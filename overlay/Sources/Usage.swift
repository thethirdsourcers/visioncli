import AppKit
import Foundation
import SwiftUI

// Claude plan usage for the menu: the 5-hour session and weekly limits come from the `rate_limit_event` Claude Code
// streams with every reply (no credentials needed). Today's tokens are added up from Claude Code's own transcripts
// (~/.claude/projects), so they cover every Claude Code session on this Mac, not only VisionCLI's.

final class UsageTracker {
    static let shared = UsageTracker()

    struct Window: Codable { var utilization: Double; var resetsAt: Date }
    struct Today { var requests = 0, input = 0, output = 0, cached = 0 }

    private(set) var session: Window?
    private(set) var week: Window?
    private(set) var updated: Date?
    private(set) var today = Today()
    private var todayScanned: Date?
    private var refreshing = false
    var onChange: () -> Void = {}

    private let defaults = UserDefaults.standard

    init() {
        let dec = JSONDecoder()
        session = defaults.data(forKey: "usage.session").flatMap { try? dec.decode(Window.self, from: $0) }
        week = defaults.data(forKey: "usage.week").flatMap { try? dec.decode(Window.self, from: $0) }
        updated = defaults.object(forKey: "usage.updated") as? Date
    }

    /// From a stream-json `rate_limit_event` ("rate_limit_info": {"unifiedWindows": {"five_hour": …, "seven_day": …}}).
    func record(_ info: [String: Any]) {
        guard let windows = info["unifiedWindows"] as? [String: Any] else { return }
        func window(_ key: String) -> Window? {
            guard let w = windows[key] as? [String: Any], let u = (w["utilization"] as? NSNumber)?.doubleValue,
                  let r = (w["resetsAt"] as? NSNumber)?.doubleValue else { return nil }
            return Window(utilization: u, resetsAt: Date(timeIntervalSince1970: r))
        }
        DispatchQueue.main.async {
            if let s = window("five_hour") { self.session = s }
            if let w = window("seven_day") { self.week = w }
            self.updated = Date()
            let enc = JSONEncoder()
            self.defaults.set(self.session.flatMap { try? enc.encode($0) }, forKey: "usage.session")
            self.defaults.set(self.week.flatMap { try? enc.encode($0) }, forKey: "usage.week")
            self.defaults.set(self.updated, forKey: "usage.updated")
            self.onChange()
        }
    }

    /// Older than 15 minutes (every reply also brings fresh numbers, so this only matters between questions).
    var isStale: Bool { Date().timeIntervalSince(updated ?? .distantPast) > 900 }

    /// A window's utilization, or 0 once its reset time has passed.
    func percent(_ w: Window?) -> Int? {
        guard let w else { return nil }
        return w.resetsAt < Date() ? 0 : Int((w.utilization * 100).rounded())
    }

    /// Ask Claude Code for fresh numbers: the smallest possible Haiku request (it uses a sliver of the limit).
    func refresh(claude: String, done: @escaping () -> Void = {}) {
        guard !refreshing else { return done() }
        refreshing = true
        DispatchQueue.global(qos: .utility).async {
            // Not saved as a session: no transcript in ~/.claude/projects (today's count, the backup, /resume stay clean).
            let (_, out, _) = shell(claude, ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
                                             "--max-turns", "1", "Reply with just: ok"], cwd: NSTemporaryDirectory())
            DispatchQueue.main.async { self.refreshing = false }
            for line in out.split(separator: "\n") where line.contains("rate_limit_event") {
                if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                   let info = obj["rate_limit_info"] as? [String: Any] { self.record(info) }
            }
            DispatchQueue.main.async(execute: done)
        }
    }

    /// Re-count today's tokens in the background (at most once a minute).
    func scanToday() {
        if let t = todayScanned, Date().timeIntervalSince(t) < 60 { return }
        todayScanned = Date()
        Self.scanQueue.async {
            let result = Self.countToday()
            DispatchQueue.main.async {
                self.today = result
                self.onChange()
            }
        }
    }

    /// Today's usage lines already read from one transcript: how far it was read, and per message id the counts
    /// (in, out, cached) of its first occurrence.
    private struct FileScan {
        var offset: UInt64 = 0
        var ids: [String] = [] // first-seen order
        var counts: [String: (Int, Int, Int)] = [:]
    }

    /// Transcripts only grow, so each scan reads just the bytes appended since the last one. Only touched on `scanQueue`.
    private static let scanQueue = DispatchQueue(label: "visioncli.usage", qos: .utility)
    private static var scans: [String: FileScan] = [:]
    private static var scansDay: Date?

    private static func countToday() -> Today {
        let root = home.appendingPathComponent(".claude/projects")
        let start = Calendar.current.startOfDay(for: Date())
        if scansDay != start { scans = [:]; scansDay = start }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var t = Today()
        var seen = Set<String>() // a streamed reply is written several times with the same message id
        var kept: [String: FileScan] = [:]
        defer { scans = kept } // drops files no longer modified today (or gone)
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]) else { return t }
        for case let url as URL in walker where url.pathExtension == "jsonl" {
            guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
                  let mod = values.contentModificationDate, mod >= start else { continue }
            var scan = scans[url.path] ?? FileScan()
            if let size = values.fileSize, UInt64(size) < scan.offset { scan = FileScan() } // rewritten: start over
            read(url, into: &scan, start: start, iso: iso)
            kept[url.path] = scan
            for id in scan.ids where seen.insert(id).inserted {
                guard let c = scan.counts[id] else { continue }
                t.requests += 1
                t.input += c.0
                t.output += c.1
                t.cached += c.2
            }
        }
        return t
    }

    /// Reads complete lines appended after `scan.offset`, a few MB at a time (transcripts can be tens of MB).
    private static func read(_ url: URL, into scan: inout FileScan, start: Date, iso: ISO8601DateFormatter) {
        guard let h = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? h.close() }
        do { try h.seek(toOffset: scan.offset) } catch { return }
        var carry = Data()
        while true {
            let chunk: Data
            do { chunk = try h.read(upToCount: 4 << 20) ?? Data() } catch { break }
            if chunk.isEmpty { break }
            carry.append(chunk)
            guard let lastNewline = carry.lastIndex(of: 0x0A) else { continue }
            let complete = carry[carry.startIndex...lastNewline]
            scan.offset += UInt64(complete.count)
            parse(String(decoding: complete, as: UTF8.self), into: &scan, start: start, iso: iso)
            carry = Data(carry[(lastNewline + 1)...]) // an unfinished last line is read again next time
        }
    }

    private static func parse(_ text: String, into scan: inout FileScan, start: Date, iso: ISO8601DateFormatter) {
        for line in text.split(separator: "\n") where line.contains("\"usage\"") && line.contains("\"assistant\"") {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let ts = (obj["timestamp"] as? String).flatMap(iso.date(from:)), ts >= start,
                  let msg = obj["message"] as? [String: Any], let usage = msg["usage"] as? [String: Any] else { continue }
            let id = (msg["id"] as? String) ?? (obj["uuid"] as? String) ?? UUID().uuidString
            guard scan.counts[id] == nil else { continue }
            func n(_ k: String) -> Int { (usage[k] as? NSNumber)?.intValue ?? 0 }
            scan.ids.append(id)
            scan.counts[id] = (n("input_tokens") + n("cache_creation_input_tokens"), n("output_tokens"), n("cache_read_input_tokens"))
        }
    }

    // MARK: Labels

    static func tokens(_ n: Int) -> String {
        n >= 1_000_000 ? String(format: "%.1fM", Double(n) / 1_000_000) : n >= 1_000 ? "\(n / 1_000)K" : "\(n)"
    }

    static func resets(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = Calendar.current.isDateInToday(d) ? "h:mm a" : "EEE h:mm a"
        return f.string(from: d)
    }

    /// Compact text for the menu bar: "22% · 52%w".
    var barText: String? {
        guard let s = percent(session), let w = percent(week) else { return nil }
        return "\(s)% · \(w)%w"
    }
}

// MARK: - Icons and card

enum UsageArt {
    static func color(_ percent: Int) -> NSColor {
        percent >= 80 ? .systemRed : percent >= 50 ? .systemOrange : .systemGreen
    }

    /// A small progress ring for the menu bar.
    static func ring(_ percent: Int, size: CGFloat = 13) -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let line: CGFloat = 2.2
            let r = rect.insetBy(dx: line / 2 + 0.5, dy: line / 2 + 0.5)
            let track = NSBezierPath(ovalIn: r)
            track.lineWidth = line
            NSColor.labelColor.withAlphaComponent(0.25).setStroke()
            track.stroke()
            let center = NSPoint(x: rect.midX, y: rect.midY)
            let arc = NSBezierPath()
            arc.appendArc(withCenter: center, radius: r.width / 2, startAngle: 90,
                          endAngle: 90 - 360 * CGFloat(min(max(percent, 0), 100)) / 100, clockwise: true)
            arc.lineWidth = line
            arc.lineCapStyle = .round
            color(percent).setStroke()
            arc.stroke()
            return true
        }
    }

    /// "◔ 22%" (and "◑ 52%w" with the week) for the menu bar button, rings drawn in color.
    static func barTitle(prefix: String, session: Int, week: Int?) -> NSAttributedString {
        let font = NSFont.menuBarFont(ofSize: 0)
        let out = NSMutableAttributedString(string: prefix + "  ", attributes: [.font: font])
        let rings = [session] + (week.map { [$0] } ?? [])
        for (i, p) in rings.enumerated() {
            let att = NSTextAttachment()
            att.image = ring(p)
            att.bounds = CGRect(x: 0, y: -2, width: 13, height: 13)
            out.append(NSAttributedString(attachment: att))
            out.append(NSAttributedString(string: " \(p)%" + (i == 1 ? "w" : "") + (i < rings.count - 1 ? "  " : ""), attributes: [.font: font]))
        }
        return out
    }

    static func symbol(_ name: String, fallback: String = "chart.bar") -> NSImage? {
        NSImage(systemSymbolName: name, accessibilityDescription: nil) ?? NSImage(systemSymbolName: fallback, accessibilityDescription: nil)
    }
}

/// The card at the top of the Claude Usage submenu.
// Gemini (Antigravity) usage: `agy -p /usage --output-format json` reports each model group's 5-hour and weekly limits
// (remaining fraction + reset time) without running a model, so it costs nothing. Gemini models and Claude/GPT models
// used through Antigravity have separate groups.
final class AgyUsage {
    static let shared = AgyUsage()

    struct Group: Codable { var name: String; var session: UsageTracker.Window?; var week: UsageTracker.Window? }

    private(set) var groups: [Group] = []
    private(set) var updated: Date?
    var onChange: () -> Void = {}
    private var refreshing = false
    private let defaults = UserDefaults.standard

    init() {
        if let d = defaults.data(forKey: "agyUsage.groups"), let g = try? JSONDecoder().decode([Group].self, from: d) { groups = g }
        updated = defaults.object(forKey: "agyUsage.updated") as? Date
    }

    /// The `command.data.groups` of agy's JSON reply; utilization = the used fraction, like Claude's.
    static func parse(_ data: Data) -> [Group] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let groups = ((obj["command"] as? [String: Any])?["data"] as? [String: Any])?["groups"] as? [[String: Any]] else { return [] }
        let iso = ISO8601DateFormatter()
        func window(_ buckets: [[String: Any]], _ w: String) -> UsageTracker.Window? {
            guard let b = buckets.first(where: { $0["window"] as? String == w }),
                  let remaining = (b["remaining_fraction"] as? NSNumber)?.doubleValue,
                  let reset = (b["reset_time"] as? String).flatMap(iso.date(from:)) else { return nil }
            return UsageTracker.Window(utilization: max(0, 1 - remaining), resetsAt: reset)
        }
        return groups.compactMap { g in
            guard let name = g["name"] as? String else { return nil }
            let buckets = g["buckets"] as? [[String: Any]] ?? []
            return Group(name: name, session: window(buckets, "5h"), week: window(buckets, "weekly"))
        }
    }

    /// The group the chosen agy model draws from (Claude/GPT models have their own limits; everything else is Gemini).
    func active(model: String?) -> Group? {
        let thirdParty = model.map { $0.range(of: "claude|gpt|opus|sonnet", options: [.regularExpression, .caseInsensitive]) != nil } ?? false
        return groups.first { $0.name.range(of: thirdParty ? "claude|gpt" : "gemini", options: [.regularExpression, .caseInsensitive]) != nil } ?? groups.first
    }

    var isStale: Bool { Date().timeIntervalSince(updated ?? .distantPast) > 600 }

    func refresh(agy: String?) {
        guard let agy, !refreshing else { return }
        refreshing = true
        DispatchQueue.global(qos: .utility).async {
            let (_, out, _) = shell(agy, ["-p", "/usage", "--output-format", "json", "--print-timeout", "60s"], cwd: NSTemporaryDirectory())
            let json = out.firstIndex(of: "{").map { String(out[$0...]) } ?? ""
            let parsed = Self.parse(Data(json.utf8))
            DispatchQueue.main.async {
                self.refreshing = false
                guard !parsed.isEmpty else { return } // agy missing, signed out or offline: keep the last numbers
                self.groups = parsed
                self.updated = Date()
                if let d = try? JSONEncoder().encode(parsed) { self.defaults.set(d, forKey: "agyUsage.groups") }
                self.defaults.set(self.updated, forKey: "agyUsage.updated")
                self.onChange()
            }
        }
    }
}

struct UsageCard: View {
    let session: (Int, Date)?
    let week: (Int, Date)?
    let today: UsageTracker.Today
    let updated: Date?
    /// Gemini: the other Antigravity model groups (shown instead of Claude Code's token counts).
    var gemini: [AgyUsage.Group]? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let session { meter(icon: "clock", title: "Session (5 hours)", percent: session.0, resets: session.1) }
            if let week { meter(icon: "calendar", title: "This week", percent: week.0, resets: week.1) }
            if session == nil && week == nil {
                Label("No usage yet: ask something or Refresh", systemImage: "gauge.with.dots.needle.0percent")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Divider()
            if let gemini {
                ForEach(Array(gemini.enumerated()), id: \.offset) { _, g in
                    Text(g.name).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    if let s = g.session { meter(icon: "clock", title: "5 hours", percent: Int((s.utilization * 100).rounded()), resets: s.resetsAt) }
                    if let w = g.week { meter(icon: "calendar", title: "This week", percent: Int((w.utilization * 100).rounded()), resets: w.resetsAt) }
                }
                Text("Antigravity plan" + (updated.map { " · " + RelativeDateTimeFormatter().localizedString(for: $0, relativeTo: Date()) } ?? ""))
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
            } else {
            HStack(spacing: 6) {
                Image(systemName: "chart.bar.fill").foregroundStyle(.blue).frame(width: 16)
                Text("Today").font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("\(today.requests) requests").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                stat("arrow.up.circle", UsageTracker.tokens(today.input), "in")
                stat("arrow.down.circle", UsageTracker.tokens(today.output), "out")
                stat("memorychip", UsageTracker.tokens(today.cached), "cached")
            }
            .padding(.leading, 22)
            Text("All Claude Code sessions on this Mac" + (updated.map { " · limits " + RelativeDateTimeFormatter().localizedString(for: $0, relativeTo: Date()) } ?? ""))
                .font(.system(size: 10)).foregroundStyle(.tertiary).padding(.leading, 22)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(width: 300, alignment: .leading)
    }

    private func meter(icon: String, title: String, percent: Int, resets: Date) -> some View {
        let tint = Color(nsColor: UsageArt.color(percent))
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: percent >= 80 ? "exclamationmark.triangle.fill" : icon).foregroundStyle(tint).frame(width: 16)
                Text(title).font(.system(size: 12, weight: .semibold))
                Spacer()
                Text("\(percent)%").font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(tint)
            }
            ProgressView(value: Double(percent), total: 100).tint(tint).padding(.leading, 22)
            Text("Resets \(UsageTracker.resets(resets))").font(.system(size: 10)).foregroundStyle(.secondary).padding(.leading, 22)
        }
    }

    private func stat(_ icon: String, _ value: String, _ label: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 11, weight: .medium).monospacedDigit())
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
        }
    }
}
