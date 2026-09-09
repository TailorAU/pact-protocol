import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAemoCsv, splitCsvLine, nemTimeToIso } from "../dist/index.js";

test("splitCsvLine: quoted fields, embedded commas, doubled quotes", () => {
  assert.deepEqual(splitCsvLine('D,DISPATCH,PRICE,4,"2026/08/12 11:05:00",1'), [
    "D",
    "DISPATCH",
    "PRICE",
    "4",
    "2026/08/12 11:05:00",
    "1",
  ]);
  assert.deepEqual(splitCsvLine('A,"a,b",c'), ["A", "a,b", "c"]);
  assert.deepEqual(splitCsvLine('A,"say ""hi""",z'), ["A", 'say "hi"', "z"]);
  assert.deepEqual(splitCsvLine("A,,B"), ["A", "", "B"]);
});

test("parseAemoCsv: I/D/C handling with multiple tables in one file", () => {
  const csv = [
    "C,NEMP.WORLD,DISPATCHIS,AEMO,PUBLIC,2026/08/12,11:05:04,0000000000000001",
    "I,DISPATCH,PRICE,4,SETTLEMENTDATE,RUNNO,REGIONID,RRP",
    'D,DISPATCH,PRICE,4,"2026/08/12 11:05:00",1,QLD1,84.50',
    'D,DISPATCH,PRICE,4,"2026/08/12 11:05:00",1,NSW1,92.10',
    "I,DISPATCH,REGIONSUM,4,SETTLEMENTDATE,RUNNO,REGIONID,TOTALDEMAND",
    'D,DISPATCH,REGIONSUM,4,"2026/08/12 11:05:00",1,QLD1,6123.45',
    'C,"END OF REPORT",6',
  ].join("\r\n");
  const tables = parseAemoCsv(csv);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].table, "DISPATCH.PRICE");
  assert.equal(tables[0].rows.length, 2);
  assert.deepEqual(tables[0].rows[0], {
    SETTLEMENTDATE: "2026/08/12 11:05:00",
    RUNNO: "1",
    REGIONID: "QLD1",
    RRP: "84.50",
  });
  assert.equal(tables[1].table, "DISPATCH.REGIONSUM");
  assert.equal(tables[1].rows[0].TOTALDEMAND, "6123.45");
});

test("parseAemoCsv: repeated I rows for the same table merge their D rows", () => {
  const csv = [
    "I,T,X,1,A,B",
    "D,T,X,1,1,2",
    "I,T,X,1,A,B",
    "D,T,X,1,3,4",
  ].join("\n");
  const tables = parseAemoCsv(csv);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows.length, 2);
});

test("parseAemoCsv: missing trailing values become empty strings", () => {
  const tables = parseAemoCsv(["I,T,X,1,A,B,C", "D,T,X,1,only"].join("\n"));
  assert.deepEqual(tables[0].rows[0], { A: "only", B: "", C: "" });
});

test("parseAemoCsv: D row before its I row throws", () => {
  assert.throws(() => parseAemoCsv("D,DISPATCH,PRICE,4,x"), /before its I row/);
});

test("nemTimeToIso: NEM time is UTC+10 fixed (no DST)", () => {
  assert.equal(nemTimeToIso("2026/08/12 14:05:00"), "2026-08-12T04:05:00Z");
  assert.equal(nemTimeToIso("2026/08/12 11:05:00"), "2026-08-12T01:05:00Z");
  // dashboard variant with T separator and dashes
  assert.equal(nemTimeToIso("2026-08-12T11:05:00"), "2026-08-12T01:05:00Z");
});

test("nemTimeToIso: midnight and year rollovers", () => {
  assert.equal(nemTimeToIso("2026/08/12 09:59:59"), "2026-08-11T23:59:59Z");
  assert.equal(nemTimeToIso("2026/01/01 04:00:00"), "2025-12-31T18:00:00Z");
});

test("nemTimeToIso: malformed input throws", () => {
  assert.throws(() => nemTimeToIso("12/08/2026 11:05"), /unrecognised NEM timestamp/);
});
