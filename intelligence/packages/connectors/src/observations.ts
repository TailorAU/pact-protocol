// Small shared helpers for building Observation envelopes from parsed rows.

import { ulid } from "@pact-tailor/ontology";
import type { ObservationRecord, ObservationValue, Quality } from "@pact-tailor/ontology";

export interface ObsInput {
  entity_id: string;
  metric: string;
  value: ObservationValue;
  event_time: string;
  ingest_time: string;
  source_id: string;
  feed_id: string;
  unit?: string;
  quality?: Quality;
  is_correction?: boolean;
  source_sequence?: string;
  meta?: Record<string, unknown>;
}

/** Build a full ObservationRecord (observation_id is a ULID at event time). */
export function makeObservation(input: ObsInput): ObservationRecord {
  const eventMs = Date.parse(input.event_time);
  return {
    observation_id: ulid(Number.isFinite(eventMs) ? eventMs : 0),
    entity_id: input.entity_id,
    metric: input.metric,
    value: input.value,
    event_time: input.event_time,
    ingest_time: input.ingest_time,
    source_id: input.source_id,
    feed_id: input.feed_id,
    quality: input.quality ?? "good",
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.is_correction !== undefined ? { is_correction: input.is_correction } : {}),
    ...(input.source_sequence !== undefined ? { source_sequence: input.source_sequence } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
}

/** String field access on a ParsedRecord row (missing → ""). */
export function fieldStr(row: Record<string, string | number>, key: string): string {
  const v = row[key];
  return v === undefined ? "" : String(v);
}

/** Numeric field access on a ParsedRecord row (missing/blank/NaN → null). */
export function fieldNum(row: Record<string, string | number>, key: string): number | null {
  const v = row[key];
  if (v === undefined || v === "") return null;
  const num = typeof v === "number" ? v : Number(v);
  return Number.isFinite(num) ? num : null;
}

/** Push an external id into `unmapped` once. */
export function reportUnmapped(unmapped: string[], id: string): void {
  if (id.length > 0 && !unmapped.includes(id)) unmapped.push(id);
}
