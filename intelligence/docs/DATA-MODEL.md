# Data model

Canonical schemas live in `../schemas/` (JSON Schema 2020-12, the same dialect as
`spec/v2.0+/schemas/`). The TypeScript mirror lives in `../packages/ontology/src/`.
This document explains the semantics the schemas encode.

## The three data classes

| Class | Envelope | Written by | Mutability |
|---|---|---|---|
| A. Structural | Entity, Relationship | registry YAML (curated) + gold deltas | bitemporal, versioned |
| B. Live telemetry | Observation | connectors only | append-only, corrections supersede |
| C. Derived intelligence | Inference | intel rules only | status transitions, never edited in place |

Class is determined by which envelope a datum lives in — there is no `data_class` field
an author could set dishonestly. The entity envelope carries `data_class: "structural"`
as a JSON Schema `const` so the tag is machine-readable but not author-choosable.

## Entity (class A)

An entity is a durable thing in the world: a grid, a generator, a smelter, a vessel, a
port, a company, a commodity. Key fields:

- `entity_id` — canonical ID per the grammar in `IDENTIFIERS.md`.
- `entity_type` — one of the 40 canonical types (Grid, GridRegion, Operator, Generator,
  StorageAsset, TransmissionAsset, Interconnector, Substation, CoalBasin, CoalMine,
  GasBasin, GasField, GasProcessingPlant, Pipeline, HydroReservoir, IndustrialFacility,
  Smelter, SteelMill, Mine, Refinery, LNGPlant, ChemicalPlant, DataCentre, Port,
  Terminal, Berth, Railway, Train, Vessel, Company, Commodity, Product, Market,
  Destination, Sensor, TelemetryFeed, Observation, Source, Evidence, Inference,
  ObservabilityGap — the final five are reified record kinds that remain addressable as
  graph nodes).
- `observability` — the facility-telemetry classification from the handoff:
  `KNOWN_LIVE` (a live feed observes this entity directly), `ESTIMATED` (state is
  derived from proxies), `NOT_OBSERVABLE` (no lawful path to live state today),
  `INSTRUMENTATION_OPPORTUNITY` (a gap record proposes owned sensing), `UNCLASSIFIED`.
- `geometry` — GeoJSON Point/LineString/Polygon/MultiPolygon in WGS84, or null.
- `external_ids` — typed cross-references (AEMO DUIDs, ENTSO-E EICs, IMO, MMSI,
  UN/LOCODE, GEM IDs, ...). The key vocabulary is closed; see `IDENTIFIERS.md`.
- `properties` — per-type payload validated by `schemas/entity-types/*.properties.json`.
- `sources[]` — every structural record cites the source registry entries it came from.

## Relationship (class A, bitemporal)

Typed edge between two entities. The 24 relationship types:

`PART_OF, CONNECTED_TO, INTERCONNECTED_WITH, OWNED_BY, OPERATED_BY, EXTRACTS, SUPPLIES,
MAY_SUPPLY, TRANSPORTS, GENERATES, TRANSMITS, IMPORTS_FROM, EXPORTS_TO, CONSUMES,
PRODUCES, LOADS_AT, DEPARTS_FROM, ARRIVES_AT, SHIPS_TO, OBSERVED_BY, REPORTED_BY,
INFERRED_FROM, SUPPORTED_BY, CONTRADICTED_BY`

Two time axes:

- **World time** — `valid_from` / `valid_to`: when the relationship held in reality
  (a mine supplied a power station 2011–2019).
- **System time** — `recorded_at` / `superseded_at`: when we believed it. Corrections
  never delete; they close the old record (`superseded_at`) and append a new one.

Every relationship carries `confidence` (0–1), `source`, and
`method: declared | derived | inferred | manual`. When `method` is `inferred`,
`evidence[]` is required — an edge asserted by a rule must point at the observations
and structural facts that justify it.

## Observation (class B)

One measurement of one metric on one entity:

- `observation_id` — ULID (time-ordered, collision-free at our scale).
- `metric` — dotted path from the metric vocabulary (`power.output.mw`,
  `market.price.energy`, `grid.frequency.hz`, `vessel.position`, ...).
- `event_time` vs `ingest_time` — when reality happened vs when we learned of it.
  All state-engine semantics key on event time; latency is the visible difference.
- `quality` — `good | suspect | estimated | interpolated | missing`.
- `is_correction` / `corrects` / `source_sequence` — publishers reissue intervals
  (AEMO dispatch runs, for example). A correction supersedes the original observation
  in projections but both remain on disk.

## Inference (class C)

The formalisation of the PACT `fact` proposal payload `{ claim, evidence, tier,
sources }` (see the RFC in `../../docs/v2-prep/`). Key fields:

- `claim` — one human-readable sentence; `claim_structured` — subject / predicate /
  object / qualifiers for machine use.
- `tier` — evidence tier: `A` (direct observation of the claimed quantity),
  `B` (strong proxy or single-hop derivation), `C` (multi-hop inference or pattern
  match).
- `confidence` — 0–1, produced by the rule, never hand-authored.
- `status` — `INFERRED → CORROBORATED | CONTESTED → VERIFIED | RETRACTED`. Status moves
  through PACT consensus (see `packages/pact-bridge`) or new evidence; records are
  never edited in place.
- `evidence[]` and `contrary_evidence[]` — references to observations, structural
  records, or prior inferences, each with a role. An inference with an empty evidence
  array is schema-invalid.
- `method` — `rule:{name}@{semver}`: the exact versioned rule that produced it, so
  every inference is reproducible.
- `lineage` — `correlation_id` / `in_response_to` / `prev_hash`, mirroring the PACT
  event envelope (`spec/v2.0/schemas/event.json`) so inference chains ride the same
  audit spine as PACT events rather than inventing a parallel one.

## Source and TelemetryFeed

A **Source** is a publisher's dataset (registry record; see `../data/registries/sources/`).
Its `verification_status` is the honesty mechanism: `verified_live` (the harness reached
it), `documented_only` (built from published documentation), `unverified`.
A **TelemetryFeed** is one concrete stream a connector produces from a source
(e.g. `feed:aemo:dispatchis:regionsum`), the unit silver files are keyed by.

## Observability gap

The reification of "we cannot see this and it matters" — entity, desired metric,
best available proxy, required resolution/accuracy, commercial and strategic value,
instrumentation options (CT sensor, substation gateway, AIS receiver, SCADA/OPC-UA,
Modbus, MQTT gateway, satellite, camera, partner feed), complexity, priority, status.
Gap records drive both the API (`/api/intel/gaps`) and the globe's gap-ring layer, and
are the input to Tailor/Sovrgn owned-instrumentation decisions.
