import AppKit

// Debug launch flags (`open VisionCLI.app --args --flag`): exercise one path of the app without the hotkey.

extension AppDelegate {
    /// Runs the debug flags given on the command line; each only schedules its work, so launch isn't delayed.
    func runDebugFlags() {
        // Debug: `open VisionCLI.app --args --say "text"` speaks text on launch (tests the voice output path).
        if let i = CommandLine.arguments.firstIndex(of: "--say"), i + 1 < CommandLine.arguments.count {
            let text = CommandLine.arguments[i + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.speaker.feed(text, final: true, force: true) }
        }

        // Debug: `--listen-test` opens the mic for 2s, three times in a row (checks the audio path without the hotkey).
        if CommandLine.arguments.contains("--listen-test") {
            func round(_ n: Int) {
                guard n > 0 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.listener.start { error in log("listen-test: \(error.localizedDescription)") }
                    log("listen-test: started")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        self.listener.stop(done: { text in
                            let size = (self.listener.recordingURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int }) ?? 0
                            log("listen-test: stopped, wav \(size) bytes, heard \"\(text)\"")
                            round(n - 1)
                        })
                    }
                }
            }
            round(3)
        }

        // Debug: `--bubble-test` shows the bubble for 30 s (checks what screen capture sees, e.g. Hide from Screen Sharing).
        if CommandLine.arguments.contains("--bubble-test") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.flash("VisionCLI bubble test", seconds: 30) }
        }

        // Debug: `--meeting-launcher` shows the ⇧⌥⌘R card.
        if CommandLine.arguments.contains("--meeting-launcher") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.showMeetingLauncher() }
        }

        // Debug: `--meeting-test [seconds]` starts Meeting Notes without the consent alert.
        if CommandLine.arguments.contains("--meeting-test") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self.meetingConsented = true
                self.toggleMeeting()
                // `--meeting-test 40`: stops it after 40 s (checks the summary and the recording).
                if let i = CommandLine.arguments.firstIndex(of: "--meeting-test"), i + 1 < CommandLine.arguments.count,
                   let seconds = Double(CommandLine.arguments[i + 1]) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { if self.meeting.isOn { self.toggleMeeting() } }
                }
            }
        }

        // Debug: `--probe-terminal` logs what the front terminal tab is running (project, claude session).
        if CommandLine.arguments.contains("--probe-terminal") {
            DispatchQueue.global().async {
                for project in [self.cfg.cwd] {
                    let started = Date()
                    let c = TerminalProbe.find(Settings.assistant, forProject: project)
                    log("find \(Settings.assistant.binary) for \(project): \(c.map { "tab=\($0.itermSession ?? "-") session=\($0.sessionId ?? "-") cwd=\($0.cwd)" } ?? "none") (\(Int(Date().timeIntervalSince(started) * 1000))ms)")
                }
                for app in ["iTerm2", "Terminal"] {
                    let c = TerminalProbe.probe(app: app)
                    log("probe \(app): \(c.map { "project=\($0.project) cwd=\($0.cwd) assistant=\($0.assistant?.binary ?? "-") session=\($0.sessionId ?? "-") tab=\($0.itermSession ?? "-")" } ?? "nothing")")
                }
            }
        }

        // Debug: `--test-download` fetches the small Kokoro voices file through the installer (progress, save, finish).
        if CommandLine.arguments.contains("--test-download") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self.installer.onFinished = { kind, error in log("test-download finished: \(kind.rawValue) error=\(error ?? "none")") }
                self.installer.debugDownload([ModelInstaller.kokoroFiles[1]])
                Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { t in
                    if let s = self.installer.status { log("test-download status: \(s)") } else { t.invalidate() }
                }
            }
        }

        // Debug: `--demo-answer` shows a sample answer with a mermaid diagram and screen drawings (rendering check).
        if CommandLine.arguments.contains("--demo-answer") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                if let w = Screen.windowUnderPointer(), let shot = try? Screen.capture(window: w) { self.currentShots = [shot] }
                else if let shot = try? Screen.capture(rect: CGRect(origin: .zero, size: NSScreen.screens[0].frame.size)) { self.currentShots = [shot] }
                log("demo: \(self.currentShots.first?.label ?? "no screenshot")")
                let W = Int(self.currentShots.first?.pixelSize.width ?? 1200), H = Int(self.currentShots.first?.pixelSize.height ?? 800)
                self.state.question = "How are orders and payments related?"
                self.state.project = "demo"
                self.state.raw = """
                Each order can have several payments; a payment always points back to one order through `order_id`.
                ```mermaid
                erDiagram
                  ORDERS ||--o{ PAYMENTS : "paid by"
                  ORDERS { int id  decimal total }
                  PAYMENTS { int id  int order_id  decimal amount }
                ```
                Start at the order [[step:1:\(W/6),\(H/5):1:Order]], follow it [[arrow:1:\(W/6),\(H/5 + 30),\(W/6),\(H*3/4 - 40):order_id]] to the payment [[circle:1:\(W/12),\(H*3/4 - 30),\(W/4 + 40),\(H*3/4 + 40):Payment]] [[step:1:\(W/4 + 70),\(H*3/4):2:Refunds too]] [[box:1:\(W*3/5),\(H/10),\(W*9/10),\(H/10 + 70):Totals]].
                """
                self.set(.thinking)
                self.finish(result: self.state.raw, error: nil)
                self.state.pinned = false
            }
        }

        // Debug: `--test-update` checks GitHub and installs a newer release without dialogs.
        if CommandLine.arguments.contains("--test-update") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self.updater.check(manual: true) { release in
                    log("test-update: running \(Updater.currentVersion), latest newer release: \(release?.version ?? "none")")
                    if release != nil { self.updater.install() }
                }
            }
        }

        // Debug: `--ask "question"` runs a question through the normal pipeline (no voice), to test assistants end to end.
        if let i = CommandLine.arguments.firstIndex(of: "--ask"), i + 1 < CommandLine.arguments.count {
            let question = CommandLine.arguments[i + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                log("debug ask (\(Settings.assistant.binary), \(Settings.terminalMode ? "terminal" : "bubble")): \(question)")
                self.state.question = question
                self.set(.thinking)
                if !Settings.terminalMode { self.session(for: self.currentProject).warm(); if self.routingOn { self.session(for: self.currentProject, lane: .fast).warm() } }
                self.questionReady(question)
            }
        }
    }
}
