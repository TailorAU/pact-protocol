// aemo-nemweb-dispatchis — NEMWEB Current DispatchIS_Reports (5-minute
// dispatch solution). Wire format bound from the published MMS Data Model
// (DISPATCH package): tables DISPATCH.REGIONSUM (regional demand/generation),
// DISPATCH.PRICE (regional RRP), DISPATCH.INTERCONNECTORRES (signed MWFLOW).
// Built against the documented format only — fixtures are synthetic-from-spec.

import type { TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { Connector, ConnectorCtx, NormalizedOutput, ParsedRecord } from "../sdk.js";
import { nemTimeToIso } from "../aemo-csv.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";
import { CorrectionTracker, makeNemwebDiscover, nemwebFetch, nemwebParseZip } from "./nemweb-common.js";

const CONNECTOR_ID = "aemo-nemweb-dispatchis";
const SOURCE_ID = "source:aemo:nemweb-dispatchis";
const BASE_URL = "https://nemweb.com.au/Reports/Current/DispatchIS_Reports/";
const FILENAME_RE = /PUBLIC_DISPATCHIS_\d{12}_\d+\.zip/;

const FEED_REGIONSUM = "feed:au-nem:dispatch:regionsum";
const FEED_PRICE = "feed:au-nem:dispatch:price";
const FEED_INTERCONNECTOR = "feed:au-nem:dispatch:interconnectorres";

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_REGIONSUM,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["grid.demand.mw", "grid.generation.mw"],
    cadence: "5min",
    description: "DISPATCH.REGIONSUM — regional total demand and dispatchable generation",
    entity_scope: "GridRegion (aemo_region_id)",
  },
  {
    feed_id: FEED_PRICE,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["market.price.energy"],
    cadence: "5min",
    description: "DISPATCH.PRICE — regional dispatch energy price (RRP)",
    entity_scope: "GridRegion (aemo_region_id)",
  },
  {
    feed_id: FEED_INTERCONNECTOR,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["intercon.flow.mw"],
    cadence: "5min",
    description: "DISPATCH.INTERCONNECTORRES — signed interconnector MW flow",
    entity_scope: "Interconnector (MMS INTERCONNECTORID kept in external_ids.aemo_duid)",
  },
];

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();
  const corrections = new CorrectionTracker();

  for (const { table, row } of records) {
    if (table !== "DISPATCH.REGIONSUM" && table !== "DISPATCH.PRICE" && table !== "DISPATCH.INTERCONNECTORRES") {
      continue; // other DISPATCH tables (CASE_SOLUTION, CONSTRAINT, ...) are out of scope
    }
    const settlement = fieldStr(row, "SETTLEMENTDATE");
    const runno = fieldNum(row, "RUNNO") ?? 0;
    const intervention = fieldNum(row, "INTERVENTION") ?? 0;
    const eventTime = nemTimeToIso(settlement);
    const sourceSequence = `${settlement}:${runno}`;

    if (table === "DISPATCH.INTERCONNECTORRES") {
      const interconnectorId = fieldStr(row, "INTERCONNECTORID");
      const entityId = ctx.entityIndex.byDuid(interconnectorId);
      if (entityId === undefined) {
        reportUnmapped(unmapped, interconnectorId);
        continue;
      }
      const flow = fieldNum(row, "MWFLOW");
      if (flow === null) continue;
      observations.push(
        makeObservation({
          entity_id: entityId,
          metric: "intercon.flow.mw",
          value: flow, // signed; positive = the interconnector's forward direction
          unit: "MW",
          event_time: eventTime,
          ingest_time: ingestTime,
          source_id: SOURCE_ID,
          feed_id: FEED_INTERCONNECTOR,
          source_sequence: sourceSequence,
          is_correction: corrections.isCorrection(`${table}|${interconnectorId}|${settlement}`, runno, intervention),
          meta: { interconnectorid: interconnectorId, intervention },
        }),
      );
      continue;
    }

    const regionId = fieldStr(row, "REGIONID");
    const entityId = ctx.entityIndex.byRegionId(regionId);
    if (entityId === undefined) {
      reportUnmapped(unmapped, regionId);
      continue;
    }
    const isCorrection = corrections.isCorrection(`${table}|${regionId}|${settlement}`, runno, intervention);
    const common = {
      entity_id: entityId,
      event_time: eventTime,
      ingest_time: ingestTime,
      source_id: SOURCE_ID,
      source_sequence: sourceSequence,
      is_correction: isCorrection,
      meta: { regionid: regionId, intervention },
    };

    if (table === "DISPATCH.PRICE") {
      const rrp = fieldNum(row, "RRP");
      if (rrp !== null) {
        observations.push(
          makeObservation({ ...common, metric: "market.price.energy", value: rrp, unit: "AUD/MWh", feed_id: FEED_PRICE }),
        );
      }
    } else {
      // DISPATCH.REGIONSUM
      const demand = fieldNum(row, "TOTALDEMAND");
      if (demand !== null) {
        observations.push(
          makeObservation({ ...common, metric: "grid.demand.mw", value: demand, unit: "MW", feed_id: FEED_REGIONSUM }),
        );
      }
      // Prefer DISPATCHABLEGENERATION when the report carries it; fall back to
      // AVAILABLEGENERATION otherwise.
      const generation = fieldNum(row, "DISPATCHABLEGENERATION") ?? fieldNum(row, "AVAILABLEGENERATION");
      if (generation !== null) {
        observations.push(
          makeObservation({ ...common, metric: "grid.generation.mw", value: generation, unit: "MW", feed_id: FEED_REGIONSUM }),
        );
      }
    }
  }
  return { observations, unmapped };
}

export const aemoNemwebDispatchis: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 5 * 60_000, jitterMs: 30_000 },
  discover: makeNemwebDiscover(BASE_URL, FILENAME_RE),
  fetch: nemwebFetch,
  parse: nemwebParseZip,
  normalize,
};
