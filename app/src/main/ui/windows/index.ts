import { BrowserWindow, clipboard, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HistoryEntry } from "../../contracts";
import { log } from "../../log";
import { SUP } from "../../paths";
import { settings } from "../../settings";
import { projectLabel } from "./menu";
import { TrayMenu } from "./tray";
import type {
  HistoryView, SettingsActionName, SettingsSection, SetupStepId, WindowsBridge, WindowsUI,
} from "./types";

export type * from "./types";

// The tray, Settings, History and Setup windows (App+Menu, SettingsWindow, HistoryWindow, SetupWizard on macOS).
// Each window is a page under renderer/ talking to main over a few IPC channels:
//   settings:get → SettingsSnapshot · settings:action {name, value} → SettingsSnapshot · push settings:snapshot,
//   settings:section · settings:usage / showResource · history:get / clear / remove / copy / open / thumb · push history:changed ·
//   setup:get → {checks, settings, step} · setup:fix / go / finish / copy · push setup:state, setup:step.

export interface WindowsOptions {
  preload?: string;        // default: build/preload.js
  rendererDir?: string;    // default: build/renderer
  /** Skip the tray (tests, or a desktop without StatusNotifier where the orchestrator shows something else). */
  noTray?: boolean;
}

const SECTIONS: SettingsSection[] = ["general", "assistant", "voice", "control", "meetings", "integrations", "usage", "advanced"];
export const SETUP_STEPS: SetupStepId[] = ["welcome", "microphone", "keyboard", "screen", "control", "terminal", "transcription", "voice", "assistant", "addons", "done"];

export function createWindowsUI(bridge: WindowsBridge, opts: WindowsOptions = {}): WindowsUI {
  const preload = opts.preload ?? join(__dirname, "preload.js");
  const rendererDir = opts.rendererDir ?? join(__dirname, "renderer");
  const iconPath = join(__dirname, "assets/logo.png");
  const wins: { settings?: BrowserWindow; history?: BrowserWindow; setup?: BrowserWindow } = {};
  let historyProject = "";
  let historyEntries: HistoryEntry[] = [];
  const thumbs = new Map<string, string>(); // path → data URL, like HistoryThumbnail's NSCache (300)

  function open(name: "settings" | "history" | "setup", o: { width: number; height: number; minWidth?: number; minHeight?: number; maxWidth?: number; resizable?: boolean; title: string; floating?: boolean }, query: Record<string, string> = {}) {
    const existing = wins[name];
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const w = new BrowserWindow({
      width: o.width, height: o.height, minWidth: o.minWidth, minHeight: o.minHeight, maxWidth: o.maxWidth,
      resizable: o.resizable ?? true, title: o.title, show: false, center: true, autoHideMenuBar: true,
      alwaysOnTop: o.floating ?? false, backgroundColor: "#00000000",
      icon: existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    w.setMenuBarVisibility(false);
    w.removeMenu();
    // No app menu, so Ctrl+W / Esc-free closing is handled here (SettingsPanelWindow's ⌘W).
    w.webContents.on("before-input-event", (e, input) => {
      if (input.type === "keyDown" && (input.control || input.meta) && input.key.toLowerCase() === "w") { e.preventDefault(); w.close(); }
    });
    // Links open in the browser, never inside the app.
    w.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
    w.once("ready-to-show", () => w.show());
    w.on("closed", () => { if (wins[name] === w) delete wins[name]; });
    void w.loadFile(join(rendererDir, name, "index.html"), { query });
    wins[name] = w;
    return w;
  }

  const alive = (w?: BrowserWindow) => (w && !w.isDestroyed() ? w : undefined);
  const send = (w: BrowserWindow | undefined, channel: string, data?: unknown) => { const a = alive(w); if (a) a.webContents.send(channel, data); };

  async function snapshot() { return await bridge.settingsSnapshot(); }

  async function pushSettings() {
    if (!alive(wins.settings) && !alive(wins.setup)) return;
    try {
      const s = await snapshot();
      send(wins.settings, "settings:snapshot", s);
      send(wins.setup, "settings:snapshot", s);
    } catch (e) { log(`windows: snapshot failed: ${e}`); }
  }

  // ── Settings ──
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, data: any) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, data) => {
      try { return await fn(e, data); } catch (err) { log(`windows: ${channel} failed: ${err}`); throw err; }
    });
  };

  handle("settings:get", () => snapshot());
  handle("settings:action", async (_e, d: { name: SettingsActionName; value: unknown }) => {
    log(`settings: ${d.name}${d.value === undefined ? "" : " " + JSON.stringify(d.value)}`);
    await bridge.settingsAction(d.name, d.value as never);
    const s = await snapshot();
    // The other window (Settings ↔ Setup) sees the change too.
    send(wins.settings, "settings:snapshot", s);
    send(wins.setup, "settings:snapshot", s);
    refreshMenu();
    return s;
  });
  handle("settings:section", (_e, section: string) => { if (SECTIONS.includes(section as SettingsSection)) settings.set("settingsSection", section); });
  handle("settings:openSetup", () => openSetup());
  handle("settings:usage", () => bridge.resourceUsage?.() ?? null);
  handle("settings:showResource", (_e, path: string) => bridge.showResource?.(String(path)));

  // ── History ──
  const display = (answer: string) => (bridge.history.display ? bridge.history.display(answer) : answer);
  const shotPath = (s: string) => (isAbsolute(s) ? s : join(SUP, "screenshots", s));
  const keyOf = (e: HistoryEntry) => `${e.date}\u0000${e.question}`;

  async function historyView() {
    historyEntries = await bridge.history.list();
    const home = bridge.menuModel().homeProject;
    const entries: HistoryView[] = historyEntries.map((e) => ({
      key: keyOf(e), date: e.date, project: e.project, projectLabel: projectLabel(e.project, home),
      question: e.question, answer: display(e.answer), shots: e.screenshots.map(shotPath),
    }));
    return { entries, project: historyProject };
  }
  handle("history:get", () => historyView());
  handle("history:filter", (_e, project: string) => { historyProject = project ?? ""; });
  handle("history:clear", async (_e, project: string | null) => {
    log(`history: clear ${project ?? "all"}`);
    await bridge.history.clear(project || null);
    return historyView();
  });
  handle("history:remove", async (_e, key: string) => {
    const entry = historyEntries.find((h) => keyOf(h) === key);
    if (entry) await bridge.history.remove(entry);
    return historyView();
  });
  handle("history:copy", (_e, text: string) => clipboard.writeText(String(text ?? "")));
  handle("history:open", (_e, path: string) => shell.openPath(path));
  // Full screenshots are several MB: decode once, small (fills 96×64 at 2×), and cache.
  handle("history:thumb", (_e, path: string) => {
    const hit = thumbs.get(path);
    if (hit !== undefined) return hit || null;
    const img = existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty();
    const url = img.isEmpty() ? "" : img.resize({ width: 192, quality: "good" }).toDataURL();
    if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value!);
    thumbs.set(path, url);
    return url || null;
  });

  // ── Setup ──
  async function setupState() {
    const [checks, s] = await Promise.all([bridge.setupChecks(), snapshot()]);
    const saved = settings.get("setupStep");
    const step = SETUP_STEPS.includes(saved as SetupStepId) ? saved : "welcome";
    return { checks, settings: s, step };
  }
  let setupFinishing = false;
  let lastRequiredDone = false;
  handle("setup:get", () => setupState());
  handle("setup:go", (_e, step: SetupStepId) => { if (SETUP_STEPS.includes(step)) settings.set("setupStep", step); });
  handle("setup:fix", async (_e, step: SetupStepId) => {
    log(`setup: fix ${step}`);
    await bridge.setupFix(step);
    return setupState();
  });
  handle("setup:copy", (_e, text: string) => clipboard.writeText(String(text ?? "")));
  handle("setup:finish", () => {
    settings.set("setupDone", true);
    settings.set("setupStep", null);
    bridge.setupFinished?.();
    setupFinishing = true;
    alive(wins.setup)?.close();
  });
  // The page reports whether every required step is done, for closing mid-setup (SetupModel.requiredGranted).
  handle("setup:required", (_e, done: boolean) => { lastRequiredDone = !!done; });

  // ── Tray ──
  let trayMenu: TrayMenu | null = null;
  if (!opts.noTray) {
    try {
      trayMenu = new TrayMenu(() => bridge.menuModel(), (id, arg) => {
        if (id === "history") return openHistory(bridge.menuModel().currentProject);
        if (id === "settings") return openSettings();
        bridge.onMenu(id, arg);
      });
    } catch (e) {
      // No StatusNotifier host is not fatal: the orchestrator can still open everything from the bubble/hotkeys.
      log(`tray: can't create: ${e}`);
    }
  }

  function refreshMenu() { trayMenu?.refresh(); }

  function openSettings(section?: SettingsSection) {
    if (section) settings.set("settingsSection", section);
    const chosen = section ?? (SECTIONS.includes(settings.get("settingsSection") as SettingsSection) ? settings.get("settingsSection")! : "general");
    const existed = !!alive(wins.settings);
    open("settings", { width: 760, height: 560, minWidth: 760, maxWidth: 760, minHeight: 540, title: "VisionCLI Settings" }, { section: chosen });
    if (existed) { send(wins.settings, "settings:section", chosen); void pushSettings(); }
  }

  /** `project`: show that project's history (all projects when it has none yet). */
  function openHistory(project?: string) {
    void (async () => {
      if (project !== undefined) {
        const list = await bridge.history.list();
        historyProject = list.some((e) => e.project === project) ? project : "";
      }
      const existed = !!alive(wins.history);
      open("history", { width: 680, height: 560, minWidth: 560, minHeight: 420, title: "VisionCLI History" });
      if (existed) send(wins.history, "history:changed");
    })();
  }

  function openSetup(step?: SetupStepId) {
    if (step && SETUP_STEPS.includes(step)) settings.set("setupStep", step);
    const existed = !!alive(wins.setup);
    const w = open("setup", { width: 720, height: 480, resizable: false, title: "Set up VisionCLI", floating: true });
    if (existed) { if (step) send(w, "setup:step", step); return; }
    setupFinishing = false;
    w.on("close", () => {
      // Closed by the user mid-setup: don't reopen next launch, and count it done if everything required is.
      if (setupFinishing) return;
      settings.set("setupStep", null);
      if (lastRequiredDone) { settings.set("setupDone", true); bridge.setupFinished?.(); }
    });
  }

  return {
    get tray() { return trayMenu?.tray ?? null; },
    openSettings,
    openHistory,
    openSetup,
    refreshMenu,
    refreshWindows() {
      void pushSettings();
      send(wins.history, "history:changed");
      send(wins.setup, "setup:refresh");
    },
    destroy() {
      trayMenu?.destroy();
      trayMenu = null;
      for (const w of Object.values(wins)) alive(w)?.destroy();
    },
  };
}
