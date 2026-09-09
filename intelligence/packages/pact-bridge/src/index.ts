// @pact-tailor/pact-bridge — inference → PACT fact proposals.
//
// Bridges class-C derived intelligence (InferenceRecord) into a PACT fabric:
// inferences publish as `fact`-type proposals, and competing hypotheses
// resolve through PACT's propose/object machinery. See
// docs/v2-prep/rfc-intelligence-fact-evidence-extension.md.

export { toFactProposal, fromProposalOutcome, type FactProposal } from "./fact-mapper.js";
export {
  PactClient,
  PactClientError,
  type JoinResult,
  type ProposeInput,
  type ProposeResult,
  type VoteResult,
  type FabricStatus,
} from "./client.js";
export {
  runGladstoneDemo,
  buildGladstoneHypotheses,
  type DemoResult,
} from "./hypotheses-demo.js";
