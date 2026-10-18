import AppKit

// From a transcript to an answer: quick commands (Jev), smart routing, screenshots, sending, and the finished answer.

extension AppDelegate {
    func questionReady(_ text: String) {
        guard !text.isEmpty else {
            highlight.hide()
            state.question = ""
            // Explain *why* nothing was transcribed when we know (permission, Dictation off, …).
            if let issue = listener.lastIssue {
                flash(issue + (whisper == nil ? " Or install Whisper in VisionCLI menu → Settings… → Voice → Speech recognition." : ""), seconds: 12)
            } else {
                flash("Didn't catch that. Hold ⌥ while you speak.")
            }
            return
        }
        state.question = text
        state.status = withScreen ? "Looking at your screen…" : "Thinking…"
        let browserInFront = QuickCommandFilter.browserBundles.contains(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
        guard Settings.quickCommands, QuickCommandFilter.matches(text, browserInFront: browserInFront) else { routeThenAsk(text); return }
        // Jev first (fast path for simple browser commands); Claude if it isn't a confident quick action.
        let started = Date()
        // Up to 8 s: a slow first Jev answer is retried inside `quick` rather than handed to the assistant.
        runQuick(text, timeout: 8) { [weak self] result in
            guard let self, self.state.phase == .thinking, self.state.question == text else { return }
            if result?["task"] as? Bool == true { self.runBrowserTask(text); return } // several steps: the Jev agent
            let handled = result?["handled"] as? Bool ?? false
            log("quick: \(handled ? "handled" : "→ claude") intent=\(result?["intent"] ?? "-") conf=\(result?["confidence"] ?? "-") \(result?["reason"] ?? "") \(Int(Date().timeIntervalSince(started) * 1000))ms")
            guard handled, let message = result?["message"] as? String else { self.captureAndAsk(text); return }
            self.activity.question(text, project: self.currentProject, shots: [])
            self.activity.note("\(message) (Jev, \(Int(Date().timeIntervalSince(started) * 1000))ms)")
            self.state.raw = message
            self.set(.done)
            self.speaker.feed(message, final: true)
            self.history.add(HistoryEntry(date: Date(), project: self.currentProject, question: text, answer: message, screenshots: []))
            self.scheduleHide(after: 4)
        }
    }

    var routingOn: Bool { Settings.smartRouting && !Settings.terminalMode && Settings.assistant != .gemini }

    /// Bubble mode: ask Jev (~0.5 s) whether a small fast model can answer, then ask. Terminal mode is unchanged:
    /// questions go to the assistant the user already has open.
    func routeThenAsk(_ text: String) {
        // Away from any project window shortly after using one: is this about that project, or general (Home)?
        let scope = Settings.pinnedProject == nil && terminalContext == nil ? scopeProject : nil
        guard routingOn || scope != nil else { captureAndAsk(text); return }
        var input: [String: Any] = ["question": text]
        if let previous = lastLane[currentProject], Date().timeIntervalSince(previous.at) < 300 {
            input["previous"] = previous.question
            input["previousLane"] = previous.lane.rawValue
        }
        if let scope {
            input["project"] = HomeProject.label(scope)
            if let w = scopeWindow { input["app"] = w.app; input["window"] = w.title }
        }
        guard let json = (try? JSONSerialization.data(withJSONObject: input)).flatMap({ String(data: $0, encoding: .utf8) }) else {
            captureAndAsk(text); return
        }
        let started = Date()
        runQuick(text, timeout: 2.5, args: ["route", json]) { [weak self] result in
            guard let self, self.state.phase == .thinking, self.state.question == text else { return }
            let lane = Lane(rawValue: result?["lane"] as? String ?? "") ?? .strong
            let general = scope != nil && result?["scope"] as? String == "general"
            log("route: \(lane.rawValue)\(scope == nil ? "" : general ? ", general (Home)" : ", project") conf=\(result?["confidence"] ?? "-")\(result?["reason"].map { " (\($0))" } ?? "") \(Int(Date().timeIntervalSince(started) * 1000))ms")
            if general {
                self.currentProject = HomeProject.path
                self.state.project = "Home"
            }
            self.nextLane = lane
            self.captureAndAsk(text)
        }
    }

    /// `visioncli quick <text>` with a hard timeout (killed if slow, so it can't act after Claude took over).
    func runQuick(_ text: String, timeout: Double, args: [String]? = nil, _ done: @escaping ([String: Any]?) -> Void) {
        guard let node = cfg.node, let server = cfg.server else { done(nil); return }
        quickProc?.terminate()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [server] + (args ?? ["quick", text])
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = cfg.path
        env["VISIONCLI_FRONT_APP"] = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        var finished = false
        p.terminationHandler = { proc in
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            DispatchQueue.main.async {
                guard !finished else { return }
                finished = true
                done(proc.terminationReason == .exit ? json : nil)
            }
        }
        do { try p.run() } catch { done(nil); return }
        quickProc = p
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            guard !finished else { return }
            finished = true
            p.terminate()
            log("quick: timed out after \(timeout)s")
            done(nil)
        }
    }

    /// Wake the Jev service while the user is still talking.
    func warmQuick() {
        guard Settings.quickCommands, Date().timeIntervalSince(lastWarm) > 120 else { return }
        lastWarm = Date()
        DispatchQueue.global().async { [cfg] in
            let (_, out, _) = cfg.visioncli(["warm"])
            log("quick: \(out.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    func captureAndAsk(_ text: String) {
        let region = self.region, startShot = self.startShot
        // Text only: no image tokens. The window's name goes along so the assistant can decide to `look` itself.
        guard withScreen else {
            highlight.hide()
            ask(text, shots: [], window: Screen.windowUnderPointer())
            return
        }
        DispatchQueue.global().async {
            var shots: [Shot] = []
            var failure: Error?
            do {
                if let region {
                    shots = [try Screen.capture(rect: region)]
                } else if let endWindow = Screen.windowUnderPointer() {
                    let end = try Screen.capture(window: endWindow)
                    // Pointer moved to another window while talking: send both ("compare this with that").
                    if let s = startShot, s.window?.id != end.window?.id { shots = [s, end] } else { shots = [end] }
                } else if let s = startShot {
                    shots = [s]
                }
            } catch {
                failure = error
            }
            DispatchQueue.main.async {
                self.highlight.hide()
                if let failure, shots.isEmpty {
                    log("capture failed: \(failure)")
                    if case CaptureError.permission = failure { CGRequestScreenCaptureAccess() }
                    self.flash(failure.localizedDescription, seconds: 15)
                    return
                }
                self.ask(text, shots: shots)
            }
        }
    }

    func ask(_ question: String, shots: [Shot], window: WinInfo? = nil) {
        taskHUD.reset(title: question.count > 40 ? String(question.prefix(40)) + "…" : question)
        var question = question
        if let crash = crashWatcher.recent {
            let mins = max(1, Int(Date().timeIntervalSince(crash.date) / 60))
            question += "\n(If relevant: \(crash.app) crashed \(mins) min ago; crash report at \(crash.file.path).)"
        }
        // A terminal the user pointed at wins; otherwise the window the pointer ended on decides the project.
        let pinned = Settings.pinnedProject
        let windowProject = pinned == nil && terminalContext == nil ? projects.project(for: shots.last?.window ?? window) : nil
        let decision = ProjectSelector.confirm(current: currentProject, pinned: pinned, terminalProject: terminalContext?.project,
                                               windowProject: windowProject)
        currentProject = decision.project
        if decision.fromWindow { lastRealProject = (decision.project, Date()) }
        state.project = HomeProject.label(currentProject)
        let saved = history.save(shots)
        currentShots = saved
        writeShotMap(saved)
        history.waitForWrites() // screenshots are written in the background; the assistant reads them next
        controlStopped = nil // a new question re-enables computer control after an Esc stop
        currentWindow = saved.last?.window ?? window ?? currentWindow
        let noShot = "No screenshot attached (to save tokens it's only sent when asked for)" + (window.map { "; the mouse is over \($0.label)" } ?? "")
            + ". If answering needs the screen, call mcp__visioncli__look (or ui_elements / browser_read, cheaper as text)."

        var context = ["Project: \(currentProject)."]
        for (i, shot) in saved.enumerated() {
            var line = "Image \(i + 1): \(shot.label), \(Int(shot.pixelSize.width))x\(Int(shot.pixelSize.height)) px"
            if let p = shot.pointer { line += ", mouse pointer at (\(Int(p.x)), \(Int(p.y)))" } else { line += ", pointer not over it" }
            if let f = shot.file { line += ", saved at \(f.path)" }
            context.append(line + ".")
        }
        if saved.isEmpty { context.append(noShot) }
        let text = "\(question)\n\n[Voice question. \(context.joined(separator: " "))]"

        activity.question(question, project: currentProject, shots: saved)

        if Settings.terminalMode {
            // The CLI running in the tab the user pointed at wins; otherwise the chosen assistant.
            let assistant = terminalContext?.assistant ?? Settings.assistant
            // "slash model haiku" / "/compact": a CLI command, typed as-is so the CLI runs it.
            if let cmd = SlashCommand.parse(question) {
                let t = terminal(for: currentProject, assistant: assistant)
                if let ctx = terminalContext, ctx.assistant == assistant, let tab = ctx.itermSession {
                    t.claudeCwd = ctx.cwd
                    t.attach(itermSession: tab, sessionId: ctx.sessionId)
                }
                let asked = state.question
                t.command(cmd) { [weak self] sent in
                    // Esc or a new question while it was being sent: leave the bubble alone.
                    guard let self, self.state.phase == .thinking, self.state.question == asked else { return }
                    if sent {
                        self.state.raw = "Sent \(cmd) to \(assistant.name)."
                        self.set(.done)
                        self.scheduleHide(after: 3)
                    } else {
                        self.finish(result: nil, error: "No \(assistant.name) is running in a terminal for this project, so \(cmd) wasn't sent.")
                    }
                }
                return
            }
            let gemini = assistant == .gemini
            let briefInstructions = assistant != .claude // no system prompt in gemini/agy interactive mode
            let paths = gemini ? geminiAttachable(saved) : saved.compactMap { $0.file?.path }
            // A short tag the user sees in their terminal: the CLI already runs in the project, and VisionCLI's MCP
            // instructions tell it when to `look`, so only what it can't know goes here.
            var parts: [String] = []
            for (i, shot) in saved.enumerated() {
                var p = "screenshot \(i < paths.count ? (gemini ? "@\(paths[i]) " : paths[i]) : shot.label)"
                if let pt = shot.pointer { p += " (mouse at \(Int(pt.x)),\(Int(pt.y)))" }
                parts.append(p)
            }
            // Only when the mouse really is over another app: over the terminal itself there's nothing to point at
            // (the fallback to the front-most other window is for screenshots, not for this hint).
            if saved.isEmpty, let under = Screen.rawWindowUnderPointer(), !under.isTerminal { parts.append("mouse over \(under.label)") }
            // Gemini can't take a system prompt in its interactive mode, so the voice instructions ride along, with the
            // first question of each conversation only (later ones keep just the [voice · …] tag).
            let instructions = "Asked out loud: the reply is also shown in a bubble on screen and read aloud, so answer in plain text, under about 100 words; \"this\" means what's under the pointer; cite files as path:line; for flows or relationships you may add one small ```mermaid diagram; put any [[box/arrow/circle/step]] drawing markers on the last line."
            let t = terminal(for: currentProject, assistant: assistant)
            // Prefer one the user already runs: the tab they pointed at, else any tab for this project.
            if let ctx = terminalContext, ctx.assistant == assistant, let tab = ctx.itermSession {
                t.claudeCwd = ctx.cwd
                t.attach(itermSession: tab, sessionId: ctx.sessionId)
            } else if let found = existingClaude, found.project == currentProject, found.context.assistant == assistant,
                      let tab = found.context.itermSession {
                t.claudeCwd = found.context.cwd
                t.attach(itermSession: tab, sessionId: found.context.sessionId)
            }
            currentTerminal = t
            current = nil
            state.raw = ""
            state.status = "Sending to \(assistant.name) in the terminal…"
            if state.phase != .thinking { set(.thinking) }
            let key = "\(assistant.rawValue)|\(currentProject)|\(t.sessionId)"
            if briefInstructions && !instructed.contains(key) {
                if assistant == .antigravity && !saved.isEmpty { parts.append("View the screenshot file(s) first.") }
                parts.append(instructions)
                instructed.insert(key)
            }
            t.ask("\(question) [voice\(parts.isEmpty ? "" : " · ")\(parts.joined(separator: " · "))]")
            return
        }
        currentTerminal = nil

        if Settings.autoActivity && !activityShown {
            activityShown = true
            TerminalLauncher.showActivity()
        }

        let lane = routingOn ? nextLane : .strong
        nextLane = .strong
        let s = session(for: currentProject, lane: lane)
        // Switching lanes changes conversations: carry the last couple of exchanges over so follow-ups make sense.
        var sendText = text
        if routingOn, let last = lastLane[currentProject], last.lane != lane, Date().timeIntervalSince(last.at) < 1800 {
            let recent = history.entries.filter { $0.project == currentProject }.prefix(2).reversed()
            if !recent.isEmpty {
                sendText = "Earlier in this conversation (for context):\n"
                    + recent.map { "User: \($0.question.prefix(300))\nAssistant: \($0.answer.prefix(500))" }.joined(separator: "\n")
                    + "\n\n" + text
            }
        }
        lastLane[currentProject] = (lane, Date(), question)
        if lane == .fast { log("route: fast lane (\(Settings.assistant == .claude ? "Haiku" : AgyModels.fastest))") }
        current = s
        state.raw = ""
        state.status = "Thinking…"
        if state.phase != .thinking { set(.thinking) }
        s.send(text: sendText, shots: saved)
    }

    func finish(result: String?, error: String?) {
        log("answer: \(error.map { "ERROR " + $0 } ?? (result ?? "").replacingOccurrences(of: "\n", with: " ").prefix(300).description)")
        if let error { activity.error(error) } else { activity.done(cost: lastCost) }
        lastCost = nil
        if let error {
            state.raw = error
            set(.error)
            scheduleHide(after: 15)
            return
        }
        if let result, !result.isEmpty { state.raw = result }
        set(.done)
        speaker.feed(Diagrams.speakable(state.answer), final: true)

        // Drawings go on the real screen, over the thing the answer is about (the answer itself sits in the corner).
        let marks = Markup.marks(in: state.raw)
        if !marks.isEmpty, !currentShots.isEmpty {
            let items: [DrawItem] = marks.map { mark in
                let shot = currentShots[min(max(mark.image, 1), currentShots.count) - 1]
                return DrawItem(kind: mark.kind, a: shot.screenPoint(forImagePoint: mark.a),
                                b: shot.screenPoint(forImagePoint: mark.b), label: mark.label)
            }
            highlight.draw(items, for: 25)
            log("drawing \(marks.count) mark(s) on screen")
        }

        history.add(HistoryEntry(date: Date(), project: currentProject, question: state.question, answer: state.raw,
                                 screenshots: currentShots.compactMap { $0.file?.path }))
        scheduleHide(after: 90)
    }
}
