import test from "node:test";
import assert from "node:assert/strict";
import { createValidators, ulid, METRICS, isKnownMetric } from "../dist/index.js";

const v = createValidators();

function expectOk(result, label) {
  assert.equal(result.ok, true, `${label}: expected valid, got errors: ${result.ok ? "" : result.errors.join("; ")}`);
}

function expectFail(result, label, needle) {
  assert.equal(result.ok, false, `${label}: expected validation failure`);
  if (needle !== undefined) {
    const joined = result.errors.join("\n");
    assert.match(joined, needle, `${label}: expected error matching ${needle} in:\n${joined}`);
  }
}

// ---------------------------------------------------------------------------
// Schema compilation
// ---------------------------------------------------------------------------

test("all schemas compile with no unresolved $refs", () => {
  // createValidators() eagerly compiles every envelope schema (including the
  // cross-file refs into defs/geojson/entity-types); reaching here means all
  // $refs resolved. Also sanity-check the registry contents.
  const names = [
    "entity",
    "relationship",
    "observation",
    "source",
    "gap",
    "inference",
    "grid",
    "feed",
    "sduiPanel",
  ];
  for (const n of names) {
    assert.equal(typeof v[n], "function", `validator ${n} missing`);
  }
  const base = "https://pact.tailor.au/intelligence/schemas/";
  for (const ref of [
    "defs.schema.json",
    "geojson.schema.json",
    "entity-types/generator.properties.json",
    "entity-types/vessel.properties.json",
  ]) {
    assert.ok(v.ajv.getSchema(base + ref), `schema not registered: ${ref}`);
  }
});

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

const validEntity = {
  entity_id: "gen:au-nem:bayswater",
  entity_type: "Generator",
  name: "Bayswater Power Station",
  aliases: ["BAYSW"],
  data_class: "structural",
  observability: "KNOWN_LIVE",
  geometry: { type: "Point", coordinates: [150.9484, -32.3946] },
  country: "au",
  admin: { region: "NSW", locality: "Muswellbrook" },
  grid_id: "grid:au-nem",
  properties: { fuel: "coal", capacity_mw: 2640, unit_count: 4, status: "operating" },
  external_ids: { aemo_duid: ["BW01", "BW02"], aemo_station_id: "BAYSW" },
  sources: ["source:aemo:nem-registration"],
  valid_from: "1985-01-01T00:00:00Z",
  valid_to: null,
  same_as: null,
};

test("entity: valid generator passes", () => {
  expectOk(v.entity(validEntity), "entity");
});

test("entity: unknown external_ids key fails", () => {
  const bad = { ...validEntity, external_ids: { aemo_duid: ["BW01"], nasa_id: "x" } };
  expectFail(v.entity(bad), "entity external_ids", /additional properties.*nasa_id|nasa_id/);
});

test("entity: wrong observability enum fails", () => {
  const bad = { ...validEntity, observability: "LIVE" };
  expectFail(v.entity(bad), "entity observability", /observability/);
});

test("entity: generator sub-schema enforces fuel enum", () => {
  const bad = { ...validEntity, properties: { ...validEntity.properties, fuel: "unicorn" } };
  expectFail(v.entity(bad), "entity fuel", /fuel/);
});

test("entity: data_class must be structural", () => {
  const bad = { ...validEntity, data_class: "live" };
  expectFail(v.entity(bad), "entity data_class");
});

test("entity: unknown top-level key fails (additionalProperties)", () => {
  const bad = { ...validEntity, extra_field: true };
  expectFail(v.entity(bad), "entity extra key", /extra_field/);
});

test("entity: sub-schemas allow extra property keys (permissive bags)", () => {
  const ok = { ...validEntity, properties: { ...validEntity.properties, custom_note: "x" } };
  expectOk(v.entity(ok), "entity extra property-bag key");
});

test("entity: vessel synthetic flag accepted", () => {
  const vessel = {
    entity_id: "vessel:imo:9700100",
    entity_type: "Vessel",
    name: "Demo Cape",
    data_class: "structural",
    observability: "ESTIMATED",
    properties: { vessel_type: "bulk-carrier", dwt: 180000, synthetic: true },
    sources: ["source:demo:vessels"],
  };
  expectOk(v.entity(vessel), "vessel entity");
  const bad = { ...vessel, properties: { ...vessel.properties, synthetic: "yes" } };
  expectFail(v.entity(bad), "vessel synthetic type", /synthetic/);
});

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

const validRel = {
  rel_id: "rel:bayswater-owned-by-agl",
  rel_type: "OWNED_BY",
  from_id: "gen:au-nem:bayswater",
  to_id: "company:au:agl",
  confidence: 0.95,
  source: "source:aemo:nem-registration",
  method: "declared",
};

test("relationship: valid declared edge passes", () => {
  expectOk(v.relationship(validRel), "relationship");
});

test("relationship: inferred edge with evidence passes", () => {
  const ok = {
    ...validRel,
    rel_id: "rel:tomago-may-supply",
    rel_type: "MAY_SUPPLY",
    method: "inferred",
    evidence: [{ kind: "observation", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
  };
  expectOk(v.relationship(ok), "relationship inferred");
});

test("relationship: method=inferred without evidence fails", () => {
  const bad = { ...validRel, method: "inferred" };
  expectFail(v.relationship(bad), "relationship missing evidence", /evidence/);
});

test("relationship: method=inferred with empty evidence fails", () => {
  const bad = { ...validRel, method: "inferred", evidence: [] };
  expectFail(v.relationship(bad), "relationship empty evidence", /fewer than 1 items|minItems|must NOT have fewer/);
});

test("relationship: unknown rel_type fails", () => {
  const bad = { ...validRel, rel_type: "FRIENDS_WITH" };
  expectFail(v.relationship(bad), "relationship rel_type", /rel_type/);
});

test("relationship: confidence out of range fails", () => {
  const bad = { ...validRel, confidence: 1.5 };
  expectFail(v.relationship(bad), "relationship confidence", /confidence/);
});

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

const validObs = {
  observation_id: ulid(),
  entity_id: "gen:au-nem:bayswater",
  metric: "power.output.mw",
  value: 1980.5,
  event_time: "2026-08-12T00:05:00Z",
  ingest_time: "2026-08-12T00:05:04Z",
  source_id: "source:aemo:nem-dispatch",
  feed_id: "feed:aemo:scada",
  quality: "good",
  unit: "MW",
};

test("observation: valid scalar observation passes", () => {
  expectOk(v.observation(validObs), "observation");
});

test("observation: object value (vessel.position) passes", () => {
  const ok = {
    ...validObs,
    observation_id: ulid(),
    entity_id: "vessel:imo:9700100",
    metric: "vessel.position",
    value: { lat: -32.9, lon: 151.78, speed_kn: 11.2, heading_deg: 44 },
    unit: undefined,
  };
  delete ok.unit;
  expectOk(v.observation(ok), "observation object value");
});

test("observation: bad ULID fails", () => {
  const bad = { ...validObs, observation_id: "not-a-ulid" };
  expectFail(v.observation(bad), "observation ulid", /observation_id/);
});

test("observation: wrong quality enum fails", () => {
  const bad = { ...validObs, quality: "excellent" };
  expectFail(v.observation(bad), "observation quality", /quality/);
});

test("observation: boolean value fails (must be number|string|object)", () => {
  const bad = { ...validObs, value: true };
  expectFail(v.observation(bad), "observation value type", /value/);
});

test("observation: bad metric grammar fails", () => {
  const bad = { ...validObs, metric: "PowerOutput" };
  expectFail(v.observation(bad), "observation metric", /metric/);
});

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

const validSource = {
  source_id: "source:aemo:nem-dispatch",
  publisher: "AEMO",
  dataset: "NEM dispatch SCADA",
  api_type: "rest",
  url: "https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN",
  coverage: { grids: ["grid:au-nem"], countries: ["au"] },
  data_class: "live",
  licensing: { class: "open-attribution", notes: "AEMO data licence" },
  verification_status: "verified_live",
  last_checked: "2026-08-12",
  reliability: 5,
};

test("source: valid source passes", () => {
  expectOk(v.source(validSource), "source");
});

test("source: unknown api_type fails", () => {
  const bad = { ...validSource, api_type: "grpc" };
  expectFail(v.source(bad), "source api_type", /api_type/);
});

test("source: bad last_checked date fails", () => {
  const bad = { ...validSource, last_checked: "12/08/2026" };
  expectFail(v.source(bad), "source date", /last_checked/);
});

test("source: reliability out of 1-5 fails", () => {
  const bad = { ...validSource, reliability: 7 };
  expectFail(v.source(bad), "source reliability", /reliability/);
});

// ---------------------------------------------------------------------------
// Observability gap
// ---------------------------------------------------------------------------

const validGap = {
  gap_id: "gap:au-nem:tomago-load",
  entity_id: "smelter:au:tomago",
  desired_metric: "power.load.mw",
  commercial_value: "high",
  strategic_value: "critical",
  priority: "P1",
  status: "open",
  current_source: null,
  best_available_proxy: {
    source_id: "source:aemo:nem-dispatch",
    metric: "grid.demand.mw",
    derivation: "regional demand residual after known generation",
  },
  instrumentation_options: [
    { kind: "ct_sensor", notes: "clamp at 330kV feeder", indicative_cost_band: "medium" },
    { kind: "partner_feed" },
  ],
  estimated_complexity: "medium",
};

test("gap: valid gap passes", () => {
  expectOk(v.gap(validGap), "gap");
});

test("gap: bad priority fails", () => {
  const bad = { ...validGap, priority: "P5" };
  expectFail(v.gap(bad), "gap priority", /priority/);
});

test("gap: unknown instrumentation kind fails", () => {
  const bad = {
    ...validGap,
    instrumentation_options: [{ kind: "drone" }],
  };
  expectFail(v.gap(bad), "gap instrumentation kind", /kind/);
});

test("gap: bad desired_metric grammar fails", () => {
  const bad = { ...validGap, desired_metric: "load" };
  expectFail(v.gap(bad), "gap metric", /desired_metric/);
});

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

const validInference = {
  inference_id: "infer:2026-08-12:tomago-potline-restart",
  claim: "Tomago potline 2 restarted around 2026-08-11T22:00Z",
  claim_structured: {
    subject: "smelter:au:tomago",
    predicate: "load_step_up",
    object: "potline-2",
    qualifiers: { magnitude_mw: 280 },
  },
  tier: "B",
  confidence: 0.72,
  status: "INFERRED",
  method: "rule:load-step@1.0.0",
  evidence: [
    { kind: "observation", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "supports" },
    { kind: "structural", ref: "gen:au-nem:bayswater", role: "supports" },
  ],
  contrary_evidence: [
    { kind: "observation", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAW", role: "contradicts" },
  ],
  sources: ["source:aemo:nem-dispatch"],
  produced_at: "2026-08-12T01:00:00Z",
  event_time_range: { from: "2026-08-11T21:00:00Z", to: "2026-08-11T23:00:00Z" },
  lineage: { correlation_id: "corr-1", in_response_to: null, prev_hash: null },
  pact: null,
};

test("inference: valid inference passes", () => {
  expectOk(v.inference(validInference), "inference");
});

test("inference: empty evidence array fails", () => {
  const bad = { ...validInference, evidence: [] };
  expectFail(v.inference(bad), "inference empty evidence", /evidence/);
});

test("inference: bad method pattern fails", () => {
  const bad = { ...validInference, method: "load-step" };
  expectFail(v.inference(bad), "inference method", /method/);
});

test("inference: evidence role must be supports", () => {
  const bad = {
    ...validInference,
    evidence: [{ kind: "observation", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV", role: "contradicts" }],
  };
  expectFail(v.inference(bad), "inference role", /role/);
});

test("inference: bad inference_id fails", () => {
  const bad = { ...validInference, inference_id: "infer:tomago" };
  expectFail(v.inference(bad), "inference id", /inference_id/);
});

// ---------------------------------------------------------------------------
// Grid registry
// ---------------------------------------------------------------------------

const validGrid = {
  grid_id: "grid:au-nem",
  name: "National Electricity Market",
  kind: "market",
  countries: ["au"],
  frequency_hz: 50,
  live_data: {
    availability: "rich",
    notes: "5-minute dispatch, SCADA per DUID",
    source_ids: ["source:aemo:nem-dispatch"],
  },
  sources: ["source:aemo:nem-registration"],
  parent_grid: null,
  operators: [
    { name: "AEMO", role: "market_operator" },
    { name: "Transgrid", role: "tso" },
  ],
  market: { structure: "gross pool", price_mechanism: "regional marginal", dispatch_interval: "5m" },
  timezone: "Australia/Brisbane",
  interconnections: [{ to_grid: "grid:au-swis", name: "none", capacity_mw: null }],
  demand_range_mw: { min: 14000, max: 35000 },
};

test("grid: valid registry record passes", () => {
  expectOk(v.grid(validGrid), "grid");
});

test("grid: frequency must be 50 or 60", () => {
  const bad = { ...validGrid, frequency_hz: 55 };
  expectFail(v.grid(bad), "grid frequency", /frequency_hz/);
});

test("grid: unknown kind fails", () => {
  const bad = { ...validGrid, kind: "mega_grid" };
  expectFail(v.grid(bad), "grid kind", /kind/);
});

test("grid: empty countries fails", () => {
  const bad = { ...validGrid, countries: [] };
  expectFail(v.grid(bad), "grid countries", /countries/);
});

// ---------------------------------------------------------------------------
// Telemetry feed
// ---------------------------------------------------------------------------

const validFeed = {
  feed_id: "feed:aemo:scada",
  source_id: "source:aemo:nem-dispatch",
  connector_id: "aemo-nemweb",
  metrics: ["power.output.mw", "grid.demand.mw"],
  cadence: "5m",
  description: "NEM dispatch SCADA per DUID",
};

test("feed: valid feed passes", () => {
  expectOk(v.feed(validFeed), "feed");
});

test("feed: empty metrics fails", () => {
  const bad = { ...validFeed, metrics: [] };
  expectFail(v.feed(bad), "feed metrics", /metrics/);
});

test("feed: malformed feed_id fails", () => {
  const bad = { ...validFeed, feed_id: "aemo:scada" };
  expectFail(v.feed(bad), "feed id", /feed_id/);
});

// ---------------------------------------------------------------------------
// SDUI panel
// ---------------------------------------------------------------------------

const validSdui = {
  entity_id: "gen:au-nem:bayswater",
  entity_type: "Generator",
  situation: ["normal"],
  layout: [
    { panel: "headline-state" },
    {
      panel: "timeseries",
      props: { metric: "power.output.mw" },
      data: { endpoint: "/api/intel/entities/gen:au-nem:bayswater/timeseries" },
    },
  ],
};

test("sduiPanel: valid doc passes", () => {
  expectOk(v.sduiPanel(validSdui), "sdui");
});

test("sduiPanel: endpoint not under /api/intel/ fails", () => {
  const bad = {
    ...validSdui,
    layout: [{ panel: "timeseries", data: { endpoint: "/api/other/x" } }],
  };
  expectFail(v.sduiPanel(bad), "sdui endpoint", /endpoint/);
});

test("sduiPanel: unknown panel kind fails", () => {
  const bad = { ...validSdui, layout: [{ panel: "pie-chart" }] };
  expectFail(v.sduiPanel(bad), "sdui panel kind", /panel/);
});

test("sduiPanel: empty layout fails", () => {
  const bad = { ...validSdui, layout: [] };
  expectFail(v.sduiPanel(bad), "sdui layout", /layout/);
});

// ---------------------------------------------------------------------------
// Metrics vocabulary
// ---------------------------------------------------------------------------

test("metrics: canonical vocabulary present and helper works", () => {
  assert.equal(Object.keys(METRICS).length, 20);
  assert.equal(isKnownMetric("power.output.mw"), true);
  assert.equal(isKnownMetric("vessel.position"), true);
  assert.equal(isKnownMetric("made.up.metric"), false);
  assert.equal(METRICS["market.price.energy"].unit, "AUD/MWh");
});
