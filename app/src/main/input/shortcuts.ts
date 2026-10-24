// Customizable shortcuts (Hotkeys.swift HotKey.shortcut / HoldKey, ShortcutsCard.swift): the hold-to-talk key and
// VisionCLI's key combinations. A combination is kept as an Electron accelerator ("Alt+Shift+Space", modifiers in
// the order Ctrl, Alt, Shift, Super), which is also how it's registered with globalShortcut; the hold machine
// (hold.ts) matches the same combination on evdev codes. Pure: the app stores them in settings (app/shortcuts.ts).

export type HoldKey = "alt" | "ctrl" | "super";
export type ShortcutId = "point" | "pin" | "open" | "allow" | "fix" | "meeting";

/** The ones Settings → Shortcuts can change, in its order (Esc stays fixed). */
export const SHORTCUT_IDS: ShortcutId[] = ["point", "pin", "open", "allow", "fix", "meeting"];

export const SHORTCUT_TITLES: Record<ShortcutId, string> = {
  point: "Point at an area", pin: "Pin the answer", open: "Open the file in the answer", allow: "Allow an action",
  fix: "Fix a spotted terminal error", meeting: "Meeting Notes",
};

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  point: "Alt+Shift+Space", pin: "Alt+P", open: "Alt+O", allow: "Alt+Enter", fix: "Alt+E", meeting: "Alt+Shift+Super+R",
};

/** Keys a combination can use: name → [evdev code, Windows virtual-key code]. */
const KEYS: Record<string, [number, number]> = {
  Space: [57, 0x20], Enter: [28, 0x0d], Tab: [15, 0x09], Backspace: [14, 0x08], Up: [103, 0x26], Down: [108, 0x28], Left: [105, 0x25], Right: [106, 0x27],
};
"QWERTYUIOP".split("").forEach((c, i) => { KEYS[c] = [16 + i, c.charCodeAt(0)]; });
"ASDFGHJKL".split("").forEach((c, i) => { KEYS[c] = [30 + i, c.charCodeAt(0)]; });
"ZXCVBNM".split("").forEach((c, i) => { KEYS[c] = [44 + i, c.charCodeAt(0)]; });
"1234567890".split("").forEach((c, i) => { KEYS[c] = [2 + i, c.charCodeAt(0)]; });
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = [i <= 10 ? 58 + i : 76 + i, 0x6f + i];

const VK_TO_CODE = new Map(Object.values(KEYS).map(([code, vk]) => [vk, code]));
/** A Windows virtual-key code → the evdev code of the same key (undefined: not one a shortcut can use). */
export const vkToEvdev = (vk: number) => VK_TO_CODE.get(vk);

export interface Combo { ctrl: boolean; alt: boolean; shift: boolean; sup: boolean; key: string; code: number }

/** "Alt+Shift+Space" → its parts; null when it isn't a valid shortcut (unknown key, or no Ctrl, Alt or Super). */
export function parseShortcut(s: string): Combo | null {
  const parts = s.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const c = { ctrl: mods.delete("ctrl"), alt: mods.delete("alt"), shift: mods.delete("shift"), sup: mods.delete("super"), key, code: KEYS[key]?.[0] ?? -1 };
  return c.code >= 0 && !mods.size && (c.ctrl || c.alt || c.sup) ? c : null;
}

/** As shown: the Windows key is Win on Windows. */
export function shortcutLabel(s: string, platform: string = process.platform): string {
  return platform === "win32" ? s.replace("Super", "Win") : s;
}

/** The stored choices, each valid one in place of its default. */
export function resolveShortcuts(saved: Partial<Record<string, string>> | null | undefined): Record<ShortcutId, string> {
  const out = { ...DEFAULT_SHORTCUTS };
  for (const id of SHORTCUT_IDS) { const v = saved?.[id]; if (v && parseShortcut(v)) out[id] = v; }
  return out;
}

/** A key press in Settings → Shortcuts (KeyboardEvent.code and its modifiers; meta is Super / the Windows key). */
export interface KeyPress { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

/** KeyboardEvent.code → a key name from KEYS, or null. */
export function keyName(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d)|(F(?:[1-9]|1[0-2])))$/.exec(code);
  if (m) return m[1] ?? m[2] ?? m[3];
  const named: Record<string, string> = { Space: "Space", Enter: "Enter", NumpadEnter: "Enter", Tab: "Tab", Backspace: "Backspace", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
  return named[code] ?? null;
}

/** Records `press` as the new shortcut for `id`: the new saved choices, or a note saying why not. A choice equal to
 *  the default is dropped, so it follows the default. */
export function recordShortcut(saved: Partial<Record<string, string>>, id: ShortcutId, press: KeyPress, platform: string = process.platform):
  { saved: Partial<Record<string, string>>; note?: undefined } | { note: string; saved?: undefined } {
  const sup = platform === "win32" ? "Win" : "Super";
  const key = keyName(press.code);
  if (!press.ctrl && !press.alt && !press.meta) return { note: `Use Ctrl, Alt or ${sup} with the key, so it doesn't stop you typing.` };
  if (!key) return { note: "That key can't be used in a shortcut: use a letter, a number, F1–F12, Space, Enter, Tab, Backspace or an arrow." };
  const s = [press.ctrl && "Ctrl", press.alt && "Alt", press.shift && "Shift", press.meta && "Super", key].filter(Boolean).join("+");
  const all = resolveShortcuts(saved);
  const other = SHORTCUT_IDS.find((o) => o !== id && all[o] === s);
  if (other) return { note: `${shortcutLabel(s, platform)} is already used for “${SHORTCUT_TITLES[other]}”.` };
  const next = { ...saved };
  if (s === DEFAULT_SHORTCUTS[id]) delete next[id]; else next[id] = s;
  return { saved: next };
}

/** The hold key's name, and the keys held for a screenshot: the hold key plus Super, or Alt for Super holders. */
export function holdNames(hold: HoldKey, platform: string = process.platform): { name: string; screen: string; added: string } {
  const sup = platform === "win32" ? "Win" : "Super";
  const name = hold === "alt" ? "Alt" : hold === "ctrl" ? "Ctrl" : sup;
  return hold === "super" ? { name, screen: `Alt+${sup}`, added: "Alt" } : { name, screen: `${name}+${sup}`, added: sup };
}

// ── What the hold machine matches (set by the app, read on every key) ──

export interface MachineKeys { hold: HoldKey; point: Combo; pin: Combo; open: Combo; allow: Combo; fix: Combo }

const comboOf = (id: ShortcutId, s: Record<ShortcutId, string>) => parseShortcut(s[id]) ?? parseShortcut(DEFAULT_SHORTCUTS[id])!;

export function machineKeys(hold: HoldKey, shortcuts: Record<ShortcutId, string>): MachineKeys {
  return { hold, point: comboOf("point", shortcuts), pin: comboOf("pin", shortcuts), open: comboOf("open", shortcuts), allow: comboOf("allow", shortcuts), fix: comboOf("fix", shortcuts) };
}

export const activeKeys: { current: MachineKeys } = { current: machineKeys("alt", DEFAULT_SHORTCUTS) };
