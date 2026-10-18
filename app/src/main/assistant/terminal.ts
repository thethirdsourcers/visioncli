import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnswerHandlers, AssistantSession, Question, TerminalContext } from "../contracts";
import { LineSplitter, JSONLines } from "../core/transcript";
import { log } from "../log";
import { CACHE, SUP } from "../paths";
import { settings } from "../settings";
import type { BufferedActivity } from "../terminal/activity";
import { batchCommand, batchPath, hasDisplay, openTerminal, shellQuote, which, writeScript } from "../terminal/launcher";
import { hasKeyboardDelivery, hasTmux, pressEnter, run, screenText, selectPane, sendLine, type Delivery } from "../terminal/mux";
import { find, forget, recent } from "../terminal/probe";
import { agyConversation, assistantFor, assistantName, claudeDir, lastModel, newestSession, sessionFile, type Cli } from "../terminal/transcripts";
import { cliEnvironment, geminiEnvironment, type AssistantConfig } from "./config";
import { describe } from "./describe";
import { autoAllowedTools, terminalPrompt } from "./prompts";

// Terminal mode (Terminal.swift TerminalSession): the conversation lives in a real interactive `claude`, `agy` or
// `gemini` in the user's terminal, so they can type to it like `claude -c`. Voice questions are typed into it (tmux /
// kitty / wezterm instead of iTerm2's AppleScript), and the bubble follows the CLI's session file
// (Claude: ~/.claude/projects/<project>/<id>.jsonl; Gemini: ~/.gemini/tmp/<project>/chats/; agy: its brain/ transcript).
// Windows: no tmux; a new CLI opens in WezTerm (typed into with `wezterm cli send-text`) when it's installed, else in
// Windows Terminal or a console window typed into by keyboard. Launch scripts are .cmd files.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tools that may be waiting for approval in the terminal. */
const APPROVAL_TOOLS = ["Edit", "MultiEdit", "Write", "Bash", "NotebookEdit", "replace", "write_file", "run_shell_command",
  "run_command", "write_to_file", "replace_file_content", "multi_replace_file_content"];

/** The project's stable id in script and tmux session names (the Swift djb2 over its UTF-8 bytes, as UInt64). */
export function stableHash(project: string): string {
  let h = 5381n;
  for (const b of Buffer.from(project, "utf8")) h = (h * 33n + BigInt(b)) & 0xffffffffffffffffn;
  return h.toString();
}

export interface TerminalDeps {
  activity: BufferedActivity;
  /** No terminal can be opened (or typed into): answer in the bubble instead. */
  fallback?: (q: Question, h: AnswerHandlers, reason: string) => void;
  /** Timing (tests shorten them). */
  pollMs?: number;
}

export class TerminalSession implements AssistantSession {
  private _sessionId: string;
  /** The pane we type into: one the user runs (attached), or the one VisionCLI opened. */
  delivery: Delivery | null = null;
  private tty: string | undefined;
  /** Folder the CLI runs in (its session files are keyed by it); usually the project root. */
  cwd: string | null = null;
  private offset = 0;
  private lines = new LineSplitter();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  /** Marker of the voice question we're waiting on. The transcript is only followed while there is one. */
  private awaitingMarker: string | null = null;
  private seenQuestion = false;
  private finalText = "";
  private lastTool: string | null = null;
  private lastToolAt = 0;
  private seenToolIds = new Set<string>();
  private agyDiscover = false; // agy picks its own conversation id: find it by the question text after typing
  private finishTimer: NodeJS.Timeout | null = null;
  private geminiFile: string | undefined;
  private cachedFor = "";
  private h: AnswerHandlers | null = null;
  private q: Question | null = null;

  constructor(readonly project: string, readonly cli: Cli, private cfg: AssistantConfig, private deps: TerminalDeps) {
    // Reuse this project's terminal conversation across app restarts.
    const saved = settings.getStore<string>(this.storeKey);
    this._sessionId = saved ?? randomUUID().toLowerCase();
    if (!saved) settings.setStore(this.storeKey, this._sessionId);
  }

  private get storeKey() { return this.cli === "claude" ? `terminalSession:${this.project}` : `terminalSession:${assistantFor(this.cli)}:${this.project}`; }
  private get name() { return assistantName(this.cli); }
  private setSession(id: string) { this._sessionId = id; settings.setStore(this.storeKey, id); }

  private get awaiting() { return this.awaitingMarker; }
  private set awaiting(v: string | null) {
    this.awaitingMarker = v;
    if (v === null) this.stopWatching();
  }

  get busy() { return this.awaitingMarker !== null; }
  sessionId() { return this._sessionId; }

  /** The session file being followed (undefined until the CLI has written it, except Claude's known path). */
  transcriptPath(): string | undefined {
    const cwd = this.cwd ?? this.project;
    if (this.cli === "claude") return join(claudeDir(cwd), `${this._sessionId}.jsonl`);
    if (this.cli === "agy") return sessionFile("agy", cwd, this._sessionId);
    if (this.geminiFile && this.cachedFor === this._sessionId) return this.geminiFile;
    this.geminiFile = sessionFile("gemini", cwd, this._sessionId);
    this.cachedFor = this._sessionId;
    return this.geminiFile;
  }

  /** Use a CLI the user started themselves: type into that pane and follow its transcript. */
  attach(ctx: TerminalContext) {
    if (ctx.delivery.kind === "none") return;
    const same = JSON.stringify(this.delivery) === JSON.stringify(ctx.delivery);
    if (same && !(ctx.sessionId && ctx.sessionId !== this._sessionId)) return;
    this.delivery = ctx.delivery;
    this.tty = ctx.tty;
    this.cwd = ctx.cwd;
    if (ctx.sessionId && ctx.sessionId !== this._sessionId) {
      this.setSession(ctx.sessionId);
      this.follow(this.transcriptPath(), false);
    }
    log(`terminal: attached to your ${this.cli} in ${ctx.delivery.kind} (session ${this._sessionId}) for ${this.project}`);
  }

  /** Start a fresh conversation next time (menu: New Conversation). */
  reset() {
    this.awaiting = null; // the old conversation's answer won't be followed any more
    this.setSession(randomUUID().toLowerCase());
    this.delivery = null;
    this.follow(undefined, true);
  }

  stop() {
    this.awaiting = null;
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.h = null;
  }

  /** The user's CLI keeps running; VisionCLI just stops following it. */
  close() { this.stop(); }

  // MARK: Asking

  /** Type a slash command (/model haiku, /effort high…) into the running CLI as-is: no voice context, no waiting for
   *  an answer. Uses the attached pane, else one the user runs for this project. False if none is running. */
  async command(cmd: string): Promise<boolean> {
    if (this.delivery && (await sendLine(this.delivery, cmd, this.tty))) {
      log(`terminal: sent ${cmd} to ${this.cli} for ${this.project}`);
      return true;
    }
    const found = await find(this.cli, this.project);
    if (!found) return false;
    this.attach(found);
    const ok = await sendLine(found.delivery, cmd, found.tty);
    if (ok) log(`terminal: sent ${cmd} to ${this.cli} for ${this.project}`);
    return ok;
  }

  /** Attach to the CLI the user runs for this project, if any (without typing anything). */
  async findRunning(): Promise<void> {
    if (this.delivery) return;
    const found = await find(this.cli, this.project);
    if (!this.delivery && found) this.attach(found);
  }

  /** The model the CLI used for its latest reply (e.g. "claude-haiku-5-5"). */
  lastModel(): string | null {
    const f = this.cli === "claude" ? this.transcriptPath() : undefined;
    return f ? lastModel(f) : null;
  }

  ask(q: Question, h: AnswerHandlers) {
    this.q = q;
    this.h = h;
    // One line: a newline would submit early. The marker lets us find this turn in the transcript.
    const line = q.text.split("\n").join(" ").split("  ").join(" ");
    this.awaiting = [...line].slice(0, 60).join("");
    this.seenQuestion = false;
    this.finalText = "";
    this.lastTool = null;
    this.seenToolIds = new Set();
    this.agyDiscover = this.cli === "agy";
    this.skipToEnd();
    this.startWatching();
    // The CLI the user already runs for this project wins (the most recently active one), like `claude -c` in that
    // terminal; then the pane VisionCLI opened; only then a new terminal. A pane found moments ago is reused.
    const ours = this.delivery;
    void (async () => {
      const r = recent(this.cli, this.project);
      const found = r ?? (await find(this.cli, this.project));
      await this.deliver(line, found, r !== null, ours);
    })().catch((e) => this.fail(`Couldn't reach the terminal: ${e}`));
  }

  /** Type the question into the pane that was found (attaching to it first), else the one VisionCLI opened, else open one. */
  private async deliver(line: string, found: TerminalContext | null, wasRecent: boolean, ours: Delivery | null): Promise<void> {
    // Attach first, so the transcript is followed from before the question lands in it.
    if (found) this.attach(found);
    this.skipToEnd();
    let target: { d: Delivery; tty?: string; existing: boolean } | null = null;
    if (found && found.delivery.kind !== "none" && (await sendLine(found.delivery, line, found.tty))) target = { d: found.delivery, tty: found.tty, existing: true };
    else if (wasRecent) {
      // The remembered pane is gone (closed since): look again.
      forget(this.cli, this.project);
      return this.deliver(line, await find(this.cli, this.project), false, ours);
    } else if (ours && (await sendLine(ours, line, this.tty))) target = { d: ours, tty: this.tty, existing: false };
    if (target) {
      this.confirmSubmitted(target.d, target.tty);
      log(`terminal: typed voice question into ${target.existing ? `your existing ${this.cli}` : `the ${target.d.kind} session`}`);
    } else {
      await this.openAndAsk(line);
    }
  }

  private status(text: string) { this.h?.onTool(this.lastTool ?? "terminal", text); }

  private fail(message: string) {
    const h = this.h;
    this.awaiting = null;
    this.h = null;
    h?.onError(message);
  }

  /** None running: open one, wait for its prompt, then type. */
  private async openAndAsk(line: string) {
    this.status(`Opening ${this.name} in the terminal…`);
    const opened = await this.open();
    if (!opened.delivery) {
      const reason = `Couldn't open ${this.name} in a terminal VisionCLI can type into: ${opened.problem}.`;
      log(`terminal: ${reason}`);
      const q = this.q, h = this.h;
      this.awaiting = null;
      this.h = null;
      if (this.deps.fallback && q && h) {
        this.deps.activity.note(`${reason} Answering in the bubble instead.`);
        this.deps.fallback(q, h, reason);
      } else {
        h?.onError(reason);
      }
      return;
    }
    this.delivery = opened.delivery;
    this.tty = undefined;
    await this.waitForPrompt(opened.delivery, this.cli === "agy" ? 90 : 40);
    const ok = await sendLine(opened.delivery, line);
    if (ok) this.confirmSubmitted(opened.delivery);
    else this.fail("Couldn't type into the terminal session.");
  }

  /** Shows the CLI's terminal (opening one if VisionCLI has none for this project). */
  async bringToFront(): Promise<void> {
    if (!this.delivery) {
      const r = await this.open();
      if (r.delivery) this.delivery = r.delivery;
      return;
    }
    await selectPane(this.delivery);
  }

  // MARK: Opening a terminal

  /** Opens the CLI for this project somewhere VisionCLI can type into: a tmux session (shown in the user's terminal
   *  emulator), else kitty or WezTerm with remote control. */
  async open(): Promise<{ delivery: Delivery | null; problem?: string }> {
    this.cwd = null;
    // Continue the project's latest conversation (what `claude -c` would pick), not one VisionCLI remembered.
    const latest = this.cli === "claude" ? newestSession("claude", this.project) : undefined;
    if (latest && latest !== this._sessionId) this.setSession(latest);
    const { script, where, id } = this.openScript();
    this.follow(this.transcriptPath(), false);
    if (process.platform === "win32") return this.openWindows(script, where);
    const env = { ...process.env, PATH: this.cfg.path };

    if (await hasTmux()) {
      const name = `visioncli-${id}`;
      // A session left from before (the CLI exited and waits for Enter): none was found running, so start over.
      if ((await run("tmux", ["has-session", "-t", `=${name}`])).code === 0) await run("tmux", ["kill-session", "-t", `=${name}`]);
      // Created detached first, so typing works whether or not a terminal window manages to open.
      const r = await run("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name, "-x", "200", "-y", "50", "-c", this.project, script], { env });
      const pane = r.out.trim();
      if (r.code !== 0 || !pane.startsWith("%")) return { delivery: null, problem: `tmux couldn't start a session (${r.err.trim() || r.code})` };
      const attach = writeScript(`${this.cli}-${id}-attach`, `exec tmux new-session -A -s ${name} ${shellQuote(script)}`);
      const shown = await openTerminal(attach);
      if (!shown.ok) {
        const note = `${shown.problem}; ${this.cli} runs in tmux session ${name} (attach with: tmux attach -t ${name})`;
        log(`terminal: ${note}`);
        this.deps.activity.note(note);
      }
      return { delivery: { kind: "tmux", target: pane } };
    }

    if (!hasDisplay()) return { delivery: null, problem: "tmux isn't installed and there's no graphical session to open a terminal in" };
    // No tmux: kitty or WezTerm, which VisionCLI can type into remotely. The script reports its pane in `where`.
    rmSync(where, { force: true });
    const kitty = which("kitty", this.cfg.path), wezterm = which("wezterm", this.cfg.path);
    if (kitty) {
      const socket = `unix:${join(CACHE, `kitty-${id}.sock`)}`;
      spawn(kitty, ["-o", "allow_remote_control=yes", "--listen-on", socket, "--directory", this.project, script], { detached: true, stdio: "ignore", env }).on("error", () => {}).unref();
      const w = await this.readWhere(where);
      if (w?.kitty) return { delivery: { kind: "kitty", socket: w.kittySocket || socket, id: +w.kitty } };
    }
    if (wezterm) {
      spawn(wezterm, ["start", "--cwd", this.project, "--", script], { detached: true, stdio: "ignore", env }).on("error", () => {}).unref();
      const w = await this.readWhere(where);
      if (w?.wezterm) return { delivery: { kind: "wezterm", pane: +w.wezterm } };
    }
    // Any other emulator: open it there and type with the keyboard into its window (the app's keyboard delivery).
    if (hasKeyboardDelivery() && !kitty && !wezterm) {
      const shown = await openTerminal(script);
      if (shown.ok) {
        for (let i = 0; i < 60; i++) {
          const f = await find(this.cli, this.project);
          if (f && f.delivery.kind === "keyboard") { this.cwd = f.cwd; return { delivery: f.delivery }; }
          await sleep(250);
        }
        return { delivery: null, problem: "the terminal didn't start" };
      }
    }
    return { delivery: null, problem: kitty || wezterm ? "the terminal didn't start" : "install tmux (or use kitty / WezTerm) so VisionCLI can type into the terminal" };
  }

  /** Windows: WezTerm (send-text), else Windows Terminal / a console window typed into by keyboard. */
  private async openWindows(script: string, where: string): Promise<{ delivery: Delivery | null; problem?: string }> {
    rmSync(where, { force: true });
    const wezterm = which("wezterm", this.cfg.path);
    if (wezterm) {
      spawn(wezterm, ["start", "--cwd", this.project, "--", "cmd", "/k", script], { detached: true, stdio: "ignore", env: cliEnvironment(this.cfg) }).on("error", () => {}).unref();
      const w = await this.readWhere(where);
      if (w?.wezterm) return { delivery: { kind: "wezterm", pane: +w.wezterm } };
    }
    if (!hasKeyboardDelivery()) return { delivery: null, problem: "the app can't type into terminal windows yet" };
    const shown = await openTerminal(script, {}, this.project);
    if (!shown.ok) return { delivery: null, problem: shown.problem ?? "no terminal window could be opened" };
    for (let i = 0; i < 60; i++) {
      const f = await find(this.cli, this.project);
      if (f && f.delivery.kind !== "none") { this.cwd = f.cwd; return { delivery: f.delivery }; }
      await sleep(250);
    }
    return { delivery: null, problem: "the terminal didn't start" };
  }

  private async readWhere(file: string): Promise<{ kitty: string; kittySocket: string; wezterm: string } | null> {
    for (let i = 0; i < 50; i++) {
      try {
        const [kitty = "", kittySocket = "", wezterm = ""] = readFileSync(file, "utf8").trim().split(" ");
        return { kitty, kittySocket, wezterm };
      } catch {}
      await sleep(200);
    }
    return null;
  }

  /** Writes the launch script for the current session (CACHE/<cli>-<hash>.sh). */
  openScript(): { script: string; where: string; id: string } {
    mkdirSync(CACHE, { recursive: true });
    const promptFile = join(CACHE, "voice-prompt.txt");
    writeFileSync(promptFile, terminalPrompt);
    const t = this.transcriptPath();
    const resume = !!t && existsSync(t);
    const quote = shellQuote;
    const effort = settings.get("effort"), model = this.cfg.model ?? settings.get("model");
    let command: string;
    if (this.cli === "claude") {
      command = `${quote(this.cfg.claude)} --append-system-prompt "$(cat ${quote(promptFile)})" \\
  --allowedTools ${autoAllowedTools.join(" ")} --disallowedTools mcp__claude-in-chrome ${effort ? `--effort ${effort}` : ""} \\
  ${model === "default" ? "" : `--model ${quote(model)}`} \\
  ${resume ? "--resume" : "--session-id"} ${this._sessionId}`;
    } else if (this.cli === "agy") {
      // agy can't take a system prompt or a preset conversation id; questions carry short instructions.
      const agyModel = settings.get("agyModel");
      command = quote(this.cfg.agy ?? "agy") + (resume ? ` --conversation ${this._sessionId}` : "")
        + (agyModel ? ` --model ${quote(agyModel)}` : "") + (effort ? ` --effort ${effort}` : "");
    } else {
      // Gemini has no --append-system-prompt; each voice question carries its own short instructions.
      const override = geminiEnvironment(this.cfg).GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      // Read the key at launch so it isn't stored in this script.
      const auth = override
        ? `export GEMINI_CLI_SYSTEM_SETTINGS_PATH=${quote(override)}; export GEMINI_API_KEY="$(${quote(this.cfg.node || "node")} -e 'try{const c=require(process.argv[1]);process.stdout.write((c.gemini&&c.gemini.apiKey)||process.env.GEMINI_API_KEY||"")}catch{process.stdout.write(process.env.GEMINI_API_KEY||"")}' ${quote(join(SUP, "integrations.json"))})"\n`
        : "";
      command = auth + `${quote(this.cfg.gemini ?? "gemini")} ${resume ? "--resume" : "--session-id"} ${this._sessionId}`;
    }
    const id = stableHash(this.project);
    const where = join(CACHE, `${this.cli}-${id}.where`);
    if (process.platform === "win32") return { script: writeScript(`${this.cli}-${id}`, this.windowsScript(where, resume)), where, id };
    const body = [
      `printf '\\033]0;%s\\007' ${quote(`${this.cli} · ${basename(this.project)} (visioncli)`)}`,
      `export PATH=${quote(this.cfg.path)}`,
      // Which pane this is, for typing into it (kitty / WezTerm; tmux panes are known when created).
      `printf '%s %s %s\\n' "$KITTY_WINDOW_ID" "$KITTY_LISTEN_ON" "$WEZTERM_PANE" > ${quote(where)}`,
      `cd ${quote(this.project)}`,
      command,
      `echo; echo "${this.cli} exited. Press Enter to close."; read _`,
    ].join("\n");
    const script = writeScript(`${this.cli}-${id}`, body);
    log(`terminal: opening ${this.cli} (${resume ? "resume" : "new"} ${this._sessionId}) in ${this.project}`);
    return { script, where, id };
  }

  /** The .cmd body that starts the CLI on Windows (the same flags as the sh script above). cmd can't read a file into
   *  an argument, so the system prompt is passed inline as one line (well under cmd's 8191-character limit). */
  windowsScript(where: string, resume: boolean): string {
    const effort = settings.get("effort"), model = this.cfg.model ?? settings.get("model");
    const lines: string[] = [];
    let argv: string[];
    if (this.cli === "claude") {
      argv = [this.cfg.claude, "--append-system-prompt", terminalPrompt.replace(/\s*\n\s*/g, " "), "--allowedTools", ...autoAllowedTools, "--disallowedTools", "mcp__claude-in-chrome",
        ...(effort ? ["--effort", effort] : []), ...(model === "default" ? [] : ["--model", model]), resume ? "--resume" : "--session-id", this._sessionId];
    } else if (this.cli === "agy") {
      const agyModel = settings.get("agyModel");
      argv = [this.cfg.agy ?? "agy", ...(resume ? ["--conversation", this._sessionId] : []), ...(agyModel ? ["--model", agyModel] : []), ...(effort ? ["--effort", effort] : [])];
    } else {
      const override = geminiEnvironment(this.cfg).GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      if (override) {
        // Read the key at launch so it isn't stored in this script.
        const keyJs = join(CACHE, "gemini-key.js");
        writeFileSync(keyJs, 'try{const c=require(process.argv[2]);process.stdout.write((c.gemini&&c.gemini.apiKey)||process.env.GEMINI_API_KEY||"")}catch{process.stdout.write(process.env.GEMINI_API_KEY||"")}');
        lines.push(`set "GEMINI_CLI_SYSTEM_SETTINGS_PATH=${override.replace(/%/g, "%%")}"`);
        lines.push(`for /f "usebackq delims=" %%K in (\`call ${batchPath(this.cfg.node || "node")} ${batchPath(keyJs)} ${batchPath(join(SUP, "integrations.json"))}\`) do set "GEMINI_API_KEY=%%K"`);
      }
      argv = [this.cfg.gemini ?? "gemini", resume ? "--resume" : "--session-id", this._sessionId];
    }
    const title = `${this.cli} - ${basename(this.project)} (visioncli)`;
    return [
      `title ${title.replace(/%/g, "%%").replace(/([\^&|<>])/g, "^$1")}`,
      `set "PATH=${this.cfg.path.replace(/%/g, "%%")}"`,
      // Which WezTerm pane this is ("- -" keeps the Linux file's three fields).
      `>${batchPath(where)} echo(- - %WEZTERM_PANE%`,
      `cd /d ${batchPath(this.project)}`,
      ...lines,
      batchCommand(argv),
      "echo.",
      `echo ${this.cli} exited.`,
    ].join("\n");
  }

  /** Claude sometimes takes fast typing for a paste and swallows the Return that follows it. Once the question shows
   *  up in the transcript it was submitted; until then press Return again (an extra Return on an empty prompt does
   *  nothing). */
  private confirmSubmitted(d: Delivery, tty?: string, tries = 4) {
    setTimeout(() => {
      if (this.awaiting === null || this.seenQuestion || tries <= 0) return;
      log("terminal: question not submitted yet, pressing Return again");
      void pressEnter(d, tty);
      this.confirmSubmitted(d, tty, tries - 1);
    }, 700);
  }

  /** Wait until the CLI's input prompt is on screen (so typed text isn't lost), up to ~12 s (agy: ~27 s). */
  private async waitForPrompt(d: Delivery, tries: number) {
    // A window typed into by keyboard can't be read: give the CLI a moment to draw its prompt (typing early is kept
    // in the terminal's input buffer anyway).
    if (d.kind === "keyboard") { await sleep(this.cli === "agy" ? 8000 : 3500); return; }
    for (let left = tries; ; left--) {
      const screen = await screenText(d);
      if (TerminalSession.promptReady(screen)) { await sleep(1500); return; } // let startup output (hooks, banners) settle
      if (left <= 0) return;
      await sleep(300);
    }
  }

  static promptReady(screen: string): boolean {
    return screen.includes("shortcuts") || screen.includes("? for") || screen.includes("❯") || screen.includes("│ >")
      || screen.includes("Type your message") || screen.includes("How can I help");
  }

  // MARK: Transcript watching

  /** Follows the transcript while a question is waiting for its answer (stopped when `awaiting` clears). */
  private startWatching() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 250);
  }

  private stopWatching() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Start following `file` at its current end (or from its start). */
  private follow(file: string | undefined, fromStart: boolean) {
    let size = 0;
    if (!fromStart && file) { try { size = statSync(file).size; } catch {} }
    this.offset = size;
    this.lines.reset();
  }

  /** Only what's written after the question matters: skip whatever the conversation has grown by since last time. */
  private skipToEnd() {
    const f = this.agyDiscover ? undefined : this.transcriptPath();
    if (!f) return;
    try { this.offset = statSync(f).size; this.lines.reset(); } catch {}
  }

  private poll() {
    const marker = this.awaiting;
    if (marker === null) { this.stopWatching(); return; }
    if (this.reading) return;
    if (this.agyDiscover) {
      const id = agyConversation(marker);
      if (!id) return;
      this.agyDiscover = false;
      if (id !== this._sessionId) this.setSession(id);
      this.follow(undefined, true); // read the whole transcript; only lines after the question count
      log(`terminal: following agy conversation ${id}`);
      return;
    }
    const f = this.transcriptPath();
    if (!f) return;
    this.reading = true;
    try {
      const read = this.readNewLines(f);
      if (!read) return;
      for (const o of read.objects) this.handle(o);
      if (!read.grew) this.checkApprovalWait();
    } finally {
      this.reading = false;
    }
  }

  /** The complete lines the transcript has grown by since last time, parsed. Undefined if it can't be read. */
  private readNewLines(file: string): { objects: Obj[]; grew: boolean } | undefined {
    let fd: number;
    try { fd = openSync(file, "r"); } catch { return undefined; }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) this.offset = 0; // file replaced
      if (size <= this.offset) return { objects: [], grew: false };
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      return { objects: JSONLines.objects(buf.subarray(0, n), this.lines), grew: true };
    } finally {
      closeSync(fd);
    }
  }

  private toolUse(name: string, input: Obj) {
    this.lastTool = name;
    this.lastToolAt = Date.now();
    this.h?.onTool(name, describe(name, input));
    this.deps.activity.tool(name, input);
  }

  /** One transcript line (exposed for tests). */
  handle(o: Obj) {
    if (this.cli === "gemini") return this.handleGemini(o);
    if (this.cli === "agy") return this.handleAgy(o);
    const marker = this.awaiting;
    if (marker === null || o.isSidechain === true) return;
    const message = obj(o.message);
    switch (o.type) {
      case "user": {
        if (typeof message.content === "string" && message.content.includes(marker)) { this.seenQuestion = true; return; }
        const content = arr(message.content);
        if (content.some((b) => typeof b.text === "string" && b.text.includes(marker))) { this.seenQuestion = true; return; }
        if (!this.seenQuestion) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          this.lastTool = null;
          let text = typeof block.content === "string" ? block.content : "";
          if (Array.isArray(block.content)) text = arr(block.content).flatMap((p) => (typeof p.text === "string" ? [p.text] : [])).join("\n");
          this.deps.activity.toolResult(text, block.is_error === true, null);
        }
        break;
      }
      case "assistant": {
        if (!this.seenQuestion) return;
        for (const block of arr(message.content)) {
          if (block.type === "tool_use") {
            this.toolUse(typeof block.name === "string" ? block.name : "", obj(block.input));
            this.finalText = ""; // text before a tool call was narration, not the answer
          } else if (block.type === "text" && typeof block.text === "string" && block.text) {
            this.finalText += (this.finalText ? "\n\n" : "") + block.text;
          }
        }
        // Claude Code writes the end of a turn as separate entries (thinking, then the text), so don't stop at the
        // first "end_turn": finish when the turn-summary entries arrive, or shortly after the answer text.
        if (message.stop_reason === "end_turn" && this.finalText) this.scheduleFinish(1000);
        break;
      }
      case "system": {
        const subtype = typeof o.subtype === "string" ? o.subtype : "";
        if (this.seenQuestion && (subtype === "turn_duration" || subtype === "stop_hook_summary")) this.finishTurn();
        break;
      }
    }
  }

  /** Gemini session lines: {"type":"user","content":[{"text"}]}, {"type":"gemini","content":"…","toolCalls":[…]}.
   *  A message is re-written (same id) as it updates; there's no end-of-turn marker, so finish once the reply text
   *  has been stable for a moment. */
  private handleGemini(o: Obj) {
    const marker = this.awaiting;
    if (marker === null) return;
    if (o.type === "user") {
      if (arr(o.content).some((p) => typeof p.text === "string" && p.text.includes(marker)) || (typeof o.content === "string" && o.content.includes(marker))) {
        this.seenQuestion = true;
      }
    } else if (o.type === "gemini") {
      if (!this.seenQuestion) return;
      const calls = arr(o.toolCalls);
      for (const call of calls) {
        const id = typeof call.id === "string" ? call.id : randomUUID();
        if (this.seenToolIds.has(id)) continue;
        this.seenToolIds.add(id);
        if (this.finishTimer) clearTimeout(this.finishTimer);
        this.finalText = "";
        this.toolUse(typeof call.name === "string" ? call.name : "", obj(call.args));
      }
      if (!calls.length && typeof o.content === "string" && o.content) {
        this.finalText = o.content;
        this.scheduleFinish(2500);
      }
    }
  }

  /** agy transcript lines: USER_INPUT (our question), PLANNER_RESPONSE with tool_calls (steps) or content (the
   *  answer), GENERIC (tool output). The answer is the last DONE PLANNER_RESPONSE without tool calls. */
  private handleAgy(o: Obj) {
    const marker = this.awaiting;
    if (marker === null) return;
    const content = typeof o.content === "string" ? o.content : "";
    if (o.type === "USER_INPUT") {
      if (content.includes(marker)) this.seenQuestion = true;
    } else if (o.type === "PLANNER_RESPONSE") {
      if (!this.seenQuestion) return;
      const calls = arr(o.tool_calls);
      for (const call of calls) {
        let name = typeof call.name === "string" ? call.name : "";
        const args = obj(call.args);
        if (name === "call_mcp_tool" && typeof args.ToolName === "string") name = args.ToolName;
        if (this.finishTimer) clearTimeout(this.finishTimer);
        this.finalText = "";
        this.toolUse(name, args);
      }
      if (!calls.length && o.status === "DONE" && content) {
        this.finalText = content;
        this.scheduleFinish(1500);
      }
    }
  }

  private scheduleFinish(ms: number) {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => this.finishTurn(), ms);
  }

  /** Hand the answer to the bubble (the same text that's in the terminal). */
  private finishTurn() {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    if (this.awaiting === null) return;
    this.awaiting = null;
    const h = this.h;
    this.h = null;
    const text = this.finalText.trim();
    if (text) h?.onDone({ text, sessionId: this._sessionId });
    else h?.onError(`${this.name} finished without a text reply; see the terminal.`);
  }

  /** Edits and commands may be waiting for approval in the terminal; say so in the bubble. */
  private checkApprovalWait() {
    const tool = this.lastTool;
    if (this.awaiting === null || !tool || !APPROVAL_TOOLS.includes(tool) || Date.now() - this.lastToolAt <= 1500) return;
    this.h?.onTool(tool, `Running ${tool}… approve in the ${this.name} terminal if asked`);
    this.h?.onWaitingInTerminal?.();
    this.lastTool = null;
  }
}
