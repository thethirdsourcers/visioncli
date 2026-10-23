// Distribution channels (docs/DISTRIBUTION.md): the Flatpak host-command helper, the Store's startup task, store-managed
// updates, and the packaging files for Flathub, the Snap Store, winget, Homebrew, SignPath and the site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostCommand, inFlatpak, runsInside } from "../../../src/flatpak";
import { Autostart, launchCommand, STARTUP_TASK_ID, startupTaskScript } from "../../src/main/features/autostart";
import type { RunResult } from "../../src/main/features/run";
import { installKind } from "../../src/main/features/updater";

const yaml = require("js-yaml") as { load(s: string): any };

function appDir() {
  for (let d = process.cwd(); d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, "electron-builder.yml"))) return d;
    if (existsSync(join(d, "app", "electron-builder.yml"))) return join(d, "app");
  }
  throw new Error("app/electron-builder.yml not found from " + process.cwd());
}
const APP = appDir();
const ROOT = dirname(APP);
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ── Flatpak: one helper decides what runs on the host ──────────────────────────────────────────────────────────

test("flatpak: detected by /.flatpak-info, on Linux only", () => {
  assert.equal(inFlatpak("linux", (p) => p === "/.flatpak-info"), true);
  assert.equal(inFlatpak("linux", () => false), false);
  assert.equal(inFlatpak("darwin", () => true), false);
  assert.equal(inFlatpak("win32", () => true), false);
});

test("flatpak: host tools go through flatpak-spawn --host; unchanged outside", () => {
  assert.deepEqual(hostCommand("xdotool", ["getmouselocation"], { flatpak: false }), { file: "xdotool", args: ["getmouselocation"] });
  assert.deepEqual(hostCommand("xdotool", ["getmouselocation"], { flatpak: true }),
    { file: "flatpak-spawn", args: ["--host", "xdotool", "getmouselocation"] });
  assert.deepEqual(hostCommand("/home/me/.local/bin/claude", ["-p", "hi"], { flatpak: true }).args,
    ["--host", "/home/me/.local/bin/claude", "-p", "hi"]);
});

test("flatpak: only the variables the app changed are passed to the host", () => {
  const base = { PATH: "/app/bin:/usr/bin", HOME: "/home/me", FLATPAK_ID: "com.thethirdsourcers.VisionCLI" };
  const env = { ...base, PATH: "/home/me/.local/bin:/usr/bin", VISIONCLI_FRONT_APP: "Code", UNSET: undefined };
  const h = hostCommand("claude", ["-p", "x"], { flatpak: true, env, base });
  assert.deepEqual(h.args, ["--host", "--env=PATH=/home/me/.local/bin:/usr/bin", "--env=VISIONCLI_FRONT_APP=Code", "claude", "-p", "x"]);
});

test("flatpak: helpers that live with the app stop with it (--watch-bus)", () => {
  assert.deepEqual(hostCommand("/home/me/.local/share/visioncli/whisper-server", ["-m", "m.bin"], { flatpak: true, watch: true }).args,
    ["--host", "--watch-bus", "/home/me/.local/share/visioncli/whisper-server", "-m", "m.bin"]);
});

test("flatpak: the app's own files and binary run inside", () => {
  const self = "/app/VisionCLI/visioncli.bin";
  assert.deepEqual(hostCommand(self, ["-e", "x"], { flatpak: true, self }), { file: self, args: ["-e", "x"] });
  assert.deepEqual(hostCommand("sh", ["/app/VisionCLI/resources/bin/setup-user.sh"], { flatpak: true }).file, "sh");
  // uv running the bundled kokoro_server.py: the script only exists in the sandbox
  assert.equal(hostCommand("/home/me/.local/bin/uv", ["run", "/app/VisionCLI/resources/assets/kokoro_server.py"], { flatpak: true }).file,
    "/home/me/.local/bin/uv");
  assert.equal(runsInside("flatpak-spawn", ["--host", "ls"]), true);
  assert.equal(runsInside("tmux", ["ls"], self), false);
});

test("flatpak: start at login runs `flatpak run <app id>` on the host", () => {
  assert.deepEqual(launchCommand(undefined, { FLATPAK_ID: "com.thethirdsourcers.VisionCLI" }, true), ["flatpak", "run", "com.thethirdsourcers.VisionCLI"]);
  assert.notDeepEqual(launchCommand(undefined, { FLATPAK_ID: "com.thethirdsourcers.VisionCLI" }, false)[0], "flatpak");
});

// ── Microsoft Store (MSIX): the startup task instead of the Run key ────────────────────────────────────────────

function storeRunner(initial: string) {
  let state = initial;
  const calls: string[][] = [];
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    const script = args[args.length - 1];
    if (state !== "DisabledByUser" && script.includes("RequestEnableAsync")) state = "Enabled";
    if (script.includes("$st.Disable()")) state = state === "DisabledByUser" ? state : "Disabled";
    return { code: 0, out: `${state}\r\n`, err: "" };
  };
  return { calls, runner };
}

test("store: Start at Login uses the package's StartupTask through PowerShell, never reg.exe", async () => {
  const { calls, runner } = storeRunner("Disabled");
  const a = new Autostart({ exec: ["C:\\Program Files\\WindowsApps\\x\\app\\VisionCLI.exe"], runner, platform: "win32", store: true });
  assert.equal(await a.isEnabled(), false);
  assert.equal(await a.set(true), "startupTask");
  assert.equal(await a.isEnabled(), true);
  assert.equal(await a.set(false), "off");
  assert.equal(await a.isEnabled(), false);
  assert.ok(calls.every((c) => c[0] === "powershell.exe"), "no reg.exe in the package");
  assert.ok(calls[0].includes("-NoProfile") && calls[0].includes("-NonInteractive"));
});

test("store: a task the user turned off in Settings is reported, not silently ignored", async () => {
  const { runner } = storeRunner("DisabledByUser");
  const a = new Autostart({ exec: ["VisionCLI.exe"], runner, platform: "win32", store: true });
  await assert.rejects(a.set(true), /Windows Settings/);
});

test("store: the script, the manifest extension and the task id agree", () => {
  for (const action of ["state", "enable", "disable"] as const) {
    const s = startupTaskScript(action);
    assert.ok(s.includes(`GetAsync('${STARTUP_TASK_ID}')`), action);
    assert.ok(s.endsWith("[string]$st.State"), action);
  }
  assert.ok(startupTaskScript("enable").includes("RequestEnableAsync"));
  assert.ok(startupTaskScript("disable").includes("$st.Disable()"));
  const ext = readFileSync(join(APP, "resources/win/appx-extensions.xml"), "utf8");
  assert.match(ext, new RegExp(`TaskId="${STARTUP_TASK_ID}" Enabled="false"`));
  assert.match(ext, /Executable="app\\VisionCLI\.exe"/);
  assert.match(ext, /<uap:Protocol Name="visioncli">/);
});

test("updates: the Store, Flathub and the Snap Store update their installs", () => {
  assert.equal(installKind({}, "C:\\Program Files\\WindowsApps\\x\\app\\VisionCLI.exe", "win32", true), "managed");
  assert.equal(installKind({}, "C:\\Users\\me\\AppData\\Local\\Programs\\VisionCLI\\VisionCLI.exe", "win32", false), "nsis");
  assert.equal(installKind({ FLATPAK_ID: "com.thethirdsourcers.VisionCLI" }, "/app/VisionCLI/visioncli.bin", "linux"), "managed");
  assert.equal(installKind({ SNAP: "/snap/visioncli/12" }, "/snap/visioncli/12/opt/VisionCLI/visioncli.bin", "linux"), "managed");
  // inherited from a snap terminal: still the .deb
  assert.equal(installKind({ SNAP: "/snap/code/200" }, "/opt/VisionCLI/visioncli.bin", "linux"), "deb");
});

// ── Packaging files ─────────────────────────────────────────────────────────────────────────────────────────────

test("electron-builder: rpm mirrors the .deb, appx is the Store package", () => {
  const cfg = yaml.load(readFileSync(join(APP, "electron-builder.yml"), "utf8"));
  assert.ok(cfg.linux.target.includes("rpm"));
  assert.equal(cfg.rpm.afterInstall, cfg.deb.afterInstall);
  for (const d of ["gtk3", "libnotify", "nss", "tmux", "(pipewire-utils or pulseaudio-utils)"]) assert.ok(cfg.rpm.depends.includes(d), d);
  assert.equal(cfg.appx.artifactName, "${productName}-${version}-windows-${arch}.msix");
  assert.equal(cfg.appx.addAutoLaunchExtension, false);
  assert.ok(existsSync(join(APP, cfg.appx.customExtensionsPath)));
  for (const f of ["StoreLogo", "Square44x44Logo", "Square150x150Logo", "Wide310x150Logo"]) assert.ok(existsSync(join(APP, "resources/appx", `${f}.png`)), f);
  // The identity comes from Partner Center at build time, never from the repo.
  assert.equal(cfg.appx.identityName, undefined);
  assert.equal(cfg.appx.publisher, undefined);
});

test("flatpak manifest: id, runtime, the permissions the app needs, the launcher", () => {
  const m = yaml.load(read("packaging/flatpak/com.thethirdsourcers.VisionCLI.yml"));
  assert.equal(m.id, "com.thethirdsourcers.VisionCLI");
  assert.equal(m.runtime, "org.freedesktop.Platform");
  assert.equal(m["runtime-version"], "26.08");
  assert.equal(m["base-version"], m["runtime-version"]);
  assert.equal(m.base, "org.electronjs.Electron2.BaseApp");
  for (const a of ["--socket=x11", "--socket=wayland", "--socket=pulseaudio", "--device=all", "--filesystem=home",
    "--talk-name=org.a11y.Bus", "--talk-name=org.kde.KWin", "--talk-name=dev.visioncli.Shell",
    "--talk-name=org.freedesktop.Flatpak"]) assert.ok(m["finish-args"].includes(a), a);
  // Flathub's linter rejects these outright: portals need no talk-name, and only names under the app id may be owned.
  for (const a of m["finish-args"]) assert.doesNotMatch(a, /^--talk-name=org\.freedesktop\.portal\.|^--own-name=/, a);
  const archives = m.modules[0].sources.filter((s: any) => s.type === "archive");
  assert.deepEqual(archives.map((s: any) => s["only-arches"][0]).sort(), ["aarch64", "x86_64"]);
  for (const s of archives) {
    assert.match(s.url, /releases\/download\/v[\d.]+\/VisionCLI-[\d.]+-linux-(x64|arm64)\.tar\.gz$/);
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(s.sha256, "0".repeat(64));
  }
  const launcher = read("packaging/flatpak/visioncli.sh");
  assert.match(launcher, /zypak-wrapper \/app\/VisionCLI\/visioncli\.bin/);
  assert.match(launcher, /XDG_CONFIG_HOME="\$HOME\/\.config"/);
  assert.match(launcher, /CHROME_DESKTOP=com\.thethirdsourcers\.VisionCLI\.desktop/);
});

test("flatpak metainfo: homepage, developer, contact, releases match the changelog", () => {
  const x = read("packaging/flatpak/com.thethirdsourcers.VisionCLI.metainfo.xml");
  assert.match(x, /<id>com\.thethirdsourcers\.VisionCLI<\/id>/);
  assert.match(x, /<url type="homepage">https:\/\/visioncli\.thethirdsourcers\.com<\/url>/);
  assert.match(x, /<developer id="com\.thethirdsourcers">\s*<name>Third Sourcers<\/name>/);
  assert.match(x, /visioncli@thethirdsourcers\.com/);
  assert.doesNotMatch(x, /<icon type="remote"/); // Flathub uses the installed icon; a remote one fails its linter
  assert.match(x, /<branding>[\s\S]*scheme_preference="light"[\s\S]*scheme_preference="dark"/);
  assert.match(x, /<content_rating type="oars-1\.1"/);
  // The screenshots are the site's (packaging/site/screenshots), so each one must exist there.
  for (const [, f] of x.matchAll(/<image>https:\/\/visioncli\.thethirdsourcers\.com\/screenshots\/([^<]+)<\/image>/g))
    assert.ok(existsSync(join(ROOT, "packaging/site/screenshots", f)), f);
  const version = JSON.parse(read("package.json")).version;
  assert.match(x, new RegExp(`<release version="${version.replace(/\./g, "\\.")}"`), "metainfo lists the current version");
});

test("tarball: package-release.sh ships the unpacked app under one folder, for the Flatpak and the snap", () => {
  const s = readFileSync(join(APP, "scripts/package-release.sh"), "utf8");
  assert.match(s, /electron-builder --linux AppImage deb rpm/);
  assert.match(s, /VisionCLI-\$VERSION-linux-\$ARCH\.tar\.gz/);
});

test("snap: core24, classic, both arches", () => {
  const s = yaml.load(read("packaging/snap/snapcraft.yaml"));
  assert.equal(s.name, "visioncli");
  assert.equal(s.base, "core24");
  assert.equal(s.confinement, "classic");
  assert.deepEqual(Object.keys(s.platforms).sort(), ["amd64", "arm64"]);
  assert.equal(s.website, "https://visioncli.thethirdsourcers.com");
});

test("winget: schema 1.6, per-user NSIS for x64 and arm64", () => {
  const dir = "packaging/winget/TheThirdSourcers.VisionCLI";
  const v = yaml.load(read(`${dir}.yaml`)), i = yaml.load(read(`${dir}.installer.yaml`)), l = yaml.load(read(`${dir}.locale.en-US.yaml`));
  for (const m of [v, i, l]) {
    assert.equal(m.PackageIdentifier, "TheThirdSourcers.VisionCLI");
    assert.equal(m.ManifestVersion, "1.6.0");
    assert.equal(m.PackageVersion, v.PackageVersion);
  }
  assert.equal(i.InstallerType, "nullsoft");
  assert.equal(i.Scope, "user");
  assert.deepEqual(i.Installers.map((x: any) => x.Architecture).sort(), ["arm64", "x64"]);
  for (const x of i.Installers) assert.match(x.InstallerUrl, new RegExp(`VisionCLI-${v.PackageVersion}-windows-${x.Architecture}\\.exe$`));
  assert.equal(l.Publisher, "Third Sourcers");
  assert.equal(l.PackageUrl, "https://visioncli.thethirdsourcers.com");
});

test("homebrew: the .dmg, the site, and a zap for the app's files and LaunchAgent", () => {
  const c = read("packaging/homebrew/visioncli.rb");
  assert.match(c, /^cask "visioncli" do/m);
  assert.match(c, /VisionCLI-#\{version\}-macos\.dmg/);
  assert.match(c, /homepage "https:\/\/visioncli\.thethirdsourcers\.com"/);
  assert.match(c, /^  sha256 /m); // the line the release workflow rewrites
  assert.ok(c.includes('"~/Library/Application Support/visioncli"'));
  assert.ok(c.includes('"~/Library/LaunchAgents/dev.visioncli.overlay.plist"'));
});

test("signpath: the app configuration signs both of our exes", () => {
  const x = read("packaging/windows/artifact-configuration.xml");
  assert.match(x, /<pe-file path="VisionCLI\.exe">/);
  assert.match(x, /<pe-file path="resources\/bin\/vcli-win\.exe">/);
  assert.match(read("packaging/windows/artifact-configuration-installer.xml"), /windows-\*\.exe/);
});

test("site: the page template has the release placeholders and the repository block", () => {
  const html = read("packaging/site/index.html");
  for (const p of ["@VERSION@", "@TAG@", "@DL@"]) assert.ok(html.includes(p), p);
  assert.ok(html.includes("<!-- repos -->") && html.includes("<!-- /repos -->"));
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(read("packaging/site/build.sh"), /visioncli\.thethirdsourcers\.com/);
});
