#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Run MusicBar in a nested GNOME Shell window (GNOME 49+ devkit), no logout needed.
#
# The nested shell gets its own D-Bus session and its own XDG config/data/cache
# under build/devkit, so it never touches your real settings (dconf) or
# extensions. Your host MPRIS players (Spotify) are mirrored into it.
# The extension is symlinked, so edits apply on the next run.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=musicbar@jgproduction.com
DEV=$ROOT/build/devkit
SIZE=${MUSICBAR_DEVKIT_SIZE:-1600x1000}

if [ "${1:-}" != --inner ]; then
    mkdir -p "$DEV/config" "$DEV/cache" "$DEV/data/gnome-shell/extensions"
    ln -sfn "$ROOT/$UUID" "$DEV/data/gnome-shell/extensions/$UUID"
    glib-compile-schemas --strict "$ROOT/$UUID/schemas"

    # Export before dbus-run-session so the nested dconf-service writes into
    # build/devkit instead of ~/.config/dconf.
    export HOST_BUS=$DBUS_SESSION_BUS_ADDRESS
    export XDG_CONFIG_HOME=$DEV/config XDG_DATA_HOME=$DEV/data XDG_CACHE_HOME=$DEV/cache
    exec dbus-run-session -- "$0" --inner
fi

[ "$XDG_CONFIG_HOME" = "$DEV/config" ] || { echo "devkit: environment not isolated" >&2; exit 1; }

gsettings set org.gnome.shell enabled-extensions "['$UUID']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'

python3 "$ROOT/tools/mpris-relay.py" &
RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT

# Lets `make dev-prefs` open the settings inside the nested shell.
echo "$DBUS_SESSION_BUS_ADDRESS" > "$DEV/bus"

MUTTER_DEBUG_DUMMY_MODE_SPECS=$SIZE gnome-shell --devkit --wayland
