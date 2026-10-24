import AppKit
import Carbon.HIToolbox

// MARK: - Hotkeys (Carbon: no Accessibility permission needed)

enum HotKey: UInt32 { case talk = 1, point, dismiss, pin, open, allow, screen, meeting, fixError }

/// A key combination (Carbon key code and modifiers) with how it's shown, e.g. "⌥P".
struct Shortcut: Equatable {
    var code: Int
    var mods: Int
    var label: String

    /// The same modifiers as NSEvent flags (to check they're still held).
    var flags: NSEvent.ModifierFlags {
        var f: NSEvent.ModifierFlags = []
        if mods & controlKey != 0 { f.insert(.control) }
        if mods & optionKey != 0 { f.insert(.option) }
        if mods & shiftKey != 0 { f.insert(.shift) }
        if mods & cmdKey != 0 { f.insert(.command) }
        return f
    }

    static func symbols(_ mods: Int) -> String {
        (mods & controlKey != 0 ? "⌃" : "") + (mods & optionKey != 0 ? "⌥" : "") + (mods & shiftKey != 0 ? "⇧" : "") + (mods & cmdKey != 0 ? "⌘" : "")
    }
}

extension HotKey {
    /// The ones Settings → Shortcuts can change (⌃Space / Esc stay fixed).
    static let customizable: [HotKey] = [.point, .pin, .open, .allow, .fixError, .meeting]

    var title: String {
        switch self {
        case .point: return "Point at an area"
        case .pin: return "Pin the answer"
        case .open: return "Open the file in the answer"
        case .allow: return "Allow an action"
        case .fixError: return "Fix a spotted terminal error"
        case .meeting: return "Meeting Notes"
        default: return "\(self)"
        }
    }

    private var defaultShortcut: Shortcut {
        switch self {
        case .talk: return Shortcut(code: kVK_Space, mods: controlKey, label: "⌃Space")
        case .point: return Shortcut(code: kVK_Space, mods: optionKey | shiftKey, label: "⌥⇧Space")
        case .screen: return Shortcut(code: kVK_Space, mods: controlKey | optionKey, label: "⌃⌥Space")
        case .dismiss: return Shortcut(code: kVK_Escape, mods: 0, label: "esc")
        case .pin: return Shortcut(code: kVK_ANSI_P, mods: optionKey, label: "⌥P")
        case .open: return Shortcut(code: kVK_ANSI_O, mods: optionKey, label: "⌥O")
        case .allow: return Shortcut(code: kVK_Return, mods: optionKey, label: "⌥↩")
        case .meeting: return Shortcut(code: kVK_ANSI_R, mods: cmdKey | optionKey | shiftKey, label: "⌥⇧⌘R")
        case .fixError: return Shortcut(code: kVK_ANSI_E, mods: optionKey, label: "⌥E") // only while an error is offered
        }
    }

    /// The user's choice (Settings → Shortcuts), else the default. Stored as "code,mods,label".
    var shortcut: Shortcut {
        guard HotKey.customizable.contains(self), let s = UserDefaults.standard.string(forKey: "shortcut.\(rawValue)") else { return defaultShortcut }
        let f = s.split(separator: ",", maxSplits: 2).map(String.init)
        guard f.count == 3, let code = Int(f[0]), let mods = Int(f[1]) else { return defaultShortcut }
        return Shortcut(code: code, mods: mods, label: f[2])
    }

    func setShortcut(_ s: Shortcut?) {
        let key = "shortcut.\(rawValue)"
        if let s { UserDefaults.standard.set("\(s.code),\(s.mods),\(s.label)", forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        HotKeys.shared?.reload(self)
    }
}

/// The key held to talk: Option by default; with Command added, the question gets a screenshot (Option for ⌘ holders).
enum HoldKey: String, CaseIterable {
    case option, control, command

    static var current: HoldKey {
        get { UserDefaults.standard.string(forKey: "holdKey").flatMap(HoldKey.init) ?? .option }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "holdKey") }
    }

    var flag: NSEvent.ModifierFlags { self == .option ? .option : self == .control ? .control : .command }
    var screenFlags: NSEvent.ModifierFlags { self == .command ? [.command, .option] : [flag, .command] }
    var symbol: String { self == .option ? "⌥" : self == .control ? "⌃" : "⌘" }
    var screenSymbol: String { self == .command ? "⌥⌘" : "\(symbol)⌘" }
    var name: String { self == .option ? "Option" : self == .control ? "Control" : "Command" }
    /// Left and right key codes.
    var codes: [CGKeyCode] { self == .option ? [58, 61] : self == .control ? [59, 62] : [55, 54] }
}

final class HotKeys {
    static var handler: (HotKey, Bool) -> Void = { _, _ in }
    static weak var shared: HotKeys?
    private var refs: [HotKey: EventHotKeyRef] = [:]
    private let sig: OSType = 0x5643_4C49 // "VCLI"

    init() {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            if let key = HotKey(rawValue: id.id) {
                DispatchQueue.main.async { HotKeys.handler(key, pressed) }
            }
            return noErr
        }, types.count, &types, nil, nil)
        HotKeys.shared = self
        set(.point, true) // ⌥ / ⌥⌘ are held modifiers (ModifierHold); ⌃Space / ⌃⌥Space only without Accessibility
    }

    /// Esc, ⌥P, ⌥O and ⌥↩ are only grabbed while the overlay is visible, so they keep working in other apps otherwise.
    func set(_ key: HotKey, _ on: Bool) {
        if on, refs[key] == nil {
            let s = key.shortcut
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(UInt32(s.code), UInt32(s.mods), EventHotKeyID(signature: sig, id: key.rawValue),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs[key] = ref } else { log("couldn't register hotkey \(key): \(status)") }
        } else if !on, let ref = refs.removeValue(forKey: key) {
            UnregisterEventHotKey(ref)
        }
    }

    /// A changed shortcut takes effect at once if it's registered now.
    func reload(_ key: HotKey) {
        guard refs[key] != nil else { return }
        set(key, false)
        set(key, true)
    }
}

/// Hold-to-talk on modifier keys alone, like a dictation app's fn key: hold ⌥ to ask (text only), ⌥⌘ to ask with a
/// screenshot. Needs Accessibility (VisionCLI has it for computer control). Any other key or a click while holding
/// cancels it, so ⌃C, ⌃-click and friends keep working.
final class ModifierHold {
    var onChange: (HotKey, Bool) -> Void = { _, _ in }
    /// ⌘ added while ⌥ is already held: the question becomes a screenshot question.
    var onUpgrade: () -> Void = {}
    /// While listening, a press counts at once (the tap that sends the question).
    var immediate: () -> Bool = { false }
    private var monitors: [Any] = []
    private var pending: DispatchWorkItem?
    private var candidate: HotKey?
    private var active: HotKey?

    func start() {
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] e in self?.handle(e) }) { monitors.append(g) }
        if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] e in self?.handle(e); return e }) { monitors.append(l) }
    }

    private func handle(_ e: NSEvent) {
        if e.cgEvent?.getIntegerValueField(.eventSourceUserData) == FlowDictation.tag { return } // our own fake keys
        guard e.type == .flagsChanged else {
            cancel() // a shortcut (⌃C) or a ⌃-click, not a hold
            return
        }
        let flags = e.modifierFlags.intersection([.control, .option, .command, .shift])
        if let held = active {
            if !ModifierHold.keyDown { active = nil; onChange(held, false); return }
            if held == .talk, flags == HoldKey.current.screenFlags { active = .screen; onUpgrade() }
            return
        }
        let hold = HoldKey.current
        guard let key: HotKey = flags == [hold.flag] ? .talk : flags == hold.screenFlags ? .screen : nil else { cancel(); return }
        candidate = key
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let c = self.candidate else { return }
            self.candidate = nil
            self.active = c
            self.onChange(c, true)
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (immediate() ? 0 : 0.3), execute: work)
    }

    /// A ⌥ chord (⌥P, ⌥O, ⌥↩) was pressed: the ⌥ was part of a shortcut, not the start of a hold.
    func cancel() {
        pending?.cancel()
        pending = nil
        candidate = nil
    }

    /// The physical hold keys (left or right), unaffected by key events VisionCLI posts.
    static var keyDown: Bool {
        HoldKey.current.codes.contains { CGEventSource.keyState(.hidSystemState, key: $0) }
    }
}

/// The bubble panel. Click-through while following the pointer; interactive when pinned or asking approval.
final class OverlayPanel: NSPanel {
    var interactive = false
    override var canBecomeKey: Bool { interactive }
}
