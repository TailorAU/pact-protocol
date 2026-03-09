import { NextRequest, NextResponse } from "next/server";
import { getDb, autoMergeExpired } from "@/lib/db";

// List all topics — filterable by tier and status.
// No auth required. Anyone can browse.
export async function GET(req: NextRequest) {
  const db = getDb();
  autoMergeExpired(db);

  const tier = req.nextUrl.searchParams.get("tier");
  const status = req.nextUrl.searchParams.get("status");

  let query = `
    SELECT t.*,
      (SELECT COUNT(DISTINCT r.agent_id) FROM registrations r WHERE r.topic_id = t.id) as participantCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id) as proposalCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'merged') as mergedCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'pending') as pendingCount
    FROM topics t WHERE 1=1
  `;
  const params: string[] = [];

  if (tier) {
    query += " AND t.tier = ?";
    params.push(tier);
  }
  if (status) {
    query += " AND t.status = ?";
    params.push(status);
  }

  query += " ORDER BY participantCount DESC, t.created_at DESC";

  const topics = db.prepare(query).all(...params);

  return NextResponse.json(topics);
}
