import type { Accessibility, DesktopWindow, PickedElement, Point, Rect, UIElement } from "../../contracts";
import { log } from "../../log";
import { createUiaAccessibility } from "../uia";
import { ownPids } from "../windows/common";
import { type Bus, Variant, call, connect, getProp, setProp } from "./dbus";

// The front app's UI through AT-SPI2 (UIElements in Control.swift): the same walk limits (depth 30, 350 items, 5000
// nodes, 4 s), press via the Action interface, set text via EditableText, password-field checks.
// Raw calls on the accessibility bus; every per-node call has a short timeout so one hung app can't stall the walk.

const ACC = "org.a11y.atspi.Accessible";
const COMPONENT = "org.a11y.atspi.Component";
const ACTION = "org.a11y.atspi.Action";
const TEXT = "org.a11y.atspi.Text";
const EDITABLE = "org.a11y.atspi.EditableText";
const ROOT: Ref = ["org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root"];
const NULL_PATH = "/org/a11y/atspi/null";
const T = 500; // per-call timeout, like AXUIElementSetMessagingTimeout(…, 0.5)

// Bare text and pictures: point mode climbs from these to the link, button or card around them.
const BARE = new Set(["static", "label", "image", "icon", "unknown", ""]);

// AtspiStateType bits (GetState returns two 32-bit words).
const ACTIVE = 1, FOCUSED = 12, SHOWING = 25, SINGLE_LINE = 26;

type Ref = [string, string]; // (bus name, object path)

/** AT-SPI role names → the macOS AX role names the rest of the app (and the model) already knows. */
export const ROLES: Record<string, string> = {
  "push button": "Button", "toggle button": "Button", "push button menu": "MenuButton", "button": "Button",
  "entry": "TextField", "password text": "TextField", "search box": "SearchField", "text": "TextArea", "editbar": "TextField",
  "check box": "CheckBox", "radio button": "RadioButton", "combo box": "ComboBox", "menu": "MenuButton",
  "menu item": "MenuItem", "check menu item": "MenuItem", "radio menu item": "MenuItem", "link": "Link",
  "page tab": "Tab", "page tab list": "TabGroup", "slider": "Slider", "spin button": "Incrementor", "toggle switch": "Switch",
  "switch": "Switch", "list item": "Row", "table cell": "Cell", "tree item": "Row", "table row": "Row",
  "label": "StaticText", "static": "StaticText", "image": "Image", "icon": "Image", "tool bar": "Toolbar",
};

export const hasState = (words: number[], bit: number) => ((words[bit >> 5] ?? 0) >>> (bit & 31) & 1) === 1;

/** Origin offset for toolkits that report window-relative "screen" coordinates (GTK on Wayland). */
export type LocateWindow = (app: string, title: string, pid?: number) => Promise<Rect | null>;

/** The desktop's idea of the front window, for when no toolkit window claims ACTIVE (it happens on some Wayland setups). */
export type ActiveWindow = () => Promise<{ pid?: number; title?: string } | null>;

interface Node { ref: Ref; role: string; state: number[] }

/** Both options come from the desktop-windows module; without them X11 works fully, Wayland mostly. On Windows: UI
 *  Automation through the helper (it reports screen coordinates and the front window itself, so no options needed). */
export function createAccessibility(opts: { locateWindow?: LocateWindow; activeWindow?: ActiveWindow } = {}): Promise<Accessibility> {
  if (process.platform === "win32") return createUiaAccessibility();
  return Promise.resolve(new Atspi(opts.locateWindow, opts.activeWindow));
}

class Atspi implements Accessibility {
  private bus: Bus | null = null;
  private connecting: Promise<Bus> | null = null;
  private ids = new Map<number, Node>();

  constructor(private locateWindow?: LocateWindow, private activeWindow?: ActiveWindow) {}

  // ── bus ──

  private async a11y(): Promise<Bus> {
    if (this.bus) return this.bus;
    this.connecting ??= (async () => {
      const session = await connect(undefined, 2000);
      try {
        // What AXManualAccessibility does on macOS: Chromium/Electron (and Qt, Firefox) only build their tree when asked.
        await setProp(session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Status", "IsEnabled", new Variant("b", true)).catch(() => {});
        const address = await call<string>(session, { dest: "org.a11y.Bus", path: "/org/a11y/bus", iface: "org.a11y.Bus", member: "GetAddress" }, 2000);
        const bus = await connect(address, 2000);
        bus.on("error", (e: Error) => { log(`atspi: ${e.message}`); this.bus = null; });
        this.bus = bus;
        return bus;
      } finally { try { session.disconnect(); } catch {} }
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private q<R = any>(ref: Ref, iface: string, member: string, signature = "", body: unknown[] = [], ms = T): Promise<R> {
    return call<R>(this.bus!, { dest: ref[0], path: ref[1], iface, member, signature, body }, ms);
  }
  private prop<R = any>(ref: Ref, iface: string, name: string): Promise<R> { return getProp<R>(this.bus!, ref[0], ref[1], iface, name, T); }
  private children(ref: Ref): Promise<Ref[]> { return this.q<Ref[]>(ref, ACC, "GetChildren").catch(() => []); }
  private role(ref: Ref): Promise<string> { return this.q<string>(ref, ACC, "GetRoleName").catch(() => ""); }
  private state(ref: Ref): Promise<number[]> { return this.q<number[]>(ref, ACC, "GetState").catch(() => []); }
  private name(ref: Ref): Promise<string> { return this.prop<string>(ref, ACC, "Name").then((s) => (s ?? "").trim()).catch(() => ""); }
  private async extents(ref: Ref): Promise<Rect | null> {
    try {
      const [x, y, width, height] = await this.q<number[]>(ref, COMPONENT, "GetExtents", "u", [0]); // ATSPI_COORD_TYPE_SCREEN
      return { x, y, width, height };
    } catch { return null; }
  }
  private async text(ref: Ref, max = -1): Promise<string> {
    return this.q<string>(ref, TEXT, "GetText", "ii", [0, max]).catch(() => "");
  }
  private async pid(app: string): Promise<number | undefined> {
    return call<number>(this.bus!, { dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus",
      member: "GetConnectionUnixProcessID", signature: "s", body: [app] }, T).catch(() => undefined);
  }

  // ── finding the window ──

  /** Every app with its windows (one level each), queried in parallel. */
  private async apps(): Promise<{ app: Ref; name: string; windows: Node[] }[]> {
    const apps = await this.q<Ref[]>(ROOT, ACC, "GetChildren", "", [], 2000);
    return Promise.all(apps.map(async (app) => {
      const [name, wins] = await Promise.all([this.name(app), this.children(app)]);
      const windows = await Promise.all(wins.map(async (ref) => ({ ref, role: "", state: await this.state(ref) })));
      return { app, name, windows };
    }));
  }

  /** The active window (state ACTIVE), or the named app's active/first showing window. */
  private async target(appName?: string): Promise<{ app: Ref; name: string; window: Node } | null> {
    const apps = await this.apps();
    if (appName) {
      const q = appName.toLowerCase();
      const app = apps.find((a) => a.name.toLowerCase() === q) ?? apps.find((a) => a.name.toLowerCase().includes(q));
      const w = app && (app.windows.find((w) => hasState(w.state, ACTIVE)) ?? app.windows.find((w) => hasState(w.state, SHOWING)));
      return app && w ? { app: app.app, name: app.name, window: w } : null;
    }
    for (const a of apps) {
      const w = a.windows.find((w) => hasState(w.state, ACTIVE));
      if (w) return { app: a.app, name: a.name, window: w };
    }
    // No ACTIVE window: ask the desktop which window is in front and find its app by process id.
    const front = await this.activeWindow?.().catch(() => null);
    if (!front?.pid) return null;
    for (const a of apps) {
      if ((await this.pid(a.app[0])) !== front.pid) continue;
      const showing = a.windows.filter((w) => hasState(w.state, SHOWING));
      let w = showing[0];
      if (front.title && showing.length > 1) {
        for (const s of showing) if ((await this.name(s.ref)) === front.title) { w = s; break; }
      }
      if (w) return { app: a.app, name: a.name, window: w };
    }
    return null;
  }

  /** Window-relative coordinates (GTK on Wayland report 0,0 for the window): the offset to add, from the desktop module. */
  private async offset(app: Ref, appName: string, window: Ref): Promise<Point> {
    const ext = await this.extents(window);
    if (!this.locateWindow || !ext || ext.x !== 0 || ext.y !== 0 || !process.env.WAYLAND_DISPLAY) return { x: 0, y: 0 };
    const r = await this.locateWindow(appName, await this.name(window), await this.pid(app[0])).catch(() => null);
    return r ? { x: r.x, y: r.y } : { x: 0, y: 0 };
  }

  /**
   * Depth-first walk of a window with the macOS limits; `visit` returns false to stop. Children of a node are fetched in
   * parallel (role + state each), then walked in order, so ids read top-to-bottom like on macOS.
   */
  private async walk(root: Node, visit: (n: Node, depth: number) => Promise<boolean | void>, limit = 5000, seconds = 4) {
    const deadline = Date.now() + seconds * 1000;
    let visited = 0;
    let stop = false;
    const go = async (n: Node, depth: number) => {
      if (stop || depth >= 30 || visited >= limit || Date.now() > deadline) return;
      visited++;
      if ((await visit(n, depth)) === false) { stop = true; return; }
      const kids = await this.children(n.ref);
      // Offscreen subtrees (closed menus, other tabs) aren't on screen on macOS either.
      const nodes = (await Promise.all(kids.slice(0, 2000).map(async (ref) => {
        const [role, state] = await Promise.all([this.role(ref), this.state(ref)]);
        return { ref, role, state };
      }))).filter((k) => hasState(k.state, SHOWING));
      for (const k of nodes) await go(k, depth + 1);
    };
    await go(root, 0);
  }

  // ── Accessibility ──

  async available(): Promise<boolean> {
    try { await this.a11y(); await this.q(ROOT, ACC, "GetChildren", "", [], 2000); return true; } catch { return false; }
  }

  async elements(appName?: string): Promise<{ app: string; elements: UIElement[] }> {
    this.ids.clear();
    await this.a11y();
    const t = await this.target(appName);
    if (!t) return { app: appName ?? "", elements: [] };
    const off = await this.offset(t.app, t.name, t.window.ref);
    const items: UIElement[] = [];
    let nextId = 1;
    await this.walk(t.window, async (n) => {
      if (items.length >= 350) return false;
      // GTK reports every GtkEntry as "text": single-line ones are fields, like AXTextField.
      const role = n.role === "text" && hasState(n.state, SINGLE_LINE) ? "TextField" : ROLES[n.role];
      if (!role) return;
      const f = await this.extents(n.ref);
      if (!f || f.width <= 1 || f.height <= 1) return;
      const secure = n.role === "password text";
      let label = await this.name(n.ref);
      if (!label) label = (await this.prop<string>(n.ref, ACC, "Description").catch(() => "")).trim();
      if (!label && !secure && (role === "TextField" || role === "TextArea" || role === "StaticText")) label = (await this.text(n.ref, 100)).trim();
      if (!label && (role === "StaticText" || role === "Image")) return;
      items.push({ id: nextId, role, label: secure ? "(password field)" : label.replace(/\s+/g, " ").slice(0, 100), x: f.x + off.x, y: f.y + off.y, w: f.width, h: f.height });
      this.ids.set(nextId++, n);
    });
    return { app: t.name, elements: items };
  }

  async press(id: number): Promise<boolean> {
    const n = this.ids.get(id);
    if (!n || !this.bus) return false;
    try {
      const count = await this.prop<number>(n.ref, ACTION, "NActions");
      if (!count) return false;
      const names = await Promise.all([...Array(count)].map((_, i) => this.q<string>(n.ref, ACTION, "GetName", "i", [i]).catch(() => "")));
      let i = names.findIndex((s) => ["click", "press", "activate", "jump"].includes(s.toLowerCase()));
      if (i < 0) i = names.findIndex((s) => ["toggle", "open", "select", "expand or contract"].includes(s.toLowerCase()));
      if (i < 0) return false;
      // A press that opens a dialog can take a while to return; timing out here would fall back to a real click and press twice.
      return await this.q<boolean>(n.ref, ACTION, "DoAction", "i", [i], 10_000);
    } catch { return false; }
  }

  async setValue(id: number, text: string): Promise<boolean> {
    const n = this.ids.get(id);
    if (!n || !this.bus) return false;
    await this.q(n.ref, COMPONENT, "GrabFocus").catch(() => {});
    return this.q<boolean>(n.ref, EDITABLE, "SetTextContents", "s", [text], 5000).catch(() => false);
  }

  async isSecure(target: { id?: number; at?: Point; focused?: boolean }): Promise<boolean> {
    try {
      if (target.id !== undefined) {
        const n = this.ids.get(target.id);
        return !!n && (n.role || (await this.role(n.ref))) === "password text";
      }
      await this.a11y();
      if (target.at) return (await this.roleAt(target.at)) === "password text";
      if (target.focused) {
        const t = await this.target();
        if (!t) return false;
        let secure = false;
        await this.walk(t.window, async (n) => {
          if (hasState(n.state, FOCUSED)) { secure = n.role === "password text"; return false; }
        }, 3000, 1.5);
        return secure;
      }
    } catch (e) { log(`atspi isSecure: ${(e as Error).message}`); }
    return false;
  }

  /** The deepest element at a screen point: in the window there (`pid`'s, else the active one first; never ours), then
   *  GetAccessibleAtPoint down. With the window's offset and frame. */
  private async refAt(p: Point, pid?: number): Promise<{ ref: Ref; off: Point; window: Rect } | null> {
    const apps = await this.apps();
    const own = ownPids();
    const wins = apps.flatMap((a) => a.windows.filter((w) => hasState(w.state, SHOWING)).map((w) => ({ a, w })))
      .sort((x, y) => Number(hasState(y.w.state, ACTIVE)) - Number(hasState(x.w.state, ACTIVE)));
    for (const { a, w } of wins) {
      const off = await this.offset(a.app, a.name, w.ref);
      const f = await this.extents(w.ref);
      const x = p.x - off.x, y = p.y - off.y;
      if (!f || x < f.x || y < f.y || x >= f.x + f.width || y >= f.y + f.height) continue;
      const appPid = await this.pid(a.app[0]);
      if (appPid !== undefined && (pid !== undefined ? appPid !== pid : own.has(appPid))) continue;
      let ref: Ref = w.ref;
      for (let depth = 0; depth < 30; depth++) {
        const next = await this.q<Ref>(ref, COMPONENT, "GetAccessibleAtPoint", "iiu", [Math.round(x), Math.round(y), 0]).catch(() => null);
        if (!next || next[1] === NULL_PATH || (next[0] === ref[0] && next[1] === ref[1])) break;
        ref = next;
      }
      return { ref, off, window: { x: f.x + off.x, y: f.y + off.y, width: f.width, height: f.height } };
    }
    return null;
  }

  private async roleAt(p: Point): Promise<string> {
    const hit = await this.refAt(p);
    return hit ? this.role(hit.ref) : "";
  }

  async elementAt(p: Point, window: DesktopWindow | null): Promise<PickedElement | null> {
    try {
      await this.a11y();
      const hit = await this.refAt(p, window?.pid);
      if (!hit) return null;
      // Climb from bare text and tiny bits to the thing a person would point at (the link, button or card).
      let ref = hit.ref, role = await this.role(ref), f = await this.extents(ref);
      for (let i = 0; i < 6 && f; i++) {
        if (!BARE.has(role) && f.width >= 24 && f.height >= 16) break;
        const parent = await this.prop<Ref>(ref, ACC, "Parent").catch(() => null);
        const pf = parent && parent[1] !== NULL_PATH ? await this.extents(parent) : null;
        if (!parent || !pf) break;
        ref = parent; role = await this.role(ref); f = pf;
      }
      if (!f) return null;
      const w = hit.window, x = Math.max(f.x + hit.off.x, w.x), y = Math.max(f.y + hit.off.y, w.y);
      const width = Math.min(f.x + hit.off.x + f.width, w.x + w.width) - x, height = Math.min(f.y + hit.off.y + f.height, w.y + w.height) - y;
      if (width < 1 || height < 1) return null;
      return { rect: { x, y, width, height }, about: await this.describe(ref, role) };
    } catch (e) {
      log(`atspi elementAt: ${(e as Error).message}`);
      return null;
    }
  }

  /** What the assistant needs to find it in code: kind, visible text, and on web pages the DOM id and classes. */
  private async describe(ref: Ref, role: string): Promise<string> {
    const clip = (s: string) => s.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    const secure = role === "password text";
    let text = clip(await this.name(ref)) || clip(await this.prop<string>(ref, ACC, "Description").catch(() => ""));
    if (!text && !secure) text = clip(await this.text(ref, 200)) || (await this.innerText(ref));
    // Chromium and Firefox expose the DOM id and class attribute as object attributes.
    const attrs = await this.q<Record<string, string>>(ref, ACC, "GetAttributes").catch(() => ({} as Record<string, string>));
    const parts = [role || "element"];
    if (text) parts.push(`“${text}”`);
    if (attrs.id) parts.push("#" + attrs.id);
    const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean).slice(0, 4);
    if (classes.length) parts.push(classes.map((c) => "." + c).join(""));
    return parts.join(" ");
  }

  /** A web group or card has no name of its own: the start of the text inside it. */
  private async innerText(root: Ref): Promise<string> {
    let out = "", budget = 40;
    const go = async (ref: Ref, depth: number) => {
      if (out.length >= 80 || budget <= 0 || depth >= 4) return;
      budget--;
      if ((await this.role(ref)) === "password text") return;
      const s = (await this.text(ref, 80)).replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim();
      if (s) out += (out ? " " : "") + s;
      for (const c of await this.children(ref)) await go(c, depth + 1);
    };
    for (const c of await this.children(root)) await go(c, 0);
    return out.slice(0, 80).trim();
  }

  async windowText(max: number): Promise<{ app: string; title: string; text: string } | null> {
    try {
      await this.a11y();
      const t = await this.target();
      if (!t) return null;
      const title = await this.name(t.window.ref);
      const parts: string[] = [];
      let size = 0;
      await this.walk(t.window, async (n) => {
        if (size >= max) return false;
        if (n.role === "password text") return;
        // Containers (Chromium paragraphs, documents) hold U+FFFC for each child object: drop it, the child is visited too.
        const s = (await this.text(n.ref, Math.max(1, max - size))).replace(/￼/g, "").replace(/[ \t]+/g, " ").trim();
        if (!s) return;
        parts.push(s);
        size += s.length + 1;
      });
      return { app: t.name, title, text: parts.join("\n").slice(0, max) };
    } catch (e) {
      log(`atspi windowText: ${(e as Error).message}`);
      return null;
    }
  }
}
