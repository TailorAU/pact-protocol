import { getBaseUrl, getAuthHeader } from './config.js';

async function request<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const baseUrl = getBaseUrl();
  const auth = getAuthHeader();

  const headers: Record<string, string> = {};
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers as Record<string, string>)) {
      headers[k] = v;
    }
  }
  if (!headers['Content-Type'] && options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  if (auth) headers[auth.key] = auth.value;

  const url = `${baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out — ${options.method ?? 'GET'} ${path}`);
    }
    throw new Error(
      err instanceof TypeError
        ? `Could not connect to ${baseUrl} — is the server running?`
        : String(err),
    );
  }

  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try {
      const json = JSON.parse(body);
      if (json.title) message = json.title;
      if (json.detail) message += ` — ${json.detail}`;
    } catch {
      if (message.length > 300) message = message.slice(0, 300) + '...';
    }
    if (res.status === 401) message = 'Unauthorized — check your API key or token.';
    if (res.status === 403) message = 'Forbidden — credentials lack the required scope.';
    throw new Error(`HTTP ${res.status}: ${message}`);
  }

  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

// ── Agent Lifecycle ──────────────────────────────────────────────

export async function join(
  docId: string,
  agentName: string,
  role?: string,
): Promise<{ registrationId: string; documentId: string; agentName: string; role: string }> {
  const body: Record<string, unknown> = { agentName };
  if (role) body.role = role;
  return request(`/api/pact/${docId}/join`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function joinWithToken(
  docId: string,
  agentName: string,
  token: string,
): Promise<{ registrationId: string; documentId: string; agentName: string; role?: string; apiKey?: string }> {
  return request(`/api/pact/${docId}/join-token`, {
    method: 'POST',
    body: JSON.stringify({ agentName, token }),
  });
}

export async function leave(docId: string): Promise<void> {
  await request(`/api/pact/${docId}/leave`, { method: 'DELETE' });
}

export async function listAgents(docId: string): Promise<unknown[]> {
  return request(`/api/pact/${docId}/agents`);
}

// ── Intent-Constraint-Salience ───────────────────────────────────

export async function declareIntent(
  docId: string,
  sectionId: string,
  goal: string,
  category?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { sectionId, goal };
  if (category) body.category = category;
  return request(`/api/pact/${docId}/intents`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listIntents(
  docId: string,
  sectionId?: string,
): Promise<unknown[]> {
  const qs = sectionId ? `?sectionId=${sectionId}` : '';
  return request(`/api/pact/${docId}/intents${qs}`);
}

export async function publishConstraint(
  docId: string,
  sectionId: string,
  boundary: string,
  category?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { sectionId, boundary };
  if (category) body.category = category;
  return request(`/api/pact/${docId}/constraints`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listConstraints(
  docId: string,
  sectionId?: string,
): Promise<unknown[]> {
  const qs = sectionId ? `?sectionId=${sectionId}` : '';
  return request(`/api/pact/${docId}/constraints${qs}`);
}

export async function setSalience(
  docId: string,
  sectionId: string,
  score: number,
): Promise<void> {
  await request(`/api/pact/${docId}/salience`, {
    method: 'POST',
    body: JSON.stringify({ sectionId, score }),
  });
}

export async function getSalienceMap(docId: string): Promise<unknown> {
  return request(`/api/pact/${docId}/salience`);
}

// ── Objection (silence = acceptance; only speak up to block) ─────

export async function objectToProposal(
  docId: string,
  proposalId: string,
  reason: string,
): Promise<void> {
  await request(`/api/pact/${docId}/proposals/${proposalId}/object`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// ── Polling & Events ─────────────────────────────────────────────

export async function poll(
  docId: string,
  since?: string,
  sectionId?: string,
  limit?: number,
): Promise<{ since: string | null; changes: unknown[]; cursor: string }> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (sectionId) params.set('sectionId', sectionId);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params}` : '';
  return request(`/api/pact/${docId}/poll${qs}`);
}

export async function getEvents(
  docId: string,
  since?: string,
  limit?: number,
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (since) params.set('since', since);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params}` : '';
  return request(`/api/pact/${docId}/events${qs}`);
}

// ── Completion ───────────────────────────────────────────────────

export async function signalDone(
  docId: string,
  status: string,
  summary?: string,
): Promise<unknown> {
  return request(`/api/pact/${docId}/done`, {
    method: 'POST',
    body: JSON.stringify({ status, summary }),
  });
}

export async function listCompletions(docId: string): Promise<unknown[]> {
  return request(`/api/pact/${docId}/completions`);
}

// ── Locking ──────────────────────────────────────────────────────

export async function lockSection(
  docId: string,
  sectionId: string,
  ttl?: number,
): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (ttl) body.ttlSeconds = ttl;
  return request(`/api/pact/${docId}/sections/${sectionId}/lock`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function unlockSection(
  docId: string,
  sectionId: string,
): Promise<void> {
  await request(`/api/pact/${docId}/sections/${sectionId}/lock`, { method: 'DELETE' });
}

// ── Escalation ───────────────────────────────────────────────────

export async function escalate(
  docId: string,
  message: string,
  sectionId?: string,
): Promise<void> {
  const body: Record<string, unknown> = { message };
  if (sectionId) body.sectionId = sectionId;
  await request(`/api/pact/${docId}/escalate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function askHuman(
  docId: string,
  question: string,
  sectionId?: string,
  context?: string,
  timeoutSeconds?: number,
): Promise<unknown> {
  return request(`/api/pact/${docId}/ask-human`, {
    method: 'POST',
    body: JSON.stringify({
      question,
      sectionId: sectionId ?? null,
      context: context ?? null,
      timeoutSeconds: timeoutSeconds ?? 60,
    }),
  });
}
