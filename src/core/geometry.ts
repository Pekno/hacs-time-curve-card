/**
 * Pure geometry for time-curve-card: maps curve time/value to SVG coordinates and back,
 * snaps and clamps drag candidates, and builds the axis ticks and SVG paths the card renders.
 * No DOM, no Lit, no Home Assistant - it imports only from ./curve.js. Keep it that way.
 *
 * Time is handled in two spaces:
 * - "minutes": minutes since midnight in [0, 1439], the unit of {@link CurvePoint.time};
 * - "keys": curve-day keys from {@link sortKey} (12:00 -> 0 ... 11:59 -> 1439), the unit the
 *   curve is sorted and interpolated in. A window end of 12:00 uses the extra key 1440
 *   ({@link CURVE_DAY_END_KEY}) so that "12:00 -> 12:00" spans the whole curve day.
 *
 * The visible x-range ({@link TimeWindow}) lies inside the curve day and maps linearly onto the
 * plot area ({@link PlotArea}, SVG user units = CSS px). The value axis spans an
 * {@link AxisDomain}: "nice" bounds around the value range ({@link valueAxis}), 0..100 for the
 * default brightness range. Rendering is linear-only on purpose: what the card draws is what the
 * Home Assistant sensor computes (see src/core/curve.ts).
 */
import {
  BRIGHTNESS_RANGE,
  MINUTES_PER_DAY,
  PIVOT_MINUTES,
  floorDiv,
  formatTime,
  fromCenti,
  isValidCurve,
  parseTime,
  rangeToCenti,
  roundHalfUp,
  snapCenti,
  sortCurve,
  sortKey,
  type CurvePoint,
  type ValueRange,
} from './curve.js';

/**
 * Value domain of the chart's vertical axis, in user units: `min` at the bottom of the plot,
 * `max` at its top (`min < max`). Built by {@link valueAxis}.
 */
export interface AxisDomain {
  min: number;
  max: number;
}

/** The value axis of a range: its domain and its gridline values (see {@link valueAxis}). */
export interface ValueAxis extends AxisDomain {
  /** Gridline values from `min` to `max` (both included), ascending, evenly spaced. */
  ticks: number[];
}

/**
 * Visible x-range of the chart, in curve-day keys (see {@link sortKey}).
 * Invariant (guaranteed by {@link makeWindow}): `0 <= startKey < endKey <= 1440`.
 */
export interface TimeWindow {
  /** Key of the left edge of the plot (0 = 12:00). */
  startKey: number;
  /** Key of the right edge of the plot (1440 = 12:00 the next day). */
  endKey: number;
}

/** Rectangle of the plot inside the SVG, in SVG user units (px). */
export interface PlotArea {
  /** Left edge. */
  x: number;
  /** Top edge (value 100 %). */
  y: number;
  /** Width; must be > 0 for the x <-> key mappings. */
  width: number;
  /** Height; must be > 0 for the y <-> value mappings. */
  height: number;
}

/** One hour tick of the x axis (see {@link hourTicks}). */
export interface HourTick {
  /** Curve-day key of the tick (a multiple of 60; 1440 for a window ending at 12:00). */
  key: number;
  /** Minute of day of the tick, in [0, 1439] (720 for key 1440). */
  minutes: number;
  /** Label `${hour}h` with the hour of day, 0h ... 23h (12h for key 1440). */
  label: string;
}

/** One node of the visible polyline, in key space (see {@link polylineNodes}). */
export interface PolylineNode {
  /** Curve-day key. */
  key: number;
  /** Value in user units. */
  value: number;
}

/** Default `window_start` config value. */
export const DEFAULT_WINDOW_START = '17:00';

/** Default `window_end` config value. */
export const DEFAULT_WINDOW_END = '08:00';

/** Default `snap_minutes` config value (time snapping step for drags). */
export const DEFAULT_SNAP_MINUTES = 5;

/** Default `max_points` config value. */
export const DEFAULT_MAX_POINTS = 12;

/** Value axis of the default brightness range: 0..100, gridlines every 25. */
export const BRIGHTNESS_AXIS: Readonly<AxisDomain> = Object.freeze({ min: 0, max: 100 });

/** Key used for a `window_end` of 12:00: the end of the curve day (one past the last key, 1439). */
export const CURVE_DAY_END_KEY = 1440;

/** Candidate tick steps in hours, tried in order by {@link hourTicks}. */
const TICK_STEPS_HOURS: readonly number[] = [1, 2, 3, 4, 6];

/** Minimum horizontal spacing between two hour labels, in px (touch-friendly, no overlap). */
const MIN_TICK_SPACING_PX = 44;

/** Interval counts a value axis aims for (see {@link valueAxis}). */
const AXIS_MIN_INTERVALS = 4;
const AXIS_MAX_INTERVALS = 6;

/** `a mod n` with a result in [0, n) even for negative `a` (JS `%` keeps the sign of `a`). */
function positiveModulo(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Clamps `x` into [min, max]. */
function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * Builds the visible window from `HH:MM` strings (strict format, see {@link parseTime}).
 * `12:00` as END maps to key {@link CURVE_DAY_END_KEY} (1440, end of the curve day) while `12:00`
 * as START maps to 0, so `makeWindow('12:00', '12:00')` is the whole curve day.
 *
 * @throws {Error} with a French message (readable in the HA card error) when a time is invalid
 *   (`window_start invalide : attendu HH:MM` / `window_end invalide : attendu HH:MM`) or when
 *   the start does not precede the end in the curve day
 *   (`window_start (HH:MM) doit précéder window_end (HH:MM) dans la journée 12:00 → 12:00`).
 */
export function makeWindow(start: string, end: string): TimeWindow {
  const startMinutes = parseTime(start);
  if (startMinutes === null) {
    throw new Error('window_start invalide : attendu HH:MM');
  }
  const endMinutes = parseTime(end);
  if (endMinutes === null) {
    throw new Error('window_end invalide : attendu HH:MM');
  }
  const startKey = sortKey(startMinutes);
  const endKey = endMinutes === PIVOT_MINUTES ? CURVE_DAY_END_KEY : sortKey(endMinutes);
  if (startKey >= endKey) {
    throw new Error(
      `window_start (${formatTime(startMinutes)}) doit précéder window_end (${formatTime(endMinutes)}) dans la journée 12:00 → 12:00`,
    );
  }
  return { startKey, endKey };
}

/**
 * Curve-day key -> x coordinate: linear from `plot.x` (startKey) to `plot.x + plot.width`
 * (endKey). Extrapolates outside the window (no clamping); the SVG clips what is not visible.
 */
export function keyToX(key: number, window: TimeWindow, plot: PlotArea): number {
  return plot.x + ((key - window.startKey) * plot.width) / (window.endKey - window.startKey);
}

/** Minutes since midnight -> x coordinate, i.e. `keyToX(sortKey(minutes), window, plot)`. */
export function timeToX(minutes: number, window: TimeWindow, plot: PlotArea): number {
  return keyToX(sortKey(minutes), window, plot);
}

/**
 * x coordinate -> curve-day key (inverse of {@link keyToX}). Unclamped: an x outside the plot
 * gives a key outside the window (possibly negative or above 1440). Not rounded.
 */
export function xToKey(x: number, window: TimeWindow, plot: PlotArea): number {
  return window.startKey + ((x - plot.x) * (window.endKey - window.startKey)) / plot.width;
}

/**
 * x coordinate -> minutes since midnight: the key from {@link xToKey} wrapped into one day with a
 * positive modulo (a key of 1440 -> 12:00 -> 720; keys outside the window wrap around too). The
 * result lies in [0, 1440) and is fractional for an x between two minutes - integer keys give
 * integers in [0, 1439]. Drags snap it afterwards with {@link snapTime}.
 */
export function xToTime(x: number, window: TimeWindow, plot: PlotArea): number {
  return positiveModulo(xToKey(x, window, plot) + PIVOT_MINUTES, MINUTES_PER_DAY);
}

/**
 * Value -> y coordinate: `domain.max` at `plot.y` (top), `domain.min` at `plot.y + plot.height`
 * (bottom), linear in between. The domain defaults to the brightness axis 0..100. Unclamped.
 */
export function valueToY(
  value: number,
  plot: PlotArea,
  domain: Readonly<AxisDomain> = BRIGHTNESS_AXIS,
): number {
  const span = domain.max - domain.min;
  return plot.y + (plot.height * (domain.max - value)) / span;
}

/** y coordinate -> value (inverse of {@link valueToY}). Unclamped, not rounded. */
export function yToValue(
  y: number,
  plot: PlotArea,
  domain: Readonly<AxisDomain> = BRIGHTNESS_AXIS,
): number {
  const span = domain.max - domain.min;
  return domain.min + ((plot.y + plot.height - y) * span) / plot.height;
}

/**
 * The value axis of a range: "nice" bounds around [range.min, range.max] and evenly spaced
 * gridlines. The gridline step is `{1, 2, 2.5, 5} x 10^n` (whole hundredths, so from 0.01 up);
 * the bounds are the range's bounds rounded outwards to a multiple of it. Among the steps that
 * give 4 to 6 intervals the one with the FEWEST intervals wins (brightness 1..100: 25 -> 0, 25,
 * 50, 75, 100; 5..30: 5 -> 5, 10, ... 30; 2000..6500: 1000 -> 2000 ... 7000); when no step gives
 * 4 to 6 (never for real ranges, kept total anyway), the count nearest to that band wins, the
 * fewer intervals first. Exact: computed in centi-units.
 *
 * @throws {RangeError} when the range is not valid (see {@link rangeToCenti}).
 */
export function valueAxis(range: Readonly<ValueRange> = BRIGHTNESS_RANGE): ValueAxis {
  const { min, max } = rangeToCenti(range);
  let best: { step: number; lo: number; count: number; penalty: number } | null = null;
  // Steps in centi-units: 1, 2, 5, 10, 20, 25, 50, 100, ... up to past the widest span (2e6).
  for (let base = 1; base <= 10_000_000; base *= 10) {
    const steps = base === 1 ? [1, 2, 5] : [base, 2 * base, (5 * base) / 2, 5 * base];
    for (const step of steps) {
      const lo = floorDiv(min, step) * step;
      const hi = -floorDiv(-max, step) * step;
      const count = (hi - lo) / step;
      const penalty =
        count < AXIS_MIN_INTERVALS
          ? AXIS_MIN_INTERVALS - count
          : count > AXIS_MAX_INTERVALS
            ? count - AXIS_MAX_INTERVALS
            : 0;
      if (
        best === null ||
        penalty < best.penalty ||
        (penalty === best.penalty && count < best.count)
      ) {
        best = { step, lo, count, penalty };
      }
    }
  }
  if (best === null) throw new RangeError('valueAxis: no step'); // unreachable
  const ticks: number[] = [];
  for (let i = 0; i <= best.count; i++) ticks.push(fromCenti(best.lo + i * best.step));
  return {
    min: fromCenti(best.lo),
    max: fromCenti(best.lo + best.count * best.step),
    ticks,
  };
}

/**
 * Nearest multiple of `step` minutes (round half up, see {@link roundHalfUp}), wrapped into
 * [0, 1439] with a positive modulo (1439 with a step of 5 -> 1440 -> 0). Because `step` divides
 * 60 it also divides 1440, so the wrapped result is still a multiple of `step`.
 *
 * @throws {RangeError} when `step` is not a positive integer that divides 60, or when `minutes`
 *   is not a finite number.
 */
export function snapTime(minutes: number, step: number): number {
  if (!Number.isInteger(step) || step <= 0 || 60 % step !== 0) {
    throw new RangeError(`snapTime: step must be a positive integer that divides 60 (got ${step})`);
  }
  if (!Number.isFinite(minutes)) {
    throw new RangeError(`snapTime: minutes must be a finite number (got ${minutes})`);
  }
  return positiveModulo(roundHalfUp(minutes / step) * step, MINUTES_PER_DAY);
}

/**
 * Value candidate (a drag position, a typed or nudged value) -> a value of the range: rounded to
 * whole hundredths, clamped into [range.min, range.max], snapped to the nearest multiple of
 * `range.step` (half up, exact integer arithmetic, see {@link snapCenti}) and clamped again (a
 * bound off the step grid stays reachable). Brightness (the default range): an integer in
 * [1, 100], rounded half up. `NaN` -> `range.min` (never lets an invalid value reach the curve).
 *
 * @throws {RangeError} when the range is not valid (see {@link rangeToCenti}).
 */
export function clampValue(value: number, range: Readonly<ValueRange> = BRIGHTNESS_RANGE): number {
  const { min, max, step } = rangeToCenti(range);
  if (Number.isNaN(value)) return fromCenti(min);
  const centi = clamp(Math.round(value * 100), min, max);
  return fromCenti(clamp(snapCenti(centi, step), min, max));
}

/**
 * The value `steps` grid steps away from `value` (keyboard nudges): the next multiple of
 * `range.step` above (`steps > 0`) or below (`steps < 0`) - an off-grid value first moves to the
 * grid line on that side - then `|steps| - 1` more steps, clamped into [range.min, range.max].
 * `steps === 0` returns `clampValue(value, range)`. Exact (centi-units).
 *
 * @throws {RangeError} when the range is not valid or `value` is not a whole number of
 *   hundredths.
 */
export function stepValue(
  value: number,
  steps: number,
  range: Readonly<ValueRange> = BRIGHTNESS_RANGE,
): number {
  const { min, max, step } = rangeToCenti(range);
  if (steps === 0) return clampValue(value, range);
  const centi = Math.round(value * 100);
  const next =
    steps > 0 ? (floorDiv(centi, step) + steps) * step : (-floorDiv(-centi, step) + steps) * step;
  return fromCenti(clamp(next, min, max));
}

/**
 * Clamps a candidate KEY between its neighbours (keeping at least one `step` of distance, so
 * points never reorder or merge) and inside the window:
 * - `lower = max(window.startKey, prevKey === null ? -Infinity : prevKey + step)`
 * - `upper = min(window.endKey, nextKey === null ? Infinity : nextKey - step)`
 *
 * When `lower > upper` (the neighbours leave no room) `lower` is returned. Note that `lower` can
 * then lie PAST `window.endKey` (a previous neighbour within one step of the window end): the
 * caller (M3 drag handler) must check the result with {@link isKeyVisible} before persisting,
 * or refuse the move. The result is NOT snapped: snap the candidate with {@link snapTime}
 * before calling. `prevKey` / `nextKey` are `null` when the point has no previous / next
 * neighbour.
 */
export function clampKeyBetween(
  key: number,
  prevKey: number | null,
  nextKey: number | null,
  step: number,
  window: TimeWindow,
): number {
  const lower = Math.max(window.startKey, prevKey === null ? -Infinity : prevKey + step);
  const upper = Math.min(window.endKey, nextKey === null ? Infinity : nextKey - step);
  if (lower > upper) return lower;
  return clamp(key, lower, upper);
}

/**
 * Hour ticks of the x axis inside `[window.startKey, window.endKey]` (inclusive).
 *
 * With `pixelsPerHour = plot.width / ((endKey - startKey) / 60)`, the step in hours is the
 * smallest n in [1, 2, 3, 4, 6] such that `pixelsPerHour * n >= 44` (6 when none qualifies), so
 * labels never overlap. Ticks are the keys whose minute of day is a full hour AND whose hour of
 * day is a multiple of the step: 2-hour steps land on even hours (18h, 20h, 22h, 0h, 2h ...)
 * whatever the window start. Labels are `${hour}h` (0h ... 23h; 12h for key 1440).
 * `window` must come from {@link makeWindow} (finite keys).
 */
export function hourTicks(window: TimeWindow, plot: PlotArea): HourTick[] {
  const pixelsPerHour = plot.width / ((window.endKey - window.startKey) / 60);
  const step = TICK_STEPS_HOURS.find((hours) => pixelsPerHour * hours >= MIN_TICK_SPACING_PX) ?? 6;
  const ticks: HourTick[] = [];
  // Keys that are multiples of 60 are exactly the full hours (the noon pivot is one itself).
  for (let key = Math.ceil(window.startKey / 60) * 60; key <= window.endKey; key += 60) {
    const minutes = positiveModulo(key + PIVOT_MINUTES, MINUTES_PER_DAY);
    const hour = minutes / 60;
    if (hour % step !== 0) continue;
    ticks.push({ key, minutes, label: `${hour}h` });
  }
  return ticks;
}

/**
 * Nodes of the visible polyline in key space, i.e. the sorted points plus the flat extensions:
 * `{ key: window.startKey, value: first.value }` is prepended when the first point lies after the
 * window start and `{ key: window.endKey, value: last.value }` is appended when the last point
 * lies before the window end (the curve holds its first / last value there, exactly like the
 * sensor). Points outside the window stay in the list - the SVG clips them - so a curve entirely
 * outside the window still draws as a flat line at its first / last value. The input array is
 * never mutated (a sorted copy is used).
 *
 * @throws {RangeError} when the curve is invalid (fewer than 2 points, see {@link isValidCurve}).
 */
export function polylineNodes(points: readonly CurvePoint[], window: TimeWindow): PolylineNode[] {
  if (!isValidCurve(points)) {
    throw new RangeError(`polylineNodes: a curve needs at least 2 points (got ${points.length})`);
  }
  const nodes: PolylineNode[] = sortCurve(points).map((point) => ({
    key: sortKey(point.time),
    value: point.value,
  }));
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError('polylineNodes: the curve has no points');
  }
  if (first.key > window.startKey) {
    nodes.unshift({ key: window.startKey, value: first.value });
  }
  if (last.key < window.endKey) {
    nodes.push({ key: window.endKey, value: last.value });
  }
  return nodes;
}

/** Formats an SVG coordinate with at most 2 decimals and no trailing zeros (`-0` -> `0`). */
function formatCoordinate(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** Projects the polyline nodes onto the plot, as formatted `x y` pairs. */
function projectedNodes(
  points: readonly CurvePoint[],
  window: TimeWindow,
  plot: PlotArea,
  domain: Readonly<AxisDomain>,
): { x: string; y: string }[] {
  return polylineNodes(points, window).map((node) => ({
    x: formatCoordinate(keyToX(node.key, window, plot)),
    y: formatCoordinate(valueToY(node.value, plot, domain)),
  }));
}

/** `M x y L x y ...` for the given projected nodes. */
function openPath(nodes: readonly { x: string; y: string }[]): string {
  return `M ${nodes.map((node) => `${node.x} ${node.y}`).join(' L ')}`;
}

/**
 * SVG path data for the curve line: `M x y L x y ...` through {@link polylineNodes} projected
 * with {@link keyToX} / {@link valueToY}. Numbers are formatted with at most 2 decimals and no
 * trailing zeros. `domain` is the value axis (default: brightness, 0..100).
 *
 * @throws {RangeError} when the curve is invalid (see {@link polylineNodes}).
 */
export function curvePath(
  points: readonly CurvePoint[],
  window: TimeWindow,
  plot: PlotArea,
  domain: Readonly<AxisDomain> = BRIGHTNESS_AXIS,
): string {
  return openPath(projectedNodes(points, window, plot, domain));
}

/**
 * SVG path data for the area under the curve: the {@link curvePath} closed down to the bottom
 * of the value axis (`domain.min`, 0 for brightness), `... L xLast yBase L xFirst yBase Z`.
 *
 * @throws {RangeError} when the curve is invalid (see {@link polylineNodes}).
 */
export function areaPath(
  points: readonly CurvePoint[],
  window: TimeWindow,
  plot: PlotArea,
  domain: Readonly<AxisDomain> = BRIGHTNESS_AXIS,
): string {
  const nodes = projectedNodes(points, window, plot, domain);
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    // Unreachable: polylineNodes rejects curves with fewer than 2 points.
    throw new RangeError('areaPath: the curve has no points');
  }
  const yBase = formatCoordinate(valueToY(domain.min, plot, domain));
  return `${openPath(nodes)} L ${last.x} ${yBase} L ${first.x} ${yBase} Z`;
}

/** true when `window.startKey <= key <= window.endKey` (both edges inclusive). */
export function isKeyVisible(key: number, window: TimeWindow): boolean {
  return window.startKey <= key && key <= window.endKey;
}
