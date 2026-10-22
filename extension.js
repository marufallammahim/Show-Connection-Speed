// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_INTERVAL_SECONDS = 1;
const PLACEHOLDER_TEXT = '↓ --  ↑ --';
const USABLE_OPERSTATES = ['up', 'unknown', 'dormant'];
const RTF_UP = 0x1;

function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function loadContents(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (source, result) => {
            try {
                resolve(source.load_contents_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Resolves to the file's text, or null if it cannot be read. Only a
// cancellation is re-thrown, so callers can stop work when disabled.
async function readTextFile(path, cancellable) {
    try {
        const [ok, contents] = await loadContents(
            Gio.File.new_for_path(path), cancellable);
        return ok ? new TextDecoder().decode(contents) : null;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

async function readCounter(path, cancellable) {
    const text = await readTextFile(path, cancellable);
    if (text === null)
        return null;

    const value = Number.parseInt(text.trim(), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function isInterfaceUsable(iface, cancellable) {
    if (!iface || iface === 'lo')
        return false;

    const state = await readTextFile(`/sys/class/net/${iface}/operstate`, cancellable);
    return !state || USABLE_OPERSTATES.includes(state.trim());
}

// IPv4: /proc/net/route, columns are
// Iface Destination Gateway Flags RefCnt Use Metric Mask ...
async function findIPv4DefaultInterface(cancellable) {
    const text = await readTextFile('/proc/net/route', cancellable);
    if (!text)
        return null;

    let best = null;
    for (const line of text.trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 8 || fields[1] !== '00000000' ||
            fields[7] !== '00000000')
            continue;

        const iface = fields[0];
        const flags = Number.parseInt(fields[3], 16);
        const metric = Number.parseInt(fields[6], 10);
        if (!(flags & RTF_UP) || !Number.isFinite(metric))
            continue;

        if (best && metric >= best.metric)
            continue;

        if (await isInterfaceUsable(iface, cancellable))
            best = {iface, metric};
    }
    return best?.iface ?? null;
}

// IPv6: /proc/net/ipv6_route, columns are
// dest prefix src prefix nexthop metric refcnt use flags iface
async function findIPv6DefaultInterface(cancellable) {
    const text = await readTextFile('/proc/net/ipv6_route', cancellable);
    if (!text)
        return null;

    let best = null;
    for (const line of text.trim().split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || fields[1] !== '00' ||
            !/^0+$/.test(fields[0]))
            continue;

        const iface = fields[9];
        const metric = Number.parseInt(fields[5], 16);
        const flags = Number.parseInt(fields[8], 16);
        if (!(flags & RTF_UP) || !Number.isFinite(metric))
            continue;

        if (best && metric >= best.metric)
            continue;

        if (await isInterfaceUsable(iface, cancellable))
            best = {iface, metric};
    }
    return best?.iface ?? null;
}

async function findDefaultInterface(cancellable) {
    return await findIPv4DefaultInterface(cancellable) ??
        await findIPv6DefaultInterface(cancellable);
}

function formatValue(value, units) {
    if (!Number.isFinite(value) || value < 0)
        return `0 ${units[0]}`;

    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatRate(bytesPerSecond) {
    return formatValue(bytesPerSecond, ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']);
}

function formatBytes(bytes) {
    return formatValue(bytes, ['B', 'KB', 'MB', 'GB', 'TB']);
}

export default class NetworkSpeedExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._updating = false;
        this._lastSample = null;
        this._sessionRx = 0;
        this._sessionTx = 0;

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        this._label = new St.Label({
            text: PLACEHOLDER_TEXT,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._label);

        this._interfaceItem = new PopupMenu.PopupMenuItem('Detecting network…', {
            reactive: false,
            can_focus: false,
        });
        this._sessionItem = new PopupMenu.PopupMenuItem('Session: --', {
            reactive: false,
            can_focus: false,
        });
        this._indicator.menu.addMenuItem(this._interfaceItem);
        this._indicator.menu.addMenuItem(this._sessionItem);

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._update();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_SECONDS, () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            });
        GLib.Source.set_name_by_id(this._timeoutId,
            `[${this.uuid}] refresh speed`);
    }

    disable() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }

        this._cancellable?.cancel();
        this._cancellable = null;

        this._label?.destroy();
        this._label = null;
        this._interfaceItem?.destroy();
        this._interfaceItem = null;
        this._sessionItem?.destroy();
        this._sessionItem = null;
        this._indicator?.destroy();
        this._indicator = null;

        this._lastSample = null;
        this._updating = false;
    }

    _showUnavailable(message) {
        this._lastSample = null;
        this._label.set_text(PLACEHOLDER_TEXT);
        this._interfaceItem.label.set_text(message);
    }

    async _update() {
        // Skip a tick if the previous read has not finished yet
        if (this._updating || !this._cancellable)
            return;

        const cancellable = this._cancellable;
        this._updating = true;
        try {
            const iface = await findDefaultInterface(cancellable);
            if (this._cancellable !== cancellable)
                return;

            if (!iface) {
                this._showUnavailable('No active network connection');
                return;
            }

            const [rx, tx] = await Promise.all([
                readCounter(`/sys/class/net/${iface}/statistics/rx_bytes`, cancellable),
                readCounter(`/sys/class/net/${iface}/statistics/tx_bytes`, cancellable),
            ]);
            if (this._cancellable !== cancellable)
                return;

            if (rx === null || tx === null) {
                this._showUnavailable(`${iface}: statistics unavailable`);
                return;
            }

            this._applySample(iface, rx, tx, GLib.get_monotonic_time());
        } catch (e) {
            if (!isCancelled(e))
                console.error(`${this.uuid}: update failed: ${e.message}`);
        } finally {
            // Ignore a stale run that was cancelled by disable()
            if (this._cancellable === cancellable)
                this._updating = false;
        }
    }

    _applySample(iface, rx, tx, now) {
        const last = this._lastSample;

        if (last && last.iface === iface) {
            const elapsed = (now - last.time) / 1_000_000;
            if (elapsed > 0) {
                const rxDelta = Math.max(0, rx - last.rx);
                const txDelta = Math.max(0, tx - last.tx);
                this._sessionRx += rxDelta;
                this._sessionTx += txDelta;

                this._label.set_text(
                    `↓ ${formatRate(rxDelta / elapsed)}  ↑ ${formatRate(txDelta / elapsed)}`);
                this._sessionItem.label.set_text(
                    `Session: ↓ ${formatBytes(this._sessionRx)}  ↑ ${formatBytes(this._sessionTx)}`);
            }
        } else {
            this._label.set_text(PLACEHOLDER_TEXT);
        }

        this._lastSample = {iface, rx, tx, time: now};
        this._interfaceItem.label.set_text(`Interface: ${iface}`);
    }
}
