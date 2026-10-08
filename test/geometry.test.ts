/**
 * Tests for src/core/geometry.ts (M2 spec, sections 1 and 6): window construction, the
 * key/time <-> x and value <-> y mappings (including a window that crosses midnight), snapping,
 * clamping between neighbours, hour ticks, polyline nodes / SVG paths and visibility.
 */
import { describe, expect, it } from 'vitest';
import { maxPointsFor, parseTime, sortKey, type CurvePoint } from '../src/core/curve.js';
import {
  BRIGHTNESS_AXIS,
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
  stepValue,
  timeToX,
  valueAxis,
  valueToY,
  xToKey,
  xToTime,
  yToValue,
  type PlotArea,
  type TimeWindow,
} from '../src/core/geometry.js';

/** Parses an `HH:MM` time, failing loudly instead of returning null. */
function minutesOf(time: string): number {
  const minutes = parseTime(time);
  if (minutes === null) throw new Error(`test time "${time}" is not HH:MM`);
  return minutes;
}

/** Builds a point from an `HH:MM` time and a value. */
function point(time: string, value: number): CurvePoint {
  return { time: minutesOf(time), value };
}

/** sortKey of an `HH:MM` time. */
function keyOf(time: string): number {
  return sortKey(minutesOf(time));
}

/** The default window: 17:00 (key 300) -> 08:00 (key 1200), 15 hours across midnight. */
const WINDOW: TimeWindow = makeWindow('17:00', '08:00');

/** A realistic plot area: a 500 px wide card with a 34 px left and a 14 px right margin. */
const PLOT: PlotArea = { x: 34, y: 14, width: 452, height: 142 };

/** A plot where 1 px = 1 key for WINDOW (900 keys) and 1 px = 1 % on the value axis. */
const UNIT_PLOT: PlotArea = { x: 0, y: 0, width: 900, height: 100 };

/** Plot area whose width gives the requested pixels per hour for WINDOW (15 hours). */
function plotWithPixelsPerHour(pixelsPerHour: number): PlotArea {
  return { x: 0, y: 0, width: pixelsPerHour * 15, height: 100 };
}

describe('constants', () => {
  it('exposes the documented defaults and limits', () => {
    expect(DEFAULT_WINDOW_START).toBe('17:00');
    expect(DEFAULT_WINDOW_END).toBe('08:00');
    expect(DEFAULT_SNAP_MINUTES).toBe(5);
    expect(DEFAULT_MAX_POINTS).toBe(12);
    // The max_points bound is per range now (src/core/curve.ts): 25 for brightness.
    expect(maxPointsFor()).toBe(25);
    expect(CURVE_DAY_END_KEY).toBe(1440);
    expect(BRIGHTNESS_AXIS).toEqual({ min: 0, max: 100 });
  });
});

describe('value ranges (presets and custom ranges)', () => {
  const TEMPERATURE = { min: 5, max: 30, step: 0.5 };
  const COLOR_TEMP = { min: 2000, max: 6500, step: 50 };
  const OFFSET = { min: -5, max: 5, step: 0.25 };

  it('valueAxis: brightness keeps its 0 / 25 / 50 / 75 / 100 gridlines', () => {
    expect(valueAxis()).toEqual({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(valueAxis({ min: 1, max: 100, step: 1 })).toEqual(valueAxis());
  });

  it('valueAxis: nice bounds with 4 to 6 intervals of {1, 2, 2.5, 5} x 10^n', () => {
    expect(valueAxis(TEMPERATURE)).toEqual({ min: 5, max: 30, ticks: [5, 10, 15, 20, 25, 30] });
    expect(valueAxis(COLOR_TEMP)).toEqual({
      min: 2000,
      max: 7000,
      ticks: [2000, 3000, 4000, 5000, 6000, 7000],
    });
    expect(valueAxis(OFFSET)).toEqual({ min: -5, max: 5, ticks: [-5, -2.5, 0, 2.5, 5] });
    expect(valueAxis({ min: 0.1, max: 0.9, step: 0.01 })).toEqual({
      min: 0,
      max: 1,
      ticks: [0, 0.25, 0.5, 0.75, 1],
    });
    expect(valueAxis({ min: 16, max: 24, step: 0.1 })).toEqual({
      min: 16,
      max: 24,
      ticks: [16, 18, 20, 22, 24],
    });
    expect(valueAxis({ min: -9999.99, max: 9999.99, step: 0.01 }).ticks).toEqual([
      -10000, -5000, 0, 5000, 10000,
    ]);
    // Every axis covers its range, with 4 to 6 evenly spaced intervals.
    for (const range of [TEMPERATURE, COLOR_TEMP, OFFSET, { min: 0, max: 41, step: 1 }]) {
      const axis = valueAxis(range);
      expect(axis.min).toBeLessThanOrEqual(range.min);
      expect(axis.max).toBeGreaterThanOrEqual(range.max);
      expect(axis.ticks.length - 1).toBeGreaterThanOrEqual(4);
      expect(axis.ticks.length - 1).toBeLessThanOrEqual(6);
      expect(axis.ticks[0]).toBe(axis.min);
      expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
    }
  });

  it('valueToY / yToValue map a custom axis domain', () => {
    const domain = { min: 5, max: 30 };
    expect(valueToY(30, UNIT_PLOT, domain)).toBe(0);
    expect(valueToY(5, UNIT_PLOT, domain)).toBe(100);
    expect(valueToY(17.5, UNIT_PLOT, domain)).toBe(50);
    expect(yToValue(25, UNIT_PLOT, domain)).toBe(23.75);
    expect(
      yToValue(valueToY(-2.5, PLOT, { min: -5, max: 5 }), PLOT, { min: -5, max: 5 }),
    ).toBeCloseTo(-2.5, 9);
  });

  it('areaPath closes down to the bottom of the axis domain', () => {
    const curve = [point('19:00', 4000), point('23:00', 2200)];
    const domain = { min: 2000, max: 7000 };
    expect(areaPath(curve, WINDOW, UNIT_PLOT, domain)).toBe(
      `${curvePath(curve, WINDOW, UNIT_PLOT, domain)} L 900 100 L 0 100 Z`,
    );
    expect(curvePath(curve, WINDOW, UNIT_PLOT, domain)).toBe('M 0 60 L 120 60 L 360 96 L 900 96');
  });

  it('clampValue snaps to the step (half up, exact) and clamps to the range', () => {
    expect(clampValue(19.3, TEMPERATURE)).toBe(19.5);
    expect(clampValue(19.2, TEMPERATURE)).toBe(19);
    expect(clampValue(19.25, TEMPERATURE)).toBe(19.5);
    expect(clampValue(19.24, TEMPERATURE)).toBe(19);
    expect(clampValue(4, TEMPERATURE)).toBe(5);
    expect(clampValue(31, TEMPERATURE)).toBe(30);
    expect(clampValue(Number.NaN, TEMPERATURE)).toBe(5);
    expect(clampValue(Infinity, TEMPERATURE)).toBe(30);
    expect(clampValue(2724, COLOR_TEMP)).toBe(2700);
    expect(clampValue(2725, COLOR_TEMP)).toBe(2750);
    expect(clampValue(-0.125, OFFSET)).toBe(0);
    expect(clampValue(-0.13, OFFSET)).toBe(-0.25);
    expect(clampValue(-5.2, OFFSET)).toBe(-5);
    // A bound off the step grid stays reachable.
    expect(clampValue(30.25, { min: 5, max: 30.25, step: 0.5 })).toBe(30.25);
    expect(clampValue(40, { min: 5, max: 30.25, step: 0.5 })).toBe(30.25);
  });

  it('stepValue moves by whole steps from the grid, off-grid values first to the grid', () => {
    expect(stepValue(50, 1)).toBe(51);
    expect(stepValue(50, -5)).toBe(45);
    expect(stepValue(100, 1)).toBe(100);
    expect(stepValue(1, -1)).toBe(1);
    expect(stepValue(19.5, 1, TEMPERATURE)).toBe(20);
    expect(stepValue(19.5, 5, TEMPERATURE)).toBe(22);
    expect(stepValue(19.25, 1, TEMPERATURE)).toBe(19.5);
    expect(stepValue(19.25, -1, TEMPERATURE)).toBe(19);
    expect(stepValue(29.5, 5, TEMPERATURE)).toBe(30);
    expect(stepValue(2700, -1, COLOR_TEMP)).toBe(2650);
    expect(stepValue(-0.25, 1, OFFSET)).toBe(0);
    expect(stepValue(0, -1, OFFSET)).toBe(-0.25);
    expect(stepValue(19.3, 0, TEMPERATURE)).toBe(19.5);
  });
});

describe('makeWindow', () => {
  it('builds the default window 17:00 -> 08:00 as keys 300 -> 1200', () => {
    expect(makeWindow(DEFAULT_WINDOW_START, DEFAULT_WINDOW_END)).toEqual({
      startKey: 300,
      endKey: 1200,
    });
  });

  it('maps a 12:00 end to key 1440 (end of the curve day)', () => {
    expect(makeWindow('17:00', '12:00')).toEqual({ startKey: 300, endKey: 1440 });
  });

  it('maps a 12:00 start to key 0', () => {
    expect(makeWindow('12:00', '08:00')).toEqual({ startKey: 0, endKey: 1200 });
  });

  it('accepts 12:00 -> 12:00 as the whole curve day', () => {
    expect(makeWindow('12:00', '12:00')).toEqual({ startKey: 0, endKey: 1440 });
  });

  it('accepts a window that does not cross midnight', () => {
    expect(makeWindow('18:00', '23:30')).toEqual({ startKey: 360, endKey: 690 });
  });

  it('accepts a window entirely after midnight', () => {
    expect(makeWindow('01:00', '11:59')).toEqual({ startKey: 780, endKey: 1439 });
  });

  it('accepts a 1-digit hour', () => {
    expect(makeWindow('9:00', '11:00')).toEqual({ startKey: 1260, endKey: 1380 });
  });

  it.each(['', '17', '17:0', '25:00', '17:60', ' 17:00', '17:00:00', '5pm', 'abc'])(
    'rejects an invalid window_start %j with a French message',
    (start) => {
      expect(() => makeWindow(start, '08:00')).toThrow(
        new Error('window_start invalide : attendu HH:MM'),
      );
    },
  );

  it.each(['', '8', '24:00', '08:60', '08:00 ', 'x'])(
    'rejects an invalid window_end %j with a French message',
    (end) => {
      expect(() => makeWindow('17:00', end)).toThrow(
        new Error('window_end invalide : attendu HH:MM'),
      );
    },
  );

  it('reports the start before checking the end when both are invalid', () => {
    expect(() => makeWindow('x', 'y')).toThrow(/window_start invalide/);
  });

  it('rejects a start after the end in the curve day', () => {
    expect(() => makeWindow('08:00', '17:00')).toThrow(
      new Error(
        'window_start (08:00) doit précéder window_end (17:00) dans la journée 12:00 → 12:00',
      ),
    );
  });

  it('rejects a start equal to the end', () => {
    expect(() => makeWindow('17:00', '17:00')).toThrow(
      new Error(
        'window_start (17:00) doit précéder window_end (17:00) dans la journée 12:00 → 12:00',
      ),
    );
  });

  it('rejects a start after a 11:59 end and echoes zero-padded times', () => {
    expect(() => makeWindow('11:59', '9:00')).toThrow(
      /window_start \(11:59\).*window_end \(09:00\)/,
    );
  });

  it('rejects a 12:00 start with an end before it only when the end is not 12:00', () => {
    // 12:00 as start is key 0: every end except 12:00 itself (key 1440) follows it.
    expect(() => makeWindow('12:00', '12:01')).not.toThrow();
    expect(() => makeWindow('12:01', '12:00')).not.toThrow();
  });
});

describe('keyToX / xToKey', () => {
  it('maps the window edges to the plot edges', () => {
    expect(keyToX(WINDOW.startKey, WINDOW, PLOT)).toBe(PLOT.x);
    expect(keyToX(WINDOW.endKey, WINDOW, PLOT)).toBe(PLOT.x + PLOT.width);
  });

  it('is linear inside the window', () => {
    // 300 -> 1200 is 900 keys; key 750 is at exactly half the width.
    expect(keyToX(750, WINDOW, PLOT)).toBeCloseTo(PLOT.x + PLOT.width / 2, 10);
    expect(keyToX(525, WINDOW, PLOT)).toBeCloseTo(PLOT.x + PLOT.width / 4, 10);
  });

  it('extrapolates outside the window without clamping', () => {
    expect(keyToX(0, WINDOW, PLOT)).toBeLessThan(PLOT.x);
    expect(keyToX(1440, WINDOW, PLOT)).toBeGreaterThan(PLOT.x + PLOT.width);
    expect(keyToX(0, WINDOW, UNIT_PLOT)).toBe(-300);
    expect(keyToX(1440, WINDOW, UNIT_PLOT)).toBe(1140);
  });

  it('xToKey maps the plot edges to the window edges', () => {
    expect(xToKey(PLOT.x, WINDOW, PLOT)).toBe(WINDOW.startKey);
    expect(xToKey(PLOT.x + PLOT.width, WINDOW, PLOT)).toBe(WINDOW.endKey);
  });

  it('xToKey is unclamped outside the plot', () => {
    expect(xToKey(-300, WINDOW, UNIT_PLOT)).toBe(0);
    expect(xToKey(1140, WINDOW, UNIT_PLOT)).toBe(1440);
    expect(xToKey(-600, WINDOW, UNIT_PLOT)).toBe(-300);
  });

  it.each([0, 1, 299, 300, 301, 333, 719, 720, 721, 1199, 1200, 1201, 1440])(
    'round-trips key %i through keyToX / xToKey',
    (key) => {
      expect(xToKey(keyToX(key, WINDOW, PLOT), WINDOW, PLOT)).toBeCloseTo(key, 9);
    },
  );

  it('round-trips an x through xToKey / keyToX', () => {
    for (let x = 0; x <= 520; x += 7) {
      expect(keyToX(xToKey(x, WINDOW, PLOT), WINDOW, PLOT)).toBeCloseTo(x, 9);
    }
  });
});

describe('timeToX / xToTime across midnight', () => {
  it('maps 17:00 to the plot left edge and 08:00 to the right edge', () => {
    expect(timeToX(minutesOf('17:00'), WINDOW, PLOT)).toBe(PLOT.x);
    expect(timeToX(minutesOf('08:00'), WINDOW, PLOT)).toBe(PLOT.x + PLOT.width);
  });

  it('maps 00:00 to exactly 7/15 of the width (7 of the 15 hours elapsed)', () => {
    expect(timeToX(minutesOf('00:00'), WINDOW, PLOT)).toBeCloseTo(
      PLOT.x + (PLOT.width * 7) / 15,
      10,
    );
    expect(timeToX(0, WINDOW, UNIT_PLOT)).toBe(420);
  });

  it('keeps late-night times before morning times', () => {
    const x2330 = timeToX(minutesOf('23:30'), WINDOW, PLOT);
    const x0030 = timeToX(minutesOf('00:30'), WINDOW, PLOT);
    const x0700 = timeToX(minutesOf('07:00'), WINDOW, PLOT);
    expect(x2330).toBeLessThan(x0030);
    expect(x0030).toBeLessThan(x0700);
  });

  it('places times outside the window outside the plot (late morning after the right edge)', () => {
    expect(timeToX(minutesOf('11:00'), WINDOW, PLOT)).toBeGreaterThan(PLOT.x + PLOT.width);
    expect(timeToX(minutesOf('16:00'), WINDOW, PLOT)).toBeLessThan(PLOT.x);
  });

  it('xToTime maps the plot edges to 17:00 and 08:00', () => {
    expect(xToTime(PLOT.x, WINDOW, PLOT)).toBe(minutesOf('17:00'));
    expect(xToTime(PLOT.x + PLOT.width, WINDOW, PLOT)).toBe(minutesOf('08:00'));
  });

  it('xToTime maps a key of 1440 (window end at 12:00) to 720', () => {
    const fullDay = makeWindow('12:00', '12:00');
    expect(xToTime(PLOT.x + PLOT.width, fullDay, PLOT)).toBe(720);
    expect(xToTime(PLOT.x, fullDay, PLOT)).toBe(720);
  });

  it('xToTime wraps keys outside the window into [0, 1440)', () => {
    // x = -300 on the unit plot is key 0 -> 12:00; x = -600 is key -300 -> 07:00.
    expect(xToTime(-300, WINDOW, UNIT_PLOT)).toBe(720);
    expect(xToTime(-600, WINDOW, UNIT_PLOT)).toBe(minutesOf('07:00'));
    expect(xToTime(1500, WINDOW, UNIT_PLOT)).toBe(minutesOf('18:00'));
  });

  it('xToTime is fractional between two minutes', () => {
    // One px is 900 / 452 keys on PLOT, so half a px is not an integer minute.
    const time = xToTime(PLOT.x + 0.5, WINDOW, PLOT);
    expect(Number.isInteger(time)).toBe(false);
    expect(time).toBeGreaterThan(minutesOf('17:00'));
    expect(time).toBeLessThan(minutesOf('17:01'));
  });

  it.each(['00:00', '00:01', '07:59', '08:00', '11:59', '12:00', '12:01', '17:00', '23:59'])(
    'round-trips %s through timeToX / xToTime',
    (time) => {
      const minutes = minutesOf(time);
      const roundTrip = xToTime(timeToX(minutes, WINDOW, PLOT), WINDOW, PLOT);
      // Distance on the circle of the day: 00:00 may come back as 1439.999... after wrapping.
      const distance = Math.abs(roundTrip - minutes);
      expect(Math.min(distance, 1440 - distance)).toBeLessThan(1e-6);
    },
  );
});

describe('valueToY / yToValue', () => {
  it('maps 100 to the top and 0 to the bottom of the plot', () => {
    expect(valueToY(100, PLOT)).toBe(PLOT.y);
    expect(valueToY(0, PLOT)).toBe(PLOT.y + PLOT.height);
  });

  it('is linear', () => {
    expect(valueToY(50, PLOT)).toBe(PLOT.y + PLOT.height / 2);
    expect(valueToY(75, PLOT)).toBe(PLOT.y + PLOT.height / 4);
    expect(valueToY(10, UNIT_PLOT)).toBe(90);
  });

  it('yToValue maps the plot edges to 100 and 0', () => {
    expect(yToValue(PLOT.y, PLOT)).toBe(100);
    expect(yToValue(PLOT.y + PLOT.height, PLOT)).toBe(0);
    expect(yToValue(PLOT.y + PLOT.height / 2, PLOT)).toBe(50);
  });

  it('is unclamped outside the plot', () => {
    expect(valueToY(120, UNIT_PLOT)).toBe(-20);
    expect(valueToY(-10, UNIT_PLOT)).toBe(110);
    expect(yToValue(-20, UNIT_PLOT)).toBe(120);
    expect(yToValue(110, UNIT_PLOT)).toBe(-10);
    expect(yToValue(PLOT.y - 5, PLOT)).toBeGreaterThan(100);
  });

  it.each([0, 1, 33, 50, 99, 100, 150, -7])('round-trips value %i', (value) => {
    expect(yToValue(valueToY(value, PLOT), PLOT)).toBeCloseTo(value, 9);
  });

  it('round-trips a y through yToValue / valueToY', () => {
    for (let y = 0; y <= 180; y += 3) {
      expect(valueToY(yToValue(y, PLOT), PLOT)).toBeCloseTo(y, 9);
    }
  });
});

describe('snapTime', () => {
  it('rounds to the nearest multiple of the step', () => {
    expect(snapTime(1002, 5)).toBe(1000);
    expect(snapTime(1003, 5)).toBe(1005);
    expect(snapTime(1000, 5)).toBe(1000);
    expect(snapTime(1017, 15)).toBe(1020);
    expect(snapTime(1007, 15)).toBe(1005);
    expect(snapTime(1029, 30)).toBe(1020);
    expect(snapTime(1031, 30)).toBe(1020);
  });

  it('rounds half up', () => {
    expect(snapTime(1002.5, 5)).toBe(1005);
    expect(snapTime(1002.4999, 5)).toBe(1000);
    expect(snapTime(1002.5, 1)).toBe(1003);
    expect(snapTime(1005, 10)).toBe(1010);
    expect(snapTime(1015, 30)).toBe(1020);
    expect(snapTime(1050, 60)).toBe(1080);
  });

  it('keeps integer minutes unchanged with a step of 1 and rounds fractions', () => {
    expect(snapTime(1439, 1)).toBe(1439);
    expect(snapTime(0.4, 1)).toBe(0);
    expect(snapTime(0.5, 1)).toBe(1);
  });

  it('wraps 1439 to 0 for a step of 5 (and other values past the day end)', () => {
    expect(snapTime(1439, 5)).toBe(0);
    expect(snapTime(1438, 5)).toBe(0);
    expect(snapTime(1437, 5)).toBe(1435);
    expect(snapTime(1439.9, 1)).toBe(0);
    expect(snapTime(1432.5, 15)).toBe(0);
    expect(snapTime(1440, 5)).toBe(0);
  });

  it('wraps negative candidates with a positive modulo', () => {
    expect(snapTime(-2, 5)).toBe(0);
    expect(snapTime(-3, 5)).toBe(1435);
    expect(snapTime(-1, 1)).toBe(1439);
  });

  it.each([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60])(
    'always returns a multiple of the step %i inside [0, 1439]',
    (step) => {
      for (let minutes = -30; minutes < 1500; minutes += 7.3) {
        const snapped = snapTime(minutes, step);
        expect(snapped % step).toBe(0);
        expect(snapped).toBeGreaterThanOrEqual(0);
        expect(snapped).toBeLessThanOrEqual(1439);
      }
    },
  );

  it.each([0, -5, 7, 8, 9, 2.5, 120, NaN, Infinity])(
    'rejects a step of %s that is not a positive integer dividing 60',
    (step) => {
      expect(() => snapTime(600, step)).toThrow(RangeError);
    },
  );

  it.each([NaN, Infinity, -Infinity])('rejects non-finite minutes (%s)', (minutes) => {
    expect(() => snapTime(minutes, 5)).toThrow(RangeError);
  });
});

describe('clampValue', () => {
  it('rounds half up to an integer', () => {
    expect(clampValue(50)).toBe(50);
    expect(clampValue(50.4)).toBe(50);
    expect(clampValue(50.5)).toBe(51);
    expect(clampValue(49.5)).toBe(50);
    expect(clampValue(1.49)).toBe(1);
  });

  it('clamps into [1, 100]', () => {
    expect(clampValue(0)).toBe(1);
    expect(clampValue(0.4)).toBe(1);
    expect(clampValue(0.5)).toBe(1);
    expect(clampValue(-10)).toBe(1);
    expect(clampValue(100)).toBe(100);
    expect(clampValue(100.4)).toBe(100);
    expect(clampValue(100.5)).toBe(100);
    expect(clampValue(150)).toBe(100);
  });

  it('maps NaN to 1 and infinities to the bounds', () => {
    expect(clampValue(NaN)).toBe(1);
    expect(clampValue(Infinity)).toBe(100);
    expect(clampValue(-Infinity)).toBe(1);
  });
});

describe('clampKeyBetween', () => {
  const STEP = 5;

  it('returns the key unchanged when it lies between the bounds', () => {
    expect(clampKeyBetween(600, null, null, STEP, WINDOW)).toBe(600);
    expect(clampKeyBetween(600, 500, 700, STEP, WINDOW)).toBe(600);
    expect(clampKeyBetween(505, 500, 510, STEP, WINDOW)).toBe(505);
  });

  it('clamps to the window when there is no neighbour', () => {
    expect(clampKeyBetween(100, null, null, STEP, WINDOW)).toBe(WINDOW.startKey);
    expect(clampKeyBetween(-50, null, null, STEP, WINDOW)).toBe(WINDOW.startKey);
    expect(clampKeyBetween(1300, null, null, STEP, WINDOW)).toBe(WINDOW.endKey);
    expect(clampKeyBetween(WINDOW.startKey, null, null, STEP, WINDOW)).toBe(WINDOW.startKey);
    expect(clampKeyBetween(WINDOW.endKey, null, null, STEP, WINDOW)).toBe(WINDOW.endKey);
  });

  it('keeps at least one step after the previous point', () => {
    expect(clampKeyBetween(500, 500, null, STEP, WINDOW)).toBe(505);
    expect(clampKeyBetween(400, 500, null, STEP, WINDOW)).toBe(505);
    expect(clampKeyBetween(505, 500, null, STEP, WINDOW)).toBe(505);
    expect(clampKeyBetween(506, 500, null, STEP, WINDOW)).toBe(506);
  });

  it('keeps at least one step before the next point', () => {
    expect(clampKeyBetween(700, null, 700, STEP, WINDOW)).toBe(695);
    expect(clampKeyBetween(800, null, 700, STEP, WINDOW)).toBe(695);
    expect(clampKeyBetween(695, null, 700, STEP, WINDOW)).toBe(695);
    expect(clampKeyBetween(694, null, 700, STEP, WINDOW)).toBe(694);
  });

  it('applies both neighbours at once', () => {
    expect(clampKeyBetween(0, 500, 700, STEP, WINDOW)).toBe(505);
    expect(clampKeyBetween(2000, 500, 700, STEP, WINDOW)).toBe(695);
  });

  it('lets the window edge win when it is the tighter lower bound', () => {
    // prevKey + step = 105 lies before the window start (300).
    expect(clampKeyBetween(200, 100, null, STEP, WINDOW)).toBe(WINDOW.startKey);
    expect(clampKeyBetween(400, 100, null, STEP, WINDOW)).toBe(400);
  });

  it('lets the window edge win when it is the tighter upper bound', () => {
    // nextKey - step = 1395 lies after the window end (1200).
    expect(clampKeyBetween(1300, null, 1400, STEP, WINDOW)).toBe(WINDOW.endKey);
    expect(clampKeyBetween(1100, null, 1400, STEP, WINDOW)).toBe(1100);
  });

  it('lets the neighbour win when it is tighter than the window edge', () => {
    expect(clampKeyBetween(0, 300, null, STEP, WINDOW)).toBe(305);
    expect(clampKeyBetween(1440, null, 1200, STEP, WINDOW)).toBe(1195);
  });

  it('returns the lower bound when the neighbours leave no room (lower > upper)', () => {
    // prev + step = 510 > next - step = 495.
    expect(clampKeyBetween(505, 500, 505, 10, WINDOW)).toBe(510);
    expect(clampKeyBetween(0, 500, 505, 10, WINDOW)).toBe(510);
    // Window tighter than the neighbour: lower = startKey (300) > upper = 100 - 5.
    expect(clampKeyBetween(200, null, 100, STEP, WINDOW)).toBe(WINDOW.startKey);
    // Neighbour tighter than the window: lower = 1300 + 5 > upper = endKey (1200).
    expect(clampKeyBetween(1250, 1300, null, STEP, WINDOW)).toBe(1305);
  });

  it('allows lower === upper', () => {
    expect(clampKeyBetween(0, 500, 510, STEP, WINDOW)).toBe(505);
    expect(clampKeyBetween(9999, 500, 510, STEP, WINDOW)).toBe(505);
  });

  it('does not snap the result', () => {
    expect(clampKeyBetween(603, 500, 700, STEP, WINDOW)).toBe(603);
    expect(clampKeyBetween(400, 500, null, 7, WINDOW)).toBe(507);
  });
});

describe('hourTicks', () => {
  const labels = (window: TimeWindow, plot: PlotArea): string[] =>
    hourTicks(window, plot).map((tick) => tick.label);

  it('uses a 1-hour step when there are at least 44 px per hour', () => {
    expect(labels(WINDOW, plotWithPixelsPerHour(60))).toEqual([
      '17h',
      '18h',
      '19h',
      '20h',
      '21h',
      '22h',
      '23h',
      '0h',
      '1h',
      '2h',
      '3h',
      '4h',
      '5h',
      '6h',
      '7h',
      '8h',
    ]);
  });

  it('accepts exactly 44 px per hour for a 1-hour step', () => {
    expect(labels(WINDOW, plotWithPixelsPerHour(44))).toHaveLength(16);
    expect(labels(WINDOW, plotWithPixelsPerHour(43.9))).toHaveLength(8);
  });

  it('uses a 2-hour step aligned on even hours when 1 hour is too narrow', () => {
    // 30 px/h: 1 h = 30 px < 44, 2 h = 60 px >= 44. 17h is odd, so the first tick is 18h.
    expect(labels(WINDOW, plotWithPixelsPerHour(30))).toEqual([
      '18h',
      '20h',
      '22h',
      '0h',
      '2h',
      '4h',
      '6h',
      '8h',
    ]);
  });

  it('uses a 3-hour step on multiples of 3', () => {
    // 20 px/h: 2 h = 40 px < 44, 3 h = 60 px.
    expect(labels(WINDOW, plotWithPixelsPerHour(20))).toEqual(['18h', '21h', '0h', '3h', '6h']);
  });

  it('uses a 4-hour step on multiples of 4', () => {
    // 13 px/h: 3 h = 39 px < 44, 4 h = 52 px.
    expect(labels(WINDOW, plotWithPixelsPerHour(13))).toEqual(['20h', '0h', '4h', '8h']);
  });

  it('uses a 6-hour step on multiples of 6', () => {
    // 10 px/h: 4 h = 40 px < 44, 6 h = 60 px.
    expect(labels(WINDOW, plotWithPixelsPerHour(10))).toEqual(['18h', '0h', '6h']);
  });

  it('falls back to a 6-hour step when even 6 hours are too narrow', () => {
    expect(labels(WINDOW, plotWithPixelsPerHour(2))).toEqual(['18h', '0h', '6h']);
    expect(labels(WINDOW, { x: 0, y: 0, width: 0, height: 100 })).toEqual(['18h', '0h', '6h']);
  });

  it('returns the key and minute of day of each tick', () => {
    const ticks = hourTicks(WINDOW, plotWithPixelsPerHour(60));
    expect(ticks[0]).toEqual({ key: 300, minutes: minutesOf('17:00'), label: '17h' });
    expect(ticks[7]).toEqual({ key: 720, minutes: 0, label: '0h' });
    expect(ticks[15]).toEqual({ key: 1200, minutes: minutesOf('08:00'), label: '8h' });
    for (const tick of ticks) {
      expect(tick.key % 60).toBe(0);
      expect(tick.minutes).toBe((tick.key + 720) % 1440);
      expect(isKeyVisible(tick.key, WINDOW)).toBe(true);
    }
  });

  it('includes both window edges when they are full hours', () => {
    const ticks = hourTicks(WINDOW, plotWithPixelsPerHour(60));
    expect(ticks[0]?.key).toBe(WINDOW.startKey);
    expect(ticks[ticks.length - 1]?.key).toBe(WINDOW.endKey);
  });

  it('skips a window start that is not a full hour', () => {
    const window = makeWindow('17:30', '08:00');
    const ticks = hourTicks(window, { x: 0, y: 0, width: 14.5 * 60, height: 100 });
    expect(ticks[0]).toEqual({ key: 360, minutes: minutesOf('18:00'), label: '18h' });
    expect(ticks).toHaveLength(15);
  });

  it('skips a window end that is not a full hour', () => {
    const window = makeWindow('17:00', '07:45');
    const ticks = hourTicks(window, { x: 0, y: 0, width: 14.75 * 60, height: 100 });
    expect(ticks[ticks.length - 1]).toEqual({
      key: 1140,
      minutes: minutesOf('07:00'),
      label: '7h',
    });
  });

  it('labels the key 1440 of a 12:00 end as 12h', () => {
    const fullDay = makeWindow('12:00', '12:00');
    const ticks = hourTicks(fullDay, { x: 0, y: 0, width: 24 * 60, height: 100 });
    expect(ticks).toHaveLength(25);
    expect(ticks[0]).toEqual({ key: 0, minutes: 720, label: '12h' });
    expect(ticks[12]).toEqual({ key: 720, minutes: 0, label: '0h' });
    expect(ticks[24]).toEqual({ key: 1440, minutes: 720, label: '12h' });
  });

  it('keeps the even-hour alignment for a window starting after midnight', () => {
    const window = makeWindow('01:00', '11:00');
    expect(labels(window, { x: 0, y: 0, width: 10 * 30, height: 100 })).toEqual([
      '2h',
      '4h',
      '6h',
      '8h',
      '10h',
    ]);
  });

  it('never places two labels closer than 44 px (above the 6-hour fallback width)', () => {
    // Below 110 px (7.33 px/h) even a 6-hour step is closer than 44 px: that fallback is the only
    // case where labels may crowd, so start above it.
    for (let width = 120; width <= 1200; width += 37) {
      const plot: PlotArea = { x: 0, y: 0, width, height: 100 };
      const xs = hourTicks(WINDOW, plot).map((tick) => keyToX(tick.key, WINDOW, plot));
      expect(xs.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < xs.length; i++) {
        const previous = xs[i - 1];
        const current = xs[i];
        if (previous === undefined || current === undefined) throw new Error('missing tick');
        expect(current - previous).toBeGreaterThan(43.99);
      }
    }
  });
});

describe('polylineNodes', () => {
  const CURVE: CurvePoint[] = [point('19:00', 100), point('23:00', 10)];

  it('adds flat extensions to both window edges when the points lie inside', () => {
    expect(polylineNodes(CURVE, WINDOW)).toEqual([
      { key: WINDOW.startKey, value: 100 },
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 10 },
      { key: WINDOW.endKey, value: 10 },
    ]);
  });

  it('adds no extension when a point sits exactly on a window edge', () => {
    const window = makeWindow('19:00', '23:00');
    expect(polylineNodes(CURVE, window)).toEqual([
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 10 },
    ]);
  });

  it('adds only the leading extension when the last point lies after the window', () => {
    const window = makeWindow('17:00', '20:00');
    expect(polylineNodes(CURVE, window)).toEqual([
      { key: window.startKey, value: 100 },
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 10 },
    ]);
  });

  it('adds only the trailing extension when the first point lies before the window', () => {
    const window = makeWindow('22:00', '08:00');
    expect(polylineNodes(CURVE, window)).toEqual([
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 10 },
      { key: window.endKey, value: 10 },
    ]);
  });

  it('keeps points outside the window and adds no extension when they surround it', () => {
    const window = makeWindow('20:00', '22:00');
    expect(polylineNodes(CURVE, window)).toEqual([
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 10 },
    ]);
  });

  it('extends a curve entirely after the window from the window start (flat first value)', () => {
    const window = makeWindow('12:00', '18:00');
    expect(polylineNodes(CURVE, window)).toEqual([
      { key: 0, value: 100 },
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 10 },
    ]);
  });

  it('extends a curve entirely before the window to the window end (flat last value)', () => {
    const window = makeWindow('00:00', '08:00');
    expect(polylineNodes(CURVE, window)).toEqual([
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 10 },
      { key: window.endKey, value: 10 },
    ]);
  });

  it('extends to key 1440 for a window ending at 12:00', () => {
    const window = makeWindow('17:00', '12:00');
    const nodes = polylineNodes(CURVE, window);
    expect(nodes[nodes.length - 1]).toEqual({ key: 1440, value: 10 });
  });

  it('sorts the points along the curve day (midnight crossing) without mutating the input', () => {
    const unsorted: CurvePoint[] = [point('01:00', 10), point('23:00', 40), point('19:00', 100)];
    const snapshot = unsorted.map((p) => ({ ...p }));
    expect(polylineNodes(unsorted, WINDOW)).toEqual([
      { key: WINDOW.startKey, value: 100 },
      { key: keyOf('19:00'), value: 100 },
      { key: keyOf('23:00'), value: 40 },
      { key: keyOf('01:00'), value: 10 },
      { key: WINDOW.endKey, value: 10 },
    ]);
    expect(unsorted).toEqual(snapshot);
  });

  it('throws a RangeError for an invalid curve', () => {
    expect(() => polylineNodes([], WINDOW)).toThrow(RangeError);
    expect(() => polylineNodes([point('19:00', 100)], WINDOW)).toThrow(RangeError);
  });
});

describe('curvePath / areaPath', () => {
  const CURVE: CurvePoint[] = [point('19:00', 100), point('23:00', 10)];

  it('builds an M/L path through the polyline nodes', () => {
    // UNIT_PLOT: 1 px per key from key 300, 1 px per % from the top.
    expect(curvePath(CURVE, WINDOW, UNIT_PLOT)).toBe('M 0 0 L 120 0 L 360 90 L 900 90');
  });

  it('closes the area down to the value-0 baseline', () => {
    expect(areaPath(CURVE, WINDOW, UNIT_PLOT)).toBe(
      'M 0 0 L 120 0 L 360 90 L 900 90 L 900 100 L 0 100 Z',
    );
  });

  it('omits the extensions when the points sit on the window edges', () => {
    const window = makeWindow('19:00', '23:00');
    const plot: PlotArea = { x: 10, y: 5, width: 240, height: 50 };
    expect(curvePath(CURVE, window, plot)).toBe('M 10 5 L 250 50');
    expect(areaPath(CURVE, window, plot)).toBe('M 10 5 L 250 50 L 250 55 L 10 55 Z');
  });

  it('formats coordinates with at most 2 decimals and no trailing zeros', () => {
    // Key 720 (00:00) on PLOT: 34 + 452 * 420 / 900 = 244.9333...; key 780: 275.0666...
    const curve = [point('00:00', 50), point('01:00', 40)];
    expect(curvePath(curve, WINDOW, PLOT)).toBe('M 34 85 L 244.93 85 L 275.07 99.2 L 486 99.2');
    expect(areaPath(curve, WINDOW, PLOT)).toBe(
      'M 34 85 L 244.93 85 L 275.07 99.2 L 486 99.2 L 486 156 L 34 156 Z',
    );
  });

  it('never emits more than 2 decimals, "-0" or a trailing zero', () => {
    const plot: PlotArea = { x: 0.001, y: 0.004, width: 333.333, height: 77.777 };
    const curve = [point('18:07', 33), point('23:59', 67), point('06:13', 1)];
    const number = '-?(?:0|[1-9]\\d*)(?:\\.\\d*[1-9])?';
    const pair = `${number} ${number}`;
    expect(curvePath(curve, WINDOW, plot)).toMatch(new RegExp(`^M ${pair}(?: L ${pair})*$`));
    expect(areaPath(curve, WINDOW, plot)).toMatch(
      new RegExp(`^M ${pair}(?: L ${pair})* L ${pair} L ${pair} Z$`),
    );
    expect(curvePath(curve, WINDOW, plot)).not.toMatch(/\.\d{3}/);
    expect(curvePath(curve, WINDOW, plot)).not.toMatch(/-0(?: |$)/);
    // The first node starts at the plot's left edge, which rounds to 0 (not "-0" or "0.00").
    expect(curvePath(curve, WINDOW, plot).startsWith('M 0 ')).toBe(true);
  });

  it('draws points outside the window (the SVG clips them)', () => {
    const window = makeWindow('20:00', '22:00');
    expect(curvePath(CURVE, window, UNIT_PLOT)).toBe('M -450 0 L 1350 90');
  });

  it('throws a RangeError for an invalid curve', () => {
    expect(() => curvePath([], WINDOW, PLOT)).toThrow(RangeError);
    expect(() => areaPath([point('19:00', 100)], WINDOW, PLOT)).toThrow(RangeError);
  });
});

describe('isKeyVisible', () => {
  it('is inclusive at both edges', () => {
    expect(isKeyVisible(WINDOW.startKey, WINDOW)).toBe(true);
    expect(isKeyVisible(WINDOW.endKey, WINDOW)).toBe(true);
    expect(isKeyVisible(750, WINDOW)).toBe(true);
  });

  it('is false outside the window', () => {
    expect(isKeyVisible(WINDOW.startKey - 1, WINDOW)).toBe(false);
    expect(isKeyVisible(WINDOW.endKey + 1, WINDOW)).toBe(false);
    expect(isKeyVisible(0, WINDOW)).toBe(false);
    expect(isKeyVisible(1440, WINDOW)).toBe(false);
  });

  it('works with sortKey values of real times', () => {
    expect(isKeyVisible(keyOf('16:59'), WINDOW)).toBe(false);
    expect(isKeyVisible(keyOf('17:00'), WINDOW)).toBe(true);
    expect(isKeyVisible(keyOf('00:00'), WINDOW)).toBe(true);
    expect(isKeyVisible(keyOf('08:00'), WINDOW)).toBe(true);
    expect(isKeyVisible(keyOf('08:01'), WINDOW)).toBe(false);
    expect(isKeyVisible(keyOf('12:00'), WINDOW)).toBe(false);
  });
});
