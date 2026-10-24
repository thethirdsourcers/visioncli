import type { Phase } from "../contracts";
import { App } from "./core";
import type { OverlayKey } from "./keys";

// The bubble (App+Panel.swift): showing it for a phase, the mascot, which overlay keys are live, hiding it later.
// Placement and following the pointer are the overlay module's job.

declare module "./core" {
  interface App {
    set(phase: Phase): void;
    scheduleHide(seconds: number): void;
    flash(message: string, seconds?: number): void;
    setOverlayKeys(keys: Partial<Record<OverlayKey, boolean>>): void;
    readonly takesMouse: boolean;
  }
}

Object.defineProperty(App.prototype, "takesMouse", {
  get(this: App) { return this.state.pinned || ["approval", "answering", "done", "error"].includes(this.state.phase); },
});

App.prototype.set = function (this: App, phase: Phase) {
  this.state.phase = phase;
  if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  if (phase !== "listening") this.ui.spotlight(null);
  this.ui.mascot.state(phase === "listening" ? "listening" : phase === "thinking" ? "thinking" : "hidden", this.state.level);
  this.hotkeys.setListening?.(phase === "listening");
  if (phase === "idle") {
    this.state.pinned = false;
    this.state.toast = "";
    this.state.approval = undefined;
    this.setOverlayKeys({});
    this.announcer.bubbleHidden();
    this.windows.refreshMenu();
    return;
  }
  this.setOverlayKeys({
    esc: true,
    pin: ["answering", "done", "error"].includes(phase),
    open: phase === "done",
    allow: phase === "approval",
  });
};

App.prototype.setOverlayKeys = function (this: App, keys: Partial<Record<OverlayKey, boolean>>) {
  keys = { ...keys, fix: !!this.offeredError }; // Alt+E lives as long as the error offer, whatever the bubble does
  this.overlayKeys = keys;
  this.keys.set(keys);
  this.hotkeys.setOverlayKeys(this.keys.active);
};

App.prototype.scheduleHide = function (this: App, seconds: number) {
  if (this.hideTimer) clearTimeout(this.hideTimer);
  this.hideTimer = null;
  if (this.state.pinned) return;
  this.hideTimer = setTimeout(() => {
    this.hideTimer = null;
    if (this.state.pinned) return;
    // Still reading (pointer on the bubble): check again shortly.
    if (this.ui.pointerOverBubble()) { this.scheduleHide(5); return; }
    this.set("idle");
    this.ui.hideMarks();
  }, seconds * 1000);
};

App.prototype.flash = function (this: App, message: string, seconds = 5) {
  this.state.raw = message;
  this.set("error");
  this.scheduleHide(seconds);
};
