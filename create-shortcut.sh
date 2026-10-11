#!/usr/bin/env bash
# Adds Moonfang to the application menu (and the desktop, if there is one). The entry runs launch.sh, which
# opens the app in its own window and stops the server again when that window is closed.
set -eu
ROOT="$(dirname "$(readlink -f "$0")")"
chmod +x "$ROOT"/*.sh

APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
ENTRY="$APPS/moonfang.desktop"
cat >"$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=Moonfang
Comment=3D texture painting
Exec="$ROOT/launch.sh"
Icon=$ROOT/icon.png
Terminal=false
Categories=Graphics;3DGraphics;
StartupNotify=false
EOF
chmod +x "$ENTRY"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
echo "Created $ENTRY"

DESKTOP_DIR=$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")
if [ -d "$DESKTOP_DIR" ] && [ "$DESKTOP_DIR" != "$HOME" ]; then
  cp "$ENTRY" "$DESKTOP_DIR/moonfang.desktop"
  chmod +x "$DESKTOP_DIR/moonfang.desktop"
  # GNOME only launches desktop files it was told to trust.
  command -v gio >/dev/null 2>&1 && gio set "$DESKTOP_DIR/moonfang.desktop" metadata::trusted true 2>/dev/null || true
  echo "Created $DESKTOP_DIR/moonfang.desktop"
fi
