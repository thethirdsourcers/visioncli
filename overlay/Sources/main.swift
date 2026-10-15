// visioncli voice overlay: hold Option+Space, ask out loud, read the answer above your mouse pointer.
//
// A menu-bar accessory app. Speech is transcribed on-device, the window under the pointer is captured,
// and the question + screenshots go to a long-lived `claude` session for the project that window belongs to.
// Answers stream into a click-through bubble that follows the cursor; it can be pinned to scroll and click
// file links, can draw highlight boxes on screen, read answers aloud, and asks before Claude edits anything.

import AppKit
import AVFoundation
import Combine
import Speech
import SwiftUI

// MARK: - App
//
// AppDelegate holds the app's state and launch wiring; its behavior lives in extensions by feature:
// App+Listening (hotkeys, mic), App+Questions (routing, asking, answers), App+Sessions, App+Projects, App+Panel,
// App+Bubble, App+Announce, App+Menu / App+MenuActions, App+Settings (the Settings window), App+Setup, App+Voice, App+Debug, and Control.swift.
// Pure logic (no AppKit) is in Core*.swift, tested by scripts/test-overlay.sh.

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, BubbleActions {
    let cfg = Config.load()
    let state = OverlayState()
    var panel: OverlayPanel!
    var hosting: NSHostingView<OverlayView>!
    var hotkeys: HotKeys!
    let modifierHold = ModifierHold()
    var listener: Listener!
    let speaker = Speaker()
    var whisper: WhisperEngine?
    var parakeet: ParakeetEngine?
    let flow = FlowDictation()
    let spotlight = Spotlight()
    let meeting = MeetingNotes()
    lazy var meetingPanel = MeetingPanel(notes: meeting)
    let meetingLauncher = MeetingLauncher()
    var meetingParakeet: ParakeetEngine? // started for Meeting Notes when no voice engine runs
    var meetingWhisper: WhisperEngine?
    var meetingSTT = ""                  // the engine transcribing the meeting: parakeet | whisper | apple
    var meetingConsented = false         // asked once per launch; Meeting Notes itself is never remembered
    let mascot = Mascot()
    let setupWizard = SetupWizard()
    let settingsWindow = SettingsWindow()
    var installer: ModelInstaller!
    let updater = Updater()
    var sigterm: DispatchSourceSignal?
    let activity = BufferedActivity()
    var activityShown = false
    var lastCost: Double?
    var kokoro: KokoroEngine!
    let projects = ProjectResolver()
    let history = HistoryStore()
    let historyWindow = HistoryWindow()
    let highlight = HighlightOverlay()
    let selector = RegionSelector()
    var statusItem: NSStatusItem!

    var sessions: [String: AssistantSession] = [:]   // key: "<assistant>:<project>"
    var terminals: [String: TerminalSession] = [:]
    var currentTerminal: TerminalSession?
    var terminalContext: TerminalContext?
    var existingClaude: (project: String, context: TerminalContext)?
    var current: AssistantSession?
    var currentProject: String {
        didSet { if currentProject != oldValue { updateStatusTitle() } }
    }
    var candidates: (running: [(project: String, assistant: Assistant)], windows: [String]) = ([], [])
    var currentShots: [Shot] = []
    var currentWindow: WinInfo?
    var withScreen = false // this question gets a screenshot (⌥⇧Space, or the "every question" setting)
    var alwaysAllow: [String: Set<String>] = [:] // project → tools approved for the session
    // Computer control (see Control.swift)
    let controlServer = ControlServer()
    let uiElements = UIElements()
    var controlStopped: Date?          // Esc pressed during a task: refuse actions until the next question
    var controlAllowUntil: Date?       // "Allow all" on an action card: no more cards for a while
    var controlLastAction = Date.distantPast
    var pendingControl: ((Bool) -> Void)?
    var controlQueue: [() -> Void] = [] // actions waiting for an approval card to free up
    var controlTarget: NSRunningApplication? // the app the assistant is working in (keys/typing go there)
    let taskHUD = TaskHUD()
    var pausedActions: [(Bool) -> Void] = [] // held while the task is paused; false = cancelled
    let crashWatcher = CrashWatcher()

    var startShot: Shot?
    var region: CGRect?
    var pressedAt = Date()
    var instructed = Set<String>() // terminal conversations that already got the gemini/agy voice instructions
    var keyPoll: Timer?
    var followTimer: Timer?
    var hideWork: DispatchWorkItem?
    // Answers don't follow the pointer, so their size is only re-measured when the bubble's content changes.
    var stateChanges: AnyCancellable?
    var layoutDirtyUntil = Date.distantPast
    var lastLayout = Date.distantPast

    override init() {
        currentProject = ""
        super.init()
        HomeProject.ensure()
        // The project is picked by hand (Project menu); the first time, the launch folder (or Home) is it.
        if Settings.pinnedProject == nil { Settings.pinnedProject = cfg.cwd == home.path ? HomeProject.path : cfg.cwd }
        currentProject = Settings.pinnedProject ?? HomeProject.path
    }

    /// The last real project questions went to, and when: a question asked away from any project window shortly after
    /// may still be about it (Jev decides), later ones go to Home.
    var lastRealProject: (path: String, at: Date)?
    /// Set at key-down when the window under the pointer belongs to no project: Jev decides project or Home.
    var scopeProject: String?
    var scopeWindow: WinInfo?

    /// Updates the assistant sends on its own later ("the release is live"), through the `announce` tool: shown in the
    /// bubble and spoken, even with Speak Answers off. Waits while the user is in the middle of a question.
    var pendingAnnouncements: [String] = []
    var quickProc: Process?
    /// A running `visioncli browse` (multi-step browser task); Esc terminates it.
    var browseProc: Process?
    /// Smart routing state: the lane chosen for the next question, and the last question/lane per project (follow-ups).
    var nextLane: Lane = .strong
    var lastLane: [String: (lane: Lane, at: Date, question: String)] = [:]
    var lastWarm = Date.distantPast
    /// The node browser layer checks this file before animating its ghost cursor.
    let ghostOffFile = supportDir.appendingPathComponent("ghost-off")
    private var modifierKeysOn = false

    func applicationDidFinishLaunching(_ n: Notification) {
        MainThreadWatchdog.start()
        CaptureHiding.start()
        MeetingNotes.recoverRecordings()
        // Writes to a helper that just exited (claude's stdin is written on a background queue) must fail with an
        // error, not kill the app with SIGPIPE.
        signal(SIGPIPE, SIG_IGN)
        if CrashReporter.isCrashLooping() {
            log("crash loop detected; not restarting")
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "VisionCLI keeps crashing"
            alert.informativeText = "It crashed several times in the last few minutes, so it won't restart automatically. Details are in \(CrashReporter.logURL.path). Run `visioncli voice` to start it again."
            alert.runModal()
            CrashReporter.markCleanExit()
            exit(0) // a clean exit, so launchd stops relaunching it
        }
        let recovered = CrashReporter.install()
        NSApp.setActivationPolicy(.accessory)
        buildPanel()
        buildMenu()
        projects.refreshIfStale()

        listener = Listener(locale: cfg.locale)
        listener.onText = { [weak self] t in self?.state.question = t }
        listener.onLevel = { [weak self] l in self?.state.level = l }
        listener.onIssue = { [weak self] issue in
            guard let self, self.state.phase == .listening, self.state.question.isEmpty else { return }
            self.state.status = issue // shown in the pill while no text has arrived
        }

        startVoiceEngines()
        startComputerControl()
        startCrashWatcher()
        updater.onAvailable = { [weak self] release in
            guard let self else { return }
            self.state.question = "visioncli"
            self.flash("VisionCLI \(release.version) is available. Install it from VisionCLI menu → Install Update.", seconds: 10)
        }
        updater.onError = { [weak self] message in
            self?.state.question = "visioncli update"
            self?.flash(message, seconds: 12)
        }
        updater.startAutomaticChecks()
        installer = ModelInstaller(cfg: cfg)
        installer.onFinished = { [weak self] kind, error in
            guard let self else { return }
            self.state.question = "visioncli"
            if let error { self.flash(error, seconds: 12); return }
            switch kind {
            case .whisper:
                Settings.sttEngine = "whisper"
                Settings.whisperModel = "small.en"
                self.restartWhisper()
                self.flash("Whisper is installed. Transcription now runs locally.", seconds: 6)
            case .kokoro:
                Settings.ttsEngine = "kokoro"
                Settings.speak = true
                self.kokoro.start()
                self.flash("Kokoro voices are installed. Answers will be read aloud; pick a voice in VisionCLI menu → Settings… → Voice.", seconds: 8)
            }
        }
        updateStatusTitle()
        refreshCandidates()
        AgyModels.refresh(cfg: cfg)
        if SetupWizard.shouldShow { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.showSetupWizard() } }
        // Gemini (Antigravity) takes ~11 s to start: in bubble mode, have it ready before the first question.
        if Settings.assistant == .antigravity && !Settings.terminalMode {
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                self.session(for: self.currentProject).warm()
                if self.routingOn { self.session(for: self.currentProject, lane: .fast).warm() }
            }
        }
        // Candidates are refreshed when the menu opens (menuNeedsUpdate), not on a timer: each refresh runs `ps` and
        // an `lsof` per running CLI.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            log("project candidates: running=\(self.candidates.running.map { "\($0.assistant.binary):\($0.project)" }) windows=\(self.candidates.windows)")
        }
        if let recovered {
            log("recovered from a crash")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.state.question = "visioncli"; self.flash(recovered, seconds: 8) }
        }

        runDebugFlags()

        // `visioncli voice` replaces a running instance with SIGTERM; shut the helper processes down too.
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { [weak self] in self?.quit() }
        term.resume()
        sigterm = term

        flow.onText = { [weak self] text in self?.state.question = text }
        mascot.level = { [weak self] in self?.state.level ?? 0 }
        hotkeys = HotKeys()
        HotKeys.handler = { [weak self] key, pressed in self?.hotkey(key, pressed: pressed) }
        hotkeys.set(.meeting, true) // ⇧⌥⌘R: Meeting Notes
        if Computer.isTrusted {
            enableModifierKeys()
        } else {
            // No Accessibility yet: modifier-only keys can't be seen, so use ⌃Space / ⌃⌥Space until it's granted.
            log("hotkeys: no Accessibility permission; using ⌃ and ⌃⌥")
            hotkeys.set(.talk, true)
            hotkeys.set(.screen, true)
        }

        let repaired = repairStalePermissions(force: false)
        if !SetupWizard.shouldShow { // the wizard asks for these one at a time
            SFSpeechRecognizer.requestAuthorization { _ in }
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            if !Screen.hasPermission { CGRequestScreenCaptureAccess() }
        }
        if !repaired.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self.state.question = "visioncli"
                self.flash("This version needs you to allow VisionCLI once more (\(repaired.joined(separator: ", "))). Turn it on in the prompt or in System Settings → Privacy & Security; updates keep it from now on.", seconds: 14)
            }
        }
    }

    /// Hold ⌥ / ⌥⌘ (needs Accessibility). Called at launch, or when setup gets the permission.
    func enableModifierKeys() {
        guard !modifierKeysOn else { return }
        modifierKeysOn = true
        hotkeys.set(.talk, false)
        hotkeys.set(.screen, false)
        modifierHold.onChange = { [weak self] key, pressed in self?.hotkey(key, pressed: pressed) }
        modifierHold.immediate = { [weak self] in self?.state.phase == .listening }
        modifierHold.onUpgrade = { [weak self] in
            guard let self, self.state.phase == .listening, !self.withScreen else { return }
            log("hotkey: ⌘ added, now with a screenshot")
            self.withScreen = true
            self.spotlight.show()
        }
        modifierHold.start()
    }

    func applicationWillTerminate(_ notification: Notification) { controlServer.stop(); CrashReporter.markCleanExit() }

    @objc func quit() {
        AgySetup.clearSessionRules()
        CrashReporter.markCleanExit()
        sessions.values.forEach { $0.stop() }
        whisper?.stop()
        parakeet?.stop()
        kokoro.stop()
        log("quit")
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
