UUID := musicbar@jgproduction.com
SRC := $(UUID)
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall pack lint clean dev dev-prefs

install:
	glib-compile-schemas $(SRC)/schemas
	rm -rf $(DEST)
	mkdir -p $(DEST)
	cp -r $(SRC)/. $(DEST)/
	@echo "Installed. Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(DEST)

pack:
	mkdir -p build
	gnome-extensions pack --force --extra-source=art.js --extra-source=details.js --extra-source=indicator.js --extra-source=marquee.js \
		--extra-source=mpris.js --extra-source=popup.js --extra-source=spotify.js --extra-source=util.js --extra-source=icons \
		--out-dir=build $(SRC)

lint:
	npm run --silent lint

# Nested GNOME Shell window with the extension and your real players; no logout.
dev:
	./tools/devkit.sh

# Open the settings inside the running `make dev` shell.
dev-prefs:
	DBUS_SESSION_BUS_ADDRESS=$$(cat build/devkit/bus) gnome-extensions prefs $(UUID)

clean:
	rm -rf build $(SRC)/schemas/gschemas.compiled
