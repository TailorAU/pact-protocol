import { v4 as uuid } from "uuid";
import { type DbClient, emitEvent } from "./db";

// ─── Economy Engine ──────────────────────────────────────────────────
// Internal credit economy for PACT Hub.
// - Agent wallets hold credit balances
// - Bounty Market: sponsors attach credits to topics, distributed on consensus
// - Axiom Yield: commercial API revenue distributed to contributing agents
//
// All multi-write operations use db.batch() for atomicity.

/**
 * Ensure an agent has a wallet row. Safe to call multiple times.
 */
export async function ensureWallet(db: DbClient, agentId: string): Promise<void> {
  await db.execute({
    sql: "INSERT OR IGNORE INTO agent_wallets (agent_id, balance) VALUES (?, 0)",
    args: [agentId],
  });
}

/**
 * Transfer credits between wallets with ledger entry.
 * Used for single ad-hoc transfers (bounty posting, starter credits).
 * For batch operations (bounty distribution), collect statements and use db.batch().
 *
 * @param from - Source wallet agent_id, or null for system mint
 * @param to - Destination wallet agent_id
 */
export async function transfer(
  db: DbClient,
  opts: { from: string | null; to: string; amount: number; topicId?: string; reason: string }
): Promise<void> {
  const { from, to, amount, topicId, reason } = opts;
  if (amount <= 0) return;

  // Ensure destination wallet exists
  await ensureWallet(db, to);

  // Deduct from source (skip for system mints)
  if (from) {
    await ensureWallet(db, from);
    await db.execute({
      sql: "UPDATE agent_wallets SET balance = balance - ? WHERE agent_id = ?",
      args: [amount, from],
    });
  }

  // Credit destination
  await db.execute({
    sql: "UPDATE agent_wallets SET balance = balance + ? WHERE agent_id = ?",
    args: [amount, to],
  });

  // Immutable ledger entry
  await db.execute({
    sql: "INSERT INTO ledger_txs (id, from_wallet, to_wallet, amount, topic_id, reason) VALUES (?, ?, ?, ?, ?, ?)",
    args: [uuid(), from ?? "hub-protocol", to, amount, topicId ?? null, reason],
  });
}

// ─── Bounty Distribution ─────────────────────────────────────────────
// Split: 40% Proposer, 40% Voters (harmonic decay), 20% Assumption Subsidy
//
// ALL WRITES ARE BATCHED ATOMICALLY via db.batch() to prevent double-spend.

/**
 * Distribute escrowed bounties for a topic that just reached consensus.
 * Called from updateConsensusStatuses() in db.ts.
 */
export async function distributeBounty(
  db: DbClient,
  topicId: string
): Promise<{ distributed: boolean; total: number }> {

  // ── Phase 1: READ ──────────────────────────────────────────────────

  // 1. Sum all escrowed bounties for this topic
  const bountyResult = await db.execute({
    sql: "SELECT SUM(amount) as total FROM topic_bounties WHERE topic_id = ? AND status = 'escrow'",
    args: [topicId],
  });
  const total = (bountyResult.rows[0]?.total as number) || 0;
  if (total === 0) return { distributed: false, total: 0 };

  // 2. Find the proposer — agent whose merged proposal targets the Answer section
  const proposerResult = await db.execute({
    sql: `SELECT p.agent_id FROM proposals p
      JOIN sections s ON s.id = p.section_id AND s.topic_id = p.topic_id
      WHERE p.topic_id = ? AND p.status = 'merged' AND s.heading = 'Answer'
      ORDER BY p.resolved_at DESC LIMIT 1`,
    args: [topicId],
  });
  const proposerId = proposerResult.rows[0]?.agent_id as string | undefined;

  // 3. Find all aligned voters, sorted by done_at ASC (early voters first)
  const votersResult = await db.execute({
    sql: `SELECT agent_id FROM registrations
      WHERE topic_id = ? AND done_status = 'aligned'
      ORDER BY done_at ASC`,
    args: [topicId],
  });
  const voters = votersResult.rows.map(r => r.agent_id as string);

  // 4. Find assumption dependencies (for the 20% subsidy)
  const depsResult = await db.execute({
    sql: "SELECT depends_on FROM topic_dependencies WHERE topic_id = ? AND relationship = 'assumes'",
    args: [topicId],
  });
  const depTopicIds = depsResult.rows.map(r => r.depends_on as string);

  // ── Phase 2: CALCULATE ─────────────────────────────────────────────

  // Dynamic split percentages
  const assumptionPct = depTopicIds.length > 0 ? 0.20 : 0;
  const proposerPct = proposerId ? 0.40 : 0;
  const voterPct = 1.0 - assumptionPct - proposerPct;

  const proposerCut = Math.floor(total * proposerPct);
  const assumptionCut = Math.floor(total * assumptionPct);
  const voterPool = total - proposerCut - assumptionCut; // Remainder goes to voters (absorbs dust)

  // Harmonic decay for voters: weight[k] = 1/(k+1)
  // First voter gets the most, last voter gets the least
  let voterPayouts: { agentId: string; amount: number }[] = [];
  if (voters.length > 0 && voterPool > 0) {
    const weights = voters.map((_, k) => 1 / (k + 1));
    const weightSum = weights.reduce((a, b) => a + b, 0);

    let distributed = 0;
    voterPayouts = voters.map((agentId, k) => {
      const normalized = weights[k] / weightSum;
      const payout = Math.floor(voterPool * normalized);
      distributed += payout;
      return { agentId, amount: payout };
    });

    // Dust (rounding remainder) goes to first voter
    const dust = voterPool - distributed;
    if (dust > 0 && voterPayouts.length > 0) {
      voterPayouts[0].amount += dust;
    }
  }

  // Assumption subsidy — depth-weighted across dependency topics
  // Foundational axioms with more downstream dependents get a larger share
  let assumptionPayouts: { topicId: string; amount: number }[] = [];
  if (depTopicIds.length > 0 && assumptionCut > 0) {
    // Query downstream dependent count for each dependency
    const depWeights: { topicId: string; weight: number }[] = [];
    for (const depId of depTopicIds) {
      const depCountResult = await db.execute({
        sql: "SELECT COUNT(*) as cnt FROM topic_dependencies WHERE depends_on = ?",
        args: [depId],
      });
      const dependentCount = (depCountResult.rows[0]?.cnt as number) || 0;
      depWeights.push({ topicId: depId, weight: 1 + dependentCount });
    }
    const totalWeight = depWeights.reduce((sum, d) => sum + d.weight, 0);

    let distributed = 0;
    assumptionPayouts = depWeights.map(d => {
      const payout = Math.floor(assumptionCut * (d.weight / totalWeight));
      distributed += payout;
      return { topicId: d.topicId, amount: payout };
    });
    // Dust to highest-weight dependency
    const dust = assumptionCut - distributed;
    if (dust > 0 && assumptionPayouts.length > 0) {
      assumptionPayouts.sort((a, b) => b.amount - a.amount);
      assumptionPayouts[0].amount += dust;
    }
  }

  // ── Phase 3: WRITE (atomic batch) ──────────────────────────────────

  const stmts: { sql: string; args: unknown[] }[] = [];

  // Ensure wallets exist for all recipients
  const allRecipients = new Set<string>();
  if (proposerId) allRecipients.add(proposerId);
  voters.forEach(v => allRecipients.add(v));

  for (const agentId of allRecipients) {
    stmts.push({
      sql: "INSERT OR IGNORE INTO agent_wallets (agent_id, balance) VALUES (?, 0)",
      args: [agentId],
    });
  }

  // Proposer cut
  if (proposerId && proposerCut > 0) {
    stmts.push({
      sql: "UPDATE agent_wallets SET balance = balance + ? WHERE agent_id = ?",
      args: [proposerCut, proposerId],
    });
    stmts.push({
      sql: "INSERT INTO ledger_txs (id, from_wallet, to_wallet, amount, topic_id, reason) VALUES (?, ?, ?, ?, ?, ?)",
      args: [uuid(), "escrow", proposerId, proposerCut, topicId, "bounty-proposer-cut"],
    });
  }

  // Voter cuts
  for (const { agentId, amount } of voterPayouts) {
    if (amount > 0) {
      stmts.push({
        sql: "UPDATE agent_wallets SET balance = balance + ? WHERE agent_id = ?",
        args: [amount, agentId],
      });
      stmts.push({
        sql: "INSERT INTO ledger_txs (id, from_wallet, to_wallet, amount, topic_id, reason) VALUES (?, ?, ?, ?, ?, ?)",
        args: [uuid(), "escrow", agentId, amount, topicId, "bounty-voter-cut"],
      });
    }
  }

  // Assumption subsidy — create new escrow bounties for dependency topics
  for (const { topicId: depId, amount } of assumptionPayouts) {
    if (amount > 0) {
      stmts.push({
        sql: "INSERT INTO topic_bounties (id, topic_id, sponsor_id, amount, status) VALUES (?, ?, 'hub-protocol', ?, 'escrow')",
        args: [uuid(), depId, amount],
      });
      stmts.push({
        sql: "INSERT INTO ledger_txs (id, from_wallet, to_wallet, amount, topic_id, reason) VALUES (?, ?, ?, ?, ?, ?)",
        args: [uuid(), "escrow", "escrow", amount, depId, "bounty-assumption-subsidy"],
      });
    }
  }

  // Mark all original bounties as paid
  stmts.push({
    sql: "UPDATE topic_bounties SET status = 'paid' WHERE topic_id = ? AND status = 'escrow'",
    args: [topicId],
  });

  // Execute all writes atomically
  await db.batch(stmts);

  // Emit event (outside batch — non-critical)
  await emitEvent(db, topicId, "pact.bounty.distributed", "", "", {
    total,
    proposerCut,
    voterPool,
    assumptionCut,
    voterCount: voters.length,
    dependencyCount: depTopicIds.length,
  });

  return { distributed: true, total };
}
