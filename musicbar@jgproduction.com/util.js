// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

/** Gently grow `target` while `hoverSource` is hovered, shrink a bit while pressed. */
export function addHoverScale(target, hoverSource, scale = 1.08) {
    target.set_pivot_point(0.5, 0.5);
    const update = () => {
        let s = 1;
        if (hoverSource.reactive && hoverSource.hover)
            s = hoverSource.pressed ? scale * 0.92 : scale;
        target.ease({
            scale_x: s,
            scale_y: s,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    };
    hoverSource.connect('notify::hover', update);
    if ('pressed' in hoverSource)
        hoverSource.connect('notify::pressed', update);
    hoverSource.connect('notify::reactive', update);
}

/** Format microseconds as m:ss or h:mm:ss. */
export function formatTime(us) {
    const total = Math.max(0, Math.floor(us / 1e6));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Define an offscreen effect that runs a GLSL fragment snippet with float
 * uniforms, set through `setUniforms({name: value})`. GNOME Shell 51 replaced
 * Shell.GLSLEffect with snippet-based Clutter.ShaderEffects, so this picks
 * whichever the running version has.
 */
export function defineShaderEffect(name, declarations, code) {
    const GTypeName = `MusicBar${name}`;
    if (Shell.GLSLEffect) {
        class GLSLShaderEffect extends Shell.GLSLEffect {
            vfunc_build_pipeline() {
                this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
            }

            setUniforms(values) {
                for (const [uniform, value] of Object.entries(values))
                    this.set_uniform_float(this.get_uniform_location(uniform), 1, [value]);
                this.queue_repaint();
            }
        }
        return GObject.registerClass({GTypeName}, GLSLShaderEffect);
    }

    class SnippetShaderEffect extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code);
        }

        setUniforms(values) {
            // Whole numbers would arrive as ints, which don't set float uniforms.
            for (const [uniform, value] of Object.entries(values)) {
                const gvalue = new GObject.Value();
                gvalue.init(GObject.TYPE_DOUBLE);
                gvalue.set_double(value);
                this.set_uniform_value(uniform, gvalue);
            }
            this.queue_repaint();
        }
    }
    return GObject.registerClass({GTypeName}, SnippetShaderEffect);
}
