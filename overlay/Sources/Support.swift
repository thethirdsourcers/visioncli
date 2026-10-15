import AppKit
import Foundation

// MARK: - Paths & log

let home = FileManager.default.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/visioncli")
let logURL = home.appendingPathComponent("Library/Logs/visioncli.log")

func log(_ message: String) {
    let line = "\(Log.stamp()) \(message)\n"
    CrashReporter.breadcrumb(String(line.dropLast()))
    guard let data = line.data(using: .utf8) else { return }
    Log.queue.async { Log.write(data) }
}

/// Appends log lines from any thread on one serial queue through a single open handle; rolls over to
/// visioncli.log.1 past 5 MB.
private enum Log {
    static let queue = DispatchQueue(label: "visioncli.log", qos: .utility)
    private static let formatter = ISO8601DateFormatter()
    private static let formatterLock = NSLock()
    private static let maxSize: UInt64 = 5 * 1024 * 1024
    private static var handle: FileHandle?
    private static var size: UInt64 = 0

    /// ISO8601DateFormatter isn't documented as thread-safe, and log() runs on many threads.
    static func stamp() -> String {
        formatterLock.lock()
        defer { formatterLock.unlock() }
        return formatter.string(from: Date())
    }

    /// Only on `queue`.
    static func write(_ data: Data) {
        if handle == nil { open() }
        guard let h = handle else { return }
        do {
            size = try h.seekToEnd() // another process (or a deleted file) may have moved the end
            try h.write(contentsOf: data)
            size += UInt64(data.count)
        } catch {
            try? h.close()
            handle = nil
            return
        }
        if size > maxSize { rotate() }
    }

    private static func open() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: logURL.path) {
            try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: logURL.path, contents: nil)
        }
        handle = try? FileHandle(forWritingTo: logURL)
        size = (try? handle?.seekToEnd()) ?? 0
    }

    private static func rotate() {
        try? handle?.close()
        handle = nil
        let old = logURL.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: logURL, to: old)
        open()
    }
}

/// Run a command synchronously and return (status, stdout, stderr). Call off the main thread for anything slow.
@discardableResult
func shell(_ exe: String, _ args: [String], cwd: String? = nil, stdin: Data? = nil, env: [String: String]? = nil) -> (Int32, String, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    if let env { p.environment = env }
    let out = Pipe(), err = Pipe(), inp = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = stdin == nil ? FileHandle.nullDevice : inp
    do { try p.run() } catch { return (-1, "", error.localizedDescription) }
    if let stdin {
        inp.fileHandleForWriting.write(stdin)
        try? inp.fileHandleForWriting.close()
    }
    let o = out.fileHandleForReading.readDataToEndOfFile()
    let e = err.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: o, as: UTF8.self), String(decoding: e, as: UTF8.self))
}

// MARK: - Launch config

struct Config: Codable {
    var cwd = home.path            // fallback project when the window under the pointer doesn't map to one
    var claude = "claude"
    var gemini: String?
    var agy: String?
    var path = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    var node: String?
    var server: String?
    var model: String?
    var locale: String?

    static let saved = supportDir.appendingPathComponent("overlay.json")

    /// True on the very first launch (no saved settings): the downloaded app configures itself.
    private(set) static var isFirstRun = false

    /// The MCP server shipped inside the app (release builds), used when not launched via `visioncli voice`.
    static var bundledServer: String? {
        Bundle.main.resourceURL.map { $0.appendingPathComponent("server/dist/index.js").path }
            .flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
    }

    /// Where Node, claude, uv and whisper usually live; apps opened from Finder get a minimal PATH.
    static var commonPath: String {
        var dirs = ["\(home.path)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(home.path)/.volta/bin",
                    "\(home.path)/.asdf/shims", "\(home.path)/.bun/bin", "\(home.path)/.claude/local"]
        // nvm / fnm installs: newest version first
        for base in ["\(home.path)/.nvm/versions/node", "\(home.path)/.local/share/fnm/node-versions"] {
            let versions = ((try? FileManager.default.contentsOfDirectory(atPath: base)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            dirs += versions.map { base.hasSuffix("fnm/node-versions") ? "\(base)/\($0)/installation/bin" : "\(base)/\($0)/bin" }
        }
        return (dirs + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).joined(separator: ":")
    }

    /// The newest Node.js 18+ on the machine (an old /usr/local/bin/node often shadows nvm/Homebrew installs).
    static func findNode(path: String) -> String? {
        var best: (path: String, version: [Int])?
        for dir in path.split(separator: ":") {
            let candidate = "\(dir)/node"
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            let (status, out, _) = shell(candidate, ["-v"])
            let version = out.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().split(separator: ".").compactMap { Int($0) }
            guard status == 0, let major = version.first, major >= 18 else { continue }
            if best == nil || version.lexicographicallyPrecedes(best!.version) == false && version != best!.version { best = (candidate, version) }
        }
        return best?.path
    }

    static func find(_ name: String, path: String) -> String? {
        path.split(separator: ":").map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Launch arguments win and are remembered, because macOS relaunches the app without any
    /// (e.g. "Quit & Reopen" after granting Screen Recording, or start at login).
    static func load() -> Config {
        let args = Array(CommandLine.arguments.dropFirst())
        var c = Config()
        if args.contains("--cwd") {
            var it = args.makeIterator()
            while let arg = it.next() {
                switch arg {
                case "--cwd": c.cwd = it.next() ?? c.cwd
                case "--claude": c.claude = it.next() ?? c.claude
                case "--path": c.path = it.next() ?? c.path
                case "--node": c.node = it.next()
                case "--server": c.server = it.next()
                case "--model": c.model = it.next()
                case "--locale": c.locale = it.next()
                default: break
                }
            }
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
            try? JSONEncoder().encode(c).write(to: saved)
        } else if let data = try? Data(contentsOf: saved), let stored = try? JSONDecoder().decode(Config.self, from: data) {
            c = stored
        } else {
            isFirstRun = true
        }
        // Self-configure anything missing (e.g. the app was downloaded and opened from Finder).
        if !c.path.contains(".local/bin") { c.path = c.path + ":" + commonPath }
        if c.server == nil || !FileManager.default.fileExists(atPath: c.server!) { c.server = bundledServer ?? c.server }
        if c.node == nil || !FileManager.default.isExecutableFile(atPath: c.node!) { c.node = findNode(path: c.path) }
        if !c.claude.hasPrefix("/") || !FileManager.default.isExecutableFile(atPath: c.claude) { c.claude = Config.findClaude(path: c.path) ?? c.claude }
        if c.gemini == nil || !FileManager.default.isExecutableFile(atPath: c.gemini!) { c.gemini = find("gemini", path: c.path) }
        if c.agy == nil || !FileManager.default.isExecutableFile(atPath: c.agy!) { c.agy = find("agy", path: c.path) }
        if isFirstRun {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
            try? JSONEncoder().encode(c).write(to: saved)
        }
        log("launch: default project \(c.cwd), claude \(c.claude)")
        return c
    }

    static func findClaude(path: String) -> String? {
        let dirs = path.split(separator: ":").map(String.init) + ["\(home.path)/.local/bin", "\(home.path)/.claude/local", "/opt/homebrew/bin", "/usr/local/bin"]
        return dirs.map { "\($0)/claude" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Environment for `gemini` processes. By default `gemini` uses its own sign-in, exactly like running it yourself.
    /// Only if the user deliberately adds "gemini": {"apiKey": …} to integrations.json do VisionCLI's runs switch to
    /// API-key auth (via a system-settings override, leaving the user's Gemini settings alone).
    func geminiEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        let file = supportDir.appendingPathComponent("integrations.json")
        let stored = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            .flatMap { ($0["gemini"] as? [String: Any])?["apiKey"] as? String }
        if let key = stored, !key.isEmpty {
            env["GEMINI_API_KEY"] = key
            let override = supportDir.appendingPathComponent("gemini-system-settings.json")
            try? #"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#.write(to: override, atomically: true, encoding: .utf8)
            env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = override.path
        }
        return env
    }

    /// Run the visioncli node CLI (quick, warm, …).
    func visioncli(_ args: [String], stdin: Data? = nil) -> (Int32, String, String) {
        guard let node, let server else { return (-1, "", "Node.js wasn't found. Install it (https://nodejs.org) and reopen VisionCLI.") }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        return shell(node, [server] + args, stdin: stdin, env: env)
    }
}

// MARK: - User settings (menu toggles)

enum Settings {
    private static let d = UserDefaults.standard

    static var speak: Bool {
        get { d.bool(forKey: "speak") }
        set { d.set(newValue, forKey: "speak") }
    }

    /// A Claude Code model alias (fable, opus, sonnet, haiku, …; see MenuLabels.claudeModels). A --model launch flag overrides.
    static var model: String {
        get { d.string(forKey: "model") ?? "default" } // "default": whatever the user's Claude Code is set to
        set { d.set(newValue, forKey: "model") }
    }

    /// "whisper" (local whisper.cpp, default when installed) or "apple".
    static var sttEngine: String {
        get { d.string(forKey: "stt") ?? "whisper" }
        set { d.set(newValue, forKey: "stt") }
    }

    static var whisperModel: String {
        get { d.string(forKey: "whisperModel") ?? "small.en" }
        set { d.set(newValue, forKey: "whisperModel") }
    }

    /// "kokoro" (local neural voice, default when installed) or "system".
    static var ttsEngine: String {
        get { d.string(forKey: "tts") ?? "kokoro" }
        set { d.set(newValue, forKey: "tts") }
    }

    /// Speaking speed multiplier for answers (1 = normal); default 2× as requested.
    static var speechSpeed: Double {
        get { d.object(forKey: "speechSpeed") as? Double ?? 2.0 }
        set { d.set(newValue, forKey: "speechSpeed") }
    }

    static var kokoroVoice: String {
        get { d.string(forKey: "kokoroVoice") ?? "af_heart" }
        set { d.set(newValue, forKey: "kokoroVoice") }
    }

    /// Extra words for Whisper to spell right (one per line or comma-separated).
    static let vocabularyFile = supportDir.appendingPathComponent("vocabulary.txt")

    /// Terminal mode: voice questions go to a real interactive `claude` in iTerm/Terminal that you can also type into.
    static var terminalMode: Bool {
        get { d.object(forKey: "terminalMode") as? Bool ?? true }
        set { d.set(newValue, forKey: "terminalMode") }
    }

    /// Look for new releases automatically (launch + every 6 hours).
    static var autoUpdate: Bool {
        get { d.object(forKey: "autoUpdate") as? Bool ?? true }
        set { d.set(newValue, forKey: "autoUpdate") }
    }

    /// Which CLI answers voice questions: Claude Code or Gemini through Antigravity.
    /// (Gemini CLI is no longer offered; anyone who had it selected moves to Antigravity.)
    static var assistant: Assistant {
        get {
            let a = Assistant(rawValue: d.string(forKey: "assistant") ?? "") ?? .claude
            return a == .gemini ? .antigravity : a
        }
        set { d.set(newValue.rawValue, forKey: "assistant") }
    }

    /// Reasoning effort for Claude and agy (`--effort low|medium|high|xhigh|max`); nil = the CLI's default.
    static var effort: String? {
        get { d.string(forKey: "effort") }
        set { d.set(newValue, forKey: "effort") }
    }

    /// Notice app crashes (Mac and Simulator apps) and offer to explain them.
    static var watchCrashes: Bool {
        get { d.object(forKey: "watchCrashes") as? Bool ?? true }
        set { d.set(newValue, forKey: "watchCrashes") }
    }

    /// Computer control: "ask" (approve each action), "auto" (no approval except sensitive spots) or "off".
    static var computerControl: String {
        get { d.string(forKey: "computerControl") ?? "ask" }
        set { d.set(newValue, forKey: "computerControl") }
    }

    /// agy model id (from `agy models`); nil = whatever agy itself is set to.
    static var agyModel: String? {
        get { d.string(forKey: "agyModel") }
        set { d.set(newValue, forKey: "agyModel") }
    }

    /// Instant browser commands routed by Jev (TypeSafe System One) before asking Claude.
    /// Smart routing (bubble mode): Jev sends light questions to a small fast model (Haiku / Gemini Flash), heavy ones
    /// to the chosen model.
    static var smartRouting: Bool {
        get { d.object(forKey: "smartRouting") as? Bool ?? true }
        set { d.set(newValue, forKey: "smartRouting") }
    }

    static var quickCommands: Bool {
        get { d.object(forKey: "quickCommands") as? Bool ?? true }
        set { d.set(newValue, forKey: "quickCommands") }
    }

    /// Attach a screenshot to every voice question. Off: only ⌥⇧Space attaches one (the assistant can still call `look`).
    static var screenshotEveryQuestion: Bool {
        get { d.object(forKey: "screenshotEveryQuestion") as? Bool ?? false }
        set { d.set(newValue, forKey: "screenshotEveryQuestion") }
    }

    /// The first-run setup wizard was finished (or every permission was already there).
    static var setupDone: Bool {
        get { d.bool(forKey: "setupDone") }
        set { d.set(newValue, forKey: "setupDone") }
    }

    /// The wizard step to reopen on (Screen Recording needs a relaunch mid-setup).
    static var setupStep: String? {
        get { d.string(forKey: "setupStep") }
        set { d.set(newValue, forKey: "setupStep") }
    }

    /// Keep VisionCLI's windows (bubble, badge, Visi, cards, Settings…) out of screen sharing and recordings.
    static var hideFromCapture: Bool {
        get { d.bool(forKey: "hideFromCapture") }
        set { d.set(newValue, forKey: "hideFromCapture"); CaptureHiding.applyAll() }
    }

    // Meeting Notes: what it does during a meeting (Meeting Notes itself is never remembered: off at each launch).
    private static func flag(_ key: String, default value: Bool) -> Bool { d.object(forKey: key) as? Bool ?? value }

    /// A one-line summary under what colleagues say.
    static var meetingSummarizeGuest: Bool {
        get { flag("meetingSummarizeGuest", default: true) }
        set { d.set(newValue, forKey: "meetingSummarizeGuest") }
    }

    /// A one-line summary under what you say (off: you know what you said).
    static var meetingSummarizeYou: Bool {
        get { flag("meetingSummarizeYou", default: false) }
        set { d.set(newValue, forKey: "meetingSummarizeYou") }
    }

    /// Three suggested replies when a colleague asks you something.
    static var meetingReplies: Bool {
        get { flag("meetingReplies", default: true) }
        set { d.set(newValue, forKey: "meetingReplies") }
    }

    /// Questions about the code answered from the project (read-only).
    static var meetingCodeLookup: Bool {
        get { flag("meetingCodeLookup", default: true) }
        set { d.set(newValue, forKey: "meetingCodeLookup") }
    }

    /// Keep a recording of both sides, to play back with the transcript.
    static var meetingRecord: Bool {
        get { flag("meetingRecord", default: true) }
        set { d.set(newValue, forKey: "meetingRecord") }
    }

    /// Show Claude's session / weekly usage next to the project name in the menu bar.
    static var usageInMenuBar: Bool {
        get { d.object(forKey: "usageInMenuBar") as? Bool ?? true }
        set { d.set(newValue, forKey: "usageInMenuBar") }
    }

    /// Also show the weekly ring in the menu bar (the 5-hour session ring is always shown when usage is on).
    static var weeklyInMenuBar: Bool {
        get { d.bool(forKey: "weeklyInMenuBar") }
        set { d.set(newValue, forKey: "weeklyInMenuBar") }
    }

    /// A project chosen in the menu; nil = Auto (follow the window under the pointer).
    static var pinnedProject: String? {
        get { d.string(forKey: "pinnedProject") }
        set { d.set(newValue, forKey: "pinnedProject") }
    }

    /// Open the live activity terminal on the first question after launch.
    static var autoActivity: Bool {
        get { d.object(forKey: "autoActivity") as? Bool ?? true }
        set { d.set(newValue, forKey: "autoActivity") }
    }

    /// VisionCLI's own microphone / speaker (CoreAudio device UID); nil = follow the Mac's default.
    static var inputDeviceUID: String? {
        get { d.string(forKey: "inputDevice") }
        set { d.set(newValue, forKey: "inputDevice") }
    }

    static var outputDeviceUID: String? {
        get { d.string(forKey: "outputDevice") }
        set { d.set(newValue, forKey: "outputDevice") }
    }

    static var voiceName: String? {
        get { d.string(forKey: "voice") }
        set { d.set(newValue, forKey: "voice") }
    }
}

// MARK: - Start at login + restart after crash

/// A per-user launchd agent for VisionCLI. KeepAlive (only after a *crash*: SuccessfulExit = false) makes launchd
/// relaunch the app within ~10s if it dies; quitting normally exits 0 and it stays quit. RunAtLoad = start at login.
/// (SMAppService refuses apps without a Developer ID signature, which a locally built VisionCLI never has.)
/// `visioncli voice` writes the same agent and (re)starts the app through launchctl.
enum LoginItem {
    static let label = "dev.visioncli.overlay"
    static let plist = home.appendingPathComponent("Library/LaunchAgents/\(label).plist")

    private static var current: [String: Any] {
        guard let data = try? Data(contentsOf: plist),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return [:] }
        return dict
    }

    static var isEnabled: Bool { current["RunAtLoad"] as? Bool == true }

    static func set(_ on: Bool) throws {
        let agent: [String: Any] = [
            "Label": label,
            "ProgramArguments": [Bundle.main.executablePath ?? "/Applications/VisionCLI.app/Contents/MacOS/VisionCLI"],
            "RunAtLoad": on,
            "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 10,
            "ProcessType": "Interactive",
            "LimitLoadToSessionType": "Aqua",
            "StandardErrorPath": home.appendingPathComponent("Library/Logs/visioncli-stderr.log").path,
        ]
        try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: agent, format: .xml, options: 0).write(to: plist)
        log("start at login: \(on)")
    }
}

/// Runs `work` and logs it when it took long enough to make the UI stutter (to find what to move off the main thread).
@discardableResult func timed<T>(_ label: String, _ work: () throws -> T) rethrows -> T {
    let start = Date()
    defer {
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        if ms > 80 { log("slow: \(label) \(ms)ms") }
    }
    return try work()
}

/// Logs when the main thread (bubble, mascot, menus) is blocked for more than 250ms, so slow work that belongs on a
/// background queue shows up in the log.
enum MainThreadWatchdog {
    private static let queue = DispatchQueue(label: "dev.visioncli.watchdog", qos: .utility)
    private static let lock = NSLock()
    private static var answered = true

    static func start() {
        queue.async { tick() }
    }

    private static var isAnswered: Bool {
        get { lock.lock(); defer { lock.unlock() }; return answered }
        set { lock.lock(); answered = newValue; lock.unlock() }
    }

    private static func tick() {
        let sent = Date()
        isAnswered = false
        DispatchQueue.main.async { isAnswered = true }
        queue.asyncAfter(deadline: .now() + 0.25) {
            if !isAnswered {
                // Wait for it to come back, then report how long the main thread was stuck.
                while !isAnswered { Thread.sleep(forTimeInterval: 0.02) }
                log("watchdog: main thread blocked \(Int(Date().timeIntervalSince(sent) * 1000))ms")
            }
            queue.asyncAfter(deadline: .now() + 0.25) { tick() }
        }
    }
}

/// VisionCLI Home: the project for questions that aren't about any software project (general knowledge, emails,
/// web pages, everyday tasks). A real folder, so terminal mode and file-making tasks work there like anywhere else.
enum HomeProject {
    static let path = home.appendingPathComponent("VisionCLI").path

    /// Creates the folder (and the note telling the assistant what it is for) if it's missing.
    static func ensure() {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: path, withIntermediateDirectories: true)
        let note = """
        # VisionCLI Home

        This is VisionCLI's general workspace: questions asked here are not about a specific software project.
        Treat them like a general assistant would: everyday questions, writing and replying to messages, explaining
        what is on the screen, web research, small tasks on this Mac. Save any notes, drafts or files you make for the
        user in this folder unless they say otherwise.
        """
        for name in ["CLAUDE.md", "AGENTS.md"] {
            let file = (path as NSString).appendingPathComponent(name)
            if !fm.fileExists(atPath: file) { try? note.write(toFile: file, atomically: true, encoding: .utf8) }
        }
    }

    static func label(_ project: String) -> String {
        ProjectSelector.label(project, home: path)
    }
}

