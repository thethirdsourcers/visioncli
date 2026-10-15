import type { PermissionAnswer } from "../contracts";
import { createControlServer, type ApprovalCard } from "../control";
import { log } from "../log";
import { settings } from "../settings";
import { App } from "./core";
import { TaskModel } from "./tasks";

// Computer control glue (the AppDelegate extension in Control.swift): the control server's approval cards in the
// bubble, its steps in the task panel, the status line, Esc to stop. The server itself (auth, actions, policy) is
// the control module's.

declare module "./core" {
  interface App {
    startComputerControl(): Promise<void>;
    startCrashWatcher(): void;
    approveControl(card: ApprovalCard, signal: AbortSignal): Promise<PermissionAnswer>;
    showControlStatus(text: string): void;
    setComputerControl(mode: "ask" | "auto" | "off"): void;
    setWatchCrashes(on: boolean): void;
  }
}

/** The card's lines in the bubble's diff style: + typed text, - the sensitive warning, the Esc hint. */
export function cardPreview(card: Pick<ApprovalCard, "detail">): string {
  return card.detail.map((d) => (d.kind === "added" ? "+ " : d.kind === "removed" ? "- " : "  ") + d.text).join("\n");
}

App.prototype.startComputerControl = async function (this: App) {
  // The injector is made on first use (the portal asks for consent then); the server only calls it for actions.
  this.tasks = new TaskModel((steps, paused, title) => this.ui.hud.update(steps, paused, title), () => this.ui.hud.hide());
  this.control = createControlServer({
    desktop: this.desktop,
    input: this.lazyInput,
    ax: this.ax,
    apps: this.apps,
    approve: (card, signal) => this.approveControl(card, signal),
    assistantName: () => (settings.get("assistant") === "claude" ? "Claude" : "Gemini"),
    announce: (text) => this.announcer.announce(text),
    tasks: this.tasks,
    onStatus: (text) => this.showControlStatus(text),
    onActivity: (text) => this.ui.badge(text, { icon: "camera" }),
    onStopped: () => {
      this.tasks.setPaused(false);
      setTimeout(() => this.ui.hud.hide(), 2000);
      this.ui.controlGlow(false);
      this.state.question = "Computer control";
      this.flash("Stopped. The assistant won't touch your computer again until your next question.", 3);
    },
    setStopKey: (on) => this.setOverlayKeys({ ...this.overlayKeys, esc: on || this.state.phase !== "idle" }),
    isIdle: () => this.state.phase === "idle",
    inputProblem: async () => {
      try { const i = await this.input(); this.inputBackend = i.backend; return i.backend === "none" ? "Computer control can't send mouse or keyboard input on this desktop yet: VisionCLI menu → Settings… → Computer Control → Set Up." : null; }
      catch (e) { return String((e as Error)?.message ?? e); }
    },
  });
  this.ui.hud.onAction((a) => {
    if (a === "stop") {
      this.control.stopComputerControl();
      if (this.current?.busy) this.current.stop();
    } else if (a === "pause") {
      this.tasks.setPaused(true);
    } else {
      this.tasks.setPaused(false);
      this.control.resume();
    }
  });
  try { await this.control.start(); } catch (e) { log(`control: not started: ${e}`); }
};

App.prototype.startCrashWatcher = function (this: App) {
  this.crashWatcher.onCrash = (crash) => {
    if (this.state.phase !== "idle") return;
    this.state.question = `${crash.app} crashed`;
    this.flash(`${crash.app} just crashed. Hold Alt and ask "why did it crash?".`, 9);
  };
  if (settings.get("watchCrashes")) void this.crashWatcher.start();
};

/** Shows a computer-control card in the bubble; one card at a time (an assistant approval showing goes first). */
App.prototype.approveControl = function (this: App, card: ApprovalCard, signal: AbortSignal) {
  return new Promise<PermissionAnswer>((resolve) => {
    const show = () => {
      if (signal.aborted) { resolve("deny"); return; }
      const finish = (answer: PermissionAnswer) => {
        if (this.pendingControl?.resolve !== finish) return;
        this.pendingControl = null;
        this.state.approval = undefined;
        this.sessions.activity.permission(`Computer: ${answer !== "deny" ? "allowed" : "denied"}`, answer !== "deny");
        // Back to the answer in progress, or away.
        if (this.current?.busy) { this.state.status = answer !== "deny" ? "Working…" : "OK, skipping that…"; this.set("thinking"); }
        else this.set("idle");
        resolve(answer);
      };
      signal.addEventListener("abort", () => {
        if (this.pendingControl?.resolve !== finish) return;
        this.pendingControl = null;
        this.state.approval = undefined;
        if (this.state.phase === "approval") this.set("idle");
        resolve("deny");
      }, { once: true });
      this.pendingControl = { resolve: finish };
      this.state.approval = { tool: "", summary: card.title, preview: cardPreview(card), queue: 0 };
      if (!this.state.question) this.state.question = "Computer control";
      this.speaker.stop();
      this.set("approval");
    };
    if (this.pendingPermission && this.state.phase === "approval") this.controlWaiting.push(show);
    else show();
  });
};

/** The step being performed, in the bubble, the activity badge and the screen edges. */
App.prototype.showControlStatus = function (this: App, text: string) {
  this.sessions.activity.text(`\n> ${text}\n`);
  this.ui.badge(`${text} · esc stops`, { icon: "cursor", tint: "purple", seconds: 4 });
  this.ui.controlGlow(true, 4);
  switch (this.state.phase) {
    case "thinking": case "listening": this.state.status = text; break;
    case "answering": this.state.toast = text; break;
    case "idle": case "error":
      this.state.question = "Computer control";
      this.flash(text + "  (esc stops)", 2.5);
      break;
    default: break;
  }
};

/** "ask" | "auto" | "off" */
App.prototype.setComputerControl = function (this: App, mode) {
  settings.set("computerControl", mode);
  if (mode !== "off") void this.input().then((i) => { this.inputBackend = i.backend; }, () => {});
};

App.prototype.setWatchCrashes = function (this: App, on: boolean) {
  settings.set("watchCrashes", on);
  if (on) void this.crashWatcher.start(); else this.crashWatcher.stop();
};
