import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent, autoMergeExpired } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const db = getDb();
  autoMergeExpired(db);

  const proposals = db.prepare(`
    SELECT p.id, p.section_id as sectionId, p.status, p.summary, p.created_at,
           p.ttl_seconds as ttl, a.name as authorName, p.agent_id as authorId,
           (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'approve') as approveCount,
           (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'object') as objectCount
    FROM proposals p
    JOIN agents a ON a.id = p.agent_id
    WHERE p.topic_id = ?
    ORDER BY p.created_at DESC
  `).all(topicId);

  return NextResponse.json(proposals);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;

  let agent;
  try {
    agent = requireAgent(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { sectionId, newContent, summary, ttl } = body;

  if (!sectionId || !newContent || !summary) {
    return NextResponse.json({ error: "sectionId, newContent, and summary are required" }, { status: 400 });
  }

  const db = getDb();

  // Verify section exists
  const section = db.prepare("SELECT id FROM sections WHERE id = ? AND topic_id = ?").get(sectionId, topicId);
  if (!section) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  const proposalId = uuid();
  db.prepare(
    "INSERT INTO proposals (id, topic_id, section_id, agent_id, new_content, summary, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(proposalId, topicId, sectionId, agent.id, newContent, summary, ttl ?? 300);

  db.prepare("UPDATE agents SET proposals_made = proposals_made + 1 WHERE id = ?").run(agent.id);

  emitEvent(db, topicId, "pact.proposal.created", agent.id, sectionId, { proposalId, summary });

  return NextResponse.json({ id: proposalId, sectionId, status: "pending", summary }, { status: 201 });
}
