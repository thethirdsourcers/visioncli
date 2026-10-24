import { log } from "../log";
import { run, screenText } from "./mux";
import { environ, listProcs } from "./procs";

// Error watcher (ErrorWatcher.swift): every few seconds VisionCLI reads the terminal panes it can read (tmux, kitty,
// WezTerm; the macOS app reads iTerm tabs), and when a new error or stack trace appears in one (not in the AI's own
// pane), a badge offers Alt+E to fix it. Each error is offered once; errors already on screen at launch are ignored.

export interface TerminalError {
  tab: string;            // pane or tab title, e.g. "npm run dev"
  folder: string | null;  // the pane's working directory
  text: string;           // the lines around the error
}

export interface Pane { id: string; name: string; folder: string | null; text: string }

// Lines that start an error report in common toolchains (Node, Python, Go, Rust, Swift, Java, shells, test runners).
const PATTERNS = [
  /Traceback \(most recent call last\)/, /^\s*(Uncaught )?[A-Z]\w*(Error|Exception)\b(:|\s)/, /^\s*Error: /,
  /npm ERR!/, /^panic: /, /^error(\[E\d+\])?: /, /: error: /, /^\s*FAIL\b/, /BUILD FAILED/,
  /Segmentation fault/, /^fatal error: /, /^Exception in thread/, /command not found$/,
];
const PROMPTS = ["➜ ", "❯ ", "$ ", "% ", "# "];

/** The last error in the bottom of the screen: its first line (to tell errors apart) and the lines around it. */
export function lastError(screen: string): { line: string; text: string } | null {
  // Panes are padded with empty lines below the output.
  const lines = screen.split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-40);
  let i = tail.length - 1;
  while (i >= 0 && !PATTERNS.some((p) => p.test(tail[i]))) i--;
  if (i < 0) return null;
  // From the command that failed (the last prompt line above the error), else the 10 lines before it.
  let prompt = i - 1;
  while (prompt >= 0 && !PROMPTS.some((p) => tail[prompt].includes(p))) prompt--;
  const text = tail.slice(prompt >= 0 ? prompt : Math.max(0, i - 10)).join("\n").trim();
  return { line: tail[i].trim(), text };
}

/** The AI CLIs' own panes are left alone. */
const isAI = (s: string) => ["claude", "agy", "gemini"].some((a) => s.toLowerCase().includes(a));

/** A file:// URL (WezTerm's and kitty's cwd) or a path → a path. */
export function cwdPath(cwd: string | undefined | null): string | null {
  if (!cwd) return null;
  if (!cwd.startsWith("file://")) return cwd;
  try {
    const p = decodeURIComponent(new URL(cwd).pathname);
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p; // Windows: /C:/Users/… → C:/Users/…
  } catch { return null; }
}

async function tmuxPanes(): Promise<Pane[]> {
  const r = await run("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{window_name}"]);
  if (r.code !== 0) return [];
  const out: Pane[] = [];
  for (const line of r.out.split("\n")) {
    const [id, cmd = "", path = "", name = ""] = line.split("\t");
    if (!id || isAI(cmd) || isAI(name)) continue;
    out.push({ id: `tmux:${id}`, name, folder: path || null, text: await screenText({ kind: "tmux", target: id }) });
  }
  return out;
}

async function weztermPanes(): Promise<Pane[]> {
  const r = await run("wezterm", ["cli", "list", "--format", "json"]);
  if (r.code !== 0) return [];
  const out: Pane[] = [];
  try {
    for (const p of JSON.parse(r.out) as { pane_id: number; title?: string; cwd?: string }[]) {
      if (isAI(p.title ?? "")) continue;
      out.push({ id: `wezterm:${p.pane_id}`, name: p.title ?? "", folder: cwdPath(p.cwd), text: await screenText({ kind: "wezterm", pane: p.pane_id }) });
    }
  } catch {}
  return out;
}

/** kitty's remote-control sockets, from the environment of the shells it runs (Linux; kitty needs listen_on). */
function kittySockets(): string[] {
  const procs = listProcs();
  const kitty = new Set(procs.filter((p) => p.comm === "kitty").map((p) => p.pid));
  if (!kitty.size) return [];
  return [...new Set(procs.filter((p) => kitty.has(p.ppid)).map((p) => environ(p.pid).KITTY_LISTEN_ON).filter(Boolean))];
}

async function kittyPanes(): Promise<Pane[]> {
  const out: Pane[] = [];
  for (const socket of kittySockets()) {
    const r = await run("kitty", ["@", "--to", socket, "ls"]);
    if (r.code !== 0) continue;
    try {
      type W = { id: number; title?: string; cwd?: string; foreground_processes?: { cmdline?: string[] }[] };
      for (const os of JSON.parse(r.out) as { tabs: { windows: W[] }[] }[]) {
        for (const w of os.tabs.flatMap((t) => t.windows)) {
          if (isAI(w.title ?? "") || (w.foreground_processes ?? []).some((p) => isAI((p.cmdline ?? []).join(" ")))) continue;
          out.push({ id: `kitty:${socket}:${w.id}`, name: w.title ?? "", folder: cwdPath(w.cwd), text: await screenText({ kind: "kitty", socket, id: w.id }) });
        }
      }
    } catch {}
  }
  return out;
}

/** Every pane VisionCLI can read, except the AI CLIs' own. */
export async function readPanes(): Promise<Pane[]> {
  const all = await Promise.all([tmuxPanes(), weztermPanes(), process.platform === "linux" ? kittyPanes() : []]);
  return all.flat();
}

export class ErrorWatcher {
  /** A new error was found. */
  onError: (e: TerminalError) => void = () => {};
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private seen = new Set<string>();
  private primed = false;

  constructor(private enabled: () => boolean, private read: () => Promise<Pane[]> = readPanes) {}

  start() {
    this.timer ??= setInterval(() => void this.poll(), 5000);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async poll() {
    if (!this.enabled() || this.busy) return;
    this.busy = true;
    try {
      const found: [string, TerminalError][] = [];
      for (const p of await this.read()) {
        const e = lastError(p.text);
        if (e) found.push([`${p.id}|${e.line}`, { tab: p.name, folder: p.folder, text: e.text }]);
      }
      const fresh = found.filter(([k]) => !this.seen.has(k));
      fresh.forEach(([k]) => this.seen.add(k));
      // The first look only learns what's already there.
      if (this.primed && fresh.length) this.onError(fresh[fresh.length - 1][1]);
      this.primed = true;
    } catch (e) {
      log(`error watcher: ${e}`);
    } finally {
      this.busy = false;
    }
  }
}
