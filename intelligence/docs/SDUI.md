# Server-driven UI (SDUI)

The interface for an entity is not a fixed dashboard: the server composes a panel
document from the entity's type and its live situation, and the client renders it.
Panel documents validate against `../schemas/sdui-panel.schema.json`.

## Panel document

```json
{
  "entity_id": "smelter:au-qld:boyne-island",
  "entity_type": "Smelter",
  "situation": ["has-gaps", "estimated-load"],
  "layout": [
    { "panel": "headline-state",
      "data": { "endpoint": "/api/intel/entities/smelter:au-qld:boyne-island/state" } },
    { "panel": "timeseries",
      "props": { "metric": "power.load.estimated_mw", "window": "24h" },
      "data": { "endpoint": "/api/intel/entities/smelter:au-qld:boyne-island/observations?metric=power.load.estimated_mw" } },
    { "panel": "gap-card",
      "data": { "endpoint": "/api/intel/gaps?entity=smelter:au-qld:boyne-island" } },
    { "panel": "graph-neighborhood", "props": { "depth": 2 },
      "data": { "endpoint": "/api/intel/entities/smelter:au-qld:boyne-island/graph?depth=2" } },
    { "panel": "inference-list",
      "data": { "endpoint": "/api/intel/inferences?entity=smelter:au-qld:boyne-island" } }
  ]
}
```

Panels reference **endpoints**, never inline data values — the client fetches, so the
data a user sees is always the API's provenance-tagged truth, not a copy baked into a
layout.

## Composition

`packages/api/src/sdui/composer.ts`:

1. **Type template** — each entity type has a deterministic base template
   (`templates/grid.ts`, `generator.ts`, `smelter.ts`, `vessel.ts`, `port.ts`,
   `default.ts`): a grid leads with load/generation/price/flows; a generator with
   current MW vs capacity and its upstream fuel chain; a vessel with position, speed,
   cargo status (reported vs inferred, visibly distinct), origin and destination.
2. **Situation rules** — computed from live state at composition time:
   `no-live-data`, `stale-telemetry` (staleness beyond the feed's expected cadence),
   `has-gaps`, `estimated-load` (observability = ESTIMATED), `anomaly-active` (an
   open anomaly inference references the entity). Situations inject or reorder panels —
   an active anomaly hoists the inference list; missing live data hoists the gap card.

## AI hook

`composeWithAI(entity, situations, deterministicLayout)` is the declared seam for
model-driven composition. Contract:

- AI may **reorder, group, annotate, or drop** panels, and may add panels that
  reference *declared* endpoints.
- AI may **not** inline data values, invent endpoints, or alter the `data` blocks of
  existing panels. Composed output is schema-validated and endpoint-checked before
  serving; violations fall back to the deterministic layout.
- The current implementation is the identity function — deterministic output ships
  unchanged. The hook exists so the AI layer lands without renegotiating the contract.

This is the SDUI expression of the system-wide rule: **AI interprets and arranges;
it does not manufacture state.**
