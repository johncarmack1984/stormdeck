// Wind particle advection + point rendering — the wgpu port of the
// deck-wind-layer / webgl-wind technique. Particle state lives in a storage
// buffer (no WebGL float-texture ping-pong needed): a compute pass samples
// the GFS u/v texture at each particle, advects it in normalized web-mercator
// world space (conformal, so one cos(lat) scale serves both axes), and
// respawns particles into the visible viewport; a render pass then draws
// them as 1px points into the trails accumulation texture (see trails.wgsl).

struct ParticleUniforms {
    view_proj: mat4x4<f32>,
    bounds_min: vec2<f32>,
    bounds_max: vec2<f32>,
    world_size: f32,
    dt: f32,
    rand_seed: f32,
    speed_factor: f32,
    u_min: f32,
    u_max: f32,
    v_min: f32,
    v_max: f32,
    drop_rate: f32,
    drop_rate_bump: f32,
    color_max: f32,
    _pad: f32,
};

struct Particle {
    pos: vec2<f32>, // normalized world (mercator [0,1]²)
    speed_t: f32,   // speed / color_max, written by the compute pass
    _pad: f32,
};

@group(0) @binding(0) var<uniform> u: ParticleUniforms;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var wind_tex: texture_2d<f32>;
@group(0) @binding(3) var wind_samp: sampler;
// The same buffer, bound read-only for the point pipeline — vertex stages
// can't take read_write storage, and auto-layout only sees used bindings.
@group(0) @binding(4) var<storage, read> particles_ro: array<Particle>;

const PI: f32 = 3.14159265358979;
const EARTH_CIRCUMFERENCE: f32 = 40075016.7;

// One float in [0,1) from a seed — PCG-ish integer hash.
fn hash11(seed: u32) -> f32 {
    var s = seed * 747796405u + 2891336453u;
    s = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    s = (s >> 22u) ^ s;
    return f32(s) / 4294967295.0;
}

fn lat_of(pos_y: f32) -> f32 {
    let merc_n = (0.5 - pos_y) * 2.0 * PI;
    return 2.0 * atan(exp(merc_n)) - PI * 0.5; // radians
}

fn sample_speed(pos: vec2<f32>) -> vec2<f32> {
    let lng = pos.x * 360.0 - 180.0;
    let lat_deg = degrees(lat_of(pos.y));
    let uv = vec2<f32>(fract(lng / 360.0), (90.0 - lat_deg) / 180.0);
    let n = textureSampleLevel(wind_tex, wind_samp, uv, 0.0).rg;
    return vec2<f32>(mix(u.u_min, u.u_max, n.x), mix(u.v_min, u.v_max, n.y));
}

fn random_spawn(idx: u32) -> vec2<f32> {
    let base = idx * 1664525u + u32(u.rand_seed);
    let r1 = hash11(base);
    let r2 = hash11(base ^ 0x9E3779B9u);
    return mix(u.bounds_min, u.bounds_max, vec2<f32>(r1, r2));
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= arrayLength(&particles)) {
        return;
    }
    var p = particles[idx];

    let vel = sample_speed(p.pos);
    let speed = length(vel);
    let speed_t = clamp(speed / u.color_max, 0.0, 1.0);

    // Conformal mercator: meters → normalized world units, one scale for
    // both axes; clamped near the poles. v positive = north = -y.
    let coslat = max(cos(lat_of(p.pos.y)), 0.05);
    let scale = u.dt * u.speed_factor / (EARTH_CIRCUMFERENCE * coslat);
    p.pos += vec2<f32>(vel.x, -vel.y) * scale;
    p.pos.x = fract(p.pos.x);

    // Respawn: random drop (faster particles drop more, keeping jets from
    // piling into permanent streaks) or drifted outside the padded view.
    let margin = (u.bounds_max - u.bounds_min) * 0.05;
    let lo = u.bounds_min - margin;
    let hi = u.bounds_max + margin;
    let outside = p.pos.y < lo.y || p.pos.y > hi.y || p.pos.x < lo.x || p.pos.x > hi.x;
    let drop = u.drop_rate + speed_t * u.drop_rate_bump;
    if (outside || hash11(idx ^ u32(u.rand_seed) * 2654435769u) < drop) {
        p.pos = random_spawn(idx);
    }

    p.speed_t = speed_t;
    particles[idx] = p;
}

// ---- point rendering into the trails texture ----

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) speed_t: f32,
};

// The web wind ramp again (see wind.wgsl); duplicated because WGSL modules
// don't import and the two pipelines want different binding layouts.
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

@vertex
fn vs_point(@builtin(vertex_index) i: u32) -> VsOut {
    let p = particles_ro[i];
    let world = vec4<f32>(p.pos * u.world_size, 0.0, 1.0);
    var out: VsOut;
    out.pos = u.view_proj * world;
    out.speed_t = p.speed_t;
    return out;
}

@fragment
fn fs_point(in: VsOut) -> @location(0) vec4<f32> {
    // Mostly white with a hint of the speed ramp — matching the web look,
    // where bright streaks ride over the colored raster wash; decoded to
    // linear (the trails texture is linear, composited later).
    let srgb = mix(wind_ramp(in.speed_t), vec3<f32>(1.0), 0.7);
    return vec4<f32>(pow(srgb, vec3<f32>(2.2)), 1.0);
}
