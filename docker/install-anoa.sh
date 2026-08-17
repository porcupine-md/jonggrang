#!/usr/bin/env bash
# Install the AnoA bundle used by Jonggrang agent images.
#
# This is intentionally vendored rather than fetched and piped to bash at build
# time. It resolves the latest AnoA release, then verifies the downloaded asset
# against the digest published by GitHub's Releases API before unpacking it.
set -euo pipefail

REPO='porcupine-md/anoa-browser'
PREFIX='/usr/local'

case "$(uname -m)" in
  x86_64|amd64) ASSET='anoa-linux-x86_64.tar.gz' ;;
  aarch64|arm64) ASSET='anoa-linux-aarch64.tar.gz' ;;
  *)
    echo "Unsupported AnoA architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ARCHIVE="$TMP_DIR/$ASSET"
RELEASE_JSON="$TMP_DIR/release.json"

curl --fail --location --silent --show-error --retry 3 \
  --output "$RELEASE_JSON" "https://api.github.com/repos/${REPO}/releases/latest"
ANOA_VERSION="$(jq -r '.tag_name // empty' "$RELEASE_JSON")"
SHA256="$(jq -r --arg asset "$ASSET" '.assets[] | select(.name == $asset) | .digest // empty' "$RELEASE_JSON" | sed -n 's/^sha256://p')"
[ -n "$ANOA_VERSION" ] || { echo 'AnoA release has no tag name' >&2; exit 1; }
[ -n "$SHA256" ] || { echo "AnoA release has no SHA-256 digest for ${ASSET}" >&2; exit 1; }

URL="https://github.com/${REPO}/releases/download/${ANOA_VERSION}/${ASSET}"
curl --fail --location --silent --show-error --retry 3 --output "$ARCHIVE" "$URL"
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | sha256sum --check --status

tar -xzf "$ARCHIVE" -C "$TMP_DIR"
test -x "$TMP_DIR/anoa/anoa.sh"

mkdir -p "$PREFIX/lib" "$PREFIX/bin"
mv "$TMP_DIR/anoa" "$PREFIX/lib/anoa"
ln -sfn "$PREFIX/lib/anoa/anoa.sh" "$PREFIX/bin/anoa"
"$PREFIX/bin/anoa" --version
