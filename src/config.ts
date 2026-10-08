/**
 * Card config validation, shared by the card (`setConfig`) and the visual editor (its inline
 * validation), plus the value presets and the stub config of the dashboard card picker. Pure: no
 * DOM, no Lit.
 *
 * The rules and their French messages are normative (docs/card-rendering-spec.md, section 2.1):
 * the card throws them from `setConfig` (Home Assistant shows them in an error card) and the
 * editor shows the same text under its form. Non-ASCII characters are written as unicode escapes.
 */
import {
  MAX_ABS_CENTI,
  isValidCurve,
  maxPointsFor,
  parseCurve,
  serializeCurve,
  type ValueRange,
} from './core/curve.js';
import {
  DEFAULT_MAX_POINTS,
  DEFAULT_SNAP_MINUTES,
  DEFAULT_WINDOW_END,
  DEFAULT_WINDOW_START,
  makeWindow,
  valueAxis,
  type TimeWindow,
  type ValueAxis,
} from './core/geometry.js';
import { formatNumber } from './format.js';
import type { CardConfig, HomeAssistant } from './types.js';

/** The value presets of the `preset` key. */
export type PresetName = 'brightness' | 'temperature' | 'color_temp' | 'custom';

/** What a preset fills in (explicit config keys override it). */
export interface Preset {
  /** Range and step, in user units; null for `custom`, which requires them in the config. */
  range: ValueRange | null;
  unit: string;
  label: string;
  /** Curve written by the reset button; null for `custom` (see {@link fallbackCurve}). */
  defaultCurve: string | null;
}

/** The presets, in the order of the editor's select. */
export const PRESETS: Readonly<Record<PresetName, Readonly<Preset>>> = Object.freeze({
  brightness: {
    range: { min: 1, max: 100, step: 1 },
    unit: '%',
    label: 'Luminosit\u{e9}',
    defaultCurve: '19:00@100;21:00@70;22:30@30;23:30@12',
  },
  temperature: {
    range: { min: 5, max: 30, step: 0.5 },
    unit: '\u{b0}C',
    label: 'Temp\u{e9}rature',
    defaultCurve: '17:00@20;22:00@18.5;06:00@17;07:00@20',
  },
  color_temp: {
    range: { min: 2000, max: 6500, step: 50 },
    unit: 'K',
    label: 'Temp\u{e9}rature de couleur',
    defaultCurve: '17:00@4000;21:00@2700;23:00@2200',
  },
  custom: { range: null, unit: '', label: 'Valeur', defaultCurve: null },
});

/** The preset names, in the order of {@link PRESETS}. */
export const PRESET_NAMES: readonly PresetName[] = [
  'brightness',
  'temperature',
  'color_temp',
  'custom',
];

/** Preset used when the config has no `preset` key. */
export const DEFAULT_PRESET: PresetName = 'brightness';

/** Card config after validation, with the defaults applied. */
export interface NormalizedConfig {
  entity: string;
  targetSensor: string | null;
  /** Any entity shown in the status row (a light, a thermostat...); null when not configured. */
  targetEntity: string | null;
  title: string | null;
  preset: PresetName;
  /** Value range and step of the curve (user units). */
  range: ValueRange;
  /** Unit shown after every value (may be empty). */
  unit: string;
  /** Name of the value (detail row, chart label). */
  label: string;
  /** Canonical curve string written by the reset button (valid in `range`). */
  defaultCurve: string;
  /** The chart's value axis (nice bounds around the range and its gridlines). */
  axis: ValueAxis;
  windowStart: string;
  windowEnd: string;
  window: TimeWindow;
  snapMinutes: number;
  maxPoints: number;
}

/**
 * Curve entity of the stub config when Home Assistant offers no `input_text` (the helper of the
 * example package, ha/example-package.yaml).
 */
export const DEFAULT_ENTITY = 'input_text.brightness_curve';

/** The valid `snap_minutes` values: the divisors of 60. */
export const SNAP_OPTIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];

/** Largest magnitude of `min` / `max` / `step` (the curve value grammar: 4 digits, 2 decimals). */
export const MAX_ABS_VALUE = MAX_ABS_CENTI / 100;

/** No-break space (U+00A0), before ':' in the French messages. */
const NBSP = '\u{a0}';

/** An entity id: `domain.object_id`, lowercase letters, digits and underscores. */
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** Text of a thrown value (makeWindow throws plain `Error`s). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * French typography for a message built elsewhere (the core helpers write a plain space before
 * `:`): a no-break space before every ` :`.
 */
function frenchColons(text: string): string {
  return text.replace(/ :/g, `${NBSP}:`);
}

/** Validates an optional entity id of the given domain; returns null when absent. */
function optionalEntity(value: unknown, key: string, prefix: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new Error(`'${key}' doit \u{ea}tre une entit\u{e9} ${prefix}*`);
  }
  return value;
}

/** true when `value` is a whole number of hundredths (at most 2 decimals, beyond float noise). */
function hasTwoDecimalsAtMost(value: number): boolean {
  const scaled = value * 100;
  return Math.abs(scaled - Math.round(scaled)) <= 1e-6;
}

/** true when `value` is a PresetName. */
function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value);
}

/**
 * A `min` / `max` value: the configured number (at most 2 decimals, within +-9999.99), else the
 * preset's.
 */
function boundValue(raw: unknown, key: 'min' | 'max', fallback: number | undefined): number {
  if (raw === undefined || raw === null) {
    if (fallback === undefined) {
      throw new Error("le preset custom exige 'min', 'max' et 'step'");
    }
    return fallback;
  }
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    Math.abs(raw) > MAX_ABS_VALUE ||
    !hasTwoDecimalsAtMost(raw)
  ) {
    throw new Error(
      `'${key}' doit \u{ea}tre un nombre entre ${formatNumber(-MAX_ABS_VALUE)} et ${formatNumber(MAX_ABS_VALUE)} avec au plus 2 d\u{e9}cimales`,
    );
  }
  return Math.round(raw * 100) / 100 + 0;
}

/** The value range: the preset's, overridden key by key by `min`, `max`, `step`. */
function rangeOf(config: Readonly<Partial<CardConfig>>, preset: Preset): ValueRange {
  const min = boundValue(config.min, 'min', preset.range?.min);
  const max = boundValue(config.max, 'max', preset.range?.max);
  if (min >= max) {
    throw new Error(
      `'min' (${formatNumber(min)}) doit \u{ea}tre inf\u{e9}rieur \u{e0} 'max' (${formatNumber(max)})`,
    );
  }
  const rawStep: unknown = config.step ?? preset.range?.step;
  if (rawStep === undefined || rawStep === null) {
    throw new Error("le preset custom exige 'min', 'max' et 'step'");
  }
  if (
    typeof rawStep !== 'number' ||
    !Number.isFinite(rawStep) ||
    rawStep <= 0 ||
    !hasTwoDecimalsAtMost(rawStep) ||
    Math.round(rawStep * 100) === 0
  ) {
    throw new Error("'step' doit \u{ea}tre un nombre positif avec au plus 2 d\u{e9}cimales");
  }
  const step = Math.round(rawStep * 100) / 100;
  // Exact comparison in hundredths: a step wider than the range would leave a single value.
  if (Math.round(step * 100) > Math.round(max * 100) - Math.round(min * 100)) {
    throw new Error(
      `'step' (${formatNumber(step)}) doit \u{ea}tre au plus l'\u{e9}cart entre 'min' et 'max' (${formatNumber(max - min)})`,
    );
  }
  return { min, max, step };
}

/** An optional string key (`unit`, `label`): the configured string, else the preset's. */
function textKey(raw: unknown, key: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') {
    throw new Error(`'${key}' doit \u{ea}tre une cha\u{ee}ne de caract\u{e8}res`);
  }
  return raw;
}

/**
 * Reset curve of a range without a preset curve (`custom`): from the top of the range at 19:00
 * down to its bottom at 23:00.
 */
export function fallbackCurve(range: Readonly<ValueRange>): string {
  return serializeCurve(
    [
      { time: 19 * 60, value: range.max },
      { time: 23 * 60, value: range.min },
    ],
    range,
  );
}

/**
 * The reset curve: `default_curve` when configured (it must hold a valid curve in the range),
 * else the preset's curve (its values clamped into the range), else {@link fallbackCurve}; always
 * in canonical form.
 */
function defaultCurveOf(raw: unknown, preset: Preset, range: ValueRange): string {
  if (raw !== undefined && raw !== null) {
    const points = typeof raw === 'string' ? parseCurve(raw, range) : [];
    if (!isValidCurve(points)) {
      throw new Error("'default_curve' doit contenir au moins 2 points HH:MM@valeur valides");
    }
    return serializeCurve(points, range);
  }
  if (preset.defaultCurve === null) return fallbackCurve(range);
  const points = parseCurve(preset.defaultCurve, range);
  return isValidCurve(points) ? serializeCurve(points, range) : fallbackCurve(range);
}

/**
 * Validates a card config and applies the defaults. Unknown keys are ignored.
 *
 * @throws {Error} with the French message of the first rule the config breaks (see
 *   docs/card-rendering-spec.md, section 2.1).
 */
export function normalizeConfig(
  config: Readonly<Partial<CardConfig>> | null | undefined,
): NormalizedConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('configuration invalide');
  }
  const entity: unknown = config.entity;
  if (typeof entity !== 'string' || !entity.startsWith('input_text.')) {
    throw new Error("'entity' est requis et doit \u{ea}tre une entit\u{e9} input_text.*");
  }
  const targetSensor = optionalEntity(config.target_sensor, 'target_sensor', 'sensor.');
  const rawTarget: unknown = config.target_entity;
  let targetEntity: string | null = null;
  if (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') {
    if (typeof rawTarget !== 'string' || !ENTITY_ID_RE.test(rawTarget)) {
      throw new Error("'target_entity' doit \u{ea}tre un identifiant d'entit\u{e9} (domaine.nom)");
    }
    targetEntity = rawTarget;
  }
  const title: unknown = config.title;
  if (title !== undefined && title !== null && typeof title !== 'string') {
    throw new Error("'title' doit \u{ea}tre une cha\u{ee}ne de caract\u{e8}res");
  }
  const presetName: unknown = config.preset ?? DEFAULT_PRESET;
  if (!isPresetName(presetName)) {
    throw new Error(`'preset' doit valoir ${PRESET_NAMES.join(', ')}`);
  }
  const preset = PRESETS[presetName];
  const range = rangeOf(config, preset);
  const unit = textKey(config.unit, 'unit', preset.unit);
  const label = textKey(config.label, 'label', preset.label);
  const defaultCurve = defaultCurveOf(config.default_curve, preset, range);
  const windowStart: unknown = config.window_start ?? DEFAULT_WINDOW_START;
  if (typeof windowStart !== 'string') {
    throw new Error(`window_start invalide${NBSP}: attendu HH:MM`);
  }
  const windowEnd: unknown = config.window_end ?? DEFAULT_WINDOW_END;
  if (typeof windowEnd !== 'string') throw new Error(`window_end invalide${NBSP}: attendu HH:MM`);
  let window: TimeWindow;
  try {
    window = makeWindow(windowStart, windowEnd);
  } catch (error) {
    // makeWindow's messages are shared with the pure helpers' tests: typography fixed here.
    throw new Error(frenchColons(messageOf(error)));
  }
  const snapMinutes: unknown = config.snap_minutes ?? DEFAULT_SNAP_MINUTES;
  if (
    typeof snapMinutes !== 'number' ||
    !Number.isInteger(snapMinutes) ||
    snapMinutes < 1 ||
    snapMinutes > 60 ||
    60 % snapMinutes !== 0
  ) {
    throw new Error(
      `snap_minutes doit \u{ea}tre un entier qui divise 60 (${SNAP_OPTIONS.join(', ')})`,
    );
  }
  const maxPointsLimit = maxPointsFor(range);
  const maxPoints: unknown = config.max_points ?? Math.min(DEFAULT_MAX_POINTS, maxPointsLimit);
  if (
    typeof maxPoints !== 'number' ||
    !Number.isInteger(maxPoints) ||
    maxPoints < 2 ||
    maxPoints > maxPointsLimit
  ) {
    throw new Error(
      `max_points doit \u{ea}tre un entier entre 2 et ${maxPointsLimit} (limite des 255 caract\u{e8}res de input_text)`,
    );
  }
  return {
    entity,
    targetSensor,
    targetEntity,
    title: title ?? null,
    preset: presetName,
    range,
    unit,
    label,
    defaultCurve,
    axis: valueAxis(range),
    windowStart,
    windowEnd,
    window,
    snapMinutes,
    maxPoints,
  };
}

/**
 * The French message {@link normalizeConfig} throws for `config`, or null when it is valid.
 * Used by the visual editor, which shows the message instead of throwing.
 */
export function configError(
  config: Readonly<Partial<CardConfig>> | null | undefined,
): string | null {
  try {
    normalizeConfig(config);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * Curve entity of the stub config: the first `input_text.*` (by entity id) whose state parses to
 * a valid curve, else the first `input_text.*`, else {@link DEFAULT_ENTITY} (also without hass).
 */
export function stubEntity(hass?: HomeAssistant): string {
  if (!hass) return DEFAULT_ENTITY;
  const ids = Object.keys(hass.states)
    .filter((id) => id.startsWith('input_text.'))
    .sort();
  const withCurve = ids.find((id) => isValidCurve(parseCurve(hass.states[id]?.state)));
  return withCurve ?? ids[0] ?? DEFAULT_ENTITY;
}

/**
 * Stub config of the dashboard card picker (`getStubConfig`): the entity of {@link stubEntity}
 * and no title (the user names the card); no preset key (brightness).
 */
export function stubConfig(hass?: HomeAssistant): Partial<CardConfig> {
  return { entity: stubEntity(hass) };
}
