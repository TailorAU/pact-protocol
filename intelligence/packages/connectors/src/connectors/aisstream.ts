// aisstream — real-time AIS via aisstream.io's websocket, scoped to the
// Gladstone harbour approaches.
//
// Wire format bound from the published documentation
// (https://aisstream.io/documentation):
//
//   subscribe (first message after connect):
//     { "APIKey": "...", "BoundingBoxes": [[[lat1, lon1], [lat2, lon2]]],
//       "FilterMessageTypes": ["PositionReport", "ShipStaticData"] }
//
//   incoming message:
//     { "MessageType": "PositionReport" | "ShipStaticData" | ...,
//       "MetaData": { "MMSI": 503000001, "ShipName": "...", "latitude": ...,
//                     "longitude": ..., "time_utc": "2026-08-12 01:00:00.000000000 +0000 UTC" },
//       "Message": { "PositionReport": { "Sog": 8.2, "Cog": 123.4,
//                    "TrueHeading": 121, ... },
//                    "ShipStaticData": { "MaximumStaticDraught": 10.5, ... } } }
//
// A fetch() collects one bounded window of messages through the MessageGate
// (replay: the committed JSONL fixture, zero delay; live: a real ws window)
// and stores them as one NDJSON bronze artifact. Built against the documented
// format only — fixtures are synthetic-from-spec, and the fixture MMSIs
// (503000001..503000003) are synthetic exemplar vessels, not real ships.

import type { TelemetryFeedRecord, VesselPositionValue } from "@pact-tailor/ontology";
import type { ArtifactRef, Connector, ConnectorCtx, NormalizedOutput, ParsedRecord, RawArtifact, VerificationReport } from "../sdk.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";

const CONNECTOR_ID = "aisstream";
const SOURCE_ID = "source:aisstream:websocket";
const STREAM_URL = "wss://stream.aisstream.io/v0/stream";

/**
 * Gladstone harbour + approaches bounding box, [[lat1, lon1], [lat2, lon2]]
 * (aisstream's documented coordinate order is [lat, lon]).
 */
export const GLADSTONE_BBOX: [[number, number], [number, number]] = [
  [-24.1, 150.9],
  [-23.6, 151.6],
];

const FEED_POSITIONS = "feed:maritime:aisstream:gladstone";

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_POSITIONS,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["vessel.position", "vessel.speed.kn", "vessel.draught.m"],
    cadence: "streaming (per received AIS message)",
    description: "AIS PositionReport/ShipStaticData for the Gladstone harbour bounding box",
    entity_scope: "Vessel (external_ids.mmsi)",
  },
];

/** "2026-08-12 01:00:00.000000000 +0000 UTC" (Go time formatting) → ISO UTC. */
export function aisTimeToIso(timeUtc: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s+\+0000\s+UTC$/.exec(timeUtc.trim());
  if (!m) throw new Error(`aisstream: unrecognised time_utc "${timeUtc}"`);
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

async function discover(_ctx: ConnectorCtx): Promise<ArtifactRef[]> {
  return [{ url: STREAM_URL, name: "aisstream-gladstone-window", meta: { bbox: GLADSTONE_BBOX } }];
}

function subscribePayload(): Record<string, unknown> {
  return {
    APIKey: process.env["AISSTREAM_API_KEY"] ?? "",
    BoundingBoxes: [GLADSTONE_BBOX],
    FilterMessageTypes: ["PositionReport", "ShipStaticData"],
  };
}

async function fetchArtifact(ref: ArtifactRef, ctx: ConnectorCtx): Promise<RawArtifact> {
  const gate = ctx.messageGate;
  if (gate === undefined) {
    throw new Error("aisstream: ConnectorCtx.messageGate is required (websocket source)");
  }
  const messages = await gate.collect(ref.url, subscribePayload(), { windowMs: 30_000, maxMessages: 500 });
  return {
    ref,
    body: Buffer.from(messages.map((m) => m.toString("utf8")).join("\n"), "utf8"),
    fetched_at: ctx.now(),
    // Streams have no HTTP status; 200 records "window collected successfully".
    http_status: 200,
    content_type: "application/x-ndjson",
  };
}

interface AisMessage {
  MessageType?: string;
  MetaData?: {
    MMSI?: number;
    ShipName?: string;
    latitude?: number;
    longitude?: number;
    time_utc?: string;
  };
  Message?: {
    PositionReport?: { Sog?: number; Cog?: number; TrueHeading?: number };
    ShipStaticData?: { MaximumStaticDraught?: number; Destination?: string };
  };
}

async function parse(raw: RawArtifact): Promise<ParsedRecord[]> {
  const records: ParsedRecord[] = [];
  for (const line of raw.body.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line) as AisMessage;
    const meta = msg.MetaData ?? {};
    const row: Record<string, string | number> = {
      MMSI: meta.MMSI ?? 0,
      ShipName: (meta.ShipName ?? "").trim(),
      latitude: meta.latitude ?? Number.NaN,
      longitude: meta.longitude ?? Number.NaN,
      time_utc: meta.time_utc ?? "",
    };
    const position = msg.Message?.PositionReport;
    if (position !== undefined) {
      if (position.Sog !== undefined) row["Sog"] = position.Sog;
      if (position.Cog !== undefined) row["Cog"] = position.Cog;
      if (position.TrueHeading !== undefined) row["TrueHeading"] = position.TrueHeading;
    }
    const staticData = msg.Message?.ShipStaticData;
    if (staticData !== undefined) {
      if (staticData.MaximumStaticDraught !== undefined) row["MaximumStaticDraught"] = staticData.MaximumStaticDraught;
      if (staticData.Destination !== undefined) row["Destination"] = staticData.Destination.trim();
    }
    records.push({ table: msg.MessageType ?? "Unknown", row });
  }
  return records;
}

/** AIS "heading unavailable" sentinel per ITU-R M.1371. */
const HEADING_UNAVAILABLE = 511;

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();

  for (const { table, row } of records) {
    const mmsi = fieldStr(row, "MMSI");
    const entityId = ctx.entityIndex.byMmsi(mmsi);
    if (entityId === undefined) {
      reportUnmapped(unmapped, mmsi);
      continue;
    }
    const timeUtc = fieldStr(row, "time_utc");
    const eventTime = aisTimeToIso(timeUtc);
    const common = {
      entity_id: entityId,
      event_time: eventTime,
      ingest_time: ingestTime,
      source_id: SOURCE_ID,
      feed_id: FEED_POSITIONS,
      source_sequence: `${mmsi}:${timeUtc}`,
    };

    if (table === "PositionReport") {
      const lat = fieldNum(row, "latitude");
      const lon = fieldNum(row, "longitude");
      if (lat === null || lon === null) continue;
      const sog = fieldNum(row, "Sog");
      const heading = fieldNum(row, "TrueHeading");
      const value: VesselPositionValue = {
        lat,
        lon,
        ...(sog !== null ? { speed_kn: sog } : {}),
        ...(heading !== null && heading !== HEADING_UNAVAILABLE ? { heading_deg: heading } : {}),
      };
      const cog = fieldNum(row, "Cog");
      observations.push(
        makeObservation({
          ...common,
          metric: "vessel.position",
          value,
          ...(cog !== null ? { meta: { cog } } : {}),
        }),
      );
      if (sog !== null) {
        observations.push(makeObservation({ ...common, metric: "vessel.speed.kn", value: sog, unit: "kn" }));
      }
    } else if (table === "ShipStaticData") {
      const draught = fieldNum(row, "MaximumStaticDraught");
      if (draught !== null && draught > 0) {
        observations.push(
          makeObservation({
            ...common,
            metric: "vessel.draught.m",
            value: draught,
            unit: "m",
            meta: { destination: fieldStr(row, "Destination") },
          }),
        );
      }
    }
  }
  return { observations, unmapped };
}

async function verify(ctx: ConnectorCtx): Promise<VerificationReport> {
  const checkedAt = ctx.now();
  if ((process.env["AISSTREAM_API_KEY"] ?? "") === "") {
    return {
      connector_id: CONNECTOR_ID,
      source_id: SOURCE_ID,
      ok: false,
      error: "AISSTREAM_API_KEY not set — aisstream requires a (free) registered API key",
      checked_at: checkedAt,
    };
  }
  const gate = ctx.messageGate;
  if (gate === undefined) {
    return { connector_id: CONNECTOR_ID, source_id: SOURCE_ID, ok: false, error: "no MessageGate", checked_at: checkedAt };
  }
  try {
    const messages = await gate.collect(STREAM_URL, subscribePayload(), { windowMs: 10_000, maxMessages: 5 });
    return {
      connector_id: CONNECTOR_ID,
      source_id: SOURCE_ID,
      ok: messages.length > 0,
      ...(messages.length === 0 ? { error: "connected but received no messages in the probe window" } : {}),
      checked_at: checkedAt,
      notes: `${messages.length} message(s) in probe window`,
    };
  } catch (err) {
    return {
      connector_id: CONNECTOR_ID,
      source_id: SOURCE_ID,
      ok: false,
      error: (err as Error).message,
      checked_at: checkedAt,
    };
  }
}

export const aisstream: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 60_000, jitterMs: 10_000 },
  discover,
  fetch: fetchArtifact,
  parse,
  normalize,
  verify,
};
