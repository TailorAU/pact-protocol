// CurrentStateProjection — the per-(entity_id, metric) "what is it doing now"
// view. Canonical entities are never mutated: this projection is the only
// holder of live state, and consumers compose it with structural records at
// read time. Semantics (phase 14 of the handoff):
//
//   - Event-time latest wins: strictly newer event_time replaces the held
//     value and yields a "state.updated" delta.
//   - Late data (event_time equal-or-older, not a correction): no change,
//     no delta — callers keep it in history only.
//   - Corrections (is_correction: true AND corrects === held observation_id
//     OR source_sequence === held source_sequence): supersede the held value
//     EVEN at equal-or-older event_time, yielding "state.corrected" with the
//     previous value attached.
//   - Duplicates (same observation_id as held): ignored.
//
// Staleness is derived, never stored: staleness(now) computes it on demand.
import type { ObservationRecord, ObservationValue, Quality } from "@pact-tailor/ontology";
import type { StateDelta } from "./bus.js";

export interface CurrentMetricState {
  entity_id: string;
  metric: string;
  value: ObservationValue;
  unit?: string;
  event_time: string;
  ingest_time: string;
  source_id: string;
  feed_id: string;
  quality: Quality;
  observation_id: string;
}

interface Held {
  state: CurrentMetricState;
  /** Publisher run/interval id of the held observation — corrections match on it. */
  source_sequence?: string;
}

function keyOf(entityId: string, metric: string): string {
  return `${entityId} ${metric}`;
}

function eventMs(iso: string): number {
  return Date.parse(iso);
}

function toState(obs: ObservationRecord): CurrentMetricState {
  return {
    entity_id: obs.entity_id,
    metric: obs.metric,
    value: obs.value,
    ...(obs.unit !== undefined ? { unit: obs.unit } : {}),
    event_time: obs.event_time,
    ingest_time: obs.ingest_time,
    source_id: obs.source_id,
    feed_id: obs.feed_id,
    quality: obs.quality,
    observation_id: obs.observation_id,
  };
}

export class CurrentStateProjection {
  private readonly held = new Map<string, Held>();

  /**
   * Fold one observation into the projection. Returns the resulting delta,
   * or null when the observation changes nothing (duplicate or late).
   */
  apply(obs: ObservationRecord): StateDelta | null {
    const key = keyOf(obs.entity_id, obs.metric);
    const prev = this.held.get(key);

    if (!prev) {
      const state = toState(obs);
      this.setHeld(key, state, obs);
      return { type: "state.updated", state, previous: null };
    }

    // Duplicate of the held observation: ignore.
    if (obs.observation_id === prev.state.observation_id) return null;

    // Correction of the held observation supersedes even at equal-or-older
    // event_time. It must explicitly reference what it corrects — by the held
    // observation_id, or by sharing the held publisher source_sequence.
    const correctsHeld =
      obs.is_correction === true &&
      ((obs.corrects != null && obs.corrects === prev.state.observation_id) ||
        (obs.source_sequence !== undefined && obs.source_sequence === prev.source_sequence));
    if (correctsHeld) {
      const state = toState(obs);
      this.setHeld(key, state, obs);
      return { type: "state.corrected", state, previous: prev.state };
    }

    // Event-time latest wins.
    if (eventMs(obs.event_time) > eventMs(prev.state.event_time)) {
      const state = toState(obs);
      this.setHeld(key, state, obs);
      return { type: "state.updated", state, previous: prev.state };
    }

    // Late (or equal-time non-correction): history only, no state change.
    return null;
  }

  get(entityId: string, metric: string): CurrentMetricState | null {
    return this.held.get(keyOf(entityId, metric))?.state ?? null;
  }

  /** All held metric states for one entity, sorted by metric. */
  forEntity(entityId: string): CurrentMetricState[] {
    const out: CurrentMetricState[] = [];
    for (const { state } of this.held.values()) {
      if (state.entity_id === entityId) out.push(state);
    }
    return out.sort((a, b) => a.metric.localeCompare(b.metric));
  }

  /** Every held state, sorted by (entity_id, metric) for determinism. */
  all(): CurrentMetricState[] {
    const out: CurrentMetricState[] = [];
    for (const { state } of this.held.values()) out.push(state);
    return out.sort(
      (a, b) => a.entity_id.localeCompare(b.entity_id) || a.metric.localeCompare(b.metric),
    );
  }

  /**
   * Milliseconds between `now` and the held event_time — derived on demand,
   * never stored. Null when no state is held for the key.
   */
  staleness(entityId: string, metric: string, now: string | number | Date = Date.now()): number | null {
    const state = this.get(entityId, metric);
    if (!state) return null;
    const nowMs = typeof now === "number" ? now : typeof now === "string" ? Date.parse(now) : now.getTime();
    return nowMs - eventMs(state.event_time);
  }

  private setHeld(key: string, state: CurrentMetricState, obs: ObservationRecord): void {
    this.held.set(
      key,
      obs.source_sequence !== undefined ? { state, source_sequence: obs.source_sequence } : { state },
    );
  }
}
