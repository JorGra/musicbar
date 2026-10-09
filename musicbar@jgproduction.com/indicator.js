// SPDX-License-Identifier: GPL-3.0-or-later
// The compact, fixed-width controls that live in the panel.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {DEFAULT_PALETTE} from './art.js';
import {addHoverScale} from './util.js';

const SEEK_STEP_US = 5 * 1000 * 1000;
// Minimum time between track skips, so one touchpad flick doesn't skip five songs.
const SKIP_INTERVAL = 400;

export const MusicBarIndicator = GObject.registerClass(
class MusicBarIndicator extends PanelMenu.Button {
    _init(manager, settings) {
        super._init(0.5, 'MusicBar', true);
        this._manager = manager;
        this._settings = settings;
        this._palette = DEFAULT_PALETTE;
        this._progress = 0;
        this._buttonSize = 0;
        this._fitLaterId = 0;
        this._scrollAccum = 0;
        this._lastSkip = 0;

        this.add_style_class_name('musicbar-indicator');

        // The pill: a row of buttons inside a progress ring. It fills the
        // panel's height, so taller panels (dash-to-panel) get bigger buttons.
        this._pill = new St.Widget({
            style_class: 'musicbar-pill',
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
            reactive: true,
        });
        this.add_child(this._pill);

        const row = new St.BoxLayout({style_class: 'musicbar-pill-row', y_expand: true});
        this._pill.add_child(row);

        this._prevButton = this._makeButton('media-skip-backward-symbolic', 'Previous',
            () => this._manager.active?.previous());
        this._playButton = this._makeButton('media-playback-start-symbolic', 'Play',
            () => this._manager.active?.playPause());
        this._nextButton = this._makeButton('media-skip-forward-symbolic', 'Next',
            () => this._manager.active?.next());
        row.add_child(this._prevButton);
        row.add_child(this._playButton);
        row.add_child(this._nextButton);

        // Song position drawn as a ring tracing the pill's outline.
        this._ring = new St.DrawingArea({
            style_class: 'musicbar-pill-ring',
            x_expand: true,
            y_expand: true,
        });
        this._ring.connect('repaint', area => this._drawRing(area));
        this._pill.insert_child_below(this._ring, row);

        this._pill.connect('scroll-event', (_a, event) => this._onScroll(event));
        row.connect('notify::height', () => this._fitButtons(row.height));

        this._settingsIds = [
            settings.connect('changed::tint-panel', () => this._applyStyle()),
            settings.connect('changed::show-progress', () => this.sync()),
        ];

        this.sync();
        this._applyStyle();
    }

    _makeButton(iconName, label, callback) {
        const button = new St.Button({
            style_class: 'musicbar-pill-button',
            accessible_name: label,
            can_focus: true,
            child: new St.Icon({icon_name: iconName, style_class: 'musicbar-pill-icon'}),
        });
        button.connect('clicked', callback);
        addHoverScale(button.child, button, 1.15);
        return button;
    }

    /** Keep the buttons roughly round-ish and the icons legible at any panel height. */
    _fitButtons(height) {
        const size = Math.round(height);
        if (size <= 0 || size === this._buttonSize)
            return;
        this._buttonSize = size;
        // Defer: restyling during allocation would re-enter the layout.
        const width = Math.max(32, Math.round(size * 0.95));
        const iconSize = Math.clamp(Math.round(size * 0.5), 16, 24);
        const laters = global.compositor.get_laters();
        if (this._fitLaterId)
            laters.remove(this._fitLaterId);
        this._fitLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._fitLaterId = 0;
            for (const button of [this._prevButton, this._playButton, this._nextButton]) {
                button.set_style(`width: ${width}px;`);
                button.child.icon_size = iconSize;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onScroll(event) {
        const player = this._manager.active;
        const action = this._settings.get_string('scroll-action');
        if (!player || action === 'none')
            return Clutter.EVENT_PROPAGATE;

        let dir;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.RIGHT:
            dir = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.LEFT:
            dir = -1;
            break;
        default: {
            // Smooth scrolling: act once per notch worth of delta.
            const [dx, dy] = event.get_scroll_delta();
            this._scrollAccum += (Math.abs(dy) > Math.abs(dx) ? -dy : dx);
            if (Math.abs(this._scrollAccum) < 1)
                return Clutter.EVENT_STOP;
            dir = Math.sign(this._scrollAccum);
            this._scrollAccum = 0;
        }
        }

        if (action === 'track') {
            const now = Date.now();
            if (now - this._lastSkip < SKIP_INTERVAL)
                return Clutter.EVENT_STOP;
            this._lastSkip = now;
            if (dir > 0)
                player.next();
            else
                player.previous();
        } else if (player.canSeek) {
            player.seekBy(dir * SEEK_STEP_US);
        }
        return Clutter.EVENT_STOP;
    }

    setPalette(palette) {
        this._palette = palette;
        this._applyStyle();
    }

    _applyStyle() {
        const tint = this._settings.get_boolean('tint-panel') && this._palette.tinted;
        // The ring is the pill's only outline, so it carries the tint.
        this._ring.set_style(tint ? `color: ${this._palette.accent};` : null);
    }

    sync() {
        const player = this._manager.active;
        this.visible = !!player;
        if (!player)
            return;

        const playing = player.isPlaying;
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? 'Pause' : 'Play';
        this._playButton.reactive = player.canPlayPause;
        this._prevButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;

        this._ring.visible = this._settings.get_boolean('show-progress') && player.track.length > 0;
        this.updateProgress();
    }

    updateProgress() {
        const player = this._manager.active;
        if (!player || !this._ring.visible)
            return;
        const length = player.track.length;
        const progress = length > 0 ? Math.clamp(player.position / length, 0, 1) : 0;
        // Skip repaints that would not move the ring by a visible amount.
        if (Math.abs(progress - this._progress) < 0.0005)
            return;
        this._progress = progress;
        this._ring.queue_repaint();
    }

    _drawRing(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const node = area.get_theme_node();
        const lineWidth = node.get_length('-ring-width') || 2;
        const trackColor = node.get_color('-ring-track-color');
        const fillColor = node.get_foreground_color();

        // Stadium path, starting at the top center and running clockwise.
        const inset = lineWidth / 2;
        const r = height / 2 - inset;
        const x0 = inset + r, x1 = width - inset - r;
        const top = inset, bottom = height - inset, cy = height / 2;
        const path = () => {
            cr.newPath();
            cr.moveTo(width / 2, top);
            cr.lineTo(x1, top);
            cr.arc(x1, cy, r, -Math.PI / 2, Math.PI / 2);
            cr.lineTo(x0, bottom);
            cr.arc(x0, cy, r, Math.PI / 2, Math.PI * 3 / 2);
            cr.closePath();
        };
        const length = 2 * (x1 - x0) + 2 * Math.PI * r;

        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.BUTT);

        path();
        cr.setSourceRGBA(trackColor.red / 255, trackColor.green / 255,
            trackColor.blue / 255, trackColor.alpha / 255);
        cr.stroke();

        if (this._progress > 0) {
            path();
            cr.setDash([length * this._progress, length + 1], 0);
            cr.setSourceRGBA(fillColor.red / 255, fillColor.green / 255,
                fillColor.blue / 255, fillColor.alpha / 255);
            cr.stroke();
        }
        cr.$dispose();
    }

    _onDestroy() {
        if (this._fitLaterId)
            global.compositor.get_laters().remove(this._fitLaterId);
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        super._onDestroy();
    }
});
