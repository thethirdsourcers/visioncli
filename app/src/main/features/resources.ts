import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Settings → Usage (ResourceUsage.swift): memory and CPU of every VisionCLI process, grouped by what it is, and the
// disk its models and recordings take. Pure parts here; the app reads ps / the Windows helper (app/resources.ts).

export interface ProcRow { pid: number; ppid: number; cpu: number | null; rss: number; args: string } // rss in bytes
export interface ProcGroup { name: string; cpu: number | null; memory: number; count: number }

export const APP = "VisionCLI app";

/** What a process is, from its command line (null: not VisionCLI's, unless its parent is). browserd runs from the
 *  same script as the tools server, so it's checked first. */
export function processLabel(args: string): string | null {
  if (/kokoro_server/.test(args)) return "Kokoro voice";
  if (/whisper-server/.test(args)) return "Whisper speech model";
  if (/sherpa-onnx|parakeet/i.test(args)) return "Parakeet speech model";
  if (/\sbrowserd(\s|$)/.test(args)) return "Browser control";
  if (/visioncli-mcp|[\\/]server[\\/]index\.m?js|visioncli[\\/]dist[\\/]index\.js/i.test(args)) return "VisionCLI tools (MCP server)";
  return null;
}

/** `ps -A -o pid=,ppid=,%cpu=,rss=,args=` (rss in KiB). */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4] * 1024, args: m[5] });
  }
  return rows;
}

/** Each process gets its own label or its nearest labeled ancestor's (uv → python…), summed by label, most memory
 *  first. `appPids` are the app's own processes (Electron's main, GPU and renderers); their other children are
 *  "VisionCLI app (helpers)". A group's CPU is null when no process in it reported one (Windows). */
export function groupProcesses(rows: ProcRow[], appPids: Set<number>): ProcGroup[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const labelOf = (r: ProcRow): string | null => {
    for (let p: ProcRow | undefined = r, hops = 0; p && hops < 20; p = byPid.get(p.ppid), hops++) {
      const l = appPids.has(p.pid) ? APP : processLabel(p.args);
      if (l) return p === r || l !== APP ? l : `${APP} (helpers)`;
      if (p.ppid <= 1) break;
    }
    return null;
  };
  const sums = new Map<string, ProcGroup>();
  for (const r of rows) {
    const name = labelOf(r);
    if (!name) continue;
    const g = sums.get(name) ?? { name, cpu: null, memory: 0, count: 0 };
    if (r.cpu != null) g.cpu = (g.cpu ?? 0) + r.cpu;
    g.memory += r.rss;
    g.count++;
    sums.set(name, g);
  }
  return [...sums.values()].sort((a, b) => b.memory - a.memory);
}

/** A file's size, or everything inside a folder (0 when missing). */
export function pathSize(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((n, f) => n + pathSize(join(path, f)), 0);
  } catch { return 0; }
}

/** The "On disk" rows: name, the path Show in Folder reveals, bytes; empty items left out. */
export function diskUsage(items: [string, string[]][], size = pathSize): { name: string; path: string; bytes: number }[] {
  return items
    .map(([name, paths]) => ({ name, path: paths[0] ?? "", bytes: paths.reduce((n, p) => n + size(p), 0) }))
    .filter((d) => d.bytes > 0);
}
