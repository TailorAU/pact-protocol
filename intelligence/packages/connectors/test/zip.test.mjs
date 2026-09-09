import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { unzipFirst } from "../dist/index.js";

test("zip: fflate zipSync round-trips through unzipFirst", () => {
  const csv = "I,DISPATCH,PRICE,4,SETTLEMENTDATE,RRP\nD,DISPATCH,PRICE,4,\"2026/08/12 11:05:00\",84.50\n";
  const zipped = zipSync({ "PUBLIC_TEST.CSV": new TextEncoder().encode(csv) });
  const entry = unzipFirst(Buffer.from(zipped));
  assert.equal(entry.name, "PUBLIC_TEST.CSV");
  assert.equal(entry.data.toString("utf8"), csv);
});

test("zip: first non-directory entry wins; empty archive throws", () => {
  const zipped = zipSync({ "sub/": new Uint8Array(0), "sub/inner.txt": new TextEncoder().encode("x") });
  const entry = unzipFirst(Buffer.from(zipped));
  assert.equal(entry.name, "sub/inner.txt");
  assert.throws(() => unzipFirst(Buffer.from(zipSync({}))), /no file entries/);
});
