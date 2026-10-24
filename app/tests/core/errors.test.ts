// The error watcher (ErrorWatcher.swift lastError): which screens hold an error, and the snippet sent to the assistant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cwdPath, ErrorWatcher, lastError, type Pane } from "../../src/main/terminal/errors";

test("lastError: Node stack trace, from the command that failed", () => {
  const screen = [
    "~/shop ❯ ls", "package.json  src", "~/shop ❯ npm run dev", "> shop@1.0.0 dev", "> node src/index.js",
    "/home/me/shop/src/index.js:3", "TypeError: Cannot read properties of undefined (reading 'port')",
    "    at Object.<anonymous> (/home/me/shop/src/index.js:3:20)", "~/shop ❯ ",
  ].join("\n");
  const e = lastError(screen)!;
  assert.equal(e.line, "TypeError: Cannot read properties of undefined (reading 'port')");
  assert.ok(e.text.startsWith("~/shop ❯ npm run dev"), "starts at the last prompt above the error");
  assert.ok(!e.text.includes("package.json"), "earlier commands left out");
});

test("lastError: Python traceback padded with blank lines", () => {
  const screen = ["$ python app.py", "Traceback (most recent call last):", '  File "app.py", line 1, in <module>',
    "ModuleNotFoundError: No module named 'flask'", "$ ", ...Array(60).fill("")].join("\n");
  const e = lastError(screen)!;
  assert.ok(e, "the error is found above 60 empty lines");
  assert.equal(e.line, "ModuleNotFoundError: No module named 'flask'", "the last error line wins");
  assert.ok(e.text.startsWith("$ python app.py"));
});

test("lastError: Rust, Go, shells; no error, no prompt", () => {
  assert.equal(lastError("$ cargo build\nerror[E0425]: cannot find value `x` in this scope\n")!.line, "error[E0425]: cannot find value `x` in this scope");
  assert.equal(lastError("panic: runtime error: index out of range")!.line, "panic: runtime error: index out of range");
  assert.equal(lastError("zsh: command not found: pnpmm")?.line, undefined, "zsh puts the name after the colon");
  assert.equal(lastError("bash: pnpmm: command not found")!.line, "bash: pnpmm: command not found");
  assert.equal(lastError("$ ls\nREADME.md\n$ git status\nnothing to commit\n\n\n"), null, "no error");
  const noPrompt = Array.from({ length: 15 }, (_, i) => `line ${i}`).concat("Error: boom").join("\n");
  assert.equal(lastError(noPrompt)!.text.split("\n")[0], "line 5", "the 10 lines before it without a prompt");
});

test("lastError: only the last 40 lines count", () => {
  const screen = ["Error: old"].concat(Array(45).fill("ok")).join("\n");
  assert.equal(lastError(screen), null);
});

test("cwdPath", () => {
  assert.equal(cwdPath("file://host/home/me/my%20app"), "/home/me/my app");
  assert.equal(cwdPath("file:///C:/Users/me/app"), "C:/Users/me/app");
  assert.equal(cwdPath("/srv/x"), "/srv/x");
  assert.equal(cwdPath(undefined), null);
});

test("ErrorWatcher: errors at launch ignored, each new one offered once, off means no reading", async () => {
  let panes: Pane[] = [{ id: "a", name: "dev", folder: "/p", text: "$ npm test\nError: old" }];
  let on = true, reads = 0;
  const w = new ErrorWatcher(() => on, async () => { reads++; return panes; });
  const offered: string[] = [];
  w.onError = (e) => offered.push(e.text);
  await w.poll();
  assert.deepEqual(offered, [], "already on screen at launch");
  panes = [{ id: "a", name: "dev", folder: "/p", text: "$ npm test\nError: old\n$ npm test\nError: new" }];
  await w.poll();
  await w.poll();
  assert.deepEqual(offered, ["$ npm test\nError: new"], "offered once");
  on = false;
  await w.poll();
  assert.equal(reads, 3, "nothing read while off");
});
