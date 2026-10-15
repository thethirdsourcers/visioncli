import AppKit
import SwiftUI

/// A small floating pill at the top of the screen the pointer is on, so it's always obvious when VisionCLI is looking at
/// the screen (a screenshot) or using the computer. While it's using the computer the edges
/// of that screen also glow. Click-through, and never in screenshots (FastCapture excludes our own windows).
final class ActivityBadge {
    static let shared = ActivityBadge()

    private let model = BadgeModel()
    private var pill: NSPanel?
    private var glow: NSPanel?
    private var hideWork: DispatchWorkItem?
    private var glowWork: DispatchWorkItem?

    /// Shows `text` with an SF Symbol for `seconds`; a later call replaces it.
    func show(_ icon: String, _ text: String, tint: Color = .cyan, seconds: Double = 2.5) {
        DispatchQueue.main.async { [self] in
            model.icon = icon
            model.text = text
            model.tint = tint
            let p = pill ?? makePill()
            pill = p
            let screen = Self.pointerScreen
            let size = p.contentView?.fittingSize ?? CGSize(width: 240, height: 36)
            let vf = screen.visibleFrame
            p.setFrame(NSRect(x: vf.midX - size.width / 2, y: vf.maxY - size.height - 6, width: size.width, height: size.height), display: true)
            if !p.isVisible {
                p.alphaValue = 0
                p.orderFrontRegardless()
            }
            model.pillShown = true
            NSAnimationContext.runAnimationGroup { $0.duration = 0.15; p.animator().alphaValue = 1 }
            hideWork?.cancel()
            let w = DispatchWorkItem { [weak self] in
                guard let p = self?.pill else { return }
                NSAnimationContext.runAnimationGroup({ $0.duration = 0.3; p.animator().alphaValue = 0 }) {
                    guard p.alphaValue < 0.01 else { return } // shown again while fading out
                    p.orderOut(nil)
                    self?.model.pillShown = false
                }
            }
            hideWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
        }
    }

    /// Glows the edges of the pointer's screen; each call keeps it on a few more seconds.
    func controlling(seconds: Double = 4) {
        DispatchQueue.main.async { [self] in
            let screen = Self.pointerScreen
            let g = glow ?? makeGlow()
            glow = g
            g.setFrame(screen.frame, display: true)
            g.contentView?.frame = NSRect(origin: .zero, size: screen.frame.size)
            if !g.isVisible { g.alphaValue = 0; g.orderFrontRegardless() }
            model.glowShown = true
            NSAnimationContext.runAnimationGroup { $0.duration = 0.25; g.animator().alphaValue = 1 }
            glowWork?.cancel()
            let w = DispatchWorkItem { [weak self] in
                guard let g = self?.glow else { return }
                NSAnimationContext.runAnimationGroup({ $0.duration = 0.4; g.animator().alphaValue = 0 }) {
                    guard g.alphaValue < 0.01 else { return } // shown again while fading out
                    g.orderOut(nil)
                    self?.model.glowShown = false
                }
            }
            glowWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
        }
    }

    private static var pointerScreen: NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func panel(_ rect: NSRect) -> NSPanel {
        let p = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.ignoresMouseEvents = true
        p.hasShadow = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        return p
    }

    private func makePill() -> NSPanel {
        let p = panel(NSRect(x: 0, y: 0, width: 240, height: 36))
        let host = NSHostingView(rootView: BadgeView(m: model))
        host.sizingOptions = [.intrinsicContentSize]
        p.contentView = host
        return p
    }

    private func makeGlow() -> NSPanel {
        let p = panel(Self.pointerScreen.frame)
        p.contentView = NSHostingView(rootView: GlowView(m: model))
        return p
    }
}

final class BadgeModel: ObservableObject {
    @Published var icon = "eye"
    @Published var text = ""
    @Published var tint: Color = .cyan
    /// Whether each panel is on screen: the pulse and glow animate only then (SwiftUI keeps animating hidden windows).
    @Published var pillShown = false
    @Published var glowShown = false
}

private struct BadgeView: View {
    @ObservedObject var m: BadgeModel

    var body: some View {
        HStack(spacing: 7) {
            ZStack {
                if m.pillShown { Pulse(tint: m.tint) } else { Pulse.dot(m.tint, pulse: false) }
                Image(systemName: m.icon).font(.system(size: 11, weight: .bold)).foregroundStyle(m.tint)
            }
            Text(m.text).font(.system(size: 12, weight: .medium)).foregroundStyle(.white).lineLimit(1)
        }
        .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 5)
        .background(Capsule().fill(Color.black.opacity(0.82)))
        .overlay(Capsule().stroke(m.tint.opacity(0.45)))
        .padding(4)
        .fixedSize()
    }
}

/// The pill's pulsing dot; removed while the pill is hidden, which stops the animation.
private struct Pulse: View {
    let tint: Color
    @State private var pulse = false

    static func dot(_ tint: Color, pulse: Bool) -> some View {
        Circle().fill(tint.opacity(0.35)).frame(width: 22, height: 22)
            .scaleEffect(pulse ? 1.25 : 0.85).opacity(pulse ? 0.2 : 0.8)
    }

    var body: some View {
        Self.dot(tint, pulse: pulse)
            .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { pulse = true } }
    }
}

private struct GlowView: View {
    @ObservedObject var m: BadgeModel

    var body: some View {
        if m.glowShown { GlowEdges() } else { Color.clear }
    }
}

private struct GlowEdges: View {
    @State private var phase = false

    var body: some View {
        RoundedRectangle(cornerRadius: 12)
            .strokeBorder(LinearGradient(colors: [.cyan, .purple, .cyan], startPoint: phase ? .topLeading : .bottomTrailing,
                                         endPoint: phase ? .bottomTrailing : .topLeading), lineWidth: 5)
            .blur(radius: 6)
            .opacity(phase ? 0.95 : 0.55)
            .onAppear { withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { phase = true } }
    }
}
