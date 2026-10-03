//! x-render — scene encoding for Vello: shapes, gradients, effects,
//! blend layers, image assets, component-instance resolution, stress scenes.

pub mod assets;
pub mod frame_cache;
pub mod gradients;
pub mod image_adjustments;
pub mod ir;
pub mod raster;
pub use raster::{optimize_images, optimize_png};
pub mod scene;
pub mod sinks;
pub mod stress;
#[cfg(test)]
mod tests_mod;
pub mod text_geometry;

pub use assets::*;
pub use frame_cache::{FrameCache, FrameCacheStats};
pub use gradients::{
    angular_gradient_mesh, angular_gradient_params, diamond_gradient_mesh, diamond_gradient_params,
    AngularGradientParams, DiamondGradientParams, Vertex,
};
pub use image_adjustments::ImageAdjustments;
pub use ir::{
    build_render_tree, build_render_tree_of, build_render_tree_slice, render_via_ir, RenderCommand,
    RenderTree, VelloSink,
};
pub use raster::{
    encode_jpg, encode_png, encode_rgba_png, export_raster, export_raster_cancellable,
    RasterFormat, RasterSink,
};
pub use scene::*;
pub use sinks::{export_pdf, export_pdf_full, export_pdf_with_assets, thumbnail_scene, SceneCache};
pub use stress::*;

pub use vello::peniko::Color;
