# Identifiers

## Canonical entity IDs

Structured stable slugs, not UUIDs — registries are YAML reviewed in pull requests, and
slugs diff, merge, and grep. Grammar (enforced by regex in the schemas and by
`packages/ontology/src/ids.ts`):

```
{type-code}:{namespace}:{local-slug}        (or {type-code}:{namespace} for singletons)
```

Examples:

```
grid:au-nem                      region:au-nem:qld1              gen:au-nem:gladstone-ps
intercon:au-nem:qni              sub:au-qld:calvale              line:au-qld:calvale-halys
basin:au:bowen                   mine:au-qld:blackwater          gasfield:au-qld:surat-fairview
pipe:au:qsn-link                 resv:au-tas:gordon              smelter:au-qld:boyne-island
steel:au-nsw:port-kembla         refinery:au-qld:lytton          lng:au-qld:qclng
chem:au-qld:orica-yarwun         dc:au-nsw:eastern-creek         port:au-qld:gladstone
terminal:au-qld:rg-tanna         berth:au-qld:rg-tanna-1         rail:au-qld:blackwater-system
train:au-qld:aurizon-bw-01       vessel:imo:9700000              vessel:mmsi:503123456
company:au:rio-tinto             commodity:coal-metallurgical    product:aluminium-ingot
market:jp:steel                  dest:jp:port-of-nagoya          sensor:au-qld:boyne-ct-01
feed:aemo:dispatchis:regionsum   source:aemo:nemweb-dispatchis   gap:au-nem:boyne-live-load
infer:2026-08-12:rgt-cargo-01    obs: (ULIDs, not slugs — see below)
```

Type codes: `grid, region, operator, gen, storage, trans, intercon, sub, line, basin,
mine, gasbasin, gasfield, gasplant, pipe, resv, facility, smelter, steel, refinery,
lng, chem, dc, port, terminal, berth, rail, train, vessel, company, commodity, product,
market, dest, sensor, feed, source, evidence, infer, gap`.

Namespace rules:

- Grid-bound assets use the grid ID's namespace (`au-nem`).
- Geographic assets use ISO country (+ state where useful): `au-qld`, `jp`, `us-tx`.
- Where a global external authority is the natural key, it becomes the namespace:
  `vessel:imo:{imo}`, falling back to `vessel:mmsi:{mmsi}` when no IMO number exists.
- Commodities and products are global: `commodity:{slug}`, `product:{slug}`.

**Immutability:** a published ID is never renamed. A misnamed entity gets an alias and,
if truly wrong, a tombstone record pointing at the successor (`same_as`).

Observation IDs are ULIDs (time-sortable, generated at ingest), not slugs — there are
too many and they are never hand-authored.

## External ID vocabulary

`external_ids` is a closed keyed object (`additionalProperties: false`):

| Key | Authority | Example |
|---|---|---|
| `aemo_duid` | AEMO dispatchable unit ID(s) | `["GSTONE1", "GSTONE2"]` |
| `aemo_station_id` | AEMO station identifier | `GSTONE` |
| `aemo_region_id` | AEMO region | `QLD1` |
| `entsoe_eic` | ENTSO-E Energy Identification Code | `10YAU-...` |
| `eia_plant_code` | US EIA plant code | `55123` |
| `gem_id` | Global Energy Monitor tracker ID | `G100000108417` |
| `imo` | IMO ship number | `9700000` |
| `mmsi` | Maritime Mobile Service Identity | `503123456` |
| `callsign` | Vessel callsign | `VJN2` |
| `unlocode` | UN/LOCODE port code | `AUGLT` |
| `abn` | Australian Business Number | `47004458404` |
| `lei` | Legal Entity Identifier | `213800YOEO5OQ72G2R82` |
| `wikidata_qid` | Wikidata | `Q1140983` |
| `osm_id` | OpenStreetMap | `way/123456789` |

Adding a key to this vocabulary is a schema change (deliberate, reviewed) — free-form
external references are not allowed, because entity resolution depends on typed keys.

## Entity resolution

`packages/registry/src/resolve.ts` runs two passes:

1. **Exact:** identical typed external ID (same `imo`, same `aemo_duid`, ...) →
   the records refer to the same entity.
2. **Heuristic:** normalised-name similarity + geometry proximity (< 5 km) →
   emits `same_as` **candidates** to `var/resolution-candidates.jsonl` for human review.

Candidates are never auto-merged. In this session's hand-curated seed data, resolution
runs as a validation step (it should find no unexpected duplicates), not as a mutation.
