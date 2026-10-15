# VisionCLI on Linux

Status of the Linux port and what's left. VisionCLI has two halves:

- **The MCP server** (`src/`, Node). It's what Claude Code / Gemini call: `look`, `list_windows`, `select_region`, `browser_*`, `db_*`.
- **The overlay app** (`overlay/Sources`, about 14k lines of Swift/AppKit). It provides voice, the bubble, Visi, computer control, settings and updates. None of it runs on Linux.

## Phase 1: MCP server on Linux

Done:

| Feature | X11 | Wayland | Tools used |
|---|---|---|---|
| `look` (window under the mouse) | ✅ | falls back to the whole screen | `wmctrl`, `xprop`, `xdotool`, `maim` or ImageMagick |
| `look` target screen | ✅ | ✅ | `maim` / `grim` / `gnome-screenshot` / `spectacle` / ImageMagick / `scrot` |
| `list_windows` | ✅ | ❌ (compositors don't allow it) | `wmctrl -lpGx` + `_NET_CLIENT_LIST_STACKING` |
| `select_region` | ✅ | ✅ | `maim -s` / `slurp` + `grim` / `gnome-screenshot -a` / `spectacle -r` |
| `clipboard_image` | ✅ | ✅ | `xclip` / `wl-paste` |
| Downscale + JPEG | ✅ | ✅ | ImageMagick if installed, otherwise PNG as is |
| `device_screenshot` android | ✅ | ✅ | `adb` |
| `db_schema` / `db_query` | ✅ | ✅ | |
| Config dir | `~/.config/visioncli` | | |

The code is in `src/linux.ts`, with unit tests in `tests/linux.test.ts`. CI runs the suite on ubuntu, plus a real capture test under Xvfb + openbox.

One-line install for an Ubuntu/Debian X11 desktop:

```sh
sudo apt install wmctrl x11-utils xdotool maim imagemagick xclip
```

For Wayland (wlroots: Sway, Hyprland): `sudo apt install grim slurp wl-clipboard`.

- **Browser tools** (`browser_*`, quick commands, multi-step tasks): on Linux every `browser.ts` call goes over DevTools through browserd (`src/browser-cdp.ts`), so Chrome's "Allow remote debugging?" is answered once. It supports Chrome, Brave and Chromium, including native, Flatpak and Snap installs. Verified against real Chromium: tabs, open, type, pick a suggestion, select, tick, click, read, new and close tab.

When the Linux app is running, the MCP server asks it for windows and captures, so `look` works on Wayland too: GNOME uses the extension, KDE a KWin script, Sway `swaymsg` and Hyprland `hyprctl`.

## Phase 2: the Linux app (full parity with the macOS app) — done in 0.9.0

**Goal: every macOS feature behaves the same on any Linux distribution, on X11 and Wayland.**

The app will be built with **Electron**:
- It ships its own Chromium, so the bubble, Mermaid, settings and history render identically on every distribution. WebKitGTK, which Tauri would use, differs from distro to distro.
- Its main process is Node, so it reuses `src/` (capture, control protocol, quick commands, routing, browserd) directly.

Each macOS piece maps to Linux as follows.

| macOS feature (overlay/Sources) | Linux implementation |
|---|---|
| Menu-bar item and menu (`App+Menu`) | Electron `Tray` (StatusNotifierItem; GNOME needs the AppIndicator extension, which Ubuntu ships) |
| Hold ⌥ / ⌥⌘ push-to-talk, tap mode, chord cancel (`Hotkeys`) | Reads key down/up from `/dev/input` (evdev). Works on X11 and every Wayland compositor; the user joins the `input` group once in setup. The X11-only fallback is XInput2 raw events |
| Esc / ⌥P / ⌥O / ⌥↩ while the overlay is up | The same evdev listener (Esc is grabbed only while the overlay is up) |
| Live captions + Apple speech | whisper.cpp streaming (`whisper-server`, already supported); captions from partial decodes |
| Parakeet | parakeet-tdt ONNX via sherpa-onnx (same model, CPU or GPU) |
| Whisper / Kokoro / vocabulary | Same as macOS: whisper-server, `uv` + `kokoro_server.py` |
| System voice (AVSpeechSynthesizer) | `speech-dispatcher` (`spd-say`) / `espeak-ng`; Kokoro is the default |
| Microphone and speaker pickers | PipeWire/PulseAudio device list (`pactl`), recording with `pw-record` / `parec` |
| Wispr Flow | Not available on Linux (no Linux Flow app); the option is hidden |
| Bubble, pills, approval card, toasts (SwiftUI `NSPanel`) | Transparent, frameless, always-on-top, click-through `BrowserWindow`s with the same layout |
| Visi mascot | The same PNG frames in a click-through window |
| Annotations, spotlight, region selector, activity badge | A full-screen transparent overlay window per display |
| Mermaid | The same `mermaid.min.js` in the bubble |
| Window list / capture / pointer (`Screen`, ScreenCaptureKit) | `src/linux.ts` on X11. On Wayland, the window list and pointer come from the compositor (GNOME extension, KWin script, `swaymsg`, `hyprctl`) and capture comes from the ScreenCast portal (PipeWire) with one-time consent |
| Terminal mode: typing into the running `claude` / `agy` / `gemini` (`Terminal`, `TerminalProbe`) | `/proc` replaces `ps`/`lsof` to find CLIs. Delivery: tmux / kitty / WezTerm remote control when available, otherwise a terminal VisionCLI opens itself with `claude` under a PTY it owns. Answers come from the same transcript files |
| Bubble mode (`ClaudeSession`, `AgySession`, `GeminiSession`) | Unchanged logic (stdio stream-json); ported to TypeScript |
| Computer control: click / type / key / scroll / drag (`Control`, CGEvent) | X11: XTest. Wayland: the RemoteDesktop portal (GNOME/KDE) or `/dev/uinput` |
| UI elements / AXPress / set value (AXUIElement) | AT-SPI2 over D-Bus (GTK, Qt, Chromium, Electron, LibreOffice): same roles, labels and actions |
| Sensitive targets always ask | AT-SPI `password text` role + a list of password managers / settings apps |
| Open app / URL / focus app | `.desktop` files + `gtk-launch` / `xdg-open`; focus via the window backend |
| Task panel, announcements | Same features in Electron windows |
| Meeting Notes (`MeetingNotes`, `MeetingPanel`, `MeetingLauncher`; ScreenCaptureKit audio + AVAudioEngine) | The default output's monitor (`parecord … --device=<sink>.monitor`, or PipeWire's `stream.capture.sink`) and the microphone (`pw-record` / `parecord` / `arecord`), segmented and transcribed the same way; the panel and the Shift+Alt+Super+R card are Electron windows (the shortcut needs X11 or a desktop that lets Electron register global shortcuts). Recordings are AAC through `ffmpeg` when it's installed, else WAV |
| Crash detection (DiagnosticReports) | `coredumpctl` / systemd-coredump journal, plus `/var/crash` (Apport) |
| Own crash reporter and relaunch-loop guard | Electron `crashReporter` + the same marker files; systemd `Restart=on-failure` with `StartLimitBurst` |
| History, usage, projects, settings (all tabs), setup wizard | Same screens. JetBrains/VS Code recents are read from `~/.config`. The setup wizard checks the `input` group, portals and PipeWire |
| Opening `file:line` | JetBrains launcher / `code --goto` / `xdg-open` |
| Start at login (LaunchAgent) | systemd user unit (+ XDG autostart fallback) |
| Updater (codesign + swap) | AppImage zsync / GitHub release check with a signature check (minisign) |
| Model installer (brew) | Prebuilt whisper-server binary download (no Homebrew), same model downloads |

The code is in `app/src/main/` (one folder per row above) and `app/src/renderer/`, with `app/src/main/app/` as the port of `AppDelegate` + `App+*.swift`. Tests: `cd linux && npm test`.

Known differences:
- **Wispr Flow:** there is no Linux Wispr Flow app.
- **Sway:** Sway's IPC never reports the pointer, so "window under the mouse" uses the focused window there.
- **Updater:** it needs a signing key (`UPDATE_PUBLIC_KEY` in `app/src/main/features/updater.ts`). Until it's set, updates are announced and the release page opens instead of installing in place.
- **Not yet tested on real hardware:** GNOME and KDE on Wayland were tested against stand-ins of their D-Bus services. X11 and Sway were tested for real.

## Phase 3: packaging — done in 0.9.0

AppImage and `.deb` (x86_64, arm64) are built by GitHub Actions on `v*` tags, next to the macOS `.dmg`. Config: `app/electron-builder.yml`; dependency installer: `app/scripts/install-deps.sh`.
