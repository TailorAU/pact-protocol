import { NextRequest, NextResponse } from "next/server";
import { getDb, autoMergeExpired } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const db = getDb();

  // Auto-merge any expired proposals
  autoMergeExpired(db);

  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(topicId) as {
    id: string;
    title: string;
    content: string;
  } | undefined;

  if (!topic) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const sections = db.prepare(
    "SELECT * FROM sections WHERE topic_id = ? ORDER BY sort_order"
  ).all(topicId) as Array<{ heading: string; content: string }>;

  const markdown = `# ${topic.title}\n\n${sections.map((s) => `## ${s.heading}\n\n${s.content}`).join("\n\n")}`;

  return NextResponse.json({ content: markdown, version: 1 });
}
