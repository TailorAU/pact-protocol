// Typed client for the pinned /api/intel contract. Every call is wrapped:
// failures resolve to null and flip the app-global `apiDown` flag — the globe
// must degrade to a structural view when the API is absent, never crash.

import type {
  EntitiesResponse,
  EntityStateResponse,
  GapsResponse,
  GridsResponse,
  GridSummaryResponse,
  SduiPanelDoc,
} from "./types.js";

export const API_BASE = "/api/intel";

type StatusListener = (down: boolean) => void;

const statusListeners = new Set<StatusListener>();

/** App-global API health flag. `down` = last request failed at network level. */
export const apiStatus = { down: false };

function setDown(down: boolean): void {
  if (apiStatus.down === down) return;
  apiStatus.down = down;
  // Mirror for quick inspection from the console.
  (globalThis as Record<string, unknown>).apiDown = down;
  for (const fn of statusListeners) fn(down);
}

export function onApiStatusChange(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

async function request<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    if (!res.ok) {
      // The server answered — API is up, this resource just isn't there.
      setDown(false);
      return null;
    }
    const body = (await res.json()) as T;
    setDown(false);
    return body;
  } catch {
    setDown(true);
    return null;
  }
}

export interface EntityQuery {
  type?: string;
  grid?: string;
  /** "minLon,minLat,maxLon,maxLat" */
  bbox?: string;
  q?: string;
}

export const api = {
  getGrids(): Promise<GridsResponse | null> {
    return request<GridsResponse>(`${API_BASE}/grids`);
  },

  getGridSummary(gridId: string): Promise<GridSummaryResponse | null> {
    return request<GridSummaryResponse>(
      `${API_BASE}/grids/${encodeURIComponent(gridId)}/summary`,
    );
  },

  getEntities(query: EntityQuery = {}): Promise<EntitiesResponse | null> {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.grid) params.set("grid", query.grid);
    if (query.bbox) params.set("bbox", query.bbox);
    if (query.q) params.set("q", query.q);
    const qs = params.toString();
    return request<EntitiesResponse>(`${API_BASE}/entities${qs ? `?${qs}` : ""}`);
  },

  getEntityState(entityId: string): Promise<EntityStateResponse | null> {
    return request<EntityStateResponse>(
      `${API_BASE}/entities/${encodeURIComponent(entityId)}/state`,
    );
  },

  getGaps(entityId?: string): Promise<GapsResponse | null> {
    const qs = entityId ? `?entity=${encodeURIComponent(entityId)}` : "";
    return request<GapsResponse>(`${API_BASE}/gaps${qs}`);
  },

  getSdui(entityId: string): Promise<SduiPanelDoc | null> {
    return request<SduiPanelDoc>(
      `${API_BASE}/sdui/${encodeURIComponent(entityId)}`,
    );
  },

  /**
   * Fetch an arbitrary endpoint referenced by an SDUI panel `data` block.
   * SDUI rule: panels reference endpoints, never inline values — the client
   * always fetches. Only same-origin /api/intel endpoints are honoured.
   */
  fetchEndpoint<T = unknown>(endpoint: string): Promise<T | null> {
    if (!endpoint.startsWith(API_BASE)) return Promise.resolve(null);
    return request<T>(endpoint);
  },
};
