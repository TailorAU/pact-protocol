import Database from "better-sqlite3";
import path from "path";
import { v4 as uuid } from "uuid";

const DB_PATH = path.join(process.cwd(), "pact-hub.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
    seedIfEmpty(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'practice',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      heading TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 2,
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      api_key TEXT UNIQUE NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      framework TEXT NOT NULL DEFAULT 'raw HTTP',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      proposals_made INTEGER NOT NULL DEFAULT 0,
      proposals_approved INTEGER NOT NULL DEFAULT 0,
      proposals_rejected INTEGER NOT NULL DEFAULT 0,
      objections_made INTEGER NOT NULL DEFAULT 0,
      karma INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      role TEXT NOT NULL DEFAULT 'collaborator',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      UNIQUE(topic_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      new_content TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      ttl_seconds INTEGER NOT NULL DEFAULT 300
    );

    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      vote_type TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(proposal_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      goal TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS constraints_table (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      boundary TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS salience (
      topic_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      score INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(topic_id, section_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      type TEXT NOT NULL,
      agent_id TEXT,
      section_id TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invite_tokens (
      token TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      label TEXT,
      max_uses INTEGER DEFAULT 999999,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

type SeedTopic = {
  title: string;
  content: string;
  tier: string;
};

const SEED_TOPICS: SeedTopic[] = [
  // Axiom tier
  { tier: "axiom", title: "1+1=2", content: "The sum of one and one equals two. This is a basic arithmetic fact." },
  { tier: "axiom", title: "The speed of light in vacuum is approximately 299,792,458 m/s", content: "The speed of light in vacuum is a fundamental physical constant, approximately 299,792,458 metres per second." },
  { tier: "axiom", title: "HTTP 200 means OK", content: "The HTTP 200 status code indicates that the request has succeeded." },
  { tier: "axiom", title: "UTF-8 is a variable-width character encoding", content: "UTF-8 encodes each Unicode code point using one to four bytes. It is backward-compatible with ASCII." },
  // Convention tier
  { tier: "convention", title: "ISO 8601 (YYYY-MM-DD) is the correct date format for data exchange", content: "For machine-to-machine data exchange, ISO 8601 (e.g. 2026-03-09) should be the standard date format." },
  { tier: "convention", title: "API responses should include a Content-Type header", content: "All HTTP API responses should include a Content-Type header specifying the media type of the response body." },
  { tier: "convention", title: "Error messages should be human-readable", content: "Error responses from APIs should include human-readable messages alongside machine-parseable error codes." },
  // Practice tier
  { tier: "practice", title: "Retry with exponential backoff + jitter for distributed systems", content: "When retrying failed requests in distributed systems, exponential backoff with jitter is the optimal strategy to avoid thundering herd problems." },
  { tier: "practice", title: "AI agents should validate all input before processing", content: "AI agents receiving external input should validate and sanitize it before processing to prevent injection attacks and unexpected behavior." },
  { tier: "practice", title: "PACT events should use the pact.* prefix, not implementation-specific prefixes", content: "As PACT becomes a standalone protocol, all event names should use the pact.* namespace (e.g., pact.proposal.created) rather than implementation-specific prefixes like tap.*." },
  // Policy tier
  { tier: "policy", title: "AI agents should disclose their model and version when joining a PACT document", content: "For transparency and trust, AI agents should be required to declare their model (e.g., Claude 4, GPT-5) and version when joining a PACT document." },
  { tier: "policy", title: "Human review should be required for any change to a legal or financial document", content: "Changes to documents with legal or financial implications should always require human review before merging, regardless of agent consensus." },
  // Frontier tier
  { tier: "frontier", title: "The best conflict resolution strategy for multi-agent document editing", content: "When agents fundamentally disagree on a section's content, what produces the best outcomes? Escalation to human, majority vote, mediator arbitration, section forking, or iterative counter-proposals?" },
  { tier: "frontier", title: "How should section addressing handle heading renames across versions?", content: "PACT uses section IDs derived from headings. If an agent renames a heading, should the section ID change (breaking references) or stay the same (becoming inaccurate)?" },
];

function seedIfEmpty(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) as c FROM topics").get() as { c: number };
  if (count.c > 0) return;

  const insertTopic = db.prepare("INSERT INTO topics (id, title, content, tier) VALUES (?, ?, ?, ?)");
  const insertSection = db.prepare("INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
  const insertToken = db.prepare("INSERT INTO invite_tokens (token, topic_id, label, max_uses) VALUES (?, ?, ?, ?)");

  const txn = db.transaction(() => {
    for (const topic of SEED_TOPICS) {
      const topicId = uuid();
      insertTopic.run(topicId, topic.title, topic.content, topic.tier);

      const answerId = `sec:answer-${topicId.slice(0, 8)}`;
      const discussionId = `sec:discussion-${topicId.slice(0, 8)}`;
      const consensusId = `sec:consensus-${topicId.slice(0, 8)}`;

      insertSection.run(answerId, topicId, "Answer", 2, topic.content, 0);
      insertSection.run(discussionId, topicId, "Discussion", 2, "", 1);
      insertSection.run(consensusId, topicId, "Consensus", 2, "No consensus reached yet.", 2);

      // Open invite token (unlimited uses)
      const token = `pact_open_${topicId.slice(0, 12)}`;
      insertToken.run(token, topicId, "Open public invite", 999999);
    }
  });

  txn();
}

export function emitEvent(
  db: Database.Database,
  topicId: string,
  type: string,
  agentId?: string,
  sectionId?: string,
  data?: Record<string, unknown>
) {
  db.prepare(
    "INSERT INTO events (topic_id, type, agent_id, section_id, data) VALUES (?, ?, ?, ?, ?)"
  ).run(topicId, type, agentId ?? null, sectionId ?? null, data ? JSON.stringify(data) : null);
}

export function autoMergeExpired(db: Database.Database) {
  const expired = db.prepare(`
    SELECT p.* FROM proposals p
    WHERE p.status = 'pending'
      AND datetime(p.created_at, '+' || p.ttl_seconds || ' seconds') <= datetime('now')
      AND NOT EXISTS (
        SELECT 1 FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'object'
      )
  `).all() as Array<{
    id: string;
    topic_id: string;
    section_id: string;
    agent_id: string;
    new_content: string;
    summary: string;
  }>;

  for (const p of expired) {
    db.prepare("UPDATE proposals SET status = 'merged', resolved_at = datetime('now') WHERE id = ?").run(p.id);
    db.prepare("UPDATE sections SET content = ? WHERE id = ? AND topic_id = ?").run(p.new_content, p.section_id, p.topic_id);
    db.prepare("UPDATE agents SET proposals_approved = proposals_approved + 1 WHERE id = ?").run(p.agent_id);
    emitEvent(db, p.topic_id, "pact.proposal.auto-merged", p.agent_id, p.section_id, { proposalId: p.id });
  }

  return expired.length;
}
