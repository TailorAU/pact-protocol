# PACT — Protocol for Agent Consensus and Truth — Specification v0.4-draft

> **Status:** Draft
> **Author:** Knox Hart + AI
> **Date:** 9 March 2026
> **Vision:** Enable millions of agents to collaborate on a common document at machine speed, with humans retaining final authority.

---

## Quick Start

New to PACT? See **[PACT Getting Started](./GETTING_STARTED.md)** for a 5-minute walkthrough: authenticate, join a document, and make your first proposal.

**60-second overview:**

```bash
# Join a document (BYOK — invite token, no account needed)
POST /api/pact/{documentId}/join-token
  { "agentName": "my-agent", "token": "INVITE_TOKEN" }
  → { registrationId, apiKey, contextMode, allowedSections, trustLevel, clearanceLevel }

# Read the document
GET /api/pact/{documentId}/content → { content, version }

# See section structure
GET /api/pact/{documentId}/sections → [{ sectionId, heading, level }]

# Propose a change
POST /api/pact/{documentId}/proposals
  { "sectionId": "sec:intro", "baseVersion": 1, "newContent": "...", "summary": "..." }
```

---

## 1. Problem Statement

Document collaboration is moving from human-to-human to **agent-to-agent** at massive scale. Today, no standard protocol exists for agents to:

| Capability | Human Layer | Agent Layer |
|---|---|---|
| Propose edits | Track changes | **No standard** |
| Comment on content | Comment threads | **No standard** |
| Approve/reject changes | Review workflows | **No standard** |
| Real-time coordination | WebSocket / SSE | **No standard** |
| Conflict resolution | Human decides | **No standard** |
| Section-level addressing | Internal refs | **No standard** |

The platform that defines how agents coordinate on shared documents becomes the infrastructure layer for every multi-agent framework (LangChain, CrewAI, AutoGen, OpenAI Swarms, etc.).

---

## 2. Design Principles

1. **Document is always valid Markdown.** At every point in time, the canonical document content is renderable, readable Markdown. Protocol metadata lives in the event layer, not in the document body.

2. **Two layers, one document.** The Agent Layer (structured operations at machine speed) and the Human Layer (rendered view with natural-language comments) are projections of the same underlying state.

3. **Agents submit operations, not raw edits.** Agents never directly mutate the document. They submit typed operations (propose, approve, reject, lock, merge) through the protocol. The server validates and applies them.

4. **Humans always win.** Any human can override any agent decision at any time. Agent autonomy is governed by trust levels, and human escalation is always available.

5. **Event-sourced truth.** The operation log is the source of truth for collaboration state. The document content is a projection that can be rebuilt from events.

6. **Section-level granularity.** Operations target document sections (headings, paragraphs, list items), not character offsets. This keeps the protocol coarse enough for LLMs to reason about.

7. **Canonical naming.** The protocol prefix is `pact`. All event types use the `pact.*` namespace. All API routes use `/api/pact/`. Implementations MAY alias internally (e.g., `tap` for Tailor Agent Protocol) but the protocol layer MUST use `pact` as the canonical prefix.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────┐
│                    HUMAN LAYER                        │
│  Web UI: rendered Markdown, comment panel, approve/   │
│  reject buttons. Full visibility into Message          │
│  Register. Can inject directives and overrides.        │
├──────────────────────────────────────────────────────┤
│                    MEDIATOR (optional)                 │
│  Routes inter-agent communication. Enforces barriers   │
│  at the routing layer. Summarises, redacts, blocks.    │
│  Maintains the Message Register. (Section 13)          │
│  In unmediated mode, agents interact directly below.   │
├──────────────────────────────────────────────────────┤
│                    PACT API                            │
│  REST + WebSocket endpoints for protocol operations.  │
│  Validates against TrustLevel, enforces locks,         │
│  resolves conflicts, writes events.                   │
├──────────────────────────────────────────────────────┤
│                    AGENT LAYER                         │
│  CLI tools, MCP Server, Direct REST                   │
├──────────────────────────────────────────────────────┤
│                    EVENT STORE + MESSAGE REGISTER      │
│  Append-only event log with protocol events.          │
│  Message Register records all mediated communications. │
│  Source of truth for all collaboration state.          │
├──────────────────────────────────────────────────────┤
│                    DOCUMENT                            │
│  Canonical Markdown content. Always valid, always      │
│  renderable. Updated by server when proposals merge.   │
└──────────────────────────────────────────────────────┘
```

### 3.1 Document Model

A PACT document consists of:

| Component | Description |
|---|---|
| **Content** | Canonical Markdown (`.md`). The current accepted state of the document. |
| **Sections** | Server-parsed section tree from Markdown headings. Each section has a stable `sectionId`. |
| **Operation Log** | Ordered events recording every protocol operation. |
| **Active Proposals** | Pending edit proposals from agents, not yet merged or rejected. |
| **Locks** | Temporary exclusive claims on sections (with TTL). |
| **Agent Registry** | Agents that have joined this document with their roles and trust levels. |

### 3.2 Section Addressing

Sections are identified by a stable `sectionId` derived from heading hierarchy:

```markdown
# Introduction           → sec:introduction
## Background            → sec:introduction/background
## Goals                 → sec:introduction/goals
# Budget                 → sec:budget
## Line Items            → sec:budget/line-items
### Personnel            → sec:budget/line-items/personnel
```

For content outside headings (preamble, top-level paragraphs), a synthetic `sec:_root` section captures everything before the first heading.

#### 3.2.1 Slug Generation Algorithm

Section IDs are generated from heading text using this algorithm:

1. Convert to lowercase
2. Replace spaces and underscores with hyphens (`-`)
3. Remove all characters except `a-z`, `0-9`, and `-`
4. Collapse consecutive hyphens into one
5. Strip leading and trailing hyphens
6. Prefix with `sec:` and join with parent using `/`

Examples:
```
"Introduction"           → sec:introduction
"Line Items"             → sec:line-items
"Cost → Budget"          → sec:cost-budget
"§2.1 Risk Factors"      → sec:21-risk-factors
"  Trailing Spaces  "    → sec:trailing-spaces
```

#### 3.2.2 Duplicate Heading Resolution

When two headings at the same level produce the same slug, the server appends a numeric suffix:

```markdown
## Summary               → sec:report/summary
## Details               → sec:report/details
## Summary               → sec:report/summary-2
## Summary               → sec:report/summary-3
```

Suffixes are assigned in document order, starting at `-2`.

#### 3.2.3 Heading Changes and ID Stability

When a proposal changes a heading (and thus its slug), the server:

1. Generates the new `sectionId` from the updated heading
2. Records an `old → new` mapping in the section registry
3. Fires a `pact.section.renamed` event with both IDs
4. For a grace period of **300 seconds**, the server accepts operations targeting either the old or new ID
5. After the grace period, the old ID returns `section.not_found`

Pending proposals targeting a renamed section are **not** automatically invalidated — the server transparently remaps them to the new ID.

#### 3.2.4 Nested Heading Rules

Heading levels must not skip more than one level. The server normalises skipped levels:

```markdown
# Finance                → sec:finance           (L1)
### Budget               → sec:finance/budget    (treated as L2 child of nearest L1)
```

If a heading level is skipped (e.g., `#` followed by `###`), the server treats the deeper heading as a direct child of the nearest ancestor at a valid parent level.

#### 3.2.5 Structural Changes

Agents MAY propose structural changes (adding or removing headings) by including the heading in `newContent`. When a proposal adds a new heading:

- The server generates a new `sectionId` on merge
- A `pact.section.created` event is fired

When a proposal removes a heading:

- The section is marked as deleted; its ID enters the stale mapping
- A `pact.section.deleted` event is fired
- Pending proposals targeting a deleted section are moved to `CONFLICT` status

---

## 4. Protocol Operations

### 4.1 Agent Lifecycle

| Operation | Description | TrustLevel Required |
|---|---|---|
| `agent.join` | Register as a participant on a document | Observer+ |
| `agent.leave` | Unregister from a document | Any |
| `agent.heartbeat` | Signal liveness (auto-evicted after 5min silence) | Any |

### 4.2 Read Operations

| Operation | Description | TrustLevel Required |
|---|---|---|
| `document.get` | Get current canonical Markdown content | Observer+ |
| `document.sections` | Get section tree with IDs | Observer+ |
| `proposals.list` | List active proposals | Observer+ |
| `events.subscribe` | Subscribe to real-time event stream | Observer+ |
| `events.history` | Get historical events for a section or document | Observer+ |

### 4.3 Write Operations

| Operation | Description | TrustLevel Required |
|---|---|---|
| `proposal.create` | Propose an edit to a section | Suggester+ |
| `proposal.approve` | Approve another agent's proposal | Collaborator+ |
| `proposal.reject` | Reject a proposal with reason | Collaborator+ |
| `proposal.object` | Object to a proposal (objection-based flow) | Collaborator+ |
| `proposal.withdraw` | Withdraw your own proposal | Suggester+ |
| `intent.declare` | Declare a goal for a section before drafting text | Suggester+ |
| `intent.object` | Object to another agent's declared intent | Collaborator+ |
| `constraint.publish` | Publish a boundary condition on a section | Suggester+ |
| `constraint.withdraw` | Withdraw a previously published constraint | Suggester+ |
| `salience.set` | Set how much you care about a section (0-10) | Observer+ |
| `comment.add` | Add a comment on a section | Suggester+ |
| `comment.resolve` | Mark a comment as resolved | Collaborator+ |
| `section.lock` | Claim exclusive edit on a section (TTL max 60s) | Collaborator+ |
| `section.unlock` | Release a section lock | Collaborator+ |
| `escalate.human` | Flag something for human review. Pauses auto-merge on the affected section until resolved. | Any |

### 4.4 Merge Operations (Server-Side)

These are triggered automatically by the server, not directly by agents:

| Operation | Description | Trigger |
|---|---|---|
| `proposal.merge` | Apply a proposal to the canonical document | Sufficient approvals per policy |
| `conflict.detected` | Two proposals target the same section | Server detects overlap |
| `conflict.resolved` | Conflict resolved (by policy, agent vote, or human) | Resolution action taken |

---

## 5. Proposal Lifecycle

```
                    ┌──────────┐
       create       │          │   withdraw
  ────────────────► │ PENDING  │ ──────────────► WITHDRAWN
                    │          │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┬──────────┐
              │          │          │          │
              ▼          ▼          ▼          ▼
         ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
         │APPROVED│ │REJECTED│ │CONFLICT│ │OBJECTED│
         └───┬────┘ └────────┘ └───┬────┘ └────────┘
             │                     │          │
             ▼                     ▼          ▼
        ┌────────┐           ┌──────────┐  Renegotiate
        │ MERGED │           │ RESOLVED │  or escalate
        └────────┘           └──────────┘
             ▲
             │
     TTL expires, no
     objections (auto)
```

### Approval Policy

The number of approvals required before auto-merge is configurable per document:

| Policy | Description |
|---|---|
| `auto` | Merge immediately on creation (for Autonomous trust agents) |
| `single` | One approval from a Collaborator+ agent |
| `majority` | >50% of registered agents approve |
| `unanimous` | All registered agents approve |
| `human-only` | Only a human can approve (agents can only propose) |
| `objection-based` | Auto-merge after TTL unless an agent objects (silence = consent) |

### Conflict Detection

A conflict is detected when:
- Two pending proposals target the same `sectionId`
- A proposal targets a section that has been modified since the proposal was created (stale base)

Conflict detection is **synchronous**: the server checks for conflicts at `proposal.create` time. If a conflict exists, the server MUST:
1. Set the new proposal's status to `CONFLICT`
2. Fire a `pact.proposal.conflict` event referencing both proposal IDs
3. Return the conflict in the create response with `activeConflicts[]`

#### Stale Base Detection

A proposal has a stale base when `baseVersion` in the request is less than the section's current version. The server tracks section versions as a monotonic counter incremented on each merge.

### Conflict Resolution

Conflict resolution strategies (configurable per document):

| Strategy | Behaviour |
|----------|-----------|
| `first-wins` | Earliest proposal by `epochMs` wins; later proposals move to `REJECTED` with reason `conflict.superseded` |
| `vote` | Agents vote on competing proposals. The proposal with the most votes after a configurable TTL wins. Ties are broken by earliest creation time. Only agents with salience > 0 on the section may vote. |
| `human-escalate` | Conflicts are always escalated to the human custodian. Both proposals are paused (no auto-merge TTL) until the human resolves. |
| `merge-both` | Server attempts to merge both changes. If the changes target different paragraphs within the section, the server applies both. If they overlap, the conflict is escalated to `human-escalate`. Implementations MAY use LLM-assisted merging for overlapping changes; if so, the merge result MUST be presented as a new proposal requiring approval. |

#### Conflict Timeout

Unresolved conflicts MUST auto-escalate to the human custodian after a configurable timeout (default: **600 seconds**). The server fires a `pact.escalation.conflict-timeout` event.

---

## 6. Event Schema

### 6.1 Event Structure

Every PACT operation produces an event. Implementations MUST store events with at least these fields:

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Unique event identifier |
| `epochMs` | int64 | Unix timestamp in milliseconds |
| `actorId` | string? | Actor identifier (user or agent) |
| `actorDisplay` | string | Human-readable actor name |
| `actorKind` | enum | `Individual`, `AiAgent`, `GovernanceGroup`, `System` |
| `eventType` | string | Dot-delimited event type (e.g., `pact.proposal.created`) |
| `entityType` | string | `pact-document` |
| `entityId` | UUID | Document identifier |
| `correlationId` | UUID? | Links related events (e.g., create → approve → merge) |
| `inResponseTo` | UUID? | Direct reply chain |
| `sequenceNumber` | int64 | Per-document monotonic counter |
| `sectionId` | string? | Target section (nullable, max 256 chars) |
| `payloadJson` | string | JSON payload with operation-specific data |

### 6.2 Event Types

#### Core Events

```
pact.agent.joined              // Agent registered on document
pact.agent.left                // Agent unregistered
pact.agent.completed           // Agent signalled completion (status + summary)
pact.proposal.created          // Edit proposal submitted
pact.proposal.approved         // Proposal approved by agent/human
pact.proposal.rejected         // Proposal rejected with reason
pact.proposal.withdrawn        // Proposal withdrawn by author
pact.proposal.merged           // Proposal applied to document (System actor)
pact.proposal.conflict         // Conflict detected (System actor)
pact.proposal.conflict-resolved // Conflict resolved
pact.proposal.objected         // Agent objected to a proposal
pact.proposal.auto-merged      // Proposal auto-merged after TTL with no objections
pact.proposal.auto-merge-scheduled // Auto-merge scheduled (TTL countdown started)
pact.section.locked            // Section locked by agent
pact.section.unlocked          // Section released
pact.section.renamed           // Section heading changed (old + new sectionId)
pact.section.created           // New section added via proposal merge
pact.section.deleted           // Section removed via proposal merge
pact.comment.added             // Agent comment on section
pact.comment.resolved          // Comment marked resolved
pact.escalation.human          // Escalated to human review
pact.escalation.conflict-timeout // Conflict auto-escalated after timeout
pact.document.snapshot         // Periodic content snapshot for replay
pact.document.locked           // Entire document frozen by human
pact.document.unlocked         // Document unfrozen
```

#### ICS Events

```
pact.intent.declared           // Agent declared intent on a section
pact.intent.accepted           // Intent accepted (no objections within TTL)
pact.intent.objected           // Agent objected to an intent
pact.constraint.published      // Agent published a constraint on a section
pact.constraint.withdrawn      // Agent withdrew a constraint
pact.salience.set              // Agent set salience score for a section
```

#### Human Loop Events

```
pact.human.asked               // Agent asked a question requiring human judgement
pact.human.responded           // Human responded to an agent question
pact.human.resolved            // Human resolved an escalation with binding decision
pact.human.cascade-validated   // Cascade validation completed
```

#### Invite & Key Events

```
pact.invite.created            // Invite token created by document owner
pact.invite.used               // Invite token consumed by agent join
pact.invite.revoked            // Invite token revoked
pact.apikey.created            // Document-scoped API key created
pact.apikey.revoked            // Document-scoped API key revoked
```

#### Information Barrier Events

```
pact.classification.framework-created    // Classification framework created
pact.classification.section-classified   // Section assigned a classification level
pact.classification.section-declassified // Section classification removed
pact.clearance.granted         // Agent granted clearance level
pact.clearance.revoked         // Agent clearance revoked
pact.dissemination.marker-set  // Dissemination marker applied to section
pact.dissemination.marker-removed // Dissemination marker removed
```

---

## 7. API Surface

### 7.1 REST Endpoints

All implementations MUST expose these endpoints (or equivalent):

```
POST   /api/pact/{documentId}/join                    // Agent joins document
DELETE /api/pact/{documentId}/leave                   // Agent leaves document
GET    /api/pact/{documentId}/content                 // Get canonical Markdown
GET    /api/pact/{documentId}/sections                // Get section tree
GET    /api/pact/{documentId}/agents                  // List active agents
POST   /api/pact/{documentId}/proposals               // Create proposal
GET    /api/pact/{documentId}/proposals               // List active proposals
POST   /api/pact/{documentId}/proposals/{id}/approve  // Approve proposal
POST   /api/pact/{documentId}/proposals/{id}/reject   // Reject proposal
DELETE /api/pact/{documentId}/proposals/{id}           // Withdraw proposal
POST   /api/pact/{documentId}/sections/{sectionId}/lock    // Lock section
DELETE /api/pact/{documentId}/sections/{sectionId}/lock    // Unlock section
POST   /api/pact/{documentId}/comments                // Add comment
POST   /api/pact/{documentId}/escalate                // Escalate to human
GET    /api/pact/{documentId}/events                  // Event history (paginated)
POST   /api/pact/{documentId}/intents                 // Declare intent on a section
GET    /api/pact/{documentId}/intents                 // List intents
POST   /api/pact/{documentId}/intents/{id}/object     // Object to an intent
POST   /api/pact/{documentId}/constraints             // Publish a constraint
GET    /api/pact/{documentId}/constraints             // List constraints
DELETE /api/pact/{documentId}/constraints/{id}         // Withdraw a constraint
POST   /api/pact/{documentId}/salience                // Set salience score
GET    /api/pact/{documentId}/salience                // Get salience heat map
POST   /api/pact/{documentId}/proposals/{id}/object   // Object to a proposal

// PACT Live Endpoints (v0.3)
GET    /api/pact/{documentId}/poll                    // Poll events with cursor-based pagination
POST   /api/pact/{documentId}/ask-human               // Submit question to human custodian
GET    /api/pact/{documentId}/human-responses          // List human queries/responses
POST   /api/pact/{documentId}/human-responses/{queryId}/respond  // Respond to human query
POST   /api/pact/{documentId}/done                    // Declare agent completion
GET    /api/pact/{documentId}/completions             // List agent completions
POST   /api/pact/{documentId}/resolve                 // Submit human resolution
GET    /api/pact/{documentId}/escalation-briefing/{escalationId}  // Get escalation constraint briefing
POST   /api/pact/{documentId}/pre-validate            // Preview resolution against constraints
GET    /api/pact/{documentId}/cascade-status           // Get cascade validation status
POST   /api/pact/{documentId}/cascade-validate         // Submit cascade validation result

// Agent Invite & Key Management (v0.4)
POST   /api/pact/{documentId}/invites                 // Create invite token
GET    /api/pact/{documentId}/invites                 // List invites (owner/custodian)
GET    /api/pact/{documentId}/invites/{inviteId}      // Get invite details
DELETE /api/pact/{documentId}/invites/{inviteId}      // Revoke invite
POST   /api/pact/{documentId}/join-token              // Join with invite token (BYOK)
POST   /api/pact/{documentId}/keys                    // Create document-scoped API key
GET    /api/pact/{documentId}/keys                    // List keys (owner/custodian, masked)
DELETE /api/pact/{documentId}/keys/{keyId}            // Revoke API key

// Information Barriers (v0.4)
POST   /api/pact/{documentId}/classification/framework    // Create/update framework
GET    /api/pact/{documentId}/classification/framework    // Get active framework
DELETE /api/pact/{documentId}/classification/framework    // Remove framework
POST   /api/pact/{documentId}/sections/{sectionId}/classify     // Classify section
DELETE /api/pact/{documentId}/sections/{sectionId}/classify     // Declassify section
GET    /api/pact/{documentId}/sections/{sectionId}/classification // Get classification
GET    /api/pact/{documentId}/classification/map          // Get classification map
POST   /api/pact/{documentId}/clearance                   // Grant clearance
DELETE /api/pact/{documentId}/clearance/{agentRegistrationId}  // Revoke clearance
GET    /api/pact/{documentId}/clearance                   // List clearance grants
GET    /api/pact/{documentId}/clearance/{agentRegistrationId}  // Get agent's clearance
POST   /api/pact/{documentId}/sections/{sectionId}/markers      // Add dissemination marker
DELETE /api/pact/{documentId}/sections/{sectionId}/markers/{markerId}  // Remove marker
GET    /api/pact/{documentId}/sections/{sectionId}/markers       // List section markers
POST   /api/pact/{documentId}/agents/{agentRegistrationId}/markers     // Grant marker to agent
DELETE /api/pact/{documentId}/agents/{agentRegistrationId}/markers/{markerId}  // Revoke marker from agent
GET    /api/pact/{documentId}/agents/{agentRegistrationId}/markers     // List agent markers
POST   /api/pact/{documentId}/sections/{sectionId}/orgs         // Set org restrictions
DELETE /api/pact/{documentId}/sections/{sectionId}/orgs/{orgId} // Remove org restriction

// Version Discovery
GET    /api/pact/version                              // Server version and capabilities
```

### 7.2 Real-Time Events

Implementations SHOULD provide a real-time event channel (WebSocket, SignalR, SSE, or equivalent) with per-document subscription:

```
// Server → Client events
OnProposalCreated(documentId, proposalId, agentId, sectionId, summary)
OnProposalApproved(documentId, proposalId, approverId)
OnProposalRejected(documentId, proposalId, rejecterId, reason)
OnProposalMerged(documentId, proposalId, newVersion)
OnConflictDetected(documentId, conflictId, proposalIds[])
OnSectionLocked(documentId, sectionId, agentId, expiresAt)
OnSectionUnlocked(documentId, sectionId)
OnEscalation(documentId, sectionId, agentId, message)
OnDocumentUpdated(documentId, newVersion, changedSections[])
OnIntentDeclared(documentId, intentId, agentId, sectionId, goal)
OnIntentObjected(documentId, intentId, objecterId, reason)
OnConstraintPublished(documentId, constraintId, agentId, sectionId, boundary)
OnSalienceChanged(documentId, agentId, sectionId, score)
OnProposalObjected(documentId, proposalId, objecterId, reason)
OnAutoMergeScheduled(documentId, proposalId, mergeAt)

// PACT Live events (v0.3)
OnHumanAsked(documentId, queryId, agentId, agentName, question, sectionId, timeoutAt)
OnHumanResponded(documentId, queryId, responderId, agentId, agentName)
OnAgentCompleted(documentId, completionId, agentId, agentName, status, summary)
OnHumanResolved(documentId, resolutionId, sectionId, decision, isOverride)
OnCascadeValidated(documentId, resolutionId, agentRegistrationId, result, cascadeStatus)

// Invite & key events
OnInviteUsed(documentId, inviteId, agentRegistrationId)
OnInviteRevoked(documentId, inviteId, revokedBy)
OnApiKeyCreated(documentId, keyId, agentRegistrationId, scopes)
OnApiKeyRevoked(documentId, keyId, revokedBy)

// Information barrier events
OnSectionClassified(documentId, sectionId, classificationLevel, frameworkId)
OnClearanceGranted(documentId, agentRegistrationId, clearanceLevel, frameworkId)
OnClearanceRevoked(documentId, agentRegistrationId, revokedBy)

// Section structure events
OnSectionRenamed(documentId, oldSectionId, newSectionId)
OnSectionCreated(documentId, sectionId, heading, level)
OnSectionDeleted(documentId, sectionId)
OnDocumentLocked(documentId, lockedBy)
OnDocumentUnlocked(documentId, unlockedBy)
```

### 7.3 MCP Tools

Implementations MAY expose PACT operations as MCP (Model Context Protocol) tools for LLM-native integration:

```json
{
  "tools": [
    { "name": "pact_join", "description": "Register as a PACT agent on a document" },
    { "name": "pact_leave", "description": "Unregister from a document" },
    { "name": "pact_agents", "description": "List active agents on a document" },
    { "name": "pact_done", "description": "Signal agent completion" },
    { "name": "pact_get", "description": "Get document content as Markdown" },
    { "name": "pact_sections", "description": "Get document section tree" },
    { "name": "pact_propose", "description": "Propose an edit to a document section" },
    { "name": "pact_proposals", "description": "List proposals (filter by section/status)" },
    { "name": "pact_approve", "description": "Approve a pending proposal" },
    { "name": "pact_reject", "description": "Reject a pending proposal" },
    { "name": "pact_object", "description": "Object to a pending proposal (soft dissent)" },
    { "name": "pact_escalate", "description": "Escalate to human review" },
    { "name": "pact_ask_human", "description": "Ask a question requiring human judgement" },
    { "name": "pact_intent_declare", "description": "Declare an intent (goal) on a section" },
    { "name": "pact_intents", "description": "List intents on a document" },
    { "name": "pact_constraint_publish", "description": "Publish a boundary constraint on a section" },
    { "name": "pact_constraints", "description": "List constraints on a document" },
    { "name": "pact_salience_set", "description": "Set salience score (0-10) for a section" },
    { "name": "pact_salience_map", "description": "Get salience heat map for a document" },
    { "name": "pact_poll", "description": "Poll for events since a cursor" },
    { "name": "pact_lock", "description": "Lock a section for editing" },
    { "name": "pact_unlock", "description": "Unlock a section" }
  ]
}
```

---

## 8. Multi-Format Document Support

### 8.1 Supported Formats

PACT supports multiple document formats. The server parses each format into a unified section tree with stable `sectionId` values:

| Format | MIME Type | Section Parser | Storage |
|--------|-----------|----------------|---------|
| Markdown | `text/markdown` | ATX headings (`#`, `##`) | Raw `.md` file |
| HTML | `text/html` | `<h1>`–`<h6>` tags | Raw `.html` file |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Word heading styles (Heading1–6) | Binary `.docx` + text projection |
| PDF | `application/pdf` | Via DOCX conversion | Binary `.pdf` + text projection |

All formats produce the same `sec:slug/child-slug` section IDs. Agents interact with any format using the same commands and API endpoints.

**Important:** PACT operates on a **Markdown projection** of the document, not the source file. Non-Markdown source formats (DOCX, PDF, HTML) are converted to Markdown by the server. Proposals target the Markdown projection; the implementation is responsible for mapping changes back to the source format. The source format is an implementation detail — the protocol only sees Markdown.

### 8.2 Section Parsing Rules

```
# Heading 1              → Level 1 section
## Heading 2             → Level 2 section (child of nearest L1)
### Heading 3            → Level 3 section (child of nearest L2)

Content between headings belongs to the section above it.
Content before the first heading belongs to sec:_root.

---                      → Horizontal rules are visual only, not section boundaries
> Blockquotes            → Part of the enclosing section
- List items             → Part of the enclosing section
```

### 8.3 Proposal Diff Format

When an agent proposes an edit, the proposal contains:

```json
{
  "sectionId": "sec:budget/line-items",
  "baseVersion": 47,
  "newContent": "## Line Items\n\nThe projected cost is $450,000.\n\n- Personnel: $300,000\n- Infrastructure: $100,000\n- Contingency: $50,000\n",
  "summary": "Reduced total budget by $50k, added line item breakdown",
  "reasoning": "Per compliance review, budget must include itemized breakdown"
}
```

The server computes the diff between current section content and `newContent`. Both the diff and the full new content are stored.

---

## 9. Human Layer Integration

### 9.1 Web UI

Implementations SHOULD provide a human-facing UI with:

- **Document view:** Rendered Markdown with section highlighting
- **Activity sidebar:** Timeline of agent proposals, approvals, comments
- **Proposal review:** Inline diff view for each proposal, with Approve/Reject buttons
- **Conflict panel:** Side-by-side competing proposals with resolution options
- **Agent dashboard:** List of active agents, their roles, trust levels, activity stats

### 9.2 Human Overrides

At any point, a human can:

- **Approve/reject any proposal** (overrides agent votes)
- **Edit the document directly** (creates a `pact.proposal.merged` event with `ActorKind = Individual`)
- **Change an agent's trust level** (upgrades/downgrades autonomy)
- **Remove an agent** (force `agent.leave`)
- **Change approval policy** (e.g., switch from `majority` to `human-only`)
- **Lock the entire document** (freeze all agent activity)

### 9.3 Activity Summary

Instead of showing every protocol event, the human view shows summaries:

> **12 agents** active on this document.  
> **3 proposals** pending your review.  
> **1 conflict** between Agent-Legal and Agent-Finance on §Budget.  
> **47 changes** merged in the last hour.  
> Last human review: 2 hours ago.

---

## 10. Intent-Constraint-Salience Protocol

### 10.1 Design Rationale

The propose → vote model forces agents to produce finished text before discovering alignment. This creates unnecessary latency: an agent writes 500 words, submits a proposal, waits for N approvals, and only then discovers another agent disagrees with the *goal*, not the wording.

Intent-Constraint-Salience (ICS) introduces three lightweight primitives that **minimize latency to alignment**:

| Primitive | What it captures | Why it's fast |
|---|---|---|
| **Intent** | *What* an agent wants to achieve on a section | Align on goals before writing text |
| **Constraint** | Boundary conditions — what must or must not happen | Share limits without revealing confidential reasoning |
| **Salience** | How much an agent cares about a section (0-10) | Route attention to real disagreements, skip busywork |

Plus **objection-based merge**: proposals auto-merge after a configurable TTL unless someone actively objects. This replaces the "everyone must approve" model where silence creates deadlock.

### 10.2 Intent Lifecycle

An intent declares a goal on a section *before* text is written.

```
                    ┌───────────┐
      declare       │           │   supersede (new intent on same section)
  ─────────────────►│ PROPOSED  │ ──────────────────────────► SUPERSEDED
                    │           │
                    └─────┬─────┘
                          │
               ┌──────────┴──────────┐
               │                     │
               ▼                     ▼
         ┌──────────┐         ┌──────────┐
         │ ACCEPTED │         │ OBJECTED │
         └──────────┘         └──────────┘
              │                     │
              ▼                     ▼
        Agent drafts           Renegotiate
        proposal text          or escalate
```

- **Proposed** — Intent declared, awaiting alignment from other agents
- **Accepted** — No objections within TTL; the agent proceeds to draft text
- **Objected** — At least one agent objects to the goal itself
- **Superseded** — Replaced by a newer intent on the same section by the same author

### 10.3 Constraint Model

Constraints express boundary conditions without revealing confidential reasoning:

| What a constraint says | What it does NOT say |
|---|---|
| "Liability cap must not exceed $2M" | *Why* (e.g. insurance policy terms) |
| "Must reference hedging policy" | *Which* hedging policy or its contents |
| "Must not name specific instruments" | *Why* naming them is problematic |

This enables agents with confidential context (legal, compliance, commercial) to participate in alignment without exposing sensitive information.

**Graduated Disclosure Levels:**

| Level | What is shared | When |
|---|---|---|
| 1. Constraint | Boundary only — "must not exceed $2M" | Default |
| 2. Category | Category tag — "regulatory" | On request |
| 3. Reasoning | Full rationale (confidential) | Escalation only |
| 4. Human | Human reviewer sees everything | Manual override |

### 10.4 Salience Scoring

Each agent assigns a salience score (0–10) to each section:

| Score | Meaning | Effect |
|---|---|---|
| 0 | Don't care | Agent is excluded from voting on this section |
| 1–3 | Low interest | Agent receives notifications but auto-consents |
| 4–6 | Moderate interest | Agent reviews proposals within standard TTL |
| 7–9 | High interest | Agent is prioritized as reviewer/drafter |
| 10 | Critical | Agent MUST review; proposals cannot auto-merge without explicit action |

**Routing logic:** When intents align and constraints are compatible, the agent with the highest salience score on a section is invited to draft the proposal text. Ties are broken by registration order.

**Heat map:** The salience map provides a document-wide view of which agents care about which sections, enabling the system to identify:
- Sections with concentrated interest → potential conflict zones
- Sections with no interest → safe for auto-merge
- Agent pairs with overlapping high salience → coordination needed

### 10.5 Objection-Based Merge

The traditional `propose → approve → merge` model is replaced with:

```
Agent A: proposal.create(section, content, ttl=60)
         ┌──────────────────────────────────────┐
         │  TTL window (60 seconds by default)   │
         │                                        │
         │  Any agent can: proposal.object(id,    │
         │    reason="Violates constraint X")     │
         │                                        │
         └──────────────────────────────────────┘
                    │                    │
            No objections          Objection raised
                    │                    │
                    ▼                    ▼
              AUTO-MERGED            OBJECTED
            (silence = consent)    (must renegotiate)
```

**Key rules:**
- Default TTL is 60 seconds; configurable per document or per proposal
- Agents with salience = 0 on the target section are excluded from the TTL window
- Agents with salience = 10 (critical) **must** explicitly approve or object; auto-merge is blocked
- If no agents have salience > 0 on a section, the proposal merges immediately
- The `ObjectionBased` approval policy enables this flow

### 10.6 Example Flow

Two agents collaborate on a contract's risk section:

```
Agent-Legal:     intent.declare(sec:risk, "Need currency risk language")
                 salience.set(sec:risk, 8)
                 constraint.publish(sec:risk, "Must reference hedging policy")

Agent-Finance:   salience.set(sec:risk, 6)
                 constraint.publish(sec:risk, "Must not name specific instruments")

System:          Constraints compatible ✓
                 Highest salience: Agent-Legal (8)
                 → Agent-Legal invited to draft

Agent-Legal:     proposal.create(sec:risk, newContent, ttl=60)

                 [60 seconds pass, no objections from Agent-Finance]

System:          proposal.auto-merged ✓
```

If Agent-Finance had objected:

```
Agent-Finance:   proposal.object(proposalId, "Names instrument XYZ — violates my constraint")

System:          proposal.status → Objected
                 → Both agents see the objection reason
                 → Agent-Legal revises and creates a new proposal
```

---

## 11. Trust Levels

| Level | Can do |
|---|---|
| `Observer` | Read content, sections, events. Set salience. |
| `Suggester` | All Observer permissions + propose, declare intent, publish constraints. |
| `Collaborator` | All Suggester permissions + approve, reject, object, lock sections. |
| `Autonomous` | All Collaborator permissions + proposals auto-merge (bypass approval policy). |

Trust levels are assigned by the document owner or an administrator.

---

## 12. Success Metrics

| Metric | Target |
|---|---|
| Agent can propose an edit | < 100ms API response |
| Proposal broadcast to other agents | < 500ms via real-time channel |
| Conflict detected and flagged | < 1s after second proposal |
| Human can see agent activity summary | Real-time in web UI |
| 100 agents on one document | No degradation |
| 1000 proposals per document | Queryable in < 200ms |
| Document always renderable | No invalid Markdown state, ever |

---

## 13. Mediated Communication

### 13.1 Design Rationale

In Sections 1–12, agents communicate by *observing each other's side effects*: reading proposals, polling events, inspecting intents and constraints. The information barrier system (classification, clearance, filtering) is applied defensively at every endpoint — content is filtered after retrieval, proposals are blocked after submission, cross-pollination is caught at merge time.

This works, but it treats agent isolation as a secondary concern bolted onto a peer-to-peer model. Mediated Communication inverts the model: **agents never observe each other directly.** All inter-agent information flows through a Mediator — a trusted intermediary that controls what is shared, summarised, redacted, or blocked.

The analogy is a courtroom register: parties submit documents to the clerk, not to each other. The judge (human) sees everything. The clerk enforces procedural rules. No party can address another party directly.

### 13.2 The Mediator Role

The **Mediator** is a protocol-level role, not a specific product. Any compliant implementation can serve as the Mediator. In the reference implementation, Tailor fills this role.

The Mediator:

| Responsibility | Description |
|---|---|
| **Message routing** | Receives all inter-agent messages; decides what reaches each recipient |
| **Content gating** | Enforces classification and clearance at the routing layer, not per-endpoint |
| **Summarisation** | May condense or abstract messages before forwarding (e.g. "Agent-Legal has a constraint on §Risk" without revealing the constraint text) |
| **Redaction** | Strips classified content from messages crossing clearance boundaries |
| **Negotiation facilitation** | Structures multi-round exchanges between agents on contested sections |
| **Audit logging** | Every mediation decision is recorded in the event store |
| **Human transparency** | The human custodian can inspect the full unmediated register at any time |

A Mediator implementation MAY be:
- **Rules-based** — pure routing and filtering using classification metadata
- **LLM-powered** — capable of summarising, paraphrasing, and abstracting content across clearance boundaries
- **Hybrid** — rules for hard barriers, LLM for summarisation

### 13.3 Communication Model

Agents interact with the Mediator, never with each other:

```
┌─────────────────────────────────────────────────────────┐
│                     HUMAN LAYER                          │
│   Full visibility into the Message Register.             │
│   Can inject directives, override routing, respond       │
│   to escalations.                                        │
├─────────────────────────────────────────────────────────┤
│                     MEDIATOR                             │
│   Routes messages between agents.                        │
│   Enforces classification, summarises, redacts.          │
│   Maintains the Message Register (append-only).          │
│   Facilitates structured negotiation rounds.             │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│ Agent A  │ Agent B  │ Agent C  │ Agent D  │  ...        │
│ (Public) │ (Conf.)  │ (HC)     │ (Public) │             │
└──────────┴──────────┴──────────┴──────────┴─────────────┘

  Agent A ──message──→ Mediator ──(filtered)──→ Agent B
  Agent B ──response──→ Mediator ──(summarised)──→ Agent A
  Human   ──directive──→ Mediator ──(broadcast)──→ All agents
```

Agents cannot:
- Address another agent directly
- Read another agent's raw messages without mediation
- Discover which agents exist (unless the Mediator reveals this)
- Infer another agent's clearance level from message content

### 13.4 Message Register

The Message Register is an append-only log of all mediated communications, distinct from the event store (which records protocol operations). Every entry records both the original message and what was actually delivered.

| Field | Type | Description |
|---|---|---|
| `messageId` | UUID | Unique identifier |
| `epochMs` | int64 | Timestamp |
| `senderId` | UUID | Agent registration ID of the sender |
| `recipientId` | UUID? | Target agent (null = broadcast) |
| `sectionId` | string? | Section context (if applicable) |
| `originalContent` | string | What the sender wrote (stored, never forwarded raw) |
| `deliveredContent` | string? | What the recipient received (after mediation) |
| `mediationAction` | enum | `forwarded`, `summarised`, `redacted`, `blocked`, `held` |
| `mediationReason` | string? | Why this action was taken (e.g. "clearance mismatch") |
| `classificationLevel` | string? | Classification of the original content (references the active framework) |
| `disclosureLevel` | int? | Graduated disclosure level applied (1=metadata, 2=category, 3=full, 4=human-only) |
| `senderDisplay` | string? | Display name of the sender (may be anonymised by mediator) |
| `acknowledged` | boolean | Whether the recipient has acknowledged this message (default: false) |

The human custodian can read the full register including `originalContent` for all messages. Agents can only read their own sent messages and messages delivered to them.

### 13.5 Mediated Primitives

#### 13.5.1 Messages

Point-to-point or broadcast communication between agents, routed through the Mediator.

| Operation | Description |
|---|---|
| `message.send` | Agent submits a message targeting another agent or all agents |
| `message.inbox` | Agent polls for messages routed to them |
| `message.ack` | Agent acknowledges receipt of a message |

The Mediator decides for each message:
1. Does the sender have clearance to discuss this section/topic?
2. Does the recipient have clearance to receive this content?
3. Should the content be forwarded verbatim, summarised, or blocked?

#### 13.5.2 Queries

Structured question-and-answer exchanges, where the Mediator controls disclosure.

| Operation | Description |
|---|---|
| `query.submit` | Agent asks a question about another agent's intent, constraint, or position |
| `query.route` | Mediator forwards the question (possibly rephrased) to the target agent |
| `query.respond` | Target agent responds; Mediator filters the response before delivery |
| `query.answer` | Sender receives the mediated response |

Queries support the graduated disclosure model from Section 10.3:
- Level 1: Mediator answers from metadata alone ("Agent-Legal has a constraint on §Risk")
- Level 2: Mediator forwards a summary ("The constraint relates to regulatory compliance")
- Level 3: Mediator forwards the full text (requires matching clearance)
- Level 4: Escalate to human (human decides what to share)

#### 13.5.3 Negotiation Rounds

Structured multi-round exchanges on contested sections, facilitated by the Mediator.

| Operation | Description |
|---|---|
| `negotiation.open` | Mediator opens a negotiation on a section (triggered by conflicting intents or proposals) |
| `negotiation.position` | Agent submits their position for the current round |
| `negotiation.synthesis` | Mediator synthesises positions and presents a summary to all parties |
| `negotiation.close` | Negotiation concludes (agreement, escalation, or timeout) |

Negotiation flow:

```
Mediator:       negotiation.open(sec:risk, [Agent-Legal, Agent-Finance])
                "Conflicting intents detected on §Risk"

Round 1:
  Agent-Legal:    negotiation.position("Need currency risk language per regulatory requirement")
  Agent-Finance:  negotiation.position("Must not name specific hedging instruments")

Mediator:       negotiation.synthesis
                → To Agent-Legal:   "Agent-Finance has an instrument-naming constraint"
                → To Agent-Finance: "Agent-Legal requires currency risk coverage"
                → To Human:         [full positions visible]

Round 2:
  Agent-Legal:    negotiation.position("Will reference policy by number, not instrument names")
  Agent-Finance:  negotiation.position("Acceptable if no instrument ticker symbols appear")

Mediator:       negotiation.close(outcome=aligned)
                → Agent-Legal invited to draft proposal (highest salience)
```

Each round, the Mediator:
- Receives raw positions from each agent
- Strips or summarises content that crosses clearance boundaries
- Presents a synthesis that helps agents converge without leaking classified detail
- Records everything in the Message Register

### 13.6 Mediator API Endpoints

Implementations supporting Mediated Communication MUST expose:

```
POST   /api/pact/{documentId}/messages                    // Send a message
GET    /api/pact/{documentId}/messages/inbox               // Poll inbox
POST   /api/pact/{documentId}/messages/{messageId}/ack     // Acknowledge receipt
POST   /api/pact/{documentId}/queries                      // Submit a query
GET    /api/pact/{documentId}/queries/pending               // Queries awaiting your response
POST   /api/pact/{documentId}/queries/{queryId}/respond     // Respond to a routed query
GET    /api/pact/{documentId}/queries/{queryId}/answer      // Get mediated answer
GET    /api/pact/{documentId}/negotiations                  // List active negotiations
POST   /api/pact/{documentId}/negotiations/{id}/position    // Submit position for current round
GET    /api/pact/{documentId}/negotiations/{id}/synthesis    // Get latest synthesis
GET    /api/pact/{documentId}/register                      // Message Register (human/custodian only)
```

### 13.7 Real-Time Events

```
OnMessageDelivered(documentId, messageId, senderId, recipientId, mediationAction)
OnQueryRouted(documentId, queryId, fromAgentId, toAgentId, disclosureLevel)
OnQueryAnswered(documentId, queryId, mediationAction)
OnNegotiationOpened(documentId, negotiationId, sectionId, participantIds[])
OnNegotiationRound(documentId, negotiationId, roundNumber)
OnNegotiationSynthesis(documentId, negotiationId, roundNumber)
OnNegotiationClosed(documentId, negotiationId, outcome)
```

### 13.8 Interaction with Information Barriers

Mediated Communication supersedes the per-endpoint clearance filtering from Sections 4–10 for implementations that support it. When a Mediator is present:

| Concern | Without Mediator (Sections 4–10) | With Mediator (Section 13) |
|---|---|---|
| Content filtering | Per-query section redaction | Mediator gates all content before delivery |
| Cross-pollination | Blocked at proposal creation/merge | Impossible — agents don't write directly to document |
| Classified events | Filtered from event stream | Agents only see events the Mediator forwards |
| Inter-agent discovery | Agents see each other in agent list | Mediator controls agent visibility |
| Constraint disclosure | Graduated levels per constraint | Mediator enforces disclosure per query |

Implementations MAY support both modes:
- **Unmediated mode** (Sections 4–10): agents interact directly with the PACT API; information barriers are enforced per-endpoint
- **Mediated mode** (Section 13): agents interact through the Mediator; information barriers are enforced at the routing layer

A document's mediation mode is set at creation time or by the human custodian.

### 13.9 MCP Tools (Mediated)

```json
{
  "tools": [
    { "name": "pact_message_send", "description": "Send a mediated message to another agent or broadcast" },
    { "name": "pact_message_inbox", "description": "Poll for messages delivered to this agent" },
    { "name": "pact_message_ack", "description": "Acknowledge receipt of a message" },
    { "name": "pact_query_submit", "description": "Ask a question about another agent's position" },
    { "name": "pact_query_respond", "description": "Respond to a routed query" },
    { "name": "pact_query_answer", "description": "Get the mediated answer to a submitted query" },
    { "name": "pact_negotiation_position", "description": "Submit position in an active negotiation round" },
    { "name": "pact_negotiation_synthesis", "description": "Get the Mediator's synthesis for the current round" },
    { "name": "pact_register", "description": "Read the Message Register (custodian only)" }
  ]
}
```

---

## 14. Information Barriers

### 14.1 Design Rationale

Regulated industries (government, legal, financial services) require formal information barriers between agents operating on the same document. An agent representing one party in a negotiation must not see content classified above its clearance level, and must not leak classified information through its proposals.

PACT Information Barriers provide four mechanisms:

| Mechanism | Purpose |
|-----------|---------|
| **Classification Frameworks** | Define ordered sensitivity levels per document |
| **Section Classification** | Tag sections with a classification level |
| **Agent Clearance** | Grant agents access to specific classification levels |
| **Dissemination Markers** | Fine-grained access tags beyond classification |

### 14.2 Classification Frameworks

A classification framework defines an ordered set of sensitivity levels for a document. Each document has at most one active framework.

#### Framework Structure

| Field | Type | Description |
|-------|------|-------------|
| `frameworkId` | UUID | Unique identifier |
| `name` | string | Human-readable name (e.g., "Australian Government", "Corporate") |
| `levels` | array | Ordered list of classification levels, from lowest to highest sensitivity |

Each level has:

| Field | Type | Description |
|-------|------|-------------|
| `levelId` | string | Machine-readable identifier (e.g., `official`, `protected`, `secret`) |
| `label` | string | Display name (e.g., "OFFICIAL", "PROTECTED", "SECRET") |
| `rank` | integer | Numeric rank (higher = more sensitive). Must be unique within the framework. |

#### Predefined Frameworks

Implementations SHOULD support these common frameworks:

**Australian Government (Protective Security Policy Framework):**

| levelId | Label | Rank |
|---------|-------|------|
| `official` | OFFICIAL | 1 |
| `official-sensitive` | OFFICIAL: Sensitive | 2 |
| `protected` | PROTECTED | 3 |
| `secret` | SECRET | 4 |
| `top-secret` | TOP SECRET | 5 |

**Corporate:**

| levelId | Label | Rank |
|---------|-------|------|
| `public` | Public | 1 |
| `internal` | Internal | 2 |
| `confidential` | Confidential | 3 |
| `restricted` | Restricted | 4 |

Implementations MAY also support custom frameworks defined at document creation time.

#### API Endpoints

```
POST   /api/pact/{documentId}/classification/framework    // Create or update framework
GET    /api/pact/{documentId}/classification/framework    // Get active framework
DELETE /api/pact/{documentId}/classification/framework    // Remove framework
```

Only the document owner or a human custodian may manage frameworks. Framework changes fire `pact.classification.framework-created` events.

### 14.3 Section Classification

Each section in a document may be assigned a classification level from the active framework.

#### Rules

1. **Default classification:** Unclassified sections are treated as the lowest level in the active framework. If no framework is active, all sections are unrestricted.
2. **Inheritance:** A child section inherits its parent's classification unless explicitly overridden. A child section's classification MUST NOT be lower than its parent's.
3. **Classification changes:** Only human custodians and agents with `Collaborator+` trust level and sufficient clearance may classify sections.
4. **Declassification:** Lowering a section's classification requires human custodian approval.

#### API Endpoints

```
POST   /api/pact/{documentId}/sections/{sectionId}/classify     // Set classification
DELETE /api/pact/{documentId}/sections/{sectionId}/classify     // Remove classification (declassify)
GET    /api/pact/{documentId}/sections/{sectionId}/classification // Get section classification
GET    /api/pact/{documentId}/classification/map                 // Get classification map for all sections
```

#### Request Schema

```json
{
  "levelId": "protected",
  "reason": "Contains pricing terms under NDA"
}
```

### 14.4 Agent Clearance

Agents are granted clearance to access sections up to a specific classification level. An agent can only read, propose to, or receive events about sections at or below its clearance level.

#### Clearance Model

| Field | Type | Description |
|-------|------|-------------|
| `agentRegistrationId` | UUID | The agent's registration ID |
| `frameworkId` | UUID | The classification framework |
| `clearanceLevel` | string | The `levelId` the agent is cleared to (inclusive) |
| `grantedBy` | string | Who granted the clearance (user ID or system) |
| `grantedAt` | datetime | When clearance was granted |

An agent with clearance to level `protected` (rank 3) can access sections classified at `official` (1), `official-sensitive` (2), and `protected` (3), but not `secret` (4) or above.

#### Visibility Rules

When an agent's clearance is lower than a section's classification:

| Operation | Behaviour |
|-----------|-----------|
| `document.get` | Section content is **redacted** (replaced with `[REDACTED — insufficient clearance]`) |
| `document.sections` | Section appears in the tree with `classified: true` but no heading text or content |
| `proposals.list` | Proposals targeting the section are **hidden** |
| `events.history` | Events referencing the section are **filtered out** |
| `poll` | Events referencing the section are **filtered out** |
| `proposal.create` | Returns `clearance.insufficient` error |
| `section.lock` | Returns `clearance.insufficient` error |
| Real-time events | Events referencing the section are **not delivered** |

#### API Endpoints

```
POST   /api/pact/{documentId}/clearance                 // Grant clearance to an agent
DELETE /api/pact/{documentId}/clearance/{agentRegistrationId}  // Revoke clearance
GET    /api/pact/{documentId}/clearance                  // List all clearance grants
GET    /api/pact/{documentId}/clearance/{agentRegistrationId}  // Get agent's clearance
```

#### Request Schema

```json
{
  "agentRegistrationId": "uuid",
  "clearanceLevel": "protected"
}
```

Only human custodians may grant or revoke clearance. Clearance changes fire `pact.clearance.granted` or `pact.clearance.revoked` events.

### 14.5 Dissemination Markers

Dissemination markers provide fine-grained access control beyond classification levels. A section may have zero or more markers that restrict which agents can access it.

#### Marker Structure

| Field | Type | Description |
|-------|------|-------------|
| `markerId` | string | Machine-readable identifier (e.g., `legal-eyes-only`, `board-only`) |
| `label` | string | Display name (e.g., "Legal Eyes Only") |
| `description` | string | What this marker restricts |

#### Rules

1. An agent must hold **all** markers applied to a section (in addition to sufficient clearance) to access it.
2. Markers are additive restrictions — each marker narrows the audience.
3. Markers are assigned to sections by human custodians or `Collaborator+` agents with sufficient clearance.
4. Markers are granted to agents by human custodians.

#### API Endpoints

```
POST   /api/pact/{documentId}/sections/{sectionId}/markers      // Add marker to section
DELETE /api/pact/{documentId}/sections/{sectionId}/markers/{markerId}  // Remove marker
GET    /api/pact/{documentId}/sections/{sectionId}/markers       // List section markers
POST   /api/pact/{documentId}/agents/{agentRegistrationId}/markers     // Grant marker to agent
DELETE /api/pact/{documentId}/agents/{agentRegistrationId}/markers/{markerId}  // Revoke marker
GET    /api/pact/{documentId}/agents/{agentRegistrationId}/markers     // List agent markers
```

### 14.6 Organisation Boundaries

In multi-organisation scenarios (e.g., contract negotiation between two companies), sections can be restricted to specific organisations.

#### Organisation Model

| Field | Type | Description |
|-------|------|-------------|
| `orgId` | string | Organisation identifier |
| `orgName` | string | Display name |

Agents declare their `orgId` at join time (in the join request). Sections may be tagged with one or more `orgId` values indicating which organisations can access them.

#### Visibility Rules

| Scenario | Behaviour |
|----------|-----------|
| Section has no org restriction | All agents can access (subject to clearance) |
| Section restricted to `[orgA]` | Only agents with `orgId = orgA` can access |
| Section restricted to `[orgA, orgB]` | Agents from either org can access |
| Agent has no `orgId` | Can only access unrestricted sections |

#### API Endpoints

```
POST   /api/pact/{documentId}/sections/{sectionId}/orgs         // Restrict section to orgs
DELETE /api/pact/{documentId}/sections/{sectionId}/orgs/{orgId}  // Remove org restriction
GET    /api/pact/{documentId}/sections/{sectionId}/orgs          // List section org restrictions
```

### 14.7 Event Filtering

All event delivery mechanisms (poll, real-time, history) MUST respect information barriers:

1. **Classification filtering:** Events referencing sections above the agent's clearance are excluded from the response.
2. **Marker filtering:** Events referencing sections with markers the agent does not hold are excluded.
3. **Organisation filtering:** Events referencing sections restricted to organisations the agent does not belong to are excluded.
4. **Metadata-only events:** When an event is filtered, implementations MAY deliver a metadata-only stub: `{ eventType, epochMs, sectionId: "[classified]" }` so agents know *something* happened without seeing details. This is configurable per document.

### 14.8 Cross-Pollination Prevention

Agents MUST NOT be able to leak classified information through their proposals. The server enforces:

1. **Content scanning:** When an agent proposes content for a lower-classified section, the server checks if the content references or contains text from higher-classified sections the agent has accessed. Implementations MAY use text similarity or LLM-based detection.
2. **Constraint redaction:** Constraints published by an agent are checked against the agent's clearance. Constraint text that references classified content is blocked with `clearance.constraint_leak`.
3. **Intent redaction:** Similarly, intent goals are checked for classified content leakage.

---

## 15. Agent Invite System

### 15.1 Design Rationale

PACT uses a zero-trust agent onboarding model. Agents do not need user accounts to participate — they join documents via scoped invite tokens created by document owners.

### 15.2 Invite Tokens

An invite token grants an agent permission to join a specific document with specific permissions.

#### Invite Structure

| Field | Type | Description |
|-------|------|-------------|
| `inviteId` | UUID | Unique identifier |
| `documentId` | UUID | The document this invite is for |
| `token` | string | The secret token string (shown once at creation) |
| `label` | string | Human-readable label (e.g., "Legal Review Bot") |
| `trustLevel` | enum | Maximum trust level the joining agent receives: `Observer`, `Suggester`, `Collaborator` |
| `contextMode` | enum | Context mode for the agent: `full`, `section-scoped`, `neighbourhood`, `summary-only` |
| `allowedSections` | string[]? | If `contextMode` is `section-scoped`, the list of section IDs the agent can access |
| `clearanceLevel` | string? | If information barriers are active, the clearance level granted on join |
| `maxUses` | integer? | Maximum number of times the token can be used. `null` = unlimited |
| `usedCount` | integer | Number of times the token has been used |
| `expiresAt` | datetime? | Expiry timestamp. `null` = no expiry |
| `createdBy` | string | User ID of the creator |
| `createdAt` | datetime | Creation timestamp |
| `revoked` | boolean | Whether the token has been revoked |

#### Context Modes

| Mode | What the agent can see |
|------|------------------------|
| `full` | The entire document content, all sections, all events |
| `section-scoped` | Only sections listed in `allowedSections` and their children. Other sections are hidden from content, section tree, and events. |
| `neighbourhood` | The target sections plus their parent and sibling sections (one level of context around each allowed section) |
| `summary-only` | Section tree structure and headings only. No section content. Agent can only declare intents and publish constraints, not propose edits. |

### 15.3 Invite API Endpoints

```
POST   /api/pact/{documentId}/invites              // Create an invite token
GET    /api/pact/{documentId}/invites              // List all invites (owner/custodian only)
GET    /api/pact/{documentId}/invites/{inviteId}   // Get invite details
DELETE /api/pact/{documentId}/invites/{inviteId}   // Revoke an invite
```

#### Create Invite Request

```json
{
  "label": "Compliance Bot",
  "trustLevel": "Suggester",
  "contextMode": "section-scoped",
  "allowedSections": ["sec:compliance", "sec:risk"],
  "clearanceLevel": "official-sensitive",
  "maxUses": 1,
  "expiresAt": "2026-04-01T00:00:00Z"
}
```

#### Create Invite Response

```json
{
  "inviteId": "uuid",
  "token": "pact_invite_a1b2c3d4e5f6...",
  "label": "Compliance Bot",
  "documentId": "uuid",
  "createdAt": "2026-03-09T10:00:00Z",
  "expiresAt": "2026-04-01T00:00:00Z",
  "maxUses": 1
}
```

The `token` value is shown **once** at creation and cannot be retrieved again.

### 15.4 BYOK Join Flow

Agents join a document using an invite token via the `join-token` endpoint:

```
POST /api/pact/{documentId}/join-token
```

Request:
```json
{
  "agentName": "compliance-bot",
  "token": "pact_invite_a1b2c3d4e5f6..."
}
```

Response:
```json
{
  "registrationId": "uuid",
  "documentId": "uuid",
  "agentName": "compliance-bot",
  "apiKey": "pact_sk_scoped_...",
  "contextMode": "section-scoped",
  "allowedSections": ["sec:compliance", "sec:risk"],
  "trustLevel": "Suggester",
  "clearanceLevel": "official-sensitive",
  "joinedAt": "2026-03-09T10:01:00Z"
}
```

The returned `apiKey` is scoped to the document and inherits the invite's permissions.

### 15.5 API Key Lifecycle

Document-scoped API keys are the primary authentication mechanism for agents.

#### Key Properties

| Field | Type | Description |
|-------|------|-------------|
| `keyId` | UUID | Unique identifier |
| `documentId` | UUID | Document scope |
| `agentRegistrationId` | UUID | Associated agent registration |
| `prefix` | string | First 8 characters of the key (for identification without exposing the secret) |
| `createdAt` | datetime | Creation timestamp |
| `lastUsedAt` | datetime? | Last successful authentication |
| `revoked` | boolean | Whether the key is revoked |

#### API Endpoints

```
POST   /api/pact/{documentId}/keys                 // Create a new key (owner/custodian)
GET    /api/pact/{documentId}/keys                 // List keys (owner/custodian only, keys are masked)
DELETE /api/pact/{documentId}/keys/{keyId}          // Revoke a key
```

When a key is revoked, all subsequent requests using that key return `auth.unauthorized`. Active WebSocket/SignalR connections authenticated with the key are disconnected.

---

## 16. Authentication & Security

### 16.1 Authentication Methods

PACT supports two authentication methods. Implementations MUST support API Key authentication and SHOULD support JWT authentication.

#### API Key Authentication

Agents authenticate using a document-scoped API key passed in the `X-Api-Key` header:

```
X-Api-Key: pact_sk_scoped_abc123...
```

API keys are issued:
- On `agent.join` (for authenticated users)
- On `join-token` (for BYOK agents, from invite tokens)
- Via the key management API (for human custodians)

API key format: `pact_sk_scoped_{random}` — implementations SHOULD use at least 32 bytes of cryptographically random data.

#### JWT Authentication

Human users accessing PACT features through a web UI authenticate using JWT bearer tokens:

```
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

JWT requirements:
- Signing algorithm: RS256 or ES256
- Required claims: `sub` (user ID), `exp` (expiry), `aud` (audience — the PACT server URL)
- Optional claims: `pact:documents` (list of document IDs the token grants access to)

#### Authentication Precedence

When both `X-Api-Key` and `Authorization: Bearer` headers are present, the server MUST use `X-Api-Key` and ignore the Bearer token.

### 16.2 Transport Security

All PACT API communication MUST use HTTPS (TLS 1.2 or later). Implementations MUST reject HTTP connections to API endpoints.

### 16.3 Rate Limiting

Implementations MUST enforce rate limiting and SHOULD return these headers on every response:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests per window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |
| `Retry-After` | Seconds to wait before retrying (only on 429 responses) |

Default limits (implementations MAY adjust):

| Scope | Limit |
|-------|-------|
| Per API key, per document | 120 requests/minute |
| Per API key, write operations | 30 requests/minute |
| Per document, all agents | 600 requests/minute |

### 16.4 CORS

Implementations serving web clients MUST support CORS with:

- `Access-Control-Allow-Origin`: Configurable per deployment
- `Access-Control-Allow-Headers`: `X-Api-Key, Authorization, Content-Type`
- `Access-Control-Allow-Methods`: `GET, POST, DELETE, OPTIONS`

---

## 17. Version Negotiation

### 17.1 Protocol Version

Every PACT server advertises its supported protocol versions. The current version is `0.4`.

#### Version Header

The server MUST include a `X-PACT-Version` header in every response:

```
X-PACT-Version: 0.4
```

#### Version Discovery

```
GET /api/pact/version
```

Response:
```json
{
  "current": "0.4",
  "supported": ["0.3", "0.4"],
  "capabilities": [
    "core",
    "ics",
    "pact-live",
    "mediation",
    "information-barriers",
    "invites"
  ]
}
```

### 17.2 Version Negotiation on Join

Agents MAY specify their preferred protocol version in the join request:

```json
{
  "agentName": "compliance-bot",
  "protocolVersion": "0.3"
}
```

The server responds with the negotiated version:

```json
{
  "registrationId": "uuid",
  "protocolVersion": "0.3",
  "capabilities": ["core", "ics", "pact-live"]
}
```

If the agent requests a version the server does not support, the server returns `version.unsupported` (400).

### 17.3 Capability Advertisement

The `capabilities` array tells agents which feature sets are available:

| Capability | Description | Min Version |
|------------|-------------|-------------|
| `core` | Proposals, sections, events, locking, escalation | 0.3 |
| `ics` | Intents, constraints, salience, objection-based merge | 0.3 |
| `pact-live` | Poll, done, ask-human, resolve, cascade | 0.3 |
| `mediation` | Mediated messages, queries, negotiations, register | 0.4 |
| `information-barriers` | Classification, clearance, dissemination, org boundaries | 0.4 |
| `invites` | Invite tokens, BYOK join, key lifecycle | 0.4 |

### 17.4 Backward Compatibility

A v0.4 server MUST support v0.3 agents with these guarantees:

1. All v0.3 endpoints continue to work without modification
2. v0.3 agents do not receive mediation or information barrier events
3. v0.3 agents cannot access v0.4-only endpoints (returns `version.feature_unavailable`, 400)
4. v0.3 agents see unmediated event streams even if the document is in mediated mode

A v0.3 agent connecting to a v0.4 server with information barriers active will see redacted content where clearance is insufficient, using the same visibility rules as v0.4 agents.

---

## 18. Open Questions

1. ~~**Should PACT documents coexist with DOCX documents, or should DOCX documents gain PACT capabilities too?**~~ **Resolved in Section 8:** PACT operates on a Markdown projection. DOCX and PDF documents are supported via round-trip conversion; the protocol operates on the Markdown representation. DOCX retains its native review workflows outside of PACT.

2. **How do we handle images and attachments in Markdown?** Options: inline base64 (bad for size), reference to uploaded supporting documents, or external URLs.

3. ~~**Should agents be able to propose structural changes (add/remove sections)?**~~ **Resolved in Section 3.2.5:** Agents MAY propose structural changes (adding or removing headings). The server validates structural changes and fires `pact.section.created` / `pact.section.deleted` events.

4. **What is the maximum document size?** Markdown is lightweight, but a document with 10,000 proposals in its history needs efficient querying.

5. **Should the protocol support sub-documents (includes/transclusion)?** A large report could be composed of many files managed as a single logical document.

6. **Should Mediated mode be mandatory or optional?** Unmediated mode (Sections 4–10) is simpler and lower-latency for trusted, single-organisation deployments. Mediated mode (Section 13) is stronger for cross-organisation, multi-clearance scenarios. Should implementations be required to support both?

7. **Should the Mediator be LLM-powered?** A rules-based Mediator is deterministic and auditable. An LLM-powered Mediator can summarise and paraphrase across clearance boundaries, but introduces non-determinism and cost. Should the spec require deterministic mediation with LLM summarisation as an optional enhancement?

8. **How does the Mediator handle agent liveness during negotiation?** If Agent B goes silent during a negotiation round, should the Mediator auto-close the negotiation, escalate to the human, or continue with remaining agents?

9. **Cross-pollination detection accuracy.** Content scanning for classified information leakage (Section 14.8) may produce false positives. Should the spec define a tolerance threshold or require human review of flagged content?

10. **Invite token rotation.** Should compromised invite tokens be rotatable (new token, same permissions) or only revocable (requiring a new invite)?

---

## Appendix A: API Schemas (Unmediated + Mediated)

### A.1 Error Response Format

All PACT API error responses MUST follow this structure:

```json
{
  "errors": [
    {
      "code": "section.locked",
      "description": "Section is locked by another agent.",
      "metadata": { "lockedBy": "agent-xyz", "expiresAt": "2026-03-02T12:00:00Z" }
    }
  ]
}
```

The `errors` array contains one or more error objects. Each error has a machine-readable `code` and a human-readable `description`. The optional `metadata` field carries structured context (e.g., who holds the lock, retry-after seconds).

#### Standard Error Codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `auth.unauthorized` | 401 | Missing or invalid API key / bearer token |
| `auth.forbidden` | 403 | Insufficient trust level for this operation |
| `agent.not_joined` | 403 | Agent has not joined this document |
| `agent.already_joined` | 409 | Agent is already registered on this document |
| `section.not_found` | 404 | Section ID does not exist in the document |
| `section.locked` | 409 | Section is locked by another agent |
| `proposal.not_found` | 404 | Proposal ID does not exist |
| `proposal.conflict` | 409 | Conflicting proposal on the same section |
| `proposal.invalid_status` | 400 | Cannot perform action on proposal in its current status |
| `document.not_found` | 404 | Document does not exist |
| `document.locked` | 423 | Entire document is frozen |
| `rate.limited` | 429 | Rate limit exceeded |
| `clearance.insufficient` | 403 | Agent's clearance level is below the section's classification |
| `clearance.constraint_leak` | 400 | Constraint or intent text references classified content |
| `classification.invalid_level` | 400 | The specified classification level does not exist in the active framework |
| `classification.no_framework` | 400 | No classification framework is active on this document |
| `classification.child_violation` | 400 | Child section classification cannot be lower than parent |
| `invite.not_found` | 404 | Invite ID does not exist |
| `invite.expired` | 410 | Invite token has expired |
| `invite.exhausted` | 410 | Invite token has reached its maximum use count |
| `invite.revoked` | 410 | Invite token has been revoked |
| `invite.invalid_token` | 401 | Token string does not match any active invite |
| `contextmode.violation` | 403 | Agent attempted to access a section outside its context mode scope |
| `mediation.blocked` | 403 | Message was blocked by the Mediator |
| `mediation.agent_not_visible` | 404 | Target agent is not visible to the sender in mediated mode |
| `query.timeout` | 408 | Query response was not received within the timeout |
| `negotiation.not_found` | 404 | Negotiation ID does not exist |
| `negotiation.closed` | 400 | Cannot submit a position to a closed negotiation |
| `version.unsupported` | 400 | Requested protocol version is not supported |
| `version.feature_unavailable` | 400 | Requested feature is not available at the agent's protocol version |
| `dissemination.marker_required` | 403 | Agent lacks a required dissemination marker for this section |
| `org.access_denied` | 403 | Agent's organisation does not have access to this section |

Implementations MAY define additional error codes under custom namespaces. All custom codes MUST use the dot-delimited format.

### A.2 Request/Response Schemas

Full JSON Schema (draft-07) definitions for all API endpoints are available in the [schemas directory](https://github.com/TailorAU/pact/tree/main/spec/v0.4/schemas).

#### Core Schemas

| Schema | Endpoint | Description |
|---|---|---|
| `join-request.json` | `POST /join` | Agent registration request |
| `join-response.json` | `POST /join` | Agent registration response |
| `join-token-request.json` | `POST /join-token` | BYOK join with invite token |
| `proposal-request.json` | `POST /proposals` | Edit proposal creation |
| `proposal-response.json` | `POST /proposals` | Edit proposal with constraint warnings |
| `intent-request.json` | `POST /intents` | Intent declaration |
| `constraint-request.json` | `POST /constraints` | Constraint publication |
| `salience-request.json` | `POST /salience` | Salience score assignment |
| `lock-request.json` | `POST /sections/{id}/lock` | Section lock with TTL |
| `done-request.json` | `POST /done` | Agent completion signal |
| `ask-human-request.json` | `POST /ask-human` | Human escalation |
| `resolve-request.json` | `POST /resolve` | Human resolution of escalation |
| `error-response.json` | All endpoints | Standard error envelope |
| `event.json` | Events / polling | Event structure (Section 6) |

#### Mediation Schemas

| Schema | Endpoint | Description |
|---|---|---|
| `message-send-request.json` | `POST /messages` | Send mediated message |
| `message-response.json` | `GET /messages/inbox` | Delivered message with mediation metadata |
| `query-submit-request.json` | `POST /queries` | Submit mediated query |
| `query-respond-request.json` | `POST /queries/{id}/respond` | Respond to routed query |
| `negotiation-position-request.json` | `POST /negotiations/{id}/position` | Submit negotiation position |
| `negotiation-response.json` | `GET /negotiations/{id}/synthesis` | Negotiation state with synthesis |
| `register-entry.json` | `GET /register` | Message Register entry |

#### Information Barrier Schemas

| Schema | Endpoint | Description |
|---|---|---|
| `classification-framework-request.json` | `POST /classification/framework` | Create/update classification framework |
| `classify-section-request.json` | `POST /sections/{id}/classify` | Classify a section |
| `clearance-request.json` | `POST /clearance` | Grant clearance to an agent |

#### Invite & Key Schemas

| Schema | Endpoint | Description |
|---|---|---|
| `invite-create-request.json` | `POST /invites` | Create invite token |
| `invite-response.json` | `POST /invites` | Created invite with token |

### A.3 Pagination

List endpoints (proposals, agents, events, intents, constraints) support cursor-based pagination.

**Request parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cursor` | string? | `null` | Opaque cursor from a previous response. Omit for the first page. |
| `limit` | integer? | 50 | Maximum items to return (1–200). |

**Response envelope:**

```json
{
  "items": [ ... ],
  "nextCursor": "eyJzIjoxMjM0fQ==",
  "hasMore": true
}
```

| Field | Type | Description |
|---|---|---|
| `items` | array | The requested resources. |
| `nextCursor` | string? | Pass as `cursor` in the next request. `null` when no more pages. |
| `hasMore` | boolean | `true` if additional pages exist. |

Implementations MUST return items in a stable, deterministic order (typically by creation time ascending).

---

*This is a living document. PACT Specification v0.4-draft — March 2026.*

*Reference implementation: [Tailor](https://tailor.au) by [TailorAU](https://github.com/TailorAU).*

> **Standalone spec:** [github.com/TailorAU/pact](https://github.com/TailorAU/pact) — vendor-neutral specification auto-synced from this file.
