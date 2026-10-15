import AppKit

// Actions that change a setting or open something, used by the menu and the Settings window (the voice, setup and
// project ones live with their features).

extension AppDelegate {
    /// nil = the CLI's own setting. A running terminal Claude switches too.
    func setEffort(_ level: String?) {
        Settings.effort = level
        log("effort: \(level ?? "default")")
        if let level { propagate("/effort \(level)") }
    }

    /// An agy model id; nil = whatever agy itself is set to.
    func setAgyModel(_ id: String?) {
        Settings.agyModel = id
        log("agy model: \(id ?? "default")")
    }

    func setAssistant(_ a: Assistant) {
        Settings.assistant = a
        log("assistant: \(a.appName)")
        if a != .claude { AgyUsage.shared.refresh(agy: cfg.agy) }
        updateStatusTitle() // the usage rings follow the assistant
    }

    /// A Claude Code alias (MenuLabels.claudeModels). A running terminal Claude switches too.
    func setClaudeModel(_ alias: String) {
        Settings.model = alias
        propagate("/model \(alias)")
    }

    @objc func showHistoryMenu() { showHistory() }

    /// The browser layer's animated cursor; off = a marker file the node side checks.
    var ghostCursorOn: Bool { !FileManager.default.fileExists(atPath: ghostOffFile.path) }

    func setGhostCursor(_ on: Bool) {
        if on { try? FileManager.default.removeItem(at: ghostOffFile) }
        else { FileManager.default.createFile(atPath: ghostOffFile.path, contents: nil) }
    }

    @objc func copyAnswerMenu() {
        let last = history.entries.first.map { Markup.display($0.answer) } ?? state.answer
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(last, forType: .string)
    }

    @objc func openScreenSettings() {
        CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc func openLog() { NSWorkspace.shared.open(logURL) }

    /// integrations.json holds API keys: TypeSafe (Jev instant browser commands) and Gemini (Gemini CLI via API key).
    @objc func openIntegrations() {
        let file = supportDir.appendingPathComponent("integrations.json")
        if !FileManager.default.fileExists(atPath: file.path) {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
            try? "{\n  \"typesafe\": { \"apiKey\": \"\" },\n  \"gemini\": { \"apiKey\": \"\" }\n}\n".write(to: file, atomically: true, encoding: .utf8)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        NSWorkspace.shared.open(file)
    }

    func setStartAtLogin(_ on: Bool) {
        do {
            try LoginItem.set(on)
        } catch {
            log("login item: \(error)")
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Couldn't change Start at Login"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    /// "ask" | "auto" | "off"
    func setComputerControl(_ mode: String) {
        Settings.computerControl = mode
        controlAllowUntil = nil
        if mode != "off", !Computer.isTrusted { Computer.requestTrust() }
    }

    func setWatchCrashes(_ on: Bool) {
        Settings.watchCrashes = on
        if on { crashWatcher.start() } else { crashWatcher.stop() }
    }

    @objc func grantAccessibility() {
        if !Computer.requestTrust() {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        }
    }

    @objc func openCrashLog() { NSWorkspace.shared.open(CrashReporter.logURL) }
}
