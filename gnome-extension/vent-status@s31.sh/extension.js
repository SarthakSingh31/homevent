import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ENDPOINT = 'http://vent.home/';
const POLL_SECONDS = 10;

// The service reports the active target as an enum variant name but does NOT send the
// metric's current reading directly — it lives under `quality` keyed by the camelCase
// `field` below. This table maps each target variant to its quality field, display
// label, and unit, and also drives the full readings list shown in the dropdown.
const METRICS = [
    {key: 'Co2',  field: 'rco2',            label: 'CO₂',   unit: 'ppm'},
    {key: 'Pm02', field: 'pm02Compensated', label: 'PM2.5', unit: 'µg/m³'},
    {key: 'Tvoc', field: 'tvocIndex',       label: 'TVOC',  unit: ''},
    {key: 'Nox',  field: 'noxIndex',        label: 'NOx',   unit: ''},
];

// Whole numbers render plainly; fractional readings get one decimal.
const fmt = (v) => (Number.isInteger(v) ? `${v}` : v.toFixed(1));

// Revolution time at full duty (ms) and the slowest spin we still animate. Duration
// scales as FULL_SPEED_MS / duty, so higher duty -> shorter period -> faster spin.
const FULL_SPEED_MS = 700;
const SLOWEST_MS = 6000;

const VentIndicator = GObject.registerClass(
class VentIndicator extends PanelMenu.Button {
    _init(iconPath) {
        // 0.5 = menu centered under the button (boxpointer then clamps it on-screen).
        // 0.0 would anchor the menu's left edge to the button, shoving it rightward.
        super._init(0.5, 'Vent Status');

        this._session = new Soup.Session();
        this._session.timeout = 5;
        this._cancellable = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box vent-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${iconPath}/icons/fan-symbolic.svg`),
            style_class: 'system-status-icon vent-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Rotate about the icon's center so it spins in place like a fan.
        this._icon.set_pivot_point(0.5, 0.5);

        // Continuous spin driven by the actor's frame clock; speed is set per-update from
        // the duty cycle. The timeline loops forever and we map progress -> 0..360°.
        this._spin = new Clutter.Timeline({actor: this._icon, duration: FULL_SPEED_MS});
        this._spin.set_repeat_count(-1);
        this._spin.connect('new-frame', () => {
            this._icon.rotation_angle_z = this._spin.get_progress() * 360;
        });
        // If the actor is torn down without disable() running (e.g. shell shutdown), stop
        // the timeline first so a queued frame can't poke the disposed icon.
        this._icon.connect('destroy', () => {
            if (this._spin) {
                this._spin.stop();
                this._spin = null;
            }
        });

        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'vent-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        // Dropdown shows the live reading for every metric (the panel already covers the
        // active target + duty, so repeating it here would add nothing). One row per
        // metric, kept by key so we can update them in place; the active target is marked
        // with an ornament dot and annotated with its setpoint.
        this._metricRows = {};
        for (const m of METRICS) {
            const item = new PopupMenu.PopupMenuItem(`${m.label}: …`, {reactive: false});
            this._metricRows[m.key] = item;
            this.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh');
        refresh.connect('activate', () => this._fetch());
        this.menu.addMenuItem(refresh);
    }

    _fetch() {
        // Cancel any in-flight request so we never race two responses.
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        const msg = Soup.Message.new('GET', ENDPOINT);
        this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, res) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._renderError();
                    return;
                }
                if (msg.get_status() !== Soup.Status.OK) {
                    this._renderError();
                    return;
                }
                try {
                    const text = new TextDecoder().decode(bytes.get_data());
                    this._render(JSON.parse(text));
                } catch (e) {
                    this._renderError();
                }
            });
    }

    _render(data) {
        const metric = data?.target?.metric;
        const setpoint = data?.target?.value;
        const duty = data?.duty_cycle;
        const quality = data?.quality;
        const target = METRICS.find((m) => m.key === metric);
        const current = target ? quality?.[target.field] : undefined;

        if (target === undefined || setpoint === undefined ||
            duty === undefined || quality === undefined || current === undefined) {
            this._renderError();
            return;
        }

        const dutyPct = Math.round(duty * 100);
        this._label.remove_style_class_name('vent-dim');
        this._label.text =
            `${dutyPct}%  ·  ${metric} ${Math.round(current)}/${Math.round(setpoint)}`;
        this._setSpin(duty);

        for (const m of METRICS) {
            const row = this._metricRows[m.key];
            const v = quality[m.field];
            const value = v === undefined ? '—' : fmt(v);
            const unit = m.unit ? ` ${m.unit}` : '';
            const isTarget = m.key === metric;
            row.label.text = isTarget
                ? `${m.label}: ${value}${unit}  (target ${fmt(setpoint)})`
                : `${m.label}: ${value}${unit}`;
            row.setOrnament(isTarget ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        }
    }

    _renderError() {
        this._label.add_style_class_name('vent-dim');
        this._label.text = '—';
        this._setSpin(0);
        for (const m of METRICS) {
            const row = this._metricRows[m.key];
            row.label.text = `${m.label}: —`;
            row.setOrnament(PopupMenu.Ornament.NONE);
        }
    }

    // Map duty cycle to spin speed. At/near zero the fan is off, so freeze it upright;
    // otherwise scale the revolution period inversely with duty (clamped to SLOWEST_MS).
    _setSpin(duty) {
        if (!duty || duty <= 0.01) {
            if (this._spin.is_playing())
                this._spin.stop();
            this._icon.rotation_angle_z = 0;
            return;
        }
        this._spin.set_duration(Math.round(Math.min(SLOWEST_MS, FULL_SPEED_MS / duty)));
        if (!this._spin.is_playing())
            this._spin.start();
    }

    destroy() {
        if (this._spin) {
            this._spin.stop();
            this._spin = null;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }
});

export default class VentStatusExtension extends Extension {
    enable() {
        this._indicator = new VentIndicator(this.path);
        Main.panel.addToStatusArea('vent-status', this._indicator);

        this._indicator._fetch();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                this._indicator._fetch();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
