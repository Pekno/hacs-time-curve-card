"""Jinja harness for the Home Assistant template sensors that go with time-curve-card.

The card and the sensor must compute exactly the same value for the same curve string and time
(CLAUDE.md "Architecture"); the rules are in docs/curve-spec.md. This harness renders the sensor
templates of every package that has a test DESCRIPTOR, with jinja2 in an environment that mirrors
Home Assistant's, against the shared fixture ``test/fixtures/curve-cases.json`` (also run by
``test/curve.test.ts``) and against the rule scenarios of the descriptor.

Run with ``npm run test:jinja`` (``uv run pytest test/jinja``).

Packages and descriptors
------------------------

A descriptor is a JSON file ``<name>.test.json`` next to its package. Collected:

- every ``ha/*.test.json`` (the generic examples: brightness ``ha/example-package.test.json``,
  heating ``ha/example-heating-package.test.json``, colour temperature
  ``ha/example-color-temp-package.test.json``);
- every ``private/**/*.test.json`` when that gitignored folder exists (a maintainer's own
  package), unless the environment variable ``BCC_SKIP_PRIVATE`` is true (``1``, ``true``,
  ``yes``): ``BCC_SKIP_PRIVATE=1 npm run test:jinja`` runs exactly what a fresh clone runs.

Descriptor format (unknown keys are errors, so a typo cannot silently disable a check)::

    {
      "package": "example-package.yaml",            # the package, relative to the descriptor
      "curve_entity": "input_text.brightness_curve",
      "sensor_unique_id": "brightness_curve_target",
      "range": [100, 10000],                        # vmin, vmax of the package (centi-units)
      "step": 100,                                  # vstep of the package (centi-units)
      "unit": "%",                                  # the sensor's unit_of_measurement
      "neutral_states": {"input_boolean.x": "on"},  # states under which the curve rule applies
      "scenarios": [...],                           # the package's other rules, see below
      "checks": {...}                               # optional package checks, see below
    }

A state value is the entity's state string, or ``null`` for an entity that does not exist.
Values are in hundredths of a unit ("centi-units", docs/curve-spec.md): ``range`` and ``step``
must equal the constants ``vmin`` / ``vmax`` / ``vstep`` set at the top of the package's parse
block (checked), and select the fixture cases the package runs: a case runs against a package
only when its ``range`` / ``step`` (default ``[100, 10000]`` / ``100``, brightness) equal the
package's; every package needs at least ``MIN_CASES_PER_PACKAGE`` of them.

The CURVE RULE is implicit: under the neutral states, every selected fixture case must give the
case's ``expected`` value (a formatted string such as ``"19.5"``) with the attributes
``mode: curve`` and ``reason: null``, or, when ``expected`` is ``null`` (invalid curve), an
unavailable sensor.

A SCENARIO is ``{"name", "states", "matrix"?, "time"?, "available", "state", "mode",
"reason"}``. ``states`` is laid over the neutral states; ``matrix`` (``entity_id -> [values]``)
expands the scenario into the cartesian product of its values. When the scenario sets the curve
entity (in ``states`` or ``matrix``) it runs once, at ``time`` (required), and ``state`` is a
value (an integer, or a string in the canonical value format such as ``"18.5"``) or ``null``.
Otherwise it runs for every selected fixture case (the case's curve and time; no ``time`` key)
and ``state`` may also be ``"curve"`` (the case's ``expected``) or ``"max"`` (the case's
``max``); the sensor is then expected unavailable when that value is ``null``. With
``"available": false``, ``state``, ``mode`` and ``reason`` must be ``null``: HA publishes neither
the state nor the attributes of an unavailable entity. ``mode`` and ``reason`` are compared with
the PUBLISHED attribute values (HA parses the rendered text: ``{{ none }}`` publishes ``null``).

``checks`` (all optional):

- ``curve_helper``: expected fields of the curve ``input_text`` (always checked: ``max: 255``, no
  ``initial:``, ``mode: text`` when given);
- ``sensor``: expected fields of the sensor config (always checked: ``unit_of_measurement``
  equal to the descriptor's ``unit``, and no ``device_class``: HA converts the state of some
  device classes, e.g. a ``temperature`` sensor to Fahrenheit, which the card would compare with
  the curve drawn in the configured unit);
- ``forbidden_sensor_keys``: sensor fields that must be absent;
- ``removed``: entity ids that must be neither declared nor referenced by the sensor templates;
- ``kept_blocks_from``: a reference package (relative to the descriptor), with ``kept_blocks``
  (entity ids whose declaration, or top-level keys such as ``automation``, must be identical to
  the reference's) and ``kept_sensor_keys`` (sensor fields that must equal those of the
  reference's sensor with the same ``unique_id``).

Sensor contract (the card side is docs/card-rendering-spec.md): the sensor has the templates
``availability``, ``state`` and the attributes ``mode`` (``curve`` when the value follows the
curve, anything else, conventionally ``override``, when a higher-priority rule of the package
decides it) and ``reason`` (free text the card shows as plain text, whitespace collapsed, for
an override; ``null`` in mode ``curve``). The parse block between ``{# --- parse: begin --- #}``
and ``{# --- parse: end --- #}`` is textually identical in ``availability`` and ``state``, and
sets the range constants ``vmin``, ``vmax`` and ``vstep`` (centi-units). The state is the value
formatted from its hundredths (``19.5``, ``70``, ``-2.05``).

What each helper mirrors (home-assistant/core, ``dev`` branch, read on 2026-09-27; the former
``homeassistant/helpers/template.py`` is now the package ``homeassistant/helpers/template/``):

- ``TemplateEnvironment`` mirrors ``TemplateEnvironment`` in ``template/__init__.py``: an
  ``ImmutableSandboxedEnvironment`` with the ``jinja2.ext.loopcontrols`` and ``jinja2.ext.do``
  extensions, the non-strict ``make_logging_undefined`` undefined class, and the
  ``is_safe_callable`` (``AllStates`` is callable) / ``is_safe_attribute`` (``Namespace`` and
  loop contexts) overrides. ``list.append``, ``dict.update``, ... raise ``SecurityError``.
- ``forgiving_int`` mirrors ``TypeCastExtension.forgiving_int`` (``template/extensions/
  type_cast.py``): ``jinja2.filters.do_int(value, default=_SENTINEL, base=base)``, then
  ``raise_no_default`` when the sentinel comes back. It is FORGIVING like HA's: ``'70.5'`` -> 70,
  ``' 70'`` -> 70, ``'+70'`` -> 70, ``'1_0'`` -> 10, full-width ``'\\uff11\\uff10'`` -> 10.
  Registered as a filter and a global, like HA.
- ``forgiving_float`` mirrors ``TypeCastExtension.forgiving_float``: ``float(value)``, else the
  default, else ``raise_no_default``. Filter and global.
- ``forgiving_round`` mirrors ``MathExtension.forgiving_round`` (``template/extensions/math.py``):
  methods ``common`` (Python ``round``, i.e. banker's rounding at .5), ``ceil``, ``floor``,
  ``half``; returns an ``int`` when ``precision == 0``. Filter only.
- ``forgiving_boolean`` / ``result_as_boolean`` mirror ``template/helpers.py`` on top of
  ``cv_boolean`` (``config_validation.boolean``). ``is_number`` mirrors
  ``TypeCastExtension.is_number``. ``min`` / ``max`` globals mirror
  ``MathExtension.min_max_from_filter`` (the ``min`` / ``max`` filters stay Jinja's).
- ``raise_no_default`` mirrors ``template/helpers.py`` (``ValueError`` with HA's message).
- ``AllStates.__call__`` (``states()``) mirrors ``AllStates.__call__`` in ``template/states.py``:
  ``'unknown'`` for a missing entity, else the state string.
- ``is_state`` / ``has_value`` mirror ``StateExtension.is_state`` / ``StateExtension.has_value``
  (``template/extensions/state.py``): a missing entity is not in any state and has no value;
  ``has_value`` is false for ``unknown`` / ``unavailable``; ``is_state`` accepts a list.
- ``now()`` mirrors ``DateTimeExtension.now`` (``template/extensions/datetime.py``):
  ``dt_util.now()``, a timezone-aware datetime in HA's configured timezone. Here it is a fixed
  datetime (the fixture ``HH:MM`` with 59 seconds, so a template that uses seconds is caught).
- Hass-dependent functions are wrapped with ``_pass_context`` like ``_pass_context`` in
  ``template/extensions/base.py`` (never evaluated at compile time).
- ``render`` mirrors ``Template.async_render``: the output is stripped; any exception becomes a
  ``TemplateError``. ``parse_result`` mirrors ``_parse_result`` / ``_cached_parse_result``
  (``literal_eval``, ``_IS_NUMERIC``). Availability mirrors ``TemplateEntity._update_available``
  (``homeassistant/components/template/template_entity.py``): ``result_as_boolean`` of the parsed
  result. NOTE: in HA a RAISING availability template makes the entity AVAILABLE, which is one
  more reason every template here must render without raising. An attribute template publishes
  its parsed result (``TemplateEntity._add_attribute_template``): ``curve`` stays a string,
  ``None`` becomes ``null``.
- ``evaluate`` mirrors the availability GATING. ``availability`` is a "super template": the
  template entity inserts it first and calls ``async_track_template_result(...,
  has_super_template=True)``; ``TrackTemplateResultInfo.async_setup`` / ``_refresh``
  (``homeassistant/helpers/event.py``) render it first and, when its result is not
  ``_super_template_as_boolean`` (a ``TemplateError`` counts as true), skip EVERY other template
  (``state`` and the attributes). And ``Entity.__async_calculate_state``
  (``homeassistant/helpers/entity.py``) publishes ``extra_state_attributes`` only while the
  entity is available. So while unavailable HA never renders the state template (its ``none``
  branch is a guard, dead code in HA) and the sensor has NO ``mode`` / ``reason`` attribute: e.g.
  an override rule whose level has no value shows as plain unavailable, without its reason.
  ``Outcome.state`` / ``mode`` / ``reason`` are ``None`` then. The never-raise guard (test 5)
  still renders every template unconditionally, since a package must stay total.

Simplifications (documented so nobody mistakes them for HA behaviour):

- No ``hass`` object: the state machine is a dict ``entity_id -> state string``; no attributes,
  no ``last_changed``, no case-insensitive lookup, no ``states.<domain>.<object_id>`` attribute
  access (it renders as undefined and fails the test), no ``states(..., rounded=...)``.
- Only the functions listed above are mirrored; any other HA function (``iif``, ``state_attr``,
  ``today_at``, ...) is undefined here and fails the render with a hint. Jinja's own globals,
  filters and tests (``namespace``, ``dict``, ``range``, ``dictsort``, ``map``, ``length``,
  ``is number``, ...) are the real ones, from the jinja2 version pinned in pyproject.toml.
- Versions: jinja2 and PyYAML are pinned to the exact versions HA ships
  (``homeassistant/package_constraints.txt``: ``Jinja2==3.1.6``, ``PyYAML==6.0.3``); bump them
  together with HA. The interpreter is NOT HA's: the harness runs on Python 3.12
  (``.python-version``) while HA core requires >= 3.14.2. Nothing the template uses depends on
  the version (int / float / true division, ``%`` sign rule, ``str.split`` / ``strip``,
  ``round``, ``math.floor``, dict insertion order); the one version-dependent piece, the Unicode
  tables behind ``int()`` of non-ASCII digits, is neutralised by the ASCII ``'0123456789'``
  whitelist the template applies before ``| int``. A replay of the fixture in real HA 2026.9
  (Python 3.14) matched this harness exactly for the v1 format (the v2 templates add only
  integer ``+ - * // %``, string slicing and concatenation); to run the suite on Python 3.14:
  ``UV_PROJECT_ENVIRONMENT=<some dir> uv run --frozen --python 3.14 pytest test/jinja``.
- STRICTER than HA on purpose: using an undefined variable fails the test (HA would render an
  empty string and log ``Template variable warning`` every minute). No ``finalize`` (HA's
  ``_finalize_output`` only rewrites enum members inside containers, and every output here is
  a plain int / bool / str), no render-info / rate limiting. HA's 256 KiB output limit is
  enforced.
- HA strips the template SOURCE (``Template.__init__``: ``template.strip()``); the harness does
  not, but both strip the OUTPUT, which is all that differs.
- HA's ``is_safe_callable`` also allows ``StateTranslated`` / ``StateAttrTranslated`` and its
  ``is_safe_attribute`` also covers ``DomainStates`` / ``TemplateStateBase``; the templates use
  none of them (no ``state_translated``, no ``states.<domain>``).
- ``now()`` here is a fixed-offset ``CEST`` datetime at HH:MM:59.999; HA's ``dt_util.now()`` is
  ``ZoneInfo``-aware and the template re-renders at second 0 of each minute (plus a random
  sub-second offset; ``async_track_utc_time_change(..., second=0)`` in event.py). ``hour`` and
  ``minute`` are the same on both sides, and DST is wall-clock time on both sides.

Tests, for every collected descriptor: 0 the fixture and the descriptors are usable (every
entity id a descriptor names is read by the sensor, and enough fixture cases match its range);
1 the curve rule for every selected fixture case; 2 every rule scenario; 3 the parse block is
identical in ``availability`` and ``state`` and its range constants match the descriptor; 4 the
package declarations (curve ``input_text``, sensor) and the optional ``checks``; 5 no template
ever raises, and whenever availability is true the state is a canonical value inside the range
and ``mode`` / ``reason`` one of the pairs the descriptor expects; 6 ``now()`` is called at most
once per render.
"""

from __future__ import annotations

import ast
import contextvars
import difflib
import itertools
import json
import logging
import math
import os
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import wraps
from numbers import Number
from pathlib import Path
from typing import Any, NoReturn

import jinja2
import jinja2.filters
import pytest
import yaml
from jinja2 import pass_context, pass_environment
from jinja2.runtime import AsyncLoopContext, LoopContext
from jinja2.sandbox import ImmutableSandboxedEnvironment
from jinja2.utils import Namespace

# --------------------------------------------------------------------------------------------
# Paths and conventions
# --------------------------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = ROOT / "test" / "fixtures" / "curve-cases.json"
PUBLIC_DESCRIPTOR_DIR = ROOT / "ha"
PRIVATE_DIR = ROOT / "private"
DESCRIPTOR_SUFFIX = ".test.json"
SKIP_PRIVATE_ENV_VAR = "BCC_SKIP_PRIVATE"

PARSE_BEGIN = "{# --- parse: begin --- #}"
PARSE_END = "{# --- parse: end --- #}"

#: ``mode`` attribute of the curve rule; any other value is an override (sensor contract).
MODE_CURVE = "curve"

#: Fixture defaults (brightness 1..100 %, step 1), in centi-units (docs/curve-spec.md).
DEFAULT_RANGE = (100, 10000)
DEFAULT_STEP = 100
#: Largest magnitude of the value grammar (9999.99), in centi-units.
MAX_ABS_CENTI = 999999
#: Fewest fixture cases a package must run (its range and step must be well covered).
MIN_CASES_PER_PACKAGE = 10

#: HA's configured timezone for ``now()`` (a fixed UTC+2 offset, no tzdata needed).
HA_TZ = timezone(timedelta(hours=2), "CEST")

# --------------------------------------------------------------------------------------------
# Mirror of Home Assistant's template helpers (see the module docstring for the sources)
# --------------------------------------------------------------------------------------------

_SENTINEL = object()
STATE_UNKNOWN = "unknown"
STATE_UNAVAILABLE = "unavailable"
MAX_TEMPLATE_OUTPUT = 256 * 1024
_IS_NUMERIC = re.compile(r"^[+-]?(?!0\d)\d*(?:\.\d*)?$")

#: (template label, action) of the render in progress, like HA's ``template_cv``.
template_cv: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "template_cv", default=None
)


class TemplateError(Exception):
    """Mirror of ``homeassistant.exceptions.TemplateError``: any error raised while rendering."""


class InvalidBoolean(ValueError):
    """Mirror of ``probatio.Invalid`` raised by ``config_validation.boolean``."""


def raise_no_default(function: str, value: Any) -> NoReturn:
    """Mirror of ``raise_no_default`` (template/helpers.py)."""
    template, action = template_cv.get() or ("", "rendering or compiling")
    raise ValueError(
        f"Template error: {function} got invalid input '{value}' when {action} template"
        f" '{template}' but no default was specified"
    )


def forgiving_int(value: Any, default: Any = _SENTINEL, base: int = 10) -> Any:
    """Mirror of ``TypeCastExtension.forgiving_int`` (the ``int`` filter and global)."""
    result = jinja2.filters.do_int(value, default=default, base=base)
    if result is _SENTINEL:
        raise_no_default("int", value)
    return result


def forgiving_float(value: Any, default: Any = _SENTINEL) -> Any:
    """Mirror of ``TypeCastExtension.forgiving_float`` (the ``float`` filter and global)."""
    try:
        return float(value)
    except (ValueError, TypeError):
        if default is _SENTINEL:
            raise_no_default("float", value)
        return default


def forgiving_round(
    value: Any, precision: int = 0, method: str = "common", default: Any = _SENTINEL
) -> Any:
    """Mirror of ``MathExtension.forgiving_round`` (the ``round`` filter)."""
    try:
        # support rounding methods like jinja
        multiplier = float(10**precision)
        if method == "ceil":
            value = math.ceil(float(value) * multiplier) / multiplier
        elif method == "floor":
            value = math.floor(float(value) * multiplier) / multiplier
        elif method == "half":
            value = round(float(value) * 2) / 2
        else:
            # if method is common or something else, use common rounding
            value = round(float(value), precision)
        return int(value) if precision == 0 else value
    except (ValueError, TypeError):
        if default is _SENTINEL:
            raise_no_default("round", value)
        return default


def cv_boolean(value: Any) -> bool:
    """Mirror of ``homeassistant.helpers.config_validation.boolean``."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        value = value.lower().strip()
        if value in ("1", "true", "yes", "on", "enable"):
            return True
        if value in ("0", "false", "no", "off", "disable"):
            return False
    elif isinstance(value, Number):
        return value != 0
    raise InvalidBoolean(f"invalid boolean value {value}")


def forgiving_boolean(value: Any, default: Any = _SENTINEL) -> Any:
    """Mirror of ``forgiving_boolean`` (template/helpers.py; the ``bool`` filter and global)."""
    try:
        return cv_boolean(value)
    except InvalidBoolean:
        if default is _SENTINEL:
            raise_no_default("bool", value)
        return default


def result_as_boolean(template_result: Any) -> bool:
    """Mirror of ``result_as_boolean`` (template/helpers.py), used for ``availability``."""
    if template_result is None:
        return False
    return forgiving_boolean(template_result, default=False)


def is_number(value: Any) -> bool:
    """Mirror of ``TypeCastExtension.is_number`` (filter, test and global)."""
    try:
        fvalue = float(value)
    except (ValueError, TypeError):
        return False
    return math.isfinite(fvalue)


def parse_result(render_result: str) -> Any:
    """Mirror of ``_parse_result`` / ``_cached_parse_result`` (template/__init__.py), minus the
    ``RESULT_WRAPPERS`` (lists / dicts keep their plain type here)."""
    if _IS_NUMERIC.match(render_result):
        try:
            return float(render_result) if "." in render_result else int(render_result)
        except ValueError:
            pass
    try:
        result = ast.literal_eval(render_result)
    except (ValueError, TypeError, SyntaxError, MemoryError):
        return render_result
    if not isinstance(result, (str, complex)) and (
        not isinstance(result, (int, float))
        or isinstance(result, bool)
        or _IS_NUMERIC.match(render_result) is not None
    ):
        return result
    return render_result


def _min_max_from_filter(builtin_filter: Any, name: str) -> Any:
    """Mirror of ``MathExtension.min_max_from_filter``: the ``min`` / ``max`` globals."""

    @pass_environment
    @wraps(builtin_filter)
    def wrapper(environment: jinja2.Environment, *args: Any, **kwargs: Any) -> Any:
        if len(args) == 0:
            raise TypeError(f"{name} expected at least 1 argument, got 0")
        if len(args) == 1:
            if isinstance(args[0], Iterable):
                return builtin_filter(environment, args[0], **kwargs)
            raise TypeError(f"'{type(args[0]).__name__}' object is not iterable")
        return builtin_filter(environment, args, **kwargs)

    return wrapper


def _pass_context(func: Callable[..., Any]) -> Callable[..., Any]:
    """Mirror of ``_pass_context`` (template/extensions/base.py): evaluated at render time only."""

    @wraps(func)
    def wrapper(_: Any, *args: Any, **kwargs: Any) -> Any:
        return func(*args, **kwargs)

    return pass_context(wrapper)


@dataclass
class HassMock:
    """The slice of Home Assistant the sensor templates see: entity states and ``now()``.

    ``entities`` maps an entity id to its state string; an absent key is an entity that does not
    exist. ``watched`` lists the entity ids ``describe`` shows even when they do not exist.
    ``now_calls`` and ``undefined_messages`` are filled by the last render.
    """

    entities: dict[str, str]
    now: datetime
    watched: tuple[str, ...] = ()
    now_calls: int = 0
    undefined_messages: list[str] = field(default_factory=list)

    def get_state(self, entity_id: str) -> str | None:
        return self.entities.get(entity_id)

    def describe(self) -> str:
        def show(entity_id: str) -> str:
            state = self.entities.get(entity_id)
            return "<missing entity>" if state is None else repr(state)

        ids = sorted({*self.watched, *self.entities})
        return f"now={self.now:%H:%M:%S} " + " ".join(f"{i}={show(i)}" for i in ids)


class AllStates:
    """Mirror of ``AllStates`` (template/states.py), call form only: ``states('domain.id')``."""

    def __init__(self, environment: TemplateEnvironment) -> None:
        self._environment = environment

    def __call__(self, entity_id: str, rounded: Any = _SENTINEL, with_unit: bool = False) -> str:
        state = self._environment.current_hass().get_state(entity_id)
        if state is None:
            return STATE_UNKNOWN
        if rounded is _SENTINEL:
            rounded = with_unit
        if rounded or with_unit:
            raise NotImplementedError("states(..., rounded/with_unit) is not mirrored here")
        return state

    def __getattr__(self, name: str) -> Any:
        # HA resolves states.<domain>.<object_id> here; the harness does not mirror it, so the
        # attribute is undefined (the render then fails with a hint).
        raise AttributeError(name)

    def __repr__(self) -> str:
        return "<template AllStates (harness mirror)>"


def _make_logging_undefined(log_fn: Callable[[int, str], None]) -> type[jinja2.Undefined]:
    """Mirror of ``make_logging_undefined(strict=False, ...)`` (template/__init__.py)."""

    class LoggingUndefined(jinja2.Undefined):
        def _log_message(self) -> None:
            log_fn(logging.WARNING, self._undefined_message)

        def _fail_with_undefined_error(self, *args: Any, **kwargs: Any) -> NoReturn:
            try:
                super()._fail_with_undefined_error(*args, **kwargs)
            except self._undefined_exception:
                log_fn(logging.ERROR, self._undefined_message)
                raise

        def __str__(self) -> str:
            self._log_message()
            return super().__str__()

        def __iter__(self) -> Any:
            self._log_message()
            return super().__iter__()

        def __bool__(self) -> bool:
            self._log_message()
            return super().__bool__()

    return LoggingUndefined


class TemplateEnvironment(ImmutableSandboxedEnvironment):
    """Mirror of HA's ``TemplateEnvironment`` restricted to what the sensor may use."""

    def __init__(self) -> None:
        super().__init__(undefined=_make_logging_undefined(self._log_undefined))
        self.add_extension("jinja2.ext.loopcontrols")
        self.add_extension("jinja2.ext.do")
        self._hass: HassMock | None = None
        self._compiled: dict[str, jinja2.Template] = {}

        states = AllStates(self)
        self.globals["states"] = states
        self.filters["states"] = _pass_context(states)
        self.globals["is_state"] = self.tests["is_state"] = _pass_context(self._is_state)
        has_value = _pass_context(self._has_value)
        self.globals["has_value"] = self.filters["has_value"] = self.tests["has_value"] = has_value
        self.globals["now"] = _pass_context(self._now)

        self.globals["int"] = self.filters["int"] = forgiving_int
        self.globals["float"] = self.filters["float"] = forgiving_float
        self.globals["bool"] = self.filters["bool"] = forgiving_boolean
        self.globals["is_number"] = self.filters["is_number"] = is_number
        self.tests["is_number"] = is_number
        self.filters["round"] = forgiving_round
        self.globals["min"] = _min_max_from_filter(self.filters["min"], "min")
        self.globals["max"] = _min_max_from_filter(self.filters["max"], "max")

    # -- HA sandbox overrides ------------------------------------------------------------------

    def is_safe_callable(self, obj: Any) -> bool:
        return isinstance(obj, AllStates) or super().is_safe_callable(obj)

    def is_safe_attribute(self, obj: Any, attr: str, value: Any) -> bool:
        if isinstance(obj, (AllStates, LoopContext, AsyncLoopContext)):
            return attr[0] != "_"
        if isinstance(obj, Namespace):
            return True
        return super().is_safe_attribute(obj, attr, value)

    # -- state-machine backed functions --------------------------------------------------------

    def current_hass(self) -> HassMock:
        if self._hass is None:
            raise RuntimeError("no HassMock bound: templates must be rendered through render()")
        return self._hass

    def _is_state(self, entity_id: str, state: str | list[str]) -> bool:
        current = self.current_hass().get_state(entity_id)
        return current is not None and (
            current == state or (isinstance(state, list) and current in state)
        )

    def _has_value(self, entity_id: str) -> bool:
        current = self.current_hass().get_state(entity_id)
        return current is not None and current not in (STATE_UNAVAILABLE, STATE_UNKNOWN)

    def _now(self) -> datetime:
        hass = self.current_hass()
        hass.now_calls += 1
        return hass.now

    def _log_undefined(self, level: int, message: str) -> None:
        if self._hass is not None:
            self._hass.undefined_messages.append(f"{logging.getLevelName(level)}: {message}")

    # -- rendering -----------------------------------------------------------------------------

    def render(self, source: str, hass: HassMock, label: str) -> str:
        """Render ``source`` against ``hass`` like ``Template.async_render`` (stripped output).

        Raises ``TemplateError`` when the template raises, uses an undefined name, or produces
        more than HA's output limit.
        """
        token = template_cv.set((label, "rendering"))
        try:
            template = self._compiled.get(source)
            if template is None:
                self._hass = None  # nothing hass-dependent may be folded at compile time
                template = self._compiled[source] = self.from_string(source)
            hass.now_calls = 0
            hass.undefined_messages.clear()
            self._hass = hass
            try:
                rendered = template.render()
            except jinja2.UndefinedError as err:
                raise TemplateError(
                    f"{label}: {err}. The harness mirrors only states('<entity_id>'), is_state,"
                    " has_value, now, int, float, round, bool, is_number, min/max and Jinja's"
                    " builtins (see the docstring of test/jinja/test_sensor.py)."
                ) from err
            except Exception as err:
                raise TemplateError(f"{label}: {type(err).__name__}: {err}") from err
            finally:
                self._hass = None
        finally:
            template_cv.reset(token)
        if len(rendered) > MAX_TEMPLATE_OUTPUT:
            raise TemplateError(f"{label}: output exceeded {MAX_TEMPLATE_OUTPUT} characters")
        if hass.undefined_messages:
            raise TemplateError(
                f"{label}: the template used undefined names (HA logs a 'Template variable"
                f" warning' on every render): {hass.undefined_messages}"
            )
        return rendered.strip()


ENV = TemplateEnvironment()

# --------------------------------------------------------------------------------------------
# Shared fixture
# --------------------------------------------------------------------------------------------

TIME_RE = re.compile(r"^([01][0-9]|2[0-3]):([0-5][0-9])$")
GUARD_TIMES = ("00:00", "06:00", "12:00", "18:00", "23:59")


def _load_cases() -> list[dict[str, Any]]:
    try:
        data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cases = data["cases"]
    except (OSError, ValueError, KeyError, TypeError) as err:
        raise RuntimeError(f"cannot load the shared fixture {FIXTURE_PATH}: {err!r}") from err
    if not isinstance(cases, list) or not cases:
        raise RuntimeError(f"{FIXTURE_PATH}: 'cases' must be a non-empty list")
    return cases


CASES = _load_cases()
CASE_IDS = [str(case.get("name", f"case-{index}")) for index, case in enumerate(CASES)]

VALUE_RE = re.compile(r"^(-?)([0-9]{1,4})(?:\.([0-9]{1,2}))?\Z")


def parse_value_centi(text: Any) -> int | None:
    """The value grammar of docs/curve-spec.md (``-?[0-9]{1,4}(\\.[0-9]{1,2})?``, ASCII digits)
    -> centi-units, or ``None``. Harness-side checks only (the templates do their own parsing)."""
    if not isinstance(text, str):
        return None
    match = VALUE_RE.match(text)
    if match is None:
        return None
    magnitude = int(match[2]) * 100 + int((match[3] or "").ljust(2, "0"))
    return -magnitude if match[1] == "-" else magnitude


def format_centi(centi: int) -> str:
    """Canonical formatting of centi-units (1950 -> '19.5', -205 -> '-2.05', 0 -> '0')."""
    magnitude = abs(centi)
    text = str(magnitude // 100)
    frac = magnitude % 100
    if frac:
        text += f".{frac // 10}" if frac % 10 == 0 else f".{frac:02d}"
    return f"-{text}" if centi < 0 else text


def is_canonical_value(text: Any) -> bool:
    """A string in the canonical value format (what the sensor state must look like)."""
    centi = parse_value_centi(text)
    return centi is not None and format_centi(centi) == text


def case_range(case: Mapping[str, Any]) -> tuple[tuple[int, int], int]:
    """``((min, max), step)`` of a fixture case, in centi-units (defaults: brightness)."""
    raw = case.get("range", list(DEFAULT_RANGE))
    return (int(raw[0]), int(raw[1])), int(case.get("step", DEFAULT_STEP))


def at(hhmm: str) -> datetime:
    """``now()`` for a fixture time: that wall-clock minute, 59 s past, in HA's timezone."""
    match = TIME_RE.match(hhmm)
    if match is None:
        raise ValueError(f"time must be HH:MM, got {hhmm!r}")
    return datetime(2026, 9, 27, int(match[1]), int(match[2]), 59, 999_000, tzinfo=HA_TZ)


# --------------------------------------------------------------------------------------------
# Descriptors (read at import time: they drive the parametrization)
# --------------------------------------------------------------------------------------------

ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
DESCRIPTOR_KEYS = {
    "$comment",
    "package",
    "curve_entity",
    "sensor_unique_id",
    "range",
    "step",
    "unit",
    "neutral_states",
    "scenarios",
    "checks",
}
SCENARIO_KEYS = {
    "$comment",
    "name",
    "states",
    "matrix",
    "time",
    "available",
    "state",
    "mode",
    "reason",
}
CHECK_KEYS = {
    "curve_helper",
    "sensor",
    "forbidden_sensor_keys",
    "removed",
    "kept_blocks_from",
    "kept_blocks",
    "kept_sensor_keys",
}
STATE_FROM_CASE = ("curve", "max")


class DescriptorError(ValueError):
    """A malformed test descriptor (reported at collection, with the file and the key)."""


@dataclass(frozen=True, eq=False)
class Scenario:
    """One expanded rule scenario. ``time`` is ``None`` for a scenario run on every fixture
    case (the case gives the curve and the time)."""

    name: str
    overlay: Mapping[str, str | None]
    time: str | None
    available: bool
    state: str | int | None
    mode: str | None
    reason: str | None

    @property
    def per_case(self) -> bool:
        return self.time is None


@dataclass(frozen=True, eq=False)
class Descriptor:
    path: Path
    label: str
    package_path: Path
    curve_entity: str
    sensor_unique_id: str
    value_range: tuple[int, int]
    step: int
    unit: str
    neutral_states: Mapping[str, str | None]
    scenarios: tuple[Scenario, ...]
    checks: Mapping[str, Any]

    def resolve(self, relative: str) -> Path:
        return self.path.parent / relative

    def cases(self) -> list[tuple[dict[str, Any], str]]:
        """The fixture cases (with their ids) whose range and step are the package's."""
        return [
            (case, case_id)
            for case, case_id in zip(CASES, CASE_IDS)
            if case_range(case) == (self.value_range, self.step)
        ]


def _skip_private() -> bool:
    return os.environ.get(SKIP_PRIVATE_ENV_VAR, "").strip().lower() in ("1", "true", "yes", "on")


def discover_descriptor_paths() -> list[Path]:
    """``ha/*.test.json``, then ``private/**/*.test.json`` unless ``BCC_SKIP_PRIVATE`` is set."""
    paths = sorted(PUBLIC_DESCRIPTOR_DIR.glob(f"*{DESCRIPTOR_SUFFIX}"))
    if not _skip_private() and PRIVATE_DIR.is_dir():
        paths += sorted(PRIVATE_DIR.rglob(f"*{DESCRIPTOR_SUFFIX}"))
    return paths


def _require(condition: bool, where: str, message: str) -> None:
    if not condition:
        raise DescriptorError(f"{where}: {message}")


def _unknown_keys(data: Mapping[str, Any], allowed: set[str], where: str) -> None:
    unknown = sorted(set(data) - allowed)
    _require(not unknown, where, f"unknown key(s) {unknown} (allowed: {sorted(allowed)})")


def _entity_id(value: Any, where: str) -> str:
    _require(
        isinstance(value, str) and ENTITY_ID_RE.match(value) is not None,
        where,
        f"expected an entity id 'domain.object_id', got {value!r}",
    )
    return value


def _state_map(value: Any, where: str) -> dict[str, str | None]:
    _require(isinstance(value, dict), where, f"expected an object, got {value!r}")
    result: dict[str, str | None] = {}
    for key, state in value.items():
        entity_id = _entity_id(key, f"{where} key")
        _require(
            state is None or isinstance(state, str),
            f"{where}.{key}",
            f"a state is a string, or null for a missing entity; got {state!r}",
        )
        result[entity_id] = state
    return result


def _optional_text(value: Any, where: str) -> str | None:
    _require(
        value is None or (isinstance(value, str) and value != ""),
        where,
        f"expected a non-empty string or null, got {value!r}",
    )
    return value


def _expand_scenario(raw: Any, index: int, curve_entity: str, where: str) -> list[Scenario]:
    where = f"{where} scenarios[{index}]"
    _require(isinstance(raw, dict), where, "a scenario is an object")
    _unknown_keys(raw, SCENARIO_KEYS, where)
    for key in ("name", "states", "available", "state", "mode", "reason"):
        _require(key in raw, where, f"missing key {key!r}")
    name = raw["name"]
    _require(isinstance(name, str) and name.strip() != "", where, "'name' must be a string")
    where = f"{where} ({name!r})"
    states = _state_map(raw["states"], f"{where} states")
    matrix_raw = raw.get("matrix", {})
    _require(isinstance(matrix_raw, dict), f"{where} matrix", "expected an object")
    matrix: dict[str, list[str | None]] = {}
    for key, values in matrix_raw.items():
        entity_id = _entity_id(key, f"{where} matrix key")
        _require(entity_id not in states, where, f"{entity_id} is both in states and matrix")
        _require(
            isinstance(values, list)
            and len(values) > 0
            and all(v is None or isinstance(v, str) for v in values),
            f"{where} matrix.{key}",
            "expected a non-empty list of states (strings, or null for a missing entity)",
        )
        matrix[entity_id] = values
    available = raw["available"]
    _require(isinstance(available, bool), where, "'available' must be true or false")
    state = raw["state"]
    mode = _optional_text(raw["mode"], f"{where} mode")
    reason = _optional_text(raw["reason"], f"{where} reason")
    fixed_curve = curve_entity in states or curve_entity in matrix
    time = raw.get("time")
    if fixed_curve:
        _require(
            isinstance(time, str) and TIME_RE.match(time) is not None,
            where,
            f"sets the curve entity {curve_entity}, so it needs a 'time' HH:MM, got {time!r}",
        )
    else:
        _require(
            time is None,
            where,
            "runs on every fixture case (it does not set the curve entity): the case gives the"
            " time, remove 'time'",
        )
    state_ok = (
        state is None
        or (isinstance(state, int) and not isinstance(state, bool))
        or is_canonical_value(state)
    )
    if not fixed_curve:
        state_ok = state_ok or state in STATE_FROM_CASE
    _require(
        state_ok,
        where,
        "'state' must be null, an integer, a canonical value string such as '18.5'"
        + ("" if fixed_curve else ", 'curve' or 'max'")
        + f"; got {state!r}",
    )
    if available:
        _require(state is not None, where, "an available scenario needs a 'state'")
        _require(mode is not None, where, "an available scenario needs a 'mode'")
    else:
        _require(
            state is None and mode is None and reason is None,
            where,
            "an unavailable sensor publishes no state and no attributes: state, mode and"
            " reason must be null",
        )
    combos = list(itertools.product(*matrix.values())) if matrix else [()]
    scenarios = []
    for combo in combos:
        overlay = {**states, **dict(zip(matrix, combo))}
        suffix = (
            "[" + ",".join(f"{k}={json.dumps(v)}" for k, v in zip(matrix, combo)) + "]"
            if matrix
            else ""
        )
        scenarios.append(
            Scenario(
                name=f"{name}{suffix}",
                overlay=overlay,
                time=time if fixed_curve else None,
                available=available,
                state=state,
                mode=mode,
                reason=reason,
            )
        )
    return scenarios


def load_descriptor(path: Path) -> Descriptor:
    where = str(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise DescriptorError(f"{where}: cannot read the descriptor: {err}") from err
    _require(isinstance(data, dict), where, "a descriptor is a JSON object")
    _unknown_keys(data, DESCRIPTOR_KEYS, where)
    for key in (
        "package",
        "curve_entity",
        "sensor_unique_id",
        "range",
        "step",
        "unit",
        "neutral_states",
        "scenarios",
    ):
        _require(key in data, where, f"missing key {key!r}")
    raw_range, step, unit = data["range"], data["step"], data["unit"]
    _require(
        isinstance(raw_range, list)
        and len(raw_range) == 2
        and all(isinstance(v, int) and not isinstance(v, bool) for v in raw_range)
        and -MAX_ABS_CENTI <= raw_range[0] < raw_range[1] <= MAX_ABS_CENTI,
        where,
        f"'range' must be [minCenti, maxCenti] with min < max, got {raw_range!r}",
    )
    _require(
        isinstance(step, int) and not isinstance(step, bool) and step >= 1,
        where,
        f"'step' must be a positive integer (centi-units), got {step!r}",
    )
    _require(isinstance(unit, str), where, f"'unit' must be a string, got {unit!r}")
    package = data["package"]
    _require(isinstance(package, str) and package != "", where, "'package' must be a path")
    curve_entity = _entity_id(data["curve_entity"], f"{where} curve_entity")
    _require(
        curve_entity.startswith("input_text."), where, "'curve_entity' must be an input_text"
    )
    unique_id = data["sensor_unique_id"]
    _require(
        isinstance(unique_id, str) and unique_id != "", where, "'sensor_unique_id' is required"
    )
    neutral = _state_map(data["neutral_states"], f"{where} neutral_states")
    _require(
        curve_entity not in neutral,
        where,
        "neutral_states must not set the curve entity (the fixture cases give the curve)",
    )
    raw_scenarios = data["scenarios"]
    _require(isinstance(raw_scenarios, list), where, "'scenarios' must be a list")
    scenarios = [
        scenario
        for index, raw in enumerate(raw_scenarios)
        for scenario in _expand_scenario(raw, index, curve_entity, where)
    ]
    names = [scenario.name for scenario in scenarios]
    duplicates = sorted({n for n in names if names.count(n) > 1})
    _require(not duplicates, where, f"duplicate scenario names {duplicates}")
    checks = data.get("checks", {})
    _require(isinstance(checks, dict), where, "'checks' must be an object")
    _unknown_keys(checks, CHECK_KEYS, f"{where} checks")
    for key in ("curve_helper", "sensor"):
        _require(isinstance(checks.get(key, {}), dict), where, f"checks.{key} must be an object")
    for key in ("forbidden_sensor_keys", "removed", "kept_blocks", "kept_sensor_keys"):
        value = checks.get(key, [])
        _require(
            isinstance(value, list) and all(isinstance(v, str) for v in value),
            where,
            f"checks.{key} must be a list of strings",
        )
    if "kept_blocks" in checks or "kept_sensor_keys" in checks:
        _require(
            isinstance(checks.get("kept_blocks_from"), str),
            where,
            "checks.kept_blocks / kept_sensor_keys need checks.kept_blocks_from",
        )
    label = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()
    return Descriptor(
        path=path,
        label=label.removesuffix(DESCRIPTOR_SUFFIX),
        package_path=path.parent / package,
        curve_entity=curve_entity,
        sensor_unique_id=unique_id,
        value_range=(raw_range[0], raw_range[1]),
        step=step,
        unit=unit,
        neutral_states=neutral,
        scenarios=tuple(scenarios),
        checks=checks,
    )


DESCRIPTORS = [load_descriptor(path) for path in discover_descriptor_paths()]

#: The curve rule (implicit for every descriptor): neutral states, every fixture case.
CURVE_RULE = Scenario(
    name="curve-rule",
    overlay={},
    time=None,
    available=True,
    state="curve",
    mode=MODE_CURVE,
    reason=None,
)


def make_hass(
    desc: Descriptor,
    *,
    time: str,
    curve: str | None = None,
    overlay: Mapping[str, str | None] | None = None,
) -> HassMock:
    """The state machine of one scenario: neutral states, then the curve, then ``overlay``
    (which may replace the curve). ``None`` means the entity does not exist."""
    entities: dict[str, str | None] = {
        **desc.neutral_states,
        desc.curve_entity: curve,
        **(overlay or {}),
    }
    return HassMock(
        {k: v for k, v in entities.items() if v is not None}, at(time), watched=tuple(entities)
    )


# --------------------------------------------------------------------------------------------
# Package loading (lazy, so a missing package fails its tests, not the collection)
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class HaTag:
    """A YAML value carrying an HA-specific tag (``!secret``, ``!include``, ...), kept inert."""

    tag: str
    value: Any


class _PackageLoader(yaml.SafeLoader):
    """PyYAML's SafeLoader (what HA's loader builds on) that keeps HA tags as ``HaTag``."""


def _construct_ha_tag(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node) -> HaTag:
    if isinstance(node, yaml.ScalarNode):
        return HaTag(f"!{tag_suffix}", loader.construct_scalar(node))
    if isinstance(node, yaml.SequenceNode):
        return HaTag(f"!{tag_suffix}", loader.construct_sequence(node))
    return HaTag(f"!{tag_suffix}", loader.construct_mapping(node))  # type: ignore[arg-type]


_PackageLoader.add_multi_constructor("!", _construct_ha_tag)

_YAML_CACHE: dict[Path, dict[str, Any]] = {}


def load_yaml_mapping(path: Path, what: str) -> dict[str, Any]:
    """Loads (once) a YAML file that must be a mapping, failing the test with a readable
    message."""
    cached = _YAML_CACHE.get(path)
    if cached is not None:
        return cached
    if not path.is_file():
        pytest.fail(f"{what} not found: {path}", pytrace=False)
    try:
        data = yaml.load(path.read_text(encoding="utf-8"), Loader=_PackageLoader)
    except yaml.YAMLError as err:
        pytest.fail(f"{what} {path} is not valid YAML: {err}", pytrace=False)
    if not isinstance(data, dict):
        pytest.fail(
            f"{what} {path} must be a YAML mapping, got {type(data).__name__}", pytrace=False
        )
    _YAML_CACHE[path] = data
    return data


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def find_sensor_config(package: Mapping[str, Any], unique_id: str, where: str) -> dict[str, Any]:
    """The template sensor with the given ``unique_id`` (exactly one)."""
    matches: list[dict[str, Any]] = []
    seen: list[str] = []
    for block in _as_list(package.get("template")):
        if not isinstance(block, dict):
            continue
        for sensor in _as_list(block.get("sensor")):
            if isinstance(sensor, dict):
                seen.append(str(sensor.get("unique_id", "<no unique_id>")))
                if sensor.get("unique_id") == unique_id:
                    matches.append(sensor)
    if len(matches) != 1:
        pytest.fail(
            f"{where}: expected exactly one template sensor with unique_id"
            f" '{unique_id}' under template: -> sensor:, found {len(matches)}"
            f" (template sensors seen: {seen or 'none'})",
            pytrace=False,
        )
    return matches[0]


def _template_source(value: Any, key: str, where: str) -> str:
    """Mirror of ``cv.template``: scalars are stringified, containers and null are invalid."""
    if value is None:
        pytest.fail(f"{where}: sensor has no '{key}' template", pytrace=False)
    if isinstance(value, (list, dict, HaTag)):
        pytest.fail(f"{where}: '{key}' must be a template string, got {value!r}", pytrace=False)
    return str(value)


@dataclass(frozen=True)
class SensorTemplates:
    availability: str
    state: str
    mode: str
    reason: str

    def labelled(self) -> tuple[tuple[str, str], ...]:
        return (
            ("availability", self.availability),
            ("state", self.state),
            ("attributes.mode", self.mode),
            ("attributes.reason", self.reason),
        )


def package_of(desc: Descriptor) -> dict[str, Any]:
    return load_yaml_mapping(desc.package_path, f"Package of {desc.label}")


def sensor_config_of(desc: Descriptor) -> dict[str, Any]:
    return find_sensor_config(package_of(desc), desc.sensor_unique_id, str(desc.package_path))


def sensor_of(desc: Descriptor) -> SensorTemplates:
    where = str(desc.package_path)
    config = sensor_config_of(desc)
    attributes = config.get("attributes")
    if not isinstance(attributes, dict):
        pytest.fail(f"{where}: sensor has no 'attributes:' (mode and reason)", pytrace=False)
    for key in ("mode", "reason"):
        if key not in attributes:
            pytest.fail(f"{where}: sensor has no 'attributes: {key}:' template", pytrace=False)
    return SensorTemplates(
        availability=_template_source(config.get("availability"), "availability", where),
        state=_template_source(config.get("state"), "state", where),
        mode=_template_source(attributes["mode"], "attributes.mode", where),
        reason=_template_source(attributes["reason"], "attributes.reason", where),
    )


# --------------------------------------------------------------------------------------------
# Rendering like the HA template entity
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Outcome:
    """What HA publishes for the sensor. ``state`` / ``mode`` / ``reason`` are ``None`` while
    unavailable: HA renders none of those templates then and publishes no attribute (see
    ``evaluate``). ``mode`` / ``reason`` are the published (parsed) attribute values."""

    availability_raw: str
    available: bool
    state: str | None
    mode: Any
    reason: Any

    def describe(self) -> str:
        return (
            f"availability={self.availability_raw!r} (available={self.available})"
            f" state={self.state!r} mode={self.mode!r} reason={self.reason!r}"
        )


def evaluate(sensor: SensorTemplates, hass: HassMock) -> Outcome:
    """Renders the templates the way the HA template entity uses them.

    ``availability`` is HA's super template: it is rendered first, and when it is not true the
    state and attribute templates are not rendered at all (``helpers/event.py``,
    ``has_super_template``), and an unavailable entity publishes no attributes
    (``helpers/entity.py``). HA only skips the other templates when the parsed availability is
    not ``None``; with ``None`` they are rendered but, the entity being unavailable, still not
    published, so ``state`` / ``mode`` / ``reason`` are ``None`` in both cases. Use
    ``render_all`` to render every template regardless (never-raise guard).
    """
    availability_raw = ENV.render(sensor.availability, hass, "availability")
    available = result_as_boolean(parse_result(availability_raw))
    if not available:
        return Outcome(availability_raw, available=False, state=None, mode=None, reason=None)
    return Outcome(
        availability_raw=availability_raw,
        available=True,
        state=ENV.render(sensor.state, hass, "state"),
        mode=parse_result(ENV.render(sensor.mode, hass, "attributes.mode")),
        reason=parse_result(ENV.render(sensor.reason, hass, "attributes.reason")),
    )


def render_all(sensor: SensorTemplates, hass: HassMock) -> dict[str, str]:
    """Renders all templates unconditionally, even those HA skips while unavailable."""
    return {label: ENV.render(source, hass, label) for label, source in sensor.labelled()}


def _case_context(
    desc: Descriptor, case: Mapping[str, Any] | None, hass: HassMock, outcome: Outcome | None
) -> str:
    lines = [f"package {desc.label} ({desc.package_path})"]
    if case is not None:
        lines.append(
            f"case {case.get('name')!r}: curve={case.get('curve')!r} time={case.get('time')}"
            f" expected={case.get('expected')!r} max={case.get('max')!r}"
        )
        if case.get("note"):
            lines.append(f"  note: {case['note']}")
    lines.append(f"  scenario: {hass.describe()}")
    if outcome is not None:
        lines.append(f"  rendered: {outcome.describe()}")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# Parametrization
# --------------------------------------------------------------------------------------------

DESCRIPTOR_PARAMS = [pytest.param(desc, id=desc.label) for desc in DESCRIPTORS]
CASE_PARAMS = [
    pytest.param(desc, case, id=f"{desc.label}::{case_id}")
    for desc in DESCRIPTORS
    for case, case_id in desc.cases()
]
SCENARIO_PARAMS = [
    pytest.param(desc, scenario, case, id=f"{desc.label}::{scenario.name}::{case_id}")
    for desc in DESCRIPTORS
    for scenario in desc.scenarios
    if scenario.per_case
    for case, case_id in desc.cases()
] + [
    pytest.param(desc, scenario, None, id=f"{desc.label}::{scenario.name}")
    for desc in DESCRIPTORS
    for scenario in desc.scenarios
    if not scenario.per_case
]

# --------------------------------------------------------------------------------------------
# 0. The shared fixture and the descriptors are usable
# --------------------------------------------------------------------------------------------


def test_fixture_is_well_formed() -> None:
    problems: list[str] = []
    names = [case.get("name") for case in CASES]
    duplicates = sorted({n for n in names if names.count(n) > 1}, key=str)
    if duplicates:
        problems.append(f"duplicate case names: {duplicates}")
    for case in CASES:
        name = case.get("name")
        for key in ("name", "curve", "time", "expected", "canonical", "max"):
            if key not in case:
                problems.append(f"{name}: missing key {key!r}")
        if not isinstance(case.get("curve"), str):
            problems.append(f"{name}: curve must be a string")
        if not isinstance(case.get("time"), str) or not TIME_RE.match(case["time"]):
            problems.append(f"{name}: time must be HH:MM, got {case.get('time')!r}")
        raw_range, step = case.get("range", list(DEFAULT_RANGE)), case.get("step", DEFAULT_STEP)
        range_ok = (
            isinstance(raw_range, list)
            and len(raw_range) == 2
            and all(isinstance(v, int) and not isinstance(v, bool) for v in raw_range)
            and -MAX_ABS_CENTI <= raw_range[0] < raw_range[1] <= MAX_ABS_CENTI
        )
        if not range_ok:
            problems.append(f"{name}: range must be [minCenti, maxCenti], got {raw_range!r}")
        if not isinstance(step, int) or isinstance(step, bool) or step < 1:
            problems.append(f"{name}: step must be a positive integer, got {step!r}")
        for key in ("expected", "max"):
            value = case.get(key)
            if value is not None and not is_canonical_value(value):
                problems.append(f"{name}: {key} must be null or a canonical value string")
            elif value is not None and range_ok and key == "expected":
                centi = parse_value_centi(value)
                assert centi is not None
                if not raw_range[0] <= centi <= raw_range[1]:
                    problems.append(f"{name}: {key} {value!r} is outside the case's range")
        if not (case.get("expected") is None) == (case.get("max") is None) == (
            case.get("canonical") is None
        ):
            problems.append(
                f"{name}: expected, canonical and max must be null together (invalid curve)"
            )
    assert not problems, "\n".join(problems)


def test_descriptors_are_collected() -> None:
    public = [desc.label for desc in DESCRIPTORS if desc.path.parent == PUBLIC_DESCRIPTOR_DIR]
    assert public, (
        f"no ha/*{DESCRIPTOR_SUFFIX} descriptor: the generic example package must be tested"
    )
    if _skip_private():
        private = [desc.label for desc in DESCRIPTORS if desc.path.is_relative_to(PRIVATE_DIR)]
        assert not private, f"{SKIP_PRIVATE_ENV_VAR} is set but {private} were collected"


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_descriptor_range_has_enough_fixture_cases(desc: Descriptor) -> None:
    """The fixture must cover the package's range and step, invalid curves included."""
    cases = [case for case, _ in desc.cases()]
    assert len(cases) >= MIN_CASES_PER_PACKAGE, (
        f"{desc.path}: only {len(cases)} fixture case(s) have range {list(desc.value_range)}"
        f" and step {desc.step}; add cases to {FIXTURE_PATH.name}"
        f" (at least {MIN_CASES_PER_PACKAGE})"
    )
    assert any(case["expected"] is None for case in cases), (
        f"{desc.path}: no invalid-curve fixture case for range {list(desc.value_range)}"
    )


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_descriptor_entities_are_read_by_the_sensor(desc: Descriptor) -> None:
    """Every entity id the descriptor sets is read by a sensor template: a typo in the
    descriptor would otherwise test nothing."""
    sources = [source for _, source in sensor_of(desc).labelled()]
    entity_ids = {
        desc.curve_entity,
        *desc.neutral_states,
        *(entity_id for scenario in desc.scenarios for entity_id in scenario.overlay),
    }
    unused = sorted(e for e in entity_ids if not any(e in source for source in sources))
    assert not unused, f"{desc.path}: entity ids the sensor templates never read: {unused}"


# --------------------------------------------------------------------------------------------
# 1. The curve rule: every fixture case under the neutral states
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("desc, case", CASE_PARAMS)
def test_curve_rule_matches_fixture(desc: Descriptor, case: dict[str, Any]) -> None:
    sensor = sensor_of(desc)
    hass = make_hass(desc, time=case["time"], curve=case["curve"])
    outcome = evaluate(sensor, hass)
    context = _case_context(desc, case, hass, outcome)
    expected = case["expected"]
    if expected is None:
        assert not outcome.available, f"invalid curve must make the sensor unavailable\n{context}"
        return
    assert outcome.available, f"valid curve must make the sensor available\n{context}"
    assert outcome.state == expected, f"state must be exactly {expected!r}\n{context}"
    assert (outcome.mode, outcome.reason) == (MODE_CURVE, None), (
        f"the curve rule publishes mode {MODE_CURVE!r} and no reason (null)\n{context}"
    )


# --------------------------------------------------------------------------------------------
# 2. The rule scenarios of each descriptor
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("desc, scenario, case", SCENARIO_PARAMS)
def test_rule_scenario(
    desc: Descriptor, scenario: Scenario, case: dict[str, Any] | None
) -> None:
    sensor = sensor_of(desc)
    if case is None:
        assert scenario.time is not None
        hass = make_hass(desc, time=scenario.time, overlay=scenario.overlay)
        expected_state: Any = scenario.state
    else:
        hass = make_hass(desc, time=case["time"], curve=case["curve"], overlay=scenario.overlay)
        expected_state = (
            case[{"curve": "expected", "max": "max"}[scenario.state]]
            if scenario.state in STATE_FROM_CASE
            else scenario.state
        )
    try:
        render_all(sensor, hass)
    except TemplateError as err:
        pytest.fail(f"a template raised: {err}\n{_case_context(desc, case, hass, None)}")
    outcome = evaluate(sensor, hass)
    context = f"scenario {scenario.name!r}\n{_case_context(desc, case, hass, outcome)}"
    if not scenario.available or expected_state is None:
        assert not outcome.available, f"the sensor must be unavailable\n{context}"
        return
    assert outcome.available, f"the sensor must be available\n{context}"
    assert outcome.state == str(expected_state), (
        f"state must be exactly {str(expected_state)!r}\n{context}"
    )
    assert outcome.mode == scenario.mode, f"mode must be {scenario.mode!r}\n{context}"
    assert outcome.reason == scenario.reason, f"reason must be {scenario.reason!r}\n{context}"


# --------------------------------------------------------------------------------------------
# 3. The parse block is textually identical in availability and state
# --------------------------------------------------------------------------------------------


def extract_parse_block(source: str, label: str) -> str:
    """Text between the parse markers; fails when the markers are missing, repeated or swapped."""
    begins, ends = source.count(PARSE_BEGIN), source.count(PARSE_END)
    if begins != 1 or ends != 1:
        pytest.fail(
            f"{label}: expected exactly one {PARSE_BEGIN!r} and one {PARSE_END!r} marker,"
            f" found {begins} and {ends}",
            pytrace=False,
        )
    start = source.index(PARSE_BEGIN) + len(PARSE_BEGIN)
    end = source.index(PARSE_END)
    if end < start:
        pytest.fail(f"{label}: {PARSE_END!r} comes before {PARSE_BEGIN!r}", pytrace=False)
    block = source[start:end]
    if not block.strip():
        pytest.fail(f"{label}: the parse block is empty", pytrace=False)
    return block


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_parse_block_is_identical_in_availability_and_state(desc: Descriptor) -> None:
    sensor = sensor_of(desc)
    availability = extract_parse_block(sensor.availability, f"{desc.label} availability")
    state = extract_parse_block(sensor.state, f"{desc.label} state")
    if availability != state:
        diff = "\n".join(
            difflib.unified_diff(
                availability.splitlines(),
                state.splitlines(),
                "availability parse block",
                "state parse block",
                lineterm="",
            )
        )
        pytest.fail(
            f"{desc.package_path}: the parse block differs between availability and state"
            " (compared after YAML parsing: use the same block style and indentation for"
            " both):\n" + diff,
            pytrace=False,
        )


RANGE_CONSTANT_RE = re.compile(r"\{%-?\s*set\s+(vmin|vmax|vstep)\s*=\s*(-?[0-9]+)\s*-?%\}")


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_parse_block_range_constants_match_descriptor(desc: Descriptor) -> None:
    """``vmin`` / ``vmax`` / ``vstep`` are set once each, as integer literals, in the parse block,
    and equal the descriptor's ``range`` / ``step`` (which select the fixture cases)."""
    block = extract_parse_block(sensor_of(desc).state, f"{desc.label} state")
    found: dict[str, list[int]] = {}
    for name, value in RANGE_CONSTANT_RE.findall(block):
        found.setdefault(name, []).append(int(value))
    expected = {"vmin": [desc.value_range[0]], "vmax": [desc.value_range[1]], "vstep": [desc.step]}
    assert found == expected, (
        f"{desc.package_path}: the parse block must set each of vmin, vmax, vstep once to"
        f" {expected} (the descriptor's range and step), found {found}"
    )


# --------------------------------------------------------------------------------------------
# 4. The package declarations and the descriptor's optional checks
# --------------------------------------------------------------------------------------------


def _yaml_diff(expected: Any, actual: Any, expected_label: str, actual_label: str) -> str:
    return "\n".join(
        difflib.unified_diff(
            yaml.safe_dump(expected, allow_unicode=True, sort_keys=False).splitlines(),
            yaml.safe_dump(actual, allow_unicode=True, sort_keys=False).splitlines(),
            expected_label,
            actual_label,
            lineterm="",
        )
    )


def _declaration(package: Mapping[str, Any], entity_id: str) -> Any:
    domain, object_id = entity_id.split(".", 1)
    section = package.get(domain)
    return section.get(object_id) if isinstance(section, dict) else None


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_package_declares_the_curve_input_text(desc: Descriptor) -> None:
    helper = _declaration(package_of(desc), desc.curve_entity)
    assert isinstance(helper, dict), (
        f"{desc.package_path}: {desc.curve_entity} is not declared under input_text:"
    )
    problems = []
    if helper.get("max") != 255:
        problems.append(
            f"max must be 255 (HA's hard limit; the default is 100), got {helper.get('max')!r}"
        )
    if "initial" in helper:
        problems.append(
            "no 'initial:' allowed: HA restores the value across restarts only without it"
        )
    if helper.get("mode", "text") != "text":
        problems.append(f"mode must be 'text', got {helper.get('mode')!r}")
    for key, value in desc.checks.get("curve_helper", {}).items():
        if helper.get(key) != value:
            problems.append(f"{key} must be {value!r} (descriptor), got {helper.get(key)!r}")
    assert not problems, f"{desc.package_path}: {desc.curve_entity}:\n" + "\n".join(problems)


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_package_sensor_config(desc: Descriptor) -> None:
    config = sensor_config_of(desc)
    problems = []
    if config.get("unit_of_measurement") != desc.unit:
        problems.append(
            f"unit_of_measurement must be {desc.unit!r} (descriptor 'unit'),"
            f" got {config.get('unit_of_measurement')!r}"
        )
    if "device_class" in config:
        problems.append(
            "no device_class: Home Assistant may convert the state (e.g. temperature to"
            " Fahrenheit) and the card would compare it with the curve in its own unit"
        )
    for key, value in desc.checks.get("sensor", {}).items():
        if config.get(key) != value:
            problems.append(f"{key} must be {value!r} (descriptor), got {config.get(key)!r}")
    for key in desc.checks.get("forbidden_sensor_keys", []):
        if key in config:
            problems.append(f"{key} must not be set (descriptor: forbidden_sensor_keys)")
    assert not problems, f"{desc.package_path}: sensor {desc.sensor_unique_id}:\n" + "\n".join(
        problems
    )


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_package_removes_entities(desc: Descriptor) -> None:
    """``checks.removed``: neither declared nor read by the sensor (passes when not set)."""
    package = package_of(desc)
    removed = desc.checks.get("removed", [])
    labelled = sensor_of(desc).labelled() if removed else ()
    problems = []
    for entity_id in removed:
        if "." not in entity_id:
            problems.append(f"checks.removed: {entity_id!r} is not an entity id")
            continue
        if _declaration(package, entity_id) is not None:
            problems.append(f"{entity_id} is still declared")
        for label, source in labelled:
            if entity_id in source:
                problems.append(f"{entity_id} is still referenced by the {label} template")
    assert not problems, f"{desc.package_path}:\n" + "\n".join(problems)


@pytest.mark.parametrize("desc", DESCRIPTOR_PARAMS)
def test_package_keeps_reference_blocks(desc: Descriptor) -> None:
    """``checks.kept_blocks`` / ``kept_sensor_keys`` against ``checks.kept_blocks_from``
    (passes when not set)."""
    reference_name = desc.checks.get("kept_blocks_from")
    if reference_name is None:
        return
    reference_path = desc.resolve(reference_name)
    reference = load_yaml_mapping(reference_path, f"Reference package of {desc.label}")
    package = package_of(desc)
    problems = []
    for key in desc.checks.get("kept_blocks", []):
        if "." in key:
            expected, actual = _declaration(reference, key), _declaration(package, key)
        else:
            expected, actual = reference.get(key), package.get(key)
        if expected is None:
            problems.append(f"{key} is not in the reference {reference_path.name}")
        elif actual is None:
            problems.append(f"{key} must be kept (it is missing)")
        elif actual != expected:
            diff = _yaml_diff(expected, actual, reference_path.name, desc.package_path.name)
            problems.append(f"{key} must be unchanged:\n{diff}")
    keys = desc.checks.get("kept_sensor_keys", [])
    if keys:
        ref_sensor = find_sensor_config(reference, desc.sensor_unique_id, str(reference_path))
        config = sensor_config_of(desc)
        problems += [
            f"sensor {key} must stay {ref_sensor.get(key)!r} (entity registry / existing"
            f" automations), got {config.get(key)!r}"
            for key in keys
            if config.get(key) != ref_sensor.get(key)
        ]
    assert not problems, f"{desc.package_path}:\n" + "\n".join(problems)


# --------------------------------------------------------------------------------------------
# 5. Sandbox guard: rendering never raises; availability covers the state's ``none`` guard
# --------------------------------------------------------------------------------------------


def _is_value_in_range(state: str, desc: Descriptor) -> bool:
    """A published state automations accept: a canonical value (``19.5``, ``70``, no padding,
    no trailing zero) inside the package's range."""
    centi = parse_value_centi(state)
    return (
        is_canonical_value(state)
        and centi is not None
        and desc.value_range[0] <= centi <= desc.value_range[1]
    )


def _per_case_overlays(desc: Descriptor) -> list[Mapping[str, str | None]]:
    """The neutral states plus the overlay of every per-case scenario (deduplicated)."""
    overlays: list[Mapping[str, str | None]] = [{}]
    for scenario in desc.scenarios:
        if scenario.per_case and scenario.overlay not in overlays:
            overlays.append(scenario.overlay)
    return overlays


def _published_attributes(desc: Descriptor) -> list[tuple[Any, Any]]:
    """The (mode, reason) pairs an available sensor may publish, per the descriptor."""
    pairs: list[tuple[Any, Any]] = [(MODE_CURVE, None)]
    for scenario in desc.scenarios:
        pair = (scenario.mode, scenario.reason)
        if scenario.available and pair not in pairs:
            pairs.append(pair)
    return pairs


@pytest.mark.parametrize("desc, case", CASE_PARAMS)
def test_templates_never_raise(desc: Descriptor, case: dict[str, Any]) -> None:
    """Every template renders for every fixture curve, including the ones HA skips while the
    sensor is unavailable (a package must stay total), and availability covers the state
    template's ``none`` guard exactly: whenever availability is true the state is a canonical
    value inside the range and (mode, reason) a pair the descriptor expects (HA would otherwise
    publish ``none`` for a sensor with a unit)."""
    sensor = sensor_of(desc)
    allowed = _published_attributes(desc)
    failures = []
    for time in GUARD_TIMES:
        for overlay in _per_case_overlays(desc):
            hass = make_hass(desc, time=time, curve=case["curve"], overlay=overlay)
            try:
                rendered = render_all(sensor, hass)
            except TemplateError as err:
                failures.append(f"{hass.describe()}\n    {err}")
                continue
            if not result_as_boolean(parse_result(rendered["availability"])):
                continue
            if not _is_value_in_range(rendered["state"], desc):
                failures.append(
                    f"{hass.describe()}\n    available but state {rendered['state']!r} is not"
                    f" a canonical value in {list(desc.value_range)} (centi-units)"
                )
            pair = (
                parse_result(rendered["attributes.mode"]),
                parse_result(rendered["attributes.reason"]),
            )
            if pair not in allowed:
                failures.append(
                    f"{hass.describe()}\n    available but (mode, reason) = {pair!r} is none of"
                    f" {allowed!r}"
                )
    assert not failures, f"{desc.label}, case {case.get('name')!r}:\n  " + "\n  ".join(failures)


# --------------------------------------------------------------------------------------------
# 6. now() is captured once per render (curve.ts note 5)
# --------------------------------------------------------------------------------------------


@pytest.mark.parametrize("desc, case", CASE_PARAMS)
def test_now_is_called_at_most_once_per_render(desc: Descriptor, case: dict[str, Any]) -> None:
    calls = {}
    for label, source in sensor_of(desc).labelled():
        hass = make_hass(desc, time=case["time"], curve=case["curve"])
        ENV.render(source, hass, label)
        calls[label] = hass.now_calls
    assert all(count <= 1 for count in calls.values()), (
        "now() must be captured once ({% set t = now() %}): two calls can straddle a minute"
        f" boundary. Calls per template: {calls}"
    )
