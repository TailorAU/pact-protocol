// @pact-tailor/api — REST + SSE server + SDUI composer.
export {
  buildApp,
  SseHub,
  SSE_HEARTBEAT_MS,
  type BuildAppOptions,
  type IntelApp,
  type SseFilters,
} from "./app.js";
export { startServer, route } from "./server.js";
export {
  composePanelDoc,
  computeSituations,
  applySituationRules,
  composeWithAI,
  DEFAULT_FEED_CADENCE_MS,
  STALENESS_MULTIPLIER,
  type ComposeInputs,
} from "./sdui/composer.js";
export { templateFor, type Template } from "./sdui/templates/index.js";
