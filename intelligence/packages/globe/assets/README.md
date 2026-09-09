# Basemap assets

`ne_110m_land.geojson` is a **hand-simplified land outline** authored for this
workspace (egress is blocked here, so the real dataset cannot be fetched at
build time). It is coarse but recognisable, with extra vertex budget spent on
the Australian coastline — the Queensland coast and the Gladstone harbour
notch — because the demo scene focuses there.

Production swaps this file for the real **Natural Earth 1:110m land**
(`ne_110m_land`) GeoJSON, which is public domain:
<https://www.naturalearthdata.com/downloads/110m-physical-vectors/>

The file is imported at build time (`?raw`) and bundled — the globe renders
with zero external tile, font, or data requests.
