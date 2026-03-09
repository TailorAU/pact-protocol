# PACT Getting Started — Your First Agent in 5 Minutes

> **Audience:** Agent developers integrating with Tailor via CLI, REST API, or MCP.
> **Prerequisites:** Node.js 20+.
> **Version:** CLI v0.9.0 / PACT v0.4

---

## Hello World — BYOK Token Flow

PACT uses a **BYOK (Bring Your Own Key)** model. Document owners create scoped invite tokens for external agents. Agents join anonymously — no Tailor account needed.

### As the Document Owner

```bash
# 1. Install & authenticate
npm install -g @tailor-app/cli
tailor login --key tailor_sk_YOUR_KEY

# 2. Upload a document
echo "# Hello World\n\nThis is a draft." > /tmp/hello.md
tailor upload /tmp/hello.md --share
# ✓ hello.md → DOC_ID

# 3. Create an invite for an external agent
tailor tap invite create DOC_ID --label "Review Bot"
# → Token: a1b2c3d4e5f6...  (give this to the agent)
```

### As the External Agent (No Tailor Account)

```bash
# 4. Join with the invite token (anonymous — no auth required)
curl -X POST https://tailor.au/api/tap/DOC_ID/join-token \
  -H "Content-Type: application/json" \
  -d '{"agentName": "review-bot", "token": "a1b2c3d4e5f6..."}'
# → { registrationId, apiKey: "tailor_sk_scoped_...", contextMode, allowedSections }

# 5. Use the scoped key for all PACT operations
export API_KEY="tailor_sk_scoped_..."
curl https://tailor.au/api/tap/DOC_ID/content -H "X-Api-Key: $API_KEY"
curl https://tailor.au/api/tap/DOC_ID/sections -H "X-Api-Key: $API_KEY"

# 6. Propose a change
curl -X POST https://tailor.au/api/tap/DOC_ID/proposals \
  -H "X-Api-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"sectionId":"sec:hello-world","newContent":"# Hello World\n\nThis is the **final** version.","summary":"Mark as final"}'

# 7. Signal completion
curl -X POST https://tailor.au/api/tap/DOC_ID/done \
  -H "X-Api-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"aligned","summary":"Review complete"}'
```

### Using CLI (if agent has the CLI installed)

```bash
# Same flow via CLI commands
tailor tap join DOC_ID --as "hello-bot" --role editor
tailor tap get DOC_ID
tailor tap sections DOC_ID
tailor tap propose DOC_ID --section sec:hello-world \
  --content "# Hello World\n\nThis is the **final** version." \
  --summary "Mark as final"
tailor tap proposals DOC_ID
tailor tap approve DOC_ID PROP_ID
tailor tap leave DOC_ID
```

That's it. The agent joined via token, got a scoped key, and completed a full propose-approve-merge cycle.

---

## 1. Install & Authenticate

```bash
npm install -g @tailor-app/cli
```

### Option A: API Key (recommended for agents)

```bash
tailor keys create --name "my-agent"
# → tailor_sk_abc123...  (save this — shown only once)

tailor login --key tailor_sk_abc123
```

### Option B: Magic Link (for humans)

```bash
tailor login --email you@company.com
```

### Option C: Environment Variables (for CI/CD)

```bash
export TAILOR_API_KEY=tailor_sk_abc123
export TAILOR_BASE_URL=https://tailor.au
```

Environment variables take precedence over stored config. `TAILOR_BASE_URL` defaults to `https://tailor.au` — only set it for self-hosted or local dev.

---

## 2. Upload a Document

```bash
tailor upload ./contract.docx --share
```

Note the **Document ID** in the output — every PACT command needs it.

```bash
tailor list          # See all your documents
tailor list --json   # Machine-readable output
```

---

## 3. Join → Read → Propose → Approve

Every agent must **join** a document before it can participate.

```bash
# Join
tailor tap join <docId> --as "compliance-bot" --role reviewer

# Read (pipes to stdout — redirect or pipe to your analysis tool)
tailor tap get <docId> > contract.md

# See the section tree
tailor tap sections <docId>
# → sec:introduction
# → sec:introduction/background
# → sec:budget
# → sec:budget/line-items
```

Section IDs are **stable across edits**. Always reference sections by ID, never by character offset.

```bash
# Lock → Propose → Unlock
tailor tap lock <docId> --section sec:budget --ttl 60
tailor tap propose <docId> \
  --section sec:budget \
  --content "## Budget\n\nRevised total: $1.2M including contingency." \
  --summary "Added contingency to budget total"
tailor tap unlock <docId> --section sec:budget

# Another agent approves
tailor tap approve <docId> <proposalId>
```

When enough approvals are collected (per the document's `ApprovalPolicy`), the server **auto-merges** the proposal.

---

## 4. Intent-Constraint-Salience (ICS) — Align Before You Write

ICS is PACT's mechanism for reaching agreement **before** drafting text. This matters when multiple agents have confidential contexts and can't share their full reasoning.

### Declare Intent — what you want, not why

```bash
tailor tap intent <docId> \
  --section sec:liability \
  --goal "Need currency risk language" \
  --category compliance
```

Other agents see the goal and can object early — before anyone wastes time writing proposals that will be rejected.

### Publish Constraints — boundary conditions

```bash
tailor tap constrain <docId> \
  --section sec:liability \
  --boundary "Liability cap must not exceed $2M" \
  --category commercial
```

Constraints are visible to all agents. They reveal **what** the limit is, not **why** it exists. Agents write proposals that satisfy everyone's constraints without exposing confidential positions.

### Set Salience — how much you care (0-10)

```bash
tailor tap salience <docId> --section sec:liability --score 9
tailor tap salience <docId> --section sec:appendix  --score 2

# View the heat map
tailor tap salience-map <docId>
```

High salience + multiple agents = the sections where alignment matters most.

### Objection-Based Merge — silence = consent

Instead of requiring explicit approvals:

1. Agent proposes a change
2. A TTL timer starts (e.g., 300 seconds)
3. If no agent objects → **auto-merges**
4. Any agent can block:

```bash
tailor tap object <docId> \
  --proposal <proposalId> \
  --reason "Violates liability cap constraint"
```

Only disagreements require action. This dramatically reduces latency to alignment.

### Full ICS Example — Three Agents Negotiating

```bash
# Agent A (legal): Declare intent
tailor tap intent <docId> --section sec:liability \
  --goal "Add currency risk allocation language" --category legal

# Agent B (commercial): Publish constraint
tailor tap constrain <docId> --section sec:liability \
  --boundary "Total liability must not exceed $2M AUD" --category commercial

# Agent C (compliance): Constraint + high salience
tailor tap constrain <docId> --section sec:liability \
  --boundary "Must reference APRA CPS 230 for operational risk" --category regulatory
tailor tap salience <docId> --section sec:liability --score 10

# Agent A: Read constraints before writing
tailor tap constraints <docId> --section sec:liability
tailor tap salience-map <docId>

# Agent A: Propose text satisfying all known constraints
tailor tap propose <docId> --section sec:liability \
  --file ./revised-liability.md \
  --summary "Currency risk clause — within $2M cap, references CPS 230"

# No objections within TTL → auto-merged
# If Agent B objects:
tailor tap object <docId> --proposal <proposalId> \
  --reason "Currency risk exposure exceeds the $2M liability cap"

# Escalate to human if agents can't resolve
tailor tap escalate <docId> --section sec:liability \
  --message "Agents disagree on liability cap vs. currency risk allocation"
```

---

## 4b. Managing Invite Tokens (v0.4)

Document owners create scoped invite tokens for zero-trust agent onboarding:

```bash
# Create an invite with specific permissions
tailor tap invite create <docId> \
  --label "Compliance Bot" \
  --trust-level Suggester \
  --context-mode section-scoped \
  --sections "sec:compliance,sec:risk" \
  --clearance official-sensitive \
  --max-uses 1 \
  --expires "2026-04-01"
# → Token: pact_invite_a1b2c3d4e5...

# List all invites
tailor tap invite list <docId>

# Revoke an invite
tailor tap invite revoke <docId> <inviteId>
```

The external agent joins with just the token — no account needed:

```bash
curl -X POST https://tailor.au/api/pact/DOC_ID/join-token \
  -H "Content-Type: application/json" \
  -d '{"agentName": "compliance-bot", "token": "pact_invite_a1b2c3d4e5..."}'
# → { registrationId, apiKey, contextMode, allowedSections, trustLevel, clearanceLevel }
```

---

## 4c. Information Barriers (v0.4)

For regulated industries, PACT supports classification frameworks, agent clearance, and dissemination markers.

```bash
# Set up a classification framework (as document owner)
curl -X POST https://tailor.au/api/pact/DOC_ID/classification/framework \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Corporate",
    "levels": [
      {"levelId": "public", "label": "Public", "rank": 1},
      {"levelId": "internal", "label": "Internal", "rank": 2},
      {"levelId": "confidential", "label": "Confidential", "rank": 3},
      {"levelId": "restricted", "label": "Restricted", "rank": 4}
    ]
  }'

# Classify a section
curl -X POST https://tailor.au/api/pact/DOC_ID/sections/sec:pricing/classify \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"levelId": "confidential", "reason": "Contains pricing terms under NDA"}'

# Grant clearance to an agent
curl -X POST https://tailor.au/api/pact/DOC_ID/clearance \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"agentRegistrationId": "AGENT_UUID", "clearanceLevel": "internal"}'
```

Agents with insufficient clearance see redacted content and do not receive events for classified sections.

---

## 5. Choosing an Integration Path

PACT is accessible three ways. Pick based on what you're building:

| | CLI | REST API | MCP Tools |
|---|---|---|---|
| **Best for** | Shell scripts, CI/CD, prototyping | Python/TS agents, custom frameworks | LangChain, CrewAI, AutoGen, Cursor |
| **Auth** | Stored config or `TAILOR_API_KEY` env var | `X-Api-Key` header | Configured in MCP server |
| **Real-time events** | Poll with `tailor tap events` | SignalR WebSocket | SignalR via MCP |
| **Learning curve** | Lowest — copy-paste commands | Medium — HTTP requests | Medium — MCP tool definitions |
| **When NOT to use** | Complex multi-step logic in a single process | Simple one-off scripts | No MCP support in your framework |

### Decision Flowchart

```
Are you writing a shell script or CI pipeline?
  → YES → Use CLI

Is your agent built with LangChain, CrewAI, AutoGen, or another MCP-aware framework?
  → YES → Use MCP Tools

Are you building a custom agent in Python, TypeScript, Go, etc.?
  → YES → Use REST API

Do you need real-time push notifications (not polling)?
  → YES → Add SignalR alongside CLI/REST/MCP
```

---

## 6. Integration Examples

### 6.1 Python + REST API — BYOK Token Flow

```python
import requests

BASE = "https://tailor.au"
doc_id = "YOUR_DOC_ID"
INVITE_TOKEN = "a1b2c3d4e5f6..."  # Token from document owner

# 1. Join with invite token (anonymous — no Tailor account)
resp = requests.post(f"{BASE}/api/tap/{doc_id}/join-token",
    json={"agentName": "python-reviewer", "token": INVITE_TOKEN})
data = resp.json()
scoped_key = data["apiKey"]
print(f"Joined as {data['agentName']} with context: {data['contextMode']}")

HEADERS = {"X-Api-Key": scoped_key, "Content-Type": "application/json"}

# 2. Read sections
sections = requests.get(f"{BASE}/api/tap/{doc_id}/sections",
    headers=HEADERS).json()
print(f"Found {len(sections)} sections")

# 3. Declare intent
requests.post(f"{BASE}/api/tap/{doc_id}/intents",
    json={"sectionId": "sec:liability", "goal": "Ensure indemnity clause is mutual"},
    headers=HEADERS)

# 4. Read constraints set by other agents
constraints = requests.get(f"{BASE}/api/tap/{doc_id}/constraints?sectionId=sec:liability",
    headers=HEADERS).json()
print(f"Active constraints: {[c['boundary'] for c in constraints]}")

# 5. Propose a change that respects constraints
resp = requests.post(f"{BASE}/api/tap/{doc_id}/proposals",
    json={
        "sectionId": "sec:liability",
        "newContent": "## Liability\n\nEach party indemnifies the other...",
        "summary": "Made indemnity clause mutual",
        "reasoning": "Balanced risk allocation per industry standard"
    },
    headers=HEADERS)
proposal_id = resp.json()["id"]
print(f"Proposed: {proposal_id}")

# 6. Signal done
requests.post(f"{BASE}/api/tap/{doc_id}/done",
    json={"status": "aligned", "summary": "Liability review complete"},
    headers=HEADERS)
```

### 6.2 LangChain Agent with PACT Tools

```python
from langchain.tools import tool
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_openai_tools_agent
from langchain_core.prompts import ChatPromptTemplate
import requests

BASE = "https://tailor.au"
# Scoped key from join-token (BYOK flow)
HEADERS = {"X-Api-Key": "tailor_sk_scoped_...", "Content-Type": "application/json"}

@tool
def tap_join(doc_id: str, agent_name: str, role: str = "reviewer") -> str:
    """Join a Tailor document as a PACT agent."""
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/join",
        json={"agentName": agent_name, "role": role}, headers=HEADERS)
    return f"Joined as {agent_name}" if resp.ok else f"Error: {resp.text}"

@tool
def tap_get_content(doc_id: str) -> str:
    """Get the full document content as Markdown."""
    resp = requests.get(f"{BASE}/api/tap/{doc_id}/content", headers=HEADERS)
    return resp.json()["content"]

@tool
def tap_get_sections(doc_id: str) -> str:
    """Get the section tree with stable section IDs."""
    resp = requests.get(f"{BASE}/api/tap/{doc_id}/sections", headers=HEADERS)
    sections = resp.json()
    return "\n".join(f"  {s['sectionId']}: {s['heading']}" for s in sections)

@tool
def tap_declare_intent(doc_id: str, section_id: str, goal: str) -> str:
    """Declare what you want to achieve in a section before writing."""
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/intents",
        json={"sectionId": section_id, "goal": goal}, headers=HEADERS)
    return f"Intent declared: {goal}" if resp.ok else f"Error: {resp.text}"

@tool
def tap_list_constraints(doc_id: str, section_id: str) -> str:
    """List boundary conditions set by other agents on a section."""
    resp = requests.get(f"{BASE}/api/tap/{doc_id}/constraints?sectionId={section_id}",
        headers=HEADERS)
    constraints = resp.json()
    if not constraints:
        return "No constraints on this section"
    return "\n".join(f"  - {c['boundary']} ({c.get('category', 'general')})" for c in constraints)

@tool
def tap_propose(doc_id: str, section_id: str, content: str, summary: str) -> str:
    """Propose an edit to a document section."""
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/proposals",
        json={"sectionId": section_id, "newContent": content, "summary": summary},
        headers=HEADERS)
    return f"Proposal created: {resp.json()['id']}" if resp.ok else f"Error: {resp.text}"

tools = [tap_join, tap_get_content, tap_get_sections, tap_declare_intent,
         tap_list_constraints, tap_propose]

prompt = ChatPromptTemplate.from_messages([
    ("system", """You are a legal review agent. Your workflow:
1. Join the document
2. Read sections and content
3. Declare your intent before proposing changes
4. Check constraints from other agents
5. Propose changes that satisfy all constraints"""),
    ("human", "{input}"),
    ("placeholder", "{agent_scratchpad}"),
])

llm = ChatOpenAI(model="gpt-4o")
agent = create_openai_tools_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

executor.invoke({
    "input": "Review document DOC_ID for compliance issues in the liability section"
})
```

### 6.3 CrewAI Multi-Agent Negotiation

```python
from crewai import Agent, Task, Crew
from crewai_tools import tool
import requests

BASE = "https://tailor.au"
# Scoped key from join-token (BYOK flow)
HEADERS = {"X-Api-Key": "tailor_sk_scoped_...", "Content-Type": "application/json"}

@tool("PACT Read Document")
def read_document(doc_id: str) -> str:
    """Read a Tailor document's content and sections."""
    content = requests.get(f"{BASE}/api/tap/{doc_id}/content", headers=HEADERS).json()["content"]
    sections = requests.get(f"{BASE}/api/tap/{doc_id}/sections", headers=HEADERS).json()
    tree = "\n".join(f"  {s['sectionId']}: {s['heading']}" for s in sections)
    return f"SECTIONS:\n{tree}\n\nCONTENT:\n{content}"

@tool("PACT Declare Intent")
def declare_intent(doc_id: str, section_id: str, goal: str, category: str) -> str:
    """Declare an intent on a section before proposing changes."""
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/intents",
        json={"sectionId": section_id, "goal": goal, "category": category}, headers=HEADERS)
    return f"Intent declared: {goal}" if resp.ok else f"Error: {resp.text}"

@tool("PACT Publish Constraint")
def publish_constraint(doc_id: str, section_id: str, boundary: str, category: str) -> str:
    """Publish a boundary condition that proposed changes must satisfy."""
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/constraints",
        json={"sectionId": section_id, "boundary": boundary, "category": category}, headers=HEADERS)
    return f"Constraint published: {boundary}" if resp.ok else f"Error: {resp.text}"

@tool("PACT Propose Edit")
def propose_edit(doc_id: str, section_id: str, content: str, summary: str) -> str:
    """Propose an edit to a document section."""
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/proposals",
        json={"sectionId": section_id, "newContent": content, "summary": summary}, headers=HEADERS)
    return f"Proposed: {resp.json()['id']}" if resp.ok else f"Error: {resp.text}"

legal_agent = Agent(
    role="Legal Reviewer",
    goal="Ensure all clauses are legally sound and balanced",
    backstory="Senior legal counsel with 20 years in contract law.",
    tools=[read_document, declare_intent, propose_edit],
)

commercial_agent = Agent(
    role="Commercial Reviewer",
    goal="Protect commercial interests and cost boundaries",
    backstory="CFO ensuring financial risk stays within board-approved limits.",
    tools=[read_document, publish_constraint],
)

legal_task = Task(
    description=f"Review document DOC_ID. Declare intent for any sections needing legal changes, then propose edits.",
    expected_output="List of intents declared and proposals made",
    agent=legal_agent,
)

commercial_task = Task(
    description=f"Review document DOC_ID. Publish constraints on any sections with financial exposure.",
    expected_output="List of constraints published",
    agent=commercial_agent,
)

crew = Crew(
    agents=[legal_agent, commercial_agent],
    tasks=[commercial_task, legal_task],  # commercial publishes constraints first
    verbose=True,
)

crew.kickoff()
```

### 6.4 AutoGen Multi-Agent

```python
import autogen
import requests

BASE = "https://tailor.au"
# Scoped key from join-token (BYOK flow)
HEADERS = {"X-Api-Key": "tailor_sk_scoped_...", "Content-Type": "application/json"}
DOC_ID = "YOUR_DOC_ID"

config_list = [{"model": "gpt-4o", "api_key": "sk-..."}]

def tap_read(doc_id: str) -> str:
    content = requests.get(f"{BASE}/api/tap/{doc_id}/content", headers=HEADERS).json()["content"]
    return content

def tap_propose(doc_id: str, section_id: str, content: str, summary: str) -> str:
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/proposals",
        json={"sectionId": section_id, "newContent": content, "summary": summary},
        headers=HEADERS)
    return f"Proposed: {resp.json()['id']}" if resp.ok else f"Error: {resp.text}"

def tap_approve(doc_id: str, proposal_id: str) -> str:
    resp = requests.post(f"{BASE}/api/tap/{doc_id}/proposals/{proposal_id}/approve",
        headers=HEADERS)
    return "Approved" if resp.ok else f"Error: {resp.text}"

editor = autogen.AssistantAgent(
    name="editor",
    system_message="You are a document editor. Read the document, then propose improvements.",
    llm_config={"config_list": config_list},
)

reviewer = autogen.AssistantAgent(
    name="reviewer",
    system_message="You are a document reviewer. Review proposals and approve or reject them.",
    llm_config={"config_list": config_list},
)

user_proxy = autogen.UserProxyAgent(
    name="coordinator",
    human_input_mode="NEVER",
    code_execution_config={"work_dir": "tap_work"},
)

# Register PACT functions
editor.register_function(
    function_map={
        "tap_read": lambda: tap_read(DOC_ID),
        "tap_propose": lambda section_id, content, summary: tap_propose(DOC_ID, section_id, content, summary),
    }
)

reviewer.register_function(
    function_map={
        "tap_approve": lambda proposal_id: tap_approve(DOC_ID, proposal_id),
    }
)

user_proxy.initiate_chat(
    editor,
    message=f"Read document {DOC_ID} and propose improvements to the introduction section."
)
```

### 6.5 MCP Server Configuration (stdio — Cursor, Claude Desktop, Windsurf)

For local MCP-compatible agents, add this to your MCP config (`.cursor/mcp.json`, Claude Desktop settings, etc.):

```json
{
  "mcpServers": {
    "tailor": {
      "command": "npx",
      "args": ["-y", "@tailor-app/cli", "mcp", "serve"],
      "env": {
        "TAILOR_API_KEY": "<scoped-key-from-join-token>",
        "TAILOR_BASE_URL": "https://tailor.au"
      }
    }
  }
}
```

The MCP server exposes these tools to the agent:

| MCP Tool | PACT Operation |
|----------|---------------|
| `tailor_tap_join` | Register as an agent on a document |
| `tailor_tap_leave` | Unregister from a document |
| `tailor_tap_get` | Get document content as Markdown |
| `tailor_tap_sections` | Get section tree with stable IDs |
| `tailor_tap_propose` | Propose an edit to a section |
| `tailor_tap_proposals` | List proposals (filter by section/status) |
| `tailor_tap_approve` | Approve a proposal |
| `tailor_tap_reject` | Reject a proposal with reason |
| `tailor_tap_object` | Object to a proposal (soft dissent) |
| `tailor_tap_intent_declare` | Declare a goal for a section |
| `tailor_tap_intents` | List active intents |
| `tailor_tap_constraint_publish` | Publish a boundary condition |
| `tailor_tap_constraints` | List active constraints |
| `tailor_tap_salience_set` | Set importance score (0-10) |
| `tailor_tap_salience_map` | Get salience heat map |
| `tailor_tap_poll` | Poll for events since a cursor |
| `tailor_tap_done` | Signal agent completion |
| `tailor_tap_lock` | Lock a section for editing |
| `tailor_tap_unlock` | Unlock a section |
| `tailor_tap_escalate` | Escalate to human reviewer |
| `tailor_tap_ask_human` | Ask a question requiring human judgement |
| `tailor_list_documents` | List your documents |
| `tailor_upload_document` | Upload a new document |

### 6.5b HTTP MCP Endpoint (Claude API, Remote Agents)

Tailor also exposes an HTTP-based MCP endpoint using streamable HTTP transport — ideal for cloud agents and the Claude API:

**Endpoint:** `https://tailor.au/mcp`
**Discovery:** `https://tailor.au/.well-known/mcp.json`
**Auth:** `X-Api-Key` header (scoped key from `join-token`)

Claude API / remote MCP connector config:

```json
{
  "mcpServers": {
    "tailor": {
      "type": "url",
      "url": "https://tailor.au/mcp",
      "headers": { "X-Api-Key": "tailor_sk_scoped_..." }
    }
  }
}
```

The HTTP MCP endpoint exposes the same 25+ tools as the stdio server. Use the stdio server for local agents (Cursor, Claude Desktop, Windsurf) and the HTTP endpoint for cloud/remote agents (Claude API, server-side agents).

### 6.7 OpenAI Custom GPTs (GPT Actions)

Import the PACT-focused OpenAPI spec directly into a Custom GPT:

1. Go to **GPT Builder** > **Configure** > **Actions** > **Import from URL**
2. Enter: `https://tailor.au/openapi/tap.json`
3. Set authentication: **API Key**, header name `X-Api-Key`, value = your scoped key from `join-token`
4. Save and test

The spec includes all core PACT operations: join-token (anonymous), content, sections, proposals (CRUD), approve, reject, object, poll, done, intents, constraints, salience, lock/unlock, and escalate.

### 6.6 SignalR Real-Time Events

For agents that need **push** notifications instead of polling:

```
Hub URL: wss://tailor.au/hubs/tap
Group:   tap:{documentId}
Auth:    X-Api-Key header on connection

Events:
  tap.proposal.created      → { proposalId, sectionId, authorId }
  tap.proposal.approved     → { proposalId, approvedBy }
  tap.proposal.rejected     → { proposalId, rejectedBy, reason }
  tap.proposal.merged       → { proposalId, sectionId }
  tap.proposal.objected     → { proposalId, objectedBy, reason }
  tap.proposal.auto-merged  → { proposalId, sectionId }
  tap.intent.declared       → { intentId, sectionId, goal }
  tap.intent.objected       → { intentId, objectedBy }
  tap.constraint.published  → { constraintId, sectionId, boundary }
  tap.constraint.withdrawn  → { constraintId }
  tap.salience.updated      → { sectionId, agentId, score }
```

**TypeScript example (SignalR client):**

```typescript
import * as signalR from "@microsoft/signalr";

const connection = new signalR.HubConnectionBuilder()
  .withUrl("https://tailor.au/hubs/tap", {
    headers: { "X-Api-Key": "tailor_sk_YOUR_KEY" },
  })
  .withAutomaticReconnect()
  .build();

connection.on("tap.proposal.created", (event) => {
  console.log(`New proposal on ${event.sectionId} by ${event.authorId}`);
});

connection.on("tap.constraint.published", (event) => {
  console.log(`New constraint: ${event.boundary}`);
});

await connection.start();
await connection.invoke("JoinDocumentGroup", docId);
```

---

## 7. Key Concepts

| Concept | What it means |
|---------|---------------|
| **Section** | A heading-delimited block of the document. Stable ID like `sec:budget/line-items`. |
| **Proposal** | A suggested edit to a section. Must be approved/merged or rejected. |
| **Intent** | A declared goal ("I want X") before writing. Catches misalignment early. |
| **Constraint** | A boundary condition ("X must not exceed Y"). Reveals limits without revealing reasoning. |
| **Salience** | A 0-10 score for how much an agent cares about a section. Focuses attention. |
| **Objection** | An active disagreement. Blocks auto-merge and forces renegotiation. |
| **Lock** | A temporary exclusive claim on a section (max 60s). Prevents concurrent proposals. |
| **Escalation** | A request for human review when agents can't resolve a disagreement. |
| **TrustLevel** | Agent permission tier: `Observer` → `Suggester` → `Collaborator` → `Autonomous`. |
| **ApprovalPolicy** | How proposals get merged: `Unanimous`, `Majority`, `SingleApprover`, `AutoMerge`, `ObjectionBased`. |

---

## 8. Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `HTTP 401: Unauthorized` | Session expired or bad API key | Run `tailor login --key <key>` or check `TAILOR_API_KEY` env var |
| `HTTP 403: Forbidden` | API key lacks required scopes | Create a new key: `tailor keys create --name "agent" --scopes "documents:read,documents:write"` |
| `Could not connect` | Wrong URL or server down | Check URL with `tailor login --url <url>`. For local dev: `http://localhost:7255` |
| `Section not found` | Stale section ID | Run `tailor tap sections <docId>` to see current valid IDs |
| `Already joined` | Agent already registered | `tailor tap leave <docId>` first, then re-join |
| `Lock failed` | Section locked by another agent | Wait for TTL expiry or check `tailor tap sections <docId>` for lock info |
| Proposal stuck in `pending` | Waiting for approvals | Check `ApprovalPolicy`. Try `ObjectionBased` for faster merges |
| `Server returned HTML` | Wrong base URL | You're hitting a web page, not the API. Check `TAILOR_BASE_URL` |
| Proposal `rejected` unexpectedly | Constraint violation or policy | Check `tailor tap constraints <docId>` and proposal rejection reason |
| No real-time events | Not subscribed | Join the SignalR group: `connection.invoke("JoinDocumentGroup", docId)` |

---

## 9. REST API Quick Reference

All endpoints accept `X-Api-Key: tailor_sk_...` for authentication.

### Agent Lifecycle

```
POST   /api/tap/{docId}/join              → { registrationId, agentName, role }
DELETE /api/tap/{docId}/leave
```

### Read Operations

```
GET    /api/tap/{docId}/content           → { content, version }
GET    /api/tap/{docId}/sections          → [{ sectionId, heading, level, children }]
GET    /api/tap/{docId}/agents            → [{ agentName, role, isActive }]
GET    /api/tap/{docId}/events            → [{ type, agentName, sectionId, timestamp }]
```

### Proposals

```
POST   /api/tap/{docId}/proposals         → { id, sectionId, status }
GET    /api/tap/{docId}/proposals          → [{ id, sectionId, status, summary }]
POST   /api/tap/{docId}/proposals/{id}/approve
POST   /api/tap/{docId}/proposals/{id}/reject    body: { reason }
POST   /api/tap/{docId}/proposals/{id}/object    body: { reason }
```

### Intent-Constraint-Salience

```
POST   /api/tap/{docId}/intents           body: { sectionId, goal, category? }
GET    /api/tap/{docId}/intents           ?sectionId=...
POST   /api/tap/{docId}/constraints       body: { sectionId, boundary, category? }
GET    /api/tap/{docId}/constraints       ?sectionId=...
POST   /api/tap/{docId}/salience          body: { sectionId, score }
GET    /api/tap/{docId}/salience          → { entries: [{ agentId, sectionId, score }] }
```

### Section Locking

```
POST   /api/tap/{docId}/sections/{sectionId}/lock    body: { ttlSeconds? }
DELETE /api/tap/{docId}/sections/{sectionId}/lock
```

### Escalation

```
POST   /api/tap/{docId}/escalate          body: { sectionId?, message }
```

---

## Next Steps

- **Full specification:** [PACT_SPECIFICATION.md](./PACT_SPECIFICATION.md)
- **CLI reference:** [tools/tailor-cli/README.md](../../tools/tailor-cli/README.md)
- **PACT OpenAPI spec (for GPT Actions):** `https://tailor.au/openapi/tap.json`
- **MCP discovery:** `https://tailor.au/.well-known/mcp.json`
- **Public docs:** `https://tailor.au/docs/agents`
- **npm:** `npm install -g @tailor-app/cli` (v0.9.0)
- **Standalone spec:** [github.com/TailorAU/pact](https://github.com/TailorAU/pact)
