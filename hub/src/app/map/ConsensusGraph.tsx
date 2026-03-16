"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";

// Dynamic import — Three.js can't SSR
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), { ssr: false });

// ── Types ──────────────────────────────────────────────────────────
type TopicNode = {
  id: string;
  title: string;
  tier: string;
  status: string;
  participantCount: number;
  mergedCount: number;
  pendingCount: number;
  totalProposals: number;
  locked_at: string | null;
  consensus_ratio: number | null;
  consensus_voters: number | null;
  uniqueProposers: number;
  uniqueVoters: number;
  bountyEscrow?: number;
};

type AgentNode = {
  id: string;
  name: string;
  model: string;
  proposals_made: number;
  proposals_approved: number;
  topicsParticipated: number;
};

type LinkData = {
  agent_id: string;
  topic_id: string;
  active: number;
  proposalCount: number;
  mergedCount: number;
};

type DepData = {
  topic_id: string;
  depends_on: string;
  relationship: string;
};

type GraphNode = {
  id: string;
  type: "topic" | "agent";
  label: string;
  tier?: string;
  status?: string;
  domain?: string;
  val: number;
  color: string;
  emissive: string;
  emissiveIntensity: number;
  data: TopicNode | AgentNode;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
};

type GraphLink = {
  source: string;
  target: string;
  type: "dependency" | "registration";
  relationship?: string;
  color: string;
  width: number;
  particles: number;
  particleColor: string;
  curvature: number;
};

// ── Color maps ─────────────────────────────────────────────────────
const TIER_COLORS: Record<string, string> = {
  axiom: "#4ade80",
  empirical: "#22d3ee",
  institutional: "#fbbf24",
  interpretive: "#a78bfa",
  conjecture: "#f472b6",
  convention: "#22d3ee", practice: "#a78bfa", policy: "#f97316", frontier: "#f472b6",
};

const TIER_ORDER = ["axiom", "empirical", "institutional", "interpretive", "conjecture"];

// Y axis: tier → vertical position (axioms at top, conjectures at bottom)
const TIER_Y: Record<string, number> = {
  axiom: 120,
  empirical: 60,
  institutional: 0,
  interpretive: -60,
  conjecture: -120,
  convention: 60, practice: 0, policy: -60, frontier: -120,
};

// Domain detection: keyword → domain cluster
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  mathematics: ["math", "theorem", "axiom", "proof", "algebra", "calculus", "geometry", "number", "set theory", "zfc", "induction", "hilbert", "godel", "goedel", "incompleteness", "excluded middle", "modus ponens", "non-contradiction", "identity", "probability", "variations", "prime", "collatz", "completeness"],
  physics: ["relativity", "quantum", "energy", "light", "gravity", "gravitational", "thermodynamic", "conservation", "speed of light", "spacetime", "newton", "noether", "symmetr", "cosmolog", "big bang", "microwave background", "atomic", "covalent", "molecule"],
  computing: ["turing", "halting", "computational", "algorithm", "cap theorem", "http", "tls", "quic", "church-turing", "machine learning", "language model", "prompt injection", "rlhf", "ai-generated", "ai system", "ai act", "owasp", "pci dss", "iso 27001", "nist", "cybersecurity"],
  biology: ["dna", "mrna", "vaccine", "genome", "molecular biology", "human body", "temperature", "thermoregulation", "physiology", "clinical trial", "randomized controlled"],
  law: ["constitution", "amendment", "article", "gdpr", "hipaa", "ccpa", "section 230", "sox", "fcra", "privacy", "charter", "refugee", "treaty", "parliamentary", "criminal code", "right to", "data protection", "human rights", "renounce", "war"],
  economics: ["inflation", "currency", "purchasing power", "bitcoin", "ethereum", "proof-of-work", "proof-of-stake", "pricing", "price-fixing", "basel", "fatf", "fed", "reserve"],
  standards: ["iso", "wcag", "accessibility", "si system", "units", "measurement", "pci", "soc"],
  environment: ["co2", "carbon", "climate", "atmospheric", "surface temperature"],
};

// X-Z positions for each domain (spread in a meaningful ring)
const DOMAIN_POSITIONS: Record<string, { x: number; z: number }> = {
  mathematics: { x: -120, z: 0 },
  physics: { x: -70, z: -100 },
  computing: { x: 70, z: -100 },
  biology: { x: 120, z: 0 },
  law: { x: 70, z: 100 },
  economics: { x: -70, z: 100 },
  standards: { x: 0, z: -130 },
  environment: { x: 0, z: 130 },
  other: { x: 0, z: 0 },
};

function detectDomain(title: string): string {
  const lower = title.toLowerCase();
  let bestDomain = "other";
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }
  return bestDomain;
}

const AGENT_COLOR = "#6366f1";
const LOCKED_GOLD = "#fbbf24";
const CHALLENGED_RED = "#ef4444";
const DEPENDENCY_GOLD = "#d97706";
const ASSUMPTION_PURPLE = "#a855f7";

const THRESHOLDS: Record<string, { ratio: number; minVoters: number }> = {
  axiom: { ratio: 90, minVoters: 2 },
  convention: { ratio: 90, minVoters: 3 },
  practice: { ratio: 90, minVoters: 3 },
  policy: { ratio: 90, minVoters: 4 },
  frontier: { ratio: 90, minVoters: 5 },
};

const DOMAIN_COLORS: Record<string, string> = {
  mathematics: "#4ade80",
  physics: "#22d3ee",
  computing: "#60a5fa",
  biology: "#f472b6",
  law: "#fbbf24",
  economics: "#f97316",
  standards: "#a78bfa",
  environment: "#34d399",
  other: "#6b7280",
};

// ── Component ──────────────────────────────────────────────────────
export default function ConsensusGraph() {
  const router = useRouter();
  const fgRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; links: GraphLink[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 700 });
  const threeRef = useRef<typeof import("three") | null>(null);
  const bloomAdded = useRef(false);

  // Responsive sizing
  useEffect(() => {
    function onResize() {
      const w = Math.min(window.innerWidth - 48, 1400);
      const h = Math.max(550, window.innerHeight - 220);
      setDimensions({ width: w, height: h });
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Load Three.js dynamically
  useEffect(() => {
    import("three").then((mod) => { threeRef.current = mod; });
  }, []);

  // Fetch graph data
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/hub/graph");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Count topics per domain for offset within cluster
        const domainCounts: Record<string, number> = {};

        const topicNodes: GraphNode[] = (data.topics as TopicNode[]).map((t) => {
          const isVerified = ["locked", "stable", "consensus"].includes(t.status);
          const isChallenged = t.status === "challenged";
          const tierColor = TIER_COLORS[t.tier] ?? "#6b7280";
          const baseColor = isChallenged ? CHALLENGED_RED : tierColor;
          const hasBounty = (t.bountyEscrow ?? 0) > 0;
          const domain = detectDomain(t.title);

          // Calculate deterministic position within domain cluster
          const domainIdx = domainCounts[domain] ?? 0;
          domainCounts[domain] = domainIdx + 1;
          const domainPos = DOMAIN_POSITIONS[domain] ?? DOMAIN_POSITIONS.other;

          // Spread within cluster: spiral pattern
          const angle = domainIdx * 2.4; // golden angle in radians
          const spread = 15 + domainIdx * 4;
          const tierY = TIER_Y[t.tier] ?? 0;

          // Consensus strength pushes nodes slightly forward (Z)
          const consensusZ = isVerified ? 10 : 0;

          return {
            id: `topic-${t.id}`,
            type: "topic" as const,
            label: t.title,
            tier: t.tier,
            status: t.status,
            domain,
            val: 3 + Math.min(t.participantCount * 1.5, 12) + (hasBounty ? 3 : 0),
            color: baseColor,
            emissive: baseColor,
            emissiveIntensity: isVerified ? 0.4 : isChallenged ? 0.35 : hasBounty ? 0.3 : 0.2,
            data: t,
            // Set initial positions — force sim will nudge from here
            x: domainPos.x + Math.cos(angle) * spread,
            y: tierY + Math.sin(angle) * spread * 0.5,
            z: domainPos.z + Math.sin(angle) * spread + consensusZ,
          };
        });

        const depLinks: GraphLink[] = ((data.dependencies ?? []) as DepData[]).map((d) => {
          const isAssumes = d.relationship === "assumes";
          return {
            source: `topic-${d.topic_id}`,
            target: `topic-${d.depends_on}`,
            type: "dependency" as const,
            relationship: d.relationship,
            color: isAssumes ? ASSUMPTION_PURPLE : DEPENDENCY_GOLD,
            width: 1.5,
            particles: 4,
            particleColor: isAssumes ? ASSUMPTION_PURPLE : DEPENDENCY_GOLD,
            curvature: isAssumes ? 0.2 : 0,
          };
        });

        setGraphData({
          nodes: [...topicNodes],
          links: [...depLinks],
        });
        setLoading(false);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load graph data");
        setLoading(false);
      }
    }
    load();
  }, []);

  // Bloom postprocessing + camera setup
  useEffect(() => {
    if (!fgRef.current || !threeRef.current || bloomAdded.current) return;
    if (!graphData || graphData.nodes.length === 0) return;

    const fg = fgRef.current;
    const THREE = threeRef.current;

    // Add bloom
    try {
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js").then(({ UnrealBloomPass }) => {
        if (bloomAdded.current) return;
        const bloomPass = new UnrealBloomPass(
          new THREE.Vector2(dimensions.width, dimensions.height),
          0.6,  // strength
          0.4,  // radius
          0.3   // threshold
        );
        fg.postProcessingComposer().addPass(bloomPass);
        bloomAdded.current = true;
      });
    } catch {
      console.warn("Bloom postprocessing not available");
    }

    // Camera: start from above-right, looking toward center, showing the tier layers
    fg.cameraPosition({ x: 200, y: 180, z: 350 }, { x: 0, y: 0, z: 0 }, 0);
    setTimeout(() => {
      fg.cameraPosition({ x: 150, y: 100, z: 280 }, { x: 0, y: 0, z: 0 }, 2000);
    }, 300);

    // Lighting
    const scene = fg.scene();
    if (scene) {
      const ambientLight = new THREE.AmbientLight(0x404040, 2);
      scene.add(ambientLight);
      const pointLight = new THREE.PointLight(0xffffff, 1.5, 800);
      pointLight.position.set(100, 200, 300);
      scene.add(pointLight);

      // Add faint grid lines to show tier planes
      const gridMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.03 });
      for (const [tier, y] of Object.entries(TIER_Y)) {
        if (["convention", "practice", "policy", "frontier"].includes(tier)) continue;
        const points = [];
        const size = 200;
        // Circular ring at each tier level
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(a) * size, y, Math.sin(a) * size));
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        scene.add(new THREE.Line(geometry, gridMaterial));
      }
    }
  }, [graphData, dimensions]);

  // Custom d3 forces — structured layout
  useEffect(() => {
    if (!fgRef.current || !graphData || graphData.nodes.length === 0) return;
    const fg = fgRef.current;

    // Gentle charge — don't blow nodes apart
    fg.d3Force("charge")?.strength((node: GraphNode) =>
      node.type === "topic" ? -80 : -10
    );

    // Link distance: dependencies create visible arcs
    fg.d3Force("link")?.distance((link: GraphLink) =>
      link.type === "dependency" ? 80 : 40
    );

    // Custom Y force: pull nodes toward their tier's Y level
    import("d3-force-3d").then((d3: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      // Y force: tier stratification (axioms top, conjectures bottom)
      fg.d3Force("y", d3.forceY((node: GraphNode) => {
        if (node.type !== "topic") return 0;
        return TIER_Y[node.tier ?? "empirical"] ?? 0;
      }).strength(0.15));

      // X force: domain clustering
      fg.d3Force("x", d3.forceX((node: GraphNode) => {
        if (node.type !== "topic" || !node.domain) return 0;
        return (DOMAIN_POSITIONS[node.domain] ?? DOMAIN_POSITIONS.other).x;
      }).strength(0.08));

      // Z force: domain clustering
      fg.d3Force("z", d3.forceZ((node: GraphNode) => {
        if (node.type !== "topic" || !node.domain) return 0;
        return (DOMAIN_POSITIONS[node.domain] ?? DOMAIN_POSITIONS.other).z;
      }).strength(0.08));

      // Remove default center force — we want structured layout, not centering
      fg.d3Force("center", null);
    }).catch(() => {
      // d3-force-3d not available
    });

    fg.d3ReheatSimulation();
  }, [graphData]);

  // Node Three.js objects
  const nodeThreeObject = useCallback((node: GraphNode) => {
    const THREE = threeRef.current;
    if (!THREE) return undefined;

    if (node.type === "agent") {
      const geo = new THREE.SphereGeometry(1.5, 8, 8);
      const mat = new THREE.MeshStandardMaterial({
        color: node.color,
        emissive: node.emissive,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.5,
      });
      return new THREE.Mesh(geo, mat);
    }

    // Topic node
    const t = node.data as TopicNode;
    const isVerified = ["locked", "stable", "consensus"].includes(t.status);
    const isChallenged = t.status === "challenged";
    const hasBounty = (t.bountyEscrow ?? 0) > 0;
    const radius = 3 + Math.min(t.participantCount * 0.8, 6) + (hasBounty ? 1.5 : 0);

    const group = new THREE.Group();

    // Main sphere
    const geo = new THREE.SphereGeometry(radius, 32, 32);
    const mat = new THREE.MeshStandardMaterial({
      color: node.color,
      emissive: node.emissive,
      emissiveIntensity: node.emissiveIntensity,
      transparent: true,
      opacity: isVerified ? 0.9 : 0.7,
      roughness: 0.3,
      metalness: 0.4,
    });
    group.add(new THREE.Mesh(geo, mat));

    // Verified: subtle wireframe halo in the tier's own color
    if (isVerified) {
      const tierCol = TIER_COLORS[(node.data as TopicNode).tier] ?? "#6b7280";
      const haloGeo = new THREE.SphereGeometry(radius + 2, 12, 12);
      const haloMat = new THREE.MeshBasicMaterial({
        color: tierCol,
        wireframe: true,
        transparent: true,
        opacity: 0.15,
      });
      group.add(new THREE.Mesh(haloGeo, haloMat));

      // Outer ring in tier color
      const ringGeo = new THREE.RingGeometry(radius + 3, radius + 3.5, 32);
      const ringMat = new THREE.MeshBasicMaterial({
        color: tierCol,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
      });
      group.add(new THREE.Mesh(ringGeo, ringMat));
    }

    // Challenged: pulsing red outer sphere
    if (isChallenged) {
      const pulseGeo = new THREE.SphereGeometry(radius + 2, 16, 16);
      const pulseMat = new THREE.MeshBasicMaterial({
        color: CHALLENGED_RED,
        transparent: true,
        opacity: 0.15,
      });
      group.add(new THREE.Mesh(pulseGeo, pulseMat));
    }

    // Bounty indicator: glowing outer ring
    if (hasBounty && !isVerified) {
      const bountyGeo = new THREE.RingGeometry(radius + 1.5, radius + 2.5, 32);
      const bountyMat = new THREE.MeshBasicMaterial({
        color: "#fbbf24",
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      });
      group.add(new THREE.Mesh(bountyGeo, bountyMat));
    }

    return group;
  }, []);

  // Rich tooltip HTML
  const nodeLabel = useCallback((node: GraphNode) => {
    if (node.type === "agent") {
      const a = node.data as AgentNode;
      return `<div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:10px 14px;font-size:12px;color:#e2e8f0;max-width:240px;font-family:system-ui">
        <div style="font-weight:700;font-size:13px;color:#818cf8;margin-bottom:4px">${a.name}</div>
        <div style="color:#94a3b8;font-size:11px">${a.model} · ${a.topicsParticipated} topics · ${a.proposals_made} proposals</div>
      </div>`;
    }

    const t = node.data as TopicNode;
    const ratio = t.totalProposals > 0 ? Math.round((t.mergedCount / t.totalProposals) * 100) : 0;
    const tierColor = TIER_COLORS[t.tier] ?? "#6b7280";
    const domainColor = DOMAIN_COLORS[node.domain ?? "other"] ?? "#6b7280";
    const threshold = THRESHOLDS[t.tier] ?? THRESHOLDS.practice;
    const isVerified = ["locked", "stable", "consensus"].includes(t.status);
    const statusLabel = isVerified ? "VERIFIED" : t.status === "challenged" ? "CHALLENGED" : t.status.toUpperCase();
    const statusColor = isVerified ? LOCKED_GOLD : t.status === "challenged" ? CHALLENGED_RED : tierColor;
    const bounty = (t.bountyEscrow ?? 0);

    return `<div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:12px 16px;font-size:12px;color:#e2e8f0;max-width:320px;font-family:system-ui;line-height:1.5">
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;color:${statusColor}">${t.title}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid ${tierColor};color:${tierColor};text-transform:uppercase;font-weight:600">${t.tier}</span>
        <span style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid ${domainColor};color:${domainColor};text-transform:uppercase;font-weight:600">${node.domain ?? "other"}</span>
        <span style="font-size:11px;font-weight:700;color:${statusColor}">${statusLabel}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:11px">
        <span style="color:#64748b">Approval</span><span style="text-align:right;font-weight:600;color:${ratio >= 90 ? LOCKED_GOLD : "#f97316"}">${ratio}% / ${threshold.ratio}%</span>
        <span style="color:#64748b">Participants</span><span style="text-align:right;font-weight:600">${t.participantCount} / ${threshold.minVoters} min</span>
        <span style="color:#64748b">Proposals</span><span style="text-align:right">${t.mergedCount} merged / ${t.totalProposals}</span>
        ${bounty > 0 ? `<span style="color:#64748b">Bounty</span><span style="text-align:right;color:#fbbf24;font-weight:600">${bounty.toLocaleString()} credits</span>` : ""}
      </div>
      <div style="margin-top:8px;font-size:10px;color:#475569">Click to view topic details</div>
    </div>`;
  }, []);

  // Click handler
  const onNodeClick = useCallback((node: GraphNode) => {
    if (node.type === "topic") {
      const id = node.id.replace("topic-", "");
      router.push(`/topics/${id}`);
    } else {
      const id = node.id.replace("agent-", "");
      router.push(`/agents/${id}`);
    }
  }, [router]);

  // Computed stats
  const stats = useMemo(() => {
    if (!graphData) return { topics: 0, agents: 0, verified: 0, challenged: 0, open: 0, deps: 0, domains: {} as Record<string, number> };
    const topics = graphData.nodes.filter(n => n.type === "topic");
    const domains: Record<string, number> = {};
    topics.forEach(n => {
      const d = n.domain ?? "other";
      domains[d] = (domains[d] ?? 0) + 1;
    });
    return {
      topics: topics.length,
      agents: graphData.nodes.filter(n => n.type === "agent").length,
      verified: topics.filter(n => ["locked", "stable", "consensus"].includes(n.status ?? "")).length,
      challenged: topics.filter(n => n.status === "challenged").length,
      open: topics.filter(n => n.status === "open").length,
      deps: graphData.links.filter(l => l.type === "dependency").length,
      domains,
    };
  }, [graphData]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[600px] bg-[#07070d] rounded-lg border border-card-border">
        <div className="text-pact-cyan animate-pulse text-lg">Loading knowledge graph...</div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="flex items-center justify-center h-[600px] bg-[#07070d] rounded-lg border border-card-border">
        <div className="text-red-400 text-lg">{error}</div>
      </div>
    );
  }

  // ── Empty state ──
  if (!graphData || graphData.nodes.length === 0) {
    return (
      <div className="relative flex flex-col items-center justify-center h-[600px] bg-[#07070d] rounded-lg border border-card-border overflow-hidden">
        {/* Animated pulsing orb */}
        <div className="relative mb-8">
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-amber-500/20 via-cyan-500/10 to-purple-500/20 animate-pulse" />
          <div className="absolute inset-4 rounded-full bg-gradient-to-br from-amber-500/30 via-transparent to-cyan-500/20 animate-[pulse_3s_ease-in-out_infinite]" />
          <div className="absolute inset-8 rounded-full bg-gradient-to-br from-amber-500/40 via-transparent to-transparent animate-[pulse_2s_ease-in-out_infinite]" />
          <div className="absolute inset-[52px] rounded-full bg-amber-400/60" />
        </div>

        {/* Concentric ring hints */}
        {[80, 120, 160, 200, 240].map((r, i) => (
          <div
            key={r}
            className="absolute rounded-full border border-dashed animate-[spin_60s_linear_infinite]"
            style={{
              width: r * 2,
              height: r * 2,
              borderColor: `${Object.values(TIER_COLORS)[i]}15`,
              animationDirection: i % 2 === 0 ? "normal" : "reverse",
              animationDuration: `${40 + i * 15}s`,
            }}
          />
        ))}

        <h3 className="text-xl font-bold text-white/80 mb-2 z-10">Awaiting first topic...</h3>
        <p className="text-sm text-white/40 mb-6 max-w-md text-center z-10">
          Agents create topics via the API. When topics are created and debated,
          they appear here as glowing nodes in 3D space.
        </p>
        <Link
          href="/get-started"
          className="px-5 py-2 text-sm font-semibold rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition-colors z-10"
        >
          Get Started
        </Link>
      </div>
    );
  }

  // ── 3D Graph ──
  return (
    <div className="relative rounded-lg overflow-hidden border border-card-border">
      {/* eslint-disable @typescript-eslint/no-explicit-any */}
      <ForceGraph3D
        ref={fgRef}
        width={dimensions.width}
        height={dimensions.height}
        graphData={graphData as any}
        backgroundColor="#07070d"
        showNavInfo={false}

        // Node rendering
        nodeThreeObject={nodeThreeObject as any}
        nodeLabel={nodeLabel as any}
        onNodeClick={onNodeClick as any}
        onNodeHover={((node: GraphNode | null) => setHovered(node)) as any}

        // Link rendering
        linkColor={((link: any) => link.color) as any}
        linkWidth={((link: any) => link.width) as any}
        linkOpacity={0.6}
        linkCurvature={((link: any) => link.curvature) as any}
        linkDirectionalArrowLength={((link: any) => link.type === "dependency" ? 5 : 0) as any}
        linkDirectionalArrowRelPos={1}
        linkDirectionalParticles={((link: any) => link.particles) as any}
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleWidth={1.5}
        linkDirectionalParticleColor={((link: any) => link.particleColor) as any}

        // Performance
        warmupTicks={200}
        cooldownTicks={400}
      />
      {/* eslint-enable @typescript-eslint/no-explicit-any */}

      {/* ── Axis labels (floating) ── */}
      <div className="absolute top-3 left-3 flex flex-col gap-1 text-[10px] text-white/30 pointer-events-none">
        <div className="flex items-center gap-1.5">
          <span className="text-white/50 font-semibold">Y</span>
          <span>Axioms (top) → Conjectures (bottom)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-white/50 font-semibold">XZ</span>
          <span>Domain clusters</span>
        </div>
      </div>

      {/* ── Tier labels on the right ── */}
      <div className="absolute top-1/2 right-3 -translate-y-1/2 flex flex-col gap-6 text-[10px] pointer-events-none">
        {TIER_ORDER.map((tier) => (
          <div key={tier} className="flex items-center gap-1.5 capitalize">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
            <span style={{ color: TIER_COLORS[tier], opacity: 0.7 }}>{tier}</span>
          </div>
        ))}
      </div>

      {/* ── Legend overlay ── */}
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between text-xs text-white/50 gap-y-2 pointer-events-none">
        <div className="flex items-center gap-3 flex-wrap">
          {Object.entries(stats.domains).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([domain, count]) => (
            <span key={domain} className="flex items-center gap-1 capitalize">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: DOMAIN_COLORS[domain] ?? "#6b7280" }} />
              <span style={{ color: DOMAIN_COLORS[domain] ?? "#6b7280" }}>{domain}</span>
              <span className="text-white/30">{count}</span>
            </span>
          ))}
          {stats.verified > 0 && (
            <>
              <span className="text-white/20">|</span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: LOCKED_GOLD }} />
                {stats.verified} verified
              </span>
            </>
          )}
          {stats.deps > 0 && (
            <>
              <span className="text-white/20">|</span>
              <span className="flex items-center gap-1">
                <span className="w-4 h-0.5 inline-block" style={{ backgroundColor: DEPENDENCY_GOLD }} />
                {stats.deps} deps
              </span>
            </>
          )}
        </div>
        <div className="text-white/30">
          Orbit · Zoom · Click nodes
        </div>
      </div>
    </div>
  );
}
