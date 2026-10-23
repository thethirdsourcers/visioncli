import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import * as browser from "../browser.js";
import { CdpTabs } from "../browser-cdp.js";
import { CDP, SETUP_HELP, wsUrl } from "../cdp.js";
import { CONFIG_DIR } from "../config.js";
import { apiKey, type Answer } from "../quick.js";
import { type AgentEvent, type Driver, type Jev, runTask, StalePage } from "./agent.js";

// browserd: one long-lived process that holds the DevTools connection to the user's browser, so Chrome's
// "Allow remote debugging?" prompt is answered once, not per voice command. `visioncli browse <goal>` connects over a
// Unix socket (starting browserd if needed), sends the goal and streams the agent's steps back as JSON lines.
// Closing the client socket (Esc in the app kills it) stops the task. browserd exits after 30 idle minutes.
// Without AppleScript (Linux), browser.ts sends every tab/page call here too ({rpc, args} → one reply line).

/** Unix socket in the config dir; Windows has no Unix socket paths for this, so a per-user named pipe there. */
export function socketPath(platform: NodeJS.Platform = process.platform, configDir = CONFIG_DIR, user = safeUser()): string {
  return platform === "win32" ? `\\\\.\\pipe\\visioncli-browserd-${user.replace(/[^\w.-]/g, "_")}` : join(configDir, "browserd.sock");
}
function safeUser() {
  try { return userInfo().username; } catch { return process.env.USERNAME ?? "user"; }
}
export const SOCKET = socketPath();
const PIPE = process.platform === "win32"; // named pipes vanish with their server: nothing to probe or unlink
const IDLE_MS = 30 * 60_000;

export type BrowseEvent = AgentEvent | { type: "status"; message: string };

const jevClient = (key: string): Jev => async (state, questions) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: AbortSignal.timeout(10_000),
    });
    if ([429, 503, 529].includes(res.status) && attempt < 2) { await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).answers as Record<string, Answer>;
  }
};

/** A Driver over one attached tab (flat CDP session). */
export function cdpDriver(cdp: CDP, sessionId: string): Driver {
  const send = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
  return {
    async evaluate(expression, awaitPromise = false) {
      let r: any;
      try {
        r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
      } catch (err) {
        // The document went away mid-call (navigation): the caller observes again.
        if (/context|navigat|destroyed|detached/i.test((err as Error).message)) throw new StalePage((err as Error).message);
        throw err;
      }
      if (r.exceptionDetails) throw new StalePage("The document changed during evaluation.");
      return r.result?.value;
    },
    async click(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    },
    async replaceText(text) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
      await send("Input.insertText", { text });
    },
    async wheel(deltaY) {
      const [x, y] = (await this.evaluate<[number, number]>("[innerWidth / 2, innerHeight / 2]")) ?? [400, 400];
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    },
  };
}

/** The tab the user is looking at, as a CDP target: matched by URL (then title) to the browser's active tab. */
export async function activeTarget(cdp: CDP, b: browser.BrowserName, tabs?: CdpTabs): Promise<string> {
  if (tabs) {
    const t = await tabs.activeTarget();
    if (!t) throw new Error("No active browser tab.");
    return t.targetId;
  }
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  const active = await browser.activeTab(b).catch(() => undefined);
  const match = active && (
    pages.find((p) => p.url === active.url) ??
    pages.find((p) => browser.sameUrl(p.url, active.url)) ??
    pages.find((p) => p.title === active.title));
  if (!match) throw new Error(active ? "Couldn't find the active tab over DevTools." : "No active browser tab.");
  return match.targetId;
}

export async function serve() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (!PIPE && existsSync(SOCKET)) {
    // Another browserd answering? Then this one isn't needed.
    const alive = await new Promise<boolean>((r) => {
      const s = createConnection(SOCKET, () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (alive) return;
    try { unlinkSync(SOCKET); } catch {}
  }

  let cdp: CDP | undefined;
  let cdpTabs: CdpTabs | undefined;
  let cdpBrowser = "";
  let running: AbortController | undefined;
  let idle: NodeJS.Timeout | undefined;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => { cdp?.close(); process.exit(0); }, IDLE_MS); };
  touch();

  async function connect(b: browser.BrowserName, emit: (e: BrowseEvent) => void): Promise<CDP> {
    if (cdp && !cdp.closed && cdpBrowser === b) return cdp;
    cdp?.close();
    const url = wsUrl(b);
    if (!url) throw new Error(`Remote debugging is off in ${b}. ${SETUP_HELP}`);
    emit({ type: "status", message: `Connecting to ${b}… click Allow if it asks about remote debugging.` });
    cdp = await CDP.connect(url, 60_000);
    cdpTabs = new CdpTabs(cdp);
    cdpBrowser = b;
    return cdp;
  }

  /** Loads `url` in tab `id`, or the active tab (a new one if there's none). */
  async function load(t: CdpTabs, id: string, url: string) {
    const target = id ? await t.resolve(id) : (await t.activeTarget())?.targetId;
    if (target) await t.load(target, url);
    else await t.create(url);
  }

  /** One browser.ts call (tabs, switch, open, load, navigate, js) on the held connection. */
  async function rpc(sock: Socket, req: { rpc: string; browser: browser.BrowserName; args?: unknown[] }) {
    try {
      await connect(req.browser, () => {});
      const t = cdpTabs!;
      const a = (req.args ?? []) as any[];
      const result =
        req.rpc === "tabs" ? (await t.tabs()).map(({ targetId: _, ...tab }) => tab) :
        req.rpc === "switch" ? await t.switchTo(a[0]) :
        req.rpc === "create" ? await t.create(a[0]) :
        req.rpc === "load" ? await load(t, a[0], a[1]) :
        req.rpc === "targets" ? (await t.pages()).map((p) => p.targetId) :
        req.rpc === "navigate" ? await t.navigate(a[0]) :
        req.rpc === "js" ? await t.js(a[0]) :
        req.rpc === "files" ? await t.setFiles(a[0], a[1]) :
        (() => { throw new Error(`Unknown browser call ${req.rpc}`); })();
      sock.end(JSON.stringify({ ok: true, result: result ?? null }) + "\n");
    } catch (err) {
      sock.end(JSON.stringify({ ok: false, error: (err as Error).message }) + "\n");
    } finally {
      touch();
    }
  }

  async function handle(sock: Socket, goal: string) {
    running?.abort();
    const ctl = new AbortController();
    running = ctl;
    sock.on("close", () => ctl.abort());
    const emit = (e: BrowseEvent) => { if (!sock.destroyed) sock.write(JSON.stringify(e) + "\n"); };
    let sessionId: string | undefined;
    let c: CDP | undefined;
    try {
      const key = apiKey();
      if (!key) throw new Error("No TypeSafe API key.");
      const { browser: b } = await browser.pickWithFront();
      c = await connect(b, emit);
      const targetId = await activeTarget(c, b, browser.APPLESCRIPT ? undefined : cdpTabs);
      ({ sessionId } = await c.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
      await runTask(goal, cdpDriver(c, sessionId!), jevClient(key), emit, ctl.signal);
    } catch (err) {
      emit({ type: "end", status: "error", message: (err as Error).message, steps: 0, ms: 0, decisions: 0 });
    } finally {
      if (sessionId && c && !c.closed) c.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      if (running === ctl) running = undefined;
      touch();
      sock.end();
    }
  }

  const server = createServer((sock) => {
    touch();
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = "";
      let goal = "";
      let req: any;
      try { req = JSON.parse(line); goal = String(req.goal ?? "").trim(); } catch {}
      if (req?.rpc) { void rpc(sock, req); return; }
      if (!goal) { sock.end(JSON.stringify({ type: "end", status: "error", message: "No goal.", steps: 0, ms: 0, decisions: 0 }) + "\n"); return; }
      void handle(sock, goal);
    });
    sock.on("error", () => {});
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(SOCKET, resolve); });
  } catch (err) {
    if (PIPE && (err as NodeJS.ErrnoException).code === "EADDRINUSE") return; // another browserd holds the pipe
    throw err;
  }
  const cleanup = () => { if (!PIPE) try { unlinkSync(SOCKET); } catch {} process.exit(0); };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  await new Promise(() => {}); // serve until idle
}

function dial(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(SOCKET, () => resolve(s));
    s.once("error", reject);
  });
}

/** The connection to browserd, starting it if it isn't running. */
async function connectDaemon(): Promise<Socket> {
  try {
    return await dial();
  } catch {
    // Inside the desktop app the server is its Electron in Node mode, which needs ELECTRON_RUN_AS_NODE to stay
    // Node (the wrapper removed it from the environment); windowsHide: no console window for a detached node.exe.
    const env = process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
    const child = spawn(process.execPath, [process.argv[1], "browserd"], { detached: true, stdio: "ignore", env, windowsHide: true });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = await dial().catch(() => undefined);
      if (s) return s;
    }
    throw new Error("Couldn't start the browser agent.");
  }
}

/** One browser call through browserd (the non-AppleScript backend of browser.ts). */
export async function call<T>(browserName: string, rpc: string, ...args: unknown[]): Promise<T> {
  const s = await connectDaemon();
  return new Promise((resolve, reject) => {
    let buf = "";
    s.on("data", (d) => { buf += d; });
    s.on("close", () => {
      try {
        const r = JSON.parse(buf.split("\n")[0]);
        if (r.ok) resolve(r.result as T);
        else reject(new Error(r.error));
      } catch {
        reject(new Error("The browser connection closed unexpectedly."));
      }
    });
    s.on("error", (e) => reject(e));
    s.write(JSON.stringify({ rpc, browser: browserName, args }) + "\n");
  });
}

/** Run a browser task through browserd (started on demand), calling `onEvent` for each step; resolves at the end. */
export async function browse(goal: string, onEvent: (e: BrowseEvent) => void): Promise<BrowseEvent | undefined> {
  const s = await connectDaemon();
  return new Promise((resolve) => {
    let last: BrowseEvent | undefined;
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try { last = JSON.parse(line); onEvent(last!); } catch {}
      }
    });
    s.on("close", () => resolve(last));
    s.on("error", () => resolve(last));
    s.write(JSON.stringify({ goal }) + "\n");
  });
}
