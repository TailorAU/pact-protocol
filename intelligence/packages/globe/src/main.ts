// @pact-tailor/globe — deck.gl _GlobeView entry point.
// GPU-instanced geography; DOM only for the HUD, tooltip and SDUI side panel.

import "./style.css";
import { Deck, _GlobeView } from "@deck.gl/core";
import type { PickingInfo } from "@deck.gl/core";
import { api, apiStatus, onApiStatusChange } from "./api.js";
import { Hud } from "./hud.js";
import { buildLayers, buildScene, tierForZoom } from "./lod.js";
import type { LodTier, Scene } from "./lod.js";
import { SidePanel } from "./panel.js";
import { stateCache } from "./state-cache.js";
import type { EntityRecord, ObservabilityGapRecord } from "./types.js";

const PULSE_MS = 1600; // gap-ring breathing period
const TICK_MS = 90; // pulse animation cadence (~11 fps, uniform-only updates)
const RELOAD_MS = 30_000; // structural data retry when API was absent

const globeEl = document.getElementById("globe");
if (!globeEl) throw new Error("missing #globe container");

const hud = new Hud(document.body);
const panel = new SidePanel(document.body);

let scene: Scene = buildScene([], []);
let tier: LodTier = tierForZoom(3.2);
hud.setTier(tier);
hud.setEntityCount(0);

// -- picking helpers ---------------------------------------------------------

function pickedEntity(obj: unknown): EntityRecord | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec["entity_id"] === "string" && typeof rec["entity_type"] === "string") {
    return obj as EntityRecord;
  }
  // wrapper data (interconnector arcs, gap markers, grid markers)
  const inner = rec["entity"];
  if (inner && typeof inner === "object") return inner as EntityRecord;
  return null;
}

function pickLabel(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const gap = rec["gap"] as ObservabilityGapRecord | undefined;
  if (gap && typeof gap === "object") {
    const entity = pickedEntity(obj);
    return `⚠ gap: ${gap.desired_metric} (${gap.priority})${entity ? `\n${entity.name}` : ""}`;
  }
  const entity = pickedEntity(obj);
  if (entity) {
    const flow = stateCache.findMegawatts(entity.entity_id);
    const flowLine =
      entity.entity_type === "Interconnector" && flow !== undefined
        ? `\n${flow.toFixed(0)} MW`
        : "";
    return `${entity.name}\n${entity.entity_type}${flowLine}`;
  }
  if (typeof rec["name"] === "string") return rec["name"];
  return null;
}

function handleClick(info: PickingInfo): void {
  const entity = pickedEntity(info.object);
  if (entity) {
    // facility LOD by interaction: entity click opens the SDUI side panel
    void panel.open(entity.entity_id, entity);
  } else if (panel.isOpen) {
    panel.close();
  }
}

// -- deck --------------------------------------------------------------------

const deck = new Deck({
  parent: globeEl as HTMLDivElement,
  // resolution: degrees per mesh subdivision when draping flat geometry on
  // the sphere — 5° keeps the coarse basemap looking curved, still cheap
  views: new _GlobeView({ resolution: 5 }),
  controller: true,
  initialViewState: {
    longitude: 146,
    latitude: -24,
    zoom: 3.2,
    minZoom: 0.4,
    maxZoom: 13,
  },
  layers: [],
  onViewStateChange: ({ viewState }) => {
    const zoom = (viewState as { zoom?: number }).zoom;
    if (typeof zoom !== "number") return;
    const next = tierForZoom(zoom);
    if (next !== tier) {
      tier = next;
      hud.setTier(tier);
      render();
    }
  },
  onClick: handleClick,
  getTooltip: (info: PickingInfo) => {
    const label = pickLabel(info.object);
    return label ? { text: label } : null;
  },
});

function render(): void {
  const pulse = (Date.now() % PULSE_MS) / PULSE_MS;
  deck.setProps({ layers: buildLayers(tier, scene, stateCache, pulse) });
}

// -- data --------------------------------------------------------------------

async function loadData(): Promise<void> {
  const [gridsRes, entitiesRes, gapsRes] = await Promise.all([
    api.getGrids(),
    api.getEntities(),
    api.getGaps(),
  ]);
  const entities = entitiesRes?.entities ?? [];
  const gaps = gapsRes?.gaps ?? [];
  scene = buildScene(entities, gaps);
  hud.setEntityCount(entities.length);
  updateHudConnection();
  render();

  // Seed interconnector flows from grid summaries so arcs carry direction
  // and width on first paint, before the first SSE tick lands.
  const grids = gridsRes?.grids ?? [];
  await Promise.all(
    grids.slice(0, 4).map(async (g) => {
      const summary = await api.getGridSummary(g.grid_id);
      for (const flow of summary?.live?.flows ?? []) {
        if (typeof flow.mw === "number") {
          stateCache.seed(flow.entity_id, "flow_mw", flow.mw, "MW", flow.event_time);
        }
      }
    }),
  );
}

// -- status wiring -----------------------------------------------------------

function updateHudConnection(): void {
  if (apiStatus.down) {
    hud.setConnection("offline", "API offline — structural view");
    return;
  }
  switch (stateCache.connection) {
    case "live":
      hud.setConnection("live", "live SSE — replayed fixtures");
      break;
    case "connecting":
      hud.setConnection("connecting", "connecting…");
      break;
    case "offline":
      hud.setConnection("offline", "stream offline");
      break;
  }
}

onApiStatusChange(updateHudConnection);
stateCache.onConnectionChange(updateHudConnection);
// cache throttles change notifications to at most 4 fps
stateCache.onChange(render);

// gap-ring pulse: uniform-only radius modulation, active when rings visible
setInterval(() => {
  if ((tier === "regional" || tier === "facility") && scene.gaps.length > 0) {
    render();
  }
}, TICK_MS);

// retry structural load while the API is absent or nothing has arrived yet
setInterval(() => {
  if (apiStatus.down || scene.entities.length === 0) void loadData();
}, RELOAD_MS);

// -- boot --------------------------------------------------------------------

stateCache.start();
updateHudConnection();
render();
void loadData();

export { deck };
