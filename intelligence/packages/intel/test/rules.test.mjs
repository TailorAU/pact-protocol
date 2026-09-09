import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeGraph } from "@pact-tailor/graph";
import { StateEngine } from "@pact-tailor/state";
import { createValidators, ulid } from "@pact-tailor/ontology";
import { IntelEngine, MIN_POINTS } from "../dist/index.js";

const validators = createValidators();

function entity(id, type, over = {}) {
  return {
    entity_id: id,
    entity_type: type,
    name: `Name of ${id}`,
    data_class: "structural",
    observability: "KNOWN_LIVE",
    sources: ["source:test:feed"],
    ...over,
  };
}

function rel(id, type, from, to, over = {}) {
  return {
    rel_id: id,
    rel_type: type,
    from_id: from,
    to_id: to,
    confidence: 1,
    source: "source:test:feed",
    method: "declared",
    ...over,
  };
}

function obs(entityId, metric, value, eventTime, over = {}) {
  return {
    observation_id: ulid(Date.parse(eventTime)),
    entity_id: entityId,
    metric,
    value,
    event_time: eventTime,
    ingest_time: eventTime,
    source_id: "source:test:feed",
    feed_id: "feed:test:main",
    quality: "good",
    ...over,
  };
}

function assertValid(record) {
  const result = validators.inference(record);
  assert.ok(result.ok, `inference must validate: ${result.ok ? "" : result.errors.join("; ")}`);
}

// ── smelter-utilisation ────────────────────────────────────────────────────

function smelterFixture() {
  const graph = new KnowledgeGraph();
  graph.load(
    [
      entity("grid:test", "Grid"),
      entity("region:test:north", "GridRegion", { grid_id: "grid:test" }),
      entity("gen:test:alpha", "Generator", { grid_id: "region:test:north" }),
      entity("smelter:test:alpha", "Smelter", {
        observability: "ESTIMATED",
        grid_id: "grid:test",
        properties: { typical_load_mw: 800 },
      }),
    ],
    [rel("rel:alpha-supplies-smelter", "SUPPLIES", "gen:test:alpha", "smelter:test:alpha")],
  );
  const state = new StateEngine();
  const demand = obs("region:test:north", "grid.demand.mw", 5000, "2026-08-12T00:00:00Z");
  state.ingest([demand]);
  return { graph, state, demand };
}

test("smelter-utilisation emits an evidence-linked tier-B estimate", () => {
  const { graph, state, demand } = smelterFixture();
  const engine = new IntelEngine({ graph, state, gaps: [] });
  const records = engine.runRule("smelter-utilisation", "2026-08-12T01:00:00Z");
  assert.equal(records.length, 1);
  const [record] = records;
  assertValid(record);
  assert.match(record.claim, /estimated live load ≈ 800 MW/);
  assert.equal(record.claim_structured.subject, "smelter:test:alpha");
  assert.equal(record.tier, "B");
  assert.equal(record.status, "INFERRED");
  assert.equal(record.method, "rule:smelter-utilisation@1.0.0");
  assert.equal(record.confidence, 0.75);
  assert.ok(record.evidence.length >= 2);
  // Evidence refs are REAL: the demand observation and the SUPPLIES edge.
  const refs = record.evidence.map((e) => e.ref);
  assert.ok(refs.includes(demand.observation_id));
  assert.ok(refs.includes("rel:alpha-supplies-smelter"));
  assert.match(record.inference_id, /^infer:2026-08-12:smelter-utilisation-1$/);
});

test("smelter-utilisation skips smelters without typical_load_mw or without ESTIMATED observability", () => {
  const graph = new KnowledgeGraph();
  graph.load(
    [
      entity("grid:test", "Grid"),
      entity("region:test:north", "GridRegion", { grid_id: "grid:test" }),
      // no typical_load_mw:
      entity("smelter:test:bare", "Smelter", { observability: "ESTIMATED", grid_id: "grid:test" }),
      // not ESTIMATED:
      entity("smelter:test:live", "Smelter", {
        observability: "KNOWN_LIVE",
        grid_id: "grid:test",
        properties: { typical_load_mw: 500 },
      }),
    ],
    [],
  );
  const state = new StateEngine();
  state.ingest([obs("region:test:north", "grid.demand.mw", 5000, "2026-08-12T00:00:00Z")]);
  const engine = new IntelEngine({ graph, state, gaps: [] });
  assert.equal(engine.runRule("smelter-utilisation").length, 0);
});

test("smelter-utilisation emits nothing without a live demand proxy", () => {
  const { graph } = smelterFixture();
  const engine = new IntelEngine({ graph, state: new StateEngine(), gaps: [] });
  assert.equal(engine.runRule("smelter-utilisation").length, 0);
});

// ── cargo-inference ────────────────────────────────────────────────────────

function cargoFixture({ commodities = ["coal"], withPosition = true } = {}) {
  const graph = new KnowledgeGraph();
  graph.load(
    [
      entity("term:test:coal", "Terminal", { properties: { commodities } }),
      entity("vessel:test:bulk1", "Vessel"),
      entity("vessel:test:idle", "Vessel"),
    ],
    [rel("rel:bulk1-loads-coal", "LOADS_AT", "vessel:test:bulk1", "term:test:coal")],
  );
  const state = new StateEngine();
  let position = null;
  if (withPosition) {
    position = obs("vessel:test:bulk1", "vessel.position", { lat: -23.8, lon: 151.2 }, "2026-08-12T00:05:00Z");
    state.ingest([position]);
  }
  return { graph, state, position };
}

test("cargo-inference emits tier-C carries claim for LOADS_AT vessels", () => {
  const { graph, state, position } = cargoFixture();
  const engine = new IntelEngine({ graph, state, gaps: [] });
  const records = engine.runRule("cargo-inference");
  assert.equal(records.length, 1);
  const [record] = records;
  assertValid(record);
  assert.equal(record.tier, "C");
  assert.equal(record.confidence, 0.85);
  assert.deepEqual(record.contrary_evidence, []);
  assert.equal(record.claim_structured.subject, "vessel:test:bulk1");
  assert.equal(record.claim_structured.predicate, "carries");
  assert.equal(record.claim_structured.object, "coal");
  const refs = record.evidence.map((e) => e.ref);
  assert.ok(refs.includes("rel:bulk1-loads-coal"));
  assert.ok(refs.includes(position.observation_id));
});

test("cargo-inference NEVER emits for vessels without a LOADS_AT edge", () => {
  const { graph, state } = cargoFixture();
  const engine = new IntelEngine({ graph, state, gaps: [] });
  const records = engine.runRule("cargo-inference");
  assert.ok(records.every((r) => r.claim_structured.subject !== "vessel:test:idle"));
});

test("cargo-inference multi-commodity terminal drops confidence to 0.6 per candidate", () => {
  const { graph, state } = cargoFixture({ commodities: ["coal", "alumina"], withPosition: false });
  const engine = new IntelEngine({ graph, state, gaps: [] });
  const records = engine.runRule("cargo-inference");
  assert.equal(records.length, 2);
  for (const record of records) {
    assertValid(record);
    assert.equal(record.confidence, 0.6);
  }
  assert.deepEqual(records.map((r) => r.claim_structured.object).sort(), ["alumina", "coal"]);
});

test("cargo-inference falls back to incoming TRANSPORTS edges for commodity", () => {
  const graph = new KnowledgeGraph();
  graph.load(
    [
      entity("term:test:bare", "Terminal"),
      entity("mine:test:black", "Mine"),
      entity("vessel:test:bulk1", "Vessel"),
    ],
    [
      rel("rel:bulk1-loads-bare", "LOADS_AT", "vessel:test:bulk1", "term:test:bare"),
      rel("rel:black-transports-bare", "TRANSPORTS", "mine:test:black", "term:test:bare", {
        properties: { commodity: "coal" },
      }),
    ],
  );
  const engine = new IntelEngine({ graph, state: new StateEngine(), gaps: [] });
  const records = engine.runRule("cargo-inference");
  assert.equal(records.length, 1);
  assert.equal(records[0].claim_structured.object, "coal");
  assert.ok(records[0].evidence.some((e) => e.ref === "rel:black-transports-bare"));
});

// ── anomaly-detection ──────────────────────────────────────────────────────

// points defaults to MIN_POINTS + 1 so the baseline (points − 1) is even and the
// alternating 99/101 values give exactly mean 100, population sigma 1.
function anomalyFixture(latestValue, points = MIN_POINTS + 1) {
  const graph = new KnowledgeGraph();
  graph.load([entity("region:test:north", "GridRegion")], []);
  const state = new StateEngine();
  const baseline = [];
  // Alternating 99/101 baseline: mean 100, population sigma 1.
  for (let i = 0; i < points - 1; i++) {
    baseline.push(
      obs("region:test:north", "grid.demand.mw", i % 2 === 0 ? 99 : 101, new Date(Date.UTC(2026, 7, 12, 0, i * 5)).toISOString()),
    );
  }
  const latest = obs("region:test:north", "grid.demand.mw", latestValue, new Date(Date.UTC(2026, 7, 12, 12, 0)).toISOString());
  state.ingest([...baseline, latest]);
  return { graph, state, latest, baseline };
}

test("anomaly-detection stays quiet within 3 sigma", () => {
  const { graph, state } = anomalyFixture(103); // deviation == 3 sigma exactly — not strictly past
  const engine = new IntelEngine({ graph, state, gaps: [] });
  assert.equal(engine.runRule("anomaly-detection").length, 0);
});

test("anomaly-detection flags strictly past 3 sigma with z-scaled confidence", () => {
  const { graph, state, latest, baseline } = anomalyFixture(110); // z = 10
  const engine = new IntelEngine({ graph, state, gaps: [] });
  const records = engine.runRule("anomaly-detection");
  assert.equal(records.length, 1);
  const [record] = records;
  assertValid(record);
  assert.match(record.claim, /^anomalous grid\.demand\.mw/);
  assert.equal(record.tier, "B");
  assert.ok(record.confidence > 0.6 && record.confidence <= 0.95);
  assert.equal(record.confidence, 0.95); // z=10 caps
  assert.equal(record.evidence.length, 3);
  const historyIds = new Set([latest, ...baseline].map((o) => o.observation_id));
  for (const e of record.evidence) {
    assert.equal(e.kind, "observation");
    assert.ok(historyIds.has(e.ref), "evidence refs must be real observation ids");
  }
  assert.equal(record.evidence[0].ref, latest.observation_id);
});

test("anomaly-detection requires at least 12 points", () => {
  const { graph, state } = anomalyFixture(200, MIN_POINTS - 1);
  const engine = new IntelEngine({ graph, state, gaps: [] });
  assert.equal(engine.runRule("anomaly-detection").length, 0);
});

// ── gap-synthesis ──────────────────────────────────────────────────────────

test("gap-synthesis emits only for uncovered, mapped, unobservable entities", () => {
  const graph = new KnowledgeGraph();
  graph.load(
    [
      entity("smelter:test:covered", "Smelter", { observability: "ESTIMATED" }),
      entity("term:test:open", "Terminal", { observability: "ESTIMATED" }),
      entity("mine:test:dark", "Mine", { observability: "NOT_OBSERVABLE" }),
      entity("gen:test:est", "Generator", { observability: "ESTIMATED" }), // no metric mapping
      entity("smelter:test:live", "Smelter", { observability: "KNOWN_LIVE" }),
    ],
    [],
  );
  const gaps = [
    {
      gap_id: "gap:test:covered-load",
      entity_id: "smelter:test:covered",
      desired_metric: "power.load.mw",
      commercial_value: "high",
      strategic_value: "high",
      priority: "P1",
      status: "open",
    },
  ];
  const engine = new IntelEngine({ graph, state: new StateEngine(), gaps });
  const records = engine.runRule("gap-synthesis");
  const subjects = records.map((r) => r.claim_structured.subject).sort();
  assert.deepEqual(subjects, ["mine:test:dark", "term:test:open"]);
  for (const record of records) {
    assertValid(record);
    assert.equal(record.tier, "C");
    assert.equal(record.confidence, 0.9);
    assert.equal(record.claim_structured.object, "production.rate.tph");
    assert.match(record.claim, /^observability gap: /);
    assert.deepEqual(record.evidence, [
      { kind: "structural", ref: record.claim_structured.subject, role: "supports" },
    ]);
  }
});
