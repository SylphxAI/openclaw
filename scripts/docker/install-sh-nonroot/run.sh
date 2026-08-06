#!/usr/bin/env bash
set -euo pipefail

INSTALL_URL="${OPENCLAW_INSTALL_URL:-https://openclaw.bot/install.sh}"
DEFAULT_PACKAGE="openclaw"
PACKAGE_NAME="${OPENCLAW_INSTALL_PACKAGE:-$DEFAULT_PACKAGE}"

echo "==> Pre-flight: ensure git absent"
if command -v git >/dev/null; then
  echo "git is present unexpectedly" >&2
  exit 1
fi

echo "==> Run installer (non-root user)"
curl -fsSL "$INSTALL_URL" | bash

# Ensure PATH picks up user npm prefix
export PATH="$HOME/.npm-global/bin:$PATH"

echo "==> Verify git installed"
command -v git >/dev/null

EXPECTED_VERSION="${OPENCLAW_INSTALL_EXPECT_VERSION:-}"
if [[ -n "$EXPECTED_VERSION" ]]; then
  LATEST_VERSION="$EXPECTED_VERSION"
else
  LATEST_VERSION="$(npm view "$PACKAGE_NAME" version)"
fi
CLI_NAME="$PACKAGE_NAME"
CMD_PATH="$(command -v "$CLI_NAME" || true)"
if [[ -z "$CMD_PATH" && -x "$HOME/.npm-global/bin/$PACKAGE_NAME" ]]; then
  CLI_NAME="$PACKAGE_NAME"
  CMD_PATH="$HOME/.npm-global/bin/$PACKAGE_NAME"
fi
if [[ -z "$CMD_PATH" ]]; then
  echo "$PACKAGE_NAME is not on PATH" >&2
  exit 1
fi
echo "==> Verify CLI installed: $CLI_NAME"
INSTALLED_VERSION="$("$CMD_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"

echo "cli=$CLI_NAME installed=$INSTALLED_VERSION expected=$LATEST_VERSION"
# The CLI may decorate its version with a product name and commit suffix
# (for example, "OpenClaw 2026.7.1-2 (sha)"). Validate the exact npm
# version token rather than requiring the human-readable output to be bare.
if [[ "$INSTALLED_VERSION" != "$LATEST_VERSION" && "$INSTALLED_VERSION" != *"$LATEST_VERSION"* && "$INSTALLED_VERSION" != *"$LATEST_VERSION "* ]]; then
  echo "ERROR: expected ${CLI_NAME}@${LATEST_VERSION}, got ${CLI_NAME}@${INSTALLED_VERSION}" >&2
  exit 1
fi

echo "==> Sanity: CLI runs"
"$CMD_PATH" --help >/dev/null

echo "OK"
