#!/bin/sh
# Adds one platform's files to the GitHub release for TAG, creating the release (notes from CHANGELOG.md) if this is
# the first platform released for it, and updates that platform's lines in SHA256SUMS.txt. The release workflows
# (release-mac/linux/windows.yml) each call it, in any order; they share a concurrency group per tag, so two never
# rewrite SHA256SUMS.txt at once.
#
#   scripts/release-upload.sh TAG REGEX DIR FILE...   e.g.  v0.11.0 '\.(dmg|zip)$' release VisionCLI-0.11.0-macos.dmg …
#
# REGEX matches this platform's file names (their old sums are replaced). Needs GH_TOKEN and GH_REPO.
set -eu
tag=$1 re=$2 dir=$3
shift 3

if ! gh release view "$tag" >/dev/null 2>&1; then
  version=${tag#v}
  # This version's section of the changelog (the lines under "## <version>").
  awk -v v="$version" '/^## /{p = ($2 == v); next} p' CHANGELOG.md > "$RUNNER_TEMP/notes.md" || true
  [ -s "$RUNNER_TEMP/notes.md" ] || echo "VisionCLI $version" > "$RUNNER_TEMP/notes.md"
  # Another platform may have created it a moment ago.
  gh release create "$tag" --verify-tag --title "$tag" --notes-file "$RUNNER_TEMP/notes.md" || gh release view "$tag" >/dev/null
fi

cd "$dir"
gh release download "$tag" -p SHA256SUMS.txt --clobber 2>/dev/null || : > SHA256SUMS.txt
grep -v -E "$re" SHA256SUMS.txt > sums.tmp || true
shasum -a 256 "$@" >> sums.tmp
mv sums.tmp SHA256SUMS.txt
cat SHA256SUMS.txt
gh release upload "$tag" "$@" SHA256SUMS.txt --clobber
