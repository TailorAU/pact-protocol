// fact-mapper — InferenceRecord ⇄ PACT `fact`-type proposal mapping.
//
// Implements the total, lossless-degradation mapping of the RFC
// (docs/v2-prep/rfc-intelligence-fact-evidence-extension.md §3): an
// `au.tailor.intel.claim` inference envelope degrades to the built-in
// `fact` proposal payload { claim, evidence, tier, sources } with nothing
// dropped — evidence and contrary evidence travel together, each item
// keeping its `role`, so counter-evidence survives the round trip.

import type { EvidenceRef, InferenceRecord } from "@pact-tailor/ontology";

/** A PACT proposal carrying a `fact`-type payload derived from an inference. */
export interface FactProposal {
  /** Field grammar of the fact type: `claim:{inference_id}`. */
  sectionId: string;
  /** The human-readable claim sentence plus its confidence. */
  summary: string;
  /** Built-in `fact` proposal payload — { claim, evidence, tier, sources }. */
  payload: {
    claim: string;
    evidence: unknown[];
    tier: string;
    sources: string[];
  };
}

/**
 * Map an InferenceRecord to a built-in `fact`-type proposal (RFC §3).
 *
 * - `sectionId` = `claim:${inference_id}` (the fact type's field grammar).
 * - `payload.evidence` = evidence ∪ contrary_evidence, verbatim — every item
 *   keeps its `role` ("supports" | "contradicts") so contrary evidence is
 *   never lost in the degradation.
 * - `summary` = the claim sentence + confidence.
 *
 * The mapping is total: every inference maps; nothing epistemically
 * significant is dropped.
 */
export function toFactProposal(inference: InferenceRecord): FactProposal {
  const evidence: EvidenceRef[] = [
    ...inference.evidence.map((e) => ({ ...e })),
    ...(inference.contrary_evidence ?? []).map((e) => ({ ...e })),
  ];
  return {
    sectionId: `claim:${inference.inference_id}`,
    summary: `${inference.claim} (confidence ${inference.confidence})`,
    payload: {
      claim: inference.claim,
      evidence,
      tier: inference.tier,
      sources: [...inference.sources],
    },
  };
}

/**
 * Fold a PACT proposal outcome back into the inference lifecycle.
 *
 * Returns a NEW record (append-only stance — the input is never mutated;
 * a status change is a new revision, never an in-place edit that loses the
 * contested history):
 *
 * - `"approved"` → status `CORROBORATED`
 * - `"rejected"` → status `CONTESTED`
 *
 * The PACT backref (`{ fabric_id, proposal_id }`) is filled from the `pact`
 * argument, merged over any backref already on the record. All evidence and
 * contrary-evidence arrays are retained verbatim.
 */
export function fromProposalOutcome(
  inference: InferenceRecord,
  outcome: "approved" | "rejected",
  pact?: { fabric_id?: string; proposal_id?: string },
): InferenceRecord {
  const next = structuredClone(inference);
  next.status = outcome === "approved" ? "CORROBORATED" : "CONTESTED";
  if (pact !== undefined || (inference.pact !== undefined && inference.pact !== null)) {
    next.pact = { ...(inference.pact ?? {}), ...(pact ?? {}) };
  }
  return next;
}
