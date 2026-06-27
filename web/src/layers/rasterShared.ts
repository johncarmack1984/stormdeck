// Shared scaffolding for the equirectangular raster layers (the wind-speed
// backdrop + the precip forecast): the PNG → GPU texture loader, the full-world
// lng/lat mesh and vertex shader (projected through deck's `project32`), and the
// colormaps. Keeping these here lets WindRasterLayer and RefcRasterLayer stay
// thin — they differ only in their fragment shader (which colormap) and UBO.

import type { Device, Texture } from '@luma.gl/core';

/**
 * Load an equirectangular PNG (the ingest's `windtex` u/v RGB, or `refctex`
 * grayscale dBZ) into a luma texture: linear-filtered, longitude-wrapping
 * (addressModeU repeat), row 0 = 90°N (drawn unflipped via a canvas, so texture
 * v=0 is north). A grayscale PNG arrives as R=G=B, so a scalar layer reads `.r`.
 * Returns null on a fetch/decode failure so callers keep their previous texture.
 */
export async function loadEquirectTexture(
  device: Device,
  url: string,
): Promise<Texture | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob(), {
    imageOrientation: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return device.createTexture({
    width: img.width,
    height: img.height,
    format: 'rgba8unorm',
    data: new Uint8Array(img.data.buffer),
    sampler: {
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    },
  });
}

/** Vertex shader for the equirect raster layers: each lng/lat vertex projected
 * through deck's `project32` (mercator-correct at any camera), emitting the
 * equirect texture coord — u = lng/360 (the `repeat` wrap covers negative lng),
 * v = (90 − lat)/180 (row 0 = north). */
export const EQUIRECT_RASTER_VS = /* glsl */ `#version 300 es
#define SHADER_NAME equirect-raster-vertex
in vec2 a_lnglat;
out vec2 v_uv;
void main() {
  float lng = a_lnglat.x;
  float lat = a_lnglat.y;
  v_uv = vec2(lng / 360.0, (90.0 - lat) / 180.0);
  gl_Position = project_position_to_clipspace(vec3(lng, lat, 0.0), vec3(0.0), vec3(0.0));
}`;

/** A lng/lat triangle grid covering the mercator-visible world, fine enough in
 * latitude that per-cell linear interpolation tracks the mercator curve. Returns
 * a flat `[lng, lat, …]` array for the `a_lnglat` attribute. */
export function equirectGridMesh(cols: number, rows: number): Float32Array {
  const [lngMin, lngMax, latMin, latMax] = [-180, 180, -84, 84];
  const v: number[] = [];
  for (let r = 0; r < rows; r++) {
    const lat0 = latMin + ((latMax - latMin) * r) / rows;
    const lat1 = latMin + ((latMax - latMin) * (r + 1)) / rows;
    for (let c = 0; c < cols; c++) {
      const lng0 = lngMin + ((lngMax - lngMin) * c) / cols;
      const lng1 = lngMin + ((lngMax - lngMin) * (c + 1)) / cols;
      // two triangles per cell
      v.push(lng0, lat0, lng1, lat0, lng0, lat1);
      v.push(lng1, lat0, lng1, lat1, lng0, lat1);
    }
  }
  return new Float32Array(v);
}

/** Wind-speed colormap (normalized 0..1 → rgb): calm blue → teal → green →
 * yellow → orange → red → magenta. Shared by the raster fill (and a future
 * legend) so the scale is one source of truth. */
export const WIND_RAMP_GLSL = /* glsl */ `
vec3 windRamp(float t) {
  const vec3 c0 = vec3(0.16, 0.22, 0.45); // calm
  const vec3 c1 = vec3(0.20, 0.55, 0.70); // teal
  const vec3 c2 = vec3(0.30, 0.74, 0.45); // green
  const vec3 c3 = vec3(0.93, 0.86, 0.32); // yellow
  const vec3 c4 = vec3(0.95, 0.55, 0.20); // orange
  const vec3 c5 = vec3(0.86, 0.24, 0.24); // red
  const vec3 c6 = vec3(0.72, 0.26, 0.66); // magenta (extreme)
  float s = clamp(t, 0.0, 1.0) * 6.0;
  if (s < 1.0) return mix(c0, c1, s);
  if (s < 2.0) return mix(c1, c2, s - 1.0);
  if (s < 3.0) return mix(c2, c3, s - 2.0);
  if (s < 4.0) return mix(c3, c4, s - 3.0);
  if (s < 5.0) return mix(c4, c5, s - 4.0);
  return mix(c5, c6, s - 5.0);
}`;

/** Composite-reflectivity (dBZ) colormap: green → yellow → orange → red →
 * magenta across ~15→65 dBZ, the conventional radar scale (so the forecast
 * precip matches the live radar's look). The precip layer renders everything
 * below its display threshold transparent, so this only colors actual echo. */
export const REFC_RAMP_GLSL = /* glsl */ `
vec3 refcRamp(float dbz) {
  const vec3 c0 = vec3(0.26, 0.71, 0.42); // ~15 green
  const vec3 c1 = vec3(0.93, 0.86, 0.32); // ~28 yellow
  const vec3 c2 = vec3(0.95, 0.55, 0.20); // ~40 orange
  const vec3 c3 = vec3(0.86, 0.24, 0.24); // ~52 red
  const vec3 c4 = vec3(0.72, 0.26, 0.66); // ~65 magenta (extreme)
  float s = clamp((dbz - 15.0) / 12.5, 0.0, 4.0);
  if (s < 1.0) return mix(c0, c1, s);
  if (s < 2.0) return mix(c1, c2, s - 1.0);
  if (s < 3.0) return mix(c2, c3, s - 2.0);
  return mix(c3, c4, s - 3.0);
}`;
