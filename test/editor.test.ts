/**
 * Tests for the visual editor <time-curve-card-editor> (M5, src/editor.ts) and the config
 * helpers it shares with the card (src/config.ts): the Lovelace editor contract (hass, setConfig,
 * config-changed), the datalists filtered by domain, the emitted configs (cleared optional keys
 * removed, defaults not written, unknown keys kept), the inline validation with the card's own
 * messages, getConfigElement / getStubConfig(hass) and the card-picker registration.
 * Non-ASCII characters are written as unicode escapes (the ASCII check at the end enforces it).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeCurveCard, TimeCurveCardEditor } from '../src/index.js';
import {
  DEFAULT_ENTITY,
  SNAP_OPTIONS,
  configError,
  normalizeConfig,
  stubConfig,
} from '../src/config.js';
import { makeWindow } from '../src/core/geometry.js';
import type { EditorConfig } from '../src/editor.js';
import type { CardConfig, HomeAssistant } from '../src/types.js';
import { MockHass, type MockEntityInit } from '../dev/mock-hass.js';

type Editor = HTMLElementTagNameMap['time-curve-card-editor'];

const TYPE = 'custom:time-curve-card';
const CURVE = 'input_text.b_courbe';
const SENSOR = 'sensor.brightness_curve_target';
const LIGHT = 'light.example_lamp';
/** A card title (the stub config has none). */
const TITLE = 'Courbe du soir';
const NBSP = '\u{a0}';

/** The field keys in the order of the form. */
const FIELD_KEYS = [
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
] as const;

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
});

/** Two helpers, two sensors, one light and entities of other domains. */
function entities(): Record<string, MockEntityInit> {
  return {
    [CURVE]: {
      state: '19:00@100;23:30@12',
      attributes: { friendly_name: 'Courbe B', max: 255 },
    },
    'input_text.a_note': { state: 'bonjour', attributes: { friendly_name: 'Note A', max: 100 } },
    [SENSOR]: { state: '57', attributes: { friendly_name: 'Brightness curve target' } },
    'sensor.temperature': { state: '21', attributes: {} },
    [LIGHT]: { state: 'on', attributes: { friendly_name: 'Example lamp' } },
    'input_boolean.brightness_curve_enabled': 'on',
    'switch.prise': 'off',
  };
}

function base(extra: Record<string, unknown> = {}): EditorConfig {
  return { type: TYPE, entity: CURVE, ...extra };
}

async function mountEditor(
  config: unknown,
  init: Record<string, MockEntityInit> = entities(),
): Promise<{ el: Editor; mock: MockHass; events: EditorConfig[] }> {
  const mock = new MockHass(init);
  const el = document.createElement('time-curve-card-editor');
  el.hass = mock.hass;
  el.setConfig(config);
  const events: EditorConfig[] = [];
  el.addEventListener('config-changed', (event) => {
    events.push(event.detail.config);
  });
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  return { el, mock, events };
}

function shadow(el: Editor): ShadowRoot {
  const root = el.shadowRoot;
  if (!root) throw new Error('editor has no shadow root');
  return root;
}

/** The control of a field (an input, or the select of snap_minutes). */
function control(el: Editor, key: string): HTMLInputElement | HTMLSelectElement {
  const found = shadow(el).querySelector(`[data-key="${key}"]`);
  if (found instanceof HTMLInputElement || found instanceof HTMLSelectElement) return found;
  throw new Error(`no field ${key}`);
}

function field(el: Editor, key: string): HTMLInputElement {
  const found = control(el, key);
  if (!(found instanceof HTMLInputElement)) throw new Error(`${key} is not an input`);
  return found;
}

function snapSelect(el: Editor): HTMLSelectElement {
  const found = control(el, 'snap_minutes');
  if (!(found instanceof HTMLSelectElement)) throw new Error('snap_minutes is not a select');
  return found;
}

function presetSelect(el: Editor): HTMLSelectElement {
  const found = control(el, 'preset');
  if (!(found instanceof HTMLSelectElement)) throw new Error('preset is not a select');
  return found;
}

/** Sets a field's value and fires `change`, as a committed edit does. */
async function change(el: Editor, key: string, value: string): Promise<void> {
  const target = control(el, key);
  target.value = value;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
}

function alertText(el: Editor): string {
  return (shadow(el).querySelector('[role="alert"]')?.textContent ?? '').trim();
}

function datalist(el: Editor, key: string): { value: string; label: string | null }[] {
  const input = field(el, key);
  const listId = input.getAttribute('list') ?? '';
  const list = shadow(el).getElementById(listId);
  if (list?.tagName !== 'DATALIST') throw new Error(`no datalist for ${key}`);
  return Array.from(list.querySelectorAll('option')).map((option) => ({
    value: option.value,
    label: option.getAttribute('label'),
  }));
}

function hintOf(el: Editor, key: string): string | null {
  const described = field(el, key).getAttribute('aria-describedby');
  if (described === null) return null;
  return shadow(el).getElementById(described)?.textContent?.trim() ?? null;
}

/** The message the CARD throws for a config (null when it accepts it). */
function cardError(config: unknown): string | null {
  const card = document.createElement('time-curve-card');
  try {
    card.setConfig(config as CardConfig);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('config helpers (src/config.ts)', () => {
  it('normalizeConfig applies the defaults (the brightness preset)', () => {
    expect(normalizeConfig({ type: TYPE, entity: CURVE })).toEqual({
      entity: CURVE,
      targetSensor: null,
      targetEntity: null,
      title: null,
      preset: 'brightness',
      range: { min: 1, max: 100, step: 1 },
      unit: '%',
      label: 'Luminosit\u{e9}',
      defaultCurve: '19:00@100;21:00@70;22:30@30;23:30@12',
      axis: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
      windowStart: '17:00',
      windowEnd: '08:00',
      window: makeWindow('17:00', '08:00'),
      snapMinutes: 5,
      maxPoints: 12,
    });
  });

  it('normalizeConfig keeps the configured values', () => {
    expect(
      normalizeConfig({
        type: TYPE,
        entity: CURVE,
        target_sensor: SENSOR,
        target_entity: LIGHT,
        title: TITLE,
        preset: 'temperature',
        min: 10,
        max: 25.5,
        step: 0.1,
        unit: '\u{b0}F',
        label: 'Consigne',
        default_curve: '18:00@21;06:00@19.5 ; bad',
        window_start: '18:00',
        window_end: '12:00',
        snap_minutes: 15,
        max_points: 23,
      }),
    ).toEqual({
      entity: CURVE,
      targetSensor: SENSOR,
      targetEntity: LIGHT,
      title: TITLE,
      preset: 'temperature',
      range: { min: 10, max: 25.5, step: 0.1 },
      unit: '\u{b0}F',
      label: 'Consigne',
      defaultCurve: '18:00@21;06:00@19.5',
      axis: { min: 10, max: 30, ticks: [10, 15, 20, 25, 30] },
      windowStart: '18:00',
      windowEnd: '12:00',
      window: makeWindow('18:00', '12:00'),
      snapMinutes: 15,
      maxPoints: 23,
    });
  });

  it('throws exactly what the card setConfig throws, and configError returns it', () => {
    const invalid: unknown[] = [
      null,
      { type: TYPE },
      base({ entity: 'sensor.x' }),
      base({ target_sensor: 'light.x' }),
      base({ target_entity: 'lampe' }),
      base({ preset: 'humidity' }),
      base({ preset: 'custom' }),
      base({ min: 100 }),
      base({ step: 0 }),
      base({ unit: 3 }),
      base({ default_curve: '19:00@50' }),
      base({ title: 42 }),
      base({ window_start: 1020 }),
      base({ window_end: '8h' }),
      base({ window_start: '20:00', window_end: '18:00' }),
      base({ snap_minutes: 7 }),
      base({ max_points: 30 }),
    ];
    for (const config of invalid) {
      const expected = cardError(config);
      expect(expected).not.toBeNull();
      expect(() => normalizeConfig(config as CardConfig)).toThrow(expected ?? '');
      expect(configError(config as CardConfig)).toBe(expected);
    }
    expect(configError(base())).toBeNull();
    expect(configError(null)).toBe('configuration invalide');
    expect(configError(base({ window_start: 1020 }))).toBe(
      `window_start invalide${NBSP}: attendu HH:MM`,
    );
  });

  it('the stub config picks the first input_text holding a valid curve, and has no title', () => {
    const hass = (states: Record<string, MockEntityInit>): HomeAssistant =>
      new MockHass(states).hass;
    // The generic default: the helper of the example package.
    expect(DEFAULT_ENTITY).toBe('input_text.brightness_curve');
    expect(stubConfig()).toEqual({ entity: DEFAULT_ENTITY });
    expect(
      stubConfig(
        hass({
          'input_text.c_courbe': '19:00@100;23:00@10',
          'input_text.a_note': 'bonjour',
          'input_text.b_courbe': '20:00@80;22:00@20',
        }),
      ),
    ).toEqual({ entity: 'input_text.b_courbe' });
    // No valid curve: the first input_text (by id); none at all: the default id.
    expect(stubConfig(hass({ 'input_text.z': 'x', 'input_text.m': '', 'light.l': 'on' }))).toEqual({
      entity: 'input_text.m',
    });
    expect(stubConfig(hass({ 'light.l': 'on' }))).toEqual({ entity: DEFAULT_ENTITY });
    expect(stubConfig()).not.toHaveProperty('title');
  });
});

describe('Lovelace wiring', () => {
  it('registers the editor and shows the card in the picker with a preview', () => {
    expect(customElements.get('time-curve-card-editor')).toBe(TimeCurveCardEditor);
    const entry = window.customCards?.find((c) => c.type === 'time-curve-card');
    expect(entry?.preview).toBe(true);
  });

  it('getConfigElement returns a new editor element', () => {
    const first = TimeCurveCard.getConfigElement();
    const second = TimeCurveCard.getConfigElement();
    expect(first).toBeInstanceOf(TimeCurveCardEditor);
    expect(first.tagName.toLowerCase()).toBe('time-curve-card-editor');
    expect(second).not.toBe(first);
  });

  it('getStubConfig uses the default id without hass and picks an entity with hass', () => {
    expect(TimeCurveCard.getStubConfig()).toEqual({ entity: 'input_text.brightness_curve' });
    const mock = new MockHass(entities());
    expect(TimeCurveCard.getStubConfig(mock.hass)).toEqual({ entity: CURVE });
  });

  it('the stub config renders the card (picker preview)', async () => {
    const mock = new MockHass(entities());
    const card = document.createElement('time-curve-card');
    card.setConfig({ type: TYPE, ...TimeCurveCard.getStubConfig(mock.hass) } as CardConfig);
    card.hass = mock.hass;
    document.body.append(card);
    mounted.push(card);
    await card.updateComplete;
    expect(card.shadowRoot?.querySelectorAll('g.point')).toHaveLength(2);
    // No title: ha-card gets an empty header.
    const haCard: (Element & { header?: string }) | null =
      card.shadowRoot?.querySelector('ha-card') ?? null;
    expect(haCard?.header).toBe('');
  });
});

describe('editor rendering', () => {
  it('uses native labelled controls only, with the French labels', async () => {
    const { el } = await mountEditor(base());
    const root = shadow(el);
    const tags = Array.from(root.querySelectorAll('*')).map((node) => node.tagName.toLowerCase());
    expect(tags.filter((tag) => tag.startsWith('ha-'))).toEqual([]);
    const labels = Array.from(root.querySelectorAll('label'));
    expect(labels.map((label) => label.textContent?.trim())).toEqual([
      'Entit\u{e9} de la courbe (input_text)',
      'Capteur cible (facultatif)',
      'Appareil affich\u{e9} (facultatif)',
      'Titre (facultatif)',
      'Type de valeur',
      'Minimum',
      'Maximum',
      'Pas de la valeur',
      'Unit\u{e9}',
      'Nom de la valeur',
      'Courbe par d\u{e9}faut (bouton R\u{e9}initialiser)',
      'D\u{e9}but de la plage',
      'Fin de la plage',
      "Pas d'accrochage (minutes)",
      'Nombre maximal de points',
    ]);
    // Every label points at the control of its field, in the form order.
    expect(labels.map((label) => root.getElementById(label.htmlFor)?.dataset.key)).toEqual([
      ...FIELD_KEYS,
    ]);
  });

  it('offers the entities of the right domain in each datalist, with friendly names', async () => {
    const { el } = await mountEditor(base());
    expect(datalist(el, 'entity')).toEqual([
      { value: 'input_text.a_note', label: 'Note A' },
      { value: CURVE, label: 'Courbe B' },
    ]);
    expect(datalist(el, 'target_sensor')).toEqual([
      { value: SENSOR, label: 'Brightness curve target' },
      { value: 'sensor.temperature', label: null },
    ]);
    // Any entity can be the target entity (a light, a thermostat, a sensor...).
    expect(datalist(el, 'target_entity')).toEqual([
      { value: 'input_boolean.brightness_curve_enabled', label: null },
      { value: 'input_text.a_note', label: 'Note A' },
      { value: CURVE, label: 'Courbe B' },
      { value: LIGHT, label: 'Example lamp' },
      { value: SENSOR, label: 'Brightness curve target' },
      { value: 'sensor.temperature', label: null },
      { value: 'switch.prise', label: null },
    ]);
    expect(field(el, 'title').getAttribute('list')).toBeNull();
  });

  it('has empty datalists before hass is set', async () => {
    const el = document.createElement('time-curve-card-editor');
    el.setConfig(base());
    document.body.append(el);
    mounted.push(el);
    await el.updateComplete;
    expect(datalist(el, 'entity')).toEqual([]);
    expect(field(el, 'entity').value).toBe(CURVE);
  });

  it('shows the defaults for the absent keys', async () => {
    const { el } = await mountEditor(base());
    expect(field(el, 'entity').value).toBe(CURVE);
    expect(field(el, 'target_sensor').value).toBe('');
    expect(field(el, 'target_entity').value).toBe('');
    expect(field(el, 'title').value).toBe('');
    // The value keys show the (default) brightness preset.
    expect(presetSelect(el).value).toBe('brightness');
    expect(field(el, 'min').value).toBe('1');
    expect(field(el, 'max').value).toBe('100');
    expect(field(el, 'step').value).toBe('1');
    expect(field(el, 'unit').value).toBe('%');
    expect(field(el, 'label').value).toBe('Luminosit\u{e9}');
    expect(field(el, 'default_curve').value).toBe('');
    expect(field(el, 'default_curve').placeholder).toBe('19:00@100;21:00@70;22:30@30;23:30@12');
    expect(field(el, 'window_start').value).toBe('17:00');
    expect(field(el, 'window_end').value).toBe('08:00');
    expect(snapSelect(el).value).toBe('5');
    expect(field(el, 'max_points').value).toBe('12');
    expect(alertText(el)).toBe('');
  });

  it('shows the configured values', async () => {
    const { el } = await mountEditor(
      base({
        target_sensor: SENSOR,
        target_entity: LIGHT,
        title: TITLE,
        preset: 'temperature',
        step: 0.25,
        unit: '\u{b0}F',
        default_curve: '18:00@21;06:00@19.5',
        window_start: '18:30',
        window_end: '07:15',
        snap_minutes: 15,
        max_points: 20,
      }),
    );
    expect(field(el, 'target_sensor').value).toBe(SENSOR);
    expect(field(el, 'target_entity').value).toBe(LIGHT);
    expect(field(el, 'title').value).toBe(TITLE);
    expect(presetSelect(el).value).toBe('temperature');
    // The temperature preset's own values, the configured ones with the French comma.
    expect(field(el, 'min').value).toBe('5');
    expect(field(el, 'max').value).toBe('30');
    expect(field(el, 'step').value).toBe('0,25');
    expect(field(el, 'unit').value).toBe('\u{b0}F');
    expect(field(el, 'label').value).toBe('Temp\u{e9}rature');
    expect(field(el, 'default_curve').value).toBe('18:00@21;06:00@19.5');
    expect(field(el, 'default_curve').placeholder).toBe('17:00@20;22:00@18.5;06:00@17;07:00@20');
    expect(field(el, 'window_start').value).toBe('18:30');
    expect(field(el, 'window_end').value).toBe('07:15');
    expect(snapSelect(el).value).toBe('15');
    expect(field(el, 'max_points').value).toBe('20');
  });

  it('uses time inputs, a select of the divisors of 60 and a bounded number input', async () => {
    const { el } = await mountEditor(base());
    for (const key of ['window_start', 'window_end']) {
      expect(field(el, key).type).toBe('time');
      expect(field(el, key).getAttribute('step')).toBe('60');
      expect(hintOf(el, key)).toBe(
        'Dans la journ\u{e9}e de la courbe, de 12:00 \u{e0} 12:00 le lendemain',
      );
    }
    const select = snapSelect(el);
    expect(Array.from(select.options).map((option) => Number(option.value))).toEqual([
      ...SNAP_OPTIONS,
    ]);
    expect(select.options[4]?.textContent?.trim()).toBe('5 (par d\u{e9}faut)');
    const maxPoints = field(el, 'max_points');
    expect(maxPoints.type).toBe('number');
    expect(maxPoints.getAttribute('min')).toBe('2');
    expect(maxPoints.getAttribute('max')).toBe('25');
    const presets = presetSelect(el);
    expect(Array.from(presets.options).map((option) => option.value)).toEqual([
      'brightness',
      'temperature',
      'color_temp',
      'custom',
    ]);
    expect(Array.from(presets.options).map((option) => option.textContent?.trim())).toEqual([
      'Luminosit\u{e9} (%) (par d\u{e9}faut)',
      'Temp\u{e9}rature (\u{b0}C)',
      'Temp\u{e9}rature de couleur (K)',
      'Personnalis\u{e9}',
    ]);
    for (const key of ['min', 'max', 'step']) {
      expect(field(el, key).type).toBe('text');
      expect(field(el, key).getAttribute('inputmode')).toBe('decimal');
    }
    for (const key of ['entity', 'target_sensor', 'target_entity']) {
      expect(field(el, key).getAttribute('autocapitalize')).toBe('none');
      expect(field(el, key).getAttribute('spellcheck')).toBe('false');
    }
  });

  it('keeps touch-sized controls and wraps the paired fields when narrow', () => {
    const styles = [TimeCurveCardEditor.styles]
      .flat()
      .map((style) => ('cssText' in style ? style.cssText : ''))
      .join('\n');
    expect(styles).toMatch(/min-height:\s*40px/);
    expect(styles).toMatch(/flex-wrap:\s*wrap/);
    expect(styles).toMatch(/var\(--error-color\)/);
  });
});

describe('editing', () => {
  const cases: { key: string; value: string; expected: Record<string, unknown> }[] = [
    { key: 'entity', value: 'input_text.a_note', expected: { entity: 'input_text.a_note' } },
    { key: 'target_sensor', value: SENSOR, expected: { target_sensor: SENSOR } },
    { key: 'target_entity', value: LIGHT, expected: { target_entity: LIGHT } },
    { key: 'title', value: TITLE, expected: { title: TITLE } },
    { key: 'preset', value: 'color_temp', expected: { preset: 'color_temp' } },
    { key: 'min', value: '0,5', expected: { min: 0.5 } },
    { key: 'max', value: ' 99.5 ', expected: { max: 99.5 } },
    { key: 'step', value: '0,5', expected: { step: 0.5 } },
    { key: 'unit', value: ' lx ', expected: { unit: 'lx' } },
    { key: 'label', value: 'Intensit\u{e9}', expected: { label: 'Intensit\u{e9}' } },
    {
      key: 'default_curve',
      value: ' 20:00@80;23:00@10 ',
      expected: { default_curve: '20:00@80;23:00@10' },
    },
    { key: 'window_start', value: '18:30', expected: { window_start: '18:30' } },
    { key: 'window_end', value: '07:00', expected: { window_end: '07:00' } },
    { key: 'snap_minutes', value: '10', expected: { snap_minutes: 10 } },
    { key: 'max_points', value: '20', expected: { max_points: 20 } },
  ];

  for (const { key, value, expected } of cases) {
    it(`emits config-changed with the new config when ${key} changes`, async () => {
      const { el, events } = await mountEditor(base());
      await change(el, key, value);
      expect(events).toEqual([{ ...base(), ...expected }]);
    });
  }

  it('fires a bubbling, composed config-changed event', async () => {
    const { el } = await mountEditor(base());
    const listener = vi.fn();
    document.addEventListener('config-changed', listener);
    try {
      await change(el, 'title', TITLE);
    } finally {
      document.removeEventListener('config-changed', listener);
    }
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent<{ config: EditorConfig }>;
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
    expect(event.detail.config).toEqual(base({ title: TITLE }));
  });

  it('builds each change on the previous one, with the known keys in the documented order', async () => {
    const { el, events } = await mountEditor({ max_points: 20, entity: CURVE, type: TYPE });
    await change(el, 'title', TITLE);
    await change(el, 'window_end', '06:00');
    await change(el, 'target_sensor', SENSOR);
    expect(events).toHaveLength(3);
    expect(Object.keys(events[2] ?? {})).toEqual([
      'type',
      'entity',
      'target_sensor',
      'title',
      'window_end',
      'max_points',
    ]);
    // Home Assistant hands the emitted config back: nothing changes, nothing is emitted.
    el.setConfig(events[2]);
    await el.updateComplete;
    expect(field(el, 'window_end').value).toBe('06:00');
    expect(events).toHaveLength(3);
  });

  it('emits a copy: mutating the emitted config does not change the editor', async () => {
    const { el, events } = await mountEditor(base());
    await change(el, 'title', TITLE);
    const emitted = events[0];
    if (emitted) emitted.title = 'Autre';
    await change(el, 'target_entity', LIGHT);
    expect(events[1]).toEqual(base({ target_entity: LIGHT, title: TITLE }));
  });

  it('removes a cleared optional field instead of emitting an empty string', async () => {
    const { el, events } = await mountEditor(
      base({ target_sensor: SENSOR, target_entity: LIGHT, title: TITLE, default_curve: 'x' }),
    );
    await change(el, 'target_sensor', '');
    await change(el, 'target_entity', '   ');
    await change(el, 'title', '');
    await change(el, 'default_curve', ' ');
    expect(events).toHaveLength(4);
    expect(events[3]).toEqual(base());
    for (const key of ['target_sensor', 'target_entity', 'title', 'default_curve']) {
      expect(events[3]).not.toHaveProperty(key);
    }
    expect(field(el, 'target_entity').value).toBe('');
  });

  it('removes a cleared entity too, and shows why the config is invalid', async () => {
    const { el, events } = await mountEditor(base());
    await change(el, 'entity', '');
    expect(events).toEqual([{ type: TYPE }]);
    expect(alertText(el)).toBe(cardError({ type: TYPE }));
  });

  it('trims the entity ids and the title', async () => {
    const { el, events } = await mountEditor(base());
    await change(el, 'target_entity', `  ${LIGHT} `);
    await change(el, 'title', ` ${TITLE}  `);
    expect(events[1]).toEqual(base({ target_entity: LIGHT, title: TITLE }));
    expect(field(el, 'target_entity').value).toBe(LIGHT);
  });

  it('never writes a default the user did not move away from', async () => {
    const { el, events } = await mountEditor(base());
    await change(el, 'title', TITLE);
    expect(events[0]).toEqual(base({ title: TITLE }));
    for (const key of ['window_start', 'window_end', 'snap_minutes', 'max_points']) {
      expect(events[0]).not.toHaveProperty(key);
    }
    // Choosing the default value is no change at all.
    await change(el, 'window_start', '17:00');
    await change(el, 'snap_minutes', '5');
    await change(el, 'max_points', '12');
    expect(events).toHaveLength(1);
  });

  it('removes a key set back to its default', async () => {
    const { el, events } = await mountEditor(
      base({ window_start: '18:00', window_end: '07:00', snap_minutes: 10, max_points: 20 }),
    );
    await change(el, 'window_start', '17:00');
    await change(el, 'window_end', '08:00');
    await change(el, 'snap_minutes', '5');
    await change(el, 'max_points', '12');
    expect(events).toHaveLength(4);
    expect(events[3]).toEqual(base());
  });

  it('an emptied time or number field goes back to the default', async () => {
    const { el, events } = await mountEditor(base({ window_end: '07:00', max_points: 20 }));
    await change(el, 'window_end', '');
    await change(el, 'max_points', '');
    expect(events[1]).toEqual(base());
    expect(field(el, 'window_end').value).toBe('08:00');
    expect(field(el, 'max_points').value).toBe('12');
  });

  it('commits nothing while one segment of a focused time field is cleared', async () => {
    // Chromium: Backspace on the hour of 18:30 empties the value and fires change; the user then
    // types 1, 9 (each complete time is committed, as a time input does).
    const { el, events } = await mountEditor(base({ window_start: '18:30' }));
    const input = field(el, 'window_start');
    input.focus();
    expect(el.shadowRoot?.activeElement).toBe(input);
    await change(el, 'window_start', '');
    expect(events).toEqual([]);
    expect(input.value).toBe('');
    await change(el, 'window_start', '01:30');
    await change(el, 'window_start', '19:30');
    expect(events).toEqual([base({ window_start: '01:30' }), base({ window_start: '19:30' })]);
    input.blur();
    await el.updateComplete;
    expect(events).toHaveLength(2);
    expect(input.value).toBe('19:30');
  });

  it('settles a time field left empty on blur: emptied -> default, partly typed -> restored', async () => {
    const { el, events } = await mountEditor(base({ window_start: '18:30', window_end: '07:00' }));
    // Every segment cleared, then the field is left: back to the default, key removed.
    const start = field(el, 'window_start');
    start.focus();
    await change(el, 'window_start', '');
    start.blur();
    await el.updateComplete;
    expect(events).toEqual([base({ window_end: '07:00' })]);
    expect(start.value).toBe('17:00');
    // Only the hour cleared ("--:00", which Chromium reports as badInput), then the field is
    // left: the configured time comes back and nothing is emitted.
    const end = field(el, 'window_end');
    end.focus();
    await change(el, 'window_end', '');
    Object.defineProperty(end, 'validity', {
      configurable: true,
      value: { badInput: true, valid: false },
    });
    end.blur();
    await el.updateComplete;
    expect(events).toHaveLength(1);
    expect(end.value).toBe('07:00');
  });

  it('keeps the unknown keys of the config', async () => {
    const extra = {
      grid_options: { columns: 6, rows: 'auto' },
      view_layout: { position: 'main' },
      custom_key: 'x',
    };
    const { el, events } = await mountEditor(base(extra));
    await change(el, 'window_start', '18:00');
    await change(el, 'title', TITLE);
    expect(events[1]).toEqual(base({ ...extra, title: TITLE, window_start: '18:00' }));
    expect(events[1]?.grid_options).toBe(extra.grid_options);
    expect(Object.keys(events[1] ?? {})).toEqual([
      'type',
      'entity',
      'title',
      'window_start',
      'grid_options',
      'view_layout',
      'custom_key',
    ]);
  });

  it('emits nothing when a change leaves the config as it was', async () => {
    const { el, events } = await mountEditor(base({ title: TITLE }));
    await change(el, 'title', TITLE);
    await change(el, 'target_entity', '  ');
    expect(events).toEqual([]);
  });

  it('commits a datalist pick at once, but not plain typing', async () => {
    const { el, events } = await mountEditor(base());
    const input = field(el, 'target_sensor');
    input.value = 'sensor.brightness_curve_tar';
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'b' }));
    await el.updateComplete;
    expect(events).toEqual([]);
    // Chromium fires a plain `input` event (or an insertReplacementText one) for a datalist pick.
    input.value = SENSOR;
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;
    expect(events).toEqual([base({ target_sensor: SENSOR })]);
    input.value = 'sensor.temperature';
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText' }));
    await el.updateComplete;
    expect(events[1]).toEqual(base({ target_sensor: 'sensor.temperature' }));
    // The change event that follows the pick finds nothing new to emit.
    input.dispatchEvent(new Event('change'));
    await el.updateComplete;
    expect(events).toHaveLength(2);
  });
});

describe('inline validation', () => {
  it('shows the French message of an invalid window, marks both fields and still emits', async () => {
    const { el, events } = await mountEditor(base({ window_end: '18:00' }));
    await change(el, 'window_start', '20:00');
    expect(events).toEqual([base({ window_start: '20:00', window_end: '18:00' })]);
    expect(alertText(el)).toBe(
      'window_start (20:00) doit pr\u{e9}c\u{e9}der window_end (18:00) dans la journ\u{e9}e 12:00 \u{2192} 12:00',
    );
    expect(alertText(el)).toBe(cardError(events[0]));
    const invalid = FIELD_KEYS.filter(
      (key) => control(el, key).getAttribute('aria-invalid') === 'true',
    );
    expect(invalid).toEqual(['window_start', 'window_end']);
    // Fixed: the message goes away.
    await change(el, 'window_end', '23:00');
    expect(alertText(el)).toBe('');
    expect(shadow(el).querySelector('[role="alert"]')?.classList.contains('empty')).toBe(true);
    expect(field(el, 'window_start').getAttribute('aria-invalid')).toBe('false');
  });

  it('shows the same message as the card setConfig for every rule', async () => {
    const invalid: Record<string, unknown>[] = [
      { type: TYPE },
      base({ entity: 'sensor.x' }),
      base({ target_sensor: 'light.x' }),
      base({ target_entity: 'switch' }),
      base({ title: 42 }),
      base({ preset: 'humidity' }),
      base({ preset: 'custom', min: 0 }),
      base({ min: 'bas' }),
      base({ max: 0.555 }),
      base({ step: 150 }),
      base({ label: false }),
      base({ default_curve: 42 }),
      base({ window_start: 1020 }),
      base({ window_end: '8h' }),
      base({ snap_minutes: 7 }),
      base({ max_points: 30 }),
    ];
    for (const config of invalid) {
      const { el } = await mountEditor(config);
      const expected = cardError(config);
      expect(expected).not.toBeNull();
      expect(alertText(el)).toBe(expected);
    }
  });

  it('setConfig never throws, whatever it is given', async () => {
    for (const config of [null, undefined, 42, 'x', [], {}]) {
      const { el } = await mountEditor(config);
      expect(field(el, 'entity').value).toBe('');
      expect(alertText(el)).not.toBe('');
    }
  });

  it('leaves a time field empty for a value that is not HH:MM (unquoted YAML 17:00)', async () => {
    const { el, events } = await mountEditor(base({ window_start: 1020 }));
    expect(field(el, 'window_start').value).toBe('');
    expect(alertText(el)).toBe(`window_start invalide${NBSP}: attendu HH:MM`);
    await change(el, 'window_start', '17:30');
    expect(events).toEqual([base({ window_start: '17:30' })]);
    expect(alertText(el)).toBe('');
  });

  it('shows a one-digit hour the card accepts ("8:00") zero-padded, without touching the config', async () => {
    const config = base({ window_start: '0:30', window_end: '8:00' });
    expect(cardError(config)).toBeNull();
    const { el, events } = await mountEditor(config);
    // Shown as a time input needs it (the raw "8:00" would show as an empty field)...
    expect(field(el, 'window_start').value).toBe('00:30');
    expect(field(el, 'window_end').value).toBe('08:00');
    expect(alertText(el)).toBe('');
    // ...and a config left alone is not rewritten.
    expect(events).toEqual([]);
    await change(el, 'title', TITLE);
    expect(events).toEqual([{ ...config, title: TITLE }]);
  });

  it('shows an unsupported snap value as a disabled option', async () => {
    const { el, events } = await mountEditor(base({ snap_minutes: 7 }));
    const select = snapSelect(el);
    const first = select.options[0];
    expect(first?.disabled).toBe(true);
    expect(first?.textContent?.trim()).toBe('7');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    await change(el, 'snap_minutes', '10');
    expect(events).toEqual([base({ snap_minutes: 10 })]);
    expect(alertText(el)).toBe('');
  });

  it('emits an out-of-range max_points as a number and explains it', async () => {
    const { el, events } = await mountEditor(base());
    await change(el, 'max_points', '30');
    expect(events).toEqual([base({ max_points: 30 })]);
    expect(alertText(el)).toBe(cardError(base({ max_points: 30 })));
    expect(field(el, 'max_points').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('hints from hass', () => {
  it('flags an entity missing from Home Assistant', async () => {
    const { el } = await mountEditor(
      base({ entity: 'input_text.absent', target_sensor: 'sensor.absent', target_entity: LIGHT }),
    );
    expect(hintOf(el, 'entity')).toBe('Entit\u{e9} introuvable dans Home Assistant');
    expect(hintOf(el, 'target_sensor')).toBe('Entit\u{e9} introuvable dans Home Assistant');
    expect(hintOf(el, 'target_entity')).toBeNull();
    const absent = await mountEditor(base({ target_entity: 'climate.absent' }));
    expect(hintOf(absent.el, 'target_entity')).toBe('Entit\u{e9} introuvable dans Home Assistant');
    // Not an error: the config itself is valid.
    expect(alertText(el)).toBe('');
  });

  it('warns when the curve helper accepts fewer than 255 characters', async () => {
    const { el } = await mountEditor(base({ entity: 'input_text.a_note' }));
    expect(hintOf(el, 'entity')).toBe(
      `Cet input_text accepte au plus 100 caract\u{e8}res${NBSP}: r\u{e9}glez son maximum (max) \u{e0} 255`,
    );
    await change(el, 'entity', CURVE);
    expect(hintOf(el, 'entity')).toBeNull();
  });

  it('shows no hint for an empty field or a field of the wrong domain', async () => {
    const { el } = await mountEditor(base({ entity: LIGHT }));
    expect(hintOf(el, 'entity')).toBeNull();
    expect(hintOf(el, 'target_sensor')).toBeNull();
  });
});

describe('hass updates', () => {
  it('re-renders only when the datalists or the hints change', async () => {
    const { el, mock } = await mountEditor(base({ entity: 'input_text.absent' }));
    const render = vi.spyOn(el, 'render');
    // A state change of a listed entity: same datalists, same hints.
    mock.setState(SENSOR, '60');
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).not.toHaveBeenCalled();
    // A new light: its datalist changes.
    mock.setState('light.cuisine', 'off', { friendly_name: 'Cuisine' });
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      datalist(el, 'target_entity')
        .map((option) => option.value)
        .filter((id) => id.startsWith('light.')),
    ).toEqual(['light.cuisine', LIGHT]);
    // The missing curve entity appears: its hint goes away.
    mock.setState('input_text.absent', '19:00@100;23:00@10');
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);
    expect(hintOf(el, 'entity')).toBeNull();
  });

  it('follows a renamed entity and an entity swap in one update', async () => {
    const { el, mock } = await mountEditor(base());
    const render = vi.spyOn(el, 'render');
    // A new friendly name: a new attributes object, the label follows.
    mock.setState(LIGHT, 'off', { friendly_name: 'Example lamp (renamed)' });
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    expect(datalist(el, 'target_entity').find((option) => option.value === LIGHT)).toEqual({
      value: LIGHT,
      label: 'Example lamp (renamed)',
    });
    // A switch removed and a sensor added in the same update: same entity count, new datalist.
    const states = { ...mock.hass.states };
    delete states['switch.prise'];
    states['sensor.humidite'] = {
      entity_id: 'sensor.humidite',
      state: '40',
      attributes: { friendly_name: 'Humidit\u{e9}' },
      last_changed: '',
      last_updated: '',
    };
    el.hass = { ...mock.hass, states };
    await el.updateComplete;
    expect(datalist(el, 'target_sensor').map((option) => option.value)).toEqual([
      SENSOR,
      'sensor.humidite',
      'sensor.temperature',
    ]);
    expect(render).toHaveBeenCalledTimes(2);
    // New attributes with the same friendly name: rebuilt, same entries, no re-render.
    const target = states[SENSOR];
    if (target === undefined) throw new Error(`no ${SENSOR}`);
    states[SENSOR] = {
      ...target,
      state: '61',
      attributes: { friendly_name: 'Brightness curve target', unit_of_measurement: '%' },
    };
    el.hass = { ...mock.hass, states: { ...states } };
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('a hass update does not reset a value being typed', async () => {
    const { el, mock } = await mountEditor(base());
    const input = field(el, 'title');
    input.value = 'Sal';
    mock.setState('light.cuisine', 'off');
    el.hass = mock.hass;
    await el.updateComplete;
    expect(input.value).toBe('Sal');
  });
});

describe('value keys (preset, range, unit, label, default curve)', () => {
  it('a preset change resets the keys the preset decides', async () => {
    const { el, events } = await mountEditor(
      base({ min: 10, unit: 'lx', label: 'Intensit\u{e9}', default_curve: '20:00@80;23:00@10' }),
    );
    await change(el, 'preset', 'temperature');
    expect(events).toEqual([base({ preset: 'temperature' })]);
    expect(field(el, 'min').value).toBe('5');
    expect(field(el, 'step').value).toBe('0,5');
    expect(field(el, 'unit').value).toBe('\u{b0}C');
    // Back to the default preset: the key goes away.
    await change(el, 'preset', 'brightness');
    expect(events[1]).toEqual(base());
    expect(alertText(el)).toBe('');
  });

  it('a switch to custom writes the range the card had, so the config stays valid', async () => {
    const { el, events } = await mountEditor(base({ preset: 'temperature', step: 0.1 }));
    await change(el, 'preset', 'custom');
    expect(events).toEqual([
      base({
        preset: 'custom',
        min: 5,
        max: 30,
        step: 0.1,
        unit: '\u{b0}C',
        label: 'Temp\u{e9}rature',
      }),
    ]);
    expect(alertText(el)).toBe('');
    expect(Object.keys(events[0] ?? {})).toEqual([
      'type',
      'entity',
      'preset',
      'min',
      'max',
      'step',
      'unit',
      'label',
    ]);
  });

  it('a custom preset without its range explains what it needs', async () => {
    const { el } = await mountEditor(base({ preset: 'custom' }));
    expect(field(el, 'min').value).toBe('');
    expect(field(el, 'unit').value).toBe('');
    expect(field(el, 'label').value).toBe('Valeur');
    expect(alertText(el)).toBe("le preset custom exige 'min', 'max' et 'step'");
    const invalid = FIELD_KEYS.filter(
      (key) => control(el, key).getAttribute('aria-invalid') === 'true',
    );
    expect(invalid).toEqual(['preset', 'min', 'max', 'step']);
  });

  it('number fields take a comma or a dot; the preset value or an empty field removes the key', async () => {
    const { el, events } = await mountEditor(base({ preset: 'temperature' }));
    await change(el, 'step', '0,25');
    expect(events[0]).toEqual(base({ preset: 'temperature', step: 0.25 }));
    expect(field(el, 'step').value).toBe('0,25');
    await change(el, 'step', '0.5');
    expect(events[1]).toEqual(base({ preset: 'temperature' }));
    await change(el, 'max', '28');
    await change(el, 'max', '');
    expect(events[3]).toEqual(base({ preset: 'temperature' }));
    expect(field(el, 'max').value).toBe('30');
  });

  it('text that is not a number is emitted as is and explained', async () => {
    const { el, events } = await mountEditor(base());
    await change(el, 'min', 'bas');
    expect(events).toEqual([base({ min: 'bas' })]);
    expect(alertText(el)).toBe(cardError(base({ min: 'bas' })));
    expect(field(el, 'min').getAttribute('aria-invalid')).toBe('true');
    // A max_points message does not mark the max field (whole key names only).
    const points = await mountEditor(base({ max_points: 30 }));
    expect(field(points.el, 'max').getAttribute('aria-invalid')).toBe('false');
    expect(field(points.el, 'max_points').getAttribute('aria-invalid')).toBe('true');
  });

  it('unit and label: the preset value or an empty field removes the key', async () => {
    const { el, events } = await mountEditor(base({ unit: 'lx', label: 'Intensit\u{e9}' }));
    await change(el, 'unit', ' % ');
    await change(el, 'label', '');
    expect(events[1]).toEqual(base());
    expect(field(el, 'label').value).toBe('Luminosit\u{e9}');
  });

  it('bounds max_points by the range: 23 for the temperature preset', async () => {
    const { el } = await mountEditor(base({ preset: 'temperature' }));
    expect(field(el, 'max_points').getAttribute('max')).toBe('23');
    const tooMany = await mountEditor(base({ preset: 'temperature', max_points: 24 }));
    expect(alertText(tooMany.el)).toBe(
      'max_points doit \u{ea}tre un entier entre 2 et 23 (limite des 255 caract\u{e8}res de input_text)',
    );
  });
});

describe('sources', () => {
  it('keeps the M5 TS sources ASCII-only (non-ASCII as unicode escapes)', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const isAscii = (line: string): boolean => {
      for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) > 0x7f) return false;
      return true;
    };
    const files = ['src/config.ts', 'src/editor.ts', 'src/index.ts', 'test/editor.test.ts'];
    for (const file of files) {
      const offending = readFileSync(resolve(root, file), 'utf8')
        .split('\n')
        .flatMap((line, i) => (isAscii(line) ? [] : [`${file}:${i + 1}`]));
      expect(offending).toEqual([]);
    }
  });
});
