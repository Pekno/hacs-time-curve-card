/**
 * `<time-curve-card-editor>`: the visual config editor of the card (docs/card-rendering-spec.md,
 * section 7). It implements the Lovelace editor contract: Home Assistant sets `hass`, calls
 * `setConfig(config)` (never throws: partial and invalid configs are shown as they are) and
 * listens for `config-changed` events, fired with the whole new config on every committed change.
 *
 * - Native form controls only (`input`, `select`, `datalist`, `label`): the HA-internal `ha-*`
 *   elements are not a stable API (CLAUDE.md).
 * - The emitted config keeps every key it does not edit (unknown keys included), drops an
 *   optional field that is cleared and never writes a value equal to its default (the defaults
 *   of the value keys are the preset's).
 * - Inline validation runs the card's own rules (`normalizeConfig`, src/config.ts): the French
 *   message is shown under the form, and the change is emitted anyway so the HA preview shows
 *   the same error.
 *
 * Non-ASCII characters are written as unicode escapes; texts holding them are bound as template
 * expressions (Prettier formats the templates' static text as HTML and would unescape them).
 */
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  DEFAULT_PRESET,
  PRESETS,
  PRESET_NAMES,
  SNAP_OPTIONS,
  configError,
  normalizeConfig,
  type PresetName,
} from './config.js';
import { MAX_CURVE_LENGTH, formatTime, maxPointsFor, parseTime } from './core/curve.js';
import {
  DEFAULT_MAX_POINTS,
  DEFAULT_SNAP_MINUTES,
  DEFAULT_WINDOW_END,
  DEFAULT_WINDOW_START,
} from './core/geometry.js';
import { formatNumber, parseDecimal } from './format.js';
import type { CardConfig, HomeAssistant } from './types.js';

/** A card config as the editor handles it: possibly partial, possibly with unknown keys. */
export type EditorConfig = Partial<CardConfig> & Record<string, unknown>;

/** `detail` of the `config-changed` event. */
export interface ConfigChangedDetail {
  config: EditorConfig;
}

/** The config keys holding an entity id, each with its own datalist. */
type EntityKey = 'entity' | 'target_sensor' | 'target_entity';

/** The numeric value keys (their defaults come from the preset). */
type NumberKey = 'min' | 'max' | 'step';

/** The text value keys (their defaults come from the preset). */
type PresetTextKey = 'unit' | 'label';

/** Every config key the editor writes. */
type FieldKey =
  | EntityKey
  | NumberKey
  | PresetTextKey
  | 'title'
  | 'preset'
  | 'default_curve'
  | 'window_start'
  | 'window_end'
  | 'snap_minutes'
  | 'max_points';

type WindowKey = 'window_start' | 'window_end';

interface EntityField {
  key: EntityKey;
  label: string;
  /** Entity domain offered by the datalist (the validation requires it); null = any domain. */
  domain: string | null;
}

/** One datalist entry: an entity id and its friendly name (null when absent or equal to the id). */
interface EntityOption {
  id: string;
  name: string | null;
}

/** What the form shows from `hass`: the datalists and the hint under each entity field. */
interface Derived {
  options: Record<EntityKey, EntityOption[]>;
  hints: Record<EntityKey, string | null>;
}

/**
 * The datalists and what they were built from: the `hass.states` object, and the `attributes`
 * object (where the friendly name lives) of every listed entity, per field.
 */
interface OptionsCache {
  states: HomeAssistant['states'];
  attributes: Record<EntityKey, Map<string, unknown>>;
  options: Record<EntityKey, EntityOption[]>;
}

/** Order of the known keys in the emitted config; unknown keys follow in their own order. */
const KEY_ORDER: readonly string[] = [
  'type',
  'entity',
  'target_sensor',
  'target_entity',
  'title',
  'preset',
  'min',
  'max',
  'step',
  'unit',
  'label',
  'default_curve',
  'window_start',
  'window_end',
  'snap_minutes',
  'max_points',
];

/** The keys a preset change resets (the preset decides them again). */
const PRESET_KEYS: readonly FieldKey[] = ['min', 'max', 'step', 'unit', 'label', 'default_curve'];

const ENTITY_FIELDS: readonly EntityField[] = [
  { key: 'entity', label: 'Entit\u{e9} de la courbe (input_text)', domain: 'input_text' },
  { key: 'target_sensor', label: 'Capteur cible (facultatif)', domain: 'sensor' },
  { key: 'target_entity', label: 'Appareil affich\u{e9} (facultatif)', domain: null },
];

/** The datalists without `hass`. */
const EMPTY_OPTIONS: Record<EntityKey, EntityOption[]> = {
  entity: [],
  target_sensor: [],
  target_entity: [],
};

const NBSP = '\u{a0}';
const TITLE_LABEL = 'Titre (facultatif)';
const PRESET_LABEL = 'Type de valeur';
const PRESET_OPTION_LABELS: Readonly<Record<PresetName, string>> = {
  brightness: 'Luminosit\u{e9} (%)',
  temperature: 'Temp\u{e9}rature (\u{b0}C)',
  color_temp: 'Temp\u{e9}rature de couleur (K)',
  custom: 'Personnalis\u{e9}',
};
const NUMBER_LABELS: Readonly<Record<NumberKey, string>> = {
  min: 'Minimum',
  max: 'Maximum',
  step: 'Pas de la valeur',
};
const UNIT_LABEL = 'Unit\u{e9}';
const VALUE_LABEL = 'Nom de la valeur';
const DEFAULT_CURVE_LABEL = 'Courbe par d\u{e9}faut (bouton R\u{e9}initialiser)';
const WINDOW_START_LABEL = 'D\u{e9}but de la plage';
const WINDOW_END_LABEL = 'Fin de la plage';
const WINDOW_HINT = 'Dans la journ\u{e9}e de la courbe, de 12:00 \u{e0} 12:00 le lendemain';
const SNAP_LABEL = "Pas d'accrochage (minutes)";
const MAX_POINTS_LABEL = 'Nombre maximal de points';
const DEFAULT_SUFFIX = '(par d\u{e9}faut)';
const NOT_FOUND_HINT = 'Entit\u{e9} introuvable dans Home Assistant';

/** Hint for a curve helper whose `max` is below the 255 characters a curve may need. */
function maxLengthHint(max: number): string {
  return (
    `Cet input_text accepte au plus ${max} caract\u{e8}res${NBSP}: ` +
    `r\u{e9}glez son maximum (max) \u{e0} ${MAX_CURVE_LENGTH}`
  );
}

/** Value of the snap select: the configured (or default) divisor of 60, '' for anything else. */
function snapSelectValue(raw: unknown): string {
  const value = raw ?? DEFAULT_SNAP_MINUTES;
  return typeof value === 'number' && SNAP_OPTIONS.includes(value) ? String(value) : '';
}

/** Text of a snap option: the number, and "(par defaut)" for the default. */
function snapLabel(minutes: number): string {
  return minutes === DEFAULT_SNAP_MINUTES ? `${minutes} ${DEFAULT_SUFFIX}` : String(minutes);
}

/** true when `value` names a preset. */
function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value);
}

/** Value of the preset select: the configured (or default) preset, '' for anything else. */
function presetSelectValue(raw: unknown): string {
  const value = raw ?? DEFAULT_PRESET;
  return isPresetName(value) ? value : '';
}

/** Text of a preset option: its French name, and "(par defaut)" for the default. */
function presetLabel(name: PresetName): string {
  const label = PRESET_OPTION_LABELS[name];
  return name === DEFAULT_PRESET ? `${label} ${DEFAULT_SUFFIX}` : label;
}

/** The preset of a config (the default one when the key is absent or unknown). */
function presetOf(config: EditorConfig): PresetName {
  return isPresetName(config.preset) ? config.preset : DEFAULT_PRESET;
}

/** The preset's default of a value key (undefined for the range of `custom`). */
function presetDefault(
  preset: PresetName,
  key: NumberKey | PresetTextKey,
): number | string | undefined {
  const values = PRESETS[preset];
  if (key === 'unit') return values.unit;
  if (key === 'label') return values.label;
  return values.range?.[key];
}

const WINDOW_DEFAULTS: Record<WindowKey, string> = {
  window_start: DEFAULT_WINDOW_START,
  window_end: DEFAULT_WINDOW_END,
};

/**
 * Text shown in a field: a string as is, nothing for a missing value, a number or a boolean
 * through `String()`, anything else as JSON (what the YAML holds).
 */
function textValue(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw) ?? '';
}

/** Text of a number field: a number with the French decimal comma, anything else as is. */
function numberText(raw: unknown): string {
  return typeof raw === 'number' && Number.isFinite(raw) ? formatNumber(raw) : textValue(raw);
}

/**
 * Value of a time field: the configured time in the zero-padded `HH:MM` form a time input needs
 * (the card also accepts a one-digit hour, `8:00`, which the input would show as empty), the
 * default when the key is absent, and an empty field for anything else (e.g. the integer 1020
 * an unquoted YAML 17:00 becomes): the error under the form says why.
 */
function timeValue(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  const minutes = typeof raw === 'string' ? parseTime(raw) : null;
  return minutes === null ? '' : formatTime(minutes);
}

/** true when the entity `id` belongs in the datalist of `field`. */
function listedIn(field: EntityField, id: string): boolean {
  return field.domain === null || id.startsWith(`${field.domain}.`);
}

/** The datalist entries of one field, sorted by entity id. */
function entityOptions(states: HomeAssistant['states'], ids: readonly string[]): EntityOption[] {
  return [...ids].sort().map((id) => {
    const name: unknown = states[id]?.attributes.friendly_name;
    return { id, name: typeof name === 'string' && name !== '' && name !== id ? name : null };
  });
}

/** true when both datalists hold the same entries in the same order. */
function sameOptions(a: readonly EntityOption[], b: readonly EntityOption[]): boolean {
  return (
    a.length === b.length &&
    a.every((option, i) => option.id === b[i]?.id && option.name === b[i]?.name)
  );
}

/**
 * true when `states` lists the same entities as the cache in every field, each with the same
 * `attributes` object (so the same friendly name): one pass over the ids, no sorting. HA
 * replaces an entity's `attributes` object only when an attribute changed.
 */
function sameListedEntities(states: HomeAssistant['states'], cache: OptionsCache): boolean {
  const counts: Record<EntityKey, number> = { entity: 0, target_sensor: 0, target_entity: 0 };
  for (const id in states) {
    for (const field of ENTITY_FIELDS) {
      if (!listedIn(field, id)) continue;
      counts[field.key] += 1;
      const attributes = cache.attributes[field.key].get(id);
      if (attributes === undefined || attributes !== states[id]?.attributes) return false;
    }
  }
  return ENTITY_FIELDS.every((field) => counts[field.key] === cache.attributes[field.key].size);
}

/**
 * The datalists of `states`: the cached ones while the listed entities did not change (see
 * {@link sameListedEntities}), else rebuilt, keeping the previous array of a datalist whose
 * entries are the same (so the caller can compare the datalists by reference).
 */
function buildOptions(
  states: HomeAssistant['states'],
  previous: OptionsCache | null,
): OptionsCache {
  if (previous !== null && (previous.states === states || sameListedEntities(states, previous))) {
    return { ...previous, states };
  }
  const ids: Record<EntityKey, string[]> = { entity: [], target_sensor: [], target_entity: [] };
  const attributes: Record<EntityKey, Map<string, unknown>> = {
    entity: new Map(),
    target_sensor: new Map(),
    target_entity: new Map(),
  };
  for (const id in states) {
    for (const field of ENTITY_FIELDS) {
      if (!listedIn(field, id)) continue;
      ids[field.key].push(id);
      attributes[field.key].set(id, states[id]?.attributes);
    }
  }
  const options = {} as Record<EntityKey, EntityOption[]>;
  for (const field of ENTITY_FIELDS) {
    const built = entityOptions(states, ids[field.key]);
    const kept = previous?.options[field.key];
    options[field.key] = kept !== undefined && sameOptions(kept, built) ? kept : built;
  }
  return { states, attributes, options };
}

/**
 * Hint under an entity field: the entity is missing from Home Assistant, or (curve entity) its
 * `max` attribute is below 255 characters. None for an empty value, a value of the wrong domain
 * (the validation message covers it) or without `hass`.
 */
function entityHint(
  hass: HomeAssistant | undefined,
  field: EntityField,
  raw: unknown,
): string | null {
  if (!hass || typeof raw !== 'string' || raw === '' || !listedIn(field, raw)) return null;
  const entity = hass.states[raw];
  if (!entity) return NOT_FOUND_HINT;
  const max = entity.attributes.max;
  if (field.key === 'entity' && typeof max === 'number' && max < MAX_CURVE_LENGTH) {
    return maxLengthHint(max);
  }
  return null;
}

/**
 * `config` with `key` set to `value` (removed when `value` is undefined), the known keys in the
 * documented order, then the unknown keys in their original order.
 */
function withKey(config: EditorConfig, key: FieldKey, value: unknown): EditorConfig {
  const next: EditorConfig = {};
  const put = (k: string, v: unknown): void => {
    if (v !== undefined) next[k] = v;
  };
  for (const k of KEY_ORDER) put(k, k === key ? value : config[k]);
  for (const [k, v] of Object.entries(config)) {
    if (!KEY_ORDER.includes(k)) put(k, v);
  }
  return next;
}

/** true when both configs hold the same keys with the same values (order ignored, shallow). */
function sameConfig(a: EditorConfig, b: EditorConfig): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]))
  );
}

/**
 * true when the validation message names the config key `key` (as a whole word: `max` is not
 * named by a `max_points` message).
 */
function namesKey(message: string | null, key: string): boolean {
  if (message === null) return false;
  return new RegExp(`(^|[^a-z_])${key}([^a-z_]|$)`).test(message);
}

/**
 * The range, unit and label a switch to the `custom` preset starts from: the effective values of
 * the current config when it is valid, else the values it holds, else the current preset's.
 */
function customStart(config: EditorConfig): Partial<Record<NumberKey | PresetTextKey, unknown>> {
  try {
    const normalized = normalizeConfig(config);
    return { ...normalized.range, unit: normalized.unit, label: normalized.label };
  } catch {
    const preset = presetOf(config);
    const pick = (key: NumberKey | PresetTextKey): unknown =>
      config[key] ?? presetDefault(preset, key);
    return {
      min: pick('min'),
      max: pick('max'),
      step: pick('step'),
      unit: pick('unit'),
      label: pick('label'),
    };
  }
}

@customElement('time-curve-card-editor')
export class TimeCurveCardEditor extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;

  /** The edited config (a copy of what `setConfig` received, then of each emitted config). */
  @state() private config: EditorConfig = {};

  /** Datalists and hints of the last render (see shouldUpdate). */
  private derived: Derived = {
    options: EMPTY_OPTIONS,
    hints: { entity: null, target_sensor: null, target_entity: null },
  };

  /** The datalists and what they were built from (see buildOptions); null without hass. */
  private optionsCache: OptionsCache | null = null;

  static override styles = css`
    :host {
      display: block;
      color: var(--primary-text-color);
      font-size: 14px;
    }
    /* One field per line; the paired fields share a line when there is room (wrap at ~360px). */
    .form {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1 1 100%;
      min-width: 0;
    }
    .field.half {
      flex: 1 1 12em;
    }
    .field.third {
      flex: 1 1 7em;
    }
    label {
      font-size: 13px;
      line-height: 18px;
      color: var(--secondary-text-color);
    }
    input,
    select {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      min-height: 40px;
      margin: 0;
      padding: 0 10px;
      font: inherit;
      font-size: 14px;
      color: var(--primary-text-color);
      background: var(--card-background-color);
      /* Idle outline as HA's own outlined fields (~38 % ink); the plain line is the fallback. */
      border: 1px solid var(--secondary-text-color);
      border-color: color-mix(in srgb, var(--secondary-text-color) 70%, transparent);
      border-radius: 6px;
    }
    input:hover,
    select:hover {
      border-color: var(--primary-text-color);
    }
    input:focus-visible,
    select:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: -1px;
    }
    input[aria-invalid='true'],
    select[aria-invalid='true'] {
      border-color: var(--error-color);
    }
    .hint {
      font-size: 12px;
      line-height: 16px;
      color: var(--secondary-text-color);
    }
    /* The window hint belongs to the two time fields above it. */
    .form > .hint {
      flex: 1 1 100%;
      margin-top: -10px;
    }
    .error {
      margin-top: 16px;
      font-size: 13px;
      line-height: 18px;
      color: var(--error-color);
    }
    /* The empty live region takes no room. */
    .error.empty {
      margin-top: 0;
    }
  `;

  // -------------------------------------------------------------------------------------------
  // Lovelace editor API
  // -------------------------------------------------------------------------------------------

  /** Stores a copy of `config`; never throws (anything but an object counts as `{}`). */
  setConfig(config: unknown): void {
    this.config =
      config !== null && typeof config === 'object' ? { ...(config as EditorConfig) } : {};
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  /**
   * `hass` is reassigned on every state change in HA: re-render for it only when what the form
   * shows from it (datalists, hints) changed. Cheap for a state change: the datalists are only
   * rebuilt when a listed entity appears, disappears or changes attributes (see buildOptions),
   * and they are compared by reference, the hints by value.
   */
  protected override shouldUpdate(changed: PropertyValues<this>): boolean {
    const derived = this.derive();
    const same = ENTITY_FIELDS.every(
      (field) =>
        derived.options[field.key] === this.derived.options[field.key] &&
        derived.hints[field.key] === this.derived.hints[field.key],
    );
    if (changed.size === 1 && changed.has('hass') && same) return false;
    this.derived = derived;
    return true;
  }

  /**
   * Selects the configured snap value and preset. A `.value` binding on a select would run before
   * its options exist on the first render, and `selected` attributes alone are not reliable in
   * every DOM implementation; a pick commits at once, so there is never a pending choice to keep.
   */
  protected override updated(): void {
    const snap = this.renderRoot.querySelector<HTMLSelectElement>('[data-key="snap_minutes"]');
    if (snap) snap.value = snapSelectValue(this.config.snap_minutes);
    const preset = this.renderRoot.querySelector<HTMLSelectElement>('[data-key="preset"]');
    if (preset) preset.value = presetSelectValue(this.config.preset);
  }

  private derive(): Derived {
    this.optionsCache = this.hass ? buildOptions(this.hass.states, this.optionsCache) : null;
    const options = this.optionsCache?.options ?? EMPTY_OPTIONS;
    const hints = {} as Record<EntityKey, string | null>;
    for (const field of ENTITY_FIELDS) {
      hints[field.key] = entityHint(this.hass, field, this.config[field.key]);
    }
    return { options, hints };
  }

  // -------------------------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------------------------

  /** Applies one field change and emits the new config (nothing when nothing changed). */
  private commit(key: FieldKey, value: unknown): void {
    this.commitConfig(withKey(this.config, key, value));
  }

  /** Emits `next` as the new config (nothing when it equals the current one). */
  private commitConfig(next: EditorConfig): void {
    if (sameConfig(next, this.config)) return;
    this.config = next;
    const detail: ConfigChangedDetail = { config: { ...next } };
    this.dispatchEvent(
      new CustomEvent<ConfigChangedDetail>('config-changed', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Text fields (entities, title, default curve): trimmed; an empty field removes its key. */
  private commitText(input: HTMLInputElement): void {
    const key = input.dataset.key as EntityKey | 'title' | 'default_curve';
    const value = input.value.trim();
    if (value !== input.value) input.value = value;
    this.commit(key, value === '' ? undefined : value);
  }

  private readonly onTextChange = (event: Event): void => {
    this.commitText(event.target as HTMLInputElement);
  };

  /**
   * A datalist pick (or an autofill) replaces the whole value of an entity field: committed at
   * once, like a `change`. Plain typing waits for the `change` event (blur / Enter).
   */
  private readonly onEntityInput = (event: Event): void => {
    if (event instanceof InputEvent && event.inputType !== 'insertReplacementText') return;
    this.commitText(event.target as HTMLInputElement);
  };

  /**
   * The preset select. The keys a preset decides (range, unit, label, default curve) are reset;
   * a switch to `custom`, which has no range of its own, writes the range, unit and label the
   * card had so far (see {@link customStart}) so the config stays valid.
   */
  private readonly onPresetChange = (event: Event): void => {
    const value = (event.target as HTMLSelectElement).value;
    if (!isPresetName(value)) return;
    let next = this.config;
    const start = value === 'custom' ? customStart(next) : {};
    for (const key of PRESET_KEYS) next = withKey(next, key, undefined);
    if (value === 'custom') {
      for (const key of ['min', 'max', 'step', 'unit', 'label'] as const) {
        const startValue = start[key];
        const fallback = presetDefault('custom', key);
        next = withKey(next, key, startValue === fallback ? undefined : startValue);
      }
    }
    this.commitConfig(withKey(next, 'preset', value === DEFAULT_PRESET ? undefined : value));
  };

  /**
   * Number fields of the value (min, max, step): a decimal number with a comma or a dot; the
   * preset's value, or an empty field, removes the key (the preset decides). Text that is not a
   * number is emitted as is: the validation message explains it.
   */
  private readonly onNumberChange = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const key = input.dataset.key as NumberKey;
    const text = input.value.trim();
    const preset = presetOf(this.config);
    const fallback = presetDefault(preset, key);
    if (text === '') {
      input.value = numberText(fallback);
      this.commit(key, undefined);
      return;
    }
    const value = parseDecimal(text);
    if (value === null) {
      this.commit(key, text);
      return;
    }
    input.value = formatNumber(value);
    this.commit(key, value === fallback ? undefined : value);
  };

  /** Unit and label: as typed (trimmed); the preset's value or an empty field removes the key. */
  private readonly onPresetTextChange = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const key = input.dataset.key as PresetTextKey;
    const value = input.value.trim();
    const fallback = presetDefault(presetOf(this.config), key);
    if (value === '') input.value = textValue(fallback);
    else if (value !== input.value) input.value = value;
    this.commit(key, value === '' || value === fallback ? undefined : value);
  };

  /**
   * Time fields: each complete `HH:MM` is committed; the default removes the key. An empty value
   * while the field has the focus is not committed: Chromium empties the value (and fires
   * `change`) as soon as ONE segment is cleared (Backspace on the hour of 18:30), while the user
   * is still typing. The field is settled when it loses the focus (see onTimeBlur); an empty
   * value that arrives without the focus (a picker's Clear button) goes back to the default.
   */
  private readonly onTimeChange = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.value === '' && this.shadowRoot?.activeElement === input) return;
    this.commitTime(input);
  };

  /**
   * A time field left empty: a partly typed time (`--:30`, `validity.badInput`) shows the
   * configured value again, an emptied one goes back to the default (and removes the key).
   */
  private readonly onTimeBlur = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    if (input.value !== '') return;
    const key = input.dataset.key as WindowKey;
    if (input.validity.badInput) {
      input.value = timeValue(this.config[key], WINDOW_DEFAULTS[key]);
      return;
    }
    this.commitTime(input);
  };

  /** Commits a time field: `HH:MM`; the default or an empty field removes the key (default shown). */
  private commitTime(input: HTMLInputElement): void {
    const key = input.dataset.key as WindowKey;
    const fallback = WINDOW_DEFAULTS[key];
    const value = input.value.slice(0, 5);
    if (value === '') input.value = fallback;
    this.commit(key, value === '' || value === fallback ? undefined : value);
  }

  private readonly onSnapChange = (event: Event): void => {
    const value = Number((event.target as HTMLSelectElement).value);
    if (!SNAP_OPTIONS.includes(value)) return;
    this.commit('snap_minutes', value === DEFAULT_SNAP_MINUTES ? undefined : value);
  };

  /** Any number is emitted (the validation explains a wrong one); empty = the default. */
  private readonly onMaxPointsChange = (event: Event): void => {
    const input = event.target as HTMLInputElement;
    const value = input.value === '' ? DEFAULT_MAX_POINTS : Number(input.value);
    if (input.value === '') input.value = String(DEFAULT_MAX_POINTS);
    this.commit('max_points', value === DEFAULT_MAX_POINTS ? undefined : value);
  };

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  /** Upper bound of `max_points` for the configured range (25 while the range is invalid). */
  private maxPointsLimit(): number {
    try {
      return maxPointsFor(normalizeConfig({ ...this.config, max_points: 2 }).range);
    } catch {
      return maxPointsFor();
    }
  }

  override render(): TemplateResult {
    const error = configError(this.config);
    // Mark the fields the message names (the window order message names both window fields).
    const invalid = (key: FieldKey): 'true' | 'false' => (namesKey(error, key) ? 'true' : 'false');
    const preset = presetOf(this.config);
    return html`
      <div class="form">
        ${ENTITY_FIELDS.map((field) => this.renderEntityField(field, invalid(field.key)))}
        <div class="field">
          <label for="tcc-ed-title">${TITLE_LABEL}</label>
          <input
            id="tcc-ed-title"
            type="text"
            data-key="title"
            autocomplete="off"
            .value=${textValue(this.config.title)}
            aria-invalid=${invalid('title')}
            @change=${this.onTextChange}
          />
        </div>
        ${this.renderPresetField(invalid('preset'))}
        ${(['min', 'max', 'step'] as const).map((key) =>
          this.renderNumberField(key, preset, invalid(key)),
        )}
        ${this.renderPresetTextField('unit', UNIT_LABEL, preset, invalid('unit'))}
        ${this.renderPresetTextField('label', VALUE_LABEL, preset, invalid('label'))}
        <div class="field">
          <label for="tcc-ed-default_curve">${DEFAULT_CURVE_LABEL}</label>
          <input
            id="tcc-ed-default_curve"
            type="text"
            data-key="default_curve"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            placeholder=${PRESETS[preset].defaultCurve ?? ''}
            .value=${textValue(this.config.default_curve)}
            aria-invalid=${invalid('default_curve')}
            @change=${this.onTextChange}
          />
        </div>
        ${this.renderTimeField('window_start', WINDOW_START_LABEL, invalid('window_start'))}
        ${this.renderTimeField('window_end', WINDOW_END_LABEL, invalid('window_end'))}
        <div class="hint" id="tcc-ed-window-hint">${WINDOW_HINT}</div>
        ${this.renderSnapField(invalid('snap_minutes'))}
        <div class="field half">
          <label for="tcc-ed-max_points">${MAX_POINTS_LABEL}</label>
          <input
            id="tcc-ed-max_points"
            type="number"
            min="2"
            max=${this.maxPointsLimit()}
            step="1"
            inputmode="numeric"
            data-key="max_points"
            .value=${textValue(this.config.max_points ?? DEFAULT_MAX_POINTS)}
            aria-invalid=${invalid('max_points')}
            @change=${this.onMaxPointsChange}
          />
        </div>
      </div>
      <div class="error ${error === null ? 'empty' : ''}" role="alert">${error ?? ''}</div>
    `;
  }

  private renderEntityField(field: EntityField, invalid: 'true' | 'false'): TemplateResult {
    const id = `tcc-ed-${field.key}`;
    const hint = this.derived.hints[field.key];
    return html`
      <div class="field">
        <label for=${id}>${field.label}</label>
        <input
          id=${id}
          type="text"
          list="${id}-list"
          data-key=${field.key}
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          .value=${textValue(this.config[field.key])}
          aria-invalid=${invalid}
          aria-describedby=${hint === null ? nothing : `${id}-hint`}
          @change=${this.onTextChange}
          @input=${this.onEntityInput}
        />
        <datalist id="${id}-list">
          ${this.derived.options[field.key].map(
            (option) => html`<option value=${option.id} label=${option.name ?? nothing}></option>`,
          )}
        </datalist>
        ${hint === null ? nothing : html`<div class="hint" id="${id}-hint">${hint}</div>`}
      </div>
    `;
  }

  /** The preset select; its value is set in {@link updated}, once its options exist. */
  private renderPresetField(invalid: 'true' | 'false'): TemplateResult {
    const raw: unknown = this.config.preset ?? DEFAULT_PRESET;
    const known = presetSelectValue(raw) !== '';
    return html`
      <div class="field">
        <label for="tcc-ed-preset">${PRESET_LABEL}</label>
        <select
          id="tcc-ed-preset"
          data-key="preset"
          aria-invalid=${invalid}
          @change=${this.onPresetChange}
        >
          ${known ? nothing : html`<option value="" disabled selected>${textValue(raw)}</option>`}
          ${PRESET_NAMES.map(
            (name) =>
              html`<option value=${name} ?selected=${name === raw}>${presetLabel(name)}</option>`,
          )}
        </select>
      </div>
    `;
  }

  /** min / max / step: the configured value, else the preset's (empty for a custom range). */
  private renderNumberField(
    key: NumberKey,
    preset: PresetName,
    invalid: 'true' | 'false',
  ): TemplateResult {
    const id = `tcc-ed-${key}`;
    return html`
      <div class="field third">
        <label for=${id}>${NUMBER_LABELS[key]}</label>
        <input
          id=${id}
          type="text"
          inputmode="decimal"
          data-key=${key}
          autocomplete="off"
          spellcheck="false"
          .value=${numberText(this.config[key] ?? presetDefault(preset, key))}
          aria-invalid=${invalid}
          @change=${this.onNumberChange}
        />
      </div>
    `;
  }

  /** unit / label: the configured text, else the preset's. */
  private renderPresetTextField(
    key: PresetTextKey,
    label: string,
    preset: PresetName,
    invalid: 'true' | 'false',
  ): TemplateResult {
    const id = `tcc-ed-${key}`;
    return html`
      <div class="field half">
        <label for=${id}>${label}</label>
        <input
          id=${id}
          type="text"
          data-key=${key}
          autocomplete="off"
          .value=${textValue(this.config[key] ?? presetDefault(preset, key))}
          aria-invalid=${invalid}
          @change=${this.onPresetTextChange}
        />
      </div>
    `;
  }

  private renderTimeField(
    key: WindowKey,
    label: string,
    invalid: 'true' | 'false',
  ): TemplateResult {
    const id = `tcc-ed-${key}`;
    return html`
      <div class="field half">
        <label for=${id}>${label}</label>
        <input
          id=${id}
          type="time"
          step="60"
          data-key=${key}
          .value=${timeValue(this.config[key], WINDOW_DEFAULTS[key])}
          aria-invalid=${invalid}
          aria-describedby="tcc-ed-window-hint"
          @change=${this.onTimeChange}
          @blur=${this.onTimeBlur}
        />
      </div>
    `;
  }

  /** The snap select; its value is set in {@link updated}, once its options exist. */
  private renderSnapField(invalid: 'true' | 'false'): TemplateResult {
    const raw: unknown = this.config.snap_minutes ?? DEFAULT_SNAP_MINUTES;
    const known = snapSelectValue(raw) !== '';
    return html`
      <div class="field half">
        <label for="tcc-ed-snap_minutes">${SNAP_LABEL}</label>
        <select
          id="tcc-ed-snap_minutes"
          data-key="snap_minutes"
          aria-invalid=${invalid}
          @change=${this.onSnapChange}
        >
          ${known ? nothing : html`<option value="" disabled selected>${textValue(raw)}</option>`}
          ${SNAP_OPTIONS.map(
            (n) => html`<option value=${n} ?selected=${n === raw}>${snapLabel(n)}</option>`,
          )}
        </select>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'time-curve-card-editor': TimeCurveCardEditor;
  }
  interface HTMLElementEventMap {
    'config-changed': CustomEvent<ConfigChangedDetail>;
  }
}
