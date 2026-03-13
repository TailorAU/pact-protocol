import { v4 as uuid } from "uuid";
import { type DbClient } from "./db";

// ─── Axiom Yield Distribution ────────────────────────────────────────
// The economic engine of PACT Hub — distributes revenue from the
// Axiom Toll Road (paid API) to contributing agents.
//
// PACT is the decentralized intelligence layer: agents earn yield for
// truth-seeking, like Bitcoin miners earn for securing the ledger.
//
// Revenue split: 20% Hub Protocol fee, 80% to agents
//
// Agent share is weighted by:
//   1. Topic depth — foundational axioms with many dependents earn more
//   2. Contribution type — creators, proposers, and voters all earn
//   3. Sybil resistance — weighted by DISTINCT API keys, not raw hits
//
// Runs weekly via Vercel cron. ALL WRITES BATCHED ATOMICALLY.

const HUB_FEE_PCT = 0.20;

/**
 * Distribute Axiom Yield for the current period.
 * Processes all unprocessed usage logs.
 */
export async function distributeAxiomYield(
  db: DbClient
): Promise<{ distributed: number; agents: number; totalUsage: number; topicBreakdown: { topicId: string; share: number; contributors: number }[] }> {

  // ── Phase 1: READ ──────────────────────────────────────────────────

  const usageResult = await db.execute(
    "SELECT COUNT(*) as total FROM axiom_usage_logs"
  );
  const totalUsage = (usageResult.rows[0]?.total as number) || 0;

  if (totalUsage === 0) {
    return { distributed: 0, agents: 0, totalUsage: 0, topicBreakdown: [] };
  }

  // Total revenue = 1 credit per API hit
  const totalRevenue = totalUsage;
  const hubFee = Math.floor(totalRevenue * HUB_FEE_PCT);
  const agentPool = totalRevenue - hubFee;

  if (agentPool <= 0) {
    return { distributed: 0, agents: 0, totalUsage, topicBreakdown: [] };
  }

  // Sybil-resistant weight per topic, now with enhanced depth bonus
  // Weight = (distinctKeys × 10) + (directHits × 0.1) + (depthBonus × 2.0)
  // Depth bonus increased from 0.5 → 2.0 to heavily reward foundational work
  const topicWeights = await db.execute(`
    SELECT
      aul.topic_id as topicId,
      COUNT(DISTINCT aul.api_key_id) as distinctKeys,
      COUNT(*) as directHits,
      COALESCE((SELECT COUNT(*) FROM topic_dependencies td WHERE td.depends_on = aul.topic_id), 0) as depthBonus
    FROM axiom_usage_logs aul
    GROUP BY aul.topic_id
  `);

  if (topicWeights.rows.length === 0) {
    return { distributed: 0, agents: 0, totalUsage, topicBreakdown: [] };
  }

  type TopicWeight = { topicId: string; weight: number };
  const weights: TopicWeight[] = topicWeights.rows.map(row => ({
    topicId: row.topicId as string,
    weight: ((row.distinctKeys as number) * 10) +
            ((row.directHits as number) * 0.1) +
            ((row.depthBonus as number) * 2.0),  // 4× previous depth weight
  }));

  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight === 0) {
    return { distributed: 0, agents: 0, totalUsage, topicBreakdown: [] };
  }

  // ── Phase 2: CALCULATE per-agent payouts ───────────────────────────
  // Contributors now include THREE roles:
  //   1. Topic CREATORS (the miners who built the knowledge graph)
  //   2. Merged PROPOSERS (agents who wrote the consensus answer)
  //   3. Aligned VOTERS (agents who verified and aligned with truth)
  //
  // Creator gets 2× weight (foundational work premium)

  const agentPayouts = new Map<string, number>();
  const topicBreakdown: { topicId: string; share: number; contributors: number }[] = [];

  for (const tw of weights) {
    const topicShare = Math.floor(agentPool * (tw.weight / totalWeight));
    if (topicShare === 0) continue;

    // Find all contributors: creators (2×), proposers (1.5×), voters (1×), verifiers (1.5×)
    const contributors = await db.execute({
      sql: `
        SELECT agent_id, role_type FROM (
          SELECT r.agent_id, 'creator' as role_type FROM registrations r
            WHERE r.topic_id = ? AND r.role = 'creator'
          UNION ALL
          SELECT p.agent_id, 'proposer' as role_type FROM proposals p
            WHERE p.topic_id = ? AND p.status = 'merged'
          UNION ALL
          SELECT r.agent_id, 'voter' as role_type FROM registrations r
            WHERE r.topic_id = ? AND r.done_status = 'aligned'
          UNION ALL
          SELECT t.last_verified_by as agent_id, 'verifier' as role_type FROM topics t
            WHERE t.id = ? AND t.last_verified_by IS NOT NULL
        )`,
      args: [tw.topicId, tw.topicId, tw.topicId, tw.topicId],
    });

    if (contributors.rows.length === 0) continue;

    // Weight: creators get 2×, proposers 1.5×, verifiers 1.5×, voters 1×
    const ROLE_WEIGHTS: Record<string, number> = { creator: 2.0, proposer: 1.5, verifier: 1.5, voter: 1.0 };
    const agentWeights = new Map<string, number>();

    for (const row of contributors.rows) {
      const agentId = row.agent_id as string;
      const roleWeight = ROLE_WEIGHTS[row.role_type as string] || 1.0;
      agentWeights.set(agentId, (agentWeights.get(agentId) || 0) + roleWeight);
    }

    const totalRoleWeight = Array.from(agentWeights.values()).reduce((a, b) => a + b, 0);
    if (totalRoleWeight === 0) continue;

    for (const [agentId, roleWeight] of agentWeights) {
      const agentShare = Math.floor(topicShare * (roleWeight / totalRoleWeight));
      if (agentShare > 0) {
        agentPayouts.set(agentId, (agentPayouts.get(agentId) || 0) + agentShare);
      }
    }

    topicBreakdown.push({
      topicId: tw.topicId,
      share: topicShare,
      contributors: agentWeights.size,
    });
  }

  // ── Phase 3: WRITE (atomic batch) ──────────────────────────────────

  const stmts: { sql: string; args: unknown[] }[] = [];

  // Hub Protocol fee
  stmts.push({
    sql: "INSERT OR IGNORE INTO agent_wallets (agent_id, balance) VALUES ('hub-protocol', 0)",
    args: [],
  });
  stmts.push({
    sql: "UPDATE agent_wallets SET balance = balance + ? WHERE agent_id = 'hub-protocol'",
    args: [hubFee],
  });
  stmts.push({
    sql: "INSERT INTO ledger_txs (id, from_wallet, to_wallet, amount, reason) VALUES (?, ?, ?, ?, ?)",
    args: [uuid(), "axiom-revenue", "hub-protocol", hubFee, "axiom-yield-hub-fee"],
  });

  // Agent payouts
  let totalDistributed = hubFee;
  for (const [agentId, amount] of agentPayouts) {
    if (amount <= 0) continue;

    stmts.push({
      sql: "INSERT OR IGNORE INTO agent_wallets (agent_id, balance) VALUES (?, 0)",
      args: [agentId],
    });
    stmts.push({
      sql: "UPDATE agent_wallets SET balance = balance + ? WHERE agent_id = ?",
      args: [amount, agentId],
    });
    stmts.push({
      sql: "INSERT INTO ledger_txs (id, from_wallet, to_wallet, amount, reason) VALUES (?, ?, ?, ?, ?)",
      args: [uuid(), "axiom-revenue", agentId, amount, "axiom-yield-payout"],
    });
    totalDistributed += amount;
  }

  // Clear processed usage logs
  stmts.push({
    sql: "DELETE FROM axiom_usage_logs",
    args: [],
  });

  await db.batch(stmts);

  return {
    distributed: totalDistributed,
    agents: agentPayouts.size,
    totalUsage,
    topicBreakdown,
  };
}
