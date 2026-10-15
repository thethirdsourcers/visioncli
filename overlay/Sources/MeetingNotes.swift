import AppKit
import AVFoundation

// Meeting Notes: a note-taker for work meetings. What the Mac plays is the guest (your colleagues), the microphone is
// you. Both are transcribed on this Mac and grouped into turns; each turn gets a one-line summary, and when a
// colleague asks you something, three short replies appear as soon as they've finished talking (and, for questions
// about the code, an answer looked up in the project). Everything goes into a Markdown file per meeting, with a
// summary at the end. The pure parts are in CoreMeeting.swift; the panel is MeetingPanel.swift.

struct MeetingRow: Identifiable, Equatable {
    enum Lookup: Equatable { case looking, found(String), failed }
    let id: Int
    let speaker: MeetingSpeaker
    let start: Date
    var text: String
    var open = true                  // the speaker may still go on
    var summary: String?
    var summarizing = false
    var question = false
    var replies: [String] = []
    var repliesLoading = false
    var lookup: Lookup?
}

final class MeetingNotes: ObservableObject {
    @Published private(set) var rows: [MeetingRow] = []
    @Published private(set) var isOn = false
    @Published private(set) var startedAt: Date?
    @Published private(set) var guestSpeaking = false
    @Published private(set) var youSpeaking = false
    @Published private(set) var overview: String?
    @Published private(set) var finishing = false
    @Published var project = ""
    @Published var engine = ""                       // the speech recognition in use, shown in the panel
    @Published private(set) var audio: URL? {       // the recording, once mixed (or of a past meeting)
        didSet { stopPlaying(); player = audio.flatMap { try? AVAudioPlayer(contentsOf: $0) }; player?.prepareToPlay() }
    }
    @Published private(set) var mixing = false
    @Published private(set) var playing = false
    @Published private(set) var playTime: Double = 0
    private(set) var folder: URL?
    var file: URL? { folder?.appendingPathComponent("notes.md") }
    private var guestTrack: TrackRecorder?
    private var youTrack: TrackRecorder?
    private var player: AVAudioPlayer?
    private var playTimer: Timer?

    // Set by the app.
    var claude = "claude"
    var path = ""
    /// Transcribes a 16 kHz WAV with the local engine; nil when none is ready.
    var transcribe: (URL, @escaping (String?) -> Void) -> Void = { _, done in done(nil) }
    /// The microphone is busy elsewhere (you're holding ⌥ to ask VisionCLI something).
    var micPaused: () -> Bool = { false }
    var onStopped: (String) -> Void = { _ in }

    private let system = SystemAudioCapture()
    private let mic = MicCapture()
    private var systemSeg = SpeechSegmenter()   // on the system capture's queue
    private var micSeg = SpeechSegmenter()      // on the mic's queue
    private var turns = TurnBuilder()
    private var closed: [MeetingTurn] = []
    private var jobs: [(speaker: MeetingSpeaker, pcm: [Int16], start: Date, end: Date)] = []
    private var transcribing = false
    private var guestSpans: [(start: Date, end: Date)] = []
    private var guestLines: [(at: Date, text: String)] = []
    private var micIsPaused = false
    // How much each source delivered (written on its queue, read for the log: approximate is fine).
    private var heardSamples: [MeetingSpeaker: Int] = [:]
    private var peak: [MeetingSpeaker: Double] = [:]
    private var lastLevelLog = Date()             // written on main, read on the mic's queue: a stale read costs a frame
    private var replyGen: [Int: Int] = [:]      // turn id → the request whose replies count
    private var lookups: [(turn: Int, proc: Process?)] = []   // running, oldest first
    static let parallelLookups = 3
    private var cap = HourlyCap(limit: 200)
    private var timer: Timer?
    private var count = 0
    private var replies: WarmPool?
    private var summaries: WarmPool?
    static let dir = supportDir.appendingPathComponent("meetings")
    private var work: URL { supportDir.appendingPathComponent("meeting-ai") }

    // MARK: Start and stop

    func start(_ done: @escaping (String?) -> Void) {
        guard !isOn else { done(nil); return }
        stopPlaying()
        let now = Date()
        let folder = Self.dir.appendingPathComponent(MeetingFile.folderName(now))
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        // The tracks exist before the audio starts flowing (the capture queues write to them).
        if Settings.meetingRecord {
            guestTrack = TrackRecorder(url: folder.appendingPathComponent("guest.pcm"), start: now)
            youTrack = TrackRecorder(url: folder.appendingPathComponent("you.pcm"), start: now)
        }
        system.onSamples = { [weak self] samples in self?.systemSamples(samples) }
        system.onStopped = { [weak self] error in
            log("meeting: speaker capture stopped: \(error.localizedDescription)")
            self?.stop()
            self?.onStopped("Meeting Notes stopped: \(error.localizedDescription)")
        }
        system.start { [weak self] error in
            guard let self else { return }
            if let error {
                log("meeting: couldn't capture system audio: \(error.localizedDescription)")
                self.discardTracks()
                done("Couldn't hear your Mac's audio. Allow VisionCLI under System Settings → Privacy & Security → Screen & System Audio Recording, then try again.")
                return
            }
            self.mic.onSamples = { [weak self] samples in self?.micSamples(samples) }
            do { try self.mic.start() } catch {
                // Still useful without it: the guest's side, summaries and replies.
                log("meeting: no microphone (\(error.localizedDescription)); guest only")
            }
            self.begin(at: now, folder: folder)
            done(nil)
        }
    }

    private func begin(at now: Date, folder: URL) {
        rows = []
        closed = []
        turns = TurnBuilder()
        jobs = []
        guestSpans = []
        guestLines = []
        overview = nil
        finishing = false
        replyGen = [:]
        audio = nil
        startedAt = now
        self.folder = folder
        isOn = true
        let (claude, path, work) = (self.claude, self.path, self.work)
        replies = WarmPool { WarmClaude(label: "replies", claude: claude, path: path, systemPrompt: MeetingAI.repliesPrompt, cwd: work) }
        summaries = WarmPool { WarmClaude(label: "summaries", claude: claude, path: path, systemPrompt: MeetingAI.summaryPrompt, cwd: work) }
        replies?.warm()
        summaries?.warm()
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.tick() }
        writeFile()
        log("meeting: on (project \(project))")
    }

    /// Stops listening, then writes the meeting summary at the top of the notes.
    func stop() {
        guard isOn else { return }
        isOn = false
        system.stop()
        mic.stop()
        timer?.invalidate()
        timer = nil
        guestSpeaking = false
        youSpeaking = false
        jobs = []
        if let t = turns.finish() { finalize(t) }
        replies?.stop()
        summaries?.stop()
        lookups.forEach { $0.proc?.terminate() }
        lookups = []
        log("meeting: off, \(closed.count) turns")
        summarizeMeeting()
        mixRecording()
    }

    // MARK: Audio → utterances

    private func systemSamples(_ samples: [Int16]) {
        guestTrack?.write(samples)
        DispatchQueue.main.async { self.count(.guest, samples) }
        let out = systemSeg.feed(samples)
        let now = Date(), speaking = systemSeg.inSpeech
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isOn else { return }
            if speaking != self.guestSpeaking { self.guestSpeaking = speaking }
            for u in out { self.utterance(.guest, u, end: now) }
        }
    }

    private func micSamples(_ samples: [Int16]) {
        // While you hold ⌥ you're talking to VisionCLI, not the meeting (the flag is refreshed on the main thread).
        if micIsPaused { micSeg.reset(); return }
        youTrack?.write(samples)
        DispatchQueue.main.async { self.count(.you, samples) }
        let out = micSeg.feed(samples)
        let now = Date(), speaking = micSeg.inSpeech
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isOn else { return }
            if speaking != self.youSpeaking { self.youSpeaking = speaking }
            for u in out { self.utterance(.you, u, end: now) }
        }
    }

    private func utterance(_ speaker: MeetingSpeaker, _ pcm: [Int16], end: Date) {
        let start = end.addingTimeInterval(-Double(pcm.count) / Double(SpeechSegmenter.rate))
        if speaker == .guest {
            guestSpans.append((start, end))
            guestSpans.removeAll { end.timeIntervalSince($0.end) > 60 }
        }
        jobs.append((speaker, pcm, start, end))
        transcribeNext()
    }

    /// One utterance at a time, in the order they were heard.
    private func transcribeNext() {
        guard !transcribing, isOn, !jobs.isEmpty else { return }
        let job = jobs.removeFirst()
        transcribing = true
        count += 1
        let wav = work.appendingPathComponent("u\(count % 8).wav")
        guard (try? MeetingAudio.wav(job.pcm).write(to: wav)) != nil else { transcribing = false; transcribeNext(); return }
        transcribe(wav) { [weak self] text in
            guard let self else { return }
            self.transcribing = false
            if self.isOn { self.heard(job.speaker, text ?? "", start: job.start, end: job.end) }
            self.transcribeNext()
        }
    }

    // MARK: Utterances → turns

    private func heard(_ speaker: MeetingSpeaker, _ raw: String, start: Date, end: Date) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !MeetingText.isJunk(text) else { return }
        if speaker == .you, EchoFilter.isEcho(text: text, start: start, end: end, guestSpans: guestSpans, guestLines: guestLines) {
            log("meeting: dropped mic echo: \(text.prefix(80))")
            return
        }
        if speaker == .guest {
            guestLines.append((end, text))
            guestLines.removeAll { end.timeIntervalSince($0.at) > 60 }
            // They went on before the replies to what they'd said arrived: it's still the same turn.
            if turns.open == nil, let last = closed.last, last.speaker == .guest,
               let i = rows.firstIndex(where: { $0.id == last.id }), rows[i].repliesLoading || rows[i].replies.isEmpty && rows[i].summarizing {
                closed.removeLast()
                replyGen[last.id] = (replyGen[last.id] ?? 0) + 1
                rows[i].open = true
                rows[i].repliesLoading = false
                rows[i].summarizing = false
                var reopened = last
                reopened.end = start // so this utterance joins it
                _ = turns.reopen(reopened)
            }
        }
        log("meeting: \(speaker.rawValue): \(text.prefix(120))")
        if let done = turns.add(speaker, text, start: start, end: end) { finalize(done) }
        if let t = turns.open { show(t) }
    }

    private func count(_ s: MeetingSpeaker, _ samples: [Int16]) {
        heardSamples[s, default: 0] += samples.count
        peak[s] = max(peak[s] ?? 0, Double(samples.map { abs(Int($0)) }.max() ?? 0) / 32768)
    }

    private func tick() {
        micIsPaused = micPaused()
        // Every 15 s: is audio arriving from each side, and how loud (a silent side is the first thing to check).
        if isOn, Date().timeIntervalSince(lastLevelLog) >= 15 {
            lastLevelLog = Date()
            func line(_ s: MeetingSpeaker) -> String {
                "\(s.rawValue) \(String(format: "%.1f", Double(heardSamples[s] ?? 0) / Double(SpeechSegmenter.rate)))s peak \(String(format: "%.3f", peak[s] ?? 0))"
            }
            log("meeting: audio in the last 15 s: \(line(.guest)), \(line(.you))")
            heardSamples = [:]
            peak = [:]
        }
        guard isOn, let open = turns.open else { return }
        let talking = open.speaker == .guest ? guestSpeaking : youSpeaking
        let pending = transcribing || jobs.contains { $0.speaker == open.speaker }
        if let t = turns.close(at: Date(), busy: talking || pending) { finalize(t) }
    }

    private func show(_ t: MeetingTurn) {
        if let i = rows.firstIndex(where: { $0.id == t.id }) { rows[i].text = t.text }
        else { rows.append(MeetingRow(id: t.id, speaker: t.speaker, start: t.start, text: t.text)) }
    }

    // MARK: Turns → summaries, replies, lookups

    private func finalize(_ t: MeetingTurn) {
        show(t)
        closed.append(t)
        guard let i = rows.firstIndex(where: { $0.id == t.id }) else { return }
        rows[i].open = false
        let context = Array(closed.dropLast().suffix(10))
        if t.speaker == .guest && Settings.meetingReplies && MeetingText.isQuestion(t.text) { askReplies(t, context: context) }
        // Your own turns only when asked for (they're always in the notes and the meeting summary). A colleague's
        // turn is still read when its summary is off: that's how requests the word check missed get replies, and
        // code questions get looked up.
        let guest = t.speaker == .guest
        if guest ? Settings.meetingSummarizeGuest || Settings.meetingReplies || Settings.meetingCodeLookup : Settings.meetingSummarizeYou {
            summarize(t, context: context)
        }
        writeFile()
    }

    private func askReplies(_ t: MeetingTurn, context: [MeetingTurn]) {
        guard let replies, cap.allows() else { return }
        cap.use()
        let gen = (replyGen[t.id] ?? 0) + 1
        replyGen[t.id] = gen
        update(t.id) { $0.repliesLoading = true; $0.question = true }
        let started = Date()
        replies.ask(MeetingAI.repliesMessage(context: context, turn: t)) { [weak self] result in
            guard let self, self.replyGen[t.id] == gen else { return }
            let list = result.flatMap(MeetingAI.parseReplies) ?? []
            log("meeting: replies in \(Int(Date().timeIntervalSince(started) * 1000))ms after the turn ended: \(list.count)")
            self.update(t.id) { $0.repliesLoading = false; $0.replies = list }
            self.writeFile()
        }
    }

    private func summarize(_ t: MeetingTurn, context: [MeetingTurn]) {
        guard let summaries, cap.allows() else { return }
        cap.use()
        let gen = replyGen[t.id] ?? 0
        if t.speaker == .guest ? Settings.meetingSummarizeGuest : Settings.meetingSummarizeYou { update(t.id) { $0.summarizing = true } }
        summaries.ask(MeetingAI.summaryMessage(context: context, turn: t)) { [weak self] result in
            guard let self, self.replyGen[t.id] ?? 0 == gen else { return }
            let s = result.flatMap(MeetingAI.parseSummary)
            let show = t.speaker == .guest ? Settings.meetingSummarizeGuest : Settings.meetingSummarizeYou
            self.update(t.id) { $0.summarizing = false; $0.summary = show ? s?.summary : nil }
            guard let s, t.speaker == .guest, s.question else { self.writeFile(); return }
            // A request the word check missed ("let me know the ETA…"): replies now.
            if Settings.meetingReplies, let row = self.rows.first(where: { $0.id == t.id }), !row.repliesLoading, row.replies.isEmpty {
                self.askReplies(t, context: context)
            }
            if s.lookup && Settings.meetingCodeLookup { self.lookUp(t, context: context) }
            self.writeFile()
        }
    }

    /// The answer from the code: read-only Claude in the project. Several run at once (one per question); past
    /// `parallelLookups`, the oldest gives way to the newest.
    private func lookUp(_ t: MeetingTurn, context: [MeetingTurn]) {
        guard !project.isEmpty, project != HomeProject.path, FileManager.default.fileExists(atPath: project) else { return }
        if lookups.count >= Self.parallelLookups {
            let old = lookups.removeFirst()
            old.proc?.terminate()
            update(old.turn) { if $0.lookup == .looking { $0.lookup = nil } }
        }
        update(t.id) { $0.lookup = .looking }
        let started = Date()
        let proc = MeetingOneShot.run(claude: claude, path: path, args: MeetingOneShot.lookupArgs(prompt: MeetingAI.lookupPrompt),
                                      cwd: project, prompt: MeetingAI.lookupMessage(context: context, turn: t), timeout: 45) { [weak self] text in
            guard let self, let i = self.lookups.firstIndex(where: { $0.turn == t.id }) else { return }
            self.lookups.remove(at: i)
            log("meeting: code lookup in \(Int(Date().timeIntervalSince(started) * 1000))ms: \(text == nil ? "nothing" : "found")")
            self.update(t.id) { $0.lookup = text.map { .found($0) } ?? .failed }
            self.writeFile()
        }
        lookups.append((t.id, proc))
    }

    private func update(_ id: Int, _ change: (inout MeetingRow) -> Void) {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return }
        change(&rows[i])
    }

    // MARK: The notes file

    private func writeFile() {
        guard let file, let started = startedAt else { return }
        var text = MeetingFile.header(started)
        for r in rows where !r.open {
            let turn = MeetingTurn(id: r.id, speaker: r.speaker, start: r.start, end: r.start, text: r.text)
            text += MeetingFile.entry(turn, summary: r.summary, replies: r.replies)
            if case .found(let answer) = r.lookup { text += "From the code:\n\(answer)\n\n" }
        }
        if let overview { text = MeetingFile.withSummary(text, overview) }
        try? text.write(to: file, atomically: true, encoding: .utf8)
        let record = MeetingRecord(started: started, project: project, rows: rows.filter { !$0.open }.map { r in
            var code: String?
            if case .found(let answer) = r.lookup { code = answer }
            return .init(speaker: r.speaker.rawValue, offset: r.start.timeIntervalSince(started), text: r.text, summary: r.summary,
                         replies: r.replies, code: code)
        }, overview: overview)
        if let folder, let data = try? Self.encoder.encode(record) { try? data.write(to: folder.appendingPathComponent("meeting.json")) }
    }

    static let listDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "d MMM, HH:mm"
        return f
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()

    private func summarizeMeeting() {
        writeFile()
        guard !closed.isEmpty else { return }
        finishing = true
        MeetingOneShot.run(claude: claude, path: path, args: MeetingOneShot.summaryArgs(), cwd: work.path,
                           prompt: MeetingAI.meetingMessage(closed), timeout: 120) { [weak self] text in
            guard let self else { return }
            self.finishing = false
            self.overview = text
            self.writeFile()
            log("meeting: summary \(text == nil ? "failed" : "written")")
        }
    }

    // MARK: Recording and playback

    private func discardTracks() {
        let folder = guestTrack?.url.deletingLastPathComponent()
        guestTrack?.close()
        youTrack?.close()
        guestTrack = nil
        youTrack = nil
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }

    /// Both tracks → one recording.m4a (AAC, small), off the main thread; the raw tracks are then removed.
    private func mixRecording() {
        guard let g = guestTrack, let y = youTrack, let folder else { return }
        guestTrack = nil
        youTrack = nil
        let end = Date()
        mixing = true
        // The capture queues may still hold a buffer: let them drain before closing.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) {
            g.catchUp(to: end); y.catchUp(to: end)
            g.close(); y.close()
            let saved = Self.mix(folder)
            DispatchQueue.main.async {
                self.mixing = false
                self.audio = saved
                log("meeting: recording saved")
            }
        }
    }

    /// guest.pcm + you.pcm in `folder` → recording.m4a (the WAV if AAC fails); the raw tracks are removed.
    @discardableResult
    static func mix(_ folder: URL) -> URL? {
        let g = folder.appendingPathComponent("guest.pcm"), y = folder.appendingPathComponent("you.pcm")
        func read(_ url: URL) -> [Int16] {
            guard let d = try? Data(contentsOf: url) else { return [] }
            return d.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        }
        let pcm = MeetingMix.mix(read(g), read(y))
        guard !pcm.isEmpty else { return nil }
        let wav = folder.appendingPathComponent("recording.wav")
        let m4a = folder.appendingPathComponent("recording.m4a")
        guard (try? MeetingAudio.wav(pcm).write(to: wav)) != nil else { return nil }
        let (code, _, err) = shell("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "48000", wav.path, m4a.path])
        let ok = code == 0 && FileManager.default.fileExists(atPath: m4a.path)
        if ok { try? FileManager.default.removeItem(at: wav) } else { log("meeting: afconvert failed \(err.prefix(200)); keeping the WAV") }
        try? FileManager.default.removeItem(at: g)
        try? FileManager.default.removeItem(at: y)
        return ok ? m4a : wav
    }

    /// A meeting cut short (VisionCLI quit or crashed) left its raw tracks: make its recording now.
    static func recoverRecordings() {
        DispatchQueue.global(qos: .utility).async {
            let folders = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            for f in folders where FileManager.default.fileExists(atPath: f.appendingPathComponent("guest.pcm").path) {
                if mix(f) != nil { log("meeting: recovered the recording in \(f.lastPathComponent)") }
            }
        }
    }

    /// Past meetings, newest first: the folders with a meeting.json.
    static func past(limit: Int = 15) -> [(folder: URL, record: MeetingRecord)] {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        let folders = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return folders.compactMap { f -> (URL, MeetingRecord)? in
            guard let data = try? Data(contentsOf: f.appendingPathComponent("meeting.json")),
                  let r = try? d.decode(MeetingRecord.self, from: data) else { return nil }
            return (f, r)
        }
        .sorted { $0.1.started > $1.1.started }
        .prefix(limit).map { $0 }
    }

    /// Shows a past meeting (not while one is running).
    func load(_ folder: URL, _ record: MeetingRecord) {
        guard !isOn else { return }
        stopPlaying()
        self.folder = folder
        startedAt = record.started
        project = record.project
        overview = record.overview
        finishing = false
        rows = record.rows.enumerated().map { i, r in
            MeetingRow(id: i + 1, speaker: MeetingSpeaker(rawValue: r.speaker) ?? .guest, start: record.started.addingTimeInterval(r.offset),
                       text: r.text, open: false, summary: r.summary, replies: r.replies, lookup: r.code.map { .found($0) })
        }
        audio = ["recording.m4a", "recording.wav"].map { folder.appendingPathComponent($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// The row being played (by its start in the recording).
    var playingRow: Int? {
        guard playing || playTime > 0, let started = startedAt else { return nil }
        let offsets = rows.map { $0.start.timeIntervalSince(started) }
        return MeetingRecord.current(offsets, at: playTime).map { rows[$0].id }
    }

    var duration: Double { player?.duration ?? 0 }

    func togglePlay() {
        if playing { player?.pause(); playing = false; return }
        guard let player else { return }
        player.play()
        playing = true
        playTimer?.invalidate()
        playTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, let p = self.player else { return }
            self.playTime = p.currentTime
            if !p.isPlaying && self.playing { self.playing = false }
        }
    }

    /// Plays from `time` seconds (a row's start, or the scrubber).
    func seek(_ time: Double) {
        player?.currentTime = max(0, min(time, duration))
        playTime = player?.currentTime ?? 0
        if !playing { togglePlay() }
    }

    func seek(toRow id: Int) {
        guard let started = startedAt, let r = rows.first(where: { $0.id == id }) else { return }
        seek(max(0, r.start.timeIntervalSince(started) - 0.3))
    }

    func stopPlaying() {
        player?.stop()
        player?.currentTime = 0
        playing = false
        playTime = 0
        playTimer?.invalidate()
        playTimer = nil
    }
}
