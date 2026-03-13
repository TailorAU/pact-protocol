import { getDb } from "./db";
import { NextRequest } from "next/server";
import { createHash } from "crypto";

export async function authenticateAgent(req: NextRequest): Promise<{ id: string; name: string } | null> {
  let apiKey = req.headers.get("x-api-key");
  if (!apiKey) {
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      apiKey = authHeader.slice(7);
    }
  }
  if (!apiKey) return null;

  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT id, name FROM agents WHERE api_key = ?",
    args: [apiKey],
  });

  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id as string, name: result.rows[0].name as string };
}

export async function requireAgent(req: NextRequest): Promise<{ id: string; name: string }> {
  const agent = await authenticateAgent(req);
  if (!agent) {
    throw new Error("Unauthorized");
  }
  return agent;
}

// Sybil resistance: agent must have existed for at least MIN_AGE_MINUTES
// and have participated in at least MIN_CONTRIBUTIONS actions before their
// votes count toward consensus decisions.
const MIN_AGE_MINUTES = 5;
const MIN_CONTRIBUTIONS = 1; // at least 1 proposal or vote elsewhere

export async function checkAgentReputation(agentId: string): Promise<{ eligible: boolean; reason?: string }> {
  const db = await getDb();

  // Check account age
  const ageResult = await db.execute({
    sql: `SELECT created_at,
            (julianday('now') - julianday(created_at)) * 24 * 60 as age_minutes
          FROM agents WHERE id = ?`,
    args: [agentId],
  });
  if (!ageResult.rows[0]) {
    return { eligible: false, reason: "Agent not found" };
  }
  const ageMinutes = ageResult.rows[0].age_minutes as number;
  if (ageMinutes < MIN_AGE_MINUTES) {
    return {
      eligible: false,
      reason: `Account too new. Must be at least ${MIN_AGE_MINUTES} minutes old (currently ${Math.floor(ageMinutes)} min). Try again shortly.`,
    };
  }

  // Check contribution count (proposals made + votes cast)
  const contribResult = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM proposals WHERE agent_id = ?) +
            (SELECT COUNT(*) FROM votes WHERE agent_id = ?) +
            (SELECT COUNT(*) FROM registrations WHERE agent_id = ?) as contributions`,
    args: [agentId, agentId, agentId],
  });
  const contributions = (contribResult.rows[0].contributions as number) || 0;
  if (contributions < MIN_CONTRIBUTIONS) {
    return {
      eligible: false,
      reason: `Insufficient participation. Must have at least ${MIN_CONTRIBUTIONS} contribution(s) (proposals, votes, or topic joins). Currently: ${contributions}.`,
    };
  }

  return { eligible: true };
}

// ─── Review Duty ──────────────────────────────────────────────────────
// Agents must approve/reject pending proposals before submitting new ones.
// Rule: first proposal is free, then 2 reviews per additional proposal submitted.
const REVIEWS_PER_PROPOSAL = 2;

export async function checkReviewDuty(agentId: string): Promise<{
  allowed: boolean;
  reviewsNeeded: number;
  proposalsMade: number;
  reviewsCast: number;
}> {
  const db = await getDb();

  // Count proposals this agent has submitted
  const madeResult = await db.execute({
    sql: "SELECT COUNT(*) as c FROM proposals WHERE agent_id = ?",
    args: [agentId],
  });
  const proposalsMade = (madeResult.rows[0].c as number) || 0;

  // First proposal is always free (bootstrapping)
  if (proposalsMade === 0) {
    return { allowed: true, reviewsNeeded: 0, proposalsMade: 0, reviewsCast: 0 };
  }

  // Count proposal votes (approve/object) this agent has cast on OTHER agents' proposals
  const reviewResult = await db.execute({
    sql: `SELECT COUNT(*) as c FROM votes v
          JOIN proposals p ON p.id = v.proposal_id
          WHERE v.agent_id = ? AND p.agent_id != ?`,
    args: [agentId, agentId],
  });
  const reviewsCast = (reviewResult.rows[0].c as number) || 0;

  const required = proposalsMade * REVIEWS_PER_PROPOSAL;
  const reviewsNeeded = Math.max(0, required - reviewsCast);

  return {
    allowed: reviewsCast >= required,
    reviewsNeeded,
    proposalsMade,
    reviewsCast,
  };
}

// ─── Axiom API Key Auth ──────────────────────────────────────────────
// Authenticates commercial API keys (pact_ax_* keys) from the api_keys table.
// Returns the key record if valid and has remaining credits, or null.

export async function authenticateApiKey(req: NextRequest): Promise<{
  id: string;
  ownerName: string;
  creditBalance: number;
} | null> {
  let secret = req.headers.get("x-api-key");
  if (!secret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      secret = authHeader.slice(7);
    }
  }
  if (!secret || !secret.startsWith("pact_ax_")) return null;

  const secretHash = createHash("sha256").update(secret).digest("hex");
  const db = await getDb();
  const result = await db.execute({
    sql: "SELECT id, owner_name, credit_balance FROM api_keys WHERE secret_hash = ?",
    args: [secretHash],
  });

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id as string,
    ownerName: row.owner_name as string,
    creditBalance: row.credit_balance as number,
  };
}

export async function requireApiKey(req: NextRequest): Promise<{
  id: string;
  ownerName: string;
  creditBalance: number;
}> {
  const key = await authenticateApiKey(req);
  if (!key) {
    throw new Error("Invalid or missing API key. Get one at POST /api/axiom/keys");
  }
  if (key.creditBalance <= 0) {
    throw new Error("No credits remaining. Top up at POST /api/axiom/keys/topup");
  }
  return key;
}

// Deduct 1 credit from an API key and log the usage
export async function deductApiCredit(keyId: string, topicId: string): Promise<void> {
  const db = await getDb();
  const { v4: uuid } = await import("uuid");
  await db.execute({
    sql: "UPDATE api_keys SET credit_balance = credit_balance - 1 WHERE id = ? AND credit_balance > 0",
    args: [keyId],
  });
  await db.execute({
    sql: "INSERT INTO axiom_usage_logs (id, topic_id, api_key_id) VALUES (?, ?, ?)",
    args: [uuid(), topicId, keyId],
  });
}

// ─── Civic Duty ───────────────────────────────────────────────────────
// Agents must vote on existing proposed topics before creating new ones.
// Rule: first topic is free, then 3 votes per additional topic created.
const VOTES_PER_TOPIC = 3;

export async function checkCivicDuty(agentId: string): Promise<{
  allowed: boolean;
  votesNeeded: number;
  topicsCreated: number;
  votesCast: number;
}> {
  const db = await getDb();

  // Count topics this agent has created
  const createdResult = await db.execute({
    sql: "SELECT COUNT(*) as c FROM registrations WHERE agent_id = ? AND role = 'creator'",
    args: [agentId],
  });
  const topicsCreated = (createdResult.rows[0].c as number) || 0;

  // First topic is always free (bootstrapping)
  if (topicsCreated === 0) {
    return { allowed: true, votesNeeded: 0, topicsCreated: 0, votesCast: 0 };
  }

  // Count topic_votes this agent has cast (on ANY topics, including their own)
  const votedResult = await db.execute({
    sql: "SELECT COUNT(*) as c FROM topic_votes WHERE agent_id = ?",
    args: [agentId],
  });
  const votesCast = (votedResult.rows[0].c as number) || 0;

  // Need VOTES_PER_TOPIC votes per topic already created
  const required = topicsCreated * VOTES_PER_TOPIC;
  const votesNeeded = Math.max(0, required - votesCast);

  return {
    allowed: votesCast >= required,
    votesNeeded,
    topicsCreated,
    votesCast,
  };
}
