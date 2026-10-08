/**
 * Tests for src/core/curve.ts.
 *
 * The first block runs every case of test/fixtures/curve-cases.json, the single source of truth
 * for curve semantics shared with the Jinja sensor test (test/jinja/test_sensor.py). The other
 * blocks are focused unit tests for the helpers and the error/mutation guarantees.
 */
import { describe, expect, it } from 'vitest';
import fixtureJson from './fixtures/curve-cases.json' with { type: 'json' };
import {
  BRIGHTNESS_RANGE,
  DEFAULT_CURVE,
  MAX_ABS_CENTI,
  MAX_CURVE_LENGTH,
  MIN_POINTS,
  MINUTES_PER_DAY,
  PIVOT_MINUTES,
  compareByDay,
  evaluateCurve,
  evaluateCurveCenti,
  floorDiv,
  formatCenti,
  formatTime,
  formatValue,
  fromCenti,
  isValidCurve,
  maxPointsFor,
  maxTokenLength,
  maxValue,
  parseCurve,
  parseTime,
  parseValueCenti,
  rangeToCenti,
  roundHalfUp,
  serializeCurve,
  snapCenti,
  sortCurve,
  sortKey,
  toCenti,
  type CurvePoint,
  type ValueRange,
} from '../src/core/curve.js';

/**
 * Shape of one fixture case (docs/curve-spec.md, section 7). `expected`, `canonical` and `max`
 * are either all set (valid curve) or all `null` (invalid curve): the union lets
 * `expected === null` narrow the other two, and a fixture mixing the two shapes fails the
 * typecheck.
 */
type FixtureCase = {
  name: string;
  /** `[minCenti, maxCenti]`; default brightness `[100, 10000]`. */
  range?: number[];
  /** Step in centi-units; default 100. */
  step?: number;
  curve: string;
  time: string;
  note?: string;
} & (
  | {
      /** Curve value at `time`, formatted (`"19.5"`). */
      expected: string;
      /** `serializeCurve(parseCurve(curve, range), range)`. */
      canonical: string;
      /** `formatValue(maxValue(parseCurve(curve, range)))`. */
      max: string;
    }
  | { expected: null; canonical: null; max: null }
);

interface Fixture {
  description: string;
  $comment: string;
  cases: FixtureCase[];
}

// A typed assignment (not a cast) so that a malformed fixture fails the typecheck.
const fixture: Fixture = fixtureJson;

const HEATING: ValueRange = { min: 5, max: 30, step: 0.5 };
const COLOR_TEMP: ValueRange = { min: 2000, max: 6500, step: 50 };

/** The {@link ValueRange} of a fixture case (defaults: brightness). */
function rangeOf(c: FixtureCase): ValueRange {
  const bounds = c.range ?? [100, 10000];
  const [min, max] = bounds;
  if (bounds.length !== 2 || min === undefined || max === undefined) {
    throw new Error(`${c.name}: range must be [minCenti, maxCenti]`);
  }
  return { min: fromCenti(min), max: fromCenti(max), step: fromCenti(c.step ?? 100) };
}

/** Parses a fixture time, failing loudly instead of returning null. */
function minutesOf(time: string): number {
  const minutes = parseTime(time);
  if (minutes === null) throw new Error(`fixture time "${time}" is not HH:MM`);
  return minutes;
}

/** Builds a point from an `HH:MM` time and a value. */
function point(time: string, value: number): CurvePoint {
  return { time: minutesOf(time), value };
}

/** sortKey of an `HH:MM` time. */
function sortKeyOf(time: string): number {
  return sortKey(minutesOf(time));
}

describe('shared fixture: test/fixtures/curve-cases.json', () => {
  it('has at least one case and unique case names', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    const names = fixture.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every time as HH:MM with a 2-digit hour, and valid ranges', () => {
    for (const c of fixture.cases) {
      expect(c.time, c.name).toMatch(/^\d{2}:\d{2}$/);
      expect(parseTime(c.time), c.name).not.toBeNull();
      expect(() => rangeToCenti(rangeOf(c)), c.name).not.toThrow();
    }
  });

  it('covers the example packages (brightness, heating, colour temperature)', () => {
    const count = (min: number, max: number, step: number): number =>
      fixture.cases.filter((c) => {
        const r = rangeToCenti(rangeOf(c));
        return r.min === min && r.max === max && r.step === step;
      }).length;
    expect(count(100, 10000, 100)).toBeGreaterThanOrEqual(50);
    expect(count(500, 3000, 50)).toBeGreaterThanOrEqual(10);
    expect(count(200000, 650000, 5000)).toBeGreaterThanOrEqual(10);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const range = rangeOf(c);
      const points = parseCurve(c.curve, range);
      const now = minutesOf(c.time);
      if (c.expected === null) {
        expect(points.length).toBeLessThan(MIN_POINTS);
        expect(isValidCurve(points)).toBe(false);
        expect(() => {
          evaluateCurveCenti(points, now, range);
        }).toThrow(RangeError);
      } else {
        expect(isValidCurve(points)).toBe(true);
        const centi = evaluateCurveCenti(points, now, range);
        expect(formatCenti(centi)).toBe(c.expected);
        expect(centi).toBe(parseValueCenti(c.expected));
        expect(evaluateCurve(points, now, range)).toBe(fromCenti(centi));
        expect(serializeCurve(points, range)).toBe(c.canonical);
        expect(formatValue(maxValue(points))).toBe(c.max);
        // The canonical form is a fixed point of parse + serialize and fits the input_text.
        expect(serializeCurve(parseCurve(c.canonical, range), range)).toBe(c.canonical);
        expect(c.canonical.length).toBeLessThanOrEqual(MAX_CURVE_LENGTH);
      }
    });
  }
});

describe('DEFAULT_CURVE', () => {
  it('is valid, fits the input_text and round-trips unchanged', () => {
    const points = parseCurve(DEFAULT_CURVE);
    expect(points).toHaveLength(4);
    expect(isValidCurve(points)).toBe(true);
    expect(DEFAULT_CURVE.length).toBeLessThanOrEqual(MAX_CURVE_LENGTH);
    expect(serializeCurve(points)).toBe(DEFAULT_CURVE);
    expect(maxValue(points)).toBe(100);
    // Midpoint of the 21:00@70 -> 22:30@30 segment.
    expect(evaluateCurve(points, minutesOf('21:45'))).toBe(50);
  });
});

describe('sortKey', () => {
  it('maps the curve day 12:00 -> 11:59 onto 0 -> 1439', () => {
    expect(sortKeyOf('12:00')).toBe(0);
    expect(sortKeyOf('23:59')).toBe(719);
    expect(sortKeyOf('00:00')).toBe(720);
    expect(sortKeyOf('11:59')).toBe(1439);
  });

  it('uses a positive modulo', () => {
    expect(sortKey(-1)).toBe(719);
    expect(sortKey(-720)).toBe(0);
    expect(sortKey(MINUTES_PER_DAY + PIVOT_MINUTES)).toBe(0);
    expect(Object.is(sortKey(PIVOT_MINUTES), 0)).toBe(true);
  });
});

describe('compareByDay', () => {
  it('orders along the curve day, not by clock time', () => {
    const at2300 = point('23:00', 40);
    const at0100 = point('01:00', 10);
    const at1200 = point('12:00', 50);
    const at1159 = point('11:59', 60);
    expect(compareByDay(at2300, at0100)).toBeLessThan(0);
    expect(compareByDay(at0100, at2300)).toBeGreaterThan(0);
    expect(compareByDay(at1200, at2300)).toBeLessThan(0);
    expect(compareByDay(at1159, at0100)).toBeGreaterThan(0);
    expect(compareByDay(at2300, point('23:00', 99))).toBe(0);
    expect([at1159, at0100, at2300, at1200].sort(compareByDay)).toEqual([
      at1200,
      at2300,
      at0100,
      at1159,
    ]);
  });
});

describe('sortCurve', () => {
  it('returns a fresh sorted copy and leaves the input untouched', () => {
    const input: readonly CurvePoint[] = Object.freeze([
      point('01:00', 10),
      point('11:59', 60),
      point('23:00', 40),
    ]);
    const sorted = sortCurve(input);
    expect(sorted).toEqual([point('23:00', 40), point('01:00', 10), point('11:59', 60)]);
    expect(sorted).not.toBe(input);
    expect(input).toEqual([point('01:00', 10), point('11:59', 60), point('23:00', 40)]);
    // The point objects are shared, only the array is new.
    expect(sorted[0]).toBe(input[2]);
  });

  it('sorts an empty curve to an empty array', () => {
    expect(sortCurve([])).toEqual([]);
  });
});

describe('parseTime', () => {
  it('accepts H:MM and HH:MM', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('9:05')).toBe(545);
    expect(parseTime('09:05')).toBe(545);
    expect(parseTime('19:00')).toBe(1140);
    expect(parseTime('23:59')).toBe(1439);
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      '24:00',
      '19:60',
      '19:5',
      '019:00',
      '1900',
      '19-00',
      '19:00:00',
      ' 19:00',
      '19:00 ',
      '19:00\n',
      '+9:00',
      '-1:00',
      'abc',
      '19:0a',
      '\u{ff11}\u{ff19}:\u{ff10}\u{ff10}',
    ]) {
      expect(parseTime(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('formatTime', () => {
  it('zero-pads to HH:MM', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(545)).toBe('09:05');
    expect(formatTime(1140)).toBe('19:00');
    expect(formatTime(1439)).toBe('23:59');
  });

  it('round-trips with parseTime for every minute of the day', () => {
    for (let m = 0; m < MINUTES_PER_DAY; m++) {
      expect(parseTime(formatTime(m))).toBe(m);
    }
  });

  it('wraps into one day and floors fractional minutes', () => {
    expect(formatTime(MINUTES_PER_DAY)).toBe('00:00');
    expect(formatTime(-60)).toBe('23:00');
    expect(formatTime(90.9)).toBe('01:30');
  });

  it('throws a RangeError for non-finite input', () => {
    expect(() => formatTime(Number.NaN)).toThrow(RangeError);
    expect(() => formatTime(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('roundHalfUp', () => {
  it('rounds .5 up, never to even', () => {
    expect(roundHalfUp(10.5)).toBe(11);
    expect(roundHalfUp(11.5)).toBe(12);
    expect(roundHalfUp(10.49)).toBe(10);
    expect(roundHalfUp(10.51)).toBe(11);
    expect(roundHalfUp(7)).toBe(7);
    expect(roundHalfUp(-0.5)).toBe(0);
    expect(roundHalfUp(-1.5)).toBe(-1);
  });
});

describe('floorDiv', () => {
  it('floors exactly, negative numerators included', () => {
    expect(floorDiv(7, 2)).toBe(3);
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(floorDiv(-1, 2)).toBe(-1);
    expect(floorDiv(-4, 2)).toBe(-2);
    expect(Object.is(floorDiv(0, 5), 0)).toBe(true);
    expect(Object.is(floorDiv(-0, 5), 0)).toBe(true);
    for (let p = -300; p <= 300; p++) {
      for (const q of [1, 2, 3, 7, 50, 100]) {
        expect(floorDiv(p, q), `${p} // ${q}`).toBe(Math.floor(p / q));
      }
    }
  });

  it('throws a RangeError for non-integers and a non-positive divisor', () => {
    expect(() => floorDiv(1.5, 2)).toThrow(RangeError);
    expect(() => floorDiv(1, 0)).toThrow(RangeError);
    expect(() => floorDiv(1, -2)).toThrow(RangeError);
    expect(() => floorDiv(Number.NaN, 2)).toThrow(RangeError);
  });
});

describe('toCenti / fromCenti', () => {
  it('converts user units to hundredths exactly', () => {
    expect(toCenti(19.5)).toBe(1950);
    expect(toCenti(-2.05)).toBe(-205);
    expect(toCenti(70)).toBe(7000);
    expect(toCenti(0.07)).toBe(7);
    expect(toCenti(0.1 + 0.2)).toBe(30);
    expect(toCenti(9999.99)).toBe(MAX_ABS_CENTI);
    expect(Object.is(toCenti(-0), 0)).toBe(true);
    expect(fromCenti(1950)).toBe(19.5);
    expect(fromCenti(-205)).toBe(-2.05);
    expect(Object.is(fromCenti(-0), 0)).toBe(true);
  });

  it('round-trips every hundredth up to 9999.99', () => {
    for (let c = -MAX_ABS_CENTI; c <= MAX_ABS_CENTI; c += 997) {
      expect(toCenti(fromCenti(c))).toBe(c);
    }
    for (let c = -1000; c <= 1000; c++) {
      expect(toCenti(fromCenti(c))).toBe(c);
    }
  });

  it('throws a RangeError for more than 2 decimals, out of bounds or non-finite values', () => {
    for (const bad of [70.123, 0.001, 10000, -10000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toCenti(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe('parseValueCenti', () => {
  it('reads the v2 value grammar from the digits', () => {
    expect(parseValueCenti('19.5')).toBe(1950);
    expect(parseValueCenti('19.50')).toBe(1950);
    expect(parseValueCenti('19.05')).toBe(1905);
    expect(parseValueCenti('-2.05')).toBe(-205);
    expect(parseValueCenti('70')).toBe(7000);
    expect(parseValueCenti('070')).toBe(7000);
    expect(parseValueCenti('0.05')).toBe(5);
    expect(parseValueCenti('9999.99')).toBe(MAX_ABS_CENTI);
    expect(parseValueCenti('-9999.99')).toBe(-MAX_ABS_CENTI);
    expect(Object.is(parseValueCenti('-0'), 0)).toBe(true);
    expect(Object.is(parseValueCenti('-0.00'), 0)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const bad of [
      '',
      '-',
      '--5',
      '+19',
      '19.',
      '.5',
      '-.5',
      '19.555',
      '19,5',
      '1e3',
      '0x1',
      '12345',
      '1.2.3',
      ' 19',
      '19 ',
      '19%',
      '\u{ff11}\u{ff19}',
      '19.\u{ff15}',
      '\u{665}\u{660}',
      'NaN',
      'Infinity',
    ]) {
      expect(parseValueCenti(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('formatCenti / formatValue', () => {
  it('formats sign, integer part and only the needed decimals', () => {
    expect(formatCenti(1950)).toBe('19.5');
    expect(formatCenti(7000)).toBe('70');
    expect(formatCenti(-205)).toBe('-2.05');
    expect(formatCenti(5)).toBe('0.05');
    expect(formatCenti(-50)).toBe('-0.5');
    expect(formatCenti(0)).toBe('0');
    expect(formatCenti(-0)).toBe('0');
    expect(formatCenti(1905)).toBe('19.05');
    expect(formatCenti(MAX_ABS_CENTI)).toBe('9999.99');
    expect(formatValue(18.5)).toBe('18.5');
    expect(formatValue(0.1 + 0.2)).toBe('0.3');
  });

  it('round-trips with parseValueCenti', () => {
    for (let c = -MAX_ABS_CENTI; c <= MAX_ABS_CENTI; c += 991) {
      expect(parseValueCenti(formatCenti(c))).toBe(c);
    }
    for (let c = -2000; c <= 2000; c++) {
      expect(parseValueCenti(formatCenti(c))).toBe(c);
    }
  });

  it('throws a RangeError for a non-integer', () => {
    expect(() => formatCenti(19.5)).toThrow(RangeError);
    expect(() => formatCenti(Number.NaN)).toThrow(RangeError);
  });
});

describe('snapCenti', () => {
  it('rounds half up (towards +infinity) to the step', () => {
    expect(snapCenti(1925, 50)).toBe(1950);
    expect(snapCenti(1924, 50)).toBe(1900);
    expect(snapCenti(-25, 50)).toBe(0);
    expect(snapCenti(-125, 50)).toBe(-100);
    expect(snapCenti(-126, 50)).toBe(-150);
    expect(snapCenti(3550, 100)).toBe(3600);
    expect(Object.is(snapCenti(-10, 50), 0)).toBe(true);
  });
});

describe('rangeToCenti', () => {
  it('converts a valid range', () => {
    expect(rangeToCenti(BRIGHTNESS_RANGE)).toEqual({ min: 100, max: 10000, step: 100 });
    expect(rangeToCenti(HEATING)).toEqual({ min: 500, max: 3000, step: 50 });
    expect(rangeToCenti({ min: -20, max: 40, step: 0.05 })).toEqual({
      min: -2000,
      max: 4000,
      step: 5,
    });
  });

  it('throws a RangeError for an invalid range', () => {
    for (const bad of [
      { min: 10, max: 10, step: 1 },
      { min: 10, max: 5, step: 1 },
      { min: 1, max: 100, step: 0 },
      { min: 1, max: 100, step: -1 },
      { min: 1, max: 100, step: 0.001 },
      { min: 1.005, max: 100, step: 1 },
      { min: 1, max: 10000, step: 1 },
    ]) {
      expect(() => rangeToCenti(bad), JSON.stringify(bad)).toThrow(RangeError);
      expect(() => parseCurve('19:00@1;20:00@2', bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe('maxTokenLength / maxPointsFor', () => {
  it('gives the documented bounds', () => {
    expect(maxTokenLength()).toBe(10);
    expect(maxPointsFor()).toBe(25);
    expect(maxTokenLength(HEATING)).toBe(11);
    expect(maxPointsFor(HEATING)).toBe(23);
    expect(maxTokenLength(COLOR_TEMP)).toBe(11);
    expect(maxPointsFor(COLOR_TEMP)).toBe(23);
    expect(maxTokenLength({ min: -20, max: 40, step: 0.05 })).toBe(13);
    expect(maxTokenLength({ min: -0.5, max: 0.5, step: 0.1 })).toBe(11);
  });

  it('always fits the input_text with the longest grid values', () => {
    const ranges: ValueRange[] = [
      BRIGHTNESS_RANGE,
      HEATING,
      COLOR_TEMP,
      { min: -20, max: 40, step: 0.05 },
      { min: -9999.99, max: 9999.99, step: 0.01 },
      { min: 0, max: 1, step: 0.1 },
      { min: -5, max: 5, step: 0.5 },
    ];
    for (const range of ranges) {
      const { min, max, step } = rangeToCenti(range);
      // Longest formatted value among the bounds and the grid values near them.
      const candidates = [min, max, snapCenti(min + step, step), snapCenti(max - step, step)];
      for (let c = min; c <= max && c <= min + 20 * step; c += step) candidates.push(c);
      for (let c = max; c >= min && c >= max - 20 * step; c -= step) candidates.push(c);
      const longest = candidates
        .filter((c) => c >= min && c <= max)
        .reduce((a, b) => (formatCenti(b).length > formatCenti(a).length ? b : a));
      expect(formatCenti(longest).length + 7, JSON.stringify(range)).toBeLessThanOrEqual(
        maxTokenLength(range),
      );
      const points = Array.from({ length: maxPointsFor(range) }, (_, i) => ({
        time: i * 30,
        value: fromCenti(longest),
      }));
      expect(serializeCurve(points, range).length, JSON.stringify(range)).toBeLessThanOrEqual(
        MAX_CURVE_LENGTH,
      );
    }
  });
});

describe('parseCurve', () => {
  it('treats null, undefined, empty and HA placeholder states as an empty curve', () => {
    for (const text of [null, undefined, '', '   ', ';;', 'unknown', 'unavailable']) {
      expect(parseCurve(text), String(text)).toEqual([]);
      expect(isValidCurve(parseCurve(text))).toBe(false);
    }
  });

  it('trims ASCII space/tab, clamps, dedupes (last wins) and sorts (spec section 3 example)', () => {
    const points = parseCurve(' 9:05@0 ; 23:00@40;09:05@150');
    expect(points).toEqual([point('23:00', 40), point('09:05', 100)]);
    expect(serializeCurve(points)).toBe('23:00@40;09:05@100');
  });

  it('accepts tabs around tokens and 1-digit hours', () => {
    expect(parseCurve('\t19:00@100\t;\t 9:30@5')).toEqual([point('19:00', 100), point('09:30', 5)]);
  });

  it('ignores malformed tokens and keeps the valid ones', () => {
    const malformed = [
      '+19:00@50',
      '19:00@+5',
      '19:00@50%',
      '19:00 @50',
      '19:00@ 50',
      '19 :00@50',
      '24:00@50',
      '19:60@50',
      '19:5@50',
      '019:00@50',
      '19:00@',
      '@50',
      '19:00@abc',
      '19:00@10000',
      '19:00@1.',
      '19:00@.5',
      '19:00@1.005',
      '19:00@19,5',
      '19:00@1e3',
      '19:00@-',
      '19:00@--5',
      '19:00@-.5',
      '19:00@1.2.3',
      '1900@50',
      '19-00@50',
      '19:00@50 x',
      '19:00@50@60',
      '19:00',
      '50',
      '19:00@50\n',
      '\u{a0}19:00@50',
      '19:00@50\u{a0}',
      '\u{ff12}\u{ff13}:\u{ff10}\u{ff10}@\u{ff11}\u{ff10}',
      '19:00@\u{ff15}\u{ff10}',
    ];
    for (const token of malformed) {
      const points = parseCurve(`18:00@100;${token};22:00@10`);
      expect(points, JSON.stringify(token)).toEqual([point('18:00', 100), point('22:00', 10)]);
    }
  });

  it('accepts negative and decimal values (v2) and clamps them to the range', () => {
    expect(parseCurve('19:00@-5;21:00@70.5;23:00@1000;01:00@0.99')).toEqual([
      point('19:00', 1),
      point('21:00', 70.5),
      point('23:00', 100),
      point('01:00', 1),
    ]);
    expect(parseCurve('17:00@-3.5;22:00@18.5;06:00@35', HEATING)).toEqual([
      point('17:00', 5),
      point('22:00', 18.5),
      point('06:00', 30),
    ]);
    expect(parseCurve('17:00@-2.05;18:00@-0', { min: -20, max: 40, step: 0.5 })).toEqual([
      point('17:00', -2.05),
      point('18:00', 0),
    ]);
  });

  it('clamps values to [1, 100] by default', () => {
    expect(parseCurve('19:00@0;21:00@150;23:00@999;01:00@000')).toEqual([
      point('19:00', 1),
      point('21:00', 100),
      point('23:00', 100),
      point('01:00', 1),
    ]);
  });

  it('accepts zero-padded values and serializes them unpadded', () => {
    expect(serializeCurve(parseCurve('19:00@007;21:00@070'))).toBe('19:00@7;21:00@70');
    expect(serializeCurve(parseCurve('17:00@020.50;22:00@0018.0', HEATING), HEATING)).toBe(
      '17:00@20.5;22:00@18',
    );
  });

  it('keeps the last valid occurrence of a duplicate time', () => {
    expect(parseCurve('19:00@100;21:00@70;19:00@50')).toEqual([
      point('19:00', 50),
      point('21:00', 70),
    ]);
    // 9:05 and 09:05 are the same time; an invalid duplicate does not override.
    expect(parseCurve('9:05@10;12:00@30;09:05@20;09:05@abc')).toEqual([
      point('12:00', 30),
      point('09:05', 20),
    ]);
  });

  it('sorts along the curve day (noon pivot)', () => {
    expect(parseCurve('01:00@10;11:59@60;23:00@40;12:00@50')).toEqual([
      point('12:00', 50),
      point('23:00', 40),
      point('01:00', 10),
      point('11:59', 60),
    ]);
  });

  it('returns a single point (invalid curve) when only one token is valid', () => {
    const points = parseCurve('19:00@100;bogus');
    expect(points).toEqual([point('19:00', 100)]);
    expect(isValidCurve(points)).toBe(false);
  });
});

describe('serializeCurve', () => {
  it('does not mutate its input (sorts a copy)', () => {
    const input: CurvePoint[] = [point('01:00', 10), point('11:59', 60), point('23:00', 40)];
    const snapshot = input.map((p) => ({ ...p }));
    const frozen: readonly CurvePoint[] = Object.freeze(input);
    expect(serializeCurve(frozen)).toBe('23:00@40;01:00@10;11:59@60');
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(frozen[0]);
  });

  it('serializes an empty curve as an empty string', () => {
    expect(serializeCurve([])).toBe('');
  });

  it('round-trips through parseCurve with the same number of points', () => {
    const input = [point('23:00', 40), point('01:00', 10), point('11:59', 60), point('12:00', 1)];
    const parsed = parseCurve(serializeCurve(input));
    expect(parsed).toHaveLength(input.length);
    expect(parsed).toEqual(sortCurve(input));
  });

  it('writes decimals without trailing zeros and keeps off-grid values', () => {
    expect(serializeCurve([point('19:00', 70.5), point('21:00', 0.1 + 0.2 + 1)])).toBe(
      '19:00@70.5;21:00@1.3',
    );
    expect(serializeCurve([point('17:00', 19.25), point('22:00', 18)], HEATING)).toBe(
      '17:00@19.25;22:00@18',
    );
    expect(
      serializeCurve([point('17:00', -2.05), point('18:00', -0)], { min: -20, max: 40, step: 1 }),
    ).toBe('17:00@-2.05;18:00@0');
  });

  it('throws a RangeError for a value that is not whole hundredths inside the range', () => {
    for (const value of [70.123, 0, 150, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => serializeCurve([point('19:00', value), point('21:00', 70)]),
        String(value),
      ).toThrow(RangeError);
    }
    expect(() => serializeCurve([point('19:00', 4.5), point('21:00', 20)], HEATING)).toThrow(
      RangeError,
    );
  });

  it('throws a RangeError for a non-finite time', () => {
    expect(() => serializeCurve([{ time: Number.NaN, value: 50 }])).toThrow(RangeError);
  });
});

describe('evaluateCurve', () => {
  const curve = parseCurve('19:00@100;21:00@70;23:00@10');

  it('returns the value of a point exactly on it', () => {
    expect(evaluateCurve(curve, minutesOf('19:00'))).toBe(100);
    expect(evaluateCurve(curve, minutesOf('21:00'))).toBe(70);
    expect(evaluateCurve(curve, minutesOf('23:00'))).toBe(10);
  });

  it('returns user units for other ranges, centi-units from evaluateCurveCenti', () => {
    const heating = parseCurve('17:00@20;22:00@18.5;06:00@17;07:00@20', HEATING);
    expect(evaluateCurve(heating, minutesOf('19:30'), HEATING)).toBe(19.5);
    expect(evaluateCurveCenti(heating, minutesOf('19:30'), HEATING)).toBe(1950);
    expect(evaluateCurve(heating, minutesOf('22:00'), HEATING)).toBe(18.5);
  });

  it('matches the v1 float formula floor(v + 0.5) on every minute of integer curves', () => {
    const curves = [
      '19:00@100;21:00@70;22:30@30;23:30@12',
      '20:00@30;20:14@1',
      '12:00@100;11:59@1',
      '23:00@70;00:30@1;04:00@99;05:07@2',
    ];
    for (const text of curves) {
      const points = parseCurve(text);
      const nodes = points.map((p) => ({ key: sortKey(p.time), value: p.value }));
      for (let m = 0; m < MINUTES_PER_DAY; m++) {
        const k = sortKey(m);
        let expected: number | undefined;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (first === undefined || last === undefined) throw new Error('empty');
        if (k <= first.key) expected = first.value;
        else if (k >= last.key) expected = last.value;
        else {
          for (let i = 0; i + 1 < nodes.length; i++) {
            const a = nodes[i];
            const b = nodes[i + 1];
            if (a !== undefined && b !== undefined && a.key <= k && k < b.key) {
              const v = a.value + ((b.value - a.value) * (k - a.key)) / (b.key - a.key);
              expected = Math.floor(v + 0.5);
              break;
            }
          }
        }
        expect(evaluateCurve(points, m), `${text} at ${formatTime(m)}`).toBe(expected);
      }
    }
  });

  it('does not depend on the input order', () => {
    const reversed = [...curve].reverse();
    for (const time of ['18:00', '20:00', '21:00', '22:30', '03:00', '11:59']) {
      expect(evaluateCurve(reversed, minutesOf(time)), time).toBe(
        evaluateCurve(curve, minutesOf(time)),
      );
    }
  });

  it('does not mutate its input (sorts a copy)', () => {
    const input: CurvePoint[] = [point('01:00', 10), point('11:59', 60), point('23:00', 40)];
    const snapshot = input.map((p) => ({ ...p }));
    const frozen: readonly CurvePoint[] = Object.freeze(input);
    // Midnight is the middle of the 23:00@40 -> 01:00@10 segment.
    expect(evaluateCurve(frozen, minutesOf('00:00'))).toBe(25);
    expect(input).toEqual(snapshot);
    expect(input.map((p) => p.time)).toEqual(snapshot.map((p) => p.time));
    expect(input[0]).toBe(frozen[0]);
  });

  it('throws a RangeError for an invalid curve', () => {
    expect(() => evaluateCurve([], 0)).toThrow(RangeError);
    expect(() => evaluateCurve([point('19:00', 100)], 0)).toThrow(RangeError);
  });

  it('throws a RangeError for a non-finite time or a value with more than 2 decimals', () => {
    expect(() => evaluateCurve(curve, Number.NaN)).toThrow(RangeError);
    expect(() => evaluateCurve([point('19:00', 50.001), point('21:00', 70)], 1200)).toThrow(
      RangeError,
    );
  });
});

describe('maxValue', () => {
  it('returns the highest point value', () => {
    expect(maxValue(parseCurve('19:00@40;21:00@70;23:00@10'))).toBe(70);
    expect(maxValue([point('19:00', 5)])).toBe(5);
    expect(maxValue(parseCurve('17:00@-2.05;18:00@-3', { min: -20, max: 40, step: 1 }))).toBe(
      -2.05,
    );
  });

  it('throws a RangeError for an empty curve', () => {
    expect(() => maxValue([])).toThrow(RangeError);
  });
});
