import assert from "node:assert/strict";
import { test } from "node:test";
import { applyContentProtection, canHideFromCapture, installContentProtection, type ProtectableWindow } from "../../src/main/ui/windows/protection";

const win = (destroyed = false) => {
  const w = { calls: [] as boolean[], isDestroyed: () => destroyed, setContentProtection(on: boolean) { w.calls.push(on); } };
  return w;
};

test("content protection: every open window on Windows, none on Linux", () => {
  const a = win(), b = win(), gone = win(true);
  assert.equal(applyContentProtection([a, b, gone], true, "win32"), 2);
  assert.deepEqual([a.calls, b.calls, gone.calls], [[true], [true], []]);
  assert.equal(applyContentProtection([a], true, "linux"), 0);
  assert.equal(a.calls.length, 1);
  assert.equal(canHideFromCapture("linux"), false);
  assert.equal(canHideFromCapture("win32"), true);
});

test("content protection: new windows get it while on, and a change re-applies to all", () => {
  let on = false;
  let created: (w: ProtectableWindow) => void = () => {};
  let changed: () => void = () => {};
  const open = [win(), win()];
  installContentProtection({
    onWindowCreated: (cb) => { created = cb; }, allWindows: () => open, isOn: () => on, onChange: (cb) => { changed = cb; }, platform: "win32",
  });
  const first = win();
  created(first);
  assert.deepEqual(first.calls, []); // off: untouched
  on = true;
  changed();
  assert.deepEqual(open.map((w) => w.calls), [[true], [true]]);
  const later = win();
  created(later);
  assert.deepEqual(later.calls, [true]);
  on = false;
  changed();
  assert.deepEqual(open.map((w) => w.calls), [[true, false], [true, false]]);
});

test("content protection: nothing is hooked on Linux", () => {
  let hooked = 0;
  installContentProtection({ onWindowCreated: () => { hooked++; }, allWindows: () => [], isOn: () => true, onChange: () => { hooked++; }, platform: "linux" });
  assert.equal(hooked, 0);
});
