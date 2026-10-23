// KDE Plasma on Wayland: KWin runs scripts but doesn't let apps list windows or read the pointer. VisionCLI exports
// a tiny D-Bus service (dev.visioncli.KWinBridge.p<pid>, under the app id in the Flatpak), loads resources/kwin/visioncli-query.js through
// org.kde.kwin.Scripting with the request filled in, and the script answers by callDBus. One round trip gives the
// windows, the active window, the cursor and the screens; it's cached briefly since callers ask for several at once.
// Capture: spectacle in background mode (KWin allows it the ScreenShot2 interface it restricts for other apps),
// else the Screenshot portal; both give the whole desktop, cropped here.

import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageBus } from "dbus-next";
import { log } from "../../log";
import { TMP } from "../../paths";
import type { Desktop, DesktopWindow, Jpeg, Point, Rect } from "../../contracts";
import { type Encoder, type Tools, cropFor, defaultEncoder, isPng, keepWindow, ownPids, pngSize, readResource, realTools, union } from "./common";
import { busCall, dbusNext, nameHasOwner, portalScreenshot, sessionBus } from "./portal";
import { type PngSource } from "./wayland";
import { prettyApp } from "./sway";

const BRIDGE_PATH = "/dev/visioncli/KWinBridge";
const BRIDGE_IFACE = "dev.visioncli.KWinBridge";

/** The bridge's bus name; inside the Flatpak it's under the app id, the only names a sandboxed app may own. */
export function bridgeName(env: NodeJS.ProcessEnv = process.env, pid = process.pid): string {
  return `${env.FLATPAK_ID || "dev.visioncli"}.KWinBridge.p${pid}`;
}

interface KWinWindow {
  id: string; resourceClass: string; resourceName: string; desktopFile: string; caption: string; pid: number;
  rect: Rect; active: boolean;
}
export interface KWinSnapshot {
  windows: (DesktopWindow & { active: boolean })[];
  cursor: Point | null;
  screens: Rect[];
}

export function parseKWinSnapshot(json: string): KWinSnapshot {
  const raw = JSON.parse(json);
  if (raw.error) throw new Error(`KWin script: ${raw.error}`);
  return {
    windows: (raw.windows as KWinWindow[]).map((w) => {
      const appId = w.desktopFile || w.resourceClass || w.resourceName;
      return {
        id: w.id,
        app: prettyApp(w.resourceClass || w.desktopFile || w.resourceName),
        appId,
        title: w.caption,
        pid: w.pid > 0 ? w.pid : undefined,
        bounds: w.rect,
        active: !!w.active,
      };
    }),
    cursor: raw.cursor ?? null,
    screens: raw.screens ?? [],
  };
}

/** The script with REQUEST filled in (between its /*REQUEST*\/ … /*END*\/ markers). */
export function fillKWinScript(template: string, request: Record<string, string>): string {
  return template.replace(/\/\*REQUEST\*\/[\s\S]*?\/\*END\*\//, JSON.stringify(request));
}

export class KdeDesktop implements Desktop {
  readonly backend = "kde" as const;
  private bridge: { bus: MessageBus; name: string } | null = null;
  private pending = new Map<string, (json: string) => void>();
  private cache: { at: number; snap: Promise<KWinSnapshot> } | null = null;

  constructor(
    private tools: Tools = realTools,
    private encode: Encoder = defaultEncoder(tools),
    private shot: PngSource = portalScreenshot,
  ) {}

  /** Exports bridgeName() with Report(token, json), once. */
  private async ensureBridge() {
    if (this.bridge) return this.bridge;
    const dbus = await dbusNext();
    const bus = await sessionBus();
    const pending = this.pending;
    class Bridge extends dbus.interface.Interface {
      Report(token: string, json: string) {
        pending.get(token)?.(json);
      }
    }
    Bridge.configureMembers({ methods: { Report: { inSignature: "ss", outSignature: "" } } });
    const name = bridgeName();
    bus.export(BRIDGE_PATH, new Bridge(BRIDGE_IFACE));
    await bus.requestName(name, dbus.NameFlag.DO_NOT_QUEUE);
    return (this.bridge = { bus, name });
  }

  private async kwin(member: string, signature: string, body: any[], path = "/Scripting", iface = "org.kde.kwin.Scripting") {
    return busCall(await sessionBus(), "org.kde.KWin", path, iface, member, signature, body);
  }

  /** Runs the script once with `action`; resolves its JSON answer. */
  private async query(action: "snapshot" | "activate", target = ""): Promise<string> {
    const { name } = await this.ensureBridge();
    const token = randomUUID().replace(/-/g, "");
    const plugin = `visioncli_${token}`;
    const file = join(TMP, `visioncli-kwin-${token}.js`);
    await writeFile(file, fillKWinScript(readResource("kwin", "visioncli-query.js"),
      { token, action, target, service: name, path: BRIDGE_PATH, iface: BRIDGE_IFACE }));
    let timer: NodeJS.Timeout | undefined;
    const answer = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("KWin didn't run VisionCLI's script.")), 3000);
      this.pending.set(token, resolve);
    });
    answer.catch(() => {}); // awaited below; this only keeps an early failure from being "unhandled"
    try {
      const [id] = await this.kwin("loadScript", "ss", [file, plugin]);
      // Plasma 6 / late 5: /Scripting/Script<id>; older 5.x: /<id>; last resort: start every loaded script.
      let started = false;
      for (const path of [`/Scripting/Script${id}`, `/${id}`]) {
        try { await this.kwin("run", "", [], path, "org.kde.kwin.Script"); started = true; break; } catch {}
      }
      if (!started) await this.kwin("start", "", []);
      return await answer;
    } finally {
      clearTimeout(timer);
      this.pending.delete(token);
      this.kwin("unloadScript", "s", [plugin]).catch(() => {});
      unlink(file).catch(() => {});
    }
  }

  private snapshot(): Promise<KWinSnapshot> {
    if (this.cache && Date.now() - this.cache.at < 150) return this.cache.snap;
    const snap = this.query("snapshot").then(parseKWinSnapshot);
    this.cache = { at: Date.now(), snap };
    snap.catch(() => { this.cache = null; });
    return snap;
  }

  async problem(): Promise<string | null> {
    if (!(await nameHasOwner("org.kde.KWin"))) return "KWin isn't reachable on the session bus, so VisionCLI can't see your windows.";
    try { await this.snapshot(); return null; } catch (e: any) {
      return `KWin refused VisionCLI's window script (${e?.message ?? e}). Windows and the mouse position aren't available.`;
    }
  }

  async displays(): Promise<Rect[]> {
    return (await this.snapshot()).screens;
  }

  async pointer(): Promise<Point | null> {
    try { return (await this.snapshot()).cursor; } catch { return null; }
  }

  async windows(): Promise<DesktopWindow[]> {
    const own = ownPids();
    try {
      return (await this.snapshot()).windows.filter((w) => keepWindow(w, own)).map(({ active: _, ...w }) => w);
    } catch (e: any) {
      log(`desktop: KWin window list failed: ${e?.message ?? e}`);
      return [];
    }
  }

  async activeWindow(): Promise<DesktopWindow | null> {
    const own = ownPids();
    const all = (await this.snapshot().catch(() => null))?.windows ?? [];
    const w = all.find((w) => w.active && !(w.pid !== undefined && own.has(w.pid))) ?? all.find((w) => keepWindow(w, own));
    if (!w) return null;
    const { active: _, ...rest } = w;
    return rest;
  }

  captureWindow(w: DesktopWindow): Promise<Jpeg> {
    return this.captureRect(w.bounds);
  }

  private async fullScreen(): Promise<Buffer> {
    const file = join(TMP, `visioncli-spectacle-${randomUUID()}.png`);
    try {
      await this.tools.text("spectacle", ["-b", "-n", "-f", "-o", file]);
      const png = await readFile(file);
      if (isPng(png)) return png;
    } catch (e: any) {
      if (e?.code !== "ENOENT") log(`desktop: spectacle failed (${e?.message ?? e}); using the portal`);
    } finally {
      unlink(file).catch(() => {});
    }
    return this.shot();
  }

  async captureRect(r: Rect): Promise<Jpeg> {
    const png = await this.fullScreen();
    const screens = await this.displays().catch(() => [] as Rect[]);
    const layout = screens.length ? union(screens) : { x: 0, y: 0, ...pngSize(png) };
    return this.encode(png, cropFor(r, layout, pngSize(png)));
  }

  async focus(w: DesktopWindow): Promise<void> {
    this.cache = null;
    const res = JSON.parse(await this.query("activate", w.id));
    if (!res.ok) throw new Error(`Window ${w.title || w.app} is gone.`);
  }
}
