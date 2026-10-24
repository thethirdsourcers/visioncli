import { BrowserWindow, app as electron, dialog, globalShortcut, screen, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgySetup, createSessions } from "./assistant";
import { createAudioDevices, createMicStream, createRecorder, createSystemAudio, meetingMic } from "./audio";
import type { DesktopWindow } from "./contracts";
import { Markup } from "./core/markup";
import { createAccessibility } from "./desktop/atspi";
import { createApps } from "./desktop/apps";
import { createInjector } from "./desktop/input";
import { createDesktop } from "./desktop/windows";
import { MeetingNotes } from "./features/meeting/notes";
import { recoverRecordings } from "./features/meeting/recording";
import { AddOns } from "./features/addons";
import { Autostart, launchCommand } from "./features/autostart";
import type { CrashReporter } from "./features/crashreporter";
import { CrashWatcher } from "./features/crashwatch";
import { HistoryStore } from "./features/history";
import { ModelInstaller } from "./features/installer";
import { ProjectResolver } from "./features/projects";
import { Updater } from "./features/updater";
import { AgyUsage, UsageTracker } from "./features/usage";
import { createHotkeys } from "./input";
import { log } from "./log";
import { settings } from "./settings";
import { createSpeechEngines } from "./stt";
import { setKeyboardDelivery } from "./terminal/mux";
import { createSpeaker } from "./tts";
import { createMeetingUI } from "./ui/meeting";
import { createOverlayUI } from "./ui/overlay";
import { createWindowsUI } from "./ui/windows";
import { installContentProtection } from "./ui/windows/protection";
import { loadConfig } from "./app/config";
import { App } from "./app/core";
import { createKeyboardDelivery } from "./app/keyboard";
import { winHelper } from "./desktop/windows/win32";
import { createWinKeyboardDelivery, useWinHelper } from "./terminal/win";
import { OverlayKeys } from "./app/keys";
import { cleanTranscript, parseOpenLink } from "./app/text";
// The feature files add their methods to App (like the App+*.swift extensions).
import "./app/panel";
import "./app/listening";
import "./app/questions";
import "./app/sessions";
import "./app/bubble";
import "./app/browserTask";
import "./app/announce";
import "./app/menu";
import "./app/settings";
import "./app/meeting";
import "./app/setup";
import "./app/voice";
import "./app/control";
import "./app/errors";
import "./app/backup";
import "./app/resources";
import "./app/shortcuts";
import "./app/debug";

export { App } from "./app/core";

// The running app (main.swift AppDelegate.applicationDidFinishLaunching + quit): builds every module and wires
// them to App. index.ts handles the process (single instance, crash guard, signals) and calls launch().

/** Windows: the packaged MCP wrapper copied to a stable per-user path (%LOCALAPPDATA%\visioncli\bin), which
 *  `claude mcp add` points at; it survives updates, unlike the install folder's own files. */
function setupUserWin(): Promise<void> {
  const src = join(process.resourcesPath, "win", "visioncli-mcp.cmd");
  if (!electron.isPackaged || !existsSync(src)) return Promise.resolve();
  try {
    const dir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "visioncli", "bin");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "visioncli-mcp.cmd");
    const body = readFileSync(src);
    if (!existsSync(dest) || !readFileSync(dest).equals(body)) { writeFileSync(dest, body); log(`setup-user: ${dest}`); }
  } catch (e) { log(`setup-user: ${(e as Error).message}`); }
  return Promise.resolve();
}

/** The packaged app's per-user setup (symlinks, visioncli-mcp, the systemd unit, one-time MCP registration). */
function runSetupUser(): Promise<void> {
  if (process.platform === "win32") return setupUserWin();
  const script = join(process.resourcesPath, "bin", "setup-user.sh");
  if (!electron.isPackaged || !existsSync(script)) return Promise.resolve();
  return new Promise((resolve) => {
    execFile("sh", [script], { env: process.env, timeout: 60_000 }, (err, out, errOut) => {
      log(`setup-user: ${String(out).trim().replace(/\n/g, " ")}${err ? ` (failed: ${String(errOut || err).trim()})` : ""}`);
      resolve();
    });
  });
}

/** Displays in global pixels, for desktops where the compositor can't say (generic Wayland). */
const pixelDisplays = () => screen.getAllDisplays().map((d) => {
  const o = d.nativeOrigin ?? { x: d.bounds.x, y: d.bounds.y };
  return { x: o.x, y: o.y, width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
});

export async function launch(o: { argv: string[]; crash: CrashReporter; recovered: string | null }): Promise<App> {
  await runSetupUser();
  const cfg = loadConfig({ argv: o.argv, packaged: electron.isPackaged, resourcesPath: process.resourcesPath, buildDir: __dirname, execPath: process.execPath });
  const a = new App(cfg);
  a.version = electron.getVersion();
  a.crashLogFile = o.crash.logFile;
  a.state.assistantName = settings.get("assistant") === "claude" ? "Claude" : "Gemini";

  // ── Screen, input, accessibility, apps ──
  a.desktop = await createDesktop({ screen: pixelDisplays });
  const desktop = a.desktop;
  a.makeInjector = async () => { const i = await createInjector(); a.inputBackend = i.backend; return i; };
  const windowByName = async (name: string): Promise<DesktopWindow | null> => {
    const q = name.toLowerCase();
    const wins = await desktop.windows().catch(() => [] as DesktopWindow[]);
    return wins.find((w) => w.app.toLowerCase() === q || w.appId.toLowerCase() === q)
      ?? wins.find((w) => w.app.toLowerCase().includes(q) || w.appId.toLowerCase().includes(q)) ?? null;
  };
  a.apps = createApps(async (name) => {
    const w = await windowByName(name);
    if (!w) return false;
    await desktop.focus(w);
    return true;
  });
  a.ax = await createAccessibility({
    locateWindow: async (app, title, pid) => {
      const wins = await desktop.windows().catch(() => [] as DesktopWindow[]);
      return (wins.find((w) => pid != null && w.pid === pid && (!title || w.title === title))
        ?? wins.find((w) => pid != null && w.pid === pid)
        ?? wins.find((w) => w.title === title && w.app.toLowerCase() === app.toLowerCase()))?.bounds ?? null;
    },
    activeWindow: () => desktop.activeWindow().catch(() => null),
  });

  // ── The overlay and its keys ──
  // Hide from screen sharing (Settings → Meeting Notes): every window, from its creation on.
  installContentProtection({
    onWindowCreated: (cb) => electron.on("browser-window-created", (_e, w) => cb(w)),
    allWindows: () => BrowserWindow.getAllWindows(),
    isOn: () => settings.get("hideFromCapture"),
    onChange: (cb) => settings.on("change", (k: string) => { if (k === "hideFromCapture") cb(); }),
  });
  a.ui = createOverlayUI({
    pointer: () => desktop.pointer(),
    motion: () => (a.hotkeys?.seesMotion ? a.hotkeys.lastMotion ?? 0 : null),
  });
  a.ui.onAction((act) => a.bubbleAction(act));
  a.keys = new OverlayKeys(globalShortcut, (k) => a.overlayKey(k));

  // ── Data and features ──
  a.history = new HistoryStore();
  a.usage = new UsageTracker();
  a.agyUsage = new AgyUsage();
  a.projects = new ProjectResolver();
  a.projects.refreshIfStale();
  a.crashWatcher = new CrashWatcher();
  a.autostart = new Autostart({ exec: launchCommand(electron.getAppPath()) });
  a.announcer = a.makeAnnouncer();
  a.addOns = new AddOns();

  // ── Assistant sessions; typing into any terminal by keyboard ──
  a.sessions = createSessions({
    node: cfg.node ?? "", server: cfg.server ?? "", path: cfg.path, claude: cfg.claude, agy: cfg.agy, gemini: cfg.gemini, model: cfg.model,
  });
  a.sessions.on("notice", (text: string) => { log(`notice: ${text}`); a.state.toast = text; });
  if (process.platform === "win32") {
    // Windows: the CLIs' working folders come from the helper (no /proc), and typing goes through SendInput.
    useWinHelper(winHelper());
    setKeyboardDelivery(createWinKeyboardDelivery(desktop, () => a.input()));
  } else {
    setKeyboardDelivery(createKeyboardDelivery(desktop, () => a.input()));
  }

  // ── Voice ──
  a.audio = createAudioDevices();
  a.recorder = createRecorder();
  a.engines = createSpeechEngines();
  a.speaker = createSpeaker(a.audio);
  a.speaker.on("speaking", (on: boolean) => { a.state.speaking = on; if (on) a.voiceUsedAt = Date.now(); });

  // ── Windows: tray, Settings, History, Setup ──
  a.windows = createWindowsUI({
    menuModel: () => a.menuModel(),
    onMenu: (id, arg) => a.onMenu(id, arg),
    settingsSnapshot: () => a.settingsSnapshot(),
    settingsAction: (name, value) => a.settingsAction(name, value),
    history: {
      list: () => a.history.entries,
      clear: (project) => a.history.clear(project ?? undefined),
      remove: (entry) => {
        const e = a.history.entries.find((x) => x.date === entry.date && x.question === entry.question);
        if (e) a.history.removeEntry(e.id);
      },
      display: (answer) => Markup.display(answer),
    },
    setupChecks: () => a.setupChecks(),
    setupFix: (step) => a.setupFix(step),
    resourceUsage: () => a.resourceUsage(),
    showResource: (path) => a.showResource(path),
    setupFinished: () => log("setup: finished"),
  });
  a.history.on("change", () => a.windows.refreshMenu());
  a.addOns.onChange = () => a.windows.refreshWindows();

  // ── Computer control, crashes ──
  await a.startComputerControl();
  a.startCrashWatcher();
  a.startErrorWatcher();
  a.startBackup();

  // ── Meeting Notes: off at every launch (the shortcut's card, or Settings → Meeting Notes) ──
  a.meetingUI = createMeetingUI();
  a.meetingUI.onAction((act) => a.meetingAction(act));
  a.meeting = new MeetingNotes({
    system: createSystemAudio(),
    // The mic picked in Settings → Voice, but not a Bluetooth headset when the computer has its own mic: opening a
    // headset's mic for the whole meeting would keep its sound in the low-quality call profile.
    mic: createMicStream(async () => {
      const r = meetingMic(await a.audio.inputs().catch(() => []), settings.get("inputDevice"));
      if (r.swappedFrom && r.device) log(`meeting: ${r.swappedFrom.name} is Bluetooth; using ${r.device.name} so the headphones keep their sound quality`);
      if (r.device) log(`meeting: microphone ${r.device.name}`);
      return r.device?.id ?? null;
    }),
    transcribe: async (wav) => {
      a.voiceUsedAt = Date.now(); // keeps the engine loaded through the meeting
      return a.engine ? cleanTranscript(await a.engine.transcribe(wav, [], false)) : "";
    },
    micPaused: () => a.state.phase === "listening",
    claude: cfg.claude, path: cfg.path,
  });
  a.meeting.on("change", () => a.pushMeeting());
  void recoverRecordings();
  a.applyShortcuts(); // the hold key, overlay keys and the Meeting Notes shortcut (Settings → Shortcuts)

  // ── Updates and model downloads ──
  a.updater = new Updater({ currentVersion: a.version, openUrl: (url) => void shell.openExternal(url), quit: () => a.quit() });
  a.updater.onAvailable = (release) => {
    if (a.state.phase !== "idle") return;
    a.state.question = "visioncli";
    a.flash(`VisionCLI ${release.version} is available. Install it from VisionCLI menu → Install Update.`, 10);
    a.windows.refreshMenu();
  };
  a.updater.onError = (message) => { a.state.question = "visioncli update"; a.flash(message, 12); };
  a.updater.onStatus = () => { a.windows.refreshMenu(); a.windows.refreshWindows(); };
  a.updater.startAutomaticChecks();
  a.installer = new ModelInstaller({
    confirm: async (title, text) => (await dialog.showMessageBox({ type: "question", message: title, detail: text, buttons: ["Download", "Cancel"], defaultId: 0, cancelId: 1 })).response === 0,
  });
  a.installer.onStatus = () => a.windows.refreshWindows();
  a.installer.onFinished = (kind, error) => {
    a.windows.refreshWindows();
    if (a.state.phase !== "idle") { log(`installer: ${kind} ${error ?? "done"}`); return; }
    a.state.question = "visioncli";
    if (error) { a.flash(error, 12); return; }
    if (kind === "Whisper") {
      settings.set("stt", "whisper");
      settings.set("whisperModel", "small.en");
      void a.restartSpeechEngine();
      a.flash("Whisper is installed. Transcription now runs locally.", 6);
    } else {
      settings.set("tts", "kokoro");
      settings.set("speak", true);
      a.speaker.warm();
      a.flash("Kokoro voices are installed. Answers will be read aloud; pick a voice in VisionCLI menu → Settings… → Voice.", 8);
    }
  };

  // ── Speech engines, menus, usage ──
  await a.startVoiceEngines();
  a.usage.onChange = () => a.windows.refreshMenu();
  a.agyUsage.onChange = () => a.windows.refreshMenu();
  a.usage.scanToday();
  // Fresh limits on launch if what we have is old (a tiny Haiku request); replies keep them current after that.
  // Each plan's limits for the assistant in use (Claude's refresh spends a tiny Haiku request; agy's is free).
  if (settings.get("assistant") === "claude") { if (a.usage.isStale()) void a.usage.refresh(cfg.claude, { ...process.env, PATH: cfg.path }); }
  else if (cfg.agy) void a.agyUsage.refresh(cfg.agy, { ...process.env, PATH: cfg.path });
  setInterval(() => { a.usage.scanToday(); a.windows.refreshMenu(); a.unloadIdleVoice(); }, 60_000).unref(); // resets roll over; idle models
  settings.on("change", (k: string) => {
    if (k === "assistant") a.state.assistantName = settings.get("assistant") === "claude" ? "Claude" : "Gemini";
    a.windows.refreshMenu();
  });
  void a.refreshCandidates().then(() => {
    log(`project candidates: running=${a.candidates.running.map((r) => `${r.assistant}:${r.project}`).join(",")} windows=${a.candidates.windows.join(",")}`);
    a.windows.refreshMenu();
  });
  // Cheap on Linux (/proc and the window list), so kept fresh for the tray menu, which can't ask when it opens.
  setInterval(() => void a.refreshCandidates().then(() => {
    a.windows.refreshMenu();
  }), 30_000).unref();
  void a.sessions.syncModelFromTerminal(a.currentProject).catch(() => {});
  void a.refreshProbe(true);
  a.sessions.setupAgy();

  if (!settings.get("setupDone")) setTimeout(() => a.windows.openSetup(), 1000);
  // Gemini (Antigravity) takes ~11 s to start: in bubble mode, have it ready before the first question.
  if (settings.get("assistant") === "antigravity" && !settings.get("terminalMode")) {
    setTimeout(() => {
      a.sessions.warm(a.currentProject, "strong");
      if (a.routingOn) a.sessions.warm(a.currentProject, "fast");
    }, 4000);
  }
  if (o.recovered) {
    log("recovered from a crash");
    setTimeout(() => { if (a.state.phase === "idle") { a.state.question = "visioncli"; a.flash(o.recovered!, 8); } }, 1500);
  }

  // ── Hold-to-talk ──
  a.hotkeys = createHotkeys();
  a.hotkeys.on("hotkey", (e) => a.hotkey(e));
  a.hotkeyInfo = await a.hotkeys.start();
  log(`hotkeys: ${a.hotkeyInfo.backend}${a.hotkeyInfo.problem ? ` (${a.hotkeyInfo.problem})` : ""}`);
  if (a.hotkeyInfo.problem && settings.get("setupDone")) {
    setTimeout(() => { if (a.state.phase === "idle") { a.state.question = "Hold-to-talk"; a.flash(a.hotkeyInfo.problem!, 14); } }, 2000);
  }

  a.runDebugFlags(o.argv);
  return a;
}

/** A visioncli://open?path=…&line=… link from another process (a terminal, the browser) opens the file. */
export function handleLink(a: App | null, url: string) {
  const ref = parseOpenLink(url);
  if (!ref || !a) return false;
  void a.apps.openFile(ref.path, ref.line, a.currentProject).catch((e) => log(`open link: ${e}`));
  return true;
}

declare module "./app/core" {
  interface App {
    shutdown(crash: CrashReporter): Promise<void>;
  }
}

/** Quit (App.quit in main.swift): helpers down, session rules removed, a clean exit for the crash guard. */
App.prototype.quit = function (this: App) {
  if (this.quitting) return;
  log("quit");
  electron.quit();
};

App.prototype.shutdown = async function (this: App, crash: CrashReporter) {
  this.quitting = true;
  AgySetup.clearSessionRules();
  crash.markCleanExit();
  try { globalShortcut.unregisterAll(); } catch {}
  try { this.hotkeys?.stop(); } catch {}
  try { this.stopRecording?.(); } catch {}
  try { this.sessions?.closeAll(); } catch {}
  try { this.engine?.stop(); } catch {}
  try { this.speaker?.stop(); this.speaker?.kokoro.stop(); } catch {}
  try { this.meeting?.stop(); this.crashWatcher?.stop(); this.errorWatcher?.stop(); this.backup?.stop(); this.updater?.stop(); } catch {}
  try { this.browseProc?.kill("SIGTERM"); } catch {}
  try { await this.control?.stop(); } catch {}
  try { this.windows?.destroy(); this.ui?.destroy(); this.meetingUI?.destroy(); } catch {}
};
