import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";
import { run, which, withPath } from "./run";

// Recommended add-ons for Claude Code (AddOns.swift), offered in setup (pre-ticked) and in Settings → Integrations.
// Nothing is installed without the user choosing it: each one changes how their Claude works in every project.
// Claude Code only: nothing here is ever installed for Antigravity.

export interface AddOn {
  id: string;
  title: string;
  detail: string;
  /** Commands run in order with the user's PATH (any failing step stops the install). */
  steps: string[][];
  isInstalled: () => boolean;
}

const readJson = (file: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
};

/** A Claude Code plugin ("name@marketplace") in ~/.claude/plugins/installed_plugins.json. */
export function pluginInstalled(name: string, file = join(homedir(), ".claude/plugins/installed_plugins.json")): boolean {
  const o = readJson(file);
  if (!o) return false;
  const plugins = (o.plugins as Record<string, unknown> | undefined) ?? o;
  return plugins[name] != null;
}

/** A user-scope MCP server in ~/.claude.json (only its mcpServers keys are looked at). */
export function mcpServerInstalled(name: string, file = join(homedir(), ".claude.json")): boolean {
  return (readJson(file)?.mcpServers as Record<string, unknown> | undefined)?.[name] != null;
}

export const ADD_ONS: AddOn[] = [
  { id: "ponytail", title: "Ponytail",
    detail: "Makes Claude write the simplest code that works: no unrequested abstractions, standard library first.",
    steps: [["claude", "plugin", "marketplace", "add", "DietrichGebert/ponytail"], ["claude", "plugin", "install", "ponytail@ponytail"]],
    isInstalled: () => pluginInstalled("ponytail@ponytail") },
  { id: "graphify", title: "Graphify",
    detail: "Turns a codebase into a knowledge graph Claude reads before answering, so it understands big projects fast (/graphify). Needs uv.",
    steps: [["uv", "tool", "install", "graphifyy"], ["graphify", "install"]],
    isInstalled: () => existsSync(join(homedir(), ".claude/skills/graphify/SKILL.md")) },
  { id: "claude-mem", title: "Claude-Mem",
    detail: "Remembers what you worked on across sessions and brings the relevant parts back.",
    steps: [["claude", "plugin", "marketplace", "add", "thedotmack/claude-mem"], ["claude", "plugin", "install", "claude-mem@thedotmack"]],
    isInstalled: () => pluginInstalled("claude-mem@thedotmack") },
  { id: "context7", title: "Context7",
    detail: "Up-to-date documentation for the libraries you use, so Claude doesn't guess at old APIs. Needs Node.",
    steps: [["claude", "mcp", "add", "--scope", "user", "context7", "--", "npx", "-y", "@upstash/context7-mcp"]],
    isInstalled: () => mcpServerInstalled("context7") },
  { id: "security-guidance", title: "Security Guidance",
    detail: "Anthropic's plugin that warns about security mistakes (injection, secrets, unsafe calls) as Claude edits code.",
    steps: [["claude", "plugin", "install", "security-guidance@claude-plugins-official"]],
    isInstalled: () => pluginInstalled("security-guidance@claude-plugins-official") },
];

export class AddOns {
  installed = new Set<string>();
  installing = new Set<string>();
  errors: Record<string, string> = {};
  /** Something changed (the windows redraw). */
  onChange = () => {};
  // One at a time: plugin installs all write Claude's settings.
  private queue = Promise.resolve();
  private readAt = 0;

  constructor(readonly all: AddOn[] = ADD_ONS) {}

  /** Re-reads what's installed, at most every `maxAgeMs` (~/.claude.json can be large; Settings polls). */
  refresh(maxAgeMs = 0) {
    if (Date.now() - this.readAt < maxAgeMs) return;
    this.readAt = Date.now();
    this.installed = new Set(this.all.filter((a) => a.isInstalled()).map((a) => a.id));
  }

  /** `claude` is the Claude Code binary; `path` the user's PATH, where the other steps' commands are found. */
  install(id: string, claude: string, path: string) {
    const addOn = this.all.find((a) => a.id === id);
    if (!addOn || this.installing.has(id) || this.installed.has(id)) return;
    this.installing.add(id);
    delete this.errors[id];
    this.onChange();
    this.queue = this.queue.then(async () => {
      const env = withPath(path);
      let error: string | null = null;
      for (const [cmd, ...args] of addOn.steps) {
        const exe = cmd === "claude" ? (existsSync(claude) ? claude : null) : which(cmd, path);
        if (!exe) { error = `${cmd} isn't installed`; break; }
        const r = await run(exe, args, { env, timeout: 600_000 });
        // Adding a marketplace that's already there isn't a failure.
        if (r.code !== 0 && !(args.includes("marketplace") && /already/i.test(r.out + r.err))) {
          error = (r.err.trim() ? r.err : r.out).trim().split("\n").pop() || `failed (${r.code})`;
          break;
        }
      }
      const ok = !error && addOn.isInstalled();
      log(`add-on ${id}: ${ok ? "installed" : `failed: ${error ?? "not found after install"}`}`);
      this.installing.delete(id);
      if (ok) this.installed.add(id); else this.errors[id] = error ?? "Didn't install";
      this.onChange();
    });
  }
}
