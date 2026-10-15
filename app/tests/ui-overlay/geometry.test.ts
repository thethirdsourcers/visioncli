import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DisplayInfo, clampInto, displayForPixel, localDipToPixels, marksByDisplay, mascotSize, placeBadge, placeBubble,
  placeFrozen, placeHud, placeMascot, toDipPoint, toDipRect,
} from "../../src/main/ui/overlay/geometry";

// A 2× laptop panel (2880×1800 px = 1440×900 DIP) with a 1× monitor to its right.
const laptop: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 32, width: 1440, height: 868 }, scaleFactor: 2, nativeOrigin: { x: 0, y: 0 } };
const monitor: DisplayInfo = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, workArea: { x: 1440, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, nativeOrigin: { x: 2880, y: 0 } };
const displays = [laptop, monitor];

test("pixels map to DIPs on the right display", () => {
  assert.equal(displayForPixel({ x: 100, y: 100 }, displays).id, 1);
  assert.equal(displayForPixel({ x: 2900, y: 10 }, displays).id, 2);
  assert.deepEqual(toDipPoint({ x: 200, y: 100 }, displays), { x: 100, y: 50 });
  assert.deepEqual(toDipPoint({ x: 2980, y: 40 }, displays), { x: 1540, y: 40 });
  assert.deepEqual(toDipRect({ x: 400, y: 200, width: 600, height: 300 }, displays), { x: 200, y: 100, width: 300, height: 150 });
  // Off every display: the nearest one.
  assert.equal(displayForPixel({ x: -50, y: 10 }, displays).id, 1);
});

test("a local DIP rect goes back to global pixels", () => {
  assert.deepEqual(localDipToPixels({ x: 10, y: 20, width: 100, height: 50 }, laptop), { x: 20, y: 40, width: 200, height: 100 });
  assert.deepEqual(localDipToPixels({ x: 10, y: 20, width: 100, height: 50 }, monitor), { x: 2890, y: 20, width: 100, height: 50 });
});

test("the pill rides right of the pointer, centred 22 below it", () => {
  const r = placeBubble("pill", { width: 200, height: 40 }, { x: 500, y: 400 }, laptop.workArea);
  assert.deepEqual(r, { x: 514, y: 402, width: 200, height: 40 });
});

test("the pill stays on screen near the edges", () => {
  const r = placeBubble("pill", { width: 200, height: 40 }, { x: 1430, y: 895 }, laptop.workArea);
  assert.equal(r.x, 1440 - 200 - 4);
  assert.equal(r.y, 32 + 868 - 40 - 4);
});

test("answers sit top-right of the work area, under the task HUD", () => {
  assert.deepEqual(placeBubble("corner", { width: 460, height: 300 }, { x: 10, y: 10 }, laptop.workArea), { x: 968, y: 44, width: 460, height: 300 });
  assert.equal(placeBubble("corner", { width: 460, height: 300 }, { x: 10, y: 10 }, laptop.workArea, 150).y, 194);
});

test("a pinned bubble keeps its top-left and stays inside its screen", () => {
  const r = placeFrozen({ x: 900, y: 600, width: 460, height: 100 }, { width: 460, height: 400 }, laptop.workArea);
  assert.deepEqual(r, { x: 900, y: 900 - 400 - 4, width: 460, height: 400 });
  assert.deepEqual(clampInto({ x: -20, y: 0, width: 10, height: 10 }, laptop.workArea), { x: 4, y: 36, width: 10, height: 10 });
});

test("the mascot's cut edge sits on the display's right edge, 12 % up", () => {
  const r = placeMascot(monitor);
  assert.equal(r.x + r.width, 1440 + 1920);
  assert.equal(r.width, mascotSize.width);
  assert.equal(r.height, 162);
  assert.equal(r.y, Math.round(1040 - 1040 * 0.12 - 162));
});

test("badge and HUD corners", () => {
  assert.deepEqual(placeBadge({ width: 200, height: 36 }, laptop.workArea), { x: 620, y: 38, width: 200, height: 36 });
  assert.deepEqual(placeHud({ width: 328, height: 100 }, laptop.workArea), { x: 1100, y: 44, width: 328, height: 100 });
});

test("marks go to the display holding their midpoint, in local DIPs", () => {
  const groups = marksByDisplay([
    { kind: "box", rect: { x: 200, y: 200, width: 400, height: 100 }, label: "Here" },
    { kind: "arrow", rect: { x: 3000, y: 500, width: -100, height: -50 } },
    { kind: "step", rect: { x: 3100, y: 600, width: 0, height: 0 }, label: "Click" },
  ], displays);
  assert.equal(groups.length, 2);
  const l = groups.find((g) => g.display.id === 1)!;
  assert.deepEqual(l.marks[0], { kind: "box", a: { x: 100, y: 100 }, b: { x: 300, y: 150 }, label: "Here" });
  const m = groups.find((g) => g.display.id === 2)!;
  assert.deepEqual(m.marks[0], { kind: "arrow", a: { x: 120, y: 500 }, b: { x: 20, y: 450 }, label: "" });
  assert.deepEqual(m.marks[1], { kind: "step", a: { x: 220, y: 600 }, b: { x: 220, y: 600 }, label: "Click", n: 1 });
});
