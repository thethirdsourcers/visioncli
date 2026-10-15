import AppKit

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
        guard startMeetingEngine() else {
            flash("Meeting Notes needs Parakeet or Whisper: Settings → Voice", seconds: 8)
            return
        }
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

    /// The voice engine already running for questions, else one started just for the meeting (Parakeet first).
    private func startMeetingEngine() -> Bool {
        if parakeet != nil || whisper != nil { return true }
        if ParakeetEngine.binary != nil {
            meetingParakeet = ParakeetEngine()
            meetingParakeet?.start()
            return true
        }
        meetingWhisper = WhisperEngine(cfg: cfg, model: Settings.whisperModel)
        meetingWhisper?.start()
        return meetingWhisper != nil
    }

    private func stopMeetingEngines() {
        meetingParakeet?.stop()
        meetingParakeet = nil
        meetingWhisper?.stop()
        meetingWhisper = nil
    }

    /// A cold Parakeet can take a minute to load: what's heard meanwhile waits for it rather than being dropped.
    private func transcribeMeeting(_ wav: URL, waited: Int = 0, _ done: @escaping (String?) -> Void) {
        if let p = parakeet ?? meetingParakeet, p.ready { p.transcribe(wav, vocabulary: [], timeout: 15, done); return }
        if let w = whisper ?? meetingWhisper, w.ready { w.transcribe(wav, prompt: "", timeout: 15, done); return }
        guard waited < 90, meeting.isOn else { log("meeting: no speech engine ready"); done(nil); return }
        if waited == 0 { log("meeting: waiting for the speech engine to load") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.transcribeMeeting(wav, waited: waited + 1, done) ?? done(nil)
        }
    }
}
