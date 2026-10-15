import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { RATE, wavFile } from "../../audio/wav";
import { log } from "../../log";
import { SUP } from "../../paths";
import { run } from "../run";
import { type MeetingRecord, mixTracks } from "./core";

// The meeting's recording (MeetingCapture.TrackRecorder, MeetingNotes.mix on macOS): each source is written raw to
// its own file in step with the clock, mixed into one at the end and encoded small.

export const MEETINGS_DIR = join(SUP, "meetings");

/** Records one source to a raw 16 kHz s16 file, kept in step with the clock: gaps (nothing played, or the mic was
 *  paused while you held Alt) are written as silence, so both sources line up when mixed. */
export class TrackRecorder {
  private fd: number | null;
  private written = 0; // samples

  constructor(readonly file: string, private start: number) {
    try { this.fd = openSync(file, "w"); } catch (e) { log(`meeting: can't record ${file}: ${(e as Error).message}`); this.fd = null; }
  }

  /** Samples that end now. */
  write(pcm: Buffer, now = Date.now()) {
    if (this.fd === null) return;
    const samples = pcm.length >> 1;
    const due = Math.floor(((now - this.start) / 1000) * RATE) - samples;
    if (due - this.written > RATE / 10) this.pad(due - this.written);
    writeSync(this.fd, pcm, 0, samples * 2);
    this.written += samples;
  }

  /** Silence up to `now` (the source went quiet or was paused). */
  catchUp(now = Date.now()) {
    const due = Math.floor(((now - this.start) / 1000) * RATE);
    if (due > this.written) this.pad(due - this.written);
  }

  private pad(n: number) {
    if (this.fd === null || n <= 0) return;
    writeSync(this.fd, Buffer.alloc(n * 2));
    this.written += n;
  }

  close() { if (this.fd !== null) { try { closeSync(this.fd); } catch {} this.fd = null; } }
}

/** guest.pcm + you.pcm in `folder` → recording.m4a (AAC through ffmpeg when it's installed, else recording.wav);
 *  the raw tracks are then removed. Returns the recording, or null. */
export async function mixFolder(folder: string): Promise<string | null> {
  const g = join(folder, "guest.pcm"), y = join(folder, "you.pcm");
  const read = (f: string) => { try { return readFileSync(f); } catch { return Buffer.alloc(0); } };
  const pcm = mixTracks(read(g), read(y));
  rmSync(g, { force: true });
  rmSync(y, { force: true });
  if (!pcm.length) return null;
  const wav = join(folder, "recording.wav");
  writeFileSync(wav, wavFile(pcm));
  const m4a = join(folder, "recording.m4a");
  const r = await run("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", "48k", m4a], { timeout: 300_000 });
  if (r.code === 0 && existsSync(m4a)) { rmSync(wav, { force: true }); return m4a; }
  log(`meeting: no ffmpeg AAC (${r.err.trim().split("\n").pop() || r.code}); keeping the WAV`);
  return wav;
}

/** A meeting cut short (VisionCLI quit or crashed) left its raw tracks: make its recording now. */
export async function recoverRecordings(dir = MEETINGS_DIR) {
  let folders: string[] = [];
  try { folders = readdirSync(dir); } catch { return; }
  for (const f of folders) {
    const folder = join(dir, f);
    if (!existsSync(join(folder, "guest.pcm"))) continue;
    if (await mixFolder(folder)) log(`meeting: recovered the recording in ${f}`);
  }
}

/** Past meetings, newest first: the folders with a meeting.json. */
export function pastMeetings(limit = 15, dir = MEETINGS_DIR): { folder: string; record: MeetingRecord }[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: { folder: string; record: MeetingRecord }[] = [];
  for (const n of names) {
    try {
      const record = JSON.parse(readFileSync(join(dir, n, "meeting.json"), "utf8")) as MeetingRecord;
      if (record && typeof record.started === "string" && Array.isArray(record.rows)) out.push({ folder: join(dir, n), record });
    } catch {}
  }
  return out.sort((a, b) => Date.parse(b.record.started) - Date.parse(a.record.started)).slice(0, limit);
}

/** The recording of a meeting folder, if any. */
export function recordingIn(folder: string): string | null {
  for (const f of ["recording.m4a", "recording.wav", "recording.ogg"]) if (existsSync(join(folder, f))) return join(folder, f);
  return null;
}
