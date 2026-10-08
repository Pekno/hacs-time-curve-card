import { TimeCurveCard } from '../src/index.js';
import { PRESET_NAMES, normalizeConfig, type PresetName } from '../src/config.js';
import {
  evaluateCurve,
  formatTime,
  formatValue,
  isValidCurve,
  maxValue,
  parseCurve,
  type ValueRange,
} from '../src/core/curve.js';
import type { CardConfig } from '../src/types.js';
import { MockHass, type MockEntityInit } from './mock-hass.js';

// Minimal <ha-card> stand-in so the harness looks like a dashboard card.
class HaCardStub extends HTMLElement {
  private headerText = '';

  get header(): string {
    return this.headerText;
  }

  /** Lit assigns `.header` on every render where the title changed: keep the heading in sync. */
  set header(value: string | null | undefined) {
    this.headerText = value ?? '';
    if (this.isConnected) this.render();
  }

  connectedCallback(): void {
    this.style.display = 'block';
    this.style.background = 'var(--card-background-color)';
    this.style.borderRadius = 'var(--ha-card-border-radius, 12px)';
    this.style.boxShadow = 'var(--ha-card-box-shadow, none)';
    this.style.color = 'var(--primary-text-color)';
    this.style.overflow = 'hidden';
    this.render();
  }

  render(): void {
    let h = this.querySelector<HTMLElement>(':scope > h1.card-header');
    if (this.headerText) {
      if (!h) {
        h = document.createElement('h1');
        h.className = 'card-header';
        h.style.cssText =
          'font-size:24px;font-weight:400;margin:0;padding:12px 16px 4px;letter-spacing:-0.012em;line-height:48px';
        this.prepend(h);
      }
      h.textContent = this.headerText;
    } else if (h) {
      h.remove();
    }
  }
}
customElements.define('ha-card', HaCardStub);

// ---------------------------------------------------------------------------------------------
// Entities and defaults
// ---------------------------------------------------------------------------------------------

/**
 * What the harness shows for one preset (`preset=` URL parameter): the generic example entities
 * of its package in ha/ (and of the tests), the card title, the value of the priority-rule
 * toggle, the extra config keys, and the target entity with its mock state.
 */
interface HarnessPreset {
  curve: string;
  sensor: string;
  enabled: string;
  /** Harness-only card title (a generic card has no title by default). */
  title: string;
  /**
   * Value of the sensor while the harness's priority-rule toggle is on: a stand-in for any
   * higher-priority rule of a user's package (e.g. a fixed value while an alarm is armed).
   */
  overrideValue: number;
  /** Config keys beyond `preset` (the `custom` preset needs its range). */
  config: Partial<CardConfig>;
  target: string;
  /** Default state of the target entity (`target=` overrides it). */
  targetState: string;
  targetAttributes: (state: string) => Record<string, unknown>;
}

/** HA brightness attribute (0-255) of the mock light when it is on: 153 = 60 %. */
const DEFAULT_BRIGHTNESS = 153;
/** `current_temperature` of the mock thermostat (`current=` overrides it, empty = none). */
const DEFAULT_CURRENT_TEMPERATURE = 19.5;

const params = new URLSearchParams(location.search);

/** Attributes of the mock light: its brightness when on (or as the URL asks). */
function lightAttributes(state: string): Record<string, unknown> {
  // Like HA, an off / unavailable light reports no brightness unless the URL asks for one.
  const brightness = intParam('brightness', 0, 255) ?? (state === 'on' ? DEFAULT_BRIGHTNESS : null);
  return { friendly_name: 'Example lamp', brightness };
}

const HARNESS_PRESETS: Readonly<Record<PresetName, HarnessPreset>> = {
  brightness: {
    curve: 'input_text.brightness_curve',
    sensor: 'sensor.brightness_curve_target',
    enabled: 'input_boolean.brightness_curve_enabled',
    title: 'Courbe du soir',
    overrideValue: 80,
    config: {},
    target: 'light.example_lamp',
    targetState: 'on',
    targetAttributes: lightAttributes,
  },
  temperature: {
    curve: 'input_text.heating_curve',
    sensor: 'sensor.heating_curve_target',
    enabled: 'input_boolean.heating_curve_enabled',
    title: 'Chauffage',
    overrideValue: 16,
    config: { preset: 'temperature' },
    target: 'climate.your_thermostat',
    targetState: 'heat',
    targetAttributes: () => {
      const raw = params.get('current');
      const current = raw === null ? DEFAULT_CURRENT_TEMPERATURE : raw === '' ? null : Number(raw);
      return {
        friendly_name: 'Thermostat',
        ...(current === null || !Number.isFinite(current) ? {} : { current_temperature: current }),
      };
    },
  },
  color_temp: {
    curve: 'input_text.color_temp_curve',
    sensor: 'sensor.color_temp_curve_target',
    enabled: 'input_boolean.color_temp_curve_enabled',
    title: 'Temp\u{e9}rature de couleur',
    overrideValue: 3000,
    config: { preset: 'color_temp' },
    target: 'light.example_lamp',
    targetState: 'on',
    targetAttributes: lightAttributes,
  },
  custom: {
    curve: 'input_text.custom_curve',
    sensor: 'sensor.custom_curve_target',
    enabled: 'input_boolean.custom_curve_enabled',
    title: 'Courbe personnalis\u{e9}e',
    overrideValue: 0,
    config: { preset: 'custom', min: -5, max: 5, step: 0.25, label: 'D\u{e9}calage' },
    target: 'sensor.example_humidity',
    targetState: '48.5',
    targetAttributes: () => ({ friendly_name: 'Humidit\u{e9}', unit_of_measurement: '%' }),
  },
};

/** The preset of the page (`preset=`, brightness by default). */
const PRESET: PresetName =
  PRESET_NAMES.find((name) => name === params.get('preset')) ?? 'brightness';
const HARNESS = HARNESS_PRESETS[PRESET];
const CURVE = HARNESS.curve;
const SENSOR = HARNESS.sensor;
const TARGET = HARNESS.target;
const ENABLED = HARNESS.enabled;
const TITLE = HARNESS.title;
const OVERRIDE_VALUE = HARNESS.overrideValue;
/** Default text of the reason field (the sensor's `reason` attribute while the rule applies). */
const DEFAULT_REASON = 'Exemple de r\u{e8}gle';
/** `reason` of the example package's own override rule: the curve switched off. */
const DISABLED_REASON = 'Curve disabled';

/** `mode=` URL values: `none` = a sensor without a `mode` attribute, `curve` = pinned to curve. */
const MODE_PARAMS = ['none', 'curve'] as const;

/**
 * The mock target sensor: its state and its `mode` / `reason` attributes (null = attribute
 * absent). `mode` is `curve` when the sensor follows the curve, `override` when a rule decides.
 */
interface SensorState {
  state: string;
  mode: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------------------------
// URL query parameters (see the "Param\u00e8tres d'URL" block in index.html)
// ---------------------------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function timeParam(name: string): string | null {
  const value = params.get(name);
  return value !== null && TIME_RE.test(value) ? value : null;
}

function intParam(name: string, min: number, max: number): number | null {
  const value = params.get(name);
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function enumParam<T extends string>(name: string, allowed: readonly T[]): T | null {
  const value = params.get(name);
  return allowed.find((candidate) => candidate === value) ?? null;
}

// ---------------------------------------------------------------------------------------------
// DOM references and logging
// ---------------------------------------------------------------------------------------------

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`dev harness: missing #${id}`);
  return el;
};
const main = document.querySelector('main') ?? document.body;
const host = byId('host');
const log = byId('log');
const curveInput = byId('curve') as HTMLInputElement;
const presetSelect = byId('preset') as HTMLSelectElement;
const darkInput = byId('dark') as HTMLInputElement;
const narrowInput = byId('narrow') as HTMLInputElement;
const overrideInput = byId('override') as HTMLInputElement;
const reasonInput = byId('reason') as HTMLInputElement;
const activeInput = byId('active') as HTMLInputElement;
const freezeInput = byId('freeze') as HTMLInputElement;
const nowInput = byId('now') as HTMLInputElement;
const failInput = byId('fail') as HTMLInputElement;
const latencyInput = byId('latency') as HTMLInputElement;
const noechoInput = byId('noecho') as HTMLInputElement;

const line = (msg: string): void => {
  log.textContent = `${new Date().toLocaleTimeString()} ${msg}\n${log.textContent ?? ''}`;
};

// ---------------------------------------------------------------------------------------------
// Clock: "Figer l'heure" freezes the card (nowProvider) AND the mock sensor at HH:MM local.
// ---------------------------------------------------------------------------------------------

/** "HH:MM" while the harness clock is frozen, null to follow the real clock. */
let frozenTime: string | null = timeParam('now');

/** Harness "now": today's date at the frozen time, or the real clock. */
function nowDate(): Date {
  const date = new Date();
  if (frozenTime !== null) {
    date.setHours(Number(frozenTime.slice(0, 2)), Number(frozenTime.slice(3, 5)), 0, 0);
  }
  return date;
}

function nowMinutes(): number {
  const date = nowDate();
  return date.getHours() * 60 + date.getMinutes();
}

// ---------------------------------------------------------------------------------------------
// Mock sensor: mirrors the rules of ha/example-package.yaml plus one extra override rule (the
// priority-rule toggle of the toolbar), so the card's sensor chip stays consistent with the
// toggles, the curve and the (frozen) clock. Priority: override rule, invalid curve (unavailable),
// curve switched off, else the curve value now.
// ---------------------------------------------------------------------------------------------

function sensorFromRules(
  curve: string,
  override: boolean,
  reason: string,
  enabled: boolean,
): SensorState {
  if (override) {
    // A blank reason is left out: the card then shows its generic label.
    return {
      state: formatValue(OVERRIDE_VALUE),
      mode: 'override',
      reason: reason.trim() === '' ? null : reason,
    };
  }
  // The sensor state is the storage format (`19.5`), like the Jinja sensors of ha/.
  const points = parseCurve(curve, valueRange);
  // Like HA: an unavailable template sensor publishes no attributes (no `mode`, no `reason`).
  if (!isValidCurve(points)) return { state: 'unavailable', mode: null, reason: null };
  if (!enabled) {
    return { state: formatValue(maxValue(points)), mode: 'override', reason: DISABLED_REASON };
  }
  return {
    state: formatValue(evaluateCurve(points, nowMinutes(), valueRange)),
    mode: 'curve',
    reason: null,
  };
}

/** Attributes of the mock sensor entity: `mode` / `reason` only when not null. */
function sensorAttributes(sensor: SensorState): Record<string, unknown> {
  return {
    ...(sensor.mode === null ? {} : { mode: sensor.mode }),
    ...(sensor.reason === null ? {} : { reason: sensor.reason }),
    ...(valueUnit === '' ? {} : { unit_of_measurement: valueUnit }),
  };
}

// ---------------------------------------------------------------------------------------------
// Initial state from the URL
// ---------------------------------------------------------------------------------------------

const config: CardConfig = {
  type: 'custom:time-curve-card',
  entity: CURVE,
  target_sensor: SENSOR,
  target_entity: TARGET,
  title: TITLE,
  ...HARNESS.config,
  // Raw values on purpose: an invalid window must surface the card's own French error.
  window_start: params.get('window_start') ?? '17:00',
  window_end: params.get('window_end') ?? '08:00',
  snap_minutes: 5,
  max_points: 12,
};

/**
 * Range, unit and default curve of the preset (the mock sensor uses them; the editor can change
 * them, see applyConfig). The window keys are left out: an invalid one must not stop the page.
 */
const harnessValues = normalizeConfig({ type: config.type, entity: CURVE, ...HARNESS.config });
let valueRange: ValueRange = harnessValues.range;
let valueUnit = harnessValues.unit;

const initialCurve = params.get('curve') ?? harnessValues.defaultCurve;
const overrideAtStart = params.get('override') === '1';
// `reason=` (empty) gives an override without a reason attribute.
const reasonAtStart = params.get('reason') ?? DEFAULT_REASON;
const activeAtStart = params.get('active') !== '0';
// `target=` sets the state of the target entity (`light=` is kept as an alias).
const targetState = params.get('target') ?? params.get('light') ?? HARNESS.targetState;
const targetAttributes = HARNESS.targetAttributes(targetState);

// `sensor=` pins the initial state and `mode=` the initial attributes until the first interaction
// (toolbar, clock or any entity change), which recomputes both from the rules; the minute refresh
// leaves a pinned sensor alone. `mode=none` creates the sensor WITHOUT a `mode` attribute (the
// card then shows its "\u2260 courbe" flag when the values differ), `mode=curve` pins `curve`.
const computedSensor = sensorFromRules(initialCurve, overrideAtStart, reasonAtStart, activeAtStart);
const modeParam = enumParam('mode', MODE_PARAMS);
const initialSensor: SensorState = {
  state: params.get('sensor') ?? computedSensor.state,
  mode: modeParam === 'none' ? null : modeParam === 'curve' ? 'curve' : computedSensor.mode,
  reason: modeParam === null ? computedSensor.reason : null,
};
/** true while the `sensor=` / `mode=` URL pin holds (cleared by the first {@link refreshSensor}). */
let sensorPinned = params.get('sensor') !== null || modeParam !== null;

// Persistence knobs (M3): `fail=1` rejects every service call, `latency=<ms>` delays it,
// `noecho=1` resolves it without updating the state (the card's 5 s echo timeout).
const DEFAULT_LATENCY = 250;
const SLOW_LATENCY = 1500;
const initialLatency = intParam('latency', 0, 60_000) ?? DEFAULT_LATENCY;
const failAtStart = params.get('fail') === '1';
const noechoAtStart = params.get('noecho') === '1';

darkInput.checked = params.get('theme') === 'dark';
narrowInput.checked = params.get('narrow') === '1';
overrideInput.checked = overrideAtStart;
reasonInput.value = reasonAtStart;
activeInput.checked = activeAtStart;
freezeInput.checked = frozenTime !== null;
nowInput.value = frozenTime ?? formatTime(nowMinutes());
failInput.checked = failAtStart;
latencyInput.checked = initialLatency >= SLOW_LATENCY;
noechoInput.checked = noechoAtStart;

// ---------------------------------------------------------------------------------------------
// Card + mock hass
// ---------------------------------------------------------------------------------------------

const card = document.createElement('time-curve-card');

/** The visual editor shown above the card with `editor=1` (null otherwise). */
let editor: HTMLElementTagNameMap['time-curve-card-editor'] | null = null;

const initialEntities: Record<string, MockEntityInit> = {
  [CURVE]: initialCurve,
  [SENSOR]: { state: initialSensor.state, attributes: sensorAttributes(initialSensor) },
  [ENABLED]: activeAtStart ? 'on' : 'off',
};
// `target=missing` leaves the target entity out (the chip then says "indisponible").
if (targetState !== 'missing') {
  initialEntities[TARGET] = { state: targetState, attributes: targetAttributes };
}

const mock = new MockHass(initialEntities, {
  latency: initialLatency,
  failServices: failAtStart,
  echo: !noechoAtStart,
  onService: (c) => {
    const outcome = failInput.checked
      ? ' \u2192 rejet simul\u00e9'
      : noechoInput.checked
        ? ' \u2192 sans \u00e9cho'
        : '';
    line(`callService ${c.domain}.${c.service} ${JSON.stringify(c.data)}${outcome}`);
  },
  onChange: (hass) => {
    card.hass = hass;
    if (editor !== null) editor.hass = hass;
    const curve = hass.states[CURVE]?.state ?? '';
    if (curve !== curveInput.value) {
      curveInput.value = curve;
      line(`\u00e9tat ${CURVE} = ${curve}`);
    }
    refreshSensor();
  },
});

// Hook for scripts/e2e-touch.mjs (and manual poking from the console): the mock and the card.
window.__tcc = { mock, card };

/**
 * Recomputes the mock sensor from the rules; no-op (and no new `hass`) when nothing changed.
 * Called by every interaction, so it also ends the URL pin of the initial sensor.
 */
function refreshSensor(): void {
  sensorPinned = false;
  const states = mock.hass.states;
  const next = sensorFromRules(
    states[CURVE]?.state ?? '',
    overrideInput.checked,
    reasonInput.value,
    states[ENABLED]?.state !== 'off',
  );
  const prev = states[SENSOR];
  if (
    prev?.state === next.state &&
    prev.attributes.mode === (next.mode ?? undefined) &&
    prev.attributes.reason === (next.reason ?? undefined)
  ) {
    return;
  }
  mock.setState(SENSOR, next.state, sensorAttributes(next));
  line(`capteur \u2192 ${next.state} (${describeSensor(next)})`);
}

/** `mode` and `reason` of the mock sensor for the log. */
function describeSensor(sensor: SensorState): string {
  const mode = sensor.mode ?? 'sans mode';
  return sensor.reason === null ? mode : `${mode} \u00b7 ${sensor.reason}`;
}

/** Sets or clears `card.nowProvider` from the frozen time (the card exposes it from M2 on). */
function applyClock(): void {
  const fixed = frozenTime === null ? null : nowDate();
  (card as { nowProvider?: (() => Date) | undefined }).nowProvider =
    fixed === null ? undefined : () => fixed;
}

/** Stand-in for HA's error card, shown instead of the card while its config is invalid. */
let errorCard: HTMLElement | null = null;
/** true once the card got its clock and hass (on the first config it accepted). */
let cardStarted = false;

/** Applies a config like HA does: `setConfig`, and an error card instead of the card if it throws. */
function applyConfig(next: CardConfig): void {
  try {
    card.setConfig(next);
  } catch (error) {
    // HA renders a setConfig error as a red error card: do the same.
    const message = error instanceof Error ? error.message : String(error);
    card.remove();
    if (errorCard === null) {
      errorCard = document.createElement('div');
      errorCard.className = 'error-card';
      host.append(errorCard);
    }
    errorCard.textContent = message;
    line(`setConfig: ${message}`);
    return;
  }
  errorCard?.remove();
  errorCard = null;
  // The mock sensor follows the range and unit the card now runs with (the editor may change
  // them); refreshSensor runs from the toolbar, the clock and every entity change.
  const accepted = normalizeConfig(next);
  valueRange = accepted.range;
  valueUnit = accepted.unit;
  if (!cardStarted) {
    cardStarted = true;
    applyClock();
    card.hass = mock.hass;
  }
  if (!card.isConnected) host.append(card);
}

applyConfig(config);

// ---------------------------------------------------------------------------------------------
// Visual editor (`editor=1`): the card's own editor above the card, wired like HA's card editor
// dialog: every config-changed goes back to the editor and to the preview card's setConfig.
// ---------------------------------------------------------------------------------------------

if (params.get('editor') === '1') {
  const panel = byId('editor-panel');
  const element =
    TimeCurveCard.getConfigElement() as HTMLElementTagNameMap['time-curve-card-editor'];
  element.hass = mock.hass;
  element.setConfig(config);
  element.addEventListener('config-changed', (event) => {
    const next = event.detail.config;
    line(`config-changed ${JSON.stringify(next)}`);
    element.setConfig(next);
    applyConfig(next as CardConfig);
  });
  byId('editor-host').append(element);
  panel.hidden = false;
  // Editor first, then the card (its preview), then the harness toolbars.
  panel.after(host);
  editor = element;
}

// ---------------------------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------------------------

function applyTheme(): void {
  document.documentElement.dataset.theme = darkInput.checked ? 'dark' : 'light';
}
function applyWidth(): void {
  main.style.maxWidth = narrowInput.checked ? '360px' : '520px';
}
function syncClock(): void {
  const wanted = freezeInput.checked && TIME_RE.test(nowInput.value) ? nowInput.value : null;
  freezeInput.checked = wanted !== null;
  frozenTime = wanted;
  applyClock();
  refreshSensor();
  line(wanted === null ? 'heure : horloge r\u00e9elle' : `heure fig\u00e9e \u00e0 ${wanted}`);
}

// The preset selector reloads the harness with `preset=` (the other URL parameters are kept, a
// `curve=` is dropped: it belongs to the previous preset's range).
presetSelect.value = PRESET;
presetSelect.addEventListener('change', () => {
  const next = new URLSearchParams(location.search);
  next.set('preset', presetSelect.value);
  next.delete('curve');
  location.search = next.toString();
});

applyTheme();
applyWidth();
darkInput.addEventListener('change', applyTheme);
narrowInput.addEventListener('change', applyWidth);
freezeInput.addEventListener('change', syncClock);
nowInput.addEventListener('change', () => {
  if (freezeInput.checked) syncClock();
});

curveInput.value = mock.hass.states[CURVE]?.state ?? '';
byId('apply').addEventListener('click', () => {
  mock.setState(CURVE, curveInput.value);
});
// The override rule is harness state (not an entity): recompute the sensor directly.
overrideInput.addEventListener('change', refreshSensor);
reasonInput.addEventListener('input', refreshSensor);
activeInput.addEventListener('change', () => {
  mock.setState(ENABLED, activeInput.checked ? 'on' : 'off');
});

// Persistence knobs. The latency checkbox toggles between the URL/default latency and 1.5 s
// (a URL latency above 1.5 s stays the slow value so the checkbox never lowers it).
const fastLatency = initialLatency < SLOW_LATENCY ? initialLatency : DEFAULT_LATENCY;
const slowLatency = Math.max(SLOW_LATENCY, initialLatency);
function applyPersistence(): void {
  mock.failServices = failInput.checked;
  mock.latency = latencyInput.checked ? slowLatency : fastLatency;
  mock.echo = !noechoInput.checked;
  line(
    `enregistrements : ${mock.failServices ? '\u00e9chec' : 'ok'} \u00b7 latence ${mock.latency} ms \u00b7 \u00e9cho ${mock.echo ? 'oui' : 'non'}`,
  );
}
failInput.addEventListener('change', applyPersistence);
latencyInput.addEventListener('change', applyPersistence);
noechoInput.addEventListener('change', applyPersistence);

// The real template sensor re-renders every minute; follow the clock when it is not frozen. A
// sensor pinned by the URL (`sensor=` / `mode=`) keeps its pinned state until an interaction.
setInterval(() => {
  if (!sensorPinned) refreshSensor();
}, 60_000);

line(
  `mock : preset ${PRESET} \u{b7} capteur ${initialSensor.state} (${describeSensor(initialSensor)}) \u{b7} ${TARGET} ${targetState} ${JSON.stringify(targetAttributes)}` +
    ` \u00b7 r\u00e8gle prioritaire ${overrideAtStart ? 'on' : 'off'} \u00b7 courbe active ${activeAtStart ? 'on' : 'off'}` +
    ` \u00b7 enregistrements ${mock.failServices ? '\u00e9chec' : 'ok'} \u00b7 latence ${mock.latency} ms \u00b7 \u00e9cho ${mock.echo ? 'oui' : 'non'}`,
);
line(`harness ready${location.search ? ` (${location.search})` : ''}`);

declare global {
  interface Window {
    /** Dev-harness hook read by scripts/e2e-touch.mjs: the mock hass and the card element. */
    __tcc?: { mock: MockHass; card: HTMLElementTagNameMap['time-curve-card'] };
  }
}
