//! Wind-speed raster overlay — stage one of porting the web app's wind stack
//! (windRasterLayer.ts; the deck-wind-layer particle pass is stage two).
//!
//! A fetch thread grabs `weather/windtex/latest.json` and the forecast-hour
//! PNG nearest to now (same feed the web app scrubs), a Prepare-stage system
//! turns it into a wgpu texture + pipeline once, a Queue-stage system writes
//! the per-frame uniforms (inverse view-projection + world size), and a
//! render-graph node draws one fullscreen triangle after the map passes
//! (wind.wgsl does the unproject → inverse-mercator → equirect sample).

use std::{ops::Deref, rc::Rc, sync::mpsc, time::SystemTime};

use cgmath::SquareMatrix;
use maplibre::{
    context::MapContext,
    coords::TILE_SIZE,
    environment::Environment,
    kernel::Kernel,
    plugin::Plugin,
    render::{
        eventually::{Eventually, Eventually::Initialized},
        graph::{Node, NodeRunError, RenderContext, RenderGraph, RenderGraphContext, SlotInfo},
        RenderResources, RenderStageLabel, Renderer,
    },
    schedule::Schedule,
    tcs::{
        system::{SystemError, SystemResult},
        world::World,
    },
};
use serde::Deserialize;

use crate::source::tile_base;

pub mod particles;

/// m/s at which the colormap saturates — matches the web legend
/// (rasterShared WIND_COLOR_MAX).
const WIND_COLOR_MAX: f32 = 28.0;

/// Startup fill opacity — the control panel owns it live; default matches
/// the web layer, STORMDECK_WIND_OPACITY overrides the default.
pub fn default_opacity() -> f32 {
    static OPACITY: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *OPACITY.get_or_init(|| {
        std::env::var("STORMDECK_WIND_OPACITY")
            .ok()
            .and_then(|o| o.parse().ok())
            .unwrap_or(0.6)
    })
}

/// weather/windtex/latest.json (contract.rs `WindTexIndex` on the wire).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindTexIndex {
    snapshot_ms: i64,
    hours: Vec<i64>,
    width: u32,
    height: u32,
    u_min: f64,
    u_max: f64,
    v_min: f64,
    v_max: f64,
}

struct WindPayload {
    index: WindTexIndex,
    hour: i64,
    rgba: Vec<u8>,
}

/// Holds the fetch thread's channel until the payload lands.
struct WindState {
    rx: mpsc::Receiver<WindPayload>,
}

/// GPU-side state, created once the payload arrives.
struct WindRenderData {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    uniform_buffer: wgpu::Buffer,
    snapshot_ms: i64,
    hour: i64,
    /// u_min/u_max/v_min/v_max — kept so the per-frame uniform write can
    /// rebuild the whole struct instead of a partial (offset-fragile) write.
    bounds: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct WindUniforms {
    inv_view_proj: [[f32; 4]; 4],
    world_size: f32,
    u_min: f32,
    u_max: f32,
    v_min: f32,
    v_max: f32,
    color_max: f32,
    opacity: f32,
    _pad: f32,
}

fn fetch_wind() -> Result<WindPayload, Box<dyn std::error::Error>> {
    let base = format!("{}/weather/windtex", tile_base());

    let client = reqwest::blocking::Client::new();
    let index: WindTexIndex = client
        .get(format!("{base}/latest.json"))
        .send()?
        .error_for_status()?
        .json()?;

    // The forecast step nearest to now (the web timeline's parked position).
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_millis() as i64;
    let hour = index
        .hours
        .iter()
        .copied()
        .min_by_key(|h| (index.snapshot_ms + h * 3_600_000 - now_ms).abs())
        .ok_or("windtex index has no hours")?;

    let png_bytes = client
        .get(format!("{base}/{}/{}.png", index.snapshot_ms, hour))
        .send()?
        .error_for_status()?
        .bytes()?;

    let decoder = png::Decoder::new(std::io::Cursor::new(&png_bytes[..]));
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf)?;
    if info.width != index.width || info.height != index.height {
        return Err(format!(
            "windtex dims {}x{} disagree with index {}x{}",
            info.width, info.height, index.width, index.height
        )
        .into());
    }
    if info.color_type != png::ColorType::Rgb || info.bit_depth != png::BitDepth::Eight {
        return Err(format!("unexpected windtex format {:?}", info.color_type).into());
    }

    // RGB → RGBA (wgpu has no 3-channel formats).
    let pixels = (index.width * index.height) as usize;
    let mut rgba = vec![255u8; pixels * 4];
    for i in 0..pixels {
        rgba[i * 4..i * 4 + 3].copy_from_slice(&buf[i * 3..i * 3 + 3]);
    }

    Ok(WindPayload { index, hour, rgba })
}

fn spawn_fetch() -> mpsc::Receiver<WindPayload> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || match fetch_wind() {
        Ok(payload) => {
            log::info!(
                "windtex ready: snapshot {} hour +{}h",
                payload.index.snapshot_ms,
                payload.hour
            );
            let _ = tx.send(payload);
        }
        Err(e) => log::warn!("wind layer disabled, fetch failed: {e}"),
    });
    rx
}

/// Prepare: once the payload has arrived, build texture + pipeline + bind group.
fn resource_system(
    MapContext {
        world, renderer, ..
    }: &mut MapContext,
) -> SystemResult {
    let Renderer {
        device,
        queue,
        resources,
        ..
    } = renderer;

    let Some((wind_state, render_data)) = world
        .resources
        .query_mut::<(&mut WindState, &mut Eventually<WindRenderData>)>()
    else {
        return Err(SystemError::Dependencies);
    };

    if matches!(render_data, Eventually::Initialized(_)) {
        return Ok(());
    }
    let Ok(payload) = wind_state.rx.try_recv() else {
        return Ok(());
    };

    let (width, height) = (payload.index.width, payload.index.height);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("wind_texture"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        texture.as_image_copy(),
        &payload.rgba,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(width * 4),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("wind_sampler"),
        // Longitude wraps, latitude clamps — same as the web loader.
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wind_uniforms"),
        size: std::mem::size_of::<WindUniforms>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("wind_shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("wind.wgsl").into()),
    });

    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("wind_pipeline"),
        layout: None, // auto layout from the WGSL, like the map pipelines
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: "vs_main",
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: "fs_main",
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: resources.surface.surface_format(),
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("wind_bind_group"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });

    let bounds = [
        payload.index.u_min as f32,
        payload.index.u_max as f32,
        payload.index.v_min as f32,
        payload.index.v_max as f32,
    ];
    render_data.initialize(|| WindRenderData {
        pipeline,
        bind_group,
        uniform_buffer,
        snapshot_ms: payload.index.snapshot_ms,
        hour: payload.hour,
        bounds,
    });

    // Stage two rides the same texture: build the particle system now.
    let surface_size = (
        resources.surface.size().width(),
        resources.surface.size().height(),
    );
    let particle_data = particles::build(
        device,
        &view,
        &sampler,
        resources.surface.surface_format(),
        surface_size,
        bounds,
    );
    if let Some(slot) = world
        .resources
        .query_mut::<&mut Eventually<particles::WindParticleData>>()
    {
        slot.initialize(|| particle_data);
    }

    Ok(())
}

/// Queue: refresh the camera-dependent uniforms every frame.
fn uniform_system(
    MapContext {
        world,
        view_state,
        renderer,
        ..
    }: &mut MapContext,
) -> SystemResult {
    let meta;
    let need_meta;
    {
        let Some(Initialized(wind)) = world.resources.get::<Eventually<WindRenderData>>() else {
            return Ok(());
        };
        // The panel owns the live opacity; fall back to defaults pre-UI.
        let (opacity, meta_unset) = match world.resources.get::<crate::ui::UiState>() {
            Some(ui) => (ui.effective_wind_opacity(), ui.wind_meta.is_none()),
            None => (default_opacity(), false),
        };
        meta = (wind.snapshot_ms, wind.hour);
        need_meta = meta_unset;

        let Some(inverted) = view_state.view_projection().0.invert() else {
            return Ok(());
        };
        let inv_view_proj: [[f32; 4]; 4] = inverted
            .cast::<f32>()
            .expect("view projection fits f32")
            .into();
        let world_size = (TILE_SIZE * 2.0_f64.powf(view_state.zoom().level() as f64)) as f32;

        let uniforms = WindUniforms {
            inv_view_proj,
            world_size,
            u_min: wind.bounds[0],
            u_max: wind.bounds[1],
            v_min: wind.bounds[2],
            v_max: wind.bounds[3],
            color_max: WIND_COLOR_MAX,
            opacity,
            _pad: 0.0,
        };
        renderer
            .queue
            .write_buffer(&wind.uniform_buffer, 0, bytemuck::bytes_of(&uniforms));
    }

    // Surface the feed provenance to the panel (separate scope: &mut borrow).
    if need_meta {
        if let Some(ui) = world.resources.query_mut::<&mut crate::ui::UiState>() {
            ui.wind_meta = Some(meta);
        }
    }

    Ok(())
}

pub struct WindPassNode;

impl Node for WindPassNode {
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
        let Some(Initialized(wind)) = world.resources.get::<Eventually<WindRenderData>>() else {
            return Ok(());
        };
        if let Some(ui) = world.resources.get::<crate::ui::UiState>() {
            if ui.effective_wind_opacity() <= 0.0 {
                return Ok(());
            }
        }

        let mut pass =
            render_context
                .command_encoder
                .begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("wind_pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: render_target.deref(),
                        ops: wgpu::Operations {
                            // Draws on top of the finished map.
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        resolve_target: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

        pass.set_pipeline(&wind.pipeline);
        pass.set_bind_group(0, &wind.bind_group, &[]);
        pass.draw(0..3, 0..1);

        Ok(())
    }
}

pub struct WindPlugin;

impl<E: Environment> Plugin<E> for WindPlugin {
    fn build(
        &self,
        schedule: &mut Schedule,
        _kernel: Rc<Kernel<E>>,
        world: &mut World,
        graph: &mut RenderGraph,
    ) {
        // Node names come from maplibre's draw graph ("draw" sub-graph with
        // main_pass → translucent_pass); wind draws after both.
        let draw_graph = graph.get_sub_graph_mut("draw").unwrap();
        draw_graph.add_node("wind_pass", WindPassNode);
        draw_graph
            .add_node_edge("translucent_pass", "wind_pass")
            .unwrap();
        // Particles composite over the raster (and under the UI, whose
        // plugin adds its own edge onto this node).
        draw_graph.add_node("wind_particle_pass", particles::WindParticlePassNode);
        draw_graph
            .add_node_edge("wind_pass", "wind_particle_pass")
            .unwrap();

        world.resources.insert(WindState { rx: spawn_fetch() });
        world
            .resources
            .insert(Eventually::<WindRenderData>::Uninitialized);
        world
            .resources
            .insert(Eventually::<particles::WindParticleData>::Uninitialized);

        schedule.add_system_to_stage(RenderStageLabel::Prepare, resource_system);
        schedule.add_system_to_stage(RenderStageLabel::Queue, uniform_system);
        schedule.add_system_to_stage(RenderStageLabel::Queue, particles::frame_system);
    }
}
