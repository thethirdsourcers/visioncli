import AppKit
import SwiftUI

// MARK: - Highlights drawn on the real screen

/// A drawing in AppKit global coordinates.
struct DrawItem {
    let kind: Mark.Kind
    let a: CGPoint
    let b: CGPoint
    let label: String
}

final class HighlightOverlay {
    private var panels: [NSPanel] = []
    private var hideWork: DispatchWorkItem?

    /// Boxes (AppKit global rects), e.g. the dashed outline of a selected area.
    func show(_ items: [(CGRect, String)], for seconds: Double = 12, persistent: Bool = false) {
        draw(items.map { DrawItem(kind: .box, a: CGPoint(x: $0.0.minX, y: $0.0.minY), b: CGPoint(x: $0.0.maxX, y: $0.0.maxY), label: $0.1) },
             for: seconds, persistent: persistent)
    }

    func draw(_ items: [DrawItem], for seconds: Double = 12, persistent: Bool = false) {
        hide()
        for screen in NSScreen.screens {
            // AppKit global → SwiftUI top-left local to this screen. An item belongs to the screen holding its midpoint.
            let local = items.filter {
                screen.frame.contains(CGPoint(x: ($0.a.x + $0.b.x) / 2, y: ($0.a.y + $0.b.y) / 2))
            }.map { item in
                DrawItem(kind: item.kind,
                         a: CGPoint(x: item.a.x - screen.frame.minX, y: screen.frame.maxY - item.a.y),
                         b: CGPoint(x: item.b.x - screen.frame.minX, y: screen.frame.maxY - item.b.y),
                         label: item.label)
            }
            guard !local.isEmpty else { continue }
            let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.ignoresMouseEvents = true
            panel.level = .statusBar
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.contentView = NSHostingView(rootView: HighlightView(items: local, dashed: persistent))
            panel.setFrame(screen.frame, display: true)
            panel.orderFrontRegardless()
            panels.append(panel)
        }
        if !persistent {
            let work = DispatchWorkItem { [weak self] in self?.hide() }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds + Double(items.count) * 0.35, execute: work)
        }
    }

    func hide() {
        hideWork?.cancel()
        panels.forEach { $0.orderOut(nil) }
        panels = []
    }
}

struct ArrowShape: Shape {
    let from: CGPoint
    let to: CGPoint
    func path(in _: CGRect) -> Path {
        var p = Path()
        p.move(to: from)
        p.addLine(to: to)
        let angle = atan2(to.y - from.y, to.x - from.x), head: CGFloat = 16, spread: CGFloat = .pi / 7
        p.move(to: to)
        p.addLine(to: CGPoint(x: to.x - head * cos(angle - spread), y: to.y - head * sin(angle - spread)))
        p.move(to: to)
        p.addLine(to: CGPoint(x: to.x - head * cos(angle + spread), y: to.y - head * sin(angle + spread)))
        return p
    }
}

/// One drawing, appearing after `delay` (so several play like someone explaining with a pen).
struct DrawingView: View {
    let item: DrawItem
    let delay: Double
    var dashed = false
    @State private var shown = false
    @State private var pulse = false

    private var rect: CGRect {
        CGRect(x: min(item.a.x, item.b.x), y: min(item.a.y, item.b.y), width: abs(item.b.x - item.a.x), height: abs(item.b.y - item.a.y))
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            switch item.kind {
            case .box:
                let r = rect.insetBy(dx: -4, dy: -4)
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(accent, style: StrokeStyle(lineWidth: 3, dash: dashed ? [8, 5] : []))
                    .shadow(color: .cyan.opacity(pulse ? 0.9 : 0.4), radius: pulse ? 12 : 5)
                    .frame(width: r.width, height: r.height)
                    .offset(x: r.minX, y: r.minY)
                    .scaleEffect(shown ? 1 : 1.08)
                    .opacity(shown ? 1 : 0)
                label(at: CGPoint(x: r.minX, y: max(0, r.minY - 28)))
            case .circle:
                let r = rect.insetBy(dx: -12, dy: -10)
                Ellipse()
                    .trim(from: 0, to: shown ? 1 : 0)
                    .stroke(accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .shadow(color: .pink.opacity(pulse ? 0.9 : 0.4), radius: pulse ? 12 : 5)
                    .frame(width: r.width, height: r.height)
                    .offset(x: r.minX, y: r.minY)
                label(at: CGPoint(x: r.minX, y: max(0, r.minY - 28)))
            case .arrow:
                ArrowShape(from: item.a, to: item.b)
                    .trim(from: 0, to: shown ? 1 : 0)
                    .stroke(LinearGradient(colors: [.cyan, .purple, .pink], startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                    .shadow(color: .purple.opacity(pulse ? 0.9 : 0.4), radius: pulse ? 10 : 4)
                // Label beside the middle of the arrow (its start often has a step badge).
                label(at: CGPoint(x: (item.a.x + item.b.x) / 2 + 12, y: max(0, (item.a.y + item.b.y) / 2 - 12)))
            case .step(let n):
                ZStack {
                    Circle().fill(LinearGradient(colors: [.cyan, .purple], startPoint: .topLeading, endPoint: .bottomTrailing))
                    Circle().stroke(Color.white.opacity(0.85), lineWidth: 2)
                    Text("\(n)").font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(.white)
                }
                .frame(width: 30, height: 30)
                .shadow(color: .cyan.opacity(pulse ? 0.9 : 0.5), radius: pulse ? 12 : 6)
                .scaleEffect(shown ? 1 : 0.3)
                .opacity(shown ? 1 : 0)
                .offset(x: item.a.x - 15, y: item.a.y - 15)
                label(at: CGPoint(x: item.a.x + 20, y: item.a.y - 12))
            }
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                withAnimation(.easeOut(duration: 0.55)) { shown = true }
                withAnimation(.easeInOut(duration: 0.9).repeatForever()) { pulse = true }
            }
        }
    }

    @ViewBuilder private func label(at p: CGPoint) -> some View {
        if !item.label.isEmpty {
            Text(item.label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Capsule().fill(bubbleFill))
                .overlay(Capsule().stroke(bubbleStroke))
                .fixedSize()
                .offset(x: p.x, y: p.y)
                .opacity(shown ? 1 : 0)
        }
    }
}

struct HighlightView: View {
    let items: [DrawItem]
    var dashed = false
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            ForEach(items.indices, id: \.self) { i in
                DrawingView(item: items[i], delay: Double(i) * 0.35, dashed: dashed)
            }
        }
        .ignoresSafeArea()
    }
}

// MARK: - Drag to select a region

final class SelectionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// The UI element under a point in whatever app owns that spot: a button, card or section, web pages included.
enum ElementPicker {
    private static let queue = DispatchQueue(label: "dev.visioncli.picker", qos: .userInteractive)
    private static var pending: CGPoint?
    private static var woken = Set<pid_t>()

    struct Picked { let rect: CGRect; let about: String } // top-left points; "button “Save” #save .btn"

    /// Calls back on main with the element under p (nil: nothing useful there). Latest point wins.
    static func element(at p: CGPoint, _ done: @escaping (Picked?) -> Void) {
        let busy = pending != nil
        pending = p
        guard !busy else { return }
        queue.async {
            var r: Picked?
            while true {
                let p: CGPoint? = DispatchQueue.main.sync { let q = pending; pending = nil; return q }
                guard let p else { break }
                r = frame(at: p)
            }
            DispatchQueue.main.async { done(r) }
        }
    }

    private static func frame(at p: CGPoint) -> Picked? {
        guard let win = Screen.windows().first(where: { $0.bounds.contains(p) }) else { return nil }
        let app = AXUIElementCreateApplication(win.pid)
        AXUIElementSetMessagingTimeout(app, 0.15)
        if woken.insert(win.pid).inserted {
            // Chrome/Brave and Electron apps only build the web page's tree when asked to.
            // (Not for other apps: it slows their window animations.)
            if ["google chrome", "brave browser", "microsoft edge", "arc", "chromium", "vivaldi", "opera"].contains(win.app.lowercased()) {
                AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            }
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        var hit: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(app, Float(p.x), Float(p.y), &hit)
        guard err == .success, var el = hit else { log("picker: no element in \(win.app) (\(err.rawValue))"); return nil }
        // Climb from bare text and tiny bits to the thing a person would point at (the link, button or card).
        for _ in 0..<6 {
            guard let r = rect(of: el) else { return nil }
            let role = attr(el, kAXRoleAttribute) as? String ?? ""
            let bare = ["AXStaticText", "AXImage", "AXUnknown", "AXInlineTextBox"].contains(role)
            if !bare && r.width >= 24 && r.height >= 16 { break }
            guard let parent = attr(el, kAXParentAttribute) else { break }
            el = parent as! AXUIElement
        }
        guard let r = rect(of: el) else { return nil }
        return Picked(rect: r.intersection(win.bounds), about: describe(el))
    }

    /// What Claude needs to find it in code: kind, visible text, and on web pages the DOM id and classes.
    private static func describe(_ el: AXUIElement) -> String {
        func text(_ name: String) -> String? {
            guard let s = attr(el, name) as? String else { return nil }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ")
            return t.isEmpty ? nil : String(t.prefix(80))
        }
        var parts = [text(kAXRoleDescriptionAttribute) ?? text(kAXRoleAttribute) ?? "element"]
        if let t = text(kAXTitleAttribute) ?? text(kAXDescriptionAttribute) ?? text(kAXValueAttribute) { parts.append("“\(t)”") }
        if let id = text("AXDOMIdentifier") { parts.append("#" + id) }
        if let classes = attr(el, "AXDOMClassList") as? [String], !classes.isEmpty { parts.append(classes.prefix(4).map { "." + $0 }.joined()) }
        return parts.joined(separator: " ")
    }

    private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    private static func rect(of el: AXUIElement) -> CGRect? {
        var pos = CGPoint.zero, size = CGSize.zero
        guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
              AXValueGetValue(p as! AXValue, .cgPoint, &pos), AXValueGetValue(s as! AXValue, .cgSize, &size),
              size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: pos, size: size)
    }
}

final class SelectionView: NSView {
    var onDone: (CGRect?) -> Void = { _ in }
    private var start: NSPoint?
    private var current: NSPoint?
    private var hovered: NSRect? // the element under the pointer, in view coordinates
    var hoveredAbout: String?
    var onPick: (String?) -> Void = { _ in } // what was picked, just before onDone (nil for a dragged area)
    var hoveredOnScreen: NSRect? { hovered.flatMap { h in window.map { $0.convertToScreen(h) } } }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.acceptsMouseMovedEvents = true
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseMoved(with e: NSEvent) {
        guard start == nil, let window else { return }
        let screen = window.convertPoint(toScreen: e.locationInWindow)
        ElementPicker.element(at: CGPoint(x: screen.x, y: Geometry.primaryHeight - screen.y)) { [weak self] r in
            guard let self, let window = self.window, self.start == nil else { return }
            let mine = r.map { window.convertFromScreen(Geometry.toAppKit($0.rect)) }
            self.hoveredAbout = r?.about
            if (mine == nil) != (self.hovered == nil) { log("picker: hover \(mine.map { "\(Int($0.width))x\(Int($0.height))" } ?? "lost")") }
            self.hovered = mine
            self.needsDisplay = true
        }
    }
    override func mouseExited(with e: NSEvent) { hovered = nil; needsDisplay = true }

    override func mouseDown(with e: NSEvent) { start = convert(e.locationInWindow, from: nil); current = start; needsDisplay = true }
    override func mouseDragged(with e: NSEvent) { current = convert(e.locationInWindow, from: nil); needsDisplay = true }
    override func mouseUp(with e: NSEvent) {
        current = convert(e.locationInWindow, from: nil)
        log("picker: mouse up, drag \(selection.map { "\(Int($0.width))x\(Int($0.height))" } ?? "none"), hovered \(hovered.map { "\(Int($0.width))x\(Int($0.height))" } ?? "none")")
        guard let window else { onDone(nil); return }
        if let r = selection, r.width > 8, r.height > 8 { onPick(nil); onDone(window.convertToScreen(r)); return } // AppKit global
        // A click (no drag) picks the element under the pointer.
        if let h = hovered { onPick(hoveredAbout); onDone(window.convertToScreen(h)); return }
        start = nil; current = nil; needsDisplay = true
    }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53 { onDone(nil) } }

    private var selection: NSRect? {
        guard let s = start, let c = current else { return nil }
        return NSRect(x: min(s.x, c.x), y: min(s.y, c.y), width: abs(s.x - c.x), height: abs(s.y - c.y))
    }

    override func draw(_ dirty: NSRect) {
        let path = NSBezierPath(rect: bounds)
        if let r = selection ?? hovered { path.append(NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4)) }
        path.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.28).setFill()
        path.fill()
        if let r = selection ?? hovered {
            let border = NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4)
            border.lineWidth = 2
            NSColor.systemCyan.setStroke()
            border.stroke()
        } else {
            let hint = "Click a part of the screen, or drag around it · keep talking · esc to cancel" as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: NSColor.white]
            let size = hint.size(withAttributes: attrs)
            hint.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.maxY - 90), withAttributes: attrs)
        }
    }
}

final class RegionSelector {
    private var panels: [SelectionPanel] = []
    private var completion: ((CGRect?) -> Void)?
    var isActive: Bool { !panels.isEmpty }

    /// Calls back with the selected rect in top-left points, or nil if cancelled.
    func begin(_ done: @escaping (CGRect?) -> Void) {
        cancel()
        picked = nil
        completion = done
        for screen in NSScreen.screens {
            let panel = SelectionPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let view = SelectionView(frame: NSRect(origin: .zero, size: screen.frame.size))
            view.onPick = { [weak self] in self?.picked = $0 }
            view.onDone = { [weak self] rect in self?.finish(rect.map(Geometry.toTopLeft)) }
            panel.contentView = view
            panel.setFrame(screen.frame, display: true)
            panel.orderFrontRegardless()
            panels.append(panel)
        }
        let p = NSEvent.mouseLocation
        if let under = panels.first(where: { NSMouseInRect(p, $0.frame, false) }) {
            under.makeKey()
            under.makeFirstResponder(under.contentView)
        }
    }

    func cancel() { finish(nil) }

    /// The element box under the pointer right now (top-left points), so letting go without a click still uses it.
    var hovered: CGRect? {
        for p in panels { if let v = p.contentView as? SelectionView, let r = v.hoveredOnScreen { picked = v.hoveredAbout; return Geometry.toTopLeft(r) } }
        return nil
    }
    /// The picked element's description, for the question ("button “Save” #save").
    private(set) var picked: String?

    private func finish(_ rect: CGRect?) {
        panels.forEach { $0.orderOut(nil) }
        panels = []
        let done = completion
        completion = nil
        done?(rect)
    }
}

// MARK: - Open a file:line in the right editor

enum Opener {
    static let jetbrains = ["phpstorm", "intellij idea", "idea", "webstorm", "pycharm", "goland", "rider", "clion", "rubymine", "datagrip", "android studio", "rustrover", "fleet"]

    /// Open path:line, preferring the editor the question was asked from.
    static func open(path: String, line: Int, project: String, preferredApp: WinInfo?) {
        DispatchQueue.global().async {
            guard let file = resolve(path, in: project) else {
                log("open: couldn't find \(path) in \(project)")
                return
            }
            let app = preferredApp?.app.lowercased() ?? ""
            if jetbrains.contains(where: { app.contains($0) }), let pid = preferredApp?.pid,
               let exe = NSRunningApplication(processIdentifier: pid)?.executableURL {
                shell(exe.path, ["--line", String(line), file])
            } else if app == "xcode" {
                shell("/usr/bin/xed", ["--line", String(line), file])
            } else if let scheme = ["code": "vscode", "visual studio code": "vscode", "cursor": "cursor", "windsurf": "windsurf"][app],
                      let url = URL(string: "\(scheme)://file\(file.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? file):\(line)") {
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            } else {
                DispatchQueue.main.async { NSWorkspace.shared.open(URL(fileURLWithPath: file)) }
            }
        }
    }

    private static func resolve(_ path: String, in project: String) -> String? {
        let fm = FileManager.default
        let candidates = path.hasPrefix("/") ? [path] : ["\(project)/\(path)"]
        if let hit = candidates.first(where: { fm.fileExists(atPath: $0) }) { return hit }
        // Claude sometimes cites just the file name; find it in the project.
        let (_, out, _) = shell("/usr/bin/find", [project, "-name", (path as NSString).lastPathComponent, "-not", "-path", "*/node_modules/*",
                                                  "-not", "-path", "*/vendor/*", "-not", "-path", "*/.git/*"])
        return out.split(separator: "\n").map(String.init).first { $0.hasSuffix(path) } ?? out.split(separator: "\n").first.map(String.init)
    }
}

// MARK: - Menu-bar icon

/// The logo as a monochrome template image: an eye whose pupil is a mouse pointer.
enum MenuIcon {
    /// The VisionCLI mark (docs/brand/mark.svg) as a menu-bar template: six aperture segments around a pupil.
    static func make() -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            NSColor.black.set()
            let c = NSPoint(x: 9, y: 9), r: CGFloat = 6.1
            let ring = NSBezierPath()
            ring.appendArc(withCenter: c, radius: r, startAngle: -70, endAngle: 290)
            ring.lineWidth = 2.3
            ring.lineCapStyle = .round
            // Six segments with visible gaps at 18 pt (the round caps eat into the gaps).
            let seg = 2 * .pi * r / 6
            ring.setLineDash([seg * 0.42, seg * 0.58], count: 2, phase: 0)
            ring.stroke()
            NSBezierPath(ovalIn: NSRect(x: c.x - 2.3, y: c.y - 2.3, width: 4.6, height: 4.6)).fill()
            return true
        }
        img.isTemplate = true
        return img
    }
}
