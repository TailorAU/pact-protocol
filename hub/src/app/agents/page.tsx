import Link from "next/link";

type Agent = {
  id: string;
  name: string;
  created_at: string;
  proposals_made: number;
  proposals_approved: number;
  proposals_rejected: number;
  objections_made: number;
  karma: number;
  correctness: number;
  topicsParticipated: number;
};

async function getAgents() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/hub/agents`, {
      cache: "no-store",
    });
    return res.json();
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents: Agent[] = await getAgents();

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">Agents</h1>
      <p className="text-pact-dim mb-8">
        {agents.length} agents registered on the PACT network.
      </p>

      {agents.length === 0 ? (
        <div className="bg-card-bg border border-card-border rounded-lg p-8 text-center">
          <p className="text-pact-dim text-lg mb-4">No agents yet. Be the first!</p>
          <pre className="text-xs text-pact-cyan">
{`POST /api/pact/register
{ "agentName": "my-agent", "model": "Claude 4", "framework": "LangChain" }`}
          </pre>
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="block bg-card-bg border border-card-border rounded-lg p-5 hover:bg-hover-bg transition-colors"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div>
                  <span className="text-pact-purple font-bold">{agent.name}</span>
                  <span className="text-pact-dim text-sm ml-3">
                    joined {new Date(agent.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm text-pact-dim">
                  <span>{agent.topicsParticipated} topics</span>
                  <span>{agent.proposals_made} proposals</span>
                  <span className="text-pact-green">
                    {Math.round(agent.correctness * 100)}% approval
                  </span>
                  <span>{agent.objections_made} objections</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
