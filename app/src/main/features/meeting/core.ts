import { RATE } from "../../audio/wav";

// Meeting Notes, the pure parts (CoreMeeting.swift): cutting audio into utterances, grouping them into turns,
// dropping the microphone's echo of the speakers, the Claude prompts and their parsing, the notes file, mixing the
// two recorded tracks, and what a saved meeting looks like. Tested in tests/features/meeting.test.ts.

// ── Utterances: speech between pauses, from a raw 16 kHz mono s16 stream ───────────────────────────────────────

const FRAME = (RATE * 30) / 1000;        // 30 ms
const FRAME_BYTES = FRAME * 2;
const PREROLL = 10;                      // 300 ms before speech starts
const END_SILENCE = 30;                  // 900 ms of silence ends an utterance
const MIN_SPEECH = 27;                   // under ~0.8 s of speech is a cough or "mm"
const MAX_FRAMES = Math.round(20_000 / 30);

export function rms(frame: Buffer): number {
  const n = frame.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = frame.readInt16LE(i * 2) / 32768; sum += s * s; }
  return Math.sqrt(sum / n);
}

/** Peak of s16 PCM, 0…1 (the per-source level log). */
export function peak(pcm: Buffer): number {
  let m = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v > m) m = v; }
  return m / 32768;
}

/** Splits 16 kHz mono s16 audio into utterances: speech starts above an adaptive threshold (with 300 ms pre-roll)
 *  and ends after 900 ms of silence; under 0.8 s of speech is dropped, and anything over 20 s is cut. */
export class Segmenter {
  private rest = Buffer.alloc(0);
  private preroll: Buffer[] = [];
  private frames: Buffer[] = [];
  private speech = 0;
  private silence = 0;
  private floor = 0.004; // until the first quiet stretch sets it: speech right at the start still counts
  inSpeech = false;

  /** Feeds PCM; returns the utterances that ended in it (each a PCM buffer). */
  push(pcm: Buffer): Buffer[] {
    const out: Buffer[] = [];
    const data = this.rest.length ? Buffer.concat([this.rest, pcm]) : pcm;
    let off = 0;
    for (; off + FRAME_BYTES <= data.length; off += FRAME_BYTES) {
      const u = this.frame(Buffer.from(data.subarray(off, off + FRAME_BYTES)));
      if (u) out.push(u);
    }
    this.rest = Buffer.from(data.subarray(off));
    return out;
  }

  /** Drops whatever is in progress (the source was paused). */
  reset() {
    this.rest = Buffer.alloc(0);
    this.preroll = [];
    this.frames = [];
    this.inSpeech = false;
    this.speech = this.silence = 0;
  }

  private frame(f: Buffer): Buffer | null {
    const level = rms(f);
    const voiced = level > Math.max(0.012, this.floor * 3);
    // The noise floor drops to quiet stretches at once and rises to steady background noise slowly, and to speech
    // hardly at all, so a long answer doesn't turn into "noise" halfway.
    this.floor = level < this.floor ? level : this.floor + (level - this.floor) * (voiced ? 0.0001 : 0.01);
    if (!this.inSpeech) {
      if (!voiced) {
        this.preroll.push(f);
        if (this.preroll.length > PREROLL) this.preroll.shift();
        return null;
      }
      this.inSpeech = true;
      this.frames = [...this.preroll, f];
      this.preroll = [];
      this.speech = 1;
      this.silence = 0;
      return null;
    }
    this.frames.push(f);
    if (voiced) { this.speech++; this.silence = 0; } else this.silence++;
    if (this.silence < END_SILENCE && this.frames.length < MAX_FRAMES) return null;
    // Ended (or too long): keep a little of the trailing silence, drop the rest.
    const keep = this.frames.slice(0, this.frames.length - Math.max(0, this.silence - 5));
    const enough = this.speech >= MIN_SPEECH;
    this.inSpeech = false;
    this.frames = [];
    this.speech = this.silence = 0;
    return enough ? Buffer.concat(keep) : null;
  }
}

// ── Text ──────────────────────────────────────────────────────────────────────────────────────────────────────

const STARTERS = ["what's", "how's", "what", "why", "how", "when", "where", "who", "which", "whose", "can", "could",
  "would", "will", "do", "does", "did", "is", "are", "was", "were", "have", "has", "should",
  "tell me", "explain", "describe", "walk me through", "give me", "talk about"];
const FILLERS = new Set(["so", "okay", "ok", "and", "um", "uh", "well", "alright", "right", "now", "hmm", "yeah"]);
const JUNK = new Set(["thank you", "thanks for watching", "you", "bye", "thank you very much"]);

export const MeetingText = {
  /** Lowercase words without punctuation: how two transcriptions of the same words compare. */
  key(s: string): string[] { return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); },

  /** Silence or noise the recognizer turned into text: "[BLANK_AUDIO]", "Thank you.", one word, only punctuation. */
  isJunk(text: string): boolean {
    const t = text.trim();
    if (/^[[(].*[\])]$/s.test(t)) return true;
    const k = MeetingText.key(t);
    return !k.length || JUNK.has(k.join(" ")) || k.length < 2;
  },

  /** A question or request, by its words: has "?", or (4+ words) starts with a question word after fillers. */
  isQuestion(text: string): boolean {
    const t = text.trim();
    const w = t.toLowerCase().split(/\s+/).filter(Boolean).map((x) => x.replace(/^[,.;:!]+|[,.;:!]+$/g, "").replace(/’/g, "'"));
    if (t.includes("?")) return w.length >= 2;
    if (w.length < 4) return false;
    while (w.length && FILLERS.has(w[0])) w.shift();
    const rest = w.join(" ");
    return STARTERS.some((s) => rest === s || rest.startsWith(s + " "));
  },
};

// ── Turns ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type MeetingSpeaker = "Guest" | "You";

export interface MeetingTurn { id: number; speaker: MeetingSpeaker; start: number; end: number; text: string } // ms

/** Consecutive utterances from one speaker make a turn, until the other speaker talks or they pause for `GAP`. */
export class TurnBuilder {
  static readonly GAP = 2000;
  open: MeetingTurn | null = null;
  private nextId = 1;

  /** Adds an utterance; returns the turn it closed (the other speaker's, or the same speaker's after a pause). */
  add(speaker: MeetingSpeaker, text: string, start: number, end: number): MeetingTurn | null {
    const t = this.open;
    if (t && t.speaker === speaker && start - t.end < TurnBuilder.GAP) {
      this.open = { ...t, text: t.text + " " + text, end: Math.max(t.end, end) };
      return null;
    }
    this.open = { id: this.nextId++, speaker, start, end, text };
    return t;
  }

  /** Closes the open turn once its speaker has been quiet for `GAP` (and isn't mid-utterance: `busy`). */
  close(now: number, busy: boolean): MeetingTurn | null {
    const t = this.open;
    if (!t || busy || now - t.end < TurnBuilder.GAP) return null;
    this.open = null;
    return t;
  }

  /** The guest went on talking before the replies to their turn arrived: that turn continues. */
  reopen(t: MeetingTurn): MeetingTurn | null {
    const closed = this.open;
    this.open = t;
    return closed;
  }

  finish(): MeetingTurn | null {
    const t = this.open;
    this.open = null;
    return t;
  }
}

/** With speakers instead of headphones the microphone also hears the guest: that isn't the user talking. */
export const EchoFilter = {
  WINDOW: 10_000,

  /** The share of `span` covered by `spans`. */
  overlap(span: { start: number; end: number }, spans: { start: number; end: number }[]): number {
    const length = span.end - span.start;
    if (length <= 0) return 0;
    let covered = 0;
    for (const s of spans) {
      const a = Math.max(s.start, span.start), b = Math.min(s.end, span.end);
      if (b > a) covered += b - a;
    }
    return Math.min(1, covered / length);
  },

  /** The share of `a`'s words that are also in `b`. */
  similarity(a: string, b: string): number {
    const wa = MeetingText.key(a), wb = new Set(MeetingText.key(b));
    if (!wa.length) return 0;
    return wa.filter((w) => wb.has(w)).length / wa.length;
  },

  isEcho(text: string, start: number, end: number, guestSpans: { start: number; end: number }[], guestLines: { at: number; text: string }[]): boolean {
    if (EchoFilter.overlap({ start, end }, guestSpans) >= 0.6) return true;
    return guestLines.some((l) => Math.abs(l.at - end) <= EchoFilter.WINDOW && EchoFilter.similarity(text, l.text) >= 0.6);
  },
};

/** At most `limit` Claude calls an hour. */
export class HourlyCap {
  used: number[] = [];
  constructor(readonly limit: number) {}
  allows(now = Date.now()) { return this.used.filter((t) => now - t < 3600_000).length < this.limit; }
  use(now = Date.now()) { this.used = [...this.used.filter((t) => now - t < 3600_000), now]; }
}

// ── What Claude is asked, and how its answers are read ──────────────────────────────────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");
/** 24-hour HH:mm:ss, whatever the system's clock setting. */
export const timeOf = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };

export const MeetingAI = {
  repliesPrompt: "You are a developer's sidekick in a work meeting (stand-up, planning, code review, incident, 1:1). You get the "
    + "recent conversation (Guest = colleagues, You = the user) and what a colleague just said to the user. Write 3 "
    + "replies the user could say right now, in the first person, in the conversation's language. Each is 3 to 12 words, "
    + "practical and concrete like a developer talking to teammates, and the three are clearly different (for example "
    + "a direct answer / a follow-up or commitment / a clarifying question, as fits). If the honest answer needs a fact "
    + "you don't know, one reply can be \"Let me check and get back to you\". Never mention being an AI. Each message is "
    + "independent: use only what it contains.\n"
    + "Reply with only JSON: {\"replies\": [\"…\", \"…\", \"…\"]}",

  summaryPrompt: "You take notes for a developer in a work meeting. You get the recent conversation (Guest = colleagues, You = the "
    + "user) and one new turn. Summarize the new turn in one short line (under 15 words), in the conversation's "
    + "language. Say whether it asks the user a question or makes a request of them. Say whether answering needs a "
    + "specific fact from the user's codebase or its git history (a config value, an endpoint, where something is "
    + "implemented, how a function behaves, when something changed); general or opinion questions don't. Each message "
    + "is independent: use only what it contains.\n"
    + "Reply with only JSON: {\"summary\": \"…\", \"question\": true|false, \"lookup\": true|false}",

  lookupPrompt: "A colleague asked the user this in a live meeting, and the user needs the answer from this codebase, fast. Look "
    + "in the code (read-only) and answer in 1-3 short spoken sentences the user can say, then the file:line references "
    + "on their own line. If the code doesn't tell, say so in one sentence. No preamble.",

  meetingPrompt: "You write meeting notes from a transcript (Guest = the other people, You = the user). Write Markdown in the "
    + "transcript's language with these sections: ## Overview (2-3 sentences), ## Key points, ## Questions asked, "
    + "## Action items (who does what; \"None\" if there are none). Be concise and factual. Output only the Markdown.",

  line(t: MeetingTurn) { return `[${timeOf(t.start)}] ${t.speaker}: ${t.text}`; },

  context(turns: MeetingTurn[]) { return turns.slice(-10).map(MeetingAI.line).join("\n"); },

  repliesMessage(context: MeetingTurn[], turn: MeetingTurn) {
    return (context.length ? `Recent conversation:\n${MeetingAI.context(context)}\n\n` : "") + `The guest just said: "${turn.text}"`;
  },

  summaryMessage(context: MeetingTurn[], turn: MeetingTurn) {
    return (context.length ? `Recent conversation:\n${MeetingAI.context(context)}\n\n` : "") + `New turn (${turn.speaker}): "${turn.text}"`;
  },

  lookupMessage(context: MeetingTurn[], turn: MeetingTurn) {
    return (context.length ? `Recent conversation:\n${MeetingAI.context(context)}\n\n` : "") + `The colleague asked: "${turn.text}"`;
  },

  meetingMessage(turns: MeetingTurn[]) { return "Transcript:\n" + turns.map(MeetingAI.line).join("\n"); },

  /** The JSON object in a reply, tolerating ```json fences and prose around it. */
  object(text: string): Record<string, unknown> | null {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { const o = JSON.parse(text.slice(a, b + 1)); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; }
  },

  parseReplies(text: string): string[] | null {
    const list = MeetingAI.object(text)?.replies;
    if (!Array.isArray(list)) return null;
    const replies = list.filter((x): x is string => typeof x === "string")
      .map((s) => s.replace(/^[\s\-•*"]+|[\s\-•*"]+$/g, "")).filter(Boolean);
    return replies.length ? replies.slice(0, 3) : null;
  },

  parseSummary(text: string): { summary: string; question: boolean; lookup: boolean } | null {
    const j = MeetingAI.object(text);
    const s = typeof j?.summary === "string" ? j.summary.trim() : "";
    if (!j || !s) return null;
    return { summary: s, question: j.question === true, lookup: j.lookup === true };
  },

  /** The `result` text of a stream-json `result` line, or null for any other line. */
  resultOfStreamLine(line: string): string | null {
    if (!line.includes('"type":"result"')) return null;
    try { const o = JSON.parse(line); return typeof o?.result === "string" ? o.result : ""; } catch { return null; }
  },

  /** `--output-format json`: one result object, or every message in an array when verbose output is on. */
  resultOfJson(out: string): string | null {
    let parsed: any;
    try { parsed = JSON.parse(out); } catch { return null; }
    const obj = Array.isArray(parsed) ? [...parsed].reverse().find((m) => m?.type === "result") : parsed;
    if (!obj || obj.is_error === true || typeof obj.result !== "string") return null;
    return obj.result.trim() || null;
  },
};

// ── The notes file ────────────────────────────────────────────────────────────────────────────────────────────

export const MeetingFile = {
  /** The meeting's folder (notes.md, recording.m4a, meeting.json). */
  folderName(ms: number) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  },

  header(ms: number) {
    const d = new Date(ms);
    const day = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return `# Meeting notes · ${day} at ${two(d.getHours())}:${two(d.getMinutes())}\n\n## Transcript\n\n`;
  },

  entry(t: MeetingTurn, summary: string | null | undefined, replies: string[]) {
    let s = `**${t.speaker}** · ${timeOf(t.start)}\n${t.text}\n`;
    if (summary) s += `> ${summary}\n`;
    if (replies.length) s += "\nReply options:\n" + replies.map((r) => `- ${r}\n`).join("");
    return s + "\n";
  },

  /** The meeting summary goes above the transcript. */
  withSummary(file: string, summary: string) {
    const i = file.indexOf("## Transcript");
    if (i < 0) return file + "\n" + summary + "\n";
    return file.slice(0, i) + summary.trim() + "\n\n" + file.slice(i);
  },
};

/** Mixing the two recorded tracks (s16 PCM) into one: the guest and you, summed and clipped. */
export function mixTracks(a: Buffer, b: Buffer): Buffer {
  const n = Math.max(a.length, b.length) >> 1;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = (i * 2 + 1 < a.length ? a.readInt16LE(i * 2) : 0) + (i * 2 + 1 < b.length ? b.readInt16LE(i * 2) : 0);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

/** What a past meeting needs to be shown and played again (meeting.json, the same schema as the Mac's). */
export interface MeetingRecord {
  started: string;                 // ISO 8601
  project: string;
  rows: { speaker: string; offset: number; text: string; summary?: string | null; replies: string[]; code?: string | null }[];
  overview?: string | null;
}

/** The row being played at `time` seconds (the last one that started by then). */
export function currentRow(offsets: number[], time: number): number | null {
  for (let i = offsets.length - 1; i >= 0; i--) if (offsets[i] <= time + 0.05) return i;
  return null;
}
