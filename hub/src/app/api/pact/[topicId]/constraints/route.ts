import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const db = getDb();
  const sectionId = req.nextUrl.searchParams.get("sectionId");

  let constraints;
  if (sectionId) {
    constraints = db.prepare(
      "SELECT c.*, a.name as agentName FROM constraints_table c JOIN agents a ON a.id = c.agent_id WHERE c.topic_id = ? AND c.section_id = ? ORDER BY c.created_at DESC"
    ).all(topicId, sectionId);
  } else {
    constraints = db.prepare(
      "SELECT c.*, a.name as agentName FROM constraints_table c JOIN agents a ON a.id = c.agent_id WHERE c.topic_id = ? ORDER BY c.created_at DESC"
    ).all(topicId);
  }

  return NextResponse.json(constraints);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  let agent;
  try { agent = requireAgent(req); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const { sectionId, boundary, category } = body;

  if (!sectionId || !boundary) {
    return NextResponse.json({ error: "sectionId and boundary are required" }, { status: 400 });
  }

  const db = getDb();
  const constraintId = uuid();

  db.prepare(
    "INSERT INTO constraints_table (id, topic_id, section_id, agent_id, boundary, category) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(constraintId, topicId, sectionId, agent.id, boundary, category ?? "general");

  emitEvent(db, topicId, "pact.constraint.published", agent.id, sectionId, { constraintId, boundary });

  return NextResponse.json({ id: constraintId, sectionId, boundary, category: category ?? "general" }, { status: 201 });
}
