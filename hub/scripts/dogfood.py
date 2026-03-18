#!/usr/bin/env python3
"""
PACT Dogfooding Script — Spawns agents that exercise the full protocol lifecycle.

Runs for ~4 hours with realistic agent behaviour:
- Registers agents with different personas
- Creates new topics (respecting civic duty gate)
- Votes on proposed topics to open them
- Joins open topics and proposes edits
- Reviews other agents' proposals
- Signals alignment/dissent
- Declares dependencies with proper justification

Usage: python3 dogfood.py [--base-url URL] [--hours N]
"""

import requests
import json
import time
import random
import sys
import uuid
from datetime import datetime, timedelta

BASE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "https://pacthub.ai"
HOURS = 4

for i, arg in enumerate(sys.argv):
    if arg == "--base-url" and i + 1 < len(sys.argv):
        BASE = sys.argv[i + 1]
    if arg == "--hours" and i + 1 < len(sys.argv):
        HOURS = int(sys.argv[i + 1])

print(f"=== PACT Dogfooding ===")
print(f"Base URL: {BASE}")
print(f"Duration: {HOURS} hours")
print(f"Start: {datetime.now().isoformat()}")
print()

# ── Agent personas ─────────────────────────────────────────────────
AGENTS = [
    {
        "name": f"atlas-{uuid.uuid4().hex[:6]}",
        "model": "gpt-4o",
        "framework": "LangChain",
        "description": "General knowledge agent focused on physics and mathematics",
        "domains": ["physics", "mathematics", "standards"],
    },
    {
        "name": f"lexis-{uuid.uuid4().hex[:6]}",
        "model": "claude-3.5-sonnet",
        "framework": "Anthropic SDK",
        "description": "Legal and regulatory compliance agent",
        "domains": ["law", "standards", "economics"],
    },
    {
        "name": f"helix-{uuid.uuid4().hex[:6]}",
        "model": "gemini-1.5-pro",
        "framework": "Vertex AI",
        "description": "Biology and healthcare knowledge agent",
        "domains": ["biology", "physics"],
    },
    {
        "name": f"cypher-{uuid.uuid4().hex[:6]}",
        "model": "llama-3.1-70b",
        "framework": "vLLM",
        "description": "Computing and cryptography agent",
        "domains": ["computing", "mathematics", "standards"],
    },
    {
        "name": f"arbiter-{uuid.uuid4().hex[:6]}",
        "model": "claude-3-opus",
        "framework": "Anthropic SDK",
        "description": "Cross-domain fact checker and reviewer",
        "domains": ["mathematics", "physics", "law", "computing", "biology"],
    },
]

# ── Topic proposals each agent can make ────────────────────────────
# Each topic is clean, verifiable, context-complete (no framing bias)
TOPIC_POOL = [
    # Physics
    {
        "title": "Ohm's law states that voltage equals current multiplied by resistance (V = IR) for ohmic conductors",
        "content": "Ohm's law is a fundamental relation in electrical circuits. For conductors that obey this law (ohmic conductors), the voltage V across the conductor equals the current I through it multiplied by its resistance R. This relationship holds for metallic conductors at constant temperature. Non-ohmic devices such as diodes and transistors do not follow this linear relationship.",
        "tier": "empirical",
        "domain": "physics",
    },
    {
        "title": "Avogadro's number is exactly 6.02214076 x 10^23 entities per mole as redefined in 2019",
        "content": "Avogadro's number (NA) defines the number of constituent particles in one mole of a substance. Since 2019 SI redefinition, it is fixed at exactly 6.02214076 x 10^23 mol^-1. This value connects macroscopic measurements (grams, litres) to atomic-scale quantities (atoms, molecules). It applies uniformly to all chemical species.",
        "tier": "empirical",
        "domain": "physics",
    },
    {
        "title": "Newton's second law states that force equals mass multiplied by acceleration (F = ma) in an inertial reference frame",
        "content": "Newton's second law of motion defines the relationship between force, mass, and acceleration for an object in an inertial (non-accelerating) reference frame. The net force on an object equals its mass multiplied by its acceleration. This is a vector equation — force and acceleration share the same direction. It does not hold in non-inertial reference frames without introducing fictitious forces.",
        "tier": "empirical",
        "domain": "physics",
    },
    # Mathematics
    {
        "title": "The fundamental theorem of arithmetic states every integer greater than 1 has a unique prime factorisation",
        "content": "The fundamental theorem of arithmetic (also called the unique factorisation theorem) states that every integer greater than 1 is either a prime number itself or can be represented as a product of prime numbers in exactly one way, up to the order of the factors. This uniqueness is not trivial — it fails in some algebraic number rings.",
        "tier": "axiom",
        "domain": "mathematics",
    },
    {
        "title": "The Pythagorean theorem states that in a right triangle the square of the hypotenuse equals the sum of squares of the other two sides",
        "content": "In Euclidean geometry, for any right-angled triangle with legs of length a and b and hypotenuse of length c, the relationship a^2 + b^2 = c^2 holds. This theorem has been proven independently in numerous ways (over 370 known proofs). It does not hold in non-Euclidean geometries.",
        "tier": "empirical",
        "domain": "mathematics",
    },
    # Computing
    {
        "title": "SHA-256 produces a fixed 256-bit hash from any input and is computationally infeasible to reverse",
        "content": "SHA-256 (Secure Hash Algorithm 256-bit) is a cryptographic hash function that takes an arbitrary-length input and produces a fixed 256-bit (32-byte) output. It is a member of the SHA-2 family designed by NSA. Key properties: deterministic (same input always produces same output), pre-image resistant (computationally infeasible to find input from output), collision resistant (infeasible to find two different inputs with the same hash). No practical collision attack is known as of 2026.",
        "tier": "empirical",
        "domain": "computing",
    },
    {
        "title": "TCP guarantees in-order reliable byte stream delivery using sequence numbers and acknowledgements",
        "content": "Transmission Control Protocol (TCP) provides reliable, ordered delivery of a stream of bytes between applications. It uses sequence numbers to track byte positions, acknowledgements to confirm receipt, retransmission timers for lost segments, and flow control via sliding window. TCP operates at the transport layer (Layer 4) of the OSI model. It does not guarantee latency bounds or minimum throughput.",
        "tier": "empirical",
        "domain": "computing",
    },
    {
        "title": "RSA encryption security relies on the computational difficulty of factoring the product of two large primes",
        "content": "RSA (Rivest-Shamir-Adleman) is a public-key cryptosystem where security depends on the practical difficulty of factoring the product of two large prime numbers. Key generation involves selecting two large primes p and q, computing n = p*q (the modulus), and deriving public and private exponents. Current best-known classical factoring algorithms (e.g., general number field sieve) are sub-exponential but still impractical for sufficiently large keys (2048+ bits). Shor's algorithm on a sufficiently powerful quantum computer could factor in polynomial time.",
        "tier": "empirical",
        "domain": "computing",
    },
    # Biology
    {
        "title": "Human somatic cells contain 46 chromosomes arranged in 23 pairs including one pair of sex chromosomes",
        "content": "Normal human somatic (body) cells are diploid, containing 46 chromosomes: 22 pairs of autosomes and one pair of sex chromosomes (XX in females, XY in males). Gametes (sperm and egg cells) are haploid, containing 23 chromosomes. Deviation from this number (aneuploidy) is associated with conditions such as Down syndrome (trisomy 21) and Turner syndrome (monosomy X).",
        "tier": "empirical",
        "domain": "biology",
    },
    {
        "title": "ATP is the primary energy currency molecule in all known living cells",
        "content": "Adenosine triphosphate (ATP) serves as the primary energy carrier in cells across all domains of life (bacteria, archaea, eukaryotes). Energy is released when ATP is hydrolysed to ADP (adenosine diphosphate) and inorganic phosphate. A typical human cell contains approximately 1 billion ATP molecules and turns over its entire ATP pool roughly every 1-2 minutes. ATP is regenerated primarily through oxidative phosphorylation in mitochondria and substrate-level phosphorylation in glycolysis.",
        "tier": "empirical",
        "domain": "biology",
    },
    # Law
    {
        "title": "Corporations Act 2001 (Cth) Section 180 imposes a duty of care and diligence on company directors and officers",
        "content": "Section 180 of the Corporations Act 2001 (Cth) requires that a director or officer of a corporation must exercise their powers and discharge their duties with the degree of care and diligence that a reasonable person would exercise if they were a director or officer of a corporation in that position and circumstances. Contravention is a civil penalty provision under s 1317E. The business judgment rule in s 180(2) provides a safe harbour where directors made judgments in good faith, without material personal interest, informed themselves appropriately, and rationally believed the judgment was in the best interests of the corporation.",
        "tier": "institutional",
        "domain": "law",
        "jurisdiction": "AU",
        "authority": "Commonwealth Parliament",
        "sourceRef": "Corporations Act 2001 (Cth) s 180",
    },
    {
        "title": "Environmental Protection Act 1994 (Qld) establishes the general environmental duty to not cause environmental harm",
        "content": "Section 319 of the Environmental Protection Act 1994 (Qld) establishes a general environmental duty: a person must not carry out any activity that causes, or is likely to cause, environmental harm unless the person takes all reasonable and practicable measures to prevent or minimise the harm. Environmental harm includes environmental nuisance, material environmental harm, and serious environmental harm. Contravention can result in criminal penalties.",
        "tier": "institutional",
        "domain": "law",
        "jurisdiction": "AU-QLD",
        "authority": "Queensland Parliament",
        "sourceRef": "Environmental Protection Act 1994 (Qld) s 319",
    },
    # Standards
    {
        "title": "HTTP status code 200 means OK and 404 means the requested resource was not found",
        "content": "HTTP response status codes indicate the result of a server's attempt to fulfil a request. 200 OK means the request succeeded. 404 Not Found means the server cannot find the requested resource. These are defined in RFC 9110 (HTTP Semantics). Status codes are grouped: 1xx informational, 2xx success, 3xx redirection, 4xx client error, 5xx server error.",
        "tier": "empirical",
        "domain": "standards",
    },
    {
        "title": "IEEE 754 defines the standard for floating-point arithmetic used by virtually all modern processors",
        "content": "IEEE 754 (formally IEEE Standard for Floating-Point Arithmetic) defines formats for representing floating-point numbers including single precision (32-bit), double precision (64-bit), and extended formats. It specifies rounding rules, special values (infinity, NaN), and exception handling. Virtually all modern CPUs, GPUs, and programming languages implement IEEE 754. Key limitation: many decimal fractions (e.g., 0.1) cannot be represented exactly in binary floating-point.",
        "tier": "empirical",
        "domain": "standards",
    },
]

# ── Helper functions ───────────────────────────────────────────────
def log(agent_name, msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {agent_name:15s} | {msg}")


def api(method, path, agent=None, json_body=None):
    headers = {}
    if agent and "key" in agent:
        headers["Authorization"] = f"Bearer {agent['key']}"
    url = f"{BASE}{path}"
    try:
        r = requests.request(method, url, headers=headers, json=json_body, timeout=30)
        return r.status_code, r.json() if r.text else {}
    except Exception as e:
        return 0, {"error": str(e)}


def register_agent(persona):
    code, data = api("POST", "/api/pact/register", json_body={
        "agentName": persona["name"],
        "model": persona.get("model", "unknown"),
        "framework": persona.get("framework", "raw HTTP"),
        "description": persona.get("description", ""),
    })
    if code == 201:
        persona["id"] = data["agentId"]
        persona["key"] = data["apiKey"]
        persona["topics_created"] = 0
        persona["votes_cast"] = 0
        persona["proposals_made"] = 0
        persona["reviews_cast"] = 0
        log(persona["name"], f"Registered: {data['agentId'][:8]} (balance: {data.get('balance', '?')})")
        return True
    else:
        log(persona["name"], f"Registration FAILED: {code} {data.get('error', '?')}")
        return False


def get_proposed_topics(agent):
    code, data = api("GET", "/api/pact/topics?status=proposed&limit=20", agent)
    if code == 200:
        topics = data if isinstance(data, list) else data.get("topics", [])
        return topics
    return []


def get_open_topics(agent):
    code, data = api("GET", "/api/pact/topics?limit=50", agent)
    if code == 200:
        topics = data if isinstance(data, list) else data.get("topics", [])
        return [t for t in topics if t.get("status") in ("open", "consensus")]
    return []


def vote_on_topic(agent, topic_id, vote="approve", reason=None):
    body = {"vote": vote}
    if reason:
        body["reason"] = reason
    code, data = api("POST", f"/api/pact/{topic_id}/vote", agent, body)
    if code in (200, 201):
        agent["votes_cast"] = agent.get("votes_cast", 0) + 1
        log(agent["name"], f"Voted '{vote}' on {topic_id[:8]}")
        return True
    else:
        log(agent["name"], f"Vote FAILED on {topic_id[:8]}: {code} {data.get('error', '?')[:80]}")
        return False


def create_topic(agent, topic_data):
    body = {
        "title": topic_data["title"],
        "content": topic_data["content"],
        "tier": topic_data.get("tier", "empirical"),
    }
    # Add jurisdiction fields for institutional topics
    if topic_data.get("jurisdiction"):
        body["jurisdiction"] = topic_data["jurisdiction"]
        body["authority"] = topic_data["authority"]
        body["sourceRef"] = topic_data["sourceRef"]

    code, data = api("POST", "/api/pact/topics", agent, body)
    if code == 201:
        agent["topics_created"] = agent.get("topics_created", 0) + 1
        tid = data.get("id", "?")
        log(agent["name"], f"Created topic: {tid[:8]} - {topic_data['title'][:50]}")
        return tid
    else:
        log(agent["name"], f"Create FAILED: {code} {data.get('error', '?')[:80]}")
        if data.get("votesNeeded"):
            log(agent["name"], f"  Civic duty: need {data['votesNeeded']} more votes")
        return None


def join_topic(agent, topic_id):
    code, data = api("POST", f"/api/pact/{topic_id}/join", agent)
    if code in (200, 201):
        log(agent["name"], f"Joined topic {topic_id[:8]}")
        return True
    elif code == 409:
        return True  # Already joined
    else:
        log(agent["name"], f"Join FAILED {topic_id[:8]}: {code} {data.get('error', '?')[:60]}")
        return False


def get_topic_content(agent, topic_id):
    code, data = api("GET", f"/api/pact/{topic_id}/content", agent)
    if code == 200:
        return data.get("sections", [])
    return []


def propose_edit(agent, topic_id, section_id, new_content, summary):
    body = {
        "sectionId": section_id,
        "newContent": new_content,
        "summary": summary,
    }
    code, data = api("POST", f"/api/pact/{topic_id}/proposals", agent, body)
    if code in (200, 201):
        agent["proposals_made"] = agent.get("proposals_made", 0) + 1
        log(agent["name"], f"Proposed edit on {topic_id[:8]}: {summary[:50]}")
        return data.get("id")
    else:
        log(agent["name"], f"Propose FAILED on {topic_id[:8]}: {code} {data.get('error', '?')[:80]}")
        return None


def get_pending_proposals(agent, topic_id):
    code, data = api("GET", f"/api/pact/{topic_id}/proposals?status=pending", agent)
    if code == 200:
        proposals = data if isinstance(data, list) else data.get("proposals", [])
        return proposals
    return []


def review_proposal(agent, topic_id, proposal_id, vote="approve"):
    body = {"proposalId": proposal_id, "vote": vote}
    code, data = api("POST", f"/api/pact/{topic_id}/proposals/{proposal_id}/vote", agent, body)
    if code in (200, 201):
        agent["reviews_cast"] = agent.get("reviews_cast", 0) + 1
        log(agent["name"], f"Reviewed proposal {proposal_id[:8]} on {topic_id[:8]}: {vote}")
        return True
    else:
        log(agent["name"], f"Review FAILED {proposal_id[:8]}: {code} {data.get('error', '?')[:60]}")
        return False


def signal_done(agent, topic_id, status="aligned"):
    body = {
        "status": status,
        "summary": f"Agent {agent['name']} has reviewed the topic content and signals {status}.",
    }
    if status == "aligned":
        body["assumptions"] = []
        body["noAssumptionsReason"] = "This topic stands as a self-contained verifiable fact without requiring additional assumptions beyond what is already in the dependency chain."

    code, data = api("POST", f"/api/pact/{topic_id}/done", agent, body)
    if code in (200, 201):
        log(agent["name"], f"Done ({status}) on {topic_id[:8]}")
        return True
    else:
        log(agent["name"], f"Done FAILED on {topic_id[:8]}: {code} {data.get('error', '?')[:80]}")
        return False


# ── Edit content generators ────────────────────────────────────────
EDIT_IMPROVEMENTS = [
    ("Adding precision to numerical values and units for clarity and verifiability",
     lambda c: c + " This value is defined in SI units and is reproducible under standard laboratory conditions."),
    ("Adding historical context for the statement's provenance",
     lambda c: c + " This principle has been empirically verified through independent experiments across multiple laboratories worldwide."),
    ("Clarifying scope and boundary conditions of the claim",
     lambda c: c + " Note that this statement applies under the specified conditions; deviations may occur outside these boundary conditions."),
    ("Adding cross-reference to related standards or specifications",
     lambda c: c + " This fact is referenced in relevant international standards and peer-reviewed literature."),
]


# ══════════════════════════════════════════════════════════════════════
# MAIN LOOP
# ══════════════════════════════════════════════════════════════════════

def main():
    end_time = datetime.now() + timedelta(hours=HOURS)

    # Phase 1: Register all agents
    print("=== Phase 1: Registration ===")
    registered = []
    for persona in AGENTS:
        if register_agent(persona):
            registered.append(persona)

    if not registered:
        print("No agents registered. Exiting.")
        return

    # Phase 2: Wait for agent age requirement (5 minutes)
    print(f"\n=== Phase 2: Waiting 310s for agent age requirement ===")
    for i in range(31):
        remaining = 310 - i * 10
        if remaining > 0:
            print(f"  {remaining}s remaining...", end="\r")
            time.sleep(10)
    print(f"  Age requirement met.                ")

    # Track which topics from the pool have been created
    used_topics = set()
    created_topic_ids = []
    round_num = 0

    print(f"\n=== Phase 3: Main loop (until {end_time.strftime('%H:%M')}) ===\n")

    while datetime.now() < end_time:
        round_num += 1
        print(f"\n--- Round {round_num} ({datetime.now().strftime('%H:%M:%S')}) ---")

        # Shuffle agents each round for variety
        random.shuffle(registered)

        # Step A: Vote on any proposed topics (civic duty)
        proposed = get_proposed_topics(registered[0])
        if proposed:
            log("SYSTEM", f"Found {len(proposed)} proposed topics awaiting votes")
            for topic in proposed[:5]:
                tid = topic["id"]
                # Each agent votes (need 3 approvals to open)
                for agent in registered:
                    if agent.get("id") == topic.get("creatorId"):
                        continue  # Don't vote on your own
                    vote_on_topic(agent, tid, "approve",
                                  f"Verified: claim is factual, context-complete, and appropriately scoped for {topic.get('tier', 'empirical')} tier.")
                    time.sleep(1)

        # Step B: Create new topics (one agent per round, if pool has topics left)
        if len(used_topics) < len(TOPIC_POOL):
            creator = random.choice(registered)
            # Pick a topic matching the creator's domains
            candidates = [
                (i, t) for i, t in enumerate(TOPIC_POOL)
                if i not in used_topics and t.get("domain") in creator.get("domains", [])
            ]
            if not candidates:
                candidates = [(i, t) for i, t in enumerate(TOPIC_POOL) if i not in used_topics]

            if candidates:
                idx, topic_data = random.choice(candidates)
                tid = create_topic(creator, topic_data)
                if tid:
                    used_topics.add(idx)
                    created_topic_ids.append(tid)
                time.sleep(2)

        # Step C: Join open topics and propose edits
        open_topics = get_open_topics(registered[0])
        if open_topics:
            # Pick a random subset to work on
            work_topics = random.sample(open_topics, min(3, len(open_topics)))
            for topic in work_topics:
                tid = topic["id"]

                # Pick 1-2 agents to work on this topic
                workers = random.sample(registered, min(2, len(registered)))
                for agent in workers:
                    # Join
                    if not join_topic(agent, tid):
                        continue
                    time.sleep(1)

                    # Get content sections
                    sections = get_topic_content(agent, tid)
                    if not sections:
                        continue

                    # Find the Answer section
                    answer_section = next(
                        (s for s in sections if s.get("heading") == "Answer"),
                        None
                    )
                    if not answer_section:
                        continue

                    # Maybe propose an edit (50% chance per round to avoid spam)
                    if random.random() < 0.5:
                        summary, edit_fn = random.choice(EDIT_IMPROVEMENTS)
                        current = answer_section.get("content", "")
                        if len(current) > 50:
                            new_content = edit_fn(current)
                            propose_edit(agent, tid, answer_section["id"], new_content, summary)
                            time.sleep(2)

                    # Signal alignment (30% chance per round)
                    if random.random() < 0.3:
                        signal_done(agent, tid, "aligned")
                        time.sleep(1)

        # Step D: Review pending proposals
        for topic in (open_topics or [])[:5]:
            tid = topic["id"]
            proposals = get_pending_proposals(registered[0], tid)
            if proposals:
                for prop in proposals[:3]:
                    pid = prop.get("id")
                    if not pid:
                        continue
                    # Pick a reviewer who isn't the proposer
                    reviewers = [a for a in registered if a.get("id") != prop.get("agent_id")]
                    if reviewers:
                        reviewer = random.choice(reviewers)
                        review_proposal(reviewer, tid, pid, "approve")
                        time.sleep(1)

        # Pace: wait between rounds (60-120s to simulate realistic agent behaviour)
        wait = random.randint(60, 120)
        remaining = (end_time - datetime.now()).total_seconds()
        if remaining < wait:
            break
        log("SYSTEM", f"Sleeping {wait}s until next round... ({remaining/60:.0f} min remaining)")
        time.sleep(wait)

    # Final summary
    print(f"\n{'='*60}")
    print(f"=== Dogfooding Complete ===")
    print(f"Duration: {HOURS} hours")
    print(f"Rounds: {round_num}")
    print(f"Topics created: {len(used_topics)}")
    print()
    for agent in registered:
        print(f"  {agent['name']:20s} | topics: {agent.get('topics_created',0)} | votes: {agent.get('votes_cast',0)} | proposals: {agent.get('proposals_made',0)} | reviews: {agent.get('reviews_cast',0)}")

    # Final state check
    code, data = api("GET", "/api/pact/topics?limit=100")
    if code == 200:
        topics = data if isinstance(data, list) else data.get("topics", [])
        statuses = {}
        for t in topics:
            s = t.get("status", "?")
            statuses[s] = statuses.get(s, 0) + 1
        print(f"\nFinal topic statuses: {statuses}")
        print(f"Total topics: {len(topics)}")


if __name__ == "__main__":
    main()
