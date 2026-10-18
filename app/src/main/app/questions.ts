import type { DesktopWindow } from "../contracts";
import { Markup } from "../core/markup";
import { ProjectSelector } from "../core/projects";
import { QuickCommandFilter, SlashCommand } from "../core/routing";
import { geminiAttachable } from "../assistant";
import { HomeProject } from "../features/home";
import { isTerminal } from "../features/projects";
import { log } from "../log";
import { settings } from "../settings";
import { assistantName, cliFor } from "../terminal/transcripts";
import { App } from "./core";
import { runJson, runText } from "./node";
import { drawMarks, makeShot, rawWindowUnderPointer, regionLabel, sameWindow, windowLabel, windowUnderPointer, type Shot } from "./shots";
import { carryOver, HIDE, hudTitle, terminalQuestion, voiceQuestion } from "./text";

// From a transcript to an answer (App+Questions.swift): quick commands (Jev), smart routing, screenshots, sending,
// and the finished answer.

declare module "./core" {
  interface App {
    questionReady(text: string): Promise<void>;
    routeThenAsk(text: string): Promise<void>;
    runQuick(args: string[], timeoutMs: number): Promise<Record<string, unknown> | null>;
    warmQuick(): void;
    captureAndAsk(text: string): Promise<void>;
    ask(question: string, shots: Shot[], window?: DesktopWindow | null): Promise<void>;
    finish(result: string | null, error: string | null): void;
    readonly nodeCli: import("./node").NodeCli;
  }
}

Object.defineProperty(App.prototype, "nodeCli", {
  get(this: App) {
    const cfg = this.cfg;
    return { node: cfg.node, path: cfg.path, args: (a: string[]) => (cfg.server ? [cfg.server, ...a] : a) };
  },
});

App.prototype.questionReady = async function (this: App, text: string) {
  if (!text) {
    this.ui.hideMarks();
    this.state.question = "";
    // Explain why nothing was transcribed when we know (no engine installed, no microphone…).
    const available = await this.engines.available().catch(() => null);
    if (available && !available.parakeet && !available.whisper.length) {
      this.flash("Speech recognition isn't installed yet. Install it in VisionCLI menu → Settings… → Voice → Speech recognition.", 12);
    } else {
      this.flash("Didn't catch that. Hold Alt while you speak.");
    }
    return;
  }
  this.state.question = text;
  this.state.status = this.withScreen ? "Looking at your screen…" : "Thinking…";
  const front = await this.desktop.activeWindow().catch(() => null);
  const browserInFront = !!front && QuickCommandFilter.isBrowser(`${front.appId} ${front.app}`);
  if (!settings.get("quickCommands") || !QuickCommandFilter.matches(text, browserInFront)) { await this.routeThenAsk(text); return; }
  // Jev first (fast path for simple browser commands); the assistant if it isn't a confident quick action.
  const started = Date.now();
  // Up to 8 s: a slow first Jev answer is retried inside `quick` rather than handed to the assistant.
  const result = await this.runQuick(["quick", text], 8000);
  if (this.state.phase !== "thinking" || this.state.question !== text) return;
  if (result?.task === true) { this.runBrowserTask(text); return; } // several steps: the Jev agent
  const handled = result?.handled === true;
  log(`quick: ${handled ? "handled" : "→ assistant"} intent=${result?.intent ?? "-"} conf=${result?.confidence ?? "-"} ${result?.reason ?? ""} ${Date.now() - started}ms`);
  const message = typeof result?.message === "string" ? result.message : null;
  if (!handled || message == null) { await this.captureAndAsk(text); return; }
  this.sessions.activity.question(text, this.currentProject, []);
  this.sessions.activity.note(`${message} (Jev, ${Date.now() - started}ms)`);
  this.state.raw = message;
  this.set("done");
  this.speaker.feed(message, true);
  this.history.add({ date: new Date().toISOString(), project: this.currentProject, question: text, answer: message, screenshots: [] });
  this.scheduleHide(HIDE.quick);
};

/** Bubble mode: ask Jev (~0.5 s) whether a small fast model can answer, then ask. Terminal mode goes straight on. */
App.prototype.routeThenAsk = async function (this: App, text: string) {
  // Away from any project window shortly after using one: is this about that project, or general (Home)?
  const scope = settings.get("pinnedProject") == null && this.terminalProject == null ? this.scopeProject : null;
  if (!this.routingOn && scope == null) { await this.captureAndAsk(text); return; }
  const input: Record<string, unknown> = { question: text };
  const previous = this.lastLane.get(this.currentProject);
  if (previous && Date.now() - previous.at < 300_000) { input.previous = previous.question; input.previousLane = previous.lane; }
  if (scope != null) {
    input.project = HomeProject.label(scope);
    if (this.scopeWindow) { input.app = this.scopeWindow.app; input.window = this.scopeWindow.title; }
  }
  const started = Date.now();
  const result = await this.runQuick(["route", JSON.stringify(input)], 2500);
  if (this.state.phase !== "thinking" || this.state.question !== text) return;
  const lane = result?.lane === "fast" ? "fast" : "strong";
  const general = scope != null && result?.scope === "general";
  log(`route: ${lane}${scope == null ? "" : general ? ", general (Home)" : ", project"} conf=${result?.confidence ?? "-"}${result?.reason ? ` (${result.reason})` : ""} ${Date.now() - started}ms`);
  if (general) {
    this.currentProject = HomeProject.path;
    this.state.project = "Home";
  }
  this.nextLane = lane;
  await this.captureAndAsk(text);
};

/** `visioncli quick|route …` with a hard timeout (killed if slow, so it can't act after the assistant took over). */
App.prototype.runQuick = async function (this: App, args: string[], timeoutMs: number) {
  this.quick?.cancel();
  const run = runJson(this.nodeCli, args, timeoutMs, await this.frontApp());
  this.quick = run;
  const r = await run.done;
  if (this.quick === run) this.quick = null;
  return r;
};

/** Wake the Jev service while the user is still talking (at most every 120 s). */
App.prototype.warmQuick = function (this: App) {
  if (!settings.get("quickCommands") || Date.now() - this.lastWarm <= 120_000) return;
  this.lastWarm = Date.now();
  void runText(this.nodeCli, ["warm"]).then((out) => log(`quick: ${out.trim()}`));
};

App.prototype.captureAndAsk = async function (this: App, text: string) {
  const region = this.region, startShot = this.startShot;
  const [windows, p] = await Promise.all([this.desktop.windows().catch(() => [] as DesktopWindow[]), this.pointer()]);
  // Text only: no image tokens. The window's name goes along so the assistant can decide to `look` itself.
  if (!this.withScreen) {
    this.ui.hideMarks();
    await this.ask(text, [], windowUnderPointer(windows, p));
    return;
  }
  let shots: Shot[] = [];
  let failure: unknown = null;
  try {
    if (region) {
      const jpeg = await this.ui.hiddenDuring(() => this.desktop.captureRect(region));
      shots = [makeShot(jpeg, region, regionLabel(windows, region), p)];
    } else {
      const end = windowUnderPointer(windows, p);
      if (end) {
        const jpeg = await this.ui.hiddenDuring(() => this.desktop.captureWindow(end));
        const shot = makeShot(jpeg, end.bounds, windowLabel(end), p, end);
        // Pointer moved to another window while talking: send both ("compare this with that").
        shots = startShot && !sameWindow(startShot.window, end) ? [startShot, shot] : [shot];
      } else if (startShot) {
        shots = [startShot];
      } else {
        // No windows to tell apart (generic Wayland): the display under the pointer.
        const displays = await this.desktop.displays();
        const d = (p && displays.find((r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height)) || displays[0];
        if (d) shots = [makeShot(await this.ui.hiddenDuring(() => this.desktop.captureRect(d)), d, "Screen", p)];
      }
    }
  } catch (e) {
    failure = e;
  }
  this.ui.hideMarks();
  if (this.state.phase !== "thinking" || this.state.question !== text) return;
  if (failure && !shots.length) {
    const message = String((failure as Error)?.message ?? failure);
    log(`capture failed: ${message}`);
    this.flash(message, 15);
    return;
  }
  await this.ask(text, shots);
};

App.prototype.ask = async function (this: App, original: string, shots: Shot[], window?: DesktopWindow | null) {
  this.tasks.reset(hudTitle(original));
  let question = original;
  const crash = this.crashWatcher.questionTag();
  if (crash) question += "\n" + crash;
  // A terminal the user pointed at wins; otherwise the window the pointer ended on decides the project.
  const pinned = settings.get("pinnedProject");
  const windowProject = pinned == null && this.terminalProject == null ? this.projects.project(shots[shots.length - 1]?.window ?? window ?? null) : null;
  const d = ProjectSelector.confirm(this.currentProject, pinned, this.terminalProject, windowProject);
  this.currentProject = d.project;
  if (d.fromWindow) this.lastRealProject = { path: d.project, at: Date.now() };
  this.state.project = HomeProject.label(this.currentProject);
  const files = this.history.save(shots.map((s) => s.jpeg));
  shots.forEach((s, i) => { s.file = files[i]; });
  this.currentShots = shots;
  this.control.writeShotMap(shots);
  await this.history.waitForWrites(); // the assistant reads the screenshots next
  this.control.newQuestion(); // a new question re-enables computer control after an Esc stop
  this.currentWindow = shots[shots.length - 1]?.window ?? window ?? this.currentWindow;
  const infos = shots.map((s) => ({ label: s.label, width: s.pixelSize.width, height: s.pixelSize.height, pointer: s.pointer, file: s.file }));
  const text = voiceQuestion(question, this.currentProject, infos, window ? windowLabel(window) : null);
  this.sessions.activity.question(question, this.currentProject, infos);
  this.state.raw = "";

  if (settings.get("terminalMode")) {
    // The CLI running in the tab the user pointed at wins; otherwise the chosen assistant.
    const assistant = this.terminalContext?.assistant === "agy" ? "antigravity" : this.terminalContext?.assistant ?? settings.get("assistant");
    const name = assistantName(cliFor(assistant));
    const t = this.sessions.terminalFor(this.currentProject, cliFor(assistant));
    const pointed = this.terminalContext?.assistant === cliFor(assistant) ? this.terminalContext : null;
    const found = !pointed && this.existingClaude?.project === this.currentProject && this.existingClaude.context.assistant === cliFor(assistant) ? this.existingClaude.context : null;
    if (pointed ?? found) t.attach((pointed ?? found)!);
    // "slash model haiku" / "/compact": a CLI command, typed as-is so the CLI runs it.
    const cmd = SlashCommand.parse(original);
    if (cmd) {
      const asked = this.state.question;
      const sent = await t.command(cmd);
      if (this.state.phase !== "thinking" || this.state.question !== asked) return; // Esc or a new question meanwhile
      if (sent) {
        this.state.raw = `Sent ${cmd} to ${name}.`;
        this.set("done");
        this.scheduleHide(HIDE.command);
      } else {
        this.finish(null, `No ${name} is running in a terminal for this project, so ${cmd} wasn't sent.`);
      }
      return;
    }
    const paths = assistant === "gemini" ? geminiAttachable(files) : files;
    // Only when the mouse really is over another app: over the terminal itself there's nothing to point at.
    let mouseOver: string | null = null;
    if (!shots.length) {
      const [wins, p] = await Promise.all([this.desktop.windows().catch(() => [] as DesktopWindow[]), this.pointer()]);
      const under = rawWindowUnderPointer(wins, p);
      if (under && !isTerminal(under)) mouseOver = windowLabel(under);
    }
    // gemini/agy have no system prompt in a terminal, so the voice instructions go with the first question of each
    // conversation only (keyed by CLI, pane and conversation); later questions carry just the [voice · …] tag.
    const key = () => `${assistant}|${JSON.stringify(t.delivery)}|${t.sessionId()}`;
    const brief = !this.instructed.has(key());
    const line = terminalQuestion(original, { assistant, shots: infos, paths, mouseOver, brief });
    if (brief) this.instructed.add(key());
    this.current = t;
    this.state.status = `Sending to ${name} in the terminal…`;
    if (this.state.phase !== "thinking") this.set("thinking");
    const handlers = this.answerHandlers(t);
    const onDone = handlers.onDone.bind(handlers);
    // agy picks its conversation id only after the first question: remember that one too.
    handlers.onDone = (r) => { if (brief) this.instructed.add(key()); onDone(r); };
    t.ask({ text: line, images: files, project: this.currentProject, lane: "strong" }, handlers);
    return;
  }

  if (settings.get("autoActivity") && !this.activityShown) {
    this.activityShown = true;
    void this.sessions.showActivity();
  }
  const lane = this.routingOn ? this.nextLane : "strong";
  this.nextLane = "strong";
  const s = this.sessions.background(this.currentProject, lane);
  // Switching lanes changes conversations: carry the last couple of exchanges over so follow-ups make sense.
  let sendText = text;
  const last = this.lastLane.get(this.currentProject);
  if (this.routingOn && last && last.lane !== lane && Date.now() - last.at < 1_800_000) sendText = carryOver(this.history.entries, this.currentProject, text);
  this.lastLane.set(this.currentProject, { lane, at: Date.now(), question: original });
  if (lane === "fast") log(`route: fast lane (${settings.get("assistant") === "claude" ? "Haiku" : "fastest agy model"})`);
  this.current = s;
  this.state.status = "Thinking…";
  if (this.state.phase !== "thinking") this.set("thinking");
  s.ask({ text: sendText, images: files, project: this.currentProject, lane }, this.answerHandlers(s));
};

App.prototype.finish = function (this: App, result: string | null, error: string | null) {
  log(`answer: ${error != null ? "ERROR " + error : (result ?? "").replace(/\n/g, " ").slice(0, 300)}`);
  if (error != null) this.sessions.activity.error(error); else this.sessions.activity.done(this.lastCost ?? null);
  this.lastCost = undefined;
  this.pendingPermission = null;
  if (error != null) {
    this.state.raw = error;
    this.set("error");
    this.scheduleHide(HIDE.error);
    return;
  }
  if (result) this.state.raw = result;
  this.set("done");
  this.speaker.feed(Markup.display(this.state.raw), true);

  // Drawings go on the real screen, over the thing the answer is about (the answer itself sits in the corner).
  const marks = Markup.marks(this.state.raw);
  if (marks.length && this.currentShots.length) {
    this.ui.showMarks(drawMarks(marks, this.currentShots), 25_000);
    log(`drawing ${marks.length} mark(s) on screen`);
  }
  this.history.add({
    date: new Date().toISOString(), project: this.currentProject, question: this.state.question, answer: this.state.raw,
    screenshots: this.currentShots.map((s) => s.file).filter((f): f is string => !!f),
  });
  this.scheduleHide(HIDE.answer);
};
