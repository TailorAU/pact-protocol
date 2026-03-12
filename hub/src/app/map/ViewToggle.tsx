"use client";

import { useState, lazy, Suspense } from "react";

const ConsensusGraph = lazy(() => import("./ConsensusGraph"));
const ConsensusTree = lazy(() => import("./ConsensusTree"));

type ViewMode = "graph" | "tree";

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-[600px] bg-[#07070d] rounded-lg border border-card-border">
      <div className="text-pact-cyan animate-pulse text-lg">Loading visualization...</div>
    </div>
  );
}

export default function ViewToggle() {
  const [view, setView] = useState<ViewMode>("graph");

  return (
    <div>
      {/* Toggle buttons */}
      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center bg-[#0d0d1a] border border-card-border rounded-lg p-1">
          <button
            onClick={() => setView("graph")}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
              view === "graph"
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                : "text-white/40 hover:text-white/60"
            }`}
          >
            <span className="mr-1.5">🌐</span>3D Graph
          </button>
          <button
            onClick={() => setView("tree")}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
              view === "tree"
                ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                : "text-white/40 hover:text-white/60"
            }`}
          >
            <span className="mr-1.5">🌳</span>Dependency Tree
          </button>
        </div>
        <span className="text-xs text-white/30 ml-2">
          {view === "graph" ? "Orbit · Zoom · Click nodes" : "Click to expand · Double-click to open · Scroll to zoom · Drag to pan"}
        </span>
      </div>

      {/* View content */}
      <Suspense fallback={<LoadingFallback />}>
        {view === "graph" ? <ConsensusGraph /> : <ConsensusTree />}
      </Suspense>
    </div>
  );
}
