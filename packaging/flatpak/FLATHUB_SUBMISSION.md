# Submitting VisionCLI to Flathub

Everything in this folder is ready to submit. The steps below are the ones only you can do (they need your GitHub
account). Flathub's docs: https://docs.flathub.org/docs/for-app-authors/submission

## Before you open the pull request

1. **Publish the screenshots.** The metainfo points at `https://visioncli.thethirdsourcers.com/screenshots/*.png`.
   `packaging/site/build.sh` copies `packaging/site/screenshots/` there, so they go live with the next site deploy
   (the `site.yml` workflow). Check them:

   ```sh
   for f in answer computer-control settings; do curl -sI https://visioncli.thethirdsourcers.com/screenshots/$f.png | head -1; done
   ```

   All three must say `200`. Flathub's linter fails the build if a screenshot can't be downloaded.

2. **Check the manifest against the current release.** The manifest points at v0.11.1. If you've released since,
   update the two archive `url`s and `sha256`s from that release's `SHA256SUMS.txt` (the `-linux-x64.tar.gz` and
   `-linux-arm64.tar.gz` lines), and add a `<release>` to the metainfo (a test checks the current version is there).

## Open the pull request

1. Fork https://github.com/flathub/flathub. On the fork page, **untick "Copy the master branch only"**: you need
   the `new-pr` branch.
2. Clone your fork and branch from `new-pr`:

   ```sh
   git clone --branch=new-pr git@github.com:<you>/flathub.git && cd flathub
   git checkout -b add-visioncli
   ```

3. Copy these three files to the **root** of that repo, nothing else:

   ```sh
   cp ~/projects/visioncli/packaging/flatpak/{com.thethirdsourcers.VisionCLI.yml,com.thethirdsourcers.VisionCLI.metainfo.xml,visioncli.sh} .
   git add . && git commit -m "Add com.thethirdsourcers.VisionCLI" && git push -u origin add-visioncli
   ```

4. Open a pull request **against the `new-pr` branch** (not `master`) of flathub/flathub, titled
   **`Add com.thethirdsourcers.VisionCLI`**. Fill in the template's checklist honestly. It asks you to confirm
   things like "I am the upstream developer" (you are) and that you've read the requirements.
5. A bot builds it. Comment `bot, build` on the PR to rebuild after you push changes.

## What reviewers will ask, and what to answer

The manifest lint passes with no errors (see "Lint results" below). The two warnings, and every wide permission,
need a sentence each. Answer in the PR comments, and paste these as needed.

**Built from source? (the biggest risk.)** Flathub's rule is that "all source available submissions must be built
entirely from source code". This manifest repackages the release's prebuilt Electron app. Reviewers may accept it,
since you're the upstream vendor and the tarball is your own CI's release artifact (published with `SHA256SUMS.txt`). They may also ask
for a from-source build: `flatpak-node-generator` for the npm dependencies, building `app/` with
`electron-builder --dir` offline. If they ask, answer that you'll do that and follow up. It's real work, a separate
task. Don't argue the rule.

**`--talk-name=org.freedesktop.Flatpak`** (lint: `finish-args-flatpak-spawn-access`, needs an exception):
> VisionCLI is a front end for the user's own AI command-line tools (Claude Code `claude`, Gemini CLI, Antigravity
> `agy`), which are installed on the host and signed in with the user's account. It can't bundle them. It also drives
> host desktop tools (`tmux`, `xdotool`, `wmctrl`, `grim`, `pactl`) that act on the user's session. All host calls go
> through one helper (`src/flatpak.ts`, `flatpak-spawn --host`), and only those tools run on the host. This is the
> same reasoning as IDEs and terminals on Flathub.

**`--socket=x11` and `--socket=wayland` together** (lint: `finish-args-contains-both-x11-and-wayland`, a warning):
> The overlay (transparent, always-on-top, click-through bubble and pointer markers) needs X11. Electron runs with
> `--ozone-platform=x11` (`app/src/main/index.ts`), so on Wayland sessions it uses XWayland and `fallback-x11` would
> leave it without a display. The Wayland socket is there so the app detects a Wayland session (GNOME, KDE, Sway,
> Hyprland) and picks the right window and input backend.

**`--device=all`**:
> Hold-to-talk needs a global held key, which on Wayland is only readable from `/dev/input` (evdev). Computer
> control on Wayland types and clicks through `/dev/uinput`. No portal covers either: the GlobalShortcuts portal
> can't bind a bare modifier (Alt held alone) and isn't on every desktop, and RemoteDesktop asks again every session. The user must also be in the `input` group, as with our .deb.

**`--filesystem=home`**:
> The core feature is matching what's on screen to the real file in the user's projects and answering with
> `file:line`. The user's CLIs also work in those project folders, wherever they live. Settings and speech models
> are shared with the app's MCP server, which the CLIs start on the host (`~/.config/visioncli`, `~/.local/share/visioncli`).

**`--talk-name=org.a11y.Bus`**: computer control reads other apps' buttons and fields through AT-SPI.

**`--talk-name=org.kde.KWin`**: on KDE Plasma (Wayland), the window list and pointer come from a KWin script the app
loads through `org.kde.kwin.Scripting`. The script reports back to `com.thethirdsourcers.VisionCLI.KWinBridge.p<pid>`,
a name under the app id, so no `--own-name` is needed.

**`--talk-name=dev.visioncli.Shell`**: on GNOME, VisionCLI's own Shell extension exports the window list, the pointer
and window screenshots on this name. It's the same extension the .deb, .rpm and AppImage use.

**`--talk-name=org.freedesktop.Notifications`, `--talk-name=org.kde.StatusNotifierWatcher`**: notifications and the
tray icon (Electron's tray uses StatusNotifierItem).

**`--socket=pulseaudio`**: microphone input for voice questions, and spoken answers.
**`--share=network`**: the AI CLIs and speech model downloads, plus the local speech servers on 127.0.0.1.

**Metainfo upstream.** Flathub wants the metainfo to live in the upstream project. It does
(`packaging/flatpak/` in thethirdsourcers/visioncli). If asked to fetch it from upstream instead of shipping a copy,
change the metainfo source to a `type: file` with
`url: https://raw.githubusercontent.com/thethirdsourcers/visioncli/v<version>/packaging/flatpak/com.thethirdsourcers.VisionCLI.metainfo.xml`
and its `sha256`. That only works from the first tag that contains this version of the file, which is the next
release after 0.11.1.

## After it's merged

1. Flathub creates `github.com/flathub/com.thethirdsourcers.VisionCLI` and invites you as a maintainer. Accept it.
   From then on, updates are pull requests to that repo. The `x-checker-data` entries make Flathub's bot open them
   for each new GitHub release (new URLs and sums); you add the `<release>` notes.
2. **Verify the domain** (the store's "Verified" badge for `com.thethirdsourcers.*`):
   - Log in at https://flathub.org with GitHub, open the app's developer page, then "Verification". Pick
     website verification for `thethirdsourcers.com`. It shows a token.
   - Put the token, exactly as given and alone in the file, at
     `https://thethirdsourcers.com/.well-known/org.flathub.VerifiedApps.txt`.
   - Who serves that domain: `curl -sI https://thethirdsourcers.com` shows `server: cloudflare` with Cloudflare name
     servers, and the site is `~/projects/thethirdsourcers` (github.com/thethirdsourcers/thethirdsourcers, which has a
     `_headers` file, so Cloudflare Pages). Add the file there as `.well-known/org.flathub.VerifiedApps.txt` and deploy
     the way that site normally deploys. The URL returns 404 today.
   - Check it with `curl -s https://thethirdsourcers.com/.well-known/org.flathub.VerifiedApps.txt`, then click
     "Verify" on Flathub. If Cloudflare serves an HTML page or a redirect instead of the plain token, make sure the
     file is in the deployed output, not ignored as a dotfolder.

## Lint results (run in Docker, `ghcr.io/flathub/flatpak-builder-lint:latest`)

- `flatpak-builder-lint manifest com.thethirdsourcers.VisionCLI.yml`: no errors. Warnings:
  `finish-args-flatpak-spawn-access` and `finish-args-contains-both-x11-and-wayland`, both explained above.
- `appstreamcli validate --pedantic`: passes, with one pedantic note, `cid-contains-uppercase-letter`. That's
  fine: Flathub IDs keep their case, and renaming would change the app id.
- `flatpak-builder-lint appstream` (it checks URLs over the network): passes once the screenshots are live. Before the
  site deploy it reports `screenshot-image-not-found` for the three images.

## Not verified yet

- **No local `flatpak-builder` build.** The 26.08 runtime, SDK and Electron BaseApp are published on Flathub
  (checked with `flatpak remote-ls`), but they're several GB to download. Flathub's bot builds the PR anyway. To try
  it first on a Linux machine, see README.md "Build and try it locally".
- **The app inside the sandbox.** README.md lists the host tools not yet routed through `flatpak-spawn` (audio
  capture and playback, system TTS, xinput/xmodmap, terminal emulators). Test voice and speech in the built Flatpak.
- **The screenshots** are the real v0.11.1 Linux app (Xfce in Docker). The answer and the approval card were filled in
  by hand through the bubble's own renderer, because no assistant was signed in there.
