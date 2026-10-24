import AppKit
import SwiftUI

enum Phase { case hidden, listening, thinking, answering, done, error, approval }

final class OverlayState: ObservableObject {
    @Published var phase: Phase = .hidden
    @Published var question = ""
    @Published var status = ""
    @Published var raw = "" { didSet { derived = nil } } // answer as streamed, with markers
    @Published var level: CGFloat = 0
    @Published var below = false        // bubble flipped under the pointer (no room above)
    @Published var pinned = false
    @Published var project = ""
    @Published var regionSelected = false
    @Published var screenshot = false   // this question gets a screenshot (shown under the live text)
    @Published var permission: PermissionRequest?
    @Published var toast = ""
    @Published var speaking = false
    /// Screenshots with the answer's drawings on them, shown in the bubble.
    @Published var annotated: [AnnotatedShot] = []

    /// Display text and segments, computed once per change of `raw` (the bubble's body runs far more often than that).
    private var derived: (answer: String, segments: [AnswerSegment])?
    /// Parsed markdown per text segment: while an answer streams only the last segment changes, the rest are reused.
    private var renderedCache: [String: AttributedString] = [:]

    var answer: String { derive().answer }
    var segments: [AnswerSegment] { derive().segments }

    private func derive() -> (answer: String, segments: [AnswerSegment]) {
        if let derived { return derived }
        let answer = Markup.display(raw)
        let d = (answer: answer, segments: Diagrams.segments(answer))
        derived = d
        let live = Set(d.segments.compactMap { if case .text(let t) = $0 { return t } else { return nil } })
        renderedCache = renderedCache.filter { live.contains($0.key) }
        return d
    }

    func rendered(_ text: String) -> AttributedString {
        if let a = renderedCache[text] { return a }
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var a = (try? AttributedString(markdown: Markup.linked(text), options: opts)) ?? AttributedString(text)
        for run in a.runs where run.link != nil {
            a[run.range].foregroundColor = .cyan
            a[run.range].underlineStyle = .single
        }
        renderedCache[text] = a
        return a
    }
}

/// Things the bubble's buttons can do (implemented by the app delegate).
protocol BubbleActions: AnyObject {
    func copyAnswer()
    func toggleSpeak()
    func showHistory()
    func dismiss()
    func togglePin()
    func openFirstReference()
    func approve(_ allow: Bool, always: Bool)
    func openLink(_ url: URL)
}

// MARK: - Pieces

let bubbleFill = Color(red: 0.09, green: 0.09, blue: 0.11).opacity(0.95)
let bubbleStroke = Color.white.opacity(0.12)
let accent = AngularGradient(colors: [.cyan, .blue, .purple, .pink, .cyan], center: .center)

/// The VisionCLI mark (docs/brand/mark.svg, as MenuIcon draws it): six aperture segments around a pupil.
struct LogoMark: View {
    var size: CGFloat
    var body: some View {
        let r = size * 6.1 / 18, seg = 2 * .pi * r / 6
        ZStack {
            Circle()
                .stroke(style: StrokeStyle(lineWidth: size * 2.3 / 18, lineCap: .round, dash: [seg * 0.42, seg * 0.58]))
                .frame(width: r * 2, height: r * 2)
                .rotationEffect(.degrees(-70))
            Circle().frame(width: size * 4.6 / 18, height: size * 4.6 / 18)
        }
        .frame(width: size, height: size)
    }
}

struct Spinner: View {
    var size: CGFloat = 22
    @State private var visible = false
    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.1), lineWidth: 2.5)
            // Only spins while its window is on screen (a hidden panel would keep animating).
            if visible { SpinnerArc() } else { SpinnerArc.arc }
            LogoMark(size: size * 0.5).foregroundStyle(.white.opacity(0.85))
        }
        .frame(width: size, height: size)
        .trackingWindowVisibility($visible)
    }
}

private struct SpinnerArc: View {
    @State private var spin = false
    static var arc: some View {
        Circle()
            .trim(from: 0, to: 0.72)
            .stroke(accent, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
    }
    var body: some View {
        Self.arc
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(.linear(duration: 0.85).repeatForever(autoreverses: false), value: spin)
            .onAppear { spin = true }
    }
}

struct LevelBars: View {
    var level: CGFloat
    private let weights: [CGFloat] = [0.5, 0.8, 1, 0.75, 0.45]
    var body: some View {
        HStack(spacing: 2.5) {
            ForEach(weights.indices, id: \.self) { i in
                Capsule()
                    .fill(LinearGradient(colors: [.cyan, .purple], startPoint: .bottom, endPoint: .top))
                    .frame(width: 3, height: 4 + 16 * min(1, level * weights[i]))
            }
        }
        .frame(height: 20)
        .animation(.easeOut(duration: 0.08), value: level)
    }
}

/// Small pill that rides next to the cursor while listening / thinking.
struct Pill<Leading: View>: View {
    let leading: Leading
    let text: String
    let placeholder: String
    var badge: String? = nil
    var badgeSymbol: String? = nil
    var body: some View {
        HStack(spacing: 9) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                Text(text.isEmpty ? placeholder : text)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(text.isEmpty ? .white.opacity(0.55) : .white)
                    .lineLimit(2)
                    .truncationMode(.head)
                    .frame(maxWidth: 300, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let badge, !badge.isEmpty {
                    HStack(spacing: 4) {
                        if let badgeSymbol { Image(systemName: badgeSymbol).font(.system(size: 9)) }
                        Text(badge).font(.system(size: 10))
                    }
                    .foregroundStyle(.white.opacity(0.4))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(bubbleFill))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(bubbleStroke))
        .fixedSize()
    }
}

struct Tail: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.midX, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
        p.closeSubpath()
        return p
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    var active = false
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(active ? .cyan : .white.opacity(hover ? 0.95 : 0.6))
                .frame(width: 24, height: 22)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(hover ? 0.1 : 0)))
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hover = $0 }
    }
}

// MARK: - Answer bubble

struct AnswerBubble: View {
    @ObservedObject var s: OverlayState
    weak var actions: BubbleActions?

    var header: some View {
        HStack(spacing: 7) {
            if s.phase == .answering { Spinner(size: 13) } else {
                if s.phase == .error {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(.orange)
                } else {
                    LogoMark(size: 12).foregroundStyle(.cyan)
                }
            }
            Text(s.question)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white.opacity(0.5))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            if !s.project.isEmpty {
                Text(s.project)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.white.opacity(0.45))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.08)))
            }
        }
    }

    /// Text and rendered mermaid diagrams, in order.
    var answerText: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(s.segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let t):
                    Text(s.rendered(t))
                        .font(.system(size: 13.5))
                        .foregroundStyle(.white.opacity(0.95))
                        .lineSpacing(2.5)
                        .tint(.cyan)
                        .frame(width: 420, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                case .mermaid(let code):
                    DiagramBlock(code: code)
                case .pendingDiagram:
                    PendingDiagram()
                }
            }
            ForEach(s.annotated) { shot in AnnotatedShotView(shot: shot) }
        }
    }

    var toolbar: some View {
        HStack(spacing: 2) {
            IconButton(symbol: "doc.on.doc", help: "Copy answer") { actions?.copyAnswer() }
            IconButton(symbol: s.speaking ? "speaker.wave.2.fill" : "speaker.wave.2", help: "Read aloud", active: s.speaking) { actions?.toggleSpeak() }
            IconButton(symbol: "clock.arrow.circlepath", help: "History") { actions?.showHistory() }
            Spacer()
            if !s.toast.isEmpty {
                Text(s.toast).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
            }
            if Markup.firstFileRef(s.answer) != nil {
                IconButton(symbol: "arrow.up.forward.square", help: "Open file (\(HotKey.open.shortcut.label))") { actions?.openFirstReference() }
            }
            IconButton(symbol: s.pinned ? "pin.slash" : "pin", help: s.pinned ? "Unpin (\(HotKey.pin.shortcut.label))" : "Pin (\(HotKey.pin.shortcut.label))", active: s.pinned) { actions?.togglePin() }
            IconButton(symbol: "xmark", help: "Close (esc)") { actions?.dismiss() }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                header
                // Scrolls in place (the panel takes the mouse while an answer shows); no need to pin first.
                // Full bubble width so the scroll bar sits on the right edge, with room beside the text for it.
                ScrollView(.vertical, showsIndicators: true) {
                    answerText.textSelection(.enabled)
                        .padding(.trailing, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                    .scrollIndicators(.visible)
                    .frame(maxWidth: .infinity, maxHeight: s.pinned ? 460 : 560)
                    .padding(.trailing, -10)
                    .environment(\.openURL, OpenURLAction { url in actions?.openLink(url); return .handled })
                if s.pinned || s.phase == .done || s.phase == .error {
                    Divider().overlay(Color.white.opacity(0.08))
                    toolbar
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(bubbleFill))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(s.pinned ? Color.cyan.opacity(0.35) : bubbleStroke))
            if !s.below && !s.pinned {
                Tail().fill(bubbleFill).frame(width: 16, height: 8)
            }
        }
        .fixedSize()
    }
}

// MARK: - Approval card

struct ApprovalCard: View {
    @ObservedObject var s: OverlayState
    weak var actions: BubbleActions?

    var body: some View {
        if let req = s.permission {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 7) {
                    Image(systemName: "hand.raised.fill").font(.system(size: 11)).foregroundStyle(.yellow)
                    Text(req.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    Spacer()
                    if !s.project.isEmpty { Text(s.project).font(.system(size: 10)).foregroundStyle(.white.opacity(0.4)) }
                }
                if let file = req.file {
                    Text(file).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.white.opacity(0.45)).lineLimit(1).truncationMode(.head)
                }
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(req.detail.enumerated()), id: \.offset) { _, line in
                        Text((line.1 == .added ? "+ " : line.1 == .removed ? "- " : "  ") + line.0)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(line.1 == .added ? Color.green : line.1 == .removed ? Color.red.opacity(0.9) : Color.white.opacity(0.8))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.35)))
                HStack(spacing: 8) {
                    Button { actions?.approve(true, always: false) } label: {
                        Text("Allow  \(HotKey.allow.shortcut.label)").font(.system(size: 12, weight: .semibold)).padding(.horizontal, 12).padding(.vertical, 5)
                            .background(Capsule().fill(Color.cyan.opacity(0.85))).foregroundStyle(.black)
                    }.buttonStyle(.plain)
                    Button { actions?.approve(true, always: true) } label: {
                        Text("Allow all this session").font(.system(size: 12)).padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Capsule().stroke(Color.white.opacity(0.25))).foregroundStyle(.white.opacity(0.85))
                    }.buttonStyle(.plain)
                    Spacer()
                    Button { actions?.approve(false, always: false) } label: {
                        Text("Deny  esc").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                    }.buttonStyle(.plain)
                }
            }
            .padding(14)
            .frame(width: 460)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(bubbleFill))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.yellow.opacity(0.35)))
            .fixedSize()
        }
    }
}

// MARK: - Root

struct OverlayView: View {
    @ObservedObject var s: OverlayState
    weak var actions: BubbleActions?

    var body: some View {
        Group {
            switch s.phase {
            case .hidden:
                Color.clear.frame(width: 1, height: 1)
            case .listening:
                Pill(leading: LevelBars(level: s.level), text: s.question,
                     placeholder: s.status.isEmpty ? "Listening…" : s.status,
                     badge: s.regionSelected ? "◻︎ area selected" : s.screenshot ? "with screenshot" : nil,
                     badgeSymbol: s.regionSelected ? nil : "camera")
            case .thinking:
                Pill(leading: Spinner(), text: s.status, placeholder: "Thinking…", badge: s.project.isEmpty ? nil : s.project)
            case .answering, .done, .error:
                AnswerBubble(s: s, actions: actions)
            case .approval:
                ApprovalCard(s: s, actions: actions)
            }
        }
        .padding(6) // room for anti-aliased edges and shadow
    }
}
