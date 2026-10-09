// SPDX-License-Identifier: GPL-3.0-or-later
// MusicBar — compact, cover-tinted media controls with a hover popup.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ArtLoader, DEFAULT_PALETTE} from './art.js';
import {DetailsLookup} from './details.js';
import {MusicBarIndicator} from './indicator.js';
import {PlayerManager} from './mpris.js';
import {MusicBarPopup} from './popup.js';
import {SpotifyClient} from './spotify.js';

const TICK_INTERVAL = 250;
const RESYNC_INTERVAL = 5000;

export default class MusicBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._art = new ArtLoader();
        this._artUrl = null;

        this._manager = new PlayerManager(this._settings);
        this._manager.connect('active-changed', () => this._onActiveChanged());
        this._manager.connect('changed', () => this._sync());
        this._manager.connect('track-changed', () => this._sync());
        this._manager.connect('position-changed', () => this._updateProgress());

        this._spotify = new SpotifyClient(this._settings);
        this._details = new DetailsLookup();
        this._popup = new MusicBarPopup(this._manager, {
            settings: this._settings,
            art: this._art,
            spotify: this._spotify,
            details: this._details,
            iconsDir: GLib.build_filenamev([this.path, 'icons']),
        });
        Main.layoutManager.addTopChrome(this._popup);
        this._popup.connect('hover-changed', () => this._syncHover());
        this._popup.connect('drag-changed', () => this._syncHover());

        this._createIndicator();
        this._settingsIds = ['panel-position', 'panel-index'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._createIndicator()));

        this._overviewId = Main.overview.connect('showing', () => this._popup.close());

        this._manager.start();
    }

    disable() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        Main.overview.disconnect(this._overviewId);

        this._clearTimeout('_openId');
        this._clearTimeout('_closeId');
        this._clearTimeout('_tickId');
        this._artCancellable?.cancel();

        this._indicator?.destroy();
        this._indicator = null;

        Main.layoutManager.removeChrome(this._popup);
        this._popup.destroy();
        this._popup = null;

        this._manager.destroy();
        this._manager = null;
        this._spotify.destroy();
        this._spotify = null;
        this._details.destroy();
        this._details = null;
        this._art.destroy();
        this._art = null;
        this._settings = null;
    }

    _createIndicator() {
        this._indicator?.destroy();

        this._indicator = new MusicBarIndicator(this._manager, this._settings);
        this._indicator.connect('notify::hover', () => this._syncHover());
        this._indicator.setPalette(this._palette ?? DEFAULT_PALETTE);

        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    // ---- player state ----------------------------------------------------

    _onActiveChanged() {
        if (!this._manager.active)
            this._popup.close();
        this._sync();
    }

    _sync() {
        this._indicator.sync();
        if (this._popup.isOpen)
            this._popup.sync();
        this._updateArt();
        this._updateTicker();
    }

    _updateProgress() {
        this._indicator.updateProgress();
        if (this._popup.isOpen)
            this._popup.updateProgress();
    }

    /** While playing, advance the progress displays and periodically resync. */
    _updateTicker() {
        const playing = this._manager.active?.isPlaying ?? false;
        if (playing && !this._tickId) {
            let sinceResync = 0;
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_INTERVAL, () => {
                sinceResync += TICK_INTERVAL;
                if (sinceResync >= RESYNC_INTERVAL) {
                    sinceResync = 0;
                    this._manager.active?.resync();
                }
                this._updateProgress();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!playing) {
            this._clearTimeout('_tickId');
        }
    }

    async _updateArt() {
        const url = this._manager.active?.track.artUrl ?? '';
        if (url === this._artUrl)
            return;
        this._artUrl = url;

        this._artCancellable?.cancel();
        const cancellable = this._artCancellable = new Gio.Cancellable();

        let result = null;
        if (url) {
            try {
                result = await this._art.load(url, cancellable);
            } catch (e) {
                if (cancellable.is_cancelled())
                    return;
                console.warn(`MusicBar: could not load cover ${url}: ${e.message}`);
                this._artUrl = null; // retry on the next update
            }
        }
        if (cancellable.is_cancelled() || !this._popup)
            return;

        this._palette = result?.palette ?? DEFAULT_PALETTE;
        this._popup.setArt(result?.uri ?? null);
        this._popup.setPalette(this._palette);
        this._indicator.setPalette(this._palette);
    }

    // ---- hover popup -----------------------------------------------------

    _syncHover() {
        if (!this._popup || !this._indicator)
            return;
        const hovered = this._indicator.hover || this._popup.hovered || this._popup.dragging;

        if (hovered) {
            this._clearTimeout('_closeId');
            if (!this._popup.isOpen && !this._openId) {
                this._openId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    Math.max(1, this._settings.get_int('open-delay')), () => {
                        this._openId = 0;
                        this._popup.open(this._indicator);
                        return GLib.SOURCE_REMOVE;
                    });
            }
        } else {
            this._clearTimeout('_openId');
            if (this._popup.isOpen && !this._closeId) {
                this._closeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    Math.max(1, this._settings.get_int('close-delay')), () => {
                        this._closeId = 0;
                        this._popup.close();
                        return GLib.SOURCE_REMOVE;
                    });
            }
        }
    }

    _clearTimeout(prop) {
        if (this[prop]) {
            GLib.source_remove(this[prop]);
            this[prop] = 0;
        }
    }
}
