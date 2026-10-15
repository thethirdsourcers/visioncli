// Hide VisionCLI from screen sharing and recordings (SettingsWindow.swift's "Hide VisionCLI from screen sharing",
// NSWindow.sharingType = .none on macOS). Every window the app makes gets content protection, applied in one place:
// on creation (Electron's browser-window-created) and to all open windows when the setting changes.
// Windows: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE), so you still see them but shares and recordings don't.
// Linux: X11 and Wayland have no equivalent, so the setting is off there.

export interface ProtectableWindow { isDestroyed(): boolean; setContentProtection(on: boolean): void }

export const canHideFromCapture = (platform: string = process.platform) => platform === "win32" || platform === "darwin";

/** Turns content protection on or off for these windows (skipping closed ones); a no-op where it isn't supported. */
export function applyContentProtection(windows: ProtectableWindow[], on: boolean, platform: string = process.platform): number {
  if (!canHideFromCapture(platform)) return 0;
  let n = 0;
  for (const w of windows) {
    if (w.isDestroyed()) continue;
    try { w.setContentProtection(on); n++; } catch {}
  }
  return n;
}

/** Applies the setting to every window as it's created and whenever it changes. */
export function installContentProtection(deps: {
  onWindowCreated(cb: (w: ProtectableWindow) => void): void;
  allWindows(): ProtectableWindow[];
  isOn(): boolean;
  onChange(cb: () => void): void;
  platform?: string;
}): void {
  const platform = deps.platform ?? process.platform;
  if (!canHideFromCapture(platform)) return;
  // Only when on: a new window isn't protected by default, so there's nothing to undo.
  deps.onWindowCreated((w) => { if (deps.isOn()) applyContentProtection([w], true, platform); });
  deps.onChange(() => applyContentProtection(deps.allWindows(), deps.isOn(), platform));
}
