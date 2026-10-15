# VisionCLI on Homebrew (macOS)

`visioncli.rb` is a cask for our own tap, **thethirdsourcers/homebrew-tap**:

```sh
brew install --cask thethirdsourcers/tap/visioncli
```

The `homebrew` job in `.github/workflows/release-mac.yml` downloads each release's `.dmg`, fills in `version` and
`sha256`, and pushes `Casks/visioncli.rb` to the tap. Without the secret `HOMEBREW_TAP_TOKEN` it prints a notice and
stops.

## Why a tap and not homebrew/cask

Homebrew 5.0 (November 2025) deprecated casks without code signing and announced it would disable every cask in
the official Homebrew/homebrew-cask repository that fails Gatekeeper checks from September 2026; it also deprecated
the `--no-quarantine` flag ("Homebrew does not wish to easily provide circumvention to macOS security features",
https://brew.sh/2025/11/12/homebrew-5.0.0/). VisionCLI is signed with its own stable certificate, not an Apple
Developer ID, and isn't notarized, so it fails Gatekeeper and can't go into the official repository. Third-party
taps aren't reviewed by Homebrew, so ours works.

## What users see

Homebrew downloads the `.dmg` with the quarantine attribute and installs `/Applications/VisionCLI.app` normally.
The first launch is then blocked by Gatekeeper ("Apple could not verify 'VisionCLI' is free of malware…"); on macOS 15
and later the old right-click → Open shortcut no longer bypasses it. The user allows it once, either in
**System Settings → Privacy & Security → Open Anyway**, or with:

```sh
xattr -dr com.apple.quarantine /Applications/VisionCLI.app
```

The cask prints this as a caveat. Later updates (the app's own updater, or `brew upgrade`) don't ask again. Only
the Apple Developer Program ($99/year: a Developer ID certificate plus notarization) removes the prompt.

## The owner's steps (once)

1. Create the public repository `thethirdsourcers/homebrew-tap` (the `homebrew-` prefix is what makes
   `thethirdsourcers/tap` work), with a `Casks/` folder and a short README.
2. Create a fine-grained personal access token limited to that repository with **Contents: Read and write**.
3. `gh secret set HOMEBREW_TAP_TOKEN -R thethirdsourcers/visioncli` and paste it.
4. The next `v*` release writes the cask. To publish the current version right away, put `visioncli.rb` into the tap
   by hand with the `.dmg`'s sha256 from `SHA256SUMS.txt`, then check it:
   `brew install --cask thethirdsourcers/tap/visioncli && brew audit --cask thethirdsourcers/tap/visioncli`.
