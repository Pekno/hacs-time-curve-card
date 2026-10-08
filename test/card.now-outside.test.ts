/**
 * Tests for the M5 edge marker of a "now" outside the window (docs/card-rendering-spec.md,
 * section 2.4 "Now marker"): the triangle on the plot edge of the side where now lies, its
 * time + value label (halo'd, kept inside the SVG and off the drag tooltip), the footer note,
 * the chart's aria-label, and the switch to the in-window line when the clock enters the window.
 *
 * Non-ASCII characters are written as unicode escapes (code point form); the check at the end
 * keeps this file ASCII-only.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/index.js';
import { TimeCurveCard, segmentMeetsBox, type Box } from '../src/card.js';
import { MockHass, type MockEntityInit } from '../dev/mock-hass.js';
import type { CardConfig } from '../src/types.js';

const CURVE = 'input_text.c';

/** The reference curve: 100 % before 19:00, 57 % at 21:30, 12 % after 23:30. */
const REFERENCE_CURVE = '19:00@100;21:00@70;22:30@30;23:30@12';

/** Narrow no-break space (before `%`), no-break space (before `:`), middle dot. */
const NNBSP = '\u{202f}';
const NBSP = '\u{a0}';
const MIDDOT = '\u{b7}';

const CHART_LABEL = `Courbe${NBSP}: Luminosit\u{e9}`;
const BEFORE = 'avant la plage affich\u{e9}e';
const AFTER = 'apr\u{e8}s la plage affich\u{e9}e';
const OUTSIDE = 'hors de la plage affich\u{e9}e';
const ONE_POINT_OUTSIDE = '1 point hors de la fen\u{ea}tre affich\u{e9}e';

/**
 * The happy-dom chart: fallback width 400 - 32 = 368, height 180; plot margins 40 / 14 / 14 / 24,
 * so the plot is x 40..354, y 14..156 (100 % at y 14, 12 % at y 138.96).
 */
const SVG_WIDTH = 368;
const SVG_HEIGHT = 180;
const PLOT = { x: 40, y: 14, width: SVG_WIDTH - 54, height: SVG_HEIGHT - 38 };

type Card = HTMLElementTagNameMap['time-curve-card'];

const mounted: Card[] = [];

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

/** Mounts the card; `now` null keeps the real (or faked) clock. */
async function mount(
  cardConfig: CardConfig,
  entities: Record<string, MockEntityInit>,
  now: string | null,
): Promise<Card> {
  const el = document.createElement('time-curve-card');
  const mock = new MockHass(entities, {
    onChange: (hass) => {
      el.hass = hass;
    },
  });
  el.setConfig(cardConfig);
  if (now !== null) el.nowProvider = clockAt(now);
  el.hass = mock.hass;
  document.body.append(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

function query(el: Card, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null;
}

function svgOf(el: Card): Element {
  const svg = query(el, 'svg');
  if (svg === null) throw new Error('the chart is not rendered');
  return svg;
}

/** Text with every whitespace run (the narrow no-break space included) as one space. */
function flat(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function boxOf(element: Element | null): Box {
  return {
    x: Number(element?.getAttribute('x')),
    y: Number(element?.getAttribute('y')),
    width: Number(element?.getAttribute('width')),
    height: Number(element?.getAttribute('height')),
  };
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The edge triangle's vertices, tip first. */
function triangleOf(el: Card): { x: number; y: number }[] {
  const points = query(el, 'g.now-outside polygon.now-edge')?.getAttribute('points') ?? '';
  return points.split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { x: x ?? Number.NaN, y: y ?? Number.NaN };
  });
}

function expectVertex(vertex: { x: number; y: number } | undefined, x: number, y: number): void {
  expect(vertex?.x).toBeCloseTo(x, 2);
  expect(vertex?.y).toBeCloseTo(y, 2);
}

/** Text of the footer note about "now" (null when there is none). */
function nowNoteOf(el: Card): string | null {
  const note = query(el, '.notes .note-now');
  return note === null ? null : (note.textContent?.trim() ?? '');
}

/** The halo stays inside the SVG, right of the value labels (which end at plot.x - 10). */
function expectInsideTheSvg(halo: Box, width = SVG_WIDTH, height = SVG_HEIGHT): void {
  expect(halo.x).toBeGreaterThanOrEqual(2);
  expect(halo.y).toBeGreaterThanOrEqual(2);
  expect(halo.x + halo.width).toBeLessThanOrEqual(width - 2);
  expect(halo.y + halo.height).toBeLessThanOrEqual(height - 2);
  expect(halo.x).toBeGreaterThan(PLOT.x - 10);
}

describe('now outside the window: edge marker', () => {
  it('draws a left-edge triangle and label when now is before the window start (14:39)', async () => {
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '14:39');
    const group = query(el, 'g.now-outside');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('data-side')).toBe('before');
    // No in-window marker at the same time.
    expect(query(el, '.now-line')).toBeNull();
    expect(query(el, 'g.now')).toBeNull();

    // 14:39 is before the first point: 100 %, the plot top. Tip on the left plot edge, pointing
    // left (out of the plot); 8px wide, 10px tall.
    const [tip, top, bottom] = triangleOf(el);
    expectVertex(tip, PLOT.x, PLOT.y);
    expectVertex(top, PLOT.x + 8, PLOT.y - 5);
    expectVertex(bottom, PLOT.x + 8, PLOT.y + 5);

    // The label: time and value, on the plot side of the triangle, below it near the top.
    const label = query(el, 'g.now-outside text.now-label');
    expect(label?.textContent?.trim()).toBe(`14:39 ${MIDDOT} 100${NNBSP}%`);
    expect(label?.getAttribute('text-anchor')).toBe('start');
    expect(Number(label?.getAttribute('x'))).toBe(PLOT.x + 8);
    expect(Number(label?.getAttribute('y'))).toBe(PLOT.y + 17);
    const halo = boxOf(query(el, 'g.now-outside rect.now-halo'));
    expect(halo.x).toBeLessThan(PLOT.x + 8);
    expect(halo.width).toBeGreaterThan(60);
    expectInsideTheSvg(halo);
    // Clear of the triangle (whose bottom is at PLOT.y + 5).
    expect(halo.y).toBeGreaterThan(PLOT.y + 5);
  });

  it('puts the label above the triangle when the value leaves room', async () => {
    const el = await mount(config(), { [CURVE]: '19:00@60;23:00@10' }, '14:39');
    const y = PLOT.y + 0.4 * PLOT.height;
    const [tip] = triangleOf(el);
    expectVertex(tip, PLOT.x, y);
    const label = query(el, 'g.now-outside text.now-label');
    expect(label?.textContent?.trim()).toBe(`14:39 ${MIDDOT} 60${NNBSP}%`);
    expect(Number(label?.getAttribute('y'))).toBeCloseTo(y - 9, 2);
    const halo = boxOf(query(el, 'g.now-outside rect.now-halo'));
    // Above the triangle's top (y - 5): the label never covers the flat start of the curve.
    expect(halo.y + halo.height).toBeLessThan(y - 5);
    expectInsideTheSvg(halo);
  });

  it('never hides the curve: the line and the markers are drawn over the edge label', async () => {
    // The owner's afternoon: 100 % at 14:39, and the curve comes down from 19:00 @ 100 right
    // under the label. Neither side of the tip is clear (above, the label would be pushed onto
    // the triangle and the flat start), so the label stays below and the curve paints over it.
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '14:39');
    const halo = boxOf(query(el, 'g.now-outside rect.now-halo'));
    const x19 = PLOT.x + (120 / 900) * PLOT.width;
    const x21 = PLOT.x + (240 / 900) * PLOT.width;
    const y21 = PLOT.y + 0.3 * PLOT.height;
    expect(segmentMeetsBox(x19, PLOT.y, x21, y21, halo)).toBe(true);
    expect(Number(query(el, 'g.now-outside text.now-label')?.getAttribute('y'))).toBe(PLOT.y + 17);

    const order = (a: Element | null, b: Element | null): boolean =>
      a !== null && b !== null && (a.compareDocumentPosition(b) & 4) !== 0;
    // The label (halo + text) between the area and the line; the triangle over the points, so a
    // point sitting on the plot edge does not hide it either.
    const label = query(el, 'g.now-outside-label');
    expect(label?.querySelector('rect.now-halo')).not.toBeNull();
    expect(label?.querySelector('text.now-label')).not.toBeNull();
    expect(order(query(el, 'path.area'), label)).toBe(true);
    expect(order(label, query(el, 'path.line'))).toBe(true);
    expect(order(label, query(el, 'g.points'))).toBe(true);
    const marker = query(el, 'g.now-outside-marker');
    expect(marker?.querySelector('polygon.now-edge')).not.toBeNull();
    expect(marker?.getAttribute('data-side')).toBe('before');
    expect(order(query(el, 'g.points'), marker)).toBe(true);
    // The line is still clipped to the plot like the area.
    expect(query(el, 'path.line')?.parentElement?.getAttribute('clip-path')).toBe(
      query(el, 'path.area')?.parentElement?.getAttribute('clip-path'),
    );
  });

  it('moves the edge label to the other side of the tip when only that side misses the curve', async () => {
    // 14:39 is before the first point (16:00, outside the window): 50 %. The curve then climbs to
    // 62 % at 17:30 and stays there until 22:00: the line runs through the usual place of the
    // label (above the tip) and leaves the room below it free.
    const el = await mount(config(), { [CURVE]: '16:00@50;17:30@62;22:00@62;23:00@10' }, '14:39');
    const y = PLOT.y + 0.5 * PLOT.height;
    const [tip] = triangleOf(el);
    expectVertex(tip, PLOT.x, y);
    const label = query(el, 'g.now-outside text.now-label');
    expect(label?.textContent?.trim()).toBe(`14:39 ${MIDDOT} 50${NNBSP}%`);
    expect(Number(label?.getAttribute('y'))).toBeCloseTo(y + 17, 2);
    const halo = boxOf(query(el, 'g.now-outside rect.now-halo'));
    // Below the triangle (whose bottom is at y + 5), clear of the 62 % line above it.
    expect(halo.y).toBeGreaterThan(y + 5);
    const y62 = PLOT.y + 0.38 * PLOT.height;
    expect(segmentMeetsBox(PLOT.x, y62, PLOT.x + PLOT.width, y62, halo)).toBe(false);
    expectInsideTheSvg(halo);
  });

  it('draws a right-edge triangle and an end-anchored label after the window end (09:30)', async () => {
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '09:30');
    expect(query(el, 'g.now-outside')?.getAttribute('data-side')).toBe('after');
    expect(query(el, '.now-line')).toBeNull();

    const right = PLOT.x + PLOT.width;
    const y = PLOT.y + 0.88 * PLOT.height; // 12 %
    const [tip, top, bottom] = triangleOf(el);
    expectVertex(tip, right, y);
    expectVertex(top, right - 8, y - 5);
    expectVertex(bottom, right - 8, y + 5);

    const label = query(el, 'g.now-outside text.now-label');
    expect(label?.textContent?.trim()).toBe(`09:30 ${MIDDOT} 12${NNBSP}%`);
    expect(label?.getAttribute('text-anchor')).toBe('end');
    expect(Number(label?.getAttribute('x'))).toBe(right - 8);
    const halo = boxOf(query(el, 'g.now-outside rect.now-halo'));
    expect(halo.x + halo.width).toBeGreaterThan(right - 8);
    expect(halo.x + halo.width).toBeLessThanOrEqual(right);
    expectInsideTheSvg(halo);
    // Above the triangle, hence clear of the plot baseline and the hour labels under it.
    expect(halo.y + halo.height).toBeLessThan(y - 5);
  });

  it('draws no edge marker, note or aria mention while now is inside the window', async () => {
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '21:30');
    expect(query(el, 'g.now-outside')).toBeNull();
    expect(query(el, '.now-edge')).toBeNull();
    expect(query(el, '.now-line')).not.toBeNull();
    expect(query(el, '.notes')).toBeNull();
    expect(svgOf(el).getAttribute('aria-label')).toBe(CHART_LABEL);
  });

  it('counts the window bounds as inside: 17:00 and 08:00 get the line, 16:59 and 08:01 the edge', async () => {
    const cases: [string, 'before' | 'after' | null][] = [
      ['16:59', 'before'],
      ['17:00', null],
      ['08:00', null],
      ['08:01', 'after'],
    ];
    for (const [now, side] of cases) {
      const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, now);
      expect(query(el, 'g.now-outside')?.getAttribute('data-side') ?? null).toBe(side);
      expect(query(el, '.now-line') === null).toBe(side !== null);
    }
  });

  it('draws nothing and writes no note for an invalid curve', async () => {
    const el = await mount(config(), { [CURVE]: 'bogus' }, '14:39');
    expect(query(el, 'svg')).toBeNull();
    expect(query(el, 'g.now-outside')).toBeNull();
    expect(query(el, '.notes')).toBeNull();
  });

  it('follows window_start / window_end', async () => {
    const el = await mount(
      config({ window_start: '20:00', window_end: '23:00' }),
      { [CURVE]: REFERENCE_CURVE },
      '23:30',
    );
    expect(query(el, 'g.now-outside')?.getAttribute('data-side')).toBe('after');
    expect(flat(query(el, 'g.now-outside text.now-label')?.textContent)).toBe(
      `23:30 ${MIDDOT} 12 %`,
    );
    expect(nowNoteOf(el)).toBe(`Maintenant (23:30)${NBSP}: ${AFTER}`);
  });

  it('keeps the whole group out of hit testing (pointer-events: none), in the now-line ink', async () => {
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '14:39');
    expect(query(el, 'g.now-outside')).not.toBeNull();
    const styles = TimeCurveCard.styles.cssText;
    expect(styles).toMatch(/\.now-outside[^{]*\{[^}]*pointer-events:\s*none/);
    expect(styles).toMatch(/\.now-edge\s*\{[^}]*fill:\s*var\(--primary-text-color\)/);
    expect(styles).toMatch(/\.now-edge\s*\{[^}]*opacity:\s*0\.6/);
  });

  it('clamps the label inside a narrow SVG', async () => {
    // A ResizeObserver whose callback the test fires itself, with a 120px chart (the narrowest
    // layout the card is designed for).
    let callback: ResizeObserverCallback | null = null;
    class ManualResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callback = cb;
      }
      observe(): void {
        // The test notifies by hand.
      }
      unobserve(): void {
        // Nothing to forget.
      }
      disconnect(): void {
        // Nothing to release.
      }
    }
    vi.stubGlobal('ResizeObserver', ManualResizeObserver);
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '14:39');
    const chart = query(el, '.chart');
    if (chart === null) throw new Error('no chart');
    Object.defineProperty(chart, 'clientWidth', { value: 120, configurable: true });
    const notify = callback as ResizeObserverCallback | null;
    notify?.([], {} as ResizeObserver);
    await el.updateComplete;
    expect(svgOf(el).getAttribute('viewBox')).toBe('0 0 120 180');
    // The label is wider than the room right of the triangle: moved left, inside the SVG.
    const halo = boxOf(query(el, 'g.now-outside rect.now-halo'));
    expectInsideTheSvg(halo, 120, 180);
    expect(halo.x + halo.width).toBeCloseTo(118, 2);
    const label = query(el, 'g.now-outside text.now-label');
    expect(Number(label?.getAttribute('x'))).toBeCloseTo(halo.x + 3, 2);
  });
});

describe('now outside the window: note and aria-label', () => {
  it('says where now lies in the footer note', async () => {
    const before = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '14:39');
    expect(nowNoteOf(before)).toBe(`Maintenant (14:39)${NBSP}: ${BEFORE}`);
    expect(query(before, '.notes .note-points')).toBeNull();

    const after = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '09:30');
    expect(nowNoteOf(after)).toBe(`Maintenant (09:30)${NBSP}: ${AFTER}`);
  });

  it('shows both notes, one per line, when points lie outside the window too', async () => {
    const el = await mount(config(), { [CURVE]: '19:00@100;23:00@20;10:00@50' }, '14:39');
    const lines = Array.from(el.shadowRoot?.querySelectorAll('.notes > div') ?? []).map((line) =>
      line.textContent?.trim(),
    );
    expect(lines).toEqual([ONE_POINT_OUTSIDE, `Maintenant (14:39)${NBSP}: ${BEFORE}`]);
  });

  it('mentions it in the chart aria-label', async () => {
    const before = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '14:39');
    expect(svgOf(before).getAttribute('aria-label')).toBe(
      `${CHART_LABEL}, maintenant 14:39, ${OUTSIDE}`,
    );
    const after = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '09:30');
    expect(svgOf(after).getAttribute('aria-label')).toBe(
      `${CHART_LABEL}, maintenant 09:30, ${OUTSIDE}`,
    );
  });
});

describe('now outside the window: clock', () => {
  it('moves with the minute clock and switches to the in-window line at 17:00', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 16, 58, 0, 0));
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, null);
    expect(flat(query(el, 'g.now-outside text.now-label')?.textContent)).toBe(
      `16:58 ${MIDDOT} 100 %`,
    );

    vi.advanceTimersByTime(60_000);
    await el.updateComplete;
    expect(flat(query(el, 'g.now-outside text.now-label')?.textContent)).toBe(
      `16:59 ${MIDDOT} 100 %`,
    );
    expect(nowNoteOf(el)).toBe(`Maintenant (16:59)${NBSP}: ${BEFORE}`);
    expect(svgOf(el).getAttribute('aria-label')).toContain('maintenant 16:59');

    vi.advanceTimersByTime(60_000);
    await el.updateComplete;
    expect(query(el, 'g.now-outside')).toBeNull();
    expect(query(el, '.notes')).toBeNull();
    expect(svgOf(el).getAttribute('aria-label')).toBe(CHART_LABEL);
    // The line sits on the window start, i.e. the left plot edge.
    const line = query(el, '.now-line');
    expect(line).not.toBeNull();
    expect(Number(line?.getAttribute('x1'))).toBe(PLOT.x);
    expect(query(el, 'g.now text.now-label')?.textContent?.trim()).toBe(`100${NNBSP}%`);
  });

  it('switches from the line to the right edge when the clock passes 08:00', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 8, 0, 0, 0));
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, null);
    expect(query(el, '.now-line')).not.toBeNull();
    expect(query(el, 'g.now-outside')).toBeNull();

    vi.advanceTimersByTime(60_000);
    await el.updateComplete;
    expect(query(el, '.now-line')).toBeNull();
    expect(query(el, 'g.now-outside')?.getAttribute('data-side')).toBe('after');
    expect(nowNoteOf(el)).toBe(`Maintenant (08:01)${NBSP}: ${AFTER}`);
  });
});

describe('now outside the window: drag tooltip', () => {
  /** 1 client px = 1 SVG unit: the bounding box is the viewBox at the origin. */
  function stubSvgRect(el: Card): void {
    svgOf(el).getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: SVG_WIDTH,
      bottom: SVG_HEIGHT,
      width: SVG_WIDTH,
      height: SVG_HEIGHT,
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

  it('keeps the drag tooltip off the edge label', async () => {
    const el = await mount(config(), { [CURVE]: REFERENCE_CURVE }, '14:39');
    stubSvgRect(el);
    const hit = query(el, 'g.point[data-index="0"] circle.hit');
    if (hit === null) throw new Error('no point 0');
    hit.dispatchEvent(
      pointerEvent('pointerdown', Number(hit.getAttribute('cx')), Number(hit.getAttribute('cy'))),
    );
    await el.updateComplete;
    // Point 0 (19:00 @ 100) dragged to 17:30 @ 75, near the left edge: now (14:39, before the
    // first point) follows it to 75 %, and its label lands where the tooltip would go.
    const x = PLOT.x + (30 / 900) * PLOT.width;
    const y = PLOT.y + 0.25 * PLOT.height;
    svgOf(el).dispatchEvent(pointerEvent('pointermove', x, y));
    await el.updateComplete;

    const label = query(el, 'g.now-outside text.now-label');
    expect(label?.textContent?.trim()).toBe(`14:39 ${MIDDOT} 75${NNBSP}%`);
    const tip = boxOf(query(el, 'g.tooltip rect'));
    const halo = boxOf(query(el, 'g.now-outside rect.now-halo'));
    // At its usual place (14px above the marker) the tooltip would cover the edge label...
    expect(intersects({ ...tip, y: y - 14 - 18 }, halo)).toBe(true);
    // ...so it is raised just above it, still inside the SVG.
    expect(intersects(tip, halo)).toBe(false);
    expect(tip.y + tip.height).toBeCloseTo(halo.y - 2, 1);
    expect(tip.y).toBeGreaterThanOrEqual(2);

    svgOf(el).dispatchEvent(pointerEvent('pointerup', x, y));
    await el.updateComplete;
  });
});

describe('segmentMeetsBox', () => {
  const box: Box = { x: 10, y: 10, width: 20, height: 10 };

  it('finds a segment crossing, entering, inside or touching the box', () => {
    expect(segmentMeetsBox(0, 15, 40, 15, box)).toBe(true); // through, horizontal
    expect(segmentMeetsBox(20, 0, 20, 30, box)).toBe(true); // through, vertical
    expect(segmentMeetsBox(0, 0, 40, 30, box)).toBe(true); // through, diagonal
    expect(segmentMeetsBox(0, 15, 15, 15, box)).toBe(true); // ends inside
    expect(segmentMeetsBox(12, 12, 14, 14, box)).toBe(true); // wholly inside
    expect(segmentMeetsBox(0, 10, 40, 10, box)).toBe(true); // along the top side
    expect(segmentMeetsBox(30, 20, 40, 30, box)).toBe(true); // touches a corner
  });

  it('misses a segment that stays outside, even when its line would cross the box', () => {
    expect(segmentMeetsBox(0, 5, 40, 5, box)).toBe(false); // above
    expect(segmentMeetsBox(0, 0, 5, 30, box)).toBe(false); // left
    expect(segmentMeetsBox(0, 15, 8, 15, box)).toBe(false); // stops short
    expect(segmentMeetsBox(0, 30, 30, 21, box)).toBe(false); // passes under a corner
    expect(segmentMeetsBox(35, 0, 45, 30, box)).toBe(false); // right
  });
});

describe('sources', () => {
  it('keeps this test file ASCII-only (non-ASCII as unicode escapes)', () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), 'card.now-outside.test.ts');
    const isAscii = (line: string): boolean => {
      for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) > 0x7f) return false;
      return true;
    };
    const offending = readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (isAscii(line) ? [] : [i + 1]));
    expect(offending).toEqual([]);
  });
});
