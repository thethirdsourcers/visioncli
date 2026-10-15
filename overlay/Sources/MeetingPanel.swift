import AppKit
import SwiftUI

// The Meeting Notes panel: the conversation as a chat (colleagues on the left, you on the right), a one-line summary
// under each turn, three reply chips under a colleague's question, and "From the code" answers. It never takes focus
// from the meeting app, so a chip's "Type" goes into whatever you were typing in.

final class MeetingPanel {
    private var panel: NSPanel?
    private let notes: MeetingNotes
    var stop: () -> Void = {}
    var projects: () -> [String] = { [] }
    var chooseFolder: () -> Void = {}

    init(notes: MeetingNotes) { self.notes = notes }

    var isVisible: Bool { panel?.isVisible ?? false }

    func show() {
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 620),
                            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                            backing: .buffered, defer: false)
            p.title = "Meeting Notes"
            p.isFloatingPanel = true
            p.level = .floating
            p.hidesOnDeactivate = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.minSize = NSSize(width: 320, height: 320)
            p.isReleasedWhenClosed = false
            let view = MeetingView(notes: notes, stop: { [weak self] in self?.stop() },
                                   projects: { [weak self] in self?.projects() ?? [] },
                                   chooseFolder: { [weak self] in self?.chooseFolder() })
            p.contentView = NSHostingView(rootView: view)
            let vf = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
            p.setFrame(NSRect(x: vf.maxX - 412, y: vf.minY + 12, width: 400, height: min(680, vf.height - 24)), display: false)
            panel = p
        }
        panel?.orderFrontRegardless()
    }

    func hide() { panel?.orderOut(nil) }
}

struct MeetingView: View {
    @ObservedObject var notes: MeetingNotes
    let stop: () -> Void
    let projects: () -> [String]
    let chooseFolder: () -> Void
    @State private var follow = true

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if !notes.isOn && (notes.audio != nil || notes.mixing) { PlayerBar(notes: notes); Divider() }
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if let overview = notes.overview { OverviewCard(text: overview).id("top") }
                        else if notes.finishing { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Writing the meeting summary…").font(.system(size: 12)).foregroundStyle(.secondary) } }
                        if notes.rows.isEmpty && notes.isOn {
                            Text("Listening… What your colleagues say (your Mac's sound) shows on the left, what you say (the microphone) on the right.\(notes.engine.isEmpty ? "" : "\nTranscribing with \(notes.engine).")")
                                .font(.system(size: 12)).foregroundStyle(.secondary).padding(.top, 30).frame(maxWidth: .infinity)
                                .multilineTextAlignment(.center)
                        }
                        ForEach(notes.rows) { row in
                            RowView(row: row, playing: notes.playingRow == row.id, play: notes.audio == nil || notes.isOn ? nil : { notes.seek(toRow: row.id) })
                        }
                        if notes.guestSpeaking || notes.youSpeaking { speaking }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(12)
                }
                .onChange(of: notes.rows) { _ in if follow && notes.isOn { withAnimation(.easeOut(duration: 0.2)) { reader.scrollTo("end") } } }
                .onChange(of: notes.playingRow) { id in if follow, let id { withAnimation { reader.scrollTo(id, anchor: .center) } } }
                .onChange(of: notes.overview) { _ in if notes.overview != nil { withAnimation { reader.scrollTo("top", anchor: .top) } } }
            }
        }
        .frame(minWidth: 320, minHeight: 320)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if notes.isOn {
                Circle().fill(Color.red).frame(width: 8, height: 8)
                if let started = notes.startedAt {
                    TimelineView(.periodic(from: started, by: 1)) { ctx in
                        Text(Self.elapsed(ctx.date.timeIntervalSince(started))).font(.system(size: 12, weight: .medium).monospacedDigit())
                    }
                }
            } else {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Ended").font(.system(size: 12, weight: .medium))
            }
            Menu {
                ForEach(projects(), id: \.self) { p in
                    Button((p as NSString).lastPathComponent) { notes.project = p }
                }
                Divider()
                Button("Choose Folder…", action: chooseFolder)
            } label: {
                Label(notes.project.isEmpty || notes.project == HomeProject.path ? "No project" : (notes.project as NSString).lastPathComponent,
                      systemImage: "folder")
                    .font(.system(size: 11))
            }
            .menuStyle(.borderlessButton).fixedSize()
            .help("Code questions are looked up in this project")
            if notes.isOn && !notes.engine.isEmpty {
                Image(systemName: "waveform").font(.system(size: 11)).foregroundStyle(.secondary).help("Transcribing with \(notes.engine)")
            }
            Spacer()
            Button { follow.toggle() } label: { Image(systemName: follow ? "arrow.down.to.line.compact" : "pause") }
                .buttonStyle(.borderless).help(follow ? "Following the conversation" : "Not scrolling")
            if notes.isOn {
                Button("Stop", action: stop).controlSize(.small)
            } else if let file = notes.file {
                Button("Open Notes") { NSWorkspace.shared.open(file) }.controlSize(.small)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private var speaking: some View {
        HStack {
            if notes.youSpeaking { Spacer() }
            HStack(spacing: 6) {
                PulsingDots()
                Text(notes.guestSpeaking ? "Guest is speaking" : "You're speaking").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            if notes.guestSpeaking { Spacer() }
        }
    }

    static func elapsed(_ s: TimeInterval) -> String {
        let t = Int(s)
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
}

private struct PlayerBar: View {
    @ObservedObject var notes: MeetingNotes

    var body: some View {
        HStack(spacing: 8) {
            if notes.mixing {
                ProgressView().controlSize(.small)
                Text("Saving the recording…").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
            } else {
                Button { notes.togglePlay() } label: { Image(systemName: notes.playing ? "pause.fill" : "play.fill").frame(width: 16) }
                    .buttonStyle(.borderless)
                Slider(value: Binding(get: { notes.playTime }, set: { notes.seek($0) }), in: 0...max(1, notes.duration))
                    .controlSize(.small)
                Text("\(MeetingView.elapsed(notes.playTime)) / \(MeetingView.elapsed(notes.duration))")
                    .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }
}

private struct RowView: View {
    let row: MeetingRow
    var playing = false
    var play: (() -> Void)?
    private var guest: Bool { row.speaker == .guest }

    var body: some View {
        HStack(alignment: .top) {
            if !guest { Spacer(minLength: 40) }
            VStack(alignment: guest ? .leading : .trailing, spacing: 4) {
                HStack(spacing: 4) {
                    Text("\(row.speaker.rawValue) · \(MeetingAI.timeFormat.string(from: row.start))")
                        .font(.system(size: 10, weight: .medium)).foregroundStyle(playing ? Color.accentColor : .secondary)
                    if let play {
                        Button(action: play) { Image(systemName: playing ? "speaker.wave.2.fill" : "play.circle").font(.system(size: 10)) }
                            .buttonStyle(.borderless).help("Play from here")
                    }
                }
                Text(row.text)
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(guest ? Color.secondary.opacity(0.15) : Color.accentColor.opacity(0.85)))
                    .foregroundStyle(guest ? Color.primary : Color.white)
                    .opacity(row.open ? 0.75 : 1)
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.accentColor, lineWidth: playing ? 2 : 0))
                if let s = row.summary {
                    Label(s, systemImage: "text.alignleft").font(.system(size: 11)).foregroundStyle(.secondary)
                } else if row.summarizing {
                    Text("Summarizing…").font(.system(size: 11)).foregroundStyle(.tertiary)
                }
                if guest && (row.repliesLoading || !row.replies.isEmpty) {
                    VStack(alignment: .leading, spacing: 5) {
                        if row.repliesLoading { ForEach(0..<3, id: \.self) { i in ShimmerChip(width: [190, 150, 220][i]) } }
                        else { ForEach(row.replies, id: \.self) { ReplyChip(text: $0) } }
                    }
                    .padding(.top, 2)
                }
                if let lookup = row.lookup { LookupCard(lookup: lookup) }
            }
            if guest { Spacer(minLength: 40) }
        }
    }
}

/// A suggested reply: click copies it; "Type" types it where you're typing (never sent).
private struct ReplyChip: View {
    let text: String
    @State private var copied = false
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: copied ? "checkmark" : "arrowshape.turn.up.left").font(.system(size: 10))
                    Text(copied ? "Copied" : text).font(.system(size: 12)).multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Capsule().stroke(Color.accentColor.opacity(hover ? 0.9 : 0.5)))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("Copy")
            if hover {
                Button { Computer.type(text) } label: { Image(systemName: "keyboard").font(.system(size: 11)) }
                    .buttonStyle(.borderless).help("Type it where you're typing (not sent)")
            }
        }
        .onHover { hover = $0 }
    }
}

private struct ShimmerChip: View {
    let width: CGFloat
    @State private var on = false

    var body: some View {
        Capsule().fill(Color.secondary.opacity(on ? 0.25 : 0.1)).frame(width: width, height: 24)
            .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { on = true } }
    }
}

private struct LookupCard: View {
    let lookup: MeetingRow.Lookup

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("From the code", systemImage: "chevron.left.forwardslash.chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            switch lookup {
            case .looking: HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Looking in the project…").font(.system(size: 11)).foregroundStyle(.secondary) }
            case .failed: Text("Couldn't find it in the code.").font(.system(size: 11)).foregroundStyle(.secondary)
            case .found(let answer): Text(answer).font(.system(size: 12)).textSelection(.enabled)
            }
        }
        .padding(8)
        .frame(maxWidth: 300, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.green.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.green.opacity(0.3)))
    }
}

private struct OverviewCard: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Meeting summary", systemImage: "list.bullet.rectangle").font(.system(size: 12, weight: .semibold))
            ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                let l = String(line)
                if l.hasPrefix("#") {
                    Text(l.trimmingCharacters(in: CharacterSet(charactersIn: "# "))).font(.system(size: 12, weight: .semibold)).padding(.top, 4)
                } else if !l.trimmingCharacters(in: .whitespaces).isEmpty {
                    // Inline Markdown only (bold, code); list markers become bullets.
                    let item = l.range(of: #"^\s*[-*•]\s+"#, options: .regularExpression)
                    let body = item.map { String(l[$0.upperBound...]) } ?? l
                    Text((item == nil ? "" : "•  ") + ((try? AttributedString(markdown: body)) ?? AttributedString(body)))
                        .font(.system(size: 12)).textSelection(.enabled)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
    }
}

private struct PulsingDots: View {
    @State private var on = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { i in
                Circle().fill(Color.secondary).frame(width: 5, height: 5)
                    .opacity(on ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.5).repeatForever().delay(Double(i) * 0.15), value: on)
            }
        }
        .onAppear { on = true }
    }
}
