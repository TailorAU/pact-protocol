import test from "node:test";
import assert from "node:assert/strict";
import { ulid, ulidTime, isUlid, ULID_RE } from "../dist/index.js";

test("ulid shape: 26 chars, Crockford base32, first char 0-7", () => {
  for (let i = 0; i < 50; i++) {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.match(id, ULID_RE);
    assert.equal(isUlid(id), true);
  }
});

test("ulid time round-trip", () => {
  const times = [0, 1, 1234567890123, Date.now(), 2 ** 48 - 1];
  for (const t of times) {
    assert.equal(ulidTime(ulid(t)), t, `round-trip failed for ${t}`);
  }
});

test("ulid lexical ordering follows increasing timestamps", () => {
  const base = Date.now();
  const ids = [];
  for (let i = 0; i < 100; i++) {
    ids.push(ulid(base + i * 1000));
  }
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids);
});

test("ulidTime rejects malformed input", () => {
  assert.throws(() => ulidTime("not-a-ulid"));
  assert.throws(() => ulidTime(""));
  // 26 chars but contains excluded letters (I, L, O, U)
  assert.throws(() => ulidTime("01ILOU0000000000000000000I"));
  // first char out of range (time overflow)
  assert.throws(() => ulidTime("81ARZ3NDEKTSV4RRFFQ69G5FAV"));
});

test("ulid rejects out-of-range time", () => {
  assert.throws(() => ulid(-1));
  assert.throws(() => ulid(2 ** 48));
  assert.throws(() => ulid(1.5));
});

test("isUlid predicate", () => {
  assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"), true);
  assert.equal(isUlid("01arz3ndektsv4rrffq69g5fav"), false); // lowercase not allowed
  assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA"), false); // too short
});
