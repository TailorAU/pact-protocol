// ID grammar for the PACT.TAILOR intelligence workspace.
//
// Entity IDs:      typeCode:namespace[:slug]     e.g. gen:au-nem:bayswater
// Relationships:   rel:<slug>
// Sources:         source:<publisher>:<dataset>
// Gaps:            gap:<ns>:<slug>
// Feeds:           feed:<ns>:<slug>[:<sub>]
// Inferences:      infer:YYYY-MM-DD:<slug>

import type { EntityType } from "./types.js";

export const ENTITY_ID_RE = /^[a-z][a-z0-9]*:[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;
export const REL_ID_RE = /^rel:[a-z0-9][a-z0-9-]*$/;
export const SOURCE_ID_RE = /^source:[a-z0-9-]+:[a-z0-9-]+$/;
export const GAP_ID_RE = /^gap:[a-z0-9-]+:[a-z0-9-]+$/;
export const FEED_ID_RE = /^feed:[a-z0-9-]+:[a-z0-9-]+(:[a-z0-9-]+)?$/;
export const INFERENCE_ID_RE = /^infer:[0-9]{4}-[0-9]{2}-[0-9]{2}:[a-z0-9][a-z0-9-]*$/;

export interface ParsedEntityId {
  /** Leading type code, e.g. "gen" */
  typeCode: string;
  /** Second segment, e.g. "au-nem" */
  namespace: string;
  /** Optional third segment, or null when absent */
  slug: string | null;
}

/** Parse an entity ID into its segments, or return null if malformed. */
export function parseEntityId(id: string): ParsedEntityId | null {
  if (!ENTITY_ID_RE.test(id)) return null;
  const parts = id.split(":");
  const typeCode = parts[0];
  const namespace = parts[1];
  if (typeCode === undefined || namespace === undefined) return null;
  return { typeCode, namespace, slug: parts[2] ?? null };
}

export function isEntityId(id: string): boolean {
  return ENTITY_ID_RE.test(id);
}

export function isRelId(id: string): boolean {
  return REL_ID_RE.test(id);
}

export function isSourceId(id: string): boolean {
  return SOURCE_ID_RE.test(id);
}

export function isGapId(id: string): boolean {
  return GAP_ID_RE.test(id);
}

export function isFeedId(id: string): boolean {
  return FEED_ID_RE.test(id);
}

export function isInferenceId(id: string): boolean {
  return INFERENCE_ID_RE.test(id);
}

/**
 * Expected entity-ID type code(s) per entity_type.
 * "mine" is shared by CoalMine and Mine.
 * (Observation has no code in the published grammar; "obs" is reserved for it.)
 */
export const TYPE_CODES: Readonly<Record<EntityType, readonly string[]>> = {
  Grid: ["grid"],
  GridRegion: ["region"],
  Operator: ["operator"],
  Generator: ["gen"],
  StorageAsset: ["storage"],
  TransmissionAsset: ["line"],
  Interconnector: ["intercon"],
  Substation: ["sub"],
  CoalBasin: ["basin"],
  CoalMine: ["mine"],
  GasBasin: ["gasbasin"],
  GasField: ["gasfield"],
  GasProcessingPlant: ["gasplant"],
  Pipeline: ["pipe"],
  HydroReservoir: ["resv"],
  IndustrialFacility: ["facility"],
  Smelter: ["smelter"],
  SteelMill: ["steel"],
  Mine: ["mine"],
  Refinery: ["refinery"],
  LNGPlant: ["lng"],
  ChemicalPlant: ["chem"],
  DataCentre: ["dc"],
  Port: ["port"],
  Terminal: ["terminal"],
  Berth: ["berth"],
  Railway: ["rail"],
  Train: ["train"],
  Vessel: ["vessel"],
  Company: ["company"],
  Commodity: ["commodity"],
  Product: ["product"],
  Market: ["market"],
  Destination: ["dest"],
  Sensor: ["sensor"],
  TelemetryFeed: ["feed"],
  Observation: ["obs"],
  Source: ["source"],
  Evidence: ["evidence"],
  Inference: ["infer"],
  ObservabilityGap: ["gap"],
};

/**
 * Check that an entity_id's leading type code matches the expected code(s)
 * for the given entity_type. Shared codes (e.g. "mine") are allowed.
 * Returns false for malformed IDs or unknown entity types.
 */
export function checkIdMatchesType(entityId: string, entityType: EntityType): boolean {
  const parsed = parseEntityId(entityId);
  if (parsed === null) return false;
  const codes = TYPE_CODES[entityType];
  if (codes === undefined) return false;
  return codes.includes(parsed.typeCode);
}
