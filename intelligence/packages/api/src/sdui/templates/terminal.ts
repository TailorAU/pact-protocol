// Terminal template — throughput, gaps, upstream commodity chain, inferences.
import type { SduiPanel } from "@pact-tailor/ontology";
import { gapCard, graphNeighborhood, headlineState, inferenceList, timeseries } from "./shared.js";

export function terminalTemplate(id: string): SduiPanel[] {
  return [
    headlineState(id),
    timeseries(id, "production.rate.tph"),
    gapCard(id),
    graphNeighborhood(id, { depth: 2, direction: "upstream" }),
    inferenceList(id),
  ];
}
