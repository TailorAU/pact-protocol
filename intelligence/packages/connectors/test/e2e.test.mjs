// End-to-end: runOnce → bronze + silver in a temp MedallionStore, idempotent
// re-runs, and the pt-ingest CLI over every connector's fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MedallionStore } from "@pact-tailor/store";
import { aemoNemwebDispatchis, runOnce } from "../dist/index.js";
import { nemEntities, testCtx, PKG_ROOT } from "./helpers.mjs";

test("runOnce: discover→fetch→bronze→parse→normalize→silver, idempotent re-run", async () => {
  const varDir = mkdtempSync(join(tmpdir(), "pt-e2e-"));
  const store = new MedallionStore(varDir);
  const ctx = testCtx(aemoNemwebDispatchis.id, nemEntities);

  const first = await runOnce(aemoNemwebDispatchis, ctx, store);
  assert.equal(first.connector_id, "aemo-nemweb-dispatchis");
  assert.equal(first.artifacts, 1);
  assert.equal(first.skipped, 0);
  assert.equal(first.observations, 8);
  assert.deepEqual(first.unmapped.sort(), ["MADEUP-X1", "SA1"]);
  assert.deepEqual(first.errors, []);

  // bronze holds the verbatim ZIP
  const bronze = store.bronze.list("source:aemo:nemweb-dispatchis");
  assert.equal(bronze.length, 1);
  assert.ok(bronze[0].url.endsWith("PUBLIC_DISPATCHIS_202608121105_0000000123456789.zip"));
  assert.equal(bronze[0].http_status, 200);
  const body = store.bronze.get(bronze[0].source_id, bronze[0].artifact_id).body;
  assert.deepEqual(body.subarray(0, 2), Buffer.from("PK")); // still a ZIP, byte-for-byte

  // silver holds the normalized observations, partitioned by feed
  assert.equal(store.silver.readFeed("feed:au-nem:dispatch:price").length, 3);
  assert.equal(store.silver.readFeed("feed:au-nem:dispatch:regionsum").length, 4);
  assert.equal(store.silver.readFeed("feed:au-nem:dispatch:interconnectorres").length, 1);

  // re-run: identical bytes are sha-skipped — no duplicate bronze, no duplicate silver
  const second = await runOnce(aemoNemwebDispatchis, ctx, store);
  assert.equal(second.artifacts, 0);
  assert.equal(second.skipped, 1);
  assert.equal(second.observations, 0);
  assert.deepEqual(second.errors, []);
  assert.equal(store.bronze.list("source:aemo:nemweb-dispatchis").length, 1);
  assert.equal(store.silver.readFeed("feed:au-nem:dispatch:price").length, 3);
});

test("pt-ingest ingest --replay: runs every connector over fixtures, exit 0", () => {
  const varDir = mkdtempSync(join(tmpdir(), "pt-cli-"));
  // --data points at an empty temp dir: hermetic — only connector seedEntities
  // resolve (BOM), everything else reports unmapped. Exit must still be 0.
  const dataDir = mkdtempSync(join(tmpdir(), "pt-cli-data-"));
  const stdout = execFileSync(process.execPath, [
    join(PKG_ROOT, "dist", "cli.js"),
    "ingest",
    "--replay",
    "--var",
    varDir,
    "--data",
    dataDir,
  ]).toString();
  assert.match(stdout, /aemo-nemweb-dispatchis/);
  assert.match(stdout, /eia-v2/);

  const store = new MedallionStore(varDir);
  // every non-stream connector left exactly one bronze artifact
  for (const sourceId of [
    "source:aemo:nemweb-dispatchis",
    "source:aemo:nemweb-dispatch-scada",
    "source:aemo:nemweb-tradingis",
    "source:aemo:vis-nem-summary",
    "source:aisstream:websocket",
    "source:bom:observations",
    "source:entsoe:transparency-platform",
    "source:eia:api-v2",
  ]) {
    assert.equal(store.bronze.list(sourceId).length, 1, `bronze for ${sourceId}`);
  }
  // BOM's seed entity resolves without any registry data
  assert.equal(store.silver.readFeed("feed:weather:bom:qld-obs").length, 6);
});
