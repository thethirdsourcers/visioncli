import { meaningful, cleanTranscript } from "./text";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { HotkeyEvent } from "../contracts";
import { ProjectSelector } from "../core/projects";
import { HomeProject } from "../features/home";
import { isTerminal } from "../features/projects";
import { log } from "../log";
import { TMP } from "../paths";
import { settings } from "../settings";
import { find as findTerminalCli, probeWindow } from "../terminal/probe";
import { cliFor } from "../terminal/transcripts";
import { App } from "./core";
import type { OverlayKey } from "./keys";
import { makeShot, rawWindowUnderPointer, windowLabel, windowUnderPointer } from "./shots";

// Hold-to-talk (App+Listening.swift): the hotkeys, opening the mic and deciding the project at key-down, the
// transcript at key-up. Linux: the microphone is recorded to a WAV (live captions are re-transcriptions of it) and
// the local engine transcribes it when the keys are let go; there is no OS recognizer running alongside.

const TAP_MS = 350;
const MAX_LISTEN_MS = 90_000;
const CAPTION_MS = 800;

declare module "./core" {
  interface App {
    hotkey(e: HotkeyEvent): void;
    overlayKey(k: OverlayKey): void;
    startListening(point: boolean, screen?: boolean): void;
    keysReleased(): void;
    finishListening(): Promise<void>;
    stopRecording(): void;
    readonly routingOn: boolean;
  }
}

App.prototype.hotkey = function (this: App, e: HotkeyEvent) {
  if (e.type !== "overlayKey") log(`hotkey ${e.type} in ${this.state.phase}`);
  switch (e.type) {
    case "holdStart":
    case "pointMode":
      // A second tap while listening (tap mode) sends the question.
      if (this.state.phase === "listening") { void this.finishListening(); return; }
      if (this.state.phase === "approval") return;
      this.startListening(e.type === "pointMode", e.type === "holdStart" && e.screenshot);
      return;
    case "screenshot":
      // Super added while Alt is held: the question becomes a screenshot question.
      if (this.state.phase !== "listening" || this.withScreen) return;
      log("hotkey: Super added, now with a screenshot");
      this.withScreen = true;
      this.state.screenshot = true;
      void (async () => {
        const [wins, p] = await Promise.all([this.desktop.windows().catch(() => []), this.pointer()]);
        const w = windowUnderPointer(wins, p);
        if (w && this.state.phase === "listening" && this.withScreen) this.ui.spotlight(w.bounds);
      })();
      return;
    case "holdEnd":
    case "tap":
      this.keysReleased();
      return;
    case "holdCancel":
      // Linux: Alt became part of a shortcut (Alt+Tab is the window switcher here): not a question after all.
      this.keysHeld = false;
      if (this.state.phase === "listening" && !this.state.question) this.dismiss();
      return;
    case "overlayKey":
      this.keys.press(e.key);
      return;
  }
};

App.prototype.overlayKey = function (this: App, k: OverlayKey) {
  log(`hotkey ${k} in ${this.state.phase}`);
  switch (k) {
    case "esc": this.dismiss(); break;
    case "pin": this.togglePin(); break;
    case "open": void this.openFirstReference(); break;
    case "allow": this.approve("allow"); break;
    case "fix": this.fixOfferedError(); break;
  }
};

Object.defineProperty(App.prototype, "routingOn", {
  get(this: App) { return settings.get("smartRouting") && !settings.get("terminalMode") && settings.get("assistant") !== "gemini"; },
});

App.prototype.startListening = function (this: App, point: boolean, screen = false) {
  this.speaker.stop();
  this.wakeVoice();
  this.ui.hideMarks();
  const s = this.state;
  s.pinned = false;
  s.question = "";
  s.live = "";
  s.raw = "";
  s.status = "";
  s.toast = "";
  s.level = 0;
  s.approval = undefined;
  this.startShot = null;
  this.region = null;
  this.heard = "";
  this.pointMode = point;
  this.keysHeld = true;
  this.withScreen = point || screen || settings.get("screenshotEveryQuestion");
  s.screenshot = this.withScreen;
  // The bubble and mascot show at once; the microphone opens meanwhile.
  this.set("listening");
  this.pressedAt = Date.now();
  const started = this.pressedAt;
  const thisPress = () => this.pressedAt === started && (this.state.phase === "listening" || this.state.phase === "thinking");

  // The microphone, with live captions from snapshots of the recording.
  const wav = join(TMP, `visioncli-q-${process.pid}-${started}.wav`);
  this.recording = wav;
  this.recorder.start(wav, settings.get("inputDevice"), (level) => { if (this.pressedAt === started && this.state.phase === "listening") this.state.level = level; })
    .then(() => {
      if (this.pressedAt !== started) return;
      const snap = wav.replace(/\.wav$/, "-live.wav");
      let busy = false;
      this.captionTimer = setInterval(async () => {
        if (busy || this.pressedAt !== started || this.state.phase !== "listening" || !this.engine) return;
        busy = true;
        try {
          if (!(await this.recorder.snapshot(snap))) return;
          const text = (await this.engine.transcribe(snap, this.vocabularyWords(), true)).trim();
          if (text && this.pressedAt === started && this.state.phase === "listening") this.state.question = text;
        } catch {} finally { busy = false; }
      }, CAPTION_MS);
    }, (e) => {
      if (!thisPress()) return;
      log(`listener failed: ${e?.message ?? e}`);
      this.stopRecording();
      this.ui.cancelRegion();
      this.state.question = "Voice";
      this.flash(`Couldn't start the microphone (${String(e?.message ?? e).trim()}). Try again, or pick another mic in VisionCLI menu → Settings… → Voice.`, 10);
    });
  this.warmQuick();

  // Work out the project now and warm up its session while the user is still talking.
  this.terminalContext = null;
  this.terminalProject = null;
  this.existingClaude = null;
  void (async () => {
    const [windows, p] = await Promise.all([this.desktop.windows().catch(() => []), this.pointer()]);
    if (!thisPress()) return;
    const window = windowUnderPointer(windows, p);
    // Screenshot questions: dim everything but the window that will be captured (point mode has its own dimming).
    if (this.withScreen && !point && window && this.state.phase === "listening") this.ui.spotlight(window.bounds);
    const pinned = settings.get("pinnedProject");
    const raw = rawWindowUnderPointer(windows, p);
    if (pinned == null && raw && isTerminal(raw) && raw.pid) {
      // Pointing at a terminal: use that tab's folder, and its CLI session if one is running there.
      void probeWindow(raw.pid).then((t) => {
        if (!t || !thisPress()) return;
        this.terminalContext = t.context;
        this.terminalProject = t.project;
        this.currentProject = t.project;
        this.lastRealProject = { path: t.project, at: Date.now() };
        this.state.project = HomeProject.label(t.project);
        log(`terminal context: ${t.project}${t.context ? ` (${t.context.assistant} running, session ${t.context.sessionId ?? "?"}, ${t.context.delivery.kind})` : ""}`);
      }).catch(() => {});
    }
    this.scopeWindow = window;
    const windowProject = pinned == null ? this.projects.project(window) : null;
    const d = ProjectSelector.decide(pinned, windowProject, this.lastRealProject, Date.now(), HomeProject.path);
    this.currentProject = d.project;
    if (d.fromWindow) this.lastRealProject = { path: d.project, at: Date.now() };
    this.scopeProject = d.askScope ? d.project : null; // about that project, or general? Jev decides
    this.state.project = HomeProject.label(this.currentProject);
    if (settings.get("terminalMode")) {
      const project = this.currentProject;
      void findTerminalCli(cliFor(settings.get("assistant")), project).then((found) => {
        if (this.pressedAt === started) this.existingClaude = found ? { project, context: found } : null;
      }).catch(() => {});
    } else {
      this.sessions.warm(this.currentProject, "strong");
      if (this.routingOn) this.sessions.warm(this.currentProject, "fast");
      if (this.scopeProject != null) this.sessions.warm(HomeProject.path, this.routingOn ? "fast" : "strong");
    }
    if (window && this.withScreen && !point) {
      try {
        const jpeg = await this.ui.hiddenDuring(() => this.desktop.captureWindow(window));
        if (this.pressedAt === started && this.state.phase === "listening") this.startShot = makeShot(jpeg, window.bounds, windowLabel(window), p, window);
      } catch (e) { log(`capture at key-down failed: ${(e as Error)?.message ?? e}`); }
    }
  })();

  if (point) {
    this.state.status = `Drag around what you mean, or tap ${this.shortcutLabels().point} for the whole window…`;
    void this.ui.selectRegion().then((rect) => {
      if (!rect || this.pressedAt !== started) return;
      this.region = rect;
      this.state.status = "";
      this.ui.showMarks([{ kind: "box", rect, label: "" }], 0, { dashed: true, persistent: true });
      // Keys already released while dragging (hold mode): send now.
      if (!this.keysHeld && Date.now() - this.pressedAt >= TAP_MS && this.state.phase === "listening") void this.finishListening();
    });
  }

  if (this.maxTimer) clearTimeout(this.maxTimer);
  this.maxTimer = setTimeout(() => {
    if (this.state.phase === "listening" && this.pressedAt === started) void this.finishListening();
  }, MAX_LISTEN_MS);
};

App.prototype.keysReleased = function (this: App) {
  this.keysHeld = false;
  if (this.state.phase !== "listening") return;
  // In point mode, keep listening while the user is still dragging.
  if (this.pointMode && this.region == null) return;
  if (Date.now() - this.pressedAt < TAP_MS) {
    // Quick tap: keep listening until the next tap.
    if (!this.state.question) this.state.status = "Listening… tap Alt to send";
    return;
  }
  void this.finishListening();
};

App.prototype.stopRecording = function (this: App) {
  if (this.captionTimer) { clearInterval(this.captionTimer); this.captionTimer = null; }
  if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
  if (this.recording) {
    this.recorder.cancel();
    const f = this.recording;
    this.recording = null;
    for (const x of [f, f.replace(/\.wav$/, "-live.wav")]) rmSync(x, { force: true });
  }
};

App.prototype.finishListening = async function (this: App) {
  if (this.captionTimer) { clearInterval(this.captionTimer); this.captionTimer = null; }
  if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
  if (this.state.phase !== "listening") return;
  this.ui.cancelRegion();
  this.state.status = "Thinking…";
  this.set("thinking");
  this.heard = this.state.question.trim();
  const press = this.pressedAt;
  const wav = this.recording;
  this.recording = null;
  let text = "";
  if (wav) {
    try {
      const rec = await this.recorder.stop();
      if (this.pressedAt !== press || (this.state.phase as string) !== "thinking") return;
      if (this.engine) {
        this.state.status = "Transcribing…";
        // Under half a second is a slip of the finger, not a question (macOS treats it as a tap).
        if (rec.seconds >= 0.5) text = cleanTranscript(await this.engine.transcribe(rec.file, this.vocabularyWords(), false));
      }
      log(`transcript (${rec.seconds.toFixed(1)}s, ${this.engine?.name ?? "no engine"}): live="${this.heard}" final="${text}"`);
    } catch (e) {
      log(`recording failed: ${(e as Error)?.message ?? e}`);
    } finally {
      for (const x of [wav, wav.replace(/\.wav$/, "-live.wav")]) rmSync(x, { force: true });
    }
  }
  if (this.pressedAt !== press || (this.state.phase as string) !== "thinking") return;
  // The live caption is the fallback when the final pass has nothing usable (like Apple's text on macOS); Whisper
  // sometimes returns "-" for a clip whose captions were fine.
  void this.questionReady(meaningful(text) ? text : meaningful(this.heard) ? this.heard : "");
};
