//! Application state — documents (engine `Document` + per-page `Editor`),
//! dashboard data, panel/tab/interaction state. UI-only; the engine does
//! the actual design work. No old-shell inheritance.

use std::collections::HashSet;
use std::path::PathBuf;

use vello::kurbo::{Point, Rect};
use x_native::editor::Editor;
use x_native::{Color, Document, Node, NodeKind, Paint, StrokeJoin, Variables, APP_DEFAULT_FONT};

use crate::command::CommandPalette;
use crate::context_menu::ContextMenu;
use crate::paint::TextUi;
use crate::theme::*;
use vello::peniko::Color as VelloColor;

// ----------------------------------------------------------------- tooling

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    Select,
    /// Figma's Scale tool (K): the same four corner handles as the Move tool,
    /// but the whole layer scales with them — stroke weight, corner radius,
    /// text size, effects and auto-layout spacing travel with the box.
    Scale,
    Frame,
    /// Figma's Section tool (⇧S): a labelled container whose whole job is to
    /// hold other layers. "Sections in Figma Design are a top-level element on
    /// the canvas by default. Sections can contain all layer types, including
    /// other sections, but cannot be contained within frames or groups."
    Section,
    Text,
    Rect,
    Ellipse,
    /// Figma's Line tool (L): one straight segment in any direction, whose
    /// only paint is its stroke — a horizontal line's box is 0 units high.
    Line,
    /// Figma's Arrow tool (⇧L): the same segment, ending in the solid head
    /// the shape menu's arrow draws.
    Arrow,
    /// Figma's Polygon tool, from the shape tools menu: "an enclosed shape
    /// that is made up of any number of straight lines", a triangle by
    /// default. Its Count lives in the Appearance section, like the arc's
    /// properties.
    Poly,
    /// Figma's Star tool: "polygons that are arranged in a star shape", five
    /// points by default, with a Count and a Ratio in the Appearance section.
    Star,
    Pen,
    Hand,
    /// Board zoom tool (kept out of the design toolbar, where wheel/shortcuts
    /// provide zooming; exposed in the board tool rail).
    Zoom,
    /// C18: comment pin mode (C / palette; not on the audited toolbar)
    Comment,
    /// Vector Eraser - erase parts of paths and shapes
    Eraser,
    /// Figma's Slice tool (S): a region whose only job is to be exported. It
    /// draws nothing itself — exporting it captures the flattened canvas
    /// content inside its bounds.
    Slice,
    /// Figma's Pencil (⇧P): a freehand stroke, smoothed into an editable
    /// vector path, and a tool that "stays active until you select another
    /// tool or press Esc".
    Pencil,
    /// Figma Draw's Brush, beside the Pencil in the same toolbar: the same
    /// freehand gesture and the same vector points, but the mark is painted
    /// rather than drawn — the article's "add texture and color for a more
    /// organic, hand-painted appearance".
    Brush,
    /// Symmetry Mirror - mirror drawing across axis
    Symmetry,
    /// Board-specific tools
    BoardSticky,
    BoardConnector,
    BoardRect,
    BoardCircle,
}

impl Tool {
    pub fn icon(self) -> &'static str {
        match self {
            Tool::Select => "mouse-pointer-2",
            Tool::Scale => "maximize",
            Tool::Frame => "frame#",
            Tool::Section => "section",
            Tool::Slice => "scissors",
            Tool::Text => "type",
            Tool::Rect => "square",
            Tool::Ellipse => "circle",
            Tool::Line => "line",
            Tool::Arrow => "arrow-up-right",
            Tool::Poly => "triangle",
            Tool::Star => "star",
            Tool::Pen => "pen-tool",
            Tool::Pencil => "pencil",
            Tool::Brush => "brush",
            Tool::Hand => "hand",
            Tool::Zoom => "zoom-in",
            Tool::Comment => "message-circle",
            Tool::Eraser => "eraser",
            Tool::Symmetry => "reflect-vertical",
            Tool::BoardSticky => "sticky-note",
            Tool::BoardConnector => "arrow-right",
            Tool::BoardRect => "square",
            Tool::BoardCircle => "circle",
        }
    }

    /// The tool a plain (Ctrl-free) keystroke selects, per document
    /// mode — the single source of truth for tool shortcuts (audit F3:
    /// the handler used to keep a second, half-drifted copy inline).
    /// `key` is the lowercased character; `board` selects the mode's
    /// tool set. Baseline keys are case/shift tolerant as before;
    /// plain-C is mode-specific and ⇧C stays free; ⇧E is the eraser;
    /// M-symmetry is design-mode only (the old handler let it leak
    /// into boards).
    /// Display name (toolbar tooltips; P10)
    pub fn label(self) -> &'static str {
        match self {
            Tool::Select => "Move",
            Tool::Scale => "Scale",
            Tool::Frame => "Frame",
            Tool::Section => "Section",
            Tool::Slice => "Slice",
            Tool::Text => "Text",
            Tool::Rect => "Rectangle",
            Tool::Ellipse => "Ellipse",
            Tool::Line => "Line",
            Tool::Arrow => "Arrow",
            Tool::Poly => "Polygon",
            Tool::Star => "Star",
            Tool::Pen => "Pen",
            Tool::Pencil => "Pencil",
            Tool::Brush => "Brush",
            Tool::Hand => "Hand",
            Tool::Zoom => "Zoom",
            Tool::Comment => "Comment",
            Tool::Eraser => "Vector eraser",
            Tool::Symmetry => "Symmetry",
            Tool::BoardSticky => "Sticky note",
            Tool::BoardConnector => "Connector",
            Tool::BoardRect => "Rectangle",
            Tool::BoardCircle => "Ellipse",
        }
    }

    /// Tooltip shortcut hint, derived from `from_shortcut` — the one
    /// source of truth — so the hint can never drift from the key
    /// handler (P10). Empty when the mode has no shortcut for this
    /// tool.
    pub fn shortcut_hint(self, board: bool) -> String {
        const KEYS: &[(&str, bool)] = &[
            ("v", false),
            ("k", false),
            ("f", false),
            ("t", false),
            ("r", false),
            ("o", false),
            ("l", false),
            ("l", true),
            ("p", true),
            ("b", true),
            ("p", false),
            ("h", false),
            ("c", false),
            ("m", false),
            ("s", false),
            ("s", true),
            ("e", true),
        ];
        for (k, sh) in KEYS {
            if Self::from_shortcut(k, *sh, board) == Some(self) {
                let base = k.chars().next().unwrap().to_ascii_uppercase();
                return if *sh {
                    format!("⇧{base}")
                } else {
                    format!("{base}")
                };
            }
        }
        String::new()
    }

    pub fn from_shortcut(key: &str, shift: bool, board: bool) -> Option<Tool> {
        match (key, shift) {
            ("e", true) => Some(Tool::Eraser),
            ("c", false) if board => Some(Tool::BoardConnector),
            ("c", false) => Some(Tool::Comment),
            ("m", false) if !board => Some(Tool::Symmetry),
            ("s", _) if board => Some(Tool::BoardSticky),
            ("r", _) if board => Some(Tool::BoardRect),
            ("o", _) if board => Some(Tool::BoardCircle),
            ("v", _) => Some(Tool::Select),
            // Figma's Scale tool; boards have their own model, no scale there
            ("k", _) if !board => Some(Tool::Scale),
            // Figma's Slice tool — also design-only: a board draws its own
            // shapes and has no export region. Sections live on the canvas,
            // so they are design-only too, and they take ⇧S (Figma's own
            // key for the tool, beside the frame's F).
            ("s", true) if !board => Some(Tool::Section),
            ("s", _) if !board => Some(Tool::Slice),
            ("f", _) => Some(Tool::Frame),
            ("t", _) => Some(Tool::Text),
            ("r", _) => Some(Tool::Rect),
            ("o", _) => Some(Tool::Ellipse),
            // Figma's shape menu keeps the line and the arrow on one key: L is
            // the Line, ⇧L the Arrow. Like the Scale, Slice, Pencil and Brush
            // tools both are design-only — a board uses its own connector.
            ("l", true) if !board => Some(Tool::Arrow),
            ("l", _) if !board => Some(Tool::Line),
            // Figma's Pencil shares P with the Pen (⇧P, the creation-tools
            // menu) and, like the Scale and Slice tools, it is design-only:
            // a board draws freehand with its own pen.
            ("p", true) if !board => Some(Tool::Pencil),
            // Figma Draw's Brush: the pencil's freehand gesture with a painted
            // mark. The article puts the two in one toolbar and names no
            // shortcut for either, so ⇧B sits beside ⇧P; like the Scale, Slice
            // and Pencil tools it is design-only.
            ("b", true) if !board => Some(Tool::Brush),
            ("p", _) => Some(Tool::Pen),
            ("h", _) => Some(Tool::Hand),
            _ => None,
        }
    }
}

/// The Pencil's ink. Figma: "the pencil tool sketches with a round 3px stroke
/// weight in black, unless you're sketching on a dark canvas or frame" — this
/// canvas is dark and every other shape tool in it draws with the light ink, so
/// a sketch does too. ONE source for the live preview and the node that lands,
/// so the two cannot drift.
pub fn pencil_ink() -> x_native::Color {
    x_native::Color::from_rgb8(0xFF, 0xFF, 0xFF)
}

/// A new sketch's stroke weight (Figma's default).
pub const PENCIL_WEIGHT: f64 = 3.0;

/// The Line and Arrow tools' ink: Figma's new line is a 1px stroke, drawn in
/// the light ink this canvas needs — the pencil's own rule, so the two tools
/// cannot drift and the chrome's colour ratchet gains no new literal. ONE
/// source for the live preview and the node that lands.
pub fn line_ink() -> x_native::Color {
    pencil_ink()
}

/// A new line's stroke weight (Figma's default for the tool).
pub const LINE_WEIGHT: f64 = 1.0;

/// The Line and Arrow tools' endpoints — the same ⌥ rule `create_rect` uses
/// (hold Option to draw from the centre), so the preview and the commit cannot
/// disagree about the segment.
pub fn create_line(start: Point, cur: Point, from_center: bool) -> ((f64, f64), (f64, f64)) {
    let (dx, dy) = (cur.x - start.x, cur.y - start.y);
    if from_center {
        ((start.x - dx, start.y - dy), (start.x + dx, start.y + dy))
    } else {
        ((start.x, start.y), (cur.x, cur.y))
    }
}

/// Freehand simplification, in world units. A hand's wobble is smaller than
/// this, and the engine's fit turns the rest into editable curves.
pub const PENCIL_SMOOTHING: f64 = 1.5;

/// The ink both freehand tools draw with. The pencil's page says black "unless
/// you're sketching on a dark canvas or frame", the brush's says it "adds
/// texture and color" on top of the pencil's line, and this canvas is dark — so
/// the brush's default is the light ink the pencil already uses.
pub fn brush_ink() -> x_native::Color {
    pencil_ink()
}

/// Figma Draw's brush styles. Their page's "Create brush" turns a closed vector
/// shape into a style that is stretched or scattered along a stroke; this build
/// has no brush-style library, so the three styles that ship are the outline's
/// own profile — how wide the mark is, how far its ends taper, and how rough
/// its two edges are. The live preview and the layer the stroke lands as read
/// this one table, so what is on screen is what is committed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BrushStyle {
    /// A loaded round brush: full width, ends that come to a point.
    Ink,
    /// A marker: one width from end to end, clean edges.
    Marker,
    /// A dry brush: a thin body and a lot of grain.
    Dry,
}

impl BrushStyle {
    pub const ALL: [BrushStyle; 3] = [BrushStyle::Ink, BrushStyle::Marker, BrushStyle::Dry];

    pub fn label(self) -> &'static str {
        match self {
            BrushStyle::Ink => "Ink",
            BrushStyle::Marker => "Marker",
            BrushStyle::Dry => "Dry",
        }
    }

    /// The mark's full width, in world units.
    pub fn width(self) -> f64 {
        match self {
            BrushStyle::Ink => 12.0,
            BrushStyle::Marker => 8.0,
            BrushStyle::Dry => 14.0,
        }
    }

    /// How far the mark's ends thin (0 = a marker's constant width).
    pub fn taper(self) -> f64 {
        match self {
            BrushStyle::Ink => 1.0,
            BrushStyle::Marker => 0.0,
            BrushStyle::Dry => 1.6,
        }
    }

    /// How rough the mark's two edges are.
    pub fn grain(self) -> f64 {
        match self {
            BrushStyle::Ink => 0.25,
            BrushStyle::Marker => 0.05,
            BrushStyle::Dry => 0.7,
        }
    }
}

/// The rect a shape-tool drag commits — ONE rule for the live preview and the
/// node that lands, so what you see while dragging is what you get.
///
/// * ⇧ (constrain to a square/circle) is applied to the drag's `cur` as it
///   moves, so it is already in `cur` here;
/// * ⌥ / Alt draws FROM THE CENTRE (Figma's shape tools), so the point the
///   drag started on is the centre, not a corner;
/// * either way the rect is normalised, so dragging up/left is the same drag.
pub fn create_rect(start: Point, cur: Point, from_center: bool) -> Rect {
    let (dx, dy) = (cur.x - start.x, cur.y - start.y);
    if from_center {
        Rect::new(
            start.x - dx.abs(),
            start.y - dy.abs(),
            start.x + dx.abs(),
            start.y + dy.abs(),
        )
    } else {
        Rect::new(
            start.x.min(cur.x),
            start.y.min(cur.y),
            start.x.max(cur.x),
            start.y.max(cur.y),
        )
    }
}

/// The corner a scale about `corner` pins: the one diagonally OPPOSITE the
/// handle the pointer grabbed. That is Figma's fixed point — grab the
/// bottom-right handle and the top-left corner does not move.
pub fn scale_anchor(orig: (f64, f64, f64, f64), corner: usize) -> (f64, f64) {
    let (x, y, w, h) = orig;
    match corner {
        0 => (x + w, y + h),
        1 => (x, y + h),
        2 => (x + w, y),
        _ => (x, y),
    }
}

/// The Scale panel's anchor box, as nine cells read row by row from the top
/// left — the middle one (4) is what the panel opens on, exactly as Figma's
/// screenshot shows it. ONE table: the panel paints it, the multiplier and the
/// dimension fields read it, and the canvas body drag uses `nearest_corner`
/// instead (Figma anchors a drag to the corner opposite the pointer).
pub const SCALE_CELLS: usize = 9;

/// The fixed point of a panel scale: which side of the box stays put.
pub fn scale_cell_anchor(orig: (f64, f64, f64, f64), cell: usize) -> (f64, f64) {
    let (x, y, w, h) = orig;
    let cell = cell.min(SCALE_CELLS - 1);
    let xs = [x, x + w / 2.0, x + w];
    let ys = [y, y + h / 2.0, y + h];
    (xs[cell % 3], ys[cell / 3])
}

/// The corner a handle grab takes hold of: 0 top-left, 1 top-right, 2
/// bottom-left, 3 bottom-right. `scale_anchor` is its opposite — the fixed
/// point of the same grab.
pub fn corner_point(orig: (f64, f64, f64, f64), corner: usize) -> Point {
    let (x, y, w, h) = orig;
    match corner {
        0 => Point::new(x, y),
        1 => Point::new(x + w, y),
        2 => Point::new(x, y + h),
        _ => Point::new(x + w, y + h),
    }
}

/// The corner of the box nearest `p` — which corner a body drag scales about
/// (the opposite one stays put, like a handle grab).
pub fn nearest_corner(orig: (f64, f64, f64, f64), p: Point) -> usize {
    let (x, y, w, h) = orig;
    match (p.x - x > w / 2.0, p.y - y > h / 2.0) {
        (false, false) => 0,
        (true, false) => 1,
        (false, true) => 2,
        (true, true) => 3,
    }
}

/// The projection rule behind EVERY scale gesture, with the grab point in
/// place of the grabbed corner: `factor` is where the pointer lands on the ray
/// from the anchor through the grab, so the grabbed point rides the pointer
/// and the box stays uniform — Figma's Scale is proportional by definition,
/// and 1.0 means "unmoved". A collapse is clamped rather than flipped:
/// dragging past the anchor must not mirror the layer.
pub fn scale_grab_factor(anchor: (f64, f64), grab: Point, pointer: Point) -> f64 {
    let (ux, uy) = (grab.x - anchor.0, grab.y - anchor.1);
    let denom = ux * ux + uy * uy;
    if denom <= 1e-9 {
        return 1.0;
    }
    let f = ((pointer.x - anchor.0) * ux + (pointer.y - anchor.1) * uy) / denom;
    f.max(MIN_SCALE)
}

/// The Scale tool's handle rule, shared by the live preview and the commit:
/// the grab is the corner the pointer holds, the anchor the one opposite it.
pub fn scale_drag_factor(
    orig: (f64, f64, f64, f64),
    corner: usize,
    pointer: Point,
) -> (f64, (f64, f64)) {
    let anchor = scale_anchor(orig, corner);
    let grab = corner_point(orig, corner);
    (scale_grab_factor(anchor, grab, pointer), anchor)
}

/// The box a scale of `factor` about `anchor` maps `orig` onto — the paint
/// half of both drag rules.
pub fn scaled_box_about(orig: (f64, f64, f64, f64), anchor: (f64, f64), factor: f64) -> Rect {
    let (x, y, w, h) = orig;
    let (ax, ay) = anchor;
    let (nx, ny) = (ax + (x - ax) * factor, ay + (y - ay) * factor);
    Rect::new(nx, ny, nx + w * factor, ny + h * factor)
}

/// The box a handle grab's scale maps `orig` onto.
pub fn scaled_box(orig: (f64, f64, f64, f64), corner: usize, factor: f64) -> Rect {
    scaled_box_about(orig, scale_anchor(orig, corner), factor)
}

/// Smallest factor a drag may commit: below this the layer is invisible and
/// the anchor sits on top of its own edge, so 0.02 is as far as a drag goes.
pub const MIN_SCALE: f64 = 0.02;

/// Which of Figma's three arc handles a drag has hold of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArcPart {
    /// The handle you meet first: drag it to change the sweep. On a solid
    /// ellipse it is the only one, and it sits at 0 — "a single handle will
    /// appear on the right-hand side".
    Sweep,
    /// The handle with a dot inside it: where the arc begins.
    Start,
    /// The handle that turns the circle into a ring: its distance from the
    /// centre is the ratio.
    Ratio,
}

/// A layer's arc properties, in the engine's own terms: `(start, end, ratio)`.
/// A solid ellipse reads as the full sweep — Figma's arc properties describe
/// every ellipse, the defaults are just 0 / 360 / 0. `None` for anything that
/// is not an ellipse or an arc.
pub fn arc_props(n: &Node) -> Option<(f64, f64, f64)> {
    match &n.kind {
        NodeKind::Ellipse => Some((0.0, 0.0, 0.0)),
        NodeKind::Arc { start, end, ratio } => Some((*start, *end, *ratio)),
        _ => None,
    }
}

/// Whether the layer still draws a whole circle: Figma only grows the Start
/// and Ratio handles once the sweep has been broken.
pub fn arc_is_full(start: f64, end: f64, ratio: f64) -> bool {
    let sweep = x_native::booleans::arc_sweep(start, end);
    sweep.abs() >= 360.0 - 1e-6 && ratio <= 1e-6
}

/// Figma's arc handles in the LAYER'S OWN box space (0..w, 0..h): the Sweep
/// handle at the end of the sweep, the Start handle at its beginning, and the
/// Ratio handle at the middle of the sweep on the inner edge — "at the center
/// of the circle" while there is no ring to ride on. The same table paints
/// them, hit-tests them and drives the drag.
pub fn arc_handles(n: &Node) -> Vec<(ArcPart, Point)> {
    let Some((start, end, ratio)) = arc_props(n) else {
        return vec![];
    };
    let sweep = x_native::booleans::arc_sweep(start, end);
    let at = |deg: f64, frac: f64| {
        let (x, y) = x_native::booleans::arc_point(n.w, n.h, deg, frac);
        Point::new(x, y)
    };
    let mut out = vec![(ArcPart::Sweep, at(end, 1.0))];
    if !arc_is_full(start, end, ratio) {
        out.push((ArcPart::Start, at(start, 1.0)));
        out.push((ArcPart::Ratio, at(start + sweep / 2.0, ratio)));
    }
    out
}

/// The layer Figma's arc handles belong to: the single selected ellipse or
/// arc, else the layer under the cursor — Figma shows the handle on hover,
/// before anything is selected.
pub fn arc_target(app: &App) -> Option<(String, bool)> {
    // the handles belong to the Move tool, the way Figma's do: another tool
    // has its own gesture for the same pointer
    if app.tool != Tool::Select {
        return None;
    }
    let doc = app.doc_opt()?;
    let sel = &doc.editor_ref().selection;
    if sel.len() == 1 {
        let n = crate::editor_ui::find_node(&doc.editor_ref().root, &sel[0])?;
        if arc_props(n).is_some() {
            return Some((sel[0].clone(), true));
        }
    }
    let hover = app.hover_node.clone()?;
    let n = crate::editor_ui::find_node(&doc.editor_ref().root, &hover)?;
    arc_props(n).map(|_| (hover, false))
}

/// The pointer's angle about a layer's centre, in the layer's own box space —
/// 0 at the right-hand point and growing clockwise, the convention the engine's
/// arc geometry and Figma's own handle both use.
pub fn arc_angle_at(w: f64, h: f64, local: Point) -> f64 {
    let (cx, cy) = (w / 2.0, h / 2.0);
    (local.y - cy).atan2(local.x - cx).to_degrees()
}

/// How far out the pointer is, as a fraction of the radius — 1.0 on the rim,
/// 0 at the centre. Ellipse-normalised, so a rim point reads 1.0 whatever the
/// box's aspect. Unclamped on purpose: the Count handle measures motion on
/// both sides of the rim, so outwards has to keep growing.
pub fn shape_radial_at(w: f64, h: f64, local: Point) -> f64 {
    let (rx, ry) = ((w / 2.0).max(1e-6), (h / 2.0).max(1e-6));
    let (dx, dy) = ((local.x - rx) / rx, (local.y - ry) / ry);
    (dx * dx + dy * dy).sqrt()
}

/// How far out the pointer is, as a fraction of the radius — what dragging the
/// Ratio handle sets. Never quite 1: a ring with no width is not a shape.
pub fn arc_ratio_at(w: f64, h: f64, local: Point) -> f64 {
    shape_radial_at(w, h, local).clamp(0.0, 0.99)
}

/// Write arc properties onto a layer, turning a solid ellipse into the arc
/// that carries them. The box is untouched: these are appearance, not size —
/// the same rule that makes Figma's arc non-destructive. `false` when the id
/// is not an ellipse or an arc (nothing is written, so nothing is undone).
pub fn set_arc(
    editor: &mut x_native::editor::Editor,
    id: &str,
    start: f64,
    end: f64,
    ratio: f64,
) -> bool {
    let ok = x_native::editor::find(&editor.root, id).is_some_and(|n| arc_props(n).is_some());
    if !ok {
        return false;
    }
    editor.mutate_visual_stack(id, |n| n.kind = NodeKind::Arc { start, end, ratio })
}

/// How far a Count handle drag travels, in units of the shape's own radius:
/// half a radius outwards adds this many points, half a radius inwards takes
/// them away. Size-independent, the way every other canvas handle is.
pub const COUNT_DRAG_SPAN: f64 = 20.0;

/// The polygon's sides, if the layer is one — Figma's Count.
pub fn poly_sides(n: &Node) -> Option<usize> {
    match &n.kind {
        NodeKind::Poly { sides } => Some(*sides),
        _ => None,
    }
}

/// A star's points and inner ratio, if the layer is one — Figma's Count and
/// Ratio on the same layer.
pub fn star_props(n: &Node) -> Option<(usize, f64)> {
    match &n.kind {
        NodeKind::Star { points, ratio } => Some((*points, *ratio)),
        _ => None,
    }
}

/// A layer's Count, whichever of Figma's two counting shapes it is.
pub fn shape_count(n: &Node) -> Option<usize> {
    poly_sides(n).or_else(|| star_props(n).map(|(points, _)| points))
}

/// A layer's kind and Count together, for the Appearance block that shows it.
pub fn shape_of(n: &Node) -> Option<(NodeKind, usize)> {
    shape_count(n).map(|count| (n.kind.clone(), count))
}

/// Which of Figma's polygon and star handles a drag has hold of.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShapePart {
    /// "How many points there are to the star" (a polygon's sides): the
    /// min/max are 3 and 60 for both.
    Count,
    /// The star only: "the distance of the inner points of the star from the
    /// center", as a share of the radius.
    Ratio,
}

/// Figma's polygon and star handles in the LAYER'S OWN box space: the Count
/// handle rides the shape's rightmost outer vertex — "the small, round count
/// handle next to the shape" — and a star's Ratio handle rides the rightmost
/// INNER vertex, the point whose distance from the centre is the Ratio. The
/// same table paints them, hit-tests them and drives the drag.
pub fn shape_handles(n: &Node) -> Vec<(ShapePart, Point)> {
    let rightmost = |mut pts: Vec<Point>| -> Option<Point> {
        pts.sort_by(|a, b| a.x.total_cmp(&b.x));
        pts.pop()
    };
    let at = |deg: f64, frac: f64| {
        let (x, y) = x_native::booleans::arc_point(n.w, n.h, deg, frac);
        Point::new(x, y)
    };
    match &n.kind {
        NodeKind::Poly { sides } => {
            let outer: Vec<Point> = (0..*sides)
                .map(|k| at(-90.0 + 360.0 * k as f64 / *sides as f64, 1.0))
                .collect();
            rightmost(outer)
                .map(|p| vec![(ShapePart::Count, p)])
                .unwrap_or_default()
        }
        NodeKind::Star { points, ratio } => {
            let outer: Vec<Point> = (0..*points)
                .map(|k| at(-90.0 + 360.0 * k as f64 / *points as f64, 1.0))
                .collect();
            let inner: Vec<Point> = (0..*points)
                .map(|k| at(-90.0 + 180.0 * (2 * k + 1) as f64 / *points as f64, *ratio))
                .collect();
            let mut out: Vec<(ShapePart, Point)> = vec![];
            if let Some(p) = rightmost(outer) {
                out.push((ShapePart::Count, p));
            }
            if let Some(p) = rightmost(inner) {
                out.push((ShapePart::Ratio, p));
            }
            out
        }
        _ => vec![],
    }
}

/// The layer Figma's Count and Ratio handles belong to: the single selected
/// polygon or star, else the layer under the cursor — the same rule as the
/// arc's handles, and for the same reason (Figma shows the handle on hover).
pub fn shape_target(app: &App) -> Option<(String, bool)> {
    if app.tool != Tool::Select {
        return None;
    }
    let doc = app.doc_opt()?;
    let sel = &doc.editor_ref().selection;
    if sel.len() == 1 {
        let n = crate::editor_ui::find_node(&doc.editor_ref().root, &sel[0])?;
        if shape_count(n).is_some() {
            return Some((sel[0].clone(), true));
        }
    }
    let hover = app.hover_node.clone()?;
    let n = crate::editor_ui::find_node(&doc.editor_ref().root, &hover)?;
    shape_count(n).map(|_| (hover, false))
}

/// Write a polygon's or star's Count, in whichever of the two kinds the layer
/// already is. The box is untouched — the Count is appearance, not size — and
/// the engine clamps it to Figma's 3..60. `false` when the id is neither (so
/// nothing is written and nothing is undone).
pub fn set_shape_count(editor: &mut x_native::editor::Editor, id: &str, count: usize) -> bool {
    let count = count.clamp(x_native::booleans::COUNT_MIN, x_native::booleans::COUNT_MAX);
    let kind = x_native::editor::find(&editor.root, id).map(|n| n.kind.clone());
    match kind {
        Some(NodeKind::Poly { .. }) => {
            editor.mutate_visual_stack(id, |n| n.kind = NodeKind::Poly { sides: count })
        }
        Some(NodeKind::Star { ratio, .. }) => editor.mutate_visual_stack(id, |n| {
            n.kind = NodeKind::Star {
                points: count,
                ratio,
            }
        }),
        _ => false,
    }
}

/// Write a star's Ratio — Figma's "distance of the inner points … from the
/// center", clamped clear of a degenerate star. `false` for anything that is
/// not a star.
pub fn set_star_ratio(editor: &mut x_native::editor::Editor, id: &str, ratio: f64) -> bool {
    let points = match x_native::editor::find(&editor.root, id).and_then(star_props) {
        Some((points, _)) => points,
        None => return false,
    };
    let ratio = ratio.clamp(0.05, 0.95);
    editor.mutate_visual_stack(id, |n| {
        n.kind = NodeKind::Star { points, ratio };
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Screen {
    Dashboard,
    Editor,
    Board,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LeftTab {
    Layers,
    Assets,
    Tokens,
}

/// Type used by the quick variable creation controls.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VariableKind {
    Color,
    Number,
    String,
    Boolean,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NavTab {
    File,
    Agents,
    Assets,
    Tools,
    Variables,
}

impl NavTab {
    pub fn icon(self) -> &'static str {
        match self {
            NavTab::File => "file",
            NavTab::Agents => "sparkles",
            NavTab::Assets => "component",
            NavTab::Tools => "sliders-horizontal",
            NavTab::Variables => "code",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            NavTab::File => "Layers",
            NavTab::Agents => "Agents",
            NavTab::Assets => "Library",
            NavTab::Tools => "Tokens",
            NavTab::Variables => "Variables",
        }
    }

    pub fn shortcut(self) -> &'static str {
        match self {
            NavTab::File => "⌥1",
            NavTab::Agents => "⌥2",
            NavTab::Assets => "⌥3",
            NavTab::Tools => "⌥4",
            NavTab::Variables => "⌥5",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RightTab {
    Design,
    Prototype,
    Inspect,
    /// UX Analysis Tool - analyze user flows, accessibility, design quality
    UX,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DashView {
    Home,
    Recents,
    Starred,
    Trash,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DashLayout {
    Grid,
    List,
}

/// How the dashboard orders files. Two honest keys (there is no stored file
/// size to sort by, and inventing one would be a fake control): when it was
/// last edited, and its name. `Starred` floats the starred files up while
/// keeping recency inside each group.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DashSort {
    Edited,
    Name,
    Starred,
}

impl DashSort {
    pub fn label(self) -> &'static str {
        match self {
            DashSort::Edited => "Edited",
            DashSort::Name => "Name",
            DashSort::Starred => "Starred first",
        }
    }
}

// ------------------------------------------------------------- frame sizes

/// Frame presets — exact values from the v45 dropdown.
pub const FRAME_PRESETS: [(&str, f64, f64); 5] = [
    ("Frame", 375.0, 420.0),
    ("Desktop", 1440.0, 900.0),
    ("Laptop", 1280.0, 800.0),
    ("Tablet", 768.0, 1024.0),
    ("Mobile", 375.0, 812.0),
];

// ------------------------------------------------------------ recent files

#[derive(Clone, Debug)]
pub struct RecentFile {
    pub name: String,
    pub team: String,
    pub edited: String,
    /// The sortable key behind [`RecentFile::edited`], in minutes (larger is
    /// older). Derived from the label so the human string and the ordering
    /// cannot disagree — `edited_minutes` is the only parser.
    pub edited_min: u32,
    pub color: VelloColor,
    pub members: Vec<String>,
    pub starred: bool,
    pub path: Option<PathBuf>,
    pub icon: &'static str,
}

/// Seed data — the exact six files / four drafts from dashboard-v2.html.
fn seed_recents() -> Vec<RecentFile> {
    vec![
        rf(
            "Liquor Delivery App UI",
            "Liquor Delivery",
            "Edited 2h ago",
            VelloColor::from_rgb8(0xFF, 0xFF, 0xFF),
            vec!['S', 'A'],
            None,
        ),
        rf(
            "DESIGN_SYSTEM.md",
            "Design System",
            "Edited 5h ago",
            VelloColor::from_rgb8(0x1A, 0x1A, 0x1A),
            vec!['S'],
            None,
        ),
        rf(
            "Payment Flow",
            "Liquor Delivery",
            "Edited yesterday",
            VelloColor::from_rgb8(0xE7, 0xF5, 0xF1),
            vec!['S', 'R', 'M'],
            None,
        ),
        rf(
            "Onboarding Screens",
            "Personal",
            "Edited 2 days ago",
            VelloColor::from_rgb8(0x11, 0x11, 0x11),
            vec!['S'],
            None,
        ),
        rf(
            "Dashboard Redesign",
            "Design System",
            "Edited 3 days ago",
            VelloColor::from_rgb8(0x1E, 0x1E, 0x24),
            vec!['S', 'A'],
            None,
        ),
        rf(
            "Landing Page",
            "Personal",
            "Edited 1 week ago",
            VelloColor::from_rgb8(0xFF, 0xFF, 0xFF),
            vec!['S'],
            None,
        ),
    ]
}

/// "Edited 2h ago" → 120, "yesterday" → 1440, "3 days ago" → 4320.
/// Unparseable labels sort last rather than first, so a new label can never
/// silently jump to the top of "Sorted by Edited".
pub fn edited_minutes(label: &str) -> u32 {
    let l = label.to_lowercase();
    let l = l.strip_prefix("edited ").unwrap_or(&l);
    if l.starts_with("now") {
        return 0;
    }
    if l.starts_with("yesterday") {
        return 24 * 60;
    }
    let mut digits = String::new();
    for ch in l.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if !digits.is_empty() {
            break;
        }
    }
    let Ok(n) = digits.parse::<u32>() else {
        return u32::MAX;
    };
    let rest = l.trim_start_matches(|c: char| c.is_ascii_digit() || c == ' ');
    let unit = rest.split_whitespace().next().unwrap_or("");
    if unit.starts_with("min") {
        n
    } else if unit.starts_with("h") {
        n * 60
    } else if unit.starts_with("day") {
        n * 24 * 60
    } else if unit.starts_with("week") {
        n * 7 * 24 * 60
    } else {
        u32::MAX
    }
}

pub fn rf(
    name: &str,
    team: &str,
    edited: &str,
    color: VelloColor,
    members: Vec<char>,
    path: Option<PathBuf>,
) -> RecentFile {
    RecentFile {
        name: name.into(),
        team: team.into(),
        edited_min: edited_minutes(edited),
        edited: edited.into(),
        color,
        members: members.into_iter().map(|c| c.to_string()).collect(),
        starred: false,
        path,
        icon: "file",
    }
}

fn seed_drafts() -> Vec<RecentFile> {
    vec![
        draft("Untitled", "Edited 1h ago", "file"),
        draft("Checkout Flow", "Edited 3h ago", "shopping-cart"),
        draft("Profile Settings", "Edited yesterday", "user"),
        draft("Analytics Dashboard", "Edited 2 days ago", "bar-chart-3"),
    ]
}

fn draft(name: &str, edited: &str, icon: &'static str) -> RecentFile {
    RecentFile {
        name: name.into(),
        team: icon.into(),
        edited_min: edited_minutes(edited),
        edited: edited.into(),
        color: C_PANEL,
        members: vec![],
        starred: false,
        path: None,
        icon,
    }
}

// ----------------------------------------------------------------- actions

/// Panel affordances that FLIP a piece of state rather than repeat an
/// action. Two presses inside the double-click window leave them where they
/// started, which reads as "the double-click did nothing" — `run.rs`'s chrome
/// dispatch counts a repeat press of one of these once per window.
///
/// Row SELECTION (`TreeRow`, `SelectPage`, `LayerRename`) is deliberately not
/// in this set: a second press there is the rename gesture and has to reach the
/// dispatcher. Steppers (zoom, alignment, gap, duplication) are not in it
/// either — repeating those is exactly what the user asked for.
impl Action {
    pub fn is_toggle_row(&self) -> bool {
        is_toggle_row(self)
    }
}

fn is_toggle_row(a: &Action) -> bool {
    matches!(
        a,
        Action::ToggleWrap
            | Action::ToggleAspectRatio
            | Action::ToggleChildAbsolute
            | Action::ToggleInstanceProp(_)
            | Action::ToggleLayoutAdvanced
            | Action::ToggleTypoAdvanced
            | Action::ToggleVisible
            | Action::ToggleLock
            | Action::ToggleShowName
            | Action::TreeVisible(_)
            | Action::TreeLock(_)
            | Action::TreeToggle(_)
            | Action::TogglePaintVisibility(_)
            | Action::ToggleGuide(_)
            | Action::ToggleGuideVisibility
            | Action::ToggleCanvasBgVisibility
            | Action::ToggleMinimap
            | Action::ToggleColorPicker(_)
            | Action::ToggleEffectAdd
            | Action::ToggleEffectKind(_)
            | Action::ToggleEffectSettings(_)
            | Action::ToggleEffectBlend(_)
            | Action::ToggleLayerBlend
            | Action::TogglePaintBlend(_)
            | Action::ToggleVectorHandles
            | Action::ClipContent
            | Action::PaintLibToggle(_)
            | Action::FrameDropdown
            | Action::ConstraintDropdown(_)
            | Action::ZoomMenu
            | Action::LhDropdown
            | Action::TextStyleDropdown
            | Action::PaletteToggle
            | Action::OpenAppMenu
            | Action::ToggleNotifications
            | Action::ToggleFindInSelection
            | Action::ToggleCaseSensitive
            | Action::DashSortMenu
            | Action::BoardToggleGrid
            | Action::BoardToggleConnectors
            | Action::VarToggleBool(_)
            | Action::FlowDeviceToggle
            // the font-family row is the one `Action::Field` that FLIPS a
            // popover instead of opening an edit buffer (run.rs dispatch):
            // a double-click would open the picker and shut it again
            | Action::Field(FieldId::FontFamily)
    )
}

/// The two axes Figma's Constraints block speaks in: one dropdown each, five
/// answers each. The labels and pins are the table from the beginner course's
/// "Frame presets and constraints" — the first dropdown manages the horizontal
/// position, the second the vertical one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConstraintAxis {
    Horizontal,
    Vertical,
}

impl ConstraintAxis {
    /// The row's label in the panel ("Horizontal" / "Vertical").
    pub fn label(self) -> &'static str {
        match self {
            Self::Horizontal => "Horizontal",
            Self::Vertical => "Vertical",
        }
    }

    /// The menu's labels, in the order the dropdown lists them. The pin that
    /// goes with each one lives in `CONSTRAINT_H` / `CONSTRAINT_V`.
    pub fn labels(self) -> [&'static str; 5] {
        match self {
            Self::Horizontal => CONSTRAINT_H.map(|(label, _)| label),
            Self::Vertical => CONSTRAINT_V.map(|(label, _)| label),
        }
    }
}

/// Figma's Constraints menu, horizontal axis: label + pin, in menu order.
pub const CONSTRAINT_H: [(&str, x_native::HPin); 5] = [
    ("Left", x_native::HPin::Left),
    ("Right", x_native::HPin::Right),
    ("Left & Right", x_native::HPin::StretchH),
    ("Center", x_native::HPin::CenterH),
    ("Scale", x_native::HPin::ScaleH),
];

/// Figma's Constraints menu, vertical axis.
pub const CONSTRAINT_V: [(&str, x_native::VPin); 5] = [
    ("Top", x_native::VPin::Top),
    ("Bottom", x_native::VPin::Bottom),
    ("Top & Bottom", x_native::VPin::StretchV),
    ("Center", x_native::VPin::CenterV),
    ("Scale", x_native::VPin::ScaleV),
];

/// Which of the Prototype tab's two **Scroll behavior** menus is open
/// (Figma shows them in one block: "Overflow" on a frame, "Position" on an
/// object that sits on a scrolling frame).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProtoScrollMenu {
    Overflow,
    Position,
}

/// Figma's Overflow menu, in the menu's own order. `None` is "No scrolling":
/// it returns the frame to the clip state the Design tab's Clip content tick
/// owns, because our `Overflow` enum carries the clip as well as the scroll
/// (Figma keeps the two as separate settings — see the master list, row 14.13).
/// Labels and values are two parallel tables so the panel can read the captions
/// as a slice without collecting one.
pub const PROTO_OVERFLOW_LABELS: [&str; 4] =
    ["No scrolling", "Horizontal", "Vertical", "Both directions"];
pub const PROTO_OVERFLOW_VALUES: [Option<x_native::Overflow>; 4] = [
    None,
    Some(x_native::Overflow::ScrollX),
    Some(x_native::Overflow::ScrollY),
    Some(x_native::Overflow::ScrollBoth),
];

/// Figma's **Animate matching layers** tick (help 360039818874), in one
/// place: the panel paints this word and its test reads it, so the two cannot
/// drift.
pub const PROTO_MATCHING_LABEL: &str = "Animate matching layers";

/// Figma's Position menu, in the menu's own order.
pub const PROTO_POSITION_LABELS: [&str; 3] = ["Scroll with parent", "Fixed", "Sticky"];
pub const PROTO_POSITION_VALUES: [x_native::ScrollPosition; 3] = [
    x_native::ScrollPosition::ScrollWithParent,
    x_native::ScrollPosition::Fixed,
    x_native::ScrollPosition::Sticky,
];

/// Which Overflow row the frame's current setting shows.
pub fn proto_overflow_row(o: x_native::Overflow) -> usize {
    for (i, v) in PROTO_OVERFLOW_VALUES.iter().enumerate() {
        if *v == Some(o) {
            return i;
        }
    }
    0
}

/// What a press on Overflow row `row` writes. "No scrolling" needs the frame's
/// current value: a frame that was scrolling is still clipping, so it lands on
/// `Clip` rather than `Visible`.
pub fn proto_overflow_for_row(row: usize, current: x_native::Overflow) -> x_native::Overflow {
    match PROTO_OVERFLOW_VALUES[row] {
        Some(v) => v,
        None => {
            if current == x_native::Overflow::Visible {
                x_native::Overflow::Visible
            } else {
                x_native::Overflow::Clip
            }
        }
    }
}

/// Which Position row the layer's flags show.
pub fn proto_position_row(c: &x_native::ChildConstraints) -> usize {
    let pos = x_native::ScrollPosition::of(c);
    for (i, p) in PROTO_POSITION_VALUES.iter().enumerate() {
        if *p == pos {
            return i;
        }
    }
    0
}

/// The nearest ancestor frame of `id` whose Overflow scrolls — Figma shows the
/// Position row only for an object "on a frame that has scroll overflow
/// applied" (help 360039818734). Returns the frame's id.
pub fn scrollable_ancestor(root: &x_native::Node, id: &str) -> Option<String> {
    let mut best: Option<String> = None;
    fn walk(n: &x_native::Node, id: &str, best: &mut Option<String>) -> bool {
        if n.id == id {
            return true;
        }
        for c in &n.children {
            if walk(c, id, best) {
                // the NEAREST scrolling frame: the first ancestor to unwind
                // wins, so an outer scrollable frame cannot overwrite it
                if best.is_none() && n.overflow.scrollable() {
                    *best = Some(n.id.clone());
                }
                return true;
            }
        }
        false
    }
    walk(root, id, &mut best);
    best
}

/// Every interactive zone records one of these; `run.rs` dispatches them.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    LoadingRetry,
    LoadingClose,
    LoadingRecover,
    LoadingSaved,
    CancelFileOperation,
    Ctx(CtxCmd),
    /// pages-panel context menu (right-click on the page field)
    PageMenu(PageMenuCmd),
    /// Add the selected frame's first auto-layout definition.
    AddAutoLayout,
    /// auto-layout wrap toggle (selected frame's own layout)
    ToggleWrap,
    /// Figma's **Width**/**Height** dropdown on an auto-layout frame
    /// (help 360040451373): the sizing choice plus the min/max rows, which are
    /// an ADDITIONAL setting — "Minimum and maximum dimensions is an
    /// additional setting that can be used at the same time as other resizing
    /// properties". `true` is the Width field, `false` the Height one.
    LayoutAxisMenu(bool),
    /// One row of that menu: Fixed … / Hug contents.
    SetAxisSizing(bool, x_native::Sizing),
    /// "Add min width" / "Add max width" — the axis, then min (`true`) or max.
    AddAxisLimit(bool, bool),
    /// "Remove min and max" for the axis.
    ClearAxisLimits(bool),
    /// The auto-layout settings' **canvas stacking** menu (help 31289464393751).
    StackingMenu,
    SetCanvasStacking(x_native::CanvasStacking),
    /// Lock the W/H inspector fields to the current aspect ratio.
    ToggleAspectRatio,
    /// selected CHILD of an auto-layout frame: Fill container vs Fixed
    SetChildFill(bool),
    /// selected CHILD of an auto-layout frame: absolute position toggle
    ToggleChildAbsolute,
    /// component properties (A2): add a prop bound to the selected
    /// descendant of a master; remove one from the master's definition
    AddProp(x_native::ComponentPropKind),
    AddSlot,
    RemoveProp(String),
    /// instance-side edits: toggle a Bool prop / cycle a Swap prop
    // — prototyping (authoring + flow preview) —
    TokensExtractVars,
    CreateVariable(VariableKind),
    VariantCycle(i32),
    VariantCombine,
    ProtoAdd,
    ProtoRemove(usize),
    ProtoTrigger(usize),
    ProtoDest(usize, i32),
    ProtoSpeed(usize),
    /// Figma's **Animate matching layers** tick, in the interaction's
    /// animation section (help 360039818874).
    ProtoToggleMatching(usize),
    ProtoAnimation(usize),
    /// Figma's four arrows beside a Move in / Move out: the side it enters from.
    ProtoDirection(usize, x_native::Direction),
    ProtoActionType(usize),
    ProtoEasing(usize),
    ProtoToggleReset(usize),
    // ProtoAddAction / ProtoRemoveAction / ProtoSetVariable / ProtoConditional
    // were declared here and constructed nowhere, so `dispatch` could never be
    // exhaustive over them (E0004) — the app crate did not compile. Deleting
    // them is the honest fix: "add interaction" and "set variable" have no UI,
    // and removing one already goes through ProtoRemove(usize) below.
    ProtoEditDelay(usize),
    ProtoEditKey(usize),
    ProtoEditUrl(usize),
    ProtoEditVideoTime(usize),
    ProtoToggleStart,
    /// Figma's Prototype-tab **Scroll behavior** menus: which one opens, and
    /// the row a press picked in it.
    ProtoScrollMenu(ProtoScrollMenu),
    ProtoSetOverflow(usize),
    ProtoSetPosition(usize),
    /// A press in the trigger menu: interaction `i` takes `Trigger::all()[row]`
    /// — the trigger *kind* plus the value its row starts from (a delay's
    /// milliseconds, a video hit's time).
    ProtoSetTrigger(usize, usize),
    FlowEnter,
    FlowBack,
    FlowExit,
    FlowDeviceToggle,
    /// load a .ttf/.otf/.ttc into the canvas font stack
    LoadFont,
    PublishLibrary,
    ToggleInstanceProp(String),
    /// C21 INSPECT: platform picker + copy-code-to-clipboard
    InspectPlatform(usize),
    InspectCopy,
    /// Tokens panel variable management (undoable via `var_history`):
    /// delete a variable, toggle a boolean, nudge a number by `f64`.
    VarDelete(String),
    VarToggleBool(String),
    VarStep(String, f64),
    /// Undo the last variable-table edit on the open document.
    VarUndoVars,
    /// Canvas minimap (audit §9 item 3): the toggle (context menu, ⇧M, or the
    /// panel's own close button) and a navigation click — the world point that
    /// should end up centred in the viewport.
    ToggleMinimap,
    MinimapNav(f64, f64),
    /// Right-panel paint library (Figma's fill/stroke variable + style
    /// picker): open it for the named row, close it, or apply an entry.
    /// The `bool` is `is_fill` — the row this popover belongs to.
    PaintLibToggle(bool),
    PaintLibClose,
    /// Bind the selected layers' fill/stroke to a colour variable.
    ApplyPaintVariable(bool, String),
    /// Apply a named paint style to the selected layers' fill.
    ApplyPaintStyle(String),
    /// Detach the variable / paint-style link, keeping the colour it shows.
    DetachPaintBinding(bool),
    /// Libraries: pick an updated .xlib for pinned dependency `usize` and
    /// open the diff review (Assets panel LIBRARIES section).
    LibCheckUpdate(usize),
    /// Instance slots: fill `slot` from another selected layer / clear it
    /// back to the anchor (or the slot's default component).
    SlotSetFromSelection(String),
    SlotClear(String),
    /// Review dialog: repin to the newer library and re-resolve consumers.
    LibReviewAccept,
    /// Review dialog: keep the pinned version (also the click-away action).
    LibReviewClose,
    CycleInstanceSwap(String),
    ResetInstanceProps,
    /// Instance More-actions menu (Figma, help 360039150733):
    /// *"Go to main component"* and *"Push changes to main component"*, plus
    /// *"Reset > Reset [property]"* carrying the target layer's id.
    GoToMainComponent,
    PushChangesToMain,
    ResetInstanceChange(String),
    // board chrome
    BoardToggleGrid,
    BoardToggleConnectors,
    BoardNextPage,
    BoardAddPage,
    // global / dashboard
    NewFile,
    OnboardingSample,
    OnboardingBlank,
    OnboardingDismiss,
    /// Re-open the welcome / quick-start card from the app menu, the ⌘K
    /// palette or Help. Dismissing it writes the onboarding marker, which
    /// used to mean "seen once, unreachable forever after".
    ShowWelcome,
    NewBoard,
    ImportFile,
    OpenRecent(usize),
    StarRecent(usize),
    OpenDraft(usize),
    DashNav(DashView),
    /// Open/close the sort menu, pick an order.
    DashSortMenu,
    DashSortBy(DashSort),
    /// Multi-select: toggle one file, select everything visible, clear.
    DashSelect(usize),
    DashSelectAll,
    DashClearSelection,
    /// Bulk actions on the selection.
    DashBulkStar,
    DashBulkUnstar,
    DashBulkOpen,
    /// Remove the selected files from *this list* (the files on disk are
    /// untouched — the label says so).
    DashBulkRemove,
    /// The bulk bar swallows clicks inside it: without a hit rect of its own a
    /// press would fall through to the card behind the bar.
    DashBarNoop,
    DashLayout(DashLayout),
    SearchFocus,
    /// UI palette (roles live in crates/x-ui/src/design_system.rs)
    SetTheme(x_native::ui::ThemeId),
    CycleTheme,
    /// Dashboard: open the template gallery (also replaced the old dead
    /// "Invite team" quick card).
    OpenTemplates,
    CloseTemplates,
    /// Dashboard template gallery: create a new document from template `i`.
    NewFromTemplate(usize),
    AddTeam,
    // editor chrome
    SelectDoc(usize),
    CloseDoc(usize),
    Tool(Tool),
    /// Pick the Brush's style (the secondary toolbar's "style" control).
    SetBrushStyle(BrushStyle),
    LeftTab(LeftTab),
    RightTab(RightTab),
    AddPage,
    SelectPage(usize),
    DeletePage(usize),
    TreeRow(String),
    TreeToggle(String),
    /// A layer's NAME zone in the Layers panel: a single press selects the row
    /// (same as `TreeRow`), a second press inside the double-click window opens
    /// the name for inline editing — Figma's rename gesture.
    LayerRename(String),
    RenameStart,
    // inspector
    FrameDropdown,
    /// Open/close one axis of Figma's Constraints block (a layer inside a
    /// frame). One flag for both axes: only one menu is ever open.
    ConstraintDropdown(ConstraintAxis),
    /// Constraints menu item: row index into `CONSTRAINT_H` / `CONSTRAINT_V`.
    SetConstraint(ConstraintAxis, usize),
    /// Scale panel: pick an anchor cell (Figma's nine-point box).
    ScaleCell(usize),
    /// The plus on the selected layer's edge — the press that begins the
    /// connection drag.
    ConnMenu,
    /// Delete the selected connection (Figma: "you can select it and press
    /// Delete to remove it").
    ConnDelete,
    /// Toggle the zoom menu (right-panel header; audit F4)
    ZoomMenu,
    /// Zoom-menu item: 0 in, 1 out, 2 100%, 3 selection, 4 fit
    ZoomStep(usize),
    LhDropdown,
    LhMode(usize),
    /// Typography panel: the styles button opens the text-style picker
    TextStyleDropdown,
    /// Apply a named text style to the selected text layers (and link them,
    /// so later edits to the style propagate)
    ApplyTextStyle(String),
    /// Create a text style from the selected text layer's typography
    CreateTextStyle,
    /// Unlink the selected text layers from their text style, keeping values
    DetachTextStyle,
    /// Push the selection's typography into the style it is linked to and
    /// re-resolve every consumer (Figma's "Update style")
    UpdateTextStyleFromSelection,
    /// layer row hover toggles (Figma): eye / padlock
    TreeVisible(String),
    TreeLock(String),
    FramePreset(usize),
    Field(FieldId),
    FontPicker(String),
    FlowBtn(usize),
    ClipContent,
    ExportRun,
    AddFill,
    RemoveFill,
    AddStroke,
    RemoveStroke,
    AddGuide,
    RemoveGuide,
    ToggleGuide(usize),
    ToggleGuideVisibility,
    CycleExportFormat,
    CycleExportScale,
    PaletteToggle,
    PaletteRun(usize),
    ToggleVisible,
    ToggleLock,
    /// Figma's right sidebar (Layer → "Show name"): paint this frame's name on
    /// the canvas, or don't. Frames only; Sections always show theirs.
    ToggleShowName,
    /// Toggle visibility of the primary fill or stroke layer.
    TogglePaintVisibility(bool),
    /// Cycle the selected stroke between inside, center, and outside.
    CycleStrokePosition,
    /// Text formatting actions (Figma Design parity)
    /// Set horizontal text alignment. Left/Center/Right only — the shaper
    /// degrades Justified to Left, so offering it would be a phantom state.
    SetTextAlign(x_native::TextAlign),
    /// Cycle vertical text alignment: top/middle/bottom
    CycleTextAlignVertical,
    /// Cycle text decoration: none/underline/strikethrough
    CycleTextDecoration,
    /// Cycle the paragraph wrap strategy (the "tw" binding the engine
    /// actually shapes with): auto → balance → pretty → auto.
    CycleTextWrap,
    /// Progressive disclosure: the typography section's advanced rows
    /// (letter/word/para spacing, baseline shift, case, variable axes).
    ToggleTypoAdvanced,
    /// Progressive disclosure: the auto layout section's advanced rows
    /// (wrap / fill / absolute).
    ToggleLayoutAdvanced,
    /// Apply a color chosen from the native color popover.
    PaintPreset(PaintTarget, String),
    Align(usize, usize),
    /// Color picker popup toggle (fill / stroke / an effect's Fill)
    ToggleColorPicker(PaintTarget),
    CloseColorPicker,
    /// Effects section: the `+` opens the add menu (Figma's five types).
    ToggleEffectAdd,
    /// Add one effect of this type to the selected layer.
    AddEffect(x_native::EffectKind),
    /// A row's type dropdown — Figma's per-effect type menu.
    ToggleEffectKind(usize),
    SetEffectKind(usize, x_native::EffectKind),
    /// The row's *Effect settings* disclosure.
    ToggleEffectSettings(usize),
    ToggleEffectVisible(usize),
    RemoveEffect(usize),
    DuplicateEffect(usize),
    /// Reorder: dragging a row moves it in the stack (Figma's gesture).
    ToggleEffectBlend(usize),
    SetEffectBlend(usize, x_native::BlendKind),
    /// Figma's **Apply blend mode** in the Appearance section, and the same
    /// control inside a fill's or stroke's colour popover.
    ToggleLayerBlend,
    SetLayerBlend(x_native::BlendKind),
    TogglePaintBlend(PaintTarget),
    SetPaintBlend(PaintTarget, x_native::BlendKind),
    /// Pressing an effect row (not its buttons) arms the reorder drag.
    EffectRow(usize),
    /// UX Analysis actions (Quant-UX inspired)
    UxAccessibility,
    UxUserFlow,
    UxQualityScore,
    UxPatterns,
    UxContrast,
    UxResponsive,
    // X-Native workspace rail
    NavTab(NavTab),
    OpenAppMenu,
    AppMenuItem(usize),
    OpenFind,
    CloseFind,
    FindNext,
    FindPrev,
    ReplaceAll,
    /// P13: replace the occurrences in the current match only
    Replace,
    /// P14: sample a layer's fill (true) or stroke (false) onto the
    /// selection — the pipette in the right panel's paint rows
    EnableEyedropper(bool),
    /// P13: canvas background visibility toggle (Figma parity)
    ToggleCanvasBgVisibility,
    /// P13: dashboard view chip — cycle Home -> Recents -> Starred -> Trash
    CycleDashView,
    ToggleCaseSensitive,
    ToggleFindInSelection,
    ToggleNotifications,
    DismissNotification(String),
    MarkAllNotificationsRead,
    CollapseAllLayers,
    /// Clear the layers tree search (audit F8)
    TreeSearchClear,
    /// File menu actions (the app menu's file section)
    FileMoveToDrafts,
    FileDuplicate,
    // Layer management (Figma parity)
    /// Inverse selection (⌘⇧A)
    InverseSelection,
    /// Select matching objects (⌥⌘A)
    SelectMatching,
    /// Copy/paste properties
    CopyProperties,
    PasteProperties,
    /// Renumber the selected layers ("Layer 1", "Layer 2", …) as ONE undo step
    /// — the numbering half of Figma's bulk rename, without the modal
    RenumberSelection,
    /// Keyboard navigation in the layer tree (Figma: ⇧⏎ parent, Tab siblings)
    SelectChild,
    SelectParent,
    SelectNextSibling,
    SelectPrevSibling,
    // Vector Edit Mode actions (Figma parity)
    /// Enter vector edit mode (Enter key on vector node)
    EnterVectorEditMode,
    /// Exit vector edit mode (Escape or Enter again)
    ExitVectorEditMode,
    /// Select a vector point by index
    SelectVectorPoint(usize),
    /// Deselect all vector points
    DeselectVectorPoints,
    /// Move selected vector points
    MoveVectorPoints {
        dx: f64,
        dy: f64,
    },
    /// Add a point to a vector path
    AddVectorPoint {
        segment_idx: usize,
        position: (f64, f64),
    },
    /// Delete selected vector points
    DeleteVectorPoints,
    /// Toggle vector handle visibility (read by the canvas overlay)
    ToggleVectorHandles,
    /// Take an anchor's handles away: smooth point collapses to a corner
    /// (⌥-click on the point inside vector edit mode)
    RemoveBezierHandles(usize),
    /// Lasso anchors; `boundary` is in world space, like every canvas hit
    LassoSelectPoints {
        boundary: Vec<(f64, f64)>,
    },
    /// Split the path at an anchor into two vector layers
    SplitVectorPath(usize),
    /// Reverse the path's direction of travel (contour <-> hole, cap swap)
    ReversePathDirection,
    /// Join the two selected open paths end to end into one layer
    JoinSelectedPaths,
    /// Offset path along its normals (positive = outward on a closed path)
    OffsetVector {
        distance: f64,
        join: StrokeJoin,
    },
    /// Simplify path: drop anchors within `tolerance` (local units)
    SimplifyVector {
        tolerance: f64,
    },
    // Advanced Gradients, Image Adjustments, and Missing Blend Modes
    /// Flip a gradient (reverse color stops)
    FlipGradient,
    /// Rotate gradient angle
    RotateGradient {
        degrees: f64,
    },
    /// Add a color stop to a gradient at position 0.0-1.0
    AddGradientStop {
        position: f32,
        color: [u8; 3],
    },
    /// Remove a color stop from gradient
    RemoveGradientStop {
        index: usize,
    },
    /// Move a color stop to new position
    MoveGradientStop {
        index: usize,
        new_position: f32,
    },
    /// Cycle the selected stop through X-Native's authored color palette.
    /// The visible swatch action is intentionally separate from fill-wide
    /// color editing so a gradient stop never silently recolors the node.
    CycleGradientStopColor {
        index: usize,
    },
    /// Change gradient type (linear/radial/angular/diamond)
    SetGradientType {
        gradient_type: String,
    },
    /// Set image adjustments (exposure, contrast, saturation, etc.)
    SetImageAdjustments {
        adjustments: x_native::ImageAdjustments,
    },
    /// Update individual image adjustment value
    UpdateImageAdjustment {
        adjustment: String,
        value: f32,
    },
    /// Reset all image adjustments
    ResetImageAdjustments,
    /// Rotate image (90° clockwise increments)
    RotateImage {
        clockwise: bool,
    },
    /// Set image fill mode (fill/fit/crop/tile)
    SetImageFillMode {
        mode: String,
    },
}

/// Commands offered by the editor right-click context menu
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageMenuCmd {
    Rename,
    Duplicate,
    Delete,
    MoveUp,
    MoveDown,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CtxCmd {
    ToFront,
    ToBack,
    Copy,
    /// B13: serialize the selection to JSX (system clipboard + status)
    CopyAsCode,
    Cut,
    Paste,
    Duplicate,
    Delete,
    Group,
    Ungroup,
    /// Figma's Frame selection (⌥⌘G): wrap the selection in a new Frame sized
    /// to the members' collective bounds.
    FrameSelection,
    /// Figma's "Wrap in new section": wrap the selection in a labelled
    /// Section. Sections are canvas elements, so a selection inside a frame
    /// or a group is lifted to the canvas first, keeping its place.
    SectionSelection,
    MakeComponent,
    /// boolean combine of the two selected shapes (engine boolean_selected)
    Union,
    Subtract,
    Intersect,
    Exclude,
    /// Flatten selection (⌘E): bake shapes into ONE editable vector path
    Flatten,
    /// Outline stroke (⇧⌘O): a stroked shape becomes its stroke's outline
    OutlineStroke,
    /// Outline text: glyphs become an editable vector path
    OutlineText,
    /// single-step z-order (Figma ⌘] / ⌘[)
    BringFwd,
    SendBack,
    /// layers-panel row toggles, reachable from the canvas menu too
    LockSel,
    HideSel,
    SelectAll,
}

/// What a colour popover writes to. Figma applies a paint to a fill, a stroke
/// **or an effect** — *"Open the color picker in the Fill or Stroke sections …
/// then click Apply blend mode"*, and a shadow's colour is its **Fill** row —
/// so the popover's target is not a bool any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaintTarget {
    Fill,
    Stroke,
    /// The **Fill** of the effect at this index in the selected layer's stack.
    Effect(usize),
}

impl PaintTarget {
    pub fn is_fill(self) -> bool {
        matches!(self, PaintTarget::Fill)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldId {
    DocName,
    /// component property, Text kind (prop name lives in
    /// `App::instance_prop_target`)
    InstanceProp,
    /// Component master description shown in the inspector.
    ComponentDescription,
    /// pages panel: active-page inline rename (opened from the page menu)
    PageName,
    /// Tokens panel: variable value editing (target variable lives in
    /// `App::var_edit_name`, resolved at click from `var_value_rects` —
    /// same pattern as `InstanceProp`).
    VarValue,
    /// Scale panel: the multiplier. A percentage on screen ("100%"); a bare
    /// number is read as one, and an `x` suffix as a plain multiplier.
    ScaleFactor,
    /// Scale panel: the width field. Typing a number scales the selection so
    /// the box BECOMES that width — proportionally, which is the whole
    /// difference from the inspector's own W (Figma: "the other dimension
    /// field will automatically update").
    ScaleW,
    /// Scale panel: the height field, the width's mirror.
    ScaleH,
    /// Arc properties (Figma's Appearance section): where the sweep begins,
    /// in degrees.
    ArcStart,
    /// Arc properties: how far the sweep runs, in degrees — a `%` is read as
    /// a share of the circle.
    ArcSweep,
    /// Arc properties: the fraction of the radius cut out of the middle, on
    /// screen a percentage (Figma's Ratio; 0 is a solid wedge, 85 a thin ring).
    ArcRatio,
    /// Figma's Count, on the two shapes that carry one: a polygon's sides, a
    /// star's points. Both are 3..60 and neither moves the box.
    ShapeCount,
    /// Figma's Ratio on a star: the inner points' distance from the centre, on
    /// screen a percentage of the radius.
    StarRatio,
    /// Tokens panel: variable name editing (rename-as-alias; same target
    /// resolution as `VarValue`, from `var_name_rects`).
    VarName,
    /// layers panel: inline layer rename, opened by double-clicking a layer
    /// NAME (Figma). The node being renamed lives in `App::layer_edit_id`.
    LayerName,
    /// layers panel: tree search query (row above the tree; audit F8).
    /// Enter keeps the field open — the query lives in
    /// `OpenDoc::tree_search` and filters the tree live.
    TreeSearch,
    W,
    H,
    X,
    Y,
    Rotation,
    Opacity,
    Radius,
    FillHex,
    FillAlpha,
    StrokeHex,
    StrokeAlpha,
    StrokeWeight,
    Gap,
    PadH,
    PadV,
    /// Figma's min/max dimensions on an auto-layout frame: the two fields the
    /// Width/Height dropdown's "Add min …"/"Add max …" rows create.
    MinWidth,
    MaxWidth,
    MinHeight,
    MaxHeight,
    FontFamily,
    FontWeight,
    FontSize,
    LineHeight,
    LetterSpacing,
    WordSpacing,
    ParaSpacing,
    BaselineShift,
    TextCase,
    OpticalSize,
    WidthAxis,
    /// Maximum lines for text truncation
    MaxLines,
    /// Paragraph indent (first-line indent in pixels)
    ParagraphIndent,
    ExportSuffix,
    GuideSize,
    /// No-selection DESIGN panel: editor canvas background hex
    CanvasBg,
    /// No-selection DESIGN panel: pixel grid color hex
    GridColor,
    /// No-selection DESIGN panel: pixel grid opacity %
    GridPct,
    /// Right-panel zoom % box
    Zoom,
    /// No-selection DESIGN panel: canvas background opacity %
    CanvasBgAlpha,
    /// Find panel: search query (Enter keeps the field open, like
    /// `TreeSearch`; the query lives in `App::find_replace`)
    FindQuery,
    /// Find panel: replacement string
    FindReplace,
    /// Effects list: one numeric setting of one effect (Figma's X / Y / Blur /
    /// Radius / Density rows). Which field is which comes from the model
    /// ([`x_native::EffectField`]) — the index is the row's place in the stack.
    EffectX(usize),
    EffectY(usize),
    EffectBlur(usize),
    EffectRadius(usize),
    EffectDensity(usize),
}

impl FieldId {
    /// The field a settings row edits, for the effect at `index`.
    pub fn for_effect(index: usize, field: x_native::EffectField) -> FieldId {
        match field {
            x_native::EffectField::X => FieldId::EffectX(index),
            x_native::EffectField::Y => FieldId::EffectY(index),
            x_native::EffectField::Blur => FieldId::EffectBlur(index),
            x_native::EffectField::Radius => FieldId::EffectRadius(index),
            x_native::EffectField::Density => FieldId::EffectDensity(index),
        }
    }
    /// The effect row and setting this field edits — the inverse, so the text
    /// commit path has ONE place to resolve an effect field from.
    pub fn effect_target(self) -> Option<(usize, x_native::EffectField)> {
        match self {
            FieldId::EffectX(i) => Some((i, x_native::EffectField::X)),
            FieldId::EffectY(i) => Some((i, x_native::EffectField::Y)),
            FieldId::EffectBlur(i) => Some((i, x_native::EffectField::Blur)),
            FieldId::EffectRadius(i) => Some((i, x_native::EffectField::Radius)),
            FieldId::EffectDensity(i) => Some((i, x_native::EffectField::Density)),
            _ => None,
        }
    }
}

/// An armed `AfterDelay` trigger in the flow preview: fire `action` when
/// the wall clock reaches `at`. `source_overlay` pins delays authored
/// inside an overlay: closing the overlay disarms them.
#[derive(Clone, Debug)]
pub struct FlowDelay {
    pub at: std::time::Instant,
    pub source_overlay: Option<String>,
    pub action: x_native::Action,
    pub ms: u32,
}

/// Hamburger menu state (Figma navigation bar top menu).
#[derive(Clone, Debug, Default)]
pub struct AppMenu {
    pub open: bool,
    pub hover_index: Option<usize>,
}

/// Find/Replace panel state (Figma left sidebar search).
#[derive(Clone, Debug, Default)]
pub struct FindReplace {
    pub open: bool,
    pub show_replace: bool,
    pub query: String,
    pub replace: String,
    pub case_sensitive: bool,
    pub in_selection: bool,
    pub match_count: usize,
    pub current_match: usize,
    /// P13: ids of the matched text layers, document order (rebuilt by
    /// `App::rescan_find`)
    pub matches: Vec<String>,
}

/// Notification center state (Figma navigation bar bottom).
#[derive(Clone, Debug)]
pub struct NotificationCenter {
    pub open: bool,
    pub notifications: Vec<Notification>,
    pub unread_count: usize,
}

impl Default for NotificationCenter {
    fn default() -> Self {
        Self {
            open: false,
            notifications: vec![
                Notification {
                    id: "font-missing".into(),
                    kind: NotificationKind::MissingFont,
                    message: "Inter font not installed — using fallback".into(),
                    timestamp: 0,
                    read: false,
                },
                Notification {
                    id: "lib-update".into(),
                    kind: NotificationKind::LibraryUpdate,
                    message: "2 library components have updates available".into(),
                    timestamp: 0,
                    read: false,
                },
            ],
            unread_count: 2,
        }
    }
}

/// A single notification entry.
#[derive(Clone, Debug)]
pub struct Notification {
    pub id: String,
    pub kind: NotificationKind,
    pub message: String,
    pub timestamp: u64,
    pub read: bool,
}

/// Notification type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationKind {
    LibraryUpdate,
    MissingFont,
    OfflineStatus,
    ComponentUpdate,
}

impl NotificationKind {
    pub fn icon(self) -> &'static str {
        match self {
            NotificationKind::LibraryUpdate => "rotate-cw",
            NotificationKind::MissingFont => "type",
            NotificationKind::OfflineStatus => "eye-off",
            NotificationKind::ComponentUpdate => "component",
        }
    }
}

/// Library update review: a newer .xlib was picked for a pinned dependency
/// and its diff is awaiting Accept / Keep. `dep_index` points into
/// `Document::library_deps` at accept time.
#[derive(Clone)]
pub struct LibReview {
    pub dep_index: usize,
    pub library_id: String,
    pub path: std::path::PathBuf,
    pub newer: x_native::Library,
    pub changes: Vec<x_native::LibraryChange>,
}

/// Flow-preview state: prototype playback in a chrome-less viewer over the
/// live canvas. The viewer focuses `current`, `stack` backs navigation,
/// `overlays` float above the screen.
///
/// `vars` is the preview's OWN variable store, cloned from the document
/// when the preview starts: expression evaluation, `SetVar`/`SetMode`,
/// and conditionals all run against it, so playback can never edit the
/// file. (No `PartialEq`: [`x_native::Variables`] deliberately doesn't
/// implement it — use field asserts in tests.)
#[derive(Clone, Debug, Default)]
pub struct FlowState {
    pub current: String,
    pub stack: Vec<String>,
    /// open overlay stack, bottom → top (the shared engine type, so the
    /// preview and the editor player can't disagree on its shape).
    pub overlays: Vec<x_native::editor::Overlay>,
    /// preview-owned variables (see above).
    pub vars: x_native::Variables,
    /// armed `AfterDelay` triggers, in arm order.
    pub delays: Vec<FlowDelay>,
    /// node id under the pointer (drives hover / enter / leave).
    pub hovered: Option<String>,
    /// a press is down inside the viewer (drag detection armed).
    pub dragging: bool,
    /// `OnDrag` already fired for this press-drag-release cycle.
    pub drag_fired: bool,
    /// armed Figma "while hovering" auto-reverse (engine `WhileSpan`).
    pub hover_span: Option<x_native::editor::WhileSpan>,
    /// armed Figma "while pressing" auto-reverse (reverts on release).
    pub press_span: Option<x_native::editor::WhileSpan>,
    /// Preview device chrome toggle (mobile/tablet frame presentation).
    pub device_frame: bool,
    /// the running Figma **Animate matching layers** transition, when the
    /// last navigation asked for one — the shared engine's tick, so the
    /// viewer and the editor player cannot disagree on its shape.
    pub tick: Option<x_native::editor::SmartTick>,
}

/// Clipboard for copying/pasting layer properties (Figma parity)
#[derive(Clone, Debug)]
pub struct PropertyClipboard {
    pub fill: Option<x_native::Paint>,
    pub stroke: Option<x_native::Stroke>,
    pub effects: Vec<x_native::Effect>,
    pub opacity: Option<f32>,
    pub corner_radius: Option<f64>,
}

// Vector Edit Mode (Figma parity)
/// Vector edit mode state. Mirrors the engine's own three fields
/// (`Editor::vector_edit_active` / `_node` / `_selected_points`) so the canvas
/// overlay can draw anchors and handles without borrowing the document.
#[derive(Debug, Clone)]
pub struct VectorEditMode {
    pub active: bool,
    pub selected_node: Option<String>,
    pub selected_points: Vec<usize>,
    pub show_handles: bool,
}

impl Default for VectorEditMode {
    fn default() -> Self {
        Self {
            active: false,
            selected_node: None,
            selected_points: Vec::new(),
            show_handles: true,
        }
    }
}

/// The one text-entry surface: clicking a field focuses it; keystrokes go
/// into `buffer`; Enter commits, Esc cancels.
#[derive(Clone, Debug)]
pub struct FieldEdit {
    pub id: FieldId,
    pub buffer: String,
}

// ------------------------------------------------------------ drag / input

/// P12: a resolved layers-tree drop: the hovered row (`row` + `zone`
/// for the indicator) and the tree coordinates to commit (`parent` +
/// logical `index`).
#[derive(Clone, Debug, PartialEq)]
pub struct TreeDrop {
    pub row: String,
    pub zone: u8,
    pub parent: String,
    pub index: usize,
}

#[derive(Clone, Debug)]
pub enum Drag {
    LeftPanel {
        start_x: f64,
        start_w: f64,
    },
    RightPanel {
        start_x: f64,
        start_w: f64,
    },
    /// Dragging the canvas with Hand tool / middle mouse / space.
    Pan {
        start: Point,
        start_pan: (f64, f64),
    },
    /// Effects list reorder (Figma: *"you click and drag the handles to
    /// reorder the effects"*). A press on a row arms it; passing the drag
    /// threshold makes it live, and the row under the pointer becomes `over`.
    EffectRow {
        from: usize,
        start: Point,
        active: bool,
        over: Option<usize>,
    },
    /// Moving the current selection.
    MoveSel {
        last: Point,
        /// Undo-stack depth when the press started the gesture. Every
        /// mouse event pushes its own `Command::Move`, so release merges
        /// `undo_depth() - base_depth` entries into ONE undo step (one
        /// Ctrl+Z reverts the whole drag).
        base_depth: usize,
    },
    /// Rubber-band selection. `deep` is the ⌘/Ctrl modifier read at press: it
    /// decides whether layers nested inside a frame can answer, which is the
    /// one thing Figma's ⌘-drag marquee adds to a plain one.
    Marquee {
        start: Point,
        cur: Point,
        deep: bool,
    },
    /// P12: dragging a layers-tree row. `active` once the pointer moved
    /// past the threshold; `over` = live drop target (row id, zone:
    /// 0 before, 1 child, 2 after).
    TreeRow {
        id: String,
        start: Point,
        active: bool,
        over: Option<TreeDrop>,
    },
    /// Drag-selecting text inside the open inline editor.
    TextEditSel,
    /// dragging a ruler guide ('v' top ruler / 'h' left ruler); the world
    /// coord tracks the cursor; release inside the ruler cancels
    Guide {
        axis: char,
    },
    /// Scrubbing the minimap: the viewport follows the pointer, so the whole
    /// page is reachable without a single pan gesture.
    Minimap,
    /// Shape-tool drag-create.
    Create {
        tool: Tool,
        start: Point,
        cur: Point,
    },
    /// Corner-resize of the selection (corner idx: 0 TL, 1 TR, 2 BL, 3 BR).
    ResizeSel {
        corner: usize,
        orig: (f64, f64, f64, f64), // x, y, w, h at drag start
        start: Point,
        /// Undo-stack depth at press; release merges the per-event resize
        /// entries into ONE undo step (see `MoveSel::base_depth`).
        base_depth: usize,
    },
    /// Scale-tool drag (K): the selection box grows about the corner the
    /// pointer is NOT holding. `parts` is built once at press — the anchor is
    /// the fixed point of the mapping, so it never moves, and `applied` is the
    /// factor already committed by this gesture (each move applies the RATIO
    /// to what is on screen, which is what keeps the drag incremental).
    ScaleSel {
        corner: usize,
        orig: (f64, f64, f64, f64), // x, y, w, h at drag start
        start: Point,
        base_depth: usize,
        parts: Vec<(String, f64, f64)>, // (id, anchor x, anchor y) in parent space
        applied: f64,
    },
    /// Scale-tool BODY drag (K): Figma's "hover over the object's bounding box
    /// ... then click-and-drag to resize". The anchor is the corner opposite
    /// the nearest one to the press, and the press point itself rides the
    /// pointer — the panel's anchor box is a setting for its multiplier and
    /// dimension fields, not for the canvas gesture.
    ScaleBody {
        orig: (f64, f64, f64, f64), // x, y, w, h at drag start
        anchor: (f64, f64),
        grab: Point,
        base_depth: usize,
        parts: Vec<(String, f64, f64)>, // (id, anchor x, anchor y) in parent space
        applied: f64,
    },
    /// Figma's canvas connection gesture: the circle on the selected layer's
    /// edge, dragged towards another frame. "Figma will snap the connection
    /// noodle to the Case study frame when you get close enough. Release your
    /// cursor to complete the connection."
    ProtoConnect {
        src: String,
        cur: Point,
        /// The frame the noodle is currently snapped to, if any.
        target: Option<String>,
    },
    /// Figma's arc handles on an ellipse or an arc (K is not involved: the
    /// handles belong to the layer, and they are dragged with the Move tool —
    /// A polygon's or star's Count handle — and, on a star, its Ratio handle.
    /// `f0` is the pointer's radial fraction when the press took hold, so the
    /// Count gesture is measured from where the drag began.
    ShapeHandle {
        id: String,
        part: ShapePart,
        count: usize,
        f0: f64,
        base_depth: usize,
    },
    /// "hover your cursor over the ellipse until you see the Arc handle").
    /// The kind of the layer is written on every move, so what is on screen is
    /// already the shape the release commits; the box never moves.
    ArcHandle {
        id: String,
        part: ArcPart,
        /// The arc as it was when the drag started — every move recomputes
        /// from these, so the gesture cannot accumulate rounding.
        start: f64,
        end: f64,
        ratio: f64,
        base_depth: usize,
    },
    /// Pen-tool polyline in progress (world-space points).
    Pen {
        points: Vec<Point>,
        cursor: Option<Point>,
    },
    /// Eraser tool stroke in progress.
    Erase {
        start: Point,
        cur: Point,
    },
    /// Dragging the selected anchors of the node in vector edit mode. The
    /// ENGINE holds the gesture snapshot (`Editor::begin_path_gesture`), so the
    /// whole drag commits as one undo entry and this only has to remember the
    /// last pointer position to turn it into a delta.
    VectorPoint {
        last: Point,
    },
    /// Dragging one bezier control handle. `outgoing` picks the side of the
    /// anchor; Alt while dragging breaks the tangent instead of mirroring it.
    /// No last-position field: a handle follows the pointer absolutely (in the
    /// node's local space), it is not accumulated from deltas.
    VectorHandle {
        anchor_idx: usize,
        outgoing: bool,
    },
    /// Rubber-band over anchors (point selection inside vector edit mode). A
    /// release without movement is a click on empty canvas, which deselects
    /// the anchors rather than the layer.
    VectorLasso {
        start: Point,
        cur: Point,
    },
    /// Pen tool dragging an anchor: pulls bezier handles out of a corner point
    /// (Figma's pen drag), mirrored so the point stays smooth unless Alt is held.
    /// Absolute, like `VectorHandle`, so it carries no last position either.
    VectorBend {
        anchor_idx: usize,
    },
    /// Board: Creating a sticky note.
    BoardCreateSticky {
        start: Point,
        cur: Point,
        color_idx: usize,
    },
    /// Board: Drawing a connector between nodes.
    BoardConnector {
        from_node: String,
        from_point: Point,
        to_point: Point,
    },
    /// Board: Moving a board node.
    BoardMoveNode {
        node_id: String,
        start: Point,
        cur: Point,
    },
    /// Board: Rubber-band selection on infinite canvas.
    BoardMarquee {
        start: Point,
        cur: Point,
    },
    /// Board: Pan on infinite canvas (Hand tool).
    BoardPan {
        start: Point,
        start_pan: (f64, f64),
    },
    /// Pencil: the freehand stroke in progress. Points are world space; the
    /// layer it joins is decided on release by the same draw-it-in rule every
    /// other creation tool follows.
    Pencil {
        points: Vec<Point>,
    },
    /// Brush: the painted stroke in progress. Sampled exactly like the pencil's
    /// — the two tools share the gesture and differ in the mark they leave.
    Brush {
        points: Vec<Point>,
    },
    /// Board: Pen tool freehand drawing.
    BoardPen {
        id: String,
        points: Vec<Point>,
    },
}

// -------------------------------------------------------------- open files

/// One open document = one editor tab.
pub struct OpenDoc {
    /// Imported source is never a native save destination.
    pub source_path: Option<PathBuf>,
    pub disk_hash: Option<String>,
    pub canonical_path: Option<PathBuf>,
    pub envelope: crate::session::Envelope,
    pub recovery_path: PathBuf,
    pub last_autosave_revision: Option<u64>,
    pub autosave_note: Option<String>,
    pub history: crate::session::History,
    pub assets: x_native::Assets,
    pub frame_cache: x_native::FrameCache,
    pub prepared_canvas: Option<crate::loading::PreparedCanvas>,
    pub name: String,
    pub path: Option<PathBuf>,
    /// v45 mock: the left-panel file-name row text (HTML `file-name-text`)
    /// — the mock keeps it independent from the active tab name; None
    /// falls back to `name`.
    pub file_label: Option<String>,
    /// Seeded mock tabs keep reference tab widths (a few px past the text
    /// advances, like a browser's flex tab layout);
    /// None → derive from the text measure (user-created tabs).
    pub tab_w: Option<f64>,
    pub doc: Document,
    pub editors: Vec<Editor>,
    pub page: usize,
    pub dirty: bool,
    pub expanded: HashSet<String>,
    /// layers tree search query (audit F8); non-empty → the tree renders
    /// only the matches plus their ancestor chain
    pub tree_search: String,
    pub left_tab: LeftTab,
    pub right_tab: RightTab,
    pub frame_preset: usize,
    pub flow: usize,
    /// v45 mock boot state: flow pills 0 AND 2 carry .active in the HTML
    /// (duplicated class in the mock); first user click takes over
    pub flow_boot_mock: bool,
    pub gap: f64,
    pub pad_h: f64,
    pub pad_v: f64,
    pub export_format: usize, // 0 PNG 1 JPG 2 SVG 3 PDF 4 SKETCH
    pub export_scale: usize,  // 0 1x 1 2x
    pub export_suffix: String,
    /// Undo log for variable-table edits (rename/delete/value), backed by
    /// `x_editor::variable_commands`. Session-scoped: it does not persist
    /// with the file (the node-tree undo stack doesn't either).
    pub var_history: x_native::editor::VariableHistory,
    pub guide_kind: usize, // 0 Square 1 Grid
    pub guide_size: f64,
    /// Whether the selected frame's layout-guide overlay is visible.
    pub guides_visible: bool,
    pub scroll_left: f64,
    pub scroll_right: f64,
    /// Ruler guides: ('v' | 'h', world coord along the canvas axis)
    pub guides: Vec<(char, f64)>,
    /// guide being dragged (live preview line)
    pub guide_drag: Option<(char, f64)>,
    /// Board document for infinite canvas mode
    pub board_doc: Option<x_board::BoardDocument>,
    /// Color picker popup state for fill
    pub color_picker_fill_open: bool,
    /// Color picker popup state for stroke
    pub color_picker_stroke_open: bool,
}

impl OpenDoc {
    /// The v45 HTML editor mock's boot document: file "Liquor Delivery App
    /// UI" on Page 3 of 3 with the Frame board (375×420 @ 0,60) as content.
    /// The left panel renders this document's real tree — there is no
    /// separate mock layer list to drift from it.
    pub fn demo_doc() -> Self {
        let mut d = OpenDoc::demo_blank("DESIGN_SYSTEM.md".into());
        d.file_label = Some("Liquor Delivery App UI".into());
        // reference tab widths: 120 | 178 | 128
        d.tab_w = Some(178.0);
        d.flow_boot_mock = true;
        // Two empty pages in front — the mock shows the "Page 3" field and
        // the PAGE 3 tree header with this document's board as Page 3.
        for n in [1usize, 2] {
            let mut p = Node::frame(&format!("page-empty-{n}"), 1440.0, 1024.0);
            p.name = format!("Page {n}");
            d.editors
                .insert(n - 1, x_native::editor::Editor::new(p.clone()));
            d.doc.pages.insert(n - 1, p);
        }
        d.page = 2;
        d
    }

    /// A small, real learning file used by first-launch onboarding: it has
    /// two prototype screens, a component, a slot, and variables so the
    /// welcome walkthrough can be explored instead of showing an empty mock.
    pub fn getting_started() -> Self {
        let mut page = Node::frame("getting-started-page", 1440.0, 1024.0);
        page.name = "Getting Started".into();
        let mut home = Node::frame("screen-home", 375.0, 812.0);
        home.name = "Home screen".into();
        home.transform.x = 80.0;
        home.transform.y = 80.0;
        home.fill = Paint::Solid(VelloColor::from_rgb8(0xF8, 0xFA, 0xFC));
        let mut title = Node::text(
            "welcome-title",
            24.0,
            32.0,
            327.0,
            40.0,
            "Welcome to X-Native",
        );
        title
            .bindings
            .insert("font".into(), APP_DEFAULT_FONT.into());
        home.children.push(title);
        let mut button = Node::rect(
            "try-button",
            24.0,
            120.0,
            180.0,
            48.0,
            VelloColor::from_rgb8(0x4F, 0x46, 0xE5),
        );
        button.name = "Try prototype".into();
        button
            .interactions
            .push(x_native::Interaction::click("screen-detail"));
        home.children.push(button);
        let mut detail = Node::frame("screen-detail", 375.0, 812.0);
        detail.name = "Detail screen".into();
        detail.transform.x = 520.0;
        detail.transform.y = 80.0;
        detail.fill = Paint::Solid(VelloColor::WHITE);
        detail.children.push(Node::text(
            "detail-title",
            24.0,
            32.0,
            327.0,
            40.0,
            "Prototype destination",
        ));
        let mut card = Node::component("card-master", "Starter Card", 280.0, 120.0);
        card.name = "Card component".into();
        card.props.push(x_native::ComponentProp::Slot {
            name: "Content".into(),
            target: "card-master".into(),
            default: None,
        });
        card.children.push(Node::text(
            "card-label",
            16.0,
            16.0,
            248.0,
            28.0,
            "Component with a slot",
        ));
        page.children.extend([home, detail, card]);
        let editor = Editor::new(page.clone());
        let mut doc = Document {
            pages: vec![page],
            default_font: Some(APP_DEFAULT_FONT.into()),
            ..Document::default()
        };
        doc.variables.colors.insert(
            "color/brand".into(),
            VelloColor::from_rgb8(0x4F, 0x46, 0xE5),
        );
        doc.variables.numbers.insert("space/page".into(), 24.0);
        let mut out = Self::from_document("Getting Started".into(), None, doc);
        out.editors = vec![editor];
        out
    }

    pub fn new_blank(name: String) -> Self {
        let mut page = Node::frame(&x_native::fresh_id("page"), 1440.0, 1024.0);
        page.name = "Page 1".into();
        Self::from_document(
            name,
            None,
            Document {
                pages: vec![page],
                // P3: a new file declares its default typeface as data
                default_font: Some(APP_DEFAULT_FONT.to_string()),
                ..Default::default()
            },
        )
    }

    // ---------------------------------------------------------- templates

    /// Built-in templates for the dashboard gallery: (name, blurb, icon).
    /// Each row carries its OWN glyph — the gallery opened with the same
    /// `layout-template` chip on all four rows, which reads as placeholder art.
    pub const TEMPLATES: [(&str, &str, &str); 4] = [
        (
            "Mobile app flow",
            "Two linked screens with a working prototype",
            "frame",
        ),
        (
            "Landing page",
            "1440 desktop hero with nav, CTA and feature cards",
            "layout-list",
        ),
        (
            "Design system",
            "Color variables, swatches and a Button component",
            "component",
        ),
        (
            "Starter board",
            "Freeform brainstorm canvas for quick ideas",
            "sticky-note",
        ),
    ];

    fn seed_brand_vars(doc: &mut Document) {
        doc.variables
            .colors
            .insert("color/brand".into(), Color::from_rgb8(0x6B, 0x49, 0xF5));
        doc.variables.numbers.insert("space/page".into(), 24.0);
        doc.variables.numbers.insert("radius/card".into(), 12.0);
    }

    fn text(id: &str, x: f64, y: f64, w: f64, h: f64, s: &str) -> Node {
        let mut t = Node::text(id, x, y, w, h, s);
        t.bindings.insert("font".into(), APP_DEFAULT_FONT.into());
        t
    }

    /// Build the built-in template `i` as a fresh document COPY (templates
    /// are code, so every open is independent). `None` out of range.
    pub fn template_doc(i: usize) -> Option<Self> {
        let brand = Color::from_rgb8(0x6B, 0x49, 0xF5);
        match i {
            0 => {
                // Mobile app flow: two linked screens + tab bars.
                let mut page = Node::frame(&x_native::fresh_id("page"), 1440.0, 1024.0);
                page.name = "Mobile flow".into();
                let mut home = Node::frame("screen-home", 375.0, 812.0);
                home.name = "Home".into();
                home.transform.x = 80.0;
                home.transform.y = 60.0;
                home.fill = Paint::Solid(Color::from_rgb8(0xF8, 0xFA, 0xFC));
                home.children
                    .push(Self::text("m-title", 24.0, 48.0, 327.0, 40.0, "Today"));
                let mut cta = Node::rect("m-cta", 24.0, 120.0, 327.0, 52.0, brand);
                cta.name = "Start".into();
                cta.corner_radii = Some([12.0, 12.0, 12.0, 12.0]);
                cta.interactions
                    .push(x_native::Interaction::click("screen-detail"));
                home.children.push(cta);
                let mut tabs = Node::rect(
                    "m-tabs",
                    0.0,
                    748.0,
                    375.0,
                    64.0,
                    Color::from_rgb8(0x1B, 0x1D, 0x23),
                );
                tabs.name = "Tab bar".into();
                home.children.push(tabs);
                let mut detail = Node::frame("screen-detail", 375.0, 812.0);
                detail.name = "Detail".into();
                detail.transform.x = 520.0;
                detail.transform.y = 60.0;
                detail.fill = Paint::Solid(Color::WHITE);
                detail
                    .children
                    .push(Self::text("d-title", 24.0, 48.0, 327.0, 40.0, "Detail"));
                page.children.extend([home, detail]);
                let editor = Editor::new(page.clone());
                let mut doc = Document {
                    pages: vec![page],
                    default_font: Some(APP_DEFAULT_FONT.into()),
                    ..Document::default()
                };
                Self::seed_brand_vars(&mut doc);
                let mut out = Self::from_document("Mobile app flow".into(), None, doc);
                out.editors = vec![editor];
                Some(out)
            }
            1 => {
                // Landing page: nav, hero, CTA, feature cards.
                let mut page = Node::frame(&x_native::fresh_id("page"), 1440.0, 1100.0);
                page.name = "Landing".into();
                let mut hero = Node::frame("lp-hero", 1440.0, 900.0);
                hero.name = "Hero".into();
                hero.fill = Paint::Solid(Color::from_rgb8(0x0B, 0x0B, 0x0F));
                let mut nav = Node::rect(
                    "lp-nav",
                    0.0,
                    0.0,
                    1440.0,
                    64.0,
                    Color::from_rgb8(0x1B, 0x1D, 0x23),
                );
                nav.name = "Nav".into();
                hero.children.push(nav);
                hero.children
                    .push(Self::text("lp-brand", 64.0, 18.0, 200.0, 28.0, "X-Native"));
                hero.children.push(Self::text(
                    "lp-h1",
                    64.0,
                    260.0,
                    900.0,
                    120.0,
                    "Design anything. Ship it native.",
                ));
                hero.children.push(Self::text(
                    "lp-sub",
                    64.0,
                    400.0,
                    640.0,
                    60.0,
                    "A local-first design tool with a plain-JSON file format.",
                ));
                let mut cta = Node::rect("lp-cta", 64.0, 500.0, 220.0, 56.0, brand);
                cta.name = "Get started".into();
                cta.corner_radii = Some([12.0, 12.0, 12.0, 12.0]);
                hero.children.push(cta);
                for (name, x) in ["Fast", "Local", "Free"].iter().zip([64.0, 384.0, 704.0]) {
                    let mut c = Node::rect(
                        &format!("lp-card-{}", name.to_lowercase()),
                        x,
                        640.0,
                        288.0,
                        160.0,
                        Color::from_rgb8(0x1B, 0x1D, 0x23),
                    );
                    c.name = format!("Feature {name}");
                    c.corner_radii = Some([12.0, 12.0, 12.0, 12.0]);
                    hero.children.push(c);
                }
                page.children.push(hero);
                let editor = Editor::new(page.clone());
                let mut doc = Document {
                    pages: vec![page],
                    default_font: Some(APP_DEFAULT_FONT.into()),
                    ..Document::default()
                };
                Self::seed_brand_vars(&mut doc);
                let mut out = Self::from_document("Landing page".into(), None, doc);
                out.editors = vec![editor];
                Some(out)
            }
            2 => {
                // Design system: swatches + type labels + a Button master.
                let mut page = Node::frame(&x_native::fresh_id("page"), 1440.0, 1024.0);
                page.name = "Foundations".into();
                for (k, (name, hex)) in [
                    ("brand", 0x6B49F5u32),
                    ("ink", 0x111318),
                    ("surface", 0xFFFFFF),
                    ("success", 0x4CD966),
                    ("danger", 0xEF9A94),
                ]
                .iter()
                .enumerate()
                {
                    let x = 64.0 + k as f64 * 200.0;
                    let mut sw = Node::rect(
                        &format!("sw-{name}"),
                        x,
                        80.0,
                        160.0,
                        160.0,
                        Color::from_rgb8((*hex >> 16) as u8, (*hex >> 8) as u8, *hex as u8),
                    );
                    sw.name = format!("color/{name}");
                    sw.corner_radii = Some([12.0, 12.0, 12.0, 12.0]);
                    page.children.push(sw);
                    page.children.push(Self::text(
                        &format!("swl-{name}"),
                        x,
                        252.0,
                        160.0,
                        24.0,
                        &format!("color/{name}"),
                    ));
                }
                page.children.push(Self::text(
                    "ts-display",
                    64.0,
                    360.0,
                    600.0,
                    56.0,
                    "Display",
                ));
                page.children
                    .push(Self::text("ts-h", 64.0, 440.0, 400.0, 40.0, "Heading"));
                page.children.push(Self::text(
                    "ts-body",
                    64.0,
                    520.0,
                    400.0,
                    24.0,
                    "Body copy for real interfaces.",
                ));
                let mut btn = Node::component("btn-master", "Button", 160.0, 48.0);
                btn.name = "Button".into();
                btn.fill = Paint::Solid(brand);
                btn.corner_radii = Some([10.0, 10.0, 10.0, 10.0]);
                btn.props.push(x_native::ComponentProp::Text {
                    name: "Label".into(),
                    target: "btn-label".into(),
                    default: "Press me".into(),
                });
                btn.children
                    .push(Self::text("btn-label", 16.0, 12.0, 128.0, 24.0, "Press me"));
                page.children.push(btn);
                let editor = Editor::new(page.clone());
                let mut doc = Document {
                    pages: vec![page],
                    default_font: Some(APP_DEFAULT_FONT.into()),
                    ..Document::default()
                };
                Self::seed_brand_vars(&mut doc);
                let mut out = Self::from_document("Design system".into(), None, doc);
                out.editors = vec![editor];
                Some(out)
            }
            3 => {
                // Starter board: freeform brainstorm canvas.
                use x_board::{BoardDocument, BoardKind};
                let mut od = Self::new_blank("Starter board".into());
                od.doc.kind = x_native::DocumentKind::Board;
                od.board_doc = Some(BoardDocument::new("Starter board", BoardKind::Brainstorm));
                Some(od)
            }
            _ => None,
        }
    }

    pub fn demo_blank(name: String) -> Self {
        let mut page = Node::frame("page-1", 1440.0, 1024.0);
        page.name = "Page 1".into();
        // The v45 canvas shows one white 375x420 frame at X 0 Y 60.
        let mut f = Node::frame("frame-1", 375.0, 420.0);
        f.name = "Frame".into();
        f.transform.x = 0.0;
        f.transform.y = 60.0;
        f.fill = Paint::Solid(VelloColor::from_rgb8(0xFF, 0xFF, 0xFF));
        // v45 mock: `rounded-[8px] shadow-2xl` on the canvas frame
        f.corner_radii = Some([8.0, 8.0, 8.0, 8.0]);
        page.children.push(f);
        let editor = Editor::new(page.clone());
        let doc = Document {
            pages: vec![page],
            // P3: the demo document declares its default typeface too
            default_font: Some(APP_DEFAULT_FONT.to_string()),
            ..Document::default()
        };
        Self {
            name,
            path: None,
            source_path: None,
            disk_hash: None,
            canonical_path: None,
            envelope: Default::default(),
            recovery_path: crate::session::new_recovery_path(),
            last_autosave_revision: None,
            autosave_note: None,
            history: Default::default(),
            assets: x_native::Assets::new(),
            frame_cache: x_native::FrameCache::new(),
            prepared_canvas: None,
            file_label: None,
            tab_w: None,
            doc,
            editors: vec![editor],
            page: 0,
            dirty: false,
            expanded: HashSet::new(),
            tree_search: String::new(),
            left_tab: LeftTab::Layers,
            right_tab: RightTab::Design,
            frame_preset: 0,
            flow: 0,
            flow_boot_mock: false,
            gap: 5.0,
            pad_h: 0.0,
            pad_v: 0.0,
            export_format: 0,
            export_scale: 0,
            export_suffix: String::new(),
            var_history: Default::default(),
            guide_kind: 0,
            guide_size: 16.0,
            // the canvas grid is OPT-IN: a fresh document opens clean
            guides_visible: false,
            scroll_left: 0.0,
            scroll_right: 0.0,
            guides: vec![],
            guide_drag: None,
            board_doc: None,
            color_picker_fill_open: false,
            color_picker_stroke_open: false,
        }
    }

    pub fn from_document(name: String, path: Option<PathBuf>, mut doc: Document) -> Self {
        if doc.pages.is_empty() {
            doc.pages.push(Node::frame("page-1", 1440.0, 1024.0));
        }
        let editors = doc.pages.iter().map(|p| Editor::new(p.clone())).collect();
        let canonical_path = path.as_ref().and_then(|p| p.canonicalize().ok());
        Self {
            name,
            path,
            source_path: None,
            disk_hash: None,
            canonical_path,
            envelope: Default::default(),
            recovery_path: crate::session::new_recovery_path(),
            last_autosave_revision: None,
            autosave_note: None,
            history: Default::default(),
            assets: x_native::Assets::new(),
            frame_cache: x_native::FrameCache::new(),
            prepared_canvas: None,
            file_label: None,
            tab_w: None,
            doc,
            editors,
            page: 0,
            dirty: false,
            expanded: HashSet::new(),
            tree_search: String::new(),
            left_tab: LeftTab::Layers,
            right_tab: RightTab::Design,
            frame_preset: 0,
            flow: 0,
            flow_boot_mock: false,
            gap: 5.0,
            pad_h: 0.0,
            pad_v: 0.0,
            export_format: 0,
            export_scale: 0,
            export_suffix: String::new(),
            var_history: Default::default(),
            guide_kind: 0,
            guide_size: 16.0,
            // the canvas grid is OPT-IN: a fresh document opens clean
            guides_visible: false,
            scroll_left: 0.0,
            scroll_right: 0.0,
            guides: vec![],
            guide_drag: None,
            board_doc: None,
            color_picker_fill_open: false,
            color_picker_stroke_open: false,
        }
    }

    pub fn editor(&mut self) -> &mut Editor {
        let n = self.editors.len();
        let idx = self.page.min(n.saturating_sub(1));
        &mut self.editors[idx]
    }

    pub fn editor_ref(&self) -> &Editor {
        let idx = self.page.min(self.editors.len().saturating_sub(1));
        &self.editors[idx]
    }

    /// Editors own mutable page roots. Synchronize every page at persistence /
    /// document-transaction boundaries, never as a side effect of painting.
    pub fn sync(&mut self) {
        self.doc.pages = self.editors.iter().map(|e| e.root.clone()).collect();
    }

    pub fn selected_id(&self) -> Option<String> {
        self.editor_ref().selection.last().cloned()
    }
}

// ---------------------------------------------------------------- app root

/// C18: the new-comment composer anchored at a canvas point.
#[derive(Debug, Clone)]
pub struct CommentDraft {
    pub x: f64,
    pub y: f64,
    pub buffer: String,
    /// `Some(root id)` = this composer posts a reply into that thread.
    pub parent: Option<String>,
}

pub struct App {
    pub document_loading: Option<crate::loading::LoadingScreen>,
    pub file_job: Option<crate::jobs::DisplayStatus>,
    pub demo_mode: bool,
    pub smoke_mode: bool,
    pub presented_frames: u64,
    pub smoke_resized: bool,
    pub smoke_wait_document: bool,
    pub smoke_editor_frames: u64,
    pub loading_frames_presented: u64,
    pub clipboard: crate::clipboard::Clipboard,
    pub ime_preedit: String,
    pub next_autosave: std::time::Instant,
    pub screen: Screen,
    pub docs: Vec<OpenDoc>,
    pub active: usize,
    pub user: &'static str,
    pub recents: Vec<RecentFile>,
    pub drafts: Vec<RecentFile>,
    /// Dashboard thumbnail cache: file path → (mtime validated at read,
    /// single-image `Assets` under key "thumb"). Filled lazily, one render
    /// per dashboard frame (see `thumb_pump`), mirrored to a disk cache.
    pub thumbs:
        std::collections::HashMap<std::path::PathBuf, (std::time::SystemTime, x_native::Assets)>,
    /// Files whose thumbnail render failed this session (no retry storm;
    /// they fall back to the flat watermark card).
    pub thumb_failed: std::collections::HashSet<std::path::PathBuf>,
    pub dash_view: DashView,
    pub dash_layout: DashLayout,
    pub dash_sort: DashSort,
    /// Whether the sort menu is open (it is a popup, so it also owns the
    /// click-away and Escape behaviour).
    pub dash_sort_open: bool,
    /// Multi-select over `recents` (indices), the way Figma's browser selects
    /// several files before acting on them. Empty means "no selection" and the
    /// bulk bar is not painted at all.
    pub dash_selected: Vec<usize>,
    pub dash_search: String,
    pub dash_scroll: f64,
    pub dash_search_focus: bool,
    /// Keyboard focus on the dashboard: a position in
    /// [`dashboard::focus_targets`] (which filters the hit list down to the
    /// real controls). The dashboard was mouse-only — Tab moves this, Enter
    /// fires the focused control, Escape drops it, and a click puts it on
    /// whatever was clicked, so the ring never disagrees with the pointer.
    pub dash_focus: Option<usize>,
    // editor ui state
    pub left_w: f64,
    pub right_w: f64,
    pub tool: Tool,
    /// Which of the frame slot's two tools the toolbar draws when the active
    /// tool is neither: Figma keeps the frame and the section on ONE slot and
    /// shows whichever you used last.
    pub frame_cluster: Tool,
    /// The Brush's style (Figma Draw's "stroke style"): which mark the tool
    /// paints. A tool setting, not a document one — it survives the stroke.
    pub brush_style: BrushStyle,
    pub drag: Option<Drag>,
    pub field: Option<FieldEdit>,
    /// prototype flow preview (None = normal editing)
    pub flow: Option<FlowState>,
    pub dropdown_frame: bool,
    /// Open axis of the Constraints block (`None` = closed)
    pub dropdown_constraint: Option<ConstraintAxis>,
    /// Screen anchor of the open Constraints field, recorded while the panel
    /// paints: the panel scrolls, so a hard-coded offset would drift away
    /// from the field it belongs to.
    pub constraint_dd_anchor: (f64, f64),
    /// Open Prototype-tab Scroll behavior menu (`None` = closed), and the
    /// screen anchor its field recorded while painting — same reason as the
    /// Constraints field above.
    pub dropdown_proto_scroll: Option<ProtoScrollMenu>,
    pub proto_scroll_dd_anchor: (f64, f64),
    /// Open Prototype-tab **trigger** menu — the index of the interaction
    /// whose row it belongs to — and the screen anchor that row recorded while
    /// painting. Figma's trigger control is a dropdown (help 360040315773);
    /// `Trigger::all` is the list it shows.
    pub dropdown_proto_trigger: Option<usize>,
    pub proto_trigger_dd_anchor: (f64, f64),
    /// Open auto-layout **Width**/**Height** menu (`true` = the Width field)
    /// and the screen anchor its chip recorded while painting. Figma's W/H
    /// control is a dropdown (help 360040451373), and its min/max rows live in
    /// it — "Open the Width dropdown to find Add min width and Add max width".
    pub dropdown_layout_axis: Option<bool>,
    pub layout_axis_dd_anchor: (f64, f64),
    /// Open **canvas stacking** menu and its anchor, in the auto-layout
    /// settings band (help 31289464393751: "Next to canvas stacking, select").
    pub dropdown_stacking: bool,
    pub stacking_dd_anchor: (f64, f64),
    /// Zoom menu open (right-panel header, audit F4)
    pub dropdown_zoom: bool,
    /// Hover labels registered this frame (P10); paint_tooltip draws
    /// the one under the cursor
    pub tooltip: Vec<(Rect, String)>,
    /// Typography panel: line-height mode menu (Auto / Pixels / Percent)
    pub dropdown_lh: bool,
    /// Typography panel: text-style picker (Figma's styles button)
    pub dropdown_text_style: bool,
    /// Paint library popover: `Some(true)` for the fill row, `Some(false)`
    /// for the stroke row. Only one panel row at a time (Figma parity).
    pub paint_lib: Option<bool>,
    /// Where that popover paints, recorded by the row that opened it (panel
    /// y depends on the scroll offset, so the row knows the anchor).
    pub paint_lib_at: Option<(f64, f64)>,
    /// Font browser opened from the typography family field.
    pub font_picker_open: bool,
    /// Typography "Advanced" disclosure (letter/word/para spacing, baseline
    /// shift, case, variable axes). Progressive disclosure, P0-8: the
    /// primary set is Font / Weight / Size / Line height / Alignment.
    pub typo_advanced_open: bool,
    /// Auto Layout "Advanced" disclosure (Wrap / Fill / Absolute).
    pub layout_advanced_open: bool,
    /// Viewport rulers (Shift+R). Off by default — the HTML mock has none.
    pub rulers: bool,
    /// Canvas minimap (⇧M). On by default in the editor: it is the only
    /// affordance that says where the content is when it is off-screen.
    pub minimap: bool,
    /// DESIGN panel (no selection): editor canvas background
    pub canvas_bg: Color,
    /// Canvas background opacity % (Figma parity; audit P13)
    pub canvas_bg_alpha: f64,
    /// Canvas background visibility (Figma parity; audit P13)
    pub canvas_bg_visible: bool,
    /// Eyedropper armed: `Some(true)` samples a layer's fill,
    /// `Some(false)` its stroke, into the current selection
    pub eyedropper: Option<bool>,
    /// DESIGN panel (no selection): pixel grid color + opacity %
    pub grid_color: Color,
    pub grid_pct: f64,
    /// Alignment-card selection (row, col) of the last alignment applied
    pub align: (usize, usize),
    /// Active smart-guide lines while dragging: world coord + 'v'/'h'
    pub snap_lines: Vec<(f64, char)>,
    /// Last click (instant + screen pos) for double-click detection
    pub last_click: Option<(std::time::Instant, Point)>,
    /// Last CHROME press: instant, screen pos, and whether it hit a
    /// toggle-class row. Chrome presses deliberately do not touch
    /// `last_click` (that one belongs to the canvas), so the panels keep
    /// their own record — the repeat-press guard and the page rows'
    /// double-click rename both read it (`run.rs` chrome dispatch).
    pub last_chrome: Option<(std::time::Instant, Point, bool)>,
    /// Node being renamed inline by `FieldId::LayerName` (the tree's name zone
    /// resolves to this id; the field itself only carries the buffer).
    pub layer_edit_id: Option<String>,
    /// Node being inline-edited
    pub text_edit: Option<String>,
    /// Rich-text styling of the OPEN inline editor (char-index runs over
    /// the field buffer). Committed to the node with the text.
    pub text_runs_edit: Vec<x_native::TextRun>,
    /// Inline-editor caret (CHAR index into the editor buffer) and the
    /// selection anchor (None = no selection, caret only).
    pub text_caret: usize,
    pub text_anchor: Option<usize>,
    /// Layer under the cursor (Figma hover outline). None when selected,
    /// off-canvas, dragging, editing text, or not on the select tool.
    pub hover_node: Option<String>,
    /// Press on an ALREADY-SELECTED Text node: click (release without
    /// drag) places the caret — Figma's single-click text re-entry. A
    /// drag cancels it and moves the layer instead.
    pub pending_text_edit: Option<(String, Point)>,
    /// The inline editor's OWN text (decoupled from `field` so panel
    /// typography fields can open while editing — focus decides who gets
    /// the keystrokes).
    pub text_buffer: String,
    pub text_undo: Vec<crate::text_session::TextSnapshot>,
    pub text_redo: Vec<crate::text_session::TextSnapshot>,
    pub text_clipboard: String,
    pub field_select_all: bool,
    /// the component Text property currently being edited
    pub instance_prop_target: Option<String>,
    /// Tokens panel: which variable's value field is being edited
    /// (`FieldId::VarValue`).
    pub var_edit_name: Option<String>,
    /// Click→variable resolution for `FieldId::VarValue`, recorded by the
    /// Tokens panel each paint (same pattern as `last_instance_prop_rect`).
    pub var_value_rects: Vec<(Rect, String)>,
    /// Same, for the name slots (`FieldId::VarName` rename).
    pub var_name_rects: Vec<(Rect, String)>,
    /// Active library-update review (modal dialog state).
    pub lib_review: Option<LibReview>,
    /// Dashboard template gallery (modal).
    pub template_picker_open: bool,
    /// last JSX produced by Copy-as-code (for tests; the real target is
    /// the system clipboard)
    pub last_copied_code: Option<String>,
    /// C18: comment being composed (pin anchor in world coords + buffer)
    pub comment_draft: Option<CommentDraft>,
    /// C18: id of the comment whose thread popover is open
    pub open_comment: Option<String>,
    /// C21 dev mode: INSPECT tab platform (0 CSS, 1 SwiftUI, 2 Compose, 3 XML)
    pub inspect_platform: usize,
    /// (rect, prop name) of the last painted InstanceProp input — lets the
    /// Field action resolve WHICH prop the click targeted
    pub last_instance_prop_rect: Option<(Rect, String)>,
    /// right-click menu on the pages panel's page field
    pub page_menu: Option<Point>,
    /// the page field rect, captured at paint for right-click hit
    pub page_field_rect: Option<Rect>,
    /// Command Palette (⌘K) - full implementation with fuzzy search, navigation, and execution
    pub palette: CommandPalette,
    /// Context menu system for canvas, layers, pages, inspector, and tool rail
    pub context_menu: ContextMenu,
    /// Color picker popup state: (is_fill, field_rect, is_open)
    pub color_picker_popup: Option<(PaintTarget, Rect, bool)>,
    /// Effects list (Figma's Effects section): which popovers are open. One at
    /// a time, the way the panel's other menus behave.
    pub effect_add_open: bool,
    pub effect_kind_open: Option<usize>,
    /// The row whose settings block is expanded (Figma's *Effect settings*).
    pub effect_settings: Option<usize>,
    pub effect_blend_open: Option<usize>,
    pub layer_blend_open: bool,
    pub paint_blend_open: Option<PaintTarget>,
    /// Where a blend menu anchors, recorded by the paint pass.
    pub blend_dd_anchor: (f64, f64),
    /// Where the Effects `+` menu anchors, recorded by the panel pass: the
    /// menu itself paints in the popover pass, above the panel's clip.
    pub effect_add_anchor: (f64, f64),
    /// The effect rows the paint pass laid out (top to bottom) — the drop
    /// targets for reordering by dragging a row, which is Figma's gesture:
    /// *"you click and drag the handles to reorder the effects"*.
    pub effect_rows: Vec<Rect>,
    /// The row a drag is over while reordering.
    pub effect_drag_over: Option<usize>,
    pub status: String,
    // Navigation bar state (Figma-style)
    pub nav_tab: NavTab,
    pub nav_bar_w: f64,
    pub sidebar_resizing: bool,
    pub ui_minimized: bool,
    pub app_menu: AppMenu,
    pub find_replace: FindReplace,
    pub notifications: NotificationCenter,
    pub left_sidebar_width: f64,
    /// Inspector W/H lock state; kept at app level because it is UI intent,
    /// not a document property.
    pub aspect_ratio_locked: bool,
    /// Scale panel: which of the nine anchor cells stays put (4 = centre, the
    /// cell Figma's panel opens on).
    pub scale_cell: usize,
    /// The connection a press on a canvas noodle selected — what Delete
    /// removes, as an index into `editor_ui::page_connections` for this page.
    pub conn_sel: Option<usize>,
    pub zoom: f64,
    pub pan: (f64, f64),
    pub ctrl: bool,
    pub shift: bool,
    /// Alt/Option held (⌥-drag = duplicate)
    pub alt: bool,
    /// Symmetry axis for mirror tool: 'v' vertical, 'h' horizontal, None = off
    pub symmetry_axis: Option<char>,
    pub fonts: TextUi,
    pub property_clipboard: Option<PropertyClipboard>,
    /// Vector edit mode state (Figma parity)
    pub vector_edit_mode: VectorEditMode,
    // Phase 5: Shape Builder state
    pub win_w: f64,
    pub win_h: f64,
    pub hit: Vec<(Rect, Action)>,
    pub scaled: bool,
    pub mouse: Point,
    /// Space held → drag pans the canvas (legacy behavior, kept).
    pub space_pan: bool,
    /// Where the right button went down (screen space). `Some` while it is
    /// held: a right CLICK opens the context menu, a right DRAG marquees
    /// (Figma's gesture), so the press point has to survive the drag.
    pub right_origin: Option<Point>,
    /// The right button has travelled far enough to count as a drag — the
    /// context menu has been dismissed and the marquee owns the gesture.
    pub right_dragging: bool,
    /// The welcome / quick-start card is open on demand (Help). The card
    /// also shows once on a fresh install, but it is reachable afterwards.
    pub welcome_open: bool,
}

/// How many page rows the rail shows at once. The band is part of the fixed
/// left rail, so the list is WINDOWED: `pages_rows` slides the window with the
/// active page, so every page stays reachable (the old code swapped the last
/// row for a sentinel `n` — an index one past the end of `pages` — so with
/// more than 3 pages the 4th was never drawn and never deletable).
pub(crate) const PAGES_MAX_ROWS: usize = 4;

pub const USER_NAME: &str = "You";

impl App {
    /// The tool the toolbar's frame slot draws: the active frame-or-section
    /// tool when one of them is active, otherwise the one used last. Figma's
    /// slot works the same way, with a caret that switches by hand.
    pub fn frame_slot(&self) -> Tool {
        match self.tool {
            Tool::Frame | Tool::Section => self.tool,
            _ => self.frame_cluster,
        }
    }

    /// Select a tool, remembering the frame slot's choice so the slot can
    /// show the section after the tool has moved on.
    pub fn select_tool(&mut self, t: Tool) {
        if matches!(t, Tool::Frame | Tool::Section) {
            self.frame_cluster = t;
        }
        self.tool = t;
    }

    pub fn new() -> Self {
        let mut app = Self::demo();
        app.demo_mode = false;
        if let Some(theme) = crate::theme::load_persisted_theme() {
            crate::theme::set_theme(theme);
        }
        app.smoke_mode = std::env::args_os().any(|a| a == "--smoke-test");
        app.docs.clear();
        app.drafts.clear();
        app.active = 0;
        app.screen = Screen::Dashboard;
        app.status = "Local files · no account required".into();
        app.reload_recents();
        app
    }

    /// Explicit --demo mode and deterministic UI fixtures only.
    pub fn demo() -> Self {
        Self {
            document_loading: None,
            file_job: None,
            demo_mode: true,
            smoke_mode: false,
            presented_frames: 0,
            smoke_resized: false,
            smoke_wait_document: false,
            smoke_editor_frames: 0,
            loading_frames_presented: 0,
            clipboard: Default::default(),
            ime_preedit: String::new(),
            next_autosave: std::time::Instant::now() + std::time::Duration::from_secs(30),
            screen: Screen::Dashboard,
            // v45 mock boot tabs: Untitled (home) | DESIGN_SYSTEM.md
            // (active, the demo doc) | Liquor App
            docs: vec![
                {
                    let mut d = OpenDoc::demo_blank("Untitled".into());
                    d.tab_w = Some(120.0); // reference tab width
                    d
                },
                OpenDoc::demo_doc(),
                {
                    let mut d = OpenDoc::demo_blank("Liquor App".into());
                    d.tab_w = Some(128.0);
                    d
                },
            ],
            active: 1,
            user: USER_NAME,
            recents: seed_recents(),
            drafts: seed_drafts(),
            thumbs: std::collections::HashMap::new(),
            thumb_failed: std::collections::HashSet::new(),
            dash_view: DashView::Home,
            dash_layout: DashLayout::Grid,
            dash_sort: DashSort::Edited,
            dash_sort_open: false,
            dash_selected: Vec::new(),
            dash_search: String::new(),
            dash_scroll: 0.0,
            dash_search_focus: false,
            dash_focus: None,
            left_w: ED_LEFT_W,
            right_w: ED_RIGHT_W,
            tool: Tool::Select,
            frame_cluster: Tool::Frame,
            brush_style: BrushStyle::Ink,
            drag: None,
            field: None,
            flow: None,
            dropdown_frame: false,
            dropdown_constraint: None,
            constraint_dd_anchor: (0.0, 0.0),
            dropdown_proto_scroll: None,
            proto_scroll_dd_anchor: (0.0, 0.0),
            dropdown_proto_trigger: None,
            proto_trigger_dd_anchor: (0.0, 0.0),
            dropdown_layout_axis: None,
            layout_axis_dd_anchor: (0.0, 0.0),
            dropdown_stacking: false,
            stacking_dd_anchor: (0.0, 0.0),
            dropdown_zoom: false,
            tooltip: Vec::new(),
            dropdown_lh: false,
            dropdown_text_style: false,
            paint_lib: None,
            paint_lib_at: None,
            font_picker_open: false,
            typo_advanced_open: false,
            layout_advanced_open: false,
            rulers: false,
            minimap: true,
            // canvas matches the HTML `.canvas` token; grid per the design
            // empty-selection panel (PIXEL GRID COLOR 0070E4 @ 20%)
            canvas_bg: crate::theme::C_CANVAS,
            canvas_bg_alpha: 100.0,
            canvas_bg_visible: true,
            eyedropper: None,
            grid_color: Color::from_rgb8(0x00, 0x70, 0xE4),
            grid_pct: 20.0,
            align: (0, 2),
            snap_lines: Vec::new(),
            last_click: None,
            last_chrome: None,
            layer_edit_id: None,
            text_edit: None,
            text_runs_edit: Vec::new(),
            text_caret: 0,
            text_anchor: None,
            text_buffer: String::new(),
            text_undo: vec![],
            text_redo: vec![],
            text_clipboard: String::new(),
            field_select_all: false,
            hover_node: None,
            pending_text_edit: None,
            instance_prop_target: None,
            var_edit_name: None,
            var_value_rects: Vec::new(),
            var_name_rects: Vec::new(),
            lib_review: None,
            template_picker_open: false,
            last_copied_code: None,
            comment_draft: None,
            open_comment: None,
            inspect_platform: 0,
            last_instance_prop_rect: None,
            page_menu: None,
            page_field_rect: None,
            palette: CommandPalette::new(1440.0, 900.0),
            context_menu: ContextMenu::new(),
            color_picker_popup: None,
            effect_add_open: false,
            effect_kind_open: None,
            effect_settings: None,
            effect_blend_open: None,
            layer_blend_open: false,
            paint_blend_open: None,
            blend_dd_anchor: (0.0, 0.0),
            effect_add_anchor: (0.0, 0.0),
            effect_rows: Vec::new(),
            effect_drag_over: None,
            status: String::from("Ready"),
            nav_tab: NavTab::File,
            nav_bar_w: 48.0,
            sidebar_resizing: false,
            ui_minimized: false,
            app_menu: AppMenu::default(),
            find_replace: FindReplace::default(),
            notifications: NotificationCenter::default(),
            left_sidebar_width: 280.0,
            property_clipboard: None,
            vector_edit_mode: VectorEditMode::default(),
            // Phase 5: Shape Builder state
            aspect_ratio_locked: false,
            scale_cell: 4,
            conn_sel: None,
            zoom: 1.0,
            pan: (0.0, 0.0),
            ctrl: false,
            alt: false,
            shift: false,
            symmetry_axis: None,
            fonts: TextUi::load(),
            win_w: 1440.0,
            win_h: 900.0,
            hit: vec![],
            scaled: false,
            mouse: Point::ZERO,
            space_pan: false,
            right_origin: None,
            right_dragging: false,
            welcome_open: false,
        }
    }

    // ------------------------------------------------------------- regions

    /// True when `p` is the second press of a double-click on the CHROME: a
    /// press within 350 ms and 4 px of the last one — the same window the
    /// canvas uses (`Host::is_double_click`), measured from the chrome's own
    /// record because the canvas owns `last_click`.
    pub fn is_repeat_chrome_click(&self, p: Point) -> bool {
        self.last_chrome
            .map(|(t, q, _)| {
                t.elapsed().as_millis() < 350 && (p.x - q.x).abs() < 4.0 && (p.y - q.y).abs() < 4.0
            })
            .unwrap_or(false)
    }

    /// PAGES list band geometry — ONE source of truth shared by paint and
    /// hit-testing. Rows start where the old single page field did
    /// (y0+142), 26px tall, at most `PAGES_MAX_ROWS` of them; the window
    /// follows the active page, so every page stays reachable and deletable.
    pub fn pages_rows(&self) -> Vec<(usize, Rect)> {
        const ROW_H: f64 = 26.0;
        let y0 = ED_TITLE_H;
        let sidebar = self.editor_regions().sidebar;
        let sx = sidebar.x0;
        let lw = sidebar.x1;
        let n = self.doc_ref().editors.len();
        if n == 0 {
            return Vec::new();
        }
        // Top row of the window. It follows the ACTIVE PAGE (`OpenDoc::page` —
        // `App::active` is the active DOCUMENT, not the page) once the page
        // walks past the last visible row, then clamps so the last page is
        // always on screen. Every page is therefore reachable by selecting it
        // (menu, keyboard, or the row above it).
        let top = self.doc_ref().page.min(n.saturating_sub(PAGES_MAX_ROWS));
        (0..PAGES_MAX_ROWS.min(n))
            .map(|i| {
                let page_i = top + i;
                let ry = y0 + 142.0 + i as f64 * ROW_H;
                (page_i, Rect::new(sx + 12.0, ry, lw - 13.0, ry + ROW_H))
            })
            .collect()
    }

    /// Bottom of the PAGES band (header label at y0+120.5, then the rows).
    pub fn pages_band_bottom(&self) -> f64 {
        const ROW_H: f64 = 26.0;
        let n = self.doc_ref().editors.len();
        let count = n.clamp(1, PAGES_MAX_ROWS);
        ED_TITLE_H + 142.0 + count as f64 * ROW_H
    }

    pub fn editor_regions(&self) -> EdRegions {
        // `left_w`/`right_w` are the live widths — Drag::LeftPanel/RightPanel
        // resize them; the old static field made the resize a visual no-op.
        // They share the window with the canvas, and both are reachable
        // extremes (drag a panel wide, then shrink the window), so this is the
        // one place that guarantees the canvas never inverts: the left dock
        // yields to the right dock's minimum, then the right takes what is
        // left over. Panels therefore stop at the floor instead of overlapping
        // each other and painting the canvas backwards.
        let want_left = if self.ui_minimized { 0.0 } else { self.left_w };
        let room = (self.win_w - self.nav_bar_w - ED_CANVAS_MIN).max(0.0);
        let left = want_left.min((room - ED_RIGHT_MIN).max(0.0));
        let right = self.right_w.min((room - left).max(0.0));
        let left_total = self.nav_bar_w + left;
        // Chrome yields to chrome: the status band owns the bottom of the
        // window, so no region (and therefore no artwork) runs underneath it.
        let bottom = self.status_band().y0.max(ED_TITLE_H);
        EdRegions {
            left: Rect::new(0.0, ED_TITLE_H, left_total, bottom),
            nav_bar: Rect::new(0.0, ED_TITLE_H, self.nav_bar_w, bottom),
            sidebar: Rect::new(self.nav_bar_w, ED_TITLE_H, left_total, bottom),
            right: Rect::new(self.win_w - right, ED_TITLE_H, self.win_w, bottom),
            canvas: Rect::new(left_total, ED_TITLE_H, self.win_w - right, bottom),
        }
    }

    /// The status band: the one row the window reserves for a message. It is
    /// both the message's background and its hit zone, and it is a *row* — the
    /// regions above stop at its top edge rather than painting under it.
    pub fn status_band(&self) -> Rect {
        Rect::new(0.0, self.win_h - ED_STATUS_H, self.win_w, self.win_h)
    }

    /// The band is chrome. The chrome-less flow viewer (a prototype preview)
    /// gives the document every pixel and paints no band at all.
    pub fn paints_status_band(&self) -> bool {
        self.flow.is_none()
    }

    /// The rect the document viewport occupies: the canvas region while
    /// editing, the whole window in the chrome-less flow viewer (editor
    /// chrome is hidden, so the prototype gets every pixel).
    pub fn view_canvas(&self) -> Rect {
        if self.flow.is_some() {
            Rect::new(0.0, 0.0, self.win_w, self.win_h)
        } else {
            self.editor_regions().canvas
        }
    }

    pub fn canvas_transform(&self) -> (f64, f64, f64) {
        // Boards intentionally use a full-window viewport. Keeping the
        // transform here (rather than making every pointer handler remember
        // which screen it is on) makes painting and hit-testing share one
        // coordinate system.
        if self.screen == Screen::Board {
            return self.board_canvas_transform();
        }
        let c = self.view_canvas();
        // rulers shrink the viewport (content starts after the strips);
        // the flow viewer paints no rulers
        let (dx, dy) = if self.rulers && self.flow.is_none() {
            (crate::theme::RULER_SIZE, crate::theme::RULER_SIZE)
        } else {
            (0.0, 0.0)
        };
        (c.x0 + self.pan.0 + dx, c.y0 + self.pan.1 + dy, self.zoom)
    }

    pub fn screen_to_world(&self, p: Point) -> Point {
        self.canvas_affine().inverse() * p
    }

    pub fn world_to_screen(&self, p: Point) -> Point {
        self.canvas_affine() * p
    }

    pub fn canvas_affine(&self) -> vello::kurbo::Affine {
        let (x, y, z) = self.canvas_transform();
        vello::kurbo::Affine::translate((x, y)) * vello::kurbo::Affine::scale(z)
    }

    // ------------------------------------------------------------- docs

    /// Guide being dragged (lives on the doc like the guide list).
    pub fn guide_drag(&mut self) -> &mut Option<(char, f64)> {
        &mut self.doc().guide_drag
    }

    /// Immutable document access (paint paths).
    pub fn doc_ref(&self) -> &OpenDoc {
        self.docs
            .get(self.active)
            .expect("at least one doc is open")
    }

    pub fn doc(&mut self) -> &mut OpenDoc {
        if self.docs.is_empty() {
            self.docs.push(OpenDoc::new_blank("Untitled".into()));
            self.active = 0;
        }
        let a = self.active.min(self.docs.len() - 1);
        &mut self.docs[a]
    }

    pub fn doc_opt(&self) -> Option<&OpenDoc> {
        self.docs.get(self.active)
    }

    /// Check if current document is a Board (infinite canvas)
    pub fn is_board(&self) -> bool {
        self.doc_opt().is_some_and(|d| d.board_doc.is_some())
    }

    /// Get board document reference
    pub fn board_doc(&self) -> &x_board::BoardDocument {
        self.doc_opt()
            .and_then(|d| d.board_doc.as_ref())
            .expect("board_doc called when not in board mode")
    }

    /// Get mutable board document reference
    pub fn board_doc_mut(&mut self) -> &mut x_board::BoardDocument {
        self.doc()
            .board_doc
            .as_mut()
            .expect("board_doc_mut called when not in board mode")
    }

    /// Board-specific regions (no side panels for infinite canvas)
    pub fn board_regions(&self) -> BoardRegions {
        BoardRegions {
            canvas: Rect::new(
                0.0,
                ED_TITLE_H,
                self.win_w,
                self.status_band().y0.max(ED_TITLE_H),
            ),
        }
    }

    /// Board canvas transform (pan/zoom for infinite canvas)
    pub fn board_canvas_transform(&self) -> (f64, f64, f64) {
        let r = self.board_regions();
        (
            r.canvas.x0 + self.pan.0,
            r.canvas.y0 + self.pan.1,
            self.zoom,
        )
    }

    /// Hit test board nodes at a world-space point
    pub fn hit_test_board_node(&self, point: Point) -> Option<String> {
        let doc = self.board_doc();
        let page = doc.current_page();

        // Check nodes in reverse order (top-most first)
        for node in page.nodes.iter().rev() {
            let bbox = node.bounding_box();
            if bbox.contains(point) {
                return Some(node.id().clone());
            }
        }

        None
    }

    /// Get current board tool from the active tool
    pub fn board_tool(&self) -> x_board::BoardTool {
        match self.tool {
            Tool::Select => x_board::BoardTool::Select,
            Tool::BoardSticky => x_board::BoardTool::StickyNote,
            Tool::BoardConnector => x_board::BoardTool::Connector,
            Tool::Pen => x_board::BoardTool::Pen,
            Tool::BoardRect => x_board::BoardTool::Rectangle,
            Tool::BoardCircle => x_board::BoardTool::Circle,
            Tool::Text => x_board::BoardTool::Text,
            Tool::Hand => x_board::BoardTool::Hand,
            Tool::Zoom => x_board::BoardTool::Zoom,
            _ => x_board::BoardTool::Select,
        }
    }

    /// Alignment-card click: align selection, remember the chosen dot.
    pub fn apply_align(&mut self, row: usize, col: usize) {
        self.align = (row, col);
        let doc = self.doc();
        doc.editor().align_selection(col, row);
        self.mark_dirty();
    }

    /// Eye (lock=false) / padlock (lock=true) toggle on the selection.
    pub fn apply_toggle(&mut self, lock: bool) {
        let doc = self.doc();
        if let Some(id) = doc.editor_ref().selection.first().cloned() {
            let (locked, visible) = {
                let root = &doc.editor_ref().root;
                match crate::editor_ui::find_node(root, id.as_str()) {
                    Some(n) => (n.locked, n.visible),
                    None => return,
                }
            };
            if lock {
                doc.editor().set_locked(&id, !locked);
            } else {
                doc.editor().set_visible(&id, !visible);
            }
            self.mark_dirty();
        }
    }

    // ------------------------------------------------------- component
    // properties (A2): masters define, instances edit

    /// Name of the Component master the selected node lives inside
    /// (None for top-level selections / non-master subtrees).
    pub fn selected_master_name(&self) -> Option<String> {
        let doc = self.doc_opt()?;
        let id = doc.selected_id()?;
        if id == doc.editor_ref().root.id {
            return None;
        }
        let mut cur = id;
        loop {
            let parent = x_native::editor::parent_id(&doc.editor_ref().root, &cur)?;
            let node = crate::editor_ui::find_node(&doc.editor_ref().root, &parent)?;
            if let x_native::NodeKind::Component { name } = &node.kind {
                return Some(name.clone());
            }
            cur = parent;
        }
    }

    /// The selected instance node's (id, component) pair.
    pub fn selected_instance(&self) -> Option<(String, String)> {
        let doc = self.doc_opt()?;
        let id = doc.selected_id()?;
        match &crate::editor_ui::find_node(&doc.editor_ref().root, &id)?.kind {
            x_native::NodeKind::Instance { component } => Some((id, component.clone())),
            _ => None,
        }
    }

    /// Prop definitions of a component (empty when none).
    pub fn props_of(&self, component: &str) -> Vec<x_native::ComponentPropEntry> {
        self.doc_opt()
            .map(|d| {
                d.doc
                    .component_props
                    .get(component)
                    .cloned()
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    /// Convert stored entries into the override pipeline's registry.
    fn registry_of(
        component: &str,
        entries: &[x_native::ComponentPropEntry],
    ) -> x_native::components::PropRegistry {
        use x_native::components::ComponentProp as P;
        let mut reg = x_native::components::PropRegistry::default();
        let list = entries
            .iter()
            .map(|e| match e.kind {
                x_native::ComponentPropKind::Text => P::Text {
                    name: e.name.clone(),
                    target: e.target.clone(),
                    default: e.default.clone(),
                },
                x_native::ComponentPropKind::Bool => P::Bool {
                    name: e.name.clone(),
                    target: e.target.clone(),
                    default: e.default == "true",
                },
                x_native::ComponentPropKind::Swap => P::Swap {
                    name: e.name.clone(),
                    target: e.target.clone(),
                    default: e.default.clone(),
                },
            })
            .collect();
        reg.props.insert(component.to_string(), list);
        reg
    }

    /// Apply a prop value to an instance as a typed override (the same
    /// pipeline the renderer consumes for visibility/text/swap).
    pub fn apply_prop(
        &mut self,
        instance_id: &str,
        component: &str,
        prop_name: &str,
        value: &str,
    ) -> bool {
        let entries = self.props_of(component);
        if entries.is_empty() {
            return false;
        }
        let reg = Self::registry_of(component, &entries);
        let doc = self.doc();
        let applied = match x_native::editor::find(&doc.editor_ref().root, instance_id).cloned() {
            Some(mut node) if matches!(node.kind, x_native::NodeKind::Instance { .. }) => {
                reg.apply(component, &mut node, prop_name, value)
                    && doc.editor().replace_node(instance_id, node)
            }
            _ => false,
        };
        if applied {
            self.mark_dirty();
        }
        applied
    }

    /// Current effective value of a prop on an instance (override, else
    /// the definition's default) — for display.
    pub fn instance_prop_value(
        &self,
        instance_id: &str,
        e: &x_native::ComponentPropEntry,
    ) -> String {
        let doc = match self.doc_opt() {
            Some(d) => d,
            None => return e.default.clone(),
        };
        let node = match crate::editor_ui::find_node(&doc.editor_ref().root, instance_id) {
            Some(n) => n,
            None => return e.default.clone(),
        };
        let t = x_native::components::typed_overrides(node);
        match t.get(&e.target) {
            Some(x_native::components::OverrideValue::Text(s)) => s.clone(),
            Some(x_native::components::OverrideValue::Visible(b)) => b.to_string(),
            Some(x_native::components::OverrideValue::Swap(s)) => s.clone(),
            _ => e.default.clone(),
        }
    }

    /// Define a new prop on the selected node's master, binding the
    /// selected node as target (Figma's "use selection as property").
    /// Add a real slot property to the selected node in a component master.
    /// Slots live on the master node's component-property list and are
    /// resolved by the engine when an instance supplies slot content.
    pub fn add_slot(&mut self) {
        let Some(component) = self.selected_master_name() else {
            return;
        };
        let Some(target) = self.doc_ref().selected_id() else {
            return;
        };
        let name = {
            let root = &self.doc_ref().editor_ref().root;
            let Some(node) = crate::editor_ui::find_node(root, target.as_str()) else {
                return;
            };
            let base = if node.name.is_empty() {
                "Content"
            } else {
                &node.name
            };
            let mut candidate = base.to_string();
            let mut n = 2;
            while crate::editor_ui::find_node(root, target.as_str())
                .is_some_and(|node| node.props.iter().any(|p| p.name() == candidate))
            {
                candidate = format!("{base} {n}");
                n += 1;
            }
            candidate
        };
        let doc = self.doc();
        doc.checkpoint();
        doc.editor().mutate_visual_stack(target.as_str(), |node| {
            node.props.push(x_native::ComponentProp::Slot {
                name: name.clone(),
                target: target.clone(),
                default: None,
            });
        });
        self.mark_dirty();
        self.status = format!("Added slot '{name}' to {component}");
    }

    pub fn add_prop(&mut self, kind: x_native::ComponentPropKind) {
        let Some(component) = self.selected_master_name() else {
            return;
        };
        let (id, name) = {
            let doc = self.doc();
            let id = match doc.selected_id() {
                Some(i) => i,
                None => return,
            };
            match crate::editor_ui::find_node(&doc.editor_ref().root, &id) {
                Some(n) => (id.clone(), n.name.clone()),
                None => return,
            }
        };
        // unique prop name (node name, then " 2", " 3", …)
        let doc = self.doc();
        let mut prop_name = name.clone();
        let mut n = 2;
        while doc
            .doc
            .component_props
            .get(&component)
            .map(|l| l.iter().any(|e| e.name == prop_name))
            .unwrap_or(false)
        {
            prop_name = format!("{name} {n}");
            n += 1;
        }
        // read the text default BEFORE borrowing the props list mutably
        let default = match kind {
            x_native::ComponentPropKind::Text => {
                let doc = self.doc();
                match crate::editor_ui::find_node(&doc.editor_ref().root, &id) {
                    Some(x_native::Node {
                        kind: x_native::NodeKind::Text { text },
                        ..
                    }) => text.clone(),
                    _ => String::new(),
                }
            }
            x_native::ComponentPropKind::Bool => "true".into(),
            x_native::ComponentPropKind::Swap => {
                // default = the component the bound node already instantiates
                let doc = self.doc();
                match crate::editor_ui::find_node(&doc.editor_ref().root, &id) {
                    Some(x_native::Node {
                        kind: x_native::NodeKind::Instance { component },
                        ..
                    }) => component.clone(),
                    _ => String::new(),
                }
            }
        };
        let doc = self.doc();
        doc.checkpoint();
        let list = doc.doc.component_props.entry(component).or_default();
        list.push(x_native::ComponentPropEntry {
            name: prop_name,
            target: id,
            kind,
            default,
        });
        self.mark_dirty();
    }

    /// Commit the component-property text field (App-level single path so
    /// tests can drive it without a window; mirrors commit_page_rename).
    pub fn commit_instance_prop(&mut self, raw: &str) {
        if let (Some((iid, comp)), Some(name)) =
            (self.selected_instance(), self.instance_prop_target.clone())
        {
            self.apply_prop(&iid, &comp, &name, raw);
        }
        self.instance_prop_target = None;
    }

    pub fn remove_prop(&mut self, component: &str, name: &str) {
        let doc = self.doc();
        if !doc
            .doc
            .component_props
            .get(component)
            .is_some_and(|l| l.iter().any(|e| e.name == name))
        {
            return;
        }
        doc.checkpoint();
        if let Some(list) = doc.doc.component_props.get_mut(component) {
            list.retain(|e| e.name != name);
        }
        self.mark_dirty();
    }

    /// Cycle a Swap prop through every master component in the document.
    pub fn cycle_swap(&mut self, instance_id: &str, component: &str, prop_name: &str) {
        let entries = self.props_of(component);
        let Some(e) = entries.iter().find(|e| e.name == prop_name) else {
            return;
        };
        // candidates: every Component master in the document (sorted)
        let doc = self.doc();
        let mut masters: Vec<String> = Vec::new();
        fn walk(n: &x_native::Node, out: &mut Vec<String>) {
            if let x_native::NodeKind::Component { name } = &n.kind {
                out.push(name.clone());
            }
            for c in &n.children {
                walk(c, out);
            }
        }
        walk(&doc.editor_ref().root.clone(), &mut masters);
        masters.sort();
        if masters.is_empty() {
            return;
        }
        let cur = self.instance_prop_value(instance_id, e);
        let idx = masters
            .iter()
            .position(|m| *m == cur)
            .map(|i| i + 1)
            .unwrap_or(0);
        let next = masters[idx % masters.len()].clone();
        self.apply_prop(instance_id, component, prop_name, &next);
    }

    pub fn reset_instance_props(&mut self, instance_id: &str) {
        let doc = self.doc();
        doc.editor().reset_instance_overrides(instance_id);
        self.mark_dirty();
    }

    /// Reset ONE change on the selected instance — Figma's *"Reset > Reset
    /// [property]"*. False when that layer carried no override.
    pub fn reset_instance_change(&mut self, target: &str) -> bool {
        let Some((iid, _)) = self.selected_instance() else {
            return false;
        };
        let doc = self.doc();
        let ok = doc.editor().reset_one_override(&iid, target);
        if ok {
            self.mark_dirty();
        }
        ok
    }

    /// Figma's *"push changes to main component"*: the instance's overrides
    /// land on the master, so every other instance of it follows. Returns how
    /// many master layers changed (0 when the master is not in this file).
    pub fn push_instance_overrides(&mut self, instance_id: &str) -> usize {
        let doc = self.doc();
        let changed = doc.editor().push_overrides_to_main(instance_id);
        if changed > 0 {
            self.mark_dirty();
        }
        changed
    }

    /// Select the instance's main component — Figma's *"Go to main
    /// component"* (help 360038665934). Returns the master's id so the caller
    /// can bring it into view.
    pub fn go_to_main_component(&mut self) -> Option<String> {
        let (_, component) = self.selected_instance()?;
        let master = {
            let doc = self.doc();
            x_native::find_master(&doc.editor_ref().root, &component).map(|m| m.id.clone())?
        };
        self.doc().editor().selection = vec![master.clone()];
        self.mark_dirty();
        Some(master)
    }

    /// The selection as Figma's instance menu needs it: `None` unless the
    /// selection is an instance. `in_file` gates both master rows (help
    /// 360038665934: *"You can only push overrides if the main component is in
    /// the same file as the instance"*) and `changes` is the list the Reset
    /// flyout prints — *"Figma only lists properties that have changes
    /// applied"*.
    pub fn context_instance(&self) -> Option<crate::context_menu::InstanceMenu> {
        let doc = self.doc_opt()?;
        let (id, component) = self.selected_instance()?;
        let root = &doc.editor_ref().root;
        let node = crate::editor_ui::find_node(root, &id)?;
        if !matches!(node.kind, x_native::NodeKind::Instance { .. }) {
            return None;
        }
        let changes = x_native::instance_changes(node)
            .iter()
            .map(|c| (c.node.clone(), c.label(root)))
            .collect();
        Some(crate::context_menu::InstanceMenu {
            id,
            component: component.clone(),
            in_file: x_native::find_master(root, &component).is_some(),
            changes,
        })
    }

    /// Figma's *select inside*: after a double-click (or a click while already
    /// inside) the status names the layer being edited within its instance and
    /// says how to leave — the breadcrumb Figma puts in the layers panel.
    pub fn enter_instance_status(&mut self, layer: &str) {
        let label = match self.doc_opt() {
            Some(doc) => {
                let ed = doc.editor_ref();
                let instance = ed
                    .instance_scope
                    .as_ref()
                    .and_then(|(id, _)| crate::editor_ui::find_node(&ed.root, id))
                    .map(|n| match &n.kind {
                        // Figma names an instance after its component
                        x_native::NodeKind::Instance { component } => component.clone(),
                        _ => n.name.clone(),
                    })
                    .unwrap_or_else(|| "the instance".to_string());
                let layer = ed
                    .scoped_layer(&doc.doc.variables)
                    .map(|n| n.name.clone())
                    .unwrap_or_else(|| layer.to_string());
                format!("Inside {instance} - {layer} (Esc to leave)")
            }
            None => return,
        };
        self.status = label;
    }

    /// Commit a page rename (single source of truth for the pages-panel
    /// inline field). Empty names are ignored.
    /// The selected node's own auto-layout (None unless it is a Frame
    /// carrying one).
    pub fn selected_layout(&self) -> Option<x_native::AutoLayout> {
        let doc = self.doc_opt()?;
        let id = doc.selected_id()?;
        match &crate::editor_ui::find_node(&doc.editor_ref().root, &id)?.kind {
            x_native::NodeKind::Frame { layout } => layout.clone(),
            _ => None,
        }
    }

    /// Does the selected node's PARENT carry an auto-layout? (gates the
    /// per-child Fill/Absolute controls)
    pub fn selected_parent_has_layout(&self) -> bool {
        let Some(doc) = self.doc_opt() else {
            return false;
        };
        let Some(id) = doc.selected_id() else {
            return false;
        };
        fn has_al(n: &x_native::Node) -> bool {
            matches!(n.kind, x_native::NodeKind::Frame { layout: Some(_) })
        }
        if has_al(&doc.editor_ref().root) {
            return true;
        }
        fn walk(n: &x_native::Node, id: &str, out: &mut bool) {
            if *out {
                return;
            }
            for c in &n.children {
                if c.id == id {
                    *out = has_al(n);
                    return;
                }
                walk(c, id, out);
                if *out {
                    return;
                }
            }
        }
        let mut out = false;
        walk(&doc.editor_ref().root, &id, &mut out);
        out
    }

    /// Apply `f` to the selected frame's auto-layout (creating a default
    /// one when absent) and re-solve — ONE undo step. Shell fields flow /
    /// gap / padding are the source of truth for those keys; everything
    /// else (wrap, sizing, distribute, align, grid) is preserved.
    pub fn modify_selected_layout(&mut self, f: impl FnOnce(&mut x_native::AutoLayout)) {
        let (id, vars, mut layout, had) = {
            let doc = self.doc();
            let id = match doc.selected_id() {
                Some(i) => i,
                None => return,
            };
            let vars = doc.doc.variables.clone();
            let cur = self.selected_layout();
            (id, vars, cur.clone().unwrap_or_default(), cur.is_some())
        };
        let _ = had;
        f(&mut layout);
        let doc = self.doc();
        doc.editor().set_auto_layout(&id, Some(layout), &vars);
        self.mark_dirty();
    }

    /// Apply `f` to the selected node's ChildConstraints (parent must
    /// carry the auto-layout) and re-solve the parent.
    pub fn modify_child_constraints(&mut self, f: impl FnOnce(&mut x_native::ChildConstraints)) {
        let (id, vars, mut con) = {
            let doc = self.doc();
            let id = match doc.selected_id() {
                Some(i) => i,
                None => return,
            };
            fn find_con(n: &x_native::Node, id: &str) -> Option<x_native::ChildConstraints> {
                for c in &n.children {
                    if c.id == id {
                        return Some(c.constraints.clone());
                    }
                    if let Some(x) = find_con(c, id) {
                        return Some(x);
                    }
                }
                None
            }
            let con = find_con(&doc.editor_ref().root.clone(), &id).unwrap_or_default();
            (id, doc.doc.variables.clone(), con)
        };
        f(&mut con);
        let doc = self.doc();
        doc.editor().set_child_constraints(&id, con, &vars);
        self.mark_dirty();
    }

    /// Rename the ACTIVE page. The page's name lives in `doc.pages[i].name`
    /// — that is the list the rail shows, the field edits, and the undo
    /// history records. The page's ROOT frame carries the same string purely
    /// as a mirror, because a handful of surfaces read a root's name directly
    /// (flow labels via `editor_ui::flow_locate`, thumbnails, SVG ids); the
    /// mirror is one-way, so a page rename can never be mistaken for a frame
    /// rename — the bug where the artboard's frame name WAS the page name.
    ///
    /// Compared against the page name, not the root's: the old guard tested
    /// `root.name`, so renaming a page back to its mirrored frame name was
    /// silently rejected.
    pub fn commit_page_rename(&mut self, raw: &str) -> bool {
        let raw = raw.trim().to_string();
        if raw.is_empty() {
            return false;
        }
        {
            let doc = self.doc();
            let i = doc.page;
            let current = doc
                .doc
                .pages
                .get(i)
                .map(|p| p.name.clone())
                .unwrap_or_default();
            if current == raw {
                return false;
            }
            doc.checkpoint();
            if let Some(p) = doc.doc.pages.get_mut(i) {
                p.name = raw.clone();
            }
            if let Some(e) = doc.editors.get_mut(i) {
                e.root.name = raw;
            }
        }
        self.mark_dirty();
        true
    }

    /// Open layer `id` for inline rename (Figma: double-click the layer's name
    /// in the Layers panel). The selection follows, so the inspector and the
    /// canvas agree with what is being renamed.
    pub fn begin_layer_rename(&mut self, id: String) {
        let name = {
            let doc = self.doc();
            // read the name out FIRST: the find borrows the tree, the
            // selection write needs it mutably
            let found = crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())
                .map(|n| n.name.clone());
            let Some(name) = found else {
                return;
            };
            doc.editor().selection = vec![id.clone()];
            name
        };
        self.layer_edit_id = Some(id);
        self.field_select_all = true;
        self.field = Some(FieldEdit {
            id: FieldId::LayerName,
            buffer: name,
        });
    }

    /// Open page `i` for inline rename (Figma: double-click a page NAME in
    /// the Pages list). Selecting and editing in one step, because the field
    /// zone only exists on the ACTIVE row — a rename that did not also select
    /// would open a field the hit-test cannot reach.
    pub fn begin_page_rename(&mut self, i: usize) {
        let name = {
            let doc = self.doc();
            if i >= doc.editors.len() {
                return;
            }
            doc.page = i;
            doc.doc
                .pages
                .get(i)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| format!("Page {}", i + 1))
        };
        self.field_select_all = true;
        self.field = Some(FieldEdit {
            id: FieldId::PageName,
            buffer: name,
        });
        self.page_menu = None;
    }

    /// Delete page `i` — the rail's ✕, which must work on ANY row including
    /// the page you are looking at (Figma allows both). Deleting a page that
    /// is not the active one leaves the selection alone; deleting the active
    /// one clamps it to the last remaining page. The last page cannot be
    /// deleted: a document with no page has nothing to render.
    pub fn delete_page(&mut self, i: usize) -> bool {
        let deleted = {
            let doc = self.doc();
            if doc.editors.len() <= 1 || i >= doc.editors.len() {
                false
            } else {
                doc.checkpoint();
                doc.editors.remove(i);
                doc.doc.pages.remove(i);
                doc.doc.comments.retain(|c| c.page != i);
                for c in &mut doc.doc.comments {
                    if c.page > i {
                        c.page -= 1;
                    }
                }
                if doc.page > i {
                    doc.page -= 1;
                } else if doc.page == i {
                    doc.page = doc.page.min(doc.editors.len() - 1);
                }
                true
            }
        };
        if deleted {
            self.mark_dirty();
        }
        deleted
    }

    pub fn page_menu_cmd(&mut self, cmd: PageMenuCmd) {
        self.page_menu = None;
        match cmd {
            PageMenuCmd::Rename => {
                let name = {
                    let doc = self.doc();
                    doc.doc
                        .pages
                        .get(doc.page)
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| format!("Page {}", doc.page + 1))
                };
                self.field_select_all = true;
                self.field = Some(FieldEdit {
                    id: FieldId::PageName,
                    buffer: name,
                });
            }
            PageMenuCmd::Duplicate => {
                {
                    let doc = self.doc();
                    doc.checkpoint();
                    let n = doc.editors.len() + 1;
                    let mut page = doc
                        .doc
                        .pages
                        .get(doc.page)
                        .cloned()
                        .unwrap_or_else(|| Node::frame(&format!("page-{n}"), 1440.0, 1024.0));
                    page.name = format!("{} copy", page.name);
                    let mut names: HashSet<String> =
                        doc.doc.component_props.keys().cloned().collect();
                    fn names_in(n: &Node, out: &mut HashSet<String>) {
                        if let x_native::NodeKind::Component { name } = &n.kind {
                            out.insert(name.clone());
                        }
                        for c in &n.children {
                            names_in(c, out);
                        }
                    }
                    for p in &doc.doc.pages {
                        names_in(p, &mut names);
                    }
                    let components = crate::clipboard::rename_components(&mut page, &mut names);
                    let ids = x_native::remap_node_ids(&mut page, |_| x_native::fresh_id("node"));
                    for (old, new) in components {
                        if let Some(props) = doc.doc.component_props.get(&old).cloned() {
                            let props = props
                                .into_iter()
                                .map(|mut p| {
                                    if let Some(id) = ids.get(&p.target) {
                                        p.target = id.clone();
                                    }
                                    p
                                })
                                .collect();
                            doc.doc.component_props.insert(new, props);
                        }
                    }
                    let ed = x_native::editor::Editor::new(page.clone());
                    let at = (doc.page + 1).min(doc.editors.len());
                    doc.editors.insert(at, ed);
                    doc.doc.pages.insert(at, page);
                    for c in &mut doc.doc.comments {
                        if c.page >= at {
                            c.page += 1;
                        }
                    }
                    doc.page = at;
                }
                self.mark_dirty();
            }
            PageMenuCmd::Delete => {
                // one implementation, shared with the rail's ✕ (see
                // `App::delete_page`): the old copy here was the ONLY delete
                // path, refused at one page, and unreachable for the active
                // page from the rail.
                let i = self.doc_ref().page;
                self.delete_page(i);
            }
            PageMenuCmd::MoveUp => {
                let moved = {
                    let doc = self.doc();
                    if doc.page > 0 {
                        doc.checkpoint();
                        let i = doc.page;
                        doc.editors.swap(i - 1, i);
                        doc.doc.pages.swap(i - 1, i);
                        crate::session::swap_comment_pages(&mut doc.doc, i - 1, i);
                        doc.page = i - 1;
                        true
                    } else {
                        false
                    }
                };
                if moved {
                    self.mark_dirty();
                }
            }
            PageMenuCmd::MoveDown => {
                let moved = {
                    let doc = self.doc();
                    if doc.page + 1 < doc.editors.len() {
                        doc.checkpoint();
                        let i = doc.page;
                        doc.editors.swap(i, i + 1);
                        doc.doc.pages.swap(i, i + 1);
                        crate::session::swap_comment_pages(&mut doc.doc, i, i + 1);
                        doc.page = i + 1;
                        true
                    } else {
                        false
                    }
                };
                if moved {
                    self.mark_dirty();
                }
            }
        }
    }

    pub fn apply_ctx(&mut self, cmd: CtxCmd) {
        use CtxCmd::*;
        match cmd {
            Copy => {
                self.copy_nodes();
                return;
            }
            CopyAsCode => {
                self.copy_selection_as_code();
                return;
            }
            SelectAll => {
                self.doc().editor().select_all();
                return;
            }
            OutlineText => {
                // the font manager lives on the app, so this cannot run inside
                // the `doc` borrow below
                self.outline_selected_text();
                return;
            }
            Cut => {
                if !self.copy_nodes() {
                    return;
                }
                self.doc().editor().delete_selection();
                self.mark_dirty();
                return;
            }
            Paste => {
                self.paste_nodes();
                return;
            }
            _ => {}
        }
        // Refusals are reported after the `doc` borrow ends — the status bar
        // belongs to the app, not the document.
        let mut refusal: Option<String> = None;
        let doc = self.doc();
        match cmd {
            Copy | Cut | Paste => unreachable!("clipboard handled above"),
            CopyAsCode => unreachable!("copy handled above"),
            OutlineText => unreachable!("outline text handled above"),
            Flatten => {
                if doc.editor().flatten_selected().is_none() {
                    refusal = Some(
                        "Select one shape or group to flatten (a vector layer is already flat)"
                            .into(),
                    );
                }
            }
            OutlineStroke => {
                if doc.editor().outline_stroke_selected().is_none() {
                    refusal = Some("Select one shape with a stroke weight to outline".into());
                }
            }
            Duplicate => {
                doc.editor().duplicate_selection((12.0, 12.0));
            }
            ToFront => {
                let id = doc.selected_id().clone();
                if let Some(id) = id {
                    doc.editor().bring_to_front(&id);
                }
            }
            ToBack => {
                let id = doc.selected_id().clone();
                if let Some(id) = id {
                    doc.editor().send_to_back(&id);
                }
            }
            Delete => doc.editor().delete_selection(),
            SelectAll => unreachable!("selection handled above"),
            Group => {
                doc.editor().group_selection(&x_native::fresh_id("group"));
            }
            Ungroup => {
                let id = doc.editor_ref().selection.first().cloned();
                if let Some(id) = id {
                    doc.editor().ungroup(&id);
                }
            }
            FrameSelection => {
                if doc.editor_ref().selection.is_empty() {
                    refusal = Some("Select at least one layer to frame it".into());
                } else {
                    // the engine sizes the frame to the members' collective
                    // bounds and re-parents them with their positions kept
                    doc.editor().frame_selection(&x_native::fresh_id("frame"));
                }
            }
            SectionSelection => {
                if doc.editor_ref().selection.is_empty() {
                    refusal = Some("Select at least one layer to wrap in a section".into());
                } else {
                    // the engine sizes the section to the members' collective
                    // bounds, lifts them to the canvas when a frame or group
                    // held them, and keeps their place on the page
                    doc.editor()
                        .section_selection(&x_native::fresh_id("section"));
                }
            }
            MakeComponent => {
                let n = doc.editor().component_names().len() + 1;
                doc.editor().make_component(&format!("Component {n}"));
            }
            Union | Subtract | Intersect | Exclude => {
                use x_native::booleans::BoolOp as B;
                use x_native::editor::{
                    ShapeBuilderOp as SbOp, DEFAULT_MIN_OVERLAP as MIN_OVERLAP,
                };
                let op = match cmd {
                    CtxCmd::Union => B::Union,
                    CtxCmd::Subtract => B::Subtract,
                    CtxCmd::Intersect => B::Intersect,
                    _ => B::Exclude,
                };
                // Union/Subtract go through the Shape Builder, which measures
                // the overlap first and refuses with a reason: merging two
                // shapes that never touch produced a compound path of two
                // unrelated islands, and subtracting a shape that fully
                // covers the other just deleted a layer. Intersect/Exclude
                // keep the raw boolean — an empty result IS their answer.
                let shape_builder = match op {
                    B::Union => Some(SbOp::Merge),
                    B::Subtract => Some(SbOp::Subtract),
                    _ => None,
                };
                match shape_builder {
                    Some(sb) => match doc.editor().shape_builder_selected(sb, MIN_OVERLAP) {
                        Ok(_) => {}
                        Err(issue) => refusal = Some(issue.message()),
                    },
                    None => {
                        doc.editor().boolean_selected(op);
                    }
                }
            }
            BringFwd => {
                if let Some(id) = doc.selected_id().clone() {
                    doc.editor().bring_forward(&id);
                }
            }
            SendBack => {
                if let Some(id) = doc.selected_id().clone() {
                    doc.editor().send_backward(&id);
                }
            }
            LockSel => {
                if let Some(id) = doc.selected_id().clone() {
                    let locked = {
                        let root = &doc.editor_ref().root;
                        crate::editor_ui::find_node(root, &id)
                            .map(|n| n.locked)
                            .unwrap_or(false)
                    };
                    doc.editor().set_locked(&id, !locked);
                }
            }
            HideSel => {
                if let Some(id) = doc.selected_id().clone() {
                    doc.editor().set_visible(&id, false);
                }
            }
        }
        if let Some(msg) = refusal {
            self.status = msg;
        }
        self.mark_dirty();
    }

    /// Outline text (Figma ⌥⌘O): swap the selected Text layer for its glyph
    /// outlines as ONE editable vector path, in ONE undo step. The glyph
    /// geometry comes from `x_native::outline_text_node`, i.e. the same shaping
    /// pipeline the canvas renders with, so the outline matches the text that
    /// was on screen.
    pub fn outline_selected_text(&mut self) {
        let miss = "Select a text layer to outline";
        let Some(id) = self.doc().selected_id() else {
            self.status = miss.into();
            return;
        };
        let vars = self.doc().doc.variables.clone();
        let Some(node) = self.doc().editor().get_node(&id).cloned() else {
            self.status = miss.into();
            return;
        };
        if !matches!(node.kind, NodeKind::Text { .. }) {
            self.status = miss.into();
            return;
        }
        let Some(v) = x_native::outline_text_node(&node, &self.fonts.fonts, &vars) else {
            self.status = "Cannot outline text - no font resolves for this layer".into();
            return;
        };
        if self.doc().editor().replace_node(&id, v) {
            self.mark_dirty();
            self.status = "Outlined text - the layer is now an editable vector path".into();
        } else {
            self.status = miss.into();
        }
    }

    // --------------------------------------------------- dev mode
    // (C21): the INSPECT tab's code view over the existing devmode
    // generators (CSS / SwiftUI / Compose / XML)

    pub const INSPECT_PLATFORMS: [&str; 5] = ["CSS", "SwiftUI", "Compose", "XML", "Tailwind"];

    /// Code for the current selection in the current INSPECT platform
    /// (empty string when nothing is selected).
    pub fn inspect_code(&self) -> String {
        let doc = match self.doc_opt() {
            Some(d) => d,
            None => return String::new(),
        };
        let Some(id) = doc.selected_id() else {
            return String::new();
        };
        let Some(n) = crate::editor_ui::find_node(&doc.editor_ref().root, &id) else {
            return String::new();
        };
        match self.inspect_platform {
            1 => x_native::editor::node_to_swift(n, &doc.doc.variables),
            2 => x_native::editor::node_to_compose(n, &doc.doc.variables),
            3 => x_native::editor::node_to_xml(n, &doc.doc.variables),
            4 => x_native::selection_to_tailwind(std::slice::from_ref(n)),
            _ => x_native::editor::node_to_css(n, &doc.doc.variables),
        }
    }

    // ------------------------------------------------------- comments
    // (C18): pins on the active page, composer + thread handled by the
    // editor shell's key/press paths

    /// Post a comment pin at world (x, y) on the ACTIVE page.
    pub fn post_comment(&mut self, x: f64, y: f64, text: &str) -> String {
        let doc = self.doc();
        let id = x_native::fresh_id("comment");
        doc.checkpoint();
        doc.doc.comments.push(x_native::Comment {
            id: id.clone(),
            page: doc.page,
            x,
            y,
            author: USER_NAME.to_string(),
            text: text.to_string(),
            resolved: false,
            parent: None,
        });
        self.mark_dirty();
        id
    }

    /// Reply to a comment thread: parents to the ROOT (flat threads — a
    /// reply to a reply still attaches to the root), inherits the page, and
    /// anchors near the root pin. `None` when `root_id` is unknown.
    pub fn post_reply(&mut self, root_id: &str, text: &str) -> Option<String> {
        let doc = self.doc();
        // Threads are flat: replying to a REPLY still attaches to the root.
        let mut root = doc.doc.comments.iter().find(|c| c.id == root_id)?.clone();
        while let Some(parent_id) = root.parent.clone() {
            root = doc.doc.comments.iter().find(|c| c.id == parent_id)?.clone();
        }
        let id = x_native::fresh_id("comment");
        let n = doc
            .doc
            .comments
            .iter()
            .filter(|c| c.parent.as_deref() == Some(root.id.as_str()))
            .count();
        doc.checkpoint();
        doc.doc.comments.push(x_native::Comment {
            id: id.clone(),
            page: root.page,
            x: root.x + 6.0,
            y: root.y + 10.0 + n as f64 * 6.0,
            author: USER_NAME.to_string(),
            text: text.to_string(),
            resolved: false,
            parent: Some(root.id.clone()),
        });
        self.mark_dirty();
        Some(id)
    }

    /// Number of replies in a thread (0 for unknown ids — and for replies,
    /// which never have their own replies).
    pub fn reply_count(&self, root_id: &str) -> usize {
        self.doc_opt()
            .map(|d| {
                d.doc
                    .comments
                    .iter()
                    .filter(|c| c.parent.as_deref() == Some(root_id))
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn resolve_comment(&mut self, id: &str, resolved: bool) {
        let doc = self.doc();
        // Thread-wide: resolving a root resolves its replies with it (a
        // reply id normalizes to its root). One message = one-member thread.
        let root_id = doc
            .doc
            .comments
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.parent.clone().unwrap_or_else(|| c.id.clone()));
        let Some(root_id) = root_id else {
            return;
        };
        let members = |c: &x_native::Comment| {
            c.id == root_id || c.parent.as_deref() == Some(root_id.as_str())
        };
        if !doc
            .doc
            .comments
            .iter()
            .any(|c| members(c) && c.resolved != resolved)
        {
            return;
        }
        doc.checkpoint();
        for c in doc.doc.comments.iter_mut().filter(|c| members(c)) {
            c.resolved = resolved;
        }
        self.mark_dirty();
    }

    pub fn delete_comment(&mut self, id: &str) {
        let doc = self.doc();
        let Some(c) = doc.doc.comments.iter().find(|c| c.id == id) else {
            return;
        };
        let is_root = c.parent.is_none();
        doc.checkpoint();
        if is_root {
            // deleting a root removes the whole thread
            doc.doc
                .comments
                .retain(|c| c.id != id && c.parent.as_deref() != Some(id));
        } else {
            doc.doc.comments.retain(|c| c.id != id);
        }
        self.mark_dirty();
    }

    /// Screen-space rect of a comment's avatar pin (24px circle anchored
    /// so the pin's top-left sits 12px right / 24px above the anchor,
    /// like Figma's cursor-tag offset).
    pub fn comment_pin_rect(&self, id: &str) -> Option<Rect> {
        let doc = self.doc_opt()?;
        let c = doc.doc.comments.iter().find(|c| c.id == id)?;
        if c.page != doc.page {
            return None;
        }
        let p = self.world_to_screen(Point::new(c.x, c.y));
        Some(Rect::new(p.x, p.y - 24.0, p.x + 24.0, p.y))
    }

    /// Topmost comment pin under a screen point (24px avatar, 6px slack).
    pub fn comment_at(&self, p: Point) -> Option<String> {
        let doc = self.doc_opt()?;
        let ids: Vec<String> = doc
            .doc
            .comments
            .iter()
            .filter(|c| c.page == doc.page)
            .map(|c| c.id.clone())
            .collect();
        for id in ids.iter().rev() {
            if let Some(mut r) = self.comment_pin_rect(id) {
                r.x0 -= 6.0;
                r.y0 -= 6.0;
                r.x1 += 6.0;
                r.y1 += 6.0;
                if r.contains(p) {
                    return Some(id.clone());
                }
            }
        }
        None
    }

    /// B13 "Copy as code": the selection (top-level picked nodes only —
    /// children shadowed by an also-selected ancestor) as JSX. Writes the
    /// system clipboard (best-effort; headless test runs have no display)
    /// and the status line; returns the code for tests.
    pub fn copy_selection_as_code(&mut self) -> Option<String> {
        let picked: Vec<x_native::Node> = {
            let doc = self.doc();
            let sel = doc.editor_ref().selection.clone();
            let root = &doc.editor_ref().root;
            let mut out = Vec::new();
            for id in &sel {
                // skip nodes whose ancestor is selected too (the subtree
                // already carries them)
                let mut cur = id.clone();
                let mut shadowed = false;
                while let Some(p) = x_native::editor::parent_id(root, &cur) {
                    if sel.contains(&p) {
                        shadowed = true;
                        break;
                    }
                    cur = p;
                }
                if shadowed {
                    continue;
                }
                if let Some(n) = crate::editor_ui::find_node(root, id) {
                    out.push(n.clone());
                }
            }
            out
        };
        if picked.is_empty() {
            return None;
        }
        let code = x_native::fileio::selection_to_jsx(&picked);
        let bytes = code.len();
        let sys = push_system_clipboard(&code);
        self.last_copied_code = Some(code.clone());
        self.status = if sys {
            format!("Copied {bytes} chars of JSX to the clipboard")
        } else {
            format!("Copied {bytes} chars of JSX")
        };
        Some(code)
    }

    pub fn open_blank(&mut self) {
        let n = self.docs_count_untitled();
        self.docs.push(OpenDoc::new_blank(format!("Untitled{n}")));
        self.active = self.docs.len() - 1;
        self.screen = Screen::Editor;
        self.center_view();
    }

    /// Open a new blank Board document (infinite canvas for brainstorming)
    pub fn open_blank_board(&mut self) {
        use x_board::{BoardDocument, BoardKind};
        let n = self.docs_count_untitled();
        let board_doc = BoardDocument::new(&format!("Board {}", n), BoardKind::Brainstorm);

        // Create OpenDoc with board_doc set
        let mut od = OpenDoc::new_blank(format!("Board {}", n));
        od.doc.kind = x_native::DocumentKind::Board;
        od.board_doc = Some(board_doc);

        self.docs.push(od);
        self.active = self.docs.len() - 1;
        // Board documents use the board scene and board input state. The old
        // path opened them in the artboard editor, which made the visible
        // board toolbar look active while clicks still hit design-canvas code.
        self.screen = Screen::Board;
        self.center_view();
    }

    /// Import a Figma document (from clipboard or file) into the current page.
    /// Used for direct Figma copy-paste functionality.
    pub fn import_figma_document(&mut self, figma_doc: x_native::Document) {
        // Merge variables, styles, assets from Figma doc
        let target = self.doc();

        // Merge variables
        for (name, var) in &figma_doc.variables.colors {
            if !target.doc.variables.colors.contains_key(name) {
                target.doc.variables.colors.insert(name.clone(), *var);
            }
        }
        for (name, var) in &figma_doc.variables.numbers {
            if !target.doc.variables.numbers.contains_key(name) {
                target.doc.variables.numbers.insert(name.clone(), *var);
            }
        }
        for (name, var) in &figma_doc.variables.strings {
            if !target.doc.variables.strings.contains_key(name) {
                target
                    .doc
                    .variables
                    .strings
                    .insert(name.clone(), var.clone());
            }
        }
        for (name, var) in &figma_doc.variables.bools {
            if !target.doc.variables.bools.contains_key(name) {
                target.doc.variables.bools.insert(name.clone(), *var);
            }
        }

        // Merge assets
        for asset in figma_doc.assets.iter_sorted() {
            target.doc.assets.register(
                &asset.name,
                asset.bytes.clone(),
                x_native::AssetSource::Embedded,
            );
        }

        // Merge component definitions
        for page in &figma_doc.pages {
            for node in &page.children {
                if let x_native::NodeKind::Component { name: _ } = &node.kind {
                    // Add component to registry (hidden, like clipboard deps)
                    let mut comp = node.clone();
                    comp.visible = false;
                    target.doc.pages[target.page].children.push(comp);
                }
            }
        }

        // Copy visible nodes to current page with new IDs
        let mut id_map = std::collections::HashMap::new();
        for page in &figma_doc.pages {
            for node in &page.children {
                if matches!(&node.kind, x_native::NodeKind::Component { .. }) {
                    continue; // Skip component defs, already added
                }
                let mut new_node = node.clone();
                let old_id = new_node.id.clone();
                new_node.id = x_native::fresh_id("node");
                id_map.insert(old_id, new_node.id.clone());

                // Reset transform to place at canvas center
                new_node.transform =
                    x_native::Transform::from_affine(vello::kurbo::Affine::translate((50.0, 50.0)));

                target.doc.pages[target.page].children.push(new_node);
            }
        }

        // Update selection to newly pasted nodes
        let new_ids: Vec<String> = id_map.values().cloned().collect();
        if !new_ids.is_empty() {
            target.editor().selection = new_ids;
            target.frame_cache = x_native::FrameCache::new();
            target.finish_document_edit();
            self.status = format!("Pasted {} node(s) from Figma", id_map.len());
        }
    }

    fn docs_count_untitled(&self) -> usize {
        1 + self
            .docs
            .iter()
            .filter(|d| d.name.starts_with("Untitled") && d.path.is_none())
            .count()
    }

    pub fn close_doc(&mut self, idx: usize) {
        if idx >= self.docs.len() {
            return;
        }

        // QA-002 FIX: Add warning and user feedback when trying to close dirty docs
        // This should only be called after user confirms save/discard via request_close_doc()
        if self.docs[idx].dirty {
            eprintln!(
                "[BUG] close_doc() called on dirty document at index {}. \
                 Caller should use request_close_doc() to show save dialog.",
                idx
            );
            // Set status to inform the user if this is the active document
            if idx == self.active {
                self.status = format!(
                    "Cannot close '{}': Document has unsaved changes. \
                     Please save or discard changes first.",
                    self.docs[idx].name
                );
            }
            return;
        }

        let removed = self.docs.remove(idx);
        let _ = std::fs::remove_file(&removed.recovery_path);
        if let Some(path) = removed.path.as_ref() {
            x_native::fileio::clear_autosave(&path.to_string_lossy());
        }
        if self.active > idx {
            self.active -= 1;
        }
        if self.docs.is_empty() {
            self.screen = Screen::Dashboard;
            self.active = 0;
        } else {
            self.active = self.active.min(self.docs.len() - 1);
        }
    }

    /// Center the view on document content (first open: like the HTML —
    /// the 375x420 frame centered in the canvas with p-8 padding).
    /// Collapse every expanded layer, keeping only the selection's
    /// ancestors expanded (Figma parity; audit F6).
    pub fn collapse_all_layers(&mut self) {
        let doc = self.doc();
        let sel = doc.editor_ref().selection.clone();
        let mut keep: HashSet<String> = HashSet::new();
        for target in &sel {
            let mut path: Vec<String> = Vec::new();
            let _ = collect_ancestor_path(&doc.editor_ref().root, target, &mut path, &mut keep);
        }
        doc.expanded.retain(|id| keep.contains(id));
    }

    /// P13: rebuild the find/replace match list from the current query.
    /// Scans text layers of the active page (case per `case_sensitive`);
    /// `in_selection` restricts the search to the selected subtrees.
    pub fn rescan_find(&mut self) {
        let mut matches: Vec<String> = Vec::new();
        // owned: `self.doc()` below takes `&mut self`
        let q = self.find_replace.query.trim().to_string();
        let case = self.find_replace.case_sensitive;
        if !q.is_empty() {
            // the "in selection" toggle scopes the search to the current
            // selection; off = the whole page
            let in_scope = self.find_replace.in_selection;
            let doc = self.doc();
            let sel = if in_scope {
                doc.editor_ref().selection.clone()
            } else {
                Vec::new()
            };
            let root = &doc.editor_ref().root;
            scan_find(root, &q, case, &sel, false, &mut matches);
        }
        self.find_replace.matches = matches.clone();
        self.find_replace.match_count = matches.len();
        // 0 = nothing selected yet (the first Next lands on match 1);
        // an out-of-range index collapses to the last match
        if self.find_replace.current_match > matches.len() {
            self.find_replace.current_match = matches.len();
        }
    }

    /// P13: step to the next (1) / previous (-1) find match, wrapping;
    /// selects the matched layer and centers the camera on it.
    pub fn find_nav(&mut self, dir: i32) {
        if self.find_replace.query.is_empty() {
            return;
        }
        if self.find_replace.matches.is_empty() {
            self.rescan_find();
        }
        let n = self.find_replace.matches.len();
        if n == 0 {
            self.status = "No matches".into();
            return;
        }
        let next = if self.find_replace.current_match == 0 {
            if dir < 0 {
                n
            } else {
                1
            }
        } else {
            let cur = self.find_replace.current_match.clamp(1, n);
            let step = if dir < 0 { n - 1 } else { 1 };
            (cur - 1 + step) % n + 1
        };
        self.find_replace.current_match = next;
        let id = self.find_replace.matches[next - 1].clone();
        let center_w = {
            let doc = self.doc();
            doc.editor().selection = vec![id.clone()];
            doc.editor_ref()
                .get_node(&id)
                .map(|n| (n.transform.x + n.w / 2.0, n.transform.y + n.h / 2.0))
        };
        if let Some((cx, cy)) = center_w {
            let sp = self.world_to_screen(Point::new(cx, cy));
            let reg = self.editor_regions();
            let cx = (reg.canvas.x0 + reg.canvas.x1) / 2.0;
            let cy = (reg.canvas.y0 + reg.canvas.y1) / 2.0;
            self.pan = (self.pan.0 + (cx - sp.x), self.pan.1 + (cy - sp.y));
        }
        self.status = format!(
            "Match {}/{}",
            self.find_replace.current_match, self.find_replace.match_count
        );
    }

    /// P13: replace every occurrence of the query in every matched text
    /// layer (one undo entry per layer). Returns the number of layers
    /// changed.
    pub fn replace_all_find(&mut self) -> usize {
        let (q, repl, case) = (
            self.find_replace.query.trim().to_string(),
            self.find_replace.replace.clone(),
            self.find_replace.case_sensitive,
        );
        if q.is_empty() || self.find_replace.matches.is_empty() {
            return 0;
        }
        let ids = self.find_replace.matches.clone();
        let mut changed = 0;
        for id in &ids {
            let new = {
                let doc = self.doc();
                let Some(node) = doc.editor_ref().get_node(id) else {
                    continue;
                };
                match &node.kind {
                    NodeKind::Text { text } => {
                        let new = replace_all_text(text, &q, &repl, case);
                        if new == *text {
                            continue;
                        }
                        Some(new)
                    }
                    _ => continue,
                }
            };
            if let Some(new) = new {
                let doc = self.doc();
                doc.editor().set_text(id, &new);
                changed += 1;
            }
        }
        if changed > 0 {
            self.mark_dirty();
        }
        self.rescan_find();
        changed
    }

    /// P13: replace every occurrence of the query in the *current* match
    /// only (the "Replace" button, as opposed to `replace_all_find`).
    pub fn replace_current_find(&mut self) -> bool {
        let (q, repl, case) = (
            self.find_replace.query.trim().to_string(),
            self.find_replace.replace.clone(),
            self.find_replace.case_sensitive,
        );
        if q.is_empty() || self.find_replace.matches.is_empty() {
            return false;
        }
        let cur = self
            .find_replace
            .current_match
            .clamp(1, self.find_replace.matches.len());
        let id = self.find_replace.matches[cur - 1].clone();
        let new = {
            let doc = self.doc();
            let Some(node) = doc.editor_ref().get_node(&id) else {
                return false;
            };
            match &node.kind {
                NodeKind::Text { text } => {
                    let new = replace_all_text(text, &q, &repl, case);
                    if new == *text {
                        return false;
                    }
                    Some(new)
                }
                _ => return false,
            }
        };
        if let Some(new) = new {
            let doc = self.doc();
            doc.editor().set_text(&id, &new);
            self.mark_dirty();
            self.rescan_find();
            return true;
        }
        false
    }

    /// P12: apply a layers-tree drop (from the active `Drag::TreeRow`):
    /// reorder the dragged row to the resolved target and keep it
    /// selected. No-op when there is no live drag or the move is
    /// invalid/a no-op.
    pub fn apply_tree_drop(&mut self, drop: &TreeDrop) {
        let Some(Drag::TreeRow { id, .. }) = self.drag.clone() else {
            return;
        };
        let root = {
            let doc = self.doc();
            doc.editor_ref().root.clone()
        };
        let Some((from_parent, from_index)) = node_slot(&root, &id) else {
            return;
        };
        let moved = {
            let doc = self.doc();
            doc.editor()
                .reorder_node(&id, &from_parent, from_index, &drop.parent, drop.index)
        };
        if moved {
            let doc = self.doc();
            doc.editor().selection = vec![id];
            self.mark_dirty();
            self.status = "Layer reordered - one undo step".into();
        }
    }

    pub fn center_view(&mut self) {
        if self.screen == Screen::Board {
            // Infinite boards have no authored page frame to fit. Put the
            // world origin near the visual centre so the first created item
            // is immediately visible and keep the same camera for painting
            // and pointer hit-testing.
            self.zoom = 1.0;
            self.pan = (self.win_w * 0.5, (self.win_h - ED_TITLE_H) * 0.5);
            return;
        }
        let camera = crate::loading::ViewConfig::from_app(self).camera(self.doc_opt());
        self.zoom = camera.zoom;
        self.pan = camera.pan;
    }

    /// A layer's effect stack as every reader sees it: the ordered stack once
    /// the node is materialized, the flat legacy list otherwise. The Effects
    /// panel, the drag targets and the colour popover all come through here,
    /// so none of them can disagree about what the list holds.
    pub fn effect_layers_of(&self, id: &str) -> Vec<x_native::EffectLayer> {
        let Some(doc) = self.doc_opt() else {
            return vec![];
        };
        let root = &doc.editor_ref().root;
        fn find<'a>(n: &'a x_native::Node, id: &str) -> Option<&'a x_native::Node> {
            if n.id == id {
                return Some(n);
            }
            n.children.iter().find_map(|c| find(c, id))
        }
        match find(root, id) {
            Some(n) if n.visual_stacks_materialized => n.effect_layers.clone(),
            Some(n) => n
                .effects
                .iter()
                .cloned()
                .map(x_native::EffectLayer::new)
                .collect(),
            None => vec![],
        }
    }

    /// Close every popover the inspector can have open. One at a time is the
    /// panel's rule (its menus anchor to the rows they came from, so two open
    /// at once would overlap), and it is what Figma does when you open the
    /// next control.
    pub fn close_panel_menus(&mut self) {
        self.effect_add_open = false;
        self.effect_kind_open = None;
        self.effect_blend_open = None;
        self.layer_blend_open = false;
        self.paint_blend_open = None;
    }

    pub fn mark_dirty(&mut self) {
        if let Some(d) = self.docs.get_mut(self.active) {
            d.record_page_changes(self.drag.is_some());
            d.dirty = true;
        }
    }

    /// Board mutations do not belong to the design editor's page history.
    /// Keep the shell's unsaved indicator accurate without manufacturing a
    /// design-page undo entry for an infinite-canvas gesture.
    pub fn mark_board_dirty(&mut self) {
        if let Some(d) = self.docs.get_mut(self.active) {
            d.dirty = true;
            d.bump_board_revision();
            d.last_autosave_revision = None;
        }
    }
}

pub struct EdRegions {
    pub left: Rect,
    pub nav_bar: Rect,
    pub sidebar: Rect,
    pub right: Rect,
    pub canvas: Rect,
}

pub struct BoardRegions {
    pub canvas: Rect,
}

// ------------------------------------------------------------ node helpers

/// Layer-type icon per the v45 mapping. Every kind is listed on purpose: a new
/// `NodeKind` should fail to compile here rather than silently become a box.
pub fn kind_icon(k: &NodeKind) -> &'static str {
    match k {
        NodeKind::Frame { .. } => "frame#",
        NodeKind::Rect { .. } => "square",
        NodeKind::Group => "layout-grid",
        NodeKind::Section => "section",
        NodeKind::Text { .. } => "type",
        NodeKind::Ellipse => "circle",
        NodeKind::Poly { .. } => "triangle",
        NodeKind::Star { .. } => "star",
        NodeKind::Vector { .. } | NodeKind::Arc { .. } | NodeKind::Line => "pen-tool",
        NodeKind::Component { .. } | NodeKind::Instance { .. } => "component",
        NodeKind::Image { .. } => "image",
        NodeKind::Slice => "scissors",
    }
}

// ================================================================ UX Analysis (Quant-UX inspired)
// Deterministic, rule-based analysis - no AI/LLM calls.

impl App {
    /// Check WCAG AA/AAA contrast for all text layers
    pub fn run_ux_accessibility_check(&mut self) {
        let (root, vars) = {
            let doc = self.doc();
            (doc.editor_ref().root.clone(), doc.doc.variables.clone())
        };
        let mut issues = Vec::new();
        check_contrast_node(&root, &mut issues, &vars);

        let status = if issues.is_empty() {
            "No text layers found".to_string()
        } else {
            format!("A11Y: {}", issues.join(" | "))
        };
        self.status = status;
    }

    /// Analyze user flow from prototype connections
    pub fn run_ux_user_flow_analysis(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut frames = Vec::new();
        let mut connections = Vec::new();
        collect_flow_frames(&root, &mut frames, &mut connections);

        let status = format!(
            "FLOW: {} frames found, {} prototype connections",
            frames.len(),
            connections.len()
        );
        self.status = status;
    }

    /// Calculate design quality score based on alignment, spacing, naming
    pub fn run_ux_quality_score(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut score = 100.0;
        let mut feedback = Vec::new();
        evaluate_quality_node(&root, &mut score, &mut feedback);
        score = score.max(0.0);

        let grade = match score as u8 {
            90..=100 => "Excellent",
            75..=89 => "Good",
            60..=74 => "Fair",
            _ => "Needs Improvement",
        };

        let status = format!(
            "QUALITY: {} ({:.0}/100) - {}",
            grade,
            score,
            feedback.first().unwrap_or(&"No issues found".to_string())
        );
        self.status = status;
    }

    /// Review component usage patterns
    pub fn run_ux_interaction_patterns(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut components_used = std::collections::HashMap::new();
        count_component_uses(&root, &mut components_used);

        let total: usize = components_used.values().sum();
        let status = if total == 0 {
            "PATTERNS: No component instances found".to_string()
        } else {
            format!(
                "PATTERNS: {} component types used {} times total",
                components_used.len(),
                total
            )
        };
        self.status = status;
    }

    /// Verify text readability with detailed contrast analysis
    pub fn run_ux_color_contrast(&mut self) {
        // This is a more detailed version of accessibility check
        self.run_ux_accessibility_check();
        self.status = self.status.replace("A11Y:", "CONTRAST:");
        self.mark_dirty();
    }

    /// Test different screen sizes (mobile, tablet, desktop)
    pub fn run_ux_responsive_preview(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut frame_sizes = Vec::new();
        collect_frame_sizes(&root, &mut frame_sizes);

        let breakpoints = [
            ("Mobile", 375.0, 812.0),
            ("Tablet", 768.0, 1024.0),
            ("Desktop", 1440.0, 900.0),
        ];

        let mut matches = Vec::new();
        for (name, w, h) in &frame_sizes {
            for (bp_name, bp_w, bp_h) in &breakpoints {
                if (w - bp_w).abs() < 50.0 && (h - bp_h).abs() < 50.0 {
                    matches.push(format!("'{}' matches {} breakpoint", name, bp_name));
                }
            }
        }

        let status = if matches.is_empty() {
            format!(
                "RESPONSIVE: {} frames found. Consider creating Mobile (375x812), Tablet (768x1024), or Desktop (1440x900) artboards",
                frame_sizes.len()
            )
        } else {
            format!("RESPONSIVE: {}", matches.join(" | "))
        };
        self.status = status;
    }
}

fn collect_flow_frames(
    n: &x_native::Node,
    frames: &mut Vec<String>,
    connections: &mut Vec<(String, String)>,
) {
    if let x_native::NodeKind::Frame { .. } = &n.kind {
        frames.push(n.name.clone());
        // Check for prototype connections
        if let Some(interactions) = n.bindings.get("prototype:interactions") {
            connections.push((n.name.clone(), interactions.clone()));
        }
    }
    for child in &n.children {
        collect_flow_frames(child, frames, connections);
    }
}

fn evaluate_quality_node(n: &x_native::Node, score: &mut f64, feedback: &mut Vec<String>) {
    // Check naming convention
    if n.name.starts_with("Rectangle") || n.name.starts_with("Frame") || n.name.starts_with("Group")
    {
        *score -= 5.0;
        feedback.push(format!("Rename '{}' to something descriptive", n.name));
    }

    // Check for nested frames (potential auto-layout candidates)
    let frame_children: usize = n
        .children
        .iter()
        .filter(|c| matches!(c.kind, x_native::NodeKind::Frame { .. }))
        .count();
    if frame_children > 3 {
        *score -= 3.0;
        feedback.push(format!("Consider Auto Layout for '{}'", n.name));
    }

    for child in &n.children {
        evaluate_quality_node(child, score, feedback);
    }
}

fn count_component_uses(n: &x_native::Node, counts: &mut std::collections::HashMap<String, usize>) {
    if let x_native::NodeKind::Instance { component, .. } = &n.kind {
        *counts.entry(component.clone()).or_insert(0) += 1;
    }
    for child in &n.children {
        count_component_uses(child, counts);
    }
}

fn collect_frame_sizes(n: &x_native::Node, sizes: &mut Vec<(String, f64, f64)>) {
    if let x_native::NodeKind::Frame { .. } = &n.kind {
        sizes.push((n.name.clone(), n.w, n.h));
    }
    for child in &n.children {
        collect_frame_sizes(child, sizes);
    }
}

fn check_contrast_node(n: &x_native::Node, issues: &mut Vec<String>, vars: &x_native::Variables) {
    use x_native::{paint_color, Color, NodeKind};
    if let NodeKind::Text { .. } = &n.kind {
        let text_color = paint_color(&n.fill, vars);
        // Assume white background for simplicity (could be improved)
        let bg_color = Color::WHITE;
        let ratio = calculate_contrast_ratio(text_color, bg_color);

        if ratio < 4.5 {
            issues.push(format!(
                "'{}': Contrast ratio {:.2}:1 (needs 4.5:1 for AA)",
                n.name, ratio
            ));
        } else if ratio < 7.0 {
            issues.push(format!(
                "'{}': Contrast ratio {:.2}:1 (AA pass, AAA needs 7.0:1)",
                n.name, ratio
            ));
        } else {
            issues.push(format!("'{}': AAA compliant ({:.2}:1)", n.name, ratio));
        }
    }
    for child in &n.children {
        check_contrast_node(child, issues, vars);
    }
}

/// Calculate WCAG contrast ratio between two colors
fn calculate_contrast_ratio(fg: Color, bg: Color) -> f64 {
    let fg_luma = relative_luminance(fg);
    let bg_luma = relative_luminance(bg);

    let lighter = fg_luma.max(bg_luma);
    let darker = fg_luma.min(bg_luma);

    (lighter + 0.05) / (darker + 0.05)
}

/// Calculate relative luminance per WCAG 2.1
fn relative_luminance(c: Color) -> f64 {
    let rgba = c.to_rgba8();
    let rsrgb = rgba.r as f64 / 255.0;
    let gsrgb = rgba.g as f64 / 255.0;
    let bsrgb = rgba.b as f64 / 255.0;

    let r = if rsrgb <= 0.03928 {
        rsrgb / 12.92
    } else {
        ((rsrgb + 0.055) / 1.055).powf(2.4)
    };
    let g = if gsrgb <= 0.03928 {
        gsrgb / 12.92
    } else {
        ((gsrgb + 0.055) / 1.055).powf(2.4)
    };
    let b = if bsrgb <= 0.03928 {
        bsrgb / 12.92
    } else {
        ((bsrgb + 0.055) / 1.055).powf(2.4)
    };

    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Fill hex of a node (first fill layer, else `fill`), like the HTML's
/// FFFFFF field.
pub fn node_fill_hex(n: &Node, vars: &Variables) -> String {
    let color = match n.fill_layers.first() {
        Some(l) => x_native::paint_color(&l.paint, vars),
        None => x_native::paint_color(&n.fill, vars),
    };
    color_hex(color)
}

pub fn node_stroke_hex(n: &Node, vars: &Variables) -> String {
    match n.stroke_layers.first() {
        Some(l) => color_hex(x_native::paint_color(&l.stroke.paint, vars)),
        None => {
            if n.stroke.width > 0.0 {
                color_hex(x_native::paint_color(&n.stroke.paint, vars))
            } else {
                "000000".into()
            }
        }
    }
}

pub fn color_hex(c: Color) -> String {
    let rgba = c.to_rgba8();
    format!("{:02X}{:02X}{:02X}", rgba.r, rgba.g, rgba.b)
}

pub fn parse_hex(s: &str) -> Option<Color> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(Color::from_rgb8(r, g, b))
}

/// System clipboard, best-effort (headless/test runs have no display —
/// the code stays available through `App::last_copied_code`).
pub fn push_system_clipboard(text: &str) -> bool {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        cb.set_text(text.to_string()).is_ok()
    } else {
        false
    }
}

/// Try to get text content from system clipboard.
/// Returns None if clipboard is empty or inaccessible.
pub fn get_system_clipboard_text() -> Option<String> {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        cb.get_text().ok()
    } else {
        None
    }
}

/// Check if clipboard contains Figma JSON data.
/// Figma copies nodes as JSON when using Cmd+C/Ctrl+C in Figma.
pub fn try_import_from_figma_clipboard() -> Option<x_native::Document> {
    let clipboard_text = get_system_clipboard_text()?;

    // QA-001 FIX: Add early validation and debug logging
    // Early exit for empty or very short content
    if clipboard_text.trim().is_empty() || clipboard_text.len() < 10 {
        return None;
    }

    // Quick check: Figma JSON must start with '{' and contain "document"
    let trimmed = clipboard_text.trim();
    if !trimmed.starts_with('{') || !trimmed.contains("\"document\"") {
        // Not Figma format - could be plain text or other app's clipboard
        eprintln!("[CLIPBOARD] Content does not appear to be Figma JSON");
        return None;
    }

    // Try to parse as Figma JSON with better error reporting
    match x_native::fileio::import_figma_json(&clipboard_text) {
        Ok(doc) => {
            eprintln!("[CLIPBOARD] Successfully imported Figma document");
            Some(doc)
        }
        Err(e) => {
            eprintln!("[CLIPBOARD] Figma import failed: {}", e);
            // Provide more context about what went wrong
            if e.contains("no \"document\"") {
                eprintln!("[CLIPBOARD] Expected Figma REST API format with 'document' key");
            } else if e.contains("not a Figma REST JSON") {
                eprintln!("[CLIPBOARD] JSON structure doesn't match Figma format");
            }
            None
        }
    }
}

/// P13: collect ids of text layers whose content matches `q` (case per
/// `case_sensitive`); `sel` non-empty restricts the search to the
/// selected subtrees (Figma's "find in selection").
fn scan_find(
    node: &Node,
    q: &str,
    case: bool,
    sel: &[String],
    in_sel: bool,
    out: &mut Vec<String>,
) {
    // `in_sel`: an ancestor is selected. An unselected node is never
    // pruned here — it may still contain a selected descendant — but
    // only nodes inside a selected subtree are tested.
    let in_sel = in_sel || sel.iter().any(|s| s == &node.id);
    if sel.is_empty() || in_sel {
        if let NodeKind::Text { text } = &node.kind {
            let hit = if case {
                text.contains(q)
            } else {
                text.to_lowercase().contains(&q.to_lowercase())
            };
            if hit {
                out.push(node.id.clone());
            }
        }
    }
    for c in &node.children {
        scan_find(c, q, case, sel, in_sel, out);
    }
}

/// P13: case-aware literal replace-all over a string.
pub fn replace_all_text(text: &str, q: &str, repl: &str, case: bool) -> String {
    if q.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let matched = if case {
            text[i..].starts_with(q)
        } else {
            case_insensitive_prefix(&text[i..], q)
        };
        if matched {
            out.push_str(repl);
            i += q.len();
        } else {
            let ch = text[i..].chars().next().map_or(1, |c| c.len_utf8());
            out.push_str(&text[i..i + ch]);
            i += ch;
        }
    }
    out
}

fn case_insensitive_prefix(hay: &str, needle: &str) -> bool {
    let hc: Vec<char> = hay.chars().collect();
    let nc: Vec<char> = needle.chars().collect();
    if hc.len() < nc.len() {
        return false;
    }
    hc[..nc.len()]
        .iter()
        .zip(nc.iter())
        .all(|(a, b)| a.to_lowercase().eq(b.to_lowercase()))
}

/// P12: `(parent id, child index)` of `id` within `root` — a top-level
/// child reports the root's own id as parent. `None` for the root or an
/// unknown id.
pub fn node_slot(root: &Node, id: &str) -> Option<(String, usize)> {
    fn walk(n: &Node, id: &str) -> Option<(String, usize)> {
        for (i, c) in n.children.iter().enumerate() {
            if c.id == id {
                return Some((n.id.clone(), i));
            }
            if let Some(found) = walk(c, id) {
                return Some(found);
            }
        }
        None
    }
    if root.id == id {
        return None;
    }
    walk(root, id)
}

/// P12: resolve a layers-tree drop `(target row, zone)` into
/// `(destination parent id, insertion index)`: before/after = the
/// target's own parent slot; child = append at the end of the target's
/// children.
pub fn tree_drop_coords(root: &Node, target: &str, zone: u8) -> Option<(String, usize)> {
    let (parent, node) = {
        fn walk<'a>(n: &'a Node, id: &str) -> Option<(Option<&'a Node>, &'a Node)> {
            for c in &n.children {
                if c.id == id {
                    return Some((Some(n), c));
                }
                if let Some(found) = walk(c, id) {
                    return Some(found);
                }
            }
            None
        }
        walk(root, target)?
    };
    let pid = parent
        .map(|p| p.id.clone())
        .unwrap_or_else(|| root.id.clone());
    let slot = parent.and_then(|p| p.children.iter().position(|c| c.id == node.id))?;
    match zone {
        0 => Some((pid, slot)),
        2 => Some((pid, slot + 1)),
        1 => Some((node.id.clone(), node.children.len())),
        _ => None,
    }
}

fn collect_ancestor_path(
    node: &Node,
    target: &str,
    path: &mut Vec<String>,
    keep: &mut HashSet<String>,
) -> bool {
    path.push(node.id.clone());
    let found = if node.id == target {
        keep.extend(path.iter().cloned());
        true
    } else {
        node.children
            .iter()
            .any(|c| collect_ancestor_path(c, target, path, keep))
    };
    path.pop();
    found
}

// --------------------------------------------------- dashboard thumbnails

impl App {
    /// (w, h) of the cached thumbnail for `path`, if fresh (the stored mtime
    /// still matches the file on disk).
    pub fn thumb_ready(&self, path: &std::path::Path) -> Option<(u32, u32)> {
        let (mt, assets) = self.thumbs.get(path)?;
        let cur = std::fs::metadata(path).ok()?.modified().ok()?;
        if cur != *mt {
            return None;
        }
        let b = assets.get("thumb")?;
        Some((b.image.width, b.image.height))
    }

    /// The cached asset bundle for `path` (call after `thumb_ready`).
    pub fn thumb_brush(&self, path: &std::path::Path) -> Option<&x_native::Assets> {
        self.thumbs.get(path).map(|(_, a)| a)
    }

    /// Render at most one pending thumbnail per call (the dashboard calls
    /// this once per frame, so a wall of new files warms up progressively
    /// instead of hitching). Skips cached and known-failed entries.
    pub fn thumb_pump(&mut self, pending: Vec<std::path::PathBuf>) {
        for p in pending {
            if self.thumbs.contains_key(&p) || self.thumb_failed.contains(&p) {
                continue;
            }
            self.render_thumb(&p);
            return;
        }
    }

    /// Disk-cache location for a thumbnail: FNV-1a of path + mtime under
    /// `~/.config/x-native/thumbs/`. `None` without a HOME.
    fn thumb_cache_file(
        path: &std::path::Path,
        mt: &std::time::SystemTime,
    ) -> Option<std::path::PathBuf> {
        let home = std::env::var_os("HOME")?;
        let mut h: u64 = 0xcbf2_9fe4_8422_2325;
        for b in path.to_string_lossy().as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        let nanos = mt
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for b in nanos.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        Some(
            std::path::PathBuf::from(home)
                .join(".config")
                .join("x-native")
                .join("thumbs")
                .join(format!("{h:016x}.png")),
        )
    }

    fn render_thumb(&mut self, path: &std::path::Path) {
        let fail = |me: &mut Self| {
            me.thumb_failed.insert(path.to_path_buf());
        };
        let Ok(md) = std::fs::metadata(path) else {
            fail(self);
            return;
        };
        let Ok(mt) = md.modified() else {
            fail(self);
            return;
        };
        // Warm sessions: a valid disk-cache hit skips the document parse.
        let cache = Self::thumb_cache_file(path, &mt);
        if let Some(cf) = &cache {
            if let Ok(bytes) = std::fs::read(cf) {
                let mut a = x_native::Assets::new();
                if a.load_png_bytes("thumb", &bytes).is_ok() {
                    self.thumbs.insert(path.to_path_buf(), (mt, a));
                    return;
                }
            }
        }
        // v1 scope: native documents only (other formats keep the watermark).
        if path.extension().map(|e| e != "x").unwrap_or(true) {
            fail(self);
            return;
        }
        let doc = match x_native::fileio::load_x_file(&path.to_string_lossy()) {
            Ok(d) => d,
            Err(_) => {
                fail(self);
                return;
            }
        };
        let Some(page) = doc.pages.first() else {
            fail(self);
            return;
        };
        // Same export path as PNG export (prepare_export strips frame-name
        // labels and outlines text), so the preview cannot drift from the
        // artifact the user gets. Embedded image assets are not decoded in
        // this path — v1 previews are text+vector.
        let Ok(plan) = x_native::prepare_export(page, &doc.variables, None, &self.fonts.fonts)
        else {
            fail(self);
            return;
        };
        let scale = (340.0 / plan.width.max(plan.height).max(1.0)).clamp(0.05, 1.0);
        let Ok((png, _, _)) = x_native::export_raster(
            &plan.tree,
            plan.width,
            plan.height,
            x_native::RasterFormat::Png,
            scale,
            None,
            None,
            Some(&self.fonts.fonts),
        ) else {
            fail(self);
            return;
        };
        if let Some(cf) = &cache {
            if let Some(dir) = cf.parent() {
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::write(cf, &png);
            }
        }
        let mut a = x_native::Assets::new();
        if a.load_png_bytes("thumb", &png).is_ok() {
            self.thumbs.insert(path.to_path_buf(), (mt, a));
        } else {
            fail(self);
        }
    }
}

#[cfg(test)]
impl App {
    /// Explicit deterministic content for old inspector/screenshot fixtures.
    pub fn open_demo_blank(&mut self) {
        self.docs.push(OpenDoc::demo_blank("Demo".into()));
        self.active = self.docs.len() - 1;
        self.screen = Screen::Editor;
        self.center_view();
    }
}

#[cfg(test)]
mod tool_shortcut_tests {
    use super::{node_slot, replace_all_text, tree_drop_coords, App, Color, Node, NodeKind, Tool};

    #[test]
    fn design_mode_shortcuts_resolve() {
        let d = |k: &str, sh: bool| Tool::from_shortcut(k, sh, false);
        assert_eq!(d("v", false), Some(Tool::Select));
        assert_eq!(d("f", false), Some(Tool::Frame));
        assert_eq!(d("t", false), Some(Tool::Text));
        assert_eq!(d("r", false), Some(Tool::Rect));
        assert_eq!(d("o", false), Some(Tool::Ellipse));
        assert_eq!(d("p", false), Some(Tool::Pen));
        assert_eq!(d("p", true), Some(Tool::Pencil));
        assert_eq!(d("k", false), Some(Tool::Scale));
        assert_eq!(d("s", false), Some(Tool::Slice));
        assert_eq!(d("h", false), Some(Tool::Hand));
        assert_eq!(d("c", false), Some(Tool::Comment));
        assert_eq!(d("m", false), Some(Tool::Symmetry));
        assert_eq!(d("e", true), Some(Tool::Eraser));
    }

    #[test]
    fn board_mode_shortcuts_resolve() {
        let b = |k: &str, sh: bool| Tool::from_shortcut(k, sh, true);
        assert_eq!(b("s", false), Some(Tool::BoardSticky));
        assert_eq!(b("c", false), Some(Tool::BoardConnector));
        assert_eq!(b("r", false), Some(Tool::BoardRect));
        assert_eq!(b("o", false), Some(Tool::BoardCircle));
        assert_eq!(b("v", false), Some(Tool::Select));
        // design-only tools do not leak into boards
        assert_eq!(b("m", false), None);
        assert_eq!(b("f", false), Some(Tool::Frame));
    }

    #[test]
    fn collapse_all_keeps_selection_ancestors() {
        let mut app = App::new();
        app.open_blank();
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        doc.editor()
            .insert_node(&root_id, Node::frame("f1", 300.0, 200.0));
        doc.editor()
            .insert_node(&root_id, Node::frame("f2", 300.0, 200.0));
        doc.editor()
            .insert_node("f1", Node::rect("r1", 0.0, 0.0, 10.0, 10.0, Color::WHITE));
        doc.expanded.insert("f1".into());
        doc.expanded.insert("f2".into());
        doc.editor().selection.push("r1".into());
        app.collapse_all_layers();
        assert!(
            app.doc().expanded.contains("f1"),
            "selection ancestor stays open"
        );
        assert!(
            !app.doc().expanded.contains("f2"),
            "everything else collapses"
        );
    }

    #[test]
    fn replace_all_text_handles_case_and_boundaries() {
        assert_eq!(replace_all_text("a b a", "a", "c", true), "c b c");
        assert_eq!(replace_all_text("banana", "an", "X", true), "bXXa");
        assert_eq!(replace_all_text("A a Ab", "a", "c", false), "c c cb");
        assert_eq!(replace_all_text("hello", "z", "q", true), "hello");
        assert_eq!(replace_all_text("abc", "", "c", true), "abc");
        assert_eq!(replace_all_text("", "a", "c", false), "");
    }

    #[test]
    fn find_matches_text_layers_and_navigates() {
        let mut app = App::new();
        app.open_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            Node::text("t1", 0.0, 0.0, 100.0, 20.0, "Hello world"),
        );
        app.doc().editor().insert_node(
            &root_id,
            Node::text("t2", 0.0, 40.0, 100.0, 20.0, "hello again"),
        );
        app.doc().editor().insert_node(
            &root_id,
            Node::text("t3", 0.0, 80.0, 100.0, 20.0, "goodbye"),
        );
        app.find_replace.query = "hello".into();
        app.rescan_find();
        assert_eq!(app.find_replace.matches, vec!["t1", "t2"]);
        assert_eq!(app.find_replace.match_count, 2);
        app.find_nav(1);
        assert_eq!(app.find_replace.current_match, 1);
        assert_eq!(app.doc().editor_ref().selection, vec!["t1".to_string()]);
        app.find_nav(1);
        assert_eq!(app.find_replace.current_match, 2);
        app.find_nav(1); // wraps to first
        assert_eq!(app.find_replace.current_match, 1);
        app.find_nav(-1); // wraps to last
        assert_eq!(app.find_replace.current_match, 2);
        // case sensitivity: "HELLO" matches nothing case-sensitively
        // ("Hello" != "HELLO"), both again case-insensitively
        app.find_replace.query = "HELLO".into();
        app.find_replace.case_sensitive = true;
        app.rescan_find();
        assert!(app.find_replace.matches.is_empty());
        app.find_replace.case_sensitive = false;
        app.rescan_find();
        assert_eq!(app.find_replace.matches, vec!["t1", "t2"]);
        // "in selection" scope: after the navs the selection is [t2], so
        // only t2 is searched
        app.find_replace.in_selection = true;
        app.rescan_find();
        assert_eq!(app.find_replace.matches, vec!["t2"]);
        app.find_replace.in_selection = false;
        app.rescan_find();
        assert_eq!(app.find_replace.matches, vec!["t1", "t2"]);
    }

    #[test]
    fn replace_all_find_rewrites_and_is_undoable() {
        let mut app = App::new();
        app.open_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            Node::text("t1", 0.0, 0.0, 100.0, 20.0, "hello hello"),
        );
        app.doc().editor().insert_node(
            &root_id,
            Node::text("t2", 0.0, 40.0, 100.0, 20.0, "hello there"),
        );
        app.find_replace.query = "hello".into();
        app.find_replace.replace = "hi".into();
        app.rescan_find();
        assert_eq!(app.replace_all_find(), 2);
        let doc = app.doc();
        assert_eq!(
            doc.editor_ref().get_node("t1").unwrap().kind,
            NodeKind::Text {
                text: "hi hi".into()
            }
        );
        assert_eq!(
            doc.editor_ref().get_node("t2").unwrap().kind,
            NodeKind::Text {
                text: "hi there".into()
            }
        );
        // both layers back with two undos
        assert!(app.doc().editor().undo());
        assert!(app.doc().editor().undo());
        let doc = app.doc();
        let t1 = doc.editor_ref().get_node("t1").unwrap();
        assert!(matches!(&t1.kind, NodeKind::Text { text } if text == "hello hello"));
    }

    #[test]
    fn replace_current_find_touches_only_the_active_match() {
        let mut app = App::new();
        app.open_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            Node::text("t1", 0.0, 0.0, 100.0, 20.0, "hi there"),
        );
        app.doc()
            .editor()
            .insert_node(&root_id, Node::text("t2", 0.0, 40.0, 100.0, 20.0, "hi hi"));
        app.find_replace.query = "hi".into();
        app.find_replace.replace = "yo".into();
        app.rescan_find();
        app.find_nav(1);
        app.find_nav(1); // current match = t2
        assert!(app.replace_current_find());
        let doc = app.doc();
        assert_eq!(
            doc.editor_ref().get_node("t1").unwrap().kind,
            NodeKind::Text {
                text: "hi there".into()
            }
        );
        assert_eq!(
            doc.editor_ref().get_node("t2").unwrap().kind,
            NodeKind::Text {
                text: "yo yo".into()
            }
        );
    }

    #[test]
    fn tree_drop_slots_resolve_parents_and_zones() {
        let mut fr = Node::frame("fr", 100.0, 100.0);
        fr.children
            .push(Node::rect("in", 0.0, 0.0, 10.0, 10.0, Color::WHITE));
        let root = Node::frame("page", 100.0, 100.0)
            .child(fr)
            .child(Node::frame("fr2", 100.0, 100.0));
        assert_eq!(node_slot(&root, "fr"), Some(("page".into(), 0)));
        assert_eq!(node_slot(&root, "in"), Some(("fr".into(), 0)));
        assert_eq!(node_slot(&root, "page"), None);
        assert_eq!(node_slot(&root, "ghost"), None);
        // before fr2 = its slot; after = slot + 1; child = append to fr2
        assert_eq!(tree_drop_coords(&root, "fr2", 0), Some(("page".into(), 1)));
        assert_eq!(tree_drop_coords(&root, "fr2", 2), Some(("page".into(), 2)));
        assert_eq!(tree_drop_coords(&root, "fr2", 1), Some(("fr2".into(), 0)));
        assert_eq!(tree_drop_coords(&root, "ghost", 0), None);
    }

    #[test]
    fn tool_labels_and_hints_follow_mode() {
        assert_eq!(Tool::Select.label(), "Move");
        assert_eq!(Tool::Eraser.label(), "Vector eraser");
        assert_eq!(Tool::Pencil.label(), "Pencil");
        assert_eq!(Tool::Select.shortcut_hint(false), "V");
        assert_eq!(Tool::Eraser.shortcut_hint(false), "⇧E");
        assert_eq!(Tool::Symmetry.shortcut_hint(true), "");
        assert_eq!(Tool::Slice.shortcut_hint(false), "S");
        assert_eq!(Tool::Slice.label(), "Slice");
        assert_eq!(Tool::Slice.shortcut_hint(true), "");
        assert_eq!(Tool::BoardSticky.shortcut_hint(true), "S");
        assert_eq!(Tool::BoardSticky.shortcut_hint(false), "");
        assert_eq!(Tool::Comment.shortcut_hint(true), "");
    }

    #[test]
    fn shift_rules_hold() {
        // ⇧C stays free (old comment promised this; old code broke it)
        assert_eq!(Tool::from_shortcut("c", true, false), None);
        assert_eq!(Tool::from_shortcut("c", true, true), None);
        // the eraser needs shift; bare E is not a tool key
        assert_eq!(Tool::from_shortcut("e", false, false), None);
        // baseline keys stay shift-tolerant (pre-refactor behavior)
        assert_eq!(Tool::from_shortcut("r", true, false), Some(Tool::Rect));
        // unclaimed keys; S is the Slice tool in design mode and a sticky
        // note in boards, so it answers in both
        assert_eq!(Tool::from_shortcut("s", false, false), Some(Tool::Slice));
        let in_board = Tool::from_shortcut("s", false, true);
        assert_eq!(in_board, Some(Tool::BoardSticky));
        assert_eq!(Tool::from_shortcut("q", false, false), None);
    }
}
