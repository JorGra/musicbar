// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal Spotify Web API client (Authorization Code + PKCE).
// Used by both the shell (playlists, likes) and the prefs window (login).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';

export const REDIRECT_PORT = 8898;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
export const SCOPES = [
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-public',
    'playlist-modify-private',
    'user-library-read',
    'user-library-modify',
    'user-read-playback-state',
].join(' ');

const PLAYLIST_CACHE_TIME = 5 * 60 * 1000;

export class SpotifyError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.status = status;
    }
}

function encodeForm(params) {
    return Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

function base64Url(bytes) {
    return GLib.base64_encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

/** Bytes from the kernel's CSPRNG; GLib's own random functions are not secure. */
function secureRandom(length) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        return stream.read_bytes(length, null).toArray();
    } finally {
        stream.close(null);
    }
}

/** Random string for the OAuth `state` parameter. */
export function createState() {
    return base64Url(secureRandom(24));
}

/** Create a PKCE verifier/challenge pair. */
export function createPkce() {
    const verifier = base64Url(secureRandom(48));
    const digest = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, verifier, -1);
    return {verifier, challenge: base64Url(hexToBytes(digest))};
}

export function buildAuthorizeUrl(clientId, challenge, state) {
    return `${ACCOUNTS}/authorize?${encodeForm({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: SCOPES,
        state,
    })}`;
}

/** Track URI for an MPRIS track id like "/com/spotify/track/<id>". */
export function trackUriFromMpris(track) {
    const fromId = /^\/com\/spotify\/(track|episode)\/([A-Za-z0-9]+)$/.exec(track.id ?? '');
    if (fromId)
        return `spotify:${fromId[1]}:${fromId[2]}`;
    const fromUrl = /open\.spotify\.com\/(track|episode)\/([A-Za-z0-9]+)/.exec(track.url ?? '');
    if (fromUrl)
        return `spotify:${fromUrl[1]}:${fromUrl[2]}`;
    return null;
}

export class SpotifyClient {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session({timeout: 15});
        this._accessToken = null;
        this._accessExpiry = 0;
        this._refreshing = null;
        this._savingToken = false;
        this._noPlaybackScope = false;
        this._playlists = null;
        this._playlistsTime = 0;
        this._me = null;

        this._settingsId = settings.connect('changed::spotify-refresh-token', () => {
            if (this._savingToken)
                return;
            this._accessToken = null;
            this._playlists = null;
            this._me = null;
            this._noPlaybackScope = false;
        });
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._session.abort();
    }

    get isConnected() {
        return !!this._settings.get_string('spotify-client-id') &&
            !!this._settings.get_string('spotify-refresh-token');
    }

    // ---- HTTP ------------------------------------------------------------

    _send(method, url, {body = null, contentType = 'application/json', token = null} = {}, cancellable = null) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new(method, url);
            if (token)
                message.request_headers.append('Authorization', `Bearer ${token}`);
            if (body !== null) {
                const data = contentType === 'application/json' ? JSON.stringify(body) : body;
                message.set_request_body_from_bytes(contentType,
                    new GLib.Bytes(new TextEncoder().encode(data)));
            }
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        const status = message.get_status();
                        const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
                        let json = null;
                        try {
                            json = text ? JSON.parse(text) : null;
                        } catch {}
                        if (status < 200 || status >= 300) {
                            const reason = json?.error?.message ?? json?.error_description ??
                                json?.error ?? `HTTP ${status}`;
                            reject(new SpotifyError(String(reason), status));
                            return;
                        }
                        resolve(json);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _token() {
        if (this._accessToken && Date.now() < this._accessExpiry)
            return Promise.resolve(this._accessToken);
        // Refresh tokens rotate, so parallel requests must share one refresh.
        this._refreshing ??= this._refresh().finally(() => {
            this._refreshing = null;
        });
        return this._refreshing;
    }

    async _refresh() {
        const clientId = this._settings.get_string('spotify-client-id');
        const refreshToken = this._settings.get_string('spotify-refresh-token');
        if (!clientId || !refreshToken)
            throw new SpotifyError('Not connected to Spotify', 401);

        let json;
        try {
            json = await this._send('POST', `${ACCOUNTS}/api/token`, {
                contentType: 'application/x-www-form-urlencoded',
                body: encodeForm({grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId}),
            });
        } catch (e) {
            if (e.status === 400) {
                // Token revoked or expired: force a fresh login.
                this._settings.set_string('spotify-refresh-token', '');
                throw new SpotifyError('Spotify login expired, reconnect in settings', 401);
            }
            throw e;
        }
        this._storeTokens(json);
        return this._accessToken;
    }

    _storeTokens(json) {
        this._accessToken = json.access_token;
        this._accessExpiry = Date.now() + (json.expires_in - 60) * 1000;
        // PKCE refresh tokens rotate; persist the new one.
        if (json.refresh_token) {
            this._savingToken = true;
            this._settings.set_string('spotify-refresh-token', json.refresh_token);
            this._savingToken = false;
        }
    }

    async _api(method, path, body = null, cancellable = null) {
        const url = path.startsWith('http') ? path : `${API}${path}`;
        try {
            return await this._send(method, url, {body, token: await this._token()}, cancellable);
        } catch (e) {
            if (e.status !== 401)
                throw e;
            this._accessToken = null;
            return this._send(method, url, {body, token: await this._token()}, cancellable);
        }
    }

    // ---- login (prefs) ---------------------------------------------------

    async exchangeCode(clientId, code, verifier) {
        const json = await this._send('POST', `${ACCOUNTS}/api/token`, {
            contentType: 'application/x-www-form-urlencoded',
            body: encodeForm({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: clientId,
                code_verifier: verifier,
            }),
        });
        this._settings.set_string('spotify-client-id', clientId);
        this._storeTokens(json);
        const me = await this.me();
        this._settings.set_string('spotify-user', me.display_name || me.id);
        return me;
    }

    disconnect() {
        this._settings.set_string('spotify-refresh-token', '');
        this._settings.set_string('spotify-user', '');
        this._accessToken = null;
        this._playlists = null;
        this._me = null;
    }

    // ---- API -------------------------------------------------------------

    async me() {
        this._me ??= await this._api('GET', '/me');
        return this._me;
    }

    /** Playlists the user can add to (owned or collaborative), cached briefly. */
    async editablePlaylists(force = false) {
        if (!force && this._playlists && Date.now() - this._playlistsTime < PLAYLIST_CACHE_TIME)
            return this._playlists;

        const me = await this.me();
        const all = [];
        let next = '/me/playlists?limit=50';
        while (next && all.length < 500) {
            const page = await this._api('GET', next);
            all.push(...(page.items ?? []).filter(Boolean));
            next = page.next;
        }
        this._playlists = all
            .filter(p => p.owner?.id === me.id || p.collaborative)
            .map(p => ({
                id: p.id,
                name: p.name,
                image: p.images?.at(-1)?.url ?? p.images?.[0]?.url ?? null,
                total: p.items?.total ?? p.tracks?.total ?? null,
            }));
        this._playlistsTime = Date.now();
        return this._playlists;
    }

    async addToPlaylist(playlistId, uri) {
        await this._api('POST', `/playlists/${playlistId}/items`, {uris: [uri]});
        const playlist = this._playlists?.find(p => p.id === playlistId);
        if (playlist && playlist.total !== null)
            playlist.total++;
    }

    /** Smart Shuffle is not exposed over MPRIS; null when unknown. */
    async smartShuffle() {
        if (this._noPlaybackScope)
            return null;
        try {
            const state = await this._api('GET', '/me/player');
            return state ? !!state.smart_shuffle : null;
        } catch (e) {
            // Logins from before the playback scope was requested; reconnecting fixes it.
            if (e.status === 401 || e.status === 403)
                this._noPlaybackScope = true;
            throw e;
        }
    }

    async isSaved(uri) {
        const [saved] = await this._api('GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`);
        return !!saved;
    }

    async setSaved(uri, saved) {
        await this._api(saved ? 'PUT' : 'DELETE', '/me/library', {uris: [uri]});
    }
}
