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

/// The microphone through its own engine, so the hold-⌥ Listener keeps working alongside it.
final class MicCapture {
    private var engine: AVAudioEngine?
    private let queue = DispatchQueue(label: "dev.visioncli.meeting.mic", qos: .userInitiated)
    var onSamples: (([Int16]) -> Void)?   // on `queue`

    func start() throws {
        let e = AVAudioEngine()
        let input = e.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "visioncli", code: 2, userInfo: [NSLocalizedDescriptionKey: "no microphone"])
        }
        let rate = format.sampleRate
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buf, _ in
            guard let self, let ch = buf.floatChannelData else { return }
            let mono = Array(UnsafeBufferPointer(start: ch[0], count: Int(buf.frameLength)))
            self.queue.async { self.onSamples?(MeetingAudio.to16k(mono, rate: rate)) }
        }
        e.prepare()
        try e.start()
        engine = e
    }

    func stop() {
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
