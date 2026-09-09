// eia-v2 (STUB) — U.S. EIA API v2, electricity/rto/region-data (hourly demand
// by balancing authority).
//
// STUB POSTURE: EIA v2 requires an api_key (freely issued, but still a
// registration credential). Live discovery returns [] with a log line and a
// live fetch throws; parse/normalize are fully implemented against the
// DOCUMENTED response shape and exercised via the replay fixture
// (synthetic-from-spec).
//
// Documented response shape (EIA API v2 documentation):
//
//   { "response": {
//       "total": ...,
//       "data": [ { "period": "2026-08-12T00",       // hourly, UTC
//                   "respondent": "DEMO",            // balancing-authority code
//                   "respondent-name": "...",
//                   "type": "D", "type-name": "Demand",
//                   "value": 21450,
//                   "value-units": "megawatthours" }, ... ] },
//     "request": {...}, "apiVersion": "2.x.x" }
//
// Hourly demand in MWh over one hour is numerically the average MW for that
// hour; emitted as grid.demand.mw with the conversion noted in meta.

import type { TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { ArtifactRef, Connector, ConnectorCtx, NormalizedOutput, ParsedRecord, RawArtifact, VerificationReport } from "../sdk.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";

const CONNECTOR_ID = "eia-v2";
const SOURCE_ID = "source:eia:api-v2";
const API_URL =
  "https://api.eia.gov/v2/electricity/rto/region-data/data/?frequency=hourly&data[0]=value&facets[type][]=D";

const FEED_DEMAND = "feed:us:eia:demand";

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_DEMAND,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["grid.demand.mw"],
    cadence: "hourly",
    description: "EIA-930 hourly demand per balancing authority via API v2",
    entity_scope: "Grid/GridRegion balancing authorities (properties.eia_ba_code — see EntityIndex friction note)",
    notes: "STUB — api_key-required source; live path disabled until EIA_API_KEY is configured.",
  },
];

async function discover(ctx: ConnectorCtx): Promise<ArtifactRef[]> {
  if (ctx.gate.kind === "live") {
    ctx.log("eia-v2: STUB — live discovery requires an EIA api_key; returning no artifacts");
    return [];
  }
  return [{ url: API_URL, name: "region-data-demand" }];
}

async function fetchArtifact(ref: ArtifactRef, ctx: ConnectorCtx): Promise<RawArtifact> {
  if (ctx.gate.kind === "live") {
    throw new Error("eia-v2: live fetch requires an EIA api_key (stub connector)");
  }
  const res = await ctx.gate.get(ref.url);
  if (res.status !== 200) {
    throw new Error(`eia-v2: GET ${ref.url} returned HTTP ${res.status}`);
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
  const doc = JSON.parse(raw.body.toString("utf8")) as { response?: { data?: unknown } };
  const data = doc.response?.data;
  const rows = Array.isArray(data) ? data : [];
  const records: ParsedRecord[] = [];
  for (const entry of rows) {
    if (entry === null || typeof entry !== "object") continue;
    const src = entry as Record<string, unknown>;
    const row: Record<string, string | number> = {};
    for (const key of ["period", "respondent", "respondent-name", "type", "value", "value-units"]) {
      const v = src[key];
      if (typeof v === "string" || typeof v === "number") row[key] = v;
    }
    records.push({ table: "region-data", row });
  }
  return records;
}

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();

  for (const { table, row } of records) {
    if (table !== "region-data") continue;
    if (fieldStr(row, "type") !== "D") continue; // demand rows only
    const respondent = fieldStr(row, "respondent");
    const entityId = ctx.entityIndex.byEiaBa(respondent);
    if (entityId === undefined) {
      reportUnmapped(unmapped, respondent);
      continue;
    }
    const value = fieldNum(row, "value");
    if (value === null) continue;
    const period = fieldStr(row, "period"); // "2026-08-12T00" (hourly)
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(period)) continue;
    observations.push(
      makeObservation({
        entity_id: entityId,
        metric: "grid.demand.mw",
        value,
        unit: "MW",
        event_time: `${period}:00:00Z`,
        ingest_time: ingestTime,
        source_id: SOURCE_ID,
        feed_id: FEED_DEMAND,
        source_sequence: `${respondent}:${period}`,
        meta: { respondent, source_units: fieldStr(row, "value-units"), conversion: "MWh/h == avg MW over the hour" },
      }),
    );
  }
  return { observations, unmapped };
}

async function verify(ctx: ConnectorCtx): Promise<VerificationReport> {
  return {
    connector_id: CONNECTOR_ID,
    source_id: SOURCE_ID,
    ok: false,
    error: "STUB: requires EIA api_key (free registration at eia.gov/opendata) — live verification not attempted",
    checked_at: ctx.now(),
  };
}

export const eiaV2: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 60 * 60_000, jitterMs: 300_000 },
  discover,
  fetch: fetchArtifact,
  parse,
  normalize,
  verify,
};
