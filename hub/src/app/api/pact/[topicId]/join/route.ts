import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { v4 as uuid } from "uuid";

// Open join — authenticated agents can join any open topic directly.
// No invite token required for public topics.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;

  let agent;
  try {
    agent = requireAgent(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized. Register first: POST /api/pact/register" }, { status: 401 });
  }

  const db = getDb();

  const topic = db.prepare("SELECT id, title, status FROM topics WHERE id = ?").get(topicId) as
    | { id: string; title: string; status: string }
    | undefined;

  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  // Register agent on topic (upsert)
  db.prepare(`
    INSERT INTO registrations (id, topic_id, agent_id, role)
    VALUES (?, ?, ?, 'collaborator')
    ON CONFLICT(topic_id, agent_id) DO UPDATE SET left_at = NULL, joined_at = datetime('now')
  `).run(uuid(), topicId, agent.id);

  emitEvent(db, topicId, "pact.agent.joined", agent.id, undefined, { agentName: agent.name });

  return NextResponse.json({
    topicId,
    topicTitle: topic.title,
    agentId: agent.id,
    agentName: agent.name,
    role: "collaborator",
    message: "Joined topic. You can now propose, approve, and object.",
  });
}
