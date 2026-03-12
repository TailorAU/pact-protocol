import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { processAssumptions, type AssumptionEntry } from "@/lib/assumptions";
import { transfer } from "@/lib/economy";

const VALID_DONE_STATUSES = ["aligned", "dissenting", "abstain"];

// POST: Signal or UPDATE your done status on a topic.
// Agents can change their vote at any time — rolling consensus means
// the crowd's current opinion is what matters, not a one-time vote.
//
// ASSUMPTION QA GATE: When signaling "aligned" for the first time,
// agents MUST declare assumptions (or explain why there are none).
// This forces the axiom chain to grow organically.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  let agent;
  try { agent = await requireAgent(req); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const { status, summary, confidential, assumptions, noAssumptionsReason } = body;
  const isConfidential = confidential ? 1 : 0;

  // Validate done_status — must be one of the valid values
  const doneStatus = status && VALID_DONE_STATUSES.includes(status) ? status : "aligned";

  const db = await getDb();

  // Check topic exists
  const topicCheck = await db.execute({ sql: "SELECT id FROM topics WHERE id = ?", args: [topicId] });
  if (topicCheck.rows.length === 0) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  // Check that the agent is actually registered for this topic
  const reg = await db.execute({
    sql: "SELECT id, done_status, assumptions_declared FROM registrations WHERE topic_id = ? AND agent_id = ?",
    args: [topicId, agent.id],
  });
  if (reg.rows.length === 0) {
    return NextResponse.json({ error: "Not registered for this topic" }, { status: 403 });
  }

  const previousStatus = reg.rows[0].done_status as string | null;
  const alreadyDeclared = (reg.rows[0].assumptions_declared as number) === 1;
  const isUpdate = previousStatus !== null && previousStatus !== doneStatus;

  // ─── Assumption QA Gate ───────────────────────────────────────────
  // Only enforced when:
  //   1. Agent is signaling "aligned" (not dissenting/abstain)
  //   2. Agent hasn't already declared assumptions for this topic
  let assumptionResult = null;

  if (doneStatus === "aligned" && !alreadyDeclared) {
    // assumptions field is REQUIRED when signaling aligned for the first time
    if (assumptions === undefined || assumptions === null) {
      return NextResponse.json({
        error: "When signaling 'aligned', you must declare assumptions via the 'assumptions' array. " +
          "Each entry should have { title, tier } for new assumptions or { topicId } for existing ones. " +
          "Pass an empty array [] with a 'noAssumptionsReason' (min 20 chars) if there are none.",
      }, { status: 400 });
    }

    if (!Array.isArray(assumptions)) {
      return NextResponse.json({
        error: "'assumptions' must be an array.",
      }, { status: 400 });
    }

    if (assumptions.length === 0) {
      // Empty array is OK — but must provide a reason
      const reason = noAssumptionsReason ? String(noAssumptionsReason).trim() : "";
      if (reason.length < 20) {
        return NextResponse.json({
          error: "When declaring no assumptions, provide a 'noAssumptionsReason' (min 20 characters) " +
            "explaining why this topic has no foundational dependencies.",
        }, { status: 400 });
      }
    }

    if (assumptions.length > 0) {
      // Validate and process assumptions
      if (assumptions.length > 20) {
        return NextResponse.json({
          error: "Too many assumptions declared at once (max 20).",
        }, { status: 400 });
      }

      assumptionResult = await processAssumptions(
        db,
        topicId,
        agent.id,
        assumptions as AssumptionEntry[]
      );

      // If ALL entries had errors, fail the request
      if (assumptionResult.created.length === 0 && assumptionResult.linked.length === 0 && assumptionResult.errors.length > 0) {
        return NextResponse.json({
          error: "All assumption entries were invalid.",
          details: assumptionResult.errors,
        }, { status: 400 });
      }
    }

    // Mark assumptions as declared for this registration
    await db.execute({
      sql: "UPDATE registrations SET assumptions_declared = 1 WHERE topic_id = ? AND agent_id = ?",
      args: [topicId, agent.id],
    });

    // Emit assumption declaration event
    await emitEvent(db, topicId, "pact.assumptions.declared", agent.id, undefined, {
      count: assumptions.length,
      created: assumptionResult?.created.length ?? 0,
      linked: assumptionResult?.linked.length ?? 0,
      noAssumptionsReason: assumptions.length === 0 ? (noAssumptionsReason ?? null) : null,
    });
  }

  // ─── Persist done status ──────────────────────────────────────────
  const sanitizedSummary = summary ? String(summary).slice(0, 2000) : null;
  await db.execute({
    sql: "UPDATE registrations SET done_status = ?, done_at = datetime('now'), done_summary = ?, confidential = ? WHERE topic_id = ? AND agent_id = ?",
    args: [doneStatus, sanitizedSummary, isConfidential, topicId, agent.id],
  });

  await emitEvent(db, topicId, isUpdate ? "pact.agent.vote-changed" : "pact.agent.done", agent.id, undefined, {
    status: doneStatus,
    previousStatus: previousStatus ?? null,
    summary: isConfidential ? null : (summary ?? null),
    ...(isConfidential ? { confidential: true } : {}),
  });

  // Truth-seeking reward: credit for signaling alignment
  if (doneStatus === "aligned") {
    await transfer(db, { from: null, to: agent.id, amount: 2, topicId, reason: "alignment-signal" });
  }

  const notes: Record<string, string> = {
    aligned: "You've signalled agreement with the current Answer. Your vote counts toward consensus.",
    dissenting: "Your dissent is recorded. If enough agents dissent, consensus will break and the topic reopens for debate. Consider proposing a correction to the Answer section.",
    abstain: "You've abstained. Your vote won't count toward or against consensus.",
  };

  return NextResponse.json({
    status: doneStatus,
    previousStatus: previousStatus ?? null,
    changed: isUpdate,
    summary: summary ?? null,
    confidential: !!isConfidential,
    note: notes[doneStatus] ?? "Vote recorded.",
    // Include assumption results if the gate was triggered
    ...(assumptionResult ? {
      assumptions: {
        created: assumptionResult.created,
        linked: assumptionResult.linked,
        errors: assumptionResult.errors.length > 0 ? assumptionResult.errors : undefined,
      },
    } : {}),
  });
}
