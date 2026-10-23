# VisionCLI on Flathub

App id `com.thethirdsourcers.VisionCLI`. The manifest repackages the release's unpacked Linux app
(`VisionCLI-<version>-linux-{x64,arm64}.tar.gz`, built by `app/scripts/package-release.sh`) on
`org.freedesktop.Platform` 26.08 with `org.electronjs.Electron2.BaseApp` (zypak gives Chromium its sandbox).

| File | What |
| --- | --- |
| `com.thethirdsourcers.VisionCLI.yml` | the manifest |
| `com.thethirdsourcers.VisionCLI.metainfo.xml` | AppStream: description, homepage, developer, releases, screenshots (`packaging/site/screenshots`) |
| `visioncli.sh` | `/app/bin/visioncli` and `/app/bin/visioncli-mcp` |

## Build and try it locally

```sh
flatpak install --user flathub org.freedesktop.Platform//26.08 org.freedesktop.Sdk//26.08 org.electronjs.Electron2.BaseApp//26.08
flatpak-builder --user --install --force-clean build-dir com.thethirdsourcers.VisionCLI.yml
flatpak run com.thethirdsourcers.VisionCLI
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest com.thethirdsourcers.VisionCLI.yml
appstreamcli validate com.thethirdsourcers.VisionCLI.metainfo.xml
```

## Submitting

`FLATHUB_SUBMISSION.md` has the steps, what to tell reviewers about each permission, the lint results and domain
verification. Each release: new archive URLs and sha256s (Flathub's checker opens that pull request) and a
`<release>` in the metainfo.

## How the app behaves inside Flatpak

- `/.flatpak-info` switches `src/flatpak.ts` on: host tools go through `flatpak-spawn --host` (with the variables the
  app set, e.g. PATH), helpers that live as long as the app add `--watch-bus` so they stop with it, and anything under
  `/app` (or the Electron binary itself) runs inside. Lookups (`which`) ask the host when the sandbox can't see a tool.
- `visioncli.sh` keeps `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` at the host's defaults, so settings and
  models are shared with the MCP server on the host and with a previous .deb/AppImage install, and points `TMPDIR`
  into `~/.var/app/com.thethirdsourcers.VisionCLI/cache/tmp`, a path both sides see (the sandbox's `/tmp` is private).
- The MCP server: the app copies `visioncli-mcp` to `~/.local/bin` as usual; on the host that script finds no
  AppImage or `/opt/VisionCLI` and runs `flatpak run --command=visioncli-mcp com.thethirdsourcers.VisionCLI`.
- Start at login writes the systemd user unit (or XDG autostart entry) in the host's `~/.config` with
  `flatpak run com.thethirdsourcers.VisionCLI` as the command.

Not yet routed through the helper (they run inside the sandbox and may not find the host's tools): the microphone
and playback tools in `app/src/main/audio`, espeak-ng/spd-say/piper in `app/src/main/tts/system.ts`, `xinput`/`xmodmap`
in `app/src/main/input`, and the terminal emulators in `app/src/main/assistant/terminal.ts`. Test these in the
Flatpak before submitting; each is a one-line `hostCommand(...)` change.
