import type { HotkeyEvent } from "../contracts";
import { KEY } from "./evdev";

// ModifierHold (Hotkeys.swift) + the key handling of App+Listening.swift, as a pure state machine fed with key and
// button events from any backend (evdev, XInput2):
// - Alt alone held 0.3 s → holdStart; Alt+Super → holdStart with a screenshot; Super added later → screenshot.
// - Letting go of Alt → holdEnd, or tap when it was let go within 0.35 s of holdStart (tap mode: listen until the
//   next press, which then counts at once, without the 0.3 s wait).
// - Any other key (Alt+Tab, Alt+F4…) or a mouse button: before the 0.3 s it just wasn't a hold; after it, holdCancel.
// - Alt+Shift+Space → pointMode; letting go of Space or Alt ends it (tap/holdEnd). Clicks are the drag, not a cancel.
// - Esc, Alt+P, Alt+O, Alt+Enter → overlayKey, only while overlay keys are on.
// - Linux addition: once Alt was part of something else (Alt+Tab, Alt+click, a hold that just ended), Alt alone
//   doesn't start a new hold until it is let go. Alt+Tab is the window switcher here (⌘Tab on macOS), and letting go
//   of Shift in Alt+Shift+Tab left "Alt alone" held long enough to start listening.

export const HOLD_DELAY = 300;
export const TAP_WINDOW = 350;
const TAP_MODE_MAX = 90_000; // listening ends after 90 s (App+Listening), so tap mode can't outlive it

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}
const realClock: Clock = { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout) };

const ALT = new Set<number>([KEY.LEFTALT, KEY.RIGHTALT]);
const SUPER = new Set<number>([KEY.LEFTMETA, KEY.RIGHTMETA]);
const SHIFT = new Set<number>([KEY.LEFTSHIFT, KEY.RIGHTSHIFT]);
const CTRL = new Set<number>([KEY.LEFTCTRL, KEY.RIGHTCTRL]);
const isModifier = (c: number) => ALT.has(c) || SUPER.has(c) || SHIFT.has(c) || CTRL.has(c);

type Hold = "talk" | "screen" | "point";

export class HoldMachine {
  overlayKeys = false;
  /** Set by the app (phase == listening, like ModifierHold.immediate); null = guess from tap mode. */
  listening: boolean | null = null;
  private down = new Map<number, number>(); // code → how many keyboards hold it
  private candidate: "talk" | "screen" | null = null;
  private pending: unknown = null;
  private active: Hold | null = null;
  private activeAt = 0;
  private sendPress = false;   // this hold started at once (it sends a tap-mode question)
  private tapMode = false;
  /** Alt took part in something else (Alt+Tab, Alt+click, a hold that ended): no new hold until it's let go. */
  private latched = false;
  private tapTimer: unknown = null;

  constructor(private emit: (e: HotkeyEvent) => void, private clock: Clock = realClock) {}

  private held(set: Set<number>) { for (const c of set) if (this.down.get(c)) return true; return false; }
  private flags() { return { alt: this.held(ALT), sup: this.held(SUPER), shift: this.held(SHIFT), ctrl: this.held(CTRL) }; }
  private get immediate() { return this.listening ?? this.tapMode; }

  /** A key went down (`down`) or up. Repeats (value 2) must not be passed in. */
  key(code: number, down: boolean) {
    const n = this.down.get(code) ?? 0;
    if (down) this.down.set(code, n + 1); else if (n > 1) this.down.set(code, n - 1); else this.down.delete(code);
    if (!down) return this.keyUp(code);
    if (isModifier(code)) return this.flagsChanged();
    this.keyDown(code);
  }

  /** A mouse button went down. */
  button() {
    if (this.active === "point") return; // dragging the region
    this.cancelPending(true);
    if (this.active) this.holdCancel();
  }

  /** The wheel turned: like macOS, only stops a hold that hasn't started yet. */
  scroll() { if (this.active !== "point") this.cancelPending(true); }

  /** Forget every pressed key (a keyboard was unplugged, or events were dropped). */
  releaseAll() { for (const code of [...this.down.keys()]) { this.down.set(code, 1); this.key(code, false); } }

  stop() { this.cancelPending(); if (this.tapTimer) this.clock.clearTimeout(this.tapTimer); }

  private flagsChanged() {
    const f = this.flags();
    if (this.active === "point") return;
    if (this.active) {
      if (this.active === "talk" && f.alt && f.sup) { this.active = "screen"; this.emit({ type: "screenshot" }); }
      return;
    }
    if (this.latched) { if (!f.alt) this.latched = false; this.cancelPending(); return; }
    const key = f.alt && !f.shift && !f.ctrl ? (f.sup ? "screen" : "talk") : null;
    if (!key) { this.cancelPending(); return; }
    this.candidate = key;
    if (this.pending) this.clock.clearTimeout(this.pending);
    this.pending = null;
    if (this.immediate) { this.activate(true); return; }
    this.pending = this.clock.setTimeout(() => { this.pending = null; this.activate(false); }, HOLD_DELAY);
  }

  private activate(immediate: boolean) {
    const c = this.candidate;
    if (!c) return;
    this.candidate = null;
    this.active = c;
    this.activeAt = this.clock.now();
    this.sendPress = immediate;
    this.setTapMode(false);
    this.emit({ type: "holdStart", screenshot: c === "screen" });
  }

  private keyDown(code: number) {
    const f = this.flags();
    if (this.overlayKeys) {
      const altOnly = f.alt && !f.sup && !f.shift && !f.ctrl;
      const none = !f.alt && !f.sup && !f.shift && !f.ctrl;
      const key = code === KEY.ESC && none ? "esc" : !altOnly ? null
        : code === KEY.P ? "pin" : code === KEY.O ? "open" : code === KEY.E ? "fix" : code === KEY.ENTER || code === KEY.KPENTER ? "allow" : null;
      if (key) { this.cancelPending(true); this.emit({ type: "overlayKey", key }); return; }
    }
    if (code === KEY.SPACE && f.alt && f.shift && !f.sup && !f.ctrl) {
      this.cancelPending();
      this.active = "point";
      this.activeAt = this.clock.now();
      this.sendPress = false;
      this.setTapMode(false);
      this.emit({ type: "pointMode" });
      return;
    }
    if (this.active === "point") return;
    this.cancelPending(true);
    if (this.active) this.holdCancel();
  }

  private keyUp(code: number) {
    const f = this.flags();
    if (this.active === "point") {
      if (code === KEY.SPACE || !f.alt) this.end();
      return;
    }
    if (this.active) {
      if (!f.alt) this.end();
      return;
    }
    if (isModifier(code)) this.flagsChanged();
  }

  private end() {
    const quick = this.clock.now() - this.activeAt < TAP_WINDOW;
    const send = this.sendPress;
    this.active = null;
    this.sendPress = false;
    this.latched = this.flags().alt; // let go of Space first in point mode: Alt alone is not a new hold
    if (quick && !send) { this.setTapMode(true); this.emit({ type: "tap" }); }
    else this.emit({ type: "holdEnd" });
  }

  private holdCancel() {
    this.latched = this.flags().alt;
    this.active = null;
    this.sendPress = false;
    this.setTapMode(false);
    this.emit({ type: "holdCancel" });
  }

  /** Drops a hold that hasn't started; `latch` when Alt was part of a shortcut (Alt+Tab keeps Alt down a while). */
  private cancelPending(latch = false) {
    if (this.pending) this.clock.clearTimeout(this.pending);
    this.pending = null;
    this.candidate = null;
    if (latch && this.flags().alt) this.latched = true;
  }

  private setTapMode(on: boolean) {
    this.tapMode = on;
    if (this.tapTimer) this.clock.clearTimeout(this.tapTimer);
    this.tapTimer = on ? this.clock.setTimeout(() => { this.tapTimer = null; this.tapMode = false; }, TAP_MODE_MAX) : null;
  }
}
