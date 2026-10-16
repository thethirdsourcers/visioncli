#!/bin/sh
# Builds the GitHub Pages site (https://visioncli.thethirdsourcers.com) into a folder: the product page for a
# release, CNAME, and, when a signing key is given, the apt and dnf repositories built from that release's
# .deb and .rpm files. Run by .github/workflows/site.yml; runs locally too (Debian/Ubuntu with apt-utils,
# createrepo-c and gnupg, plus an authenticated gh).
#   sh packaging/site/build.sh <tag> <out-dir>
# Environment: PACKAGES_GPG_PRIVATE_KEY (armored secret key; without it, no repositories) and the optional
# PACKAGES_GPG_PASSPHRASE. GH_REPO for gh (default thethirdsourcers/visioncli).
set -eu
TAG=$1
OUT=$2
DOMAIN=visioncli.thethirdsourcers.com
export GH_REPO="${GH_REPO:-thethirdsourcers/visioncli}"
here=$(dirname "$0")
VERSION=${TAG#v}
DL="https://github.com/$GH_REPO/releases/download/$TAG"

# Each platform is released on its own (release-mac/linux/windows.yml), so a release may not have every platform's
# files: each platform's links (and the apt/dnf repositories) use the newest release, up to TAG, that has them.
releases=$(gh release list --limit 30 --exclude-drafts --json tagName --jq '.[].tagName' 2>/dev/null || echo "$TAG")
newest_with() { # <file-name suffix> → tag
  past=no
  for t in $releases; do
    [ "$t" = "$TAG" ] && past=yes
    [ "$past" = yes ] || continue
    if gh release view "$t" --json assets --jq '.assets[].name' 2>/dev/null | grep -q -- "$1\$"; then echo "$t"; return; fi
  done
  echo "$TAG"
}
MAC_TAG=$(newest_with "-macos.dmg")
WIN_TAG=$(newest_with "-windows-x64.exe")
LIN_TAG=$(newest_with "-linux-x86_64.AppImage")
echo "Downloads: macOS $MAC_TAG, Windows $WIN_TAG, Linux $LIN_TAG"

rm -rf "$OUT"
mkdir -p "$OUT"
echo "$DOMAIN" > "$OUT/CNAME"
touch "$OUT/.nojekyll" # plain files: no Jekyll processing (it would hide dists/ entries starting with _ or .)
cp "$here/../../docs/logo.png" "$OUT/logo.png"
cp "$here/../../docs/brand/mark.svg" "$OUT/mark.svg"
cp "$here/privacy.html" "$OUT/privacy.html"

repos=no
if [ -n "${PACKAGES_GPG_PRIVATE_KEY:-}" ]; then
  GNUPGHOME=$(mktemp -d)
  export GNUPGHOME
  trap 'rm -rf "$GNUPGHOME"' EXIT
  printf '%s\n' "$PACKAGES_GPG_PRIVATE_KEY" | gpg --batch --quiet --import 2>/dev/null
  printf '%s' "${PACKAGES_GPG_PASSPHRASE:-}" > "$GNUPGHOME/passphrase"
  KEYID=$(gpg --batch --list-secret-keys --with-colons | awk -F: '/^sec/ { print $5; exit }')
  sign() { gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$GNUPGHOME/passphrase" --local-user "$KEYID" "$@"; }
  gpg --batch --armor --export "$KEYID" > "$OUT/public.key"

  mkdir -p "$OUT/pool/main" "$OUT/rpm"
  gh release download "$LIN_TAG" -p '*.deb' -D "$OUT/pool/main"
  # Releases before 0.10.5 have no .rpm files: then only the apt repository is built.
  gh release download "$LIN_TAG" -p '*.rpm' -D "$OUT/rpm" 2>/dev/null || echo "::notice::$LIN_TAG has no .rpm files: dnf repository skipped."
  # A git push rejects files over 100 MB, and gh-pages is a git branch.
  big=$(find "$OUT/pool" "$OUT/rpm" -type f -size +95M)
  if [ -n "$big" ]; then
    echo "::warning::Package repositories skipped: over GitHub's 100 MB file limit for gh-pages: $big"
    rm -rf "$OUT/pool" "$OUT/rpm" "$OUT/public.key"
  else
    # apt: dists/stable/main/binary-{amd64,arm64}, signed InRelease + Release.gpg.
    (
      cd "$OUT"
      # One scan, split per architecture (apt-ftparchive's own --arch filter returns nothing for these files).
      apt-ftparchive packages pool/main > Packages.all
      for arch in amd64 arm64; do
        d=dists/stable/main/binary-$arch
        mkdir -p "$d"
        awk -v RS= -v ORS='\n\n' -v want="$arch" '$0 ~ "\nArchitecture: (" want "|all)\n"' Packages.all > "$d/Packages"
        gzip -9kn "$d/Packages"
      done
      rm Packages.all
      apt-ftparchive \
        -o APT::FTPArchive::Release::Origin=VisionCLI -o APT::FTPArchive::Release::Label=VisionCLI \
        -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
        -o APT::FTPArchive::Release::Architectures="amd64 arm64" -o APT::FTPArchive::Release::Components=main \
        -o APT::FTPArchive::Release::Description="VisionCLI by Third Sourcers" \
        release dists/stable > Release.tmp
      mv Release.tmp dists/stable/Release
      sign --clearsign -o dists/stable/InRelease dists/stable/Release
      sign --detach-sign --armor -o dists/stable/Release.gpg dists/stable/Release
    )
    # dnf/zypper: repodata with a detached signature on repomd.xml (repo_gpgcheck), packages checked by gpgcheck
    # against the same key, so each .rpm is signed too.
    if ! ls "$OUT"/rpm/*.rpm >/dev/null 2>&1; then
      rm -rf "$OUT/rpm"
    elif command -v rpmsign >/dev/null 2>&1; then
      for f in "$OUT"/rpm/*.rpm; do
        rpmsign --addsign --define "__gpg $(command -v gpg)" --define "_gpg_name $KEYID" --define "_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback --passphrase-file $GNUPGHOME/passphrase" "$f" >/dev/null
      done
      pkgcheck=1
    else
      echo "::warning::rpmsign isn't installed: the .rpm files themselves are unsigned (gpgcheck=0); repomd.xml is signed."
      pkgcheck=0
    fi
    if [ -d "$OUT/rpm" ]; then
    createrepo_c --quiet "$OUT/rpm"
    sign --detach-sign --armor -o "$OUT/rpm/repodata/repomd.xml.asc" "$OUT/rpm/repodata/repomd.xml"
    cat > "$OUT/visioncli.repo" <<EOF
[visioncli]
name=VisionCLI
baseurl=https://$DOMAIN/rpm
enabled=1
gpgcheck=$pkgcheck
repo_gpgcheck=1
gpgkey=https://$DOMAIN/public.key
metadata_expire=6h
EOF
    fi
    repos=yes
  fi
else
  echo "::notice::Package repositories skipped: PACKAGES_GPG_PRIVATE_KEY isn't set (scripts/make-packages-key.sh). The site is published without them."
fi

# The page: this release's links; the repository instructions only when the repositories exist.
dl() { echo "https://github.com/$GH_REPO/releases/download/$1"; }
sed -e "s|@MAC_DL@|$(dl "$MAC_TAG")|g" -e "s|@MAC_VERSION@|${MAC_TAG#v}|g" \
    -e "s|@WIN_DL@|$(dl "$WIN_TAG")|g" -e "s|@WIN_VERSION@|${WIN_TAG#v}|g" \
    -e "s|@LIN_DL@|$(dl "$LIN_TAG")|g" -e "s|@LIN_VERSION@|${LIN_TAG#v}|g" \
    -e "s|@VERSION@|$VERSION|g" -e "s|@TAG@|$TAG|g" -e "s|@DL@|$DL|g" "$here/index.html" > "$OUT/index.html.tmp"
if [ "$repos" = no ]; then
  sed -i.bak '/<!-- repos -->/,/<!-- \/repos -->/d' "$OUT/index.html.tmp" && rm -f "$OUT/index.html.tmp.bak"
fi
mv "$OUT/index.html.tmp" "$OUT/index.html"
echo "Site for $TAG in $OUT (package repositories: $repos)"
