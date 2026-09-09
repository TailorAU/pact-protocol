import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, checkIntegrity, gridEntitiesFrom, findResolutionCandidates } from "../dist/index.js";

function writeFixtureTree(root) {
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
    licensing: { class: open, notes: test }
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
    live_data: { availability: rich, notes: test, source_ids: [source:test:feed] }
    sources: [source:test:feed]
`,
  );
  writeFileSync(
    join(root, "entities", "test", "entities.yaml"),
    `records:
  - entity_id: gen:test:alpha
    entity_type: Generator
    name: Alpha Power Station
    data_class: structural
    observability: KNOWN_LIVE
    geometry: { type: Point, coordinates: [151.0, -23.0] }
    country: au
    grid_id: grid:test
    properties: { fuel: coal, capacity_mw: 100 }
    external_ids: { aemo_station_id: ALPHA }
    sources: [source:test:feed]
  - entity_id: gen:test:alpha-dup
    entity_type: Generator
    name: Alpha Power Stn
    data_class: structural
    observability: KNOWN_LIVE
    geometry: { type: Point, coordinates: [151.001, -23.001] }
    country: au
    grid_id: grid:test
    external_ids: { aemo_station_id: ALPHA }
    sources: [source:test:feed]
`,
  );
  writeFileSync(
    join(root, "registries", "gaps", "test.yaml"),
    `records:
  - gap_id: gap:test:alpha-metric
    entity_id: gen:test:alpha
    desired_metric: power.output.mw
    commercial_value: high
    strategic_value: high
    priority: P1
    status: open
`,
  );
  writeFileSync(
    join(root, "relationships", "test", "rels.yaml"),
    `records:
  - rel_id: rel:alpha-generates-test
    rel_type: GENERATES
    from_id: gen:test:alpha
    to_id: grid:test
    confidence: 1.0
    source: source:test:feed
    method: declared
`,
  );
}

test("loads a valid fixture tree with no errors and full integrity", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-registry-"));
  writeFixtureTree(root);
  const { data, errors } = loadRegistry(root);
  assert.deepEqual(errors, []);
  assert.equal(data.grids.length, 1);
  assert.equal(data.sources.length, 1);
  assert.equal(data.gaps.length, 1);
  assert.equal(data.entities.length, 2);
  assert.equal(data.relationships.length, 1);
  assert.deepEqual(checkIntegrity(data), []);
});

test("schema-invalid records are reported with file context and excluded", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-registry-"));
  writeFixtureTree(root);
  writeFileSync(
    join(root, "entities", "test", "broken.yaml"),
    `records:
  - entity_id: not a valid id
    entity_type: Generator
    name: Broken
    data_class: structural
    observability: KNOWN_LIVE
    sources: [source:test:feed]
`,
  );
  const { data, errors } = loadRegistry(root);
  assert.equal(data.entities.length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /broken\.yaml/);
});

test("integrity check flags dangling references", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-registry-"));
  writeFixtureTree(root);
  writeFileSync(
    join(root, "relationships", "test", "dangling.yaml"),
    `records:
  - rel_id: rel:dangling
    rel_type: SUPPLIES
    from_id: gen:test:alpha
    to_id: smelter:test:missing
    confidence: 0.9
    source: source:test:feed
    method: manual
`,
  );
  const { data } = loadRegistry(root);
  const problems = checkIntegrity(data);
  assert.ok(problems.some((p) => p.includes("smelter:test:missing")));
});

test("grid entities materialise and shared-external-id duplicates surface", () => {
  const root = mkdtempSync(join(tmpdir(), "pt-registry-"));
  writeFixtureTree(root);
  const { data } = loadRegistry(root);
  const gridEntities = gridEntitiesFrom(data.grids);
  assert.equal(gridEntities.length, 1);
  assert.equal(gridEntities[0].entity_id, "grid:test");
  assert.equal(gridEntities[0].entity_type, "Grid");
  assert.equal(gridEntities[0].observability, "KNOWN_LIVE");

  const candidates = findResolutionCandidates(data.entities);
  assert.ok(candidates.some((c) => c.reason.includes("aemo_station_id")));
});
