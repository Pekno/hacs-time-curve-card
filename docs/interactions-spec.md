# Card interactions spec (normative, M3)

Refines CLAUDE.md ("Card spec" > Interactions) for milestone M3. Where CLAUDE.md is silent, THIS
document decides. It is the M3 working spec with every decision of the M3 fix plan folded in; the
plan items are referenced in brackets (**[A1]** ... **[C9]**) so a test or a review can point at
them. The rendering is specified in `docs/card-rendering-spec.md` (M2, with its M3 amendments
marked there) and the curve semantics in `docs/curve-spec.md`. UI strings are French; code,
comments and test names are English; non-ASCII characters in TS source are written as `\u`
escapes. The pure helpers of `src/core/curve.ts` and `src/core/geometry.ts` keep their semantics
(a new pure helper may be added to `geometry.ts` when this document needs it, with tests).

The M3 repair (findings of the independent verifiers) amends some of the plan's decisions; its
own decisions are marked **[R1]** ... **[R9]**:

| Item   | Decision                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------- |
| **R1** | A dragged point keeps its grab offset (section 2.3).                                           |
| **R2** | The drag tooltip never covers the "now" label (section 4).                                     |
| **R3** | The save chip is a slot of fixed size; the full error also shows in the message line (5.5, 7). |
| **R4** | One `set_value` call in flight at a time (section 5.2).                                        |
| **R5** | A debounce ends a drag whose pointer is gone (section 2.3).                                    |
| **R6** | After an external update the selection follows its point (sections 1.4, 6.1).                  |
| **R7** | The pointer modality ends on any key in the document, and when the card is removed (3.2).      |
| **R8** | A typed 12:00 is the end of a window ending at 12:00 (section 6.2).                            |
| **R9** | The M3 TS sources (card, dev harness and mock, interaction tests) are ASCII-only (section 12). |

Generalization (time-curve-card): the card edits ANY value range, not only a brightness
percentage. The config's **range** (`min`, `max`, value step, from the `preset` or explicit keys;
docs/card-rendering-spec.md, section 2.1) replaces the fixed 1..100 of M3 everywhere below: every
value a drag, a tap, a key or the detail row produces goes through
`clampValue(candidate, range)` (rounded to hundredths, clamped, snapped to the value step half up
with exact integer arithmetic, clamped again), and every value is shown with the French decimal
comma and the unit of the config (`19,5 °C`, `57 %`, `2700 K`). With the default brightness
preset (1..100, value step 1, unit `%`) every behaviour of M3 is unchanged.

Terms: a **key** is a curve-day key (`sortKey`: 12:00 -> 0 ... 11:59 -> 1439); **step** is
`snap_minutes` (the **value step** is the range's `step`); the **stored curve** is the parsed state
of the `input_text` entity (parsed with the range: values clamped into it); the **rendered curve**
is `localPoints ?? hassPoints` (section 1.1).

## 1. State model (src/card.ts)

### 1.1 Fields

| Field                       | Kind   | Meaning                                                                                                                                            |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hassPoints`                | plain  | `parseCurve(hass.states[entity]?.state)`, re-parsed only when the state STRING changes (`hassCurveState` keeps the last one; undefined = missing). |
| `localPoints`               | @state | `CurvePoint[] \| null`: the curve edited locally, always sorted (`sortCurve`), integer values in [1, 100]; `null` = no local edits.                |
| `points` (getter)           | -      | The rendered curve: `localPoints ?? hassPoints`.                                                                                                   |
| `dirty` (getter)            | -      | `localPoints !== null`.                                                                                                                            |
| `valid`                     | plain  | `isValidCurve(hassPoints) && isValidCurve(points)`: the chart is chosen from the STORED curve **[A9]**.                                            |
| `selectedIndex`             | @state | `number \| null`: index into the rendered (sorted) curve.                                                                                          |
| `selectionKey`              | plain  | Key of the detail row, bumped whenever the selection moves to another point **[C2]** (sections 1.2, 1.4).                                          |
| `drag`                      | plain  | `DragState \| null`: the active pointer interaction (section 2.2); every change of it comes with a @state change.                                  |
| `dragging`                  | @state | true while a point is dragged past the tap slop (tooltip, enlarged marker).                                                                        |
| `saveState`                 | @state | `'idle' \| 'saving' \| 'saved' \| 'error'` (save chip, section 5.5).                                                                               |
| `saveError`                 | @state | `string \| null`: text of the error chip.                                                                                                          |
| `pendingValue`              | plain  | `string \| null`: the serialized string of the ONE call in flight (sent, not yet echoed back) **[R4]**.                                            |
| `saveDeferred`              | plain  | true when a save came due while a call was in flight: it goes out after that call's echo **[R4]** (section 5.2).                                   |
| `lastFailedValue`           | plain  | `string \| null`: the value whose echo timed out **[A7]**.                                                                                         |
| `message`                   | @state | `string \| null`: transient user message (section 7), cleared after 4 s.                                                                           |
| `chartPlot`, `chartViewBox` | plain  | Plot area and viewBox of the last rendered chart; pointer coordinates map through them.                                                            |

```ts
/** The active pointer interaction: a point drag, or a press on the chart background (index -1). */
interface DragState {
  index: number; // point index in the rendered curve; -1 = chart background
  pointerId: number;
  startX: number; // client coordinates of the pointerdown (tap slop)
  startY: number;
  slop: number; // tap slop of this pointer type, px, Chebyshev [B3]
  moved: boolean; // true once the pointer travelled past the slop
  capture: Element | null; // element holding the pointer capture [B1]; null when unsupported
  frame: SvgFrame | null; // SVG box measured at pointerdown [B2]; null = measure again
  grabX: number; // grab offset [R1], SVG units: marker centre - pointer at pointerdown
  grabY: number; // (0 for the chart background)
}
/** svg = (client - left|top) * scale; scale = viewBox.width / rect.width (1 for a 0 width). */
interface SvgFrame {
  left: number;
  top: number;
  scale: number;
}
```

Timers (each one `setTimeout`, armed only while the card is connected, see section 5.8): save
debounce 400 ms, "Enregistré" chip 2 s, message 4 s, echo timeout 5 s.

### 1.2 Applying a change

`applyPoints(next, { save })`:

1. `sorted = sortCurve(next)`. If `serializeCurve(sorted).length > MAX_CURVE_LENGTH` (255) the
   change is REFUSED: message "Courbe trop longue pour input_text (N > 255 caractères)", state
   unchanged, returns false (section 5.7).
2. `localPoints = sorted`; with `save` -> `scheduleSave()` (section 5.1); returns true.

Built on it:

- `movePoint(index, time, value, save)`: a no-op (success) when the point is already there.
- `deletePoint(index)`: refused (returns false) when `points.length <= MIN_POINTS` (2); always
  `{ save: true }`. The caller moves the selection.
- `selectPoint(index, another = false)`: sets `selectedIndex` and bumps `selectionKey` when the
  index changes, or when `another` says a different point now sits at the same index (a point
  added, a keyboard delete).

`max_points` limits ADDING points only (section 2.5): a stored curve with more points (written
outside the card) is shown and editable, within the length guard.

### 1.3 Snapping and clamping a key (`resolveKey`)

The drag, the keyboard and the time input share one rule, so they always agree:

- `snapped = roundHalfUp(rawKey / step) * step`, in KEY space (never wraps around the pivot).
- The **drag window** is the configured window, except that a `window_end` of 12:00 (end key
  `1440`) ends at `1440 - step`: key 1440 is the pivot again (12:00 = key 0) and a point there
  would jump to the start of the curve day.
- `lower = max(dragWindow.startKey, prevKey + step)` and
  `upper = min(dragWindow.endKey, nextKey - step)`, where prev / next are the neighbours in the
  rendered curve (no bound at the ends).
- `lower > upper` (neighbours less than two steps apart, or a neighbour within one step of the
  window edge): NO ROOM, the key is null and the point keeps its time.
- Otherwise `key = clampKeyBetween(snapped, prevKey, nextKey, step, dragWindow)` and
  `clampedBy` is `'window'` or `'neighbour'` when the clamp moved the snapped key (the window wins
  a tie), `null` otherwise.
- `time = (key + 720) % 1440`.

### 1.4 External updates (`willUpdate`)

When the curve entity's state string differs from the last parsed one, `willUpdate` re-parses it,
then:

1. **Echo [A2]**: `pendingValue !== null` and the new state equals it -> `pendingValue = null`,
   echo timeout cleared; `localPoints = null` ONLY if `serializeCurve(localPoints) === state`;
   `saveState = 'saved'` (2 s, then `'idle'`) ONLY when `localPoints` ended up null. Otherwise the
   chip stays on "Enregistrement…": newer edits are scheduled, waiting or being dragged, and their
   own save reports. A save that waited for this echo (`saveDeferred`, **[R4]**) is sent right
   after the current update (never from inside it: with a synchronous echo the update would miss
   it), unless a debounce armed since or a drag in progress sends it later.
2. **Late echo [A7]**: else, `saveState === 'error'` and the state equals `lastFailedValue` -> HA
   was only slow: `lastFailedValue = null`, `saveError = null`, "Enregistré" chip. The failure
   already cleared `localPoints`, so the rendered curve follows the state.
3. Otherwise a dirty card (including during a drag) keeps its local curve: local edits win, the
   scheduled / in-flight save overwrites the external value. A clean card renders the new stored
   curve.

**Selection [R6]**: when a clean card (no local edits) takes a new stored curve, the selection
follows its point, found by time: same point at another index (a point inserted or removed before
it) -> `selectedIndex` moves, `selectionKey` does not (the detail row, and what the user is typing
in it, stays with its point). Point gone (moved or deleted elsewhere) -> the index is kept but it
is another point now: `selectPoint(index, true)` gives its row fresh inputs. The same goes for a
point pressed but not moved yet (the card is still clean): `drag.index` follows the pressed point
to its new index, so the coming drag moves THAT point; when it is gone the press ends
(`abortDrag`, the rest of the gesture changes nothing).

On every update, after that: `valid` is recomputed; `selectedIndex` is dropped when the curve is
not valid and moved to the last point when it is past the end. A stored curve that turns invalid
DURING a drag ends the drag as a release would (section 2.4: the moved point is saved, over the
invalid value), since the chart and its listeners go away **[A9]**. The "Maintenant" value, the now
marker and the footer note follow the rendered curve (local edits included).

### 1.5 Which block is rendered [A8, A9]

The card body renders, in order: the status row (ending with the save chip), the chart when
`valid` or else an `.invalid` block, the detail row (section 6), the message line (section 7) and
the footer notes. The `.invalid` block:

| Stored state                                           | Block                  | Content                                                                                      |
| ------------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------- |
| entity absent from `hass.states`                       | `.invalid.missing`     | "Entité introuvable" + the entity id in `<code>`; NO reset button                            |
| `unavailable` (or `hass` not set yet)                  | `.invalid.unavailable` | "Entité indisponible" + the entity id in `<code>`; NO reset button                           |
| `unknown` (never written)                              | `.invalid`             | "Courbe invalide ou vide." (no `<code>`) + the reset button                                  |
| any other invalid string (`''`, malformed, < 2 points) | `.invalid`             | "Courbe invalide ou vide." + the raw string in `<code>` (none when empty) + the reset button |

No reset button for a missing or unavailable helper: the write would be rejected, or (HA starting
up) would overwrite the user's curve as soon as the helper is back. `unknown` is different: a new
`input_text` without `initial:` starts `unknown` until it is written once (HA restores a written
value across restarts), so there is no curve to lose and the reset button is what the first start
after the migration needs.

## 2. Pointer interactions (SVG)

Listeners sit on the `<svg>` (delegation): `pointerdown`, `pointermove`, `pointerup`,
`pointercancel`, `lostpointercapture`, plus `focusin` and `keydown` (section 3). The move and end
handlers ignore events whose `pointerId` differs from `drag.pointerId`.

### 2.1 Coordinates [B2]

SVG user units = `(clientX - frame.left) * frame.scale`, `(clientY - frame.top) * frame.scale`.
The frame is measured once (one `getBoundingClientRect`) at pointerdown and cached in the
`DragState` for every event of that interaction; `scale = viewBox.width / rect.width`, 1 when the
width is 0 (happy-dom, hidden card). A ResizeObserver callback during an interaction drops the
cache (`frame = null`) and the next pointer event measures again (the re-render at the new width
runs before it). Plot area and viewBox are the ones of the last render.

### 2.2 Press (pointerdown)

1. `event.button > 0` (secondary mouse buttons) -> ignored.
2. **Stale interaction [A5]**: when `drag !== null`, a press of ANOTHER pointer while the old
   capture is still held is ignored (a second finger during a drag). Otherwise (the same pointer:
   its pointerup never arrived; or the old pointer is gone and its capture with it) the old
   interaction is ended as a release would end it (section 2.4: capture released, state cleared, a
   moved point scheduled for saving) and the new one starts.
3. Target: the closest `g.point` of `event.target` gives the point index (`data-index`); a group
   whose index is not a rendered point -> ignored. No group -> a background press (index -1).
4. Set the host attribute `pointer-focus` **[C4]** (section 3.2).
5. Blur a focused detail-row input (`shadowRoot.activeElement` inside `.detail`), so its pending
   `change` commits to the point that row was rendered for BEFORE the selection moves **[C1]**
   (the `preventDefault` below would otherwise keep it focused).
6. `preventDefault()`.
7. **Pointer capture [B1]** (guarded: `setPointerCapture` may be missing or throw): a point press
   captures on the pointerdown TARGET, the pressed circle (the `circle.hit`, or the `circle.dot`
   drawn over its centre), never on the group; a background press captures on the SVG. Captured
   events still bubble to the SVG listeners.
8. `drag = { index, pointerId, startX, startY, slop, moved: false, capture, frame, grabX, grabY }`
   with `slop = tapSlop(pointerType)`, the frame measured here and, for a point, the grab offset
   **[R1]** `grabX = keyToX(point key) - x`, `grabY = valueToY(point value, plot, axis) - y` (the pointer
   position in SVG units; 0 for the background).
9. A point press selects the point (`selectPoint(index)`) and focuses its group
   (`focus({ preventScroll: true })`), so the keyboard works right after a tap.

### 2.3 Move (drag a point)

- **Tap slop [B3]**: until `moved`, a pointer that travelled less than `slop` px (Chebyshev,
  client px from the press) is ignored: 8 px for `pointerType` `'touch'` and `'pen'` (Android's
  touch slop is about 8 dp), 3 px for `'mouse'` and unknown types. Reaching the slop sets
  `moved = true`; a roll within the slop stays a tap.
- Background interaction: a move does nothing (a swipe).
- Point: `dragging = true`; the marker keeps its grab offset **[R1]**: with `x' = x + grabX` and
  `y' = y + grabY`, the key comes from `resolveKey(xToKey(x'), index, points)` (section 1.3) - no
  room keeps the time; `value = clampValue(yToValue(y', plot, axis), range)` (snapped to the
  value step, clamped to the range) follows the pointer even when the time
  is refused; `movePoint(index, time, value, false)` (no save per frame). A point grabbed off its
  centre (anywhere in its 44 px target; on a phone the finger hides the marker, so off-centre is
  the norm) moves WITH the pointer instead of jumping under it: a vertical drag changes the value
  only. The offset is in SVG units (= CSS px), kept across a resize. With the capture the pointer
  may leave the SVG: the point stays clamped to the drag window and to the range. A point never
  crosses a neighbour, so indices are stable during a drag.
- **Debounce vs live drag [A6, R5]**: a save debounce armed before the drag (a drag that starts
  less than 400 ms after the previous edit) must never write an intermediate position: while a
  point is being dragged (`drag.moved && drag.index >= 0`) and the drag is LIVE, a debounce that
  comes due is re-armed instead of saving, so it can only fire after the release, which schedules
  the real save anyway. Live = its capture holder still holds the pointer (`hasPointerCapture`),
  or the browser gave no capture (`capture === null`: a live drag cannot be told from a stale one
  then). A stale drag (its pointer gone without any end event reaching the card) is ended there
  as a release would end it, and the save goes out: it no longer blocks every later save, and its
  tooltip goes away.

### 2.4 Release (pointerup / pointercancel / lostpointercapture)

- Release the capture if it is still held; `drag = null`; `dragging = false`; a point that moved
  -> `scheduleSave()` (the same for `pointercancel` and `lostpointercapture`).
- A `pointerup` without movement is a TAP. On a point it stays selected (done at pointerdown; the
  detail row shows); tapping the selected point again keeps it selected (no toggle: the row closes
  with "Fermer" or Escape). On the background it adds a point (section 2.5) at the release
  position. `pointercancel` / `lostpointercapture` without movement do nothing more.
- A background tap never deselects; a swipe (a background press that moved) does nothing.

### 2.5 Add a point [B4]

A background tap at `(x, y)` (SVG units), checked in this order:

1. Outside the plot area -> ignored, no message.
2. `points.length >= max_points` -> "Nombre maximal de points atteint (N)".
3. `key = roundHalfUp(xToKey(x) / step) * step` (key space). Not `isKeyVisible(key, dragWindow)`
   -> "En dehors de la fenêtre affichée" (the right edge of a window ending at 12:00 rounds to key
   1440; a window start off the snap grid can round before it).
4. An existing point with `|key - key_i| < step` -> "Trop proche d'un point existant" (a point
   exactly one step away is accepted).
5. `time = (key + 720) % 1440`, `value = clampValue(yToValue(y, plot, axis), range)`,
   `applyPoints([...points, { time, value }], { save: true })`; the new point is selected
   (`selectPoint(indexOf(time), true)`).

### 2.6 Interrupted interactions

- A failed save (section 5.4) aborts an active drag first **[A4]**: capture released,
  `drag = null`, `dragging = false`, NO save scheduled; later pointermoves of that pointer change
  nothing and no extra call is made.
- The card removed mid-drag **[A5]**: section 5.8.
- The stored curve turning invalid mid-drag: section 1.4.

## 3. Keyboard

### 3.1 Keys

The SVG has `tabindex="0"`; each point group has `tabindex="0"` (section 9). A point group that
receives the focus (Tab, or a press) is selected (`focusin`). The `keydown` listener on the SVG
acts only while a rendered point is selected. Alt / Ctrl / Meta combinations are left to the
browser and the OS: no action, no `preventDefault` **[C5]**. `preventDefault()` is called on the
handled keys only; every edit applies with `{ save: true }` (the 400 ms debounce coalesces
repeats).

| Key                    | Action                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ArrowLeft / ArrowRight | Time -/+ `step` minutes (Shift: x 5) from the point's key, through `resolveKey` (section 1.3); no room -> nothing.                                                                                           |
| ArrowUp / ArrowDown    | Value +/- one value step (Shift: 5 steps) through `stepValue(value, steps, range)`: an off-grid value first moves to the grid line on that side, then clamped to the range (brightness: +/- 1, Shift +/- 5). |
| Delete / Backspace     | Delete the point (refused at 2 points, like the button). The neighbour `min(index, length - 1)` becomes selected and its group is focused after the update, so repeated presses keep working **[C5]**.       |
| Escape                 | Deselect and focus the SVG **[C5]**.                                                                                                                                                                         |

Keys typed in the detail row never reach this handler (the row is outside the SVG). The
"Fermer" and "Supprimer" buttons also move the focus to the SVG after the update **[C5]**.

### 3.2 Focus modality [C4]

A pointer-given focus must not paint a keyboard focus ring (Chromium matches `:focus-visible` for
a programmatic focus that follows a touch). The host attribute `pointer-focus` is set by every
press the card handles (before the pressed group is focused) and removed by any `keydown` in the
DOCUMENT without Alt / Ctrl / Meta **[R7]**: while the attribute is set, a capture-phase `keydown`
listener on `document` watches for the next key wherever the focus is (keys in the detail row, and
a Tab pressed outside the card after a click elsewhere that brings the focus back in, which must
show the ring). The modifier exception follows the browsers' own `:focus-visible` heuristic: a
shortcut is not keyboard navigation. Removing the card also leaves the modality and drops the
listener (a removed card holds no focus). A window blur keeps the attribute: coming back to the
app shows no ring on the last tapped point. The rings are scoped to
`:host(:not([pointer-focus]))`:

- `.point:focus-visible .hit`: a dashed ring on the 44 px hit target (stroke
  `--primary-text-color`, 1 px, dash `4 3`, opacity 0.6);
- `.chart svg:focus-visible`: a 2 px `--primary-color` outline, offset 2 px.

## 4. Tooltip while dragging [B7]

`<g class="tooltip">` (`pointer-events: none`), drawn over everything while `dragging`:

- Text `HH:MM · <value>`: the value with the decimal comma and the unit after U+202F
  (`21:30 · 60 %`, `22:00 · 19,5 °C`), 12 px, `--primary-text-color`, tabular numbers,
  centred in its box (`text-anchor: middle`, `dy: 0.35em`).
- Box: `rect`, rx 4, height 18, width `text.length * 6.6 + 12`, fill `--tcc-surface`, 1 px
  `--divider-color` stroke.
- x: centred on the marker, clamped to `[2, width - 2 - boxWidth]` (never outside the SVG).
- y: above the marker, `boxY = max(2, cy - 14 - 18)`; below it, `boxY = cy + 22`, when
  `cy < 14 + 18 + 2 + 1 = 35` (a marker at cy 31 gets the tooltip below, one at cy 35 above).
- **Now label [R2]**: the "now" label is the live readout of a reshaped curve (what the lamp gets
  now), so the tooltip never covers it. When the box comes closer than 2 px to the label's halo
  box (the `.now-halo` rect, docs/card-rendering-spec.md section 2.4; M5: the halo of the edge
  label when now lies outside the window, same rule), `placeTooltip` moves it,
  keeping it 2 px or more inside the SVG:
  1. past the label on the side of the marker the tooltip is on (above: higher,
     `boxY = haloY - 2 - 18`; below: lower, `boxY = haloY + haloHeight + 2`), still centred on the
     marker, so a tooltip above stays clear of the finger;
  2. else beside the label at the same height, on the side away from the label first
     (`boxX = haloX - 2 - boxWidth` or `haloX + haloWidth + 2`);
  3. else where it was (nothing fits: a tiny chart).
- Coordinates go through the 2-decimal formatter like every other coordinate.

## 5. Persistence

### 5.1 Debounce and flush

- `scheduleSave()`: 400 ms debounce, cleared and re-armed on every call. When it comes due during
  a live point drag it re-arms itself; a stale drag is ended and the save goes out (section 2.3,
  **[A6, R5]**); otherwise it runs `save()`.
- `flushSave()`: when a debounce is armed or a save is waiting for the call in flight
  (`saveDeferred`), clears both and runs `save(force = true)` now: the page may be gone before
  either comes due, so it does not wait for the call in flight **[R4]**. Called on
  `visibilitychange` to `hidden` (the WebView may be killed) and by the reset button (5.6).
- Card removal: section 5.8.

### 5.2 `save(force = false)` [A1, R4]

**One call in flight at a time [R4]**: the echo is recognised by its value, which is only
unambiguous with a single call in flight. With several, edits going X -> Y -> X (calls X, Y, X)
let the echo of the FIRST X end the session early: the echo of Y was then adopted as an external
update (the curve jumped back to the intermediate edit) and a rejection of the last X was ignored
(its edit silently lost).

1. Nothing without config / hass, or when `localPoints === null`.
2. `value = serializeCurve(localPoints)`. The reference is the value HA WILL hold:
   `pendingValue ?? stored state`.
3. `value === pendingValue` -> return: it is already in flight and its echo ends the session.
4. `pendingValue !== null` and not `force` -> `saveDeferred = true`, return: the save goes out
   once that call is echoed (section 1.4, step 1); a failure reverts the edits instead (5.4).
5. `pendingValue === null && value === stored state` -> nothing to write: `localPoints = null`,
   `saveDeferred = false`; if `saveState === 'saving'` (the echo of an earlier save came back while
   these edits were still open, **[A2]**) -> "Enregistré" chip. Return.
6. Otherwise send: `saveDeferred = false`, `pendingValue = value` (with `force`, replacing the
   value in flight), `lastFailedValue = null`, echo timeout cleared, `saveError = null`,
   `saveState = 'saving'`, then
   `await hass.callService('input_text', 'set_value', { entity_id: config.entity, value })`.
7. Once the call settles: if `pendingValue !== value` (already echoed, or superseded by a forced
   save) the call has nothing more to say, its rejection included. Else a rejection ->
   `failSave("Erreur d'enregistrement : " + errorMessage(error))` (U+00A0 before `:`,
   **[A3, C9]**); a resolution -> arm the echo timeout (5.3).

`force` is only used by `flushSave()` (page hidden, reset button) and the card removal (5.8), where
waiting could lose the edit; a second call in flight is then accepted (the older echo is taken for
an external update, which a dirty card ignores).

Examples (latency 1 s, debounce 400 ms): point dragged away (call X at t = 400), then dragged back
to the stored position -> at t = 800 the save waits; at t = 1400 X is echoed and a second
`set_value` with the original string is sent (the stored state is not the reference while a value
is in flight); the curve ends at the original position. Edits X -> Y -> X within the latency: only
X is sent (the last save finds X in flight), its echo ends the session. Edits X -> Y -> Z: X, then
Z after X's echo; a rejection of Z shows the error and reverts to X.

### 5.3 Echo, echo timeout, late echo

- "Saved" is shown only on the echo (section 1.4): a resolved call proves nothing, HA logs
  "Invalid value" without raising when the value exceeds the helper's `max`.
- Echo timeout: 5 s after the resolution, when `pendingValue` is still set ->
  `failSave("Valeur refusée par Home Assistant (vérifiez max: 255 sur l'input_text)")` (`max: 255`
  is YAML: no French colon), then `lastFailedValue = the timed-out value` **[A7]**.
- A late echo of that value turns the error into "Enregistré" (section 1.4, step 2).

### 5.4 Failure: `failSave(message)` [A3, A4]

1. Abort an active drag (section 2.6): capture released, no save scheduled.
2. Clear the debounce, the echo timeout and `saveDeferred` (the waiting edits are reverted too).
3. Revert to the last known HA state: `pendingValue = null`, `localPoints = null`,
   `selectedIndex = null`.
4. `saveError = message`, `saveState = 'error'`.

`errorMessage(error: unknown): string` (exported): an `Error` -> its `message`; an object with a
string `message` (the HA websocket rejects with `{ code, message }`) -> that message; a string ->
itself; a number -> `code N`; anything else -> `String(error)`. Example:
`{ code: 'invalid_format', message: 'Value too long' }` -> the chip reads "Erreur
d'enregistrement : Value too long".

### 5.5 Save chip [C8, R3]

One persistent `<span class="chip save {saveState}" role="status" aria-live="polite">`, last in the
status row. The element stays; only its content changes (a live region inserted together with its
text is often not announced).

**Slot of fixed size [R3]**: the chip's box never depends on its text or state, so a save that
starts, ends or fails never re-wraps the status row and never moves the chart under the finger (an
error arrives up to 5 s after a release, when the user may be tapping again). It is always in the
flex flow (empty while idle), `flex: 1 1 8em` (8 em of its 13 px text: "Enregistrement…" fits),
`min-width: 0`, exactly one status line high (`height: 20px` = the row's `line-height`), one line
(`white-space: nowrap` of `.chip`), `overflow: hidden`, `text-overflow: ellipsis`,
`text-align: end`: it takes at least 8 em and grows into the rest of its line. The state classes
only change the colour. Cost: when the last status line has less than 8 em + the 16 px gap left,
the (empty) slot sits on a line of its own, permanently. A longer text (an error; the echo-timeout
text never fits a phone) is cut with an ellipsis; the chip's `title` holds the full error, and the
message line below the chart shows it in full (section 7).

| `saveState` | Content                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`      | Empty (the slot stays).                                                                                                                                         |
| `saving`    | "Enregistrement…"                                                                                                                                               |
| `saved`     | "Enregistré", 2 s, then `idle`.                                                                                                                                 |
| `error`     | `<span role="alert">{saveError}</span>` in `--error-color`, `title={saveError}`, cut by the ellipsis; stays until the next save is sent or a late echo arrives. |

### 5.6 Reset button [A8, A9]

Only in the `.invalid` block of an invalid string or a never-written (`unknown`) helper (never for
a missing / unavailable entity, section 1.5): a native `<button type="button" class="reset">` labelled "Réinitialiser la
courbe", styled like the detail-row buttons. A click applies the config's default curve parsed
with its range, `parseCurve(defaultCurve, range)` (`default_curve` when configured, else the
preset's curve: brightness `19:00@100;21:00@70;22:30@30;23:30@12`, temperature
`17:00@20;22:00@18.5;06:00@17;07:00@20`, colour temperature `17:00@4000;21:00@2700;23:00@2200`,
custom `19:00@<max>;23:00@<min>`), through `applyPoints({ save: true })`, then
`flushSave()` (the call is immediate). The block stays (the chart is chosen from the STORED
curve): the button is disabled and the chip says "Enregistrement…" until the echo (then the chart
appears with the default curve, chip "Enregistré") or the error (the block stays, the button is
enabled again). A click while saving does nothing.

### 5.7 Length guard

`applyPoints` refuses any change whose canonical string would exceed 255 characters, whatever its
source (drag frame, keyboard, detail row, add): message "Courbe trop longue pour input_text (N >
255 caractères)", curve unchanged, a detail field shows the unchanged value again. Adding points
cannot overflow (`max_points <= maxPointsFor(range)`, 25 for brightness, and that many tokens of
the range's grid fit), but a stored curve written elsewhere can sit at the limit (32 tokens
`HH:MM@1` = 255 characters): widening one value to 2 digits is then refused.

### 5.8 Lifecycle

- `disconnectedCallback` **[A5]**: leaves the pointer modality (section 3.2, **[R7]**), ends an
  active drag (capture released, state cleared, no save scheduled by it) and, when
  `localPoints !== null`, clears the debounce and `saveDeferred` and runs `save(force = true)` at
  once (the in-progress drag or the scheduled / waiting edit goes out instead of being lost, even
  while another call is in flight, **[R4]**). Clears the chip, message and echo-timeout timers
  (plus the M2 clock, ResizeObserver and `visibilitychange` listener). No timer is left behind.
- `connectedCallback` re-arms the timers whose state survived a removal: the message (4 s), the
  "Enregistré" chip (2 s) and, while `pendingValue` is set, the echo timeout.

## 6. Detail row

Rendered below the chart while `selectedIndex !== null` and the curve is `valid`:

```html
<div class="detail">
  <label>Heure <input type="time" step="{snap_minutes * 60}" /></label>
  <label>
    {label}
    <input type="number" lang="fr" min="{min}" max="{max}" step="{step}" inputmode="{mode}" />
    {unit}
  </label>
  <span class="actions">
    <button type="button" class="delete">Supprimer</button>
    <button type="button" class="close">Fermer</button>
  </span>
  <!-- only while "Supprimer" is disabled -->
  <span class="hint" id="tcc-delete-hint">Une courbe garde au moins 2 points</span>
</div>
```

`{label}`, `{min}`, `{max}`, `{step}` and `{unit}` come from the config (brightness: "Luminosité",
1, 100, 1, "%"); `{mode}` is `numeric` for a whole-number step and a range without negative values,
`decimal` otherwise. The field shows the value in the storage form (`18.5`: a number input needs a
dot); `lang="fr"` lets the browsers that localize number inputs accept a comma.

### 6.1 Binding [C1, C2]

- The row is `keyed` (lit/directives/keyed.js) on the selected point: its key (`selectionKey`,
  section 1.2) changes whenever the selection moves to another point, even one with the same values
  or at the same index, so the inputs are recreated and a value typed for one point never shows on
  the next. Local edits of the selected point (drag, keyboard, the row itself) keep the key (same
  point: the focus stays in the row); an external update keeps it when the selected point still
  exists, at whatever index, and bumps it when that point is gone **[R6]** (section 1.4).
- The `.value` bindings are plain (no `live()`): Lit writes them only when the point's value
  changes, so an unrelated re-render (clock tick, sensor or target entity update) never overwrites what the
  user is typing.
- The `change` handlers are bound to the POINT the row was rendered for (its time), not to
  `selectedIndex`: they look up its current index and ignore the event when the point no longer
  exists (a late `change` of a replaced row). With the blur at pointerdown (section 2.2, step 5), a
  value typed in the number input followed by a press on another point lands on the FIRST point.
- After a change the field is reset explicitly to what the point holds now whenever they differ
  (refused, clamped, adjusted or invalid input).

### 6.2 Time input [C3]

On `change`:

1. `requested = parseTime(value.slice(0, 5))`; null -> "Heure invalide", point unchanged.
2. `requested === point.time` -> nothing, no message.
3. `requestedKey = sortKey(requested)`, except for 12:00 **[R8]**, which is both ends of the curve
   day (key 0 and key 1440): when the window ends at 12:00 (end key 1440) it is key 1440 if the
   window does not start at 12:00 (12:00 only shows at its right edge), else (the whole curve day,
   12:00 -> 12:00) the end nearer to the point's key (1440 from key 720 on). So 12:00 typed for the
   last point of a window 17:00 -> 12:00 is limited to 11:55 with the window message, instead of
   jumping to one step after its previous neighbour.
4. Otherwise `resolveKey(requestedKey)` (section 1.3); the message, by priority:
   1. no room -> "Pas de place entre les points voisins" (point unchanged);
   2. clamped by the window -> "Heure limitée à la fenêtre affichée";
   3. clamped by a neighbour -> "Heure ajustée pour rester entre les points voisins";
   4. snap only (snapped key != `requestedKey`) -> "Heure arrondie à HH:MM" (the final time);
   5. otherwise no message.

   Then `movePoint(index, time, value, true)`.

### 6.3 Value input

On `change`: `parseDecimal(text)` (src/format.ts: surrounding blanks ignored, an optional sign,
digits and a `.` or a French `,` decimal separator); anything else (empty, `1e3`, `abc`) ->
"Valeur invalide", point unchanged; otherwise `clampValue(value, range)` (snapped to the value
step half up, clamped to the range: `19,3` -> 19.5 on a 0.5 grid) and apply with
`{ save: true }`. The field then shows the value the point holds (`19.5`).

### 6.4 Buttons

- "Supprimer": disabled when `points.length <= 2`, with a `title` AND a visible
  `<span class="hint">` ("Une courbe garde au moins 2 points", 12 px, `--secondary-text-color`, on
  its own line, end-aligned) referenced by `aria-describedby="tcc-delete-hint"` **[C7]**. A click
  deletes the selected point (saved), deselects and focuses the SVG.
- "Fermer": deselects and focuses the SVG.

### 6.5 Styles

Flex row that wraps (phone width), gap 8 px 16 px, margin-top 10 px, 13 px
`--secondary-text-color`. Inputs and buttons: min-height 40 px (touch), padding 0 10 px, 1 px
`--divider-color` border, radius 6 px, `--card-background-color` background,
`--primary-text-color` text (inputs 14 px, buttons 13 px weight 500); time input 8em wide, number
input 5em; `.actions` pushed to the end of the row; disabled buttons at opacity 0.5;
`:focus-visible` outline 2 px `--primary-color`, offset 1 px. Native inputs only (no `ha-*`
elements).

## 7. Message line

`<div class="message" role="status" aria-live="polite">`, after the detail row, always in the DOM
**[C8]**: emptied instead of removed, with the class `empty` (no margin, 0 px high) while there is
nothing to show; otherwise 12 px `--primary-text-color`, margin-top 8 px. `showMessage(text)` sets
the text and re-arms a 4 s timer that empties it. The texts are listed in the appendix.

While `saveState === 'error'` and no transient message is shown, the line shows the save error in
full **[R3]** (the chip may cut it): `<span class="error" aria-hidden="true">{saveError}</span>` in
`--error-color`, hidden from assistive technologies, which get it from the chip's alert. A
transient message takes the line for its 4 s, then the error shows again; the next save sent (or a
late echo) clears it. Below the chart and the detail row, a line that appears never moves what the
user is touching.

## 8. Selection rendering [B8]

- The selected point's `g.point` AND its `circle.dot` carry the class `selected`; the dragged point
  (past the slop) also carries `dragging` on both.
- Marker radius: 5 idle, 7 selected, 8 dragging; `.point.selected .dot` gets `stroke-width: 3` (a
  thicker `--tcc-surface` ring). Same curve colour in every state (no extra hue for a state).
- Cursors: crosshair on the SVG, `grab` on a point, `grabbing` while dragging.
- The marker clip is padded by 10 px (`CLIP_PAD`, **[B6]**) so a selected or dragged marker on the
  plot edge is not shaved, and the SVG has `overflow: visible` (**[B5]**) so the hit targets of
  points on the top / right plot edge are whole (docs/card-rendering-spec.md, section 2.4).
- `aria-label` and `aria-pressed` follow the point (re-rendered with it).

## 9. Accessibility

- SVG: `role="group"`, `aria-label="Courbe : {label}"` (U+00A0 before `:`; "Courbe : Luminosité"
  for brightness, "Courbe" alone for an empty label), `tabindex="0"`. M5: while the curve is valid
  and now lies outside the window (where the chart only shows the edge marker), the label reads
  "Courbe : {label}, maintenant HH:MM, hors de la plage affichée" (docs/card-rendering-spec.md,
  section 2.4); it follows the minute clock like the marker.
- Point groups **[C6]**: `tabindex="0"`, `role="button"`,
  `aria-roledescription="point de la courbe"`, `aria-pressed="true|false"` (selected),
  `aria-label="Point HH:MM, <value>"` (the formatted value: `60 %`, `19,5 °C`, U+202F before the
  unit): toggle buttons with a French role description.
- Focus modality and focus rings: section 3.2 **[C4]**; focus moves after Delete, Escape,
  "Fermer" and "Supprimer": section 3.1 **[C5]**.
- Detail row: native labelled inputs; a disabled "Supprimer" is described by the visible hint
  **[C7]**.
- Live regions: the save chip (polite status; the error text is also `role="alert"`) and the
  message line (polite status), both persistent elements **[C8]**; the message line's copy of the
  save error is `aria-hidden` (announced once, by the chip) **[R3]**.
- Touch: 44 px hit targets that stay whole on the plot edges **[B5]**, 40 px row controls,
  `touch-action: none` on the SVG so a drag never scrolls the dashboard.
- French typography **[C9]**: U+202F before the unit (`%`, `°C`, `K`) and the decimal comma in
  every displayed value; U+00A0 before `:` in "Erreur d'enregistrement :
  …" and in the `setConfig` errors that contain " : " ("window_start invalide : attendu HH:MM",
  "window_end invalide : attendu HH:MM", and the `makeWindow` messages, which the card rewrites
  since the pure helpers keep a plain space).

## 10. Dev harness hooks (dev/main.ts, dev/index.html, dev/mock-hass.ts)

- `window.__tcc = { mock, card }` (typed with a `declare global` on `Window`): the hook read by
  the e2e tool, also handy from the console.
- `MockHass` public mutable fields, read AFTER the latency so flipping them affects a call in
  flight: `latency` (ms, 0 = next microtask), `failServices` (the call rejects with
  `Error('mock: service call failed')` after the latency, nothing echoed), `echo` (false: a
  successful `input_text.set_value` resolves WITHOUT updating the state, like HA with a value
  longer than the helper's `max`; exercises the 5 s echo timeout); `calls` records every call.
- Toolbar checkboxes: "Échec des enregistrements" (`failServices`), "Latence 1,5 s" (toggles
  between the fast latency, the URL value when below 1500 ms else 250 ms, and the slow one,
  `max(1500, URL value)`) and "Sans écho (délai 5 s)" (`echo = false`). The "Simuler changement
  externe" button writes the text field into the curve entity (an external update).
- URL params (in addition to the M2 ones): `fail=1`, `latency=<ms>` (0..60000, default 250),
  `noecho=1`.
- The log shows every `callService` with its outcome (" → rejet simulé", " → sans écho") and
  every state change of the curve entity.

## 11. E2E touch tool (scripts/e2e-touch.mjs)

Real Chromium (`$BCC_BROWSER`, else Edge, else Chrome) with touch emulation, driven over the
Chrome DevTools Protocol with the global `WebSocket` of Node >= 22 (no Puppeteer).

```sh
node scripts/e2e-touch.mjs --port 5301 --cdp-port 9301 --out shots/e2e
node scripts/e2e-touch.mjs --only drag,fail   # a subset (ids from --list)
node scripts/e2e-touch.mjs --all              # also the slow optional scenarios
```

- Starts Vite on `--port` (127.0.0.1, `--strictPort`: it fails rather than taking another port),
  launches the browser headless with `--remote-debugging-port=<--cdp-port>` and a temporary
  profile, then `Emulation.setDeviceMetricsOverride` (360 x 740, deviceScaleFactor 2, mobile) and
  `Emulation.setTouchEmulationEnabled` (maxTouchPoints 1). A warm-up load lets Vite transform the
  modules before any timing.
- Each scenario loads the harness (`?now=21:30&latency=300` plus its own knobs), waits for
  `window.__tcc`, reads the marker positions (bounding rects of `g.point .dot` in the shadow root),
  touches with `Input.dispatchTouchEvent` (touchStart, several touchMove, touchEnd) and reads
  `__tcc.mock.calls` / the entity state. Page exceptions and console errors are reported per
  scenario. The scenarios drive the default brightness preset; the tool's own curve parser (for
  its assertions) follows the v2 token grammar (`-?[0-9]{1,4}(\.[0-9]{1,2})?`) and clamps to
  1..100.
- Output: `PASS` / `FAIL` per scenario with notes, then a summary. Exit code 0, 1 when a scenario
  failed, 2 when the tooling failed (no browser, Vite down...). Edge and Vite are always killed
  (SIGINT included) and the temporary profile removed; only the two given ports are used.
- Screenshots go to `--out` (default `shots/e2e`, git-ignored with `shots/`).

| Id          | Scenario                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`     | Tooling: the viewport and touch emulation apply, a tap reaches the page as a `pointerdown` of type touch, a swipe OUTSIDE the chart scrolls the page (so `noscroll` is not vacuous).                                                                                                                     |
| `drag`      | (a) Touch-drag point 1 by (+60, +40) px; mid-drag screenshot with the tooltip; after 1 s exactly one `input_text.set_value` whose value has the same point count, point 1 moved, differs from the initial string and was echoed.                                                                         |
| `add`       | (b) A tap on an empty spot of the plot adds one `g.point` and saves exactly one curve with one more point.                                                                                                                                                                                               |
| `select`    | (c) A tap on point 1 shows the detail row with its time and value, sets `[pointer-focus]` without painting a focus ring (C4), moves nothing, saves nothing.                                                                                                                                              |
| `noscroll`  | (d) On a scrollable page, a vertical drag on a point and a vertical swipe on the background leave `scrollY === 0` and the harness `main` in place.                                                                                                                                                       |
| `fail`      | (e) `fail=1`: after a drag the `.save` chip contains "Erreur", the state is unchanged and the markers are back in place.                                                                                                                                                                                 |
| `noecho`    | (f, optional, `--all`) `noecho=1`: the save times out after 5 s, error chip and revert.                                                                                                                                                                                                                  |
| `hitzone`   | (g) Touches 15 px off a marker centre select that point (no add, no save); a drag started 15 px off drags it (the time shift of that vertical drag is reported: 0 with the grab offset, R1).                                                                                                             |
| `slop`      | (h) 8 px touch slop (B3): 2, 5 and 7 px finger rolls on point 1 stay taps (point selected, detail row shown, no move, no save); a 12 px move drags it and saves once. The 8 px roll (the slop reached: a drag, section 2.3) is only reported.                                                            |
| `focusring` | (n) A touch tap on point 1 focuses it and sets `[pointer-focus]` without painting the dashed focus ring (C4); a key press (Shift) removes `[pointer-focus]` and shows the ring (so the check is not vacuous); a touch tap on point 2 hides it again; nothing is saved. Zoomed screenshots of each state. |
| `edges`     | (i) Curve `17:00@100;21:00@70;08:00@10`: touches 15 px outward of the 100 % marker (above) and of the window-end marker (right) still select them (B5); the reach above the top marker is reported.                                                                                                      |
| `tooltip`   | (j) Dragging the 100 % point puts the tooltip below the marker, inside the SVG (B7).                                                                                                                                                                                                                     |
| `dragfar`   | (k) A drag that leaves the chart (below, to the left) clamps the point to 1 % and one step after point 0, does not scroll, saves once.                                                                                                                                                                   |
| `longpress` | (l) A 900 ms hold before dragging is not cancelled by the long-press gesture; one save.                                                                                                                                                                                                                  |
| `detail`    | (m) By touch: "Supprimer" deletes and saves once; a value typed in the number input (55) commits to point 1 when "Fermer" is tapped; "Fermer" closes the row.                                                                                                                                            |

## 12. Tests (Vitest + happy-dom)

- `test/card.interactions.test.ts`: mounts the card on a `MockHass` wired like the harness (every
  state change reaches `el.hass`), stubs `svg.getBoundingClientRect` to the viewBox at the origin
  (1 client px = 1 SVG unit, positions computed with the geometry helpers), dispatches
  `PointerEvent`s (`pointerdown` on the `circle.hit`, `pointermove` / `pointerup` /
  `pointercancel` / `lostpointercapture` on the SVG, `bubbles` + `composed`) and uses fake timers
  for the 400 ms debounce, the 2 s chip, the 4 s message and the 5 s echo timeout. Coverage:
  - drag: time snapped to 5 min and value rounded, value clamped, neighbour clamping (one step
    away), window clamping, no room (time kept, value applied), the 12:00 window end, tooltip and
    enlarged marker, other pointers ignored, save after a `pointercancel`;
  - tap: selects without moving, a second tap keeps the selection, a small wobble is a tap;
  - persistence: debounce (two drags within 400 ms -> one call), the payload
    `{ entity_id, value }`, "Enregistrement…" -> "Enregistré" on the echo -> nothing, nothing
    written when the edits end where HA is, rejection -> error + revert, echo timeout -> error +
    revert, edits made while a save is in flight are kept;
  - external updates ignored while dirty and adopted when clean; the selection clamped / dropped;
  - add a point (snapped, selected, saved), the `max_points` and "too close" messages, taps outside
    the plot and swipes ignored;
  - detail row (time change with its message, number change with clamping and "Valeur invalide",
    "Supprimer" disabled at 2 points, delete, "Fermer"); keyboard (arrows with / without Shift,
    Delete / Backspace, Escape); the reset button; the length guard (through the private
    `applyPoints`: 26 points cannot come from the UI); lifecycle (removal and hidden page flush a
    scheduled save, no timer left, timers re-armed on re-add);
  - one regression test (or more) per fix-plan item, in the `fix plan A` / `B` / `C` blocks: A1 to
    A9, B1 to B8, C1 to C9 as described in the sections above;
  - one regression test (or more) per repair item, in the `M3 repair` block: R1 to R8 as described
    above, and **[R9]** a guard that the TS files written or extended in M3 (`src/card.ts`,
    `dev/main.ts`, `dev/mock-hass.ts`, `test/card.interactions.test.ts` and
    `test/card.interactions.independent.test.ts`) are ASCII-only (non-ASCII written as `\u`
    escapes; the raw characters of the M0-M2 files are out of its scope). French texts inside the
    static part of an `html` template are bound as expressions of escaped JS constants
    (`RESET_LABEL`, `MIDDOT`, the config's label and unit): Prettier formats those templates
    as HTML and would turn their escapes back into raw characters.
- `test/card.presets.test.ts` (generalization): the config rules of the value keys and the
  per-range `max_points` bound; the temperature, colour temperature and custom (negative, no unit)
  ranges: axis labels and margin, formatted values (status row, now label, sensor chip, aria-labels,
  tooltip), drags snapped to 0.5 / 50 K / 0.25, keyboard steps from an off-grid value, the detail
  row attributes and a typed French comma, the exact numeric sensor comparison (`18.50` equals
  18.5), the reset curve per preset and from `default_curve`, a new config re-parsing the stored
  curve; the pure helpers of src/format.ts and the chip helpers (`sensorCenti`,
  `targetEntityText`); an ASCII-only guard for `src/format.ts`, `src/card.ts` and itself.
- `test/card.interactions.independent.test.ts`: written from the working spec only and kept as an
  independent check; an assertion may be adjusted only where this document (a fix-plan item)
  explicitly overrides the working spec, and "does not blame the neighbours for a snap-only
  adjustment" must pass with the C3 messages. It also covers the length guard on a stored
  255-character curve. Adjusted by the repair **[R4]**: "sends the newest value when the curve
  changes while a save is in flight" now expects the second call after the first echo (t = 1400),
  not at t = 800.
- `test/card.test.ts`: the M2 rendering (docs/card-rendering-spec.md, section 6), including the
  "Entité introuvable" block of a missing entity (A8) and the sensor chip rules of the generic
  sensor contract (`mode` / `reason`, docs/card-rendering-spec.md, sections 2.2 and 2.4). Since the
  genericization it is ASCII-only too (its own check, which also covers `src/types.ts`).
- A change is done when `npm run typecheck`, `npm run lint`, `npm test`, `npm run format:check`
  and `npm run build` pass (and `npm run test:jinja` for the HA package).

## Appendix: UI strings (French)

| Where                 | Text                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save chip             | "Enregistrement…", "Enregistré", "Erreur d'enregistrement : {message}" (U+00A0 before `:`)                                                                                        |
| Save chip (timeout)   | "Valeur refusée par Home Assistant (vérifiez max: 255 sur l'input_text)"                                                                                                          |
| Invalid block         | "Courbe invalide ou vide.", "Entité indisponible", "Entité introuvable", button "Réinitialiser la courbe"                                                                         |
| Detail row            | "Heure", the config's label ("Luminosité") and unit ("%"), "Supprimer", "Fermer", hint "Une courbe garde au moins 2 points"                                                       |
| Messages (add)        | "Nombre maximal de points atteint (N)", "En dehors de la fenêtre affichée", "Trop proche d'un point existant"                                                                     |
| Messages (time input) | "Heure invalide", "Pas de place entre les points voisins", "Heure limitée à la fenêtre affichée", "Heure ajustée pour rester entre les points voisins", "Heure arrondie à HH:MM"  |
| Messages (value)      | "Valeur invalide"                                                                                                                                                                 |
| Messages (any edit)   | "Courbe trop longue pour input_text (N > 255 caractères)"                                                                                                                         |
| Tooltip               | "HH:MM · {value}" (`60 %`, `19,5 °C`: decimal comma, U+202F before the unit)                                                                                                      |
| Sensor chip           | "Capteur {value}" / "Capteur indisponible", then " · " + "≠ courbe" (no `mode`, values differ), the sensor's `reason` (an override, at most 60 characters) or "Règle prioritaire" |
| ARIA (chart)          | SVG "Courbe : {label}"; M5, now outside the window: "Courbe : {label}, maintenant HH:MM, hors de la plage affichée"                                                               |
| ARIA (point)          | "Point HH:MM, {value}", role description "point de la courbe"                                                                                                                     |
