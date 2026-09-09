// Gold: derived, always reproducible from bronze + code. The graph delta journal is the
// load-bearing piece — hash-chained exactly like the PACT §6.4 event log (prev_hash over
// the canonical JSON of the previous line, "GENESIS" first), so runtime graph changes
// are tamper-evident and replayable. Memory is a projection; this file is the truth.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { InferenceRecord } from "@pact-tailor/ontology";
import { canonicalJson } from "./canonical.js";

export interface GraphDelta {
  seq: number;
  recorded_at: string;
  kind: "entity_patch" | "relationship_patch";
  payload: Record<string, unknown>;
  prev_hash: string;
}

export type GraphDeltaInput = Omit<GraphDelta, "seq" | "prev_hash">;

function hashLine(line: string): string {
  return createHash("sha256").update(line).digest("base64url");
}

export class GoldStore {
  private readonly graphDir: string;
  private readonly stateDir: string;
  private readonly inferDir: string;
  private lastHash: string | null = null;
  private lastSeq = 0;

  constructor(root: string) {
    this.graphDir = join(root, "graph");
    this.stateDir = join(root, "state");
    this.inferDir = join(root, "inferences");
  }

  private get deltasPath(): string {
    return join(this.graphDir, "deltas.jsonl");
  }

  private loadChainTip(): void {
    if (this.lastHash !== null) return;
    if (!existsSync(this.deltasPath)) {
      this.lastHash = "GENESIS";
      return;
    }
    const lines = readFileSync(this.deltasPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) {
      this.lastHash = "GENESIS";
      return;
    }
    const parsed = JSON.parse(last) as GraphDelta;
    this.lastSeq = parsed.seq;
    this.lastHash = hashLine(canonicalJson(parsed));
  }

  appendGraphDelta(input: GraphDeltaInput): GraphDelta {
    this.loadChainTip();
    const delta: GraphDelta = {
      seq: this.lastSeq + 1,
      recorded_at: input.recorded_at,
      kind: input.kind,
      payload: input.payload,
      prev_hash: this.lastHash as string,
    };
    mkdirSync(this.graphDir, { recursive: true });
    const line = canonicalJson(delta);
    appendFileSync(this.deltasPath, line + "\n");
    this.lastSeq = delta.seq;
    this.lastHash = hashLine(line);
    return delta;
  }

  readGraphDeltas(): GraphDelta[] {
    if (!existsSync(this.deltasPath)) return [];
    return readFileSync(this.deltasPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as GraphDelta);
  }

  /** Walk the journal verifying every prev_hash. Returns the first bad seq, or null if intact. */
  verifyChain(): number | null {
    let prev = "GENESIS";
    for (const delta of this.readGraphDeltas()) {
      if (delta.prev_hash !== prev) return delta.seq;
      prev = hashLine(canonicalJson(delta));
    }
    return null;
  }

  snapshotState(snapshot: Record<string, unknown>, at: string): string {
    mkdirSync(this.stateDir, { recursive: true });
    const path = join(this.stateDir, `${at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, JSON.stringify(snapshot, null, 2));
    return path;
  }

  appendInference(inference: InferenceRecord): void {
    mkdirSync(this.inferDir, { recursive: true });
    const day = inference.produced_at.slice(0, 10);
    appendFileSync(join(this.inferDir, `${day}.jsonl`), JSON.stringify(inference) + "\n");
  }

  readInferences(): InferenceRecord[] {
    if (!existsSync(this.inferDir)) return [];
    return readdirSync(this.inferDir)
      .sort()
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) =>
        readFileSync(join(this.inferDir, n), "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as InferenceRecord),
      );
  }
}
