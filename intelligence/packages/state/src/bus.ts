// StateBus — the typed delta channel between the state engine and its
// consumers (API SSE, intel rules, the globe). One event shape, one event
// name; subscribers get every state.updated / state.corrected in ingest order.
import { EventEmitter } from "node:events";
import type { CurrentMetricState } from "./current.js";

export type StateDeltaType = "state.updated" | "state.corrected";

export interface StateDelta {
  type: StateDeltaType;
  /** The new held state for (entity_id, metric). */
  state: CurrentMetricState;
  /** The state it replaced — null on first sight of the key. */
  previous: CurrentMetricState | null;
}

const DELTA_EVENT = "delta";

export class StateBus extends EventEmitter {
  emitDelta(d: StateDelta): boolean {
    return this.emit(DELTA_EVENT, d);
  }

  /** Subscribe to deltas. Returns the unsubscribe function. */
  onDelta(cb: (d: StateDelta) => void): () => void {
    this.on(DELTA_EVENT, cb);
    return () => {
      this.off(DELTA_EVENT, cb);
    };
  }
}
