// Esc, Alt+P, Alt+O and Alt+Enter while the overlay is up, and Alt+E while an error is offered (HotKeys.set(.dismiss/
// .pin/.open/.allow/.fixError) on macOS).
// The evdev / XInput2 listener only *sees* them; to take them away from the focused app like macOS does, they're
// also registered with Electron's globalShortcut (an X grab), only while they mean something. A press can arrive
// both ways, so each key fires once per press.

export type OverlayKey = "esc" | "pin" | "open" | "allow" | "fix";

export const ACCELERATORS: Record<OverlayKey, string> = { esc: "Escape", pin: "Alt+P", open: "Alt+O", allow: "Alt+Enter", fix: "Alt+E" };

export interface ShortcutApi {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}

export class OverlayKeys {
  private on = new Set<OverlayKey>();
  /** Settings → Shortcuts' choices (Esc stays). */
  private accel: Record<OverlayKey, string> = { ...ACCELERATORS };
  private last = new Map<OverlayKey, number>();
  static readonly DEDUPE_MS = 400;

  constructor(private api: ShortcutApi | null, private fire: (k: OverlayKey) => void, private now = () => Date.now()) {}

  /** Which keys are live now; registers the new ones, releases the rest. */
  set(keys: Partial<Record<OverlayKey, boolean>>) {
    for (const k of Object.keys(ACCELERATORS) as OverlayKey[]) {
      const want = !!keys[k];
      if (want === this.on.has(k)) continue;
      if (want) {
        this.on.add(k);
        try { this.api?.register(this.accel[k], () => this.press(k)); } catch {}
      } else {
        this.on.delete(k);
        try { this.api?.unregister(this.accel[k]); } catch {}
      }
    }
  }

  /** New key combinations take effect at once for the keys live now (HotKeys.reload). */
  setAccelerators(a: Partial<Record<OverlayKey, string>>) {
    const live = Object.fromEntries([...this.on].map((k) => [k, true]));
    this.clear();
    this.accel = { ...this.accel, ...a, esc: "Escape" };
    this.set(live);
  }

  get active(): boolean { return this.on.size > 0; }
  has(k: OverlayKey) { return this.on.has(k); }

  /** A press from either source; dropped when the same key fired a moment ago (the other source's copy). */
  press(k: OverlayKey) {
    if (!this.on.has(k)) return;
    const t = this.now(), prev = this.last.get(k);
    if (prev !== undefined && t - prev < OverlayKeys.DEDUPE_MS) return;
    this.last.set(k, t);
    this.fire(k);
  }

  clear() { this.set({}); }
}
