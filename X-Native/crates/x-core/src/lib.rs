//! x-core — the document model: nodes, geometry, layout, variables,
//! components, styles. No rendering, no editing, no IO.
#![allow(unused_imports)]

extern crate serde;

pub mod analyze;
pub mod assets;
pub mod auto_layout;
pub mod bezier_clip;
pub mod booleans;
pub mod clip;
pub mod components;
pub mod document;
pub mod expression;
pub mod fallbacks;
pub mod geometry;
pub mod grid;
pub mod image_transform;
pub mod layout_types;
pub mod library;
pub mod lint;
pub mod modifier;
pub mod node;
pub mod paint;
pub mod pins;
pub mod plugin;
pub mod prototype;
pub mod query;
pub mod registry;
pub mod smart_animate;
pub mod styles;
pub mod transaction;
pub mod transform;
pub mod variables;
pub mod vector_network;

pub use expression::*;
pub use modifier::*;
pub use plugin::*;
pub use transaction::*;
pub use vector_network::*;

pub use analyze::{
    adoption, adoption_root, analyze as analyze_design, analyze_root as analyze_design_root,
    analyze_with as analyze_design_with, hex_color, Adoption, AnalyzeOptions,
    Tokens as DesignTokens,
};
pub use assets::*;
pub use auto_layout::*;
pub use components::*;
pub use document::*;
pub use geometry::*;
pub use image_transform::*;
pub use layout_types::*;
pub use library::*;
pub use lint::{
    contrast as lint_contrast, lint, lint_node, lint_node_with, lint_with, render as lint_render,
    report_json as lint_report_json, rule_severity, rule_table, rules as lint_rules,
    summary_line as lint_summary, unknown_rules, Finding, LintConfig, Preset as LintPreset,
    RuleInfo, Severity,
};
pub use node::*;
pub use paint::*;
pub use pins::*;
pub use prototype::*;
pub use query::{
    esc_str, find as query_find, find_node, find_under, find_with, found_json, info, locate,
    node_json, subtree_json, tree_lines, FindFilter, Found, InfoStats,
};
pub use registry::*;
pub use styles::*;
pub use transform::*;
pub use variables::*;

pub use std::f64::consts::PI;

// geometry + color live here (audit F12): x-core is the canonical provider
// of kurbo/peniko so pure-model crates never need the vello GPU stack.
pub use kurbo;
pub use peniko;
pub use peniko::Color;

pub mod identity;
pub use identity::{fresh_id, remap_node_ids};
