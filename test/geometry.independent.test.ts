/**
 * Independent tests for src/core/geometry.ts, written from the M2 spec (section 1) alone, without
 * reading the implementation or test/geometry.test.ts: every expected value below was derived by
 * hand from the spec text so that the two test files cannot share a misreading. Kept in the repo
 * as extra coverage next to test/geometry.test.ts.
 *
 * Fixed reference frame used throughout:
 * - WINDOW = 17:00 -> 08:00 = keys 300 -> 1200 (span 900 min = 15 h), the card's defaults;
 * - PLOT = { x: 34, y: 14, width: 900, height: 200 }: 1 px per minute and 2 px per percent, so
 *   x = 34 + (key - 300) and y = 14 + 2 * (100 - value).
 */
import { describe, expect, it } from 'vitest';
import {
  CURVE_DAY_END_KEY,
  DEFAULT_MAX_POINTS,
  DEFAULT_SNAP_MINUTES,
  DEFAULT_WINDOW_END,
  DEFAULT_WINDOW_START,
  areaPath,
  clampKeyBetween,
  clampValue,
  curvePath,
  hourTicks,
  isKeyVisible,
  keyToX,
  makeWindow,
  polylineNodes,
  snapTime,
  timeToX,
  valueToY,
  xToKey,
  xToTime,
  yToValue,
  type PlotArea,
  type TimeWindow,
} from '../src/core/geometry.js';
import {
  DEFAULT_CURVE,
  MAX_CURVE_LENGTH,
  MINUTES_PER_DAY,
  maxPointsFor,
  parseCurve,
  parseTime,
  serializeCurve,
  sortKey,
  type CurvePoint,
} from '../src/core/curve.js';

/** 17:00 -> 08:00: sortKey(1020) = 300, sortKey(480) = (480 - 720) mod 1440 = 1200. */
const WINDOW: TimeWindow = { startKey: 300, endKey: 1200 };
/** 12:00 -> 12:00 next day: the whole curve day. */
const FULL_DAY: TimeWindow = { startKey: 0, endKey: 1440 };
/** 1 px per minute over WINDOW (900 px for 900 min), 2 px per percent. */
const PLOT: PlotArea = { x: 34, y: 14, width: 900, height: 200 };

/** Parses an `HH:MM` fixture time, failing loudly instead of returning null. */
function minutesOf(time: string): number {
  const minutes = parseTime(time);
  if (minutes === null) throw new Error(`test time "${time}" is not HH:MM`);
  return minutes;
}

/** Curve-day key of an `HH:MM` time. */
function keyOf(time: string): number {
  return sortKey(minutesOf(time));
}

/** Builds a curve point from an `HH:MM` time and a value. */
function point(time: string, value: number): CurvePoint {
  return { time: minutesOf(time), value };
}

/** Builds a polyline node (key space) from an `HH:MM` time and a value. */
function node(time: string, value: number): { key: number; value: number } {
  return { key: keyOf(time), value };
}

/** Builds the expected hour tick for a full-hour `HH:MM` time. */
function tick(time: string): { key: number; minutes: number; label: string } {
  const minutes = minutesOf(time);
  return { key: sortKey(minutes), minutes, label: `${Math.floor(minutes / 60)}h` };
}

/** PLOT with another width (the hour-tick step only depends on width / span). */
function plotOfWidth(width: number): PlotArea {
  return { ...PLOT, width };
}

describe('constants', () => {
  it('match the spec values', () => {
    expect(DEFAULT_WINDOW_START).toBe('17:00');
    expect(DEFAULT_WINDOW_END).toBe('08:00');
    expect(DEFAULT_SNAP_MINUTES).toBe(5);
    expect(DEFAULT_MAX_POINTS).toBe(12);
    expect(maxPointsFor()).toBe(25);
    expect(CURVE_DAY_END_KEY).toBe(1440);
    expect(CURVE_DAY_END_KEY).toBe(MINUTES_PER_DAY);
  });

  it('maxPointsFor() canonical tokens always fit in the input_text (25 x "HH:MM@100" = 249)', () => {
    const points = Array.from({ length: maxPointsFor() }, (_, i) => ({
      time: i * 30,
      value: 100,
    }));
    expect(serializeCurve(points)).toHaveLength(249);
    expect(serializeCurve(points).length).toBeLessThanOrEqual(MAX_CURVE_LENGTH);
  });
});

describe('makeWindow', () => {
  it('maps the default 17:00 -> 08:00 window onto keys 300 -> 1200', () => {
    expect(makeWindow(DEFAULT_WINDOW_START, DEFAULT_WINDOW_END)).toEqual(WINDOW);
    expect(makeWindow('17:00', '08:00')).toEqual({ startKey: 300, endKey: 1200 });
  });

  it('maps 12:00 as END to key 1440 and 12:00 as START to key 0', () => {
    expect(makeWindow('12:00', '12:00')).toEqual({ startKey: 0, endKey: CURVE_DAY_END_KEY });
    expect(makeWindow('17:00', '12:00')).toEqual({ startKey: 300, endKey: 1440 });
    expect(makeWindow('12:00', '08:00')).toEqual({ startKey: 0, endKey: 1200 });
    expect(makeWindow('12:00', '11:59')).toEqual({ startKey: 0, endKey: 1439 });
  });

  it('maps other times with sortKey (noon pivot)', () => {
    expect(makeWindow('23:00', '01:00')).toEqual({ startKey: 660, endKey: 780 });
    expect(makeWindow('12:01', '11:59')).toEqual({ startKey: 1, endKey: 1439 });
    expect(makeWindow('00:00', '06:00')).toEqual({ startKey: 720, endKey: 1080 });
  });

  it('throws a readable French error for an invalid window_start', () => {
    for (const bad of ['', '25:00', '17:60', '17h00', '1700', 'abc', '17:00:00']) {
      expect(() => makeWindow(bad, '08:00'), JSON.stringify(bad)).toThrow(Error);
      expect(() => makeWindow(bad, '08:00'), JSON.stringify(bad)).toThrow(
        'window_start invalide : attendu HH:MM',
      );
    }
  });

  it('throws a readable French error for an invalid window_end', () => {
    for (const bad of ['', '24:00', '08:99', '8h', 'x']) {
      expect(() => makeWindow('17:00', bad), JSON.stringify(bad)).toThrow(Error);
      expect(() => makeWindow('17:00', bad), JSON.stringify(bad)).toThrow(
        'window_end invalide : attendu HH:MM',
      );
    }
  });

  it('throws when the start does not precede the end in the 12:00 -> 12:00 day', () => {
    // 08:00 (key 1200) comes after 17:00 (key 300) in the curve day.
    expect(() => makeWindow('08:00', '17:00')).toThrow(
      'window_start (08:00) doit précéder window_end (17:00) dans la journée 12:00 → 12:00',
    );
    // Equal keys are rejected too (startKey < endKey is strict).
    expect(() => makeWindow('17:00', '17:00')).toThrow(
      'window_start (17:00) doit précéder window_end (17:00) dans la journée 12:00 → 12:00',
    );
    // 12:00 as end is 1440, but 12:00 as start is 0: 11:00 -> 12:00 is fine, 12:00 -> 11:59 too,
    // while a start of 13:00 with an end of 12:30 (key 30) is not.
    expect(makeWindow('11:00', '12:00')).toEqual({ startKey: 1380, endKey: 1440 });
    expect(() => makeWindow('13:00', '12:30')).toThrow(
      'window_start (13:00) doit précéder window_end (12:30) dans la journée 12:00 → 12:00',
    );
  });
});

describe('keyToX / timeToX', () => {
  it('maps the window edges onto the plot edges', () => {
    expect(keyToX(300, WINDOW, PLOT)).toBeCloseTo(34, 9);
    expect(keyToX(1200, WINDOW, PLOT)).toBeCloseTo(934, 9);
  });

  it('is linear inside the window', () => {
    expect(keyToX(720, WINDOW, PLOT)).toBeCloseTo(454, 9); // 00:00
    expect(keyToX(750, WINDOW, PLOT)).toBeCloseTo(484, 9); // 00:30, exact middle
    expect(keyToX(421, WINDOW, PLOT)).toBeCloseTo(155, 9); // 19:01
  });

  it('extrapolates outside the window instead of clamping', () => {
    expect(keyToX(0, WINDOW, PLOT)).toBeCloseTo(-266, 9);
    expect(keyToX(1440, WINDOW, PLOT)).toBeCloseTo(1174, 9);
    expect(keyToX(299, WINDOW, PLOT)).toBeCloseTo(33, 9);
  });

  it('timeToX goes through sortKey: 17:00 at plot.x, 08:00 at plot.x + width', () => {
    expect(timeToX(minutesOf('17:00'), WINDOW, PLOT)).toBeCloseTo(34, 9);
    expect(timeToX(minutesOf('08:00'), WINDOW, PLOT)).toBeCloseTo(934, 9);
    expect(timeToX(minutesOf('23:59'), WINDOW, PLOT)).toBeCloseTo(453, 9);
    expect(timeToX(minutesOf('00:00'), WINDOW, PLOT)).toBeCloseTo(454, 9);
    // Outside the window: 12:00 is key 0 (before), 11:59 is key 1439 (after).
    expect(timeToX(minutesOf('12:00'), WINDOW, PLOT)).toBeCloseTo(-266, 9);
    expect(timeToX(minutesOf('11:59'), WINDOW, PLOT)).toBeCloseTo(1173, 9);
  });

  it('places midnight at the exact fraction 7/15 of a 17:00 -> 08:00 window', () => {
    const plot = plotOfWidth(450);
    expect(timeToX(0, WINDOW, plot)).toBeCloseTo(34 + (450 * 7) / 15, 9);
    expect(timeToX(0, WINDOW, plot)).toBeCloseTo(244, 9);
  });

  it('honours plot.x and plot.width', () => {
    const plot: PlotArea = { x: 100, y: 0, width: 300, height: 100 };
    expect(keyToX(300, WINDOW, plot)).toBeCloseTo(100, 9);
    expect(keyToX(1200, WINDOW, plot)).toBeCloseTo(400, 9);
    expect(keyToX(750, WINDOW, plot)).toBeCloseTo(250, 9);
  });
});

describe('xToKey / xToTime', () => {
  it('inverts keyToX at the plot edges and in between', () => {
    expect(xToKey(34, WINDOW, PLOT)).toBeCloseTo(300, 9);
    expect(xToKey(934, WINDOW, PLOT)).toBeCloseTo(1200, 9);
    expect(xToKey(454, WINDOW, PLOT)).toBeCloseTo(720, 9);
  });

  it('is unclamped outside the plot', () => {
    expect(xToKey(0, WINDOW, PLOT)).toBeCloseTo(266, 9);
    expect(xToKey(1000, WINDOW, PLOT)).toBeCloseTo(1266, 9);
    expect(xToKey(-266, WINDOW, PLOT)).toBeCloseTo(0, 9);
  });

  it('round-trips with keyToX', () => {
    for (const key of [0, 300, 421, 720, 999.5, 1200, 1440, -100, 2000]) {
      expect(xToKey(keyToX(key, WINDOW, PLOT), WINDOW, PLOT), String(key)).toBeCloseTo(key, 9);
    }
    for (const x of [-10, 34, 100.25, 454, 934, 1500]) {
      expect(keyToX(xToKey(x, WINDOW, PLOT), WINDOW, PLOT), String(x)).toBeCloseTo(x, 9);
    }
  });

  it('xToTime returns minutes since midnight (key + 720, wrapped)', () => {
    // x offsets chosen so that (x - plot.x) / width is a dyadic fraction: no FP noise.
    expect(xToTime(34, WINDOW, PLOT)).toBe(minutesOf('17:00')); // key 300
    expect(xToTime(34 + 225, WINDOW, PLOT)).toBe(minutesOf('20:45')); // key 525
    expect(xToTime(34 + 450, WINDOW, PLOT)).toBe(minutesOf('00:30')); // key 750
    expect(xToTime(34 + 675, WINDOW, PLOT)).toBe(minutesOf('04:15')); // key 975
    expect(xToTime(34 + 900, WINDOW, PLOT)).toBe(minutesOf('08:00')); // key 1200
  });

  it('wraps key 1440 to 12:00 (720) and key 0 to 12:00 too', () => {
    const plot: PlotArea = { x: 10, y: 0, width: 1440, height: 100 };
    expect(xToTime(10 + 1440, FULL_DAY, plot)).toBe(720); // key 1440 -> 12:00
    expect(xToTime(10, FULL_DAY, plot)).toBe(720); // key 0 -> 12:00
    expect(xToTime(10 + 720, FULL_DAY, plot)).toBe(0); // key 720 -> 00:00
    expect(xToTime(10 + 360, FULL_DAY, plot)).toBe(minutesOf('18:00')); // key 360
    // The 17:00 -> 12:00 window ends at key 1440 as well.
    const noonEnd: TimeWindow = { startKey: 300, endKey: 1440 };
    const plot2: PlotArea = { x: 0, y: 0, width: 1140, height: 100 };
    expect(xToTime(1140, noonEnd, plot2)).toBe(720);
  });

  it('uses a positive modulo for keys outside [0, 1440]', () => {
    const plot: PlotArea = { x: 0, y: 0, width: 1440, height: 100 };
    expect(xToTime(-360, FULL_DAY, plot)).toBe(minutesOf('06:00')); // key -360 -> 360
    expect(xToTime(-1080, FULL_DAY, plot)).toBe(minutesOf('18:00')); // key -1080 -> -360 -> 1080
    expect(xToTime(1800, FULL_DAY, plot)).toBe(minutesOf('18:00')); // key 1800 -> 2520 -> 1080
    expect(xToTime(2880, FULL_DAY, plot)).toBe(720); // key 2880 -> 3600 -> 720
  });

  it('always returns a minute of day in [0, 1439] for integer keys', () => {
    const plot: PlotArea = { x: 0, y: 0, width: 1440, height: 100 };
    for (let x = -1440; x <= 2880; x += 15) {
      const minutes = xToTime(x, FULL_DAY, plot);
      expect(minutes, String(x)).toBeGreaterThanOrEqual(0);
      expect(minutes, String(x)).toBeLessThan(MINUTES_PER_DAY);
      expect(Number.isInteger(minutes), String(x)).toBe(true);
    }
  });
});

describe('valueToY / yToValue', () => {
  it('puts 100 % at the top and 0 % at the bottom of the plot', () => {
    expect(valueToY(100, PLOT)).toBeCloseTo(14, 9);
    expect(valueToY(0, PLOT)).toBeCloseTo(214, 9);
    expect(valueToY(50, PLOT)).toBeCloseTo(114, 9);
    expect(valueToY(75, PLOT)).toBeCloseTo(64, 9);
    expect(valueToY(25, PLOT)).toBeCloseTo(164, 9);
    expect(valueToY(1, PLOT)).toBeCloseTo(212, 9);
    expect(valueToY(33, PLOT)).toBeCloseTo(148, 9);
  });

  it('inverts valueToY', () => {
    expect(yToValue(14, PLOT)).toBeCloseTo(100, 9);
    expect(yToValue(214, PLOT)).toBeCloseTo(0, 9);
    expect(yToValue(114, PLOT)).toBeCloseTo(50, 9);
    expect(yToValue(64, PLOT)).toBeCloseTo(75, 9);
    expect(yToValue(115, PLOT)).toBeCloseTo(49.5, 9);
  });

  it('yToValue is unclamped', () => {
    expect(yToValue(0, PLOT)).toBeCloseTo(107, 9);
    expect(yToValue(300, PLOT)).toBeCloseTo(-43, 9);
  });

  it('round-trips', () => {
    for (const value of [0, 1, 12, 33.3, 50, 99.9, 100]) {
      expect(yToValue(valueToY(value, PLOT), PLOT), String(value)).toBeCloseTo(value, 9);
    }
  });

  it('honours plot.y and plot.height', () => {
    const plot: PlotArea = { x: 0, y: 50, width: 100, height: 400 };
    expect(valueToY(100, plot)).toBeCloseTo(50, 9);
    expect(valueToY(0, plot)).toBeCloseTo(450, 9);
    expect(valueToY(25, plot)).toBeCloseTo(350, 9);
    expect(yToValue(350, plot)).toBeCloseTo(25, 9);
  });
});

describe('snapTime', () => {
  it('snaps to the nearest multiple of step', () => {
    expect(snapTime(1020, 5)).toBe(1020);
    expect(snapTime(1022, 5)).toBe(1020);
    expect(snapTime(1023, 5)).toBe(1025);
    expect(snapTime(2, 5)).toBe(0);
    expect(snapTime(3, 5)).toBe(5);
    expect(snapTime(1027, 15)).toBe(1020);
    expect(snapTime(1028, 15)).toBe(1035);
    expect(snapTime(1049, 60)).toBe(1020);
    expect(snapTime(1051, 60)).toBe(1080);
    expect(snapTime(0, 60)).toBe(0);
  });

  it('rounds half up (never to even)', () => {
    // 1025 / 10 = 102.5: half up -> 103 -> 1030 (banker's rounding would give 1020).
    expect(snapTime(1025, 10)).toBe(1030);
    expect(snapTime(1035, 10)).toBe(1040);
    expect(snapTime(1050, 60)).toBe(1080); // 17.5 h -> 18 h
    expect(snapTime(1022.5, 5)).toBe(1025);
    expect(snapTime(1027.5, 15)).toBe(1035);
    expect(snapTime(1022.5, 1)).toBe(1023);
    expect(snapTime(1022.4, 1)).toBe(1022);
    expect(snapTime(5, 10)).toBe(10);
    expect(snapTime(15, 10)).toBe(20);
    expect(snapTime(30, 60)).toBe(60);
    expect(snapTime(90, 60)).toBe(120);
  });

  it('wraps 1440 back to 0 (1439 -> 0 for step 5)', () => {
    expect(snapTime(1439, 5)).toBe(0);
    expect(snapTime(1438, 5)).toBe(0);
    expect(snapTime(1437, 5)).toBe(1435);
    expect(snapTime(1439, 1)).toBe(1439);
    expect(snapTime(1439.5, 1)).toBe(0);
    expect(snapTime(1425, 30)).toBe(0); // 47.5 -> 48 -> 1440 -> 0
    expect(snapTime(1410, 60)).toBe(0); // 23.5 h -> 24 h -> 0
    expect(snapTime(1440, 5)).toBe(0);
  });

  it('wraps with a positive modulo below 0', () => {
    expect(snapTime(-2, 5)).toBe(0);
    expect(snapTime(-3, 5)).toBe(1435);
    expect(snapTime(-1, 1)).toBe(1439);
  });

  it('always returns an integer multiple of step in [0, 1439] within step / 2 of the input', () => {
    for (const step of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]) {
      for (let m = 0; m < MINUTES_PER_DAY; m += 7) {
        const snapped = snapTime(m, step);
        const label = `${m} / ${step}`;
        expect(Number.isInteger(snapped), label).toBe(true);
        expect(snapped, label).toBeGreaterThanOrEqual(0);
        expect(snapped, label).toBeLessThan(MINUTES_PER_DAY);
        expect(snapped % step, label).toBe(0);
        const diff = Math.abs(snapped - m);
        expect(Math.min(diff, MINUTES_PER_DAY - diff), label).toBeLessThanOrEqual(step / 2);
      }
    }
  });
});

describe('clampValue', () => {
  it('rounds half up to an integer', () => {
    expect(clampValue(50)).toBe(50);
    expect(clampValue(50.4)).toBe(50);
    expect(clampValue(50.49)).toBe(50);
    expect(clampValue(50.5)).toBe(51);
    expect(clampValue(2.5)).toBe(3); // banker's rounding would give 2
    expect(clampValue(1.5)).toBe(2);
    expect(clampValue(99.5)).toBe(100);
  });

  it('clamps into [1, 100] after rounding', () => {
    expect(clampValue(0)).toBe(1);
    expect(clampValue(0.4)).toBe(1);
    expect(clampValue(0.5)).toBe(1);
    expect(clampValue(-10)).toBe(1);
    expect(clampValue(1)).toBe(1);
    expect(clampValue(100)).toBe(100);
    expect(clampValue(100.4)).toBe(100);
    expect(clampValue(100.5)).toBe(100);
    expect(clampValue(150)).toBe(100);
  });

  it('maps NaN to 1', () => {
    expect(clampValue(Number.NaN)).toBe(1);
  });
});

describe('clampKeyBetween', () => {
  const step = 5;

  it('clamps to the window when there are no neighbours', () => {
    expect(clampKeyBetween(500, null, null, step, WINDOW)).toBe(500);
    expect(clampKeyBetween(200, null, null, step, WINDOW)).toBe(300);
    expect(clampKeyBetween(1300, null, null, step, WINDOW)).toBe(1200);
    expect(clampKeyBetween(300, null, null, step, WINDOW)).toBe(300);
    expect(clampKeyBetween(1200, null, null, step, WINDOW)).toBe(1200);
  });

  it('keeps at least one step after the previous point', () => {
    expect(clampKeyBetween(700, 600, null, step, WINDOW)).toBe(700);
    expect(clampKeyBetween(605, 600, null, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(604, 600, null, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(600, 600, null, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(100, 600, null, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(1250, 600, null, step, WINDOW)).toBe(1200);
    // A previous point before the window: the window start wins (max).
    expect(clampKeyBetween(200, 100, null, step, WINDOW)).toBe(300);
    expect(clampKeyBetween(298, 296, null, step, WINDOW)).toBe(301);
  });

  it('keeps at least one step before the next point', () => {
    expect(clampKeyBetween(700, null, 900, step, WINDOW)).toBe(700);
    expect(clampKeyBetween(895, null, 900, step, WINDOW)).toBe(895);
    expect(clampKeyBetween(896, null, 900, step, WINDOW)).toBe(895);
    expect(clampKeyBetween(900, null, 900, step, WINDOW)).toBe(895);
    expect(clampKeyBetween(1400, null, 900, step, WINDOW)).toBe(895);
    expect(clampKeyBetween(250, null, 900, step, WINDOW)).toBe(300);
    // A next point after the window: the window end wins (min).
    expect(clampKeyBetween(1250, null, 1300, step, WINDOW)).toBe(1200);
    expect(clampKeyBetween(1202, null, 1204, step, WINDOW)).toBe(1199);
  });

  it('clamps between both neighbours', () => {
    expect(clampKeyBetween(700, 600, 900, step, WINDOW)).toBe(700);
    expect(clampKeyBetween(100, 600, 900, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(1400, 600, 900, step, WINDOW)).toBe(895);
    expect(clampKeyBetween(605, 600, 900, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(895, 600, 900, step, WINDOW)).toBe(895);
  });

  it('returns lower when lower > upper (neighbours closer than one step)', () => {
    // prev 600 + 5 = 605, next 605 - 5 = 600 -> lower > upper -> 605 whatever the key.
    expect(clampKeyBetween(602, 600, 605, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(100, 600, 605, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(1000, 600, 605, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(604, 600, 608, step, WINDOW)).toBe(605);
    // Driven by the window: prev + step beyond the end, next - step before the start.
    expect(clampKeyBetween(1000, 1198, null, step, WINDOW)).toBe(1203);
    expect(clampKeyBetween(1000, null, 302, step, WINDOW)).toBe(300);
    // lower === upper is a valid (degenerate) range.
    expect(clampKeyBetween(100, 600, 610, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(1000, 600, 610, step, WINDOW)).toBe(605);
  });

  it('uses the given step', () => {
    expect(clampKeyBetween(600, 600, null, 1, WINDOW)).toBe(601);
    expect(clampKeyBetween(600, 600, null, 15, WINDOW)).toBe(615);
    expect(clampKeyBetween(900, null, 900, 15, WINDOW)).toBe(885);
    expect(clampKeyBetween(600, 600, 630, 15, WINDOW)).toBe(615);
  });

  it('does not snap the result', () => {
    expect(clampKeyBetween(602.3, null, null, step, WINDOW)).toBe(602.3);
    expect(clampKeyBetween(602.3, 600, null, step, WINDOW)).toBe(605);
    expect(clampKeyBetween(607.7, 600, null, step, WINDOW)).toBe(607.7);
    expect(clampKeyBetween(700, 600.5, null, step, WINDOW)).toBe(700);
    expect(clampKeyBetween(600, 600.5, null, step, WINDOW)).toBe(605.5);
  });

  it('works with the full 12:00 -> 12:00 window', () => {
    expect(clampKeyBetween(-5, null, null, step, FULL_DAY)).toBe(0);
    expect(clampKeyBetween(1500, null, null, step, FULL_DAY)).toBe(1440);
    expect(clampKeyBetween(1440, null, null, step, FULL_DAY)).toBe(1440);
  });
});

describe('hourTicks', () => {
  const STEP_1 = [
    '17:00',
    '18:00',
    '19:00',
    '20:00',
    '21:00',
    '22:00',
    '23:00',
    '00:00',
    '01:00',
    '02:00',
    '03:00',
    '04:00',
    '05:00',
    '06:00',
    '07:00',
    '08:00',
  ].map(tick);
  const STEP_2 = ['18:00', '20:00', '22:00', '00:00', '02:00', '04:00', '06:00', '08:00'].map(tick);
  const STEP_3 = ['18:00', '21:00', '00:00', '03:00', '06:00'].map(tick);
  const STEP_4 = ['20:00', '00:00', '04:00', '08:00'].map(tick);
  const STEP_6 = ['18:00', '00:00', '06:00'].map(tick);

  it('uses a 1-hour step at exactly 44 px per hour (both window edges included)', () => {
    // 15 h window: 660 px / 15 h = 44 px/h.
    const ticks = hourTicks(WINDOW, plotOfWidth(660));
    expect(ticks).toEqual(STEP_1);
    expect(ticks).toHaveLength(16);
    expect(ticks[0]).toEqual({ key: 300, minutes: 1020, label: '17h' });
    expect(ticks[15]).toEqual({ key: 1200, minutes: 480, label: '8h' });
    expect(hourTicks(WINDOW, PLOT)).toEqual(STEP_1);
  });

  it('switches to a 2-hour step just below 44 px per hour, on even hours', () => {
    // 659 / 15 = 43.93 < 44, 2 * 43.93 >= 44.
    const ticks = hourTicks(WINDOW, plotOfWidth(659));
    expect(ticks).toEqual(STEP_2);
    expect(ticks.map((t) => t.label)).toEqual(['18h', '20h', '22h', '0h', '2h', '4h', '6h', '8h']);
    // The window start (17h, odd) is not a tick even though it is inside the window.
    expect(ticks.some((t) => t.label === '17h')).toBe(false);
  });

  it('keeps the 2-hour step down to exactly 22 px per hour', () => {
    expect(hourTicks(WINDOW, plotOfWidth(330))).toEqual(STEP_2); // 22 px/h * 2 = 44
    expect(hourTicks(WINDOW, plotOfWidth(450))).toEqual(STEP_2); // 30 px/h
  });

  it('switches to a 3-hour step just below 22 px per hour, on multiples of 3', () => {
    expect(hourTicks(WINDOW, plotOfWidth(329))).toEqual(STEP_3); // 21.93 * 2 < 44, * 3 >= 44
    expect(hourTicks(WINDOW, plotOfWidth(225))).toEqual(STEP_3); // 15 px/h * 3 = 45
    expect(hourTicks(WINDOW, plotOfWidth(225)).map((t) => t.label)).toEqual([
      '18h',
      '21h',
      '0h',
      '3h',
      '6h',
    ]);
  });

  it('switches to a 4-hour step at exactly 11 px per hour, on multiples of 4', () => {
    expect(hourTicks(WINDOW, plotOfWidth(219))).toEqual(STEP_4); // 14.6 * 3 < 44, * 4 >= 44
    expect(hourTicks(WINDOW, plotOfWidth(165))).toEqual(STEP_4); // 11 px/h * 4 = 44
    expect(hourTicks(WINDOW, plotOfWidth(165)).map((t) => t.label)).toEqual([
      '20h',
      '0h',
      '4h',
      '8h',
    ]);
  });

  it('switches to a 6-hour step below 11 px per hour and keeps it when nothing fits', () => {
    expect(hourTicks(WINDOW, plotOfWidth(164))).toEqual(STEP_6); // 10.93 * 4 < 44, * 6 >= 44
    expect(hourTicks(WINDOW, plotOfWidth(120))).toEqual(STEP_6); // 8 px/h * 6 = 48
    expect(hourTicks(WINDOW, plotOfWidth(30))).toEqual(STEP_6); // 2 px/h * 6 = 12 < 44 -> 6 anyway
    expect(hourTicks(WINDOW, plotOfWidth(30)).map((t) => t.label)).toEqual(['18h', '0h', '6h']);
  });

  it('only depends on width / span, not on plot.x', () => {
    const shifted: PlotArea = { x: 500, y: 100, width: 660, height: 50 };
    expect(hourTicks(WINDOW, shifted)).toEqual(STEP_1);
  });

  it('skips a non-hour window start and end', () => {
    // 17:30 (key 330) -> 07:30 (key 1170): 18h ... 7h.
    const window = makeWindow('17:30', '07:30');
    const ticks = hourTicks(window, { x: 0, y: 0, width: 1400, height: 100 }); // 100 px/h
    expect(ticks).toHaveLength(14);
    expect(ticks[0]).toEqual(tick('18:00'));
    expect(ticks[13]).toEqual(tick('07:00'));
  });

  it('covers the full 12:00 -> 12:00 day including the end key 1440', () => {
    const ticks = hourTicks(FULL_DAY, { x: 0, y: 0, width: 1440, height: 100 }); // 60 px/h
    expect(ticks).toHaveLength(25);
    expect(ticks[0]).toEqual({ key: 0, minutes: 720, label: '12h' });
    expect(ticks[11]).toEqual({ key: 660, minutes: 1380, label: '23h' });
    expect(ticks[12]).toEqual({ key: 720, minutes: 0, label: '0h' });
    expect(ticks[23]).toEqual({ key: 1380, minutes: 660, label: '11h' });
    expect(ticks[24]).toEqual({ key: 1440, minutes: 720, label: '12h' });
    // 200 px / 24 h = 8.33 px/h: 4 * 8.33 < 44, 6 * 8.33 >= 44 -> 6-hour step.
    expect(hourTicks(FULL_DAY, { x: 0, y: 0, width: 200, height: 100 })).toEqual([
      { key: 0, minutes: 720, label: '12h' },
      { key: 360, minutes: 1080, label: '18h' },
      { key: 720, minutes: 0, label: '0h' },
      { key: 1080, minutes: 360, label: '6h' },
      { key: 1440, minutes: 720, label: '12h' },
    ]);
  });

  it('returns consistent, increasing, evenly spaced ticks for every width', () => {
    for (let width = 30; width <= 1200; width += 13) {
      const ticks = hourTicks(WINDOW, plotOfWidth(width));
      expect(ticks.length, String(width)).toBeGreaterThan(0);
      const stepMinutes = [60, 120, 180, 240, 360];
      const first = ticks[0];
      const second = ticks[1];
      const gapMinutes = first !== undefined && second !== undefined ? second.key - first.key : 0;
      for (const [i, t] of ticks.entries()) {
        const label = `${width}px #${i}`;
        expect(t.key % 60, label).toBe(0);
        expect(t.key, label).toBeGreaterThanOrEqual(WINDOW.startKey);
        expect(t.key, label).toBeLessThanOrEqual(WINDOW.endKey);
        expect(t.minutes, label).toBe((t.key + 720) % MINUTES_PER_DAY);
        expect(t.label, label).toBe(`${Math.floor(t.minutes / 60)}h`);
        expect(t.label, label).toMatch(/^(?:[0-9]|1[0-9]|2[0-3])h$/);
        const previous = ticks[i - 1];
        if (previous !== undefined) {
          expect(t.key - previous.key, label).toBe(gapMinutes);
          expect(stepMinutes, label).toContain(t.key - previous.key);
        }
      }
      // The step guarantees at least 44 px between labels unless even 6 h cannot provide it.
      if (gapMinutes > 0 && gapMinutes < 360) {
        expect((gapMinutes / 900) * width, String(width)).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

describe('polylineNodes', () => {
  const defaultPoints = parseCurve(DEFAULT_CURVE);

  it('adds flat extensions to both window edges when the curve lies inside the window', () => {
    expect(polylineNodes(defaultPoints, WINDOW)).toEqual([
      { key: 300, value: 100 },
      node('19:00', 100),
      node('21:00', 70),
      node('22:30', 30),
      node('23:30', 12),
      { key: 1200, value: 12 },
    ]);
  });

  it('adds only the end extension when the first point sits on the window start', () => {
    expect(polylineNodes([point('17:00', 80), point('21:00', 40)], WINDOW)).toEqual([
      { key: 300, value: 80 },
      { key: 540, value: 40 },
      { key: 1200, value: 40 },
    ]);
  });

  it('adds only the start extension when the last point sits on the window end', () => {
    expect(polylineNodes([point('19:00', 100), point('08:00', 20)], WINDOW)).toEqual([
      { key: 300, value: 100 },
      { key: 420, value: 100 },
      { key: 1200, value: 20 },
    ]);
  });

  it('adds no extension when the points sit on both window edges', () => {
    expect(polylineNodes([point('17:00', 80), point('08:00', 20)], WINDOW)).toEqual([
      { key: 300, value: 80 },
      { key: 1200, value: 20 },
    ]);
  });

  it('keeps points outside the window and skips the extension on that side', () => {
    expect(polylineNodes([point('16:00', 90), point('21:00', 40)], WINDOW)).toEqual([
      { key: 240, value: 90 },
      { key: 540, value: 40 },
      { key: 1200, value: 40 },
    ]);
    expect(polylineNodes([point('19:00', 100), point('09:00', 5)], WINDOW)).toEqual([
      { key: 300, value: 100 },
      { key: 420, value: 100 },
      { key: 1260, value: 5 },
    ]);
    expect(polylineNodes([point('16:00', 90), point('09:00', 5)], WINDOW)).toEqual([
      { key: 240, value: 90 },
      { key: 1260, value: 5 },
    ]);
  });

  it('sorts the points along the curve day and does not mutate the input', () => {
    const reversed = [...defaultPoints].reverse();
    const snapshot = reversed.map((p) => ({ ...p }));
    expect(polylineNodes(reversed, WINDOW)).toEqual(polylineNodes(defaultPoints, WINDOW));
    expect(reversed).toEqual(snapshot);
    // Crossing midnight: 23:00 (key 660) comes before 01:00 (key 780).
    expect(polylineNodes([point('01:00', 10), point('23:00', 40)], WINDOW)).toEqual([
      { key: 300, value: 40 },
      { key: 660, value: 40 },
      { key: 780, value: 10 },
      { key: 1200, value: 10 },
    ]);
  });

  it('handles the full 12:00 -> 12:00 window', () => {
    expect(polylineNodes([point('12:00', 50), point('11:59', 60)], FULL_DAY)).toEqual([
      { key: 0, value: 50 },
      { key: 1439, value: 60 },
      { key: 1440, value: 60 },
    ]);
  });

  it('throws a RangeError for an invalid curve', () => {
    expect(() => polylineNodes([], WINDOW)).toThrow(RangeError);
    expect(() => polylineNodes([point('19:00', 100)], WINDOW)).toThrow(RangeError);
  });
});

describe('curvePath', () => {
  it('draws "M x y L x y" with integer coordinates', () => {
    // 17:00@80 -> (34, 14 + 40) ; 08:00@20 -> (934, 14 + 160).
    expect(curvePath([point('17:00', 80), point('08:00', 20)], WINDOW, PLOT)).toBe(
      'M 34 54 L 934 174',
    );
  });

  it('includes the flat extensions of polylineNodes', () => {
    // Keys 300, 420, 540, 630, 690, 1200 -> x 34, 154, 274, 364, 424, 934;
    // values 100, 100, 70, 30, 12, 12 -> y 14, 14, 74, 154, 190, 190.
    expect(curvePath(parseCurve(DEFAULT_CURVE), WINDOW, PLOT)).toBe(
      'M 34 14 L 154 14 L 274 74 L 364 154 L 424 190 L 934 190',
    );
  });

  it('formats numbers with at most 2 decimals', () => {
    // 300 px / 900 min = 1/3 px per minute, 1.5 px per percent.
    const plot: PlotArea = { x: 34, y: 14, width: 300, height: 150 };
    const points = [point('17:00', 80), point('19:01', 33), point('19:02', 33), point('08:00', 20)];
    // x: 34, 34 + 121/3 = 74.333, 34 + 122/3 = 74.667, 334 ; y: 44, 114.5, 114.5, 134.
    expect(curvePath(points, WINDOW, plot)).toBe('M 34 44 L 74.33 114.5 L 74.67 114.5 L 334 134');
  });

  it('drops trailing zeros', () => {
    // 90 px / 900 min = 0.1 px per minute; height 100 -> y = 100 - value.
    const plot: PlotArea = { x: 0, y: 0, width: 90, height: 100 };
    const points = [point('17:01', 50), point('17:10', 50)];
    expect(curvePath(points, WINDOW, plot)).toBe('M 0 50 L 0.1 50 L 1 50 L 90 50');
  });

  it('keeps points outside the window (negative x)', () => {
    // 16:00@90 -> key 240 -> x -26, y 34 ; 21:00@40 -> (274, 134) ; extension (934, 134).
    expect(curvePath([point('16:00', 90), point('21:00', 40)], WINDOW, PLOT)).toBe(
      'M -26 34 L 274 134 L 934 134',
    );
  });

  it('throws a RangeError for an invalid curve', () => {
    expect(() => curvePath([], WINDOW, PLOT)).toThrow(RangeError);
    expect(() => curvePath([point('19:00', 100)], WINDOW, PLOT)).toThrow(RangeError);
  });
});

describe('areaPath', () => {
  it('closes the curve path down to the 0 % baseline', () => {
    expect(areaPath([point('17:00', 80), point('08:00', 20)], WINDOW, PLOT)).toBe(
      'M 34 54 L 934 174 L 934 214 L 34 214 Z',
    );
    expect(areaPath(parseCurve(DEFAULT_CURVE), WINDOW, PLOT)).toBe(
      'M 34 14 L 154 14 L 274 74 L 364 154 L 424 190 L 934 190 L 934 214 L 34 214 Z',
    );
  });

  it('uses the first and last node x, even outside the plot', () => {
    expect(areaPath([point('16:00', 90), point('21:00', 40)], WINDOW, PLOT)).toBe(
      'M -26 34 L 274 134 L 934 134 L 934 214 L -26 214 Z',
    );
  });

  it('formats like curvePath', () => {
    const plot: PlotArea = { x: 0, y: 0, width: 90, height: 100 };
    const points = [point('17:01', 50), point('17:10', 50)];
    expect(areaPath(points, WINDOW, plot)).toBe(
      'M 0 50 L 0.1 50 L 1 50 L 90 50 L 90 100 L 0 100 Z',
    );
  });

  it('starts with the curve path', () => {
    const points = parseCurve(DEFAULT_CURVE);
    const curve = curvePath(points, WINDOW, PLOT);
    const area = areaPath(points, WINDOW, PLOT);
    expect(area.startsWith(curve)).toBe(true);
    expect(area.slice(curve.length)).toBe(' L 934 214 L 34 214 Z');
  });

  it('throws a RangeError for an invalid curve', () => {
    expect(() => areaPath([], WINDOW, PLOT)).toThrow(RangeError);
    expect(() => areaPath([point('19:00', 100)], WINDOW, PLOT)).toThrow(RangeError);
  });
});

describe('isKeyVisible', () => {
  it('is inclusive on both bounds', () => {
    expect(isKeyVisible(300, WINDOW)).toBe(true);
    expect(isKeyVisible(1200, WINDOW)).toBe(true);
    expect(isKeyVisible(750, WINDOW)).toBe(true);
    expect(isKeyVisible(299, WINDOW)).toBe(false);
    expect(isKeyVisible(1201, WINDOW)).toBe(false);
    expect(isKeyVisible(299.99, WINDOW)).toBe(false);
    expect(isKeyVisible(0, WINDOW)).toBe(false);
    expect(isKeyVisible(1440, WINDOW)).toBe(false);
  });

  it('works with the full 12:00 -> 12:00 window', () => {
    expect(isKeyVisible(0, FULL_DAY)).toBe(true);
    expect(isKeyVisible(1440, FULL_DAY)).toBe(true);
    expect(isKeyVisible(-1, FULL_DAY)).toBe(false);
    expect(isKeyVisible(1441, FULL_DAY)).toBe(false);
  });

  it('agrees with keyToX landing inside the plot', () => {
    for (const key of [200, 300, 301, 750, 1199, 1200, 1201, 1440]) {
      const x = keyToX(key, WINDOW, PLOT);
      const inside = x >= PLOT.x - 1e-9 && x <= PLOT.x + PLOT.width + 1e-9;
      expect(isKeyVisible(key, WINDOW), String(key)).toBe(inside);
    }
  });
});
