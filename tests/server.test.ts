import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, test } from "node:test";
import { server } from "../src/server.js";

// The tool list is the server's public surface (Claude Code and Antigravity allow rules name these tools).
const TOOLS = [
  "look", "list_windows", "select_region", "clipboard_image", "device_screenshot",
  "db_schema", "db_query",
  "browser_tabs", "browser_open", "browser_switch_tab", "browser_navigate", "browser_read", "browser_elements",
  "browser_click", "browser_type", "browser_select", "browser_scroll", "browser_task",
  "ui_elements", "click", "type_text", "press_keys", "scroll", "drag", "open_app", "open_url", "announce",
  "start_voice",
];

describe("MCP server", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);

  test("lists every tool, in order", async () => {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), TOOLS);
  });

  test("read-only tools are marked read-only", async () => {
    const ro = (await client.listTools()).tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    assert.deepEqual(ro, ["look", "list_windows", "select_region", "clipboard_image", "device_screenshot", "db_schema", "db_query",
      "browser_tabs", "browser_read", "browser_elements", "ui_elements"]);
  });

  test("prompts", async () => {
    assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ["see", "point"]);
  });

  test("a tool error comes back as an error result, not a protocol error", async () => {
    const r = await client.callTool({ name: "db_query", arguments: { sql: "drop table users" } });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0].text, /Read-only/);
  });

  test("click without a target explains what's missing", async () => {
    const r = await client.callTool({ name: "click", arguments: {} });
    assert.equal(r.isError, true);
    assert.equal((r.content as { text: string }[])[0].text, "Give an element id or x and y.");
  });

  test("teardown", async () => { await client.close(); });
});
