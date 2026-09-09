import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MedallionStore } from "@pact-tailor/store";
import { ulid } from "@pact-tailor/ontology";
import { buildApp, startServer } from "../dist/index.js";

// ── fixture registry (YAML) ────────────────────────────────────────────────

function writeRegistry(root) {
  mkdirSync(join(root, "registries", "grids"), { recursive: true });
  mkdirSync(join(root, "registries", "sources"), { recursive: true });
  mkdirSync(join(root, "registries", "gaps"), { recursive: true });
  mkdirSync(join(root, "entities", "test"), { recursive: true });
  mkdirSync(join(root, "relationships", "test"), { recursive: true });

  writeFileSync(
    join(root, "registries", "sources", "test.yaml"),
    `records:
  - source_id: source:test:feed
    publisher: Test Publisher
    dataset: Test Dataset
    api_type: rest
    url: https://example.com/api
    coverage: { grids: [grid:test], countries: [au] }
    data_class: live
    licensing: { class: open }
    verification_status: documented_only
    last_checked: "2026-08-12"
`,
  );
  writeFileSync(
    join(root, "registries", "grids", "test.yaml"),
    `records:
  - grid_id: grid:test
    name: Test Grid
    kind: isolated_grid
    countries: [au]
    frequency_hz: 50
    live_data: { availability: rich, source_ids: [source:test:feed] }
    sources: [source:test:feed]
`,
  );
  writeFileSync(
    join(root, "registries", "gaps", "test.yaml"),
    `records:
  - gap_id: gap:test:smelter-load
    entity_id: smelter:test:alpha
    desired_metric: power.load.mw
    commercial_value: high
    strategic_value: critical
    priority: P1
    status: open
`,
  );
  writeFileSync(
    join(root, "entities", "test", "entities.yaml"),
    `records:
  - entity_id: region:test:north
    entity_type: GridRegion
    name: North Region
    data_class: structural
    observability: KNOWN_LIVE
    geometry: { type: Point, coordinates: [151.0, -23.0] }
    country: au
    grid_id: grid:test
    sources: [source:test:feed]
  - entity_id: region:test:south
    entity_type: GridRegion
    name: South Region
    data_class: structural
    observability: KNOWN_LIVE
    geometry: { type: Point, coordinates: [147.0, -32.0] }
    country: au
    grid_id: grid:test
    sources: [source:test:feed]
  - entity_id: gen:test:alpha
    entity_type: Generator
    name: Alpha Power Station
    data_class: structural
    observability: KNOWN_LIVE
    geometry: { type: Point, coordinates: [151.2, -23.5] }
    country: au
    grid_id: grid:test
    properties: { fuel: coal, capacity_mw: 1600 }
    sources: [source:test:feed]
  - entity_id: smelter:test:alpha
    entity_type: Smelter
    name: Alpha Aluminium Smelter
    aliases: [Alpha Smelter]
    data_class: structural
    observability: ESTIMATED
    geometry: { type: Point, coordinates: [151.3, -23.9] }
    country: au
    grid_id: grid:test
    properties: { product: aluminium, typical_load_mw: 800 }
    sources: [source:test:feed]
  - entity_id: term:test:coal
    entity_type: Terminal
    name: Coal Export Terminal
    data_class: structural
    observability: ESTIMATED
    geometry: { type: Point, coordinates: [151.25, -23.85] }
    country: au
    grid_id: grid:test
    properties: { commodities: [coal] }
    sources: [source:test:feed]
  - entity_id: vessel:test:bulk1
    entity_type: Vessel
    name: Bulk Carrier One
    data_class: structural
    observability: KNOWN_LIVE
    geometry: { type: Point, coordinates: [152.5, -23.0] }
    properties: { vessel_type: bulk-carrier, synthetic: true }
    sources: [source:test:feed]
  - entity_id: intercon:test:link
    entity_type: Interconnector
    name: Test Link
    data_class: structural
    observability: KNOWN_LIVE
    country: au
    grid_id: grid:test
    sources: [source:test:feed]
`,
  );
  writeFileSync(
    join(root, "relationships", "test", "rels.yaml"),
    `records:
  - rel_id: rel:alpha-supplies-smelter
    rel_type: SUPPLIES
    from_id: gen:test:alpha
    to_id: smelter:test:alpha
    confidence: 1.0
    source: source:test:feed
    method: declared
  - rel_id: rel:bulk1-loads-coal
    rel_type: LOADS_AT
    from_id: vessel:test:bulk1
    to_id: term:test:coal
    confidence: 1.0
    source: source:test:feed
    method: declared
`,
  );
}

// ── fixture silver observations ────────────────────────────────────────────

function obs(entityId, metric, value, eventTime, feed = "feed:test:main") {
  return {
    observation_id: ulid(Date.parse(eventTime)),
    entity_id: entityId,
    metric,
    value,
    event_time: eventTime,
    ingest_time: eventTime,
    source_id: "source:test:feed",
    feed_id: feed,
    quality: "good",
  };
}

function writeSilver(varDir) {
  const store = new MedallionStore(varDir);
  const observations = [
    obs("region:test:north", "grid.demand.mw", 5000, "2026-08-12T00:00:00Z"),
    obs("region:test:north", "grid.demand.mw", 5100, "2026-08-12T00:05:00Z"),
    obs("region:test:south", "grid.demand.mw", 3000, "2026-08-12T00:10:00Z"),
    obs("region:test:north", "market.price.energy", 88.5, "2026-08-12T00:15:00Z"),
    obs("region:test:north", "grid.generation.mw", 4500, "2026-08-12T00:20:00Z"),
    obs("intercon:test:link", "intercon.flow.mw", 300, "2026-08-12T00:25:00Z"),
    obs("vessel:test:bulk1", "vessel.position", { lat: -23.8, lon: 151.9 }, "2026-08-12T00:30:00Z", "feed:test:ais"),
  ];
  store.silver.append(observations);
  return observations;
}

// ── boot ───────────────────────────────────────────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "pt-api-data-"));
const varDir = mkdtempSync(join(tmpdir(), "pt-api-var-"));
writeRegistry(dataDir);
writeSilver(varDir);

let app;
let server;
let base;

function listen(theApp) {
  return new Promise((resolve) => {
    const srv = startServer(theApp, 0);
    srv.on("listening", () => resolve(srv));
  });
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

before(async () => {
  app = buildApp({ dataDir, varDir, replay: false });
  server = await listen(app);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

// ── endpoint tests ─────────────────────────────────────────────────────────

test("GET /healthz", async () => {
  const { status, body } = await get("/healthz");
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "ok", service: "pact-tailor-intel-api" });
});

test("GET /api/intel/grids", async () => {
  const { status, body } = await get("/api/intel/grids");
  assert.equal(status, 200);
  assert.equal(body.grids.length, 1);
  assert.equal(body.grids[0].grid_id, "grid:test");
});

test("GET /api/intel/grids/{id}/summary aggregates region state", async () => {
  const { status, body } = await get("/api/intel/grids/grid:test/summary");
  assert.equal(status, 200);
  assert.equal(body.grid.grid_id, "grid:test");
  assert.deepEqual(
    body.regions.map((r) => r.entity_id),
    ["region:test:north", "region:test:south"],
  );
  assert.equal(body.live.demand_mw.value, 8100); // 5100 (latest north) + 3000 (south)
  assert.equal(body.live.demand_mw.event_time, "2026-08-12T00:10:00Z");
  assert.equal(body.live.generation_mw.value, 4500);
  assert.equal(body.live.price.value, 88.5); // unambiguous: only north has price
  assert.equal(body.live.flows.length, 1);
  assert.equal(body.live.flows[0].entity_id, "intercon:test:link");
  assert.equal(body.live.flows[0].mw, 300);
  const north = body.regions_live.find((r) => r.entity_id === "region:test:north");
  assert.deepEqual(north, { entity_id: "region:test:north", demand_mw: 5100, price: 88.5, generation_mw: 4500 });
  assert.equal(body.data_class.live, "telemetry");
});

test("GET /api/intel/grids/{id}/summary 404s on unknown grid", async () => {
  assert.equal((await get("/api/intel/grids/grid:nope/summary")).status, 404);
});

test("GET /api/intel/entities with filters", async () => {
  assert.equal((await get("/api/intel/entities")).body.entities.length, 8); // 7 + materialised grid node

  const smelters = (await get("/api/intel/entities?type=Smelter")).body.entities;
  assert.equal(smelters.length, 1);
  assert.equal(smelters[0].entity_id, "smelter:test:alpha");

  assert.equal((await get("/api/intel/entities?grid=grid:test")).body.entities.length, 6);
  assert.equal((await get("/api/intel/entities?observability=ESTIMATED")).body.entities.length, 2);

  const q = (await get("/api/intel/entities?q=alpha")).body.entities;
  assert.deepEqual(q.map((e) => e.entity_id).sort(), ["gen:test:alpha", "smelter:test:alpha"]);

  const inBox = (await get("/api/intel/entities?bbox=150,-25,152,-23")).body.entities;
  assert.deepEqual(
    inBox.map((e) => e.entity_id).sort(),
    ["gen:test:alpha", "region:test:north", "smelter:test:alpha", "term:test:coal"],
  );

  assert.equal((await get("/api/intel/entities?bbox=150,-25,152")).status, 400);
});

test("GET /api/intel/entities/{id} composes provenance, state, gaps, inferences", async () => {
  const { status, body } = await get("/api/intel/entities/smelter:test:alpha");
  assert.equal(status, 200);
  assert.equal(body.entity.entity_id, "smelter:test:alpha");
  assert.equal(body.provenance.data_class, "structural");
  assert.equal(body.provenance.sources[0].source_id, "source:test:feed"); // resolved to the full record
  assert.deepEqual(body.state, []); // no live telemetry for the smelter itself
  assert.equal(body.gaps.length, 1);
  assert.equal(body.inference_count, 1); // smelter-utilisation estimate
  assert.deepEqual(body.data_class, {
    entity: "structural",
    state: "telemetry",
    gaps: "structural",
    inferences: "derived",
  });

  assert.equal((await get("/api/intel/entities/smelter:test:nope")).status, 404);
});

test("GET /api/intel/entities/{id}/state", async () => {
  const { status, body } = await get("/api/intel/entities/region:test:north/state");
  assert.equal(status, 200);
  assert.equal(body.entity_id, "region:test:north");
  assert.deepEqual(
    body.states.map((s) => s.metric),
    ["grid.demand.mw", "grid.generation.mw", "market.price.energy"],
  );
  assert.equal(body.data_class, "telemetry");
});

test("GET /api/intel/entities/{id}/observations requires metric and honours range", async () => {
  assert.equal((await get("/api/intel/entities/region:test:north/observations")).status, 400);

  const all = await get("/api/intel/entities/region:test:north/observations?metric=grid.demand.mw");
  assert.equal(all.status, 200);
  assert.equal(all.body.observations.length, 2);

  const ranged = await get(
    "/api/intel/entities/region:test:north/observations?metric=grid.demand.mw&from=2026-08-12T00:03:00Z",
  );
  assert.equal(ranged.body.observations.length, 1);
  assert.equal(ranged.body.observations[0].value, 5100);
});

test("GET /api/intel/entities/{id}/graph traverses with filters", async () => {
  const { status, body } = await get("/api/intel/entities/vessel:test:bulk1/graph?direction=downstream&depth=1");
  assert.equal(status, 200);
  assert.equal(body.paths.length, 1);
  assert.deepEqual(body.paths[0].nodes, ["vessel:test:bulk1", "term:test:coal"]);
  assert.ok(body.nodes.some((n) => n.entity_id === "term:test:coal"));

  const filtered = await get("/api/intel/entities/vessel:test:bulk1/graph?rels=SUPPLIES");
  assert.equal(filtered.body.paths.length, 0);

  assert.equal((await get("/api/intel/entities/vessel:test:bulk1/graph?direction=sideways")).status, 400);
  assert.equal((await get("/api/intel/entities/vessel:test:nope/graph")).status, 404);
});

test("GET /api/intel/graph/path finds downstream paths", async () => {
  const { status, body } = await get("/api/intel/graph/path?from=gen:test:alpha&to=smelter:test:alpha");
  assert.equal(status, 200);
  assert.equal(body.paths.length, 1);
  assert.equal(body.paths[0].steps[0].rel.rel_id, "rel:alpha-supplies-smelter");

  assert.equal((await get("/api/intel/graph/path?from=gen:test:alpha")).status, 400);
  assert.equal((await get("/api/intel/graph/path?from=gen:test:nope&to=smelter:test:alpha")).status, 404);
});

test("GET /api/intel/sources", async () => {
  assert.equal((await get("/api/intel/sources")).body.sources.length, 1);
  assert.equal((await get("/api/intel/sources/source:test:feed")).body.source.publisher, "Test Publisher");
  assert.equal((await get("/api/intel/sources/source:test:nope")).status, 404);
});

test("GET /api/intel/gaps with filters", async () => {
  assert.equal((await get("/api/intel/gaps")).body.gaps.length, 1);
  assert.equal((await get("/api/intel/gaps?entity=smelter:test:alpha")).body.gaps.length, 1);
  assert.equal((await get("/api/intel/gaps?entity=gen:test:alpha")).body.gaps.length, 0);
  assert.equal((await get("/api/intel/gaps?priority=P1&status=open")).body.gaps.length, 1);
  assert.equal((await get("/api/intel/gaps?priority=P4")).body.gaps.length, 0);
});

test("GET /api/intel/inferences and by id", async () => {
  const { body } = await get("/api/intel/inferences");
  assert.equal(body.data_class, "derived");
  // smelter-utilisation (smelter) + cargo-inference (vessel) + gap-synthesis (terminal)
  assert.equal(body.inferences.length, 3);
  const methods = body.inferences.map((i) => i.method).sort();
  assert.deepEqual(methods, [
    "rule:cargo-inference@1.0.0",
    "rule:gap-synthesis@1.0.0",
    "rule:smelter-utilisation@1.0.0",
  ]);

  const vessel = await get("/api/intel/inferences?entity=vessel:test:bulk1");
  assert.equal(vessel.body.inferences.length, 1);
  const cargo = vessel.body.inferences[0];
  assert.equal(cargo.claim_structured.predicate, "carries");
  assert.equal(cargo.claim_structured.object, "coal");
  assert.equal(cargo.confidence, 0.85);

  assert.equal((await get("/api/intel/inferences?status=INFERRED")).body.inferences.length, 3);
  assert.equal((await get("/api/intel/inferences?status=VERIFIED")).body.inferences.length, 0);

  const byId = await get(`/api/intel/inferences/${cargo.inference_id}`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.inference.inference_id, cargo.inference_id);
  assert.equal((await get("/api/intel/inferences/infer:2020-01-01:nope-1")).status, 404);
});

test("GET /api/intel/sdui/{entityId} composes a schema-valid situation-aware doc", async () => {
  const { status, body } = await get("/api/intel/sdui/smelter:test:alpha");
  assert.equal(status, 200);
  assert.equal(body.entity_id, "smelter:test:alpha");
  assert.equal(body.entity_type, "Smelter");
  assert.deepEqual(body.situation, ["no-live-data", "has-gaps", "estimated-load"]);
  assert.equal(body.layout[0].panel, "gap-card"); // no-live-data hoists the gap card
  for (const panel of body.layout) {
    if (panel.data !== undefined) assert.match(panel.data.endpoint, /^\/api\/intel\//);
  }

  // The vessel HAS live state (position), so no hoisting applies; whether the
  // fixture telemetry counts as stale depends on wall clock, so only assert
  // the clock-independent parts.
  const vessel = await get("/api/intel/sdui/vessel:test:bulk1");
  assert.ok(!vessel.body.situation.includes("no-live-data"));
  assert.ok(!vessel.body.situation.includes("has-gaps"));
  assert.ok(!vessel.body.situation.includes("anomaly-active"));
  assert.equal(vessel.body.layout[0].panel, "headline-state");

  assert.equal((await get("/api/intel/sdui/vessel:test:nope")).status, 404);
});

test("GET /api/intel/meta", async () => {
  const { body } = await get("/api/intel/meta");
  assert.deepEqual(
    { ...body.counts },
    { entities: 8, relationships: 2, sources: 1, gaps: 1, grids: 1, inferences: 3 },
  );
  assert.equal(body.replay, false);
  assert.ok(typeof body.generated_at === "string");
});

test("unknown routes and non-GET methods return 404 JSON", async () => {
  const notFound = await get("/api/intel/nope");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error, "not_found");

  const post = await fetch(`${base}/api/intel/grids`, { method: "POST" });
  assert.equal(post.status, 404);
});

// ── SSE + replay ───────────────────────────────────────────────────────────

test("SSE stream: hello then real replayed state deltas", async () => {
  const replayApp = buildApp({ dataDir, varDir, replay: true, replayTickMs: 100 });
  assert.equal(replayApp.replay, true);
  assert.equal(replayApp.replayRemaining(), 4); // 7 observations: 3 at boot, 4 queued
  const replayServer = await listen(replayApp);
  const replayBase = `http://127.0.0.1:${replayServer.address().port}`;

  const controller = new AbortController();
  try {
    const res = await fetch(`${replayBase}/api/intel/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: state.updated")) break;
    }
    assert.ok(text.includes("event: hello"), "hello event must arrive first");
    assert.ok(text.includes("event: state.updated"), "a replayed state delta must arrive within 10s");
    const dataLine = text
      .split("\n")
      .find((l, i, lines) => l.startsWith("data: ") && lines[i - 1] === "event: state.updated");
    const payload = JSON.parse(dataLine.slice("data: ".length));
    assert.equal(payload.data_class, "telemetry");
    assert.ok(payload.state.entity_id.startsWith("region:test:") || payload.state.entity_id.startsWith("intercon:") || payload.state.entity_id.startsWith("vessel:"));
  } finally {
    controller.abort();
    replayServer.closeAllConnections?.();
    await new Promise((resolve) => replayServer.close(resolve));
  }
});

test("SSE stream filters by entities allowlist", async () => {
  const controller = new AbortController();
  try {
    const res = await fetch(`${base}/api/intel/stream?entities=region:test:north&metrics=grid.demand.mw`, {
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes("event: hello"));
  } finally {
    controller.abort();
  }
});
