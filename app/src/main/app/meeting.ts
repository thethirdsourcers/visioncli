import { clipboard, dialog, shell } from "electron";
import { mkdirSync } from "node:fs";
import type { DesktopWindow } from "../contracts";
import { HomeProject } from "../features/home";
import { MEETINGS_DIR, pastMeetings } from "../features/meeting/recording";
import { DEFAULT_SHORTCUTS, shortcutLabel } from "../input/shortcuts";
import { log } from "../log";
import { settings } from "../settings";
import { type LauncherModel, type MeetingAction, fileUrl } from "../ui/meeting";
import { canHideFromCapture } from "../ui/windows/protection";
import { App } from "./core";

// Meeting Notes (App+Meeting.swift): the shortcut's launcher card, starting and stopping, the speech engine it uses,
// the panel's actions, and past meetings. The listening itself is features/meeting/notes.ts.

declare module "./core" {
  interface App {
    toggleMeeting(): Promise<void>;
    startMeeting(project: string, fromLauncher?: boolean): Promise<void>;
    showMeetingLauncher(): void;
    showMeetingPanel(): void;
    openPastMeeting(folder: string): void;
    openMeetingsFolder(): void;
    meetingProjects(): string[];
    meetingAction(a: MeetingAction): void;
    pushMeeting(): void;
    meetingShortcut: string;
  }
}

App.prototype.meetingShortcut = shortcutLabel(DEFAULT_SHORTCUTS.meeting); // or the user's / the fallback (applyShortcuts)

/** The engine label the panel shows ("Parakeet", "Whisper large-v3"). */
export function engineLabel(name: string | undefined | null): string {
  if (!name) return "";
  if (name === "parakeet") return "Parakeet";
  if (name.startsWith("whisper:")) return `Whisper ${name.slice(8)}`;
  if (name === "whisper") return "Whisper";
  return "the system speech engine";
}

const projectLabel = (p: string) => (!p || p === HomeProject.path ? "No project" : p.split(/[\\/]/).filter(Boolean).pop() ?? p);

App.prototype.toggleMeeting = async function (this: App) {
  if (this.meeting.isOn) {
    this.meeting.stop();
    this.ui.badge("Meeting Notes stopped: writing the summary", { icon: "speaker", seconds: 3 });
    this.windows.refreshWindows();
    return;
  }
  await this.startMeeting(settings.get("pinnedProject") ?? this.currentProject);
};

App.prototype.startMeeting = async function (this: App, project: string, fromLauncher = false) {
  if (this.meeting.isOn) return;
  // The card explains what it does; Settings asks once per launch.
  if (!fromLauncher && !this.meetingConsented) {
    const r = await dialog.showMessageBox({
      type: "question", message: "Start Meeting Notes?",
      detail: "VisionCLI listens to your computer's sound (your colleagues on the call) and your microphone (you), and "
        + "transcribes both on this computer. After each turn, Claude Haiku writes a one-line summary, and when a colleague "
        + "asks you something it suggests three short replies. Questions about the code are looked up (read-only) in the "
        + "project. Notes are saved in VisionCLI's meetings folder. Nothing is read aloud or sent for you.\n\n"
        + "Where the law or your company's rules require it, tell the people in the meeting.",
      buttons: ["Start", "Cancel"], defaultId: 0, cancelId: 1,
    });
    if (r.response !== 0) return;
  }
  this.meetingConsented = true;
  // The speech engine picked in Settings → Voice (it already falls back parakeet → whisper → system).
  this.wakeVoice();
  const engine = this.engine;
  const avail = await this.engines.available().catch(() => null);
  if (!engine || (avail && !avail.parakeet && !avail.whisper.length)) {
    this.state.question = "Meeting Notes";
    this.flash("Meeting Notes needs speech recognition: install Parakeet or Whisper (Settings → Voice).", 10);
    return;
  }
  this.meeting.project = project;
  this.meeting.engine = engineLabel(engine.name);
  log(`meeting: transcribing with ${this.meeting.engine}`);
  try {
    await this.meeting.start();
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    log(`meeting: couldn't start: ${message}`);
    this.state.question = "Meeting Notes";
    this.flash(message, 12);
    return;
  }
  this.showMeetingPanel();
  this.ui.badge("Meeting Notes: listening", { icon: "speaker", tint: "#30d158", seconds: 3 });
  this.windows.refreshWindows();
};

App.prototype.showMeetingPanel = function (this: App) {
  this.pushMeeting();
  this.meetingUI.showPanel();
};

/** The shortcut: the start card (its options and project), or Stop / Show Notes while a meeting runs. */
App.prototype.showMeetingLauncher = function (this: App) {
  if (this.meetingUI.launcherVisible) { this.meetingUI.hideLauncher(); return; }
  this.meetingUI.showLauncher(launcherModel(this, this.meeting.isOn ? this.meeting.project : settings.get("pinnedProject") ?? this.currentProject));
};

let launcherProject = "";
function launcherModel(a: App, project: string): LauncherModel {
  launcherProject = project;
  return {
    running: a.meeting.isOn, startedAt: a.meeting.startedAt, shortcut: a.meetingShortcut, project, projectLabel: projectLabel(project),
    options: {
      summarizeGuest: settings.get("meetingSummarizeGuest"), summarizeYou: settings.get("meetingSummarizeYou"),
      replies: settings.get("meetingReplies"), codeLookup: settings.get("meetingCodeLookup"), record: settings.get("meetingRecord"),
      hide: settings.get("hideFromCapture"), canHide: canHideFromCapture(),
    },
  };
}

const OPTION_KEYS = {
  summarizeGuest: "meetingSummarizeGuest", summarizeYou: "meetingSummarizeYou", replies: "meetingReplies",
  codeLookup: "meetingCodeLookup", record: "meetingRecord", hide: "hideFromCapture",
} as const;

App.prototype.meetingAction = function (this: App, a: MeetingAction) {
  switch (a.type) {
    case "start":
      this.meetingUI.hideLauncher();
      void this.startMeeting(launcherProject, true);
      break;
    case "stop":
      this.meetingUI.hideLauncher();
      if (this.meeting.isOn) void this.toggleMeeting();
      break;
    case "cancel": this.meetingUI.hideLauncher(); break;
    case "showNotes": this.meetingUI.hideLauncher(); this.showMeetingPanel(); break;
    case "openNotes": if (this.meeting.folder) void shell.openPath(`${this.meeting.folder}/notes.md`); break;
    case "copy": clipboard.writeText(a.text); break;
    case "type": void typeReply(this, a.text); break;
    case "setOption": {
      const key = a.key === "canHide" ? null : OPTION_KEYS[a.key];
      if (key) { settings.set(key, !!a.value); this.windows.refreshWindows(); }
      break;
    }
    case "projectMenu": {
      const pick = (p: string) => {
        if (a.from === "launcher") this.meetingUI.updateLauncher(launcherModel(this, p));
        else { this.meeting.project = p; this.pushMeeting(); }
      };
      this.meetingUI.projectMenu(this.meetingProjects(), pick, () => {
        void dialog.showOpenDialog({ title: "Code questions are looked up in…", properties: ["openDirectory"] }).then((r) => {
          if (!r.canceled && r.filePaths[0]) pick(r.filePaths[0]);
        });
      });
      break;
    }
  }
};

/** "Type it": into the window you were in (the panel never takes focus, but a click can still raise it). Never sent:
 *  no Enter. */
async function typeReply(a: App, text: string) {
  const wins = await a.desktop.windows().catch(() => [] as DesktopWindow[]);
  const front = await a.desktop.activeWindow().catch(() => null);
  const target = front && front.pid !== process.pid ? front : wins.find((w) => w.pid !== process.pid) ?? null;
  if (target && target.id !== front?.id) { await a.desktop.focus(target).catch(() => {}); await new Promise((r) => setTimeout(r, 300)); }
  try { await (await a.input()).type(text); } catch (e) { log(`meeting: couldn't type the reply: ${(e as Error).message}`); }
}

App.prototype.pushMeeting = function (this: App) {
  const v = this.meeting.view();
  this.meetingUI?.update({ ...v, projectLabel: projectLabel(v.project), audioUrl: fileUrl(v.audio) });
};

/** Projects to look code questions up in: the current one, then recent ones. */
App.prototype.meetingProjects = function (this: App) {
  const seen = new Set([HomeProject.path]);
  return [this.currentProject, ...this.history.entries.slice(0, 50).map((e) => e.project), ...this.candidates.running.map((r) => r.project), ...this.candidates.windows]
    .filter((p) => !!p && !seen.has(p) && !!seen.add(p));
};

App.prototype.openPastMeeting = function (this: App, folder: string) {
  if (this.meeting.isOn) return;
  const p = pastMeetings(500).find((m) => m.folder === folder);
  if (!p) return;
  this.meeting.load(p.folder, p.record);
  this.showMeetingPanel();
};

App.prototype.openMeetingsFolder = function (this: App) {
  mkdirSync(MEETINGS_DIR, { recursive: true });
  void shell.openPath(MEETINGS_DIR);
};
