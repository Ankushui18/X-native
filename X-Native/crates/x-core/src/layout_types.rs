#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// ------------------------------------------------------------------- layout

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutDirection {
    Horizontal,
    #[default]
    Vertical,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sizing {
    #[default]
    Fixed,
    Hug,
}
/// Phase 5.1: cross-axis alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CrossAlign {
    #[default]
    Start,
    Center,
    End,
    Baseline,
}
/// Phase P0: AutoLayout wrap mode for text wrapping
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AutoLayoutWrap {
    #[default]
    NoWrap,
    Wrap,
}
/// Phase P0: Alignment with baseline support
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Alignment {
    #[default]
    Min,
    Center,
    Max,
    Baseline,
}
/// Phase P0: Child constraints within auto-layout
#[derive(Debug, Clone, PartialEq)]
pub struct ChildConstraints {
    pub align_self: Option<Alignment>,
    pub grow: f64,
    pub shrink: f64,
    pub basis: Option<f64>,
    /// Absolute positioning: removed from normal flow (Figma ABSOLUTE).
    pub is_absolute: bool,
    /// Fixed positioning: ignores the parent's scroll offset (Figma FIXED).
    pub fixed: bool,
    /// Sticky positioning: sticks to the scroll viewport edge when scrolled
    /// past its natural position (Figma STICKY, top edge).
    pub sticky: bool,
    /// Grid placement: explicit column index (0-based) within the parent
    /// grid's columns; `None` = auto-flow.
    pub grid_col: Option<usize>,
    /// Grid placement: explicit row index; `None` = auto-flow.
    pub grid_row: Option<usize>,
    /// Grid span across columns (>= 1).
    pub grid_col_span: usize,
    /// Grid span across rows (>= 1).
    pub grid_row_span: usize,
}
impl Default for ChildConstraints {
    fn default() -> Self {
        Self {
            align_self: None,
            grow: 0.0,
            shrink: 1.0,
            basis: None,
            is_absolute: false,
            fixed: false,
            sticky: false,
            grid_col: None,
            grid_row: None,
            grid_col_span: 1,
            grid_row_span: 1,
        }
    }
}
impl ChildConstraints {
    /// Whether this child is removed from normal flow (absolute/fixed/sticky).
    pub fn is_out_of_flow(&self) -> bool {
        self.is_absolute || self.fixed || self.sticky
    }
}

/// How a frame clips its overflowing content and whether it scrolls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Overflow {
    /// Content can extend past the frame's bounds (Figma default).
    #[default]
    Visible,
    /// Content is clipped to the frame's bounds, no scrolling.
    Clip,
    /// Clipped, scrolls horizontally.
    ScrollX,
    /// Clipped, scrolls vertically.
    ScrollY,
    /// Clipped, scrolls both axes.
    ScrollBoth,
}

impl Overflow {
    pub fn scrollable(self) -> bool {
        matches!(
            self,
            Overflow::ScrollX | Overflow::ScrollY | Overflow::ScrollBoth
        )
    }
    pub fn clips(self) -> bool {
        self != Overflow::Visible
    }
    pub fn label(self) -> &'static str {
        match self {
            Overflow::Visible => "Visible",
            Overflow::Clip => "Clip",
            Overflow::ScrollX => "Scroll X",
            Overflow::ScrollY => "Scroll Y",
            Overflow::ScrollBoth => "Scroll both",
        }
    }
    pub fn to_str(self) -> &'static str {
        match self {
            Overflow::Visible => "visible",
            Overflow::Clip => "clip",
            Overflow::ScrollX => "scrollx",
            Overflow::ScrollY => "scrolly",
            Overflow::ScrollBoth => "scrollboth",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "clip" => Overflow::Clip,
            "scrollx" => Overflow::ScrollX,
            "scrolly" => Overflow::ScrollY,
            "scrollboth" => Overflow::ScrollBoth,
            _ => Overflow::Visible,
        }
    }
}

/// Per-side frame padding: `[left, right, top, bottom]`.
pub type Padding = [f64; 4];

/// Canvas stacking order for negative-gap (overlapping) auto-layout stacks.
/// Figma Jun-2026: controls which end of the stack paints on top when gap
/// is negative (items overlap).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CanvasStacking {
    /// The last (right-most / bottom-most) item paints on top. This is
    /// the classic canvas painter's-algorithm order and the default.
    #[default]
    LastOnTop,
    /// The first (left-most / top-most) item paints on top — useful for
    /// card-fan layouts where the "first" card should be visually in front.
    FirstOnTop,
}

impl CanvasStacking {
    pub fn label(self) -> &'static str {
        match self {
            CanvasStacking::LastOnTop => "Last on top",
            CanvasStacking::FirstOnTop => "First on top",
        }
    }
    pub fn to_str(self) -> &'static str {
        match self {
            CanvasStacking::LastOnTop => "last-on-top",
            CanvasStacking::FirstOnTop => "first-on-top",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "first-on-top" => CanvasStacking::FirstOnTop,
            _ => CanvasStacking::LastOnTop,
        }
    }
}

/// CSS-Grid-style track sizing (Figma Grid, Config 2025).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GridTrack {
    /// Fixed pixel size.
    Fixed(f64),
    /// Fraction of the leftover space (CSS `fr`).
    Fr(f64),
    /// Content-sized: the max natural size of the items in the track.
    Auto,
}

/// Grid layout for frames (CSS grid; Figma Grid). Children place into
/// cells — explicitly via [`ChildConstraints`] or auto-flowed row-major —
/// and stretch to their spanned cell area. Column tracks size
/// Fixed/Fr/Auto against the frame's content box; row tracks likewise
/// (implicit rows are `Auto`).
#[derive(Debug, Clone, PartialEq)]
pub struct GridLayout {
    pub columns: Vec<GridTrack>,
    /// Row tracks; children overflowing these get implicit `Auto` rows.
    pub rows: Vec<GridTrack>,
    pub column_gap: f64,
    pub row_gap: f64,
    /// `[left, right, top, bottom]` (same convention as AutoLayout).
    pub padding: [f64; 4],
}

impl Default for GridLayout {
    fn default() -> Self {
        Self {
            columns: vec![GridTrack::Auto, GridTrack::Auto, GridTrack::Auto],
            rows: vec![],
            column_gap: 8.0,
            row_gap: 8.0,
            padding: [0.0; 4],
        }
    }
}

impl GridLayout {
    /// CSS `grid-template-columns` value ("120px 1fr 2fr auto").
    pub fn template_columns_css(&self) -> String {
        tracks_css(&self.columns)
    }
    /// CSS `grid-template-rows` value; empty = "" (all implicit auto rows).
    pub fn template_rows_css(&self) -> String {
        if self.rows.is_empty() {
            String::new()
        } else {
            tracks_css(&self.rows)
        }
    }
}

fn tracks_css(tracks: &[GridTrack]) -> String {
    tracks
        .iter()
        .map(|t| match t {
            GridTrack::Fixed(v) => format!("{v:.0}px"),
            GridTrack::Fr(v) => format!("{v:.0}fr"),
            GridTrack::Auto => "auto".to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Main-axis distribution of free space (CSS justify-content).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Distribute {
    /// Authored `gap`, items packed from the start (default).
    #[default]
    Packed,
    /// Equal gaps between items, none at the edges.
    Between,
    /// Equal unit per item: half at each edge, full between items.
    Around,
    /// Every gap identical, including both edges.
    Evenly,
}

impl Distribute {
    pub fn to_str(self) -> &'static str {
        match self {
            Distribute::Packed => "packed",
            Distribute::Between => "between",
            Distribute::Around => "around",
            Distribute::Evenly => "evenly",
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "between" => Distribute::Between,
            "around" => Distribute::Around,
            "evenly" => Distribute::Evenly,
            _ => Distribute::Packed,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Distribute::Packed => "PACKED",
            Distribute::Between => "BETWEEN",
            Distribute::Around => "AROUND",
            Distribute::Evenly => "EVENLY",
        }
    }
    pub fn css(self) -> &'static str {
        match self {
            Distribute::Packed => "flex-start",
            Distribute::Between => "space-between",
            Distribute::Around => "space-around",
            Distribute::Evenly => "space-evenly",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AutoLayout {
    pub direction: LayoutDirection,
    pub gap: f64,
    pub padding: Padding,
    /// Main-axis sizing (`Hug` sizes the frame to its content).
    pub sizing: Sizing,
    /// Independent cross-axis sizing; `None` follows `sizing` (legacy
    /// behavior: one flag for both axes).
    pub cross_sizing: Option<Sizing>,
    pub gap_var: Option<String>,
    pub padding_var: Option<String>,
    /// Phase 5.1: cross-axis alignment of children.
    pub align: CrossAlign,
    /// Main-axis distribution of leftover space in Fixed frames — CSS
    /// `justify-content` semantics, matching Figma's Aug-2026 auto-spacing
    /// modes (Between / Around / Evenly). `Packed` keeps the authored gap.
    pub distribute: Distribute,
    /// Phase P0: wrap mode
    pub wrap: AutoLayoutWrap,
    /// Phase P0: min/max constraints
    pub min_width: Option<f64>,
    pub max_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_height: Option<f64>,
    /// Phase P0: resize on wrap
    pub resize_on_wrap: bool,
    /// CSS-Grid mode: when set, the frame lays out as a grid instead of a
    /// stack (see [`GridLayout`]); the stack fields above are ignored.
    pub grid: Option<GridLayout>,
    /// CSS Flexbox parity (Figma Jul-2026): when true, inside strokes on
    /// THIS frame are included in layout calculations (minimum size and
    /// padding offset). Outside and center strokes are never included,
    /// regardless of this setting. Default: true, matching Figma's new
    /// default for new frames.
    pub stroke_include_in_layout: bool,
    /// Canvas stacking order for negative-gap (overlapping) stacks. Figma
    /// Jun-2026: controls paint order when items overlap due to negative
    /// gap. Default: LastOnTop (classic painter's-algorithm order).
    pub canvas_stacking: CanvasStacking,
}

impl Default for AutoLayout {
    fn default() -> Self {
        Self {
            direction: LayoutDirection::default(),
            gap: 0.0,
            padding: [0.0; 4],
            sizing: Sizing::default(),
            cross_sizing: None,
            gap_var: None,
            padding_var: None,
            align: CrossAlign::default(),
            distribute: Distribute::default(),
            wrap: AutoLayoutWrap::default(),
            min_width: None,
            max_width: None,
            min_height: None,
            max_height: None,
            resize_on_wrap: false,
            grid: None,
            // CSS Flexbox parity (Figma Jul-2026): inside strokes are
            // included in layout by default for new frames.
            stroke_include_in_layout: true,
            canvas_stacking: CanvasStacking::default(),
        }
    }
}

impl AutoLayout {
    /// True when all four sides carry the same value (serializes as the
    /// legacy scalar `"padding":N`, keeping old files byte-stable).
    pub fn uniform_pad(&self) -> bool {
        let [l, r, t, b] = self.padding;
        l == r && r == t && t == b
    }
    /// Cross-axis sizing with the `None`-follows-`sizing` fallback applied.
    pub fn cross(&self) -> Sizing {
        self.cross_sizing.unwrap_or(self.sizing)
    }
}
