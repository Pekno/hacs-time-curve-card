/**
 * `<time-curve-card>`: Lovelace card drawing a time-of-day value curve (brightness %, heating
 * setpoint, colour temperature, ... see the presets in src/config.ts) stored in an `input_text`
 * helper (see CLAUDE.md, docs/card-rendering-spec.md for the rendering and
 * docs/interactions-spec.md for the interactions: the "interactions spec" cited below).
 *
 * M2 = read-only rendering: status row ("Maintenant" / "Capteur" / the target entity), an SVG
 * chart (gridlines, hour ticks, area wash, 2px line, point markers with 44px hit targets, "now"
 * marker) and footer notes. Every value is shown with the French decimal comma and the unit of the
 * config (src/format.ts); the value axis spans "nice" bounds around the range (valueAxis).
 *
 * M3 = interactions and persistence: drag a point (pointer events, snapped to `snap_minutes` and
 * clamped between its neighbours; the value snapped to the config's step and clamped to its range),
 * tap the background to add a point, select a point to edit it
 * in a detail row or with the keyboard, delete it, and save the curve to the `input_text` helper
 * (debounced, with an optimistic local copy that wins over external updates until the save is
 * echoed back by Home Assistant).
 *
 * M5 = a "now" outside the window gets an edge marker (triangle + `HH:MM` and value label on the
 * plot edge of its side), a footer note and a mention in the chart's aria-label.
 *
 * Rendering is linear-only on purpose: what the card draws is exactly what the Home Assistant
 * template sensor computes (src/core/curve.ts). All colours come from HA theme variables so the
 * card works in light and dark themes; the curve colour can be overridden with
 * `--time-curve-card-color`.
 */
import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { ref } from 'lit/directives/ref.js';
import {
  BRIGHTNESS_RANGE,
  MAX_CURVE_LENGTH,
  MINUTES_PER_DAY,
  MIN_POINTS,
  PIVOT_MINUTES,
  evaluateCurve,
  formatTime,
  formatValue,
  isValidCurve,
  parseCurve,
  parseTime,
  parseValueCenti,
  roundHalfUp,
  serializeCurve,
  sortCurve,
  sortKey,
  toCenti,
  type CurvePoint,
  type ValueRange,
} from './core/curve.js';
import {
  BRIGHTNESS_AXIS,
  CURVE_DAY_END_KEY,
  DEFAULT_SNAP_MINUTES,
  areaPath,
  clampKeyBetween,
  clampValue,
  curvePath,
  hourTicks,
  isKeyVisible,
  keyToX,
  polylineNodes,
  stepValue,
  valueToY,
  xToKey,
  yToValue,
  type AxisDomain,
  type PlotArea,
  type TimeWindow,
} from './core/geometry.js';
import { normalizeConfig, stubConfig, type NormalizedConfig } from './config.js';
import { NNBSP, formatNumber, formatQuantity, parseDecimal } from './format.js';
import type { CardConfig, HassEntity, HomeAssistant } from './types.js';

/** Card config after validation (moved to src/config.ts, re-exported for compatibility). */
export type { NormalizedConfig };

/**
 * `mode` attribute value of a `target_sensor` that follows the curve (the generic sensor
 * contract, docs/card-rendering-spec.md section 2.2). Any other non-empty `mode` (conventionally
 * `override`) means that a higher-priority rule of the user's own package decides the value.
 */
export const SENSOR_MODE_CURVE = 'curve';

/** Longest sensor `reason` shown in the sensor chip, in characters, the ellipsis included. */
export const REASON_MAX_LENGTH = 60;

/**
 * What the sensor chip appends after the sensor value (see {@link sensorNote}): the text and,
 * for a reason given by the sensor, its full text for the `title` attribute.
 */
export interface SensorNote {
  text: string;
  title: string | null;
}

/** Where the last save stands; shown as the `.save` chip at the end of the status row. */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * A candidate key of a point, snapped to the step and clamped between its neighbours and inside
 * the window (interactions spec, section 1.3).
 */
interface KeyResolution {
  /** The snapped and clamped key; null when the neighbours / the window leave no room. */
  key: number | null;
  /** The key snapped to the step, before the clamp. */
  snapped: number;
  /** The bound that moved the snapped key (the window wins a tie); null when it was kept. */
  clampedBy: 'window' | 'neighbour' | null;
}

/**
 * Client -> SVG user units mapping of the chart: `svg = (client - left|top) * scale`, from the
 * SVG's bounding box and its viewBox.
 */
interface SvgFrame {
  left: number;
  top: number;
  /** SVG user units per client px (1 when the box has no width, as in happy-dom). */
  scale: number;
}

/**
 * The active pointer interaction: a drag of point `index`, or a press on the chart background
 * (`index` -1) that becomes an "add a point" tap when the pointer does not move.
 */
interface DragState {
  /** Index in the rendered (sorted) curve; -1 for the chart background. */
  index: number;
  pointerId: number;
  /** Client coordinates of the pointerdown, for the tap tolerance. */
  startX: number;
  startY: number;
  /** Tap tolerance of this pointer (px, Chebyshev): see {@link tapSlop}. */
  slop: number;
  /** true once the pointer travelled past the tap tolerance. */
  moved: boolean;
  /** Element holding the pointer capture (null when the browser does not support it). */
  capture: Element | null;
  /**
   * The SVG box measured at pointerdown, used by every event of the interaction (no layout
   * read per pointermove); null after a resize, re-measured by the next event.
   */
  frame: SvgFrame | null;
  /**
   * Grab offset (SVG units): the marker centre minus the pointer position at pointerdown. A point
   * pressed off-centre (anywhere in its 44px target) keeps that offset while it is dragged, so it
   * never jumps under the finger; 0 for the chart background.
   */
  grabX: number;
  grabY: number;
}

/** A box in SVG user units (tooltip, now label halo). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Layout of a "now" label: its text position and anchor, and the halo box behind it. */
interface NowLabelLayout {
  labelX: number;
  labelY: number;
  anchor: 'start' | 'end';
  halo: Box;
}

/** Layout of the "now" marker inside the window: the dot on the curve and its label. */
interface NowLayout extends NowLabelLayout {
  x: number;
  y: number;
}

/**
 * Layout of the edge marker of a "now" outside the window: the outward-pointing triangle on the
 * plot edge (tip first) and its label (the time and the value, see {@link nowEdgeText}).
 */
interface NowEdgeLayout extends NowLabelLayout {
  side: 'before' | 'after';
  triangle: string;
}

/**
 * Where "now" lies in the curve day relative to the window: inside it, before its start (drawn
 * on the left edge) or after its end (right edge).
 */
type NowSide = 'inside' | 'before' | 'after';

/** Horizontal padding of the card body (px): the chart is the host width minus twice this. */
const BODY_PADDING_X = 16;

/** Line height of the status row (px): the save chip is exactly one such line high. */
const STATUS_LINE_HEIGHT = 20;

/**
 * Minimum width of the save chip's slot (em of its 13px text): "Enregistrement\u2026" (about
 * 100px) fits without an ellipsis.
 */
const SAVE_SLOT_EM = 8;

/** Host width assumed before the first layout / ResizeObserver measurement (px). */
const FALLBACK_HOST_WIDTH = 400;

/** Narrowest chart the layout is designed for (px); the SVG scales down below it. */
const MIN_CHART_WIDTH = 120;

/** Chart height bounds and aspect ratio (height = width / ASPECT, clamped). */
const MIN_CHART_HEIGHT = 180;
const MAX_CHART_HEIGHT = 320;
const CHART_ASPECT = 2.5;

/**
 * Plot margins inside the SVG (px): value labels on the left, hour labels below. The left margin
 * leaves room for "100 %" (about 30px) AND the ring of a marker sitting on the window start
 * (outer radius with its surface ring: 6px idle, 8.5px selected, 9.5px while dragged, i.e. r 5 /
 * 7 / 8 plus half of a 2 / 3 / 3 px stroke): labels end at plot.x - AXIS_LABEL_GAP, so nothing
 * overlaps.
 */
const MARGIN_LEFT = 40;
const MARGIN_RIGHT = 14;
const MARGIN_TOP = 14;
const MARGIN_BOTTOM = 24;

/** Gap between the right edge of the value labels and the plot (px). */
const AXIS_LABEL_GAP = 10;

/**
 * Padding of the clip rectangles (px): a marker on the plot edge stays whole, the dragged one
 * included (r 8 + half of its 3px ring = 9.5px).
 */
const CLIP_PAD = 10;

/** Radii (px): visible point marker (idle / selected / dragged), its invisible hit target (44px), the "now" dot. */
const POINT_RADIUS = 5;
const SELECTED_RADIUS = 7;
const DRAGGING_RADIUS = 8;
const HIT_RADIUS = 22;
const NOW_RADIUS = 4;

/** Outer radius (px) of the largest point marker: the dragged one, r 8 + half its 3px ring. */
const MARKER_REACH = DRAGGING_RADIUS + 1.5;

/**
 * "now" label: distance from the line, the right-edge zone where it flips to the left, and the
 * top zone of the plot where it goes below its marker instead of above.
 */
const NOW_LABEL_OFFSET = 8;
const NOW_LABEL_FLIP_ZONE = 48;
const NOW_LABEL_TOP_ZONE = 20;

/**
 * "now" label halo (px): a surface-coloured box behind the label so a gridline running through
 * the glyphs is interrupted once (a per-glyph stroke halo leaves specks between the glyphs).
 * The width is estimated from the 12px tabular label: one digit (or the decimal comma), the
 * narrow no-break space and one unit character (" %" = 3 + 8 = 11 px), see nowValueWidth.
 */
const NOW_LABEL_DIGIT_WIDTH = 6.8;
const NOW_LABEL_UNIT_GAP = 3;
const NOW_LABEL_UNIT_CHAR = 8;
const NOW_LABEL_HALO_PAD = 3;
const NOW_LABEL_HALO_ASCENT = 10.5;
const NOW_LABEL_HALO_HEIGHT = 13;

/**
 * Width (px) of the time prefix of the edge label (see NOW_EDGE_*, nowEdgeText): the four digits
 * of `HH:MM`, then the colon, the two spaces and the middle dot (about 12px together in the 12px
 * label).
 */
const NOW_LABEL_TIME_WIDTH = 4 * NOW_LABEL_DIGIT_WIDTH + 12;

/** Smallest distance (px) between a "now" label's halo and the SVG edges. */
const NOW_LABEL_MARGIN = 2;

/**
 * Edge marker of a "now" outside the window (px): an outward-pointing triangle, NOW_EDGE_WIDTH
 * wide and NOW_EDGE_HEIGHT tall, whose tip touches the plot edge on the side where now lies. Its
 * label starts NOW_LABEL_OFFSET (= the triangle width) inside the plot, past the triangle.
 */
const NOW_EDGE_WIDTH = 8;
const NOW_EDGE_HEIGHT = 10;

/**
 * Room (px) the edge label's halo keeps from the curve when it has the choice (see
 * nowEdgeLayout): from the 2px line's centre (1px of stroke + 1px clear) and from a point
 * marker's outer edge, taken at its largest size ({@link MARKER_REACH}) so that selecting or
 * dragging a point never moves the label by itself.
 */
const NOW_EDGE_CURVE_GAP = 2;

/**
 * Drag tooltip (px): a surface box with the 12px `HH:MM \u00b7 NN %` text, 14px above the marker,
 * or 22px below it when the box would not fit above (marker centre closer to the SVG top than
 * {@link TOOLTIP_BELOW_UNDER}); kept 2px inside the SVG. The width is estimated per character,
 * like the "now" label. It never covers the "now" label: it keeps
 * {@link TOOLTIP_NOW_LABEL_GAP} px away from its halo (see renderTooltip).
 */
const TOOLTIP_CHAR_WIDTH = 6.6;
const TOOLTIP_PAD = 12;
const TOOLTIP_HEIGHT = 18;
const TOOLTIP_GAP_ABOVE = 14;
const TOOLTIP_GAP_BELOW = 22;
const TOOLTIP_MARGIN = 2;
const TOOLTIP_BELOW_UNDER = TOOLTIP_GAP_ABOVE + TOOLTIP_HEIGHT + TOOLTIP_MARGIN + 1;
const TOOLTIP_NOW_LABEL_GAP = 2;

/**
 * Pointer travel (px, Chebyshev) below which a press is a tap, not a drag: a finger (or a pen)
 * rolls a few px while it rests (Android's touch slop is about 8 dp), a mouse does not.
 */
const TAP_SLOP_TOUCH_PX = 8;
const TAP_SLOP_MOUSE_PX = 3;

/** Keyboard nudges are multiplied by this with Shift. */
const KEYBOARD_SHIFT_FACTOR = 5;

/** Timers (ms): save debounce, "Enregistr\u00e9" chip, transient message, echo timeout of a save. */
const SAVE_DEBOUNCE_MS = 400;
const SAVED_CHIP_MS = 2000;
const MESSAGE_MS = 4000;
const ECHO_TIMEOUT_MS = 5000;

/**
 * Width budget of the value labels left of the plot (px): "100 %" at 11px. The left margin grows
 * past MARGIN_LEFT only for wider labels ("6500 K", "-10,5 \u{b0}C"...), see axisLabelWidth.
 */
const AXIS_LABEL_FONT_PX = 11;

/** No-break space (U+00A0): French typography puts one before `:`. */
const NBSP = '\u00a0';

/**
 * UI texts with non-ASCII characters used in html`` templates: bound as expressions, because
 * Prettier formats the templates' static text as HTML and would turn their escapes into raw
 * characters (the source stays ASCII-only).
 */
const MIDDOT = '\u00b7';
const RESET_LABEL = 'R\u00e9initialiser la courbe';

/** Accessible name of the chart: "Courbe : <label>" (the label of the config's value). */
function chartName(label: string): string {
  return label === '' ? 'Courbe' : `Courbe${NBSP}: ${label}`;
}

/** Name of the target entity chip when the entity has no friendly name (or is missing). */
const TARGET_FALLBACK_NAME = 'Appareil';

/** French names of the climate `hvac_mode` states (shown when there is no current temperature). */
const HVAC_STATES: Readonly<Record<string, string>> = {
  off: 'arr\u00eat',
  heat: 'chauffage',
  cool: 'climatisation',
  heat_cool: 'chauffage / climatisation',
  auto: 'auto',
  dry: 'd\u00e9shumidification',
  fan_only: 'ventilation',
};

/** Where a "now" outside the window lies, in the footer note and the chart's aria-label. */
const NOW_BEFORE_WINDOW = 'avant la plage affich\u00e9e';
const NOW_AFTER_WINDOW = 'apr\u00e8s la plage affich\u00e9e';
const NOW_OUTSIDE_WINDOW = 'hors de la plage affich\u00e9e';

/** Host attribute set while the focus comes from a pointer (no keyboard focus ring then). */
const POINTER_FOCUS_ATTRIBUTE = 'pointer-focus';

/**
 * Sensor chip notes: a sensor without `mode` whose value differs from the curve, and an override
 * (`mode` other than `curve`) that gives no `reason`.
 */
const CURVE_MISMATCH = '\u2260 courbe';
const OVERRIDE_WITHOUT_REASON = 'R\u00e8gle prioritaire';

/** Why "Supprimer" is disabled (title AND visible hint), and the hint's id in the shadow root. */
const DELETE_HINT = 'Une courbe garde au moins 2 points';
const DELETE_HINT_ID = 'tcc-delete-hint';

/** Per-instance counter for the SVG ids (clipPath / gradient must be unique in the document). */
let instanceCounter = 0;

/** `NN %` with the French narrow no-break space (a light's brightness). */
export function formatPercent(value: number): string {
  return formatQuantity(value, '%');
}

/**
 * Estimated width (px) of a value label at `fontPx` (tabular digits): about 0.56 em per digit,
 * 0.28 em for `,` and `.`, 0.35 em for `-`, 0.2 em for the narrow no-break space and 0.72 em for
 * any other character (the unit). "100 %" at 11px: about 29 px.
 */
export function labelWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const char of text) {
    if (char >= '0' && char <= '9') em += 0.56;
    else if (char === ',' || char === '.') em += 0.28;
    else if (char === '-') em += 0.35;
    else if (char === NNBSP || char === ' ') em += 0.2;
    else em += 0.72;
  }
  return em * fontPx;
}

/**
 * Text of the target entity chip's value (docs/card-rendering-spec.md, section 2.4): a light
 * "allum\u{e9}e \u{b7} 60 %" / "allum\u{e9}e" / "\u{e9}teinte"; a climate entity its
 * `current_temperature` with the HA temperature unit (else the French name of its hvac state); any
 * other entity its state (a number with the decimal comma) and its `unit_of_measurement`;
 * "indisponible" for a missing, `unavailable` or `unknown` entity.
 */
export function targetEntityText(entity: HassEntity | undefined, temperatureUnit: string): string {
  if (entity === undefined || entity.state === 'unavailable' || entity.state === 'unknown') {
    return 'indisponible';
  }
  const domain = entity.entity_id.split('.')[0];
  const { attributes, state } = entity;
  if (domain === 'light') {
    if (state === 'off') return '\u{e9}teinte';
    if (state !== 'on') return state;
    const brightness = attributes.brightness;
    return typeof brightness === 'number' && Number.isFinite(brightness)
      ? `allum\u{e9}e ${MIDDOT} ${formatPercent(Math.round((brightness / 255) * 100))}`
      : 'allum\u{e9}e';
  }
  if (domain === 'climate') {
    const current = attributes.current_temperature;
    if (typeof current === 'number' && Number.isFinite(current)) {
      return formatQuantity(current, temperatureUnit);
    }
    return HVAC_STATES[state] ?? state;
  }
  const unit = attributes.unit_of_measurement;
  const number = parseDecimal(state);
  const text = number === null || state.includes(',') ? state : formatNumber(number);
  return typeof unit === 'string' && unit !== '' ? `${text}${NNBSP}${unit}` : text;
}

/** The friendly name of an entity, or "Appareil" (no name, missing entity). */
function friendlyName(entity: HassEntity | undefined): string {
  const name = entity?.attributes.friendly_name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : TARGET_FALLBACK_NAME;
}

/**
 * Parses a sensor state into centi-units: the curve value grammar first (`19.5`, `57`), else any
 * finite decimal number rounded to hundredths (`19.555`, `+3`, `57.0`); null for anything else
 * (`unavailable`, `unknown`, text).
 */
export function sensorCenti(state: string | undefined): number | null {
  if (state === undefined) return null;
  const trimmed = state.trim();
  const exact = parseValueCenti(trimmed);
  if (exact !== null) return exact;
  const number = parseDecimal(trimmed);
  if (number === null || trimmed.includes(',')) return null;
  const centi = Math.round(number * 100) + 0;
  return Number.isSafeInteger(centi) ? centi : null;
}

/**
 * A text attribute of the sensor contract (`mode`, `reason`): a string with its whitespace runs
 * collapsed to one space and trimmed; null when absent, not a string or blank.
 */
export function sensorText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/**
 * `text` cut to at most `max` characters (code points, so a surrogate pair is never split), the
 * last one being an ellipsis when it is cut.
 */
export function truncateText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const kept = chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd();
  return `${kept}\u2026`;
}

/**
 * What the sensor chip appends after the sensor value (docs/card-rendering-spec.md, section 2.4),
 * from the sensor's `mode` and `reason` (see {@link sensorText}) and the two values:
 * - no `mode`: "\u2260 courbe" when both values are known and differ, else nothing;
 * - `mode` `curve`: nothing, even when the values differ (the sensor re-renders on its own minute
 *   schedule, so a flag would flicker for up to a minute after every tick);
 * - any other `mode`: the `reason`, cut to {@link REASON_MAX_LENGTH} characters with its full
 *   text as the title, else "R\u00e8gle prioritaire".
 */
export function sensorNote(
  mode: string | null,
  reason: string | null,
  sensorValue: number | null,
  nowValue: number | null,
): SensorNote | null {
  if (mode === null) {
    const differs = sensorValue !== null && nowValue !== null && sensorValue !== nowValue;
    return differs ? { text: CURVE_MISMATCH, title: null } : null;
  }
  if (mode === SENSOR_MODE_CURVE) return null;
  if (reason === null) return { text: OVERRIDE_WITHOUT_REASON, title: null };
  return { text: truncateText(reason, REASON_MAX_LENGTH), title: reason };
}

/**
 * Text of the edge label of a "now" outside the window: the time, a middle dot and the curve
 * value (`now` in minutes since midnight), like the drag tooltip.
 */
function nowEdgeText(now: number, value: number, unit: string): string {
  return `${formatTime(now)} ${MIDDOT} ${formatQuantity(value, unit)}`;
}

/**
 * Estimated width (px) of the 12px "now" label showing `value` with `unit`: NOW_LABEL_DIGIT_WIDTH
 * per character of the number (the comma counted as a digit), plus the narrow no-break space and
 * 8 px per unit character (11 px for " %", the brightness label of M2).
 */
function nowValueWidth(value: number, unit: string): number {
  const suffix =
    unit === '' ? 0 : NOW_LABEL_UNIT_GAP + Array.from(unit).length * NOW_LABEL_UNIT_CHAR;
  return formatNumber(value).length * NOW_LABEL_DIGIT_WIDTH + suffix;
}

/**
 * Readable text of a rejected service call: an Error's message, the `message` of the
 * `{ code, message }` object the HA websocket rejects with, a string as is, a bare numeric code
 * as `code N`, anything else through `String()`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'number') return `code ${error}`;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message: unknown = error.message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** Focuses an HTML or SVG element without scrolling the dashboard (no-op for anything else). */
function focusElement(element: Element | null | undefined): void {
  if (element instanceof HTMLElement || element instanceof SVGElement) {
    element.focus({ preventScroll: true });
  }
}

/** Formats an SVG coordinate with at most 2 decimals (keeps the DOM readable). */
function px(n: number): number {
  return Number(n.toFixed(2));
}

/** Clamps `x` into [min, max]. */
function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

/**
 * The usual side of a "now" label: above its marker at the height `y`, below it when `y` is
 * within NOW_LABEL_TOP_ZONE px of the plot top.
 */
function nowLabelBelow(y: number, plot: PlotArea): boolean {
  return y < plot.y + NOW_LABEL_TOP_ZONE;
}

/**
 * Places a "now" label of `textWidth` px beside the vertical at `x` (the now line, or the plot
 * edge of the edge marker) at the height `y` of its marker: NOW_LABEL_OFFSET px right of `x`, or
 * left of it (text-anchor end) when `flip`; its baseline 9px above `y`, or 17px below it when
 * `below` (see {@link nowLabelBelow}). The halo box (NOW_LABEL_HALO_*) spans the text; label and
 * halo then move together, when needed, to stay NOW_LABEL_MARGIN px inside the `width` x
 * `height` SVG.
 */
function placeNowLabel(
  x: number,
  y: number,
  flip: boolean,
  below: boolean,
  textWidth: number,
  plot: PlotArea,
  width: number,
  height: number,
): NowLabelLayout {
  const labelX = flip ? x - NOW_LABEL_OFFSET : x + NOW_LABEL_OFFSET;
  const labelY = below ? y + 17 : y - 9;
  const haloWidth = textWidth + 2 * NOW_LABEL_HALO_PAD;
  const haloX = flip ? labelX - textWidth - NOW_LABEL_HALO_PAD : labelX - NOW_LABEL_HALO_PAD;
  const haloY = labelY - NOW_LABEL_HALO_ASCENT;
  const dx = clamp(haloX, NOW_LABEL_MARGIN, width - NOW_LABEL_MARGIN - haloWidth) - haloX;
  const dy =
    clamp(haloY, NOW_LABEL_MARGIN, height - NOW_LABEL_MARGIN - NOW_LABEL_HALO_HEIGHT) - haloY;
  return {
    labelX: px(labelX + dx),
    labelY: px(labelY + dy),
    anchor: flip ? 'end' : 'start',
    halo: {
      x: px(haloX + dx),
      y: px(haloY + dy),
      width: px(haloWidth),
      height: NOW_LABEL_HALO_HEIGHT,
    },
  };
}

/**
 * true when the segment from (x1, y1) to (x2, y2) meets `box` (touching counts), by clipping the
 * segment to the box (Liang-Barsky). Exported for the tests.
 */
export function segmentMeetsBox(x1: number, y1: number, x2: number, y2: number, box: Box): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let enter = 0;
  let leave = 1;
  const sides: [number, number][] = [
    [-dx, x1 - box.x],
    [dx, box.x + box.width - x1],
    [-dy, y1 - box.y],
    [dy, box.y + box.height - y1],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      // Parallel to this side: inside its half-plane or never.
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return false;
  }
  return true;
}

/** true when the disc of centre (`cx`, `cy`) and radius `r` meets `box` (touching counts). */
function discMeetsBox(cx: number, cy: number, r: number, box: Box): boolean {
  const dx = cx - clamp(cx, box.x, box.x + box.width);
  const dy = cy - clamp(cy, box.y, box.y + box.height);
  return dx * dx + dy * dy <= r * r;
}

/** true when the boxes `a` and `b` are closer than `gap` (overlapping boxes included). */
function boxesTouch(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap &&
    b.x < a.x + a.width + gap &&
    a.y < b.y + b.height + gap &&
    b.y < a.y + a.height + gap
  );
}

/**
 * Moves the drag tooltip `box` (placed above the marker, or `below` it) off the "now" label
 * `halo` when they touch, keeping it inside the `width` x `height` SVG:
 * 1. past the label on the side of the marker it is already on (higher when above, lower when
 *    below), still centred on the marker, so a tooltip above stays clear of the finger;
 * 2. else beside the label, at the same height, on the side away from the label first;
 * 3. else where it was (nothing fits: a tiny chart).
 * Exported for the tests of the rare fallbacks.
 */
export function placeTooltip(
  box: Box,
  below: boolean,
  halo: Box | null,
  width: number,
  height: number,
): Box {
  if (halo === null || !boxesTouch(box, halo, TOOLTIP_NOW_LABEL_GAP)) return box;
  const fits = (candidate: Box): boolean =>
    candidate.x >= TOOLTIP_MARGIN &&
    candidate.y >= TOOLTIP_MARGIN &&
    candidate.x + candidate.width <= width - TOOLTIP_MARGIN &&
    candidate.y + candidate.height <= height - TOOLTIP_MARGIN;
  const vertical = {
    ...box,
    y: below
      ? halo.y + halo.height + TOOLTIP_NOW_LABEL_GAP
      : halo.y - TOOLTIP_NOW_LABEL_GAP - box.height,
  };
  if (fits(vertical)) return vertical;
  const left = { ...box, x: halo.x - TOOLTIP_NOW_LABEL_GAP - box.width };
  const right = { ...box, x: halo.x + halo.width + TOOLTIP_NOW_LABEL_GAP };
  const labelOnTheRight = halo.x + halo.width / 2 >= box.x + box.width / 2;
  for (const candidate of labelOnTheRight ? [left, right] : [right, left]) {
    if (fits(candidate)) return candidate;
  }
  return box;
}

/** Curve-day key in [0, 1439] -> minutes since midnight (inverse of {@link sortKey}). */
function keyToTime(key: number): number {
  return (key + PIVOT_MINUTES) % MINUTES_PER_DAY;
}

/**
 * Tap tolerance of a pointer type (px, Chebyshev): 8 for 'touch' and 'pen', 3 for 'mouse' and
 * for an unknown type.
 */
function tapSlop(pointerType: string): number {
  return pointerType === 'touch' || pointerType === 'pen' ? TAP_SLOP_TOUCH_PX : TAP_SLOP_MOUSE_PX;
}

/** Sets the pointer capture on `element` when the browser supports it; returns the holder. */
function capturePointer(element: Element | null, pointerId: number): Element | null {
  if (element === null || typeof element.setPointerCapture !== 'function') return null;
  try {
    element.setPointerCapture(pointerId);
    return element;
  } catch {
    // The pointer is no longer active (already released): nothing to capture.
    return null;
  }
}

/** true while `element` (from {@link capturePointer}) still holds the capture of `pointerId`. */
function holdsPointer(element: Element | null, pointerId: number): boolean {
  if (element === null || typeof element.hasPointerCapture !== 'function') return false;
  try {
    return element.hasPointerCapture(pointerId);
  } catch {
    return false;
  }
}

/** Releases a capture taken with {@link capturePointer}. */
function releasePointer(element: Element | null, pointerId: number): void {
  if (element === null || typeof element.releasePointerCapture !== 'function') return;
  try {
    if (typeof element.hasPointerCapture !== 'function' || element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Already released by the browser.
  }
}

@customElement('time-curve-card')
export class TimeCurveCard extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;

  /** Overrides the clock (tests, dev harness); `undefined` = `new Date()`. */
  @property({ attribute: false }) nowProvider?: (() => Date) | undefined;

  @state() private config?: NormalizedConfig;

  /** Width of the chart container in px (0 until measured). */
  @state() private chartWidth = 0;

  /** Bumped every minute by the clock so the "now" marker moves even without a hass change. */
  @state() private tick = 0;

  // --- M3 interaction state (see the interactions spec, section 1) -----------------------------

  /** The curve being edited locally (sorted, values in the range); null = no local edits. */
  @state() private localPoints: CurvePoint[] | null = null;

  /** Index of the selected point in the rendered (sorted) curve; null = nothing selected. */
  @state() private selectedIndex: number | null = null;

  /**
   * Key of the detail row, bumped whenever the selection moves to another point (see
   * {@link selectPoint}): the row's inputs are recreated for each point, never reused.
   */
  private selectionKey = 0;

  /** true while a point is being dragged (the tooltip and the enlarged marker are shown). */
  @state() private dragging = false;

  @state() private saveState: SaveState = 'idle';
  @state() private saveError: string | null = null;

  /** Transient user message (max points, too close, too long...), auto-cleared after 4 s. */
  @state() private message: string | null = null;

  /** The active pointer interaction (plain field: every change comes with a @state change). */
  private drag: DragState | null = null;

  /**
   * The serialized string of the ONE `set_value` call in flight (sent, not yet echoed back by the
   * entity state); null when none is. One call at a time, so an echo always belongs to it.
   */
  private pendingValue: string | null = null;

  /**
   * A debounced save came due while a call was in flight: it runs once that call is echoed back
   * (or fails, which reverts the edits instead).
   */
  private saveDeferred = false;

  /**
   * The value whose echo timed out: when the entity state reaches it later (a slow HA), the
   * save did land and the error is replaced by the "saved" chip.
   */
  private lastFailedValue: string | null = null;

  // Derived from hass in willUpdate() - plain fields, never assigned during render().
  /** Raw state of the curve entity the last time it was parsed (undefined = missing entity). */
  private hassCurveState: string | undefined;
  /** The range {@link hassCurveState} was parsed with (a new config re-parses the state). */
  private hassCurveRange: ValueRange | undefined;
  /** Curve parsed from the entity state (the rendered curve is `localPoints ?? hassPoints`). */
  private hassPoints: CurvePoint[] = [];
  /**
   * true when the STORED curve is valid (the local edits always are): the chart, the detail row
   * and the "now" value are shown only then, otherwise the `.invalid` block (a reset stays on
   * that block until HA echoes the default curve back).
   */
  private valid = false;
  private now = 0;
  /** Curve value at now, in user units; null while the curve is invalid. */
  private nowValue: number | null = null;
  /** The sensor state in centi-units (see {@link sensorCenti}); null when not a number. */
  private sensorValue: number | null = null;
  /** The sensor's `mode` and `reason` attributes (see {@link sensorText}); null when absent. */
  private sensorMode: string | null = null;
  private sensorReason: string | null = null;
  /** The target entity chip: its name and its value text (see {@link targetEntityText}). */
  private targetName: string | null = null;
  private targetText: string | null = null;

  /** Plot area and viewBox of the last rendered chart (pointer coordinates map through them). */
  private chartPlot: PlotArea | null = null;
  private chartViewBox = { width: 0, height: 0 };

  private readonly instanceId = ++instanceCounter;
  private resizeObserver: ResizeObserver | undefined;
  /** The `.chart` container currently observed for its width (null while the curve is invalid). */
  private observedChart: Element | null = null;
  private clockTimeout: ReturnType<typeof setTimeout> | undefined;
  private saveTimeout: ReturnType<typeof setTimeout> | undefined;
  private savedChipTimeout: ReturnType<typeof setTimeout> | undefined;
  private messageTimeout: ReturnType<typeof setTimeout> | undefined;
  private echoTimeout: ReturnType<typeof setTimeout> | undefined;
  private formatterZone: string | undefined;
  private formatter: Intl.DateTimeFormat | undefined;

  static override styles = css`
    :host {
      display: block;
      --tcc-curve: var(
        --time-curve-card-color,
        var(--state-light-active-color, var(--primary-color))
      );
      /* The card surface, as ha-card paints it (themes may override --ha-card-background). */
      --tcc-surface: var(--ha-card-background, var(--card-background-color));
    }
    /*
     * Query container for the chart height (100cqw in .chart = this content-box width) AND
     * inline-size containment: nothing inside the body contributes to the card's min-content
     * width, so a content-sized host (a grid "auto" track, a flex item) can shrink the card down
     * to phone width. The chart must never be an "aspect-ratio" box: during intrinsic sizing a
     * percentage width counts as auto, so its min-height would transfer through the ratio into
     * a 450px minimum WIDTH that locks the card open ("contain: inline-size" on the chart itself
     * does not cancel that transfer in Chromium).
     */
    .body {
      padding: 12px ${BODY_PADDING_X}px 16px;
      color: var(--primary-text-color);
      container-type: inline-size;
    }
    .status {
      display: flex;
      flex-wrap: wrap;
      gap: 2px 16px;
      margin-bottom: 8px;
      font-size: 13px;
      line-height: ${STATUS_LINE_HEIGHT}px;
      color: var(--secondary-text-color);
    }
    .chip {
      white-space: nowrap;
    }
    /*
     * The sensor chip may carry a reason written by the user's sensor (up to 60 characters), the
     * target chip a long friendly name: neither grows past the status row, a narrow card cuts
     * them with an ellipsis (full text of a reason in the title of .reason).
     */
    .chip.sensor,
    .chip.target {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .value {
      color: var(--primary-text-color);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    /*
     * Save status, last in the status row, in a slot whose size never depends on its text: always
     * in the flex flow (empty while idle), one line high, SAVE_SLOT_EM wide at least (room for
     * the "saving" text) and growing into the rest of its line. The row wraps the same way
     * whatever the save state, so a save starting, ending or failing never moves the chart under
     * the finger. A longer text (an error) is cut with an ellipsis: the message line below the
     * chart shows it in full.
     */
    .save {
      flex: 1 1 ${SAVE_SLOT_EM}em;
      min-width: 0;
      height: ${STATUS_LINE_HEIGHT}px;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: end;
    }
    .save.error {
      color: var(--error-color);
    }
    /*
     * The chart box is sized by CSS alone, with the same rule as the viewBox computed in
     * renderChart (height = width / aspect, clamped), so that a resize never changes it twice:
     * with "height: auto" the SVG would first follow the stale viewBox aspect and then the
     * re-rendered one inside the same ResizeObserver cycle, which raises "ResizeObserver loop
     * completed with undelivered notifications" on every width change. The height is derived
     * from the container-query width, never from "aspect-ratio" (see .body); the plain 180px
     * line is the fallback for browsers without container-query units.
     */
    .chart {
      width: 100%;
      height: ${MIN_CHART_HEIGHT}px;
      height: clamp(${MIN_CHART_HEIGHT}px, calc(100cqw / ${CHART_ASPECT}), ${MAX_CHART_HEIGHT}px);
    }
    /*
     * overflow: visible lets the 44px hit target of a point on the top / right plot edge reach
     * past the SVG box (the browser only hit-tests what the SVG paints). The curve and the
     * markers are clipped, the tooltip and the now label are kept inside the box, and the target
     * of a point outside the window is clipped (see renderChart): only the keyboard focus ring of
     * an edge target may paint up to 8px (HIT_RADIUS - margin) outside, inside the card padding.
     */
    .chart svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
      /* Drags must never scroll the dashboard. */
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      cursor: crosshair;
      outline: none;
    }
    /*
     * Keyboard focus rings only: the host carries [pointer-focus] from a press on the chart (which
     * focuses the pressed point) until the next key press.
     */
    :host(:not([pointer-focus])) .chart svg:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
    /* Only the point hit targets (and the chart background) receive pointer events. */
    .gridlines,
    .ticks,
    .now-line,
    .now,
    .now-outside,
    .tooltip {
      pointer-events: none;
    }
    .grid,
    .tick {
      stroke: var(--divider-color);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }
    .axis-label {
      font-size: 11px;
      fill: var(--secondary-text-color);
      font-variant-numeric: tabular-nums;
    }
    .grad-top {
      stop-color: var(--tcc-curve);
      stop-opacity: 0.2;
    }
    .grad-bottom {
      stop-color: var(--tcc-curve);
      stop-opacity: 0.02;
    }
    .line {
      fill: none;
      stroke: var(--tcc-curve);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .point {
      cursor: grab;
      outline: none;
    }
    .point.dragging {
      cursor: grabbing;
    }
    .point .dot {
      fill: var(--tcc-curve);
      stroke: var(--tcc-surface);
      stroke-width: 2;
    }
    /* Selection: same colour, thicker surface ring (no extra hue for a state). */
    .point.selected .dot {
      stroke-width: 3;
    }
    /* Keyboard focus: a dashed ring on the 44px hit target (never for a pointer-given focus). */
    :host(:not([pointer-focus])) .point:focus-visible .hit {
      stroke: var(--primary-text-color);
      stroke-width: 1;
      stroke-dasharray: 4 3;
      opacity: 0.6;
    }
    .now-line {
      stroke: var(--primary-text-color);
      stroke-width: 1.5;
      opacity: 0.6;
    }
    .now-dot {
      fill: var(--primary-text-color);
      stroke: var(--tcc-surface);
      stroke-width: 2;
    }
    /* Edge marker of a "now" outside the window: the same ink as the now line. */
    .now-edge {
      fill: var(--primary-text-color);
      opacity: 0.6;
    }
    .now-halo {
      fill: var(--tcc-surface);
    }
    .now-label {
      font-size: 12px;
      font-weight: 500;
      fill: var(--primary-text-color);
      font-variant-numeric: tabular-nums;
      /* Fallback halo for a font wider than the .now-halo estimate. */
      paint-order: stroke;
      stroke: var(--tcc-surface);
      stroke-width: 3px;
      stroke-linejoin: round;
    }
    .tooltip rect {
      fill: var(--tcc-surface);
      stroke: var(--divider-color);
      stroke-width: 1;
    }
    .tooltip text {
      font-size: 12px;
      fill: var(--primary-text-color);
      font-variant-numeric: tabular-nums;
    }
    /* Detail row of the selected point: native inputs, 40px touch height, wraps when narrow. */
    .detail {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      margin-top: 10px;
      font-size: 13px;
      color: var(--secondary-text-color);
    }
    .detail label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .detail input,
    .detail button,
    .invalid button {
      box-sizing: border-box;
      min-height: 40px;
      padding: 0 10px;
      font: inherit;
      font-size: 14px;
      color: var(--primary-text-color);
      background: var(--card-background-color);
      border: 1px solid var(--divider-color);
      border-radius: 6px;
    }
    .detail input:focus-visible,
    .detail button:focus-visible,
    .invalid button:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 1px;
    }
    .detail input[type='time'] {
      width: 8em;
    }
    .detail input[type='number'] {
      width: 5em;
    }
    .detail .actions {
      display: flex;
      gap: 8px;
      margin-left: auto;
    }
    .detail button,
    .invalid button {
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .detail button:disabled,
    .invalid button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    /* Explains a disabled "Supprimer", on its own line under the buttons. */
    .detail .hint {
      flex-basis: 100%;
      font-size: 12px;
      color: var(--secondary-text-color);
      text-align: end;
    }
    .message {
      margin-top: 8px;
      font-size: 12px;
      color: var(--primary-text-color);
    }
    /* The empty live region takes no room (no text, no margin: 0 px high). */
    .message.empty {
      margin-top: 0;
    }
    /* The save error in full (the chip may cut it). */
    .message .error {
      color: var(--error-color);
    }
    .notes {
      margin-top: 8px;
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    .invalid {
      padding: 12px 0;
      font-size: 13px;
      line-height: 20px;
      color: var(--secondary-text-color);
    }
    .invalid code {
      display: block;
      margin-top: 4px;
      font-size: 12px;
      color: var(--primary-text-color);
      word-break: break-all;
    }
    .invalid button {
      display: block;
      margin-top: 12px;
    }
  `;

  // -------------------------------------------------------------------------------------------
  // Lovelace card API
  // -------------------------------------------------------------------------------------------

  /** Validates the config (src/config.ts: French messages shown by HA) and applies the defaults. */
  setConfig(config: CardConfig): void {
    const next = normalizeConfig(config);
    const local = this.localPoints;
    if (local !== null) {
      // Local edits survive a new config, their values brought inside its range (the save
      // serializes them with it).
      const { min, max } = next.range;
      this.localPoints = local.map((point) => ({
        time: point.time,
        value: Math.min(max, Math.max(min, point.value)),
      }));
    }
    this.config = next;
  }

  getCardSize(): number {
    return 5;
  }

  getGridOptions(): {
    columns: number | string;
    rows: number | string;
    min_columns: number;
    min_rows: number;
  } {
    return { columns: 12, rows: 'auto', min_columns: 6, min_rows: 4 };
  }

  /**
   * Stub config of the card picker: `{ entity }` without a title, the entity being picked from
   * `hass` when HA passes it (see stubEntity in src/config.ts).
   */
  static getStubConfig(hass?: HomeAssistant): Partial<CardConfig> {
    return stubConfig(hass);
  }

  /** The visual editor (src/editor.ts, registered by src/index.ts). */
  static getConfigElement(): HTMLElement {
    return document.createElement('time-curve-card-editor');
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  override connectedCallback(): void {
    // The observer must exist BEFORE Lit reconnects the `ref` directive (inside
    // super.connectedCallback), which calls chartRef() again when the card is re-added to the
    // DOM: otherwise the .chart container would stay unobserved until it is replaced.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this);
      if (this.observedChart !== null) this.resizeObserver.observe(this.observedChart);
    }
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.startClock();
    // Timers only run while connected: re-arm the ones whose state survived a disconnection.
    if (this.message !== null) this.armMessageTimer();
    if (this.saveState === 'saved') this.armSavedChipTimer();
    if (this.pendingValue !== null) this.armEchoTimeout();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.observedChart = null;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.stopClock();
    // A removed card holds no focus: back to the keyboard modality (drops the document listener).
    this.setPointerModality(false);
    // A drag interrupted by the removal ends here, and the local edits (a scheduled or deferred
    // save, or the in-progress drag) are sent now, even while another call is in flight, rather
    // than lost; the other timers are dropped.
    this.abortDrag();
    if (this.localPoints !== null) {
      this.clearSaveTimer();
      this.saveDeferred = false;
      void this.save(true);
    }
    this.clearSavedChipTimer();
    this.clearMessageTimer();
    this.clearEchoTimeout();
  }

  /**
   * Only re-render for a `hass` change when one of the watched entities (curve, sensor, light)
   * or the HA timezone actually changed: `hass` is reassigned on EVERY state change in HA.
   */
  protected override shouldUpdate(changed: PropertyValues<this>): boolean {
    if (changed.size !== 1 || !changed.has('hass')) return true;
    const prev = changed.get('hass');
    const next = this.hass;
    const config = this.config;
    if (!prev || !next || !config) return true;
    if (prev.config?.time_zone !== next.config?.time_zone) return true;
    // The unit of a climate target's current temperature.
    if (prev.config?.unit_system?.temperature !== next.config?.unit_system?.temperature) {
      return true;
    }
    return this.watchedEntities(config).some((id) => prev.states[id] !== next.states[id]);
  }

  protected override willUpdate(): void {
    this.syncHassCurve();
    this.deriveState();
    // The stored curve turned invalid mid-drag: the chart (and its pointer listeners) goes away,
    // so the drag ends here; a moved point is saved over the invalid value (local edits win).
    if (!this.valid && this.drag !== null) this.endDrag(this.drag);
  }

  // -------------------------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------------------------

  /** The rendered curve: the local edits when there are any, the HA curve otherwise. */
  private get points(): CurvePoint[] {
    return this.localPoints ?? this.hassPoints;
  }

  /** true while the card holds local edits that HA has not echoed back yet. */
  private get dirty(): boolean {
    return this.localPoints !== null;
  }

  /** The value range of the config (brightness before the first setConfig). */
  private get range(): ValueRange {
    return this.config?.range ?? BRIGHTNESS_RANGE;
  }

  /** The value axis domain of the config (0..100 before the first setConfig). */
  private get domain(): AxisDomain {
    return this.config?.axis ?? BRIGHTNESS_AXIS;
  }

  /** `value` with the config's unit and the French decimal comma (see formatQuantity). */
  private display(value: number): string {
    return formatQuantity(value, this.config?.unit ?? '%');
  }

  private watchedEntities(config: NormalizedConfig): string[] {
    const ids = [config.entity];
    if (config.targetSensor !== null) ids.push(config.targetSensor);
    if (config.targetEntity !== null) ids.push(config.targetEntity);
    return ids;
  }

  /** Re-parses the curve entity when its state string changed (interactions spec, section 1.4). */
  private syncHassCurve(): void {
    const config = this.config;
    const state = config && this.hass ? this.hass.states[config.entity]?.state : undefined;
    const range = this.range;
    if (state === this.hassCurveState) {
      // A new config (setConfig) may bring another range: same string, values clamped anew.
      if (range !== this.hassCurveRange) {
        this.hassCurveRange = range;
        this.hassPoints = parseCurve(state, range);
      }
      return;
    }
    // Without local edits the rendered curve is about to be replaced: note the selected point
    // and the pressed one (a press that has not moved yet leaves the card clean).
    const clean = this.localPoints === null;
    const selected =
      clean && this.selectedIndex !== null ? this.hassPoints[this.selectedIndex] : undefined;
    const drag = this.drag;
    const pressed =
      clean && drag !== null && drag.index >= 0 ? this.hassPoints[drag.index] : undefined;
    this.hassCurveState = state;
    this.hassCurveRange = range;
    this.hassPoints = parseCurve(state, range);
    this.onCurveStateChanged(state);
    if (selected !== undefined) this.followSelection(selected.time);
    if (drag !== null && pressed !== undefined) this.followPress(drag, pressed.time);
  }

  /**
   * After an external update of a clean card, the selection follows its point (found by time) to
   * its new index, and the detail row with what the user may be typing in it stays with that
   * point. When the point is gone, the selection keeps its index (clamped to the new curve by
   * deriveState) but that is another point now: its row gets fresh inputs.
   */
  private followSelection(time: number): void {
    const index = this.hassPoints.findIndex((point) => point.time === time);
    // Same point, maybe at another index: the row (keyed on selectionKey) is kept.
    if (index >= 0) this.selectedIndex = index;
    else this.selectPoint(this.selectedIndex, true);
  }

  /**
   * Same for a point pressed but not moved yet: the coming drag moves THAT point, at its new
   * index; when it is gone the press ends (the rest of the gesture changes nothing).
   */
  private followPress(drag: DragState, time: number): void {
    const index = this.hassPoints.findIndex((point) => point.time === time);
    if (index >= 0) drag.index = index;
    else this.abortDrag();
  }

  /**
   * External update of the curve entity. The echo of our own save ends the edit session; a late
   * echo of a save that timed out clears its error; while the user drags or has unsaved edits,
   * the local curve wins (a scheduled / in-flight save will overwrite the external value);
   * otherwise the rendered curve simply follows hass.
   */
  private onCurveStateChanged(state: string | undefined): void {
    if (this.pendingValue !== null && state === this.pendingValue) {
      this.completeSave(state);
      return;
    }
    if (this.saveState === 'error' && state !== undefined && state === this.lastFailedValue) {
      // HA was only slow: the value did land.
      this.lastFailedValue = null;
      this.saveError = null;
      this.markSaved();
    }
  }

  private deriveState(): void {
    const config = this.config;
    const hass = this.hass;
    const points = this.points;
    this.valid = isValidCurve(this.hassPoints) && isValidCurve(points);
    this.now = this.currentMinutes();
    this.nowValue = this.valid ? evaluateCurve(points, this.now, this.range) : null;
    if (this.selectedIndex !== null) {
      if (!this.valid) this.selectPoint(null);
      else if (this.selectedIndex >= points.length) this.selectPoint(points.length - 1);
    }

    this.sensorValue = null;
    this.sensorMode = null;
    this.sensorReason = null;
    if (config?.targetSensor && hass) {
      const sensor = hass.states[config.targetSensor];
      this.sensorValue = sensorCenti(sensor?.state);
      this.sensorMode = sensorText(sensor?.attributes.mode);
      this.sensorReason = sensorText(sensor?.attributes.reason);
    }

    this.targetName = null;
    this.targetText = null;
    if (config?.targetEntity && hass) {
      const target: HassEntity | undefined = hass.states[config.targetEntity];
      const temperatureUnit = hass.config?.unit_system?.temperature ?? '\u{b0}C';
      this.targetName = friendlyName(target);
      this.targetText = targetEntityText(target, temperatureUnit);
    }
  }

  /**
   * Minutes since midnight "now" in HA's timezone (`hass.config.time_zone`), so the marker
   * matches the sensor's `now()` even when the phone is in another zone. Falls back to the
   * browser's local time when the zone is missing or unknown to `Intl`.
   */
  private currentMinutes(): number {
    const date = this.nowProvider ? this.nowProvider() : new Date();
    const timeZone = this.hass?.config?.time_zone;
    if (this.formatterZone !== timeZone) {
      this.formatterZone = timeZone;
      this.formatter = undefined;
      if (timeZone) {
        try {
          this.formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          });
        } catch {
          // Unknown zone: keep the browser clock.
        }
      }
    }
    if (this.formatter) {
      try {
        const parts = this.formatter.formatToParts(date);
        const hour = Number(parts.find((part) => part.type === 'hour')?.value);
        const minute = Number(parts.find((part) => part.type === 'minute')?.value);
        if (Number.isInteger(hour) && Number.isInteger(minute)) {
          return (hour % 24) * 60 + minute;
        }
      } catch {
        // Invalid date: keep the browser clock.
      }
    }
    return date.getHours() * 60 + date.getMinutes();
  }

  // -------------------------------------------------------------------------------------------
  // Clock and size
  // -------------------------------------------------------------------------------------------

  /** Ticks on every minute boundary. */
  private startClock(): void {
    this.stopClock();
    this.scheduleTick();
  }

  /**
   * One self-rescheduling timeout whose delay is recomputed after every tick (instead of a
   * setInterval): when a suspended WebView / hidden tab resumes, the overdue tick fires late
   * but the next one lands on the minute boundary again, in step with the sensor's `now()`.
   */
  private scheduleTick(): void {
    this.clockTimeout = setTimeout(
      () => {
        this.tick++;
        this.scheduleTick();
      },
      60_000 - (Date.now() % 60_000),
    );
  }

  private stopClock(): void {
    if (this.clockTimeout !== undefined) clearTimeout(this.clockTimeout);
    this.clockTimeout = undefined;
  }

  /**
   * Going to the background: send a pending save now (the tab may be killed). Back to the
   * foreground: refresh the "now" marker at once and re-align the clock.
   */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.flushSave();
      return;
    }
    if (document.visibilityState !== 'visible') return;
    this.tick++;
    this.startClock();
  };

  /**
   * ResizeObserver callback (host and `.chart`). A live drag maps its pointer through the SVG box
   * measured at pointerdown: the box may have moved or changed size, so the next pointer event
   * measures it again (after the re-render of the new width, which runs before that event).
   */
  private readonly onResize = (): void => {
    this.syncChartWidth();
    if (this.drag !== null) this.drag.frame = null;
  };

  /**
   * Measures the chart container (falls back to the host width minus the body padding) so that
   * 1 SVG unit = 1 CSS px and the hit targets are real pixels.
   */
  private syncChartWidth(): void {
    const chart = this.renderRoot.querySelector<HTMLElement>('.chart');
    const chartWidth = chart?.clientWidth ?? 0;
    // A 0 measurement (hidden container) falls back to the host, never to a 0-width chart.
    const measured = chartWidth > 0 ? chartWidth : this.clientWidth - 2 * BODY_PADDING_X;
    if (measured > 0 && measured !== this.chartWidth) this.chartWidth = measured;
  }

  /**
   * `ref` callback of the `.chart` container: observing it too (not only the host) gives an
   * exact measurement when the chart appears after the curve became valid, without a resize.
   */
  private readonly chartRef = (chart: Element | undefined): void => {
    const next = chart ?? null;
    if (next === this.observedChart) return;
    if (this.observedChart !== null) this.resizeObserver?.unobserve(this.observedChart);
    this.observedChart = next;
    if (next !== null) this.resizeObserver?.observe(next);
  };

  // -------------------------------------------------------------------------------------------
  // Editing the curve (interactions spec, sections 1.2 and 1.3)
  // -------------------------------------------------------------------------------------------

  /**
   * Makes `next` the local curve (sorted) and optionally schedules a save. Refused, with a
   * message, when the serialized curve would not fit in the `input_text` helper.
   */
  private applyPoints(next: readonly CurvePoint[], options: { save: boolean }): boolean {
    const sorted = sortCurve(next);
    const length = serializeCurve(sorted, this.range).length;
    if (length > MAX_CURVE_LENGTH) {
      this.showMessage(
        `Courbe trop longue pour input_text (${length} > ${MAX_CURVE_LENGTH} caract\u00e8res)`,
      );
      return false;
    }
    this.localPoints = sorted;
    if (options.save) this.scheduleSave();
    return true;
  }

  /** Moves point `index` to `time` / `value` (no-op when it is already there). */
  private movePoint(index: number, time: number, value: number, save: boolean): boolean {
    const points = this.points;
    const current = points[index];
    if (current === undefined) return false;
    if (current.time === time && current.value === value) return true;
    const next = points.map((point, i) => (i === index ? { time, value } : point));
    return this.applyPoints(next, { save });
  }

  /**
   * Removes point `index` (never below MIN_POINTS) and saves; the caller moves the selection.
   * Returns false when nothing was removed.
   */
  private deletePoint(index: number): boolean {
    const points = this.points;
    if (points.length <= MIN_POINTS || points[index] === undefined) return false;
    return this.applyPoints(
      points.filter((_, i) => i !== index),
      { save: true },
    );
  }

  /**
   * Selects point `index` (null = nothing). The detail row is keyed on the selection, so moving
   * it to another point recreates the inputs: a value typed for one point never shows on the
   * next. `another` says a different point took the same index (added, or after a deletion).
   */
  private selectPoint(index: number | null, another = false): void {
    if (another || index !== this.selectedIndex) this.selectionKey++;
    this.selectedIndex = index;
  }

  /** Index of the point at `time` in the rendered curve (-1 when it no longer exists). */
  private indexOfTime(time: number): number {
    return this.points.findIndex((point) => point.time === time);
  }

  /**
   * The window a dragged point may occupy: when `window_end` is 12:00 (key 1440) the last step
   * is excluded, because key 1440 is the pivot again (12:00, key 0) and a point there would jump
   * to the start of the curve day.
   */
  private dragWindow(config: NormalizedConfig): TimeWindow {
    const { window, snapMinutes } = config;
    if (window.endKey !== CURVE_DAY_END_KEY) return window;
    return { startKey: window.startKey, endKey: CURVE_DAY_END_KEY - snapMinutes };
  }

  /**
   * Snaps a candidate key of point `index` to the step and clamps it between its neighbours (one
   * step away) and inside the window (interactions spec, section 1.3). The key is null when they
   * leave no room at all (points already closer than a step, or a neighbour on the window edge):
   * the time of the point must not change then, a clamp would put it past a neighbour or outside.
   */
  private resolveKey(rawKey: number, index: number, points: readonly CurvePoint[]): KeyResolution {
    const config = this.config;
    const step = config?.snapMinutes ?? DEFAULT_SNAP_MINUTES;
    const snapped = roundHalfUp(rawKey / step) * step;
    if (!config) return { key: null, snapped, clampedBy: null };
    const window = this.dragWindow(config);
    const prev = points[index - 1];
    const next = points[index + 1];
    const prevKey = prev === undefined ? null : sortKey(prev.time);
    const nextKey = next === undefined ? null : sortKey(next.time);
    const afterPrev = prevKey === null ? -Infinity : prevKey + step;
    const beforeNext = nextKey === null ? Infinity : nextKey - step;
    const lower = Math.max(window.startKey, afterPrev);
    const upper = Math.min(window.endKey, beforeNext);
    if (lower > upper) return { key: null, snapped, clampedBy: null };
    const key = clampKeyBetween(snapped, prevKey, nextKey, step, window);
    let clampedBy: KeyResolution['clampedBy'] = null;
    if (key < snapped) clampedBy = window.endKey <= beforeNext ? 'window' : 'neighbour';
    else if (key > snapped) clampedBy = window.startKey >= afterPrev ? 'window' : 'neighbour';
    return { key, snapped, clampedBy };
  }

  /** Drags point `index` towards the SVG coordinates (x, y); a refused time keeps the old one. */
  private dragPointTo(index: number, x: number, y: number): void {
    const config = this.config;
    const plot = this.chartPlot;
    const points = this.points;
    const point = points[index];
    if (!config || plot === null || point === undefined) return;
    const { key } = this.resolveKey(xToKey(x, config.window, plot), index, points);
    const time = key === null ? point.time : keyToTime(key);
    const value = clampValue(yToValue(y, plot, config.axis), config.range);
    this.movePoint(index, time, value, false);
  }

  /**
   * Adds a point at the SVG coordinates (x, y) of a tap on the chart background. The time is
   * snapped in KEY space, so a tap at the right edge of a window ending at 12:00 rounds to key
   * 1440 (outside the drag window) instead of wrapping to 12:00 at the start of the curve day.
   */
  private addPointAt(x: number, y: number): void {
    const config = this.config;
    const plot = this.chartPlot;
    if (!config || plot === null) return;
    const inside =
      x >= plot.x && x <= plot.x + plot.width && y >= plot.y && y <= plot.y + plot.height;
    if (!inside) return;
    const points = this.points;
    if (points.length >= config.maxPoints) {
      this.showMessage(`Nombre maximal de points atteint (${config.maxPoints})`);
      return;
    }
    const step = config.snapMinutes;
    const key = roundHalfUp(xToKey(x, config.window, plot) / step) * step;
    if (!isKeyVisible(key, this.dragWindow(config))) {
      this.showMessage('En dehors de la fen\u00eatre affich\u00e9e');
      return;
    }
    if (points.some((point) => Math.abs(sortKey(point.time) - key) < step)) {
      this.showMessage("Trop proche d'un point existant");
      return;
    }
    const time = keyToTime(key);
    const value = clampValue(yToValue(y, plot, config.axis), config.range);
    if (!this.applyPoints([...points, { time, value }], { save: true })) return;
    this.selectPoint(this.indexOfTime(time), true);
  }

  /** Nudges the time of point `index` by `deltaMinutes` (keyboard), through the drag clamp. */
  private nudgeTime(index: number, deltaMinutes: number): void {
    const points = this.points;
    const point = points[index];
    if (point === undefined) return;
    const { key } = this.resolveKey(sortKey(point.time) + deltaMinutes, index, points);
    if (key === null) return;
    this.movePoint(index, keyToTime(key), point.value, true);
  }

  /**
   * Nudges the value of point `index` by `steps` grid steps of the config (keyboard), clamped to
   * the range (see stepValue: an off-grid value first moves to the grid).
   */
  private nudgeValue(index: number, steps: number): void {
    const point = this.points[index];
    if (point === undefined) return;
    this.movePoint(index, point.time, stepValue(point.value, steps, this.range), true);
  }

  private showMessage(text: string): void {
    this.message = text;
    this.armMessageTimer();
  }

  private armMessageTimer(): void {
    this.clearMessageTimer();
    if (!this.isConnected) return;
    this.messageTimeout = setTimeout(() => {
      this.messageTimeout = undefined;
      this.message = null;
    }, MESSAGE_MS);
  }

  private clearMessageTimer(): void {
    if (this.messageTimeout !== undefined) clearTimeout(this.messageTimeout);
    this.messageTimeout = undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Pointer interactions (interactions spec, section 2)
  // -------------------------------------------------------------------------------------------

  /** Measures the SVG's bounding box against its viewBox (one layout read). */
  private measureFrame(svgElement: EventTarget | null): SvgFrame {
    if (!(svgElement instanceof Element)) return { left: 0, top: 0, scale: 1 };
    const rect = svgElement.getBoundingClientRect();
    // happy-dom (and a hidden card) report a 0 width: 1 unit = 1 px then.
    const scale = rect.width > 0 ? this.chartViewBox.width / rect.width : 1;
    return { left: rect.left, top: rect.top, scale };
  }

  /**
   * Client coordinates -> SVG user units, through the SVG box cached by the interaction (the
   * listeners sit on the SVG, so `currentTarget` is the SVG when the cache must be refilled).
   */
  private toSvgPoint(event: PointerEvent, drag: DragState): { x: number; y: number } {
    const frame = drag.frame ?? this.measureFrame(event.currentTarget);
    drag.frame = frame;
    return {
      x: (event.clientX - frame.left) * frame.scale,
      y: (event.clientY - frame.top) * frame.scale,
    };
  }

  /** Press on a point (drag / tap-select) or on the chart background (tap-add). */
  private readonly onPointerDown = (event: PointerEvent): void => {
    // Secondary mouse buttons are not an interaction; a second finger during a drag is ignored.
    if (event.button > 0) return;
    const stale = this.drag;
    if (stale !== null) {
      if (stale.pointerId !== event.pointerId && holdsPointer(stale.capture, stale.pointerId)) {
        return;
      }
      // The previous interaction never ended (a missed pointerup, or its pointer is gone and
      // the capture with it): close it, saving a point it moved, before this one starts.
      this.endDrag(stale);
    }
    const target = event.target;
    const group = target instanceof Element ? target.closest('g.point') : null;
    const index = group === null ? -1 : Number(group.getAttribute('data-index'));
    if (group !== null && (!Number.isInteger(index) || this.points[index] === undefined)) return;
    // Pointer modality: the focus given to the pressed point paints no keyboard focus ring.
    this.setPointerModality(true);
    // A value typed in the detail row commits to ITS point before the selection moves (the
    // preventDefault below would otherwise keep the input focused, a mouse press blurs nothing).
    this.commitDetailInput();
    event.preventDefault();
    // A point drag captures on the pressed element itself (its hit circle, or the marker drawn
    // over it), a background press on the SVG; captured events still bubble to the SVG
    // listeners. The SVG box is measured once here for the whole interaction.
    const svgElement = event.currentTarget instanceof Element ? event.currentTarget : null;
    const holder = group === null || !(target instanceof Element) ? svgElement : target;
    const frame = this.measureFrame(svgElement);
    // Where the point was grabbed: the drag keeps the marker at that offset from the pointer.
    // Read after the commit above, which may have just moved this very point (a value typed for
    // it); indices are stable (a commit never moves a point past a neighbour).
    let grabX = 0;
    let grabY = 0;
    const config = this.config;
    const plot = this.chartPlot;
    const point = group === null ? undefined : this.points[index];
    if (point !== undefined && config && plot !== null) {
      grabX =
        keyToX(sortKey(point.time), config.window, plot) -
        (event.clientX - frame.left) * frame.scale;
      grabY = valueToY(point.value, plot, config.axis) - (event.clientY - frame.top) * frame.scale;
    }
    this.drag = {
      index: group === null ? -1 : index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      slop: tapSlop(event.pointerType),
      moved: false,
      capture: capturePointer(holder, event.pointerId),
      frame,
      grabX,
      grabY,
    };
    if (group !== null) {
      this.selectPoint(index);
      // Keyboard nudges work right after a tap; SVG groups with tabindex are focusable.
      focusElement(group);
    }
  };

  /**
   * Blurs a focused detail-row input: the browser fires its pending `change` right away, which
   * the row's handlers apply to the point that row was rendered for.
   */
  private commitDetailInput(): void {
    let active: Element | null = null;
    try {
      active = this.shadowRoot?.activeElement ?? null;
    } catch {
      // happy-dom (tests) throws when the focus is inside ANOTHER shadow tree (e.g. a second
      // card); browsers return null there, which is what this fallback means.
    }
    if (active instanceof HTMLElement && active.closest('.detail') !== null) active.blur();
  }

  /**
   * Enters (a press on the chart) or leaves (a key press, the card removed) the pointer modality:
   * the host attribute hides the keyboard focus rings. While it is set, a capture-phase keydown
   * listener on the DOCUMENT watches for the next key, wherever the focus is: a Tab pressed
   * outside the card (after a click elsewhere) that brings the focus back in must show the ring.
   */
  private setPointerModality(on: boolean): void {
    if (on === this.hasAttribute(POINTER_FOCUS_ATTRIBUTE)) return;
    if (on) {
      this.setAttribute(POINTER_FOCUS_ATTRIBUTE, '');
      document.addEventListener('keydown', this.onDocumentKeyDown, true);
    } else {
      this.removeAttribute(POINTER_FOCUS_ATTRIBUTE);
      document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    }
  }

  /**
   * Any key (without Alt / Ctrl / Meta, like the browsers' own :focus-visible heuristic: a
   * shortcut is not keyboard navigation) switches back to the keyboard modality.
   */
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    this.setPointerModality(false);
  };

  /** Focuses, once the pending render is done, the element `find` returns from it. */
  private focusAfterUpdate(find: () => Element | null): void {
    void this.updateComplete.then(() => {
      focusElement(find());
    });
  }

  /** Moves the focus to the chart itself (after Escape, "Fermer", "Supprimer"). */
  private focusChart(): void {
    this.focusAfterUpdate(() => this.renderRoot.querySelector('.chart svg'));
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag?.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      const travel = Math.max(
        Math.abs(event.clientX - drag.startX),
        Math.abs(event.clientY - drag.startY),
      );
      if (travel < drag.slop) return;
      drag.moved = true;
    }
    if (drag.index < 0) return; // a swipe on the background drags nothing
    this.dragging = true;
    const { x, y } = this.toSvgPoint(event, drag);
    // The marker keeps the offset at which it was grabbed: it moves WITH the pointer instead of
    // jumping under it (a vertical drag started off-centre does not change the time).
    this.dragPointTo(drag.index, x + drag.grabX, y + drag.grabY);
  };

  /** pointerup / pointercancel / lostpointercapture: the interaction of this pointer is over. */
  private readonly onPointerEnd = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag?.pointerId !== event.pointerId) return;
    this.endDrag(drag);
    if (event.type !== 'pointerup' || drag.moved) return;
    // A tap: on a point it stays selected (done at pointerdown); on the background it adds one.
    if (drag.index < 0) {
      const { x, y } = this.toSvgPoint(event, drag);
      this.addPointAt(x, y);
    }
  };

  /** Releases the capture, clears the drag state and schedules a save when the point moved. */
  private endDrag(drag: DragState): void {
    releasePointer(drag.capture, drag.pointerId);
    if (this.drag === drag) this.drag = null;
    this.dragging = false;
    if (drag.moved && drag.index >= 0) this.scheduleSave();
  }

  /** Stops the active interaction without saving anything (the caller decides what happens). */
  private abortDrag(): void {
    const drag = this.drag;
    if (drag === null) return;
    releasePointer(drag.capture, drag.pointerId);
    this.drag = null;
    this.dragging = false;
  }

  /** true while a point is being dragged (past the tap tolerance): its position is not final. */
  private get draggingPoint(): boolean {
    return this.drag !== null && this.drag.moved && this.drag.index >= 0;
  }

  /** Focusing a point group (Tab) selects it. */
  private readonly onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    const group = target instanceof Element ? target.closest('g.point') : null;
    if (group === null) return;
    const index = Number(group.getAttribute('data-index'));
    if (Number.isInteger(index) && this.points[index] !== undefined) this.selectPoint(index);
  };

  /**
   * Keyboard editing of the selected point (interactions spec, section 3). Alt / Ctrl / Meta
   * combinations are left to the browser and the OS (shortcuts), only Shift changes the step.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const config = this.config;
    const index = this.selectedIndex;
    if (!config || index === null || this.points[index] === undefined) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const factor = event.shiftKey ? KEYBOARD_SHIFT_FACTOR : 1;
    switch (event.key) {
      case 'ArrowLeft':
        this.nudgeTime(index, -config.snapMinutes * factor);
        break;
      case 'ArrowRight':
        this.nudgeTime(index, config.snapMinutes * factor);
        break;
      case 'ArrowUp':
        this.nudgeValue(index, factor);
        break;
      case 'ArrowDown':
        this.nudgeValue(index, -factor);
        break;
      case 'Delete':
      case 'Backspace':
        // The neighbour (the next point, the previous one for the last) takes the selection and
        // the focus, so that repeated presses keep working.
        if (this.deletePoint(index)) {
          const neighbour = Math.min(index, this.points.length - 1);
          this.selectPoint(neighbour, true);
          this.focusAfterUpdate(() =>
            this.renderRoot.querySelector(`g.point[data-index="${neighbour}"]`),
          );
        }
        break;
      case 'Escape':
        this.selectPoint(null);
        this.focusChart();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // -------------------------------------------------------------------------------------------
  // Detail row (interactions spec, section 6)
  // -------------------------------------------------------------------------------------------

  /**
   * `change` of the time input of the row rendered for the point at `time` (not necessarily the
   * selected one any more: the change of a blurred input can arrive after the selection moved).
   * Snapped and clamped like a drag; the message says what changed the requested time, in this
   * priority: no room at all, the window, a neighbour, the snap alone.
   */
  private onTimeChange(event: Event, time: number): void {
    const input = event.currentTarget;
    const index = this.indexOfTime(time);
    const point = this.points[index];
    if (!(input instanceof HTMLInputElement) || point === undefined) return;
    const requested = parseTime(input.value.slice(0, 5));
    if (requested === null) {
      this.showMessage('Heure invalide');
    } else if (requested !== point.time) {
      const requestedKey = this.typedKey(requested, sortKey(point.time));
      const { key, snapped, clampedBy } = this.resolveKey(requestedKey, index, this.points);
      if (key === null) {
        this.showMessage('Pas de place entre les points voisins');
      } else {
        if (clampedBy === 'window') {
          this.showMessage('Heure limit\u00e9e \u00e0 la fen\u00eatre affich\u00e9e');
        } else if (clampedBy === 'neighbour') {
          this.showMessage('Heure ajust\u00e9e pour rester entre les points voisins');
        } else if (snapped !== requestedKey) {
          this.showMessage(`Heure arrondie \u00e0 ${formatTime(keyToTime(key))}`);
        }
        this.movePoint(index, keyToTime(key), point.value, true);
      }
    }
    // The field shows the time the point has now (refused or adjusted changes included); Lit
    // only writes the binding when that time changed.
    this.syncInput(input, formatTime(this.points[index]?.time ?? point.time));
  }

  /**
   * Curve-day key of a time typed for a point whose key is `currentKey`. 12:00 is both ends of
   * the curve day: key 0 (start) or 1440 (end, where a window ending at 12:00 shows it). It is
   * the end when the window shows 12:00 only there, the nearer end when the window shows both
   * (12:00 -> 12:00), the start otherwise.
   */
  private typedKey(requested: number, currentKey: number): number {
    const key = sortKey(requested);
    const window = this.config?.window;
    if (key !== 0 || window?.endKey !== CURVE_DAY_END_KEY) return key;
    if (window.startKey > 0) return CURVE_DAY_END_KEY;
    return currentKey >= CURVE_DAY_END_KEY / 2 ? CURVE_DAY_END_KEY : 0;
  }

  /**
   * `change` of the value input of the row rendered for the point at `time`: a decimal number
   * with a dot or a French comma, snapped to the step and clamped to the range like a drag.
   */
  private onValueChange(event: Event, time: number): void {
    const input = event.currentTarget;
    const index = this.indexOfTime(time);
    const point = this.points[index];
    if (!(input instanceof HTMLInputElement) || point === undefined) return;
    const parsed = parseDecimal(input.value);
    if (parsed === null) this.showMessage('Valeur invalide');
    else this.movePoint(index, point.time, clampValue(parsed, this.range), true);
    // Snapped, clamped, refused (too long) or invalid: the field shows the value the point has.
    this.syncInput(input, formatValue(this.points[index]?.value ?? point.value));
  }

  /** Writes `text` into a detail input that does not show it (after a refused / adjusted edit). */
  private syncInput(input: HTMLInputElement, text: string): void {
    if (input.value !== text) input.value = text;
  }

  private readonly onDeleteClick = (): void => {
    const index = this.selectedIndex;
    if (index === null || !this.deletePoint(index)) return;
    this.selectPoint(null);
    this.focusChart();
  };

  private readonly onCloseClick = (): void => {
    this.selectPoint(null);
    this.focusChart();
  };

  /**
   * "R\u00e9initialiser la courbe" on an invalid curve: writes the default curve of the config
   * (`default_curve`, else the preset's) at once.
   */
  private readonly onResetClick = (): void => {
    const config = this.config;
    if (this.saveState === 'saving' || !config) return;
    const points = parseCurve(config.defaultCurve, config.range);
    if (this.applyPoints(points, { save: true })) this.flushSave();
  };

  // -------------------------------------------------------------------------------------------
  // Persistence (interactions spec, section 5)
  // -------------------------------------------------------------------------------------------

  /**
   * Debounced save: re-armed on every call, so a burst of edits ends in one service call. A
   * debounce that comes due while a point is being dragged (a drag started less than 400 ms
   * after the previous edit) is re-armed instead of writing the intermediate position: it can
   * only fire once the drag is over, and the drag's pointerup schedules the real save anyway.
   * A drag whose pointer is gone (its capture lost without any end event reaching the card) is
   * not live any more: it is ended there, and the save goes out.
   */
  private scheduleSave(): void {
    this.clearSaveTimer();
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = undefined;
      const drag = this.drag;
      if (drag !== null && this.draggingPoint) {
        // Without capture support (capture null) a live drag cannot be told from a stale one.
        if (drag.capture === null || holdsPointer(drag.capture, drag.pointerId)) {
          this.scheduleSave();
          return;
        }
        this.endDrag(drag); // schedules the save of the moved point: sent right below
        this.clearSaveTimer();
      }
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Sends the local edits right away (page hidden, card removed, reset button) when a save is
   * scheduled or waiting for the call in flight: the page may be gone before either comes due,
   * so this one does not wait for the in-flight call.
   */
  private flushSave(): void {
    if (this.saveTimeout === undefined && !this.saveDeferred) return;
    this.clearSaveTimer();
    this.saveDeferred = false;
    void this.save(true);
  }

  private clearSaveTimer(): void {
    if (this.saveTimeout !== undefined) clearTimeout(this.saveTimeout);
    this.saveTimeout = undefined;
  }

  /**
   * Writes the local curve to the `input_text` helper. "Saved" is only shown once the entity
   * state echoes the value back (a resolved call proves nothing: HA logs "Invalid value" without
   * raising when the value is too long); the echo timeout turns a missing echo into an error.
   *
   * One call in flight at a time: while one is, a new save waits for its echo (`saveDeferred`),
   * so an echo can only belong to that call (matching it by value is then unambiguous, even
   * when the edits go X -> Y -> X). `force` (page hidden, card removed) sends at once anyway:
   * the page may be gone before the echo.
   */
  private async save(force = false): Promise<void> {
    const config = this.config;
    const hass = this.hass;
    const local = this.localPoints;
    if (!config || !hass || local === null) return;
    const value = serializeCurve(local, config.range);
    // Compare with the value HA WILL hold: the in-flight one when there is one.
    if (value === this.pendingValue) return; // already sent: its echo ends the session
    if (this.pendingValue !== null && !force) {
      this.saveDeferred = true; // sent once the call in flight is echoed (see completeSave)
      return;
    }
    if (this.pendingValue === null && value === hass.states[config.entity]?.state) {
      // Nothing to write: the local edits ended where HA already is.
      this.localPoints = null;
      this.saveDeferred = false;
      // A save whose echo came back while these edits were still open is now complete.
      if (this.saveState === 'saving') this.markSaved();
      return;
    }
    this.saveDeferred = false;
    this.pendingValue = value;
    this.lastFailedValue = null;
    this.clearEchoTimeout();
    this.saveError = null;
    this.saveState = 'saving';
    let failure: string | null = null;
    try {
      await hass.callService('input_text', 'set_value', { entity_id: config.entity, value });
    } catch (error) {
      failure = errorMessage(error);
    }
    // Already echoed back, or superseded by a newer save: this call has nothing left to say.
    if (this.pendingValue !== value) return;
    if (failure !== null) {
      this.failSave(`Erreur d'enregistrement${NBSP}: ${failure}`);
      return;
    }
    this.armEchoTimeout();
  }

  /**
   * The entity state echoed the pending value. The edit session is over only when the local
   * curve is that value: edits made after the save was sent are kept, and the chip stays on
   * "saving" until their own save is echoed. When that save was waiting for this echo it goes
   * out right after the current update (never from inside it: an echo arriving during the update
   * would not be seen).
   */
  private completeSave(state: string): void {
    this.pendingValue = null;
    this.clearEchoTimeout();
    if (this.localPoints !== null && serializeCurve(this.localPoints, this.range) === state) {
      this.localPoints = null;
    }
    if (this.localPoints === null) {
      this.saveDeferred = false;
      this.markSaved();
      return;
    }
    if (this.saveDeferred) {
      void this.updateComplete.then(() => {
        this.runDeferredSave();
      });
    }
  }

  /**
   * Sends a save that waited for the call in flight, unless something else sends it: a debounce
   * armed since (newer edits), a drag in progress (its release schedules one), or a newer call.
   */
  private runDeferredSave(): void {
    if (!this.saveDeferred || this.pendingValue !== null) return;
    if (this.saveTimeout !== undefined || this.draggingPoint) return;
    void this.save();
  }

  /** The "saved" chip, for 2 s. */
  private markSaved(): void {
    this.saveState = 'saved';
    this.armSavedChipTimer();
  }

  /**
   * A save failed (rejected, or never echoed): a drag in progress is aborted (its position is
   * dropped, nothing more is saved), then the card reverts to the last known HA state.
   */
  private failSave(message: string): void {
    this.abortDrag();
    this.clearSaveTimer();
    this.clearEchoTimeout();
    this.saveDeferred = false;
    this.pendingValue = null;
    this.localPoints = null;
    this.selectPoint(null);
    this.saveError = message;
    this.saveState = 'error';
  }

  private armEchoTimeout(): void {
    this.clearEchoTimeout();
    if (!this.isConnected) return;
    this.echoTimeout = setTimeout(() => {
      this.echoTimeout = undefined;
      const timedOut = this.pendingValue;
      if (timedOut === null) return;
      this.failSave(
        "Valeur refus\u00e9e par Home Assistant (v\u00e9rifiez max: 255 sur l'input_text)",
      );
      // Remembered after failSave(): a late echo of this value turns the error into "saved".
      this.lastFailedValue = timedOut;
    }, ECHO_TIMEOUT_MS);
  }

  private clearEchoTimeout(): void {
    if (this.echoTimeout !== undefined) clearTimeout(this.echoTimeout);
    this.echoTimeout = undefined;
  }

  private armSavedChipTimer(): void {
    this.clearSavedChipTimer();
    if (!this.isConnected) return;
    this.savedChipTimeout = setTimeout(() => {
      this.savedChipTimeout = undefined;
      if (this.saveState === 'saved') this.saveState = 'idle';
    }, SAVED_CHIP_MS);
  }

  private clearSavedChipTimer(): void {
    if (this.savedChipTimeout !== undefined) clearTimeout(this.savedChipTimeout);
    this.savedChipTimeout = undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  override render(): TemplateResult | typeof nothing {
    const config = this.config;
    if (!config) return nothing;
    return html`
      <ha-card .header=${config.title ?? ''}>
        <div class="body">
          ${this.renderStatus(config)}
          ${this.valid ? this.renderChart(config) : this.renderInvalid(config)}
          ${this.renderDetail(config)} ${this.renderMessage()} ${this.renderNotes(config)}
        </div>
      </ha-card>
    `;
  }

  private renderStatus(config: NormalizedConfig): TemplateResult {
    return html`
      <div class="status">
        <span class="chip now">
          Maintenant <span class="value">${formatTime(this.now)}</span>
          ${
            this.nowValue === null
              ? nothing
              : html` ${MIDDOT} <span class="value">${this.display(this.nowValue)}</span>`
          }
        </span>
        ${config.targetSensor === null ? nothing : this.renderSensorChip()}
        ${config.targetEntity === null ? nothing : this.renderTargetChip()} ${this.renderSaveChip()}
      </div>
    `;
  }

  /**
   * "Capteur" + the sensor value and, after a middle dot, the note of {@link sensorNote}. A reason
   * given by the sensor is plain text (Lit escapes it), cut to REASON_MAX_LENGTH characters, with
   * its full text in the `title`; the chip itself never grows past the status row (ellipsis).
   */
  private renderSensorChip(): TemplateResult {
    const value = this.sensorValue;
    // Exact comparison in centi-units (both sides are whole hundredths).
    const nowCenti = this.nowValue === null ? null : toCenti(this.nowValue);
    const note = sensorNote(this.sensorMode, this.sensorReason, value, nowCenti);
    return html`
      <span class="chip sensor">
        Capteur
        <span class="value">${value === null ? 'indisponible' : this.display(value / 100)}</span>
        ${
          note === null
            ? nothing
            : html` ${MIDDOT}
                <span class="reason" title=${note.title ?? nothing}>${note.text}</span>`
        }
      </span>
    `;
  }

  /** The target entity: its friendly name (or "Appareil") and its state (targetEntityText). */
  private renderTargetChip(): TemplateResult {
    return html`<span class="chip target"
      >${this.targetName ?? TARGET_FALLBACK_NAME}
      <span class="value">${this.targetText ?? 'indisponible'}</span></span
    >`;
  }

  /**
   * The save status: ONE persistent polite live region whose text changes (a region inserted
   * together with its text is often not announced); an error is also an alert. The chip is a
   * slot of fixed size (see styles): whatever its text, the status row keeps its layout and the
   * chart never moves. A text too long for the slot is cut with an ellipsis; the full error is in
   * the title and in the message line (see renderMessage).
   */
  private renderSaveChip(): TemplateResult {
    const state = this.saveState;
    let content: TemplateResult | string | typeof nothing = nothing;
    if (state === 'saving') content = 'Enregistrement\u2026';
    else if (state === 'saved') content = 'Enregistr\u00e9';
    else if (state === 'error') content = html`<span role="alert">${this.saveError}</span>`;
    const title = state === 'error' ? (this.saveError ?? nothing) : nothing;
    return html`<span class="chip save ${state}" role="status" aria-live="polite" title=${title}
      >${content}</span
    >`;
  }

  /**
   * The message line: a persistent polite live region, emptied instead of removed (with no
   * margin when empty, so it takes no room). It shows the transient message, else the save error
   * in full (the chip may cut it); that copy is hidden from assistive technologies, which get
   * the error from the chip's alert already. Below the chart and the detail row, a message that
   * appears never moves what the user is touching.
   */
  private renderMessage(): TemplateResult {
    const error = this.saveState === 'error' ? this.saveError : null;
    const empty = this.message === null && error === null;
    let content: TemplateResult | string | typeof nothing = nothing;
    if (this.message !== null) content = this.message;
    else if (error !== null) content = html`<span class="error" aria-hidden="true">${error}</span>`;
    return html`<div class="message${empty ? ' empty' : ''}" role="status" aria-live="polite">
      ${content}
    </div>`;
  }

  private renderInvalid(config: NormalizedConfig): TemplateResult {
    const hass = this.hass;
    const entity = hass?.states[config.entity];
    // A missing or unavailable helper gets no reset button: the write would be rejected, or
    // (HA starting up) would overwrite the user's curve as soon as the helper is back.
    // `unknown` is different: a new input_text without `initial:` has never been written (HA
    // restores a written value across restarts), so there is no curve to lose and the reset
    // button is exactly what the first start needs.
    if (entity === undefined || entity.state === 'unavailable') {
      const missing = hass !== undefined && entity === undefined;
      return html`
        <div class="invalid ${missing ? 'missing' : 'unavailable'}">
          ${missing ? 'Entit\u00e9 introuvable' : 'Entit\u00e9 indisponible'}
          <code>${config.entity}</code>
        </div>
      `;
    }
    return html`
      <div class="invalid">
        Courbe invalide ou vide.
        ${
          entity.state === '' || entity.state === 'unknown'
            ? nothing
            : html`<code>${entity.state}</code>`
        }
        <button
          type="button"
          class="reset"
          ?disabled=${this.saveState === 'saving'}
          @click=${this.onResetClick}
        >
          ${RESET_LABEL}
        </button>
      </div>
    `;
  }

  private renderDetail(config: NormalizedConfig): TemplateResult | typeof nothing {
    const index = this.selectedIndex;
    if (index === null || !this.valid) return nothing;
    const point = this.points[index];
    if (point === undefined) return nothing;
    const canDelete = this.points.length > MIN_POINTS;
    // The handlers are bound to THIS point (its time), not to the selection: a `change` fired by
    // a blur after the selection moved still lands on the point the field was showing.
    const time = point.time;
    const onTime = (event: Event): void => {
      this.onTimeChange(event, time);
    };
    const onValue = (event: Event): void => {
      this.onValueChange(event, time);
    };
    // The plain `.value` bindings (no live()) are written only when the point's value changes:
    // an unrelated re-render (the clock, a sensor update) never overwrites what the user types.
    const row = html`
      <div class="detail">
        <label>
          Heure
          <input
            type="time"
            step="${config.snapMinutes * 60}"
            .value=${formatTime(point.time)}
            @change=${onTime}
          />
        </label>
        <label>
          ${config.label}
          <input
            type="number"
            lang="fr"
            min=${config.range.min}
            max=${config.range.max}
            step=${config.range.step}
            inputmode=${
              Number.isInteger(config.range.step) && config.range.min >= 0 ? 'numeric' : 'decimal'
            }
            .value=${formatValue(point.value)}
            @change=${onValue}
          />
          ${config.unit}
        </label>
        <span class="actions">
          <button
            type="button"
            class="delete"
            ?disabled=${!canDelete}
            title=${canDelete ? nothing : DELETE_HINT}
            aria-describedby=${canDelete ? nothing : DELETE_HINT_ID}
            @click=${this.onDeleteClick}
          >
            Supprimer
          </button>
          <button type="button" class="close" @click=${this.onCloseClick}>Fermer</button>
        </span>
        ${canDelete ? nothing : html`<span class="hint" id=${DELETE_HINT_ID}>${DELETE_HINT}</span>`}
      </div>
    `;
    // Keyed on the selection: another point gets fresh inputs, never the ones of the last point.
    return html`${keyed(this.selectionKey, row)}`;
  }

  /**
   * The footer notes, one line each: how many points lie outside the window, and where "now"
   * lies when it is outside the window (M5: the chart only shows it as an edge marker then).
   */
  private renderNotes(config: NormalizedConfig): TemplateResult | typeof nothing {
    if (!this.valid) return nothing;
    const outside = this.points.filter(
      (point) => !isKeyVisible(sortKey(point.time), config.window),
    ).length;
    const side = this.nowSide();
    if (outside === 0 && (side === null || side === 'inside')) return nothing;
    let pointsNote: string | null = null;
    if (outside === 1) pointsNote = '1 point hors de la fen\u00eatre affich\u00e9e';
    else if (outside > 1) pointsNote = `${outside} points hors de la fen\u00eatre affich\u00e9e`;
    let nowNote: string | null = null;
    if (side === 'before' || side === 'after') {
      const where = side === 'before' ? NOW_BEFORE_WINDOW : NOW_AFTER_WINDOW;
      nowNote = `Maintenant (${formatTime(this.now)})${NBSP}: ${where}`;
    }
    return html`<div class="notes">
      ${pointsNote === null ? nothing : html`<div class="note-points">${pointsNote}</div>`}
      ${nowNote === null ? nothing : html`<div class="note-now">${nowNote}</div>`}
    </div>`;
  }

  private renderChart(config: NormalizedConfig): TemplateResult {
    // The fallback reads clientWidth (a layout flush): only before the first measurement.
    const width = Math.max(
      MIN_CHART_WIDTH,
      this.chartWidth || (this.clientWidth || FALLBACK_HOST_WIDTH) - 2 * BODY_PADDING_X,
    );
    // Same formula as the CSS height clamp of .chart (see styles).
    const height = Math.round(
      Math.max(MIN_CHART_HEIGHT, Math.min(MAX_CHART_HEIGHT, width / CHART_ASPECT)),
    );
    // Value labels: the axis ticks with the decimal comma, the unit on the top one only.
    const axis = config.axis;
    const top = axis.ticks.length - 1;
    const labels = axis.ticks.map((value, i) =>
      i === top ? formatQuantity(value, config.unit) : formatNumber(value),
    );
    // The left margin fits the widest label (never below MARGIN_LEFT, sized for "100 %").
    const widest = Math.max(...labels.map((label) => labelWidth(label, AXIS_LABEL_FONT_PX)));
    const marginLeft = Math.max(MARGIN_LEFT, Math.ceil(widest + AXIS_LABEL_GAP + 1));
    const plot: PlotArea = {
      x: marginLeft,
      y: MARGIN_TOP,
      width: width - marginLeft - MARGIN_RIGHT,
      height: height - MARGIN_TOP - MARGIN_BOTTOM,
    };
    // Pointer events of this render map through the plot and viewBox drawn here.
    this.chartPlot = plot;
    this.chartViewBox = { width, height };
    const window = config.window;
    const clipId = `tcc-clip-${this.instanceId}`;
    const pointsClipId = `tcc-clip-points-${this.instanceId}`;
    const hitsClipId = `tcc-clip-hits-${this.instanceId}`;
    const gradientId = `tcc-gradient-${this.instanceId}`;
    const baseY = px(plot.y + plot.height);

    const gridlines = axis.ticks.map((value, i) => {
      const y = px(valueToY(value, plot, axis));
      const label = labels[i] ?? '';
      return svg`
        <line class="grid" x1="${plot.x}" x2="${px(plot.x + plot.width)}" y1="${y}" y2="${y}"></line>
        <text class="axis-label" x="${plot.x - AXIS_LABEL_GAP}" y="${y}" dy="0.35em" text-anchor="end">${label}</text>`;
    });

    const ticks = hourTicks(window, plot).map((tick) => {
      const x = px(keyToX(tick.key, window, plot));
      return svg`
        <line class="tick" x1="${x}" x2="${x}" y1="${baseY}" y2="${baseY + 4}"></line>
        <text class="axis-label" x="${x}" y="${baseY + 18}" text-anchor="middle">${tick.label}</text>`;
    });

    // Only the visible marker is clipped: a clip-path also restricts hit testing, and the 44px
    // hit target of a point on the plot edge (100 %, window start / end) must stay whole (the SVG
    // lets it overflow its box). The target of a point OUTSIDE the window is the exception: it is
    // clipped to the reach of an edge target (plot + HIT_RADIUS), so that an invisible circle
    // extrapolated far past the plot never catches taps meant for the page around the card.
    const draggedIndex = this.dragging && this.drag !== null ? this.drag.index : -1;
    const points = this.points.map((point, index) => {
      const key = sortKey(point.time);
      const cx = px(keyToX(key, window, plot));
      const cy = px(valueToY(point.value, plot, axis));
      const selected = index === this.selectedIndex;
      const dragged = index === draggedIndex;
      const radius = dragged ? DRAGGING_RADIUS : selected ? SELECTED_RADIUS : POINT_RADIUS;
      // The state classes go on the group (CSS) and on the marker (interactions spec, section 8).
      const states = `${selected ? ' selected' : ''}${dragged ? ' dragging' : ''}`;
      const hitClip = isKeyVisible(key, window) ? nothing : `url(#${hitsClipId})`;
      const label = `Point ${formatTime(point.time)}, ${this.display(point.value)}`;
      // A button that toggles the selection: its state is aria-pressed, its kind a French label.
      return svg`
        <g class="point${states}" data-index="${index}" tabindex="0" role="button" aria-roledescription="point de la courbe" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${label}">
          <circle class="hit" cx="${cx}" cy="${cy}" r="${HIT_RADIUS}" fill="transparent" clip-path="${hitClip}"></circle>
          <circle class="dot${states}" cx="${cx}" cy="${cy}" r="${radius}" clip-path="url(#${pointsClipId})"></circle>
        </g>`;
    });

    return html`
      <div class="chart" ${ref(this.chartRef)}>
        <svg
          viewBox="0 0 ${width} ${height}"
          width="${width}"
          height="${height}"
          role="group"
          aria-label=${this.chartLabel()}
          tabindex="0"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerEnd}
          @pointercancel=${this.onPointerEnd}
          @lostpointercapture=${this.onPointerEnd}
          @focusin=${this.onFocusIn}
          @keydown=${this.onKeyDown}
        >
          <defs>
            <clipPath id="${clipId}">
              <rect
                x="${plot.x}"
                y="${plot.y - CLIP_PAD}"
                width="${plot.width}"
                height="${plot.height + 2 * CLIP_PAD}"
              ></rect>
            </clipPath>
            <clipPath id="${pointsClipId}">
              <rect
                x="${plot.x - CLIP_PAD}"
                y="${plot.y - CLIP_PAD}"
                width="${plot.width + 2 * CLIP_PAD}"
                height="${plot.height + 2 * CLIP_PAD}"
              ></rect>
            </clipPath>
            <clipPath id="${hitsClipId}">
              <rect
                x="${plot.x - HIT_RADIUS}"
                y="${plot.y - HIT_RADIUS}"
                width="${plot.width + 2 * HIT_RADIUS}"
                height="${plot.height + 2 * HIT_RADIUS}"
              ></rect>
            </clipPath>
            <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
              <stop class="grad-top" offset="0"></stop>
              <stop class="grad-bottom" offset="1"></stop>
            </linearGradient>
          </defs>
          <g class="gridlines">${gridlines}</g>
          <g class="ticks">${ticks}</g>
          <g class="curve" clip-path="url(#${clipId})">
            <path
              class="area"
              d="${areaPath(this.points, window, plot, axis)}"
              fill="url(#${gradientId})"
            ></path>
          </g>
          ${
            // The label of a "now" outside the window sits over the area but under the line
            // and the markers: it may have to cross the curve (see nowEdgeLayout), and it must
            // never hide a piece of it.
            this.renderNowEdgeLabel(plot, width, height)
          }
          <g class="curve" clip-path="url(#${clipId})">
            <path class="line" d="${curvePath(this.points, window, plot, axis)}"></path>
          </g>
          ${this.renderNowLine(plot)}
          <g class="points">${points}</g>
          ${this.renderNowMarker(plot, width, height)}
          ${this.renderNowEdgeMarker(plot, width, height)}
          ${this.renderTooltip(plot, width, height, draggedIndex)}
        </svg>
      </div>
    `;
  }

  /**
   * Where "now" lies in the curve day relative to the window (the key test of isKeyVisible):
   * before its start, after its end, or inside it; null when there is no now value (invalid
   * curve, no config).
   */
  private nowSide(): NowSide | null {
    const window = this.config?.window;
    if (!window || this.nowValue === null) return null;
    const key = sortKey(this.now);
    if (key < window.startKey) return 'before';
    if (key > window.endKey) return 'after';
    return 'inside';
  }

  /**
   * The chart's accessible name; it also says so when "now" lies outside the window, where
   * the chart only shows it as an edge marker.
   */
  private chartLabel(): string {
    const name = chartName(this.config?.label ?? '');
    const side = this.nowSide();
    if (side !== 'before' && side !== 'after') return name;
    return `${name}, maintenant ${formatTime(this.now)}, ${NOW_OUTSIDE_WINDOW}`;
  }

  /** x of the "now" marker, or null when now lies outside the window (or the curve is invalid). */
  private nowX(plot: PlotArea): number | null {
    const window = this.config?.window;
    if (!window || this.nowSide() !== 'inside') return null;
    return px(keyToX(sortKey(this.now), window, plot));
  }

  private renderNowLine(plot: PlotArea): TemplateResult | typeof nothing {
    const x = this.nowX(plot);
    if (x === null) return nothing;
    return svg`<line class="now-line" x1="${x}" x2="${x}" y1="${plot.y}" y2="${px(plot.y + plot.height)}"></line>`;
  }

  /**
   * Where the "now" marker is drawn: the dot on the curve, its label above the dot (below it
   * near the top edge), flipped to the left of the line near the right edge so it never leaves
   * the SVG, and the halo box behind the label (see NOW_LABEL_* for the width estimate and
   * placeNowLabel). Null when now lies outside the window (or the curve is invalid).
   */
  private nowLayout(plot: PlotArea, width: number, height: number): NowLayout | null {
    const x = this.nowX(plot);
    if (x === null || this.nowValue === null) return null;
    const y = px(valueToY(this.nowValue, plot, this.domain));
    const flip = x > plot.x + plot.width - NOW_LABEL_FLIP_ZONE;
    const textWidth = nowValueWidth(this.nowValue, this.config?.unit ?? '%');
    const below = nowLabelBelow(y, plot);
    return { x, y, ...placeNowLabel(x, y, flip, below, textWidth, plot, width, height) };
  }

  /**
   * Where the edge marker of a "now" outside the window is drawn (M5): the triangle's tip on the
   * plot edge of the side where now lies (left before the window start, right after its end) at
   * the height of the curve value, pointing out of the plot; its label placed like the in-window
   * label with the plot edge as the line, i.e. on the plot side of the triangle (see
   * placeNowLabel). The label sits on its usual side of the tip (above, below near the plot top)
   * unless it would touch the curve there while the other side is clear (see
   * haloClearOfCurve). When neither side is clear (e.g. at 100 % with the default curve that comes
   * down from its first point right after the window start), the usual side is kept: the curve
   * line and the markers are drawn over the label (see renderChart), never the reverse. Null
   * when now lies inside the window (or the curve is invalid).
   */
  private nowEdgeLayout(plot: PlotArea, width: number, height: number): NowEdgeLayout | null {
    const side = this.nowSide();
    const window = this.config?.window;
    if ((side !== 'before' && side !== 'after') || this.nowValue === null || !window) return null;
    const after = side === 'after';
    const tipX = px(after ? plot.x + plot.width : plot.x);
    const baseX = px(after ? tipX - NOW_EDGE_WIDTH : tipX + NOW_EDGE_WIDTH);
    const y = px(valueToY(this.nowValue, plot, this.domain));
    const half = NOW_EDGE_HEIGHT / 2;
    const triangle = `${tipX},${y} ${baseX},${px(y - half)} ${baseX},${px(y + half)}`;
    const triangleBox: Box = {
      x: Math.min(tipX, baseX),
      y: y - half,
      width: NOW_EDGE_WIDTH,
      height: NOW_EDGE_HEIGHT,
    };
    const textWidth = NOW_LABEL_TIME_WIDTH + nowValueWidth(this.nowValue, this.config?.unit ?? '%');
    const below = nowLabelBelow(y, plot);
    const place = (labelBelow: boolean): NowLabelLayout =>
      placeNowLabel(tipX, y, after, labelBelow, textWidth, plot, width, height);
    const usual = place(below);
    if (this.haloClearOfCurve(usual.halo, plot, window)) return { side, triangle, ...usual };
    // The other side: only when it keeps off the triangle (the clamp at the SVG top can push an
    // "above" label onto it) and the hour labels under the plot, and misses the curve.
    const other = place(!below);
    const usable =
      !boxesTouch(other.halo, triangleBox, 0) &&
      other.halo.y + other.halo.height <= plot.y + plot.height &&
      this.haloClearOfCurve(other.halo, plot, window);
    return { side, triangle, ...(usable ? other : usual) };
  }

  /**
   * true when the halo `halo` of the edge label leaves the drawn curve alone: it stays
   * NOW_EDGE_CURVE_GAP px away from the line where the plot clip lets the line show (between the
   * plot's left and right edges) and from every point marker taken at its largest size.
   */
  private haloClearOfCurve(halo: Box, plot: PlotArea, window: TimeWindow): boolean {
    const gap = NOW_EDGE_CURVE_GAP;
    const box: Box = {
      x: halo.x - gap,
      y: halo.y - gap,
      width: halo.width + 2 * gap,
      height: halo.height + 2 * gap,
    };
    const left = Math.max(box.x, plot.x);
    const right = Math.min(box.x + box.width, plot.x + plot.width);
    if (left <= right) {
      const shown: Box = { ...box, x: left, width: right - left };
      const nodes = polylineNodes(this.points, window).map((node) => ({
        x: keyToX(node.key, window, plot),
        y: valueToY(node.value, plot, this.domain),
      }));
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1];
        const b = nodes[i];
        if (a !== undefined && b !== undefined && segmentMeetsBox(a.x, a.y, b.x, b.y, shown)) {
          return false;
        }
      }
    }
    return this.points.every(
      (point) =>
        !discMeetsBox(
          keyToX(sortKey(point.time), window, plot),
          valueToY(point.value, plot, this.domain),
          MARKER_REACH,
          box,
        ),
    );
  }

  /** The halo box of the "now" label on the chart (in-window or edge marker); null when none. */
  private nowLabelHalo(plot: PlotArea, width: number, height: number): Box | null {
    return (
      this.nowLayout(plot, width, height)?.halo ??
      this.nowEdgeLayout(plot, width, height)?.halo ??
      null
    );
  }

  private renderNowMarker(
    plot: PlotArea,
    width: number,
    height: number,
  ): TemplateResult | typeof nothing {
    const now = this.nowLayout(plot, width, height);
    if (now === null || this.nowValue === null) return nothing;
    const { halo } = now;
    return svg`
      <g class="now">
        <circle class="now-dot" cx="${now.x}" cy="${now.y}" r="${NOW_RADIUS}"></circle>
        <rect class="now-halo" x="${halo.x}" y="${halo.y}" width="${halo.width}" height="${halo.height}" rx="2"></rect>
        <text class="now-label" x="${now.labelX}" y="${now.labelY}" text-anchor="${now.anchor}">${this.display(this.nowValue)}</text>
      </g>`;
  }

  /**
   * M5: when "now" lies outside the window the line has nowhere to go, so an edge marker says
   * where we are: the halo'd `HH:MM` + value label (this group, drawn under the curve line and
   * the point markers so that it never hides them, see renderChart) and a triangle on the plot
   * edge ({@link renderNowEdgeMarker}). The footer note and the chart's aria-label say it in
   * words.
   */
  private renderNowEdgeLabel(
    plot: PlotArea,
    width: number,
    height: number,
  ): TemplateResult | typeof nothing {
    const edge = this.nowEdgeLayout(plot, width, height);
    if (edge === null || this.nowValue === null) return nothing;
    const { halo } = edge;
    return svg`
      <g class="now-outside now-outside-label" data-side="${edge.side}">
        <rect class="now-halo" x="${halo.x}" y="${halo.y}" width="${halo.width}" height="${halo.height}" rx="2"></rect>
        <text class="now-label" x="${edge.labelX}" y="${edge.labelY}" text-anchor="${edge.anchor}">${nowEdgeText(this.now, this.nowValue, this.config?.unit ?? '%')}</text>
      </g>`;
  }

  /**
   * The triangle of the edge marker (same ink as the now line, at 0.6 opacity), drawn over the
   * points like the in-window marker: it stays visible next to a point sitting on the plot edge.
   */
  private renderNowEdgeMarker(
    plot: PlotArea,
    width: number,
    height: number,
  ): TemplateResult | typeof nothing {
    const edge = this.nowEdgeLayout(plot, width, height);
    if (edge === null) return nothing;
    return svg`
      <g class="now-outside now-outside-marker" data-side="${edge.side}">
        <polygon class="now-edge" points="${edge.triangle}"></polygon>
      </g>`;
  }

  /**
   * `HH:MM \u00b7 NN %` above the dragged point (interactions spec, section 4), kept off the "now"
   * label: that label is the live readout of a reshaped curve (what the lamp gets now), so a
   * tooltip that would cover it moves away (see {@link placeTooltip}). The same goes for the edge
   * label of a "now" outside the window (M5).
   */
  private renderTooltip(
    plot: PlotArea,
    width: number,
    height: number,
    draggedIndex: number,
  ): TemplateResult | typeof nothing {
    const window = this.config?.window;
    const point = this.points[draggedIndex];
    if (!window || point === undefined) return nothing;
    const cx = keyToX(sortKey(point.time), window, plot);
    const cy = valueToY(point.value, plot, this.domain);
    const text = `${formatTime(point.time)} ${MIDDOT} ${this.display(point.value)}`;
    const boxWidth = text.length * TOOLTIP_CHAR_WIDTH + TOOLTIP_PAD;
    // Below the marker when the box would not fit above it; above, never past the SVG top.
    const below = cy < TOOLTIP_BELOW_UNDER;
    const box = placeTooltip(
      {
        x: clamp(cx - boxWidth / 2, TOOLTIP_MARGIN, width - TOOLTIP_MARGIN - boxWidth),
        y: below
          ? cy + TOOLTIP_GAP_BELOW
          : Math.max(TOOLTIP_MARGIN, cy - TOOLTIP_GAP_ABOVE - TOOLTIP_HEIGHT),
        width: boxWidth,
        height: TOOLTIP_HEIGHT,
      },
      below,
      this.nowLabelHalo(plot, width, height),
      width,
      height,
    );
    return svg`
      <g class="tooltip">
        <rect x="${px(box.x)}" y="${px(box.y)}" width="${px(box.width)}" height="${TOOLTIP_HEIGHT}" rx="4"></rect>
        <text x="${px(box.x + box.width / 2)}" y="${px(box.y + TOOLTIP_HEIGHT / 2)}" dy="0.35em" text-anchor="middle">${text}</text>
      </g>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'time-curve-card': TimeCurveCard;
  }
}
