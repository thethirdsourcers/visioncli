// The seam between the tray / Settings / History / Setup windows and the orchestrator (app.ts). The windows know
// nothing about the app: they read snapshots (menuModel, settingsSnapshot, setupChecks) and call back by name, so
// every action runs the same app code the menu, the Settings window and the setup wizard share (as on macOS, where
// SettingsWindow.Hooks / SetupWizard.Hooks did the same job).

import type { Tray } from "electron";
import type { HistoryEntry } from "../../contracts";

export type AssistantId = "claude" | "antigravity" | "gemini";

export interface Item { id: string; name: string }

// ── Tray menu (App+Menu.swift, App+Projects.swift, Usage.swift) ─────────────────────────────────────────────────

export interface UsageWindow { percent: number; resetsAt: string }  // percent already 0 once the reset passed

export interface MenuModel {
  currentProject: string;              // path; HOME_PROJECT for Home
  pinnedProject: string | null;        // the project picked by hand (null only before the first launch pinned one)
  homeProject: string;
  /** Project menu candidates, as refreshCandidates found them (the orchestrator refreshes them in the background). */
  running: { project: string; assistant: string }[];   // assistant = binary name ("claude", "agy")
  windows: string[];                   // projects of open editor windows
  recent: string[];                    // history, terminals and sessions, in the Swift order (current first)
  usage: {
    session: UsageWindow | null;
    week: UsageWindow | null;
    today: { requests: number; input: number; output: number; cached: number };
    updated: string | null;            // ISO; when the limits were last read
    inMenuBar: boolean;                // Settings.usageInMenuBar
    weeklyInMenuBar: boolean;
    /** Whose plan this is: "Claude" (Claude Code) or "Gemini" (Antigravity). */
    name?: string;
    /** Gemini: every model group's limits (Gemini models, Claude/GPT models), the active one first. */
    groups?: { name: string; session: UsageWindow | null; week: UsageWindow | null }[];
  };
  updateStatus: string | null;         // "Downloading update…" while installing
  updateAvailable: string | null;      // version
  /** Screen capture isn't set up yet (macOS "Grant Screen Recording…"); the text is the menu item. */
  screenProblem: string | null;
  terminalMode: boolean;
  assistantName: string;               // "Claude" | "Gemini"
  canContinueInTerminal: boolean;      // bubble mode with a session id
}

/** Menu item ids passed to bridge.onMenu. "history" and "settings" are handled by the windows module itself. */
export type MenuId =
  | "pickProject"            // arg: path
  | "chooseFolder"
  | "refreshUsage" | "toggleUsageInMenuBar" | "toggleWeeklyInMenuBar"
  | "installUpdate"
  | "setupScreen"            // the screen capture problem item: opens the right fix (portal / extension)
  | "newConversation" | "copyLastAnswer"
  | "showTerminal"           // terminal mode: Show <Assistant> Terminal
  | "showActivity"           // bubble mode: Show Live Activity in Terminal
  | "continueInTerminal"
  | "quit";

// ── Settings window (SettingsWindow.swift, App+Settings.swift) ──────────────────────────────────────────────────

export interface ToolsStatus { connected: boolean | null; connecting: boolean; error: string | null } // null = not checked yet

export interface SettingsSnapshot {
  // General
  startAtLogin: boolean;
  autoUpdate: boolean;
  screenshotEvery: boolean;
  errorWatcher: boolean;               // Spot errors in the terminal
  hideFromCapture: boolean;
  canHideFromCapture: boolean;         // false on Linux (no way to exclude a window from capture)
  project: string;                     // the project questions go to (picked by hand)
  projectChoices: Item[];              // Home, running CLIs, open windows, recents; id = path
  version: string;
  updateAvailable: string | null;
  updateStatus: string | null;
  // Assistant
  assistant: AssistantId;
  installed: Record<AssistantId, boolean>;
  terminalMode: boolean;
  autoActivity: boolean;
  claudeModel: string;
  fixedModel: string | null;           // VISIONCLI_MODEL / --model wins over the picker
  claudeModels: Item[];                // MenuLabels.claudeModels (id = alias)
  agyModel: string | null;
  agyModels: Item[];
  effort: string | null;
  efforts: Item[];                     // low…max with MenuLabels.effort labels
  smartRouting: boolean;
  // Voice
  speak: boolean;
  speed: number;
  voice: string | null;                // Kokoro voice id; null = the system voice (speech-dispatcher)
  kokoroVoices: Item[];                // empty until Kokoro is installed
  kokoroInstalled: boolean;
  kokoroProblem: string | null;        // Kokoro is installed but failed to start (the last error)
  installStatus: string | null;        // "Downloading Kokoro voices… 42%"
  speechEngine: string;                // "parakeet" | "whisper:<model>" | "system"
  hasParakeet: boolean;
  parakeetReady: boolean;
  parakeetDownloaded: boolean;
  parakeetProgress: number | null;     // 0…1 while it downloads
  whisperModels: string[];
  whisperDownloadable: boolean;        // no model or no whisper-server yet
  systemSpeech: boolean;               // the "system" engine is usable
  inputs: Item[];                      // id = PipeWire/Pulse source name
  outputs: Item[];                     // id = sink name
  inputDevice: string | null;
  outputDevice: string | null;
  defaultInput: string;                // "none" when there is none
  defaultOutput: string;
  // Computer Control
  computerControl: "ask" | "auto" | "off";
  keyboardAccess: boolean;             // in the input group (evdev), or the XInput2 fallback works
  keyboardBackend: string | null;      // "evdev" | "xinput2" | "hooks" (Windows)
  /** process.platform of the app: "linux" | "win32" (wording differs per system). */
  platform?: string;
  keyboardProblem: string | null;      // what's missing ("Join the input group, then log out and in")
  atspi: boolean;                      // AT-SPI accessibility bus enabled
  inputBackend: string | null;         // "xtest" | "portal" | "uinput"; null = can't click or type yet
  watchCrashes: boolean;
  ghostCursor: boolean;
  quickCommands: boolean;
  // Meeting Notes
  meetingNotes: boolean;               // running now (session-only)
  meetingSummarizeGuest: boolean;
  meetingSummarizeYou: boolean;
  meetingReplies: boolean;
  meetingCodeLookup: boolean;
  meetingRecord: boolean;
  meetingShortcut: string;             // "Shift+Alt+Super+R", or the fallback that could be registered
  pastMeetings: Item[];                // the latest 10, id = folder
  // Integrations
  tools: Record<AssistantId, ToolsStatus>;
  /** Add-ons for Claude Code (AddOns.swift), in the recommended order. */
  addOns: { id: string; title: string; detail: string; installed: boolean; installing: boolean; error: string | null }[];
  // Advanced
  desktop: string;                     // "GNOME (Wayland)", "X11 · Openbox"…
  desktopProblem: string | null;       // Desktop.problem()
  crashLogExists: boolean;
  homeProject: string;
  /** Claude backup (ClaudeBackup.swift). */
  backup: {
    restic: boolean;                   // restic is on PATH
    folder: string | null;             // null = off
    running: boolean;
    status: string;
    fraction: number | null;           // 0…1 while a backup or restore runs
    askPassword: boolean;              // the folder picked has backups: their password is needed
    snapshots: Item[] | null;          // the Restore… picker (newest first), null when closed
  };
}

/** settingsAction(name, value): the Settings window's (and setup wizard's) controls. */
export interface SettingsActions {
  // General
  setStartAtLogin: boolean;
  setScreenshotEvery: boolean;
  setErrorWatcher: boolean;
  setHideFromCapture: boolean;
  pickProject: string;                 // a path
  chooseProjectFolder: undefined;
  setAutoUpdate: boolean;
  checkForUpdates: undefined;
  installUpdate: undefined;
  // Assistant
  setAssistant: AssistantId;
  setTerminalMode: boolean;
  setAutoActivity: boolean;
  setClaudeModel: string;
  setAgyModel: string | null;
  setEffort: string | null;
  refreshAgyModels: undefined;
  setSmartRouting: boolean;
  // Voice
  setSpeak: boolean;
  setSpeed: number;                    // plays a sample
  selectVoice: string | null;          // null = the system voice; plays a sample
  installKokoro: undefined;
  installWhisper: undefined;
  chooseSpeech: string;                // "parakeet" | "whisper:<model>" | "system"
  editVocabulary: undefined;
  setAudioDevice: { input: boolean; id: string | null };
  testSpeaker: undefined;
  // Computer Control
  setComputerControl: "ask" | "auto" | "off";
  grantKeyboardAccess: undefined;      // input group (pkexec usermod) or explains the XInput2 fallback
  enableAtspi: undefined;              // gsettings toolkit-accessibility / org.a11y.Status IsEnabled
  setupInput: undefined;               // RemoteDesktop portal consent, or explains xdotool / uinput
  setWatchCrashes: boolean;
  setGhostCursor: boolean;
  setQuickCommands: boolean;
  // Meeting Notes
  toggleMeeting: undefined;            // starting asks for consent, once per launch
  showMeetingPanel: undefined;
  openMeeting: string;                 // a past meeting's folder
  openMeetings: undefined;
  setMeetingOption: { key: "meetingSummarizeGuest" | "meetingSummarizeYou" | "meetingReplies" | "meetingCodeLookup" | "meetingRecord"; on: boolean };
  // Integrations
  checkTools: undefined;               // re-check which CLIs have the tools (slow; updates `tools`)
  connectTools: AssistantId;
  openIntegrations: undefined;
  installAddOns: string[];             // ids; Claude Code only
  // Advanced
  fixPermissions: undefined;           // forget saved portal consent so the desktop asks again
  openLog: undefined;
  openCrashLog: undefined;
  openHome: undefined;
  backupChooseFolder: undefined;
  backupPassword: string;              // for backups already in the folder picked
  backupCancel: undefined;             // closes the password prompt or the restore picker
  backupNow: undefined;
  backupRestore: undefined;            // opens the snapshot picker
  backupRestoreSnapshot: string;       // snapshot id
  backupShow: undefined;
  backupCopyPassword: undefined;
  backupOff: undefined;
}
export type SettingsActionName = keyof SettingsActions;

export type SettingsSection = "general" | "assistant" | "voice" | "control" | "meetings" | "integrations" | "advanced";

// ── Setup wizard (Setup.swift), Linux steps ─────────────────────────────────────────────────────────────────────

export type SetupStepId =
  | "welcome" | "microphone" | "keyboard" | "screen" | "control" | "terminal"
  | "transcription" | "voice" | "assistant" | "addons" | "done";

export interface SetupCheck {
  state: "done" | "pending" | "optional";
  /** One line under the step's header: what was found ("PipeWire · Built-in Audio", "Not in the input group"). */
  detail?: string;
  /** The fix button's label ("Join the input group…"); none = nothing to fix. */
  fix?: string;
  /** Extra explanation below the button (e.g. "Log out and back in for it to take effect."). */
  note?: string;
  /** A command the user can run themselves, shown with a Copy button. */
  command?: string;
  /** setupFix is running. */
  busy?: boolean;
}

export type SetupChecks = Partial<Record<SetupStepId, SetupCheck>>;

// ── History window ──────────────────────────────────────────────────────────────────────────────────────────────

/** A history entry as the History page shows it. */
export interface HistoryView {
  key: string;
  date: string;
  project: string;
  projectLabel: string;
  question: string;
  answer: string;          // as displayed and copied
  shots: string[];         // absolute paths
}

// ── The bridge ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface WindowsBridge {
  menuModel(): MenuModel;
  onMenu(id: MenuId, arg?: string | null): void;
  settingsSnapshot(): SettingsSnapshot | Promise<SettingsSnapshot>;
  settingsAction<K extends SettingsActionName>(name: K, value: SettingsActions[K]): void | Promise<void>;
  history: {
    list(): HistoryEntry[] | Promise<HistoryEntry[]>;     // newest first
    clear(project?: string | null): void | Promise<void>; // null/undefined = everything
    remove(entry: HistoryEntry): void | Promise<void>;
    /** Markup.display: the answer as shown and copied (no Mermaid source, tags…). Defaults to the raw answer. */
    display?(answer: string): string;
  };
  setupChecks(): SetupChecks | Promise<SetupChecks>;
  setupFix(step: SetupStepId): void | Promise<void>;
  /** Setup finished (or closed with everything required done): the orchestrator sets setupDone. Optional. */
  setupFinished?(): void;
}

export interface WindowsUI {
  tray: Tray | null;
  openSettings(section?: SettingsSection): void;
  openHistory(project?: string): void;
  openSetup(step?: SetupStepId): void;
  refreshMenu(): void;
  /** Pushes fresh snapshots to open windows now (after a change the windows can't see, e.g. a download finished). */
  refreshWindows(): void;
  destroy(): void;
}
