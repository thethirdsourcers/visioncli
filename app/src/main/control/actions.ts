// What the MCP server asks for (the request's "action"), and the pure rules around it. Port of the ControlAction enum
// and the policy bits of overlay/Sources/Control.swift. src/control.ts mirrors these names (a test keeps them equal).

export const ControlAction = {
  status: "status",
  displays: "displays",
  announce: "announce",
  capture: "capture",
  elements: "elements",
  click: "click",
  type: "type",
  key: "key",
  scroll: "scroll",
  drag: "drag",
  openApp: "open_app",
  focusApp: "focus_app",
  openURL: "open_url",
} as const;
export type ControlActionName = (typeof ControlAction)[keyof typeof ControlAction];

export const CONTROL_ACTION_NAMES: ControlActionName[] = Object.values(ControlAction);

export const isControlAction = (a: string): a is ControlActionName => (CONTROL_ACTION_NAMES as string[]).includes(a);

/** Keys and typing go to the app the assistant is working in. */
export const usesKeyboard = (a: string) => a === "type" || a === "key";

/** Answered right away, no approval, and they work even when control is off. */
export const READ_ONLY: ReadonlySet<string> = new Set(["announce", "status", "displays", "capture", "elements"]);

/**
 * Apps where every action asks first, even with "Allow all": settings, password managers, keyrings and polkit/sudo
 * prompts. Matched against the window's app id (WM_CLASS / app_id / desktop id) and name, lowercased, as substrings.
 * (macOS: System Settings, Keychain Access, Passwords, 1Password, Bitwarden, LastPass, Dashlane, Terminal sudo.)
 */
export const SENSITIVE_APPS = [
  "gnome-control-center", "org.gnome.settings", "systemsettings", "org.kde.systemsettings", "kcmshell", "xfce4-settings",
  "cinnamon-settings", "mate-control-center", "keepassxc", "keepass", "1password", "bitwarden", "lastpass", "dashlane",
  "seahorse", "kwalletmanager", "gnome-keyring", "gcr-prompter", "pinentry", "polkit", "lxpolkit", "authentication-agent",
  // Windows: Settings (SystemSettings.exe matches "systemsettings" above), the credential prompt, Windows Security
  "credentialuibroker", "sechealthui", "registry editor", "user account control", "credential manager",
];

/** Windows programs matched by their exact exe name (short names that would match unrelated apps as substrings):
 *  Microsoft Management Console, the Registry Editor, the UAC prompt, Control Panel, policy editors. */
export const SENSITIVE_EXES = ["mmc", "regedit", "consent", "control", "gpedit", "secpol", "lusrmgr", "certmgr", "netplwiz", "useraccountcontrolsettings"];

export function isSensitiveApp(app: { appId?: string; app?: string } | null | undefined): boolean {
  if (!app) return false;
  const id = (app.appId ?? "").toLowerCase(), name = (app.app ?? "").toLowerCase();
  if (SENSITIVE_EXES.some((e) => id === e || id === `${e}.exe` || name === `${e}.exe`)) return true;
  return SENSITIVE_APPS.some((s) => (id && id.includes(s)) || (name && name.includes(s)));
}

/** Chrome/Brave/Chromium/Edge: the browser_* tools are exact (Edge over DevTools); keyboard navigation there opened
 *  stray tabs and windows. */
export function isBrowserApp(app: { appId?: string; app?: string } | null | undefined): boolean {
  if (!app) return false;
  const s = `${app.appId ?? ""} ${app.app ?? ""}`.toLowerCase();
  return /google-chrome|chrome|chromium|brave|msedge|microsoft-edge|microsoft edge/.test(s);
}

const MOD_ALIASES: Record<string, string> = {
  cmd: "super", command: "super", "⌘": "super", super: "super", meta: "super", win: "super",
  ctrl: "ctrl", control: "ctrl", "⌃": "ctrl", shift: "shift", "⇧": "shift", alt: "alt", option: "alt", opt: "alt", "⌥": "alt",
};

/** "Ctrl+Shift+N" → "ctrl+shift+n" with modifiers in a fixed order, so combos compare exactly. */
export function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  const keys: string[] = [];
  for (const p of parts) {
    const m = MOD_ALIASES[p];
    if (m) mods.add(m); else keys.push(p);
  }
  return [...["ctrl", "super", "alt", "shift"].filter((m) => mods.has(m)), ...keys].join("+");
}

// Open location / new tab / new window / new private window, with Ctrl (Linux, Windows) or Super/Cmd (the macOS names
// models use; on Windows Win+L would lock the screen, so it's refused there too).
const BROWSER_NAV = new Set(["l", "t", "n", "shift+n"].flatMap((k) => [`ctrl+${k}`, `super+${k}`]));

/** True when `keys` (space-separated combos) contains a browser navigation shortcut. */
export function isBrowserNavShortcut(keys: string): boolean {
  return keys.split(/\s+/).filter(Boolean).some((c) => BROWSER_NAV.has(normalizeCombo(c)));
}

export function browserGuardMessage(appName: string): string {
  return `Don't use keyboard shortcuts to open or navigate pages in ${appName}. Use browser_open (reuses tabs), browser_navigate, browser_switch_tab, browser_elements + browser_click/browser_type/browser_select. Use click/type_text only for things those can't reach (canvas, cross-origin frames, browser dialogs).`;
}

type Req = Record<string, unknown>;
const n = (r: Req, k: string): number | undefined => (typeof r[k] === "number" ? (r[k] as number) : undefined);

/** The step, in words: "click "Save" button in Files", "type "hello" in gedit" … (Control.swift `what`). */
export function describeAction(action: string, r: Req, ctx: { appName: string; elementLabel?: string | null; target?: { x: number; y: number } | null; element?: number | null }): string {
  const on = ctx.elementLabel ?? (ctx.target ? `(${Math.trunc(ctx.target.x)}, ${Math.trunc(ctx.target.y)})` : "");
  const appName = ctx.appName;
  switch (action) {
    case "click": {
      const click = r.button === "right" ? "right-click" : (n(r, "count") ?? 1) >= 2 ? "double-click" : "click";
      return `${click} ${on} in ${appName}`;
    }
    case "type": {
      const t = typeof r.text === "string" ? r.text : "";
      const chars = [...t];
      return `type "${chars.length > 60 ? chars.slice(0, 60).join("") + "…" : t}"${ctx.element != null ? ` into ${on}` : ""} in ${appName}`;
    }
    case "key": return `press ${typeof r.keys === "string" ? r.keys : ""} in ${appName}`;
    case "scroll": return `scroll in ${appName}`;
    case "drag": return `drag from (${Math.trunc(n(r, "x1") ?? 0)}, ${Math.trunc(n(r, "y1") ?? 0)}) to (${Math.trunc(n(r, "x2") ?? 0)}, ${Math.trunc(n(r, "y2") ?? 0)}) in ${appName}`;
    case "open_app": return `open ${typeof r.name === "string" ? r.name : "an app"}`;
    case "focus_app": return `switch to ${typeof r.name === "string" ? r.name : "an app"}`;
    case "open_url": return `open ${typeof r.url === "string" ? r.url : "a link"}`;
    default: return action;
  }
}

export const capitalize = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);

/** "https://" is added to bare hosts; null for something that isn't a URL. */
export function normalizeUrl(s: string): string | null {
  const u = s.includes("://") ? s : "https://" + s;
  try { new URL(u); return u; } catch { return null; }
}
