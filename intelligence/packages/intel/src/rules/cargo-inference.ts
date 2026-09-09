// cargo-inference@1.0.0 — infer the probable cargo of a vessel from where it
// loads. STRICT precondition: the vessel must have a LOADS_AT edge to a
// Terminal — vessels without one are NEVER speculated about.
//
// Commodity candidates for the terminal, in order of preference:
//   - terminal.properties.commodities (declared string list), else
//   - the `properties.commodity` of incoming TRANSPORTS edges.
// One inference per candidate commodity. A single-commodity terminal gives
// confidence 0.85; a multi-commodity terminal 0.6 per candidate. Multi-hop
// (vessel → terminal → commodity) → tier C.
import type { InferenceRecord, RelationshipRecord } from "@pact-tailor/ontology";
import { addSource, methodOf, type IntelRule, type RuleContext } from "./types.js";

const NAME = "cargo-inference";
const VERSION = "1.0.0";

interface Candidate {
  commodity: string;
  /** TRANSPORTS edge the commodity came from, when not declared on the terminal. */
  via: RelationshipRecord | null;
}

function terminalCommodities(ctx: RuleContext, terminalId: string): Candidate[] {
  const terminal = ctx.graph.node(terminalId);
  if (!terminal) return [];
  const props = (terminal.properties ?? {}) as Record<string, unknown>;
  const declared = props["commodities"];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  if (Array.isArray(declared)) {
    for (const c of declared) {
      if (typeof c === "string" && c.length > 0 && !seen.has(c)) {
        seen.add(c);
        out.push({ commodity: c, via: null });
      }
    }
  }
  if (out.length === 0) {
    for (const step of ctx.graph.neighbors(terminalId, { direction: "in", relTypes: ["TRANSPORTS"] })) {
      const commodity = (step.rel.properties ?? {})["commodity"];
      if (typeof commodity === "string" && commodity.length > 0 && !seen.has(commodity)) {
        seen.add(commodity);
        out.push({ commodity, via: step.rel });
      }
    }
  }
  return out.sort((a, b) => a.commodity.localeCompare(b.commodity));
}

export const cargoInference: IntelRule = {
  name: NAME,
  version: VERSION,
  run(ctx: RuleContext): InferenceRecord[] {
    const out: InferenceRecord[] = [];
    for (const vessel of ctx.graph.allNodes()) {
      if (vessel.entity_type !== "Vessel") continue;
      // Only LOADS_AT edges that point at a Terminal count. No edge → no claim.
      const loadEdges = ctx.graph
        .neighbors(vessel.entity_id, { direction: "out", relTypes: ["LOADS_AT"] })
        .filter((step) => ctx.graph.node(step.to)?.entity_type === "Terminal");
      if (loadEdges.length === 0) continue;

      const positionState = ctx.state.current(vessel.entity_id, "vessel.position")[0];

      for (const step of loadEdges) {
        const terminal = ctx.graph.node(step.to);
        if (!terminal) continue;
        const candidates = terminalCommodities(ctx, step.to);
        if (candidates.length === 0) continue; // nothing known about the terminal's cargo
        const confidence = candidates.length === 1 ? 0.85 : 0.6;

        for (const candidate of candidates) {
          const evidence: InferenceRecord["evidence"] = [
            { kind: "structural", ref: step.rel.rel_id, role: "supports" },
          ];
          if (candidate.via) evidence.push({ kind: "structural", ref: candidate.via.rel_id, role: "supports" });
          if (positionState !== undefined) {
            evidence.push({ kind: "observation", ref: positionState.observation_id, role: "supports" });
          }

          const sources: string[] = [];
          addSource(sources, step.rel.source);
          if (candidate.via) addSource(sources, candidate.via.source);
          if (positionState !== undefined) addSource(sources, positionState.source_id);

          out.push({
            inference_id: ctx.mintId(NAME),
            claim: `${vessel.name} probably carries ${candidate.commodity} (loads at ${terminal.name})`,
            claim_structured: {
              subject: vessel.entity_id,
              predicate: "carries",
              object: candidate.commodity,
              qualifiers: {
                terminal: terminal.entity_id,
                candidate_count: candidates.length,
              },
            },
            tier: "C",
            confidence,
            status: "INFERRED",
            method: methodOf(this),
            evidence,
            contrary_evidence: [],
            sources,
            produced_at: ctx.now(),
          });
        }
      }
    }
    return out;
  },
};
