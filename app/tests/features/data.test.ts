import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { HistoryStore } from "../../src/main/features/history";
import { AgyUsage, UsageTracker } from "../../src/main/features/usage";
import { ProjectResolver, tokens } from "../../src/main/features/projects";
import { AnnounceQueue, announceSeconds } from "../../src/main/features/announce";
import { HOME_NOTE, HomeProject } from "../../src/main/features/home";
import type { Phase } from "../../src/main/contracts";
import { fakeCli } from "./fakes";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("HistoryStore", () => {
  test("append, reload newest-first, 200 per project, clear one project", async () => {
    const dir = tmp("vcli-hist-");
    const h = new HistoryStore(dir);
    for (let i = 0; i < 3; i++) h.add({ date: new Date(2026, 0, 1, 0, i).toISOString(), project: "/p/a", question: `q${i}`, answer: "a", screenshots: [] });
    h.add({ date: new Date().toISOString(), project: "/p/b", question: "b", answer: "x", screenshots: [] });
    await h.waitForWrites();
    const again = new HistoryStore(dir);
    assert.deepEqual(again.entries.map((e) => e.question), ["b", "q2", "q1", "q0"]);
    assert.deepEqual(again.projects(), ["/p/b", "/p/a"]);
    assert.deepEqual(again.filtered("/p/a", "Q1").map((e) => e.question), ["q1"]);
    const [shot] = again.save([Buffer.from("jpeg")]);
    for (let i = 0; i < 200; i++) again.add({ date: new Date().toISOString(), project: "/p/a", question: `n${i}`, answer: "", screenshots: i === 0 ? [] : [] });
    // The oldest /p/a entries (q0…q2) go; /p/b keeps its one.
    assert.equal(again.entries.filter((e) => e.project === "/p/a").length, 200);
    assert.ok(!again.entries.some((e) => e.question === "q0"));
    again.add({ date: new Date().toISOString(), project: "/p/c", question: "with shot", answer: "", screenshots: [shot] });
    again.clear("/p/c");
    await again.waitForWrites();
    assert.ok(!existsSync(shot));
    const third = new HistoryStore(dir);
    assert.equal(third.entries.length, 201);
    third.clear();
    await third.waitForWrites();
    assert.ok(!existsSync(join(dir, "history.jsonl")));
  });

  test("screenshots past 30 days or 300 MB are pruned, oldest first", async () => {
    const dir = tmp("vcli-hist-");
    const h = new HistoryStore(dir);
    const shots = join(dir, "screenshots");
    writeFileSync(join(shots, "old.jpg"), "x");
    utimesSync(join(shots, "old.jpg"), new Date(Date.now() - 31 * 86400_000), new Date(Date.now() - 31 * 86400_000));
    writeFileSync(join(shots, "new.jpg"), "x");
    await h.pruneShots();
    assert.deepEqual(readdirSync(shots), ["new.jpg"]);
    (h as any).shotsMaxBytes = 0; // over the size cap: everything goes, oldest first
    await h.pruneShots();
    assert.deepEqual(readdirSync(shots), []);
  });
});

describe("UsageTracker", () => {
  const store = () => { const m = new Map<string, unknown>(); return { getStore: <T>(k: string) => m.get(k) as T, setStore: (k: string, v: unknown) => (v === undefined ? m.delete(k) : m.set(k, v)), m }; };

  test("rate_limit_event, percent, bar text, staleness", () => {
    const s = store();
    const u = new UsageTracker(s, "/nonexistent");
    assert.equal(u.isStale(), true);
    const future = Date.now() / 1000 + 3600;
    u.recordLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.224, resetsAt: future }, seven_day: { utilization: 0.52, resetsAt: future } } } }));
    assert.equal(u.percent(u.session), 22);
    assert.equal(u.barText(), "22% · 52%w");
    assert.equal(u.percent({ utilization: 0.9, resetsAt: Date.now() - 1 }), 0);
    assert.equal(u.isStale(), false);
    assert.equal(u.isStale(Date.now() + 3 * 3600_000 + 1000), true);
    const reloaded = new UsageTracker(s, "/nonexistent");
    assert.equal(reloaded.percent(reloaded.week), 52);
    assert.equal(UsageTracker.tokens(1_234_567), "1.2M");
    assert.equal(UsageTracker.tokens(52_900), "52K");
    assert.equal(UsageTracker.tokens(999), "999");
    assert.equal(UsageTracker.color(85), "red");
  });

  test("refresh runs the tiny haiku request", async () => {
    const dir = tmp("vcli-usage-");
    const future = Math.floor(Date.now() / 1000) + 600;
    const event = { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: future } } } };
    const fake = fakeCli(dir, "claude", `require("fs").writeFileSync(${JSON.stringify(join(dir, "args"))}, process.argv.slice(2).join(" ") + "\\n");
console.log(${JSON.stringify(JSON.stringify(event))});`);
    const u = new UsageTracker(store(), "/nonexistent");
    await u.refresh(fake);
    assert.equal(u.percent(u.session), 10);
    assert.equal(readFileSync(join(dir, "args"), "utf8").trim(), "-p --model haiku --output-format stream-json --verbose --max-turns 1 Reply with just: ok");
  });

  test("today's tokens: incremental reads, dedupe by message id, only today", () => {
    const dir = tmp("vcli-usage-");
    mkdirSync(join(dir, "proj"), { recursive: true });
    const file = join(dir, "proj", "s.jsonl");
    const now = new Date();
    const line = (id: string, ts: Date, inp: number) => JSON.stringify({ type: "assistant", timestamp: ts.toISOString(), message: { id, usage: { input_tokens: inp, cache_creation_input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 } } }) + "\n";
    writeFileSync(file, line("m1", now, 10) + line("m1", now, 10) + line("old", new Date(now.getTime() - 3 * 86400_000), 1000));
    const u = new UsageTracker(store(), dir);
    assert.deepEqual(u.countToday(now), { requests: 1, input: 15, output: 7, cached: 100 });
    appendFileSync(file, line("m2", now, 20) + '{"type":"assistant","usage": partial');
    assert.deepEqual(u.countToday(now), { requests: 2, input: 40, output: 14, cached: 200 });
    // The unfinished line is re-read once complete.
    appendFileSync(file, `, "timestamp":"x"}\n`);
    assert.equal(u.countToday(now).requests, 2);
  });
});

describe("ProjectResolver", () => {
  test("title tokens", () => {
    assert.deepEqual(tokens("myshop – payments.php"), ["myshop", "payments.php"]);
    assert.deepEqual(tokens("● file.ts - myapp - Visual Studio Code"), ["file.ts", "myapp", "Visual Studio Code"]);
    assert.deepEqual(tokens("myshop [~/PhpstormProjects/myshop] – x"), ["~/PhpstormProjects/myshop", "myshop", "x"]);
  });

  // Windows recents (%APPDATA%, file:///c%3A/… URIs) are tested in win-features/data.test.ts
  test("Linux recents (JetBrains, VS Code family), scanned folders, git root", { skip: process.platform === "win32" && "Linux config folders and POSIX file:// paths" }, async () => {
    const home = tmp("vcli-home-");
    const config = join(home, ".config");
    const mk = (p: string) => mkdirSync(join(home, p), { recursive: true });
    mk("work/shop/.git"); mk("elsewhere/vsapp"); mk("projects/api/src"); mk("projects/group/inner"); writeFileSync(join(home, "projects/group/inner/package.json"), "{}");
    mkdirSync(join(config, "JetBrains/PhpStorm2025.2/options"), { recursive: true });
    writeFileSync(join(config, "JetBrains/PhpStorm2025.2/options/recentProjects.xml"), `<application><component name="RecentProjectsManager"><option name="additionalInfo"><map><entry key="$USER_HOME$/work/shop"><value/></entry></map></option></component></application>`);
    mkdirSync(join(config, "Cursor/User/globalStorage"), { recursive: true });
    writeFileSync(join(config, "Cursor/User/globalStorage/storage.json"), JSON.stringify({ windowsState: { lastActiveWindow: { folder: `file://${home}/elsewhere/vs%20app`.replace("vs%20app", "vsapp") } } }));
    const r = new ProjectResolver(home, config);
    await r.refresh();
    assert.equal(r.project({ title: "shop – Cart.php" }), join(home, "work/shop"));
    assert.equal(r.project({ title: "index.ts - vsapp - Cursor" }), join(home, "elsewhere/vsapp"));
    assert.equal(r.project({ title: "api" }), join(home, "projects/api"));
    assert.equal(r.project({ title: "inner — x" }), join(home, "projects/group/inner"));
    assert.equal(r.project({ title: `Cart.php [${home}/work/shop/src/Cart.php]`.replace("/src/Cart.php", "") }), join(home, "work/shop"));
    assert.equal(r.project({ title: "nothing here" }), null);
    assert.deepEqual(r.openWindowProjects([
      { id: "1", app: "kitty", appId: "kitty", title: "api", bounds: { x: 0, y: 0, width: 1, height: 1 } },
      { id: "2", app: "PhpStorm", appId: "jetbrains-phpstorm", title: "shop – a", bounds: { x: 0, y: 0, width: 1, height: 1 } },
    ]), [join(home, "work/shop")]);
    // Projects to pick by hand: the editors' recents first, then project folders (only real projects).
    const recent = r.recentProjects(8);
    assert.deepEqual(recent.slice(0, 2), [join(home, "elsewhere/vsapp"), join(home, "work/shop")]);
    assert.ok(recent.includes(join(home, "projects/group/inner")));
    assert.ok(!recent.includes(join(home, "projects/group")), "a plain folder isn't offered");
  });
});

describe("AnnounceQueue", () => {
  test("shows when idle/done/error, queues otherwise, drains after the bubble hides", async () => {
    let phase: Phase = "thinking";
    const shown: [string, number][] = [];
    const q = new AnnounceQueue({ phase: () => phase, show: (t, s) => shown.push([t, s]) });
    q.announce("  ");
    q.announce("Build finished.");
    assert.deepEqual(shown, []);
    assert.deepEqual(q.pending, ["Build finished."]);
    phase = "idle";
    q.bubbleHidden();
    await new Promise((r) => setTimeout(r, 700));
    assert.deepEqual(shown, [["Build finished.", 6]]);
    assert.equal(announceSeconds("x".repeat(600)), 20);
    assert.equal(announceSeconds("x".repeat(120)), 10);
  });
});

describe("HomeProject", () => {
  test("creates CLAUDE.md and AGENTS.md once, labels Home", () => {
    const dir = join(tmp("vcli-homeproj-"), "VisionCLI");
    HomeProject.ensure(dir);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), HOME_NOTE);
    writeFileSync(join(dir, "AGENTS.md"), "mine");
    HomeProject.ensure(dir);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "mine");
    assert.equal(HomeProject.label(HomeProject.path), "Home");
    assert.equal(HomeProject.label("/x/myapp"), "myapp");
  });
});

test("Antigravity /usage: each group's 5-hour and weekly limits, and the group for the chosen model", () => {
  const json = JSON.stringify({ command: { name: "usage", data: { groups: [
    { name: "Gemini Models", buckets: [
      { window: "weekly", remaining_fraction: 0.97, reset_time: "2026-10-19T04:55:01Z" },
      { window: "5h", remaining_fraction: 0.99, reset_time: "2026-10-13T18:39:20Z" }] },
    { name: "Claude and GPT models", buckets: [{ window: "weekly", remaining_fraction: 0.27, reset_time: "2026-10-16T07:54:50Z" }] },
  ] } } });
  const groups = AgyUsage.parse(json);
  assert.equal(groups.length, 2);
  assert.ok(Math.abs(groups[0].session!.utilization - 0.01) < 1e-9);
  assert.equal(groups[0].week!.resetsAt, Date.parse("2026-10-19T04:55:01Z"));
  assert.equal(groups[1].session, null);
  const store = new Map<string, unknown>();
  const u = new AgyUsage({ getStore: (k) => store.get(k) as never, setStore: (k, v) => store.set(k, v) });
  u.groups = groups;
  assert.equal(u.active("gemini-3.8-flash")?.name, "Gemini Models");
  assert.equal(u.active("claude-opus-5-5")?.name, "Claude and GPT models");
  assert.equal(u.active(null)?.name, "Gemini Models");
});
