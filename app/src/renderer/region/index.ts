// Drag to select a region (Overlays.swift SelectionView): the display dims, a crosshair drags out a cyan box that
// cuts through the dim; release sends the rect (DIPs local to this display) on "region:done", esc sends null.
// Point mode: the pointer goes to main on "region:hover", which boxes the element under it ("region:box"); a click
// (no drag) picks that box ("region:pick").

import type { Point, Rect } from "../../main/contracts";
import { vcli } from "../shared/bridge";

const root = document.getElementById("root")!;
root.innerHTML = `<svg class="canvas"><path class="dim" fill-rule="evenodd"/><rect class="sel" rx="4"/></svg>
  <div class="hint">Click a part of the screen, or drag around it · keep talking · esc to cancel</div>`;
const dim = root.querySelector<SVGPathElement>(".dim")!;
const sel = root.querySelector<SVGRectElement>(".sel")!;
const hint = root.querySelector<HTMLElement>(".hint")!;
let start: Point | null = null, current: Point | null = null;
let box: Rect | null = null; // the element under the pointer
let finished = false;

function selection(): Rect | null {
  if (!start || !current) return null;
  return { x: Math.min(start.x, current.x), y: Math.min(start.y, current.y), width: Math.abs(start.x - current.x), height: Math.abs(start.y - current.y) };
}

function draw() {
  const w = innerWidth, h = innerHeight, r = selection() ?? box;
  const hole = r ? `M${r.x + 4},${r.y} h${r.width - 8} a4,4 0 0 1 4,4 v${r.height - 8} a4,4 0 0 1 -4,4 h-${r.width - 8} a4,4 0 0 1 -4,-4 v-${r.height - 8} a4,4 0 0 1 4,-4 Z` : "";
  dim.setAttribute("d", `M0,0 H${w} V${h} H0 Z ${r && r.width > 8 && r.height > 8 ? hole : ""}`);
  sel.style.display = r ? "" : "none";
  if (r) for (const [k, v] of Object.entries(r)) sel.setAttribute(k, `${v}`);
  hint.hidden = !!r;
}

function done(rect: Rect | null) {
  if (finished) return;
  finished = true;
  vcli.send("region:done", rect);
}

addEventListener("mousedown", (e) => { if (e.button !== 0) return; start = current = { x: e.clientX, y: e.clientY }; draw(); });
addEventListener("mousemove", (e) => {
  if (!start) { vcli.send("region:hover", { x: e.clientX, y: e.clientY }); return; }
  current = { x: e.clientX, y: e.clientY };
  draw();
});
addEventListener("mouseup", (e) => {
  if (!start) return;
  current = { x: e.clientX, y: e.clientY };
  const r = selection();
  if (r && r.width > 8 && r.height > 8) { done(r); return; }
  // A click (no drag) picks the element under the pointer; with none, keep waiting for a click or drag.
  if (box) vcli.send("region:pick");
  start = current = null;
  draw();
});
addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
addEventListener("contextmenu", (e) => { e.preventDefault(); done(null); });
addEventListener("resize", draw);
// Main reuses the window: a new selection starts clean.
vcli.on("region:reset", () => { start = current = box = null; finished = false; draw(); });
vcli.on("region:box", (r) => { box = r as Rect | null; if (!start) draw(); });
draw();
