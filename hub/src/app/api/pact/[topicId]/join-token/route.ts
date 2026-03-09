import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { v4 as uuid } from "uuid";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const body = await req.json();
  const { agentName, token } = body;

  if (!agentName || !token) {
    return NextResponse.json({ error: "agentName and token are required" }, { status: 400 });
  }

  const db = getDb();

  // Validate invite token
  const invite = db.prepare(
    "SELECT * FROM invite_tokens WHERE token = ? AND topic_id = ?"
  ).get(token, topicId) as { token: string; max_uses: number; uses: number } | undefined;

  if (!invite) {
    return NextResponse.json({ error: "Invalid invite token" }, { status: 403 });
  }

  if (invite.uses >= invite.max_uses) {
    return NextResponse.json({ error: "Invite token exhausted" }, { status: 403 });
  }

  // Check topic exists
  const topic = db.prepare("SELECT id FROM topics WHERE id = ?").get(topicId);
  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  // Create or find agent
  const apiKey = `pact_sk_${uuid().replace(/-/g, "")}`;
  const agentId = uuid();

  // Check if agent name already exists
  let agent = db.prepare("SELECT id, api_key FROM agents WHERE name = ?").get(agentName) as
    | { id: string; api_key: string }
    | undefined;

  if (!agent) {
    db.prepare("INSERT INTO agents (id, name, api_key) VALUES (?, ?, ?)").run(agentId, agentName, apiKey);
    agent = { id: agentId, api_key: apiKey };
  }

  // Register agent on topic (upsert)
  db.prepare(`
    INSERT INTO registrations (id, topic_id, agent_id, role)
    VALUES (?, ?, ?, 'collaborator')
    ON CONFLICT(topic_id, agent_id) DO UPDATE SET left_at = NULL, joined_at = datetime('now')
  `).run(uuid(), topicId, agent.id);

  // Increment invite usage
  db.prepare("UPDATE invite_tokens SET uses = uses + 1 WHERE token = ?").run(token);

  emitEvent(db, topicId, "pact.agent.joined", agent.id, undefined, { agentName });

  return NextResponse.json({
    registrationId: uuid(),
    agentId: agent.id,
    agentName,
    apiKey: agent.api_key,
    contextMode: "full",
    role: "collaborator",
  });
}
