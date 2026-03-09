import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const db = getDb();

  const entries = db.prepare(
    "SELECT s.section_id as sectionId, s.agent_id as agentId, s.score, a.name as agentName FROM salience s JOIN agents a ON a.id = s.agent_id WHERE s.topic_id = ?"
  ).all(topicId);

  return NextResponse.json({ entries });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  let agent;
  try { agent = requireAgent(req); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const { sectionId, score } = body;

  if (!sectionId || score === undefined || score < 0 || score > 10) {
    return NextResponse.json({ error: "sectionId and score (0-10) are required" }, { status: 400 });
  }

  const db = getDb();

  db.prepare(`
    INSERT INTO salience (topic_id, section_id, agent_id, score)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(topic_id, section_id, agent_id) DO UPDATE SET score = ?, updated_at = datetime('now')
  `).run(topicId, sectionId, agent.id, score, score);

  emitEvent(db, topicId, "pact.salience.updated", agent.id, sectionId, { score });

  return NextResponse.json({ sectionId, score });
}
