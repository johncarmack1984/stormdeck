//! Input handling, vendored from maplibre-winit (rev e2c1c4d) — see
//! window.rs for why the loop is owned locally. Trimmed to what a 2D map
//! wants (mouse/touch pan, zoom, WASD/arrow pan; the upstream camera
//! pitch/yaw orbit, click-query, and debug handlers are dropped) with two
//! local fixes: a usable zoom sensitivity (upstream hardcodes 0.1, which
//! turns a full trackpad swipe into half a zoom level) and trackpad pinch
//! support (upstream's PinchHandler is an empty TODO and PinchGesture
//! events fall through unhandled).

use std::time::Duration;

use cgmath::Vector2;
use maplibre::context::MapContext;
use winit::event::{KeyEvent, TouchPhase, WindowEvent};

mod pan_handler;
mod shift_handler;
mod zoom_handler;

use pan_handler::PanHandler;
use shift_handler::ShiftHandler;
use zoom_handler::ZoomHandler;

pub trait UpdateState {
    fn update_state(&mut self, state: &mut MapContext, dt: Duration);
}

pub struct InputController {
    pan_handler: PanHandler,
    zoom_handler: ZoomHandler,
    shift_handler: ShiftHandler,
}

impl InputController {
    /// `speed`/`sensitivity` drive the keyboard pan (see ShiftHandler);
    /// `zoom_sensitivity` scales wheel/trackpad zoom deltas.
    pub fn new(speed: f64, sensitivity: f64, zoom_sensitivity: f64) -> Self {
        Self {
            pan_handler: PanHandler::default(),
            zoom_handler: ZoomHandler::new(zoom_sensitivity),
            shift_handler: ShiftHandler::new(speed, sensitivity),
        }
    }

    /// Process the given winit [`winit::event::WindowEvent`].
    /// Returns true if the event has been processed and false otherwise.
    pub fn window_input(&mut self, event: &WindowEvent, scale_factor: f64) -> bool {
        match event {
            WindowEvent::CursorMoved { position, .. } => {
                let position: (f64, f64) = position.to_owned().into();
                let position = Vector2::from(position) / scale_factor;
                self.pan_handler.process_window_position(&position, false);
                self.zoom_handler.process_window_position(&position, false);
                true
            }
            WindowEvent::KeyboardInput {
                event: KeyEvent {
                    state, logical_key, ..
                },
                ..
            } => {
                self.shift_handler.process_key_press(logical_key, *state)
                    || self.zoom_handler.process_key_press(logical_key, *state)
            }
            WindowEvent::Touch(touch) => match touch.phase {
                TouchPhase::Started => {
                    let position: (f64, f64) = touch.location.to_owned().into();
                    self.pan_handler
                        .process_touch_start(&Vector2::from(position));
                    true
                }
                TouchPhase::Ended => {
                    self.pan_handler.process_touch_end();
                    true
                }
                TouchPhase::Moved => {
                    let position: (f64, f64) = touch.location.to_owned().into();
                    let position = Vector2::from(position) / scale_factor;
                    self.pan_handler.process_window_position(&position, true);
                    self.zoom_handler.process_window_position(&position, true);
                    true
                }
                TouchPhase::Cancelled => false,
            },
            WindowEvent::MouseWheel { delta, .. } => {
                self.zoom_handler.process_scroll(delta);
                true
            }
            // Trackpad pinch (macOS); upstream drops these on the floor.
            WindowEvent::PinchGesture { delta, .. } => {
                self.zoom_handler.process_pinch(*delta);
                true
            }
            WindowEvent::MouseInput { button, state, .. } => {
                self.pan_handler.process_mouse_key_press(button, state);
                true
            }
            _ => false,
        }
    }
}

impl UpdateState for InputController {
    fn update_state(&mut self, map_context: &mut MapContext, dt: Duration) {
        self.pan_handler.update_state(map_context, dt);
        self.zoom_handler.update_state(map_context, dt);
        self.shift_handler.update_state(map_context, dt);
    }
}
