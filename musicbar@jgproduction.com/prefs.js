// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    REDIRECT_PORT, REDIRECT_URI, SpotifyClient, buildAuthorizeUrl, createPkce, createState,
} from './spotify.js';

const LOGIN_TIMEOUT = 5 * 60;
const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>MusicBar</title>
<body style="font:16px system-ui;background:#111316;color:#fff;display:grid;place-items:center;height:90vh">
<div style="text-align:center"><h2>%s</h2><p style="opacity:.6">You can close this tab.</p></div>`;

function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        row.selected = Math.max(0, choices.findIndex(([v]) => v === settings.get_string(key)));
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, choices[row.selected][0]));
    settings.connect(`changed::${key}`, sync);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max, step) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.title = title;
    row.subtitle = subtitle;
    row.value = settings.get_int(key);
    row.connect('notify::value', () => settings.set_int(key, row.value));
    settings.connect(`changed::${key}`, () => {
        row.value = settings.get_int(key);
    });
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class MusicBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'MusicBar',
            icon_name: 'audio-x-generic-symbolic',
        });
        window.add(page);

        const panel = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(panel);
        panel.add(comboRow(settings, 'panel-position', 'Position', 'Where in the top bar the controls appear', [
            ['left', 'Left'], ['center', 'Center'], ['right', 'Right'],
        ]));
        panel.add(spinRow(settings, 'panel-index', 'Order', 'Index within the chosen area', 0, 20, 1));
        panel.add(switchRow(settings, 'tint-panel', 'Cover color', 'Tint the controls with the dominant color of the cover art'));
        panel.add(switchRow(settings, 'show-progress', 'Progress ring', 'Trace the song position around the controls'));
        panel.add(comboRow(settings, 'scroll-action', 'Scroll action', 'What scrolling over the controls does', [
            ['none', 'Nothing'], ['track', 'Previous / next track'], ['seek', 'Seek 5 seconds'],
        ]));

        const popup = new Adw.PreferencesGroup({title: 'Popup'});
        page.add(popup);
        popup.add(switchRow(settings, 'tint-popup', 'Cover color', 'Tint the popup background with the cover art'));
        popup.add(spinRow(settings, 'popup-opacity', 'Opacity', 'Background opacity in percent', 30, 100, 5));
        popup.add(switchRow(settings, 'popup-blur', 'Blur', 'Blur the windows behind the popup'));
        popup.add(comboRow(settings, 'open-animation', 'Open animation', 'How the popup and its contents appear', [
            ['cascade', 'Cascade'],
            ['spring', 'Spring'],
            ['sweep', 'Sweep'],
            ['zoom', 'Zoom'],
            ['fade', 'Fade'],
            ['none', 'None'],
        ]));
        popup.add(switchRow(settings, 'show-details', 'Genre and year',
            'Looked up on MusicBrainz when the player does not provide them'));
        popup.add(spinRow(settings, 'open-delay', 'Open delay', 'Milliseconds of hovering before the popup appears', 0, 2000, 25));
        popup.add(spinRow(settings, 'close-delay', 'Close delay', 'Milliseconds before the popup hides after the pointer leaves', 50, 3000, 25));

        const players = new Adw.PreferencesGroup({title: 'Players'});
        page.add(players);
        players.add(switchRow(settings, 'spotify-only', 'Spotify only',
            'Ignore other MPRIS players like browsers. When off, Spotify is still preferred.'));

        page.add(this._buildSpotifyGroup(window, settings));
    }

    _buildSpotifyGroup(window, settings) {
        const client = new SpotifyClient(settings);
        window.connect('close-request', () => {
            this._stopLogin();
            client.destroy();
            return false;
        });

        const group = new Adw.PreferencesGroup({title: 'Spotify Account'});

        // Opt-in: everything below only matters once the switch is on.
        const expander = new Adw.ExpanderRow({
            title: 'Like and add to playlists',
            subtitle: 'Needs a Spotify Premium account and your own free developer app. ' +
                `Create one in the dashboard, tick “Web API”, add ${REDIRECT_URI} as ` +
                'redirect URI and paste its Client ID below.',
            show_enable_switch: true,
        });
        settings.bind('spotify-integration', expander, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        expander.expanded = settings.get_boolean('spotify-integration');
        group.add(expander);

        const dashboardRow = new Adw.ActionRow({
            title: 'Spotify Developer Dashboard',
            subtitle: 'developer.spotify.com/dashboard',
            activatable: true,
        });
        dashboardRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        dashboardRow.connect('activated', () =>
            new Gtk.UriLauncher({uri: 'https://developer.spotify.com/dashboard'}).launch(window, null, null));
        expander.add_row(dashboardRow);

        const redirectRow = new Adw.ActionRow({
            title: 'Redirect URI',
            subtitle: REDIRECT_URI,
            subtitle_selectable: true,
        });
        expander.add_row(redirectRow);

        const clientIdRow = new Adw.EntryRow({title: 'Client ID'});
        clientIdRow.text = settings.get_string('spotify-client-id');
        expander.add_row(clientIdRow);

        const statusRow = new Adw.ActionRow({title: 'Account'});
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        statusRow.add_suffix(button);
        expander.add_row(statusRow);

        const sync = () => {
            const connected = !!settings.get_string('spotify-refresh-token');
            const user = settings.get_string('spotify-user');
            if (this._login) {
                statusRow.subtitle = 'Waiting for authorization in your browser…';
                button.label = 'Cancel';
                button.remove_css_class('destructive-action');
                button.remove_css_class('suggested-action');
            } else if (connected) {
                statusRow.subtitle = `Connected as ${user || 'unknown user'}`;
                button.label = 'Disconnect';
                button.remove_css_class('suggested-action');
                button.add_css_class('destructive-action');
            } else {
                statusRow.subtitle = 'Not connected';
                button.label = 'Connect';
                button.remove_css_class('destructive-action');
                button.add_css_class('suggested-action');
            }
            button.sensitive = !!this._login || connected || /^[0-9a-f]{32}$/i.test(clientIdRow.text.trim());
        };
        this._syncSpotify = sync;
        clientIdRow.connect('changed', sync);
        settings.connect('changed::spotify-refresh-token', sync);
        settings.connect('changed::spotify-user', sync);

        button.connect('clicked', () => {
            if (this._login)
                this._stopLogin();
            else if (settings.get_string('spotify-refresh-token'))
                client.disconnect();
            else
                this._startLogin(window, client, clientIdRow.text.trim());
            sync();
        });
        sync();
        return group;
    }

    _startLogin(window, client, clientId) {
        const {verifier, challenge} = createPkce();
        const state = createState();
        const server = new Soup.Server();

        const finish = (message, title) => {
            message.set_status(200, null);
            const html = DONE_PAGE.replace('%s', GLib.markup_escape_text(title, -1));
            message.set_response('text/html; charset=utf-8', Soup.MemoryUse.COPY,
                new TextEncoder().encode(html));
        };

        server.add_handler('/callback', (_server, message) => {
            const query = message.get_uri().get_query() ?? '';
            const params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
            if (params.state !== state) {
                finish(message, 'Login request did not match, please try again.');
                return;
            }
            if (params.error || !params.code) {
                finish(message, `Spotify login failed: ${params.error ?? 'no code'}`);
                this._stopLogin();
                this._toast(window, `Spotify login failed: ${params.error ?? 'no code'}`);
                return;
            }
            finish(message, 'MusicBar is connected to Spotify');
            // Respond first, then trade the code for tokens outside the handler.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._stopLogin();
                client.exchangeCode(clientId, params.code, verifier)
                    .then(me => this._toast(window, `Connected as ${me.display_name || me.id}`))
                    .catch(e => this._toast(window, `Spotify login failed: ${e.message}`))
                    .finally(() => this._syncSpotify?.());
                return GLib.SOURCE_REMOVE;
            });
        });

        try {
            server.listen_local(REDIRECT_PORT, Soup.ServerListenOptions.IPV4_ONLY);
        } catch (e) {
            this._toast(window, `Could not listen on port ${REDIRECT_PORT}: ${e.message}`);
            return;
        }

        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LOGIN_TIMEOUT, () => {
            this._login.timeoutId = 0;
            this._stopLogin();
            this._toast(window, 'Spotify login timed out');
            return GLib.SOURCE_REMOVE;
        });
        this._login = {server, timeoutId};

        new Gtk.UriLauncher({uri: buildAuthorizeUrl(clientId, challenge, state)})
            .launch(window, null, null);
    }

    _stopLogin() {
        if (!this._login)
            return;
        const {server, timeoutId} = this._login;
        this._login = null;
        if (timeoutId)
            GLib.source_remove(timeoutId);
        server.disconnect();
        this._syncSpotify?.();
    }

    _toast(window, title) {
        window.add_toast(new Adw.Toast({title, timeout: 4}));
    }
}
