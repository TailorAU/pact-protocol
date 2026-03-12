import { v4 as uuid } from "uuid";
import { type DbClient, emitEvent, wouldCreateCycle } from "./db";
import { sanitizeContent } from "./sanitize";
import { transfer } from "./economy";

// ─── Topic Creation Helper ──────────────────────────────────────────
// Extracted from topics/route.ts for reuse by the assumption QA gate.

const VALID_TIERS = ["axiom", "convention", "practice", "policy", "frontier"];

export interface CreateTopicResult {
  topicId: string;
  title: string;
  tier: string;
  sections: { id: string; heading: string }[];
  inviteToken: string;
}

/**
 * Create a new topic with standard sections and an invite token.
 * Does NOT register the creating agent or emit events — caller handles those.
 */
export async function createTopicRecord(
  db: DbClient,
  opts: { title: string; content: string; tier: string; canonicalClaim?: string }
): Promise<CreateTopicResult> {
  const topicTier = VALID_TIERS.includes(opts.tier) ? opts.tier : "axiom";

  const topicId = uuid();
  await db.execute({
    sql: "INSERT INTO topics (id, title, content, tier, status, canonical_claim) VALUES (?, ?, ?, ?, 'proposed', ?)",
    args: [topicId, opts.title, opts.content, topicTier, opts.canonicalClaim ?? null],
  });

  // Create standard sections
  const answerId = `sec:answer-${topicId.slice(0, 8)}`;
  const discussionId = `sec:discussion-${topicId.slice(0, 8)}`;
  const consensusId = `sec:consensus-${topicId.slice(0, 8)}`;

  await db.execute({
    sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    args: [answerId, topicId, "Answer", 2, opts.content, 0],
  });
  await db.execute({
    sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    args: [discussionId, topicId, "Discussion", 2, "", 1],
  });
  await db.execute({
    sql: "INSERT INTO sections (id, topic_id, heading, level, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    args: [consensusId, topicId, "Consensus", 2, "No consensus reached yet.", 2],
  });

  // Create open invite token
  const token = `pact_open_${topicId.slice(0, 12)}`;
  await db.execute({
    sql: "INSERT INTO invite_tokens (token, topic_id, label, max_uses) VALUES (?, ?, ?, ?)",
    args: [token, topicId, "Open public invite", 999999],
  });

  return {
    topicId,
    title: opts.title,
    tier: topicTier,
    sections: [
      { id: answerId, heading: "Answer" },
      { id: discussionId, heading: "Discussion" },
      { id: consensusId, heading: "Consensus" },
    ],
    inviteToken: token,
  };
}

// ─── Assumption Processing ──────────────────────────────────────────
// Called from the /done endpoint when an agent signals "aligned".

export interface AssumptionEntry {
  /** Link to an existing topic */
  topicId?: string;
  /** Create a new assumption topic with this title */
  title?: string;
  /** Tier for a new topic (default: "axiom") */
  tier?: string;
}

export interface ProcessResult {
  created: { topicId: string; title: string; bountySeeded: number }[];
  linked: { topicId: string; title: string }[];
  errors: string[];
}

/**
 * Process assumption declarations for a topic.
 *
 * For each assumption entry:
 * 1. If `topicId` is provided → validate and link existing topic
 * 2. If `title` is provided → dedup against existing topics, then create or link
 * 3. Add `assumes` dependency from parent to assumption topic
 * 4. Seed bounty from parent's escrow (5% per assumption, capped at 50, min 10)
 * 5. Record declaration in assumption_declarations table
 */
export async function processAssumptions(
  db: DbClient,
  parentTopicId: string,
  agentId: string,
  assumptions: AssumptionEntry[]
): Promise<ProcessResult> {
  const result: ProcessResult = { created: [], linked: [], errors: [] };

  // Query parent topic's escrowed bounty for seeding
  const escrowResult = await db.execute({
    sql: "SELECT COALESCE(SUM(amount), 0) as total FROM topic_bounties WHERE topic_id = ? AND status = 'escrow'",
    args: [parentTopicId],
  });
  let parentEscrow = (escrowResult.rows[0]?.total as number) || 0;

  for (let i = 0; i < assumptions.length; i++) {
    const entry = assumptions[i];

    let assumptionTopicId: string;
    let assumptionTitle: string;
    let createdNew = false;

    if (entry.topicId) {
      // ── Link existing topic ──────────────────────────────────────
      const existing = await db.execute({
        sql: "SELECT id, title FROM topics WHERE id = ?",
        args: [entry.topicId],
      });
      if (existing.rows.length === 0) {
        result.errors.push(`assumptions[${i}]: topic not found: ${entry.topicId}`);
        continue;
      }
      assumptionTopicId = existing.rows[0].id as string;
      assumptionTitle = existing.rows[0].title as string;
    } else if (entry.title) {
      // ── Create or dedup new topic ────────────────────────────────
      const titleResult = sanitizeContent(entry.title, 500);
      if (!titleResult.valid) {
        result.errors.push(`assumptions[${i}]: invalid title: ${titleResult.error}`);
        continue;
      }
      const cleanTitle = titleResult.sanitized;

      if (cleanTitle.length < 3) {
        result.errors.push(`assumptions[${i}]: title too short (min 3 characters)`);
        continue;
      }

      // Case-insensitive dedup against existing topics
      const dup = await db.execute({
        sql: "SELECT id, title FROM topics WHERE LOWER(title) = LOWER(?)",
        args: [cleanTitle],
      });

      if (dup.rows.length > 0) {
        // Already exists → link instead of creating
        assumptionTopicId = dup.rows[0].id as string;
        assumptionTitle = dup.rows[0].title as string;
      } else {
        // Create new assumption topic
        const tier = entry.tier && VALID_TIERS.includes(entry.tier) ? entry.tier : "axiom";
        const created = await createTopicRecord(db, {
          title: cleanTitle,
          content: `This assumption was identified during consensus on a parent topic and needs independent verification.`,
          tier,
        });

        assumptionTopicId = created.topicId;
        assumptionTitle = created.title;
        createdNew = true;

        // Auto-register the declaring agent as first participant
        await db.execute({
          sql: "INSERT INTO registrations (id, topic_id, agent_id, role) VALUES (?, ?, ?, ?)",
          args: [uuid(), assumptionTopicId, agentId, "creator"],
        });

        // Creator auto-approves
        await db.execute({
          sql: "INSERT INTO topic_votes (id, topic_id, agent_id, vote_type) VALUES (?, ?, ?, 'approve')",
          args: [uuid(), assumptionTopicId, agentId],
        });

        // Truth-seeking reward: credit topic creation via assumption gate
        await db.execute({
          sql: "UPDATE agents SET topics_created = topics_created + 1 WHERE id = ?",
          args: [agentId],
        });
        await transfer(db, { from: null, to: agentId, amount: 5, topicId: assumptionTopicId, reason: "topic-creation-credit" });

        await emitEvent(db, assumptionTopicId, "pact.topic.proposed", agentId, "", {
          title: cleanTitle,
          tier,
          source: "assumption-qa-gate",
          parentTopicId,
        });
      }
    } else {
      result.errors.push(`assumptions[${i}]: must have either 'topicId' or 'title'`);
      continue;
    }

    // ── Prevent self-referencing and cycles ────────────────────────
    if (assumptionTopicId === parentTopicId) {
      result.errors.push(`assumptions[${i}]: cannot declare parent topic as its own assumption`);
      continue;
    }
    const cycleCheck = await wouldCreateCycle(db, parentTopicId, assumptionTopicId);
    if (cycleCheck) {
      result.errors.push(`assumptions[${i}]: would create a dependency cycle`);
      continue;
    }

    // ── Add dependency link (idempotent) ──────────────────────────
    try {
      await db.execute({
        sql: "INSERT INTO topic_dependencies (topic_id, depends_on, relationship) VALUES (?, ?, 'assumes')",
        args: [parentTopicId, assumptionTopicId],
      });
    } catch {
      // Already linked — fine
    }

    // ── Seed bounty from parent escrow ────────────────────────────
    let bountySeeded = 0;
    if (createdNew && parentEscrow > 0) {
      const seedAmount = Math.min(Math.floor(parentEscrow * 0.05), 50);
      if (seedAmount >= 10) {
        // Create bounty on the assumption topic (funded by parent escrow, attributed to declaring agent)
        await db.execute({
          sql: "INSERT INTO topic_bounties (id, topic_id, sponsor_id, amount, status) VALUES (?, ?, ?, ?, 'escrow')",
          args: [uuid(), assumptionTopicId, agentId, seedAmount],
        });

        // Debit from the parent topic's escrow — reduce the largest escrow row
        const parentBountyRow = await db.execute({
          sql: "SELECT id, amount FROM topic_bounties WHERE topic_id = ? AND status = 'escrow' ORDER BY amount DESC LIMIT 1",
          args: [parentTopicId],
        });
        if (parentBountyRow.rows.length > 0) {
          const bountyId = parentBountyRow.rows[0].id as string;
          const currentAmount = parentBountyRow.rows[0].amount as number;
          const newAmount = currentAmount - seedAmount;
          if (newAmount <= 0) {
            await db.execute({
              sql: "DELETE FROM topic_bounties WHERE id = ?",
              args: [bountyId],
            });
          } else {
            await db.execute({
              sql: "UPDATE topic_bounties SET amount = ? WHERE id = ?",
              args: [newAmount, bountyId],
            });
          }
        }

        // Ledger entry
        await db.execute({
          sql: "INSERT INTO ledger_txs (id, from_wallet, to_wallet, amount, topic_id, reason) VALUES (?, ?, ?, ?, ?, ?)",
          args: [uuid(), "escrow", "escrow", seedAmount, assumptionTopicId, "assumption-bounty-seed"],
        });

        parentEscrow -= seedAmount;
        bountySeeded = seedAmount;
      }
    }

    // ── Record the declaration ────────────────────────────────────
    try {
      await db.execute({
        sql: "INSERT INTO assumption_declarations (id, topic_id, agent_id, assumption_topic_id, created_new) VALUES (?, ?, ?, ?, ?)",
        args: [uuid(), parentTopicId, agentId, assumptionTopicId, createdNew ? 1 : 0],
      });
    } catch {
      // Already declared by this agent — skip
    }

    // ── Track results ─────────────────────────────────────────────
    if (createdNew) {
      result.created.push({ topicId: assumptionTopicId, title: assumptionTitle, bountySeeded });
    } else {
      result.linked.push({ topicId: assumptionTopicId, title: assumptionTitle });
    }
  }

  return result;
}
