# stormdeck-desktop

A native desktop window for stormdeck, rendering the same martin-served OpenStreetMap basemap as [stormdeck.live](https://stormdeck.live) — no browser, no webview. Built on [maplibre-rs](https://github.com/maplibre/maplibre-rs) (Rust + wgpu, Metal on macOS), pinned to a known-good `main` revision since the project has no usable crates.io release.

## Run

```sh
just desktop run     # or: cargo run (from this folder)
```

A window opens over Dallas at z6, pulling vector tiles from `https://stormdeck.live` (`world` z0–6 planet, `region` full-detail bbox past z6).

**Controls:** drag to pan · scroll or trackpad-pinch to zoom (anchored at the cursor) · `WASD`/arrow keys pan · `i`/`+` and `k`/`-` step zoom · `Esc` or the close button quits.

Tiles are HTTP-cached under `target/tile-cache/`. `STORMDECK_TILE_BASE` points it elsewhere — `just desktop run-local` targets a `just dev` martin on `:3030` — and `STORMDECK_START_ZOOM` overrides the starting zoom (handy for landing straight in the region detail, e.g. `STORMDECK_START_ZOOM=9`).

## How it works

maplibre-rs hardcodes its demo tile source inside the stock `VectorPlugin`, so `src/source.rs` registers a copy of that request system pointed at stormdeck's endpoints, ordered ahead of the stock one (which then sees each tile already claimed and skips it). `src/style.rs` is a hand-reduced protomaps **light**-flavor style — maplibre-rs supports flat colors per source layer, not the kind-based filters the web style uses, so continents read correctly but with less nuance than the browser map.

The windowing/input layer (`src/window.rs`, `src/input/`) is vendored from maplibre-winit rather than depended on: upstream hardcodes a zoom sensitivity that makes a full trackpad swipe worth half a level, has no pinch-gesture handling at all (an empty `TODO` handler), and never requests the first redraw (its `Resumed` arm is a `FIXME`), which left occluded launches permanently black. All three are fixed in the vendored copy and are candidates to upstream.

This crate is deliberately a **standalone cargo workspace**: the wgpu/winit tree stays out of `crates/` (the lambda workspace that CI lints and cargo-lambda-cdk compiles at synth).

## Wind layer

The first weather layer is live: `src/wind/` ports the web app's `WindRasterLayer` to WGSL. A fetch thread pulls `weather/windtex/latest.json` and the forecast-hour u/v PNG nearest to now (the same GFS feed the web timeline scrubs), and a render-graph pass after the map draws one fullscreen triangle whose fragment shader unprojects each pixel to the map plane, inverts web mercator to lng/lat, samples the equirect texture, and colormaps `length(u,v)` with the web's exact ramp (saturating at 28 m/s). `STORMDECK_WIND_OPACITY` overrides the 0.6 default (0 disables it). Limits for now: the hour is picked once at launch (no timeline), and there's no particle animation yet — the ramp output is gamma-decoded before write since the wgpu surface is sRGB, unlike the web's framebuffer.

## Control panel

The upper-left card is egui (0.29 — the wgpu-22 pairing that shares maplibre's GPU types), painted as the last render-graph pass. The event loop feeds winit events to egui first (consumed events never reach the map controls), builds the panel against a shared `UiState` resource, and hands the frame's meshes to an upload system + pass node in `src/ui/`. Today it carries the wind toggle, the 0–28 m/s legend, feed provenance (run age + forecast hour), and a live fill-opacity slider; every future layer/timeline control lands in the same place.

## Day-one scope and what's next

This is a beachhead: basemap in a window, plus the wind-speed raster. Known limits — no overzoom (past z6 outside the region bbox goes empty), flat landcover/landuse colors, label rendering is whatever maplibre-rs' SDF pass can do today. Next steps, in rough order: the wind particle pass (deck-wind-layer's advection, as a wgpu compute + trails accumulation), more weather feeds (alerts/temps/precip on the same contract types), a timeline, and upstreaming a style-driven tile source so `source.rs` can shrink.

## Attribution

Basemap data © [OpenStreetMap](https://openstreetmap.org/copyright) contributors, tiles via [Protomaps](https://protomaps.com) extracts — the same archives credited on the web map. Wind: [NOAA GFS](https://registry.opendata.aws/noaa-gfs-bdp-pds/) via NOAA Open Data Dissemination (public domain), served from stormdeck's own `weather/` feed.
