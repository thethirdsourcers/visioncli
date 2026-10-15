# Builds the Windows release for one arch: release/VisionCLI-<version>-windows-{x64,arm64}.exe, a per-user NSIS
# installer (no admin). The version is the repo's (package.json at the root), so a tag only needs the root bump.
#   pwsh app/scripts/package-release-win.ps1 [-Arch x64|arm64]     (default: this machine's arch)
# arm64 builds fine on an x64 machine (electron-builder fetches the arm64 Electron; the C# helper is AnyCPU).
# Stages, so CI can code-sign the app's exes between packing and the installer (SignPath, release-windows.yml):
#   -Stage all        (default) the installer, as one step
#   -Stage unpacked   only app/dist/win-unpacked (win-arm64-unpacked for arm64)
#   -Stage installer  the installer from an already packed folder (-Unpacked <dir>, e.g. the signed copy)
#   -Stage store      the Microsoft Store .msix from the packed folder; needs MS_STORE_IDENTITY_NAME,
#                     MS_STORE_PUBLISHER and MS_STORE_PUBLISHER_DISPLAY_NAME (Partner Center > Product identity)
param(
  [ValidateSet("x64", "arm64")]
  [string]$Arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }),
  [ValidateSet("all", "unpacked", "installer", "store")]
  [string]$Stage = "all",
  [string]$Unpacked = ""
)
$ErrorActionPreference = "Stop"
function Check([string]$what) { if ($LASTEXITCODE) { throw "$what failed (exit code $LASTEXITCODE)" } }

Set-Location (Join-Path $PSScriptRoot "..\..")
$version = node -p "require('./package.json').version"; Check "reading the version"
$out = "release"
New-Item -ItemType Directory -Force $out | Out-Null

$unpackedName = if ($Arch -eq "x64") { "win-unpacked" } else { "win-$Arch-unpacked" } # electron-builder's naming
if (-not $Unpacked) { $Unpacked = "app/dist/$unpackedName" }
$Unpacked = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Unpacked))

if ($Stage -eq "installer" -or $Stage -eq "store") {
  if (-not (Test-Path (Join-Path $Unpacked "VisionCLI.exe"))) { throw "$Unpacked has no VisionCLI.exe: run -Stage unpacked first" }
  Set-Location app
  npm pkg set "version=$version"; Check "npm pkg set"
  if ($Stage -eq "installer") {
    npx electron-builder --win nsis "--$Arch" --prepackaged $Unpacked --publish never; Check "electron-builder (nsis)"
    Copy-Item "dist/VisionCLI-$version-windows-$Arch.exe" "../$out/"
  } else {
    foreach ($v in "MS_STORE_IDENTITY_NAME", "MS_STORE_PUBLISHER", "MS_STORE_PUBLISHER_DISPLAY_NAME") {
      if (-not [Environment]::GetEnvironmentVariable($v)) { throw "$v isn't set (Partner Center > Product identity)" }
    }
    # Unsigned: the Store signs the package when it's submitted.
    npx electron-builder --win appx "--$Arch" --prepackaged $Unpacked --publish never `
      "-c.appx.identityName=$env:MS_STORE_IDENTITY_NAME" "-c.appx.publisher=$env:MS_STORE_PUBLISHER" `
      "-c.appx.publisherDisplayName=$env:MS_STORE_PUBLISHER_DISPLAY_NAME"; Check "electron-builder (appx)"
    Copy-Item "dist/VisionCLI-$version-windows-$Arch.msix" "../$out/"
  }
  Set-Location ..
  Get-ChildItem $out | Format-Table Name, Length
  exit 0
}

npm ci --no-audit --no-fund --loglevel=error; Check "npm ci (MCP server)" # build/server comes from ../src

# The native helper (vcli-win.exe, .NET Framework 4.8) lands in app/resources/bin.
if (Test-Path app/native/windows/build.sh) {
  # Git's bash, not System32\bash.exe (that one is WSL).
  $bash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
  if (-not (Test-Path $bash)) { $bash = "bash" }
  & $bash app/native/windows/build.sh; Check "building vcli-win.exe"
} else {
  throw "app/native/windows/build.sh is missing: the installer needs vcli-win.exe"
}
if (-not (Test-Path app/resources/bin/vcli-win.exe)) { throw "app/resources/bin/vcli-win.exe wasn't built" }

# The Visual C++ runtime DLLs whisper.cpp needs (redistributable), from this machine's System32. They must match the
# target arch: build each arch on its own runner (windows-latest = x64, windows-11-arm = arm64).
$machine = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$vc = "app/resources/win32/vcruntime/$Arch"
New-Item -ItemType Directory -Force $vc | Out-Null
if ($machine -eq $Arch) {
  foreach ($f in "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll") { Copy-Item (Join-Path $env:WINDIR "System32\$f") $vc -ErrorAction Stop }
} else {
  Write-Warning "Building ${Arch} on ${machine}: no app-local VC++ runtime (Whisper then needs Microsoft's redistributable)."
}

Set-Location app
npm ci --no-audit --no-fund --loglevel=error; Check "npm ci (app)"
npm pkg set "version=$version"; Check "npm pkg set" # no-op when app/package.json already matches
node build.mjs; Check "node build.mjs"
if ($Stage -eq "unpacked") {
  npx electron-builder --win dir "--$Arch" --publish never; Check "electron-builder (dir)"
  Set-Location ..
  Write-Output "Packed app: $Unpacked"
  exit 0
}
npx electron-builder --win nsis "--$Arch" --publish never; Check "electron-builder"
Copy-Item "dist/VisionCLI-$version-windows-$Arch.exe" "../$out/"
Set-Location ..
Write-Output "Release files:"
Get-ChildItem $out | Format-Table Name, Length
