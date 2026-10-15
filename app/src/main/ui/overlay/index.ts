// The overlay UI (Views.swift, App+Panel.swift, Mascot.swift, Overlays.swift, Spotlight.swift, Badge.swift, Tasks.swift):
// the windows that float over the user's screen. The orchestrator drives them with
// OverlayState and gets BubbleActions back. Inputs are global pixels (contracts.ts); windows are placed in DIPs.

import { screen } from "electron";
import { execFile } from "node:child_process";
import type { BubbleAction, Mark, OverlayState, Point, Rect, TaskStep } from "../../contracts";
import { log } from "../../log";
import {
  type DisplayInfo, type Size, contains, displayForDip, displayForPixel, localDipToPixels, marksByDisplay, placeBadge,
  placeBubble, placeFrozen, placeHud, placeMascot, toDipPoint, toDipRect,
} from "./geometry";
import { overlaySupport } from "./platform";
import { OverlayWindow } from "./window";

export { overlaySupport } from "./platform";
export type { OverlaySupport } from "./platform";

export type MascotState = "peek" | "listening" | "thinking" | "hidden";
export type HudAction = "pause" | "resume" | "stop";

export interface OverlayUI {
  render(state: OverlayState): void;
  onAction(cb: (a: BubbleAction) => void): void;
  /** Draws marks over the screen for `durationMs` (plus 0.35 s per mark for the sequential animation). `dashed`
   *  draws dashed boxes (a selected area); `persistent` keeps them until hideMarks(). */
  showMarks(marks: Mark[], durationMs: number, opts?: { dashed?: boolean; persistent?: boolean }): void;
  hideMarks(): void;
  /** Drag-to-select on every display; resolves with the rect in global pixels, or null (esc / right click / tiny). */
  selectRegion(): Promise<Rect | null>;
  cancelRegion(): void;
  /** Dims the pointer's display except `hole` (global pixels); null hides it. Call again to move the hole. */
  spotlight(hole: Rect | null): void;
  /** The activity pill at the top of the pointer's screen; hides by itself after `seconds` (2.5). null hides it now. */
  badge(text: string | null, opts?: { icon?: string; tint?: string; seconds?: number }): void;
  /** Glowing screen edges while using the computer. With `seconds`, turns itself off (each call extends it). */
  controlGlow(on: boolean, seconds?: number): void;
  hud: {
    update(steps: TaskStep[], paused: boolean, title?: string): void;
    hide(): void;
    onAction(cb: (a: HudAction) => void): void;
    /** Height the HUD takes in the top-right corner (the bubble goes under it). */
    readonly visibleHeight: number;
  };
  mascot: { state(state: MascotState, level?: number): void };
  pointerOverBubble(): boolean;
  /** Hides every overlay window while `fn` runs (screenshots on X11 include windows on top of the target). */
  hiddenDuring<T>(fn: () => Promise<T>): Promise<T>;
  destroy(): void;
}

export interface OverlayOptions {
  /** When the pointer last moved (epoch ms), from the hotkey reader; null = unknown, so the pointer is always read. */
  motion?: () => number | null;
  /** The pointer in global pixels: pass Desktop.pointer. Electron's screen.getCursorScreenPoint() is not usable on
   *  Linux: it only updates while the pointer moves over our own windows (verified under Xvfb/openbox). Without this,
   *  `xdotool getmouselocation` is used on X11. */
  pointer?: () => Promise<Point | null>;
}

const xdotoolPointer = (): Promise<Point | null> => new Promise((resolve) => {
  execFile("xdotool", ["getmouselocation", "--shell"], { timeout: 500 }, (err, out) => {
    const x = /X=(-?\d+)/.exec(out ?? ""), y = /Y=(-?\d+)/.exec(out ?? "");
    resolve(err || !x || !y ? null : { x: Number(x[1]), y: Number(y[1]) });
  });
});

const displaysNow = (): DisplayInfo[] =>
  screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, nativeOrigin: d.nativeOrigin ?? { x: d.bounds.x, y: d.bounds.y } }));

export function createOverlayUI(opts: OverlayOptions = {}): OverlayUI {
  const support = overlaySupport(process.env);
  if (support.note) log(`overlay: ${support.note}`);

  // The pointer is read asynchronously and cached: every frame while the pill rides it, 4×/s while anything else
  // shows, not at all while everything is hidden.
  const readPointer = opts.pointer ?? (process.env.DISPLAY ? xdotoolPointer : async () => null);
  let latestPointer: Point | null = null;
  let pointerLoop = true;
  let lastRead = 0;
  const trackPointer = async () => {
    while (pointerLoop) {
      const anyShown = allWindows().some((w) => w.visible) || !!pendingShow || mascotShown;
      // Reading the pointer can mean spawning a process (xdotool, hyprctl): skip it while the mouse hasn't moved,
      // which is most of the time someone is talking.
      const moved = opts.motion?.() ?? null;
      if (anyShown && (moved === null || !latestPointer || moved >= lastRead)) {
        lastRead = Date.now();
        try { latestPointer = (await readPointer()) ?? latestPointer; } catch { /* keep the last one */ }
      }
      await new Promise((r) => setTimeout(r, rides() ? 16 : anyShown ? 250 : 400));
    }
  };
  /** Pointer in DIPs. */
  const pointer = (): Point => latestPointer ? toDipPoint(latestPointer, displaysNow()) : screen.getCursorScreenPoint();
  const pointerDisplay = () => displayForDip(pointer(), displaysNow());

  // ── Bubble (App+Panel) ───────────────────────────────────────────────────────────────────────────────────────────

  const bubble = new OverlayWindow({ page: "bubble" });
  let state: OverlayState | null = null;
  let size: Size = { width: 1, height: 1 };
  let followTimer: NodeJS.Timeout | null = null;
  let followCadence = 0;
  let lastLayout = 0;
  let pendingShow: NodeJS.Timeout | null = null;
  let actionCb: (a: BubbleAction) => void = () => {};
  let lastSent = "";

  const frozen = () => !!state && (state.pinned || state.phase === "approval");
  /** Answers sit in the corner rather than under the pointer, so they take the mouse: scroll, links, buttons. */
  const takesMouse = () => !!state && (frozen() || ["answering", "done", "error"].includes(state.phase));
  const rides = () => !!state && !frozen() && (state.phase === "listening" || state.phase === "thinking");

  function follow(force = false) {
    if (!state || state.phase === "idle" || !bubble.alive) return;
    // Only the pill rides the pointer every frame; answers re-place twice a second (to follow the pointer's screen)
    // and whenever their size changes.
    const now = Date.now();
    if (!force && !rides() && now - lastLayout < 500) return;
    lastLayout = now;
    if (size.width <= 2) return;
    const displays = displaysNow();
    // An approval card that just appeared is placed again when the task panel shows up above it (the panel's
    // size arrives a moment later than on macOS); after that it stays put like any frozen bubble.
    const settle = force && state.phase === "approval" && !state.pinned && hudJustShown();
    if (frozen() && !settle) {
      const cur = bubble.bounds;
      const d = displayForDip({ x: cur.x + cur.width / 2, y: cur.y + cur.height / 2 }, displays);
      bubble.setBounds(placeFrozen(cur, size, d.workArea));
      return;
    }
    const p = pointer();
    const d = displayForDip(p, displays);
    bubble.setBounds(placeBubble(rides() ? "pill" : "corner", size, p, d.workArea, hudHeight()));
  }

  bubble.on("overlay:size", (s: Size) => {
    size = s;
    follow(true);
    if (pendingShow) { clearTimeout(pendingShow); pendingShow = null; bubble.show(); }
  });
  bubble.on("overlay:action", (a: BubbleAction) => actionCb(a));

  function render(next: OverlayState) {
    const prev = state;
    state = { ...next };
    if (next.phase === "idle") {
      if (followTimer) { clearInterval(followTimer); followTimer = null; }
      if (pendingShow) { clearTimeout(pendingShow); pendingShow = null; }
      bubble.hide();
      bubble.send("overlay:state", state);
      lastSent = "";
      return;
    }
    // The mic level changes ~30×/s: send just the level unless something else changed.
    const key = JSON.stringify({ ...state, level: 0 });
    if (key !== lastSent) { lastSent = key; bubble.send("overlay:state", state); }
    else bubble.send("overlay:level", state.level);
    bubble.setClickThrough(!takesMouse());
    // 60 fps only while the pill rides the pointer; an answer is re-placed twice a second (pointer's screen).
    const cadence = rides() ? 1000 / 60 : 500;
    if (followTimer && followCadence !== cadence) { clearInterval(followTimer); followTimer = null; }
    if (!followTimer) { followTimer = setInterval(() => follow(), cadence); followCadence = cadence; }
    if (prev?.phase !== next.phase || prev?.pinned !== next.pinned) {
      follow(true);
      bubble.raise(); // above a spotlight or marks shown meanwhile
    }
    if (!bubble.visible && !pendingShow) {
      // Show once the page has measured the new content (or shortly anyway), so the old size never flashes.
      pendingShow = setTimeout(() => { pendingShow = null; follow(true); bubble.show(); }, 120);
    }
  }

  function pointerOverBubble() {
    if (!bubble.visible) return false;
    return contains(bubble.bounds, pointer());
  }

  // ── Marks (HighlightOverlay) ─────────────────────────────────────────────────────────────────────────────────────

  const markWindows = new Map<number, OverlayWindow>();
  let marksTimer: NodeJS.Timeout | null = null;

  function hideMarks() {
    if (marksTimer) { clearTimeout(marksTimer); marksTimer = null; }
    for (const w of markWindows.values()) { w.send("marks:draw", { items: [], dashed: false }); w.hide(); }
  }

  function showMarks(marks: Mark[], durationMs: number, o: { dashed?: boolean; persistent?: boolean } = {}) {
    hideMarks();
    const groups = marksByDisplay(marks, displaysNow());
    for (const g of groups) {
      let w = markWindows.get(g.display.id);
      if (!w?.alive) { w = new OverlayWindow({ page: "marks", query: { mode: "marks" } }); markWindows.set(g.display.id, w); }
      w.setBounds(g.display.bounds);
      w.send("marks:draw", { items: g.marks, dashed: !!o.dashed });
      w.show();
    }
    bubble.raise();
    // The marks windows map asynchronously and can end up above the bubble and the task panel: raise those again.
    setTimeout(() => { bubble.raise(); hudWin.raise(); }, 250);
    if (!o.persistent) marksTimer = setTimeout(hideMarks, durationMs + marks.length * 350);
  }

  // ── Region selection (RegionSelector) ────────────────────────────────────────────────────────────────────────────

  // One selector window per display, kept and reused so the next selection opens instantly.
  const regionWindows = new Map<number, OverlayWindow>();
  let region: { finish: (r: Rect | null) => void } | null = null;

  function selectRegion(): Promise<Rect | null> {
    region?.finish(null);
    return new Promise((resolve) => {
      const displays = displaysNow();
      for (const [id, w] of regionWindows) if (!displays.some((d) => d.id === id)) { w.destroy(); regionWindows.delete(id); }
      const me = {
        finish: (r: Rect | null) => {
          if (region !== me) return;
          region = null;
          for (const w of regionWindows.values()) w.hide();
          resolve(r);
        },
      };
      region = me;
      const under = displayForDip(pointer(), displays);
      for (const d of displays) {
        let w = regionWindows.get(d.id);
        if (!w?.alive) {
          w = new OverlayWindow({ page: "region", focusable: true, clickThrough: false, bounds: d.bounds });
          regionWindows.set(d.id, w);
        }
        w.on("region:done", (r: Rect | null) => me.finish(r ? localDipToPixels(r, d) : null));
        w.send("region:reset");
        w.setBounds(d.bounds);
        w.show();
        if (d.id === under.id) w.win.focus();
      }
    });
  }

  // ── Spotlight ────────────────────────────────────────────────────────────────────────────────────────────────────

  let spot: OverlayWindow | null = null;

  function spotlight(hole: Rect | null) {
    if (!hole) { spot?.send("spotlight:hole", null); spot?.hide(); return; }
    const displays = displaysNow();
    const d = pointerDisplay();
    const r = toDipRect(hole, displays);
    spot = spot?.alive ? spot : new OverlayWindow({ page: "marks", query: { mode: "spotlight" } });
    spot.setBounds(d.bounds);
    spot.send("spotlight:hole", { x: r.x - d.bounds.x, y: r.y - d.bounds.y, width: r.width, height: r.height });
    if (!spot.visible) { spot.show(); bubble.raise(); }
  }

  // ── Activity badge + control glow (Badge.swift) ──────────────────────────────────────────────────────────────────

  const badgeWin = new OverlayWindow({ page: "badge", lazy: { idleMs: 60_000 } });
  let badgeSize: Size = { width: 240, height: 36 };
  let badgeTimer: NodeJS.Timeout | null = null;
  const placeBadgeNow = () => badgeWin.setBounds(placeBadge(badgeSize, pointerDisplay().workArea));
  badgeWin.on("badge:size", (s: Size) => { badgeSize = s; placeBadgeNow(); });

  function badge(text: string | null, o: { icon?: string; tint?: string; seconds?: number } = {}) {
    if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = null; }
    const fadeOut = () => {
      badgeWin.send("badge:hide");
      badgeTimer = setTimeout(() => { badgeTimer = null; badgeWin.hide(); }, 320);
    };
    if (text === null) { if (badgeWin.visible) fadeOut(); return; }
    badgeWin.send("badge:show", { icon: o.icon, text, tint: o.tint });
    placeBadgeNow();
    badgeWin.show();
    badgeTimer = setTimeout(fadeOut, (o.seconds ?? 2.5) * 1000);
  }

  let glowWin: OverlayWindow | null = null;
  let glowTimer: NodeJS.Timeout | null = null;

  function controlGlow(on: boolean, seconds?: number) {
    if (glowTimer) { clearTimeout(glowTimer); glowTimer = null; }
    if (!on) {
      glowWin?.send("glow:set", false);
      glowTimer = setTimeout(() => { glowTimer = null; glowWin?.hide(); }, 420);
      return;
    }
    glowWin = glowWin?.alive ? glowWin : new OverlayWindow({ page: "marks", query: { mode: "glow" } });
    glowWin.setBounds(pointerDisplay().bounds);
    glowWin.show();
    glowWin.send("glow:set", true);
    if (seconds !== undefined) glowTimer = setTimeout(() => controlGlow(false), seconds * 1000);
  }

  // ── Task HUD (Tasks.swift) ───────────────────────────────────────────────────────────────────────────────────────

  const hudWin = new OverlayWindow({ page: "hud", clickThrough: false, lazy: { idleMs: 60_000 } });
  let hudSize: Size = { width: 328, height: 120 };
  let hudArea: Rect | null = null;
  let hudTimer: NodeJS.Timeout | null = null;
  let hudCb: (a: HudAction) => void = () => {};
  let hudSteps: TaskStep[] = [], hudPaused = false;
  const placeHudNow = () => { if (hudArea) hudWin.setBounds(placeHud(hudSize, hudArea)); };
  hudWin.on("hud:size", (s: Size) => { hudSize = s; placeHudNow(); follow(true); });
  hudWin.on("hud:action", (a: HudAction) => hudCb(a));
  const hudHeight = () => hudWin.visible ? hudWin.bounds.height + 8 : 0;
  let hudShownAt = 0;
  const hudJustShown = () => Date.now() - hudShownAt < 1500;

  const hud: OverlayUI["hud"] = {
    update(steps, paused, title = "Working") {
      hudSteps = steps.slice(-40);
      hudPaused = paused;
      hudWin.send("hud:state", { title, steps: hudSteps, paused });
      if (!hudWin.visible) { hudArea = pointerDisplay().workArea; placeHudNow(); hudWin.show(); hudShownAt = Date.now(); follow(true); }
      // Goes away 12 s after the last step finished (not while paused or something still runs / waits).
      if (hudTimer) clearTimeout(hudTimer);
      hudTimer = setTimeout(() => {
        hudTimer = null;
        if (!hudPaused && !hudSteps.some((s) => s.state === "running" || s.state === "waiting")) hud.hide();
      }, 12_000);
    },
    hide() {
      if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
      hudWin.hide();
      hudPaused = false;
      follow(true);
    },
    onAction(cb) { hudCb = cb; },
    get visibleHeight() { return hudHeight(); },
  };

  // ── Mascot ───────────────────────────────────────────────────────────────────────────────────────────────────────

  const mascotWin = new OverlayWindow({ page: "mascot" });
  let mascotShown = false;
  let mascotMood = "";
  let mascotTimer: NodeJS.Timeout | null = null;
  mascotWin.on("mascot:gone", () => {
    if (mascotShown) return; // shown again meanwhile
    mascotWin.hide();
    if (mascotTimer) { clearInterval(mascotTimer); mascotTimer = null; }
  });
  const placeMascotNow = () => mascotWin.setBounds(placeMascot(pointerDisplay()));

  const mascot: OverlayUI["mascot"] = {
    state(st, level = 0) {
      if (st === "hidden") {
        if (mascotShown) { mascotShown = false; mascotWin.send("mascot:hide"); }
        return;
      }
      mascotWin.send("mascot:level", level);
      const mood = st === "thinking" ? "thinking" : "listening";
      if (!mascotShown || mascotMood !== mood) mascotWin.send("mascot:show", { mood });
      mascotMood = mood;
      if (!mascotShown) {
        mascotShown = true;
        placeMascotNow();
        mascotWin.show();
        // Follows the pointer to another display, like Mascot.tick → place.
        mascotTimer ??= setInterval(placeMascotNow, 250);
      }
    },
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const allWindows = () => [bubble, badgeWin, hudWin, mascotWin, spot, glowWin, ...markWindows.values(), ...regionWindows.values()]
    .filter((w): w is OverlayWindow => !!w);

  async function hiddenDuring<T>(fn: () => Promise<T>): Promise<T> {
    const shown = allWindows().filter((w) => w.visible);
    shown.forEach((w) => w.hide());
    if (shown.length) await new Promise((r) => setTimeout(r, 90)); // let the X server / compositor repaint
    try { return await fn(); } finally { shown.forEach((w) => w.show()); bubble.raise(); }
  }

  screen.on("display-metrics-changed", () => follow(true));
  void trackPointer();

  return {
    render,
    onAction(cb) { actionCb = cb; },
    showMarks,
    hideMarks,
    selectRegion,
    cancelRegion() { region?.finish(null); },
    spotlight,
    badge,
    controlGlow,
    hud,
    mascot,
    pointerOverBubble,
    hiddenDuring,
    destroy() {
      pointerLoop = false;
      if (followTimer) clearInterval(followTimer);
      if (mascotTimer) clearInterval(mascotTimer);
      region?.finish(null);
      allWindows().forEach((w) => w.destroy());
    },
  };
}

// For the orchestrator's pixel ↔ DIP needs (e.g. converting a region back to a capture rect).
export { displayForPixel, toDipPoint, toDipRect };
