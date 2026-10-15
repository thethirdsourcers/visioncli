import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { SystemAudio } from "../../contracts";
import { RATE, wavFile } from "../../audio/wav";
import { log } from "../../log";
import { SUP } from "../../paths";
import { settings } from "../../settings";
import { HomeProject } from "../home";
import { type ClaudeWorker, WarmClaude, WarmPool, lookupArgs, runOnce, summaryArgs } from "./claude";
import {
  EchoFilter, HourlyCap, MeetingAI, MeetingFile, type MeetingRecord, type MeetingSpeaker, MeetingText, type MeetingTurn,
  Segmenter, TurnBuilder, peak,
} from "./core";
import { MEETINGS_DIR, TrackRecorder, mixFolder, recordingIn } from "./recording";

// Meeting Notes (MeetingNotes.swift): a note-taker for work meetings. What the computer plays is the guest (your
// colleagues), the microphone is you. Both are transcribed locally and grouped into turns; each colleague's turn gets
// a one-line summary, and when a colleague asks you something, three short replies appear once they've finished
// talking (and, for questions about the code, an answer looked up in the project). Everything goes into a Markdown
// file per meeting, with a summary at the end and a recording. The panel (ui/meeting) shows `view()`.

export type Lookup = { state: "looking" } | { state: "found"; text: string } | { state: "failed" };

export interface MeetingRow {
  id: number;
  speaker: MeetingSpeaker;
  start: number;             // ms
  text: string;
  open: boolean;             // the speaker may still go on
  summary: string | null;
  summarizing: boolean;
  question: boolean;
  replies: string[];
  repliesLoading: boolean;
  lookup: Lookup | null;
}

export interface MeetingOptions {
  summarizeGuest: boolean;
  summarizeYou: boolean;
  replies: boolean;
  codeLookup: boolean;
  record: boolean;
}

export const meetingOptions = (): MeetingOptions => ({
  summarizeGuest: settings.get("meetingSummarizeGuest"),
  summarizeYou: settings.get("meetingSummarizeYou"),
  replies: settings.get("meetingReplies"),
  codeLookup: settings.get("meetingCodeLookup"),
  record: settings.get("meetingRecord"),
});

export interface MeetingView {
  isOn: boolean;
  startedAt: number | null;
  rows: MeetingRow[];
  guestSpeaking: boolean;
  youSpeaking: boolean;
  overview: string | null;
  finishing: boolean;
  mixing: boolean;
  project: string;
  engine: string;
  folder: string | null;
  audio: string | null;      // the recording (a path), once mixed
}

export interface MeetingDeps {
  system: SystemAudio;
  mic: SystemAudio;
  /** Transcribes a 16 kHz WAV with the local engine; "" when nothing usable. */
  transcribe(wav: string): Promise<string>;
  /** The microphone is busy elsewhere (you're holding Alt to ask VisionCLI something). */
  micPaused(): boolean;
  claude: string;
  path: string;
  options?(): MeetingOptions;
  /** Workers for the reply/summary pools (tests); default: warm `claude -p` processes. */
  worker?(label: "replies" | "summaries", systemPrompt: string): ClaudeWorker;
  /** The code lookup / meeting summary runner (tests); default: one-shot `claude -p`. */
  runOnce?: typeof runOnce;
  dir?: string;
  now?(): number;
}

export class MeetingNotes extends EventEmitter {
  static readonly PARALLEL_LOOKUPS = 3;
  rows: MeetingRow[] = [];
  isOn = false;
  startedAt: number | null = null;
  guestSpeaking = false;
  youSpeaking = false;
  overview: string | null = null;
  finishing = false;
  mixing = false;
  project = "";
  engine = "";
  folder: string | null = null;
  audio: string | null = null;

  private systemSeg = new Segmenter();
  private micSeg = new Segmenter();
  private turns = new TurnBuilder();
  private closed: MeetingTurn[] = [];
  private jobs: { speaker: MeetingSpeaker; pcm: Buffer; start: number; end: number }[] = [];
  private transcribing = false;
  private guestSpans: { start: number; end: number }[] = [];
  private guestLines: { at: number; text: string }[] = [];
  private guestSpeechSince: number | null = null;  // the guest is mid-utterance since then
  private lastSystemPcm = 0;
  private replyGen = new Map<number, number>();   // turn id → the request whose replies count
  private lookups: { turn: number; proc: ChildProcess | null }[] = [];
  private cap = new HourlyCap(200);
  private timer: NodeJS.Timeout | null = null;
  private count = 0;
  private replies: WarmPool | null = null;
  private summaries: WarmPool | null = null;
  private guestTrack: TrackRecorder | null = null;
  private youTrack: TrackRecorder | null = null;
  private heardSamples: Record<MeetingSpeaker, number> = { Guest: 0, You: 0 };
  private peaks: Record<MeetingSpeaker, number> = { Guest: 0, You: 0 };
  private lastLevelLog = 0;
  private changeQueued = false;

  constructor(private deps: MeetingDeps) { super(); }

  private now() { return this.deps.now?.() ?? Date.now(); }
  private opts() { return (this.deps.options ?? meetingOptions)(); }
  private get dir() { return this.deps.dir ?? MEETINGS_DIR; }
  private get work() { return join(this.deps.dir ? join(this.deps.dir, "..") : SUP, "meeting-ai"); }

  view(): MeetingView {
    return {
      isOn: this.isOn, startedAt: this.startedAt, rows: this.rows, guestSpeaking: this.guestSpeaking, youSpeaking: this.youSpeaking,
      overview: this.overview, finishing: this.finishing, mixing: this.mixing, project: this.project, engine: this.engine,
      folder: this.folder, audio: this.audio,
    };
  }

  /** Coalesced: the panel redraws once per tick, however many rows changed. */
  private changed() {
    if (this.changeQueued) return;
    this.changeQueued = true;
    setImmediate(() => { this.changeQueued = false; this.emit("change", this.view()); });
  }

  // ── Start and stop ──────────────────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isOn) return;
    const now = this.now();
    const folder = join(this.dir, MeetingFile.folderName(now));
    mkdirSync(folder, { recursive: true });
    mkdirSync(this.work, { recursive: true });
    // The tracks exist before the audio starts flowing.
    if (this.opts().record) {
      this.guestTrack = new TrackRecorder(join(folder, "guest.pcm"), now);
      this.youTrack = new TrackRecorder(join(folder, "you.pcm"), now);
    }
    try {
      await this.deps.system.start((pcm) => this.systemPcm(pcm));
    } catch (e) {
      this.discardTracks(folder);
      log(`meeting: couldn't capture system audio: ${(e as Error).message}`);
      throw new Error(`Couldn't hear your computer's sound (${(e as Error).message}).`);
    }
    try {
      await this.deps.mic.start((pcm) => this.micPcm(pcm));
    } catch (e) {
      // Still useful without it: the guest's side, summaries and replies.
      log(`meeting: no microphone (${(e as Error).message}); guest only`);
    }
    this.begin(now, folder);
  }

  private begin(now: number, folder: string) {
    this.rows = [];
    this.closed = [];
    this.turns = new TurnBuilder();
    this.jobs = [];
    this.guestSpans = [];
    this.guestLines = [];
    this.overview = null;
    this.finishing = false;
    this.replyGen.clear();
    this.audio = null;
    this.startedAt = now;
    this.folder = folder;
    this.isOn = true;
    this.systemSeg.reset();
    this.micSeg.reset();
    this.lastLevelLog = now;
    const make = this.deps.worker ?? ((label: "replies" | "summaries", systemPrompt: string) =>
      new WarmClaude({ label, claude: this.deps.claude, path: this.deps.path, systemPrompt, cwd: this.work }));
    this.replies = new WarmPool(() => make("replies", MeetingAI.repliesPrompt));
    this.summaries = new WarmPool(() => make("summaries", MeetingAI.summaryPrompt));
    this.replies.warm();
    this.summaries.warm();
    this.timer = setInterval(() => this.tick(), 400);
    this.timer.unref?.();
    this.writeFile();
    log(`meeting: on (project ${this.project})`);
    this.changed();
  }

  /** Stops listening, then writes the meeting summary at the top of the notes and mixes the recording. */
  stop() {
    if (!this.isOn) return;
    this.isOn = false;
    this.deps.system.stop();
    this.deps.mic.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.guestSpeaking = this.youSpeaking = false;
    this.jobs = [];
    const t = this.turns.finish();
    if (t) this.finalize(t);
    this.replies?.stop();
    this.summaries?.stop();
    for (const l of this.lookups) l.proc?.kill();
    this.lookups = [];
    log(`meeting: off, ${this.closed.length} turns`);
    this.summarizeMeeting();
    void this.mixRecording();
    this.changed();
  }

  // ── Audio → utterances ──────────────────────────────────────────────────────────────────────────────────────

  systemPcm(pcm: Buffer) {
    if (!this.isOn) return;
    this.lastSystemPcm = this.now();
    this.guestTrack?.write(pcm, this.now());
    this.level("Guest", pcm);
    const out = this.systemSeg.push(pcm);
    if (this.systemSeg.inSpeech !== this.guestSpeaking) {
      this.guestSpeaking = this.systemSeg.inSpeech;
      this.guestSpeechSince = this.guestSpeaking ? this.now() - ((pcm.length >> 1) / RATE) * 1000 : null;
      this.changed();
    }
    for (const u of out) this.utterance("Guest", u);
  }

  micPcm(pcm: Buffer) {
    if (!this.isOn) return;
    // While you hold Alt you're talking to VisionCLI, not the meeting.
    if (this.deps.micPaused()) { this.micSeg.reset(); return; }
    this.youTrack?.write(pcm, this.now());
    this.level("You", pcm);
    const out = this.micSeg.push(pcm);
    if (this.micSeg.inSpeech !== this.youSpeaking) { this.youSpeaking = this.micSeg.inSpeech; this.changed(); }
    for (const u of out) this.utterance("You", u);
  }

  private level(s: MeetingSpeaker, pcm: Buffer) {
    this.heardSamples[s] += pcm.length >> 1;
    this.peaks[s] = Math.max(this.peaks[s], peak(pcm));
  }

  private utterance(speaker: MeetingSpeaker, pcm: Buffer) {
    const end = this.now();
    const start = end - ((pcm.length >> 1) / RATE) * 1000;
    if (speaker === "Guest") {
      this.guestSpans.push({ start, end });
      this.guestSpans = this.guestSpans.filter((s) => end - s.end <= 60_000);
    }
    this.jobs.push({ speaker, pcm, start, end });
    void this.transcribeNext();
  }

  /** One utterance at a time, in the order they were heard. */
  private async transcribeNext() {
    if (this.transcribing || !this.isOn || !this.jobs.length) return;
    const job = this.jobs.shift()!;
    this.transcribing = true;
    const wav = join(this.work, `u${++this.count % 8}.wav`);
    let text = "";
    try {
      writeFileSync(wav, wavFile(job.pcm));
      text = await this.deps.transcribe(wav);
    } catch (e) {
      log(`meeting: transcription failed: ${(e as Error)?.message ?? e}`);
    } finally {
      rmSync(wav, { force: true });
      this.transcribing = false;
    }
    if (this.isOn) this.heard(job.speaker, text, job.start, job.end);
    void this.transcribeNext();
  }

  // ── Utterances → turns ──────────────────────────────────────────────────────────────────────────────────────

  /** A transcribed utterance (also the entry point for tests). */
  heard(speaker: MeetingSpeaker, raw: string, start: number, end: number) {
    const text = raw.trim();
    if (MeetingText.isJunk(text)) return;
    // The guest's utterance still in progress counts too: its words may be transcribed after the mic's echo of them.
    const spans = this.guestSpeechSince === null ? this.guestSpans : [...this.guestSpans, { start: this.guestSpeechSince, end: this.now() }];
    if (speaker === "You" && EchoFilter.isEcho(text, start, end, spans, this.guestLines)) {
      log(`meeting: dropped mic echo: ${text.slice(0, 80)}`);
      return;
    }
    if (speaker === "Guest") {
      this.guestLines.push({ at: end, text });
      this.guestLines = this.guestLines.filter((l) => end - l.at <= 60_000);
      // They went on before the replies to what they'd said arrived: it's still the same turn.
      const last = this.closed[this.closed.length - 1];
      const row = last && this.rows.find((r) => r.id === last.id);
      if (!this.turns.open && last?.speaker === "Guest" && row && (row.repliesLoading || (!row.replies.length && row.summarizing))) {
        this.closed.pop();
        this.replyGen.set(last.id, (this.replyGen.get(last.id) ?? 0) + 1);
        row.open = true;
        row.repliesLoading = false;
        row.summarizing = false;
        this.turns.reopen({ ...last, end: start }); // so this utterance joins it
      }
    }
    log(`meeting: ${speaker}: ${text.slice(0, 120)}`);
    const done = this.turns.add(speaker, text, start, end);
    if (done) this.finalize(done);
    if (this.turns.open) this.show(this.turns.open);
  }

  tick() {
    const now = this.now();
    // Every 15 s: is audio arriving from each side, and how loud (a silent side is the first thing to check).
    if (this.isOn && now - this.lastLevelLog >= 15_000) {
      this.lastLevelLog = now;
      const line = (s: MeetingSpeaker) => `${s} ${(this.heardSamples[s] / RATE).toFixed(1)}s peak ${this.peaks[s].toFixed(3)}`;
      log(`meeting: audio in the last 15 s: ${line("Guest")}, ${line("You")}`);
      this.heardSamples = { Guest: 0, You: 0 };
      this.peaks = { Guest: 0, You: 0 };
    }
    // Some outputs' monitors stop sending anything once playback stops (a suspended sink): that silence still ends
    // the guest's utterance.
    if (this.isOn && this.guestSpeaking && now - this.lastSystemPcm > 500) {
      const ms = Math.min(1000, now - this.lastSystemPcm);
      this.systemPcm(Buffer.alloc(Math.round((ms / 1000) * RATE) * 2));
    }
    const open = this.turns.open;
    if (!this.isOn || !open) return;
    const talking = open.speaker === "Guest" ? this.guestSpeaking : this.youSpeaking;
    const pending = this.transcribing || this.jobs.some((j) => j.speaker === open.speaker);
    const t = this.turns.close(now, talking || pending);
    if (t) this.finalize(t);
  }

  private show(t: MeetingTurn) {
    const row = this.rows.find((r) => r.id === t.id);
    if (row) row.text = t.text;
    else this.rows.push({ id: t.id, speaker: t.speaker, start: t.start, text: t.text, open: true, summary: null, summarizing: false,
      question: false, replies: [], repliesLoading: false, lookup: null });
    this.changed();
  }

  // ── Turns → summaries, replies, lookups ─────────────────────────────────────────────────────────────────────

  private finalize(t: MeetingTurn) {
    this.show(t);
    this.closed.push(t);
    const row = this.rows.find((r) => r.id === t.id);
    if (!row) return;
    row.open = false;
    const context = this.closed.slice(0, -1).slice(-10);
    const o = this.opts();
    if (t.speaker === "Guest" && o.replies && MeetingText.isQuestion(t.text)) this.askReplies(t, context);
    // Your own turns only when asked for (they're always in the notes and the meeting summary). A colleague's turn
    // is still read when its summary is off: that's how requests the word check missed get replies, and code
    // questions get looked up.
    const guest = t.speaker === "Guest";
    if (guest ? o.summarizeGuest || o.replies || o.codeLookup : o.summarizeYou) this.summarize(t, context);
    this.writeFile();
    this.changed();
  }

  private askReplies(t: MeetingTurn, context: MeetingTurn[]) {
    if (!this.replies || !this.cap.allows(this.now())) return;
    this.cap.use(this.now());
    const gen = (this.replyGen.get(t.id) ?? 0) + 1;
    this.replyGen.set(t.id, gen);
    this.update(t.id, (r) => { r.repliesLoading = true; r.question = true; });
    const started = Date.now();
    this.replies.ask(MeetingAI.repliesMessage(context, t), (result) => {
      if (this.replyGen.get(t.id) !== gen) return;
      const list = (result && MeetingAI.parseReplies(result)) || [];
      log(`meeting: replies in ${Date.now() - started}ms after the turn ended: ${list.length}`);
      this.update(t.id, (r) => { r.repliesLoading = false; r.replies = list; });
      this.writeFile();
    });
  }

  private summarize(t: MeetingTurn, context: MeetingTurn[]) {
    if (!this.summaries || !this.cap.allows(this.now())) return;
    this.cap.use(this.now());
    const gen = this.replyGen.get(t.id) ?? 0;
    const show = () => (t.speaker === "Guest" ? this.opts().summarizeGuest : this.opts().summarizeYou);
    if (show()) this.update(t.id, (r) => { r.summarizing = true; });
    this.summaries.ask(MeetingAI.summaryMessage(context, t), (result) => {
      if ((this.replyGen.get(t.id) ?? 0) !== gen) return;
      const s = result ? MeetingAI.parseSummary(result) : null;
      this.update(t.id, (r) => { r.summarizing = false; r.summary = show() ? s?.summary ?? null : null; });
      if (s && t.speaker === "Guest" && s.question) {
        // A request the word check missed ("let me know the ETA…"): replies now.
        const row = this.rows.find((r) => r.id === t.id);
        if (this.opts().replies && row && !row.repliesLoading && !row.replies.length) this.askReplies(t, context);
        if (s.lookup && this.opts().codeLookup) this.lookUp(t, context);
      }
      this.writeFile();
    });
  }

  /** The answer from the code: read-only Claude in the project. Several run at once (one per question); past
   *  PARALLEL_LOOKUPS, the oldest gives way to the newest. */
  private lookUp(t: MeetingTurn, context: MeetingTurn[]) {
    if (!this.project || this.project === HomeProject.path || !existsSync(this.project)) return;
    if (this.lookups.length >= MeetingNotes.PARALLEL_LOOKUPS) {
      const old = this.lookups.shift()!;
      old.proc?.kill();
      this.update(old.turn, (r) => { if (r.lookup?.state === "looking") r.lookup = null; });
    }
    this.update(t.id, (r) => { r.lookup = { state: "looking" }; });
    const started = Date.now();
    const proc = (this.deps.runOnce ?? runOnce)({
      claude: this.deps.claude, path: this.deps.path, args: lookupArgs(), cwd: this.project,
      prompt: MeetingAI.lookupMessage(context, t), timeout: 45_000,
    }, (text) => {
      const i = this.lookups.findIndex((l) => l.turn === t.id);
      if (i < 0) return;
      this.lookups.splice(i, 1);
      log(`meeting: code lookup in ${Date.now() - started}ms: ${text ? "found" : "nothing"}`);
      this.update(t.id, (r) => { r.lookup = text ? { state: "found", text } : { state: "failed" }; });
      this.writeFile();
    });
    this.lookups.push({ turn: t.id, proc });
  }

  private update(id: number, change: (r: MeetingRow) => void) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return;
    change(r);
    this.changed();
  }

  // ── The notes file ──────────────────────────────────────────────────────────────────────────────────────────

  record(): MeetingRecord | null {
    if (this.startedAt === null) return null;
    const started = this.startedAt;
    return {
      started: new Date(started).toISOString(), project: this.project, overview: this.overview,
      rows: this.rows.filter((r) => !r.open).map((r) => ({
        speaker: r.speaker, offset: (r.start - started) / 1000, text: r.text, summary: r.summary, replies: r.replies,
        code: r.lookup?.state === "found" ? r.lookup.text : null,
      })),
    };
  }

  private writeFile() {
    if (!this.folder || this.startedAt === null) return;
    let text = MeetingFile.header(this.startedAt);
    for (const r of this.rows) {
      if (r.open) continue;
      text += MeetingFile.entry({ id: r.id, speaker: r.speaker, start: r.start, end: r.start, text: r.text }, r.summary, r.replies);
      if (r.lookup?.state === "found") text += `From the code:\n${r.lookup.text}\n\n`;
    }
    if (this.overview) text = MeetingFile.withSummary(text, this.overview);
    try {
      writeFileSync(join(this.folder, "notes.md"), text);
      writeFileSync(join(this.folder, "meeting.json"), JSON.stringify(this.record(), null, 2));
    } catch (e) { log(`meeting: can't write the notes: ${(e as Error).message}`); }
  }

  private summarizeMeeting() {
    this.writeFile();
    if (!this.closed.length) return;
    this.finishing = true;
    (this.deps.runOnce ?? runOnce)({
      claude: this.deps.claude, path: this.deps.path, args: summaryArgs(), cwd: this.work,
      prompt: MeetingAI.meetingMessage(this.closed), timeout: 120_000,
    }, (text) => {
      this.finishing = false;
      this.overview = text;
      this.writeFile();
      log(`meeting: summary ${text ? "written" : "failed"}`);
      this.changed();
    });
  }

  // ── Recording ───────────────────────────────────────────────────────────────────────────────────────────────

  private discardTracks(folder: string) {
    this.guestTrack?.close();
    this.youTrack?.close();
    this.guestTrack = this.youTrack = null;
    rmSync(folder, { recursive: true, force: true });
  }

  private async mixRecording() {
    const g = this.guestTrack, y = this.youTrack, folder = this.folder;
    this.guestTrack = this.youTrack = null;
    if (!g || !y || !folder) return;
    const end = this.now();
    g.catchUp(end); y.catchUp(end);
    g.close(); y.close();
    this.mixing = true;
    this.changed();
    try { this.audio = await mixFolder(folder); } catch (e) { log(`meeting: mixing failed: ${(e as Error).message}`); }
    this.mixing = false;
    log("meeting: recording saved");
    this.changed();
  }

  /** Shows a past meeting (not while one is running). */
  load(folder: string, record: MeetingRecord) {
    if (this.isOn) return;
    const started = Date.parse(record.started);
    this.folder = folder;
    this.startedAt = started;
    this.project = record.project;
    this.overview = record.overview ?? null;
    this.finishing = false;
    this.rows = record.rows.map((r, i) => ({
      id: i + 1, speaker: r.speaker === "You" ? "You" : "Guest", start: started + r.offset * 1000, text: r.text, open: false,
      summary: r.summary ?? null, summarizing: false, question: false, replies: r.replies ?? [], repliesLoading: false,
      lookup: r.code ? { state: "found", text: r.code } : null,
    }));
    this.audio = recordingIn(folder);
    this.changed();
  }
}
