// PactClient — minimal zero-dependency HTTP client for the PACT reference
// server (reference-server/src/server.ts), built on the global fetch.
//
// Covers exactly the surface the intelligence bridge needs: join a fabric,
// create a `fact`-type proposal, vote (approve/object), read fabric status,
// and reset the server's in-memory fixtures. Every member-scoped call
// asserts the caller via the `X-Pact-Principal` header.

/** Error thrown for transport failures and non-2xx responses. */
export class PactClientError extends Error {
  constructor(
    message: string,
    /** HTTP status code, when a response was received. */
    readonly status?: number,
    /** Parsed response body, when one was received. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PactClientError";
  }
}

/** Result of joining a fabric via POST /join-token. */
export interface JoinResult {
  /** `did:key:{registrationId}` — the member's principal_id on the fabric. */
  principalId: string;
  apiKey: string;
}

export interface ProposeInput {
  /** Caller-supplied deterministic id (idempotent on re-POST). Optional. */
  proposalId?: string;
  sectionId: string;
  summary: string;
  due_by?: string;
}

export interface ProposeResult {
  proposalId: string;
  status: string;
  created: boolean;
  proposer: string;
  required_voters: string[];
  [key: string]: unknown;
}

export interface VoteResult {
  proposalId: string;
  recorded: boolean;
  decision: string;
  [key: string]: unknown;
}

/** GET /_status snapshot (§4.4.1) — the fields the bridge relies on. */
export interface FabricStatus {
  fabric_id: string;
  phase: string;
  open_proposals: number;
  members: Array<Record<string, unknown>>;
  pending_obligations: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class PactClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: { timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST /api/pact/{fabricId}/join-token — anonymous BYOK join (§4.1/§7.1). */
  async join(fabricId: string, agentName: string): Promise<JoinResult> {
    const res = await this.request<{ registrationId: string; apiKey: string }>(
      "POST",
      `/api/pact/${encodeURIComponent(fabricId)}/join-token`,
      { body: { agentName } },
    );
    if (typeof res.registrationId !== "string" || res.registrationId.length === 0) {
      throw new PactClientError(
        `join(${fabricId}, ${agentName}): server response missing registrationId`,
        undefined,
        res,
      );
    }
    // The created member's principal_id is did:key:{registrationId}.
    return { principalId: `did:key:${res.registrationId}`, apiKey: res.apiKey };
  }

  /** POST /api/pact/{fabricId}/proposals — create an open proposal (§4.3/§7.1). */
  async propose(
    fabricId: string,
    principalId: string,
    input: ProposeInput,
  ): Promise<ProposeResult> {
    return this.request<ProposeResult>(
      "POST",
      `/api/pact/${encodeURIComponent(fabricId)}/proposals`,
      { principal: principalId, body: input },
    );
  }

  /**
   * POST /api/pact/{fabricId}/proposals/{id}/{verb} — vote on a proposal,
   * discharging the caller's §6.5 vote obligation. `approve` resolves the
   * proposal approved; `object` blocks it (rejected, §10.5).
   */
  async vote(
    fabricId: string,
    principalId: string,
    proposalId: string,
    verb: "approve" | "object",
  ): Promise<VoteResult> {
    return this.request<VoteResult>(
      "POST",
      `/api/pact/${encodeURIComponent(fabricId)}/proposals/${encodeURIComponent(proposalId)}/${verb}`,
      { principal: principalId, body: {} },
    );
  }

  /** GET /api/pact/{fabricId}/_status — whole-fabric snapshot (§4.4.1). */
  async status(fabricId: string): Promise<FabricStatus> {
    return this.request<FabricStatus>(
      "GET",
      `/api/pact/${encodeURIComponent(fabricId)}/_status`,
    );
  }

  /** POST /__reset — reference-server test helper: reseed in-memory fixtures. */
  async reset(): Promise<void> {
    await this.request<{ reset: boolean }>("POST", "/__reset");
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { principal?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (opts.principal !== undefined) headers["X-Pact-Principal"] = opts.principal;
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new PactClientError(
        `PactClient: ${method} ${url} failed (${cause}). Is the reference server running?`,
      );
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      throw new PactClientError(
        `PactClient: ${method} ${url} → HTTP ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }
}
