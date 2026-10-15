// The orchestrator's pure parts: launch config, shot geometry, question text, overlay keys, task panel, keyboard
// delivery's window lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { compareVersions, electronNodeWrapper, findNode, loadConfig, mergePath, parseArgs, registryPath, serverArgs } from "../../src/main/app/config";
import { drawMarks, makeShot, rawWindowUnderPointer, regionLabel, screenPoint, windowLabel, windowUnderPointer } from "../../src/main/app/shots";
import { carryOver, cleanTranscript, hudTitle, meaningful, parseOpenLink, terminalQuestion, voiceQuestion } from "../../src/main/app/text";
import { OverlayKeys } from "../../src/main/app/keys";
import { idleUnload } from "../../src/main/app/voice";
import { TaskModel } from "../../src/main/app/tasks";
import { ancestorPids, emulatorWindow } from "../../src/main/app/keyboard";
import { cardPreview } from "../../src/main/app/control";
import { Markup } from "../../src/main/core/markup";
import type { DesktopWindow } from "../../src/main/contracts";

const win = (id: string, app: string, title: string, x: number, y: number, w: number, h: number, pid?: number, appId = app.toLowerCase()): DesktopWindow =>
  ({ id, app, appId, title, pid, bounds: { x, y, width: w, height: h } });

test("parseArgs: launch flags only with --cwd", () => {
  assert.equal(parseArgs(["--say", "hi"]), null);
  assert.deepEqual(parseArgs(["--cwd", "/p", "--claude", "/c", "--node", "/n", "--server", "/s", "--model", "opus"]),
    { cwd: "/p", claude: "/c", node: "/n", server: "/s", model: "opus" });
});

test("findNode picks the newest Node 18+", () => {
  const d = mkdtempSync(join(tmpdir(), "vn-"));
  // this platform's PATH form: `;` and node.exe on Windows (a drive letter's `:` would split a `:` PATH)
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const dirs = ["a", "b", "c"].map((n) => { const p = join(d, n); mkdirSync(p); writeFileSync(join(p, exe), ""); chmodSync(join(p, exe), 0o755); return p; });
  const versions: Record<string, string> = { [join(dirs[0], exe)]: "v16.20.0", [join(dirs[1], exe)]: "v22.1.0", [join(dirs[2], exe)]: "v20.9.0" };
  assert.equal(findNode(dirs.join(delimiter), (b) => versions[b]), join(dirs[1], exe));
  assert.equal(findNode(dirs[0], (b) => versions[b]), null);
  assert.ok(compareVersions([22, 1], [22, 0, 9]) > 0);
});

test("loadConfig: args are saved, a wrapper node keeps the server empty", () => {
  const d = mkdtempSync(join(tmpdir(), "vc-"));
  const file = join(d, "overlay.json");
  const wrapper = join(d, "visioncli-mcp");
  writeFileSync(wrapper, "#!/bin/sh\n"); chmodSync(wrapper, 0o755);
  writeFileSync(file, JSON.stringify({ cwd: "/proj", claude: "claude", path: "/usr/bin", node: wrapper }));
  const c = loadConfig({ argv: [], packaged: true, resourcesPath: d, buildDir: d, execPath: "/x/electron", file });
  assert.equal(c.cwd, "/proj");
  assert.equal(c.node, wrapper);
  assert.equal(c.server, null);
  assert.match(c.path, process.platform === "win32" ? /\.local\\bin/i : /\.local\/bin/);
  assert.deepEqual(serverArgs(c, ["quick", "x"]), ["quick", "x"]);
  assert.deepEqual(serverArgs({ server: "/s.mjs" }, ["warm"]), ["/s.mjs", "warm"]);

  const c2 = loadConfig({ argv: ["--cwd", "/other", "--server", "/nope"], packaged: false, buildDir: d, execPath: "/x/electron", file });
  assert.equal(c2.cwd, "/other");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cwd, "/other", "launch args are remembered");
});

test("electronNodeWrapper runs Electron as Node", () => {
  const d = mkdtempSync(join(tmpdir(), "vw-"));
  const f = electronNodeWrapper("/opt/it's/electron", d, "linux");
  const body = readFileSync(f, "utf8");
  assert.match(body, /ELECTRON_RUN_AS_NODE=1 exec '\/opt\/it'\\''s\/electron' "\$@"/);
  const cmd = readFileSync(electronNodeWrapper("C:\\Apps\\100%\\VisionCLI.exe", d, "win32"), "utf8");
  assert.equal(cmd, '@set ELECTRON_RUN_AS_NODE=1\r\n@"C:\\Apps\\100%%\\VisionCLI.exe" %*\r\n', "Windows: a .cmd, % doubled");
});

test("shots: pointer in image pixels, image → screen, marks", () => {
  const jpeg = { data: Buffer.alloc(0), width: 1000, height: 500 };
  const s = makeShot(jpeg, { x: 100, y: 50, width: 2000, height: 1000 }, "Code", { x: 1100, y: 550 });
  assert.deepEqual(s.pointer, { x: 500, y: 250 });
  assert.equal(makeShot(jpeg, { x: 0, y: 0, width: 10, height: 10 }, "x", { x: 50, y: 50 }).pointer, undefined);
  assert.deepEqual(screenPoint(s, { x: 500, y: 250 }), { x: 1100, y: 550 });
  const marks = drawMarks(Markup.marks("[[box:1:10,20,30,40:B]] [[arrow:1:30,40,10,20]] [[step:1:5,5:3:S]] [[circle:2:0,0,10,10]]"), [s]);
  assert.deepEqual(marks[0], { kind: "box", rect: { x: 120, y: 90, width: 40, height: 40 }, label: "B" });
  assert.deepEqual(marks[1].rect, { x: 160, y: 130, width: -40, height: -40 }, "arrows keep their direction");
  assert.deepEqual(marks[2], { kind: "step", rect: { x: 110, y: 60, width: 0, height: 0 }, label: "S", n: 3 });
  assert.equal(marks[3].kind, "circle", "an image number past the end uses the last shot");
  assert.deepEqual(drawMarks(Markup.marks("[[box:1:1,1,2,2]]"), []), []);
});

test("windows under the pointer skip terminals", () => {
  const wins = [win("1", "kitty", "zsh", 0, 0, 500, 500), win("2", "Code", "app.ts - shop", 0, 0, 1000, 800), win("3", "Firefox", "", 1000, 0, 500, 500)];
  assert.equal(rawWindowUnderPointer(wins, { x: 10, y: 10 })?.id, "1");
  assert.equal(windowUnderPointer(wins, { x: 10, y: 10 })?.id, "2");
  assert.equal(windowUnderPointer(wins, { x: 1200, y: 10 })?.id, "3");
  assert.equal(windowUnderPointer(wins, null)?.id, "2");
  assert.equal(windowLabel(wins[1]), 'Code — "app.ts - shop"');
  assert.equal(windowLabel(wins[2]), "Firefox");
  assert.equal(regionLabel(wins, { x: 1100, y: 10, width: 5, height: 5 }), "Selected area of Firefox");
  assert.equal(regionLabel([], { x: 0, y: 0, width: 5, height: 5 }), "Selected area of Screen");
});

test("question text: bubble and terminal tags", () => {
  const shot = { label: "Code", width: 1000, height: 500, pointer: { x: 5, y: 6 }, file: "/s/1.jpg" };
  assert.equal(voiceQuestion("why", "/p", [shot], null),
    "why\n\n[Voice question. Project: /p. Image 1: Code, 1000x500 px, mouse pointer at (5, 6), saved at /s/1.jpg.]");
  assert.match(voiceQuestion("why", "/p", [], "Firefox"), /No screenshot attached .*; the mouse is over Firefox\. If answering needs the screen/);
  assert.equal(terminalQuestion("fix it", { assistant: "claude", shots: [shot], paths: ["/s/1.jpg"], mouseOver: null }),
    "fix it [voice · screenshot /s/1.jpg (mouse at 5,6)]");
  assert.equal(terminalQuestion("hi", { assistant: "claude", shots: [], paths: [], mouseOver: null }), "hi [voice]");
  assert.equal(terminalQuestion("hi", { assistant: "claude", shots: [], paths: [], mouseOver: "Firefox" }), "hi [voice · mouse over Firefox]");
  const g = terminalQuestion("q", { assistant: "gemini", shots: [shot], paths: ["/c/1.png"], mouseOver: null });
  assert.ok(g.startsWith("q [voice · screenshot @/c/1.png  (mouse at 5,6) · "), g);
  assert.match(terminalQuestion("q", { assistant: "antigravity", shots: [shot], paths: ["/s/1.jpg"], mouseOver: null }), /View the screenshot file\(s\) first\./);
  assert.doesNotMatch(terminalQuestion("q", { assistant: "antigravity", shots: [], paths: [], mouseOver: null }), / · · /);
});

test("carryOver, links, HUD title", () => {
  const e = (q: string, project = "/p") => ({ date: "", project, question: q, answer: "A " + q, screenshots: [] });
  assert.equal(carryOver([e("new"), e("other", "/x"), e("old"), e("older")], "/p", "Q"),
    "Earlier in this conversation (for context):\nUser: old\nAssistant: A old\nUser: new\nAssistant: A new\n\nQ");
  assert.equal(carryOver([], "/p", "Q"), "Q");
  assert.deepEqual(parseOpenLink("visioncli://open?path=src/a%20b.ts&line=12"), { path: "src/a b.ts", line: 12 });
  assert.deepEqual(parseOpenLink("visioncli://open?path=/x.ts"), { path: "/x.ts", line: 1 });
  assert.equal(parseOpenLink("https://example.com"), null);
  assert.equal(hudTitle("x".repeat(41)), "x".repeat(40) + "…");
});

test("overlay keys: registered while live, one press per key", () => {
  const reg = new Set<string>();
  const cbs = new Map<string, () => void>();
  const api = { register: (a: string, cb: () => void) => { reg.add(a); cbs.set(a, cb); return true; }, unregister: (a: string) => { reg.delete(a); } };
  let now = 0;
  const fired: string[] = [];
  const k = new OverlayKeys(api, (x) => fired.push(x), () => now);
  k.set({ esc: true, pin: true });
  assert.deepEqual([...reg].sort(), ["Alt+P", "Escape"]);
  cbs.get("Escape")!();   // the X grab
  k.press("esc");         // the same press seen by evdev
  now = 1000;
  k.press("esc");
  k.press("open");        // not live
  assert.deepEqual(fired, ["esc", "esc"]);
  k.set({ esc: true });
  assert.deepEqual([...reg], ["Escape"]);
  k.clear();
  assert.equal(reg.size, 0);
  assert.equal(k.active, false);
});

test("task panel model", () => {
  const draws: string[] = [];
  const t = new TaskModel((steps, paused, title) => draws.push(`${title}:${paused}:${steps.map((s) => s.state).join(",")}`));
  t.reset("Open the menu");
  const a = t.begin("Click File");
  const b = t.begin("Waiting for you", true);
  t.update(a, "done");
  t.update(b, "declined");
  t.setPaused(true);
  assert.deepEqual(draws, ["Open the menu:false:running", "Open the menu:false:running,waiting", "Open the menu:false:done,waiting",
    "Open the menu:false:done,declined", "Open the menu:true:done,declined"]);
  for (let i = 0; i < 50; i++) t.begin("x");
  assert.equal(t.steps.length, 40);
});

test("keyboard delivery finds the emulator window above the CLI", () => {
  const parents: Record<number, number> = { 500: 400, 400: 300, 300: 1 };
  assert.deepEqual(ancestorPids(500, (p) => parents[p] ?? null), [500, 400, 300]);
  const wins = [win("1", "Firefox", "", 0, 0, 1, 1, 77), win("2", "Terminal", "zsh", 0, 0, 1, 1, 300)];
  assert.equal(emulatorWindow(wins, [500, 400, 300])?.id, "2");
  assert.equal(emulatorWindow(wins, [9]), null);
});

test("the control card preview", () => {
  assert.equal(cardPreview({ detail: [{ text: "hello", kind: "added" }, { text: "Sensitive", kind: "removed" }, { text: "Esc stops", kind: "context" }] }),
    "+ hello\n- Sensitive\n  Esc stops");
});

test("voice instructions only when asked for, and junk transcripts", () => {
  const q = (brief?: boolean) => terminalQuestion("q", { assistant: "antigravity", shots: [], paths: [], mouseOver: null, brief });
  assert.match(q(), /Asked out loud/);
  assert.equal(q(false), "q [voice]");
  for (const junk of ["-", " … ", "[BLANK_AUDIO]", "(music)", "*silence*", ""]) assert.equal(meaningful(junk), false, junk);
  for (const ok of ["Can you hear me?", "2", "écoute", "Um, open the file"]) assert.equal(meaningful(ok), true, ok);
  for (const filler of ["Mm-hmm.", "Uh", "Hmm…", "um um"]) assert.equal(meaningful(filler), false, filler);
  assert.equal(cleanTranscript(" - Hello, How are you?\n"), "Hello, How are you?");
  assert.equal(cleanTranscript("— don't stop"), "don't stop");
});

test("idle voice models unload: Kokoro after 10 minutes (not mid-sentence), speech after 30", () => {
  assert.deepEqual(idleUnload(5 * 60_000, false), { speech: false, voice: false });
  assert.deepEqual(idleUnload(11 * 60_000, false), { speech: false, voice: true });
  assert.deepEqual(idleUnload(11 * 60_000, true), { speech: false, voice: false });
  assert.deepEqual(idleUnload(31 * 60_000, false), { speech: true, voice: true });
});

test("Windows: the saved Path from the registry, %VARS% expanded (finds CLIs installed after launch)", () => {
  const out: Record<string, string> = {
    "HKCU\\Environment": "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n\r\n",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment": "\r\n    Path    REG_SZ    C:\\Windows\\system32;%SystemRoot%\r\n",
  };
  const path = registryPath({ userprofile: "C:\\Users\\me", SystemRoot: "C:\\Windows" }, (k) => out[k] ?? "");
  assert.equal(path, "C:\\Users\\me\\.local\\bin;C:\\Tools;C:\\Windows\\system32;C:\\Windows");
  assert.equal(registryPath({}, () => ""), "");
});

test("the saved PATH is merged with this launch's (CLIs installed after the first run are found)", () => {
  assert.equal(mergePath("/usr/bin:/bin", "/bin:/home/me/.local/bin", "linux"), "/usr/bin:/bin:/home/me/.local/bin");
  assert.equal(mergePath("C:\\Windows;C:\\Tools", "c:\\tools;C:\\Users\\me\\AppData\\Local\\agy\\bin", "win32"),
    "C:\\Windows;C:\\Tools;C:\\Users\\me\\AppData\\Local\\agy\\bin");
  assert.equal(mergePath(null, "/bin", "linux"), "/bin");
});
