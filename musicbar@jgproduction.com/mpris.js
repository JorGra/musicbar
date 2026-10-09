// SPDX-License-Identifier: GPL-3.0-or-later
// MPRIS player discovery and state tracking.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';

// Bus names that only mirror other players.
const IGNORED_PLAYERS = [/^org\.mpris\.MediaPlayer2\.playerctld/];

const RootIfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const PlayerIfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="Seek">
      <arg direction="in" type="x" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`;

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function emptyTrack() {
    return {
        id: '', title: '', artists: [], artist: '', album: '', artUrl: '', length: 0, url: '',
        genres: [], year: '',
    };
}

export class Player extends Signals.EventEmitter {
    constructor(busName, proxies) {
        super();
        this.busName = busName;
        this.track = emptyTrack();
        this.ready = false;
        this._proxies = proxies;
        this._root = null;
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        this._position = 0;
        this._positionTime = GLib.get_monotonic_time();
    }

    get isSpotify() {
        return /spotify/i.test(this.busName) || /spotify/i.test(this.identity);
    }

    async init() {
        const bus = Gio.DBus.session;
        [this._root, this._proxy] = await Promise.all([
            this._proxies.root.newAsync(bus, this.busName, MPRIS_PATH, this._cancellable),
            this._proxies.player.newAsync(bus, this.busName, MPRIS_PATH, this._cancellable),
        ]);

        this._propsId = this._proxy.connect('g-properties-changed',
            (_p, changed) => this._onPropertiesChanged(changed.deepUnpack()));
        this._seekedId = this._proxy.connectSignal('Seeked',
            (_p, _sender, [position]) => this._setPosition(position));

        this._updateTrack();
        this._syncPosition();
    }

    destroy() {
        this._cancellable.cancel();
        if (this._proxy) {
            this._proxy.disconnect(this._propsId);
            this._proxy.disconnectSignal(this._seekedId);
        }
        this._proxy = null;
        this._root = null;
    }

    // ---- state -----------------------------------------------------------

    get identity() {
        return this._root?.Identity ?? this.busName.slice(MPRIS_PREFIX.length).split('.')[0];
    }

    get desktopEntry() {
        return this._root?.DesktopEntry ?? '';
    }

    get canRaise() {
        return this._root?.CanRaise ?? false;
    }

    get status() {
        return this._proxy?.PlaybackStatus ?? 'Stopped';
    }

    get isPlaying() {
        return this.status === 'Playing';
    }

    get canGoNext() {
        return this._proxy?.CanGoNext ?? false;
    }

    get canGoPrevious() {
        return this._proxy?.CanGoPrevious ?? false;
    }

    get canPlayPause() {
        return (this._proxy?.CanPlay || this._proxy?.CanPause) ?? false;
    }

    get canSeek() {
        return (this._proxy?.CanSeek ?? false) && this.track.length > 0;
    }

    // null when the player does not expose the property
    get shuffle() {
        return this._proxy?.Shuffle ?? null;
    }

    get loopStatus() {
        return this._proxy?.LoopStatus ?? null;
    }

    /** 0..1, or null when the player has no volume control. */
    get volume() {
        const volume = this._proxy?.Volume;
        if (typeof volume !== 'number' || this._proxy?.CanControl === false)
            return null;
        return Math.clamp(volume, 0, 1);
    }

    get rate() {
        const rate = this._proxy?.Rate;
        return typeof rate === 'number' && rate > 0 ? rate : 1;
    }

    /** Interpolated playback position in microseconds. */
    get position() {
        let pos = this._position;
        if (this.isPlaying)
            pos += (GLib.get_monotonic_time() - this._positionTime) * this.rate;
        if (this.track.length > 0)
            pos = Math.min(pos, this.track.length);
        return Math.max(0, pos);
    }

    // ---- actions ---------------------------------------------------------

    playPause() {
        this._proxy?.PlayPauseRemote(() => {});
    }

    next() {
        this._proxy?.NextRemote(() => {});
    }

    previous() {
        this._proxy?.PreviousRemote(() => {});
    }

    raise() {
        this._root?.RaiseRemote(() => {});
    }

    seekTo(positionUs) {
        if (!this._proxy)
            return;
        positionUs = Math.round(Math.clamp(positionUs, 0, this.track.length || positionUs));

        const id = this.track.id;
        if (id && GLib.Variant.is_object_path(id))
            this._proxy.SetPositionRemote(id, positionUs, () => {});
        else
            this._proxy.SeekRemote(Math.round(positionUs - this.position), () => {});

        // Optimistic update; the player confirms with Seeked.
        this._setPosition(positionUs);
    }

    seekBy(offsetUs) {
        this.seekTo(this.position + offsetUs);
    }

    setShuffle(shuffle) {
        this._setProperty('Shuffle', GLib.Variant.new_boolean(shuffle));
    }

    setLoopStatus(status) {
        this._setProperty('LoopStatus', GLib.Variant.new_string(status));
    }

    setVolume(volume) {
        if (!this._proxy)
            return;
        const value = GLib.Variant.new_double(Math.clamp(volume, 0, 1));
        this._setProperty('Volume', value);
        // Optimistic: not every player signals volume changes.
        this._proxy.set_cached_property('Volume', value);
    }

    // ---- internals -------------------------------------------------------

    _setProperty(name, value) {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, PROPS_IFACE, 'Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE, name, value]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    if (!isCancelled(e))
                        console.debug(`MusicBar: cannot set ${name}: ${e.message}`);
                }
            });
    }

    _syncPosition() {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const [value] = conn.call_finish(res).deepUnpack();
                    this._setPosition(Number(value.unpack()));
                } catch {
                    // Some players do not implement Position.
                }
            });
    }

    /** Re-read the position from the player (positions are not signalled). */
    resync() {
        if (!this._proxy)
            return;
        this._syncPosition();
        this._syncVolume();
    }

    /** Spotify does not signal volume changes made in its own window; poll it. */
    _syncVolume() {
        if (typeof this._proxy?.Volume !== 'number')
            return;
        Gio.DBus.session.call(this.busName, MPRIS_PATH, PROPS_IFACE, 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Volume']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const [value] = conn.call_finish(res).deepUnpack();
                    if (!this._proxy || value.unpack() === this._proxy.Volume)
                        return;
                    this._proxy.set_cached_property('Volume', value);
                    this.emit('changed');
                } catch {
                    // Volume is optional.
                }
            });
    }

    _setPosition(positionUs) {
        this._position = Number(positionUs);
        this._positionTime = GLib.get_monotonic_time();
        this.emit('position-changed');
    }

    _updateTrack() {
        const meta = this._proxy?.Metadata ?? {};
        const get = key => meta[key]?.recursiveUnpack() ?? null;

        const list = key => {
            const value = get(key) ?? [];
            return (typeof value === 'string' ? [value] : value).filter(Boolean);
        };
        const artists = list('xesam:artist');

        const old = this.track;
        this.track = {
            id: String(get('mpris:trackid') ?? ''),
            title: get('xesam:title') ?? '',
            artists,
            artist: artists.join(', '),
            album: get('xesam:album') ?? '',
            artUrl: get('mpris:artUrl') ?? '',
            length: Number(get('mpris:length') ?? 0),
            url: get('xesam:url') ?? '',
            genres: list('xesam:genre'),
            year: /^\d{4}/.exec(get('xesam:contentCreated') ?? '')?.[0] ?? '',
        };

        const changed = old.id !== this.track.id || old.title !== this.track.title;
        if (changed) {
            this._setPosition(0);
            this._syncPosition();
        }
        return changed;
    }

    _onPropertiesChanged(changed) {
        if ('Metadata' in changed && this._updateTrack())
            this.emit('track-changed');
        if ('PlaybackStatus' in changed) {
            // Freeze the interpolated position at the moment of the change,
            // then ask the player for the authoritative value.
            this._position = this.position;
            this._positionTime = GLib.get_monotonic_time();
            this._syncPosition();
        }
        this.emit('changed');
    }
}

/**
 * Watches the session bus for MPRIS players and picks the one to show.
 *
 * Signals:
 *   'active-changed'   the active player was replaced (or is now null)
 *   'changed'          state of the active player changed
 *   'track-changed'    the active player moved to another track
 *   'position-changed' the active player reported a new position
 */
export class PlayerManager extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._players = new Map();
        this._proxies = {
            root: Gio.DBusProxy.makeProxyWrapper(RootIfaceXml),
            player: Gio.DBusProxy.makeProxyWrapper(PlayerIfaceXml),
        };
        this._nameOwnerId = 0;
        this._cancellable = null;
        this.active = null;

        this._settingsId = settings.connect('changed::spotify-only', () => this._choose());
    }

    start() {
        const bus = Gio.DBus.session;
        this._nameOwnerId = bus.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        this._cancellable = new Gio.Cancellable();
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX))
                        .forEach(n => this._addPlayer(n));
                } catch (e) {
                    if (!isCancelled(e))
                        logError(e, 'MusicBar: ListNames failed');
                }
            });
    }

    destroy() {
        this._cancellable?.cancel();
        if (this._nameOwnerId)
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
        this._settings.disconnect(this._settingsId);
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
        this.active = null;
    }

    async _addPlayer(busName) {
        if (this._players.has(busName) || IGNORED_PLAYERS.some(re => re.test(busName)))
            return;

        const player = new Player(busName, this._proxies);
        this._players.set(busName, player);
        try {
            await player.init();
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`MusicBar: ignoring ${busName}: ${e.message}`);
            if (this._players.get(busName) === player)
                this._players.delete(busName);
            player.destroy();
            return;
        }

        if (this._players.get(busName) !== player) {
            player.destroy();
            return;
        }

        player.ready = true;
        player.connect('changed', () => {
            this._choose();
            if (player === this.active)
                this.emit('changed');
        });
        player.connect('track-changed', () => {
            if (player === this.active)
                this.emit('track-changed');
        });
        player.connect('position-changed', () => {
            if (player === this.active)
                this.emit('position-changed');
        });
        this._choose();
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        this._players.delete(busName);
        player.destroy();
        if (player === this.active)
            this.active = null;
        this._choose(true);
    }

    _choose(force = false) {
        const spotifyOnly = this._settings.get_boolean('spotify-only');
        const candidates = [...this._players.values()]
            .filter(p => p.ready && (!spotifyOnly || p.isSpotify));

        const score = p =>
            (p.isPlaying ? 4 : 0) +
            (p === this.active ? 2 : 0) +
            (p.isSpotify ? 1 : 0);

        let best = null;
        for (const p of candidates) {
            if (!best || score(p) > score(best))
                best = p;
        }

        if (best !== this.active || force) {
            this.active = best;
            this.emit('active-changed');
        }
    }
}
