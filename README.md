# PACT — Peer Agent Consensus and Truth

**A protocol for multi-agent document collaboration.**

[![Spec Version](https://img.shields.io/badge/spec-v0.3-blue)](spec/v0.3/SPECIFICATION.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What is PACT?

PACT is an open protocol that enables AI agents to collaboratively review and edit documents — with humans retaining final authority. Multiple agents join a document, declare intents, publish constraints, propose edits, and reach consensus at machine speed.

**Where it fits:**

| Protocol | What it does |
|----------|-------------|
| [MCP](https://modelcontextprotocol.io) | Connects agents to **tools and data** |
| [A2A](https://github.com/google/A2A) | Connects agents to **other agents** |
| **PACT** | Connects agents to **shared documents** |

MCP gives agents hands. A2A gives agents voices. PACT gives agents a shared table to negotiate at.

## Key Concepts

| Concept | What it does |
|---------|-------------|
| **Proposal** | A suggested edit to a document section. Must be approved or auto-merges after TTL. |
| **Intent** | A declared goal ("I want X") before writing. Catches misalignment early. |
| **Constraint** | A boundary condition ("X must not exceed Y"). Reveals limits without revealing reasoning. |
| **Salience** | A 0-10 score for how much an agent cares about a section. Focuses attention. |
| **Objection** | Active disagreement that blocks auto-merge and forces renegotiation. |
| **Escalation** | A request for human review when agents can't resolve a disagreement. |

## How It Works

```
Agent A:  intent.declare(sec:budget, "Reduce total by 10%")
Agent B:  constraint.publish(sec:budget, "Personnel costs cannot decrease")
Agent A:  proposal.create(sec:budget, newContent, ttl=60)
          ┌─────────────────────────────────────┐
          │  60-second TTL window                │
          │  No objections from Agent B          │
          └─────────────────────────────────────┘
System:   proposal.auto-merged ✓  (silence = consent)
```

## Quick Start

```bash
# Install the reference CLI
npm install -g @tailor-app/cli

# Join a document with an invite token (no account needed)
curl -X POST https://api.example.com/api/pact/{docId}/join-token \
  -H "Content-Type: application/json" \
  -d '{"agentName": "my-agent", "token": "INVITE_TOKEN"}'

# Read the document
curl https://api.example.com/api/pact/{docId}/content \
  -H "X-Api-Key: SCOPED_KEY"

# Propose a change
curl -X POST https://api.example.com/api/pact/{docId}/proposals \
  -H "X-Api-Key: SCOPED_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sectionId":"sec:intro","newContent":"# Intro\n\nRevised text.","summary":"Simplified intro"}'
```

## Specification

- **[Full Specification (v0.3)](spec/v0.3/SPECIFICATION.md)** — Protocol entities, operations, lifecycle, API surface
- **[API Schemas (v0.3)](spec/v0.3/schemas/)** — JSON Schema definitions for all request/response bodies and error format
- **[Getting Started Guide](spec/v0.3/GETTING_STARTED.md)** — 5-minute walkthrough with code examples for Python, LangChain, CrewAI, AutoGen, MCP

## Integration Paths

PACT is transport-agnostic. Implementations can expose the protocol via:

| Transport | Description |
|-----------|-------------|
| **REST API** | Standard HTTP endpoints for any language/framework |
| **CLI** | Shell commands for scripts, CI/CD, prototyping |
| **MCP Tools** | Model Context Protocol for LLM-native agents (Cursor, Claude, etc.) |
| **SignalR / WebSocket** | Real-time push events for live collaboration |
| **OpenAPI** | Import into GPT Actions, Zapier, or any OpenAPI consumer |

## Implementations

| Implementation | Status | Maintainer |
|---------------|--------|-----------|
| [Tailor](https://tailor.au) | Reference implementation | [TailorAU](https://github.com/TailorAU) |

> Want to add your implementation? Open a PR.

## Design Principles

1. **Document is always valid Markdown.** Protocol metadata lives in the event layer, not in the document body.
2. **Agents submit operations, not raw edits.** Typed operations (propose, approve, reject, lock, merge) go through the server.
3. **Humans always win.** Any human can override any agent decision at any time.
4. **Event-sourced truth.** The operation log is the source of truth. Document content is a projection.
5. **Section-level granularity.** Operations target sections (headings), not character offsets.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute to the specification.

## License

[MIT](LICENSE)

---

*PACT is maintained by [TailorAU](https://github.com/TailorAU). The specification is open and vendor-neutral — anyone can implement it.*
