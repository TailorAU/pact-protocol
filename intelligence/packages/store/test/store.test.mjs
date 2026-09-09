import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MedallionStore, canonicalJson } from "../dist/index.js";

const obs = (feed, day, hour, value, extra = {}) => ({
  observation_id: "01JABCDEFGHJKMNPQRSTVWXYZ0".slice(0, 26),
  entity_id: "gen:test:alpha",
  metric: "power.output.mw",
  value,
  unit: "MW",
  event_time: `${day}T${hour}:00:00Z`,
  ingest_time: `${day}T${hour}:01:00Z`,
  source_id: "source:test:feed",
  feed_id: feed,
  quality: "good",
  ...extra,
});

test("bronze: put is content-addressed, immutable, and re-readable", () => {
  const store = new MedallionStore(mkdtempSync(join(tmpdir(), "pt-store-")));
  const body = Buffer.from("PUBLIC_DISPATCHIS payload");
  const meta = store.bronze.put({
    source_id: "source:aemo:nemweb-dispatchis",
    url: "https://example.invalid/PUBLIC_DISPATCHIS.zip",
    fetched_at: "2026-08-12T01:05:00.000Z",
    http_status: 200,
    body,
  });
  assert.equal(meta.bytes, body.length);
  const roundTrip = store.bronze.get("source:aemo:nemweb-dispatchis", meta.artifact_id);
  assert.ok(roundTrip);
  assert.deepEqual(roundTrip.body, body);
  // Same content re-put → same artifact, still listed once.
  store.bronze.put({
    source_id: "source:aemo:nemweb-dispatchis",
    url: "https://example.invalid/PUBLIC_DISPATCHIS.zip",
    fetched_at: "2026-08-12T01:05:00.000Z",
    http_status: 200,
    body,
  });
  assert.equal(store.bronze.list("source:aemo:nemweb-dispatchis").length, 1);
});

test("silver: append partitions by feed and event date; reads filter by day", () => {
  const store = new MedallionStore(mkdtempSync(join(tmpdir(), "pt-store-")));
  store.silver.append([
    obs("feed:test:a", "2026-08-11", "23", 100),
    obs("feed:test:a", "2026-08-12", "00", 110),
    obs("feed:test:b", "2026-08-12", "00", 7),
  ]);
  assert.equal(store.silver.readFeed("feed:test:a").length, 2);
  assert.equal(store.silver.readFeed("feed:test:a", { fromDay: "2026-08-12" }).length, 1);
  assert.deepEqual(store.silver.listFeeds().sort(), ["feed:test:a", "feed:test:b"]);
});

test("gold: graph delta journal is hash-chained and tamper-evident", () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-store-"));
  const store = new MedallionStore(dir);
  for (let i = 1; i <= 3; i++) {
    store.gold.appendGraphDelta({
      recorded_at: `2026-08-12T0${i}:00:00Z`,
      kind: "relationship_patch",
      payload: { rel_id: `rel:test-${i}` },
    });
  }
  assert.equal(store.gold.verifyChain(), null);
  const deltas = store.gold.readGraphDeltas();
  assert.deepEqual(deltas.map((d) => d.seq), [1, 2, 3]);
  assert.equal(deltas[0].prev_hash, "GENESIS");

  // A fresh instance resumes the chain from disk.
  const reopened = new MedallionStore(dir);
  reopened.gold.appendGraphDelta({
    recorded_at: "2026-08-12T04:00:00Z",
    kind: "entity_patch",
    payload: { entity_id: "gen:test:alpha" },
  });
  assert.equal(reopened.gold.verifyChain(), null);

  // Tampering with a middle line breaks verification at the next seq.
  const path = join(dir, "gold", "graph", "deltas.jsonl");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const tampered = lines[1].replace("rel:test-2", "rel:evil");
  writeFileSync(path, [lines[0], tampered, ...lines.slice(2)].join("\n") + "\n");
  assert.notEqual(new MedallionStore(dir).gold.verifyChain(), null);
});

test("canonicalJson: key order does not change the serialisation", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});
