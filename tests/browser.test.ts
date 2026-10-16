import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ELEMENTS_JS, sameUrl, serial, shortHrefFor, zipTabs } from "../src/browser.js";

describe("shortHrefFor", () => {
  test("same host: just path + short query", () => {
    assert.equal(shortHrefFor("https://github.com/org/repo?tab=readme", "github.com"), "/org/repo?tab=readme");
  });

  test("other host: host + path", () => {
    assert.equal(shortHrefFor("https://docs.github.com/en", "github.com"), "docs.github.com/en");
  });

  test("a port is part of the host", () => {
    assert.equal(shortHrefFor("http://localhost:3000/a", "localhost:3000"), "/a");
    assert.equal(shortHrefFor("http://localhost:8080/a", "localhost:3000"), "localhost:8080/a");
  });

  test("long query strings (tracking params) are dropped, short ones kept", () => {
    const longQ = "?" + "utm_source=newsletter&utm_medium=email&utm_campaign=x";
    assert.equal(shortHrefFor(`https://x.dev/p${longQ}`, "x.dev"), "/p");
    assert.equal(shortHrefFor("https://x.dev/p?q=1", "x.dev"), "/p?q=1");
  });

  test("the fragment never shows", () => assert.equal(shortHrefFor("https://x.dev/p#section", "x.dev"), "/p"));

  test("capped at 80 characters", () => {
    assert.equal(shortHrefFor("https://x.dev/" + "a".repeat(200), "y.dev")?.length, 80);
  });

  test("non-http(s) links and garbage are left out", () => {
    for (const href of ["mailto:a@b.c", "javascript:void(0)", "tel:123", "ftp://x.dev/f", "not a url", ""]) {
      assert.equal(shortHrefFor(href, "x.dev"), undefined, href);
    }
  });

  test("its source is embedded in the page script and runs standalone (no outside references)", () => {
    const src = String(shortHrefFor);
    assert.ok(ELEMENTS_JS.includes(src));
    assert.doesNotMatch(src, /:\s*string/); // type annotations were stripped
    const inPage = new Function(`return (${src})`)() as typeof shortHrefFor;
    assert.equal(inPage("https://github.com/a?b=1", "github.com"), "/a?b=1");
    assert.equal(inPage("mailto:x@y.z", "github.com"), undefined);
  });
});

describe("zipTabs", () => {
  test("ids, windows and indexes from the per-window arrays", () => {
    const out = JSON.stringify([[2, 1], [["A", "B"], ["C"]], [["https://a", "https://b"], ["https://c"]]]);
    assert.deepEqual(zipTabs(out), [
      { id: "t1.1", window: 1, index: 1, active: false, title: "A", url: "https://a" },
      { id: "t1.2", window: 1, index: 2, active: true, title: "B", url: "https://b" },
      { id: "t2.1", window: 2, index: 1, active: false, title: "C", url: "https://c" }, // only the front window has "the" active tab
    ]);
  });

  test("null titles/urls (loading tabs) become empty strings", () => {
    const [t] = zipTabs(JSON.stringify([[1], [[null]], [[null]]]));
    assert.equal(t.title, "");
    assert.equal(t.url, "");
  });

  test("a missing url array doesn't throw", () => {
    assert.equal(zipTabs(JSON.stringify([[1], [["A"]], []]))[0].url, "");
  });

  test("no windows / empty output", () => {
    assert.deepEqual(zipTabs(""), []);
    assert.deepEqual(zipTabs("[[],[],[]]"), []);
  });
});

describe("sameUrl", () => {
  test("ignores scheme, www, trailing slashes, fragment and case", () => {
    assert.ok(sameUrl("https://www.GitHub.com/org/", "http://github.com/org#readme"));
  });

  test("path and query still matter", () => {
    assert.ok(!sameUrl("https://x.dev/a", "https://x.dev/b"));
    assert.ok(!sameUrl("https://x.dev/a?x=1", "https://x.dev/a"));
  });
});

describe("serial", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("runs one call at a time, in call order", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => serial(async () => {
      log.push(`start ${name}`);
      await tick(ms);
      log.push(`end ${name}`);
      return name;
    });
    const results = await Promise.all([job("a", 30), job("b", 1), job("c", 10)]);
    assert.deepEqual(results, ["a", "b", "c"]);
    assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("a failing call rejects for its caller but doesn't block the queue", async () => {
    const failed = serial(async () => { throw new Error("boom"); });
    const next = serial(async () => "after");
    await assert.rejects(failed, /boom/);
    assert.equal(await next, "after");
  });

  test("a synchronous throw is also contained", async () => {
    const failed = serial((() => { throw new Error("sync"); }) as () => Promise<never>);
    await assert.rejects(failed, /sync/);
    assert.equal(await serial(async () => 1), 1);
  });
});

describe("ELEMENTS_JS ranking", () => {
  function makeEl(name: string, opts: { text?: string; inDialog?: boolean; rect?: { width: number; height: number; top: number; bottom: number; left: number; right: number }; attrs?: Record<string, string> } = {}) {
    const attrs: Record<string, string> = { ...opts.attrs };
    return {
      tagName: name.toUpperCase(),
      innerText: opts.text || "",
      type: "text",
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({ visibility: "visible", display: "block" }),
          location: { host: "example.com" },
        },
      },
      getAttribute: (k: string) => attrs[k] ?? null,
      hasAttribute: (k: string) => k in attrs,
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      removeAttribute: (k: string) => { delete attrs[k]; },
      closest: (sel: string) => {
        if (opts.inDialog && (sel.includes("dialog[open]") || sel.includes("[role=dialog]") || sel.includes("[role=alertdialog]"))) {
          return { tagName: "DIALOG" };
        }
        return null;
      },
      getBoundingClientRect: () => opts.rect || { width: 10, height: 10, top: 100, bottom: 120, left: 10, right: 30 },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
  }

  function evaluateElements(els: any[], innerWidth = 1024, innerHeight = 768) {
    const mockDoc = {
      querySelectorAll: (sel: string) => (sel === "[data-vcli]" ? [] : sel.includes("iframe") ? [] : els),
      location: { host: "example.com" },
    };
    const fn = new Function("document", "window", "innerHeight", "innerWidth", `return ${ELEMENTS_JS}`);
    return JSON.parse(fn(mockDoc, { innerHeight, innerWidth }, innerHeight, innerWidth));
  }

  test("ranks dialog elements first, then viewport elements, then off-viewport elements", () => {
    const inViewSidebar = makeEl("button", { text: "Sidebar Nav", rect: { width: 50, height: 20, top: 50, bottom: 70, left: 10, right: 60 } });
    const dialogSubmit = makeEl("button", { text: "Save Changes", inDialog: true, rect: { width: 80, height: 30, top: 200, bottom: 230, left: 300, right: 380 } });
    const offscreenFooter = makeEl("a", { text: "Footer Link", attrs: { href: "https://example.com/footer" }, rect: { width: 60, height: 20, top: 900, bottom: 920, left: 10, right: 70 } });

    // Document order: sidebar first, then dialog, then footer
    const results = evaluateElements([inViewSidebar, dialogSubmit, offscreenFooter]);
    assert.equal(results.length, 3);
    assert.equal(results[0].text, "Save Changes"); // rank 0 (dialog)
    assert.equal(results[1].text, "Sidebar Nav");  // rank 1 (viewport)
    assert.equal(results[2].text, "Footer Link");  // rank 2 (offscreen)
    assert.equal(results[0].id, "e1");
    assert.equal(results[1].id, "e2");
    assert.equal(results[2].id, "e3");
  });

  test("preserves dialog elements when page has > 150 elements before it", () => {
    // 160 sidebar links preceding a dialog button in document order
    const sidebarLinks = Array.from({ length: 160 }, (_, i) =>
      makeEl("a", { text: `Nav ${i + 1}`, attrs: { href: `https://example.com/nav/${i + 1}` }, rect: { width: 40, height: 15, top: 10 + (i % 20) * 20, bottom: 25 + (i % 20) * 20, left: 10, right: 50 } })
    );
    const dialogBtn = makeEl("button", { text: "Modal Confirm", inDialog: true, rect: { width: 80, height: 30, top: 300, bottom: 330, left: 400, right: 480 } });

    const allElements = [...sidebarLinks, dialogBtn];
    const results = evaluateElements(allElements);

    // Capped at 150
    assert.equal(results.length, 150);
    // Modal confirm appears as the very first element (e1) despite being element #161 in document order
    assert.equal(results[0].text, "Modal Confirm");
    assert.equal(results[0].id, "e1");
    assert.equal(results[1].text, "Nav 1");
  });
});
