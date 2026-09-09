// Mine template — production rate, gaps, downstream transport chain, inferences.
import type { SduiPanel } from "@pact-tailor/ontology";
import { gapCard, graphNeighborhood, headlineState, inferenceList, timeseries } from "./shared.js";

export function mineTemplate(id: string): SduiPanel[] {
  return [
    headlineState(id),
    timeseries(id, "production.rate.tph"),
    gapCard(id),
    graphNeighborhood(id, { depth: 2, direction: "downstream" }),
    inferenceList(id),
  ];
}
