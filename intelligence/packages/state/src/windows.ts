// WindowAggregator — tumbling 5-minute and 1-hour windows per
// (entity_id, metric) over numeric observation values, computing
// {min, max, mean, last, count}. Windows are aligned to the epoch
// (start = floor(event_time / size) * size).
//
// The watermark is the maximum event_time seen across all observations minus
// allowedLatenessMs (default 10 minutes). A window whose end is at or before
// the watermark is closed; an observation that lands in a closed window still
// patches it — the add() result flags it as a revision so downstream can
// re-emit the corrected aggregate. Non-numeric values are skipped.
import type { ObservationRecord } from "@pact-tailor/ontology";

export const WINDOW_5M = 300_000;
export const WINDOW_1H = 3_600_000;
export type WindowSizeMs = typeof WINDOW_5M | typeof WINDOW_1H;
export const WINDOW_SIZES_MS: readonly WindowSizeMs[] = [WINDOW_5M, WINDOW_1H];

export const DEFAULT_ALLOWED_LATENESS_MS = 600_000;

export interface WindowAggregate {
  entity_id: string;
  metric: string;
  window_ms: WindowSizeMs;
  /** Inclusive window start, ISO 8601. */
  window_start: string;
  /** Exclusive window end, ISO 8601. */
  window_end: string;
  min: number;
  max: number;
  mean: number;
  /** Value of the latest-event_time observation in the window (arrival breaks ties). */
  last: number;
  count: number;
}

export interface WindowAddResult {
  /** False when the value was non-numeric (or event_time unparseable) and skipped. */
  accepted: boolean;
  /** True when the observation landed in at least one already-closed window. */
  revised: boolean;
  /** Fresh snapshots of the windows this observation landed in (one per size). */
  aggregates: WindowAggregate[];
}

interface WindowState {
  min: number;
  max: number;
  sum: number;
  count: number;
  last: number;
  lastEventMs: number;
}

function keyOf(entityId: string, metric: string): string {
  return `${entityId} ${metric}`;
}

export class WindowAggregator {
  /** size → key → windowStartMs → running aggregate. */
  private readonly windowsBySize = new Map<WindowSizeMs, Map<string, Map<number, WindowState>>>();
  private readonly allowedLatenessMs: number;
  private maxEventMs: number | null = null;

  constructor(opts: { allowedLatenessMs?: number } = {}) {
    this.allowedLatenessMs = opts.allowedLatenessMs ?? DEFAULT_ALLOWED_LATENESS_MS;
    for (const size of WINDOW_SIZES_MS) this.windowsBySize.set(size, new Map());
  }

  /** Current watermark in epoch ms (max seen event_time − allowed lateness), or null before any data. */
  watermarkMs(): number | null {
    return this.maxEventMs === null ? null : this.maxEventMs - this.allowedLatenessMs;
  }

  /**
   * Fold one observation into its 5-minute and 1-hour windows. Closed-window
   * membership is judged against the watermark as it stood BEFORE this
   * observation, so an observation never closes its own window.
   */
  add(obs: ObservationRecord): WindowAddResult {
    const value = obs.value;
    const eventMs = Date.parse(obs.event_time);
    if (typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(eventMs)) {
      return { accepted: false, revised: false, aggregates: [] };
    }

    const priorWatermark = this.watermarkMs();
    const key = keyOf(obs.entity_id, obs.metric);
    const aggregates: WindowAggregate[] = [];
    let revised = false;

    for (const size of WINDOW_SIZES_MS) {
      const startMs = Math.floor(eventMs / size) * size;
      const endMs = startMs + size;
      if (priorWatermark !== null && endMs <= priorWatermark) revised = true;

      const byKey = this.windowsBySize.get(size) as Map<string, Map<number, WindowState>>;
      let byStart = byKey.get(key);
      if (!byStart) {
        byStart = new Map();
        byKey.set(key, byStart);
      }
      const win = byStart.get(startMs);
      if (!win) {
        byStart.set(startMs, { min: value, max: value, sum: value, count: 1, last: value, lastEventMs: eventMs });
      } else {
        win.min = Math.min(win.min, value);
        win.max = Math.max(win.max, value);
        win.sum += value;
        win.count += 1;
        if (eventMs >= win.lastEventMs) {
          win.last = value;
          win.lastEventMs = eventMs;
        }
      }
      aggregates.push(this.snapshot(obs.entity_id, obs.metric, size, startMs, byStart.get(startMs) as WindowState));
    }

    if (this.maxEventMs === null || eventMs > this.maxEventMs) this.maxEventMs = eventMs;
    return { accepted: true, revised, aggregates };
  }

  /** All aggregates for the key at one window size, sorted by window_start. */
  windows(entityId: string, metric: string, windowMs: WindowSizeMs): WindowAggregate[] {
    const byStart = this.windowsBySize.get(windowMs)?.get(keyOf(entityId, metric));
    if (!byStart) return [];
    return [...byStart.entries()]
      .sort(([a], [b]) => a - b)
      .map(([startMs, win]) => this.snapshot(entityId, metric, windowMs, startMs, win));
  }

  private snapshot(
    entityId: string,
    metric: string,
    size: WindowSizeMs,
    startMs: number,
    win: WindowState,
  ): WindowAggregate {
    return {
      entity_id: entityId,
      metric,
      window_ms: size,
      window_start: new Date(startMs).toISOString(),
      window_end: new Date(startMs + size).toISOString(),
      min: win.min,
      max: win.max,
      mean: win.sum / win.count,
      last: win.last,
      count: win.count,
    };
  }
}
