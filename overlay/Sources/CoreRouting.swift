import Foundation

// Pure routing decisions for a spoken question (Foundation only, tested in overlay/Tests).

/// Which model answers a bubble-mode question: the small fast one or the chosen (strong) one. See smart routing.
enum Lane: String { case fast, strong }

/// Quick (Jev) commands are browser actions: "open github", "click sign in", "scroll down", or a multi-step task on the
/// open page ("find a stay in Lisbon with a pool and open it", run by the Jev agent). Checking that
/// locally skips a ~1s classifier round trip for everything else, which goes straight to the assistant.
enum QuickCommandFilter {
    /// Polite or filler openings dropped before looking at the verb.
    static let fillers = ["hey ", "ok ", "okay ", "please ", "can you ", "could you ", "would you ", "just ", "now "]

    /// Verbs a quick command can start with.
    static let verbs: Set<Substring> = ["open", "go", "search", "google", "find", "click", "press", "tap", "scroll", "type",
                                        "close", "switch", "reload", "refresh", "back", "forward", "play", "pause", "show",
                                        "take", "visit", "launch", "navigate", "select", "choose", "fill", "enter", "submit",
                                        "zoom", "new", "look", "watch", "download", "sign", "log"]

    /// More verbs when a browser is the front app: there, "create a CV", "add it to the cart" or "book the 9 am slot"
    /// are about the page, and Jev still sends anything that isn't to the assistant.
    static let browserVerbs: Set<Substring> = ["create", "make", "add", "book", "buy", "order", "apply", "register", "subscribe",
                                               "upload", "post", "reply", "compose", "write", "send", "share", "like", "follow",
                                               "sort", "filter", "set", "check", "uncheck", "pick", "change", "update", "remove",
                                               "delete", "edit", "save", "continue", "accept", "dismiss", "complete", "start",
                                               "use", "put", "copy", "paste", "login", "signup", "join", "mark", "rate", "reserve"]

    /// Browsers the quick commands and the Jev agent drive.
    static let browserBundles: Set<String> = ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary",
                                              "com.brave.Browser", "com.brave.Browser.beta", "com.microsoft.edgemac"]

    static let questionWords: Set<Substring> = ["why", "how", "what", "explain", "tell", "where", "when", "which"]

    static func matches(_ text: String, browserInFront: Bool = false) -> Bool {
        var t = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        if text.trimmingCharacters(in: .whitespaces).hasSuffix("?") { return false }
        for prefix in fillers where t.hasPrefix(prefix) {
            t = String(t.dropFirst(prefix.count))
        }
        let words = t.split(separator: " ")
        // Up to 20 words leaves room for a browser task ("find a stay in Lisbon with a pool and open it");
        // question words mean it's for the assistant, however it starts.
        guard let first = words.first, words.count <= 20, !words.contains(where: { questionWords.contains($0) }) else { return false }
        return verbs.contains(first) || (browserInFront && browserVerbs.contains(first))
    }
}

/// A spoken or typed CLI command: "/model haiku", "Slash model haiku." → "/model haiku". Typed into the terminal
/// as-is so the CLI runs it.
enum SlashCommand {
    static func parse(_ question: String) -> String? {
        var q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = q.last, ".?!,".contains(last) { q.removeLast() }
        let lower = q.lowercased()
        if lower.hasPrefix("slash ") { q = "/" + q.dropFirst(6) }
        else if lower.hasPrefix("forward slash ") { q = "/" + q.dropFirst(14) }
        guard q.hasPrefix("/"), q.count > 1, q.count < 60, !q.contains("\n") else { return nil }
        let parts = q.split(separator: " ", maxSplits: 1)
        let name = parts[0].lowercased().replacingOccurrences(of: ",", with: "")
        return parts.count > 1 ? "\(name) \(parts[1].lowercased())" : name
    }
}
