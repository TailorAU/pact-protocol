import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { transfer } from "@/lib/economy";

// POST: Re-verify an institutional/interpretive topic is still current.
//
// Agents earn maintenance credits for confirming jurisdictional facts
// are still in force. This incentivizes ongoing truth maintenance —
// laws change, get amended, or get repealed.
//
// Body:
//   { "status": "current" | "amended" | "repealed",
//     "notes": "optional explanation" }
//
// Rewards:
//   - "current" verification:  +10 credits
//   - "amended" or "repealed": +25 credits (higher reward for catching changes)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  let agent;
  try {
    agent = await requireAgent(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const { status, notes } = body;
  const VALID_STATUSES = ["current", "amended", "repealed"];
  if (!status || !VALID_STATUSES.includes(status)) {
    return NextResponse.json({
      error: `status is required: one of ${VALID_STATUSES.join(", ")}`,
      hint: 'Use "current" to confirm the fact is still valid, "amended" if it has changed, or "repealed" if it no longer applies.',
    }, { status: 400 });
  }

  const db = await getDb();

  // Verify topic exists and is institutional/interpretive
  const topicResult = await db.execute({
    sql: "SELECT id, tier, status, jurisdiction FROM topics WHERE id = ?",
    args: [topicId],
  });

  if (topicResult.rows.length === 0) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const topic = topicResult.rows[0];

  if (!["institutional", "interpretive"].includes(topic.tier as string)) {
    return NextResponse.json({
      error: "Only institutional and interpretive topics can be re-verified. Universal truths (axioms, empirical) don't change.",
    }, { status: 400 });
  }

  // Agent must be a participant
  const reg = await db.execute({
    sql: "SELECT id FROM registrations WHERE topic_id = ? AND agent_id = ? AND left_at IS NULL",
    args: [topicId, agent.id],
  });
  if (reg.rows.length === 0) {
    return NextResponse.json({
      error: "You must be a participant in this topic to verify it. POST /api/pact/{topicId}/join first.",
    }, { status: 403 });
  }

  // Update verification timestamp
  await db.execute({
    sql: "UPDATE topics SET last_verified_at = datetime('now'), last_verified_by = ? WHERE id = ?",
    args: [agent.id, topicId],
  });

  // Award credits based on verification type
  const isChange = status === "amended" || status === "repealed";
  const reward = isChange ? 25 : 10;
  const reason = isChange ? "maintenance-change-detected" : "maintenance-reverification";

  await transfer(db, {
    from: null,
    to: agent.id,
    amount: reward,
    topicId,
    reason,
  });

  // If the law was amended or repealed, reopen the topic for debate
  if (isChange && ["consensus", "stable", "locked"].includes(topic.status as string)) {
    await db.execute({
      sql: "UPDATE topics SET status = 'challenged' WHERE id = ?",
      args: [topicId],
    });

    await emitEvent(db, topicId, "pact.topic.challenged", agent.id, notes || "", {
      verificationType: status,
      previousStatus: topic.status,
      jurisdiction: topic.jurisdiction,
    });
  } else {
    await emitEvent(db, topicId, "pact.topic.re-verified", agent.id, notes || "", {
      verificationType: status,
      jurisdiction: topic.jurisdiction,
    });
  }

  return NextResponse.json({
    verified: true,
    status,
    reward,
    ...(isChange ? {
      note: `Topic reopened as 'challenged' because the ${topic.tier} fact was ${status}. Other agents should review the changes.`,
    } : {
      note: `Verification confirmed. ${topic.jurisdiction} fact is still current. +${reward} credits earned.`,
    }),
  });
}
