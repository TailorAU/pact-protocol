# Architecture

The system is a pipeline from raw external observation to composed interface, with the
knowledge graph and real-time state engine at its centre.

```
SOURCE (AEMO, AIS, BOM, ENTSO-E, EIA, ...)
  ↓  connectors: discover → fetch
RAW / BRONZE          verbatim bytes + fetch metadata, never rewritten
  ↓  connectors: parse → normalize (reproducible, versioned)
NORMALISED / SILVER   Observation envelopes, append-only JSONL per feed
  ↓  state engine: project / aggregate / correct
RECONCILED / GOLD     current-state snapshots, hash-chained graph deltas, inferences
  ↓
KNOWLEDGE GRAPH       what exists (structural) — bitemporal nodes and edges
REAL-TIME STATE       what it is doing now — per (entity, metric) projections
  ↓
API                   REST + SSE, provenance-tagged responses, SDUI composition
  ↓
GLOBE                 GPU-rendered human interface (deck.gl)
```

## Package dependency order

```
ontology → registry, store → graph, state → connectors, intel → pact-bridge, api → globe
```

- **ontology** owns the envelopes (schemas + TS types + validators + ID grammar). Every
  other package speaks these types; nothing else defines a data shape.
- **registry** loads the YAML registries (class-A structural truth) and enforces
  referential integrity: every `source_id`, `entity_id`, `grid_id` mentioned anywhere
  must resolve.
- **store** owns the on-disk medallion layout under `intelligence/var/` (see
  `STORAGE.md`). Bronze is immutable history; silver is append-only observations; gold
  is derived and always reproducible from bronze + code.
- **graph** holds the structural world model in memory, loaded from the registry, and
  applies runtime deltas only through a hash-chained journal (the journal is truth,
  memory is a projection — the same event-sourced stance as PACT's §6 event log).
- **state** turns observations into per-entity current state with event-time semantics,
  correction handling, and window aggregation. It never mutates canonical entities.
- **connectors** implement source-specific ingestion behind a common SDK. The
  `HttpGate` abstraction makes fixture replay and live fetching the same code path.
- **intel** runs deterministic, versioned rules over state + graph and emits
  evidence-linked Inference records — the only producer of class-C data.
- **api** composes registry ⊕ graph ⊕ state ⊕ gaps ⊕ inferences at read time and
  serves REST + SSE plus SDUI panel documents.
- **pact-bridge** publishes inferences into a PACT fabric as `fact`-type proposals and
  demonstrates competing-hypotheses resolution against the reference server.
- **globe** renders it.

## Phase mapping

How the handoff's build phases land in this tree:

| Phase | Landing |
|---|---|
| 1 Grid discovery | `data/registries/grids/` |
| 2–3 Source discovery + registry | `data/registries/sources/` |
| 4 Ontology | `schemas/` + `packages/ontology` |
| 5 Relationship graph | `schemas/relationship.schema.json` + `packages/graph` |
| 6 Ingestion | `packages/store` + `packages/connectors` |
| 7–9 Energy chains, electricity, industrial load | `data/entities/au-nem/`, `data/relationships/au-nem/`, AEMO connectors |
| 10 Facility telemetry classification | `observability` field + `data/registries/gaps/` |
| 11 Production | structural PRODUCES/CONSUMES edges + intel rules |
| 12 Live logistics | `aisstream` connector + vessel entities |
| 13 Product destination | SHIPS_TO / EXPORTS_TO edges at defensible level |
| 14 Real-time state engine | `packages/state` |
| 15 Real-time knowledge graph | `packages/graph` + state attachment at API read time |
| 16 AI role | `packages/intel` (deterministic rules now; AI hook documented in `SDUI.md`) |
| 17 PACT | `packages/pact-bridge` + RFC in `docs/v2-prep/` |
| 18 SDUI | `packages/api` composer + `schemas/sdui-panel.schema.json` |
| 19–20 Globe + LOD | `packages/globe` |
| 21 3DGS | documented placeholder (`GLOBE.md`) |

## Design invariants

1. **Class separation is structural.** Structural, telemetry, and inference data live in
   different envelopes with different schemas. There is no field an inference could set
   to pass as an observation.
2. **Raw is sacred.** Bronze artifacts are never rewritten or destroyed. Every
   downstream transformation is reproducible: silver and gold can be deleted and
   rebuilt from bronze + code at any time.
3. **Canonical entities are never mutated by telemetry.** State attaches to entities at
   read time, keyed by `entity_id`.
4. **Absence is explicit.** Missing live coverage is a first-class observability-gap
   record, not a silent hole.
5. **Honesty about verification.** A source is `verified_live` only after the
   verification harness has actually reached it. Everything authored under blocked
   egress says `documented_only`.
