// One overlay window: transparent, frameless, on top of everything (including full-screen apps where the window
// manager allows it), on every workspace, out of the taskbar and alt-tab, never taking focus unless asked to
// (the NSPanel .nonactivatingPanel + .canJoinAllSpaces + .fullScreenAuxiliary setup of the macOS overlays).

import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { join } from "node:path";
import type { Rect } from "../../contracts";
import { log } from "../../log";

export interface OverlayWindowOptions {
  page: "bubble" | "mascot" | "marks" | "region" | "badge" | "hud";
  query?: Record<string, string>;
  /** Region selection needs the keyboard (esc); everything else never takes focus. */
  focusable?: boolean;
  /** Clicks go to the windows underneath. */
  clickThrough?: boolean;
  bounds?: Rect;
}

// On X11 (and XWayland) Electron maps a non-focusable window as override-redirect: the window manager doesn't manage
// it at all, so it has no frame, no taskbar or alt-tab entry, shows on every workspace and stays above managed
// windows; compositors (Mutter, KWin, Sway, Hyprland) draw such windows on top. That is exactly an NSPanel overlay, so
// every overlay window is non-focusable except the region selector (it wants esc). VCLI_OVERLAY_WINDOW_TYPE can
// still set a _NET_WM_WINDOW_TYPE for that one (e.g. "dock" on WMs that keep docks above full-screen windows).
const windowType = process.env.VCLI_OVERLAY_WINDOW_TYPE;

// ipcMain is shared with the other UI windows: one listener per channel, dispatched by the sending webContents.
const handlers = new Map<string, Map<number, (data: any) => void>>();
function listen(channel: string, id: number, cb: (data: any) => void) {
  let byWindow = handlers.get(channel);
  if (!byWindow) {
    byWindow = new Map();
    handlers.set(channel, byWindow);
    const map = byWindow;
    ipcMain.on(channel, (e: IpcMainEvent, data: unknown) => map.get(e.sender.id)?.(data));
  }
  byWindow.set(id, cb);
}

export class OverlayWindow {
  private w: BrowserWindow | null = null;
  private loaded = false;
  /** The last message per channel, replayed whenever the page (re)loads. */
  private last = new Map<string, unknown>();
  private wcId = -1;
  private clickThrough: boolean;
  private lastBounds = "";
  private rect: Rect;
  private listeners: [string, (data: any) => void][] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  /** `lazy`: the window (and its renderer process, ~90 MB) exists only while needed: created on first show,
   *  destroyed after `idleMs` hidden. For overlays that are rarely on screen (badge, task panel). */
  constructor(readonly opts: OverlayWindowOptions & { lazy?: { idleMs: number } }) {
    this.rect = opts.bounds ?? { x: 0, y: 0, width: 10, height: 10 };
    this.clickThrough = opts.clickThrough ?? true;
    if (!opts.lazy) this.create();
  }

  /** The BrowserWindow, created if it isn't there (lazy windows). */
  get win(): BrowserWindow { return this.create(); }

  private create(): BrowserWindow {
    if (this.w && !this.w.isDestroyed()) return this.w;
    const opts = this.opts;
    const b = this.rect;
    const win = new BrowserWindow({
      ...b, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: !!opts.focusable, alwaysOnTop: true, enableLargerThanScreen: true,
      ...(opts.focusable && windowType ? { type: windowType } : {}),
      webPreferences: {
        preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false, spellcheck: false,
      },
    });
    this.w = win;
    this.loaded = false;
    this.lastBounds = `${b.x},${b.y},${b.width},${b.height}`;
    this.wcId = win.webContents.id;
    for (const [c, cb] of this.listeners) listen(c, this.wcId, cb);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(this.clickThrough, { forward: true });
    // An answer's links never navigate the overlay itself; the page reports them as actions.
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("did-finish-load", () => {
      this.loaded = true;
      for (const [c, d] of this.last) win.webContents.send(c, d);
    });
    // A crashed page comes back with its last state rather than leaving a dead window on screen.
    win.webContents.on("render-process-gone", (_e, details) => {
      log(`overlay: ${opts.page} renderer gone (${details.reason}, exit ${details.exitCode}); reloading`);
      this.loaded = false;
      if (details.reason !== "clean-exit" && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 300);
    });
    void win.loadFile(join(__dirname, "renderer", opts.page, "index.html"), { query: opts.query });
    return win;
  }

  private get created() { return !!this.w && !this.w.isDestroyed(); }
  get alive() { return !this.closed && (this.created || !!this.opts.lazy); }
  get visible() { return this.created && this.w!.isVisible(); }
  get bounds(): Rect { return this.created ? this.w!.getBounds() : this.rect; }

  send(channel: string, data?: unknown) {
    if (!this.alive) return;
    this.last.delete(channel); // keep replay order = send order
    this.last.set(channel, data);
    if (this.created && this.loaded) this.w!.webContents.send(channel, data);
  }

  on(channel: string, cb: (data: any) => void) {
    this.listeners.push([channel, cb]);
    if (this.created) listen(channel, this.wcId, cb);
  }

  setBounds(r: Rect) {
    this.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
    const key = `${this.rect.x},${this.rect.y},${this.rect.width},${this.rect.height}`;
    if (!this.created || key === this.lastBounds) return;
    this.lastBounds = key;
    this.w!.setBounds(this.rect);
  }

  setClickThrough(on: boolean) {
    if (on === this.clickThrough) return;
    this.clickThrough = on;
    if (this.created) this.w!.setIgnoreMouseEvents(on, { forward: true });
  }

  show() {
    if (!this.alive) return;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const win = this.create();
    if (!win.isVisible()) {
      if (this.opts.focusable) win.show(); else win.showInactive();
      // Some window managers drop the above-state of unmapped windows; assert it again on every map.
      win.setAlwaysOnTop(true, "screen-saver");
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
  }

  raise() { if (this.visible) this.w!.moveTop(); }

  hide() {
    if (this.visible) this.w!.hide();
    const lazy = this.opts.lazy;
    if (lazy && this.created && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.visible || !this.created) return;
        for (const m of handlers.values()) m.delete(this.wcId);
        this.w!.destroy();
        this.w = null;
        this.loaded = false;
      }, lazy.idleMs);
      this.idleTimer.unref?.();
    }
  }

  destroy() {
    this.closed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    for (const m of handlers.values()) m.delete(this.wcId);
    if (this.created) this.w!.destroy();
  }
}
