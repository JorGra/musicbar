// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';

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
