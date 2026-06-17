// The Windy-style colored wind-speed backdrop: a full-world lng/lat grid mesh,
// each vertex projected through deck's `project32` (so it's mercator-correct at
// any camera), with the fragment shader sampling the GFS u/v texture and
// colormapping its speed. Drawn under the particle layer.

import {
  Layer,
  type LayerContext,
  type LayerProps,
  project32,
  type UpdateParameters,
} from '@deck.gl/core';
import { Geometry, Model } from '@luma.gl/engine';
import { loadWindTexture, WIND_RAMP_GLSL } from './windShared';

// std140 UBO (luma v9 has no setUniforms) — bounds to denormalize u/v, the m/s
// the colormap saturates at, and fill opacity.
const RASTER_UNIFORM_BLOCK = /* glsl */ `\
layout(std140) uniform rasterUniforms {
  float uMin;
  float uMax;
  float vMin;
  float vMax;
  float colorMax;
  float opacity;
} raster;
`;

// Typed `any`: luma's ShaderModule generic isn't worth threading for a local UBO.
const rasterUniforms: any = {
  name: 'raster',
  vs: RASTER_UNIFORM_BLOCK,
  fs: RASTER_UNIFORM_BLOCK,
  uniformTypes: {
    uMin: 'f32',
    uMax: 'f32',
    vMin: 'f32',
    vMax: 'f32',
    colorMax: 'f32',
    opacity: 'f32',
  },
};

const VS = /* glsl */ `#version 300 es
#define SHADER_NAME wind-raster-vertex
in vec2 a_lnglat;
out vec2 v_uv;
void main() {
  float lng = a_lnglat.x;
  float lat = a_lnglat.y;
  // equirect is linear in lng/lat; texture is 0..360°E so u = lng/360 and the
  // repeat wrap handles the western hemisphere (negative lng) seamlessly.
  v_uv = vec2(lng / 360.0, (90.0 - lat) / 180.0);
  gl_Position = project_position_to_clipspace(vec3(lng, lat, 0.0), vec3(0.0), vec3(0.0));
}`;

const FS = /* glsl */ `#version 300 es
#define SHADER_NAME wind-raster-fragment
precision highp float;
uniform sampler2D u_wind;
in vec2 v_uv;
out vec4 fragColor;
${WIND_RAMP_GLSL}
void main() {
  vec2 n = texture(u_wind, v_uv).rg;
  vec2 vel = vec2(mix(raster.uMin, raster.uMax, n.x), mix(raster.vMin, raster.vMax, n.y));
  float speed = length(vel);
  fragColor = vec4(windRamp(speed / raster.colorMax), raster.opacity);
}`;

export type WindRasterLayerProps = LayerProps & {
  image: string;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  /** m/s at which the colormap saturates (magenta). */
  colorMax?: number;
  opacity?: number;
};

const defaultProps = {
  image: '',
  uMin: -40,
  uMax: 40,
  vMin: -40,
  vMax: 40,
  colorMax: 28,
  opacity: 0.6,
};

/** A lng/lat grid covering the mercator-visible world; fine enough in latitude
 * that per-cell linear interpolation tracks the mercator curve. */
function gridMesh(cols: number, rows: number): Float32Array {
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

export class WindRasterLayer extends Layer<WindRasterLayerProps> {
  static layerName = 'WindRasterLayer';
  static defaultProps = defaultProps as never;

  // Typed `any`: deck's layer state is loosely typed; the GPU resources are local.
  declare state: any;

  initializeState(): void {
    const { device } = this.context;
    const mesh = gridMesh(90, 140);
    const model = new Model(device, {
      id: `${this.props.id}-mesh`,
      vs: VS,
      fs: FS,
      modules: [project32, rasterUniforms],
      geometry: new Geometry({
        topology: 'triangle-list',
        vertexCount: mesh.length / 2,
        attributes: { a_lnglat: { size: 2, value: mesh } },
      }),
      parameters: {
        blend: true,
        blendColorSrcFactor: 'src-alpha',
        blendColorDstFactor: 'one-minus-src-alpha',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one-minus-src-alpha',
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
      disableWarnings: true,
    });
    this.setState({ model });
  }

  updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    if (props.image && props.image !== oldProps.image) {
      void this._loadWind(props.image);
    }
  }

  async _loadWind(url: string): Promise<void> {
    const tex = await loadWindTexture(this.context.device, url).catch(
      () => null,
    );
    if (!tex || this.props.image !== url) {
      tex?.destroy();
      return;
    }
    this.state.windTexture?.destroy();
    this.setState({ windTexture: tex });
    this.setNeedsRedraw();
  }

  draw(): void {
    const { model, windTexture } = this.state;
    if (!windTexture) return;
    model.setBindings({ u_wind: windTexture });
    model.shaderInputs.setProps({
      raster: {
        uMin: this.props.uMin,
        uMax: this.props.uMax,
        vMin: this.props.vMin,
        vMax: this.props.vMax,
        colorMax: this.props.colorMax ?? 28,
        opacity: this.props.opacity ?? 0.6,
      },
    });
    model.draw(this.context.renderPass);
  }

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.state.windTexture?.destroy();
    this.state.model?.destroy();
  }
}
