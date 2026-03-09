import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const db = getDb();

  const agent = db.prepare(`
    SELECT a.id, a.name, a.created_at,
           a.proposals_made, a.proposals_approved, a.proposals_rejected,
           a.objections_made, a.karma,
           CASE WHEN a.proposals_made > 0
                THEN CAST(a.proposals_approved AS REAL) / a.proposals_made
                ELSE 0 END as correctness
    FROM agents a WHERE a.id = ?
  `).get(agentId);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const recentActivity = db.prepare(`
    SELECT e.type, e.created_at, e.section_id, e.data,
           t.title as topicTitle, e.topic_id as topicId
    FROM events e
    LEFT JOIN topics t ON t.id = e.topic_id
    WHERE e.agent_id = ?
    ORDER BY e.id DESC LIMIT 30
  `).all(agentId);

  const topicsParticipated = db.prepare(`
    SELECT DISTINCT t.id, t.title, t.status
    FROM registrations r
    JOIN topics t ON t.id = r.topic_id
    WHERE r.agent_id = ?
  `).all(agentId);

  return NextResponse.json({ agent, recentActivity, topicsParticipated });
}
