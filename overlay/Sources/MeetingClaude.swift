import Foundation

// Claude for Meeting Notes. Replies have to appear seconds after a colleague stops talking, and starting `claude -p`
// costs a couple of seconds each time, so a process is kept running per job (replies, summaries) and each request
// is one more stream-json user message. It's one conversation, so it's swapped for a fresh one every few requests
// to keep the context (and the latency) small.

final class WarmClaude {
    private let label: String
    private let claude: String
    private let args: [String]
    private let cwd: URL
    private let env: [String: String]
    private var proc: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var waiting: [(id: Int, done: (String?) -> Void)] = []
    private var asked = 0
    private var nextId = 0
    static let requestsPerProcess = 12
    static let timeout: TimeInterval = 30

    init(label: String, claude: String, path: String, systemPrompt: String, model: String = "haiku", cwd: URL) {
        self.label = label
        self.claude = claude
        self.cwd = cwd
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        self.env = env
        args = ["-p", "--model", model, "--effort", "low", "--setting-sources", "project", "--system-prompt", systemPrompt,
                "--tools", "", "--strict-mcp-config", "--no-session-persistence",
                "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
    }

    /// Starts the process now, so the first request doesn't pay for it.
    func warm() { if proc == nil { spawn() } }

    /// A request is in flight.
    var busy: Bool { !waiting.isEmpty }

    /// One request; `done` gets the result text (nil on failure or timeout), on the main thread.
    func ask(_ text: String, _ done: @escaping (String?) -> Void) {
        if proc == nil || asked >= Self.requestsPerProcess && waiting.isEmpty { restart() }
        guard let input else { done(nil); return }
        let msg: [String: Any] = ["type": "user", "message": ["role": "user", "content": [["type": "text", "text": text]]]]
        guard let line = try? JSONSerialization.data(withJSONObject: msg) else { done(nil); return }
        nextId += 1
        let id = nextId
        waiting.append((id, done))
        asked += 1
        do { try input.write(contentsOf: line + Data([0x0A])) } catch {
            fail("write failed")
            return
        }
        // A stuck request would hold up every later one: give up on this process.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout) { [weak self] in
            guard let self, self.waiting.contains(where: { $0.id == id }) else { return }
            self.fail("timed out")
        }
    }

    func stop() {
        let p = proc
        proc = nil
        input = nil
        p?.terminate()
        let w = waiting
        waiting = []
        w.forEach { $0.done(nil) }
    }

    private func restart() {
        stop()
        spawn()
    }

    private func fail(_ why: String) {
        log("meeting: \(label) claude \(why)")
        restart()
    }

    private func spawn() {
        try? FileManager.default.createDirectory(at: cwd, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: claude)
        p.arguments = args
        p.currentDirectoryURL = cwd
        p.environment = env
        let out = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = inp
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            DispatchQueue.main.async { self?.received(data, from: p) }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.proc === p else { return }
                self.proc = nil
                self.input = nil
                let w = self.waiting
                self.waiting = []
                w.forEach { $0.done(nil) }
            }
        }
        do { try p.run() } catch {
            log("meeting: \(label) claude couldn't start: \(error.localizedDescription)")
            return
        }
        proc = p
        input = inp.fileHandleForWriting
        buffer = Data()
        asked = 0
    }

    private func received(_ data: Data, from p: Process) {
        guard proc === p, !data.isEmpty else { return }
        buffer += data
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
            buffer = Data(buffer[buffer.index(after: nl)...])
            guard let result = MeetingAI.result(streamLine: line), !waiting.isEmpty else { continue }
            waiting.removeFirst().done(result)
        }
    }
}

/// Several warm processes for one job, so requests run side by side: a colleague's second question doesn't wait
/// behind the replies to the first, nor a summary behind another. An idle process takes each request; a new one is
/// started (up to `size`) when all are busy, else the least loaded queues it.
final class WarmPool {
    private let make: () -> WarmClaude
    private let size: Int
    private var all: [WarmClaude] = []

    init(size: Int = 3, _ make: @escaping () -> WarmClaude) {
        self.size = size
        self.make = make
    }

    /// One process ready before the first request.
    func warm() {
        if all.isEmpty { all.append(make()) }
        all.forEach { $0.warm() }
    }

    func ask(_ text: String, _ done: @escaping (String?) -> Void) {
        let w: WarmClaude
        if let idle = all.first(where: { !$0.busy }) { w = idle }
        else if all.count < size { w = make(); all.append(w) }
        else { w = all[Int.random(in: 0..<all.count)] }
        w.ask(text, done)
    }

    func stop() {
        all.forEach { $0.stop() }
        all = []
    }
}

/// One-shot Claude runs: the code lookup (read-only tools, in the project) and the end-of-meeting summary.
enum MeetingOneShot {
    /// Runs `claude -p` with `prompt` on stdin; the result text, or nil. Killed after `timeout`. Cancellable through
    /// the returned process.
    @discardableResult
    static func run(claude: String, path: String, args: [String], cwd: String, prompt: String, timeout: TimeInterval,
                    _ done: @escaping (String?) -> Void) -> Process? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: claude)
        p.arguments = ["-p"] + args + ["--strict-mcp-config", "--no-session-persistence", "--output-format", "json"]
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        p.environment = env
        let out = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = inp
        do { try p.run() } catch { done(nil); return nil }
        try? inp.fileHandleForWriting.write(contentsOf: Data(prompt.utf8))
        try? inp.fileHandleForWriting.close()
        let timer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        DispatchQueue.global().async {
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            timer.cancel()
            // `json` is one result object, or every message in an array when verbose output is on.
            let parsed = try? JSONSerialization.jsonObject(with: data)
            let obj = (parsed as? [String: Any]) ?? (parsed as? [[String: Any]])?.last { $0["type"] as? String == "result" }
            let ok = p.terminationReason == .exit && p.terminationStatus == 0 && obj?["is_error"] as? Bool != true
            let text = ok ? (obj?["result"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            DispatchQueue.main.async { done(text?.isEmpty == false ? text : nil) }
        }
        return p
    }

    /// Read-only: the tools that can only look.
    static func lookupArgs(prompt: String) -> [String] {
        // Project settings only: user-level hooks and plugins (e.g. memory hooks) can keep a one-shot run going.
        ["--model", "sonnet", "--setting-sources", "project", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--append-system-prompt", prompt]
    }

    static func summaryArgs() -> [String] {
        ["--model", "haiku", "--effort", "low", "--setting-sources", "project", "--tools", "", "--system-prompt", MeetingAI.meetingPrompt]
    }
}
