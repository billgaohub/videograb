#!/usr/bin/env bash
# Build release zips for Chrome and Firefox from this repo.
# Chrome zip: manifest.json at root (required by the Chrome Web Store and
# for "Load unpacked" the repo root itself can be used directly).
# Firefox zip: uses firefox/manifest.json, adds firefox-bridge.js, and
# drops offscreen.html (Firefox has no Offscreen API; the engine runs in
# the background page instead — see firefox/firefox-bridge.js).
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
OUT="../release"
mkdir -p "$OUT"

COMMON_FILES=(
  background.js content.js inject.js
  popup.html popup.css popup.js
  offscreen.js mux.min.js
  LICENSE THIRD-PARTY-NOTICES.md
)

stage() {
  local dir="$1"
  rm -rf "$dir"; mkdir -p "$dir/icons"
  for f in "${COMMON_FILES[@]}"; do cp "$f" "$dir/"; done
  cp icons/*.png "$dir/icons/"
}

# --- Chrome ---
stage ".build-chrome"
cp manifest.json offscreen.html ".build-chrome/"
(cd ".build-chrome" && zip -qr "../$OUT/videograb-chrome-v$VERSION.zip" .)
rm -rf ".build-chrome"

# --- Firefox ---
stage ".build-firefox"
cp firefox/manifest.json ".build-firefox/manifest.json"
cp firefox/firefox-bridge.js ".build-firefox/"
(cd ".build-firefox" && zip -qr "../$OUT/videograb-firefox-v$VERSION.zip" .)
rm -rf ".build-firefox"

echo "Built:"
ls -la "$OUT"/videograb-*-v"$VERSION".zip
