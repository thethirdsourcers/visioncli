// Ported from overlay/Tests/main.swift: QuickCommandFilter, SlashCommand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QuickCommandFilter, SlashCommand } from "../../src/main/core/routing";

test("QuickCommandFilter", () => {
  const yes = ["open github", "Open GitHub.", "please click sign in", "can you scroll down", "hey go back",
    "okay now search for cats", "Google the weather", "sign in", "log out", "new tab", "type hello world"];
  for (const t of yes) assert.ok(QuickCommandFilter.matches(t), `accepts "${t}"`);
  const no = ["open github?", "what is this?", "why does this fail", "explain the payment flow",
    "open the file and then tell me why the tests in this folder fail on CI every time", "",
    "the button", "hello", "please", "is it open"];
  for (const t of no) assert.ok(!QuickCommandFilter.matches(t), `rejects "${t}"`);
  assert.ok(!QuickCommandFilter.matches("create a CV for me"), "create alone isn't a browser command");
  assert.ok(QuickCommandFilter.matches("create a CV for me", true), "with the browser in front it is");
  assert.ok(!QuickCommandFilter.matches("why does create fail", true), "questions still go to the assistant");
  assert.ok(QuickCommandFilter.isBrowser("google-chrome Google Chrome") && QuickCommandFilter.isBrowser("brave-browser") && QuickCommandFilter.isBrowser("msedge.exe"));
  assert.ok(!QuickCommandFilter.isBrowser("code Visual Studio Code"));
  assert.ok(QuickCommandFilter.matches("open a b c d e f g h i j k l m n o p q r s"), "20 words is still short");
  assert.ok(!QuickCommandFilter.matches("open a b c d e f g h i j k l m n o p q r s t"), "21 words is too long");
  assert.ok(QuickCommandFilter.matches("find a stay in Lisbon for 3 nights with a pool and free cancellation, then open it"), "a browser task");
  assert.ok(!QuickCommandFilter.matches("open the settings and explain the timeout"), "question words go to the assistant");
});

test("SlashCommand", () => {
  assert.equal(SlashCommand.parse("/compact"), "/compact", "typed command");
  assert.equal(SlashCommand.parse("Slash model haiku."), "/model haiku", "spoken slash, trailing period");
  assert.equal(SlashCommand.parse("forward slash Effort High!"), "/effort high", "forward slash, lowercased");
  assert.equal(SlashCommand.parse("Slash model, Sonnet"), "/model sonnet", "comma after the name dropped");
  assert.equal(SlashCommand.parse("  /Clear  "), "/clear", "trimmed and lowercased");
  assert.equal(SlashCommand.parse("what does slash compact do"), null, "slash in the middle is a question");
  assert.equal(SlashCommand.parse("/"), null, "bare slash");
  assert.equal(SlashCommand.parse("slash"), null, "the word alone");
  assert.equal(SlashCommand.parse("/" + "a".repeat(60)), null, "too long");
  assert.equal(SlashCommand.parse("/model\nhaiku"), null, "multi-line");
  // Swift's split(separator:maxSplits:) skips an empty piece and keeps the rest as is.
  assert.equal(SlashCommand.parse("/model  haiku"), "/model  haiku", "double space kept in the argument");
  assert.equal(SlashCommand.parse("/model ."), "/model", "trailing space after punctuation removed");
});
