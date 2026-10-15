// Placement math for the overlay windows (App+Panel.follow, Mascot.place, Badge, Tasks), kept free of
// Electron so it can be tested. Everything here is top-left origin. Callers pass global *pixels* (contracts.ts);
// windows are placed in Electron DIPs, so pixels go through toDip* first.

import type { Point, Rect } from "../../contracts";

/** The parts of Electron's Display this module needs. */
export interface DisplayInfo {
  id: number;
  bounds: Rect;          // DIP
  workArea: Rect;        // DIP, without panels/docks
  scaleFactor: number;
  nativeOrigin: Point;   // pixel origin of the display
}

export interface Size { width: number; height: number }

export const contains = (r: Rect, p: Point) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
const nativeRect = (d: DisplayInfo): Rect =>
  ({ x: d.nativeOrigin.x, y: d.nativeOrigin.y, width: d.bounds.width * d.scaleFactor, height: d.bounds.height * d.scaleFactor });

/** The display holding a pixel point (or the nearest one). Electron's own screenToDip* are Windows-only. */
export function displayForPixel(p: Point, displays: DisplayInfo[]): DisplayInfo {
  return displays.find((d) => contains(nativeRect(d), p)) ?? nearest(p, displays, nativeRect);
}

export function displayForDip(p: Point, displays: DisplayInfo[]): DisplayInfo {
  return displays.find((d) => contains(d.bounds, p)) ?? nearest(p, displays, (d) => d.bounds);
}

function nearest(p: Point, displays: DisplayInfo[], rect: (d: DisplayInfo) => Rect): DisplayInfo {
  let best = displays[0], bestDist = Infinity;
  for (const d of displays) {
    const r = rect(d);
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width)), dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
    if (dx * dx + dy * dy < bestDist) { best = d; bestDist = dx * dx + dy * dy; }
  }
  return best;
}

export function toDipPoint(p: Point, displays: DisplayInfo[]): Point {
  const d = displayForPixel(p, displays);
  return { x: d.bounds.x + (p.x - d.nativeOrigin.x) / d.scaleFactor, y: d.bounds.y + (p.y - d.nativeOrigin.y) / d.scaleFactor };
}

/** A pixel rect in DIPs, scaled by the display holding its centre. */
export function toDipRect(r: Rect, displays: DisplayInfo[]): Rect {
  const d = displayForPixel({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, displays);
  const s = d.scaleFactor;
  return { x: d.bounds.x + (r.x - d.nativeOrigin.x) / s, y: d.bounds.y + (r.y - d.nativeOrigin.y) / s, width: r.width / s, height: r.height / s };
}

/** A rect local to display `d` (DIPs from its top-left), back to global pixels. */
export function localDipToPixels(r: Rect, d: DisplayInfo): Rect {
  const s = d.scaleFactor;
  return { x: Math.round(d.nativeOrigin.x + r.x * s), y: Math.round(d.nativeOrigin.y + r.y * s), width: Math.round(r.width * s), height: Math.round(r.height * s) };
}

export function clampInto(r: Rect, area: Rect, margin = 4): Rect {
  const x = Math.min(Math.max(r.x, area.x + margin), area.x + area.width - r.width - margin);
  const y = Math.min(Math.max(r.y, area.y + margin), area.y + area.height - r.height - margin);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(r.width), height: Math.round(r.height) };
}

export type BubbleKind = "pill" | "corner";

/**
 * App+Panel.follow: the listening/thinking pill rides 14 px right of the pointer, centred 22 px below it; answers and
 * approval cards sit in the top-right corner of the pointer's work area, under the task HUD when it's showing.
 */
export function placeBubble(kind: BubbleKind, size: Size, pointer: Point, workArea: Rect, hudHeight = 0): Rect {
  const r = kind === "pill"
    ? { x: pointer.x + 14, y: pointer.y + 22 - size.height / 2, ...size }
    : { x: workArea.x + workArea.width - size.width - 12, y: workArea.y + 12 + hudHeight, ...size };
  return clampInto(r, workArea);
}

/** Pinned / approval: the bubble stays put (top-left corner kept) and only resizes, kept on its screen. */
export function placeFrozen(current: Rect, size: Size, workArea: Rect): Rect {
  return clampInto({ x: current.x, y: current.y, ...size }, workArea);
}

// Mascot.swift geometry: 130 pt tall frames (285×360 px), room above/left for the antenna glow, the body cut at
// 264/285 of the image width sitting exactly on the screen's right edge.
export const MASCOT = { height: 130, headroom: 32, sideroom: 28, cutX: 264 / 285, aspect: 285 / 360 };
export const mascotImageWidth = MASCOT.height * MASCOT.aspect;
export const mascotSize: Size = {
  width: Math.round(MASCOT.sideroom + mascotImageWidth * MASCOT.cutX), height: MASCOT.height + MASCOT.headroom,
};

/** Right edge of the display, its bottom 12 % of the work area up from the bottom (AppKit's y = vf.minY + vf.h·0.12). */
export function placeMascot(d: DisplayInfo): Rect {
  const wa = d.workArea;
  return {
    x: d.bounds.x + d.bounds.width - mascotSize.width,
    y: Math.round(wa.y + wa.height - wa.height * 0.12 - mascotSize.height),
    ...mascotSize,
  };
}

/** ActivityBadge: centred at the top of the work area, 6 pt down. */
export function placeBadge(size: Size, workArea: Rect): Rect {
  return { x: Math.round(workArea.x + workArea.width / 2 - size.width / 2), y: workArea.y + 6, ...size };
}

/** TaskHUD: top-right corner, 12 pt in. */
export function placeHud(size: Size, workArea: Rect): Rect {
  return { x: workArea.x + workArea.width - size.width - 12, y: workArea.y + 12, ...size };
}

export interface DipMark { kind: "box" | "circle" | "arrow" | "step"; a: Point; b: Point; label: string; n?: number }

/**
 * Marks (global pixels) grouped per display, in DIPs local to that display. A mark belongs to the display holding its
 * midpoint (HighlightOverlay.draw). Box/circle use the rect's corners; an arrow runs from (x, y) to (x+width, y+height)
 * (negative sizes point back); a step sits at the rect's centre (a zero-size rect = a point).
 */
export function marksByDisplay(marks: { kind: DipMark["kind"]; rect: Rect; label?: string; n?: number }[], displays: DisplayInfo[]) {
  const out = new Map<number, { display: DisplayInfo; marks: DipMark[] }>();
  for (const m of marks) {
    const a = { x: m.rect.x, y: m.rect.y }, b = { x: m.rect.x + m.rect.width, y: m.rect.y + m.rect.height };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = displayForPixel(mid, displays);
    const local = (p: Point) => ({ x: (p.x - d.nativeOrigin.x) / d.scaleFactor, y: (p.y - d.nativeOrigin.y) / d.scaleFactor });
    const entry = out.get(d.id) ?? { display: d, marks: [] };
    entry.marks.push(m.kind === "step"
      ? { kind: "step", a: local(mid), b: local(mid), label: m.label ?? "", n: m.n ?? entry.marks.filter((x) => x.kind === "step").length + 1 }
      : { kind: m.kind, a: local(a), b: local(b), label: m.label ?? "" });
    out.set(d.id, entry);
  }
  return [...out.values()];
}
