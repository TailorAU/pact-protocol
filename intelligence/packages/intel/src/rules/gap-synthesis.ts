// gap-synthesis@1.0.0 — find entities that SHOULD have an observability-gap
// record but don't: observability ESTIMATED or NOT_OBSERVABLE, no gap record
// in the loaded registry, and an entity type we know the keystone metric for.
// The emitted inferences feed the gap-registry review loop (a human or a
// downstream process turns accepted ones into real gap records).
//
// Multi-hop editorial claim about our own observability posture → tier C.
import type { EntityType, InferenceRecord } from "@pact-tailor/ontology";
import { methodOf, type IntelRule, type RuleContext } from "./types.js";

const NAME = "gap-synthesis";
const VERSION = "1.0.0";

/** Entity types with a well-known keystone live metric. Others are skipped. */
export const SUGGESTED_METRIC: Partial<Record<EntityType, string>> = {
  Smelter: "power.load.mw",
  Terminal: "production.rate.tph",
  Mine: "production.rate.tph",
  LNGPlant: "production.rate.tph",
  DataCentre: "power.load.mw",
};

export const gapSynthesis: IntelRule = {
  name: NAME,
  version: VERSION,
  run(ctx: RuleContext): InferenceRecord[] {
    const covered = new Set(ctx.gaps.map((g) => g.entity_id));
    const out: InferenceRecord[] = [];
    for (const entity of ctx.graph.allNodes()) {
      if (entity.observability !== "ESTIMATED" && entity.observability !== "NOT_OBSERVABLE") continue;
      if (covered.has(entity.entity_id)) continue;
      const metric = SUGGESTED_METRIC[entity.entity_type];
      if (metric === undefined) continue;
      if (entity.sources.length === 0) continue; // cannot cite a source — skip honestly

      out.push({
        inference_id: ctx.mintId(NAME),
        claim: `observability gap: ${entity.name} lacks live ${metric}`,
        claim_structured: {
          subject: entity.entity_id,
          predicate: "lacks_live_metric",
          object: metric,
          qualifiers: { observability: entity.observability, entity_type: entity.entity_type },
        },
        tier: "C",
        confidence: 0.9,
        status: "INFERRED",
        method: methodOf(this),
        evidence: [{ kind: "structural", ref: entity.entity_id, role: "supports" }],
        sources: [...entity.sources],
        produced_at: ctx.now(),
      });
    }
    return out;
  },
};
