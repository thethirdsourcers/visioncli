import AVFoundation
import Foundation

// Local voice models. Both run as long-lived processes so each question only pays inference time:
// - Whisper (whisper.cpp `whisper-server`) for the final transcript: better with technical words than
//   Apple's recognizer, especially with a vocabulary hint. Apple's recognizer still drives the live preview.
// - Kokoro (kokoro-onnx via `uv`) for natural-sounding answers, synthesized sentence by sentence.

enum VoiceModels {
    static let searchDirs = [
        supportDir.appendingPathComponent("models").path,
        home.appendingPathComponent(".cache/hyperframes/whisper/models").path,
        home.appendingPathComponent(".cache/whisper").path,
        home.appendingPathComponent(".cache/hyperframes/tts/models").path,
        home.appendingPathComponent(".cache/hyperframes/tts/voices").path,
        "/opt/homebrew/share/whisper-cpp",
        "/usr/local/share/whisper-cpp",
    ]

    /// Whisper ggml models found on disk: name ("small.en") → path, most useful first.
    static func whisperModels() -> [(String, String)] {
        let preferred = ["small.en", "small", "base.en", "medium.en", "medium", "large-v3-turbo", "large-v3", "base", "tiny.en"]
        var found: [String: String] = [:]
        for dir in searchDirs {
            for file in (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [] where file.hasPrefix("ggml-") && file.hasSuffix(".bin") {
                let name = String(file.dropFirst(5).dropLast(4))
                if !name.contains("for-tests"), found[name] == nil { found[name] = "\(dir)/\(file)" }
            }
        }
        return found.sorted { (preferred.firstIndex(of: $0.key) ?? 99) < (preferred.firstIndex(of: $1.key) ?? 99) }
    }

    static func find(_ file: String) -> String? {
        searchDirs.map { "\($0)/\(file)" }.first { FileManager.default.fileExists(atPath: $0) }
    }

    static func binary(_ name: String, path: String) -> String? {
        let dirs = path.split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin", "\(home.path)/.local/bin", "\(home.path)/.cargo/bin"]
        return dirs.map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static var kokoroModel: String? { find("kokoro-v1.0.onnx") }

    // Helper PIDs are recorded so a later launch can clean up after a crash or hard kill.
    static let pidFile = supportDir.appendingPathComponent("helpers.pid")

    static func remember(_ pid: Int32) {
        var pids = (try? String(contentsOf: pidFile, encoding: .utf8)) ?? ""
        pids += "\(pid)\n"
        try? pids.write(to: pidFile, atomically: true, encoding: .utf8)
    }

    /// Kill helpers left over from a previous run (only if they're still whisper-server / kokoro processes).
    /// The list is read (and the file removed) right away, so helpers started from now on aren't touched; the `ps`
    /// checks run in the background (one per pid, too slow for launch on the main thread).
    static func killStrays() {
        guard let text = try? String(contentsOf: pidFile, encoding: .utf8) else { return }
        try? FileManager.default.removeItem(at: pidFile)
        let pids = text.split(separator: "\n").compactMap { Int32($0) }
        guard !pids.isEmpty else { return }
        DispatchQueue.global(qos: .utility).async {
            let (_, ps, _) = shell("/bin/ps", ["-o", "pid=,ppid=,command=", "-p", pids.map(String.init).joined(separator: ",")])
            let me = ProcessInfo.processInfo.processIdentifier
            for line in ps.split(separator: "\n") {
                let f = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
                // Skip our own children: a helper this launch just started may have reused an old pid.
                guard f.count == 3, let pid = Int32(f[0]), Int32(f[1]) != me else { continue }
                let cmd = f[2]
                if cmd.contains("whisper-server") || cmd.contains("parakeet-server") || cmd.contains("kokoro_server") || cmd.contains("kokoro-onnx") || cmd.contains("chatterbox_server") {
                    kill(pid, SIGKILL)
                    log("killed stray helper \(pid)")
                }
            }
        }
    }

    /// Stop a helper for sure: SIGKILL it (and, for `uv run`, its python child) right away.
    static func hardStop(_ p: Process?) {
        guard let p, p.isRunning else { return }
        let pid = p.processIdentifier
        let (_, kids, _) = shell("/usr/bin/pgrep", ["-P", String(pid)])
        for child in kids.split(separator: "\n").compactMap({ Int32($0) }) { kill(child, SIGKILL) }
        kill(pid, SIGKILL)
    }
    static var kokoroVoices: String? { find("voices-v1.0.bin") }

    /// Curated Kokoro voices for the menu: id → label.
    static let kokoroVoiceList: [(String, String)] = [
        ("af_heart", "Heart (US, warm)"), ("af_bella", "Bella (US)"), ("af_nicole", "Nicole (US, soft)"),
        ("am_michael", "Michael (US)"), ("am_adam", "Adam (US)"), ("bf_emma", "Emma (UK)"), ("bm_george", "George (UK)"),
    ]
    /// The "voice" that switches the speech worker to Chatterbox Turbo (MLX): richer, about 2 s before it starts talking.
    static let chatterboxId = "chatterbox"
}

// MARK: - Whisper

final class WhisperEngine {
    let modelName: String
    private let modelPath: String
    private let binary: String
    private var proc: Process?
    private var port = 0
    private(set) var ready = false

    init?(cfg: Config, model: String) {
        guard let bin = VoiceModels.binary("whisper-server", path: cfg.path),
              let path = VoiceModels.whisperModels().first(where: { $0.0 == model })?.1 ?? VoiceModels.whisperModels().first?.1 else { return nil }
        binary = bin
        modelPath = path
        modelName = ((path as NSString).lastPathComponent as NSString).deletingPathExtension.replacingOccurrences(of: "ggml-", with: "")
    }

    func start(attempt: Int = 0) {
        guard proc == nil || proc?.isRunning == false else { return }
        ready = false
        port = Int.random(in: 18100...18999)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port), "-t", "4"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.proc === proc else { return }
                self.proc = nil
                self.ready = false
                log("whisper-server exited (\(proc.terminationStatus))")
                if attempt < 2 { self.start(attempt: attempt + 1) } // port clash or crash: try again
            }
        }
        do { try p.run() } catch { log("whisper-server failed to start: \(error)"); return }
        proc = p
        VoiceModels.remember(p.processIdentifier)
        log("whisper-server starting (\(modelName)) on port \(port)")
        waitUntilReady(tries: 120)
    }

    func stop() {
        let p = proc
        proc = nil
        ready = false
        VoiceModels.hardStop(p)
    }

    private func waitUntilReady(tries: Int) {
        guard tries > 0, let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse) != nil {
                    self.ready = true
                    log("whisper-server ready")
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitUntilReady(tries: tries - 1) }
                }
            }
        }.resume()
    }

    /// Transcribe a 16 kHz mono WAV. `prompt` biases spelling of names and jargon. Calls back on main; nil on failure.
    func transcribe(_ wav: URL, prompt: String, timeout: Double = 6, _ done: @escaping (String?) -> Void) {
        guard ready, let audio = try? Data(contentsOf: wav), let url = URL(string: "http://127.0.0.1:\(port)/inference") else { done(nil); return }
        let boundary = "visioncli-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("response_format", "json")
        field("temperature", "0")
        if !prompt.isEmpty { field("prompt", prompt) }
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"q.wav\"\r\nContent-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(audio)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let started = Date()
        URLSession.shared.dataTask(with: req) { data, _, error in
            var text: String?
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let t = obj["text"] as? String {
                // Segments are separated by newlines that can fall mid-word ("La\nravel"); words carry their own spaces.
                text = t.replacingOccurrences(of: "\n", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
                if text?.range(of: #"^\[.*\]$|^\(.*\)$"#, options: .regularExpression) != nil { text = "" } // "[BLANK_AUDIO]"
            }
            log("whisper: \(String(format: "%.2f", Date().timeIntervalSince(started)))s \(error.map { "error \($0.localizedDescription)" } ?? "")")
            DispatchQueue.main.async { done(text) }
        }.resume()
    }
}

// MARK: - Parakeet

/// NVIDIA Parakeet TDT on the Neural Engine (overlay/helpers/parakeet, built on FluidAudio). Faster than Whisper and
/// takes a word list (class names, frameworks, CLI tools) that it actually spells right. One JSON request per line.
final class ParakeetEngine {
    private var proc: Process?
    private var stdin: FileHandle?
    private var buffer = Data()
    private var callbacks: [Int: (String?) -> Void] = [:]
    private var nextId = 0
    private(set) var ready = false

    /// The helper ships inside the app (arm64 only); a dev build can also sit in Application Support.
    static var binary: String? {
        [Bundle.main.bundlePath + "/Contents/MacOS/parakeet-server", supportDir.appendingPathComponent("bin/parakeet-server").path]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func start(attempt: Int = 0) {
        guard proc?.isRunning != true, let bin = Self.binary else { return }
        ready = false
        buffer = Data()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        let input = Pipe(), output = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = FileHandle.nullDevice // CoreML prints harmless shape warnings
        output.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            DispatchQueue.main.async { self?.received(data) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.proc === proc else { return }
                self.proc = nil
                self.ready = false
                self.callbacks.values.forEach { $0(nil) }
                self.callbacks = [:]
                log("parakeet exited (\(proc.terminationStatus))")
                if attempt < 2 { self.start(attempt: attempt + 1) }
            }
        }
        do { try p.run() } catch { log("parakeet failed to start: \(error)"); return }
        proc = p
        stdin = input.fileHandleForWriting
        VoiceModels.remember(p.processIdentifier)
        log("parakeet starting (first run downloads ~600 MB of models)")
    }

    func stop() {
        let p = proc
        proc = nil
        ready = false
        VoiceModels.hardStop(p)
    }

    private func received(_ data: Data) {
        buffer.append(data)
        var start = buffer.startIndex
        defer { if start != buffer.startIndex { buffer = Data(buffer[start...]) } }
        while let nl = buffer[start...].firstIndex(of: 0x0A) {
            var line = buffer[start..<nl]
            start = buffer.index(after: nl)
            // CoreML prints warnings to stdout without a newline, so they can prefix a reply: start at the JSON.
            if let brace = line.firstIndex(of: 0x7B) { line = line[brace...] }
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if obj["ready"] as? Bool == true { ready = true; log("parakeet ready"); continue }
            if let err = obj["error"] as? String, obj["id"] == nil { log("parakeet: \(err)"); continue }
            guard let id = obj["id"] as? Int, let done = callbacks.removeValue(forKey: id) else { continue }
            let boosted = (obj["boosted"] as? [String]) ?? []
            log("parakeet: \(obj["ms"] ?? "?")ms\(boosted.isEmpty ? "" : " vocabulary: " + boosted.joined(separator: "; "))\(obj["error"].map { " error \($0)" } ?? "")")
            done(obj["text"] as? String)
        }
    }

    /// Transcribe a 16 kHz mono WAV, spelling `vocabulary` terms as given. Calls back on main; nil on failure.
    func transcribe(_ wav: URL, vocabulary: [String], timeout: Double = 6, _ done: @escaping (String?) -> Void) {
        guard ready, let stdin else { done(nil); return }
        nextId += 1
        let id = nextId
        callbacks[id] = done
        let req: [String: Any] = ["id": id, "wav": wav.path, "vocab": vocabulary]
        guard var line = try? JSONSerialization.data(withJSONObject: req) else { callbacks[id] = nil; done(nil); return }
        line.append(0x0A)
        do { try stdin.write(contentsOf: line) } catch { callbacks[id] = nil; done(nil); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            if let cb = self?.callbacks.removeValue(forKey: id) { log("parakeet: timed out"); cb(nil) }
        }
    }
}

// MARK: - Kokoro

final class KokoroEngine {
    private let cfg: Config
    private var proc: Process?
    private var stdin: FileHandle?
    private var callbacks: [Int: (URL?) -> Void] = [:]
    private var nextId = 0
    private(set) var ready = false

    static var available: Bool {
        VoiceModels.kokoroModel != nil && VoiceModels.kokoroVoices != nil && VoiceModels.binary("uv", path: ProcessInfo.processInfo.environment["PATH"] ?? "") != nil
    }

    init(cfg: Config) { self.cfg = cfg }

    var isRunning: Bool { proc?.isRunning == true }
    /// The running worker is Chatterbox, not Kokoro (same protocol; picked by the chosen voice).
    private(set) var chatterbox = false

    func start() {
        let wantChatterbox = Settings.kokoroVoice == VoiceModels.chatterboxId
        if isRunning, wantChatterbox != chatterbox { stop() }
        guard !isRunning, let uv = VoiceModels.binary("uv", path: cfg.path),
              let script = Bundle.main.path(forResource: wantChatterbox ? "chatterbox_server" : "kokoro_server", ofType: "py") else {
            log("speech worker unavailable (needs uv)")
            return
        }
        let outDir = FileManager.default.temporaryDirectory.appendingPathComponent("visioncli-tts")
        let args: [String]
        if wantChatterbox {
            args = ["run", "--quiet", "--python", "3.11", "--with", "mlx-audio", "--with", "soundfile", "python", script, outDir.path]
        } else {
            guard let model = VoiceModels.kokoroModel, let voices = VoiceModels.kokoroVoices else {
                log("kokoro unavailable (needs kokoro-v1.0.onnx, voices-v1.0.bin)")
                return
            }
            args = ["run", "--quiet", "--with", "kokoro-onnx", "--with", "soundfile", "python", script, model, voices, outDir.path]
        }
        chatterbox = wantChatterbox
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: uv)
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        p.environment = env
        let out = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = inp

        let lines = LineSplitter()
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            lines.feed(h.availableData) { line in
                guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
                DispatchQueue.main.async { self?.handle(obj) }
            }
        }
        p.terminationHandler = { [weak self] proc in
            out.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self, self.proc === proc else { return }
                log("kokoro exited (\(proc.terminationStatus))")
                self.proc = nil
                self.stdin = nil
                self.ready = false
                self.callbacks.values.forEach { $0(nil) }
                self.callbacks = [:]
            }
        }
        do { try p.run() } catch { log("kokoro failed to start: \(error)"); return }
        proc = p
        VoiceModels.remember(p.processIdentifier)
        stdin = inp.fileHandleForWriting
        log("\(chatterbox ? "chatterbox" : "kokoro") starting")
    }

    func stop() {
        let p = proc
        proc = nil
        VoiceModels.hardStop(p)
        stdin = nil
        ready = false
    }

    /// Queue text for synthesis; the callback gets a WAV file (or nil) on the main thread.
    func synth(_ text: String, voice: String, speed: Double, _ done: @escaping (URL?) -> Void) {
        if !isRunning { start() }
        guard let stdin else { done(nil); return }
        nextId += 1
        callbacks[nextId] = done
        let msg: [String: Any] = ["id": nextId, "text": text, "voice": voice, "speed": speed]
        guard var data = try? JSONSerialization.data(withJSONObject: msg) else { done(nil); return }
        data.append(0x0A)
        do { try stdin.write(contentsOf: data) } catch { callbacks[nextId] = nil; done(nil) }
    }

    private func handle(_ obj: [String: Any]) {
        if obj["ready"] as? Bool == true {
            ready = true
            log("\(chatterbox ? "chatterbox" : "kokoro") ready")
            return
        }
        guard let id = obj["id"] as? Int, let cb = callbacks.removeValue(forKey: id) else { return }
        if let err = obj["error"] as? String { log("kokoro error: \(err)") }
        cb((obj["path"] as? String).map { URL(fileURLWithPath: $0) })
    }
}

// MARK: - Recording for Whisper

/// Writes microphone buffers to a 16 kHz mono 16-bit WAV, the format whisper.cpp wants.
final class WavRecorder {
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private let lock = NSLock()
    private(set) var url: URL?

    func begin() {
        lock.lock(); defer { lock.unlock() }
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("visioncli-question.wav")
        try? FileManager.default.removeItem(at: u)
        converter = nil
        file = try? AVAudioFile(forWriting: u, settings: outFormat.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        url = file == nil ? nil : u
    }

    func append(_ buf: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard let file, buf.frameLength > 0, buf.format.sampleRate > 0 else { return }
        // Build (or rebuild) the converter from the format the buffers actually arrive in.
        if converter == nil || converter?.inputFormat != buf.format {
            converter = AVAudioConverter(from: buf.format, to: outFormat)
        }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buf.frameLength) * outFormat.sampleRate / buf.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        if error == nil, out.frameLength > 0 { try? file.write(from: out) }
    }

    /// Close the file and return it (nil if nothing was recorded).
    func finish() -> URL? {
        lock.lock(); defer { lock.unlock() }
        let length = file?.length ?? 0
        file = nil
        converter = nil
        return length > 1600 ? url : nil // < 0.1 s is nothing
    }
}
