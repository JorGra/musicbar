// SPDX-License-Identifier: GPL-3.0-or-later
// Cover art download/cache and cover-based color palettes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';

const MAX_CACHED_FILES = 200;
const MAX_CACHED_PALETTES = 100;

// ---- color helpers -------------------------------------------------------

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    if (s === 0)
        return [l * 255, l * 255, l * 255];
    const hue2rgb = (p, q, t) => {
        if (t < 0)
            t += 1;
        if (t > 1)
            t -= 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

function rgb(h, s, l) {
    return hslToRgb(h, Math.clamp(s, 0, 1), Math.clamp(l, 0, 1)).map(Math.round);
}

function css(h, s, l, a = 1) {
    const [r, g, b] = rgb(h, s, l);
    return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

/** CSS color for an [r, g, b] array with alpha. */
export function rgba([r, g, b], a = 1) {
    return `rgba(${r},${g},${b},${a})`;
}

/**
 * Find the most prominent "vivid" color of an image. Pixels are bucketed by
 * hue and weighted by saturation and brightness, so a cover that is mostly
 * grey with a bold red logo yields red rather than grey.
 */
export function extractColor(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 48, 48, false);
    const data = pixbuf.read_pixel_bytes().get_data();
    const nChannels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();

    const NEUTRAL = 12;
    const bins = Array.from({length: NEUTRAL + 1}, () => ({r: 0, g: 0, b: 0, w: 0}));

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * nChannels;
            if (nChannels === 4 && data[i + 3] < 128)
                continue;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
            const sat = max === 0 ? 0 : (max - min) / max;

            let bin, weight;
            if (sat < 0.2 || max < 0.18) {
                bin = NEUTRAL;
                weight = 0.15;
            } else {
                bin = Math.floor(rgbToHsl(r, g, b)[0] * 12) % 12;
                weight = (0.2 + sat) * (0.3 + max);
            }
            const target = bins[bin];
            target.r += r * weight;
            target.g += g * weight;
            target.b += b * weight;
            target.w += weight;
        }
    }

    const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w === 0)
        return null;
    return {r: best.r / best.w, g: best.g / best.w, b: best.b / best.w};
}

/** Derive all UI colors from one cover color. */
export function makePalette(color) {
    if (!color)
        return DEFAULT_PALETTE;

    const [h, s] = rgbToHsl(color.r, color.g, color.b);
    const grey = s < 0.12;
    const sat = Math.min(s, 0.8);
    const accentSat = grey ? sat : Math.max(sat, 0.5);

    return {
        tinted: true,
        bgStart: rgb(h, sat * 0.6, 0.25),
        bgEnd: rgb(h, sat * 0.5, 0.09),
        accent: css(h, accentSat, grey ? 0.9 : 0.7),
        onAccent: css(h, accentSat * 0.6, 0.1),
        glow: css(h, accentSat, 0.5, 0.45),
    };
}

export const DEFAULT_PALETTE = {
    tinted: false,
    bgStart: [43, 47, 54],
    bgEnd: [17, 19, 22],
    accent: '#1ed760',
    onAccent: '#06240f',
    glow: 'rgba(30,215,96,0.35)',
};

// ---- loader --------------------------------------------------------------

/** Spotify serves 300px covers via MPRIS; the 640px variant looks sharper. */
function upgradeUrl(url) {
    return url
        .replace('https://open.spotify.com/image/', 'https://i.scdn.co/image/')
        .replace(/(i\.scdn\.co\/image\/ab67616d)00001e02/, (_m, prefix) => `${prefix}0000b273`);
}

export class ArtLoader {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'musicbar']);
        GLib.mkdir_with_parents(this._dir, 0o755);
        this._session = new Soup.Session({timeout: 15});
        this._palettes = new Map();
        this._prune();
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }

    /** Resolve `url` to a local file and its palette. Returns null for unusable URLs. */
    async load(url, cancellable) {
        const path = await this.fetch(url, cancellable);
        if (!path)
            return null;

        let palette = this._palettes.get(path);
        if (!palette) {
            try {
                palette = makePalette(extractColor(path));
            } catch {
                // Broken download: drop it so it is fetched again next time.
                if (path.startsWith(this._dir))
                    GLib.unlink(path);
                return null;
            }
            if (this._palettes.size > MAX_CACHED_PALETTES)
                this._palettes.clear();
            this._palettes.set(path, palette);
        }
        return {path, uri: Gio.File.new_for_path(path).get_uri(), palette};
    }

    /** Resolve `url` to a local file path (downloading into the cache), or null. */
    async fetch(url, cancellable) {
        let path;
        if (url.startsWith('file://')) {
            path = Gio.File.new_for_uri(url).get_path();
        } else if (url.startsWith('/')) {
            path = url;
        } else if (/^https?:\/\//.test(url)) {
            url = upgradeUrl(url);
            path = GLib.build_filenamev([this._dir,
                GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)]);
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                await this._download(url, path, cancellable);
        } else {
            return null;
        }

        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS))
            return null;
        return path;
    }

    _download(url, path, cancellable) {
        return new Promise((resolve, reject) => {
            if (!this._session) {
                reject(new Error('Cover loader was destroyed'));
                return;
            }
            const message = Soup.Message.new('GET', url);
            if (!message) {
                reject(new Error(`Invalid URL ${url}`));
                return;
            }
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        if (message.get_status() !== Soup.Status.OK)
                            throw new Error(`HTTP ${message.get_status()} for ${url}`);
                        GLib.file_set_contents(path, bytes.get_data());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /** Keep the cache directory from growing forever. */
    _prune() {
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const enumerator = dir.enumerate_children('standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
            const files = [];
            let info;
            while ((info = enumerator.next_file(null)))
                files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
            enumerator.close(null);

            if (files.length <= MAX_CACHED_FILES)
                return;
            files.sort((a, b) => a[1] - b[1]);
            for (const [name] of files.slice(0, files.length - MAX_CACHED_FILES))
                dir.get_child(name).delete(null);
        } catch (e) {
            console.debug(`MusicBar: cache prune failed: ${e.message}`);
        }
    }
}
