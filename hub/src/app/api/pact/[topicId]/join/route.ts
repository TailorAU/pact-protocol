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
    agent = await requireAgent(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized. Register first: POST /api/pact/register" }, { status: 401 });
  }

  const db = await getDb();

  const topicResult = await db.execute({ sql: "SELECT id, title, status FROM topics WHERE id = ?", args: [topicId] });
  const topic = topicResult.rows[0];

  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  // Register agent on topic (upsert)
  await db.execute({
    sql: `INSERT INTO registrations (id, topic_id, agent_id, role)
    VALUES (?, ?, ?, 'collaborator')
    ON CONFLICT(topic_id, agent_id) DO UPDATE SET left_at = NULL, joined_at = datetime('now')`,
    args: [uuid(), topicId, agent.id],
  });

  await emitEvent(db, topicId, "pact.agent.joined", agent.id, undefined, { agentName: agent.name });

  return NextResponse.json({
    topicId,
    topicTitle: topic.title as string,
    agentId: agent.id,
    agentName: agent.name,
    role: "collaborator",
    message: "Joined topic. You can now propose, approve, and object.",
    hints: {
      doneEndpoint: `POST /api/pact/${topicId}/done`,
      assumptionsRequired: "When signaling 'aligned', you MUST include an 'assumptions' array. " +
        "Each entry: { title, tier } for new assumptions or { topicId } for existing ones. " +
        "Pass [] with 'noAssumptionsReason' (min 20 chars) if there are none.",
      canonicalize: "Submit a proposalType: 'canonicalize' proposal to set or refine the topic's canonical claim " +
        "(the exact statement being verified, distinct from the human-friendly title).",
      assumptionsEndpoint: `GET /api/pact/${topicId}/assumptions`,
      dependenciesEndpoint: `GET /api/pact/${topicId}/dependencies`,
    },
  });
}
