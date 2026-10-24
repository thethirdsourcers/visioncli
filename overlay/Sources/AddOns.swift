import AppKit
import SwiftUI

// Recommended add-ons for Claude Code, offered in setup (pre-ticked) and in Settings → Integrations. Nothing is
// installed without the user choosing it: each one changes how their Claude works in every project.

struct AddOn: Identifiable {
    let id: String
    let title: String
    let detail: String
    /// Shell steps run in order with the user's PATH (any failing step stops the install).
    let steps: [[String]]
    let isInstalled: () -> Bool
}

final class AddOns: ObservableObject {
    static let shared = AddOns()

    @Published private(set) var installed: Set<String> = []
    @Published private(set) var installing: Set<String> = []
    @Published private(set) var errors: [String: String] = [:]
    @Published var selected: Set<String> = []

    private let queue = DispatchQueue(label: "dev.visioncli.addons", qos: .userInitiated)
    private lazy var cfg = Config.load()

    private static func plugin(_ name: String) -> Bool {
        let url = home.appendingPathComponent(".claude/plugins/installed_plugins.json")
        guard let data = try? Data(contentsOf: url), let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        let plugins = o["plugins"] as? [String: Any] ?? o
        return plugins[name] != nil
    }

    private static func mcpServer(_ name: String) -> Bool {
        let url = home.appendingPathComponent(".claude.json")
        guard let data = try? Data(contentsOf: url), let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return (o["mcpServers"] as? [String: Any])?[name] != nil
    }

    let all: [AddOn] = [
        AddOn(id: "ponytail", title: "Ponytail",
              detail: "Makes Claude write the simplest code that works: no unrequested abstractions, standard library first.",
              steps: [["claude", "plugin", "marketplace", "add", "DietrichGebert/ponytail"], ["claude", "plugin", "install", "ponytail@ponytail"]],
              isInstalled: { AddOns.plugin("ponytail@ponytail") }),
        AddOn(id: "graphify", title: "Graphify",
              detail: "Turns a codebase into a knowledge graph Claude reads before answering, so it understands big projects fast (/graphify). Needs uv.",
              steps: [["uv", "tool", "install", "graphifyy"], ["graphify", "install"]],
              isInstalled: { FileManager.default.fileExists(atPath: home.appendingPathComponent(".claude/skills/graphify/SKILL.md").path) }),
        AddOn(id: "claude-mem", title: "Claude-Mem",
              detail: "Remembers what you worked on across sessions and brings the relevant parts back.",
              steps: [["claude", "plugin", "marketplace", "add", "thedotmack/claude-mem"], ["claude", "plugin", "install", "claude-mem@thedotmack"]],
              isInstalled: { AddOns.plugin("claude-mem@thedotmack") }),
        AddOn(id: "context7", title: "Context7",
              detail: "Up-to-date documentation for the libraries you use, so Claude doesn't guess at old APIs. Needs Node.",
              steps: [["claude", "mcp", "add", "--scope", "user", "context7", "--", "npx", "-y", "@upstash/context7-mcp"]],
              isInstalled: { AddOns.mcpServer("context7") }),
        AddOn(id: "security-guidance", title: "Security Guidance",
              detail: "Anthropic's plugin that warns about security mistakes (injection, secrets, unsafe calls) as Claude edits code.",
              steps: [["claude", "plugin", "install", "security-guidance@claude-plugins-official"]],
              isInstalled: { AddOns.plugin("security-guidance@claude-plugins-official") }),
    ]

    var claudeInstalled: Bool { FileManager.default.isExecutableFile(atPath: cfg.claude) }

    /// Re-reads what's installed; the ones not installed yet start ticked (setup).
    func refresh(selectMissing: Bool = false) {
        queue.async { [weak self] in
            guard let self else { return }
            let have = Set(self.all.filter { $0.isInstalled() }.map(\.id))
            DispatchQueue.main.async {
                self.installed = have
                if selectMissing { self.selected = Set(self.all.map(\.id)).subtracting(have) }
            }
        }
    }

    func installSelected() {
        for id in selected where !installed.contains(id) { install(id) }
    }

    func install(_ id: String) {
        guard let addOn = all.first(where: { $0.id == id }), !installing.contains(id) else { return }
        installing.insert(id)
        errors[id] = nil
        // One at a time: plugin installs all write Claude's settings.
        queue.async { [weak self] in
            guard let self else { return }
            var error: String?
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = self.cfg.path + ":" + home.appendingPathComponent(".local/bin").path
            for step in addOn.steps {
                let exe = step[0] == "claude" ? self.cfg.claude : (Config.find(step[0], path: env["PATH"]!) ?? step[0])
                guard FileManager.default.isExecutableFile(atPath: exe) else { error = "\(step[0]) isn't installed"; break }
                let (code, out, err) = shell(exe, Array(step.dropFirst()), env: env)
                // Adding a marketplace that's already there isn't a failure.
                if code != 0, !(step.contains("marketplace") && (out + err).localizedCaseInsensitiveContains("already")) {
                    let msg = (err.isEmpty ? out : err).trimmingCharacters(in: .whitespacesAndNewlines)
                    error = String(msg.split(separator: "\n").last ?? "failed (\(code))")
                    break
                }
            }
            let ok = error == nil && addOn.isInstalled()
            log("add-on \(id): \(ok ? "installed" : "failed: \(error ?? "not found after install")")")
            DispatchQueue.main.async {
                self.installing.remove(id)
                if ok { self.installed.insert(id) } else { self.errors[id] = error ?? "Didn't install" }
            }
        }
    }
}

/// One add-on: a tick box (setup) or an Install button (Settings), with its status.
struct AddOnRow: View {
    @ObservedObject var a = AddOns.shared
    let addOn: AddOn
    var checkbox = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if checkbox {
                Toggle("", isOn: Binding(get: { a.installed.contains(addOn.id) || a.selected.contains(addOn.id) },
                                         set: { if $0 { a.selected.insert(addOn.id) } else { a.selected.remove(addOn.id) } }))
                    .toggleStyle(.checkbox).labelsHidden().disabled(a.installed.contains(addOn.id))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(addOn.title).font(.system(size: 13, weight: .semibold))
                Text(addOn.detail).font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let e = a.errors[addOn.id] { Text(e).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 8)
            if a.installed.contains(addOn.id) {
                Label("Installed", systemImage: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(.green).fixedSize()
            } else if a.installing.contains(addOn.id) {
                ProgressView().controlSize(.small)
            } else if !checkbox {
                Button("Install") { a.install(addOn.id) }.disabled(!a.claudeInstalled).fixedSize()
            }
        }
        .padding(.vertical, 4)
    }
}
