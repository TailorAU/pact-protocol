// anomaly-detection@1.0.0 — 3-sigma outlier detection on numeric metric
// history. For each (entity, metric) key with at least MIN_POINTS numeric
// observations retained in state history, the latest point is compared to the
// baseline (all points excluding the latest): flag when
// |latest − mean(baseline)| > 3 · σ(baseline), with population σ.
//
// Direct statistical statement about an observed quantity → tier B.
// Confidence scales with the z-score: 0.6 at z = 3, +0.05 per unit of z,
// capped at 0.95 (an infinite z — zero-variance baseline — pins the cap).
import type { InferenceRecord, ObservationRecord } from "@pact-tailor/ontology";
import { addSource, methodOf, type IntelRule, type RuleContext } from "./types.js";

const NAME = "anomaly-detection";
const VERSION = "1.0.0";
export const MIN_POINTS = 12;
const CONFIDENCE_CAP = 0.95;

function confidenceFromZ(z: number): number {
  if (!Number.isFinite(z)) return CONFIDENCE_CAP;
  return Math.min(CONFIDENCE_CAP, 0.6 + 0.05 * (z - 3));
}

function numericHistory(ctx: RuleContext, entityId: string, metric: string): ObservationRecord[] {
  return ctx.state.history(entityId, metric).filter((o) => typeof o.value === "number");
}

/** Scan one (entity, metric) key; returns zero or one anomaly record. */
export function anomaliesForKey(
  ctx: RuleContext,
  entityId: string,
  metric: string,
  method: string = `rule:${NAME}@${VERSION}`,
): InferenceRecord[] {
  const points = numericHistory(ctx, entityId, metric);
  if (points.length < MIN_POINTS) return [];
  const latest = points[points.length - 1] as ObservationRecord;
  const baseline = points.slice(0, -1);
  const values = baseline.map((o) => o.value as number);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const sigma = Math.sqrt(variance);
  const deviation = Math.abs((latest.value as number) - mean);

  // Flag strictly past 3σ. Zero-variance baseline: any deviation is anomalous.
  if (sigma === 0 ? deviation === 0 : deviation <= 3 * sigma) return [];
  const z = sigma === 0 ? Number.POSITIVE_INFINITY : deviation / sigma;

  // Evidence: the anomalous observation plus the two most recent baseline points.
  const b1 = baseline[baseline.length - 1] as ObservationRecord;
  const b2 = baseline[baseline.length - 2] as ObservationRecord;
  const evidence: InferenceRecord["evidence"] = [
    { kind: "observation", ref: latest.observation_id, role: "supports" },
    { kind: "observation", ref: b1.observation_id, role: "supports" },
    { kind: "observation", ref: b2.observation_id, role: "supports" },
  ];
  const sources: string[] = [];
  addSource(sources, latest.source_id);
  addSource(sources, b1.source_id);

  const first = baseline[0] as ObservationRecord;
  return [
    {
      inference_id: ctx.mintId(NAME),
      claim: `anomalous ${metric} on ${entityId}: latest ${latest.value} vs baseline mean ${mean.toFixed(2)} ± ${sigma.toFixed(2)} (z=${Number.isFinite(z) ? z.toFixed(2) : "inf"})`,
      claim_structured: {
        subject: entityId,
        predicate: "exhibits_anomaly",
        object: metric,
        qualifiers: {
          latest: latest.value,
          baseline_mean: mean,
          baseline_sigma: sigma,
          z_score: Number.isFinite(z) ? z : null,
          baseline_points: baseline.length,
        },
      },
      tier: "B",
      confidence: confidenceFromZ(z),
      status: "INFERRED",
      method,
      evidence,
      sources,
      produced_at: ctx.now(),
      event_time_range: { from: first.event_time, to: latest.event_time },
    },
  ];
}

export const anomalyDetection: IntelRule = {
  name: NAME,
  version: VERSION,
  run(ctx: RuleContext): InferenceRecord[] {
    const out: InferenceRecord[] = [];
    for (const state of ctx.state.projection.all()) {
      out.push(...anomaliesForKey(ctx, state.entity_id, state.metric, methodOf(this)));
    }
    return out;
  },
};
