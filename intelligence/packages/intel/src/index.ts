// @pact-tailor/intel — deterministic, versioned rules producing evidence-linked
// InferenceRecords (class C). The IntelEngine is the ONLY producer of class-C
// data in the system: every record it lets out has been schema-validated (a
// rule that emits invalid intelligence is a bug, and the engine throws).
import { EventEmitter } from "node:events";
import {
  createValidators,
  type InferenceRecord,
  type ObservabilityGapRecord,
  type Validators,
} from "@pact-tailor/ontology";
import type { KnowledgeGraph } from "@pact-tailor/graph";
import type { StateEngine, StateDelta } from "@pact-tailor/state";
import type { MedallionStore } from "@pact-tailor/store";
import { ALL_RULES, anomaliesForKey } from "./rules/index.js";
import type { IntelRule, RuleContext } from "./rules/types.js";

export {
  ALL_RULES,
  smelterUtilisation,
  cargoInference,
  anomalyDetection,
  anomaliesForKey,
  gapSynthesis,
  methodOf,
  MIN_POINTS,
  SUGGESTED_METRIC,
  type IntelRule,
  type RuleContext,
} from "./rules/index.js";

export interface IntelEngineOptions {
  graph: KnowledgeGraph;
  state: StateEngine;
  gaps: readonly ObservabilityGapRecord[];
  /** Rule set override (default: ALL_RULES). */
  rules?: readonly IntelRule[];
  /** Debounce for react-mode anomaly re-runs, ms (default 250). */
  reactDebounceMs?: number;
}

const INFERENCE_EVENT = "inference";

export class IntelEngine {
  private readonly graph: KnowledgeGraph;
  private readonly state: StateEngine;
  private readonly gaps: readonly ObservabilityGapRecord[];
  private readonly rules: readonly IntelRule[];
  private readonly validators: Validators;
  private readonly emitter = new EventEmitter();
  private readonly reactDebounceMs: number;

  /** Every validated record produced by this engine, in production order. */
  private readonly inferences: InferenceRecord[] = [];
  /** How many of `inferences` have already been appended to gold. */
  private persisted = 0;
  /** Engine-scoped id counters, keyed `${day}:${slug}` — unique across runs. */
  private readonly idCounters = new Map<string, number>();
  /** React-mode debounce timers keyed `${entity_id} ${metric}`. */
  private readonly reactTimers = new Map<string, NodeJS.Timeout>();
  private detachBus: (() => void) | null = null;

  constructor(opts: IntelEngineOptions) {
    this.graph = opts.graph;
    this.state = opts.state;
    this.gaps = opts.gaps;
    this.rules = opts.rules ?? ALL_RULES;
    this.reactDebounceMs = opts.reactDebounceMs ?? 250;
    this.validators = createValidators();
  }

  private makeContext(now: string): RuleContext {
    const counters = this.idCounters;
    return {
      graph: this.graph,
      state: this.state,
      gaps: this.gaps,
      now: () => now,
      mintId: (slug: string): string => {
        const day = now.slice(0, 10);
        const key = `${day}:${slug}`;
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        return `infer:${day}:${slug}-${n}`;
      },
    };
  }

  /** Validate, record, and announce a batch of rule output. Throws on invalid. */
  private accept(rule: Pick<IntelRule, "name" | "version">, records: InferenceRecord[]): InferenceRecord[] {
    for (const record of records) {
      const result = this.validators.inference(record);
      if (!result.ok) {
        throw new Error(
          `intel: rule ${rule.name}@${rule.version} emitted a schema-invalid inference ` +
            `(${record.inference_id}): ${result.errors.join("; ")}`,
        );
      }
    }
    for (const record of records) {
      this.inferences.push(record);
      this.emitter.emit(INFERENCE_EVENT, record);
    }
    return records;
  }

  /** Run every rule once. Returns the records produced by THIS call. */
  runAll(now: string = new Date().toISOString()): InferenceRecord[] {
    const produced: InferenceRecord[] = [];
    const ctx = this.makeContext(now);
    for (const rule of this.rules) {
      produced.push(...this.accept(rule, rule.run(ctx)));
    }
    return produced;
  }

  /** Run one rule by name. Throws on unknown rule name. */
  runRule(name: string, now: string = new Date().toISOString()): InferenceRecord[] {
    const rule = this.rules.find((r) => r.name === name);
    if (rule === undefined) throw new Error(`intel: unknown rule "${name}"`);
    return this.accept(rule, rule.run(this.makeContext(now)));
  }

  /** All records produced so far, in production order. */
  all(): InferenceRecord[] {
    return [...this.inferences];
  }

  /** Records whose claim subject is the given entity. */
  byEntity(entityId: string): InferenceRecord[] {
    return this.inferences.filter((i) => i.claim_structured.subject === entityId);
  }

  byId(inferenceId: string): InferenceRecord | null {
    return this.inferences.find((i) => i.inference_id === inferenceId) ?? null;
  }

  /** Append records not yet persisted to the gold inference log. Returns the count appended. */
  persistTo(store: MedallionStore): number {
    const fresh = this.inferences.slice(this.persisted);
    for (const record of fresh) store.gold.appendInference(record);
    this.persisted = this.inferences.length;
    return fresh.length;
  }

  /** Subscribe to every record the engine accepts (runAll, runRule, react mode). */
  onInference(cb: (record: InferenceRecord) => void): () => void {
    this.emitter.on(INFERENCE_EVENT, cb);
    return () => {
      this.emitter.off(INFERENCE_EVENT, cb);
    };
  }

  /**
   * React mode: subscribe to state deltas and re-run anomaly-detection for the
   * affected (entity, metric) key only, debounced per key. Returns the detach
   * function (also clears pending timers).
   */
  attach(): () => void {
    if (this.detachBus) return () => this.detach();
    this.detachBus = this.state.onDelta((delta: StateDelta) => {
      const { entity_id, metric } = delta.state;
      const key = `${entity_id} ${metric}`;
      const pending = this.reactTimers.get(key);
      if (pending !== undefined) clearTimeout(pending);
      const timer = setTimeout(() => {
        this.reactTimers.delete(key);
        const ctx = this.makeContext(new Date().toISOString());
        const records = anomaliesForKey(ctx, entity_id, metric);
        this.accept({ name: "anomaly-detection", version: "1.0.0" }, records);
      }, this.reactDebounceMs);
      timer.unref?.();
      this.reactTimers.set(key, timer);
    });
    return () => this.detach();
  }

  /** Detach react mode and cancel pending debounced re-runs. */
  detach(): void {
    if (this.detachBus) {
      this.detachBus();
      this.detachBus = null;
    }
    for (const timer of this.reactTimers.values()) clearTimeout(timer);
    this.reactTimers.clear();
  }
}
