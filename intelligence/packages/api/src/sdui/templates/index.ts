// Deterministic per-type base templates (docs/SDUI.md "Composition" step 1).
import type { EntityType, SduiPanel } from "@pact-tailor/ontology";
import { gridTemplate } from "./grid.js";
import { generatorTemplate } from "./generator.js";
import { smelterTemplate } from "./smelter.js";
import { vesselTemplate } from "./vessel.js";
import { portTemplate } from "./port.js";
import { terminalTemplate } from "./terminal.js";
import { mineTemplate } from "./mine.js";
import { defaultTemplate } from "./default.js";

export { gridTemplate, generatorTemplate, smelterTemplate, vesselTemplate, portTemplate, terminalTemplate, mineTemplate, defaultTemplate };
export { gapCard, graphNeighborhood, headlineState, inferenceList, timeseries } from "./shared.js";

export type Template = (entityId: string) => SduiPanel[];

const TEMPLATES: Partial<Record<EntityType, Template>> = {
  Grid: gridTemplate,
  GridRegion: gridTemplate,
  Generator: generatorTemplate,
  Smelter: smelterTemplate,
  Vessel: vesselTemplate,
  Port: portTemplate,
  Terminal: terminalTemplate,
  Berth: terminalTemplate,
  Mine: mineTemplate,
  CoalMine: mineTemplate,
};

export function templateFor(entityType: EntityType): Template {
  return TEMPLATES[entityType] ?? defaultTemplate;
}
