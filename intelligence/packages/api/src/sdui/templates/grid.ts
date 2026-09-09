// Grid / GridRegion template — leads with load, generation, price and flows.
import type { SduiPanel } from "@pact-tailor/ontology";
import { graphNeighborhood, headlineState, inferenceList, timeseries } from "./shared.js";

export function gridTemplate(id: string): SduiPanel[] {
  return [
    headlineState(id),
    timeseries(id, "grid.demand.mw"),
    { panel: "price-strip", data: { endpoint: `/api/intel/entities/${id}/observations?metric=market.price.energy` } },
    { panel: "fuel-mix", data: { endpoint: `/api/intel/entities/${id}/observations?metric=grid.generation.fuel_mix` } },
    { panel: "flow-arcs", data: { endpoint: `/api/intel/grids/${id}/summary` } },
    graphNeighborhood(id),
    inferenceList(id),
  ];
}
