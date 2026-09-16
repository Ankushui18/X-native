//! Phase 2 / 8 / 9 / 10 slices: the headless editing engine.
//!
//! Everything here is UI-independent on purpose: a winit window (Phase 1)
//! will translate mouse/keyboard events into these operations. That means
//! all of it is testable right now, in this sandbox, without a display.
//!
//! - hit testing (transform-aware, z-order-aware, lock/visibility-aware)
//! - Editor: selection + command-based mutations with full undo/redo
//! - move / resize / rotate / set-fill / reorder(z) / group / delete
//! - transformed (rotation-aware) corner resize + world/local mapping
//! - shape builder with overlap validation before any boolean runs
//! - parametric resize: variable-bound sizes and the dependents they sync
//! - align & distribute
//! - snapping (grid + other-object edges)
//! - constraints solver (pins: left/right/center/stretch/scale)
//! - Phase 8: prototype Player (navigate/back state machine)
//! - Phase 9: SpatialGrid index for O(~1) point queries at 100K nodes
//! - Phase 10: named version checkpoints + dev-mode CSS export

pub mod align;
pub mod booleans;
pub mod commands;
pub mod constraints;
pub mod devmode;
pub mod editor_core;
pub mod eraser;
pub mod parametric;
pub mod prototype;
pub mod selection;
pub mod shape_builder;
pub mod snapping;
pub mod spatial;
#[cfg(test)]
mod tests_mod;
pub mod transformed_resize;
pub mod variable_commands;
pub mod vector_edit;
pub mod vector_handles;

pub use align::*;
pub use booleans::{boolean_paths, node_to_path, BoolOp};
pub use commands::*;
pub use constraints::*;
pub use devmode::*;
pub use editor_core::*;
pub use eraser::*;
pub use parametric::*;
pub use prototype::*;
pub use selection::*;
pub use variable_commands::{
    apply_all, apply_variable, clear_active_mode, invert_variable, remove_mode_value,
    remove_variable, rename_variable, set_active_mode, set_alias, set_bool, set_collection,
    set_color, set_exposed, set_mode_value, set_number, set_string, VarValue, VariableCommand,
    VariableHistory,
};
pub use shape_builder::{
    overlap, path_area, validate, OverlapReport, ShapeBuilderIssue, ShapeBuilderOp, AREA_STEPS,
    DEFAULT_MIN_OVERLAP,
};
pub use snapping::*;
pub use spatial::*;
pub use transformed_resize::{
    anchor_norm, corner_at, corner_from_index, corner_index, handle_norm, linear, local_point,
    local_to_world, plan_resize, world_corners, world_point, ResizePlan,
};
pub use vector_edit::{
    anchor_at, anchors, bend_anchor, delete_anchors, move_anchors_by, move_handle_in, reverse_path,
    segment_at, simplify_path, split_path_at, split_segment_at, translate_path, Anchor,
};
pub use vector_handles::{
    anchor_at_world, anchors_of, anchors_world, anchors_world_of, handle_at_world, handles_world,
    local_scale, segment_at_world, AnchorWorld, HandleHit,
};
