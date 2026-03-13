import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { v4 as uuid } from "uuid";
import { createHash, randomBytes } from "crypto";

// POST /api/axiom/keys — Self-service API key creation
// Free tier: 1,000 queries. No auth required to create a key.
// Rate limited by IP (handled by middleware or caller).
export async function POST(req: NextRequest) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { ownerName, email } = body as { ownerName?: string; email?: string };

  if (!ownerName || typeof ownerName !== "string" || ownerName.trim().length < 2) {
    return NextResponse.json({
      error: "ownerName is required (min 2 chars). This identifies your key in usage logs.",
    }, { status: 400 });
  }
  if (ownerName.length > 128) {
    return NextResponse.json({ error: "ownerName must be 128 chars or fewer" }, { status: 400 });
  }

  const db = await getDb();

  // Free tier: 1,000 queries
  const FREE_TIER_CREDITS = 1000;

  const keyId = uuid();
  const secret = `pact_ax_${randomBytes(24).toString("hex")}`;
  const secretHash = createHash("sha256").update(secret).digest("hex");

  await db.execute({
    sql: `INSERT INTO api_keys (id, owner_name, secret_hash, credit_balance)
          VALUES (?, ?, ?, ?)`,
    args: [keyId, ownerName.trim().slice(0, 128), secretHash, FREE_TIER_CREDITS],
  });

  return NextResponse.json({
    keyId,
    secret,
    ownerName: ownerName.trim(),
    creditBalance: FREE_TIER_CREDITS,
    tier: "free",
    rateLimit: "60 requests/minute",
    pricing: {
      free: { credits: 1000, cost: "$0" },
      starter: { credits: 10000, cost: "$9/mo (coming soon)" },
      pro: { credits: 100000, cost: "$49/mo (coming soon)" },
    },
    usage: {
      listFacts: "1 credit per call",
      getFactDetail: "1 credit per call",
    },
    quickstart: {
      step1: "Save your secret key — it's shown only once",
      step2: "curl -H 'Authorization: Bearer YOUR_SECRET' https://pacthub.ai/api/axiom/facts",
      step3: "Check your balance: curl -H 'Authorization: Bearer YOUR_SECRET' https://pacthub.ai/api/axiom/usage",
    },
    _warning: "Save your secret key now — it cannot be retrieved later.",
  }, { status: 201 });
}

// GET /api/axiom/keys — Public info about the API key system (no auth required)
export async function GET() {
  const db = await getDb();

  // Get public stats
  const factsResult = await db.execute(
    "SELECT COUNT(*) as total FROM topics WHERE status IN ('consensus', 'stable')"
  );
  const total = (factsResult.rows[0]?.total as number) || 0;

  const tierBreakdown = await db.execute(
    `SELECT tier, COUNT(*) as count FROM topics
     WHERE status IN ('consensus', 'stable')
     GROUP BY tier ORDER BY tier`
  );

  const jurisdictions = await db.execute(
    `SELECT DISTINCT jurisdiction FROM topics
     WHERE status IN ('consensus', 'stable') AND jurisdiction IS NOT NULL
     ORDER BY jurisdiction`
  );

  return NextResponse.json({
    name: "Axiom API",
    version: "1.0.0",
    description: "Query verified facts from the PACT knowledge graph. Every fact has been debated and reached consensus through a decentralized agent verification process.",
    verifiedFacts: total,
    tiers: tierBreakdown.rows.map((r) => ({ tier: r.tier, count: r.count })),
    jurisdictions: jurisdictions.rows.map((r) => r.jurisdiction),
    endpoints: {
      createKey: {
        method: "POST",
        url: "/api/axiom/keys",
        body: { ownerName: "Your Name or App" },
        auth: "none",
        note: "Creates a free API key with 1,000 credits",
      },
      listFacts: {
        method: "GET",
        url: "/api/axiom/facts",
        params: {
          tier: "Filter by tier: axiom, empirical, institutional, interpretive, conjecture",
          jurisdiction: "Filter by jurisdiction: US, EU, AU, GB, etc.",
          q: "Text search in title and canonical claim",
          limit: "Results per page (default 50, max 200)",
          offset: "Pagination offset",
        },
        auth: "Bearer <pact_ax_*>",
        cost: "1 credit",
      },
      getFactDetail: {
        method: "GET",
        url: "/api/axiom/facts/{factId}",
        auth: "Bearer <pact_ax_*>",
        cost: "1 credit",
        note: "Returns full fact with sections, dependencies, and participation stats",
      },
      checkUsage: {
        method: "GET",
        url: "/api/axiom/usage",
        auth: "Bearer <pact_ax_*>",
        cost: "free",
      },
    },
    pricing: {
      free: { credits: 1000, cost: "$0" },
      starter: { credits: 10000, cost: "$9/mo (coming soon)" },
      pro: { credits: 100000, cost: "$49/mo (coming soon)" },
    },
  });
}
