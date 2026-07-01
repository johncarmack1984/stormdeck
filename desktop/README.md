# stormdeck-desktop

A native desktop window for stormdeck, rendering the same martin-served OpenStreetMap basemap as [stormdeck.live](https://stormdeck.live) — no browser, no webview. Built on [maplibre-rs](https://github.com/maplibre/maplibre-rs) (Rust + wgpu, Metal on macOS), pinned to a known-good `main` revision since the project has no usable crates.io release.

## Run

```sh
just desktop run     # or: cargo run (from this folder)
```

A window opens over Dallas at z6, pulling vector tiles from `https://stormdeck.live` (`world` z0–6 planet, `region` full-detail bbox past z6). Drag to pan, scroll to zoom. Tiles are HTTP-cached under `target/tile-cache/`. `STORMDECK_TILE_BASE` points it elsewhere — `just desktop run-local` targets a `just dev` martin on `:3030` — and `STORMDECK_START_ZOOM` overrides the starting zoom (handy for landing straight in the region detail, e.g. `STORMDECK_START_ZOOM=9`).

## How it works

maplibre-rs hardcodes its demo tile source inside the stock `VectorPlugin`, so `src/source.rs` registers a copy of that request system pointed at stormdeck's endpoints, ordered ahead of the stock one (which then sees each tile already claimed and skips it). `src/style.rs` is a hand-reduced protomaps **light**-flavor style — maplibre-rs supports flat colors per source layer, not the kind-based filters the web style uses, so continents read correctly but with less nuance than the browser map.

This crate is deliberately a **standalone cargo workspace**: the wgpu/winit tree stays out of `crates/` (the lambda workspace that CI lints and cargo-lambda-cdk compiles at synth).

## Day-one scope and what's next

This is a beachhead: basemap in a window. Known limits — no overzoom (past z6 outside the region bbox goes empty), flat landcover/landuse colors, label rendering is whatever maplibre-rs' SDF pass can do today. Next steps, in rough order: weather JSON feeds (`weather/*` snapshots, same contract types as the web app), raster overlays (wind/precip textures), and upstreaming a style-driven tile source so `source.rs` can shrink.

## Attribution

Basemap data © [OpenStreetMap](https://openstreetmap.org/copyright) contributors, tiles via [Protomaps](https://protomaps.com) extracts — the same archives credited on the web map.
