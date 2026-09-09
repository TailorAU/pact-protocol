import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayGate, ReplayMessageGate, REPLAY_UNMATCHED_STATUS } from "../dist/index.js";

function fixtureDirWith(exchanges) {
  const dir = mkdtempSync(join(tmpdir(), "pt-gate-"));
  mkdirSync(join(dir, "exchanges"), { recursive: true });
  exchanges.forEach((exchange, i) => {
    writeFileSync(join(dir, "exchanges", `0${i}-x.json`), JSON.stringify(exchange));
  });
  return dir;
}

test("ReplayGate: exact URL match wins over prefix; longest prefix otherwise", async () => {
  const dir = fixtureDirWith([
    { url_pattern: "https://x.test/reports/", status: 200, content_type: "text/html", body_base64: Buffer.from("listing").toString("base64") },
    { url_pattern: "https://x.test/reports/a.zip", status: 200, body_base64: Buffer.from("exact").toString("base64") },
    { url_pattern: "https://x.test/", status: 200, body_base64: Buffer.from("root").toString("base64") },
  ]);
  const gate = new ReplayGate(dir);
  assert.equal(gate.kind, "replay");
  assert.equal((await gate.get("https://x.test/reports/a.zip")).body.toString(), "exact");
  // no exact match → longest prefix (the /reports/ listing, not the root)
  const prefixed = await gate.get("https://x.test/reports/b.zip");
  assert.equal(prefixed.body.toString(), "listing");
  assert.equal(prefixed.content_type, "text/html");
  assert.equal((await gate.get("https://x.test/other")).body.toString(), "root");
});

test("ReplayGate: unmatched URL surfaces as status 599, not a silent pass", async () => {
  const gate = new ReplayGate(fixtureDirWith([]));
  const res = await gate.get("https://nothing.test/at-all");
  assert.equal(res.status, REPLAY_UNMATCHED_STATUS);
  assert.equal(res.body.length, 0);
});

test("ReplayMessageGate: replays JSONL lines in order with zero delay; missing file → []", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-mgate-"));
  const file = join(dir, "messages.jsonl");
  writeFileSync(file, '{"a":1}\n{"a":2}\n\n{"a":3}\n');
  const gate = new ReplayMessageGate(file);
  const all = await gate.collect("wss://ignored", { APIKey: "" });
  assert.deepEqual(all.map((b) => JSON.parse(b.toString()).a), [1, 2, 3]);
  const capped = await gate.collect("wss://ignored", {}, { maxMessages: 2 });
  assert.equal(capped.length, 2);
  const empty = new ReplayMessageGate(join(dir, "absent.jsonl"));
  assert.deepEqual(await empty.collect("wss://ignored", {}), []);
});
