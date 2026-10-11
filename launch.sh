#!/usr/bin/env bash
# Opens Moonfang as a desktop app in the default browser: starts the dev server, shows the app in a window of
# its own and runs stop.sh once that window is closed (the Linux counterpart of launch.ps1).
#  - Chromium browsers (Chrome, Chromium, Brave, Vivaldi, Edge): app mode, no tabs or address bar.
#  - Firefox (no app mode): a separate profile whose tab strip and toolbars are hidden.
# Run through the menu entry made by create-shortcut.sh.
set -u
ROOT="$(dirname "$(readlink -f "$0")")"
PORT=5178
URL="http://localhost:$PORT"

fail() {
  echo "$1" >&2
  if command -v zenity >/dev/null 2>&1; then zenity --error --title=Moonfang --text="$1" 2>/dev/null
  elif command -v kdialog >/dev/null 2>&1; then kdialog --title Moonfang --error "$1" 2>/dev/null
  elif command -v notify-send >/dev/null 2>&1; then notify-send Moonfang "$1"
  fi
  exit 1
}

listening() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]
  else
    (exec 3<>"/dev/tcp/localhost/$PORT") 2>/dev/null # localhost: IPv4 or IPv6
  fi
}

# The default browser's .desktop file, or nothing.
default_desktop_file() {
  local name dir
  name=$(xdg-settings get default-web-browser 2>/dev/null) || return
  [ -n "$name" ] || return
  for dir in "${XDG_DATA_HOME:-$HOME/.local/share}" $(echo "${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" | tr ':' ' ') \
    /var/lib/snapd/desktop /var/lib/flatpak/exports/share "$HOME/.local/share/flatpak/exports/share"; do
    [ -f "$dir/applications/$name" ] && { echo "$dir/applications/$name"; return; }
  done
}

# --- pick the browser: BROWSER_CMD (array), KIND (chromium | firefox) and DATA_ROOT (where its profile may live)
BROWSER_CMD=()
KIND=""
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/moonfang"
desktop=$(default_desktop_file)
if [ -n "$desktop" ]; then
  exec_line=$(sed -n '/^\[Desktop Entry\]/,/^\[/{s/^Exec=//p}' "$desktop" | head -n 1)
  # Drop field codes (%u, %U, ...) and Flatpak's file-forwarding markers.
  read -ra words <<<"$exec_line"
  for w in "${words[@]}"; do
    case "$w" in %? | @@ | @@u | @@U | --file-forwarding) ;; *) BROWSER_CMD+=("${w//\"/}") ;; esac
  done
  case "${exec_line,,}" in
    *firefox* | *librewolf* | *waterfox* | *floorp* | *zen*) KIND=firefox ;;
    *chrome* | *chromium* | *brave* | *vivaldi* | *edge*) KIND=chromium ;;
  esac
  base=$(basename "$desktop" .desktop)
  # Sandboxed browsers can't read hidden folders in $HOME: keep the profile in their own data folder.
  if [[ "$desktop" == /var/lib/snapd/* || "$exec_line" == */snap/bin/* ]]; then
    DATA_ROOT="$HOME/snap/${base%%_*}/common/moonfang"
  elif [[ "$exec_line" == *"flatpak run"* ]]; then
    DATA_ROOT="$HOME/.var/app/$base/moonfang"
  fi
fi
if [ -z "$KIND" ]; then
  # Unknown default browser: first one on PATH.
  BROWSER_CMD=()
  DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/moonfang"
  for b in firefox google-chrome google-chrome-stable chromium chromium-browser brave-browser vivaldi microsoft-edge; do
    if command -v "$b" >/dev/null 2>&1; then
      BROWSER_CMD=("$b")
      case "$b" in firefox) KIND=firefox ;; *) KIND=chromium ;; esac
      # A snap install behind /snap/bin needs the sandbox-friendly folder too.
      [[ "$(readlink -f "$(command -v "$b")")" == /snap/* || "$(command -v "$b")" == /snap/bin/* ]] && DATA_ROOT="$HOME/snap/$b/common/moonfang"
      break
    fi
  done
fi

if [ "$KIND" = chromium ]; then
  PROFILE="$DATA_ROOT/browser-profile"
  ARGS=("--app=$URL" "--user-data-dir=$PROFILE" --no-first-run --no-default-browser-check --start-maximized)
else
  PROFILE="$DATA_ROOT/firefox-profile"
  ARGS=(-profile "$PROFILE" -new-window "$URL")
fi

app_running() { pgrep -f -- "$PROFILE" >/dev/null 2>&1; }

# --- server
"$ROOT/start.sh" --no-browser >/dev/null || fail "The Moonfang server did not start. Run start.sh in a terminal to see why."

if [ -z "$KIND" ]; then
  # No browser we know how to run as an app: open a normal tab and leave the server running (stop.sh stops it).
  xdg-open "$URL" >/dev/null 2>&1 || fail "No browser found. Open $URL yourself."
  exit 0
fi

# Already open: just bring up another window; the first launcher stops the server when the last one closes.
if app_running; then
  "${BROWSER_CMD[@]}" "${ARGS[@]}" >/dev/null 2>&1 &
  exit 0
fi

# --- profile setup
mkdir -p "$PROFILE"
if [ "$KIND" = firefox ]; then
  # No welcome pages or prompts; the system title bar so hiding the tab strip keeps the window buttons.
  cat >"$PROFILE/user.js" <<'EOF'
// Written by Moonfang's launch.sh
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.startup.page", 0);
user_pref("browser.tabs.inTitlebar", 0);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.toolbars.bookmarks.visibility", "never");
user_pref("browser.warnOnQuit", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("sidebar.revamp", false);
user_pref("sidebar.verticalTabs", false);
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
EOF
  mkdir -p "$PROFILE/chrome"
  cat >"$PROFILE/chrome/userChrome.css" <<'EOF'
/* Written by Moonfang's launch.sh: only the page, like an app window. */
#TabsToolbar, #nav-bar, #PersonalToolbar, #sidebar-main, #sidebar-box, #sidebar-splitter { visibility: collapse !important; }
EOF
  # Open maximised the first time (Firefox remembers the window state afterwards).
  [ -f "$PROFILE/xulstore.json" ] ||
    echo '{"chrome://browser/content/browser.xhtml":{"main-window":{"sizemode":"maximized"}}}' >"$PROFILE/xulstore.json"
elif command -v python3 >/dev/null 2>&1; then
  # Chromium can keep running in the background after its last window closes unless told not to.
  python3 - "$PROFILE/Local State" <<'EOF'
import json, os, sys
p = sys.argv[1]
try:
    s = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
except ValueError:
    s = {}
for k in ('background_mode', 'startup_boost'):
    s.setdefault(k, {})['enabled'] = False
json.dump(s, open(p, 'w', encoding='utf-8'))
EOF
fi

# --- run, then wait until the last process of the app profile is gone
"${BROWSER_CMD[@]}" "${ARGS[@]}" >/dev/null 2>&1 &
wait $!
# Wrappers (snap, flatpak, some distro scripts) may hand the window to a child that outlives them.
while app_running; do sleep 1; done

"$ROOT/stop.sh" >/dev/null
