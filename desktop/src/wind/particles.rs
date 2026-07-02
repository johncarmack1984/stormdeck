//! Wind particles — stage two of the wind stack (deck-wind-layer's
//! advection, wgpu-native). See particles.wgsl / trails.wgsl for the GPU
//! side; this file owns the resources (state buffer, trails ping-pong,
//! four pipelines), the per-frame uniform/resize system, and the graph
//! node that runs compute → fade+points → composite.

use std::{cell::Cell, ops::Deref, time::Instant};

use cgmath::{SquareMatrix, Vector4};
use maplibre::{
    context::MapContext,
    coords::TILE_SIZE,
    render::{
        eventually::{Eventually, Eventually::Initialized},
        graph::{Node, NodeRunError, RenderContext, RenderGraphContext, SlotInfo},
        RenderResources, Renderer,
    },
    tcs::{system::SystemResult, world::World},
};

use super::WIND_COLOR_MAX;

const PARTICLE_COUNT: u32 = 20_000;
/// Multiplies real wind speed so synoptic motion reads at map zooms —
/// heavily exaggerated on purpose (a ~10 m/s breeze moves ~100 px/s at z6),
/// the same lie Windy and webgl-wind tell.
const SPEED_FACTOR: f32 = 10_000.0;
const DROP_RATE: f32 = 0.003;
const DROP_RATE_BUMP: f32 = 0.012;
/// Trail persistence: steady camera vs. panning/zooming (screen-space
/// trails smear under camera motion, so they wash out faster).
const FADE_STEADY: f32 = 0.99;
const FADE_MOVING: f32 = 0.85;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ParticleUniforms {
    view_proj: [[f32; 4]; 4],
    bounds_min: [f32; 2],
    bounds_max: [f32; 2],
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
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct TrailUniforms {
    fade: f32,
    _pad: [f32; 3],
}

struct TrailTargets {
    size: (u32, u32),
    views: [wgpu::TextureView; 2],
    /// fade_bgs[i] samples views[i] (the previous frame).
    fade_bgs: [wgpu::BindGroup; 2],
    /// comp_bgs[i] samples views[i] (the just-written frame).
    comp_bgs: [wgpu::BindGroup; 2],
}

pub struct WindParticleData {
    compute_pipeline: wgpu::ComputePipeline,
    point_pipeline: wgpu::RenderPipeline,
    fade_pipeline: wgpu::RenderPipeline,
    composite_pipeline: wgpu::RenderPipeline,
    /// One compute bind group per uploaded forecast hour (each references
    /// that hour's texture); the node picks nearest to the timeline.
    compute_bgs: std::collections::HashMap<i64, wgpu::BindGroup>,
    particle_buf: wgpu::Buffer,
    point_bg: wgpu::BindGroup,
    uniform_buf: wgpu::Buffer,
    trail_uniform_buf: wgpu::Buffer,
    trails_sampler: wgpu::Sampler,
    trails: TrailTargets,
    /// Which trails view is "current" this frame; flipped by the node.
    parity: Cell<bool>,
    bounds: [f32; 4],
    last_frame: Instant,
    frame_counter: u32,
}

impl WindParticleData {
    /// Register another forecast hour's texture (called as uploads land).
    pub fn add_hour(
        &mut self,
        device: &wgpu::Device,
        hour: i64,
        wind_view: &wgpu::TextureView,
        wind_sampler: &wgpu::Sampler,
    ) {
        let bg = compute_bind_group(
            device,
            &self.compute_pipeline,
            &self.uniform_buf,
            &self.particle_buf,
            wind_view,
            wind_sampler,
        );
        self.compute_bgs.insert(hour, bg);
    }
}

fn compute_bind_group(
    device: &wgpu::Device,
    pipeline: &wgpu::ComputePipeline,
    uniform_buf: &wgpu::Buffer,
    particle_buf: &wgpu::Buffer,
    wind_view: &wgpu::TextureView,
    wind_sampler: &wgpu::Sampler,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("wind_particle_compute_bg"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: particle_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::TextureView(wind_view),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: wgpu::BindingResource::Sampler(wind_sampler),
            },
        ],
    })
}

fn make_trails(
    device: &wgpu::Device,
    size: (u32, u32),
    fade_pipeline: &wgpu::RenderPipeline,
    composite_pipeline: &wgpu::RenderPipeline,
    trail_uniform_buf: &wgpu::Buffer,
    sampler: &wgpu::Sampler,
) -> TrailTargets {
    let make_view = || {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("wind_trails"),
                size: wgpu::Extent3d {
                    width: size.0.max(1),
                    height: size.1.max(1),
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default())
    };
    let views = [make_view(), make_view()];

    let fade_bg = |view: &wgpu::TextureView| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wind_trails_fade_bg"),
            layout: &fade_pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: trail_uniform_buf.as_entire_binding(),
                },
            ],
        })
    };
    let comp_bg = |view: &wgpu::TextureView| {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("wind_trails_composite_bg"),
            layout: &composite_pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    };

    TrailTargets {
        size,
        fade_bgs: [fade_bg(&views[0]), fade_bg(&views[1])],
        comp_bgs: [comp_bg(&views[0]), comp_bg(&views[1])],
        views,
    }
}

pub fn build(
    device: &wgpu::Device,
    first_hour: i64,
    wind_view: &wgpu::TextureView,
    wind_sampler: &wgpu::Sampler,
    surface_format: wgpu::TextureFormat,
    surface_size: (u32, u32),
    bounds: [f32; 4],
) -> WindParticleData {
    let particle_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("wind_particles_shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("particles.wgsl").into()),
    });
    let trails_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("wind_trails_shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("trails.wgsl").into()),
    });

    let particle_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wind_particles"),
        size: (PARTICLE_COUNT as u64) * 16,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wind_particle_uniforms"),
        size: std::mem::size_of::<ParticleUniforms>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let trail_uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wind_trail_uniforms"),
        size: std::mem::size_of::<TrailUniforms>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("wind_particle_compute"),
        layout: None,
        module: &particle_shader,
        entry_point: "cs_main",
        compilation_options: Default::default(),
        cache: None,
    });

    let point_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("wind_particle_points"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &particle_shader,
            entry_point: "vs_point",
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &particle_shader,
            entry_point: "fs_point",
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::PointList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    let fullscreen = |entry: &'static str, format: wgpu::TextureFormat, blend| {
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry),
            layout: None,
            vertex: wgpu::VertexState {
                module: &trails_shader,
                entry_point: "vs_fullscreen",
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &trails_shader,
                entry_point: entry,
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        })
    };
    let fade_pipeline = fullscreen("fs_fade", wgpu::TextureFormat::Rgba8Unorm, None);
    let composite_pipeline = fullscreen(
        "fs_composite",
        surface_format,
        // Premultiplied over: the trails carry faded alpha with them.
        Some(wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        }),
    );

    let mut compute_bgs = std::collections::HashMap::new();
    compute_bgs.insert(
        first_hour,
        compute_bind_group(
            device,
            &compute_pipeline,
            &uniform_buf,
            &particle_buf,
            wind_view,
            wind_sampler,
        ),
    );
    let point_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("wind_particle_point_bg"),
        layout: &point_pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: particle_buf.as_entire_binding(),
            },
        ],
    });

    let trails_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("wind_trails_sampler"),
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    let trails = make_trails(
        device,
        surface_size,
        &fade_pipeline,
        &composite_pipeline,
        &trail_uniform_buf,
        &trails_sampler,
    );

    WindParticleData {
        compute_pipeline,
        point_pipeline,
        fade_pipeline,
        composite_pipeline,
        compute_bgs,
        particle_buf,
        point_bg,
        uniform_buf,
        trail_uniform_buf,
        trails_sampler,
        trails,
        parity: Cell::new(false),
        bounds,
        last_frame: Instant::now(),
        frame_counter: 0,
    }
}

/// Unproject an NDC corner to the z=0 map plane (the CPU twin of the
/// raster shader's ray intersection).
fn ndc_to_ground(inv: &cgmath::Matrix4<f64>, x: f64, y: f64) -> Option<(f64, f64)> {
    let unproject = |z: f64| {
        let p = inv * Vector4::new(x, y, z, 1.0);
        (p.truncate() / p.w, p.w)
    };
    let (near, _) = unproject(0.0);
    let (far, _) = unproject(1.0);
    let denom = near.z - far.z;
    if denom.abs() < 1e-12 {
        return None;
    }
    let t = near.z / denom;
    let hit = near + (far - near) * t;
    Some((hit.x, hit.y))
}

/// Queue stage: resize the trails with the window, advance the clock, and
/// write both uniform buffers for this frame.
pub fn frame_system(
    MapContext {
        world,
        view_state,
        renderer,
        ..
    }: &mut MapContext,
) -> SystemResult {
    let Renderer {
        device,
        queue,
        resources,
        ..
    } = renderer;

    let Some(data) = world
        .resources
        .query_mut::<&mut Eventually<WindParticleData>>()
    else {
        return Ok(());
    };
    let Eventually::Initialized(data) = data else {
        return Ok(());
    };

    let surface_size = (
        resources.surface.size().width(),
        resources.surface.size().height(),
    );
    if data.trails.size != surface_size {
        data.trails = make_trails(
            device,
            surface_size,
            &data.fade_pipeline,
            &data.composite_pipeline,
            &data.trail_uniform_buf,
            &data.trails_sampler,
        );
    }

    let now = Instant::now();
    let dt = (now - data.last_frame).as_secs_f32().min(0.05);
    data.last_frame = now;
    data.frame_counter = data.frame_counter.wrapping_add(1);

    let view_proj = view_state.view_projection();
    let Some(inv) = view_proj.0.invert() else {
        return Ok(());
    };
    let world_size = TILE_SIZE * 2.0_f64.powf(view_state.zoom().level() as f64);

    // Visible world rect (normalized to [0,1]²) from the four NDC corners.
    let mut min = (f64::MAX, f64::MAX);
    let mut max = (f64::MIN, f64::MIN);
    for (x, y) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
        let Some((wx, wy)) = ndc_to_ground(&inv, x, y) else {
            return Ok(());
        };
        min = (min.0.min(wx), min.1.min(wy));
        max = (max.0.max(wx), max.1.max(wy));
    }
    let norm = |v: f64| (v / world_size).clamp(-0.5, 1.5) as f32;

    let moving = view_state.did_camera_change() || view_state.did_zoom_change();

    let uniforms = ParticleUniforms {
        view_proj: view_proj.downcast().into(),
        bounds_min: [norm(min.0), norm(min.1)],
        bounds_max: [norm(max.0), norm(max.1)],
        world_size: world_size as f32,
        dt,
        rand_seed: data.frame_counter as f32,
        speed_factor: SPEED_FACTOR,
        u_min: data.bounds[0],
        u_max: data.bounds[1],
        v_min: data.bounds[2],
        v_max: data.bounds[3],
        drop_rate: DROP_RATE,
        drop_rate_bump: DROP_RATE_BUMP,
        color_max: WIND_COLOR_MAX,
        _pad: 0.0,
    };
    queue.write_buffer(&data.uniform_buf, 0, bytemuck::bytes_of(&uniforms));

    let trail_uniforms = TrailUniforms {
        fade: if moving { FADE_MOVING } else { FADE_STEADY },
        _pad: [0.0; 3],
    };
    queue.write_buffer(
        &data.trail_uniform_buf,
        0,
        bytemuck::bytes_of(&trail_uniforms),
    );

    Ok(())
}

pub struct WindParticlePassNode;

impl Node for WindParticlePassNode {
    fn input(&self) -> Vec<SlotInfo> {
        vec![]
    }

    fn update(&mut self, _state: &mut RenderResources) {}

    fn run(
        &self,
        _graph: &mut RenderGraphContext,
        render_context: &mut RenderContext,
        resources: &RenderResources,
        world: &World,
    ) -> Result<(), NodeRunError> {
        let Initialized(render_target) = &resources.render_target else {
            return Ok(());
        };
        let Some(Initialized(data)) = world.resources.get::<Eventually<WindParticleData>>() else {
            return Ok(());
        };
        let mut target_hour = 0;
        if let Some(ui) = world.resources.get::<crate::ui::UiState>() {
            if !ui.wind_enabled {
                return Ok(());
            }
            target_hour = ui.current_hour().unwrap_or(0);
        }
        let Some((compute_bg, _)) = super::nearest_hour(&data.compute_bgs, target_hour) else {
            return Ok(());
        };

        let cur = usize::from(data.parity.get());
        let prev = 1 - cur;

        {
            let mut pass =
                render_context
                    .command_encoder
                    .begin_compute_pass(&wgpu::ComputePassDescriptor {
                        label: Some("wind_particle_advect"),
                        timestamp_writes: None,
                    });
            pass.set_pipeline(&data.compute_pipeline);
            pass.set_bind_group(0, compute_bg, &[]);
            pass.dispatch_workgroups(PARTICLE_COUNT.div_ceil(64), 1, 1);
        }

        {
            // Fade last frame's trails into the current target, then stamp
            // the freshly advected particles on top.
            let mut pass =
                render_context
                    .command_encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("wind_trails_pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &data.trails.views[cur],
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                            resolve_target: None,
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });
            pass.set_pipeline(&data.fade_pipeline);
            pass.set_bind_group(0, &data.trails.fade_bgs[prev], &[]);
            pass.draw(0..3, 0..1);
            pass.set_pipeline(&data.point_pipeline);
            pass.set_bind_group(0, &data.point_bg, &[]);
            pass.draw(0..PARTICLE_COUNT, 0..1);
        }

        {
            let mut pass =
                render_context
                    .command_encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("wind_trails_composite"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: render_target.deref(),
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                            resolve_target: None,
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });
            pass.set_pipeline(&data.composite_pipeline);
            pass.set_bind_group(0, &data.trails.comp_bgs[cur], &[]);
            pass.draw(0..3, 0..1);
        }

        data.parity.set(!data.parity.get());
        Ok(())
    }
}
