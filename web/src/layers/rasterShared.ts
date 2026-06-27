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

/** A single colormap stop, rgb in 0..1 (the GLSL colorspace). */
export type Rgb = readonly [number, number, number];

/** Build a GLSL colormap `vec3 ${fn}(float ${param})` from evenly-spaced color
 * stops; `mapExpr` maps `param` into the segment coordinate s ∈ [0, n-1]. The
 * stops are exported alongside, so the on-panel legend and the shader share one
 * source — change a color here and both the map and the legend move. */
function buildRampGlsl(
  fn: string,
  param: string,
  stops: readonly Rgb[],
  mapExpr: string,
): string {
  const g = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
  const decls = stops
    .map(
      (c, i) =>
        `  const vec3 c${i} = vec3(${g(c[0])}, ${g(c[1])}, ${g(c[2])});`,
    )
    .join('\n');
  const branches = stops
    .slice(0, -1)
    .map(
      (_, i) =>
        `  if (s < ${i + 1}.0) return mix(c${i}, c${i + 1}, s - ${i}.0);`,
    )
    .join('\n');
  return `
vec3 ${fn}(float ${param}) {
${decls}
  float s = ${mapExpr};
${branches}
  return c${stops.length - 1};
}`;
}

/** Wind-speed colormap stops: calm blue → teal → green → yellow → orange → red →
 * magenta. The ramp input is speed normalized over [0, `WIND_COLOR_MAX`]. */
export const WIND_STOPS: readonly Rgb[] = [
  [0.16, 0.22, 0.45], // calm
  [0.2, 0.55, 0.7], // teal
  [0.3, 0.74, 0.45], // green
  [0.93, 0.86, 0.32], // yellow
  [0.95, 0.55, 0.2], // orange
  [0.86, 0.24, 0.24], // red
  [0.72, 0.26, 0.66], // magenta (extreme)
];
/** m/s at which the wind colormap saturates (magenta) — the legend's high end. */
export const WIND_COLOR_MAX = 28;
export const WIND_RAMP_GLSL = buildRampGlsl(
  'windRamp',
  't',
  WIND_STOPS,
  'clamp(t, 0.0, 1.0) * 6.0',
);

/** Composite-reflectivity (dBZ) colormap stops + domain — the conventional radar
 * scale, so the forecast precip matches the live radar's look. The precip layer
 * renders everything below its display threshold transparent, so this only
 * colors actual echo. */
export const REFC_STOPS: readonly Rgb[] = [
  [0.26, 0.71, 0.42], // green
  [0.93, 0.86, 0.32], // yellow
  [0.95, 0.55, 0.2], // orange
  [0.86, 0.24, 0.24], // red
  [0.72, 0.26, 0.66], // magenta (extreme)
];
export const REFC_DOMAIN: readonly [number, number] = [15, 65];
export const REFC_RAMP_GLSL = buildRampGlsl(
  'refcRamp',
  'dbz',
  REFC_STOPS,
  'clamp((dbz - 15.0) / 12.5, 0.0, 4.0)',
);

/** Surface-CAPE (J/kg) colormap stops + domain — the severe-weather instability
 * scale. The storm-potential layer fades out stable/weak air (< ~250 J/kg) so
 * the overlay only paints where the atmosphere is primed for convection. */
export const CAPE_STOPS: readonly Rgb[] = [
  [0.3, 0.66, 0.36], // weak (green)
  [0.93, 0.86, 0.32], // moderate (yellow)
  [0.95, 0.55, 0.2], // strong (orange)
  [0.86, 0.24, 0.24], // severe (red)
  [0.72, 0.26, 0.66], // extreme (magenta)
];
export const CAPE_DOMAIN: readonly [number, number] = [500, 4500];
export const CAPE_RAMP_GLSL = buildRampGlsl(
  'capeRamp',
  'cape',
  CAPE_STOPS,
  'clamp((cape - 500.0) / 1000.0, 0.0, 4.0)',
);
