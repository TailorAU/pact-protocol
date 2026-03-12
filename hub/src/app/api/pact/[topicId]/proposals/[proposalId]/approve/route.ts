import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent, checkAgentReputation } from "@/lib/auth";
import { v4 as uuid } from "uuid";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string; proposalId: string }> }
) {
  const { topicId, proposalId } = await params;

  let agent;
  try {
    agent = await requireAgent(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();

  const proposalResult = await db.execute({
    sql: "SELECT * FROM proposals WHERE id = ? AND topic_id = ? AND status = 'pending'",
    args: [proposalId, topicId],
  });
  const proposal = proposalResult.rows[0];

  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found or not pending" }, { status: 404 });
  }

  // Block self-approval — you can't approve your own proposal
  if (proposal.agent_id === agent.id) {
    return NextResponse.json({ error: "You cannot approve your own proposal" }, { status: 403 });
  }

  // Sybil resistance — check agent reputation before allowing consensus-affecting votes
  const reputation = await checkAgentReputation(agent.id);
  if (!reputation.eligible) {
    return NextResponse.json({ error: reputation.reason }, { status: 403 });
  }

  // Record vote
  try {
    await db.execute({
      sql: "INSERT INTO votes (id, proposal_id, agent_id, vote_type) VALUES (?, ?, ?, 'approve')",
      args: [uuid(), proposalId, agent.id],
    });
  } catch {
    return NextResponse.json({ error: "Already voted" }, { status: 409 });
  }

  // Count current votes on this proposal
  const voteCountResult = await db.execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM votes WHERE proposal_id = ? AND vote_type = 'approve') as approveCount,
      (SELECT COUNT(*) FROM votes WHERE proposal_id = ? AND vote_type = 'object') as objectCount`,
    args: [proposalId, proposalId],
  });
  const approveCount = (voteCountResult.rows[0].approveCount as number) || 0;
  const objectCount = (voteCountResult.rows[0].objectCount as number) || 0;

  // Count registered agents for this topic (for majority calculation)
  const regCountResult = await db.execute({
    sql: "SELECT COUNT(*) as c FROM registrations WHERE topic_id = ? AND left_at IS NULL",
    args: [topicId],
  });
  const registeredAgents = (regCountResult.rows[0].c as number) || 1;

  // Merge policy:
  // - No objections: min(2, registeredAgents) approvals needed (prevents single-agent rubber-stamping)
  // - With objections: need ceil(registeredAgents * 0.5) approvals (majority rule)
  // - Solo topics (1 participant): 1 approval still required (from a non-author)
  const needsMajority = objectCount > 0;
  const requiredApprovals = needsMajority
    ? Math.ceil(registeredAgents * 0.5)
    : Math.min(2, Math.max(1, registeredAgents));

  await emitEvent(db, topicId, "pact.proposal.approved", agent.id, proposal.section_id as string, { proposalId });

  if (approveCount >= requiredApprovals) {
    // Merge the proposal — enough approvals gathered
    await db.execute({
      sql: "UPDATE proposals SET status = 'merged', resolved_at = datetime('now') WHERE id = ?",
      args: [proposalId],
    });
    // Canonicalize proposals update topics.canonical_claim instead of a section
    if (proposal.proposal_type === "canonicalize") {
      await db.execute({
        sql: "UPDATE topics SET canonical_claim = ? WHERE id = ?",
        args: [proposal.new_content as string, topicId],
      });
    } else {
      await db.execute({
        sql: "UPDATE sections SET content = ? WHERE id = ? AND topic_id = ?",
        args: [proposal.new_content as string, proposal.section_id as string, topicId],
      });
    }
    await db.execute({
      sql: "UPDATE agents SET proposals_approved = proposals_approved + 1 WHERE id = ?",
      args: [proposal.agent_id as string],
    });

    await emitEvent(db, topicId, "pact.proposal.merged", agent.id, proposal.section_id as string, {
      proposalId,
      approveCount,
      objectCount,
      requiredApprovals,
      policy: needsMajority ? "majority" : "multi-approval",
    });

    return NextResponse.json({
      status: "merged",
      approveCount,
      objectCount,
      policy: needsMajority ? "majority" : "multi-approval",
    });
  } else {
    // Approved but not enough votes to merge yet
    const remaining = requiredApprovals - approveCount;
    const reason = needsMajority
      ? `Proposal has objections. ${remaining} more approval(s) needed for majority merge.`
      : `${remaining} more approval(s) needed to merge.`;
    return NextResponse.json({
      status: "approved",
      approveCount,
      objectCount,
      requiredApprovals,
      remainingApprovals: remaining,
      policy: needsMajority ? "majority" : "multi-approval",
      note: reason,
    });
  }
}
