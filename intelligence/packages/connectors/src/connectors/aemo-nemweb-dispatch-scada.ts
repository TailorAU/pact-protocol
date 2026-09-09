// aemo-nemweb-dispatch-scada — NEMWEB Current Dispatch_SCADA (unit-level
// SCADA MW per dispatch interval). Wire format bound from the published MMS
// Data Model: table DISPATCH.UNIT_SCADA (SETTLEMENTDATE, DUID, SCADAVALUE).
// Built against the documented format only — fixtures are synthetic-from-spec.

import type { TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { Connector, ConnectorCtx, NormalizedOutput, ParsedRecord } from "../sdk.js";
import { nemTimeToIso } from "../aemo-csv.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";
import { makeNemwebDiscover, nemwebFetch, nemwebParseZip } from "./nemweb-common.js";

const CONNECTOR_ID = "aemo-nemweb-dispatch-scada";
const SOURCE_ID = "source:aemo:nemweb-dispatch-scada";
const BASE_URL = "https://nemweb.com.au/Reports/Current/Dispatch_SCADA/";
const FILENAME_RE = /PUBLIC_DISPATCHSCADA_\d{12}_\d+\.zip/;

const FEED_SCADA = "feed:au-nem:dispatch:scada";

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_SCADA,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["power.output.mw"],
    cadence: "5min",
    description: "DISPATCH.UNIT_SCADA — instantaneous unit output (SCADAVALUE) per DUID",
    entity_scope: "Generator/StorageAsset units (external_ids.aemo_duid)",
  },
];

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();

  for (const { table, row } of records) {
    if (table !== "DISPATCH.UNIT_SCADA") continue;
    const duid = fieldStr(row, "DUID");
    const entityId = ctx.entityIndex.byDuid(duid);
    if (entityId === undefined) {
      reportUnmapped(unmapped, duid);
      continue;
    }
    const value = fieldNum(row, "SCADAVALUE");
    if (value === null) continue;
    const settlement = fieldStr(row, "SETTLEMENTDATE");
    observations.push(
      makeObservation({
        entity_id: entityId,
        metric: "power.output.mw",
        value,
        unit: "MW",
        event_time: nemTimeToIso(settlement),
        ingest_time: ingestTime,
        source_id: SOURCE_ID,
        feed_id: FEED_SCADA,
        source_sequence: settlement,
        // A station can map several DUIDs to one entity; keep the unit id so
        // downstream aggregation can tell the units apart.
        meta: { duid },
      }),
    );
  }
  return { observations, unmapped };
}

export const aemoNemwebDispatchScada: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 5 * 60_000, jitterMs: 30_000 },
  discover: makeNemwebDiscover(BASE_URL, FILENAME_RE),
  fetch: nemwebFetch,
  parse: nemwebParseZip,
  normalize,
};
