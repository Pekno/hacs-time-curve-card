/**
 * A tiny fake `hass` for the standalone dev harness and tests.
 * Mimics the two things that matter for this card:
 *  - `hass` is replaced by a NEW object on every state change (like HA does),
 *  - `callService('input_text', 'set_value', ...)` updates the entity state (the "echo" the card
 *    waits for before showing "Enregistr\u00e9"), after an optional latency, unless the mock is set
 *    to fail (rejects, no echo) or to swallow the value (`echo = false`: resolves, no state change,
 *    like HA rejecting a value longer than the helper's `max`).
 *
 * `latency`, `failServices` and `echo` are public mutable fields so the dev harness (checkboxes,
 * URL params) and the tests can change them on a live mock.
 */
import type { HassEntity, HomeAssistant } from '../src/types.js';

export interface ServiceCall {
  domain: string;
  service: string;
  data: Record<string, unknown>;
}

export interface MockHassOptions {
  /** Called with the new `hass` object after every state change. */
  onChange?: (hass: HomeAssistant) => void;
  /** Called on every service call (for logging / assertions), before the latency. */
  onService?: (call: ServiceCall) => void;
  /** Initial delay applied to callService, ms (simulates network). Default 0. */
  latency?: number;
  /** Initially make service calls reject (to test error handling). Default false. */
  failServices?: boolean;
  /** Initially echo `input_text.set_value` into the state (HA behaviour). Default true. */
  echo?: boolean;
}

/** Initial entity: a bare state string, or a state with attributes. */
export type MockEntityInit = string | { state: string; attributes?: Record<string, unknown> };

export class MockHass {
  hass: HomeAssistant;
  readonly calls: ServiceCall[] = [];

  /** Delay applied to every service call, ms (0 = resolve on the next microtask). */
  latency: number;

  /** When true every service call rejects (after the latency) and nothing is echoed. */
  failServices: boolean;

  /**
   * When false a successful `input_text.set_value` resolves WITHOUT updating the state - HA does
   * that for a value longer than the helper's `max` (it logs "Invalid value" and keeps the old
   * state). Exercises the card's echo timeout.
   */
  echo: boolean;

  private readonly onChange: MockHassOptions['onChange'];
  private readonly onService: MockHassOptions['onService'];

  constructor(initial: Record<string, MockEntityInit>, options: MockHassOptions = {}) {
    this.onChange = options.onChange;
    this.onService = options.onService;
    this.latency = options.latency ?? 0;
    this.failServices = options.failServices ?? false;
    this.echo = options.echo ?? true;
    const states: Record<string, HassEntity> = {};
    for (const [id, init] of Object.entries(initial)) {
      states[id] =
        typeof init === 'string'
          ? makeEntity(id, init)
          : makeEntity(id, init.state, init.attributes);
    }
    this.hass = {
      states,
      language: 'fr',
      callService: (domain, service, data = {}) => this.callService(domain, service, data),
    };
  }

  /** Update one entity state; produces a new `hass` object and a new entity object. */
  setState(entityId: string, state: string, attributes?: Record<string, unknown>): void {
    const prev = this.hass.states[entityId];
    const next = makeEntity(entityId, state, attributes ?? prev?.attributes ?? {});
    this.hass = {
      ...this.hass,
      states: { ...this.hass.states, [entityId]: next },
    };
    this.onChange?.(this.hass);
  }

  removeEntity(entityId: string): void {
    const states = Object.fromEntries(
      Object.entries(this.hass.states).filter(([id]) => id !== entityId),
    );
    this.hass = { ...this.hass, states };
    this.onChange?.(this.hass);
  }

  private async callService(
    domain: string,
    service: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const call: ServiceCall = { domain, service, data };
    this.calls.push(call);
    this.onService?.(call);
    // The fields are read AFTER the latency on purpose: flipping a checkbox while a call is in
    // flight applies to that call, like a network failure would.
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
    if (this.failServices) throw new Error('mock: service call failed');
    if (domain === 'input_text' && service === 'set_value' && this.echo) {
      const id = String(data.entity_id);
      this.setState(id, String(data.value));
    }
  }
}

function makeEntity(
  entityId: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HassEntity {
  const now = new Date().toISOString();
  return { entity_id: entityId, state, attributes, last_changed: now, last_updated: now };
}
