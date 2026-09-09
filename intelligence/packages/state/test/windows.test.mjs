import { test } from "node:test";
import assert from "node:assert/strict";
import { StateEngine, WindowAggregator, WINDOW_5M, WINDOW_1H } from "../dist/index.js";

let seq = 0;
const obs = (eventTime, value, extra = {}) => ({
  observation_id: `wobs-${String(++seq).padStart(4, "0")}`,
  entity_id: "gen:test:alpha",
  metric: "power.output.mw",
  value,
  unit: "MW",
  event_time: eventTime,
  ingest_time: eventTime,
  source_id: "source:test:feed",
  feed_id: "feed:test:a",
  quality: "good",
  ...extra,
});

test("tumbling windows compute min/max/mean/last/count per (entity, metric)", () => {
  const agg = new WindowAggregator();
  agg.add(obs("2026-08-12T01:01:00Z", 10));
  agg.add(obs("2026-08-12T01:02:00Z", 30));
  agg.add(obs("2026-08-12T01:04:00Z", 20));
  agg.add(obs("2026-08-12T01:06:00Z", 40)); // next 5-min window

  const w5 = agg.windows("gen:test:alpha", "power.output.mw", WINDOW_5M);
  assert.equal(w5.length, 2);
  assert.equal(w5[0].window_start, "2026-08-12T01:00:00.000Z");
  assert.equal(w5[0].window_end, "2026-08-12T01:05:00.000Z");
  assert.deepEqual(
    [w5[0].min, w5[0].max, w5[0].mean, w5[0].last, w5[0].count],
    [10, 30, 20, 20, 3],
  );
  assert.deepEqual([w5[1].min, w5[1].max, w5[1].count], [40, 40, 1]);

  // The same observations roll into one 1-hour window.
  const w1h = agg.windows("gen:test:alpha", "power.output.mw", WINDOW_1H);
  assert.equal(w1h.length, 1);
  assert.deepEqual([w1h[0].min, w1h[0].max, w1h[0].mean, w1h[0].last, w1h[0].count], [10, 40, 25, 40, 4]);
});

test("last tracks the latest event_time within the window, not arrival order", () => {
  const agg = new WindowAggregator();
  agg.add(obs("2026-08-12T01:04:00Z", 99));
  agg.add(obs("2026-08-12T01:01:00Z", 11)); // arrives later, but is earlier in event time
  const [w] = agg.windows("gen:test:alpha", "power.output.mw", WINDOW_5M);
  assert.equal(w.last, 99);
  assert.equal(w.count, 2);
});

test("an observation landing in a watermark-closed window patches it and flags revised", () => {
  const agg = new WindowAggregator(); // default allowed lateness: 10 min
  agg.add(obs("2026-08-12T01:01:00Z", 10));
  agg.add(obs("2026-08-12T01:04:00Z", 30));

  // Advance the watermark past the [01:00, 01:05) window: 01:59 - 10 min = 01:49.
  const advance = agg.add(obs("2026-08-12T01:59:00Z", 50));
  assert.equal(advance.revised, false);
  assert.equal(agg.watermarkMs(), Date.parse("2026-08-12T01:49:00Z"));

  // Late data into the closed window: patched, reported as a revision.
  const late = agg.add(obs("2026-08-12T01:03:00Z", 100));
  assert.equal(late.accepted, true);
  assert.equal(late.revised, true);
  const patched5m = late.aggregates.find((a) => a.window_ms === WINDOW_5M);
  assert.deepEqual(
    [patched5m.min, patched5m.max, patched5m.mean, patched5m.last, patched5m.count],
    [10, 100, (10 + 30 + 100) / 3, 30, 3],
  );

  // The revision is visible on subsequent reads too.
  const [w] = agg.windows("gen:test:alpha", "power.output.mw", WINDOW_5M);
  assert.deepEqual([w.min, w.max, w.count], [10, 100, 3]);

  // The 1h window [01:00, 02:00) is still open (ends after the watermark),
  // so the same late observation revised only the 5-minute window.
  const patched1h = late.aggregates.find((a) => a.window_ms === WINDOW_1H);
  assert.equal(patched1h.count, 4);
});

test("allowedLatenessMs is configurable and an observation never closes its own window", () => {
  const agg = new WindowAggregator({ allowedLatenessMs: 60_000 });
  assert.equal(agg.watermarkMs(), null);
  const first = agg.add(obs("2026-08-12T01:04:00Z", 10));
  assert.equal(first.revised, false);
  // Watermark now 01:03; the [01:00, 01:05) window is still open.
  const inWindow = agg.add(obs("2026-08-12T01:00:30Z", 20));
  assert.equal(inWindow.revised, false);
  // Jump ahead so 01:10 - 1 min lateness closes everything before 01:09...
  agg.add(obs("2026-08-12T01:10:00Z", 30));
  // ...then even a same-window repeat of a closed window is a revision.
  const late = agg.add(obs("2026-08-12T01:01:00Z", 40));
  assert.equal(late.revised, true);
});

test("non-numeric values are skipped by windows but still drive current state", () => {
  const engine = new StateEngine();
  const r = engine.ingest([
    obs("2026-08-12T01:00:00Z", { lat: -27.4, lon: 153.1, speed_kn: 11.5 }, {
      entity_id: "vessel:imo:9999999",
      metric: "vessel.position",
      unit: undefined,
    }),
  ]);
  assert.equal(r.deltas.length, 1);
  assert.deepEqual(engine.current("vessel:imo:9999999", "vessel.position")[0].value.speed_kn, 11.5);
  assert.equal(engine.windows("vessel:imo:9999999", "vessel.position", WINDOW_5M).length, 0);

  const direct = new WindowAggregator();
  const skipped = direct.add(obs("2026-08-12T01:00:00Z", "not-a-number"));
  assert.deepEqual(skipped, { accepted: false, revised: false, aggregates: [] });
});

test("engine.windows exposes late revisions after ingest", () => {
  const engine = new StateEngine();
  engine.ingest([
    obs("2026-08-12T01:01:00Z", 10),
    obs("2026-08-12T01:59:00Z", 50), // watermark → 01:49, closes [01:00, 01:05)
  ]);
  const late = obs("2026-08-12T01:02:00Z", 90);
  const r = engine.ingest([late]);
  assert.equal(r.late, 1); // history-only for current state...
  const [w] = engine.windows("gen:test:alpha", "power.output.mw", WINDOW_5M);
  // ...but the closed 5-min window was patched.
  assert.deepEqual([w.min, w.max, w.count], [10, 90, 2]);
});
