import Foundation

// Meeting Notes, the pure parts: cutting audio into utterances, grouping them into turns, dropping the microphone's
// echo of the speakers, the Claude Haiku prompts and their parsing, and the notes file. Tested by overlay/Tests.

/// Splits 16 kHz mono Int16 audio into utterances: speech starts above an adaptive threshold (with 300 ms pre-roll)
/// and ends after 900 ms of silence; under 0.8 s of speech is dropped, and anything over 20 s is cut.
struct SpeechSegmenter {
    static let rate = 16000
    static let frame = 480 // 30 ms
    static let prerollFrames = 10
    static let silenceFrames = 30
    static let minSpeechFrames = 27
    static let maxFrames = 667
    static var trailingSilence: TimeInterval { Double(silenceFrames * frame) / Double(rate) }

    /// The background level: drops quickly to a quieter frame, rises slowly, so speech doesn't become "the floor".
    private(set) var floor = 0.004
    private var partial: [Int16] = []
    private var preroll: [[Int16]] = []
    private var utterance: [Int16] = []
    private var frames = 0
    private var speechFrames = 0
    private var silent = 0
    private(set) var inSpeech = false

    static func rms(_ f: ArraySlice<Int16>) -> Double {
        guard !f.isEmpty else { return 0 }
        var sum = 0.0
        for s in f { let v = Double(s) / 32768; sum += v * v }
        return (sum / Double(f.count)).squareRoot()
    }

    /// Feeds samples; returns the utterances that ended in them.
    mutating func feed(_ samples: [Int16]) -> [[Int16]] {
        partial += samples
        var out: [[Int16]] = []
        var i = 0
        while partial.count - i >= Self.frame {
            if let u = step(Array(partial[i..<i + Self.frame])) { out.append(u) }
            i += Self.frame
        }
        partial.removeFirst(i)
        return out
    }

    /// Drops whatever is in progress (the source was paused).
    mutating func reset() {
        partial = []; preroll = []; utterance = []; inSpeech = false
    }

    private mutating func step(_ f: [Int16]) -> [Int16]? {
        let level = Self.rms(f[...])
        floor = level < floor ? floor * 0.9 + level * 0.1 : floor * 0.999 + level * 0.001
        let speech = level > max(0.012, floor * 3)
        guard inSpeech else {
            if speech {
                inSpeech = true
                utterance = preroll.flatMap { $0 } + f
                frames = preroll.count + 1
                speechFrames = 1
                silent = 0
                preroll = []
            } else {
                preroll.append(f)
                if preroll.count > Self.prerollFrames { preroll.removeFirst() }
            }
            return nil
        }
        utterance += f
        frames += 1
        if speech { speechFrames += 1; silent = 0 } else { silent += 1 }
        guard silent >= Self.silenceFrames || frames >= Self.maxFrames else { return nil }
        inSpeech = false
        let u = utterance, enough = speechFrames >= Self.minSpeechFrames
        utterance = []
        return enough ? u : nil
    }
}

enum MeetingAudio {
    /// A 16 kHz mono 16-bit WAV file.
    static func wav(_ pcm: [Int16]) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(pcm.count * 2), rate = UInt32(SpeechSegmenter.rate)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes)
        d.append(contentsOf: Array("WAVEfmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        pcm.withUnsafeBytes { d.append(contentsOf: $0) }
        return d
    }

    /// Float samples (any rate, first channel already picked) → 16 kHz Int16, by linear interpolation.
    static func to16k(_ x: [Float], rate: Double) -> [Int16] {
        func i16(_ v: Float) -> Int16 { Int16(max(-1, min(1, v)) * 32767) }
        guard rate != Double(SpeechSegmenter.rate) else { return x.map(i16) }
        let step = rate / Double(SpeechSegmenter.rate)
        let n = Int(Double(x.count) / step)
        var out = [Int16](repeating: 0, count: n)
        for j in 0..<n {
            let p = Double(j) * step, k = Int(p), f = Float(p - Double(k))
            let a = x[k], b = k + 1 < x.count ? x[k + 1] : a
            out[j] = i16(a + (b - a) * f)
        }
        return out
    }
}

enum MeetingText {
    static let starters = ["what's", "how's", "what", "why", "how", "when", "where", "who", "which", "whose", "can", "could",
                           "would", "will", "do", "does", "did", "is", "are", "was", "were", "have", "has", "should",
                           "tell me", "explain", "describe", "walk me through", "give me", "talk about"]
    static let fillers: Set<String> = ["so", "okay", "ok", "and", "um", "uh", "well", "alright", "right", "now", "hmm", "yeah"]
    static let junk: Set<String> = ["thank you", "thanks for watching", "you", "bye", "thank you very much"]

    static func words(_ s: String) -> [String] {
        s.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// Lowercase words without punctuation: how two transcriptions of the same words compare.
    static func key(_ s: String) -> [String] {
        s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    /// Silence or noise the recognizer turned into text: "[BLANK_AUDIO]", "Thank you.", one word, only punctuation.
    static func isJunk(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.range(of: #"^[\[\(].*[\]\)]$"#, options: .regularExpression) != nil { return true }
        let bare = key(t).joined(separator: " ")
        return bare.isEmpty || junk.contains(bare) || key(t).count < 2
    }

    /// A question or request, by its words: ends with "?", or (4+ words) starts with a question word after fillers.
    static func isQuestion(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var w = words(t).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ",.;:!")) }
        if t.contains("?") { return w.count >= 2 }
        guard w.count >= 4 else { return false }
        while let first = w.first, fillers.contains(first) { w.removeFirst() }
        let rest = w.joined(separator: " ")
        return starters.contains { rest == $0 || rest.hasPrefix($0 + " ") }
    }
}

enum MeetingSpeaker: String { case guest = "Guest", you = "You" }

struct MeetingTurn: Identifiable, Equatable {
    let id: Int
    let speaker: MeetingSpeaker
    let start: Date
    var end: Date
    var text: String
}

/// Consecutive utterances from one speaker make a turn, until the other speaker talks or they pause for `gap`.
struct TurnBuilder {
    static let gap: TimeInterval = 2.0
    private(set) var open: MeetingTurn?
    private var nextId = 1

    /// Adds an utterance; returns the turn it closed (the other speaker's, or the same speaker's after a pause).
    mutating func add(_ speaker: MeetingSpeaker, _ text: String, start: Date, end: Date) -> MeetingTurn? {
        if var t = open, t.speaker == speaker, start.timeIntervalSince(t.end) < Self.gap {
            t.text += " " + text
            t.end = max(t.end, end)
            open = t
            return nil
        }
        let closed = open
        open = MeetingTurn(id: nextId, speaker: speaker, start: start, end: end, text: text)
        nextId += 1
        return closed
    }

    /// Closes the open turn once its speaker has been quiet for `gap` (and isn't mid-utterance: `busy`).
    mutating func close(at now: Date, busy: Bool) -> MeetingTurn? {
        guard let t = open, !busy, now.timeIntervalSince(t.end) >= Self.gap else { return nil }
        open = nil
        return t
    }

    /// The guest went on talking before the replies to their turn arrived: that turn continues.
    mutating func reopen(_ t: MeetingTurn) -> MeetingTurn? {
        let closed = open
        open = t
        return closed
    }

    mutating func finish() -> MeetingTurn? {
        defer { open = nil }
        return open
    }
}

/// With speakers instead of headphones the microphone also hears the guest: that isn't the user talking.
enum EchoFilter {
    static let window: TimeInterval = 10

    /// The share of `span` covered by `spans`.
    static func overlap(_ span: (start: Date, end: Date), _ spans: [(start: Date, end: Date)]) -> Double {
        let length = span.end.timeIntervalSince(span.start)
        guard length > 0 else { return 0 }
        var covered = 0.0
        for s in spans {
            let a = max(s.start, span.start), b = min(s.end, span.end)
            if b > a { covered += b.timeIntervalSince(a) }
        }
        return min(1, covered / length)
    }

    /// The share of `a`'s words that are also in `b`.
    static func similarity(_ a: String, _ b: String) -> Double {
        let wa = MeetingText.key(a), wb = Set(MeetingText.key(b))
        guard !wa.isEmpty else { return 0 }
        return Double(wa.filter { wb.contains($0) }.count) / Double(wa.count)
    }

    static func isEcho(text: String, start: Date, end: Date, guestSpans: [(start: Date, end: Date)],
                       guestLines: [(at: Date, text: String)]) -> Bool {
        if overlap((start, end), guestSpans) >= 0.6 { return true }
        return guestLines.contains { abs($0.at.timeIntervalSince(end)) <= window && similarity(text, $0.text) >= 0.6 }
    }
}

/// At most `limit` Claude calls an hour.
struct HourlyCap {
    let limit: Int
    private(set) var used: [Date] = []

    func allows(at now: Date = Date()) -> Bool { used.filter { now.timeIntervalSince($0) < 3600 }.count < limit }

    mutating func use(at now: Date = Date()) { used = used.filter { now.timeIntervalSince($0) < 3600 } + [now] }
}

/// What Claude Haiku is asked, and how its answers are read.
enum MeetingAI {
    static let repliesPrompt = """
    You are a developer's sidekick in a work meeting (stand-up, planning, code review, incident, 1:1). You get the \
    recent conversation (Guest = colleagues, You = the user) and what a colleague just said to the user. Write 3 \
    replies the user could say right now, in the first person, in the conversation's language. Each is 3 to 12 words, \
    practical and concrete like a developer talking to teammates, and the three are clearly different (for example \
    a direct answer / a follow-up or commitment / a clarifying question, as fits). If the honest answer needs a fact \
    you don't know, one reply can be "Let me check and get back to you". Never mention being an AI. Each message is \
    independent: use only what it contains.
    Reply with only JSON: {"replies": ["…", "…", "…"]}
    """

    static let summaryPrompt = """
    You take notes for a developer in a work meeting. You get the recent conversation (Guest = colleagues, You = the \
    user) and one new turn. Summarize the new turn in one short line (under 15 words), in the conversation's \
    language. Say whether it asks the user a question or makes a request of them. Say whether answering needs a \
    specific fact from the user's codebase or its git history (a config value, an endpoint, where something is \
    implemented, how a function behaves, when something changed); general or opinion questions don't. Each message \
    is independent: use only what it contains.
    Reply with only JSON: {"summary": "…", "question": true|false, "lookup": true|false}
    """

    static let lookupPrompt = """
    A colleague asked the user this in a live meeting, and the user needs the answer from this codebase, fast. Look \
    in the code (read-only) and answer in 1-3 short spoken sentences the user can say, then the file:line references \
    on their own line. If the code doesn't tell, say so in one sentence. No preamble.
    """

    static let meetingPrompt = """
    You write meeting notes from a transcript (Guest = the other people, You = the user). Write Markdown in the \
    transcript's language with these sections: ## Overview (2-3 sentences), ## Key points, ## Questions asked, \
    ## Action items (who does what; "None" if there are none). Be concise and factual. Output only the Markdown.
    """

    static let timeFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX") // 24-hour whatever the Mac's clock setting
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    static func line(_ t: MeetingTurn) -> String { "[\(timeFormat.string(from: t.start))] \(t.speaker.rawValue): \(t.text)" }

    static func context(_ turns: [MeetingTurn]) -> String {
        turns.suffix(10).map(line).joined(separator: "\n")
    }

    static func repliesMessage(context: [MeetingTurn], turn: MeetingTurn) -> String {
        (context.isEmpty ? "" : "Recent conversation:\n\(self.context(context))\n\n") + "The guest just said: \"\(turn.text)\""
    }

    static func summaryMessage(context: [MeetingTurn], turn: MeetingTurn) -> String {
        (context.isEmpty ? "" : "Recent conversation:\n\(self.context(context))\n\n") + "New turn (\(turn.speaker.rawValue)): \"\(turn.text)\""
    }

    static func meetingMessage(_ turns: [MeetingTurn]) -> String {
        "Transcript:\n" + turns.map(line).joined(separator: "\n")
    }

    /// The JSON object in a reply, tolerating ```json fences and prose around it.
    static func object(_ text: String) -> [String: Any]? {
        guard let a = text.firstIndex(of: "{"), let b = text.lastIndex(of: "}"), a < b else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(text[a...b].utf8)) as? [String: Any]
    }

    static func parseReplies(_ text: String) -> [String]? {
        guard let list = object(text)?["replies"] as? [Any] else { return nil }
        let replies = list.compactMap { $0 as? String }
            .map { $0.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "-•*\""))) }
            .filter { !$0.isEmpty }
        return replies.isEmpty ? nil : Array(replies.prefix(3))
    }

    static func parseSummary(_ text: String) -> (summary: String, question: Bool, lookup: Bool)? {
        guard let j = object(text), let s = (j["summary"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return (s, j["question"] as? Bool ?? false, j["lookup"] as? Bool ?? false)
    }

    static func lookupMessage(context: [MeetingTurn], turn: MeetingTurn) -> String {
        (context.isEmpty ? "" : "Recent conversation:\n\(self.context(context))\n\n") + "The colleague asked: \"\(turn.text)\""
    }

    /// The `result` text of a stream-json `result` line, or nil for any other line.
    static func result(streamLine line: String) -> String? {
        guard line.contains("\"type\":\"result\""),
              let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
        return obj["result"] as? String ?? ""
    }
}

/// The meeting's Markdown file.
enum MeetingFile {
    /// The meeting's folder (notes.md, recording.m4a, meeting.json).
    static func folderName(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH-mm-ss"
        return f.string(from: date)
    }

    static func header(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .full
        f.timeStyle = .short
        return "# Meeting notes · \(f.string(from: date))\n\n## Transcript\n\n"
    }

    static func entry(_ t: MeetingTurn, summary: String?, replies: [String]) -> String {
        var s = "**\(t.speaker.rawValue)** · \(MeetingAI.timeFormat.string(from: t.start))\n\(t.text)\n"
        if let summary { s += "> \(summary)\n" }
        if !replies.isEmpty { s += "\nReply options:\n" + replies.map { "- \($0)\n" }.joined() }
        return s + "\n"
    }

    /// The meeting summary goes above the transcript.
    static func withSummary(_ file: String, _ summary: String) -> String {
        guard let r = file.range(of: "## Transcript") else { return file + "\n" + summary + "\n" }
        return file[..<r.lowerBound] + summary.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n" + file[r.lowerBound...]
    }
}

/// Mixing the two recorded tracks into one: the guest and you, summed and clipped.
enum MeetingMix {
    static func mix(_ a: [Int16], _ b: [Int16]) -> [Int16] {
        (0..<max(a.count, b.count)).map { i in
            let s = Int(i < a.count ? a[i] : 0) + Int(i < b.count ? b[i] : 0)
            return Int16(max(Int(Int16.min), min(Int(Int16.max), s)))
        }
    }
}

/// What a past meeting needs to be shown and played again (meeting.json next to the notes and the recording).
struct MeetingRecord: Codable, Equatable {
    struct Row: Codable, Equatable {
        var speaker: String
        var offset: Double           // seconds from the start of the recording
        var text: String
        var summary: String?
        var replies: [String]
        var code: String?
    }
    var started: Date
    var project: String
    var rows: [Row]
    var overview: String?

    /// The row being played at `time` (the last one that started by then).
    static func current(_ offsets: [Double], at time: Double) -> Int? {
        offsets.lastIndex { $0 <= time + 0.05 }
    }
}
