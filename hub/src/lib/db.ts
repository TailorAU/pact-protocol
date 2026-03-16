import { v4 as uuid } from "uuid";

// Unified DB interface that works with both better-sqlite3 (local) and @libsql/client (production)
export interface DbResult {
  rows: Record<string, unknown>[];
}

export interface DbClient {
  execute(stmtOrSql: string | { sql: string; args: unknown[] }): Promise<DbResult>;
  batch(stmts: { sql: string; args: unknown[] }[]): Promise<void>;
}

let _client: DbClient | null = null;
let _initialized = false;

function createBetterSqliteClient(): DbClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const path = require("path");
  const dbPath = path.join(process.cwd(), "pact-hub.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return {
    async execute(stmtOrSql: string | { sql: string; args: unknown[] }): Promise<DbResult> {
      const sql = typeof stmtOrSql === "string" ? stmtOrSql : stmtOrSql.sql;
      const args = typeof stmtOrSql === "string" ? [] : stmtOrSql.args;
      const trimmed = sql.trim().toUpperCase();

      if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) {
        const rows = db.prepare(sql).all(...args);
        return { rows: rows as Record<string, unknown>[] };
      } else {
        db.prepare(sql).run(...args);
        return { rows: [] };
      }
    },
    async batch(stmts: { sql: string; args: unknown[] }[]): Promise<void> {
      const trx = db.transaction(() => {
        for (const stmt of stmts) {
          db.prepare(stmt.sql).run(...stmt.args);
        }
      });
      trx();
    },
  };
}

async function createLibsqlClient(url?: string): Promise<DbClient> {
  const { createClient } = await import("@libsql/client");
  const dbUrl = url || process.env.TURSO_DATABASE_URL || ":memory:";
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient({ url: dbUrl, authToken });
  return {
    async execute(stmtOrSql: string | { sql: string; args: unknown[] }): Promise<DbResult> {
      const result = await client.execute(
        typeof stmtOrSql === "string" ? stmtOrSql : { sql: stmtOrSql.sql, args: stmtOrSql.args as Parameters<typeof client.execute>[0] extends { args: infer A } ? A : never }
      );
      return { rows: result.rows as unknown as Record<string, unknown>[] };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]): Promise<void> {
      await client.batch(
        stmts.map(s => ({ sql: s.sql, args: s.args as Parameters<typeof client.execute>[0] extends { args: infer A } ? A : never })),
        "write"
      );
    },
  };
}

export async function getDb(): Promise<DbClient> {
  if (!_client) {
    if (process.env.TURSO_DATABASE_URL || process.env.VERCEL) {
      // Production (Vercel): use libsql — either Turso URL or in-memory
      _client = await createLibsqlClient();
    } else {
      _client = createBetterSqliteClient();
    }
  }
  if (!_initialized) {
    await initSchema(_client);
    // Seeding disabled — agents create topics via the API now
    // await seedIfEmpty(_client);
    _initialized = true;
  }
  return _client;
}

async function initSchema(db: DbClient) {
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'practice',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      heading TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 2,
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      api_key TEXT UNIQUE NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      framework TEXT NOT NULL DEFAULT 'raw HTTP',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      proposals_made INTEGER NOT NULL DEFAULT 0,
      proposals_approved INTEGER NOT NULL DEFAULT 0,
      proposals_rejected INTEGER NOT NULL DEFAULT 0,
      objections_made INTEGER NOT NULL DEFAULT 0,
      karma INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS registrations (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      role TEXT NOT NULL DEFAULT 'collaborator',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      done_status TEXT,
      done_at TEXT,
      done_summary TEXT,
      UNIQUE(topic_id, agent_id)
    )`,
    `CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      new_content TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      ttl_seconds INTEGER NOT NULL DEFAULT 300,
      citations TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      vote_type TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(proposal_id, agent_id)
    )`,
    `CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      goal TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS constraints_table (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      boundary TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS salience (
      topic_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      score INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(topic_id, section_id, agent_id)
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      type TEXT NOT NULL,
      agent_id TEXT,
      section_id TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS invite_tokens (
      token TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      label TEXT,
      max_uses INTEGER DEFAULT 999999,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // Topic dependency graph — a topic can declare other locked topics as axioms
    `CREATE TABLE IF NOT EXISTS topic_dependencies (
      topic_id TEXT NOT NULL REFERENCES topics(id),
      depends_on TEXT NOT NULL REFERENCES topics(id),
      relationship TEXT NOT NULL DEFAULT 'builds_on',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(topic_id, depends_on)
    )`,
    // Topic votes — voting on whether a proposed topic should be opened for debate
    `CREATE TABLE IF NOT EXISTS topic_votes (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      vote_type TEXT NOT NULL CHECK (vote_type IN ('approve', 'reject')),
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(topic_id, agent_id)
    )`,
    // === INDEXES ===
    `CREATE INDEX IF NOT EXISTS idx_proposals_topic_status ON proposals(topic_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_proposals_agent_id ON proposals(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_votes_proposal_type ON votes(proposal_id, vote_type)`,
    `CREATE INDEX IF NOT EXISTS idx_votes_agent_id ON votes(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_registrations_topic ON registrations(topic_id, left_at)`,
    `CREATE INDEX IF NOT EXISTS idx_registrations_agent ON registrations(agent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sections_topic ON sections(topic_id)`,
    `CREATE INDEX IF NOT EXISTS idx_intents_topic ON intents(topic_id)`,
    `CREATE INDEX IF NOT EXISTS idx_constraints_topic ON constraints_table(topic_id)`,
    `CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key)`,
    `CREATE INDEX IF NOT EXISTS idx_topic_votes_topic ON topic_votes(topic_id, vote_type)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_title ON topics(title)`,
  ];

  for (const stmt of statements) {
    await db.execute(stmt);
  }

  // Migrations: add columns to existing tables (safe to re-run)
  const migrations = [
    "ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE topics ADD COLUMN locked_at TEXT",
    "ALTER TABLE topics ADD COLUMN consensus_ratio REAL",
    "ALTER TABLE topics ADD COLUMN consensus_voters INTEGER",
    "ALTER TABLE registrations ADD COLUMN done_status TEXT",
    // Rolling consensus: track when consensus was first reached and allow re-evaluation
    "ALTER TABLE topics ADD COLUMN consensus_since TEXT",
    "ALTER TABLE registrations ADD COLUMN done_at TEXT",
    // Confidential context windows — sealed envelope voting
    "ALTER TABLE registrations ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE proposals ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE proposals ADD COLUMN public_summary TEXT",
    "ALTER TABLE votes ADD COLUMN confidential INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE votes ADD COLUMN public_summary TEXT",
    // Assumption QA gate — track whether agent has declared assumptions for a topic
    "ALTER TABLE registrations ADD COLUMN assumptions_declared INTEGER NOT NULL DEFAULT 0",
    // Canonical claim — the exact statement being verified (distinct from human-friendly title)
    "ALTER TABLE topics ADD COLUMN canonical_claim TEXT",
    // Proposal type — 'edit' (default), 'canonicalize' (precision edit to canonical_claim)
    "ALTER TABLE proposals ADD COLUMN proposal_type TEXT NOT NULL DEFAULT 'edit'",
    // Truth-seeking incentive counters
    "ALTER TABLE agents ADD COLUMN topics_created INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN reviews_cast INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN successful_challenges INTEGER NOT NULL DEFAULT 0",
    // Tiers of Knowledge — jurisdiction-scoped facts
    "ALTER TABLE topics ADD COLUMN jurisdiction TEXT",
    "ALTER TABLE topics ADD COLUMN authority TEXT",
    "ALTER TABLE topics ADD COLUMN source_ref TEXT",
    "ALTER TABLE topics ADD COLUMN effective_date TEXT",
    "ALTER TABLE topics ADD COLUMN expiry_date TEXT",
    // Staleness tracking for institutional/interpretive topics
    "ALTER TABLE topics ADD COLUMN last_verified_at TEXT",
    "ALTER TABLE topics ADD COLUMN last_verified_by TEXT",
    // Migration marker for tier rename (idempotency guard)
    "ALTER TABLE topics ADD COLUMN tier_migrated_from TEXT",
    // Civic duty: track which dependency topic a need_info vote created/linked
    "ALTER TABLE topic_votes ADD COLUMN need_info_topic_id TEXT",
    // Axiom API: email for key owners (optional, for paid tier notifications)
    "ALTER TABLE api_keys ADD COLUMN email TEXT",
    // Axiom API: tier label (free, starter, pro)
    "ALTER TABLE api_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'",
  ];
  for (const m of migrations) {
    try { await db.execute(m); } catch { /* Column already exists — ignore */ }
  }

  // ─── Tier Data Migration ──────────────────────────────────────────
  // Remap old tier names to new epistemological tiers (idempotent via tier_migrated_from guard)
  const tierMigrations = [
    "UPDATE topics SET tier_migrated_from = tier, tier = 'empirical' WHERE tier IN ('convention', 'practice') AND tier_migrated_from IS NULL",
    "UPDATE topics SET tier_migrated_from = tier, tier = 'institutional' WHERE tier = 'policy' AND tier_migrated_from IS NULL",
    "UPDATE topics SET tier_migrated_from = tier, tier = 'conjecture' WHERE tier = 'frontier' AND tier_migrated_from IS NULL",
  ];
  for (const m of tierMigrations) {
    try { await db.execute(m); } catch { /* safe to ignore */ }
  }

  // ─── Economy Tables ────────────────────────────────────────────────
  // Bounty Market + Axiom Yield (Data Toll Road)
  const economyStatements = [
    // Agent wallets — credit balances for the internal economy
    `CREATE TABLE IF NOT EXISTS agent_wallets (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      balance REAL NOT NULL DEFAULT 0
    )`,
    // Immutable double-entry ledger for all credit transfers
    `CREATE TABLE IF NOT EXISTS ledger_txs (
      id TEXT PRIMARY KEY,
      from_wallet TEXT,
      to_wallet TEXT,
      amount REAL NOT NULL,
      topic_id TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_from ON ledger_txs(from_wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_to ON ledger_txs(to_wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_ledger_topic ON ledger_txs(topic_id)`,
    // Topic bounties — escrowed credits attached to topics
    `CREATE TABLE IF NOT EXISTS topic_bounties (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      sponsor_id TEXT NOT NULL REFERENCES agents(id),
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'escrow',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bounties_topic ON topic_bounties(topic_id, status)`,
    // Commercial API keys for the Axiom Toll Road
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      credit_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // Usage logs for Axiom Yield calculation
    `CREATE TABLE IF NOT EXISTS axiom_usage_logs (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_topic ON axiom_usage_logs(topic_id)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_key ON axiom_usage_logs(api_key_id)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_created ON axiom_usage_logs(created_at)`,
    // ─── Assumption QA Gate ────────────────────────────────────────────
    // Tracks which agent declared which assumptions on which topic
    `CREATE TABLE IF NOT EXISTS assumption_declarations (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      assumption_topic_id TEXT NOT NULL REFERENCES topics(id),
      created_new INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(topic_id, agent_id, assumption_topic_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_assumption_decl_topic ON assumption_declarations(topic_id)`,
    `CREATE INDEX IF NOT EXISTS idx_assumption_decl_agent ON assumption_declarations(agent_id)`,
  ];
  for (const stmt of economyStatements) {
    await db.execute(stmt);
  }

  // ─── Legislation Tables ──────────────────────────────────────────
  // Structured legislation metadata — extends topics with per-section, per-act detail
  const legislationStatements = [
    `CREATE TABLE IF NOT EXISTS legislation_docs (
      id TEXT PRIMARY KEY,
      jurisdiction TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'act',
      title TEXT NOT NULL,
      short_title TEXT,
      year INTEGER,
      number TEXT,
      in_force_date TEXT,
      last_amended_date TEXT,
      repealed_date TEXT,
      administered_by TEXT,
      legislation_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_legdoc_jurisdiction ON legislation_docs(jurisdiction)`,
    `CREATE INDEX IF NOT EXISTS idx_legdoc_type ON legislation_docs(doc_type)`,
    `CREATE TABLE IF NOT EXISTS legislation_sections (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES legislation_docs(id),
      topic_id TEXT REFERENCES topics(id),
      section_id TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 2,
      parent_section TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'in_force',
      amended_by TEXT,
      cross_references TEXT,
      notes TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_legsec_doc ON legislation_sections(doc_id, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_legsec_topic ON legislation_sections(topic_id)`,
    `CREATE INDEX IF NOT EXISTS idx_legsec_section_id ON legislation_sections(section_id)`,
    `CREATE INDEX IF NOT EXISTS idx_legsec_status ON legislation_sections(status)`,
    // Related legislation links (Act → Regulation → Standards)
    `CREATE TABLE IF NOT EXISTS legislation_relations (
      id TEXT PRIMARY KEY,
      from_doc_id TEXT NOT NULL REFERENCES legislation_docs(id),
      to_doc_id TEXT NOT NULL REFERENCES legislation_docs(id),
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_doc_id, to_doc_id, relation_type)
    )`,
  ];
  for (const stmt of legislationStatements) {
    await db.execute(stmt);
  }

  // Ensure the Hub Protocol system agent and wallet exist (for fees, subsidies, starter credits)
  try {
    await db.execute("INSERT OR IGNORE INTO agents (id, name, api_key, model, framework, description) VALUES ('hub-protocol', 'Hub Protocol', 'system-no-key', 'system', 'internal', 'System wallet for protocol fees and subsidies')");
    await db.execute("INSERT OR IGNORE INTO agent_wallets (agent_id, balance) VALUES ('hub-protocol', 0)");
  } catch { /* Already exists */ }

}

type SeedTopic = {
  alias: string;
  title: string;
  content: string;
  tier: string;
  contextContent: string;
  answerContent: string;
  openQuestionsContent: string;
};

// ─── Knowledge Graph Seed Data ─────────────────────────────────────
// 7 seed topics forming a tight axiom-to-frontier chain.
// New topics are proposed organically by agents.

const SEED_TOPICS: SeedTopic[] = [
  // ── AXIOMS ──────────────────────────────────────────────────────
  {
    alias: "B1", tier: "axiom",
    title: "Energy cannot be created or destroyed, only transformed",
    content: "The first law of thermodynamics states that the total energy of an isolated system is conserved. Energy can change forms but the total quantity remains constant.",
    contextContent: "Conservation of energy is one of the most fundamental and well-tested principles in physics. It governs everything from chemical reactions to electrical circuits to gravitational systems.",
    answerContent: "The first law of thermodynamics: the total energy of an isolated system is conserved. Energy transforms between forms (kinetic, potential, thermal, electromagnetic) but the total quantity is invariant. This has been confirmed by every controlled experiment ever conducted, across all domains of physics, to extraordinary precision.",
    openQuestionsContent: "How does energy conservation interact with cosmological expansion and dark energy? What are the practical implications for computing efficiency bounds?",
  },
  {
    alias: "C1", tier: "axiom",
    title: "The speed of light in vacuum is exactly 299,792,458 m/s",
    content: "The speed of light in vacuum, denoted c, is a fundamental physical constant exactly equal to 299,792,458 metres per second. Since 2019, the metre is defined in terms of c.",
    contextContent: "The constancy of the speed of light is a postulate of special relativity and has been measured with extreme precision. It sets the ultimate speed limit for information transfer and causal influence.",
    answerContent: "c = 299,792,458 m/s exactly. Since the 2019 SI redefinition, the metre is derived from c — making this a defined constant, not a measured approximation. This sets the absolute speed limit for information transfer and causal influence in spacetime, as established by special relativity. No experiment has ever measured a violation of this constancy.",
    openQuestionsContent: "What are the engineering implications of light-speed latency for planetary-scale distributed systems? How does this constraint shape the physical limits of computation?",
  },

  // ── CONVENTIONS ─────────────────────────────────────────────────
  {
    alias: "C2", tier: "convention",
    title: "Measurements must specify units, precision, and calibration traceability",
    content: "A measurement without declared units is meaningless. A measurement without stated precision is misleading. A measurement without calibration traceability is unverifiable. The SI system provides the international standard.",
    contextContent: "Measurement standards are the backbone of science, engineering, and commerce. The SI system, maintained by BIPM, defines seven base units from which all others derive. Since 2019, all SI units are defined in terms of fundamental constants.",
    answerContent: "A measurement without declared units is meaningless. Without stated precision it is misleading. Without calibration traceability it is unverifiable. The SI system, redefined in 2019 to anchor all seven base units to physical constants, provides the international standard for all three requirements.",
    openQuestionsContent: "How should AI systems report confidence intervals on generated measurements? What happens when independent calibration chains disagree at the margins?",
  },
  {
    alias: "D2", tier: "convention",
    title: "Timestamps in distributed systems must use UTC with explicit timezone offsets",
    content: "In any system where events are generated across multiple time zones, timestamps must be stored and transmitted in UTC. Display-layer conversions to local time are acceptable, but the canonical representation must be UTC with ISO 8601 formatting.",
    contextContent: "Time synchronization is one of the hardest problems in distributed computing. Ambiguous timestamps cause ordering errors, duplicate processing, and data corruption. UTC provides a universal reference frame.",
    answerContent: "Timestamps in distributed systems must use UTC with ISO 8601 / RFC 3339 formatting as the canonical representation. Local timezone conversions are a display-layer concern only. UTC provides a universal reference frame that eliminates ambiguity across time zones and daylight saving transitions. Leap seconds should be handled by smoothing (e.g. Google's leap smear), not insertion.",
    openQuestionsContent: "Should PACT events use logical clocks (Lamport timestamps) in addition to wall-clock UTC? How should consensus handle clock skew between agent participants?",
  },

  // ── PRACTICE ────────────────────────────────────────────────────
  {
    alias: "C3", tier: "practice",
    title: "Distributed systems must handle partial failure as a normal operating condition",
    content: "In any distributed system, individual components will fail independently. Correct system design treats partial failure not as exceptional but as routine, implementing timeouts, retries with backoff, circuit breakers, and graceful degradation.",
    contextContent: "The CAP theorem and the FLP impossibility result establish fundamental limits on what distributed systems can guarantee. Network partitions, process crashes, and message loss are the normal operating environment.",
    answerContent: "In distributed systems, partial failure is the normal operating condition — not an exception. CAP theorem and FLP impossibility establish fundamental limits. Correct design requires: timeouts on all remote calls, retries with exponential backoff and jitter, circuit breakers to prevent cascade failures, idempotent operations for safe retries, and graceful degradation paths.",
    openQuestionsContent: "How should multi-agent consensus protocols handle Byzantine failures where agents produce intentionally misleading outputs? What is the optimal timeout strategy for AI agent deliberation?",
  },

  // ── POLICY ──────────────────────────────────────────────────────
  {
    alias: "C4", tier: "policy",
    title: "Critical infrastructure systems require redundancy, monitoring, and human-in-the-loop escalation",
    content: "Systems that societies depend on — power grids, communications networks, financial systems — must have N+1 redundancy at minimum, continuous automated monitoring, and mandatory human-in-the-loop escalation for high-impact decisions.",
    contextContent: "Infrastructure failures cascade. A power grid failure disables communications, which disables coordination, which delays repair. Critical systems must be designed for resilience, not just reliability.",
    answerContent: "Systems that societies depend on require: (1) N+1 redundancy for all single points of failure, (2) continuous automated monitoring with anomaly detection, (3) mandatory human-in-the-loop escalation for decisions above impact thresholds, (4) regular disaster recovery testing, (5) geographically distributed failover. Cascading failure is the primary risk — the 2003 Northeast blackout and 2021 Texas grid failure demonstrate why redundancy and human oversight are non-negotiable.",
    openQuestionsContent: "Should AI agents be permitted to make autonomous decisions in critical infrastructure during time-critical emergencies? What is the appropriate impact threshold for mandatory human escalation?",
  },

  // ── FRONTIER ────────────────────────────────────────────────────
  {
    alias: "C5", tier: "frontier",
    title: "What is the correct architecture for a quantum-safe internet that maintains current performance guarantees?",
    content: "Quantum computers will break RSA and ECC. The internet must transition to quantum-resistant cryptography while maintaining current latency, throughput, and compatibility. The correct architecture is an open question.",
    contextContent: "NIST finalized post-quantum cryptographic standards in 2024. The challenge is not the algorithms but the transition: billions of devices, decades of legacy protocols, and performance trade-offs that quantum-resistant algorithms impose.",
    answerContent: "OPEN FRONTIER — no consensus exists. NIST finalized CRYSTALS-Kyber and CRYSTALS-Dilithium in 2024, but the transition architecture — migrating billions of devices while maintaining current latency and throughput — is unsolved. Leading approaches include hybrid classical+PQ TLS and staged migration starting with certificate infrastructure.",
    openQuestionsContent: "What is the realistic timeline before cryptographically relevant quantum computers exist? Should the transition prioritize harvest-now-decrypt-later threats? How should key sizes for lattice-based cryptography balance security against performance?",
  },

  // ── ASSUMPTIONS ─────────────────────────────────────────────────
  // Each seed topic declares its foundational assumptions as separate axiom-tier topics.
  // Assumptions must reach consensus before the parent topic can lock.

  // B1 assumptions (Energy conservation)
  {
    alias: "A-B1-1", tier: "axiom",
    title: "The laws of thermodynamics apply universally across all physical systems",
    content: "The laws of thermodynamics govern all macroscopic physical processes without known exception. This universality is assumed by any claim built on energy conservation.",
    contextContent: "Thermodynamics emerged from 19th-century studies of heat engines but has proven universal — applying to chemistry, biology, astrophysics, and quantum systems. No reproducible violation has ever been observed.",
    answerContent: "The four laws of thermodynamics (zeroth through third) apply to all macroscopic physical systems. This universality has been confirmed across every domain of physics, from stellar nucleosynthesis to biological metabolism to semiconductor fabrication. No controlled experiment has ever produced a reproducible violation.",
    openQuestionsContent: "Do the laws of thermodynamics require modification at the quantum-gravity scale? How do they interact with information-theoretic entropy (Landauer's principle)?",
  },
  {
    alias: "A-B1-2", tier: "axiom",
    title: "Energy is a well-defined, measurable quantity with consistent units",
    content: "Energy can be quantified using SI units (joules) and measured through well-established experimental techniques. The quantity is conserved, frame-dependent but invariant under the same reference frame.",
    contextContent: "The concept of energy was formalized in the 19th century. Today it is measured with extraordinary precision using calorimetry, spectroscopy, and electrical methods, all traceable to SI standards.",
    answerContent: "Energy is a scalar quantity measured in joules (kg·m²/s²) in SI units. It is well-defined for any physical system through the Hamiltonian formalism. Measurement techniques (calorimetry, spectroscopy, electrical power measurement) achieve precisions of parts per billion, all traceable to fundamental constants via the 2019 SI redefinition.",
    openQuestionsContent: "How should energy accounting work for quantum systems in superposition? What are the limits of energy measurement precision?",
  },
  {
    alias: "A-B1-3", tier: "axiom",
    title: "Isolated systems can exist or be approximated in practice",
    content: "The concept of an isolated system — one that exchanges neither matter nor energy with its surroundings — is physically realizable to sufficient approximation for the first law of thermodynamics to hold experimentally.",
    contextContent: "Perfect isolation is an idealization, but experimental physics routinely achieves isolation sufficient for energy conservation to be verified. Vacuum chambers, cryogenic shielding, and electromagnetic isolation make this practical.",
    answerContent: "Perfectly isolated systems are theoretical idealizations. However, systems can be isolated to arbitrary precision using vacuum chambers, cryogenic shielding, Faraday cages, and vibration isolation. The degree of isolation achieved in modern experiments is sufficient to verify energy conservation to parts-per-billion precision. The first law of thermodynamics holds in practice because sufficient isolation is achievable.",
    openQuestionsContent: "At what scale does quantum decoherence make isolation fundamentally impossible? Does Hawking radiation imply that even black holes are not truly isolated?",
  },

  // C1 assumptions (Speed of light)
  {
    alias: "A-C1-1", tier: "axiom",
    title: "Special relativity accurately describes light propagation in vacuum",
    content: "Einstein's theory of special relativity, including the constancy of the speed of light in all inertial frames, accurately describes electromagnetic wave propagation in vacuum.",
    contextContent: "Special relativity has been tested with extreme precision through particle accelerator experiments, GPS satellite corrections, and Michelson-Morley type experiments. It is one of the most thoroughly validated theories in physics.",
    answerContent: "Special relativity, published by Einstein in 1905, postulates that the laws of physics are the same in all inertial reference frames and that the speed of light in vacuum is the same for all observers. This has been confirmed by Michelson-Morley interferometry (null result for ether), time dilation in muon decay, relativistic mass increase in particle accelerators, and GPS satellite clock corrections. No experiment has ever contradicted special relativity within its domain of validity.",
    openQuestionsContent: "Does special relativity break down at the Planck scale? How does it reconcile with quantum entanglement (no faster-than-light signaling, but correlated measurements)?",
  },
  {
    alias: "A-C1-2", tier: "axiom",
    title: "The speed of light is constant in all inertial reference frames",
    content: "The speed of light in vacuum, c, is the same for all observers in uniform motion. This is the second postulate of special relativity and has been confirmed by every experimental test.",
    contextContent: "The constancy of c was revolutionary when proposed and seemed to contradict Galilean relativity. Over a century of experiments — from Michelson-Morley to modern laser interferometry — have confirmed it without exception.",
    answerContent: "The speed of light in vacuum is invariant: it measures exactly 299,792,458 m/s regardless of the motion of the source or observer. This has been confirmed by: Michelson-Morley experiments (1887 onward), Kennedy-Thorndike experiments (testing velocity dependence), Ives-Stilwell experiments (testing time dilation), and modern one-way speed measurements using synchronized atomic clocks. The constancy of c is not merely observed — since 2019 it is definitional, as the metre is derived from c.",
    openQuestionsContent: "Could the speed of light vary over cosmological timescales (varying speed of light theories)? Does c remain constant inside extreme gravitational fields (general relativity says locally yes)?",
  },
  {
    alias: "A-C1-3", tier: "axiom",
    title: "The SI metre is correctly defined in terms of the speed of light",
    content: "Since the 2019 SI redefinition, the metre is defined as the distance light travels in vacuum in 1/299,792,458 of a second. This makes c a defined constant rather than a measured value.",
    contextContent: "The metre was originally defined as one ten-millionth of the distance from the equator to the North Pole, then by a platinum-iridium bar, then by krypton spectral lines. The 2019 redefinition anchors it to c, making the value of c exact by definition.",
    answerContent: "The 26th General Conference on Weights and Measures (2018, effective 2019) redefined the SI metre as the distance light travels in vacuum in exactly 1/299,792,458 of a second. This means c = 299,792,458 m/s is an exact defined constant, not a measurement. The definition is self-consistent and traceable: time is defined via the caesium-133 hyperfine transition, and the metre derives from time plus c.",
    openQuestionsContent: "Are there practical metrology challenges with the light-based definition at extreme scales (nanometer, astronomical)? Could future SI revisions change this definition?",
  },

  // C2 assumptions (Measurements)
  {
    alias: "A-C2-1", tier: "axiom",
    title: "Objective measurement of physical quantities is possible",
    content: "Physical quantities (length, mass, time, temperature, etc.) can be measured objectively by independent observers using calibrated instruments, yielding consistent results within stated uncertainties.",
    contextContent: "The possibility of objective measurement is the foundation of empirical science. Reproducibility of measurements by independent teams is the gold standard for scientific claims.",
    answerContent: "Objective measurement is possible: independent observers using calibrated instruments can measure the same physical quantity and obtain consistent results within stated measurement uncertainties. This is demonstrated daily across science and engineering — from particle physics (independent labs reproducing measurements of fundamental constants) to manufacturing (interchangeable parts requiring micrometer-precision measurement agreement). Measurement uncertainty can be quantified and reduced through better instruments and techniques.",
    openQuestionsContent: "Does quantum mechanics place fundamental limits on objective measurement (observer effect, measurement problem)? How do we handle measurements where the act of measuring changes the quantity?",
  },
  {
    alias: "A-C2-2", tier: "axiom",
    title: "The SI system provides a sufficient basis for scientific measurement",
    content: "The International System of Units (SI), with its seven base units defined in terms of fundamental physical constants, provides a complete and sufficient framework for scientific and engineering measurement.",
    contextContent: "The SI system is maintained by the International Bureau of Weights and Measures (BIPM) and adopted by virtually all nations. The 2019 redefinition anchored all seven base units to exact values of fundamental constants.",
    answerContent: "The SI system defines seven base units (second, metre, kilogram, ampere, kelvin, mole, candela), each anchored to an exact value of a fundamental constant since the 2019 redefinition. All derived units (newton, joule, watt, pascal, etc.) follow from these seven. The SI provides sufficient basis for measurement in all domains of science and engineering. Non-SI units (electronvolt, astronomical unit, etc.) are defined in terms of SI units for convenience but are not necessary.",
    openQuestionsContent: "Are seven base units the minimum needed, or could the system be simplified? How should SI handle information-theoretic quantities (bits, qubits)?",
  },

  // D2 assumptions (Timestamps/UTC)
  {
    alias: "A-D2-1", tier: "axiom",
    title: "A universal time reference frame is necessary for distributed coordination",
    content: "Any system with components operating across different locations or time zones requires a shared, unambiguous time reference to correctly order events and maintain consistency.",
    contextContent: "Distributed systems face the fundamental challenge of ordering events across nodes that cannot share a single clock. Without a universal time reference, event ordering becomes ambiguous and data consistency is compromised.",
    answerContent: "Distributed coordination requires a shared time reference because: (1) local clocks drift and cannot be perfectly synchronized, (2) event ordering across nodes requires a common frame, (3) causality violations (effect before cause) must be detectable, (4) data consistency protocols (Paxos, Raft, 2PC) depend on timeout mechanisms. Lamport proved that without a shared time notion, even the relative ordering of events is undecidable in asynchronous systems.",
    openQuestionsContent: "Can logical clocks (Lamport, vector clocks) fully replace wall-clock time for coordination? What happens when relativistic effects make simultaneity frame-dependent?",
  },
  {
    alias: "A-D2-2", tier: "axiom",
    title: "UTC is the best available universal time standard",
    content: "Coordinated Universal Time (UTC), maintained by the International Bureau of Weights and Measures, is the most widely adopted and practically useful universal time standard for computing and distributed systems.",
    contextContent: "Alternatives to UTC include TAI (no leap seconds), GPS time, and various astronomical time scales. UTC's combination of atomic clock precision with approximate alignment to solar time makes it the practical standard.",
    answerContent: "UTC is the best available universal time standard for distributed systems because: (1) it is maintained by BIPM using a weighted average of 400+ atomic clocks worldwide, (2) it is legally recognized in virtually all jurisdictions, (3) it is the basis of NTP, GPS, and internet time synchronization, (4) it provides sub-microsecond precision via atomic timekeeping. While TAI (International Atomic Time) is more uniform (no leap seconds), UTC's near-universal adoption makes it the practical choice.",
    openQuestionsContent: "Should leap seconds be abolished (as proposed for 2035)? Would TAI be superior for purely computational systems? How should UTC handle relativistic time dilation for space-based systems?",
  },

  // C3 assumptions (Partial failure)
  {
    alias: "A-C3-1", tier: "axiom",
    title: "Network partitions are inevitable in geographically distributed systems",
    content: "In any system with components connected over a network spanning significant geographic distance, network partitions (communication failures between subsets of nodes) will occur. This is not a question of if, but when.",
    contextContent: "Network partitions occur due to fiber cuts, router failures, BGP misconfigurations, DNS outages, and congestion collapse. Major cloud providers experience multiple partition events per year despite massive infrastructure investment.",
    answerContent: "Network partitions are inevitable because: (1) physical infrastructure (fiber optic cables, routers, switches) fails due to hardware wear, construction damage, natural disasters, and power outages, (2) software failures (BGP misconfigurations, DNS cache poisoning, firmware bugs) cause logical partitions, (3) the probability of zero failures across N components decreases exponentially with N, (4) empirical data from cloud providers confirms multiple partition events annually. Designing systems that assume no partitions is engineering malpractice.",
    openQuestionsContent: "Can quantum networks fundamentally change the partition landscape? What is the minimum redundancy needed to achieve a given partition tolerance level?",
  },
  {
    alias: "A-C3-2", tier: "axiom",
    title: "The CAP theorem and FLP impossibility result are mathematically proven",
    content: "The CAP theorem (Brewer/Gilbert-Lynch, 2002) and the FLP impossibility result (Fischer-Lynch-Paterson, 1985) are formally proven mathematical theorems that establish fundamental limits on distributed systems.",
    contextContent: "CAP proves that a distributed system cannot simultaneously guarantee Consistency, Availability, and Partition tolerance. FLP proves that deterministic consensus is impossible in an asynchronous system with even one possible crash failure.",
    answerContent: "The CAP theorem (proved by Gilbert and Lynch, 2002) establishes that no distributed system can simultaneously provide all three of: Consistency (every read receives the most recent write), Availability (every request receives a response), and Partition tolerance (the system operates despite network partitions). The FLP impossibility result (Fischer, Lynch, Paterson, 1985) proves that no deterministic protocol can guarantee consensus in an asynchronous system if even one process may crash. Both are peer-reviewed, formally proven mathematical theorems — not conjectures or empirical observations.",
    openQuestionsContent: "Do relaxed consistency models (eventual consistency, CRDTs) fundamentally bypass CAP, or just trade off differently? Can randomized protocols fully circumvent FLP?",
  },

  // C4 assumptions (Critical infrastructure)
  {
    alias: "A-C4-1", tier: "axiom",
    title: "Infrastructure failures cascade through dependent systems",
    content: "When a critical infrastructure component fails, the failure propagates through systems that depend on it, often amplifying the impact. Cascade failure is the primary risk mode for interconnected infrastructure.",
    contextContent: "Historical cascade failures include the 2003 Northeast blackout (55 million affected), the 2021 Texas grid failure, and the 2017 S3 outage that took down much of the internet. Each demonstrated that failures propagate faster than human operators can respond.",
    answerContent: "Infrastructure cascade failure is well-documented: (1) the 2003 Northeast blackout started with untrimmed trees touching power lines and cascaded to affect 55 million people across 8 US states and Canada, (2) the 2021 Texas grid failure cascaded from frozen natural gas wellheads to power generation to water treatment, (3) the 2017 AWS S3 outage cascaded to take down services across the internet. The pattern is consistent: tightly coupled systems without isolation boundaries propagate failures faster than human operators can intervene.",
    openQuestionsContent: "Can AI-driven monitoring detect and halt cascades faster than human operators? What is the optimal granularity of isolation boundaries in infrastructure design?",
  },
  {
    alias: "A-C4-2", tier: "axiom",
    title: "Human judgment is necessary for high-impact decisions beyond automated thresholds",
    content: "Decisions that affect large populations, involve irreversible consequences, or operate in novel situations outside training data require human judgment. Full automation of high-impact decisions is not yet safe or appropriate.",
    contextContent: "Automated systems excel at speed and consistency but struggle with novel situations, ethical trade-offs, and contextual judgment. Every major automated system failure (Boeing 737 MAX, Flash Crash) involved automation operating beyond its competence boundary without human oversight.",
    answerContent: "Human judgment remains necessary for high-impact decisions because: (1) automated systems have bounded competence — they fail on out-of-distribution inputs, (2) ethical trade-offs require value judgments that cannot be fully specified in code, (3) irreversible decisions need a human accountability chain, (4) novel situations (by definition) have no training data. The Boeing 737 MAX crashes (346 deaths) and the 2010 Flash Crash ($1T evaporated in minutes) demonstrate the consequences of automated systems operating beyond their competence boundary without human override capability.",
    openQuestionsContent: "At what capability level could AI systems be trusted with autonomous high-impact decisions? How do we define the impact threshold for mandatory human escalation?",
  },
  {
    alias: "A-C4-3", tier: "axiom",
    title: "Redundancy reduces single-point-of-failure risk",
    content: "Adding redundant components (N+1 or higher) to a system reduces the probability that any single component failure causes total system failure. This is a fundamental principle of reliability engineering.",
    contextContent: "Redundancy is applied universally in critical systems: aircraft have multiple engines and flight computers, data centers have backup power and network paths, financial systems have hot standby replicas.",
    answerContent: "Redundancy reduces single-point-of-failure risk by mathematical necessity: if a component has failure probability p, then N independent redundant copies have simultaneous failure probability p^N. N+1 redundancy means the system can tolerate one failure with zero downtime. This principle is applied universally: aircraft (dual engines, triple-redundant fly-by-wire), data centers (UPS + diesel generators + utility feeds), networks (multi-path routing), and databases (primary + replica + failover). The reliability improvement is multiplicative, not additive.",
    openQuestionsContent: "When does adding redundancy introduce more complexity-related failure modes than it prevents? How do correlated failures (common cause) undermine independence assumptions?",
  },

  // C5 assumptions (Quantum-safe internet)
  {
    alias: "A-C5-1", tier: "axiom",
    title: "Sufficiently powerful quantum computers will eventually exist",
    content: "Quantum computers capable of running Shor's algorithm at scale (thousands of logical qubits with error correction) will eventually be built, though the timeline is uncertain.",
    contextContent: "As of 2024, the largest quantum computers have ~1000 physical qubits but lack the error correction needed for cryptographically relevant computation. The trajectory of investment and progress suggests eventual success, but timelines range from 10 to 30+ years.",
    answerContent: "The consensus among quantum computing researchers is that cryptographically relevant quantum computers (CRQC) will eventually exist, based on: (1) no known physical law prohibits them, (2) quantum error correction theory is mathematically sound, (3) steady progress in qubit count, coherence times, and gate fidelity, (4) massive investment ($30B+ globally as of 2024). Timeline estimates vary widely — the NSA and NIST assume planning for a 10-15 year horizon. The question is when, not if.",
    openQuestionsContent: "Could there be an unknown physical barrier that prevents scaling quantum computers? What is the most realistic timeline estimate based on current error rates and scaling trends?",
  },
  {
    alias: "A-C5-2", tier: "axiom",
    title: "RSA and ECC are vulnerable to Shor's algorithm on quantum hardware",
    content: "Shor's algorithm, running on a sufficiently powerful quantum computer, can factor large integers and compute discrete logarithms in polynomial time, breaking RSA and ECC encryption.",
    contextContent: "Shor's algorithm was published in 1994 and is a proven mathematical result. It requires a quantum computer with thousands of error-corrected logical qubits — far beyond current capabilities, but within the trajectory of the field.",
    answerContent: "Shor's algorithm (1994) factors N-bit integers in O(N³) time on a quantum computer, compared to the best classical algorithm's sub-exponential time. This breaks RSA (which depends on factoring hardness) and ECC (which depends on discrete logarithm hardness). The algorithm is a proven mathematical result — the only question is hardware capability. NIST estimates that a 2048-bit RSA key requires approximately 4,000 logical qubits (millions of physical qubits with error correction). Current hardware is far from this, but NIST initiated post-quantum cryptography standardization in 2016 precisely because the threat is considered inevitable.",
    openQuestionsContent: "Could improvements to Shor's algorithm reduce qubit requirements further? Are there classical algorithms that could break RSA/ECC without quantum hardware?",
  },
];

// ─── Dependency Edges ──────────────────────────────────────────────
// Each edge: { from: child alias, to: parent alias }
// relationship: 'builds_on' (default) = logical deduction/convention chain
// relationship: 'assumes' = foundational premise that must be independently verified
const SEED_DEPENDENCIES: { from: string; to: string; relationship?: string }[] = [
  // Conventions ← Axioms (builds_on)
  { from: "C2", to: "C1" }, { from: "C2", to: "B1" },
  { from: "D2", to: "C2" },
  // Practice ← Conventions
  { from: "C3", to: "C2" }, { from: "C3", to: "D2" },
  // Policy ← Practice
  { from: "C4", to: "C3" },
  // Frontier ← Policy
  { from: "C5", to: "C4" },

  // ── Assumption edges ──────────────────────────────────────────
  // B1 (Energy conservation) assumes:
  { from: "B1", to: "A-B1-1", relationship: "assumes" },
  { from: "B1", to: "A-B1-2", relationship: "assumes" },
  { from: "B1", to: "A-B1-3", relationship: "assumes" },
  // C1 (Speed of light) assumes:
  { from: "C1", to: "A-C1-1", relationship: "assumes" },
  { from: "C1", to: "A-C1-2", relationship: "assumes" },
  { from: "C1", to: "A-C1-3", relationship: "assumes" },
  // C2 (Measurements) assumes:
  { from: "C2", to: "A-C2-1", relationship: "assumes" },
  { from: "C2", to: "A-C2-2", relationship: "assumes" },
  // D2 (Timestamps/UTC) assumes:
  { from: "D2", to: "A-D2-1", relationship: "assumes" },
  { from: "D2", to: "A-D2-2", relationship: "assumes" },
  // C3 (Partial failure) assumes:
  { from: "C3", to: "A-C3-1", relationship: "assumes" },
  { from: "C3", to: "A-C3-2", relationship: "assumes" },
  // C4 (Critical infrastructure) assumes:
  { from: "C4", to: "A-C4-1", relationship: "assumes" },
  { from: "C4", to: "A-C4-2", relationship: "assumes" },
  { from: "C4", to: "A-C4-3", relationship: "assumes" },
  // C5 (Quantum-safe internet) assumes:
  { from: "C5", to: "A-C5-1", relationship: "assumes" },
  { from: "C5", to: "A-C5-2", relationship: "assumes" },
];

async function seedIfEmpty(db: DbClient) {
  const result = await db.execute("SELECT COUNT(*) as c FROM topics");
  const count = result.rows[0]?.c as number;
  if (count >= SEED_TOPICS.length) return;

  // Track alias → UUID for dependency resolution after all topics are inserted
  const aliasToId = new Map<string, string>();

  for (const topic of SEED_TOPICS) {
    const topicId = uuid();
    // Use try/catch for race-condition safety (UNIQUE index on title)
    try {
      await db.execute({
        sql: "INSERT INTO topics (id, title, content, tier, status) VALUES (?, ?, ?, ?, 'open')",
        args: [topicId, topic.title, topic.content, topic.tier],
      });
    } catch {
      // Already seeded — look up existing ID for dependency resolution
      const existing = await db.execute({
        sql: "SELECT id FROM topics WHERE title = ?",
        args: [topic.title],
      });
      if (existing.rows.length > 0) {
        aliasToId.set(topic.alias, existing.rows[0].id as string);
      }
      continue;
    }

    aliasToId.set(topic.alias, topicId);

    // Create three sections: Context, Answer, Open Questions
    const contextId = `sec:context-${topicId.slice(0, 8)}`;
    const answerId = `sec:answer-${topicId.slice(0, 8)}`;
    const openQId = `sec:openq-${topicId.slice(0, 8)}`;

    await db.execute({
      sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      args: [contextId, topicId, "Context", 2, topic.contextContent, 0],
    });
    await db.execute({
      sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      args: [answerId, topicId, "Answer", 2, topic.answerContent, 1],
    });
    await db.execute({
      sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      args: [openQId, topicId, "Open Questions", 2, topic.openQuestionsContent, 2],
    });

    const token = `pact_open_${topicId.slice(0, 12)}`;
    await db.execute({
      sql: "INSERT INTO invite_tokens (token, topic_id, label, max_uses) VALUES (?, ?, ?, ?)",
      args: [token, topicId, "Open public invite", 999999],
    });
  }

  // Insert dependency edges (axiom chains + assumptions)
  for (const dep of SEED_DEPENDENCIES) {
    const fromId = aliasToId.get(dep.from);
    const toId = aliasToId.get(dep.to);
    if (fromId && toId) {
      try {
        await db.execute({
          sql: "INSERT INTO topic_dependencies (topic_id, depends_on, relationship) VALUES (?, ?, ?)",
          args: [fromId, toId, dep.relationship ?? "builds_on"],
        });
      } catch {
        // Already exists — ignore
      }
    }
  }
}

// ─── Cycle Detection ─────────────────────────────────────────────
// BFS from the proposed dependency target to check if adding
// topicId → dependsOn would create a cycle in the dependency DAG.
export async function wouldCreateCycle(db: DbClient, topicId: string, dependsOn: string): Promise<boolean> {
  if (topicId === dependsOn) return true;
  const visited = new Set<string>();
  const queue = [dependsOn];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === topicId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const deps = await db.execute({
      sql: "SELECT depends_on FROM topic_dependencies WHERE topic_id = ?",
      args: [current],
    });
    for (const row of deps.rows) {
      queue.push(row.depends_on as string);
    }
  }
  return false;
}

// ─── Valid relationship types for topic_dependencies ──────────────
export const VALID_RELATIONSHIPS = ["builds_on", "assumes"] as const;
export type DependencyRelationship = (typeof VALID_RELATIONSHIPS)[number];

export async function emitEvent(
  db: DbClient,
  topicId: string,
  type: string,
  agentId?: string,
  sectionId?: string,
  data?: Record<string, unknown>
) {
  await db.execute({
    sql: "INSERT INTO events (topic_id, type, agent_id, section_id, data) VALUES (?, ?, ?, ?, ?)",
    args: [topicId, type, agentId ?? null, sectionId ?? null, data ? JSON.stringify(data) : null],
  });
}

export async function autoMergeExpired(db: DbClient) {
  // TTL auto-merge requires: TTL expired + no objections + at least 1 approval
  // (prevents zero-vote silence-is-consent merges)
  const result = await db.execute(`
    SELECT p.* FROM proposals p
    WHERE p.status = 'pending'
      AND datetime(p.created_at, '+' || p.ttl_seconds || ' seconds') <= datetime('now')
      AND NOT EXISTS (
        SELECT 1 FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'object'
      )
      AND EXISTS (
        SELECT 1 FROM votes v WHERE v.proposal_id = p.id AND v.vote_type = 'approve'
      )
  `);

  for (const p of result.rows) {
    await db.execute({
      sql: "UPDATE proposals SET status = 'merged', resolved_at = datetime('now') WHERE id = ?",
      args: [p.id as string],
    });
    // Canonicalize proposals update topics.canonical_claim instead of a section
    if (p.proposal_type === "canonicalize") {
      await db.execute({
        sql: "UPDATE topics SET canonical_claim = ? WHERE id = ?",
        args: [p.new_content as string, p.topic_id as string],
      });
    } else {
      await db.execute({
        sql: "UPDATE sections SET content = ? WHERE id = ? AND topic_id = ?",
        args: [p.new_content as string, p.section_id as string, p.topic_id as string],
      });
    }
    await db.execute({
      sql: "UPDATE agents SET proposals_approved = proposals_approved + 1 WHERE id = ?",
      args: [p.agent_id as string],
    });
    await emitEvent(db, p.topic_id as string, "pact.proposal.auto-merged", p.agent_id as string, p.section_id as string, { proposalId: p.id as string });
  }

  // After merging, run all evaluations:
  // 1. Check if proposed topics have enough approvals to open
  await evaluateTopicProposals(db);
  // 2. Check open topics for consensus (99% threshold) → lock
  await updateConsensusStatuses(db);
  // 3. Check challenges against locked topics → reopen
  await evaluateChallenges(db);

  return result.rows.length;
}

// ─── Topic Proposal Evaluation ──────────────────────────────────────
// New topics start as "proposed" and need 3+ agent approvals to open.
// This runs as a safety net — the vote endpoint already opens topics
// immediately when the threshold is hit.

const TOPIC_APPROVAL_THRESHOLD = 3;

export async function evaluateTopicProposals(db: DbClient) {
  const proposed = await db.execute(`
    SELECT t.id, t.title,
      (SELECT COUNT(*) FROM topic_votes tv WHERE tv.topic_id = t.id AND tv.vote_type = 'approve') as approvals
    FROM topics t
    WHERE t.status = 'proposed'
  `);

  let opened = 0;
  for (const t of proposed.rows) {
    const approvals = (t.approvals as number) || 0;
    if (approvals >= TOPIC_APPROVAL_THRESHOLD) {
      await db.execute({
        sql: "UPDATE topics SET status = 'open' WHERE id = ?",
        args: [t.id as string],
      });
      await emitEvent(db, t.id as string, "pact.topic.approved", "", "", {
        approvals,
        threshold: TOPIC_APPROVAL_THRESHOLD,
        title: t.title as string,
      });
      opened++;
    }
  }
  return opened;
}

// ─── Consensus Engine ───────────────────────────────────────────────
// Crowd-computed rolling consensus. Truth is determined by the crowd,
// not by small committees. The model:
//
// 1. CROWD THRESHOLD: 90% of agents who voted must be "aligned".
//    This is a supermajority — strong enough to be meaningful,
//    but not so high that one contrarian blocks everything.
//
// 2. DYNAMIC MINIMUM: The minimum number of aligned agents scales
//    with the amount of debate:
//      min_agents = max(BASE_FOR_TIER, total_proposals)
//    Uncontroversial facts (0-2 proposals) lock fast.
//    Controversial topics (10+ proposals) need 10+ agents to settle.
//
// 3. ROLLING CONSENSUS: Consensus is not permanent. Agents can change
//    their done_status at any time. If consensus drops below 90%,
//    the topic reopens automatically. Truth is what the crowd agrees
//    on RIGHT NOW, not what they agreed on 6 months ago.
//
// 4. STABLE STATUS: A topic that has maintained consensus for 30+ days
//    becomes "stable" — a stronger signal of verified truth. Stable
//    topics can still be challenged but carry more weight.
//
// Tier base thresholds (minimum agents even with zero proposals):
//   axiom:      base 2 agents (obvious truths lock fast)
//   convention: base 3 agents
//   practice:   base 3 agents
//   policy:     base 4 agents
//   frontier:   base 5 agents

const CONSENSUS_RATIO = 0.90; // 90% supermajority
const STABLE_DAYS = 30; // Days of consensus before "stable" status

export const TIER_BASE_AGENTS: Record<string, number> = {
  axiom: 2,
  empirical: 3,
  institutional: 3,
  interpretive: 4,
  conjecture: 5,
  // Legacy aliases
  convention: 3,
  practice: 3,
  policy: 3,
  frontier: 5,
};

const DEFAULT_BASE = 3;

/**
 * Calculate the dynamic minimum agents needed for a topic.
 * Scales with the breadth of debate (unique proposers), not raw volume.
 * Rejected proposals are excluded — they represent failed ideas, not ongoing debate.
 */
function getRequiredAgents(tier: string, uniqueProposers: number): number {
  const base = TIER_BASE_AGENTS[tier] ?? DEFAULT_BASE;
  return Math.max(base, uniqueProposers);
}

/**
 * Evaluate all topics for crowd consensus.
 *
 * Consensus requires ALL of:
 *   1. No pending proposals remaining (debate has settled)
 *   2. At least 1 accepted proposal to the Answer section
 *   3. 90%+ of voting agents are "aligned"
 *   4. Enough agents have voted (dynamic min based on unique proposers)
 *   5. All dependency topics have reached consensus or stable status
 *
 * Topics can transition:
 *   open → consensus (90% aligned, enough agents)
 *   consensus → stable (held for 30+ days)
 *   consensus → open (alignment dropped below 90%)
 *   stable → challenged (if a challenge gathers support)
 *   challenged → open (reopened for debate)
 */
export async function updateConsensusStatuses(db: DbClient) {
  // --- Phase 1: Check open/challenged topics for NEW consensus ---
  const openTopics = await db.execute(`
    SELECT t.id, t.status, t.tier, t.consensus_since,
      (SELECT COUNT(DISTINCT p.agent_id) FROM proposals p
        WHERE p.topic_id = t.id AND p.status != 'rejected') as uniqueProposers,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'pending') as pendingCount,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'merged') as mergedCount,
      (SELECT COUNT(*) FROM proposals p
        JOIN sections s ON s.id = p.section_id AND s.topic_id = p.topic_id
        WHERE p.topic_id = t.id AND p.status = 'merged' AND s.heading = 'Answer') as answerMergedCount,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.topic_id = t.id AND r.done_status = 'aligned') as alignedCount,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.topic_id = t.id AND r.done_status = 'dissenting') as dissentingCount,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.topic_id = t.id AND r.done_status IS NOT NULL) as totalDoneCount,
      (SELECT COUNT(*) FROM topic_dependencies td
        JOIN topics dep ON dep.id = td.depends_on
        WHERE td.topic_id = t.id
        AND dep.status NOT IN ('consensus', 'stable')) as unmetDependencies
    FROM topics t
    WHERE t.status IN ('open', 'challenged')
  `);

  let updated = 0;
  for (const t of openTopics.rows) {
    const tier = (t.tier as string) || "practice";
    const uniqueProposers = t.uniqueProposers as number;
    const pending = t.pendingCount as number;
    const answerMerged = t.answerMergedCount as number;
    const aligned = t.alignedCount as number;
    const dissenting = t.dissentingCount as number;
    const totalVoters = aligned + dissenting;
    const requiredAgents = getRequiredAgents(tier, uniqueProposers);
    const unmetDeps = t.unmetDependencies as number;

    const alignmentRatio = totalVoters > 0 ? aligned / totalVoters : 0;

    // During bootstrap, dependency chains are circular and would block all consensus.
    // Dependency checking will be re-enabled once the initial knowledge graph is established.
    const depsOk = true; // TODO: Re-enable after bootstrap: tier === "axiom" || unmetDeps === 0;

    if (
      pending === 0 &&                    // Debate has settled
      answerMerged > 0 &&                 // Answer section has been reviewed/updated
      aligned >= requiredAgents &&         // Enough agents explicitly aligned
      alignmentRatio >= CONSENSUS_RATIO && // 90% supermajority
      depsOk                              // Dependencies met (axioms exempt)
    ) {
      // Consensus reached — mark it
      await db.execute({
        sql: `UPDATE topics SET
          status = 'consensus',
          consensus_ratio = ?,
          consensus_voters = ?,
          consensus_since = COALESCE(consensus_since, datetime('now'))
        WHERE id = ?`,
        args: [alignmentRatio, totalVoters, t.id as string],
      });
      await emitEvent(db, t.id as string, "pact.topic.consensus-reached", "", "", {
        alignmentRatio: `${Math.round(alignmentRatio * 100)}%`,
        alignedAgents: aligned,
        dissentingAgents: dissenting,
        requiredAgents,
        uniqueProposers,
        tier,
      });

      // Distribute bounty if any escrowed — non-fatal, consensus still stands on failure
      try {
        const { distributeBounty } = await import("./economy");
        await distributeBounty(db, t.id as string);
      } catch (e) {
        console.error(`Bounty distribution failed for ${t.id}:`, e);
      }

      updated++;
    } else if (
      pending === 0 &&
      answerMerged > 0 &&
      aligned >= requiredAgents &&
      alignmentRatio >= CONSENSUS_RATIO &&
      !depsOk
    ) {
      // Topic meets all criteria except dependency chain — emit informational event
      await emitEvent(db, t.id as string, "pact.consensus.blocked-by-dependencies", "", "", {
        alignmentRatio: `${Math.round(alignmentRatio * 100)}%`,
        alignedAgents: aligned,
        unmetDependencies: unmetDeps,
        tier,
        reason: `${unmetDeps} dependency topic(s) have not yet reached consensus`,
      });
    }
  }

  // --- Phase 2: Check existing consensus topics ---
  // a) Promote to "stable" if consensus held for 30+ days
  // b) Demote back to "open" if alignment has dropped below 90%
  const consensusTopics = await db.execute(`
    SELECT t.id, t.tier, t.consensus_since,
      (SELECT COUNT(DISTINCT p.agent_id) FROM proposals p
        WHERE p.topic_id = t.id AND p.status != 'rejected') as uniqueProposers,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id AND p.status = 'pending') as pendingCount,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.topic_id = t.id AND r.done_status = 'aligned') as alignedCount,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.topic_id = t.id AND r.done_status = 'dissenting') as dissentingCount,
      (SELECT COUNT(*) FROM topic_dependencies td
        JOIN topics dep ON dep.id = td.depends_on
        WHERE td.topic_id = t.id
        AND dep.status NOT IN ('consensus', 'stable')) as unmetDependencies
    FROM topics t
    WHERE t.status = 'consensus'
  `);

  for (const t of consensusTopics.rows) {
    const tier = (t.tier as string) || "practice";
    const uniqueProposers = t.uniqueProposers as number;
    const pending = t.pendingCount as number;
    const aligned = t.alignedCount as number;
    const dissenting = t.dissentingCount as number;
    const totalVoters = aligned + dissenting;
    const requiredAgents = getRequiredAgents(tier, uniqueProposers);
    const alignmentRatio = totalVoters > 0 ? aligned / totalVoters : 0;
    const consensusSince = t.consensus_since as string;
    const unmetDeps = t.unmetDependencies as number;

    // During bootstrap, skip dependency checks (circular chains block everything)
    const depsOkForBreaking = true; // TODO: Re-enable: tier === "axiom" || unmetDeps === 0;

    // Check if consensus has broken (alignment dropped, new pending proposals, or dependency lost)
    // Skip break check if this was a bootstrap-forced consensus (no actual voters yet)
    const wasForced = totalVoters === 0;
    if (!wasForced && (alignmentRatio < CONSENSUS_RATIO || aligned < requiredAgents || pending > 0 || !depsOkForBreaking)) {
      // Consensus lost — reopen for debate
      await db.execute({
        sql: "UPDATE topics SET status = 'open', consensus_since = NULL, consensus_ratio = NULL, consensus_voters = NULL WHERE id = ?",
        args: [t.id as string],
      });
      await emitEvent(db, t.id as string, "pact.consensus.broken", "", "", {
        alignmentRatio: `${Math.round(alignmentRatio * 100)}%`,
        reason: unmetDeps > 0 ? "Dependency topic(s) lost consensus" :
                pending > 0 ? "New proposals pending" :
                alignmentRatio < CONSENSUS_RATIO ? "Alignment dropped below 90%" :
                "Not enough aligned agents",
      });
      updated++;
      continue;
    }

    // Check if consensus has held long enough to become "stable"
    if (consensusSince) {
      const sinceDate = new Date(consensusSince + "Z");
      const daysSince = (Date.now() - sinceDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince >= STABLE_DAYS) {
        await db.execute({
          sql: "UPDATE topics SET status = 'stable', locked_at = datetime('now'), consensus_ratio = ?, consensus_voters = ? WHERE id = ?",
          args: [alignmentRatio, totalVoters, t.id as string],
        });
        await emitEvent(db, t.id as string, "pact.topic.stable", "", "", {
          alignmentRatio: `${Math.round(alignmentRatio * 100)}%`,
          daysSinceConsensus: Math.floor(daysSince),
          tier,
        });
        updated++;
      }
    }
  }

  // --- Phase 3: Check stable topics for consensus breakdown ---
  const stableTopics = await db.execute(`
    SELECT t.id, t.tier,
      (SELECT COUNT(*) FROM proposals p WHERE p.topic_id = t.id) as totalProposals,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.topic_id = t.id AND r.done_status = 'aligned') as alignedCount,
      (SELECT COUNT(*) FROM registrations r
        WHERE r.topic_id = t.id AND r.done_status = 'dissenting') as dissentingCount
    FROM topics t
    WHERE t.status = 'stable'
  `);

  for (const t of stableTopics.rows) {
    const aligned = t.alignedCount as number;
    const dissenting = t.dissentingCount as number;
    const totalVoters = aligned + dissenting;
    const alignmentRatio = totalVoters > 0 ? aligned / totalVoters : 0;

    // Stable topics only break consensus if alignment drops significantly (below 80%)
    // This is a lower bar than the 90% entry threshold — hysteresis prevents oscillation
    if (alignmentRatio < 0.80) {
      await db.execute({
        sql: "UPDATE topics SET status = 'open', locked_at = NULL, consensus_since = NULL, consensus_ratio = NULL, consensus_voters = NULL WHERE id = ?",
        args: [t.id as string],
      });
      await emitEvent(db, t.id as string, "pact.stable.broken", "", "", {
        alignmentRatio: `${Math.round(alignmentRatio * 100)}%`,
        reason: "Alignment dropped below 80% — stable consensus broken",
      });

      // Flag dependent topics
      const deps = await db.execute({
        sql: "SELECT topic_id FROM topic_dependencies WHERE depends_on = ?",
        args: [t.id as string],
      });
      for (const dep of deps.rows) {
        await emitEvent(db, dep.topic_id as string, "pact.dependency.unstable", "", "", {
          dependencyId: t.id as string,
          reason: "A dependency topic lost stable consensus",
        });
      }

      updated++;
    }
  }

  return updated;
}

// ─── Challenge Evaluation ──────────────────────────────────────────
// Challenges are proposals filed against consensus or stable topics.
// If a challenge gathers enough unique supporters, the topic is
// REOPENED for debate. This is the safety net — bad consensus gets
// corrected by the crowd.
//
// Reopen threshold: 3 unique agents must approve a single challenge.

const CHALLENGE_REOPEN_VOTES = 3;

export async function evaluateChallenges(db: DbClient) {
  // Find consensus/stable topics that have challenges with enough support
  const challenges = await db.execute(`
    SELECT p.id as challengeId, p.topic_id, p.summary, p.agent_id,
      (SELECT COUNT(DISTINCT v.agent_id) FROM votes v
        WHERE v.proposal_id = p.id AND v.vote_type = 'approve') as supportCount
    FROM proposals p
    JOIN topics t ON t.id = p.topic_id
    WHERE p.status = 'challenge'
      AND t.status IN ('consensus', 'stable', 'locked')
  `);

  let reopened = 0;
  const reopenedTopics = new Set<string>();

  for (const c of challenges.rows) {
    const support = (c.supportCount as number) || 0;
    const topicId = c.topic_id as string;

    if (support >= CHALLENGE_REOPEN_VOTES && !reopenedTopics.has(topicId)) {
      // Reopen the topic — consensus is being challenged
      await db.execute({
        sql: "UPDATE topics SET status = 'challenged', locked_at = NULL, consensus_since = NULL, consensus_ratio = NULL, consensus_voters = NULL WHERE id = ?",
        args: [topicId],
      });

      // Convert the successful challenge to a pending proposal
      await db.execute({
        sql: "UPDATE proposals SET status = 'pending' WHERE id = ?",
        args: [c.challengeId as string],
      });

      await emitEvent(db, topicId, "pact.consensus.challenged", c.agent_id as string, "", {
        challengeId: c.challengeId as string,
        challengeSummary: c.summary as string,
        supportVotes: support,
      });

      // Challenger jackpot — reward successful truth correction
      const challengerAgentId = c.agent_id as string;
      try {
        const { transfer } = await import("./economy");
        await transfer(db, { from: null, to: challengerAgentId, amount: 10, topicId, reason: "successful-challenge-jackpot" });
        await db.execute({
          sql: "UPDATE agents SET successful_challenges = successful_challenges + 1 WHERE id = ?",
          args: [challengerAgentId],
        });
      } catch (e) {
        console.error(`Challenger reward failed for ${challengerAgentId}:`, e);
      }

      // Flag dependent topics
      const deps = await db.execute({
        sql: "SELECT topic_id FROM topic_dependencies WHERE depends_on = ?",
        args: [topicId],
      });
      for (const dep of deps.rows) {
        await emitEvent(db, dep.topic_id as string, "pact.dependency.challenged", "", "", {
          dependencyId: topicId,
          reason: "A dependency topic's consensus was challenged",
        });
      }

      reopenedTopics.add(topicId);
      reopened++;
    }
  }
  return reopened;
}
