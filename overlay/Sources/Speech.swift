import AppKit
import AudioToolbox
import AVFoundation
import Speech

/// On-device speech-to-text while the hotkey is held.
///
/// Threading: the public API and the recognition state belong to the main thread. Opening and closing the microphone
/// (AVAudioEngine / AVCaptureSession start and stop, a few hundred ms) runs on `audio`, a serial queue, so the bubble
/// appears at once; start, stop and cancel are queued there in the order they're called. The `audio*` state below is
/// only touched on that queue.
final class Listener {
    private let audio = DispatchQueue(label: "dev.visioncli.audio", qos: .userInteractive)
    // Recreated for every question: a long-lived engine keeps a stale input format after the mic changes
    // (AirPods connect, Teams/Zoom grab the device, sample-rate switch), and installTap then aborts the app.
    private var engine = AVAudioEngine()            // audio queue
    private var configObserver: NSObjectProtocol?   // audio queue
    private var tapped = false                      // audio queue
    private var recording = false                   // audio queue: a question's audio is being captured
    private var generation = 0                      // main: bumped by every start/cancel, so stale callbacks are dropped
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer: SFSpeechRecognizer?
    private var latest = ""
    private var finish: ((String) -> Void)?
    let recorder = WavRecorder()

    var onText: (String) -> Void = { _ in }
    var onLevel: (CGFloat) -> Void = { _ in }
    /// Why live captions aren't working (permission, Dictation off, …); shown in the pill. Recording continues.
    var onIssue: (String) -> Void = { _ in }
    private(set) var lastIssue: String?

    /// The request audio is appended to; swapped when recognition restarts (e.g. on-device → online).
    private let box = RequestBox()
    private var retriedOnline = false

    init(locale: String?) {
        if let locale { recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) }
        else { recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) }
    }

    /// Start listening. Call on main. The microphone opens on the audio queue; if it can't, `failed` is called on
    /// main (unless this listen was cancelled or replaced by then).
    func start(failed: @escaping (Error) -> Void) {
        cancel()
        latest = ""
        lastIssue = nil
        retriedOnline = false
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        // Prefer on-device; if that fails (model not downloaded for this language), we retry online below.
        if recognizer?.supportsOnDeviceRecognition == true { req.requiresOnDeviceRecognition = true }
        request = req
        box.set(req)

        let onBuffer = handler(for: req)
        let gen = generation
        audio.async { [weak self] in
            guard let self else { return }
            do {
                try self.startAudio(onBuffer)
            } catch {
                DispatchQueue.main.async {
                    guard self.generation == gen else { return } // cancelled, or a newer listen started
                    self.cancel() // no captions without audio either
                    failed(error)
                }
            }
        }
        startRecognition(req)
    }

    /// Audio queue: open the picked mic, or the system default through AVAudioEngine.
    private func startAudio(_ onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        recording = true
        // A specific mic picked in the menu is captured input-only (AVCaptureSession). AVAudioEngine drives input
        // and output as one unit, so it can't use e.g. the built-in mic, which is a separate device from the speakers.
        if let uid = Settings.inputDeviceUID, let device = AudioDevices.device(uid: uid) {
            if let mic = CaptureMic(uid: uid) {
                recorder.begin()
                mic.onBuffer = onBuffer
                if mic.start() {
                    capture = mic
                    log("listener: capturing from \(device.name)")
                } else {
                    _ = recorder.finish()
                    log("listener: \(device.name) didn't start; using the system default mic")
                }
            } else {
                log("listener: can't open \(device.name); using the system default mic")
            }
        }
        if capture == nil {
            do { try startEngine(onBuffer) } catch { recording = false; throw error }
        }
    }

    /// Main: live captions through Apple's recognizer (the audio is appended to `req` as it arrives).
    private func startRecognition(_ req: SFSpeechAudioBufferRecognitionRequest) {
        // Live captions need Speech Recognition permission and an available recognizer. Without them we still
        // record (Whisper can transcribe on release) and say why captions are missing.
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { _ in }
            report("Allow Speech Recognition for VisionCLI to see live captions (macOS is asking).")
            return
        default:
            report("Live captions need Speech Recognition: System Settings → Privacy & Security → Speech Recognition → VisionCLI.")
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            report("Apple speech recognition isn't available right now (check Siri & Dictation in System Settings → Keyboard).")
            return
        }
        startTask(recognizer, req)
    }

    private func startTask(_ recognizer: SFSpeechRecognizer, _ req: SFSpeechAudioBufferRecognitionRequest) {
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.request === req else { return }
                // The final result after endAudio() is sometimes empty; never let it wipe what we heard.
                if let text = result?.bestTranscription.formattedString, !text.isEmpty {
                    self.latest = text
                    self.onText(text)
                }
                if let error, self.finish == nil { self.recognitionFailed(error, recognizer, req); return }
                if result?.isFinal == true || error != nil { self.complete() }
            }
        }
    }

    /// Recognition stopped while still listening: retry online if on-device failed, otherwise explain.
    private func recognitionFailed(_ error: Error, _ recognizer: SFSpeechRecognizer, _ failed: SFSpeechAudioBufferRecognitionRequest) {
        let e = error as NSError
        log("listener: recognition error \(e.domain) \(e.code): \(e.localizedDescription)")
        if failed.requiresOnDeviceRecognition && !retriedOnline {
            retriedOnline = true
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            req.addsPunctuation = true
            req.requiresOnDeviceRecognition = false
            request = req
            box.set(req)
            log("listener: retrying with online recognition")
            startTask(recognizer, req)
            return
        }
        let text = e.localizedDescription.lowercased()
        if text.contains("siri") || text.contains("dictation") || e.code == 201 {
            report("Live captions need Dictation: turn on System Settings → Keyboard → Dictation (and Siri & Dictation in Privacy).")
        } else if e.code == 203 || text.contains("no speech") {
            return // just silence so far; keep listening
        } else {
            report("Live captions stopped (\(e.localizedDescription)). Still recording.")
        }
    }

    private func report(_ issue: String) {
        lastIssue = issue
        log("listener: \(issue)")
        onIssue(issue)
    }

    private var capture: CaptureMic?   // audio queue

    /// What to do with each microphone buffer: feed speech recognition, the WAV for Whisper, and the level meter.
    private func handler(for req: SFSpeechAudioBufferRecognitionRequest) -> (AVAudioPCMBuffer) -> Void {
        let recorder = self.recorder
        let box = self.box
        return { [weak self] buf in
            box.current?.append(buf)
            recorder.append(buf)
            guard let ch = buf.floatChannelData?[0], buf.frameLength > 0 else { return }
            var sum: Float = 0
            for i in 0..<Int(buf.frameLength) { sum += ch[i] * ch[i] }
            let level = CGFloat(min(1, sqrt(sum / Float(buf.frameLength)) * 12))
            DispatchQueue.main.async { self?.onLevel(level) }
        }
    }

    /// Audio queue: the system default mic through AVAudioEngine.
    private func startEngine(_ onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        if engine.isRunning { engine.stop() }
        engine = AVAudioEngine()
        let input = engine.inputNode
        let hardware = input.inputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else {
            log("listener: no usable input (\(hardware))")
            throw NSError(domain: "visioncli", code: 2, userInfo: [NSLocalizedDescriptionKey:
                "No microphone input right now (the audio device may be switching, or another app is using it). Try again in a moment"])
        }
        recorder.begin()
        // format: nil = the node's own output format; an explicit format that disagrees with it aborts the app.
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in onBuffer(buf) }
        tapped = true
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            _ = recorder.finish()
            throw error
        }
        // Bluetooth headsets (AirPods, Sony…) switch to their call profile when the mic opens, which stops the engine
        // mid-question. Re-attach to the new input and keep recording into the same file.
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        let current = engine
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: current, queue: nil) { [weak self] _ in
            self?.audio.async { self?.inputChanged(current, onBuffer) }
        }
    }

    /// Audio queue: the input device changed under a running engine; re-attach to the new input.
    private func inputChanged(_ current: AVAudioEngine, _ onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        guard engine === current, recording else { return }
        let input = current.inputNode
        let format = input.inputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { log("listener: input changed, no usable format yet"); return }
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in onBuffer(buf) }
        current.prepare()
        do { try current.start(); log("listener: input changed (\(Int(format.sampleRate)) Hz), resumed") }
        catch { log("listener: input changed, couldn't resume: \(error.localizedDescription)") }
    }

    /// Stop recording. Call on main. `onRecording` gets the finished WAV (nil if nothing was recorded) as soon as the
    /// microphone is closed, so a local engine can start transcribing right away; `done` gets Apple's final
    /// transcript (or whatever it had after a short grace period), both on main.
    func stop(onRecording: @escaping (URL?) -> Void = { _ in }, done: @escaping (String) -> Void) {
        finish = done
        let req = request, gen = generation
        audio.async { [weak self] in
            guard let self else { return }
            let url = self.stopAudio()
            DispatchQueue.main.async {
                self.recordingURL = url
                req?.endAudio()
                onRecording(url)
                // Grace period for Apple's final result, from when its audio ended.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    guard let self, self.generation == gen else { return } // not for a newer question's stop
                    self.complete()
                }
            }
        }
    }

    func cancel() {
        generation += 1
        box.set(nil)
        finish = nil
        task?.cancel()
        task = nil
        request = nil
        audio.async { [weak self] in _ = self?.stopAudio() }
    }

    /// Audio queue: close the microphone and the WAV; returns the WAV (nil if nothing was recorded).
    private func stopAudio() -> URL? {
        guard recording || capture != nil || tapped else { return nil }
        recording = false
        capture?.stop()
        capture = nil
        if engine.isRunning { engine.stop() }
        // Touching inputNode when we never used it opens the mic (and flips Bluetooth headsets into call mode).
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        if let configObserver { NotificationCenter.default.removeObserver(configObserver); self.configObserver = nil }
        let url = recorder.finish()
        let bytes = (url.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int }) ?? 0
        log("listener: recorded \(String(format: "%.1f", Double(max(0, bytes - 44)) / 32000))s")
        return url
    }

    /// The WAV of the last question (for Whisper), available once stop() has closed the microphone.
    private(set) var recordingURL: URL?

    /// Stop waiting for Apple's final transcript (a local engine already has the question): `done` gets what Apple
    /// had so far, and no more live text arrives.
    func finishNow() { complete() }

    private func complete() {
        guard let done = finish else { return }
        finish = nil
        task?.cancel()
        task = nil
        request = nil // results still queued for the main thread are dropped (they'd overwrite the question shown)
        done(latest.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

/// Thread-safe holder for the request the audio thread appends to.
final class RequestBox {
    private let lock = NSLock()
    private var req: SFSpeechAudioBufferRecognitionRequest?
    var current: SFSpeechAudioBufferRecognitionRequest? { lock.lock(); defer { lock.unlock() }; return req }
    func set(_ r: SFSpeechAudioBufferRecognitionRequest?) { lock.lock(); req = r; lock.unlock() }
}

/// Input-only capture from one specific microphone, delivered as PCM buffers.
final class CaptureMic: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureAudioDataOutput()
    private let queue = DispatchQueue(label: "visioncli.mic")
    var onBuffer: (AVAudioPCMBuffer) -> Void = { _ in }

    init?(uid: String) {
        guard let device = AVCaptureDevice(uniqueID: uid), let input = try? AVCaptureDeviceInput(device: device) else { return nil }
        super.init()
        guard session.canAddInput(input), session.canAddOutput(output) else { return nil }
        session.addInput(input)
        // Float32, non-interleaved: the layout speech recognition and the level meter expect.
        output.audioSettings = [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32,
                                AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: true]
        session.addOutput(output)
        output.setSampleBufferDelegate(self, queue: queue)
    }

    func start() -> Bool {
        session.startRunning()
        return session.isRunning
    }

    func stop() {
        output.setSampleBufferDelegate(nil, queue: nil)
        session.stopRunning()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let desc = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        pcm.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList) == noErr else { return }
        onBuffer(pcm)
    }
}

/// Reads answers aloud sentence by sentence as they stream in, with Kokoro when available
/// (synthesized ahead, played in order) and the system voice otherwise.
final class Speaker: NSObject, AVAudioPlayerDelegate {
    private let synth = AVSpeechSynthesizer()
    var kokoro: KokoroEngine?
    private var spokenUpTo = 0
    private var generation = 0
    private var nextId = 0
    private var nextToPlay = 0
    private var ready: [Int: URL?] = [:]
    private var player: AVAudioPlayer?

    func reset() {
        if nextToPlay < nextId { log("tts: reset with \(nextId - nextToPlay) sentences pending") }
        generation += 1
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        ready = [:]
        nextId = 0
        nextToPlay = 0
        spokenUpTo = 0
    }

    var isSpeaking: Bool { synth.isSpeaking || player?.isPlaying == true || nextToPlay < nextId }

    /// Feed the full display text so far; speaks any newly completed sentences (or everything when final).
    func feed(_ text: String, final: Bool, force: Bool = false) {
        guard Settings.speak || force, text.count > spokenUpTo else { return }
        let rest = String(text.dropFirst(spokenUpTo))
        var cut = rest.endIndex
        if !final {
            // Speak up to the last sentence boundary only.
            guard let r = rest.range(of: #"[.!?](\s|$)|\n"#, options: [.regularExpression, .backwards]) else { return }
            cut = r.upperBound
        }
        let chunk = String(rest[..<cut])
        spokenUpTo += chunk.count
        let spoken = SpokenText.clean(chunk).trimmingCharacters(in: .whitespacesAndNewlines)
        guard SpokenText.speakable(spoken) else { return }
        if Settings.ttsEngine == "kokoro", let kokoro {
            // One request per sentence so the first one starts playing quickly.
            for sentence in SpokenText.sentences(spoken) { enqueueKokoro(sentence, kokoro) }
        } else {
            speakSystem(spoken)
        }
    }

    private func enqueueKokoro(_ text: String, _ kokoro: KokoroEngine) {
        let id = nextId, gen = generation
        nextId += 1
        // Kokoro tops out at 2×.
        kokoro.synth(text, voice: Settings.kokoroVoice, speed: min(2.0, 1.08 * Settings.speechSpeed)) { [weak self] url in
            guard let self else { return }
            guard gen == self.generation else { log("tts: dropped stale sentence \(id)"); return }
            log("tts: sentence \(id) ready (\(url == nil ? "failed" : "ok"))")
            // A failed sentence is skipped: switching to the system voice mid-answer talked over Kokoro.
            self.ready[id] = .some(url)
            self.pump()
        }
    }

    private func pump() {
        guard player?.isPlaying != true, let entry = ready.removeValue(forKey: nextToPlay) else { return }
        nextToPlay += 1
        guard let url = entry else { pump(); return }
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            // Chatterbox has no speed option: play it faster instead (pitch kept).
            if url.lastPathComponent.hasPrefix("tts-cb") { p.enableRate = true; p.rate = Float(min(2.0, Settings.speechSpeed)) }
            // The speaker picked in the menu (app-only), if it's still connected.
            if let uid = Settings.outputDeviceUID, AudioDevices.device(uid: uid) != nil { p.currentDevice = uid }
            player = p
            p.delegate = self
            let ok = p.play()
            log("tts: playing sentence \(nextToPlay - 1) (\(String(format: "%.1f", p.duration))s) started=\(ok)")
        } catch {
            log("tts: can't play \(url.lastPathComponent): \(error)")
            pump()
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        try? FileManager.default.removeItem(at: player.url!)
        DispatchQueue.main.async { self.pump() }
    }

    private func speakSystem(_ text: String) {
        if let uid = Settings.outputDeviceUID, AudioDevices.device(uid: uid) != nil {
            // AVSpeechSynthesizer can't pick a device, so render to a file and play it through the queue.
            let id = nextId, gen = generation
            nextId += 1
            renderSystem(text) { [weak self] url in
                guard let self, gen == self.generation else { return }
                self.ready[id] = .some(url)
                self.pump()
            }
            return
        }
        synth.speak(utterance(text))
    }

    private let renderer = AVSpeechSynthesizer()

    private func renderSystem(_ text: String, _ done: @escaping (URL?) -> Void) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("visioncli-say-\(UUID().uuidString).caf")
        var file: AVAudioFile?
        var finished = false
        renderer.write(utterance(text)) { buffer in
            guard !finished else { return }
            guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                finished = true
                file = nil // closes the file
                DispatchQueue.main.async { done(FileManager.default.fileExists(atPath: url.path) ? url : nil) }
                return
            }
            if file == nil { file = try? AVAudioFile(forWriting: url, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved) }
            try? file?.write(from: pcm)
        }
    }

    private func utterance(_ text: String) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: text)
        u.rate = Float(min(Double(AVSpeechUtteranceMaximumSpeechRate), 0.52 + (Settings.speechSpeed - 1) * 0.2))
        if let name = Settings.voiceName, let v = AVSpeechSynthesisVoice(identifier: name) { u.voice = v }
        else { u.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier.hasPrefix("en") ? Locale.current.identifier.replacingOccurrences(of: "_", with: "-") : "en-US") }
        return u
    }
}
