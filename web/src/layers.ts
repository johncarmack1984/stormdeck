import type { Color, Layer } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import {
  BitmapLayer,
  GeoJsonLayer,
  LineLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers';
import type { Geometry } from 'geojson';
import type { RadarSource } from './config';
import type {
  AlertProps,
  GridProps,
  PointGeom,
  WeatherFc,
  WeatherFeature,
} from './generated/weather';

const SEVERITY_FILL: Record<string, Color> = {
  Extreme: [168, 0, 90, 80],
  Severe: [220, 60, 30, 70],
  Moderate: [240, 150, 20, 55],
  Minor: [120, 170, 40, 45],
  Unknown: [128, 128, 128, 45],
};

const SEVERITY_LINE: Record<string, Color> = {
  Extreme: [168, 0, 90, 220],
  Severe: [220, 60, 30, 220],
  Moderate: [200, 120, 0, 220],
  Minor: [100, 145, 30, 220],
  Unknown: [110, 110, 110, 220],
};

/** Live radar composite; the template is already stamped per frame. */
export function radarLayer(opacity: number, source: RadarSource): Layer {
  return new TileLayer({
    id: 'radar',
    data: source.template,
    minZoom: 1,
    maxZoom: source.maxNativeZoom,
    tileSize: 256,
    opacity,
    renderSubLayers: (props: any) => {
      const [[west, south], [east, north]] = props.tile.boundingBox;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [west, south, east, north],
      });
    },
  });
}

export function alertsLayer(fc: WeatherFc<Geometry, AlertProps>): Layer {
  return new GeoJsonLayer({
    id: 'alerts',
    data: fc as any,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 40],
    stroked: true,
    filled: true,
    lineWidthMinPixels: 1.5,
    getFillColor: (f: any) =>
      SEVERITY_FILL[f.properties.severity] ?? SEVERITY_FILL.Unknown,
    getLineColor: (f: any) =>
      SEVERITY_LINE[f.properties.severity] ?? SEVERITY_LINE.Unknown,
  });
}

export interface WindSeg {
  from: [number, number];
  to: [number, number];
  mph: number;
  dir: number;
}

/**
 * Vector per grid cell pointing where the wind blows toward, scaled by
 * speed. `kmScale` stretches vectors for coarse grids viewed from far out
 * (geographic lengths sized for a metro grid vanish at planet zoom).
 */
export function windSegments(
  grid: WeatherFc<PointGeom, GridProps>,
  kmScale = 1,
): WindSeg[] {
  return grid.features
    .filter((f) => f.properties.windMph != null && f.properties.windDir != null)
    .map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const mph = f.properties.windMph as number;
      const dir = f.properties.windDir as number;
      // windDir is meteorological (direction the wind comes FROM).
      const toward = ((dir + 180) * Math.PI) / 180;
      const lengthKm = (2 + mph * 0.6) * kmScale;
      const dLat = (lengthKm / 111) * Math.cos(toward);
      const dLon =
        (lengthKm / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(toward);
      return {
        from: [lon, lat] as [number, number],
        to: [lon + dLon, lat + dLat] as [number, number],
        mph,
        dir,
      };
    });
}

function windColor(mph: number): Color {
  if (mph < 5) return [148, 163, 184, 200];
  if (mph < 15) return [56, 132, 222, 220];
  if (mph < 25) return [245, 158, 11, 235];
  return [220, 38, 38, 255];
}

export function windLayers(segs: WindSeg[]): Layer[] {
  return [
    new LineLayer<WindSeg>({
      id: 'wind-vectors',
      data: segs,
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: (d) => windColor(d.mph),
      getWidth: (d) => Math.max(1.5, Math.min(5, d.mph / 8)),
      widthUnits: 'pixels',
    }),
    new ScatterplotLayer<WindSeg>({
      id: 'wind-origins',
      data: segs,
      getPosition: (d) => d.from,
      getFillColor: [70, 80, 95, 200],
      radiusMinPixels: 2,
      radiusMaxPixels: 2,
    }),
  ];
}

function tempColor(f: number): Color {
  if (f <= 32) return [37, 99, 235, 255];
  if (f <= 50) return [13, 148, 136, 255];
  if (f <= 70) return [22, 163, 74, 255];
  if (f <= 85) return [234, 88, 12, 255];
  return [220, 38, 38, 255];
}

export function tempLayer(grid: WeatherFc<PointGeom, GridProps>): Layer {
  type F = WeatherFeature<PointGeom, GridProps>;
  const cells = grid.features.filter((f) => f.properties.tempF != null);
  return new TextLayer<F>({
    id: 'temps',
    data: cells,
    pickable: true,
    getPosition: (f) => f.geometry.coordinates,
    getText: (f) => `${Math.round(f.properties.tempF as number)}°`,
    getColor: (f) => tempColor(f.properties.tempF as number),
    getSize: 16,
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontWeight: 700,
    fontSettings: { sdf: true },
    outlineWidth: 2,
    outlineColor: [255, 255, 255, 235],
    characterSet: 'auto',
  });
}
