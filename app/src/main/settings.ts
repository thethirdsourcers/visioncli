import { EventEmitter } from "node:events";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUP } from "./paths";

// The macOS app's UserDefaults keys and defaults, stored in SUP/settings.json.

export type Assistant = "claude" | "antigravity" | "gemini";

export interface SettingsShape {
  speak: boolean;
  model: string;                 // Claude alias; "default" = the CLI's own
  stt: string;                   // "parakeet" | "whisper" | "whisper:<model>" | "system"
  whisperModel: string;
  tts: string;                   // "kokoro" | "system"
  speechSpeed: number;
  kokoroVoice: string;
  voice: string | null;          // system voice name
  terminalMode: boolean;
  autoUpdate: boolean;
  assistant: Assistant;
  effort: string | null;
  watchCrashes: boolean;
  errorWatcher: boolean;         // spot new errors in terminal panes and offer Alt+E to fix them
  computerControl: "ask" | "auto" | "off";
  agyModel: string | null;
  smartRouting: boolean;
  quickCommands: boolean;
  screenshotEveryQuestion: boolean;
  setupDone: boolean;
  setupStep: string | null;
  // Meeting Notes: what it does during a meeting (Meeting Notes itself is never remembered: off at each launch).
  meetingSummarizeGuest: boolean; // a one-line summary under what colleagues say
  meetingSummarizeYou: boolean;   // and under what you say (off: you know what you said)
  meetingReplies: boolean;        // three suggested replies when a colleague asks you something
  meetingCodeLookup: boolean;     // questions about the code answered from the project (read-only)
  meetingRecord: boolean;         // keep a recording of both sides, to play back with the transcript
  usageInMenuBar: boolean;
  weeklyInMenuBar: boolean;
  pinnedProject: string | null;
  autoActivity: boolean;
  inputDevice: string | null;    // PipeWire/Pulse source name
  outputDevice: string | null;   // sink name
  ghostCursor: boolean;
  /** Content protection on every VisionCLI window (Windows; not possible on Linux). */
  hideFromCapture: boolean;
  settingsSection: string | null;
  notifiedUpdate: string | null;
  permissionRepairVersion: string | null;
  /** Session ids and caches: backgroundSession:<cwd>, terminalSession:<project>, agyModels, usage.* … */
  store: Record<string, unknown>;
}

export const DEFAULTS: SettingsShape = {
  speak: false, model: "default", stt: "whisper", whisperModel: "small.en", tts: "kokoro", speechSpeed: 2, kokoroVoice: "af_heart",
  voice: null, terminalMode: true, autoUpdate: true, assistant: "claude", effort: null, watchCrashes: true, errorWatcher: true, computerControl: "ask",
  agyModel: null, smartRouting: true, quickCommands: true, screenshotEveryQuestion: false, setupDone: false, setupStep: null,
  meetingSummarizeGuest: true, meetingSummarizeYou: false, meetingReplies: true, meetingCodeLookup: true, meetingRecord: true,
  usageInMenuBar: true, weeklyInMenuBar: false, pinnedProject: null, autoActivity: true,
  inputDevice: null, outputDevice: null, ghostCursor: true, hideFromCapture: false, settingsSection: null, notifiedUpdate: null, permissionRepairVersion: null,
  store: {},
};

const FILE = join(SUP, "settings.json");

class Settings extends EventEmitter {
  private v: SettingsShape;
  constructor() {
    super();
    let saved: Partial<SettingsShape> = {};
    try { saved = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
    this.v = { ...DEFAULTS, ...saved, store: { ...(saved.store ?? {}) } };
    if (this.v.assistant === "gemini") this.v.assistant = "antigravity"; // as on macOS: Gemini CLI users move to agy
  }
  get<K extends keyof SettingsShape>(k: K): SettingsShape[K] { return this.v[k]; }
  set<K extends keyof SettingsShape>(k: K, value: SettingsShape[K]) {
    this.v[k] = value;
    this.save();
    this.emit("change", k, value);
  }
  getStore<T>(key: string): T | undefined { return this.v.store[key] as T | undefined; }
  setStore(key: string, value: unknown) {
    if (value === undefined) delete this.v.store[key]; else this.v.store[key] = value;
    this.save();
  }
  all(): SettingsShape { return structuredClone(this.v); }
  private save() {
    try { writeFileSync(FILE + ".tmp", JSON.stringify(this.v, null, 2)); renameSync(FILE + ".tmp", FILE); } catch {}
  }
}

export const settings = new Settings();
