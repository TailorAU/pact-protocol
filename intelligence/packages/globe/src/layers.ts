// GPU layer builders. Everything geographic is instanced — no DOM markers.

import type { Color } from "@deck.gl/core";
import { ArcLayer, IconLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { StateCache } from "./state-cache.js";
import type { EntityRecord, ObservabilityGapRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** NEM region centroids — the demo's hardcoded interconnector anchor points. */
export const NEM_REGION_CENTROIDS: Record<string, [number, number]> = {
  QLD1: [146.5, -21],
  NSW1: [147, -32.5],
  VIC1: [144.5, -36.8],
  SA1: [137, -31],
  TAS1: [146.5, -42],
};

export function pointCoords(e: EntityRecord): [number, number] | null {
  const g = e.geometry;
  if (!g || g.type !== "Point") return null;
  const c = g.coordinates as number[];
  const lon = c[0];
  const lat = c[1];
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  return [lon, lat];
}

const GREY: Color = [107, 114, 128, 200];

/** Utilisation colour ramp: cool (idle) → hot (flat out). */
const RAMP: Array<[number, Color]> = [
  [0.0, [56, 130, 246, 220]],
  [0.35, [45, 212, 191, 225]],
  [0.7, [250, 204, 21, 230]],
  [1.0, [248, 113, 113, 240]],
];

function rampColor(t: number): Color {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    const hi = RAMP[i];
    const lo = RAMP[i - 1];
    if (!hi || !lo) break;
    if (x <= hi[0]) {
      const span = hi[0] - lo[0] || 1;
      const f = (x - lo[0]) / span;
      const a = lo[1];
      const b = hi[1];
      return [
        Math.round((a[0] ?? 0) + ((b[0] ?? 0) - (a[0] ?? 0)) * f),
        Math.round((a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * f),
        Math.round((a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * f),
        Math.round((a[3] ?? 255) + ((b[3] ?? 255) - (a[3] ?? 255)) * f),
      ];
    }
  }
  const last = RAMP[RAMP.length - 1];
  return last ? last[1] : GREY;
}

const GEN_MW_METRICS = [
  "power.output_mw",
  "generation_mw",
  "power.generation_mw",
  "output_mw",
  "dispatch_mw",
  "mw",
];

const FLOW_MW_METRICS = [
  "flow_mw",
  "power.flow_mw",
  "net_flow_mw",
  "interconnector.flow_mw",
  "mw",
];

function liveMegawatts(
  cache: StateCache,
  entityId: string,
  candidates: string[],
): number | undefined {
  return (
    cache.getFirstNumber(entityId, candidates) ?? cache.findMegawatts(entityId)
  );
}

// ---------------------------------------------------------------------------
// Icon atlas (runtime canvas — no network, no bundled binaries)
// ---------------------------------------------------------------------------

const ICON = 64;

export const ICON_MAPPING: Record<
  string,
  { x: number; y: number; width: number; height: number; mask: boolean }
> = {
  triangle: { x: 0, y: 0, width: ICON, height: ICON, mask: true },
  square: { x: ICON, y: 0, width: ICON, height: ICON, mask: true },
  diamond: { x: ICON * 2, y: 0, width: ICON, height: ICON, mask: true },
};

let atlasUrl: string | null = null;

/** White shapes on transparent — used as alpha masks and tinted per instance. */
function getIconAtlas(): string {
  if (atlasUrl) return atlasUrl;
  const canvas = document.createElement("canvas");
  canvas.width = ICON * 3;
  canvas.height = ICON;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#ffffff";
  // triangle (points up — rotated per-vessel by heading)
  ctx.beginPath();
  ctx.moveTo(32, 4);
  ctx.lineTo(56, 58);
  ctx.lineTo(32, 46);
  ctx.lineTo(8, 58);
  ctx.closePath();
  ctx.fill();
  // square
  ctx.fillRect(ICON + 14, 14, 36, 36);
  // diamond
  ctx.beginPath();
  ctx.moveTo(ICON * 2 + 32, 6);
  ctx.lineTo(ICON * 2 + 58, 32);
  ctx.lineTo(ICON * 2 + 32, 58);
  ctx.lineTo(ICON * 2 + 6, 32);
  ctx.closePath();
  ctx.fill();
  atlasUrl = canvas.toDataURL("image/png");
  return atlasUrl;
}

// ---------------------------------------------------------------------------
// Grid markers
// ---------------------------------------------------------------------------

export interface GridMarker {
  id: string;
  name: string;
  position: [number, number];
  entity?: EntityRecord;
}

/**
 * Markers for grids/regions. Entities with geometry win; the hardcoded NEM
 * centroids fill in so the globe shows structure even with the API offline.
 */
export function collectGridMarkers(entities: EntityRecord[]): GridMarker[] {
  const markers = new Map<string, GridMarker>();
  for (const [region, position] of Object.entries(NEM_REGION_CENTROIDS)) {
    markers.set(region, { id: `nem-region:${region}`, name: region, position });
  }
  for (const e of entities) {
    if (e.entity_type !== "Grid" && e.entity_type !== "GridRegion") continue;
    const position = pointCoords(e);
    if (!position) continue;
    const regionKey = Object.keys(NEM_REGION_CENTROIDS).find(
      (r) => e.entity_id.includes(r.toLowerCase()) || e.name.includes(r),
    );
    markers.set(regionKey ?? e.entity_id, {
      id: e.entity_id,
      name: e.name,
      position,
      entity: e,
    });
  }
  return [...markers.values()];
}

export function buildGridMarkersLayer(
  markers: GridMarker[],
): ScatterplotLayer<GridMarker> {
  return new ScatterplotLayer<GridMarker>({
    id: "grid-markers",
    data: markers,
    getPosition: (d) => d.position,
    getRadius: 45_000,
    radiusMinPixels: 3,
    radiusMaxPixels: 10,
    filled: true,
    stroked: true,
    getFillColor: [148, 163, 184, 90],
    getLineColor: [203, 213, 225, 190],
    lineWidthMinPixels: 1,
    pickable: true,
  });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function generatorCapacity(e: EntityRecord): number {
  const cap = e.properties?.["capacity_mw"];
  return typeof cap === "number" && cap > 0 ? cap : 0;
}

export function buildGeneratorsLayer(
  generators: EntityRecord[],
  cache: StateCache,
  opts: { minCapacityMw?: number } = {},
): ScatterplotLayer<EntityRecord> {
  const min = opts.minCapacityMw ?? 0;
  const data = generators.filter(
    (e) => pointCoords(e) !== null && generatorCapacity(e) >= min,
  );
  return new ScatterplotLayer<EntityRecord>({
    id: min > 0 ? "generators-major" : "generators",
    data,
    getPosition: (d) => pointCoords(d) ?? [0, 0],
    // radius = sqrt(capacity): area tracks capacity
    getRadius: (d) => Math.sqrt(Math.max(generatorCapacity(d), 1)),
    radiusScale: 500,
    radiusUnits: "meters",
    radiusMinPixels: 2.5,
    radiusMaxPixels: 26,
    filled: true,
    stroked: true,
    lineWidthMinPixels: 1,
    getLineColor: [15, 23, 42, 160],
    getFillColor: (d) => {
      const cap = generatorCapacity(d);
      const mw = liveMegawatts(cache, d.entity_id, GEN_MW_METRICS);
      if (cap <= 0 || mw === undefined) return GREY; // no live state → grey
      return rampColor(mw / cap);
    },
    pickable: true,
    updateTriggers: { getFillColor: cache.version },
  });
}

// ---------------------------------------------------------------------------
// Interconnectors
// ---------------------------------------------------------------------------

interface InterconnectorArc {
  entity: EntityRecord;
  source: [number, number];
  target: [number, number];
}

function regionCentroid(region: unknown): [number, number] | null {
  if (typeof region !== "string") return null;
  return NEM_REGION_CENTROIDS[region.toUpperCase()] ?? null;
}

const FLOW_FORWARD: Color = [56, 189, 248, 210]; // cyan: from → to
const FLOW_REVERSE: Color = [251, 146, 60, 210]; // amber: to → from
const FLOW_NONE: Color = [100, 116, 139, 130];

export function buildInterconnectorsLayer(
  interconnectors: EntityRecord[],
  cache: StateCache,
): ArcLayer<InterconnectorArc> {
  const data: InterconnectorArc[] = [];
  for (const e of interconnectors) {
    const source = regionCentroid(e.properties?.["from_region"]);
    const target = regionCentroid(e.properties?.["to_region"]);
    if (source && target) data.push({ entity: e, source, target });
  }
  const flowOf = (d: InterconnectorArc): number =>
    liveMegawatts(cache, d.entity.entity_id, FLOW_MW_METRICS) ?? 0;
  return new ArcLayer<InterconnectorArc>({
    id: "interconnectors",
    data,
    getSourcePosition: (d) => d.source,
    getTargetPosition: (d) => d.target,
    getHeight: 0.35,
    greatCircle: false,
    // width by |flow|; a slim structural arc when no live flow
    getWidth: (d) => {
      const mw = Math.abs(flowOf(d));
      return mw > 0 ? Math.max(1.5, Math.sqrt(mw) / 3) : 1.2;
    },
    widthUnits: "pixels",
    widthMinPixels: 1,
    widthMaxPixels: 14,
    getSourceColor: (d) => {
      const mw = flowOf(d);
      if (mw === 0) return FLOW_NONE;
      return mw > 0 ? FLOW_FORWARD : FLOW_REVERSE;
    },
    getTargetColor: (d) => {
      const mw = flowOf(d);
      if (mw === 0) return FLOW_NONE;
      // brighter head at the receiving end of the flow direction
      return mw > 0
        ? [186, 230, 253, 235]
        : [254, 215, 170, 235];
    },
    pickable: true,
    updateTriggers: {
      getWidth: cache.version,
      getSourceColor: cache.version,
      getTargetColor: cache.version,
    },
  });
}

// ---------------------------------------------------------------------------
// Vessels
// ---------------------------------------------------------------------------

const VESSEL_COLOR: Color = [192, 132, 252, 240]; // violet — distinct at sea

export function buildVesselsLayer(
  vessels: EntityRecord[],
  cache: StateCache,
): IconLayer<EntityRecord> {
  const data = vessels.filter(
    (e) =>
      pointCoords(e) !== null ||
      cache.getVesselPosition(e.entity_id) !== undefined,
  );
  return new IconLayer<EntityRecord>({
    id: "vessels",
    data,
    iconAtlas: getIconAtlas(),
    iconMapping: ICON_MAPPING,
    getIcon: () => "triangle",
    // live position from vessel.position state beats structural geometry
    getPosition: (d) => {
      const live = cache.getVesselPosition(d.entity_id);
      if (live) return [live.lon, live.lat];
      return pointCoords(d) ?? [0, 0];
    },
    // deck angles are CCW degrees; compass heading is CW from north
    getAngle: (d) => {
      const heading = cache.getVesselPosition(d.entity_id)?.heading_deg;
      return typeof heading === "number" ? -heading : 0;
    },
    getSize: 20,
    sizeUnits: "pixels",
    getColor: VESSEL_COLOR,
    pickable: true, // hover tooltip labels the vessel by name
    updateTriggers: { getPosition: cache.version, getAngle: cache.version },
  });
}

// ---------------------------------------------------------------------------
// Observability gaps — first-class visual: pulsing unfilled rings
// ---------------------------------------------------------------------------

export interface GapMarker {
  gap: ObservabilityGapRecord;
  entity: EntityRecord;
  position: [number, number];
}

export function collectGapMarkers(
  gaps: ObservabilityGapRecord[],
  entityById: Map<string, EntityRecord>,
): GapMarker[] {
  const markers: GapMarker[] = [];
  for (const gap of gaps) {
    const entity = entityById.get(gap.entity_id);
    if (!entity) continue;
    const position = pointCoords(entity);
    if (!position) continue;
    markers.push({ gap, entity, position });
  }
  return markers;
}

const GAP_PRIORITY_COLOR: Record<string, Color> = {
  P1: [248, 113, 113, 235],
  P2: [251, 146, 60, 230],
  P3: [251, 191, 36, 220],
  P4: [148, 163, 184, 200],
};

/**
 * @param pulse 0..1 phase — radius breathes with it (time-based modulation,
 *        driven by the animation ticker in main.ts).
 */
export function buildGapsLayer(
  markers: GapMarker[],
  pulse: number,
): ScatterplotLayer<GapMarker> {
  const breathe = 1 + 0.4 * Math.sin(pulse * Math.PI * 2);
  return new ScatterplotLayer<GapMarker>({
    id: "observability-gaps",
    data: markers,
    getPosition: (d) => d.position,
    getRadius: 9_000,
    radiusScale: breathe, // uniform-only change per tick — cheap
    radiusMinPixels: 6 * breathe,
    radiusMaxPixels: 34,
    filled: false, // ring style: stroked, unfilled
    stroked: true,
    getLineColor: (d) => GAP_PRIORITY_COLOR[d.gap.priority] ?? GAP_PRIORITY_COLOR["P4"] ?? GREY,
    lineWidthMinPixels: 2,
    getLineWidth: 2,
    lineWidthUnits: "pixels",
    pickable: true,
  });
}

// ---------------------------------------------------------------------------
// Other facilities — small squares/diamonds coloured by entity_type
// ---------------------------------------------------------------------------

export const FACILITY_TYPES: ReadonlySet<string> = new Set([
  "Smelter",
  "SteelMill",
  "Mine",
  "CoalMine",
  "Refinery",
  "LNGPlant",
  "ChemicalPlant",
  "DataCentre",
  "Port",
  "Terminal",
  "Berth",
  "GasProcessingPlant",
  "GasField",
  "HydroReservoir",
  "IndustrialFacility",
  "Substation",
  "StorageAsset",
]);

const FACILITY_COLORS: Record<string, Color> = {
  Smelter: [251, 113, 133, 235], // rose
  SteelMill: [244, 114, 182, 235],
  Mine: [217, 119, 6, 235], // ochre
  CoalMine: [161, 98, 7, 235],
  Refinery: [234, 179, 8, 235],
  LNGPlant: [45, 212, 191, 235], // teal
  GasProcessingPlant: [20, 184, 166, 235],
  GasField: [13, 148, 136, 235],
  ChemicalPlant: [163, 230, 53, 235],
  DataCentre: [96, 165, 250, 235],
  Port: [125, 211, 252, 235], // light blue
  Terminal: [56, 189, 248, 235],
  Berth: [2, 132, 199, 235],
  HydroReservoir: [59, 130, 246, 235],
  IndustrialFacility: [216, 180, 254, 235],
  Substation: [148, 163, 184, 235],
  StorageAsset: [134, 239, 172, 235],
};

/** Ports/terminals/berths get diamonds; everything else squares. */
const DIAMOND_TYPES = new Set(["Port", "Terminal", "Berth"]);

export function buildFacilitiesLayer(
  facilities: EntityRecord[],
): IconLayer<EntityRecord> {
  const data = facilities.filter((e) => pointCoords(e) !== null);
  return new IconLayer<EntityRecord>({
    id: "facilities",
    data,
    iconAtlas: getIconAtlas(),
    iconMapping: ICON_MAPPING,
    getIcon: (d) => (DIAMOND_TYPES.has(d.entity_type) ? "diamond" : "square"),
    getPosition: (d) => pointCoords(d) ?? [0, 0],
    getSize: 13,
    sizeUnits: "pixels",
    getColor: (d) => FACILITY_COLORS[d.entity_type] ?? [203, 213, 225, 220],
    pickable: true,
  });
}
