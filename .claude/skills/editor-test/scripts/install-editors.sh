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

# Stops the run unless a download has the checksum its publisher lists for it. Both editors
# are fetched over HTTPS and then executed, so a truncated or swapped file must not get
# as far as being unpacked.
verify_sha256() {
  local file=$1 expected=$2 actual
  actual="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    echo "checksum mismatch for $file: expected '${expected:-none published}', got $actual" >&2
    rm -f "$file"
    exit 1
  fi
}

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
  # the update service answers with the download URL and its SHA-256
  local api="https://update.code.visualstudio.com/api" release url sha256
  if [ -n "${VSCODE_VERSION:-}" ]; then
    release="$(curl -fsSL --retry 3 "$api/versions/$VSCODE_VERSION/linux-$CODE_ARCH/stable")"
  else
    release="$(curl -fsSL --retry 3 "$api/update/linux-$CODE_ARCH/stable/latest")"
  fi
  url="$(node -p 'JSON.parse(process.argv[1]).url' "$release")"
  sha256="$(node -p 'JSON.parse(process.argv[1]).sha256hash' "$release")"
  echo "vscode: downloading $(node -p 'JSON.parse(process.argv[1]).name' "$release") for linux-$CODE_ARCH"
  curl -fsSL --retry 3 -o "$DOWNLOADS/vscode.tar.gz" "$url"
  verify_sha256 "$DOWNLOADS/vscode.tar.gz" "$sha256"
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
  local base="https://download.vscodium.com/debs" build filename sha256
  # one line per build: version, file, and the SHA-256 the index lists for that file
  build="$(
    curl -fsSL --retry 3 "$base/dists/vscodium/main/binary-$DEB_ARCH/Packages" |
      awk '
        /^Package: /  { pkg = $2 }
        /^Version: /  { ver = $2 }
        /^Filename: / { file = $2 }
        /^SHA256: /   { sum = $2 }
        /^$/          { if (pkg == "codium") print ver, file, sum; pkg = ver = file = sum = "" }
        END           { if (pkg == "codium") print ver, file, sum }
      ' |
      { if [ -n "${VSCODIUM_VERSION:-}" ]; then grep "^$VSCODIUM_VERSION " || true; else sort -V; fi; } |
      tail -1
  )"
  filename="$(echo "$build" | cut -d' ' -f2)"
  sha256="$(echo "$build" | cut -d' ' -f3)"
  if [ -z "$filename" ]; then
    echo "vscodium: no build ${VSCODIUM_VERSION:-} found in the apt index for $DEB_ARCH" >&2
    exit 1
  fi
  echo "vscodium: downloading $filename"
  curl -fsSL --retry 3 -o "$DOWNLOADS/codium.deb" "$base/$filename"
  verify_sha256 "$DOWNLOADS/codium.deb" "$sha256"
  fresh_dir "$dest"
  dpkg-deb -x "$DOWNLOADS/codium.deb" "$dest"
  rm -f "$DOWNLOADS/codium.deb"
  node -p "require('$dest/usr/share/codium/resources/app/package.json').version" >"$dest/VERSION"
  echo "vscodium: unpacked $(cat "$dest/VERSION")"
}

install_vscode
install_vscodium
