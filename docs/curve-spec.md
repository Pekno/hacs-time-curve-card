# Curve semantics (normative spec, format v2)

This refines CLAUDE.md ("Curve string format", "Day pivot and interpolation semantics", "Testing").
Where CLAUDE.md is silent, THIS document decides. The TypeScript library (`src/core/curve.ts`) and
the HA Jinja template sensors (the references are the packages in `ha/`: brightness
`example-package.yaml`, heating `example-heating-package.yaml`, colour temperature
`example-color-temp-package.yaml`; any package that computes the curve value must use the same
parse, evaluate and format blocks) must implement exactly these rules; both are checked against
`test/fixtures/curve-cases.json`. The "Notes for the Jinja implementation" block at the top of
`src/core/curve.ts` lists the sandbox pitfalls.

A curve describes any value over the day (brightness %, heating setpoint °C, colour temperature
K, ...). Format v2 generalizes v1 (integer percentages): **every v1 string is a valid v2 string
and gives exactly the same values with the brightness range**.

## 1. Values: centi-units and range

- Values are handled EXACTLY as integers in hundredths of a unit ("centi-units"): `19.5` → 1950,
  `-2.05` → -205, `70` → 7000, `0.05` → 5. They are built from the digit strings, never through
  float parsing, on both sides.
- A curve has a **range** `(min, max, step)` in centi-units, with
  `-999999 <= min < max <= 999999` and `step >= 1`. Parsed values are clamped to `[min, max]`;
  interpolated values are rounded to a multiple of `step`.
- The brightness range is `[100, 10000]`, step 100 (1..100 %, step 1 %): it reproduces v1
  exactly. The example packages use heating `[500, 3000]` step 50 (5..30 °C, step 0.5 °C) and
  colour temperature `[200000, 650000]` step 5000 (2000..6500 K, step 50 K).
- The range lives in two places that must agree: the card's config (`min` / `max` / `step`, in
  units) and the constants `vmin` / `vmax` / `vstep` (centi) at the top of the package's parse
  block.

## 2. Token grammar (lenient parser)

Input: the raw `input_text` state (string). `null`/`undefined`/`"unknown"`/`"unavailable"` are treated
like an empty string (→ no points → invalid curve).

1. Split on `;`.
2. For each token: trim leading/trailing whitespace (ASCII space, tab only). Empty token → ignored.
3. A token is VALID iff it matches `^([0-9]{1,2}):([0-9]{2})@(-?[0-9]{1,4}(\.[0-9]{1,2})?)$`
   (after trimming, ASCII digits only) AND `0 <= HH <= 23` AND `0 <= MM <= 59`. Notes:
   - hour may be 1 or 2 digits (`9:30` and `09:30` are both valid and equal);
   - minutes must be exactly 2 digits (`19:5` is invalid);
   - the value V is an optional `-`, 1 to 4 digits, then optionally `.` and 1 or 2 digits.
     Leading zeros are allowed (`070`, `0050.0`). `+`, exponents (`1e3`), a comma (`19,5`), a
     leading or trailing dot (`.5`, `19.`), 3 decimals (`19.555`), 5 digits (`10000`), `%`,
     internal spaces, `24:00`, `19:60`, `19:00@`, `@50`, `19:00@abc`, non-ASCII digits → the
     token is INVALID and ignored.
4. V is converted to centi-units: `int(integer part) * 100 + int(decimals padded right to 2
digits)` (`'5'` → 50, `'05'` → 5), negated when there is a `-` (`-0` is 0), then clamped to
   `[min, max]` (brightness: `0 → 1`, `150 → 100`, `1000 → 100`, `-5 → 1`).
5. Time is converted to minutes since midnight `m = HH*60 + MM` (0..1439).
6. Duplicate times (same `m`) → the LAST valid occurrence in input order wins.
7. Points are sorted ascending by `sortKey(m) = ((m - 720) % 1440 + 1440) % 1440`
   (positive modulo; 12:00 → 0, 23:59 → 719, 00:00 → 720, 11:59 → 1439).
8. If fewer than 2 points remain the curve is INVALID: card shows "Courbe invalide", sensor is
   unavailable. Otherwise VALID.

## 3. Evaluation at time `now` (exact integer arithmetic)

`now` is given as `HH:MM` (seconds ignored): `n = HH*60 + MM`, `k = sortKey(n)`.
Let the sorted points be `p_0..p_last` with keys `k_i` and values `v_i` (centi), `s` the step.

- if `k <= k_0` → `v_0` (before the first point: hold the first value);
- else if `k >= k_last` → `v_last` (after the last point: hold the last value, e.g. at 3 a.m.);
- else find `i` with `k_i <= k < k_{i+1}`:
  - if `k == k_i` → `v_i` (exactly on an interior point);
  - otherwise, with `a = v_i`, `b = v_{i+1}`, `ka = k_i`, `kb = k_{i+1}`:
    `N = a * (kb - ka) + (b - a) * (k - ka)` and `D = kb - ka` (the exact value is `N / D`
    centi-units), rounded half UP to the step:
    `q = floorDiv(2 * N + D * s, 2 * D * s)`, result `clamp(q * s, min, max)`.
- **A point's value is returned as stored**, never quantized (a value typed off the step grid,
  e.g. 19.25 on a 0.5 grid, is shown as typed); only interpolated values are quantized.
- `floorDiv` is exact floor division, also for negative numerators: JS
  `(p - (((p % q) + q) % q)) / q`, Jinja `p // q` (Python floor division). "Half up" means
  towards +infinity: -1.25 on a 0.5 grid → -1, -0.25 → 0.
- No float anywhere: the integers stay far below 2^53 (|V| <= 999999, keys < 1440), so JS numbers
  are exact too. There is no operation-order pitfall any more (v1 had one with floats).
- Linear interpolation only (no smoothing).

Sanity examples (brightness unless stated):

- `23:00@40;01:00@10` at `00:00` → 25 (crossing midnight; k=660,720,780 → mid segment).
- `19:00@100;21:00@70` at `20:00` → 85; at `18:00` → 100; at `03:00` → 70; at `12:00` → 100;
  at `11:59` → 70 (11:59 is the END of the curve day, after the last point).
- `20:00@10;22:00@13` at `20:20` → N/D = 1050 centi (10.5) → 11 (half up).
- `20:00@13;22:00@10` at `21:40` → 10.5 → 11.
- Heating `17:00@20;22:00@18.5;06:00@17;07:00@20` at `19:30` → N/D = 1925 (19.25) → 19.5; at
  `22:00` → 18.5; at `02:00` → 17.75 → 18.
- Heating `17:00@19.25;22:00@18` at `17:00` → 19.25 (as stored); at `18:00` → 19.
- Range `[-2000, 4000]` step 50: `17:00@-1;18:00@-2` at `17:15` → -1.25 → -1; `17:00@-0.5;18:00@0`
  at `17:30` → -0.25 → 0 (formatted `0`).

## 4. Formatting a value

A centi value is formatted with integer division and modulo on its absolute value: sign, integer
part, then `.d` or `.dd` only when the fraction is not zero, no trailing zero:
1950 → `19.5`, 7000 → `70`, -205 → `-2.05`, 5 → `0.05`, -50 → `-0.5`, 0 → `0`. This is the
storage and sensor format (`.` decimal point, no grouping); the card displays values with the
French decimal comma. The sensor state is this string.

## 5. Serializer (canonical form)

`serialize(points)`: points sorted by sortKey, each `HH:MM@V` with HH and MM zero-padded to 2
digits and V formatted as in section 4, joined by `;`, no spaces, no trailing `;`.
Examples: parse(" 9:05@0 ; 23:00@40;09:05@150") → sorted [23:00@40, 09:05@100] →
`23:00@40;09:05@100`; heating parse("17:00@20.50;22:00@18.0") → `17:00@20.5;22:00@18`.

Max length 255 chars (`MAX_CURVE_LENGTH`). `maxTokenLength(range)` is the longest canonical token
of a value on the range's grid, with its `;`: `5 + 1 + width + 1`, where `width` is the longest
signed integer part of a value in `[min, max]` (that of `min` when it is negative, else of `max`)
plus the decimals the bounds and the step can produce (none when all three are whole units, `.d`
when they are whole tenths, else `.dd`). The card's `max_points` upper bound is
`floor(256 / maxTokenLength(range))`: 25 for brightness (`HH:MM@100;`), 23 for the heating and
colour temperature examples (`HH:MM@19.5;`, `HH:MM@6500;`). A value typed with more decimals than
the grid can be longer, so the serialized length check stays the last guard.

(The first draft of this spec used `max(len(format(min)), len(format(max)))` for `width`; it
ignores the step's decimals and would allow 28 heating points of up to 11 chars, 307 > 255.)

## 6. Highest value

`maxValue(points)` = the maximum `v_i` over all points. The brightness example package uses it
for its override rule "curve switched off" (`input_boolean.brightness_curve_enabled` off → the
curve's highest value); the Jinja side computes it as `curve | map(attribute=1) | max` (centi)
and formats it.

## 7. TypeScript API (src/core/curve.ts): pure, no DOM, no HA imports

Point values are in user units (`19.5`), always a whole number of hundredths; the `*Centi`
functions expose the exact integers. Every range parameter defaults to `BRIGHTNESS_RANGE`.

```ts
export interface CurvePoint {
  time: number; // minutes 0..1439
  value: number; // user units, whole hundredths, inside the range
}
export interface ValueRange {
  min: number;
  max: number;
  step: number;
} // user units
export interface CentiRange {
  min: number;
  max: number;
  step: number;
} // centi-units
export const MINUTES_PER_DAY = 1440;
export const PIVOT_MINUTES = 720;
export const MAX_CURVE_LENGTH = 255;
export const MIN_POINTS = 2;
export const MAX_ABS_CENTI = 999999;
export const BRIGHTNESS_RANGE: Readonly<ValueRange>; // { min: 1, max: 100, step: 1 }
export const DEFAULT_CURVE = '19:00@100;21:00@70;22:30@30;23:30@12';
export function floorDiv(p: number, q: number): number; // exact, q > 0
export function toCenti(value: number): number; // Math.round(value * 100), checked
export function fromCenti(centi: number): number; // centi / 100
export function parseValueCenti(text: string): number | null; // value grammar -> centi
export function formatCenti(centi: number): string; // section 4
export function formatValue(value: number): string; // formatCenti(toCenti(value))
export function snapCenti(centi: number, step: number): number; // half up to the step
export function rangeToCenti(range: Readonly<ValueRange>): CentiRange; // validates
export function maxTokenLength(range?: Readonly<ValueRange>): number; // section 5
export function maxPointsFor(range?: Readonly<ValueRange>): number; // floor(256 / maxTokenLength)
export function sortKey(minutes: number): number;
export function compareByDay(a: CurvePoint, b: CurvePoint): number; // sortKey order
export function sortCurve(points: readonly CurvePoint[]): CurvePoint[]; // fresh sorted copy
export function parseTime(text: string): number | null; // "H:MM"/"HH:MM" -> minutes, else null
export function formatTime(minutes: number): string; // "HH:MM" zero padded
export function parseCurve(
  text: string | null | undefined,
  range?: Readonly<ValueRange>,
): CurvePoint[];
export function isValidCurve(points: readonly CurvePoint[]): boolean; // length >= MIN_POINTS
export function serializeCurve(points: readonly CurvePoint[], range?: Readonly<ValueRange>): string;
export function evaluateCurveCenti(
  points: readonly CurvePoint[],
  minutes: number,
  range?: Readonly<ValueRange>,
): number; // section 3, centi
export function evaluateCurve(
  points: readonly CurvePoint[],
  minutes: number,
  range?: Readonly<ValueRange>,
): number; // fromCenti(evaluateCurveCenti(...))
export function maxValue(points: readonly CurvePoint[]): number; // user units; throws if empty
export function roundHalfUp(x: number): number; // Math.floor(x + 0.5), geometry only
```

Every exported function must have a JSDoc comment; the file header must state that the Jinja
sensors implement the same rules and point to test/fixtures/curve-cases.json.

## 8. Shared fixture format (test/fixtures/curve-cases.json)

```json
{
  "description": "Single source of truth for curve semantics; run by test/curve.test.ts AND test/jinja/test_sensor.py",
  "cases": [
    {
      "name": "mid-segment-simple",
      "curve": "19:00@100;21:00@70",
      "time": "20:00",
      "expected": "85",
      "canonical": "19:00@100;21:00@70",
      "max": "100",
      "note": "linear midpoint"
    },
    {
      "name": "heating-default-mid-segment-rounds-half-up-to-step",
      "range": [500, 3000],
      "step": 50,
      "curve": "17:00@20;22:00@18.5;06:00@17;07:00@20",
      "time": "19:30",
      "expected": "19.5",
      "canonical": "17:00@20;22:00@18.5;06:00@17;07:00@20",
      "max": "20"
    },
    {
      "name": "single-point-is-invalid",
      "curve": "19:00@100",
      "time": "20:00",
      "expected": null,
      "canonical": null,
      "max": null
    }
  ]
}
```

- `range`: `[minCenti, maxCenti]`, optional, default `[100, 10000]` (brightness).
- `step`: centi-units, optional, default `100`.
- `expected`: the formatted value (section 4) as a string, or `null` when the curve is invalid
  (sensor unavailable).
- `canonical`: `serializeCurve(parseCurve(curve, range), range)`, or `null` when invalid.
- `max`: `formatValue(maxValue(parseCurve(curve, range)))`, or `null` when invalid.
- `time`: always `HH:MM` with 2-digit hour.
- `name`s must be unique. `note` is optional free text.

The TS test (test/curve.test.ts) iterates every case: parse with the case's range → if expected is
null assert `isValidCurve` false; else assert `formatCenti(evaluateCurveCenti(...))` ===
expected, `serializeCurve` === canonical, `formatValue(maxValue(...))` === max. The Jinja harness
(test/jinja/test_sensor.py) runs a case against a package only when the case's range and step
equal the package's (its descriptor's `range` / `step`, checked against the parse block's
`vmin` / `vmax` / `vstep`); cases of other ranges (negative values, other steps) are covered on
the Jinja side by the differential fuzz run while developing. Plus dedicated unit tests for the
helpers and for the "no mutation" guarantee of serializeCurve.
