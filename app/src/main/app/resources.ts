import { app as electron, shell } from "electron";
import { dirname, join } from "node:path";
import { winHelper } from "../desktop/windows/win32";
import { formatBytes } from "../features/backup";
import { MEETINGS_DIR } from "../features/meeting/recording";
import { type ProcRow, diskUsage, groupProcesses, parsePs } from "../features/resources";
import { run } from "../features/run";
import { LOG_FILE, log } from "../log";
import { SUP } from "../paths";
import { VoiceModels } from "../stt";
import { SHERPA_DIR, parakeetFiles } from "../stt/models";
import type { ResourceUsageView } from "../ui/windows";
import { App } from "./core";

// Settings → Usage (ResourceUsagePage): the page asks every 2 s while it's open. Processes come from ps on Linux; on
// Windows from the helper's process list (pid, parent, command line) with memory from tasklist, which has no CPU
// figure, so CPU is left out there. The app's own processes (main, GPU, renderers) are Electron's app metrics.

declare module "./core" {
  interface App {
    resourceUsage(): Promise<ResourceUsageView>;
    showResource(path: string): void;
  }
}

let disk: ResourceUsageView["disk"] | null = null;
let lastAsked = 0;

async function processRows(): Promise<ProcRow[]> {
  if (process.platform !== "win32") return parsePs((await run("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss=,args="], { timeout: 5000 })).out);
  const [procs, list] = await Promise.all([winHelper().call("processes", {}), run("tasklist", ["/fo", "csv", "/nh"], { timeout: 10_000 })]);
  const mem = new Map<number, number>();
  for (const line of list.out.split("\n")) {
    const f = line.trim().split('","'); // "Image","PID","Session","#","12,345 K"
    if (f.length >= 5) mem.set(Number(f[1]), Number(f[4].replace(/\D/g, "")) * 1024);
  }
  return procs.map((p) => ({ pid: p.pid, ppid: p.ppid, cpu: null, rss: mem.get(p.pid) ?? 0, args: p.cmdline || p.exe }));
}

App.prototype.resourceUsage = async function (this: App) {
  const metrics = electron.getAppMetrics();
  const appPids = new Set(metrics.map((m) => m.pid));
  let rows: ProcRow[] = [];
  try { rows = await processRows(); } catch (e) { log(`usage: processes: ${e}`); }
  // The app's own figures from Electron: the only CPU on Windows, and all there is without ps (Flatpak).
  const own = new Map(metrics.map((m) => [m.pid, m]));
  rows = rows.filter((r) => !own.has(r.pid)).concat(metrics.map((m) => ({
    pid: m.pid, ppid: rows.find((r) => r.pid === m.pid)?.ppid ?? 0,
    cpu: process.platform === "win32" ? null : m.cpu.percentCPUUsage, rss: m.memory.workingSetSize * 1024, args: "",
  })));
  const groups = groupProcesses(rows, appPids);
  const cpu = (n: number | null) => (n == null ? null : `${Math.round(n)}% CPU`);
  const running = groups.map((g) => ({ name: g.name + (g.count > 1 ? `  ·  ${g.count} processes` : ""), cpu: cpu(g.cpu), memory: formatBytes(g.memory) }));
  if (groups.length) {
    const total = groups.reduce((t, g) => ({ cpu: g.cpu == null ? t.cpu : (t.cpu ?? 0) + g.cpu, mem: t.mem + g.memory }), { cpu: null as number | null, mem: 0 });
    running.push({ name: "Total", cpu: process.platform === "win32" ? null : cpu(total.cpu), memory: formatBytes(total.mem) });
  }
  // The disk is measured when the page opens (it was closed for more than a few seconds), not every 2 s.
  if (!disk || Date.now() - lastAsked > 5000) {
    const parakeet = parakeetFiles();
    const items = diskUsage([
      ["Kokoro voices", [VoiceModels.kokoroModel(), VoiceModels.kokoroVoices()].filter((p): p is string => !!p)],
      ["Whisper speech models", VoiceModels.whisperModels().map((m) => m[1])],
      ["Parakeet speech model", [...(parakeet ? [dirname(parakeet.encoder)] : []), SHERPA_DIR]],
      ["Meeting recordings and notes", [MEETINGS_DIR]],
      ["Screenshots and history", [join(SUP, "screenshots")]],
      ["Logs", [LOG_FILE, LOG_FILE + ".1", this.crashLogFile].filter(Boolean)],
    ]);
    disk = items.map((d) => ({ name: d.name, path: d.path, size: formatBytes(d.bytes) }));
    if (items.length) disk.push({ name: "Total", path: null, size: formatBytes(items.reduce((n, d) => n + d.bytes, 0)) });
  }
  lastAsked = Date.now();
  return { running, disk, cpu: process.platform !== "win32" };
};

App.prototype.showResource = function (this: App, path: string) {
  if (disk?.some((d) => d.path === path)) shell.showItemInFolder(path); // only the paths the page was given
};
