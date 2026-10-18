// Pure routing decisions for a spoken question. Port of overlay/Sources/CoreRouting.swift.
import { characters, trimWS, trimWSNL, trimWSNLPunct } from "./swift";

/** Which model answers a bubble-mode question: the small fast one or the chosen (strong) one. See smart routing. */
export type Lane = "fast" | "strong";
export const Lane = { fast: "fast", strong: "strong" } as const;

/** Swift `split(separator: " ")`: empty pieces omitted; with maxSplits the rest is kept as is. */
function splitSpaces(s: string, maxSplits = Infinity): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== " ") continue;
    const appended = i > start;
    if (appended) out.push(s.slice(start, i));
    start = i + 1;
    if (appended && out.length === maxSplits) break;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Quick (Jev) commands are browser actions: "open github", "click sign in", "scroll down", or a multi-step task on the
 *  open page ("find a stay in Lisbon with a pool and open it", run by the Jev agent). Checking that
 *  locally skips a ~1s classifier round trip for everything else, which goes straight to the assistant. */
export const QuickCommandFilter = {
  /** Polite or filler openings dropped before looking at the verb. */
  fillers: ["hey ", "ok ", "okay ", "please ", "can you ", "could you ", "would you ", "just ", "now "],

  /** Verbs a quick command can start with. */
  verbs: new Set(["open", "go", "search", "google", "find", "click", "press", "tap", "scroll", "type",
                  "close", "switch", "reload", "refresh", "back", "forward", "play", "pause", "show",
                  "take", "visit", "launch", "navigate", "select", "choose", "fill", "enter", "submit",
                  "zoom", "new", "look", "watch", "download", "sign", "log"]),

  /** More verbs when a browser is the front app: there, "create a CV", "add it to the cart" or "book the 9 am slot"
   *  are about the page, and Jev still sends anything that isn't to the assistant. */
  browserVerbs: new Set(["create", "make", "add", "book", "buy", "order", "apply", "register", "subscribe",
                         "upload", "post", "reply", "compose", "write", "send", "share", "like", "follow",
                         "sort", "filter", "set", "check", "uncheck", "pick", "change", "update", "remove",
                         "delete", "edit", "save", "continue", "accept", "dismiss", "complete", "start",
                         "use", "put", "copy", "paste", "login", "signup", "join", "mark", "rate", "reserve"]),

  /** Browsers the quick commands and the Jev agent drive (window class / app id, lowercased). */
  isBrowser(appId: string): boolean { return /chrome|chromium|brave|msedge|microsoft-edge/i.test(appId); },

  questionWords: new Set(["why", "how", "what", "explain", "tell", "where", "when", "which"]),

  matches(text: string, browserInFront = false): boolean {
    let t = trimWSNLPunct(text.toLowerCase());
    if (trimWS(text).endsWith("?")) return false;
    for (const prefix of QuickCommandFilter.fillers) {
      if (t.startsWith(prefix)) t = t.slice(prefix.length);
    }
    const words = splitSpaces(t);
    // Up to 20 words leaves room for a browser task ("find a stay in Lisbon with a pool and open it");
    // question words mean it's for the assistant, however it starts.
    const first = words[0];
    if (first === undefined || words.length > 20 || words.some((w) => QuickCommandFilter.questionWords.has(w))) return false;
    return QuickCommandFilter.verbs.has(first) || (browserInFront && QuickCommandFilter.browserVerbs.has(first));
  },
};

/** A spoken or typed CLI command: "/model haiku", "Slash model haiku." → "/model haiku". Typed into the terminal
 *  as-is so the CLI runs it. */
export const SlashCommand = {
  parse(question: string): string | null {
    const chars = characters(trimWSNL(question));
    while (chars.length && ".?!,".includes(chars[chars.length - 1]) && chars[chars.length - 1].length === 1) chars.pop();
    const lower = chars.join("").toLowerCase();
    let q = chars;
    if (lower.startsWith("slash ")) q = ["/", ...chars.slice(6)];
    else if (lower.startsWith("forward slash ")) q = ["/", ...chars.slice(14)];
    const s = q.join("");
    if (!s.startsWith("/") || q.length <= 1 || q.length >= 60 || s.includes("\n")) return null;
    const parts = splitSpaces(s, 1);
    const name = parts[0].toLowerCase().split(",").join("");
    return parts.length > 1 ? `${name} ${parts[1].toLowerCase()}` : name;
  },
};
