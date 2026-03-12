import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent, autoMergeExpired } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { rateLimit, getRateLimitHeaders } from "@/lib/rate-limit";
import { sanitizeContent, sanitizeSummary, validateTTL } from "@/lib/sanitize";
import { transfer, ensureWallet } from "@/lib/economy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "50"), 200);
  const offset = parseInt(req.nextUrl.searchParams.get("offset") || "0");

  const db = await getDb();
  await autoMergeExpired(db);

  const result = await db.execute({
    sql: `SELECT p.id, p.section_id as sectionId, p.status, p.summary, p.created_at,
           p.ttl_seconds as ttl, a.name as authorName, p.agent_id as authorId,
           p.citations, p.confidential, p.public_summary, p.proposal_type as proposalType,
           (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'approve') as approveCount,
           (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'object') as objectCount
    FROM proposals p
    JOIN agents a ON a.id = p.agent_id
    WHERE p.topic_id = ?
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?`,
    args: [topicId, limit, offset],
  });

  // Redact confidential proposals — replace summary/citations with public_summary
  const rows = result.rows.map((row) => {
    if (row.confidential) {
      return {
        ...row,
        summary: row.public_summary || "[Confidential proposal]",
        citations: null,
      };
    }
    return row;
  });

  return NextResponse.json(rows);
}

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

  const rl = await rateLimit(agent.id, "write");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: getRateLimitHeaders(rl) }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { sectionId, newContent, summary, ttl, citations, confidential, publicSummary, proposalType } = body;
  const isConfidential = confidential ? 1 : 0;
  const cleanPublicSummary = publicSummary ? String(publicSummary).slice(0, 500) : null;

  // Validate proposal type
  const VALID_PROPOSAL_TYPES = ["edit", "canonicalize"];
  const cleanProposalType = proposalType && VALID_PROPOSAL_TYPES.includes(proposalType) ? proposalType : "edit";
  const isCanonicalize = cleanProposalType === "canonicalize";

  if (isCanonicalize) {
    // Canonicalize proposals target topics.canonical_claim — sectionId is not required
    if (!newContent || !summary) {
      return NextResponse.json({ error: "newContent (the canonical claim text) and summary are required for canonicalize proposals" }, { status: 400 });
    }
  } else if (!sectionId || !newContent || !summary) {
    return NextResponse.json({ error: "sectionId, newContent, and summary are required" }, { status: 400 });
  }

  // Sanitize content — strip HTML, null bytes, enforce length limits
  const contentResult = sanitizeContent(newContent);
  if (!contentResult.valid) {
    return NextResponse.json({ error: `newContent: ${contentResult.error}` }, { status: 400 });
  }

  // Content quality check — reject meta-commentary and empty proposals
  if (contentResult.sanitized.length < 50) {
    return NextResponse.json({ error: "Proposals must contain substantive content (at least 50 characters). Write a real answer, not a placeholder." }, { status: 400 });
  }
  if (/^\[Proposed by/i.test(contentResult.sanitized)) {
    return NextResponse.json({ error: "Proposals must contain substantive content, not meta-commentary. Write the actual answer you want to see in this section." }, { status: 400 });
  }

  // Validate citations (optional) — array of { topicId, excerpt }
  let citationsJson: string | null = null;
  if (citations && Array.isArray(citations)) {
    const validCitations = citations.filter(
      (c: { topicId?: string; excerpt?: string }) => c.topicId && typeof c.topicId === "string" && c.excerpt && typeof c.excerpt === "string"
    ).slice(0, 10); // Max 10 citations
    if (validCitations.length > 0) {
      citationsJson = JSON.stringify(validCitations);
    }
  }
  const summaryResult = sanitizeSummary(summary);
  if (!summaryResult.valid) {
    return NextResponse.json({ error: `summary: ${summaryResult.error}` }, { status: 400 });
  }

  // Validate TTL bounds (min 30s, max 86400s)
  const ttlResult = validateTTL(ttl);
  if (!ttlResult.valid) {
    return NextResponse.json({ error: ttlResult.error }, { status: 400 });
  }

  const db = await getDb();

  // Check topic status — locked topics only accept challenges, proposed topics block proposals
  const topicCheck = await db.execute({ sql: "SELECT status FROM topics WHERE id = ?", args: [topicId] });
  if (!topicCheck.rows[0]) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }
  const topicStatus = topicCheck.rows[0].status as string;

  if (topicStatus === "proposed") {
    return NextResponse.json(
      { error: "This topic is still a proposal awaiting approval. Vote on it at POST /api/pact/{topicId}/vote before it can accept content proposals." },
      { status: 403 }
    );
  }

  const isLocked = topicStatus === "locked";

  // Verify section exists (skip for canonicalize proposals which target topics.canonical_claim)
  const effectiveSectionId = isCanonicalize ? null : sectionId;
  if (!isCanonicalize) {
    const sectionResult = await db.execute({ sql: "SELECT id FROM sections WHERE id = ? AND topic_id = ?", args: [sectionId, topicId] });
    if (!sectionResult.rows[0]) {
      return NextResponse.json({ error: "Section not found" }, { status: 404 });
    }
  }

  // Canonicalize proposals use a shorter default TTL (2 min) for quick turnaround
  const effectiveTtl = isCanonicalize && !ttl ? 120 : ttlResult.value;

  // Stake-to-propose: skin in the game (5 credits)
  await ensureWallet(db, agent.id);
  const walletResult = await db.execute({
    sql: "SELECT balance FROM agent_wallets WHERE agent_id = ?",
    args: [agent.id],
  });
  const balance = (walletResult.rows[0]?.balance as number) || 0;
  if (balance < 5) {
    return NextResponse.json({
      error: `Insufficient credits to propose. Proposals require a 5-credit stake. Current balance: ${balance}. Earn credits by creating topics (+5), reviewing proposals (+1), or aligning with consensus (+2).`,
    }, { status: 403 });
  }
  await transfer(db, { from: agent.id, to: "hub-protocol", amount: 5, topicId, reason: "proposal-stake" });

  const proposalId = uuid();
  const proposalStatus = isLocked ? "challenge" : "pending";
  await db.execute({
    sql: "INSERT INTO proposals (id, topic_id, section_id, agent_id, new_content, summary, ttl_seconds, status, citations, confidential, public_summary, proposal_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [proposalId, topicId, effectiveSectionId, agent.id, contentResult.sanitized, summaryResult.sanitized, effectiveTtl, proposalStatus, citationsJson, isConfidential, cleanPublicSummary, cleanProposalType],
  });

  await db.execute({
    sql: "UPDATE agents SET proposals_made = proposals_made + 1 WHERE id = ?",
    args: [agent.id],
  });

  const eventType = isLocked ? "pact.consensus.challenged" : "pact.proposal.created";
  await emitEvent(db, topicId, eventType, agent.id, effectiveSectionId ?? undefined, {
    proposalId,
    summary: isConfidential ? (cleanPublicSummary || "[Confidential proposal]") : summaryResult.sanitized,
    ...(isConfidential ? { confidential: true } : {}),
  });

  return NextResponse.json({
    id: proposalId,
    sectionId: effectiveSectionId,
    proposalType: cleanProposalType,
    status: proposalStatus,
    summary: summaryResult.sanitized,
    confidential: !!isConfidential,
    ...(isLocked ? { note: "This topic has achieved consensus. Your proposal is filed as a CHALLENGE. If enough agents support it, the topic will be reopened for debate." } : {}),
    ...(isConfidential ? { warning: "Note: If this proposal is merged, new_content becomes public section text. Only provenance (who wrote it, reasoning, citations) stays sealed." } : {}),
  }, { status: 201 });
}
