// Stub connectors (entsoe-transparency, eia-v2): replay path fully works,
// live path honestly refuses (registration/api-key required).
import { test } from "node:test";
import assert from "node:assert/strict";
import { entsoeTransparency, eiaV2, xmlBlocks, xmlText } from "../dist/index.js";
import { entity, runPipeline, testCtx } from "./helpers.mjs";

const liveCtx = (base) => ({
  ...base,
  gate: {
    kind: "live",
    get: async () => {
      throw new Error("network must not be touched by stub connectors in live mode");
    },
  },
});

test("xml scanner: blocks and text extraction (dotted tags, attributes)", () => {
  const xml = "<A><B x=\"1\">one</B><B>two</B><c.d>dot</c.d></A>";
  assert.deepEqual(xmlBlocks(xml, "B"), ["one", "two"]);
  assert.equal(xmlText(xml, "c.d"), "dot");
  assert.equal(xmlText(xml, "missing"), undefined);
});

test("entsoe-transparency: A75 replay parse+normalize; EIC mapping; unmapped zone", async () => {
  const entities = [entity("grid:eu-test:zone", "Grid", { entsoe_eic: "10Y-TEST-ZONE--X" })];
  const ctx = testCtx(entsoeTransparency.id, entities);
  const { parsed, observations, unmapped } = await runPipeline(entsoeTransparency, ctx);
  assert.equal(parsed.length, 4); // 2 points × 2 TimeSeries
  assert.equal(observations.length, 2); // only the mapped zone survives
  assert.deepEqual(unmapped, ["10Y-UNMAPPED---Z"]);
  assert.deepEqual(
    observations.map((o) => [o.metric, o.value, o.event_time, o.meta.psr_type]),
    [
      ["grid.generation.mw", 640, "2026-08-12T00:00:00Z", "B05"],
      ["grid.generation.mw", 655, "2026-08-12T01:00:00Z", "B05"], // position 2 at PT60M
    ],
  );
  assert.equal(observations[0].feed_id, "feed:eu:entsoe:actual-generation");
});

test("entsoe-transparency: live discover returns [] and live fetch throws (no token, no fetch)", async () => {
  const ctx = liveCtx(testCtx(entsoeTransparency.id, []));
  assert.deepEqual(await entsoeTransparency.discover(ctx), []);
  await assert.rejects(() => entsoeTransparency.fetch({ url: "https://x", name: "x" }, ctx), /securityToken/);
  const report = await entsoeTransparency.verify(ctx);
  assert.equal(report.ok, false);
  assert.match(report.error, /securityToken/);
});

test("eia-v2: region-data replay parse+normalize; BA mapping via properties.eia_ba_code", async () => {
  const entities = [entity("grid:us-test:demo-ba", "Grid", {}, { eia_ba_code: "DEMO" })];
  const ctx = testCtx(eiaV2.id, entities);
  const { parsed, observations, unmapped } = await runPipeline(eiaV2, ctx);
  assert.equal(parsed.length, 3);
  assert.equal(observations.length, 2);
  assert.deepEqual(unmapped, ["NOBA"]);
  assert.deepEqual(
    observations.map((o) => [o.entity_id, o.metric, o.value, o.event_time]),
    [
      ["grid:us-test:demo-ba", "grid.demand.mw", 21450, "2026-08-12T00:00:00Z"],
      ["grid:us-test:demo-ba", "grid.demand.mw", 20980, "2026-08-12T01:00:00Z"],
    ],
  );
  assert.equal(observations[0].feed_id, "feed:us:eia:demand");
  assert.equal(observations[0].meta.source_units, "megawatthours");
});

test("eia-v2: live discover returns [] and live fetch throws (api key required)", async () => {
  const ctx = liveCtx(testCtx(eiaV2.id, []));
  assert.deepEqual(await eiaV2.discover(ctx), []);
  await assert.rejects(() => eiaV2.fetch({ url: "https://x", name: "x" }, ctx), /api_key/);
  const report = await eiaV2.verify(ctx);
  assert.equal(report.ok, false);
});
