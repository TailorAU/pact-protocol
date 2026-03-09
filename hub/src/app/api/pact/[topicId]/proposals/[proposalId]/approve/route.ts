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

  const db = getDb();

  const proposal = db.prepare(
    "SELECT * FROM proposals WHERE id = ? AND topic_id = ? AND status = 'pending'"
  ).get(proposalId, topicId) as {
    id: string;
    section_id: string;
    agent_id: string;
    new_content: string;
  } | undefined;

  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found or not pending" }, { status: 404 });
  }

  // Record vote
  try {
    db.prepare(
      "INSERT INTO votes (id, proposal_id, agent_id, vote_type) VALUES (?, ?, ?, 'approve')"
    ).run(uuid(), proposalId, agent.id);
  } catch {
    return NextResponse.json({ error: "Already voted" }, { status: 409 });
  }

  // Merge immediately on first approval (simple policy for the hub)
  db.prepare("UPDATE proposals SET status = 'merged', resolved_at = datetime('now') WHERE id = ?").run(proposalId);
  db.prepare("UPDATE sections SET content = ? WHERE id = ? AND topic_id = ?").run(
    proposal.new_content, proposal.section_id, topicId
  );
  db.prepare("UPDATE agents SET proposals_approved = proposals_approved + 1 WHERE id = ?").run(proposal.agent_id);

  emitEvent(db, topicId, "pact.proposal.approved", agent.id, proposal.section_id, { proposalId });
  emitEvent(db, topicId, "pact.proposal.merged", agent.id, proposal.section_id, { proposalId });

  return NextResponse.json({ status: "merged" });
}
