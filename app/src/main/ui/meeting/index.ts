import { BrowserWindow, Menu, ipcMain, nativeImage, screen, shell, type IpcMainEvent } from "electron";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MeetingView } from "../../features/meeting/notes";
import { log } from "../../log";

// The Meeting Notes windows (MeetingPanel.swift, MeetingLauncher.swift): the panel with the conversation as a chat,
// summaries, reply chips, code answers and, afterwards, the summary and a player; and the launcher card in the middle
// of the screen (the shortcut). The panel never takes focus, like the macOS non-activating panel, so a chip's "type"
// goes into the app you were typing in (on Linux it does take focus when clicked; "type" goes back first); the
// launcher does, for ⏎ and Esc.
// Pages: renderer/meeting (channel meeting:view, actions on meeting:action) and renderer/launcher (launcher:model,
// launcher:action, launcher:size).

export interface LauncherModel {
  running: boolean;
  startedAt: number | null;
  shortcut: string;                     // "Shift+Alt+Super+R"
  project: string;
  projectLabel: string;
  options: { summarizeGuest: boolean; summarizeYou: boolean; replies: boolean; codeLookup: boolean; record: boolean; hide: boolean; canHide: boolean };
}

export interface PanelView extends MeetingView {
  projectLabel: string;
  audioUrl: string | null;              // file:// URL of the recording
}

export type MeetingAction =
  | { type: "stop" } | { type: "start" } | { type: "cancel" } | { type: "showNotes" } | { type: "openNotes" }
  | { type: "copy"; text: string } | { type: "type"; text: string }
  | { type: "projectMenu"; from: "panel" | "launcher" }
  | { type: "setOption"; key: keyof LauncherModel["options"]; value: boolean };

export interface MeetingUI {
  showPanel(): void;
  hidePanel(): void;
  readonly panelVisible: boolean;
  update(view: PanelView): void;
  showLauncher(m: LauncherModel): void;
  updateLauncher(m: LauncherModel): void;
  hideLauncher(): void;
  readonly launcherVisible: boolean;
  onAction(cb: (a: MeetingAction) => void): void;
  /** The project menu, under the pointer: recent projects, then Choose Folder…. */
  projectMenu(projects: string[], pick: (path: string) => void, chooseFolder: () => void): void;
  destroy(): void;
}

export const fileUrl = (path: string | null) => (path ? pathToFileURL(path).href : null);

export function createMeetingUI(opts: { preload?: string; rendererDir?: string } = {}): MeetingUI {
  const preload = opts.preload ?? join(__dirname, "preload.js");
  const rendererDir = opts.rendererDir ?? join(__dirname, "renderer");
  const iconPath = join(__dirname, "assets/logo.png");
  let panel: BrowserWindow | null = null;
  let launcher: BrowserWindow | null = null;
  let lastView: PanelView | null = null;
  let lastModel: LauncherModel | null = null;
  let cb: (a: MeetingAction) => void = () => {};
  const alive = (w: BrowserWindow | null) => (w && !w.isDestroyed() ? w : null);

  const listen = (channel: string, fn: (e: IpcMainEvent, data: any) => void) => {
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, fn);
  };
  listen("meeting:action", (_e, a: MeetingAction) => cb(a));
  listen("launcher:action", (_e, a: MeetingAction) => cb(a));
  listen("meeting:ready", (e) => { if (lastView) e.sender.send("meeting:view", lastView); });
  listen("launcher:ready", (e) => { if (lastModel) e.sender.send("launcher:model", lastModel); });
  listen("launcher:size", (_e, s: { width: number; height: number }) => {
    const w = alive(launcher);
    if (!w || !s?.width) return;
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.ceil(s.width), height = Math.ceil(s.height);
    w.setBounds({ x: Math.round(d.x + (d.width - width) / 2), y: Math.round(d.y + (d.height - height) / 2 - d.height * 0.08), width, height });
  });

  function makePanel() {
    const d = screen.getPrimaryDisplay().workArea;
    const w = new BrowserWindow({
      width: 400, height: Math.min(680, d.height - 24), x: d.x + d.width - 412, y: d.y + 12, minWidth: 320, minHeight: 320,
      title: "Meeting Notes", show: false, alwaysOnTop: true, autoHideMenuBar: true, backgroundColor: "#1c1c22",
      // Windows: never takes focus (WS_EX_NOACTIVATE), so clicking a chip leaves the keyboard with the app you were
      // typing in. On X11 a non-focusable window loses its frame (no moving or resizing), so there it's a normal
      // window shown without focus, and "type" brings the app you were in back first.
      focusable: process.platform === "linux", skipTaskbar: false,
      icon: existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    w.setMenuBarVisibility(false);
    w.removeMenu();
    w.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
    w.on("closed", () => { if (panel === w) panel = null; });
    void w.loadFile(join(rendererDir, "meeting", "index.html"));
    return w;
  }

  function makeLauncher() {
    const w = new BrowserWindow({
      width: 400, height: 440, show: false, frame: false, transparent: true, resizable: false, alwaysOnTop: true,
      skipTaskbar: true, center: true, backgroundColor: "#00000000", hasShadow: true, title: "Meeting Notes",
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Like the card on macOS: it goes away when you click elsewhere.
    w.on("blur", () => { if (!w.isDestroyed() && w.isVisible()) w.hide(); });
    w.on("closed", () => { if (launcher === w) launcher = null; });
    void w.loadFile(join(rendererDir, "launcher", "index.html"));
    return w;
  }

  return {
    showPanel() {
      panel = alive(panel) ?? makePanel();
      const w = panel;
      if (w.webContents.isLoading()) w.once("ready-to-show", () => w.showInactive());
      else w.showInactive();
    },
    hidePanel() { alive(panel)?.hide(); },
    get panelVisible() { return !!alive(panel)?.isVisible(); },
    update(view) {
      lastView = view;
      alive(panel)?.webContents.send("meeting:view", view);
    },
    showLauncher(m) {
      lastModel = m;
      launcher = alive(launcher) ?? makeLauncher();
      const w = launcher;
      const show = () => { w.webContents.send("launcher:model", m); w.show(); w.focus(); };
      if (w.webContents.isLoading()) w.once("ready-to-show", show); else show();
    },
    updateLauncher(m) { lastModel = m; alive(launcher)?.webContents.send("launcher:model", m); },
    hideLauncher() { alive(launcher)?.hide(); },
    get launcherVisible() { return !!alive(launcher)?.isVisible(); },
    onAction(fn) { cb = fn; },
    projectMenu(projects, pick, chooseFolder) {
      const menu = Menu.buildFromTemplate([
        ...projects.map((p) => ({ label: basename(p) || p, click: () => pick(p) })),
        ...(projects.length ? [{ type: "separator" as const }] : []),
        { label: "Choose Folder…", click: chooseFolder },
      ]);
      menu.popup({ window: alive(launcher) ?? alive(panel) ?? undefined });
    },
    destroy() {
      for (const w of [panel, launcher]) try { alive(w)?.destroy(); } catch (e) { log(`meeting ui: ${e}`); }
      panel = launcher = null;
    },
  };
}
