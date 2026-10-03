//! x-components — the component system, its own crate.
//!
//! model:  typed overrides, component properties, variants, detach,
//!         dependency graph (was x-core/components.rs)
//! layout: instance resolution + text-measure + auto-layout re-solve
//!         (was x-core/component_layout.rs)
//!
//! Future homes as they grow: definition.rs, instance.rs, overrides.rs,
//! variants.rs, properties.rs, registry.rs, slots.rs, libraries.rs.

pub mod layout;
#[cfg(test)]
mod layout_regression;
pub mod model;

pub use layout::{resolve_instance_layout, sync_instance_sizes, MeasureFn};
pub use model::*;
