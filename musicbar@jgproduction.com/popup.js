// SPDX-License-Identifier: GPL-3.0-or-later
// The hover popup: cover art, track info, scrubber and full controls.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {DEFAULT_PALETTE, rgba} from './art.js';
import {MarqueeLabel} from './marquee.js';
import {trackUriFromMpris} from './spotify.js';
import {addHoverScale, defineShaderEffect, formatTime} from './util.js';

const GAP = 8;
const MARGIN = 8;
const SHOW_TIME = 220;
const HIDE_TIME = 140;
const COVER_FADE_TIME = 350;
const SEEK_DEBOUNCE = 180;
const SHEET_FADE_TIME = 160;
const TOAST_TIME = 1800;
const VOLUME_TOGGLE_TIME = 200;
const BLUR_RADIUS = 32;

const Mode = Clutter.AnimationMode;

/**
 * Open animation presets. `popup` moves the whole card; `items` (optional)
 * staggers the individual elements in, starting from the panel side.
 */
const ANIMATIONS = {
    none: {},
    fade: {
        popup: {duration: 180, mode: Mode.EASE_OUT_QUAD},
    },
    cascade: {
        popup: {scale: 0.96, shift: 8, duration: SHOW_TIME, mode: Mode.EASE_OUT_CUBIC},
        items: {shift: 16, stagger: 28, duration: 380, mode: Mode.EASE_OUT_CUBIC},
    },
    spring: {
        popup: {scale: 0.9, shift: 14, duration: 320, mode: Mode.EASE_OUT_BACK},
        items: {shift: 26, stagger: 38, duration: 520, mode: Mode.EASE_OUT_BACK},
    },
    sweep: {
        popup: {scale: 0.98, duration: SHOW_TIME, mode: Mode.EASE_OUT_CUBIC},
        items: {slide: -36, stagger: 30, duration: 460, mode: Mode.EASE_OUT_EXPO},
    },
    zoom: {
        popup: {scale: 0.85, duration: 260, mode: Mode.EASE_OUT_QUINT},
        items: {scale: 0.6, stagger: 26, duration: 420, mode: Mode.EASE_OUT_BACK},
    },
};

// Cuts an actor down to a rounded rectangle with antialiased corners.
const CORNERS_DECLARATIONS = `
uniform float width;
uniform float height;
uniform float radius;
`;
const CORNERS_CODE = `
vec2 size = vec2(width, height);
vec2 q = abs(cogl_tex_coord_in[0].xy * size - 0.5 * size) - (0.5 * size - radius);
float d = length(max(q, 0.0)) - radius;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;
const RoundedCornersEffect = defineShaderEffect('RoundedCornersEffect',
    CORNERS_DECLARATIONS, CORNERS_CODE);

/** Takes whatever space the popup gives it; the screen-sized clone inside must not count. */
const Backdrop = GObject.registerClass(
class Backdrop extends Clutter.Actor {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }
});

/** The card itself; always exactly as wide as the cover, whatever the title length. */
const PopupBox = GObject.registerClass(
class PopupBox extends St.BoxLayout {
    vfunc_get_preferred_width(_forHeight) {
        const [, coverWidth] = this.first_child.get_preferred_width(-1);
        return this.get_theme_node().adjust_preferred_width(coverWidth, coverWidth);
    }
});

/** Left group | center | right group, with the center child centered in the row. */
const ControlsLayout = GObject.registerClass(
class ControlsLayout extends Clutter.LayoutManager {
    _init(spacing) {
        super._init();
        this._spacing = spacing;
    }

    _widths(container) {
        return container.get_children().map(c => (c.visible ? c.get_preferred_width(-1)[1] : 0));
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const [left, center, right] = this._widths(container);
        const width = 2 * (Math.max(left, right) + this._spacing) + center;
        return [width, width];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const height = Math.max(0, ...container.get_children().map(c => c.get_preferred_height(-1)[1]));
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const [left, center, right] = this._widths(container);
        const x = Math.round(box.x1 + (box.get_width() - center) / 2);
        const xs = [x - this._spacing - left, x, x + center + this._spacing];
        const widths = [left, center, right];
        container.get_children().forEach((child, i) => {
            const height = child.get_preferred_height(widths[i])[1];
            const y = Math.round(box.y1 + (box.get_height() - height) / 2);
            child.allocate(new Clutter.ActorBox({x1: xs[i], y1: y, x2: xs[i] + widths[i], y2: y + height}));
        });
    }
});

export const MusicBarPopup = GObject.registerClass({
    Signals: {'drag-changed': {}, 'hover-changed': {}},
}, class MusicBarPopup extends St.Widget {
    _init(manager, {settings, art, spotify, details, iconsDir}) {
        // An unstyled, non-reactive frame holding the shadow and the card.
        // St's own box-shadow renders as a hard rectangle under translucent
        // backgrounds, so the shadow is drawn by hand, outside the card only.
        super._init({
            layout_manager: new Clutter.BinLayout(),
            visible: false,
            opacity: 0,
        });
        this._shadow = new St.DrawingArea({
            style_class: 'musicbar-popup-shadow',
            x_expand: true,
            y_expand: true,
        });
        this._shadow.connect('repaint', area => this._drawShadow(area));
        this.add_child(this._shadow);

        this._box = new PopupBox({
            style_class: 'musicbar-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            // Keeps elements that slide in from outside within the card.
            clip_to_allocation: true,
        });
        this._box.connect('notify::hover', () => this.emit('hover-changed'));
        this._box.connect('style-changed', () => {
            this._shadow.queue_repaint();
            this._queueBackdropSync();
        });
        // Above a bottom panel the card grows upwards (volume row), so re-anchor.
        this._box.connect('notify::height', () => {
            if (this._isOpen && !this._below && this._anchor)
                this._place(this._anchor);
        });
        this._buildBackdrop();
        this.add_child(this._box);

        this._manager = manager;
        this._settings = settings;
        this._art = art;
        this._spotify = spotify;
        this._detailsLookup = details;
        this._iconsDir = iconsDir;
        this._destroyed = false;
        this.dragging = false;

        this._isOpen = false;
        this._anchor = null;
        this._below = true;
        this._palette = DEFAULT_PALETTE;
        this._accent = DEFAULT_PALETTE.accent;
        this._app = null;

        this._detailsKey = null;
        this._detailsCancellable = null;
        this._detailsText = '';

        this._showRemaining = false;
        this._updatingSlider = false;
        this._seekId = 0;

        this._volumeOpen = false;
        this._volumeDragging = false;
        this._updatingVolume = false;
        this._unmutedVolume = 0.5;

        this._likeUri = null;
        this._liked = false;
        this._smartShuffle = false;
        this._smartSerial = 0;
        this._lastShuffle = false;
        this._sheetCancellable = null;
        this._sheetAction = null;
        this._toastId = 0;

        this._buildCover();
        this._buildInfo();
        this._buildProgress();
        this._buildControls();
        this._buildVolume();
        this._buildSheet();
        this._buildToast();

        this._settingsIds = [
            settings.connect('changed::tint-popup', () => this.setPalette(this._palette)),
            settings.connect('changed::popup-opacity', () => this.setPalette(this._palette)),
            settings.connect('changed::popup-blur', () => this._queueBackdropSync()),
            settings.connect('changed::show-details', () => {
                this._detailsKey = null;
                if (this._isOpen)
                    this.sync();
            }),
            ...['spotify-integration', 'spotify-refresh-token'].map(key =>
                settings.connect(`changed::${key}`, () => {
                    this._likeUri = null;
                    if (this._isOpen)
                        this.sync();
                })),
        ];

        this.connect('destroy', () => {
            // Spotify requests still in flight resolve after this; see the guards.
            this._destroyed = true;
            this._settingsIds.forEach(id => settings.disconnect(id));
            this._sheetCancellable?.cancel();
            this._detailsCancellable?.cancel();
            if (this._seekId)
                GLib.source_remove(this._seekId);
            if (this._toastId)
                GLib.source_remove(this._toastId);
            if (this._backdropLaterId)
                global.compositor.get_laters().remove(this._backdropLaterId);
        });

        this.setPalette(DEFAULT_PALETTE);
        this._syncBackdrop();
    }

    get isOpen() {
        return this._isOpen;
    }

    get hovered() {
        return this._box.hover;
    }

    _icon(name) {
        return new Gio.FileIcon({
            file: Gio.File.new_for_path(GLib.build_filenamev([this._iconsDir, `${name}.svg`])),
        });
    }

    // ---- construction ----------------------------------------------------

    _buildCover() {
        this._cover = new St.Widget({
            style_class: 'musicbar-cover',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
        });
        this._box.add_child(this._cover);

        // Clicking the artwork brings the player to the front.
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => {
            if (!this._sheet.visible)
                this._openPlayer();
        });
        this._cover.add_action(click);
        addHoverScale(this._cover, this._cover, 1.015);

        this._coverPlaceholder = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'musicbar-cover-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._cover.add_child(this._coverPlaceholder);

        // Two layers so a new cover can cross-fade over the old one.
        this._coverLayers = [0, 1].map(() => {
            const layer = new St.Widget({
                style_class: 'musicbar-cover-image',
                x_expand: true,
                y_expand: true,
                opacity: 0,
            });
            this._cover.add_child(layer);
            return layer;
        });
        this._coverFront = 0;
        this._coverUri = null;
    }

    _buildInfo() {
        const info = new St.BoxLayout({style_class: 'musicbar-info'});
        this._box.add_child(info);

        const text = new St.BoxLayout({
            style_class: 'musicbar-info-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        info.add_child(text);

        // Long titles and album lines scroll instead of being cut off.
        const label = styleClass => {
            const l = new MarqueeLabel({style_class: styleClass, x_expand: true});
            text.add_child(l);
            return l;
        };
        this._title = label('musicbar-title');
        this._artist = label('musicbar-artist');
        // Album, year and genre share one quiet line.
        this._meta = label('musicbar-meta');

        // Spotify-only actions: like and add to playlist.
        this._actions = new St.BoxLayout({
            style_class: 'musicbar-actions',
            y_align: Clutter.ActorAlign.CENTER,
        });
        info.add_child(this._actions);

        const action = (iconName, label, callback) => {
            const button = new St.Button({
                style_class: 'musicbar-action',
                accessible_name: label,
                can_focus: true,
                child: new St.Icon({gicon: this._icon(iconName)}),
            });
            button.connect('clicked', callback);
            addHoverScale(button.child, button, 1.15);
            this._actions.add_child(button);
            return button;
        };
        this._likeButton = action('musicbar-heart-symbolic', 'Save to Liked Songs',
            () => this._toggleLike());
        this._playlistButton = action('musicbar-playlist-add-symbolic', 'Add to playlist',
            () => (this._sheet.visible ? this._closeSheet() : this._openSheet()));
    }

    _buildProgress() {
        this._progressBox = new St.BoxLayout({
            style_class: 'musicbar-progress',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._box.add_child(this._progressBox);

        this._slider = new Slider.Slider(0);
        this._slider.add_style_class_name('musicbar-slider');
        this._slider.accessible_name = 'Playback position';
        this._progressBox.add_child(this._slider);

        const times = new St.BoxLayout({style_class: 'musicbar-times'});
        this._progressBox.add_child(times);
        this._elapsed = new St.Label({style_class: 'musicbar-time', x_expand: true});
        times.add_child(this._elapsed);

        // Clicking the total time toggles "remaining" mode.
        this._totalButton = new St.Button({style_class: 'musicbar-time-button', can_focus: true});
        this._total = new St.Label({style_class: 'musicbar-time'});
        this._totalButton.child = this._total;
        this._totalButton.connect('clicked', () => {
            this._showRemaining = !this._showRemaining;
            this.updateProgress();
        });
        times.add_child(this._totalButton);

        this._slider.connect('drag-begin', () => {
            this.dragging = true;
            this.emit('drag-changed');
        });
        this._slider.connect('drag-end', () => {
            this.dragging = false;
            this._seekToSlider();
            this.emit('drag-changed');
        });
        this._slider.connect('notify::value', () => {
            if (this._updatingSlider)
                return;
            this._updateTimeLabels(this._slider.value * (this._manager.active?.track.length ?? 0));
            // Scroll and keyboard changes come without a drag; debounce them.
            if (!this.dragging)
                this._queueSeek();
        });
    }

    _buildControls() {
        // Play stays centered under the scrubber, whatever sits on either side.
        const controls = new St.Widget({
            style_class: 'musicbar-controls',
            layout_manager: new ControlsLayout(4),
        });
        this._box.add_child(controls);
        const side = () => {
            const box = new St.BoxLayout({style_class: 'musicbar-controls-side'});
            controls.add_child(box);
            return box;
        };
        const left = side();
        const center = new St.Bin();
        controls.add_child(center);
        const right = side();
        this._controlButtons = [];

        let parent = left;
        const make = (iconName, label, extraClass, callback) => {
            const button = new St.Button({
                style_class: `musicbar-control ${extraClass}`,
                accessible_name: label,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({icon_name: iconName}),
            });
            button.connect('clicked', callback);
            if (parent === center)
                center.child = button;
            else
                parent.add_child(button);
            this._controlButtons.push(button);
            return button;
        };

        this._shuffleButton = make('media-playlist-shuffle-symbolic', 'Shuffle', 'small', () => {
            const p = this._manager.active;
            if (p?.shuffle !== null)
                p.setShuffle(!p.shuffle);
        });
        this._prevButton = make('media-skip-backward-symbolic', 'Previous', '',
            () => this._manager.active?.previous());
        parent = center;
        this._playButton = make('media-playback-start-symbolic', 'Play', 'musicbar-play',
            () => this._manager.active?.playPause());
        parent = right;
        this._nextButton = make('media-skip-forward-symbolic', 'Next', '',
            () => this._manager.active?.next());
        this._repeatButton = make('media-playlist-repeat-symbolic', 'Repeat', 'small', () => {
            const p = this._manager.active;
            if (p?.loopStatus === null)
                return;
            const order = ['None', 'Playlist', 'Track'];
            p.setLoopStatus(order[(order.indexOf(p.loopStatus) + 1) % order.length]);
        });
        this._volumeButton = make('audio-volume-high-symbolic', 'Volume', 'small',
            () => this._setVolumeOpen(!this._volumeOpen));

        // Spotify's Smart Shuffle: the shuffle icon with a small sparkle.
        const shuffleIcon = this._shuffleButton.child;
        this._shuffleButton.child = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._shuffleButton.child.add_child(shuffleIcon);
        this._sparkle = new St.Icon({
            style_class: 'musicbar-sparkle',
            gicon: this._icon('musicbar-sparkle-symbolic'),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            translation_x: 4,
            translation_y: -4,
            visible: false,
        });
        this._shuffleButton.child.add_child(this._sparkle);

        addHoverScale(this._shuffleButton.child, this._shuffleButton, 1.12);
        addHoverScale(this._prevButton.child, this._prevButton, 1.12);
        addHoverScale(this._playButton, this._playButton, 1.07);
        addHoverScale(this._nextButton.child, this._nextButton, 1.12);
        addHoverScale(this._repeatButton.child, this._repeatButton, 1.12);
        addHoverScale(this._volumeButton.child, this._volumeButton, 1.12);
    }

    _buildVolume() {
        this._volumeRow = new St.BoxLayout({
            style_class: 'musicbar-volume',
            clip_to_allocation: true,
            visible: false,
            opacity: 0,
        });
        this._box.add_child(this._volumeRow);

        this._muteButton = new St.Button({
            style_class: 'musicbar-action',
            accessible_name: 'Mute',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'audio-volume-high-symbolic'}),
        });
        this._muteButton.connect('clicked', () => {
            const player = this._manager.active;
            const volume = player?.volume;
            if (volume === null || volume === undefined)
                return;
            if (volume > 0) {
                this._unmutedVolume = volume;
                player.setVolume(0);
            } else {
                player.setVolume(this._unmutedVolume);
            }
            this._syncVolume(player);
        });
        this._volumeRow.add_child(this._muteButton);

        this._volumeSlider = new Slider.Slider(0);
        this._volumeSlider.add_style_class_name('musicbar-slider');
        this._volumeSlider.add_style_class_name('musicbar-volume-slider');
        this._volumeSlider.accessible_name = 'Volume';
        this._volumeSlider.x_expand = true;
        this._volumeSlider.y_align = Clutter.ActorAlign.CENTER;
        this._volumeSlider.connect('drag-begin', () => {
            this._volumeDragging = true;
        });
        this._volumeSlider.connect('drag-end', () => {
            this._volumeDragging = false;
        });
        this._volumeSlider.connect('notify::value', () => {
            if (this._updatingVolume)
                return;
            const value = this._volumeSlider.value;
            this._manager.active?.setVolume(value);
            this._showVolume(value);
        });
        this._volumeRow.add_child(this._volumeSlider);

        this._volumeLabel = new St.Label({
            style_class: 'musicbar-volume-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volumeRow.add_child(this._volumeLabel);
    }

    _buildSheet() {
        this._sheet = new St.BoxLayout({
            style_class: 'musicbar-sheet',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
            visible: false,
            opacity: 0,
        });
        this._cover.add_child(this._sheet);

        const header = new St.BoxLayout({style_class: 'musicbar-sheet-header'});
        this._sheet.add_child(header);
        header.add_child(new St.Label({
            text: 'Add to playlist',
            style_class: 'musicbar-sheet-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const close = new St.Button({
            style_class: 'musicbar-action',
            accessible_name: 'Close',
            can_focus: true,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        close.connect('clicked', () => this._closeSheet());
        header.add_child(close);

        this._sheetList = new St.BoxLayout({
            style_class: 'musicbar-sheet-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._sheetScroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._sheetList,
        });
        this._sheet.add_child(this._sheetScroll);

        this._sheetMessage = new St.BoxLayout({
            style_class: 'musicbar-sheet-message',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sheet.add_child(this._sheetMessage);
        this._sheetMessageIcon = new St.Icon({x_align: Clutter.ActorAlign.CENTER});
        this._sheetMessageLabel = new St.Label({style_class: 'musicbar-sheet-message-label'});
        this._sheetMessageLabel.clutter_text.line_wrap = true;
        this._sheetMessageLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._sheetMessageButton = new St.Button({
            style_class: 'musicbar-sheet-button',
            x_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
        });
        this._sheetMessageButton.connect('clicked', () => this._sheetAction?.());
        this._sheetMessage.add_child(this._sheetMessageIcon);
        this._sheetMessage.add_child(this._sheetMessageLabel);
        this._sheetMessage.add_child(this._sheetMessageButton);
    }

    _buildToast() {
        this._toast = new St.Label({
            style_class: 'musicbar-toast',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            visible: false,
            opacity: 0,
        });
        this._cover.add_child(this._toast);
    }

    // ---- state -----------------------------------------------------------

    setPalette(palette) {
        this._palette = palette;
        if (!this._settings.get_boolean('tint-popup'))
            palette = DEFAULT_PALETTE;
        const alpha = Math.clamp(this._settings.get_int('popup-opacity'), 30, 100) / 100;
        this._box.set_style(
            `background-gradient-start: ${rgba(palette.bgStart, alpha)};` +
            `background-gradient-end: ${rgba(palette.bgEnd, Math.min(1, alpha + 0.08))};`);
        this._playButton.set_style(
            `background-color: ${palette.accent}; color: ${palette.onAccent};` +
            `box-shadow: 0 4px 18px ${palette.glow};`);
        this._slider.set_style(
            `-barlevel-active-background-color: ${palette.accent}; color: ${palette.accent};`);
        this._accent = palette.accent;
        this._syncToggles();
        this._setLiked(this._liked);
    }

    setArt(uri) {
        if (uri === this._coverUri)
            return;
        this._coverUri = uri;

        const front = this._coverLayers[this._coverFront];
        const back = this._coverLayers[1 - this._coverFront];
        // Finish any running fade first so stale callbacks can't fire later.
        this._coverLayers.forEach(l => l.remove_all_transitions());

        if (!uri) {
            front.opacity = back.opacity = 0;
            this._coverPlaceholder.show();
            return;
        }

        back.set_style(`background-image: url("${uri}");`);
        this._cover.set_child_above_sibling(back, front);
        this._coverFront = 1 - this._coverFront;

        if (!this._isOpen) {
            back.opacity = 255;
            front.opacity = 0;
            this._coverPlaceholder.hide();
            return;
        }

        back.opacity = 0;
        back.ease({
            opacity: 255,
            duration: COVER_FADE_TIME,
            mode: Mode.EASE_OUT_QUAD,
            onStopped: () => {
                front.opacity = 0;
                this._coverPlaceholder.hide();
            },
        });
    }

    sync() {
        const player = this._manager.active;
        if (!player) {
            this.close();
            return;
        }

        const {track} = player;
        this._title.text = track.title || player.identity || 'Nothing playing';
        this._artist.text = track.artist;
        this._artist.visible = !!track.artist;
        this._syncDetails(track);
        this._updateMeta();

        const playing = player.isPlaying;
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playButton.accessible_name = playing ? 'Pause' : 'Play';
        this._playButton.reactive = player.canPlayPause;
        this._prevButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;

        this._progressBox.visible = track.length > 0;
        this._slider.reactive = player.canSeek;
        this._syncToggles();
        this._syncSource(player);
        this._syncVolume(player);
        this._syncSpotify();
        this.updateProgress();
    }

    /** Year and genre; looked up asynchronously when the player lacks them. */
    _syncDetails(track) {
        const enabled = this._settings.get_boolean('show-details');
        const key = enabled ? `${track.id}\n${track.artist}\n${track.title}` : null;
        if (key === this._detailsKey)
            return;
        this._detailsKey = key;
        this._detailsCancellable?.cancel();
        this._detailsText = '';
        if (!key)
            return;

        const cancellable = this._detailsCancellable = new Gio.Cancellable();
        this._detailsLookup.lookup(track, cancellable).then(({genres, year}) => {
            if (cancellable.is_cancelled() || key !== this._detailsKey)
                return;
            this._detailsText = [year, ...genres].filter(Boolean).join(' · ');
            this._updateMeta();
        });
    }

    _updateMeta() {
        const album = this._manager.active?.track.album ?? '';
        const text = [album, this._detailsText].filter(Boolean).join(' · ');
        this._meta.text = text;
        this._meta.visible = !!text;
    }

    // ---- volume ----------------------------------------------------------

    _syncVolume(player) {
        const volume = player.volume;
        this._volumeButton.visible = volume !== null;
        if (volume === null) {
            this._setVolumeOpen(false, false);
            return;
        }
        if (!this._volumeDragging) {
            this._updatingVolume = true;
            this._volumeSlider.value = volume;
            this._updatingVolume = false;
        }
        this._showVolume(volume);
    }

    _showVolume(volume) {
        let icon = 'audio-volume-high-symbolic';
        if (volume <= 0)
            icon = 'audio-volume-muted-symbolic';
        else if (volume < 0.34)
            icon = 'audio-volume-low-symbolic';
        else if (volume < 0.67)
            icon = 'audio-volume-medium-symbolic';
        this._volumeButton.child.icon_name = icon;
        this._muteButton.child.icon_name = icon;
        this._muteButton.accessible_name = volume > 0 ? 'Mute' : 'Unmute';
        this._volumeLabel.text = `${Math.round(volume * 100)}%`;
    }

    /** Fold the volume row open below the controls, or away again. */
    _setVolumeOpen(open, animate = true) {
        const row = this._volumeRow;
        if (open === this._volumeOpen && (animate || !row.get_transition('height')))
            return;
        this._volumeOpen = open;
        if (open)
            this._volumeButton.add_style_pseudo_class('checked');
        else
            this._volumeButton.remove_style_pseudo_class('checked');

        row.remove_all_transitions();
        if (!animate) {
            row.set({visible: open, opacity: open ? 255 : 0, height: -1});
            return;
        }
        if (open) {
            const [, natural] = row.get_preferred_height(this._box.get_theme_node()
                .get_content_box(this._box.get_allocation_box()).get_width());
            row.set({visible: true, height: 0, opacity: 0});
            row.ease({
                height: natural,
                opacity: 255,
                duration: VOLUME_TOGGLE_TIME,
                mode: Mode.EASE_OUT_CUBIC,
                onStopped: isFinished => {
                    if (isFinished)
                        row.height = -1;
                },
            });
        } else {
            row.ease({
                height: 0,
                opacity: 0,
                duration: VOLUME_TOGGLE_TIME,
                mode: Mode.EASE_IN_OUT_QUAD,
                onStopped: isFinished => {
                    if (isFinished)
                        row.set({visible: false, height: -1});
                },
            });
        }
    }

    /**
     * Blurred view of the windows behind the card. Shell.BlurEffect's
     * background mode can't round its corners, so this blurs a clone of the
     * window group, lined up with the screen, and rounds it before blurring.
     */
    _buildBackdrop() {
        this._backdrop = new Backdrop({x_expand: true, y_expand: true, clip_to_allocation: true});
        this._backdropClone = new Clutter.Clone({source: global.window_group});
        this._backdrop.add_child(this._backdropClone);

        // The blur has to come first: it can't render inside another
        // offscreen effect. It then blurs the already rounded clone.
        this._backdrop.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
        }));
        this._corners = new RoundedCornersEffect();
        this._backdrop.add_effect(this._corners);

        this._backdropLaterId = 0;
        this._backdrop.connect('notify::allocation', () => this._queueBackdropSync());
        this.connect('notify::allocation', () => this._queueBackdropSync());
        this.add_child(this._backdrop);
    }

    _queueBackdropSync() {
        if (this._backdropLaterId)
            return;
        // Moving the clone during allocation would re-enter the layout.
        this._backdropLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._backdropLaterId = 0;
            this._syncBackdrop();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncBackdrop() {
        const backdrop = this._backdrop;
        const box = this._box;
        backdrop.visible = this._settings.get_boolean('popup-blur');
        if (!backdrop.visible || !box.get_stage())
            return;
        // Same place as the card, whose margins leave room for the shadow.
        // Only touch them on change: that would invalidate the allocation.
        for (const margin of ['margin_top', 'margin_right', 'margin_bottom', 'margin_left']) {
            if (backdrop[margin] !== box[margin])
                backdrop[margin] = box[margin];
        }
        // The window group has no size of its own; it spans the stage.
        this._backdropClone.set_size(...global.stage.get_size());
        this._backdropClone.set_position(-(this.x + box.x), -(this.y + box.y));
        this._corners.setUniforms({
            width: box.width,
            height: box.height,
            radius: box.get_theme_node().get_border_radius(St.Corner.TOPLEFT),
        });
    }

    /** Soft shadow around the card, clipped so it never darkens the card itself. */
    _drawShadow(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const node = area.get_theme_node();
        const blur = Math.max(1, Math.round(node.get_length('-shadow-blur') || 18));
        const offset = node.get_length('-shadow-offset');
        const color = node.get_foreground_color();

        const box = this._box;
        const x = box.margin_left, y = box.margin_top;
        const w = width - x - box.margin_right, h = height - y - box.margin_bottom;
        const radius = box.get_theme_node().get_border_radius(St.Corner.TOPLEFT);

        const roundedRect = (rx, ry, rw, rh, r) => {
            r = Math.min(r, rw / 2, rh / 2);
            cr.newSubPath();
            cr.arc(rx + rw - r, ry + r, r, -Math.PI / 2, 0);
            cr.arc(rx + rw - r, ry + rh - r, r, 0, Math.PI / 2);
            cr.arc(rx + r, ry + rh - r, r, Math.PI / 2, Math.PI);
            cr.arc(rx + r, ry + r, r, Math.PI, Math.PI * 3 / 2);
            cr.closePath();
        };

        if (w > 0 && h > 0) {
            cr.rectangle(0, 0, width, height);
            roundedRect(x, y, w, h, radius);
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.clip();
            cr.setFillRule(Cairo.FillRule.WINDING);

            // Stack growing rounded rects; each adds a little alpha, so the
            // shadow is darkest at the card's edge and fades out over `blur`.
            const peak = color.alpha / 255;
            const layer = 1 - Math.pow(1 - peak, 1 / blur);
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, layer);
            for (let grow = blur; grow >= 1; grow--) {
                roundedRect(x - grow, y - grow + offset, w + 2 * grow, h + 2 * grow, radius + grow);
                cr.fill();
            }
        }
        cr.$dispose();
    }

    // ---- Spotify actions -------------------------------------------------

    get _trackUri() {
        const player = this._manager.active;
        return player?.isSpotify ? trackUriFromMpris(player.track) : null;
    }

    _syncSpotify() {
        // Opt-in: without a connected account the buttons stay hidden.
        const enabled = this._settings.get_boolean('spotify-integration') && this._spotify.isConnected;
        const uri = enabled ? this._trackUri : null;
        this._likeButton.visible = this._playlistButton.visible = !!uri;
        if (!uri)
            this._closeSheet();
        if (uri === this._likeUri)
            return;
        this._likeUri = uri;
        this._refreshSmartShuffle();
        this._setLiked(false);
        if (uri && this._spotify.isConnected)
            this._refreshLike(uri);
    }

    /** Smart Shuffle only shows up in the Web API, so ask it when it may have changed. */
    async _refreshSmartShuffle() {
        const serial = ++this._smartSerial;
        const player = this._manager.active;
        let smart = false;
        if (player?.isSpotify && player.shuffle && this._spotify.isConnected &&
            this._settings.get_boolean('spotify-integration')) {
            try {
                smart = !!await this._spotify.smartShuffle();
            } catch (e) {
                console.debug(`MusicBar: could not read Smart Shuffle: ${e.message}`);
            }
        }
        if (this._destroyed || serial !== this._smartSerial || smart === this._smartShuffle)
            return;
        this._smartShuffle = smart;
        this._syncToggles();
    }

    async _refreshLike(uri) {
        try {
            const saved = await this._spotify.isSaved(uri);
            if (!this._destroyed && uri === this._likeUri)
                this._setLiked(saved);
        } catch (e) {
            console.debug(`MusicBar: could not check library: ${e.message}`);
        }
    }

    _setLiked(liked) {
        this._liked = liked;
        this._likeButton.child.gicon = this._icon(liked
            ? 'musicbar-heart-filled-symbolic' : 'musicbar-heart-symbolic');
        this._likeButton.accessible_name = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
        this._likeButton.set_style(liked ? `color: ${this._accent};` : null);
    }

    async _toggleLike() {
        const uri = this._trackUri;
        if (!uri)
            return;
        const liked = !this._liked;
        this._setLiked(liked);
        try {
            await this._spotify.setSaved(uri, liked);
            this._showToast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
        } catch (e) {
            if (!this._destroyed && uri === this._likeUri)
                this._setLiked(!liked);
            this._showToast(e.message);
        }
    }

    _openSheet() {
        this._sheet.remove_all_transitions();
        this._sheet.show();
        this._sheet.ease({
            opacity: 255,
            duration: SHEET_FADE_TIME,
            mode: Mode.EASE_OUT_QUAD,
        });
        this._playlistButton.add_style_pseudo_class('checked');
        this._loadPlaylists(false);
    }

    _closeSheet() {
        this._sheetCancellable?.cancel();
        this._playlistButton.remove_style_pseudo_class('checked');
        if (!this._sheet.visible)
            return;
        this._sheet.ease({
            opacity: 0,
            duration: SHEET_FADE_TIME,
            mode: Mode.EASE_IN_QUAD,
            onStopped: isFinished => {
                if (isFinished)
                    this._sheet.hide();
            },
        });
    }

    _showSheetMessage(text, {icon = null, button = null, action = null} = {}) {
        this._sheetScroll.hide();
        this._sheetMessage.show();
        this._sheetMessageIcon.visible = !!icon;
        if (icon)
            this._sheetMessageIcon.icon_name = icon;
        this._sheetMessageLabel.text = text;
        this._sheetMessageButton.visible = !!button;
        this._sheetMessageButton.label = button ?? '';
        this._sheetAction = action;
    }

    async _loadPlaylists(force) {
        this._sheetCancellable?.cancel();
        const cancellable = this._sheetCancellable = new Gio.Cancellable();

        this._showSheetMessage('Loading playlists…');
        let playlists;
        try {
            playlists = await this._spotify.editablePlaylists(force);
        } catch (e) {
            if (!cancellable.is_cancelled()) {
                this._showSheetMessage(e.message, {
                    icon: 'dialog-warning-symbolic',
                    button: 'Retry',
                    action: () => this._loadPlaylists(true),
                });
            }
            return;
        }
        if (cancellable.is_cancelled())
            return;

        if (playlists.length === 0) {
            this._showSheetMessage('You have no playlists you can add songs to.', {
                icon: 'view-list-symbolic',
                button: 'Refresh',
                action: () => this._loadPlaylists(true),
            });
            return;
        }

        this._sheetList.destroy_all_children();
        for (const playlist of playlists)
            this._sheetList.add_child(this._makePlaylistRow(playlist, cancellable));
        this._sheetMessage.hide();
        this._sheetScroll.show();
    }

    _makePlaylistRow(playlist, cancellable) {
        const row = new St.Button({
            style_class: 'musicbar-sheet-row',
            accessible_name: `Add to ${playlist.name}`,
            can_focus: true,
            x_expand: true,
        });
        const box = new St.BoxLayout({style_class: 'musicbar-sheet-row-box', x_expand: true});
        row.child = box;

        const thumb = new St.Widget({
            style_class: 'musicbar-sheet-thumb',
            layout_manager: new Clutter.BinLayout(),
        });
        const thumbIcon = new St.Icon({
            icon_name: 'view-list-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        thumb.add_child(thumbIcon);
        box.add_child(thumb);
        if (playlist.image) {
            this._art.fetch(playlist.image, cancellable).then(path => {
                if (!path || cancellable.is_cancelled())
                    return;
                thumb.set_style(`background-image: url("${Gio.File.new_for_path(path).get_uri()}");`);
                thumbIcon.hide();
            }).catch(() => {});
        }

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(text);
        const name = new St.Label({text: playlist.name, style_class: 'musicbar-sheet-name'});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(name);
        if (playlist.total !== null) {
            text.add_child(new St.Label({
                text: `${playlist.total} ${playlist.total === 1 ? 'song' : 'songs'}`,
                style_class: 'musicbar-sheet-count',
            }));
        }

        row.connect('clicked', () => this._addToPlaylist(playlist));
        return row;
    }

    async _addToPlaylist(playlist) {
        const uri = this._trackUri;
        if (!uri) {
            this._showToast('This track cannot be added');
            return;
        }
        this._closeSheet();
        try {
            await this._spotify.addToPlaylist(playlist.id, uri);
            this._showToast(`Added to ${playlist.name}`);
        } catch (e) {
            this._showToast(e.message);
        }
    }

    _showToast(text) {
        if (this._destroyed)
            return;
        if (this._toastId)
            GLib.source_remove(this._toastId);
        this._toast.text = text;
        this._toast.remove_all_transitions();
        this._toast.show();
        this._toast.ease({opacity: 255, duration: 150, mode: Mode.EASE_OUT_QUAD});
        this._toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_TIME, () => {
            this._toastId = 0;
            this._toast.ease({
                opacity: 0,
                duration: 250,
                mode: Mode.EASE_IN_QUAD,
                onStopped: isFinished => {
                    if (isFinished)
                        this._toast.hide();
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncToggles() {
        const player = this._manager.active;
        const shuffle = player?.shuffle ?? null;
        const loop = player?.loopStatus ?? null;

        this._shuffleButton.visible = shuffle !== null;
        this._setToggle(this._shuffleButton, !!shuffle);
        if (shuffle && !this._lastShuffle)
            this._refreshSmartShuffle();
        this._lastShuffle = !!shuffle;
        const smart = !!shuffle && this._smartShuffle;
        this._sparkle.visible = smart;
        this._shuffleButton.accessible_name = smart ? 'Smart Shuffle' : 'Shuffle';

        this._repeatButton.visible = loop !== null;
        this._repeatButton.child.icon_name = loop === 'Track'
            ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._setToggle(this._repeatButton, loop === 'Playlist' || loop === 'Track');
    }

    _setToggle(button, active) {
        if (active) {
            button.add_style_pseudo_class('checked');
            button.set_style(`color: ${this._accent};`);
        } else {
            button.remove_style_pseudo_class('checked');
            button.set_style(null);
        }
    }

    _syncSource(player) {
        const entry = player.desktopEntry;
        this._app = entry ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`) : null;
        this._cover.reactive = player.canRaise || !!this._app;
        this._cover.accessible_name = `Open ${player.identity}`;
    }

    _openPlayer() {
        const player = this._manager.active;
        if (player?.canRaise)
            player.raise();
        else
            this._app?.activate();
        this.close();
    }

    updateProgress() {
        const player = this._manager.active;
        if (!player || this.dragging || this._seekId)
            return;
        const length = player.track.length;
        const position = player.position;

        this._updatingSlider = true;
        this._slider.value = length > 0 ? Math.clamp(position / length, 0, 1) : 0;
        this._updatingSlider = false;
        this._updateTimeLabels(position);
    }

    _updateTimeLabels(position) {
        const length = this._manager.active?.track.length ?? 0;
        this._elapsed.text = formatTime(position);
        this._total.text = this._showRemaining
            ? `-${formatTime(length - position)}` : formatTime(length);
    }

    _queueSeek() {
        if (this._seekId)
            GLib.source_remove(this._seekId);
        this._seekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_DEBOUNCE, () => {
            this._seekId = 0;
            this._seekToSlider();
            return GLib.SOURCE_REMOVE;
        });
    }

    _seekToSlider() {
        const player = this._manager.active;
        if (player?.canSeek)
            player.seekTo(this._slider.value * player.track.length);
    }

    // ---- showing ---------------------------------------------------------

    open(anchor) {
        if (!this._manager.active)
            return;
        this._anchor = anchor;
        this.sync();
        this._place(anchor);

        if (this._isOpen)
            return;
        this._manager.active.resync();
        this._refreshSmartShuffle();
        this._isOpen = true;

        const preset = ANIMATIONS[this._settings.get_string('open-animation')] ?? ANIMATIONS.cascade;
        const fresh = this.opacity === 0;
        this.remove_all_transitions();
        this.show();

        if (fresh)
            this._animateItems(preset.items);

        const popup = preset.popup;
        if (!popup) {
            this.set({opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0});
            return;
        }
        if (fresh) {
            this.scale_x = this.scale_y = popup.scale ?? 1;
            this.translation_y = (popup.shift ?? 0) * (this._below ? -1 : 1);
        }
        // Opacity gets its own, non-overshooting curve.
        this.ease({opacity: 255, duration: Math.min(popup.duration, SHOW_TIME), mode: Mode.EASE_OUT_QUAD});
        this.ease({
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: popup.duration,
            mode: popup.mode,
        });
    }

    /** The elements that slide in, ordered from the panel side outwards. */
    _animatedItems() {
        const items = [
            this._cover,
            this._title, this._artist, this._meta,
            this._actions,
            this._progressBox,
            ...this._controlButtons,
        ];
        return this._below ? items : items.reverse();
    }

    _animateItems(spec) {
        const items = this._animatedItems();
        for (const item of items) {
            item.remove_all_transitions();
            item.set({opacity: 255, translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1});
        }
        if (!spec)
            return;

        const dir = this._below ? -1 : 1;
        let delay = 0;
        for (const item of items.filter(i => i.visible)) {
            item.set_pivot_point(0.5, 0.5);
            item.set({
                opacity: 0,
                translation_x: spec.slide ?? 0,
                translation_y: (spec.shift ?? 0) * -dir,
                scale_x: spec.scale ?? 1,
                scale_y: spec.scale ?? 1,
            });
            item.ease({
                opacity: 255,
                delay,
                duration: Math.round(spec.duration * 0.7),
                mode: Mode.EASE_OUT_QUAD,
            });
            item.ease({
                translation_x: 0,
                translation_y: 0,
                scale_x: 1,
                scale_y: 1,
                delay,
                duration: spec.duration,
                mode: spec.mode,
            });
            delay += spec.stagger;
        }
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._closeSheet();
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            translation_y: this._below ? -6 : 6,
            duration: HIDE_TIME,
            mode: Mode.EASE_IN_QUAD,
            onStopped: isFinished => {
                if (isFinished) {
                    this.hide();
                    this._setVolumeOpen(false, false);
                }
            },
        });
    }

    /** Position the card next to `anchor`, on the side facing the screen center. */
    _place(anchor) {
        const [ax, ay] = anchor.get_transformed_position();
        const [aw, ah] = anchor.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(anchor) ??
            Main.layoutManager.primaryMonitor;

        // The frame is larger than the card by the card's margins (shadow room).
        const box = this._box;
        const [, frameWidth] = this.get_preferred_width(-1);
        const [, frameHeight] = this.get_preferred_height(frameWidth);
        const width = frameWidth - box.margin_left - box.margin_right;
        const height = frameHeight - box.margin_top - box.margin_bottom;

        const centerY = ay + ah / 2;
        this._below = centerY < monitor.y + monitor.height / 2;

        let x = ax + aw / 2 - width / 2;
        x = Math.clamp(x, monitor.x + MARGIN, monitor.x + monitor.width - width - MARGIN);
        const y = this._below ? ay + ah + GAP : ay - height - GAP;

        this.set_position(Math.round(x - box.margin_left), Math.round(y - box.margin_top));
        this.set_pivot_point(
            Math.clamp((ax + aw / 2 - x + box.margin_left) / frameWidth, 0, 1),
            this._below ? box.margin_top / frameHeight : 1 - box.margin_bottom / frameHeight);
    }
});
