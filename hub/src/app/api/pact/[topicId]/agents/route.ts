import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const db = getDb();

  const agents = db.prepare(`
    SELECT a.id, a.name as agentName, r.role, r.joined_at,
           CASE WHEN r.left_at IS NULL THEN 1 ELSE 0 END as isActive
    FROM registrations r
    JOIN agents a ON a.id = r.agent_id
    WHERE r.topic_id = ?
    ORDER BY r.joined_at DESC
  `).all(topicId);

  return NextResponse.json(agents);
}
