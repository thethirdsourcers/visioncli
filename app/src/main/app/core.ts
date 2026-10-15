import type { ChildProcess } from "node:child_process";
import type { AssistantSessions } from "../assistant";
import type {
  Accessibility, Apps, AssistantSession, AudioDevices, Desktop, DesktopWindow, Hotkeys, InputInjector, Lane, OverlayState,
  PermissionAnswer, Point, Rect, Recorder, SpeechEngine, SpeechEngines, TerminalContext,
} from "../contracts";
import type { ControlServer } from "../control";
import type { AnnounceQueue } from "../features/announce";
import type { MeetingNotes } from "../features/meeting/notes";
import type { Autostart } from "../features/autostart";
import type { CrashReporter } from "../features/crashreporter";
import type { CrashWatcher } from "../features/crashwatch";
import type { HistoryStore } from "../features/history";
import { HomeProject } from "../features/home";
import type { ModelInstaller } from "../features/installer";
import type { ProjectResolver } from "../features/projects";
import type { Updater } from "../features/updater";
import type { AgyUsage, UsageTracker } from "../features/usage";
import { settings } from "../settings";
import type { LinuxSpeaker } from "../tts";
import type { MeetingUI } from "../ui/meeting";
import type { OverlayUI } from "../ui/overlay";
import type { WindowsUI } from "../ui/windows";
import type { AppConfig } from "./config";
import type { OverlayKeys, OverlayKey } from "./keys";
import type { Shot } from "./shots";
import type { TaskModel } from "./tasks";

// The app's state (AppDelegate's stored properties). Its behaviour lives in the files next to this one, each adding
// methods to App the way the App+*.swift extensions do: listening.ts, questions.ts, sessions.ts, panel.ts, bubble.ts,
// browserTask.ts, announce.ts, menu.ts, projects.ts, settings.ts, setup.ts, voice.ts, control.ts, debug.ts.
// app.ts wires them together at launch.

export type HotkeysImpl = Hotkeys & { setListening?(on: boolean): void };

export class App {
  // ── Modules (set at launch) ──
  ui!: OverlayUI;
  windows!: WindowsUI;
  desktop!: Desktop;
  ax!: Accessibility;
  apps!: Apps;
  hotkeys!: HotkeysImpl;
  recorder!: Recorder;
  audio!: AudioDevices;
  engines!: SpeechEngines;
  speaker!: LinuxSpeaker;
  sessions!: AssistantSessions;
  control!: ControlServer;
  tasks!: TaskModel;
  history!: HistoryStore;
  usage!: UsageTracker;
  agyUsage!: AgyUsage;
  projects!: ProjectResolver;
  crashWatcher!: CrashWatcher;
  meeting!: MeetingNotes;
  meetingUI!: MeetingUI;
  updater!: Updater;
  installer!: ModelInstaller;
  autostart!: Autostart;
  announcer!: AnnounceQueue;
  keys!: OverlayKeys;
  /** Created on first use: on Wayland the RemoteDesktop portal asks for consent then. */
  injector: Promise<InputInjector> | null = null;
  makeInjector: () => Promise<InputInjector> = async () => { throw new Error("no input"); };
  input(): Promise<InputInjector> { return (this.injector ??= this.makeInjector().catch((e) => { this.injector = null; throw e; })); }
  inputBackend: string | null = null;
  /** An injector that is only created when an action needs it (for modules that hold one). */
  readonly lazyInput: InputInjector = (() => {
    const i = () => this.input();
    const self = this;
    return {
      get backend() { return self.inputBackend ?? "pending"; },
      move: async (p) => (await i()).move(p),
      click: async (p, b, n) => (await i()).click(p, b, n),
      type: async (t) => (await i()).type(t),
      key: async (k) => (await i()).key(k),
      scroll: async (dx, dy, at) => (await i()).scroll(dx, dy, at),
      drag: async (a, b) => (await i()).drag(a, b),
    } satisfies InputInjector;
  })();

  /** The transcription engine in use (null until chosen). */
  engine: SpeechEngine | null = null;
  /** Last time voice was used (key-down or speech): models unload after a while without it (app/voice.ts). */
  voiceUsedAt = Date.now();
  /** Meeting Notes was confirmed once this launch (it's never remembered on). */
  meetingConsented = false;
  hotkeyInfo: { backend: string; problem?: string } = { backend: "none" };
  hotkeysStarted = false;

  // ── The bubble (OverlayState, published to the overlay on every change) ──
  readonly state: OverlayState;
  private renderQueued = false;

  activityShown = false;
  lastCost: number | undefined;
  private _project = "";
  candidates: { running: { project: string; assistant: string }[]; windows: string[] } = { running: [], windows: [] };
  currentShots: Shot[] = [];
  currentWindow: DesktopWindow | null = null;
  withScreen = false; // this question gets a screenshot (Alt+Super, point mode, or the "every question" setting)

  // ── This press ──
  startShot: Shot | null = null;
  region: Rect | null = null;
  pressedAt = 0;
  /** The keys of this press are still down (point mode waits for the drag while they are). */
  keysHeld = false;
  pointMode = false;
  recording: string | null = null;
  captionTimer: NodeJS.Timeout | null = null;
  maxTimer: NodeJS.Timeout | null = null;
  hideTimer: NodeJS.Timeout | null = null;
  heard = "";
  /** Terminal conversations that already got the voice instructions (see questions.ts). */
  instructed = new Set<string>();

  // ── Where the question goes ──
  current: AssistantSession | null = null;
  terminalContext: TerminalContext | null = null;
  /** The project of the terminal the user pointed at (TerminalProbe.probe's project). */
  terminalProject: string | null = null;
  existingClaude: { project: string; context: TerminalContext } | null = null;
  lastRealProject: { path: string; at: number } | null = null;
  scopeProject: string | null = null;
  scopeWindow: DesktopWindow | null = null;
  quick: { cancel(): void } | null = null;
  browseProc: ChildProcess | null = null;
  nextLane: Lane = "strong";
  lastLane = new Map<string, { lane: Lane; at: number; question: string }>();
  lastWarm = 0;

  // ── Approvals ──
  /** The assistant is waiting for Allow/Deny on an edit or command. */
  pendingPermission: { resolve: (a: PermissionAnswer) => void } | null = null;
  /** A computer-control card is up. */
  pendingControl: { resolve: (a: PermissionAnswer) => void } | null = null;
  /** Control cards waiting while an assistant approval is showing. */
  controlWaiting: (() => void)[] = [];
  overlayKeys: Partial<Record<OverlayKey, boolean>> = {};

  quitting = false;
  version = "0.0.0";
  crashLogFile = "";
  parakeetProgress: number | null = null;

  constructor(readonly cfg: AppConfig) {
    HomeProject.ensure();
    // The project is picked by hand (Project menu); the first time, the launch folder (or Home) is it.
    if (!settings.get("pinnedProject")) settings.set("pinnedProject", cfg.cwd === process.env.HOME ? HomeProject.path : cfg.cwd);
    this._project = settings.get("pinnedProject") ?? HomeProject.path;
    const raw: OverlayState = {
      phase: "idle", question: "", live: "", level: 0, status: "", raw: "", pinned: false, speaking: false, screenshot: false,
      toast: "", project: HomeProject.label(this._project), assistantName: "Claude",
    };
    // Like the SwiftUI view observing OverlayState: any change is drawn on the next tick, coalesced.
    this.state = new Proxy(raw, {
      set: (t, k, v) => {
        if ((t as any)[k] !== v) { (t as any)[k] = v; this.queueRender(); }
        return true;
      },
    });
  }

  get currentProject() { return this._project; }
  set currentProject(p: string) {
    if (p === this._project) return;
    this._project = p;
    this.windows?.refreshMenu();
  }

  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.ui?.render({ ...this.state });
    });
  }

  async pointer(): Promise<Point | null> { return this.desktop.pointer().catch(() => null); }

  /** The front window's app name, for VISIONCLI_FRONT_APP (NSWorkspace.frontmostApplication). */
  async frontApp(): Promise<string> { return (await this.desktop.activeWindow().catch(() => null))?.app ?? ""; }
}
