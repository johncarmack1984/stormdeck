//! From maplibre-winit rev e2c1c4d (input/zoom_handler.rs), plus
//! `process_pinch` — upstream has no pinch path at all.

use std::time::Duration;

use cgmath::Vector2;
use maplibre::{context::MapContext, coords::Zoom};
use winit::keyboard::Key;

use super::UpdateState;

/// log2 of the pinch scale maps magnification to zoom levels 1:1; boost it
/// so a full two-finger pinch spans a couple of levels, like the web map.
const PINCH_ZOOM_BOOST: f64 = 2.5;

pub struct ZoomHandler {
    window_position: Option<Vector2<f64>>,
    zoom_delta: Option<Zoom>,
    sensitivity: f64,
}

impl UpdateState for ZoomHandler {
    fn update_state(&mut self, MapContext { view_state, .. }: &mut MapContext, _dt: Duration) {
        if let Some(zoom_delta) = self.zoom_delta {
            if let Some(window_position) = self.window_position {
                let current_zoom = view_state.zoom();
                let next_zoom = current_zoom + zoom_delta;

                view_state.update_zoom(next_zoom);
                self.zoom_delta = None;

                let view_proj = view_state.view_projection();
                let inverted_view_proj = view_proj.invert();

                if let Some(cursor_position) = view_state.window_to_world_at_ground(
                    &window_position,
                    &inverted_view_proj,
                    false,
                ) {
                    let scale = current_zoom.scale_delta(&next_zoom);

                    let delta = Vector2::new(cursor_position.x * scale, cursor_position.y * scale)
                        - cursor_position;

                    view_state.camera_mut().move_relative(delta);
                }
            }
        }
    }
}

impl ZoomHandler {
    pub fn new(sensitivity: f64) -> Self {
        Self {
            window_position: None,
            zoom_delta: None,
            sensitivity,
        }
    }

    pub fn process_window_position(
        &mut self,
        window_position: &Vector2<f64>,
        _touch: bool,
    ) -> bool {
        self.window_position = Some(*window_position);
        true
    }

    pub fn update_zoom(&mut self, delta: f64) {
        self.zoom_delta = Some(self.zoom_delta.unwrap_or_default() + Zoom::new(delta));
    }

    pub fn process_scroll(&mut self, delta: &winit::event::MouseScrollDelta) {
        self.update_zoom(
            match delta {
                winit::event::MouseScrollDelta::LineDelta(_horizontal, vertical) => {
                    *vertical as f64
                }
                winit::event::MouseScrollDelta::PixelDelta(winit::dpi::PhysicalPosition {
                    y: scroll,
                    ..
                }) => *scroll / 100.0,
            } * self.sensitivity,
        );
    }

    /// winit reports the relative magnification change per event; zoom is
    /// log2 of scale. Clamped so a wild negative delta can't NaN the camera.
    pub fn process_pinch(&mut self, delta: f64) {
        self.update_zoom((1.0 + delta).max(0.1).log2() * PINCH_ZOOM_BOOST);
    }

    pub fn process_key_press(&mut self, key: &Key, state: winit::event::ElementState) -> bool {
        let amount = if state == winit::event::ElementState::Pressed {
            0.1
        } else {
            0.0
        };

        match key.as_ref() {
            Key::Character("i") | Key::Character("+") => {
                self.update_zoom(amount);
                true
            }
            Key::Character("k") | Key::Character("-") => {
                self.update_zoom(-amount);
                true
            }
            _ => false,
        }
    }
}
