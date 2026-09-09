// HttpGate — the replay/live seam. Connectors call gate.get(url) and never
// know whether bytes came from the network or from committed fixtures; replay
// is the SAME code path as live. ReplayGate serves synthetic exchanges
// (fixture_provenance: synthetic-from-spec) and answers unmatched URLs with
// status 599 so a connector's gaps surface honestly instead of silently
// passing.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface GateResponse {
  status: number;
  body: Buffer;
  content_type?: string;
}

export interface HttpGate {
  get(url: string): Promise<GateResponse>;
  kind: "replay" | "live";
}

/** Synthetic status for "no fixture matched this URL" in replay mode. */
export const REPLAY_UNMATCHED_STATUS = 599;

/** Live HTTP: global fetch, 30s timeout, one retry. */
export class LiveGate implements HttpGate {
  readonly kind = "live" as const;

  constructor(private readonly timeoutMs = 30_000) {}

  async get(url: string): Promise<GateResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "follow",
          headers: { "user-agent": "pact-tailor-intelligence/0.1 (connector ingest)" },
        });
        const body = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type");
        return {
          status: res.status,
          body,
          ...(contentType ? { content_type: contentType } : {}),
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`LiveGate: GET ${url} failed after retry — ${(lastError as Error)?.message ?? String(lastError)}`);
  }
}

/**
 * One committed exchange: fixtures/{connector_id}/exchanges/{NN}-{slug}.json.
 * `url_pattern` is an exact URL or a URL prefix.
 */
export interface ReplayExchange {
  url_pattern: string;
  status: number;
  content_type?: string;
  body_base64: string;
}

/** Serves committed synthetic exchanges. Exact URL match first, then longest prefix. */
export class ReplayGate implements HttpGate {
  readonly kind = "replay" as const;
  private readonly exchanges: ReplayExchange[] = [];

  constructor(fixturesDir: string) {
    const dir = join(fixturesDir, "exchanges");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      this.exchanges.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ReplayExchange);
    }
  }

  async get(url: string): Promise<GateResponse> {
    const exact = this.exchanges.find((e) => e.url_pattern === url);
    const match =
      exact ??
      this.exchanges
        .filter((e) => url.startsWith(e.url_pattern))
        .sort((a, b) => b.url_pattern.length - a.url_pattern.length)[0];
    if (!match) return { status: REPLAY_UNMATCHED_STATUS, body: Buffer.alloc(0) };
    return {
      status: match.status,
      body: Buffer.from(match.body_base64, "base64"),
      ...(match.content_type ? { content_type: match.content_type } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// MessageGate — the same seam for streaming (websocket) sources.
// ---------------------------------------------------------------------------

export interface MessageCollectOptions {
  /** Stop after this many messages (live default 500). */
  maxMessages?: number;
  /** Stop after this long (live default 30s). Replay delivers with zero delay. */
  windowMs?: number;
}

export interface MessageGate {
  kind: "replay" | "live";
  /**
   * Open the stream, send the subscription payload, and collect raw messages
   * until the stream ends (replay: fixture exhausted) or a limit is hit.
   */
  collect(url: string, subscribe: unknown, opts?: MessageCollectOptions): Promise<Buffer[]>;
}

/**
 * Replays a committed JSONL fixture (fixtures/{connector_id}/messages.jsonl,
 * one message per line) with zero delay. The subscription payload is accepted
 * and ignored — fixtures already reflect the subscribed filter.
 */
export class ReplayMessageGate implements MessageGate {
  readonly kind = "replay" as const;

  constructor(private readonly jsonlPath: string) {}

  async collect(_url: string, _subscribe: unknown, opts: MessageCollectOptions = {}): Promise<Buffer[]> {
    if (!existsSync(this.jsonlPath)) return [];
    const lines = readFileSync(this.jsonlPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const max = opts.maxMessages ?? lines.length;
    return lines.slice(0, max).map((line) => Buffer.from(line, "utf8"));
  }
}

/** Live websocket collection via `ws` (loaded lazily so replay never needs it). */
export class LiveMessageGate implements MessageGate {
  readonly kind = "live" as const;

  async collect(url: string, subscribe: unknown, opts: MessageCollectOptions = {}): Promise<Buffer[]> {
    const { WebSocket } = await import("ws");
    const maxMessages = opts.maxMessages ?? 500;
    const windowMs = opts.windowMs ?? 30_000;
    return new Promise<Buffer[]>((resolve, reject) => {
      const messages: Buffer[] = [];
      const socket = new WebSocket(url);
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // already closed
        }
        if (err && messages.length === 0) reject(err);
        else resolve(messages);
      };
      const timer = setTimeout(() => finish(), windowMs);
      socket.on("open", () => {
        socket.send(JSON.stringify(subscribe));
      });
      socket.on("message", (data) => {
        messages.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        if (messages.length >= maxMessages) finish();
      });
      socket.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
      socket.on("close", () => finish());
    });
  }
}
