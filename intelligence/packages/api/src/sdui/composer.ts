// SDUI composer (docs/SDUI.md, implemented exactly):
//   1. deterministic per-type base template,
//   2. situation computation from live state at composition time,
//   3. situation rules inject/reorder panels,
//   4. composeWithAI — the declared AI seam, currently the identity function.
//
// Panels reference endpoints only; the composer never inlines data values.
// The HTTP handler validates the finished document against
// createValidators().sduiPanel and fails loud (500) on violation.
import type {
  CurrentMetricState,
} from "@pact-tailor/state";
import type {
  EntityRecord,
  InferenceRecord,
  ObservabilityGapRecord,
  SduiPanel,
  SduiPanelDoc,
  SduiSituation,
} from "@pact-tailor/ontology";
import { gapCard, inferenceList, templateFor } from "./templates/index.js";

/**
 * Default assumed feed cadence when no telemetry-feed record is available:
 * 30 minutes. Telemetry is "stale" when staleness exceeds 3× the cadence.
 */
export const DEFAULT_FEED_CADENCE_MS = 30 * 60 * 1000;
export const STALENESS_MULTIPLIER = 3;

export interface ComposeInputs {
  entity: EntityRecord;
  /** Current per-metric states for the entity ([] = no live data). */
  states: CurrentMetricState[];
  /** Gap registry records targeting the entity. */
  gaps: ObservabilityGapRecord[];
  /** Inference records whose subject is the entity. */
  inferences: InferenceRecord[];
  /** Composition instant (ISO). Defaults to wall clock. */
  now?: string;
}

/** Situation rules, computed from live state at composition time. */
export function computeSituations(inputs: ComposeInputs): SduiSituation[] {
  const nowMs = Date.parse(inputs.now ?? new Date().toISOString());
  const situations: SduiSituation[] = [];

  if (inputs.states.length === 0) situations.push("no-live-data");

  const staleThreshold = STALENESS_MULTIPLIER * DEFAULT_FEED_CADENCE_MS;
  const anyStale = inputs.states.some((s) => nowMs - Date.parse(s.event_time) > staleThreshold);
  if (anyStale) situations.push("stale-telemetry");

  if (inputs.gaps.length > 0) situations.push("has-gaps");

  if (inputs.entity.observability === "ESTIMATED") situations.push("estimated-load");

  const anomalyActive = inputs.inferences.some(
    (i) =>
      i.method.startsWith("rule:anomaly-detection@") &&
      (i.status === "INFERRED" || i.status === "CORROBORATED"),
  );
  if (anomalyActive) situations.push("anomaly-active");

  return situations.length === 0 ? ["normal"] : situations;
}

/** Move the first panel of the given kind to the front (inject if absent). */
function hoist(layout: SduiPanel[], kind: SduiPanel["panel"], make: () => SduiPanel): SduiPanel[] {
  const idx = layout.findIndex((p) => p.panel === kind);
  const panel = idx >= 0 ? (layout[idx] as SduiPanel) : make();
  const rest = idx >= 0 ? [...layout.slice(0, idx), ...layout.slice(idx + 1)] : [...layout];
  return [panel, ...rest];
}

/**
 * Situation rules inject or reorder panels:
 *   - has-gaps injects a gap-card when the template lacks one;
 *   - no-live-data hoists the gap-card to the top;
 *   - anomaly-active hoists the inference-list to the very top (applied last,
 *     so it wins over the gap-card hoist).
 */
export function applySituationRules(
  layout: SduiPanel[],
  situations: SduiSituation[],
  entityId: string,
): SduiPanel[] {
  let out = [...layout];
  if (situations.includes("has-gaps") && !out.some((p) => p.panel === "gap-card")) {
    out.push(gapCard(entityId));
  }
  if (situations.includes("no-live-data")) {
    out = hoist(out, "gap-card", () => gapCard(entityId));
  }
  if (situations.includes("anomaly-active")) {
    out = hoist(out, "inference-list", () => inferenceList(entityId));
  }
  return out;
}

/**
 * AI hook (docs/SDUI.md "AI hook") — the declared seam for model-driven
 * composition. Contract: AI may reorder, group, annotate, or drop panels and
 * add panels referencing declared endpoints; it may NOT inline data values,
 * invent endpoints, or alter existing panels' data blocks. Output is
 * schema-validated before serving, and violations fall back to the
 * deterministic layout. The current implementation is the identity function —
 * deterministic output ships unchanged — so the AI layer can land later
 * without renegotiating this contract.
 */
export function composeWithAI(
  _entity: EntityRecord,
  _situations: SduiSituation[],
  deterministicLayout: SduiPanel[],
): SduiPanel[] {
  return deterministicLayout;
}

/** Compose the full panel document for an entity. */
export function composePanelDoc(inputs: ComposeInputs): SduiPanelDoc {
  const situations = computeSituations(inputs);
  const base = templateFor(inputs.entity.entity_type)(inputs.entity.entity_id);
  const deterministic = applySituationRules(base, situations, inputs.entity.entity_id);
  const layout = composeWithAI(inputs.entity, situations, deterministic);
  return {
    entity_id: inputs.entity.entity_id,
    entity_type: inputs.entity.entity_type,
    situation: situations,
    layout,
  };
}
