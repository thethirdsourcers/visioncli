import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Element, Tab } from "../src/browser.js";
import { browserShare, MIN_BROWSER, MIN_INTENT, MIN_SAFE_INTENT, MIN_TARGET, phrase, plan, quickQuestions, readIntent, siteUrl } from "../src/quick.js";

describe("phrase", () => {
  const cases: [string, string][] = [
    ["search for laravel queues", "laravel queues"],
    ["Search the web for stripe webhooks.", "stripe webhooks"],
    ["google stripe webhooks", "stripe webhooks"],
    ["hey please open github", "github"],
    ["can you go to laravel.com?", "laravel.com"],
    ["okay let's open up the website github", "github"],
    ["search for cats on google", "cats"],
    ["open youtube in a new tab", "youtube"],
    ["take me to the site news.ycombinator.com!!", "news.ycombinator.com"],
    ["look up rust lifetimes using the browser", "rust lifetimes"],
  ];
  for (const [said, want] of cases) test(JSON.stringify(said), () => assert.equal(phrase(said), want));

  test("only strips the verb at the start, and only one trailing 'on …'", () => {
    assert.equal(phrase("open the open source page"), "the open source page"); // "the " is kept unless followed by site/page
    assert.equal(phrase("laravel docs on google on chrome"), "laravel docs on google");
  });

  test("a bare phrase is unchanged", () => assert.equal(phrase("tailwind"), "tailwind"));
});

describe("siteUrl", () => {
  test("domains (with optional path) are used as is", () => {
    assert.equal(siteUrl("github.com"), "github.com");
    assert.equal(siteUrl("docs.python.org/3/library"), "docs.python.org/3/library");
  });

  test("speech-split domains are joined", () => assert.equal(siteUrl("laravel . com"), "laravel.com"));

  test("names go through Google's I'm Feeling Lucky, encoded", () => {
    assert.equal(siteUrl("hacker news"), "https://www.google.com/search?btnI=1&q=hacker%20news");
    assert.equal(siteUrl("a&b"), "https://www.google.com/search?btnI=1&q=a%26b");
  });

  test("a single word without a dot is not a domain", () => assert.match(siteUrl("github"), /btnI=1&q=github$/));
});

describe("readIntent", () => {
  const ans = (choice: string, confidence: number, probabilities?: Record<string, number>) =>
    ({ intent: { type: "choice", choice, confidence, probabilities } });

  test("no answer means ask Claude", () => {
    assert.deepEqual(readIntent({}), { intent: "ask_claude", confidence: 0, fallthrough: "needs Claude" });
  });

  test("a confident ask_claude falls through", () => {
    assert.equal(readIntent(ans("ask_claude", 0.9, { ask_claude: 0.9, click: 0.1 })).fallthrough, "needs Claude");
  });

  test("ask_claude that's mostly browser actions goes to the agent, not Claude", () => {
    const r = readIntent(ans("ask_claude", 0.4, { ask_claude: 0.4, click: 0.35, browser_task: 0.25 }));
    assert.equal(r.task, true);
    assert.equal(r.fallthrough, undefined);
    assert.equal(readIntent(ans("ask_claude", 0.4, { ask_claude: 0.4, click: 0.6 }), false).fallthrough, "needs Claude", "not with the browser behind");
  });

  test("at MIN_INTENT it's handled", () => {
    assert.deepEqual(readIntent(ans("scroll_down", MIN_INTENT)), { intent: "scroll_down", confidence: MIN_INTENT });
  });

  test("a fairly likely one-step action still runs; an unsure click goes to the agent", () => {
    assert.deepEqual(readIntent(ans("open_site", MIN_SAFE_INTENT, { open_site: MIN_SAFE_INTENT, ask_claude: 0.2 })), { intent: "open_site", confidence: MIN_SAFE_INTENT });
    const click = readIntent(ans("click", 0.5, { click: 0.5, browser_task: 0.3, ask_claude: 0.2 }));
    assert.equal(click.task, true);
    const close = readIntent(ans("close_tab", 0.5, { close_tab: 0.5, ask_claude: 0.5 }), true);
    assert.equal(close.fallthrough, "unsure (0.50)", "closing a tab needs to be sure, and half of it is Claude");
  });

  test("browserShare: one minus ask_claude, else the top choice", () => {
    assert.equal(browserShare(ans("click", 0.6, { click: 0.6, ask_claude: 0.25, scroll_down: 0.15 })), 0.75);
    assert.equal(browserShare(ans("ask_claude", 0.8)), 0.19999999999999996);
    assert.ok(MIN_BROWSER > 0.5);
  });
});

describe("plan", () => {
  const ans = (choice: string, confidence: number) => ({ type: "choice", choice, confidence });

  test("switch_tab with a confident tab switches", () => {
    assert.deepEqual(plan("switch_tab", { tab: ans("t1.2", MIN_TARGET) }, "go to github"), { do: "switch_tab", tab: "t1.2" });
  });

  test("switch_tab with no matching tab opens the site instead", () => {
    assert.deepEqual(plan("switch_tab", { tab: ans("none", 0.99) }, "go to github"), { do: "open_site", site: "github" });
    assert.deepEqual(plan("switch_tab", { tab: ans("t1.2", MIN_TARGET - 0.01) }, "go to github"), { do: "open_site", site: "github" });
    assert.deepEqual(plan("switch_tab", {}, "show me github"), { do: "open_site", site: "github" });
  });

  test("click needs a confident element, otherwise Claude", () => {
    assert.deepEqual(plan("click", { element: ans("e4", 0.9) }, "click sign in"), { do: "click", element: "e4" });
    assert.deepEqual(plan("click", { element: ans("none", 0.9) }, "click it"), { do: "fallthrough", reason: "couldn't tell which element" });
    assert.deepEqual(plan("click", {}, "click it"), { do: "fallthrough", reason: "couldn't tell which element" });
  });

  test("open_site / web_search use the phrase", () => {
    assert.deepEqual(plan("open_site", {}, "open laravel.com"), { do: "open_site", site: "laravel.com" });
    assert.deepEqual(plan("web_search", {}, "search for vite config"), { do: "web_search", query: "vite config" });
  });

  test("scroll, media and navigation intents", () => {
    assert.deepEqual(plan("scroll_bottom", {}, ""), { do: "scroll", where: "bottom" });
    assert.deepEqual(plan("play_pause", {}, ""), { do: "play_pause" });
    assert.deepEqual(plan("mute", {}, ""), { do: "mute" });
    assert.deepEqual(plan("reload", {}, ""), { do: "navigate", action: "reload" });
    assert.deepEqual(plan("close_tab", {}, ""), { do: "navigate", action: "close" });
    assert.deepEqual(plan("new_tab", {}, ""), { do: "navigate", action: "new" });
  });

  test("an unknown intent falls through", () => {
    assert.deepEqual(plan("dance", {}, ""), { do: "fallthrough", reason: "unhandled intent dance" });
  });
});

describe("quickQuestions", () => {
  test("only the intent question without candidates", () => {
    assert.deepEqual(Object.keys(quickQuestions([], [])), ["intent"]);
  });

  test("tab and element candidates become choice criteria (capped) with a 'none' option", () => {
    const tabs: Tab[] = [{ id: "t1.1", window: 1, index: 1, title: "T".repeat(100), url: "https://x.dev/" + "p".repeat(100), active: true }];
    const els: Element[] = [{ id: "e1", kind: "link", text: "Docs", href: "/docs" }, { id: "e2", kind: "button", text: "Go" }];
    const q = quickQuestions(tabs, els) as Record<string, { criteria: Record<string, string> }>;
    assert.deepEqual(Object.keys(q), ["intent", "tab", "element"]);
    assert.equal(q.tab.criteria["t1.1"], `${"T".repeat(80)} (${("https://x.dev/" + "p".repeat(100)).slice(0, 80)})`);
    assert.equal(q.tab.criteria.none, "None of the open tabs matches.");
    assert.equal(q.element.criteria.e1, "link: Docs (/docs)");
    assert.equal(q.element.criteria.e2, "button: Go");
    assert.ok(q.element.criteria.none);
  });
});
