#!/bin/bash
# =============================================================================
# Capture Package State — run periodically to snapshot installed packages
# =============================================================================
# Diffs current apt packages against base image snapshot, captures pip --user.
# npm/bun globals live in overlay or HOME — no capture needed.
# =============================================================================
set -euo pipefail

STATE_DIR="/data/package-state"
BASE_APT="/app/.base-apt-packages"

mkdir -p "$STATE_DIR"

# --- apt packages: diff against base image ---
if [ -f "$BASE_APT" ]; then
  CURRENT=$(mktemp)
  apt-mark showmanual | sort > "$CURRENT"
  # Packages in current but not in base = user-installed
  comm -23 "$CURRENT" "$BASE_APT" > "$STATE_DIR/apt.txt.tmp"
  mv "$STATE_DIR/apt.txt.tmp" "$STATE_DIR/apt.txt"
  rm -f "$CURRENT"
  COUNT=$(wc -l < "$STATE_DIR/apt.txt")
  echo "[capture-state] apt: $COUNT user-installed packages captured"
else
  echo "[capture-state] No base apt snapshot at $BASE_APT — skipping apt capture"
fi

# --- pip --user packages ---
if command -v pip3 >/dev/null 2>&1; then
  pip3 list --user --format=freeze 2>/dev/null > "$STATE_DIR/pip.txt.tmp" || true
  mv "$STATE_DIR/pip.txt.tmp" "$STATE_DIR/pip.txt"
  COUNT=$(wc -l < "$STATE_DIR/pip.txt")
  echo "[capture-state] pip: $COUNT user packages captured"
fi
