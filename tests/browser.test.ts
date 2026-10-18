import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ELEMENTS_JS, drag, fill, hover, loadedFrom, read, sameUrl, select, serial, shortHrefFor, type, zipTabs } from "../src/browser.js";

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

describe("loadedFrom", () => {
  test("loaded and on the site that was opened (redirects within it count)", () => {
    assert.ok(loadedFrom({ ready: "complete", href: "https://en.wikipedia.org/wiki/Commodore_64" }, "https://en.wikipedia.org/wiki/Special:Search?search=c64"));
    assert.ok(loadedFrom({ ready: "complete", href: "https://github.com/" }, "https://www.github.com"));
  });
  test("still loading, or still the previous page", () => {
    assert.ok(!loadedFrom({ ready: "interactive", href: "https://en.wikipedia.org/" }, "https://en.wikipedia.org/"));
    assert.ok(!loadedFrom({ ready: "complete", href: "https://news.ycombinator.com/" }, "https://en.wikipedia.org/"));
  });
  test("a new page on the same site: only once the document is a new one", () => {
    const url = "https://the-internet.herokuapp.com/dynamic_controls";
    assert.ok(!loadedFrom({ ready: "complete", href: "https://the-internet.herokuapp.com/tables", doc: 100 }, url, 100), "still the old page");
    assert.ok(loadedFrom({ ready: "complete", href: url, doc: 200 }, url, 100));
  });
});

describe("page scripts", () => {
  // Every script the browser tools send to the page must be valid JavaScript (they're built from template strings).
  const scripts: string[] = [];
  const dump = async (call: () => Promise<unknown>) => {
    process.env.VISIONCLI_JS_DUMP = "1";
    (globalThis as any).__vcliDump = (code: string) => scripts.push(code);
    try { await call(); } catch {} finally { delete process.env.VISIONCLI_JS_DUMP; }
  };
  test("elements, read, type, select and fill compile", async () => {
    await dump(() => read(2000, "Google Chrome"));
    await dump(() => type("e3", "it's \"quoted\"", false, "Google Chrome"));
    await dump(() => type("e3", "x", true, "Google Chrome"));
    await dump(() => select("e5", "Maths", "Google Chrome"));
    await dump(() => fill([{ target: "e3", value: "Grace" }, { target: "e9", value: true }, { target: "e5", value: "Maths" }], "Google Chrome"));
    await dump(() => hover("e4", "Google Chrome"));
    await dump(() => drag("e2", "Drop here", "Google Chrome"));
    scripts.push(ELEMENTS_JS);
    assert.ok(scripts.length >= 6);
    for (const s of scripts) assert.doesNotThrow(() => new Function(`return ${s}`), s.slice(0, 120));
  });
  test("type closes a picker with Tab (not Escape, which closes dialogs), but not in a search-as-you-type field", async () => {
    scripts.length = 0;
    await dump(() => type("e3", "10 Dec 1815", false, "Google Chrome"));
    assert.match(scripts[0], /key: 'Tab'/);
    assert.doesNotMatch(scripts[0], /key: 'Escape'/);
    assert.match(scripts[0], /if \(!combo\)/);
  });
});

describe("site guides", () => {
  test("NetSuite's guide comes once, for any account host; other sites get none", async () => {
    const { guideFor, resetGuides } = await import("../src/sites.js");
    resetGuides();
    assert.equal(guideFor("https://example.com/"), null);
    const g = guideFor("https://3778702.app.netsuite.com/app/center/card.nl?sc=-29");
    assert.match(g ?? "", /NetSuite guide/);
    assert.match(g ?? "", /ubersearchresults\.nl/);
    assert.equal(guideFor("https://1234.app.netsuite.com/app/common/entity/custjoblist.nl"), null, "once per session");
    assert.equal(guideFor("not a url"), null);
  });
});
