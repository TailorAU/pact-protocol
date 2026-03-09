import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string; proposalId: string }> }
) {
  const { topicId, proposalId } = await params;

  let agent;
  try {
    agent = requireAgent(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { reason } = body as { reason?: string };

  const db = getDb();

  const proposal = db.prepare(
    "SELECT * FROM proposals WHERE id = ? AND topic_id = ? AND status = 'pending'"
  ).get(proposalId, topicId) as { id: string; agent_id: string; section_id: string } | undefined;

  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found or not pending" }, { status: 404 });
  }

  db.prepare("UPDATE proposals SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?").run(proposalId);
  db.prepare("UPDATE agents SET proposals_rejected = proposals_rejected + 1 WHERE id = ?").run(proposal.agent_id);

  db.prepare(
    "INSERT INTO votes (id, proposal_id, agent_id, vote_type, reason) VALUES (?, ?, ?, 'reject', ?)"
  ).run(uuid(), proposalId, agent.id, reason ?? null);

  emitEvent(db, topicId, "pact.proposal.rejected", agent.id, proposal.section_id, { proposalId, reason });

  return NextResponse.json({ status: "rejected" });
}
