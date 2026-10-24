import { globalShortcut } from "electron";
import {
  DEFAULT_SHORTCUTS, type HoldKey, type KeyPress, SHORTCUT_IDS, SHORTCUT_TITLES, type ShortcutId,
  activeKeys, holdNames, machineKeys, recordShortcut, resolveShortcuts, shortcutLabel,
} from "../input/shortcuts";
import { log } from "../log";
import { settings } from "../settings";
import type { SettingsSnapshot } from "../ui/windows";
import { App } from "./core";

// Settings → General → Shortcuts (ShortcutsCard.swift): the hold-to-talk key and the key combinations, stored in
// settings and put to work at once: the hold machine reads them on every key, the overlay keys and the Meeting
// Notes shortcut are registered again with globalShortcut, and the bubble's hints follow.

const HOLD_KEYS: HoldKey[] = ["alt", "ctrl", "super"];
const MEETING_FALLBACK = "Ctrl+Alt+Shift+R"; // when the default is taken (some desktops keep Super combinations)

declare module "./core" {
  interface App {
    shortcuts(): Record<ShortcutId, string>;
    shortcutLabels(): Record<ShortcutId, string>;
    applyShortcuts(): void;
    shortcutsSnapshot(): SettingsSnapshot["shortcuts"];
    shortcutAction(name: string, value: unknown): void;
    shortcutNote: string;
  }
}

let meetingAccel: string | null = null;
App.prototype.shortcutNote = "";

App.prototype.shortcuts = function (this: App) { return resolveShortcuts(settings.get("shortcuts")); };

App.prototype.shortcutLabels = function (this: App) {
  const s = this.shortcuts();
  return Object.fromEntries(SHORTCUT_IDS.map((id) => [id, shortcutLabel(s[id])])) as Record<ShortcutId, string>;
};

App.prototype.applyShortcuts = function (this: App) {
  const s = this.shortcuts();
  activeKeys.current = machineKeys(settings.get("holdKey"), s);
  this.keys.setAccelerators({ pin: s.pin, open: s.open, allow: s.allow, fix: s.fix });
  const l = this.shortcutLabels();
  this.state.keys = { pin: l.pin, open: l.open, allow: l.allow };
  // Meeting Notes, from anywhere: the chosen keys, or the fallback when the default can't be had.
  if (meetingAccel) try { globalShortcut.unregister(meetingAccel); } catch {}
  meetingAccel = null;
  const tries = s.meeting === DEFAULT_SHORTCUTS.meeting ? [s.meeting, MEETING_FALLBACK] : [s.meeting];
  for (const sc of tries) {
    let ok = false;
    try { ok = globalShortcut.register(sc, () => this.showMeetingLauncher()); } catch {}
    if (ok) { meetingAccel = sc; this.meetingShortcut = shortcutLabel(sc); log(`meeting: shortcut ${this.meetingShortcut}`); return; }
    log(`meeting: couldn't register ${sc}`);
  }
  this.meetingShortcut = l.meeting;
  this.shortcutNote = `${l.meeting} couldn't be set up for Meeting Notes: another app may use it.`;
};

App.prototype.shortcutsSnapshot = function (this: App) {
  const hold = settings.get("holdKey"), saved = settings.get("shortcuts") ?? {}, l = this.shortcutLabels(), n = holdNames(hold);
  return {
    hold, holdName: n.name, screenKeys: n.screen, added: n.added, note: this.shortcutNote,
    list: SHORTCUT_IDS.map((id) => ({ id, title: SHORTCUT_TITLES[id], keys: id === "meeting" ? this.meetingShortcut : l[id], custom: !!saved[id] })),
  };
};

App.prototype.shortcutAction = function (this: App, name, value) {
  this.shortcutNote = "";
  const saved = settings.get("shortcuts") ?? {};
  if (name === "setHoldKey") {
    if (HOLD_KEYS.includes(value as HoldKey)) settings.set("holdKey", value as HoldKey);
  } else if (name === "resetShortcut") {
    if (!SHORTCUT_IDS.includes(value as ShortcutId)) return;
    const next = { ...saved };
    delete next[value as ShortcutId];
    settings.set("shortcuts", next);
  } else if (name === "recordShortcut") {
    const v = value as { id: ShortcutId } & KeyPress;
    if (!v || !SHORTCUT_IDS.includes(v.id)) return;
    const r = recordShortcut(saved, v.id, { code: String(v.code), ctrl: !!v.ctrl, alt: !!v.alt, shift: !!v.shift, meta: !!v.meta });
    if (!r.saved) { this.shortcutNote = r.note; return; }
    settings.set("shortcuts", r.saved);
  } else return;
  this.applyShortcuts();
};
