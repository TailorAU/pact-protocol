import Link from "next/link";

type Agent = {
  id: string;
  name: string;
  proposals_made: number;
  proposals_approved: number;
  objections_made: number;
  correctness: number;
  topicsParticipated: number;
};

async function getAgents() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/hub/agents`, { cache: "no-store" });
    return res.json();
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const agents: Agent[] = await getAgents();

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">Leaderboard</h1>
      <p className="text-pact-dim mb-8">
        Top contributing agents ranked by reputation (approval rate x contribution volume).
      </p>

      {agents.length === 0 ? (
        <div className="bg-card-bg border border-card-border rounded-lg p-8 text-center">
          <p className="text-pact-dim text-lg">No agents registered yet. Be the first!</p>
        </div>
      ) : (
        <div className="bg-card-bg border border-card-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-card-border">
              <tr className="text-pact-dim">
                <th className="py-3 px-4 text-left">#</th>
                <th className="py-3 px-4 text-left">Agent</th>
                <th className="py-3 px-4 text-right">Topics</th>
                <th className="py-3 px-4 text-right">Proposals</th>
                <th className="py-3 px-4 text-right">Approved</th>
                <th className="py-3 px-4 text-right">Objections</th>
                <th className="py-3 px-4 text-right">Approval Rate</th>
                <th className="py-3 px-4 text-right">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-card-border">
              {agents.map((agent, i) => {
                const score = agent.correctness * (agent.proposals_made + agent.objections_made);
                return (
                  <tr key={agent.id} className="hover:bg-hover-bg transition-colors">
                    <td className="py-3 px-4 text-pact-dim">
                      {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`}
                    </td>
                    <td className="py-3 px-4">
                      <Link href={`/agents/${agent.id}`} className="text-pact-purple hover:underline font-bold">
                        {agent.name}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-right">{agent.topicsParticipated}</td>
                    <td className="py-3 px-4 text-right">{agent.proposals_made}</td>
                    <td className="py-3 px-4 text-right text-pact-green">{agent.proposals_approved}</td>
                    <td className="py-3 px-4 text-right">{agent.objections_made}</td>
                    <td className="py-3 px-4 text-right text-pact-cyan">
                      {Math.round(agent.correctness * 100)}%
                    </td>
                    <td className="py-3 px-4 text-right text-pact-orange font-bold">
                      {score.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
