import { TEST_HOME } from "./_env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AnswerHandlers } from "../../src/main/contracts";
import { resolveConfig } from "../../src/main/assistant/config";
import { agentTranscript, stableHash, TerminalSession } from "../../src/main/assistant/terminal";
import { describe, permissionPreview, permissionTitle } from "../../src/main/assistant/describe";
import { ActivityLog, BufferedActivity } from "../../src/main/terminal/activity";
import { parseCmdline, parseStat, ttyName } from "../../src/main/terminal/procs";
import {
  agyConversation, agyTranscript, claudeDir, gitRoot, isHeadless, lastModel, matches, newestSession, sessionFile,
} from "../../src/main/terminal/transcripts";
import { settings } from "../../src/main/settings";

const cfg = resolveConfig({ node: "node", server: "s", path: "/usr/bin:/bin", claude: "claude", agy: null, gemini: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const activityFile = join(TEST_HOME, "activity.log");
const activity = new BufferedActivity(new ActivityLog(activityFile));

function handlers() {
  const got: { tools: [string, string | undefined][]; done?: { text: string }; error?: string; waiting: number } = { tools: [], waiting: 0 };
  let resolve!: () => void;
  // bounded: a transcript the session never sees fails the test instead of hanging the file
  const finished = new Promise<void>((r, j) => { resolve = r; setTimeout(() => j(new Error("no answer within 15 s")), 15_000).unref(); });
  const h: AnswerHandlers = {
    onText() {},
    onTool: (n, d) => got.tools.push([n, d]),
    onPermission: async () => "deny",
    onDone: (r) => { got.done = r; resolve(); },
    onError: (m) => { got.error = m; resolve(); },
    onWaitingInTerminal: () => got.waiting++,
  };
  return { h, got, finished };
}

/** Puts a session into "waiting for this question" without typing anywhere (delivery is tested in Docker). */
function await_(t: TerminalSession, marker: string, h: AnswerHandlers) {
  const s = t as unknown as { awaiting: string; seenQuestion: boolean; finalText: string; h: AnswerHandlers; agyDiscover: boolean; skipToEnd(): void; startWatching(): void };
  s.awaiting = marker;
  s.seenQuestion = false;
  s.finalText = "";
  s.h = h;
  s.agyDiscover = t.cli === "agy";
  s.skipToEnd();
  s.startWatching();
}

test("procs: stat, tty numbers, cmdline", () => {
  const st = parseStat("4242 (claude (x) y) S 4200 4242 4100 34817 4242 4194560 1 0 0 0");
  assert.deepEqual(st, { pid: 4242, comm: "claude (x) y", ppid: 4200, pgrp: 4242, tty: "pts/1", tpgid: 4242 });
  assert.equal(ttyName(0), null);
  assert.equal(ttyName((137 << 8) | 44), "pts/300");
  assert.equal(ttyName((4 << 8) | 2), "tty2");
  assert.deepEqual(parseCmdline("node\0/usr/lib/gemini\0--resume\0"), ["node", "/usr/lib/gemini", "--resume"]);
  assert.deepEqual(parseCmdline("claude --resume abc" + "\0".repeat(5)), ["claude", "--resume", "abc"]);
});

test("transcripts: which processes are CLIs", () => {
  assert.ok(matches("claude", ["claude"]));
  assert.ok(matches("claude", ["/home/u/.local/bin/claude", "--resume", "x"]));
  assert.ok(matches("gemini", ["node", "/usr/lib/node_modules/.bin/gemini"]));
  assert.ok(matches("claude", ["/bin/bash", "/usr/local/bin/claude", "--session-id", "x"]));
  assert.ok(!matches("claude", ["vim", "claude.md"]));
  assert.ok(matches("agy", ["agy", "--conversation", "c"]));
  assert.ok(isHeadless(["claude", "-p", "--output-format", "stream-json"]));
  assert.ok(!isHeadless(["claude", "--resume", "x"]));
});

test("transcripts: session files under a synthetic HOME", () => {
  const project = join(TEST_HOME, "work", "app");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(project, "src/deep"), { recursive: true });
  assert.equal(gitRoot(join(project, "src/deep")), project);
  assert.equal(gitRoot(join(TEST_HOME, "elsewhere")), join(TEST_HOME, "elsewhere"));

  const dir = claudeDir(project);
  assert.ok(dir.endsWith(project.replace(/[^A-Za-z0-9]/g, "-")));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.jsonl"), "");
  writeFileSync(join(dir, "new.jsonl"), [
    JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5", content: [] } }),
    JSON.stringify({ type: "assistant", message: { model: "claude-haiku-5-5", content: [] } }),
    JSON.stringify({ type: "user", message: { content: "x" } }),
  ].join("\n") + "\n");
  utimesSync(join(dir, "old.jsonl"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(newestSession("claude", project), "new");
  assert.equal(sessionFile("claude", project, "new"), join(dir, "new.jsonl"));
  assert.equal(sessionFile("claude", project, "missing"), undefined);
  assert.equal(lastModel(join(dir, "new.jsonl")), "claude-haiku-5-5");

  // Gemini: chats under the path's SHA-256, matched by the header's projectHash / sessionId.
  const hash = createHash("sha256").update(project).digest("hex");
  const chats = join(TEST_HOME, ".gemini/tmp", hash, "chats");
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, "session-2026-10-13T09-12-deadbeef.jsonl"), JSON.stringify({ sessionId: "deadbeef-1111", projectHash: hash }) + "\n");
  assert.equal(newestSession("gemini", project), "deadbeef-1111");
  assert.ok(sessionFile("gemini", project, "deadbeef-1111")?.endsWith("deadbeef.jsonl"));

  // agy: found by the question text in a recently written transcript.
  const t = agyTranscript("conv-42");
  mkdirSync(join(t, ".."), { recursive: true });
  writeFileSync(t, JSON.stringify({ type: "USER_INPUT", content: "why is the build red [voice]" }) + "\n");
  assert.equal(agyConversation("why is the build red"), "conv-42");
  assert.equal(agyConversation("something else"), undefined);
  // A Windows screenshot path is JSON-escaped in the transcript (\\ for \): still found.
  const w = agyTranscript("conv-win");
  mkdirSync(join(w, ".."), { recursive: true });
  const q = "What do you see? [voice · screenshot C:\\Users\\me\\shots\\1.jpg (mouse at 5,6)]";
  writeFileSync(w, JSON.stringify({ type: "USER_INPUT", content: q }) + "\n");
  assert.equal(agyConversation(q), "conv-win");
});

test("terminal: follows a Claude transcript to the end of the turn", async () => {
  const project = join(TEST_HOME, "proj-claude");
  const t = new TerminalSession(project, "claude", cfg, { activity, pollMs: 20 });
  assert.equal(settings.getStore(`terminalSession:${project}`), t.sessionId());
  const file = t.transcriptPath()!;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "user", message: { content: "an older question" } }) + "\n"); // skipped
  const { h, got, finished } = handlers();
  const question = "what does this function do [voice · screenshot /tmp/a.jpg]";
  await_(t, question.slice(0, 60), h);
  assert.equal(t.busy, true);
  const w = (o: unknown) => appendFileSync(file, JSON.stringify(o) + "\n");
  w({ type: "user", message: { role: "user", content: question } });
  w({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent noise" }] } });
  w({ type: "assistant", message: { content: [{ type: "text", text: "Let me read it." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/src/util.ts" } }] } });
  w({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a\nb" }] }] } });
  // A line written in two pieces: the partial first half waits for the rest.
  const line = JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "It parses the config." }] } });
  appendFileSync(file, line.slice(0, 30));
  await sleep(60);
  appendFileSync(file, line.slice(30) + "\n");
  w({ type: "system", subtype: "turn_duration", durationMs: 1234 });
  await finished;
  assert.equal(got.done?.text, "It parses the config.");
  assert.deepEqual(got.tools, [["Read", "Reading util.ts…"]]);
  assert.equal(t.busy, false);
  activity.flush();
  const feed = readFileSync(activityFile, "utf8");
  assert.ok(feed.includes("\x1b[35mtool Read \x1b[0m/p/src/util.ts"));
  assert.ok(feed.includes("   └ 2 lines"));
});

test("terminal: end_turn without the summary still finishes; approvals waiting in the terminal are reported", async () => {
  const project = join(TEST_HOME, "proj-claude-2");
  const t = new TerminalSession(project, "claude", cfg, { activity, pollMs: 20 });
  const file = t.transcriptPath()!;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "");
  const { h, got, finished } = handlers();
  await_(t, "fix the typo", h);
  const w = (o: unknown) => appendFileSync(file, JSON.stringify(o) + "\n");
  w({ type: "user", message: { content: [{ type: "text", text: "fix the typo [voice]" }] } });
  w({ type: "assistant", message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/p/README.md" } }] } });
  await sleep(1700); // nothing written for 1.5 s after an Edit: it's waiting for approval in the terminal
  assert.equal(got.waiting, 1);
  assert.deepEqual(got.tools.at(-1), ["Edit", "Running Edit… approve in the Claude terminal if asked"]);
  w({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok" }] } });
  w({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Fixed." }] } });
  await finished;
  assert.equal(got.done?.text, "Fixed.");
});

test("terminal: Gemini and agy transcripts", async () => {
  const project = join(TEST_HOME, "proj-gem");
  const g = new TerminalSession(project, "gemini", cfg, { activity, pollMs: 20 });
  const sid = g.sessionId();
  const hash = createHash("sha256").update(project).digest("hex");
  const chats = join(TEST_HOME, ".gemini/tmp", hash, "chats");
  mkdirSync(chats, { recursive: true });
  const file = join(chats, `session-2026-10-13T10-00-${sid.slice(0, 8)}.jsonl`);
  writeFileSync(file, JSON.stringify({ sessionId: sid, projectHash: hash }) + "\n");
  const a = handlers();
  await_(g, "list the routes", a.h);
  const w = (o: unknown) => appendFileSync(file, JSON.stringify(o) + "\n");
  w({ type: "user", content: [{ text: "list the routes [voice]" }] });
  w({ type: "gemini", id: "m1", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { absolute_path: "/p/routes.ts" } }] });
  w({ type: "gemini", id: "m1", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { absolute_path: "/p/routes.ts" } }] }); // re-written: once
  w({ type: "gemini", id: "m2", content: "There are three routes." });
  await a.finished;
  assert.equal(a.got.done?.text, "There are three routes.");
  assert.deepEqual(a.got.tools, [["read_file", "Reading routes.ts…"]]);

  const y = new TerminalSession(join(TEST_HOME, "proj-agy"), "agy", cfg, { activity, pollMs: 20 });
  const b = handlers();
  await_(y, "explain the cache layer", b.h);
  await sleep(100);
  const tr = agyTranscript("conv-agy-1");
  mkdirSync(join(tr, ".."), { recursive: true });
  const wa = (o: unknown) => appendFileSync(tr, JSON.stringify(o) + "\n");
  wa({ type: "USER_INPUT", content: "explain the cache layer [voice]" });
  wa({ type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "call_mcp_tool", args: { ToolName: "look" } }] });
  wa({ type: "GENERIC", content: "screenshot" });
  wa({ type: "PLANNER_RESPONSE", status: "DONE", content: "It's an LRU in front of Redis." });
  await b.finished;
  assert.equal(b.got.done?.text, "It's an LRU in front of Redis.");
  assert.equal(y.sessionId(), "conv-agy-1");
  assert.equal(settings.getStore(`terminalSession:antigravity:${join(TEST_HOME, "proj-agy")}`), "conv-agy-1");
});

// Windows writes a .cmd launch script instead (tested in win-features/terminal.test.ts)
test("terminal: launch script", { skip: process.platform === "win32" && "the POSIX sh launch script" }, () => {
  settings.set("effort", "high");
  settings.set("model", "opus");
  const project = join(TEST_HOME, "it's a project");
  const t = new TerminalSession(project, "claude", cfg, { activity });
  const { script, where, id } = t.openScript();
  const body = readFileSync(script, "utf8");
  assert.ok(body.startsWith("#!/bin/sh\n"));
  assert.ok(body.includes(`cd '${project.replace("'", `'\\''`)}'`));
  assert.ok(body.includes(`--append-system-prompt "$(cat '`));
  assert.ok(body.includes("--allowedTools Read Grep Glob mcp__visioncli__look"));
  assert.ok(body.includes("--effort high"));
  assert.ok(body.includes("--model 'opus'"));
  assert.ok(body.includes(`--session-id ${t.sessionId()}`)); // no transcript yet: a new session with our id
  assert.ok(body.includes(where));
  assert.equal(id, stableHash(project));
  settings.set("effort", null);
  settings.set("model", "default");
});

test("terminal: stable names, prompt detection", () => {
  // Same as Swift's `project.utf8.reduce(5381) { $0 &* 33 &+ $1 }` (UInt64, wrapping).
  assert.equal(stableHash("/home/me/proj"), "1257409565501412264");
  assert.ok(TerminalSession.promptReady("╭───╮\n│ > \n? for shortcuts"));
  assert.ok(!TerminalSession.promptReady("Loading…"));
});

test("describe and approval cards", () => {
  assert.equal(describe("Read", { file_path: "/a/b/c.ts" }), "Reading c.ts…");
  assert.equal(describe("Grep", { pattern: "x".repeat(50) }), `Searching for “${"x".repeat(40)}”…`);
  assert.equal(describe("mcp__visioncli__click", {}), "Using your computer…");
  assert.equal(describe("write_to_file", { TargetFile: "/x/y.md" }), "Editing y.md…");
  assert.equal(describe("view_file", {}), "Looking at a file…");
  assert.equal(describe("something", {}), "Working…");
  const edit = { id: "1", tool: "Edit", input: { file_path: "/p/a.ts", old_string: "one\ntwo", new_string: "uno" } };
  assert.equal(permissionTitle(edit, "Claude"), "Claude wants to edit a.ts");
  assert.equal(permissionPreview(edit), "- one\n- two\n+ uno");
  assert.equal(permissionTitle({ id: "2", tool: "Write", input: { file_path: join(TEST_HOME, "nope.txt") } }, "Claude"), "Claude wants to create nope.txt");
  assert.equal(permissionTitle({ id: "3", tool: "mcp__visioncli__browser_click", input: {} }, "Gemini"), "Gemini wants to use browser_click");
  assert.equal(permissionPreview({ id: "4", tool: "Bash", input: { command: "npm test" } }), "  $ npm test");
  const long = permissionPreview({ id: "5", tool: "Write", input: { content: Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n") } });
  assert.equal(long.split("\n").length, 11);
  assert.ok(long.endsWith("  … 2 more lines"));
});

test("activity feed: same ANSI layout as macOS", () => {
  const file = join(TEST_HOME, "feed.log");
  const a = new ActivityLog(file);
  a.question("why is this red", "/home/u/app", [{ label: "Code — main.ts", width: 1568, height: 980, pointer: { x: 10.7, y: 20 } }]);
  a.text("Because ");
  a.text("the test fails.");
  a.tool("Bash", { command: "npm test" });
  a.toolResult("ok\nfine", false, "Bash");
  a.permission("Claude wants to run a command", null);
  a.permission("x", true);
  a.done(0.01234);
  a.error("boom");
  const out = readFileSync(file, "utf8").split("\n");
  assert.match(out[1], /^\x1b\[2m━━━ .+ · app ━{40}\x1b\[0m$/);
  assert.equal(out[2], "\x1b[1;36mYou: \x1b[0m\x1b[1mwhy is this red\x1b[0m");
  assert.equal(out[3], "\x1b[2m   screenshot: Code — main.ts (1568×980, pointer at 10,20)\x1b[0m");
  assert.equal(out[4], "\x1b[1;32mClaude: \x1b[0mBecause the test fails.");
  assert.equal(out[5], "\x1b[35mtool Bash \x1b[0m\x1b[33m$ npm test\x1b[0m");
  assert.equal(out[6], "\x1b[2m   │ ok\x1b[0m");
  assert.equal(out[8], "\x1b[1;33mWaiting for you: Claude wants to run a command? (in the bubble)\x1b[0m");
  assert.equal(out[9], "\x1b[32m   ✓ allowed\x1b[0m");
  assert.equal(out[10], "\x1b[2m   ($0.0123)\x1b[0m");
  assert.equal(out[11], "\x1b[31mError: boom\x1b[0m");
});

test("a question typed while a background agent is viewed is found in that agent's transcript", () => {
  const main = join(TEST_HOME, "agent-case", "s1.jsonl");
  const dir = join(TEST_HOME, "agent-case", "s1", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(main, "");
  const before = JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "earlier" }] } }) + "\n";
  const question = JSON.stringify({ type: "user", isSidechain: true, message: { content: "The user sent a new message while you were working:\nLooking at this [voice]" } }) + "\n";
  writeFileSync(join(dir, "agent-a1.jsonl"), before + question);
  writeFileSync(join(dir, "agent-a2.jsonl"), before);
  const found = agentTranscript(main, "Looking at this [voice]");
  assert.equal(found?.file, join(dir, "agent-a1.jsonl"));
  assert.equal(found?.offset, Buffer.byteLength(before));
  assert.equal(agentTranscript(main, "not asked"), null);
});
