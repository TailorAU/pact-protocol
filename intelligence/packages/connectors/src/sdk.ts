// Connector SDK — the shared contract every source connector implements.
//
// Pipeline: discover() lists candidate artifacts, fetch() pulls verbatim bytes
// (bronze), parse() turns bytes into flat table rows, normalize() maps rows to
// canonical Observation envelopes (silver). The HttpGate seam makes fixture
// replay and live fetching the SAME code path — connectors never know which
// they are talking to.
//
// HONESTY: this workspace is built under blocked egress. Every connector is
// written against the source's DOCUMENTED wire format, exercised only through
// synthetic fixtures (fixture_provenance: synthetic-from-spec). Nothing in
// this package claims live verification; see verify-live.ts for the harness
// that a human runs to earn `verified_live` status.

import type { EntityRecord, ObservationRecord, TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { HttpGate, MessageGate } from "./gate.js";
import type { EntityIndex } from "./entity-index.js";

/** A discovered artifact: something fetchable that may yield observations. */
export interface ArtifactRef {
  url: string;
  name: string;
  meta?: Record<string, unknown>;
}

/** Verbatim fetched bytes plus fetch metadata — exactly what bronze stores. */
export interface RawArtifact {
  ref: ArtifactRef;
  body: Buffer;
  fetched_at: string;
  http_status: number;
  content_type?: string;
}

/** One flat row extracted from a raw artifact, tagged with its table name. */
export interface ParsedRecord {
  table: string;
  row: Record<string, string | number>;
}

/**
 * Output of normalize(). `unmapped` lists the external ids (DUIDs, region ids,
 * MMSIs, EICs, ...) that could not be resolved to an entity — their rows are
 * DROPPED, never guessed at, and the ids are surfaced here so the gap is
 * visible in every IngestReport.
 */
export interface NormalizedOutput {
  observations: ObservationRecord[];
  unmapped: string[];
}

/** Result of a live verification attempt (see verify-live.ts). */
export interface VerificationReport {
  connector_id: string;
  source_id: string;
  ok: boolean;
  error?: string;
  checked_at: string;
  notes?: string;
}

/** Everything a connector is handed at runtime. */
export interface ConnectorCtx {
  /** HTTP seam: ReplayGate (fixtures) or LiveGate — same connector code path. */
  gate: HttpGate;
  /** Websocket/stream seam, present for streaming connectors (aisstream). */
  messageGate?: MessageGate;
  /** Wall-clock, injectable for deterministic tests. Returns ISO-8601 UTC. */
  now(): string;
  /** External-id → entity_id resolution built from the registry + seed entities. */
  entityIndex: EntityIndex;
  log(msg: string): void;
}

export interface Connector {
  /** Stable connector id; also names its fixtures dir: fixtures/{id}/. */
  id: string;
  /** The source registry record this connector ingests from. */
  source_id: string;
  /** Telemetry feeds this connector writes (silver partitions). */
  feeds: TelemetryFeedRecord[];
  schedule: { intervalMs: number; jitterMs: number };
  discover(ctx: ConnectorCtx): Promise<ArtifactRef[]>;
  fetch(ref: ArtifactRef, ctx: ConnectorCtx): Promise<RawArtifact>;
  parse(raw: RawArtifact): Promise<ParsedRecord[]>;
  normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput;
  /** Optional custom live-verification probe (stubs report why they can't). */
  verify?(ctx: ConnectorCtx): Promise<VerificationReport>;
  /**
   * Connector-owned structural entities (e.g. weather stations) that are not
   * part of the registry seed. The CLI merges these into the EntityIndex at
   * load time; registry records win on entity_id collision.
   */
  seedEntities?: EntityRecord[];
}
