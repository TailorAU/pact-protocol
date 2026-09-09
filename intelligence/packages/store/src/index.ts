// @pact-tailor/store — the embedded medallion. Layout contract in docs/STORAGE.md:
// bronze is immutable, silver is append-only, gold is disposable-and-reproducible.
// Nothing outside this package touches `var/` directly.
import { join } from "node:path";
import { BronzeStore } from "./bronze.js";
import { SilverStore } from "./silver.js";
import { GoldStore } from "./gold.js";

export { BronzeStore, type BronzeMeta, type BronzePut } from "./bronze.js";
export { SilverStore } from "./silver.js";
export { GoldStore, type GraphDelta, type GraphDeltaInput } from "./gold.js";
export { canonicalJson } from "./canonical.js";

export class MedallionStore {
  readonly bronze: BronzeStore;
  readonly silver: SilverStore;
  readonly gold: GoldStore;

  constructor(varDir: string) {
    this.bronze = new BronzeStore(join(varDir, "bronze"));
    this.silver = new SilverStore(join(varDir, "silver"));
    this.gold = new GoldStore(join(varDir, "gold"));
  }
}
