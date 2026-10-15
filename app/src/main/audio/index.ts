import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { AudioDevice, AudioDevices, Recorder, SystemAudio } from "../contracts";
import { log } from "../log";
import { RATE, level, streamHeaderLength, wavFile } from "./wav";
import { WinAudioDevices, WinMicStream, WinRecorder, WinSystemAudio } from "./win32";
import { winHelper } from "../desktop/windows/win32";

// The microphone and speakers (Listener's capture + WavRecorder, AudioDevices.swift) through the sound server's
// command-line tools, so it works on PipeWire, PulseAudio and plain ALSA alike: pw-record → parecord → arecord.
// The tools write raw 16 kHz mono s16 PCM to a pipe and the WAV is written here, so the level meter and live-caption
// snapshots come from the same stream.

// Windows: waveIn / waveOut through the helper (audio/win32.ts).
export function createRecorder(): Recorder { return process.platform === "win32" ? new WinRecorder(winHelper()) : new CliRecorder(); }
export function createAudioDevices(): AudioDevices { return process.platform === "win32" ? new WinAudioDevices(winHelper()) : new CliAudioDevices(); }

const whichCache = new Map<string, boolean>();
export function has(bin: string): boolean {
  if (!whichCache.has(bin)) whichCache.set(bin, spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0);
  return whichCache.get(bin)!;
}

/** Where device ids came from: Pulse/PipeWire names, or ALSA PCM names (only arecord/aplay understand those). */
let deviceKind: "pulse" | "alsa" = "pulse";

let pwRaw: boolean | undefined;
function pwSupportsRaw(): boolean {
  if (pwRaw === undefined) {
    const r = spawnSync("pw-record", ["--help"], { encoding: "utf8" });
    pwRaw = /--raw\b/.test((r.stdout ?? "") + (r.stderr ?? ""));
  }
  return pwRaw;
}

interface Command { cmd: string; args: string[] }

/** Capture commands to try, best first; ones that take the device come before the system default. */
export function captureCommands(device: string | null, avail: (bin: string) => boolean = has, raw = pwSupportsRaw): Command[] {
  const fmt = (dev: string | null): Command[] => {
    const out: Command[] = [];
    const pulseDev = dev && deviceKind === "pulse" ? dev : null;
    if (avail("pw-record") && raw() && (!dev || pulseDev))
      out.push({ cmd: "pw-record", args: ["--rate=16000", "--channels=1", "--format=s16", "--latency=20ms", "--raw", ...(pulseDev ? ["--target", pulseDev] : []), "-"] });
    if (avail("parecord") && (!dev || pulseDev))
      out.push({ cmd: "parecord", args: ["--raw", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=20", ...(pulseDev ? [`--device=${pulseDev}`] : [])] });
    if (avail("arecord") && (!dev || deviceKind === "alsa"))
      out.push({ cmd: "arecord", args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1", "--period-time=20000", ...(dev ? ["-D", dev] : [])] });
    // Older PipeWire without --raw: whatever it writes to the pipe, a WAV header is stripped below.
    if (avail("pw-record") && !raw() && (!dev || pulseDev))
      out.push({ cmd: "pw-record", args: ["--rate=16000", "--channels=1", "--format=s16", ...(pulseDev ? ["--target", pulseDev] : []), "-"] });
    return out;
  };
  return device ? [...fmt(device), ...fmt(null)] : fmt(null);
}

const LEVEL_BYTES = Math.round(RATE / 30) * 2; // ~30 level updates a second

class CliRecorder implements Recorder {
  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private file = "";
  private gen = 0;

  async start(file: string, device: string | null, onLevel?: (level: number) => void): Promise<void> {
    this.cancel();
    const gen = ++this.gen;
    this.file = file;
    this.chunks = [];
    this.bytes = 0;
    const cmds = captureCommands(device);
    if (!cmds.length) throw new Error("No audio recorder found: install pipewire (pw-record), pulseaudio-utils (parecord) or alsa-utils (arecord).");
    let lastError = "";
    for (const c of cmds) {
      if (gen !== this.gen) return;
      try {
        await this.tryStart(c, gen, onLevel);
        log(`recorder: ${c.cmd} ${device ?? "(default)"}`);
        return;
      } catch (e) {
        lastError = (e as Error).message;
        log(`recorder: ${c.cmd} ${device ?? "(default)"} failed: ${lastError}`);
      }
    }
    throw new Error(`Couldn't open the microphone (${lastError}).`);
  }

  private tryStart(c: Command, gen: number, onLevel?: (level: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(c.cmd, c.args, { stdio: ["ignore", "pipe", "pipe"] });
      let started = false, err = "";
      let head: Buffer | null = Buffer.alloc(0); // until the stream is known to be raw or its WAV header is skipped
      let odd: Buffer | null = null;
      let meter = Buffer.alloc(0);
      const timer = setTimeout(() => { if (!started) { p.kill("SIGKILL"); reject(new Error("no audio within 4 s")); } }, 4000);
      p.stderr!.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-400); });
      p.stdout!.on("data", (d: Buffer) => {
        if (gen !== this.gen) return;
        if (head) {
          head = Buffer.concat([head, d]);
          const n = streamHeaderLength(head);
          if (n < 0) return;
          d = head.subarray(n);
          head = null;
        }
        if (odd) { d = Buffer.concat([odd, d]); odd = null; }
        if (d.length & 1) { odd = Buffer.from(d.subarray(d.length - 1)); d = d.subarray(0, d.length - 1); }
        if (!d.length) return;
        this.chunks.push(Buffer.from(d));
        this.bytes += d.length;
        if (!started) { started = true; clearTimeout(timer); this.proc = p; resolve(); }
        if (onLevel) {
          meter = meter.length ? Buffer.concat([meter, d]) : d;
          while (meter.length >= LEVEL_BYTES) { onLevel(level(meter.subarray(0, LEVEL_BYTES))); meter = meter.subarray(LEVEL_BYTES); }
        }
      });
      p.on("error", (e) => { clearTimeout(timer); if (!started) reject(e); });
      p.on("exit", (code) => {
        clearTimeout(timer);
        if (!started) reject(new Error(err.trim().split("\n").pop() || `exited ${code}`));
        else if (this.proc === p && gen === this.gen) log(`recorder: ${c.cmd} stopped by itself (${code}) ${err.trim()}`);
      });
    });
  }

  async stop(): Promise<{ file: string; seconds: number }> {
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      // Let it flush what's buffered; a stuck tool is killed.
      await new Promise<void>((res) => {
        const t = setTimeout(() => { p.kill("SIGKILL"); res(); }, 600);
        p.once("exit", () => { clearTimeout(t); res(); });
        p.kill("SIGINT");
      });
    }
    this.gen++;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    await writeFile(this.file, wavFile(pcm));
    const seconds = pcm.length / (RATE * 2);
    log(`listener: recorded ${seconds.toFixed(1)}s`);
    return { file: this.file, seconds };
  }

  cancel() {
    this.gen++;
    this.proc?.kill("SIGKILL");
    this.proc = null;
    this.chunks = [];
    this.bytes = 0;
  }

  async snapshot(file: string): Promise<boolean> {
    if (!this.bytes) return false;
    try { await writeFile(file, wavFile(Buffer.concat(this.chunks))); return true; } catch { return false; }
  }
}

// ── devices ────────────────────────────────────────────────────────────────────────────────────────────────────

const run = (cmd: string, args: string[]) => new Promise<string | null>((res) => {
  execFile(cmd, args, { timeout: 4000, maxBuffer: 8 << 20 }, (e, out) => res(e ? null : out));
});

interface PulseNode { name: string; description?: string; monitor_source?: string; monitor_of_sink?: string; properties?: Record<string, string> }

/** `pactl -f json list sources|sinks` (PulseAudio 16+, pipewire-pulse). Monitors of outputs aren't microphones. */
export function parsePactlJson(json: string, kind: "sources" | "sinks", def: string | null): AudioDevice[] {
  const nodes = JSON.parse(json) as PulseNode[];
  return nodes
    .filter((n) => kind === "sinks" || !(n.properties?.["device.class"] === "monitor" || (n.monitor_of_sink && n.monitor_of_sink !== "n/a")))
    .map((n) => ({ id: n.name, name: n.description || n.properties?.["device.description"] || n.name, isDefault: n.name === def }));
}

/** `pactl list sources|sinks` text: "Source #1" blocks with "Name:", "Description:", "Monitor of Sink:". */
export function parsePactlText(text: string, kind: "sources" | "sinks", def: string | null): AudioDevice[] {
  const out: AudioDevice[] = [];
  for (const block of text.split(/\n(?=\S)/)) {
    const name = /^\s*Name:\s*(.+)$/m.exec(block)?.[1].trim();
    if (!name) continue;
    const monitorOf = /^\s*Monitor of Sink:\s*(.+)$/m.exec(block)?.[1].trim();
    if (kind === "sources" && ((monitorOf && monitorOf !== "n/a") || /device\.class = "monitor"/.test(block))) continue;
    const desc = /^\s*Description:\s*(.+)$/m.exec(block)?.[1].trim();
    out.push({ id: name, name: desc || name, isDefault: name === def });
  }
  return out;
}

/** `arecord -L` / `aplay -L`: PCM names at the start of a line, their description indented below. Only real sound
 *  cards (default, sysdefault:/plughw:) are listed, not ALSA's converter and mixer plugins (lavrate, speex, jack, oss,
 *  upmix…), which aren't microphones or speakers. */
export function parseAlsaList(text: string): AudioDevice[] {
  const out: AudioDevice[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i];
    if (!id || /^\s/.test(id) || !(id === "default" || /^(sysdefault|plughw|hw):/.test(id))) continue;
    const desc = lines[i + 1]?.startsWith(" ") ? lines[i + 1].trim() : id;
    // hw: only takes the card's own formats; plughw: converts to the 16 kHz mono we record.
    const dev = id.replace(/^hw:/, "plughw:");
    if (out.some((d) => d.id === dev)) continue;
    out.push({ id: dev, name: id === "default" ? "Default" : desc, isDefault: id === "default" });
  }
  return out;
}

async function pulseDefault(kind: "sources" | "sinks"): Promise<string | null> {
  const direct = await run("pactl", [kind === "sources" ? "get-default-source" : "get-default-sink"]);
  if (direct?.trim()) return direct.trim();
  const info = await run("pactl", ["info"]);
  const re = kind === "sources" ? /^Default Source:\s*(.+)$/m : /^Default Sink:\s*(.+)$/m;
  return (info && re.exec(info)?.[1].trim()) || null;
}

async function list(kind: "sources" | "sinks"): Promise<AudioDevice[]> {
  if (has("pactl")) {
    const def = await pulseDefault(kind);
    const json = await run("pactl", ["-f", "json", "list", kind]);
    if (json) { try { deviceKind = "pulse"; return parsePactlJson(json, kind, def); } catch {} }
    const text = await run("pactl", ["list", kind]);
    if (text) { deviceKind = "pulse"; return parsePactlText(text, kind, def); }
  }
  const alsa = await run(kind === "sources" ? "arecord" : "aplay", ["-L"]);
  if (alsa) { deviceKind = "alsa"; return parseAlsaList(alsa); }
  return [];
}

/** Players to try for a file on a device (null = default). */
export function playCommands(file: string, device: string | null, avail: (bin: string) => boolean = has): Command[] {
  const out: Command[] = [];
  const pulseDev = device && deviceKind === "pulse" ? device : null;
  if (avail("pw-play") && (!device || pulseDev)) out.push({ cmd: "pw-play", args: [...(pulseDev ? ["--target", pulseDev] : []), file] });
  if (avail("paplay") && (!device || pulseDev)) out.push({ cmd: "paplay", args: [...(pulseDev ? [`--device=${pulseDev}`] : []), file] });
  if (avail("aplay") && /\.wav$/i.test(file) && (!device || deviceKind === "alsa")) out.push({ cmd: "aplay", args: ["-q", ...(device ? ["-D", device] : []), file] });
  // The device is gone or unusable: the default output is better than silence.
  return device && !out.length ? playCommands(file, null, avail) : out;
}

class CliAudioDevices implements AudioDevices {
  inputs() { return list("sources"); }
  outputs() { return list("sinks"); }

  async play(file: string, device: string | null, signal?: AbortSignal): Promise<void> {
    for (const c of playCommands(file, device)) {
      if (signal?.aborted) return;
      const ok = await new Promise<boolean>((res) => {
        const p = spawn(c.cmd, c.args, { stdio: "ignore" });
        const abort = () => p.kill("SIGKILL");
        signal?.addEventListener("abort", abort, { once: true });
        p.on("error", () => res(false));
        p.on("exit", (code) => { signal?.removeEventListener("abort", abort); res(code === 0 || !!signal?.aborted); });
      });
      if (ok) return;
      log(`audio: ${c.cmd} couldn't play ${file}`);
    }
    if (device && !signal?.aborted) return this.play(file, null, signal); // the picked speaker is gone: use the default
  }
}

// ── Meeting Notes: what the speakers play, and the microphone, as live PCM ───────────────────────────────────────

/** Commands that record the default output's monitor, best first. `sink` is `pactl get-default-sink` (null if unknown). */
export function systemCaptureCommands(sink: string | null, avail: (bin: string) => boolean = has, raw = pwSupportsRaw): Command[] {
  const out: Command[] = [];
  if (avail("parecord") && sink)
    out.push({ cmd: "parecord", args: ["--raw", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=50", `--device=${sink}.monitor`] });
  // PipeWire: stream.capture.sink records what the default output plays, without knowing its name.
  if (avail("pw-record"))
    out.push({ cmd: "pw-record", args: ["--rate=16000", "--channels=1", "--format=s16", ...(raw() ? ["--raw"] : []), "-P", "{ stream.capture.sink=true }", "-"] });
  if (avail("parecord") && !sink)
    out.push({ cmd: "parecord", args: ["--raw", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=50", "--device=@DEFAULT_MONITOR@"] });
  return out;
}

/** A Bluetooth headset's microphone: opening it switches the headphones to their low-quality call profile. */
export function isBluetoothInput(d: AudioDevice): boolean {
  return /^bluez_/i.test(d.id) || /bluetooth|hands-?free|headset|airpods|\bbuds\b/i.test(d.name);
}

/** The microphone for a meeting: the one picked in Settings (else the default), but when that's a Bluetooth
 *  headset and another mic exists (the laptop's own), that one, so the headphones keep their sound quality for the
 *  whole meeting. `swappedFrom` is the headset when it was replaced. */
export function meetingMic(inputs: AudioDevice[], chosen: string | null): { device: AudioDevice | null; swappedFrom: AudioDevice | null } {
  const picked = (chosen && inputs.find((d) => d.id === chosen)) || inputs.find((d) => d.isDefault) || inputs[0] || null;
  if (!picked || !isBluetoothInput(picked)) return { device: picked, swappedFrom: null };
  const other = inputs.find((d) => !isBluetoothInput(d));
  return other ? { device: other, swappedFrom: picked } : { device: picked, swappedFrom: null };
}

/** Streams raw 16 kHz mono s16 PCM from the first command that works (a sound server tool writing to a pipe). */
class CliPcmStream implements SystemAudio {
  private proc: ChildProcess | null = null;
  private gen = 0;

  /** `quietOk`: a monitor of an idle (suspended) output may deliver nothing until something plays, so a capture
   *  that's still running after 4 s counts as started. */
  constructor(private label: string, private commands: () => Promise<Command[]>, private missing: string, private quietOk = false) {}

  async start(onPcm: (pcm: Buffer) => void): Promise<void> {
    this.stop();
    const gen = this.gen;
    const cmds = await this.commands();
    if (!cmds.length) throw new Error(this.missing);
    let lastError = "";
    for (const c of cmds) {
      if (gen !== this.gen) return;
      try {
        this.proc = await this.tryStart(c, gen, onPcm);
        log(`meeting: ${this.label} through ${c.cmd} ${c.args[c.args.length - 1]}`);
        return;
      } catch (e) {
        lastError = (e as Error).message;
        log(`meeting: ${this.label}: ${c.cmd} failed: ${lastError}`);
      }
    }
    throw new Error(lastError || "no audio");
  }

  private tryStart(c: Command, gen: number, onPcm: (pcm: Buffer) => void): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const p = spawn(c.cmd, c.args, { stdio: ["ignore", "pipe", "pipe"] });
      let started = false, err = "";
      let head: Buffer | null = Buffer.alloc(0);
      let odd: Buffer | null = null;
      // A mic streams silence too, so nothing at all within 4 s means it didn't open.
      const timer = setTimeout(() => {
        if (started) return;
        if (this.quietOk && p.exitCode === null && gen === this.gen) { started = true; resolve(p); return; }
        p.kill("SIGKILL");
        reject(new Error("no audio within 4 s"));
      }, 4000);
      p.stderr!.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-400); });
      p.stdout!.on("data", (d: Buffer) => {
        if (gen !== this.gen) return;
        if (head) {
          head = Buffer.concat([head, d]);
          const n = streamHeaderLength(head);
          if (n < 0) return;
          d = head.subarray(n);
          head = null;
        }
        if (odd) { d = Buffer.concat([odd, d]); odd = null; }
        if (d.length & 1) { odd = Buffer.from(d.subarray(d.length - 1)); d = d.subarray(0, d.length - 1); }
        if (!d.length) return;
        if (!started) { started = true; clearTimeout(timer); resolve(p); }
        onPcm(Buffer.from(d));
      });
      p.on("error", (e) => { clearTimeout(timer); if (!started) reject(e); });
      p.on("exit", (code) => {
        clearTimeout(timer);
        if (!started) reject(new Error(err.trim().split("\n").pop() || `exited ${code}`));
        else if (this.proc === p && gen === this.gen) log(`meeting: ${this.label}: ${c.cmd} stopped by itself (${code}) ${err.trim()}`);
      });
    });
  }

  stop() {
    this.gen++;
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }
}

/** What the speakers play (Meeting Notes' guest side). */
export function createSystemAudio(): SystemAudio {
  if (process.platform === "win32") return new WinSystemAudio(winHelper());
  return new CliPcmStream("speakers", async () => systemCaptureCommands(has("pactl") ? await pulseDefault("sinks") : null),
    "Can't listen to the speakers: install pulseaudio-utils (parecord) or pipewire (pw-record).", true);
}

/** The microphone as a live stream (Meeting Notes' "you" side): `device()` is the mic to use (null = default). */
export function createMicStream(device: () => Promise<string | null>): SystemAudio {
  if (process.platform === "win32") return new WinMicStream(winHelper(), device);
  return new CliPcmStream("microphone", async () => captureCommands(await device()),
    "No audio recorder found: install pipewire (pw-record), pulseaudio-utils (parecord) or alsa-utils (arecord).");
}
