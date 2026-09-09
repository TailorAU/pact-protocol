# Legal & licensing posture

Engineering metadata, not legal advice. Every source registry record carries a
`licensing` field summarising the publisher's terms as understood from their published
documentation; this file records the workspace-wide posture and the analyses that
shaped connector choices.

## Ground rules

1. **No scraping against terms of service.** Connectors are built only for sources
   whose published terms permit programmatic access for this use, or which are
   explicitly open data.
2. **No bulk third-party data committed to the repo.** The repo contains structural
   facts (locations, capacities, identifiers — cited to their sources), small synthetic
   fixtures flagged `fixture_provenance: synthetic-from-spec`, and public-domain
   basemap geometry (Natural Earth). It does not contain redistributed datasets.
3. **Private contracts are never fabricated.** Product-destination edges stop at the
   highest defensible level (port, country, market). Inferred commercial relationships
   are `MAY_SUPPLY` with confidence and evidence, never presented as contracts.
4. **Attribution obligations** recorded per source in its registry record and honoured
   in API responses via the `sources[]` provenance blocks.

## Analyses

- **AIS.** Design target is aisstream.io, whose published terms permit free
  programmatic streaming access with an API key for non-redistribution use. Scraping
  commercial AIS aggregator websites (e.g. MarineTraffic) is rejected — their terms
  prohibit it. Commercial feeds (Spire, exactEarth, or a direct AISHub membership) are
  the documented upgrade path for production coverage; owned AIS receivers are an
  instrumentation option recorded in the gap registry. AIS itself is an open VHF
  broadcast intended for navigation safety; receiving and decoding it is lawful in
  Australia, but redistribution terms attach to third-party *aggregated* feeds.
- **AEMO.** NEMWEB and the MMS data model are published for public use with
  attribution; AEMO's terms permit reproduction for study/analysis. Registration data
  and dashboards are public. Connector cadence respects published file cadence
  (5-minute dispatch); no authentication is bypassed anywhere.
- **BOM.** Observation products are publicly published; BOM's copyright notice permits
  use with attribution. High-volume programmatic access has a registered/paid channel
  (documented in the source record) — the connector is designed for low-cadence
  station observations.
- **ENTSO-E Transparency.** Free but registration-required (security token). The
  connector is a documented stub; no token, no fetch.
- **EIA.** US federal open data, API key freely issued; public domain.
- **Natural Earth.** Public domain; committed.
- **Global Energy Monitor.** CC BY 4.0 for most trackers — usable with attribution;
  recorded per record where GEM is a source.

## Committed-data provenance

Structural seed records in `../data/entities/` cite their sources in each record's
`sources[]` array. Facts of the world (a smelter's location, a generator's DUID and
capacity) are not copyrightable as facts, but the compilations they were read from are
credited, and nothing is bulk-copied.
