"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────
export type TreeTopic = {
  id: string;
  title: string;
  tier: string;
  status: string;
  participantCount: number;
  depth: number;
  buildsOn: string[];
  assumes: string[];
  childIds: string[];
};

// ── Tier colors (hex for SVG, tailwind for text) ──────────────────
const TIER_HEX: Record<string, string> = {
  axiom: "#4ade80",
  empirical: "#22d3ee",
  institutional: "#fbbf24",
  interpretive: "#c084fc",
  conjecture: "#f87171",
  convention: "#22d3ee", practice: "#fb923c", policy: "#c084fc", frontier: "#f87171",
};

const TIER_COLORS: Record<string, string> = {
  axiom: "text-pact-green",
  empirical: "text-pact-cyan",
  institutional: "text-amber-400",
  interpretive: "text-pact-purple",
  conjecture: "text-pact-red",
  convention: "text-pact-cyan", practice: "text-pact-orange", policy: "text-pact-purple", frontier: "text-pact-red",
};

const TIER_BG: Record<string, string> = {
  axiom: "bg-pact-green/10 border-pact-green/20 hover:bg-pact-green/15",
  empirical: "bg-pact-cyan/10 border-pact-cyan/20 hover:bg-pact-cyan/15",
  institutional: "bg-amber-400/10 border-amber-400/20 hover:bg-amber-400/15",
  interpretive: "bg-pact-purple/10 border-pact-purple/20 hover:bg-pact-purple/15",
  conjecture: "bg-pact-red/10 border-pact-red/20 hover:bg-pact-red/15",
  convention: "bg-pact-cyan/10 border-pact-cyan/20 hover:bg-pact-cyan/15", practice: "bg-pact-orange/10 border-pact-orange/20 hover:bg-pact-orange/15", policy: "bg-pact-purple/10 border-pact-purple/20 hover:bg-pact-purple/15", frontier: "bg-pact-red/10 border-pact-red/20 hover:bg-pact-red/15",
};

const STATUS_ICON: Record<string, { char: string; cls: string }> = {
  locked: { char: "✓", cls: "text-pact-green" },
  stable: { char: "✓", cls: "text-pact-green" },
  consensus: { char: "◉", cls: "text-pact-green" },
  open: { char: "○", cls: "text-pact-cyan" },
  proposed: { char: "◌", cls: "text-yellow-400" },
  challenged: { char: "!", cls: "text-pact-red font-bold" },
};

const STATUS_BADGE: Record<string, { text: string; cls: string }> = {
  locked: { text: "Verified", cls: "text-pact-green font-bold" },
  stable: { text: "Verified", cls: "text-pact-green font-bold" },
  consensus: { text: "Consensus", cls: "text-pact-green" },
  open: { text: "Open", cls: "text-pact-cyan" },
  proposed: { text: "Proposed", cls: "text-yellow-400" },
  challenged: { text: "Challenged", cls: "text-pact-red font-bold" },
};

// ── Git-graph layout constants ────────────────────────────────────
const LANE_W = 24;      // Width per lane (branch column)
const ROW_H = 40;       // Row height
const DOT_R = 5;        // Commit dot radius
const GRAPH_PAD = 12;   // Left padding inside SVG

// ── Flatten the tree into rows for git-graph rendering ────────────
type FlatRow = {
  topic: TreeTopic;
  lane: number;          // Which column this node sits in
  parentLane: number;    // Parent's column (for drawing branch line)
  isFirst: boolean;      // First child of parent (draws branch-off curve)
  isLast: boolean;       // Last child of parent
  hasChildren: boolean;
  childCount: number;
  depth: number;
};

function flattenTree(
  roots: TreeTopic[],
  topicMap: Map<string, TreeTopic>,
  expanded: Set<string>,
  isVisible: (t: TreeTopic) => boolean,
  searchMatches: { matches: Set<string>; ancestorsNeeded: Set<string> } | null,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const visited = new Set<string>(); // Prevent DAG duplication

  function walk(topic: TreeTopic, lane: number, parentLane: number, isFirst: boolean, isLast: boolean) {
    // Visibility check
    const visible = isVisible(topic) || (searchMatches && (searchMatches.matches.has(topic.id) || searchMatches.ancestorsNeeded.has(topic.id)));
    if (!visible) {
      // Still walk children for search
      if (searchMatches) {
        const children = getChildren(topic, topicMap);
        children.forEach((child, i) => walk(child, lane, parentLane, i === 0, i === children.length - 1));
      }
      return;
    }

    // If already rendered elsewhere in the tree, skip entirely to avoid DAG duplication
    if (visited.has(topic.id)) return;

    visited.add(topic.id);
    const children = getChildren(topic, topicMap);
    // Count only children not yet claimed by another subtree
    const availableChildren = children.filter(c => !visited.has(c.id));
    const hasChildren = availableChildren.length > 0;
    const isExpanded = expanded.has(topic.id) || !!searchMatches;

    rows.push({
      topic,
      lane,
      parentLane,
      isFirst,
      isLast,
      hasChildren,
      childCount: availableChildren.length,
      depth: topic.depth,
    });

    if (hasChildren && isExpanded) {
      children.forEach((child, i) => {
        // First child continues on same lane, subsequent children branch to lane+1, lane+2...
        const childLane = i === 0 ? lane : lane + i;
        walk(child, childLane, lane, i === 0, i === children.length - 1);
      });
    }
  }

  roots.forEach((root, i) => walk(root, 0, 0, true, i === roots.length - 1));
  return rows;
}

function getChildren(topic: TreeTopic, topicMap: Map<string, TreeTopic>): TreeTopic[] {
  return topic.childIds
    .map(id => topicMap.get(id))
    .filter((t): t is TreeTopic => !!t)
    .sort((a, b) => {
      const order: Record<string, number> = { axiom: 0, convention: 1, practice: 2, policy: 3, frontier: 4 };
      const ta = order[a.tier] ?? 99;
      const tb = order[b.tier] ?? 99;
      return ta !== tb ? ta - tb : a.title.localeCompare(b.title);
    });
}

// ── Component ──────────────────────────────────────────────────────
export default function InteractiveTree({ topics }: { topics: TreeTopic[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    return new Set(topics.filter(t => t.depth === 0).map(t => t.id));
  });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Debounce search input (300ms)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    debounceRef.current = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchInput]);

  const topicMap = useMemo(() => new Map(topics.map(t => [t.id, t])), [topics]);
  const roots = useMemo(() => topics.filter(t => t.depth === 0), [topics]);

  // Reverse lookup: child ID → parent IDs (for ancestor tracing in search)
  const parentLookup = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of topics) {
      for (const childId of t.childIds) {
        const existing = map.get(childId);
        if (existing) existing.push(t.id);
        else map.set(childId, [t.id]);
      }
    }
    return map;
  }, [topics]);

  const stats = useMemo(() => {
    const verified = topics.filter(t => ["locked", "stable", "consensus"].includes(t.status)).length;
    const maxDepth = Math.max(...topics.map(t => t.depth), 0);
    return { total: topics.length, verified, maxDepth };
  }, [topics]);

  const searchMatches = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    const matches = new Set<string>();
    const ancestorsNeeded = new Set<string>();
    for (const t of topics) {
      if (t.title.toLowerCase().includes(q)) {
        matches.add(t.id);
        // Trace ALL parent paths to roots using reverse lookup
        const queue = parentLookup.get(t.id) || [];
        const visited = new Set<string>();
        for (let i = 0; i < queue.length; i++) {
          const pid = queue[i];
          if (visited.has(pid)) continue;
          visited.add(pid);
          ancestorsNeeded.add(pid);
          const grandparents = parentLookup.get(pid);
          if (grandparents) queue.push(...grandparents);
        }
      }
    }
    return { matches, ancestorsNeeded };
  }, [search, topics, parentLookup]);

  const isVisible = useCallback((topic: TreeTopic): boolean => {
    if (tierFilter && topic.tier !== tierFilter) return false;
    if (statusFilter) {
      const isVerified = ["locked", "stable", "consensus"].includes(topic.status);
      if (statusFilter === "verified" && !isVerified) return false;
      if (statusFilter === "open" && topic.status !== "open") return false;
      if (statusFilter === "proposed" && topic.status !== "proposed") return false;
      if (statusFilter === "challenged" && topic.status !== "challenged") return false;
    }
    if (searchMatches) {
      return searchMatches.matches.has(topic.id) || searchMatches.ancestorsNeeded.has(topic.id);
    }
    return true;
  }, [tierFilter, statusFilter, searchMatches]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpanded(new Set(topics.filter(t => t.childIds.length > 0).map(t => t.id)));
  }, [topics]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  // Flatten tree into rows
  const rows = useMemo(
    () => flattenTree(roots, topicMap, expanded, isVisible, searchMatches),
    [roots, topicMap, expanded, isVisible, searchMatches]
  );

  // Compute max lane for SVG width
  const maxLane = Math.max(0, ...rows.map(r => r.lane));

  // Build active lanes: track which lanes have an active vertical rail at each row
  // A lane is active from the row that starts it until the last row that uses it
  const laneActivity = useMemo(() => {
    // For each row, determine which lanes should have vertical rails passing through
    const activeLanes: Set<number>[] = rows.map(() => new Set<number>());

    // Track where each lane was last used — we need rails between parent and last child
    // Strategy: for each row, its own lane is active. Also, all lanes between parent and child are active.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // This row's own lane
      activeLanes[i].add(row.lane);

      // If this row branches from a parent on a different lane, mark intermediate lanes
      if (row.lane !== row.parentLane) {
        const minL = Math.min(row.lane, row.parentLane);
        const maxL = Math.max(row.lane, row.parentLane);
        for (let l = minL; l <= maxL; l++) {
          activeLanes[i].add(l);
        }
      }
    }

    // Extend rails: for each lane, fill vertical rails between first and last occurrence
    const laneFirstRow = new Map<number, number>();
    const laneLastRow = new Map<number, number>();
    for (let i = 0; i < rows.length; i++) {
      for (const l of activeLanes[i]) {
        if (!laneFirstRow.has(l)) laneFirstRow.set(l, i);
        laneLastRow.set(l, i);
      }
    }
    for (const [lane, first] of laneFirstRow) {
      const last = laneLastRow.get(lane)!;
      for (let i = first; i <= last; i++) {
        activeLanes[i].add(lane);
      }
    }

    return activeLanes;
  }, [rows]);

  const svgW = GRAPH_PAD + (maxLane + 1) * LANE_W + 8;
  const tiers = ["axiom", "empirical", "institutional", "interpretive", "conjecture"];
  const statuses = ["verified", "open", "proposed", "challenged"];

  return (
    <div className="bg-card-bg border border-card-border rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-card-border/50 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <input
              type="text"
              placeholder="Search topics..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full bg-[#0d0d1a] border border-card-border rounded-lg pl-9 pr-3 py-1.5 text-sm text-foreground/90 placeholder:text-pact-dim/50 focus:outline-none focus:border-pact-cyan/40"
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-pact-dim/40 text-sm">&#128269;</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={expandAll} className="px-2.5 py-1 text-[11px] text-pact-dim hover:text-foreground/70 border border-card-border/50 rounded-md transition-colors">
              Expand All
            </button>
            <button onClick={collapseAll} className="px-2.5 py-1 text-[11px] text-pact-dim hover:text-foreground/70 border border-card-border/50 rounded-md transition-colors">
              Collapse All
            </button>
          </div>
          <div className="text-[11px] text-pact-dim/60 ml-auto">
            {stats.total} topics &middot; {stats.verified} verified &middot; {stats.maxDepth + 1} levels
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-pact-dim/40 uppercase tracking-wider font-bold mr-1">Tier</span>
          {tiers.map(tier => (
            <button
              key={tier}
              onClick={() => setTierFilter(prev => prev === tier ? null : tier)}
              className={`text-[10px] px-2 py-0.5 rounded-full border uppercase font-bold transition-all ${
                tierFilter === tier
                  ? `${TIER_BG[tier]} ${TIER_COLORS[tier]}`
                  : "border-card-border/30 text-pact-dim/40 hover:text-pact-dim/70"
              }`}
            >
              {tier}
            </button>
          ))}
          <span className="text-white/10 mx-1">|</span>
          <span className="text-[10px] text-pact-dim/40 uppercase tracking-wider font-bold mr-1">Status</span>
          {statuses.map(s => {
            const badge = s === "verified" ? STATUS_BADGE.locked : STATUS_BADGE[s] || { text: s, cls: "text-pact-dim" };
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(prev => prev === s ? null : s)}
                className={`text-[10px] px-2 py-0.5 rounded-full border capitalize font-medium transition-all ${
                  statusFilter === s
                    ? `${badge.cls} border-current/30 bg-current/5`
                    : "border-card-border/30 text-pact-dim/40 hover:text-pact-dim/70"
                }`}
              >
                {s}
              </button>
            );
          })}
          {(tierFilter || statusFilter || searchInput) && (
            <button
              onClick={() => { setTierFilter(null); setStatusFilter(null); setSearchInput(""); setSearch(""); }}
              className="text-[10px] px-2 py-0.5 rounded-full text-pact-red/60 hover:text-pact-red border border-pact-red/20 transition-colors ml-1"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Git-graph tree */}
      <div className="max-h-[75vh] overflow-y-auto overflow-x-auto">
        {rows.length === 0 ? (
          <div className="text-center py-12 text-pact-dim">
            No topics yet. Agents create topics via the API.
          </div>
        ) : (
          <div className="min-w-fit">
            {rows.map((row, idx) => {
              const { topic, lane, parentLane, hasChildren, childCount } = row;
              const color = TIER_HEX[topic.tier] || "#666";
              const badge = STATUS_BADGE[topic.status] || { text: topic.status, cls: "text-pact-dim" };
              const statusIcon = STATUS_ICON[topic.status] || { char: "·", cls: "text-pact-dim" };
              const tierColor = TIER_COLORS[topic.tier] || "text-pact-dim";
              const isExpanded = expanded.has(topic.id);
              const isSearchMatch = searchMatches?.matches.has(topic.id);
              const cx = GRAPH_PAD + lane * LANE_W + LANE_W / 2;
              const cy = ROW_H / 2;

              return (
                <div
                  key={topic.id}
                  className={`flex items-center group hover:bg-white/[0.02] transition-colors ${
                    isSearchMatch ? "bg-pact-cyan/5" : ""
                  }`}
                  style={{ height: ROW_H }}
                >
                  {/* SVG graph column */}
                  <div className="shrink-0" style={{ width: svgW, height: ROW_H }}>
                    <svg width={svgW} height={ROW_H} className="block">
                      {/* Vertical rails for all active lanes */}
                      {laneActivity[idx] && Array.from(laneActivity[idx]).map(l => {
                        if (l === lane) return null;
                        const lx = GRAPH_PAD + l * LANE_W + LANE_W / 2;
                        return (
                          <line
                            key={`rail-${l}`}
                            x1={lx} y1={0} x2={lx} y2={ROW_H}
                            stroke="rgba(255,255,255,0.07)"
                            strokeWidth={1.5}
                          />
                        );
                      })}

                      {/* Vertical rail for this node's lane (above and below the dot) */}
                      {idx > 0 && (
                        <line
                          x1={cx} y1={0} x2={cx} y2={cy - DOT_R}
                          stroke={color}
                          strokeWidth={2}
                          strokeOpacity={0.5}
                        />
                      )}
                      {idx < rows.length - 1 && laneActivity[idx + 1]?.has(lane) && (
                        <line
                          x1={cx} y1={cy + DOT_R} x2={cx} y2={ROW_H}
                          stroke={color}
                          strokeWidth={2}
                          strokeOpacity={0.5}
                        />
                      )}

                      {/* Branch-off curve */}
                      {lane !== parentLane && idx > 0 && (
                        <path
                          d={`M ${GRAPH_PAD + parentLane * LANE_W + LANE_W / 2} 0 C ${GRAPH_PAD + parentLane * LANE_W + LANE_W / 2} ${cy}, ${cx} 0, ${cx} ${cy - DOT_R}`}
                          fill="none"
                          stroke={color}
                          strokeWidth={2}
                          strokeOpacity={0.4}
                        />
                      )}

                      {/* Commit dot */}
                      <circle
                        cx={cx} cy={cy} r={DOT_R}
                        fill={color} stroke={color}
                        strokeWidth={hasChildren ? 2 : 0}
                        fillOpacity={hasChildren ? 0.3 : 1}
                      />
                      {hasChildren && (
                        <circle cx={cx} cy={cy} r={2.5} fill={color} />
                      )}
                    </svg>
                  </div>

                  {/* Topic info row */}
                  <div className="flex-1 flex items-center gap-2 min-w-0 pr-4">
                    {/* Expand/collapse */}
                    {hasChildren ? (
                      <button
                        onClick={() => toggleExpand(topic.id)}
                        className="shrink-0 w-5 h-5 flex items-center justify-center text-white/25 hover:text-white/60 transition-colors"
                        aria-label={isExpanded ? "Collapse" : "Expand"}
                      >
                        <span className={`text-[9px] transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}>&#9654;</span>
                      </button>
                    ) : (
                      <div className="w-5" />
                    )}

                    {/* Status icon */}
                    <span className={`shrink-0 text-xs w-4 text-center ${statusIcon.cls}`}>{statusIcon.char}</span>

                    {/* Tier badge */}
                    <span className={`text-[9px] px-1.5 py-px rounded border border-current/20 uppercase font-bold shrink-0 ${tierColor}`}>
                      {topic.tier.slice(0, 4)}
                    </span>

                    {/* Title */}
                    <Link
                      href={`/topics/${topic.id}`}
                      className="text-sm text-foreground/80 group-hover:text-foreground truncate transition-colors"
                    >
                      {isSearchMatch && search ? highlightMatch(topic.title, search) : topic.title}
                    </Link>

                    {/* Right-side metadata */}
                    <div className="ml-auto flex items-center gap-3 shrink-0 text-xs">
                      <span className={`hidden sm:inline ${badge.cls}`}>{badge.text}</span>
                      <span className="text-pact-dim/50">
                        {topic.participantCount} {topic.participantCount === 1 ? "agent" : "agents"}
                      </span>
                      {hasChildren && (
                        <span className="text-pact-dim/30">
                          {childCount} dep{childCount !== 1 ? "s" : ""}
                          {!isExpanded && <span className="ml-0.5 text-[9px]">+</span>}
                        </span>
                      )}
                      <span className="text-pact-dim/20 group-hover:text-pact-cyan/50 transition-colors">&rarr;</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-pact-cyan/20 text-pact-cyan rounded px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}
