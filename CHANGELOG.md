# Changelog

## 0.11.0

- **Meeting Notes (macOS, Linux and Windows):** a note-taker for work meetings. Press **⇧⌥⌘R** on macOS, **Shift+Alt+Super+R** on Linux or **Shift+Alt+Win+R** on Windows (or Settings → Meeting Notes) to start.
  - Your colleagues (your computer's sound) and you (the microphone) are transcribed on your computer and shown as a chat in a side panel. With a Bluetooth headset, the computer's own mic records you so the headphones keep their sound quality.
  - Each colleague's turn gets a one-line summary.
  - When you're asked something, three short replies appear once they've finished talking. Click one to copy it, or type it where you're typing; nothing is sent.
  - Questions about the code are answered from the project (read-only), with file:line.
  - Each meeting is saved with its notes, a summary at the end (overview, key points, questions, action items) and a recording to play back alongside the transcript.
  - Every part can be switched off in Settings.
- **Hide VisionCLI from screen sharing** (Settings → Meeting Notes, macOS and Windows): VisionCLI's windows stay visible to you but are left out of screen shares and recordings. Linux has no way to do this.
- **Autopilot is removed** on every platform: Meeting Notes takes its place in Settings.
- **The project is picked by hand** (Project menu): it no longer follows the window under the pointer.
- **macOS, Terminal app:** voice questions are typed into the window VisionCLI opened. Before, each question opened another Terminal window and showed "Couldn't open a terminal" (with Gemini/Antigravity, or whenever iTerm wasn't used).

## 0.10.5

- **New look:** a new logo (an aperture around a pupil) on every app icon, the macOS menu bar and the Linux/Windows tray, and a new website at **https://visioncli.thethirdsourcers.com** with downloads for every platform.
- **Easier, verified installs:**
  - Linux: a signed apt repository on the website (`sudo apt install visioncli-linux`) and new `.rpm` packages with a signed dnf repository (`sudo dnf install visioncli-linux`).
  - macOS: Homebrew (`brew install --cask thethirdsourcers/tap/visioncli`), updated automatically with each release.
  - Windows: winget (`winget install TheThirdSourcers.VisionCLI`) once Microsoft accepts the package.
  - Every download carries a build provenance attestation (`gh attestation verify <file> -R thethirdsourcers/visioncli`).
- **macOS:** restarting VisionCLI no longer re-registers its background item, so the "App Background Activity" notice doesn't come back on every start.
- **Linux:** runs inside Flatpak (host tools through `flatpak-spawn --host`); the GNOME extension's id is now `visioncli@thethirdsourcers.com` (the old one is switched off and removed on update).
- Publisher name: Third Sourcers.

## 0.10.4

- **Windows on Arm, Kokoro voices:** every voice sample played the Windows voice, because Kokoro's Python libraries (onnxruntime, soundfile) have no Windows-on-Arm builds and Kokoro couldn't start. It now runs on x64 Python there, through Windows' built-in emulation. The system voice is labelled "Windows voice" on Windows.

## 0.10.3

- **Windows, Gemini in the terminal:** a voice question with a screenshot kept showing "Sending to Gemini…" after Gemini had answered. VisionCLI finds the conversation by the question's text, and Antigravity's transcript stores the screenshot's Windows path with escaped backslashes, so it never matched. It now matches both forms.

## 0.10.2

- **Assistant CLIs installed later are found (Linux and Windows):** VisionCLI kept the PATH from its first run, so Antigravity (`agy`) or Claude Code installed afterwards stayed "not installed" even after a restart. Now each launch adds the current PATH, Setup and Settings look again every few seconds, and on Windows the saved PATH (where installers write) is read too, along with Antigravity's own folder (`%LOCALAPPDATA%\agy\bin`).

## 0.10.1

- **Windows installers published:** the 0.10.0 release build stopped on a PowerShell parsing slip in the Windows packaging script, so its Windows installers were missing (macOS and Linux were fine). 0.10.1 is the same app with the Windows preview installers (`VisionCLI-0.10.1-windows-x64.exe`, `-arm64.exe`). CI now parse-checks that script on every push.

## 0.10.0

- **VisionCLI for Windows (preview):** the same app on Windows 10 and 11 (x64 and Arm), installed per user with no admin rights: hold **Alt** to ask (**Alt + Win** with a screenshot), Visi, the answer bubble with Mermaid and on-screen markers, terminal mode (Windows Terminal, WezTerm, Claude in WSL) and bubble mode with Claude Code and Gemini, computer control through UI Automation with approvals, Autopilot, crash watching (Windows Error Reporting), history, usage, Settings, the setup wizard, start at login, Whisper/Parakeet/Kokoro voices and browser control for Chrome, Brave and Edge. A small built-in helper (`vcli-win.exe`, .NET Framework 4.8, part of every Windows) does what Windows only allows native code to do. Download `VisionCLI-<version>-windows-x64.exe` (or `-arm64`) from the release. The installer isn't code-signed yet, so Windows SmartScreen asks once: *More info → Run anyway*.
- **One app for Linux and Windows:** the desktop app's folder is now `app/` (was `linux/`), with each system's parts behind the same interfaces; CI runs every test on macOS, Linux and Windows, plus the helper's self-test and a launch with a screenshot on Windows.
- **Browser control** also works with Microsoft Edge (Windows and Linux), and the browser helper no longer starts a second copy of the app when the MCP server runs inside it.

## 0.9.1

- **Gemini usage:** with Gemini (Antigravity) as the assistant, the menu shows *Gemini Usage* (Antigravity's 5-hour and weekly limits, plus the Claude/GPT models you use through it) instead of Claude's, with the same menu-bar rings. Reading it costs nothing. Mac and Linux.
- **Shorter terminal questions for Gemini:** the voice instructions go with the first question of a conversation only; later ones carry just `[voice]`. Mac and Linux.
- **Linux, much lighter when idle:** about 3% CPU instead of 30% (the pointer is read only after the mouse moves; answers re-place twice a second instead of 60 times), about 400 MB less memory (rarely used overlays open on demand), and Parakeet/Kokoro unload after a quiet spell and reload as you start talking.
- **Linux voice fixes:** Whisper's final transcript is accurate again and allowed more time on slower CPUs; a junk transcript ("-", "[BLANK_AUDIO]", "Mm-hmm") or a slip of the finger no longer gets sent; Parakeet is offered in Settings (it downloads on first use) with a progress bar; Kokoro voices play in the AppImage (it couldn't read its script from the app archive), and the system voice speaks if Kokoro can't start.
- **Linux keys:** a Mac's Command key works as Super through VNC/remote desktops (Alt+Super attaches a screenshot), and `xinput` is now a dependency for hold-to-talk without the input group.
- **Linux:** the microphone list shows real sound cards instead of ALSA plugins; the menu says "Quit VisionCLI".

## 0.9.0

- **VisionCLI for Linux:** the whole app now runs on Linux, any distribution, on X11 and Wayland (GNOME, KDE, Sway, Hyprland): hold Alt to ask (Alt+Super with a screenshot), Visi, the answer bubble with Mermaid and on-screen markers, terminal and bubble modes with Claude Code, Antigravity and Gemini, computer control with approvals, Autopilot, crash watching, history, usage, Settings, the setup wizard, start at login and quick browser commands and tasks. Download the AppImage or .deb (x86_64 and arm64) from the release. Built with Electron; transcription is Whisper or Parakeet (the same model as on the Mac), voices are Kokoro or the system voice. Not available on Linux: Wispr Flow (no Linux app). See docs/LINUX.md for what each desktop needs.
- **MCP server on Linux:** `look`, `list_windows`, `select_region`, `clipboard_image` and every `browser_*` tool work on Linux. Browser control goes over DevTools (Chrome, Brave, Chromium; native, Flatpak and Snap).
- CI now also runs on Ubuntu, including a real X11 capture test and the Linux app's 212 tests.

## 0.8.0

- **Multi-step browser tasks:** say a task for the page in front, like "find a stay in Lisbon for 3 nights with a pool and free cancellation, then open it", and a Jev agent does it step by step: it reads the page, one Jev request picks the next operation (click, type, choose from a dropdown, scroll, wait, done) and its target, and it acts, about 0.3–0.5 s per step. Each step shows in the bubble as it happens; Esc stops it. Text it types comes from your own words. It never confirms a purchase, payment, booking, deletion or message unless you asked for that step, and stops when it needs a password or personal details. Works with Chrome (and Brave) over DevTools: tick *Allow remote debugging* at chrome://inspect/#remote-debugging and click Allow when it connects. Design after browser-use/jev-ultrafast.
- **Scrollable answers:** the answer bubble scrolls in place with a visible scroll bar on the right, and links work without pinning. The ⌥ shortcut hint is replaced by buttons (copy, read aloud, history, open file, pin, close), and the bubble stays open while the pointer is on it.
- **Fix:** ⌥P / ⌥O could also start listening, since ⌥ alone is the talk key.

## 0.7.9

- **Settings window:** the nested Settings menus are replaced by one window in the style of macOS System Settings (VisionCLI menu → Settings…, or ⌘,). Sections: General, Assistant, Voice, Computer Control, Autopilot, Integrations and Advanced; changes apply immediately. Voices play a sample when picked, downloads show progress, the speaker has a Test button, and Integrations connects VisionCLI's tools to Claude Code, Antigravity and Gemini CLI without pop-ups.
- **Simpler menu:** Show Terminal, Show Live Activity and Continue in Terminal are now top-level items; everything else lives in the Settings window.

## 0.7.8

- **Cleaner, tested codebase:** the app's 2,356-line main file is split into focused parts (270 lines left), the server's tools are split by area, and 251 automated tests (app core logic and server) now run on every push. Messages between the app and the server are typed on both sides, with a test that keeps them in sync.
- Fixes found by the new tests: `ui_elements` and `look_after` output showed a literal `\n` instead of line breaks; clicking on "image N" could use the wrong screenshot when its record was missing; `.env` values with trailing spaces or Windows line endings kept their quotes.

## 0.7.7

- **Report back out loud:** a new `announce` tool lets Claude or Gemini tell you when background work they promised to report on is done ("the release is live"). VisionCLI shows it in the bubble and says it out loud, even with Speak Answers off, and waits if you're in the middle of a question.
- **Fix: a second voice talking over the answer.** Tables and other markdown were read aloud; Kokoro couldn't pronounce fragments like `|---|` and the macOS voice jumped in mid-answer, saying "dot" and "bar". Spoken answers now skip tables, code blocks and bare punctuation, and stay in one voice.

## 0.7.6

- **Gemini is much faster:** one Antigravity process per project stays running (questions go to it over stdin), started at launch in bubble mode and kept ready for an hour, instead of a new ~20 s startup for every question.
- **Smart routing (bubble mode):** one Jev (TypeSafe System One) request, about 0.5 s, decides whether a question is light ("what is this?", "how are you") or heavy (code changes, debugging, planning). Light ones go to a small fast model (Claude Haiku or Gemini Flash Low), heavy ones and their follow-ups to your model; switching lanes carries the last exchanges along. Turn it off in Settings → More.
- **Your model by default:** with no model picked in VisionCLI, Claude uses the model your terminal Claude is on, or your Claude Code default (it no longer forces Sonnet). Gemini uses Antigravity's default unless you pick one.
- **VisionCLI Home:** a general-purpose project (`~/VisionCLI`) for questions that aren't about any project. Questions asked away from any project window go there; shortly after using a project, Jev decides whether a question is about that project or general. Pin Home in the Project menu to use VisionCLI as a plain assistant.

## 0.7.5

- **Setup wizard:** first-time users get one window that walks through everything VisionCLI needs, one step at a time, each ticking itself as soon as macOS reports it granted: Microphone, Speech Recognition, Accessibility, Screen Recording (it restarts the app for you and resumes there), Terminal access, the speech model (Parakeet, Wispr Flow, any Whisper model on your Mac, or Apple, with download progress), voice (read answers aloud, speed, and every voice with a sample), and your assistant (Claude Code or Gemini through Antigravity, where answers appear, and connecting VisionCLI's tools). It replaces the burst of permission prompts on first launch. Reopen it from VisionCLI menu → Settings → Setup Wizard….
- **Simpler menu:** only Project, Claude Usage, History, New Conversation, Copy Last Answer and Settings at the top. Assistant, Answer In, Model, Effort, Voice & Audio, Computer Control and Autopilot live under Settings; rarely used options under Settings → More.
- **No emoji** in menus, messages or the activity log.
- **Recipes removed:** just ask for what you want ("run the tests", "review my changes").

## 0.7.4

- **New keys:** hold **⌥** to ask as text, hold **⌥⌘** to ask with a screenshot of the window under the mouse (adding ⌘ while holding ⌥ also works). ⌥⇧Space still lets you drag an area.
- **Meet Visi:** a little robot peeks in from the right edge of the screen while you hold ⌥. It blinks, talks along with you, pulls a face now and then (wink, laugh, surprise, wave), and its antenna glows while the answer is on its way.
- **Autopilot (off by default):** in the apps you pick (VisionCLI menu → Autopilot), VisionCLI glances at the window when you switch to it or pause, and shows a small suggestion card when it has something useful; in chat apps it drafts a reply you can put in the reply box. Nothing is ever sent for you. Uses Claude Haiku (about 1k tokens a look, at most 30 an hour); password fields and password managers are never read. *Check Now* asks for a suggestion right away.
- **See when it's looking or acting:** a small pill at the top of the screen shows when a screenshot is taken or Autopilot is reading, and the screen edges glow while the assistant is using your computer.
- **Wispr Flow:** your words now show live while you speak (Apple's on-device recognizer runs alongside Flow for the preview), and if Flow returns nothing the live text is used instead of failing. ⌥⌘ works with Flow.
- **Terminal mode:** questions go to the Claude you already have open for the project (the most recent one), or open your latest conversation like `claude -c`. The question is always submitted (Return is pressed again if Claude swallowed it), and the note added to it is now short: `[voice · mouse over …]`, only naming the window when the mouse is really over another app.
- **Much faster and lighter:**
  - No more freezes: the terminal, computer control, microphone, transcript reading and screenshot saving all run off the main thread (one long session used to freeze the bubble for 10 seconds per question).
  - Idle CPU went from ~9% to ~0%.
  - Parakeet starts the moment you let go.
  - Short questions skip the quick-command check (~1 s faster).
  - The MCP server starts in ~45 ms (bundled), `look` gets the window list from the app (7 ms instead of ~120 ms), browser tabs are read in one go, and database connections are reused.
  - The log rotates at 5 MB, and history keeps at most 30 days or 300 MB of screenshots, with thumbnails.

## 0.7.3

- **Parakeet is included in the download.** 0.7.2 was built without it (the release build's compiler was too old); the release build now uses the latest Xcode.
- **Faster screenshots:** captured in memory with ScreenCaptureKit, about 3× faster (≈80 ms for a whole display instead of ≈215 ms). Claude's `look` tool uses the running app for this too; without the app it falls back to `screencapture`.

## 0.7.2

- **New keys, no Space:** hold **⌃** to ask as text only (no screenshot, far fewer tokens; the assistant takes its own look if it needs to), hold **⌃⌥** to ask with a screenshot of the window under the mouse (adding ⌥ while holding ⌃ also works). ⌥⇧Space still lets you drag an area. Other ⌃ shortcuts (⌃C, ⌃-click) keep working. Without the Accessibility permission the keys fall back to ⌃Space / ⌃⌥Space. VisionCLI menu → Settings → *Screenshot Every Question* brings back the old behaviour.
- **See what it sees:** while a screenshot question is held, the display under the mouse dims except the window that will be captured (cyan outline).
- **Parakeet speech recognition:** NVIDIA Parakeet TDT runs locally on the Neural Engine (Apple Silicon), about 0.2–0.3 s per question, and gets your project's names right (class names from the window title, your vocabulary list, common tools). Choose it in VisionCLI menu → Voice & Audio → Speech Recognition; the model (~600 MB) downloads on first use.
- **Wispr Flow:** use your own Wispr Flow account as the speech engine. Hold ⌃ and speak as usual; VisionCLI holds Flow's push-to-talk key for you and takes Flow's text as the question.
- **Claude usage in the menu bar:** a coloured ring with your current 5-hour session usage (optionally the week too), and a usage card in VisionCLI menu → Claude Usage with session and weekly limits, reset times and today's tokens across all Claude Code sessions.
- **All Claude models:** Fable, Opus, Sonnet, Haiku, Opus-plan and the 1M-context variants. Changing Model or Effort in the menu is sent to the Claude running in your terminal (`/model`, `/effort`), and the menu follows a model you pick in the terminal. Saying "slash compact" (or any "slash …") runs it as a real command.
- **History per project:** History opens on the current project, with a project picker, *Clear Project*, and 200 questions kept per project.
- Fixes: Bluetooth headsets (AirPods, Sony…) no longer record silence when they switch to their call mode mid-question; the crash watcher ignores Xcode's background services.

## 0.7.1

- **Fix: browser tasks opened lots of tabs and windows.** `browser_open` now switches to a tab already showing the page, otherwise reuses the assistant's own working tab, and opens at most one new tab. In Chrome/Brave, keyboard navigation (⌘L/⌘T/⌘N) from computer control is refused in favour of the browser tools, so keys can't land in the wrong window.
- **Browser tools see inside frames.** Portals and admin panels that put their UI in iframes/frames (government and bank sites, Ext JS apps) now work with `browser_elements`, `browser_click`, `browser_type`, `browser_select` and `browser_read`, instead of falling back to pixel clicks.
- **No more races.** Clicks and typing in the browser happen immediately (the AI cursor just shows where), so the next step never runs before a field is filled, even when Chrome is in the background.
- **Answers in the top-right corner.** The answer bubble and approval cards sit in the corner (under the task panel); only the listening/thinking loader follows the cursor. Pointing markers are drawn on the real screen again, over the thing being explained.

## 0.7.0

- **Computer control: VisionCLI can use your Mac.** Claude or Gemini can click, double/right-click, drag, scroll, type, press shortcuts, open apps and URLs, in any app, from voice or from the terminal. It reads each app's real buttons, fields and menus through Accessibility (`ui_elements`) so it clicks "Save" by id instead of guessing pixels; pixel positions on a screenshot work too. Keys and typing go to the app it's working in, never by accident to your terminal.
  - **Approvals:** VisionCLI menu → Computer Control → *Ask Before Each Action* (default), *Allow All Actions*, or *Off*. Password fields, System Settings, Keychain and password managers always ask.
  - **Task panel** (top-right) lists each step with ✓/✗, plus **Pause** and **Stop**. **Esc** stops the assistant from touching the computer until your next question.
  - Needs the Accessibility permission (VisionCLI menu → Computer Control → Grant Accessibility Permission…).
- **Recipes:** saved routines (*Explain this screen*, *Fix this error*, *Run the tests*, *Review my changes*, *Explain the last crash*, *Run on the simulator*, *Write a commit message*) in VisionCLI menu → Recipes, or say the name ("run the tests"). Edit or add your own in `recipes.json`.
- **Crash watcher:** when one of your apps (Mac or iOS Simulator) crashes, VisionCLI offers to explain it, and your next question includes the crash report's path.
- **Browser dropdowns and toggles work.** Clicks now send the full pointer sequence (custom React/Radix/MUI widgets respond), new `browser_select` picks options in native and custom dropdowns, and `browser_elements` shows toggles' on/off state and dropdowns' options. Fixed stale element ids after listing a page twice.
- **Drawings are shown on the screenshot inside the bubble**, not on your real screen.

- **Two assistants:** Claude Code or Gemini (Antigravity). Gemini CLI is no longer offered (it doesn't work on personal Google accounts); anyone who had it selected moves to Antigravity.
- **Model menu for Gemini:** every model your `agy` account offers (Gemini 3.8/3.7/3.6 Flash, 3.1 Pro, …), or agy's default. Claude keeps Sonnet / Opus.
- **Effort menu** (Default, Low, Medium, High, Extra High, Max) for both Claude and Gemini, in bubble and terminal mode (`--effort`).
- **Gemini can run commands in Bubble Only mode.** Read-only commands (grep, rg, ls, cat, find, git status/log/diff…) run without asking. Any other command shows the approval card, as with Claude: Allow runs it and Gemini continues, Allow all keeps it for the session (removed on New Conversation or quit), Deny makes Gemini answer without it.

## 0.6.0

- **Mermaid diagrams in the answer bubble.** For flows, relationships, data models or architecture, the answer can include a ```mermaid diagram (flowchart, sequence, ER…). It's rendered as a picture in the bubble with the bundled Mermaid (works offline), sized to fit, with a "Drawing diagram…" placeholder while it streams; the read-aloud voice skips the code.
- **Drawing on the screen to explain.** Besides boxes, answers can draw **arrows** (from one thing to another), **circles**, and **numbered steps** (①②③) on your real screen. They animate in the order written, like someone explaining with a pen. Works with Claude, Gemini (Antigravity) and Gemini CLI.

## 0.5.5

- **Self-repairing permissions.** After a signature change (moving to the permanently signed releases), System Settings can show VisionCLI as allowed while macOS still asks, and toggling doesn't help. On the first launch of a new version, VisionCLI now clears its own stale entries (only for permissions not actually in effect), so macOS shows a fresh prompt and one click fixes it. VisionCLI menu → Settings → *Fix Permissions…* does the same on demand.

## 0.5.4

- Fix: *Install Update* refused updates that were correctly signed (the signature check read an extra line from `codesign`). Verified end to end: a 0.5.2 build updated itself from GitHub, kept the same certificate, and relaunched. **If you have 0.5.3, download 0.5.4 manually once**; automatic updates work from 0.5.4 on.

## 0.5.3

- **Permissions survive upgrades.** Releases are now signed with VisionCLI's permanent certificate instead of an ad-hoc signature (which changed every build, so macOS asked for Screen Recording / Microphone again after each update). You'll be asked one last time when moving to 0.5.3.
- **Check for updates.** VisionCLI checks GitHub at launch and every 6 hours, then offers *Install Update*: it downloads, verifies the signature matches, replaces itself and restarts. Manual check and an on/off switch are in VisionCLI menu → Settings.

## 0.5.2

- **Fix: level bars move but no text appears** (seen on some Macs). Live captions no longer fail silently. VisionCLI checks Speech Recognition permission, retries with Apple's online recognition when on-device recognition isn't available for the language, and shows the reason and fix in the pill (permission, Dictation off, …). Audio keeps recording, so Whisper can still transcribe; if nothing could, the bubble says why instead of "Didn't catch that".

## 0.5.1

- **Whisper and Kokoro on any Mac**: when they aren't installed, VisionCLI menu → Voice & Audio offers *Download Whisper* (installs whisper-cpp via Homebrew + the small.en model) and *Download Natural Voices* (installs uv if needed + the Kokoro model), with progress in the menu. Each switches itself on when done. Previously they only appeared on Macs that already had the models.

## 0.5.0

- **Gemini via Antigravity CLI (`agy`)**, using your Google sign-in: VisionCLI menu → Assistant → *Gemini (Antigravity CLI)*. Terminal mode opens or attaches to `agy` and follows its transcript (`~/.gemini/antigravity-cli/brain/<id>/…/transcript.jsonl`). Bubble Only mode runs `agy -p --output-format stream-json --conversation <id>`. *Set Up Antigravity CLI* registers the MCP tools globally with allow rules. Verified end to end in both modes, including attaching to a running `agy`.
- Clear message when headless Gemini ends a turn because a step needed approval.

- **Gemini CLI support**: *Set Up Gemini CLI* registers the MCP tools (`gemini mcp add -s user --trust`); VisionCLI menu → Assistant → Gemini CLI answers voice questions in Gemini Terminal mode (types into your running `gemini`, reads its session file) or Bubble Only mode (`gemini -p -o stream-json`, resumed per project). Pointing at a terminal that runs `gemini` uses it automatically, and the Project menu marks running `gemini` sessions.
- Gemini uses your normal `gemini` sign-in, like Claude uses your `claude` login. Optionally, a `gemini.apiKey` in integrations.json switches VisionCLI's runs to API-key auth. Auth errors show actionable messages.
- `visioncli install` also registers with Gemini CLI when it's installed.

## 0.4.1

- First-run setup picks the newest Node.js 18+ on the machine instead of the first `node` on the path (an old Node 16 in /usr/local/bin was being chosen).
- Welcome screen, setup dialog and README now explain that typing in Claude Code needs Screen Recording for your terminal app.
- Removed the `share` tool and the Slack, Linear, Jira and markdown-report integrations. `integrations.json` now only holds the TypeSafe key for Jev.

## 0.4.0

First public release.

- **MCP server for Claude Code**: `look`, `select_region`, `list_windows`, `clipboard_image`, `device_screenshot` (iOS Simulator / Android), read-only `db_schema` / `db_query`, `share` (file, Slack, Linear, Jira), browser tools (`browser_tabs`, `browser_read`, `browser_click`, …).
- **VisionCLI.app voice overlay** (macOS): hold ⌥Space to ask about what's under the mouse; answers in a bubble above the pointer, read aloud.
  - Project auto-detection from the window under the pointer, or pick one in the menu.
  - Claude in your terminal (type or talk, same conversation; attaches to an existing `claude` for the project) or background mode.
  - Local Whisper transcription and Kokoro voices when installed; speech speed up to 2×.
  - Instant browser commands via TypeSafe Jev with a visible AI cursor.
  - Highlight boxes on screen, drag-to-select, pin & scroll, file links, approvals for edits and commands, history.
  - Microphone / speaker selection, crash logging and automatic restart.
