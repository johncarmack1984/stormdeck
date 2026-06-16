import type { Layer, PickingInfo } from '@deck.gl/core';
import type { MapboxOverlayProps } from '@deck.gl/mapbox';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ViewStateChangeEvent } from 'react-map-gl/maplibre';
import { Map, useControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { basemapStyle } from './basemap';
import { INITIAL_VIEW } from './config';
import { LAYERS, type LayerCtx } from './layers';
import { nextStep, nowOffset, Timeline } from './Timeline';
import { useWeatherData } from './weather';

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

type UiState = Record<string, Record<string, number>>;
const seedVisible = (): Record<string, boolean> =>
  Object.fromEntries(LAYERS.map((l) => [l.id, l.defaultVisible]));
const seedUi = (): UiState =>
  Object.fromEntries(
    LAYERS.filter((l) => l.initialUi).map((l) => [l.id, { ...l.initialUi }]),
  );

export default function App() {
  const [zoom, setZoom] = useState(INITIAL_VIEW.zoom);
  const data = useWeatherData(zoom);
  const [visible, setVisible] = useState(seedVisible);
  const [ui, setUi] = useState<UiState>(seedUi);
  const [timeState, setTimeState] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const style = useMemo(() => basemapStyle(), []);

  // Map-wide forecast time (hour offset), defaulting to "now" once the citytile
  // axis loads. Drives every time-aware layer's DataFilter.
  const axis = data.cityTiles;
  const time = timeState ?? (axis ? nowOffset(axis) : 0);

  // Play: step the timeline forward, looping.
  useEffect(() => {
    if (!playing || !axis) return;
    const id = setInterval(
      () => setTimeState((t) => nextStep(t ?? nowOffset(axis), axis)),
      700,
    );
    return () => clearInterval(id);
  }, [playing, axis]);

  const ctxFor = (id: string): LayerCtx => ({
    zoom,
    region: data.region,
    time,
    ui: ui[id] ?? {},
    setUi: (patch) => setUi((u) => ({ ...u, [id]: { ...u[id], ...patch } })),
  });

  const layers: Layer[] = LAYERS.flatMap((l) => {
    if (!visible[l.id]) return [];
    const d = l.select(data);
    return d == null ? [] : l.build(d, ctxFor(l.id));
  });

  const getTooltip = (info: PickingInfo): string | null => {
    for (const l of LAYERS) {
      if (visible[l.id] && l.tooltip) {
        const text = l.tooltip(info.object);
        if (text) return text;
      }
    }
    return null;
  };

  return (
    <div className="fixed inset-0">
      <Map
        initialViewState={INITIAL_VIEW}
        // Shareable views: maplibre mirrors #zoom/lat/lng into the URL and
        // reads it back on load (beating INITIAL_VIEW when present).
        hash
        mapStyle={style}
        style={{ width: '100%', height: '100%' }}
        // A hash can land the map far from INITIAL_VIEW; sync zoom state once
        // the real camera exists.
        onLoad={(e) => setZoom(e.target.getZoom())}
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
        {LAYERS.map((l) => (
          <Fragment key={l.id}>
            <div className="flex items-center justify-between gap-6">
              <Label htmlFor={`layer-${l.id}`}>
                {l.legend} {l.label(l.select(data))}
              </Label>
              <Switch
                id={`layer-${l.id}`}
                size="sm"
                checked={visible[l.id]}
                onCheckedChange={(on) =>
                  setVisible((v) => ({ ...v, [l.id]: on }))
                }
              />
            </div>
            {visible[l.id] && l.controls?.(ctxFor(l.id), l.select(data))}
          </Fragment>
        ))}
        {axis && (
          <>
            <hr className="my-0.5 border-white/15" />
            <Timeline
              axis={axis}
              time={time}
              playing={playing}
              onChange={(t) => {
                setPlaying(false);
                setTimeState(t);
              }}
              onTogglePlay={() => setPlaying((p) => !p)}
            />
          </>
        )}
      </div>
    </div>
  );
}
