import AppKit
import SwiftUI

// ⇧⌥⌘R: a card in the middle of the screen to start Meeting Notes, with its options (the same ones as in Settings)
// and the project code questions are looked up in. While a meeting runs, the same shortcut offers Stop and the panel.

final class MeetingLauncherModel: ObservableObject {
    @Published var summarizeGuest = Settings.meetingSummarizeGuest { didSet { Settings.meetingSummarizeGuest = summarizeGuest } }
    @Published var summarizeYou = Settings.meetingSummarizeYou { didSet { Settings.meetingSummarizeYou = summarizeYou } }
    @Published var replies = Settings.meetingReplies { didSet { Settings.meetingReplies = replies } }
    @Published var codeLookup = Settings.meetingCodeLookup { didSet { Settings.meetingCodeLookup = codeLookup } }
    @Published var record = Settings.meetingRecord { didSet { Settings.meetingRecord = record } }
    @Published var hide = Settings.hideFromCapture { didSet { Settings.hideFromCapture = hide } }
    @Published var project = ""
    @Published var projects: [String] = []
    @Published var running = false
    @Published var startedAt: Date?

    /// Re-read when shown: Settings may have changed them meanwhile.
    func reload() {
        summarizeGuest = Settings.meetingSummarizeGuest
        summarizeYou = Settings.meetingSummarizeYou
        replies = Settings.meetingReplies
        codeLookup = Settings.meetingCodeLookup
        record = Settings.meetingRecord
        hide = Settings.hideFromCapture
    }
}

/// Borderless panels can't take keys by default; this one needs ⏎ and Esc.
private final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class MeetingLauncher {
    let model = MeetingLauncherModel()
    private var panel: NSPanel?
    var start: () -> Void = {}
    var stop: () -> Void = {}
    var showNotes: () -> Void = {}
    var chooseFolder: (@escaping (String) -> Void) -> Void = { _ in }

    var isVisible: Bool { panel?.isVisible ?? false }

    func show() {
        model.reload()
        if panel == nil {
            let p = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 420), styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
            p.isFloatingPanel = true
            p.level = .floating
            p.backgroundColor = .clear
            p.isOpaque = false
            p.hasShadow = true
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.hidesOnDeactivate = false
            let view = MeetingLauncherView(m: model,
                                           start: { [weak self] in self?.hide(); self?.start() },
                                           stop: { [weak self] in self?.hide(); self?.stop() },
                                           showNotes: { [weak self] in self?.hide(); self?.showNotes() },
                                           cancel: { [weak self] in self?.hide() },
                                           chooseFolder: { [weak self] in
                                               self?.chooseFolder { path in self?.model.project = path }
                                           })
            let host = NSHostingView(rootView: view)
            host.sizingOptions = [.intrinsicContentSize]
            p.contentView = host
            panel = p
        }
        guard let panel else { return }
        DispatchQueue.main.async {
            let size = panel.contentView?.fittingSize ?? CGSize(width: 380, height: 420)
            let mouse = NSEvent.mouseLocation
            let vf = (NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens[0]).visibleFrame
            panel.setFrame(NSRect(x: vf.midX - size.width / 2, y: vf.midY - size.height / 2 + vf.height * 0.08,
                                  width: size.width, height: size.height), display: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    func hide() { panel?.orderOut(nil) }
}

struct MeetingLauncherView: View {
    @ObservedObject var m: MeetingLauncherModel
    let start: () -> Void
    let stop: () -> Void
    let showNotes: () -> Void
    let cancel: () -> Void
    let chooseFolder: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(Color.red.opacity(0.18)).frame(width: 44, height: 44)
                    Circle().fill(Color.red).frame(width: 16, height: 16)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.running ? "Meeting Notes is on" : "Start Meeting Notes").font(.system(size: 17, weight: .semibold))
                    if m.running, let started = m.startedAt {
                        TimelineView(.periodic(from: started, by: 1)) { ctx in
                            Text("Recording · \(MeetingView.elapsed(ctx.date.timeIntervalSince(started)))")
                                .font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
                        }
                    } else {
                        Text("Your colleagues (your Mac's sound) and you (the microphone), transcribed on this Mac.")
                            .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            if !m.running {
                VStack(alignment: .leading, spacing: 7) {
                    Toggle("Summarize what colleagues say", isOn: $m.summarizeGuest)
                    Toggle("Summarize what you say", isOn: $m.summarizeYou)
                    Toggle("Suggest replies when you're asked something", isOn: $m.replies)
                    Toggle("Answer code questions from the project", isOn: $m.codeLookup)
                    Toggle("Record the meeting", isOn: $m.record)
                    Toggle("Hide VisionCLI from screen sharing", isOn: $m.hide)
                }
                .toggleStyle(.switch).controlSize(.mini).font(.system(size: 12.5))

                HStack(spacing: 6) {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                    Menu {
                        ForEach(m.projects, id: \.self) { p in Button((p as NSString).lastPathComponent) { m.project = p } }
                        Divider()
                        Button("Choose Folder…", action: chooseFolder)
                    } label: {
                        Text(m.project.isEmpty || m.project == HomeProject.path ? "No project" : (m.project as NSString).lastPathComponent)
                    }
                    .menuStyle(.borderlessButton).fixedSize()
                    Text("for code questions").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                .font(.system(size: 12))

                Text("Where the law or your company's rules require it, tell the people in the meeting.")
                    .font(.system(size: 10.5)).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Text(m.running ? "⇧⌥⌘R" : "⏎ to start · Esc to cancel").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                if m.running {
                    Button("Stop", action: stop)
                    Button("Show Notes", action: showNotes).keyboardShortcut(.defaultAction)
                } else {
                    Button("Start", action: start).keyboardShortcut(.defaultAction)
                }
            }
            .controlSize(.regular)
        }
        .padding(18)
        .frame(width: 380, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.primary.opacity(0.08)))
        .padding(6)
        .fixedSize()
    }
}
