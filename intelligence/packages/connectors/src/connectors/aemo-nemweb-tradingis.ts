// aemo-nemweb-tradingis — NEMWEB Current TradingIS_Reports (trading-interval
// price report). Wire format bound from the published MMS Data Model: table
// TRADING.PRICE (SETTLEMENTDATE, RUNNO, REGIONID, PERIODID, RRP). The feed is
// deliberately distinct from the dispatch price feed — trading price is a
// different market quantity than the 5-minute dispatch RRP.
// Built against the documented format only — fixtures are synthetic-from-spec.

import type { TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { Connector, ConnectorCtx, NormalizedOutput, ParsedRecord } from "../sdk.js";
import { nemTimeToIso } from "../aemo-csv.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";
import { CorrectionTracker, makeNemwebDiscover, nemwebFetch, nemwebParseZip } from "./nemweb-common.js";

const CONNECTOR_ID = "aemo-nemweb-tradingis";
const SOURCE_ID = "source:aemo:nemweb-tradingis";
const BASE_URL = "https://nemweb.com.au/Reports/Current/TradingIS_Reports/";
const FILENAME_RE = /PUBLIC_TRADINGIS_\d{12}_\d+\.zip/;

const FEED_TRADING_PRICE = "feed:au-nem:trading:price";

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_TRADING_PRICE,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["market.price.energy"],
    cadence: "5min",
    description: "TRADING.PRICE — regional trading-interval energy price (RRP)",
    entity_scope: "GridRegion (aemo_region_id)",
  },
];

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();
  const corrections = new CorrectionTracker();

  for (const { table, row } of records) {
    if (table !== "TRADING.PRICE") continue;
    const regionId = fieldStr(row, "REGIONID");
    const entityId = ctx.entityIndex.byRegionId(regionId);
    if (entityId === undefined) {
      reportUnmapped(unmapped, regionId);
      continue;
    }
    const rrp = fieldNum(row, "RRP");
    if (rrp === null) continue;
    const settlement = fieldStr(row, "SETTLEMENTDATE");
    const runno = fieldNum(row, "RUNNO") ?? 0;
    observations.push(
      makeObservation({
        entity_id: entityId,
        metric: "market.price.energy",
        value: rrp,
        unit: "AUD/MWh",
        event_time: nemTimeToIso(settlement),
        ingest_time: ingestTime,
        source_id: SOURCE_ID,
        feed_id: FEED_TRADING_PRICE,
        source_sequence: `${settlement}:${runno}`,
        is_correction: corrections.isCorrection(`${regionId}|${settlement}`, runno, fieldNum(row, "INVALIDFLAG") ?? 0),
        meta: { regionid: regionId, periodid: fieldStr(row, "PERIODID") },
      }),
    );
  }
  return { observations, unmapped };
}

export const aemoNemwebTradingis: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 5 * 60_000, jitterMs: 30_000 },
  discover: makeNemwebDiscover(BASE_URL, FILENAME_RE),
  fetch: nemwebFetch,
  parse: nemwebParseZip,
  normalize,
};
