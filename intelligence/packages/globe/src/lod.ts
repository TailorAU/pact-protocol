// Zoom-gated layer sets.
//
//   global      z < 2.5   land + grid markers + interconnector arcs
//   continental 2.5–4.5   + major generators (>500 MW)
//   regional    4.5–8     + all facilities, vessels, gap rings (Gladstone scene)
//   facility    z > 8     same scene; entity click opens the SDUI side panel

import type { LayersList } from "@deck.gl/core";
import { buildLandLayer, buildOceanLayer } from "./basemap.js";
import {
  buildFacilitiesLayer,
  buildGapsLayer,
  buildGeneratorsLayer,
  buildGridMarkersLayer,
  buildInterconnectorsLayer,
  buildVesselsLayer,
  collectGapMarkers,
  collectGridMarkers,
  FACILITY_TYPES,
} from "./layers.js";
import type { StateCache } from "./state-cache.js";
import type { EntityRecord, ObservabilityGapRecord } from "./types.js";

export type LodTier = "global" | "continental" | "regional" | "facility";

export const MAJOR_GENERATOR_MW = 500;

export function tierForZoom(zoom: number): LodTier {
  if (zoom < 2.5) return "global";
  if (zoom < 4.5) return "continental";
  if (zoom <= 8) return "regional";
  return "facility";
}

export interface Scene {
  entities: EntityRecord[];
  gaps: ObservabilityGapRecord[];
  entityById: Map<string, EntityRecord>;
}

export function buildScene(
  entities: EntityRecord[],
  gaps: ObservabilityGapRecord[],
): Scene {
  return {
    entities,
    gaps,
    entityById: new Map(entities.map((e) => [e.entity_id, e])),
  };
}

export function buildLayers(
  tier: LodTier,
  scene: Scene,
  cache: StateCache,
  pulse: number,
): LayersList {
  const generators = scene.entities.filter(
    (e) => e.entity_type === "Generator",
  );
  const interconnectors = scene.entities.filter(
    (e) => e.entity_type === "Interconnector",
  );

  const layers: LayersList = [
    buildOceanLayer(),
    buildLandLayer(),
    buildGridMarkersLayer(collectGridMarkers(scene.entities)),
    buildInterconnectorsLayer(interconnectors, cache),
  ];

  if (tier === "continental") {
    layers.push(
      buildGeneratorsLayer(generators, cache, {
        minCapacityMw: MAJOR_GENERATOR_MW,
      }),
    );
  }

  if (tier === "regional" || tier === "facility") {
    const vessels = scene.entities.filter((e) => e.entity_type === "Vessel");
    const facilities = scene.entities.filter((e) =>
      FACILITY_TYPES.has(e.entity_type),
    );
    layers.push(
      buildGeneratorsLayer(generators, cache),
      buildFacilitiesLayer(facilities),
      buildVesselsLayer(vessels, cache),
      buildGapsLayer(collectGapMarkers(scene.gaps, scene.entityById), pulse),
    );
  }

  return layers;
}
