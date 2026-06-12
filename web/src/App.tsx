import type { Layer, PickingInfo } from '@deck.gl/core';
import type { MapboxOverlayProps } from '@deck.gl/mapbox';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import type { ViewStateChangeEvent } from 'react-map-gl/maplibre';
import { Map, useControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { basemapStyle } from './basemap';
import { GRID_ZOOM_SPLIT, INITIAL_VIEW } from './config';
import {
  alertsLayer,
  radarLayer,
  tempLayer,
  windLayers,
  windSegments,
} from './layers';
import { useAlerts, useGlobalGrid, useGrid, useRadarTiles } from './weather';

// Tailwind needs every class statically present, so the per-layer swatch
// variants live in a literal lookup rather than `swatch ${key}`. The cn()
// wraps keep these strings under the class linter's jurisdiction too.
// The two arbitrary hexes deliberately mirror the deck.gl layer colors
// in layers.ts (severe-alert fill, mid-tier wind) — legend matches map.
const SWATCH: Record<string, string> = {
  radar: cn('bg-linear-to-br from-green-500 via-yellow-500 to-red-600'),
  alerts: cn('bg-[#dc3c1e]'),
  wind: cn('bg-[#3884de]'),
  temps: cn('bg-linear-to-br from-blue-600 to-red-600'),
};

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function getTooltip(info: PickingInfo): string | null {
  const object: any = info.object;
  if (!object?.properties) return null;
  const p = object.properties;
  if (p.event) {
    return [p.event, p.headline, p.areaDesc].filter(Boolean).join('\n');
  }
  if (p.tempF != null) {
    return `${Math.round(p.tempF)}°F · ${p.rh ?? '—'}% RH\nwind ${Math.round(p.windMph ?? 0)} mph from ${p.windDir ?? '—'}°`;
  }
  return null;
}

function age(ms?: number): string {
  if (!ms) return '—';
  const min = Math.round((Date.now() - ms) / 60_000);
  return min <= 0 ? 'just now' : `${min} min ago`;
}

export default function App() {
  const alerts = useAlerts();
  const grid = useGrid();
  const globalGrid = useGlobalGrid();
  const radarSource = useRadarTiles();
  const [show, setShow] = useState({
    radar: true,
    alerts: true,
    wind: true,
    temps: false,
  });
  const [radarOpacity, setRadarOpacity] = useState(0.65);
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom);

  const style = useMemo(() => basemapStyle(), []);

  // Far out, the coarse planet lattice; near the ground, the fine bbox grid.
  const nearGround = zoom >= GRID_ZOOM_SPLIT;
  const activeGrid = nearGround ? grid : globalGrid;

  const segs = useMemo(
    () => (activeGrid ? windSegments(activeGrid, nearGround ? 1 : 30) : []),
    [activeGrid, nearGround],
  );

  // Thin the global lattice as it recedes so labels don't pile up.
  const temps = useMemo(() => {
    if (!activeGrid) return null;
    if (nearGround) return activeGrid;
    const stride = zoom < 3 ? 3 : zoom < 4.5 ? 2 : 1;
    return {
      ...activeGrid,
      features: activeGrid.features.filter(
        (f) =>
          (f.properties.i ?? 0) % stride === 0 &&
          (f.properties.j ?? 0) % stride === 0,
      ),
    };
  }, [activeGrid, nearGround, zoom]);

  const layers: Layer[] = [];
  if (show.radar) layers.push(radarLayer(radarOpacity, radarSource));
  if (show.alerts && alerts) layers.push(alertsLayer(alerts));
  if (show.wind && segs.length) layers.push(...windLayers(segs));
  if (show.temps && temps) layers.push(tempLayer(temps));

  const toggle = (key: keyof typeof show) => (on: boolean) =>
    setShow((s) => ({ ...s, [key]: on }));

  const layerRow = (key: keyof typeof show, label: ReactNode) => (
    <div className="flex items-center justify-between gap-6">
      <Label htmlFor={`layer-${key}`}>
        <span className={cn('inline-block size-2.5 rounded-xs', SWATCH[key])} />{' '}
        {label}
      </Label>
      <Switch
        id={`layer-${key}`}
        size="sm"
        checked={show[key]}
        onCheckedChange={toggle(key)}
      />
    </div>
  );

  return (
    <div className="fixed inset-0">
      <Map
        initialViewState={INITIAL_VIEW}
        mapStyle={style}
        style={{ width: '100%', height: '100%' }}
        onMoveEnd={(e: ViewStateChangeEvent) => setZoom(e.viewState.zoom)}
        attributionControl={{
          compact: false,
          customAttribution:
            'Radar: <a href="https://www.rainviewer.com/">RainViewer</a> / NOAA · Alerts: <a href="https://www.weather.gov/">NWS</a> · <a href="https://open-meteo.com/">Open-Meteo</a>',
        }}
      >
        <DeckOverlay layers={layers} getTooltip={getTooltip} />
      </Map>

      {/* z-10 clears the deck.gl overlay canvas, which sits in maplibre's
          control container at z-index 2 */}
      <div className="dark absolute top-3 left-3 z-10 flex select-none flex-col gap-2 rounded-lg bg-slate-900/80 px-3.5 py-3 text-slate-200 text-sm shadow-lg backdrop-blur-sm">
        <h1 className="mb-0.5 font-bold text-base tracking-wider">stormdeck</h1>
        {layerRow('radar', 'radar')}
        {show.radar && (
          <Slider
            value={[radarOpacity]}
            min={0.1}
            max={1}
            step={0.05}
            onValueChange={([v]) => setRadarOpacity(v)}
            aria-label="radar opacity"
          />
        )}
        {layerRow(
          'alerts',
          `NWS alerts${alerts ? ` (${alerts.features.length})` : ''}`,
        )}
        {layerRow('wind', 'wind')}
        {layerRow('temps', 'temperature')}
        <div className="mt-1 border-white/15 border-t pt-2 text-slate-400 text-xs leading-normal">
          <div>alerts: {age(alerts?.generated_ms)}</div>
          <div>
            conditions: {age((nearGround ? grid : globalGrid)?.generated_ms)}
          </div>
          <div>grid: {nearGround ? 'regional' : 'global'}</div>
        </div>
      </div>
    </div>
  );
}
