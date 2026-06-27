// The GFS storm-potential raster: the same full-world lng/lat mesh as the wind
// backdrop (projected through deck's `project32`), but the fragment shader samples
// the single-channel `capetex` surface-CAPE texture, fades out stable air below a
// display threshold (→ transparent), and colormaps the rest on the severe-weather
// instability scale. Always a forecast (CAPE has no live analog). Mirrors
// RefcRasterLayer / WindRasterLayer.

import {
  Layer,
  type LayerContext,
  type LayerProps,
  project32,
  type UpdateParameters,
} from '@deck.gl/core';
import { Geometry, Model } from '@luma.gl/engine';
import {
  CAPE_RAMP_GLSL,
  EQUIRECT_RASTER_VS,
  equirectGridMesh,
  loadEquirectTexture,
} from './rasterShared';

// std140 UBO (luma v9 has no setUniforms): the J/kg bounds to denormalize the
// texture byte with, and the fill opacity.
const RASTER_UNIFORM_BLOCK = /* glsl */ `\
layout(std140) uniform capeUniforms {
  float capeMin;
  float capeMax;
  float opacity;
} raster;
`;

// Typed `any`: luma's ShaderModule generic isn't worth threading for a local UBO.
// `name` MUST match the UBO block prefix: luma derives the block it binds as
// `${name}Uniforms` (shadertools getShaderModuleUniformBlockName), so a 'raster'
// name with a `capeUniforms` block silently fails to bind (uniforms read 0).
const capeUniforms: any = {
  name: 'cape',
  vs: RASTER_UNIFORM_BLOCK,
  fs: RASTER_UNIFORM_BLOCK,
  uniformTypes: {
    capeMin: 'f32',
    capeMax: 'f32',
    opacity: 'f32',
  },
};

const FS = /* glsl */ `#version 300 es
#define SHADER_NAME cape-raster-fragment
precision highp float;
uniform sampler2D u_cape;
in vec2 v_uv;
out vec4 fragColor;
${CAPE_RAMP_GLSL}
void main() {
  // Grayscale texture: CAPE (J/kg) packed in the red channel over [capeMin, capeMax].
  float cape = mix(raster.capeMin, raster.capeMax, texture(u_cape, v_uv).r);
  // Stable / weakly-unstable air (below ~250 J/kg) fades out; only air primed for
  // convection paints. Fade in across the threshold band so edges aren't a hard cut.
  float a = smoothstep(250.0, 800.0, cape) * raster.opacity;
  if (a <= 0.0) discard;
  fragColor = vec4(capeRamp(cape), a);
}`;

export type CapeRasterLayerProps = LayerProps & {
  image: string;
  capeMin: number;
  capeMax: number;
  opacity?: number;
};

const defaultProps = {
  image: '',
  capeMin: 0,
  capeMax: 5000,
  opacity: 0.5,
};

export class CapeRasterLayer extends Layer<CapeRasterLayerProps> {
  static layerName = 'CapeRasterLayer';
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
      modules: [project32, capeUniforms],
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
      void this._loadCape(props.image);
    }
  }

  async _loadCape(url: string): Promise<void> {
    const tex = await loadEquirectTexture(this.context.device, url).catch(
      () => null,
    );
    if (!tex || this.props.image !== url) {
      tex?.destroy();
      return;
    }
    this.state.capeTexture?.destroy();
    this.setState({ capeTexture: tex });
    this.setNeedsRedraw();
  }

  draw(): void {
    const { model, capeTexture } = this.state;
    if (!capeTexture) return;
    model.setBindings({ u_cape: capeTexture });
    model.shaderInputs.setProps({
      cape: {
        capeMin: this.props.capeMin,
        capeMax: this.props.capeMax,
        opacity: this.props.opacity ?? 0.5,
      },
    });
    model.draw(this.context.renderPass);
  }

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.state.capeTexture?.destroy();
    this.state.model?.destroy();
  }
}
