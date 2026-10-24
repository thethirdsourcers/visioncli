// Add-ons for Claude Code (AddOns.swift): the installed checks, and the setup step's state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADD_ONS, AddOns, mcpServerInstalled, pluginInstalled } from "../../src/main/features/addons";
import { stateOf } from "../../src/renderer/setup/steps";
import type { SettingsSnapshot } from "../../src/main/ui/windows/types";

test("add-ons: installed checks read the plugin list and ~/.claude.json's MCP servers", () => {
  const dir = mkdtempSync(join(tmpdir(), "addons-"));
  const plugins = join(dir, "installed_plugins.json"), claude = join(dir, ".claude.json");
  assert.equal(pluginInstalled("ponytail@ponytail", plugins), false, "no file");
  writeFileSync(plugins, JSON.stringify({ version: 2, plugins: { "ponytail@ponytail": [{ scope: "user" }] } }));
  assert.equal(pluginInstalled("ponytail@ponytail", plugins), true, "v2 layout");
  writeFileSync(plugins, JSON.stringify({ "claude-mem@thedotmack": {} }));
  assert.equal(pluginInstalled("claude-mem@thedotmack", plugins), true, "flat layout");
  writeFileSync(claude, JSON.stringify({ mcpServers: { context7: { command: "npx" } } }));
  assert.equal(mcpServerInstalled("context7", claude), true);
  assert.equal(mcpServerInstalled("other", claude), false);
  writeFileSync(claude, "{ not json");
  assert.equal(mcpServerInstalled("context7", claude), false, "unreadable file");
});

test("add-ons: the macOS list, all through Claude Code or uv; a missing claude fails without running anything", async () => {
  assert.deepEqual(ADD_ONS.map((a) => a.id), ["ponytail", "graphify", "claude-mem", "context7", "security-guidance"]);
  assert.ok(ADD_ONS.every((a) => a.steps.every((s) => ["claude", "uv", "graphify"].includes(s[0]))), "never agy");
  const a = new AddOns([{ id: "x", title: "X", detail: "", steps: [["claude", "plugin", "install", "x"]], isInstalled: () => false }]);
  let changes = 0;
  a.onChange = () => changes++;
  a.install("x", "/nonexistent/claude", "");
  assert.ok(a.installing.has("x"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.errors.x, "claude isn't installed");
  assert.equal(a.installing.size, 0);
  assert.equal(changes, 2);
});

test("setup: the Add-ons step is optional until every add-on is installed", () => {
  const snap = (installed: boolean[]) => ({ addOns: installed.map((i, n) => ({ id: String(n), installed: i })) }) as unknown as SettingsSnapshot;
  assert.equal(stateOf("addons", "addons", {}, snap([true, false])), "optional");
  assert.equal(stateOf("addons", "addons", {}, snap([true, true])), "done");
});
