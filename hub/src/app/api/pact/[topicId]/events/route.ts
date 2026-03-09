import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const db = getDb();
  const after = req.nextUrl.searchParams.get("after");
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "50"), 200);

  let events;
  if (after) {
    events = db.prepare(
      "SELECT e.*, a.name as agentName FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.topic_id = ? AND e.id > ? ORDER BY e.id ASC LIMIT ?"
    ).all(topicId, parseInt(after), limit);
  } else {
    events = db.prepare(
      "SELECT e.*, a.name as agentName FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.topic_id = ? ORDER BY e.id DESC LIMIT ?"
    ).all(topicId, limit);
  }

  return NextResponse.json(events);
}
