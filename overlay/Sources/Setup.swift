import AppKit
import AVFoundation
import Speech
import SwiftUI

/// First-run setup: one window that walks through every permission and download VisionCLI needs, one step at a
/// time, with live status (✓ as soon as macOS reports it granted). Reopen it from VisionCLI menu → Settings… → General → Setup Wizard.
/// Screen Recording only takes effect after a relaunch, so the step we're on is remembered across restarts.
final class SetupWizard {
    /// What the wizard needs from the app (engines, installers) without knowing the AppDelegate.
    struct Hooks {
        var chooseSpeech: (String) -> Void          // "parakeet" | "external" | "apple" | "whisper:<model>"
        var whisperModels: () -> [String]           // installed Whisper models ("small.en", …)
        var whisperReady: () -> Bool
        var installWhisper: () -> Void
        var voices: () -> [(id: String, label: String)] // Kokoro voices (empty until installed)
        var selectVoice: (String?) -> Void          // nil = the macOS voice; plays a preview
        var setSpeak: (Bool) -> Void
        var setSpeed: (Double) -> Void
        var parakeetReady: () -> Bool
        var installKokoro: () -> Void
        var installStatus: () -> String?            // "Downloading Kokoro voices… 42%" while installing
        var useSystemVoice: () -> Void
        var isInstalled: (Assistant) -> Bool
        var toolsConnected: (Assistant) -> Bool       // slow: called off the main thread
        var connectTools: (Assistant, @escaping (String?) -> Void) -> Void
        var chooseAssistant: (Assistant) -> Void
        var setTerminalMode: (Bool) -> Void
        var accessibilityGranted: () -> Void        // start the ⌥ hold keys
        var relaunch: () -> Void
    }

    private var window: NSWindow?
    private var model: SetupModel?
    private lazy var closeWatcher = CloseWatcher { [weak self] in
        // Closed with the red button: don't reopen mid-setup next launch (only if something required is missing).
        Settings.setupStep = nil
        if SetupModel.requiredGranted { Settings.setupDone = true }
        self?.model?.stopPolling()
        self?.model = nil
        self?.window = nil
    }

    /// First run, or a required permission is missing and setup was never finished.
    static var shouldShow: Bool {
        if Settings.setupDone { return false }
        if Config.isFirstRun || Settings.setupStep != nil { return true }
        // Existing users who already granted everything never see it.
        if SetupModel.requiredGranted { Settings.setupDone = true; return false }
        return true
    }

    func show(hooks: Hooks) {
        NSApp.activate(ignoringOtherApps: true)
        if let window { window.makeKeyAndOrderFront(nil); return }
        let model = SetupModel(hooks: hooks)
        model.onFinish = { [weak self] in self?.close() }
        self.model = model
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 480),
                         styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: SetupView(m: model))
        w.center()
        w.level = .floating
        w.delegate = closeWatcher
        w.makeKeyAndOrderFront(nil)
        window = w
        model.startPolling()
    }

    func close() {
        model?.stopPolling()
        model = nil
        window?.delegate = nil
        window?.orderOut(nil)
        window = nil
    }
}

private final class CloseWatcher: NSObject, NSWindowDelegate {
    let onClose: () -> Void
    init(_ onClose: @escaping () -> Void) { self.onClose = onClose }
    /// Only a close the user asked for (the red button): quitting or relaunching (Screen Recording) closes windows
    /// too, and must keep the step to resume on.
    func windowShouldClose(_ sender: NSWindow) -> Bool { onClose(); return true }
}

// MARK: - Steps and status

enum SetupStep: String, CaseIterable, Identifiable {
    case welcome, microphone, speech, accessibility, screen, automation, transcription, voice, assistant, addons, done
    var id: String { rawValue }

    var title: String {
        switch self {
        case .welcome: return "Welcome"
        case .microphone: return "Microphone"
        case .speech: return "Speech Recognition"
        case .accessibility: return "Accessibility"
        case .screen: return "Screen Recording"
        case .automation: return "Terminal Access"
        case .transcription: return "Speech Model"
        case .voice: return "Voice"
        case .assistant: return "Assistant"
        case .addons: return "Add-ons"
        case .done: return "All Set"
        }
    }

    var icon: String {
        switch self {
        case .welcome: return "hand.wave.fill"
        case .microphone: return "mic.fill"
        case .speech: return "waveform"
        case .accessibility: return "keyboard"
        case .screen: return "rectangle.dashed.badge.record"
        case .automation: return "terminal.fill"
        case .transcription: return "brain.head.profile"
        case .voice: return "speaker.wave.2.fill"
        case .assistant: return "sparkles"
        case .addons: return "puzzlepiece.extension.fill"
        case .done: return "checkmark.seal.fill"
        }
    }

    var optional: Bool { [.automation, .voice, .addons].contains(self) }
}

enum StepState { case pending, done, optional }

final class SetupModel: ObservableObject {
    @Published var step: SetupStep
    @Published var mic = false
    @Published var speech = false
    @Published var accessibility = false
    @Published var screen = false
    @Published var screenAsked = false
    @Published var automation: OSStatus? // nil = not checked yet
    @Published var speechEngine = Settings.sttEngine == "whisper" ? "whisper:\(Settings.whisperModel)" : Settings.sttEngine
    @Published var whisperModels: [String] = []
    @Published var speak = Settings.speak
    @Published var speed = Settings.speechSpeed
    @Published var voice: String? = Settings.ttsEngine == "kokoro" ? Settings.kokoroVoice : nil
    @Published var voices: [(id: String, label: String)] = []
    @Published var parakeetProgress: Double? // 0…1 while downloading
    @Published var parakeetReady = false
    @Published var kokoroStatus: String?
    @Published var kokoroInstalled = ModelInstaller.kokoroInstalled
    @Published var assistant = Settings.assistant
    @Published var terminalMode = Settings.terminalMode
    @Published var connected: [Assistant: Bool] = [:]   // missing = not checked yet
    @Published var connecting: Set<Assistant> = []
    @Published var connectError: [Assistant: String] = [:]

    let hooks: SetupWizard.Hooks
    var onFinish: () -> Void = {}
    private var timer: Timer?

    static let parakeetBytes: Double = 540_000_000
    static var parakeetModelsDir: URL { home.appendingPathComponent("Library/Application Support/FluidAudio/Models") }
    static var terminalBundle: String {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") != nil ? "com.googlecode.iterm2" : "com.apple.Terminal"
    }
    static var terminalName: String { terminalBundle == "com.googlecode.iterm2" ? "iTerm" : "Terminal" }
    static var hasParakeet: Bool { ParakeetEngine.binary != nil }
    static var parakeetDownloaded: Bool {
        FileManager.default.fileExists(atPath: parakeetModelsDir.appendingPathComponent("parakeet-tdt-0.6b-v2").path)
    }

    static var requiredGranted: Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            && SFSpeechRecognizer.authorizationStatus() == .authorized
            && Computer.isTrusted && Screen.hasPermission
    }

    init(hooks: SetupWizard.Hooks) {
        self.hooks = hooks
        step = Settings.setupStep.flatMap(SetupStep.init(rawValue:)) ?? .welcome
        refresh()
        checkAutomation(ask: false)
        checkAssistant()
    }

    /// Which CLIs already have VisionCLI's tools (each check runs the CLI, so in the background).
    private func checkAssistant() {
        for a in Assistant.allCases where hooks.isInstalled(a) {
            DispatchQueue.global(qos: .utility).async {
                let ok = self.hooks.toolsConnected(a)
                DispatchQueue.main.async { self.connected[a] = ok }
            }
        }
    }

    func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    /// Re-reads every status (the user flips switches in System Settings while the window is open).
    func refresh() {
        mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        speech = SFSpeechRecognizer.authorizationStatus() == .authorized
        let trusted = Computer.isTrusted
        if trusted && !accessibility { hooks.accessibilityGranted() }
        accessibility = trusted
        screen = Screen.hasPermission
        parakeetReady = hooks.parakeetReady()
        if speechEngine == "parakeet", !parakeetReady, parakeetProgress != nil {
            DispatchQueue.global(qos: .utility).async {
                let bytes = Double(Self.folderSize(Self.parakeetModelsDir))
                DispatchQueue.main.async { self.parakeetProgress = min(0.99, bytes / Self.parakeetBytes) }
            }
        }
        if parakeetReady { parakeetProgress = nil }
        kokoroStatus = hooks.installStatus()
        kokoroInstalled = ModelInstaller.kokoroInstalled
        whisperModels = hooks.whisperModels()
        voices = hooks.voices()
        if step == .automation { checkAutomation(ask: false) }
    }

    func state(of s: SetupStep) -> StepState {
        switch s {
        case .welcome: return SetupStep.allCases.firstIndex(of: step)! > 0 ? .done : .pending
        case .microphone: return mic ? .done : .pending
        case .speech: return speech ? .done : .pending
        case .accessibility: return accessibility ? .done : .pending
        case .screen: return screen ? .done : .pending
        case .automation: return automation == noErr ? .done : .optional
        case .transcription:
            if speechEngine == "parakeet" { return parakeetReady ? .done : .pending }
            if speechEngine.hasPrefix("whisper") { return whisperModels.isEmpty ? .pending : .done }
            return .done
        case .voice: return speak ? .done : .optional
        case .assistant: return connected[assistant] == true ? .done : .pending
        case .addons:
            let a = AddOns.shared
            return a.all.allSatisfy { a.installed.contains($0.id) } ? .done : .optional
        case .done: return .pending
        }
    }

    func go(_ s: SetupStep) {
        step = s
        Settings.setupStep = s.rawValue
        if s == .automation { checkAutomation(ask: false) }
    }

    func next() {
        let all = SetupStep.allCases
        guard let i = all.firstIndex(of: step), i + 1 < all.count else { finish(); return }
        go(all[i + 1])
    }

    func back() {
        let all = SetupStep.allCases
        if let i = all.firstIndex(of: step), i > 0 { go(all[i - 1]) }
    }

    func finish() {
        Settings.setupDone = true
        Settings.setupStep = nil
        onFinish()
    }

    // MARK: Actions

    func askMicrophone() {
        AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { self.refresh() } }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .denied { openPrivacy("Privacy_Microphone") }
    }

    func askSpeech() {
        SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async { self.refresh() } }
        if SFSpeechRecognizer.authorizationStatus() == .denied { openPrivacy("Privacy_SpeechRecognition") }
    }

    func askAccessibility() {
        _ = Computer.requestTrust()
        openPrivacy("Privacy_Accessibility")
    }

    func askScreen() {
        screenAsked = true
        Settings.setupStep = SetupStep.screen.rawValue // come back here after the relaunch macOS asks for
        if !CGRequestScreenCaptureAccess() { openPrivacy("Privacy_ScreenCapture") }
    }

    /// Asking blocks until the user answers macOS's prompt, so it runs off the main thread.
    func checkAutomation(ask: Bool) {
        let bundle = Self.terminalBundle
        if ask, NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty {
            // macOS can only ask about an app that's running.
            NSWorkspace.shared.openApplication(at: NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle)!,
                                               configuration: .init()) { _, _ in
                DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { self.automationCheck(bundle, ask: true) }
            }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { self.automationCheck(bundle, ask: ask) }
    }

    private func automationCheck(_ bundle: String, ask: Bool) {
        var addr = AEAddressDesc()
        let id = Array(bundle.utf8)
        AECreateDesc(typeApplicationBundleID, id, id.count, &addr)
        let status = AEDeterminePermissionToAutomateTarget(&addr, typeWildCard, typeWildCard, ask)
        AEDisposeDesc(&addr)
        DispatchQueue.main.async {
            self.automation = status
            if status == OSStatus(errAEEventNotPermitted) && ask { self.openPrivacy("Privacy_Automation") }
        }
    }

    func chooseSpeech(_ engine: String) {
        speechEngine = engine
        hooks.chooseSpeech(engine)
        if engine == "parakeet" && !hooks.parakeetReady() { parakeetProgress = 0 }
    }

    func chooseVoice(_ id: String?) {
        voice = id
        speak = true
        hooks.selectVoice(id)
    }

    func chooseAssistant(_ a: Assistant) {
        assistant = a
        hooks.chooseAssistant(a)
        // Its tools are needed for voice questions: connect right away if they aren't yet.
        if connected[a] != true { connect(a) }
    }

    func connect(_ a: Assistant) {
        connecting.insert(a)
        connectError[a] = nil
        hooks.connectTools(a) { [weak self] error in
            guard let self else { return }
            self.connecting.remove(a)
            if let error { self.connectError[a] = error } else { self.connected[a] = true }
        }
    }

    func setTerminalMode(_ on: Bool) {
        terminalMode = on
        hooks.setTerminalMode(on)
    }

    func openPrivacy(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }

    /// "Downloading Kokoro voices… 42%" → 0.42 (indeterminate when there's no number).
    static func percent(_ status: String) -> Double? {
        guard let r = status.range(of: #"(\d+)%"#, options: .regularExpression) else { return nil }
        return Double(status[r].dropLast()).map { $0 / 100 }
    }

    static func folderSize(_ url: URL) -> Int {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total = 0
        for case let f as URL in e { total += (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 }
        return total
    }
}

// MARK: - Views

private struct SetupView: View {
    @ObservedObject var m: SetupModel

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                ScrollView { VStack(alignment: .leading, spacing: 0) { content }.padding(.horizontal, 32).padding(.top, 40).frame(maxWidth: .infinity, alignment: .leading) }
                Divider()
                footer.padding(.horizontal, 24).padding(.vertical, 14)
            }
        }
        .frame(width: 720, height: 480)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Set up VisionCLI").font(.system(size: 13, weight: .semibold)).padding(.bottom, 10).padding(.leading, 8)
            ForEach(SetupStep.allCases) { s in
                Button { m.go(s) } label: {
                    HStack(spacing: 8) {
                        badge(for: s)
                        Text(s.title).font(.system(size: 12.5, weight: s == m.step ? .semibold : .regular))
                        Spacer()
                    }
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(s == m.step ? Color.accentColor.opacity(0.15) : .clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .focusable(false)
            }
            Spacer()
        }
        .padding(.top, 36).padding(.horizontal, 10)
        .frame(width: 200)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.6))
    }

    @ViewBuilder private func badge(for s: SetupStep) -> some View {
        switch m.state(of: s) {
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .optional: Image(systemName: "circle.dotted").foregroundStyle(.secondary)
        case .pending: Image(systemName: s.icon).foregroundStyle(s == m.step ? Color.accentColor : .secondary)
        }
    }

    private var footer: some View {
        HStack {
            if m.step != .welcome { Button("Back") { m.back() } }
            Spacer()
            if m.step == .done {
                Button("Finish") { m.finish() }.keyboardShortcut(.defaultAction)
            } else {
                Button(m.state(of: m.step) == .done || m.step == .welcome || m.step.optional ? "Continue" : "Continue Anyway") { m.next() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch m.step {
        case .welcome:
            header("Welcome to VisionCLI", "Ask Claude about anything on your screen, out loud. This takes about a minute.")
            VStack(alignment: .leading, spacing: 10) {
                keyRow("⌥", "Hold Option, ask, let go: the answer appears in the corner.")
                keyRow("⌥ ⌘", "Hold Option and Command to include a screenshot of the window.")
                keyRow("⌥ ⇧ Space", "Drag a box around what you mean.")
            }
            .padding(.top, 8)
            if let img = Bundle.main.url(forResource: "peek", withExtension: "png", subdirectory: "mascot").flatMap(NSImage.init(contentsOf:)) {
                HStack { Spacer(); Image(nsImage: img).resizable().scaledToFit().frame(height: 110) }.padding(.top, 12)
            }
        case .microphone:
            header("Microphone", "VisionCLI listens only while you hold ⌥.")
            permission(granted: m.mic, button: "Allow Microphone", action: m.askMicrophone)
        case .speech:
            header("Speech Recognition", "Shows your words live while you talk. On-device on most Macs.")
            permission(granted: m.speech, button: "Allow Speech Recognition", action: m.askSpeech)
        case .accessibility:
            header("Accessibility", "Lets VisionCLI notice when you hold ⌥, and click and type for you when you ask it to.")
            permission(granted: m.accessibility, button: "Open Accessibility Settings", action: m.askAccessibility)
            note("In System Settings, turn on VisionCLI in the list. This window updates on its own.")
        case .screen:
            header("Screen Recording", "Lets VisionCLI see the window you're asking about. It only looks when you ask. Meeting Notes also uses it to hear your Mac's sound.")
            permission(granted: m.screen, button: "Allow Screen Recording", action: m.askScreen)
            if !m.screen && m.screenAsked {
                note("After turning it on, macOS needs VisionCLI to restart. Setup continues where you left off.")
                Button("Restart VisionCLI") { m.hooks.relaunch() }.padding(.top, 4)
            }
        case .automation:
            header("Terminal Access", "Optional: lets VisionCLI type your spoken questions into Claude in \(SetupModel.terminalName).")
            permission(granted: m.automation == noErr, button: "Allow \(SetupModel.terminalName)") { m.checkAutomation(ask: true) }
            if m.automation == OSStatus(errAEEventNotPermitted) {
                note("It's turned off. In System Settings → Privacy & Security → Automation, turn on \(SetupModel.terminalName) under VisionCLI.")
            }
        case .transcription:
            header("Speech Model", "How your voice becomes text. You can change it later in VisionCLI menu → Settings… → Voice.")
            VStack(alignment: .leading, spacing: 10) {
                if SetupModel.hasParakeet {
                    choice("parakeet", "Parakeet (recommended)", "Most accurate, runs on your Mac, knows your project's names. "
                           + (SetupModel.parakeetDownloaded ? "Already on your Mac." : "Downloads about 540 MB once."))
                }
                if FlowDictation.isInstalled {
                    choice("external", "Wispr Flow", "Uses your Wispr Flow account. Flow must be running with fn as its push-to-talk key.")
                }
                ForEach(m.whisperModels, id: \.self) { name in
                    choice("whisper:\(name)", "Whisper \(name)", Self.whisperDetail(name))
                }
                if m.whisperModels.isEmpty {
                    choice("whisper:small.en", "Whisper", "Runs on your Mac, good with accents. Downloads about 490 MB (needs Homebrew).")
                }
                choice("apple", "Apple (built in)", "No download. Less accurate with code words and names.")
            }
            if m.speechEngine.hasPrefix("whisper"), m.whisperModels.isEmpty {
                if let status = m.kokoroStatus {
                    VStack(alignment: .leading, spacing: 4) {
                        ProgressView(value: SetupModel.percent(status))
                        Text(status).font(.caption).foregroundStyle(.secondary)
                    }.padding(.top, 8)
                } else {
                    Button("Download Whisper") { m.hooks.installWhisper() }.padding(.top, 8)
                }
            }
            if m.speechEngine == "parakeet" {
                if m.parakeetReady {
                    Label("Parakeet is ready.", systemImage: "checkmark.circle.fill").foregroundStyle(.green).padding(.top, 8)
                } else if let p = m.parakeetProgress {
                    VStack(alignment: .leading, spacing: 4) {
                        ProgressView(value: p)
                        Text(p < 0.98 ? "Downloading Parakeet… \(Int(p * 100))%" : "Preparing the model for your Mac…")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(.top, 8)
                } else {
                    Button("Download Parakeet") { m.chooseSpeech("parakeet") }.padding(.top, 8)
                }
            }
        case .voice:
            header("Voice", "VisionCLI can read short answers aloud. Pick a voice; you'll hear a sample.")
            Toggle("Read answers aloud", isOn: Binding(get: { m.speak }, set: { m.speak = $0; m.hooks.setSpeak($0) }))
                .toggleStyle(.switch).fixedSize()
            do {
                if m.speak { Picker("Speed", selection: Binding(get: { m.speed }, set: { m.speed = $0; m.hooks.setSpeed($0) })) {
                    ForEach([1.0, 1.25, 1.5, 2.0], id: \.self) { x in Text(x == 1 ? "1×" : "\(x.formatted())×").tag(x) }
                }
                .pickerStyle(.segmented).frame(width: 260).padding(.top, 6) }
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(m.voices, id: \.id) { v in voiceRow(v.id, "Kokoro · \(v.label)") }
                    voiceRow(nil, "macOS voice")
                }
                .padding(.top, 10)
                if !m.kokoroInstalled {
                    if let status = m.kokoroStatus {
                        VStack(alignment: .leading, spacing: 4) {
                            ProgressView(value: SetupModel.percent(status))
                            Text(status).font(.caption).foregroundStyle(.secondary)
                        }.padding(.top, 8)
                    } else {
                        Button("Download Natural Voices (~340 MB)") { m.hooks.installKokoro() }.padding(.top, 8)
                        note("Seven natural-sounding voices (US and UK) that run on your Mac.")
                    }
                }
            }
        case .assistant:
            header("Assistant", "Pick the AI that answers your voice questions. VisionCLI's tools (look, click, browser…) are connected to it, so they also work when you type.")
            VStack(alignment: .leading, spacing: 10) {
                assistantRow(.claude, "Claude Code", "Anthropic's Claude in your terminal.",
                             install: "Install from claude.com/claude-code, then run `claude` once to sign in.")
                assistantRow(.antigravity, "Gemini (Antigravity)", "Google's Gemini through the Antigravity CLI.",
                             install: "Install Antigravity from antigravity.google, then run `agy` once to sign in.")
            }
            Text("Answers appear").font(.system(size: 13, weight: .semibold)).padding(.top, 18)
            Picker("", selection: Binding(get: { m.terminalMode }, set: { m.setTerminalMode($0) })) {
                Text("In your terminal (type or talk, same conversation)").tag(true)
                Text("Only in the bubble (lighter)").tag(false)
            }
            .pickerStyle(.radioGroup).labelsHidden().padding(.top, 4)
            let others = [Assistant.gemini].filter { m.hooks.isInstalled($0) }
            if !others.isEmpty {
                Text("Also connect the tools to").font(.system(size: 13, weight: .semibold)).padding(.top, 18)
                ForEach(others, id: \.self) { a in toolsRow(a) }
            }
        case .addons:
            header("Add-ons for Claude Code", "Optional plugins that make Claude better at everyday coding. The ticked ones are installed for all your projects; you can change this later in Settings → Integrations.")
            AddOnsStep()
        case .done:
            header("You're all set", "Hold ⌥ and ask \"what is this?\" while pointing at anything on your screen.")
            let missing = SetupStep.allCases.filter { !$0.optional && $0 != .done && m.state(of: $0) == .pending }
            if !missing.isEmpty {
                note("Still to do: \(missing.map(\.title).joined(separator: ", ")). Reopen this from VisionCLI menu → Settings… → General → Setup Wizard.")
            }
        }
    }

    private func header(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: m.step.icon).font(.system(size: 26)).foregroundStyle(Color.accentColor).padding(.bottom, 4)
            Text(title).font(.system(size: 22, weight: .bold))
            Text(subtitle).font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 16)
    }

    private func permission(granted: Bool, button: String, action: @escaping () -> Void) -> some View {
        Group {
            if granted {
                Label("Allowed", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.system(size: 13, weight: .medium))
            } else {
                Button(button, action: action).controlSize(.large)
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.top, 10)
    }

    private func keyRow(_ keys: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(keys).font(.system(size: 12, weight: .semibold, design: .rounded))
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.5)))
                .frame(width: 92, alignment: .leading)
            Text(text).font(.system(size: 13))
        }
    }

    private func choice(_ engine: String, _ title: String, _ detail: String) -> some View {
        Button { m.chooseSpeech(engine) } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: m.speechEngine == engine ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(m.speechEngine == engine ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func assistantRow(_ a: Assistant, _ title: String, _ detail: String, install: String) -> some View {
        let installed = m.hooks.isInstalled(a)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: m.assistant == a ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(m.assistant == a ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title + (installed ? "" : " (not installed)")).font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(installed ? .primary : .secondary)
                Text(installed ? detail : install).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if installed { connectionStatus(a) }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if installed { m.chooseAssistant(a) } }
    }

    private func toolsRow(_ a: Assistant) -> some View {
        HStack(spacing: 10) {
            Text(a.appName).font(.system(size: 13))
            connectionStatus(a)
        }
        .padding(.top, 4)
    }

    @ViewBuilder private func connectionStatus(_ a: Assistant) -> some View {
        if m.connecting.contains(a) {
            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Connecting…").font(.caption).foregroundStyle(.secondary) }
        } else if m.connected[a] == true {
            Label("Tools connected", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
        } else if let error = m.connectError[a] {
            HStack(spacing: 8) {
                Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
                Button("Try Again") { m.connect(a) }.controlSize(.small)
            }
        } else if m.connected[a] == false {
            Button("Connect Tools") { m.connect(a) }.controlSize(.small)
        }
    }

    private func voiceRow(_ id: String?, _ label: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: m.voice == id ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(m.voice == id ? Color.accentColor : .secondary)
            Text(label).font(.system(size: 13))
            Spacer()
            Image(systemName: "play.circle").foregroundStyle(.secondary)
        }
        .frame(width: 320)
        .contentShape(Rectangle())
        .onTapGesture { m.chooseVoice(id) }
    }

    static func whisperDetail(_ name: String) -> String {
        if name.hasPrefix("large") { return "Most accurate Whisper, slower. Already on your Mac." }
        if name.hasPrefix("medium") { return "More accurate, a bit slower. Already on your Mac." }
        return "Fast and accurate\(name.hasSuffix(".en") ? " (English)" : "")." + " Already on your Mac."
    }
}

/// Setup: the recommended add-ons, ticked unless already installed, and one button to install them.
private struct AddOnsStep: View {
    @ObservedObject var a = AddOns.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(a.all) { AddOnRow(addOn: $0, checkbox: true) }
            if !a.claudeInstalled {
                Text("Install Claude Code first (claude.com/claude-code).").font(.system(size: 12)).foregroundStyle(.secondary).padding(.top, 6)
            } else {
                let todo = a.selected.subtracting(a.installed)
                Button(a.installing.isEmpty ? "Install Selected" : "Installing…") { a.installSelected() }
                    .disabled(todo.isEmpty || !a.installing.isEmpty).controlSize(.large).padding(.top, 10)
            }
        }
        .onAppear { a.refresh(selectMissing: true) }
    }
}
