<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-dark.png">
    <img src="docs/brand/wordmark-light.png" width="360" alt="VisionCLI">
  </picture>
</p>

<p align="center">
<b>An AI co-assistant for developers that sees your screen and uses your computer.</b><br>
Ask about the file, error, UI, database table or web page in front of you, or have it do the task for you:
by typing or <b>by voice</b>, with the AI you already use: <b>Claude Code</b> or <b>Gemini</b> (Antigravity).
</p>

<p align="center">
<a href="https://visioncli.thethirdsourcers.com"><b>visioncli.thethirdsourcers.com</b></a> · <a href="https://github.com/thethirdsourcers/visioncli/releases/latest"><b>Download for macOS, Windows or Linux</b></a>
</p>

---

- **"What is this file for?"** Your assistant looks at the window under your mouse, finds the real file in your project and answers with `file:line` references.
- **Hold ⌥ and ask out loud** (⌥⌘ to include a screenshot). Visi, a little robot, peeks in from the edge of the screen while it listens and thinks; the answer appears in the top-right corner and is read aloud.
- **Claude or Gemini, your choice.** Uses your own `claude` or `agy` sign-in (no API keys) and the session already running for that project, so you can type and talk in the same conversation. Pick the model and effort in VisionCLI menu → Settings… → Assistant.
- **Uses your computer.** "Open Xcode and run the app", "fill this form", "switch the dropdown to Production": it clicks, types, presses shortcuts and opens apps, one checked step at a time, reading each app's real buttons and fields through Accessibility. You approve each action (or allow all), passwords and System Settings always ask, a task panel shows every step with Pause/Stop, and **Esc stops it instantly**.
- **Meeting Notes (optional).** In a meeting, it transcribes your colleagues (your computer's sound) and you (the microphone) on your computer and shows the conversation in a side panel. Each colleague's turn gets a one-line summary. When you're asked something, three short replies appear once they've finished talking. Questions about the code are answered from your project. Each meeting is saved with its notes, a summary at the end and a recording you can play back. Nothing is sent for you.
- **Notices crashes.** When your app (Mac or Simulator) crashes, VisionCLI offers to explain it, and the next question already knows which crash report to read.
- **Points and draws.** Answers point at things on your real screen (boxes, circles, arrows, numbered steps) and can include **Mermaid diagrams** rendered in the bubble.
- **Fast browser control.** "Open the Stripe tab", "click sign in", "pause the video" run in under a second (via TypeSafe Jev), with a visible AI cursor. Forms, dropdowns, toggles and framed portals work through the page itself, without opening stray tabs.
- **Multi-step browser tasks.** "Find a stay in Lisbon with a pool and free cancellation and open it": a Jev agent works through the page in front one step at a time (type, click, pick, scroll), about 0.3–0.5 s per step, with each step shown in the bubble. Needs Chrome's *Allow remote debugging* (chrome://inspect/#remote-debugging) and a click on Allow when it first connects.
- **Knows your data.** Read-only database questions ("how are payments and orders related?") using your project's `.env`.

## Install

### Requirements

- macOS 13 or later (Apple Silicon or Intel), Linux (x86_64 or arm64; X11 or Wayland: see [Linux](#linux)), or Windows 10/11 (x64 or Arm, preview: see [Windows](#windows))
- At least one AI CLI, installed and signed in: [Claude Code](https://claude.com/claude-code) (`claude`), [Antigravity CLI](https://antigravity.google) (`agy`, Gemini on a Google account), or [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)
- [Node.js](https://nodejs.org) 18 or later

### 1. Download the app

1. Download **`VisionCLI-<version>-macos.dmg`** from the [latest release](https://github.com/thethirdsourcers/visioncli/releases/latest).
2. Open it and drag **VisionCLI** into **Applications**.
3. The app isn't notarized by Apple yet, so the first time:
   - **Right-click VisionCLI → Open → Open** (on macOS 15 and later: System Settings → Privacy & Security → **Open Anyway**), or
   - run `xattr -dr com.apple.quarantine /Applications/VisionCLI.app` in Terminal.

With Homebrew (*available once published*):

```sh
brew install --cask thethirdsourcers/tap/visioncli
```

Every release file can be checked against the workflow that built it: `gh attestation verify <file> -R thethirdsourcers/visioncli`. All install options are on [visioncli.thethirdsourcers.com](https://visioncli.thethirdsourcers.com); [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) covers each channel.

### Updates

VisionCLI checks GitHub for new releases at launch and every 6 hours. When one is out, the VisionCLI menu shows **Install Update**: it downloads the release, checks it's signed with the same certificate, replaces the app and restarts, keeping your permissions and settings. Use VisionCLI menu → Settings… → General → *Check Now* to check now, or turn automatic checks off there.

### 2. First launch

The VisionCLI icon appears in the menu bar and a welcome screen offers to set up the CLIs it finds. That registers VisionCLI's tools for every project: `claude mcp add visioncli --scope user …` for Claude Code, the global MCP config for Antigravity CLI, and `gemini mcp add -s user --trust visioncli …` for Gemini CLI. You can also do it later from VisionCLI menu → Settings… → Integrations → *Connect*.

macOS will ask for three permissions. VisionCLI needs all of them:

| Permission | Why |
|---|---|
| **Microphone** and **Speech Recognition** | to hear your question while you hold ⌥ |
| **Screen & System Audio Recording** for **VisionCLI** | to see the window you're asking about in voice mode. After allowing it, quit and reopen VisionCLI. |
| **Screen & System Audio Recording** for **your terminal app** (iTerm, Terminal, Warp…) | when you *type* to Claude Code, the screenshot is taken by the terminal running `claude`. Without it, Claude only sees the wallpaper. Restart the terminal after allowing it. |
| **Automation** (iTerm, Chrome/Brave) | asked the first time it types into your terminal or controls the browser |

If something doesn't work, check System Settings → Privacy & Security, and VisionCLI menu → Settings… → Advanced → *Open Log*.

### 3. Optional extras

| Add | Get | How |
|---|---|---|
| **Parakeet** | Fastest local transcription (~0.3s on the Neural Engine) that spells your project's class names right. Apple Silicon | VisionCLI menu → Settings… → Voice → Speech recognition → **Parakeet** (downloads ~600 MB on first use) |
| **Wispr Flow** | Use your own Wispr Flow account: hold ⌥ and speak as usual | Have Flow running with its push-to-talk key on fn, then pick **Wispr Flow** in Speech Recognition |
| **Whisper** | More accurate transcription of names and jargon (~0.7s, local) | VisionCLI menu → Settings… → Voice → Speech recognition → Whisper **Download…** (installs `whisper-cpp` via Homebrew, then downloads the ~490 MB model) |
| **Kokoro** | Natural voices for spoken answers (local) | VisionCLI menu → Settings… → Voice → Natural voices **Download…** (installs [`uv`](https://docs.astral.sh/uv/) if needed, then downloads ~350 MB) |
| **TypeSafe Jev** | Instant browser commands and multi-step browser tasks | add your key via VisionCLI menu → Settings… → Integrations → *Edit API Keys…*, or set `TYPESAFE_API_KEY` |
| **Browser control** | Click, scroll and read pages | in Chrome or Brave: **View → Developer → Allow JavaScript from Apple Events** |

Models are saved in `~/Library/Application Support/visioncli/models/`. Whisper and Kokoro models you already have from other tools (e.g. in `~/.cache/whisper`) are picked up automatically. Without them, VisionCLI uses Apple's on-device speech recognition and the system voice.

## Linux

1. Download **`VisionCLI-<version>-linux-x86_64.AppImage`** (or `-arm64`), the **`.deb`** for Debian/Ubuntu or the **`.rpm`** for Fedora/openSUSE, from the [latest release](https://github.com/thethirdsourcers/visioncli/releases/latest). Or install from a repository, so updates come with the system's (*available once published*):

   ```sh
   # Debian / Ubuntu
   curl -fsSL https://visioncli.thethirdsourcers.com/public.key | sudo gpg --dearmor -o /usr/share/keyrings/visioncli.gpg
   echo "deb [signed-by=/usr/share/keyrings/visioncli.gpg] https://visioncli.thethirdsourcers.com stable main" | sudo tee /etc/apt/sources.list.d/visioncli.list
   sudo apt update && sudo apt install visioncli-linux

   # Fedora / RHEL / openSUSE
   sudo curl -fsSL -o /etc/yum.repos.d/visioncli.repo https://visioncli.thethirdsourcers.com/visioncli.repo
   sudo dnf install visioncli-linux

   # Flathub / Snap Store
   flatpak install flathub com.thethirdsourcers.VisionCLI
   sudo snap install visioncli --classic
   ```
2. Install the desktop tools VisionCLI uses (the script detects apt/dnf/pacman/zypper and your desktop, and asks before installing): `sh app/scripts/install-deps.sh` from the repo, or see [docs/LINUX.md](docs/LINUX.md).
3. Start VisionCLI. The setup wizard checks each piece and offers fixes:
   - **Hold Alt to talk** reads the keyboard directly, so join the `input` group once (`sudo usermod -aG input $USER`, then log out and in). On X11 it also works without it.
   - **GNOME on Wayland:** VisionCLI installs a small GNOME Shell extension so it can see windows and the pointer (log out and in once). KDE, Sway and Hyprland need nothing extra.
   - **Computer control on Wayland** asks once through the desktop's Remote Desktop permission.
   - **Terminal mode** types into `claude` running in tmux, kitty or WezTerm, or into any terminal window directly.

Keys: ⌥ is **Alt**, ⌘ is **Super**. Everything else matches the macOS app.

## Windows

Preview. Download **`VisionCLI-<version>-windows-x64.exe`** (or `-arm64`) from the [latest release](https://github.com/thethirdsourcers/visioncli/releases/latest) and run it: it installs for your user only, no admin rights. The installer isn't code-signed yet, so SmartScreen asks once: *More info → Run anyway*. With winget (*available once published*): `winget install TheThirdSourcers.VisionCLI`; a Microsoft Store listing is in preparation.

Keys: ⌥ is **Alt**, ⌘ is the **Win** key (hold Alt to ask, Alt + Win with a screenshot, Alt + Shift + Space to drag a region). Terminal mode types into `claude` in Windows Terminal, WezTerm or any console window, including Claude Code inside WSL. Nothing else to install: keyboard, screen, UI Automation and the microphone work out of the box; the setup wizard downloads the speech models.

## Gemini (Antigravity CLI or Gemini CLI)

VisionCLI works with Gemini as well as Claude, using your own sign-in, the same way it uses your `claude` login:

| | Use when |
|---|---|
| **Antigravity CLI** (`agy`) | You sign in with a personal Google account. Google now serves personal accounts through Antigravity. |
| **Gemini CLI** (`gemini`) | Your Gemini CLI sign-in still works (paid Code Assist / work account), or you add an API key. |

- **Set up:** VisionCLI menu → Settings… → Integrations → *Connect* next to Gemini (Antigravity) or Gemini CLI (or `visioncli install`, which registers every CLI it finds).
  - Antigravity: adds visioncli to `~/.gemini/config/mcp_config.json` and allows its read-only/navigation tools in `~/.gemini/antigravity-cli/settings.json`.
  - Gemini CLI: `gemini mcp add -s user --trust visioncli …`.
- **Typing:** in `agy` or `gemini`, the visioncli tools (look, browser, database, device screenshots…) are available in every workspace.
- **Voice:** choose VisionCLI menu → **Settings… → Assistant → Gemini (Antigravity)**.
  - *Terminal* mode types your question into the `agy`/`gemini` running for the project (or opens one) and shows the answer in the terminal and the bubble.
  - *Bubble Only* mode runs it headless (`agy -p … --output-format stream-json`, or `gemini -p … -o stream-json`) and continues the same conversation each time.
- **Pointing at a terminal** that runs `claude`, `agy` or `gemini` uses that CLI, whatever the Assistant setting.

**Notes:**
- In Bubble Only mode the CLI can't ask for approval, so it only reads (code, screen, browser, database). Use terminal mode for edits and commands.
- Headless `agy` takes ~15s to start per question; terminal mode keeps it running and answers faster.
- Gemini CLI on a free *personal* Google sign-in now fails with "…no longer supported for Gemini Code Assist for individuals". Use Antigravity instead, or add `"gemini": {"apiKey": "..."}` in VisionCLI menu → Settings… → Integrations → *Edit API Keys…*.

## Use it

### Voice (anywhere)

| Keys | What happens |
|---|---|
| **Hold ⌥**, speak, let go | Ask as text, no screenshot (cheap). The assistant knows which window you're over and takes a look itself if it needs to. Tap to start, tap again to send |
| **Hold ⌥ ⌘** | Ask with a screenshot of the window under the mouse |
| **Hold ⌥ ⇧ Space** | Ask with a screenshot of just an area: drag a box around exactly what you mean, or tap ⌥ ⇧ Space again for the whole window |
| **⌥ P** | Pin the answer: scroll, select text, click `file:line` links, toolbar (copy, read aloud, history) |
| **⌥ O** | Open the first `file:line` in your editor (JetBrains IDEs, Xcode, VS Code, Cursor) |
| **⌥ ↩ / esc** | Approve or deny an edit or command (background mode) |
| **esc** | Dismiss, or stop the answer |

To attach a screenshot to every question instead, turn on **VisionCLI menu → Settings… → General → Screenshot every question**.

**Which project?** By default VisionCLI follows the window under your mouse. PhpStorm `myshop – payments` maps to `~/PhpstormProjects/myshop`, and a terminal running `claude` maps to its folder. With several projects open, pick one in **VisionCLI menu → Project**. The menu bar shows the current project.

**Which session?** In **Terminal** mode (the default), voice questions are typed into the `claude` (or `agy`/`gemini`, see [Gemini](#gemini-antigravity-cli-or-gemini-cli)) already running for that project in iTerm, or a new one is opened. You can type there too; it's one conversation, and answers show in both the terminal and the bubble. **Bubble Only** mode uses a hidden, leaner session instead. Switch in VisionCLI menu → *Settings… → Assistant → Answers appear*.

### In Claude Code (typing)

After *Set Up Claude Code*, just talk about what's on screen in any project:

- *"what is this file for?"*, *"why is this view misaligned in the simulator?"*
- *"let me select an area"*, *"read the page I have open and summarize it"*
- *"how are the orders and payments tables related?"*

Slash commands: `/mcp__visioncli__see <question>`, `/mcp__visioncli__point <question>`.

<details>
<summary><b>All MCP tools</b></summary>

| Tool | |
|---|---|
| `look` | Screenshot the window behind the terminal, the one under the mouse, a named app, or a display; reports the pointer position |
| `list_windows`, `select_region`, `clipboard_image` | Pick a window, drag a box, or use the clipboard image |
| `device_screenshot` | Clean iOS Simulator (needs Xcode) or Android (`adb`) screenshot |
| `db_schema`, `db_query` | Tables, columns, foreign keys; single read-only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH queries in a read-only transaction (MySQL, Postgres, SQLite from `.env`) |
| `browser_tabs`, `browser_open`, `browser_switch_tab`, `browser_navigate`, `browser_read`, `browser_elements`, `browser_click`, `browser_type`, `browser_select`, `browser_scroll` | Fast Chrome/Brave control via AppleScript (dropdowns, toggles with on/off state, custom React/Radix widgets) |
| `ui_elements`, `click`, `type_text`, `press_keys`, `scroll`, `drag`, `open_app`, `open_url` | Use any app: Accessibility element list with ids, real mouse/keyboard, by element id or screenshot pixels. Performed by VisionCLI.app (needs Accessibility permission), approved in the bubble |
| `start_voice` | Start the voice overlay |
</details>

## Menu

**Project** (Auto, or pick from running `claude`/`agy`/`gemini` sessions, open editors and recent projects) · **Claude Usage** · History · New Conversation · Copy Last Answer · Show Terminal · **Settings…** (⌘,).

**Settings…** opens one window, laid out like System Settings; changes apply right away:

- **General:** start at login, check for updates (now or automatically), Setup Wizard, screenshot every question.
- **Assistant:** Claude Code or Gemini (Antigravity), where answers appear (terminal or bubble only), model, effort, fast model for simple questions.
- **Voice:** read answers aloud, speed, voice (with a sample), natural voice download, speech recognition (Parakeet, Wispr Flow, Whisper, Apple), vocabulary, microphone and speaker.
- **Computer Control:** ask before each action, allow all, or off; Accessibility; AI cursor and instant commands in the browser; watch for app crashes.
- **Meeting Notes:** on/off, summaries (colleagues, you), suggested replies, code answers, recording, past meetings, and hiding VisionCLI from screen sharing.
- **Integrations:** connect VisionCLI's tools to Claude Code, Antigravity and Gemini CLI; API keys.
- **Advanced:** Fix Permissions, log, crash log, home folder.

## API keys

VisionCLI menu → Settings… → Integrations → *Edit API Keys…* opens `~/Library/Application Support/visioncli/integrations.json` (readable only by you):

```json
{
  "typesafe": { "apiKey": "..." },
  "gemini": { "apiKey": "..." }
}
```

- `typesafe`: instant browser commands with [Jev](https://typesafe.ai). Without it, every request goes to the assistant.
- `gemini` (optional): makes VisionCLI's Gemini runs use this API key instead of your `gemini` sign-in.

`TYPESAFE_API_KEY` in your shell is copied here by `visioncli voice` if the file has none.

## Privacy

- Screenshots and questions go to the assistant you picked (Claude Code or Antigravity), through your own login.
- With Jev enabled, quick commands send your spoken words, open tab titles and URLs, and visible link/button text to api.typesafe.ai. Browser tasks also send the visible text, controls and field values of the page in front (never password fields). Turn it off in Settings.
- Computer control runs locally: the MCP server talks to VisionCLI.app over 127.0.0.1 with a per-launch secret token (in a file only you can read). Nothing is clicked or typed unless an assistant asks and you allow it (or chose *Allow All Actions*).
- Whisper and Kokoro run locally. History is stored in `~/Library/Application Support/visioncli/`.

## Build from source

```bash
git clone https://github.com/thethirdsourcers/visioncli.git && cd visioncli
npm install                       # builds the MCP server (dist/)
node dist/index.js install        # register with Claude Code, Antigravity CLI and Gemini CLI (whichever are installed)
npm run build                     # build VisionCLI.app and install it into /Applications
node dist/index.js voice          # start voice mode (under launchd: restarts after a crash)
```

- `npm run setup-signing` (optional, once) creates a local code-signing identity so macOS keeps permissions across rebuilds.
- `npm run release` builds the downloadable universal `.dmg` and `.zip` into `release/`. Pushing a `v*` tag does the same on GitHub Actions and attaches them to a release.

**Layout:** `src/` is the MCP server and CLI (TypeScript). `overlay/Sources/` is the menu-bar app (Swift). `scripts/` has the build, release and signing scripts.

## Troubleshooting

| Problem | Fix |
|---|---|
| "VisionCLI can't be opened" | Right-click → Open, or `xattr -dr com.apple.quarantine /Applications/VisionCLI.app` |
| Claude sees only the wallpaper | Voice: enable Screen Recording for VisionCLI. Typing in Claude Code: enable it for your terminal app. Then quit and reopen that app. |
| Tools missing in Claude Code / Gemini CLI | VisionCLI menu → Settings… → Integrations → *Connect* / *Reconnect* (again after moving the app or switching Node versions), then restart `claude` / `gemini` |
| Gemini CLI: "no longer supported for Code Assist for individuals" | Google moved personal accounts to Antigravity: choose VisionCLI menu → Settings… → Assistant → *Gemini (Antigravity)* (or add a Gemini API key) |
| Gemini answers "tried a step that needs your approval" | Bubble Only mode can't approve commands/edits; switch VisionCLI menu → Settings… → Assistant → Answers appear to the terminal |
| Answers only in the terminal, or none at all | VisionCLI menu → Settings… → Advanced → *Open Log*; check `claude` is installed and signed in |
| Microphone errors | Pick a specific mic in VisionCLI menu → Settings… → Voice → Microphone |
| Sound bars move but no text appears | The pill now says why. Usually: allow **Speech Recognition** for VisionCLI (Privacy & Security), or turn on **Keyboard → Dictation**. Installing Whisper also transcribes without Apple's recognizer. |
| Asked for permissions again after updating, though Settings shows VisionCLI as allowed | The switch belongs to an older signature. VisionCLI 0.5.5+ clears it automatically on first launch; otherwise use VisionCLI menu → Settings… → Advanced → **Fix Permissions…** (or remove VisionCLI with − and add it again). Happens once when moving to the permanently signed releases; later updates keep permissions. |
| It crashed | It restarts automatically; details are in VisionCLI menu → Settings… → Advanced → *Open Crash Log* |

## Contributing

Contributions are welcome: bug reports, fixes, platform support and docs. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is organised and how to build and test it, and look for issues labelled **good first issue** to get started. Security problems: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Third Sourcers
