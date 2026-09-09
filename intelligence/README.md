# PACT.TAILOR Intelligence Network

A real-time model of the physical economy — energy, industry, and trade — built as a
**Tailor extension workspace** on top of the PACT protocol. The machine interface is a
REST + SSE API over a bitemporal knowledge graph; the human interface is a GPU-rendered
globe; the coordination, evidence, and attestation layer is PACT.

This directory is an *extension implementation* in the sense of `GOVERNANCE.md`
(decision D2=B: domain-specific Tailor needs land as extensions, not PACT core). Nothing
under `spec/` is modified by this workspace. The design record lives at
`docs/v2-prep/rfc-intelligence-fact-evidence-extension.md`.

## The one rule

**Intelligence means live observable state — not AI prose.** Every piece of information
in this system belongs to exactly one of three classes, and the class is structurally
unforgeable (each class has its own envelope schema):

| Class | Envelope | Meaning |
|---|---|---|
| A. Structural | `schemas/entity.schema.json`, `relationship.schema.json` | The world model: what exists and how it connects |
| B. Live telemetry | `schemas/observation.schema.json` | What is being observed right now |
| C. Derived intelligence | `schemas/inference.schema.json` | Interpretations — **must** reference their evidence |

Derived intelligence can never be written into the observation store, and inferred
cargo/state/utilisation is never presented as reported fact. Where live observability
does not exist, the system records an explicit **observability gap**
(`schemas/observability-gap.schema.json`) — a first-class product output identifying
where Tailor/Sovrgn could deploy owned instrumentation.

## Honest data status

This workspace was developed in an environment whose network egress policy blocks all
energy-data endpoints. Consequently:

- Every connector is built against the *documented* wire format of its source and ships
  with fixtures marked `fixture_provenance: synthetic-from-spec`.
- Every source registry record carries `verification_status: documented_only` until the
  live-verification harness (`npm run verify:live`) has actually reached the endpoint.
- No claim of live verification is made anywhere in this tree. The replay path used in
  tests is the *same code path* as live ingestion (`HttpGate` swaps `ReplayGate` for
  `LiveGate`), so passing fixtures is meaningful but is not live proof.

## Layout

```
schemas/       Canonical JSON Schemas (2020-12) for all envelopes
data/          YAML registries: grids, sources, observability gaps + NEM structural seed
packages/
  ontology     TS types, ajv validators, ID grammar
  registry     YAML loaders, cross-reference validation, entity-resolution candidates
  store        Bronze/silver/gold medallion storage (embedded, zero external services)
  graph        In-process bitemporal property graph + traversal
  state        Real-time state engine: observations → current-state projections
  connectors   Connector SDK + AEMO / AIS / BOM / ENTSO-E / EIA connectors + fixtures
  intel        Rule-based derived intelligence (utilisation, cargo inference, anomalies)
  api          Zero-dep REST + SSE server + SDUI composer
  pact-bridge  Inference → PACT `fact` proposals; competing-hypotheses demo
  globe        deck.gl GPU globe prototype (Vite)
docs/          Architecture, data model, identifiers, storage, SDUI, globe, licensing
scripts/       End-to-end smoke test
var/           Runtime output (gitignored; bronze/silver/gold live here)
```

## Quick start

```bash
cd intelligence
npm ci
npm run build          # builds all packages in dependency order
npm test               # per-package node --test suites
npm run validate:data  # ajv-validates every schema + every YAML registry record
npm run smoke          # fixtures → ingest → state → graph → API → SSE, end to end
```

Run the API against replayed fixtures:

```bash
node packages/connectors/dist/cli.js ingest --replay
node packages/api/dist/cli.js --port 4200
# then: curl localhost:4200/api/intel/grids/grid:au-nem/summary
```

Run the globe dev server (expects the API on :4200):

```bash
npm run dev -w @pact-tailor/globe
```

## Status

All packages are `private: true` and are **never published to npm** (see repo issue #5).
First depth target: Australia's NEM, with the Gladstone industrial cluster as the worked
exemplar. Global breadth lives in the registries.
