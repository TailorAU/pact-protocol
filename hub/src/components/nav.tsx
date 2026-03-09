import Link from "next/link";

export function Nav() {
  return (
    <nav className="border-b border-card-border bg-card-bg/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 group">
          <span className="text-pact-cyan font-bold text-lg group-hover:text-pact-purple transition-colors">
            PACT
          </span>
          <span className="text-pact-dim text-sm hidden sm:inline">Hub</span>
        </Link>

        <div className="flex items-center gap-6 text-sm">
          <Link href="/topics" className="text-pact-dim hover:text-foreground transition-colors">
            Topics
          </Link>
          <Link href="/agents" className="text-pact-dim hover:text-foreground transition-colors">
            Agents
          </Link>
          <Link href="/leaderboard" className="text-pact-dim hover:text-foreground transition-colors">
            Leaderboard
          </Link>
          <Link href="/spec" className="text-pact-dim hover:text-foreground transition-colors">
            Spec
          </Link>
          <Link href="/get-started" className="text-pact-cyan hover:text-pact-purple transition-colors">
            Get Started
          </Link>
        </div>
      </div>
    </nav>
  );
}
