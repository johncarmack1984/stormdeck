//! Windowing + event loop, vendored from maplibre-winit rev e2c1c4d
//! (lib.rs/noweb.rs), monomorphized to a desktop `()` user-event type.
//!
//! Owned locally for three fixes upstream doesn't have: the first
//! RedrawRequested is primed on `Resumed` (upstream's Resumed arm is a
//! FIXME, so an occluded launch never renders or fetches), the input
//! controller is built with a usable zoom sensitivity plus pinch support
//! (hardcoded/absent upstream — see input/), and the window opens at a
//! map-worthy default size instead of 800x800.

use std::{marker::PhantomData, sync::Arc, time::Instant};

use maplibre::{
    environment::{Environment, OffscreenKernel},
    event_loop::{EventLoop, EventLoopError, EventLoopProxy, SendEventError},
    io::{apc::AsyncProcedureCall, scheduler::Scheduler, source_client::HttpClient},
    map::Map,
    window::{HeadedMapWindow, MapWindow, MapWindowConfig, PhysicalSize, WindowCreateError},
};
use winit::{
    dpi::{LogicalSize, Size},
    event::{ElementState, Event, KeyEvent, WindowEvent},
    keyboard::{Key, NamedKey},
    window::WindowAttributes,
};

use crate::input::{InputController, UpdateState};

/// Keyboard-pan speed/sensitivity match upstream; zoom sensitivity is 5x
/// upstream's 0.1 (one wheel notch = half a level, a trackpad swipe a
/// couple of levels).
const ZOOM_SENSITIVITY: f64 = 0.5;

#[derive(Clone)]
pub struct StormdeckMapWindowConfig {
    title: String,
}

impl StormdeckMapWindowConfig {
    pub fn new(title: String) -> Self {
        Self { title }
    }
}

impl MapWindowConfig for StormdeckMapWindowConfig {
    type MapWindow = StormdeckMapWindow;

    fn create(&self) -> Result<Self::MapWindow, WindowCreateError> {
        let raw_event_loop = winit::event_loop::EventLoop::<()>::with_user_event()
            .build()
            .map_err(|_| WindowCreateError::EventLoop)?;

        #[allow(deprecated)]
        let window = raw_event_loop
            .create_window(
                WindowAttributes::default()
                    .with_title(&self.title)
                    .with_inner_size(Size::Logical(LogicalSize::new(1200.0, 800.0))),
            )
            .map_err(|_| WindowCreateError::Window)?;
        // Shared with the event loop so it can host egui against the
        // concrete winit window (map.window() is generic in run()).
        let window = Arc::new(window);

        Ok(StormdeckMapWindow {
            window: window.clone(),
            event_loop: Some(StormdeckEventLoop {
                event_loop: raw_event_loop,
                window,
            }),
        })
    }
}

pub struct StormdeckMapWindow {
    window: Arc<winit::window::Window>,
    event_loop: Option<StormdeckEventLoop>,
}

impl StormdeckMapWindow {
    pub fn take_event_loop(&mut self) -> Option<StormdeckEventLoop> {
        self.event_loop.take()
    }
}

impl MapWindow for StormdeckMapWindow {
    fn size(&self) -> PhysicalSize {
        let size = self.window.inner_size();
        PhysicalSize::new(size.width, size.height).expect("failed to get window dimensions.")
    }
}

impl HeadedMapWindow for StormdeckMapWindow {
    type WindowHandle = winit::window::Window;

    fn handle(&self) -> &Self::WindowHandle {
        &self.window
    }

    fn request_redraw(&self) {
        self.window.request_redraw()
    }

    fn scale_factor(&self) -> f64 {
        self.window.scale_factor()
    }

    fn id(&self) -> u64 {
        self.window.id().into()
    }
}

pub struct StormdeckEventLoop {
    event_loop: winit::event_loop::EventLoop<()>,
    window: Arc<winit::window::Window>,
}

impl EventLoop<()> for StormdeckEventLoop {
    type EventLoopProxy = StormdeckEventLoopProxy;

    fn run<E>(self, mut map: Map<E>, max_frames: Option<u64>) -> Result<(), EventLoopError>
    where
        E: Environment,
        <E::MapWindowConfig as MapWindowConfig>::MapWindow: HeadedMapWindow,
    {
        let mut last_render_time = Instant::now();
        let mut current_frame: u64 = 0;

        let mut input_controller = InputController::new(0.2, 100.0, ZOOM_SENSITIVITY);
        let mut scale_factor = map.window().scale_factor();

        // egui hosts the control panel; it sees every window event first and
        // hands the frame's primitives to UiPlugin via the UiFrameData
        // resource (uploaded + painted inside the render schedule/graph).
        let window = self.window;
        let egui_ctx = egui::Context::default();
        egui_ctx.set_visuals(egui::Visuals::dark());
        let mut egui_state = egui_winit::State::new(
            egui_ctx.clone(),
            egui::ViewportId::ROOT,
            window.as_ref(),
            Some(scale_factor as f32),
            None,
            None,
        );

        #[allow(deprecated)]
        let result = self.event_loop.run(move |event, window_target| {
            match event {
                Event::WindowEvent {
                    ref event,
                    window_id,
                } if window_id == map.window().id().into() => {
                    let ui_response = egui_state.on_window_event(&window, event);

                    if let WindowEvent::RedrawRequested = event {
                        if !map.is_initialized() {
                            return;
                        }

                        let now = Instant::now();
                        let dt = now - last_render_time;
                        last_render_time = now;

                        // Build the egui frame against the shared UI state...
                        let raw_input = egui_state.take_egui_input(&window);
                        let full_output = egui_ctx.run(raw_input, |ctx| {
                            if let Ok(map_context) = map.context_mut() {
                                if let Some(ui_state) = map_context
                                    .world
                                    .resources
                                    .query_mut::<&mut crate::ui::UiState>()
                                {
                                    crate::ui::build_panel(ctx, ui_state);
                                }
                            }
                        });
                        egui_state.handle_platform_output(&window, full_output.platform_output);
                        let primitives =
                            egui_ctx.tessellate(full_output.shapes, full_output.pixels_per_point);

                        // ...and stage it for UiPlugin's upload system + pass.
                        let size = window.inner_size();
                        if let Ok(map_context) = map.context_mut() {
                            if let Some(frame) = map_context
                                .world
                                .resources
                                .query_mut::<&mut crate::ui::UiFrameData>()
                            {
                                frame.primitives = primitives;
                                frame.textures_delta.append(full_output.textures_delta);
                                frame.pixels_per_point = full_output.pixels_per_point;
                                frame.size = [size.width, size.height];
                            }
                        }

                        if let Ok(map_context) = map.context_mut() {
                            input_controller.update_state(map_context, dt);
                        }

                        map.run_schedule().expect("Failed to run schedule!");

                        if let Some(max_frames) = max_frames {
                            if current_frame >= max_frames {
                                log::info!("Exiting because maximum frames reached.");
                                window_target.exit()
                            }

                            current_frame += 1;
                        }

                        map.window().request_redraw();
                    }

                    if !(ui_response.consumed || input_controller.window_input(event, scale_factor))
                    {
                        match event {
                            WindowEvent::CloseRequested
                            | WindowEvent::KeyboardInput {
                                event:
                                    KeyEvent {
                                        state: ElementState::Pressed,
                                        logical_key: Key::Named(NamedKey::Escape),
                                        ..
                                    },
                                ..
                            } => window_target.exit(),
                            WindowEvent::Resized(winit::dpi::PhysicalSize { width, height }) => {
                                // Zero sizes arrive when minimizing; skip them.
                                if let Some(size) = PhysicalSize::new(*width, *height) {
                                    if let Ok(map_context) = map.context_mut() {
                                        map_context.resize(size, scale_factor);
                                        map.window().request_redraw();
                                    }
                                }
                            }
                            WindowEvent::ScaleFactorChanged {
                                scale_factor: new_scale_factor,
                                ..
                            } => {
                                if let Ok(map_context) = map.context_mut() {
                                    log::info!("New scaling factor: {}", new_scale_factor);
                                    scale_factor = *new_scale_factor;
                                    map_context.resize(
                                        map_context.renderer.resources.surface.size(),
                                        scale_factor,
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                }

                Event::Suspended => {
                    log::info!("Suspending and dropping render state.");
                    map.reset()
                }
                // The redraw loop is self-perpetuating (each RedrawRequested
                // requests the next); this is what starts it. Upstream leaves
                // Resumed unimplemented, which is why occluded launches
                // stalled black.
                Event::Resumed => map.window().request_redraw(),
                _ => {}
            }
        });

        result.map_err(|_| EventLoopError)
    }

    fn create_proxy(&self) -> Self::EventLoopProxy {
        StormdeckEventLoopProxy {
            proxy: self.event_loop.create_proxy(),
        }
    }
}

pub struct StormdeckEventLoopProxy {
    proxy: winit::event_loop::EventLoopProxy<()>,
}

impl EventLoopProxy<()> for StormdeckEventLoopProxy {
    fn send_event(&self, event: ()) -> Result<(), SendEventError> {
        self.proxy
            .send_event(event)
            .map_err(|_e| SendEventError::Closed)
    }
}

/// Mirror of maplibre-winit's WinitEnvironment with our window config.
pub struct StormdeckEnvironment<
    S: Scheduler,
    HC: HttpClient,
    K: OffscreenKernel,
    APC: AsyncProcedureCall<K>,
> {
    phantom_s: PhantomData<S>,
    phantom_hc: PhantomData<HC>,
    phantom_k: PhantomData<K>,
    phantom_apc: PhantomData<APC>,
}

impl<S: Scheduler, HC: HttpClient, K: OffscreenKernel, APC: AsyncProcedureCall<K>> Environment
    for StormdeckEnvironment<S, HC, K, APC>
{
    type MapWindowConfig = StormdeckMapWindowConfig;
    type AsyncProcedureCall = APC;
    type Scheduler = S;
    type HttpClient = HC;
    type OffscreenKernelEnvironment = K;
}
