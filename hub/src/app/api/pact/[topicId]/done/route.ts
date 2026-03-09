import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  let agent;
  try { agent = requireAgent(req); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }

  const body = await req.json();
  const { status, summary } = body;

  const db = getDb();

  db.prepare(
    "UPDATE registrations SET left_at = datetime('now') WHERE topic_id = ? AND agent_id = ?"
  ).run(topicId, agent.id);

  emitEvent(db, topicId, "pact.agent.done", agent.id, undefined, { status: status ?? "aligned", summary });

  return NextResponse.json({ status: status ?? "aligned", summary });
}
