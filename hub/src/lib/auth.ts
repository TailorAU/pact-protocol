import { getDb } from "./db";
import { NextRequest } from "next/server";

export function authenticateAgent(req: NextRequest): { id: string; name: string } | null {
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) return null;

  const db = getDb();
  const agent = db.prepare("SELECT id, name FROM agents WHERE api_key = ?").get(apiKey) as
    | { id: string; name: string }
    | undefined;

  return agent ?? null;
}

export function requireAgent(req: NextRequest): { id: string; name: string } {
  const agent = authenticateAgent(req);
  if (!agent) {
    throw new Error("Unauthorized");
  }
  return agent;
}
