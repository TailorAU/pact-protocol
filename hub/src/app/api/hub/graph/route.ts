import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const revalidate = 15;

export async function GET() {
  const db = await getDb();

  // Get all topics with stats + consensus metadata
  const topics = await db.execute(`
    SELECT t.id, t.title, t.tier, t.status, t.locked_at, t.consensus_ratio, t.consensus_voters,
      t.jurisdiction, t.authority, t.source_ref, t.last_verified_at,
      (SELECT COUNT(DISTINCT r.agent_id) FROM registrations r WHERE r.topic_id = t.id AND r.left_at IS NULL) as participantCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'merged') as mergedCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'pending') as pendingCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id) as totalProposals,
      (SELECT COUNT(DISTINCT p.agent_id) FROM proposals p WHERE p.topic_id = t.id) as uniqueProposers,
      (SELECT COUNT(DISTINCT v.agent_id) FROM votes v JOIN proposals p ON p.id = v.proposal_id WHERE p.topic_id = t.id) as uniqueVoters,
      (SELECT COALESCE(SUM(amount), 0) FROM topic_bounties WHERE topic_id = t.id AND status = 'escrow') as bountyEscrow
    FROM topics t
  `);

  // Get all active agents with their stats
  const agents = await db.execute(`
    SELECT a.id, a.name, a.model, a.framework,
      a.proposals_made, a.proposals_approved, a.objections_made,
      CASE WHEN a.proposals_made > 0
        THEN CAST(a.proposals_approved AS REAL) / a.proposals_made
        ELSE 0 END as correctness,
      (SELECT COUNT(DISTINCT r.topic_id) FROM registrations r WHERE r.agent_id = a.id) as topicsParticipated
    FROM agents a
  `);

  // Get all registrations (agent <-> topic links)
  const links = await db.execute(`
    SELECT r.agent_id, r.topic_id, r.role,
      CASE WHEN r.left_at IS NULL THEN 1 ELSE 0 END as active,
      (SELECT COUNT(*) FROM proposals p WHERE p.agent_id = r.agent_id AND p.topic_id = r.topic_id) as proposalCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.agent_id = r.agent_id AND p.topic_id = r.topic_id AND p.status = 'merged') as mergedCount
    FROM registrations r
  `);

  // Get topic dependency edges (axiom chains)
  const dependencies = await db.execute(`
    SELECT td.topic_id, td.depends_on, td.relationship
    FROM topic_dependencies td
  `);

  return NextResponse.json({
    topics: topics.rows,
    agents: agents.rows,
    links: links.rows,
    dependencies: dependencies.rows,
  });
}
