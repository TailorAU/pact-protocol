"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";

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

type DepData = {
  topic_id: string;
  depends_on: string;
  relationship: string;
};

type TreeNode = {
  topic: TopicNode;
  children: TreeNode[];
  depth: number;
  x: number;
  y: number;
  collapsed: boolean;
  dependentCount: number; // How many other topics depend on this one
};

// ── Colors ─────────────────────────────────────────────────────────
const TIER_COLORS: Record<string, string> = {
  axiom: "#4ade80",
  empirical: "#22d3ee",
  institutional: "#fbbf24",
  interpretive: "#a78bfa",
  conjecture: "#f472b6",
  convention: "#22d3ee", practice: "#a78bfa", policy: "#f97316", frontier: "#f472b6",
};

const STATUS_COLORS: Record<string, string> = {
  locked: "#fbbf24",
  stable: "#fbbf24",
  consensus: "#22c55e",
  open: "#22d3ee",
  proposed: "#a78bfa",
  challenged: "#ef4444",
};

const SHARED_COLOR = "#f59e0b"; // Amber for shared dependencies (2+ dependents)
const KEYSTONE_COLOR = "#ef4444"; // Red for keystone dependencies (3+ dependents)
const BG_COLOR = 0x07070d;
const LINE_COLOR = 0x334155;
const LINE_HIGHLIGHT = 0xd97706;
const TEXT_COLOR = "#e2e8f0";
const DIM_TEXT = "#64748b";

// ── Layout constants ───────────────────────────────────────────────
const NODE_WIDTH = 340;
const NODE_HEIGHT = 56;
const H_GAP = 60;
const V_GAP = 40;
const PADDING = 80;

// ── Component ──────────────────────────────────────────────────────
export default function ConsensusTree() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<typeof import("three") | null>(null);
  const rendererRef = useRef<any>(null);
  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const raycasterRef = useRef<any>(null);
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const animFrameRef = useRef<number>(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 700 });
  const [hovered, setHovered] = useState<string | null>(null);

  const treeDataRef = useRef<TreeNode[]>([]);
  const flatNodesRef = useRef<TreeNode[]>([]);
  const nodeMeshMapRef = useRef<Map<string, any>>(new Map());
  const lineMeshesRef = useRef<any[]>([]);
  const collapsedSetRef = useRef<Set<string>>(new Set());

  // Camera state for pan/zoom
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; startPanX: number; startPanY: number }>({
    active: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0,
  });

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

  // Build tree structure from flat topic + dependency data
  const dependentCountMapRef = useRef<Map<string, number>>(new Map());

  const buildTree = useCallback((topics: TopicNode[], deps: DepData[]): TreeNode[] => {
    const topicMap = new Map(topics.map(t => [t.id, t]));
    const childrenMap = new Map<string, string[]>(); // parent -> children (depends_on -> topic_ids)
    const parentSet = new Set<string>();

    // Count how many topics depend on each topic (for shared dependency highlighting)
    const depCountMap = new Map<string, number>();
    for (const d of deps) {
      const children = childrenMap.get(d.depends_on) || [];
      children.push(d.topic_id);
      childrenMap.set(d.depends_on, children);
      parentSet.add(d.topic_id);
      depCountMap.set(d.depends_on, (depCountMap.get(d.depends_on) || 0) + 1);
    }
    dependentCountMapRef.current = depCountMap;

    // Root topics = those with no parent dependencies
    const rootIds = topics.filter(t => !parentSet.has(t.id)).map(t => t.id);

    function buildNode(id: string, depth: number, visited: Set<string>): TreeNode | null {
      if (visited.has(id)) return null; // Prevent cycles
      visited.add(id);
      const topic = topicMap.get(id);
      if (!topic) return null;

      const childIds = childrenMap.get(id) || [];
      const isCollapsed = collapsedSetRef.current.has(id);
      const children: TreeNode[] = isCollapsed ? [] : childIds
        .map(cid => buildNode(cid, depth + 1, new Set(visited)))
        .filter((n): n is TreeNode => n !== null)
        .sort((a, b) => a.topic.title.localeCompare(b.topic.title));

      return {
        topic,
        children,
        depth,
        x: 0,
        y: 0,
        collapsed: isCollapsed,
        dependentCount: depCountMap.get(id) || 0,
      };
    }

    const trees = rootIds
      .map(id => buildNode(id, 0, new Set()))
      .filter((n): n is TreeNode => n !== null)
      .sort((a, b) => a.topic.title.localeCompare(b.topic.title));

    return trees;
  }, []);

  // Layout tree — compute x,y for each node (top-down, left-to-right)
  const layoutTree = useCallback((roots: TreeNode[]): TreeNode[] => {
    const flat: TreeNode[] = [];
    let currentY = PADDING;

    function layoutNode(node: TreeNode) {
      node.x = PADDING + node.depth * (NODE_WIDTH + H_GAP);
      node.y = currentY;
      flat.push(node);
      currentY += NODE_HEIGHT + V_GAP;

      for (const child of node.children) {
        layoutNode(child);
      }
    }

    for (const root of roots) {
      layoutNode(root);
    }

    return flat;
  }, []);

  // Create/update Three.js scene
  const updateScene = useCallback(() => {
    const THREE = threeRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!THREE || !scene || !camera) return;

    // Clear existing meshes
    while (scene.children.length > 0) {
      scene.remove(scene.children[0]);
    }
    nodeMeshMapRef.current.clear();
    lineMeshesRef.current = [];

    const flat = flatNodesRef.current;
    if (flat.length === 0) return;

    // Calculate total bounds
    const maxX = Math.max(...flat.map(n => n.x + NODE_WIDTH));
    const maxY = Math.max(...flat.map(n => n.y + NODE_HEIGHT));

    // Draw connection lines
    for (const node of flat) {
      for (const child of node.children) {
        const startX = node.x + NODE_WIDTH;
        const startY = node.y + NODE_HEIGHT / 2;
        const endX = child.x;
        const endY = child.y + NODE_HEIGHT / 2;
        const midX = startX + (endX - startX) / 2;

        // Create curved path with line segments
        const points: any[] = [];
        const segments = 20;
        for (let i = 0; i <= segments; i++) {
          const t = i / segments;
          let px, py;
          if (t < 0.5) {
            const t2 = t * 2;
            px = startX + (midX - startX) * t2;
            py = startY;
          } else {
            const t2 = (t - 0.5) * 2;
            px = midX + (endX - midX) * t2;
            py = startY + (endY - startY) * t2;
          }
          points.push(new THREE.Vector3(px, -py, 0));
        }

        // Color lines to shared/keystone deps differently
        const childDepCount = dependentCountMapRef.current.get(child.topic.id) || 0;
        const lineColorVal = childDepCount >= 3 ? 0xef4444 : childDepCount >= 2 ? 0xf59e0b : LINE_COLOR;
        const lineOpacity = childDepCount >= 2 ? 0.7 : 0.5;

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({
          color: lineColorVal,
          transparent: true,
          opacity: lineOpacity,
        });
        const line = new THREE.Line(geometry, material);
        scene.add(line);
        lineMeshesRef.current.push(line);
      }
    }

    // Draw node cards
    for (const node of flat) {
      const topic = node.topic;
      const tierColor = TIER_COLORS[topic.tier] ?? "#6b7280";
      const statusColor = STATUS_COLORS[topic.status] ?? "#6b7280";
      const isVerified = ["locked", "stable", "consensus"].includes(topic.status);
      const hasChildren = (collapsedSetRef.current.has(topic.id)) || node.children.length > 0;
      const depCount = node.dependentCount;
      const isKeystone = depCount >= 3; // 3+ topics depend on this
      const isShared = depCount >= 2;   // 2+ topics depend on this

      // Card background
      const cardGeo = new THREE.PlaneGeometry(NODE_WIDTH, NODE_HEIGHT);
      const canvas = document.createElement("canvas");
      canvas.width = NODE_WIDTH * 2;
      canvas.height = NODE_HEIGHT * 2;
      const ctx = canvas.getContext("2d")!;

      // Background — shared/keystone deps get special background
      const borderColor = isKeystone ? KEYSTONE_COLOR : isShared ? SHARED_COLOR : tierColor;
      ctx.fillStyle = isKeystone ? "#1a0f0f" : isShared ? "#1a1a0f" : isVerified ? "#1a1a0f" : "#0d0d1a";
      ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 12);
      ctx.fill();

      // Border — thicker and brighter for shared deps
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = isKeystone ? 4 : isShared ? 3 : isVerified ? 3 : 1.5;
      ctx.globalAlpha = isKeystone ? 1 : isShared ? 0.9 : isVerified ? 0.8 : 0.4;
      ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 12);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Left accent bar
      ctx.fillStyle = borderColor;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(2, 16, 6, canvas.height - 32);
      ctx.globalAlpha = 1;

      // Tier badge
      ctx.font = "bold 18px system-ui";
      ctx.fillStyle = tierColor;
      ctx.globalAlpha = 0.9;
      const tierText = topic.tier.toUpperCase();
      ctx.fillText(tierText, 24, 34);
      ctx.globalAlpha = 1;

      // Status badge
      const statusText = isVerified ? "✓ VERIFIED" : topic.status === "challenged" ? "⚠ CHALLENGED" : topic.status.toUpperCase();
      ctx.font = "bold 16px system-ui";
      ctx.fillStyle = statusColor;
      const tierWidth = ctx.measureText(tierText).width;
      ctx.fillText(statusText, 24 + tierWidth + 16, 34);

      // Shared dependency badge
      if (isKeystone) {
        ctx.font = "bold 14px system-ui";
        ctx.fillStyle = KEYSTONE_COLOR;
        const keystoneText = `⬢ KEYSTONE (${depCount} dependents)`;
        const keystoneWidth = ctx.measureText(keystoneText).width;
        ctx.fillText(keystoneText, canvas.width - keystoneWidth - 20, 34);
      } else if (isShared) {
        ctx.font = "bold 14px system-ui";
        ctx.fillStyle = SHARED_COLOR;
        const sharedText = `◆ SHARED (${depCount} dependents)`;
        const sharedWidth = ctx.measureText(sharedText).width;
        ctx.fillText(sharedText, canvas.width - sharedWidth - 20, 34);
      } else {
        // Participant count
        ctx.font = "14px system-ui";
        ctx.fillStyle = DIM_TEXT;
        const agentText = `${topic.participantCount} agent${topic.participantCount !== 1 ? "s" : ""}`;
        const agentWidth = ctx.measureText(agentText).width;
        ctx.fillText(agentText, canvas.width - agentWidth - 20, 34);
      }

      // Title
      ctx.font = "500 22px system-ui";
      ctx.fillStyle = TEXT_COLOR;
      let title = topic.title;
      // Truncate if too long
      while (ctx.measureText(title).width > canvas.width - 80 && title.length > 3) {
        title = title.slice(0, -4) + "...";
      }
      ctx.fillText(title, 24, 76);

      // Collapse indicator
      if (hasChildren) {
        const collapsed = collapsedSetRef.current.has(topic.id);
        ctx.font = "bold 24px system-ui";
        ctx.fillStyle = tierColor;
        ctx.globalAlpha = 0.7;
        ctx.fillText(collapsed ? "▶" : "▼", canvas.width - 40, 76);
        ctx.globalAlpha = 1;
      }

      // Verified glow effect
      if (isVerified) {
        ctx.shadowColor = tierColor;
        ctx.shadowBlur = 20;
        ctx.strokeStyle = tierColor;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.3;
        ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 10);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      const cardMat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 1,
      });

      const mesh = new THREE.Mesh(cardGeo, cardMat);
      mesh.position.set(
        node.x + NODE_WIDTH / 2,
        -(node.y + NODE_HEIGHT / 2),
        0
      );
      mesh.userData = { topicId: topic.id, node };
      scene.add(mesh);
      nodeMeshMapRef.current.set(topic.id, mesh);
    }

    // Update camera to fit content
    const centerX = maxX / 2;
    const centerY = -maxY / 2;
    camera.position.set(centerX + panRef.current.x, centerY + panRef.current.y, 1000);
    camera.lookAt(centerX + panRef.current.x, centerY + panRef.current.y, 0);

    const aspect = dimensions.width / dimensions.height;
    const frustumHeight = (maxY + PADDING * 2) / zoomRef.current;
    const frustumWidth = frustumHeight * aspect;
    camera.left = -frustumWidth / 2;
    camera.right = frustumWidth / 2;
    camera.top = frustumHeight / 2;
    camera.bottom = -frustumHeight / 2;
    camera.updateProjectionMatrix();
  }, [dimensions]);

  // Initialize Three.js
  useEffect(() => {
    if (!canvasRef.current) return;

    let cleanup = false;

    import("three").then((THREE) => {
      if (cleanup) return;
      threeRef.current = THREE;

      const renderer = new THREE.WebGLRenderer({
        canvas: canvasRef.current!,
        antialias: true,
        alpha: false,
      });
      renderer.setSize(dimensions.width, dimensions.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(BG_COLOR);
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const camera = new THREE.OrthographicCamera(
        -dimensions.width / 2, dimensions.width / 2,
        dimensions.height / 2, -dimensions.height / 2,
        0.1, 2000
      );
      camera.position.set(0, 0, 1000);
      cameraRef.current = camera;

      const raycaster = new THREE.Raycaster();
      raycasterRef.current = raycaster;

      // Render loop
      function animate() {
        if (cleanup) return;
        animFrameRef.current = requestAnimationFrame(animate);
        renderer.render(scene, camera);
      }
      animate();

      // Fetch data and build tree
      fetch("/api/hub/graph")
        .then(res => res.json())
        .then(data => {
          if (cleanup) return;
          const trees = buildTree(data.topics, data.dependencies ?? []);
          treeDataRef.current = trees;
          const flat = layoutTree(trees);
          flatNodesRef.current = flat;
          updateScene();
          setLoading(false);
        })
        .catch(err => {
          setError(err.message);
          setLoading(false);
        });
    });

    return () => {
      cleanup = true;
      cancelAnimationFrame(animFrameRef.current);
      rendererRef.current?.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update renderer on resize
  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.setSize(dimensions.width, dimensions.height);
      updateScene();
    }
  }, [dimensions, updateScene]);

  // Mouse handlers for pan, zoom, click
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    zoomRef.current = Math.max(0.2, Math.min(5, zoomRef.current * delta));
    updateScene();
  }, [updateScene]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) { // Left click
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        startPanX: panRef.current.x,
        startPanY: panRef.current.y,
      };
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Update mouse for raycasting
    mouseRef.current = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };

    if (dragRef.current.active) {
      const dx = (e.clientX - dragRef.current.startX) / zoomRef.current;
      const dy = -(e.clientY - dragRef.current.startY) / zoomRef.current;
      panRef.current = {
        x: dragRef.current.startPanX + dx,
        y: dragRef.current.startPanY + dy,
      };
      updateScene();
    } else {
      // Raycasting for hover
      const THREE = threeRef.current;
      const raycaster = raycasterRef.current;
      const camera = cameraRef.current;
      if (!THREE || !raycaster || !camera) return;

      raycaster.setFromCamera(
        new THREE.Vector2(mouseRef.current.x, mouseRef.current.y),
        camera
      );

      const meshes = Array.from(nodeMeshMapRef.current.values());
      const intersects = raycaster.intersectObjects(meshes);
      if (intersects.length > 0) {
        const topicId = intersects[0].object.userData.topicId;
        setHovered(topicId);
        if (canvasRef.current) canvasRef.current.style.cursor = "pointer";
      } else {
        setHovered(null);
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      }
    }
  }, [updateScene]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const wasDrag = dragRef.current.active &&
      (Math.abs(e.clientX - dragRef.current.startX) > 5 ||
       Math.abs(e.clientY - dragRef.current.startY) > 5);

    dragRef.current.active = false;

    if (wasDrag) return; // Don't trigger click on drag

    // Check for click on node
    const THREE = threeRef.current;
    const raycaster = raycasterRef.current;
    const camera = cameraRef.current;
    if (!THREE || !raycaster || !camera) return;

    raycaster.setFromCamera(
      new THREE.Vector2(mouseRef.current.x, mouseRef.current.y),
      camera
    );

    const meshes = Array.from(nodeMeshMapRef.current.values());
    const intersects = raycaster.intersectObjects(meshes);
    if (intersects.length > 0) {
      const topicId = intersects[0].object.userData.topicId;
      const node = intersects[0].object.userData.node as TreeNode;

      // Check if click is on the collapse toggle area (right side)
      const hasChildren = node.children.length > 0 || collapsedSetRef.current.has(topicId);
      if (hasChildren) {
        // Toggle collapse
        if (collapsedSetRef.current.has(topicId)) {
          collapsedSetRef.current.delete(topicId);
        } else {
          collapsedSetRef.current.add(topicId);
        }

        // Rebuild and re-render
        fetch("/api/hub/graph")
          .then(res => res.json())
          .then(data => {
            const trees = buildTree(data.topics, data.dependencies ?? []);
            treeDataRef.current = trees;
            const flat = layoutTree(trees);
            flatNodesRef.current = flat;
            updateScene();
          });
      } else {
        // Navigate to topic
        router.push(`/topics/${topicId}`);
      }
    }
  }, [router, buildTree, layoutTree, updateScene]);

  // Handle double-click to navigate
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const THREE = threeRef.current;
    const raycaster = raycasterRef.current;
    const camera = cameraRef.current;
    if (!THREE || !raycaster || !camera) return;

    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );

    raycaster.setFromCamera(mouse, camera);
    const meshes = Array.from(nodeMeshMapRef.current.values());
    const intersects = raycaster.intersectObjects(meshes);
    if (intersects.length > 0) {
      const topicId = intersects[0].object.userData.topicId;
      router.push(`/topics/${topicId}`);
    }
  }, [router]);

  // Computed stats
  const stats = useMemo(() => {
    const flat = flatNodesRef.current;
    const maxDepth = flat.reduce((max, n) => Math.max(max, n.depth), 0);
    return {
      topics: flat.length,
      maxDepth,
      roots: treeDataRef.current.length,
    };
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative rounded-lg overflow-hidden border border-card-border">
      {/* Canvas is always rendered so the useEffect can initialise Three.js */}
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{ width: dimensions.width, height: dimensions.height, cursor: loading ? "default" : "grab", display: loading || error ? "none" : "block" }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />

      {/* Loading / error overlays */}
      {loading && (
        <div className="flex items-center justify-center h-[600px] bg-[#07070d]">
          <div className="text-pact-cyan animate-pulse text-lg">Building dependency tree...</div>
        </div>
      )}
      {error && !loading && (
        <div className="flex items-center justify-center h-[600px] bg-[#07070d]">
          <div className="text-red-400 text-lg">{error}</div>
        </div>
      )}

      {/* Legend overlay */}
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between text-xs text-white/50 gap-y-2 pointer-events-none">
        <div className="flex items-center gap-3 flex-wrap">
          {["axiom", "empirical", "institutional", "interpretive", "conjecture"].map((tier) => (
            <span key={tier} className="flex items-center gap-1 capitalize">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
              <span style={{ color: TIER_COLORS[tier] }}>{tier}</span>
            </span>
          ))}
          <span className="text-white/20">|</span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: SHARED_COLOR }} />
            <span style={{ color: SHARED_COLOR }}>shared</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: KEYSTONE_COLOR }} />
            <span style={{ color: KEYSTONE_COLOR }}>keystone</span>
          </span>
          <span className="text-white/20">|</span>
          <span>{stats.topics} topics</span>
          <span className="text-white/20">|</span>
          <span>{stats.maxDepth + 1} levels deep</span>
        </div>
        <div className="text-white/30">
          Click to expand/collapse · Double-click to open · Scroll to zoom · Drag to pan
        </div>
      </div>

      {/* Hover tooltip */}
      {hovered && (
        <div className="absolute top-3 right-3 bg-[#1a1a2e] border border-card-border rounded-lg px-4 py-3 text-sm text-white/80 max-w-xs pointer-events-none">
          {flatNodesRef.current.find(n => n.topic.id === hovered)?.topic.title}
        </div>
      )}
    </div>
  );
}
