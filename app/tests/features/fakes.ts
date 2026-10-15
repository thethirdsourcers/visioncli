// Fake desktop/input/accessibility/apps for driving the control server in tests.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Accessibility, Apps, Desktop, DesktopWindow, InputInjector, Point, Rect, UIElement } from "../../src/main/contracts";

export const win = (id: string, app: string, appId: string, title = "", pid = 4242): DesktopWindow =>
  ({ id, app, appId, title, pid, bounds: { x: 10, y: 20, width: 800, height: 600 } });

export function fakes() {
  const calls: string[] = [];
  const state = {
    windows: [win("100", "gedit", "org.gnome.gedit", "notes.txt - gedit"), win("200", "Terminal", "gnome-terminal", "~")],
    active: null as DesktopWindow | null,
    secureIds: new Set<number>(),
    secureFocused: false,
    elements: [
      { id: 1, role: "push button", label: "Save", x: 50, y: 60, w: 40, h: 20 },
      { id: 2, role: "text", label: "Name", x: 150, y: 60, w: 100, h: 20 },
      { id: 3, role: "password text", label: "(password field)", x: 150, y: 90, w: 100, h: 20 },
    ] as UIElement[],
    pressOk: true,
    text: { app: "gedit", title: "notes.txt - gedit", text: "" },
  };
  state.active = state.windows[0];
  const desktop: Desktop = {
    backend: "x11",
    problem: async () => null,
    displays: async () => [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1280, height: 1024 }],
    pointer: async () => ({ x: 5, y: 6 }),
    windows: async () => state.windows,
    activeWindow: async () => state.active,
    captureWindow: async (w: DesktopWindow) => { calls.push(`captureWindow ${w.id}`); return { data: Buffer.from("jpeg-" + w.id), width: 800, height: 600 }; },
    captureRect: async (r: Rect) => { calls.push(`captureRect ${r.x},${r.y},${r.width},${r.height}`); return { data: Buffer.from("rect"), width: r.width, height: r.height }; },
    focus: async (w: DesktopWindow) => { calls.push(`focus ${w.id}`); state.active = w; },
  };
  const input: InputInjector = {
    backend: "fake",
    move: async (p: Point) => { calls.push(`move ${p.x},${p.y}`); },
    click: async (p: Point, b, n) => { calls.push(`click ${p.x},${p.y} ${b} ${n}`); },
    type: async (t: string) => { calls.push(`type ${t}`); },
    key: async (c: string) => { if (c === "bogus") throw new Error(`Unknown key "${c}"`); calls.push(`key ${c}`); },
    scroll: async (dx, dy, at) => { calls.push(`scroll ${dx},${dy}${at ? ` at ${at.x},${at.y}` : ""}`); },
    drag: async (a, b) => { calls.push(`drag ${a.x},${a.y}->${b.x},${b.y}`); },
  };
  const ax: Accessibility = {
    available: async () => true,
    elements: async () => ({ app: state.active?.app ?? "", elements: state.elements }),
    press: async (id) => { calls.push(`press ${id}`); return state.pressOk; },
    setValue: async (id, t) => { calls.push(`setValue ${id} ${t}`); return true; },
    isSecure: async (t) => (t.id != null && state.secureIds.has(t.id)) || (!!t.focused && state.secureFocused),
    windowText: async () => state.text,
  };
  const apps: Apps = {
    list: async () => [],
    open: async (n) => { if (n === "nope") throw new Error("no such app"); calls.push(`open ${n}`); return n; },
    focus: async (n) => { calls.push(`focusApp ${n}`); return n; },
    openUrl: async (u) => { calls.push(`openUrl ${u}`); },
    openFile: async () => {},
  };
  return { calls, state, desktop, input, ax, apps };
}

/** A fake CLI on disk that runs `js` (Node source; process.argv.slice(2) are its arguments): a sh script on Linux and
 *  macOS, a .cmd on Windows (so the same cmd.exe quoting a real npm shim gets is exercised). Returns its path. */
export function fakeCli(dir: string, name: string, js: string): string {
  const script = join(dir, `${name}.fake.js`);
  writeFileSync(script, js);
  if (process.platform === "win32") {
    const p = join(dir, `${name}.cmd`);
    writeFileSync(p, `@"${process.execPath}" "${script}" %*\r\n`);
    return p;
  }
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} "$@"\n`, { mode: 0o755 });
  return p;
}
