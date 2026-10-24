import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";
import { settings } from "../settings";
import { userPath, which, withPath } from "./run";

// Claude backup (ClaudeBackup.swift): everything Claude Code knows about you lives in ~/.claude (CLAUDE.md, settings,
// skills, memory, plugins, conversations) and ~/.claude.json (MCP servers, per-project settings). Once a day VisionCLI
// backs both up with restic into a folder you pick (one synced by Google Drive, Dropbox or OneDrive, or an external
// drive): the first backup is a full copy, later ones only add what changed, every snapshot restores in full, and it's
// all encrypted with a password kept in the system's secret store. The login token (~/.claude/.credentials.json) is
// left out. The password only ever reaches restic through RESTIC_PASSWORD, never a command line.

export const REPO_NAME = "visioncli-claude-backup";

/** Where the password is kept (the app gives one backed by Electron's safeStorage). */
export interface SecretStore { get(): string | null; set(value: string | null): void }

export interface ResticResult { code: number; out: string; err: string }

export const restic = () => which("restic", userPath());

export function installHint(platform: string = process.platform): string {
  return platform === "win32" ? "Install restic first: winget install restic.restic"
    : "Install restic first: sudo apt install restic (Fedora: sudo dnf install restic)";
}

/** 24 characters in groups of 6, without look-alikes (0/O, 1/l/I). */
export function newPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = Array.from({ length: 24 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return chars.match(/.{6}/g)!.join("-");
}

/** Bytes the way ByteCountFormatter (.file) writes them on macOS: decimal units, "Zero KB". */
export function formatBytes(n: number): string {
  if (n <= 0) return "Zero KB";
  if (n < 1000) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${i === 0 ? Math.round(v) : Number(v.toFixed(1))} ${units[i]}`;
}

/** A restic --json "status" line → its progress; null for anything else. */
export function parseStatus(line: string): { pct: number; done: number; total: number } | null {
  try {
    const o = JSON.parse(line);
    if (o?.message_type !== "status" || typeof o.percent_done !== "number") return null;
    return { pct: o.percent_done, done: o.bytes_done ?? 0, total: o.total_bytes ?? 0 };
  } catch { return null; }
}

/** The backup's "summary" line: how much was new, and the whole folder ("4.1 GB, 17,837 files"). */
export function parseSummary(out: string): { added: number | null; whole: string | null } {
  const line = out.split("\n").reverse().find((l) => l.includes('"summary"'));
  try {
    const o = JSON.parse(line ?? "");
    const added = o.data_added_packed ?? o.data_added;
    const whole = typeof o.total_bytes_processed === "number" && typeof o.total_files_processed === "number"
      ? `${formatBytes(o.total_bytes_processed)}, ${o.total_files_processed.toLocaleString("en-US")} files` : null;
    return { added: typeof added === "number" ? added : null, whole };
  } catch { return { added: null, whole: null }; }
}

export function progressText(verb: string, pct: number, done: number, total: number): string {
  return `${verb}… ${Math.floor(pct * 100)}%` + (total > 0 ? ` (${formatBytes(done)} of ${formatBytes(total)})` : "");
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });
/** "just now", "5 minutes ago", "2 days ago". */
export function ago(then: number, now = Date.now()): string {
  const s = (now - then) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return relative.format(-Math.floor(s / 60), "minute");
  if (s < 86_400) return relative.format(-Math.floor(s / 3600), "hour");
  return relative.format(-Math.floor(s / 86_400), "day");
}

/** "Last backup just now: all of ~/.claude (4.1 GB, 17,837 files), of which 2 MB was new. Keeps …" */
export function statusText(last: number | null, whole: string | null, added: number | null, now = Date.now()): string {
  if (last == null) return "No backup yet.";
  // Each snapshot is the whole folder; only the changes since the last one are stored again.
  const all = whole ? `: all of ~/.claude (${whole})` : "";
  const fresh = added == null ? "" : added === 0 ? ", nothing changed since the last one" : `, of which ${formatBytes(added)} was new`;
  return `Last backup ${ago(last, now)}${all}${fresh}. Keeps 7 daily and 4 weekly snapshots.`;
}

/** Where restic puts an absolute path under a restore target: /home/me → <target>/home/me, C:\Users\me → <target>/C/Users/me. */
export function restoredPath(target: string, path: string, platform: string = process.platform): string {
  return platform === "win32" ? join(target, path.replace(/^([A-Za-z]):/, "$1")) : join(target, path);
}

/** One snapshot from `restic snapshots --json`, newest first, for the restore picker. */
export function snapshotChoices(json: string): { id: string; name: string }[] {
  const list = JSON.parse(json) as { short_id?: string; id?: string; time?: string }[];
  return list.reverse().flatMap((s) => {
    const id = s.short_id ?? s.id;
    if (!id || !s.time) return [];
    const d = new Date(s.time);
    const when = isNaN(+d) ? s.time : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    return [{ id, name: `${when}  ·  ${id}` }];
  });
}

export class ClaudeBackup {
  running = false;
  status = "";
  fraction: number | null = null;   // progress of the backup or restore running now
  /** An existing repository picked whose password isn't known yet (the card asks for it). */
  pendingFolder: string | null = null;
  /** Snapshots offered by Restore… (null when the picker isn't open). */
  snapshots: { id: string; name: string }[] | null = null;
  onChange = () => {};
  private timer: NodeJS.Timeout | null = null;

  constructor(private secret: SecretStore, private home = homedir()) {}

  /** The folder picked for backups (the restic repository is a folder inside it); null = backups off. */
  get folder(): string | null { return settings.getStore<string>("claudeBackupFolder") ?? null; }
  set folder(v: string | null) { settings.setStore("claudeBackupFolder", v ?? undefined); this.changed(); }
  get repo(): string | null { return this.folder ? join(this.folder, REPO_NAME) : null; }
  get hasPassword() { return !!this.secret.get(); }

  private changed() { this.onChange(); }
  private say(status: string, fraction: number | null = this.fraction) { this.status = status; this.fraction = fraction; this.changed(); }

  /** Checks hourly and backs up when the last one is a day old (so a computer that sleeps overnight still gets one). */
  start() {
    this.refreshStatus();
    this.timer = setInterval(() => this.backUpIfDue(), 3600_000);
    this.timer.unref?.();
    setTimeout(() => this.backUpIfDue(), 120_000).unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private backUpIfDue() {
    if (!this.folder || this.running) return;
    const last = settings.getStore<number>("claudeBackupLast");
    if (last && Date.now() - last < 23 * 3600_000) return;
    void this.backUp();
  }

  refreshStatus(added: number | null = null) {
    this.say(this.folder ? statusText(settings.getStore<number>("claudeBackupLast") ?? null, settings.getStore<string>("claudeBackupWhole") ?? null, added) : "");
  }

  /** Runs restic on `repo` with the password in its environment; `progress` gets the --json status lines. */
  run(repo: string, args: string[], password: string, progress?: (p: { pct: number; done: number; total: number }) => void): Promise<ResticResult> {
    const exe = restic();
    if (!exe) return Promise.resolve({ code: -1, out: "", err: installHint() });
    return new Promise((resolve) => {
      const env = { ...withPath(userPath()), RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: password };
      const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let out = "", err = "", pending = "", lastReport = 0;
      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        out += d;
        if (!progress) return;
        pending += d;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const p = Date.now() - lastReport > 250 ? parseStatus(line) : null;
          if (p) { lastReport = Date.now(); progress(p); }
        }
      });
      child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
      child.on("error", (e) => resolve({ code: -1, out, err: e.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    });
  }

  static failure(r: ResticResult): string {
    const e = r.err.trim();
    return e ? e.split("\n").pop()! : `restic failed (${r.code})`;
  }

  /** A folder was picked: set up a new repository there, or use the one already in it (asks for its password). */
  async useFolder(folder: string) {
    if (!restic()) { this.say(installHint()); return; }
    const repo = join(folder, REPO_NAME);
    // A folder with backups from before (another computer, or a reinstall): its password is needed to use it.
    const existing = existsSync(join(repo, "config"));
    const pw = this.secret.get();
    if (existing && (!pw || (await this.run(repo, ["cat", "config"], pw)).code !== 0)) {
      this.pendingFolder = folder;
      this.say("This folder already has Claude backups. Enter the backup password to use them (Settings → Advanced → Claude backup → Copy Password, on the computer that made them).");
      return;
    }
    await this.setUp(folder, pw ?? newPassword(), existing);
  }

  /** The password typed for an existing repository. */
  async usePassword(password: string) {
    const folder = this.pendingFolder;
    if (!folder || !password) return;
    if ((await this.run(join(folder, REPO_NAME), ["cat", "config"], password)).code !== 0) {
      this.say("That password doesn't open the backups in this folder.");
      return;
    }
    this.pendingFolder = null;
    await this.setUp(folder, password, true);
  }

  cancelPassword() { this.pendingFolder = null; this.refreshStatus(); }

  private async setUp(folder: string, password: string, existing: boolean) {
    const repo = join(folder, REPO_NAME);
    this.running = true;
    this.say(existing ? "Using the backups in this folder…" : "Setting up…");
    const r = existing ? null : await this.run(repo, ["init"], password);
    this.running = false;
    this.fraction = null;
    if (r && r.code !== 0) { this.say(`Couldn't set up backups: ${ClaudeBackup.failure(r)}`); return; }
    try { this.secret.set(password); } catch (e) { this.say(`Couldn't set up backups: ${(e as Error).message}`); return; }
    this.folder = folder;
    log(`claude backup: repository ${repo}${existing ? " (existing)" : ""}`);
    await this.backUp();
  }

  async backUp() {
    const repo = this.repo, password = this.secret.get();
    if (!repo || !password || this.running) return;
    this.running = true;
    this.say("Backing up…");
    const paths = [join(this.home, ".claude")];
    if (existsSync(join(this.home, ".claude.json"))) paths.push(join(this.home, ".claude.json"));
    const r = await this.run(repo, ["backup", "--json", "--tag", "visioncli", "--exclude", join(this.home, ".claude", ".credentials.json"), ...paths], password,
      (p) => { if (this.running) this.say(progressText("Backing up", p.pct, p.done, p.total), p.pct); });
    // 3 = some files couldn't be read (a conversation being written): the snapshot is still made.
    const ok = r.code === 0 || r.code === 3;
    if (ok) {
      this.say("Cleaning up old snapshots…");
      await this.run(repo, ["forget", "--tag", "visioncli", "--keep-daily", "7", "--keep-weekly", "4", "--prune"], password);
    }
    this.running = false;
    this.fraction = null;
    if (!ok) {
      log(`claude backup failed: ${r.err.trim().slice(0, 300)}`);
      this.say(`Last backup failed: ${ClaudeBackup.failure(r)}`);
      return;
    }
    const s = parseSummary(r.out);
    settings.setStore("claudeBackupLast", Date.now());
    if (s.whole) settings.setStore("claudeBackupWhole", s.whole);
    log(`claude backup: done${s.added != null ? `, ${formatBytes(s.added)} added` : ""}`);
    this.refreshStatus(s.added);
  }

  /** Restore…: lists the snapshots for the picker. */
  async listSnapshots() {
    const repo = this.repo, password = this.secret.get();
    if (!repo || !password || this.running) return;
    const r = await this.run(repo, ["snapshots", "--json", "--tag", "visioncli"], password);
    let list: { id: string; name: string }[] = [];
    try { if (r.code === 0) list = snapshotChoices(r.out); } catch {}
    if (!list.length) { this.say(r.code === 0 ? "No backups to restore yet." : `Couldn't list backups: ${ClaudeBackup.failure(r)}`); return; }
    this.snapshots = list;
    this.changed();
  }

  cancelRestore() { this.snapshots = null; this.changed(); }

  /** Puts a snapshot back: the current ~/.claude and ~/.claude.json are moved aside first (to
   *  ~/.claude-before-restore-<date>), and put back if the restore fails. */
  async restore(id: string) {
    const repo = this.repo, password = this.secret.get();
    const snap = this.snapshots?.find((s) => s.id === id);
    this.snapshots = null;
    if (!repo || !password || !snap || this.running) { this.changed(); return; }
    this.running = true;
    this.say("Restoring…");
    const error = await this.unpack(id, repo, password);
    this.running = false;
    this.fraction = null;
    if (error) { log(`claude restore failed: ${error}`); this.say(`Restore failed: ${error}`); return; }
    log(`claude restore: snapshot ${id}`);
    this.say(`Restored the backup from ${snap.name}. The previous files are in ~/.claude-before-restore-…`);
  }

  /** An error message, or null when it worked. */
  private async unpack(id: string, repo: string, password: string): Promise<string | null> {
    const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const aside = join(this.home, `.claude-before-restore-${stamp}`);
    // restic recreates absolute paths under the target: restored next to home (same disk, so moves are renames).
    const target = join(this.home, `.claude-restore-${stamp}`);
    const names = [".claude", ".claude.json"];
    const r = await this.run(repo, ["restore", id, "--target", target, "--json"], password,
      (x) => this.say(progressText("Restoring", x.pct, x.done, x.total), x.pct));
    const from = restoredPath(target, this.home);
    try {
      if (r.code !== 0) return ClaudeBackup.failure(r);
      if (!existsSync(join(from, ".claude"))) return "the backup doesn't hold ~/.claude";
      mkdirSync(aside, { recursive: true });
      for (const n of names) if (existsSync(join(this.home, n))) renameSync(join(this.home, n), join(aside, n));
      try {
        for (const n of names) if (existsSync(join(from, n))) renameSync(join(from, n), join(this.home, n));
      } catch (e) {
        // Put the previous files back rather than leave a half-restored folder.
        for (const n of names) {
          if (!existsSync(join(aside, n))) continue;
          rmSync(join(this.home, n), { recursive: true, force: true });
          renameSync(join(aside, n), join(this.home, n));
        }
        return (e as Error).message;
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
}
