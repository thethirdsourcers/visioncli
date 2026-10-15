import AppKit
import SwiftUI

// SwiftUI keeps running repeatForever / TimelineView animations in windows that are only ordered out, which costs CPU
// while nothing is on screen. Views that animate forever check whether their window is actually visible.

extension View {
    /// Keeps `visible` in sync with whether the view's window is on screen (ordered in and not fully covered).
    func trackingWindowVisibility(_ visible: Binding<Bool>) -> some View {
        background(WindowVisibilityReader(visible: visible).frame(width: 0, height: 0))
    }
}

private struct WindowVisibilityReader: NSViewRepresentable {
    @Binding var visible: Bool

    func makeNSView(context: Context) -> ProbeView {
        let v = ProbeView()
        v.onChange = { visible = $0 }
        return v
    }

    func updateNSView(_ v: ProbeView, context: Context) {
        v.onChange = { visible = $0 }
    }

    final class ProbeView: NSView {
        var onChange: (Bool) -> Void = { _ in }
        private var observer: NSObjectProtocol?
        private var last: Bool?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard let window else { report(false); return }
            observer = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification,
                                                              object: window, queue: .main) { [weak self] _ in self?.check() }
            check()
        }

        private func check() {
            guard let window else { report(false); return }
            report(window.isVisible && window.occlusionState.contains(.visible))
        }

        /// Deferred: this can run while SwiftUI is updating views, where state mustn't change.
        private func report(_ on: Bool) {
            guard on != last else { return }
            last = on
            DispatchQueue.main.async { [weak self] in
                guard let self, self.last == on else { return }
                self.onChange(on)
            }
        }

        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }
}

/// "Hide VisionCLI from screen sharing and recordings": every window the app shows gets `sharingType = .none`
/// (`.readOnly` when off). Windows are made in many places and some only once shown, so instead of touching each,
/// this re-applies the setting whenever any window updates, appears or becomes key, plus a pass when it changes.
enum CaptureHiding {
    private static var observers: [NSObjectProtocol] = []

    static var desired: NSWindow.SharingType { Settings.hideFromCapture ? .none : .readOnly }

    static func start() {
        guard observers.isEmpty else { return }
        let nc = NotificationCenter.default
        for name in [NSWindow.didUpdateNotification, NSWindow.didChangeOcclusionStateNotification, NSWindow.didBecomeKeyNotification] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { n in
                if let w = n.object as? NSWindow { apply(w) }
            })
        }
        applyAll()
    }

    static func apply(_ w: NSWindow) {
        let want = desired
        if w.sharingType != want { w.sharingType = want }
    }

    static func applyAll() { NSApp?.windows.forEach(apply) }
}
