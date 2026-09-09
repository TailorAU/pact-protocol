// Live state cache fed by the /api/intel/stream SSE feed.
// Map<entity_id, Map<metric, {value, unit, event_time}>>; deck re-renders are
// triggered through onChange, throttled to at most 4 fps. Reconnects with
// exponential backoff. When the API is absent the cache simply stays empty
// and the HUD reports "API offline — structural view".

import { API_BASE } from "./api.js";
import type { StreamStateEvent, VesselPositionValue } from "./types.js";

export type ConnectionState = "connecting" | "live" | "offline";

export interface CachedMetric {
  value: number | string | Record<string, unknown>;
  unit?: string;
  event_time: string;
}

const THROTTLE_MS = 250; // 4 fps max
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export class StateCache {
  private byEntity = new Map<string, Map<string, CachedMetric>>();
  private source: EventSource | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private changeListeners = new Set<() => void>();
  private connectionListeners = new Set<(s: ConnectionState) => void>();

  /** Monotonic version bump per applied update — used for deck updateTriggers. */
  version = 0;
  connection: ConnectionState = "connecting";
  inferenceCount = 0;

  start(): void {
    if (this.source) return;
    this.connect();
  }

  stop(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.source?.close();
    this.source = null;
  }

  get(entityId: string, metric: string): CachedMetric | undefined {
    return this.byEntity.get(entityId)?.get(metric);
  }

  metricsFor(entityId: string): ReadonlyMap<string, CachedMetric> | undefined {
    return this.byEntity.get(entityId);
  }

  getNumber(entityId: string, metric: string): number | undefined {
    const v = this.get(entityId, metric)?.value;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  }

  /** First numeric hit among candidate metric names. */
  getFirstNumber(entityId: string, metrics: string[]): number | undefined {
    for (const m of metrics) {
      const v = this.getNumber(entityId, m);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /**
   * Fallback lookup when the exact metric name is unknown: first numeric
   * metric whose unit is MW or whose name ends in the given suffix.
   */
  findMegawatts(entityId: string): number | undefined {
    const metrics = this.byEntity.get(entityId);
    if (!metrics) return undefined;
    for (const [name, entry] of metrics) {
      if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
        continue;
      }
      if (entry.unit === "MW" || name.endsWith("_mw") || name.endsWith(".mw")) {
        return entry.value;
      }
    }
    return undefined;
  }

  getVesselPosition(entityId: string): VesselPositionValue | undefined {
    const entry =
      this.get(entityId, "vessel.position") ?? this.get(entityId, "position");
    const v = entry?.value;
    if (
      v !== null &&
      typeof v === "object" &&
      typeof (v as Record<string, unknown>).lat === "number" &&
      typeof (v as Record<string, unknown>).lon === "number"
    ) {
      return v as unknown as VesselPositionValue;
    }
    return undefined;
  }

  /**
   * Seed a metric from a REST snapshot (e.g. grid summary flows) — only when
   * no fresher SSE value already occupies the slot.
   */
  seed(
    entityId: string,
    metric: string,
    value: number | string | Record<string, unknown>,
    unit: string | undefined,
    eventTime: string,
  ): void {
    if (this.get(entityId, metric)) return;
    let metrics = this.byEntity.get(entityId);
    if (!metrics) {
      metrics = new Map();
      this.byEntity.set(entityId, metrics);
    }
    const entry: CachedMetric = { value, event_time: eventTime };
    if (unit !== undefined) entry.unit = unit;
    metrics.set(metric, entry);
    this.markDirty();
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onConnectionChange(fn: (s: ConnectionState) => void): () => void {
    this.connectionListeners.add(fn);
    return () => this.connectionListeners.delete(fn);
  }

  // -- internals ------------------------------------------------------------

  private connect(): void {
    this.setConnection(this.connection === "live" ? "live" : "connecting");
    let source: EventSource;
    try {
      source = new EventSource(`${API_BASE}/stream`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = source;

    source.onopen = () => {
      this.backoffMs = BACKOFF_MIN_MS;
      this.setConnection("live");
    };

    source.onerror = () => {
      // EventSource auto-retries, but when the API is down entirely we take
      // over with our own capped exponential backoff.
      source.close();
      if (this.source === source) this.source = null;
      this.setConnection("offline");
      this.scheduleReconnect();
    };

    const onState = (ev: Event) => {
      this.applyStateEvent((ev as MessageEvent<string>).data);
    };
    source.addEventListener("state.updated", onState);
    source.addEventListener("state.corrected", onState);
    source.addEventListener("inference", () => {
      this.inferenceCount += 1;
      this.markDirty();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private applyStateEvent(raw: string): void {
    let parsed: StreamStateEvent;
    try {
      parsed = JSON.parse(raw) as StreamStateEvent;
    } catch {
      return;
    }
    const state = parsed?.state;
    if (!state || typeof state.entity_id !== "string" || !state.metric) return;
    let metrics = this.byEntity.get(state.entity_id);
    if (!metrics) {
      metrics = new Map();
      this.byEntity.set(state.entity_id, metrics);
    }
    const entry: CachedMetric = {
      value: state.value,
      event_time: state.event_time,
    };
    if (state.unit !== undefined) entry.unit = state.unit;
    metrics.set(state.metric, entry);
    this.markDirty();
  }

  private markDirty(): void {
    this.version += 1;
    this.dirty = true;
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      for (const fn of this.changeListeners) fn();
    }, THROTTLE_MS);
  }

  private setConnection(s: ConnectionState): void {
    if (this.connection === s) return;
    this.connection = s;
    for (const fn of this.connectionListeners) fn(s);
  }
}

export const stateCache = new StateCache();
