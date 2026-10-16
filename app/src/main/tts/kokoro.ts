import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { LineSplitter } from "../core/transcript";
import { log } from "../log";
import { TMP } from "../paths";
import { VoiceModels } from "../stt/models";

// KokoroEngine (Voice.swift): kokoro-onnx through `uv`, with overlay/Resources/kokoro_server.py unchanged. JSON lines
// {"id","text","voice","speed"} in; {"id","path"} or {"id","error"} out; {"ready": true} once the model is loaded.

/** `uv run` arguments for Kokoro's Python. Windows on Arm: onnxruntime and soundfile publish no win_arm64 wheels, so
 *  Kokoro runs on x64 Python there, which Windows runs through its built-in emulation (uv fetches that Python). */
export function kokoroUvArgs(platform: string = process.platform, arch: string = process.arch): string[] {
  const python = platform === "win32" && arch === "arm64" ? ["--python", "cpython-3.12-windows-x86_64-none"] : [];
  return ["run", "--quiet", ...python, "--with", "kokoro-onnx", "--with", "soundfile", "python"];
}

/** kokoro_server.py: next to the bundle (build/assets), in the packaged app, or in the repo (dev, tests). */
export function kokoroScript(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env.VISIONCLI_KOKORO_SCRIPT,
    join(__dirname, "assets/kokoro_server.py"),
    resources && join(resources, "app/build/assets/kokoro_server.py"),
    resources && join(resources, "assets/kokoro_server.py"),
    join(__dirname, "../../overlay/Resources/kokoro_server.py"),
    join(__dirname, "../../../overlay/Resources/kokoro_server.py"),
  ];
  // Electron's fs sees into app.asar, but python can't read from it: only real files count.
  return candidates.find((p): p is string => !!p && !p.includes(".asar") && existsSync(p)) ?? null;
}

export class KokoroEngine {
  private proc: ChildProcess | null = null;
  private callbacks = new Map<number, (path: string | null) => void>();
  private nextId = 0;
  ready = false;

  static available(): boolean { return !!VoiceModels.kokoroModel() && !!VoiceModels.kokoroVoices() && !!VoiceModels.binary("uv") && !!kokoroScript(); }

  /** Why the last start failed (shown in Settings → Voice); null once it's ready. */
  lastError: string | null = null;

  get isRunning() { return !!this.proc; }

  start() {
    if (this.proc) return;
    const uv = VoiceModels.binary("uv"), model = VoiceModels.kokoroModel(), voices = VoiceModels.kokoroVoices(), script = kokoroScript();
    if (!uv || !model || !voices || !script) {
      this.lastError = !uv ? "Kokoro needs uv, which isn't installed." : "Kokoro's voice files are missing.";
      log("kokoro unavailable (needs uv, kokoro-v1.0.onnx, voices-v1.0.bin)");
      return;
    }
    const outDir = join(TMP, "visioncli-tts");
    mkdirSync(outDir, { recursive: true });
    const env = { ...process.env, PATH: [process.env.PATH, join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin")].filter(Boolean).join(delimiter) };
    const p = VoiceModels.spawnHelper(uv, [...kokoroUvArgs(), script, model, voices, outDir],
      { stdio: ["pipe", "pipe", "pipe"], env });
    this.proc = p;
    const lines = new LineSplitter();
    p.stdout!.on("data", (d: Buffer) => lines.feed(d, (line) => {
      try { this.handle(JSON.parse(line.toString("utf8"))); } catch {}
    }));
    p.stdin!.on("error", () => {});
    let stderr = "";
    p.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf8")).slice(-600); });
    p.on("error", (e) => log(`kokoro failed to start: ${e.message}`));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      log(`kokoro exited (${code})${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
      // Exiting before it was ready is a broken install (Settings → Voice says so, instead of the system voice
      // quietly answering for the Kokoro voice you picked).
      if (!this.ready) this.lastError = `Kokoro couldn't start${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : "."}`;
      this.proc = null;
      this.ready = false;
      this.failAll();
    });
    log("kokoro starting");
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    VoiceModels.hardStop(p);
    this.ready = false;
    this.failAll();
  }

  private failAll() {
    const cbs = [...this.callbacks.values()];
    this.callbacks.clear();
    cbs.forEach((cb) => cb(null));
  }

  /** Queues text for synthesis; resolves with a WAV file, or null. */
  synth(text: string, voice: string, speed: number): Promise<string | null> {
    if (!this.proc) this.start();
    const p = this.proc;
    if (!p?.stdin?.writable) return Promise.resolve(null);
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.callbacks.set(id, resolve);
      p.stdin!.write(JSON.stringify({ id, text, voice, speed }) + "\n");
    });
  }

  private handle(obj: { ready?: boolean; id?: number; path?: string; error?: string }) {
    if (obj.ready) { this.ready = true; this.lastError = null; log("kokoro ready"); return; }
    const cb = obj.id !== undefined ? this.callbacks.get(obj.id) : undefined;
    if (!cb) return;
    this.callbacks.delete(obj.id!);
    if (obj.error) log(`kokoro error: ${obj.error}`);
    cb(obj.path ?? null);
  }
}
