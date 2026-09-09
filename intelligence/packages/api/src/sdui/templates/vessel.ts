// Vessel template — position/speed headline, track, cargo status. Reported
// cargo (observations) and inferred cargo (inference-list) are separate
// panels so the two are visibly distinct in the client.
import type { SduiPanel } from "@pact-tailor/ontology";
import { graphNeighborhood, headlineState, inferenceList } from "./shared.js";

export function vesselTemplate(id: string): SduiPanel[] {
  return [
    headlineState(id),
    {
      panel: "vessel-track",
      props: { metric: "vessel.position", window: "48h" },
      data: { endpoint: `/api/intel/entities/${id}/observations?metric=vessel.position` },
    },
    graphNeighborhood(id, { depth: 2 }),
    inferenceList(id),
  ];
}
