// AEMO connectors against their synthetic-from-spec fixtures, with an INLINE
// entity index (exact counts, exact mapping, exact unmapped reporting).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aemoNemwebDispatchis,
  aemoNemwebDispatchScada,
  aemoNemwebTradingis,
  aemoVisNemSummary,
} from "../dist/index.js";
import { entity, nemEntities, runPipeline, testCtx, FIXED_NOW } from "./helpers.mjs";

test("dispatchis: discover picks the newest ZIP from the dir listing", async () => {
  const ctx = testCtx(aemoNemwebDispatchis.id, nemEntities);
  const refs = await aemoNemwebDispatchis.discover(ctx);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "PUBLIC_DISPATCHIS_202608121105_0000000123456789.zip");
  assert.ok(refs[0].url.endsWith(refs[0].name));
});

test("dispatchis: full pipeline — exact observations, corrections, unmapped", async () => {
  const ctx = testCtx(aemoNemwebDispatchis.id, nemEntities);
  const { parsed, observations, unmapped } = await runPipeline(aemoNemwebDispatchis, ctx);
  assert.equal(parsed.length, 8); // 3 PRICE + 3 REGIONSUM + 2 INTERCONNECTORRES

  assert.equal(observations.length, 8);
  assert.deepEqual(unmapped.sort(), ["MADEUP-X1", "SA1"]);
  for (const obs of observations) {
    assert.equal(obs.event_time, "2026-08-12T01:05:00Z"); // 11:05 NEM = 01:05Z
    assert.equal(obs.ingest_time, FIXED_NOW);
    assert.equal(obs.source_id, "source:aemo:nemweb-dispatchis");
  }

  const price = observations.filter((o) => o.feed_id === "feed:au-nem:dispatch:price");
  assert.equal(price.length, 3);
  assert.deepEqual(
    price.map((o) => [o.entity_id, o.value, o.is_correction]),
    [
      ["region:au-nem:qld1", 84.5, false],
      ["region:au-nem:nsw1", 92.1, false],
      ["region:au-nem:nsw1", 95.75, true], // RUNNO=2 + INTERVENTION=1 re-run
    ],
  );
  assert.equal(price[0].source_sequence, "2026/08/12 11:05:00:1");
  assert.equal(price[2].source_sequence, "2026/08/12 11:05:00:2");

  const regionsum = observations.filter((o) => o.feed_id === "feed:au-nem:dispatch:regionsum");
  assert.equal(regionsum.length, 4); // QLD1+NSW1 × (demand, generation); SA1 dropped
  const qldDemand = regionsum.find((o) => o.entity_id === "region:au-nem:qld1" && o.metric === "grid.demand.mw");
  assert.equal(qldDemand.value, 6123.45);
  const qldGen = regionsum.find((o) => o.entity_id === "region:au-nem:qld1" && o.metric === "grid.generation.mw");
  assert.equal(qldGen.value, 5900.1); // DISPATCHABLEGENERATION preferred over AVAILABLEGENERATION

  const flows = observations.filter((o) => o.feed_id === "feed:au-nem:dispatch:interconnectorres");
  assert.equal(flows.length, 1);
  assert.equal(flows[0].entity_id, "intercon:au-nem:qni"); // byDuid("NSW1-QLD1")
  assert.equal(flows[0].metric, "intercon.flow.mw");
  assert.equal(flows[0].value, 350);
});

test("dispatch-scada: DUID mapping to station entities, unmapped DUID reported", async () => {
  const entities = [
    entity("gen:au-nem:gladstone-ps", "Generator", {
      aemo_duid: ["GSTONE1", "GSTONE2", "GSTONE3", "GSTONE4", "GSTONE5", "GSTONE6"],
    }),
    entity("gen:au-nem:callide-b", "Generator", { aemo_duid: ["CALL_B_1", "CALL_B_2"] }),
  ];
  const ctx = testCtx(aemoNemwebDispatchScada.id, entities);
  const { observations, unmapped } = await runPipeline(aemoNemwebDispatchScada, ctx);
  assert.equal(observations.length, 7); // GSTONE1..6 + CALL_B_1; NOMAP_1 dropped
  assert.deepEqual(unmapped, ["NOMAP_1"]);
  for (const obs of observations) {
    assert.equal(obs.metric, "power.output.mw");
    assert.equal(obs.feed_id, "feed:au-nem:dispatch:scada");
    assert.equal(obs.event_time, "2026-08-12T01:05:00Z");
  }
  const gladstone = observations.filter((o) => o.entity_id === "gen:au-nem:gladstone-ps");
  assert.equal(gladstone.length, 6);
  assert.deepEqual(new Set(gladstone.map((o) => o.meta.duid)).size, 6); // unit kept in meta
  const callide = observations.find((o) => o.entity_id === "gen:au-nem:callide-b");
  assert.equal(callide.value, 312.4);
});

test("tradingis: TRADING.PRICE on its own feed, distinct from dispatch price", async () => {
  const ctx = testCtx(aemoNemwebTradingis.id, nemEntities);
  const { observations, unmapped } = await runPipeline(aemoNemwebTradingis, ctx);
  assert.equal(observations.length, 2);
  assert.deepEqual(unmapped, ["SA1"]);
  assert.deepEqual(
    observations.map((o) => [o.feed_id, o.entity_id, o.metric, o.value]),
    [
      ["feed:au-nem:trading:price", "region:au-nem:qld1", "market.price.energy", 86.2],
      ["feed:au-nem:trading:price", "region:au-nem:nsw1", "market.price.energy", 93.4],
    ],
  );
  assert.equal(observations[0].source_id, "source:aemo:nemweb-tradingis");
});

test("vis-nem-summary: dashboard JSON → demand/generation/price per region", async () => {
  const ctx = testCtx(aemoVisNemSummary.id, nemEntities);
  const { parsed, observations, unmapped } = await runPipeline(aemoVisNemSummary, ctx);
  assert.equal(parsed.length, 3); // QLD1, NSW1, SA1 rows
  assert.equal(observations.length, 6); // 3 metrics × 2 mapped regions
  assert.deepEqual(unmapped, ["SA1"]);
  const qld = observations.filter((o) => o.entity_id === "region:au-nem:qld1");
  assert.equal(qld.find((o) => o.metric === "grid.demand.mw").value, 6123.45);
  // SCHEDULEDGENERATION + SEMISCHEDULEDGENERATION
  assert.ok(Math.abs(qld.find((o) => o.metric === "grid.generation.mw").value - 5900.1) < 1e-9);
  assert.equal(qld.find((o) => o.metric === "market.price.energy").value, 84.5);
  // dashboard "2026-08-12T11:05:00" NEM time converts like NEMWEB timestamps
  assert.equal(qld[0].event_time, "2026-08-12T01:05:00Z");
  assert.equal(qld[0].feed_id, "feed:au-nem:vis-nem-summary");
});
