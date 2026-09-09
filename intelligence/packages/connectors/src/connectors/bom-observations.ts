// bom-observations — Bureau of Meteorology station observations (JSON data
// feed products).
//
// Wire format bound from the published product format (e.g. IDQ60801,
// Queensland observations; per-station JSON at
// www.bom.gov.au/fwo/{product}/{product}.{wmo-id}.json):
//
//   { "observations": {
//       "notice": [...], "header": [...],
//       "data": [ { "wmo": 94381, "name": "Gladstone Airport",
//                   "aifstime_utc": "20260812013000",   // UTC, yyyymmddHHMMSS
//                   "air_temp": 18.4,                   // degC
//                   "wind_spd_kmh": 19, ... }, ... ] } }
//
// Weather stations are connector-owned entities: the NEM structural seed does
// not include them, so this connector exports `seedEntities` (the Gladstone
// AWS Sensor record) for the CLI to merge into the graph load. Consistent
// with the no-guessing rule, normalize() still DROPS rows whose station is
// not in the EntityIndex and reports the wmo id in `unmapped` — the seed
// mechanism, not a hardcoded bypass, is what makes the station resolvable.
// Built against the documented format only — fixtures are synthetic-from-spec.

import type { EntityRecord, TelemetryFeedRecord } from "@pact-tailor/ontology";
import type { ArtifactRef, Connector, ConnectorCtx, NormalizedOutput, ParsedRecord, RawArtifact } from "../sdk.js";
import { fieldNum, fieldStr, makeObservation, reportUnmapped } from "../observations.js";

const CONNECTOR_ID = "bom-observations";
const SOURCE_ID = "source:bom:observations";

const FEED_QLD_OBS = "feed:weather:bom:qld-obs";

/** Hardcoded station map: BOM product/WMO id → connector-owned Sensor entity. */
const STATIONS = [
  {
    product: "IDQ60801",
    wmo: "94381",
    url: "http://www.bom.gov.au/fwo/IDQ60801/IDQ60801.94381.json",
    entity_id: "sensor:au-qld:gladstone-aws",
    name: "Gladstone Airport AWS",
    lat: -23.87,
    lon: 151.22,
  },
] as const;

const feeds: TelemetryFeedRecord[] = [
  {
    feed_id: FEED_QLD_OBS,
    source_id: SOURCE_ID,
    connector_id: CONNECTOR_ID,
    metrics: ["weather.temp.c", "weather.wind.speed_ms"],
    cadence: "30min (10min at some stations)",
    description: "BOM AWS observations for the Gladstone industrial cluster",
    entity_scope: "Sensor (connector-owned weather stations)",
  },
];

const seedEntities: EntityRecord[] = STATIONS.map((station) => ({
  entity_id: station.entity_id,
  entity_type: "Sensor",
  name: station.name,
  data_class: "structural",
  observability: "KNOWN_LIVE",
  geometry: { type: "Point", coordinates: [station.lon, station.lat] },
  country: "au",
  admin: { region: "qld", locality: "gladstone" },
  grid_id: null,
  properties: { sensor_kind: "weather_station", bom_product: station.product, bom_wmo: station.wmo },
  external_ids: {},
  sources: [SOURCE_ID],
  notes:
    "Connector-owned weather-station entity seeded by the bom-observations connector (not part of the NEM structural seed).",
}));

/** "20260812013000" (BOM aifstime_utc, already UTC) → ISO-8601 UTC. */
export function bomTimeToIso(aifstimeUtc: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(aifstimeUtc.trim());
  if (!m) throw new Error(`bom-observations: unrecognised aifstime_utc "${aifstimeUtc}"`);
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

async function discover(_ctx: ConnectorCtx): Promise<ArtifactRef[]> {
  return STATIONS.map((station) => ({
    url: station.url,
    name: `${station.product}.${station.wmo}`,
    meta: { wmo: station.wmo },
  }));
}

async function fetchArtifact(ref: ArtifactRef, ctx: ConnectorCtx): Promise<RawArtifact> {
  const res = await ctx.gate.get(ref.url);
  if (res.status !== 200) {
    throw new Error(`bom-observations: GET ${ref.url} returned HTTP ${res.status}`);
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
  const doc = JSON.parse(raw.body.toString("utf8")) as { observations?: { data?: unknown } };
  const data = doc.observations?.data;
  const rows = Array.isArray(data) ? data : [];
  const records: ParsedRecord[] = [];
  for (const entry of rows) {
    if (entry === null || typeof entry !== "object") continue;
    const src = entry as Record<string, unknown>;
    const row: Record<string, string | number> = {};
    for (const key of ["wmo", "name", "aifstime_utc", "air_temp", "wind_spd_kmh"]) {
      const v = src[key];
      // BOM uses null / "-" for missing values; keep only real strings/numbers.
      if (typeof v === "number" || (typeof v === "string" && v !== "-")) row[key] = v;
    }
    records.push({ table: "observations", row });
  }
  return records;
}

const KMH_TO_MS = 1 / 3.6;

function normalize(records: ParsedRecord[], ctx: ConnectorCtx): NormalizedOutput {
  const observations: NormalizedOutput["observations"] = [];
  const unmapped: string[] = [];
  const ingestTime = ctx.now();
  const stationByWmo = new Map<string, (typeof STATIONS)[number]>(STATIONS.map((s) => [s.wmo, s]));

  for (const { table, row } of records) {
    if (table !== "observations") continue;
    const wmo = fieldStr(row, "wmo");
    const station = stationByWmo.get(wmo);
    // Unknown station, or station entity absent from the index (seed not
    // merged): DROP and report — never emit against an unresolvable entity.
    if (station === undefined || !ctx.entityIndex.has(station.entity_id)) {
      reportUnmapped(unmapped, wmo);
      continue;
    }
    const aifstime = fieldStr(row, "aifstime_utc");
    if (aifstime === "") continue;
    const common = {
      entity_id: station.entity_id,
      event_time: bomTimeToIso(aifstime),
      ingest_time: ingestTime,
      source_id: SOURCE_ID,
      feed_id: FEED_QLD_OBS,
      source_sequence: `${wmo}:${aifstime}`,
      meta: { wmo, station: fieldStr(row, "name") },
    };
    const airTemp = fieldNum(row, "air_temp");
    if (airTemp !== null) {
      observations.push(makeObservation({ ...common, metric: "weather.temp.c", value: airTemp, unit: "degC" }));
    }
    const windKmh = fieldNum(row, "wind_spd_kmh");
    if (windKmh !== null) {
      observations.push(
        makeObservation({
          ...common,
          metric: "weather.wind.speed_ms",
          value: Math.round(windKmh * KMH_TO_MS * 100) / 100,
          unit: "m/s",
        }),
      );
    }
  }
  return { observations, unmapped };
}

export const bomObservations: Connector = {
  id: CONNECTOR_ID,
  source_id: SOURCE_ID,
  feeds,
  schedule: { intervalMs: 30 * 60_000, jitterMs: 120_000 },
  discover,
  fetch: fetchArtifact,
  parse,
  normalize,
  seedEntities,
};
