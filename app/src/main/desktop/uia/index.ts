import type { Accessibility, DesktopWindow, PickedElement, Point, UIElement } from "../../contracts";
import { log } from "../../log";
import { type WinHelper, winHelper } from "../windows/win32";

// The front app's UI through UI Automation (UIElements in Control.swift), walked by the helper with the macOS limits
// (depth 30, 350 items, 5000 nodes, 4 s). Roles come back as the macOS AX names (Button, TextField…); press uses
// Invoke / Toggle / SelectionItem / ExpandCollapse, setValue the ValuePattern; IsPassword marks secure fields.

export function createUiaAccessibility(helper: WinHelper = winHelper()): Promise<Accessibility> {
  return Promise.resolve(new Uia(helper));
}

export class Uia implements Accessibility {
  constructor(private helper: WinHelper, private ownPid = process.pid) {}

  async available(): Promise<boolean> {
    try { await this.helper.call("hello", {}); return true; } catch { return false; }
  }

  async elements(app?: string): Promise<{ app: string; elements: UIElement[] }> {
    const r = await this.helper.call("elements", { ...(app ? { app } : {}), excludePid: this.ownPid });
    return {
      app: r.app,
      elements: r.elements.map((e) => ({ id: e.id, role: e.role, label: e.label.replace(/\s+/g, " ").trim().slice(0, 100), x: e.x, y: e.y, w: e.w, h: e.h })),
    };
  }

  async press(id: number): Promise<boolean> {
    // A press that opens a dialog can take a while to return (the helper allows 15 s): timing out would fall back to a real
    // click and press twice.
    try { return await this.helper.call("press", { id }); } catch { return false; }
  }

  async setValue(id: number, text: string): Promise<boolean> {
    try { return await this.helper.call("setValue", { id, text }); } catch { return false; }
  }

  async isSecure(target: { id?: number; at?: Point; focused?: boolean }): Promise<boolean> {
    try {
      if (target.id !== undefined) return await this.helper.call("isSecure", { id: target.id });
      if (target.at) return await this.helper.call("isSecure", { x: Math.round(target.at.x), y: Math.round(target.at.y) });
      if (target.focused) return await this.helper.call("isSecure", { focused: true });
    } catch (e) { log(`uia isSecure: ${(e as Error).message}`); }
    return false;
  }

  async elementAt(p: Point, window: DesktopWindow | null): Promise<PickedElement | null> {
    if (!window) return null;
    const r = await this.helper.call("elementAt", { hwnd: window.id, x: Math.round(p.x), y: Math.round(p.y) }).catch(() => null);
    return r && { rect: { x: r.x, y: r.y, width: r.w, height: r.h }, about: r.about };
  }

  async windowText(max: number): Promise<{ app: string; title: string; text: string } | null> {
    try {
      const r = await this.helper.call("windowText", { max, excludePid: this.ownPid });
      return r ? { ...r, text: r.text.slice(0, max) } : null;
    } catch (e) {
      log(`uia windowText: ${(e as Error).message}`);
      return null;
    }
  }
}
