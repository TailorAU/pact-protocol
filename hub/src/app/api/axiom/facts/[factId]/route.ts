import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireApiKey, deductApiCredit } from "@/lib/auth";

// GET /api/axiom/facts/:factId — Get full detail for a verified fact
// Returns the topic with all merged section content, dependency links, and verification metadata.
// Costs 1 credit per call.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ factId: string }> }
) {
  let apiKey;
  try {
    apiKey = await requireApiKey(req);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unauthorized";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const { factId } = await params;
  const db = await getDb();

  // Fetch the topic — only if it's verified (consensus or stable)
  const topicResult = await db.execute({
    sql: `SELECT id, title, content, canonical_claim, tier, status, jurisdiction, authority, source_ref,
      effective_date, expiry_date, last_verified_at, last_verified_by,
      consensus_ratio, consensus_voters, consensus_since, created_at
      FROM topics WHERE id = ? AND status IN ('consensus', 'stable')`,
    args: [factId],
  });

  if (topicResult.rows.length === 0) {
    return NextResponse.json({
      error: "Fact not found. Either the ID is invalid or the topic has not reached consensus.",
    }, { status: 404 });
  }

  const topic = topicResult.rows[0];

  // Fetch all sections (merged content)
  const sectionsResult = await db.execute({
    sql: "SELECT id, heading, level, content, sort_order FROM sections WHERE topic_id = ? ORDER BY sort_order",
    args: [factId],
  });

  // Fetch dependencies
  const depsResult = await db.execute({
    sql: `SELECT td.depends_on, td.relationship, t.title, t.tier, t.status
      FROM topic_dependencies td
      JOIN topics t ON t.id = td.depends_on
      WHERE td.topic_id = ?`,
    args: [factId],
  });

  // Fetch participation stats
  const statsResult = await db.execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM registrations WHERE topic_id = ?) as participants,
      (SELECT COUNT(*) FROM proposals WHERE topic_id = ? AND status = 'merged') as mergedProposals,
      (SELECT COUNT(*) FROM votes v JOIN proposals p ON p.id = v.proposal_id WHERE p.topic_id = ?) as totalVotes`,
    args: [factId, factId, factId],
  });
  const stats = statsResult.rows[0] || {};

  // Deduct 1 credit
  await deductApiCredit(apiKey.id, factId);

  return NextResponse.json({
    fact: {
      id: topic.id,
      title: topic.title,
      description: topic.content,
      canonicalClaim: topic.canonical_claim,
      tier: topic.tier,
      status: topic.status,
      jurisdiction: topic.jurisdiction || null,
      authority: topic.authority || null,
      sourceRef: topic.source_ref || null,
      effectiveDate: topic.effective_date || null,
      expiryDate: topic.expiry_date || null,
      lastVerifiedAt: topic.last_verified_at || null,
      lastVerifiedBy: topic.last_verified_by || null,
      consensusRatio: topic.consensus_ratio,
      consensusVoters: topic.consensus_voters,
      consensusSince: topic.consensus_since,
      createdAt: topic.created_at,
    },
    sections: sectionsResult.rows.map((s) => ({
      id: s.id,
      heading: s.heading,
      level: s.level,
      content: s.content,
      sortOrder: s.sort_order,
    })),
    dependencies: depsResult.rows.map((d) => ({
      factId: d.depends_on,
      relationship: d.relationship,
      title: d.title,
      tier: d.tier,
      status: d.status,
    })),
    participation: {
      totalParticipants: stats.participants,
      mergedProposals: stats.mergedProposals,
      totalVotes: stats.totalVotes,
    },
    creditsRemaining: apiKey.creditBalance - 1,
  });
}
