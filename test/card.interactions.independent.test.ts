/**
 * Independent tests for the M3 interactions of <time-curve-card>, written from the M3 spec
 * (sections 1-5 and 8: state model, pointer drags, tap-to-add, keyboard, tooltip, persistence,
 * detail row, selection rendering) WITHOUT reading the implementation first, so they only encode
 * what the spec promises.
 *
 * Coordinates: the M2 plot margins (left 40, right 14, top 14, bottom 24) and the SVG viewBox give
 * the plot area; the SVG's `getBoundingClientRect` is stubbed to the viewBox size so that client
 * px = SVG user units. Points are observed through their `aria-label` ("Point HH:MM, NN %") and
 * the `input_text.set_value` payloads recorded by the mock hass. Fake timers drive the 400 ms
 * debounce, the 2 s "Enregistr\u00e9" chip, the 4 s message and the 5 s echo timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index.js';
import {
  DEFAULT_CURVE,
  MAX_CURVE_LENGTH,
  formatTime,
  parseTime,
  sortKey,
} from '../src/core/curve.js';
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
const REFERENCE_CURVE = '19:00@100;21:00@70;22:30@30;23:30@12';
const REFERENCE_LABELS = ['19:00, 100 %', '21:00, 70 %', '22:30, 30 %', '23:30, 12 %'];

const DEBOUNCE_MS = 400;
const SAVED_CHIP_MS = 2000;
const MESSAGE_MS = 4000;
const ECHO_TIMEOUT_MS = 5000;

/** Plot margins of the M2 rendering spec, in SVG px. */
const PLOT_LEFT = 40;
const PLOT_RIGHT = 14;
const PLOT_TOP = 14;
const PLOT_BOTTOM = 24;

/** Narrow no-break space (U+202F), required before "%" in the tooltip. */
const NNBSP = '\u202f';

type Card = HTMLElementTagNameMap['time-curve-card'];

interface Mounted {
  el: Card;
  mock: MockHass;
  window: TimeWindow;
}

interface Chart {
  svg: SVGSVGElement;
  plot: PlotArea;
}

const mounted: Card[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 15, 21, 30, 0, 0));
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Mounting and DOM helpers
// ---------------------------------------------------------------------------------------------

/**
 * Mounts a card with a mock hass whose state changes (echoes included) are pushed to the card,
 * like the dev harness does. The clock is frozen at 21:30.
 */
async function mount(
  extra: Partial<CardConfig> = {},
  entities: Record<string, MockEntityInit> = { [CURVE]: REFERENCE_CURVE },
  options: Omit<MockHassOptions, 'onChange'> = {},
): Promise<Mounted> {
  const el = document.createElement('time-curve-card');
  const mock = new MockHass(entities, {
    ...options,
    onChange: (hass) => {
      el.hass = hass;
    },
  });
  el.setConfig({ type: 'custom:time-curve-card', entity: CURVE, ...extra });
  el.nowProvider = () => new Date(2026, 0, 15, 21, 30, 0, 0);
  el.hass = mock.hass;
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  const window = makeWindow(extra.window_start ?? '17:00', extra.window_end ?? '08:00');
  return { el, mock, window };
}

/** Advances the fake clock (firing timers, flushing promises) and waits for Lit. */
async function tick(el: Card, ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await el.updateComplete;
}

function query(el: Card, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null;
}

function queryAll(el: Card, selector: string): Element[] {
  return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? []);
}

function element(el: Card, selector: string): Element {
  const found = query(el, selector);
  if (found === null) throw new Error(`missing ${selector} in the card`);
  return found;
}

function inputOf(el: Card, selector: string): HTMLInputElement {
  const found = element(el, selector);
  if (!(found instanceof HTMLInputElement)) throw new Error(`${selector} is not an <input>`);
  return found;
}

function buttonOf(el: Card, selector: string): HTMLButtonElement {
  const found = element(el, selector);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${selector} is not a <button>`);
  return found;
}

/** Shadow text with every whitespace run (including no-break spaces) as one space. */
function textOf(el: Card): string {
  return (el.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function normalized(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The `.save` chip text, or null when the status is idle. M3 fix plan C8 overrides "no chip when
 * idle": the chip is a persistent live region, EMPTY when idle.
 */
function saveChip(el: Card): string | null {
  const text = normalized(query(el, '.save')?.textContent);
  return text === '' ? null : text;
}

/**
 * The rendered `<svg>` and its plot area, with `getBoundingClientRect` stubbed to the viewBox
 * size (scale 1). Re-evaluated on every call: the SVG is re-created when the curve goes from
 * invalid to valid.
 */
function chartOf(el: Card): Chart {
  const svg = el.shadowRoot?.querySelector('svg') ?? null;
  if (svg === null) throw new Error('the chart <svg> is not rendered');
  const [, , width = 0, height = 0] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  const rect: DOMRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  };
  svg.getBoundingClientRect = () => rect;
  return {
    svg,
    plot: {
      x: PLOT_LEFT,
      y: PLOT_TOP,
      width: width - PLOT_LEFT - PLOT_RIGHT,
      height: height - PLOT_TOP - PLOT_BOTTOM,
    },
  };
}

function minutesOf(time: string): number {
  const parsed = parseTime(time);
  if (parsed === null) throw new Error(`invalid test time ${time}`);
  return parsed;
}

/** SVG x of a time of day in the mounted card's window. */
function xAt(m: Mounted, time: string): number {
  return keyToX(sortKey(minutesOf(time)), m.window, chartOf(m.el).plot);
}

/** SVG y of a brightness value. */
function yAt(m: Mounted, value: number): number {
  return valueToY(value, chartOf(m.el).plot);
}

function groupOf(el: Card, index: number): Element {
  return element(el, `g.point[data-index="${index}"]`);
}

function hitOf(el: Card, index: number): Element {
  return element(el, `g.point[data-index="${index}"] circle.hit`);
}

function dotOf(el: Card, index: number): Element {
  return element(el, `g.point[data-index="${index}"] circle.dot`);
}

/**
 * true when the point group or its marker carries `cls`. Spec 5 puts `selected` / `dragging` on
 * the marker; a class on the `g.point` group styling the marker is accepted as equivalent.
 */
function hasPointClass(group: Element, cls: string): boolean {
  if (group.classList.contains(cls)) return true;
  return group.querySelector('circle.dot')?.classList.contains(cls) ?? false;
}

function isSelected(el: Card, index: number): boolean {
  return hasPointClass(groupOf(el, index), 'selected');
}

function isDragged(el: Card, index: number): boolean {
  return hasPointClass(groupOf(el, index), 'dragging');
}

/** Indices of the points flagged `selected`. */
function selectedIndices(el: Card): number[] {
  const indices: number[] = [];
  queryAll(el, 'g.point').forEach((group, index) => {
    if (hasPointClass(group, 'selected')) indices.push(index);
  });
  return indices;
}

/** "HH:MM, NN %" of every rendered point, from the `aria-label`s, in rendered order. */
function labelsOf(el: Card): string[] {
  return queryAll(el, 'g.point').map((g) =>
    normalized(g.getAttribute('aria-label')).replace(/^Point /, ''),
  );
}

/** Centre of a point marker: its `cx`/`cy`, or the projection of its aria-label. */
function centerOf(m: Mounted, index: number): { x: number; y: number } {
  const dot = dotOf(m.el, index);
  if (dot.hasAttribute('cx') && dot.hasAttribute('cy')) {
    return { x: Number(dot.getAttribute('cx')), y: Number(dot.getAttribute('cy')) };
  }
  const match = /^(\d{2}:\d{2}), (\d+) %$/.exec(labelsOf(m.el)[index] ?? '');
  const time = match?.[1];
  const value = match?.[2];
  if (time === undefined || value === undefined) {
    throw new Error(`point ${index} has no usable position`);
  }
  return { x: xAt(m, time), y: yAt(m, Number(value)) };
}

function pointer(target: Element, type: string, x: number, y: number, pointerId = 1): PointerEvent {
  const event = new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/**
 * Presses on point `index`, moves to `to` in two steps and releases there. Every event is
 * dispatched on the hit circle, as pointer capture retargets them in a browser; they bubble to
 * the SVG for the delegated listeners.
 */
async function drag(
  m: Mounted,
  index: number,
  to: { x: number; y: number },
  end: 'pointerup' | 'pointercancel' | 'lostpointercapture' = 'pointerup',
  pointerId = 1,
): Promise<Element> {
  const from = centerOf(m, index);
  const hit = hitOf(m.el, index);
  pointer(hit, 'pointerdown', from.x, from.y, pointerId);
  await m.el.updateComplete;
  pointer(hit, 'pointermove', (from.x + to.x) / 2, (from.y + to.y) / 2, pointerId);
  pointer(hit, 'pointermove', to.x, to.y, pointerId);
  await m.el.updateComplete;
  pointer(hit, end, to.x, to.y, pointerId);
  await m.el.updateComplete;
  return hit;
}

async function tap(m: Mounted, target: Element, x: number, y: number): Promise<void> {
  pointer(target, 'pointerdown', x, y);
  await m.el.updateComplete;
  pointer(target, 'pointerup', x, y);
  await m.el.updateComplete;
}

async function tapPoint(m: Mounted, index: number): Promise<void> {
  const centre = centerOf(m, index);
  await tap(m, hitOf(m.el, index), centre.x, centre.y);
}

async function tapBackground(m: Mounted, x: number, y: number): Promise<void> {
  await tap(m, chartOf(m.el).svg, x, y);
}

/** Dispatches a keydown on the point group `index` (bubbles to the SVG). */
async function press(
  m: Mounted,
  index: number,
  key: string,
  shiftKey = false,
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  groupOf(m.el, index).dispatchEvent(event);
  await m.el.updateComplete;
  return event;
}

/** Sets an input's value and fires `change`, like a user committing the field. */
async function commit(el: Card, input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  await el.updateComplete;
}

function setValueCall(value: string): {
  domain: string;
  service: string;
  data: Record<string, unknown>;
} {
  return { domain: 'input_text', service: 'set_value', data: { entity_id: CURVE, value } };
}

// ---------------------------------------------------------------------------------------------
// Accessibility structure (spec 2.3)
// ---------------------------------------------------------------------------------------------

describe('structure', () => {
  it('makes the SVG and every point group focusable buttons with a French label', async () => {
    const { el } = await mount();
    expect(chartOf(el).svg.getAttribute('tabindex')).toBe('0');
    const groups = queryAll(el, 'g.point');
    expect(groups).toHaveLength(4);
    for (const group of groups) {
      expect(group.getAttribute('tabindex')).toBe('0');
      expect(group.getAttribute('role')).toBe('button');
    }
    expect(labelsOf(el)).toEqual(REFERENCE_LABELS);
    expect(groups[1]?.getAttribute('aria-label')).toMatch(/^Point 21:00, 70\s%$/);
  });
});

// ---------------------------------------------------------------------------------------------
// Drag (spec 2.1, 2.4, 5)
// ---------------------------------------------------------------------------------------------

describe('drag a point', () => {
  it('moves the point with the time snapped to 5 min and the value rounded, saved after 400 ms', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:32'), y: yAt(m, 60.3) });
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '21:30, 60 %', '22:30, 30 %', '23:30, 12 %']);
    expect(m.mock.calls).toHaveLength(0);
    await tick(m.el, DEBOUNCE_MS - 1);
    expect(m.mock.calls).toHaveLength(0);
    await tick(m.el, 1);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@60;22:30@30;23:30@12')]);
  });

  it('snaps to the configured snap_minutes (round half up)', async () => {
    const m = await mount({ snap_minutes: 15 });
    await drag(m, 1, { x: xAt(m, '21:38'), y: yAt(m, 70) });
    expect(labelsOf(m.el)[1]).toBe('21:45, 70 %');
    // M3 fix plan B3: a touch press must travel 8 px to become a drag (21:45 -> 21:36 is only
    // ~3 px), so the round-down case goes further: 21:06 is 0.4 step past 21:00.
    await drag(m, 1, { x: xAt(m, '21:06'), y: yAt(m, 70) });
    expect(labelsOf(m.el)[1]).toBe('21:00, 70 %');
  });

  it('clamps the value to 1..100 when dragged above or below the plot', async () => {
    const m = await mount();
    const { plot } = chartOf(m.el);
    await drag(m, 1, { x: xAt(m, '21:00'), y: plot.y - 25 });
    expect(labelsOf(m.el)[1]).toBe('21:00, 100 %');
    await drag(m, 1, { x: xAt(m, '21:00'), y: plot.y + plot.height + 25 });
    expect(labelsOf(m.el)[1]).toBe('21:00, 1 %');
  });

  it('cannot cross a neighbour and stays one snap step away from it', async () => {
    const m = await mount();
    // Past the next point (22:30) -> one step before it.
    await drag(m, 1, { x: xAt(m, '23:00'), y: yAt(m, 70) });
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '22:25, 70 %', '22:30, 30 %', '23:30, 12 %']);
    // Before the previous point (19:00) -> one step after it.
    await drag(m, 1, { x: xAt(m, '18:00'), y: yAt(m, 70) });
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '19:05, 70 %', '22:30, 30 %', '23:30, 12 %']);
  });

  it('clamps the first and last points to the visible window', async () => {
    const m = await mount();
    const { plot } = chartOf(m.el);
    await drag(m, 0, { x: plot.x - 30, y: yAt(m, 100) });
    expect(labelsOf(m.el)[0]).toBe('17:00, 100 %');
    await drag(m, 3, { x: plot.x + plot.width + 30, y: yAt(m, 12) });
    expect(labelsOf(m.el)[3]).toBe('08:00, 12 %');
    expect(labelsOf(m.el)).toHaveLength(4);
  });

  it('never puts a point on the noon pivot when the window ends at 12:00', async () => {
    const m = await mount({ window_start: '12:00', window_end: '12:00' });
    const { plot } = chartOf(m.el);
    await drag(m, 3, { x: plot.x + plot.width + 30, y: yAt(m, 12) });
    expect(labelsOf(m.el)[3]).toBe('11:55, 12 %');
  });

  it('refuses a move when the neighbours leave no visible room', async () => {
    // 07:57 is within one step of the 08:00 window end: the clamp of the last point would land on
    // 08:02, outside the window, so the move is refused and the point stays put.
    const m = await mount({}, { [CURVE]: '19:00@100;07:57@50;08:00@20' });
    await drag(m, 2, { x: xAt(m, '07:00'), y: yAt(m, 20) });
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '07:57, 50 %', '08:00, 20 %']);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('treats a press that moved less than 3 px as a tap: selected, not moved, not saved', async () => {
    const m = await mount();
    const from = centerOf(m, 1);
    const hit = hitOf(m.el, 1);
    pointer(hit, 'pointerdown', from.x, from.y);
    pointer(hit, 'pointermove', from.x + 2, from.y - 2);
    await m.el.updateComplete;
    expect(query(m.el, 'g.tooltip')).toBeNull();
    pointer(hit, 'pointerup', from.x + 2, from.y - 2);
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(isSelected(m.el, 1)).toBe(true);
    expect(query(m.el, '.detail')).not.toBeNull();
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('prevents the default of pointerdown and captures the pointer for the drag', async () => {
    const m = await mount();
    const from = centerOf(m, 1);
    const hit = hitOf(m.el, 1);
    // Spec 2.1 captures on "the target element": the hit circle, its point group or the SVG that
    // delegates the listeners all retarget the pointer into the card, so any of them may hold it.
    const holders = [hit, groupOf(m.el, 1), chartOf(m.el).svg];
    const down = pointer(hit, 'pointerdown', from.x, from.y, 7);
    expect(down.defaultPrevented).toBe(true);
    expect(holders.some((holder) => holder.hasPointerCapture(7))).toBe(true);
    pointer(hit, 'pointermove', from.x + 20, from.y + 20, 7);
    pointer(hit, 'pointerup', from.x + 20, from.y + 20, 7);
    await m.el.updateComplete;
    expect(holders.some((holder) => holder.hasPointerCapture(7))).toBe(false);
  });

  it('ignores pointer events of another pointerId during a drag', async () => {
    const m = await mount();
    const from = centerOf(m, 1);
    const hit = hitOf(m.el, 1);
    pointer(hit, 'pointerdown', from.x, from.y, 1);
    pointer(hit, 'pointermove', xAt(m, '22:00'), yAt(m, 40), 2);
    await m.el.updateComplete;
    expect(labelsOf(m.el)[1]).toBe('21:00, 70 %');
    pointer(hit, 'pointerup', xAt(m, '22:00'), yAt(m, 40), 2);
    await m.el.updateComplete;
    // Still dragging with pointer 1.
    pointer(hit, 'pointermove', xAt(m, '21:30'), yAt(m, 60), 1);
    await m.el.updateComplete;
    expect(labelsOf(m.el)[1]).toBe('21:30, 60 %');
    expect(query(m.el, 'g.tooltip')).not.toBeNull();
    pointer(hit, 'pointerup', xAt(m, '21:30'), yAt(m, 60), 1);
    await m.el.updateComplete;
    expect(query(m.el, 'g.tooltip')).toBeNull();
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@60;22:30@30;23:30@12')]);
  });

  it('ends the drag and saves on pointercancel and on lostpointercapture', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) }, 'pointercancel');
    expect(query(m.el, 'g.tooltip')).toBeNull();
    expect(isDragged(m.el, 1)).toBe(false);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@60;22:30@30;23:30@12')]);

    await drag(m, 2, { x: xAt(m, '22:30'), y: yAt(m, 40) }, 'lostpointercapture');
    expect(query(m.el, 'g.tooltip')).toBeNull();
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(2);
    expect(m.mock.calls[1]?.data.value).toBe('19:00@100;21:30@60;22:30@40;23:30@12');
  });

  it('shows the tooltip "HH:MM \u00b7 NN %" above the dragged point and removes it on release', async () => {
    const m = await mount();
    const from = centerOf(m, 1);
    const hit = hitOf(m.el, 1);
    pointer(hit, 'pointerdown', from.x, from.y);
    await m.el.updateComplete;
    expect(query(m.el, 'g.tooltip')).toBeNull();

    pointer(hit, 'pointermove', xAt(m, '21:32'), yAt(m, 60.3));
    await m.el.updateComplete;
    const tooltip = element(m.el, 'g.tooltip');
    const text = tooltip.querySelector('text');
    expect(normalized(text?.textContent)).toBe('21:30 \u00b7 60 %');
    expect(text?.textContent).toContain(`${NNBSP}%`);
    const halo = tooltip.querySelector('rect');
    expect(halo?.getAttribute('rx')).toBe('4');
    // 60 % is far from the top of the plot: the tooltip sits above the marker.
    expect(Number(text?.getAttribute('y'))).toBeLessThan(yAt(m, 60));

    pointer(hit, 'pointerup', xAt(m, '21:32'), yAt(m, 60.3));
    await m.el.updateComplete;
    expect(query(m.el, 'g.tooltip')).toBeNull();
  });

  it('marks the dragged point (r=8), then the selected point (r=7), and updates its aria-label', async () => {
    const m = await mount();
    const from = centerOf(m, 1);
    const hit = hitOf(m.el, 1);
    pointer(hit, 'pointerdown', from.x, from.y);
    await m.el.updateComplete;
    expect(isSelected(m.el, 1)).toBe(true);
    expect(dotOf(m.el, 1).getAttribute('r')).toBe('7');

    pointer(hit, 'pointermove', xAt(m, '21:30'), yAt(m, 60));
    await m.el.updateComplete;
    expect(isDragged(m.el, 1)).toBe(true);
    expect(dotOf(m.el, 1).getAttribute('r')).toBe('8');
    expect(groupOf(m.el, 1).getAttribute('aria-label')).toMatch(/^Point 21:30, 60\s%$/);
    expect(dotOf(m.el, 0).getAttribute('r')).toBe('5');

    pointer(hit, 'pointerup', xAt(m, '21:30'), yAt(m, 60));
    await m.el.updateComplete;
    expect(isDragged(m.el, 1)).toBe(false);
    expect(isSelected(m.el, 1)).toBe(true);
    expect(dotOf(m.el, 1).getAttribute('r')).toBe('7');
  });
});

// ---------------------------------------------------------------------------------------------
// Selection by tap (spec 2.1, 4)
// ---------------------------------------------------------------------------------------------

describe('tap to select', () => {
  it('selects the tapped point, shows the detail row and keeps it selected on a second tap', async () => {
    const m = await mount();
    expect(query(m.el, '.detail')).toBeNull();
    await tapPoint(m, 2);
    expect(selectedIndices(m.el)).toEqual([2]);
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('22:30');
    expect(inputOf(m.el, '.detail input[type="number"]').value).toBe('30');

    await tapPoint(m, 2);
    expect(selectedIndices(m.el)).toEqual([2]);
    expect(query(m.el, '.detail')).not.toBeNull();

    await tapPoint(m, 0);
    expect(selectedIndices(m.el)).toEqual([0]);
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('19:00');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('selects a point group when it receives focus', async () => {
    const m = await mount();
    const group = groupOf(m.el, 3);
    group.dispatchEvent(new FocusEvent('focus'));
    group.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    await m.el.updateComplete;
    expect(selectedIndices(m.el)).toEqual([3]);
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('23:30');
  });
});

// ---------------------------------------------------------------------------------------------
// Add a point (spec 2.2)
// ---------------------------------------------------------------------------------------------

describe('add a point', () => {
  it('adds a snapped point on a background tap, selects it and saves', async () => {
    const m = await mount();
    await tapBackground(m, xAt(m, '20:03'), yAt(m, 51.2));
    expect(labelsOf(m.el)).toEqual([
      '19:00, 100 %',
      '20:05, 51 %',
      '21:00, 70 %',
      '22:30, 30 %',
      '23:30, 12 %',
    ]);
    expect(selectedIndices(m.el)).toEqual([1]);
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('20:05');
    expect(inputOf(m.el, '.detail input[type="number"]').value).toBe('51');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;20:05@51;21:00@70;22:30@30;23:30@12')]);
  });

  it('refuses when max_points is reached and clears the message after 4 s', async () => {
    const m = await mount({ max_points: 4 });
    await tapBackground(m, xAt(m, '20:00'), yAt(m, 50));
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(textOf(m.el)).toContain('Nombre maximal de points atteint (4)');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
    await tick(m.el, MESSAGE_MS - DEBOUNCE_MS - 1);
    expect(textOf(m.el)).toContain('Nombre maximal de points atteint (4)');
    await tick(m.el, 1);
    expect(textOf(m.el)).not.toContain('Nombre maximal');
  });

  it('refuses a point whose snapped time is within one step of an existing point', async () => {
    const m = await mount();
    // 21:02 snaps to 21:00, the time of point 1; tapped far below its 44 px hit target.
    await tapBackground(m, xAt(m, '21:02'), yAt(m, 15));
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(textOf(m.el)).toContain("Trop proche d'un point existant");
    await tapBackground(m, xAt(m, '20:58'), yAt(m, 15));
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('accepts a point exactly one step away from an existing one', async () => {
    const m = await mount();
    // 21:04 snaps to 21:05: |545 - 540| = 5 is not < 5.
    await tapBackground(m, xAt(m, '21:04'), yAt(m, 15));
    expect(labelsOf(m.el)).toEqual([
      '19:00, 100 %',
      '21:00, 70 %',
      '21:05, 15 %',
      '22:30, 30 %',
      '23:30, 12 %',
    ]);
  });

  it('ignores taps outside the plot area', async () => {
    const m = await mount();
    const { plot } = chartOf(m.el);
    await tapBackground(m, plot.x - 10, plot.y + plot.height / 2);
    await tapBackground(m, plot.x + plot.width / 2, plot.y + plot.height + 10);
    await tapBackground(m, plot.x + plot.width / 2, plot.y - 8);
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(query(m.el, '.detail')).toBeNull();
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('does not add a point after a swipe on the background', async () => {
    const m = await mount();
    const { svg } = chartOf(m.el);
    const x = xAt(m, '20:00');
    const y = yAt(m, 50);
    pointer(svg, 'pointerdown', x, y);
    pointer(svg, 'pointermove', x + 30, y + 10);
    pointer(svg, 'pointerup', x + 30, y + 10);
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Persistence (spec 3, 1.2)
// ---------------------------------------------------------------------------------------------

describe('persistence', () => {
  it('coalesces two drags within 400 ms into one call carrying the final curve', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 70) });
    await tick(m.el, 200);
    await drag(m, 2, { x: xAt(m, '22:00'), y: yAt(m, 40) });
    await tick(m.el, 300);
    expect(m.mock.calls).toHaveLength(0);
    await tick(m.el, 100);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@70;22:00@40;23:30@12')]);
  });

  it('shows "Enregistrement\u2026" while in flight, then "Enregistr\u00e9" for 2 s after the echo', async () => {
    const m = await mount({}, { [CURVE]: REFERENCE_CURVE }, { latency: 1000 });
    expect(saveChip(m.el)).toBeNull();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    await tick(m.el, DEBOUNCE_MS);
    expect(saveChip(m.el)).toBe('Enregistrement\u2026');
    await tick(m.el, 999);
    expect(saveChip(m.el)).toBe('Enregistrement\u2026');
    await tick(m.el, 1);
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    await tick(m.el, SAVED_CHIP_MS - 1);
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    await tick(m.el, 1);
    expect(saveChip(m.el)).toBeNull();
    expect(labelsOf(m.el)[1]).toBe('21:30, 60 %');
  });

  it('follows hass again once the echo arrived (local edits cleared)', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    await tick(m.el, DEBOUNCE_MS);
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    expect(m.mock.hass.states[CURVE]?.state).toBe('19:00@100;21:30@60;22:30@30;23:30@12');
    m.mock.setState(CURVE, '19:00@100;23:00@10');
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '23:00, 10 %']);
  });

  it('does not fire the echo timeout after a successful echo', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    await tick(m.el, DEBOUNCE_MS);
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    await tick(m.el, ECHO_TIMEOUT_MS + 100);
    expect(saveChip(m.el)).toBeNull();
    expect(labelsOf(m.el)[1]).toBe('21:30, 60 %');
    expect(m.mock.calls).toHaveLength(1);
  });

  it('writes nothing when the edited curve equals the stored one', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    await press(m, 1, 'ArrowRight');
    expect(labelsOf(m.el)[1]).toBe('21:05, 70 %');
    await press(m, 1, 'ArrowLeft');
    expect(labelsOf(m.el)[1]).toBe('21:00, 70 %');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
    expect(saveChip(m.el)).toBeNull();
    // Clean again: an external update is adopted.
    m.mock.setState(CURVE, '19:00@100;23:00@10');
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '23:00, 10 %']);
  });

  it('on rejection shows the error, reverts to the HA curve and deselects', async () => {
    const m = await mount({}, { [CURVE]: REFERENCE_CURVE }, { failServices: true });
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    expect(query(m.el, '.detail')).not.toBeNull();
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(1);
    expect(saveChip(m.el)).toMatch(/^Erreur d.enregistrement : mock: service call failed$/);
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(query(m.el, '.detail')).toBeNull();
    expect(selectedIndices(m.el)).toEqual([]);
    // The error stays until the next change.
    await tick(m.el, ECHO_TIMEOUT_MS);
    expect(saveChip(m.el)).toMatch(/Erreur/);

    m.mock.failServices = false;
    await drag(m, 2, { x: xAt(m, '22:00'), y: yAt(m, 30) });
    await tick(m.el, DEBOUNCE_MS);
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    expect(m.mock.calls[1]?.data.value).toBe('19:00@100;21:00@70;22:00@30;23:30@12');
  });

  it('treats a missing echo as a refusal after 5 s and reverts', async () => {
    const m = await mount({}, { [CURVE]: REFERENCE_CURVE }, { echo: false });
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(1);
    expect(saveChip(m.el)).toBe('Enregistrement\u2026');
    expect(labelsOf(m.el)[1]).toBe('21:30, 60 %');
    await tick(m.el, ECHO_TIMEOUT_MS - 1);
    expect(saveChip(m.el)).toBe('Enregistrement\u2026');
    await tick(m.el, 1);
    expect(saveChip(m.el)).toBe(
      "Valeur refus\u00e9e par Home Assistant (v\u00e9rifiez max: 255 sur l'input_text)",
    );
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(query(m.el, '.detail')).toBeNull();
    expect(m.mock.calls).toHaveLength(1);
  });

  it('sends the newest value when the curve changes while a save is in flight', async () => {
    const m = await mount({}, { [CURVE]: REFERENCE_CURVE }, { latency: 1000 });
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 70) });
    await tick(m.el, DEBOUNCE_MS); // t = 400: call 1 sent, echoes at t = 1400
    expect(m.mock.calls).toHaveLength(1);
    // Second change while call 1 is in flight.
    await drag(m, 2, { x: xAt(m, '22:00'), y: yAt(m, 40) });
    // Adjusted (M3 repair, one call in flight at a time, overriding "pendingValue is replaced"):
    // at t = 800 the debounce comes due but the save waits for the echo of call 1.
    await tick(m.el, DEBOUNCE_MS); // t = 800
    expect(m.mock.calls).toHaveLength(1);
    // Echo of call 1 (older value): the local edits win, and call 2 goes out (echoes at 2400).
    await tick(m.el, 600); // t = 1400
    expect(m.mock.calls).toHaveLength(2);
    expect(m.mock.calls[1]?.data.value).toBe('19:00@100;21:30@70;22:00@40;23:30@12');
    expect(m.mock.hass.states[CURVE]?.state).toBe('19:00@100;21:30@70;22:30@30;23:30@12');
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '21:30, 70 %', '22:00, 40 %', '23:30, 12 %']);
    expect(saveChip(m.el)).toBe('Enregistrement\u2026');
    // Echo of call 2: saved.
    await tick(m.el, 1000); // t = 2400
    expect(m.mock.hass.states[CURVE]?.state).toBe('19:00@100;21:30@70;22:00@40;23:30@12');
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '21:30, 70 %', '22:00, 40 %', '23:30, 12 %']);
    expect(m.mock.calls).toHaveLength(2);
    // The echo timeout of call 1 must not resurface as an error later.
    await tick(m.el, ECHO_TIMEOUT_MS);
    expect(saveChip(m.el)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// External updates (spec 1.2)
// ---------------------------------------------------------------------------------------------

describe('external updates', () => {
  it('adopts an external change when there are no local edits', async () => {
    const m = await mount();
    m.mock.setState(CURVE, '19:00@100;23:00@10');
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '23:00, 10 %']);
    expect(saveChip(m.el)).toBeNull();
  });

  it('keeps an unsaved local edit and then saves it over the external value', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    m.mock.setState(CURVE, '19:00@100;23:00@10');
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '21:30, 60 %', '22:30, 30 %', '23:30, 12 %']);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@60;22:30@30;23:30@12')]);
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '21:30, 60 %', '22:30, 30 %', '23:30, 12 %']);
  });

  it('keeps the local curve while a drag is in progress', async () => {
    const m = await mount();
    const from = centerOf(m, 1);
    const hit = hitOf(m.el, 1);
    pointer(hit, 'pointerdown', from.x, from.y);
    pointer(hit, 'pointermove', xAt(m, '21:30'), yAt(m, 60));
    await m.el.updateComplete;
    m.mock.setState(CURVE, '19:00@100;23:00@10');
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '21:30, 60 %', '22:30, 30 %', '23:30, 12 %']);
    expect(query(m.el, 'g.tooltip')).not.toBeNull();
    pointer(hit, 'pointerup', xAt(m, '21:30'), yAt(m, 60));
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@60;22:30@30;23:30@12')]);
  });

  it('clamps the selection to the new curve and drops it when the curve becomes invalid', async () => {
    const m = await mount();
    await tapPoint(m, 3);
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('23:30');
    m.mock.setState(CURVE, '19:00@100;23:00@10');
    await m.el.updateComplete;
    expect(query(m.el, '.detail')).not.toBeNull();
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('23:00');
    expect(selectedIndices(m.el)).toEqual([1]);

    m.mock.setState(CURVE, 'bogus');
    await m.el.updateComplete;
    expect(query(m.el, '.invalid')).not.toBeNull();
    expect(query(m.el, '.detail')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Detail row (spec 4)
// ---------------------------------------------------------------------------------------------

describe('detail row', () => {
  it('shows the selected point in a time input and a number input with the spec attributes', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    const time = inputOf(m.el, '.detail input[type="time"]');
    expect(time.value).toBe('21:00');
    expect(time.getAttribute('step')).toBe('300');
    const value = inputOf(m.el, '.detail input[type="number"]');
    expect(value.value).toBe('70');
    expect(value.getAttribute('min')).toBe('1');
    expect(value.getAttribute('max')).toBe('100');
    expect(value.getAttribute('step')).toBe('1');
    expect(normalized(buttonOf(m.el, '.detail button.delete').textContent)).toBe('Supprimer');
    expect(normalized(buttonOf(m.el, '.detail button.close').textContent)).toBe('Fermer');
    expect(textOf(m.el)).toContain('Heure');
    expect(textOf(m.el)).toContain('Luminosit\u00e9');
  });

  it('applies a time change through the drag snapping, then saves', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    await commit(m.el, inputOf(m.el, '.detail input[type="time"]'), '21:35');
    expect(labelsOf(m.el)[1]).toBe('21:35, 70 %');
    expect(textOf(m.el)).not.toContain('Heure ajust\u00e9e');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:35@70;22:30@30;23:30@12')]);

    // Off the 5 min grid: snapped like a drag (21:48 -> 21:50).
    await commit(m.el, inputOf(m.el, '.detail input[type="time"]'), '21:48');
    expect(labelsOf(m.el)[1]).toBe('21:50, 70 %');
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('21:50');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls[1]?.data.value).toBe('19:00@100;21:50@70;22:30@30;23:30@12');
  });

  it('clamps a time past a neighbour, says so, and clears the message after 4 s', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    await commit(m.el, inputOf(m.el, '.detail input[type="time"]'), '23:00');
    expect(labelsOf(m.el)[1]).toBe('22:25, 70 %');
    expect(textOf(m.el)).toContain('Heure ajust\u00e9e pour rester entre les points voisins');
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('22:25');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;22:25@70;22:30@30;23:30@12')]);
    await tick(m.el, MESSAGE_MS - DEBOUNCE_MS);
    expect(textOf(m.el)).not.toContain('Heure ajust\u00e9e');
  });

  it('does not blame the neighbours for a snap-only adjustment', async () => {
    // Spec 4: the message is for a time the CLAMP changed. 21:33 -> 21:35 is the snap alone, with
    // plenty of room between 19:00 and 22:30, so the neighbour message would be misleading.
    const m = await mount();
    await tapPoint(m, 1);
    await commit(m.el, inputOf(m.el, '.detail input[type="time"]'), '21:33');
    expect(labelsOf(m.el)[1]).toBe('21:35, 70 %');
    expect(textOf(m.el)).not.toContain('Heure ajust\u00e9e pour rester entre les points voisins');
  });

  it('rejects an empty time with "Heure invalide" and keeps the point', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    await commit(m.el, inputOf(m.el, '.detail input[type="time"]'), '');
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(textOf(m.el)).toContain('Heure invalide');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('applies a brightness change clamped to 1..100 and saves', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    await commit(m.el, inputOf(m.el, '.detail input[type="number"]'), '55');
    expect(labelsOf(m.el)[1]).toBe('21:00, 55 %');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:00@55;22:30@30;23:30@12')]);

    await commit(m.el, inputOf(m.el, '.detail input[type="number"]'), '150');
    expect(labelsOf(m.el)[1]).toBe('21:00, 100 %');
    expect(inputOf(m.el, '.detail input[type="number"]').value).toBe('100');
    await commit(m.el, inputOf(m.el, '.detail input[type="number"]'), '0');
    expect(labelsOf(m.el)[1]).toBe('21:00, 1 %');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls[1]?.data.value).toBe('19:00@100;21:00@1;22:30@30;23:30@12');
  });

  it('keeps the value and says "Valeur invalide" for a non-numeric brightness', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    const input = inputOf(m.el, '.detail input[type="number"]');
    // A number input sanitizes "abc" to "": stub the property to reach the NaN branch (the setter
    // absorbs whatever the handler writes back).
    let stubbed = 'abc';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => stubbed,
      set: (next: string) => {
        stubbed = next;
      },
    });
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await m.el.updateComplete;
    expect(labelsOf(m.el)[1]).toBe('21:00, 70 %');
    expect(textOf(m.el)).toContain('Valeur invalide');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('deletes the selected point and saves the shorter curve', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    const remove = buttonOf(m.el, '.detail button.delete');
    expect(remove.disabled).toBe(false);
    remove.click();
    await m.el.updateComplete;
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '22:30, 30 %', '23:30, 12 %']);
    expect(query(m.el, '.detail')).toBeNull();
    expect(selectedIndices(m.el)).toEqual([]);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;22:30@30;23:30@12')]);
  });

  it('disables deletion when only two points remain', async () => {
    const m = await mount({}, { [CURVE]: '19:00@100;23:00@10' });
    await tapPoint(m, 0);
    const remove = buttonOf(m.el, '.detail button.delete');
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute('title')).toBe('Une courbe garde au moins 2 points');
    remove.click();
    await press(m, 0, 'Delete');
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '23:00, 10 %']);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('closes the row with "Fermer" without changing the curve', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    buttonOf(m.el, '.detail button.close').click();
    await m.el.updateComplete;
    expect(query(m.el, '.detail')).toBeNull();
    expect(selectedIndices(m.el)).toEqual([]);
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Keyboard (spec 2.3)
// ---------------------------------------------------------------------------------------------

describe('keyboard', () => {
  it('moves the selected point with the arrows (Shift \u00d7 5) and coalesces the saves', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    const steps: [string, boolean, string][] = [
      ['ArrowRight', false, '21:05, 70 %'],
      ['ArrowRight', true, '21:30, 70 %'],
      ['ArrowUp', false, '21:30, 71 %'],
      ['ArrowUp', true, '21:30, 76 %'],
      ['ArrowDown', false, '21:30, 75 %'],
      ['ArrowDown', true, '21:30, 70 %'],
      ['ArrowLeft', false, '21:25, 70 %'],
      ['ArrowLeft', true, '21:00, 70 %'],
      ['ArrowRight', false, '21:05, 70 %'],
    ];
    for (const [key, shift, expected] of steps) {
      const event = await press(m, 1, key, shift);
      expect(event.defaultPrevented).toBe(true);
      expect(labelsOf(m.el)[1]).toBe(expected);
    }
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('21:05');
    expect(m.mock.calls).toHaveLength(0);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:05@70;22:30@30;23:30@12')]);
  });

  it('clamps keyboard moves between the neighbours, the window and 1..100', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    for (let i = 0; i < 4; i++) await press(m, 1, 'ArrowRight', true);
    expect(labelsOf(m.el)[1]).toBe('22:25, 70 %');

    await tapPoint(m, 0);
    for (let i = 0; i < 6; i++) await press(m, 0, 'ArrowLeft', true);
    expect(labelsOf(m.el)[0]).toBe('17:00, 100 %');
    await press(m, 0, 'ArrowUp');
    await press(m, 0, 'ArrowUp', true);
    expect(labelsOf(m.el)[0]).toBe('17:00, 100 %');

    await tapPoint(m, 3);
    for (let i = 0; i < 3; i++) await press(m, 3, 'ArrowDown', true);
    expect(labelsOf(m.el)[3]).toBe('23:30, 1 %');
    expect(labelsOf(m.el)).toEqual(['17:00, 100 %', '22:25, 70 %', '22:30, 30 %', '23:30, 1 %']);
  });

  it('deletes with Delete or Backspace, deselects with Escape, leaves other keys alone', async () => {
    const m = await mount();
    await tapPoint(m, 1);
    const other = await press(m, 1, 'a');
    expect(other.defaultPrevented).toBe(false);
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);

    const escape = await press(m, 1, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(query(m.el, '.detail')).toBeNull();
    expect(selectedIndices(m.el)).toEqual([]);
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);

    await tapPoint(m, 1);
    const del = await press(m, 1, 'Delete');
    expect(del.defaultPrevented).toBe(true);
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '22:30, 30 %', '23:30, 12 %']);
    // M3 fix plan C5 overrides "Delete clears the selection": the neighbour is selected instead.
    expect(selectedIndices(m.el)).toEqual([1]);
    expect(inputOf(m.el, '.detail input[type="time"]').value).toBe('22:30');

    await tapPoint(m, 1);
    await press(m, 1, 'Backspace');
    expect(labelsOf(m.el)).toEqual(['19:00, 100 %', '23:30, 12 %']);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;23:30@12')]);
  });
});

// ---------------------------------------------------------------------------------------------
// Reset button (spec 3)
// ---------------------------------------------------------------------------------------------

describe('reset button', () => {
  it('writes DEFAULT_CURVE immediately from the invalid block, once, and shows it after the echo', async () => {
    const m = await mount({}, { [CURVE]: 'bogus' }, { latency: 500 });
    expect(query(m.el, 'svg')).toBeNull();
    const reset = buttonOf(m.el, '.invalid button');
    expect(normalized(reset.textContent)).toBe('R\u00e9initialiser la courbe');
    expect(reset.disabled).toBe(false);

    reset.click();
    await m.el.updateComplete;
    expect(m.mock.calls).toEqual([setValueCall(DEFAULT_CURVE)]);
    expect(saveChip(m.el)).toBe('Enregistrement\u2026');
    // Spec 3 keeps the invalid block with a disabled button while saving; a chart that already
    // shows the default curve (rendered = localPoints ?? hassPoints) is accepted as well. Either
    // way a second press must not write twice.
    const saving = query(m.el, '.invalid button');
    if (saving instanceof HTMLButtonElement) {
      expect(saving.disabled).toBe(true);
      saving.click();
      await m.el.updateComplete;
    } else {
      expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    }
    expect(m.mock.calls).toHaveLength(1);

    await tick(m.el, 500);
    expect(m.mock.hass.states[CURVE]?.state).toBe(DEFAULT_CURVE);
    expect(query(m.el, '.invalid')).toBeNull();
    expect(labelsOf(m.el)).toEqual(REFERENCE_LABELS);
    expect(saveChip(m.el)).toBe('Enregistr\u00e9');
    expect(m.mock.calls).toHaveLength(1);
  });

  it('shows the error and stays on the invalid block when the reset is rejected', async () => {
    const m = await mount({}, { [CURVE]: 'bogus' }, { failServices: true });
    buttonOf(m.el, '.invalid button').click();
    await tick(m.el);
    expect(m.mock.calls).toHaveLength(1);
    expect(saveChip(m.el)).toMatch(/Erreur d.enregistrement : mock: service call failed/);
    expect(query(m.el, '.invalid')).not.toBeNull();
    expect(buttonOf(m.el, '.invalid button').disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Length guard (spec 1.1)
// ---------------------------------------------------------------------------------------------

describe('length guard', () => {
  // max_points (<= 25) cannot overflow 255 chars by adding points, but a stored curve may already
  // sit at the limit: 32 tokens "HH:MM@1" (7 chars) joined by 31 ";" = 255 chars exactly, every
  // 10 min from 17:00. Widening any value to 2 or 3 digits then exceeds the input_text.
  const FULL_CURVE = Array.from({ length: 32 }, (_, i) => `${formatTime(17 * 60 + i * 10)}@1`).join(
    ';',
  );

  it('is built exactly at the input_text limit', () => {
    expect(FULL_CURVE).toHaveLength(MAX_CURVE_LENGTH);
  });

  it('refuses a value edit that would push the curve past 255 characters', async () => {
    const m = await mount({}, { [CURVE]: FULL_CURVE });
    expect(labelsOf(m.el)).toHaveLength(32);
    await tapPoint(m, 0);
    await commit(m.el, inputOf(m.el, '.detail input[type="number"]'), '100');
    expect(labelsOf(m.el)[0]).toBe('17:00, 1 %');
    expect(textOf(m.el)).toContain(
      'Courbe trop longue pour input_text (257 > 255 caract\u00e8res)',
    );
    // The state is unchanged, so the field must not keep showing the refused value.
    expect(inputOf(m.el, '.detail input[type="number"]').value).toBe('1');
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(0);
  });

  it('keeps edits within the limit and refuses the keyboard nudge past it', async () => {
    const m = await mount({}, { [CURVE]: FULL_CURVE });
    await tapPoint(m, 0);
    for (let i = 0; i < 8; i++) await press(m, 0, 'ArrowUp');
    expect(labelsOf(m.el)[0]).toBe('17:00, 9 %');
    expect(textOf(m.el)).not.toContain('Courbe trop longue');
    // 9 -> 10 adds one character: 256 > 255.
    await press(m, 0, 'ArrowUp');
    expect(labelsOf(m.el)[0]).toBe('17:00, 9 %');
    expect(textOf(m.el)).toContain(
      'Courbe trop longue pour input_text (256 > 255 caract\u00e8res)',
    );
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toEqual([setValueCall(FULL_CURVE.replace('17:00@1', '17:00@9'))]);
  });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle (spec 3, 1)
// ---------------------------------------------------------------------------------------------

describe('lifecycle', () => {
  it('flushes a scheduled save when the card is disconnected and leaves no timer', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    expect(m.mock.calls).toHaveLength(0);
    m.el.remove();
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@60;22:30@30;23:30@12')]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes a scheduled save when the page becomes hidden', async () => {
    const m = await mount();
    await drag(m, 1, { x: xAt(m, '21:30'), y: yAt(m, 60) });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(m.mock.calls).toEqual([setValueCall('19:00@100;21:30@60;22:30@30;23:30@12')]);
    await tick(m.el, DEBOUNCE_MS);
    expect(m.mock.calls).toHaveLength(1);
  });

  it('clears the transient message timer on disconnect', async () => {
    const m = await mount({ max_points: 4 });
    await tapBackground(m, xAt(m, '20:00'), yAt(m, 50));
    expect(textOf(m.el)).toContain('Nombre maximal de points atteint (4)');
    m.el.remove();
    expect(vi.getTimerCount()).toBe(0);
    expect(m.mock.calls).toHaveLength(0);
  });
});
