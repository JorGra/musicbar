// SPDX-License-Identifier: GPL-3.0-or-later
// Genre and release year for the current track, looked up on MusicBrainz
// when the player does not provide them (Spotify never does).

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const API = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'MusicBar/1.0 ( https://github.com/JorGra/musicbar )';
// MusicBrainz allows one request per second per client.
const REQUEST_INTERVAL = 1100;
const MIN_SCORE = 90;
const MAX_GENRES = 2;
const CACHE_SIZE = 300;

const EMPTY = Object.freeze({genres: [], year: ''});

function luceneQuote(text) {
    return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

/** Drop decorations like "(feat. X)" or " - 2011 Remaster" that hurt matching. */
function cleanTitle(title) {
    return title
        .replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/gi, '')
        .replace(/\s+-\s+.*\b(remaster(ed)?|version|edit|mix|live|mono|stereo)\b.*$/i, '')
        .trim() || title;
}

/** "A Night at the Opera (2011 Remaster)" -> "A Night at the Opera" */
function cleanAlbum(album) {
    return album
        .replace(/\s*[([][^)\]]*\b(remaster(ed)?|deluxe|edition|expanded|anniversary|version|bonus)\b[^)\]]*[)\]]/gi, '')
        .replace(/\s+-\s+.*\b(remaster(ed)?|deluxe|edition)\b.*$/i, '')
        .trim() || album;
}

function earliestYear(items) {
    return items
        .map(r => /^\d{4}/.exec(r['first-release-date'] ?? '')?.[0])
        .filter(Boolean)
        .sort()[0] ?? '';
}

function normalize(text) {
    return text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** "contemporary r&b" -> "Contemporary R&B" */
function titleCase(genre) {
    return genre.replace(/(^|[\s-])(\p{L})/gu, (_m, sep, c) => sep + c.toUpperCase())
        .replace(/\bR&b\b/g, 'R&B');
}

function topNames(items) {
    return (items ?? [])
        .filter(t => t.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_GENRES)
        .map(t => titleCase(t.name));
}

class LruCache extends Map {
    get(key) {
        if (!super.has(key))
            return undefined;
        const value = super.get(key);
        super.delete(key);
        super.set(key, value);
        return value;
    }

    set(key, value) {
        super.delete(key);
        super.set(key, value);
        if (this.size > CACHE_SIZE)
            this.delete(this.keys().next().value);
        return this;
    }
}

export class DetailsLookup {
    constructor() {
        this._session = new Soup.Session({timeout: 15, user_agent: USER_AGENT});
        this._tracks = new LruCache();
        this._artists = new LruCache();
        this._queue = Promise.resolve();
        this._lastRequest = 0;
        this._timeoutIds = new Set();
    }

    destroy() {
        this._timeoutIds.forEach(id => GLib.source_remove(id));
        this._timeoutIds.clear();
        this._session.abort();
    }

    /**
     * Resolve {genres, year} for `track`. Values the player already provides
     * win; only the missing ones are looked up. Never throws.
     */
    async lookup(track, cancellable) {
        const own = {genres: track.genres ?? [], year: track.year ?? ''};
        if ((own.genres.length && own.year) || !track.title || !track.artists?.length)
            return own;

        const key = `${normalize(track.artists[0])}\n${normalize(track.title)}\n${normalize(track.album ?? '')}`;
        let found = this._tracks.get(key);
        if (!found) {
            try {
                found = await this._search(track, cancellable);
            } catch (e) {
                if (!cancellable?.is_cancelled())
                    console.debug(`MusicBar: genre lookup failed: ${e.message}`);
                return own;
            }
            this._tracks.set(key, found);
        }
        return {
            genres: own.genres.length ? own.genres : found.genres,
            year: own.year || found.year,
        };
    }

    async _search(track, cancellable) {
        const artist = track.artists[0];
        const wanted = normalize(artist);
        const byArtist = r => (r['artist-credit'] ?? [])
            .some(c => normalize(c.name ?? c.artist?.name ?? '') === wanted);
        const search = async (entity, field, title) => {
            const query = `${field}:${luceneQuote(title)} AND artist:${luceneQuote(artist)}`;
            const json = await this._get(`/${entity}?fmt=json&limit=10&query=${encodeURIComponent(query)}`,
                cancellable);
            return (json?.[`${entity}s`] ?? []).filter(r => (r.score ?? 0) >= MIN_SCORE && byArtist(r));
        };

        const matches = await search('recording', 'recording', cleanTitle(track.title));
        if (!matches.length)
            return EMPTY;

        // The year shown is the album's, like in the players themselves.
        // Popular songs have hundreds of recordings (live, compilations), so
        // the earliest recording found is only a fallback.
        let year = '';
        if (track.album)
            year = earliestYear(await search('release-group', 'releasegroup', cleanAlbum(track.album)));
        year ||= earliestYear(matches);

        // Recording tags are sparse; fall back to the artist's genres.
        const tags = new Map();
        for (const r of matches) {
            for (const t of r.tags ?? [])
                tags.set(t.name, (tags.get(t.name) ?? 0) + t.count);
        }
        let genres = topNames([...tags].map(([name, count]) => ({name, count})));
        if (!genres.length) {
            const artistId = matches[0]['artist-credit']
                .find(c => normalize(c.name ?? c.artist?.name ?? '') === wanted)?.artist?.id;
            if (artistId)
                genres = await this._artistGenres(artistId, cancellable);
        }
        return {genres, year};
    }

    async _artistGenres(id, cancellable) {
        let genres = this._artists.get(id);
        if (!genres) {
            const json = await this._get(`/artist/${id}?fmt=json&inc=genres`, cancellable);
            genres = topNames(json?.genres);
            this._artists.set(id, genres);
        }
        return genres;
    }

    /** Rate-limited GET; requests run one after another. */
    _get(path, cancellable) {
        const run = async () => {
            const wait = this._lastRequest + REQUEST_INTERVAL - Date.now();
            if (wait > 0)
                await this._sleep(wait);
            if (cancellable?.is_cancelled())
                throw new Error('cancelled');
            this._lastRequest = Date.now();
            return this._fetch(`${API}${path}`, cancellable);
        };
        const result = this._queue.then(run, run);
        this._queue = result.catch(() => {});
        return result;
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timeoutIds.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timeoutIds.add(id);
        });
    }

    _fetch(url, cancellable) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);
            message.request_headers.append('Accept', 'application/json');
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        const status = message.get_status();
                        if (status !== 200)
                            throw new Error(`HTTP ${status}`);
                        resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
