import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isBluetoothInput, meetingMic, systemCaptureCommands } from "../../src/main/audio/index";
import { WinMicStream, WinSystemAudio } from "../../src/main/audio/win32";
import { engineLabel } from "../../src/main/app/meeting";
import { type ClaudeWorker, WarmPool, lookupArgs, summaryArgs } from "../../src/main/features/meeting/claude";
import {
  EchoFilter, HourlyCap, MeetingAI, MeetingFile, type MeetingTurn, MeetingText, Segmenter, TurnBuilder, currentRow, mixTracks, timeOf,
} from "../../src/main/features/meeting/core";
import { MeetingNotes, type MeetingOptions } from "../../src/main/features/meeting/notes";
import { TrackRecorder, mixFolder, pastMeetings, recoverRecordings } from "../../src/main/features/meeting/recording";
import { fakeHelper, tick } from "../win-backends/fake";

/** `ms` of 16 kHz PCM: a 220 Hz tone at `amp` (0 = silence). */
function tone(ms: number, amp: number): Buffer {
  const n = (16000 * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * amp * 32767), i * 2);
  return b;
}

describe("Meeting Notes: the pure parts (CoreMeeting.swift)", () => {
  it("cuts speech into utterances: pre-roll, short sounds dropped, long monologues cut, reset", () => {
    let s = new Segmenter();
    const got = s.push(Buffer.concat([tone(1000, 0), tone(2000, 0.3), tone(1000, 0)]));
    assert.equal(got.length, 1, "one utterance from 2 s of speech");
    assert.ok(got[0].length / 32000 >= 2 && got[0].length / 32000 < 2.6);
    assert.equal(new Segmenter().push(Buffer.concat([tone(1000, 0), tone(400, 0.3), tone(1000, 0)])).length, 0, "under 0.8 s dropped");
    assert.equal(new Segmenter().push(tone(25_000, 0.3)).length, 1, "a 25 s monologue is cut at 20 s");
    assert.equal(new Segmenter().push(tone(3000, 0.005)).length, 0, "quiet hum isn't speech");
    s = new Segmenter();
    const all = Buffer.concat([tone(1000, 0), tone(1500, 0.3), tone(1000, 0)]);
    let pieces = 0;
    for (let i = 0; i < all.length; i += 2000) pieces += s.push(all.subarray(i, Math.min(i + 2000, all.length))).length;
    assert.equal(pieces, 1, "small chunks give the same utterance");
    s = new Segmenter();
    s.push(Buffer.concat([tone(1000, 0), tone(1000, 0.3)]));
    assert.ok(s.inSpeech);
    s.reset();
    assert.equal(s.push(tone(1000, 0)).length, 0, "reset drops the utterance in progress");
  });

  it("questions and junk", () => {
    assert.ok(MeetingText.isQuestion("What is the difference between a process and a thread?"));
    assert.ok(MeetingText.isQuestion("Why Java?"));
    assert.ok(MeetingText.isQuestion("So, tell me about your last project"));
    assert.ok(MeetingText.isQuestion("okay um how would you design a cache"));
    assert.ok(!MeetingText.isQuestion("I worked on the payments team for two years."));
    assert.ok(!MeetingText.isQuestion("Whatever you think is best here"));
    for (const j of ["[BLANK_AUDIO]", "Thank you.", "Okay.", " ... ", "(music)"]) assert.ok(MeetingText.isJunk(j), j);
    assert.ok(!MeetingText.isJunk("Tell me more."));
  });

  it("turns: same speaker merges, the other speaker or a pause closes, reopening goes on", () => {
    const tb = new TurnBuilder();
    assert.equal(tb.add("Guest", "Hi there.", 0, 1000), null);
    assert.equal(tb.add("Guest", "How are you?", 1500, 3000), null);
    assert.equal(tb.open?.text, "Hi there. How are you?");
    assert.equal(tb.close(4000, false), null, "not before the gap");
    assert.equal(tb.close(6000, true), null, "not while mid-utterance");
    const g = tb.add("You", "Good, thanks.", 3500, 4500);
    assert.equal(g?.text, "Hi there. How are you?");
    assert.equal(g?.end, 3000);
    assert.equal(tb.close(7000, false)?.speaker, "You");
    assert.equal(tb.open, null);
    tb.add("Guest", "One.", 10_000, 11_000);
    assert.equal(tb.add("Guest", "Two.", 14_000, 15_000)?.text, "One.", "after the gap: a new turn");
    assert.equal(tb.reopen({ id: 99, speaker: "Guest", start: 20_000, end: 21_000, text: "Why Java" })?.text, "Two.");
    tb.add("Guest", "over Kotlin?", 21_500, 22_000);
    assert.equal((tb.open as MeetingTurn | null)?.text, "Why Java over Kotlin?");
    assert.equal(tb.finish()?.id, 99);
  });

  it("echo, the hourly cap", () => {
    const spans = [{ start: 0, end: 4000 }];
    assert.ok(EchoFilter.isEcho("anything", 500, 3500, spans, []));
    assert.ok(!EchoFilter.isEcho("anything at all", 3000, 8000, spans, []));
    const lines = [{ at: 4000, text: "Can you tell me about your last project?" }];
    assert.ok(EchoFilter.isEcho("tell me about your last project", 10_000, 12_000, [], lines));
    assert.ok(!EchoFilter.isEcho("tell me about your last project", 30_000, 32_000, [], lines));
    assert.ok(!EchoFilter.isEcho("I built a payments system in Go", 5000, 7000, [], lines));
    assert.equal(EchoFilter.overlap({ start: 0, end: 10 }, [{ start: 2, end: 4 }, { start: 6, end: 7 }]), 0.3);
    const cap = new HourlyCap(2);
    cap.use(0); cap.use(1000);
    assert.ok(!cap.allows(2000));
    assert.ok(cap.allows(3_601_000));
  });

  it("prompts and parsing, including the lookup and both json shapes", () => {
    const g: MeetingTurn = { id: 1, speaker: "Guest", start: 0, end: 2000, text: "Why do you choose Java?" };
    const y: MeetingTurn = { id: 2, speaker: "You", start: 3000, end: 5000, text: "It's what the team knows." };
    const msg = MeetingAI.repliesMessage([y], g);
    assert.ok(msg.startsWith("Recent conversation:\n[") && msg.includes("You: It's what the team knows.") && msg.endsWith('The guest just said: "Why do you choose Java?"'));
    assert.equal(MeetingAI.summaryMessage([], y), 'New turn (You): "It\'s what the team knows."');
    assert.ok(MeetingAI.lookupMessage([], g).endsWith('asked: "Why do you choose Java?"'));
    const many = Array.from({ length: 15 }, (_, i): MeetingTurn => ({ id: i, speaker: "Guest", start: 0, end: 0, text: String(i) }));
    assert.equal(MeetingAI.context(many).split("\n").length, 10);
    assert.deepEqual(MeetingAI.parseReplies('```json\n{"replies": ["Yes, happy to.", " - No, sorry ", "", 4, "Which day?", "Extra"]}\n```'), ["Yes, happy to.", "No, sorry", "Which day?"]);
    assert.equal(MeetingAI.parseReplies('{"replies": []}'), null);
    assert.equal(MeetingAI.parseReplies("Sorry, I can't."), null);
    assert.deepEqual(MeetingAI.parseSummary('Here: {"summary": " Asks why Java ", "question": true}'), { summary: "Asks why Java", question: true, lookup: false });
    assert.equal(MeetingAI.parseSummary('{"summary": "x", "lookup": true}')?.lookup, true);
    assert.equal(MeetingAI.parseSummary('{"question": true}'), null);
    assert.equal(MeetingAI.resultOfStreamLine('{"type":"result","result":"{}"}'), "{}");
    assert.equal(MeetingAI.resultOfStreamLine('{"type":"assistant"}'), null);
    assert.equal(MeetingAI.resultOfJson('{"type":"result","result":" release.yml:354 "}'), "release.yml:354");
    assert.equal(MeetingAI.resultOfJson('[{"type":"system"},{"type":"result","result":"found it"}]'), "found it", "verbose: an array");
    assert.equal(MeetingAI.resultOfJson('[{"type":"result","result":""}]'), null, "an empty result (a hook kept it going)");
    assert.equal(MeetingAI.resultOfJson('{"type":"result","is_error":true,"result":"x"}'), null);
    assert.ok(lookupArgs().join(" ").includes("--setting-sources project --tools Read,Grep,Glob"), "read-only, no user hooks");
    assert.ok(summaryArgs().includes("--system-prompt"));
  });

  it("the notes file, mixing, the row being played, folder names", () => {
    const g: MeetingTurn = { id: 1, speaker: "Guest", start: new Date(2026, 9, 15, 10, 14, 38).getTime(), end: 0, text: "Why do you choose Java?" };
    assert.equal(MeetingFile.entry(g, "Asks why Java", ["Team skills.", "Ecosystem."]),
      "**Guest** · 10:14:38\nWhy do you choose Java?\n> Asks why Java\n\nReply options:\n- Team skills.\n- Ecosystem.\n\n");
    assert.equal(MeetingFile.withSummary("# Meeting notes · x\n\n## Transcript\n\nturns\n", "## Overview\nShort.\n"),
      "# Meeting notes · x\n\n## Overview\nShort.\n\n## Transcript\n\nturns\n");
    assert.equal(MeetingFile.folderName(new Date(2026, 9, 15, 9, 5, 3).getTime()), "2026-10-15 09-05-03");
    assert.equal(timeOf(new Date(2026, 0, 1, 21, 7, 9).getTime()), "21:07:09", "24-hour");
    const a = Buffer.alloc(6), b = Buffer.alloc(4);
    a.writeInt16LE(100, 0); a.writeInt16LE(30000, 2); a.writeInt16LE(-30000, 4);
    b.writeInt16LE(50, 0); b.writeInt16LE(10000, 2);
    const m = mixTracks(a, b);
    assert.deepEqual([m.readInt16LE(0), m.readInt16LE(2), m.readInt16LE(4)], [150, 32767, -30000]);
    assert.equal(currentRow([0, 4.5, 10], 5), 1);
    assert.equal(currentRow([0, 4.5, 10], 4.47), 1);
    assert.equal(currentRow([2, 4.5], 1), null);
  });
});

// ── The controller ──────────────────────────────────────────────────────────────────────────────────────────────

class FakeWorker implements ClaudeWorker {
  asked: { text: string; done: (r: string | null) => void }[] = [];
  warmed = 0;
  stopped = 0;
  get busy() { return this.asked.length > 0; }
  warm() { this.warmed++; }
  ask(text: string, done: (r: string | null) => void) { this.asked.push({ text, done }); }
  answer(r: string) { this.asked.shift()!.done(r); }
  stop() { this.stopped++; }
}

function setup(over: Partial<MeetingOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vcli-meeting-"));
  const meetings = join(dir, "meetings");
  const project = join(dir, "project");
  mkdirSync(project);
  let now = 1_000_000;
  const workers: Record<string, FakeWorker[]> = { replies: [], summaries: [] };
  const once: { args: string[]; cwd: string; prompt: string; done: (r: string | null) => void }[] = [];
  const opts: MeetingOptions = { summarizeGuest: true, summarizeYou: false, replies: true, codeLookup: true, record: false, ...over };
  const m = new MeetingNotes({
    system: { start: async () => {}, stop: () => {} },
    mic: { start: async () => {}, stop: () => {} },
    transcribe: async () => "",
    micPaused: () => false,
    claude: "claude", path: "",
    options: () => opts,
    worker: (label) => { const w = new FakeWorker(); workers[label].push(w); return w; },
    runOnce: (o, done) => { once.push({ args: o.args, cwd: o.cwd, prompt: o.prompt, done }); return null; },
    dir: meetings,
    now: () => now,
  });
  m.project = project;
  return { m, workers, once, opts, project, meetings, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe("Meeting Notes: the controller (MeetingNotes.swift)", () => {
  it("a colleague's question: summary and three replies once they've finished; your turn isn't summarized", async () => {
    const { m, workers, advance, at } = setup();
    await m.start();
    assert.equal(workers.replies[0].warmed, 1, "a reply process is ready before the first question");
    m.heard("Guest", "Morning. Can you push the release fix before lunch?", at() - 2000, at());
    assert.equal(m.rows.length, 1);
    assert.equal(m.rows[0].open, true);
    advance(2100);
    m.tick();
    assert.equal(m.rows[0].open, false);
    const r = workers.replies[0];
    assert.equal(r.asked.length, 1);
    assert.ok(r.asked[0].text.endsWith('The guest just said: "Morning. Can you push the release fix before lunch?"'));
    assert.equal(m.rows[0].repliesLoading, true);
    r.answer('{"replies": ["Yes, before noon.", "Can it wait till 2?", "Which fix?"]}');
    assert.deepEqual(m.rows[0].replies, ["Yes, before noon.", "Can it wait till 2?", "Which fix?"]);
    workers.summaries[0].answer('{"summary": "Asks to push the fix before lunch", "question": true}');
    assert.equal(m.rows[0].summary, "Asks to push the fix before lunch");
    // Your own turn: in the notes, not summarized (the default).
    m.heard("You", "Sure, I'll do it now.", at() + 500, at() + 2000);
    advance(5000);
    m.tick();
    assert.equal(m.rows[1].open, false);
    assert.equal(workers.summaries[0].asked.length, 0);
    assert.equal(m.rows[1].summarizing, false);
    m.stop();
  });

  it("with colleague summaries off, their turn is still read: replies for a missed request, and a code lookup", async () => {
    const { m, workers, once, advance, at, project } = setup({ summarizeGuest: false });
    await m.start();
    m.heard("Guest", "Let me know which workflow publishes the winget package.", at() - 2000, at());
    advance(2100);
    m.tick();
    assert.equal(workers.replies[0].asked.length, 0, "not a question by its words");
    assert.equal(m.rows[0].summarizing, false, "no summary shown");
    workers.summaries[0].answer('{"summary": "Asks which workflow publishes winget", "question": true, "lookup": true}');
    assert.equal(m.rows[0].summary, null);
    assert.equal(workers.replies[0].asked.length, 1, "replies after all");
    assert.equal(once.length, 1);
    assert.equal(once[0].cwd, project);
    assert.ok(once[0].args.includes("Read,Grep,Glob"));
    assert.equal(m.rows[0].lookup?.state, "looking");
    once[0].done("The winget job in release.yml.\n.github/workflows/release.yml:354");
    assert.deepEqual(m.rows[0].lookup, { state: "found", text: "The winget job in release.yml.\n.github/workflows/release.yml:354" });
    m.stop();
  });

  it("lookups run side by side; past three, the oldest gives way", async () => {
    const { m, workers, once, advance, at } = setup();
    await m.start();
    for (let i = 0; i < 4; i++) {
      m.heard("Guest", `Where is endpoint number ${i} implemented?`, at() - 1000, at());
      advance(2100);
      m.tick();
      workers.summaries.find((w) => w.busy)!.answer('{"summary": "x", "question": true, "lookup": true}');
      // Replies in, so the next question is a new turn (not the same one going on).
      for (const w of workers.replies) while (w.busy) w.answer('{"replies": ["ok"]}');
      advance(3000);
    }
    assert.equal(once.length, 4);
    assert.equal(m.rows[0].lookup, null, "the oldest gave way");
    assert.deepEqual(m.rows.slice(1).map((r) => r.lookup?.state), ["looking", "looking", "looking"]);
    m.stop();
  });

  it("the guest goes on before the replies arrive: the same turn, and the stale replies are dropped", async () => {
    const { m, workers, advance, at } = setup();
    await m.start();
    m.heard("Guest", "Why do you choose Java?", at() - 1000, at());
    advance(2100);
    m.tick();
    assert.equal(m.rows[0].repliesLoading, true);
    m.heard("Guest", "Over Kotlin, I mean.", at(), at() + 1500);
    assert.equal(m.rows.length, 1);
    assert.equal(m.rows[0].open, true);
    assert.equal(m.rows[0].text, "Why do you choose Java? Over Kotlin, I mean.");
    workers.replies[0].answer('{"replies": ["stale"]}');
    assert.deepEqual(m.rows[0].replies, []);
    advance(4000);
    m.tick();
    const w = workers.replies.find((x) => x.busy)!;
    assert.ok(w.asked[0].text.includes("Over Kotlin"));
    m.stop();
  });

  it("drops the mic's echo of the speakers", async () => {
    const { m, at, advance } = setup();
    await m.start();
    m.heard("Guest", "Can you tell me about your last project?", at() - 3000, at());
    m.heard("You", "tell me about your last project", at() + 1000, at() + 3000);
    assert.equal(m.rows.length, 1);
    // The guest is still talking (their words not transcribed yet): what the mic hears meanwhile is them.
    m.systemPcm(tone(2000, 0.3));
    assert.ok(m.guestSpeaking);
    m.heard("You", "Can you push the release fix before lunch today?", at() - 2000, at());
    assert.equal(m.rows.filter((r) => r.speaker === "You").length, 0);
    // The output stops sending anything (a suspended sink): the silence still ends their utterance.
    for (let i = 0; i < 3; i++) { advance(600); m.tick(); }
    assert.ok(!m.guestSpeaking);
    m.stop();
  });

  it("writes notes.md and meeting.json, the summary at the end, and loads a past meeting back", async () => {
    const { m, workers, once, advance, at, meetings } = setup();
    await m.start();
    m.heard("Guest", "Can you review my pull request today?", at() - 2000, at());
    advance(2100);
    m.tick();
    workers.replies[0].answer('{"replies": ["Yes, after lunch."]}');
    m.stop();
    const folder = m.folder!;
    assert.ok(folder.startsWith(meetings));
    const summary = once.find((o) => o.args.includes(summaryArgs()[summaryArgs().length - 1]))!;
    assert.ok(summary.prompt.startsWith("Transcript:\n["));
    summary.done("## Overview\nA review request.");
    const notes = readFileSync(join(folder, "notes.md"), "utf8");
    assert.match(notes, /^# Meeting notes · /);
    assert.ok(notes.indexOf("## Overview") < notes.indexOf("## Transcript"));
    assert.match(notes, /\*\*Guest\*\* · \d\d:\d\d:\d\d\nCan you review my pull request today\?/);
    assert.match(notes, /- Yes, after lunch\./);
    const rec = JSON.parse(readFileSync(join(folder, "meeting.json"), "utf8"));
    assert.equal(rec.rows[0].speaker, "Guest");
    assert.equal(typeof rec.rows[0].offset, "number");
    assert.equal(rec.overview, "## Overview\nA review request.");
    const past = pastMeetings(10, meetings);
    assert.equal(past.length, 1);
    const other = setup();
    other.m.load(past[0].folder, past[0].record);
    assert.equal(other.m.rows[0].text, "Can you review my pull request today?");
    assert.deepEqual(other.m.rows[0].replies, ["Yes, after lunch."]);
    assert.equal(other.m.overview, "## Overview\nA review request.");
  });
});

describe("Meeting Notes: recording", () => {
  it("tracks stay in step with the clock, mix into one recording, and leftovers are recovered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vcli-rec-"));
    const folder = join(dir, "2026-10-15 10-00-00");
    mkdirSync(folder);
    const start = 1_000_000;
    const g = new TrackRecorder(join(folder, "guest.pcm"), start);
    g.write(tone(100, 0.3), start + 100);
    g.write(tone(100, 0.3), start + 1100); // nothing played for 0.9 s: padded
    g.catchUp(start + 2000);
    g.close();
    assert.equal(readFileSync(join(folder, "guest.pcm")).length, 2 * 16000 * 2, "2 s of audio, gaps as silence");
    writeFileSync(join(folder, "you.pcm"), tone(500, 0.2));
    const out = await mixFolder(folder);
    assert.ok(out && existsSync(out) && /recording\.(m4a|wav)$/.test(out));
    assert.ok(!existsSync(join(folder, "guest.pcm")) && !existsSync(join(folder, "you.pcm")), "raw tracks removed");
    const left = join(dir, "2026-10-15 11-00-00");
    mkdirSync(left);
    writeFileSync(join(left, "guest.pcm"), tone(300, 0.3));
    await recoverRecordings(dir);
    assert.ok(!existsSync(join(left, "guest.pcm")));
    assert.ok(existsSync(join(left, "recording.m4a")) || existsSync(join(left, "recording.wav")));
  });
});

describe("Meeting Notes: processes, engine, microphone", () => {
  it("the pool: an idle worker takes the request, up to three run side by side", () => {
    const made: FakeWorker[] = [];
    const pool = new WarmPool(() => { const w = new FakeWorker(); made.push(w); return w; });
    pool.warm();
    assert.equal(made.length, 1);
    pool.ask("a", () => {});
    assert.equal(made[0].asked.length, 1);
    pool.ask("b", () => {});
    pool.ask("c", () => {});
    assert.equal(made.length, 3, "busy workers: new ones, up to three");
    pool.ask("d", () => {});
    assert.equal(made.length, 3, "then they queue");
    while (made[1].busy) made[1].answer("x");
    assert.equal(pool.pick(), made[1], "an idle one first");
    pool.stop();
    assert.ok(made.every((w) => w.stopped === 1));
  });

  it("the engine label follows the Voice setting", () => {
    assert.equal(engineLabel("parakeet"), "Parakeet");
    assert.equal(engineLabel("whisper:large-v3"), "Whisper large-v3");
    assert.equal(engineLabel("system"), "the system speech engine");
    assert.equal(engineLabel(null), "");
  });

  it("a Bluetooth headset's mic gives way to the computer's own", () => {
    const sony = { id: "bluez_input.80_99_E7", name: "WH-1000XM6", isDefault: true };
    const builtIn = { id: "alsa_input.pci-0000_00_1f.3.analog-stereo", name: "Built-in Audio Analog Stereo", isDefault: false };
    const winHeadset = { id: "1", name: "Headset (WH-1000XM6 Hands-Free)", isDefault: false };
    assert.ok(isBluetoothInput(sony) && isBluetoothInput(winHeadset) && !isBluetoothInput(builtIn));
    assert.deepEqual(meetingMic([sony, builtIn], null), { device: builtIn, swappedFrom: sony });
    assert.deepEqual(meetingMic([sony, builtIn], builtIn.id), { device: builtIn, swappedFrom: null });
    assert.deepEqual(meetingMic([sony], null), { device: sony, swappedFrom: null }, "no other mic: the headset");
    assert.deepEqual(meetingMic([], null), { device: null, swappedFrom: null });
  });

  it("Linux: the default output's monitor through parecord, else PipeWire's capture.sink", () => {
    const all = () => true;
    const cmds = systemCaptureCommands("alsa_output.pci", all, () => true);
    assert.equal(cmds[0].cmd, "parecord");
    assert.ok(cmds[0].args.includes("--device=alsa_output.pci.monitor"));
    assert.equal(cmds[1].cmd, "pw-record");
    assert.ok(cmds[1].args.includes("{ stream.capture.sink=true }") && cmds[1].args.includes("--raw"));
    const noSink = systemCaptureCommands(null, all, () => false);
    assert.deepEqual(noSink.map((c) => c.cmd), ["pw-record", "parecord"]);
    assert.ok(noSink[1].args.includes("--device=@DEFAULT_MONITOR@"));
    assert.deepEqual(systemCaptureCommands("x", () => false), []);
  });

  it("Windows: loopback and mic events become PCM; stop unsubscribes; a gone mic falls back to the default", async () => {
    const h = fakeHelper({
      "loopback.start": () => true, "loopback.stop": () => true,
      "micstream.start": (p: any) => { if (p.device === "7") throw new Error("gone"); return true; }, "micstream.stop": () => true,
    });
    const sys = new WinSystemAudio(h);
    const got: Buffer[] = [];
    await sys.start((b) => got.push(b));
    h.emit("loopback", { data: Buffer.from([1, 2, 3, 4]).toString("base64") });
    assert.deepEqual([...got[0]], [1, 2, 3, 4]);
    sys.stop();
    await tick();
    h.emit("loopback", { data: "AAA=" });
    assert.equal(got.length, 1);
    const mic = new WinMicStream(h, async () => "7");
    const heard: Buffer[] = [];
    await mic.start((b) => heard.push(b));
    assert.deepEqual(h.of("micstream.start"), [{ device: "7" }, { device: null }]);
    h.emit("mic", { data: Buffer.from([5, 6]).toString("base64") });
    assert.deepEqual([...heard[0]], [5, 6]);
    mic.stop();
    await tick();
    assert.equal(h.of("micstream.stop").length, 1);
  });
});
