#!/usr/bin/env node
// verify:live — the live verification harness.
//
// For each connector: attempt ONE live discover → fetch → parse round trip
// (or the connector's own verify() probe), then write the results to
// var/verify-report.json and print a table.
//
// THIS HARNESS NEVER UPDATES THE YAML REGISTRIES. `verification_status` in
// data/registries/sources/*.yaml is upgraded to `verified_live` only by a
// human, after reviewing var/verify-report.json — honesty rule: nothing
// authored under blocked egress may claim live verification, and no tool may
// claim it automatically.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EntityIndex } from "./entity-index.js";
import { LiveGate, LiveMessageGate } from "./gate.js";
import type { Connector, ConnectorCtx, VerificationReport } from "./sdk.js";
import { allConnectors } from "./connectors/index.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEL_ROOT = resolve(PKG_ROOT, "..", "..");

function makeCtx(connector: Connector): ConnectorCtx {
  return {
    gate: new LiveGate(),
    messageGate: new LiveMessageGate(),
    now: () => new Date().toISOString(),
    // Verification exercises discover/fetch/parse only; no entity resolution.
    entityIndex: new EntityIndex([]),
    log: (msg: string) => console.error(`[${connector.id}] ${msg}`),
  };
}

async function verifyOne(connector: Connector): Promise<VerificationReport> {
  const ctx = makeCtx(connector);
  const checkedAt = ctx.now();
  if (connector.verify) return connector.verify(ctx);
  try {
    const refs = await connector.discover(ctx);
    const first = refs[0];
    if (first === undefined) {
      return {
        connector_id: connector.id,
        source_id: connector.source_id,
        ok: false,
        error: "discover returned no artifacts",
        checked_at: checkedAt,
      };
    }
    const raw = await connector.fetch(first, ctx);
    const parsed = await connector.parse(raw);
    return {
      connector_id: connector.id,
      source_id: connector.source_id,
      ok: true,
      checked_at: checkedAt,
      notes: `${first.name}: ${raw.body.length} bytes, ${parsed.length} parsed record(s)`,
    };
  } catch (err) {
    return {
      connector_id: connector.id,
      source_id: connector.source_id,
      ok: false,
      error: (err as Error).message,
      checked_at: checkedAt,
    };
  }
}

async function main(): Promise<number> {
  const reports: VerificationReport[] = [];
  for (const connector of allConnectors) {
    console.error(`verifying ${connector.id} ...`);
    reports.push(await verifyOne(connector));
  }

  const varDir = join(INTEL_ROOT, "var");
  mkdirSync(varDir, { recursive: true });
  const reportPath = join(varDir, "verify-report.json");
  writeFileSync(reportPath, JSON.stringify(reports, null, 2) + "\n");

  const headers = ["connector", "source", "ok", "detail"];
  const rows = reports.map((r) => [r.connector_id, r.source_id, r.ok ? "yes" : "NO", r.error ?? r.notes ?? "-"]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(headers));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(row));
  console.log(`\nreport written to ${reportPath}`);
  console.log(
    "NOTE: registry verification_status is NOT updated by this tool — a human reviews the report and edits the YAML.",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`verify-live: ${(err as Error).message}`);
    process.exit(1);
  },
);
