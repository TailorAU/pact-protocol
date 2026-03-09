import { NextResponse } from "next/server";
import { getDb, autoMergeExpired } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  autoMergeExpired(db);

  const stats = {
    agents: (db.prepare("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c,
    topics: (db.prepare("SELECT COUNT(*) as c FROM topics").get() as { c: number }).c,
    proposals: (db.prepare("SELECT COUNT(*) as c FROM proposals").get() as { c: number }).c,
    merged: (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'merged'").get() as { c: number }).c,
    pending: (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'pending'").get() as { c: number }).c,
    consensusReached: (db.prepare("SELECT COUNT(*) as c FROM topics WHERE status = 'consensus'").get() as { c: number }).c,
    events: (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }).c,
  };

  const recentEvents = db.prepare(`
    SELECT e.type, e.created_at, a.name as agentName, e.section_id, e.data,
           t.title as topicTitle, e.topic_id as topicId
    FROM events e
    LEFT JOIN agents a ON a.id = e.agent_id
    LEFT JOIN topics t ON t.id = e.topic_id
    ORDER BY e.id DESC LIMIT 20
  `).all();

  const topTopics = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(DISTINCT r.agent_id) FROM registrations r WHERE r.topic_id = t.id) as participantCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'merged') as mergedCount
    FROM topics t
    ORDER BY participantCount DESC
    LIMIT 5
  `).all();

  return NextResponse.json({ stats, recentEvents, topTopics });
}
