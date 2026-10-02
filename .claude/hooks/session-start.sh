#!/bin/bash
# Cloud sessions only: install the Node version in .nvmrc (the image defaults
# to an older one), put it on PATH for the session, and install dependencies.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# nvm.sh references unset variables, so relax -u while it runs.
set +u
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh" --no-use
nvm install --no-progress "$(cat .nvmrc)" >/dev/null
nvm use "$(cat .nvmrc)" >/dev/null
set -u

NODE_BIN="$(dirname "$(nvm which current)")"
export PATH="$NODE_BIN:$PATH"

# pnpm at the exact version package.json pins (packageManager).
PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"
if [ "$(pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ] || [ "$(command -v pnpm)" != "$NODE_BIN/pnpm" ]; then
  npm install -g --silent "pnpm@$PNPM_VERSION"
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

pnpm install --frozen-lockfile
