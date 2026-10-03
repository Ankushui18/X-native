//! Phase 7 slice: the native `.x` document format + SVG export.
//!
//! `.x` v1 is versioned JSON (schema field first, forward-compatible:
//! unknown keys are skipped on load). Written with a purpose-built emitter
//! and read with a purpose-built recursive-descent parser — zero new
//! dependencies, which matters given this crate's pinned dependency tree.
//! A binary (postcard/flatbuffers) format can replace the encoding behind
//! the same save/load API later.

pub mod admission;
pub mod cancellation;
pub use admission::{read_bounded, validate_admission};
pub(crate) mod b64;
pub use b64::base64;
pub mod codegen;
pub mod deserialize;
pub mod figbinary;
pub mod figma;
pub mod import_ir;
pub(crate) mod json;
pub mod kiwi;
pub mod png_import;
pub mod reliability;
pub mod serialize;
pub mod sketch;
pub mod svg_export;
pub mod svg_import;
#[cfg(test)]
mod tests_mod;
pub mod v2;
pub mod xlib;
pub(crate) mod zipfile;

pub use codegen::{node_to_jsx, node_to_tailwind, selection_to_jsx, selection_to_tailwind};
pub use deserialize::*;
pub use figbinary::{import_fig, import_fig_bytes, import_fig_bytes_with_report};
pub use figma::{export_figma_json, import_figma_json};
pub use import_ir::{lower, lower_with_report, ImportDoc, ImportKind, ImportNode, ImportReport};
pub use png_import::import_png;
pub use reliability::*;
pub use serialize::*;
pub use sketch::{export_sketch, import_sketch, import_sketch_with_report};
pub use svg_export::*;
pub use svg_import::*;
pub use v2::{
    list_pages, load_checked, load_page, load_x_any, load_x_lenient, migrate_v1_to_v2, save_x_v2,
    validate, DocumentV2, Issue, Metadata, SCHEMA_VERSION,
};
pub use xlib::{
    library_hash, load_xlib, save_xlib, verify_dependency, verify_document_libraries,
    IntegrityStatus,
};

pub const X_FORMAT_VERSION: u32 = 1;
