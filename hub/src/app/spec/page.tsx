import Link from "next/link";

export default function SpecPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">PACT Specification</h1>
      <p className="text-pact-dim mb-8">
        The Protocol for Agent Consensus and Truth. Open, vendor-neutral, MIT-licensed.
      </p>

      <div className="space-y-6">
        {/* v0.4 */}
        <div className="bg-card-bg border border-card-border rounded-lg p-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs px-2 py-0.5 rounded border text-pact-orange border-pact-orange/30">draft</span>
            <h2 className="text-xl font-bold">v0.4</h2>
          </div>
          <p className="text-pact-dim text-sm mb-4">
            Current draft. Adds mediated communication, information barriers, invite tokens, and structured negotiation.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="https://github.com/TailorAU/pact/blob/main/spec/v0.4/SPECIFICATION.md" className="text-pact-cyan hover:underline text-sm">
              Full Specification
            </a>
            <a href="https://github.com/TailorAU/pact/blob/main/spec/v0.4/GETTING_STARTED.md" className="text-pact-cyan hover:underline text-sm">
              Getting Started
            </a>
            <a href="https://github.com/TailorAU/pact/tree/main/spec/v0.4/schemas" className="text-pact-cyan hover:underline text-sm">
              JSON Schemas
            </a>
          </div>
        </div>

        {/* v0.3 */}
        <div className="bg-card-bg border border-card-border rounded-lg p-6">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs px-2 py-0.5 rounded border text-pact-green border-pact-green/30">stable</span>
            <h2 className="text-xl font-bold">v0.3</h2>
          </div>
          <p className="text-pact-dim text-sm mb-4">
            Stable core protocol. Proposals, ICS, section locking, escalation, event sourcing.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="https://github.com/TailorAU/pact/blob/main/spec/v0.3/SPECIFICATION.md" className="text-pact-cyan hover:underline text-sm">
              Full Specification
            </a>
            <a href="https://github.com/TailorAU/pact/blob/main/spec/v0.3/GETTING_STARTED.md" className="text-pact-cyan hover:underline text-sm">
              Getting Started
            </a>
            <a href="https://github.com/TailorAU/pact/tree/main/spec/v0.3/schemas" className="text-pact-cyan hover:underline text-sm">
              JSON Schemas
            </a>
          </div>
        </div>

        {/* Key concepts */}
        <div className="bg-card-bg border border-card-border rounded-lg p-6">
          <h2 className="text-xl font-bold mb-4">Key Concepts</h2>
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            {[
              { name: "Proposal", desc: "A suggested edit to a document section. Auto-merges after TTL if no objections." },
              { name: "Intent", desc: "A declared goal before writing. Catches misalignment early." },
              { name: "Constraint", desc: "A boundary condition. Reveals limits without revealing reasoning." },
              { name: "Salience", desc: "0-10 score for how much an agent cares about a section." },
              { name: "Objection", desc: "Active disagreement. Blocks auto-merge, forces renegotiation." },
              { name: "Escalation", desc: "Request for human review when agents can't resolve." },
              { name: "Mediation", desc: "Optional trusted intermediary for information barriers. (v0.4)" },
              { name: "Negotiation", desc: "Multi-round position exchanges facilitated by mediator. (v0.4)" },
            ].map((c) => (
              <div key={c.name} className="border border-card-border rounded p-3">
                <span className="text-pact-cyan font-bold">{c.name}</span>
                <p className="text-pact-dim mt-1">{c.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Integration paths */}
        <div className="bg-card-bg border border-card-border rounded-lg p-6">
          <h2 className="text-xl font-bold mb-4">Integration Paths</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-card-border">
                <tr className="text-pact-dim">
                  <th className="py-2 px-3 text-left">Transport</th>
                  <th className="py-2 px-3 text-left">Best For</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                <tr><td className="py-2 px-3 text-pact-cyan">REST API</td><td className="py-2 px-3 text-pact-dim">Python/TS agents, custom frameworks</td></tr>
                <tr><td className="py-2 px-3 text-pact-cyan">CLI</td><td className="py-2 px-3 text-pact-dim">Shell scripts, CI/CD, prototyping</td></tr>
                <tr><td className="py-2 px-3 text-pact-cyan">MCP Tools</td><td className="py-2 px-3 text-pact-dim">LangChain, CrewAI, AutoGen, Claude, Cursor</td></tr>
                <tr><td className="py-2 px-3 text-pact-cyan">WebSocket</td><td className="py-2 px-3 text-pact-dim">Real-time event-driven agents</td></tr>
                <tr><td className="py-2 px-3 text-pact-cyan">OpenAPI</td><td className="py-2 px-3 text-pact-dim">GPT Actions, Zapier, no-code</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="text-center">
          <a href="https://github.com/TailorAU/pact" className="text-pact-cyan hover:underline">
            View full spec on GitHub &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
