import type { Layer } from '@deck.gl/core';
import type { ReactNode } from 'react';
import type { WeatherData } from '../weather';

/**
 * Per-render context handed to a layer's `build`/`controls`.
 *
 * `zoom`/`region` are the shared, view-derived state; `ui` is the layer's own
 * slice of UI state (e.g. `{ opacity }`) and `setUi` patches it.
 */
export interface LayerCtx {
  zoom: number;
  /** True near the ground (fine grid); false far out (global lattice). */
  region: boolean;
  /** Map-wide forecast time as an hour offset from the citytile snapshot.
   * Time-aware layers filter their data to it (via DataFilterExtension). */
  time: number;
  ui: Record<string, number>;
  setUi: (patch: Record<string, number>) => void;
}

/**
 * A self-contained map layer: data selection, rendering, legend, optional
 * controls, and tooltip — all in one module. The registry in `./index` is the
 * only place that has to know a layer exists; `App` never names one.
 */
export interface WeatherLayer<D = unknown> {
  id: string;
  /** Panel label; gets the layer's data so it can show counts, etc. */
  label: (data: D | null) => ReactNode;
  /** Legend swatch shown beside the label (mirror the layer's map colors). */
  legend: ReactNode;
  defaultVisible: boolean;
  /** Initial per-layer UI state (e.g. `{ opacity: 0.65 }`). */
  initialUi?: Record<string, number>;
  /** Pull this layer's slice out of the shared feeds. */
  select: (w: WeatherData) => D | null;
  /** Build the deck.gl layer(s); owns any per-layer transform. */
  build: (data: D, ctx: LayerCtx) => Layer[];
  /** Optional control rendered under the toggle while the layer is visible. */
  controls?: (ctx: LayerCtx) => ReactNode;
  /** Optional tooltip for a picked object belonging to this layer. */
  tooltip?: (object: any) => string | null;
}
