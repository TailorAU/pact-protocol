// aemo-vis-nem-summary — the JSON backing service of AEMO's public NEM data
// dashboard.
//
// DOCUMENTED-FROM-PUBLIC-DASHBOARD: this endpoint has no formal API spec; the
// shape below is what the dashboard's own network calls exchange, as
// documented in the source registry record (source:aemo:vis-nem-summary).
// Treat NEMWEB DispatchIS as canonical; this is a convenience snapshot.
//
//   GET https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY
//   → {
//       "ELEC_NEM_SUMMARY": [
//         { "SETTLEMENTDATE": "2026-08-12T11:05:00",   // NEM time (UTC+10), no zone suffix
//           "REGIONID": "QLD1",
//           "TOTALDEMAND": 6123.45,                    // MW
//           "SCHEDULEDGENERATION": 5410.2,             // MW
//           "SEMISCHEDULEDGENERATION": 489.9,          // MW
//           "PRICE": 84.5,                             // AUD/MWh
//           ... },
//         ... one row per region ],
//       "ELEC_NEM_SUMMARY_PRICES": [...],              // sibling blocks not consumed here
//       "ELEC_NEM_SUMMARY_MARKET_NOTICE": [...]
//     }
//
// grid.generation.mw = SCHEDULEDGENERATION + SEMISCHEDULEDGENERATION.
// Built against the documented shape only — fixtures are synthetic-from-spec.

import type { TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { ArtifactRef, Connector, ConnectorCtx, NormalizedOutput, ParsedRecord, RawArtifact } from "../sdk.js";
import { nemTimeToIso } from "../aemo-csv.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";

const CONNECTOR_ID = "aemo-vis-nem-summary";
const SOURCE_ID = "source:aemo:vis-nem-summary";
const REPORT_URL = "https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY";

const FEED_SUMMARY = "feed:au-nem:vis-nem-summary";

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_SUMMARY,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["grid.demand.mw", "grid.generation.mw", "market.price.energy"],
    cadence: "5min",
    description: "ELEC_NEM_SUMMARY dashboard snapshot — per-region demand, generation, price",
    entity_scope: "GridRegion (aemo_region_id)",
    notes: "Undocumented dashboard endpoint; NEMWEB DispatchIS is canonical for the same quantities.",
  },
];

async function discover(_ctx: ConnectorCtx): Promise<ArtifactRef[]> {
  return [{ url: REPORT_URL, name: "ELEC_NEM_SUMMARY" }];
}

async function fetchArtifact(ref: ArtifactRef, ctx: ConnectorCtx): Promise<RawArtifact> {
  const res = await ctx.gate.get(ref.url);
  if (res.status !== 200) {
    throw new Error(`vis-nem-summary: GET ${ref.url} returned HTTP ${res.status}`);
  }
  return {
    ref,
    body: res.body,
    fetched_at: ctx.now(),
    http_status: res.status,
    ...(res.content_type !== undefined ? { content_type: res.content_type } : {}),
  };
}

async function parse(raw: RawArtifact): Promise<ParsedRecord[]> {
  const doc = JSON.parse(raw.body.toString("utf8")) as { ELEC_NEM_SUMMARY?: unknown };
  const rows = Array.isArray(doc.ELEC_NEM_SUMMARY) ? doc.ELEC_NEM_SUMMARY : [];
  const records: ParsedRecord[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") continue;
    const src = raw as Record<string, unknown>;
    const row: Record<string, string | number> = {};
    for (const key of [
      "SETTLEMENTDATE",
      "REGIONID",
      "TOTALDEMAND",
      "SCHEDULEDGENERATION",
      "SEMISCHEDULEDGENERATION",
      "PRICE",
    ]) {
      const v = src[key];
      if (typeof v === "string" || typeof v === "number") row[key] = v;
    }
    records.push({ table: "ELEC_NEM_SUMMARY", row });
  }
  return records;
}

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();

  for (const { table, row } of records) {
    if (table !== "ELEC_NEM_SUMMARY") continue;
    const regionId = fieldStr(row, "REGIONID");
    const entityId = ctx.entityIndex.byRegionId(regionId);
    if (entityId === undefined) {
      reportUnmapped(unmapped, regionId);
      continue;
    }
    const settlement = fieldStr(row, "SETTLEMENTDATE");
    const common = {
      entity_id: entityId,
      event_time: nemTimeToIso(settlement),
      ingest_time: ingestTime,
      source_id: SOURCE_ID,
      feed_id: FEED_SUMMARY,
      source_sequence: settlement,
      meta: { regionid: regionId },
    };
    const demand = fieldNum(row, "TOTALDEMAND");
    if (demand !== null) {
      observations.push(makeObservation({ ...common, metric: "grid.demand.mw", value: demand, unit: "MW" }));
    }
    const scheduled = fieldNum(row, "SCHEDULEDGENERATION");
    const semiScheduled = fieldNum(row, "SEMISCHEDULEDGENERATION");
    if (scheduled !== null || semiScheduled !== null) {
      observations.push(
        makeObservation({
          ...common,
          metric: "grid.generation.mw",
          value: (scheduled ?? 0) + (semiScheduled ?? 0),
          unit: "MW",
        }),
      );
    }
    const price = fieldNum(row, "PRICE");
    if (price !== null) {
      observations.push(makeObservation({ ...common, metric: "market.price.energy", value: price, unit: "AUD/MWh" }));
    }
  }
  return { observations, unmapped };
}

export const aemoVisNemSummary: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 5 * 60_000, jitterMs: 30_000 },
  discover,
  fetch: fetchArtifact,
  parse,
  normalize,
};
