import AppKit

// The Project menu: candidates (running CLIs, open editor windows) and pinning a project.

extension AppDelegate {
    /// Refresh the Project menu's candidates in the background (running claude/gemini sessions, open editor windows).
    /// The process scan and the window list are taken off the main thread; mapping window titles to projects uses
    /// the resolver's index, which belongs to main.
    func refreshCandidates() {
        DispatchQueue.global(qos: .utility).async {
            let running = TerminalProbe.runningProjects()
            let windows = Screen.windows().filter { !$0.isTerminal }
            DispatchQueue.main.async {
                var open: [String] = []
                for w in windows {
                    if let p = self.projects.project(for: w), !open.contains(p) { open.append(p) }
                }
                self.candidates = (running, open)
            }
        }
    }

    @objc func pickProject(_ sender: NSMenuItem) {
        guard let p = sender.representedObject as? String else { return }
        Settings.pinnedProject = p
        currentProject = p
        updateStatusTitle()
        log("project: \(p)")
    }

    @objc func chooseProjectFolder() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Use This Project"
        panel.directoryURL = URL(fileURLWithPath: currentProject)
        if panel.runModal() == .OK, let url = panel.url {
            Settings.pinnedProject = url.path
            currentProject = url.path
            updateStatusTitle()
        }
    }
}
