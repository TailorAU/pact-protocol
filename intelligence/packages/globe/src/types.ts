// Local mirrors of the ontology shapes the globe consumes, plus the pinned
// /api/intel response contracts. Kept in lock-step with
// packages/ontology/src/types.ts — the JSON Schemas remain the source of truth.

// ---------------------------------------------------------------------------
// Entities
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

export interface GeoGeometry {
  type: string;
  coordinates: number[] | number[][] | number[][][] | number[][][][];
}

export interface EntityRecord {
  entity_id: string;
  entity_type: EntityType;
  name: string;
  observability: Observability;
  geometry?: GeoGeometry | null;
  country?: string | null;
  grid_id?: string | null;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Observability gaps
// ---------------------------------------------------------------------------

export type ValueBand = "low" | "medium" | "high" | "critical";
export type GapPriority = "P1" | "P2" | "P3" | "P4";
export type GapStatus = "open" | "proxied" | "instrumented" | "wont_do";
export type CostBand = "low" | "medium" | "high";

export interface InstrumentationOption {
  kind: string;
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
// Inferences
// ---------------------------------------------------------------------------

export type InferenceStatus =
  | "INFERRED"
  | "CORROBORATED"
  | "CONTESTED"
  | "VERIFIED"
  | "RETRACTED";

export interface EvidenceRef {
  kind: string;
  ref: string;
  role: "supports" | "contradicts";
}

export interface InferenceRecord {
  inference_id: string;
  claim: string;
  tier: "A" | "B" | "C";
  confidence: number;
  status: InferenceStatus;
  method: string;
  evidence?: EvidenceRef[];
  contrary_evidence?: EvidenceRef[];
  produced_at?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SDUI panel document
// ---------------------------------------------------------------------------

export interface SduiPanel {
  panel: string;
  props?: Record<string, unknown>;
  data?: { endpoint: string };
}

export interface SduiPanelDoc {
  entity_id: string;
  entity_type: EntityType;
  situation: string[];
  layout: SduiPanel[];
}

// ---------------------------------------------------------------------------
// /api/intel response contracts (pinned — the api package codes to the same)
// ---------------------------------------------------------------------------

export interface GridInfo {
  grid_id: string;
  name: string;
  kind: string;
  countries: string[];
  frequency_hz: number;
  live_data: { availability: string; notes?: string; source_ids?: string[] };
  parent_grid?: string | null;
}

export interface GridsResponse {
  grids: GridInfo[];
}

export interface GridSummaryResponse {
  grid: GridInfo;
  regions: Array<{ entity_id: string; name: string }>;
  live: {
    demand_mw: { value: number; event_time: string } | null;
    price: { value: number; event_time: string } | null;
    generation_mw: { value: number } | null;
    flows: Array<{
      entity_id: string;
      name: string;
      mw: number;
      event_time: string;
    }>;
  };
}

export interface EntitiesResponse {
  entities: EntityRecord[];
}

export interface StateEntry {
  metric: string;
  value: number | string | Record<string, unknown>;
  unit?: string;
  event_time: string;
  quality?: string;
  source_id?: string;
}

export interface EntityStateResponse {
  entity_id: string;
  states: StateEntry[];
}

export interface GapsResponse {
  gaps: ObservabilityGapRecord[];
}

/** `data:` payload of SSE events `state.updated` / `state.corrected`. */
export interface StreamStateEvent {
  state: {
    entity_id: string;
    metric: string;
    value: number | string | Record<string, unknown>;
    unit?: string;
    event_time: string;
  };
  previous?: unknown;
}

/** Structured value carried by `vessel.position` state. */
export interface VesselPositionValue {
  lat: number;
  lon: number;
  speed_kn?: number;
  heading_deg?: number;
  [key: string]: unknown;
}
