// The GFS precipitation-forecast raster: the same full-world lng/lat mesh as the
// wind backdrop (projected through deck's `project32`), but the fragment shader
// samples the single-channel `refctex` dBZ texture, drops everything below a
// display threshold (clear sky → transparent), and colormaps the rest on the
// conventional radar scale. Drawn in place of the live radar tiles when the
// timeline is scrubbed into the future. Mirrors WindRasterLayer.

import {
  Layer,
  type LayerContext,
  type LayerProps,
  project32,
  type UpdateParameters,
} from '@deck.gl/core';
import { Geometry, Model } from '@luma.gl/engine';
import {
  EQUIRECT_RASTER_VS,
  equirectGridMesh,
  loadEquirectTexture,
  REFC_RAMP_GLSL,
} from './rasterShared';

// std140 UBO (luma v9 has no setUniforms): the dBZ bounds to denormalize the
// texture byte with, and the fill opacity.
const RASTER_UNIFORM_BLOCK = /* glsl */ `\
layout(std140) uniform refcUniforms {
  float dbzMin;
  float dbzMax;
  float opacity;
} raster;
`;

// Typed `any`: luma's ShaderModule generic isn't worth threading for a local UBO.
const refcUniforms: any = {
  name: 'raster',
  vs: RASTER_UNIFORM_BLOCK,
  fs: RASTER_UNIFORM_BLOCK,
  uniformTypes: {
    dbzMin: 'f32',
    dbzMax: 'f32',
    opacity: 'f32',
  },
};

const FS = /* glsl */ `#version 300 es
#define SHADER_NAME refc-raster-fragment
precision highp float;
uniform sampler2D u_refc;
in vec2 v_uv;
out vec4 fragColor;
${REFC_RAMP_GLSL}
void main() {
  // Grayscale texture: dBZ packed in the red channel over [dbzMin, dbzMax].
  float dbz = mix(raster.dbzMin, raster.dbzMax, texture(u_refc, v_uv).r);
  // Clear sky (GFS floors no-echo at ~-20 dBZ) and faint returns fade out; only
  // real precip (≳ light rain) paints. Fade in across the threshold band so the
  // echo edges aren't a hard cutoff.
  float a = smoothstep(8.0, 20.0, dbz) * raster.opacity;
  if (a <= 0.0) discard;
  fragColor = vec4(refcRamp(dbz), a);
}`;

export type RefcRasterLayerProps = LayerProps & {
  image: string;
  dbzMin: number;
  dbzMax: number;
  opacity?: number;
};

const defaultProps = {
  image: '',
  dbzMin: -20,
  dbzMax: 75,
  opacity: 0.65,
};

export class RefcRasterLayer extends Layer<RefcRasterLayerProps> {
  static layerName = 'RefcRasterLayer';
  static defaultProps = defaultProps as never;

  // Typed `any`: deck's layer state is loosely typed; the GPU resources are local.
  declare state: any;

  initializeState(): void {
    const { device } = this.context;
    const mesh = equirectGridMesh(90, 140);
    const model = new Model(device, {
      id: `${this.props.id}-mesh`,
      vs: EQUIRECT_RASTER_VS,
      fs: FS,
      modules: [project32, refcUniforms],
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
      void this._loadRefc(props.image);
    }
  }

  async _loadRefc(url: string): Promise<void> {
    const tex = await loadEquirectTexture(this.context.device, url).catch(
      () => null,
    );
    if (!tex || this.props.image !== url) {
      tex?.destroy();
      return;
    }
    this.state.refcTexture?.destroy();
    this.setState({ refcTexture: tex });
    this.setNeedsRedraw();
  }

  draw(): void {
    const { model, refcTexture } = this.state;
    if (!refcTexture) return;
    model.setBindings({ u_refc: refcTexture });
    model.shaderInputs.setProps({
      raster: {
        dbzMin: this.props.dbzMin,
        dbzMax: this.props.dbzMax,
        opacity: this.props.opacity ?? 0.65,
      },
    });
    model.draw(this.context.renderPass);
  }

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.state.refcTexture?.destroy();
    this.state.model?.destroy();
  }
}
