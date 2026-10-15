# VisionCLI in the Snap Store

`snapcraft.yaml` repackages the release's unpacked app (`VisionCLI-<version>-linux-{x64,arm64}.tar.gz`) on core24
with **classic** confinement. The `snap` job in `.github/workflows/release-linux.yml` builds it on an x64 and an arm64
runner and publishes it to the `stable` channel when the secret `SNAPCRAFT_STORE_CREDENTIALS` exists; without it the
job prints a notice and stops.

## Why classic

VisionCLI runs the user's own `claude` / `agy` / `gemini` CLIs (their installs and sign-ins), `tmux` and desktop tools
(`xdotool`, `wmctrl`, `maim`, `grim`), reads the keyboard from `/dev/input`, captures the whole screen and drives other
apps through AT-SPI. Strict confinement has no interfaces for running arbitrary host programs, so it fits the
"terminal emulators, IDEs and developer tools" category the Snap Store grants classic to, but only after a manual
review.

## One-time steps (the owner)

1. Create an Ubuntu One account and sign in at https://snapcraft.io (free).
2. Register the name: `snapcraft register visioncli` (or on snapcraft.io → *Register a snap name*).
3. Ask for classic confinement: post in the forum's **store-requests** category
   (https://forum.snapcraft.io/c/store-requests/19), title "Classic confinement request: visioncli", with:
   - what it is (an AI co-assistant for developers that drives the user's own CLIs and desktop),
   - why strict can't work (the list above: host CLIs, `/dev/input`, other apps' windows),
   - the source (https://github.com/thethirdsourcers/visioncli) and this `snapcraft.yaml`.
   A reviewer votes and the publisher is vetted; this usually takes a few days to weeks. Uploads stay in manual
   review until it's granted.
4. Make the CI credential (it can only upload and release this snap):
   ```sh
   snapcraft export-login --snaps=visioncli --acls package_access,package_push,package_update,package_release credentials.txt
   gh secret set SNAPCRAFT_STORE_CREDENTIALS -R thethirdsourcers/visioncli < credentials.txt
   rm credentials.txt
   ```
5. The next `v*` tag publishes it. Users then install with `sudo snap install visioncli --classic`.

## Building locally

```sh
cp ../../docs/logo.png visioncli.png
sed -i "s/@VERSION@/0.10.4/g" snapcraft.yaml   # the version you want to package (don't commit this)
snapcraft pack
sudo snap install --classic --dangerous visioncli_*.snap
```

The MCP server is `visioncli.mcp` in the snap; the app's `~/.local/bin/visioncli-mcp` also finds
`/snap/visioncli/current`. Hold-to-talk still needs the user in the `input` group, as with the .deb.
