/**
 * Tests for the <time-curve-card> element (M0 smoke + M2 read-only rendering):
 * config validation, the SVG chart (points, paths, now marker, ticks), the status row (with the
 * sensor chip of the generic sensor contract: `mode` / `reason`), the invalid / out-of-window
 * states, shouldUpdate and the HA-timezone clock.
 * Non-ASCII characters are written as unicode escapes (the check at the end enforces it).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeCurveCard } from '../src/index.js';
import {
  REASON_MAX_LENGTH,
  SENSOR_MODE_CURVE,
  sensorNote,
  sensorText,
  truncateText,
} from '../src/card.js';
import { MockHass, type MockEntityInit } from '../dev/mock-hass.js';
import type { CardConfig } from '../src/types.js';

const CURVE = 'input_text.brightness_curve';
const SENSOR = 'sensor.brightness_curve_target';
const LIGHT = 'light.example_lamp';
const OTHER = 'input_boolean.brightness_curve_enabled';

/** The reference curve: 57 % at 21:30, 12 % after 23:30, 100 % before 19:00. */
const REFERENCE_CURVE = '19:00@100;21:00@70;22:30@30;23:30@12';

/** No-break space (U+00A0), before ':' in the French messages (M3 fix plan C9). */
const NBSP = '\u{a0}';

/** Narrow no-break space (U+202F), between a value and its unit. */
const NNBSP = '\u{202f}';

/** Middle dot, between a chip value and its note. */
const DOT = '\u{b7}';

/** Ellipsis, at the end of a cut reason. */
const ELLIPSIS = '\u{2026}';

/** The sensor chip notes, and the reason of an override in the tests. */
const MISMATCH = '\u{2260} courbe';
const OVERRIDE = 'R\u{e8}gle prioritaire';
const EXAMPLE_REASON = 'Exemple de r\u{e8}gle';

type Card = HTMLElementTagNameMap['time-curve-card'];

const mounted: Card[] = [];

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
});

function config(extra: Partial<CardConfig> = {}): CardConfig {
  return { type: 'custom:time-curve-card', entity: CURVE, ...extra };
}

/** A fixed clock at `HH:MM` local time (the card falls back to local time without a zone). */
function clockAt(time: string): () => Date {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(2026, 0, 15, hours ?? 0, minutes ?? 0, 0, 0);
  return () => date;
}

async function mount(
  cardConfig: CardConfig,
  entities: Record<string, MockEntityInit>,
  now = '21:30',
): Promise<{ el: Card; mock: MockHass }> {
  const mock = new MockHass(entities);
  const el = document.createElement('time-curve-card');
  el.setConfig(cardConfig);
  el.nowProvider = clockAt(now);
  el.hass = mock.hass;
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  return { el, mock };
}

/** Shadow text with every whitespace run (including the narrow no-break space) as one space. */
function textOf(el: Card): string {
  return (el.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function query(el: Card, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null;
}

function queryAll(el: Card, selector: string): Element[] {
  return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? []);
}

describe('time-curve-card (M0 smoke)', () => {
  it('is registered as a custom element and in window.customCards', () => {
    expect(customElements.get('time-curve-card')).toBeDefined();
    expect(window.customCards?.some((c) => c.type === 'time-curve-card')).toBe(true);
  });

  it('rejects a config without an input_text entity', () => {
    const el = document.createElement('time-curve-card');
    expect(() => {
      el.setConfig({ type: 'custom:time-curve-card', entity: 'light.x' });
    }).toThrow(/input_text/);
  });

  it('renders the chart of the stored curve with a mock hass', async () => {
    const { el } = await mount(config(), { [CURVE]: '19:00@100;23:00@10' });
    expect(query(el, 'svg')).not.toBeNull();
    expect(queryAll(el, 'g.point')).toHaveLength(2);
    expect(query(el, '.invalid')).toBeNull();
  });
});

describe('setConfig validation', () => {
  const card = (): Card => document.createElement('time-curve-card');

  it('requires entity to be an input_text', () => {
    expect(() => {
      card().setConfig({ type: 'x' } as CardConfig);
    }).toThrow(/'entity' est requis et doit \u{ea}tre une entit\u{e9} input_text\.\*/u);
    expect(() => {
      card().setConfig(config({ entity: 'sensor.x' }));
    }).toThrow(/input_text/);
  });

  it('checks the domain of target_sensor and the entity id of target_entity', () => {
    expect(() => {
      card().setConfig(config({ target_sensor: 'light.x' }));
    }).toThrow(/'target_sensor' doit \u{ea}tre une entit\u{e9} sensor\.\*/u);
    for (const bad of ['lampe', 'light.', 'Light.x', 'light.x y', 42 as unknown as string]) {
      expect(() => {
        card().setConfig(config({ target_entity: bad }));
      }).toThrow(`'target_entity' doit \u{ea}tre un identifiant d'entit\u{e9} (domaine.nom)`);
    }
    for (const good of ['light.ok', 'climate.room_2', 'switch.x', '']) {
      expect(() => {
        card().setConfig(config({ target_sensor: 'sensor.ok', target_entity: good }));
      }).not.toThrow();
    }
  });

  it('ignores the old light key (replaced by target_entity)', async () => {
    const { el } = await mount(config({ light: LIGHT } as Partial<CardConfig>), {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: 'on',
    });
    expect(query(el, '.chip.target')).toBeNull();
  });

  it('rejects a non-string title', () => {
    expect(() => {
      card().setConfig(config({ title: 42 as unknown as string }));
    }).toThrow(/'title'/);
  });

  it('propagates the window errors, with a no-break space before the colon', () => {
    expect(() => {
      card().setConfig(config({ window_start: '25:00' }));
    }).toThrow(`window_start invalide${NBSP}: attendu HH:MM`);
    expect(() => {
      card().setConfig(config({ window_end: '8h' }));
    }).toThrow(`window_end invalide${NBSP}: attendu HH:MM`);
    expect(() => {
      card().setConfig(config({ window_start: '20:00', window_end: '18:00' }));
    }).toThrow(
      'window_start (20:00) doit pr\u{e9}c\u{e9}der window_end (18:00) dans la journ\u{e9}e 12:00 \u{2192} 12:00',
    );
    expect(() => {
      card().setConfig(config({ window_start: 12 as unknown as string }));
    }).toThrow(`window_start invalide${NBSP}: attendu HH:MM`);
    expect(() => {
      card().setConfig(config({ window_end: 8 as unknown as string }));
    }).toThrow(`window_end invalide${NBSP}: attendu HH:MM`);
    // No message of the card keeps a breakable space before a colon.
    for (const bad of [{ window_start: '25:00' }, { window_end: 8 as unknown as string }]) {
      expect(() => {
        card().setConfig(config(bad));
      }).not.toThrow(/ :/);
    }
  });

  it('requires snap_minutes to be an integer dividing 60', () => {
    const message =
      'snap_minutes doit \u{ea}tre un entier qui divise 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60)';
    for (const bad of [0, 7, 1.5, 61, -5, '5' as unknown as number]) {
      expect(() => {
        card().setConfig(config({ snap_minutes: bad }));
      }).toThrow(message);
    }
    for (const good of [1, 5, 15, 60]) {
      expect(() => {
        card().setConfig(config({ snap_minutes: good }));
      }).not.toThrow();
    }
  });

  it('requires max_points to be an integer between 2 and 25', () => {
    const message =
      'max_points doit \u{ea}tre un entier entre 2 et 25 (limite des 255 caract\u{e8}res de input_text)';
    for (const bad of [1, 26, 2.5, '12' as unknown as number]) {
      expect(() => {
        card().setConfig(config({ max_points: bad }));
      }).toThrow(message);
    }
    for (const good of [2, 12, 25]) {
      expect(() => {
        card().setConfig(config({ max_points: good }));
      }).not.toThrow();
    }
  });

  it('exposes the Lovelace card API', () => {
    const el = card();
    expect(el.getCardSize()).toBe(5);
    expect(el.getGridOptions()).toEqual({
      columns: 12,
      rows: 'auto',
      min_columns: 6,
      min_rows: 4,
    });
    const Ctor = customElements.get('time-curve-card') as unknown as {
      getStubConfig(): Partial<CardConfig>;
    };
    // A generic stub: the example helper's id and no title.
    expect(Ctor.getStubConfig()).toEqual({ entity: 'input_text.brightness_curve' });
  });
});

describe('chart rendering', () => {
  it('draws one group per point, the line and the area, and the now marker inside the window', async () => {
    const { el } = await mount(config({ title: 'Courbe du soir' }), { [CURVE]: REFERENCE_CURVE });
    const svg = query(el, 'svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);

    const points = queryAll(el, 'g.point');
    expect(points).toHaveLength(4);
    expect(points.map((g) => g.getAttribute('data-index'))).toEqual(['0', '1', '2', '3']);
    // Only the visible marker is clipped: a clip-path would also cut the 44px hit target.
    expect(query(el, 'g.points')?.hasAttribute('clip-path')).toBe(false);
    for (const group of points) {
      const hit = group.querySelector('circle.hit');
      expect(hit?.getAttribute('r')).toBe('22');
      expect(hit?.hasAttribute('clip-path')).toBe(false);
      const dot = group.querySelector('circle.dot');
      expect(dot?.getAttribute('r')).toBe('5');
      expect(dot?.getAttribute('clip-path')).toMatch(/^url\(#tcc-clip-points-\d+\)$/);
    }

    const line = query(el, 'path.line')?.getAttribute('d') ?? '';
    const area = query(el, 'path.area')?.getAttribute('d') ?? '';
    expect(line).toMatch(/^M [\d.]+ [\d.]+( L [\d.]+ [\d.]+)+$/);
    expect(area.startsWith(line)).toBe(true);
    expect(area.endsWith('Z')).toBe(true);
    expect(query(el, 'path.area')?.getAttribute('fill')).toMatch(/^url\(#tcc-gradient-\d+\)$/);

    expect(query(el, '.now-line')).not.toBeNull();
    expect(query(el, '.now-dot')).not.toBeNull();
    expect(textOf(el)).toContain('57 %');
    const label = query(el, 'text.now-label');
    expect(label?.textContent?.replace(/\s+/g, ' ')).toBe('57 %');
    // The label sits on a surface-coloured halo box that spans it (start-anchored here).
    const halo = query(el, 'rect.now-halo');
    expect(halo).not.toBeNull();
    const haloX = Number(halo?.getAttribute('x'));
    const haloWidth = Number(halo?.getAttribute('width'));
    const labelX = Number(label?.getAttribute('x'));
    expect(label?.getAttribute('text-anchor')).toBe('start');
    expect(haloX).toBeLessThan(labelX);
    expect(haloX + haloWidth).toBeGreaterThan(labelX + 20);
    // Every coordinate is formatted with at most 2 decimals.
    for (const attr of ['x', 'y', 'width']) {
      expect(halo?.getAttribute(attr)).toMatch(/^-?\d+(\.\d{1,2})?$/);
    }
    for (const attr of ['x', 'y']) {
      expect(label?.getAttribute(attr)).toMatch(/^-?\d+(\.\d{1,2})?$/);
    }
  });

  it('flips the now label (and its halo) to the left near the right edge', async () => {
    // 07:45 is 15 min before the 08:00 window end: inside the 48px flip zone at any width.
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '07:45');
    const label = query(el, 'text.now-label');
    const halo = query(el, 'rect.now-halo');
    expect(label?.getAttribute('text-anchor')).toBe('end');
    const labelX = Number(label?.getAttribute('x'));
    const haloRight = Number(halo?.getAttribute('x')) + Number(halo?.getAttribute('width'));
    expect(haloRight).toBeGreaterThan(labelX);
    expect(haloRight).toBeLessThan(labelX + 5);
    expect(Number(halo?.getAttribute('x'))).toBeLessThan(labelX - 20);
  });

  it('draws 5 value gridlines and the hour ticks with their labels', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const gridlines = queryAll(el, 'line.grid');
    expect(gridlines).toHaveLength(5);
    // Plot left edge at 40px, value labels right-aligned 10px before it: a marker ring on the
    // window start (outer radius 7px) never paints over "100 %".
    expect(gridlines[0]?.getAttribute('x1')).toBe('40');
    const axisLabels = queryAll(el, 'text.axis-label').map(
      (t) => t.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
    expect(queryAll(el, 'text.axis-label')[4]?.getAttribute('x')).toBe('30');
    expect(axisLabels.slice(0, 5)).toEqual(['0', '25', '50', '75', '100 %']);
    const hourLabels = axisLabels.slice(5);
    expect(queryAll(el, 'line.tick')).toHaveLength(hourLabels.length);
    expect(hourLabels.length).toBeGreaterThanOrEqual(3);
    expect(hourLabels.every((label) => /^\d{1,2}h$/.test(label))).toBe(true);
    expect(hourLabels).toContain('0h');
  });

  it('draws no now line when now is outside the window but still reports the value', async () => {
    // M5: the edge marker (test/card.now-outside.test.ts) replaces the line and its dot.
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '10:00');
    expect(query(el, 'svg')).not.toBeNull();
    expect(query(el, '.now-line')).toBeNull();
    expect(query(el, '.now-dot')).toBeNull();
    expect(query(el, 'g.now')).toBeNull();
    expect(query(el, 'g.now-outside')).not.toBeNull();
    expect(textOf(el)).toContain(`Maintenant 10:00 ${DOT} 12 %`);
  });

  it('honours window_start / window_end for the now marker', async () => {
    const { el } = await mount(
      config({ window_start: '12:00', window_end: '12:00' }),
      { [CURVE]: REFERENCE_CURVE },
      '10:00',
    );
    expect(query(el, '.now-line')).not.toBeNull();
  });

  it('shows the invalid block with the raw string instead of the chart', async () => {
    const { el } = await mount(config(), { [CURVE]: 'bogus' });
    expect(query(el, 'svg')).toBeNull();
    expect(textOf(el)).toContain('Courbe invalide ou vide.');
    expect(query(el, '.invalid code')?.textContent).toBe('bogus');
    expect(textOf(el)).toContain('Maintenant 21:30');
    expect(textOf(el)).not.toContain(`Maintenant 21:30 ${DOT}`);
  });

  it('says when the entity is missing', async () => {
    // M3 fix plan A8: "entity not found" + the entity id, and no reset button.
    const { el } = await mount(config(), {});
    expect(query(el, 'svg')).toBeNull();
    expect(textOf(el)).toContain('Entit\u{e9} introuvable');
    expect(query(el, '.invalid code')?.textContent).toBe(CURVE);
    expect(query(el, '.invalid button')).toBeNull();
  });

  it('counts the points outside the window in the footer note', async () => {
    const one = await mount(config(), { [CURVE]: '19:00@100;23:00@20;10:00@50' }, '22:00');
    expect(queryAll(one.el, 'g.point')).toHaveLength(3);
    expect(query(one.el, '.notes')?.textContent?.trim()).toBe(
      '1 point hors de la fen\u{ea}tre affich\u{e9}e',
    );

    const two = await mount(config(), { [CURVE]: '16:00@100;23:00@20;10:00@50' }, '22:00');
    expect(query(two.el, '.notes')?.textContent?.trim()).toBe(
      '2 points hors de la fen\u{ea}tre affich\u{e9}e',
    );

    const none = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    expect(query(none.el, '.notes')).toBeNull();
  });

  it('passes the title to ha-card', async () => {
    const { el } = await mount(config({ title: 'Courbe du soir' }), { [CURVE]: REFERENCE_CURVE });
    const card: (Element & { header?: string }) | null = query(el, 'ha-card');
    expect(card?.header).toBe('Courbe du soir');
  });

  it('gives ha-card an empty header without a title', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const card: (Element & { header?: string }) | null = query(el, 'ha-card');
    expect(card?.header).toBe('');
  });
});

describe('status row', () => {
  const withLight = config({ target_entity: LIGHT });
  const LAMP = { friendly_name: 'Lampe' };

  it('shows the time and the curve value at now', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    expect(textOf(el)).toContain(`Maintenant 21:30 ${DOT} 57 %`);
    expect(textOf(el)).not.toContain('Capteur');
    expect(query(el, '.chip.target')).toBeNull();
  });

  it('describes a light target: its friendly name, state and brightness', async () => {
    const on = await mount(withLight, {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: { state: 'on', attributes: { ...LAMP, brightness: 153 } },
    });
    expect(query(on.el, '.chip.target')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      `Lampe allum\u{e9}e ${DOT} 60 %`,
    );

    const onNoBrightness = await mount(withLight, {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: { state: 'on', attributes: LAMP },
    });
    expect(textOf(onNoBrightness.el)).toMatch(/Lampe allum\u{e9}e(?! \u{b7})/u);

    const off = await mount(withLight, {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: { state: 'off', attributes: LAMP },
    });
    expect(textOf(off.el)).toContain('Lampe \u{e9}teinte');

    const unavailable = await mount(withLight, {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: { state: 'unavailable', attributes: LAMP },
    });
    expect(textOf(unavailable.el)).toContain('Lampe indisponible');

    const unknown = await mount(withLight, {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: { state: 'unknown', attributes: LAMP },
    });
    expect(textOf(unknown.el)).toContain('Lampe indisponible');

    // No friendly name (or a missing entity): the generic "Appareil".
    const unnamed = await mount(withLight, { [CURVE]: REFERENCE_CURVE, [LIGHT]: 'off' });
    expect(textOf(unnamed.el)).toContain('Appareil \u{e9}teinte');
    const missing = await mount(withLight, { [CURVE]: REFERENCE_CURVE });
    expect(textOf(missing.el)).toContain('Appareil indisponible');
  });

  it('describes a climate target: its current temperature, else its hvac state', async () => {
    const THERMOSTAT = 'climate.your_thermostat';
    const withClimate = config({ preset: 'temperature', target_entity: THERMOSTAT });
    const curve = '17:00@20;22:00@18.5;06:00@17;07:00@20';
    const chip = (el: Card): string =>
      query(el, '.chip.target')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

    const heating = await mount(withClimate, {
      [CURVE]: curve,
      [THERMOSTAT]: {
        state: 'heat',
        attributes: { friendly_name: 'Thermostat', current_temperature: 19.5, temperature: 20 },
      },
    });
    expect(chip(heating.el)).toBe('Thermostat 19,5 \u{b0}C');
    expect(query(heating.el, '.chip.target .value')?.textContent).toBe(`19,5${NNBSP}\u{b0}C`);

    // The HA unit system decides the unit of the current temperature.
    const fahrenheit = await mount(withClimate, {
      [CURVE]: curve,
      [THERMOSTAT]: { state: 'heat', attributes: { current_temperature: 67 } },
    });
    fahrenheit.el.hass = {
      ...fahrenheit.mock.hass,
      config: { unit_system: { temperature: '\u{b0}F' } },
    };
    await fahrenheit.el.updateComplete;
    expect(query(fahrenheit.el, '.chip.target .value')?.textContent).toBe(`67${NNBSP}\u{b0}F`);

    const hvacOnly = await mount(withClimate, {
      [CURVE]: curve,
      [THERMOSTAT]: { state: 'heat', attributes: { friendly_name: 'Thermostat' } },
    });
    expect(chip(hvacOnly.el)).toBe('Thermostat chauffage');
    const off = await mount(withClimate, { [CURVE]: curve, [THERMOSTAT]: 'off' });
    expect(chip(off.el)).toBe('Appareil arr\u{ea}t');
    const odd = await mount(withClimate, { [CURVE]: curve, [THERMOSTAT]: 'eco_boost' });
    expect(chip(odd.el)).toBe('Appareil eco_boost');
    const unavailable = await mount(withClimate, { [CURVE]: curve, [THERMOSTAT]: 'unavailable' });
    expect(chip(unavailable.el)).toBe('Appareil indisponible');
  });

  it('describes any other target: its state and unit_of_measurement', async () => {
    const HUMIDITY = 'sensor.example_humidity';
    const SWITCH = 'switch.example_plug';
    const chip = (el: Card): string | null => query(el, '.chip.target .value')?.textContent ?? null;
    const humidity = await mount(config({ target_entity: HUMIDITY }), {
      [CURVE]: REFERENCE_CURVE,
      [HUMIDITY]: { state: '48.5', attributes: { unit_of_measurement: '%' } },
    });
    expect(chip(humidity.el)).toBe(`48,5${NNBSP}%`);
    const plain = await mount(config({ target_entity: HUMIDITY }), {
      [CURVE]: REFERENCE_CURVE,
      [HUMIDITY]: '1200',
    });
    expect(chip(plain.el)).toBe('1200');
    const plug = await mount(config({ target_entity: SWITCH }), {
      [CURVE]: REFERENCE_CURVE,
      [SWITCH]: 'on',
    });
    expect(chip(plug.el)).toBe('on');
  });

  it('re-renders when the target entity changes', async () => {
    const { el, mock } = await mount(withLight, {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: { state: 'off', attributes: LAMP },
    });
    mock.setState(LIGHT, 'on', { ...LAMP, brightness: 255 });
    el.hass = mock.hass;
    await el.updateComplete;
    expect(textOf(el)).toContain(`Lampe allum\u{e9}e ${DOT} 100 %`);
  });
});

describe('sensor chip (generic sensor contract: mode / reason)', () => {
  const withSensor = config({ target_sensor: SENSOR });

  /** Mounts the card at 21:30 (curve value 57 %) with the sensor entity `sensor`. */
  async function mountSensor(sensor: MockEntityInit): Promise<{ el: Card; mock: MockHass }> {
    return mount(withSensor, { [CURVE]: REFERENCE_CURVE, [SENSOR]: sensor });
  }

  function reasonOf(el: Card): Element | null {
    return query(el, '.chip.sensor .reason');
  }

  it('appends nothing for mode curve, even when the values differ (no minute flicker)', async () => {
    const match = await mountSensor({ state: '57', attributes: { mode: 'curve' } });
    expect(textOf(match.el)).toContain('Capteur 57 %');
    expect(reasonOf(match.el)).toBeNull();

    const late = await mountSensor({ state: '40', attributes: { mode: 'curve' } });
    expect(textOf(late.el)).toContain('Capteur 40 %');
    expect(textOf(late.el)).not.toContain(MISMATCH);
    expect(reasonOf(late.el)).toBeNull();

    // A reason means nothing while the sensor follows the curve (surrounding blanks allowed).
    const withReason = await mountSensor({
      state: '57',
      attributes: { mode: ' curve ', reason: EXAMPLE_REASON },
    });
    expect(reasonOf(withReason.el)).toBeNull();
    expect(textOf(withReason.el)).not.toContain('Exemple');
  });

  it('shows the reason of an override as plain text, with its full text as the title', async () => {
    const { el } = await mountSensor({
      state: '100',
      attributes: { mode: 'override', reason: EXAMPLE_REASON },
    });
    expect(textOf(el)).toContain(`Capteur 100 % ${DOT} ${EXAMPLE_REASON}`);
    expect(reasonOf(el)?.getAttribute('title')).toBe(EXAMPLE_REASON);

    // ANY mode other than `curve` is an override; whitespace runs collapse, blanks are trimmed.
    const other = await mountSensor({
      state: '30',
      attributes: { mode: 'away', reason: '  Maison\n   vide  ' },
    });
    expect(reasonOf(other.el)?.textContent).toBe('Maison vide');
    expect(reasonOf(other.el)?.getAttribute('title')).toBe('Maison vide');

    // Text, never markup.
    const markup = await mountSensor({
      state: '100',
      attributes: { mode: 'override', reason: '<b>Nuit</b> & <i>jour</i>' },
    });
    expect(reasonOf(markup.el)?.textContent).toBe('<b>Nuit</b> & <i>jour</i>');
    expect(reasonOf(markup.el)?.children).toHaveLength(0);

    // The reason stays when the sensor value is unavailable.
    const unavailable = await mountSensor({
      state: 'unavailable',
      attributes: { mode: 'override', reason: EXAMPLE_REASON },
    });
    expect(textOf(unavailable.el)).toContain(`Capteur indisponible ${DOT} ${EXAMPLE_REASON}`);
  });

  it(`says "${OVERRIDE}" for an override without a usable reason`, async () => {
    for (const reason of [undefined, '', '   ', 42, null, ['Nuit']]) {
      const attributes: Record<string, unknown> = { mode: 'override' };
      if (reason !== undefined) attributes.reason = reason;
      const { el } = await mountSensor({ state: '100', attributes });
      expect(textOf(el)).toContain(`Capteur 100 % ${DOT} ${OVERRIDE}`);
      expect(reasonOf(el)?.hasAttribute('title')).toBe(false);
    }
    // Any mode string other than `curve`, even one that looks like it.
    const lookalike = await mountSensor({ state: '57', attributes: { mode: 'Curve' } });
    expect(textOf(lookalike.el)).toContain(`Capteur 57 % ${DOT} ${OVERRIDE}`);
  });

  it(`cuts a long reason to ${REASON_MAX_LENGTH} characters with an ellipsis, full text in the title`, async () => {
    // 67 characters: 'mot0 mot1 ... mot12'.
    const long = Array.from({ length: 13 }, (_, i) => `mot${i}`).join(' ');
    expect(long).toHaveLength(67);
    const { el } = await mountSensor({
      state: '100',
      attributes: { mode: 'override', reason: long },
    });
    const shown = reasonOf(el)?.textContent ?? '';
    expect(shown).toBe(`${long.slice(0, 59).trimEnd()}${ELLIPSIS}`);
    expect(Array.from(shown).length).toBeLessThanOrEqual(REASON_MAX_LENGTH);
    expect(reasonOf(el)?.getAttribute('title')).toBe(long);

    // Exactly 60 characters: shown whole.
    const sixty = 'a'.repeat(60);
    const exact = await mountSensor({
      state: '100',
      attributes: { mode: 'override', reason: sixty },
    });
    expect(reasonOf(exact.el)?.textContent).toBe(sixty);

    // Characters, not UTF-16 units: an emoji is never cut in half.
    const moons = '\u{1f319}'.repeat(61);
    const emoji = await mountSensor({
      state: '100',
      attributes: { mode: 'override', reason: moons },
    });
    expect(reasonOf(emoji.el)?.textContent).toBe(`${'\u{1f319}'.repeat(59)}${ELLIPSIS}`);
  });

  it('keeps the chip inside the status row on a narrow card (CSS ellipsis)', () => {
    const styles = TimeCurveCard.styles.cssText;
    // The same rule caps the target entity chip (a long friendly name).
    const rule = String.raw`\.chip\.sensor,\s*\.chip\.target\s*\{[^}]*`;
    expect(styles).toMatch(new RegExp(`${rule}max-width:\\s*100%`));
    expect(styles).toMatch(new RegExp(`${rule}overflow:\\s*hidden`));
    expect(styles).toMatch(new RegExp(`${rule}text-overflow:\\s*ellipsis`));
  });

  it(`flags a mismatch with "${MISMATCH}" only for a sensor without a mode`, async () => {
    const mismatch = await mountSensor('40');
    expect(textOf(mismatch.el)).toContain(`Capteur 40 % ${DOT} ${MISMATCH}`);
    expect(reasonOf(mismatch.el)?.hasAttribute('title')).toBe(false);

    const match = await mountSensor('57');
    expect(textOf(match.el)).toContain('Capteur 57 %');
    expect(reasonOf(match.el)).toBeNull();

    // A mode that is not a string, or blank, counts as absent.
    for (const mode of [42, '', '  ', null]) {
      const { el } = await mountSensor({ state: '40', attributes: { mode } });
      expect(textOf(el)).toContain(`Capteur 40 % ${DOT} ${MISMATCH}`);
    }

    const followsCurve = await mountSensor({ state: '40', attributes: { mode: 'curve' } });
    expect(textOf(followsCurve.el)).not.toContain(MISMATCH);
  });

  it('shows "indisponible" for an unavailable or missing sensor', async () => {
    const unavailable = await mountSensor('unavailable');
    expect(textOf(unavailable.el)).toContain('Capteur indisponible');
    expect(textOf(unavailable.el)).not.toContain(MISMATCH);

    const missing = await mount(withSensor, { [CURVE]: REFERENCE_CURVE });
    expect(textOf(missing.el)).toContain('Capteur indisponible');
    expect(reasonOf(missing.el)).toBeNull();
  });

  it('follows a change of the mode and the reason', async () => {
    const { el, mock } = await mountSensor({ state: '57', attributes: { mode: 'curve' } });
    mock.setState(SENSOR, '100', { mode: 'override', reason: EXAMPLE_REASON });
    el.hass = mock.hass;
    await el.updateComplete;
    expect(textOf(el)).toContain(`Capteur 100 % ${DOT} ${EXAMPLE_REASON}`);

    mock.setState(SENSOR, '100', { mode: 'override', reason: 'Autre raison' });
    el.hass = mock.hass;
    await el.updateComplete;
    expect(reasonOf(el)?.textContent).toBe('Autre raison');

    mock.setState(SENSOR, '57', { mode: 'curve' });
    el.hass = mock.hass;
    await el.updateComplete;
    expect(reasonOf(el)).toBeNull();
  });
});

describe('sensor contract helpers', () => {
  it('sensorText keeps a non-blank string, collapsed and trimmed', () => {
    expect(sensorText(' a \t b\n')).toBe('a b');
    expect(sensorText('curve')).toBe('curve');
    for (const blank of ['', ' \n ', undefined, null, 1, true, {}, ['x']]) {
      expect(sensorText(blank)).toBeNull();
    }
  });

  it('truncateText cuts to the maximum, ellipsis included, without a trailing blank', () => {
    expect(truncateText('abcdef', 6)).toBe('abcdef');
    expect(truncateText('abcdefg', 6)).toBe(`abcde${ELLIPSIS}`);
    expect(truncateText('abcd efg', 6)).toBe(`abcd${ELLIPSIS}`);
    expect(truncateText('\u{1f319}\u{1f319}\u{1f319}', 2)).toBe(`\u{1f319}${ELLIPSIS}`);
  });

  it('sensorNote applies the chip rules', () => {
    expect(SENSOR_MODE_CURVE).toBe('curve');
    // No mode: the mismatch flag, only when both values are known and differ.
    expect(sensorNote(null, null, 40, 57)).toEqual({ text: MISMATCH, title: null });
    expect(sensorNote(null, 'ignored', 57, 57)).toBeNull();
    expect(sensorNote(null, null, null, 57)).toBeNull();
    expect(sensorNote(null, null, 40, null)).toBeNull();
    // Mode curve: never anything.
    expect(sensorNote('curve', 'ignored', 40, 57)).toBeNull();
    // Any other mode: the reason, else the generic text.
    expect(sensorNote('override', 'Nuit', 40, 57)).toEqual({ text: 'Nuit', title: 'Nuit' });
    expect(sensorNote('override', null, 57, 57)).toEqual({ text: OVERRIDE, title: null });
    expect(sensorNote('manual', null, null, null)).toEqual({ text: OVERRIDE, title: null });
  });
});

describe('shouldUpdate', () => {
  it('skips hass changes that only touch unrelated entities and re-renders on the curve', async () => {
    const { el, mock } = await mount(config({ target_sensor: SENSOR, target_entity: LIGHT }), {
      [CURVE]: REFERENCE_CURVE,
      [SENSOR]: '57',
      [LIGHT]: 'off',
      [OTHER]: 'off',
    });
    const render = vi.spyOn(el, 'render');

    mock.setState(OTHER, 'on');
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).not.toHaveBeenCalled();

    mock.setState(CURVE, '19:00@100;23:00@10');
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    expect(queryAll(el, 'g.point')).toHaveLength(2);

    mock.setState(SENSOR, '80');
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);
    expect(textOf(el)).toContain('Capteur 80 %');

    mock.setState(LIGHT, 'on', { brightness: 255 });
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(3);
    expect(textOf(el)).toContain(`Appareil allum\u{e9}e ${DOT} 100 %`);
  });

  it('re-renders when the HA temperature unit changes (climate target)', async () => {
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const render = vi.spyOn(el, 'render');
    mock.hass = { ...mock.hass, config: { unit_system: { temperature: '\u{b0}F' } } };
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('re-renders when the HA timezone changes', async () => {
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const render = vi.spyOn(el, 'render');
    mock.hass = { ...mock.hass, config: { time_zone: 'Etc/UTC' } };
    el.hass = mock.hass;
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('re-renders when the clock override changes', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    el.nowProvider = clockAt('23:30');
    await el.updateComplete;
    expect(textOf(el)).toContain(`Maintenant 23:30 ${DOT} 12 %`);
  });
});

describe('layout', () => {
  // Regression guard for the phone-width bug: an "aspect-ratio" chart box with a min-height
  // transfers that min-height through the ratio into a 450px minimum WIDTH during intrinsic
  // sizing, which kept the card from shrinking below ~482px in a content-sized host (a grid
  // "auto" track, as in the dev harness). happy-dom does no layout, so the guard checks the
  // static styles: the chart height must come from container-query units of an inline-size
  // container (which also stops the chart contents from widening the card), never from
  // aspect-ratio. Measured in Chromium: 360px card, 328x180 chart, 3-hour ticks (18h ... 6h).
  it('sizes the chart from container-query units so the card can shrink to phone width', () => {
    const styles = TimeCurveCard.styles.cssText;
    expect(styles).toMatch(/\.body\s*\{[^}]*container-type:\s*inline-size/);
    expect(styles).toMatch(
      /\.chart\s*\{[^}]*height:\s*clamp\(\s*180px,\s*calc\(100cqw \/ 2\.5\),\s*320px\s*\)/,
    );
    // The property, not the word: the comments explain why aspect-ratio must not be used.
    expect(styles).not.toMatch(/aspect-ratio\s*:/);
  });
});

describe('lifecycle', () => {
  /** Records observe / unobserve / disconnect calls (happy-dom's ResizeObserver never fires). */
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    readonly observed = new Set<Element>();
    disconnected = false;
    constructor(public readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.instances.push(this);
    }
    observe(target: Element): void {
      this.observed.add(target);
    }
    unobserve(target: Element): void {
      this.observed.delete(target);
    }
    disconnect(): void {
      this.observed.clear();
      this.disconnected = true;
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeResizeObserver.instances.length = 0;
  });

  function observedNow(): Element[] {
    const live = FakeResizeObserver.instances.filter((ro) => !ro.disconnected);
    return live.flatMap((ro) => Array.from(ro.observed));
  }

  it('observes the host and .chart, and again after the card is removed and re-added', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const chart = query(el, '.chart');
    expect(chart).not.toBeNull();
    expect(observedNow()).toEqual(expect.arrayContaining([el, chart]));
    expect(observedNow()).toHaveLength(2);

    el.remove();
    expect(FakeResizeObserver.instances.at(-1)?.disconnected).toBe(true);
    expect(observedNow()).toHaveLength(0);

    // Lovelace removes / re-appends cards on re-layout: the same .chart must be re-observed.
    document.body.append(el);
    await el.updateComplete;
    const chartAgain = query(el, '.chart');
    expect(chartAgain).toBe(chart);
    expect(observedNow()).toEqual(expect.arrayContaining([el, chartAgain]));
    expect(observedNow()).toHaveLength(2);
  });

  it('re-renders once per minute boundary and stops after removal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 21, 30, 0, 0));
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const render = vi.spyOn(el, 'render');

    vi.advanceTimersByTime(59_999);
    await el.updateComplete;
    expect(render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);

    el.remove();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(180_000);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('re-aligns the clock on the minute boundary after a late (throttled) tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 21, 30, 0, 0));
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const render = vi.spyOn(el, 'render');

    // The WebView was suspended: the wall clock jumps 90 s while the pending timer is frozen,
    // so the tick fires 30 s past a minute boundary (21:32:30).
    vi.setSystemTime(Date.now() + 90_000);
    vi.advanceTimersByTime(60_000);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    expect(new Date().getSeconds()).toBe(30);

    // A setInterval would tick at 21:33:30; the clock must land on 21:33:00 instead.
    vi.advanceTimersByTime(29_999);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);
    expect(new Date().getSeconds()).toBe(0);
  });

  it('re-renders and re-aligns the clock when the page becomes visible again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 21, 30, 0, 0));
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const render = vi.spyOn(el, 'render');

    vi.advanceTimersByTime(20_000);
    expect(document.visibilityState).toBe('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    // Restarted at :20 -> the next tick is still on the boundary, not 60 s later.
    vi.advanceTimersByTime(39_999);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);

    el.remove();
    document.dispatchEvent(new Event('visibilitychange'));
    await el.updateComplete;
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe('timezone', () => {
  const instant = new Date('2026-01-15T10:00:00Z');

  function expectedIn(timeZone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(instant);
  }

  it('shows "Maintenant" in the HA timezone, not the browser one', async () => {
    const mock = new MockHass({ [CURVE]: REFERENCE_CURVE });
    mock.hass = { ...mock.hass, config: { time_zone: 'Pacific/Kiritimati' } };
    const el = document.createElement('time-curve-card');
    el.setConfig(config());
    el.nowProvider = () => instant;
    el.hass = mock.hass;
    document.body.append(el);
    mounted.push(el);
    await el.updateComplete;
    const expected = expectedIn('Pacific/Kiritimati');
    expect(expected).toBe('00:00');
    expect(textOf(el)).toContain(`Maintenant ${expected}`);

    mock.hass = { ...mock.hass, config: { time_zone: 'Europe/Paris' } };
    el.hass = mock.hass;
    await el.updateComplete;
    expect(textOf(el)).toContain(`Maintenant ${expectedIn('Europe/Paris')}`);
  });

  it('falls back to the browser clock for an unknown zone', async () => {
    const mock = new MockHass({ [CURVE]: REFERENCE_CURVE });
    mock.hass = { ...mock.hass, config: { time_zone: 'Not/AZone' } };
    const el = document.createElement('time-curve-card');
    el.setConfig(config());
    el.nowProvider = clockAt('21:30');
    el.hass = mock.hass;
    document.body.append(el);
    mounted.push(el);
    await el.updateComplete;
    expect(textOf(el)).toContain(`Maintenant 21:30 ${DOT} 57 %`);
  });
});

describe('sources', () => {
  it('keeps this test file and src/types.ts ASCII-only (non-ASCII as unicode escapes)', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const isAscii = (line: string): boolean => {
      for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) > 0x7f) return false;
      return true;
    };
    for (const file of ['test/card.test.ts', 'src/types.ts']) {
      const offending = readFileSync(resolve(root, file), 'utf8')
        .split('\n')
        .flatMap((line, i) => (isAscii(line) ? [] : [`${file}:${i + 1}`]));
      expect(offending).toEqual([]);
    }
  });
});
