// aisstream (MessageGate replay) and bom-observations, with inline entities —
// the vessel entities deliberately carry the synthetic exemplar MMSIs
// (503000001..503000003) so these tests do not depend on the data/ lane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aisstream, bomObservations, aisTimeToIso, GLADSTONE_BBOX } from "../dist/index.js";
import { entity, runPipeline, testCtx } from "./helpers.mjs";

const vesselEntities = [
  entity("vessel:au:synthetic-demo-1", "Vessel", { mmsi: "503000001" }, { synthetic: true }),
  entity("vessel:au:synthetic-demo-2", "Vessel", { mmsi: "503000002" }, { synthetic: true }),
  entity("vessel:au:synthetic-demo-3", "Vessel", { mmsi: "503000003" }, { synthetic: true }),
];

test("aisTimeToIso: Go-style aisstream timestamps", () => {
  assert.equal(aisTimeToIso("2026-08-12 01:00:00.000000000 +0000 UTC"), "2026-08-12T01:00:00Z");
  assert.equal(aisTimeToIso("2026-08-12 01:05:00 +0000 UTC"), "2026-08-12T01:05:00Z");
  assert.throws(() => aisTimeToIso("yesterday"), /unrecognised time_utc/);
});

test("aisstream: bbox constant covers Gladstone harbour ([lat,lon] order)", () => {
  const [[lat1, lon1], [lat2, lon2]] = GLADSTONE_BBOX;
  assert.ok(lat1 < -23.8 && lat2 > -23.9); // straddles the harbour latitude
  assert.ok(lon1 < 151.2 && lon2 > 151.3);
});

test("aisstream: replayed window → position/speed/draught obs, unmapped MMSIs dropped", async () => {
  const ctx = testCtx(aisstream.id, vesselEntities);
  const { raws, parsed, observations, unmapped } = await runPipeline(aisstream, ctx);
  assert.equal(raws.length, 1);
  assert.equal(raws[0].content_type, "application/x-ndjson");
  assert.equal(parsed.length, 20); // 18 PositionReports + 2 ShipStaticData

  // 15 mapped PositionReports × (position + speed) + 1 mapped ShipStaticData draught
  assert.equal(observations.length, 31);
  assert.deepEqual(unmapped, ["999999999"]);

  const positions = observations.filter((o) => o.metric === "vessel.position");
  assert.equal(positions.length, 15);
  const first = positions.find((o) => o.entity_id === "vessel:au:synthetic-demo-1");
  assert.equal(first.event_time, "2026-08-12T01:00:00Z");
  assert.deepEqual(first.value, { lat: -23.82, lon: 151.25, speed_kn: 8.2, heading_deg: 121 });
  assert.equal(first.feed_id, "feed:maritime:aisstream:gladstone");
  assert.equal(first.source_id, "source:aisstream:websocket");

  // TrueHeading 511 (unavailable sentinel) must not become a heading
  const demo2 = positions.find((o) => o.entity_id === "vessel:au:synthetic-demo-2");
  assert.equal(demo2.value.heading_deg, undefined);
  assert.equal(demo2.value.speed_kn, 0.1);

  const speeds = observations.filter((o) => o.metric === "vessel.speed.kn");
  assert.equal(speeds.length, 15);

  const draughts = observations.filter((o) => o.metric === "vessel.draught.m");
  assert.equal(draughts.length, 1); // mapped ShipStaticData only
  assert.equal(draughts[0].value, 10.5);
  assert.equal(draughts[0].entity_id, "vessel:au:synthetic-demo-1");
});

test("aisstream: fetch without a MessageGate fails loudly", async () => {
  const ctx = { ...testCtx(aisstream.id, vesselEntities), messageGate: undefined };
  await assert.rejects(() => aisstream.fetch({ url: "wss://x", name: "w" }, ctx), /messageGate is required/);
});

test("bom-observations: seeded Sensor entity → temp + wind observations", async () => {
  // The connector exports its own Sensor seed; merging it is exactly what the
  // CLI does. wind km/h → m/s.
  const ctx = testCtx(bomObservations.id, bomObservations.seedEntities);
  const { observations, unmapped } = await runPipeline(bomObservations, ctx);
  assert.equal(observations.length, 6); // 3 rows × (temp, wind)
  assert.deepEqual(unmapped, []);
  for (const obs of observations) {
    assert.equal(obs.entity_id, "sensor:au-qld:gladstone-aws");
    assert.equal(obs.feed_id, "feed:weather:bom:qld-obs");
  }
  const temps = observations.filter((o) => o.metric === "weather.temp.c");
  assert.deepEqual(temps.map((o) => o.value), [18.4, 18.1, 17.8]);
  assert.equal(temps[0].event_time, "2026-08-12T01:30:00Z"); // aifstime_utc is already UTC
  const winds = observations.filter((o) => o.metric === "weather.wind.speed_ms");
  assert.deepEqual(winds.map((o) => o.value), [5.28, 4.72, 4.17]); // 19/17/15 km/h → m/s
});

test("bom-observations: station absent from the index → rows DROPPED and wmo reported", async () => {
  const ctx = testCtx(bomObservations.id, []); // seed NOT merged
  const { observations, unmapped } = await runPipeline(bomObservations, ctx);
  assert.equal(observations.length, 0);
  assert.deepEqual(unmapped, ["94381"]);
});

test("bom-observations: seedEntities is a valid connector-owned Sensor record", () => {
  assert.equal(bomObservations.seedEntities.length, 1);
  const seed = bomObservations.seedEntities[0];
  assert.equal(seed.entity_id, "sensor:au-qld:gladstone-aws");
  assert.equal(seed.entity_type, "Sensor");
  assert.deepEqual(seed.sources, ["source:bom:observations"]);
});
