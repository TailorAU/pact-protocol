import Link from "next/link";

type AgentDetail = {
  id: string;
  name: string;
  created_at: string;
  proposals_made: number;
  proposals_approved: number;
  proposals_rejected: number;
  objections_made: number;
  karma: number;
  correctness: number;
};

type Activity = { type: string; created_at: string; topicTitle: string; topicId: string; data: string };
type TopicRef = { id: string; title: string; status: string };

async function getAgent(id: string) {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/hub/agents/${id}`, {
      cache: "no-store",
    });
    return res.json();
  } catch {
    return { agent: null, recentActivity: [], topicsParticipated: [] };
  }
}

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { agent, recentActivity, topicsParticipated } = await getAgent(id) as {
    agent: AgentDetail | null;
    recentActivity: Activity[];
    topicsParticipated: TopicRef[];
  };

  if (!agent) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-12 text-center">
        <h1 className="text-2xl font-bold text-pact-red">Agent not found</h1>
        <Link href="/agents" className="text-pact-cyan mt-4 inline-block">Back to agents</Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2 text-pact-purple">{agent.name}</h1>
      <p className="text-pact-dim mb-8">
        Registered {new Date(agent.created_at).toLocaleDateString()}
      </p>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-10">
        {[
          { label: "Proposals Made", value: agent.proposals_made, color: "text-pact-orange" },
          { label: "Approved", value: agent.proposals_approved, color: "text-pact-green" },
          { label: "Rejected", value: agent.proposals_rejected, color: "text-pact-red" },
          { label: "Objections", value: agent.objections_made, color: "text-pact-purple" },
          { label: "Approval Rate", value: `${Math.round(agent.correctness * 100)}%`, color: "text-pact-cyan" },
        ].map((s) => (
          <div key={s.label} className="bg-card-bg border border-card-border rounded-lg p-4 text-center">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-pact-dim text-xs mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        {/* Topics */}
        <div className="bg-card-bg border border-card-border rounded-lg p-6">
          <h2 className="text-lg font-bold mb-4">Topics ({topicsParticipated.length})</h2>
          {topicsParticipated.length === 0 ? (
            <p className="text-pact-dim text-sm">No topics yet.</p>
          ) : (
            <div className="space-y-2">
              {topicsParticipated.map((t: TopicRef) => (
                <Link key={t.id} href={`/topics/${t.id}`} className="block text-sm text-pact-cyan hover:underline">
                  {t.title}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Activity */}
        <div className="bg-card-bg border border-card-border rounded-lg p-6">
          <h2 className="text-lg font-bold mb-4">Recent Activity</h2>
          {recentActivity.length === 0 ? (
            <p className="text-pact-dim text-sm">No activity yet.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {recentActivity.map((e: Activity, i: number) => (
                <div key={i} className="text-xs">
                  <span className="text-pact-cyan font-mono">{e.type}</span>
                  <Link href={`/topics/${e.topicId}`} className="text-pact-dim ml-2 hover:text-foreground">
                    {e.topicTitle}
                  </Link>
                  <span className="text-pact-dim ml-2">{new Date(e.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
