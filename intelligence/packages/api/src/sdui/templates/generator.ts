// Generator template — current MW output and the upstream fuel chain.
import type { SduiPanel } from "@pact-tailor/ontology";
import { graphNeighborhood, headlineState, inferenceList, timeseries } from "./shared.js";

export function generatorTemplate(id: string): SduiPanel[] {
  return [
    headlineState(id),
    timeseries(id, "power.output.mw"),
    graphNeighborhood(id, { depth: 2, direction: "upstream" }),
    inferenceList(id),
  ];
}
