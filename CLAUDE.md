# CLAUDE.md

Guidance for Claude Code working in this repository. Read this before making changes.

Maintainer- and machine-specific context (the maintainer's own Home Assistant setup and package,
and the quirks of the development machine) lives in `CLAUDE.local.md` and `private/`, both
gitignored. Claude Code loads `CLAUDE.local.md` automatically when it exists. **Never copy anything
from there into a published file** (see "The component is generic").

## What this is

**time-curve-card** — a Home Assistant Lovelace custom card that lets the user **draw a daily
value curve by dragging points** on a chart (x = time of day, y = a value: brightness %, heating
setpoint °C, colour temperature K, or any custom range). The card stores the curve in an
`input_text` helper. A **template sensor** in Home Assistant reads the same string, interpolates
the curve for the current time and exposes the target value; the user's automations push that
value to a device (a light, a thermostat...). It replaces the usual "start time, end time, max,
min, curve shape" sliders with a direct-manipulation editor.

Users mostly interact from the **Home Assistant companion apps on phones**, so touch is a
first-class input. UI strings are in **French**; code, comments, docs and commits in English.

## The component is generic

Everything that is published (every file `git ls-files --others --exclude-standard` lists, or that
is committed: the repository is public and distributed through HACS) must be generic:

- No information about a particular household: no personal names, IP addresses, device ids, real
  entity ids of anyone's setup, or description of how a particular home uses the card.
- Use the **generic example ids** everywhere (code, tests, docs, harness, examples):
  - brightness: `input_text.brightness_curve`, `sensor.brightness_curve_target`,
    `input_boolean.brightness_curve_enabled`;
  - heating: `input_text.heating_curve`, `sensor.heating_curve_target`,
    `input_boolean.heating_curve_enabled`, `climate.your_thermostat`;
  - colour temperature: `input_text.color_temp_curve`, `sensor.color_temp_curve_target`;
  - devices: `light.example_lamp` (`light.your_light` in the `ha/` examples, where the user puts
    their own light); Home Assistant host `homeassistant.local`.

### Private area

- `private/` (gitignored) holds the maintainer's own package, card config and notes; owner and
  machine context is in `CLAUDE.local.md` (gitignored). Both stay on the maintainer's machine.
- `test/jinja` also runs a package found in `private/` when its descriptor exists (see Testing),
  without naming it in any published file.
- Before publishing, a denylist scan of the household terms over the publishable files must come
  back empty.

## Architecture (the contract — don't break it)

```
┌──────────────── Lovelace ────────────────┐        ┌──────────── HA core ─────────────┐
│ custom:time-curve-card                   │ write  │ input_text.<curve>               │
│  (preset / min / max / step / unit)      │───────►│  "17:00@20;22:00@18.5;07:00@20"  │
│  parse ◄── state ── input_text           │        │            │ read                │
│  drag / add / delete points              │        │            ▼                     │
│  serialize ── input_text.set_value ──────┘        │ sensor.<curve>_target            │
│  shows "now" marker + live sensor value  │◄───────│  (Jinja interp. + override rules,│
│  (+ the sensor's mode / reason)          │        │   same vmin / vmax / vstep)      │
│  + target_entity state                   │        │            │                     │
└──────────────────────────────────────────┘        │ automations → light.turn_on,     │
                                                    │   climate.set_temperature, ...   │
                                                    └──────────────────────────────────┘
```

**The card and the Jinja sensor must compute exactly the same value for the same string, range,
step and time.** Both implementations are tested against one shared fixture file (see Testing).

### Curve string format (v2)

- `HH:MM@V` tokens joined by `;` — e.g. `19:00@100;21:00@70;22:30@30;23:30@12`,
  `17:00@20;22:00@18.5;06:00@17;07:00@20`.
- `HH` 0–23 (one or two digits), `MM` 00–59 (two digits). `V` = optional `-`, 1–4 ASCII digits,
  optional `.` + 1–2 digits (`^-?[0-9]{1,4}(\.[0-9]{1,2})?$`): no `+`, no exponent, no leading or
  trailing dot, no comma. v1 strings (integer percentages 1–100) are valid v2 strings with the
  same meaning.
- Values are handled **exactly as integers in hundredths** ("centi-units": `19.5` → 1950, `-2.05`
  → -205), built from the digit strings on both sides, never through a float.
- Range `{ min, max }` and `step` come from the card config (preset); each parsed value is clamped
  to the range. Brightness = 1..100 step 1, which reproduces v1 exactly.
- Must fit in an `input_text` → **max 255 chars**. Cap the card at `max_points` (default 12,
  upper bound `maxPointsFor(range)` = `floor(256 / maxTokenLength(range))`: 25 for brightness, 23
  for the temperature and colour temperature presets).
- Serializer output is canonical: sorted (see day pivot), `HH:MM@<formatted>`, no spaces, no
  trailing `;`. Formatting: sign, integer part, `.d` / `.dd` only when non-zero, no trailing zeros
  (1950 → `19.5`, 7000 → `70`, -205 → `-2.05`).
- Parser is lenient: trims whitespace, ignores empty/invalid tokens, drops duplicate times (last
  wins), clamps values to the range. If fewer than 2 valid points remain → the curve is "invalid".

### Day pivot and interpolation semantics

- The "curve day" runs **12:00 → 12:00 next day** so a night-time curve can cross midnight.
  Sort key for a time `m` (minutes since midnight): `(m - 720) mod 1440` (use a positive modulo).
- Evaluation at time `now`: compute `k = (now - 720) mod 1440`, then
  - `k` before the first point → first point's value,
  - `k` after the last point → last point's value (so at 3 a.m. the light stays at the night
    value),
  - exactly on a point → its value as stored (even off the step grid),
  - otherwise **linear** interpolation between the two surrounding points in **exact integer
    arithmetic**: `N = a·(kb − ka) + (b − a)·(k − ka)`, `D = kb − ka`, quantized to the step `s`
    half up with `q = floorDiv(2N + D·s, 2D·s)`, result `q·s`, then clamped to the range
    (`floorDiv` exact for negatives: JS `(p - (((p % q) + q) % q)) / q`, Jinja `p // q`). No
    float anywhere, no banker's rounding.
- Linear only. The card draws straight segments — **what you see is what the sensor does**.
  Do not add smoothing/splines to the drawing unless the sensor implements the same math.
- The normative rules, with examples, are in `docs/curve-spec.md`; the Jinja sandbox pitfalls are
  in the "Notes for the Jinja implementation" block at the top of `src/core/curve.ts`.

### Target sensor contract (generic)

The card only needs the `input_text`. The template sensor (optional `target_sensor`) belongs to
the user's own package; `ha/example-package.yaml` (brightness) is the reference implementation,
with `ha/example-heating-package.yaml` and `ha/example-color-temp-package.yaml` as variants.

- **State**: the curve value at `now()` (same rules as the card), formatted like the serializer
  (`18.5`, `70`), when no rule overrides it. Unavailable (`availability:` template) when the curve
  is invalid or the `input_text` has no value — an override rule of the user's package decides
  availability for its own branch; the curve branch needs a valid curve.
- The parse block starts with the range constants `vmin`, `vmax`, `vstep` (centi-units), which
  must equal the card's `min`, `max`, `step`.
- **Attribute `mode`**: `curve` when the sensor follows the curve; ANY other string
  (conventionally `override`) means a higher-priority rule of the user's package decides the value.
- **Attribute `reason`** (optional): free text in the user's language explaining an override, shown
  as plain text by the card (whitespace runs collapsed to one space, trimmed).
- **Card chip** after the sensor value: `mode` absent → "≠ courbe" when the sensor value differs
  from the curve value (compared exactly in centi-units); `mode: curve` → nothing; any other `mode`
  → `reason` (whitespace collapsed and trimmed, max 60 characters with an ellipsis, full text in
  the `title` attribute), else "Règle prioritaire".
- The brightness example has one override rule: `input_boolean.brightness_curve_enabled` off → the
  curve's highest value (`mode: override`, `reason: Curve disabled`); its comments show how to add
  another rule before the curve (e.g. a fixed brightness in away mode, or while an alarm panel is
  armed). The heating example's rule gives a fixed comfort value; the colour temperature example
  has none. Priority: override rules first, then the curve; the curve branch keeps `mode: curve`
  and no reason.
- Jinja: only HA-sandbox-safe constructs (`namespace`, loops, `split`, `int(default)`,
  `float(default)`, `now()`, `states()`, `is_state()`, `has_value()`). The parse block is
  **byte-identical** in `availability:` and `state:` (between the parse markers; the Jinja harness
  checks it). The template re-renders every minute because it uses `now()` — keep it that way.
- The `input_text` helper declares `max: 255` (the default is 100!), `mode: text` and **no
  `initial:`**, so the drawn curve is restored across restarts.

## Repository layout

```
src/
  core/curve.ts          # pure: parse, serialize, sortKey, evaluate (centi-units), maxValue,
                         #   maxPointsFor — no DOM, no HA
  core/geometry.ts       # pure: time/value <-> SVG coords, value axis, window, snapping, clamps
  card.ts                # LitElement <time-curve-card>
  config.ts              # config validation (card + editor), presets, the picker's stub config
  editor.ts              # visual config editor <time-curve-card-editor>
  format.ts              # French display formatting of values (decimal comma, unit)
  types.ts               # CardConfig, minimal HomeAssistant typings
  index.ts               # customElements.define + window.customCards registration + banner
  global.d.ts            # __CARD_VERSION__, window.customCards
test/
  fixtures/curve-cases.json   # SHARED fixture: {curve, time, range?, step?, expected, ...}[] — TS AND Jinja
  curve.test.ts, geometry*.test.ts, card*.test.ts (incl. card.presets.test.ts), editor.test.ts
  jinja/test_sensor.py        # renders each package's sensor with jinja2 against the fixture
dev/
  index.html + main.ts + mock-hass.ts   # standalone harness with a fake `hass` (no HA needed)
ha/
  example-package.yaml                    # brightness package: helper, boolean, sensor, automation
  example-heating-package.yaml            # heating setpoint package (°C, climate.set_temperature)
  example-color-temp-package.yaml         # colour temperature package (K, color_temp_kelvin)
  example-*package.test.json              # their descriptors for test/jinja (range, step, scenarios)
  example-dashboard-card.yaml             # brightness card config with every option
  example-dashboard-heating-card.yaml, example-dashboard-color-temp-card.yaml
docs/
  curve-spec.md, card-rendering-spec.md, interactions-spec.md   # normative specs
  images/card-light.png, card-dark.png   # README screenshots (brightness light, temperature dark)
scripts/
  deploy.mjs, screenshot.mjs, e2e-touch.mjs, check-version.mjs
.github/workflows/           # ci.yml, release.yml (tag → release with the card), validate.yml (HACS)
hacs.json, LICENSE, README.md
dist/time-curve-card.js      # build output, NOT committed (the release workflow attaches it)
private/                     # gitignored: a maintainer's own package + descriptor (not published)
CLAUDE.local.md              # gitignored: maintainer / machine context
```

## Stack & commands

- TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), **Lit 3**,
  **Vite** (library mode, single ES module output, Lit bundled in — HA does not provide it to
  custom cards), **Vitest** + happy-dom.
- Python + `jinja2` + `PyYAML` + `pytest` only for `test/jinja` (dev-only, no HA install needed),
  always through **uv** (`uv run ...`): `.python-version` and `uv.lock` pin Python and the
  `jinja2` / `PyYAML` versions of Home Assistant.
- Install with `npm ci` (the lockfile is the source of truth).

```bash
npm run dev          # vite dev server on dev/index.html with mock hass
npm run build        # -> dist/time-curve-card.js
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
npm run format:check # Prettier (npm run format to fix)
npm test             # vitest run
npm run test:jinja   # uv run pytest test/jinja (BCC_SKIP_PRIVATE=1 skips the private package)
npm run deploy       # copy dist file to $HA_WWW_PATH (e.g. //homeassistant.local/config/www) — env-driven, no hardcoded path
```

A change is done when `npm run typecheck && npm run lint && npm test && npm run format:check &&
npm run build && npm run test:jinja` pass (CI runs the same gates on every push and pull request).
UI changes are also checked in the harness and with the touch e2e tool (below).

Engineering rules:

- **Non-ASCII characters in TS sources are written as unicode escapes** (`\uXXXX` with four hex
  digits, or the code point form `\u{e9}`), comments included; several tests assert that the
  card, editor, harness and their test files are ASCII-only. Markdown, HTML and YAML files may
  contain UTF-8.
- Tools that start a Vite server or a browser (`scripts/screenshot.mjs`, `scripts/e2e-touch.mjs`)
  take explicit `--port` / `--cdp-port` arguments and stop what they started.
- Format only the files you touched (`npx prettier --write <file>`) when others are being edited.

## Card spec (summary — the normative specs are in docs/)

`docs/card-rendering-spec.md` (config, rendering, harness, editor) and
`docs/interactions-spec.md` (drag, add, select, keyboard, persistence, external updates) decide
the details; this is the overview.

### Config

```yaml
type: custom:time-curve-card
entity: input_text.brightness_curve               # required — curve storage
preset: brightness      # brightness (default) | temperature | color_temp | custom
min: 1                  # optional overrides of the preset (custom requires min, max, step)
max: 100                #   at most 2 decimals, within -9999.99..9999.99, min < max
step: 1                 #   > 0, at most 2 decimals, at most max - min
unit: "%"               #   may be empty
label: Luminosité       #   name of the value
default_curve: "19:00@100;21:00@70;22:30@30;23:30@12"   # reset curve, valid in the range
target_sensor: sensor.brightness_curve_target     # optional — live computed value + mode / reason
target_entity: light.example_lamp                 # optional — any entity, its state is shown
title: Courbe du soir                             # optional
window_start: "17:00"   # visible x-range, must lie inside the 12:00→12:00 curve day
window_end: "08:00"
snap_minutes: 5         # divides 60
max_points: 12          # 2..maxPointsFor(range) (25 for brightness)
```

Presets: `brightness` 1–100 step 1 `%` "Luminosité" (`19:00@100;21:00@70;22:30@30;23:30@12`);
`temperature` 5–30 step 0.5 `°C` "Température" (`17:00@20;22:00@18.5;06:00@17;07:00@20`);
`color_temp` 2000–6500 step 50 `K` "Température de couleur" (`17:00@4000;21:00@2700;23:00@2200`);
`custom` requires `min` / `max` / `step`, unit '' and label "Valeur".

Validate config in `setConfig` and throw readable French errors (HA shows them in the card).
Implement `getCardSize()`, `getGridOptions()` (sections view) and `static getStubConfig()` (the
first `input_text` whose state is a valid curve, else the first `input_text`, else
`input_text.brightness_curve`; no title, no preset).

### Rendering (SVG inside `ha-card`)

- Hour ticks on x (labels every 1–2 h depending on width); value axis with "nice" bounds around
  the range, 4–6 intervals (0/25/50/75/100 % for brightness), the unit on the top label.
- Curve as a polyline + soft area fill under it; flat extensions to the window edges before the
  first / after the last point.
- Points as circles with a **≥ 44 px invisible hit target** (touch).
- A vertical **"now" line** + label with the curve value at now (an edge marker when now is
  outside the window); a status row with the curve value now, the `target_sensor` value and its
  chip (see "Target sensor contract"), and the `target_entity` state (light: "allumée · 60 %",
  climate: current temperature, other: state + unit).
- Every value is shown with the French decimal comma and the unit after a narrow no-break space
  (`19,5 °C`, `57 %`, `2700 K`), via `src/format.ts`.
- Responsive width (ResizeObserver), fixed aspect ~ 2.5:1, min height usable on a phone.
- HA theme CSS variables only (`--primary-color`, `--primary-text-color`,
  `--secondary-text-color`, `--divider-color`, `--card-background-color`, …) → light & dark;
  the curve colour can be overridden with `--time-curve-card-color`.

### Interactions

- **Drag a point** (pointer events + `setPointerCapture`; mouse, touch, pen). Time snaps to
  `snap_minutes`, value to `step` (exact, in centi-units). A point is **clamped between its
  neighbours** (no reordering, min 1 snap step apart) and to [min, max]. Tooltip `21:30 · 60 %`
  while dragging. `touch-action: none` on the SVG so dragging doesn't scroll the dashboard.
- **Add a point**: tap/click on an empty area → new point (snapped), unless `max_points` is
  reached (short message).
- **Select a point** (tap) → detail row with a time input, a value input (min / max / step of the
  config, accepts a French comma), "Supprimer" (disabled at 2 points) and "Fermer". Edits there
  apply like a drag.
- Keyboard: ←/→ = snap step, ↑/↓ = one value step, Shift ×5, Delete removes, Escape deselects.
- **Persistence**: serialize and call `hass.callService('input_text', 'set_value', { entity_id,
  value })`, debounced ~400 ms; saving / saved / error state; "saved" only once the state echoes
  the value; on error, revert to the last known HA state.
- **External updates**: re-parse and re-render — **except while the user is dragging or has
  unsaved edits** (then keep local, save wins).
- Invalid/empty stored string → "Courbe invalide ou vide." + a reset button that writes the
  default curve (`default_curve`, else the preset's).
- A serialized string longer than 255 chars is refused with a message.

## Testing

- `test/fixtures/curve-cases.json` is the **single source of truth** for behaviour. Each case may
  carry `range` ([min, max] in centi-units) and `step` (centi), defaulting to brightness
  ([100, 10000], 100); `expected`, `canonical` and `max` are formatted strings or null. It covers
  at least: before first point, exactly on a point, mid-segment, crossing midnight
  (`23:00@40;01:00@10` at `00:00` → 25), after last point at 03:00, noon boundary (`11:59` vs
  `12:00`), 2-point minimum, unsorted input, duplicates, whitespace, invalid tokens, clamping,
  rounding at .5, non-ASCII digits, decimals, negative values, custom ranges and steps, off-grid
  stored points, invalid decimals, v1 strings unchanged.
- `test/curve.test.ts` runs every case through `evaluateCurve(parseCurve(curve, range), time,
  range)` (plus canonical form and max value).
- `test/jinja/test_sensor.py` is package-agnostic: every tested package has a JSON descriptor next
  to it (`ha/example-*package.test.json`; a private one in `private/` when present) naming its
  curve `input_text`, its sensor `unique_id`, its `range` / `step` (centi-units, equal to the
  package's `vmin` / `vmax` / `vstep`), the neutral states under which the curve rule applies, and
  rule scenarios (`states`, `available`, `state`, `mode`, `reason`). The harness renders the
  sensor's `availability`, `state` and attributes with `jinja2` in an environment that mirrors
  HA's sandbox and filters, for every fixture case whose range and step match the package and
  every scenario. The private package is collected only when its files exist;
  `BCC_SKIP_PRIVATE=1` skips it. If a case can't pass in Jinja, fix the semantics in **both**
  places — never let them diverge.
- Geometry: snapping, neighbour clamping, window mapping across midnight, value axis, coord
  round-trips (`geometry.test.ts` and an independent suite written from the spec alone).
- Card and editor: Vitest + happy-dom with the mock hass (render, drag, add, select, keyboard,
  saves, echo timeout, external updates, sensor chip rules, target entity chip, presets and custom
  ranges in `card.presets.test.ts`, editor form).
- Touch: `node scripts/e2e-touch.mjs --port <p> --cdp-port <q>` drives the harness in a real
  Chromium with touch emulation (`--list` shows the scenarios).

## Milestones (history)

- **M0** Scaffold (Vite lib build, Lit, strict TS, Vitest, ESLint/Prettier, dev harness,
  `.gitignore`). Done.
- **M1** `core/curve.ts` + shared fixture + tests green. Done.
- **M2** Read-only SVG rendering in the harness (axes, curve, now line, theme vars). Done.
- **M3** Interactions + persistence + external-update handling; touch e2e tool. Done.
- **M4** HA package + Jinja tests green + dashboard card example + install notes. Done.
- **M5** HACS packaging (`hacs.json`, release workflow attaching `dist/` on tag), README (HACS
  custom repository or manual copy to `/homeassistant/www/` + resource
  `/local/<card file>.js?v=<version>` as "JavaScript module"), visual editor, "now" marker outside
  the window. Done.
- **Genericization** (2026-09-29): the published component carries no household-specific
  information; generic sensor contract (`mode` / `reason`), generic example package and dashboard
  card in `ha/`, package-agnostic Jinja harness, owner files moved to `private/` +
  `CLAUDE.local.md`. Done.
- **Generalization** (2026-09-30): renamed from brightness-only to **time-curve-card** (element
  `time-curve-card`, `dist/time-curve-card.js`, resource `/local/time-curve-card.js?v=<version>`,
  banner `TIME-CURVE-CARD`, CSS variable `--time-curve-card-color`) before the first publish; any
  daily value: curve format v2 (values with up to 2 decimals and a sign, exact integer arithmetic
  in centi-units, range and step), presets (`brightness`, `temperature`, `color_temp`, `custom`)
  and `min` / `max` / `step` / `unit` / `label` / `default_curve`, `target_entity` replacing
  `light`, French value formatting (`src/format.ts`), heating and colour temperature examples in
  `ha/`, Jinja descriptors with range / step. Done.

Stop after each milestone with a short summary so the user can review.

## Non-obvious things that will bite you

- `hass` is reassigned on **every** state change in HA; only re-render when the relevant entities'
  state objects changed (`shouldUpdate` comparing `hass.states[id]` references). Otherwise dragging
  will stutter and local edits get clobbered.
- HA caches card JS aggressively — bump the `?v=` query on the resource after each deploy; the
  card logs a one-line version banner in the console on load.
- Register in `window.customCards` so the card shows up in the dashboard "Add card" picker.
- `input_text` is capped at 255 chars by HA (hard limit) and its default `max` is 100: the helper
  must declare `max: 255`. HA rejects a longer value by logging "Invalid value" without raising
  to the caller, hence the card's echo timeout.
- Don't depend on HA-internal elements (`ha-*`) beyond `ha-card`; they are not a stable API.
  Use native `<input type="time">` / `<input type="number">` for the detail row and the editor.
- The pivot is noon: a point at `11:00` sorts **after** `23:00`. Make that visible in the UI if the
  window includes late morning.
- "Now" is HA's time zone (`hass.config.time_zone`), not the phone's, like the sensor's `now()`.
- The card's range / step and the sensor's `vmin` / `vmax` / `vstep` must match, or the two
  compute different values. A temperature sensor must not declare `device_class: temperature`
  (HA would convert its state to the installation's unit system).
- Zigbee bulbs may ignore very low brightness (often < 3 %): that's a device limit, not a card bug.
- Times in YAML must be quoted (`"17:00"`): YAML 1.1 reads an unquoted `17:00` as the base-60
  number 1020.
