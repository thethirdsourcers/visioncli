import AppKit

// The Settings window: what it shows (settingsSnapshot) and the app actions behind its controls, the same ones the
// menu and the setup wizard use.

extension AppDelegate {
    @objc func showSettings() {
        settingsWindow.show(hooks: SettingsWindow.Hooks(
            read: { [weak self] in self?.settingsSnapshot() ?? SettingsSnapshot() },
            setStartAtLogin: { [weak self] in self?.setStartAtLogin($0) },
            checkForUpdates: { [weak self] in self?.checkForUpdates() },
            installUpdate: { [weak self] in self?.installUpdate() },
            showSetupWizard: { [weak self] in self?.showSetupWizard() },
            setAssistant: { [weak self] in self?.setAssistant($0) },
            setTerminalMode: { Settings.terminalMode = $0 },
            setClaudeModel: { [weak self] in self?.setClaudeModel($0) },
            setAgyModel: { [weak self] in self?.setAgyModel($0) },
            setEffort: { [weak self] in self?.setEffort($0) },
            refreshAgyModels: { [weak self] in if let cfg = self?.cfg { AgyModels.refresh(cfg: cfg) } },
            setSpeak: { [weak self] in self?.setSpeak($0) },
            setSpeed: { [weak self] in self?.setSpeechSpeed($0) },
            selectVoice: { [weak self] in self?.selectVoice($0) },
            installKokoro: { [weak self] in self?.installer.installKokoro() },
            installWhisper: { [weak self] in self?.installer.installWhisper() },
            chooseSpeech: { [weak self] in self?.chooseSpeechEngine($0) },
            editVocabulary: { [weak self] in self?.editVocabulary() },
            setAudioDevice: { [weak self] input, uid in self?.setAudioDevice(input: input, uid: uid) },
            testSpeaker: { [weak self] in self?.testSpeaker() },
            setComputerControl: { [weak self] in self?.setComputerControl($0) },
            grantAccessibility: { [weak self] in self?.grantAccessibility() },
            accessibilityGranted: { [weak self] in self?.enableModifierKeys() },
            setWatchCrashes: { [weak self] in self?.setWatchCrashes($0) },
            setGhostCursor: { [weak self] in self?.setGhostCursor($0) },
            toggleMeeting: { [weak self] in self?.toggleMeeting() },
            openMeetings: { [weak self] in self?.openMeetingsFolder() },
            openMeeting: { [weak self] in self?.openPastMeeting($0) },
            showMeetingPanel: { [weak self] in self?.showMeetingPanel() },
            toolsConnected: { [weak self] in self?.toolsConnected($0) ?? false },
            connectTools: { [weak self] a, done in self?.connectTools(a, done: done) },
            openIntegrations: { [weak self] in self?.openIntegrations() },
            fixPermissions: { [weak self] in self?.fixPermissions() },
            openLog: { [weak self] in self?.openLog() },
            openCrashLog: { [weak self] in self?.openCrashLog() },
            openHome: { NSWorkspace.shared.open(URL(fileURLWithPath: HomeProject.path)) }
        ))
    }

    /// Every value the Settings window shows, read from Settings and the running engines. Cheap enough to call on
    /// the window's light polling (file checks and CoreAudio queries only; nothing runs a process).
    func settingsSnapshot() -> SettingsSnapshot {
        var s = SettingsSnapshot()
        typealias Item = SettingsSnapshot.Item
        // General
        s.startAtLogin = LoginItem.isEnabled
        s.autoUpdate = Settings.autoUpdate
        s.screenshotEvery = Settings.screenshotEveryQuestion
        s.hideFromCapture = Settings.hideFromCapture
        s.version = Updater.currentVersion
        s.updateAvailable = updater.available?.version
        s.updateStatus = updater.status
        // Assistant
        s.assistant = Settings.assistant
        for a in Assistant.allCases { s.installed[a] = isInstalled(a) }
        s.terminalMode = Settings.terminalMode
        s.autoActivity = Settings.autoActivity
        s.claudeModel = Settings.model
        s.fixedModel = cfg.model
        s.agyModel = Settings.agyModel
        s.agyModels = AgyModels.cached.map { Item(id: $0.id, name: $0.name) }
        s.effort = Settings.effort
        s.smartRouting = Settings.smartRouting
        // Voice (same rules as the old menu: without the Kokoro model only the macOS voice can be on)
        let kokoroAvailable = VoiceModels.kokoroModel != nil
        s.speak = Settings.speak
        s.speed = Settings.speechSpeed
        s.voice = kokoroAvailable && Settings.ttsEngine == "kokoro" ? Settings.kokoroVoice : nil
        s.kokoroVoices = kokoroAvailable ? VoiceModels.kokoroVoiceList.map { Item(id: $0.0, name: $0.1) } : []
        s.kokoroInstalled = ModelInstaller.kokoroInstalled
        s.installStatus = installer?.status
        s.speechEngine = currentSpeechEngine
        s.hasParakeet = ParakeetEngine.binary != nil
        s.parakeetReady = parakeet?.ready ?? false
        s.parakeetDownloaded = SetupModel.parakeetDownloaded
        s.flowInstalled = FlowDictation.isInstalled
        s.whisperModels = VoiceModels.whisperModels().map(\.0)
        s.whisperDownloadable = s.whisperModels.isEmpty || VoiceModels.binary("whisper-server", path: cfg.path) == nil
        s.inputs = AudioDevices.inputs.map { Item(id: $0.uid, name: $0.name) }
        s.outputs = AudioDevices.outputs.map { Item(id: $0.uid, name: $0.name) }
        s.inputUID = Settings.inputDeviceUID
        s.outputUID = Settings.outputDeviceUID
        s.defaultInput = AudioDevices.defaultDevice(input: true)?.name ?? "none"
        s.defaultOutput = AudioDevices.defaultDevice(input: false)?.name ?? "none"
        // Computer Control
        s.computerControl = Settings.computerControl
        s.accessibility = Computer.isTrusted
        s.watchCrashes = Settings.watchCrashes
        s.ghostCursor = ghostCursorOn
        s.quickCommands = Settings.quickCommands
        // Meeting Notes
        s.meetingNotes = meeting.isOn
        s.meetingSummarizeGuest = Settings.meetingSummarizeGuest
        s.meetingSummarizeYou = Settings.meetingSummarizeYou
        s.meetingReplies = Settings.meetingReplies
        s.meetingCodeLookup = Settings.meetingCodeLookup
        s.meetingRecord = Settings.meetingRecord
        s.pastMeetings = MeetingNotes.past(limit: 10).map { p in
            let first = p.record.rows.first { $0.speaker == MeetingSpeaker.guest.rawValue } ?? p.record.rows.first
            return Item(id: p.folder.path, name: "\(MeetingNotes.listDate.string(from: p.record.started)) · \((first?.summary ?? first?.text ?? "No conversation").prefix(50))")
        }
        // Advanced
        s.crashLogExists = ((try? FileManager.default.attributesOfItem(atPath: CrashReporter.logURL.path)[.size] as? Int) ?? 0) > 0
        return s
    }
}
