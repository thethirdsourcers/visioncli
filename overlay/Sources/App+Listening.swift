import AppKit
import AVFoundation
import Carbon.HIToolbox
import Speech

// Hold-to-talk: the hotkeys, opening the mic and deciding the project at key-down, and the transcript at key-up.

extension AppDelegate {
    func hotkey(_ key: HotKey, pressed: Bool) {
        if key == .talk || key == .point || key == .screen || pressed { log("hotkey \(key) \(pressed ? "down" : "up") in \(state.phase)") }
        switch (key, pressed) {
        case (.talk, true), (.point, true), (.screen, true):
            // Second tap while listening (tap mode) sends the question.
            if state.phase == .listening { finishListening(); return }
            if state.phase == .approval { return }
            startListening(point: key == .point, screen: key == .screen)
        case (.talk, false), (.point, false), (.screen, false):
            keysReleased()
        case (.meeting, true): modifierHold.cancel(); showMeetingLauncher()
        case (.dismiss, true): dismiss()
        case (.pin, true): modifierHold.cancel(); togglePin()
        case (.open, true): modifierHold.cancel(); openFirstReference()
        case (.allow, true): modifierHold.cancel(); approve(true, always: false)
        case (.fixError, true): modifierHold.cancel(); fixOfferedError()
        default: break
        }
    }

    func startListening(point: Bool, screen: Bool = false) {
        speaker.reset()
        highlight.hide()
        state.pinned = false
        state.question = ""
        state.raw = ""
        state.status = ""
        state.toast = ""
        state.level = 0
        state.regionSelected = false
        state.annotated = []
        startShot = nil
        region = nil
        withScreen = point || screen || Settings.screenshotEveryQuestion
        let external = Settings.sttEngine == "external" // Wispr Flow listens instead of our mic (see FlowDictation)
        // One look at the window list for this press: it decides the project, the spotlight and the screenshot.
        let windows = timed("Screen.windows") { Screen.windows() }
        let window = Screen.windowUnderPointer(in: windows)
        // The bubble and mascot show at once; the microphone opens on the listener's audio queue meanwhile.
        timed("set(.listening)") { set(.listening) }
        pressedAt = Date()
        let started = pressedAt
        listener.start { [weak self] error in
            guard let self else { return }
            if external {
                // Flow only hands over its text when you let go, so Apple's on-device recognizer runs alongside it for
                // the live text near the pointer (and as a fallback if Flow returns nothing).
                log("listener (live preview for Flow) failed: \(error)")
                return
            }
            // Still this press (listening, or already let go and waiting for the transcript).
            guard self.pressedAt == started, self.state.phase == .listening || self.state.phase == .thinking else { return }
            log("listener failed: \(error)")
            self.keyPoll?.invalidate()
            self.keyPoll = nil
            if self.selector.isActive { self.selector.cancel() }
            self.state.question = "Voice"
            // Only blame permissions when macOS actually denied them.
            let micDenied = AVCaptureDevice.authorizationStatus(for: .audio) != .authorized
            let speechDenied = SFSpeechRecognizer.authorizationStatus() != .authorized
            if micDenied || speechDenied {
                self.flash("VisionCLI needs \([micDenied ? "Microphone" : nil, speechDenied ? "Speech Recognition" : nil].compactMap { $0 }.joined(separator: " and ")) access: System Settings → Privacy & Security.", seconds: 10)
            } else {
                self.flash("Couldn't start the microphone (\(error.localizedDescription)). Try again, or pick another mic in VisionCLI menu → Microphone.", seconds: 10)
            }
        }
        timed("warmQuick") { warmQuick() }
        // Screenshot questions: dim everything but the window that will be captured (point mode has its own dimming).
        if withScreen && !point { spotlight.show(window: window) }

        // Work out the project now and warm up its Claude session while the user is still talking.
        terminalContext = nil
        existingClaude = nil
        if Settings.pinnedProject == nil, let raw = Screen.rawWindowUnderPointer(in: windows), raw.isTerminal {
            // Pointing at a terminal: use that tab's folder, and its claude session if one is running there.
            let app = raw.app
            DispatchQueue.global().async {
                let ctx = TerminalProbe.probe(app: app)
                DispatchQueue.main.async {
                    guard let ctx, self.pressedAt == started, self.state.phase == .listening || self.state.phase == .thinking else { return }
                    self.terminalContext = ctx
                    self.currentProject = ctx.project
                    self.lastRealProject = (ctx.project, Date())
                    self.state.project = HomeProject.label(ctx.project)
                    log("terminal context: \(ctx.project)\(ctx.assistant.map { " (\($0.binary) running, session \(ctx.sessionId ?? "?"))" } ?? "")")
                }
            }
        }
        scopeWindow = window
        let pinned = Settings.pinnedProject
        let windowProject = pinned == nil ? timed("project(for:)", { projects.project(for: window) }) : nil
        let decision = ProjectSelector.decide(pinned: pinned, windowProject: windowProject, lastReal: lastRealProject,
                                              now: Date(), home: HomeProject.path)
        currentProject = decision.project
        if decision.fromWindow { lastRealProject = (decision.project, Date()) }
        scopeProject = decision.askScope ? decision.project : nil // about that project, or general? Jev decides
        if Settings.terminalMode {
            let project = currentProject
            DispatchQueue.global().async {
                // Also remembered by TerminalProbe, so sending the question moments later doesn't scan again.
                let found = TerminalProbe.find(Settings.assistant, forProject: project)
                DispatchQueue.main.async { if self.pressedAt == started { self.existingClaude = found.map { (project, $0) } } }
            }
        }
        state.project = HomeProject.label(currentProject)
        if !Settings.terminalMode {
            session(for: currentProject).warm()
            if routingOn { session(for: currentProject, lane: .fast).warm() }
            if scopeProject != nil { session(for: HomeProject.path, lane: routingOn ? .fast : .strong).warm() }
        }
        if let window, withScreen {
            DispatchQueue.global().async {
                let shot = try? Screen.capture(window: window)
                DispatchQueue.main.async { if self.state.phase == .listening { self.startShot = shot } }
            }
        }

        if external {
            state.status = ""
            timed("flow.begin") { flow.begin() }
        }

        if point {
            state.status = "Drag around what you mean, or tap \(HotKey.point.shortcut.label) for the whole window…"
            selector.begin { [weak self] rect in
                guard let self, let rect else { return }
                self.region = rect
                self.state.regionSelected = true
                self.state.status = ""
                self.highlight.show([(Geometry.toAppKit(rect), "")], persistent: true)
                // Keys already released while dragging (hold mode): send now.
                let held = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(HotKey.point.shortcut.code))
                if !held && Date().timeIntervalSince(self.pressedAt) >= 0.35 && self.state.phase == .listening { self.finishListening() }
            }
        }

        // Carbon doesn't always deliver the key-up (e.g. when Option is let go first), so also watch the keys directly.
        keyPoll?.invalidate()
        keyPoll = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in
            let pointKey = HotKey.point.shortcut
            let space = CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(pointKey.code))
            // ⌥⇧Space holds Space and Option; ⌥ / ⌥⌘ are held on their own (⌃Space without Accessibility).
            let held = point ? space && NSEvent.modifierFlags.contains(pointKey.flags.subtracting(.shift)) : ModifierHold.keyDown
            if !held { self?.keysReleased() }
        }
        RunLoop.main.add(keyPoll!, forMode: .common)
        DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
            guard let self, self.state.phase == .listening, self.pressedAt == started else { return }
            self.finishListening()
        }
    }

    func keysReleased() {
        keyPoll?.invalidate()
        keyPoll = nil
        guard state.phase == .listening else { return }
        // Wispr Flow: letting go always ends the question (Flow has no tap mode here).
        if Settings.sttEngine == "external" {
            if selector.isActive && region == nil { return }
            finishListening()
            return
        }
        // In point mode, keep listening while the user is still dragging.
        if selector.isActive && region == nil { return }
        if Date().timeIntervalSince(pressedAt) < 0.35 {
            // Quick tap: keep listening until the next tap.
            if state.question.isEmpty { state.status = "Listening… tap ⌥ to send" }
            return
        }
        finishListening()
    }

    func finishListening() {
        keyPoll?.invalidate()
        keyPoll = nil
        guard state.phase == .listening else { return }
        if Settings.sttEngine == "external" {
            if selector.isActive { selector.cancel() }
            set(.thinking)
            state.status = "Transcribing…"
            var preview = state.question.trimmingCharacters(in: .whitespacesAndNewlines)
            listener.stop(done: { final in if !final.isEmpty { preview = final } })
            flow.end { [weak self] text in
                guard let self, self.state.phase == .thinking else { return }
                if !text.isEmpty { log("transcript: apple=\"\(preview)\" flow=\"\(text)\"") }
                let best = text.isEmpty ? preview : text
                if best.isEmpty {
                    self.flash("Wispr Flow didn't type anything. Make sure Flow is running and its push-to-talk key is fn.", seconds: 8)
                    return
                }
                if text.isEmpty { log("flow: no text, using the live preview \"\(preview)\"") }
                self.state.question = best
                self.questionReady(best)
            }
            return
        }
        if selector.isActive { selector.cancel() }
        state.status = "Thinking…"
        set(.thinking)
        let heard = state.question
        let press = pressedAt
        // Local Parakeet/Whisper (better with names and jargon) starts on the WAV as soon as the mic is closed, while
        // Apple's recognizer finishes in parallel; Apple's text is only the fallback when the local engine has nothing.
        let useLocal = (parakeet?.ready ?? false) || (whisper?.ready ?? false)
        var localPending = useLocal       // a local transcription may still come
        var local: (engine: String, text: String?)?
        var apple: String?                // Apple's final, once it's in
        var settled = false
        func decide() {
            guard !settled, state.phase == .thinking, pressedAt == press, !localPending else { return }
            if let local, let text = local.text, !text.isEmpty {
                settled = true
                listener.finishNow() // Apple's late final mustn't replace the question in the bubble
                log("transcript: apple=\"\(apple ?? heard.trimmingCharacters(in: .whitespacesAndNewlines))\" \(local.engine)=\"\(text)\"")
                questionReady(text)
                return
            }
            guard let apple else { return } // the local engine had nothing: wait for Apple's final
            settled = true
            if let local { log("transcript: apple=\"\(apple)\" \(local.engine)=\"\(local.text ?? "nil")\"") } else { log("transcript: \(apple)") }
            questionReady(apple)
        }
        listener.stop(onRecording: { [weak self] wav in
            guard let self, useLocal else { return }
            guard let wav, self.state.phase == .thinking, self.pressedAt == press else { localPending = false; decide(); return }
            if let parakeet = self.parakeet, parakeet.ready {
                self.state.status = "Transcribing…"
                parakeet.transcribe(wav, vocabulary: self.vocabularyWords()) { text in
                    local = ("parakeet", text)
                    localPending = false
                    decide()
                }
            } else if let whisper = self.whisper, whisper.ready {
                self.state.status = "Transcribing…"
                whisper.transcribe(wav, prompt: self.vocabularyPrompt()) { text in
                    local = ("whisper", text)
                    localPending = false
                    decide()
                }
            } else {
                localPending = false
                decide()
            }
        }, done: { final in
            apple = final.isEmpty ? heard.trimmingCharacters(in: .whitespacesAndNewlines) : final
            decide()
        })
    }
}
