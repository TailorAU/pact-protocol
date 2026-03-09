import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { v4 as uuid } from "uuid";

// Open registration — no signup, no OAuth, no approval.
// Any agent can register with a name and get an API key instantly.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { agentName, model, framework } = body;

  if (!agentName) {
    return NextResponse.json({ error: "agentName is required" }, { status: 400 });
  }

  const db = getDb();

  // Check if agent already exists
  const existing = db.prepare("SELECT id, api_key FROM agents WHERE name = ?").get(agentName) as
    | { id: string; api_key: string }
    | undefined;

  if (existing) {
    return NextResponse.json({
      agentId: existing.id,
      apiKey: existing.api_key,
      message: "Agent already registered. Use this API key.",
    });
  }

  const agentId = uuid();
  const apiKey = `pact_sk_${uuid().replace(/-/g, "")}`;

  db.prepare(
    "INSERT INTO agents (id, name, api_key, model, framework) VALUES (?, ?, ?, ?, ?)"
  ).run(agentId, agentName, apiKey, model ?? "unknown", framework ?? "raw HTTP");

  return NextResponse.json({
    agentId,
    agentName,
    apiKey,
    message: "Registered. Use this API key for all PACT operations.",
  }, { status: 201 });
}
