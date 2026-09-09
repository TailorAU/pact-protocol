// Zero-dependency node:http REST + SSE server in the reference-server style:
// router on path segments, sendJson, 404 JSON envelope. Every entity-bearing
// response is tagged with data_class provenance so structural vs telemetry vs
// derived is always distinguishable.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CurrentMetricState } from "@pact-tailor/state";
import type { EntityRecord, RelType } from "@pact-tailor/ontology";
import type { Path } from "@pact-tailor/graph";
import type { IntelApp } from "./app.js";
import { composePanelDoc } from "./sdui/composer.js";

// ─── helpers ──────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { error: "bad_request", message });
}

function numericState(app: IntelApp, entityId: string, metric: string): CurrentMetricState | null {
  const state = app.state.current(entityId, metric)[0];
  return state !== undefined && typeof state.value === "number" ? state : null;
}

function csvSet(value: string | null): Set<string> | null {
  if (value === null || value.trim() === "") return null;
  const items = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? new Set(items) : null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim()) return null;
  return Math.min(max, Math.max(min, n));
}

// ─── handlers ─────────────────────────────────────────────────────────────

function handleGridSummary(app: IntelApp, gridId: string, res: ServerResponse): void {
  const grid = app.registry.grids.find((g) => g.grid_id === gridId);
  if (!grid) return notFound(res);

  const regionNodes = app.graph
    .allNodes()
    .filter((n) => n.entity_type === "GridRegion" && n.grid_id === gridId)
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id));

  const demandStates = regionNodes
    .map((r) => numericState(app, r.entity_id, "grid.demand.mw"))
    .filter((s): s is CurrentMetricState => s !== null);
  const generationStates = regionNodes
    .map((r) => numericState(app, r.entity_id, "grid.generation.mw"))
    .filter((s): s is CurrentMetricState => s !== null);
  const priceStates = regionNodes
    .map((r) => numericState(app, r.entity_id, "market.price.energy"))
    .filter((s): s is CurrentMetricState => s !== null);

  const demand_mw =
    demandStates.length === 0
      ? null
      : {
          value: demandStates.reduce((a, s) => a + (s.value as number), 0),
          event_time: demandStates.map((s) => s.event_time).sort().at(-1) as string,
        };
  const generation_mw =
    generationStates.length === 0
      ? null
      : { value: generationStates.reduce((a, s) => a + (s.value as number), 0) };
  // Price is not aggregated across regions — only reported when unambiguous
  // (exactly one region has a live price). Per-region prices sit in regions_live.
  const priceState = priceStates.length === 1 ? (priceStates[0] as CurrentMetricState) : null;
  const price = priceState === null ? null : { value: priceState.value, event_time: priceState.event_time };

  const flows = app.graph
    .allNodes()
    .filter((n) => n.entity_type === "Interconnector" && n.grid_id === gridId)
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
    .flatMap((icon) => {
      const state = numericState(app, icon.entity_id, "intercon.flow.mw");
      if (state === null) return [];
      return [{ entity_id: icon.entity_id, name: icon.name, mw: state.value, event_time: state.event_time }];
    });

  const regions_live = regionNodes.map((r) => ({
    entity_id: r.entity_id,
    demand_mw: numericState(app, r.entity_id, "grid.demand.mw")?.value ?? null,
    price: numericState(app, r.entity_id, "market.price.energy")?.value ?? null,
    generation_mw: numericState(app, r.entity_id, "grid.generation.mw")?.value ?? null,
  }));

  sendJson(res, 200, {
    grid,
    regions: regionNodes.map((r) => ({ entity_id: r.entity_id, name: r.name })),
    live: { demand_mw, price, generation_mw, flows },
    regions_live,
    data_class: { grid: "structural", regions: "structural", live: "telemetry", regions_live: "telemetry" },
  });
}

function handleEntities(app: IntelApp, query: URLSearchParams, res: ServerResponse): void {
  let entities = app.graph.allNodes();

  const type = query.get("type");
  if (type !== null && type !== "") entities = entities.filter((e) => e.entity_type === type);

  const grid = query.get("grid");
  if (grid !== null && grid !== "") entities = entities.filter((e) => e.grid_id === grid);

  const observability = query.get("observability");
  if (observability !== null && observability !== "") {
    entities = entities.filter((e) => e.observability === observability);
  }

  const q = query.get("q");
  if (q !== null && q !== "") {
    const needle = q.toLowerCase();
    entities = entities.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        (e.aliases ?? []).some((a) => a.toLowerCase().includes(needle)),
    );
  }

  const bbox = query.get("bbox");
  if (bbox !== null && bbox !== "") {
    const parts = bbox.split(",").map((p) => Number.parseFloat(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return badRequest(res, "bbox must be minLon,minLat,maxLon,maxLat");
    }
    const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
    entities = entities.filter((e) => {
      if (!e.geometry || e.geometry.type !== "Point") return false;
      const lon = e.geometry.coordinates[0];
      const lat = e.geometry.coordinates[1];
      if (typeof lon !== "number" || typeof lat !== "number") return false;
      return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    });
  }

  entities = [...entities].sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  sendJson(res, 200, { entities, data_class: "structural" });
}

function handleEntityDetail(app: IntelApp, id: string, res: ServerResponse): void {
  const entity = app.graph.node(id);
  if (!entity) return notFound(res);
  const sources = entity.sources.map(
    (sid) => app.registry.sources.find((s) => s.source_id === sid) ?? sid,
  );
  sendJson(res, 200, {
    entity,
    provenance: { data_class: "structural", sources },
    state: app.state.current(id),
    gaps: app.registry.gaps.filter((g) => g.entity_id === id),
    inference_count: app.intel.byEntity(id).length,
    data_class: { entity: "structural", state: "telemetry", gaps: "structural", inferences: "derived" },
  });
}

function handleEntityGraph(app: IntelApp, id: string, query: URLSearchParams, res: ServerResponse): void {
  if (!app.graph.node(id)) return notFound(res);
  const direction = query.get("direction") ?? "both";
  if (direction !== "upstream" && direction !== "downstream" && direction !== "both") {
    return badRequest(res, "direction must be upstream|downstream|both");
  }
  const depth = clampInt(query.get("depth"), 2, 1, 5);
  if (depth === null) return badRequest(res, "depth must be an integer");
  const relsParam = csvSet(query.get("rels"));
  const relTypes = relsParam !== null ? ([...relsParam] as RelType[]) : undefined;

  const directions: Array<"upstream" | "downstream"> =
    direction === "both" ? ["upstream", "downstream"] : [direction];
  const paths: Path[] = [];
  for (const dir of directions) {
    paths.push(
      ...app.graph.traverse({
        start: id,
        direction: dir,
        maxDepth: depth,
        ...(relTypes !== undefined ? { relTypes } : {}),
      }),
    );
  }

  const nodeIds = new Set<string>([id]);
  for (const path of paths) for (const nodeId of path.nodes) nodeIds.add(nodeId);
  const nodes = [...nodeIds]
    .sort()
    .map((nid) => app.graph.node(nid))
    .filter((n): n is EntityRecord => n !== null);

  sendJson(res, 200, { paths, nodes, data_class: "structural" });
}

function handleGraphPath(app: IntelApp, query: URLSearchParams, res: ServerResponse): void {
  const from = query.get("from");
  const to = query.get("to");
  if (!from || !to) return badRequest(res, "from and to are required");
  if (!app.graph.node(from)) return notFound(res);
  const maxDepth = clampInt(query.get("maxDepth"), 4, 1, 6);
  if (maxDepth === null) return badRequest(res, "maxDepth must be an integer");
  const paths = app.graph
    .traverse({ start: from, direction: "downstream", maxDepth })
    .filter((p) => p.nodes[p.nodes.length - 1] === to);
  sendJson(res, 200, { from, to, paths, data_class: "structural" });
}

function handleSdui(app: IntelApp, id: string, res: ServerResponse): void {
  const entity = app.graph.node(id);
  if (!entity) return notFound(res);
  const doc = composePanelDoc({
    entity,
    states: app.state.current(id),
    gaps: app.registry.gaps.filter((g) => g.entity_id === id),
    inferences: app.intel.byEntity(id),
  });
  // Fail loud: a composed document that violates the SDUI schema is a bug.
  const result = app.validators.sduiPanel(doc);
  if (!result.ok) {
    sendJson(res, 500, { error: "sdui_invalid", details: result.errors });
    return;
  }
  sendJson(res, 200, doc);
}

function metaBody(app: IntelApp): Record<string, unknown> {
  return {
    counts: {
      entities: app.graph.nodeCount(),
      relationships: app.graph.edgeCount(),
      sources: app.registry.sources.length,
      gaps: app.registry.gaps.length,
      grids: app.registry.grids.length,
      inferences: app.intel.all().length,
    },
    replay: app.replay,
    generated_at: new Date().toISOString(),
  };
}

function handleStream(app: IntelApp, query: URLSearchParams, res: ServerResponse): void {
  app.sse.subscribe(
    res,
    { entities: csvSet(query.get("entities")), metrics: csvSet(query.get("metrics")) },
    { service: "pact-tailor-intel-api", ...metaBody(app) },
  );
}

// ─── router ───────────────────────────────────────────────────────────────

export function route(app: IntelApp, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const query = url.searchParams;
  const method = req.method ?? "GET";

  if (method !== "GET") return notFound(res);

  if (segs.length === 1 && segs[0] === "healthz") {
    return sendJson(res, 200, { status: "ok", service: "pact-tailor-intel-api" });
  }

  if (segs[0] !== "api" || segs[1] !== "intel") return notFound(res);
  const rest = segs.slice(2);
  const [head, id, sub] = rest;

  if (head === "grids") {
    if (rest.length === 1) return sendJson(res, 200, { grids: app.registry.grids, data_class: "structural" });
    if (rest.length === 3 && sub === "summary" && id !== undefined) return handleGridSummary(app, id, res);
    return notFound(res);
  }

  if (head === "entities") {
    if (rest.length === 1) return handleEntities(app, query, res);
    if (id === undefined) return notFound(res);
    if (rest.length === 2) return handleEntityDetail(app, id, res);
    if (rest.length === 3 && sub === "state") {
      if (!app.graph.node(id)) return notFound(res);
      return sendJson(res, 200, { entity_id: id, states: app.state.current(id), data_class: "telemetry" });
    }
    if (rest.length === 3 && sub === "observations") {
      if (!app.graph.node(id)) return notFound(res);
      const metric = query.get("metric");
      if (metric === null || metric === "") return badRequest(res, "metric query parameter is required");
      const from = query.get("from");
      const to = query.get("to");
      const observations = app.state.history(id, metric, {
        ...(from !== null && from !== "" ? { from } : {}),
        ...(to !== null && to !== "" ? { to } : {}),
      });
      return sendJson(res, 200, { entity_id: id, metric, observations, data_class: "telemetry" });
    }
    if (rest.length === 3 && sub === "graph") return handleEntityGraph(app, id, query, res);
    return notFound(res);
  }

  if (head === "graph" && rest.length === 2 && id === "path") return handleGraphPath(app, query, res);

  if (head === "sources") {
    if (rest.length === 1) return sendJson(res, 200, { sources: app.registry.sources, data_class: "structural" });
    if (rest.length === 2 && id !== undefined) {
      const source = app.registry.sources.find((s) => s.source_id === id);
      return source ? sendJson(res, 200, { source, data_class: "structural" }) : notFound(res);
    }
    return notFound(res);
  }

  if (head === "gaps" && rest.length === 1) {
    let gaps = app.registry.gaps;
    const entity = query.get("entity");
    if (entity !== null && entity !== "") gaps = gaps.filter((g) => g.entity_id === entity);
    const priority = query.get("priority");
    if (priority !== null && priority !== "") gaps = gaps.filter((g) => g.priority === priority);
    const status = query.get("status");
    if (status !== null && status !== "") gaps = gaps.filter((g) => g.status === status);
    return sendJson(res, 200, { gaps, data_class: "structural" });
  }

  if (head === "inferences") {
    if (rest.length === 1) {
      const entity = query.get("entity");
      let inferences = entity !== null && entity !== "" ? app.intel.byEntity(entity) : app.intel.all();
      const status = query.get("status");
      if (status !== null && status !== "") inferences = inferences.filter((i) => i.status === status);
      return sendJson(res, 200, { inferences, data_class: "derived" });
    }
    if (rest.length === 2 && id !== undefined) {
      const inference = app.intel.byId(id);
      return inference ? sendJson(res, 200, { inference, data_class: "derived" }) : notFound(res);
    }
    return notFound(res);
  }

  if (head === "sdui" && rest.length === 2 && id !== undefined) return handleSdui(app, id, res);

  if (head === "meta" && rest.length === 1) return sendJson(res, 200, metaBody(app));

  if (head === "stream" && rest.length === 1) return handleStream(app, query, res);

  return notFound(res);
}

// ─── bootstrap ────────────────────────────────────────────────────────────

/**
 * Start the HTTP server on 127.0.0.1:port (0 = ephemeral). Prints
 * `listening on http://127.0.0.1:{port}` once bound, and starts the replay
 * ticker when the app was built in replay mode. Closing the server closes
 * the app (ticker, subscriptions, SSE streams).
 */
export function startServer(app: IntelApp, port: number): Server {
  const server = createServer((req, res) => {
    try {
      route(app, req, res);
    } catch (err) {
      sendJson(res, 500, { error: "internal", message: (err as Error).message });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const actual = addr !== null && typeof addr === "object" ? addr.port : port;
    console.log(`listening on http://127.0.0.1:${actual}`);
    if (app.replay) app.startReplayTicker();
  });
  server.on("close", () => app.close());
  return server;
}
