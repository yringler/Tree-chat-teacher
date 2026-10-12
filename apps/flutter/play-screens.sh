#!/bin/sh
# play-screens.sh — prep an Android emulator for Google Play screenshots.
#
# Usage:
#   ./play-screens.sh start   # clean status bar (demo mode); optional resize
#   ./play-screens.sh stop    # exit demo mode; undo any resize
#   ./play-screens.sh capture name.png   # screenshot -> Play-ready PNG (no alpha)
#
# Optional env vars:
#   SIZE=1080x1920 DENSITY=420 ./play-screens.sh start|capture name.png
#     -> override the display to 9:16 (for tall devices like the Pixel 10 Pro XL)
#        stays in effect until `stop`
#   SERIAL=emulator-5556 ./play-screens.sh start
#     -> target a specific device when more than one is connected

set -eu

# --- locate adb -------------------------------------------------------------
find_adb() {
  if command -v adb >/dev/null 2>&1; then
    command -v adb; return
  fi
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
             "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" \
             "${LOCALAPPDATA:-}/Android/Sdk"; do
    for bin in adb adb.exe; do
      [ -n "$sdk" ] && [ -x "$sdk/platform-tools/$bin" ] && {
        echo "$sdk/platform-tools/$bin"; return
      }
    done
  done
  echo "adb not found. Add <sdk>/platform-tools to PATH or set ANDROID_HOME." >&2
  exit 1
}

ADB=$(find_adb)
[ -n "${SERIAL:-}" ] && ADB="$ADB -s $SERIAL"

adb_() { $ADB "$@"; }
demo() { adb_ shell am broadcast -a com.android.systemui.demo -e command "$@" >/dev/null; }

# --- preflight --------------------------------------------------------------
adb_ wait-for-device
if [ "$(adb_ get-state 2>/dev/null)" != "device" ]; then
  echo "No device ready. Is the emulator running? (adb devices)" >&2
  exit 1
fi

# --- commands ---------------------------------------------------------------
start() {
  if [ -n "${SIZE:-}" ]; then
    adb_ shell wm size "$SIZE"
    [ -n "${DENSITY:-}" ] && adb_ shell wm density "$DENSITY"
    echo "Display overridden to $SIZE${DENSITY:+ @ ${DENSITY}dpi}"
  fi

  adb_ shell settings put global sysui_demo_allowed 1
  demo enter
  demo clock -e hhmm 1200
  demo battery -e level 100 -e plugged false
  demo network -e wifi show -e level 4 -e mobile show -e datatype none -e level 4
  demo notifications -e visible false

  echo "Demo mode ON. Capture with:"
  echo "  $0 capture name.png"
  echo "Done? Reset with:"
  echo "  $0 stop"
}

stop() {
  demo exit
  adb_ shell settings put global sysui_demo_allowed 0
  # Resetting is harmless even if start never overrode anything.
  adb_ shell wm size reset
  adb_ shell wm density reset
  echo "Demo mode OFF. Display size/density reset."
}

find_magick() {
  if command -v magick >/dev/null 2>&1; then echo magick      # ImageMagick 7
  elif command -v convert >/dev/null 2>&1; then echo convert  # ImageMagick 6
  else
    echo "ImageMagick not found (need 'magick' or 'convert')." >&2
    exit 1
  fi
}

capture() {
  out="${1:-}"
  if [ -z "$out" ]; then
    echo "Usage: $0 capture name.png" >&2; exit 2
  fi
  case "$out" in *.png|*.PNG|*.jpg|*.jpeg|*.JPG|*.JPEG) ;; *) out="$out.png" ;; esac

  im=$(find_magick)

  # Honor SIZE/DENSITY here too, so `SIZE=1080x1920 ./play-screens.sh capture x` works
  # without a separate `start`. Only re-apply if the override isn't already active,
  # because every wm size change forces a relayout (and a visible flicker).
  if [ -n "${SIZE:-}" ]; then
    current=$(adb_ shell wm size | tr -d '\r' | sed -n 's/^Override size: //p')
    if [ "$current" != "$SIZE" ]; then
      adb_ shell wm size "$SIZE"
      [ -n "${DENSITY:-}" ] && adb_ shell wm density "$DENSITY"
      echo "Display overridden to $SIZE — waiting for relayout..."
      sleep 2
    fi
  fi

  raw=$(mktemp "${TMPDIR:-/tmp}/playshot.XXXXXX")
  trap 'rm -f "$raw"' EXIT

  # exec-out streams raw bytes; plain 'shell' can mangle binary with CRLF translation.
  adb_ exec-out screencap -p > "$raw"
  if [ ! -s "$raw" ]; then
    echo "screencap returned nothing." >&2; exit 1
  fi

  # Flatten onto white and drop the alpha channel -> 24-bit PNG / plain JPEG.
  # PNG24: forces truecolor RGB; otherwise ImageMagick may pick an 8-bit palette
  # PNG for simple screens, which isn't the "24-bit PNG" Play asks for.
  case "$out" in
    *.png|*.PNG) dest="PNG24:$out" ;;
    *)           dest="$out" ;;
  esac
  "$im" "$raw" -background white -alpha remove -alpha off "$dest"

  # Report dimensions and check Play's 2:1 limit.
  if [ "$im" = magick ]; then dims=$(magick identify -format '%w %h' "$out")
  else dims=$(identify -format '%w %h' "$out"); fi
  w=${dims% *}; h=${dims#* }
  if [ "$w" -gt "$h" ]; then long=$w; short=$h; else long=$h; short=$w; fi

  echo "Saved $out (${w}x${h})"
  if [ "$long" -gt $((short * 2)) ]; then
    echo "WARNING: aspect ratio exceeds 2:1 — Play will reject this. Use SIZE=1080x1920 on start." >&2
  elif [ "$short" -lt 1080 ]; then
    echo "Note: shortest side < 1080px — accepted, but not eligible for featuring." >&2
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  capture) shift; capture "${1:-}" ;;
  *) echo "Usage: $0 {start|stop|capture name.png}" >&2; exit 2 ;;
esac
