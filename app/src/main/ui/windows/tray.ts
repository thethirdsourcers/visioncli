import { Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions, type NativeImage } from "electron";
import { log } from "../../log";
import { gaugeIcon, ringIcon, trayIcon, warningIcon } from "./icons";
import { buildMenu, tooltip, trayRings, type LocalId, type MItem } from "./menu";
import type { MenuId, MenuModel } from "./types";

// The menu-bar item (App+Menu.swift) as an Electron Tray (StatusNotifierItem on Linux). macOS rebuilds the menu
// each time it opens (menuNeedsUpdate); a StatusNotifier menu is exported over D-Bus ahead of time, so it's rebuilt
// whenever the model changes: on refresh() from the orchestrator, and on a light poll (resets roll over, like the
// 60 s timer on macOS).

/** Dark panels get a light glyph: GNOME's top bar is always dark, otherwise follow the theme. */
function lightGlyph(): boolean {
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  return nativeTheme.shouldUseDarkColors || /gnome|unity|ubuntu|pantheon|budgie/.test(desktop);
}

function image(make: (scale: number) => Buffer): NativeImage {
  const img = nativeImage.createFromBuffer(make(1), { scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, buffer: make(2) });
  return img;
}

export class TrayMenu {
  readonly tray: Tray;
  private last = "";
  private timer: NodeJS.Timeout;
  private icons = new Map<string, NativeImage>();

  constructor(private model: () => MenuModel, private click: (id: MenuId | LocalId, arg?: string | null) => void) {
    this.tray = new Tray(this.icon("tray:none"));
    this.tray.setToolTip("VisionCLI");
    this.tray.on("click", () => this.click("menuOpened"));
    this.tray.on("right-click", () => this.click("menuOpened"));
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 15_000);
    nativeTheme.on("updated", () => { this.icons.clear(); this.refresh(true); });
  }

  /** Rebuilds the menu, icon and tooltip if anything changed (or `force`). */
  refresh(force = false) {
    let m: MenuModel;
    try { m = this.model(); } catch (e) { log(`tray: menu model failed: ${e}`); return; }
    const items = buildMenu(m);
    const rings = trayRings(m);
    const key = JSON.stringify([items, rings, tooltip(m), new Date().getMinutes()]);
    if (!force && key === this.last) return;
    this.last = key;
    this.tray.setImage(this.icon(rings ? `tray:${rings.session}:${rings.week}` : "tray:none", rings));
    this.tray.setToolTip(tooltip(m));
    this.tray.setContextMenu(Menu.buildFromTemplate(items.map((i) => this.toElectron(i))));
  }

  destroy() {
    clearInterval(this.timer);
    this.tray.destroy();
  }

  private icon(key: string, rings?: { session: number; week: number | null } | null): NativeImage {
    let img = this.icons.get(key);
    if (!img) {
      const light = lightGlyph();
      img = key.startsWith("tray:") ? image((scale) => trayIcon({ light, rings, scale }))
        : key === "warning" ? image(warningIcon)
        : key === "gauge" ? image((s) => gaugeIcon(light, s))
        : image((s) => ringIcon(Number(key.slice(5)), light, s));
      if (this.icons.size > 200) this.icons.clear();
      this.icons.set(key, img);
    }
    return img;
  }

  private toElectron(i: MItem): MenuItemConstructorOptions {
    if (i.type === "separator") return { type: "separator" };
    const o: MenuItemConstructorOptions = { label: i.label, type: i.type ?? "normal", enabled: i.enabled ?? true };
    if (i.checked !== undefined) o.checked = i.checked;
    if (i.icon) o.icon = this.icon(typeof i.icon === "string" ? i.icon : `ring:${i.icon.ring}`);
    if (i.submenu) o.submenu = i.submenu.map((s) => this.toElectron(s));
    else if (i.id) {
      const { id, arg } = i;
      o.click = () => this.click(id, arg);
    }
    return o;
  }
}
