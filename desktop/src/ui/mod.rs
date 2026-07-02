//! The control panel — egui (0.29, the wgpu-22 pairing) drawn as the last
//! render-graph pass, styled after the web app's upper-left card.
//!
//! Data flow per frame: the event loop (window.rs) feeds winit events to
//! egui-winit (consumed events never reach the map's input controller),
//! builds the panel against the shared [`UiState`] resource, and stashes the
//! tessellated primitives + texture deltas in [`UiFrameData`]. A Queue-stage
//! system (which has device + queue) uploads egui's buffers/textures, and
//! [`UiPassNode`] paints on top of everything. Layer systems (wind) read
//! [`UiState`] to apply the toggles.

use std::{ops::Deref, rc::Rc, time::SystemTime};

use maplibre::{
    context::MapContext,
    environment::Environment,
    kernel::Kernel,
    plugin::Plugin,
    render::{
        eventually::Eventually::Initialized,
        graph::{Node, NodeRunError, RenderContext, RenderGraph, RenderGraphContext, SlotInfo},
        RenderResources, RenderStageLabel, Renderer,
    },
    schedule::Schedule,
    tcs::{system::SystemResult, world::World},
};

/// What the panel controls + shows; layer systems read this.
pub struct UiState {
    pub wind_enabled: bool,
    pub wind_opacity: f32,
    /// Feed snapshot (GFS run) in unix ms, once the wind fetch lands.
    pub wind_meta: Option<i64>,
    /// The forecast-hour axis (sorted, from the feed index) + scrub position.
    pub timeline_hours: Vec<i64>,
    pub timeline_snapshot_ms: i64,
    pub timeline_pos: usize,
    pub playing: bool,
    last_advance: Option<std::time::Instant>,
}

impl UiState {
    pub fn effective_wind_opacity(&self) -> f32 {
        if self.wind_enabled {
            self.wind_opacity
        } else {
            0.0
        }
    }

    /// The forecast hour the timeline is parked on (None until the feed
    /// index arrives).
    pub fn current_hour(&self) -> Option<i64> {
        self.timeline_hours.get(self.timeline_pos).copied()
    }
}

/// One frame of egui output, handed from the event loop to the render side.
#[derive(Default)]
pub struct UiFrameData {
    pub primitives: Vec<egui::ClippedPrimitive>,
    pub textures_delta: egui::TexturesDelta,
    pub pixels_per_point: f32,
    /// Physical size, captured alongside the primitives.
    pub size: [u32; 2],
}

/// egui's wgpu renderer + the primitives it was last prepared with.
struct UiRenderData {
    renderer: egui_wgpu::Renderer,
    primitives: Vec<egui::ClippedPrimitive>,
    screen: egui_wgpu::ScreenDescriptor,
}

/// The web wind ramp (rasterShared WIND_STOPS), for the legend strip.
const WIND_STOPS: [[f32; 3]; 7] = [
    [0.16, 0.22, 0.45],
    [0.2, 0.55, 0.7],
    [0.3, 0.74, 0.45],
    [0.93, 0.86, 0.32],
    [0.95, 0.55, 0.2],
    [0.86, 0.24, 0.24],
    [0.72, 0.26, 0.66],
];

fn ramp_color(t: f32) -> egui::Color32 {
    let s = (t.clamp(0.0, 1.0) * 6.0).min(5.999);
    let i = s as usize;
    let f = s - i as f32;
    let a = WIND_STOPS[i];
    let b = WIND_STOPS[i + 1];
    egui::Color32::from_rgb(
        ((a[0] + (b[0] - a[0]) * f) * 255.0) as u8,
        ((a[1] + (b[1] - a[1]) * f) * 255.0) as u8,
        ((a[2] + (b[2] - a[2]) * f) * 255.0) as u8,
    )
}

/// Build the panel. Runs inside `egui::Context::run` from the event loop.
pub fn build_panel(ctx: &egui::Context, state: &mut UiState) {
    let frame = egui::Frame {
        fill: egui::Color32::from_rgba_unmultiplied(13, 20, 36, 235),
        rounding: egui::Rounding::same(10.0),
        inner_margin: egui::Margin::same(12.0),
        shadow: egui::epaint::Shadow {
            offset: egui::vec2(0.0, 2.0),
            blur: 12.0,
            spread: 0.0,
            color: egui::Color32::from_black_alpha(90),
        },
        ..Default::default()
    };

    egui::Window::new("stormdeck-panel")
        .anchor(egui::Align2::LEFT_TOP, [12.0, 12.0])
        .title_bar(false)
        .resizable(false)
        .frame(frame)
        .show(ctx, |ui| {
            // Clamp the card to its content: full-width widgets (separator,
            // sliders) otherwise ratchet the auto-sized window wider.
            ui.set_max_width(170.0);
            ui.spacing_mut().item_spacing.y = 6.0;
            ui.spacing_mut().slider_width = 110.0;
            ui.label(
                egui::RichText::new("stormdeck")
                    .size(16.0)
                    .strong()
                    .color(egui::Color32::WHITE),
            );

            ui.horizontal(|ui| {
                ui.checkbox(&mut state.wind_enabled, "");
                ui.label(egui::RichText::new("wind").color(egui::Color32::WHITE));
            });

            if let Some(snapshot_ms) = state.wind_meta {
                let age_min = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| (d.as_millis() as i64 - snapshot_ms) / 60_000)
                    .unwrap_or(0);
                ui.label(
                    egui::RichText::new(format!("GFS · {age_min} min ago"))
                        .size(10.5)
                        .color(egui::Color32::from_gray(150)),
                );
            }

            // Legend strip: 0..28 m/s through the shared ramp.
            let (rect, _) = ui.allocate_exact_size(egui::vec2(160.0, 8.0), egui::Sense::hover());
            let painter = ui.painter();
            let n = 32;
            for i in 0..n {
                let t0 = i as f32 / n as f32;
                let t1 = (i + 1) as f32 / n as f32;
                painter.rect_filled(
                    egui::Rect::from_min_max(
                        egui::pos2(rect.min.x + rect.width() * t0, rect.min.y),
                        egui::pos2(rect.min.x + rect.width() * t1, rect.max.y),
                    ),
                    0.0,
                    ramp_color((t0 + t1) * 0.5),
                );
            }
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("0")
                        .size(9.0)
                        .color(egui::Color32::from_gray(140)),
                );
                ui.add_space(rect.width() - 44.0);
                ui.label(
                    egui::RichText::new("28 m/s")
                        .size(9.0)
                        .color(egui::Color32::from_gray(140)),
                );
            });

            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new("fill")
                        .size(10.5)
                        .color(egui::Color32::from_gray(150)),
                );
                ui.add(egui::Slider::new(&mut state.wind_opacity, 0.0..=1.0).show_value(false));
            });

            // Timeline: play/scrub the 7-day forecast axis (one step per
            // 3-hourly texture, same axis the web app scrubs).
            if !state.timeline_hours.is_empty() {
                ui.separator();

                let last = state.timeline_hours.len() - 1;
                ui.horizontal(|ui| {
                    let icon = if state.playing { "⏸" } else { "▶" };
                    if ui.button(icon).clicked() {
                        state.playing = !state.playing;
                        state.last_advance = None;
                    }
                    let mut pos = state.timeline_pos;
                    ui.add(egui::Slider::new(&mut pos, 0..=last).show_value(false));
                    state.timeline_pos = pos;
                });

                if state.playing {
                    let now = std::time::Instant::now();
                    let due = state
                        .last_advance
                        .map(|t| now.duration_since(t).as_millis() >= 350)
                        .unwrap_or(true);
                    if due {
                        state.timeline_pos = (state.timeline_pos + 1) % (last + 1);
                        state.last_advance = Some(now);
                    }
                }

                if let Some(hour) = state.current_hour() {
                    let valid_ms = state.timeline_snapshot_ms + hour * 3_600_000;
                    let label = chrono::DateTime::from_timestamp_millis(valid_ms)
                        .map(|utc| {
                            utc.with_timezone(&chrono::Local)
                                .format("%a %l %p")
                                .to_string()
                                .replace("  ", " ")
                        })
                        .unwrap_or_default();
                    ui.label(
                        egui::RichText::new(format!("{label} · +{hour}h"))
                            .size(10.5)
                            .color(egui::Color32::from_gray(150)),
                    );
                }
            }
        });
}

/// Queue stage: turn the frame's egui output into GPU buffers/textures.
fn ui_upload_system(
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

    let Some(frame) = world.resources.query_mut::<&mut UiFrameData>() else {
        return Ok(());
    };
    if frame.size[0] == 0 {
        return Ok(());
    }
    let primitives = std::mem::take(&mut frame.primitives);
    let textures_delta = std::mem::take(&mut frame.textures_delta);
    let screen = egui_wgpu::ScreenDescriptor {
        size_in_pixels: frame.size,
        pixels_per_point: frame.pixels_per_point,
    };

    // Lazily create the egui renderer (needs the surface format).
    if world.resources.get::<UiRenderData>().is_none() {
        let renderer =
            egui_wgpu::Renderer::new(device, resources.surface.surface_format(), None, 1, false);
        world.resources.insert(UiRenderData {
            renderer,
            primitives: Vec::new(),
            screen: egui_wgpu::ScreenDescriptor {
                size_in_pixels: [1, 1],
                pixels_per_point: 1.0,
            },
        });
    }
    let Some(ui_render) = world.resources.query_mut::<&mut UiRenderData>() else {
        return Ok(());
    };

    for (id, delta) in &textures_delta.set {
        ui_render.renderer.update_texture(device, queue, *id, delta);
    }

    // egui wants an encoder for staging; ours submits before the graph runs.
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("ui_upload"),
    });
    let user_buffers =
        ui_render
            .renderer
            .update_buffers(device, queue, &mut encoder, &primitives, &screen);
    queue.submit(user_buffers.into_iter().chain([encoder.finish()]));

    for id in &textures_delta.free {
        ui_render.renderer.free_texture(id);
    }

    ui_render.primitives = primitives;
    ui_render.screen = screen;

    Ok(())
}

pub struct UiPassNode;

impl Node for UiPassNode {
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
        let Some(ui_render) = world.resources.get::<UiRenderData>() else {
            return Ok(());
        };
        if ui_render.primitives.is_empty() {
            return Ok(());
        }

        let pass = render_context
            .command_encoder
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("ui_pass"),
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

        // egui-wgpu wants a 'static pass; ours ends inside this scope.
        let mut pass = pass.forget_lifetime();
        ui_render
            .renderer
            .render(&mut pass, &ui_render.primitives, &ui_render.screen);

        Ok(())
    }
}

pub struct UiPlugin;

impl<E: Environment> Plugin<E> for UiPlugin {
    fn build(
        &self,
        schedule: &mut Schedule,
        _kernel: Rc<Kernel<E>>,
        world: &mut World,
        graph: &mut RenderGraph,
    ) {
        let draw_graph = graph.get_sub_graph_mut("draw").unwrap();
        draw_graph.add_node("ui_pass", UiPassNode);
        // Above everything, including the wind raster + particle trails.
        draw_graph.add_node_edge("wind_pass", "ui_pass").unwrap();
        draw_graph
            .add_node_edge("wind_particle_pass", "ui_pass")
            .unwrap();

        world.resources.insert(UiState {
            wind_enabled: true,
            wind_opacity: crate::wind::default_opacity(),
            wind_meta: None,
            timeline_hours: Vec::new(),
            timeline_snapshot_ms: 0,
            timeline_pos: 0,
            playing: false,
            last_advance: None,
        });
        world.resources.insert(UiFrameData::default());

        schedule.add_system_to_stage(RenderStageLabel::Queue, ui_upload_system);
    }
}
