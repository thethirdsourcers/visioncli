import { dialog, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vocabulary } from "../core/text";
import { HomeProject } from "../features/home";
import { log } from "../log";
import { SUP } from "../paths";
import { settings } from "../settings";
import { installParakeet } from "../stt/install";
import { ParakeetEngine } from "../stt/parakeet";
import { App } from "./core";

// Speech in and out (App+Voice.swift): the transcription engine, vocabulary hints, voices, audio devices.

export const VOCABULARY_FILE = join(SUP, "vocabulary.txt");

declare module "./core" {
  interface App {
    vocabularyWords(): string[];
    startVoiceEngines(): Promise<void>;
    restartSpeechEngine(): Promise<void>;
    chooseSpeechEngine(engine: string): Promise<void>;
    chooseSpeech(engine: string): Promise<void>;
    readonly currentSpeechEngine: string;
    setAudioDevice(input: boolean, id: string | null): void;
    testSpeaker(): void;
    setSpeechSpeed(x: number): void;
    setSpeak(on: boolean): void;
    selectVoice(id: string | null): void;
    editVocabulary(): void;
  }
}

/** Terms the engine should spell exactly (Vocabulary.words): the project, the window title, the user's list. */
App.prototype.vocabularyWords = function (this: App) {
  let custom: string | null = null;
  try { custom = readFileSync(VOCABULARY_FILE, "utf8"); } catch {}
  return Vocabulary.words(HomeProject.label(this.currentProject), this.scopeWindow?.title ?? null, custom);
};

App.prototype.startVoiceEngines = async function (this: App) {
  void Promise.all([this.audio.inputs(), this.audio.outputs()]).then(([i, o]) =>
    log(`audio inputs: ${i.map((d) => d.name).join(", ")} | outputs: ${o.map((d) => d.name).join(", ")}`), () => {});
  if (settings.get("speak") && settings.get("tts") === "kokoro") this.speaker.warm();
  await this.restartSpeechEngine();
};

/** One engine runs at a time; the setting falls back parakeet → whisper → system like macOS. */
App.prototype.restartSpeechEngine = async function (this: App) {
  const stt = settings.get("stt");
  const setting = stt === "whisper" ? `whisper:${settings.get("whisperModel")}` : stt;
  this.engine = await this.engines.choose(setting);
};

/** "parakeet" | "whisper:<model>" | "system". */
App.prototype.chooseSpeechEngine = async function (this: App, engine: string) {
  if (engine.startsWith("whisper:")) { settings.set("stt", "whisper"); settings.set("whisperModel", engine.slice(8)); }
  else settings.set("stt", engine);
  await this.restartSpeechEngine();
  this.windows.refreshWindows();
};

/** The Settings picker: Parakeet is downloaded first when it isn't on this computer yet (sherpa-onnx + ~640 MB). */
App.prototype.chooseSpeech = async function (this: App, engine: string) {
  if (engine === "parakeet" && !ParakeetEngine.available()) {
    if (this.parakeetProgress != null) return;
    const r = await dialog.showMessageBox({
      type: "question", message: "Download Parakeet?",
      detail: "Downloads the Parakeet speech model (~670 MB, with the sherpa-onnx runtime). Transcription then runs locally on this computer, fast and accurate with names.",
      buttons: ["Download", "Cancel"], defaultId: 0, cancelId: 1,
    });
    if (r.response !== 0) return;
    this.parakeetProgress = 0;
    this.windows.refreshWindows();
    try {
      await installParakeet((_label, f) => { if (f != null) this.parakeetProgress = f; });
    } catch (e) {
      this.parakeetProgress = null;
      await dialog.showMessageBox({ type: "warning", message: "Couldn't install Parakeet", detail: String((e as Error)?.message ?? e), buttons: ["OK"] });
      return;
    }
    this.parakeetProgress = null;
  }
  await this.chooseSpeechEngine(engine);
};

/** The engine actually in use, in chooseSpeechEngine's terms. */
Object.defineProperty(App.prototype, "currentSpeechEngine", {
  get(this: App) {
    const n = this.engine?.name ?? "system";
    return n === "parakeet" || n.startsWith("whisper:") ? n : "system";
  },
});

/** VisionCLI's own microphone or speaker (Pulse/PipeWire name); null = the system default. A new speaker plays a test. */
App.prototype.setAudioDevice = function (this: App, input: boolean, id: string | null) {
  settings.set(input ? "inputDevice" : "outputDevice", id);
  log(`${input ? "microphone" : "speaker"}: ${id ?? "system default"}`);
  if (!input) this.testSpeaker();
};

App.prototype.testSpeaker = function (this: App) {
  this.speaker.warm();
  this.speaker.stop();
  this.speaker.feed("This is the VisionCLI speaker test.", true, true);
};

/** Plays a short sample at the new speed. */
App.prototype.setSpeechSpeed = function (this: App, x: number) {
  settings.set("speechSpeed", x);
  this.testSpeaker();
};

App.prototype.setSpeak = function (this: App, on: boolean) {
  settings.set("speak", on);
  if (!on) this.speaker.stop(); else this.speaker.warm();
};

/** A Kokoro voice id, or null for the system voice; plays a short preview. */
App.prototype.selectVoice = function (this: App, id: string | null) {
  this.speaker.stop();
  if (id) {
    settings.set("tts", "kokoro");
    settings.set("kokoroVoice", id);
    this.speaker.warm();
  } else {
    settings.set("tts", "system");
    this.speaker.kokoro.stop();
  }
  this.speaker.preview(id ?? settings.get("voice") ?? "");
};

App.prototype.editVocabulary = function (this: App) {
  if (!existsSync(VOCABULARY_FILE)) {
    try { writeFileSync(VOCABULARY_FILE, "# Words Whisper should spell right, one per line (names, products, libraries)\nLaravel\nKubernetes\n"); } catch {}
  }
  void shell.openPath(VOCABULARY_FILE);
};

// ── Idle unloading ──────────────────────────────────────────────────────────────────────────────────────────────
// Parakeet (~850 MB) and Kokoro (~600 MB) stay in memory while in use; after a quiet spell they're stopped and start
// again on the next key-down (speech) or answer (voice), in the background while you talk.

export const SPEECH_IDLE_MS = 30 * 60_000;
export const VOICE_IDLE_MS = 10 * 60_000;

/** Which models to unload after `idleMs` without voice use (pure, for tests). */
export function idleUnload(idleMs: number, speaking: boolean): { speech: boolean; voice: boolean } {
  return { speech: idleMs > SPEECH_IDLE_MS, voice: idleMs > VOICE_IDLE_MS && !speaking };
}

declare module "./core" {
  interface App {
    /** Key-down: note the use and start loading the speech engine if it was unloaded. */
    wakeVoice(): void;
    unloadIdleVoice(): void;
  }
}

App.prototype.wakeVoice = function (this: App) {
  this.voiceUsedAt = Date.now();
  (this.engine as { start?: () => unknown } | null)?.start?.();
};

App.prototype.unloadIdleVoice = function (this: App) {
  const u = idleUnload(Date.now() - this.voiceUsedAt, this.speaker.speaking);
  if (u.speech && (this.engine as { isRunning?: boolean } | null)?.isRunning) { log("voice: speech engine idle, unloading"); this.engine!.stop(); }
  const kokoro = (this.speaker as { kokoro?: { isRunning: boolean; lastUse: number; stop(): void } }).kokoro;
  // Answers and announcements spoken without a key-down count as use too.
  const voiceIdle = idleUnload(Date.now() - Math.max(this.voiceUsedAt, kokoro?.lastUse ?? 0), this.speaker.speaking).voice;
  if (voiceIdle && kokoro?.isRunning) { log("voice: Kokoro idle, unloading"); kokoro.stop(); }
};
