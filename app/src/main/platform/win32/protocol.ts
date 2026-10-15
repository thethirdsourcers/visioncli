// The protocol between the app and its Windows helper (app/native/windows, `vcli-win.exe`, C# on .NET Framework 4.8,
// which every Windows 10/11 has). Windows APIs that Node can't reach (hooks, UI Automation, SendInput, GDI capture,
// waveIn, SAPI) live there; the app talks to one long-running helper over stdin/stdout, one JSON object per line.
//
//   app → helper   {"id": 7, "method": "windows", "params": {}}
//   helper → app   {"id": 7, "result": [...]}            or {"id": 7, "error": "message"}
//   helper → app   {"event": "key", "data": {...}}       unsolicited events (hooks, levels)
//
// Coordinates are physical screen pixels (the helper is per-monitor DPI aware), top-left origin of the virtual
// screen, like X11 pixels on Linux. Images are JPEG files the helper writes into the given path.

export interface Rect { x: number; y: number; width: number; height: number }

export interface WinWindow {
  hwnd: string;            // decimal HWND
  title: string;
  pid: number;
  exe: string;             // "chrome.exe"
  app: string;             // product name from the exe's version info ("Google Chrome"), else exe without .exe
  bounds: Rect;            // DWM extended frame bounds (no invisible resize borders)
  cloaked?: boolean;       // on another virtual desktop / UWP suspended: filtered out by the helper
}

export interface UiaElement { id: number; role: string; label: string; x: number; y: number; w: number; h: number }

export interface Methods {
  /** Helper version and capabilities. */
  hello: { params: {}; result: { version: string; dpiAware: boolean; arch: string } };

  // ── Desktop ──
  displays: { params: {}; result: (Rect & { primary: boolean; scale: number })[] };
  pointer: { params: {}; result: { x: number; y: number } };
  /** Visible top-level app windows, front-most first (z-order), excluding tool windows and the app's own (pid). */
  windows: { params: { excludePid?: number }; result: WinWindow[] };
  activeWindow: { params: { excludePid?: number }; result: WinWindow | null };
  focus: { params: { hwnd: string }; result: boolean };
  /** Window (PrintWindow with PW_RENDERFULLCONTENT, falling back to a screen copy) or screen rect → JPEG q85,
   *  longest side ≤ maxDim. */
  capture: { params: { hwnd?: string; rect?: Rect; maxDim: number; file: string }; result: { width: number; height: number } };
  clipboardImage: { params: { file: string }; result: boolean };      // PNG written to file; false if none
  setClipboardText: { params: { text: string }; result: true };
  getClipboardText: { params: {}; result: string };

  // ── Input (SendInput; events carry the helper's tag in dwExtraInfo so its own hooks ignore them) ──
  move: { params: { x: number; y: number }; result: true };
  click: { params: { x: number; y: number; button: "left" | "right"; count: number }; result: true };
  type: { params: { text: string }; result: true };                   // KEYEVENTF_UNICODE per UTF-16 unit
  key: { params: { combo: string }; result: true };                   // "ctrl+shift+s", "enter", "win+d", "alt+f4"
  scroll: { params: { dx: number; dy: number; x?: number; y?: number }; result: true };
  drag: { params: { x1: number; y1: number; x2: number; y2: number }; result: true };

  // ── Hooks: after `hooks.start`, the helper streams `key`, `button` and `motion` events ──
  "hooks.start": { params: {}; result: true };
  "hooks.stop": { params: {}; result: true };

  // ── UI Automation ──
  /** Actionable/editable elements of the foreground (or named) app's window; ids valid until the next call.
   *  Limits like macOS: depth 30, 350 items, 5000 nodes, 4 s. */
  elements: { params: { app?: string; excludePid?: number }; result: { app: string; elements: UiaElement[] } };
  press: { params: { id: number }; result: boolean };                 // Invoke / Toggle / SelectionItem / ExpandCollapse
  setValue: { params: { id: number; text: string }; result: boolean }; // ValuePattern
  isSecure: { params: { id?: number; x?: number; y?: number; focused?: boolean }; result: boolean }; // IsPassword
  windowText: { params: { max: number; excludePid?: number }; result: { app: string; title: string; text: string } | null };

  // ── Audio (waveIn / waveOut, 16 kHz mono 16-bit) ──
  audioDevices: { params: {}; result: { inputs: { id: string; name: string; isDefault: boolean }[]; outputs: { id: string; name: string; isDefault: boolean }[] } };
  /** Starts recording into `file` (WAV); streams `level` events (0…1, ~30/s) while recording. */
  "record.start": { params: { file: string; device: string | null }; result: true };
  "record.snapshot": { params: { file: string }; result: boolean };   // a valid WAV of what's recorded so far
  "record.stop": { params: {}; result: { file: string; seconds: number } };
  "record.cancel": { params: {}; result: true };
  /** Plays a WAV on `device` (null = default); resolves when done or stopped. */
  play: { params: { file: string; device: string | null; token: string }; result: true };
  "play.stop": { params: { token: string }; result: true };
  /** What the speakers play (WASAPI loopback of the default output) as `loopback` events, 16 kHz mono s16 (Meeting Notes). */
  "loopback.start": { params: {}; result: true };
  "loopback.stop": { params: {}; result: true };
  /** The microphone as `mic` events (16 kHz mono s16), alongside any record.start (Meeting Notes). */
  "micstream.start": { params: { device: string | null }; result: true };
  "micstream.stop": { params: {}; result: true };

  // ── Speech (SAPI 5 via System.Speech) ──
  voices: { params: {}; result: string[] };
  /** Renders `text` to a WAV (rate −10…10). */
  speak: { params: { text: string; voice: string | null; rate: number; file: string }; result: true };

  // ── Processes (for terminal mode: cwd isn't exposed by any CLI tool on Windows) ──
  processes: { params: { names?: string[] }; result: { pid: number; ppid: number; exe: string; cmdline: string; cwd: string | null }[] };
}

export type Method = keyof Methods;

/** Unsolicited events. Virtual-key codes are Windows VK_*; `injected` events (other tools' SendInput) are included
 *  with the flag, the helper's own are dropped. */
export interface Events {
  key: { vk: number; down: boolean; injected: boolean };
  button: { button: "left" | "right" | "middle" | "x1" | "x2"; down: boolean };
  motion: { x: number; y: number };     // throttled to ~60/s
  level: { level: number };
  /** ~100 ms of loopback PCM (base64, 16 kHz mono s16); silence is padded in while nothing plays. */
  loopback: { data: string };
  /** ~100 ms of microphone PCM from micstream.start (base64, 16 kHz mono s16). */
  mic: { data: string };
}

export type Event = keyof Events;
