#!/usr/bin/env node
// Validates every YAML record under intelligence/data/ against its schema, then runs
// cross-registry referential integrity and entity-resolution sanity. CI-facing:
// exits non-zero on any problem. Run from anywhere: paths resolve relative to this file.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadRegistry, checkIntegrity, gridEntitiesFrom, findResolutionCandidates } from "@pact-tailor/registry";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "..", "..", "data");

const { data, errors } = loadRegistry(dataDir);
const integrity = checkIntegrity(data);
const candidates = findResolutionCandidates([...data.entities, ...gridEntitiesFrom(data.grids)]).filter(
  // Shared-external-ID hits in curated data are duplicate bugs; heuristic name hits are review items.
  (c) => c.score === 1,
);

const counts = {
  grids: data.grids.length,
  sources: data.sources.length,
  gaps: data.gaps.length,
  entities: data.entities.length,
  relationships: data.relationships.length,
};
console.log(`registry: ${JSON.stringify(counts)}`);

let failed = false;
if (errors.length > 0) {
  failed = true;
  console.error(`\nSchema validation errors (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
}
if (integrity.length > 0) {
  failed = true;
  console.error(`\nReferential integrity errors (${integrity.length}):`);
  for (const e of integrity) console.error(`  - ${e}`);
}
if (candidates.length > 0) {
  failed = true;
  console.error(`\nDuplicate-entity candidates via shared external IDs (${candidates.length}):`);
  for (const c of candidates) console.error(`  - ${c.a} ~ ${c.b} (${c.reason})`);
}

if (failed) {
  console.error("\nvalidate:data FAILED");
  process.exit(1);
}
console.log("validate:data OK");
