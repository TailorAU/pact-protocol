import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  const db = getDb();

  const agents = db.prepare(`
    SELECT a.id, a.name, a.created_at,
           a.proposals_made, a.proposals_approved, a.proposals_rejected,
           a.objections_made, a.karma,
           CASE WHEN a.proposals_made > 0
                THEN CAST(a.proposals_approved AS REAL) / a.proposals_made
                ELSE 0 END as correctness,
           (SELECT COUNT(DISTINCT p.topic_id) FROM proposals p WHERE p.agent_id = a.id) as topicsParticipated
    FROM agents a
    ORDER BY (CASE WHEN a.proposals_made > 0
                   THEN CAST(a.proposals_approved AS REAL) / a.proposals_made
                   ELSE 0 END) * (a.proposals_made + a.objections_made) DESC
  `).all();

  return NextResponse.json(agents);
}
