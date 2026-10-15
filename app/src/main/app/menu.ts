import { clipboard, dialog, shell } from "electron";
import { Markup } from "../core/markup";
import { HomeProject } from "../features/home";
import { isTerminal } from "../features/projects";
import { UsageTracker } from "../features/usage";
import { log } from "../log";
import { settings } from "../settings";
import { runningProjects } from "../terminal/probe";
import type { MenuId, MenuModel, UsageWindow } from "../ui/windows";
import { App } from "./core";

// The tray menu (App+Menu.swift, App+MenuActions.swift, App+Projects.swift): its model, and what its items do.

declare module "./core" {
  interface App {
    menuModel(): MenuModel;
    onMenu(id: MenuId, arg?: string | null): void;
    refreshCandidates(): Promise<void>;
    pickProject(path: string): void;
    chooseProjectFolder(): Promise<void>;
    copyLastAnswer(): void;
    installUpdate(): Promise<void>;
    checkForUpdates(): Promise<void>;
    setupScreen(): Promise<void>;
    quit(): void;
    screenProblem: string | null;
  }
}

App.prototype.screenProblem = null;

const usageWindow = (u: UsageTracker, w: { utilization: number; resetsAt: number } | null): UsageWindow | null =>
  w ? { percent: u.percent(w) ?? 0, resetsAt: new Date(w.resetsAt).toISOString() } : null;

App.prototype.menuModel = function (this: App): MenuModel {
  const u = this.usage;
  const gemini = settings.get("assistant") !== "claude";
  // Gemini: Antigravity's own limits, re-read when the menu is rebuilt and they're older than 10 minutes.
  if (gemini && this.cfg.agy && this.agyUsage.isStale()) void this.agyUsage.refresh(this.cfg.agy, { ...process.env, PATH: this.cfg.path });
  const active = gemini ? this.agyUsage.active(settings.get("agyModel")) : null;
  const groups = gemini ? [active, ...this.agyUsage.groups.filter((g) => g !== active)].filter((g): g is NonNullable<typeof g> => !!g) : [];
  const recent = [this.currentProject];
  const seen = new Set<string>();
  for (const e of this.history.entries.slice(0, 50)) seen.add(e.project);
  recent.push(...[...seen].sort());
  return {
    currentProject: this.currentProject,
    pinnedProject: settings.get("pinnedProject"),
    homeProject: HomeProject.path,
    running: this.candidates.running,
    windows: this.candidates.windows,
    recent,
    usage: {
      session: usageWindow(u, gemini ? active?.session ?? null : u.session), week: usageWindow(u, gemini ? active?.week ?? null : u.week),
      today: u.today,
      updated: (gemini ? this.agyUsage.updated : u.updated) ? new Date((gemini ? this.agyUsage.updated : u.updated)!).toISOString() : null,
      inMenuBar: settings.get("usageInMenuBar"), weeklyInMenuBar: settings.get("weeklyInMenuBar"),
      name: gemini ? "Gemini" : "Claude",
      groups: groups.map((g) => ({ name: g.name, session: usageWindow(u, g.session), week: usageWindow(u, g.week) })),
    },
    updateStatus: this.updater?.status ?? null,
    updateAvailable: this.updater?.available?.version ?? null,
    screenProblem: this.screenProblem,
    terminalMode: settings.get("terminalMode"),
    assistantName: settings.get("assistant") === "claude" ? "Claude" : "Gemini",
    canContinueInTerminal: !!this.sessions?.current?.sessionId(),
  };
};

App.prototype.onMenu = function (this: App, id: MenuId, arg?: string | null) {
  log(`menu: ${id}${arg ? " " + arg : ""}`);
  switch (id) {
    case "pickProject": if (arg) this.pickProject(arg); break;
    case "chooseFolder": void this.chooseProjectFolder(); break;
    case "refreshUsage":
      if (settings.get("assistant") !== "claude") { if (this.cfg.agy) void this.agyUsage.refresh(this.cfg.agy, { ...process.env, PATH: this.cfg.path }); }
      else void this.usage.refresh(this.cfg.claude, { ...process.env, PATH: this.cfg.path });
      break;
    case "toggleUsageInMenuBar": settings.set("usageInMenuBar", !settings.get("usageInMenuBar")); break;
    case "toggleWeeklyInMenuBar": settings.set("weeklyInMenuBar", !settings.get("weeklyInMenuBar")); break;
    case "installUpdate": void this.installUpdate(); break;
    case "setupScreen": void this.setupScreen(); break;
    case "newConversation": this.newConversation(); break;
    case "copyLastAnswer": this.copyLastAnswer(); break;
    case "showTerminal": this.showAssistantTerminal(); break;
    case "showActivity": this.showActivityMenu(); break;
    case "continueInTerminal": this.continueInTerminal(); break;
    case "quit": this.quit(); break;
  }
  this.windows.refreshMenu();
};

/** The Project menu's candidates: running CLIs (/proc) and the projects of open editor windows. */
App.prototype.refreshCandidates = async function (this: App) {
  const running = runningProjects().map((r) => ({ project: r.project, assistant: r.assistant }));
  const windows = (await this.desktop.windows().catch(() => [])).filter((w) => !isTerminal(w));
  const open: string[] = [];
  for (const w of windows) {
    const p = this.projects.project(w);
    if (p && !open.includes(p)) open.push(p);
  }
  this.candidates = { running, windows: open };
  this.screenProblem = await this.desktop.problem().then((p) => (p ? "Set Up Screen Capture…" : null), () => null);
};

/** The project is picked by hand (there's no "follow the window" mode any more). */
App.prototype.pickProject = function (this: App, path: string) {
  settings.set("pinnedProject", path);
  this.currentProject = path;
  log(`project: ${path}`);
};

App.prototype.chooseProjectFolder = async function (this: App) {
  const r = await dialog.showOpenDialog({ title: "Choose a project", buttonLabel: "Use This Project", defaultPath: this.currentProject, properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  this.pickProject(r.filePaths[0]);
  this.windows.refreshMenu();
};

App.prototype.copyLastAnswer = function (this: App) {
  const last = this.history.entries[0];
  clipboard.writeText(last ? Markup.display(last.answer) : this.answer);
};

App.prototype.installUpdate = async function (this: App) {
  const release = this.updater.available;
  if (!release) return;
  const r = await dialog.showMessageBox({
    type: "question", message: `Install VisionCLI ${release.version}?`, detail: this.updater.installPrompt(release),
    buttons: [this.updater.kind === "appimage" ? "Install" : "Open Release Page", "Cancel"], defaultId: 0, cancelId: 1,
  });
  if (r.response === 0) await this.updater.install();
};

App.prototype.checkForUpdates = async function (this: App) {
  const release = await this.updater.check(true);
  if (release) {
    const r = await dialog.showMessageBox({
      type: "info", message: `VisionCLI ${release.version} is available`,
      detail: `You have ${this.version}. ${this.updater.installPrompt(release)}`,
      buttons: ["Install Update", "Release Notes", "Later"], defaultId: 0, cancelId: 2,
    });
    if (r.response === 0) await this.updater.install();
    else if (r.response === 1) void shell.openExternal(release.page);
  } else {
    await dialog.showMessageBox({ type: "info", message: "VisionCLI is up to date", detail: `You have the latest version (${this.version}).`, buttons: ["OK"] });
  }
};

/** The screen capture problem item: the setup step that fixes it. */
App.prototype.setupScreen = async function (this: App) {
  this.windows.openSetup("screen");
};
