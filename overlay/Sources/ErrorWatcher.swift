import AppKit
import SwiftUI

// Error watcher: every few seconds VisionCLI reads the iTerm tabs, and when a new error or stack trace appears in one
// (not in the AI's own tab), a badge offers "⌥E to fix". ⌥E sends the error to the assistant, in that tab's folder.
// Each error is offered once; errors already on screen when VisionCLI starts are ignored.

struct TerminalError {
    let tab: String      // tab title, e.g. "npm run dev"
    let folder: String?  // the tab's working directory
    let text: String     // the lines around the error
}

final class ErrorWatcher {
    static let enabledKey = "errorWatcher"
    static var enabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    /// A new error was found (main thread).
    var onError: (TerminalError) -> Void = { _ in }
    private var timer: Timer?
    private var busy = false
    private var seen = Set<String>()
    private var primed = false
    private let queue = DispatchQueue(label: "dev.visioncli.errors", qos: .utility)

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        guard Self.enabled, !busy,
              NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == "com.googlecode.iterm2" }) else { return }
        busy = true
        queue.async { [weak self] in
            guard let self else { return }
            let found = Self.readTabs().compactMap { tab -> (String, TerminalError)? in
                guard let (line, text) = Self.lastError(in: tab.text) else { return nil }
                return ("\(tab.id)|\(line)", TerminalError(tab: tab.name, folder: tab.folder, text: text))
            }
            DispatchQueue.main.async {
                self.busy = false
                let new = found.filter { !self.seen.contains($0.0) }
                new.forEach { self.seen.insert($0.0) }
                // The first look only learns what's already there.
                if self.primed, let e = new.last { self.onError(e.1) }
                self.primed = true
            }
        }
    }

    private struct Tab { let id: String; let name: String; let folder: String?; let text: String }

    /// Every iTerm session except the AI CLIs' own: id, title, folder and the text on screen.
    private static func readTabs() -> [Tab] {
        let script = """
        set out to ""
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                set out to out & (unique id of s) & (ASCII character 31) & (name of s) & (ASCII character 31) & (variable s named "session.path") & (ASCII character 31) & (contents of s) & (ASCII character 30)
              end repeat
            end repeat
          end repeat
        end tell
        return out
        """
        let (code, out, _) = shell("/usr/bin/osascript", ["-e", script])
        guard code == 0 else { return [] }
        return out.split(separator: "\u{1e}").compactMap { record in
            let f = record.split(separator: "\u{1f}", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
            guard f.count == 4 else { return nil }
            let name = f[1].trimmingCharacters(in: .whitespacesAndNewlines)
            if ["claude", "agy", "gemini"].contains(where: { name.lowercased().contains($0) }) { return nil }
            return Tab(id: f[0].trimmingCharacters(in: .whitespacesAndNewlines), name: name, folder: f[2].isEmpty ? nil : f[2], text: f[3])
        }
    }

    // Lines that start an error report in common toolchains (Node, Python, Go, Rust, Swift, Java, shells, test runners).
    private static let patterns = [
        #"Traceback \(most recent call last\)"#, #"^\s*(Uncaught )?[A-Z]\w*(Error|Exception)\b(:|\s)"#, #"^\s*Error: "#,
        #"npm ERR!"#, #"^panic: "#, #"^error(\[E\d+\])?: "#, #": error: "#, #"^\s*FAIL\b"#, #"BUILD FAILED"#,
        #"Segmentation fault"#, #"^fatal error: "#, #"^Exception in thread"#, #"command not found$"#,
    ].map { try! NSRegularExpression(pattern: $0, options: [.anchorsMatchLines]) }

    /// The last error in the bottom of the screen: its first line (to tell errors apart) and the lines around it.
    static func lastError(in screen: String) -> (String, String)? {
        // iTerm pads the screen with empty lines below the output.
        var lines = screen.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeLast() }
        let tail = Array(lines.suffix(40))
        guard let i = tail.lastIndex(where: { line in
            patterns.contains { $0.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil }
        }) else { return nil }
        // From the command that failed (the last prompt line above the error), else the 10 lines before it.
        let prompt = tail[..<i].lastIndex { l in ["➜ ", "❯ ", "$ ", "% ", "# "].contains { l.contains($0) } }
        let text = tail[(prompt ?? max(0, i - 10))...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (tail[i].trimmingCharacters(in: .whitespaces), text)
    }
}

/// Settings → General: turn the error watcher off.
struct ErrorWatcherSwitch: View {
    @AppStorage(ErrorWatcher.enabledKey) private var on = true

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Spot errors in the terminal").font(.system(size: 13))
                Text("When an error shows up in an iTerm tab, offers ⌥E to have the assistant explain and fix it.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Toggle("", isOn: $on).toggleStyle(.switch).labelsHidden()
        }
        .padding(.vertical, 8)
    }
}

extension AppDelegate {
    /// A badge for ~20 s: "Error in npm run dev · ⌥E to fix", with ⌥E grabbed only meanwhile.
    func offerFix(_ e: TerminalError) {
        guard state.phase == .hidden || state.phase == .done || state.phase == .error else { return } // busy: don't interrupt
        log("error watcher: \(e.tab): \(e.text.split(separator: "\n").last ?? "")")
        offeredError = e
        ActivityBadge.shared.show("exclamationmark.triangle.fill", "Error in \(e.folder.map { ($0 as NSString).lastPathComponent } ?? (e.tab.isEmpty ? "the terminal" : e.tab))  ·  ⌥E to fix", tint: .orange, seconds: 20)
        hotkeys.set(.fixError, true)
        errorOfferWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.offeredError = nil; self?.hotkeys.set(.fixError, false) }
        errorOfferWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: w)
    }

    /// ⌥E: the error goes to the assistant as a question, in the tab's folder (the text is in a file the CLI reads, so
    /// the question stays one line in a terminal).
    func fixOfferedError() {
        errorOfferWork?.cancel()
        hotkeys.set(.fixError, false)
        guard let e = offeredError else { return }
        offeredError = nil
        let file = TerminalSession.scriptsDir.appendingPathComponent("error-\(Int(Date().timeIntervalSince1970)).txt")
        try? FileManager.default.createDirectory(at: TerminalSession.scriptsDir, withIntermediateDirectories: true)
        try? e.text.write(to: file, atomically: true, encoding: .utf8)
        if let folder = e.folder { currentProject = projects.gitRoot(folder); state.project = HomeProject.label(currentProject) }
        withScreen = false
        terminalContext = nil
        existingClaude = nil
        let question = "Explain and fix the error that just appeared in my terminal tab \"\(e.tab)\". The output is in \(file.path)."
        state.question = question
        set(.thinking)
        questionReady(question)
    }
}
