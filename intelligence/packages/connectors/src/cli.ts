#!/usr/bin/env node
// pt-ingest — connector ingestion CLI.
//
//   pt-ingest ingest --replay [--var <dir>] [--data <dir>]
//       Run every connector once against its committed fixtures via
//       ReplayGate/ReplayMessageGate (synthetic-from-spec — no network).
//       Prints a per-connector IngestReport table. Exit 0 even with unmapped
//       ids (they are reported, not errors); non-zero on hard errors.
//
//   pt-ingest ingest --watch [--var <dir>] [--data <dir>]
//       LiveGate + cooperative scheduler loop. In an egress-blocked
//       environment this fails fast per pass — expected and honest.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "@pact-tailor/registry";
import { MedallionStore } from "@pact-tailor/store";
import type { EntityRecord } from "@pact-tailor/ontology";
import { EntityIndex } from "./entity-index.js";
import { LiveGate, LiveMessageGate, ReplayGate, ReplayMessageGate } from "./gate.js";
import type { Connector, ConnectorCtx } from "./sdk.js";
import { runOnce, Scheduler, type IngestReport } from "./scheduler.js";
import { allConnectors } from "./connectors/index.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // packages/connectors
const INTEL_ROOT = resolve(PKG_ROOT, "..", ".."); // intelligence/

interface CliArgs {
  command: string | undefined;
  replay: boolean;
  watch: boolean;
  varDir: string;
  dataDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: undefined,
    replay: false,
    watch: false,
    varDir: join(INTEL_ROOT, "var"),
    dataDir: join(INTEL_ROOT, "data"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--replay") args.replay = true;
    else if (arg === "--watch") args.watch = true;
    else if (arg === "--var") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--var requires a directory argument");
      args.varDir = resolve(v);
    } else if (arg === "--data") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--data requires a directory argument");
      args.dataDir = resolve(v);
    } else if (!arg.startsWith("-") && args.command === undefined) args.command = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** Registry entities + connector seedEntities (registry wins on collision). */
function buildEntityIndex(dataDir: string, connectors: Connector[]): EntityIndex {
  const byId = new Map<string, EntityRecord>();
  for (const connector of connectors) {
    for (const seed of connector.seedEntities ?? []) byId.set(seed.entity_id, seed);
  }
  if (existsSync(dataDir)) {
    const { data, errors } = loadRegistry(dataDir);
    if (errors.length > 0) {
      console.error(`warning: registry load reported ${errors.length} validation error(s); invalid records excluded`);
    }
    for (const entity of data.entities) byId.set(entity.entity_id, entity);
  } else {
    console.error(`warning: data dir ${dataDir} does not exist; EntityIndex holds connector seed entities only`);
  }
  return new EntityIndex([...byId.values()]);
}

function makeCtxFactory(mode: "replay" | "live", entityIndex: EntityIndex): (connector: Connector) => ConnectorCtx {
  return (connector: Connector): ConnectorCtx => {
    const log = (msg: string) => console.error(`[${connector.id}] ${msg}`);
    if (mode === "replay") {
      const fixturesDir = join(PKG_ROOT, "fixtures", connector.id);
      return {
        gate: new ReplayGate(fixturesDir),
        messageGate: new ReplayMessageGate(join(fixturesDir, "messages.jsonl")),
        now: () => new Date().toISOString(),
        entityIndex,
        log,
      };
    }
    return {
      gate: new LiveGate(),
      messageGate: new LiveMessageGate(),
      now: () => new Date().toISOString(),
      entityIndex,
      log,
    };
  };
}

function printReportTable(reports: IngestReport[]): void {
  const headers = ["connector", "artifacts", "skipped", "observations", "unmapped", "errors"];
  const rows = reports.map((r) => [
    r.connector_id,
    String(r.artifacts),
    String(r.skipped),
    String(r.observations),
    r.unmapped.length === 0 ? "-" : `${r.unmapped.length}: ${r.unmapped.join(",")}`,
    r.errors.length === 0 ? "-" : `${r.errors.length}: ${r.errors.join(" | ")}`,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(headers));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(row));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "ingest" || args.replay === args.watch) {
    console.error("usage: pt-ingest ingest (--replay | --watch) [--var <dir>] [--data <dir>]");
    return 2;
  }

  mkdirSync(args.varDir, { recursive: true });
  const store = new MedallionStore(args.varDir);
  const entityIndex = buildEntityIndex(args.dataDir, allConnectors);
  console.error(`entity index: ${entityIndex.size} entities (registry + connector seeds)`);

  if (args.replay) {
    const makeCtx = makeCtxFactory("replay", entityIndex);
    const reports: IngestReport[] = [];
    for (const connector of allConnectors) {
      reports.push(await runOnce(connector, makeCtx(connector), store));
    }
    printReportTable(reports);
    const hardErrors = reports.flatMap((r) => r.errors);
    if (hardErrors.length > 0) {
      console.error(`${hardErrors.length} hard error(s) — see table`);
      return 1;
    }
    return 0;
  }

  // --watch: live scheduler loop. Runs until SIGINT/SIGTERM. Under blocked
  // egress every pass fails fast — that is expected, and reported honestly.
  const makeCtx = makeCtxFactory("live", entityIndex);
  const scheduler = new Scheduler(store, makeCtx, (report) => {
    const status = report.errors.length > 0 ? "ERR" : "ok";
    console.log(
      `[${new Date().toISOString()}] ${report.connector_id}: ${status} artifacts=${report.artifacts} skipped=${report.skipped} obs=${report.observations}` +
        (report.unmapped.length > 0 ? ` unmapped=${report.unmapped.join(",")}` : "") +
        (report.errors.length > 0 ? ` errors=${report.errors.join(" | ")}` : ""),
    );
  });
  scheduler.start(allConnectors);
  await new Promise<void>((resolveWait) => {
    const stop = () => {
      scheduler.stop();
      resolveWait();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`pt-ingest: ${(err as Error).message}`);
    process.exit(1);
  },
);
