// Smelter template — mirrors the worked example in docs/SDUI.md: headline,
// estimated-load timeseries, gap card, neighborhood, inferences.
import type { SduiPanel } from "@pact-tailor/ontology";
import { gapCard, graphNeighborhood, headlineState, inferenceList, timeseries } from "./shared.js";

export function smelterTemplate(id: string): SduiPanel[] {
  return [
    headlineState(id),
    timeseries(id, "power.load.estimated_mw"),
    gapCard(id),
    graphNeighborhood(id),
    inferenceList(id),
  ];
}
