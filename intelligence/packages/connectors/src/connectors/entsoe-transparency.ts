// entsoe-transparency (STUB) — ENTSO-E Transparency Platform, document type
// A75 (actual generation per production type).
//
// STUB POSTURE: the Transparency REST API is registration-required (free
// securityToken). Live discovery therefore returns [] with a log line, and a
// live fetch throws — no token, no fetch, per LEGAL-LICENSING.md. The parse
// and normalize paths are fully implemented against the DOCUMENTED XML format
// and exercised through the replay fixture (synthetic-from-spec).
//
// Documented A75 GL_MarketDocument shape (per the published Transparency user
// guide):
//
//   <GL_MarketDocument>
//     <TimeSeries>
//       <inBiddingZone_Domain.mRID codingScheme="A01">10Y...</inBiddingZone_Domain.mRID>
//       <MktPSRType><psrType>B05</psrType></MktPSRType>   <!-- fuel/technology code -->
//       <Period>
//         <timeInterval><start>2026-08-12T00:00Z</start><end>...</end></timeInterval>
//         <resolution>PT60M</resolution>                  <!-- PT15M/PT30M/PT60M -->
//         <Point><position>1</position><quantity>640</quantity></Point>
//         ...
//       </Period>
//     </TimeSeries>
//   </GL_MarketDocument>
//
// The XML is consumed with a tiny hand-rolled tag scanner (no XML dependency)
// — sufficient for this well-formed, namespaced-but-flat document family.

import type { TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { ArtifactRef, Connector, ConnectorCtx, NormalizedOutput, ParsedRecord, RawArtifact, VerificationReport } from "../sdk.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";

const CONNECTOR_ID = "entsoe-transparency";
const SOURCE_ID = "source:entsoe:transparency-platform";
const API_URL = "https://web-api.tp.entsoe.eu/api?documentType=A75&processType=A16";

const FEED_GENERATION = "feed:eu:entsoe:actual-generation";

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_GENERATION,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["grid.generation.mw"],
    cadence: "15-60min depending on bidding zone",
    description: "A75 actual generation per production type, per bidding zone",
    entity_scope: "Grid/GridRegion (external_ids.entsoe_eic)",
    notes: "STUB — registration-required source; live path disabled until a securityToken is configured.",
  },
];

// --- tiny hand-rolled tag scanner (documented format, no xml dependency) ---

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All inner contents of <tag ...>...</tag>, non-nested, document order. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(tag)}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

/** Trimmed text of the first <tag>...</tag>, or undefined. */
export function xmlText(xml: string, tag: string): string | undefined {
  const first = xmlBlocks(xml, tag)[0];
  return first === undefined ? undefined : first.trim();
}

function resolutionMinutes(resolution: string): number {
  const m = /^PT(\d+)M$/.exec(resolution);
  if (!m) throw new Error(`entsoe-transparency: unsupported resolution "${resolution}"`);
  return Number(m[1]);
}

async function discover(ctx: ConnectorCtx): Promise<ArtifactRef[]> {
  if (ctx.gate.kind === "live") {
    ctx.log("entsoe-transparency: STUB — live discovery requires a registered securityToken; returning no artifacts");
    return [];
  }
  return [{ url: API_URL, name: "a75-actual-generation" }];
}

async function fetchArtifact(ref: ArtifactRef, ctx: ConnectorCtx): Promise<RawArtifact> {
  if (ctx.gate.kind === "live") {
    throw new Error("entsoe-transparency: live fetch requires securityToken (registration-required source; stub connector)");
  }
  const res = await ctx.gate.get(ref.url);
  if (res.status !== 200) {
    throw new Error(`entsoe-transparency: GET ${ref.url} returned HTTP ${res.status}`);
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
  const xml = raw.body.toString("utf8");
  const records: ParsedRecord[] = [];
  for (const series of xmlBlocks(xml, "TimeSeries")) {
    const eic = xmlText(series, "inBiddingZone_Domain.mRID") ?? xmlText(series, "outBiddingZone_Domain.mRID") ?? "";
    const psrType = xmlText(series, "psrType") ?? "";
    for (const period of xmlBlocks(series, "Period")) {
      const interval = xmlBlocks(period, "timeInterval")[0] ?? "";
      const start = xmlText(interval, "start") ?? "";
      const resolutionMin = resolutionMinutes(xmlText(period, "resolution") ?? "");
      for (const point of xmlBlocks(period, "Point")) {
        const position = Number(xmlText(point, "position") ?? "0");
        const quantity = Number(xmlText(point, "quantity") ?? "");
        records.push({
          table: "A75",
          row: { eic, psr_type: psrType, start, resolution_min: resolutionMin, position, quantity },
        });
      }
    }
  }
  return records;
}

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();

  for (const { table, row } of records) {
    if (table !== "A75") continue;
    const eic = fieldStr(row, "eic");
    const entityId = ctx.entityIndex.byEic(eic);
    if (entityId === undefined) {
      reportUnmapped(unmapped, eic);
      continue;
    }
    const quantity = fieldNum(row, "quantity");
    const position = fieldNum(row, "position");
    const resolutionMin = fieldNum(row, "resolution_min");
    const startMs = Date.parse(fieldStr(row, "start"));
    if (quantity === null || position === null || resolutionMin === null || !Number.isFinite(startMs)) continue;
    const eventMs = startMs + (position - 1) * resolutionMin * 60_000;
    observations.push(
      makeObservation({
        entity_id: entityId,
        metric: "grid.generation.mw",
        value: quantity,
        unit: "MW",
        event_time: new Date(eventMs).toISOString().replace(".000Z", "Z"),
        ingest_time: ingestTime,
        source_id: SOURCE_ID,
        feed_id: FEED_GENERATION,
        source_sequence: `${eic}:${fieldStr(row, "start")}:${position}`,
        meta: { psr_type: fieldStr(row, "psr_type") },
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
    error: "STUB: requires securityToken (free registration at transparency.entsoe.eu) — live verification not attempted",
    checked_at: ctx.now(),
  };
}

export const entsoeTransparency: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 15 * 60_000, jitterMs: 60_000 },
  discover,
  fetch: fetchArtifact,
  parse,
  normalize,
  verify,
};
