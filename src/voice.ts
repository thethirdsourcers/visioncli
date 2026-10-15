import { execFile, spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIG_DIR } from "./config.js";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT_APP = join(root, "overlay", "build", "VisionCLI.app");
const INSTALLED_APP = "/Applications/VisionCLI.app"; // the build script installs here
const appPath = () => (existsSync(join(INSTALLED_APP, "Contents", "MacOS", "VisionCLI")) ? INSTALLED_APP : BUILT_APP);
const LABEL = "dev.visioncli.overlay";
const AGENT = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const SUPPORT = CONFIG_DIR;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** launchd agent: restarts VisionCLI after a crash (not after a normal quit); RunAtLoad = start at login.
 *  Written only when its contents change (returns true then): macOS shows "App Background Activity" every time it
 *  sees a background item added or modified. */
function writeAgent(exe: string): boolean {
  let old = "";
  try { old = readFileSync(AGENT, "utf8"); } catch {}
  const runAtLoad = /<key>RunAtLoad<\/key>\s*<true\/>/.test(old);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(exe)}</string></array>
  <key>RunAtLoad</key><${runAtLoad}/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardErrorPath</key><string>${xml(join(homedir(), "Library", "Logs", "visioncli-stderr.log"))}</string>
</dict>
</plist>
`;
  if (plist === old) return false;
  writeFileSync(AGENT, plist);
  return true;
}

async function which(cmd: string) {
  if (process.platform === "linux") return findOnPath(cmd); // not every distro ships /usr/bin/which
  if (process.platform === "win32") return findOnPathWin(cmd);
  try {
    return (await run("/usr/bin/which", [cmd])).stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Build (if needed) and launch the voice overlay for a project. Replaces any running instance. */
export async function startVoice(cwd: string): Promise<string> {
  if (process.platform === "linux") return startVoiceLinux(cwd);
  if (process.platform === "win32") return startVoiceWin(cwd);
  if (process.platform !== "darwin") throw new Error("Voice mode is only supported on macOS, Linux and Windows.");

  if (!existsSync(join(appPath(), "Contents", "MacOS", "VisionCLI"))) {
    await run(join(root, "scripts", "build-overlay.sh"), { cwd: root });
  }
  const APP = appPath();

  const claude = process.env.VISIONCLI_CLAUDE ?? (await which("claude"));
  if (!claude) throw new Error("Couldn't find the `claude` CLI on PATH. Set VISIONCLI_CLAUDE to its full path.");

  // The overlay runs `claude` with only this server attached (node + script below), so it starts fast and
  // doesn't depend on how visioncli was installed. `--cwd` is the fallback project when it can't tell
  // the project from the window under the pointer.
  // Settings the app reads at launch (it's started by launchd without arguments).
  const config: Record<string, string> = {
    cwd: resolve(cwd),
    claude,
    path: process.env.PATH ?? "",
    node: process.execPath,
    server: join(root, "dist", "index.js"),
  };
  if (process.env.VISIONCLI_MODEL) config.model = process.env.VISIONCLI_MODEL;
  if (process.env.VISIONCLI_LOCALE) config.locale = process.env.VISIONCLI_LOCALE;
  mkdirSync(SUPPORT, { recursive: true });
  writeFileSync(join(SUPPORT, "overlay.json"), JSON.stringify(config));

  // The app runs under launchd without your shell's environment: keep the TypeSafe key (for Jev quick
  // commands) in integrations.json, readable only by you.
  // (Gemini uses your normal `gemini` sign-in; a Gemini API key is only used if you add one to integrations.json yourself.)
  const keys: Record<string, string | undefined> = { typesafe: process.env.TYPESAFE_API_KEY };
  if (Object.values(keys).some(Boolean)) {
    const file = join(SUPPORT, "integrations.json");
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch {}
    let changed = false;
    for (const [name, key] of Object.entries(keys)) {
      if (key && !cfg[name]?.apiKey) { cfg[name] = { ...(cfg[name] ?? {}), apiKey: key }; changed = true; }
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
      chmodSync(file, 0o600);
    }
  }

  // Stop any running instance (launchd-managed or not), then start it under launchd so a crash gets
  // an automatic restart. Launched this way the app is still its own process for macOS permissions.
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const changed = writeAgent(join(APP, "Contents", "MacOS", "VisionCLI"));
  const loaded = await run("/bin/launchctl", ["print", `${domain}/${LABEL}`]).then(() => true, () => false);
  if (changed || !loaded) {
    // A new or changed agent has to be (re)registered: macOS notes it as background activity, once.
    await run("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => {});
    await run("/usr/bin/pkill", ["-x", "VisionCLI"]).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    await run("/bin/launchctl", ["bootstrap", domain, AGENT]).catch(() => {});
  }
  // Same agent already registered: just restart the app inside it (no new background item, no alert).
  await run("/bin/launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);

  return (
    `Voice mode is on (pick the project from the menu bar icon → Project; the first time it is ${resolve(cwd)}). Hold Option, ask your question, then let go (Option+Command to include a screenshot). ` +
    `The answer appears above your mouse pointer (Esc dismisses it). The eye icon in the menu bar has Quit. ` +
    `The first time, macOS asks for Microphone and Speech Recognition access. VisionCLI also needs ` +
    `Screen Recording permission (System Settings → Privacy & Security).`
  );
}

/** Register visioncli as a user-scope MCP server in Claude Code and Antigravity CLI (and build the voice overlay on macOS). */
export async function install(): Promise<string> {
  const claude = process.env.VISIONCLI_CLAUDE ?? (await which("claude"));
  if (!claude) throw new Error("Couldn't find the `claude` CLI on PATH.");
  const script = join(root, "dist", "index.js");
  // Installed via `npx visioncli install`: the npx cache path is temporary, so register through npx instead.
  const server = /[\\/]_npx[\\/]/.test(script) ? ["npx", "-y", "visioncli@latest"] : [process.execPath, script];
  // Linux app (`visioncli-mcp install`): this is the app's Electron running as Node, from an AppImage mount that
  // changes every run, so register the stable wrapper instead.
  if (process.platform === "linux" && process.versions.electron) server.splice(0, server.length, MCP_WRAPPER);
  if (process.platform === "win32") server.splice(0, server.length, ...winServerCommand(server, !!process.versions.electron));
  await runTool(claude, ["mcp", "remove", "visioncli", "-s", "user"]).catch(() => {});
  await runTool(claude, ["mcp", "add", "visioncli", "--scope", "user", "--", ...server]);
  const lines = [`Registered the visioncli MCP server with Claude Code for all projects (${server.join(" ")}).`];
  // Antigravity CLI (agy, Gemini on a Google account), if installed: global MCP config + allow rules for headless runs.
  if (await which("agy") || existsSync(join(homedir(), ".local", "bin", "agy"))) {
    const mcpFile = join(homedir(), ".gemini", "config", "mcp_config.json");
    const settingsFile = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
    const read = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };
    const mcp = read(mcpFile);
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), visioncli: { command: server[0], args: server.slice(1) } };
    mkdirSync(dirname(mcpFile), { recursive: true });
    writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + "\n");
    const settings = read(settingsFile);
    const allow: string[] = settings.permissions?.allow ?? [];
    for (const t of ["look", "list_windows", "select_region", "clipboard_image", "device_screenshot", "db_schema", "db_query",
      "browser_tabs", "browser_read", "browser_elements", "browser_open", "browser_switch_tab", "browser_navigate", "browser_scroll",
      "ui_elements", "click", "type_text", "press_keys", "scroll", "drag", "open_app", "open_url"]) {
      if (!allow.includes(`mcp(visioncli/${t})`)) allow.push(`mcp(visioncli/${t})`);
    }
    // Read-only commands Gemini may run without asking (headless agy can't prompt).
    for (const c of ["grep", "rg", "ls", "cat", "head", "tail", "find", "wc", "pwd", "file", "stat", "tree",
      "git status", "git log", "git diff", "git show", "git branch", "git blame"]) {
      if (!allow.includes(`command(${c})`)) allow.push(`command(${c})`);
    }
    settings.permissions = { ...(settings.permissions ?? {}), allow };
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    lines.push("Registered it with Antigravity CLI (agy) as well.");
  }
  if (process.platform === "darwin") {
    if (!existsSync(join(appPath(), "Contents", "MacOS", "VisionCLI"))) await run(join(root, "scripts", "build-overlay.sh"), { cwd: root });
    lines.push("Voice overlay built. Start it with: visioncli voice  (or ask Claude to \"start voice mode\").");
    lines.push("Grant Screen Recording to your terminal (and to VisionCLI for voice mode) in System Settings → Privacy & Security.");
  }
  if (process.platform === "linux") {
    lines.push(linuxApp()
      ? "Start the voice overlay with: visioncli voice  (or ask Claude to \"start voice mode\")."
      : `For voice mode, install the VisionCLI app (AppImage or .deb) from ${RELEASES}.`);
    lines.push("Desktop tools for your session (X11, GNOME, KDE, Sway, Hyprland): sh app/scripts/install-deps.sh (shipped in the app as resources/bin/install-deps.sh).");
  }
  if (process.platform === "win32") {
    lines.push(windowsApp()
      ? "Start the voice overlay with: visioncli voice  (or ask Claude to \"start voice mode\")."
      : `For voice mode, install the VisionCLI app (the Windows installer) from ${RELEASES}.`);
  }
  lines.push("Restart Claude Code to load it.");
  return lines.join("\n");
}

// ---- Linux ------------------------------------------------------------------------------------------------------
// The app is an AppImage (linked at ~/.local/bin/VisionCLI.AppImage by its first run), the .deb in /opt/VisionCLI,
// or a dev build of app/ run by its own electron. Crash restart comes from a systemd user unit when the app
// installed one (setup-user.sh), the counterpart of the launchd agent above.

const RELEASES = "https://github.com/thethirdsourcers/visioncli/releases";
const LINUX_DEV = join(root, "app");
const MCP_WRAPPER = join(homedir(), ".local", "bin", "visioncli-mcp");
const UNIT = "visioncli.service";
const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

function findOnPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && isExecutable(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

function isExecutable(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The Linux app to launch: an installed one first, else the dev build. Null when there's none. */
export function linuxApp(): { exe: string; args: string[] } | null {
  for (const c of [process.env.VISIONCLI_APP, join(homedir(), ".local", "bin", "VisionCLI.AppImage"), "/opt/VisionCLI/visioncli"]) {
    if (c && isExecutable(c)) return { exe: c, args: [] };
  }
  const electron = join(LINUX_DEV, "node_modules", ".bin", "electron");
  if (existsSync(join(LINUX_DEV, "build", "main.js")) && isExecutable(electron)) return { exe: electron, args: [LINUX_DEV] };
  return null;
}

/** Main processes of running VisionCLI apps, not their helpers and not MCP servers (the same binary in Node mode). */
function linuxAppPids(): number[] {
  const skip = new Set([process.pid, process.ppid]);
  const pids: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || skip.has(Number(d))) continue;
    try {
      const comm = readFileSync(`/proc/${d}/comm`, "utf8").trim();
      const argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0");
      const app = comm === "visioncli.bin" || (comm === "electron" && argv.includes(LINUX_DEV));
      if (!app || argv.some((a) => a.startsWith("--type="))) continue;
      if (readFileSync(`/proc/${d}/environ`, "utf8").split("\0").includes("ELECTRON_RUN_AS_NODE=1")) continue;
      pids.push(Number(d));
    } catch {}
  }
  return pids;
}

async function stopLinuxApp() {
  const pids = linuxAppPids();
  for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 30 && pids.some((p) => existsSync(`/proc/${p}`)); i++) await new Promise((r) => setTimeout(r, 100));
}

async function startVoiceLinux(cwd: string): Promise<string> {
  let app = linuxApp();
  if (!app && existsSync(join(LINUX_DEV, "build.mjs")) && existsSync(join(LINUX_DEV, "node_modules"))) {
    await run(process.execPath, ["build.mjs"], { cwd: LINUX_DEV });
    app = linuxApp();
  }
  if (!app) throw new Error(`VisionCLI for Linux isn't installed. Get the AppImage or .deb from ${RELEASES}.`);

  const claude = process.env.VISIONCLI_CLAUDE ?? (await which("claude"));
  if (!claude) throw new Error("Couldn't find the `claude` CLI on PATH. Set VISIONCLI_CLAUDE to its full path.");

  // Same settings as on macOS. Inside the app (visioncli-mcp) this process is Electron in Node mode, from an
  // AppImage mount that goes away: the app runs the server through the stable wrapper then (no "server" key).
  const config: Record<string, string> = {
    cwd: resolve(cwd),
    claude,
    path: process.env.PATH ?? "",
    node: process.versions.electron ? MCP_WRAPPER : process.execPath,
  };
  if (!process.versions.electron) config.server = process.argv[1] ? resolve(process.argv[1]) : join(root, "dist", "index.js");
  if (process.env.VISIONCLI_MODEL) config.model = process.env.VISIONCLI_MODEL;
  if (process.env.VISIONCLI_LOCALE) config.locale = process.env.VISIONCLI_LOCALE;
  mkdirSync(SUPPORT, { recursive: true });
  writeFileSync(join(SUPPORT, "overlay.json"), JSON.stringify(config));

  const keys: Record<string, string | undefined> = { typesafe: process.env.TYPESAFE_API_KEY };
  if (Object.values(keys).some(Boolean)) {
    const file = join(SUPPORT, "integrations.json");
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch {}
    let changed = false;
    for (const [name, key] of Object.entries(keys)) {
      if (key && !cfg[name]?.apiKey) { cfg[name] = { ...(cfg[name] ?? {}), apiKey: key }; changed = true; }
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
      chmodSync(file, 0o600);
    }
  }

  // Replace any running instance so it rereads overlay.json. Under systemd it gets crash restarts, but the user
  // manager may not know this session's display (sway/Hyprland don't always export it): hand that over first.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set when this is visioncli-mcp; the app must start as an app
  const systemd = existsSync(join(xdgConfig(), "systemd", "user", UNIT)) &&
    (await run("systemctl", ["--user", "show-environment"]).then(() => true, () => false));
  await stopLinuxApp();
  if (systemd) {
    const vars = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_SESSION_DESKTOP",
      "HYPRLAND_INSTANCE_SIGNATURE", "SWAYSOCK", "DBUS_SESSION_BUS_ADDRESS"].filter((v) => process.env[v]);
    if (vars.length) await run("systemctl", ["--user", "import-environment", ...vars], { env }).catch(() => {});
    await run("systemctl", ["--user", "restart", UNIT], { env });
  } else {
    spawn(app.exe, app.args, { detached: true, stdio: "ignore", env, cwd: homedir() }).unref();
  }

  return (
    `Voice mode is on (pick the project from the tray icon → Project; the first time it is ${resolve(cwd)}). Hold Alt, ask your question, then let go (Alt+Super to include a screenshot). ` +
    `The answer appears above your mouse pointer (Esc dismisses it). The VisionCLI icon in the tray has Quit. ` +
    `On Wayland, push-to-talk and computer control need you in the "input" group once: sh app/scripts/install-deps.sh sets that up.`
  );
}

// ---- Windows ----------------------------------------------------------------------------------------------------
// The app is the NSIS per-user install (%LOCALAPPDATA%\Programs\VisionCLI\VisionCLI.exe, no admin) or a dev build of
// app/ run by its own electron.exe. The app writes %LOCALAPPDATA%\visioncli\bin\visioncli-mcp.cmd on start: the
// stable path Claude Code runs the server through (the app's exe in Node mode, like Linux's visioncli-mcp).

export function windowsPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
  return {
    installed: join(local, "Programs", "VisionCLI", "VisionCLI.exe"),
    mcpWrapper: join(local, "visioncli", "bin", "visioncli-mcp.cmd"),
  };
}

/** What `claude mcp add` runs on Windows: a .cmd (and npx is one) can only start through cmd /c. */
export function winServerCommand(server: string[], inApp: boolean, wrapper = windowsPaths().mcpWrapper): string[] {
  if (inApp) return ["cmd", "/c", wrapper];
  return server[0] === "npx" ? ["cmd", "/c", ...server] : server;
}

/** `cmd` on PATH with Windows' executable extensions (claude.exe from the native installer, claude.cmd from npm). */
export function findOnPathWin(cmd: string, env: NodeJS.ProcessEnv = process.env, exists: (f: string) => boolean = existsSync): string | null {
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (!dir) continue;
    for (const ext of ["", ...exts]) {
      const f = join(dir.replace(/^"|"$/g, ""), cmd + ext.toLowerCase());
      if ((ext || /\.\w+$/.test(cmd)) && exists(f)) return f;
    }
  }
  return null;
}

/** A command line for cmd.exe: quote what has spaces or cmd's special characters. */
export function cmdLine(args: string[]): string {
  return args.map((a) => (a === "" || /[\s&|<>^()"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ");
}

/** execFile, except that .cmd/.bat (npm's claude.cmd) need cmd.exe on Windows (Node refuses to spawn them directly). */
function runTool(file: string, args: string[]) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    return run("cmd.exe", ["/d", "/s", "/c", `"${cmdLine([file, ...args])}"`], { windowsVerbatimArguments: true, windowsHide: true });
  }
  return run(file, args, { windowsHide: true });
}

/** The Windows app to launch: VISIONCLI_APP, the installed one, else the dev build. Null when there's none. */
export function windowsApp(env: NodeJS.ProcessEnv = process.env, exists: (f: string) => boolean = existsSync): { exe: string; args: string[] } | null {
  for (const c of [env.VISIONCLI_APP, windowsPaths(env).installed]) {
    if (c && exists(c)) return { exe: c, args: [] };
  }
  const electron = join(LINUX_DEV, "node_modules", "electron", "dist", "electron.exe");
  if (exists(join(LINUX_DEV, "build", "main.js")) && exists(electron)) return { exe: electron, args: [LINUX_DEV] };
  return null;
}

export interface WinProc { pid: number; name: string; cmd?: string | null }

/** Main processes of running VisionCLI apps: not Chromium helpers (--type=), not MCP servers or browserd (Node mode). */
export function windowsAppPids(procs: WinProc[], skip: Set<number>, devDir = LINUX_DEV): number[] {
  const dev = devDir.toLowerCase();
  return procs
    .filter((p) => {
      const cmd = (p.cmd ?? "").toLowerCase();
      if (skip.has(p.pid) || cmd.includes("--type=")) return false;
      if (/visioncli-mcp|[\\/]server[\\/]index\.m?js/.test(cmd)) return false;
      return p.name.toLowerCase() === "visioncli.exe" || (p.name.toLowerCase() === "electron.exe" && cmd.includes(dev));
    })
    .map((p) => p.pid);
}

async function stopWindowsApp() {
  const { powershell } = await import("./win32.js");
  let procs: WinProc[] = [];
  try {
    const out = await powershell(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name='VisionCLI.exe' OR Name='electron.exe'" |
  ForEach-Object { @{ pid = [int]$_.ProcessId; name = $_.Name; cmd = $_.CommandLine } })`, 15_000, false);
    procs = out ? [JSON.parse(out)].flat() : [];
  } catch {}
  const pids = windowsAppPids(procs, new Set([process.pid, process.ppid]));
  // /t: the app's renderers and its helper go with it. Windows has no SIGTERM for a windowless app; the app saves
  // its settings as they change, so a forced stop loses nothing.
  for (const pid of pids) await run("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }).catch(() => {});
  if (pids.length) await new Promise((r) => setTimeout(r, 500));
}

async function startVoiceWin(cwd: string): Promise<string> {
  let app = windowsApp();
  if (!app && existsSync(join(LINUX_DEV, "build.mjs")) && existsSync(join(LINUX_DEV, "node_modules"))) {
    await run(process.execPath, ["build.mjs"], { cwd: LINUX_DEV, windowsHide: true });
    app = windowsApp();
  }
  if (!app) throw new Error(`VisionCLI for Windows isn't installed. Get the installer from ${RELEASES}.`);

  const claude = process.env.VISIONCLI_CLAUDE ?? (await which("claude"));
  if (!claude) throw new Error("Couldn't find the `claude` CLI on PATH. Set VISIONCLI_CLAUDE to its full path.");

  // Same settings as on Linux: inside the app this process is its exe in Node mode, so the app runs the server
  // through the stable wrapper (no "server" key).
  const config: Record<string, string> = {
    cwd: resolve(cwd),
    claude,
    path: process.env.PATH ?? process.env.Path ?? "",
    node: process.versions.electron ? windowsPaths().mcpWrapper : process.execPath,
  };
  if (!process.versions.electron) config.server = process.argv[1] ? resolve(process.argv[1]) : join(root, "dist", "index.js");
  if (process.env.VISIONCLI_MODEL) config.model = process.env.VISIONCLI_MODEL;
  if (process.env.VISIONCLI_LOCALE) config.locale = process.env.VISIONCLI_LOCALE;
  mkdirSync(SUPPORT, { recursive: true });
  writeFileSync(join(SUPPORT, "overlay.json"), JSON.stringify(config));

  // The TypeSafe key for Jev quick commands, as on macOS/Linux (%APPDATA% is already private to the user).
  const key = process.env.TYPESAFE_API_KEY;
  if (key) {
    const file = join(SUPPORT, "integrations.json");
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch {}
    if (!cfg.typesafe?.apiKey) {
      cfg.typesafe = { ...(cfg.typesafe ?? {}), apiKey: key };
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    }
  }

  // Replace any running instance so it rereads overlay.json. No crash-restart service on Windows (that would need
  // a scheduled task or admin rights); the app is started detached from this process.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set when this is visioncli-mcp; the app must start as an app
  await stopWindowsApp();
  spawn(app.exe, app.args, { detached: true, stdio: "ignore", env, cwd: homedir(), windowsHide: false }).unref();

  return (
    `Voice mode is on (pick the project from the tray icon → Project; the first time it is ${resolve(cwd)}). Hold Alt, ask your question, then let go. ` +
    `The answer appears above your mouse pointer (Esc dismisses it). The VisionCLI icon in the notification area has Quit.`
  );
}
