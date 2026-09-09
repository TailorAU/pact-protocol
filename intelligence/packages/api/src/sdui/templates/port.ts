// Port template — headline, downstream trade neighborhood, gaps, inferences.
import type { SduiPanel } from "@pact-tailor/ontology";
import { gapCard, graphNeighborhood, headlineState, inferenceList } from "./shared.js";

export function portTemplate(id: string): SduiPanel[] {
  return [
    headlineState(id),
    graphNeighborhood(id, { depth: 2 }),
    gapCard(id),
    inferenceList(id),
  ];
}
