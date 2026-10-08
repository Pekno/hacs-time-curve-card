/**
 * Minimal Home Assistant typings: only what this card needs.
 * We deliberately do not depend on `custom-card-helpers` or HA internals.
 */

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity | undefined>;
  language?: string;
  /** Subset of HA's core config; `time_zone` is the IANA zone the template sensor's `now()` uses. */
  config?: { time_zone?: string; unit_system?: { temperature?: string } };
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Lovelace config for `custom:time-curve-card` (see docs/card-rendering-spec.md, section 2.1). */
export interface CardConfig {
  type: string;
  /** input_text entity holding the curve string (required). */
  entity: string;
  /**
   * Optional template sensor exposing the live computed target value; its optional `mode`
   * (`curve`, or e.g. `override`) and `reason` attributes explain a value that is not the curve's.
   */
  target_sensor?: string;
  /**
   * Optional entity shown in the status row (its friendly name and state): a light ("allum\u{e9}e
   * \u{b7} 60 %"), a thermostat (its current temperature), any other entity (state + unit).
   */
  target_entity?: string;
  title?: string;
  /** Value preset: `brightness` (default), `temperature`, `color_temp` or `custom`. */
  preset?: string;
  /** Lowest value (user units, at most 2 decimals); overrides the preset. */
  min?: number;
  /** Highest value; overrides the preset. */
  max?: number;
  /** Value step (drag, keyboard, interpolation); overrides the preset. */
  step?: number;
  /** Unit shown after the values (may be empty); overrides the preset. */
  unit?: string;
  /** Name of the value (detail row, chart label); overrides the preset. */
  label?: string;
  /** Curve written by the reset button; overrides the preset's. */
  default_curve?: string;
  /** Visible x-range start, "HH:MM", must lie inside the 12:00 -> 12:00 curve day. */
  window_start?: string;
  /** Visible x-range end, "HH:MM". */
  window_end?: string;
  /** Time snapping step for drags, in minutes. */
  snap_minutes?: number;
  /** Maximum number of points (input_text is capped at 255 chars). */
  max_points?: number;
}

/** Minimal Lovelace card interface implemented by the element. */
export interface LovelaceCard extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: CardConfig): void;
  getCardSize(): number;
}
