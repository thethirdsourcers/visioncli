import AppKit
import Carbon.HIToolbox

// MARK: - Hotkeys (Carbon: no Accessibility permission needed)

enum HotKey: UInt32 { case talk = 1, point, dismiss, pin, open, allow, screen, meeting }

final class HotKeys {
    static var handler: (HotKey, Bool) -> Void = { _, _ in }
    private var refs: [HotKey: EventHotKeyRef] = [:]
    private let sig: OSType = 0x5643_4C49 // "VCLI"

    private static let combos: [HotKey: (Int, Int)] = [
        .talk: (kVK_Space, controlKey),
        .point: (kVK_Space, optionKey | shiftKey),
        .screen: (kVK_Space, controlKey | optionKey),
        .dismiss: (kVK_Escape, 0),
        .pin: (kVK_ANSI_P, optionKey),
        .open: (kVK_ANSI_O, optionKey),
        .allow: (kVK_Return, optionKey),
        .meeting: (kVK_ANSI_R, cmdKey | optionKey | shiftKey),
    ]

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
        set(.point, true) // ⌥ / ⌥⌘ are held modifiers (ModifierHold); ⌃Space / ⌃⌥Space only without Accessibility
    }

    /// Esc, ⌥P, ⌥O and ⌥↩ are only grabbed while the overlay is visible, so they keep working in other apps otherwise.
    func set(_ key: HotKey, _ on: Bool) {
        if on, refs[key] == nil, let (code, mods) = HotKeys.combos[key] {
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(UInt32(code), UInt32(mods), EventHotKeyID(signature: sig, id: key.rawValue),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref { refs[key] = ref } else { log("couldn't register hotkey \(key): \(status)") }
        } else if !on, let ref = refs.removeValue(forKey: key) {
            UnregisterEventHotKey(ref)
        }
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
            if held == .talk, flags == [.option, .command] { active = .screen; onUpgrade() }
            return
        }
        guard let key: HotKey = flags == [.option] ? .talk : flags == [.option, .command] ? .screen : nil else { cancel(); return }
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

    /// The physical Option keys (left or right), unaffected by key events VisionCLI posts.
    static var keyDown: Bool {
        CGEventSource.keyState(.hidSystemState, key: 58) || CGEventSource.keyState(.hidSystemState, key: 61)
    }
}

/// The bubble panel. Click-through while following the pointer; interactive when pinned or asking approval.
final class OverlayPanel: NSPanel {
    var interactive = false
    override var canBecomeKey: Bool { interactive }
}
