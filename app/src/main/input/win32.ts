import { EventEmitter } from "node:events";
import type { HotkeyEvent, Hotkeys } from "../contracts";
import type { WinHelper } from "../desktop/windows/win32";
import { log } from "../log";
import { KEY } from "./evdev";
import { type Clock, HoldMachine } from "./hold";

// Windows hold-to-talk: the helper's low-level keyboard and mouse hooks (WH_KEYBOARD_LL / WH_MOUSE_LL) stream key,
// button and motion events, which go into the same HoldMachine as the Linux backends (as evdev codes). Hooks observe
// and never swallow, so Esc / Alt+P / Alt+O / Alt+Enter also reach the focused app, as on Linux.
//
// The Alt menu bar: in Windows a lone Alt press and release activates the focused window's menu bar (and a lone Win
// release opens Start). Holding Alt to talk and letting go would move focus to the menu bar in many apps. Like other
// push-to-talk tools, once a hold really started listening, the helper presses and releases VK 0xE8 (unassigned)
// while Alt/Win are still down, so Windows sees "Alt+something" and does nothing on release. The helper's own
// injected keys are tagged and never come back as hook events.

/** Windows virtual-key codes the hold machine cares about. */
export const VK = {
  RETURN: 0x0d, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, ESCAPE: 0x1b, SPACE: 0x20, E: 0x45, O: 0x4f, P: 0x50,
  LWIN: 0x5b, RWIN: 0x5c, LSHIFT: 0xa0, RSHIFT: 0xa1, LCONTROL: 0xa2, RCONTROL: 0xa3, LMENU: 0xa4, RMENU: 0xa5,
} as const;

/** The masking key: unassigned, so no app reacts to it (the AutoHotkey "menu mask" trick). */
export const MASK_KEY = "vk:0xE8";

/** Keys with no evdev twin in hold.ts still count as "another key" (cancels a hold): an offset keeps them apart. */
const OTHER = 0x1000;

/** A VK code → the evdev code HoldMachine expects (Alt, Super, Shift, Ctrl, Space, Esc, P, O, E, Enter; others offset). */
export function vkToCode(vk: number): number {
  switch (vk) {
    case VK.MENU: case VK.LMENU: return KEY.LEFTALT;
    case VK.RMENU: return KEY.RIGHTALT;
    case VK.LWIN: return KEY.LEFTMETA;
    case VK.RWIN: return KEY.RIGHTMETA;
    case VK.SHIFT: case VK.LSHIFT: return KEY.LEFTSHIFT;
    case VK.RSHIFT: return KEY.RIGHTSHIFT;
    case VK.CONTROL: case VK.LCONTROL: return KEY.LEFTCTRL;
    case VK.RCONTROL: return KEY.RIGHTCTRL;
    case VK.SPACE: return KEY.SPACE;
    case VK.ESCAPE: return KEY.ESC;
    case VK.P: return KEY.P;
    case VK.O: return KEY.O;
    case VK.E: return KEY.E;
    case VK.RETURN: return KEY.ENTER;
    default: return OTHER + vk;
  }
}

export class WinHotkeys extends EventEmitter implements Hotkeys {
  private machine: HoldMachine;
  private down = new Set<number>();
  private started = false;
  private subscribed = false;
  /** When the pointer last moved (ms), so the overlay reads its position only after it did. */
  lastMotion = 0;
  get seesMotion() { return this.started; }

  constructor(private helper: WinHelper, clock?: Clock) {
    super();
    this.machine = new HoldMachine((e) => this.fire(e), clock);
  }

  private fire(e: HotkeyEvent) {
    log(`hotkey ${e.type}${e.type === "overlayKey" ? " " + e.key : ""}`);
    // Listening started (or became a screenshot question, i.e. Win is down too): mask Alt/Win before they're let go.
    if (e.type === "holdStart" || e.type === "screenshot") {
      this.helper.call("key", { combo: MASK_KEY }).catch((err) => log(`hotkeys: menu mask: ${(err as Error).message}`));
    }
    this.emit("hotkey", e);
  }

  async start(): Promise<{ backend: string; problem?: string }> {
    if (!this.subscribed) {
      this.subscribed = true;
      this.helper.on("key", (k) => this.key(k.vk, k.down));
      this.helper.on("button", (b) => { if (this.started && b.down) this.machine.button(); });
      this.helper.on("motion", () => { this.lastMotion = Date.now(); });
    }
    try {
      await this.helper.call("hooks.start", {});
      this.started = true;
      log("hotkeys: Windows low-level hooks");
      return { backend: "hook" };
    } catch (e) {
      log(`hotkeys: hooks failed: ${(e as Error).message}`);
      return { backend: "none", problem: `Hold-to-talk couldn't watch the keyboard (${(e as Error).message}). Restart VisionCLI.` };
    }
  }

  /** One hook event; auto-repeat (another "down" while held) is dropped like evdev's value 2. */
  key(vk: number, down: boolean) {
    if (!this.started) return;
    const code = vkToCode(vk);
    if (down) { if (this.down.has(code)) return; this.down.add(code); this.machine.key(code, true); }
    else { if (!this.down.delete(code)) return; this.machine.key(code, false); }
  }

  setOverlayKeys(on: boolean) { this.machine.overlayKeys = on; }

  /** Optional (not in the contract): the app's phase is listening, so the next Alt press counts at once. */
  setListening(on: boolean) { this.machine.listening = on; }

  stop() {
    this.started = false;
    this.machine.stop();
    this.down.clear();
    this.helper.call("hooks.stop", {}).catch(() => {});
  }
}
