import { layers, namedFlavor } from '@protomaps/basemaps';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { API_BASE } from './config';

const FLAVOR = namedFlavor('light');

function styleLayers(source: string): LayerSpecification[] {
  // Prefix ids so the two copies of the layer set don't collide.
  return layers(source, FLAVOR, { lang: 'en' }).map((l) => ({
    ...l,
    id: `${source}-${l.id}`,
  }));
}

/**
 * Protomaps basemap over two martin-served archives: `world` is a z0-6
 * planet extract (overzooms past 6) so the whole globe has context, and
 * `region` is the full-detail bbox extract painted over it wherever its
 * tiles exist. The region set must drop its `background` layer — that one
 * is screen-wide, not tile-bound, and would hide the world layers.
 */
export function basemapStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs:
      'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
    sources: {
      world: {
        type: 'vector',
        tiles: [`${API_BASE}/world/{z}/{x}/{y}`],
        maxzoom: 6,
        attribution:
          '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
      },
      region: {
        type: 'vector',
        tiles: [`${API_BASE}/region/{z}/{x}/{y}`],
        maxzoom: 15,
      },
    },
    layers: [
      ...styleLayers('world'),
      ...styleLayers('region').filter((l) => l.type !== 'background'),
    ],
  };
}
