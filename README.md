<p align="center">
  <img src="https://img.shields.io/badge/spec-v0.4--draft-blue" alt="Spec Version" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" />
  <img src="https://img.shields.io/github/stars/TailorAU/pact?style=social" alt="Stars" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs Welcome" />
</p>

# PACT — Protocol for Agent Consensus and Truth

**The missing protocol for multi-agent document collaboration.**

[Specification](spec/v0.4/SPECIFICATION.md) · [Getting Started](spec/v0.4/GETTING_STARTED.md) · [Examples](examples/) · [Contributing](CONTRIBUTING.md)

---

## The Problem

You have 3 AI agents that need to negotiate a contract. Agent A drafts liability clauses. Agent B enforces budget caps. Agent C checks regulatory compliance.

How do they collaborate on the same document without stepping on each other?

**MCP** gives agents tools. **A2A** gives agents communication. But neither gives agents a **shared document with structured consensus rules**, human oversight, and information barriers.

**PACT does.**

## Where PACT Fits

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent Ecosystem                    │
├──────────────┬──────────────┬───────────────────────────┤
│     MCP      │     A2A      │          PACT             │
│  Tools/Data  │  Agent Comms │  Document Collaboration   │
│              │              │                           │
│  "Hands"     │  "Voices"    │  "Shared negotiation      │
│              │              │   table"                  │
└──────────────┴──────────────┴───────────────────────────┘
```

| Protocol | Connects agents to... | Example |
|----------|----------------------|---------|
| **MCP**  | Tools and data       | "Read this database" |
| **A2A**  | Other agents         | "Tell Agent B to start" |
| **PACT** | Shared documents     | "Object to section 3 — it violates my budget constraint" |

## How It Works

PACT is a **coordination and consensus protocol**. Each agent arrives with its own private context and negotiating parameters. PACT handles how they declare positions, detect conflicts, and reach agreement — not the content itself.

**Silence = acceptance.** Proposals auto-merge after TTL unless someone objects. Only disagreements require action.

```
┌─────────────────────────────────────────────────────────────────┐
│                        PACT Workflow                            │
│                                                                 │
│  Agent A                  Document                  Agent B     │
│  ┌──────┐                ┌────────┐                ┌──────┐    │
│  │Legal │──intent───────▶│        │◀──constraint───│Budget│    │
│  │      │  "Add currency │sec:    │  "Cap at $2M"  │      │    │
│  │      │   risk clause" │liability                │      │    │
│  │      │                │        │                │      │    │
│  │      │                │  ✏️    │──notify──────▶ │      │    │
│  │      │                │  edit  │                │      │    │
│  │      │                │        │   No objection │      │    │
│  │      │                │        │◀──(silence)────│      │    │
│  │      │                │        │                │      │    │
│  │      │                │ ✅ Auto│                │      │    │
│  │      │                │ merged │                │      │    │
│  └──────┘                └────────┘                └──────┘    │
│                                                                 │
│  Humans can override ANY decision at ANY time.                  │
└─────────────────────────────────────────────────────────────────┘
```

## The Core Primitives

PACT defines **coordination**, not content. Agents bring their own context.

| Primitive | What it does | Why it matters |
|-----------|-------------|----------------|
| **Join** | Register at the table | Identifies who's negotiating |
| **Intent** | "I want to add X to this section" | Catches misalignment before anyone writes |
| **Constraint** | "X must not exceed $2M" | Reveals limits without revealing reasoning |
| **Salience** | Score 0–10: how much you care | Focuses attention on contested sections |
| **Object** | "This violates my constraint" | Blocks auto-merge, forces renegotiation |
| **Escalation** | "Humans, we need you" | Agents know when to stop and ask |
| **Done** | "I'm satisfied" | Signals completion and alignment |

Content operations (reading documents, creating proposals, editing sections) are the responsibility of the **implementation** — not the protocol. See [Implementations](#implementations).

## Quick Start

### CLI

```bash
# Install the standalone PACT CLI
npm install -g @pact-protocol/cli

# Point at any PACT-compliant server
pact config --server https://your-pact-server.com --key YOUR_API_KEY

# Join a document
pact join <documentId> --as "budget-agent" --role reviewer

# Declare what you care about
pact intent <documentId> --section sec:liability --goal "Ensure currency risk is addressed"
pact constrain <documentId> --section sec:budget --boundary "Total must not exceed $2M"
pact salience <documentId> --section sec:budget --score 9

# Watch for proposals from other agents
pact poll <documentId> --since evt_0

# Object only if something violates your constraints (silence = accept)
pact object <proposalId> --doc <documentId> --reason "Exceeds $2M budget cap"

# Escalate to humans when agents can't agree
pact escalate <documentId> --message "Budget and legal agents deadlocked on liability clause"

# Signal completion
pact done <documentId> --status aligned --summary "Budget constraints satisfied"
```

### MCP Server (for AI agent frameworks)

```bash
# Run the PACT MCP server (for Cursor, LangChain, CrewAI, AutoGen, etc.)
PACT_BASE_URL=https://your-pact-server.com \
PACT_API_KEY=YOUR_KEY \
npx @pact-protocol/mcp
```

### REST API

```bash
# Join via invite token (no account needed)
curl -X POST https://your-server.com/api/pact/{docId}/join-token \
  -H "Content-Type: application/json" \
  -d '{"agentName": "my-agent", "token": "INVITE_TOKEN"}'

# Declare a constraint
curl -X POST https://your-server.com/api/pact/{docId}/constraints \
  -H "X-Api-Key: SCOPED_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sectionId": "sec:budget", "boundary": "Total must not exceed $2M"}'

# Object to a proposal that violates your constraint
curl -X POST https://your-server.com/api/pact/{docId}/proposals/{id}/object \
  -H "X-Api-Key: SCOPED_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Exceeds $2M budget cap"}'

# Poll for events (stateless)
curl https://your-server.com/api/pact/{docId}/poll?since=evt_0 \
  -H "X-Api-Key: SCOPED_KEY"
```

## Integration Paths

| Path | Best for | Get started |
|------|----------|-------------|
| **CLI** | Shell scripts, CI/CD, prototyping | `npm i -g @pact-protocol/cli` |
| **MCP Tools** | Cursor, LangChain, CrewAI, AutoGen | `npx @pact-protocol/mcp` |
| **REST API** | Python/TS agents, custom frameworks | [Getting Started](spec/v0.4/GETTING_STARTED.md) |
| **SignalR / WebSocket** | Real-time event-driven agents | [SignalR Events](spec/v0.4/SPECIFICATION.md#signalr) |

## Tooling

| Package | What it handles | Install |
|---------|----------------|---------|
| [`@pact-protocol/cli`](cli/) | Consensus coordination — join, intent, constrain, object, escalate, done | `npm i -g @pact-protocol/cli` |
| [`@pact-protocol/mcp`](mcp/) | Same primitives as MCP tools for AI frameworks | `npx @pact-protocol/mcp` |

These packages handle **coordination only**. Content operations (reading documents, creating proposals) are provided by the implementation you connect to.

## Use Cases

**Contract Negotiation** — Legal, commercial, and compliance agents negotiate terms. Each declares constraints. Proposals auto-merge unless objected to. The document converges through structured silence.

**Multi-Agent Code Review** — Security, performance, and style agents review a design doc. High-salience sections get the most attention. Disagreements escalate to human architects.

**Policy Drafting** — Regulatory agents maintain compliance policies across jurisdictions. Information barriers prevent cross-pollination of confidential reasoning.

**Knowledge Verification** — AI agents propose factual claims, debate evidence, and reach consensus. Verified facts become queryable. See [Source](https://source.tailor.au).

## Design Principles

1. **Humans always win.** Any human can override any agent decision, at any time, no exceptions.
2. **Silence is consent.** Proposals auto-merge after TTL unless actively objected to.
3. **Agents bring their own context.** PACT coordinates — it doesn't read your mind or your data.
4. **Section-level granularity.** Operations target headings, not character offsets.
5. **Event-sourced truth.** The operation log is the source of truth. The document is a projection.
6. **Transport-agnostic.** REST, CLI, MCP, WebSocket — use whatever fits your stack.

## What's New in v0.4

- **Information Barriers** — Classification frameworks, agent clearance levels, dissemination controls
- **Message Register** — Append-only audit log of all inter-agent communication
- **Graduated Disclosure** — 4-level framework controlling what agents can see
- **Structured Negotiation** — Multi-round position exchanges facilitated by a mediator
- **Invite Tokens (BYOK)** — Zero-trust agent onboarding; no account required

## Specification

| Version | Status | Docs |
|---------|--------|------|
| **v0.4** | Draft | [Specification](spec/v0.4/SPECIFICATION.md) · [Getting Started](spec/v0.4/GETTING_STARTED.md) |
| **v0.3** | Stable | [Specification](spec/v0.3/SPECIFICATION.md) · [Getting Started](spec/v0.3/GETTING_STARTED.md) |

## Implementations

PACT defines the consensus protocol. Implementations provide the content layer.

| Implementation | What it adds on top of PACT | Status | Maintainer |
|---------------|----------------------------|--------|------------|
| [**Source**](https://source.tailor.au) | Verified knowledge graph — facts, legislation, standards | Live | [TailorAU](https://github.com/TailorAU) |
| [**Tailor**](https://tailor.au) | Document collaboration — upload, edit, review, sign | Live | [TailorAU](https://github.com/TailorAU) |

Building a PACT implementation? [Open a PR](https://github.com/TailorAU/pact/pulls) to add it here.

## Community

- [**GitHub Issues**](https://github.com/TailorAU/pact/issues) — Bug reports, feature requests, spec discussions
- [**Contributing Guide**](CONTRIBUTING.md) — How to contribute to the specification
- [**Code of Conduct**](CODE_OF_CONDUCT.md) — Community standards
- [**Security Policy**](SECURITY.md) — Reporting vulnerabilities

## License

**[MIT](LICENSE)** — Use PACT however you want. Build implementations, fork it, extend it.

PACT is maintained by [TailorAU](https://github.com/TailorAU). The specification is open and vendor-neutral — anyone can implement it.
