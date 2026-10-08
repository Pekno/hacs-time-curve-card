/**
 * Pure curve library: parse, serialize, sort and evaluate a time-of-day value curve (brightness %,
 * heating setpoint, colour temperature, ...). No DOM, no Home Assistant imports - keep it that way.
 *
 * Curve string (v2): `HH:MM@V` tokens joined by `;`, e.g. `19:00@100;21:00@70;22:30@30;23:30@12`
 * or `17:00@20;22:00@18.5;06:00@17`, stored in an `input_text` helper (max 255 chars). V is an
 * optional `-`, 1 to 4 ASCII digits and an optional `.` followed by 1 or 2 ASCII digits; every v1
 * string (integer percentages) is a valid v2 string with the same meaning. The "curve day" runs
 * 12:00 -> 12:00 next day (noon pivot) so a night-time curve can cross midnight. Evaluation holds the
 * first value before the first point, the last value after the last point, and interpolates
 * linearly in between, quantized to the range's step.
 *
 * Values are handled EXACTLY as integers in hundredths of a unit ("centi-units": `19.5` -> 1950),
 * built from the digit strings, never through float parsing; all the arithmetic of the evaluation
 * is integer arithmetic. The point-level API ({@link CurvePoint}, {@link ValueRange}) speaks user
 * units (`19.5`), always a whole number of hundredths; the `*Centi` helpers expose the exact
 * integers for comparisons and formatting.
 *
 * CONTRACT: the Home Assistant template sensor of a user's package (the references are the
 * packages in ha/) implements EXACTLY the same rules in Jinja. Both implementations are verified
 * against the shared fixture test/fixtures/curve-cases.json (run by test/curve.test.ts and
 * test/jinja/test_sensor.py); the normative rules are written down in docs/curve-spec.md.
 * Any change to a rule here must be mirrored in the Jinja sensors and covered by a fixture case -
 * never let the two diverge.
 */

/*
 * Notes for the Jinja implementation (the packages in ha/) and for the card.
 * Pitfalls found while writing both sides, kept here so the sensor and the card end up computing
 * the same value as this library.
 *
 * 1. Exact integer arithmetic. Values are integers in hundredths (centi-units) on both sides, so
 *    the evaluation has no float anywhere and no operation-order pitfall: with a, b the segment's
 *    values, ka, kb its keys and s the step (all integers),
 *      N = a * (kb - ka) + (b - a) * (k - ka),   D = kb - ka,
 *      q = floorDiv(2 * N + D * s, 2 * D * s),   result = clamp(q * s, vmin, vmax).
 *    Jinja: `(2 * n + d * vstep) // (2 * d * vstep)` (Python `//` floors, negative numerators
 *    included). Never use `/` (true division gives a float), `round` (banker's rounding) or
 *    `| int` on a float. Sizes stay far below 2^53 (|V| <= 999999, keys < 1440) so the JS side is
 *    exact too.
 *
 * 2. Digits and anchors. Python's `\d` matches every Unicode decimal digit (full-width
 *    U+FF12 U+FF11, Arabic-Indic, ...) and `int()` accepts them; Python's `$` also matches before
 *    a trailing newline; HA's `int` filter accepts ' 70', '+70', '1_0', '1e2' and '1.0'. JS `\d` is
 *    ASCII-only. Validate the value text by hand BEFORE any `| int`: split off one leading `-`,
 *    split the rest on `.` into 1 or 2 parts, check the integer part has 1-4 characters and the
 *    fraction 1-2, and check every character against '0123456789'. The fraction is scaled by
 *    padding: `(f_txt ~ '0')[:2] | int` ('5' -> 50, '05' -> 5). If `regex_match` is used anyway,
 *    write `^-?[0-9]{1,4}(\.[0-9]{1,2})?\Z`, never `\d` or `$`. The fixture cases
 *    `non-ascii-digits-are-invalid` and `invalid-decimal-forms-*` pin this.
 *
 * 3. Parsing inside the HA sandbox. `list.append` / `dict.update` raise SecurityError, but
 *    `{% set ns.pairs = ns.pairs + [(key, value)] %}` works. Collect `(sortKey, clampedCenti)`
 *    tuples, then `{% set curve = dict(ns.pairs) | dictsort %}`: `dict()` keeps the LAST value of a
 *    repeated key (duplicate-last-wins) and `dictsort` orders integer keys, so keying by
 *    `((h * 60 + m - 720) % 1440)` makes dedupe-by-time and sort-by-day one operation (Python `%`
 *    is already non-negative for a positive divisor; the spec's double modulo is harmless there).
 *    Validity is `curve | length >= 2`, the highest value is `curve | map(attribute=1) | max`, and
 *    `{% for k, v in curve %}` unpacks the pairs. The range constants `vmin`, `vmax`, `vstep`
 *    (centi) are set at the top of the parse block.
 *
 * 4. Segment search. Mirror the three branches (k <= k_0, k >= k_last, else search) with a STRICT
 *    upper bound `{% if ka <= k and k < kb %}` and `{% break %}` (loopcontrols is enabled in HA),
 *    iterating `range(curve | length - 1)` over curve[i] / curve[i + 1]. `k == ka` returns the
 *    stored value `a` WITHOUT quantization (a point typed off the step grid is shown as typed), like
 *    the two outer branches. Deduped points make every span >= 1 (no ZeroDivisionError) and the
 *    search always hits, but keep the template total: guard the final render
 *    (`{% if r.v is none %}none{% else %}...{% endif %}`) so it can never raise - a raising state
 *    template logs an error every minute and freezes the value.
 *
 * 5. Formatting. The state is the value formatted from the centi integer with integer `//` and
 *    `%` on its absolute value: sign, integer part, then `.d` / `.dd` only when the fraction is not
 *    zero, no trailing zero (1950 -> `19.5`, 7000 -> `70`, -205 -> `-2.05`, 5 -> `0.05`). Never
 *    format through a float (`1950 / 100` prints `19.5` but `-205 / 100` may not round-trip).
 *
 * 6. Time source. Capture `now()` ONCE: `{% set t = now() %}` then
 *    `{% set k = (t.hour * 60 + t.minute - 720) % 1440 %}`. Two `now()` calls can straddle a minute
 *    boundary (hour from 20:59, minute from 21:00 -> 20:00). Seconds are ignored on both sides.
 *    HA's `now()` is in the HA-configured timezone while the browser's `new Date()` is in the
 *    phone's: the card must derive its "now" marker from `hass.config.time_zone` (e.g.
 *    `Intl.DateTimeFormat` with that `timeZone`), otherwise a user viewing the dashboard from
 *    another timezone sees a different value than the sensor. DST is not a divergence (both sides
 *    evaluate wall-clock time).
 *
 * 7. Availability and override rules. An override rule of the user's package decides
 *    availability for its own branch (e.g. a rule that uses a fixed value needs no curve); the
 *    curve branch needs a valid curve: `has_value(input_text) and at least 2 valid points` (a rule
 *    that uses the curve's highest value needs a valid curve too). `availability:` and `state:` are
 *    separate templates, so keep the parse block byte-identical in both and have
 *    test/jinja/test_sensor.py render BOTH templates for every fixture case so drift is caught.
 *    Render `none` from the state template when the curve is invalid (the state string is never
 *    evaluated while unavailable). Do not give the sensor a `device_class` that Home Assistant
 *    converts (e.g. `temperature` on an imperial system would publish Fahrenheit, which the card
 *    would compare with a Celsius curve).
 *
 * 8. Length. HA caps the input_text `max` at 255 (MAX_LENGTH_STATE_STATE) and
 *    `input_text.set_value` rejects a longer value by logging "Invalid value" WITHOUT updating the
 *    state and without raising to the caller, so the sensor never sees more than 255 chars and
 *    needs no length handling. A canonical token is at most {@link maxTokenLength} chars with its
 *    `;` (10 for brightness, `HH:MM@100;`), so any curve with at most {@link maxPointsFor} points
 *    fits (25 for brightness): the card validates `max_points` against it, keeps the
 *    MAX_CURVE_LENGTH check as defence in depth, and must not treat a resolved `set_value` call as
 *    proof of persistence - show "saved" only once the input_text state echoes the value.
 */

/** One point of the curve. */
export interface CurvePoint {
  /** Minutes since midnight, integer in [0, 1439]. */
  time: number;
  /**
   * Value in user units (e.g. 70 for 70 %, 19.5 for 19.5 degrees): always a whole number of
   * hundredths (see {@link toCenti}); {@link parseCurve} returns it clamped into the range.
   */
  value: number;
}

/**
 * Value range of a curve, in user units, each a whole number of hundredths with
 * `-9999.99 <= min < max <= 9999.99` and `step > 0` (see {@link rangeToCenti}).
 */
export interface ValueRange {
  /** Lowest value; parsed and interpolated values are clamped up to it. */
  min: number;
  /** Highest value; parsed and interpolated values are clamped down to it. */
  max: number;
  /** Interpolated values are rounded (half up) to a multiple of this step. */
  step: number;
}

/** A {@link ValueRange} in centi-units (integers). */
export interface CentiRange {
  min: number;
  max: number;
  step: number;
}

/** Number of minutes in a day. */
export const MINUTES_PER_DAY = 1440;

/** The curve day starts at noon (720 min) so that a night-time curve can cross midnight. */
export const PIVOT_MINUTES = 720;

/** Maximum length of a serialized curve: the `input_text` helper is declared with `max: 255`. */
export const MAX_CURVE_LENGTH = 255;

/** A curve needs at least this many points to be valid (evaluable). */
export const MIN_POINTS = 2;

/** Largest absolute value of the token grammar, in centi-units (`9999.99`). */
export const MAX_ABS_CENTI = 999999;

/** Brightness range (1..100 %, step 1): the default, it reproduces the v1 semantics exactly. */
export const BRIGHTNESS_RANGE: Readonly<ValueRange> = Object.freeze({ min: 1, max: 100, step: 1 });

/** Curve written by the card's reset action when the stored string is invalid (brightness). */
export const DEFAULT_CURVE = '19:00@100;21:00@70;22:30@30;23:30@12';

/**
 * `H:MM` / `HH:MM`, ASCII digits only. JS `\d` always means `[0-9]` (with or without the `u`
 * flag); the Jinja side must spell `[0-9]` explicitly because Python's `\d` matches every Unicode
 * digit (see note 2 above). Hour and minute ranges are checked in {@link toMinutes}.
 */
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** A value: optional `-`, 1-4 ASCII digits, optional `.` and 1-2 ASCII digits. */
const VALUE_RE = /^(-?)(\d{1,4})(?:\.(\d{1,2}))?$/;

/**
 * One curve token: `H:MM@V` / `HH:MM@V` with V as in {@link VALUE_RE}, surrounded only by
 * optional ASCII space/tab (the token grammar trims nothing else). Nothing else is accepted: no
 * `+`, no exponent, no comma, no `%`, no internal space. An empty or blank token fails the match
 * and is ignored like any malformed one.
 */
const TOKEN_RE = /^[ \t]*(\d{1,2}):(\d{2})@(-?\d{1,4}(?:\.\d{1,2})?)[ \t]*$/;

/** `a mod n` with a result in [0, n) even for negative `a` (JS `%` keeps the sign of `a`). */
function positiveModulo(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Clamps `x` into [min, max]. */
function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * Exact floor division of integers (`Math.floor(p / q)` without the float division), for
 * negative numerators too: `floorDiv(-1, 2) === -1`. Same as Python's `p // q` for `q > 0`.
 *
 * @throws {RangeError} when `p` or `q` is not a safe integer, or `q <= 0`.
 */
export function floorDiv(p: number, q: number): number {
  if (!Number.isSafeInteger(p) || !Number.isSafeInteger(q) || q <= 0) {
    throw new RangeError(`floorDiv: expected safe integers with q > 0 (got ${p}, ${q})`);
  }
  // (p - (p mod q)) is an exact multiple of q, so the division is exact. `+ 0` turns -0 into 0.
  return (p - positiveModulo(p, q)) / q + 0;
}

/**
 * User units -> centi-units: `Math.round(value * 100)` (19.5 -> 1950, -2.05 -> -205).
 *
 * @throws {RangeError} when `value` is not finite, is not a whole number of hundredths (more than
 *   2 decimals, beyond float noise), or its magnitude exceeds 9999.99.
 */
export function toCenti(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`toCenti: value must be a finite number (got ${value})`);
  }
  const scaled = value * 100;
  const centi = Math.round(scaled) + 0;
  if (Math.abs(scaled - centi) > 1e-6) {
    throw new RangeError(`toCenti: value must have at most 2 decimals (got ${value})`);
  }
  if (Math.abs(centi) > MAX_ABS_CENTI) {
    throw new RangeError(`toCenti: |value| must be at most 9999.99 (got ${value})`);
  }
  return centi;
}

/** Centi-units -> user units (1950 -> 19.5). The inverse of {@link toCenti}. */
export function fromCenti(centi: number): number {
  return centi / 100 + 0;
}

/**
 * Parses a value text with the token grammar (`-?[0-9]{1,4}(\.[0-9]{1,2})?`, ASCII digits, no
 * surrounding space) into centi-units, built from the digit strings (no float parsing):
 * `"19.5"` -> 1950, `"-2.05"` -> -205, `"070"` -> 7000, `"-0"` -> 0. Returns `null` for anything
 * else (`"19."`, `".5"`, `"19.555"`, `"19,5"`, `"+19"`, `"1e3"`, `"12345"`).
 */
export function parseValueCenti(text: string): number | null {
  const match = VALUE_RE.exec(text);
  if (match === null) return null;
  const [, sign, intText, fracText] = match;
  if (sign === undefined || intText === undefined) return null;
  // '5' is 50 hundredths, '05' is 5: pad the fraction to 2 digits.
  const frac = fracText === undefined ? 0 : Number(fracText.padEnd(2, '0'));
  const magnitude = Number(intText) * 100 + frac;
  return sign === '-' ? 0 - magnitude + 0 : magnitude;
}

/**
 * Formats centi-units with integer arithmetic: sign, integer part, then `.d` / `.dd` only when
 * the fraction is not zero, without trailing zero. 1950 -> `19.5`, 7000 -> `70`, -205 -> `-2.05`,
 * 5 -> `0.05`, -50 -> `-0.5`, 0 -> `0`. No thousands separator, `.` as the decimal point (this is
 * the storage / sensor format, not a display format).
 *
 * @throws {RangeError} when `centi` is not a safe integer.
 */
export function formatCenti(centi: number): string {
  if (!Number.isSafeInteger(centi)) {
    throw new RangeError(`formatCenti: expected an integer number of hundredths (got ${centi})`);
  }
  const negative = centi < 0;
  const magnitude = Math.abs(centi);
  const integer = floorDiv(magnitude, 100);
  const frac = magnitude % 100;
  let text = String(integer);
  if (frac !== 0) {
    text += frac % 10 === 0 ? `.${frac / 10}` : `.${String(frac).padStart(2, '0')}`;
  }
  return negative ? `-${text}` : text;
}

/** Formats a value in user units (`formatCenti(toCenti(value))`): 19.5 -> `19.5`. */
export function formatValue(value: number): string {
  return formatCenti(toCenti(value));
}

/**
 * Nearest multiple of `step` (centi-units), rounding half UP (towards +infinity) with exact
 * integer arithmetic: `floorDiv(2 * centi + step, 2 * step) * step`. -25 at step 50 -> 0.
 *
 * @throws {RangeError} when `centi` is not a safe integer or `step` is not a positive one.
 */
export function snapCenti(centi: number, step: number): number {
  return floorDiv(2 * centi + step, 2 * step) * step + 0;
}

/**
 * Converts and validates a {@link ValueRange}: each bound a whole number of hundredths within
 * +-9999.99, `min < max`, `step > 0`.
 *
 * @throws {RangeError} when the range is not valid.
 */
export function rangeToCenti(range: Readonly<ValueRange>): CentiRange {
  const min = toCenti(range.min);
  const max = toCenti(range.max);
  const step = toCenti(range.step);
  if (min >= max) {
    throw new RangeError(`range: min must be below max (got ${range.min}, ${range.max})`);
  }
  if (step <= 0) {
    throw new RangeError(`range: step must be positive (got ${range.step})`);
  }
  return { min, max, step };
}

/**
 * Length of the longest canonical token of a value on the range's grid, its `;` separator
 * included: `5 ("HH:MM") + 1 ("@") + width + 1 (";")`, where `width` is the longest signed
 * integer part of a value in [min, max] (that of `min` when it is negative, else of `max`) plus
 * the decimals the bounds and the step can produce (none when all three are whole numbers, `.d`
 * when they are whole tenths, else `.dd`). 10 for brightness (`HH:MM@100;`), 11 for 5..30 step 0.5
 * (`HH:MM@19.5;`) and for 2000..6500 step 50 (`HH:MM@6500;`).
 *
 * A value typed with more decimals than the grid (e.g. 19.25 on a 0.5 grid) can be longer: the
 * serialized length check ({@link MAX_CURVE_LENGTH}) stays the last guard.
 *
 * @throws {RangeError} when the range is not valid (see {@link rangeToCenti}).
 */
export function maxTokenLength(range: Readonly<ValueRange> = BRIGHTNESS_RANGE): number {
  const { min, max, step } = rangeToCenti(range);
  const integerWidth = (centi: number): number =>
    (centi < 0 ? 1 : 0) + String(floorDiv(Math.abs(centi), 100)).length;
  const width = Math.max(min < 0 ? integerWidth(min) : 0, integerWidth(max));
  const all = [min, max, step];
  const decimals = all.every((c) => c % 100 === 0) ? 0 : all.every((c) => c % 10 === 0) ? 2 : 3;
  return 5 + 1 + width + decimals + 1;
}

/**
 * Most points whose canonical serialization always fits in {@link MAX_CURVE_LENGTH} chars when
 * every value is on the range's grid: `floor((255 + 1) / maxTokenLength(range))` (the last token
 * has no `;`). 25 for brightness, 23 for 5..30 step 0.5 and for 2000..6500 step 50.
 *
 * @throws {RangeError} when the range is not valid (see {@link rangeToCenti}).
 */
export function maxPointsFor(range: Readonly<ValueRange> = BRIGHTNESS_RANGE): number {
  return Math.floor((MAX_CURVE_LENGTH + 1) / maxTokenLength(range));
}

/**
 * Minutes since midnight for already-matched `HH` / `MM` digit strings, or `null` when the hour is
 * above 23 or the minute above 59 (the regexes only check the digit count).
 */
function toMinutes(hourText: string, minuteText: string): number | null {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Position of a time inside the curve day, i.e. minutes elapsed since the noon pivot:
 * `((minutes - 720) mod 1440)` with a positive modulo. 12:00 -> 0, 23:59 -> 719, 00:00 -> 720,
 * 11:59 -> 1439. Points are sorted and interpolated in this key space.
 */
export function sortKey(minutes: number): number {
  return positiveModulo(minutes - PIVOT_MINUTES, MINUTES_PER_DAY);
}

/**
 * Comparator ordering points along the curve day (by {@link sortKey}), for `Array.prototype.sort`.
 * Returns a negative number when `a` comes before `b`, 0 when they share the same time.
 */
export function compareByDay(a: CurvePoint, b: CurvePoint): number {
  return sortKey(a.time) - sortKey(b.time);
}

/**
 * Fresh copy of `points` sorted along the curve day ({@link compareByDay}). The input array is
 * never mutated (the point objects are shared, not cloned). Used by {@link serializeCurve} and
 * {@link evaluateCurve}; the card re-sorts with it after every add/drag to keep the
 * neighbour-clamping invariant.
 */
export function sortCurve(points: readonly CurvePoint[]): CurvePoint[] {
  return [...points].sort(compareByDay);
}

/**
 * Parses a strict `H:MM` / `HH:MM` time (ASCII digits, 2-digit minutes, `0 <= HH <= 23`,
 * `0 <= MM <= 59`) into minutes since midnight. Returns `null` for anything else: no trimming,
 * no seconds, no `24:00`.
 */
export function parseTime(text: string): number | null {
  const match = TIME_RE.exec(text);
  if (match === null) return null;
  const [, hourText, minuteText] = match;
  if (hourText === undefined || minuteText === undefined) return null;
  return toMinutes(hourText, minuteText);
}

/**
 * Formats minutes since midnight as zero-padded `HH:MM`. Values are wrapped into one day with a
 * positive modulo (1440 -> `00:00`, -60 -> `23:00`) and fractional minutes are floored.
 *
 * @throws {RangeError} when `minutes` is not a finite number.
 */
export function formatTime(minutes: number): string {
  if (!Number.isFinite(minutes)) {
    throw new RangeError(`formatTime: minutes must be a finite number (got ${minutes})`);
  }
  const wrapped = positiveModulo(Math.floor(minutes), MINUTES_PER_DAY);
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Lenient parser for the stored curve string (`HH:MM@V` tokens joined by `;`).
 *
 * - `null`, `undefined`, `"unknown"` and `"unavailable"` (HA states) behave like an empty string.
 * - Tokens may be surrounded by ASCII space/tab; empty and malformed tokens are ignored.
 * - V is clamped to [range.min, range.max]; duplicate times keep the LAST valid occurrence.
 * - The result is sorted along the curve day ({@link compareByDay}).
 *
 * The result may have fewer than {@link MIN_POINTS} points: check it with {@link isValidCurve}.
 *
 * @throws {RangeError} when `range` is not valid (see {@link rangeToCenti}).
 */
export function parseCurve(
  text: string | null | undefined,
  range: Readonly<ValueRange> = BRIGHTNESS_RANGE,
): CurvePoint[] {
  const { min, max } = rangeToCenti(range);
  if (text === undefined || text === null || text === 'unknown' || text === 'unavailable') {
    return [];
  }
  const centiByTime = new Map<number, number>();
  for (const token of text.split(';')) {
    const match = TOKEN_RE.exec(token);
    if (match === null) continue;
    const [, hourText, minuteText, valueText] = match;
    if (hourText === undefined || minuteText === undefined || valueText === undefined) continue;
    const time = toMinutes(hourText, minuteText);
    const centi = parseValueCenti(valueText);
    if (time === null || centi === null) continue;
    // Last valid occurrence of a time wins; the final sort makes insertion order irrelevant.
    centiByTime.set(time, clamp(centi, min, max));
  }
  // The array is fresh, so it can be sorted in place.
  return Array.from(centiByTime, ([time, centi]) => ({ time, value: fromCenti(centi) })).sort(
    compareByDay,
  );
}

/**
 * A curve is valid (evaluable, storable) when it has at least {@link MIN_POINTS} points.
 * Individual points are not re-checked: {@link parseCurve} only produces well-formed ones.
 */
export function isValidCurve(points: readonly CurvePoint[]): boolean {
  return points.length >= MIN_POINTS;
}

/**
 * Canonical serialization: points sorted along the curve day, each as zero-padded `HH:MM@V`
 * (V formatted by {@link formatCenti}: `70`, `18.5`, `-2.05`), joined by `;` with no spaces and
 * no trailing `;`. Sorts a copy: the input array is never mutated. Does not enforce
 * {@link MAX_CURVE_LENGTH}; the caller checks the length. Values are not snapped to the step
 * (a point typed off the grid is stored as typed).
 *
 * @throws {RangeError} when a point's value is not a whole number of hundredths inside
 *   [range.min, range.max] - such a point would serialize to a token the parser drops or clamps,
 *   silently corrupting the stored curve - when a point's time is not a finite number (see
 *   {@link formatTime}), or when `range` is not valid.
 */
export function serializeCurve(
  points: readonly CurvePoint[],
  range: Readonly<ValueRange> = BRIGHTNESS_RANGE,
): string {
  const { min, max } = rangeToCenti(range);
  return sortCurve(points)
    .map((point) => {
      let centi: number;
      try {
        centi = toCenti(point.value);
      } catch {
        centi = Number.NaN;
      }
      if (!(centi >= min && centi <= max)) {
        throw new RangeError(
          `serializeCurve: point values must be whole hundredths in [${range.min}, ${range.max}] (got ${point.value})`,
        );
      }
      return `${formatTime(point.time)}@${formatCenti(centi)}`;
    })
    .join(';');
}

/**
 * Curve value at `minutes` (minutes since midnight, seconds ignored), in centi-units, with exact
 * integer arithmetic:
 * - the first point's value before (or on) the first point, the last point's value after (or on)
 *   the last point, the stored value exactly on an interior point - returned as stored, NOT
 *   quantized;
 * - otherwise, on the segment `ka <= k < kb` in {@link sortKey} space with values a, b (centi),
 *   `N = a * (kb - ka) + (b - a) * (k - ka)`, `D = kb - ka`, rounded half up to the step:
 *   `floorDiv(2 * N + D * step, 2 * D * step) * step`, then clamped to [range.min, range.max].
 *
 * Input order is irrelevant (a sorted copy is used; the input array is never mutated).
 *
 * @throws {RangeError} when the curve is invalid (see {@link isValidCurve}), `minutes` is not
 *   a finite number, a value is not a whole number of hundredths, or `range` is not valid.
 */
export function evaluateCurveCenti(
  points: readonly CurvePoint[],
  minutes: number,
  range: Readonly<ValueRange> = BRIGHTNESS_RANGE,
): number {
  const { min, max, step } = rangeToCenti(range);
  if (!isValidCurve(points)) {
    throw new RangeError(
      `evaluateCurve: a curve needs at least ${MIN_POINTS} points (got ${points.length})`,
    );
  }
  if (!Number.isFinite(minutes)) {
    throw new RangeError(`evaluateCurve: minutes must be a finite number (got ${minutes})`);
  }
  // One sort key per point, computed once: this runs every minute and on every drag frame.
  const nodes = sortCurve(points).map((point) => ({
    key: sortKey(point.time),
    value: toCenti(point.value),
  }));
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError('evaluateCurve: the curve has no points');
  }
  const k = sortKey(Math.floor(minutes));
  if (k <= first.key) return first.value;
  if (k >= last.key) return last.value;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a === undefined || b === undefined) continue;
    // Strict upper bound: `k === b.key` is handled by the next segment (or by the last-point rule),
    // which also skips zero-length segments (duplicate times) so no division by zero can occur.
    if (a.key <= k && k < b.key) {
      if (k === a.key) return a.value;
      const d = b.key - a.key;
      const n = a.value * d + (b.value - a.value) * (k - a.key);
      const q = floorDiv(2 * n + d * step, 2 * d * step);
      return clamp(q * step, min, max) + 0;
    }
  }
  // Unreachable for well-formed points (k lies strictly between the first and last keys).
  throw new RangeError('evaluateCurve: point times must be finite numbers');
}

/**
 * Curve value at `minutes` in user units: `fromCenti(evaluateCurveCenti(points, minutes, range))`
 * (an integer 1..100 for the default brightness range). See {@link evaluateCurveCenti}.
 *
 * @throws {RangeError} like {@link evaluateCurveCenti}.
 */
export function evaluateCurve(
  points: readonly CurvePoint[],
  minutes: number,
  range: Readonly<ValueRange> = BRIGHTNESS_RANGE,
): number {
  return fromCenti(evaluateCurveCenti(points, minutes, range));
}

/**
 * Highest point value of the curve, in user units (e.g. the value of an override rule such as
 * "curve switched off" in ha/example-package.yaml). `formatValue(maxValue(points))` is what the
 * Jinja side prints.
 *
 * @throws {RangeError} when `points` is empty.
 */
export function maxValue(points: readonly CurvePoint[]): number {
  if (points.length === 0) {
    throw new RangeError('maxValue: the curve has no points');
  }
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    max = Math.max(max, point.value);
  }
  return max;
}

/**
 * Rounds half UP (`Math.floor(x + 0.5)`: 10.5 -> 11, -0.5 -> 0), never banker's rounding.
 * Not used by the curve evaluation any more (exact integer arithmetic, see note 1); kept for the
 * geometry helpers (time snapping, drag candidates).
 */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}
