// Rule contract for @pact-tailor/intel. A rule is a pure, deterministic,
// versioned function over the knowledge graph + real-time state. It emits
// evidence-linked InferenceRecords (class C) and NOTHING else — no state
// mutation, no graph mutation, no I/O.
//
// Honesty invariants (enforced by the engine's schema validation and by
// convention here):
//   - `method` is always `rule:${name}@${version}` — reproducible provenance.
//   - Every evidence ref points at a REAL id: an observation_id held in state
//     history, a rel_id / entity_id present in the graph. Rules never mint
//     fresh ULIDs to use as evidence (`newUlidRefs?: never` documents this —
//     there is no facility in the context for making up references).
import type { InferenceRecord, ObservabilityGapRecord } from "@pact-tailor/ontology";
import type { KnowledgeGraph } from "@pact-tailor/graph";
import type { StateEngine } from "@pact-tailor/state";

export interface RuleContext {
  graph: KnowledgeGraph;
  state: StateEngine;
  /** Observability-gap registry records, loaded once at boot (read-only). */
  gaps: readonly ObservabilityGapRecord[];
  /** The rule run's single timestamp — every record in one run shares it. */
  now(): string;
  /**
   * Mint the next inference_id for this run:
   * `infer:${now().slice(0, 10)}:${slug}-${n}` with an engine-scoped counter,
   * so ids stay unique across repeated runs on the same day.
   */
  mintId(slug: string): string;
  /** Rules must not fabricate evidence refs — see module header. */
  newUlidRefs?: never;
}

export interface IntelRule {
  name: string;
  version: string;
  run(ctx: RuleContext): InferenceRecord[];
}

/** `rule:${name}@${version}` — the method string for a rule's records. */
export function methodOf(rule: Pick<IntelRule, "name" | "version">): string {
  return `rule:${rule.name}@${rule.version}`;
}

/** Deduplicating push helper for source id lists (order-preserving). */
export function addSource(sources: string[], id: string | undefined): void {
  if (id !== undefined && id.length > 0 && !sources.includes(id)) sources.push(id);
}
