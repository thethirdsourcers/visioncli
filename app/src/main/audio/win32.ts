import { randomBytes } from "node:crypto";
import type { AudioDevice, AudioDevices, Recorder, SystemAudio } from "../contracts";
import type { WinHelper } from "../desktop/windows/win32";
import { log } from "../log";

// Windows: the microphone and speakers through the helper (waveIn / waveOut, 16 kHz mono 16-bit WAV). The helper
// writes the WAV and streams `level` events (~30/s) while recording, like the Linux recorder's meter.

export class WinRecorder implements Recorder {
  private onLevel: ((level: number) => void) | undefined;
  private recording = false;

  constructor(private helper: WinHelper) {
    helper.on("level", (e) => { if (this.recording) this.onLevel?.(e.level); });
  }

  async start(file: string, device: string | null, onLevel?: (level: number) => void): Promise<void> {
    this.cancel();
    this.onLevel = onLevel;
    try {
      await this.helper.call("record.start", { file, device });
    } catch (e) {
      // The picked microphone is gone: the default one beats silence (like the Linux recorder's fallback).
      if (!device) throw new Error(`Couldn't open the microphone (${(e as Error).message}).`);
      log(`recorder: ${device} failed (${(e as Error).message}); using the default microphone`);
      await this.helper.call("record.start", { file, device: null });
    }
    this.recording = true;
    log(`recorder: waveIn ${device ?? "(default)"}`);
  }

  async stop(): Promise<{ file: string; seconds: number }> {
    this.recording = false;
    this.onLevel = undefined;
    const r = await this.helper.call("record.stop", {});
    log(`listener: recorded ${r.seconds.toFixed(1)}s`);
    return r;
  }

  cancel() {
    if (!this.recording) return;
    this.recording = false;
    this.onLevel = undefined;
    this.helper.call("record.cancel", {}).catch(() => {});
  }

  async snapshot(file: string): Promise<boolean> {
    if (!this.recording) return false;
    try { return await this.helper.call("record.snapshot", { file }); } catch { return false; }
  }
}

export class WinAudioDevices implements AudioDevices {
  constructor(private helper: WinHelper) {}

  private async list(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
    try { return await this.helper.call("audioDevices", {}); } catch (e) { log(`audio: devices: ${(e as Error).message}`); return { inputs: [], outputs: [] }; }
  }
  async inputs() { return (await this.list()).inputs; }
  async outputs() { return (await this.list()).outputs; }

  async play(file: string, device: string | null, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const token = randomBytes(6).toString("hex");
    const abort = () => { this.helper.call("play.stop", { token }).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    let failed: Error | null = null;
    try {
      // No timeout (the helper's default for play): it resolves when the sound ends, or on play.stop.
      await this.helper.call("play", { file, device, token });
    } catch (e) { failed = e as Error; } finally { signal?.removeEventListener("abort", abort); }
    if (!failed || signal?.aborted) return;
    log(`audio: couldn't play ${file} on ${device ?? "default"}: ${failed.message}`);
    if (device) return this.play(file, null, signal); // the picked speaker is gone: use the default
    throw failed;
  }
}

/** What the speakers play (Meeting Notes): the helper's WASAPI loopback, streamed as `loopback` events. */
export class WinSystemAudio implements SystemAudio {
  private off: (() => void) | null = null;

  constructor(private helper: WinHelper) {}

  async start(onPcm: (pcm: Buffer) => void): Promise<void> {
    this.stop();
    this.off = this.helper.on("loopback", (e) => onPcm(Buffer.from(e.data, "base64")));
    try {
      await this.helper.call("loopback.start", {});
    } catch (e) {
      this.stop();
      throw e;
    }
    log("meeting: speakers through WASAPI loopback on the default output");
  }

  stop() {
    if (!this.off) return;
    this.off();
    this.off = null;
    this.helper.call("loopback.stop", {}).catch(() => {});
  }
}

/** The microphone as a live stream (Meeting Notes): a second waveIn in the helper, independent of the hold-to-talk
 *  recording, streamed as `mic` events. */
export class WinMicStream implements SystemAudio {
  private off: (() => void) | null = null;

  constructor(private helper: WinHelper, private device: () => Promise<string | null>) {}

  async start(onPcm: (pcm: Buffer) => void): Promise<void> {
    this.stop();
    const device = await this.device();
    this.off = this.helper.on("mic", (e) => onPcm(Buffer.from(e.data, "base64")));
    try {
      await this.helper.call("micstream.start", { device });
    } catch (e) {
      if (!device) { this.stop(); throw e; }
      // The picked microphone is gone: the default one beats nothing.
      log(`meeting: microphone ${device} failed (${(e as Error).message}); using the default`);
      await this.helper.call("micstream.start", { device: null }).catch((err) => { this.stop(); throw err; });
    }
    log(`meeting: microphone through waveIn ${device ?? "(default)"}`);
  }

  stop() {
    if (!this.off) return;
    this.off();
    this.off = null;
    this.helper.call("micstream.stop", {}).catch(() => {});
  }
}
