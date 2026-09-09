import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeGraph } from "../dist/index.js";

const entity = (id, type, name) => ({
  entity_id: id,
  entity_type: type,
  name,
  data_class: "structural",
  observability: "UNCLASSIFIED",
  sources: ["source:test:feed"],
});

const rel = (id, type, from, to, extra = {}) => ({
  rel_id: id,
  rel_type: type,
  from_id: from,
  to_id: to,
  confidence: 1.0,
  source: "source:test:feed",
  method: "declared",
  ...extra,
});

function gladstoneGraph() {
  const g = new KnowledgeGraph();
  g.load(
    [
      entity("mine:au-qld:blackwater", "CoalMine", "Blackwater"),
      entity("terminal:au-qld:rg-tanna", "Terminal", "RG Tanna"),
      entity("port:au-qld:gladstone", "Port", "Port of Gladstone"),
      entity("vessel:imo:9000001", "Vessel", "MV Bowen Trader"),
      entity("dest:jp", "Destination", "Japan"),
      entity("gen:au-nem:gladstone-ps", "Generator", "Gladstone PS"),
      entity("smelter:au-qld:boyne-island", "Smelter", "Boyne Island"),
    ],
    [
      rel("rel-1", "TRANSPORTS", "mine:au-qld:blackwater", "terminal:au-qld:rg-tanna"),
      rel("rel-2", "PART_OF", "terminal:au-qld:rg-tanna", "port:au-qld:gladstone"),
      rel("rel-3", "LOADS_AT", "vessel:imo:9000001", "terminal:au-qld:rg-tanna"),
      rel("rel-4", "SHIPS_TO", "vessel:imo:9000001", "dest:jp"),
      rel("rel-5", "SUPPLIES", "gen:au-nem:gladstone-ps", "smelter:au-qld:boyne-island"),
    ],
  );
  return g;
}

test("neighbors respects direction and relTypes", () => {
  const g = gladstoneGraph();
  const out = g.neighbors("mine:au-qld:blackwater", { direction: "out" });
  assert.equal(out.length, 1);
  assert.equal(out[0].to, "terminal:au-qld:rg-tanna");
  const loaders = g.neighbors("terminal:au-qld:rg-tanna", { direction: "in", relTypes: ["LOADS_AT"] });
  assert.equal(loaders.length, 1);
  assert.equal(loaders[0].from, "vessel:imo:9000001");
});

test("downstream traversal walks mine → terminal → port", () => {
  const g = gladstoneGraph();
  const paths = g.traverse({ start: "mine:au-qld:blackwater", direction: "downstream", maxDepth: 3 });
  const tips = paths.map((p) => p.nodes[p.nodes.length - 1]);
  assert.ok(tips.includes("terminal:au-qld:rg-tanna"));
  assert.ok(tips.includes("port:au-qld:gladstone"));
});

test("upstream traversal answers 'what feeds the smelter?'", () => {
  const g = gladstoneGraph();
  const paths = g.traverse({ start: "smelter:au-qld:boyne-island", direction: "upstream", maxDepth: 2 });
  assert.ok(paths.some((p) => p.nodes.includes("gen:au-nem:gladstone-ps")));
});

test("chain follows an explicit rel-type sequence", () => {
  const g = gladstoneGraph();
  const paths = g.chain("mine:au-qld:blackwater", ["TRANSPORTS", "PART_OF"]);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].nodes, ["mine:au-qld:blackwater", "terminal:au-qld:rg-tanna", "port:au-qld:gladstone"]);
});

test("bitemporal: expired edges disappear under asOf; superseded edges disappear by default", () => {
  const g = new KnowledgeGraph();
  g.load(
    [entity("mine:t:a", "Mine", "A"), entity("gen:t:b", "Generator", "B")],
    [
      rel("rel-old", "SUPPLIES", "mine:t:a", "gen:t:b", {
        valid_from: "2010-01-01T00:00:00Z",
        valid_to: "2019-12-31T00:00:00Z",
      }),
    ],
  );
  assert.equal(g.neighbors("mine:t:a", { direction: "out" }).length, 0);
  assert.equal(g.neighbors("mine:t:a", { direction: "out", asOf: "2015-06-01T00:00:00Z" }).length, 1);

  g.applyDelta({
    kind: "relationship_patch",
    relationship: rel("rel-new", "SUPPLIES", "mine:t:a", "gen:t:b", {
      valid_from: "2020-01-01T00:00:00Z",
      recorded_at: "2020-01-05T00:00:00Z",
    }),
  });
  const now = g.neighbors("mine:t:a", { direction: "out" });
  assert.equal(now.length, 1);
  assert.equal(now[0].rel.rel_id, "rel-new");
});

test("applyDelta supersedes a re-recorded edge without losing history", () => {
  const g = new KnowledgeGraph();
  g.load(
    [entity("mine:t:a", "Mine", "A"), entity("gen:t:b", "Generator", "B")],
    [rel("rel-x", "SUPPLIES", "mine:t:a", "gen:t:b", { confidence: 0.6, recorded_at: "2026-01-01T00:00:00Z" })],
  );
  g.applyDelta({
    kind: "relationship_patch",
    relationship: rel("rel-x", "SUPPLIES", "mine:t:a", "gen:t:b", { confidence: 0.95, recorded_at: "2026-06-01T00:00:00Z" }),
  });
  const current = g.neighbors("mine:t:a", { direction: "out" });
  assert.equal(current.length, 1);
  assert.equal(current[0].rel.confidence, 0.95);
  // System-time query as of before the re-record still sees the old belief.
  const then = g.neighbors("mine:t:a", { direction: "out", recordedAsOf: "2026-03-01T00:00:00Z" });
  assert.equal(then.length, 1);
  assert.equal(then[0].rel.confidence, 0.6);
});

test("export is deterministic", () => {
  const a = gladstoneGraph().export();
  const b = gladstoneGraph().export();
  assert.deepEqual(a, b);
});
