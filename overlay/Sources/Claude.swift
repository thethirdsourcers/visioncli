import Foundation

let voiceSystemPrompt = """
You are answering a question the user asked out loud. Your reply appears in a small bubble above their mouse pointer (and may be read aloud).

Screenshots of what they are looking at are attached to each question, with the mouse pointer position in image pixels. "This", "here" and "that" mean what is under the pointer. If two images are attached, image 1 is where the pointer was when they started speaking and image 2 is where it ended, so "compare this with that" means 1 versus 2.

- If code is visible, find the file in the project (Glob/Grep) and Read the relevant lines before answering. Cite files as path:line, with the path relative to the project root.
- For questions about database tables or data, use mcp__visioncli__db_schema and mcp__visioncli__db_query (read-only), together with the models and migrations in the code.
- For the iOS Simulator or an Android emulator, mcp__visioncli__device_screenshot gives a sharper image. Grep for the visible strings to find the view's code.
- If you need a fresh look (for example "now look at this"), call mcp__visioncli__look with under_cursor: true.
- To explain visually, point at things with markers (pixel coordinates in that attached image; IMAGE is 1-based; never mention the markers themselves). They are drawn on the user's real screen, right over the thing you mean. Put all markers together on the LAST line of your reply so the text stays readable: [[box:IMAGE:x1,y1,x2,y2:label]] outlines an area, [[circle:IMAGE:x1,y1,x2,y2:label]] circles it, [[arrow:IMAGE:x1,y1,x2,y2:label]] points from (x1,y1) to (x2,y2), [[step:IMAGE:x,y:N:label]] places a numbered step N (use 1, 2, 3… to walk through a flow). They animate in the order you write them.
- For flows, relationships, data models or architecture, you may add one small ```mermaid diagram (flowchart, sequence or erDiagram, at most ~12 nodes). It is rendered as a picture in the bubble; keep the text around it short.
- If the user asks you to change code, make the edit with Edit/Write. The user approves each change from the bubble, so keep edits small and focused.
- To run tests, builds, artisan/npm/git commands etc., use Bash. The user approves each command from the bubble, so run one focused command at a time and summarize the output briefly.
- For web pages in Brave/Chrome, use the mcp__visioncli__browser_* tools (never other browser-control tools such as Claude in Chrome, and not screenshots): browser_read for the page text, browser_elements then browser_click/browser_type (browser_select for dropdowns; toggles show on/off) to act, browser_tabs/browser_open/browser_switch_tab/browser_navigate to move around. For a multi-step task on the open page (a form, filters, search and open a result), call browser_task with the whole goal and every value to type: it's done in seconds. Clicks and typing ask the user first.
- You can use the whole computer, any app, like the user would: mcp__visioncli__ui_elements lists the front app's buttons, fields and menus with ids, then mcp__visioncli__click / mcp__visioncli__type_text by element id (most reliable). Or click at pixel x/y in an attached image (pass image: N) or in the last look. Also press_keys ("cmd+s", "enter"), scroll, drag, open_app, open_url. Do multi-step tasks one step at a time and check the result (look_after: true) before the next step. The user approves actions in the bubble; if they decline or press Esc, stop and ask. In Chrome/Brave always use the browser_* tools (browser_open reuses tabs, browser_navigate, browser_elements → browser_click/browser_type/browser_select); never ⌘L/⌘T or typed URLs, and pixel clicks only for canvas, cross-origin frames or browser dialogs.
- If you can't tell what they mean, call mcp__visioncli__select_region so they can drag a box around it. If they say they copied a screenshot, use mcp__visioncli__clipboard_image.
- Reply in plain conversational text, under about 100 words unless they ask for detail. No headings or tables, and code snippets of 3 lines at most.
- The question came from speech-to-text, so technical words may be misheard; infer what they meant.
"""

/// Tools that run without asking. Everything else (Edit, Write, Bash, …) asks the user in the bubble.
let autoAllowedTools = [
    "Read", "Grep", "Glob",
    "mcp__visioncli__look", "mcp__visioncli__list_windows", "mcp__visioncli__device_screenshot",
    "mcp__visioncli__db_schema", "mcp__visioncli__db_query",
    "mcp__visioncli__select_region", "mcp__visioncli__clipboard_image",
    // Browser: reading and navigating are automatic; clicking and typing in pages ask first.
    "mcp__visioncli__browser_tabs", "mcp__visioncli__browser_read", "mcp__visioncli__browser_elements",
    "mcp__visioncli__browser_open", "mcp__visioncli__browser_switch_tab", "mcp__visioncli__browser_navigate",
    "mcp__visioncli__browser_scroll",
    // Computer control: VisionCLI shows its own approval card for each action (or none in "Allow all" mode).
    "mcp__visioncli__ui_elements", "mcp__visioncli__click", "mcp__visioncli__type_text", "mcp__visioncli__press_keys",
    "mcp__visioncli__scroll", "mcp__visioncli__drag", "mcp__visioncli__open_app", "mcp__visioncli__open_url",
]

struct PermissionRequest {
    let id: String
    let tool: String
    let input: [String: Any]
    var customTitle: String? = nil              // computer-control actions describe themselves
    var customDetail: [(String, DiffKind)]? = nil

    var file: String? { (input["file_path"] as? String) ?? (input["notebook_path"] as? String) }

    var title: String {
        if let customTitle { return customTitle }
        let name = file.map { ($0 as NSString).lastPathComponent } ?? ""
        switch tool {
        case "Edit", "MultiEdit": return "\(Settings.assistant.name) wants to edit \(name)"
        case "Write": return FileManager.default.fileExists(atPath: file ?? "") ? "\(Settings.assistant.name) wants to overwrite \(name)" : "\(Settings.assistant.name) wants to create \(name)"
        case "Bash": return "\(Settings.assistant.name) wants to run a command"
        default: return "\(Settings.assistant.name) wants to use \(tool.replacingOccurrences(of: "mcp__visioncli__", with: ""))"
        }
    }

    /// A short preview: a diff for edits, the command for Bash, etc.
    var detail: [(String, DiffKind)] {
        func lines(_ s: String?, _ kind: DiffKind, max: Int = 8) -> [(String, DiffKind)] {
            let all = (s ?? "").components(separatedBy: "\n")
            var out = all.prefix(max).map { (($0.count > 110 ? String($0.prefix(110)) + "…" : $0), kind) }
            if all.count > max { out.append(("… \(all.count - max) more lines", .context)) }
            return out
        }
        if let customDetail { return customDetail }
        switch tool {
        case "Edit":
            return lines(input["old_string"] as? String, .removed, max: 6) + lines(input["new_string"] as? String, .added, max: 8)
        case "MultiEdit":
            let edits = input["edits"] as? [[String: Any]] ?? []
            return edits.prefix(3).flatMap { lines($0["old_string"] as? String, .removed, max: 3) + lines($0["new_string"] as? String, .added, max: 4) }
        case "Write": return lines(input["content"] as? String, .added, max: 10)
        case "Bash": return [("$ " + (input["command"] as? String ?? ""), .context)]
        default:
            let json = (try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted])).map { String(decoding: $0, as: UTF8.self) }
            return lines(json, .context, max: 8)
        }
    }
}

enum DiffKind { case added, removed, context }

/// The tail of a process's stderr, appended from its readability handler and read from its termination handler
/// (different threads), so behind a lock.
final class TailText {
    private let lock = NSLock()
    private var text = ""

    func append(_ data: Data) {
        let s = String(decoding: data, as: UTF8.self)
        lock.lock(); defer { lock.unlock() }
        text += s
        if text.count > 4000 { text = String(text.suffix(2000)) }
    }

    var value: String { lock.lock(); defer { lock.unlock() }; return text }
}

/// What the app needs from a background assistant session (Claude Code or Gemini CLI).
protocol AssistantSession: AnyObject {
    var cwd: String { get }
    var busy: Bool { get }
    var sessionId: String? { get }
    var onStatus: (String) -> Void { get set }
    var onToolStart: () -> Void { get set }
    var onDelta: (String) -> Void { get set }
    var onPermission: (PermissionRequest) -> Void { get set }
    var onDone: (_ result: String?, _ error: String?) -> Void { get set }
    var onToolUse: (_ name: String, _ input: [String: Any]) -> Void { get set }
    var onToolResult: (_ text: String, _ isError: Bool, _ tool: String?) -> Void { get set }
    var onCost: (Double) -> Void { get set }
    func warm()
    func send(text: String, shots: [Shot])
    func respond(to req: PermissionRequest, allow: Bool)
    func reset()
    func stop()
}

/// One long-lived `claude` process per project, driven over stream-json so follow-ups don't pay startup cost.
final class ClaudeSession: AssistantSession {
    let cwd: String
    private let cfg: Config
    private var proc: Process?
    private var stdin: FileHandle?
    // Persisted so a restart (e.g. after a crash) resumes the same conversation.
    private(set) var sessionId: String? {
        didSet { UserDefaults.standard.set(sessionId, forKey: storeKey) }
    }
    private(set) var busy = false
    private var model: String
    private var effort: String? = Settings.effort

    var onStatus: (String) -> Void = { _ in }
    var onToolStart: () -> Void = {}
    var onDelta: (String) -> Void = { _ in }
    var onPermission: (PermissionRequest) -> Void = { _ in }
    var onDone: (_ result: String?, _ error: String?) -> Void = { _, _ in }
    // Activity feed (terminal mirror)
    var onToolUse: (_ name: String, _ input: [String: Any]) -> Void = { _, _ in }
    var onToolResult: (_ text: String, _ isError: Bool, _ tool: String?) -> Void = { _, _, _ in }
    var onCost: (Double) -> Void = { _ in }
    private var toolNames: [String: String] = [:]

    /// The fast lane (smart routing) answers light questions with Haiku at low effort, in its own conversation.
    let lane: Lane
    private var storeKey: String { lane == .fast ? "backgroundSession:fast:\(cwd)" : "backgroundSession:\(cwd)" }
    private var wantedModel: String { lane == .fast ? "haiku" : (cfg.model ?? Settings.model) }
    private var wantedEffort: String? { lane == .fast ? "low" : Settings.effort }

    init(cwd: String, cfg: Config, lane: Lane = .strong) {
        self.cwd = cwd
        self.cfg = cfg
        self.lane = lane
        self.model = lane == .fast ? "haiku" : (cfg.model ?? Settings.model)
        self.sessionId = UserDefaults.standard.string(forKey: lane == .fast ? "backgroundSession:fast:\(cwd)" : "backgroundSession:\(cwd)")
        self.effort = wantedEffort
    }

    var isRunning: Bool { proc?.isRunning == true }

    /// Start the process ahead of time (called when the hotkey goes down) so it's warm by the time we ask.
    func warm() { if !isRunning { start() } }

    func send(text: String, shots: [Shot]) {
        if busy { restart() } // a new question interrupts the old one; --resume keeps the conversation
        let wanted = wantedModel
        if wanted != model || wantedEffort != effort { model = wanted; effort = wantedEffort; restart() }
        if !isRunning { start() }
        busy = true
        // Built on the write queue: base64 of the screenshots is a megabyte or more.
        write(building: {
            var content: [[String: Any]] = shots.map {
                ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": $0.jpeg.base64EncodedString()]]
            }
            content.append(["type": "text", "text": text])
            return ["type": "user", "message": ["role": "user", "content": content]]
        })
        log("ask (\(cwd)): \(text.prefix(300))")
    }

    func respond(to req: PermissionRequest, allow: Bool) {
        let response: [String: Any] = allow
            ? ["behavior": "allow", "updatedInput": req.input]
            : ["behavior": "deny", "message": "The user declined this. Don't retry it; tell them what you would have done instead."]
        write(["type": "control_response", "response": ["subtype": "success", "request_id": req.id, "response": response]])
    }

    /// Forget the conversation (menu: New Conversation).
    func reset() {
        stop()
        sessionId = nil
    }

    func stop() {
        busy = false
        if let p = proc, p.isRunning { p.terminate() }
        proc = nil
        stdin = nil
    }

    private func restart() {
        stop()
        start()
    }

    private func start() {
        var args = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--permission-prompt-tool", "stdio", "--permission-mode", "default",
            "--append-system-prompt", voiceSystemPrompt,
        ] + (model == "default" ? [] : ["--model", model]) // "default": the user's own Claude Code default
          + (effort.map { ["--effort", $0] } ?? []) + [
            // Lean session: only the built-in tools voice mode uses (about half the input tokens of the full set),
            // and no plugin hooks (their per-session output also defeats prompt caching).
            "--tools", "Read,Grep,Glob,Edit,Write,Bash",
            "--settings", #"{"disableAllHooks": true}"#,
            "--allowedTools",
        ] + autoAllowedTools
        if let node = cfg.node, let server = cfg.server {
            let mcp: [String: Any] = ["mcpServers": ["visioncli": ["command": node, "args": [server]]]]
            if let data = try? JSONSerialization.data(withJSONObject: mcp) {
                args += ["--mcp-config", String(decoding: data, as: UTF8.self), "--strict-mcp-config"]
            }
        }
        if let sid = sessionId { args += ["--resume", sid] }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: cfg.claude)
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        p.environment = env

        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = inp

        let lines = LineSplitter()
        let stderrTail = TailText()
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            lines.feed(h.availableData) { line in
                guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
                DispatchQueue.main.async {
                    guard let self, self.proc === p else { return }
                    self.handle(obj)
                }
            }
        }
        err.fileHandleForReading.readabilityHandler = { h in stderrTail.append(h.availableData) }
        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            let errText = stderrTail.value
            log("claude exited \(proc.terminationStatus)\(errText.isEmpty ? "" : ": " + errText.suffix(400))")
            DispatchQueue.main.async {
                guard let self, self.proc === proc else { return }
                self.proc = nil
                self.stdin = nil
                if self.busy {
                    self.busy = false
                    let tail = errText.split(separator: "\n").suffix(3).joined(separator: "\n")
                    self.onDone(nil, tail.isEmpty ? "Claude stopped unexpectedly (exit \(proc.terminationStatus))." : tail)
                }
            }
        }
        do {
            try p.run()
            proc = p
            stdin = inp.fileHandleForWriting
            log("claude started in \(cwd) (model \(model)\(sessionId.map { ", resume \($0)" } ?? ""))")
        } catch {
            log("failed to start claude: \(error)")
            onDone(nil, "Couldn't start claude at \(cfg.claude): \(error.localizedDescription)")
        }
    }

    /// Writes to claude's stdin happen here, in order: a screenshot message is far bigger than the 64 KB pipe buffer,
    /// so a write blocks until claude has read it, which must not be the main thread.
    private let writer = DispatchQueue(label: "dev.visioncli.claude.stdin", qos: .userInitiated)

    private func write(_ obj: [String: Any]) { write(building: { obj }) }

    private func write(building make: @escaping () -> [String: Any]) {
        guard let stdin else { return }
        writer.async {
            guard var data = try? JSONSerialization.data(withJSONObject: make()) else { return }
            data.append(0x0A)
            do { try stdin.write(contentsOf: data) } catch { log("write to claude failed: \(error)") }
        }
    }

    private func handle(_ obj: [String: Any]) {
        if let sid = obj["session_id"] as? String { sessionId = sid }
        switch obj["type"] as? String {
        case "rate_limit_event":
            if let info = obj["rate_limit_info"] as? [String: Any] { UsageTracker.shared.record(info) }
        case "stream_event":
            guard obj["parent_tool_use_id"] == nil || obj["parent_tool_use_id"] is NSNull,
                  let ev = obj["event"] as? [String: Any] else { return }
            if ev["type"] as? String == "content_block_start",
               (ev["content_block"] as? [String: Any])?["type"] as? String == "tool_use" {
                onToolStart()
            }
            if ev["type"] as? String == "content_block_delta",
               let d = ev["delta"] as? [String: Any], d["type"] as? String == "text_delta",
               let text = d["text"] as? String {
                onDelta(text)
            }
        case "assistant":
            let content = (obj["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in content where block["type"] as? String == "tool_use" {
                let name = block["name"] as? String ?? "", input = block["input"] as? [String: Any] ?? [:]
                if let id = block["id"] as? String { toolNames[id] = name }
                onStatus(ClaudeSession.describe(tool: name, input: input))
                onToolUse(name, input)
            }
        case "user":
            let content = (obj["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in content where block["type"] as? String == "tool_result" {
                var text = ""
                if let s = block["content"] as? String { text = s }
                else if let parts = block["content"] as? [[String: Any]] {
                    text = parts.map { ($0["text"] as? String) ?? ($0["type"] as? String == "image" ? "[image]" : "") }.joined(separator: "\n")
                }
                onToolResult(text, block["is_error"] as? Bool ?? false, (block["tool_use_id"] as? String).flatMap { toolNames[$0] })
            }
        case "control_request":
            guard let id = obj["request_id"] as? String, let req = obj["request"] as? [String: Any] else { return }
            if req["subtype"] as? String == "can_use_tool" {
                let r = PermissionRequest(id: id, tool: req["tool_name"] as? String ?? "", input: req["input"] as? [String: Any] ?? [:])
                log("permission requested: \(r.tool)")
                onPermission(r)
            } else {
                write(["type": "control_response", "response": ["subtype": "error", "request_id": id, "error": "unsupported"]])
            }
        case "result":
            busy = false
            if let cost = obj["total_cost_usd"] as? Double { onCost(cost) }
            let isError = obj["is_error"] as? Bool ?? false
            let result = obj["result"] as? String
            log("result: \((result ?? "").prefix(200))")
            onDone(isError ? nil : result, isError ? (result ?? "Something went wrong") : nil)
        default:
            break
        }
    }

    static func describe(tool: String, input: [String: Any]) -> String {
        func base(_ key: String) -> String { ((input[key] as? String) ?? "").split(separator: "/").last.map(String.init) ?? "" }
        switch tool {
        case "mcp__visioncli__look": return "Taking another look…"
        case "mcp__visioncli__list_windows": return "Checking open windows…"
        case "mcp__visioncli__device_screenshot": return "Looking at the simulator…"
        case "mcp__visioncli__db_schema": return "Reading the database schema…"
        case "mcp__visioncli__db_query": return "Querying the database…"
        case "mcp__visioncli__ui_elements": return "Reading the app's controls…"
        case "mcp__visioncli__click", "mcp__visioncli__type_text", "mcp__visioncli__press_keys", "mcp__visioncli__scroll",
             "mcp__visioncli__drag", "mcp__visioncli__open_app", "mcp__visioncli__open_url": return "Using your computer…"
        case "Read": return "Reading \(base("file_path"))…"
        case "Grep": return "Searching for “\((input["pattern"] as? String ?? "").prefix(40))”…"
        case "Glob": return "Finding files…"
        case "Edit", "MultiEdit", "Write": return "Editing \(base("file_path"))…"
        case "Bash": return "Running a command…"
        case "ToolSearch": return "Getting ready…"
        // Gemini CLI tools (and visioncli MCP tools as Gemini names them)
        case "read_file", "read_many_files": return "Reading \(base("absolute_path").isEmpty ? base("file_path") : base("absolute_path"))…"
        case "grep_search", "search_file_content": return "Searching for “\((input["pattern"] as? String ?? "").prefix(40))”…"
        case "glob", "list_directory": return "Finding files…"
        case "replace", "write_file": return "Editing \(base("file_path"))…"
        case "run_shell_command": return "Running a command…"
        case "google_web_search", "web_fetch": return "Searching the web…"
        case "view_file": return "Looking at \(((input["AbsolutePath"] as? String) ?? "").split(separator: "/").last.map(String.init) ?? "a file")…"
        case "list_dir", "find_by_name": return "Finding files…"
        case "run_command": return "Running a command…"
        case "write_to_file", "replace_file_content", "multi_replace_file_content": return "Editing \(((input["TargetFile"] as? String) ?? "").split(separator: "/").last.map(String.init) ?? "a file")…"
        case "search_web", "read_url_content": return "Searching the web…"
        case "look": return "Taking another look…"
        case "db_schema": return "Reading the database schema…"
        case "db_query": return "Querying the database…"
        default: return "Working…"
        }
    }
}
