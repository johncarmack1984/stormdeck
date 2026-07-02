// Wind-speed raster: the WGSL port of the web app's WindRasterLayer
// (web/src/layers/windRasterLayer.ts + rasterShared.ts). One fullscreen
// triangle; the fragment shader unprojects each pixel to the z=0 map plane
// (the same near/far-ray intersection ViewState::window_to_world_at_ground
// does on the CPU), inverts web mercator to lng/lat, and samples the GFS
// u/v equirect texture (row 0 = 90°N, col 0 = 0°E), colormapping speed.

struct WindUniforms {
    inv_view_proj: mat4x4<f32>,
    world_size: f32,
    u_min: f32,
    u_max: f32,
    v_min: f32,
    v_max: f32,
    color_max: f32,
    opacity: f32,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> u: WindUniforms;
@group(0) @binding(1) var wind_tex: texture_2d<f32>;
@group(0) @binding(2) var wind_samp: sampler;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) ndc: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
    var corners = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var out: VsOut;
    out.pos = vec4<f32>(corners[i], 0.0, 1.0);
    out.ndc = corners[i];
    return out;
}

fn unproject(ndc: vec2<f32>, z: f32) -> vec3<f32> {
    let p = u.inv_view_proj * vec4<f32>(ndc, z, 1.0);
    return p.xyz / p.w;
}

// The web colormap (rasterShared WIND_STOPS): calm blue → teal → green →
// yellow → orange → red → magenta, input speed/color_max over 6 segments.
fn wind_ramp(t: f32) -> vec3<f32> {
    let c0 = vec3<f32>(0.16, 0.22, 0.45);
    let c1 = vec3<f32>(0.2, 0.55, 0.7);
    let c2 = vec3<f32>(0.3, 0.74, 0.45);
    let c3 = vec3<f32>(0.93, 0.86, 0.32);
    let c4 = vec3<f32>(0.95, 0.55, 0.2);
    let c5 = vec3<f32>(0.86, 0.24, 0.24);
    let c6 = vec3<f32>(0.72, 0.26, 0.66);
    let s = clamp(t, 0.0, 1.0) * 6.0;
    if (s < 1.0) { return mix(c0, c1, s); }
    if (s < 2.0) { return mix(c1, c2, s - 1.0); }
    if (s < 3.0) { return mix(c2, c3, s - 2.0); }
    if (s < 4.0) { return mix(c3, c4, s - 3.0); }
    if (s < 5.0) { return mix(c4, c5, s - 4.0); }
    if (s < 6.0) { return mix(c5, c6, s - 5.0); }
    return c6;
}

const PI: f32 = 3.14159265358979;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let near = unproject(in.ndc, 0.0);
    let far = unproject(in.ndc, 1.0);
    let denom = near.z - far.z;
    if (abs(denom) < 1e-9) {
        discard;
    }
    // Intersect the eye ray with the z=0 map plane.
    let t = near.z / denom;
    let world = mix(near, far, t);

    // Off the world square there is no map (and no wrapped copies drawn).
    if (world.x < 0.0 || world.x > u.world_size || world.y < 0.0 || world.y > u.world_size) {
        discard;
    }

    // Inverse of WorldCoords::from_lat_lon (web mercator, world_size = 512·2^z).
    let lng = world.x / u.world_size * 360.0 - 180.0;
    let merc_n = (u.world_size * 0.5 - world.y) * 2.0 * PI / u.world_size;
    let lat = degrees(2.0 * atan(exp(merc_n)) - PI * 0.5);

    // Equirect uv: u = lng/360 (repeat wrap puts 0°E at column 0), v = north-down.
    let uv = vec2<f32>(fract(lng / 360.0), (90.0 - lat) / 180.0);
    // SampleLevel: plain sample needs uniform control flow, lost at the discards.
    let n = textureSampleLevel(wind_tex, wind_samp, uv, 0.0).rg;

    let vel = vec2<f32>(mix(u.u_min, u.u_max, n.x), mix(u.v_min, u.v_max, n.y));
    let speed = length(vel);
    // The ramp stops are sRGB values (shared with the web layer, which writes
    // them to a gamma framebuffer); this surface is sRGB so wgpu re-encodes
    // linear output — decode first or the wash renders darker than the web.
    let srgb = wind_ramp(speed / u.color_max);
    return vec4<f32>(pow(srgb, vec3<f32>(2.2)), u.opacity);
}
