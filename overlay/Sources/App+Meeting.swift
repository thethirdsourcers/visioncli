import AppKit
import Speech

// Meeting Notes: the menu toggle, the speech engine it uses, and the panel (see MeetingNotes and MeetingPanel).

extension AppDelegate {
    /// ⇧⌥⌘R: the start card (its options and project), or Stop / Show Notes while a meeting runs.
    func showMeetingLauncher() {
        if meetingLauncher.isVisible { meetingLauncher.hide(); return }
        let l = meetingLauncher
        l.model.running = meeting.isOn
        l.model.startedAt = meeting.startedAt
        l.model.projects = meetingProjects()
        l.model.project = meeting.isOn ? meeting.project : Settings.pinnedProject ?? currentProject
        l.start = { [weak self] in
            guard let self else { return }
            // The card says what it does: no second alert.
            self.meetingConsented = true
            self.startMeeting(project: l.model.project)
        }
        l.stop = { [weak self] in if self?.meeting.isOn == true { self?.toggleMeeting() } }
        l.showNotes = { [weak self] in self?.meetingPanel.show() }
        l.chooseFolder = { done in
            let open = NSOpenPanel()
            open.canChooseDirectories = true
            open.canChooseFiles = false
            NSApp.activate(ignoringOtherApps: true)
            if open.runModal() == .OK, let url = open.url { done(url.path) }
        }
        l.show()
    }

    @objc func toggleMeeting() {
        if meeting.isOn {
            meeting.stop()
            stopMeetingEngines()
            ActivityBadge.shared.show("ear", "Meeting Notes stopped: writing the summary", seconds: 3)
            return
        }
        startMeeting(project: Settings.pinnedProject ?? currentProject)
    }

    private func startMeeting(project: String) {
        guard !meeting.isOn else { return }
        if !meetingConsented {
            let alert = NSAlert()
            alert.messageText = "Start Meeting Notes?"
            alert.informativeText = """
            VisionCLI listens to your Mac's sound (your colleagues on the call) and your microphone (you), and \
            transcribes both on this Mac. After each turn, Claude Haiku writes a one-line summary, and when a colleague \
            asks you something it suggests three short replies. Questions about the code are looked up (read-only) \
            in the project. Notes are saved in VisionCLI's meetings folder. Nothing is read aloud or sent for you.

            Where the law or your company's rules require it, tell the people in the meeting.
            """
            alert.addButton(withTitle: "Start")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            meetingConsented = true
        }
        guard let engine = startMeetingEngine() else {
            flash("Meeting Notes needs speech recognition: install Parakeet or Whisper, or allow Apple's (Settings → Voice)", seconds: 8)
            return
        }
        meeting.engine = engine
        log("meeting: transcribing with \(engine)")
        meeting.claude = cfg.claude
        meeting.path = cfg.path
        meeting.project = project
        meeting.transcribe = { [weak self] wav, done in self?.transcribeMeeting(wav, done) ?? done(nil) }
        meeting.micPaused = { [weak self] in self?.state.phase == .listening }
        meeting.onStopped = { [weak self] message in
            self?.stopMeetingEngines()
            self?.flash(message, seconds: 10)
        }
        meetingPanel.stop = { [weak self] in self?.toggleMeeting() }
        meetingPanel.projects = { [weak self] in self?.meetingProjects() ?? [] }
        meetingPanel.chooseFolder = { [weak self] in self?.chooseMeetingProject() }
        meeting.start { [weak self] error in
            guard let self else { return }
            if let error {
                self.stopMeetingEngines()
                self.flash(error, seconds: 12)
                return
            }
            self.meetingPanel.show()
            ActivityBadge.shared.show("ear", "Meeting Notes: listening", tint: .green, seconds: 3)
        }
    }

    func showMeetingPanel() { meetingPanel.show() }

    /// Shows a saved meeting (Settings → Meeting Notes → Past meetings).
    func openPastMeeting(_ path: String) {
        guard !meeting.isOn, let p = MeetingNotes.past(limit: 200).first(where: { $0.folder.path == path }) else { return }
        meeting.load(p.folder, p.record)
        meetingPanel.stop = { [weak self] in self?.toggleMeeting() }
        meetingPanel.projects = { [weak self] in self?.meetingProjects() ?? [] }
        meetingPanel.chooseFolder = { [weak self] in self?.chooseMeetingProject() }
        meetingPanel.show()
    }


    func openMeetingsFolder() {
        try? FileManager.default.createDirectory(at: MeetingNotes.dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(MeetingNotes.dir)
    }

    /// Projects to look code questions up in: the current one, then recent ones.
    private func meetingProjects() -> [String] {
        var seen: Set<String> = [HomeProject.path]
        return ([currentProject] + history.entries.prefix(50).map(\.project) + terminals.values.map(\.project))
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private func chooseMeetingProject() {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        NSApp.activate(ignoringOtherApps: true)
        if open.runModal() == .OK, let url = open.url { meeting.project = url.path }
    }

    /// The engine picked in Settings → Voice. Wispr Flow only dictates live (it can't take recorded audio), so it,
    /// like a missing engine, falls back to Parakeet, then Whisper, then Apple's recognizer. A running engine is
    /// shared with voice questions; otherwise one is started for the meeting. Returns its name, or nil.
    private func startMeetingEngine() -> String? {
        let order: [String]
        switch Settings.sttEngine {
        case "parakeet": order = ["parakeet", "whisper", "apple"]
        case "whisper": order = ["whisper", "parakeet", "apple"]
        case "apple": order = ["apple", "parakeet", "whisper"]
        default: order = ["parakeet", "whisper", "apple"]
        }
        for kind in order {
            switch kind {
            case "parakeet":
                if parakeet == nil {
                    guard ParakeetEngine.binary != nil else { continue }
                    meetingParakeet = ParakeetEngine()
                    meetingParakeet?.start()
                }
                meetingSTT = "parakeet"
                return "Parakeet"
            case "whisper":
                if whisper == nil {
                    guard let w = WhisperEngine(cfg: cfg, model: Settings.whisperModel) else { continue }
                    meetingWhisper = w
                    w.start()
                }
                meetingSTT = "whisper"
                return "Whisper \((whisper ?? meetingWhisper)?.modelName ?? "")"
            default:
                guard SFSpeechRecognizer.authorizationStatus() == .authorized else { continue }
                meetingSTT = "apple"
                return "Apple speech recognition"
            }
        }
        return nil
    }

    private func stopMeetingEngines() {
        meetingParakeet?.stop()
        meetingParakeet = nil
        meetingWhisper?.stop()
        meetingWhisper = nil
    }

    /// A cold Parakeet or Whisper can take a minute to load: what's heard meanwhile waits rather than being dropped.
    private func transcribeMeeting(_ wav: URL, waited: Int = 0, _ done: @escaping (String?) -> Void) {
        switch meetingSTT {
        case "apple":
            AppleFileSpeech.transcribe(wav, locale: cfg.locale, done)
            return
        case "parakeet":
            if let p = parakeet ?? meetingParakeet, p.ready { p.transcribe(wav, vocabulary: [], timeout: 15, done); return }
        default:
            if let w = whisper ?? meetingWhisper, w.ready { w.transcribe(wav, prompt: "", timeout: 15, done); return }
        }
        guard waited < 90, meeting.isOn else { log("meeting: no speech engine ready"); done(nil); return }
        if waited == 0 { log("meeting: waiting for \(meetingSTT) to load") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.transcribeMeeting(wav, waited: waited + 1, done) ?? done(nil)
        }
    }
}

/// Apple's recognizer on a recorded file, on this Mac when the language supports it.
enum AppleFileSpeech {
    private static var recognizers: [String: SFSpeechRecognizer] = [:] // kept alive while their tasks run

    static func transcribe(_ wav: URL, locale: String?, _ done: @escaping (String?) -> Void) {
        let key = locale ?? ""
        let r = recognizers[key] ?? (locale.map { SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer())
        guard let r, r.isAvailable else { done(nil); return }
        recognizers[key] = r
        let req = SFSpeechURLRecognitionRequest(url: wav)
        req.shouldReportPartialResults = false
        if r.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        var finished = false
        r.recognitionTask(with: req) { result, error in
            guard !finished else { return }
            if let result, result.isFinal { finished = true; done(result.bestTranscription.formattedString) }
            else if error != nil { finished = true; done(nil) }
        }
    }
}
