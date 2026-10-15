import AppKit
import SwiftUI

/// The Settings window (VisionCLI menu → Settings…): every option in one place, laid out like macOS System Settings
/// (a sidebar of sections, each a page of grouped rows). Changes apply immediately; there is no Save button.
/// It knows nothing about the AppDelegate: it reads a snapshot of the current values and calls back through Hooks,
/// so every action runs the same app code the menu and the setup wizard use.
final class SettingsWindow {
    struct Hooks {
        var read: () -> SettingsSnapshot            // every value the window shows, read fresh
        // General
        var setStartAtLogin: (Bool) -> Void
        var checkForUpdates: () -> Void
        var installUpdate: () -> Void
        var showSetupWizard: () -> Void
        // Assistant
        var setAssistant: (Assistant) -> Void
        var setTerminalMode: (Bool) -> Void
        var setClaudeModel: (String) -> Void
        var setAgyModel: (String?) -> Void
        var setEffort: (String?) -> Void
        var refreshAgyModels: () -> Void
        // Voice
        var setSpeak: (Bool) -> Void
        var setSpeed: (Double) -> Void              // plays a sample
        var selectVoice: (String?) -> Void          // nil = the macOS voice; plays a sample
        var installKokoro: () -> Void
        var installWhisper: () -> Void
        var chooseSpeech: (String) -> Void          // "parakeet" | "external" | "apple" | "whisper:<model>"
        var editVocabulary: () -> Void
        var setAudioDevice: (Bool, String?) -> Void // (input, uid); nil uid = system default
        var testSpeaker: () -> Void
        // Computer Control
        var setComputerControl: (String) -> Void
        var grantAccessibility: () -> Void
        var accessibilityGranted: () -> Void        // start the ⌥ hold keys
        var setWatchCrashes: (Bool) -> Void
        var setGhostCursor: (Bool) -> Void
        // Meeting Notes
        var toggleMeeting: () -> Void               // asks first, once per launch
        var openMeetings: () -> Void
        var openMeeting: (String) -> Void           // a past meeting's folder
        var showMeetingPanel: () -> Void
        // Integrations
        var toolsConnected: (Assistant) -> Bool     // slow: called off the main thread
        var connectTools: (Assistant, @escaping (String?) -> Void) -> Void
        var openIntegrations: () -> Void
        // Advanced
        var fixPermissions: () -> Void
        var openLog: () -> Void
        var openCrashLog: () -> Void
        var openHome: () -> Void
    }

    private var window: NSWindow?
    private var model: SettingsModel?
    private var observers: [NSObjectProtocol] = []

    /// Opens the window, or brings the one already open to the front (there is only ever one).
    func show(hooks: Hooks) {
        NSApp.activate(ignoringOtherApps: true)
        if let window, let model {
            model.refresh()
            model.checkTools()
            window.makeKeyAndOrderFront(nil)
            return
        }
        let model = SettingsModel(hooks: hooks)
        self.model = model
        let w = SettingsPanelWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 540),
                                    styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
                                    backing: .buffered, defer: false)
        w.title = "VisionCLI Settings" // not shown (transparent titlebar), but used by Mission Control and the Window menu
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: SettingsView(m: model))
        w.setContentSize(NSSize(width: 760, height: 540))
        w.center()
        let nc = NotificationCenter.default
        observers = [
            nc.addObserver(forName: NSWindow.didBecomeKeyNotification, object: w, queue: .main) { [weak model] _ in model?.refresh() },
            // Poll only while some of the window is on screen (not minimized or hidden behind other windows).
            nc.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: w, queue: .main) { [weak model, weak w] _ in
                if w?.occlusionState.contains(.visible) == true { model?.refresh(); model?.startPolling() } else { model?.stopPolling() }
            },
            nc.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in self?.closed() },
        ]
        w.makeKeyAndOrderFront(nil)
        window = w
        model.startPolling()
        model.checkTools()
    }

    /// No timers or models are left behind once the window is closed.
    private func closed() {
        model?.stopPolling()
        model = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        window = nil
    }
}

/// The app has no main menu (it's a menu-bar accessory), so ⌘W has to be handled by the window itself.
private final class SettingsPanelWindow: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, event.charactersIgnoringModifiers == "w" {
            performClose(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

// MARK: - Values

/// Everything the window shows, read in one go. Comparing snapshots lets the light polling redraw only on change.
struct SettingsSnapshot: Equatable {
    struct Item: Equatable, Hashable { var id: String; var name: String }

    // General
    var startAtLogin = false
    var autoUpdate = true
    var screenshotEvery = false
    var hideFromCapture = false
    var version = ""
    var updateAvailable: String?        // a newer version, once found
    var updateStatus: String?           // "Downloading update…" while installing
    // Assistant
    var assistant = Assistant.claude
    var installed: [Assistant: Bool] = [:]
    var terminalMode = true
    var autoActivity = true
    var claudeModel = "default"
    var fixedModel: String?             // --model / VISIONCLI_MODEL wins over the picker
    var agyModel: String?
    var agyModels: [Item] = []
    var effort: String?
    var smartRouting = true
    // Voice
    var speak = false
    var speed = 2.0
    var voice: String?                  // Kokoro voice id; nil = the macOS voice
    var kokoroVoices: [Item] = []       // empty until Kokoro is installed
    var kokoroInstalled = false
    var installStatus: String?          // the model installer's progress ("Downloading Kokoro voices… 42%")
    var speechEngine = "apple"          // as in Hooks.chooseSpeech
    var hasParakeet = false
    var parakeetReady = false
    var parakeetDownloaded = false
    var flowInstalled = false
    var whisperModels: [String] = []
    var whisperDownloadable = false     // no model or no whisper-server yet
    var inputs: [Item] = []             // id = CoreAudio UID
    var outputs: [Item] = []
    var inputUID: String?
    var outputUID: String?
    var defaultInput = "none"
    var defaultOutput = "none"
    // Computer Control
    var computerControl = "ask"
    var accessibility = false
    var watchCrashes = true
    var ghostCursor = true
    var quickCommands = true
    // Meeting Notes
    var meetingNotes = false
    var meetingSummarizeGuest = true
    var meetingSummarizeYou = false
    var meetingReplies = true
    var meetingCodeLookup = true
    var meetingRecord = true
    var pastMeetings: [Item] = []      // the latest 10, id = folder path
    // Advanced
    var crashLogExists = false
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case general, assistant, voice, control, meetings, integrations, advanced
    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: return "General"
        case .assistant: return "Assistant"
        case .voice: return "Voice"
        case .control: return "Computer Control"
        case .meetings: return "Meeting Notes"
        case .integrations: return "Integrations"
        case .advanced: return "Advanced"
        }
    }

    var subtitle: String {
        switch self {
        case .general: return "Startup, updates and screenshots."
        case .assistant: return "Which AI answers your voice questions, where answers appear, and how hard it thinks."
        case .voice: return "How your voice becomes text, and how answers are read back to you."
        case .control: return "Let the assistant click and type for you, with your approval."
        case .meetings: return "Notes, summaries and suggested replies in your meetings, with a recording to play back."
        case .integrations: return "Connect VisionCLI's tools (look, click, browser…) to your AI command-line tools."
        case .advanced: return "Permissions, logs and files."
        }
    }

    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .assistant: return "sparkles"
        case .voice: return "waveform"
        case .control: return "cursorarrow.click.2"
        case .meetings: return "person.2.wave.2"
        case .integrations: return "puzzlepiece.extension"
        case .advanced: return "wrench.and.screwdriver"
        }
    }

    /// Tile colors, System Settings style.
    var tint: Color {
        switch self {
        case .general: return .gray
        case .assistant: return .purple
        case .voice: return .pink
        case .control: return .blue
        case .meetings: return .orange
        case .integrations: return .green
        case .advanced: return Color(white: 0.45)
        }
    }
}

final class SettingsModel: ObservableObject {
    @Published private(set) var s: SettingsSnapshot
    @Published var section: SettingsSection {
        didSet { UserDefaults.standard.set(section.rawValue, forKey: "settingsSection") }
    }
    @Published var connected: [Assistant: Bool] = [:]   // missing = not checked yet
    @Published var connecting: Set<Assistant> = []
    @Published var connectError: [Assistant: String] = [:]
    @Published var parakeetProgress: Double?            // 0…1 while Parakeet downloads

    let hooks: SettingsWindow.Hooks
    private var timer: Timer?

    init(hooks: SettingsWindow.Hooks) {
        self.hooks = hooks
        s = hooks.read()
        section = UserDefaults.standard.string(forKey: "settingsSection").flatMap(SettingsSection.init(rawValue:)) ?? .general
        if s.assistant == .antigravity && s.agyModels.isEmpty { hooks.refreshAgyModels() }
    }

    func startPolling() {
        guard timer == nil else { return }
        // Things change behind the window's back: downloads progress, devices come and go, permissions get granted.
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        let new = hooks.read()
        if new.accessibility && !s.accessibility { hooks.accessibilityGranted() }
        if new != s { s = new }
        if s.speechEngine == "parakeet", !s.parakeetReady, !s.parakeetDownloaded {
            DispatchQueue.global(qos: .utility).async {
                let bytes = Double(SetupModel.folderSize(SetupModel.parakeetModelsDir))
                DispatchQueue.main.async { self.parakeetProgress = min(0.99, bytes / SetupModel.parakeetBytes) }
            }
        } else if parakeetProgress != nil {
            parakeetProgress = nil
        }
    }

    /// Runs an app action, then re-reads: the action may not have happened (e.g. the Meeting Notes consent was cancelled).
    func run(_ action: () -> Void) {
        action()
        refresh()
    }

    /// A control bound to one snapshot value; setting it runs the app action.
    func bind<T>(_ key: KeyPath<SettingsSnapshot, T>, _ set: @escaping (T) -> Void) -> Binding<T> {
        Binding(get: { self.s[keyPath: key] }, set: { value in self.run { set(value) } })
    }

    /// Which CLIs already have VisionCLI's tools (each check runs the CLI, so in the background).
    func checkTools() {
        for a in Assistant.allCases where s.installed[a] == true {
            DispatchQueue.global(qos: .utility).async {
                let ok = self.hooks.toolsConnected(a)
                DispatchQueue.main.async { self.connected[a] = ok }
            }
        }
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
}

// MARK: - Views

struct SettingsView: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    page
                }
                .padding(.horizontal, 28).padding(.top, 40).padding(.bottom, 28)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .id(m.section) // each page starts scrolled to the top
            .background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(width: 760)
        .frame(minHeight: 540, maxHeight: .infinity)
        .ignoresSafeArea() // the sidebar runs up under the transparent titlebar, as in System Settings
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(nsImage: Self.appIcon).resizable().frame(width: 34, height: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text("VisionCLI").font(.system(size: 13, weight: .semibold))
                    Text("Version \(m.s.version)").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 18).padding(.top, 44).padding(.bottom, 8)
            // Plain rows rather than a sidebar List: List greys its labels out whenever the window isn't key, which
            // made the sections look disabled.
            VStack(alignment: .leading, spacing: 2) {
                ForEach(SettingsSection.allCases) { section in
                    let selected = section == m.section
                    Button { m.section = section } label: {
                        HStack(spacing: 8) {
                            Tile(symbol: section.icon, tint: section.tint, size: 20)
                            Text(section.title).font(.system(size: 13, weight: selected ? .semibold : .regular)).foregroundStyle(.primary)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.accentColor.opacity(0.18) : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .focusable(false) // otherwise the first row keeps a focus ring and looks selected
                }
                Spacer()
            }
            .padding(.horizontal, 10).padding(.top, 4)
        }
        .frame(width: 215)
        .background(SidebarMaterial())
    }

    /// The bundled AppIcon.icns (an accessory app's applicationIconImage can come back as a generic icon).
    static let appIcon: NSImage = Bundle.main.url(forResource: "AppIcon", withExtension: "icns").flatMap(NSImage.init(contentsOf:))
        ?? NSApp.applicationIconImage

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            Tile(symbol: m.section.icon, tint: m.section.tint, size: 34)
            VStack(alignment: .leading, spacing: 3) {
                Text(m.section.title).font(.system(size: 20, weight: .bold))
                Text(m.section.subtitle).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var page: some View {
        switch m.section {
        case .general: GeneralPage(m: m)
        case .assistant: AssistantPage(m: m)
        case .voice: VoicePage(m: m)
        case .control: ControlPage(m: m)
        case .meetings: MeetingsPage(m: m)
        case .integrations: IntegrationsPage(m: m)
        case .advanced: AdvancedPage(m: m)
        }
    }
}

// MARK: Pages

private struct GeneralPage: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        Card {
            SwitchRow("Start at login", "Opens VisionCLI when you log in to your Mac.", isOn: m.bind(\.startAtLogin, m.hooks.setStartAtLogin))
            Divider()
            SwitchRow("Screenshot every question",
                      "Sends a screenshot of the window with every voice question (uses more tokens). Off: only when you hold ⌥⌘ or drag a box; the assistant can still take a look itself.",
                      isOn: m.bind(\.screenshotEvery) { Settings.screenshotEveryQuestion = $0 })
        }
        Card("Updates") {
            Row("VisionCLI \(m.s.version)", m.s.updateStatus ?? m.s.updateAvailable.map { "Version \($0) is available." } ?? "Checks GitHub for new releases.") {
                if m.s.updateStatus != nil {
                    ProgressView().controlSize(.small)
                } else if m.s.updateAvailable != nil {
                    Button("Install Update…") { m.run(m.hooks.installUpdate) }
                } else {
                    Button("Check Now") { m.run(m.hooks.checkForUpdates) }
                }
            }
            Divider()
            SwitchRow("Check for updates automatically", "At launch and every 6 hours.", isOn: m.bind(\.autoUpdate) { Settings.autoUpdate = $0 })
        }
        Card("Setup") {
            Row("Setup wizard", "Walks through permissions, the speech model, voice and assistant again.") {
                Button("Open Setup Wizard…") { m.hooks.showSetupWizard() }
            }
        }
    }
}

private struct AssistantPage: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        let s = m.s
        Card(footer: "A terminal already running claude or agy is used as-is when you point at it.") {
            assistantRow(.claude, "Anthropic's Claude in your terminal.", install: "Install from claude.com/claude-code, then run claude once to sign in.")
            Divider()
            assistantRow(.antigravity, "Google's Gemini through the Antigravity CLI.", install: "Install Antigravity from antigravity.google, then run agy once to sign in.")
        }
        Card("Answers appear") {
            RadioRow("In your \(s.assistant.name) terminal", "Type or talk, same conversation. Answers show in the terminal and the bubble.",
                     selected: s.terminalMode) { m.run { m.hooks.setTerminalMode(true) } }
            Divider()
            RadioRow("Only in the bubble", "A hidden, leaner session in the background. It can't approve commands or edits.",
                     selected: !s.terminalMode) { m.run { m.hooks.setTerminalMode(false) } }
            if !s.terminalMode {
                Divider()
                SwitchRow("Open the activity terminal automatically", "Shows what the assistant is doing on the first question after launch.",
                          isOn: m.bind(\.autoActivity) { Settings.autoActivity = $0 })
            }
        }
        Card("Model") {
            modelRow
            Divider()
            Row("Effort", "Higher is slower but more thorough. Default leaves it to the CLI's own setting.") {
                Picker("", selection: Binding(get: { s.effort ?? "" }, set: { v in m.run { m.hooks.setEffort(v.isEmpty ? nil : v) } })) {
                    Text("Default").tag("")
                    ForEach(["low", "medium", "high", "xhigh", "max"], id: \.self) { Text(MenuLabels.effort($0)).tag($0) }
                }
                .labelsHidden().fixedSize()
            }
            Divider()
            SwitchRow("Fast model for simple questions",
                      "Jev sends light questions like \"what is this?\" to \(s.assistant == .antigravity ? "Gemini Flash" : "Claude Haiku") and the rest to your model."
                        + (s.terminalMode ? " Only when answers appear in the bubble." : ""),
                      isOn: m.bind(\.smartRouting) { Settings.smartRouting = $0 })
                .disabled(s.terminalMode)
        }
    }

    @ViewBuilder private var modelRow: some View {
        let s = m.s
        if s.assistant == .antigravity {
            Row("Model", s.agyModels.isEmpty ? "Loading models from agy…" : "Gemini models available to your agy sign-in.") {
                Picker("", selection: Binding(get: { s.agyModel ?? "" }, set: { v in m.run { m.hooks.setAgyModel(v.isEmpty ? nil : v) } })) {
                    Text("Default (from your agy settings)").tag("")
                    if !s.agyModels.isEmpty { Divider() }
                    ForEach(s.agyModels, id: \.id) { Text($0.name).tag($0.id) }
                    // A saved model agy no longer lists still shows as the current choice.
                    if let id = s.agyModel, !s.agyModels.contains(where: { $0.id == id }) { Text(id).tag(id) }
                }
                .labelsHidden().fixedSize()
            }
        } else if let fixed = s.fixedModel {
            Row("Model", "Set by VISIONCLI_MODEL (or --model) when VisionCLI was started; change it there.") {
                Text(MenuLabels.claudeModel(fixed)).foregroundStyle(.secondary)
            }
        } else {
            Row("Model", "A running terminal Claude switches too.") {
                Picker("", selection: Binding(get: { s.claudeModel }, set: { v in m.run { m.hooks.setClaudeModel(v) } })) {
                    ForEach(MenuLabels.claudeModels, id: \.0) { alias, label in
                        if alias == "opusplan" { Divider() }
                        Text(label).tag(alias)
                    }
                    if !MenuLabels.claudeModels.contains(where: { $0.0 == s.claudeModel }) { Text(s.claudeModel).tag(s.claudeModel) }
                }
                .labelsHidden().fixedSize()
            }
        }
    }

    private func assistantRow(_ a: Assistant, _ detail: String, install: String) -> some View {
        let installed = m.s.installed[a] == true
        return RadioRow(a.appName + (installed ? "" : " (not installed)"), installed ? detail : install,
                        selected: m.s.assistant == a, enabled: installed) {
            m.run { m.hooks.setAssistant(a) }
            if a == .antigravity && m.s.agyModels.isEmpty { m.hooks.refreshAgyModels() }
        }
    }
}

private struct VoicePage: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        let s = m.s
        Card {
            SwitchRow("Read answers aloud", "Answers are read out loud as well as shown.", isOn: m.bind(\.speak, m.hooks.setSpeak))
            Divider()
            Row("Speed", nil) {
                Picker("", selection: m.bind(\.speed, m.hooks.setSpeed)) {
                    ForEach([1.0, 1.25, 1.5, 1.75, 2.0], id: \.self) { x in Text(x == 1 ? "1×" : "\(x.formatted())×").tag(x) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 280)
            }
        }
        Card("Voice", footer: "Choosing a voice plays a sample.") {
            ForEach(s.kokoroVoices, id: \.id) { v in
                voiceRow(v.id, "Kokoro · \(v.name)")
                Divider()
            }
            voiceRow(nil, "macOS voice")
            if !s.kokoroInstalled {
                Divider()
                if let status = s.installStatus {
                    InstallProgress(status: status)
                } else {
                    Row("Natural voices", "Seven natural-sounding voices (US and UK) that run on your Mac. About 350 MB.") {
                        Button("Download…") { m.run(m.hooks.installKokoro) }
                    }
                }
            }
        }
        Card("Speech recognition") {
            if s.hasParakeet {
                RadioRow("Parakeet", "Local and fastest. Knows your project's names." + (s.parakeetDownloaded ? "" : " Downloads about 540 MB on first use."),
                         selected: s.speechEngine == "parakeet") { choose("parakeet") }
                if s.speechEngine == "parakeet" && !s.parakeetReady {
                    parakeetProgress.padding(.leading, 26).padding(.bottom, 6)
                }
                Divider()
            }
            RadioRow("Wispr Flow" + (s.flowInstalled ? "" : " (not installed)"),
                     s.flowInstalled ? "Uses your Wispr Flow account. Flow must be running with fn as its push-to-talk key." : "Install Wispr Flow to use your Flow account here.",
                     selected: s.speechEngine == "external", enabled: s.flowInstalled) { choose("external") }
            ForEach(s.whisperModels, id: \.self) { name in
                Divider()
                RadioRow("Whisper \(name)", "Local. Good with accents.", selected: s.speechEngine == "whisper:\(name)") { choose("whisper:\(name)") }
            }
            Divider()
            RadioRow("Apple", "On-device, no download. Less accurate with code words and names.", selected: s.speechEngine == "apple") { choose("apple") }
            if s.whisperDownloadable {
                Divider()
                if let status = s.installStatus {
                    InstallProgress(status: status)
                } else {
                    Row("Whisper", "More accurate with names and jargon. Installs whisper-cpp with Homebrew, then about 490 MB.") {
                        Button("Download…") { m.run(m.hooks.installWhisper) }
                    }
                }
            }
            Divider()
            Row("Vocabulary", "Words to spell right: names, products, libraries.") {
                Button("Edit Vocabulary…") { m.hooks.editVocabulary() }
            }
        }
        Card("Audio devices", footer: "These apply to VisionCLI only.") {
            Row("Microphone", s.inputUID != nil && !s.inputs.contains { $0.id == s.inputUID } ? "The chosen microphone is disconnected; using the default." : nil) {
                devicePicker(input: true)
            }
            Divider()
            Row("Speaker", s.outputUID != nil && !s.outputs.contains { $0.id == s.outputUID } ? "The chosen speaker is disconnected; using the default." : nil) {
                HStack(spacing: 8) {
                    devicePicker(input: false)
                    Button("Test") { m.hooks.testSpeaker() }
                }
            }
        }
    }

    private func choose(_ engine: String) { m.run { m.hooks.chooseSpeech(engine) } }

    private func voiceRow(_ id: String?, _ label: String) -> some View {
        HStack(spacing: 10) {
            RadioMark(selected: m.s.voice == id)
            Text(label).font(.system(size: 13))
            Spacer()
            Button { m.run { m.hooks.selectVoice(id) } } label: { Image(systemName: "play.circle").font(.system(size: 15)) }
                .buttonStyle(.borderless).help("Play a sample")
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture { m.run { m.hooks.selectVoice(id) } }
    }

    /// Same choices as before: "System default (name)" follows the Mac; a disconnected choice falls back to it.
    private func devicePicker(input: Bool) -> some View {
        let s = m.s
        let devices = input ? s.inputs : s.outputs
        let chosen = input ? s.inputUID : s.outputUID
        let current = chosen.flatMap { uid in devices.contains { $0.id == uid } ? uid : nil } ?? ""
        return Picker("", selection: Binding(get: { current }, set: { v in m.run { m.hooks.setAudioDevice(input, v.isEmpty ? nil : v) } })) {
            Text("System default (\(input ? s.defaultInput : s.defaultOutput))").tag("")
            if !devices.isEmpty { Divider() }
            ForEach(devices, id: \.id) { Text($0.name).tag($0.id) }
        }
        .labelsHidden().fixedSize()
    }

    @ViewBuilder private var parakeetProgress: some View {
        if let p = m.parakeetProgress {
            VStack(alignment: .leading, spacing: 4) {
                ProgressView(value: p)
                Text(p < 0.98 ? "Downloading Parakeet… \(Int(p * 100))%" : "Preparing the model for your Mac…").font(.caption).foregroundStyle(.secondary)
            }
        } else {
            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Loading Parakeet…").font(.caption).foregroundStyle(.secondary) }
        }
    }
}

private struct ControlPage: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        let s = m.s
        Card(footer: "Passwords, payments and System Settings always ask. Press Esc to stop it.") {
            ForEach(Array(["ask", "auto", "off"].enumerated()), id: \.1) { i, mode in
                if i > 0 { Divider() }
                RadioRow(Self.names[mode]!, Self.details[mode]!, selected: s.computerControl == mode) {
                    m.run { m.hooks.setComputerControl(mode) }
                }
            }
        }
        Card {
            Row("Accessibility", "Needed to click and type for you, and to notice when you hold ⌥.") {
                if s.accessibility {
                    Label("Allowed", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.system(size: 12, weight: .medium))
                } else {
                    Button("Grant Access…") { m.run(m.hooks.grantAccessibility) }
                }
            }
        }
        Card("Browser") {
            SwitchRow("Show AI cursor in browser", "An animated pointer shows where the assistant clicks and types.",
                      isOn: m.bind(\.ghostCursor, m.hooks.setGhostCursor))
            Divider()
            SwitchRow("Instant browser commands (Jev)", "Simple browser commands run right away through Jev before asking the assistant. Needs a TypeSafe API key (Integrations).",
                      isOn: m.bind(\.quickCommands) { Settings.quickCommands = $0 })
        }
        Card {
            SwitchRow("Watch for app crashes", "Notices when a Mac or Simulator app crashes and offers to explain why.",
                      isOn: m.bind(\.watchCrashes, m.hooks.setWatchCrashes))
        }
    }

    static let names = ["ask": "Ask before each action", "auto": "Allow all actions", "off": "Off"]
    static let details = [
        "ask": "You approve every click and keystroke in a bubble.",
        "auto": "No approval needed, except for sensitive spots.",
        "off": "The assistant can look at your screen, but not click or type.",
    ]
}

private struct MeetingsPage: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        let s = m.s
        Card {
            SwitchRow("Meeting Notes", "Listens to your Mac's sound (your colleagues) and your microphone (you), transcribes both on this Mac and shows the conversation in a panel. Start it anywhere with ⇧⌥⌘R. Off each time VisionCLI starts.",
                      isOn: Binding(get: { s.meetingNotes }, set: { on in if on != s.meetingNotes { m.run(m.hooks.toggleMeeting) } }))
            if s.meetingNotes {
                Divider()
                Row("Listening now", "The panel shows the conversation, summaries and replies.") { Button("Show Panel") { m.hooks.showMeetingPanel() } }
            }
        }
        Card("Past meetings", footer: "Each meeting is saved with its notes, the summary and the recording, in VisionCLI's meetings folder.") {
            if s.pastMeetings.isEmpty {
                Text("None yet.").font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 8)
            }
            ForEach(Array(s.pastMeetings.enumerated()), id: \.1.id) { i, meeting in
                if i > 0 { Divider() }
                Row(meeting.name, nil) { Button("Open") { m.hooks.openMeeting(meeting.id) }.disabled(s.meetingNotes) }
            }
            Divider()
            Row("All meetings", nil) { Button("Show in Finder") { m.hooks.openMeetings() } }
        }
        Card("During a meeting", footer: "Summaries, replies and code answers use Claude under your own account: the transcript text is sent, never the audio.") {
            SwitchRow("Summarize what colleagues say", "A one-line summary under each of their turns (Claude Haiku).",
                      isOn: m.bind(\.meetingSummarizeGuest) { Settings.meetingSummarizeGuest = $0 })
            Divider()
            SwitchRow("Summarize what you say", "A summary under your own turns too. Your words are always in the notes and the meeting summary.",
                      isOn: m.bind(\.meetingSummarizeYou) { Settings.meetingSummarizeYou = $0 })
            Divider()
            SwitchRow("Suggest replies", "When a colleague asks you something, three short replies appear once they've finished talking. Click to copy; nothing is sent.",
                      isOn: m.bind(\.meetingReplies) { Settings.meetingReplies = $0 })
            Divider()
            SwitchRow("Answer code questions from the project", "Questions like \"which endpoint handles refunds?\" are looked up in the project's code (read-only) and answered with file:line.",
                      isOn: m.bind(\.meetingCodeLookup) { Settings.meetingCodeLookup = $0 })
            Divider()
            SwitchRow("Record the meeting", "Keeps a recording of both sides on this Mac, to play back with the transcript.",
                      isOn: m.bind(\.meetingRecord) { Settings.meetingRecord = $0 })
        }
        Card("Privacy") {
            SwitchRow("Hide VisionCLI from screen sharing and recordings",
                      "The Meeting Notes panel, bubble, badge, Visi and VisionCLI's windows are left out when you share or record your screen. Some capture apps may still show them.",
                      isOn: m.bind(\.hideFromCapture) { Settings.hideFromCapture = $0 })
        }
    }
}

private struct IntegrationsPage: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        Card(footer: "Connecting adds VisionCLI's tools to that CLI for every project. Restart running sessions to load them.") {
            integration(.claude, install: "Install from claude.com/claude-code, then run claude once to sign in.")
            Divider()
            integration(.antigravity, install: "Install Antigravity from antigravity.google, then run agy once to sign in.")
            Divider()
            integration(.gemini, install: "Install with npm install -g @google/gemini-cli, then run gemini once to sign in.")
        }
        Card {
            Row("API keys", "TypeSafe (for Jev instant browser commands) and an optional Gemini API key, kept in integrations.json.") {
                Button("Edit API Keys…") { m.hooks.openIntegrations() }
            }
        }
    }

    private func integration(_ a: Assistant, install: String) -> some View {
        let installed = m.s.installed[a] == true
        let error = m.connectError[a]
        return Row(a.appName, installed ? error ?? (m.connected[a] == nil ? "Checking…" : nil) : install, detailColor: error == nil ? .secondary : .red) {
            if !installed {
                Text("Not installed").foregroundStyle(.secondary)
            } else if m.connecting.contains(a) {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Connecting…").foregroundStyle(.secondary) }
            } else if m.connected[a] == true {
                HStack(spacing: 10) {
                    Label("Tools connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    Button("Reconnect") { m.connect(a) }.help("Register the tools again, e.g. after moving the app or switching Node versions")
                }
            } else if m.connected[a] == false || error != nil {
                Button(error == nil ? "Connect" : "Try Again") { m.connect(a) }
            }
        }
    }
}

private struct AdvancedPage: View {
    @ObservedObject var m: SettingsModel

    var body: some View {
        Card {
            Row("Fix permissions", "If System Settings shows VisionCLI as allowed but it still asks or can't see the screen: clears VisionCLI's own entries so macOS asks again.") {
                Button("Fix Permissions…") { m.run(m.hooks.fixPermissions) }
            }
        }
        Card("Files") {
            Row("Log", "What VisionCLI did, for troubleshooting.") { Button("Open Log") { m.hooks.openLog() } }
            if m.s.crashLogExists {
                Divider()
                Row("Crash log", "Details of the last crash.") { Button("Open Crash Log") { m.hooks.openCrashLog() } }
            }
            Divider()
            Row("Home folder", "~/VisionCLI, where general questions (no project) run.") { Button("Show in Finder") { m.hooks.openHome() } }
        }
        Text("VisionCLI \(m.s.version) · MIT License · github.com/thethirdsourcers/visioncli")
            .font(.system(size: 11)).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 4)
    }
}

// MARK: Building blocks

/// A rounded group of rows, like a System Settings section, with an optional title above and note below.
private struct Card<Content: View>: View {
    let title: String?
    let footer: String?
    @ViewBuilder let content: Content

    init(_ title: String? = nil, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title { Text(title).font(.system(size: 13, weight: .semibold)).padding(.leading, 2) }
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(.horizontal, 12).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.035)))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.09), lineWidth: 1))
            if let footer {
                Text(footer).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.leading, 2)
            }
        }
    }
}

/// A title (and optional explanation) on the left, a control on the right.
private struct Row<Control: View>: View {
    let title: String
    let detail: String?
    var detailColor: Color = .secondary
    @ViewBuilder let control: Control

    init(_ title: String, _ detail: String?, detailColor: Color = .secondary, @ViewBuilder control: () -> Control) {
        self.title = title
        self.detail = detail
        self.detailColor = detailColor
        self.control = control()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13))
                if let detail, !detail.isEmpty {
                    Text(detail).font(.system(size: 11)).foregroundStyle(detailColor).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            control
        }
        .padding(.vertical, 8)
    }
}

private struct SwitchRow: View {
    let title: String
    let detail: String?
    let isOn: Binding<Bool>

    init(_ title: String, _ detail: String?, isOn: Binding<Bool>) {
        self.title = title
        self.detail = detail
        self.isOn = isOn
    }

    var body: some View {
        Row(title, detail) { Toggle("", isOn: isOn).toggleStyle(.switch).controlSize(.small).labelsHidden() }
    }
}

/// One choice of several, with a line explaining it (the setup wizard's radio rows).
private struct RadioRow: View {
    let title: String
    let detail: String?
    let selected: Bool
    var enabled = true
    let action: () -> Void

    init(_ title: String, _ detail: String?, selected: Bool, enabled: Bool = true, action: @escaping () -> Void) {
        self.title = title
        self.detail = detail
        self.selected = selected
        self.enabled = enabled
        self.action = action
    }

    var body: some View {
        Button { if enabled && !selected { action() } } label: {
            HStack(alignment: .top, spacing: 10) {
                RadioMark(selected: selected).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13)).foregroundStyle(enabled ? .primary : .secondary)
                    if let detail {
                        Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .disabled(!enabled)
    }
}

private struct RadioMark: View {
    let selected: Bool
    var body: some View {
        Image(systemName: selected ? "largecircle.fill.circle" : "circle")
            .font(.system(size: 14))
            .foregroundStyle(selected ? Color.accentColor : .secondary)
    }
}

/// A white SF Symbol on a colored rounded square, as in the System Settings sidebar.
private struct Tile: View {
    let symbol: String
    let tint: Color
    let size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.24)
            .fill(tint.gradient)
            .frame(width: size, height: size)
            .overlay(Image(systemName: symbol).font(.system(size: size * 0.55, weight: .medium)).foregroundStyle(.white))
    }
}

/// The model installer's progress line ("Downloading Kokoro voices… 42%").
private struct InstallProgress: View {
    let status: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ProgressView(value: SetupModel.percent(status))
            Text(status).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
    }
}

/// The translucent sidebar background System Settings uses.
private struct SidebarMaterial: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .sidebar
        v.blendingMode = .behindWindow
        v.state = .followsWindowActiveState
        return v
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}
