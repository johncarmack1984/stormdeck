// One full-world equirectangular raster of a single GFS scalar field: the same
// lng/lat mesh as the wind backdrop (projected through deck's `project32`), with
// a fragment shader that denormalizes the grayscale texture over [min, max],
// fades out below a display threshold (→ transparent), and colormaps the rest.
// The precip-forecast (REFC) and storm-potential (CAPE) layers are one config
// each on top of this base.
//
// The UBO block name is derived from the layer's `name` (luma binds the block it
// finds as `${module.name}Uniforms`), so the name/block mismatch that silently
// blanked these layers before is now unrepresentable: there is a single `name`.

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
  REFC_RAMP_GLSL,
} from './rasterShared';

export type ScalarRasterLayerProps = LayerProps & {
  image: string;
  /** Denormalization bounds: texture byte 0→min, 255→max. */
  min: number;
  max: number;
  opacity?: number;
};

/** Everything that distinguishes one scalar raster from another. `name` is the
 * single source for the module name, the UBO block (`${name}Uniforms`), the
 * sampler (`u_${name}`), and the setProps key — so they cannot drift apart. */
type ScalarConfig = {
  name: string;
  /** GLSL defining `vec3 ${rampFn}(float value)`. */
  rampGlsl: string;
  rampFn: string;
  /** smoothstep fade-in band over the denormalized value (below → transparent). */
  threshold: [number, number];
  defaultOpacity: number;
};

abstract class ScalarRasterLayer<
  P extends ScalarRasterLayerProps = ScalarRasterLayerProps,
> extends Layer<P> {
  // Typed `any`: deck's layer state is loosely typed; the GPU resources are local.
  declare state: any;

  protected abstract scalarConfig(): ScalarConfig;

  initializeState(): void {
    const { name, rampGlsl, rampFn, threshold, defaultOpacity } =
      this.scalarConfig();
    // std140 UBO (luma v9 has no setUniforms). `vmin`/`vmax` (not min/max — those
    // are GLSL builtins) carry the denormalization bounds; opacity the fill.
    const block = /* glsl */ `\
layout(std140) uniform ${name}Uniforms {
  float vmin;
  float vmax;
  float opacity;
} scalar;
`;
    // Typed `any`: luma's ShaderModule generic isn't worth threading for a UBO.
    const uniforms: any = {
      name,
      vs: block,
      fs: block,
      uniformTypes: { vmin: 'f32', vmax: 'f32', opacity: 'f32' },
    };
    const [lo, hi] = threshold;
    const fs = /* glsl */ `#version 300 es
#define SHADER_NAME ${name}-raster-fragment
precision highp float;
uniform sampler2D u_${name};
in vec2 v_uv;
out vec4 fragColor;
${rampGlsl}
void main() {
  float value = mix(scalar.vmin, scalar.vmax, texture(u_${name}, v_uv).r);
  float a = smoothstep(${lo.toFixed(1)}, ${hi.toFixed(1)}, value) * scalar.opacity;
  if (a <= 0.0) discard;
  fragColor = vec4(${rampFn}(value), a);
}`;
    const mesh = equirectGridMesh(90, 140);
    const model = new Model(this.context.device, {
      id: `${this.props.id}-mesh`,
      vs: EQUIRECT_RASTER_VS,
      fs,
      modules: [project32, uniforms],
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
    this.setState({
      model,
      sampler: `u_${name}`,
      uboKey: name,
      defaultOpacity,
    });
  }

  updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    if (props.image && props.image !== oldProps.image) {
      void this._load(props.image);
    }
  }

  async _load(url: string): Promise<void> {
    const tex = await loadEquirectTexture(this.context.device, url).catch(
      () => null,
    );
    if (!tex || this.props.image !== url) {
      tex?.destroy();
      return;
    }
    this.state.texture?.destroy();
    this.setState({ texture: tex });
    this.setNeedsRedraw();
  }

  draw(): void {
    const { model, texture, sampler, uboKey, defaultOpacity } = this.state;
    if (!texture) return;
    model.setBindings({ [sampler]: texture });
    model.shaderInputs.setProps({
      [uboKey]: {
        vmin: this.props.min,
        vmax: this.props.max,
        opacity: this.props.opacity ?? defaultOpacity,
      },
    });
    model.draw(this.context.renderPass);
  }

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.state.texture?.destroy();
    this.state.model?.destroy();
  }
}

/** GFS composite-reflectivity precip forecast (dBZ). Clear sky (GFS floors
 * no-echo at ~−20 dBZ) and faint returns fade out; only real precip paints. */
export class RefcRasterLayer extends ScalarRasterLayer {
  static layerName = 'RefcRasterLayer';
  static defaultProps = {
    image: '',
    min: -20,
    max: 75,
    opacity: 0.65,
  } as never;
  protected scalarConfig(): ScalarConfig {
    return {
      name: 'refc',
      rampGlsl: REFC_RAMP_GLSL,
      rampFn: 'refcRamp',
      threshold: [8, 20],
      defaultOpacity: 0.65,
    };
  }
}

/** GFS surface-CAPE storm potential (J/kg). Stable / weakly-unstable air (below
 * ~250 J/kg) fades out; only air primed for convection paints. */
export class CapeRasterLayer extends ScalarRasterLayer {
  static layerName = 'CapeRasterLayer';
  static defaultProps = { image: '', min: 0, max: 5000, opacity: 0.5 } as never;
  protected scalarConfig(): ScalarConfig {
    return {
      name: 'cape',
      rampGlsl: CAPE_RAMP_GLSL,
      rampFn: 'capeRamp',
      threshold: [250, 800],
      defaultOpacity: 0.5,
    };
  }
}
