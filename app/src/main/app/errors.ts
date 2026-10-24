import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HomeProject } from "../features/home";
import { log } from "../log";
import { CACHE } from "../paths";
import { settings } from "../settings";
import { ErrorWatcher, type TerminalError } from "../terminal/errors";
import { App } from "./core";

// The error watcher's offer (the AppDelegate extension in ErrorWatcher.swift): a badge for 20 s, "Error in shop ·
// Alt+E to fix", with Alt+E live only meanwhile; Alt+E asks the assistant to explain and fix it, in the pane's folder.

declare module "./core" {
  interface App {
    errorWatcher: ErrorWatcher;
    offeredError?: TerminalError | null;
    errorOfferTimer?: NodeJS.Timeout | null;
    startErrorWatcher(): void;
    offerFix(e: TerminalError): void;
    fixOfferedError(): void;
  }
}

App.prototype.startErrorWatcher = function (this: App) {
  this.errorWatcher = new ErrorWatcher(() => settings.get("errorWatcher"));
  this.errorWatcher.onError = (e) => this.offerFix(e);
  this.errorWatcher.start();
};

App.prototype.offerFix = function (this: App, e: TerminalError) {
  if (!["idle", "done", "error"].includes(this.state.phase)) return; // busy: don't interrupt
  log(`error watcher: ${e.tab}: ${e.text.split("\n").pop() ?? ""}`);
  this.offeredError = e;
  const where = e.folder ? basename(e.folder) : e.tab || "the terminal";
  this.ui.badge(`Error in ${where} · ${this.shortcutLabels().fix} to fix`, { icon: "warning", tint: "var(--orange)", seconds: 20 });
  this.setOverlayKeys(this.overlayKeys);
  if (this.errorOfferTimer) clearTimeout(this.errorOfferTimer);
  this.errorOfferTimer = setTimeout(() => {
    this.errorOfferTimer = null;
    this.offeredError = null;
    this.setOverlayKeys(this.overlayKeys);
  }, 20_000);
};

/** Alt+E: the error goes to the assistant as a question, in the pane's folder (the text is in a file the CLI reads,
 *  so the question stays one line in a terminal). */
App.prototype.fixOfferedError = function (this: App) {
  if (this.errorOfferTimer) clearTimeout(this.errorOfferTimer);
  this.errorOfferTimer = null;
  const e = this.offeredError;
  this.offeredError = null;
  this.setOverlayKeys(this.overlayKeys);
  if (!e) return;
  this.ui.badge(null);
  const file = join(CACHE, `error-${Math.floor(Date.now() / 1000)}.txt`);
  try { mkdirSync(CACHE, { recursive: true }); writeFileSync(file, e.text); } catch (err) { log(`error watcher: ${err}`); }
  if (e.folder) { this.currentProject = this.projects.gitRoot(e.folder); this.state.project = HomeProject.label(this.currentProject); }
  this.withScreen = false;
  this.terminalContext = null;
  this.existingClaude = null;
  const question = `Explain and fix the error that just appeared in my terminal tab "${e.tab}". The output is in ${file}.`;
  this.state.question = question;
  this.set("thinking");
  void this.questionReady(question);
};
