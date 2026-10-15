# Distribution

How VisionCLI reaches users beyond the GitHub release, which warning each channel removes, and the one-time steps
the owner takes to switch each one on. Everything here is free. Every job is wired into one of the per-platform
release workflows (`release-mac.yml`, `release-linux.yml`, `release-windows.yml`, plus `site.yml`) and **skips with a
notice** until its secret or variable exists, so nothing fails while a channel isn't set up yet.

## Releasing

Releases are started by hand, one platform at a time, so each release only uses the runners it needs:

1. Bump the version (`package.json`, `.claude-plugin/plugin.json`, `app/package.json`), add the CHANGELOG section,
   commit, then push the commit and the tag: `git tag v0.11.0 && git push origin main v0.11.0`. Pushing a tag
   doesn't build anything by itself.
2. In GitHub → Actions, run **Release macOS**, **Release Linux** and/or **Release Windows** with that tag, or from the
   terminal: `gh workflow run release-mac.yml -f tag=v0.11.0` (likewise `release-linux.yml`, `release-windows.yml`).
   The first one creates the GitHub release with the CHANGELOG notes; each adds its files and its lines in
   `SHA256SUMS.txt`.
3. Options per workflow: Linux and Windows can skip the arm64 build (`-f arm64=false`); Linux updates the website
   with its apt/dnf repositories (on by default) and the Snap Store; macOS updates Homebrew; Windows opens the winget
   update. macOS and Windows can rebuild the website too (`-f site=true`).

Each app only updates itself from a release that has its own platform's file, so releasing one platform first
doesn't affect the others.

Website and package repositories: **https://visioncli.thethirdsourcers.com** (GitHub Pages, `gh-pages` branch).
Contact: visioncli@thethirdsourcers.com. Publisher: Third Sourcers.

## Channels

| Channel | Users run | Automated in its release workflow | Removes | Switched on by |
| --- | --- | --- | --- | --- |
| GitHub release (today) | download `.dmg` / AppImage / `.deb` / `.rpm` / `.exe` | yes (existing jobs, plus `.rpm` and the unpacked `.tar.gz`) | nothing by itself | already on |
| Build provenance | `gh attestation verify <file> -R thethirdsourcers/visioncli` | yes, every release file | lets anyone prove a file was built by this repo's workflow from a given commit (no OS warning changes) | the repo being public (done) |
| apt repository (Debian/Ubuntu) | `apt install visioncli-linux` | yes (`site` job) | manual `.deb` downloads and updates; packages are verified against our key | step 3 |
| dnf/zypper repository (Fedora, RHEL, openSUSE) | `dnf install visioncli-linux` | yes (`site` job) | same, for `.rpm` | step 3 |
| Website | https://visioncli.thethirdsourcers.com | yes (`site` job) | — | step 2 |
| SignPath (Windows signing) | the same `.exe` | yes (in the `windows` job) | SmartScreen's and UAC's *Unknown publisher*; reputation builds per certificate instead of per file | step 4 |
| Microsoft Store | the Microsoft Store app | builds the `.msix` (upload by hand per release) | SmartScreen entirely (Microsoft signs the package); Store updates | step 5 |
| Snap Store | `sudo snap install visioncli --classic` | yes (`snap` job) | manual downloads and updates on Ubuntu and other snap systems | step 6 |
| Flathub | `flatpak install flathub com.thethirdsourcers.VisionCLI` | Flathub's bot opens the update PR (`x-checker-data`) | manual downloads; GNOME Software / KDE Discover listing | step 7 |
| Homebrew tap (macOS) | `brew install --cask thethirdsourcers/tap/visioncli` | yes (`homebrew` job) | manual download/drag to Applications; **not** Gatekeeper's warning | step 8 |
| winget | `winget install TheThirdSourcers.VisionCLI` | yes (`winget` job), after the first version | manual downloads and updates (`winget upgrade`); SmartScreen still applies to unsigned installers | step 9 |

What each OS shows today, and what changes it:

- **macOS**: Gatekeeper blocks the first launch ("Apple could not verify 'VisionCLI' is free of malware…"). The user
  allows it once in System Settings → Privacy & Security → **Open Anyway**, or runs
  `xattr -dr com.apple.quarantine /Applications/VisionCLI.app`. Homebrew doesn't change this (it quarantines downloads
  too, and deprecated `--no-quarantine`). **Only the Apple Developer Program ($99/year: a Developer ID certificate plus
  notarization) removes this warning**; there is no free route. The official homebrew/cask repository also needs it
  (casks failing Gatekeeper are disabled there since September 2026), which is why the cask lives in our own tap.
- **Windows**: SmartScreen shows "Windows protected your PC" with *Unknown publisher* for the unsigned installer.
  SignPath signing replaces *Unknown publisher* with a verified one and builds reputation; the Store avoids SmartScreen
  altogether.
- **Linux**: no OS warning. The repositories, Flathub and the Snap Store bring updates through the system's own tools.

## What's automated where

- `release-mac.yml`: `build` (universal `.dmg`/`.zip`, signed), `publish` (uploads, provenance), `homebrew`, `site`
  (optional).
- `release-linux.yml`: `build` (AppImage, `.deb`, `.rpm` and `VisionCLI-<v>-linux-{x64,arm64}.tar.gz`, the unpacked
  app for Flatpak and snap; arm64 optional), `publish`, `site` (the apt/dnf repositories), `snap`.
- `release-windows.yml`: `build` (NSIS installers, optional SignPath signing and the optional Store `.msix`; arm64
  optional), `publish`, `winget`, `site` (optional).
- Every `publish` runs `scripts/release-upload.sh` (creates the release if needed, merges `SHA256SUMS.txt`) in one
  concurrency group per tag, then `actions/attest-build-provenance@v2` (public repositories only).
- `site.yml` (also on `release: published` and by hand): `packaging/site/build.sh` builds the page, `CNAME`,
  `public.key`, the apt repository (`dists/stable/main/binary-{amd64,arm64}` with `Packages(.gz)`, `Release`,
  `InRelease`, `Release.gpg`, built with `apt-ftparchive` from the release's `.deb` files), the rpm repository
  (`rpm/` with `createrepo_c` metadata, signed `repomd.xml.asc` and signed packages) and `visioncli.repo`, then
  force-pushes a single commit to `gh-pages`. Without the signing key the page is published without the repositories
  (and without their instructions). It does nothing while the repository is private.

| Secret / variable | Kind | Used by |
| --- | --- | --- |
| `PACKAGES_GPG_PRIVATE_KEY`, `PACKAGES_GPG_PASSPHRASE` (optional) | secrets | site: signing the apt/rpm repositories |
| `SIGNPATH_API_TOKEN` | secret | windows: SignPath |
| `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG` | variables | windows: SignPath |
| `MS_STORE_IDENTITY_NAME`, `MS_STORE_PUBLISHER`, `MS_STORE_PUBLISHER_DISPLAY_NAME` | variables | windows: the `.msix` |
| `SNAPCRAFT_STORE_CREDENTIALS` | secret | snap |
| `HOMEBREW_TAP_TOKEN` | secret | homebrew |
| `WINGET_TOKEN` | secret | winget |

## The owner's one-time steps, in order

1. **Make the repository public.** Done.
2. **GitHub Pages and the domain.**
   - DNS for thethirdsourcers.com: a `CNAME` record `visioncli` → `thethirdsourcers.github.io`.
   - Run the *Site* workflow once (Actions → Site → Run workflow) so the `gh-pages` branch exists.
   - Repository Settings → Pages: *Deploy from a branch*, branch `gh-pages`, folder `/ (root)`; custom domain
     `visioncli.thethirdsourcers.com` (the branch's `CNAME` file already says so); once the certificate is issued,
     tick **Enforce HTTPS**.
   - Optionally verify thethirdsourcers.com for the organization (Settings → Pages → Verified domains) so nobody else
     can claim the subdomain.
3. **The repository signing key.** On a trusted machine: `sh scripts/make-packages-key.sh` (a dedicated ed25519 key in
   a throwaway keyring). It prints the `gh secret set PACKAGES_GPG_PRIVATE_KEY` (and passphrase) commands; run them,
   keep `packages-key/private.asc` offline, then re-run the Site workflow. Note: very old rpm (RHEL 8's rpm 4.14)
   can't verify ed25519 signatures; Fedora, RHEL 9+, openSUSE and every current Debian/Ubuntu can.
4. **SignPath.** Apply at https://signpath.org/apply and set it up: `packaging/windows/SIGNPATH.md`.
5. **Partner Center.** Free individual developer account, reserve "VisionCLI", set the three `MS_STORE_*` variables,
   submit the `.msix` files: `packaging/windows/STORE.md` (also lists precisely what differs in the MSIX build).
6. **Snap classic request.** Register `visioncli`, ask for classic confinement in the forum, add
   `SNAPCRAFT_STORE_CREDENTIALS`: `packaging/snap/README.md`.
7. **Flathub PR.** Real screenshots in the metainfo, the release's sha256s in the manifest, then the pull request to
   `flathub/flathub`: `packaging/flatpak/README.md` (with the permissions reviewers will ask about).
8. **Homebrew tap.** Create `thethirdsourcers/homebrew-tap` and a token limited to it as `HOMEBREW_TAP_TOKEN`:
   `packaging/homebrew/README.md`.
9. **winget.** Submit the first version from `packaging/winget/` by hand, then add `WINGET_TOKEN` for the automatic
   updates: `packaging/winget/README.md`.

## Not possible for free, or not for this app

- **macOS notarization**: needs the paid Apple Developer Program. Until then every macOS channel (download, Homebrew)
  shows Gatekeeper's prompt once, and the official homebrew/cask repository is closed to the app.
- **Strict snap confinement / a tight Flatpak sandbox**: the app runs the user's host CLIs, reads `/dev/input` and drives
  other apps, so the snap needs classic confinement (a manual Store approval) and the Flatpak needs
  `org.freedesktop.Flatpak` (host commands), `--device=all` and the home folder. Reviewers may refuse; the READMEs give
  the reasons to put to them.
- **The Store's MSIX** keeps the app's settings in the package's private AppData copy, so the MCP server is only
  reachable from CLIs that VisionCLI itself starts. People who use VisionCLI's tools from their own terminals should
  use the NSIS installer (`packaging/windows/STORE.md`).
- **Provenance attestations** need a public repository on GitHub's free plans (the jobs check it).
- **SignPath** is free only for OSI-licensed, public projects that it accepts after review, and each signing request
  waits for a manual approval in SignPath.
