import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeGraph } from "@pact-tailor/graph";
import { StateEngine } from "@pact-tailor/state";
import { MedallionStore } from "@pact-tailor/store";
import { ulid } from "@pact-tailor/ontology";
import { IntelEngine, ALL_RULES, MIN_POINTS } from "../dist/index.js";

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

function obs(entityId, metric, value, eventTime) {
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
  };
}

function engineFixture() {
  const graph = new KnowledgeGraph();
  graph.load(
    [
      entity("term:test:open", "Terminal", { observability: "ESTIMATED" }),
      entity("mine:test:dark", "Mine", { observability: "NOT_OBSERVABLE" }),
    ],
    [],
  );
  const state = new StateEngine();
  return { graph, state };
}

test("runAll runs every rule, byEntity filters on subject, ids stay unique across runs", () => {
  const { graph, state } = engineFixture();
  const engine = new IntelEngine({ graph, state, gaps: [] });
  assert.equal(ALL_RULES.length, 4);

  const first = engine.runAll("2026-08-12T01:00:00Z");
  assert.equal(first.length, 2); // two gap-synthesis records; other rules have no targets
  const second = engine.runAll("2026-08-12T02:00:00Z");
  assert.equal(second.length, 2);

  const ids = engine.all().map((r) => r.inference_id);
  assert.equal(new Set(ids).size, ids.length, "inference ids must be unique across runs");
  assert.equal(engine.all().length, 4);

  const forMine = engine.byEntity("mine:test:dark");
  assert.equal(forMine.length, 2);
  assert.ok(forMine.every((r) => r.claim_structured.subject === "mine:test:dark"));
  assert.equal(engine.byEntity("mine:test:unknown").length, 0);
});

test("runRule rejects unknown rule names", () => {
  const { graph, state } = engineFixture();
  const engine = new IntelEngine({ graph, state, gaps: [] });
  assert.throws(() => engine.runRule("no-such-rule"), /unknown rule/);
});

test("persistTo appends only new records to the gold inference log", () => {
  const { graph, state } = engineFixture();
  const engine = new IntelEngine({ graph, state, gaps: [] });
  const varDir = mkdtempSync(join(tmpdir(), "pt-intel-"));
  const store = new MedallionStore(varDir);

  engine.runAll("2026-08-12T01:00:00Z");
  assert.equal(engine.persistTo(store), 2);
  assert.equal(store.gold.readInferences().length, 2);
  // Idempotent when nothing new was produced.
  assert.equal(engine.persistTo(store), 0);
  assert.equal(store.gold.readInferences().length, 2);

  engine.runAll("2026-08-12T02:00:00Z");
  assert.equal(engine.persistTo(store), 2);
  assert.equal(store.gold.readInferences().length, 4);
});

test("attach() re-runs anomaly-detection for the affected key only (debounced)", async () => {
  const graph = new KnowledgeGraph();
  graph.load([entity("region:test:north", "GridRegion")], []);
  const state = new StateEngine();
  const baseline = [];
  for (let i = 0; i < MIN_POINTS; i++) {
    baseline.push(
      obs(
        "region:test:north",
        "grid.demand.mw",
        i % 2 === 0 ? 99 : 101,
        new Date(Date.UTC(2026, 7, 12, 0, i * 5)).toISOString(),
      ),
    );
  }
  state.ingest(baseline);

  const engine = new IntelEngine({ graph, state, gaps: [], reactDebounceMs: 20 });
  const seen = [];
  const unsubscribe = engine.onInference((r) => seen.push(r));
  const detach = engine.attach();

  // A non-anomalous delta must not produce an inference after debounce.
  state.ingest([obs("region:test:north", "grid.demand.mw", 100, "2026-08-12T02:00:00Z")]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(seen.length, 0);

  // An outlier delta triggers a scoped anomaly record.
  state.ingest([obs("region:test:north", "grid.demand.mw", 500, "2026-08-12T03:00:00Z")]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].claim_structured.subject, "region:test:north");
  assert.equal(seen[0].claim_structured.object, "grid.demand.mw");
  assert.equal(seen[0].method, "rule:anomaly-detection@1.0.0");

  detach();
  unsubscribe();
  // After detach, further deltas are ignored.
  state.ingest([obs("region:test:north", "grid.demand.mw", 900, "2026-08-12T04:00:00Z")]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(engine.all().length, 1);
});
