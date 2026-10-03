//! Infinite Canvas - pan/zoom without fixed artboards

use glam::Vec2;
use serde::{Deserialize, Serialize};

/// Viewport state for infinite canvas
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfiniteCanvas {
    /// Current zoom level (1.0 = 100%)
    pub zoom: f32,
    /// Pan offset in screen coordinates
    pub pan_offset: Vec2,
    /// Minimum zoom allowed
    pub min_zoom: f32,
    /// Maximum zoom allowed
    pub max_zoom: f32,
}

impl Default for InfiniteCanvas {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            pan_offset: Vec2::ZERO,
            min_zoom: 0.01,
            max_zoom: 50.0,
        }
    }
}

impl InfiniteCanvas {
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply zoom towards a point (mouse position)
    pub fn zoom_towards(&mut self, delta: f32, mouse_pos: Vec2) {
        let old_zoom = self.zoom;
        self.zoom = (self.zoom * (1.0 + delta)).clamp(self.min_zoom, self.max_zoom);

        // Adjust pan to zoom towards mouse position
        let zoom_factor = self.zoom / old_zoom;
        self.pan_offset = mouse_pos - (mouse_pos - self.pan_offset) * zoom_factor;
    }

    /// Pan the canvas
    pub fn pan(&mut self, delta: Vec2) {
        self.pan_offset += delta;
    }

    /// Convert screen coordinates to world coordinates
    pub fn screen_to_world(&self, screen_pos: Vec2) -> Vec2 {
        (screen_pos - self.pan_offset) / self.zoom
    }

    /// Convert world coordinates to screen coordinates
    pub fn world_to_screen(&self, world_pos: Vec2) -> Vec2 {
        world_pos * self.zoom + self.pan_offset
    }

    /// Reset view to default
    pub fn reset(&mut self) {
        self.zoom = 1.0;
        self.pan_offset = Vec2::ZERO;
    }

    /// Fit content to view (calculate appropriate zoom and pan)
    pub fn fit_to_content(&mut self, content_bounds: Option<(Vec2, Vec2)>) {
        if let Some((min, max)) = content_bounds {
            let _content_size = max - min;
            let center = (min + max) * 0.5;

            // Assume viewport size will be provided by renderer
            // For now, just center on content
            self.pan_offset = -center * self.zoom;
        } else {
            self.reset();
        }
    }
}
