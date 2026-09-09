// Entity resolution: find records that likely describe the same real-world thing.
// Pass 1 — identical typed external IDs. Pass 2 — name similarity + geometry proximity.
// Candidates are REPORTED, never auto-merged; a human closes them via `same_as`.
import type { EntityRecord } from "@pact-tailor/ontology";

export interface ResolutionCandidate {
  a: string;
  b: string;
  reason: string;
  score: number;
}

const MATCH_KEYS = ["imo", "mmsi", "aemo_station_id", "entsoe_eic", "eia_plant_code", "gem_id", "unlocode", "abn", "lei", "wikidata_qid"] as const;

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(power station|power plant|ps|pty ltd|limited|ltd|corporation|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

function similarity(a: string, b: string): number {
  const ta = trigrams(normalise(a));
  const tb = trigrams(normalise(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const gram of ta) if (tb.has(gram)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

function pointOf(entity: EntityRecord): [number, number] | null {
  const geom = entity.geometry;
  if (geom && geom.type === "Point") return geom.coordinates as [number, number];
  return null;
}

function kmBetween([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Pairwise scan. Fine at registry scale (thousands); production would block on typed keys first. */
export function findResolutionCandidates(
  entities: EntityRecord[],
  options: { nameThreshold?: number; maxKm?: number } = {},
): ResolutionCandidate[] {
  const nameThreshold = options.nameThreshold ?? 0.82;
  const maxKm = options.maxKm ?? 5;
  const candidates: ResolutionCandidate[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i]!;
      const b = entities[j]!;
      if (a.same_as === b.entity_id || b.same_as === a.entity_id) continue;

      let matched = false;
      for (const key of MATCH_KEYS) {
        const va = a.external_ids?.[key];
        const vb = b.external_ids?.[key];
        if (va !== undefined && vb !== undefined && va === vb) {
          candidates.push({ a: a.entity_id, b: b.entity_id, reason: `shared external_ids.${key}=${String(va)}`, score: 1 });
          matched = true;
          break;
        }
      }
      if (matched || a.entity_type !== b.entity_type) continue;

      const nameScore = similarity(a.name, b.name);
      if (nameScore < nameThreshold) continue;
      const pa = pointOf(a);
      const pb = pointOf(b);
      if (pa && pb) {
        const km = kmBetween(pa, pb);
        if (km <= maxKm) {
          candidates.push({
            a: a.entity_id,
            b: b.entity_id,
            reason: `name similarity ${nameScore.toFixed(2)} within ${km.toFixed(1)} km`,
            score: nameScore,
          });
        }
      }
    }
  }
  return candidates;
}
