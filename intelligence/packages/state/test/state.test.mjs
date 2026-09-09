import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MedallionStore } from "@pact-tailor/store";
import { StateEngine } from "../dist/index.js";

let seq = 0;
const obs = (entity, metric, eventTime, value, extra = {}) => ({
  observation_id: `obs-${String(++seq).padStart(4, "0")}`,
  entity_id: entity,
  metric,
  value,
  unit: "MW",
  event_time: eventTime,
  ingest_time: extra.ingest_time ?? `2026-08-12T02:${String(seq % 60).padStart(2, "0")}:00Z`,
  source_id: "source:test:feed",
  feed_id: "feed:test:a",
  quality: "good",
  ...extra,
});

test("event-time latest wins: newer observation replaces held state, emits state.updated", () => {
  const engine = new StateEngine();
  const a = obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:00:00Z", 100);
  const b = obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:05:00Z", 110);

  const r1 = engine.ingest([a]);
  assert.equal(r1.deltas.length, 1);
  assert.equal(r1.deltas[0].type, "state.updated");
  assert.equal(r1.deltas[0].previous, null);

  const r2 = engine.ingest([b]);
  assert.equal(r2.deltas.length, 1);
  assert.equal(r2.deltas[0].type, "state.updated");
  assert.equal(r2.deltas[0].state.value, 110);
  assert.equal(r2.deltas[0].previous.value, 100);
  assert.equal(r2.deltas[0].previous.observation_id, a.observation_id);

  const current = engine.current("gen:test:alpha", "power.output.mw");
  assert.equal(current.length, 1);
  assert.equal(current[0].value, 110);
  assert.equal(current[0].observation_id, b.observation_id);
});

test("late data: older event_time goes to history only — no state change, no delta", () => {
  const engine = new StateEngine();
  engine.ingest([obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:05:00Z", 110)]);

  const lateObs = obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:00:00Z", 90);
  let busCalls = 0;
  engine.onDelta(() => busCalls++);
  const r = engine.ingest([lateObs]);

  assert.equal(r.deltas.length, 0);
  assert.equal(r.late, 1);
  assert.equal(busCalls, 0);
  assert.equal(engine.current("gen:test:alpha", "power.output.mw")[0].value, 110);

  // ...but it IS in history, which is sorted by event_time.
  const history = engine.history("gen:test:alpha", "power.output.mw");
  assert.deepEqual(history.map((o) => o.value), [90, 110]);
});

test("correction supersedes at equal event_time via corrects", () => {
  const engine = new StateEngine();
  const orig = obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:05:00Z", 110);
  engine.ingest([orig]);

  const corr = obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:05:00Z", 105, {
    is_correction: true,
    corrects: orig.observation_id,
  });
  const r = engine.ingest([corr]);

  assert.equal(r.corrections, 1);
  assert.equal(r.late, 0);
  assert.equal(r.deltas.length, 1);
  assert.equal(r.deltas[0].type, "state.corrected");
  assert.equal(r.deltas[0].state.value, 105);
  assert.equal(r.deltas[0].previous.value, 110);
  assert.equal(engine.current("gen:test:alpha", "power.output.mw")[0].value, 105);
});

test("correction supersedes at older event_time via source_sequence", () => {
  const engine = new StateEngine();
  const orig = obs("gen:test:beta", "power.output.mw", "2026-08-12T01:10:00Z", 50, {
    source_sequence: "DISPATCH-RUN-42",
  });
  engine.ingest([orig]);

  const corr = obs("gen:test:beta", "power.output.mw", "2026-08-12T01:05:00Z", 55, {
    is_correction: true,
    source_sequence: "DISPATCH-RUN-42",
  });
  const r = engine.ingest([corr]);

  assert.equal(r.corrections, 1);
  assert.equal(r.deltas[0].type, "state.corrected");
  assert.equal(r.deltas[0].previous.observation_id, orig.observation_id);
  assert.equal(engine.current("gen:test:beta", "power.output.mw")[0].value, 55);
});

test("a correction that matches neither corrects nor source_sequence follows time rules", () => {
  const engine = new StateEngine();
  engine.ingest([
    obs("gen:test:beta", "power.output.mw", "2026-08-12T01:10:00Z", 50, { source_sequence: "RUN-1" }),
  ]);
  const stray = obs("gen:test:beta", "power.output.mw", "2026-08-12T01:00:00Z", 999, {
    is_correction: true,
    corrects: "obs-does-not-match",
    source_sequence: "RUN-0",
  });
  const r = engine.ingest([stray]);
  assert.equal(r.deltas.length, 0);
  assert.equal(r.late, 1);
  assert.equal(engine.current("gen:test:beta", "power.output.mw")[0].value, 50);
});

test("duplicate observation_id is ignored everywhere", () => {
  const engine = new StateEngine();
  const a = obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:00:00Z", 100);
  engine.ingest([a]);
  const r = engine.ingest([a]);

  assert.equal(r.duplicates, 1);
  assert.equal(r.deltas.length, 0);
  assert.equal(r.late, 0);
  assert.equal(engine.history("gen:test:alpha", "power.output.mw").length, 1);
  assert.equal(engine.windows("gen:test:alpha", "power.output.mw", 300000)[0].count, 1);
});

test("deltas are emitted on the bus in ingest order and match the returned array", () => {
  const engine = new StateEngine();
  const seen = [];
  const unsubscribe = engine.onDelta((d) => seen.push(d));

  const batch = [
    obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:00:00Z", 1),
    obs("gen:test:beta", "grid.demand.mw", "2026-08-12T01:00:00Z", 2),
    obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:05:00Z", 3),
  ];
  const r = engine.ingest(batch);

  assert.equal(r.deltas.length, 3);
  assert.deepEqual(seen, r.deltas);
  assert.deepEqual(
    seen.map((d) => d.state.observation_id),
    batch.map((o) => o.observation_id),
  );

  unsubscribe();
  engine.ingest([obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:10:00Z", 4)]);
  assert.equal(seen.length, 3);
});

test("staleness is derived from event_time on demand, never stored", () => {
  const engine = new StateEngine();
  engine.ingest([obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:00:00Z", 100)]);
  assert.equal(engine.staleness("gen:test:alpha", "power.output.mw", "2026-08-12T01:07:30Z"), 450000);
  assert.equal(engine.staleness("gen:test:alpha", "no.such.metric"), null);
  assert.equal("staleness" in engine.current("gen:test:alpha", "power.output.mw")[0], false);
});

test("retentionPerKey bounds history per (entity, metric), keeping newest arrivals", () => {
  const engine = new StateEngine({ retentionPerKey: 3 });
  for (let i = 1; i <= 5; i++) {
    engine.ingest([obs("gen:test:alpha", "power.output.mw", `2026-08-12T01:0${i}:00Z`, i * 10)]);
  }
  const history = engine.history("gen:test:alpha", "power.output.mw");
  assert.deepEqual(history.map((o) => o.value), [30, 40, 50]);
  // Current state is untouched by eviction.
  assert.equal(engine.current("gen:test:alpha", "power.output.mw")[0].value, 50);
});

test("history honours inclusive from/to bounds; current(entityId) lists all metrics", () => {
  const engine = new StateEngine();
  engine.ingest([
    obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:00:00Z", 1),
    obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:05:00Z", 2),
    obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:10:00Z", 3),
    obs("gen:test:alpha", "power.capacity_factor", "2026-08-12T01:00:00Z", 0.4),
  ]);
  const ranged = engine.history("gen:test:alpha", "power.output.mw", {
    from: "2026-08-12T01:05:00Z",
    to: "2026-08-12T01:10:00Z",
  });
  assert.deepEqual(ranged.map((o) => o.value), [2, 3]);

  const all = engine.current("gen:test:alpha");
  assert.deepEqual(all.map((s) => s.metric), ["power.capacity_factor", "power.output.mw"]);
});

test("snapshot round-trips through GoldStore.snapshotState", () => {
  const store = new MedallionStore(mkdtempSync(join(tmpdir(), "pt-state-")));
  const engine = new StateEngine();
  engine.ingest([
    obs("gen:test:alpha", "power.output.mw", "2026-08-12T01:00:00Z", 100),
    obs("gen:test:beta", "grid.demand.mw", "2026-08-12T01:00:00Z", 7000),
  ]);

  const snap = engine.snapshot();
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(snap.at));
  assert.equal(snap.states.length, 2);
  // Deterministic order: (entity_id, metric).
  assert.deepEqual(snap.states.map((s) => s.entity_id), ["gen:test:alpha", "gen:test:beta"]);

  const path = store.gold.snapshotState(snap, snap.at);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), snap);
});

test("loadFromSilver replays a real MedallionStore feed with live semantics", () => {
  const store = new MedallionStore(mkdtempSync(join(tmpdir(), "pt-state-")));
  const orig = obs("gen:test:alpha", "power.output.mw", "2026-08-11T23:55:00Z", 80, {
    ingest_time: "2026-08-11T23:56:00Z",
    source_sequence: "RUN-A",
  });
  const newer = obs("gen:test:alpha", "power.output.mw", "2026-08-12T00:00:00Z", 90, {
    ingest_time: "2026-08-12T00:01:00Z",
    source_sequence: "RUN-B",
  });
  const corr = obs("gen:test:alpha", "power.output.mw", "2026-08-12T00:00:00Z", 92, {
    ingest_time: "2026-08-12T00:06:00Z",
    is_correction: true,
    source_sequence: "RUN-B",
  });
  const lateArrival = obs("gen:test:alpha", "power.output.mw", "2026-08-11T23:50:00Z", 70, {
    ingest_time: "2026-08-12T00:07:00Z",
  });
  const otherFeed = obs("region:test:qld", "grid.demand.mw", "2026-08-12T00:05:00Z", 6100, {
    ingest_time: "2026-08-12T00:08:00Z",
    feed_id: "feed:test:b",
  });
  store.silver.append([orig, newer, corr, lateArrival, otherFeed]);

  const engine = new StateEngine();
  const count = engine.loadFromSilver(store);
  assert.equal(count, 5);

  // Correction won over the equal-event-time original; late arrival did not regress state.
  assert.equal(engine.current("gen:test:alpha", "power.output.mw")[0].value, 92);
  assert.equal(engine.current("region:test:qld", "grid.demand.mw")[0].value, 6100);
  // History spans both silver day-partitions of feed:test:a, event-time sorted.
  assert.deepEqual(
    engine.history("gen:test:alpha", "power.output.mw").map((o) => o.value),
    [70, 80, 90, 92],
  );

  // Restricting to one feed replays only that feed.
  const scoped = new StateEngine();
  assert.equal(scoped.loadFromSilver(store, ["feed:test:b"]), 1);
  assert.equal(scoped.current("gen:test:alpha", "power.output.mw").length, 0);
});
