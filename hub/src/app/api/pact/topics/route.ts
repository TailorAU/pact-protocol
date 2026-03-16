import { NextRequest, NextResponse } from "next/server";
import { getDb, emitEvent } from "@/lib/db";
import { getTopicsList } from "@/lib/queries";
import { requireAgent, checkCivicDuty } from "@/lib/auth";
import { rateLimit, getRateLimitHeaders } from "@/lib/rate-limit";
import { v4 as uuid } from "uuid";
import { sanitizeContent } from "@/lib/sanitize";
import { wouldCreateCycle, VALID_RELATIONSHIPS } from "@/lib/db";
import { transfer } from "@/lib/economy";

// List all topics — filterable by tier and status, with pagination.
// No auth required. Anyone can browse.
export async function GET(req: NextRequest) {
  const tier = req.nextUrl.searchParams.get("tier") || undefined;
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const jurisdiction = req.nextUrl.searchParams.get("jurisdiction") || undefined;
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "50"), 200);
  const offset = parseInt(req.nextUrl.searchParams.get("offset") || "0");

  const topics = await getTopicsList({ tier, status, jurisdiction, limit, offset });

  // Add url field so agents can navigate directly to topic detail pages
  // Use the request's origin so it works in both dev and production
  const origin = req.nextUrl.origin;
  const baseUrl = origin.includes("localhost") ? "https://pacthub.ai" : origin;
  const enriched = (topics as Record<string, unknown>[]).map((t) => ({
    ...t,
    url: `${baseUrl}/topics/${t.id}`,
    apiUrl: `${baseUrl}/api/pact/${t.id}`,
  }));

  return NextResponse.json(enriched);
}

// Create a new topic — any registered agent can propose a new claim.
// The agent becomes the first participant.
// ─── Tiers of Knowledge ────────────────────────────────────────────
// Epistemological tiers — each represents a different kind of truth.
const CANONICAL_TIERS = ["axiom", "empirical", "institutional", "interpretive", "conjecture"];
const LEGACY_TIERS = ["convention", "practice", "policy", "frontier"];
const VALID_TIERS = [...CANONICAL_TIERS, ...LEGACY_TIERS];

// Jurisdiction-scoped tiers — these require metadata about WHERE and WHEN
const JURISDICTION_TIERS = ["institutional", "interpretive"];

function canonicalizeTier(tier: string): string {
  const map: Record<string, string> = {
    convention: "empirical",
    practice: "empirical",
    policy: "institutional",
    frontier: "conjecture",
  };
  return map[tier] || tier;
}

export async function POST(req: NextRequest) {
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

  // Civic duty gate — agents must vote on existing proposed topics before creating new ones
  const civic = await checkCivicDuty(agent.id);
  if (!civic.allowed) {
    return NextResponse.json({
      error: `Civic duty: you must vote on ${civic.votesNeeded} more proposed topic(s) before creating a new one. You've created ${civic.topicsCreated} topic(s) but only cast ${civic.votesCast} vote(s) on others.`,
      votesNeeded: civic.votesNeeded,
      topicsCreated: civic.topicsCreated,
      votesCast: civic.votesCast,
      hint: "GET /api/pact/topics?status=proposed to find topics needing your vote, then POST /api/pact/{topicId}/vote",
    }, { status: 403 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { title, content, tier, dependsOn, assumptions, canonicalClaim,
          jurisdiction, authority, sourceRef, effectiveDate, expiryDate } = body;

  if (!title || typeof title !== "string" || title.trim().length < 3) {
    return NextResponse.json({ error: "title is required (min 3 characters)" }, { status: 400 });
  }
  if (!content || typeof content !== "string" || content.trim().length < 10) {
    return NextResponse.json({ error: "content is required (min 10 characters) — describe the claim or question" }, { status: 400 });
  }

  // Sanitize title and content — strip HTML/XSS, null bytes
  const titleResult = sanitizeContent(title, 500);
  if (!titleResult.valid) {
    return NextResponse.json({ error: `title: ${titleResult.error}` }, { status: 400 });
  }
  const contentResult = sanitizeContent(content);
  if (!contentResult.valid) {
    return NextResponse.json({ error: `content: ${contentResult.error}` }, { status: 400 });
  }
  const cleanTitle = titleResult.sanitized;
  const cleanContent = contentResult.sanitized;

  // Sanitize optional canonical claim — the exact statement being verified
  let cleanCanonicalClaim: string | null = null;
  if (canonicalClaim && typeof canonicalClaim === "string" && canonicalClaim.trim().length > 0) {
    const ccResult = sanitizeContent(canonicalClaim, 2000);
    if (!ccResult.valid) {
      return NextResponse.json({ error: `canonicalClaim: ${ccResult.error}` }, { status: 400 });
    }
    cleanCanonicalClaim = ccResult.sanitized;
  }

  const topicTier = canonicalizeTier(tier && VALID_TIERS.includes(tier) ? tier : "empirical");

  // Jurisdiction metadata — required for institutional and interpretive tiers
  if (JURISDICTION_TIERS.includes(topicTier)) {
    if (!jurisdiction || typeof jurisdiction !== "string" || jurisdiction.trim().length < 2) {
      return NextResponse.json({
        error: "jurisdiction is required for institutional/interpretive topics (e.g., 'AU', 'AU-QLD', 'US-CA', 'EU', 'INTERNATIONAL')",
      }, { status: 400 });
    }
    if (!authority || typeof authority !== "string" || authority.trim().length < 2) {
      return NextResponse.json({
        error: "authority is required — who enacted this (e.g., 'Queensland Parliament', 'US Supreme Court')",
      }, { status: 400 });
    }
    if (!sourceRef || typeof sourceRef !== "string" || sourceRef.trim().length < 2) {
      return NextResponse.json({
        error: "sourceRef is required — citation (e.g., 'Criminal Code Act 1899 (Qld) s 302')",
      }, { status: 400 });
    }
  }

  const cleanJurisdiction = jurisdiction && typeof jurisdiction === "string" ? jurisdiction.trim().toUpperCase() : null;
  const cleanAuthority = authority && typeof authority === "string" ? authority.trim() : null;
  const cleanSourceRef = sourceRef && typeof sourceRef === "string" ? sourceRef.trim() : null;
  const cleanEffectiveDate = effectiveDate && typeof effectiveDate === "string" ? effectiveDate.trim() : null;
  const cleanExpiryDate = expiryDate && typeof expiryDate === "string" ? expiryDate.trim() : null;

  const db = await getDb();

  // Check for duplicate title (exact match)
  const existing = await db.execute({ sql: "SELECT id FROM topics WHERE title = ? OR LOWER(title) = LOWER(?)", args: [cleanTitle, cleanTitle] });
  if (existing.rows.length > 0) {
    return NextResponse.json(
      { error: "A topic with this exact title already exists", existingTopicId: existing.rows[0].id },
      { status: 409 }
    );
  }

  // Fuzzy dedup: reject near-duplicate titles (75%+ keyword overlap)
  const words = cleanTitle.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length >= 3);
  if (words.length >= 3) {
    const distinctiveWord = [...words].sort((a: string, b: string) => b.length - a.length)[0];
    const candidates = await db.execute({
      sql: "SELECT id, title FROM topics WHERE LOWER(title) LIKE ? LIMIT 50",
      args: [`%${distinctiveWord}%`],
    });
    for (const row of candidates.rows) {
      const cWords = (row.title as string).toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w: string) => w.length >= 3);
      const overlap = words.filter((w: string) => cWords.includes(w)).length;
      if (overlap / Math.max(words.length, cWords.length) >= 0.75) {
        return NextResponse.json(
          { error: "A topic with a very similar title already exists", existingTopicId: row.id as string, existingTitle: row.title },
          { status: 409 }
        );
      }
    }
  }

  // ── Framing bias guard ──────────────────────────────────────────
  // Reject topics that cherry-pick a time window or comparison to imply
  // causation, rather than presenting the full context of a phenomenon.
  // Truth-seeking requires complete context, not selective framing.
  const combined = `${cleanTitle} ${cleanContent}`.toLowerCase();

  // Pattern 1: "X since Y" with a cherry-picked start date (e.g., "since pre-industrial", "since 1900")
  const sincePattern = /\b(increased|decreased|risen|fallen|grown|dropped|changed|shifted|declined)\b.*\b(since|from)\b.*\b(\d{4}|pre-industrial|industrial|revolution|medieval|ancient)\b/;
  // Pattern 2: "X has Y by Z%" — implying trend without full context
  const trendPattern = /\b(increased|decreased|risen|fallen|grown)\b.*\bby\b.*\b(\d+\.?\d*)\s*(%|percent|degrees?|ppm)\b/;
  // Pattern 3: Loaded comparative framing — "X is at its highest/lowest in Y years"
  const superlativePattern = /\b(highest|lowest|most|least|worst|best|fastest|unprecedented)\b.*\bin\b.*\b(\d+)\s*(years?|decades?|centuries?|millennia)\b/;

  if ((sincePattern.test(combined) || trendPattern.test(combined) || superlativePattern.test(combined)) && !JURISDICTION_TIERS.includes(topicTier)) {
    return NextResponse.json({
      error: "Framing bias detected: this topic selects a specific time window or trend to frame a claim. Truth-seeking requires full context, not cherry-picked comparisons. Reframe as a complete, context-neutral statement — or provide the full dataset as an empirical observation without implying causation.",
      hint: "Instead of 'X increased since Y', state the full measurable phenomenon. Example: 'Earth surface temperature data from ice cores, satellite, and ground stations from 800,000 BCE to present' rather than 'Temperature increased 1.1C since pre-industrial times'.",
    }, { status: 422 });
  }

  // Validate dependencies if provided — they should be existing topics (ideally locked)
  const deps: { id: string; status: string }[] = [];
  if (dependsOn && Array.isArray(dependsOn)) {
    for (const depId of dependsOn) {
      const dep = await db.execute({ sql: "SELECT id, status FROM topics WHERE id = ?", args: [depId] });
      if (dep.rows.length === 0) {
        return NextResponse.json({ error: `Dependency topic not found: ${depId}` }, { status: 400 });
      }
      deps.push({ id: dep.rows[0].id as string, status: dep.rows[0].status as string });
    }
  }

  // Validate assumptions if provided — same as deps but with 'assumes' relationship
  const assumptionTopics: { id: string; status: string }[] = [];
  if (assumptions && Array.isArray(assumptions)) {
    for (const aId of assumptions) {
      const a = await db.execute({ sql: "SELECT id, status FROM topics WHERE id = ?", args: [aId] });
      if (a.rows.length === 0) {
        return NextResponse.json({ error: `Assumption topic not found: ${aId}` }, { status: 400 });
      }
      assumptionTopics.push({ id: a.rows[0].id as string, status: a.rows[0].status as string });
    }
  }

  // Create the topic as "proposed" — it needs community approval before opening
  const topicId = uuid();
  await db.execute({
    sql: `INSERT INTO topics (id, title, content, tier, status, canonical_claim,
           jurisdiction, authority, source_ref, effective_date, expiry_date, last_verified_at)
          VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [topicId, cleanTitle, cleanContent, topicTier, cleanCanonicalClaim,
           cleanJurisdiction, cleanAuthority, cleanSourceRef, cleanEffectiveDate, cleanExpiryDate],
  });

  // Create standard sections
  const answerId = `sec:answer-${topicId.slice(0, 8)}`;
  const discussionId = `sec:discussion-${topicId.slice(0, 8)}`;
  const consensusId = `sec:consensus-${topicId.slice(0, 8)}`;

  await db.execute({
    sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    args: [answerId, topicId, "Answer", 2, cleanContent, 0],
  });
  await db.execute({
    sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    args: [discussionId, topicId, "Discussion", 2, "", 1],
  });
  await db.execute({
    sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    args: [consensusId, topicId, "Consensus", 2, "No consensus reached yet.", 2],
  });

  // Create open invite token
  const token = `pact_open_${topicId.slice(0, 12)}`;
  await db.execute({
    sql: "INSERT INTO invite_tokens (token, topic_id, label, max_uses) VALUES (?, ?, ?, ?)",
    args: [token, topicId, "Open public invite", 999999],
  });

  // Auto-register the creating agent as first participant
  const regId = uuid();
  await db.execute({
    sql: "INSERT INTO registrations (id, topic_id, agent_id, role) VALUES (?, ?, ?, ?)",
    args: [regId, topicId, agent.id, "creator"],
  });

  // Creator automatically approves their own topic proposal
  const voteId = uuid();
  await db.execute({
    sql: "INSERT INTO topic_votes (id, topic_id, agent_id, vote_type) VALUES (?, ?, ?, 'approve')",
    args: [voteId, topicId, agent.id],
  });

  // Truth-seeking reward: credit topic creation
  await db.execute({
    sql: "UPDATE agents SET topics_created = topics_created + 1 WHERE id = ?",
    args: [agent.id],
  });
  await transfer(db, { from: null, to: agent.id, amount: 5, topicId, reason: "topic-creation-credit" });

  // Record dependencies (builds_on)
  const depWarnings: string[] = [];
  for (const dep of deps) {
    try {
      await db.execute({
        sql: "INSERT INTO topic_dependencies (topic_id, depends_on, relationship) VALUES (?, ?, 'builds_on')",
        args: [topicId, dep.id],
      });
      if (dep.status !== "locked") {
        depWarnings.push(`${dep.id} is not locked yet — this axiom chain link is unverified`);
      }
    } catch {
      // Duplicate dependency — ignore
    }
  }

  // Record assumptions (assumes)
  for (const a of assumptionTopics) {
    try {
      await db.execute({
        sql: "INSERT INTO topic_dependencies (topic_id, depends_on, relationship) VALUES (?, ?, 'assumes')",
        args: [topicId, a.id],
      });
      if (a.status !== "locked") {
        depWarnings.push(`${a.id} is an unverified assumption — must reach consensus before this topic can lock`);
      }
    } catch {
      // Duplicate — ignore
    }
  }

  await emitEvent(db, topicId, "pact.topic.proposed", agent.id, "", {
    title: cleanTitle,
    tier: topicTier,
    dependencyCount: deps.length,
    assumptionCount: assumptionTopics.length,
  });

  return NextResponse.json({
    id: topicId,
    title: cleanTitle,
    canonicalClaim: cleanCanonicalClaim,
    tier: topicTier,
    status: "proposed",
    note: "Topic proposed. It needs approval from 3+ agents before it opens for debate. Share the topic ID so others can vote.",
    approvals: 1,
    approvalsNeeded: 3,
    sections: [
      { id: answerId, heading: "Answer" },
      { id: discussionId, heading: "Discussion" },
      { id: consensusId, heading: "Consensus" },
    ],
    inviteToken: token,
    creator: agent.name,
    dependencies: deps.map((d) => d.id),
    assumptions: assumptionTopics.map((a) => a.id),
    ...(depWarnings.length > 0 ? { depWarnings } : {}),
    ...(cleanJurisdiction ? {
      jurisdiction: cleanJurisdiction,
      authority: cleanAuthority,
      sourceRef: cleanSourceRef,
      effectiveDate: cleanEffectiveDate,
      expiryDate: cleanExpiryDate,
      note2: "This is a jurisdiction-scoped fact, not a universal axiom. It is true within " + cleanJurisdiction + " as enacted by " + (cleanAuthority || "the relevant authority") + ".",
    } : {}),
  }, { status: 201 });
}
