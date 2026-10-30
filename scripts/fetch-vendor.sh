#!/usr/bin/env bash
# Download the browser libraries SkiffCode's UI uses (editor + terminal) into vendor/.
# Run automatically by install.sh when vendor/ isn't bundled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$HERE/vendor"
REGISTRY="${SKIFFCODE_NPM_REGISTRY:-https://registry.npmjs.org}"

MONACO=0.52.2
XTERM=5.5.0
FIT=0.10.0
LINKS=0.11.0
WEBGL=0.18.0
UNICODE11=0.8.0

fetch() { # url dest
  if command -v curl >/dev/null; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null; then wget -q -O "$2" "$1"
  else echo "curl or wget is required" >&2; exit 1; fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
get() { # package version → extracted dir
  local pkg="$1" ver="$2" name="${1##*/}"
  local url="$REGISTRY/$pkg/-/$name-$ver.tgz"
  mkdir -p "$tmp/$name"
  fetch "$url" "$tmp/$name.tgz"
  tar -xzf "$tmp/$name.tgz" -C "$tmp/$name"
  echo "$tmp/$name/package"
}

echo "Downloading editor (monaco-editor $MONACO) and terminal (xterm.js $XTERM)…"
rm -rf "$VENDOR.new"
mkdir -p "$VENDOR.new/monaco" "$VENDOR.new/xterm"
m="$(get monaco-editor "$MONACO")"
cp -r "$m/min/vs" "$VENDOR.new/monaco/vs"
cp "$m/LICENSE" "$VENDOR.new/monaco/LICENSE" 2>/dev/null || true
x="$(get @xterm/xterm "$XTERM")"
cp "$x/lib/xterm.js" "$x/css/xterm.css" "$VENDOR.new/xterm/"
cp "$x/LICENSE" "$VENDOR.new/xterm/LICENSE" 2>/dev/null || true
f="$(get @xterm/addon-fit "$FIT")";       cp "$f/lib/addon-fit.js" "$VENDOR.new/xterm/"
l="$(get @xterm/addon-web-links "$LINKS")"; cp "$l/lib/addon-web-links.js" "$VENDOR.new/xterm/"
w="$(get @xterm/addon-webgl "$WEBGL")";    cp "$w/lib/addon-webgl.js" "$VENDOR.new/xterm/"
u="$(get @xterm/addon-unicode11 "$UNICODE11")"; cp "$u/lib/addon-unicode11.js" "$VENDOR.new/xterm/"
rm -rf "$VENDOR"
mv "$VENDOR.new" "$VENDOR"
echo "$MONACO $XTERM" > "$VENDOR/VERSIONS"
echo "Done: $(du -sh "$VENDOR" | cut -f1) in $VENDOR"
