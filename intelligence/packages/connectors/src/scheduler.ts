// runOnce — one full discover→fetch→bronze→parse→normalize→silver pass for a
// connector — plus a cooperative setTimeout scheduler for --watch mode.

import { createHash } from "node:crypto";
import type { MedallionStore } from "@pact-tailor/store";
import type { Connector, ConnectorCtx } from "./sdk.js";

export interface IngestReport {
  connector_id: string;
  /** Newly ingested artifacts (bronze puts) this pass. */
  artifacts: number;
  /** Artifacts skipped because bronze already holds identical bytes (sha256). */
  skipped: number;
  observations: number;
  unmapped: string[];
  errors: string[];
}

/**
 * Run one connector pass. Artifacts whose bytes (sha256) are already in
 * bronze are skipped entirely — no re-put, no re-append — which makes
 * repeated runs over the same fixtures/files idempotent. Per-artifact
 * failures are recorded and do not abort the pass.
 */
export async function runOnce(connector: Connector, ctx: ConnectorCtx, store: MedallionStore): Promise<IngestReport> {
  const report: IngestReport = {
    connector_id: connector.id,
    artifacts: 0,
    skipped: 0,
    observations: 0,
    unmapped: [],
    errors: [],
  };

  let refs;
  try {
    refs = await connector.discover(ctx);
  } catch (err) {
    report.errors.push(`discover: ${(err as Error).message}`);
    return report;
  }

  const knownShas = new Set(store.bronze.list(connector.source_id).map((meta) => meta.sha256));

  for (const ref of refs) {
    try {
      const raw = await connector.fetch(ref, ctx);
      const sha256 = createHash("sha256").update(raw.body).digest("hex");
      if (knownShas.has(sha256)) {
        report.skipped++;
        continue;
      }
      store.bronze.put({
        source_id: connector.source_id,
        url: ref.url,
        fetched_at: raw.fetched_at,
        http_status: raw.http_status,
        ...(raw.content_type !== undefined ? { content_type: raw.content_type } : {}),
        body: raw.body,
      });
      knownShas.add(sha256);
      const parsed = await connector.parse(raw);
      const { observations, unmapped } = connector.normalize(parsed, ctx);
      if (observations.length > 0) store.silver.append(observations);
      report.artifacts++;
      report.observations += observations.length;
      for (const id of unmapped) {
        if (!report.unmapped.includes(id)) report.unmapped.push(id);
      }
    } catch (err) {
      report.errors.push(`${ref.name}: ${(err as Error).message}`);
    }
  }
  return report;
}

/**
 * Cooperative per-connector loop: setTimeout at intervalMs plus uniform
 * random jitter, rescheduled after each pass completes (no overlap per
 * connector). Production swaps this for real workers + a queue — the
 * Connector interface is the seam (STORAGE.md).
 */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly store: MedallionStore,
    private readonly makeCtx: (connector: Connector) => ConnectorCtx,
    private readonly onReport?: (report: IngestReport) => void,
  ) {}

  start(connectors: Connector[]): void {
    this.stopped = false;
    for (const connector of connectors) {
      // First pass soon, spread by jitter so connectors don't stampede.
      this.schedule(connector, Math.random() * connector.schedule.jitterMs);
    }
  }

  private schedule(connector: Connector, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void (async () => {
        let report: IngestReport;
        try {
          report = await runOnce(connector, this.makeCtx(connector), this.store);
        } catch (err) {
          report = {
            connector_id: connector.id,
            artifacts: 0,
            skipped: 0,
            observations: 0,
            unmapped: [],
            errors: [`pass: ${(err as Error).message}`],
          };
        }
        this.onReport?.(report);
        this.schedule(connector, connector.schedule.intervalMs + Math.random() * connector.schedule.jitterMs);
      })();
    }, delayMs);
    this.timers.set(connector.id, timer);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
