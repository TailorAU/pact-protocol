// @pact-tailor/graph — in-process bitemporal property graph over the structural world
// model. Nodes are canonical entities (never mutated by telemetry); edges carry the full
// relationship envelope with two time axes. Runtime changes enter only via applyDelta,
// which the caller journals through @pact-tailor/store's hash-chained gold log first —
// the journal is truth, this structure is the projection.
import type { EntityRecord, RelationshipRecord, RelType } from "@pact-tailor/ontology";

export interface TemporalFilter {
  /** World-time: the edge must be valid at this instant (default: now). */
  asOf?: string;
  /** System-time: only edges we believed at this instant (default: latest). */
  recordedAsOf?: string;
}

export interface NeighborOptions extends TemporalFilter {
  relTypes?: RelType[];
  direction?: "out" | "in" | "both";
}

export interface TraverseOptions extends TemporalFilter {
  start: string;
  direction: "upstream" | "downstream";
  relTypes?: RelType[];
  maxDepth?: number;
}

export interface PathStep {
  rel: RelationshipRecord;
  from: string;
  to: string;
}

export interface Path {
  nodes: string[];
  steps: PathStep[];
}

function activeAt(rel: RelationshipRecord, filter: TemporalFilter): boolean {
  const asOf = filter.asOf ?? new Date().toISOString();
  if (rel.valid_from != null && rel.valid_from > asOf) return false;
  if (rel.valid_to != null && rel.valid_to <= asOf) return false;
  if (filter.recordedAsOf !== undefined) {
    if (rel.recorded_at != null && rel.recorded_at > filter.recordedAsOf) return false;
    if (rel.superseded_at != null && rel.superseded_at <= filter.recordedAsOf) return false;
  } else if (rel.superseded_at != null) {
    return false;
  }
  return true;
}

export class KnowledgeGraph {
  private nodes = new Map<string, EntityRecord>();
  private edges = new Map<string, RelationshipRecord>();
  private out = new Map<string, RelationshipRecord[]>();
  private in = new Map<string, RelationshipRecord[]>();

  load(entities: EntityRecord[], relationships: RelationshipRecord[]): void {
    for (const entity of entities) this.nodes.set(entity.entity_id, entity);
    for (const rel of relationships) this.indexEdge(rel);
  }

  private indexEdge(rel: RelationshipRecord): void {
    this.edges.set(rel.rel_id, rel);
    let outList = this.out.get(rel.from_id);
    if (!outList) this.out.set(rel.from_id, (outList = []));
    outList.push(rel);
    let inList = this.in.get(rel.to_id);
    if (!inList) this.in.set(rel.to_id, (inList = []));
    inList.push(rel);
  }

  /**
   * Apply a runtime patch. The caller MUST have journaled it (GoldStore.appendGraphDelta)
   * before calling — this method only projects.
   */
  applyDelta(delta:
    | { kind: "entity_patch"; entity: EntityRecord }
    | { kind: "relationship_patch"; relationship: RelationshipRecord }): void {
    if (delta.kind === "entity_patch") {
      this.nodes.set(delta.entity.entity_id, delta.entity);
      return;
    }
    const rel = delta.relationship;
    const existing = this.edges.get(rel.rel_id);
    if (existing) {
      // Re-recording an edge supersedes the old version rather than replacing history.
      const closed: RelationshipRecord = { ...existing, superseded_at: rel.recorded_at ?? new Date().toISOString() };
      this.edges.set(existing.rel_id, closed);
      const replaceIn = (list: RelationshipRecord[] | undefined) => {
        if (!list) return;
        const idx = list.indexOf(existing);
        if (idx >= 0) list[idx] = closed;
      };
      replaceIn(this.out.get(existing.from_id));
      replaceIn(this.in.get(existing.to_id));
      this.indexEdge({ ...rel, rel_id: `${rel.rel_id}-r${Date.now()}` });
      return;
    }
    this.indexEdge(rel);
  }

  node(id: string): EntityRecord | null {
    return this.nodes.get(id) ?? null;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  allNodes(): EntityRecord[] {
    return [...this.nodes.values()];
  }

  neighbors(id: string, options: NeighborOptions = {}): PathStep[] {
    const direction = options.direction ?? "both";
    const steps: PathStep[] = [];
    const want = options.relTypes ? new Set(options.relTypes) : null;
    if (direction !== "in") {
      for (const rel of this.out.get(id) ?? []) {
        if (want && !want.has(rel.rel_type)) continue;
        if (!activeAt(rel, options)) continue;
        steps.push({ rel, from: id, to: rel.to_id });
      }
    }
    if (direction !== "out") {
      for (const rel of this.in.get(id) ?? []) {
        if (want && !want.has(rel.rel_type)) continue;
        if (!activeAt(rel, options)) continue;
        steps.push({ rel, from: rel.from_id, to: id });
      }
    }
    return steps;
  }

  /**
   * Breadth-first supply-chain walk. "downstream" follows edges in their natural
   * direction (mine SUPPLIES station, smelter SHIPS_TO market...); "upstream" walks
   * them in reverse (what feeds this entity?).
   */
  traverse(options: TraverseOptions): Path[] {
    const maxDepth = options.maxDepth ?? 4;
    const paths: Path[] = [];
    const queue: Path[] = [{ nodes: [options.start], steps: [] }];
    const visited = new Set<string>([options.start]);

    while (queue.length > 0) {
      const path = queue.shift() as Path;
      if (path.steps.length >= maxDepth) continue;
      const tip = path.nodes[path.nodes.length - 1] as string;
      const direction = options.direction === "downstream" ? "out" : "in";
      const steps = this.neighbors(tip, {
        direction,
        ...(options.relTypes !== undefined ? { relTypes: options.relTypes } : {}),
        ...(options.asOf !== undefined ? { asOf: options.asOf } : {}),
        ...(options.recordedAsOf !== undefined ? { recordedAsOf: options.recordedAsOf } : {}),
      });
      for (const step of steps) {
        const next = options.direction === "downstream" ? step.to : step.from;
        if (visited.has(next)) continue;
        visited.add(next);
        const extended: Path = { nodes: [...path.nodes, next], steps: [...path.steps, step] };
        paths.push(extended);
        queue.push(extended);
      }
    }
    return paths;
  }

  /**
   * Follow an explicit relationship-type chain from a start node, e.g.
   * chain("mine:au-qld:blackwater", ["TRANSPORTS", "PART_OF"]) — returns every path
   * that matches the chain exactly, in order.
   */
  chain(start: string, relTypes: RelType[], filter: TemporalFilter = {}): Path[] {
    let frontier: Path[] = [{ nodes: [start], steps: [] }];
    for (const relType of relTypes) {
      const next: Path[] = [];
      for (const path of frontier) {
        const tip = path.nodes[path.nodes.length - 1] as string;
        for (const step of this.neighbors(tip, { direction: "out", relTypes: [relType], ...filter })) {
          next.push({ nodes: [...path.nodes, step.to], steps: [...path.steps, step] });
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return frontier;
  }

  /** Deterministic export for tests and the globe's static bundle. */
  export(): { entities: EntityRecord[]; relationships: RelationshipRecord[] } {
    const entities = [...this.nodes.values()].sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    const relationships = [...this.edges.values()].sort((a, b) => a.rel_id.localeCompare(b.rel_id));
    return { entities, relationships };
  }
}
