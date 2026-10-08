/**
 * Tests for the M3 interactions of <time-curve-card>: dragging / tapping points, adding
 * one on the background, the detail row, keyboard editing, the debounced save with its echo and
 * error handling, external updates, the reset button and the timers' lifecycle.
 *
 * Pointer events are dispatched on the point hit circles (or on the SVG for the background) with
 * the SVG bounding box stubbed to its viewBox, so 1 client px = 1 SVG unit and target positions
 * can be computed with the geometry helpers.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/index.js';
import { TimeCurveCard, errorMessage, placeTooltip, type Box } from '../src/card.js';
import { DEFAULT_CURVE, parseTime, sortKey, type CurvePoint } from '../src/core/curve.js';
import {
  keyToX,
  makeWindow,
  valueToY,
  type PlotArea,
  type TimeWindow,
} from '../src/core/geometry.js';
import { MockHass, type MockEntityInit, type MockHassOptions } from '../dev/mock-hass.js';
import type { CardConfig } from '../src/types.js';

const CURVE = 'input_text.c';

/** The reference curve: 57 % at 21:30. Point 1 (21:00 @ 70) is the one most tests move. */
const REFERENCE_CURVE = '19:00@100;21:00@70;22:30@30;23:30@12';

/** Narrow no-break space (U+202F), as the card puts before `%`. */
const NNBSP = '\u202f';

/** No-break space (U+00A0), as the card puts before `:` (fix plan C9). */
const NBSP = '\u00a0';

/** The reference curve with point 1 dragged to 21:30 @ 60 (the save most tests expect). */
const MOVED_CURVE = '19:00@100;21:30@60;22:30@30;23:30@12';

/** Save chip texts ("Enregistrement...", "Enregistre" with their French accents). */
const SAVING = 'Enregistrement\u2026';
const SAVED = 'Enregistr\u00e9';

/** Invalid-block texts of an unavailable / missing helper (M3 fix plan A8). */
const UNAVAILABLE_TEXT = 'Entit\u00e9 indisponible';
const MISSING_TEXT = 'Entit\u00e9 introuvable';

/** Message of a background tap that snaps outside the drag window (M3 fix plan B4). */
const OUTSIDE_WINDOW_TEXT = 'En dehors de la fen\u00eatre affich\u00e9e';

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

/** A fixed clock at `HH:MM` local time (the card falls back to local time without a zone). */
function clockAt(time: string): () => Date {
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(2026, 0, 15, hours ?? 0, minutes ?? 0, 0, 0);
  return () => date;
}

interface MountOptions {
  now?: string;
  latency?: number;
  fail?: boolean;
  echo?: boolean;
}

/** Mounts the card on a MockHass wired like the harness: every state change reaches `el.hass`. */
async function mount(
  cardConfig: CardConfig,
  entities: Record<string, MockEntityInit>,
  options: MountOptions = {},
): Promise<{ el: Card; mock: MockHass }> {
  const el = document.createElement('time-curve-card');
  const mockOptions: MockHassOptions = {
    onChange: (hass) => {
      el.hass = hass;
    },
  };
  if (options.latency !== undefined) mockOptions.latency = options.latency;
  if (options.fail !== undefined) mockOptions.failServices = options.fail;
  if (options.echo !== undefined) mockOptions.echo = options.echo;
  const mock = new MockHass(entities, mockOptions);
  el.setConfig(cardConfig);
  el.nowProvider = clockAt(options.now ?? '21:30');
  el.hass = mock.hass;
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  stubSvgRect(el);
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

function svgOf(el: Card): Element {
  const svg = query(el, 'svg');
  if (svg === null) throw new Error('the chart is not rendered');
  return svg;
}

/** Text of the message line; null when it is empty (a persistent live region, fix plan C8). */
function messageOf(el: Card): string | null {
  const text = query(el, '.message')?.textContent?.trim();
  return text === undefined || text === '' ? null : text;
}

/** Text of the save chip; null when it is empty (idle; a persistent live region, fix plan C8). */
function saveChipOf(el: Card): string | null {
  const text = query(el, '.save')?.textContent?.trim();
  return text === undefined || text === '' ? null : text;
}

/** Lets the promise chain of a (rejected) service call settle under fake timers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------------------------
// Geometry: the chart is rendered with the happy-dom fallback width; read the viewBox back and
// rebuild the plot area (margins 40 / 14 / 14 / 24) the card uses.
// ---------------------------------------------------------------------------------------------

interface Geometry {
  plot: PlotArea;
  width: number;
  height: number;
  window: TimeWindow;
}

function geometry(el: Card, windowStart = '17:00', windowEnd = '08:00'): Geometry {
  const [, , w, h] = (svgOf(el).getAttribute('viewBox') ?? '').split(' ').map(Number);
  const width = w ?? 0;
  const height = h ?? 0;
  return {
    plot: { x: 40, y: 14, width: width - 54, height: height - 38 },
    width,
    height,
    window: makeWindow(windowStart, windowEnd),
  };
}

/** 1 client px = 1 SVG unit: the bounding box is the viewBox at the origin. */
function stubSvgRect(el: Card): void {
  const svg = query(el, 'svg');
  if (svg === null) return;
  const { width, height } = geometry(el);
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

function xAt(g: Geometry, time: string): number {
  const minutes = parseTime(time);
  if (minutes === null) throw new Error(`bad time ${time}`);
  return keyToX(sortKey(minutes), g.window, g.plot);
}

function yAt(g: Geometry, value: number): number {
  return valueToY(value, g.plot);
}

function groupOf(el: Card, index: number): Element {
  const group = queryAll(el, 'g.point')[index];
  if (group === undefined) throw new Error(`no point ${index}`);
  return group;
}

function hitOf(el: Card, index: number): Element {
  const hit = groupOf(el, index).querySelector('circle.hit');
  if (hit === null) throw new Error(`no hit target for point ${index}`);
  return hit;
}

function centerOf(hit: Element): { x: number; y: number } {
  return { x: Number(hit.getAttribute('cx')), y: Number(hit.getAttribute('cy')) };
}

/** The rendered points, read back from the aria-labels (`Point HH:MM, NN %`). */
function pointsOf(el: Card): { time: string; value: number }[] {
  return queryAll(el, 'g.point').map((group) => {
    const match = /^Point (\d{2}:\d{2}), (\d+)\u202f%$/.exec(
      group.getAttribute('aria-label') ?? '',
    );
    if (match === null) throw new Error(`bad aria-label ${group.getAttribute('aria-label')}`);
    return { time: match[1] ?? '', value: Number(match[2]) };
  });
}

function pointerEvent(
  type: string,
  x: number,
  y: number,
  init: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId: 1,
    bubbles: true,
    composed: true,
    cancelable: true,
    ...init,
  });
}

/** pointerdown on the hit circle of point `index`; returns the marker centre. */
async function press(el: Card, index: number, pointerId = 1): Promise<{ x: number; y: number }> {
  const hit = hitOf(el, index);
  const centre = centerOf(hit);
  hit.dispatchEvent(pointerEvent('pointerdown', centre.x, centre.y, { pointerId }));
  await el.updateComplete;
  return centre;
}

async function moveTo(el: Card, x: number, y: number, pointerId = 1): Promise<void> {
  svgOf(el).dispatchEvent(pointerEvent('pointermove', x, y, { pointerId }));
  await el.updateComplete;
}

async function release(
  el: Card,
  x: number,
  y: number,
  pointerId = 1,
  type: 'pointerup' | 'pointercancel' | 'lostpointercapture' = 'pointerup',
): Promise<void> {
  svgOf(el).dispatchEvent(pointerEvent(type, x, y, { pointerId }));
  await el.updateComplete;
}

async function dragPoint(el: Card, index: number, x: number, y: number): Promise<void> {
  await press(el, index);
  await moveTo(el, x, y);
  await release(el, x, y);
}

async function tapBackground(el: Card, x: number, y: number): Promise<void> {
  svgOf(el).dispatchEvent(pointerEvent('pointerdown', x, y));
  await el.updateComplete;
  await release(el, x, y);
}

async function tapPoint(el: Card, index: number): Promise<void> {
  const centre = await press(el, index);
  await release(el, centre.x, centre.y);
}

async function focusPoint(el: Card, index: number): Promise<void> {
  (groupOf(el, index) as SVGElement).focus();
  await el.updateComplete;
}

async function pressKey(
  el: Card,
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
): Promise<boolean> {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    composed: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  await el.updateComplete;
  return event.defaultPrevented;
}

function detailInput(el: Card, type: 'time' | 'number'): HTMLInputElement {
  const input = query(el, `.detail input[type="${type}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no ${type} input`);
  return input;
}

async function changeInput(el: Card, input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
}

/** The card's private edit state (local curve, active pointer interaction). */
function internals(el: Card): { localPoints: CurvePoint[] | null; drag: unknown } {
  return el as unknown as { localPoints: CurvePoint[] | null; drag: unknown };
}

/** The elements that may hold the capture of a point drag: its hit circle, its group, the SVG. */
function captureHolders(el: Card, index: number): Element[] {
  return [hitOf(el, index), groupOf(el, index), svgOf(el)];
}

function capturedBy(el: Card, index: number, pointerId = 1): boolean {
  return captureHolders(el, index).some((holder) => holder.hasPointerCapture(pointerId));
}

/**
 * Drops the capture of `pointerId` without any event reaching the card, like a browser losing a
 * pointer whose pointerup / lostpointercapture never arrives.
 */
function dropCapture(el: Card, index: number, pointerId: number): void {
  for (const holder of captureHolders(el, index)) holder.releasePointerCapture(pointerId);
}

// ---------------------------------------------------------------------------------------------

describe('drag', () => {
  it('moves a point with the time snapped to snap_minutes and the value rounded', async () => {
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:32'), yAt(g, 60.3));
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    expect(pointsOf(el)).toHaveLength(4);
    // Nothing is written before the debounce.
    expect(mock.calls).toHaveLength(0);
    // The status row follows the local curve (57 % became 60 % at 21:30).
    expect(textOf(el)).toContain('Maintenant 21:30 \u00b7 60 %');
  });

  it('clamps the value to 1..100 when dragged past the plot', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:00'), -50);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 100 });
    await dragPoint(el, 1, xAt(g, '21:00'), g.height + 50);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 1 });
  });

  it('keeps a dragged point between its neighbours, one step away', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    // Past the next point (22:30): stops at 22:25.
    await dragPoint(el, 1, xAt(g, '23:00'), yAt(g, 70));
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '22:25', '22:30', '23:30']);
    // Before the previous point (19:00): stops at 19:05.
    await dragPoint(el, 1, xAt(g, '18:00'), yAt(g, 70));
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '19:05', '22:30', '23:30']);
  });

  it('clamps the first and last points to the window edges', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 0, -100, yAt(g, 100));
    expect(pointsOf(el)[0]).toEqual({ time: '17:00', value: 100 });
    await dragPoint(el, 3, g.width + 500, yAt(g, 12));
    expect(pointsOf(el)[3]).toEqual({ time: '08:00', value: 12 });
  });

  it('refuses a move when the neighbours leave no room, but still applies the value', async () => {
    // 07:58 + one 5 min step lies past the 08:00 window end: the time cannot change.
    const { el } = await mount(config(), { [CURVE]: '07:58@50;07:59@10' });
    const g = geometry(el);
    await dragPoint(el, 1, g.width + 100, yAt(g, 40));
    expect(pointsOf(el)[1]).toEqual({ time: '07:59', value: 40 });
  });

  it('never puts a point on the noon pivot when the window ends at 12:00', async () => {
    const { el } = await mount(config({ window_end: '12:00' }), {
      [CURVE]: '19:00@100;11:00@10',
    });
    const g = geometry(el, '17:00', '12:00');
    await dragPoint(el, 1, g.width + 100, yAt(g, 10));
    expect(pointsOf(el)[1]).toEqual({ time: '11:55', value: 10 });
  });

  it('shows the tooltip and the enlarged marker while dragging', async () => {
    // At 18:00 the "now" label sits far from the dragged point: the tooltip keeps its default
    // place (next to the now label it moves away, see the M3 repair tests).
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { now: '18:00' });
    const g = geometry(el);
    await press(el, 1);
    expect(query(el, 'g.tooltip')).toBeNull();
    expect(hitOf(el, 1).hasPointerCapture(1)).toBe(true);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    expect(query(el, 'g.tooltip text')?.textContent).toBe(`21:30 \u00b7 60${NNBSP}%`);
    const dot = groupOf(el, 1).querySelector('circle.dot');
    expect(groupOf(el, 1).classList.contains('dragging')).toBe(true);
    expect(dot?.getAttribute('r')).toBe('8');
    const box = query(el, 'g.tooltip rect');
    // Above the marker, horizontally centred on it.
    const cy = Number(dot?.getAttribute('cy'));
    const cx = Number(dot?.getAttribute('cx'));
    expect(Number(box?.getAttribute('y')) + Number(box?.getAttribute('height'))).toBe(cy - 14);
    expect(Number(box?.getAttribute('x')) + Number(box?.getAttribute('width')) / 2).toBeCloseTo(
      cx,
      1,
    );
    await release(el, xAt(g, '21:30'), yAt(g, 60));
    expect(query(el, 'g.tooltip')).toBeNull();
    expect(capturedBy(el, 1)).toBe(false);
    // Still selected after the drag.
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    expect(dot?.getAttribute('r')).toBe('7');
  });

  it('places the tooltip below the marker near the top and keeps it inside the SVG', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 0);
    await moveTo(el, -100, yAt(g, 100));
    const box = query(el, 'g.tooltip rect');
    const cy = Number(groupOf(el, 0).querySelector('circle.dot')?.getAttribute('cy'));
    expect(Number(box?.getAttribute('y'))).toBe(cy + 22);
    expect(Number(box?.getAttribute('x'))).toBe(2);
    await release(el, -100, yAt(g, 100));
  });

  it('ignores events of another pointer during a drag', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 1, 1);
    await moveTo(el, xAt(g, '22:00'), yAt(g, 50), 2);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    await release(el, xAt(g, '22:00'), yAt(g, 50), 2);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60), 1);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    await release(el, xAt(g, '21:30'), yAt(g, 60), 1);
  });

  it('saves after a pointercancel that follows a move', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 1);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    await release(el, xAt(g, '21:30'), yAt(g, 60), 1, 'pointercancel');
    expect(query(el, 'g.tooltip')).toBeNull();
    vi.advanceTimersByTime(400);
    expect(mock.calls).toHaveLength(1);
  });
});

describe('tap', () => {
  it('selects a point without moving it and keeps it selected on a second tap', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    expect(groupOf(el, 1).querySelector('circle.dot')?.getAttribute('r')).toBe('7');
    expect(groupOf(el, 0).querySelector('circle.dot')?.getAttribute('r')).toBe('5');
    expect(query(el, '.detail')).not.toBeNull();
    expect(detailInput(el, 'time').value).toBe('21:00');
    expect(detailInput(el, 'number').value).toBe('70');
    await tapPoint(el, 1);
    expect(query(el, '.detail')).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(mock.calls).toHaveLength(0);
  });

  it('tolerates a 2 px wobble as a tap', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const centre = await press(el, 1);
    await moveTo(el, centre.x + 2, centre.y - 2);
    expect(query(el, 'g.tooltip')).toBeNull();
    await release(el, centre.x + 2, centre.y - 2);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    expect(query(el, '.detail')).not.toBeNull();
  });
});

describe('persistence', () => {
  it('debounces the save and sends the serialized curve to input_text.set_value', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(200);
    await dragPoint(el, 2, xAt(g, '22:30'), yAt(g, 35));
    vi.advanceTimersByTime(399);
    expect(mock.calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(mock.calls).toEqual([
      {
        domain: 'input_text',
        service: 'set_value',
        data: { entity_id: CURVE, value: '19:00@100;21:30@60;22:30@35;23:30@12' },
      },
    ]);
  });

  it('shows "Enregistrement\u2026", then "Enregistr\u00e9" on the echo, then nothing', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 100 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    expect(saveChipOf(el)).toBeNull();
    vi.advanceTimersByTime(400);
    await el.updateComplete;
    expect(saveChipOf(el)).toBe('Enregistrement\u2026');
    await vi.advanceTimersByTimeAsync(100);
    await el.updateComplete;
    expect(mock.hass.states[CURVE]?.state).toBe('19:00@100;21:30@60;22:30@30;23:30@12');
    expect(saveChipOf(el)).toBe('Enregistr\u00e9');
    // The local copy is dropped: the rendered curve is the HA one.
    expect((el as unknown as { localPoints: CurvePoint[] | null }).localPoints).toBeNull();
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    vi.advanceTimersByTime(1999);
    await el.updateComplete;
    expect(saveChipOf(el)).toBe('Enregistr\u00e9');
    vi.advanceTimersByTime(1);
    await el.updateComplete;
    expect(saveChipOf(el)).toBeNull();
  });

  it('writes nothing when the edits end where HA already is', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await dragPoint(el, 1, xAt(g, '21:00'), yAt(g, 70));
    vi.advanceTimersByTime(400);
    await el.updateComplete;
    expect(mock.calls).toHaveLength(0);
    expect((el as unknown as { localPoints: CurvePoint[] | null }).localPoints).toBeNull();
  });

  it('reverts to the HA curve and shows the error when the service call rejects', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { fail: true });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    expect(query(el, '.detail')).not.toBeNull();
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    await el.updateComplete;
    expect(saveChipOf(el)).toBe(`Erreur d'enregistrement${NBSP}: mock: service call failed`);
    expect(query(el, '.save.error')).not.toBeNull();
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    expect(query(el, '.detail')).toBeNull();
    // The error stays until the next change.
    vi.advanceTimersByTime(10_000);
    await el.updateComplete;
    expect(query(el, '.save.error')).not.toBeNull();
  });

  it('treats a save that HA never echoes as an error after 5 s', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { echo: false });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    await el.updateComplete;
    expect(mock.calls).toHaveLength(1);
    expect(saveChipOf(el)).toBe('Enregistrement\u2026');
    vi.advanceTimersByTime(4999);
    await el.updateComplete;
    expect(saveChipOf(el)).toBe('Enregistrement\u2026');
    vi.advanceTimersByTime(1);
    await el.updateComplete;
    expect(saveChipOf(el)).toBe(
      "Valeur refus\u00e9e par Home Assistant (v\u00e9rifiez max: 255 sur l'input_text)",
    );
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
  });

  it('keeps the edits made while a save is in flight', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 100 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    // A second edit while the first call is in flight.
    await dragPoint(el, 2, xAt(g, '22:30'), yAt(g, 35));
    await vi.advanceTimersByTimeAsync(100);
    await el.updateComplete;
    // The first echo must not discard the second edit...
    expect(pointsOf(el)[2]).toEqual({ time: '22:30', value: 35 });
    // ...which is saved by its own debounced call.
    await vi.advanceTimersByTimeAsync(400);
    await el.updateComplete;
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:30@60;22:30@30;23:30@12',
      '19:00@100;21:30@60;22:30@35;23:30@12',
    ]);
    expect(mock.hass.states[CURVE]?.state).toBe('19:00@100;21:30@60;22:30@35;23:30@12');
    expect((el as unknown as { localPoints: CurvePoint[] | null }).localPoints).toBeNull();
  });
});

describe('external updates', () => {
  it('keeps the local curve while dirty and adopts external updates when clean', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    // Mid-drag (pointer still down).
    await press(el, 1);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    mock.setState(CURVE, '19:00@100;23:00@10');
    await el.updateComplete;
    expect(pointsOf(el)).toHaveLength(4);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    await release(el, xAt(g, '21:30'), yAt(g, 60));
    // Dirty, save scheduled: still local.
    mock.setState(CURVE, '19:00@100;23:00@20');
    await el.updateComplete;
    expect(pointsOf(el)).toHaveLength(4);
    // The save overwrites the external value; its echo ends the edit session.
    vi.advanceTimersByTime(400);
    await el.updateComplete;
    expect(mock.hass.states[CURVE]?.state).toBe('19:00@100;21:30@60;22:30@30;23:30@12');
    expect(saveChipOf(el)).toBe('Enregistr\u00e9');
    // Clean: an external update is adopted.
    mock.setState(CURVE, '19:00@100;23:00@30');
    await el.updateComplete;
    expect(pointsOf(el)).toEqual([
      { time: '19:00', value: 100 },
      { time: '23:00', value: 30 },
    ]);
  });

  it('clamps the selection to the new curve and drops it when the curve turns invalid', async () => {
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 3);
    expect(detailInput(el, 'time').value).toBe('23:30');
    mock.setState(CURVE, '19:00@100;23:00@10');
    await el.updateComplete;
    expect(detailInput(el, 'time').value).toBe('23:00');
    mock.setState(CURVE, 'bogus');
    await el.updateComplete;
    expect(query(el, '.detail')).toBeNull();
    expect(query(el, '.invalid')).not.toBeNull();
  });
});

describe('add a point', () => {
  it('adds a snapped point on a background tap, selects it and saves', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await tapBackground(el, xAt(g, '20:02'), yAt(g, 80.4));
    expect(pointsOf(el)).toEqual([
      { time: '19:00', value: 100 },
      { time: '20:00', value: 80 },
      { time: '21:00', value: 70 },
      { time: '22:30', value: 30 },
      { time: '23:30', value: 12 },
    ]);
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    expect(detailInput(el, 'time').value).toBe('20:00');
    expect(messageOf(el)).toBeNull();
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;20:00@80;21:00@70;22:30@30;23:30@12',
    ]);
  });

  it('refuses a point when max_points is reached', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config({ max_points: 4 }), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await tapBackground(el, xAt(g, '20:00'), yAt(g, 80));
    expect(pointsOf(el)).toHaveLength(4);
    expect(messageOf(el)).toBe('Nombre maximal de points atteint (4)');
    vi.advanceTimersByTime(3999);
    await el.updateComplete;
    expect(messageOf(el)).not.toBeNull();
    vi.advanceTimersByTime(1);
    await el.updateComplete;
    expect(messageOf(el)).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it('refuses a point too close to an existing one', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await tapBackground(el, xAt(g, '21:02'), yAt(g, 50));
    expect(pointsOf(el)).toHaveLength(4);
    expect(messageOf(el)).toBe("Trop proche d'un point existant");
  });

  it('ignores taps outside the plot area and swipes on the background', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await tapBackground(el, 10, 10);
    expect(pointsOf(el)).toHaveLength(4);
    expect(messageOf(el)).toBeNull();
    svgOf(el).dispatchEvent(pointerEvent('pointerdown', xAt(g, '20:00'), yAt(g, 80)));
    await moveTo(el, xAt(g, '20:30'), yAt(g, 80));
    expect(query(el, 'g.tooltip')).toBeNull();
    await release(el, xAt(g, '20:30'), yAt(g, 80));
    expect(pointsOf(el)).toHaveLength(4);
    // The swipe left nothing behind: the next tap still adds a point.
    await tapBackground(el, xAt(g, '20:00'), yAt(g, 80));
    expect(pointsOf(el)).toHaveLength(5);
  });
});

describe('detail row', () => {
  it('applies a typed time through the drag clamp and explains the adjustment', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    const time = detailInput(el, 'time');
    expect(time.getAttribute('step')).toBe('300');
    await changeInput(el, time, '23:00');
    expect(pointsOf(el)[1]).toEqual({ time: '22:25', value: 70 });
    expect(messageOf(el)).toBe('Heure ajust\u00e9e pour rester entre les points voisins');
    expect(detailInput(el, 'time').value).toBe('22:25');
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;22:25@70;22:30@30;23:30@12',
    ]);
  });

  it('accepts a time inside the room between the neighbours without a message', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    await changeInput(el, detailInput(el, 'time'), '21:45:00');
    expect(pointsOf(el)[1]).toEqual({ time: '21:45', value: 70 });
    expect(messageOf(el)).toBeNull();
  });

  it('rejects an invalid time', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    await changeInput(el, detailInput(el, 'time'), '');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    expect(messageOf(el)).toBe('Heure invalide');
    expect(detailInput(el, 'time').value).toBe('21:00');
  });

  it('applies a typed value, clamped to 1..100, and rejects a non-number', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    const number = detailInput(el, 'number');
    expect(number.getAttribute('min')).toBe('1');
    expect(number.getAttribute('max')).toBe('100');
    await changeInput(el, number, '55');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 55 });
    await changeInput(el, number, '150');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 100 });
    expect(detailInput(el, 'number').value).toBe('100');
    await changeInput(el, number, '');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 100 });
    expect(messageOf(el)).toBe('Valeur invalide');
    expect(detailInput(el, 'number').value).toBe('100');
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:00@100;22:30@30;23:30@12',
    ]);
  });

  it('disables Supprimer when only 2 points remain', async () => {
    const { el } = await mount(config(), { [CURVE]: '19:00@100;23:00@10' });
    await tapPoint(el, 0);
    const button = query(el, '.detail button.delete');
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(button?.getAttribute('title')).toBe('Une courbe garde au moins 2 points');
    (button as HTMLButtonElement).click();
    await el.updateComplete;
    expect(pointsOf(el)).toHaveLength(2);
  });

  it('deletes the selected point and saves', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    const button = query(el, '.detail button.delete');
    expect(button?.hasAttribute('disabled')).toBe(false);
    expect(button?.hasAttribute('title')).toBe(false);
    (button as HTMLButtonElement).click();
    await el.updateComplete;
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '22:30', '23:30']);
    expect(query(el, '.detail')).toBeNull();
    expect(queryAll(el, 'g.point.selected')).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual(['19:00@100;22:30@30;23:30@12']);
  });

  it('closes with Fermer', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    (query(el, '.detail button.close') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(query(el, '.detail')).toBeNull();
    expect(queryAll(el, 'g.point.selected')).toHaveLength(0);
  });
});

describe('keyboard', () => {
  it('selects a point on focus and nudges it with the arrows (Shift \u00d7 5), then saves once', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const group = groupOf(el, 1);
    expect(group.getAttribute('tabindex')).toBe('0');
    expect(group.getAttribute('role')).toBe('button');
    expect(svgOf(el).getAttribute('tabindex')).toBe('0');
    await focusPoint(el, 1);
    expect(query(el, '.detail')).not.toBeNull();
    expect(await pressKey(el, group, 'ArrowRight')).toBe(true);
    expect(pointsOf(el)[1]).toEqual({ time: '21:05', value: 70 });
    await pressKey(el, group, 'ArrowRight', { shiftKey: true });
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 70 });
    await pressKey(el, group, 'ArrowLeft');
    expect(pointsOf(el)[1]).toEqual({ time: '21:25', value: 70 });
    await pressKey(el, group, 'ArrowUp');
    expect(pointsOf(el)[1]).toEqual({ time: '21:25', value: 71 });
    await pressKey(el, group, 'ArrowDown', { shiftKey: true });
    expect(pointsOf(el)[1]).toEqual({ time: '21:25', value: 66 });
    expect(group.getAttribute('aria-label')).toBe(`Point 21:25, 66${NNBSP}%`);
    expect(await pressKey(el, group, 'a')).toBe(false);
    expect(mock.calls).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:25@66;22:30@30;23:30@12',
    ]);
  });

  it('clamps keyboard moves like a drag', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await focusPoint(el, 1);
    for (let i = 0; i < 4; i++) {
      await pressKey(el, groupOf(el, 1), 'ArrowRight', { shiftKey: true });
    }
    expect(pointsOf(el)[1]).toEqual({ time: '22:25', value: 70 });
    for (let i = 0; i < 25; i++) await pressKey(el, groupOf(el, 1), 'ArrowUp', { shiftKey: true });
    expect(pointsOf(el)[1]).toEqual({ time: '22:25', value: 100 });
  });

  it('deletes with Delete / Backspace (the neighbour takes over) and deselects with Escape', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await focusPoint(el, 1);
    expect(await pressKey(el, groupOf(el, 1), 'Delete')).toBe(true);
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '22:30', '23:30']);
    // Fix plan C5: the next point is selected, so a repeated press deletes it too.
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    expect(detailInput(el, 'time').value).toBe('22:30');
    expect(await pressKey(el, groupOf(el, 1), 'Backspace')).toBe(true);
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '23:30']);
    expect(detailInput(el, 'time').value).toBe('23:30');
    // At 2 points nothing more is deleted.
    await pressKey(el, groupOf(el, 1), 'Delete');
    expect(pointsOf(el)).toHaveLength(2);
    expect(query(el, '.detail')).not.toBeNull();
    expect(await pressKey(el, groupOf(el, 1), 'Escape')).toBe(true);
    expect(query(el, '.detail')).toBeNull();
    // Nothing selected: the keys are left to the browser.
    expect(await pressKey(el, groupOf(el, 1), 'ArrowRight')).toBe(false);
    expect(pointsOf(el)[1]).toEqual({ time: '23:30', value: 12 });
  });
});

describe('invalid curve', () => {
  it('writes DEFAULT_CURVE at once from the reset button', async () => {
    const { el, mock } = await mount(config(), { [CURVE]: 'bogus' });
    const button = query(el, '.invalid button.reset');
    expect(button?.textContent?.trim()).toBe('R\u00e9initialiser la courbe');
    (button as HTMLButtonElement).click();
    expect(mock.calls).toEqual([
      {
        domain: 'input_text',
        service: 'set_value',
        data: { entity_id: CURVE, value: DEFAULT_CURVE },
      },
    ]);
    await el.updateComplete;
    expect(query(el, '.invalid')).toBeNull();
    expect(pointsOf(el)).toHaveLength(4);
    expect(mock.hass.states[CURVE]?.state).toBe(DEFAULT_CURVE);
    expect(saveChipOf(el)).toBe('Enregistr\u00e9');
  });

  it('stays on the invalid block and shows the error when the reset fails', async () => {
    const { el } = await mount(config(), { [CURVE]: '' }, { fail: true });
    (query(el, '.invalid button.reset') as HTMLButtonElement).click();
    await el.updateComplete;
    // M3 fix plan A9: the chart only appears once HA holds a valid curve (never optimistically).
    expect(query(el, 'svg')).toBeNull();
    expect((query(el, '.invalid button.reset') as HTMLButtonElement).disabled).toBe(true);
    await flushMicrotasks();
    await el.updateComplete;
    expect(query(el, 'svg')).toBeNull();
    expect(query(el, '.invalid')).not.toBeNull();
    expect((query(el, '.invalid button.reset') as HTMLButtonElement).disabled).toBe(false);
    expect(saveChipOf(el)).toContain('Erreur');
    expect(saveChipOf(el)).toContain('mock: service call failed');
  });
});

describe('length guard', () => {
  it('refuses a curve that would not fit in the 255 chars of input_text', async () => {
    const { el } = await mount(config({ max_points: 25 }), { [CURVE]: REFERENCE_CURVE });
    // 26 canonical 9-char tokens + 25 separators = 259 > 255 (unreachable from the UI, which
    // caps max_points at 25): exercised through the private method.
    const points: CurvePoint[] = Array.from({ length: 26 }, (_, i) => ({
      time: (720 + i * 5) % 1440,
      value: 100,
    }));
    const card = el as unknown as {
      applyPoints(next: CurvePoint[], options: { save: boolean }): boolean;
    };
    expect(card.applyPoints(points, { save: false })).toBe(false);
    await el.updateComplete;
    expect(messageOf(el)).toBe('Courbe trop longue pour input_text (259 > 255 caract\u00e8res)');
    expect(pointsOf(el)).toHaveLength(4);
  });
});

describe('lifecycle', () => {
  it('flushes a scheduled save when the card is removed', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    expect(mock.calls).toHaveLength(0);
    el.remove();
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:30@60;22:30@30;23:30@12',
    ]);
  });

  it('flushes a scheduled save when the page is hidden', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
    expect(mock.calls).toHaveLength(1);
  });

  it('leaves no timer behind after removal', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config({ max_points: 4 }), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    // A message (4 s), a selection, a scheduled save (400 ms) and an in-flight echo.
    await tapBackground(el, xAt(g, '20:00'), yAt(g, 80));
    expect(messageOf(el)).not.toBeNull();
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    el.remove();
    expect(vi.getTimerCount()).toBe(0);
    await el.updateComplete;
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arms the "Enregistr\u00e9" chip and message timers when re-added to the DOM', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config({ max_points: 4 }), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await tapBackground(el, xAt(g, '20:00'), yAt(g, 80));
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    el.remove();
    await el.updateComplete;
    expect(saveChipOf(el)).toBe('Enregistr\u00e9');
    document.body.append(el);
    await el.updateComplete;
    vi.advanceTimersByTime(4000);
    await el.updateComplete;
    expect(saveChipOf(el)).toBeNull();
    expect(messageOf(el)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// M3 fix plan, section A (persistence / state machine) - one regression test per item.
// ---------------------------------------------------------------------------------------------

describe('fix plan A: save / echo / failure paths', () => {
  it('A1: sends the stored curve again when the edits return to it while a save is in flight', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 1000 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await vi.advanceTimersByTimeAsync(400); // t = 400: call 1 sent, echoed at t = 1400
    expect(mock.calls).toHaveLength(1);
    // Back to the HA position: HA still holds the reference curve, but WILL hold call 1's value.
    await dragPoint(el, 1, xAt(g, '21:00'), yAt(g, 70));
    // One call in flight at a time (M3 repair): the save due at t = 800 waits for call 1's echo.
    await vi.advanceTimersByTimeAsync(400); // t = 800
    expect(mock.calls.map((call) => call.data.value)).toEqual([MOVED_CURVE]);
    await vi.advanceTimersByTimeAsync(600); // t = 1400: echo of call 1, call 2 sent
    await el.updateComplete;
    expect(mock.calls.map((call) => call.data.value)).toEqual([MOVED_CURVE, REFERENCE_CURVE]);
    expect(saveChipOf(el)).toBe(SAVING);
    await vi.advanceTimersByTimeAsync(1000); // t = 2400: echo of call 2
    await el.updateComplete;
    expect(mock.hass.states[CURVE]?.state).toBe(REFERENCE_CURVE);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    expect(internals(el).localPoints).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
  });

  it('A1: does not send the in-flight value twice', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 1000 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await vi.advanceTimersByTimeAsync(400); // call 1 in flight
    await dragPoint(el, 1, xAt(g, '21:45'), yAt(g, 50));
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await vi.advanceTimersByTimeAsync(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([MOVED_CURVE]);
    await vi.advanceTimersByTimeAsync(600); // echo of call 1
    await el.updateComplete;
    expect(internals(el).localPoints).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
  });

  it('A2: an echo that matches the local curve ends the session with the saved chip', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 100 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await vi.advanceTimersByTimeAsync(400);
    expect(saveChipOf(el)).toBe(SAVING);
    await vi.advanceTimersByTimeAsync(100);
    await el.updateComplete;
    expect(mock.hass.states[CURVE]?.state).toBe(MOVED_CURVE);
    expect(internals(el).localPoints).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
  });

  it('A2: stays on "saving" while newer edits are pending at the echo, until their own echo', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 100 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await vi.advanceTimersByTimeAsync(400); // t = 400: call 1 sent, echoed at t = 500
    await dragPoint(el, 2, xAt(g, '22:30'), yAt(g, 35)); // newer edit, saved at t = 800
    await vi.advanceTimersByTimeAsync(100); // echo of call 1
    await el.updateComplete;
    expect(mock.hass.states[CURVE]?.state).toBe(MOVED_CURVE);
    expect(internals(el).localPoints).not.toBeNull();
    expect(pointsOf(el)[2]).toEqual({ time: '22:30', value: 35 });
    expect(saveChipOf(el)).toBe(SAVING);
    await vi.advanceTimersByTimeAsync(300); // t = 800: call 2 sent
    expect(mock.calls).toHaveLength(2);
    expect(saveChipOf(el)).toBe(SAVING);
    await vi.advanceTimersByTimeAsync(100); // echo of call 2
    await el.updateComplete;
    expect(internals(el).localPoints).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
  });

  it('A2: newer edits that return to the echoed value end the session without a call', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 100 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await vi.advanceTimersByTimeAsync(400); // call 1 sent, echoed at t = 500
    await dragPoint(el, 2, xAt(g, '22:30'), yAt(g, 35));
    await vi.advanceTimersByTimeAsync(100); // echo of call 1: still "saving"
    await el.updateComplete;
    expect(saveChipOf(el)).toBe(SAVING);
    await dragPoint(el, 2, xAt(g, '22:30'), yAt(g, 30)); // back to what HA holds
    await vi.advanceTimersByTimeAsync(400);
    await el.updateComplete;
    expect(mock.calls).toHaveLength(1);
    expect(internals(el).localPoints).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    await el.updateComplete;
    expect(saveChipOf(el)).toBeNull();
  });

  it('A3: formats service rejections into a readable message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage({ code: 'invalid_format', message: 'Value too long' })).toBe(
      'Value too long',
    );
    expect(errorMessage('timeout')).toBe('timeout');
    expect(errorMessage(3)).toBe('code 3');
    expect(errorMessage({ code: 'x', message: 42 })).toBe('[object Object]');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('A3: shows the message of a HA websocket rejection ({ code, message })', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const rejection = { code: 'invalid_format', message: 'Value too long' };
    el.hass = {
      ...mock.hass,
      callService: (domain, service, data) => {
        mock.calls.push({ domain, service, data: data ?? {} });
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- HA's websocket rejects with a plain { code, message } object
        return Promise.reject(rejection);
      },
    };
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    await el.updateComplete;
    expect(mock.calls).toHaveLength(1);
    expect(query(el, '.save.error')).not.toBeNull();
    expect(saveChipOf(el)).toContain('Value too long');
    expect(saveChipOf(el)).not.toContain('[object Object]');
  });

  it('A4: a rejection arriving mid-drag aborts the drag; the next moves change nothing', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(
      config(),
      { [CURVE]: REFERENCE_CURVE },
      { latency: 300, fail: true },
    );
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400); // call 1 sent, rejected at t = 700
    expect(mock.calls).toHaveLength(1);
    // A second drag is in progress when the rejection arrives.
    await press(el, 2);
    await moveTo(el, xAt(g, '22:45'), yAt(g, 40));
    expect(pointsOf(el)[2]).toEqual({ time: '22:45', value: 40 });
    expect(capturedBy(el, 2)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    await el.updateComplete;
    expect(saveChipOf(el)).toContain('mock: service call failed');
    expect(pointsOf(el)).toEqual([
      { time: '19:00', value: 100 },
      { time: '21:00', value: 70 },
      { time: '22:30', value: 30 },
      { time: '23:30', value: 12 },
    ]);
    expect(internals(el).drag).toBeNull();
    expect(capturedBy(el, 2)).toBe(false);
    expect(query(el, 'g.tooltip')).toBeNull();
    expect(queryAll(el, 'g.point.dragging')).toHaveLength(0);
    expect(queryAll(el, 'g.point.selected')).toHaveLength(0);
    // The rest of the aborted gesture is ignored.
    await moveTo(el, xAt(g, '23:00'), yAt(g, 20));
    expect(pointsOf(el)[2]).toEqual({ time: '22:30', value: 30 });
    expect(query(el, 'g.tooltip')).toBeNull();
    await release(el, xAt(g, '23:00'), yAt(g, 20));
    await vi.advanceTimersByTimeAsync(2000);
    await el.updateComplete;
    expect(mock.calls).toHaveLength(1);
    expect(query(el, '.save.error')).not.toBeNull();
  });

  it('A5: removing the card mid-drag ends the drag and sends the in-progress edit', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 1);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    expect(capturedBy(el, 1)).toBe(true);
    el.remove();
    expect(mock.calls.map((call) => call.data.value)).toEqual([MOVED_CURVE]);
    expect(internals(el).drag).toBeNull();
    expect(capturedBy(el, 1)).toBe(false);
    await el.updateComplete;
    expect(query(el, 'g.tooltip')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('A5: a new pointerdown recovers from a drag whose pointer is gone', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 1, 1);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60), 1);
    // A second finger while pointer 1 still holds its capture: ignored.
    await press(el, 2, 2);
    await moveTo(el, xAt(g, '22:45'), yAt(g, 40), 2);
    expect(pointsOf(el)[2]).toEqual({ time: '22:30', value: 30 });
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    await release(el, xAt(g, '22:45'), yAt(g, 40), 2);
    // Pointer 1 is lost without its pointerup / lostpointercapture reaching the card.
    dropCapture(el, 1, 1);
    await press(el, 2, 2);
    expect(groupOf(el, 2).classList.contains('selected')).toBe(true);
    await moveTo(el, xAt(g, '22:45'), yAt(g, 40), 2);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    expect(pointsOf(el)[2]).toEqual({ time: '22:45', value: 40 });
    await release(el, xAt(g, '22:45'), yAt(g, 40), 2);
    expect(internals(el).drag).toBeNull();
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:30@60;22:45@40;23:30@12',
    ]);
  });

  it('A6: a debounce that comes due during a drag waits for the pointerup', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60)); // save due at t = 400
    vi.advanceTimersByTime(200);
    await press(el, 2); // a second drag starts 200 ms later...
    await moveTo(el, xAt(g, '22:45'), yAt(g, 40));
    vi.advanceTimersByTime(300); // ...and is still live when the first debounce comes due
    expect(mock.calls).toHaveLength(0);
    await moveTo(el, xAt(g, '23:00'), yAt(g, 35));
    vi.advanceTimersByTime(900); // held still, well past another debounce
    expect(mock.calls).toHaveLength(0);
    await release(el, xAt(g, '23:00'), yAt(g, 35));
    vi.advanceTimersByTime(399);
    expect(mock.calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:30@60;23:00@35;23:30@12',
    ]);
    vi.advanceTimersByTime(2000);
    expect(mock.calls).toHaveLength(1);
  });

  it('A7: a late echo after the echo timeout turns the error into the saved chip', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { echo: false });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    vi.advanceTimersByTime(5000);
    await el.updateComplete;
    expect(query(el, '.save.error')).not.toBeNull();
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    // Another value from elsewhere: adopted, the error stays.
    mock.setState(CURVE, '19:00@100;21:00@70;23:30@12');
    await el.updateComplete;
    expect(pointsOf(el)).toHaveLength(3);
    expect(query(el, '.save.error')).not.toBeNull();
    // HA was only slow: the timed-out value lands.
    mock.setState(CURVE, MOVED_CURVE);
    await el.updateComplete;
    expect(query(el, '.save.error')).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    vi.advanceTimersByTime(2000);
    await el.updateComplete;
    expect(saveChipOf(el)).toBeNull();
    expect(mock.calls).toHaveLength(1);
  });

  it('A8: an unavailable helper says so, with no reset button', async () => {
    const { el } = await mount(config(), { [CURVE]: 'unavailable' });
    expect(query(el, 'svg')).toBeNull();
    expect(query(el, '.invalid.unavailable')).not.toBeNull();
    expect(textOf(el)).toContain(UNAVAILABLE_TEXT);
    expect(textOf(el)).not.toContain('Courbe invalide');
    expect(query(el, '.invalid code')?.textContent).toBe(CURVE);
    expect(query(el, '.invalid button')).toBeNull();
  });

  it('A8: a never-written (unknown) helper offers the reset, which writes the default curve', async () => {
    // A new input_text without `initial:` starts as `unknown` (first start after the migration).
    const { el, mock } = await mount(config(), { [CURVE]: 'unknown' });
    expect(query(el, '.invalid.unavailable')).toBeNull();
    expect(textOf(el)).toContain('Courbe invalide ou vide.');
    expect(query(el, '.invalid code')).toBeNull();
    const button = query(el, '.invalid button.reset');
    expect(button).not.toBeNull();
    (button as HTMLButtonElement).click();
    await el.updateComplete;
    await flushMicrotasks();
    expect(mock.calls.at(-1)).toEqual({
      domain: 'input_text',
      service: 'set_value',
      data: { entity_id: CURVE, value: DEFAULT_CURVE },
    });
  });

  it('A8: a missing helper says so, with no reset button', async () => {
    const { el, mock } = await mount(config(), {});
    expect(query(el, '.invalid.missing')).not.toBeNull();
    expect(textOf(el)).toContain(MISSING_TEXT);
    expect(query(el, '.invalid button')).toBeNull();
    // The helper appears later with a curve: the chart replaces the block.
    mock.setState(CURVE, REFERENCE_CURVE);
    await el.updateComplete;
    expect(query(el, '.invalid')).toBeNull();
    expect(pointsOf(el)).toHaveLength(4);
  });

  it('A8: keeps the reset button for an empty or malformed stored string', async () => {
    for (const state of ['', 'bogus']) {
      const { el } = await mount(config(), { [CURVE]: state });
      expect(textOf(el)).toContain('Courbe invalide ou vide.');
      expect(query(el, '.invalid button.reset')).not.toBeNull();
    }
  });

  it('A9: after a reset the invalid block stays, button disabled, until the echo', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: 'bogus' }, { latency: 500 });
    const resetButton = (): HTMLButtonElement | null =>
      query(el, '.invalid button.reset') as HTMLButtonElement | null;
    resetButton()?.click();
    await el.updateComplete;
    expect(mock.calls.map((call) => call.data.value)).toEqual([DEFAULT_CURVE]);
    expect(query(el, 'svg')).toBeNull();
    expect(query(el, '.invalid code')?.textContent).toBe('bogus');
    expect(resetButton()?.disabled).toBe(true);
    expect(saveChipOf(el)).toBe(SAVING);
    // The status row does not evaluate the default curve before HA holds it (time only).
    expect(queryAll(el, '.chip.now .value')).toHaveLength(1);
    resetButton()?.click();
    await el.updateComplete;
    expect(mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    await el.updateComplete;
    expect(query(el, '.invalid')).toBeNull();
    expect(pointsOf(el)).toHaveLength(4);
    expect(saveChipOf(el)).toBe(SAVED);
  });

  it('A9: a stored curve turning invalid mid-drag ends the drag; the moved point is saved', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 1);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    const holders = captureHolders(el, 1);
    mock.setState(CURVE, 'bogus');
    await el.updateComplete;
    expect(query(el, 'svg')).toBeNull();
    expect(query(el, '.invalid')).not.toBeNull();
    expect(query(el, '.detail')).toBeNull();
    expect(internals(el).drag).toBeNull();
    expect(holders.some((holder) => holder.hasPointerCapture(1))).toBe(false);
    // Local edits win: the moved curve overwrites the invalid value, and the chart comes back.
    vi.advanceTimersByTime(400);
    await el.updateComplete;
    expect(mock.calls.map((call) => call.data.value)).toEqual([MOVED_CURVE]);
    expect(query(el, '.invalid')).toBeNull();
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
  });
});

// ---------------------------------------------------------------------------------------------
// M3 fix plan, section B (pointer / drag) - one regression test per item.
// ---------------------------------------------------------------------------------------------

describe('fix plan B: pointer / drag', () => {
  /** Dispatches a pointer event of the given type (touch, pen, mouse) on `target`. */
  async function pointerOn(
    el: Card,
    target: Element,
    type: string,
    x: number,
    y: number,
    pointerType: string,
  ): Promise<void> {
    target.dispatchEvent(pointerEvent(type, x, y, { pointerType }));
    await el.updateComplete;
  }

  /** The clip rectangle referenced by the `clip-path` attribute of `element`. */
  function clipRectOf(el: Card, element: Element | null | undefined): Element | null {
    const id = /^url\(#([\w-]+)\)$/.exec(element?.getAttribute('clip-path') ?? '')?.[1];
    return id === undefined ? null : query(el, `[id="${id}"] rect`);
  }

  function rectOf(rect: Element | null): { x: number; y: number; width: number; height: number } {
    return {
      x: Number(rect?.getAttribute('x')),
      y: Number(rect?.getAttribute('y')),
      width: Number(rect?.getAttribute('width')),
      height: Number(rect?.getAttribute('height')),
    };
  }

  it('B1: captures the pointer on the pressed element, not on its group', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 1);
    expect(hitOf(el, 1).hasPointerCapture(1)).toBe(true);
    expect(groupOf(el, 1).hasPointerCapture(1)).toBe(false);
    expect(svgOf(el).hasPointerCapture(1)).toBe(false);
    // Events retargeted to the captured circle bubble to the SVG listeners.
    hitOf(el, 1).dispatchEvent(pointerEvent('pointermove', xAt(g, '21:30'), yAt(g, 60)));
    await el.updateComplete;
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    hitOf(el, 1).dispatchEvent(pointerEvent('pointerup', xAt(g, '21:30'), yAt(g, 60)));
    await el.updateComplete;
    expect(hitOf(el, 1).hasPointerCapture(1)).toBe(false);
    expect(internals(el).drag).toBeNull();
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);

    // A press on the marker drawn over the hit circle captures on the marker.
    const dot = groupOf(el, 2).querySelector('circle.dot');
    if (dot === null) throw new Error('no marker for point 2');
    const centre = centerOf(dot);
    dot.dispatchEvent(pointerEvent('pointerdown', centre.x, centre.y, { pointerId: 2 }));
    await el.updateComplete;
    expect(dot.hasPointerCapture(2)).toBe(true);
    expect(groupOf(el, 2).hasPointerCapture(2)).toBe(false);
    await release(el, centre.x, centre.y, 2);
    expect(dot.hasPointerCapture(2)).toBe(false);

    // A press on the background captures on the SVG.
    svgOf(el).dispatchEvent(
      pointerEvent('pointerdown', xAt(g, '20:00'), yAt(g, 80), { pointerId: 3 }),
    );
    await el.updateComplete;
    expect(svgOf(el).hasPointerCapture(3)).toBe(true);
    await release(el, xAt(g, '20:00'), yAt(g, 80), 3);
    expect(svgOf(el).hasPointerCapture(3)).toBe(false);
  });

  it('B2: measures the SVG box once per drag, and again after a resize', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    let left = 0;
    let reads = 0;
    svgOf(el).getBoundingClientRect = () => {
      reads++;
      return {
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + g.width,
        bottom: g.height,
        width: g.width,
        height: g.height,
        toJSON: () => ({}),
      };
    };
    await press(el, 1);
    expect(reads).toBe(1);
    await moveTo(el, xAt(g, '21:15'), yAt(g, 65));
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    expect(reads).toBe(1);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    // The SVG moved 100 px to the right without a resize: the box cached at pointerdown is used.
    left = 100;
    await moveTo(el, xAt(g, '21:45'), yAt(g, 60));
    expect(reads).toBe(1);
    expect(pointsOf(el)[1]).toEqual({ time: '21:45', value: 60 });
    // A ResizeObserver callback during the drag: the next event measures the box again.
    (el as unknown as { onResize(): void }).onResize();
    await moveTo(el, xAt(g, '21:45') + 100, yAt(g, 50));
    expect(reads).toBe(2);
    expect(pointsOf(el)[1]).toEqual({ time: '21:45', value: 50 });
    await moveTo(el, xAt(g, '22:00') + 100, yAt(g, 50));
    await release(el, xAt(g, '22:00') + 100, yAt(g, 50));
    expect(reads).toBe(2);
    expect(pointsOf(el)[1]).toEqual({ time: '22:00', value: 50 });
    // A background tap reads the box once, at pointerdown; its pointerup reuses it.
    await tapBackground(el, xAt(g, '20:00') + 100, yAt(g, 80));
    expect(reads).toBe(3);
    expect(pointsOf(el)[1]).toEqual({ time: '20:00', value: 80 });
  });

  it('B3: a touch or pen press that rolls less than 8 px is a tap; 8 px starts a drag', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    for (const pointerType of ['touch', 'pen']) {
      const hit = hitOf(el, 1);
      const c = centerOf(hit);
      await pointerOn(el, hit, 'pointerdown', c.x, c.y, pointerType);
      await pointerOn(el, hit, 'pointermove', c.x + 7, c.y - 7, pointerType);
      expect(query(el, 'g.tooltip')).toBeNull();
      await pointerOn(el, hit, 'pointerup', c.x + 7, c.y - 7, pointerType);
      expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
      expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
      expect(query(el, '.detail')).not.toBeNull();
    }
    vi.advanceTimersByTime(1000);
    expect(mock.calls).toHaveLength(0);
    // 8 px (about 23 min at this width) is past the slop: a drag, snapped to 21:25.
    const hit = hitOf(el, 1);
    const c = centerOf(hit);
    await pointerOn(el, hit, 'pointerdown', c.x, c.y, 'touch');
    await pointerOn(el, hit, 'pointermove', c.x + 8, c.y, 'touch');
    expect(query(el, 'g.tooltip')).not.toBeNull();
    expect(pointsOf(el)[1]).toEqual({ time: '21:25', value: 70 });
    await pointerOn(el, hit, 'pointerup', c.x + 8, c.y, 'touch');
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:25@70;22:30@30;23:30@12',
    ]);
  });

  it('B3: a mouse press becomes a drag after 3 px', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const hit = hitOf(el, 1);
    const c = centerOf(hit);
    await pointerOn(el, hit, 'pointerdown', c.x, c.y, 'mouse');
    await pointerOn(el, hit, 'pointermove', c.x, c.y + 2, 'mouse');
    expect(query(el, 'g.tooltip')).toBeNull();
    await pointerOn(el, hit, 'pointerup', c.x, c.y + 2, 'mouse');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    // 3 px down = 2.1 % at this height: 70 -> 68.
    await pointerOn(el, hit, 'pointerdown', c.x, c.y, 'mouse');
    await pointerOn(el, hit, 'pointermove', c.x, c.y + 3, 'mouse');
    expect(query(el, 'g.tooltip')).not.toBeNull();
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 68 });
    await pointerOn(el, hit, 'pointerup', c.x, c.y + 3, 'mouse');
  });

  it('B4: snaps a background tap in key space; the 12:00 window end is outside', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config({ window_end: '12:00' }), {
      [CURVE]: '19:00@100;23:00@10',
    });
    const g = geometry(el, '17:00', '12:00');
    // The right edge rounds to key 1440 (12:00 the next day), past the drag window that ends one
    // step before the pivot: refused as outside, not wrapped to 12:00 (key 0) and blamed on
    // a neighbour.
    await tapBackground(el, g.plot.x + g.plot.width - 0.5, yAt(g, 40));
    expect(pointsOf(el)).toHaveLength(2);
    expect(messageOf(el)).toBe(OUTSIDE_WINDOW_TEXT);
    // 11:53 rounds to 11:55, the last step inside the drag window: added after 23:00.
    await tapBackground(el, xAt(g, '11:53'), yAt(g, 40));
    expect(pointsOf(el)).toEqual([
      { time: '19:00', value: 100 },
      { time: '23:00', value: 10 },
      { time: '11:55', value: 40 },
    ]);
    expect(groupOf(el, 2).classList.contains('selected')).toBe(true);
    // The neighbour check comes after the window check.
    await tapBackground(el, xAt(g, '23:02'), yAt(g, 40));
    expect(pointsOf(el)).toHaveLength(3);
    expect(messageOf(el)).toBe("Trop proche d'un point existant");
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual(['19:00@100;23:00@10;11:55@40']);
  });

  it('B4: a window start off the snap grid refuses a tap that rounds before it', async () => {
    const { el } = await mount(config({ window_start: '17:02' }), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el, '17:02', '08:00');
    // x of 17:02 exactly: the key rounds down to 17:00, left of the window.
    await tapBackground(el, g.plot.x, yAt(g, 40));
    expect(pointsOf(el)).toHaveLength(4);
    expect(messageOf(el)).toBe(OUTSIDE_WINDOW_TEXT);
    await tapBackground(el, xAt(g, '17:04'), yAt(g, 40));
    expect(pointsOf(el)[0]).toEqual({ time: '17:05', value: 40 });
  });

  it('B5: the SVG lets the hit targets overflow its box', () => {
    const styles = TimeCurveCard.styles.cssText;
    expect(styles).toMatch(/\.chart svg\s*\{[^}]*overflow:\s*visible/);
    expect(styles).not.toMatch(/\.chart svg\s*\{[^}]*overflow:\s*hidden/);
  });

  it('B5: clips the hit target of a point outside the window to the reach of an edge target', async () => {
    // 10:00 lies past the 08:00 window end: its target would otherwise be extrapolated right of
    // the card, over whatever the dashboard shows there.
    const { el } = await mount(config(), { [CURVE]: '19:00@100;23:30@12;10:00@80' });
    const g = geometry(el);
    const hits = queryAll(el, 'g.point circle.hit');
    expect(hits).toHaveLength(3);
    expect(hits[0]?.hasAttribute('clip-path')).toBe(false);
    expect(hits[1]?.hasAttribute('clip-path')).toBe(false);
    expect(hits[2]?.getAttribute('clip-path')).toMatch(/^url\(#tcc-clip-hits-\d+\)$/);
    expect(rectOf(clipRectOf(el, hits[2]))).toEqual({
      x: g.plot.x - 22,
      y: g.plot.y - 22,
      width: g.plot.width + 44,
      height: g.plot.height + 44,
    });
    // Dragged back into the window, its target is whole again.
    const hit = hits[2];
    if (hit === undefined) throw new Error('no hit target for point 2');
    const c = centerOf(hit);
    hit.dispatchEvent(pointerEvent('pointerdown', c.x, c.y));
    await el.updateComplete;
    await moveTo(el, xAt(g, '07:00'), yAt(g, 80));
    await release(el, xAt(g, '07:00'), yAt(g, 80));
    expect(pointsOf(el)[2]).toEqual({ time: '07:00', value: 80 });
    expect(hitOf(el, 2).hasAttribute('clip-path')).toBe(false);
  });

  it('B6: pads the marker clip by 10 px, so a dragged marker on the plot corner stays whole', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    await press(el, 0);
    await moveTo(el, -100, -100);
    const dot = groupOf(el, 0).querySelector('circle.dot');
    if (dot === null) throw new Error('no marker for point 0');
    expect(dot.getAttribute('r')).toBe('8');
    const clip = rectOf(clipRectOf(el, dot));
    expect(clip).toEqual({
      x: g.plot.x - 10,
      y: g.plot.y - 10,
      width: g.plot.width + 20,
      height: g.plot.height + 20,
    });
    // Marker at the top-left corner of the plot: r 8 + half of the 3 px selected ring.
    const { x, y } = centerOf(dot);
    expect(x).toBe(g.plot.x);
    expect(y).toBe(g.plot.y);
    expect(x - 9.5).toBeGreaterThanOrEqual(clip.x);
    expect(y - 9.5).toBeGreaterThanOrEqual(clip.y);
    await release(el, -100, -100);
  });

  it('B7: puts the tooltip below a marker 31 px from the top, above one 35 px from it', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    const dot = (): Element | null => groupOf(el, 1).querySelector('circle.dot');
    const box = (): Element | null => query(el, 'g.tooltip rect');
    await press(el, 1);
    // 88 % -> cy = 31: 14 px gap + 18 px box would end 1 px above the SVG top.
    await moveTo(el, xAt(g, '21:30'), yAt(g, 88));
    const low = Number(dot()?.getAttribute('cy'));
    expect(low).toBeCloseTo(31, 0);
    expect(Number(box()?.getAttribute('y'))).toBeCloseTo(low + 22, 1);
    // 85 % -> cy = 35.3: the box fits above, 2 px or more inside the SVG.
    await moveTo(el, xAt(g, '21:30'), yAt(g, 85));
    const high = Number(dot()?.getAttribute('cy'));
    expect(high).toBeGreaterThanOrEqual(35);
    expect(Number(box()?.getAttribute('y'))).toBeCloseTo(high - 14 - 18, 1);
    expect(Number(box()?.getAttribute('y'))).toBeGreaterThanOrEqual(2);
    await release(el, xAt(g, '21:30'), yAt(g, 85));
  });

  it('B8: puts the selected / dragging classes on the marker as well as on the group', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const g = geometry(el);
    const dot = (index: number): Element | null => groupOf(el, index).querySelector('circle.dot');
    await press(el, 1);
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    expect(dot(1)?.classList.contains('selected')).toBe(true);
    expect(dot(1)?.classList.contains('dragging')).toBe(false);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    expect(groupOf(el, 1).classList.contains('dragging')).toBe(true);
    const dragged = queryAll(el, 'circle.dot.dragging');
    expect(dragged).toHaveLength(1);
    expect(dragged[0]).toBe(dot(1));
    const selected = queryAll(el, 'circle.dot.selected');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(dot(1));
    await release(el, xAt(g, '21:30'), yAt(g, 60));
    expect(queryAll(el, 'circle.dot.dragging')).toHaveLength(0);
    expect(dot(1)?.classList.contains('selected')).toBe(true);
    expect(dot(0)?.getAttribute('class')).toBe('dot');
    (query(el, '.detail button.close') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(queryAll(el, 'circle.dot.selected')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// M3 fix plan, section C (detail row, focus, keyboard, a11y) - one regression test per item.
// ---------------------------------------------------------------------------------------------

describe('fix plan C: detail row, focus, keyboard, a11y', () => {
  const LIGHT = 'light.l';

  /** Messages of the time input (fix plan C3). */
  const NO_ROOM_TEXT = 'Pas de place entre les points voisins';
  const WINDOW_LIMIT_TEXT = 'Heure limit\u00e9e \u00e0 la fen\u00eatre affich\u00e9e';
  const NEIGHBOUR_TEXT = 'Heure ajust\u00e9e pour rester entre les points voisins';
  const roundedText = (time: string): string => `Heure arrondie \u00e0 ${time}`;

  /** Hint (and title) of a disabled "Supprimer" (fix plan C7). */
  const DELETE_HINT = 'Une courbe garde au moins 2 points';

  /**
   * Emulates a browser: an edited field that loses the focus (blur(), or the focus moving to
   * another element) fires its pending `change` first. happy-dom fires no `change` on blur.
   */
  function commitOnBlur(input: HTMLInputElement): void {
    const initial = input.value;
    const blur = input.blur.bind(input);
    input.blur = () => {
      if (input.value !== initial) input.dispatchEvent(new Event('change', { bubbles: true }));
      blur();
    };
  }

  function activeOf(el: Card): Element | null {
    return el.shadowRoot?.activeElement ?? null;
  }

  /** Waits for the render and for the focus moves queued after it. */
  async function settle(el: Card): Promise<void> {
    await el.updateComplete;
    await flushMicrotasks();
  }

  function stylesText(): string {
    return TimeCurveCard.styles.cssText;
  }

  it('C1: a value typed in the row commits to ITS point when another point is pressed', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    const number = detailInput(el, 'number');
    number.focus();
    expect(activeOf(el)).toBe(number);
    commitOnBlur(number);
    number.value = '4'; // typed, not committed yet
    const centre = await press(el, 2);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 4 });
    expect(pointsOf(el)[2]).toEqual({ time: '22:30', value: 30 });
    expect(groupOf(el, 2).classList.contains('selected')).toBe(true);
    expect(detailInput(el, 'number').value).toBe('30');
    await release(el, centre.x, centre.y);
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:00@4;22:30@30;23:30@12',
    ]);
  });

  it('C1: a late change of a replaced row applies to its own point, to none once deleted', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    const rowOf1 = detailInput(el, 'number');
    await tapPoint(el, 2);
    expect(detailInput(el, 'number')).not.toBe(rowOf1);
    // The change of the old row (a blur that fired late) still targets point 1.
    await changeInput(el, rowOf1, '45');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 45 });
    expect(pointsOf(el)[2]).toEqual({ time: '22:30', value: 30 });
    expect(detailInput(el, 'number').value).toBe('30');
    // The row of a deleted point changes nothing.
    const rowOf2 = detailInput(el, 'time');
    (query(el, '.detail button.delete') as HTMLButtonElement).click();
    await el.updateComplete;
    await changeInput(el, rowOf2, '22:45');
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '21:00', '23:30']);
    expect(messageOf(el)).toBeNull();
  });

  it('C2: a re-render (clock tick, watched entity) never overwrites what the user is typing', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config({ target_entity: LIGHT }), {
      [CURVE]: REFERENCE_CURVE,
      [LIGHT]: 'on',
    });
    await tapPoint(el, 1);
    const number = detailInput(el, 'number');
    number.focus();
    number.value = '4'; // typed, not committed
    vi.advanceTimersByTime(60_000); // the minute tick
    await el.updateComplete;
    expect(number.value).toBe('4');
    mock.setState(LIGHT, 'off');
    await el.updateComplete;
    expect(textOf(el)).toContain('Appareil \u00e9teinte');
    expect(detailInput(el, 'number')).toBe(number);
    expect(number.value).toBe('4');
    // Committed, it is applied as usual.
    await changeInput(el, number, '4');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 4 });
    expect(number.value).toBe('4');
  });

  it('C2: another point gets fresh inputs, even when it has the same values', async () => {
    const { el } = await mount(config(), { [CURVE]: '19:00@100;21:00@50;22:30@50;23:30@12' });
    await focusPoint(el, 1);
    const number = detailInput(el, 'number');
    number.value = '4'; // typed but never committed
    await focusPoint(el, 2);
    expect(detailInput(el, 'number')).not.toBe(number);
    expect(detailInput(el, 'number').value).toBe('50');
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 50 });
    expect(pointsOf(el)[2]).toEqual({ time: '22:30', value: 50 });
  });

  it('C2: a change that leaves the point as it was resets the field explicitly', async () => {
    const { el } = await mount(config(), { [CURVE]: '19:00@100;21:00@100;22:30@30;23:30@12' });
    await tapPoint(el, 1);
    const number = detailInput(el, 'number');
    await changeInput(el, number, '150'); // clamped to 100: the point does not change
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 100 });
    expect(number.value).toBe('100');
    const time = detailInput(el, 'time');
    await changeInput(el, time, '21:02'); // rounded back to 21:00: the point does not change
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 100 });
    expect(time.value).toBe('21:00');
  });

  it('C3: says when the window limited the time (the window wins a tie with a neighbour)', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 0);
    await changeInput(el, detailInput(el, 'time'), '16:00');
    expect(pointsOf(el)[0]).toEqual({ time: '17:00', value: 100 });
    expect(messageOf(el)).toBe(WINDOW_LIMIT_TEXT);
    expect(detailInput(el, 'time').value).toBe('17:00');
    await tapPoint(el, 3);
    await changeInput(el, detailInput(el, 'time'), '09:00');
    expect(pointsOf(el)[3]).toEqual({ time: '08:00', value: 12 });
    expect(messageOf(el)).toBe(WINDOW_LIMIT_TEXT);
    // 16:55 + one step = 17:00 = the window start: both bounds agree, the window is named.
    const other = await mount(config(), { [CURVE]: '16:55@100;21:00@70;23:30@12' });
    await tapPoint(other.el, 1);
    await changeInput(other.el, detailInput(other.el, 'time'), '16:00');
    expect(pointsOf(other.el)[1]).toEqual({ time: '17:00', value: 70 });
    expect(messageOf(other.el)).toBe(WINDOW_LIMIT_TEXT);
  });

  it('C3: says when a neighbour limited the time, from either side', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 2);
    await changeInput(el, detailInput(el, 'time'), '20:00');
    expect(pointsOf(el)[2]).toEqual({ time: '21:05', value: 30 });
    expect(messageOf(el)).toBe(NEIGHBOUR_TEXT);
    await changeInput(el, detailInput(el, 'time'), '23:50');
    expect(pointsOf(el)[2]).toEqual({ time: '23:25', value: 30 });
    expect(messageOf(el)).toBe(NEIGHBOUR_TEXT);
  });

  it('C3: says when the time was only rounded to the step, nothing when it is unchanged', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    await changeInput(el, detailInput(el, 'time'), '21:33');
    expect(pointsOf(el)[1]).toEqual({ time: '21:35', value: 70 });
    expect(messageOf(el)).toBe(roundedText('21:35'));
    expect(detailInput(el, 'time').value).toBe('21:35');
    vi.advanceTimersByTime(4000);
    await el.updateComplete;
    expect(messageOf(el)).toBeNull();
    await changeInput(el, detailInput(el, 'time'), '21:35');
    expect(messageOf(el)).toBeNull();
    // Rounded back onto its own time: said, and the field shows it.
    await changeInput(el, detailInput(el, 'time'), '21:37');
    expect(pointsOf(el)[1]).toEqual({ time: '21:35', value: 70 });
    expect(messageOf(el)).toBe(roundedText('21:35'));
    expect(detailInput(el, 'time').value).toBe('21:35');
  });

  it('C3: refuses any time when the neighbours leave no room (the field and a drag)', async () => {
    vi.useFakeTimers();
    // 21:02 lies less than a step from both neighbours: it has no legal position at all.
    const { el, mock } = await mount(config(), { [CURVE]: '21:00@50;21:02@40;21:04@30' });
    await tapPoint(el, 1);
    await changeInput(el, detailInput(el, 'time'), '21:30');
    expect(pointsOf(el).map((p) => p.time)).toEqual(['21:00', '21:02', '21:04']);
    expect(messageOf(el)).toBe(NO_ROOM_TEXT);
    expect(detailInput(el, 'time').value).toBe('21:02');
    vi.advanceTimersByTime(400);
    expect(mock.calls).toHaveLength(0);
    // A drag cannot push it past its neighbour either: only the value follows the pointer.
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    expect(pointsOf(el)).toEqual([
      { time: '21:00', value: 50 },
      { time: '21:02', value: 60 },
      { time: '21:04', value: 30 },
    ]);
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual(['21:00@50;21:02@60;21:04@30']);
  });

  it('C4: a press marks the focus as pointer-given until the next key press', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    expect(el.hasAttribute('pointer-focus')).toBe(false);
    await tapPoint(el, 1);
    expect(el.hasAttribute('pointer-focus')).toBe(true);
    expect(activeOf(el)).toBe(groupOf(el, 1));
    // A shortcut with a modifier is not keyboard navigation.
    await pressKey(el, groupOf(el, 1), 'c', { ctrlKey: true });
    expect(el.hasAttribute('pointer-focus')).toBe(true);
    await pressKey(el, groupOf(el, 1), 'ArrowRight');
    expect(el.hasAttribute('pointer-focus')).toBe(false);
    // Set again by a press, cleared by a key anywhere in the card (the detail row included).
    await tapPoint(el, 2);
    expect(el.hasAttribute('pointer-focus')).toBe(true);
    await pressKey(el, detailInput(el, 'number'), 'Tab');
    expect(el.hasAttribute('pointer-focus')).toBe(false);
    // Only the keyboard modality paints the focus rings.
    const styles = stylesText();
    const scoped = ':host(:not([pointer-focus])) .point:focus-visible .hit';
    expect(styles.split('.point:focus-visible').length - 1).toBe(1);
    expect(styles).toContain(scoped);
    expect(styles).toContain(':host(:not([pointer-focus])) .chart svg:focus-visible');
  });

  it('C5: leaves Alt / Ctrl / Meta combinations to the browser', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await focusPoint(el, 1);
    const group = groupOf(el, 1);
    expect(await pressKey(el, group, 'ArrowRight', { ctrlKey: true })).toBe(false);
    expect(await pressKey(el, group, 'ArrowUp', { altKey: true })).toBe(false);
    expect(await pressKey(el, group, 'Delete', { metaKey: true })).toBe(false);
    expect(await pressKey(el, group, 'Backspace', { altKey: true })).toBe(false);
    expect(await pressKey(el, group, 'Escape', { ctrlKey: true })).toBe(false);
    expect(pointsOf(el)).toHaveLength(4);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 70 });
    expect(group.classList.contains('selected')).toBe(true);
    // Shift alone still multiplies the step.
    expect(await pressKey(el, group, 'ArrowRight', { shiftKey: true })).toBe(true);
    expect(pointsOf(el)[1]).toEqual({ time: '21:25', value: 70 });
  });

  it('C5: a keyboard Delete selects and focuses the neighbouring point', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await focusPoint(el, 1);
    await pressKey(el, groupOf(el, 1), 'Delete');
    await settle(el);
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '22:30', '23:30']);
    expect(activeOf(el)).toBe(groupOf(el, 1));
    expect(groupOf(el, 1).getAttribute('aria-label')).toBe(`Point 22:30, 30${NNBSP}%`);
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    // The last point: the previous one takes over (its group was removed with it).
    await focusPoint(el, 2);
    await pressKey(el, groupOf(el, 2), 'Delete');
    await settle(el);
    expect(pointsOf(el).map((p) => p.time)).toEqual(['19:00', '22:30']);
    expect(activeOf(el)).toBe(groupOf(el, 1));
    expect(groupOf(el, 1).classList.contains('selected')).toBe(true);
    expect(detailInput(el, 'time').value).toBe('22:30');
  });

  it('C5: Escape, "Fermer" and "Supprimer" move the focus to the chart', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await focusPoint(el, 1);
    await pressKey(el, groupOf(el, 1), 'Escape');
    await settle(el);
    expect(query(el, '.detail')).toBeNull();
    expect(activeOf(el)).toBe(svgOf(el));

    await tapPoint(el, 1);
    const close = query(el, '.detail button.close') as HTMLButtonElement;
    close.focus();
    close.click();
    await settle(el);
    expect(query(el, '.detail')).toBeNull();
    expect(activeOf(el)).toBe(svgOf(el));

    await tapPoint(el, 2);
    const remove = query(el, '.detail button.delete') as HTMLButtonElement;
    remove.focus();
    remove.click();
    await settle(el);
    expect(pointsOf(el)).toHaveLength(3);
    expect(query(el, '.detail')).toBeNull();
    expect(activeOf(el)).toBe(svgOf(el));
  });

  it('C6: point groups are toggle buttons with a French role description', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    for (const group of queryAll(el, 'g.point')) {
      expect(group.getAttribute('role')).toBe('button');
      expect(group.getAttribute('aria-roledescription')).toBe('point de la courbe');
      expect(group.getAttribute('aria-pressed')).toBe('false');
    }
    await tapPoint(el, 1);
    expect(queryAll(el, 'g.point').map((g) => g.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(groupOf(el, 1).getAttribute('aria-label')).toBe(`Point 21:00, 70${NNBSP}%`);
    (query(el, '.detail button.close') as HTMLButtonElement).click();
    await el.updateComplete;
    expect(groupOf(el, 1).getAttribute('aria-pressed')).toBe('false');
  });

  it('C7: a disabled "Supprimer" is described by a visible hint', async () => {
    const { el } = await mount(config(), { [CURVE]: '19:00@100;23:00@10' });
    await tapPoint(el, 0);
    const button = query(el, '.detail button.delete');
    const hint = query(el, '.detail .hint');
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(button?.getAttribute('title')).toBe(DELETE_HINT);
    expect(hint?.textContent?.trim()).toBe(DELETE_HINT);
    expect(hint?.id).toMatch(/\S/);
    expect(button?.getAttribute('aria-describedby')).toBe(hint?.id);
    expect(stylesText()).toMatch(
      /\.detail \.hint\s*\{[^}]*font-size:\s*12px[^}]*color:\s*var\(--secondary-text-color\)/,
    );
    // With a point to spare: no hint, nothing described.
    const other = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(other.el, 1);
    expect(query(other.el, '.detail .hint')).toBeNull();
    expect(query(other.el, '.detail button.delete')?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('C8: the save chip is one persistent polite live region whose text changes', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 100 });
    const chip = query(el, '.save');
    expect(chip?.getAttribute('role')).toBe('status');
    expect(chip?.getAttribute('aria-live')).toBe('polite');
    expect(chip?.textContent?.trim()).toBe('');
    expect(chip?.classList.contains('idle')).toBe(true);
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    await vi.advanceTimersByTimeAsync(400);
    await el.updateComplete;
    expect(query(el, '.save')).toBe(chip);
    expect(saveChipOf(el)).toBe(SAVING);
    expect(chip?.classList.contains('idle')).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await el.updateComplete;
    expect(query(el, '.save')).toBe(chip);
    expect(saveChipOf(el)).toBe(SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    await el.updateComplete;
    expect(query(el, '.save')).toBe(chip);
    expect(saveChipOf(el)).toBeNull();
    expect(chip?.classList.contains('idle')).toBe(true);
    // M3 repair: idle and empty, it keeps its slot in the flex flow (the layout never depends on
    // the save state; see the "save chip slot" repair test).
    expect(stylesText()).not.toMatch(/\.save\.idle\s*\{/);
  });

  it('C8: an error is also an alert, inside the same status region', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { fail: true });
    const chip = query(el, '.save');
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    await el.updateComplete;
    expect(query(el, '.save')).toBe(chip);
    expect(chip?.getAttribute('role')).toBe('status');
    expect(chip?.classList.contains('error')).toBe(true);
    expect(query(el, '.save [role="alert"]')?.textContent).toContain('mock: service call failed');
  });

  it('C8: the message line is a persistent live region, emptied instead of removed', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config({ max_points: 4 }), { [CURVE]: REFERENCE_CURVE });
    const line = query(el, '.message');
    expect(line?.getAttribute('role')).toBe('status');
    expect(line?.getAttribute('aria-live')).toBe('polite');
    expect(messageOf(el)).toBeNull();
    expect(line?.classList.contains('empty')).toBe(true);
    const g = geometry(el);
    await tapBackground(el, xAt(g, '20:00'), yAt(g, 80));
    expect(query(el, '.message')).toBe(line);
    expect(messageOf(el)).toBe('Nombre maximal de points atteint (4)');
    expect(line?.classList.contains('empty')).toBe(false);
    vi.advanceTimersByTime(4000);
    await el.updateComplete;
    expect(query(el, '.message')).toBe(line);
    expect(messageOf(el)).toBeNull();
    expect(line?.classList.contains('empty')).toBe(true);
    // Empty, it takes no room.
    expect(stylesText()).toMatch(/\.message\.empty\s*\{[^}]*margin-top:\s*0/);
  });

  it('C9: a no-break space precedes the colon of the French messages', async () => {
    vi.useFakeTimers();
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { fail: true });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    await el.updateComplete;
    expect(saveChipOf(el)).toBe(`Erreur d'enregistrement${NBSP}: mock: service call failed`);
    const card = document.createElement('time-curve-card');
    const invalid: Partial<CardConfig>[] = [
      { window_start: '25:00' },
      { window_end: '8h' },
      { window_start: 12 as unknown as string },
      { window_end: 8 as unknown as string },
    ];
    for (const extra of invalid) {
      expect(() => {
        card.setConfig(config(extra));
      }).toThrow(`invalide${NBSP}: attendu HH:MM`);
      expect(() => {
        card.setConfig(config(extra));
      }).not.toThrow(/ :/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// M3 repair: one regression test (or more) per finding of the independent verifiers.
// ---------------------------------------------------------------------------------------------

describe('M3 repair: verifier findings', () => {
  /** Three successive edits of point 1 (X is the MOVED_CURVE most tests save). */
  const X = MOVED_CURVE;
  const Y = '19:00@100;21:45@50;22:30@30;23:30@12';
  const Z = '19:00@100;22:00@40;22:30@30;23:30@12';
  const FAILED = 'mock: service call failed';
  const WINDOW_LIMIT_TEXT = 'Heure limit\u00e9e \u00e0 la fen\u00eatre affich\u00e9e';

  function boxOf(element: Element | null): Box {
    return {
      x: Number(element?.getAttribute('x')),
      y: Number(element?.getAttribute('y')),
      width: Number(element?.getAttribute('width')),
      height: Number(element?.getAttribute('height')),
    };
  }

  function intersects(a: Box, b: Box): boolean {
    return (
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    );
  }

  function dotOf(el: Card, index: number): { x: number; y: number } {
    const dot = groupOf(el, index).querySelector('circle.dot');
    if (dot === null) throw new Error(`no marker for point ${index}`);
    return centerOf(dot);
  }

  function hidePage(): void {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  }

  it('keeps the grab offset: a point pressed off-centre moves with the pointer, never under it', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { now: '18:00' });
    const g = geometry(el);
    const hit = hitOf(el, 1);
    const c = centerOf(hit);
    // Pressed 15 px right of and 10 px above the marker centre, inside its 44 px target...
    hit.dispatchEvent(pointerEvent('pointerdown', c.x + 15, c.y - 10, { pointerType: 'touch' }));
    await el.updateComplete;
    // ...then moved straight down by 20 px: the time stays, the value follows the 20 px (the
    // pointer position itself would have given 21:45 @ 63).
    await moveTo(el, c.x + 15, c.y + 10);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 56 });
    expect(dotOf(el, 1).x).toBeCloseTo(c.x, 1);
    expect(dotOf(el, 1).y).toBeCloseTo(c.y + 20, 0);
    // A horizontal move changes the time by the pointer's travel only (21:00 -> 21:30).
    const dx = xAt(g, '21:30') - xAt(g, '21:00');
    await moveTo(el, c.x + 15 + dx, c.y + 10);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 56 });
    await release(el, c.x + 15 + dx, c.y + 10);
    vi.advanceTimersByTime(400);
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:30@56;22:30@30;23:30@12',
    ]);
  });

  it('takes the grab offset after a typed value of the pressed point commits', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { now: '18:00' });
    await tapPoint(el, 1);
    const number = detailInput(el, 'number');
    number.focus();
    number.value = '55'; // typed; the press below blurs it, which commits it (like a browser)
    const blur = number.blur.bind(number);
    number.blur = () => {
      number.dispatchEvent(new Event('change', { bubbles: true }));
      blur();
    };
    const hit = hitOf(el, 1);
    const c = centerOf(hit); // the marker is still drawn at 70 %
    hit.dispatchEvent(pointerEvent('pointerdown', c.x, c.y));
    await el.updateComplete;
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 55 });
    // 10 px down moves it from 55 %, where it is now (70 % would give 63).
    await moveTo(el, c.x, c.y + 10);
    expect(pointsOf(el)[1]).toEqual({ time: '21:00', value: 48 });
    await release(el, c.x, c.y + 10);
  });

  it('moves the drag tooltip off the "now" label: above it, else beside it', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE }); // now = 21:30
    const g = geometry(el);
    await press(el, 1);
    // Point 1 on the now line: the now dot and its label sit right on the dragged marker.
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    expect(query(el, '.now-label')?.textContent).toBe(`60${NNBSP}%`);
    let tip = boxOf(query(el, 'g.tooltip rect'));
    let halo = boxOf(query(el, 'rect.now-halo'));
    expect(intersects(tip, halo)).toBe(false);
    // Raised just above the label, still centred on the marker (clear of a finger below it).
    const marker = dotOf(el, 1);
    expect(tip.x + tip.width / 2).toBeCloseTo(marker.x, 1);
    expect(tip.y + tip.height).toBeCloseTo(halo.y - 2, 1);
    expect(tip.y + tip.height).toBeLessThan(marker.y - 14);
    // Near the top there is no room above the label: the tooltip goes beside it, on the left
    // (the label sits right of the now line), at its usual height, inside the SVG.
    await moveTo(el, xAt(g, '21:30'), yAt(g, 84));
    tip = boxOf(query(el, 'g.tooltip rect'));
    halo = boxOf(query(el, 'rect.now-halo'));
    expect(intersects(tip, halo)).toBe(false);
    expect(tip.x + tip.width).toBeCloseTo(halo.x - 2, 1);
    expect(tip.y).toBeCloseTo(dotOf(el, 1).y - 14 - 18, 1);
    expect(tip.x).toBeGreaterThanOrEqual(2);
    await release(el, xAt(g, '21:30'), yAt(g, 84));
  });

  it('placeTooltip: below the marker it drops under the label; beside it on the side that fits', () => {
    const tooltip = (x: number, y: number): Box => ({ x, y, width: 90, height: 18 });
    const halo = (x: number, y: number): Box => ({ x, y, width: 30, height: 13 });
    // Below the marker, touching the label: moved under the label.
    expect(placeTooltip(tooltip(80, 45), true, halo(100, 40), 400, 180)).toEqual(tooltip(80, 55));
    // Above, no room over the label (y 15 - 2 - 18 < 2): beside it, away from it first...
    expect(placeTooltip(tooltip(60, 20), false, halo(100, 15), 400, 180)).toEqual(tooltip(8, 20));
    // ...else on its other side...
    expect(placeTooltip(tooltip(10, 20), false, halo(60, 15), 400, 180)).toEqual(tooltip(92, 20));
    // ...else where it was (nothing fits in a tiny SVG).
    expect(placeTooltip(tooltip(2, 20), false, halo(30, 15), 100, 60)).toEqual(tooltip(2, 20));
    // No label, or no contact: unchanged.
    const alone = tooltip(200, 20);
    expect(placeTooltip(alone, false, null, 400, 180)).toBe(alone);
    expect(placeTooltip(alone, false, halo(100, 15), 400, 180)).toBe(alone);
  });

  it('keeps the save chip in a slot of fixed size; the full error also shows in the message line', async () => {
    const styles = TimeCurveCard.styles.cssText;
    const rule = /\n\s*\.save\s*\{([^}]*)\}/.exec(styles)?.[1] ?? '';
    expect(rule).toMatch(/flex:\s*1 1 8em/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/height:\s*20px/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(styles).toMatch(/\.chip\s*\{[^}]*white-space:\s*nowrap/);
    expect(styles).toMatch(/\.status\s*\{[^}]*line-height:\s*20px/);
    // No save state changes the chip's box (only its colour): the chart never moves.
    for (const match of styles.matchAll(/\.save\.[\w-]+\s*\{([^}]*)\}/g)) {
      expect(match[1]).not.toMatch(/position|display|white-space|flex|width|height|margin|padding/);
    }

    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { fail: true });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    await el.updateComplete;
    const error = `Erreur d'enregistrement${NBSP}: ${FAILED}`;
    expect(saveChipOf(el)).toBe(error);
    expect(query(el, '.save')?.getAttribute('title')).toBe(error);
    // In full below the chart, hidden from assistive technologies (the chip's alert says it).
    const copy = query(el, '.message .error');
    expect(copy?.textContent).toBe(error);
    expect(copy?.getAttribute('aria-hidden')).toBe('true');
    expect(query(el, '.message')?.classList.contains('empty')).toBe(false);
    // A transient message takes the line for 4 s, then the error shows again.
    await tapBackground(el, xAt(g, '21:02'), yAt(g, 50));
    expect(messageOf(el)).toBe("Trop proche d'un point existant");
    vi.advanceTimersByTime(4000);
    await el.updateComplete;
    expect(messageOf(el)).toBe(error);
    // The next save that goes out clears both.
    mock.failServices = false;
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60));
    vi.advanceTimersByTime(400);
    await flushMicrotasks();
    await el.updateComplete;
    expect(saveChipOf(el)).toBe(SAVED);
    expect(query(el, '.save')?.hasAttribute('title')).toBe(false);
    expect(messageOf(el)).toBeNull();
  });

  it('keeps one set_value in flight: edits going X -> Y -> X end on X with one call', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 1000 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60)); // X
    await vi.advanceTimersByTimeAsync(400); // t = 400: call X sent, echoed at t = 1400
    await dragPoint(el, 1, xAt(g, '21:45'), yAt(g, 50)); // Y
    await vi.advanceTimersByTimeAsync(400); // t = 800: waits for the echo of X
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60)); // back to X
    await vi.advanceTimersByTimeAsync(400); // t = 1200: X is already in flight
    expect(mock.calls.map((call) => call.data.value)).toEqual([X]);
    expect(saveChipOf(el)).toBe(SAVING);
    await vi.advanceTimersByTimeAsync(200); // t = 1400: echo of X ends the session
    await el.updateComplete;
    expect(internals(el).localPoints).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    // Nothing else comes: no intermediate value adopted, no call left.
    await vi.advanceTimersByTimeAsync(6000);
    await el.updateComplete;
    expect(mock.calls).toHaveLength(1);
    expect(mock.hass.states[CURVE]?.state).toBe(X);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
  });

  it('sends the edits that waited for the call in flight after its echo; their rejection shows', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 1000 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60)); // X
    await vi.advanceTimersByTimeAsync(400); // t = 400: call X sent
    await dragPoint(el, 1, xAt(g, '21:45'), yAt(g, 50)); // Y
    await vi.advanceTimersByTimeAsync(400); // t = 800: waits
    await dragPoint(el, 1, xAt(g, '22:00'), yAt(g, 40)); // Z
    await vi.advanceTimersByTimeAsync(400); // t = 1200: waits
    expect(mock.calls.map((call) => call.data.value)).toEqual([X]);
    await vi.advanceTimersByTimeAsync(200); // t = 1400: echo of X, then the newest edits (Z)
    await el.updateComplete;
    expect(mock.calls.map((call) => call.data.value)).toEqual([X, Z]);
    expect(saveChipOf(el)).toBe(SAVING);
    expect(pointsOf(el)[1]).toEqual({ time: '22:00', value: 40 });
    // HA rejects Z: the error is shown and the card reverts to what HA holds (X).
    mock.failServices = true;
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    await el.updateComplete;
    expect(saveChipOf(el)).toContain(FAILED);
    expect(pointsOf(el)[1]).toEqual({ time: '21:30', value: 60 });
    expect(mock.hass.states[CURVE]?.state).toBe(X);
    expect(mock.calls).toHaveLength(2);
  });

  it('a hidden page sends a waiting save at once, without waiting for the call in flight', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { latency: 1000 });
    const g = geometry(el);
    await dragPoint(el, 1, xAt(g, '21:30'), yAt(g, 60)); // X
    await vi.advanceTimersByTimeAsync(400); // t = 400: call X sent, echoed at t = 1400
    await dragPoint(el, 1, xAt(g, '21:45'), yAt(g, 50)); // Y
    await vi.advanceTimersByTimeAsync(400); // t = 800: Y waits for the echo of X
    expect(mock.calls).toHaveLength(1);
    hidePage(); // the WebView may be killed: Y goes out now
    expect(mock.calls.map((call) => call.data.value)).toEqual([X, Y]);
    // The echo of X (t = 1400) is not the latest call's: the local curve stays; Y's ends it.
    await vi.advanceTimersByTimeAsync(600);
    await el.updateComplete;
    expect(pointsOf(el)[1]).toEqual({ time: '21:45', value: 50 });
    expect(saveChipOf(el)).toBe(SAVING);
    await vi.advanceTimersByTimeAsync(400); // t = 1800
    await el.updateComplete;
    expect(mock.hass.states[CURVE]?.state).toBe(Y);
    expect(internals(el).localPoints).toBeNull();
    expect(saveChipOf(el)).toBe(SAVED);
    expect(mock.calls).toHaveLength(2);
  });

  it('a debounce that comes due ends a drag whose pointer is gone, then saves', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { now: '18:00' });
    const g = geometry(el);
    await press(el, 1);
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    // The pointer is lost without any end event reaching the card (a stale drag)...
    dropCapture(el, 1, 1);
    // ...and a keyboard edit of another point schedules a save.
    await focusPoint(el, 2);
    await pressKey(el, groupOf(el, 2), 'ArrowUp');
    vi.advanceTimersByTime(400);
    await el.updateComplete;
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;21:30@60;22:30@31;23:30@12',
    ]);
    expect(internals(el).drag).toBeNull();
    expect(query(el, 'g.tooltip')).toBeNull();
    expect(queryAll(el, 'g.point.dragging')).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(mock.calls).toHaveLength(1);
  });

  it('an external update moves the selection with its point; what is typed stays with it', async () => {
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    const number = detailInput(el, 'number');
    number.focus();
    number.value = '4'; // typed, not committed
    // Another device inserts a point with the same value before the selected one.
    mock.setState(CURVE, '19:00@100;20:00@70;21:00@70;22:30@30;23:30@12');
    await el.updateComplete;
    expect(queryAll(el, 'g.point').map((group) => group.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(detailInput(el, 'number')).toBe(number);
    expect(number.value).toBe('4');
    expect(detailInput(el, 'time').value).toBe('21:00');
    await changeInput(el, number, '4');
    expect(pointsOf(el)[1]).toEqual({ time: '20:00', value: 70 });
    expect(pointsOf(el)[2]).toEqual({ time: '21:00', value: 4 });
  });

  it('an external update during a press keeps the coming drag on the pressed point', async () => {
    vi.useFakeTimers();
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE }, { now: '18:00' });
    const g = geometry(el);
    await press(el, 1); // 21:00 @ 70, not moved yet: the card is still clean
    mock.setState(CURVE, '19:00@100;20:00@80;21:00@70;22:30@30;23:30@12');
    await el.updateComplete;
    await moveTo(el, xAt(g, '21:30'), yAt(g, 60));
    await release(el, xAt(g, '21:30'), yAt(g, 60));
    expect(pointsOf(el)).toEqual([
      { time: '19:00', value: 100 },
      { time: '20:00', value: 80 },
      { time: '21:30', value: 60 },
      { time: '22:30', value: 30 },
      { time: '23:30', value: 12 },
    ]);
    vi.advanceTimersByTime(400);
    await el.updateComplete;
    expect(mock.calls.map((call) => call.data.value)).toEqual([
      '19:00@100;20:00@80;21:30@60;22:30@30;23:30@12',
    ]);
    // A press whose point disappears ends there: the rest of the gesture changes nothing.
    await press(el, 3); // 22:30 @ 30
    mock.setState(CURVE, '19:00@100;20:00@80;21:30@60;23:30@12');
    await el.updateComplete;
    expect(internals(el).drag).toBeNull();
    await moveTo(el, xAt(g, '23:00'), yAt(g, 50));
    await release(el, xAt(g, '23:00'), yAt(g, 50));
    expect(pointsOf(el).map((p) => `${p.time}@${p.value}`)).toEqual([
      '19:00@100',
      '20:00@80',
      '21:30@60',
      '23:30@12',
    ]);
    vi.advanceTimersByTime(1000);
    expect(mock.calls).toHaveLength(1);
  });

  it('when the selected point is gone after an external update, its row starts afresh', async () => {
    const { el, mock } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    await tapPoint(el, 1);
    const number = detailInput(el, 'number');
    number.value = '4'; // typed, not committed
    // Point 1 moved to 21:15 elsewhere: the selection stays at index 1, on that point now.
    mock.setState(CURVE, '19:00@100;21:15@70;22:30@30;23:30@12');
    await el.updateComplete;
    expect(groupOf(el, 1).getAttribute('aria-pressed')).toBe('true');
    expect(detailInput(el, 'number')).not.toBe(number);
    expect(detailInput(el, 'number').value).toBe('70');
    expect(detailInput(el, 'time').value).toBe('21:15');
  });

  it('ends the pointer modality on a key pressed outside the card, and when it is removed', async () => {
    const { el } = await mount(config(), { [CURVE]: REFERENCE_CURVE });
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      await tapPoint(el, 1);
      expect(el.hasAttribute('pointer-focus')).toBe(true);
      // A click elsewhere, then Tab from there back into the card: the ring must show again.
      outside.focus();
      await pressKey(el, outside, 'Tab');
      expect(el.hasAttribute('pointer-focus')).toBe(false);
      // A shortcut is not keyboard navigation, wherever it is pressed.
      await tapPoint(el, 1);
      await pressKey(el, outside, 'c', { ctrlKey: true });
      expect(el.hasAttribute('pointer-focus')).toBe(true);
      // A removed card leaves the pointer modality and drops its document listener.
      const removeListener = vi.spyOn(document, 'removeEventListener');
      el.remove();
      expect(el.hasAttribute('pointer-focus')).toBe(false);
      expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    } finally {
      outside.remove();
      vi.restoreAllMocks();
    }
  });

  it('reads a typed 12:00 as the end of a window ending at 12:00', async () => {
    const { el } = await mount(config({ window_end: '12:00' }), {
      [CURVE]: '19:00@100;23:00@10;11:00@5',
    });
    await tapPoint(el, 2);
    await changeInput(el, detailInput(el, 'time'), '12:00');
    expect(pointsOf(el)[2]).toEqual({ time: '11:55', value: 5 });
    expect(messageOf(el)).toBe(WINDOW_LIMIT_TEXT);
    expect(detailInput(el, 'time').value).toBe('11:55');
    // A window showing the whole curve day (12:00 -> 12:00): 12:00 is the nearer end.
    const full = await mount(config({ window_start: '12:00', window_end: '12:00' }), {
      [CURVE]: '13:00@100;23:00@10;11:00@5',
    });
    await tapPoint(full.el, 0);
    await changeInput(full.el, detailInput(full.el, 'time'), '12:00');
    expect(pointsOf(full.el)[0]).toEqual({ time: '12:00', value: 100 });
    expect(messageOf(full.el)).toBeNull();
    await tapPoint(full.el, 2);
    await changeInput(full.el, detailInput(full.el, 'time'), '12:00');
    expect(pointsOf(full.el)[2]).toEqual({ time: '11:55', value: 5 });
    expect(messageOf(full.el)).toBe(WINDOW_LIMIT_TEXT);
  });

  it('keeps the M3 TS sources ASCII-only (non-ASCII as unicode escapes)', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const isAscii = (line: string): boolean => {
      for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) > 0x7f) return false;
      return true;
    };
    // The card, the dev harness and mock written or extended in M3, and both interaction suites.
    const files = [
      'src/card.ts',
      'dev/main.ts',
      'dev/mock-hass.ts',
      'test/card.interactions.test.ts',
      'test/card.interactions.independent.test.ts',
    ];
    for (const file of files) {
      const offending = readFileSync(resolve(root, file), 'utf8')
        .split('\n')
        .flatMap((line, i) => (isAscii(line) ? [] : [`${file}:${i + 1}`]));
      expect(offending).toEqual([]);
    }
  });
});
