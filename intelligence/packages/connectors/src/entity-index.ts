// EntityIndex — external-id → entity_id resolution.
//
// Built once from EntityRecord[] (registry + connector seedEntities). Lookups
// return the canonical entity_id or undefined; connectors DROP observations
// whose external id does not resolve and report the id in `unmapped`. No
// guessing, ever — an unresolved id is an honest gap, not a new entity.

import type { EntityRecord } from "@pact-tailor/ontology";

export class EntityIndex {
  private readonly duid = new Map<string, string>();
  private readonly region = new Map<string, string>();
  private readonly mmsi = new Map<string, string>();
  private readonly imo = new Map<string, string>();
  private readonly eic = new Map<string, string>();
  private readonly eiaBa = new Map<string, string>();
  private readonly ids = new Set<string>();

  constructor(entities: EntityRecord[]) {
    for (const entity of entities) {
      this.ids.add(entity.entity_id);
      const ext = entity.external_ids ?? {};
      for (const duid of ext.aemo_duid ?? []) this.duid.set(duid, entity.entity_id);
      if (ext.aemo_region_id) this.region.set(ext.aemo_region_id, entity.entity_id);
      if (ext.mmsi) this.mmsi.set(ext.mmsi, entity.entity_id);
      if (ext.imo) this.imo.set(ext.imo, entity.entity_id);
      if (ext.entsoe_eic) this.eic.set(ext.entsoe_eic, entity.entity_id);
      // FRICTION NOTE: ontology's ExternalIds has no slot for an EIA balancing-
      // authority code (eia_plant_code is a plant, not a BA). Rather than widen
      // the shared type from this package, BA codes are read from the open
      // properties bag (properties.eia_ba_code) — flagged for the ontology
      // owner as a candidate ExternalIds field.
      const eiaBa = entity.properties?.["eia_ba_code"];
      if (typeof eiaBa === "string" && eiaBa.length > 0) this.eiaBa.set(eiaBa, entity.entity_id);
    }
  }

  /** AEMO dispatchable unit id (also MMS INTERCONNECTORID, e.g. NSW1-QLD1). */
  byDuid(duid: string): string | undefined {
    return this.duid.get(duid);
  }

  /** AEMO region id, e.g. QLD1 → region:au-nem:qld1. */
  byRegionId(regionId: string): string | undefined {
    return this.region.get(regionId);
  }

  byMmsi(mmsi: string): string | undefined {
    return this.mmsi.get(mmsi);
  }

  byImo(imo: string): string | undefined {
    return this.imo.get(imo);
  }

  /** ENTSO-E EIC code (external_ids.entsoe_eic). */
  byEic(eic: string): string | undefined {
    return this.eic.get(eic);
  }

  /** EIA balancing-authority code (properties.eia_ba_code — see friction note). */
  byEiaBa(code: string): string | undefined {
    return this.eiaBa.get(code);
  }

  /** True if the entity_id itself is known (used by connector-owned entities). */
  has(entityId: string): boolean {
    return this.ids.has(entityId);
  }

  get size(): number {
    return this.ids.size;
  }
}
