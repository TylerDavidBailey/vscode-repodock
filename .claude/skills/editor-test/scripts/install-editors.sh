#!/usr/bin/env bash
# Downloads VS Code and VSCodium into the work dir and unpacks them, without installing
# anything system-wide. Re-running skips an editor that is already unpacked; pass --force
# to fetch it again (the way to move to a newer release).
#
#   VSCODE_VERSION    a release such as 1.96.0   (default: latest stable)
#   VSCODIUM_VERSION  a release such as 1.96.0.24347 (default: newest in the apt index)
set -euo pipefail

E2E_DIR="${REPODOCK_E2E_DIR:-/tmp/repodock-e2e}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

case "$(uname -m)" in
  x86_64) CODE_ARCH=x64 DEB_ARCH=amd64 ;;
  aarch64 | arm64) CODE_ARCH=arm64 DEB_ARCH=arm64 ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

EDITORS="$E2E_DIR/editors"
DOWNLOADS="$E2E_DIR/downloads"
mkdir -p "$EDITORS" "$DOWNLOADS"

# Each archive is unpacked into its own freshly created directory, never over an old one,
# so a half-finished earlier run cannot leave a mix of two versions behind.
fresh_dir() {
  case "$1" in
    "$EDITORS"/*) rm -rf "$1" && mkdir -p "$1" ;;
    *)
      echo "refusing to clear $1: not inside $EDITORS" >&2
      exit 1
      ;;
  esac
}

install_vscode() {
  local dest="$EDITORS/vscode" binary="$EDITORS/vscode/VSCode-linux-$CODE_ARCH/code"
  if [ -x "$binary" ] && [ "$FORCE" = 0 ]; then
    echo "vscode: already unpacked ($(cat "$dest/VERSION"))"
    return
  fi
  echo "vscode: downloading ${VSCODE_VERSION:-latest} for linux-$CODE_ARCH"
  curl -fsSL --retry 3 -o "$DOWNLOADS/vscode.tar.gz" \
    "https://update.code.visualstudio.com/${VSCODE_VERSION:-latest}/linux-$CODE_ARCH/stable"
  fresh_dir "$dest"
  tar -xzf "$DOWNLOADS/vscode.tar.gz" -C "$dest"
  rm -f "$DOWNLOADS/vscode.tar.gz"
  node -p "require('$dest/VSCode-linux-$CODE_ARCH/resources/app/package.json').version" >"$dest/VERSION"
  echo "vscode: unpacked $(cat "$dest/VERSION")"
}

install_vscodium() {
  local dest="$EDITORS/vscodium" binary="$EDITORS/vscodium/usr/share/codium/codium"
  if [ -x "$binary" ] && [ "$FORCE" = 0 ]; then
    echo "vscodium: already unpacked ($(cat "$dest/VERSION"))"
    return
  fi
  # VSCodium's GitHub releases are out of reach in a cloud session, whose GitHub access is
  # scoped to this repository. Its apt repository is plain HTTPS and carries the same builds.
  local base="https://download.vscodium.com/debs" filename
  filename="$(
    curl -fsSL --retry 3 "$base/dists/vscodium/main/binary-$DEB_ARCH/Packages" |
      awk '/^Package: /{pkg=$2} /^Version: /{ver=$2} /^Filename: /{if (pkg=="codium") print ver, $2}' |
      { if [ -n "${VSCODIUM_VERSION:-}" ]; then grep "^$VSCODIUM_VERSION " || true; else sort -V; fi; } |
      tail -1 | cut -d' ' -f2
  )"
  if [ -z "$filename" ]; then
    echo "vscodium: no build ${VSCODIUM_VERSION:-} found in the apt index for $DEB_ARCH" >&2
    exit 1
  fi
  echo "vscodium: downloading $filename"
  curl -fsSL --retry 3 -o "$DOWNLOADS/codium.deb" "$base/$filename"
  fresh_dir "$dest"
  dpkg-deb -x "$DOWNLOADS/codium.deb" "$dest"
  rm -f "$DOWNLOADS/codium.deb"
  node -p "require('$dest/usr/share/codium/resources/app/package.json').version" >"$dest/VERSION"
  echo "vscodium: unpacked $(cat "$dest/VERSION")"
}

install_vscode
install_vscodium
