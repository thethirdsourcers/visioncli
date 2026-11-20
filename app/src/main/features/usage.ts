import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../settings";
import { run } from "./run";

// Claude plan usage for the menu: the 5-hour session and weekly limits come from the `rate_limit_event` Claude Code
// streams with every reply (no credentials needed). Today's tokens are added up from Claude Code's own transcripts
// (~/.claude/projects), so they cover every Claude Code session on this computer. Port of overlay/Sources/Usage.swift.

export interface UsageWindow { utilization: number; resetsAt: number } // resetsAt: epoch ms
export interface Today { requests: number; input: number; output: number; cached: number }

/** Today's usage lines already read from one transcript: how far it was read, and per message id the counts
 *  (in, out, cached) of its first occurrence. */
interface FileScan { offset: number; ids: string[]; counts: Map<string, [number, number, number]> }

/** Fresh limits only if what we have is older than this (every reply also brings fresh numbers, so this only matters
 *  between questions). */
export const STALE_MS = 15 * 60_000;

interface Store { getStore<T>(k: string): T | undefined; setStore(k: string, v: unknown): void }

export class UsageTracker {
  session: UsageWindow | null;
  week: UsageWindow | null;
  updated: number | null;
  today: Today = { requests: 0, input: 0, output: 0, cached: 0 };
  onChange: () => void = () => {};
  private todayScanned = 0;
  private refreshing = false;
  private scans = new Map<string, FileScan>();
  private scansDay = 0;

  constructor(private store: Store = settings, private projectsDir = join(homedir(), ".claude/projects")) {
    this.session = store.getStore<UsageWindow>("usage.session") ?? null;
    this.week = store.getStore<UsageWindow>("usage.week") ?? null;
    this.updated = store.getStore<number>("usage.updated") ?? null;
  }

  /** From a stream-json `rate_limit_event` ("rate_limit_info": {"unifiedWindows": {"five_hour": …, "seven_day": …}}). */
  record(info: unknown) {
    const windows = (info as { unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }> })?.unifiedWindows;
    if (!windows || typeof windows !== "object") return;
    const window = (k: string): UsageWindow | null => {
      const w = windows[k];
      return w && typeof w.utilization === "number" && typeof w.resetsAt === "number" ? { utilization: w.utilization, resetsAt: w.resetsAt * 1000 } : null;
    };
    const s = window("five_hour"), w = window("seven_day");
    if (s) this.session = s;
    if (w) this.week = w;
    this.updated = Date.now();
    this.store.setStore("usage.session", this.session ?? undefined);
    this.store.setStore("usage.week", this.week ?? undefined);
    this.store.setStore("usage.updated", this.updated);
    this.onChange();
  }

  /** Feeds one stream-json line (from any claude run); records it if it's a rate_limit_event. */
  recordLine(line: string) {
    if (!line.includes("rate_limit_event")) return;
    try {
      const obj = JSON.parse(line);
      if (obj?.rate_limit_info) this.record(obj.rate_limit_info);
    } catch {}
  }

  /** A window's utilization in percent, or 0 once its reset time has passed. */
  percent(w: UsageWindow | null | undefined, now = Date.now()): number | null {
    if (!w) return null;
    return w.resetsAt < now ? 0 : Math.round(w.utilization * 100);
  }

  isStale(now = Date.now()) { return now - (this.updated ?? 0) > STALE_MS; }

  /** Asks Claude Code for fresh numbers: the smallest possible Haiku request (it uses a sliver of the limit). */
  async refresh(claude: string, env?: NodeJS.ProcessEnv) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Not saved as a session: no transcript in ~/.claude/projects (today's count, the backup, /resume stay clean).
      const { out } = await run(claude, ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
        "--max-turns", "1", "Reply with just: ok"], { cwd: tmpdir(), env, timeout: 120_000 });
      for (const line of out.split("\n")) this.recordLine(line);
    } finally {
      this.refreshing = false;
    }
  }

  /** Re-counts today's tokens (at most once a minute). */
  scanToday(now = Date.now()) {
    if (now - this.todayScanned < 60_000) return;
    this.todayScanned = now;
    setImmediate(() => {
      this.today = this.countToday();
      this.onChange();
    });
  }

  /** Transcripts only grow, so each scan reads just the bytes appended since the last one. */
  countToday(now = new Date()): Today {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (this.scansDay !== start) { this.scans = new Map(); this.scansDay = start; }
    const t: Today = { requests: 0, input: 0, output: 0, cached: 0 };
    const seen = new Set<string>(); // a streamed reply is written several times with the same message id
    const kept = new Map<string, FileScan>();
    for (const file of walk(this.projectsDir)) {
      let st;
      try { st = statSync(file); } catch { continue; }
      if (st.mtimeMs < start) continue;
      let scan = this.scans.get(file) ?? { offset: 0, ids: [], counts: new Map() };
      if (st.size < scan.offset) scan = { offset: 0, ids: [], counts: new Map() }; // rewritten: start over
      readAppended(file, scan, start);
      kept.set(file, scan);
      for (const id of scan.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const c = scan.counts.get(id);
        if (!c) continue;
        t.requests++;
        t.input += c[0];
        t.output += c[1];
        t.cached += c[2];
      }
    }
    this.scans = kept; // drops files no longer modified today (or gone)
    return t;
  }

  /** Compact text for the tray: "22% · 52%w". */
  barText(now = Date.now()): string | null {
    const s = this.percent(this.session, now), w = this.percent(this.week, now);
    return s == null || w == null ? null : `${s}% · ${w}%w`;
  }

  static tokens(n: number): string {
    return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.floor(n / 1_000)}K` : `${n}`;
  }

  /** "3:40 PM" today, else "Mon 3:40 PM". */
  static resets(d: number, now = new Date()): string {
    const date = new Date(d);
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  }

  /** Green under 50 %, orange under 80 %, red above (UsageArt.color). */
  static color(percent: number): "red" | "orange" | "green" {
    return percent >= 80 ? "red" : percent >= 50 ? "orange" : "green";
  }
}

function* walk(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

/** Reads complete lines appended after `scan.offset`, a few MB at a time (transcripts can be tens of MB). */
function readAppended(file: string, scan: FileScan, start: number) {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return; }
  try {
    const chunk = Buffer.alloc(4 << 20);
    let carry = Buffer.alloc(0);
    let pos = scan.offset;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      carry = Buffer.concat([carry, chunk.subarray(0, n)]);
      const last = carry.lastIndexOf(0x0a);
      if (last < 0) continue;
      scan.offset += last + 1;
      parseLines(carry.subarray(0, last + 1).toString("utf8"), scan, start);
      carry = Buffer.from(carry.subarray(last + 1)); // an unfinished last line is read again next time
    }
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string, scan: FileScan, start: number) {
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = typeof obj?.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    const msg = obj?.message, usage = msg?.usage;
    if (!(ts >= start) || !usage || typeof usage !== "object") continue;
    const id: string = msg.id ?? obj.uuid ?? `${Math.random()}`;
    if (scan.counts.has(id)) continue;
    const n = (k: string) => (typeof usage[k] === "number" ? Math.trunc(usage[k]) : 0);
    scan.ids.push(id);
    scan.counts.set(id, [n("input_tokens") + n("cache_creation_input_tokens"), n("output_tokens"), n("cache_read_input_tokens")]);
  }
}

// ── Gemini (Antigravity) usage ──────────────────────────────────────────────────────────────────────────────────
// `agy -p /usage --output-format json` reports each model group's 5-hour and weekly limits (remaining fraction and
// reset time) without running a model, so it costs nothing. Gemini models and Claude/GPT models have separate groups.

export interface AgyGroup { name: string; session: UsageWindow | null; week: UsageWindow | null }

export class AgyUsage {
  groups: AgyGroup[];
  updated: number | null;
  onChange: () => void = () => {};
  private refreshing = false;

  constructor(private store: Store = settings) {
    this.groups = store.getStore<AgyGroup[]>("agyUsage.groups") ?? [];
    this.updated = store.getStore<number>("agyUsage.updated") ?? null;
  }

  /** The `command.data.groups` of agy's JSON reply; utilization = the used fraction, like Claude's. */
  static parse(json: string): AgyGroup[] {
    type Bucket = { window?: string; remaining_fraction?: number; reset_time?: string };
    const groups = (JSON.parse(json)?.command?.data?.groups ?? []) as { name?: string; buckets?: Bucket[] }[];
    const win = (bs: Bucket[] | undefined, w: string): UsageWindow | null => {
      const b = bs?.find((x) => x.window === w);
      const at = b?.reset_time ? Date.parse(b.reset_time) : NaN;
      return b && typeof b.remaining_fraction === "number" && !Number.isNaN(at) ? { utilization: Math.max(0, 1 - b.remaining_fraction), resetsAt: at } : null;
    };
    return groups.filter((g) => g.name).map((g) => ({ name: g.name!, session: win(g.buckets, "5h"), week: win(g.buckets, "weekly") }));
  }

  /** The group the chosen agy model draws from (Claude/GPT models have their own limits; everything else is Gemini). */
  active(model: string | null): AgyGroup | null {
    const thirdParty = !!model && /claude|gpt|opus|sonnet/i.test(model);
    return this.groups.find((g) => (thirdParty ? /claude|gpt/i : /gemini/i).test(g.name)) ?? this.groups[0] ?? null;
  }

  isStale(now = Date.now(), maxAge = 10 * 60_000) { return now - (this.updated ?? 0) > maxAge; }

  async refresh(agy: string, env?: NodeJS.ProcessEnv) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { out } = await run(agy, ["-p", "/usage", "--output-format", "json", "--print-timeout", "60s"], { cwd: tmpdir(), env, timeout: 90_000 });
      const groups = AgyUsage.parse(out.slice(out.indexOf("{")));
      if (!groups.length) return;
      this.groups = groups;
      this.updated = Date.now();
      this.store.setStore("agyUsage.groups", groups);
      this.store.setStore("agyUsage.updated", this.updated);
      this.onChange();
    } catch {
      // agy missing, signed out or offline: keep the last numbers
    } finally {
      this.refreshing = false;
    }
  }
}
