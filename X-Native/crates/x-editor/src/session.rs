//! Stateful, UI-independent command session over an x-core document.
//!
//! A native host calls this directly; the web host calls the same Rust code
//! through x-wasm. Only the changed node's identity, label, position and size
//! cross the command boundary. A complete document is read at open and produced
//! again only at an explicit save/checkpoint, never on every interaction.

use std::collections::HashSet;

use crate::{find, Editor};
use x_core::booleans::BoolOp;
use x_core::stroke_alignment::aligned_stroke_band;
use x_core::{
    validate_width_profile, Color, Document, Node, NodeKind, Paint, PaintLayer, PathCmd,
    StrokeAlign, StrokeCap, StrokeJoin, StrokeLayer, VariableWidthPoint, MAX_OUTLINE_ANCHORS,
    MAX_OUTLINE_INPUT_COMMANDS,
};

/// The first bounded command slice. Further mutations need their own state
/// delta and equivalence tests before they can be added to the bridge.
#[derive(Debug, Clone, Copy)]
pub enum SessionCommand<'a> {
    Rename {
        id: &'a str,
        name: &'a str,
    },
    Move {
        id: &'a str,
        dx: f64,
        dy: f64,
    },
    /// Absolute rectangle size; validation belongs here, not in a web UI.
    Resize {
        id: &'a str,
        w: f64,
        h: f64,
    },
    /// Atomic two-layer Boolean. Only direct, plain rectangles are admitted
    /// until other shapes have their own command-session proof of parity.
    Boolean {
        first: &'a str,
        second: &'a str,
        op: BoolOp,
    },
    /// Bounded uniform stroke on a direct, plain rectangle. The style and
    /// actual offset contours are owned by Rust; zero width removes it.
    Stroke {
        id: &'a str,
        width: f64,
        color: Color,
        align: StrokeAlign,
        join: StrokeJoin,
    },
    /// Signed inset/outset of one filled layer. The original shape and
    /// resulting vector are one ReplaceNode entry in the Rust undo history.
    Offset {
        id: &'a str,
        distance: f64,
        join: StrokeJoin,
    },
    /// Replace one bounded primitive/vector stroke with its filled outline.
    /// The core path expansion owns variable widths, dashes, caps and joins;
    /// this session command only admits a losslessly projected one-layer slice.
    OutlineStroke {
        id: &'a str,
    },
    Undo,
    Redo,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeDelta {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A bounded per-layer projection for an atomic Boolean edit. The path is a
/// list of NODE-LOCAL, already simplified contour anchors, not a page JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometryNodeDelta {
    pub node: NodeDelta,
    pub index: usize,
    pub fill: String,
    pub visible: bool,
    pub locked: bool,
    /// `None` = rectangle, `Some` = vector (possibly empty).
    pub rings: Option<Vec<Vec<(f64, f64)>>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BooleanDelta {
    pub upsert: Vec<GeometryNodeDelta>,
    pub removed: Vec<String>,
}

/// Local stroke contours and the style that produced them, sent ONLY on an
/// edit/undo/redo. At most two rectangular rings (12 anchors), never a page.
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeDelta {
    pub id: String,
    pub width: f64,
    pub color: String,
    pub align: StrokeAlign,
    pub join: StrokeJoin,
    pub outer: Vec<(f64, f64)>,
    pub inner: Vec<(f64, f64)>,
}

/// One affected layer, not a page. The full *original* path is needed on
/// undo, including its cubic controls; straight result contours stay bounded
/// by x-core's offset anchor budget. Paint, order and flags cannot change.
#[derive(Debug, Clone, PartialEq)]
pub enum OffsetShapeDelta {
    Rect { radius: f64 },
    Ellipse,
    Poly { sides: usize },
    Star { points: usize, ratio: f64 },
    Vector { path: Vec<PathCmd> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct OffsetDelta {
    pub node: NodeDelta,
    pub shape: OffsetShapeDelta,
}

/// Bounded shape projection used exclusively by the Outline Stroke command.
/// It deliberately includes the original primitive forms so undo/redo can
/// update a host view without asking it to retain a second document or history.
#[derive(Debug, Clone, PartialEq)]
pub enum OutlineShapeDelta {
    Rect { radius: f64 },
    Ellipse,
    Line,
    Arc { start: f64, end: f64, ratio: f64 },
    Poly { sides: usize },
    Star { points: usize, ratio: f64 },
    Vector { path: Vec<PathCmd> },
}

/// The one persisted stroke layer admitted at the Outline Stroke boundary.
/// The core owns the actual geometry; this is only sufficient bounded style
/// metadata for a host to restore the pre-outline primitive on undo.
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineStrokeStyle {
    pub width: f64,
    pub color: String,
    pub align: StrokeAlign,
    pub cap_start: StrokeCap,
    pub cap_end: StrokeCap,
    pub join: StrokeJoin,
    pub dash: Vec<f64>,
    pub dash_offset: f64,
    pub miter_limit: f64,
    pub width_profile: Vec<VariableWidthPoint>,
}

/// One node only, never a document. `fill = None` represents the transparent
/// legacy fill used by line centerlines; all admitted opaque paints use a CSS
/// `#rrggbb` string. `stroke = None` is the filled result of Outline Stroke.
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineDelta {
    pub node: NodeDelta,
    pub shape: OutlineShapeDelta,
    pub fill: Option<String>,
    pub stroke: Option<OutlineStrokeStyle>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionDelta {
    /// Increases only after a successful document edit, including undo/redo.
    pub revision: u64,
    /// `None` for a no-op/status read; never a whole-page snapshot.
    pub node: Option<NodeDelta>,
    /// Only structural Boolean edits/undo/redo return this bounded change set.
    pub boolean: Option<BooleanDelta>,
    /// Mutually exclusive with the structural and simple-node projections.
    pub stroke: Option<StrokeDelta>,
    /// The exact shape of just the layer changed by offset/undo/redo.
    pub offset: Option<OffsetDelta>,
    /// One bounded source/result shape for Outline Stroke apply/undo/redo.
    pub outline: Option<OutlineDelta>,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// One-page session for now: declining other shapes is safer than silently
/// dropping pages or pretending that per-page Editor stacks are one history.
/// The page root lives ONLY in Editor; the rest of the document's metadata
/// remains in `document` until an explicit snapshot/export.
pub struct DocumentSession {
    document: Document,
    editor: Editor,
    revision: u64,
}

impl DocumentSession {
    pub fn new(mut document: Document) -> Result<Self, String> {
        if document.pages.len() != 1 {
            return Err("command session requires exactly one page".into());
        }
        let page = document.pages.pop().expect("one page was checked above");
        {
            let mut ids = HashSet::new();
            let mut stack = vec![&page];
            while let Some(node) = stack.pop() {
                if node.id.is_empty() || !ids.insert(node.id.as_str()) {
                    return Err(format!("empty or duplicate node id: {}", node.id));
                }
                stack.extend(node.children.iter());
            }
        }
        Ok(Self {
            document,
            editor: Editor::new(page),
            revision: 0,
        })
    }

    pub fn page_id(&self) -> &str {
        &self.editor.root.id
    }

    /// A single node query is explicit; it does not copy the page to JS.
    pub fn node(&self, id: &str) -> Option<NodeDelta> {
        let node = find(&self.editor.root, id)?;
        Some(NodeDelta {
            id: node.id.clone(),
            name: node.name.clone(),
            x: node.transform.x,
            y: node.transform.y,
            w: node.w,
            h: node.h,
        })
    }

    pub fn state(&self) -> SessionDelta {
        SessionDelta {
            revision: self.revision,
            node: None,
            boolean: None,
            stroke: None,
            offset: None,
            outline: None,
            can_undo: self.editor.undo_depth() > 0,
            can_redo: self.editor.next_redo_node().is_some()
                || self.editor.next_redo_boolean().is_some(),
        }
    }

    fn target(&self, id: &str) -> Result<&Node, String> {
        if id == self.page_id() {
            return Err("page root is not a layer command target".into());
        }
        find(&self.editor.root, id).ok_or_else(|| format!("node not found: {id}"))
    }

    fn boolean_operand(&self, id: &str) -> Result<(), String> {
        let node = self.target(id)?;
        if !self.editor.root.children.iter().any(|child| child.id == id)
            || !matches!(&node.kind, NodeKind::Rect { radius } if *radius == 0.0)
            || !node.children.is_empty()
            || id.len() > 256
            || node.name.len() > 1024
            || !node.visible
            || node.locked
            || node.opacity != 1.0
            || node.stroke.width != 0.0
            || !node.fill_layers.is_empty()
            || !node.stroke_layers.is_empty()
            || !node.effects.is_empty()
            || !node.effect_layers.is_empty()
            || node.corner_radii.is_some()
            || node.corner_smoothing != 0.0
            || node.transform.rotation != 0.0
            || node.transform.scale_x != 1.0
            || node.transform.scale_y != 1.0
            || node.transform.skew_x != 0.0
            || node.transform.skew_y != 0.0
            || ![node.transform.x, node.transform.y, node.w, node.h]
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 1e9)
            || node.w <= 0.0
            || node.h <= 0.0
            || !matches!(&node.fill, Paint::Solid(color) if color.to_rgba8().a == 255)
        {
            return Err(
                "Boolean session admits only plain visible, unlocked solid rectangles".into(),
            );
        }
        Ok(())
    }

    fn stroke_operand(&self, id: &str) -> Result<(), String> {
        let node = self.target(id)?;
        if !self.editor.root.children.iter().any(|child| child.id == id)
            || !matches!(&node.kind, NodeKind::Rect { radius } if *radius == 0.0)
            || !node.children.is_empty()
            || id.len() > 256
            || node.name.len() > 1024
            || !node.visible
            || node.locked
            || node.opacity != 1.0
            || node.transform.rotation != 0.0
            || node.transform.scale_x != 1.0
            || node.transform.scale_y != 1.0
            || node.transform.skew_x != 0.0
            || node.transform.skew_y != 0.0
            || node.corner_radii.is_some()
            || node.corner_smoothing != 0.0
            || !node.effects.is_empty()
            || !node.effect_layers.is_empty()
            || ![node.transform.x, node.transform.y, node.w, node.h]
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 1e9)
            || node.w <= 0.0
            || node.h <= 0.0
            || !matches!(&node.fill, Paint::Solid(c) if c.to_rgba8().a == 255)
        {
            return Err("stroke session admits only direct, plain opaque rectangles".into());
        }
        if node.stroke.width == 0.0
            && !node.visual_stacks_materialized
            && node.fill_layers.is_empty()
            && node.stroke_layers.is_empty()
        {
            return Ok(());
        }
        // Accept only a style produced by this same command. Native inputs
        // with gradient/multiple layers, dashes, effects or modified options
        // must not be flattened to a single rectangle stroke on update.
        let Some(layer) = node.stroke_layers.first() else {
            return Err("unsupported stroke stack".into());
        };
        let mut expected = StrokeLayer::new(node.stroke.clone());
        expected.options.align = layer.options.align;
        expected.options.join = layer.options.join;
        if !node.visual_stacks_materialized
            || node.fill_layers.len() != 1
            || node.fill_layers[0] != PaintLayer::new(node.fill.clone())
            || node.stroke_layers.len() != 1
            || node.stroke_layers[0] != expected
            || layer.options.join == StrokeJoin::Round
            || !(0.0 < node.stroke.width && node.stroke.width <= 2048.0)
            || !matches!(&node.stroke.paint, Paint::Solid(c) if c.to_rgba8().a == 255)
        {
            return Err("unsupported stroke stack".into());
        }
        Ok(())
    }

    fn offset_operand(&self, id: &str) -> Result<(), String> {
        let node = self.target(id)?;
        let shape = match &node.kind {
            NodeKind::Rect { radius } => {
                radius.is_finite() && *radius >= 0.0 && *radius <= node.w.min(node.h) / 2.0
            }
            NodeKind::Ellipse => true,
            NodeKind::Poly { sides } => (3..=256).contains(sides),
            NodeKind::Star { points, ratio } => {
                (3..=256).contains(points) && ratio.is_finite() && *ratio > 0.0 && *ratio < 1.0
            }
            NodeKind::Vector { path } => path.len() <= x_core::offset_path::MAX_OFFSET_ANCHORS,
            _ => false,
        };
        if !self.editor.root.children.iter().any(|child| child.id == id)
            || !shape
            || !node.children.is_empty()
            || id.len() > 256
            || node.name.len() > 1024
            || !node.visible
            || node.locked
            || node.opacity != 1.0
            || node.transform.rotation != 0.0
            || node.transform.scale_x != 1.0
            || node.transform.scale_y != 1.0
            || node.transform.skew_x != 0.0
            || node.transform.skew_y != 0.0
            || node.corner_radii.is_some()
            || node.corner_smoothing != 0.0
            || node.stroke.width != 0.0
            || !node.fill_layers.is_empty()
            || !node.stroke_layers.is_empty()
            || !node.effects.is_empty()
            || !node.effect_layers.is_empty()
            || ![node.transform.x, node.transform.y, node.w, node.h]
                .iter()
                .all(|v| v.is_finite() && v.abs() <= 1e9)
            || node.w <= 0.0
            || node.h <= 0.0
            || !matches!(&node.fill, Paint::Solid(c) if c.to_rgba8().a == 255)
        {
            return Err("offset session admits only direct, plain filled shapes".into());
        }
        Ok(())
    }

    /// Read one offset operand as a bounded, lossless shape projection. This
    /// is used for web equivalence checks without retaining a JS document.
    pub fn offset_shape(&self, id: &str) -> Result<OffsetDelta, String> {
        self.offset_operand(id)?;
        self.offset_node(id)
    }

    /// Check the candidate before changing Rust history. The opt-in Web host
    /// compares this one-layer projection to the independent TS geometry
    /// oracle and can decline without having to undo a rejected edit.
    pub fn preview_offset(
        &self,
        id: &str,
        distance: f64,
        join: StrokeJoin,
    ) -> Result<Option<OffsetDelta>, String> {
        self.offset_operand(id)?;
        self.editor
            .preview_filled_offset(id, distance, join)
            .map_err(str::to_string)?
            .map(|node| Self::offset_projection(&node))
            .transpose()
    }

    fn offset_node(&self, id: &str) -> Result<OffsetDelta, String> {
        Self::offset_projection(self.target(id)?)
    }

    fn offset_projection(node: &Node) -> Result<OffsetDelta, String> {
        // On undo the original may have nonzero curvature. Send PathCmds,
        // not a lossy approximation made from the offset's straight rings.
        let shape = match &node.kind {
            NodeKind::Rect { radius } => OffsetShapeDelta::Rect { radius: *radius },
            NodeKind::Ellipse => OffsetShapeDelta::Ellipse,
            NodeKind::Poly { sides } => OffsetShapeDelta::Poly { sides: *sides },
            NodeKind::Star { points, ratio } => OffsetShapeDelta::Star {
                points: *points,
                ratio: *ratio,
            },
            NodeKind::Vector { path }
                if path.len() <= x_core::offset_path::MAX_OFFSET_ANCHORS + 128 =>
            {
                OffsetShapeDelta::Vector { path: path.clone() }
            }
            _ => return Err("offset delta exceeds the path budget".into()),
        };
        Ok(OffsetDelta {
            node: NodeDelta {
                id: node.id.clone(),
                name: node.name.clone(),
                x: node.transform.x,
                y: node.transform.y,
                w: node.w,
                h: node.h,
            },
            shape,
        })
    }

    /// Admit the intentionally small session dialect before asking the editor
    /// to mutate its real command log. The native editor supports richer
    /// paints/transforms/nesting; this bridge refuses them until a host can
    /// project every property losslessly instead of flattening it on undo.
    fn outline_operand(&self, id: &str) -> Result<(), String> {
        let node = self.target(id)?;
        if !self.editor.root.children.iter().any(|child| child.id == id) {
            return Err("outline session requires a direct page child".into());
        }
        let projected = Self::outline_projection(node)?;
        let style = projected
            .stroke
            .as_ref()
            .ok_or("outline session requires one visible stroke layer")?;
        let source = x_core::booleans::node_to_path(node)
            .ok_or("outline session node has no supported centerline")?;
        if source.len() > MAX_OUTLINE_INPUT_COMMANDS {
            return Err("outline source path exceeds the command budget".into());
        }
        validate_width_profile(&style.width_profile)
            .map_err(|error| format!("outline width profile is invalid: {error}"))?;
        // Preflight through the same pure implementation. `outline_stroke_node`
        // will run it again while constructing the history command, but doing
        // it here guarantees a rejected bridge call never reaches history.
        let layer = node
            .active_strokes()
            .into_iter()
            .next()
            .ok_or("outline session requires one visible stroke layer")?;
        let outline = x_core::outline_stroke_path(&source, layer.stroke.width, &layer.options)
            .map_err(|error| format!("outline stroke cannot be materialized: {error}"))?;
        let anchors = outline
            .path
            .iter()
            .filter(|command| matches!(command, PathCmd::MoveTo(..) | PathCmd::LineTo(..)))
            .count();
        let output_w = outline.bounds.width().max(1.0);
        let output_h = outline.bounds.height().max(1.0);
        let output_x = node.transform.x + outline.bounds.min_x;
        let output_y = node.transform.y + outline.bounds.min_y;
        if outline.path.len() > OUTLINE_SESSION_MAX_PATH_COMMANDS
            || anchors > MAX_OUTLINE_ANCHORS
            || !outline.path.iter().all(path_command_is_session_safe)
            || ![output_x, output_y, output_w, output_h]
                .iter()
                .all(|value| value.is_finite() && value.abs() <= OUTLINE_SESSION_COORD_LIMIT)
        {
            return Err("outline result exceeds the session projection budget".into());
        }
        Ok(())
    }

    fn outline_node(&self, id: &str) -> Result<OutlineDelta, String> {
        Self::outline_projection(self.target(id)?)
    }

    fn outline_projection(node: &Node) -> Result<OutlineDelta, String> {
        let finite = |value: f64| value.is_finite() && value.abs() <= OUTLINE_SESSION_COORD_LIMIT;
        if node.id.is_empty()
            || node.id.len() > 256
            || node.name.len() > 1024
            || !node.children.is_empty()
            || !node.visible
            || node.locked
            || node.opacity != 1.0
            || !node.effects.is_empty()
            || !node.effect_layers.is_empty()
            || node.corner_radii.is_some()
            || node.corner_smoothing != 0.0
            || node.transform.rotation != 0.0
            || node.transform.scale_x != 1.0
            || node.transform.scale_y != 1.0
            || node.transform.skew_x != 0.0
            || node.transform.skew_y != 0.0
            || node.transform.origin_x != 0.5
            || node.transform.origin_y != 0.5
            || ![node.transform.x, node.transform.y, node.w, node.h]
                .iter()
                .all(|value| finite(*value))
            || node.w <= 0.0
            || node.h <= 0.0
        {
            return Err("outline session admits only direct, plain opaque layers".into());
        }

        let shape = match &node.kind {
            NodeKind::Rect { radius }
                if radius.is_finite() && *radius >= 0.0 && *radius <= node.w.min(node.h) / 2.0 =>
            {
                OutlineShapeDelta::Rect { radius: *radius }
            }
            NodeKind::Ellipse => OutlineShapeDelta::Ellipse,
            NodeKind::Line => OutlineShapeDelta::Line,
            NodeKind::Arc { start, end, ratio }
                if [*start, *end, *ratio].iter().all(|value| finite(*value))
                    && (0.0..=1.0).contains(ratio) =>
            {
                OutlineShapeDelta::Arc {
                    start: *start,
                    end: *end,
                    ratio: *ratio,
                }
            }
            NodeKind::Poly { sides } if (3..=256).contains(sides) => {
                OutlineShapeDelta::Poly { sides: *sides }
            }
            NodeKind::Star { points, ratio }
                if (3..=256).contains(points)
                    && ratio.is_finite()
                    && (0.05..=0.95).contains(ratio) =>
            {
                OutlineShapeDelta::Star {
                    points: *points,
                    ratio: *ratio,
                }
            }
            NodeKind::Vector { path }
                if path.len() <= OUTLINE_SESSION_MAX_PATH_COMMANDS
                    && path.iter().all(path_command_is_session_safe) =>
            {
                OutlineShapeDelta::Vector { path: path.clone() }
            }
            _ => return Err("outline session does not support this shape".into()),
        };

        let fill = outline_paint_color(&node.fill)?;
        let strokes = node.active_strokes();
        if strokes.len() > 1 {
            return Err("outline session permits exactly one stroke layer".into());
        }
        let stroke = strokes.first().map(outline_stroke_style).transpose()?;

        if node.visual_stacks_materialized {
            if node.fill_layers.len() != 1
                || node.fill_layers[0] != PaintLayer::new(node.fill.clone())
                || node.stroke_layers.len() != (if stroke.is_some() { 1 } else { 0 })
            {
                return Err("outline session requires canonical one-layer paint stacks".into());
            }
            if let Some(layer) = node.stroke_layers.first() {
                if node.stroke != layer.stroke
                    || !layer.visible
                    || layer.opacity != 1.0
                    || layer.blend != x_core::BlendKind::Normal
                {
                    return Err("outline session requires an opaque normal stroke layer".into());
                }
            }
        } else if !node.fill_layers.is_empty() || !node.stroke_layers.is_empty() {
            return Err("outline session requires canonical legacy paint stacks".into());
        }

        Ok(OutlineDelta {
            node: NodeDelta {
                id: node.id.clone(),
                name: node.name.clone(),
                x: node.transform.x,
                y: node.transform.y,
                w: node.w,
                h: node.h,
            },
            shape,
            fill,
            stroke,
        })
    }

    fn stroke_node(&self, id: &str) -> Result<StrokeDelta, String> {
        let node = self.target(id)?;
        self.stroke_operand(id)?;
        let width = node.stroke.width;
        let (align, join) = node
            .stroke_layers
            .first()
            .map(|l| (l.options.align, l.options.join))
            .unwrap_or((StrokeAlign::Center, StrokeJoin::Miter));
        let color = match &node.stroke.paint {
            Paint::Solid(c) => {
                let rgba = c.to_rgba8();
                format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b)
            }
            _ => return Err("stroke delta requires a solid color".into()),
        };
        let band = if width > 0.0 {
            let corners = [(0.0, 0.0), (node.w, 0.0), (node.w, node.h), (0.0, node.h)];
            aligned_stroke_band(&corners, width, align, join, 4.0).map_err(str::to_string)?
        } else {
            x_core::stroke_alignment::AlignedStrokeBand {
                outer: vec![],
                inner: vec![],
            }
        };
        Ok(StrokeDelta {
            id: id.into(),
            width,
            color,
            align,
            join,
            outer: band.outer,
            inner: band.inner,
        })
    }

    fn geometry_node(&self, id: &str) -> Result<GeometryNodeDelta, String> {
        let node = self.target(id)?;
        let index = self
            .editor
            .root
            .children
            .iter()
            .position(|n| n.id == id)
            .ok_or("Boolean delta target is not a page child")?;
        let Paint::Solid(color) = &node.fill else {
            return Err("Boolean delta requires a solid fill".into());
        };
        let rgba = color.to_rgba8();
        let rings = match &node.kind {
            NodeKind::Rect { radius } if *radius == 0.0 => None,
            NodeKind::Vector { path } => {
                let mut rings = Vec::new();
                let mut ring = Vec::new();
                for cmd in path {
                    match *cmd {
                        PathCmd::MoveTo(x, y) => {
                            if !ring.is_empty() {
                                return Err("unclosed Boolean path".into());
                            }
                            ring.push((x, y));
                        }
                        PathCmd::LineTo(x, y) => ring.push((x, y)),
                        PathCmd::Close => {
                            if ring.len() < 3 {
                                return Err("degenerate Boolean contour".into());
                            }
                            rings.push(std::mem::take(&mut ring));
                        }
                        PathCmd::CurveTo(..) => return Err("unexpected Boolean curve".into()),
                    }
                }
                if !ring.is_empty() {
                    return Err("unclosed Boolean path".into());
                }
                Some(rings)
            }
            _ => return Err("unsupported Boolean delta layer".into()),
        };
        Ok(GeometryNodeDelta {
            node: self.node(id).ok_or("Boolean node missing")?,
            index,
            fill: format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b),
            visible: node.visible,
            locked: node.locked,
            rings,
        })
    }

    pub fn dispatch(&mut self, command: SessionCommand<'_>) -> Result<SessionDelta, String> {
        // One structural edit can change three node identities. The editor's
        // command stack remains the only history; this is just a delta hint.
        let mut boolean: Option<([String; 2], String, bool)> = None;
        let mut stroke_id: Option<String> = None;
        let mut stroke_only = false;
        let mut offset_id: Option<String> = None;
        let mut outline_id: Option<String> = None;
        let changed = match command {
            SessionCommand::Rename { id, name } => {
                self.target(id)?;
                self.editor.rename_node(id, name).then(|| id.to_string())
            }
            SessionCommand::Move { id, dx, dy } => {
                if !dx.is_finite() || !dy.is_finite() {
                    return Err("move delta must be finite".into());
                }
                let node = self.target(id)?;
                let next_x = node.transform.x + dx;
                let next_y = node.transform.y + dy;
                if !next_x.is_finite() || !next_y.is_finite() {
                    return Err("move would overflow the node position".into());
                }
                if next_x == node.transform.x && next_y == node.transform.y {
                    None
                } else {
                    let before = self.editor.undo_depth();
                    self.editor.move_node(id, dx, dy);
                    (self.editor.undo_depth() > before).then(|| id.to_string())
                }
            }
            SessionCommand::Resize { id, w, h } => {
                // Editor::resize clamps dimensions below one; refuse instead of
                // silently reporting a different size. This is the SAME Rust
                // undo command used by native, not a web-side resize history.
                if !w.is_finite() || !h.is_finite() || w < 1.0 || h < 1.0 {
                    return Err("resize dimensions must be finite and at least one".into());
                }
                let node = self.target(id)?;
                if matches!(&node.kind, NodeKind::Vector { .. }) {
                    return Err("resizing Boolean vectors needs a proved contour transform".into());
                }
                if node.w == w && node.h == h {
                    None
                } else {
                    let styled = node.stroke.width > 0.0;
                    if styled {
                        self.stroke_operand(id)?;
                        let options = &node.stroke_layers[0].options;
                        let corners = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)];
                        aligned_stroke_band(
                            &corners,
                            node.stroke.width,
                            options.align,
                            options.join,
                            4.0,
                        )
                        .map_err(str::to_string)?;
                    }
                    let before = self.editor.undo_depth();
                    self.editor.resize(id, w, h);
                    if self.editor.undo_depth() > before {
                        if styled {
                            stroke_id = Some(id.to_string());
                        }
                        Some(id.to_string())
                    } else {
                        None
                    }
                }
            }
            SessionCommand::Boolean { first, second, op } => {
                if first == second {
                    return Err("Boolean operands must be distinct".into());
                }
                self.boolean_operand(first)?;
                self.boolean_operand(second)?;
                let previous = std::mem::replace(
                    &mut self.editor.selection,
                    vec![first.to_string(), second.to_string()],
                );
                let result = self.editor.boolean_web_selected(op);
                if result.is_err() {
                    self.editor.selection = previous;
                }
                let result = result.map_err(str::to_string)?;
                boolean = Some(([first.to_string(), second.to_string()], result, true));
                None
            }
            SessionCommand::Stroke {
                id,
                width,
                color,
                align,
                join,
            } => {
                self.stroke_operand(id)?;
                if self
                    .editor
                    .set_aligned_rect_stroke(id, width, color, align, join)
                    .map_err(str::to_string)?
                {
                    stroke_id = Some(id.to_string());
                }
                None
            }
            SessionCommand::Offset { id, distance, join } => {
                self.offset_operand(id)?;
                if self
                    .editor
                    .offset_filled_node(id, distance, join)
                    .map_err(str::to_string)?
                {
                    offset_id = Some(id.to_string());
                }
                None
            }
            SessionCommand::OutlineStroke { id } => {
                self.outline_operand(id)?;
                let before = self.editor.undo_depth();
                if self.editor.outline_stroke_node(id).is_some()
                    && self.editor.undo_depth() > before
                {
                    outline_id = Some(id.to_string());
                }
                None
            }
            SessionCommand::Undo => {
                let id = self.editor.next_undo_node().map(str::to_string);
                let structural = self.editor.next_undo_boolean();
                let outline = self.editor.next_undo_outline().map(str::to_string);
                let is_outline = outline.is_some();
                let style = if !is_outline {
                    self.editor.next_undo_stroke().map(str::to_string)
                } else {
                    None
                };
                let offset = if !is_outline {
                    self.editor.next_undo_offset().map(str::to_string)
                } else {
                    None
                };
                let previous_size = id.as_ref().and_then(|id| self.node(id)).map(|n| (n.w, n.h));
                if self.editor.undo() {
                    boolean = structural.map(|(ids, result)| (ids, result, false));
                    outline_id = outline;
                    stroke_only = style.is_some();
                    offset_id = offset;
                    stroke_id = if is_outline {
                        None
                    } else {
                        style.or_else(|| {
                            id.as_ref().and_then(|id| {
                                let node = self.target(id).ok()?;
                                (previous_size != Some((node.w, node.h)) && node.stroke.width > 0.0)
                                    .then(|| id.clone())
                            })
                        })
                    };
                    id
                } else {
                    None
                }
            }
            SessionCommand::Redo => {
                let id = self.editor.next_redo_node().map(str::to_string);
                let structural = self.editor.next_redo_boolean();
                let outline = self.editor.next_redo_outline().map(str::to_string);
                let is_outline = outline.is_some();
                let style = if !is_outline {
                    self.editor.next_redo_stroke().map(str::to_string)
                } else {
                    None
                };
                let offset = if !is_outline {
                    self.editor.next_redo_offset().map(str::to_string)
                } else {
                    None
                };
                let previous_size = id.as_ref().and_then(|id| self.node(id)).map(|n| (n.w, n.h));
                if self.editor.redo() {
                    boolean = structural.map(|(ids, result)| (ids, result, true));
                    outline_id = outline;
                    stroke_only = style.is_some();
                    offset_id = offset;
                    stroke_id = if is_outline {
                        None
                    } else {
                        style.or_else(|| {
                            id.as_ref().and_then(|id| {
                                let node = self.target(id).ok()?;
                                (previous_size != Some((node.w, node.h)) && node.stroke.width > 0.0)
                                    .then(|| id.clone())
                            })
                        })
                    };
                    id
                } else {
                    None
                }
            }
        };
        if let Some((sources, result, applied)) = &boolean {
            self.editor.selection = if *applied {
                vec![result.clone()]
            } else {
                sources.to_vec()
            };
        }
        if changed.is_some()
            || boolean.is_some()
            || stroke_id.is_some()
            || offset_id.is_some()
            || outline_id.is_some()
        {
            self.revision += 1;
        }
        let mut delta = self.state();
        // A shape or stroke edit needs only its affected-layer projection,
        // not a second copy of the label/bounds and never a whole document.
        delta.node = if stroke_only || offset_id.is_some() || outline_id.is_some() {
            None
        } else {
            changed.and_then(|id| self.node(&id))
        };
        delta.stroke = stroke_id.map(|id| self.stroke_node(&id)).transpose()?;
        delta.offset = offset_id.map(|id| self.offset_node(&id)).transpose()?;
        delta.outline = outline_id.map(|id| self.outline_node(&id)).transpose()?;
        if let Some((sources, result, applied)) = boolean {
            delta.boolean = Some(if applied {
                BooleanDelta {
                    upsert: vec![self.geometry_node(&result)?],
                    removed: sources.into_iter().collect(),
                }
            } else {
                BooleanDelta {
                    upsert: sources
                        .iter()
                        .map(|id| self.geometry_node(id))
                        .collect::<Result<_, _>>()?,
                    removed: vec![result],
                }
            });
        }
        Ok(delta)
    }

    /// Explicit, potentially large save/checkpoint path. Never call this from
    /// a paint loop or to acknowledge a command.
    pub fn snapshot(&self) -> Document {
        let mut document = self.document.clone();
        document.pages.push(self.editor.root.clone());
        document
    }

    /// Native hosts can also take ownership at close without cloning the tree.
    pub fn into_document(self) -> Document {
        let Self {
            mut document,
            editor,
            ..
        } = self;
        document.pages.push(editor.root);
        document
    }
}

/// The web session accepts core's one-billion-unit centerline dialect plus
/// its largest legal miter/cap expansion, while still refusing an unbounded
/// vector payload at the bridge boundary.
const OUTLINE_SESSION_COORD_LIMIT: f64 = 1_100_000_000.0;
/// A filled contour needs at least three anchors. `outline_stroke_path` caps
/// anchors at `MAX_OUTLINE_ANCHORS`, so this is the largest possible number of
/// anchors plus `Close` commands (without accepting a larger hostile JSON path).
const OUTLINE_SESSION_MAX_PATH_COMMANDS: usize =
    MAX_OUTLINE_ANCHORS + (MAX_OUTLINE_ANCHORS + 2) / 3;

fn path_command_is_session_safe(command: &PathCmd) -> bool {
    let finite = |value: f64| value.is_finite() && value.abs() <= OUTLINE_SESSION_COORD_LIMIT;
    match *command {
        PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => finite(x) && finite(y),
        PathCmd::CurveTo(a, b, c, d, x, y) => [a, b, c, d, x, y].iter().all(|value| finite(*value)),
        PathCmd::Close => true,
    }
}

fn outline_paint_color(paint: &Paint) -> Result<Option<String>, String> {
    let Paint::Solid(color) = paint else {
        return Err("outline session admits solid paints only".into());
    };
    let rgba = color.to_rgba8();
    match rgba.a {
        0 => Ok(None),
        255 => Ok(Some(format!("#{:02x}{:02x}{:02x}", rgba.r, rgba.g, rgba.b))),
        _ => Err("outline session admits fully opaque or transparent paints only".into()),
    }
}

fn outline_stroke_style(layer: &StrokeLayer) -> Result<OutlineStrokeStyle, String> {
    if !layer.stroke.width.is_finite() || layer.stroke.width <= 0.0 {
        return Err("outline session stroke width is invalid".into());
    }
    if layer.opacity != 1.0 || !layer.visible || layer.blend != x_core::BlendKind::Normal {
        return Err("outline session requires an opaque normal stroke layer".into());
    }
    let color = outline_paint_color(&layer.stroke.paint)?
        .ok_or("outline session stroke paint must be opaque")?;
    validate_width_profile(&layer.options.width_profile)
        .map_err(|error| format!("outline width profile is invalid: {error}"))?;
    Ok(OutlineStrokeStyle {
        width: layer.stroke.width,
        color,
        align: layer.options.align,
        cap_start: layer.options.cap_start,
        cap_end: layer.options.cap_end,
        join: layer.options.join,
        dash: layer.options.dash.clone(),
        dash_offset: layer.options.dash_offset,
        miter_limit: layer.options.miter_limit,
        width_profile: layer.options.width_profile.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use x_core::{Color, Node};

    fn sample() -> Document {
        Document {
            default_font: Some("Sample font".into()),
            pages: vec![Node::frame("page", 400.0, 300.0).child(Node::rect(
                "box",
                10.0,
                20.0,
                30.0,
                40.0,
                Color::BLACK,
            ))],
            ..Default::default()
        }
    }

    #[test]
    fn rename_move_and_undo_redo_return_only_changed_node() {
        let mut session = DocumentSession::new(sample()).unwrap();
        assert_eq!(session.page_id(), "page");
        assert_eq!(session.state().revision, 0);
        let before = session.node("box").unwrap();
        assert_eq!((before.x, before.y), (10.0, 20.0));

        let renamed = session
            .dispatch(SessionCommand::Rename {
                id: "box",
                name: "  New name  ",
            })
            .unwrap();
        assert_eq!(renamed.revision, 1);
        assert_eq!(renamed.node.as_ref().unwrap().name, "New name");
        assert!(renamed.can_undo);
        assert!(!renamed.can_redo);
        let moved = session
            .dispatch(SessionCommand::Move {
                id: "box",
                dx: -3.0,
                dy: 4.0,
            })
            .unwrap();
        assert_eq!(moved.revision, 2);
        let moved_node = moved.node.unwrap();
        assert_eq!((moved_node.x, moved_node.y), (7.0, 24.0));

        let undone = session.dispatch(SessionCommand::Undo).unwrap();
        assert_eq!(undone.revision, 3);
        assert!(undone.can_redo);
        let undone_node = undone.node.unwrap();
        assert_eq!((undone_node.x, undone_node.y), (10.0, 20.0));
        let undone = session.dispatch(SessionCommand::Undo).unwrap();
        assert_eq!(undone.node.unwrap().name, before.name);
        let redone = session.dispatch(SessionCommand::Redo).unwrap();
        assert_eq!(redone.node.unwrap().name, "New name");
        assert_eq!(redone.revision, 5);
        assert_eq!(session.node("box").unwrap().id, "box");
        let doc = session.into_document();
        assert_eq!(doc.default_font.as_deref(), Some("Sample font"));
        assert_eq!(doc.pages[0].children[0].name, "New name");
        assert_eq!(doc.pages[0].children[0].transform.x, 10.0);
    }

    #[test]
    fn resize_is_shared_rust_history_with_one_node_delta() {
        let mut session = DocumentSession::new(sample()).unwrap();
        let original = session.node("box").unwrap();
        assert_eq!((original.w, original.h), (30.0, 40.0));
        let resized = session
            .dispatch(SessionCommand::Resize {
                id: "box",
                w: 75.25,
                h: 42.5,
            })
            .unwrap();
        assert_eq!(resized.revision, 1);
        assert!(resized.can_undo);
        let node = resized.node.unwrap();
        assert_eq!((node.id.as_str(), node.w, node.h), ("box", 75.25, 42.5));
        let undone = session.dispatch(SessionCommand::Undo).unwrap();
        let undone_node = undone.node.as_ref().unwrap();
        assert_eq!((undone_node.w, undone_node.h), (30.0, 40.0));
        assert_eq!(undone.revision, 2);
        assert!(undone.can_redo);
        let redone = session.dispatch(SessionCommand::Redo).unwrap();
        let redone_node = redone.node.as_ref().unwrap();
        assert_eq!((redone_node.w, redone_node.h), (75.25, 42.5));
        assert_eq!(redone.revision, 3);
        assert!(redone.can_undo);
        assert_eq!(session.snapshot().pages[0].children[0].w, 75.25);
    }

    #[test]
    fn web_booleans_are_atomic_rust_commands_with_only_changed_layer_deltas() {
        for (op, loop_sizes) in [
            (BoolOp::Union, vec![11]),
            (BoolOp::Subtract, vec![8]),
            (BoolOp::Intersect, vec![5]),
            (BoolOp::Exclude, vec![8, 8]),
        ] {
            let document = Document {
                pages: vec![Node::frame("page", 400.0, 300.0)
                    .child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
                    .child(Node::rect("middle", 40.0, 40.0, 10.0, 10.0, Color::BLACK))
                    .child(Node::rect("b", 5.0, 5.0, 10.0, 10.0, Color::BLACK))],
                ..Default::default()
            };
            let mut session = DocumentSession::new(document).unwrap();
            let changed = session
                .dispatch(SessionCommand::Boolean {
                    first: "a",
                    second: "b",
                    op,
                })
                .unwrap();
            assert_eq!(changed.revision, 1);
            assert!(changed.node.is_none());
            assert!(changed.can_undo);
            let patch = changed.boolean.unwrap();
            assert_eq!(patch.removed, vec!["a", "b"]);
            assert_eq!(patch.upsert.len(), 1);
            let result = &patch.upsert[0];
            assert_eq!(result.index, 0);
            assert_eq!(result.fill, "#000000");
            assert_eq!(
                result
                    .rings
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(Vec::len)
                    .collect::<Vec<_>>(),
                loop_sizes
            );
            let result_id = result.node.id.clone();
            let saved = session.snapshot();
            assert_eq!(saved.pages[0].children.len(), 2);
            assert_eq!(saved.pages[0].children[0].id, result_id);
            assert_eq!(saved.pages[0].children[1].id, "middle");
            assert_eq!(session.editor.undo_depth(), 1);

            let undo = session.dispatch(SessionCommand::Undo).unwrap();
            assert!(undo.can_redo);
            let undo_patch = undo.boolean.unwrap();
            assert_eq!(undo_patch.removed, vec![result_id.as_str()]);
            assert_eq!(
                undo_patch
                    .upsert
                    .iter()
                    .map(|n| n.index)
                    .collect::<Vec<_>>(),
                [0, 2]
            );
            assert!(undo_patch.upsert.iter().all(|n| n.rings.is_none()));
            assert_eq!(
                session.snapshot().pages[0]
                    .children
                    .iter()
                    .map(|n| n.id.as_str())
                    .collect::<Vec<_>>(),
                ["a", "middle", "b"]
            );
            let redo = session.dispatch(SessionCommand::Redo).unwrap();
            assert_eq!(redo.boolean.unwrap().upsert[0].node.id, result_id);
            assert_eq!(session.state().revision, 3);
        }
    }

    #[test]
    fn empty_intersection_still_commits_an_undoable_empty_vector() {
        let doc = Document {
            pages: vec![Node::frame("page", 600.0, 300.0)
                .child(Node::rect("a", 0.0, 0.0, 10.0, 10.0, Color::BLACK))
                .child(Node::rect("b", 500.0, 0.0, 10.0, 10.0, Color::BLACK))],
            ..Default::default()
        };
        let mut session = DocumentSession::new(doc).unwrap();
        let result = session
            .dispatch(SessionCommand::Boolean {
                first: "a",
                second: "b",
                op: BoolOp::Intersect,
            })
            .unwrap();
        assert!(result.boolean.unwrap().upsert[0]
            .rings
            .as_ref()
            .unwrap()
            .is_empty());
        assert_eq!(session.snapshot().pages[0].children.len(), 1);
        assert_eq!(
            session
                .dispatch(SessionCommand::Undo)
                .unwrap()
                .boolean
                .unwrap()
                .upsert
                .len(),
            2
        );
        assert_eq!(session.snapshot().pages[0].children.len(), 2);
    }

    #[test]
    fn refused_boolean_keeps_both_nodes_and_history_unchanged() {
        let mut doc = sample();
        doc.pages[0]
            .children
            .push(Node::rect("b", 12.0, 20.0, 20.0, 20.0, Color::BLACK));
        let mut session = DocumentSession::new(doc).unwrap();
        for (a, b) in [("box", "box"), ("box", "missing"), ("page", "b")] {
            assert!(session
                .dispatch(SessionCommand::Boolean {
                    first: a,
                    second: b,
                    op: BoolOp::Union,
                })
                .is_err());
        }
        session.editor.root.children[1].locked = true;
        assert!(session
            .dispatch(SessionCommand::Boolean {
                first: "box",
                second: "b",
                op: BoolOp::Union,
            })
            .is_err());
        assert_eq!(session.state().revision, 0);
        assert!(!session.state().can_undo);
        assert_eq!(session.snapshot().pages[0].children.len(), 2);
    }

    #[test]
    fn refusals_and_no_ops_leave_history_and_revision_unchanged() {
        let mut session = DocumentSession::new(sample()).unwrap();
        let first = SessionCommand::Rename {
            id: "box",
            name: "First",
        };
        session.dispatch(first).unwrap();
        session.dispatch(SessionCommand::Undo).unwrap();
        let state = session.state();
        let blank = SessionCommand::Rename {
            id: "box",
            name: "   ",
        };
        let no_move = SessionCommand::Move {
            id: "box",
            dx: 0.0,
            dy: 0.0,
        };
        let no_resize = SessionCommand::Resize {
            id: "box",
            w: 30.0,
            h: 40.0,
        };
        for command in [blank, no_move, no_resize] {
            assert_eq!(session.dispatch(command).unwrap(), state);
        }
        assert!(session.state().can_redo, "no-op must preserve redo");
        let nan = SessionCommand::Move {
            id: "box",
            dx: f64::NAN,
            dy: 1.0,
        };
        let infinity = SessionCommand::Move {
            id: "box",
            dx: f64::INFINITY,
            dy: 1.0,
        };
        assert!(session.dispatch(nan).is_err());
        assert!(session.dispatch(infinity).is_err());
        let unknown = SessionCommand::Rename {
            id: "missing",
            name: "X",
        };
        let root = SessionCommand::Rename {
            id: "page",
            name: "X",
        };
        assert!(session.dispatch(unknown).is_err());
        assert!(session.dispatch(root).is_err());
        for (id, w, h) in [
            ("box", f64::NAN, 20.0),
            ("box", 30.0, f64::INFINITY),
            ("box", 0.0, 40.0),
            ("box", 20.0, -1.0),
            ("page", 20.0, 40.0),
            ("missing", 20.0, 40.0),
        ] {
            assert!(session
                .dispatch(SessionCommand::Resize { id, w, h })
                .is_err());
        }
        assert_eq!(session.state(), state);
        let redone = session.dispatch(SessionCommand::Redo).unwrap();
        assert_eq!(redone.node.unwrap().name, "First");
        assert_eq!(session.dispatch(SessionCommand::Redo).unwrap().node, None);

        let mut overflow_doc = sample();
        overflow_doc.pages[0].children[0].transform.x = f64::MAX;
        let mut overflow = DocumentSession::new(overflow_doc).unwrap();
        let move_overflow = SessionCommand::Move {
            id: "box",
            dx: f64::MAX,
            dy: 0.0,
        };
        assert!(overflow.dispatch(move_overflow).is_err());
        assert_eq!(overflow.state().revision, 0);
    }

    #[test]
    fn bounded_stroke_command_and_resize_share_rust_history_and_x_checkpoint() {
        let mut session = DocumentSession::new(sample()).unwrap();
        let style = |id: &'static str, width: f64, join: StrokeJoin| SessionCommand::Stroke {
            id,
            width,
            color: Color::from_rgb8(35, 107, 158),
            align: StrokeAlign::Outside,
            join,
        };
        let changed = session
            .dispatch(style("box", 8.0, StrokeJoin::Bevel))
            .unwrap();
        assert_eq!(changed.revision, 1);
        assert!(changed.node.is_none() && changed.boolean.is_none());
        let band = changed.stroke.unwrap();
        assert_eq!(band.id, "box");
        assert_eq!(band.color, "#236b9e");
        assert_eq!(band.outer[0], (-8.0, 0.0));
        assert_eq!(band.outer.len(), 8);
        assert_eq!(
            band.inner.as_slice(),
            &[(0.0, 0.0), (30.0, 0.0), (30.0, 40.0), (0.0, 40.0)]
        );
        assert_eq!(
            session
                .dispatch(style("box", 8.0, StrokeJoin::Bevel))
                .unwrap(),
            session.state(),
            "no-op cannot push a new history entry"
        );
        assert!(session
            .dispatch(style("box", 8.0, StrokeJoin::Round))
            .is_err());
        assert!(session
            .dispatch(style("box", f64::NAN, StrokeJoin::Bevel))
            .is_err());
        assert_eq!(session.state().revision, 1);
        let save = x_format::serialize::save_x(&session.snapshot());
        let loaded = x_format::deserialize::load_x(&save).unwrap();
        let layer = &loaded.pages[0].children[0];
        assert!(layer.visual_stacks_materialized);
        assert_eq!(layer.stroke_layers.len(), 1);
        assert_eq!(layer.stroke_layers[0].options.align, StrokeAlign::Outside);
        assert_eq!(layer.stroke_layers[0].options.join, StrokeJoin::Bevel);
        assert_eq!(layer.stroke.width, 8.0);

        let resize = session
            .dispatch(SessionCommand::Resize {
                id: "box",
                w: 50.0,
                h: 40.0,
            })
            .unwrap();
        assert_eq!(resize.node.unwrap().w, 50.0);
        assert_eq!(resize.stroke.unwrap().outer[2], (50.0, -8.0));
        let undo_resize = session.dispatch(SessionCommand::Undo).unwrap();
        assert_eq!(undo_resize.node.unwrap().w, 30.0);
        assert_eq!(undo_resize.stroke.unwrap().outer[2], (30.0, -8.0));
        let undo_style = session.dispatch(SessionCommand::Undo).unwrap();
        assert!(undo_style.node.is_none());
        assert_eq!(undo_style.stroke.unwrap().width, 0.0);
        let redo_style = session.dispatch(SessionCommand::Redo).unwrap();
        assert_eq!(redo_style.stroke.unwrap().outer[0], (-8.0, 0.0));
        assert!(session
            .dispatch(style("page", 8.0, StrokeJoin::Bevel))
            .is_err());
        assert!(session
            .dispatch(style("missing", 8.0, StrokeJoin::Bevel))
            .is_err());
        assert_eq!(
            session
                .dispatch(style("box", 0.0, StrokeJoin::Bevel))
                .unwrap()
                .stroke
                .unwrap()
                .width,
            0.0
        );
        assert!(session.snapshot().pages[0].children[0]
            .stroke_layers
            .is_empty());
    }

    #[test]
    fn single_page_unique_id_contract_and_explicit_snapshot() {
        assert!(DocumentSession::new(Document::default()).is_err());
        let mut duplicate_page = sample();
        let extra_page = Node::frame("page-2", 200.0, 100.0);
        duplicate_page.pages.push(extra_page);
        assert!(DocumentSession::new(duplicate_page).is_err());
        let mut duplicate_id = sample();
        let duplicate = Node::rect("box", 0.0, 0.0, 1.0, 1.0, Color::BLACK);
        duplicate_id.pages[0].children.push(duplicate);
        assert!(DocumentSession::new(duplicate_id).is_err());

        let mut session = DocumentSession::new(sample()).unwrap();
        session
            .dispatch(SessionCommand::Move {
                id: "box",
                dx: 3.0,
                dy: 4.0,
            })
            .unwrap();
        let saved = x_format::serialize::save_x(&session.snapshot());
        let reopened = x_format::deserialize::load_x(&saved).unwrap();
        assert_eq!(reopened.pages[0].children[0].transform.x, 13.0);
        assert_eq!(reopened.default_font.as_deref(), Some("Sample font"));
    }

    #[test]
    fn offset_is_one_bounded_layer_edit_with_rust_owned_undo_for_all_shapes() {
        let shapes = [
            Node::rect("target", 10.0, 15.0, 90.0, 80.0, Color::BLACK),
            Node::ellipse("target", 10.0, 15.0, 90.0, 80.0, Color::BLACK),
            Node::poly("target", 10.0, 15.0, 90.0, 80.0, 6, Color::BLACK),
            Node::star("target", 10.0, 15.0, 90.0, 80.0, 5, 0.45, Color::BLACK),
            Node::vector(
                "target",
                10.0,
                15.0,
                90.0,
                80.0,
                vec![
                    PathCmd::MoveTo(0.0, 0.0),
                    PathCmd::LineTo(90.0, 0.0),
                    PathCmd::LineTo(90.0, 80.0),
                    PathCmd::LineTo(0.0, 80.0),
                    PathCmd::Close,
                ],
            ),
        ];
        for shape in shapes {
            let before = shape.clone();
            let doc = Document {
                pages: vec![Node::frame("page", 400.0, 300.0)
                    .child(shape)
                    .child(Node::rect("other", 150.0, 0.0, 20.0, 20.0, Color::WHITE))],
                ..Default::default()
            };
            let mut session = DocumentSession::new(doc).unwrap();
            let before_file = x_format::serialize::save_x(&session.snapshot());
            let applied = session
                .dispatch(SessionCommand::Offset {
                    id: "target",
                    distance: 6.0,
                    join: StrokeJoin::Miter,
                })
                .unwrap();
            assert_eq!(applied.revision, 1);
            assert!(
                applied.node.is_none() && applied.boolean.is_none() && applied.stroke.is_none()
            );
            let patch = applied.offset.unwrap();
            assert_eq!(patch.node.id, "target");
            assert!(
                matches!(patch.shape, OffsetShapeDelta::Vector { path } if path.last() == Some(&PathCmd::Close))
            );
            assert_eq!(session.editor.undo_depth(), 1);
            assert_eq!(session.snapshot().pages[0].children[1].id, "other");
            assert_eq!(session.snapshot().pages[0].children[0].fill, before.fill);
            let saved = x_format::serialize::save_x(&session.snapshot());
            assert!(matches!(
                x_format::deserialize::load_x(&saved).unwrap().pages[0].children[0].kind,
                NodeKind::Vector { .. }
            ));
            let undone = session.dispatch(SessionCommand::Undo).unwrap();
            assert_eq!(undone.revision, 2);
            assert!(undone.node.is_none() && undone.offset.is_some());
            assert_eq!(
                x_format::serialize::save_x(&session.snapshot()),
                before_file
            );
            let redone = session.dispatch(SessionCommand::Redo).unwrap();
            assert_eq!(redone.revision, 3);
            assert!(redone.node.is_none() && redone.offset.is_some());
        }
    }

    #[test]
    fn offset_rejects_strokes_and_bad_input_without_a_history_entry() {
        let mut session = DocumentSession::new(sample()).unwrap();
        for distance in [f64::NAN, 2049.0] {
            assert!(session
                .dispatch(SessionCommand::Offset {
                    id: "box",
                    distance,
                    join: StrokeJoin::Round
                })
                .is_err());
        }
        let unchanged = session
            .dispatch(SessionCommand::Offset {
                id: "box",
                distance: 0.0,
                join: StrokeJoin::Bevel,
            })
            .unwrap();
        assert_eq!(unchanged.revision, 0);
        assert!(unchanged.offset.is_none());
        assert_eq!(session.editor.undo_depth(), 0);
        session
            .dispatch(SessionCommand::Stroke {
                id: "box",
                width: 5.0,
                color: Color::BLACK,
                align: StrokeAlign::Center,
                join: StrokeJoin::Miter,
            })
            .unwrap();
        assert!(session
            .dispatch(SessionCommand::Offset {
                id: "box",
                distance: 4.0,
                join: StrokeJoin::Round
            })
            .is_err());
        assert_eq!(session.editor.undo_depth(), 1);
    }

    #[test]
    fn outline_stroke_session_returns_a_bounded_vector_delta_and_round_trips_history() {
        let mut source = Node::rect(
            "ink",
            10.0,
            20.0,
            64.0,
            28.0,
            Color::from_rgb8(0x12, 0x34, 0x56),
        );
        source.visual_stacks_materialized = true;
        source.fill_layers = vec![PaintLayer::new(source.fill.clone())];
        source.stroke = x_core::Stroke::solid(Color::from_rgb8(0x99, 0x55, 0x11), 6.0);
        source.stroke_layers = vec![StrokeLayer {
            stroke: source.stroke.clone(),
            opacity: 1.0,
            visible: true,
            blend: x_core::BlendKind::Normal,
            options: x_core::StrokeOptions {
                cap_start: StrokeCap::Round,
                cap_end: StrokeCap::Triangle,
                join: StrokeJoin::Round,
                dash: vec![13.0, 5.0],
                dash_offset: 8.0,
                width_profile: vec![
                    VariableWidthPoint {
                        position: 0.0,
                        width_multiplier: 0.5,
                    },
                    VariableWidthPoint {
                        position: 0.5,
                        width_multiplier: 1.75,
                    },
                    VariableWidthPoint {
                        position: 1.0,
                        width_multiplier: 0.75,
                    },
                ],
                ..Default::default()
            },
        }];
        let before_file = x_format::serialize::save_x(&Document {
            pages: vec![Node::frame("page", 160.0, 90.0).child(source.clone())],
            ..Default::default()
        });
        let mut session =
            DocumentSession::new(x_format::deserialize::load_x(&before_file).unwrap()).unwrap();

        let applied = session
            .dispatch(SessionCommand::OutlineStroke { id: "ink" })
            .expect("profiled dashed outline is admitted");
        assert_eq!(applied.revision, 1);
        assert!(applied.node.is_none() && applied.stroke.is_none() && applied.offset.is_none());
        let outline = applied.outline.expect("one bounded outline delta");
        assert_eq!(outline.node.id, "ink");
        assert_eq!(outline.fill.as_deref(), Some("#995511"));
        assert!(
            outline.stroke.is_none(),
            "the result is a fill, not a live stroke"
        );
        assert!(
            matches!(outline.shape, OutlineShapeDelta::Vector { ref path } if path.iter().any(|cmd| matches!(cmd, PathCmd::Close)))
        );
        assert_eq!(session.editor.undo_depth(), 1);

        let undone = session.dispatch(SessionCommand::Undo).unwrap();
        assert_eq!(undone.revision, 2);
        assert!(undone.node.is_none() && undone.stroke.is_none() && undone.offset.is_none());
        let restored = undone.outline.expect("undo projects the source layer");
        assert!(matches!(restored.shape, OutlineShapeDelta::Rect { radius } if radius == 0.0));
        let restored_stroke = restored.stroke.expect("source stroke returns on undo");
        assert_eq!(restored_stroke.dash, vec![13.0, 5.0]);
        assert_eq!(restored_stroke.dash_offset, 8.0);
        assert_eq!(restored_stroke.width_profile.len(), 3);
        assert_eq!(
            x_format::serialize::save_x(&session.snapshot()),
            before_file
        );

        let redone = session.dispatch(SessionCommand::Redo).unwrap();
        assert_eq!(redone.revision, 3);
        assert!(matches!(
            redone.outline.unwrap().shape,
            OutlineShapeDelta::Vector { .. }
        ));
    }

    #[test]
    fn outline_stroke_session_rejects_unprojectable_or_invalid_input_before_history() {
        let mut source = Node::rect("ink", 0.0, 0.0, 30.0, 20.0, Color::WHITE);
        source.visual_stacks_materialized = true;
        source.fill_layers = vec![PaintLayer::new(source.fill.clone())];
        source.stroke = x_core::Stroke::solid(Color::BLACK, 4.0);
        source.stroke_layers = vec![StrokeLayer {
            stroke: source.stroke.clone(),
            opacity: 1.0,
            visible: true,
            blend: x_core::BlendKind::Normal,
            options: x_core::StrokeOptions {
                dash: vec![0.0, 4.0],
                width_profile: vec![VariableWidthPoint {
                    position: 0.0,
                    width_multiplier: 1.0,
                }],
                ..Default::default()
            },
        }];
        let doc = Document {
            pages: vec![Node::frame("page", 100.0, 60.0).child(source)],
            ..Default::default()
        };
        let mut session = DocumentSession::new(doc).unwrap();
        assert!(session
            .dispatch(SessionCommand::OutlineStroke { id: "ink" })
            .is_err());
        assert_eq!(session.revision, 0);
        assert_eq!(session.editor.undo_depth(), 0);

        let child = Node::rect("nested", 0.0, 0.0, 10.0, 10.0, Color::WHITE);
        session.editor.root.children[0].children.push(child);
        assert!(session
            .dispatch(SessionCommand::OutlineStroke { id: "ink" })
            .is_err());
        assert_eq!(session.editor.undo_depth(), 0);
    }

    #[test]
    fn small_layer_edits_do_not_snapshot_sibling_subtrees_into_history() {
        let mut doc = sample();
        for i in 0..300 {
            let id = format!("sibling-{i}");
            let child = Node::rect(&id, 0.0, 0.0, 1.0, 1.0, Color::BLACK);
            doc.pages[0].children.push(child);
        }
        let mut session = DocumentSession::new(doc).unwrap();
        session
            .dispatch(SessionCommand::Rename {
                id: "box",
                name: "Small",
            })
            .unwrap();
        session
            .dispatch(SessionCommand::Resize {
                id: "box",
                w: 2.0,
                h: 3.0,
            })
            .unwrap();
        let bytes = session.editor.history_bytes();
        assert!(
            bytes < 10_000,
            "rename/resize history captured the page: {bytes}"
        );
    }
}
