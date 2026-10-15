import AVFoundation
import ScreenCaptureKit

// Meeting Notes' two sources, both as 16 kHz mono Int16: what the Mac plays (the guest) and the microphone (you).

/// The Mac's output audio through ScreenCaptureKit, without VisionCLI's own sounds.
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "dev.visioncli.meeting.system", qos: .userInitiated)
    var onSamples: (([Int16]) -> Void)?   // on `queue`
    var onStopped: ((Error) -> Void)?

    func start(_ done: @escaping (Error?) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { [weak self] content, error in
            guard let self else { return }
            guard let display = content?.displays.first else {
                DispatchQueue.main.async { done(error ?? NSError(domain: "visioncli", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])) }
                return
            }
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true // VisionCLI's own sounds aren't the guest
            config.sampleRate = 48000                 // 16 kHz isn't reliable: converted below
            config.channelCount = 1
            // Audio only: ScreenCaptureKit needs a display, so the video is as small and rare as it allows.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
            do { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue) } catch {
                DispatchQueue.main.async { done(error) }
                return
            }
            s.startCapture { error in
                DispatchQueue.main.async {
                    if error == nil { self.stream = s }
                    done(error)
                }
            }
        }
    }

    func stop() {
        stream?.stopCapture { _ in }
        stream = nil
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.stream === stream else { return }
            self.stream = nil
            self.onStopped?(error)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sample.isValid, let fmt = sample.formatDescription?.audioStreamBasicDescription else { return }
        var list = AudioBufferList()
        var block: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sample, bufferListSizeNeededOut: nil, bufferListOut: &list, bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block)
        // Float32; non-interleaved means the first buffer is the first (here the only) channel.
        guard status == noErr, fmt.mFormatFlags & kAudioFormatFlagIsFloat != 0, let data = list.mBuffers.mData else { return }
        let channels = fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 ? 1 : Int(max(1, fmt.mChannelsPerFrame))
        let all = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: Int(list.mBuffers.mDataByteSize) / 4)
        let mono = channels == 1 ? Array(all) : stride(from: 0, to: all.count, by: channels).map { all[$0] }
        onSamples?(MeetingAudio.to16k(mono, rate: fmt.mSampleRate))
    }
}

/// The microphone: the one picked in Settings → Voice (input-only capture, like the ⌥ listener), else the system
/// default through its own engine, so the hold-⌥ listener keeps working alongside it.
final class MicCapture {
    private var engine: AVAudioEngine?
    private var picked: CaptureMic?
    private var configObserver: NSObjectProtocol?
    private let queue = DispatchQueue(label: "dev.visioncli.meeting.mic", qos: .userInitiated)
    var onSamples: (([Int16]) -> Void)?   // on `queue`
    private(set) var deviceName = "default microphone"

    func start() throws {
        var chosen = Settings.inputDeviceUID.flatMap(AudioDevices.device(uid:)) ?? AudioDevices.defaultDevice(input: true)
        // A meeting is long: a Bluetooth headset's mic would keep its sound in the muffled call profile the whole
        // time. The Mac's own mic hears you just as well and leaves the headphones in high quality.
        if let c = chosen, AudioDevices.isBluetooth(c), let builtIn = AudioDevices.builtInInput {
            log("meeting: \(c.name) is Bluetooth; using \(builtIn.name) so the headphones keep their sound quality")
            chosen = builtIn
        }
        if let device = chosen, let mic = CaptureMic(uid: device.uid) {
            mic.onBuffer = { [weak self] buf in self?.deliver(buf) }
            if mic.start() {
                picked = mic
                deviceName = device.name
                log("meeting: microphone \(device.name)")
                return
            }
            log("meeting: \(device.name) didn't start; using the default microphone")
        }
        try startEngine()
    }

    private func startEngine() throws {
        let e = AVAudioEngine()
        let input = e.inputNode
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "visioncli", code: 2, userInfo: [NSLocalizedDescriptionKey: "no microphone"])
        }
        // format: nil = the node's own format (an explicit one that disagrees aborts the app).
        input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buf, _ in self?.deliver(buf) }
        e.prepare()
        try e.start()
        engine = e
        log("meeting: microphone \(deviceName) (\(Int(format.sampleRate)) Hz)")
        // Bluetooth headsets switch to their call profile when the mic opens, which stops the engine: re-attach.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { [weak self] _ in
            guard let self, self.engine === e else { return }
            let input = e.inputNode
            let format = input.inputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { log("meeting: microphone changed, no input yet"); return }
            input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buf, _ in self?.deliver(buf) }
            e.prepare()
            do { try e.start(); log("meeting: microphone changed (\(Int(format.sampleRate)) Hz), resumed") }
            catch { log("meeting: microphone changed, couldn't resume: \(error.localizedDescription)") }
        }
    }

    /// Any capture's buffer → 16 kHz mono Int16 (first channel; float or 16-bit).
    private func deliver(_ buf: AVAudioPCMBuffer) {
        let n = Int(buf.frameLength), rate = buf.format.sampleRate
        let mono: [Float]
        if let ch = buf.floatChannelData {
            mono = Array(UnsafeBufferPointer(start: ch[0], count: n))
        } else if let ch = buf.int16ChannelData {
            let stride = buf.format.isInterleaved ? Int(buf.format.channelCount) : 1
            mono = (0..<n).map { Float(ch[0][$0 * stride]) / 32768 }
        } else { return }
        queue.async { self.onSamples?(MeetingAudio.to16k(mono, rate: rate)) }
    }

    func stop() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        picked?.stop()
        picked = nil
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
    }
}

/// Records one source to a raw 16 kHz Int16 file, kept in step with the clock: gaps (the speakers deliver nothing
/// while silent, the mic is paused while you hold ⌥) are written as silence, so both sources line up when mixed.
final class TrackRecorder {
    private let handle: FileHandle?
    private let start: Date
    private var written = 0
    let url: URL

    init(url: URL, start: Date) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        self.url = url
        self.start = start
        handle = try? FileHandle(forWritingTo: url)
    }

    /// Called on the source's queue, with samples that end now.
    func write(_ samples: [Int16], at now: Date = Date()) {
        guard let handle else { return }
        let due = Int(now.timeIntervalSince(start) * Double(SpeechSegmenter.rate)) - samples.count
        if due - written > SpeechSegmenter.rate / 10 { pad(due - written) }
        samples.withUnsafeBytes { try? handle.write(contentsOf: Data($0)) }
        written += samples.count
    }

    /// Silence up to `now` (the source went quiet or was paused).
    func catchUp(to now: Date) {
        let due = Int(now.timeIntervalSince(start) * Double(SpeechSegmenter.rate))
        if due > written { pad(due - written) }
    }

    private func pad(_ n: Int) {
        try? handle?.write(contentsOf: Data(count: n * 2))
        written += n
    }

    func close() { try? handle?.close() }
}
