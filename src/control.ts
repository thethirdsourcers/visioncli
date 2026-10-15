import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

// Computer control goes through VisionCLI.app, which holds the Accessibility permission. It listens on 127.0.0.1
// with a per-launch token written to control.json (readable only by the user).

const SUPPORT = CONFIG_DIR;

/** Where the last screenshot sits on screen (top-left global points), to turn image pixels into screen points. */
export interface ShotMap {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
}

// Concurrent looks: the one started last wins, not the one that happened to finish last.
let lastLook: ShotMap | null = null;
let lookSeq = 0;
let lastLookSeq = 0;
/** Call when a screenshot starts; pass the number to rememberLook. */
export const beginLook = () => ++lookSeq;
export const rememberLook = (m: ShotMap, seq = ++lookSeq) => {
  if (seq < lastLookSeq) return;
  lastLookSeq = seq;
  lastLook = m;
};

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

/**
 * The app's control protocol (overlay/Sources/Control.swift), one request shape per action, so a misspelled action or
 * field fails the typecheck. Fields are snake_case/short as the app reads them.
 */
export interface ControlRequests {
  status: {};
  displays: { windows?: boolean };
  announce: { text: string };
  capture: { window_id: number } | Rect; // a window, or an area in top-left points (e.g. a whole display)
  elements: { app?: string };
  click: { element?: number; x?: number; y?: number; button?: "left" | "right"; count?: number };
  type: { text: string; element?: number; replace?: boolean; app?: string };
  key: { keys: string; app?: string };
  scroll: { x?: number; y?: number; dx?: number; dy?: number };
  drag: { x1: number; y1: number; x2: number; y2: number };
  open_app: { name: string };
  focus_app: { name: string };
  open_url: { url: string };
}
export type ControlAction = keyof ControlRequests;
export type ControlRequest<A extends ControlAction = ControlAction> = { [K in A]: { action: K } & ControlRequests[K] }[A];

/** An on-screen window as the app reports it (front-most first). */
export interface AppWindow { id: number; app: string; title: string; pid?: number; bounds: Rect }
/** An Accessibility element from `elements`: center and size in screen points. */
export interface UIElement { id: number; role: string; label: string; x: number; y: number; w: number; h: number }
/** What the app replies to an action it performed (after approval). */
export interface ActionDone { ok: true; done: string; frontApp: string }

export interface ControlResponses {
  status: { trusted: boolean; mode: string; frontApp: string; stopped: boolean };
  displays: { displays: Rect[]; pointer?: Point; windows?: AppWindow[] };
  announce: { ok: true };
  capture: { data?: string; width?: number; height?: number };
  elements: { app: string; elements: UIElement[] };
  click: ActionDone;
  type: ActionDone;
  key: ActionDone;
  scroll: ActionDone;
  drag: ActionDone;
  open_app: ActionDone;
  focus_app: ActionDone;
  open_url: ActionDone;
}

// Answered instantly by the app (no approval), so a short timeout; anything else may wait for the user to approve.
// A Record over every action, so a new action has to pick its timeout here.
const APPROVAL_TIMEOUT = 5 * 60_000;
const TIMEOUTS: Record<ControlAction, number> = {
  status: 3000,
  displays: 3000,
  announce: 3000,
  capture: 5000,
  elements: 8000,
  click: APPROVAL_TIMEOUT,
  type: APPROVAL_TIMEOUT,
  key: APPROVAL_TIMEOUT,
  scroll: APPROVAL_TIMEOUT,
  drag: APPROVAL_TIMEOUT,
  open_app: APPROVAL_TIMEOUT,
  focus_app: APPROVAL_TIMEOUT,
  open_url: APPROVAL_TIMEOUT,
};

/** Every action the app understands (kept equal to Swift's ControlAction by a test). */
export const CONTROL_ACTIONS = Object.keys(TIMEOUTS) as ControlAction[];

/** How long to wait for the app's reply (unknown actions, e.g. from the CLI debug path, may need approval). */
export const timeoutFor = (action: string): number => TIMEOUTS[action as ControlAction] ?? APPROVAL_TIMEOUT;

// control.json is re-read only when the app restarted (new port/token): connection refused or a bad token.
let info: { port: number; token: string } | null = null;
function readInfo() {
  try {
    info = JSON.parse(readFileSync(join(SUPPORT, "control.json"), "utf8"));
  } catch {
    info = null;
    throw new Error("VisionCLI isn't running. Start it with `visioncli voice` (or the start_voice tool), then try again.");
  }
  return info!;
}

class Stale extends Error {}

function post(conn: { port: number; token: string }, body: string, timeout: number) {
  return new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: conn.port,
        method: "POST",
        path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-VisionCLI-Token": conn.token },
        timeout,
      },
      (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => (r.statusCode === 401 || r.statusCode === 403 ? reject(new Stale()) : resolve(data)));
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) =>
      reject(err instanceof Stale ? err : err?.code === "ECONNREFUSED" ? new Stale() :
        new Error(/answer/.test(err?.message ?? "") ? err.message : "Couldn't reach VisionCLI. Is it running? Start it with `visioncli voice`.")));
    req.on("timeout", () =>
      req.destroy(new Error(timeout >= APPROVAL_TIMEOUT ? "VisionCLI didn't answer (the approval may have timed out)." : "VisionCLI didn't answer in time.")));
    req.end(body);
  });
}

/** One request to the app; its `{ error }` replies become thrown errors. */
export async function send<A extends ControlAction>(req: ControlRequest<A>): Promise<ControlResponses[A]> {
  if (!["darwin", "linux", "win32"].includes(process.platform)) throw new Error("Computer control is only supported on macOS, Linux and Windows.");
  const body = JSON.stringify(req);
  const timeout = timeoutFor(req.action);
  let res: string;
  try {
    res = await post(info ?? readInfo(), body, timeout);
  } catch (err) {
    if (!(err instanceof Stale)) throw err;
    try {
      res = await post(readInfo(), body, timeout); // the app restarted since we cached its port/token
    } catch (err2) {
      if (err2 instanceof Stale) throw new Error("Couldn't reach VisionCLI. Is it running? Start it with `visioncli voice`.");
      throw err2;
    }
  }
  const out = JSON.parse(res || "{}");
  if (out.error) throw new Error(out.error);
  return out;
}

/**
 * Turn coordinates into screen points.
 * - `image` N: pixel coordinates in the N-th screenshot attached to the current voice question.
 * - otherwise: pixel coordinates in the last `look` screenshot (falls back to screen points if there is none).
 * - `screen: true`: already screen points (e.g. from ui_elements).
 */
export function toScreen(x: number, y: number, opts: { image?: number; screen?: boolean }): { x: number; y: number } {
  if (opts.screen) return { x, y };
  let m: ShotMap | null = lastLook;
  if (opts.image) {
    m = null; // never fall back to the last look: its pixels are a different image
    try {
      const shots: ShotMap[] = JSON.parse(readFileSync(join(SUPPORT, "shots.json"), "utf8")).shots;
      m = shots[opts.image - 1] ?? null;
    } catch {}
    if (!m) throw new Error(`There's no attached image ${opts.image}. Take a new screenshot with look.`);
  }
  if (!m) return { x, y };
  return {
    x: Math.round(m.x + (x * m.width) / m.imageWidth),
    y: Math.round(m.y + (y * m.height) / m.imageHeight),
  };
}

/**
 * Displays (top-left points) and the mouse position, from the running app; null if it isn't running.
 * `windows: true` also asks for the on-screen windows (newer app versions; older ones just leave them out).
 */
export async function displaysAndPointer(opts: { windows?: boolean } = {}): Promise<ControlResponses["displays"] | null> {
  try {
    return await send(opts.windows ? { action: "displays", windows: true } : { action: "displays" });
  } catch {
    return null;
  }
}

/** The display (1-based) containing p, or undefined. */
export function displayAt(displays: Rect[], p?: { x: number; y: number }): number | undefined {
  if (!p) return undefined;
  const i = displays.findIndex((b) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height);
  return i >= 0 ? i + 1 : undefined;
}

/** The display (1-based) the mouse is on, or undefined if unknown. */
export async function pointerDisplay(): Promise<number | undefined> {
  const d = await displaysAndPointer();
  return d ? displayAt(d.displays, d.pointer) : undefined;
}

/** Screen bounds (top-left points) of display N (1 = main), for mapping whole-screen screenshots. */
export async function displayBounds(display = 1): Promise<Rect | null> {
  const d = await displaysAndPointer();
  return d?.displays[display - 1] ?? null;
}
