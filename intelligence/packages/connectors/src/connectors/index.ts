// Connector inventory. Order is the CLI's run order.

import type { Connector } from "../sdk.js";
import { aemoNemwebDispatchis } from "./aemo-nemweb-dispatchis.js";
import { aemoNemwebDispatchScada } from "./aemo-nemweb-dispatch-scada.js";
import { aemoNemwebTradingis } from "./aemo-nemweb-tradingis.js";
import { aemoVisNemSummary } from "./aemo-vis-nem-summary.js";
import { aisstream } from "./aisstream.js";
import { bomObservations } from "./bom-observations.js";
import { entsoeTransparency } from "./entsoe-transparency.js";
import { eiaV2 } from "./eia-v2.js";

export {
  aemoNemwebDispatchis,
  aemoNemwebDispatchScada,
  aemoNemwebTradingis,
  aemoVisNemSummary,
  aisstream,
  bomObservations,
  entsoeTransparency,
  eiaV2,
};
export { GLADSTONE_BBOX, aisTimeToIso } from "./aisstream.js";
export { bomTimeToIso } from "./bom-observations.js";
export { xmlBlocks, xmlText } from "./entsoe-transparency.js";
export { CorrectionTracker, makeNemwebDiscover, nemwebFetch, nemwebParseZip } from "./nemweb-common.js";

export const allConnectors: Connector[] = [
  aemoNemwebDispatchis,
  aemoNemwebDispatchScada,
  aemoNemwebTradingis,
  aemoVisNemSummary,
  aisstream,
  bomObservations,
  entsoeTransparency,
  eiaV2,
];
