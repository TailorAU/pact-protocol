// Default template — for entity types without a bespoke layout.
import type { SduiPanel } from "@pact-tailor/ontology";
import { graphNeighborhood, headlineState, inferenceList } from "./shared.js";

export function defaultTemplate(id: string): SduiPanel[] {
  return [headlineState(id), graphNeighborhood(id), inferenceList(id)];
}
