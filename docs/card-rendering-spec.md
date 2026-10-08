# Card rendering spec (normative, M2, amended in M3)

Refines CLAUDE.md ("Card spec" > Config, Rendering). Where CLAUDE.md is silent, THIS document
decides. Interactions (drag / add / select / keyboard / persistence) are specified in
`docs/interactions-spec.md` (M3); the rendering changes they brought are marked "(M3)" below, with
their fix-plan item where there is one (B5, B6, C6...). UI strings are French; code, comments,
tests are English. Only `ha-card` from HA; everything else is native/SVG/Lit. Use HA theme CSS
variables only (see section 2.5). The curve semantics themselves are in `docs/curve-spec.md`.

Generalization (time-curve-card): the card draws any daily value curve, not only a brightness
percentage. The element is `time-curve-card` (editor `time-curve-card-editor`, config
`type: custom:time-curve-card`, picker entry "Time Curve Card", console banner `TIME-CURVE-CARD`,
build file `dist/time-curve-card.js`). A value **range** (`min`, `max`, value `step`), a **unit** and
a **label** come from a `preset` (section 2.1); the value axis, every displayed value, the
snapping and the reset curve follow them. With the default brightness preset (1..100 %, step 1)
the rendering is the M2 one, pixel for pixel.

## 1. Geometry (src/core/geometry.ts) - pure, no DOM, no Lit, imports only from ./curve.js

All "keys" are curve-day keys from `sortKey()` (12:00 -> 0 ... 11:59 -> 1439). The window is the
visible x-range; it must lie inside the curve day.

```ts
export interface TimeWindow {
  startKey: number;
  endKey: number;
} // 0 <= startKey < endKey <= 1440
export interface PlotArea {
  x: number;
  y: number;
  width: number;
  height: number;
} // SVG user units (px)
export const DEFAULT_WINDOW_START = '17:00';
export const DEFAULT_WINDOW_END = '08:00';
export const DEFAULT_SNAP_MINUTES = 5;
export const DEFAULT_MAX_POINTS = 12;
// The max_points bound is per range: maxPointsFor(range) of src/core/curve.ts (25 for brightness).
export const CURVE_DAY_END_KEY = 1440; // key used for a window_end of 12:00
export interface AxisDomain {
  min: number;
  max: number;
} // the value axis: min at the bottom of the plot, max at its top
export interface ValueAxis extends AxisDomain {
  ticks: number[];
} // gridline values, min..max, evenly spaced
export const BRIGHTNESS_AXIS: AxisDomain; // { min: 0, max: 100 }, the default domain

/** Builds the window from "HH:MM" strings. 12:00 as END maps to key 1440 (end of curve day),
 *  12:00 as START maps to 0. Throws a French Error (readable in HA) when a time is invalid
 *  ("window_start invalide : attendu HH:MM") or startKey >= endKey
 *  ("window_start (HH:MM) doit précéder window_end (HH:MM) dans la journée 12:00 → 12:00"). */
export function makeWindow(start: string, end: string): TimeWindow;
/** Key -> x (linear, extrapolates outside the window). */
export function keyToX(key: number, window: TimeWindow, plot: PlotArea): number;
/** Minutes since midnight -> x (keyToX(sortKey(minutes))). */
export function timeToX(minutes: number, window: TimeWindow, plot: PlotArea): number;
/** x -> key (unclamped, may be outside the window). */
export function xToKey(x: number, window: TimeWindow, plot: PlotArea): number;
/** x -> minutes since midnight (key wrapped with positive modulo; a key of 1440 -> 12:00 -> 720).
 *  Fractional for an x between two minutes; snap afterwards with snapTime. */
export function xToTime(x: number, window: TimeWindow, plot: PlotArea): number;
/** domain.max at plot.y (top), domain.min at plot.y + plot.height (bottom); the domain defaults to
 *  BRIGHTNESS_AXIS (0..100). */
export function valueToY(value: number, plot: PlotArea, domain?: AxisDomain): number;
export function yToValue(y: number, plot: PlotArea, domain?: AxisDomain): number; // unclamped
/** The value axis of a range (default: brightness): gridline step from {1, 2, 2.5, 5} x 10^n
 *  (whole hundredths), bounds = the range bounds rounded outwards to a multiple of it; among the
 *  steps giving 4 to 6 intervals the one with the FEWEST intervals wins (else the count nearest to
 *  that band, fewer first). Exact (centi-units). Brightness 1..100 -> 0, 25, 50, 75, 100;
 *  5..30 -> 5, 10, ... 30; 2000..6500 -> 2000, 3000, ... 7000; -5..5 -> -5, -2.5, 0, 2.5, 5. */
export function valueAxis(range?: ValueRange): ValueAxis;
/** Nearest multiple of `step` minutes (round half up), wrapped into [0, 1439]. step must divide 60
 *  (RangeError otherwise). */
export function snapTime(minutes: number, step: number): number;
/** Rounded to hundredths, clamped to [range.min, range.max], snapped to the nearest multiple of
 *  range.step (half up, exact integer arithmetic: snapCenti), clamped again (an off-grid bound stays
 *  reachable). NaN -> range.min. Default range: brightness, i.e. an integer in [1, 100]. */
export function clampValue(value: number, range?: ValueRange): number;
/** Keyboard nudges: `steps` value steps from the grid (an off-grid value first moves to the grid
 *  line on that side), clamped to the range; steps 0 -> clampValue. */
export function stepValue(value: number, steps: number, range?: ValueRange): number;
/** Clamp a candidate KEY between neighbours and the window:
 *  lower = max(window.startKey, prevKey === null ? -Infinity : prevKey + step)
 *  upper = min(window.endKey,   nextKey === null ?  Infinity : nextKey - step)
 *  If lower > upper return lower - which can then lie PAST window.endKey (prevKey within one step of the
 *  window end): the M3 drag handler must check the result with isKeyVisible before persisting, or refuse
 *  the move. Result is NOT snapped (snap before calling). */
export function clampKeyBetween(
  key: number,
  prevKey: number | null,
  nextKey: number | null,
  step: number,
  window: TimeWindow,
): number;
/** Hour ticks inside [startKey, endKey] (inclusive). pixelsPerHour = plot.width / ((endKey - startKey) / 60).
 *  Step in hours = the smallest n in [1, 2, 3, 4, 6] such that pixelsPerHour * n >= 44 (6 if none).
 *  Ticks are the keys whose minute-of-day is a full hour AND whose hour-of-day is a multiple of the step
 *  (so 2-hour steps land on even hours: 18h, 20h, 22h, 0h, 2h ...). label = `${hour}h` (0h ... 23h;
 *  12h for key 1440). */
export function hourTicks(
  window: TimeWindow,
  plot: PlotArea,
): { key: number; minutes: number; label: string }[];
/** Nodes of the visible polyline in key space, including the flat extensions:
 *  [ {key: window.startKey, value: first.value} if first.key > window.startKey ] + sorted points +
 *  [ {key: window.endKey, value: last.value} if last.key < window.endKey ]. Points outside the window
 *  stay in the list (the SVG clips them). Throws RangeError if the curve is invalid (< 2 points). */
export function polylineNodes(
  points: readonly CurvePoint[],
  window: TimeWindow,
): { key: number; value: number }[];
/** SVG path "M x y L x y ..." from polylineNodes (numbers formatted with at most 2 decimals, no trailing zeros). */
export function curvePath(
  points: readonly CurvePoint[],
  window: TimeWindow,
  plot: PlotArea,
  domain?: AxisDomain,
): string;
/** Same, closed down to the bottom of the axis (domain.min, 0 for brightness):
 *  "... L xLast yBase L xFirst yBase Z". */
export function areaPath(
  points: readonly CurvePoint[],
  window: TimeWindow,
  plot: PlotArea,
  domain?: AxisDomain,
): string;
/** true when startKey <= key <= endKey. */
export function isKeyVisible(key: number, window: TimeWindow): boolean;
```

## 2. Card element (src/card.ts) - LitElement `time-curve-card`

### 2.1 Config validation (setConfig) - throw `Error` with French messages

M5: the rules below live in the pure `normalizeConfig(config): NormalizedConfig` of `src/config.ts`
(the `NormalizedConfig` type moved there and is re-exported by `src/card.ts`). `setConfig` stores
its result; the visual editor (section 7) shows the message it throws (`configError`), so the card
and the editor always agree.

Rules, checked in this order (the first one broken is thrown):

- `entity`: required, must start with `input_text.` ("'entity' est requis et doit être une entité input_text.*").
- `target_sensor`: optional, must start with `sensor.` ("'target_sensor' doit être une entité sensor.*").
- `target_entity` (replaces the M2 `light` key, which is now an unknown key, ignored): optional, any
  entity id `domain.object_id` (lowercase letters, digits, `_`) ("'target_entity' doit être un
  identifiant d'entité (domaine.nom)"); an empty string counts as absent.
- `title`: optional string.
- `preset` (default `brightness`): `brightness` | `temperature` | `color_temp` | `custom`
  ("'preset' doit valoir brightness, temperature, color_temp, custom"). A preset fills the
  defaults below; explicit keys override them one by one:

  | preset        | min  | max  | step | unit | label                  | default curve                           |
  | ------------- | ---- | ---- | ---- | ---- | ---------------------- | --------------------------------------- |
  | `brightness`  | 1    | 100  | 1    | `%`  | Luminosité             | `19:00@100;21:00@70;22:30@30;23:30@12`  |
  | `temperature` | 5    | 30   | 0.5  | `°C` | Température            | `17:00@20;22:00@18.5;06:00@17;07:00@20` |
  | `color_temp`  | 2000 | 6500 | 50   | `K`  | Température de couleur | `17:00@4000;21:00@2700;23:00@2200`      |
  | `custom`      | -    | -    | -    | none | Valeur                 | `19:00@<max>;23:00@<min>`               |

- `min`, `max`: numbers with at most 2 decimals within -9999.99..9999.99 ("'min' doit être un nombre
  entre -9999,99 et 9999,99 avec au plus 2 décimales", same for `max`); required by `custom`
  ("le preset custom exige 'min', 'max' et 'step'"); `min < max` ("'min' (100) doit être inférieur
  à 'max' (100)", numbers with the decimal comma).
- `step`: a positive number with at most 2 decimals ("'step' doit être un nombre positif avec au
  plus 2 décimales"), required by `custom` (same message as above), at most `max - min`
  ("'step' (30) doit être au plus l'écart entre 'min' et 'max' (25)").
- `unit`, `label`: strings, may be empty ("'unit' doit être une chaîne de caractères").
- `default_curve` (optional): must parse (with the range, values clamped) to a valid curve
  ("'default_curve' doit contenir au moins 2 points HH:MM@valeur valides"); stored in canonical
  form. Without it the reset curve is the preset's curve parsed with the range (clamped), or for
  `custom` `19:00@<max>;23:00@<min>` (`fallbackCurve`).
- `window_start` (default 17:00) / `window_end` (default 08:00): via makeWindow (its errors propagate).
  They must be strings: an unquoted YAML `17:00` arrives as the integer 1020 and is rejected.
- `snap_minutes` (default 5): integer 1..60 that divides 60 ("snap_minutes doit être un entier qui divise 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60)").
- `max_points` (default 12): integer from 2 to `maxPointsFor(range)` = `floor(256 / maxTokenLength)`
  (25 for brightness, 23 for the temperature and colour temperature presets, 21 for -5..5 step
  0.25, 17 for the widest range) ("max_points doit être un entier entre 2 et 25 (limite des 255
  caractères de input_text)", with the computed bound).
- Unknown keys are ignored. Store a normalized config (defaults applied) in a private state:
  `NormalizedConfig` also carries `preset`, `range` (`{ min, max, step }`), `unit`, `label`,
  `defaultCurve` (canonical) and `axis` (`valueAxis(range)`).
- `static getStubConfig(hass?)` returns `{ entity }`, with NO title (a generic card has no
  household title; the user names it). Without `hass` the entity is `input_text.brightness_curve`
  (`DEFAULT_ENTITY`, the helper of `ha/example-package.yaml`). M5: with `hass` (the dashboard card
  picker passes it) the entity is the first `input_text.*` by entity id whose state parses to a valid
  curve, else the first `input_text.*`, else that default id. The `window.customCards` entry has
  `preview: true` (the picker renders the card with this stub).
- `static getConfigElement()` (M5) returns a new `<time-curve-card-editor>` (section 7).
- `setConfig` with local edits pending (unsaved) keeps them, their values clamped into the new
  range; the stored curve is parsed again with the new range.
- `getCardSize()` returns 5; `getGridOptions()` returns `{ columns: 12, rows: 'auto', min_columns: 6, min_rows: 4 }`.

### 2.2 Data derived from hass (recomputed in `willUpdate`, cheap)

- `points = parseCurve(hass.states[entity]?.state, range)`; `valid = isValidCurve(points)`.
- `now`: minutes since midnight in HA's timezone: `hass.config?.time_zone` via
  `Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })`
  (wrapped in try/catch, fallback to the browser's local time). A public property
  `nowProvider?: () => Date` (attribute: false) overrides the clock for tests and the dev harness.
  A 1-minute clock ticks on every minute boundary: one self-rescheduling `setTimeout` whose delay is
  recomputed after each tick (`60 000 - Date.now() % 60 000`), NOT a `setInterval` - after a suspended
  WebView / hidden tab resumes, the overdue tick fires late but the next one is aligned again. A
  `visibilitychange` listener (document) re-renders and re-aligns the clock when the page becomes
  visible. Started in `connectedCallback`, cleared (timer + listener) in `disconnectedCallback`.
- `nowValue = valid ? evaluateCurve(points, now, range) : null`.
- Sensor (if `target_sensor` configured): entity = hass.states[target_sensor]; `sensorValue` =
  `sensorCenti(state)`: the trimmed state parsed with the curve value grammar into exact
  centi-units (`parseValueCenti`: `18.5`, `18.50` -> 1850), else any other finite decimal number
  with a dot (`+3`, `19.555`) rounded to hundredths, else null (unknown/unavailable/missing/text
  -> null). The sensor state is in the curve's units (the card shows it with the card's unit, not
  the sensor's `unit_of_measurement`). The generic sensor
  contract: the sensor MAY expose two attributes, both read through `sensorText` (a string, whitespace
  runs collapsed to one space, trimmed; null when absent, not a string or blank):
  - `mode`: `curve` when the sensor follows the curve; ANY other string (conventionally `override`)
    means that a higher-priority rule of the user's own package decides the value. A blank or
    non-string `mode` counts as absent. Compared as is (`Curve` is not `curve`).
  - `reason`: free text in the user's language explaining an override, shown as plain text by the
    card (collapsed by `sensorText`, so a multi-line reason shows on one line, title included). Ignored unless `mode` is an override.
    The card never interprets the rules themselves: it only shows what the sensor says (the example
    package, `ha/example-package.yaml`, sets `mode: override` and a `reason` for its "curve disabled"
    rule).
- Target entity (if `target_entity` configured): its name is the `friendly_name` attribute
  (trimmed, when a non-blank string) else "Appareil"; its text is `targetEntityText(entity,
temperatureUnit)`:
  - missing entity, `unavailable` or `unknown` state: "indisponible";
  - `light.*`: "allumée · NN %" (NN = round(attributes.brightness / 255 \* 100) when brightness is a
    finite number), "allumée" without brightness, "éteinte" when off, the raw state otherwise;
  - `climate.*`: `current_temperature` (a finite number) with the decimal comma and the HA
    temperature unit (`hass.config.unit_system.temperature`, else `°C`), e.g. "19,5 °C"; without it
    the French name of the hvac state ("arrêt", "chauffage", "climatisation", "chauffage /
    climatisation", "auto", "déshumidification", "ventilation"; any other state raw);
  - any other domain: the state (a decimal number with a dot is shown with the decimal comma) and
    its `unit_of_measurement` after U+202F when present ("48,5 %", "on").

### 2.3 shouldUpdate

Only re-render when something relevant changed: if the only changed property is `hass`, compare the
state objects (reference equality) of `entity`, `target_sensor`, `target_entity`,
`hass.config?.time_zone` and `hass.config?.unit_system?.temperature` against the previous hass;
return false when all are identical. Any other property change -> true.
Keep a unit test for this (spy on `render`).

### 2.4 Layout (inside `<ha-card .header=${title}>`)

1. Status row (`.status`, flex, wraps on narrow screens, 13px, `--secondary-text-color`, values in
   `--primary-text-color` and `font-weight: 500`):
   - Every value of the card (status row, now label, edge label, tooltip, aria-labels, sensor chip)
     is formatted by `formatQuantity(value, unit)` (src/format.ts): the French decimal comma, no
     trailing zero, no thousands separator, then U+202F and the config's unit (`19,5 °C`, `57 %`,
     `2700 K`; the bare number for an empty unit). Below, `{value}` is such a text.
   - "Maintenant" chip: `HH:MM` and, when valid, `{value}` (the curve value at now).
   - Sensor chip (only if configured): "Capteur" + `{value}` or "indisponible", then, after " · ", the
     note of the pure `sensorNote(mode, reason, sensorValue, nowValue)` (exported by `src/card.ts`,
     called with both values in exact centi-units) in a `<span class="reason">`:
     - `mode` absent: "≠ courbe" when sensorValue !== nowValue (both non-null, compared exactly as
       integers: `18.50` equals a curve value of 18.5), else nothing;
     - `mode` `curve`: nothing, even when the values differ. Deliberate: the sensor re-renders on its
       own minute schedule, so the two values legitimately differ for up to a minute after every tick
       (a flag would flicker); a genuine drift still shows as "Capteur {value}" next to "Maintenant";
     - any other `mode`: the `reason` when there is one, else "Règle prioritaire". The reason is
       rendered as text (Lit escapes it, never markup), cut to `REASON_MAX_LENGTH` = 60 characters
       (code points, so an emoji is never split; the last one an ellipsis "…", with no blank before
       it), and its full text goes in the `title` attribute of `.reason` (no `title` for the card's own
       notes). The value stays shown (or "indisponible") next to the reason.
       The chip (`.chip.sensor`) is capped at the status row width (`max-width: 100%; overflow: hidden;
text-overflow: ellipsis`), so a long reason on a phone-width card is cut again by CSS instead of
       overflowing the card.
   - Target chip (`.chip.target`, only if `target_entity` is configured): the entity's name and,
     in `.value`, its text (section 2.2): "Lampe allumée · 60 %", "Thermostat 19,5 °C",
     "Appareil indisponible". Capped at the row width like the sensor chip (same CSS rule).
   - Save chip (M3): a persistent live region, last in the row, empty while idle, in a slot of fixed
     size (at least 8 em, one line, ellipsis) so the row, and the chart under it, never move when
     a save starts, ends or fails (docs/interactions-spec.md, section 5.5).
2. Chart (`.chart`): an `<svg>` filling the width; `touch-action: none; user-select: none; display: block`.
   - Width = width of the `.chart` container (host width minus the 32 px body padding), measured by a
     `ResizeObserver` on the host and on `.chart` (guard `typeof ResizeObserver !== 'undefined'`; the observer
     is created BEFORE `super.connectedCallback()` so the `ref` directive re-observes `.chart` when the card is
     re-added to the DOM; disconnect in `disconnectedCallback`); fallback `(this.clientWidth || 400) - 32`
     before the first observation (read lazily, only while `chartWidth` is 0).
   - Height = `Math.round(Math.max(180, Math.min(320, width / 2.5)))` (aspect ~2.5:1, phone-usable minimum).
     The `.chart` box is sized by CSS with the same rule, using container-query units:
     `.body { container-type: inline-size }` and
     `.chart { width: 100%; height: clamp(180px, calc(100cqw / 2.5), 320px) }` (preceded by a plain
     `height: 180px` fallback for browsers without `cqw`); the SVG is `width: 100%; height: 100%`.
     NEVER size the chart with `aspect-ratio`: during intrinsic sizing a percentage width counts as auto,
     so the 180 px min-height would transfer through the ratio into a 450 px minimum WIDTH that stops the
     card from shrinking to phone width in a content-sized host (a grid `auto` track, a flex item). The
     inline-size containment of `.body` also keeps the chart contents out of the card's min-content width.
     Sizing by CSS alone means a resize never changes the box twice inside one ResizeObserver cycle (with
     `height: auto` the SVG first followed the stale viewBox aspect, which raised "ResizeObserver loop
     completed with undelivered notifications" on every width change). The rounded viewBox height differs
     from the CSS box by < 0.5 px (negligible letterboxing).
   - viewBox = `0 0 ${width} ${height}` (1 unit = 1 CSS px, so hit targets are real px).
   - The `<svg>` itself (M3, C6): `role="group"`, `aria-label="Courbe : {label}"` (U+00A0 before
     `:`, "Courbe : Luminosité" for brightness, "Courbe" for an empty label), `tabindex="0"`,
     `cursor: crosshair`, `outline: none` with a keyboard-only focus outline (docs/interactions-spec.md,
     section 3.2). M5: while now lies outside the window the label reads
     "Courbe : {label}, maintenant HH:MM, hors de la plage affichée".
   - Plot area: left 40, right 14, top 14, bottom 24 (px). The value labels end at `plot.x - 10` so a marker
     on the window start never paints over "100 %": the outer radius of a marker with its surface ring is
     6 px idle, 8.5 px selected and 9.5 px while dragged (M3: r 7 / r 8 with a 3 px ring). The left
     margin grows for wider value labels: `max(40, ceil(widest label + 10 + 1))`, the width estimated
     by `labelWidth(text, 11)` (0.56 em per digit, 0.28 em for `,` / `.`, 0.35 em for `-`, 0.2 em for
     U+202F, 0.72 em for any other character): 40 px for "100 %" and "30 °C" (42), 46 px for
     "7000 K".
   - Clip paths (M3, B6: `CLIP_PAD` = 10 px, 7 px in M2). The curve groups (`g.curve`, one for the area and,
     M5, one for the line, see the edge label below) are clipped to the plot area
     padded by 10 px vertically only (a 2 px line at 0 / 100 % is not shaved; the flat extensions still stop
     at the window edges). Each visible point marker (`circle.dot`) is clipped to the plot area padded by
     10 px on every side, so a marker exactly on the edge stays whole, the dragged one included (r 8 + its
     ring); a point up to 10 px past the window is therefore still (partly) drawn while the footer note
     counts it as outside (documented tolerance). NOT clipped: the point groups and the hit targets of
     visible points - a clip-path also restricts hit testing and the 44 px target of a point on the plot
     edge must stay whole. Unique clipPath ids per element instance (`tcc-clip-${n}`,
     `tcc-clip-points-${n}`, `tcc-clip-hits-${n}`; gradient `tcc-gradient-${n}`).
   - The SVG has `overflow: visible` (M3, B5): the 44 px target of a point on the top / right plot edge
     reaches up to 8 px past the SVG box (22 px hit radius - 14 px margin), and the browser only hit-tests
     what the SVG lets overflow. Nothing else paints outside the box (curve and markers are clipped, the
     drag tooltip and the now label are kept inside), except the keyboard focus ring of such an edge
     target, which stays inside the card padding. The one clipped hit target: the target of a point
     OUTSIDE the window gets a clip rect of the plot padded by the hit radius (22 px, the reach of an edge
     target), so a transparent circle extrapolated past the plot never catches taps meant for the page
     around the card.
   - Value axis: `config.axis = valueAxis(range)` (section 1); every coordinate maps through its domain
     (`valueToY(value, plot, axis)`). Gridlines at its ticks (brightness: 0/25/50/75/100; temperature
     5/10/.../30; colour temperature 2000/3000/.../7000): solid 1px `--divider-color`; labels at the
     left (11px, `--secondary-text-color`, text-anchor end, `font-variant-numeric: tabular-nums`),
     formatted with the decimal comma; the unit is only on the top label ("0", "25", "50", "75",
     "100 %"; "5" ... "30 °C"; "-5", "-2,5", "0", "2,5", "5" for a custom range without unit).
   - Pointer events: `.gridlines`, `.ticks`, `.now-line`, the `.now` group, the two `.now-outside` edge marker
     groups (M5) and the drag `.tooltip` (M3) get `pointer-events: none`, so only the point hit targets and the
     chart background receive taps (the structure M3's drag / tap-to-add needs).
   - Hour ticks from `hourTicks`: 1px `--divider-color` tick marks (4px long) under the baseline + labels
     `${hour}h` (11px, `--secondary-text-color`, text-anchor middle). Labels must not overlap: the tick step
     rule guarantees >= 44px per label.
   - Area: `areaPath` (closed down to the bottom of the axis) filled with a vertical `<linearGradient>` of the curve colour, stop-opacity 0.20 at the
     top -> 0.02 at the bottom (a wash, never a block - 0.28 read as a solid band on dark themes). Gradient id
     unique per instance.
   - Line: `curvePath`, stroke = curve colour, 2px, `stroke-linejoin: round`, `stroke-linecap: round`, no fill.
   - Points: for each curve point a `<g class="point" data-index="i">` holding an invisible hit target
     `<circle class="hit" r="22" fill="transparent">` (44px) and, drawn over it, the marker
     `<circle class="dot" r="5">` filled with the curve colour, stroke `--tcc-surface` 2px (surface ring).
     Points outside the window are still rendered (clipped).
     M3, C6: the group is a focusable toggle button - `tabindex="0"`, `role="button"`,
     `aria-roledescription="point de la courbe"`, `aria-pressed="true|false"` (selected) and
     `aria-label="Point HH:MM, {value}"` (e.g. "Point 21:00, 70 %", "Point 22:00, 18,5 °C"), kept up to date while the point
     moves. M3, B8: the selected point carries the class `selected` and the dragged one `dragging`, on the
     group AND on its `circle.dot` (r 7 / r 8, ring 3 px; docs/interactions-spec.md, section 8).
   - Now marker (only when the `now` key is inside the window): vertical 1.5px line in `--primary-text-color`
     at opacity 0.6 over the plot height; a `<circle r="4">` on the curve at (nowX, nowY) filled
     `--primary-text-color` with a 2px surface ring; a label next to the dot with `{value}` (12px,
     `--primary-text-color`, font-weight 500), offset 8px to the right of the line; the label flips to the
     left of the line (text-anchor end) when nowX is within 48px of the plot's right edge so it never overflows.
     Behind the label, a `<rect class="now-halo">` in `--tcc-surface` (rx 2, height 13, top 10.5 px above the
     baseline, width = characters of the number (the comma counted as a digit) x 6.8 + (unit: 3 + 8 per
     unit character, 11 for " %"; nothing without unit) + 2 x 3 px, an estimate of the 12px tabular label) interrupts a
     gridline running through the glyphs with one clean box (a per-glyph `paint-order: stroke` halo, kept as a
     fallback for wider fonts, leaves specks between the glyphs). All label / halo coordinates go through the
     2-decimal formatter like every other coordinate. Label and halo are also moved together, when needed, to
     stay 2 px inside the SVG (a no-op at the supported widths for the in-window label, which the flip keeps
     inside; it matters for the edge label below).
   - Now marker outside the window (M5): when the curve is valid and the `now` key lies outside the window
     (`sortKey(now) < window.startKey`: before it, `> window.endKey`: after it; the bounds themselves are
     inside and get the line), there is no line and no dot; instead two groups, both
     `class="now-outside"`, `data-side="before|after"` and `pointer-events: none`:
     - `<g class="now-outside now-outside-marker">`, drawn where the in-window marker would be (over the
       points, under the drag tooltip), holds the edge marker `<polygon class="now-edge">`: an
       outward-pointing triangle 8 px wide and 10 px tall whose tip touches the plot edge of the side where
       now lies (left edge `plot.x` before the window, right edge `plot.x + plot.width` after it), at
       `y = valueToY(nowValue, plot, axis)`; vertices tip first (`tipX,y baseX,y-5 baseX,y+5`, base 8 px inside the
       plot); filled `--primary-text-color` at opacity 0.6 (the ink of the now line); over the points, so a
       point on the plot edge does not hide it;
     - `<g class="now-outside now-outside-label">`, drawn over the area but UNDER the curve line (the line
       has its own clipped `g.curve` after it) and the points, holds the halo'd 12px label of the in-window
       marker (`rect.now-halo` + `text.now-label`, same styles) with `HH:MM · {value}` (the time of now, the
       curve value at now, formatted with its unit), laid out by the same helper with the plot edge as the line:
       8 px (the triangle width) inside the plot, i.e. on the inner side of the triangle, text-anchor start
       on the left edge and end on the right edge; halo width = 4 time digits x 6.8 + 12 (colon, spaces,
       middle dot) + the value width of the in-window label + 2 x 3 px; then moved inside the SVG (2 px margin) - on a 120 px
       chart the left label slides back over the triangle rather than overflow. Its usual side is the
       in-window rule: baseline 9 px above the tip (17 px below it within 20 px of the plot top), so it never
       covers the flat start / end of the curve at the edge. It takes the OTHER side when its halo, grown
       by 2 px, meets the curve on the usual side (the line where the clip shows it, i.e. between the plot's
       left and right edges, or a point marker at its largest, dragged, 9.5 px radius so that a selection
       never moves the label) while the other side is clear, keeps off the triangle (an "above" label
       pushed down by the SVG-top clamp would touch it) and does not reach below the plot (the hour
       labels). When neither side is clear - an afternoon with the default curve: 100 % at 14:39 with the
       default curve coming down from 19:00 right under the label - it stays on the usual side and the curve line and
       markers paint over it: the label never hides a piece of the curve ("what you see is what the sensor
       does"). It never reaches the value labels (they end at `plot.x - 10`) or the hour labels.
     - The drag tooltip avoids this label exactly like the in-window one (docs/interactions-spec.md,
       section 4, R2): `placeTooltip` gets the halo of whichever now label is drawn.
     - Footer note and aria-label: see item 3 and the `<svg>` item above.
     - It follows the minute clock like the in-window marker: when now enters the window (17:00 with the
       default window) the line replaces it; when it leaves (08:01) the edge marker comes back.
   - Colour: `--tcc-curve` = `var(--time-curve-card-color, var(--state-light-active-color, var(--primary-color)))`
     defined on `:host` (the same fallback for every preset; a heating card can set
     `--time-curve-card-color` from its theme or card-mod). Text never uses the curve colour. Surface rings and halos use
     `--tcc-surface` = `var(--ha-card-background, var(--card-background-color))` (also on `:host`): the colour
     `<ha-card>` actually paints, which themes may set through `--ha-card-background`.
3. Footer notes (`.notes`, 12px, `--secondary-text-color`, one `<div>` per note, each on its own line; no
   block at all when there is no note): when some points are outside the window (`.note-points`):
   "N point(s) hors de la fenêtre affichée" (singular "1 point hors de la fenêtre affichée"); M5, when now is
   outside the window (`.note-now`, after the points note when both appear): "Maintenant (HH:MM) : avant la
   plage affichée" / "Maintenant (HH:MM) : après la plage affichée" (U+00A0 before `:`). M3: the detail
   row of the selected point and the message line sit between the chart and these notes
   (docs/interactions-spec.md, sections 6 and 7).
   When the stored curve is invalid the chart is replaced by a `.invalid` block (M3, A8 / A9 -
   docs/interactions-spec.md, sections 1.5 and 5.6): "Entité introuvable" + the entity id in `<code>` for
   a missing entity; "Entité indisponible" + the entity id in `<code>` for an `unavailable` state (or
   while `hass` is not set yet), both with NO reset button; "Courbe invalide ou vide." (no `<code>`) + the
   "Réinitialiser la courbe" button for an `unknown` state (a helper never written, e.g. the new
   `input_text` on its first start); otherwise "Courbe invalide ou vide." + the raw stored string in
   `<code>` (none when empty) + the "Réinitialiser la courbe" button. The block is chosen from the
   STORED curve: local edits do not bring the chart back.

### 2.5 Styles

`:host { display: block }`; card body padding 12px 16px 16px; font-family inherits from HA. Use only these
theme variables: `--primary-color`, `--primary-text-color`, `--secondary-text-color`, `--divider-color`,
`--card-background-color`, `--ha-card-background` (the documented card-surface variable, only as the first
choice of `--tcc-surface`), `--state-light-active-color`, `--error-color` (M3: the save error chip),
and the card-specific override `--time-curve-card-color`. No hard-coded colours except gradient
opacities.

## 3. Types (src/types.ts)

`HomeAssistant` carries `config?: { time_zone?: string; unit_system?: { temperature?: string } }`.
`HassEntity.attributes` stays `Record<string, unknown>`. `CardConfig` has `target_entity` (no
`light`) and the value keys `preset`, `min`, `max`, `step`, `unit`, `label`, `default_curve`.

## 4. Dev harness (dev/main.ts, dev/index.html)

- `preset=brightness|temperature|color_temp|custom` (default brightness; also a "Preset" select in
  the toolbar, which reloads the page with the parameter and drops `curve=`) picks the generic
  entities, the title, the priority-rule value and the target entity of the harness:

  | preset        | curve / sensor / boolean                                                                                  | title                  | rule | target entity                                                          |
  | ------------- | --------------------------------------------------------------------------------------------------------- | ---------------------- | ---- | ---------------------------------------------------------------------- |
  | `brightness`  | `input_text.brightness_curve`, `sensor.brightness_curve_target`, `input_boolean.brightness_curve_enabled` | Courbe du soir         | 80   | `light.example_lamp` (on, brightness 153)                              |
  | `temperature` | `input_text.heating_curve`, `sensor.heating_curve_target`, `input_boolean.heating_curve_enabled`          | Chauffage              | 16   | `climate.your_thermostat` (heat, current temperature 19.5)             |
  | `color_temp`  | `input_text.color_temp_curve`, `sensor.color_temp_curve_target`, `input_boolean.color_temp_curve_enabled` | Température de couleur | 3000 | `light.example_lamp`                                                   |
  | `custom`      | `input_text.custom_curve`, `sensor.custom_curve_target`, `input_boolean.custom_curve_enabled`             | Courbe personnalisée   | 0    | `sensor.example_humidity` (48.5 %); range -5..5, step 0.25, "Décalage" |

  The initial curve is the preset's default curve; the mock sensor's state is the formatted
  storage value (`18.5`) with the preset's unit as `unit_of_measurement`, and follows the range and
  unit the card runs with (the editor may change them).

- The card title is set by the harness only (the stub config has none).
- URL query params applied on load: `theme=dark`, `narrow=1` (360px), `curve=<string>`,
  `now=HH:MM` (sets `card.nowProvider` to a fixed Date built from today's date + HH:MM local), `sensor=<n>`,
  `mode=none|curve` (the sensor's `mode` attribute pinned at start: `none` creates the sensor without a
  `mode` attribute so the "≠ courbe" flag can be seen with `sensor=<n>`, `curve` pins `mode: curve`;
  a `sensor=` / `mode=` pin survives the minute refresh and lasts until the first interaction —
  toolbar, clock or any entity change — which recomputes the sensor from the rules),
  `override=1` (the "Règle prioritaire" toggle on), `reason=<text>` (the reason field; empty = an
  override without a `reason` attribute, the card then shows "Règle prioritaire"), `active=0`,
  `target=<state>` (the state of the target entity: `on|off|unavailable` for the lamp,
  `heat|off|unavailable` for the thermostat; `missing` leaves the entity out; `light=` is an
  alias), `brightness=<0-255>` (the lamp), `current=<n>` (the thermostat's current temperature,
  empty = none), `window_start=HH:MM`, `window_end=HH:MM`.
- M5: `editor=1` shows the visual editor (from `TimeCurveCard.getConfigElement()`) above the
  card, wired like HA's card editor dialog: every `config-changed` goes back to the editor's
  `setConfig` and to the card's `setConfig`; a config the card rejects replaces the card with the
  red error card until a valid one comes. Combines with the other parameters (`theme`, `narrow`,
  `now`, `window_start`...).
- A "Figer l'heure" checkbox + `<input type="time">` sets/clears `card.nowProvider`.
- The mock sensor entity carries the `mode` / `reason` attributes of the generic sensor contract
  (section 2.2). Toolbar toggles "Courbe
  active" (the generic boolean) and "Règle prioritaire" (a stand-in for any higher-priority rule of a
  user's package) with a small text field for its reason (default "Exemple de règle"). The harness
  recomputes the mock sensor from the rules of `ha/example-package.yaml` plus that extra rule, by
  priority: "Règle prioritaire" on -> the preset's rule value (80 %), `mode: override`, the typed reason (none when blank);
  invalid curve -> unavailable, no attributes (like HA, no `mode` / `reason`); boolean off -> the curve's highest value, `mode: override`, reason
  "Curve disabled"; else the curve value at the harness clock, `mode: curve`.
- The `ha-card` stub re-renders its header when the `.header` property changes after first paint.

## 5. Screenshot tool (scripts/screenshot.mjs)

`node scripts/screenshot.mjs --port 5211 --out <dir> --set default` produces light/dark x 520/360 shots at
now=21:30; `--query "theme=dark&narrow=1&now=03:00" --name custom` adds a custom shot. It starts Vite on the
port, captures with headless Edge (or Chrome, `$BCC_BROWSER`), then kills Vite. Note: headless Edge on
Windows enforces a minimum window width, so use `narrow=1` (a 360 px content-sized host) rather than a
360 px `--width` to check phone rendering.

## 6. Tests

- `test/geometry.test.ts` (+ `test/geometry.independent.test.ts`, written from this spec only): makeWindow
  (defaults, 12:00 end -> 1440, 12:00 start -> 0, errors), keyToX/xToKey round trip, timeToX across midnight
  (window 17:00 -> 08:00: 17:00 at plot.x, 08:00 at plot.x + width, 00:00 in between at the exact fraction
  7/15), valueToY/yToValue, snapTime (half up, wrap 1439 -> 0 for step 5), clampValue, clampKeyBetween (all
  branches incl. lower > upper), hourTicks (step 1 vs 2 vs 3 by width, even-hour alignment, labels),
  polylineNodes/curvePath/areaPath (flat extensions present/absent, invalid curve throws), isKeyVisible;
  the generalization block of `test/geometry.test.ts`: `valueAxis` (brightness 0/25/50/75/100,
  temperature, colour temperature, negative and sub-unit ranges, the widest range, 4 to 6
  intervals covering the range), `valueToY` / `yToValue` / `curvePath` / `areaPath` with a domain,
  `clampValue` with ranges (0.5 / 50 / 0.25 steps, half up with negatives, an off-grid bound) and
  `stepValue`.
- `test/card.presets.test.ts`: the value presets and custom ranges (see docs/interactions-spec.md,
  section 12).
- `test/card.test.ts`: config validation errors (each rule); renders an `<svg>` with N point groups, a path
  for the curve and the area, the now line when now is inside the window and not when outside; status row
  texts (now value; the target entity chip for a light, a thermostat - current temperature, HA
  unit system, hvac state - and any other entity; "Appareil" without a friendly name; the old
  `light` key ignored); the sensor chip rules of the generic contract (`mode` `curve`: nothing
  even when the values differ, a `reason` ignored; an override with a reason: the text, escaped, with
  its title, whitespace collapsed, kept when the value is unavailable; an override without a usable
  reason, or any other mode string: "Règle prioritaire"; a long reason cut to 60 characters with an
  ellipsis and the full title, 60 exactly kept whole, an emoji never split; the CSS cap of the chip;
  `mode` absent, blank or not a string + differing values: "≠ courbe"; a mode / reason change
  re-renders) plus the pure `sensorText` / `truncateText` / `sensorNote`; the generic stub config
  (no title, empty `ha-card` header);
  invalid curve block; "hors de la fenêtre" note; shouldUpdate skips a hass change that only touches an
  unrelated entity and re-renders when the curve entity changes; timezone: with
  `hass.config.time_zone = 'Pacific/Kiritimati'` (UTC+14) and a fixed nowProvider the "Maintenant" time
  equals the Intl result for that zone; lifecycle: with a stubbed `ResizeObserver` the host AND `.chart` are
  observed after mount and again after remove / re-add (disconnect on removal); clock (fake timers): one
  render per minute boundary, none after removal, a late tick re-aligns the next one on the boundary, and a
  `visibilitychange` to visible re-renders; clipping: `g.points` has no clip-path, every `circle.dot` has one;
  the now label has its `rect.now-halo`; layout: the static styles size the chart from container-query units
  and never use the `aspect-ratio` property.
- M3 rendering amendments are tested in `test/card.interactions.test.ts` (the "fix plan B" / "fix plan C"
  blocks): B5 the SVG overflow and the hit clip of a point outside the window, B6 the 10 px marker clip,
  B8 the state classes on group and marker, C6 the point group roles; see docs/interactions-spec.md,
  section 12.
- `test/editor.test.ts` (M5): the visual editor and `src/config.ts` (section 7).
- `test/card.now-outside.test.ts` (M5): the edge marker of a now outside the window (section 2.4): left
  edge at 14:39 and right edge at 09:30 with the default window (triangle vertices, label text / anchor /
  position, halo inside the SVG), none inside the window and the bounds counted as inside (16:59 / 17:00,
  08:00 / 08:01), label above the triangle when there is room, the label moved to the other side of the
  tip when only that side misses the curve, the paint order (label between the area and the line,
  triangle over the points) that keeps the curve visible when the label has to cross it (the default
  curve at 14:39), `segmentMeetsBox`, custom window, invalid curve, the
  `pointer-events: none` rule, the clamp on a 120 px chart, the footer note (alone and with the points
  note), the aria-label, the switch to the line when the clock reaches 17:00 (and back to the edge after
  08:00), and the drag tooltip kept off the edge label.

## 7. Visual editor (src/editor.ts) - M5

`<time-curve-card-editor>`, registered by `src/index.ts` and returned by
`TimeCurveCard.getConfigElement()`. Native controls only (no `ha-*` element), French labels,
theme variables, controls at least 40 px high.

- Contract: `hass` property; `setConfig(config)` stores a shallow copy and never throws (anything
  but an object counts as `{}`); every committed change fires
  `new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true })` with
  the whole new config (a copy), which HA hands back through `setConfig`.
- Fields, in this order: "Entité de la courbe (input_text)" (`entity`), "Capteur cible
  (facultatif)" (`target_sensor`), "Appareil affiché (facultatif)" (`target_entity`): text inputs,
  each with a `<datalist>` of the `input_text.*` / `sensor.*` / ALL entity ids of `hass.states`,
  sorted by id, the friendly name as the option `label` when it differs from the id; "Titre
  (facultatif)" (`title`); "Type de valeur" (`preset`): a `<select>` of the presets ("Luminosité (%)
  (par défaut)", "Température (°C)", "Température de couleur (K)", "Personnalisé"; an unknown value
  shows as a disabled selected option); "Minimum" / "Maximum" / "Pas de la valeur" (`min`, `max`,
  `step`): `<input type="text" inputmode="decimal">` on one line when there is room (7 em each),
  showing the configured number or the preset's with the decimal comma (empty for a custom range);
  "Unité" / "Nom de la valeur" (`unit`, `label`): text inputs showing the configured text or the
  preset's; "Courbe par défaut (bouton Réinitialiser)" (`default_curve`): a text input whose
  placeholder is the preset's curve; "Début de la plage" / "Fin de la plage": `<input type="time" step="60">`, emitted as
  `HH:MM` strings, followed by the hint "Dans la journée de la courbe, de 12:00 à 12:00 le
  lendemain"; "Pas d'accrochage (minutes)": a `<select>` of the divisors of 60, the default marked
  "(par défaut)" (a configured value that is not one of them shows as a disabled selected option);
  "Nombre maximal de points": `<input type="number" min="2" max="{maxPointsFor(range)}">` (25 while
  the range is invalid). The pairs (unit / label, window start / end, snap / max points) share a
  line when each gets 12 em, so they stack at 360 px.
- Value keys: a preset change removes `min`, `max`, `step`, `unit`, `label` and `default_curve`
  (the new preset decides them) and removes `preset` for the default one; a switch to `custom`
  (which has no range of its own) writes the range, unit and label the card had (the normalized
  values when the config was valid, else its own keys or the previous preset's), minus the custom
  defaults (empty unit, "Valeur"), so the config stays valid. `min` / `max` / `step` accept a
  comma or a dot (`parseDecimal`); the preset's value or an emptied field removes the key (the
  field then shows the preset's value); text that is not a number is emitted as is (the
  validation explains it). `unit` / `label`: trimmed; the preset's value or an empty field
  removes the key. `default_curve`: trimmed, empty removes it.
- Display: an absent key shows its default (17:00, 08:00, 5, 12); a window value the card accepts
  shows zero-padded (`8:00` as 08:00: a time input shows a one-digit hour as empty), without
  rewriting the config; a window value that is not a time string (the integer 1020 of an unquoted
  YAML 17:00) leaves the time field empty.
- Commit: text fields on `change` (blur, Enter), or at once on an `input` event that is not plain
  typing (a datalist pick or an autofill: not an `InputEvent`, or `inputType`
  `insertReplacementText`), trimmed; the time, select and number fields on `change` (a time input
  commits each complete value typed). An EMPTY time value is not committed while its field has the
  focus: Chromium empties the value and fires `change` as soon as one segment is cleared (Backspace
  on the hour of 18:30), while the user is still typing. The field is settled on `blur`: still
  empty, a partly typed time (`validity.badInput`, e.g. `--:30`) shows the configured value again
  (nothing emitted) and an emptied field goes back to the default; an empty `change` that arrives
  without the focus (a picker's Clear button) goes back to the default at once.
- Emitted config: the keys the change does not touch stay as they are, unknown keys included; an
  emptied text field (the required `entity` too) removes its key; a window / snap / max value equal
  to its default removes its key, and an emptied time or number field goes back to the default, so
  a default is never written. Nothing is emitted when the config did not change. Key order: `type`,
  `entity`, `target_sensor`, `target_entity`, `title`, `preset`, `min`, `max`, `step`, `unit`,
  `label`, `default_curve`, `window_start`, `window_end`, `snap_minutes`, `max_points`, then the
  unknown keys in their original order.
- Inline validation: `configError(config)` (the message `normalizeConfig` throws, section 2.1) in a
  persistent `role="alert"` region under the form, in `--error-color` (empty and without margin
  when the config is valid); the fields whose key the message names as a whole word (`max` is not
  named by a `max_points` message) get `aria-invalid="true"` (red outline). The change is emitted
  anyway, so HA's preview shows the same error.
- Hints (not errors, linked with `aria-describedby`): "Entité introuvable dans Home Assistant" when
  an entity field names an id of the right domain (any domain for `target_entity`) that
  `hass.states` lacks; for the curve entity,
  "Cet input_text accepte au plus N caractères : réglez son maximum (max) à 255" when its `max`
  attribute is below 255.
- `shouldUpdate`: a change of `hass` alone re-renders only when the datalists or the hints change
  (`hass` is reassigned on every state change in HA), and stays cheap: one pass over the entity ids
  checks that the listed entities are the same, each with the same `attributes` object (HA replaces
  it only when an attribute changes); only then are the datalists rebuilt and sorted, a datalist
  with the same entries keeping its previous array, so datalists compare by reference and hints by
  value (no serialisation). A re-render never resets a value being typed:
  the field values are bound from the config, which only changes on a commit or a `setConfig`.
