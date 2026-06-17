// Shared bits for the wind layers (raster backdrop + particle animation): the
// windtex PNG → GPU texture loader, and the wind-speed colormap GLSL.

import type { Device, Texture } from '@luma.gl/core';

/**
 * Load an equirectangular u/v PNG (the ingest's `windtex`) into a luma texture:
 * linear-filtered, longitude-wrapping (addressModeU repeat), row 0 = 90°N
 * (drawn unflipped via a canvas, so texture v=0 is north). Returns null on a
 * fetch/decode failure so callers keep their previous texture.
 */
export async function loadWindTexture(
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
