// Shared panel builders for the SDUI type templates. Panels reference
// ENDPOINTS only — never inline data values — so what the client renders is
// always the API's provenance-tagged truth at fetch time.
import type { SduiPanel } from "@pact-tailor/ontology";

export function headlineState(id: string): SduiPanel {
  return { panel: "headline-state", data: { endpoint: `/api/intel/entities/${id}/state` } };
}

export function timeseries(id: string, metric: string, window = "24h"): SduiPanel {
  return {
    panel: "timeseries",
    props: { metric, window },
    data: { endpoint: `/api/intel/entities/${id}/observations?metric=${metric}` },
  };
}

export function gapCard(id: string): SduiPanel {
  return { panel: "gap-card", data: { endpoint: `/api/intel/gaps?entity=${id}` } };
}

export function graphNeighborhood(id: string, props: Record<string, unknown> = { depth: 2 }): SduiPanel {
  const depth = typeof props["depth"] === "number" ? props["depth"] : 2;
  const direction = typeof props["direction"] === "string" ? `&direction=${props["direction"]}` : "";
  return {
    panel: "graph-neighborhood",
    props,
    data: { endpoint: `/api/intel/entities/${id}/graph?depth=${depth}${direction}` },
  };
}

export function inferenceList(id: string): SduiPanel {
  return { panel: "inference-list", data: { endpoint: `/api/intel/inferences?entity=${id}` } };
}
