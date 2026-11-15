#!/usr/bin/env bash
# Downloads the newest version of an open-source app from F-Droid.
#
# Usage: scripts/get-app.sh <package-id>
#   The package id is the last part of the app's F-Droid web address:
#   https://f-droid.org/packages/org.fossify.math/  ->  org.fossify.math
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="${1:-}"

if ! printf '%s' "$PKG" | grep -Eq '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$'; then
  echo "Usage: scripts/get-app.sh <package-id>   (for example: org.fossify.math)" >&2
  exit 1
fi

PAGE="https://f-droid.org/packages/$PKG/"
html="$(curl -fsSL "$PAGE")" || { echo "❌ Couldn't open $PAGE. Is the package id right, and can this session reach f-droid.org?" >&2; exit 1; }

# Pick the newest build: the highest version number in the download links.
url="$(printf '%s' "$html" \
  | grep -oE "https://f-droid.org/repo/${PKG//./\\.}_[0-9]+\.apk" \
  | sed -E 's/.*_([0-9]+)\.apk$/\1 &/' | sort -u -n | tail -1 | cut -d' ' -f2 || true)"
[ -n "$url" ] || { echo "❌ No downloadable app file found on $PAGE." >&2; exit 1; }

mkdir -p "$ROOT/apps"
dest="$ROOT/apps/$(basename "$url")"
curl -fsSL -o "$dest.part" "$url" || { rm -f "$dest.part"; echo "❌ Download failed: $url" >&2; exit 1; }

# An Android app file is a zip archive, so it starts with the letters "PK".
if [ "$(head -c 2 "$dest.part")" != "PK" ]; then
  rm -f "$dest.part"
  echo "❌ That download isn't an Android app file, so it was deleted." >&2
  exit 1
fi
mv "$dest.part" "$dest"

if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$dest" | cut -d' ' -f1)"; else sum="$(shasum -a 256 "$dest" | cut -d' ' -f1)"; fi
echo "✅ Saved $dest"
echo "   From:        $url"
echo "   Fingerprint: $sum"

# When run by the GitHub "Run" button, hand the file's location to the next step.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "file=$dest"; echo "url=$url"; } >> "$GITHUB_OUTPUT"
fi
