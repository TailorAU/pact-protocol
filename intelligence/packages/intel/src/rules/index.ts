export { type IntelRule, type RuleContext, methodOf } from "./types.js";
export { smelterUtilisation } from "./smelter-utilisation.js";
export { cargoInference } from "./cargo-inference.js";
export { anomalyDetection, anomaliesForKey, MIN_POINTS } from "./anomaly-detection.js";
export { gapSynthesis, SUGGESTED_METRIC } from "./gap-synthesis.js";

import type { IntelRule } from "./types.js";
import { smelterUtilisation } from "./smelter-utilisation.js";
import { cargoInference } from "./cargo-inference.js";
import { anomalyDetection } from "./anomaly-detection.js";
import { gapSynthesis } from "./gap-synthesis.js";

/** All built-in rules, in the order the engine runs them. */
export const ALL_RULES: readonly IntelRule[] = [
  smelterUtilisation,
  cargoInference,
  anomalyDetection,
  gapSynthesis,
];
