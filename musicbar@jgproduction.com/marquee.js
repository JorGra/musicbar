// SPDX-License-Identifier: GPL-3.0-or-later
// A one-line label that scrolls its text when it doesn't fit.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {defineShaderEffect} from './util.js';

// Pixels per second.
const SPEED = 30;
// Time the start of the text stays readable before each pass.
const PAUSE = 2000;
// Space between the end of the text and the start of its repeat.
const GAP = 48;
// Width of the soft edges the text fades out at.
const FADE = 20;

const FADE_DECLARATIONS = `
uniform float fade_left;
uniform float fade_right;
`;
const FADE_CODE = `
float x = cogl_tex_coord_in[0].x;
float alpha = 1.0;
if (fade_left > 0.0)
    alpha *= clamp(x / fade_left, 0.0, 1.0);
if (fade_right > 0.0)
    alpha *= clamp((1.0 - x) / fade_right, 0.0, 1.0);
cogl_color_out *= alpha;
`;

/** Fades the left and right edges of an actor; widths are fractions of its width. */
const EdgeFadeEffect = defineShaderEffect('EdgeFadeEffect', FADE_DECLARATIONS, FADE_CODE);

/** Whether moving text is welcome: animations on, no reduced motion (GNOME 51+). */
function motionAllowed() {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return false;
    return !St.ReducedMotion || settings.reduced_motion !== St.ReducedMotion.REDUCE;
}

/**
 * Drop-in for a single-line St.Label. Overflowing text loops from right to
 * left while the label is on screen and falls back to an ellipsis when
 * animations are off or reduced motion is requested.
 */
export const MarqueeLabel = GObject.registerClass(
class MarqueeLabel extends St.Widget {
    _init(params = {}) {
        super._init({...params, clip_to_allocation: true});

        // The copy follows the text so the loop wraps around seamlessly.
        this._label = new St.Label();
        this._copy = new St.Label({visible: false});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._label);
        this.add_child(this._copy);

        this._fade = new EdgeFadeEffect();
        this._fade.enabled = false;
        this.add_effect(this._fade);
        this._label.connect('notify::translation-x', () => this._updateFade());

        this._textWidth = 0;
        this._overflow = false;
        this._updateLaterId = 0;

        const settings = St.Settings.get();
        this._settingsIds = ['enable-animations', 'reduced-motion']
            .filter(name => GObject.Object.find_property.call(St.Settings, name))
            .map(name => settings.connect(`notify::${name}`, () => this.queue_relayout()));
        this.connect('notify::mapped', () => this._queueUpdate());
        this.connect('destroy', () => this._onDestroy());
    }

    get text() {
        return this._label.text;
    }

    set text(text) {
        if (text === this._label.text)
            return;
        this._label.text = text;
        this._copy.text = text;
        this._stop();
        this._queueUpdate();
    }

    vfunc_get_preferred_width(_forHeight) {
        const [, natural] = this._label.get_preferred_width(-1);
        return this.get_theme_node().adjust_preferred_width(0, natural);
    }

    vfunc_get_preferred_height(_forWidth) {
        const [min, natural] = this._label.get_preferred_height(-1);
        return this.get_theme_node().adjust_preferred_height(min, natural);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const [, textWidth] = this._label.get_preferred_width(-1);
        const [, height] = this._label.get_preferred_height(-1);
        const available = content.get_width();
        const overflow = textWidth > available && motionAllowed();

        // While scrolling the text gets its full width; otherwise it is
        // clamped to the available space and ellipsized.
        const child = new Clutter.ActorBox();
        child.set_origin(content.x1, content.y1);
        child.set_size(overflow ? textWidth : available, height);
        this._label.allocate(child);
        child.set_origin(content.x1 + textWidth + GAP, content.y1);
        child.set_size(textWidth, height);
        this._copy.allocate(child);

        if (overflow !== this._overflow || textWidth !== this._textWidth) {
            this._overflow = overflow;
            this._textWidth = textWidth;
            // Starting transitions during allocation would re-enter the layout.
            this._queueUpdate();
        }
    }

    _queueUpdate() {
        if (this._updateLaterId)
            return;
        const laters = global.compositor.get_laters();
        this._updateLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._updateLaterId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        this._stop();
        this._copy.visible = this._overflow;
        this._fade.enabled = this._overflow;
        this._updateFade();
        if (this._overflow && this.mapped)
            this._scroll();
    }

    _scroll() {
        const distance = this._textWidth + GAP;
        const params = {
            translation_x: -distance,
            delay: PAUSE,
            duration: distance / SPEED * 1000,
            mode: Clutter.AnimationMode.LINEAR,
        };
        this._label.translation_x = 0;
        this._copy.translation_x = 0;
        this._copy.ease(params);
        this._label.ease({...params, onComplete: () => this._scroll()});
    }

    _updateFade() {
        const width = this.width;
        if (!this._fade.enabled || width <= 0)
            return;
        // The left edge only fades while the text is moving, so the start of
        // the text is crisp during the pause.
        const offset = -this._label.translation_x;
        const left = Math.clamp(Math.min(offset, this._textWidth + GAP - offset), 0, FADE);
        this._fade.setUniforms({fade_left: left / width, fade_right: FADE / width});
    }

    _stop() {
        for (const label of [this._label, this._copy]) {
            label.remove_all_transitions();
            label.translation_x = 0;
        }
    }

    _onDestroy() {
        if (this._updateLaterId)
            global.compositor.get_laters().remove(this._updateLaterId);
        const settings = St.Settings.get();
        this._settingsIds.forEach(id => settings.disconnect(id));
    }
});
