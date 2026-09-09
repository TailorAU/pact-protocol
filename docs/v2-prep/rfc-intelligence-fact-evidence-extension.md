# RFC: `au.tailor.intel.claim` — an evidence-carrying claim payload for the PACT `fact` resource type

> **Status:** RFC — for discussion. Implementation ships in the `intelligence/`
> extension workspace; **no spec text or registry entry changes in this PR.**
> **Proposed resource type:** `au.tailor.intel.claim` (registration deferred — see §6)
> **Target PACT version:** v2.2 (§14 resource types; §24 Matters unaffected)
> **Owner:** Tailor (extension workspace); registry decision remains with the maintainer
> **Related:** `spec/v2.2/resource-types.yaml` built-in `fact` type; GOVERNANCE.md
> decision D2=B (domain-specific Tailor needs are extensions, not core); issue #34
> (KG product extraction — explicitly *not* what this workspace is, see §7)
> **Reference implementation:** `intelligence/schemas/inference.schema.json` +
> `intelligence/packages/pact-bridge/` (competing-hypotheses demo against
> `reference-server/`)

---

## 1. Summary

PACT's built-in `fact` resource type verifies knowledge claims into a knowledge graph,
but its proposal payload — `{ claim, evidence, tier, sources }` — is described in the
registry as a string, with no JSON Schema behind it. `tier` and `sources` are undefined
in spec text; `evidence` has no structure; nothing binds a claim to the observations
that justify it.

The intelligence workspace needs exactly that binding: its rule is that **derived
intelligence must always point back to its evidence and can never masquerade as direct
telemetry**. This RFC documents the formalisation the workspace implements — a
schema'd, evidence-carrying claim payload — and proposes it, eventually, as a
registered custom resource type `au.tailor.intel.claim`.

## 2. Motivation

A live intelligence system produces statements like:

> Vessel X departing Gladstone is likely carrying metallurgical coal. Confidence 0.91.

That statement is useful precisely to the degree that its support is inspectable. The
informal `fact` payload can carry the sentence; it cannot carry, in any checkable way,
*which* AIS observations, berth assignments, and structural supply edges support it,
which evidence cuts against it, what rule produced it, or what its status became after
other agents weighed in.

PACT already solves the adjacent problem for *authority* (hash-chained event log,
`authorization_proof`, mandates). This RFC applies the same discipline to *epistemics*:
claims carry their evidence, their counter-evidence, their method, and their lineage.

## 3. The payload

Normative schema: `intelligence/schemas/inference.schema.json`. Shape (informative):

```json
{
  "inference_id": "infer:2026-08-12:rgt-cargo-01",
  "claim": "Vessel MV Example, departing RG Tanna berth 1, is loading metallurgical coal.",
  "claim_structured": {
    "subject": "vessel:imo:9700000",
    "predicate": "carries",
    "object": "commodity:coal-metallurgical",
    "qualifiers": { "loading_at": "terminal:au-qld:rg-tanna" }
  },
  "tier": "B",
  "confidence": 0.91,
  "status": "INFERRED",
  "method": "rule:cargo-inference@1.0.0",
  "evidence": [
    { "kind": "observation", "ref": "01J...ULID", "role": "supports" },
    { "kind": "structural",  "ref": "rel:terminal-supplies-met-coal", "role": "supports" }
  ],
  "contrary_evidence": [
    { "kind": "observation", "ref": "01J...ULID2", "role": "contradicts" }
  ],
  "sources": ["source:ais:aisstream", "source:aemo:nemweb-dispatchis"],
  "produced_at": "2026-08-12T03:15:00Z",
  "event_time_range": { "from": "2026-08-12T01:00:00Z", "to": "2026-08-12T03:10:00Z" },
  "lineage": { "correlation_id": "corr-...", "in_response_to": null, "prev_hash": "..." },
  "pact": { "fabric_id": "...", "proposal_id": "..." }
}
```

Mapping to the built-in `fact` payload is total: `claim` → `claim`,
`evidence ∪ contrary_evidence` → `evidence`, `tier` → `tier`, `sources` → `sources` —
so an `au.tailor.intel.claim` proposal degrades losslessly to a legacy `fact` proposal
for servers that only know the built-in type. The bridge in
`intelligence/packages/pact-bridge/src/fact-mapper.ts` implements this mapping today.

## 4. Semantics

- **Evidence tiers:** `A` — the claimed quantity was directly observed; `B` — one-hop
  proxy or derivation from direct observations; `C` — multi-hop inference or pattern
  match. Tier is about *distance from observation*, confidence is about *strength*;
  the two are orthogonal and both required.
- **Status lifecycle:** `INFERRED → CORROBORATED | CONTESTED → VERIFIED | RETRACTED`.
  Transitions happen through PACT consensus (propose/object/salience on the claim
  field) or through new evidence; records are append-only — a status change is a new
  revision, never an edit that loses the contested history.
- **Contrary evidence is first-class.** An objection that cites evidence lands in
  `contrary_evidence` and survives resolution. A claim that won consensus still shows
  what cut against it.
- **Non-masquerade rule (normative for the workspace):** an inference envelope can
  never be written to the observation store, and no observation field is
  author-choosable to claim otherwise. Consumers can always distinguish reported from
  inferred — this is the payload-level expression of PACT's evidence-backed-claim
  intent in §14.5.
- **Lineage** reuses the event-log vocabulary (`correlation_id`, `in_response_to`,
  `prev_hash` per §6.1/§6.4) rather than inventing a parallel provenance chain. An
  inference chain is auditable with the same tooling as a PACT event chain.

## 5. Consensus flow (worked example, implemented)

The Gladstone demo (`intelligence/packages/pact-bridge/`): two agents propose competing
cargo claims for the same vessel — metallurgical coal (0.91) citing berth assignment +
draught-change observations + terminal supply edges, versus thermal coal (0.34) citing
a contrary shipping-schedule observation. One objects to the other's claim; salience
and consensus resolve; the winning inference becomes `CORROBORATED`, the losing one
`CONTESTED`; both retain full evidence and contrary-evidence arrays. Runs offline
against `reference-server/` in `node --test`.

## 6. Registration (deferred)

Registering `au.tailor.intel.claim` in `spec/vX.Y/resource-types.yaml` follows the
registry's own process — a dedicated PR against that file, linking the reference
implementation, reviewed by the maintainer. **This workspace's PR deliberately does not
touch the registry** (or any file under `spec/`): per AGENTS.md, agents do not freehand
spec-adjacent surfaces; the registration PR is a follow-up under maintainer sign-off.
Proposed entry (informative draft):

```yaml
- type: au.tailor.intel.claim
  status: registered
  field_schema: "claim:{id}  — evidence-carrying knowledge-claim identifier"
  proposal_payload: "inference envelope per intelligence/schemas/inference.schema.json"
  apply_semantics: Claim verified into the knowledge graph with evidence and lineage retained.
  terminal_states: [Verified, Retracted]
  content_format: application/json
  maintainer: TailorAU
```

## 7. Relationship to issue #34

Issue #34 (extraction of the production KG product into this repo) is owner-only and
security-sensitive. This workspace is **not** that extraction: it is a new extension
implementation under GOVERNANCE.md D2=B, with its own data model and no dependency on
`tailor-app` internals. The only overlap is conceptual — both verify claims into a
knowledge graph — and this RFC is written so the production product could *adopt* the
schema'd payload later if the owner chooses.

## 8. Compatibility

- Servers that know only the built-in `fact` type receive the degraded
  `{ claim, evidence, tier, sources }` mapping (§3) — no breakage.
- The payload adds no PACT operations, no endpoints, no `_meta` extensions; it rides
  the existing propose/object/consensus machinery unchanged.
- Nothing in this RFC is normative for PACT. It becomes normative for the registry
  only if/when the §6 registration PR is accepted.
