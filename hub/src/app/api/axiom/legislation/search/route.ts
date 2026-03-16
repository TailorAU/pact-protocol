import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireApiKey, deductApiCredit } from "@/lib/auth";

// GET /api/axiom/legislation/search — Full-text search across all legislation
//
// Query params:
//   q             — Search query (required). Searches title, section content, section IDs.
//   jurisdiction  — Optional filter: "QLD", "CTH", "NSW", etc.
//   type          — Optional filter: "act", "regulation", "standard", "guidance"
//   status        — Optional section status filter: "in_force", "repealed", "not_yet_commenced"
//   limit/offset  — Pagination
//
// Auth: Requires Axiom API key. Costs 1 credit.
//
// Example: GET /api/axiom/legislation/search?q=assault&jurisdiction=QLD
export async function GET(req: NextRequest) {
  let apiKey;
  try {
    apiKey = await requireApiKey(req);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unauthorized";
    return NextResponse.json({ error: msg }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q");
  const jurisdiction = searchParams.get("jurisdiction");
  const docType = searchParams.get("type");
  const sectionStatus = searchParams.get("status");
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);
  const offset = parseInt(searchParams.get("offset") || "0");

  if (!query) {
    return NextResponse.json({
      error: "Missing required query parameter: q",
      example: "/api/axiom/legislation/search?q=assault&jurisdiction=QLD",
    }, { status: 400 });
  }

  // Tokenize query into keywords (3+ chars)
  const keywords = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3);

  if (keywords.length === 0) {
    return NextResponse.json({
      error: "Query too short. Please provide at least one word with 3+ characters.",
    }, { status: 400 });
  }

  const db = await getDb();

  // Build WHERE conditions for the main query
  const conditions: string[] = [];
  const args: unknown[] = [];

  // At least one keyword must match in section content, title, or section_id
  const keywordMatchParts: string[] = [];
  for (const kw of keywords) {
    const p = `%${kw}%`;
    keywordMatchParts.push(
      `(LOWER(ls.content) LIKE ? OR LOWER(COALESCE(ls.title, '')) LIKE ? OR LOWER(ls.section_id) LIKE ? OR LOWER(d.title) LIKE ?)`
    );
    args.push(p, p, p, p);
  }
  conditions.push(`(${keywordMatchParts.join(" OR ")})`);

  if (jurisdiction) {
    conditions.push("(d.jurisdiction = ? OR d.jurisdiction LIKE ? || '-%')");
    args.push(jurisdiction.toUpperCase(), jurisdiction.toUpperCase());
  }
  if (docType) {
    conditions.push("d.doc_type = ?");
    args.push(docType.toLowerCase());
  }
  if (sectionStatus) {
    conditions.push("ls.status = ?");
    args.push(sectionStatus);
  }

  const where = conditions.join(" AND ");

  // Count total matches
  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as total FROM legislation_sections ls JOIN legislation_docs d ON d.id = ls.doc_id WHERE ${where}`,
    args,
  });
  const total = (countResult.rows[0]?.total as number) || 0;

  // Fetch results — sorted by doc then sort_order
  const result = await db.execute({
    sql: `SELECT
      ls.id,
      ls.doc_id,
      ls.section_id,
      ls.title as section_title,
      ls.content,
      ls.depth,
      ls.status as section_status,
      ls.cross_references,
      ls.notes,
      d.title as doc_title,
      d.jurisdiction,
      d.doc_type,
      d.year,
      d.short_title,
      d.administered_by
    FROM legislation_sections ls
    JOIN legislation_docs d ON d.id = ls.doc_id
    WHERE ${where}
    ORDER BY d.title ASC, ls.sort_order ASC
    LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });

  // Deduct 1 credit
  await deductApiCredit(apiKey.id, "legislation-search");

  // Format results with highlighted matches
  const results = result.rows.map((row) => {
    let content = row.content as string;
    // Highlight keyword matches with ** markers
    for (const kw of keywords) {
      const regex = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      content = content.replace(regex, "**$1**");
    }

    // Simple relevance: count keyword hits
    const lowerContent = (row.content as string).toLowerCase();
    const lowerTitle = ((row.section_title as string) || "").toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lowerTitle.includes(kw)) score += 3;
      if ((row.section_id as string).toLowerCase().includes(kw)) score += 3;
      // Count occurrences in content
      let idx = -1;
      while ((idx = lowerContent.indexOf(kw, idx + 1)) !== -1) score += 1;
    }

    return {
      docId: row.doc_id,
      docTitle: row.doc_title,
      jurisdiction: row.jurisdiction,
      docType: row.doc_type,
      year: row.year,
      sectionId: row.section_id,
      sectionTitle: row.section_title || null,
      content,
      depth: row.depth,
      status: row.section_status,
      relevanceScore: score,
      crossReferences: row.cross_references ? JSON.parse(row.cross_references as string) : [],
      sourceRef: `${row.short_title || row.doc_title} ${row.section_id}`,
    };
  });

  // Sort by relevance score descending
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return NextResponse.json({
    results,
    query,
    keywords,
    total,
    limit,
    offset,
    creditsRemaining: apiKey.creditBalance - 1,
    _links: {
      self: `/api/axiom/legislation/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
      next: offset + limit < total
        ? `/api/axiom/legislation/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset + limit}`
        : null,
    },
  });
}
