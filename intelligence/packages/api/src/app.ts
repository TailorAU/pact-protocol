// buildApp — composes registry ⊕ graph ⊕ state ⊕ gaps ⊕ inferences into one
// application object the HTTP layer serves. Also owns the SSE hub (typed
// delta/inference broadcasting) and the replay clock.
import type { ServerResponse } from "node:http";
import {
  createValidators,
  type InferenceRecord,
  type ObservationRecord,
  type Validators,
} from "@pact-tailor/ontology";
import { loadRegistry, gridEntitiesFrom, checkIntegrity, type RegistryData } from "@pact-tailor/registry";
import { KnowledgeGraph } from "@pact-tailor/graph";
import { StateEngine, type StateDelta } from "@pact-tailor/state";
import { MedallionStore } from "@pact-tailor/store";
import { IntelEngine } from "@pact-tailor/intel";

// ---------------------------------------------------------------------------
// SSE hub
// ---------------------------------------------------------------------------

export interface SseFilters {
  /** Allow-list of entity_ids (null = all). */
  entities: Set<string> | null;
  /** Allow-list of metrics (null = all). */
  metrics: Set<string> | null;
}

interface SseClient extends SseFilters {
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

export const SSE_HEARTBEAT_MS = 15_000;

export class SseHub {
  private readonly clients = new Set<SseClient>();

  constructor(private readonly heartbeatMs: number = SSE_HEARTBEAT_MS) {}

  get size(): number {
    return this.clients.size;
  }

  /** Attach a response as an SSE stream: headers, hello event, heartbeat, cleanup. */
  subscribe(res: ServerResponse, filters: SseFilters, hello: unknown): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, this.heartbeatMs);
    heartbeat.unref?.();
    const client: SseClient = { res, heartbeat, ...filters };
    this.clients.add(client);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
    });
  }

  /** Forward a state delta as `event: state.updated | state.corrected`. */
  broadcastDelta(delta: StateDelta): void {
    for (const client of this.clients) {
      if (client.entities && !client.entities.has(delta.state.entity_id)) continue;
      if (client.metrics && !client.metrics.has(delta.state.metric)) continue;
      client.res.write(
        `event: ${delta.type}\ndata: ${JSON.stringify({
          state: delta.state,
          previous: delta.previous,
          data_class: "telemetry",
        })}\n\n`,
      );
    }
  }

  /** Forward a freshly produced inference as `event: inference`. */
  broadcastInference(inference: InferenceRecord): void {
    for (const client of this.clients) {
      if (client.entities && !client.entities.has(inference.claim_structured.subject)) continue;
      client.res.write(
        `event: inference\ndata: ${JSON.stringify({ inference, data_class: "derived" })}\n\n`,
      );
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      client.res.end();
    }
    this.clients.clear();
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export interface BuildAppOptions {
  /** Registry root (normally intelligence/data). */
  dataDir: string;
  /** Medallion root (normally intelligence/var). */
  varDir: string;
  /** Replay mode: boot on half the silver history, tick the rest through the real ingest path. */
  replay?: boolean;
  /** Replay tick interval, ms (default 3000; tests use a smaller value). */
  replayTickMs?: number;
}

export interface IntelApp {
  registry: RegistryData;
  graph: KnowledgeGraph;
  state: StateEngine;
  store: MedallionStore;
  intel: IntelEngine;
  validators: Validators;
  sse: SseHub;
  replay: boolean;
  bootedAt: string;
  /** Observations still queued for the replay ticker. */
  replayRemaining(): number;
  startReplayTicker(): void;
  stopReplayTicker(): void;
  /** Detach all subscriptions, stop timers, end SSE streams. */
  close(): void;
}

export function buildApp(opts: BuildAppOptions): IntelApp {
  const validators = createValidators();

  const { data, errors } = loadRegistry(opts.dataDir, validators);
  if (errors.length > 0) {
    throw new Error(`api: registry failed to load (${errors.length} error(s)):\n${errors.join("\n")}`);
  }
  const integrityProblems = checkIntegrity(data);
  if (integrityProblems.length > 0) {
    // Referential problems are surfaced, not fatal — schema-valid records still serve.
    console.warn(`api: registry integrity problems (${integrityProblems.length}): ${integrityProblems.join("; ")}`);
  }

  const graph = new KnowledgeGraph();
  graph.load([...data.entities, ...gridEntitiesFrom(data.grids)], data.relationships);

  const store = new MedallionStore(opts.varDir);
  const state = new StateEngine();
  const replay = opts.replay === true;

  // Replay clock (honest by construction): no synthetic observations and no
  // re-stamped event_times. All silver observations are sorted by event_time;
  // the first half is ingested at boot, and the ticker ingests the remainder
  // — one event-second batch per tick — through the REAL ingest path, so
  // every delta consumers see is a genuine engine delta over genuine data on
  // a compressed clock. When the queue drains the ticker stops (no looping).
  let replayQueue: ObservationRecord[] = [];
  if (replay) {
    const all: ObservationRecord[] = [];
    for (const feedId of store.silver.listFeeds()) all.push(...store.silver.readFeed(feedId));
    all.sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time));
    const boot = Math.floor(all.length / 2);
    state.ingest(all.slice(0, boot));
    replayQueue = all.slice(boot);
  } else {
    state.loadFromSilver(store);
  }

  const intel = new IntelEngine({ graph, state, gaps: data.gaps });
  intel.runAll();
  intel.persistTo(store);
  const detachIntel = intel.attach(); // react mode: scoped anomaly re-runs on deltas

  const sse = new SseHub();
  const offDelta = state.onDelta((delta) => sse.broadcastDelta(delta));
  const offInference = intel.onInference((inference) => sse.broadcastInference(inference));

  let ticker: NodeJS.Timeout | null = null;
  const tickMs = opts.replayTickMs ?? 3000;

  const stopReplayTicker = (): void => {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const startReplayTicker = (): void => {
    if (!replay || ticker !== null) return;
    ticker = setInterval(() => {
      if (replayQueue.length === 0) {
        console.log("replay drained");
        stopReplayTicker();
        return;
      }
      const head = replayQueue[0] as ObservationRecord;
      const second = head.event_time.slice(0, 19);
      const batch: ObservationRecord[] = [];
      while (replayQueue.length > 0 && (replayQueue[0] as ObservationRecord).event_time.slice(0, 19) === second) {
        batch.push(replayQueue.shift() as ObservationRecord);
      }
      state.ingest(batch);
    }, tickMs);
    ticker.unref?.();
  };

  return {
    registry: data,
    graph,
    state,
    store,
    intel,
    validators,
    sse,
    replay,
    bootedAt: new Date().toISOString(),
    replayRemaining: () => replayQueue.length,
    startReplayTicker,
    stopReplayTicker,
    close(): void {
      stopReplayTicker();
      offDelta();
      offInference();
      detachIntel();
      sse.closeAll();
    },
  };
}
