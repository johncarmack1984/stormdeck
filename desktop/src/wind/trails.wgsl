// Trail accumulation + composite for the wind particles (webgl-wind's FBO
// trick on wgpu): each frame the previous trails texture is redrawn faded
// into the current one before the new particle points land on top, and the
// result is composited over the map. The floor() in the fade is
// load-bearing — u8 quantization otherwise stalls (3 × 0.97 rounds back to
// 3) and dead trails ghost forever.

struct TrailUniforms {
    fade: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var trails_tex: texture_2d<f32>;
@group(0) @binding(1) var trails_samp: sampler;
@group(0) @binding(2) var<uniform> u: TrailUniforms;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var out: VsOut;
    out.pos = vec4<f32>(corners[i], 0.0, 1.0);
    // Flip y: clip +y is up, texture v grows down.
    out.uv = corners[i] * vec2<f32>(0.5, -0.5) + 0.5;
    return out;
}

@fragment
fn fs_fade(in: VsOut) -> @location(0) vec4<f32> {
    let prev = textureSampleLevel(trails_tex, trails_samp, in.uv, 0.0);
    return floor(prev * u.fade * 255.0) / 255.0;
}

@fragment
fn fs_composite(in: VsOut) -> @location(0) vec4<f32> {
    // Premultiplied-style over blend (points wrote alpha 1, fade scales all
    // channels together); the pipeline blend does src=One, dst=1-src.alpha.
    return textureSampleLevel(trails_tex, trails_samp, in.uv, 0.0);
}
