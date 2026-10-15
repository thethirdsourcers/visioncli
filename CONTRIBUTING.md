# Contributing to VisionCLI

Thanks for helping! VisionCLI is MIT-licensed and built in the open by [Third Sourcers](https://thethirdsourcers.com) and contributors. Bug reports, fixes, new platform support, docs and translations are all welcome.

## How the code is laid out

| Folder | What it is | Language |
|---|---|---|
| `src/` | The MCP server: the tools Claude Code / Gemini call (`look`, `browser_*`, `click`, `db_*`…), quick commands (Jev), the browser agent | TypeScript (Node) |
| `overlay/` | The macOS app: hold-⌥ voice, the bubble, Visi, computer control, settings | Swift / AppKit |
| `app/` | The Linux and Windows app (Electron): the same features, with each platform's parts behind the interfaces in `app/src/main/contracts.ts` | TypeScript |
| `app/native/windows/` | `vcli-win.exe`, the small Windows helper (hooks, UI Automation, capture, audio) | C# (.NET Framework 4.8) |
| `packaging/` | The website, Homebrew, winget, Flatpak, Snap and Store packaging | |
| `docs/` | `LINUX.md` (platform notes and the feature map), `DISTRIBUTION.md` (release channels), `brand/` (logo masters) | |

Every feature should behave the same on macOS, Windows and Linux. If you change a feature on one platform, check the others (the macOS app and `app/` mirror each other module by module), or say in the pull request what's left to port.

## Build and test

You need Node.js 22.

```sh
npm ci && npm test                     # the MCP server (all platforms)
cd app && npm ci && npm test           # the Linux/Windows app
sh scripts/test-overlay.sh             # the macOS app's core tests (macOS, Xcode Command Line Tools)
```

Run them locally:

- **macOS app:** `sh scripts/build-overlay.sh` builds and installs `/Applications/VisionCLI.app`, then `node dist/index.js voice` starts it.
- **Linux/Windows app:** `cd app && npm start` (Linux and Windows; on macOS it builds but the desktop parts are for Linux/Windows).
- **Windows helper:** `sh app/native/windows/build.sh` (builds on macOS too, with the .NET SDK).

CI runs on pull requests, per platform and only for the parts a change touches (`ci-mac.yml`, `ci-linux.yml`, `ci-windows.yml`): the tests, plus the Windows helper's self-test and a launch with a screenshot. Pushes to main don't run it, so run the tests above before pushing.

## Pull requests

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Keep the change focused, match the surrounding code style (short comments that explain *why*), and add tests for logic you add or change.
3. Make sure the three test commands above pass.
4. Describe what you changed and how you checked it (screenshots for UI changes).

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).

## Reporting bugs

Use the bug report template. The most useful details: your OS and version, VisionCLI's version (Settings → General), which assistant (Claude Code / Gemini), and the log:

- macOS: `~/Library/Logs/visioncli.log`
- Linux: `~/.local/state/visioncli/visioncli.log`
- Windows: `%LOCALAPPDATA%\visioncli\logs\visioncli.log`

Security problems: please don't open a public issue, see [SECURITY.md](SECURITY.md).

## Code of conduct

Be kind and constructive: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
