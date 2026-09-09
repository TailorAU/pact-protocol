// Shared test scaffolding. Tests use INLINE entity records (not the data/
// lane, which a concurrent agent owns) so they are hermetic and exact.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EntityIndex, ReplayGate, ReplayMessageGate } from "../dist/index.js";

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const fixturesDir = (connectorId) => join(PKG_ROOT, "fixtures", connectorId);

export const entity = (entity_id, entity_type, external_ids = {}, properties = {}) => ({
  entity_id,
  entity_type,
  name: entity_id,
  data_class: "structural",
  observability: "KNOWN_LIVE",
  sources: ["source:test:seed"],
  external_ids,
  properties,
});

export const FIXED_NOW = "2026-08-12T01:10:00Z";

export const testCtx = (connectorId, entities, now = FIXED_NOW) => {
  const dir = fixturesDir(connectorId);
  return {
    gate: new ReplayGate(dir),
    messageGate: new ReplayMessageGate(join(dir, "messages.jsonl")),
    now: () => now,
    entityIndex: new EntityIndex(entities),
    log: () => {},
  };
};

/** Inline NEM entities matching the synthetic fixtures (regions + QNI). */
export const nemEntities = [
  entity("region:au-nem:qld1", "GridRegion", { aemo_region_id: "QLD1" }),
  entity("region:au-nem:nsw1", "GridRegion", { aemo_region_id: "NSW1" }),
  entity("intercon:au-nem:qni", "Interconnector", { aemo_duid: ["NSW1-QLD1"] }),
];

/** Full discover→fetch→parse→normalize pass without a store. */
export async function runPipeline(connector, ctx) {
  const refs = await connector.discover(ctx);
  const raws = [];
  let parsed = [];
  for (const ref of refs) {
    const raw = await connector.fetch(ref, ctx);
    raws.push(raw);
    parsed = parsed.concat(await connector.parse(raw));
  }
  const { observations, unmapped } = connector.normalize(parsed, ctx);
  return { refs, raws, parsed, observations, unmapped };
}
