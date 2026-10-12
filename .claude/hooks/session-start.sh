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

# Flutter for apps/flutter, at the version apps/flutter/.flutter-version pins.
# Web only: cloud sessions have no Android SDK or iOS toolchain. A failed
# download leaves the JS toolchain working, so it warns instead of failing.
FLUTTER_VERSION="$(cat apps/flutter/.flutter-version)"
FLUTTER_HOME=/opt/flutter
if [ "$("$FLUTTER_HOME/bin/flutter" --version --machine 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0)).frameworkVersion' 2>/dev/null || true)" != "$FLUTTER_VERSION" ]; then
  echo "Installing Flutter $FLUTTER_VERSION"
  rm -rf "$FLUTTER_HOME"
  if curl -fsSL "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" | tar -xJ -C /opt; then
    git config --global --add safe.directory "$FLUTTER_HOME"
    "$FLUTTER_HOME/bin/flutter" --disable-analytics >/dev/null 2>&1 || true
  else
    echo "warning: Flutter $FLUTTER_VERSION download failed; apps/flutter can't build this session" >&2
  fi
fi
if [ -x "$FLUTTER_HOME/bin/flutter" ]; then
  export PATH="$FLUTTER_HOME/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$FLUTTER_HOME/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
  (cd apps/flutter && flutter pub get >/dev/null) || echo "warning: flutter pub get failed in apps/flutter" >&2
fi
