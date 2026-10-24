// Customizable shortcuts (Hotkeys.swift, ShortcutsCard.swift): parsing, storing, duplicates, and the hold machine
// following the chosen keys.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { HotkeyEvent } from "../../src/main/contracts";
import { EV_KEY, KEY } from "../../src/main/input/evdev";
import { HoldMachine, type Clock } from "../../src/main/input/hold";
import { feedEvent } from "../../src/main/input/index";
import {
  DEFAULT_SHORTCUTS, activeKeys, holdNames, keyName, machineKeys, parseShortcut, recordShortcut, resolveShortcuts, shortcutLabel, vkToEvdev,
} from "../../src/main/input/shortcuts";
import { vkToCode } from "../../src/main/input/win32";

const press = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) =>
  ({ code, ctrl: false, alt: false, shift: false, meta: false, ...mods });

test("shortcuts: parsing and labels", () => {
  assert.deepEqual(parseShortcut("Alt+Shift+Space"), { ctrl: false, alt: true, shift: true, sup: false, key: "Space", code: KEY.SPACE });
  assert.equal(parseShortcut("Ctrl+K")?.code, 37);
  assert.equal(parseShortcut("Super+F12")?.code, 88);
  assert.equal(parseShortcut("Shift+K"), null);      // needs Ctrl, Alt or Super
  assert.equal(parseShortcut("Alt+Comma"), null);    // not a key a shortcut can use
  assert.equal(parseShortcut("Alt+Hyper+K"), null);
  assert.equal(shortcutLabel("Alt+Shift+Super+R", "win32"), "Alt+Shift+Win+R");
  assert.equal(shortcutLabel("Alt+Shift+Super+R", "linux"), "Alt+Shift+Super+R");
  assert.equal(keyName("KeyQ"), "Q");
  assert.equal(keyName("Digit7"), "7");
  assert.equal(keyName("NumpadEnter"), "Enter");
  assert.equal(keyName("ArrowLeft"), "Left");
  assert.equal(keyName("Comma"), null);
  assert.deepEqual(holdNames("alt", "linux"), { name: "Alt", screen: "Alt+Super", added: "Super" });
  assert.deepEqual(holdNames("ctrl", "win32"), { name: "Ctrl", screen: "Ctrl+Win", added: "Win" });
  assert.deepEqual(holdNames("super", "linux"), { name: "Super", screen: "Alt+Super", added: "Alt" });
  // Windows keys reach the hold machine as the same evdev codes.
  assert.equal(vkToEvdev(0x4b), 37);
  assert.equal(vkToCode(0x4b), 37);
  assert.equal(vkToCode(0x70), 59);
});

test("shortcuts: storing, resetting by matching the default, invalid saved values ignored", () => {
  const r = recordShortcut({}, "pin", press("KeyK", { ctrl: true, alt: true }), "linux");
  assert.deepEqual(r, { saved: { pin: "Ctrl+Alt+K" } });
  assert.equal(resolveShortcuts(r.saved).pin, "Ctrl+Alt+K");
  assert.equal(resolveShortcuts(r.saved).open, "Alt+O");
  assert.deepEqual(recordShortcut({ pin: "Ctrl+Alt+K" }, "pin", press("KeyP", { alt: true }), "linux"), { saved: {} });
  assert.deepEqual(recordShortcut({}, "meeting", press("KeyM", { alt: true, meta: true }), "win32"), { saved: { meeting: "Alt+Super+M" } });
  assert.deepEqual(resolveShortcuts({ pin: "garbage", open: "Shift+O" }), DEFAULT_SHORTCUTS);
  assert.deepEqual(resolveShortcuts(null), DEFAULT_SHORTCUTS);
});

test("shortcuts: duplicates and keys without a modifier are refused", () => {
  assert.deepEqual(recordShortcut({}, "pin", press("KeyO", { alt: true }), "linux"), { note: "Alt+O is already used for “Open the file in the answer”." });
  assert.deepEqual(recordShortcut({ open: "Ctrl+Alt+K" }, "pin", press("KeyK", { ctrl: true, alt: true }), "linux"),
    { note: "Ctrl+Alt+K is already used for “Open the file in the answer”." });
  assert.deepEqual(recordShortcut({}, "fix", press("KeyR", { alt: true, shift: true, meta: true }), "win32"), { note: "Alt+Shift+Win+R is already used for “Meeting Notes”." });
  assert.equal(recordShortcut({}, "pin", press("KeyK", { shift: true }), "linux").note, "Use Ctrl, Alt or Super with the key, so it doesn't stop you typing.");
  assert.match(recordShortcut({}, "pin", press("Comma", { alt: true }), "linux").note ?? "", /can't be used/);
});

// ── The hold machine with other keys ──

class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private ids = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.ids; this.timers.push({ at: this.t + ms, fn, id }); return id; }
  clearTimeout(id: unknown) { this.timers = this.timers.filter((t) => t.id !== id); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

function machine() {
  const clock = new FakeClock(), events: HotkeyEvent[] = [], down = new Set<number>();
  const m = new HoldMachine((e) => events.push(e), clock);
  return { clock, m, events, down: (c: number) => feedEvent(m, down, EV_KEY, c, 1), up: (c: number) => feedEvent(m, down, EV_KEY, c, 0) };
}

afterEach(() => { activeKeys.current = machineKeys("alt", DEFAULT_SHORTCUTS); });

test("hold machine: Ctrl to talk, Ctrl+Super for a screenshot, Alt alone does nothing", () => {
  activeKeys.current = machineKeys("ctrl", DEFAULT_SHORTCUTS);
  const t = machine();
  t.down(KEY.LEFTALT); t.clock.advance(400); t.up(KEY.LEFTALT);
  assert.equal(t.events.length, 0);
  t.down(KEY.LEFTCTRL); t.clock.advance(400);
  t.down(KEY.LEFTMETA); t.clock.advance(500);
  t.up(KEY.LEFTMETA); t.up(KEY.LEFTCTRL);
  assert.deepEqual(t.events.map((e) => e.type), ["holdStart", "screenshot", "holdEnd"]);
});

test("hold machine: Super holders add Alt for a screenshot", () => {
  activeKeys.current = machineKeys("super", DEFAULT_SHORTCUTS);
  const t = machine();
  t.down(KEY.LEFTMETA); t.down(KEY.LEFTALT); t.clock.advance(900);
  t.up(KEY.LEFTALT); t.up(KEY.LEFTMETA);
  assert.deepEqual(t.events, [{ type: "holdStart", screenshot: true }, { type: "holdEnd" }]);
});

test("hold machine: re-recorded point and pin keys", () => {
  activeKeys.current = machineKeys("alt", resolveShortcuts({ point: "Ctrl+Alt+Space", pin: "Ctrl+Alt+K" }));
  const t = machine();
  t.m.overlayKeys = true;
  t.down(KEY.LEFTALT); t.down(25); t.up(25); t.up(KEY.LEFTALT);          // Alt+P: no longer pin
  t.down(KEY.LEFTCTRL); t.down(KEY.LEFTALT); t.down(37); t.up(37);       // Ctrl+Alt+K: pin
  t.down(KEY.SPACE);                                                     // Ctrl+Alt+Space: point
  t.clock.advance(500);
  t.up(KEY.LEFTCTRL);                                                    // a modifier let go ends it
  assert.deepEqual(t.events.map((e) => (e.type === "overlayKey" ? e.key : e.type)), ["pin", "pointMode", "holdEnd"]);
});
