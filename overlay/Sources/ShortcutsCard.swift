import AppKit
import Carbon.HIToolbox
import SwiftUI

/// Settings → General: the hold-to-talk key and VisionCLI's key combinations, each changeable by pressing a new one.
struct ShortcutsCard: View {
    @State private var hold = HoldKey.current
    @State private var recording: HotKey?
    @State private var monitor: Any?
    @State private var note = ""
    @State private var version = 0 // bumped after a change, to redraw the labels

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Shortcuts").font(.system(size: 13, weight: .semibold)).padding(.leading, 2)
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Hold to talk").font(.system(size: 13))
                        Text("Hold it, ask, let go. Add \(hold == .command ? "Option" : "Command") for a screenshot (\(hold.screenSymbol)).")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Picker("", selection: $hold) {
                        ForEach(HoldKey.allCases, id: \.self) { Text("\($0.symbol) \($0.name)").tag($0) }
                    }
                    .labelsHidden().fixedSize()
                    .onChange(of: hold) { HoldKey.current = $0 }
                }
                .padding(.vertical, 8)
                ForEach(HotKey.customizable, id: \.self) { key in
                    Divider()
                    HStack {
                        Text(key.title).font(.system(size: 13))
                        Spacer()
                        Button(recording == key ? "Press keys…" : key.shortcut.label) { record(key) }
                            .font(.system(size: 12, weight: .medium).monospaced()).frame(minWidth: 90)
                        Button { key.setShortcut(nil); version += 1 } label: { Image(systemName: "arrow.uturn.backward") }
                            .buttonStyle(.borderless).help("Back to the default")
                    }
                    .padding(.vertical, 6)
                    .id("\(key.rawValue)-\(version)")
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.035)))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.09), lineWidth: 1))
            Text(note.isEmpty ? "Click a shortcut, then press the new keys (with ⌃, ⌥ or ⌘). Esc cancels." : note)
                .font(.system(size: 11)).foregroundStyle(note.isEmpty ? Color.secondary : Color.orange).padding(.leading, 2)
        }
        .onDisappear { stopRecording() }
    }

    private func record(_ key: HotKey) {
        stopRecording()
        recording = key
        note = ""
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            defer { stopRecording() }
            if e.keyCode == UInt16(kVK_Escape) { return nil }
            let f = e.modifierFlags
            var mods = 0
            if f.contains(.control) { mods |= controlKey }
            if f.contains(.option) { mods |= optionKey }
            if f.contains(.shift) { mods |= shiftKey }
            if f.contains(.command) { mods |= cmdKey }
            guard mods & (controlKey | optionKey | cmdKey) != 0 else { note = "Use ⌃, ⌥ or ⌘ with the key, so it doesn't stop you typing."; return nil }
            let new = Shortcut(code: Int(e.keyCode), mods: mods, label: Shortcut.symbols(mods) + Self.keyName(e))
            if let other = HotKey.customizable.first(where: { $0 != key && $0.shortcut.code == new.code && $0.shortcut.mods == new.mods }) {
                note = "\(new.label) is already used for “\(other.title)”."
                return nil
            }
            key.setShortcut(new)
            version += 1
            return nil
        }
    }

    private func stopRecording() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        recording = nil
    }

    static func keyName(_ e: NSEvent) -> String {
        switch Int(e.keyCode) {
        case kVK_Space: return "Space"
        case kVK_Return: return "↩"
        case kVK_Tab: return "⇥"
        case kVK_Delete: return "⌫"
        case kVK_UpArrow: return "↑"
        case kVK_DownArrow: return "↓"
        case kVK_LeftArrow: return "←"
        case kVK_RightArrow: return "→"
        default: return (e.charactersIgnoringModifiers ?? "?").uppercased()
        }
    }
}
