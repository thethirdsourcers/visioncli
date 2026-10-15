import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { log } from "../../log";
import { spawnCommand } from "../run";
import { MeetingAI } from "./core";

// Claude for Meeting Notes (MeetingClaude.swift). Replies have to appear seconds after a colleague stops talking, and
// starting `claude -p` costs a couple of seconds each time, so a process is kept running per job and each request
// is one more stream-json user message. It's one conversation, so it's swapped for a fresh one every few requests
// to keep the context (and the latency) small.

export interface ClaudeWorker {
  readonly busy: boolean;
  warm(): void;
  ask(text: string, done: (result: string | null) => void): void;
  stop(): void;
}

export class WarmClaude implements ClaudeWorker {
  static readonly REQUESTS_PER_PROCESS = 12;
  static readonly TIMEOUT = 30_000;
  private proc: ChildProcess | null = null;
  private buffer = "";
  private waiting: { id: number; done: (r: string | null) => void }[] = [];
  private asked = 0;
  private nextId = 0;
  private readonly args: string[];

  constructor(private o: { label: string; claude: string; path: string; systemPrompt: string; cwd: string; model?: string }) {
    this.args = ["-p", "--model", o.model ?? "haiku", "--effort", "low", "--setting-sources", "project", "--system-prompt", o.systemPrompt,
      "--tools", "", "--strict-mcp-config", "--no-session-persistence",
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  }

  get busy() { return this.waiting.length > 0; }

  /** Starts the process now, so the first request doesn't pay for it. */
  warm() { if (!this.proc) this.spawn(); }

  ask(text: string, done: (r: string | null) => void) {
    if (!this.proc || (this.asked >= WarmClaude.REQUESTS_PER_PROCESS && !this.waiting.length)) this.restart();
    const p = this.proc;
    if (!p?.stdin) { done(null); return; }
    const id = ++this.nextId;
    this.waiting.push({ id, done });
    this.asked++;
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    p.stdin.write(JSON.stringify(msg) + "\n", (e) => { if (e) this.fail("write failed"); });
    // A stuck request would hold up every later one: give up on this process.
    setTimeout(() => { if (this.waiting.some((w) => w.id === id)) this.fail("timed out"); }, WarmClaude.TIMEOUT).unref?.();
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    p?.kill();
    const w = this.waiting;
    this.waiting = [];
    w.forEach((x) => x.done(null));
  }

  private restart() { this.stop(); this.spawn(); }

  private fail(why: string) {
    log(`meeting: ${this.o.label} claude ${why}`);
    this.restart();
  }

  private spawn() {
    try { mkdirSync(this.o.cwd, { recursive: true }); } catch {}
    let p: ChildProcess;
    try {
      const env = { ...process.env, PATH: this.o.path };
      const s = spawnCommand(this.o.claude, this.args, env); // .cmd shims on Windows, the host from a Flatpak
      p = spawn(s.file, s.args, { cwd: this.o.cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: s.verbatim });
    } catch (e) { log(`meeting: ${this.o.label} claude couldn't start: ${(e as Error).message}`); return; }
    p.on("error", (e) => { log(`meeting: ${this.o.label} claude: ${e.message}`); this.exited(p); });
    p.on("exit", () => this.exited(p));
    p.stdin?.on("error", () => {});
    p.stdout!.setEncoding("utf8");
    p.stdout!.on("data", (d: string) => this.received(d, p));
    this.proc = p;
    this.buffer = "";
    this.asked = 0;
  }

  private exited(p: ChildProcess) {
    if (this.proc !== p) return;
    this.proc = null;
    const w = this.waiting;
    this.waiting = [];
    w.forEach((x) => x.done(null));
  }

  private received(d: string, p: ChildProcess) {
    if (this.proc !== p) return;
    this.buffer += d;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const result = MeetingAI.resultOfStreamLine(line);
      if (result === null || !this.waiting.length) continue;
      this.waiting.shift()!.done(result);
    }
  }
}

/** Several warm processes for one job, so requests run side by side: a colleague's second question doesn't wait
 *  behind the replies to the first, nor a summary behind another. An idle process takes each request; a new one is
 *  started (up to `size`) when all are busy, else a random one queues it. */
export class WarmPool {
  all: ClaudeWorker[] = [];
  constructor(private make: () => ClaudeWorker, private size = 3) {}

  /** One process ready before the first request. */
  warm() {
    if (!this.all.length) this.all.push(this.make());
    this.all.forEach((w) => w.warm());
  }

  /** The worker a request goes to (exposed for tests). */
  pick(): ClaudeWorker {
    const idle = this.all.find((w) => !w.busy);
    if (idle) return idle;
    if (this.all.length < this.size) { const w = this.make(); this.all.push(w); return w; }
    return this.all[Math.floor(Math.random() * this.all.length)];
  }

  ask(text: string, done: (r: string | null) => void) { this.pick().ask(text, done); }

  stop() { this.all.forEach((w) => w.stop()); this.all = []; }
}

/** One-shot `claude -p` (the code lookup and the end-of-meeting summary): `prompt` on stdin, the result text or null.
 *  Killed after `timeout`; the returned process can be killed to cancel. */
export function runOnce(o: { claude: string; path: string; args: string[]; cwd: string; prompt: string; timeout: number }, done: (r: string | null) => void): ChildProcess | null {
  let p: ChildProcess;
  try {
    const env = { ...process.env, PATH: o.path };
    const s = spawnCommand(o.claude, ["-p", ...o.args, "--strict-mcp-config", "--no-session-persistence", "--output-format", "json"], env);
    p = spawn(s.file, s.args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: s.verbatim });
  } catch { done(null); return null; }
  let out = "";
  let finished = false;
  const finish = (r: string | null) => { if (finished) return; finished = true; clearTimeout(timer); done(r); };
  const timer = setTimeout(() => { p.kill(); finish(null); }, o.timeout);
  p.stdout!.setEncoding("utf8");
  p.stdout!.on("data", (d: string) => { out += d; });
  p.on("error", () => finish(null));
  p.on("exit", (code) => finish(code === 0 ? MeetingAI.resultOfJson(out) : null));
  p.stdin?.on("error", () => {});
  p.stdin?.end(o.prompt);
  return p;
}

/** Read-only tools, project settings only: user-level hooks and plugins (e.g. memory hooks) can keep a one-shot run
 *  going long after it answered. */
export const lookupArgs = () => ["--model", "sonnet", "--setting-sources", "project", "--tools", "Read,Grep,Glob",
  "--allowedTools", "Read,Grep,Glob", "--append-system-prompt", MeetingAI.lookupPrompt];

export const summaryArgs = () => ["--model", "haiku", "--effort", "low", "--setting-sources", "project", "--tools", "",
  "--system-prompt", MeetingAI.meetingPrompt];
