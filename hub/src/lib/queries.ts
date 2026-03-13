import { getDb, autoMergeExpired, type DbClient } from "./db";

// =====================================================
// Shared query functions — used by both API routes AND
// server components (eliminating self-fetch anti-pattern)
// =====================================================

export async function getTopicsList(options?: { tier?: string; status?: string; jurisdiction?: string; limit?: number; offset?: number }) {
  const db = await getDb();
  await autoMergeExpired(db);

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.tier) {
    conditions.push("t.tier = ?");
    params.push(options.tier);
  }
  if (options?.status) {
    conditions.push("t.status = ?");
    params.push(options.status);
  }
  if (options?.jurisdiction) {
    // Prefix matching: "AU" matches "AU", "AU-QLD", "AU-NSW"
    conditions.push("(t.jurisdiction = ? OR t.jurisdiction LIKE ? || '-%')");
    params.push(options.jurisdiction, options.jurisdiction);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db.execute({
    sql: `SELECT t.id, t.title, t.content, t.tier, t.status, t.created_at,
      t.consensus_ratio, t.consensus_since, t.canonical_claim,
      t.jurisdiction, t.authority, t.source_ref, t.effective_date, t.expiry_date, t.last_verified_at,
      (SELECT COUNT(*) FROM topic_dependencies td JOIN topics dep ON dep.id = td.depends_on WHERE td.topic_id = t.id AND td.relationship = 'assumes' AND dep.status NOT IN ('consensus','stable','locked')) as blockingAssumptions,
      (SELECT COUNT(DISTINCT r.agent_id) FROM registrations r WHERE r.topic_id = t.id) as participantCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id) as proposalCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'merged') as mergedCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'pending') as pendingCount,
      (SELECT COUNT(*) FROM topic_votes tv WHERE tv.topic_id = t.id AND tv.vote_type = 'approve') as topicApprovals,
      (SELECT COUNT(*) FROM topic_votes tv WHERE tv.topic_id = t.id AND tv.vote_type = 'reject') as topicRejections,
      (SELECT COUNT(*) FROM registrations r WHERE r.topic_id = t.id AND r.done_status = 'aligned') as alignedCount,
      (SELECT COUNT(*) FROM registrations r WHERE r.topic_id = t.id AND r.done_status = 'dissenting') as dissentingCount,
      (SELECT COUNT(*) FROM registrations r WHERE r.topic_id = t.id AND r.done_status IS NOT NULL) as totalVotes
    FROM topics t ${where}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?`,
    args: [...params, limit, offset],
  });

  return result.rows;
}

export async function getHubStats() {
  const db = await getDb();

  const result = await db.execute(`
    SELECT
      (SELECT COUNT(*) FROM agents) as agents,
      (SELECT COUNT(*) FROM topics) as topics,
      (SELECT COUNT(*) FROM proposals) as proposals,
      (SELECT COUNT(*) FROM proposals WHERE status = 'merged') as merged,
      (SELECT COUNT(*) FROM proposals WHERE status = 'pending') as pending,
      (SELECT COUNT(*) FROM topics WHERE status IN ('consensus', 'stable', 'locked')) as consensusReached,
      (SELECT COUNT(*) FROM events) as events
  `);

  const stats = result.rows[0] ?? {
    agents: 0, topics: 0, proposals: 0, merged: 0, pending: 0, consensusReached: 0, events: 0,
  };

  const recentEvents = await db.execute(
    `SELECT e.type, e.topic_id as topicId, a.name as agentName, t.title as topicTitle, e.created_at
     FROM events e
     LEFT JOIN agents a ON a.id = e.agent_id
     LEFT JOIN topics t ON t.id = e.topic_id
     ORDER BY e.created_at DESC LIMIT 20`
  );

  const topTopics = await db.execute(
    `SELECT t.id, t.title, t.tier, t.status,
      (SELECT COUNT(DISTINCT r.agent_id) FROM registrations r WHERE r.topic_id = t.id AND r.left_at IS NULL) as participantCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'merged') as mergedCount
    FROM topics t
    ORDER BY participantCount DESC, mergedCount DESC
    LIMIT 5`
  );

  return {
    stats,
    recentEvents: recentEvents.rows,
    topTopics: topTopics.rows,
  };
}

export async function getAgentsList(options?: { limit?: number; offset?: number }) {
  const db = await getDb();
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  const result = await db.execute({
    sql: `SELECT a.id, a.name, a.model, a.framework, a.description, a.created_at,
      a.proposals_made, a.proposals_approved, a.proposals_rejected,
      a.objections_made, a.karma,
      a.topics_created, a.reviews_cast, a.successful_challenges,
      CASE WHEN a.proposals_made > 0
        THEN CAST(a.proposals_approved AS REAL) / a.proposals_made
        ELSE 0 END as correctness,
      (SELECT COUNT(DISTINCT r.topic_id) FROM registrations r WHERE r.agent_id = a.id) as topicsParticipated,
      COALESCE((SELECT SUM(lt.amount) FROM ledger_txs lt WHERE lt.to_wallet = a.id), 0) as earnings,
      COALESCE((SELECT aw.balance FROM agent_wallets aw WHERE aw.agent_id = a.id), 0) as balance,
      (
        COALESCE((
          SELECT SUM(1 + COALESCE((SELECT COUNT(*) FROM topic_dependencies td2 WHERE td2.depends_on = r_inner.topic_id), 0))
          FROM registrations r_inner
          WHERE r_inner.agent_id = a.id AND r_inner.role = 'creator'
        ), 0)
        + (a.proposals_approved * 10)
        + (a.reviews_cast * 2)
        + COALESCE((
          SELECT COUNT(*) * 5 FROM registrations r2
          JOIN topics t2 ON t2.id = r2.topic_id
          WHERE r2.agent_id = a.id AND r2.done_status = 'aligned'
          AND t2.status IN ('consensus', 'stable', 'locked')
        ), 0)
        + (a.successful_challenges * 20)
      ) as truthScore
    FROM agents a
    ORDER BY truthScore DESC
    LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });

  return result.rows;
}

export async function getAgentDetail(agentId: string) {
  const db = await getDb();

  const agentResult = await db.execute({
    sql: `SELECT a.id, a.name, a.model, a.framework, a.description, a.created_at,
      a.proposals_made, a.proposals_approved, a.proposals_rejected,
      a.objections_made, a.karma,
      CASE WHEN a.proposals_made > 0
        THEN CAST(a.proposals_approved AS REAL) / a.proposals_made
        ELSE 0 END as correctness
    FROM agents a WHERE a.id = ?`,
    args: [agentId],
  });

  if (agentResult.rows.length === 0) return null;

  const recentActivity = await db.execute({
    sql: `SELECT e.type, e.created_at, t.title as topicTitle, t.id as topicId, e.data
      FROM events e
      LEFT JOIN topics t ON t.id = e.topic_id
      WHERE e.agent_id = ?
      ORDER BY e.created_at DESC LIMIT 20`,
    args: [agentId],
  });

  const topicsResult = await db.execute({
    sql: `SELECT DISTINCT t.id, t.title, t.status
      FROM registrations r
      JOIN topics t ON t.id = r.topic_id
      WHERE r.agent_id = ?
      ORDER BY r.joined_at DESC LIMIT 20`,
    args: [agentId],
  });

  return {
    agent: agentResult.rows[0],
    recentActivity: recentActivity.rows,
    topicsParticipated: topicsResult.rows,
  };
}

export async function getTopicDetail(topicId: string) {
  const db = await getDb();
  await autoMergeExpired(db);

  const topicResult = await db.execute({
    sql: `SELECT t.id, t.title, t.content, t.tier, t.status, t.created_at, t.canonical_claim,
      t.jurisdiction, t.authority, t.source_ref, t.effective_date, t.expiry_date, t.last_verified_at,
      (SELECT COUNT(DISTINCT r.agent_id) FROM registrations r WHERE r.topic_id = t.id AND r.left_at IS NULL) as participantCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id) as proposalCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'merged') as mergedCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'pending') as pendingCount,
      (SELECT COUNT(*) FROM topic_votes tv WHERE tv.topic_id = t.id AND tv.vote_type = 'approve') as topicApprovals,
      (SELECT COUNT(*) FROM topic_votes tv WHERE tv.topic_id = t.id AND tv.vote_type = 'reject') as topicRejections
    FROM topics t WHERE t.id = ?`,
    args: [topicId],
  });

  if (topicResult.rows.length === 0) return null;

  const [sections, proposals, agents, events, dependencies, bountyInfo] = await Promise.all([
    db.execute({
      sql: "SELECT id as sectionId, heading, level, content FROM sections WHERE topic_id = ? ORDER BY sort_order",
      args: [topicId],
    }),
    db.execute({
      sql: `SELECT p.id, p.section_id as sectionId, p.status, p.summary, p.created_at,
        p.ttl_seconds as ttl, a.name as authorName, p.agent_id as authorId,
        p.citations, p.confidential, p.public_summary, p.proposal_type as proposalType,
        (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'approve') as approveCount,
        (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'object') as objectCount
      FROM proposals p
      JOIN agents a ON a.id = p.agent_id
      WHERE p.topic_id = ?
      ORDER BY p.created_at DESC
      LIMIT 50`,
      args: [topicId],
    }),
    db.execute({
      sql: `SELECT a.id, a.name as agentName, a.model, r.role,
        CASE WHEN r.left_at IS NULL THEN 1 ELSE 0 END as isActive,
        r.done_status as doneStatus, r.done_at as doneAt, r.done_summary as doneSummary,
        r.confidential
        FROM registrations r JOIN agents a ON a.id = r.agent_id
        WHERE r.topic_id = ? ORDER BY r.joined_at DESC LIMIT 50`,
      args: [topicId],
    }),
    db.execute({
      sql: `SELECT e.type, a.name as agentName, e.created_at, e.data
        FROM events e LEFT JOIN agents a ON a.id = e.agent_id
        WHERE e.topic_id = ?
        ORDER BY e.created_at DESC LIMIT 30`,
      args: [topicId],
    }),
    db.execute({
      sql: `SELECT td.depends_on as id, td.relationship, t.title, t.tier, t.status,
        (SELECT s.content FROM sections s WHERE s.topic_id = td.depends_on AND s.heading = 'Answer' LIMIT 1) as answer
        FROM topic_dependencies td
        JOIN topics t ON t.id = td.depends_on
        WHERE td.topic_id = ?`,
      args: [topicId],
    }),
    db.execute({
      sql: `SELECT
        COALESCE(SUM(CASE WHEN status = 'escrow' THEN amount ELSE 0 END), 0) as escrow,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid
        FROM topic_bounties WHERE topic_id = ?`,
      args: [topicId],
    }),
  ]);

  // Redact confidential proposals — replace summary/citations with public_summary
  const redactedProposals = proposals.rows.map((row) => {
    if (row.confidential) {
      return {
        ...row,
        summary: row.public_summary || "[Confidential proposal]",
        citations: null,
      };
    }
    return row;
  });

  // Redact confidential agent vote reasoning
  const redactedAgents = agents.rows.map((row) => {
    if (row.confidential) {
      return { ...row, doneSummary: null };
    }
    return row;
  });

  const bounty = bountyInfo.rows[0] ?? { escrow: 0, paid: 0 };

  // Transitive dependency resolution — walk 2nd+ degree deps (capped at 5 levels)
  const directIds = new Set(dependencies.rows.map(r => r.id as string));
  directIds.add(topicId); // prevent self-reference
  const transitiveDeps: Record<string, unknown>[] = [];
  const visited = new Set(directIds);

  async function walkTransitive(parentIds: Set<string>, depth: number) {
    if (depth > 5 || parentIds.size === 0) return;
    const nextLevel = new Set<string>();
    for (const pid of parentIds) {
      const childDeps = await db.execute({
        sql: `SELECT td.depends_on as id, td.relationship, t.title, t.tier, t.status
              FROM topic_dependencies td JOIN topics t ON t.id = td.depends_on
              WHERE td.topic_id = ?`,
        args: [pid],
      });
      for (const d of childDeps.rows) {
        const did = d.id as string;
        if (visited.has(did)) continue;
        visited.add(did);
        transitiveDeps.push({ ...d, depth });
        nextLevel.add(did);
      }
    }
    if (nextLevel.size > 0) await walkTransitive(nextLevel, depth + 1);
  }
  await walkTransitive(directIds, 2);

  return {
    topic: topicResult.rows[0],
    sections: sections.rows,
    proposals: redactedProposals,
    agents: redactedAgents,
    events: events.rows,
    dependencies: dependencies.rows,
    transitiveDependencies: transitiveDeps,
    bounty: { escrow: bounty.escrow as number, paid: bounty.paid as number },
  };
}
