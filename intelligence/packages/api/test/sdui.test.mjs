import { test } from "node:test";
import assert from "node:assert/strict";
import { createValidators } from "@pact-tailor/ontology";
import {
  composePanelDoc,
  computeSituations,
  applySituationRules,
  composeWithAI,
  templateFor,
} from "../dist/index.js";

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

function state(entityId, metric, eventTime) {
  return {
    entity_id: entityId,
    metric,
    value: 100,
    event_time: eventTime,
    ingest_time: eventTime,
    source_id: "source:test:feed",
    feed_id: "feed:test:main",
    quality: "good",
    observation_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  };
}

function gap(entityId) {
  return {
    gap_id: "gap:test:x",
    entity_id: entityId,
    desired_metric: "power.load.mw",
    commercial_value: "high",
    strategic_value: "high",
    priority: "P1",
    status: "open",
  };
}

function anomalyInference(subject, status = "INFERRED") {
  return {
    inference_id: "infer:2026-08-12:anomaly-detection-1",
    claim: "anomalous grid.demand.mw",
    claim_structured: { subject, predicate: "exhibits_anomaly", object: "grid.demand.mw" },
    tier: "B",
    confidence: 0.9,
    status,
    method: "rule:anomaly-detection@1.0.0",
    evidence: [{ kind: "observation", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "supports" }],
    sources: ["source:test:feed"],
    produced_at: "2026-08-12T00:00:00Z",
  };
}

const NOW = "2026-08-12T12:00:00Z";

test("situations: no-live-data, has-gaps, estimated-load", () => {
  const e = entity("smelter:test:alpha", "Smelter", { observability: "ESTIMATED" });
  const situations = computeSituations({ entity: e, states: [], gaps: [gap(e.entity_id)], inferences: [], now: NOW });
  assert.deepEqual(situations, ["no-live-data", "has-gaps", "estimated-load"]);
});

test("situations: normal when nothing is wrong", () => {
  const e = entity("gen:test:alpha", "Generator");
  const fresh = state(e.entity_id, "power.output.mw", "2026-08-12T11:55:00Z");
  const situations = computeSituations({ entity: e, states: [fresh], gaps: [], inferences: [], now: NOW });
  assert.deepEqual(situations, ["normal"]);
});

test("situations: stale-telemetry past 3x the 30-minute default cadence", () => {
  const e = entity("gen:test:alpha", "Generator");
  // 91 minutes old — beyond 3 x 30 min.
  const stale = state(e.entity_id, "power.output.mw", "2026-08-12T10:29:00Z");
  assert.deepEqual(
    computeSituations({ entity: e, states: [stale], gaps: [], inferences: [], now: NOW }),
    ["stale-telemetry"],
  );
  // 89 minutes old — within threshold.
  const fresh = state(e.entity_id, "power.output.mw", "2026-08-12T10:31:00Z");
  assert.deepEqual(
    computeSituations({ entity: e, states: [fresh], gaps: [], inferences: [], now: NOW }),
    ["normal"],
  );
});

test("situations: anomaly-active only for open anomaly inferences", () => {
  const e = entity("region:test:north", "GridRegion");
  const s = state(e.entity_id, "grid.demand.mw", "2026-08-12T11:59:00Z");
  assert.deepEqual(
    computeSituations({ entity: e, states: [s], gaps: [], inferences: [anomalyInference(e.entity_id)], now: NOW }),
    ["anomaly-active"],
  );
  assert.deepEqual(
    computeSituations({
      entity: e,
      states: [s],
      gaps: [],
      inferences: [anomalyInference(e.entity_id, "RETRACTED")],
      now: NOW,
    }),
    ["normal"],
  );
  assert.deepEqual(
    computeSituations({
      entity: e,
      states: [s],
      gaps: [],
      inferences: [anomalyInference(e.entity_id, "CORROBORATED")],
      now: NOW,
    }),
    ["anomaly-active"],
  );
});

test("anomaly-active hoists inference-list to the top", () => {
  const e = entity("region:test:north", "GridRegion");
  const doc = composePanelDoc({
    entity: e,
    states: [state(e.entity_id, "grid.demand.mw", "2026-08-12T11:59:00Z")],
    gaps: [],
    inferences: [anomalyInference(e.entity_id)],
    now: NOW,
  });
  assert.deepEqual(doc.situation, ["anomaly-active"]);
  assert.equal(doc.layout[0].panel, "inference-list");
});

test("no-live-data hoists (or injects) the gap-card; anomaly still wins the top slot", () => {
  const e = entity("smelter:test:alpha", "Smelter");
  const doc = composePanelDoc({ entity: e, states: [], gaps: [gap(e.entity_id)], inferences: [], now: NOW });
  assert.equal(doc.layout[0].panel, "gap-card");

  const both = applySituationRules(
    templateFor("Smelter")(e.entity_id),
    ["no-live-data", "anomaly-active"],
    e.entity_id,
  );
  assert.equal(both[0].panel, "inference-list");
  assert.equal(both[1].panel, "gap-card");
});

test("has-gaps injects a gap-card into templates that lack one", () => {
  const e = entity("gen:test:alpha", "Generator");
  const base = templateFor("Generator")(e.entity_id);
  assert.ok(!base.some((p) => p.panel === "gap-card"));
  const doc = composePanelDoc({
    entity: e,
    states: [state(e.entity_id, "power.output.mw", "2026-08-12T11:59:00Z")],
    gaps: [gap(e.entity_id)],
    inferences: [],
    now: NOW,
  });
  assert.ok(doc.layout.some((p) => p.panel === "gap-card"));
});

test("composed docs validate against the SDUI panel schema and never inline data", () => {
  const cases = [
    entity("grid:test", "Grid"),
    entity("region:test:north", "GridRegion"),
    entity("gen:test:alpha", "Generator"),
    entity("smelter:test:alpha", "Smelter", { observability: "ESTIMATED" }),
    entity("vessel:test:bulk1", "Vessel"),
    entity("port:test:main", "Port"),
    entity("term:test:coal", "Terminal"),
    entity("mine:test:black", "Mine"),
    entity("company:test:acme", "Company"), // default template
  ];
  for (const e of cases) {
    const doc = composePanelDoc({ entity: e, states: [], gaps: [gap(e.entity_id)], inferences: [], now: NOW });
    const result = validators.sduiPanel(doc);
    assert.ok(result.ok, `sdui doc for ${e.entity_type} must validate: ${result.ok ? "" : result.errors.join("; ")}`);
    for (const panel of doc.layout) {
      if (panel.data !== undefined) assert.match(panel.data.endpoint, /^\/api\/intel\//);
      assert.ok(!("values" in (panel.props ?? {})), "panels must not inline data values");
    }
  }
});

test("composeWithAI is the documented identity stub", () => {
  const e = entity("gen:test:alpha", "Generator");
  const layout = templateFor("Generator")(e.entity_id);
  assert.equal(composeWithAI(e, ["normal"], layout), layout);
});
