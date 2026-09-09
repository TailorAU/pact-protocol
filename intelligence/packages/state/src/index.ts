// @pact-tailor/state — the real-time state engine (handoff phase 14).
// Observations in, per-(entity_id, metric) current state + bounded history +
// tumbling-window aggregates + typed deltas out. Canonical entities are never
// mutated; the API composes this state with structural records at read time.
import type { ObservationRecord } from "@pact-tailor/ontology";
import type { MedallionStore } from "@pact-tailor/store";
import { ObservationLog, DEFAULT_RETENTION_PER_KEY, type HistoryRange } from "./observations.js";
import { CurrentStateProjection, type CurrentMetricState } from "./current.js";
import {
  WindowAggregator,
  DEFAULT_ALLOWED_LATENESS_MS,
  type WindowAggregate,
  type WindowSizeMs,
} from "./windows.js";
import { StateBus, type StateDelta } from "./bus.js";

export { ObservationLog, DEFAULT_RETENTION_PER_KEY, type HistoryRange } from "./observations.js";
export { CurrentStateProjection, type CurrentMetricState } from "./current.js";
export {
  WindowAggregator,
  WINDOW_5M,
  WINDOW_1H,
  WINDOW_SIZES_MS,
  DEFAULT_ALLOWED_LATENESS_MS,
  type WindowSizeMs,
  type WindowAggregate,
  type WindowAddResult,
} from "./windows.js";
export { StateBus, type StateDelta, type StateDeltaType } from "./bus.js";

export interface StateEngineOptions {
  /** Ring-buffer depth per (entity_id, metric); default 576 (~48 h of 5-min data). */
  retentionPerKey?: number;
  /** Watermark lag for window aggregation; default 600 000 ms (10 minutes). */
  allowedLatenessMs?: number;
}

export interface IngestResult {
  /** Deltas emitted, in ingest order (each was also emitted on the bus). */
  deltas: StateDelta[];
  /** Observations recorded to history only (event_time not newer than held, no correction match). */
  late: number;
  /** Observations dropped because their observation_id was already seen for the key. */
  duplicates: number;
  /** Subset of deltas that were state.corrected. */
  corrections: number;
}

export type StateSnapshot = { at: string; states: CurrentMetricState[] };

export class StateEngine {
  readonly log: ObservationLog;
  readonly projection: CurrentStateProjection;
  readonly aggregator: WindowAggregator;
  readonly bus: StateBus;

  constructor(opts: StateEngineOptions = {}) {
    this.log = new ObservationLog(opts.retentionPerKey ?? DEFAULT_RETENTION_PER_KEY);
    this.projection = new CurrentStateProjection();
    this.aggregator = new WindowAggregator(
      opts.allowedLatenessMs !== undefined ? { allowedLatenessMs: opts.allowedLatenessMs } : {},
    );
    this.bus = new StateBus();
  }

  /**
   * Fold a batch of observations into the engine, in the given order.
   * Duplicates are dropped before touching history, windows, or state.
   * Every returned delta was also emitted on the bus, in the same order.
   */
  ingest(observations: ObservationRecord[]): IngestResult {
    const deltas: StateDelta[] = [];
    let late = 0;
    let duplicates = 0;
    let corrections = 0;

    for (const obs of observations) {
      const heldId = this.projection.get(obs.entity_id, obs.metric)?.observation_id;
      if (obs.observation_id === heldId || this.log.has(obs.entity_id, obs.metric, obs.observation_id)) {
        duplicates += 1;
        continue;
      }

      this.log.record(obs);
      // Every non-duplicate numeric observation lands in its event-time
      // window (late arrivals patch closed windows as revisions).
      this.aggregator.add(obs);

      const delta = this.projection.apply(obs);
      if (delta === null) {
        late += 1;
        continue;
      }
      if (delta.type === "state.corrected") corrections += 1;
      deltas.push(delta);
      this.bus.emitDelta(delta);
    }

    return { deltas, late, duplicates, corrections };
  }

  /** Held state for one metric ([] when unknown), or all metrics of an entity sorted by metric. */
  current(entityId: string, metric?: string): CurrentMetricState[] {
    if (metric !== undefined) {
      const state = this.projection.get(entityId, metric);
      return state ? [state] : [];
    }
    return this.projection.forEntity(entityId);
  }

  /** Retained observations for the key, sorted by event_time; range bounds are inclusive. */
  history(entityId: string, metric: string, range?: { from?: string; to?: string }): ObservationRecord[] {
    return this.log.history(entityId, metric, range as HistoryRange | undefined);
  }

  /** Tumbling-window aggregates (5 min or 1 h) for the key, sorted by window_start. */
  windows(entityId: string, metric: string, windowMs: WindowSizeMs): WindowAggregate[] {
    return this.aggregator.windows(entityId, metric, windowMs);
  }

  /** Derived, never stored: ms between `now` and the held event_time; null when the key is unknown. */
  staleness(entityId: string, metric: string, now: string | number | Date = Date.now()): number | null {
    return this.projection.staleness(entityId, metric, now);
  }

  /** Subscribe to every delta the engine emits. Returns the unsubscribe function. */
  onDelta(cb: (d: StateDelta) => void): () => void {
    return this.bus.onDelta(cb);
  }

  /** Deterministic full-state snapshot, shaped for GoldStore.snapshotState(snap, snap.at). */
  snapshot(): StateSnapshot {
    return { at: new Date().toISOString(), states: this.projection.all() };
  }

  /**
   * Boot-time replay from silver: reads the given feeds (default: all),
   * orders observations by ingest_time (stable, so same-instant arrivals keep
   * file order), and ingests them — corrections and late data resolve exactly
   * as they did live. Returns the number of observations replayed.
   */
  loadFromSilver(store: MedallionStore, feedIds?: string[]): number {
    const feeds = feedIds ?? store.silver.listFeeds();
    const observations: ObservationRecord[] = [];
    for (const feedId of feeds) observations.push(...store.silver.readFeed(feedId));
    observations.sort((a, b) => Date.parse(a.ingest_time) - Date.parse(b.ingest_time));
    this.ingest(observations);
    return observations.length;
  }
}
