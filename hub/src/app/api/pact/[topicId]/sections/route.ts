import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ topicId: string }> }
) {
  const { topicId } = await params;
  const db = getDb();

  const sections = db.prepare(
    "SELECT id as sectionId, heading, level, content FROM sections WHERE topic_id = ? ORDER BY sort_order"
  ).all(topicId);

  return NextResponse.json(sections);
}
