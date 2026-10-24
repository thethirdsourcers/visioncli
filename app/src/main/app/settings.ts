import { dialog, shell } from "electron";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgyModels } from "../assistant";
import { MenuLabels } from "../core/labels";
import { pastMeetings } from "../features/meeting/recording";
import { canHideFromCapture } from "../ui/windows/protection";
import { projectChoices } from "../ui/windows/menu";
import { HomeProject } from "../features/home";
import { openIntegrations } from "../features/integrations";
import { LOG_FILE, log } from "../log";
import { SUP } from "../paths";
import { settings } from "../settings";
import { VoiceModels } from "../stt";
import { parakeetFiles, sherpaServer } from "../stt/models";
import { KokoroEngine } from "../tts";
import type { Item, SettingsActionName, SettingsActions, SettingsSnapshot } from "../ui/windows";
import { App } from "./core";

// The Settings window (App+Settings.swift): what it shows, and the app actions behind its controls, the same ones
// the menu and the setup wizard use. The snapshot is polled every 1.5 s, so it only reads settings and caches.

export const GHOST_OFF = join(SUP, "ghost-off");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

declare module "./core" {
  interface App {
    settingsSnapshot(): SettingsSnapshot;
    settingsAction<K extends SettingsActionName>(name: K, value: SettingsActions[K]): Promise<void>;
    desktopLabel(): string;
    setStartAtLogin(on: boolean): Promise<void>;
    openWithDefault(path: string): void;
  }
}

App.prototype.desktopLabel = function (this: App) {
  const wm = process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || "";
  if (process.platform === "win32") return "Windows";
  switch (this.desktop.backend) {
    case "x11": return `X11${wm ? " · " + wm : ""}`;
    case "gnome": return "GNOME (Wayland)";
    case "kde": return "KDE Plasma (Wayland)";
    case "sway": return "Sway (Wayland)";
    case "hyprland": return "Hyprland (Wayland)";
    default: return `Wayland${wm ? " · " + wm : ""}`;
  }
};

App.prototype.settingsSnapshot = function (this: App): SettingsSnapshot {
  void this.refreshProbe();
  const p = this.probe;
  // The Kokoro voices are offered only when Kokoro can run (model, voices, uv and its script); with the files but no
  // uv, picking one saved it while the system voice kept answering.
  const kokoroAvailable = KokoroEngine.available();
  const whisperModels = VoiceModels.whisperModels().map((m) => m[0]);
  const defIn = p.inputs.find((d) => d.isDefault), defOut = p.outputs.find((d) => d.isDefault);
  const engine = this.currentSpeechEngine;
  let crashLog = false;
  try { crashLog = statSync(this.crashLogFile).size > 0; } catch {}
  return {
    // General
    startAtLogin: p.startAtLogin,
    autoUpdate: settings.get("autoUpdate"),
    screenshotEvery: settings.get("screenshotEveryQuestion"),
    errorWatcher: settings.get("errorWatcher"),
    hideFromCapture: settings.get("hideFromCapture"),
    canHideFromCapture: canHideFromCapture(),
    project: this.currentProject,
    projectChoices: (() => {
      const m = this.menuModel();
      const list = [{ id: HomeProject.path, name: "Home: general questions, no project" },
        ...projectChoices(m).map((c) => {
          const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
          const short = home && c.path.startsWith(home) ? "~" + c.path.slice(home.length) : c.path;
          return { id: c.path, name: `${c.label.split("   ")[0]} (${short})` };
        })];
      // A folder picked with Choose Folder… that isn't in the list still shows as chosen.
      if (!list.some((c) => c.id === this.currentProject)) list.push({ id: this.currentProject, name: this.currentProject });
      return list;
    })(),
    version: this.version,
    updateAvailable: this.updater.available?.version ?? null,
    updateStatus: this.updater.status,
    // Assistant
    assistant: settings.get("assistant"),
    installed: { claude: this.isInstalled("claude"), antigravity: this.isInstalled("antigravity"), gemini: this.isInstalled("gemini") },
    terminalMode: settings.get("terminalMode"),
    autoActivity: settings.get("autoActivity"),
    claudeModel: settings.get("model"),
    fixedModel: this.cfg.model,
    claudeModels: MenuLabels.claudeModels.map(([id, name]) => ({ id, name })),
    agyModel: settings.get("agyModel"),
    agyModels: AgyModels.cached(),
    effort: settings.get("effort"),
    efforts: EFFORTS.map((id) => ({ id, name: MenuLabels.effort(id) })),
    smartRouting: settings.get("smartRouting"),
    // Voice (without the Kokoro model only the system voice can be on)
    speak: settings.get("speak"),
    speed: settings.get("speechSpeed"),
    voice: kokoroAvailable && settings.get("tts") === "kokoro" ? settings.get("kokoroVoice") : null,
    kokoroVoices: kokoroAvailable ? VoiceModels.kokoroVoiceList.map(([id, name]) => ({ id, name })) : [],
    kokoroInstalled: kokoroAvailable,
    kokoroProblem: kokoroAvailable ? this.speaker.kokoro.lastError : null,
    installStatus: this.installer.status ?? this.setupBusy.transcription ?? null,
    speechEngine: engine,
    // Offered on every 64-bit machine: choosing it downloads sherpa-onnx and the model (like macOS, where it ships).
    hasParakeet: !!sherpaServer() || process.arch === "x64" || process.arch === "arm64",
    parakeetReady: engine === "parakeet",
    parakeetDownloaded: !!parakeetFiles(),
    parakeetProgress: this.parakeetProgress,
    whisperModels,
    whisperDownloadable: !whisperModels.length || !VoiceModels.binary("whisper-server"),
    systemSpeech: p.speech.system,
    inputs: p.inputs.map((d) => ({ id: d.id, name: d.name })),
    outputs: p.outputs.map((d) => ({ id: d.id, name: d.name })),
    inputDevice: settings.get("inputDevice"),
    outputDevice: settings.get("outputDevice"),
    defaultInput: defIn?.name ?? "none",
    defaultOutput: defOut?.name ?? "none",
    // Computer Control
    computerControl: settings.get("computerControl"),
    keyboardAccess: !this.hotkeyInfo.problem && this.hotkeyInfo.backend !== "none",
    keyboardBackend: this.hotkeyInfo.backend === "none" ? null : this.hotkeyInfo.backend,
    platform: process.platform,
    keyboardProblem: this.hotkeyInfo.problem ?? null,
    atspi: p.atspi,
    inputBackend: this.inputBackend && this.inputBackend !== "none" ? this.inputBackend : null,
    watchCrashes: settings.get("watchCrashes"),
    ghostCursor: !existsSync(GHOST_OFF),
    quickCommands: settings.get("quickCommands"),
    // Meeting Notes
    meetingNotes: !!this.meeting?.isOn,
    meetingSummarizeGuest: settings.get("meetingSummarizeGuest"),
    meetingSummarizeYou: settings.get("meetingSummarizeYou"),
    meetingReplies: settings.get("meetingReplies"),
    meetingCodeLookup: settings.get("meetingCodeLookup"),
    meetingRecord: settings.get("meetingRecord"),
    meetingShortcut: this.meetingShortcut,
    pastMeetings: pastMeetings(10).map((p) => {
      const first = p.record.rows.find((r) => r.speaker === "Guest") ?? p.record.rows[0];
      const d = new Date(p.record.started);
      const when = `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return { id: p.folder, name: `${when} · ${(first?.summary ?? first?.text ?? "No conversation").slice(0, 50)}` };
    }),
    // Integrations
    tools: p.tools,
    addOns: (this.addOns.refresh(5000), this.addOns.all.map((a) => ({
      id: a.id, title: a.title, detail: a.detail, installed: this.addOns.installed.has(a.id), installing: this.addOns.installing.has(a.id), error: this.addOns.errors[a.id] ?? null,
    }))),
    // Advanced
    desktop: this.desktopLabel(),
    desktopProblem: p.desktopProblem,
    crashLogExists: crashLog,
    homeProject: HomeProject.path,
    backup: this.backupSnapshot(),
  };
};

App.prototype.settingsAction = async function (this: App, name, value) {
  const v = value as never;
  switch (name) {
    // General
    case "setStartAtLogin": await this.setStartAtLogin(v); break;
    case "setScreenshotEvery": settings.set("screenshotEveryQuestion", v); break;
    case "setErrorWatcher": settings.set("errorWatcher", v); break;
    case "pickProject": if (v) this.pickProject(v); break;
    case "chooseProjectFolder": await this.chooseProjectFolder(); break;
    case "setHideFromCapture": settings.set("hideFromCapture", v); this.windows.refreshMenu(); break;
    case "setAutoUpdate": settings.set("autoUpdate", v); break;
    case "checkForUpdates": await this.checkForUpdates(); break;
    case "installUpdate": await this.installUpdate(); break;
    // Assistant
    case "setAssistant": this.setAssistant(v); break;
    case "setTerminalMode": settings.set("terminalMode", v); break;
    case "setAutoActivity": settings.set("autoActivity", v); break;
    case "setClaudeModel": this.setClaudeModel(v); break;
    case "setAgyModel": this.setAgyModel(v); break;
    case "setEffort": this.setEffort(v); break;
    case "refreshAgyModels": void AgyModels.refresh(this.sessions.cfg).then(() => this.windows.refreshWindows()); break;
    case "setSmartRouting": settings.set("smartRouting", v); break;
    // Voice
    case "setSpeak": this.setSpeak(v); break;
    case "setSpeed": this.setSpeechSpeed(v); break;
    case "selectVoice": this.selectVoice(v); break;
    case "installKokoro": void this.installer.installKokoro(); break;
    case "installWhisper": void this.installer.installWhisper(); break;
    case "chooseSpeech": await this.chooseSpeech(v); break;
    case "editVocabulary": this.editVocabulary(); break;
    case "setAudioDevice": { const d = value as SettingsActions["setAudioDevice"]; this.setAudioDevice(d.input, d.id); break; }
    case "testSpeaker": this.testSpeaker(); break;
    // Computer Control
    case "setComputerControl": this.setComputerControl(v); break;
    case "grantKeyboardAccess": await this.grantKeyboardAccess(); break;
    case "enableAtspi": await this.enableAtspi(); break;
    case "setupInput": await this.setupInput(); break;
    case "setWatchCrashes": this.setWatchCrashes(v); break;
    case "setGhostCursor":
      if (v) rmSync(GHOST_OFF, { force: true }); else writeFileSync(GHOST_OFF, "");
      break;
    case "setQuickCommands": settings.set("quickCommands", v); break;
    // Meeting Notes
    case "toggleMeeting": await this.toggleMeeting(); break;
    case "showMeetingPanel": this.showMeetingPanel(); break;
    case "openMeeting": this.openPastMeeting(value as string); break;
    case "openMeetings": this.openMeetingsFolder(); break;
    case "setMeetingOption": { const o = value as SettingsActions["setMeetingOption"]; settings.set(o.key, !!o.on); break; }
    // Integrations
    case "checkTools": await this.checkTools(); break;
    case "connectTools": await this.connectToolsFor(v); break;
    case "openIntegrations": await openIntegrations((f) => this.openWithDefault(f)); break;
    case "installAddOns": if (this.isInstalled("claude")) for (const id of value as string[]) this.addOns.install(id, this.cfg.claude, this.cfg.path); break;
    // Advanced
    case "fixPermissions": await this.fixPermissions(); break;
    case "openLog": this.openWithDefault(LOG_FILE); break;
    case "openCrashLog": this.openWithDefault(this.crashLogFile); break;
    case "openHome": HomeProject.ensure(); this.openWithDefault(HomeProject.path); break;
    default: if (name.startsWith("backup")) await this.backupAction(name, value);
  }
  await this.refreshProbe(true);
};

App.prototype.openWithDefault = function (this: App, path: string) {
  void shell.openPath(path).then((err) => { if (err) log(`open ${path}: ${err}`); });
};

App.prototype.setStartAtLogin = async function (this: App, on: boolean) {
  try {
    await this.autostart.set(on);
  } catch (e) {
    log(`login item: ${e}`);
    await dialog.showMessageBox({ type: "warning", message: "Couldn't change Start at Login", detail: String((e as Error)?.message ?? e), buttons: ["OK"] });
  }
};

