import AppKit

/// Terminal mode: the conversation lives in a real interactive `claude` or `gemini` running in iTerm2 (or Terminal),
/// so the user can type to it like `claude -c`. Voice questions are typed into that session for them, and the bubble
/// follows the session file (Claude: ~/.claude/projects/<project>/<id>.jsonl; Gemini: ~/.gemini/tmp/<project>/chats/).
final class TerminalSession {
    let project: String
    let assistant: Assistant
    private let cfg: Config
    private(set) var sessionId: String
    // Threading: everything here belongs to the main thread, except `offset`/`lines` (owned by `reader`, which reads
    // and parses the transcript). Process scans and AppleScript run on `work`, with results applied on main.
    private var termId: String?          // iTerm session unique id, or Terminal tab reference
    private let usesITerm: Bool
    private var offset: UInt64 = 0       // reader queue only
    private let lines = LineSplitter()   // reader queue only
    private var timer: Timer?
    private var reading = false          // a transcript read is in flight on the reader queue
    /// Marker of the voice question we're waiting on. The transcript is only followed while there is one.
    private var awaiting: String? {
        didSet { if awaiting == nil { stopWatching() } }
    }
    private var seenQuestion = false
    private var finalText = ""
    private var lastTool: String?
    private var lastToolAt = Date()
    private var seenToolIds = Set<String>()
    private var agyDiscover = false   // agy picks its own conversation id: find it by the question text after typing

    var onStatus: (String) -> Void = { _ in }
    var onToolUse: (_ name: String, _ input: [String: Any]) -> Void = { _, _ in }
    var onToolResult: (_ text: String, _ isError: Bool) -> Void = { _, _ in }
    var onDone: (_ result: String?, _ error: String?) -> Void = { _, _ in }

    static let scriptsDir = home.appendingPathComponent("Library/Caches/visioncli") // no spaces: iTerm runs the path as a command
    static let terminalPrompt = """
    Some messages end with a "[voice …]" tag: the user asked those out loud while looking at their screen, and your reply is also shown in a small bubble above their mouse pointer and may be read aloud. For those, first Read any screenshot file listed in the tag (the mouse position is in image pixels; "this/here/that" means what's under the pointer); with no screenshot, the tag says which window the mouse is over: call the visioncli `look` tool only if answering needs the screen. Then follow the rest of these instructions.
    """ + "\n" + voiceSystemPrompt

    init(project: String, cfg: Config, assistant: Assistant) {
        self.project = project
        self.cfg = cfg
        self.assistant = assistant
        self.usesITerm = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil
        // Reuse this project's terminal conversation across app restarts.
        let key = TerminalSession.key(project, assistant)
        if let saved = UserDefaults.standard.string(forKey: key) { sessionId = saved } else {
            sessionId = UUID().uuidString.lowercased()
            UserDefaults.standard.set(sessionId, forKey: key)
        }
    }

    private static func key(_ project: String, _ assistant: Assistant) -> String {
        assistant == .claude ? "terminalSession:\(project)" : "terminalSession:\(assistant.rawValue):\(project)"
    }
    private var defaultsKey: String { TerminalSession.key(project, assistant) }

    /// Folder the CLI runs in (its session files are keyed by it); usually the project root.
    var claudeCwd: String?

    /// The session file being followed (nil until the CLI has written it).
    var transcriptURL: URL? {
        let cwd = claudeCwd ?? project
        if assistant == .claude {
            let encoded = cwd.replacingOccurrences(of: #"[^A-Za-z0-9]"#, with: "-", options: .regularExpression)
            return home.appendingPathComponent(".claude/projects/\(encoded)/\(sessionId).jsonl")
        }
        if assistant == .antigravity { return TerminalProbe.sessionFile(.antigravity, cwd: cwd, sessionId: sessionId) }
        if let cached = geminiFile, cachedFor == sessionId { return cached }
        geminiFile = TerminalProbe.sessionFile(.gemini, cwd: cwd, sessionId: sessionId)
        cachedFor = sessionId
        return geminiFile
    }
    private var geminiFile: URL?
    private var cachedFor = ""

    var isBusy: Bool { awaiting != nil }

    /// Use a `claude` the user started themselves (in iTerm): type into that tab and follow its transcript.
    func attach(itermSession: String, sessionId: String?) {
        guard usesITerm, termId != itermSession || (sessionId != nil && sessionId != self.sessionId) else { return }
        termId = itermSession
        if let sessionId, sessionId != self.sessionId {
            self.sessionId = sessionId
            UserDefaults.standard.set(sessionId, forKey: defaultsKey)
            follow(transcriptURL, fromStart: false)
        }
        log("terminal: attached to your \(assistant.binary) in iTerm (session \(self.sessionId)) for \(project)")
    }

    /// Start a fresh conversation next time (menu: New Conversation).
    func reset() {
        awaiting = nil // the old conversation's answer won't be followed any more
        sessionId = UUID().uuidString.lowercased()
        UserDefaults.standard.set(sessionId, forKey: defaultsKey)
        termId = nil
        follow(nil, fromStart: true)
    }

    // MARK: Asking

    /// Type a slash command (/model haiku, /effort high…) into the running CLI as-is: no voice context, no waiting
    /// for an answer. Uses the attached tab, else one the user runs for this project. Call on main; `done` gets false
    /// (on main) if none is running.
    func command(_ cmd: String, done: @escaping (Bool) -> Void = { _ in }) {
        let ours = termId
        TerminalSession.work.async { [weak self] in
            guard let self else { return }
            if let id = ours, self.send(cmd, to: id) {
                log("terminal: sent \(cmd) to \(self.assistant.binary) for \(self.project)")
                DispatchQueue.main.async { done(true) }
                return
            }
            let found = TerminalProbe.find(self.assistant, forProject: self.project)
            DispatchQueue.main.async {
                guard let found, let tab = found.itermSession else { done(false); return }
                self.claudeCwd = found.cwd
                self.attach(itermSession: tab, sessionId: found.sessionId)
                TerminalSession.work.async {
                    let ok = self.send(cmd, to: tab)
                    if ok { log("terminal: sent \(cmd) to \(self.assistant.binary) for \(self.project)") }
                    DispatchQueue.main.async { done(ok) }
                }
            }
        }
    }

    /// Attach to the CLI the user runs for this project, if any (without typing anything). Call on main; `then` runs
    /// on main once that's settled.
    func findRunning(then: @escaping () -> Void = {}) {
        guard termId == nil else { then(); return }
        TerminalSession.work.async { [weak self] in
            guard let self else { return }
            let found = TerminalProbe.find(self.assistant, forProject: self.project)
            DispatchQueue.main.async {
                if self.termId == nil, let found, let tab = found.itermSession {
                    self.claudeCwd = found.cwd
                    self.attach(itermSession: tab, sessionId: found.sessionId)
                }
                then()
            }
        }
    }

    /// The model the CLI used for its latest reply (e.g. "claude-haiku-5-5"), read from its transcript in the
    /// background. Call on main; `done` gets it on main.
    func lastModel(_ done: @escaping (String?) -> Void) {
        guard assistant == .claude, let url = transcriptURL else { done(nil); return }
        DispatchQueue.global(qos: .utility).async {
            let model = TerminalSession.lastModel(in: url)
            DispatchQueue.main.async { done(model) }
        }
    }

    private static func lastModel(in url: URL) -> String? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        try? h.seek(toOffset: size > 200_000 ? size - 200_000 : 0)
        guard let data = try? h.readToEnd(), let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n").reversed() where line.contains("\"assistant\"") && line.contains("\"model\"") {
            if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
               let model = (obj["message"] as? [String: Any])?["model"] as? String, model.hasPrefix("claude") { return model }
        }
        return nil
    }

    func ask(_ text: String) {
        // One line: a newline would submit early. The marker lets us find this turn in the transcript.
        let line = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "  ", with: " ")
        awaiting = String(line.prefix(60))
        seenQuestion = false
        finalText = ""
        lastTool = nil
        seenToolIds = []
        agyDiscover = assistant == .antigravity
        skipToEnd()
        startWatching()
        // The assistant the user already runs for this project wins (the most recently active one), like `claude -c`
        // in that terminal; then the tab VisionCLI opened; only then a new terminal. Process scans and AppleScript are
        // slow, so they run on a background queue and the bubble and mascot keep animating. A tab found moments ago
        // (when the key went down) is reused instead of scanning again.
        let ours = termId
        TerminalSession.work.async { [weak self] in
            guard let self else { return }
            let recent = TerminalProbe.recent(self.assistant, forProject: self.project)
            let found = recent ?? TerminalProbe.find(self.assistant, forProject: self.project)
            DispatchQueue.main.async { self.deliver(line, found: found, recent: recent != nil, ours: ours) }
        }
    }

    /// Type the question into the tab that was found (attaching to it first), else the one VisionCLI opened, else open one.
    private func deliver(_ line: String, found: TerminalContext?, recent: Bool, ours: String?) {
        // Attach first, so the transcript is followed from before the question lands in it.
        if let found, let tab = found.itermSession {
            claudeCwd = found.cwd
            attach(itermSession: tab, sessionId: found.sessionId)
        }
        skipToEnd()
        TerminalSession.work.async {
            var target: (id: String, existing: Bool)?
            if let tab = found?.itermSession, self.send(line, to: tab) { target = (tab, true) }
            else if recent {
                // The remembered tab is gone (closed since): look again.
                TerminalProbe.forget(self.assistant, forProject: self.project)
                let fresh = TerminalProbe.find(self.assistant, forProject: self.project)
                DispatchQueue.main.async { self.deliver(line, found: fresh, recent: false, ours: ours) }
                return
            }
            else if let id = ours, self.send(line, to: id) { target = (id, false) }
            DispatchQueue.main.async {
                if let target {
                    self.confirmSubmitted(target.id)
                    log("terminal: typed voice question into \(target.existing ? "your existing \(self.assistant.binary)" : "\(self.usesITerm ? "iTerm" : "Terminal") session")")
                } else {
                    self.openAndAsk(line)
                }
            }
        }
    }

    /// None running: open one, wait for its prompt, then type.
    private func openAndAsk(_ line: String) {
        onStatus("Opening \(assistant.name) in the terminal…")
        open { [weak self] id in
            guard let self else { return }
            guard let id else {
                self.awaiting = nil
                self.onDone(nil, "Couldn't open a terminal. Allow VisionCLI to control \(self.usesITerm ? "iTerm" : "Terminal") in System Settings → Privacy & Security → Automation.")
                return
            }
            self.termId = id
            self.waitForPrompt(id, tries: self.assistant == .antigravity ? 90 : 40) { [weak self] in
                guard let self else { return }
                TerminalSession.work.async {
                    let ok = self.send(line, to: id)
                    DispatchQueue.main.async {
                        if ok { self.confirmSubmitted(id) }
                        else { self.awaiting = nil; self.onDone(nil, "Couldn't type into the terminal session.") }
                    }
                }
            }
        }
    }

    /// Serial queue for the slow parts (AppleScript to iTerm, process scans), off the main thread.
    static let work = DispatchQueue(label: "dev.visioncli.terminal", qos: .userInitiated)

    func bringToFront() {
        guard let id = termId else {
            open { [weak self] id in if let id { self?.termId = id } }
            return
        }
        let script: String
        if usesITerm {
            script = """
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if unique id of s is "\(id)" then
                      select w
                      tell t to select
                      activate
                      return "ok"
                    end if
                  end repeat
                end repeat
              end repeat
            end tell
            """
        } else {
            script = "tell application \"Terminal\"\nset frontmost of (first window whose tabs contains \(id)) to true\nactivate\nend tell"
        }
        TerminalSession.work.async { _ = self.applescript(script) }
    }

    // MARK: Terminal control

    /// Open a new terminal window running the CLI for this project. Call on main; `done` gets the new session's id
    /// (nil if the terminal couldn't be opened) on main. The session-folder scan and the AppleScript run on `work`.
    private func open(_ done: @escaping (String?) -> Void) {
        claudeCwd = nil
        let project = self.project, assistant = self.assistant
        TerminalSession.work.async { [weak self] in
            // Continue the project's latest conversation (what `claude -c` would pick), not one VisionCLI remembered.
            let latest = assistant == .claude ? TerminalProbe.newestSession(.claude, cwd: project) : nil
            DispatchQueue.main.async {
                guard let self else { return }
                if let latest, latest != self.sessionId {
                    self.sessionId = latest
                    UserDefaults.standard.set(latest, forKey: self.defaultsKey)
                }
                let (script, url) = self.openScript()
                self.follow(url, fromStart: false)
                TerminalSession.work.async {
                    let id = self.applescript(script)
                    // Terminal: that window's tab, so later questions go to it even when another window is in front.
                    DispatchQueue.main.async { done(self.usesITerm ? id : id.map { "selected tab of window id \($0)" }) }
                }
            }
        }
    }

    /// Writes the launch script for the current session and returns the AppleScript that opens a window running it,
    /// and the transcript to follow.
    private func openScript() -> (String, URL?) {
        let fm = FileManager.default
        try? fm.createDirectory(at: TerminalSession.scriptsDir, withIntermediateDirectories: true)
        let promptFile = TerminalSession.scriptsDir.appendingPathComponent("voice-prompt.txt")
        try? TerminalSession.terminalPrompt.write(to: promptFile, atomically: true, encoding: .utf8)
        let resume = transcriptURL.map { fm.fileExists(atPath: $0.path) } ?? false
        let quote = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let command: String
        if assistant == .claude {
            command = """
            \(quote(cfg.claude)) --append-system-prompt "$(cat \(quote(promptFile.path)))" \\
              --allowedTools \(autoAllowedTools.joined(separator: " ")) \(Settings.effort.map { "--effort \($0)" } ?? "") \\
              \(Settings.model == "default" ? "" : "--model \(quote(Settings.model))") \\
              \(resume ? "--resume" : "--session-id") \(sessionId)
            """
        } else if assistant == .antigravity {
            // agy can't take a system prompt or a preset conversation id; questions carry short instructions.
            command = "\(quote(cfg.agy ?? "agy"))" + (resume ? " --conversation \(sessionId)" : "")
                + (Settings.agyModel.map { " --model \(quote($0))" } ?? "")
                + (Settings.effort.map { " --effort \($0)" } ?? "")
        } else {
            // Gemini has no --append-system-prompt; each voice question carries its own short instructions.
            let env = cfg.geminiEnvironment()
            let auth = env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"].map { override in
                // Read the key at launch so it isn't stored in this script.
                "export GEMINI_CLI_SYSTEM_SETTINGS_PATH=\(quote(override)); export GEMINI_API_KEY=\"$(\(quote(cfg.node ?? "node")) -e 'try{const c=require(process.argv[1]);process.stdout.write((c.gemini&&c.gemini.apiKey)||process.env.GEMINI_API_KEY||\"\")}catch{process.stdout.write(process.env.GEMINI_API_KEY||\"\")}' \(quote(supportDir.appendingPathComponent("integrations.json").path)))\"\n"
            } ?? ""
            command = auth + "\(quote(cfg.gemini ?? "gemini")) \(resume ? "--resume" : "--session-id") \(sessionId)"
        }
        let script = """
        #!/bin/zsh -l
        printf '\\e]0;\(assistant.binary) · \((project as NSString).lastPathComponent) (visioncli)\\a'
        cd \(quote(project))
        \(command)
        echo; echo "\(assistant.binary) exited. Press Enter to close."; read
        """
        let stable = project.utf8.reduce(UInt64(5381)) { ($0 &* 33) &+ UInt64($1) }
        let file = TerminalSession.scriptsDir.appendingPathComponent("\(assistant.binary)-\(stable).sh")
        try? script.write(to: file, atomically: true, encoding: .utf8)
        try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        log("terminal: opening \(assistant.binary) (\(resume ? "resume" : "new") \(sessionId)) in \(project)")
        if usesITerm {
            return ("""
            tell application "iTerm2"
              set w to (create window with default profile command "\(file.path)")
              return unique id of current session of w
            end tell
            """, transcriptURL)
        }
        // A Terminal tab can't be turned into text ("Can't make «class ttab» 1 of window id … into type text"), which
        // made every open look failed and the next question open yet another window: return its window's id.
        return ("""
        tell application "Terminal"
          set t to do script "exec \(file.path)"
          activate
          set y to tty of t
          repeat with w in windows
            if tty of selected tab of w is y then return id of w as text
          end repeat
          return id of front window as text
        end tell
        """, transcriptURL)
    }

    /// Claude sometimes takes fast typing for a paste and swallows the Return that follows it. Once the question shows
    /// up in the transcript it was submitted; until then press Return again (an extra Return on an empty prompt does
    /// nothing).
    private func confirmSubmitted(_ id: String, tries: Int = 4) {
        guard usesITerm else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
            guard let self, self.awaiting != nil, !self.seenQuestion, tries > 0 else { return }
            log("terminal: question not submitted yet, pressing Return again")
            let script = self.inSession(id, "tell s to write text (character id 13) newline NO")
            TerminalSession.work.async { _ = self.applescript(script) }
            self.confirmSubmitted(id, tries: tries - 1)
        }
    }

    private func inSession(_ id: String, _ body: String) -> String {
        """
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if unique id of s is "\(id)" then
                  \(body)
                  return "ok"
                end if
              end repeat
            end repeat
          end repeat
          return "missing"
        end tell
        """
    }

    /// Type a line into the session; false if the session no longer exists.
    private func send(_ line: String, to id: String) -> Bool {
        let text = line.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        if usesITerm {
            return applescript("""
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if unique id of s is "\(id)" then
                      -- Type the text, then press Return: claude's input needs a real carriage return to submit.
                      tell s to write text "\(text)" newline NO
                      delay 0.15
                      tell s to write text (character id 13) newline NO
                      return "ok"
                    end if
                  end repeat
                end repeat
              end repeat
              return "missing"
            end tell
            """) == "ok"
        }
        return applescript("tell application \"Terminal\" to do script \"\(text)\" in \(id)") != nil
    }

    /// Wait until claude's input prompt is on screen (so typed text isn't lost), up to ~12s.
    private func waitForPrompt(_ id: String, tries: Int, then: @escaping () -> Void) {
        TerminalSession.work.async { [weak self] in
            guard let self else { return }
            let screen = self.screenContents(id)
            DispatchQueue.main.async { self.promptChecked(id, screen: screen, tries: tries, then: then) }
        }
    }

    private func screenContents(_ id: String) -> String {
        var screen = ""
        if usesITerm {
            screen = applescript("""
            tell application "iTerm2"
              repeat with w in windows
                repeat with t in tabs of w
                  repeat with s in sessions of t
                    if unique id of s is "\(id)" then return contents of s
                  end repeat
                end repeat
              end repeat
            end tell
            """) ?? ""
        } else {
            screen = applescript("tell application \"Terminal\" to return contents of \(id)") ?? ""
        }
        return screen
    }

    private func promptChecked(_ id: String, screen: String, tries: Int, then: @escaping () -> Void) {
        let ready = screen.contains("shortcuts") || screen.contains("? for") || screen.contains("❯") || screen.contains("│ >")
            || screen.contains("Type your message") || screen.contains("How can I help")
        if ready || tries <= 0 {
            // Let startup output (hooks, banners) settle so typed characters aren't eaten.
            DispatchQueue.main.asyncAfter(deadline: .now() + (ready ? 1.5 : 0)) { then() }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.waitForPrompt(id, tries: tries - 1, then: then) }
        }
    }

    /// Runs AppleScript in a separate osascript process. NSAppleScript always executes on the main thread (even when
    /// called from a background queue), so a slow script, like typing with a `delay`, would freeze the bubble and
    /// mascot; osascript doesn't touch our main thread at all.
    private func applescript(_ source: String) -> String? {
        let (status, out, err) = shell("/usr/bin/osascript", ["-e", source])
        if status != 0 { log("applescript error: \(err.trimmingCharacters(in: .whitespacesAndNewlines))"); return nil }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Transcript watching

    /// Reads and parses the transcript off the main thread; owns `offset` and `lines`.
    private let reader = DispatchQueue(label: "dev.visioncli.transcript", qos: .userInitiated)

    /// Follows the transcript while a question is waiting for its answer (stopped when `awaiting` clears).
    private func startWatching() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func stopWatching() {
        timer?.invalidate()
        timer = nil
    }

    /// Start following `url` at its current end (or from its start): on the reader queue, after any read in flight.
    private func follow(_ url: URL?, fromStart: Bool) {
        reader.async { [weak self] in
            guard let self else { return }
            self.offset = fromStart ? 0 : url.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? UInt64 } ?? 0
            self.lines.reset()
        }
    }

    private func poll() {
        guard let marker = awaiting else { stopWatching(); return }
        guard !reading else { return } // the last read is still going (a big burst of output); don't pile up
        if agyDiscover {
            reading = true
            reader.async { [weak self] in
                let id = TerminalProbe.agyConversation(containing: marker)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.reading = false
                    guard let id, self.agyDiscover, self.awaiting == marker else { return }
                    self.agyDiscover = false
                    if id != self.sessionId {
                        self.sessionId = id
                        UserDefaults.standard.set(id, forKey: self.defaultsKey)
                    }
                    self.follow(nil, fromStart: true) // read the whole transcript; only lines after the question count
                    log("terminal: following agy conversation \(id)")
                }
            }
            return
        }
        guard let url = transcriptURL else { return }
        reading = true
        reader.async { [weak self] in
            guard let self else { return }
            let read = self.readNewLines(url)
            DispatchQueue.main.async {
                self.reading = false
                guard let read else { return }
                for obj in read.objects { self.handle(obj) }
                if !read.grew { self.checkApprovalWait() }
            }
        }
    }

    /// Reader queue: the complete lines the transcript has grown by since last time, parsed. Nil if it can't be read.
    private func readNewLines(_ url: URL) -> (objects: [[String: Any]], grew: Bool)? {
        guard let h = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? h.close() }
        let size = h.seekToEndOfFile()
        if size < offset { offset = 0 } // file replaced
        guard size > offset else { return ([], false) }
        h.seek(toFileOffset: offset)
        let data = h.readDataToEndOfFile()
        offset += UInt64(data.count) // what was read, which can be past `size` if the file grew meanwhile
        // One pass over the new lines; a partial last line waits in `lines` for the rest.
        return (JSONLines.objects(data, splitter: lines), true)
    }

    /// Only what's written after the question matters: skip whatever the conversation has grown by since last time
    /// (in a long session that's megabytes of earlier tool output).
    private func skipToEnd() {
        guard !agyDiscover, let url = transcriptURL else { return }
        reader.async { [weak self] in
            guard let self, let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? UInt64) else { return }
            self.offset = size
            self.lines.reset()
        }
    }

    private func handle(_ obj: [String: Any]) {
        if assistant == .gemini { handleGemini(obj); return }
        if assistant == .antigravity { handleAgy(obj); return }
        guard let marker = awaiting, obj["isSidechain"] as? Bool != true else { return }
        let message = obj["message"] as? [String: Any] ?? [:]
        switch obj["type"] as? String {
        case "user":
            if let text = message["content"] as? String, text.contains(marker) { seenQuestion = true; return }
            let content = message["content"] as? [[String: Any]] ?? []
            if content.contains(where: { ($0["text"] as? String)?.contains(marker) == true }) { seenQuestion = true; return }
            guard seenQuestion else { return }
            for block in content where block["type"] as? String == "tool_result" {
                lastTool = nil
                var text = block["content"] as? String ?? ""
                if let parts = block["content"] as? [[String: Any]] { text = parts.compactMap { $0["text"] as? String }.joined(separator: "\n") }
                onToolResult(text, block["is_error"] as? Bool ?? false)
            }
        case "assistant":
            guard seenQuestion else { return }
            let content = message["content"] as? [[String: Any]] ?? []
            for block in content {
                if block["type"] as? String == "tool_use" {
                    let name = block["name"] as? String ?? "", input = block["input"] as? [String: Any] ?? [:]
                    lastTool = name
                    lastToolAt = Date()
                    onToolUse(name, input)
                    finalText = "" // text before a tool call was narration, not the answer
                } else if block["type"] as? String == "text", let t = block["text"] as? String, !t.isEmpty {
                    finalText += (finalText.isEmpty ? "" : "\n\n") + t
                }
            }
            // Claude Code writes the end of a turn as separate entries (thinking, then the text), so don't stop at
            // the first "end_turn": finish when the turn-summary entries arrive, or shortly after the answer text.
            if message["stop_reason"] as? String == "end_turn", !finalText.isEmpty { scheduleFinish(after: 1.0) }
        case "system":
            let subtype = obj["subtype"] as? String ?? ""
            if seenQuestion, subtype == "turn_duration" || subtype == "stop_hook_summary" { finishTurn() }
        default:
            break
        }
    }

    /// Gemini session lines: {"type":"user","content":[{"text"}]}, {"type":"gemini","content":"…","toolCalls":[…]}.
    /// A message is re-written (same id) as it updates; there's no end-of-turn marker, so finish once the reply text
    /// has been stable for a moment.
    private func handleGemini(_ obj: [String: Any]) {
        guard let marker = awaiting else { return }
        switch obj["type"] as? String {
        case "user":
            let parts = obj["content"] as? [[String: Any]] ?? []
            if parts.contains(where: { ($0["text"] as? String)?.contains(marker) == true }) || (obj["content"] as? String)?.contains(marker) == true {
                seenQuestion = true
            }
        case "gemini":
            guard seenQuestion else { return }
            let calls = obj["toolCalls"] as? [[String: Any]] ?? []
            for call in calls {
                let id = call["id"] as? String ?? UUID().uuidString
                guard seenToolIds.insert(id).inserted else { continue }
                let name = call["name"] as? String ?? ""
                lastTool = name
                lastToolAt = Date()
                finishWork?.cancel()
                finalText = ""
                onToolUse(name, call["args"] as? [String: Any] ?? [:])
            }
            if calls.isEmpty, let text = obj["content"] as? String, !text.isEmpty {
                finalText = text
                scheduleFinish(after: 2.5)
            }
        default:
            break
        }
    }

    /// agy transcript lines: USER_INPUT (our question), PLANNER_RESPONSE with tool_calls (steps) or content (the answer),
    /// GENERIC (tool output). The answer is the last DONE PLANNER_RESPONSE without tool calls.
    private func handleAgy(_ obj: [String: Any]) {
        guard let marker = awaiting else { return }
        let content = obj["content"] as? String ?? ""
        switch obj["type"] as? String {
        case "USER_INPUT":
            if content.contains(marker) { seenQuestion = true }
        case "PLANNER_RESPONSE":
            guard seenQuestion else { return }
            let calls = obj["tool_calls"] as? [[String: Any]] ?? []
            for call in calls {
                var name = call["name"] as? String ?? ""
                let args = call["args"] as? [String: Any] ?? [:]
                if name == "call_mcp_tool", let tool = args["ToolName"] as? String { name = tool }
                lastTool = name
                lastToolAt = Date()
                finishWork?.cancel()
                finalText = ""
                onToolUse(name, args)
            }
            if calls.isEmpty, obj["status"] as? String == "DONE", !content.isEmpty {
                finalText = content
                scheduleFinish(after: 1.5)
            }
        default:
            break
        }
    }

    private var finishWork: DispatchWorkItem?

    private func scheduleFinish(after seconds: Double) {
        finishWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.finishTurn() }
        finishWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// Hand the answer to the bubble (the same text that's in the terminal).
    private func finishTurn() {
        finishWork?.cancel()
        guard awaiting != nil else { return }
        awaiting = nil
        let text = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        onDone(text.isEmpty ? nil : text, text.isEmpty ? "\(assistant.name) finished without a text reply; see the terminal." : nil)
    }

    /// Edits and commands may be waiting for approval in the terminal; say so in the bubble.
    private func checkApprovalWait() {
        guard awaiting != nil, let tool = lastTool,
              ["Edit", "MultiEdit", "Write", "Bash", "NotebookEdit", "replace", "write_file", "run_shell_command",
               "run_command", "write_to_file", "replace_file_content", "multi_replace_file_content"].contains(tool),
              Date().timeIntervalSince(lastToolAt) > 1.5 else { return }
        onStatus("Running \(tool)… approve in the \(assistant.name) terminal if asked")
        lastTool = nil
    }
}
