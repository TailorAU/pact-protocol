# Globe

The human interface is a GPU-rendered interactive globe (`packages/globe`), built with
deck.gl's `_GlobeView` and instanced layers. It consumes only the public API — it holds
no privileged data path — and it was deliberately built **last**, after the data
architecture, per the build-order rule.

## Rendering decisions

- **deck.gl over raw Three.js:** instanced Scatterplot/Arc/Path/GeoJson layers give a
  globe capable of millions of instances without hand-writing projection math or
  shaders; custom layers and the WebGPU path remain available as escape hatches.
- **No DOM elements for geographic objects.** Everything geographic is GPU-instanced.
  DOM is reserved for the SDUI side panel and controls.
- **Bundled basemap:** simplified Natural Earth 110m coastline/country GeoJSON
  (public domain, ~250 KB) is committed and served statically — the globe renders with
  zero external tile or font requests, which also keeps it working under blocked
  egress.

## Layers

| Layer | deck.gl type | Encoding |
|---|---|---|
| Grid boundaries | GeoJsonLayer | fill by live demand intensity |
| Generators | ScatterplotLayer | radius = capacity, colour = live MW / capacity |
| Interconnectors | ArcLayer | width = |flow|, animated direction |
| Vessels | IconLayer | heading-rotated, colour = cargo status (reported vs inferred) |
| Observability gaps | ScatterplotLayer (ring style) | distinct ring — gaps are a first-class visual |

## Level of detail

Zoom-gated layer sets in `src/lod.ts`:

1. **Global** — grid regions, aggregate demand, major interconnector arcs, vessels in
   transit on major routes.
2. **Continental** — major generation assets, basins, ports, cross-border flows.
3. **Regional** — all facilities, transmission, vessels/trains; the Gladstone demo
   scene lives here.
4. **Facility** — SDUI side panel (`/api/intel/sdui/{entityId}`) with live state,
   process inputs/outputs, upstream/downstream chains.

## Live feel under replay

The globe subscribes to `/api/intel/stream` (SSE). When the API runs in replay mode it
re-emits fixture observations on a compressed clock, so the demo visibly ticks —
described in the UI as replayed fixture data, never as live telemetry.

## 3DGS placeholder

The facility LOD reserves a mount point for 3D Gaussian Splatting site views
(globe → region → facility → 3DGS digital twin). Out of scope for this workspace
today; the mount contract is: given `entity_id`, the panel receives a `splat_url`
property from the entity's `properties.visualisation` block when one exists.
