#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Mirror MPRIS players from the host session bus into a nested session bus.

A nested (devkit) GNOME Shell runs on its own D-Bus session, so it cannot see
the real Spotify. This relay owns the same org.mpris.MediaPlayer2.* names on
the nested bus and forwards method calls, properties and signals to the host.

Usage: HOST_BUS=<host bus address> mpris-relay.py   (run inside the nested bus)
"""

import os

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

PREFIX = 'org.mpris.MediaPlayer2.'
PATH = '/org/mpris/MediaPlayer2'
SKIP = {'org.mpris.MediaPlayer2.playerctld'}
BUILTIN = {'org.freedesktop.DBus.Properties', 'org.freedesktop.DBus.Introspectable',
           'org.freedesktop.DBus.Peer'}
BUS_FLAGS = (Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
             Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION)

host = Gio.DBusConnection.new_for_address_sync(os.environ['HOST_BUS'], BUS_FLAGS, None, None)
nested_address = os.environ['DBUS_SESSION_BUS_ADDRESS']
mirrors = {}


def bus_call(conn, method, args, reply):
    return conn.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                          method, args, GLib.VariantType(reply), Gio.DBusCallFlags.NONE, -1, None)


class Mirror:
    def __init__(self, name):
        self.name = name
        owner = bus_call(host, 'GetNameOwner', GLib.Variant('(s)', (name,)), '(s)').unpack()[0]
        xml = host.call_sync(name, PATH, 'org.freedesktop.DBus.Introspectable', 'Introspect',
                             None, GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, -1, None).unpack()[0]
        self.node = Gio.DBusNodeInfo.new_for_xml(xml)

        # One connection per player: objects are registered per connection.
        self.conn = Gio.DBusConnection.new_for_address_sync(nested_address, BUS_FLAGS, None, None)
        self.regs = [self.conn.register_object(PATH, iface, self.call, self.get, self.set)
                     for iface in self.node.interfaces if iface.name not in BUILTIN]
        self.sub = host.signal_subscribe(owner, None, None, PATH, None, Gio.DBusSignalFlags.NONE,
                                         self.signal)
        bus_call(self.conn, 'RequestName', GLib.Variant('(su)', (name, 4)), '(u)')
        print(f'mirroring {name}', flush=True)

    def call(self, _conn, _sender, path, iface, method, params, invocation):
        def done(conn, res):
            try:
                invocation.return_value(conn.call_finish(res))
            except GLib.Error as e:
                invocation.return_gerror(e)
        host.call(self.name, path, iface, method, params, None, Gio.DBusCallFlags.NONE, -1, None, done)

    def get(self, _conn, _sender, path, iface, prop):
        try:
            return host.call_sync(self.name, path, 'org.freedesktop.DBus.Properties', 'Get',
                                  GLib.Variant('(ss)', (iface, prop)), GLib.VariantType('(v)'),
                                  Gio.DBusCallFlags.NONE, -1, None).get_child_value(0).get_variant()
        except GLib.Error:
            return None

    def set(self, _conn, _sender, path, iface, prop, value):
        host.call_sync(self.name, path, 'org.freedesktop.DBus.Properties', 'Set',
                       GLib.Variant('(ssv)', (iface, prop, value)), None,
                       Gio.DBusCallFlags.NONE, -1, None)
        return True

    def signal(self, _conn, _sender, path, iface, signal, params):
        self.conn.emit_signal(None, path, iface, signal, params)

    def close(self):
        host.signal_unsubscribe(self.sub)
        self.conn.close_sync(None)
        print(f'dropped {self.name}', flush=True)


def update(name, present):
    if not name.startswith(PREFIX) or name in SKIP:
        return
    if name in mirrors:
        mirrors.pop(name).close()
    if present:
        try:
            mirrors[name] = Mirror(name)
        except GLib.Error as e:
            print(f'cannot mirror {name}: {e.message}', flush=True)


def owner_changed(_conn, _sender, _path, _iface, _signal, params):
    name, _old, new = params.unpack()
    update(name, bool(new))


host.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                      '/org/freedesktop/DBus', None, Gio.DBusSignalFlags.NONE, owner_changed)
for bus_name in bus_call(host, 'ListNames', None, '(as)').unpack()[0]:
    update(bus_name, True)

GLib.MainLoop().run()
