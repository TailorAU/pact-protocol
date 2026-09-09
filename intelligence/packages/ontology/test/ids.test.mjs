import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEntityId,
  isEntityId,
  isRelId,
  isSourceId,
  isGapId,
  isFeedId,
  isInferenceId,
  checkIdMatchesType,
  TYPE_CODES,
} from "../dist/index.js";

test("parseEntityId: three-segment id", () => {
  assert.deepEqual(parseEntityId("gen:au-nem:bayswater"), {
    typeCode: "gen",
    namespace: "au-nem",
    slug: "bayswater",
  });
});

test("parseEntityId: two-segment id has null slug", () => {
  assert.deepEqual(parseEntityId("grid:au-nem"), {
    typeCode: "grid",
    namespace: "au-nem",
    slug: null,
  });
});

test("parseEntityId: malformed ids return null", () => {
  for (const bad of [
    "",
    "gen",
    "Gen:au-nem:x",
    "gen:au-nem:Bayswater",
    "gen:-au:x",
    "gen:au:x:y",
    "gen:au_nem:x",
    "1gen:au:x",
    ":au:x",
  ]) {
    assert.equal(parseEntityId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("id predicate accept/reject table", () => {
  const table = [
    // [fn, accepted[], rejected[]]
    [isEntityId, ["gen:au-nem:bayswater", "grid:au-nem", "vessel:imo:9700100"], ["gen", "GEN:au:x", "gen:au:x:y", "rel bad"]],
    [isRelId, ["rel:bayswater-owned-by-agl", "rel:x1"], ["rel:", "rel:X", "gen:au-nem:x", "rel:a:b"]],
    [isSourceId, ["source:aemo:nem-dispatch", "source:gem:coal-plants"], ["source:aemo", "source:aemo:nem:extra", "src:aemo:x", "source:AEMO:x"]],
    [isGapId, ["gap:au-nem:tomago-load"], ["gap:au-nem", "gap:x:y:z", "gaps:a:b"]],
    [isFeedId, ["feed:aemo:scada", "feed:aemo:scada:nsw1"], ["feed:aemo", "feed:aemo:scada:nsw1:extra", "feeds:a:b"]],
    [isInferenceId, ["infer:2026-08-12:tomago-restart"], ["infer:2026-8-12:x", "infer:tomago", "infer:2026-08-12:", "infer:2026-08-12:X"]],
  ];
  for (const [fn, accepted, rejected] of table) {
    for (const id of accepted) {
      assert.equal(fn(id), true, `${fn.name} should accept ${JSON.stringify(id)}`);
    }
    for (const id of rejected) {
      assert.equal(fn(id), false, `${fn.name} should reject ${JSON.stringify(id)}`);
    }
  }
});

test("TYPE_CODES covers all 41 entity types", () => {
  assert.equal(Object.keys(TYPE_CODES).length, 41);
  assert.deepEqual(TYPE_CODES.Generator, ["gen"]);
  assert.deepEqual(TYPE_CODES.CoalMine, ["mine"]);
  assert.deepEqual(TYPE_CODES.Mine, ["mine"]);
});

test("checkIdMatchesType", () => {
  assert.equal(checkIdMatchesType("gen:au-nem:bayswater", "Generator"), true);
  assert.equal(checkIdMatchesType("grid:au-nem", "Grid"), true);
  // shared code: mine works for both CoalMine and Mine
  assert.equal(checkIdMatchesType("mine:au-nsw:mount-thorley", "CoalMine"), true);
  assert.equal(checkIdMatchesType("mine:au-wa:mount-whaleback", "Mine"), true);
  // mismatched code
  assert.equal(checkIdMatchesType("gen:au-nem:bayswater", "Vessel"), false);
  // malformed id
  assert.equal(checkIdMatchesType("not an id", "Generator"), false);
});
