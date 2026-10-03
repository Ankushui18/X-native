//! X-Native Board Module
//!
//! Infinite canvas brainstorming and UX mapping capabilities.
//! Separate from Design files - no Auto Layout, Components, or Code Gen.
//! Reuses x-core rendering primitives with board-specific node types.

pub mod connectors;
pub mod document;
pub mod infinite_canvas;
pub mod nodes;
pub mod shapes;
pub mod stickies;
pub mod tools;

// Re-export main types
pub use connectors::{AttachmentPoint, Connector, ConnectorType, NodeId, Side};
pub use document::BoardKind;
pub use document::{BoardDocument, BoardMetadata, BoardPage, BoardSettings};
pub use infinite_canvas::InfiniteCanvas;
pub use nodes::{BoardImage, BoardNode, ConnectorRef, PenPath, TextLabel};
pub use shapes::{BoardShape, ShapeType};
pub use stickies::StickyNote;
pub use tools::BoardTool;
