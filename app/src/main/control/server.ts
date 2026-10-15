import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { Accessibility, Apps, Desktop, DesktopWindow, InputInjector, PermissionAnswer, Point, Rect, TaskStep, UIElement } from "../contracts";
import { log } from "../log";
import { SUP } from "../paths";
import { settings } from "../settings";
import {
  READ_ONLY, browserGuardMessage, capitalize, describeAction, isBrowserApp, isBrowserNavShortcut, isControlAction, isSensitiveApp,
  normalizeUrl, usesKeyboard,
} from "./actions";

// Computer control: VisionCLI performs mouse/keyboard/app actions for the AI. The MCP server (src/control.ts) sends
// actions over a localhost-only HTTP connection authenticated with a per-launch token, written to SUP/control.json
// (mode 0600). Port of ControlServer + the AppDelegate control extension in overlay/Sources/Control.swift.

export type Reply = Record<string, unknown>;
type Req = Record<string, unknown>;

/** The approval card's content; the orchestrator shows it (bubble in the approval phase). */
export interface ApprovalCard {
  title: string;                 // "Claude wants to click "Save" button in gedit"
  what: string;
  sensitive: boolean;
  /** Lines under the title: typed text (added), the sensitive warning (removed), the Esc hint (context). */
  detail: { text: string; kind: "added" | "removed" | "context" }[];
  request: Req;
}

/** The task panel (Tasks.swift TaskHUD): a step per action. */
export interface ControlTasks {
  begin(text: string, waiting?: boolean): string;
  update(id: string, state: TaskStep["state"]): void;
  readonly paused: boolean;
}

export interface ControlDeps {
  desktop: Desktop;
  input: InputInjector;
  ax: Accessibility;
  apps: Apps;
  /** Shows the card and resolves with the user's answer ("allowAll" = allow for 15 minutes). Aborted on an Esc stop:
   *  hide the card then (the server already counts it as declined). One card at a time; the server queues the rest. */
  approve(card: ApprovalCard, signal: AbortSignal): Promise<PermissionAnswer>;
  mode?(): "ask" | "auto" | "off";
  assistantName?(): string;
  announce?(text: string): void;
  tasks?: ControlTasks;
  /** The step being performed ("Click "Save" button in gedit…"): bubble status / toast / badge. */
  onStatus?(text: string): void;
  /** Short activity note for the badge ("Taking a screenshot of Firefox"). */
  onActivity?(text: string): void;
  /** After an Esc stop: flash "Stopped. The assistant won't touch your computer again until your next question." */
  onStopped?(): void;
  /** Esc = stop while the assistant is acting (Hotkeys.setOverlayKeys). */
  setStopKey?(on: boolean): void;
  /** The bubble is hidden (Esc can be released after 31 s of no actions). */
  isIdle?(): boolean;
  /** Why mouse/keyboard input can't be injected (e.g. needs the `input` group), or null. */
  inputProblem?(): Promise<string | null>;
  /** Defaults: SUP/control.json and SUP/shots.json. */
  infoFile?: string;
  shotsFile?: string;
}

export interface ShotInfo { screenRect: Rect; pixelSize: { width: number; height: number }; label: string }

export interface ControlServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  readonly port: number;
  /** True while the AI is in the middle of using the computer (Esc then stops it). */
  readonly active: boolean;
  /** Esc: decline the pending card, drop queued/held actions, refuse new ones for 120 s. */
  stopComputerControl(): void;
  /** The task panel's Resume: run the actions held while paused. */
  resume(): void;
  /** A new question re-enables control after an Esc stop. */
  newQuestion(): void;
  /** Where each attached screenshot sits on screen, so the MCP server can turn image pixels into clicks. */
  writeShotMap(shots: ShotInfo[]): void;
  /** One request, as the HTTP handler runs it (exposed for tests and the debug path). */
  handle(request: Req): Promise<Reply>;
}

const ALLOW_ALL_MS = 15 * 60_000;
const STOP_REFUSAL_MS = 120_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const assistantNames: Record<string, string> = { claude: "Claude", antigravity: "Gemini", gemini: "Gemini" };

export function createControlServer(deps: ControlDeps): ControlServer {
  const token = randomBytes(36).toString("hex");
  const infoFile = deps.infoFile ?? join(SUP, "control.json");
  const shotsFile = deps.shotsFile ?? join(SUP, "shots.json");
  const mode = () => deps.mode?.() ?? settings.get("computerControl");
  const assistantName = () => deps.assistantName?.() ?? assistantNames[settings.get("assistant")] ?? "Claude";

  let server: Server | null = null;
  let port = 0;
  let controlStopped: number | null = null;
  let controlLastAction = 0;
  let controlAllowUntil = 0;
  /** The window keys and typing go to (the app the assistant works in). */
  let controlTarget: DesktopWindow | null = null;
  /** The last `elements` listing: ids → element, and the window they belong to. */
  let elements = new Map<number, UIElement>();
  let elementsWindow: DesktopWindow | null = null;
  let pending: { done: (ok: boolean) => void; abort: AbortController } | null = null;
  let approvalQueue: { go: () => void; done: (ok: boolean) => void }[] = [];
  let pausedActions: ((go: boolean) => void)[] = [];
  let escTimer: NodeJS.Timeout | null = null;

  // Window ids in the protocol are numbers; X11 ids already are, compositor ids get a stable number per launch.
  const idNumbers = new Map<string, number>();
  const idOf = (w: DesktopWindow) => {
    const n = Number(w.id);
    if (Number.isSafeInteger(n) && n >= 0) return n;
    if (!idNumbers.has(w.id)) idNumbers.set(w.id, 0x7000_0000 + idNumbers.size);
    return idNumbers.get(w.id)!;
  };

  const active = () => Date.now() - controlLastAction < 30_000 || pending != null;

  async function windowForApp(name: string): Promise<DesktopWindow | null> {
    const q = name.toLowerCase();
    const wins = await deps.desktop.windows().catch(() => [] as DesktopWindow[]);
    return wins.find((w) => w.app.toLowerCase() === q || w.appId.toLowerCase() === q)
      ?? wins.find((w) => w.app.toLowerCase().includes(q) || w.appId.toLowerCase().includes(q)) ?? null;
  }

  async function stillOpen(w: DesktopWindow | null): Promise<DesktopWindow | null> {
    if (!w) return null;
    const wins = await deps.desktop.windows().catch(() => [] as DesktopWindow[]);
    return wins.find((x) => x.id === w.id) ?? null;
  }

  const frontApp = async () => (await deps.desktop.activeWindow().catch(() => null))?.app ?? "";

  function elementLabel(id: number): string {
    const e = elements.get(id);
    if (!e) return `element ${id}`;
    const role = e.role.toLowerCase();
    return e.label && e.label !== "(password field)" ? `"${[...e.label].slice(0, 40).join("")}" ${role}` : role;
  }

  // ── Read-only requests and target resolution (handleControl) ──────────────────────────────────────────────────

  async function handle(r: Req): Promise<Reply> {
    const action = typeof r.action === "string" ? r.action : "";
    const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
    const point = (): Point | null => {
      const x = num("x"), y = num("y");
      return x != null && y != null ? { x, y } : null;
    };

    switch (action) {
      case "announce":
        // The assistant reporting back later on its own (background work done): bubble + speech.
        deps.announce?.(typeof r.text === "string" ? r.text : "");
        return { ok: true };
      case "status":
        return { trusted: (await deps.inputProblem?.()) == null, mode: mode(), frontApp: await frontApp(), stopped: controlStopped != null };
      case "displays": {
        const [displays, pointer] = await Promise.all([deps.desktop.displays(), deps.desktop.pointer().catch(() => null)]);
        const out: Reply = { displays: displays.map((d) => ({ x: d.x, y: d.y, width: d.width, height: d.height })) };
        if (pointer) out.pointer = { x: pointer.x, y: pointer.y };
        // `look` asks for the window list here too, front-most first.
        if (r.windows === true) {
          out.windows = (await deps.desktop.windows()).map((w) => ({
            id: idOf(w), app: w.app, title: w.title, pid: w.pid ?? 0,
            bounds: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height },
          }));
        }
        return out;
      }
      case "capture": {
        // A window by id, or x/y/width/height (e.g. a whole display).
        const windowId = num("window_id");
        const window = windowId != null ? (await deps.desktop.windows()).find((w) => idOf(w) === windowId) ?? null : null;
        deps.onActivity?.(`Taking a screenshot of ${window?.app ?? "the screen"}`);
        try {
          let jpeg;
          if (windowId != null) {
            if (!window) return { error: "capture unavailable" };
            jpeg = await deps.desktop.captureWindow(window);
          } else if (num("width") != null) {
            jpeg = await deps.desktop.captureRect({ x: num("x") ?? 0, y: num("y") ?? 0, width: num("width")!, height: num("height") ?? 0 });
          } else {
            return { error: "capture unavailable" };
          }
          return { data: jpeg.data.toString("base64"), width: jpeg.width, height: jpeg.height };
        } catch (e) {
          log(`control: capture failed: ${(e as Error)?.message ?? e}`);
          return { error: "capture unavailable" };
        }
      }
      case "elements": {
        if (!(await deps.ax.available().catch(() => false))) return needAccessibility();
        const res = await deps.ax.elements(typeof r.app === "string" && r.app ? r.app : undefined);
        elements = new Map(res.elements.map((e) => [e.id, e]));
        elementsWindow = res.app ? await windowForApp(res.app) : null;
        if (elementsWindow) controlTarget = elementsWindow;
        return { app: res.app, elements: res.elements.map((e) => ({ id: e.id, role: e.role, label: e.label, x: e.x, y: e.y, w: e.w, h: e.h })) };
      }
    }

    if (mode() === "off") {
      return { error: "Computer control is turned off in VisionCLI (VisionCLI menu → Settings… → Computer Control). Ask the user to turn it on." };
    }
    const problem = await deps.inputProblem?.();
    if (problem) return { error: problem };

    // Resolve the target (accessibility calls into other apps can be slow), then decide.
    const element = num("element") ?? null;
    let target = point();
    if (element != null) {
      const e = elements.get(element);
      target = e ? { x: e.x, y: e.y } : null;
    }
    const elementApp = element != null ? elementsWindow : null;
    const label = element != null ? elementLabel(element) : null;
    const secure = async () => {
      const isSecure = (t: Parameters<Accessibility["isSecure"]>[0]) => deps.ax.isSecure(t).catch(() => false);
      if (element != null && (elements.get(element)?.label === "(password field)" || await isSecure({ id: element }))) return true;
      if (action === "type" && await isSecure({ focused: true })) return true;
      return target ? isSecure({ at: target }) : false;
    };
    const secureTarget = await secure();
    return decide(action, r, target, element, elementApp, label, secureTarget);
  }

  // ── Refuse after Esc, describe, ask, run (decideControl) ──────────────────────────────────────────────────────

  async function decide(action: string, r: Req, target: Point | null, element: number | null, elementApp: DesktopWindow | null,
                        label: string | null, secureTarget: boolean): Promise<Reply> {
    if (controlStopped != null && Date.now() - controlStopped < STOP_REFUSAL_MS) {
      return { error: "The user pressed Esc to stop you using the computer. Stop and ask them how to continue." };
    }
    controlStopped = null;

    // Keys and typing go to the app the assistant is working in (an accessibility press doesn't bring it forward,
    // so otherwise they'd land in whatever is in front, e.g. the terminal).
    const keyboard = usesKeyboard(action);
    if (keyboard) {
      if (typeof r.app === "string" && r.app) controlTarget = (await windowForApp(r.app)) ?? controlTarget;
      if (element != null && elementApp) controlTarget = elementApp;
    }
    const keyboardTarget = keyboard ? await stillOpen(controlTarget) : null;
    const app = keyboardTarget ?? (await deps.desktop.activeWindow().catch(() => null));

    if (action === "key" && isBrowserApp(app) && typeof r.keys === "string" && isBrowserNavShortcut(r.keys)) {
      return { error: browserGuardMessage(app?.app || "the browser") };
    }
    const appName = app?.app || "the front app";
    const what = describeAction(action, r, { appName, elementLabel: label, target, element });
    const sensitive = isSensitiveApp(app) || secureTarget;
    const allowed = mode() === "auto" || Date.now() < controlAllowUntil;
    const stepLabel = capitalize(what);

    const run = async (): Promise<Reply> => {
      // Paused from the task panel: hold the action until Resume (or drop it on Stop).
      if (deps.tasks?.paused) {
        return new Promise<Reply>((resolve) => pausedActions.push((go) =>
          resolve(go ? run() : { error: "The user stopped the task. Stop and ask them how to continue." })));
      }
      controlLastAction = Date.now();
      deps.setStopKey?.(true); // Esc = stop, while the assistant is acting
      const step = deps.tasks?.begin(stepLabel);
      log(`control: ${stepLabel}…`);
      deps.onStatus?.(stepLabel + "…");
      // Our own Esc hotkey would swallow a synthetic Escape.
      const isEsc = action === "key" && String(r.keys ?? "").toLowerCase().includes("esc");
      if (isEsc) deps.setStopKey?.(false);
      if (keyboardTarget) {
        const front = await deps.desktop.activeWindow().catch(() => null);
        if (front?.id !== keyboardTarget.id) {
          await deps.desktop.focus(keyboardTarget).catch(() => {});
          for (let i = 0; i < 20 && (await deps.desktop.activeWindow().catch(() => null))?.id !== keyboardTarget.id; i++) await sleep(50);
          await sleep(150);
        }
      }
      const error = await perform(action, r, target, element);
      if (!error && (action === "open_app" || action === "focus_app") && typeof r.name === "string") {
        controlTarget = await windowForApp(r.name);
      }
      if (isEsc) setTimeout(() => deps.setStopKey?.(true), 300);
      controlLastAction = Date.now();
      await sleep(350); // let the UI react before the next look
      if (step != null) deps.tasks?.update(step, error == null ? "done" : "failed");
      releaseEscIfIdle();
      return error != null ? { error } : { ok: true, done: what, frontApp: await frontApp() };
    };

    if (allowed && !sensitive) return run();
    const waiting = deps.tasks?.begin(`Waiting for you: ${stepLabel}`, true);
    const ok = await askApproval(what, sensitive, r);
    if (waiting != null) deps.tasks?.update(waiting, ok ? "done" : "declined");
    return ok ? run() : { error: `The user declined: ${what}. Don't retry it; ask what they'd like instead.` };
  }

  function needAccessibility(): Reply {
    return { error: "VisionCLI can't read app controls: the accessibility bus (AT-SPI) isn't available. The user should turn on accessibility (GNOME: `gsettings set org.gnome.desktop.interface toolkit-accessibility true`; KDE/others: make sure at-spi2-core is installed), restart the app, then try again. Meanwhile use look + click at x/y." };
  }

  // ── The action itself (perform) ───────────────────────────────────────────────────────────────────────────────

  async function perform(action: string, r: Req, target: Point | null, element: number | null): Promise<string | null> {
    if (!isControlAction(action) || READ_ONLY.has(action)) return `Unknown action ${action}.`;
    const num = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
    try {
      switch (action) {
        case "click": {
          const button = r.button === "right" ? "right" : "left";
          const count = Math.trunc(num("count") ?? 1);
          // Prefer pressing the element through accessibility (exact, no mouse needed); fall back to a real click.
          if (element != null && button === "left" && count === 1 && elements.has(element) && await deps.ax.press(element).catch(() => false)) return null;
          if (!target) return element != null ? "That element is gone; call ui_elements again." : "Missing x/y or element.";
          await deps.input.click(target, button, Math.max(1, count));
          return null;
        }
        case "type": {
          if (typeof r.text !== "string") return "Missing text.";
          if (element != null) {
            if (r.replace === true && elements.has(element) && await deps.ax.setValue(element, r.text).catch(() => false)) return null;
            const e = elements.get(element);
            if (e) { await deps.input.click({ x: e.x, y: e.y }, "left", 1); await sleep(120); }
          }
          await deps.input.type(r.text);
          return null;
        }
        case "key": {
          if (typeof r.keys !== "string") return "Missing keys.";
          for (const combo of r.keys.split(" ").filter(Boolean)) {
            try { await deps.input.key(combo); } catch (e) { return (e as Error)?.message || `Unknown key "${combo}"`; }
            await sleep(60);
          }
          return null;
        }
        case "scroll":
          await deps.input.scroll(Math.trunc(num("dx") ?? 0), Math.trunc(num("dy") ?? -5), target ?? undefined);
          return null;
        case "drag": {
          const x1 = num("x1"), y1 = num("y1"), x2 = num("x2"), y2 = num("y2");
          if (x1 == null || y1 == null || x2 == null || y2 == null) return "Missing x1/y1/x2/y2.";
          await deps.input.drag({ x: x1, y: y1 }, { x: x2, y: y2 });
          return null;
        }
        case "open_app":
        case "focus_app": {
          if (typeof r.name !== "string") return "Missing name.";
          try {
            await (action === "open_app" ? deps.apps.open(r.name) : deps.apps.focus(r.name));
          } catch (e) {
            return `Couldn't open ${r.name}: ${String((e as Error)?.message ?? e).trim()}`;
          }
          return null;
        }
        case "open_url": {
          if (typeof r.url !== "string") return "Missing url.";
          const url = normalizeUrl(r.url);
          if (!url) return "Bad URL";
          await deps.apps.openUrl(url);
          return null;
        }
      }
    } catch (e) {
      return String((e as Error)?.message ?? e);
    }
    return `Unknown action ${action}.`;
  }

  // ── Approvals (askApproval / finishControlApproval) ───────────────────────────────────────────────────────────

  function askApproval(what: string, sensitive: boolean, request: Req): Promise<boolean> {
    return new Promise((done) => {
      const go = () => {
        controlLastAction = Date.now();
        const detail: ApprovalCard["detail"] = [];
        if (typeof request.text === "string") detail.push(...request.text.split("\n").slice(0, 6).map((text) => ({ text, kind: "added" as const })));
        if (sensitive) detail.push({ text: "Sensitive: passwords, payments or system settings. Check carefully.", kind: "removed" });
        detail.push({ text: "Esc stops the assistant from using your computer.", kind: "context" });
        const abort = new AbortController();
        const me = { done, abort };
        pending = me;
        const finish = (answer: PermissionAnswer) => {
          if (pending !== me) return; // stopped meanwhile: already declined
          const allow = answer !== "deny";
          if (allow && answer === "allowAll") controlAllowUntil = Date.now() + ALLOW_ALL_MS;
          pending = null;
          log(`control: ${allow ? "allowed" : "denied"}: ${what}`);
          done(allow);
          const next = approvalQueue.shift();
          if (next) setImmediate(next.go);
        };
        deps.approve({ title: `${assistantName()} wants to ${what}`, what, sensitive, detail, request }, abort.signal)
          .then(finish, () => finish("deny"));
      };
      // One card at a time; later actions wait their turn.
      if (pending) approvalQueue.push({ go, done }); else go();
    });
  }

  function releaseEscIfIdle() {
    if (escTimer) clearTimeout(escTimer);
    escTimer = setTimeout(() => {
      escTimer = null;
      if (!active() && (deps.isIdle?.() ?? true)) deps.setStopKey?.(false);
    }, 31_000);
    escTimer.unref?.();
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────────────────────────────────────────

  function respond(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, obj: Reply) => {
      const json = JSON.stringify(obj);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), Connection: "close" });
      res.end(json);
    };
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1 << 20) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (req.headers["x-visioncli-token"] !== token) { send(403, { error: "bad token" }); return; }
      let request: unknown;
      try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { request = null; }
      if (!request || typeof request !== "object" || Array.isArray(request)) { send(400, { error: "bad json" }); return; }
      handle(request as Req).then((reply) => send(200, reply), (e) => {
        log(`control: ${(request as Req).action}: ${(e as Error)?.stack ?? e}`);
        send(200, { error: String((e as Error)?.message ?? e) });
      });
    });
  }

  return {
    get port() { return port; },
    get active() { return active(); },
    handle,

    start() {
      return new Promise<number>((resolve, reject) => {
        const s = createServer(respond);
        s.on("error", (e) => { log(`control: couldn't start server: ${e}`); reject(e); });
        s.listen(0, "127.0.0.1", () => {
          port = (s.address() as AddressInfo).port;
          try {
            mkdirSync(dirname(infoFile), { recursive: true });
            writeFileSync(infoFile, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
            // The file may have existed with other permissions. Windows has no POSIX modes (chmod only toggles
            // read-only): there the file is private through %APPDATA%'s inherited ACL (the user, SYSTEM, Administrators).
            chmodSync(infoFile, 0o600);
          } catch (e) {
            log(`control: can't write ${infoFile}: ${e}`);
          }
          log(`control: listening on 127.0.0.1:${port}`);
          resolve(port);
        });
        server = s;
      });
    },

    stop() {
      try { rmSync(infoFile, { force: true }); } catch {}
      const s = server;
      server = null;
      if (escTimer) clearTimeout(escTimer);
      return new Promise<void>((resolve) => {
        if (!s) return resolve();
        s.close(() => resolve());
        s.closeAllConnections?.();
      });
    },

    stopComputerControl() {
      controlStopped = Date.now();
      controlLastAction = 0;
      if (pending) {
        const p = pending;
        pending = null;
        p.abort.abort();
        p.done(false);
      }
      // Queued cards and held actions are declined too (their requests get an answer instead of timing out).
      const queued = approvalQueue;
      approvalQueue = [];
      queued.forEach((q) => q.done(false));
      const held = pausedActions;
      pausedActions = [];
      held.forEach((h) => h(false));
      if (deps.tasks) deps.tasks.update(deps.tasks.begin("Stopped by you"), "declined");
      log("control: stopped by Esc");
      deps.onStopped?.();
    },

    resume() {
      const held = pausedActions;
      pausedActions = [];
      held.forEach((h) => h(true));
    },

    newQuestion() { controlStopped = null; },

    writeShotMap(shots: ShotInfo[]) {
      const list = shots.map((s) => ({
        x: s.screenRect.x, y: s.screenRect.y, width: s.screenRect.width, height: s.screenRect.height,
        imageWidth: s.pixelSize.width, imageHeight: s.pixelSize.height, label: s.label,
      }));
      try {
        mkdirSync(dirname(shotsFile), { recursive: true });
        writeFileSync(shotsFile, JSON.stringify({ shots: list, time: Date.now() / 1000 }));
      } catch (e) {
        log(`control: can't write shots.json: ${e}`);
      }
    },
  };
}
