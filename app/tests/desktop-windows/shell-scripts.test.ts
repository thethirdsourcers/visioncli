// Runs the real KWin script and GNOME Shell extension in a vm sandbox against fake KWin / Mutter objects, so their
// logic is exercised even though neither desktop can run in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { bridgeName, fillKWinScript, parseKWinSnapshot } from "../../src/main/desktop/windows/kde";
import { toLegacyExtension } from "../../src/main/desktop/windows/gnome";
import { resourcesDir } from "../../src/main/desktop/windows/common";

const res = resourcesDir();
const kwinScript = readFileSync(join(res, "kwin/visioncli-query.js"), "utf8");
const extension = readFileSync(join(res, "gnome-extension/visioncli@thethirdsourcers.com/extension.js"), "utf8");

function kwinWindow(id: string, cls: string, x: number, extra: object = {}) {
  return { internalId: id, resourceClass: cls, resourceName: cls, desktopFileName: "", caption: cls + " title", pid: 100,
    frameGeometry: { x, y: 10, width: 800, height: 600 }, normalWindow: true, minimized: false, onAllDesktops: false, desktops: [] as any[],
    activities: [], ...extra };
}

function runKWin(workspace: any, request: Record<string, string>) {
  const calls: any[][] = [];
  const ctx = vm.createContext({ workspace, KWin: { ScreenArea: 7 }, callDBus: (...a: any[]) => calls.push(a) });
  vm.runInContext(fillKWinScript(kwinScript, request), ctx);
  assert.equal(calls.length, 1);
  return calls[0];
}

test("KWin script (Plasma 6 API): front-most first, current desktop only, cursor, screens", () => {
  const d1 = { id: "d1" }, d2 = { id: "d2" };
  const a = kwinWindow("{a}", "konsole", 0, { desktops: [d1] });
  const b = kwinWindow("{b}", "dolphin", 50, { desktops: [d1] });
  const c = kwinWindow("{c}", "kate", 90, { desktops: [d2] });
  const m = kwinWindow("{m}", "firefox", 70, { desktops: [d1], minimized: true });
  const p = kwinWindow("{p}", "plasmashell", 0, { onAllDesktops: true, normalWindow: false });
  const workspace = { stackingOrder: [p, a, m, b, c], activeWindow: a, currentDesktop: d1, cursorPos: { x: 12, y: 34 },
    screens: [{ geometry: { x: 0, y: 0, width: 1920, height: 1080 } }] };
  const [service, path, iface, method, token, json] = runKWin(workspace, { token: "tk", action: "snapshot", target: "", service: "dev.visioncli.KWinBridge.p1", path: "/dev/visioncli/KWinBridge", iface: "dev.visioncli.KWinBridge" });
  assert.deepEqual([service, path, iface, method, token], ["dev.visioncli.KWinBridge.p1", "/dev/visioncli/KWinBridge", "dev.visioncli.KWinBridge", "Report", "tk"]);
  const snap = parseKWinSnapshot(json);
  assert.deepEqual(snap.windows.map((w) => w.id), ["{b}", "{a}"]);
  assert.equal(snap.windows[1].active, true);
  assert.deepEqual(snap.cursor, { x: 12, y: 34 });
  assert.deepEqual(snap.screens, [{ x: 0, y: 0, width: 1920, height: 1080 }]);
});

test("KWin script (Plasma 5 API): clientList, activeClient, numScreens, activate", () => {
  const a = kwinWindow("{a}", "konsole", 0, { desktop: 1, desktops: undefined });
  const b = kwinWindow("{b}", "dolphin", 50, { desktop: 1, desktops: undefined, minimized: true });
  const workspace: any = { clientList: () => [a, b], activeClient: b, currentDesktop: 1, numScreens: 1,
    clientArea: (_o: number, _i: number, _d: number) => ({ x: 0, y: 0, width: 1280, height: 1024 }) };
  const snap = parseKWinSnapshot(runKWin(workspace, { token: "t", action: "snapshot", target: "", service: "s", path: "/p", iface: "i" })[5]);
  assert.deepEqual(snap.windows.map((w) => w.id), ["{a}"]);
  assert.equal(snap.cursor, null);
  assert.deepEqual(snap.screens, [{ x: 0, y: 0, width: 1280, height: 1024 }]);
  const res = JSON.parse(runKWin(workspace, { token: "t", action: "activate", target: "{b}", service: "s", path: "/p", iface: "i" })[5]);
  assert.deepEqual(res, { ok: true });
  assert.equal(workspace.activeClient, b);
  assert.equal(b.minimized, false);
});

function fakeShell() {
  const ws = { name: "ws1" };
  const mk = (id: number, cls: string, x: number, extra: object = {}) => ({
    id, cls, minimized: false, type: 0, skip: false, ws,
    get_id: () => id, get_wm_class: () => cls, get_gtk_application_id: () => null, get_sandboxed_app_id: () => null,
    get_title: () => cls + " title", get_pid: () => id * 10, get_window_type() { return (this as any).type; },
    is_skip_taskbar() { return (this as any).skip; }, located_on_workspace(w: any) { return (this as any).ws === w; },
    get_frame_rect: () => ({ x, y: 5, width: 640, height: 480 }), ...extra,
  });
  const a = mk(1, "Gedit", 0), b = mk(2, "firefox", 100), c = mk(3, "kitty", 200, { minimized: true }),
    d = mk(4, "ding", 0, { skip: true }), e = mk(5, "other", 0, { ws: { name: "ws2" } });
  const stacking = [d, a, e, c, b]; // bottom → top
  let exported: any = null, activated: any = null, owned = "";
  const global = {
    get_window_actors: () => [b, a, c, d, e].map((w) => ({ get_meta_window: () => w })),
    display: {
      focus_window: a,
      sort_windows_by_stacking: (wins: any[]) => stacking.filter((w) => wins.includes(w)),
      get_n_monitors: () => 2, get_monitor_geometry: (i: number) => ({ x: i * 1920, y: 0, width: 1920, height: 1080 }),
      get_monitor_scale: () => 1,
    },
    workspace_manager: { get_active_workspace: () => ws },
    get_pointer: () => [321, 654, 0],
  };
  const imports = {
    gi: {
      Gio: {
        DBusExportedObject: { wrapJSObject: (_xml: string, obj: any) => { exported = obj; return { export: () => {}, unexport: () => {} }; } },
        DBus: { session: {} }, BusNameOwnerFlags: { NONE: 0 },
        bus_own_name_on_connection: (_c: any, name: string) => { owned = name; return 7; }, bus_unown_name: () => {},
        MemoryOutputStream: { new_resizable: () => ({}) },
      },
      GLib: {}, Meta: { WindowType: { NORMAL: 0, DIALOG: 3, MODAL_DIALOG: 4, UTILITY: 5 } },
      Shell: { WindowTracker: { get_default: () => ({ get_window_app: (w: any) => (w.cls === "Gedit" ? { get_id: () => "org.gnome.gedit.desktop", get_name: () => "Text Editor" } : null) }) } },
    },
    ui: { main: { activateWindow: (w: any) => { activated = w; } } },
  };
  return { global, imports, get exported() { return exported; }, get activated() { return activated; }, get owned() { return owned; } };
}

test("GNOME extension (legacy form for 42–44) exports the service and lists windows like Screen.windows()", () => {
  const legacy = toLegacyExtension(extension);
  assert.doesNotMatch(legacy, /^import /m);
  assert.doesNotMatch(legacy, /^export /m);
  const shell = fakeShell();
  const ctx = vm.createContext({ global: shell.global, imports: shell.imports });
  vm.runInContext(legacy, ctx);
  const ext = vm.runInContext("init()", ctx);
  ext.enable();
  assert.equal(shell.owned, "dev.visioncli.Shell");
  const svc = shell.exported;
  assert.equal(svc.Version(), "1");
  const ws = JSON.parse(svc.Windows());
  assert.deepEqual(ws.map((w: any) => w.id), ["2", "1"]);
  assert.deepEqual(ws[1], { id: "1", wm_class: "Gedit", app_id: "org.gnome.gedit.desktop", app: "Text Editor", title: "Gedit title", pid: 10, x: 0, y: 5, width: 640, height: 480, focus: true });
  assert.deepEqual([...svc.Pointer()], [321, 654]);
  assert.deepEqual(JSON.parse(svc.Displays()).map((d: any) => d.x), [0, 1920]);
  assert.equal(svc.Activate("2"), true);
  assert.equal(shell.activated.get_id(), 2);
  assert.equal(svc.Activate("99"), false);
  ext.disable();
});

test("GNOME extension ESM form and KWin script are valid JavaScript", () => {
  const dir = mkdtempSync(join(tmpdir(), "vcli-ext-"));
  writeFileSync(join(dir, "extension.mjs"), extension);
  writeFileSync(join(dir, "legacy.js"), toLegacyExtension(extension));
  writeFileSync(join(dir, "kwin.js"), kwinScript);
  for (const f of ["extension.mjs", "legacy.js", "kwin.js"]) execFileSync(process.execPath, ["--check", join(dir, f)]);
});

test("KWin bridge name: under the app id inside the Flatpak (the only names it may own)", () => {
  assert.equal(bridgeName({}, 42), "dev.visioncli.KWinBridge.p42");
  assert.equal(bridgeName({ FLATPAK_ID: "com.thethirdsourcers.VisionCLI" }, 42), "com.thethirdsourcers.VisionCLI.KWinBridge.p42");
});
