// The seams between the Linux app's modules. Each folder under src/main implements one part, mirroring a part of the
// macOS app (overlay/Sources). The orchestrator (app.ts, the port of AppDelegate + App+*.swift) only talks to these.
//
// Coordinates: everything in main is in global X/compositor *pixels* (what capture, input injection and AT-SPI use),
// top-left origin. Only src/main/ui converts to Electron DIPs when placing windows.

import type { EventEmitter } from "node:events";

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

// ── input/: global hotkeys (Hotkeys.swift, ModifierHold) ─────────────────────────────────────────────────────────
// macOS → Linux keys: ⌥ Option → Alt, ⌘ Command → Super, ⌃ Control → Ctrl.

export type HotkeyEvent =
  | { type: "holdStart"; screenshot: boolean }  // Alt held (Alt+Super: with a screenshot); starts listening
  | { type: "screenshot" }                      // Super added while Alt is held: upgrade to a screenshot question
  | { type: "holdEnd" }                         // released: finish listening
  | { type: "holdCancel" }                      // another key or a click while holding (Alt+Tab, Alt+click…)
  | { type: "tap" }                             // a tap under 0.35 s: toggle tap mode (listen until the next tap)
  | { type: "pointMode" }                       // Alt+Shift+Space: drag a region
  | { type: "overlayKey"; key: "esc" | "pin" | "open" | "allow" | "fix" }; // Esc, Alt+P, Alt+O, Alt+Enter, Alt+E while grabbed

export interface Hotkeys extends EventEmitter {
  /** Starts listening; `backend` says how ("evdev", "xinput2"); `problem` explains what setup is missing, if any. */
  start(): Promise<{ backend: string; problem?: string }>;
  /** While the overlay is up (or computer control runs), Esc / Alt+P / Alt+O / Alt+Enter are reported. */
  setOverlayKeys(on: boolean): void;
  stop(): void;
  /** When the pointer last moved (epoch ms), if this backend sees mouse movement (`seesMotion`). */
  readonly lastMotion?: number;
  readonly seesMotion?: boolean;
  on(event: "hotkey", listener: (e: HotkeyEvent) => void): this;
}

// ── audio/: microphone + devices (Speech.swift Listener, WavRecorder, AudioDevices.swift) ───────────────────────

export interface AudioDevice { id: string; name: string; isDefault: boolean }

export interface Recorder {
  /** Records 16 kHz mono 16-bit WAV to `file` from `device` (null = default). `onLevel` gets 0…1 about 30×/s. */
  start(file: string, device: string | null, onLevel?: (level: number) => void): Promise<void>;
  /** Stops and finalizes the WAV; resolves with its path and duration in seconds. */
  stop(): Promise<{ file: string; seconds: number }>;
  cancel(): void;
  /** A copy of what's been recorded so far (valid WAV), for live captions. */
  snapshot(file: string): Promise<boolean>;
}

export interface AudioDevices {
  inputs(): Promise<AudioDevice[]>;
  outputs(): Promise<AudioDevice[]>;
  /** Plays a WAV/OGG file on `device` (null = default); resolves when done. */
  play(file: string, device: string | null, signal?: AbortSignal): Promise<void>;
}

/** What the speakers play (Listen to Calls), not the microphone: raw 16 kHz mono s16 PCM chunks. */
export interface SystemAudio {
  start(onPcm: (pcm: Buffer) => void): Promise<void>;
  stop(): void;
}

// ── stt/: transcription (Voice.swift WhisperEngine, ParakeetEngine; App+Voice.chooseSpeechEngine) ────────────────

export interface SpeechEngine {
  readonly name: string;         // "parakeet" | "whisper:<model>" | "system"
  ready(): Promise<boolean>;
  transcribe(wav: string, vocabulary: string[], partial?: boolean): Promise<string>;
  stop(): void;
}

export interface SpeechEngines {
  /** The engine for the user's setting, falling back like macOS (parakeet → whisper → system). */
  choose(setting: string): Promise<SpeechEngine>;
  available(): Promise<{ parakeet: boolean; whisper: string[]; system: boolean }>;
}

// ── tts/: speaking (Speech.swift Speaker, KokoroEngine) ──────────────────────────────────────────────────────────

export interface Speaker extends EventEmitter {
  /** Streams answer text; speaks whole sentences as they complete (skips code and Mermaid). `final` flushes. */
  feed(text: string, final: boolean): void;
  say(text: string): void;        // speak now (announcements, summaries)
  stop(): void;
  readonly speaking: boolean;
  voices(): Promise<{ kokoro: string[]; system: string[] }>;
  preview(voice: string): void;
}

// ── assistant/: talking to claude / agy / gemini (Claude.swift, Agy.swift, Gemini.swift, App+Sessions.swift) ─────

export type Lane = "fast" | "strong";

export interface Question {
  text: string;                  // already tagged ([voice · screenshot … ])
  images: string[];              // JPEG paths
  project: string;               // cwd
  lane: Lane;
}

export interface PermissionRequest {
  tool: string;                  // "Edit", "Bash", "command(git push)" …
  summary: string;               // one line
  preview?: string;              // diff or command
}
export type PermissionAnswer = "allow" | "allowAll" | "deny";

export interface AnswerHandlers {
  onText(delta: string): void;
  onTool(name: string, detail?: string): void;
  onPermission(req: PermissionRequest): Promise<PermissionAnswer>;
  onDone(result: { text: string; costUsd?: number; sessionId?: string }): void;
  onError(message: string): void;
  onRateLimit?(info: unknown): void;
  /** Terminal mode: an edit/Bash is waiting for approval in the terminal. */
  onWaitingInTerminal?(): void;
}

export interface AssistantSession {
  readonly busy: boolean;
  ask(q: Question, h: AnswerHandlers): void;
  stop(): void;                  // interrupt the current turn
  close(): void;                 // end the process
  sessionId(): string | undefined;
}

export interface Sessions {
  /** Bubble mode: a warm background session per (project, lane, assistant); at most 4 alive. */
  background(project: string, lane: Lane): AssistantSession;
  /** Terminal mode: the interactive CLI in a terminal for this project (found, or opened). */
  terminal(project: string, pointedAt?: TerminalContext | null): AssistantSession;
  newConversation(project: string): void;
  continueInTerminal(project: string): Promise<void>;
  closeAll(): void;
}

// ── terminal/: finding CLIs in terminals (TerminalProbe.swift) ───────────────────────────────────────────────────

export interface TerminalContext {
  assistant: "claude" | "agy" | "gemini";
  pid: number;
  cwd: string;
  tty?: string;
  sessionId?: string;
  /** How text can be delivered: tmux pane, kitty window, wezterm pane, a PTY VisionCLI owns, or "keyboard": focus the
   *  emulator window of the CLI (`pid`) and type with synthetic input (any other emulator: gnome-terminal, konsole…). */
  delivery: { kind: "tmux"; target: string } | { kind: "kitty"; socket?: string; id: number } | { kind: "wezterm"; pane: number } | { kind: "pty"; id: string }
    | { kind: "keyboard"; pid: number } | { kind: "none" };
}

// ── desktop/: windows, capture, input injection, accessibility, apps (Screen.swift, Control.swift Computer/UIElements) ──

export interface DesktopWindow {
  id: string;                    // backend-specific (X11 id in decimal, or compositor id)
  app: string;                   // display name ("Google Chrome", "Code")
  appId: string;                 // WM_CLASS / app_id / desktop file id
  title: string;
  pid?: number;
  bounds: Rect;
}

export interface Jpeg { data: Buffer; width: number; height: number }

export interface Desktop {
  readonly backend: "x11" | "gnome" | "kde" | "sway" | "hyprland" | "wayland" | "win32";
  /** What's missing for full support (e.g. the GNOME extension isn't enabled yet); null when complete. */
  problem(): Promise<string | null>;
  displays(): Promise<Rect[]>;
  pointer(): Promise<Point | null>;
  /** On-screen windows, front-most first, excluding VisionCLI's own. */
  windows(): Promise<DesktopWindow[]>;
  activeWindow(): Promise<DesktopWindow | null>;
  /** Max 1568 px longest side, JPEG q85. */
  captureWindow(w: DesktopWindow): Promise<Jpeg>;
  captureRect(r: Rect): Promise<Jpeg>;
  focus(w: DesktopWindow): Promise<void>;
}

export interface InputInjector {
  readonly backend: string;      // "xtest" | "portal" | "uinput"
  move(p: Point): Promise<void>;
  click(p: Point, button: "left" | "right", count: number): Promise<void>;
  type(text: string): Promise<void>;          // unicode-safe; long text may go through the clipboard
  key(combo: string): Promise<void>;          // "ctrl+shift+s enter" (macOS names cmd/option map to super/alt)
  scroll(dx: number, dy: number, at?: Point): Promise<void>;
  drag(from: Point, to: Point): Promise<void>;
}

export interface UIElement { id: number; role: string; label: string; x: number; y: number; w: number; h: number }

export interface Accessibility {
  available(): Promise<boolean>;
  /** The front (or named) app's actionable elements, ids valid until the next call. */
  elements(app?: string): Promise<{ app: string; elements: UIElement[] }>;
  press(id: number): Promise<boolean>;                    // AT-SPI action "click"/"press"/"activate"
  setValue(id: number, text: string): Promise<boolean>;   // EditableText
  isSecure(target: { id?: number; at?: Point; focused?: boolean }): Promise<boolean>;
  /** Visible text of the front window, max `max` chars, never from password fields. */
  windowText(max: number): Promise<{ app: string; title: string; text: string } | null>;
}

export interface Apps {
  /** Installed apps from .desktop files. */
  list(): Promise<{ id: string; name: string; exec: string; icon?: string }[]>;
  open(name: string): Promise<string>;       // launches, returns the app's name
  focus(name: string): Promise<string>;
  openUrl(url: string): Promise<void>;
  /** Opens file:line in the right editor (JetBrains, VS Code family, Zed, Sublime, vim in a terminal…), like Opener. */
  openFile(path: string, line?: number, project?: string): Promise<void>;
}

// ── ui/: windows (Views.swift, Mascot.swift, Overlays.swift, Tasks.swift, Badge.swift, Spotlight.swift …) ─────────

export type Phase = "idle" | "listening" | "thinking" | "answering" | "done" | "error" | "approval";

export interface OverlayState {
  phase: Phase;
  question: string;
  live: string;                  // live caption while listening
  level: number;                 // mic level 0…1
  status: string;                // thinking pill / header text
  raw: string;                   // answer markdown
  pinned: boolean;
  speaking: boolean;
  screenshot: boolean;           // this question has a screenshot (pill icon)
  approval?: { tool: string; summary: string; preview?: string; queue: number };
  toast?: string;
  project?: string;
  assistantName: string;         // "Claude" | "Gemini"
  keys: { pin: string; open: string; allow: string };  // Settings → Shortcuts' keys, for the bubble's hints
}

/** Things the bubble's buttons and links ask for (renderer → main). */
export type BubbleAction =
  | { type: "copy" } | { type: "speak" } | { type: "history" } | { type: "openFirst" } | { type: "pin" } | { type: "close" }
  | { type: "approve"; answer: PermissionAnswer } | { type: "link"; url: string } | { type: "hover"; inside: boolean };

export interface Mark { kind: "box" | "circle" | "arrow" | "step"; rect: Rect; label?: string; n?: number }

export interface TaskStep { id: string; text: string; state: "running" | "done" | "failed" | "declined" | "waiting" }

// ── features: history (History.swift), control server (Control.swift) …: see their modules. ───────────────────────

export interface HistoryEntry {
  date: string;                  // ISO
  project: string;
  question: string;
  answer: string;
  screenshots: string[];         // file names in SUP/screenshots
}
