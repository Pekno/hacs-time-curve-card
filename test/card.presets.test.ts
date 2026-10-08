/**
 * Tests for the value presets and custom ranges of <time-curve-card> (generalization spec,
 * section 3): the config rules of `preset`, `min`, `max`, `step`, `unit`, `label`,
 * `default_curve` and the per-range `max_points` bound; the nice value axis; the French value
 * formatting (decimal comma, unit after a narrow no-break space); the exact snapping of drags,
 * keyboard nudges and the detail row; the numeric sensor comparison; the reset curve per preset;
 * and the pure formatting helpers (src/format.ts) and chip helpers of src/card.ts.
 * Non-ASCII characters are written as unicode escapes (code point form); the check at the end
 * keeps this file ASCII-only.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/index.js';
import { labelWidth, sensorCenti, targetEntityText } from '../src/card.js';
import { PRESETS, fallbackCurve, normalizeConfig } from '../src/config.js';
import { parseTime, sortKey } from '../src/core/curve.js';
import { keyToX, makeWindow, valueToY, type PlotArea } from '../src/core/geometry.js';
import { NNBSP, formatNumber, formatQuantity, parseDecimal } from '../src/format.js';
import { MockHass, type MockEntityInit } from '../dev/mock-hass.js';
import type { CardConfig, HassEntity } from '../src/types.js';

const CURVE = 'input_text.c';
const SENSOR = 'sensor.s';
const DEG_C = '\u{b0}C';
const NBSP = '\u{a0}';

/** The default curves of the presets (their `default_curve`). */
const TEMPERATURE_CURVE = '17:00@20;22:00@18.5;06:00@17;07:00@20';
const COLOR_TEMP_CURVE = '17:00@4000;21:00@2700;23:00@2200';

/** A custom range with negative values, quarter steps and no unit. */
const OFFSET: Partial<CardConfig> = { preset: 'custom', min: -5, max: 5, step: 0.25 };

type Card = HTMLElementTagNameMap['time-curve-card'];

const mounted: Card[] = [];

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
  vi.useRealTimers();
});

function config(extra: Partial<CardConfig> = {}): CardConfig {
  return { type: 'custom:time-curve-card', entity: CURVE, ...extra };
}

/** The message setConfig throws for a config (null when it accepts it). */
function errorOf(extra: Record<string, unknown>): string | null {
  const el = document.createElement('time-curve-card');
  try {
    el.setConfig({ ...config(), ...extra });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Mounts the card at 21:30 on a mock hass wired like the harness (echoes reach the card). */
async function mount(
  cardConfig: CardConfig,
  entities: Record<string, MockEntityInit>,
): Promise<{ el: Card; mock: MockHass }> {
  const el = document.createElement('time-curve-card');
  const mock = new MockHass(entities, {
    onChange: (hass) => {
      el.hass = hass;
    },
  });
  el.setConfig(cardConfig);
  el.nowProvider = () => new Date(2026, 0, 15, 21, 30, 0, 0);
  el.hass = mock.hass;
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  stubSvgRect(el);
  return { el, mock };
}

function query(el: Card, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null;
}

function queryAll(el: Card, selector: string): Element[] {
  return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? []);
}

/** Text of an element with every whitespace run (U+202F included) as one space. */
function textOf(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The value labels of the axis, bottom to top, exactly as rendered. */
function axisLabels(el: Card): string[] {
  const grid = queryAll(el, 'line.grid').length;
  return queryAll(el, 'text.axis-label')
    .slice(0, grid)
    .map((text) => text.textContent ?? '');
}

/** The plot area, read back from the gridlines (bottom one first). */
function plotOf(el: Card): PlotArea {
  const lines = queryAll(el, 'line.grid');
  const bottom = lines[0];
  const top = lines[lines.length - 1];
  const x = Number(bottom?.getAttribute('x1'));
  const y = Number(top?.getAttribute('y1'));
  return {
    x,
    y,
    width: Number(bottom?.getAttribute('x2')) - x,
    height: Number(bottom?.getAttribute('y1')) - y,
  };
}

/** 1 client px = 1 SVG unit: the bounding box is the viewBox at the origin. */
function stubSvgRect(el: Card): void {
  const svg = query(el, 'svg');
  if (svg === null) return;
  const [, , width = 0, height = 0] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  svg.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  });
}

function pointerEvent(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId: 1,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
}

/** Drags point `index` from its centre to the height of `value` on the axis `domain`. */
async function dragToValue(
  el: Card,
  index: number,
  value: number,
  domain: { min: number; max: number },
): Promise<void> {
  const hit = queryAll(el, 'g.point')[index]?.querySelector('circle.hit');
  if (!hit) throw new Error(`no point ${index}`);
  const x = Number(hit.getAttribute('cx'));
  const y = Number(hit.getAttribute('cy'));
  const svg = query(el, 'svg');
  hit.dispatchEvent(pointerEvent('pointerdown', x, y));
  await el.updateComplete;
  const target = valueToY(value, plotOf(el), domain);
  svg?.dispatchEvent(pointerEvent('pointermove', x, target));
  await el.updateComplete;
  svg?.dispatchEvent(pointerEvent('pointerup', x, target));
  await el.updateComplete;
}

/** The aria-labels of the points ("Point HH:MM, <value>"). */
function pointLabels(el: Card): string[] {
  return queryAll(el, 'g.point').map((group) => group.getAttribute('aria-label') ?? '');
}

/** The `value` of the last input_text.set_value call. */
function lastSaved(mock: MockHass): unknown {
  return mock.calls.filter((call) => call.service === 'set_value').at(-1)?.data.value;
}

async function settleSave(el: Card): Promise<void> {
  await vi.advanceTimersByTimeAsync(400);
  await el.updateComplete;
}

async function pressKey(el: Card, index: number, key: string, shiftKey = false): Promise<void> {
  const group = queryAll(el, 'g.point')[index] as SVGElement | undefined;
  group?.focus();
  await el.updateComplete;
  group?.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, composed: true }),
  );
  await el.updateComplete;
}

async function selectPoint(el: Card, index: number): Promise<void> {
  const group = queryAll(el, 'g.point')[index] as SVGElement | undefined;
  group?.focus();
  await el.updateComplete;
}

function valueInput(el: Card): HTMLInputElement {
  const input = query(el, '.detail input[type="number"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('no value input');
  return input;
}

async function typeValue(el: Card, text: string): Promise<void> {
  const input = valueInput(el);
  input.value = text;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
}

describe('config: presets and ranges', () => {
  it('fills the defaults of each preset', () => {
    const temperature = normalizeConfig(config({ preset: 'temperature' }));
    expect(temperature.range).toEqual({ min: 5, max: 30, step: 0.5 });
    expect(temperature.unit).toBe(DEG_C);
    expect(temperature.label).toBe('Temp\u{e9}rature');
    expect(temperature.defaultCurve).toBe(TEMPERATURE_CURVE);
    const colour = normalizeConfig(config({ preset: 'color_temp' }));
    expect(colour.range).toEqual({ min: 2000, max: 6500, step: 50 });
    expect(colour.unit).toBe('K');
    expect(colour.label).toBe('Temp\u{e9}rature de couleur');
    expect(colour.defaultCurve).toBe(COLOR_TEMP_CURVE);
    const custom = normalizeConfig(config(OFFSET));
    expect(custom.unit).toBe('');
    expect(custom.label).toBe('Valeur');
    expect(custom.defaultCurve).toBe('19:00@5;23:00@-5');
    expect(PRESETS.brightness.defaultCurve).toBe('19:00@100;21:00@70;22:30@30;23:30@12');
  });

  it('lets explicit keys override the preset', () => {
    const cfg = normalizeConfig(
      config({ preset: 'temperature', min: 16, step: 0.1, unit: '', label: 'Consigne' }),
    );
    expect(cfg.range).toEqual({ min: 16, max: 30, step: 0.1 });
    expect(cfg.unit).toBe('');
    expect(cfg.label).toBe('Consigne');
    // The preset curve is clamped into the new range.
    expect(cfg.defaultCurve).toBe('17:00@20;22:00@18.5;06:00@17;07:00@20');
    expect(normalizeConfig(config({ preset: 'temperature', min: 18 })).defaultCurve).toBe(
      '17:00@20;22:00@18.5;06:00@18;07:00@20',
    );
    // A brightness range with another step.
    expect(normalizeConfig(config({ step: 5 })).range).toEqual({ min: 1, max: 100, step: 5 });
  });

  it('rejects an unknown preset and a custom preset without its range', () => {
    expect(errorOf({ preset: 'humidity' })).toBe(
      "'preset' doit valoir brightness, temperature, color_temp, custom",
    );
    expect(errorOf({ preset: 42 })).toBe(
      "'preset' doit valoir brightness, temperature, color_temp, custom",
    );
    const missing = "le preset custom exige 'min', 'max' et 'step'";
    expect(errorOf({ preset: 'custom' })).toBe(missing);
    expect(errorOf({ preset: 'custom', min: 0, max: 10 })).toBe(missing);
    expect(errorOf({ preset: 'custom', min: 0, step: 1 })).toBe(missing);
    expect(errorOf({ preset: 'custom', min: 0, max: 10, step: 1 })).toBeNull();
  });

  it('checks min and max: numbers with at most 2 decimals within +-9999.99, min < max', () => {
    const bound = (key: string): string =>
      `'${key}' doit \u{ea}tre un nombre entre -9999,99 et 9999,99 avec au plus 2 d\u{e9}cimales`;
    for (const bad of ['5', 0.001, 10000, -10000, Number.NaN, Infinity, true]) {
      expect(errorOf({ min: bad })).toBe(bound('min'));
      expect(errorOf({ max: bad })).toBe(bound('max'));
    }
    expect(errorOf({ min: -9999.99, max: 9999.99, step: 0.01 })).toBeNull();
    expect(errorOf({ min: 0.07 })).toBeNull();
    expect(errorOf({ min: 100 })).toBe(
      `'min' (100) doit \u{ea}tre inf\u{e9}rieur \u{e0} 'max' (100)`,
    );
    expect(errorOf({ preset: 'temperature', min: 30.5 })).toBe(
      `'min' (30,5) doit \u{ea}tre inf\u{e9}rieur \u{e0} 'max' (30)`,
    );
  });

  it('checks step: positive, at most 2 decimals, not wider than the range', () => {
    const message = "'step' doit \u{ea}tre un nombre positif avec au plus 2 d\u{e9}cimales";
    for (const bad of [0, -1, 0.001, 0.125, '1', Number.NaN]) {
      expect(errorOf({ step: bad })).toBe(message);
    }
    expect(errorOf({ preset: 'temperature', step: 30 })).toBe(
      `'step' (30) doit \u{ea}tre au plus l'\u{e9}cart entre 'min' et 'max' (25)`,
    );
    expect(errorOf({ preset: 'temperature', step: 25 })).toBeNull();
    expect(errorOf({ step: 0.01 })).toBeNull();
  });

  it('checks unit, label and default_curve', () => {
    expect(errorOf({ unit: 1 })).toBe("'unit' doit \u{ea}tre une cha\u{ee}ne de caract\u{e8}res");
    expect(errorOf({ label: ['x'] })).toBe(
      "'label' doit \u{ea}tre une cha\u{ee}ne de caract\u{e8}res",
    );
    expect(errorOf({ unit: '' })).toBeNull();
    const curve = "'default_curve' doit contenir au moins 2 points HH:MM@valeur valides";
    for (const bad of ['19:00@50', 'bogus', '', 42]) {
      expect(errorOf({ default_curve: bad })).toBe(curve);
    }
    // Values outside the range are clamped (like the parser), the result is canonical.
    expect(normalizeConfig(config({ default_curve: '23:00@0 ; 19:00@150' })).defaultCurve).toBe(
      '19:00@100;23:00@1',
    );
  });

  it('bounds max_points by the longest token of the range, and says so', () => {
    const message = (limit: number): string =>
      `max_points doit \u{ea}tre un entier entre 2 et ${limit} (limite des 255 caract\u{e8}res de input_text)`;
    expect(errorOf({ max_points: 25 })).toBeNull();
    expect(errorOf({ max_points: 26 })).toBe(message(25));
    expect(errorOf({ preset: 'temperature', max_points: 23 })).toBeNull();
    expect(errorOf({ preset: 'temperature', max_points: 24 })).toBe(message(23));
    expect(errorOf({ preset: 'color_temp', max_points: 24 })).toBe(message(23));
    // "HH:MM@-4.75;" is 12 characters: 21 points.
    expect(errorOf({ ...OFFSET, max_points: 21 })).toBeNull();
    expect(errorOf({ ...OFFSET, max_points: 22 })).toBe(message(21));
    const widest = { min: -9999.99, max: 9999.99, step: 0.01 };
    expect(errorOf({ ...widest, max_points: 17 })).toBeNull();
    expect(errorOf({ ...widest, max_points: 18 })).toBe(message(17));
    // The default (12) always fits.
    expect(normalizeConfig(config(widest)).maxPoints).toBe(12);
  });

  it('fallbackCurve goes from the top of the range at 19:00 to its bottom at 23:00', () => {
    expect(fallbackCurve({ min: 0.5, max: 12.25, step: 0.25 })).toBe('19:00@12.25;23:00@0.5');
  });
});

describe('temperature preset', () => {
  const TEMPERATURE = config({ preset: 'temperature', target_sensor: SENSOR });
  const AXIS = { min: 5, max: 30 };

  it('draws a 5..30 axis with the unit on the top label', async () => {
    const { el } = await mount(TEMPERATURE, { [CURVE]: TEMPERATURE_CURVE });
    expect(axisLabels(el)).toEqual(['5', '10', '15', '20', '25', `30${NNBSP}${DEG_C}`]);
    expect(queryAll(el, 'line.grid')).toHaveLength(6);
    // "30 \u{b0}C" fits in the default 40 px margin plus a little.
    expect(plotOf(el).x).toBe(42);
  });

  it('formats every value with the decimal comma and the unit', async () => {
    const { el } = await mount(TEMPERATURE, {
      [CURVE]: TEMPERATURE_CURVE,
      [SENSOR]: { state: '18.5', attributes: { mode: 'curve' } },
    });
    expect(textOf(query(el, '.chip.now'))).toBe('Maintenant 21:30 \u{b7} 18,5 \u{b0}C');
    expect(query(el, 'text.now-label')?.textContent).toBe(`18,5${NNBSP}${DEG_C}`);
    expect(textOf(query(el, '.chip.sensor'))).toBe('Capteur 18,5 \u{b0}C');
    expect(pointLabels(el)).toEqual([
      `Point 17:00, 20${NNBSP}${DEG_C}`,
      `Point 22:00, 18,5${NNBSP}${DEG_C}`,
      `Point 06:00, 17${NNBSP}${DEG_C}`,
      `Point 07:00, 20${NNBSP}${DEG_C}`,
    ]);
    expect(query(el, 'svg')?.getAttribute('aria-label')).toBe(`Courbe${NBSP}: Temp\u{e9}rature`);
  });

  it('snaps a drag to the 0.5 step and saves the decimal value', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(TEMPERATURE, { [CURVE]: TEMPERATURE_CURVE });
    await dragToValue(el, 1, 19.3, AXIS);
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 19,5${NNBSP}${DEG_C}`);
    await settleSave(el);
    expect(lastSaved(mock)).toBe('17:00@20;22:00@19.5;06:00@17;07:00@20');
    // Past the top of the plot: clamped to 30.
    await dragToValue(el, 1, 40, AXIS);
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 30${NNBSP}${DEG_C}`);
  });

  it('shows the drag tooltip with the formatted value', async () => {
    const { el } = await mount(TEMPERATURE, { [CURVE]: TEMPERATURE_CURVE });
    const hit = queryAll(el, 'g.point')[1]?.querySelector('circle.hit');
    const x = Number(hit?.getAttribute('cx'));
    const y = Number(hit?.getAttribute('cy'));
    hit?.dispatchEvent(pointerEvent('pointerdown', x, y));
    await el.updateComplete;
    query(el, 'svg')?.dispatchEvent(pointerEvent('pointermove', x, valueToY(21, plotOf(el), AXIS)));
    await el.updateComplete;
    expect(query(el, '.tooltip text')?.textContent).toBe(`22:00 \u{b7} 21${NNBSP}${DEG_C}`);
  });

  it('nudges by one step (0.5) with the arrows, five with Shift', async () => {
    const { el } = await mount(TEMPERATURE, { [CURVE]: TEMPERATURE_CURVE });
    await pressKey(el, 1, 'ArrowUp');
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 19${NNBSP}${DEG_C}`);
    await pressKey(el, 1, 'ArrowDown', true);
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 16,5${NNBSP}${DEG_C}`);
  });

  it('moves an off-grid stored value to the grid first', async () => {
    const { el } = await mount(TEMPERATURE, { [CURVE]: '17:00@20;22:00@18.25' });
    // Stored as typed (not snapped): shown with its two decimals.
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 18,25${NNBSP}${DEG_C}`);
    await pressKey(el, 1, 'ArrowUp');
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 18,5${NNBSP}${DEG_C}`);
  });

  it('gives the detail row the range, step, unit and label of the config', async () => {
    const { el } = await mount(TEMPERATURE, { [CURVE]: TEMPERATURE_CURVE });
    await selectPoint(el, 1);
    const input = valueInput(el);
    expect(input.getAttribute('min')).toBe('5');
    expect(input.getAttribute('max')).toBe('30');
    expect(input.getAttribute('step')).toBe('0.5');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(input.getAttribute('lang')).toBe('fr');
    expect(input.value).toBe('18.5');
    const label = input.closest('label');
    expect(textOf(label)).toBe(`Temp\u{e9}rature ${DEG_C}`);
  });

  it('accepts a French comma in the detail row and snaps the typed value', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(TEMPERATURE, { [CURVE]: TEMPERATURE_CURVE });
    await selectPoint(el, 1);
    await typeValue(el, '19,3');
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 19,5${NNBSP}${DEG_C}`);
    expect(valueInput(el).value).toBe('19.5');
    await settleSave(el);
    expect(lastSaved(mock)).toBe('17:00@20;22:00@19.5;06:00@17;07:00@20');
    await typeValue(el, ' 4 ');
    expect(pointLabels(el)[1]).toBe(`Point 22:00, 5${NNBSP}${DEG_C}`);
    await typeValue(el, 'abc');
    expect(textOf(query(el, '.message'))).toBe('Valeur invalide');
    expect(valueInput(el).value).toBe('5');
  });

  it('compares the sensor state with the curve value exactly', async () => {
    const chipNote = async (state: string): Promise<string | null> => {
      const { el } = await mount(TEMPERATURE, { [CURVE]: TEMPERATURE_CURVE, [SENSOR]: state });
      return query(el, '.chip.sensor .reason')?.textContent ?? null;
    };
    // The curve gives 18.5 at 21:30.
    expect(await chipNote('18.5')).toBeNull();
    expect(await chipNote('18.50')).toBeNull();
    expect(await chipNote(' 18.5 ')).toBeNull();
    expect(await chipNote('18.49')).toBe('\u{2260} courbe');
    expect(await chipNote('19')).toBe('\u{2260} courbe');
    expect(await chipNote('unavailable')).toBeNull();
  });

  it('resets an invalid curve to the preset curve', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(TEMPERATURE, { [CURVE]: 'bogus' });
    (query(el, 'button.reset') as HTMLButtonElement | null)?.click();
    await vi.advanceTimersByTimeAsync(0);
    await el.updateComplete;
    expect(lastSaved(mock)).toBe(TEMPERATURE_CURVE);
    expect(queryAll(el, 'g.point')).toHaveLength(4);
  });

  it('resets to default_curve when the config has one', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(
      config({ preset: 'temperature', default_curve: '06:00@19;18:00@21.5' }),
      { [CURVE]: '' },
    );
    (query(el, 'button.reset') as HTMLButtonElement | null)?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSaved(mock)).toBe('18:00@21.5;06:00@19');
  });
});

describe('colour temperature preset', () => {
  const COLOUR = config({ preset: 'color_temp', target_sensor: SENSOR });
  const AXIS = { min: 2000, max: 7000 };

  it('draws a 2000..7000 axis and widens the margin for "7000 K"', async () => {
    const { el } = await mount(COLOUR, { [CURVE]: COLOR_TEMP_CURVE });
    expect(axisLabels(el)).toEqual(['2000', '3000', '4000', '5000', '6000', `7000${NNBSP}K`]);
    expect(plotOf(el).x).toBe(46);
    // The labels end 10 px before the plot.
    expect(queryAll(el, 'text.axis-label')[0]?.getAttribute('x')).toBe('36');
  });

  it('interpolates to the 50 K step and shows kelvins without decimals', async () => {
    const { el } = await mount(COLOUR, {
      [CURVE]: COLOR_TEMP_CURVE,
      [SENSOR]: { state: '2600', attributes: {} },
    });
    // 21:30 between 21:00@2700 and 23:00@2200: 2575 exactly, rounded half up to 2600.
    expect(textOf(query(el, '.chip.now'))).toBe('Maintenant 21:30 \u{b7} 2600 K');
    expect(query(el, '.chip.sensor .reason')).toBeNull();
    expect(textOf(query(el, '.chip.sensor'))).toBe('Capteur 2600 K');
  });

  it('snaps a drag to the 50 K step', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(COLOUR, { [CURVE]: COLOR_TEMP_CURVE });
    await dragToValue(el, 2, 2524, AXIS);
    expect(pointLabels(el)[2]).toBe(`Point 23:00, 2500${NNBSP}K`);
    await dragToValue(el, 2, 1000, AXIS);
    expect(pointLabels(el)[2]).toBe(`Point 23:00, 2000${NNBSP}K`);
    await settleSave(el);
    expect(lastSaved(mock)).toBe('17:00@4000;21:00@2700;23:00@2000');
  });

  it('resets to the colour temperature curve', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(COLOUR, { [CURVE]: 'unknown' });
    (query(el, 'button.reset') as HTMLButtonElement | null)?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSaved(mock)).toBe(COLOR_TEMP_CURVE);
  });
});

describe('custom range', () => {
  const CUSTOM = config({ ...OFFSET, label: 'D\u{e9}calage' });
  const CURVE_TEXT = '18:00@2.5;22:00@-1.75;02:00@-5';

  it('draws a -5..5 axis without unit and bare values', async () => {
    const { el } = await mount(CUSTOM, { [CURVE]: CURVE_TEXT });
    expect(axisLabels(el)).toEqual(['-5', '-2,5', '0', '2,5', '5']);
    expect(pointLabels(el)).toEqual(['Point 18:00, 2,5', 'Point 22:00, -1,75', 'Point 02:00, -5']);
    // 21:30: 2.5 -> -1.75 over 4 h, 3.5 h in: -1.21875, to the 0.25 step: -1.25.
    expect(textOf(query(el, '.chip.now'))).toBe('Maintenant 21:30 \u{b7} -1,25');
    expect(query(el, 'svg')?.getAttribute('aria-label')).toBe(`Courbe${NBSP}: D\u{e9}calage`);
  });

  it('clamps stored values into the range', async () => {
    const { el } = await mount(CUSTOM, { [CURVE]: '18:00@12;22:00@-7.5' });
    expect(pointLabels(el)).toEqual(['Point 18:00, 5', 'Point 22:00, -5']);
  });

  it('snaps negative drags half up and closes the area at the bottom of the axis', async () => {
    const { el } = await mount(CUSTOM, { [CURVE]: CURVE_TEXT });
    await dragToValue(el, 0, -0.13, { min: -5, max: 5 });
    expect(pointLabels(el)[0]).toBe('Point 18:00, -0,25');
    const plot = plotOf(el);
    const area = query(el, 'path.area')?.getAttribute('d') ?? '';
    expect(area).toMatch(new RegExp(` ${plot.y + plot.height} Z$`));
  });

  it('resets to the fallback curve of the range', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(CUSTOM, { [CURVE]: '' });
    (query(el, 'button.reset') as HTMLButtonElement | null)?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSaved(mock)).toBe('19:00@5;23:00@-5');
  });

  it('re-parses the stored curve when a new config brings another range', async () => {
    const { el } = await mount(config(), { [CURVE]: '19:00@100;23:00@2' });
    expect(pointLabels(el)[1]).toBe(`Point 23:00, 2${NNBSP}%`);
    el.setConfig(config({ min: 10 }));
    await el.updateComplete;
    expect(pointLabels(el)[1]).toBe(`Point 23:00, 10${NNBSP}%`);
  });
});

describe('brightness stays as it was', () => {
  it('keeps the 0 / 25 / 50 / 75 / 100 % axis and the 40 px margin', async () => {
    const { el } = await mount(config(), { [CURVE]: '19:00@100;23:30@12' });
    expect(axisLabels(el)).toEqual(['0', '25', '50', '75', `100${NNBSP}%`]);
    expect(plotOf(el).x).toBe(40);
    const window = makeWindow('17:00', '08:00');
    const first = queryAll(el, 'g.point')[0]?.querySelector('circle.dot');
    const minutes = parseTime('19:00') ?? 0;
    expect(Number(first?.getAttribute('cx'))).toBeCloseTo(
      keyToX(sortKey(minutes), window, plotOf(el)),
      1,
    );
  });

  it('compares an integer sensor state written with decimals exactly', async () => {
    const note = async (state: string): Promise<string | null> => {
      const { el } = await mount(config({ target_sensor: SENSOR }), {
        [CURVE]: '19:00@100;21:00@70;22:30@30;23:30@12',
        [SENSOR]: state,
      });
      return query(el, '.chip.sensor .reason')?.textContent ?? null;
    };
    expect(await note('57')).toBeNull();
    expect(await note('57.0')).toBeNull();
    expect(await note('56.99')).toBe('\u{2260} courbe');
  });
});

describe('formatting helpers (src/format.ts)', () => {
  it('formatNumber: decimal comma, no trailing zero, no thousands separator', () => {
    expect(formatNumber(19.5)).toBe('19,5');
    expect(formatNumber(70)).toBe('70');
    expect(formatNumber(-2.05)).toBe('-2,05');
    expect(formatNumber(0.1 + 0.2)).toBe('0,3');
    expect(formatNumber(6500)).toBe('6500');
    expect(formatNumber(-0)).toBe('0');
  });

  it('formatQuantity: a narrow no-break space before the unit, none without unit', () => {
    expect(formatQuantity(19.5, DEG_C)).toBe(`19,5${NNBSP}${DEG_C}`);
    expect(formatQuantity(57, '%')).toBe(`57${NNBSP}%`);
    expect(formatQuantity(2700, 'K')).toBe(`2700${NNBSP}K`);
    expect(formatQuantity(-1.25, '')).toBe('-1,25');
  });

  it('parseDecimal: a comma or a dot, an optional sign, nothing else', () => {
    expect(parseDecimal('19,5')).toBe(19.5);
    expect(parseDecimal(' 19.5 ')).toBe(19.5);
    expect(parseDecimal('-2')).toBe(-2);
    expect(parseDecimal('+3')).toBe(3);
    for (const bad of ['', ' ', '1e3', '19,5,1', 'abc', '.5', '5.', '1 000']) {
      expect(parseDecimal(bad)).toBeNull();
    }
  });

  it('labelWidth estimates the axis labels ("100 %" fits in the 40 px margin)', () => {
    expect(labelWidth(`100${NNBSP}%`, 11) + 10).toBeLessThanOrEqual(40);
    expect(labelWidth(`7000${NNBSP}K`, 11)).toBeGreaterThan(labelWidth(`100${NNBSP}%`, 11));
  });
});

describe('chip helpers (src/card.ts)', () => {
  it('sensorCenti parses the value grammar exactly, other numbers to hundredths', () => {
    expect(sensorCenti('19.5')).toBe(1950);
    expect(sensorCenti(' 57 ')).toBe(5700);
    expect(sensorCenti('-2.05')).toBe(-205);
    expect(sensorCenti('19.555')).toBe(1956);
    expect(sensorCenti('+3')).toBe(300);
    for (const bad of [undefined, 'unavailable', 'unknown', '', '19,5', 'abc']) {
      expect(sensorCenti(bad)).toBeNull();
    }
  });

  it('targetEntityText covers lights, thermostats and any other entity', () => {
    const entity = (
      id: string,
      state: string,
      attributes: Record<string, unknown> = {},
    ): HassEntity => ({ entity_id: id, state, attributes, last_changed: '', last_updated: '' });
    expect(targetEntityText(entity('light.l', 'on', { brightness: 128 }), DEG_C)).toBe(
      `allum\u{e9}e \u{b7} 50${NNBSP}%`,
    );
    expect(targetEntityText(entity('light.l', 'off'), DEG_C)).toBe('\u{e9}teinte');
    expect(
      targetEntityText(entity('climate.c', 'heat', { current_temperature: 20.25 }), DEG_C),
    ).toBe(`20,25${NNBSP}${DEG_C}`);
    expect(targetEntityText(entity('climate.c', 'cool'), DEG_C)).toBe('climatisation');
    expect(targetEntityText(entity('climate.c', 'heat_cool'), DEG_C)).toBe(
      'chauffage / climatisation',
    );
    expect(
      targetEntityText(entity('sensor.t', '21.3', { unit_of_measurement: DEG_C }), DEG_C),
    ).toBe(`21,3${NNBSP}${DEG_C}`);
    expect(targetEntityText(entity('input_select.m', 'Nuit'), DEG_C)).toBe('Nuit');
    expect(targetEntityText(undefined, DEG_C)).toBe('indisponible');
    expect(targetEntityText(entity('light.l', 'unknown'), DEG_C)).toBe('indisponible');
  });
});

describe('sources', () => {
  it('keeps the new TS sources and this file ASCII-only (non-ASCII as unicode escapes)', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const files = ['src/format.ts', 'src/card.ts', 'test/card.presets.test.ts'];
    for (const file of files) {
      const offending = readFileSync(resolve(root, file), 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          Array.from(line).every((char) => char.charCodeAt(0) <= 0x7f) ? [] : [`${file}:${i + 1}`],
        );
      expect(offending).toEqual([]);
    }
  });
});
