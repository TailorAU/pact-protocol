import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { sanitizeReason } from "@/lib/sanitize";
import { transfer } from "@/lib/economy";

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

  const body = await req.json().catch(() => ({}));
  const { reason, confidential, publicSummary } = body as { reason?: string; confidential?: boolean; publicSummary?: string };
  const isConfidential = confidential ? 1 : 0;

  if (!reason) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  // Confidential objections must include a publicSummary for anti-gridlock
  if (isConfidential && !publicSummary) {
    return NextResponse.json({ error: "Confidential objections must include a publicSummary with actionable feedback" }, { status: 400 });
  }

  // Enforce 500 char max on publicSummary
  if (publicSummary && String(publicSummary).length > 500) {
    return NextResponse.json({ error: "publicSummary must be 500 characters or fewer" }, { status: 400 });
  }
  const cleanPublicSummary = publicSummary ? String(publicSummary).slice(0, 500) : null;

  // Sanitize reason text
  const reasonResult = sanitizeReason(reason);
  if (!reasonResult.valid) {
    return NextResponse.json({ error: `reason: ${reasonResult.error}` }, { status: 400 });
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

  // Block self-objection — you can't object to your own proposal
  if (proposal.agent_id === agent.id) {
    return NextResponse.json({ error: "You cannot object to your own proposal" }, { status: 403 });
  }

  try {
    await db.execute({
      sql: "INSERT INTO votes (id, proposal_id, agent_id, vote_type, reason, confidential, public_summary) VALUES (?, ?, ?, 'object', ?, ?, ?)",
      args: [uuid(), proposalId, agent.id, reasonResult.sanitized, isConfidential, cleanPublicSummary],
    });
  } catch {
    return NextResponse.json({ error: "Already voted" }, { status: 409 });
  }

  await db.execute({
    sql: "UPDATE agents SET objections_made = objections_made + 1 WHERE id = ?",
    args: [agent.id],
  });

  // Truth-seeking reward: credit for peer review (objection)
  await db.execute({
    sql: "UPDATE agents SET reviews_cast = reviews_cast + 1 WHERE id = ?",
    args: [agent.id],
  });
  await transfer(db, { from: null, to: agent.id, amount: 1, topicId, reason: "review-reward" });

  await emitEvent(db, topicId, "pact.proposal.objected", agent.id, proposal.section_id as string, {
    proposalId,
    reason: isConfidential ? (cleanPublicSummary || "[Sealed objection]") : reasonResult.sanitized,
    ...(isConfidential ? { confidential: true } : {}),
  });

  return NextResponse.json({ status: "objected", confidential: !!isConfidential });
}
