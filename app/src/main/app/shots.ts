import type { DesktopWindow, Jpeg, Mark as DrawMark, Point, Rect } from "../contracts";
import type { Mark } from "../core/markup";
import { isTerminal } from "../features/projects";

// Screenshots attached to a question (Screen.swift Shot / WinInfo) and the geometry that ties image pixels to the
// screen: the pointer in the image, marks drawn back over the real thing, and shots.json for clicks at image pixels.
// Everything is global pixels, top-left origin (contracts.ts).

export interface Shot {
  jpeg: Buffer;
  pixelSize: { width: number; height: number };
  screenRect: Rect;          // the area captured
  label: string;
  window?: DesktopWindow;
  pointer?: Point;           // pointer position in image pixels, if inside
  file?: string;
}

/** WinInfo.label: `App — "title"`, or the app alone. */
export const windowLabel = (w: Pick<DesktopWindow, "app" | "title">) => (w.title ? `${w.app} — "${w.title}"` : w.app);

const inside = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;

export function makeShot(jpeg: Jpeg, rect: Rect, label: string, pointer: Point | null, window?: DesktopWindow): Shot {
  const shot: Shot = { jpeg: jpeg.data, pixelSize: { width: jpeg.width, height: jpeg.height }, screenRect: rect, label, window };
  if (pointer && inside(rect, pointer) && rect.width > 0 && rect.height > 0) {
    shot.pointer = {
      x: Math.round((pointer.x - rect.x) / rect.width * jpeg.width),
      y: Math.round((pointer.y - rect.y) / rect.height * jpeg.height),
    };
  }
  return shot;
}

/** Image pixel → screen pixel. */
export function screenPoint(shot: Pick<Shot, "screenRect" | "pixelSize">, p: Point): Point {
  const r = shot.screenRect;
  return { x: r.x + p.x * r.width / shot.pixelSize.width, y: r.y + p.y * r.height / shot.pixelSize.height };
}

/** The answer's [[box/circle/arrow/step]] markers (image pixels of image N) as overlay marks in screen pixels.
 *  Arrows keep their direction (rect from a to b, width/height may be negative); steps sit at a. */
export function drawMarks(marks: Mark[], shots: Pick<Shot, "screenRect" | "pixelSize">[]): DrawMark[] {
  if (!shots.length) return [];
  return marks.map((m) => {
    const shot = shots[Math.min(Math.max(m.image, 1), shots.length) - 1];
    const a = screenPoint(shot, m.a), b = screenPoint(shot, m.b);
    if (m.kind.type === "step") return { kind: "step", rect: { x: a.x, y: a.y, width: 0, height: 0 }, label: m.label, n: m.kind.n };
    if (m.kind.type === "arrow") return { kind: "arrow", rect: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }, label: m.label };
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { kind: m.kind.type, rect: { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, label: m.label };
  });
}

/** The window directly under the pointer, terminals included (front-most first list). */
export function rawWindowUnderPointer(windows: DesktopWindow[], p: Point | null): DesktopWindow | null {
  return p ? windows.find((w) => inside(w.bounds, p)) ?? null : null;
}

/** The window under the pointer, or (if that's a terminal or nothing) the front-most non-terminal window. */
export function windowUnderPointer(windows: DesktopWindow[], p: Point | null): DesktopWindow | null {
  const hit = rawWindowUnderPointer(windows, p);
  if (hit && !isTerminal(hit)) return hit;
  return windows.find((w) => !isTerminal(w)) ?? null;
}

/** "Selected area of <window>" (the window the region overlaps, else "Screen"). */
export function regionLabel(windows: DesktopWindow[], r: Rect): string {
  const w = windows.find((x) => x.bounds.x < r.x + r.width && r.x < x.bounds.x + x.bounds.width && x.bounds.y < r.y + r.height && r.y < x.bounds.y + x.bounds.height);
  return "Selected area of " + (w ? windowLabel(w) : "Screen");
}

/** `r` grown by `by` on every side, kept inside `bounds` (a picked element's margin, within its display). */
export function grow(r: Rect, by: number, bounds?: Rect): Rect {
  let x1 = r.x - by, y1 = r.y - by, x2 = r.x + r.width + by, y2 = r.y + r.height + by;
  if (bounds) {
    x1 = Math.max(x1, bounds.x); y1 = Math.max(y1, bounds.y);
    x2 = Math.min(x2, bounds.x + bounds.width); y2 = Math.min(y2, bounds.y + bounds.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function sameWindow(a?: DesktopWindow, b?: DesktopWindow) { return !!a && !!b && a.id === b.id; }
