import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireApiKey, deductApiCredit } from "@/lib/auth";

// GET /api/axiom/facts — Query verified facts (consensus or stable topics)
// Requires a valid Axiom API key (pact_ax_*).
// Each call costs 1 credit. Returns verified facts with optional filtering.
export async function GET(req: NextRequest) {
  let apiKey;
  try {
    apiKey = await requireApiKey(req);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unauthorized";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const tier = searchParams.get("tier"); // axiom, empirical, institutional, interpretive, conjecture
  const jurisdiction = searchParams.get("jurisdiction"); // US, EU, AU, etc.
  const search = searchParams.get("q"); // text search in title/canonical_claim
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const offset = parseInt(searchParams.get("offset") || "0");

  const db = await getDb();

  // Build WHERE clause separately so we can reuse it for count and select
  let where = "status IN ('consensus', 'stable')";
  const args: unknown[] = [];

  if (tier) {
    where += " AND tier = ?";
    args.push(tier);
  }
  if (jurisdiction) {
    where += " AND jurisdiction = ?";
    args.push(jurisdiction);
  }
  if (search) {
    where += " AND (title LIKE ? OR canonical_claim LIKE ?)";
    args.push(`%${search}%`, `%${search}%`);
  }

  // Get total count
  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as total FROM topics WHERE ${where}`,
    args,
  });
  const total = (countResult.rows[0]?.total as number) || 0;

  // Get paginated results
  const selectArgs = [...args, limit, offset];
  const result = await db.execute({
    sql: `SELECT id, title, canonical_claim, tier, status, jurisdiction, authority, source_ref,
      effective_date, expiry_date, last_verified_at, consensus_ratio, consensus_voters, consensus_since, created_at
      FROM topics WHERE ${where} ORDER BY tier ASC, title ASC LIMIT ? OFFSET ?`,
    args: selectArgs,
  });

  // Deduct 1 credit for this query
  await deductApiCredit(apiKey.id, "list-query");

  const facts = result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    canonicalClaim: row.canonical_claim,
    tier: row.tier,
    status: row.status,
    jurisdiction: row.jurisdiction || null,
    authority: row.authority || null,
    sourceRef: row.source_ref || null,
    effectiveDate: row.effective_date || null,
    expiryDate: row.expiry_date || null,
    lastVerifiedAt: row.last_verified_at || null,
    consensusRatio: row.consensus_ratio,
    consensusVoters: row.consensus_voters,
    consensusSince: row.consensus_since,
    createdAt: row.created_at,
  }));

  return NextResponse.json({
    facts,
    total,
    limit,
    offset,
    creditsRemaining: apiKey.creditBalance - 1,
    _links: {
      self: `/api/axiom/facts?limit=${limit}&offset=${offset}`,
      next: offset + limit < total ? `/api/axiom/facts?limit=${limit}&offset=${offset + limit}` : null,
    },
  });
}
