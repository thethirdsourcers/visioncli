import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import type { DesktopWindow } from "../contracts";
import { log } from "../log";

// Maps the window under the pointer to a project folder, so voice mode follows you between projects.
// Known projects come from JetBrains "recent projects" (PhpStorm, IntelliJ, …), VS Code/Cursor/Windsurf/VSCodium
// recents, and the usual code folders (~/projects, ~/PhpstormProjects, ~/dev, …). Window titles are split into
// tokens (e.g. PhpStorm "myshop – payments", VS Code "file.ts - myapp - Visual Studio Code") and matched by folder
// name. Port of overlay/Sources/Projects.swift with Linux config paths.
// Windows: the editors keep their recents under %APPDATA% (JetBrains\<Product>\options, Code\User\globalStorage…),
// paths have drive letters and backslashes, and folder names match case-insensitively (they already do here).

export const PROJECT_ROOTS = ["projects", "Projects", "PhpstormProjects", "IdeaProjects", "WebstormProjects", "PycharmProjects",
  "GolandProjects", "RiderProjects", "AndroidStudioProjects", "Developer", "dev", "code", "Code", "src", "workspace", "repos",
  "Sites", "Documents/GitHub", "Documents/Projects", "Desktop", "git", "work"];

const MARKERS = [".git", "package.json", "composer.json", "Package.swift", "Podfile", "build.gradle", "pubspec.yaml", "Cargo.toml",
  "go.mod", "pyproject.toml"];

/** Terminal emulators (their windows aren't projects). macOS list + Linux terminals. */
export const TERMINAL_APPS = new Set(["terminal", "iterm2", "warp", "ghostty", "kitty", "alacritty", "wezterm", "hyper", "tabby", "rio",
  "wave", "gnome-terminal", "gnome-terminal-server", "org.gnome.terminal", "console", "kgx", "org.gnome.console", "ptyxis",
  "org.gnome.ptyxis", "konsole", "org.kde.konsole", "xterm", "uxterm", "urxvt", "rxvt", "st", "st-256color", "foot", "footclient",
  "tilix", "terminator", "xfce4-terminal", "lxterminal", "mate-terminal", "qterminal", "sakura", "terminology", "guake", "tilda",
  "yakuake", "blackbox", "com.raggesilver.blackbox", "contour", "cool-retro-term", "deepin-terminal", "termite", "org.wezfurlong.wezterm",
  "com.mitchellh.ghostty",
  // Windows (exe names without .exe, and product names): Windows Terminal, the console host, shells, WezTerm…
  "windowsterminal", "windows terminal", "openconsole", "conhost", "console window host", "cmd", "windows command processor",
  "command prompt", "powershell", "windows powershell", "pwsh", "wezterm-gui", "mintty", "wsl", "wslhost", "fluentterminal",
  "cmder", "conemu", "conemu64", "termius"]);

const exeless = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\.exe$/, "");
export const isTerminal = (w: { app?: string; appId?: string }) =>
  TERMINAL_APPS.has(exeless(w.app)) || TERMINAL_APPS.has(exeless(w.appId));

/** A window-title token that is a path itself: /…, ~/…, C:\… or C:/…, \\server\share. */
export const isPathToken = (t: string) => t.startsWith("/") || t.startsWith("~") || /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\");

/** Paths in JetBrains' recentProjects.xml: `<entry key="$USER_HOME$/projects/shop">`; on Windows "C:/Users/me/shop". */
export function jetbrainsPaths(xml: string, home: string, platform: string = process.platform): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<entry key="([^"]+)"/g)) {
    const p = m[1].replaceAll("$USER_HOME$", home);
    out.push(platform === "win32" ? win32.normalize(p) : p);
  }
  return out;
}

/** Folder URIs in a VS Code-family storage.json: file:///home/me/app, or file:///c%3A/Users/me/app on Windows. */
export function vscodePaths(text: string, platform: string = process.platform): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/file:\/\/(\/[^"]+)/g)) {
    let p: string;
    try { p = decodeURIComponent(m[1]); } catch { continue; }
    if (platform === "win32") {
      if (!/^\/[A-Za-z]:/.test(p)) continue;
      p = win32.normalize(p.slice(1, 2).toUpperCase() + p.slice(2));
    }
    out.push(p);
  }
  return out;
}

export class ProjectResolver {
  private byName = new Map<string, string>(); // lowercased folder name → path (first source wins)
  private lastRefresh = 0;
  private building = false;

  constructor(private home = homedir(), private config = defaultConfigDir(), private platform: string = process.platform) {}

  /** Rebuilds the index in the background (scanning folders takes a while); lookups use the last index meanwhile. */
  refreshIfStale(now = Date.now()) {
    if (now - this.lastRefresh <= 300_000 || this.building) return;
    this.lastRefresh = now;
    this.building = true;
    this.buildIndex().then((map) => {
      this.byName = map;
      log(`projects indexed: ${map.size}`);
    }).finally(() => (this.building = false));
  }

  /** Builds and installs the index now (tests, first launch). */
  async refresh() {
    this.lastRefresh = Date.now();
    this.byName = await this.buildIndex();
    return this.byName;
  }

  async buildIndex(): Promise<Map<string, string>> {
    const found: string[] = [...this.jetbrainsRecents(), ...this.vscodeRecents()];
    for (const root of PROJECT_ROOTS) {
      const dir = join(this.home, root);
      const kids = await dirs(dir);
      for (const kid of kids) {
        found.push(kid);
        // One level deeper for grouped layouts like ~/projects/ios/MyApp.
        const grand = await dirs(kid);
        if (grand.length < 60) found.push(...grand.filter((g) => this.isProject(g)));
      }
    }
    const map = new Map<string, string>();
    for (const path of found) {
      const key = basename(path).toLowerCase();
      if (!map.has(key) && existsSync(path)) map.set(key, path);
    }
    return map;
  }

  project(window: Pick<DesktopWindow, "title"> | null | undefined): string | null {
    if (!window?.title) return null;
    this.refreshIfStale();
    for (const token of tokens(window.title)) {
      // Some IDEs show the path itself, e.g. "myshop [~/PhpstormProjects/myshop]".
      if (isPathToken(token)) {
        const path = token.startsWith("~") ? join(this.home, token.slice(1)) : token;
        try {
          const st = statSync(path);
          return this.gitRoot(st.isDirectory() ? path : dirname(path));
        } catch {}
      }
      const hit = this.byName.get(token.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  /** Projects of the windows currently on screen (editors etc.), front-most first. */
  openWindowProjects(windows: DesktopWindow[]): string[] {
    const out: string[] = [];
    for (const w of windows) {
      if (isTerminal(w)) continue;
      const p = this.project(w);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  }

  isProject(path: string): boolean {
    if (MARKERS.some((m) => existsSync(join(path, m)))) return true;
    try { return readdirSync(path).some((k) => k.endsWith(".xcodeproj") || k.endsWith(".xcworkspace")); } catch { return false; }
  }

  gitRoot(path: string): string {
    let dir = path;
    // dirname of a root ("/", "C:\\", "\\\\server\\share\\") is the root itself.
    while (dir !== this.home && dir !== "." && dirname(dir) !== dir) {
      if (existsSync(join(dir, ".git"))) return dir;
      dir = dirname(dir);
    }
    return path;
  }

  /** ~/.config/JetBrains/<Product><version>/options/recentProjects.xml (newest versions first); %APPDATA%\JetBrains\… on Windows. */
  jetbrainsRecents(): string[] {
    const base = join(this.config, "JetBrains");
    let products: string[] = [];
    try { products = readdirSync(base).sort().reverse(); } catch {}
    const paths: string[] = [];
    for (const product of products) {
      let xml: string;
      try { xml = readFileSync(join(base, product, "options", "recentProjects.xml"), "utf8"); } catch { continue; }
      paths.push(...jetbrainsPaths(xml, this.home, this.platform));
    }
    return paths;
  }

  /** VS Code family: ~/.config/<Editor>/User/globalStorage/storage.json (and the Flatpak copies). */
  vscodeRecents(): string[] {
    const editors = ["Code", "Cursor", "Windsurf", "VSCodium", "Code - OSS"];
    const files = editors.map((e) => join(this.config, e, "User", "globalStorage", "storage.json"));
    if (this.platform !== "win32") {
      files.push(join(this.home, ".var/app/com.visualstudio.code/config/Code/User/globalStorage/storage.json"));
      files.push(join(this.home, ".var/app/com.vscodium.codium/config/VSCodium/User/globalStorage/storage.json"));
    }
    const paths: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      paths.push(...vscodePaths(text, this.platform));
    }
    return paths;
  }
}

/** Where the editors keep their settings: $XDG_CONFIG_HOME (~/.config), or %APPDATA% on Windows. */
export function defaultConfigDir(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === "win32") return env.APPDATA || win32.join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || join(home, ".config");
}

/** Title → candidate names: a bracketed path first, then the parts between –, —, |, and " - ". */
export function tokens(title: string): string[] {
  const out: string[] = [];
  const bracket = /\[([^\]]+)\]/.exec(title);
  if (bracket) out.push(bracket[1]);
  const cleaned = title.replace(/\[[^\]]*\]/g, "");
  for (const part of cleaned.split(/[–—|]/).flatMap((p) => p.split(" - "))) {
    const t = part.trim().replace(/^[●•*]+|[●•*]+$/g, "").trim();
    if (t) out.push(t);
  }
  return out;
}

async function dirs(dir: string): Promise<string[]> {
  try {
    const kids = await readdir(dir, { withFileTypes: true });
    return kids.filter((k) => !k.name.startsWith(".") && (k.isDirectory() || (k.isSymbolicLink() && isDir(join(dir, k.name))))).map((k) => join(dir, k.name));
  } catch {
    return [];
  }
}

function isDir(p: string) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
