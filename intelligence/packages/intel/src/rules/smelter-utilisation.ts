// smelter-utilisation@1.0.0 — estimate the live electrical load of smelters
// whose state we cannot observe directly (observability ESTIMATED), using the
// grid region's live demand as the activity proxy and the smelter's declared
// typical load as the magnitude.
//
// Region resolution heuristic (documented, simplest-first):
//   1. If the smelter's grid_id points directly at a GridRegion node, use it.
//   2. Else, if a Generator SUPPLIES the smelter and that generator's grid_id
//      points at a GridRegion, use that region.
//   3. Else, among GridRegion nodes whose grid_id equals the smelter's grid_id
//      and which hold live grid.demand.mw state, use the first by entity_id.
//
// The emitted estimate is the smelter's properties.typical_load_mw (declared
// structural knowledge); the region demand observation is the evidence that
// the region is live and the proxy through which the estimate is derived.
// Single-hop derivation from a strong proxy → tier B.
import type { EntityRecord, InferenceRecord } from "@pact-tailor/ontology";
import type { RelationshipRecord } from "@pact-tailor/ontology";
import { addSource, methodOf, type IntelRule, type RuleContext } from "./types.js";

const NAME = "smelter-utilisation";
const VERSION = "1.0.0";

/** Confidence: base 0.6, +0.15 when a structural SUPPLIES edge ties the smelter to its supply chain. */
function score(hasSupplyEdge: boolean): number {
  return hasSupplyEdge ? 0.75 : 0.6;
}

function resolveRegion(ctx: RuleContext, smelter: EntityRecord): EntityRecord | null {
  // 1. grid_id is itself a region.
  if (smelter.grid_id) {
    const direct = ctx.graph.node(smelter.grid_id);
    if (direct && direct.entity_type === "GridRegion") return direct;
  }
  // 2. via a Generator that SUPPLIES the smelter.
  for (const step of ctx.graph.neighbors(smelter.entity_id, { direction: "in", relTypes: ["SUPPLIES"] })) {
    const generator = ctx.graph.node(step.from);
    if (generator?.entity_type !== "Generator" || !generator.grid_id) continue;
    const region = ctx.graph.node(generator.grid_id);
    if (region && region.entity_type === "GridRegion") return region;
  }
  // 3. first GridRegion child of the smelter's grid that has live demand state.
  if (smelter.grid_id) {
    const candidates = ctx.graph
      .allNodes()
      .filter(
        (n) =>
          n.entity_type === "GridRegion" &&
          n.grid_id === smelter.grid_id &&
          ctx.state.current(n.entity_id, "grid.demand.mw").length > 0,
      )
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    if (candidates[0] !== undefined) return candidates[0];
  }
  return null;
}

function suppliesEdge(ctx: RuleContext, smelterId: string): RelationshipRecord | null {
  for (const step of ctx.graph.neighbors(smelterId, { direction: "in", relTypes: ["SUPPLIES"] })) {
    if (ctx.graph.node(step.from)?.entity_type === "Generator") return step.rel;
  }
  return null;
}

export const smelterUtilisation: IntelRule = {
  name: NAME,
  version: VERSION,
  run(ctx: RuleContext): InferenceRecord[] {
    const out: InferenceRecord[] = [];
    for (const entity of ctx.graph.allNodes()) {
      if (entity.entity_type !== "Smelter" || entity.observability !== "ESTIMATED") continue;

      const props = (entity.properties ?? {}) as Record<string, unknown>;
      const typicalLoad = props["typical_load_mw"];
      if (typeof typicalLoad !== "number" || !Number.isFinite(typicalLoad)) continue; // no declared share — skip

      const region = resolveRegion(ctx, entity);
      if (!region) continue;
      const demandState = ctx.state.current(region.entity_id, "grid.demand.mw")[0];
      if (demandState === undefined) continue; // no live proxy — nothing honest to say

      const edge = suppliesEdge(ctx, entity.entity_id);
      const evidence: InferenceRecord["evidence"] = [
        { kind: "observation", ref: demandState.observation_id, role: "supports" },
      ];
      if (edge) evidence.push({ kind: "structural", ref: edge.rel_id, role: "supports" });

      const sources: string[] = [];
      addSource(sources, demandState.source_id);
      if (edge) addSource(sources, edge.source);

      out.push({
        inference_id: ctx.mintId(NAME),
        claim: `${entity.name}: estimated live load ≈ ${typicalLoad} MW (declared typical load; ${region.name} demand live at ${demandState.value} MW)`,
        claim_structured: {
          subject: entity.entity_id,
          predicate: "has_estimated_load_mw",
          object: String(typicalLoad),
          qualifiers: {
            unit: "MW",
            proxy_region: region.entity_id,
            proxy_metric: "grid.demand.mw",
            proxy_value: demandState.value,
          },
        },
        tier: "B",
        confidence: score(edge !== null),
        status: "INFERRED",
        method: methodOf(this),
        evidence,
        sources,
        produced_at: ctx.now(),
        event_time_range: { from: demandState.event_time, to: demandState.event_time },
      });
    }
    return out;
  },
};
