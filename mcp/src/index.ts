import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request } from './api.js';

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const };
}

const server = new McpServer({
  name: 'PACT Protocol',
  version: '0.2.0',
});

// ── Agent Lifecycle ──────────────────────────────────────────────

server.tool(
  'pact_join',
  'Join a document as a PACT agent. Required before any other operations.',
  {
    documentId: z.string().describe('Document ID'),
    agentName: z.string().describe('Agent display name'),
    role: z.string().optional().describe('Role: editor, reviewer, observer'),
    token: z.string().optional().describe('Invite token for BYOK join (no account needed)'),
  },
  async ({ documentId, agentName, role, token }) => {
    try {
      if (token) {
        const result = await request(`/api/pact/${documentId}/join-token`, {
          method: 'POST',
          body: JSON.stringify({ agentName, token }),
        });
        return jsonResult(result);
      }
      const body: Record<string, unknown> = { agentName };
      if (role) body.role = role;
      const result = await request(`/api/pact/${documentId}/join`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return jsonResult(result);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'pact_leave',
  'Leave a document, unregistering as a PACT agent.',
  { documentId: z.string().describe('Document ID') },
  async ({ documentId }) => {
    try {
      await request(`/api/pact/${documentId}/leave`, { method: 'DELETE' });
      return jsonResult({ success: true });
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'pact_agents',
  'List all agents registered on a document.',
  { documentId: z.string().describe('Document ID') },
  async ({ documentId }) => {
    try {
      const result = await request(`/api/pact/${documentId}/agents`);
      return jsonResult(result);
    } catch (err) { return errorResult(err); }
  },
);

// ── Intent-Constraint-Salience ───────────────────────────────────

server.tool(
  'pact_intent',
  'Declare intent for a section — what you plan to do.',
  {
    documentId: z.string().describe('Document ID'),
    sectionId: z.string().describe('Target section ID'),
    goal: z.string().describe('What you plan to do'),
    category: z.string().optional().describe('Intent category'),
  },
  async ({ documentId, sectionId, goal, category }) => {
    try {
      const body: Record<string, unknown> = { sectionId, goal };
      if (category) body.category = category;
      const result = await request(`/api/pact/${documentId}/intents`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return jsonResult(result);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'pact_constrain',
  'Publish a constraint on a section — what must or must not happen.',
  {
    documentId: z.string().describe('Document ID'),
    sectionId: z.string().describe('Target section ID'),
    boundary: z.string().describe('What must or must not happen'),
    category: z.string().optional().describe('Constraint category'),
  },
  async ({ documentId, sectionId, boundary, category }) => {
    try {
      const body: Record<string, unknown> = { sectionId, boundary };
      if (category) body.category = category;
      const result = await request(`/api/pact/${documentId}/constraints`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return jsonResult(result);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'pact_salience',
  'Set salience score for a section (0-10: how much you care).',
  {
    documentId: z.string().describe('Document ID'),
    sectionId: z.string().describe('Target section ID'),
    score: z.number().min(0).max(10).describe('Salience score (0-10)'),
  },
  async ({ documentId, sectionId, score }) => {
    try {
      await request(`/api/pact/${documentId}/salience`, {
        method: 'POST',
        body: JSON.stringify({ sectionId, score }),
      });
      return jsonResult({ section: sectionId, score });
    } catch (err) { return errorResult(err); }
  },
);

// ── Objection (silence = acceptance; only speak up to block) ─────

server.tool(
  'pact_object',
  'Object to a proposal — blocks auto-merge, forces renegotiation. Silence = acceptance; only call this when a proposal violates your constraints.',
  {
    documentId: z.string().describe('Document ID'),
    proposalId: z.string().describe('Proposal ID'),
    reason: z.string().describe('Why this violates your constraints'),
  },
  async ({ documentId, proposalId, reason }) => {
    try {
      await request(`/api/pact/${documentId}/proposals/${proposalId}/object`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      return jsonResult({ status: 'objected', proposalId });
    } catch (err) { return errorResult(err); }
  },
);

// ── Polling & Events ─────────────────────────────────────────────

server.tool(
  'pact_poll',
  'Poll for new events since a cursor (stateless). Returns proposals, objections, escalations, and completions.',
  {
    documentId: z.string().describe('Document ID'),
    since: z.string().optional().describe('Cursor to poll from'),
    sectionId: z.string().optional().describe('Filter by section'),
    limit: z.number().optional().describe('Max events to return'),
  },
  async ({ documentId, since, sectionId, limit }) => {
    try {
      const params = new URLSearchParams();
      if (since) params.set('since', since);
      if (sectionId) params.set('sectionId', sectionId);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString() ? `?${params}` : '';
      const result = await request(`/api/pact/${documentId}/poll${qs}`);
      return jsonResult(result);
    } catch (err) { return errorResult(err); }
  },
);

// ── Completion ───────────────────────────────────────────────────

server.tool(
  'pact_done',
  'Signal that this agent has completed its work.',
  {
    documentId: z.string().describe('Document ID'),
    status: z.string().describe('Completion status: aligned, blocked, or withdrawn'),
    summary: z.string().optional().describe('Summary of what was accomplished'),
  },
  async ({ documentId, status, summary }) => {
    try {
      const result = await request(`/api/pact/${documentId}/done`, {
        method: 'POST',
        body: JSON.stringify({ status, summary }),
      });
      return jsonResult(result);
    } catch (err) { return errorResult(err); }
  },
);

// ── Locking ──────────────────────────────────────────────────────

server.tool(
  'pact_lock',
  'Lock a section for exclusive coordination.',
  {
    documentId: z.string().describe('Document ID'),
    sectionId: z.string().describe('Section ID to lock'),
    ttlSeconds: z.number().optional().describe('Lock TTL in seconds'),
  },
  async ({ documentId, sectionId, ttlSeconds }) => {
    try {
      const body: Record<string, unknown> = {};
      if (ttlSeconds) body.ttlSeconds = ttlSeconds;
      const result = await request(`/api/pact/${documentId}/sections/${sectionId}/lock`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return jsonResult(result);
    } catch (err) { return errorResult(err); }
  },
);

server.tool(
  'pact_unlock',
  'Unlock a section.',
  {
    documentId: z.string().describe('Document ID'),
    sectionId: z.string().describe('Section ID to unlock'),
  },
  async ({ documentId, sectionId }) => {
    try {
      await request(`/api/pact/${documentId}/sections/${sectionId}/lock`, { method: 'DELETE' });
      return jsonResult({ status: 'unlocked', sectionId });
    } catch (err) { return errorResult(err); }
  },
);

// ── Escalation ───────────────────────────────────────────────────

server.tool(
  'pact_escalate',
  'Escalate an issue to human reviewers. Use when agents cannot reach consensus.',
  {
    documentId: z.string().describe('Document ID'),
    message: z.string().describe('Reason for escalation'),
    sectionId: z.string().optional().describe('Relevant section ID'),
  },
  async ({ documentId, message, sectionId }) => {
    try {
      const body: Record<string, unknown> = { message };
      if (sectionId) body.sectionId = sectionId;
      await request(`/api/pact/${documentId}/escalate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return jsonResult({ status: 'escalated', documentId });
    } catch (err) { return errorResult(err); }
  },
);

// ── Start ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('PACT MCP server failed to start:', err);
  process.exit(1);
});
