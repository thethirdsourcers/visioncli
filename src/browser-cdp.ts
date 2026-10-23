import type { CDP } from "./cdp.js";

// Browser tabs over DevTools: the non-AppleScript backend for browser.ts (Linux). It runs inside browserd, which holds
// the one connection Chrome asked "Allow remote debugging?" for. DevTools has no "active tab", so each page is asked
// whether it's visible (= the selected tab of its window) and focused (= in the front window).

export interface PageInfo { targetId: string; url: string; title: string }
export interface CdpTab { id: string; window: number; index: number; title: string; url: string; active: boolean; targetId: string }

/** "c" + the first 8 characters of the target id: short, stable for the tab's lifetime, and never `t1.2`-shaped. */
export const tabId = (targetId: string) => "c" + targetId.slice(0, 8).toLowerCase();

/** Orders tabs: windows with a focused tab first, each window's visible tab marking it; ids as `tabId`. */
export function arrange(pages: (PageInfo & { windowId: number; visible: boolean; focused: boolean })[]): CdpTab[] {
  const windows = [...new Set(pages.map((p) => p.windowId))];
  const focusedWindow = pages.find((p) => p.focused)?.windowId ?? pages.find((p) => p.visible)?.windowId;
  windows.sort((a, b) => Number(b === focusedWindow) - Number(a === focusedWindow));
  return windows.flatMap((w, wi) =>
    pages.filter((p) => p.windowId === w).map((p, i) => ({
      id: tabId(p.targetId),
      window: wi + 1,
      index: i + 1,
      title: p.title,
      url: p.url,
      active: wi === 0 && p.visible, // only the front window's selected tab is "the" active tab
      targetId: p.targetId,
    })),
  );
}

/** A page's evaluated value as AppleScript's "execute javascript" would hand it back: text. */
export function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

export class CdpTabs {
  private sessions = new Map<string, Promise<string>>();

  constructor(private cdp: CDP) {
    cdp.on((method, params) => {
      if (method === "Target.detachedFromTarget" || method === "Target.targetDestroyed") {
        for (const [t, s] of this.sessions) {
          if (t === params.targetId) this.sessions.delete(t);
          else s.then((id) => { if (id === params.sessionId) this.sessions.delete(t); }, () => this.sessions.delete(t));
        }
      }
    });
  }

  /** A flat session on the page, kept for later calls. */
  session(targetId: string): Promise<string> {
    let s = this.sessions.get(targetId);
    if (!s) {
      s = this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }).then((r) => r.sessionId);
      s.catch(() => this.sessions.delete(targetId));
      this.sessions.set(targetId, s);
    }
    return s;
  }

  async pages(): Promise<PageInfo[]> {
    const { targetInfos } = await this.cdp.send<{ targetInfos: (PageInfo & { type: string })[] }>("Target.getTargets");
    return targetInfos
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
      .map(({ targetId, url, title }) => ({ targetId, url, title }));
  }

  async tabs(): Promise<CdpTab[]> {
    const pages = await this.pages();
    const info = await Promise.all(pages.map(async (p) => {
      const [windowId, state] = await Promise.all([
        this.cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: p.targetId }).then((r) => r.windowId, () => 0),
        // Discarded or frozen tabs may not answer: treat them as hidden.
        this.evaluate(p.targetId, "[document.visibilityState === 'visible', document.hasFocus()]", 1500).catch(() => [false, false]),
      ]);
      const [visible, focused] = (state as [boolean, boolean]) ?? [false, false];
      return { ...p, windowId, visible, focused };
    }));
    return arrange(info);
  }

  async activeTarget(): Promise<CdpTab | undefined> {
    return (await this.tabs()).find((t) => t.active);
  }

  /** Accepts a tab id from tabs() or a raw target id. */
  async resolve(id: string): Promise<string> {
    const pages = await this.pages();
    const hit = pages.find((p) => tabId(p.targetId) === id.toLowerCase() || p.targetId === id);
    if (!hit) throw new Error(`No tab ${id}. List the tabs again.`);
    return hit.targetId;
  }

  async evaluate(targetId: string, expression: string, timeoutMs = 10_000): Promise<unknown> {
    const sessionId = await this.session(targetId);
    const r = await this.cdp.send<any>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "JavaScript error");
    return r.result?.value;
  }

  async switchTo(id: string) {
    await this.cdp.send("Target.activateTarget", { targetId: await this.resolve(id) });
  }

  /** Creates a tab (in the last focused window) and brings it to the front; returns its target id. */
  async create(url: string): Promise<string> {
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url });
    await this.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
    return targetId;
  }

  async load(targetId: string, url: string) {
    await this.cdp.send("Page.navigate", { url }, await this.session(targetId));
    await this.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
  }

  private async front(): Promise<string> {
    const t = await this.activeTarget();
    if (!t) throw new Error("No active browser tab.");
    return t.targetId;
  }

  async navigate(action: "back" | "forward" | "reload" | "close" | "new") {
    if (action === "new") { await this.create("chrome://newtab/"); return; }
    const t = await this.front();
    if (action === "close") await this.cdp.send("Target.closeTarget", { targetId: t });
    else if (action === "reload") await this.cdp.send("Page.reload", {}, await this.session(t));
    else await this.evaluate(t, action === "back" ? "history.back()" : "history.forward()");
  }

  /** Puts files in a file input (found by `expression` in the active tab), the way choosing them in the dialog does. */
  async setFiles(expression: string, files: string[]) {
    const t = await this.front(), sessionId = await this.session(t);
    const r = await this.cdp.send<any>("Runtime.evaluate", { expression, returnByValue: false }, sessionId);
    if (!r.result?.objectId) throw new Error("No file input for that element.");
    await this.cdp.send("DOM.setFileInputFiles", { files, objectId: r.result.objectId }, sessionId);
  }

  async js(code: string): Promise<string> {
    return asText(await this.evaluate(await this.front(), code));
  }
}
