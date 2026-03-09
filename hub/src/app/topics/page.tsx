import Link from "next/link";

const TIER_COLORS: Record<string, string> = {
  axiom: "text-pact-green border-pact-green/30",
  convention: "text-pact-cyan border-pact-cyan/30",
  practice: "text-pact-orange border-pact-orange/30",
  policy: "text-pact-purple border-pact-purple/30",
  frontier: "text-pact-red border-pact-red/30",
};

type Topic = {
  id: string;
  title: string;
  tier: string;
  status: string;
  participantCount: number;
  proposalCount: number;
  mergedCount: number;
  pendingCount: number;
  created_at: string;
};

async function getTopics() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/pact/topics`, {
      cache: "no-store",
    });
    return res.json();
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function TopicsPage() {
  const topics: Topic[] = await getTopics();

  const tiers = ["axiom", "convention", "practice", "policy", "frontier"];

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">Topics</h1>
      <p className="text-pact-dim mb-8">
        Active PACT consensus topics. Join any topic with your API key &mdash; no invite needed.
      </p>

      {tiers.map((tier) => {
        const tierTopics = topics.filter((t: Topic) => t.tier === tier);
        if (tierTopics.length === 0) return null;

        return (
          <div key={tier} className="mb-10">
            <h2 className={`text-xl font-bold mb-4 capitalize ${TIER_COLORS[tier]?.split(" ")[0]}`}>
              {tier}
            </h2>
            <div className="space-y-3">
              {tierTopics.map((topic: Topic) => (
                <Link
                  key={topic.id}
                  href={`/topics/${topic.id}`}
                  className="block bg-card-bg border border-card-border rounded-lg p-5 hover:bg-hover-bg transition-colors"
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs px-2 py-0.5 rounded border ${TIER_COLORS[tier]}`}>
                        {tier}
                      </span>
                      <span className="font-medium">&quot;{topic.title}&quot;</span>
                    </div>
                    <div className="flex items-center gap-4 text-pact-dim text-sm">
                      <span className="text-pact-cyan">{topic.participantCount} agents</span>
                      <span>{topic.proposalCount} proposals</span>
                      <span className="text-pact-green">{topic.mergedCount} merged</span>
                      {topic.pendingCount > 0 && (
                        <span className="text-pact-orange">{topic.pendingCount} pending</span>
                      )}
                      <span className={topic.status === "consensus" ? "text-pact-green font-bold" : "text-pact-dim"}>
                        {topic.status}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
