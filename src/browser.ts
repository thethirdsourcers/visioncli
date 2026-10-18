import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR } from "./config.js";

const run = promisify(execFile);

// Fast browser control for Chromium browsers (Brave, Chrome) through AppleScript: no extension, no CDP.
// Tab/navigation commands work out of the box; reading the page, clicking and typing use
// "execute javascript", which needs View → Developer → "Allow JavaScript from Apple Events" in the browser.

export const BROWSERS = ["Brave Browser", "Google Chrome", "Chromium", "Microsoft Edge"] as const;
export type BrowserName = (typeof BROWSERS)[number];

/** macOS drives the browser with AppleScript; elsewhere every call goes over DevTools through browserd. */
export const APPLESCRIPT = process.platform === "darwin";
/** The browsers this platform drives: Edge only over DevTools (Windows, Linux); the macOS AppleScript path never had it. */
export const SUPPORTED: readonly BrowserName[] = APPLESCRIPT ? BROWSERS.filter((b) => b !== "Microsoft Edge") : BROWSERS;
const daemon = async <T>(b: BrowserName, rpc: string, ...args: unknown[]): Promise<T> =>
  (await import("./agent/browserd.js")).call<T>(b, rpc, ...args);

/** Linux WM_CLASS → browser name (native, Flatpak and Snap builds). */
export function browserFromClass(wmClass: string): BrowserName | undefined {
  const c = wmClass.toLowerCase();
  if (c.includes("brave")) return "Brave Browser";
  if (c.includes("google-chrome") || c === "com.google.chrome") return "Google Chrome";
  if (c.includes("chromium")) return "Chromium";
  if (c.includes("microsoft-edge") || c.includes("msedge")) return "Microsoft Edge";
  return undefined;
}

/** Windows exe or product name ("msedge.exe", "Google Chrome") → browser name. */
export function browserFromWin(name: string): BrowserName | undefined {
  const n = name.toLowerCase().replace(/\.exe$/, "");
  if (n.includes("brave")) return "Brave Browser";
  if (n === "msedge" || n.includes("microsoft edge")) return "Microsoft Edge";
  if (n.includes("chromium")) return "Chromium";
  if (n === "chrome" || n.includes("google chrome")) return "Google Chrome";
  return undefined;
}

/** Image names per browser on Windows, for tasklist. */
export const WIN_EXES: Record<BrowserName, string> = {
  "Brave Browser": "brave.exe", "Google Chrome": "chrome.exe", Chromium: "chromium.exe", "Microsoft Edge": "msedge.exe",
};

export interface Tab { id: string; window: number; index: number; title: string; url: string; active: boolean }
export interface Element { id: string; kind: string; text: string; href?: string; state?: string; expanded?: boolean; value?: string; options?: string[] }

const JS_HELP =
  'turn on View → Developer → "Allow JavaScript from Apple Events" in the browser (needed to read, click and type in pages)';

async function osa(script: string, timeout = 8000, jxa = false): Promise<string> {
  try {
    const { stdout } = await run("/usr/bin/osascript", [...(jxa ? ["-l", "JavaScript"] : []), "-e", script], { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout.replace(/\n$/, "");
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || err);
    if (/JavaScript through AppleScript is turned off|Allow JavaScript from Apple Events/i.test(msg)) throw new Error(`Please ${JS_HELP}.`);
    if (/Not authorized to send Apple events|-1743/.test(msg)) {
      throw new Error("Not allowed to control the browser: enable it in System Settings → Privacy & Security → Automation.");
    }
    throw new Error(msg.trim().replace(/^\d+:\d+: execution error: /, ""));
  }
}

const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

/**
 * One browser action at a time: element ids (data-vcli) are reset by each listing and "window 1 / active tab" can
 * change under a concurrent call, so tool calls queue up here.
 */
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Display name of the front-most app ("" if unknown). VISIONCLI_FRONT_APP (set by the app) skips the lookup. */
export async function frontApp(): Promise<string> {
  if (process.env.VISIONCLI_FRONT_APP !== undefined) return process.env.VISIONCLI_FRONT_APP;
  if (process.platform === "win32") {
    // Windows has no CLI for the foreground window; the running app (its helper) knows it.
    try {
      const { send } = await import("./control.js");
      const name = (await send({ action: "status" })).frontApp ?? "";
      return browserFromWin(name) ?? name;
    } catch {
      return "";
    }
  }
  if (!APPLESCRIPT) {
    const { activeWindowClass } = await import("./linux.js");
    const cls = await activeWindowClass();
    return browserFromClass(cls) ?? cls;
  }
  try {
    const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "name", "front"]);
    return /"LSDisplayName"="([^"]+)"/.exec(stdout)?.[1] ?? "";
  } catch {
    return "";
  }
}

async function firstRunning(): Promise<BrowserName | undefined> {
  if (process.platform === "win32") {
    const { wsUrl } = await import("./cdp.js");
    const { runningImages } = await import("./win32.js");
    const running = await runningImages();
    return SUPPORTED.find((b) => running.has(WIN_EXES[b]) && wsUrl(b)) ?? SUPPORTED.find((b) => wsUrl(b));
  }
  if (!APPLESCRIPT) {
    // Process names differ per distro and package; a browser with remote debugging on is the one we can use.
    const { wsUrl } = await import("./cdp.js");
    const procs: Record<BrowserName, string> = { "Brave Browser": "brave", "Google Chrome": "chrome", Chromium: "chromium", "Microsoft Edge": "msedge" };
    for (const b of SUPPORTED) {
      const running = await run("pgrep", ["-f", procs[b]]).then(() => true, () => false);
      if (running && wsUrl(b)) return b;
    }
    return SUPPORTED.find((b) => wsUrl(b));
  }
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-xl", SUPPORTED.join("|")]);
    return SUPPORTED.find((b) => stdout.split("\n").some((l) => l.replace(/^\d+\s+/, "") === b));
  } catch {
    return undefined; // pgrep exits 1 when nothing matches
  }
}

/** The browser to act on (the front-most supported browser, else the first one running) and whether it's in front. */
export async function pickWithFront(): Promise<{ browser: BrowserName; front: boolean }> {
  const front = await frontApp();
  if ((SUPPORTED as readonly string[]).includes(front)) return { browser: front as BrowserName, front: true };
  const running = await firstRunning();
  if (running) return { browser: running, front: false };
  throw new Error(APPLESCRIPT ? "Neither Brave nor Chrome is running." : "No Chrome, Brave, Edge or Chromium with remote debugging is running.");
}

/** The browser to act on: the front-most supported browser, else the first one running. */
export async function pick(): Promise<BrowserName> {
  return (await pickWithFront()).browser;
}

export async function frontmostIsBrowser(): Promise<boolean> {
  return (SUPPORTED as readonly string[]).includes(await frontApp());
}

export async function tabs(b?: BrowserName): Promise<Tab[]> {
  const browser = b ?? (await pick());
  if (!APPLESCRIPT) return daemon<Tab[]>(browser, "tabs");
  // Three Apple events for all windows at once (per-tab property reads are what made this slow).
  const out = await osa(`const a = Application(${JSON.stringify(browser)});
    JSON.stringify([a.windows.activeTabIndex(), a.windows.tabs.title(), a.windows.tabs.url()])`, 8000, true);
  return zipTabs(out);
}

/** Tabs from the JXA reply `[activeTabIndex per window, titles per window, urls per window]` (front window first). */
export function zipTabs(out: string): Tab[] {
  const [active, titles, urls]: [number[], (string | null)[][], (string | null)[][]] = JSON.parse(out || "[[],[],[]]");
  return titles.flatMap((ts, w) =>
    ts.map((title, i) => ({
      id: `t${w + 1}.${i + 1}`,
      window: w + 1,
      index: i + 1,
      active: w === 0 && active[0] === i + 1, // only the front window's tab counts as "the" active tab
      title: title ?? "",
      url: urls[w]?.[i] ?? "",
    })),
  );
}

export async function activeTab(b?: BrowserName): Promise<Tab | undefined> {
  return (await tabs(b)).find((t) => t.active);
}

export async function switchTo(tabId: string, b?: BrowserName) {
  const browser = b ?? (await pick());
  if (!APPLESCRIPT) return void (await daemon(browser, "switch", tabId));
  const [w, i] = tabId.replace(/^t/, "").split(".").map(Number);
  await osa(`tell application ${q(browser)}
    set active tab index of window ${w} to ${i}
    set index of window ${w} to 1
    activate
  end tell`);
}

// The tab the assistant works in: later opens navigate it instead of piling up new tabs/windows.
// Kept in a file because quick commands run as separate processes.
const AGENT_TAB = join(CONFIG_DIR, "agent-tab.json");
/** Same page, ignoring scheme, www., trailing slashes, #fragment and case. */
export const sameUrl = (a: string, b: string) => {
  const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
  return norm(a) === norm(b);
};

/**
 * Open a URL without spamming tabs: switch to a tab that already shows it; otherwise navigate the assistant's own tab
 * (if it's still open); otherwise make one new tab in the front window. `newTab: false` loads it in the current tab.
 */
export async function open(url: string, newTab = true, b?: BrowserName, knownTabs?: Tab[]): Promise<string> {
  const browser = b ?? (await pick());
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  // The document showing before, so the wait below can tell the new page apart (same site included).
  const before = await pageState(browser);
  const said = await openTab(url, newTab, browser, knownTabs);
  // Wait for the new page, so the next read or click sees it (not the page that was there before). A tab that was
  // already showing it is loaded.
  if (!said.startsWith("Switched")) await waitForLoad(url, browser, before?.doc);
  return said;
}

interface PageState { ready: string; href: string; doc: number }
const PAGE_STATE = `JSON.stringify({ ready: document.readyState, href: location.href, doc: performance.timeOrigin })`;
async function pageState(browser: BrowserName): Promise<PageState | null> {
  if (process.env.VISIONCLI_JS_DUMP) return null;
  try { return JSON.parse(await js(PAGE_STATE, browser)); } catch { return null; }
}

/** Watches the page for changes (kept in the page between calls), so settle() can tell when it's quiet. */
const WATCH = `(() => { if (!window.__vcliQuiet) { window.__vcliQuiet = { at: Date.now() };
    new MutationObserver(() => { window.__vcliQuiet.at = Date.now(); }).observe(document, { subtree: true, childList: true, characterData: true }); }
  return JSON.stringify({ ready: document.readyState, href: location.href, doc: performance.timeOrigin, quietMs: Date.now() - window.__vcliQuiet.at }); })()`;

/**
 * After an action that may navigate: a new document loads, or a single-page app (GitHub, Gmail, React Router) swaps
 * the content without one. Waits until the page has stopped changing: quiet for 300 ms, loaded if it's a new
 * document; at most `ms`. A click that changes nothing costs about 0.3 s.
 */
async function settle(browser: BrowserName, before: PageState | null, ms = 4000) {
  if (process.env.VISIONCLI_JS_DUMP) return;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 120));
    let s: (PageState & { quietMs: number }) | null = null;
    try { s = JSON.parse(await js(WATCH, browser)); } catch {}
    if (!s) continue; // between documents
    const moved = !before || s.doc !== before.doc || s.href !== before.href;
    if (s.ready !== "complete") continue;
    if (s.quietMs >= (moved ? 400 : 300)) return;
  }
}

/** True once a new document (not `previousDoc`, the one shown before) from `url`'s site has fully loaded. Every
 *  document has its own performance.timeOrigin, so a new page on the same site counts and the old one doesn't. */
export function loadedFrom(state: { ready: string; href: string; doc?: number }, url: string, previousDoc?: number): boolean {
  if (state.ready !== "complete") return false;
  if (previousDoc !== undefined && state.doc === previousDoc) return false;
  try { return new URL(state.href).host.replace(/^www\./, "") === new URL(url).host.replace(/^www\./, ""); } catch { return false; }
}

/** Polls the active tab until it shows a new, fully loaded page from `url`'s site (up to `ms`; slow pages carry on). */
async function waitForLoad(url: string, browser: BrowserName, previousDoc?: number, ms = 8000) {
  if (!/^https?:/i.test(url) || process.env.VISIONCLI_JS_DUMP) return;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = await pageState(browser);
    if (s && loadedFrom(s, url, previousDoc)) return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function openTab(url: string, newTab: boolean, browser: BrowserName, knownTabs?: Tab[]): Promise<string> {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  const existing = (knownTabs ?? (await tabs(browser).catch(() => [] as Tab[]))).find((t) => sameUrl(t.url, url));
  if (existing) {
    await switchTo(existing.id, browser);
    return `Switched to the tab already showing ${url}`;
  }
  if (!APPLESCRIPT) return openOverDevTools(url, newTab, browser);
  if (!newTab) {
    await osa(`tell application ${q(browser)}
      if (count of windows) = 0 then make new window
      set URL of active tab of window 1 to ${q(url)}
      activate
    end tell`);
    return `Opened ${url} in the current tab`;
  }
  let agent: { browser?: string; id?: string } = {};
  try { agent = JSON.parse(readFileSync(AGENT_TAB, "utf8")); } catch {}
  if (agent.browser === browser && agent.id) {
    const r = await osa(`tell application ${q(browser)}
      repeat with w in windows
        set ids to id of tabs of w -- one Apple event per window, not per tab
        repeat with i from 1 to (count of ids)
          if (item i of ids as text) is ${q(agent.id)} then
            set URL of tab i of w to ${q(url)}
            set active tab index of w to i
            set index of w to 1
            activate
            return "reused"
          end if
        end repeat
      end repeat
      return "gone"
    end tell`).catch(() => "gone");
    if (r === "reused") return `Opened ${url} (in the assistant's tab)`;
  }
  const id = await osa(`tell application ${q(browser)}
    if (count of windows) = 0 then make new window
    tell window 1 to set t to make new tab with properties {URL:${q(url)}}
    activate
    return id of t as text
  end tell`);
  try {
    mkdirSync(dirname(AGENT_TAB), { recursive: true });
    writeFileSync(AGENT_TAB, JSON.stringify({ browser, id }));
  } catch {}
  return `Opened ${url} in a new tab`;
}

/** open() without AppleScript: the same rules (current tab, the assistant's own tab, else one new tab). */
async function openOverDevTools(url: string, newTab: boolean, browser: BrowserName): Promise<string> {
  if (!newTab) {
    await daemon(browser, "load", "", url);
    return `Opened ${url} in the current tab`;
  }
  let agent: { browser?: string; id?: string } = {};
  try { agent = JSON.parse(readFileSync(AGENT_TAB, "utf8")); } catch {}
  if (agent.browser === browser && agent.id && (await daemon<string[]>(browser, "targets")).includes(agent.id)) {
    await daemon(browser, "load", agent.id, url);
    return `Opened ${url} (in the assistant's tab)`;
  }
  const id = await daemon<string>(browser, "create", url);
  try {
    mkdirSync(dirname(AGENT_TAB), { recursive: true });
    writeFileSync(AGENT_TAB, JSON.stringify({ browser, id }));
  } catch {}
  return `Opened ${url} in a new tab`;
}

export async function navigate(action: "back" | "forward" | "reload" | "close" | "new", b?: BrowserName) {
  const browser = b ?? (await pick());
  if (!APPLESCRIPT) return void (await daemon(browser, "navigate", action));
  const cmd = {
    back: "go back active tab of window 1",
    forward: "go forward active tab of window 1",
    reload: "reload active tab of window 1",
    close: "close active tab of window 1",
    new: "tell window 1 to make new tab",
  }[action];
  await osa(`tell application ${q(browser)}
    ${cmd}
  end tell`);
}

/** Run JavaScript in the active tab and return its (string) result. */
export async function js(code: string, b?: BrowserName): Promise<string> {
  if (process.env.VISIONCLI_JS_DUMP) { // debug: hand the script to a checker instead of the browser
    (globalThis as any).__vcliDump?.(code);
    return "ok";
  }
  const browser = b ?? (await pick());
  if (!APPLESCRIPT) return daemon<string>(browser, "js", code);
  return osa(`tell application ${q(browser)} to execute active tab of window 1 javascript ${q(code)}`, 10000);
}

/**
 * Page-side helpers that see into same-origin iframes/frames too (government and enterprise portals, Ext JS apps and
 * older admin panels often put the whole UI inside frames): __docs() all documents, __q/__qa query across them,
 * __rect an element's box in top-window coordinates.
 */
const FRAMES = `const __docs = () => { const out = [document];
    for (let i = 0; i < out.length && out.length < 40; i++) for (const f of out[i].querySelectorAll('iframe, frame')) {
      try { if (f.contentDocument && f.contentDocument.documentElement) out.push(f.contentDocument); } catch (e) {} }
    return out; };
  // Every searchable root: the documents plus the open shadow roots inside them (web components: Shoelace, Lit,
  // Salesforce, YouTube…), roots in roots included.
  let __rootList = null; // found once per script (a big page has thousands of elements to check)
  const __roots = () => { if (__rootList) return __rootList; const out = __rootList = [];
    for (const d of __docs()) { out.push(d);
      for (let i = out.length - 1; i < out.length && out.length < 400; i++)
        for (const el of out[i].querySelectorAll('*')) if (el.shadowRoot && out.length < 400) out.push(el.shadowRoot); }
    return out; };
  const __qa = sel => __roots().flatMap(d => [...d.querySelectorAll(sel)]);
  const __q = sel => { for (const d of __roots()) { const e = d.querySelector(sel); if (e) return e; } return null; };
  // Text an element shows through <slot>s (a web component's <button><slot></slot></button> gets its words from the page).
  const __slotText = el => [...(el.querySelectorAll ? el.querySelectorAll('slot') : [])].flatMap(s => s.assignedNodes({ flatten: true }))
    .map(n => n.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
  // The field a <label> stands for: its linked control, else the only text field next to it (labels that aren't linked).
  const __fieldFor = l => { if (l.control) return l.control; const inner = l.querySelector('input, textarea, select'); if (inner) return inner;
    let host = l.parentElement;
    for (let i = 0; i < 3 && host; i++, host = host.parentElement) {
      const fs = [...host.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select')];
      if (fs.length === 1) return fs[0];
      if (fs.length > 1) return null;
    }
    return null; };
  const __rect = el => { const r = el.getBoundingClientRect(); let x = r.left, y = r.top, w = el.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) { const fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
    return { left: x, top: y, width: r.width, height: r.height }; };`;

/**
 * Links as a short path (same site) or host + path: full URLs with tracking params cost a lot of tokens. Runs in the page
 * (its source is embedded in ELEMENTS_JS), so it must stay plain JavaScript without outside references.
 */
export function shortHrefFor(href: string, hereHost: string): string | undefined {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return undefined;
    return ((u.host === hereHost ? "" : u.host) + u.pathname + (u.search.length < 40 ? u.search : "")).slice(0, 80);
  } catch (e) {
    return undefined;
  }
}

// Tags visible, clickable elements with data-vcli ids so a later click/type can target them exactly.
export const ELEMENTS_JS = `(() => {
  ${FRAMES}
  const vis = el => { const r = el.getBoundingClientRect(); const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' &&
      r.bottom > -200 && r.top < innerHeight + 1200; };
  // Form controls are named by their <label> (minus the control's own text, e.g. a select's options).
  const labelText = el => { const l = el.labels?.[0]; if (!l) return ''; const c = l.cloneNode(true);
    c.querySelectorAll('select, input, textarea').forEach(x => x.remove()); return c.innerText || c.textContent || ''; };
  // Inside a web component, the component itself carries the name (<sl-input label="Name">, aria-label on the host).
  const hostName = el => { const h = el.getRootNode && el.getRootNode().host; return h ? h.getAttribute('label') || h.getAttribute('aria-label') || h.getAttribute('placeholder') || '' : ''; };
  const label = el => ((/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? el.getAttribute('aria-label') || labelText(el) || hostName(el) : '') ||
    el.innerText || __slotText(el) || (el.type === 'checkbox' || el.type === 'radio' ? '' : el.value) || el.getAttribute('aria-label') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || el.getAttribute('alt') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  const sel = 'a[href], button, input, textarea, select, label, summary, [onclick], [aria-haspopup], [contenteditable=true], ' +
    '[role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], ' +
    '[role=checkbox], [role=switch], [role=radio], [role=combobox], [role=listbox], [role=slider], [role=treeitem]';
  const shortHref = el => typeof el.href === 'string' && el.href ? (${shortHrefFor})(el.href, el.ownerDocument.location.host) : undefined;
  // Ads (and their "Why this ad?" menus) aren't part of the page the user means.
  const AD = /googleadservices|doubleclick|googlesyndication|adssettings\\.google|adservice\\.google|amazon-adsystem|taboola|outbrain/i;
  const isAd = el => (typeof el.href === 'string' && AD.test(el.href)) ||
    !!el.closest('ins.adsbygoogle, [id^=google_ads], [id*=div-gpt-ad], [data-google-query-id], [aria-label=Advertisement]') ||
    (el.ownerDocument !== document && (() => { const f = el.ownerDocument.defaultView.frameElement;
      return !!f && (AD.test(f.src || '') || /google_ads|aswift/i.test((f.id || '') + (f.name || ''))); })());
  // A custom dropdown's current choice: its own value, else the short text next to it (react-select, MUI, Radix show
  // the chosen option beside the input); a placeholder isn't a choice.
  const shownValue = el => {
    if (el.value && typeof el.value === 'string') return el.value.trim();
    let host = el;
    for (let i = 0; i < 4 && host.parentElement; i++) {
      host = host.parentElement;
      const t = (host.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length > 80) return undefined;
      const ph = host.querySelector('[class*=placeholder], [data-placeholder]');
      return ph && (ph.innerText || '').trim() === t ? '' : t;
    }
    return undefined;
  };
  // A control without a <label>: aria-labelledby, else the short text just before it ("Select Value", "Title").
  const nearbyName = el => {
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\\s+/).map(i => el.ownerDocument.getElementById(i)?.innerText || '').join(' ').trim(); if (t) return t; }
    // Start outside the widget's own box (its placeholder or chosen value isn't its name): climb while the text is
    // still just the widget's.
    let host = el;
    const own = e => (e.innerText || '').replace(/\\s+/g, ' ').trim();
    while (host.parentElement && (own(host) === '' || own(host.parentElement) === own(host)) && host.parentElement !== el.ownerDocument.body) host = host.parentElement;
    for (let i = 0; i < 4 && host; i++, host = host.parentElement) {
      let prev = host.previousElementSibling;
      while (prev && !(prev.innerText || '').trim()) prev = prev.previousElementSibling;
      const t = (prev?.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t && t.length <= 60) return t;
      if (t) return '';
    }
    return '';
  };
  const out = [], found = []; let n = 0; // candidates with temporary ids; the best 150 get e1… at the end
  __qa('[data-vcli]').forEach(el => el.removeAttribute('data-vcli')); // ids from an earlier listing
  for (const el of __qa(sel)) {
    if (!vis(el) || isAd(el)) continue;
    if (el.tagName === 'LABEL' && el.querySelector('input, select, textarea, button')) continue; // the control itself is listed
    const text = label(el); if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
    const id = 'p' + (++n); el.setAttribute('data-vcli', id); found.push(el);
    const role = el.getAttribute('role') || '';
    const type = (el.type || '').toLowerCase();
    let kind = el.tagName === 'A' ? 'link' : el.tagName === 'SELECT' ? 'dropdown' :
      ['checkbox', 'radio'].includes(type) || ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(role) ? 'toggle' :
      // A text box with suggestions (GitHub's filter, a site search) is still a field you type into.
      role === 'combobox' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el.getAttribute('aria-autocomplete') || 'list') !== 'none' && !el.readOnly ? 'field:combobox' :
      role === 'combobox' || role === 'listbox' || el.hasAttribute('aria-haspopup') ? 'dropdown' :
      role === 'option' ? 'option' : role === 'slider' ? 'slider' :
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? 'field:' + (type || 'text') :
      el.isContentEditable ? 'field:editor' : el.tagName === 'LABEL' ? 'label' : 'button';
    const item = { id, kind, text: text || '(empty ' + kind + ')', href: shortHref(el) };
    if (kind === 'toggle') item.state = (el.checked ?? (el.getAttribute('aria-checked') === 'true')) ? 'on' : 'off';
    if (el.hasAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded') === 'true';
    // Only pickers have a chosen value (a combobox, a listbox popup); a menu button (File, Edit…) doesn't.
    // A native dropdown's own text is all its options: name it by its label, the text before it, or its name/id.
    if (el.tagName === 'SELECT') item.text = ((el.getAttribute('aria-label') || labelText(el) || nearbyName(el)).replace(/\\s+/g, ' ').trim() || el.name || el.id || 'dropdown').slice(0, 90);
    else if (kind === 'dropdown' && item.text === '(empty dropdown)') { const name = nearbyName(el); if (name) item.text = name.replace(/\\s+/g, ' ').trim().slice(0, 90); }
    if (kind === 'dropdown' && el.tagName !== 'SELECT' && (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox')) {
      const v = shownValue(el);
      if (v !== undefined) item.value = v || '(none)';
    }
    if (el.tagName === 'SELECT') {
      item.value = el.multiple ? [...el.selectedOptions].map(o => o.text.trim()).join(', ') || '(none)' : el.selectedOptions[0]?.text?.trim();
      if (el.multiple) item.kind = 'dropdown:multiple';
      item.options = [...el.options].slice(0, 25).map(o => o.text.trim());
    }
    out.push(item);
    if (out.length >= 600) break;
  }
  // Clickable things that aren't buttons: icons made of a span/svg with a click handler (a table's edit and delete
  // icons), named by their tooltip or label, and sortable table headers. Clickable means a pointer cursor (or a sort).
  for (const el of __qa('[draggable=true], [class*=drag], [id*=drag]')) {
    if (out.length >= 600) break;
    if (el.hasAttribute('data-vcli') || el.closest('[data-vcli]') || !vis(el) || isAd(el)) continue;
    const cur = el.ownerDocument.defaultView.getComputedStyle(el).cursor;
    if (el.getAttribute('draggable') !== 'true' && !/move|grab/.test(cur) && !/ui-draggable/.test(el.className)) continue;
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
    if (!text) continue;
    const id = 'p' + (++n); el.setAttribute('data-vcli', id); found.push(el);
    out.push({ id, kind: 'draggable', text });
  }
  for (const el of __qa('[title], [aria-label], th, [aria-sort]')) {
    if (out.length >= 600) break;
    if (el.hasAttribute('data-vcli') || el.closest('[data-vcli]') || el.querySelector('[data-vcli]') || !vis(el) || isAd(el)) continue;
    const header = el.tagName === 'TH' || el.hasAttribute('aria-sort');
    // Sortable headers: a sort library marks the header or its table (tablesorter, DataTables, AG Grid…).
    const sortable = el.hasAttribute('aria-sort') || (header && (/sort|header/i.test(el.className) || /sort/i.test(el.closest('table')?.className || '')));
    if (el.ownerDocument.defaultView.getComputedStyle(el).cursor !== 'pointer' && !sortable) continue;
    const text = ((header ? el.innerText : '') || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
    if (!text) continue;
    const id = 'p' + (++n); el.setAttribute('data-vcli', id); found.push(el);
    const item = { id, kind: header ? 'header' : 'button', text };
    if (el.hasAttribute('aria-sort')) item.state = 'sorted ' + el.getAttribute('aria-sort');
    out.push(item);
  }
  // Rank before cutting to 150: an open dialog's controls first (they're what the user is looking at), then what's on
  // screen, then the rest, each in page order. Big sidebars no longer push a dialog's fields off the list.
  const dialog = __qa('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]').filter(vis).pop();
  const rank = el => { if (dialog && (dialog.contains(el) || (el.getRootNode().host && dialog.contains(el.getRootNode().host)))) return 0;
    const r = __rect(el); return r.top + r.height > 0 && r.top < innerHeight && r.left < innerWidth && r.left + r.width > 0 ? 1 : 2; };
  const order = out.map((item, i) => ({ item, el: found[i], i, r: rank(found[i]) })).sort((a, b) => a.r - b.r || a.i - b.i);
  const kept = order.slice(0, 150);
  order.slice(150).forEach(o => o.el.removeAttribute('data-vcli'));
  kept.forEach((o, k) => { o.item.id = 'e' + (k + 1); o.el.setAttribute('data-vcli', o.item.id); });
  return JSON.stringify(kept.map(o => o.item));
})()`;

export async function elements(b?: BrowserName): Promise<Element[]> {
  return JSON.parse((await js(ELEMENTS_JS, b)) || "[]");
}

// ---- AI cursor: a faint ghost pointer that glides to the target, ripples, then acts, so you can see
// what Jev/Claude is doing. Off when CONFIG_DIR/ghost-off exists (menu toggle).
const GHOST_OFF = join(CONFIG_DIR, "ghost-off");
const ghostOn = () => !existsSync(GHOST_OFF);

/** Page-side helper (defined once per page): window.__vcliGhost(x, y, then) moves the ghost and calls `then`. */
const GHOST_LIB = `if (!window.__vcliGhost) {
  const g = document.createElement('div');
  g.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5 L5 19.5 L9.4 15.4 L12.3 21.8 L15 20.6 L12.2 14.3 L18.4 14.1 Z" fill="rgba(255,255,255,.92)" stroke="#22d3ee" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  Object.assign(g.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', opacity: '0',
    filter: 'drop-shadow(0 0 6px rgba(34,211,238,.85)) drop-shadow(0 0 2px rgba(168,85,247,.8))',
    transition: 'transform .42s cubic-bezier(.25,.8,.25,1), opacity .25s ease',
    transform: 'translate(' + innerWidth * 0.72 + 'px,' + innerHeight * 0.3 + 'px)' });
  document.documentElement.appendChild(g);
  const ripple = (x, y) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: (x - 14) + 'px', top: (y - 14) + 'px', width: '28px', height: '28px',
      borderRadius: '50%', border: '2px solid rgba(34,211,238,.9)', boxShadow: '0 0 12px rgba(168,85,247,.7)',
      zIndex: 2147483646, pointerEvents: 'none', transform: 'scale(.3)', opacity: '1', transition: 'transform .45s ease-out, opacity .45s ease-out' });
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
    setTimeout(() => r.remove(), 500);
  };
  window.__vcliGhost = (x, y, then, click = true) => {
    g.style.opacity = '0.62';
    requestAnimationFrame(() => { g.style.transform = 'translate(' + (x - 5) + 'px,' + (y - 3) + 'px)'; });
    setTimeout(() => {
      if (click) ripple(x, y);
      try { then && then(); } finally {
        clearTimeout(window.__vcliGhostHide);
        window.__vcliGhostHide = setTimeout(() => { g.style.opacity = '0'; }, 1600);
      }
    }, 450);
  };
}`;

/**
 * Page-side "real" press: custom widgets (React/Radix/MUI dropdowns, switches) often listen to pointerdown/mousedown,
 * not click, so fire the whole sequence a mouse would, at the element's center, then the native click.
 */
const PRESS_LIB = `if (!window.__vcliPress) {
  window.__vcliPress = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: el.ownerDocument.defaultView, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const P = window.PointerEvent || MouseEvent;
    el.dispatchEvent(new P('pointerover', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new P('pointerdown', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    if (el.focus) el.focus({ preventScroll: true });
    el.dispatchEvent(new P('pointerup', { ...o, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  };
}`;

/** Click an element by data-vcli id (from elements()) or, failing that, by its visible text. */
export async function click(target: string, b?: BrowserName): Promise<string> {
  const code = `(() => {
    ${FRAMES}
    let el = __q('[data-vcli=${JSON.stringify(target)}]');
    if (!el) {
      const want = ${JSON.stringify(target.toLowerCase())};
      // The best match: exact text, then starting with it, then containing it ("Use" means the Use tab, not "Users").
      const name = e => (e.innerText || __slotText(e) || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/\\s+/g, ' ').toLowerCase().trim();
      const seen = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
      const all = [...__qa('[data-vcli], a, button, label, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=switch], [role=radio], [role=combobox], [aria-haspopup], input[type=submit], summary')].filter(seen);
      el = all.find(e => name(e) === want) || all.find(e => name(e).startsWith(want)) || all.find(e => name(e).includes(want));
    }
    if (!el) return 'NOT_FOUND';
    if (el.tagName === 'SELECT') return 'USE_SELECT';
    ${PRESS_LIB}
    const label = (el.labels?.[0]?.innerText || el.innerText || __slotText(el) || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 80);
    el.scrollIntoView({ block: 'center' });
    ${ghostOn() ? `${GHOST_LIB}
    const r = __rect(el);
    window.__vcliPress(el); // act now; the ghost cursor only shows where (its timers may be throttled)
    window.__vcliGhost(r.left + Math.min(r.width / 2, 48), r.top + r.height / 2, null);` : "window.__vcliPress(el);"}
    return label;
  })()`;
  const browser = b ?? (await pick());
  // Start watching before the click, so a single-page app's swap counts as a change.
  const before = await js(WATCH, browser).then((x) => JSON.parse(x) as PageState, () => null);
  const r = await js(code, browser);
  if (r === "NOT_FOUND") throw new Error(`No clickable element matching "${target}".`);
  if (r === "USE_SELECT") throw new Error(`"${target}" is a native dropdown: use browser_select with the option text instead of clicking it.`);
  await settle(browser, before);
  return r;
}

export async function type(target: string, text: string, submit = false, b?: BrowserName): Promise<string> {
  const code = `(() => {
    ${FRAMES}
    let el = __q('[data-vcli=${JSON.stringify(target)}]') || document.activeElement;
    while (el && el.contentDocument && el.contentDocument.activeElement) el = el.contentDocument.activeElement; // focus inside a frame
    if (el && el.tagName === 'LABEL') el = __fieldFor(el) || el; // a label means its field
    const text = ${JSON.stringify(text)};
    if (el && el.isContentEditable) {
      // A rich-text editor (TinyMCE, Quill, ProseMirror, Gmail…): replace its text the way typing does, so the editor
      // keeps its own state; plain text if the browser won't insert.
      el.focus();
      const d = el.ownerDocument, sel = d.defaultView.getSelection(), range = d.createRange();
      range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
      if (!d.execCommand('insertText', false, text)) { el.innerText = text; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return 'ok';
    }
    if (!el || !('value' in el)) return 'NOT_FOUND';
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    const set = v => { setter ? setter.call(el, v) : (el.value = v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    // A search-as-you-type dropdown needs its text to stay (browser_select picks from the suggestions next).
    const combo = el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || !!el.closest('[role=combobox]');
    const finish = () => {
      set(text);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${submit ? "if (el.form) { el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); } else { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }" : `
      // Any other field: close what typing opened (a date picker's calendar would cover the next click), and leave it.
      // Tab, not Escape: pickers close on it, while Escape would also close a dialog the field is in.
      if (!combo) {
        const tab = { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', tab));
        el.dispatchEvent(new KeyboardEvent('keyup', tab));
        el.blur();
      }`}
    };
    el.scrollIntoView({ block: 'center' });
    ${ghostOn() ? `${GHOST_LIB}
    const r = __rect(el);
    // Commit the exact value right away so the next step never races an animation; the ghost just shows where.
    el.focus(); finish();
    window.__vcliGhost(r.left + 14, r.top + r.height / 2, null);` : "el.focus(); finish();"}
    return 'ok';
  })()`;
  const browser = b ?? (await pick());
  const before = submit ? await js(WATCH, browser).then((x) => JSON.parse(x) as PageState, () => null) : null;
  const r = await js(code, browser);
  if (r === "NOT_FOUND") throw new Error(`No text field "${target}".`);
  if (submit) await settle(browser, before);
  return r;
}

export async function scroll(where: "down" | "up" | "top" | "bottom", b?: BrowserName) {
  const action = {
    down: "window.scrollBy({top: innerHeight * 0.8, behavior: 'smooth'})",
    up: "window.scrollBy({top: -innerHeight * 0.8, behavior: 'smooth'})",
    top: "window.scrollTo({top: 0, behavior: 'smooth'})",
    bottom: "window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'})",
  }[where];
  const down = where === "down" || where === "bottom";
  const code = ghostOn()
    ? `(() => { ${GHOST_LIB}
        const x = innerWidth * 0.82, y = innerHeight * (${down} ? 0.35 : 0.65);
        window.__vcliGhost(x, y, () => { ${action}; window.__vcliGhost(x, innerHeight * (${down} ? 0.65 : 0.35), null, false); }, false);
        return 'ok'; })()`
    : `${action}; 'ok'`;
  await js(code, b);
}

/** Readable text of the current page (title, URL, main content), capped. */
export async function read(maxChars = 6000, b?: BrowserName): Promise<string> {
  const code = `(() => {
    ${FRAMES}
    // The main content: <main>, else the one <article> (a list of articles, like a shop's product cards, is the page itself).
    const arts = document.querySelectorAll('article');
    const main = document.querySelector('main, [role=main]') || (arts.length === 1 ? arts[0] : null) || document.body;
    // Long option lists (a date picker's 200 years, every country) are noise here: browser_elements lists their options.
    const long = __qa('select, [role=listbox]').filter(l => (l.options || l.children).length > 15 && l.style.display !== 'none');
    long.forEach(l => { l.dataset.vcliDisplay = l.style.display; l.style.display = 'none'; });
    const adFrame = d => { const f = d.defaultView && d.defaultView.frameElement;
      return !!f && (/googlesyndication|doubleclick|googleadservices/i.test(f.src || '') || /google_ads|aswift/i.test((f.id || '') + (f.name || ''))); };
    const frames = __docs().slice(1).filter(d => !adFrame(d)).map(d => d.body ? d.body.innerText || '' : '').filter(t => t.trim());
    const text = [main.innerText || '', ...frames].join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n');
    long.forEach(l => { l.style.display = l.dataset.vcliDisplay; delete l.dataset.vcliDisplay; });
    return JSON.stringify({ title: document.title, url: location.href, selection: String(getSelection() || ''), text: text.slice(0, ${maxChars}) });
  })()`;
  const page = JSON.parse(await js(code, b));
  return `${page.title}\n${page.url}\n${page.selection ? `\nSelected text: ${page.selection}\n` : ""}\n${page.text}`;
}

/**
 * Choose an option in a dropdown. Native <select>: set the value the way React/Vue notice (native setter + input/change).
 * Custom dropdowns: press the trigger, wait for the popup to render, then press the matching [role=option]/menu item.
 */
export async function select(target: string, option: string, b?: BrowserName): Promise<string> {
  const want = JSON.stringify(option.toLowerCase().trim());
  const first = await js(`(() => {
    ${PRESS_LIB}
    ${FRAMES}
    const el = __q('[data-vcli=${JSON.stringify(target)}]');
    if (!el) return 'NOT_FOUND';
    el.scrollIntoView({ block: 'center' });
    if (el.tagName === 'SELECT') {
      const want = ${want};
      const opt = [...el.options].find(o => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
        || [...el.options].find(o => o.text.toLowerCase().includes(want));
      if (!opt) return 'NO_OPTION:' + [...el.options].map(o => o.text.trim()).slice(0, 30).join(' | ');
      if (el.multiple) {
        // A multi-select adds the option (and keeps what's already chosen), like ⌘-clicking it.
        opt.selected = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return 'DONE:' + [...el.selectedOptions].map(o => o.text.trim()).join(', ');
      }
      const setter = Object.getOwnPropertyDescriptor(el.ownerDocument.defaultView.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'DONE:' + opt.text.trim();
    }
    window.__vcliPress(el);
    // A search box (react-select, MUI Autocomplete…): its options may only show after typing.
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    return input && !input.readOnly && (input.getAttribute('aria-autocomplete') || 'list') !== 'none' && input.type !== 'checkbox' ? 'OPENED_SEARCH' : 'OPENED';
  })()`, b);
  if (first === "NOT_FOUND") throw new Error(`No element "${target}". Call browser_elements again.`);
  if (first.startsWith("NO_OPTION:")) throw new Error(`No option "${option}". Options: ${first.slice(10)}`);
  if (first.startsWith("DONE:")) return `Selected "${first.slice(5)}"`;
  // Popups render (and animate) after the press: look for the option as soon as it can be there, up to ~1 s.
  const poll = async (ms: number) => {
    let r = "";
    for (const until = Date.now() + ms; ;) {
      await new Promise((res) => setTimeout(res, 80));
      r = await js(pickOption, b);
      if (r.startsWith("DONE:") || Date.now() > until) return r;
    }
  };
  const pickOption = `(() => {
    ${PRESS_LIB}
    const want = ${want};
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    ${FRAMES}
    const items = [...__qa('[role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=treeitem], [cmdk-item], li')].filter(vis);
    const text = e => (e.innerText || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    const hit = items.find(e => text(e).toLowerCase() === want) || items.find(e => text(e).toLowerCase().includes(want));
    if (!hit) return 'NO_OPTION:' + items.map(text).filter(Boolean).slice(0, 30).join(' | ');
    hit.scrollIntoView({ block: 'nearest' });
    window.__vcliPress(hit);
    return 'DONE:' + text(hit);
  })()`;
  // A search box gets one quick look (its full list may already be open), then typing; a plain dropdown up to ~1 s.
  const second = await poll(first === "OPENED_SEARCH" ? 150 : 900);
  if (second.startsWith("NO_OPTION:")) {
    // A searchable dropdown (react-select, MUI Autocomplete…) only lists matches once you type: type the option.
    const typed = await js(`(() => {
      ${FRAMES}
      const box = __q('[data-vcli=${JSON.stringify(target)}]');
      const el = box && ('value' in box && box.tagName !== 'SELECT' ? box : box.querySelector('input'));
      if (!el) return 'NO';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter ? setter.call(el, ${JSON.stringify(option)}) : (el.value = ${JSON.stringify(option)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'TYPED';
    })()`, b);
    if (typed === "TYPED") {
      const third = await poll(1500); // suggestions load (some ask the server)
      if (third.startsWith("DONE:")) return `Selected "${third.slice(5)}"`;
    }
    throw new Error(`Opened the dropdown but found no option "${option}". Visible: ${second.slice(10) || "(none)"}`);
  }
  return `Selected "${second.slice(5)}"`;
}

export interface FillField { target: string; value: string | boolean }

/**
 * Fills a form in one go: text fields are typed, dropdowns (native or custom, searchable or not) pick the option,
 * checkboxes/radios/switches are set to on (true / "on") or off. Each field reports its own result; one failing
 * doesn't stop the rest.
 */
export async function fill(fields: FillField[], b?: BrowserName): Promise<string[]> {
  const browser = b ?? (await pick());
  // One page call sets every text field and toggle (each round trip to the browser costs ~0.2 s); dropdowns, which
  // open popups and wait for them, follow one by one.
  const raw = await js(`(() => {
    ${FRAMES}
    ${PRESS_LIB}
    const fields = ${JSON.stringify(fields)};
    return JSON.stringify(fields.map(({ target, value }) => {
      let el = __q('[data-vcli=' + JSON.stringify(target) + ']');
      if (!el) return 'NOT_FOUND';
      // A label means its field ("First Name" is often both the label and the field's placeholder).
      if (el.tagName === 'LABEL') { const c = __fieldFor(el);
        if (c && !['checkbox', 'radio'].includes((c.type || '').toLowerCase())) el = c; }
      const role = el.getAttribute('role') || '';
      const box = el.tagName === 'LABEL' ? (el.control || el.querySelector('input')) : el;
      if (box && (['checkbox', 'radio'].includes((box.type || '').toLowerCase()) || ['checkbox', 'switch', 'radio'].includes(box.getAttribute('role') || ''))) {
        const want = value === true || /^(on|true|yes|checked|1)$/i.test(String(value));
        const on = box.checked ?? box.getAttribute('aria-checked') === 'true';
        if (on !== want) { el.scrollIntoView({ block: 'center' }); window.__vcliPress(el); }
        return want ? 'on' : 'off';
      }
      if (el.tagName === 'SELECT' || role === 'combobox' || (el.hasAttribute('aria-haspopup') && el.tagName !== 'INPUT')) return 'DROPDOWN';
      if (!('value' in el)) return 'BUTTON';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter ? setter.call(el, String(value)) : (el.value = String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Close what typing opened (a date picker), with Tab: Escape would also close a dialog the form is in.
      const tab = { key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', tab));
      el.dispatchEvent(new KeyboardEvent('keyup', tab));
      el.blur();
      return 'typed';
    }));
  })()`, browser);
  let first: string[];
  try { first = JSON.parse(raw); } catch { first = fields.map(() => "DROPDOWN"); } // dump mode / odd page: one by one
  const out: string[] = [];
  for (const [i, { target, value }] of fields.entries()) {
    const r = first[i];
    if (r === "NOT_FOUND") out.push(`${target}: FAILED not found (call browser_elements again)`);
    else if (r === "BUTTON") out.push(`${target}: FAILED is a button: use browser_click`);
    else if (r === "DROPDOWN") {
      try { out.push(`${target}: ${await select(target, String(value), browser)}`); }
      catch (err) { out.push(`${target}: FAILED ${(err as Error).message ?? err}`); }
    } else out.push(`${target}: ${r}`);
  }
  return out;
}

/**
 * Hover over an element: menus and captions that show on hover. Script-driven ones get the mouse-over events; CSS
 * :hover ones get a copy of the page's :hover rules that also applies to a marker class, put on the element and its
 * parents (a real hover covers them too). The pointer itself doesn't move. The next hover moves it to another element.
 */
export async function hover(target: string, b?: BrowserName): Promise<string> {
  const r = await js(`(() => {
    ${FRAMES}
    let el = __q('[data-vcli=${JSON.stringify(target)}]');
    if (!el) {
      // By text: the smallest visible element whose text, image description, label or tooltip has it.
      const want = ${JSON.stringify(target.toLowerCase())};
      const name = e => (e.getAttribute('alt') || e.getAttribute('aria-label') || e.getAttribute('title') || (e.children.length < 4 ? e.innerText : '') || '').toLowerCase();
      el = __qa('img[alt], [aria-label], [title], a, button, li, span, div, td, th').filter(e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && name(e).includes(want); })
        .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    }
    if (!el) return 'NOT_FOUND';
    const doc = el.ownerDocument;
    if (!doc.getElementById('__vcli_hover')) {
      const rules = [];
      for (const sheet of [...doc.styleSheets]) {
        let list; try { list = sheet.cssRules; } catch (e) { continue; } // another site's stylesheet: can't read it
        const walk = rs => { for (const r of rs) {
          if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; } // @media blocks
          if (r.selectorText && r.selectorText.includes(':hover')) rules.push(r.cssText.split(r.selectorText).join(r.selectorText.replace(/:hover/g, '.__vcliHover')));
        } };
        walk(list);
      }
      const style = doc.createElement('style'); style.id = '__vcli_hover'; style.textContent = rules.join('\\n');
      doc.head.appendChild(style);
    }
    doc.querySelectorAll('.__vcliHover').forEach(e => e.classList.remove('__vcliHover'));
    for (let e = el; e && e.classList; e = e.parentElement) e.classList.add('__vcliHover');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: doc.defaultView, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const P = doc.defaultView.PointerEvent || MouseEvent;
    el.dispatchEvent(new P('pointerover', { ...o, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new P('pointerenter', { ...o, bubbles: false, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', o));
    return (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60);
  })()`, b);
  if (r === "NOT_FOUND") throw new Error(`No element "${target}". Call browser_elements again.`);
  return r;
}

/**
 * Drag one element onto another (ids from elements(), or visible text): sends both what HTML5 drag-and-drop listens to
 * (dragstart / dragover / drop with a DataTransfer) and the mouse down / moves / up that mouse-driven libraries
 * (jQuery UI, SortableJS, dnd-kit) follow. Returns what the target says afterwards.
 */
export async function drag(from: string, to: string, b?: BrowserName): Promise<string> {
  const r = await js(`(() => {
    ${FRAMES}
    const find = t => {
      const byId = __q('[data-vcli=' + JSON.stringify(t) + ']'); if (byId) return byId;
      const want = t.toLowerCase();
      const name = e => (e.getAttribute('aria-label') || e.getAttribute('title') || (e.children.length < 6 ? e.innerText : '') || '').replace(/\\s+/g, ' ').toLowerCase().trim();
      const seen = e => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
      const all = __qa('[draggable], div, li, span, td, p, section, [role]').filter(seen);
      return all.find(e => name(e) === want) || all.find(e => name(e).startsWith(want));
    };
    const src = find(${JSON.stringify(from)}), dst = find(${JSON.stringify(to)});
    if (!src) return 'NO_SOURCE'; if (!dst) return 'NO_TARGET';
    src.scrollIntoView({ block: 'center' });
    const a = src.getBoundingClientRect(), z = dst.getBoundingClientRect();
    const x1 = a.left + a.width / 2, y1 = a.top + a.height / 2, x2 = z.left + z.width / 2, y2 = z.top + z.height / 2;
    const doc = src.ownerDocument, view = doc.defaultView, P = view.PointerEvent || MouseEvent;
    const at = (x, y, extra) => ({ bubbles: true, cancelable: true, composed: true, view, clientX: x, clientY: y, screenX: x, screenY: y, ...extra });
    const under = (x, y) => doc.elementFromPoint(x, y) || dst;
    // Mouse-driven libraries.
    src.dispatchEvent(new P('pointerdown', at(x1, y1, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })));
    src.dispatchEvent(new MouseEvent('mousedown', at(x1, y1, { button: 0, buttons: 1 })));
    for (let i = 1; i <= 10; i++) {
      const x = x1 + (x2 - x1) * i / 10, y = y1 + (y2 - y1) * i / 10;
      under(x, y).dispatchEvent(new P('pointermove', at(x, y, { pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 })));
      under(x, y).dispatchEvent(new MouseEvent('mousemove', at(x, y, { buttons: 1 })));
      doc.dispatchEvent(new MouseEvent('mousemove', at(x, y, { buttons: 1 })));
    }
    dst.dispatchEvent(new MouseEvent('mouseover', at(x2, y2, { buttons: 1 })));
    under(x2, y2).dispatchEvent(new P('pointerup', at(x2, y2, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 })));
    under(x2, y2).dispatchEvent(new MouseEvent('mouseup', at(x2, y2, { button: 0 })));
    doc.dispatchEvent(new MouseEvent('mouseup', at(x2, y2, { button: 0 })));
    // HTML5 drag and drop.
    const drag = src.closest('[draggable=true]');
    if (drag && view.DataTransfer) {
      const dt = new view.DataTransfer();
      const D = (type, el, x, y) => el.dispatchEvent(new view.DragEvent(type, at(x, y, { dataTransfer: dt })));
      D('dragstart', drag, x1, y1); D('dragenter', dst, x2, y2); D('dragover', dst, x2, y2); D('drop', dst, x2, y2); D('dragend', drag, x2, y2);
    }
    return 'OK:' + (dst.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  })()`, b);
  if (r === "NO_SOURCE") throw new Error(`Nothing to drag matching "${from}".`);
  if (r === "NO_TARGET") throw new Error(`No drop target matching "${to}".`);
  return r.slice(3);
}
