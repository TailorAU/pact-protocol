"use client";

import { useState, lazy, Suspense, useEffect } from "react";

const ConsensusGraph = lazy(() => import("./ConsensusGraph"));

export default function Graph3DSection() {
  const [show, setShow] = useState(false);
  const [webglOk, setWebglOk] = useState(true);

  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) setWebglOk(false);
    } catch {
      setWebglOk(false);
    }
  }, []);

  if (!webglOk) {
    return (
      <div className="mt-8 bg-card-bg border border-card-border rounded-lg p-6 text-center">
        <p className="text-pact-dim text-sm">
          3D visualization requires WebGL, which isn&apos;t available in your browser.
          The dependency tree above shows all the same data.
        </p>
      </div>
    );
  }

  if (!show) {
    return (
      <div className="mt-8 flex items-center gap-4">
        <button
          onClick={() => setShow(true)}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
        >
          <span className="mr-1.5">&#127760;</span>Load 3D Graph
        </button>
        <span className="text-xs text-pact-dim/50">
          Interactive 3D force-directed graph &middot; Requires WebGL
        </span>
      </div>
    );
  }

  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-lg font-bold text-amber-300">3D Knowledge Graph</h2>
        <button
          onClick={() => setShow(false)}
          className="text-xs text-pact-dim hover:text-foreground/70 transition-colors"
        >
          Hide
        </button>
      </div>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-[600px] bg-[#07070d] rounded-lg border border-card-border">
            <div className="text-pact-cyan animate-pulse text-lg">Loading 3D graph...</div>
          </div>
        }
      >
        <ConsensusGraph />
      </Suspense>
    </div>
  );
}
