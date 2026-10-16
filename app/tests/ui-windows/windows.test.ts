import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { trayIcon, ringIcon, usageColor, GREEN, ORANGE, RED } from "../../src/main/ui/windows/icons";
import { buildMenu, projectChoices, projectLabel, resets, shortName, tokens, tooltip, trayRings, type MItem } from "../../src/main/ui/windows/menu";
import { encodePNG, Painter } from "../../src/main/ui/windows/painter";
import type { MenuModel, SettingsSnapshot } from "../../src/main/ui/windows/types";
import { filterEntries, projectsOf } from "../../src/renderer/history/model";
import { missing, next, back, requiredDone, stateOf } from "../../src/renderer/setup/steps";

/** Decodes our own unfiltered RGBA PNGs: width, height and pixel access. */
function decode(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  let off = 8;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const at = (x: number, y: number) => { const i = y * (w * 4 + 1) + 1 + x * 4; return [...raw.subarray(i, i + 4)]; };
  return { w, h, at };
}

test("PNG encoder round-trips pixels", () => {
  const px = new Uint8ClampedArray(2 * 2 * 4);
  px.set([255, 0, 0, 255], 0);
  px.set([0, 0, 255, 128], 12);
  const d = decode(encodePNG(2, 2, px));
  assert.equal(d.w, 2);
  assert.deepEqual(d.at(0, 0), [255, 0, 0, 255]);
  assert.deepEqual(d.at(1, 1), [0, 0, 255, 128]);
  assert.deepEqual(d.at(1, 0), [0, 0, 0, 0]);
});

test("an arc starts at 12 o'clock and runs clockwise", () => {
  const p = new Painter(20, 20);
  p.arc(10, 10, 8, 2, 0, 90, [255, 0, 0, 255]); // a quarter: top to 3 o'clock
  const d = decode(p.png());
  assert.equal(d.at(14, 3)[3] > 200, true);   // top right quadrant, on the ring
  assert.equal(d.at(18, 10)[3] > 100, true);  // 3 o'clock (round cap)
  assert.equal(d.at(10, 18)[3], 0);           // 6 o'clock: not drawn
  assert.equal(d.at(3, 6)[3], 0);             // top left: not drawn
});

test("usage colors follow UsageArt", () => {
  assert.deepEqual(usageColor(10), GREEN);
  assert.deepEqual(usageColor(50), ORANGE);
  assert.deepEqual(usageColor(80), RED);
});

test("tray icon is 22 points, 44 px at 2x, with the ring in the session color", () => {
  const plain = decode(trayIcon({ light: true, scale: 1 }));
  assert.equal(plain.w, 22);
  assert.equal(plain.h, 22);
  const ringed = decode(trayIcon({ light: true, rings: { session: 85, week: null }, scale: 2 }));
  assert.equal(ringed.w, 44);
  const top = ringed.at(22, 2); // the arc starts at 12 o'clock
  assert.equal(top[0] > 200 && top[1] < 120 && top[3] > 200, true, `expected red at the top, got ${top}`);
  const both = decode(trayIcon({ light: false, rings: { session: 10, week: 60 }, scale: 1 }));
  assert.equal(both.w, 22);
  assert.equal(decode(ringIcon(40, true, 2)).w, 32);
});

const model = (over: Partial<MenuModel> = {}): MenuModel => ({
  currentProject: "/home/u/code/app", pinnedProject: null, homeProject: "/home/u/VisionCLI",
  running: [{ project: "/home/u/code/app", assistant: "claude" }], windows: ["/home/u/code/web", "/home/u/code/app"],
  recent: ["/home/u/code/app", "/home/u/VisionCLI", "/home/u/old"],
  usage: { session: { percent: 22, resetsAt: new Date().toISOString() }, week: { percent: 52, resetsAt: new Date(Date.now() + 3 * 86400e3).toISOString() },
    today: { requests: 12, input: 1_500_000, output: 4200, cached: 999 }, updated: new Date(Date.now() - 5 * 60e3).toISOString(), inMenuBar: true, weeklyInMenuBar: false },
  updateStatus: null, updateAvailable: null, screenProblem: null, terminalMode: true, assistantName: "Claude", canContinueInTerminal: false,
  ...over,
});
const labels = (items: MItem[]) => items.filter((i) => i.type !== "separator").map((i) => i.label);

test("menu has the macOS items in order", () => {
  const items = buildMenu(model());
  assert.deepEqual(labels(items), [
    "Project: app", "Claude Usage: 22% session · 52% week", "History…", "New Conversation", "Copy Last Answer",
    "Show Claude Terminal", "Settings…", "Quit VisionCLI",
  ]);
  const bubble = buildMenu(model({ terminalMode: false, updateAvailable: "0.9.0", screenProblem: "Set Up Screen Capture…", pinnedProject: "/home/u/code/app" }));
  const l = labels(bubble);
  assert.equal(l[0], "Project: app");
  assert.ok(l.includes("Install Update (0.9.0)…"));
  assert.ok(l.includes("Set Up Screen Capture…"));
  assert.ok(l.includes("Show Live Activity in Terminal"));
  const cont = bubble.find((i) => i.label === "Continue Conversation in Terminal")!;
  assert.equal(cont.enabled, false);
  assert.equal(labels(buildMenu(model({ updateStatus: "Downloading update…" }))).includes("Downloading update…"), true);
});

test("Gemini: Antigravity's limits under Gemini Usage, other model groups in the card", () => {
  const m = model({ assistantName: "Gemini" });
  const g = (p: number) => ({ percent: p, resetsAt: new Date(Date.now() + 3600e3).toISOString() });
  m.usage = { ...m.usage, name: "Gemini", session: g(1), week: g(3),
    groups: [{ name: "Gemini Models", session: g(1), week: g(3) }, { name: "Claude and GPT models", session: g(0), week: g(73) }] };
  const usage = buildMenu(m).find((i) => i.label?.includes("Usage"))!;
  assert.equal(usage.label, "Gemini Usage: 1% session · 3% week");
  const rows = labels(usage.submenu!);
  assert.ok(rows.includes("Claude and GPT models"));
  assert.ok(!rows.some((l) => l?.startsWith("Today")));
  assert.match(tooltip(m), /Gemini usage: 1% of this 5-hour session/);
});

test("project submenu: picked by hand (no Auto), Home, candidates once each, Choose Folder", () => {
  const sub = buildMenu(model({ pinnedProject: "/home/u/code/web" }))[0].submenu!;
  const l = labels(sub);
  assert.equal(l[0], "Home: general questions, no project");
  assert.match(l[1]!, /^app   claude running · /);
  assert.match(l[2]!, /^web   open · /);
  assert.match(l[3]!, /^old   recent · /);
  assert.equal(l.length, 5);
  assert.equal(l[4], "Choose Folder…");
  assert.equal(sub[0].checked, false);
  assert.equal(sub.find((i) => i.arg === "/home/u/code/web")!.checked, true);
  assert.ok(!sub.some((i) => i.id === "pickProject" && i.arg === null), "no Auto item");
  const empty = labels(buildMenu(model({ running: [], windows: [], recent: [] }))[0].submenu!);
  assert.ok(empty.includes("No projects found yet"));
});

test("projectChoices: running, then open, then recents; no Home, no repeats, capped", () => {
  const c = projectChoices({ homeProject: "/h/VisionCLI", running: [{ project: "/h/a", assistant: "claude" }], windows: ["/h/b", "/h/a"],
    recent: ["/h/VisionCLI", "/h/c", "/h/b", ...Array.from({ length: 30 }, (_, i) => `/h/r${i}`)] } as never);
  assert.deepEqual(c.slice(0, 3).map((x) => x.path), ["/h/a", "/h/b", "/h/c"]);
  assert.match(c[0].label, /^a   claude running · /);
  assert.ok(!c.some((x) => x.path === "/h/VisionCLI"));
  assert.equal(c.length, 15);
});

test("usage submenu and labels", () => {
  const usage = buildMenu(model())[1];
  const l = labels(usage.submenu!);
  assert.ok(l.some((x) => x?.startsWith("Session (5 hours)   22%")));
  assert.ok(l.some((x) => x?.includes("↑ 1.5M in   ↓ 4K out   999 cached")));
  assert.ok(l.includes("Refresh Usage"));
  assert.equal(usage.submenu!.find((i) => i.id === "toggleWeeklyInMenuBar")!.enabled, true);
  assert.equal(usage.icon, "gauge");
  assert.equal(buildMenu(model({ usage: { ...model().usage, week: { percent: 91, resetsAt: new Date().toISOString() } } }))[1].icon, "warning");
  const none = buildMenu(model({ usage: { ...model().usage, session: null, week: null } }))[1];
  assert.equal(none.label, "Claude Usage");
  assert.ok(labels(none.submenu!).includes("No usage yet: ask something or Refresh"));
  assert.equal(tokens(999), "999");
  assert.equal(tokens(4200), "4K");
  assert.equal(tokens(2_340_000), "2.3M");
  assert.match(resets(new Date().toISOString()), /^\d{1,2}:\d{2} [AP]M$/);
});

test("tooltip, rings and project labels", () => {
  assert.equal(projectLabel("/home/u/VisionCLI", "/home/u/VisionCLI"), "Home");
  assert.equal(shortName("a-very-long-project-name"), "a-very-long-proje…");
  assert.match(tooltip(model()), /22% of this 5-hour session, 52% of this week/);
  assert.deepEqual(trayRings(model()), { session: 22, week: null });
  assert.deepEqual(trayRings(model({ usage: { ...model().usage, weeklyInMenuBar: true } })), { session: 22, week: 52 });
  assert.equal(trayRings(model({ usage: { ...model().usage, inMenuBar: false } })), null);
  assert.equal(tooltip(model({ usage: { ...model().usage, inMenuBar: false } })), "VisionCLI · app");
});

test("history filter and projects", () => {
  const e = (date: string, project: string, question: string) => ({ key: date, date, project, projectLabel: project, question, answer: "the answer", shots: [] });
  const list = [e("2026-01-03", "b", "Why red?"), e("2026-01-02", "a", "what is this"), e("2026-01-01", "b", "Hello")];
  assert.deepEqual(projectsOf(list).map((p) => p.path), ["b", "a"]);
  assert.equal(filterEntries(list, "b", "").length, 2);
  assert.equal(filterEntries(list, "", "WHY").length, 1);
  assert.equal(filterEntries(list, "a", "answer").length, 1);
  assert.equal(filterEntries(list, "a", "nope").length, 0);
});

test("setup steps: states, required, missing", () => {
  const snap = { speechEngine: "parakeet", parakeetReady: false, whisperModels: [], speak: false, assistant: "claude",
    tools: { claude: { connected: true, connecting: false, error: null } } } as unknown as SettingsSnapshot;
  const checks = { microphone: { state: "done" as const }, keyboard: { state: "done" as const }, screen: { state: "pending" as const }, control: { state: "done" as const } };
  assert.equal(stateOf("welcome", "welcome", checks, snap), "pending");
  assert.equal(stateOf("welcome", "microphone", checks, snap), "done");
  assert.equal(stateOf("transcription", "done", checks, snap), "pending");
  assert.equal(stateOf("voice", "done", checks, snap), "optional");
  assert.equal(stateOf("terminal", "done", checks, snap), "optional");
  assert.equal(stateOf("assistant", "done", checks, snap), "done");
  assert.equal(requiredDone("done", checks, snap), false);
  assert.equal(requiredDone("done", { ...checks, screen: { state: "done" } }, snap), true);
  assert.deepEqual(missing("done", checks, snap).map((s) => s.id), ["screen", "transcription"]);
  assert.equal(next("welcome"), "microphone");
  assert.equal(next("done"), null);
  assert.equal(back("welcome"), null);
});
