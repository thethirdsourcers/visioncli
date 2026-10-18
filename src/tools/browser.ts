import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as browser from "../browser.js";
import { guideFor } from "../sites.js";
import { errorResult, text } from "./common.js";

const wrap = <A,>(fn: (args: A) => Promise<string>) => async (args: A) => {
  try {
    return text(await browser.serial(() => fn(args))); // one browser call at a time (element ids, "window 1")
  } catch (err) {
    return errorResult(err);
  }
};

/** Brave/Chrome through AppleScript: the browser_* tools. */
export function register(server: McpServer) {
  server.registerTool(
    "browser_tabs",
    {
      title: "List browser tabs",
      description: "Open tabs in the front-most Brave/Chrome (ids like t1.3 = window 1, tab 3), marking the active one.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const b = await browser.pick();
      return `${b}\n` + (await browser.tabs(b)).map((t) => `${t.id}${t.active ? " (active)" : ""}\t${t.title}\t${t.url}`).join("\n");
    }),
  );

  server.registerTool(
    "browser_open",
    {
      title: "Open a URL",
      description:
        "Open a URL in Chrome/Brave. Always use this (never ⌘L/⌘T + typing) to go to a page: it switches to a tab already showing it, " +
        "otherwise reuses your own working tab, and only opens one new tab the first time. new_tab: false loads it in the user's current tab.",
      inputSchema: { url: z.string(), new_tab: z.boolean().default(true) },
    },
    wrap(async ({ url, new_tab }) => browser.open(url, new_tab)),
  );

  server.registerTool(
    "browser_switch_tab",
    {
      title: "Switch tab",
      description: "Bring a tab (id from browser_tabs) to the front.",
      inputSchema: { tab_id: z.string() },
    },
    wrap(async ({ tab_id }) => {
      await browser.switchTo(tab_id);
      return `Switched to ${tab_id}`;
    }),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Back / forward / reload / close tab / new tab",
      description: "Navigate the active tab.",
      inputSchema: { action: z.enum(["back", "forward", "reload", "close", "new"]) },
    },
    wrap(async ({ action }) => {
      await browser.navigate(action);
      return `Done: ${action}`;
    }),
  );

  server.registerTool(
    "browser_read",
    {
      title: "Read the current page",
      description: "Title, URL, selected text and readable text of the active tab (capped). Faster and more exact than a screenshot.",
      inputSchema: { max_chars: z.number().int().min(500).max(50000).default(6000).describe("Raise it (up to 50000) only if the text you need was cut off") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ max_chars }) => {
      const page = await browser.read(max_chars);
      // The first page of a big app (NetSuite…) comes with how to get around it.
      const guide = guideFor(page.split("\n")[1]);
      return guide ? `${page}\n\n${guide}` : page;
    }),
  );

  server.registerTool(
    "browser_elements",
    {
      title: "List clickable elements",
      description: "Visible links, buttons, fields, dropdowns (with options) and toggles (with on/off state) on the active page, with ids (e1, e2, …) for browser_click / browser_type / browser_select.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      const list = (await browser.elements())
        .map((e) =>
          [e.id, e.kind, e.text, e.state && `[${e.state}]`, e.expanded !== undefined && (e.expanded ? "[open]" : "[closed]"),
            e.value !== undefined && `value: ${e.value}`, e.options && `options: ${e.options.join(" | ")}`, e.href]
            .filter(Boolean).join("\t"))
        .join("\n") || "(none)";
      const guide = guideFor((await browser.activeTab().catch(() => undefined))?.url);
      return guide ? `${list}\n\n${guide}` : list;
    }),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click an element",
      description: "Click an element by id from browser_elements (or by its visible text).",
      inputSchema: { target: z.string().describe("Element id like e12, or visible text") },
    },
    wrap(async ({ target }) => `Clicked “${await browser.click(target)}”`),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type into a field",
      description: "Set the value of a form field (id from browser_elements), optionally submitting the form.",
      inputSchema: { target: z.string(), text: z.string(), submit: z.boolean().default(false) },
    },
    wrap(async ({ target, text: value, submit }) => {
      await browser.type(target, value, submit);
      return `Typed into ${target}${submit ? " and submitted" : ""}`;
    }),
  );

  server.registerTool(
    "browser_select",
    {
      title: "Choose a dropdown option",
      description:
        "Pick an option in a dropdown (native <select> or custom combobox/menu) by its visible text. Use this instead of browser_click for dropdowns. " +
        "Toggles/switches/checkboxes: use browser_click (browser_elements shows their on/off state).",
      inputSchema: { target: z.string().describe("Dropdown id from browser_elements"), option: z.string().describe("Option text") },
    },
    wrap(async ({ target, option }) => browser.select(target, option)),
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover over an element",
      description: "Hover over an element (id from browser_elements) to show what appears on hover: menus, captions, tooltips. " +
        "Then call browser_elements to see and click what appeared.",
      inputSchema: { target: z.string().describe("Element id like e12, or its visible text / image description") },
    },
    wrap(async ({ target }) => `Hovering over “${await browser.hover(target)}”`),
  );

  server.registerTool(
    "browser_drag",
    {
      title: "Drag and drop",
      description: "Drag an element onto another (ids from browser_elements, which lists draggables, or visible text): " +
        "sorting lists, boards, upload drop zones, sliders built from divs. Returns the target's text afterwards.",
      inputSchema: { from: z.string().describe("What to drag: id or visible text"), to: z.string().describe("Where to drop it: id or visible text") },
    },
    wrap(async ({ from, to }) => `Dragged onto “${await browser.drag(from, to)}”`),
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill in a form",
      description:
        "Fill several fields of a form in one call (ids from browser_elements): text fields get the text, dropdowns (native, " +
        "custom or searchable) pick the option by its text, checkboxes/radios/switches are set on (true) or off (false). " +
        "Much faster than one call per field. Each field reports its result; submit with browser_click afterwards.",
      inputSchema: {
        fields: z.array(z.object({ target: z.string().describe("Element id like e12"), value: z.union([z.string(), z.boolean()]) })).min(1),
      },
    },
    wrap(async ({ fields }) => (await browser.fill(fields)).join("\n")),
  );

  server.registerTool(
    "browser_scroll",
    {
      title: "Scroll the page",
      description: "Scroll the active page.",
      inputSchema: { where: z.enum(["down", "up", "top", "bottom"]) },
    },
    wrap(async ({ where }) => {
      await browser.scroll(where);
      return `Scrolled ${where}`;
    }),
  );

  server.registerTool(
    "browser_task",
    {
      title: "Do a task on the page (fast)",
      description:
        "Hand a multi-step task on the web page in front of the user's Chrome/Brave to VisionCLI's Jev agent: fill in a form, " +
        "search this site and open a result, set filters, pick options, add to a cart. It clicks, types and selects in a few " +
        "seconds (about 0.4 s a step). Put every value to type in the goal: it only types text that's in the goal. Returns each " +
        "step and where it ended; check the result with browser_read if needed. Open the right page first (browser_open).",
      inputSchema: { goal: z.string().describe("The whole task, with every value to type, e.g. \"search for 'standing desk', sort by price and open the first result\"") },
    },
    wrap(async ({ goal }) => {
      const { browse } = await import("../agent/browserd.js");
      const steps: string[] = [];
      const end = await browse(goal, (e) => {
        if (e.type === "step") steps.push(`${e.step.n}. ${e.step.op}${e.step.label ? ` "${e.step.label}"` : ""}${e.step.text ? ` → "${e.step.text}"` : ""}`);
      });
      if (!end || end.type !== "end") return `The browser agent stopped without finishing.\n${steps.join("\n")}`;
      return `${end.status}: ${end.message} (${end.steps} steps, ${(end.ms / 1000).toFixed(1)} s)\n${steps.join("\n")}`;
    }),
  );
}
