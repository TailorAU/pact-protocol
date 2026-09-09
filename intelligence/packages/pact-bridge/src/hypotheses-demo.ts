// The Gladstone competing-hypotheses demo (RFC §5, implemented).
//
// A vessel is loading at Gladstone's RG Tanna coal terminal. Two rule agents
// derive competing cargo hypotheses for the same vessel:
//
//   Agent A ("cargo-inference-a")  — metallurgical coal, confidence 0.91,
//     citing AIS berth-arrival + draught-change observations and a structural
//     terminal-supply edge.
//   Agent B ("schedule-checker-b") — thermal coal, confidence 0.34, citing a
//     contrary shipping-schedule observation; its contrary_evidence cites the
//     met-coal hypothesis' own supporting observation and the met-coal
//     inference itself.
//
// Both publish into a fresh PACT fabric as `fact`-type proposals. A third
// agent ("resolver-c") approves A's proposal; A objects to B's (a blocking
// objection rejects it per §10.5). The outcomes fold back into the inference
// lifecycle: A's record becomes CORROBORATED, B's becomes CONTESTED — both as
// NEW records (append-only) retaining every evidence and contrary-evidence
// item, with the PACT backref filled.
//
// All data is synthetic and clearly marked so: vessel:imo:9000001 is not a
// real ship, timestamps are fixed constants.

import { createValidators, type InferenceRecord } from "@pact-tailor/ontology";
import { toFactProposal, fromProposalOutcome } from "./fact-mapper.js";
import { PactClient, type FabricStatus } from "./client.js";

export interface DemoResult {
  /** Agent A's met-coal inference after consensus — status CORROBORATED. */
  corroborated: InferenceRecord;
  /** Agent B's thermal-coal inference after consensus — status CONTESTED. */
  contested: InferenceRecord;
  /** Final fabric _status snapshot (0 open proposals once resolved). */
  fabricStatus: FabricStatus;
}

// Fixed synthetic constants — deterministic records, clearly not real data.
const PRODUCED_AT = "2026-08-12T03:15:00Z";
const EVENT_FROM = "2026-08-12T01:00:00Z";
const EVENT_TO = "2026-08-12T03:10:00Z";
const VESSEL = "vessel:imo:9000001";
const TERMINAL = "terminal:au-qld:rg-tanna";

const MET_COAL_ID = "infer:2026-08-12:gladstone-met-coal";
const THERMAL_ID = "infer:2026-08-12:gladstone-thermal-coal";

// Synthetic evidence refs shared between the two hypotheses.
const OBS_BERTH_ARRIVAL = "obs:demo:ais-berth-arrival-rg-tanna-b1";
const OBS_DRAUGHT_CHANGE = "obs:demo:draught-increase-9000001";
const REL_SUPPLY_EDGE = "rel:rg-tanna-supplies-met-coal";
const OBS_SCHEDULE_THERMAL = "obs:demo:shipping-schedule-thermal-9000001";

/**
 * Build the two competing InferenceRecords, both status INFERRED.
 * Exported so tests can exercise the mapper against the same fixtures.
 */
export function buildGladstoneHypotheses(): {
  metCoal: InferenceRecord;
  thermal: InferenceRecord;
} {
  const metCoal: InferenceRecord = {
    inference_id: MET_COAL_ID,
    claim:
      "Vessel IMO 9000001, loading at RG Tanna terminal (Gladstone), is loading metallurgical coal.",
    claim_structured: {
      subject: VESSEL,
      predicate: "carries",
      object: "commodity:coal-metallurgical",
      qualifiers: { loading_at: TERMINAL, synthetic: true },
    },
    tier: "B",
    confidence: 0.91,
    status: "INFERRED",
    method: "rule:cargo-inference@1.0.0",
    evidence: [
      { kind: "observation", ref: OBS_BERTH_ARRIVAL, role: "supports" },
      { kind: "observation", ref: OBS_DRAUGHT_CHANGE, role: "supports" },
      { kind: "structural", ref: REL_SUPPLY_EDGE, role: "supports" },
    ],
    contrary_evidence: [
      { kind: "observation", ref: OBS_SCHEDULE_THERMAL, role: "contradicts" },
    ],
    sources: ["source:ais:aisstream", "source:demo:gladstone-berth-registry"],
    produced_at: PRODUCED_AT,
    event_time_range: { from: EVENT_FROM, to: EVENT_TO },
    lineage: {
      correlation_id: "corr-gladstone-demo",
      in_response_to: null,
      prev_hash: null,
    },
    notes: "Synthetic demo record — vessel:imo:9000001 is not a real ship.",
  };

  const thermal: InferenceRecord = {
    inference_id: THERMAL_ID,
    claim:
      "Vessel IMO 9000001, loading at RG Tanna terminal (Gladstone), is loading thermal coal.",
    claim_structured: {
      subject: VESSEL,
      predicate: "carries",
      object: "commodity:coal-thermal",
      qualifiers: { loading_at: TERMINAL, synthetic: true },
    },
    tier: "C",
    confidence: 0.34,
    status: "INFERRED",
    method: "rule:cargo-schedule-check@1.0.0",
    evidence: [
      { kind: "observation", ref: OBS_SCHEDULE_THERMAL, role: "supports" },
    ],
    contrary_evidence: [
      { kind: "observation", ref: OBS_BERTH_ARRIVAL, role: "contradicts" },
      { kind: "inference", ref: MET_COAL_ID, role: "contradicts" },
    ],
    sources: ["source:demo:gladstone-shipping-schedule"],
    produced_at: PRODUCED_AT,
    event_time_range: { from: EVENT_FROM, to: EVENT_TO },
    lineage: {
      correlation_id: "corr-gladstone-demo",
      in_response_to: null,
      prev_hash: null,
    },
    notes: "Synthetic demo record — vessel:imo:9000001 is not a real ship.",
  };

  return { metCoal, thermal };
}

/**
 * Run the full competing-hypotheses flow against a PACT reference server at
 * `baseUrl`. Returns the two post-consensus inference records (both validated
 * against the inference JSON Schema) plus the final fabric status.
 */
export async function runGladstoneDemo(baseUrl: string): Promise<DemoResult> {
  const client = new PactClient(baseUrl);
  const suffix = Math.random().toString(36).slice(2, 10);
  const fabricId = `intel-gladstone-demo-${suffix}`;

  // Three agents join a fresh fabric.
  const agentA = await client.join(fabricId, "cargo-inference-a");
  const agentB = await client.join(fabricId, "schedule-checker-b");
  const agentC = await client.join(fabricId, "resolver-c");

  const { metCoal, thermal } = buildGladstoneHypotheses();

  // Each hypothesis is published as a `fact`-type proposal (RFC §3 mapping).
  const factA = toFactProposal(metCoal);
  const factB = toFactProposal(thermal);

  const proposalA = await client.propose(fabricId, agentA.principalId, {
    proposalId: `prop-met-coal-${suffix}`,
    sectionId: factA.sectionId,
    summary: factA.summary,
  });
  const proposalB = await client.propose(fabricId, agentB.principalId, {
    proposalId: `prop-thermal-coal-${suffix}`,
    sectionId: factB.sectionId,
    summary: factB.summary,
  });

  // Consensus: C (holding a vote obligation on A's proposal) approves it;
  // A objects to B's proposal — a blocking objection rejects it (§10.5).
  await client.vote(fabricId, agentC.principalId, proposalA.proposalId, "approve");
  await client.vote(fabricId, agentA.principalId, proposalB.proposalId, "object");

  // Fold the outcomes back into the inference lifecycle as NEW records.
  const corroborated = fromProposalOutcome(metCoal, "approved", {
    fabric_id: fabricId,
    proposal_id: proposalA.proposalId,
  });
  const contested = fromProposalOutcome(thermal, "rejected", {
    fabric_id: fabricId,
    proposal_id: proposalB.proposalId,
  });

  // Both final records MUST validate against the inference JSON Schema.
  const validators = createValidators();
  for (const [label, record] of [
    ["corroborated", corroborated],
    ["contested", contested],
  ] as const) {
    const result = validators.inference(record);
    if (!result.ok) {
      throw new Error(
        `gladstone demo produced a schema-invalid ${label} inference: ${result.errors.join("; ")}`,
      );
    }
  }

  const fabricStatus = await client.status(fabricId);
  return { corroborated, contested, fabricStatus };
}
