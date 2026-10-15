# Windows code signing with SignPath (free for open source)

SignPath Foundation (https://signpath.org) signs open-source Windows software for free with its own certificate
("SignPath Foundation" as the publisher). What it changes: the installer and the app show a verified publisher
instead of *Unknown publisher* in SmartScreen's "Windows protected your PC" and in UAC/properties dialogs, and
SmartScreen reputation builds up for the certificate across releases instead of starting over with every new
unsigned file. It is an OV certificate, so a brand-new release can still get the SmartScreen prompt until enough
people have downloaded it. Until it's set up the Windows build stays unsigned, as now.

## What the release workflow does

In the `build` job of `.github/workflows/release-windows.yml`, when the secret and the three variables below exist:

1. `package-release-win.ps1 -Stage unpacked` packs the app (`app/dist/win-unpacked`, or `win-arm64-unpacked`).
2. That folder is uploaded as a workflow artifact and sent to SignPath with artifact configuration **`app`**
   (`artifact-configuration.xml`): `VisionCLI.exe` and `resources/bin/vcli-win.exe` are signed.
3. `-Stage installer -Unpacked app/dist/signed-unpacked` builds the NSIS installer around the signed files.
4. The installer goes to SignPath with artifact configuration **`installer`** (`artifact-configuration-installer.xml`)
   and the signed one replaces it in `release/`.

Without them the job prints a notice and builds the unsigned installer exactly as before. The installer's embedded
uninstaller is not signed separately (electron-builder generates it inside the NSIS step).

## Applying (the owner, once)

1. Read the conditions: https://signpath.org/terms. The essentials: an OSI license (MIT: yes), a public repository,
   built on GitHub-hosted runners from that repository, no malware/PUA, a code-signing policy page on the project
   site, and a named team member who approves releases. VisionCLI.exe is Electron's prebuilt binary renamed and
   stamped by electron-builder: mention it in the application; SignPath signs Electron apps, but they decide.
2. Apply at https://signpath.org/apply (the form asks for the repository, the homepage
   https://visioncli.thethirdsourcers.com and contact visioncli@thethirdsourcers.com).
3. Add the code-signing policy text SignPath asks for to the site and README ("Free code signing provided by
   SignPath.io, certificate by SignPath Foundation", plus who approves releases).
4. Once accepted, in SignPath:
   - install the SignPath GitHub App on `thethirdsourcers/visioncli` (it checks that artifacts come from this repo's
     workflow runs),
   - create the project (slug, e.g. `visioncli`) with a trusted build system *GitHub.com*,
   - add two artifact configurations, slugs **`app`** and **`installer`**, with the XML files in this folder,
   - a signing policy (e.g. `release-signing`); SignPath Foundation's policies need a manual approval per request
     by a team member in the SignPath web app, so a release waits until someone approves it,
   - create a CI user and its API token, with submitter rights on the project.
5. In GitHub (Settings → Secrets and variables → Actions):
   ```sh
   gh secret set SIGNPATH_API_TOKEN -R thethirdsourcers/visioncli
   gh variable set SIGNPATH_ORGANIZATION_ID -R thethirdsourcers/visioncli --body <organization id>
   gh variable set SIGNPATH_PROJECT_SLUG -R thethirdsourcers/visioncli --body visioncli
   gh variable set SIGNPATH_SIGNING_POLICY_SLUG -R thethirdsourcers/visioncli --body release-signing
   ```

## Checking a signed file

```powershell
Get-AuthenticodeSignature .\VisionCLI-<version>-windows-x64.exe | Format-List
```
