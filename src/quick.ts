import { existsSync, readFileSync } from "node:fs";
import * as browser from "./browser.js";
import { INTEGRATIONS_FILE } from "./config.js";

// Instant voice commands: one Jev (TypeSafe System One) request routes the spoken command and picks its
// target from candidates code collected (open tabs, clickable elements); code then performs the action.
// A browser action is always ours: a fairly likely one-step action runs, anything else that's probably about the page
// goes to the Jev agent (multi-step), and failures are reported here. Only what isn't a browser action (or can't be
// done without one: the browser isn't in front for a page task) falls through to Claude.

export interface QuickResult {
  handled: boolean;
  message?: string;       // shown in the bubble when handled
  intent?: string;
  confidence?: number;
  ms?: number;
  reason?: string;        // why it fell through to Claude
  task?: boolean;         // a multi-step task on the current page: run `visioncli browse` (the Jev agent) instead
}

const INTENTS: Record<string, string> = {
  switch_tab: "Go to, show or switch to one of the browser tabs that is already open.",
  open_site: "Open a website that is not already open, e.g. 'open github' or 'go to laravel.com'.",
  web_search: "Search the web for something, e.g. 'search for laravel queues' or 'google stripe webhooks'.",
  click: "Click, press, select or follow a specific button, link or tab on the current web page.",
  scroll_down: "Scroll the current page down / show more below.",
  scroll_up: "Scroll the current page up.",
  scroll_top: "Go to the top of the current page.",
  scroll_bottom: "Go to the bottom of the current page.",
  play_pause: "Play, pause or resume the video or audio on the current page (e.g. 'pause the video', 'play it').",
  mute: "Mute or unmute the video or audio on the current page.",
  back: "Go back to the previous page.",
  forward: "Go forward to the next page.",
  reload: "Reload / refresh the current page.",
  close_tab: "Close the current browser tab.",
  new_tab: "Open a new empty browser tab.",
  browser_task:
    "Do a multi-step task on the web page that is open in front, e.g. fill in a form, search on this site and open a result, " +
    "set filters, pick options, add something to a cart. Several clicks or typing on the page, all said in the command.",
  ask_claude:
    "Anything else: a question about what is on screen or in the code, an explanation, a code change, typing outside a web page, " +
    "running commands, or a task outside the open web page. Also any request that is not clearly a browser action.",
};

export function apiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    if (existsSync(INTEGRATIONS_FILE)) return JSON.parse(readFileSync(INTEGRATIONS_FILE, "utf8"))?.typesafe?.apiKey || undefined;
  } catch {}
  return undefined;
}

export interface Answer { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }

async function jev(state: unknown, questions: Record<string, unknown>, key: string): Promise<Record<string, Answer>> {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).answers;
}

/** Words after the command verb, e.g. "search for laravel queues" → "laravel queues". */
export function phrase(utterance: string): string {
  return utterance
    .replace(/[.?!]+$/, "")
    .replace(/^(hey |ok |okay |please |can you |could you |would you |i want to |let'?s )+/i, "")
    .replace(/^(search( the web)?( for)?|google|look up|find|open( up)?|go to|navigate to|show me|take me to|visit|launch)\s+/i, "")
    .replace(/\s+(on|in|with|using) (google|the web|the browser|brave|chrome|a new tab)$/i, "")
    .replace(/^(the )?(website|site|page) /i, "")
    .trim();
}

/** A spoken site name as a URL: a domain as is, anything else through Google's "I'm Feeling Lucky". */
export function siteUrl(name: string): string {
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(name.replace(/\s+/g, ""))) return name.replace(/\s+/g, "");
  // Not a domain: let Google pick the site ("I'm Feeling Lucky").
  return `https://www.google.com/search?btnI=1&q=${encodeURIComponent(name)}`;
}

export const MIN_INTENT = 0.7;
/** A one-step action this likely still runs (switch_tab falls back to opening the site): undoing it is one command. */
export const MIN_SAFE_INTENT = 0.45;
/** How likely a command must be to concern the browser at all (every intent but ask_claude) for the agent to take it. */
export const MIN_BROWSER = 0.55;
const SAFE_INTENTS = new Set(["switch_tab", "open_site", "web_search", "scroll_down", "scroll_up", "scroll_top", "scroll_bottom",
  "play_pause", "mute", "back", "forward", "reload", "new_tab"]);
export const MIN_TARGET = 0.55;
export const MAX_ELEMENTS = 60; // page elements offered to Jev (in page order): enough for a screenful, keeps the request fast

/** The Jev questions: the intent, plus which open tab / page element is meant when there are candidates. */
export function quickQuestions(tabList: browser.Tab[], els: browser.Element[], pageTasks = false): Record<string, unknown> {
  // Multi-step page tasks only make sense with the browser in front (they act on the page you're looking at).
  const criteria = pageTasks ? INTENTS : Object.fromEntries(Object.entries(INTENTS).filter(([k]) => k !== "browser_task"));
  const questions: Record<string, unknown> = {
    intent: {
      type: "choice",
      instructions: "What does the user want done with `spoken_command`? Pick the single matching action.",
      criteria,
    },
  };
  if (tabList.length) {
    questions.tab = {
      type: "choice",
      instructions: "Suppose the user wants to switch to an already-open browser tab: which of these open tabs do they mean (by title, site or topic)?",
      criteria: { ...Object.fromEntries(tabList.map((t) => [t.id, `${t.title.slice(0, 80)} (${t.url.slice(0, 80)})`])), none: "None of the open tabs matches." },
    };
  }
  if (els.length) {
    questions.element = {
      type: "choice",
      instructions: "Suppose the user wants to click something on the current web page: which of these page elements do they mean?",
      criteria: { ...Object.fromEntries(els.map((e) => [e.id, `${e.kind}: ${e.text}${e.href ? ` (${e.href})` : ""}`])), none: "None of these elements matches." },
    };
  }
  return questions;
}

/** How likely the command is a browser action of any kind: everything but ask_claude. */
export function browserShare(a: Record<string, Answer | undefined>): number {
  const p = a.intent?.probabilities;
  if (p && typeof p.ask_claude === "number") return 1 - p.ask_claude;
  const c = a.intent?.confidence ?? 0;
  return a.intent?.choice === "ask_claude" ? 1 - c : c;
}

/** The intent, and whether to run it, give it to the Jev agent (`task`) or let Claude have it (`fallthrough` says why).
 *  `pageTasks`: the browser is in front, so the agent can work on the page. */
export function readIntent(a: Record<string, Answer | undefined>, pageTasks = true): { intent: string; confidence: number; fallthrough?: string; task?: boolean } {
  const intent = a.intent?.choice ?? "ask_claude";
  const confidence = a.intent?.confidence ?? 0;
  const share = browserShare(a);
  // Probably about the page after all (or a browser action Jev isn't sure which of): the agent works it out step by step.
  const toAgent = pageTasks && share >= MIN_BROWSER;
  if (intent === "ask_claude") return toAgent ? { intent: "browser_task", confidence: share, task: true } : { intent, confidence, fallthrough: "needs Claude" };
  if (confidence >= MIN_INTENT) return { intent, confidence };
  if (confidence >= MIN_SAFE_INTENT && SAFE_INTENTS.has(intent)) return { intent, confidence };
  if (toAgent) return { intent: "browser_task", confidence: share, task: true };
  return { intent, confidence, fallthrough: `unsure (${confidence.toFixed(2)})` };
}

/** What a confident intent does, with its target resolved (a weak target falls back or falls through). */
export type QuickPlan =
  | { do: "fallthrough"; reason: string }
  | { do: "switch_tab"; tab: string }
  | { do: "open_site"; site: string }
  | { do: "web_search"; query: string }
  | { do: "click"; element: string }
  | { do: "scroll"; where: "down" | "up" | "top" | "bottom" }
  | { do: "play_pause" | "mute" }
  | { do: "navigate"; action: "back" | "forward" | "reload" | "close" | "new" };

const sure = (t: Answer | undefined): t is Answer & { choice: string } =>
  !!t?.choice && t.choice !== "none" && (t.confidence ?? 0) >= MIN_TARGET;

export function plan(intent: string, a: Record<string, Answer | undefined>, utterance: string): QuickPlan {
  switch (intent) {
    case "switch_tab":
      // Not open yet: treat as opening the site.
      return sure(a.tab) ? { do: "switch_tab", tab: a.tab.choice } : { do: "open_site", site: phrase(utterance) };
    case "open_site":
      return { do: "open_site", site: phrase(utterance) };
    case "web_search":
      return { do: "web_search", query: phrase(utterance) };
    case "click":
      return sure(a.element) ? { do: "click", element: a.element.choice } : { do: "fallthrough", reason: "couldn't tell which element" };
    case "scroll_down": case "scroll_up": case "scroll_top": case "scroll_bottom":
      return { do: "scroll", where: intent.replace("scroll_", "") as "down" | "up" | "top" | "bottom" };
    case "play_pause": case "mute":
      return { do: intent };
    case "back": case "forward": case "reload":
      return { do: "navigate", action: intent };
    case "close_tab":
      return { do: "navigate", action: "close" };
    case "new_tab":
      return { do: "navigate", action: "new" };
    default:
      return { do: "fallthrough", reason: `unhandled intent ${intent}` };
  }
}

export async function quick(utterance: string): Promise<QuickResult> {
  const started = Date.now();
  const key = apiKey();
  if (!key) return { handled: false, reason: "no TypeSafe API key" };
  if (utterance.split(/\s+/).length > 25) return { handled: false, reason: "too long for a quick command" };

  let b: browser.BrowserName;
  let inFront: boolean;
  try {
    ({ browser: b, front: inFront } = await browser.pickWithFront());
  } catch {
    return { handled: false, reason: "no supported browser running" };
  }

  // Candidates the answers can point at. Page elements only when the browser is in front (it's what "this page" means).
  const [tabList, allEls] = await Promise.all([
    browser.tabs(b).catch(() => [] as browser.Tab[]),
    inFront ? browser.elements(b).catch(() => [] as browser.Element[]) : ([] as browser.Element[]),
  ]);
  const els = allEls.slice(0, MAX_ELEMENTS);
  const active = tabList.find((t) => t.active);

  // The candidates go to Jev once, as the choice criteria (not repeated in the state), to keep the request small.
  const state = {
    spoken_command: utterance,
    note: "The command came from speech-to-text, so words may be misheard.",
    browser: b,
    browser_is_front_app: inFront,
    current_tab: active ? { title: active.title.slice(0, 80), url: active.url.slice(0, 100) } : null,
  };

  const questions = quickQuestions(tabList, els, inFront);

  let a: Record<string, Answer>;
  try {
    // One retry: a slow first answer after idle shouldn't hand a browser command to Claude.
    a = await jev(state, questions, key).catch(() => jev(state, questions, key));
  } catch (err) {
    // The command passed the browser-command filter: say what went wrong instead of quietly asking Claude.
    return { handled: true, reason: "TypeSafe unreachable", message: `Browser control couldn't reach TypeSafe: ${String((err as Error).message ?? err).slice(0, 120)}`, ms: Date.now() - started };
  }
  const { intent, confidence: conf, fallthrough: why, task } = readIntent(a, inFront);
  const base = { intent, confidence: conf, ms: 0 };
  const fallthrough = (reason: string): QuickResult => ({ handled: false, ...base, reason, ms: Date.now() - started });
  const toAgent = (reason: string): QuickResult => ({ handled: false, ...base, task: true, reason, ms: Date.now() - started });
  if (why) return fallthrough(why);
  if (task || intent === "browser_task") return toAgent("browser task");
  if (process.env.VISIONCLI_QUICK_DRY === "1") {
    const target = intent === "switch_tab" ? a.tab : intent === "click" ? a.element : undefined;
    const label = target?.choice && target.choice !== "none"
      ? (tabList.find((t) => t.id === target.choice)?.title ?? els.find((e) => e.id === target.choice)?.text ?? target.choice)
      : "";
    return { handled: true, ...base, message: `[dry run] ${intent}${label ? ` → ${label} (${(target?.confidence ?? 0).toFixed(2)})` : ""}${["open_site", "web_search"].includes(intent) ? ` → "${phrase(utterance)}"` : ""}`, ms: Date.now() - started };
  }

  const p = plan(intent, a, utterance);
  try {
    let message = "";
    switch (p.do) {
      case "fallthrough":
        // A click whose target Jev couldn't pick from the visible elements: the agent looks at the whole page.
        return inFront ? toAgent(p.reason) : fallthrough(p.reason);
      case "switch_tab":
        await browser.switchTo(p.tab, b);
        message = `Switched to “${tabList.find((x) => x.id === p.tab)?.title ?? p.tab}”`;
        break;
      case "open_site":
        await browser.open(siteUrl(p.site), true, b, tabList);
        message = `Opened ${p.site}`;
        break;
      case "web_search":
        await browser.open(`https://www.google.com/search?q=${encodeURIComponent(p.query)}`, true, b, tabList);
        message = `Searching for “${p.query}”`;
        break;
      case "click":
        message = `Clicked “${await browser.click(p.element, b)}”`;
        break;
      case "scroll":
        await browser.scroll(p.where, b);
        message = { down: "Scrolled down", up: "Scrolled up", top: "Top of page", bottom: "Bottom of page" }[p.where];
        break;
      case "play_pause": {
        const r = await browser.js(`(() => { const m = [...document.querySelectorAll('video, audio')].sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0];
          if (!m) return 'none'; if (m.paused) { m.play(); return 'Playing'; } m.pause(); return 'Paused'; })()`, b);
        message = r === "none" ? "No video or audio on this page" : r;
        break;
      }
      case "mute": {
        const r = await browser.js(`(() => { const m = document.querySelector('video, audio'); if (!m) return 'none'; m.muted = !m.muted; return m.muted ? 'Muted' : 'Unmuted'; })()`, b);
        message = r === "none" ? "No video or audio on this page" : r;
        break;
      }
      case "navigate":
        await browser.navigate(p.action, b);
        message = { back: "Back", forward: "Forward", reload: "Reloaded", close: "Closed the tab", new: "New tab" }[p.action];
        break;
    }
    return { handled: true, ...base, message, ms: Date.now() - started };
  } catch (err) {
    // The action itself failed (e.g. JavaScript from Apple Events is off): report it rather than silently asking Claude.
    return { handled: true, ...base, message: String((err as Error).message ?? err), ms: Date.now() - started };
  }
}

/** Tiny request to wake the service up (the first call after idle can take a few seconds). */
export async function warm(): Promise<string> {
  const key = apiKey();
  if (!key) return "no key";
  const t = Date.now();
  await jev({ spoken_command: "scroll down" }, { intent: { type: "choice", instructions: "Which action?", criteria: { scroll: "Scroll", other: "Other" } } }, key);
  return `warm in ${Date.now() - t}ms`;
}
