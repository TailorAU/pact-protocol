// @pact-tailor/registry — loads the YAML registries (class-A structural truth) and
// enforces referential integrity across them. The registries on disk are the source
// of truth; this package never mutates them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  createValidators,
  type EntityRecord,
  type GridRecord,
  type ObservabilityGapRecord,
  type RelationshipRecord,
  type SourceRecord,
  type Validators,
} from "@pact-tailor/ontology";

export { findResolutionCandidates, type ResolutionCandidate } from "./resolve.js";

export interface RegistryData {
  grids: GridRecord[];
  sources: SourceRecord[];
  gaps: ObservabilityGapRecord[];
  entities: EntityRecord[];
  relationships: RelationshipRecord[];
}

export interface LoadResult {
  data: RegistryData;
  /** Validation errors, each prefixed with the offending file path. */
  errors: string[];
}

function yamlFilesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names.sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...yamlFilesUnder(full));
    else if (name.endsWith(".yaml") || name.endsWith(".yml")) files.push(full);
  }
  return files;
}

function readRecords(file: string, errors: string[]): unknown[] {
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: YAML parse error — ${(err as Error).message}`);
    return [];
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray((doc as { records?: unknown }).records)) {
    errors.push(`${file}: expected a top-level \`records:\` array`);
    return [];
  }
  return (doc as { records: unknown[] }).records;
}

function loadKind<T>(
  dir: string,
  validate: (data: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  label: string,
  errors: string[],
): T[] {
  const out: T[] = [];
  for (const file of yamlFilesUnder(dir)) {
    const records = readRecords(file, errors);
    records.forEach((record, i) => {
      const result = validate(record);
      if (result.ok) out.push(result.value);
      else errors.push(`${file} ${label}[${i}]: ${result.errors.join("; ")}`);
    });
  }
  return out;
}

/**
 * Load every registry under `dataDir` (normally `intelligence/data`), validating each
 * record against its schema. Schema-invalid records are excluded from the result and
 * reported in `errors`.
 */
export function loadRegistry(dataDir: string, validators: Validators = createValidators()): LoadResult {
  const errors: string[] = [];
  const data: RegistryData = {
    grids: loadKind(join(dataDir, "registries", "grids"), validators.grid, "grid", errors),
    sources: loadKind(join(dataDir, "registries", "sources"), validators.source, "source", errors),
    gaps: loadKind(join(dataDir, "registries", "gaps"), validators.gap, "gap", errors),
    entities: loadKind(join(dataDir, "entities"), validators.entity, "entity", errors),
    relationships: loadKind(join(dataDir, "relationships"), validators.relationship, "relationship", errors),
  };
  return { data, errors };
}

const AVAILABILITY_TO_OBSERVABILITY: Record<string, EntityRecord["observability"]> = {
  rich: "KNOWN_LIVE",
  partial: "ESTIMATED",
  minimal: "ESTIMATED",
  none: "NOT_OBSERVABLE",
};

/** Materialise Grid entities from grid registry records so grids are graph-addressable. */
export function gridEntitiesFrom(grids: GridRecord[]): EntityRecord[] {
  return grids.map((grid) => ({
    entity_id: grid.grid_id,
    entity_type: "Grid",
    name: grid.name,
    data_class: "structural",
    observability: AVAILABILITY_TO_OBSERVABILITY[grid.live_data.availability] ?? "UNCLASSIFIED",
    geometry: null,
    country: grid.countries[0] ?? null,
    grid_id: grid.parent_grid ?? null,
    properties: { kind: grid.kind, frequency_hz: grid.frequency_hz },
    external_ids: {},
    sources: grid.sources,
    ...(grid.notes !== undefined ? { notes: grid.notes } : {}),
  }));
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  return [...dups];
}

/**
 * Cross-registry referential integrity. Every ID mentioned anywhere must resolve:
 * source citations, gap targets, relationship endpoints, grid parents, same_as.
 */
export function checkIntegrity(data: RegistryData): string[] {
  const problems: string[] = [];
  const sourceIds = new Set(data.sources.map((s) => s.source_id));
  const gridIds = new Set(data.grids.map((g) => g.grid_id));
  const entityIds = new Set(data.entities.map((e) => e.entity_id));
  const nodeIds = new Set([...entityIds, ...gridIds]);

  for (const dup of duplicates(data.sources.map((s) => s.source_id))) problems.push(`duplicate source_id ${dup}`);
  for (const dup of duplicates(data.grids.map((g) => g.grid_id))) problems.push(`duplicate grid_id ${dup}`);
  for (const dup of duplicates(data.entities.map((e) => e.entity_id))) problems.push(`duplicate entity_id ${dup}`);
  for (const dup of duplicates(data.gaps.map((g) => g.gap_id))) problems.push(`duplicate gap_id ${dup}`);
  for (const dup of duplicates(data.relationships.map((r) => r.rel_id))) problems.push(`duplicate rel_id ${dup}`);

  const requireSource = (id: string, where: string) => {
    if (!sourceIds.has(id)) problems.push(`${where}: unknown source ${id}`);
  };
  const requireNode = (id: string, where: string) => {
    if (!nodeIds.has(id)) problems.push(`${where}: unknown entity/grid ${id}`);
  };

  for (const grid of data.grids) {
    for (const id of grid.sources) requireSource(id, grid.grid_id);
    for (const id of grid.live_data.source_ids ?? []) requireSource(id, `${grid.grid_id}.live_data`);
    if (grid.parent_grid && !gridIds.has(grid.parent_grid)) {
      problems.push(`${grid.grid_id}: unknown parent_grid ${grid.parent_grid}`);
    }
  }
  for (const entity of data.entities) {
    for (const id of entity.sources) requireSource(id, entity.entity_id);
    if (entity.grid_id && !nodeIds.has(entity.grid_id)) {
      problems.push(`${entity.entity_id}: unknown grid_id ${entity.grid_id}`);
    }
    if (entity.same_as && !nodeIds.has(entity.same_as)) {
      problems.push(`${entity.entity_id}: unknown same_as ${entity.same_as}`);
    }
  }
  for (const gap of data.gaps) {
    requireNode(gap.entity_id, gap.gap_id);
    if (gap.current_source) requireSource(gap.current_source, gap.gap_id);
    if (gap.best_available_proxy) requireSource(gap.best_available_proxy.source_id, `${gap.gap_id}.proxy`);
  }
  for (const rel of data.relationships) {
    requireNode(rel.from_id, rel.rel_id);
    requireNode(rel.to_id, rel.rel_id);
    requireSource(rel.source, rel.rel_id);
  }
  return problems;
}
