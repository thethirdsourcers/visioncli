import AppKit
import SwiftUI

// Settings → Usage: memory and CPU of every VisionCLI process (the app, its voice and speech-model workers, its tools
// server in each assistant), and the disk its models and recordings take. Refreshed every 2 s while the page is open.

final class ResourceUsage: ObservableObject {
    struct Proc: Identifiable { let id: String; let cpu: Double; let memory: Int64; let count: Int }
    struct Disk: Identifiable { let id: String; let path: String; let bytes: Int64 }

    @Published private(set) var procs: [Proc] = []
    @Published private(set) var disk: [Disk] = []
    private var timer: Timer?
    private let queue = DispatchQueue(label: "dev.visioncli.usage", qos: .utility)

    func start() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
        queue.async { [weak self] in
            let d = Self.diskUsage()
            DispatchQueue.main.async { self?.disk = d }
        }
    }

    func stop() { timer?.invalidate(); timer = nil }

    private func refresh() {
        queue.async { [weak self] in
            let p = Self.processes()
            DispatchQueue.main.async { self?.procs = p }
        }
    }

    /// What a process is, from its command line (nil: not VisionCLI's, unless its parent is).
    static func label(_ command: String) -> String? {
        let rules: [(String, String)] = [
            ("kokoro_server", "Kokoro voice"), ("chatterbox_server", "Chatterbox voice"),
            ("whisper-server", "Whisper speech model"), ("parakeet", "Parakeet speech model"),
            ("VisionCLI.app/Contents/MacOS", "VisionCLI app"), ("visioncli/dist/index.js", "VisionCLI tools (MCP server)"),
            ("browserd", "Browser control"),
        ]
        return rules.first { command.contains($0.0) }?.1
    }

    /// ps once; each process gets its own label or its nearest labeled ancestor's (uv → python, etc.), summed by label.
    static func processes() -> [Proc] {
        let (_, out, _) = shell("/bin/ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss=,command="])
        var parent: [Int: Int] = [:], info: [Int: (cpu: Double, rss: Int64, cmd: String)] = [:]
        for line in out.split(separator: "\n") {
            let f = line.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true)
            guard f.count == 5, let pid = Int(f[0]), let ppid = Int(f[1]) else { continue }
            parent[pid] = ppid
            info[pid] = (Double(f[2]) ?? 0, (Int64(f[3]) ?? 0) * 1024, String(f[4]))
        }
        func labelFor(_ pid: Int) -> String? {
            var p = pid, hops = 0
            while let i = info[p], hops < 20 {
                if let l = label(i.cmd) { return p == pid || l != "VisionCLI app" ? l : "VisionCLI app (helpers)" }
                guard let up = parent[p], up > 1 else { return nil }
                p = up; hops += 1
            }
            return nil
        }
        var sums: [String: (cpu: Double, mem: Int64, n: Int)] = [:]
        for (pid, i) in info {
            guard let l = labelFor(pid) else { continue }
            let s = sums[l] ?? (0, 0, 0)
            sums[l] = (s.cpu + i.cpu, s.mem + i.rss, s.n + 1)
        }
        return sums.map { Proc(id: $0.key, cpu: $0.value.cpu, memory: $0.value.mem, count: $0.value.n) }.sorted { $0.memory > $1.memory }
    }

    static func diskUsage() -> [Disk] {
        let hf = home.appendingPathComponent(".cache/huggingface/hub/models--mlx-community--chatterbox-turbo-4bit").path
        let items: [(String, [String])] = [
            ("Kokoro voices", [VoiceModels.kokoroModel, VoiceModels.kokoroVoices].compactMap { $0 }),
            ("Chatterbox voice", [hf]),
            ("Whisper speech models", VoiceModels.whisperModels().map(\.1)),
            ("Parakeet speech model", [SetupModel.parakeetModelsDir.path]),
            ("Meeting recordings and notes", [MeetingNotes.dir.path]),
            ("Screenshots and history", [supportDir.appendingPathComponent("screenshots").path]),
            ("Logs", [logURL.path, logURL.path + ".1", CrashReporter.logURL.path]),
        ]
        return items.compactMap { name, paths in
            let bytes = paths.reduce(Int64(0)) { $0 + size($1) }
            return bytes > 0 ? Disk(id: name, path: paths.first ?? "", bytes: bytes) : nil
        }
    }

    /// A file's size, or everything inside a folder.
    static func size(_ path: String) -> Int64 {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir) else { return 0 }
        if !isDir.boolValue { return (try? fm.attributesOfItem(atPath: path)[.size] as? Int64) ?? 0 }
        var total: Int64 = 0
        let e = fm.enumerator(at: URL(fileURLWithPath: path), includingPropertiesForKeys: [.totalFileAllocatedSizeKey])
        while let f = e?.nextObject() as? URL {
            total += Int64((try? f.resourceValues(forKeys: [.totalFileAllocatedSizeKey]).totalFileAllocatedSize) ?? 0)
        }
        return total
    }
}

struct ResourceUsagePage: View {
    @StateObject private var u = ResourceUsage()

    private func bytes(_ n: Int64) -> String { ByteCountFormatter.string(fromByteCount: n, countStyle: .memory) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            section("Running now", footer: "CPU is a share of one core (100% = one full core). Updates every 2 seconds.") {
                if u.procs.isEmpty { Text("Reading…").font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 8) }
                ForEach(Array(u.procs.enumerated()), id: \.element.id) { i, p in
                    if i > 0 { Divider() }
                    row(p.id + (p.count > 1 ? "  ·  \(p.count) processes" : ""), String(format: "%.0f%% CPU", p.cpu), bytes(p.memory))
                }
                if !u.procs.isEmpty {
                    Divider()
                    row("Total", String(format: "%.0f%% CPU", u.procs.reduce(0) { $0 + $1.cpu }), bytes(u.procs.reduce(0) { $0 + $1.memory }), bold: true)
                }
            }
            section("On disk", footer: nil) {
                ForEach(Array(u.disk.enumerated()), id: \.element.id) { i, d in
                    if i > 0 { Divider() }
                    HStack {
                        row(d.id, "", ByteCountFormatter.string(fromByteCount: d.bytes, countStyle: .file))
                        Button { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: d.path)]) } label: { Image(systemName: "magnifyingglass") }
                            .buttonStyle(.borderless).help("Show in Finder")
                    }
                }
                if !u.disk.isEmpty {
                    Divider()
                    row("Total", "", ByteCountFormatter.string(fromByteCount: u.disk.reduce(0) { $0 + $1.bytes }, countStyle: .file), bold: true)
                }
            }
        }
        .onAppear { u.start() }
        .onDisappear { u.stop() }
    }

    private func row(_ name: String, _ cpu: String, _ size: String, bold: Bool = false) -> some View {
        HStack {
            Text(name).font(.system(size: 13, weight: bold ? .semibold : .regular))
            Spacer()
            Text(cpu).font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary).frame(width: 80, alignment: .trailing)
            Text(size).font(.system(size: 12, weight: bold ? .semibold : .regular).monospacedDigit()).frame(width: 80, alignment: .trailing)
        }
        .padding(.vertical, 6)
    }

    private func section<C: View>(_ title: String, footer: String?, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold)).padding(.leading, 2)
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.035)))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.09), lineWidth: 1))
            if let footer { Text(footer).font(.system(size: 11)).foregroundStyle(.secondary).padding(.leading, 2) }
        }
    }
}
