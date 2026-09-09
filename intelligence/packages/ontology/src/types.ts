// Canonical TypeScript mirrors of the JSON Schemas in intelligence/schemas/.
// Keep these in lock-step with the schemas — the schemas are the source of truth.

// ---------------------------------------------------------------------------
// GeoJSON (minimal WGS84 subset — mirrors geojson.schema.json)
// ---------------------------------------------------------------------------

/** [lon, lat] or [lon, lat, elevation] */
export type Position = [number, number] | [number, number, number] | number[];

export interface GeoJSONPoint {
  type: "Point";
  coordinates: Position;
}

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: Position[];
}

export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: Position[][];
}

export interface GeoJSONMultiPolygon {
  type: "MultiPolygon";
  coordinates: Position[][][];
}

export type GeoJSONGeometry =
  | GeoJSONPoint
  | GeoJSONLineString
  | GeoJSONPolygon
  | GeoJSONMultiPolygon;

// ---------------------------------------------------------------------------
// Entity (entity.schema.json)
// ---------------------------------------------------------------------------

export type EntityType =
  | "Grid"
  | "GridRegion"
  | "Operator"
  | "Generator"
  | "StorageAsset"
  | "TransmissionAsset"
  | "Interconnector"
  | "Substation"
  | "CoalBasin"
  | "CoalMine"
  | "GasBasin"
  | "GasField"
  | "GasProcessingPlant"
  | "Pipeline"
  | "HydroReservoir"
  | "IndustrialFacility"
  | "Smelter"
  | "SteelMill"
  | "Mine"
  | "Refinery"
  | "LNGPlant"
  | "ChemicalPlant"
  | "DataCentre"
  | "Port"
  | "Terminal"
  | "Berth"
  | "Railway"
  | "Train"
  | "Vessel"
  | "Company"
  | "Commodity"
  | "Product"
  | "Market"
  | "Destination"
  | "Sensor"
  | "TelemetryFeed"
  | "Observation"
  | "Source"
  | "Evidence"
  | "Inference"
  | "ObservabilityGap";

export type Observability =
  | "KNOWN_LIVE"
  | "ESTIMATED"
  | "NOT_OBSERVABLE"
  | "INSTRUMENTATION_OPPORTUNITY"
  | "UNCLASSIFIED";

export interface ExternalIds {
  aemo_duid?: string[];
  aemo_station_id?: string;
  aemo_region_id?: string;
  entsoe_eic?: string;
  eia_plant_code?: string;
  gem_id?: string;
  imo?: string;
  mmsi?: string;
  callsign?: string;
  unlocode?: string;
  abn?: string;
  lei?: string;
  wikidata_qid?: string;
  osm_id?: string;
}

// Typed per-entity-type property bags (entity-types/*.properties.json).
// All are open (additionalProperties: true) — extra keys are allowed.

export type GeneratorFuel =
  | "coal"
  | "gas"
  | "hydro"
  | "wind"
  | "solar"
  | "battery"
  | "pumped-hydro"
  | "diesel"
  | "biomass"
  | "nuclear"
  | "other";

export type GeneratorStatus =
  | "operating"
  | "mothballed"
  | "retired"
  | "announced"
  | "construction";

export interface GeneratorProperties {
  fuel?: GeneratorFuel;
  capacity_mw?: number;
  technology?: string;
  commissioned?: number;
  unit_count?: number;
  status?: GeneratorStatus;
  [key: string]: unknown;
}

export interface InterconnectorProperties {
  capacity_mw_forward?: number;
  capacity_mw_reverse?: number;
  from_region?: string;
  to_region?: string;
  hvdc?: boolean;
  [key: string]: unknown;
}

export interface VesselProperties {
  vessel_type?: string;
  dwt?: number;
  loa_m?: number;
  beam_m?: number;
  flag?: string;
  /** true marks exemplar/demo vessels that are NOT real ships */
  synthetic?: boolean;
  [key: string]: unknown;
}

export interface PortProperties {
  harbour_type?: string;
  max_draught_m?: number;
  [key: string]: unknown;
}

export interface TerminalProperties {
  commodities?: string[];
  nameplate_mtpa?: number;
  [key: string]: unknown;
}

export interface SmelterProperties {
  product?: string;
  capacity_tpa?: number;
  potlines?: number;
  technology?: string;
  [key: string]: unknown;
}

export type MineType = "open-cut" | "underground" | "mixed";

export interface MineProperties {
  commodities?: string[];
  mine_type?: MineType;
  capacity_mtpa?: number;
  status?: string;
  [key: string]: unknown;
}

export type PipelineCommodity = "gas" | "oil" | "water" | "slurry";

export interface PipelineProperties {
  commodity?: PipelineCommodity;
  length_km?: number;
  capacity_tj_day?: number;
  [key: string]: unknown;
}

export interface GridProperties {
  frequency_hz?: 50 | 60;
  kind?: string;
  [key: string]: unknown;
}

export type EntityProperties =
  | GeneratorProperties
  | InterconnectorProperties
  | VesselProperties
  | PortProperties
  | TerminalProperties
  | SmelterProperties
  | MineProperties
  | PipelineProperties
  | GridProperties
  | Record<string, unknown>;

export interface EntityRecord {
  entity_id: string;
  entity_type: EntityType;
  name: string;
  aliases?: string[];
  data_class: "structural";
  observability: Observability;
  geometry?: GeoJSONGeometry | null;
  country?: string | null;
  admin?: { region?: string; locality?: string };
  grid_id?: string | null;
  properties?: EntityProperties;
  external_ids?: ExternalIds;
  sources: string[];
  valid_from?: string | null;
  valid_to?: string | null;
  notes?: string;
  same_as?: string | null;
}

// ---------------------------------------------------------------------------
// Relationship (relationship.schema.json)
// ---------------------------------------------------------------------------

export type RelType =
  | "PART_OF"
  | "CONNECTED_TO"
  | "INTERCONNECTED_WITH"
  | "OWNED_BY"
  | "OPERATED_BY"
  | "EXTRACTS"
  | "SUPPLIES"
  | "MAY_SUPPLY"
  | "TRANSPORTS"
  | "GENERATES"
  | "TRANSMITS"
  | "IMPORTS_FROM"
  | "EXPORTS_TO"
  | "CONSUMES"
  | "PRODUCES"
  | "LOADS_AT"
  | "DEPARTS_FROM"
  | "ARRIVES_AT"
  | "SHIPS_TO"
  | "OBSERVED_BY"
  | "REPORTED_BY"
  | "INFERRED_FROM"
  | "SUPPORTED_BY"
  | "CONTRADICTED_BY";

export type RelMethod = "declared" | "derived" | "inferred" | "manual";

export type EvidenceKind = "observation" | "structural" | "inference";

/** Evidence item on a relationship ({kind, ref}). */
export interface RelEvidenceItem {
  kind: EvidenceKind;
  ref: string;
}

export interface RelationshipRecord {
  rel_id: string;
  rel_type: RelType;
  from_id: string;
  to_id: string;
  confidence: number;
  source: string;
  method: RelMethod;
  valid_from?: string | null;
  valid_to?: string | null;
  recorded_at?: string | null;
  superseded_at?: string | null;
  /** Required (minItems 1) when method === "inferred". */
  evidence?: RelEvidenceItem[];
  properties?: Record<string, unknown>;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Observation (observation.schema.json)
// ---------------------------------------------------------------------------

export type Quality = "good" | "suspect" | "estimated" | "interpolated" | "missing";

/** Structured value for vessel.position observations. */
export interface VesselPositionValue {
  lat: number;
  lon: number;
  speed_kn?: number;
  heading_deg?: number;
  draught_m?: number;
  [key: string]: unknown;
}

export type ObservationValue = number | string | Record<string, unknown>;

export interface ObservationRecord {
  observation_id: string;
  entity_id: string;
  metric: string;
  value: ObservationValue;
  event_time: string;
  ingest_time: string;
  source_id: string;
  feed_id: string;
  quality: Quality;
  unit?: string;
  is_correction?: boolean;
  corrects?: string | null;
  source_sequence?: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Source (source.schema.json)
// ---------------------------------------------------------------------------

export type ApiType = "rest" | "websocket" | "file-drop" | "html" | "bulk-download" | "none";
export type SourceDataClass = "live" | "static" | "both";
export type LicensingClass =
  | "open"
  | "open-attribution"
  | "registration-required"
  | "commercial"
  | "restricted";
export type VerificationStatus = "verified_live" | "documented_only" | "unverified";
export type Authentication = "none" | "api_key" | "oauth" | "registration";

export interface SourceRecord {
  source_id: string;
  publisher: string;
  dataset: string;
  api_type: ApiType;
  url: string;
  docs_url?: string;
  coverage: { grids: string[]; countries: string[] };
  data_class: SourceDataClass;
  entity_types?: string[];
  metrics?: string[];
  latency?: string;
  resolution?: string;
  update_frequency?: string;
  history_depth?: string;
  licensing: { class: LicensingClass; notes?: string };
  authentication?: Authentication;
  cost?: string;
  reliability?: number;
  verification_status: VerificationStatus;
  last_checked: string;
  quality_notes?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Observability gap (observability-gap.schema.json)
// ---------------------------------------------------------------------------

export type ValueBand = "low" | "medium" | "high" | "critical";
export type GapPriority = "P1" | "P2" | "P3" | "P4";
export type GapStatus = "open" | "proxied" | "instrumented" | "wont_do";
export type CostBand = "low" | "medium" | "high";

export type InstrumentationKind =
  | "ct_sensor"
  | "revenue_meter"
  | "power_quality_meter"
  | "substation_gateway"
  | "iot_gateway"
  | "weather_station"
  | "camera_ocr"
  | "ais_receiver"
  | "gnss"
  | "scada_integration"
  | "plc_integration"
  | "opc_ua"
  | "modbus"
  | "mqtt_gateway"
  | "environmental_sensor"
  | "condition_sensor"
  | "satellite_thermal"
  | "satellite_optical"
  | "partner_feed"
  | "customer_api";

export interface InstrumentationOption {
  kind: InstrumentationKind;
  notes?: string;
  indicative_cost_band?: CostBand;
}

export interface ObservabilityGapRecord {
  gap_id: string;
  entity_id: string;
  desired_metric: string;
  commercial_value: ValueBand;
  strategic_value: ValueBand;
  priority: GapPriority;
  status: GapStatus;
  current_source?: string | null;
  best_available_proxy?: {
    source_id: string;
    metric: string;
    derivation?: string;
  } | null;
  required_resolution?: string;
  required_accuracy?: string;
  instrumentation_options?: InstrumentationOption[];
  estimated_complexity?: CostBand;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Inference (inference.schema.json)
// ---------------------------------------------------------------------------

export type InferenceTier = "A" | "B" | "C";
export type InferenceStatus =
  | "INFERRED"
  | "CORROBORATED"
  | "CONTESTED"
  | "VERIFIED"
  | "RETRACTED";

/** Evidence item on an inference — role discriminates supporting vs contradicting. */
export interface EvidenceRef {
  kind: EvidenceKind;
  ref: string;
  role: "supports" | "contradicts";
}

export interface SupportingEvidenceRef extends EvidenceRef {
  role: "supports";
}

export interface ContraryEvidenceRef extends EvidenceRef {
  role: "contradicts";
}

export interface InferenceRecord {
  inference_id: string;
  claim: string;
  claim_structured: {
    subject: string;
    predicate: string;
    object: string;
    qualifiers?: Record<string, unknown>;
  };
  tier: InferenceTier;
  confidence: number;
  status: InferenceStatus;
  /** rule:<name>@<semver>, e.g. rule:load-estimate@1.2.0 */
  method: string;
  evidence: SupportingEvidenceRef[];
  contrary_evidence?: ContraryEvidenceRef[];
  sources: string[];
  produced_at: string;
  event_time_range?: { from?: string; to?: string };
  lineage?: {
    correlation_id?: string;
    in_response_to?: string | null;
    prev_hash?: string | null;
  };
  pact?: { fabric_id?: string; proposal_id?: string } | null;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Grid registry record (grid.schema.json)
// ---------------------------------------------------------------------------

export type GridKind =
  | "synchronous_area"
  | "interconnection"
  | "iso_rto"
  | "tso_area"
  | "market"
  | "balancing_authority"
  | "national_grid"
  | "regional_grid"
  | "isolated_grid"
  | "captive";

export type LiveDataAvailability = "rich" | "partial" | "minimal" | "none";

export type OperatorRole =
  | "system_operator"
  | "market_operator"
  | "tso"
  | "transmission_owner"
  | "regulator";

export interface GridRecord {
  grid_id: string;
  name: string;
  kind: GridKind;
  countries: string[];
  frequency_hz: 50 | 60;
  live_data: {
    availability: LiveDataAvailability;
    notes?: string;
    source_ids?: string[];
  };
  sources: string[];
  parent_grid?: string | null;
  operators?: Array<{ name: string; role: OperatorRole }>;
  market?: {
    structure?: string;
    price_mechanism?: string;
    dispatch_interval?: string;
  } | null;
  timezone?: string;
  interconnections?: Array<{
    to_grid: string;
    name?: string;
    capacity_mw?: number | null;
  }>;
  demand_range_mw?: { min?: number; max?: number } | null;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Telemetry feed (telemetry-feed.schema.json)
// ---------------------------------------------------------------------------

export interface TelemetryFeedRecord {
  feed_id: string;
  source_id: string;
  connector_id: string;
  metrics: string[];
  cadence: string;
  description?: string;
  entity_scope?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// SDUI panel document (sdui-panel.schema.json)
// ---------------------------------------------------------------------------

export type SduiSituation =
  | "no-live-data"
  | "stale-telemetry"
  | "has-gaps"
  | "estimated-load"
  | "anomaly-active"
  | "normal";

export type SduiPanelKind =
  | "headline-state"
  | "timeseries"
  | "gap-card"
  | "graph-neighborhood"
  | "inference-list"
  | "vessel-track"
  | "fuel-mix"
  | "price-strip"
  | "flow-arcs"
  | "table"
  | "markdown-note";

export interface SduiPanel {
  panel: SduiPanelKind;
  props?: Record<string, unknown>;
  data?: { endpoint: string };
}

export interface SduiPanelDoc {
  entity_id: string;
  entity_type: EntityType;
  situation: SduiSituation[];
  layout: SduiPanel[];
}
