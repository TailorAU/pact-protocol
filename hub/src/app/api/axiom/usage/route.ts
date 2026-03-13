import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireApiKey } from "@/lib/auth";

// GET /api/axiom/usage — Check API key balance and usage stats
// Free — does not deduct credits.
export async function GET(req: NextRequest) {
  let apiKey;
  try {
    apiKey = await requireApiKey(req);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unauthorized";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const db = await getDb();

  // Total queries made
  const totalResult = await db.execute({
    sql: "SELECT COUNT(*) as total FROM axiom_usage_logs WHERE api_key_id = ?",
    args: [apiKey.id],
  });
  const totalQueries = (totalResult.rows[0]?.total as number) || 0;

  // Queries in last 24 hours
  const recentResult = await db.execute({
    sql: `SELECT COUNT(*) as recent FROM axiom_usage_logs
          WHERE api_key_id = ? AND created_at > datetime('now', '-1 day')`,
    args: [apiKey.id],
  });
  const queriesLast24h = (recentResult.rows[0]?.recent as number) || 0;

  // Queries in last hour (for rate limit info)
  const hourResult = await db.execute({
    sql: `SELECT COUNT(*) as hourly FROM axiom_usage_logs
          WHERE api_key_id = ? AND created_at > datetime('now', '-1 hour')`,
    args: [apiKey.id],
  });
  const queriesLastHour = (hourResult.rows[0]?.hourly as number) || 0;

  // Most queried topics
  const topFactsResult = await db.execute({
    sql: `SELECT u.topic_id, COUNT(*) as queries, t.title, t.tier
          FROM axiom_usage_logs u
          LEFT JOIN topics t ON t.id = u.topic_id
          WHERE u.api_key_id = ? AND u.topic_id != 'list-query'
          GROUP BY u.topic_id
          ORDER BY queries DESC LIMIT 10`,
    args: [apiKey.id],
  });

  return NextResponse.json({
    keyId: apiKey.id,
    ownerName: apiKey.ownerName,
    creditBalance: apiKey.creditBalance,
    totalQueries,
    queriesLast24h,
    queriesLastHour,
    rateLimit: { limit: 60, window: "1 minute", remaining: Math.max(0, 60 - queriesLastHour) },
    topQueriedFacts: topFactsResult.rows.map((r) => ({
      factId: r.topic_id,
      title: r.title,
      tier: r.tier,
      queries: r.queries,
    })),
  });
}
