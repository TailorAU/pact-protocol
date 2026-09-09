// Bundled basemap: simplified land-outline GeoJSON committed under assets/,
// rendered as a dim GeoJsonLayer plus a solid "ocean" sphere backdrop so the
// globe reads against the space background with zero external requests.

import { GeoJsonLayer, SolidPolygonLayer } from "@deck.gl/layers";
import type { FeatureCollection } from "geojson";
import landRaw from "../assets/ne_110m_land.geojson?raw";

export const LAND: FeatureCollection = JSON.parse(landRaw) as FeatureCollection;

/** Whole-world polygon — renders as the ocean sphere under _GlobeView. */
const WORLD: [number, number][][] = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

export function buildOceanLayer(): SolidPolygonLayer<[number, number][]> {
  return new SolidPolygonLayer<[number, number][]>({
    id: "ocean-sphere",
    data: WORLD,
    getPolygon: (d) => d,
    filled: true,
    getFillColor: [8, 14, 30, 255],
    pickable: false,
  });
}

export function buildLandLayer(): GeoJsonLayer {
  return new GeoJsonLayer({
    id: "basemap-land",
    data: LAND,
    filled: true,
    stroked: true,
    getFillColor: [30, 41, 59, 235],
    getLineColor: [71, 85, 105, 180],
    getLineWidth: 1,
    lineWidthUnits: "pixels",
    lineWidthMinPixels: 1,
    pickable: false,
  });
}
