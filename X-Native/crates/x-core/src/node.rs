#[allow(unused_imports)]
use crate::*;
use kurbo::{Affine, Circle, Rect, RoundedRect, RoundedRectRadii, Shape};
use peniko::{Brush, Color, Fill, Gradient, Mix};
use std::collections::HashMap;

// Phase 6: Import ImageAdjustments from x-render
// We'll define it here in x-core to avoid circular dependencies
/// Phase 6: Image adjustment parameters
/// All values are in the range [-1.0, 1.0] where:
/// - -1.0 = maximum negative adjustment
/// - 0.0 = no adjustment
/// - 1.0 = maximum positive adjustment
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageAdjustments {
    /// Brightness adjustment (-1.0 to 1.0)
    pub exposure: f32,
    /// Contrast adjustment (-1.0 to 1.0)
    pub contrast: f32,
    /// Color saturation adjustment (-1.0 to 1.0)
    pub saturation: f32,
    /// Color temperature adjustment (-1.0 to 1.0, negative = cool/blue, positive = warm/orange)
    pub temperature: f32,
    /// Color tint adjustment (-1.0 to 1.0, negative = green, positive = magenta)
    pub tint: f32,
    /// Highlight brightness adjustment (-1.0 to 1.0)
    pub highlights: f32,
    /// Shadow brightness adjustment (-1.0 to 1.0)
    pub shadows: f32,
}

impl Default for ImageAdjustments {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            tint: 0.0,
            highlights: 0.0,
            shadows: 0.0,
        }
    }
}

// -------------------------------------------------------------------- nodes

/// Phase 2.6: editable vector path data. A vector node owns a list of
/// subpath commands in local coordinates — the pen tool's data model.
/// Rendered as a real filled (and optionally stroked) Vello path.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathCmd {
    MoveTo(f64, f64),
    LineTo(f64, f64),
    /// Cubic bezier: control1, control2, endpoint.
    CurveTo(f64, f64, f64, f64, f64, f64),
    Close,
}

/// Ramer-Douglas-Peucker polyline simplification (pencil tool): drops
/// points whose perpendicular deviation from the first-last chord is
/// within `eps`. Keeps at least the endpoints.
pub fn simplify_polyline(pts: &[(f64, f64)], eps: f64) -> Vec<(f64, f64)> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    let (x0, y0) = pts[0];
    let (x1, y1) = *pts.last().unwrap();
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len = dx.hypot(dy);
    let mut max_d = 0.0f64;
    let mut idx = 0usize;
    for (i, (x, y)) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
        let d = if len < 1e-12 {
            (x - x0).hypot(y - y0)
        } else {
            (dy * (x - x0) - dx * (y - y0)).abs() / len
        };
        if d > max_d {
            max_d = d;
            idx = i;
        }
    }
    if max_d > eps {
        let mut left = simplify_polyline(&pts[..=idx], eps);
        let right = simplify_polyline(&pts[idx..], eps);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![pts[0], *pts.last().unwrap()]
    }
}

pub fn path_to_bez(cmds: &[PathCmd]) -> kurbo::BezPath {
    let mut p = kurbo::BezPath::new();
    for c in cmds {
        match *c {
            PathCmd::MoveTo(x, y) => p.move_to((x, y)),
            PathCmd::LineTo(x, y) => p.line_to((x, y)),
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => p.curve_to((x1, y1), (x2, y2), (x, y)),
            PathCmd::Close => p.close_path(),
        }
    }
    p
}

/// Designer-facing image placement on top of the fit mode: crop focal
/// point (which part of the image stays visible), extra zoom, and flips.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImagePlacement {
    /// crop focal point in 0..1 image space; (0.5, 0.5) = center
    pub focal: (f64, f64),
    /// extra zoom multiplier on top of the fit scale (1.0 = none)
    pub scale: f64,
    pub flip_h: bool,
    pub flip_v: bool,
}
impl Default for ImagePlacement {
    fn default() -> Self {
        Self {
            focal: (0.5, 0.5),
            scale: 1.0,
            flip_h: false,
            flip_v: false,
        }
    }
}
impl ImagePlacement {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// Image fill behavior inside the node's box (fill modes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImageFit {
    /// stretch to the box (aspect ignored)
    #[default]
    Fill,
    /// contain: fit inside, letterboxed
    Fit,
    /// cover: fill the box, cropped, centered
    Crop,
    /// natural size, positioned at offset
    Tile,
}

/// Phase P0: Text metrics for hit-testing and selection
#[derive(Debug, Clone, Default)]
pub struct TextMetrics {
    pub font_size: f64,
    pub line_height: f64,
    pub letter_spacing: f64,
    pub max_width: f64,
    pub actual_width: f64,
    pub actual_height: f64,
    pub line_count: usize,
    pub caret_positions: Vec<(usize, f64, f64)>, // (char_index, x, y) in local coords
}

// NOTE: the Phase-P0 `VectorNetwork` experiment (VectorPoint/VectorSegment/
// PointType + the NodeKind::VectorNetwork variant) was removed 2026-09-02:
// it was never constructed anywhere (no importer, no editor op, no test)
// and every renderer carried a TODO for it. Vector paths are served by
// NodeKind::Vector. The .x deserializer never had a "vector_network" case
// (unknown tags load as frames), so no file-format compatibility is lost.

#[derive(Debug, Clone, PartialEq)]
pub enum NodeKind {
    Frame {
        layout: Option<AutoLayout>,
    },
    Group,
    Rect {
        radius: f64,
    },
    Ellipse,
    /// Figma-style Section: a labelled container frame. The label is the
    /// node's `name`, drawn as a header by the renderer. Children render
    /// inside; behaves like a Frame for hit-testing/marquee/ungroup.
    Section,
    /// Elliptical arc: start/end angles in degrees (y-down space, 0 = east,
    /// increasing clockwise on screen). start == end means the full ellipse.
    Arc {
        start: f64,
        end: f64,
    },
    Line,
    Text {
        text: String,
    },
    Image {
        asset: String,
        fit: ImageFit,
        placement: ImagePlacement,
    },
    Vector {
        path: Vec<PathCmd>,
    },
    Component {
        name: String,
    },
    Instance {
        component: String,
    },
    /// Figma slice: an export region. Renders nothing itself (no fill, no
    /// stroke, no effects); exporting it captures the flattened canvas
    /// content inside its bounds. Slices are leaf nodes.
    Slice,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrototypeAction {
    pub destination: String,
    pub transition_ms: u32,
}

/// Per-node export preset (Figma's Export panel): a format/scale/quality/
/// suffix tuple. `Node.export_settings` is a list of these.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportSettings {
    pub format: String,
    pub scale: f64,
    pub quality: u8,
    pub suffix: String,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            format: "png".to_string(),
            scale: 1.0,
            quality: 90,
            suffix: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Node {
    /// Stable identity: the key every reference (prototype destinations,
    /// instance overrides, render keys, selection) points at. Never changes
    /// once a node exists — renaming a layer edits `name` instead, so
    /// references survive (Figma parity).
    pub id: String,
    /// User-facing display name. Independent of `id` (Figma separates name
    /// from identity); defaults to `id` for nodes created programmatically.
    pub name: String,
    pub kind: NodeKind,
    pub w: f64,
    pub h: f64,
    pub transform: Transform,
    pub fill: Paint,
    pub stroke: Stroke,
    /// Ordered visual stacks. Empty means a legacy node and falls back to
    /// `fill`, `stroke`, and `effects`; this keeps old `.x` documents valid.
    pub fill_layers: Vec<PaintLayer>,
    pub stroke_layers: Vec<StrokeLayer>,
    pub effect_layers: Vec<EffectLayer>,
    pub visual_stacks_materialized: bool,
    pub opacity: f32,
    pub children: Vec<Node>,
    pub dirty: bool,
    pub visible: bool,
    /// Phase 2: editor lock (excluded from hit testing).
    pub locked: bool,
    pub prototype: Option<PrototypeAction>,
    pub overrides: HashMap<String, String>,
    /// Phase 4.7: per-corner radii [tl, tr, br, bl]; overrides Rect's uniform radius.
    pub corner_radii: Option<[f64; 4]>,
    /// Corner smoothing (0.0–1.0): Figma's "squircle" corner rounding.
    /// 0.0 = standard circular corner (default), 0.6–0.8 = iOS-style
    /// continuous corner (superellipse). Higher values produce smoother
    /// transitions between straight edges and curved corners.
    pub corner_smoothing: f64,
    /// Phase 4: blend mode.
    pub blend: BlendKind,
    /// Phase 4: layer effects (shadows/blurs).
    pub effects: Vec<Effect>,
    /// Phase 2.12: resize constraints relative to the parent frame.
    pub pin: (HPin, VPin),
    /// Phase 2.12/P0: resize + per-child auto-layout constraints
    /// (absolute/fixed/sticky, align_self, grow/shrink/basis).
    pub constraints: ChildConstraints,
    /// Z-index override for paint order within auto-layout frames. When
    /// `Some(i)`, this child paints at the given z-level relative to
    /// siblings (higher values paint on top). When `None`, the child
    /// paints in document order (layer-panel order). This enables
    /// z-index-like behavior within auto-layout without breaking the
    /// flow semantics. Default: `None`.
    pub z_index: Option<i32>,
    /// Masks: when true, this node clips its FOLLOWING SIBLINGS inside
    /// the same parent (mask semantics semantics, simplified).
    pub is_mask: bool,
    /// P1: variable bindings — property -> variable name.
    /// Supported keys: "radius", "opacity", "fontsize", "w", "h".
    /// ("fill" binds via Paint::Variable; gap/padding via AutoLayout vars.)
    pub bindings: HashMap<String, String>,
    /// Phase P0: text metrics for selection and hit-testing
    pub text_metrics: Option<TextMetrics>,
    /// Rich text: styled sub-ranges of a Text node's string (CHAR-index
    /// based: start/len into the text's char vector). Empty = plain text.
    /// Only applies to Text nodes (like corner_radii only applies to
    /// Rects). Editing the text clears these — ranges would be stale.
    pub text_runs: Vec<TextRun>,
    /// Baseline offset (node-local px from the top edge to the first text
    /// baseline). Populated by the text pipeline from real font metrics;
    /// `None` falls back to a geometry heuristic in the auto-layout solver.
    pub baseline: Option<f64>,
    /// Component properties (Figma component properties) — meaningful only on
    /// Component masters; instances expose them as editable controls.
    pub props: Vec<ComponentProp>,
    /// Per-node export settings (Figma's Export panel): a list of
    /// format/scale/suffix presets. Exporting the node writes one file per
    /// entry. Empty means "no explicit exports" (the quick-format buttons
    /// still work). Most useful on slices, but any node may carry them.
    pub export_settings: Vec<ExportSettings>,
    /// Prototyping interactions (trigger → action). Rich Figma-parity model;
    /// the legacy `prototype` field above is kept only for old `.x` docs and
    /// is treated as an `OnClick → Navigate` interaction during playback.
    pub interactions: Vec<Interaction>,
    /// Flow starting point (Figma "starting frame" of a prototype flow).
    pub is_starting_point: bool,
    /// Clip/scroll behavior for a frame's overflowing content.
    pub overflow: Overflow,
    /// Current scroll offset (page px) for a scrollable frame.
    pub scroll: (f64, f64),
    /// Layout grid guides (Figma "layout grid"): visual column/row/grid
    /// overlays on a frame — guides, NOT auto layout. A frame may stack
    /// several (e.g. columns + rows). Meaningful only on Frame nodes.
    pub layout_grids: Vec<LayoutGridDef>,
    
    /// Text formatting properties — the CANONICAL model (Figma "Text and
    /// typography"). The renderer, the `.x` format, the inspector and the
    /// CSS/Code panels read these through the `resolved_*` getters below.
    /// The legacy string bindings ("ps", "bs", "tc", "tw", "lh") stay
    /// readable for older documents but are no longer written.
    pub text_align: TextAlign,
    pub text_align_vertical: TextAlignVertical,
    pub text_decoration: TextDecoration,
    pub text_case: TextCase,
    pub text_truncation: TextTruncation,
    pub max_lines: Option<usize>,
    pub paragraph_spacing: f64,
    pub paragraph_indent: f64,
    pub hanging_punctuation: HangingPunctuation,
    pub list_style: ListStyle,
    pub wrap_style: WrapStyle,
    /// Paragraph break strategy (Auto/Balance/Pretty) — was the "tw"
    /// binding; a field now, so the model has exactly one home for it.
    pub text_wrap: TextWrap,
    /// Explicit line-height multiplier (legacy "lh" binding). 0.0 = unset,
    /// which keeps default-shaped nodes on the pipeline's 1.2.
    pub line_height: f64,
    /// Explicit letter-spacing in px (legacy "ls" binding).
    pub letter_spacing: f64,
    /// Explicit font size in px (legacy "fs" binding). 0.0 = unset — the
    /// renderer falls back to the engine-em convention `h * 0.72`.
    pub font_size: f64,
    /// Figma "Trim lines and paragraphs": the text box hugs the rendered
    /// ink box instead of the full line boxes.
    pub vertical_trim: bool,
    
    /// Phase 6: Image adjustments (exposure, contrast, saturation, etc.)
    /// Only applies to Image nodes and Pattern fills
    pub image_adjustments: Option<ImageAdjustments>,
    
    /// Phase 6: Image rotation in degrees (0, 90, 180, 270)
    /// Independent of node rotation, applies only to the image fill
    pub image_rotation: f64,
}

impl Node {
    /// Clone this node's own state without walking/allocating its descendants.
    /// Parent shells and registry carriers use this on the hot path.
    pub fn shallow_clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind.clone(),
            w: self.w,
            h: self.h,
            transform: self.transform,
            fill: self.fill.clone(),
            stroke: self.stroke.clone(),
            fill_layers: self.fill_layers.clone(),
            stroke_layers: self.stroke_layers.clone(),
            effect_layers: self.effect_layers.clone(),
            visual_stacks_materialized: self.visual_stacks_materialized,
            opacity: self.opacity,
            children: Vec::new(),
            dirty: self.dirty,
            visible: self.visible,
            locked: self.locked,
            prototype: self.prototype.clone(),
            overrides: self.overrides.clone(),
            corner_radii: self.corner_radii,
            corner_smoothing: self.corner_smoothing,
            blend: self.blend,
            effects: self.effects.clone(),
            pin: self.pin,
            constraints: self.constraints.clone(),
            z_index: self.z_index,
            is_mask: self.is_mask,
            bindings: self.bindings.clone(),
            text_metrics: self.text_metrics.clone(),
            text_runs: self.text_runs.clone(),
            baseline: self.baseline,
            props: self.props.clone(),
            export_settings: self.export_settings.clone(),
            interactions: self.interactions.clone(),
            is_starting_point: self.is_starting_point,
            overflow: self.overflow,
            scroll: self.scroll,
            layout_grids: self.layout_grids.clone(),
            text_align: self.text_align,
            text_align_vertical: self.text_align_vertical,
            text_decoration: self.text_decoration,
            text_case: self.text_case,
            text_truncation: self.text_truncation,
            max_lines: self.max_lines,
            paragraph_spacing: self.paragraph_spacing,
            paragraph_indent: self.paragraph_indent,
            hanging_punctuation: self.hanging_punctuation,
            list_style: self.list_style,
            wrap_style: self.wrap_style,
            text_wrap: self.text_wrap,
            line_height: self.line_height,
            letter_spacing: self.letter_spacing,
            font_size: self.font_size,
            vertical_trim: self.vertical_trim,
            image_adjustments: self.image_adjustments,
            image_rotation: self.image_rotation,
        }
    }

    /// This node's paragraph wrap strategy (the "tw" binding; Text nodes).
    /// Line-height MODE bindings (Figma): `lhm`="px" with `lhpx` (absolute
    /// line box in px) or `lhm`="pct" with `lhp` (percent of font size).
    /// Absent -> the legacy `lh` multiplier (default 1.2 = Auto).
    /// Returns (mode, raw value): 0 = multiplier, 1 = px, 2 = percent.
    pub fn lh_mode_value(&self) -> (u8, f64) {
        match self.bindings.get("lhm").map(String::as_str) {
            Some("px") => (
                1,
                self.bindings
                    .get("lhpx")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0),
            ),
            Some("pct") => (
                2,
                self.bindings
                    .get("lhp")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(100.0),
            ),
            _ => (0, 0.0),
        }
    }

    /// True when an explicit line-height binding is present (any mode) —
    /// such nodes must render through the styled pipeline (the plain
    /// block path always uses the face's natural line box).
    pub fn has_explicit_lh(&self) -> bool {
        self.bindings.contains_key("lhm")
            || self.bindings.contains_key("lh")
            || self.line_height > 0.0
    }

    /// Paragraph break strategy. Canonical: the typed `text_wrap` field;
    /// legacy: the "tw" binding written by older documents and importers.
    pub fn text_wrap(&self) -> TextWrap {
        if self.text_wrap != TextWrap::Auto {
            return self.text_wrap;
        }
        // "twm" is the canonical binding spelling for the break strategy;
        // "tw" predates it (older .x documents)
        for k in ["twm", "tw"] {
            if let Some(v) = self.bindings.get(k) {
                let p = TextWrap::parse(v);
                if p != TextWrap::Auto {
                    return p;
                }
            }
        }
        TextWrap::Auto
    }

    /// Figma's paragraph-resize strategy as a CSS `text-wrap` value:
    /// "balance"/"pretty" when set, else None (no property emitted).
    pub fn text_wrap_mode(&self) -> Option<&'static str> {
        match self.text_wrap() {
            TextWrap::Auto => None,
            TextWrap::Balance => Some("balance"),
            TextWrap::Pretty => Some("pretty"),
        }
    }

    // ------------------------------------------------- resolved text model
    // One home per property: typed fields are canonical, bindings are the
    // legacy read path only. Renderer, `.x`, inspector and Code panels all
    // go through these getters — that is what keeps canvas, export and
    // generated CSS honest with each other.

    /// Horizontal alignment inside the box.
    pub fn resolved_text_align(&self) -> TextAlign {
        self.text_align
    }

    /// Vertical alignment inside the box (only meaningful for fixed-size
    /// text — Figma ignores it while auto-resizing, and so do we).
    pub fn resolved_text_align_vertical(&self) -> TextAlignVertical {
        self.text_align_vertical
    }

    /// Underline / strikethrough as authored on the node.
    pub fn resolved_text_decoration(&self) -> TextDecoration {
        self.text_decoration
    }

    /// Small caps rides the legacy "tc"="sc" spelling (it is a shaping
    /// mode, not a case transform); the typed case transform is separate.
    pub fn resolved_small_caps(&self) -> bool {
        if self.bindings.get("tc").map(String::as_str) == Some("sc") {
            return true;
        }
        // legacy spelling: a standalone "sc" binding (pre-`tc` documents)
        self.bindings
            .get("sc")
            .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
            .unwrap_or(false)
    }

    /// The non-destructive case transform applied to the CONTENT. Legacy
    /// documents carry it as the "tc" binding ("upper"/"lower"/"title").
    pub fn resolved_text_case(&self) -> TextCase {
        if self.text_case != TextCase::Original {
            return self.text_case;
        }
        match self.bindings.get("tc").map(String::as_str) {
            Some("upper") => TextCase::Upper,
            Some("lower") => TextCase::Lower,
            Some("title") => TextCase::Title,
            _ => TextCase::Original,
        }
    }

    /// Case mode as `apply_text_case` expects it ("upper"/"lower"/"title").
    pub fn text_case_mode(&self) -> Option<&'static str> {
        match self.text_case {
            TextCase::Original => None,
            TextCase::Upper => Some("upper"),
            TextCase::Lower => Some("lower"),
            TextCase::Title => Some("title"),
        }
    }

    /// End/middle truncation with an optional line cap.
    pub fn resolved_truncation(&self) -> (TextTruncation, Option<usize>) {
        (self.text_truncation, self.max_lines)
    }

    /// Space added after each paragraph (`\n`-terminated line).
    pub fn resolved_paragraph_spacing(&self) -> f64 {
        if self.paragraph_spacing != 0.0 {
            return self.paragraph_spacing;
        }
        self.bindings
            .get("ps")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0)
    }

    /// First-line indent in px for every paragraph.
    pub fn resolved_paragraph_indent(&self) -> f64 {
        if self.paragraph_indent > 0.0 {
            return self.paragraph_indent;
        }
        self.bindings
            .get("pi")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| *v > 0.0)
            .unwrap_or(0.0)
    }

    pub fn resolved_list_style(&self) -> ListStyle {
        self.list_style
    }

    pub fn resolved_hanging_punctuation(&self) -> HangingPunctuation {
        self.hanging_punctuation
    }

    /// CSS `overflow-wrap`-style breaking of overlong words mid-glyph.
    pub fn resolved_word_break(&self) -> bool {
        self.wrap_style == WrapStyle::BreakWord
    }

    /// Line-height multiplier (legacy "lh" binding, then the typed field).
    pub fn resolved_line_height(&self) -> f64 {
        if self.line_height > 0.0 {
            return self.line_height;
        }
        self.bindings
            .get("lh")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| *v > 0.0)
            .unwrap_or(1.2)
    }

    /// Letter-spacing in px (legacy "ls" binding, then the typed field).
    pub fn resolved_letter_spacing(&self) -> f64 {
        if self.letter_spacing != 0.0 {
            return self.letter_spacing;
        }
        self.bindings
            .get("ls")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0)
    }

    /// Font size in px: legacy "fs" binding, then the typed field; `None`
    /// means "engine em" (`h * 0.72`).
    pub fn resolved_font_size(&self) -> Option<f64> {
        if self.font_size > 0.0 {
            return Some(self.font_size);
        }
        self.bindings
            .get("fs")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| *v > 0.0)
    }

    /// True when the text must render through the styled pipeline (the
    /// plain block path only knows size/color/wrap-at-width).
    pub fn text_needs_styled(&self) -> bool {
        self.resolved_small_caps()
            || self.resolved_text_case() != TextCase::Original
            || self.resolved_paragraph_spacing() != 0.0
            || self.resolved_paragraph_indent() != 0.0
            || self.text_decoration != TextDecoration::None
            || self.text_align != TextAlign::Left
            || self.text_align_vertical != TextAlignVertical::Top
            || self.text_truncation != TextTruncation::Disabled
            || self.list_style != ListStyle::None
            || self.paragraph_indent != 0.0
            || self.text_align_vertical != TextAlignVertical::Top
            || self.vertical_trim
            || self.wrap_style != WrapStyle::Normal
            || self.text_wrap != TextWrap::Auto
            || self
                .bindings
                .get("opsz")
                .and_then(|v| v.parse::<f32>().ok())
                .unwrap_or(0.0)
                > 0.0
            || self
                .bindings
                .get("wdth")
                .and_then(|v| v.parse::<f32>().ok())
                .unwrap_or(0.0)
                > 0.0
            || self.has_explicit_lh()
    }
}

/// Paragraph wrap strategy (Figma Aug-2026 text wrap). `Auto` is the
/// classic greedy first-fit; `Balance` evens line lengths per paragraph
/// (CSS `text-wrap: balance`); `Pretty` balances AND avoids a lone word
/// stranded on the last line (widows). Rides the node as the "tw"
/// binding, same as "ls"/"lh".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextWrap {
    #[default]
    Auto,
    Balance,
    Pretty,
}

impl TextWrap {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Balance => "balance",
            Self::Pretty => "pretty",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "balance" => Self::Balance,
            "pretty" => Self::Pretty,
            _ => Self::Auto,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Auto => "AUTO",
            Self::Balance => "BALANCE",
            Self::Pretty => "PRETTY",
        }
    }
}

/// Layout-grid guide pattern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]

/// Text horizontal alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
    Justified,
}

impl TextAlign {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Center => "center",
            Self::Right => "right",
            Self::Justified => "justified",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "center" => Self::Center,
            "right" => Self::Right,
            "justified" => Self::Justified,
            _ => Self::Left,
        }
    }
}

/// Text vertical alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextAlignVertical {
    #[default]
    Top,
    Middle,
    Bottom,
}

impl TextAlignVertical {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Middle => "middle",
            Self::Bottom => "bottom",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "middle" => Self::Middle,
            "bottom" => Self::Bottom,
            _ => Self::Top,
        }
    }
}

/// Text decoration (underline/strikethrough).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextDecoration {
    #[default]
    None,
    Underline,
    Strikethrough,
}

impl TextDecoration {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Underline => "underline",
            Self::Strikethrough => "strikethrough",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "underline" => Self::Underline,
            "strikethrough" => Self::Strikethrough,
            _ => Self::None,
        }
    }
}

/// Text case transformation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextCase {
    #[default]
    Original,
    Upper,
    Lower,
    Title,
}

impl TextCase {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Upper => "upper",
            Self::Lower => "lower",
            Self::Title => "title",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "upper" => Self::Upper,
            "lower" => Self::Lower,
            "title" => Self::Title,
            _ => Self::Original,
        }
    }
}

/// Text truncation mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextTruncation {
    #[default]
    Disabled,
    End,
    Middle,
}

impl TextTruncation {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::End => "end",
            Self::Middle => "middle",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "end" => Self::End,
            "middle" => Self::Middle,
            _ => Self::Disabled,
        }
    }
}

/// List style (bulleted/numbered).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ListStyle {
    #[default]
    None,
    Bulleted,
    Numbered,
}

impl ListStyle {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Bulleted => "bulleted",
            Self::Numbered => "numbered",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "bulleted" => Self::Bulleted,
            "numbered" => Self::Numbered,
            _ => Self::None,
        }
    }
}

/// Text wrap style for line breaking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WrapStyle {
    #[default]
    Normal,
    BreakWord,
}

impl WrapStyle {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::BreakWord => "break-word",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "break-word" => Self::BreakWord,
            _ => Self::Normal,
        }
    }
}

/// Hanging punctuation settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HangingPunctuation {
    pub quotes: bool,
    pub lists: bool,
}

impl HangingPunctuation {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"quotes\":{},\"lists\":{}}}",
            self.quotes, self.lists
        )
    }
    pub fn parse(s: &str) -> Self {
        // Simple JSON parser for {"quotes":bool,"lists":bool}
        let quotes = s.contains("\"quotes\":true");
        let lists = s.contains("\"lists\":true");
        Self { quotes, lists }
    }
}
pub enum GridPattern {
    #[default]
    Columns,
    Rows,
    /// Square grid of `LayoutGridDef::cell` px.
    Grid,
}

impl GridPattern {
    pub fn to_str(self) -> &'static str {
        match self {
            Self::Columns => "columns",
            Self::Rows => "rows",
            Self::Grid => "grid",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "rows" => Self::Rows,
            "grid" => Self::Grid,
            _ => Self::Columns,
        }
    }
}

/// One layout grid. Columns/Rows use `count`/`gutter`/`margin`; the Grid
/// pattern uses `cell` (square cell size) and ignores gutter.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutGridDef {
    pub pattern: GridPattern,
    /// Column/row count (Columns/Rows).
    pub count: usize,
    /// Gap between columns/rows.
    pub gutter: f64,
    /// Outer margin: sides for Columns, top/bottom for Rows.
    pub margin: f64,
    /// Square cell size (Grid pattern only).
    pub cell: f64,
}

impl Default for LayoutGridDef {
    fn default() -> Self {
        Self {
            pattern: GridPattern::Columns,
            count: 12,
            gutter: 20.0,
            margin: 20.0,
            cell: 8.0,
        }
    }
}

impl LayoutGridDef {
    /// Guide bands for Columns/Rows, frame-local px: (x, y, w, h)
    /// rectangles to paint translucently. Empty for the Grid pattern.
    pub fn bands(&self, w: f64, h: f64) -> Vec<(f64, f64, f64, f64)> {
        match self.pattern {
            GridPattern::Grid => vec![],
            GridPattern::Columns => {
                let m = self.margin.clamp(0.0, w / 2.0);
                let inner = (w - 2.0 * m).max(0.0);
                let n = self.count.max(1);
                let g = self.gutter.clamp(0.0, inner / n as f64);
                let band = ((inner - g * (n - 1) as f64) / n as f64).max(0.0);
                (0..n)
                    .map(|i| (m + i as f64 * (band + g), 0.0, band, h))
                    .collect()
            }
            GridPattern::Rows => {
                let m = self.margin.clamp(0.0, h / 2.0);
                let inner = (h - 2.0 * m).max(0.0);
                let n = self.count.max(1);
                let g = self.gutter.clamp(0.0, inner / n as f64);
                let band = ((inner - g * (n - 1) as f64) / n as f64).max(0.0);
                (0..n)
                    .map(|i| (0.0, m + i as f64 * (band + g), w, band))
                    .collect()
            }
        }
    }

    /// Line positions for the square Grid pattern: (xs, ys), frame-local.
    pub fn grid_lines(&self, w: f64, h: f64) -> (Vec<f64>, Vec<f64>) {
        let step = self.cell.max(1.0);
        let upto = |len: f64| -> Vec<f64> {
            let mut v = vec![];
            let mut x = 0.0;
            while x <= len + 1e-9 {
                v.push(x);
                x += step;
            }
            v
        };
        (upto(w), upto(h))
    }
}

/// A styled sub-range of a Text node's string. `start`/`len` are CHAR
/// indices; out-of-range parts are ignored by the resolver (hostile or
/// hand-edited files can never panic the renderer).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextRun {
    pub start: usize,
    pub len: usize,
    pub color: Option<Color>,
    pub size: Option<f64>,
    pub font: Option<String>,
    /// Font weight (400 normal, 700 bold…) — emitted by exports; shaping
    /// resolves through the font name when the family carries it.
    pub weight: Option<u16>,
    pub italic: Option<bool>,
    /// Per-run letter-spacing override (px); None = node-level `ls` binding.
    pub ls: Option<f64>,
}

/// One resolved styled chunk of a Text node (renderer/sink facing).
#[derive(Debug, Clone, PartialEq)]
pub struct TextPart {
    pub text: String,
    pub color: Option<Color>,
    pub size: Option<f64>,
    pub font: Option<String>,
    pub weight: Option<u16>,
    pub italic: Option<bool>,
    pub ls: Option<f64>,
}

/// Split a Text node's string into styled parts. Unstyled ranges produce
/// parts with all-None styling; runs are clipped to the text; overlapping
/// runs are applied in order (last wins per range). Empty/absent runs
/// degrade to a single plain part.
pub fn plain_part(text: &str) -> TextPart {
    TextPart {
        text: text.to_string(),
        color: None,
        size: None,
        font: None,
        weight: None,
        italic: None,
        ls: None,
    }
}

/// Text-case transform (the `tc` binding): "upper" | "lower" | "title".
/// Anything else (including None) is identity. NOTE: case can change the
/// char count (ß -> SS), so callers apply it only to plain text (no rich
/// runs) or before building runs.
pub fn apply_text_case(text: &str, mode: Option<&str>) -> String {
    match mode {
        Some("upper") | Some("UPPER") => text.to_uppercase(),
        Some("lower") | Some("LOWER") => text.to_lowercase(),
        Some("title") | Some("TITLE") => {
            let mut out = String::with_capacity(text.len());
            let mut at_word_start = true;
            for c in text.chars() {
                if c.is_whitespace() {
                    at_word_start = true;
                    out.push(c);
                } else if at_word_start {
                    out.extend(c.to_uppercase());
                    at_word_start = false;
                } else {
                    out.extend(c.to_lowercase());
                }
            }
            out
        }
        _ => text.to_string(),
    }
}

pub fn resolve_text_parts(text: &str, runs: &[TextRun]) -> Vec<TextPart> {
    let total = text.chars().count();
    if runs.is_empty() || total == 0 {
        return vec![plain_part(text)];
    }
    // char-index -> style lookup, last run wins
    let mut at: Vec<Option<usize>> = vec![None; total];
    for (i, r) in runs.iter().enumerate() {
        let end = r.start.saturating_add(r.len).min(total);
        for a in &mut at[r.start.min(total)..end] {
            *a = Some(i);
        }
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<TextPart> = vec![];
    let mut i = 0;
    while i < total {
        let style = at[i];
        let mut j = i + 1;
        while j < total && at[j] == style {
            j += 1;
        }
        let (color, size, font, weight, italic, ls) = match style.and_then(|k| runs.get(k)) {
            Some(r) => (r.color, r.size, r.font.clone(), r.weight, r.italic, r.ls),
            None => (None, None, None, None, None, None),
        };
        out.push(TextPart {
            text: chars[i..j].iter().collect(),
            color,
            size,
            font,
            weight,
            italic,
            ls,
        });
        i = j;
    }
    if out.is_empty() {
        out.push(plain_part(text));
    }
    out
}

impl Node {
    /// Dev-Mode annotation (Figma: notes on a layer for developers). Rides
    /// the bindings map under the reserved `note` key so it round-trips
    /// `.x` without a schema bump.
    pub fn note(&self) -> Option<&str> {
        self.bindings
            .get("note")
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
    }

    /// Set or clear the Dev-Mode annotation.
    pub fn set_note(&mut self, note: Option<&str>) {
        match note {
            Some(s) => {
                self.bindings.insert("note".into(), s.into());
            }
            None => {
                self.bindings.remove("note");
            }
        }
    }

    fn base(id: &str, kind: NodeKind, x: f64, y: f64, w: f64, h: f64, fill: Paint) -> Self {
        Self {
            id: id.into(),
            name: id.into(),
            kind,
            w,
            h,
            transform: Transform {
                x,
                y,
                ..Default::default()
            },
            fill,
            stroke: Stroke::default(),
            fill_layers: vec![],
            stroke_layers: vec![],
            effect_layers: vec![],
            visual_stacks_materialized: false,
            opacity: 1.0,
            children: vec![],
            dirty: true,
            visible: true,
            locked: false,
            prototype: None,
            overrides: HashMap::new(),
            corner_radii: None,
            corner_smoothing: 0.0,
            blend: BlendKind::Normal,
            effects: vec![],
            is_mask: false,
            pin: (HPin::Left, VPin::Top),
            constraints: ChildConstraints::default(),
            z_index: None,
            bindings: HashMap::new(),
            text_metrics: None,
            text_runs: vec![],
            baseline: None,
            props: vec![],
            export_settings: vec![],
            interactions: vec![],
            is_starting_point: false,
            overflow: Overflow::default(),
            scroll: (0.0, 0.0),
            layout_grids: vec![],
            text_align: TextAlign::Left,
            text_align_vertical: TextAlignVertical::Top,
            text_decoration: TextDecoration::None,
            text_case: TextCase::Original,
            text_truncation: TextTruncation::Disabled,
            max_lines: None,
            paragraph_spacing: 0.0,
            paragraph_indent: 0.0,
            hanging_punctuation: HangingPunctuation::default(),
            list_style: ListStyle::None,
            wrap_style: WrapStyle::Normal,
            text_wrap: TextWrap::Auto,
            line_height: 0.0,
            letter_spacing: 0.0,
            font_size: 0.0,
            vertical_trim: false,
            image_adjustments: None,
            image_rotation: 0.0,
        }
    }
    pub fn frame(id: &str, w: f64, h: f64) -> Self {
        Self::base(
            id,
            NodeKind::Frame { layout: None },
            0.0,
            0.0,
            w,
            h,
            Paint::Solid(Color::TRANSPARENT),
        )
    }
    pub fn group(id: &str, w: f64, h: f64) -> Self {
        Self::base(
            id,
            NodeKind::Group,
            0.0,
            0.0,
            w,
            h,
            Paint::Solid(Color::TRANSPARENT),
        )
    }
    pub fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, fill: Color) -> Self {
        Self::base(
            id,
            NodeKind::Rect { radius: 0.0 },
            x,
            y,
            w,
            h,
            Paint::Solid(fill),
        )
    }
    pub fn ellipse(id: &str, x: f64, y: f64, w: f64, h: f64, fill: Color) -> Self {
        Self::base(id, NodeKind::Ellipse, x, y, w, h, Paint::Solid(fill))
    }
    /// Section container: subtle tint + the node name as its header label.
    pub fn section(id: &str, w: f64, h: f64) -> Self {
        let mut n = Self::base(
            id,
            NodeKind::Section,
            0.0,
            0.0,
            w,
            h,
            Paint::Solid(Color::from_rgba8(0x62, 0x74, 0x8b, 0x0d)),
        );
        n.name = "Section".into();
        n.corner_radii = Some([8.0; 4]);
        n.stroke.paint = Paint::Solid(Color::from_rgba8(0x62, 0x74, 0x8b, 0x5a));
        n.stroke.width = 1.0;
        n
    }
    /// Shape constructors mirror their Figma counterparts; the angle pair
    /// is intrinsic to an arc, so the arity is what it is.
    #[allow(clippy::too_many_arguments)]
    pub fn arc(
        id: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        start: f64,
        end: f64,
        fill: Color,
    ) -> Self {
        Self::base(
            id,
            NodeKind::Arc { start, end },
            x,
            y,
            w,
            h,
            Paint::Solid(fill),
        )
    }
    pub fn line(id: &str, x: f64, y: f64, w: f64, h: f64, color: Color) -> Self {
        // Figma-like: 1px stroke, no fill — thin, clean line
        Self::base(
            id,
            NodeKind::Line,
            x,
            y,
            w,
            h,
            Paint::Solid(Color::TRANSPARENT),
        )
        .stroke(Stroke::solid(color, 1.0))
    }
    pub fn text(id: &str, x: f64, y: f64, w: f64, h: f64, text: &str) -> Self {
        // Figma-like: dark fill for text on white frames; no stroke outline
        let mut n = Self::base(
            id,
            NodeKind::Text { text: text.into() },
            x,
            y,
            w,
            h,
            Paint::Solid(Color::from_rgb8(0x0d, 0x12, 0x20)),
        );
        n.stroke.width = 0.0;
        n
    }
    pub fn image(id: &str, x: f64, y: f64, w: f64, h: f64, asset: &str) -> Self {
        Self::base(
            id,
            NodeKind::Image {
                asset: asset.into(),
                fit: ImageFit::default(),
                placement: ImagePlacement::default(),
            },
            x,
            y,
            w,
            h,
            Paint::Solid(Color::from_rgb8(0xdd, 0xdd, 0xdd)),
        )
    }
    pub fn vector(id: &str, x: f64, y: f64, w: f64, h: f64, path: Vec<PathCmd>) -> Self {
        Self::base(
            id,
            NodeKind::Vector { path },
            x,
            y,
            w,
            h,
            Paint::Solid(Color::BLACK),
        )
    }
    pub fn component(id: &str, name: &str, w: f64, h: f64) -> Self {
        Self::base(
            id,
            NodeKind::Component { name: name.into() },
            0.0,
            0.0,
            w,
            h,
            Paint::Solid(Color::TRANSPARENT),
        )
    }
    pub fn instance(id: &str, component: &str, x: f64, y: f64, w: f64, h: f64) -> Self {
        Self::base(
            id,
            NodeKind::Instance {
                component: component.into(),
            },
            x,
            y,
            w,
            h,
            Paint::Solid(Color::TRANSPARENT),
        )
    }
    pub fn slice(id: &str, x: f64, y: f64, w: f64, h: f64) -> Self {
        Self::base(
            id,
            NodeKind::Slice,
            x,
            y,
            w,
            h,
            Paint::Solid(Color::TRANSPARENT),
        )
    }

    pub fn radius(mut self, r: f64) -> Self {
        if let NodeKind::Rect { .. } = self.kind {
            self.kind = NodeKind::Rect { radius: r }
        }
        self
    }
    pub fn corners(mut self, tl: f64, tr: f64, br: f64, bl: f64) -> Self {
        self.corner_radii = Some([tl, tr, br, bl]);
        self
    }
    /// Set corner smoothing (0.0–1.0). Higher values produce iOS-style
    /// continuous corners (superellipse). 0.0 = standard circular corners.
    pub fn smooth_corners(mut self, v: f64) -> Self {
        self.corner_smoothing = v.clamp(0.0, 1.0);
        self
    }
    pub fn rotate(mut self, r: f64) -> Self {
        self.transform.rotation = r;
        self
    }
    pub fn scale(mut self, x: f64, y: f64) -> Self {
        self.transform.scale_x = x;
        self.transform.scale_y = y;
        self
    }
    pub fn opacity(mut self, v: f32) -> Self {
        self.opacity = v.clamp(0.0, 1.0);
        self
    }
    pub fn stroke(mut self, s: Stroke) -> Self {
        self.stroke = s;
        self
    }
    pub fn fill_paint(mut self, p: Paint) -> Self {
        self.fill = p;
        self
    }
    pub fn blend(mut self, b: BlendKind) -> Self {
        self.blend = b;
        self
    }
    pub fn effect(mut self, e: Effect) -> Self {
        self.effects.push(e);
        self
    }
    /// Attach a rich-text style span (byte range) to a Text node.
    pub fn materialize_visual_stacks(&mut self) {
        if self.visual_stacks_materialized {
            return;
        }
        if self.fill_layers.is_empty() {
            self.fill_layers.push(PaintLayer::new(self.fill.clone()));
        }
        if self.stroke_layers.is_empty() && self.stroke.width > 0.0 {
            self.stroke_layers
                .push(StrokeLayer::new(self.stroke.clone()));
        }
        if self.effect_layers.is_empty() {
            self.effect_layers = self.effects.iter().cloned().map(EffectLayer::new).collect();
        }
        self.visual_stacks_materialized = true;
    }

    pub fn active_fills(&self) -> Vec<PaintLayer> {
        if !self.visual_stacks_materialized {
            vec![PaintLayer::new(self.fill.clone())]
        } else {
            self.fill_layers
                .iter()
                .filter(|l| l.visible && l.opacity > 0.0)
                .cloned()
                .collect()
        }
    }
    pub fn active_strokes(&self) -> Vec<StrokeLayer> {
        if !self.visual_stacks_materialized {
            if self.stroke.width > 0.0 {
                vec![StrokeLayer::new(self.stroke.clone())]
            } else {
                vec![]
            }
        } else {
            self.stroke_layers
                .iter()
                .filter(|l| l.visible && l.opacity > 0.0 && l.stroke.width > 0.0)
                .cloned()
                .collect()
        }
    }
    /// CSS Flexbox parity (Figma Jul-2026): the effective inside-stroke
    /// width for layout purposes. Returns the maximum width among visible
    /// inside-aligned stroke layers (inside strokes reduce the content
    /// area like CSS `border` in border-box model). Outside and center
    /// strokes are never included — they behave like CSS `outline`.
    pub fn inside_stroke_width(&self) -> f64 {
        self.active_strokes()
            .iter()
            .filter(|l| l.options.align == StrokeAlign::Inside)
            .map(|l| l.stroke.width)
            .fold(0.0f64, f64::max)
    }
    pub fn active_effects(&self) -> Vec<EffectLayer> {
        if !self.visual_stacks_materialized {
            self.effects.iter().cloned().map(EffectLayer::new).collect()
        } else {
            self.effect_layers
                .iter()
                .filter(|l| l.visible && l.opacity > 0.0)
                .cloned()
                .collect()
        }
    }
    pub fn pin(mut self, h: HPin, v: VPin) -> Self {
        self.pin = (h, v);
        self
    }
    pub fn locked(mut self, v: bool) -> Self {
        self.locked = v;
        self
    }
    pub fn mask(mut self, v: bool) -> Self {
        self.is_mask = v;
        self
    }
    pub fn child(mut self, n: Node) -> Self {
        self.children.push(n);
        self.dirty = true;
        self
    }
    /// Set the user-facing display name (does not touch `id`).
    pub fn name(mut self, name: &str) -> Self {
        self.name = name.into();
        self
    }
    pub fn prototype(mut self, destination: &str, transition_ms: u32) -> Self {
        self.prototype = Some(PrototypeAction {
            destination: destination.into(),
            transition_ms,
        });
        self
    }
    pub fn interaction(mut self, i: Interaction) -> Self {
        self.interactions.push(i);
        self
    }
    pub fn starting_point(mut self, v: bool) -> Self {
        self.is_starting_point = v;
        self
    }
    pub fn override_prop(mut self, key: &str, value: &str) -> Self {
        self.overrides.insert(key.into(), value.into());
        self
    }
    pub fn auto_layout(mut self, layout: AutoLayout) -> Self {
        if let NodeKind::Frame { .. } = self.kind {
            self.kind = NodeKind::Frame {
                layout: Some(layout),
            }
        }
        self
    }
    /// Set z-index for paint order within auto-layout frames. Higher
    /// values paint on top of siblings. `None` = document order.
    pub fn z_index(mut self, z: i32) -> Self {
        self.z_index = Some(z);
        self
    }
    /// Absolute-position this child inside its auto-layout parent (Figma ABSOLUTE).
    pub fn absolute(mut self) -> Self {
        self.constraints.is_absolute = true;
        self
    }
    /// Fixed positioning: ignores the parent's scroll offset (Figma FIXED).
    pub fn fixed(mut self) -> Self {
        self.constraints.fixed = true;
        self
    }
    /// Sticky positioning (top edge) inside a scrollable parent.
    pub fn sticky(mut self) -> Self {
        self.constraints.sticky = true;
        self
    }
    /// Clip/scroll overflow behavior for a frame.
    pub fn overflow(mut self, o: Overflow) -> Self {
        self.overflow = o;
        self
    }
    /// Set a frame's scroll offset (page px).
    pub fn scroll(mut self, x: f64, y: f64) -> Self {
        self.scroll = (x, y);
        self
    }
    /// Per-child cross-axis alignment override.
    pub fn align_self(mut self, a: Alignment) -> Self {
        self.constraints.align_self = Some(a);
        self
    }
    /// Flex-grow factor.
    pub fn grow(mut self, g: f64) -> Self {
        self.constraints.grow = g;
        self
    }
    /// Flex-shrink factor.
    pub fn shrink(mut self, s: f64) -> Self {
        self.constraints.shrink = s;
        self
    }
    /// Flex-basis (base main-axis size before grow/shrink).
    pub fn basis(mut self, b: f64) -> Self {
        self.constraints.basis = Some(b);
        self
    }
    /// Explicit baseline offset (top edge -> first text baseline, node-local px).
    pub fn baseline_offset(mut self, b: f64) -> Self {
        self.baseline = Some(b);
        self
    }
    /// Bind a property ("radius"/"opacity"/"fontsize"/"w"/"h") to a number variable.
    pub fn bind(mut self, prop: &str, var: &str) -> Self {
        self.bindings.insert(prop.into(), var.into());
        self
    }

    /// Resolve a bound numeric property against `vars`, else `fallback`.
    pub fn bound_number(&self, prop: &str, vars: &Variables, fallback: f64) -> f64 {
        match self.bindings.get(prop) {
            Some(name) => vars.number(name, fallback),
            None => fallback,
        }
    }
}

#[cfg(test)]
mod text_run_tests {
    use super::*;

    fn part(text: &str, color: Option<Color>, size: Option<f64>) -> TextPart {
        TextPart {
            text: text.into(),
            color,
            size,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }
    }

    #[test]
    fn no_runs_degrades_to_a_single_plain_part() {
        let parts = resolve_text_parts("Hello", &[]);
        assert_eq!(parts, vec![part("Hello", None, None)]);
    }

    #[test]
    fn empty_text_degrades_to_a_single_plain_part() {
        let parts = resolve_text_parts(
            "",
            &[TextRun {
                start: 0,
                len: 5,
                color: Some(Color::from_rgb8(255, 0, 0)),
                size: None,
                font: None,
                weight: None,
                italic: None,
                ls: None,
            }],
        );
        assert_eq!(parts, vec![part("", None, None)]);
    }

    #[test]
    fn styled_range_splits_into_three_parts() {
        // "hello": chars 1..3 styled red
        let runs = [TextRun {
            start: 1,
            len: 2,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: Some(30.0),
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let parts = resolve_text_parts("hello", &runs);
        assert_eq!(
            parts,
            vec![
                part("h", None, None),
                part("el", Some(Color::from_rgb8(255, 0, 0)), Some(30.0)),
                part("lo", None, None),
            ]
        );
    }

    #[test]
    fn out_of_range_runs_are_clamped_not_panicking() {
        // hostile/hand-edited files: run far past the end
        let runs = [TextRun {
            start: 10,
            len: 50,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let parts = resolve_text_parts("abc", &runs);
        // range fully outside -> plain
        assert_eq!(parts, vec![part("abc", None, None)]);
        // partially outside clips to the text end
        let runs = [TextRun {
            start: 2,
            len: 50,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let parts = resolve_text_parts("abc", &runs);
        assert_eq!(
            parts,
            vec![
                part("ab", None, None),
                part("c", Some(Color::from_rgb8(255, 0, 0)), None)
            ]
        );
    }

    #[test]
    fn overlapping_runs_last_wins() {
        let runs = [
            TextRun {
                start: 0,
                len: 4,
                color: Some(Color::from_rgb8(255, 0, 0)),
                size: None,
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
            TextRun {
                start: 2,
                len: 2,
                color: Some(Color::from_rgb8(0, 0, 255)),
                size: None,
                font: None,
                weight: None,
                italic: None,
                ls: None,
            },
        ];
        let parts = resolve_text_parts("abcd", &runs);
        assert_eq!(
            parts,
            vec![
                part("ab", Some(Color::from_rgb8(255, 0, 0)), None),
                part("cd", Some(Color::from_rgb8(0, 0, 255)), None),
            ]
        );
    }

    #[test]
    fn whole_text_run_covers_every_char() {
        let runs = [TextRun {
            start: 0,
            len: 5,
            color: Some(Color::from_rgb8(255, 0, 0)),
            size: None,
            font: None,
            weight: None,
            italic: None,
            ls: None,
        }];
        let parts = resolve_text_parts("hello", &runs);
        assert_eq!(
            parts,
            vec![part("hello", Some(Color::from_rgb8(255, 0, 0)), None)]
        );
    }
}

#[cfg(test)]
mod lh_mode_tests {
    use super::*;

    #[test]
    fn lh_modes_parse_from_bindings() {
        let mut n = Node::text("t", 0.0, 0.0, 100.0, 14.0, "x");
        // default: legacy multiplier mode
        assert_eq!(n.lh_mode_value(), (0, 0.0));
        assert!(!n.has_explicit_lh());
        // fixed px
        n.bindings.insert("lhm".into(), "px".into());
        n.bindings.insert("lhpx".into(), "40".into());
        assert_eq!(n.lh_mode_value(), (1, 40.0));
        assert!(n.has_explicit_lh());
        // percent of font size
        if let Some(v) = n.bindings.get_mut("lhm") {
            *v = "pct".into();
        }
        n.bindings.insert("lhp".into(), "150".into());
        n.bindings.remove("lhpx");
        assert_eq!(n.lh_mode_value(), (2, 150.0));
        // legacy multiplier still counts as explicit
        n.bindings.remove("lhm");
        n.bindings.insert("lh".into(), "1.5".into());
        assert!(n.has_explicit_lh());
        assert_eq!(n.lh_mode_value(), (0, 0.0));
    }
}

#[cfg(test)]
mod simplify_tests {
    use super::*;

    #[test]
    fn collinear_points_collapse_to_two() {
        let pts = vec![(0.0, 0.0), (1.0, 0.5), (2.0, 1.0), (3.0, 1.5), (4.0, 2.0)];
        assert_eq!(simplify_polyline(&pts, 0.1), vec![(0.0, 0.0), (4.0, 2.0)]);
    }

    #[test]
    fn spikes_survive() {
        // a spike in the middle must survive simplification
        let pts = vec![(0.0, 0.0), (5.0, 5.0), (10.0, 0.0)];
        assert_eq!(simplify_polyline(&pts, 0.1), pts);
        // ...but a shallow wiggle within eps is dropped
        let pts = vec![(0.0, 0.0), (5.0, 0.4), (10.0, 0.0)];
        assert_eq!(simplify_polyline(&pts, 1.0), vec![(0.0, 0.0), (10.0, 0.0)]);
    }

    #[test]
    fn tiny_inputs_and_zero_eps() {
        assert_eq!(simplify_polyline(&[], 1.0), vec![]);
        assert_eq!(simplify_polyline(&[(1.0, 1.0)], 1.0), vec![(1.0, 1.0)]);
        let pts = vec![(0.0, 0.0), (1.0, 0.1), (2.0, 0.0)];
        assert_eq!(simplify_polyline(&pts, 0.0), pts, "eps 0 keeps everything");
    }
}

#[cfg(test)]
mod layout_grid_tests {
    use super::*;

    #[test]
    fn columns_bands_math() {
        let g = LayoutGridDef {
            pattern: GridPattern::Columns,
            count: 4,
            gutter: 10.0,
            margin: 10.0,
            cell: 8.0,
        };
        // frame 210 wide: inner 190, bands (190 - 3*10)/4 = 40
        let b = g.bands(210.0, 100.0);
        assert_eq!(b.len(), 4);
        assert_eq!(b[0], (10.0, 0.0, 40.0, 100.0));
        assert_eq!(b[1], (60.0, 0.0, 40.0, 100.0));
        assert_eq!(b[3], (160.0, 0.0, 40.0, 100.0));
        // last band ends exactly at the right margin
        assert!((b[3].0 + b[3].2 - 200.0).abs() < 1e-9);
    }

    #[test]
    fn rows_bands_and_clamping() {
        let g = LayoutGridDef {
            pattern: GridPattern::Rows,
            count: 3,
            gutter: 8.0,
            margin: 6.0,
            cell: 8.0,
        };
        let b = g.bands(50.0, 70.0);
        assert_eq!(b.len(), 3);
        // inner 58, band (58-16)/3 = 14
        assert_eq!(b[0], (0.0, 6.0, 50.0, 14.0));
        // degenerate: huge gutter clamps so bands never go negative
        let wild = LayoutGridDef {
            pattern: GridPattern::Rows,
            count: 2,
            gutter: 500.0,
            margin: 0.0,
            cell: 8.0,
        };
        let b = wild.bands(100.0, 100.0);
        assert_eq!(b.len(), 2);
        assert!(b[0].2 >= 0.0 && b[0].3 >= 0.0);
    }

    #[test]
    fn grid_pattern_lines() {
        let g = LayoutGridDef {
            pattern: GridPattern::Grid,
            count: 12,
            gutter: 20.0,
            margin: 20.0,
            cell: 8.0,
        };
        assert!(
            g.bands(100.0, 100.0).is_empty(),
            "grid draws lines, not bands"
        );
        let (xs, ys) = g.grid_lines(20.0, 12.0);
        assert_eq!(xs, vec![0.0, 8.0, 16.0]);
        assert_eq!(ys, vec![0.0, 8.0]);
        // zero cell falls back to 1px steps (never a loop)
        let z = LayoutGridDef {
            pattern: GridPattern::Grid,
            cell: 0.0,
            ..Default::default()
        };
        let (xs, _) = z.grid_lines(3.0, 3.0);
        assert_eq!(xs.len(), 4);
    }

    #[test]
    fn pattern_strings_roundtrip() {
        for p in [GridPattern::Columns, GridPattern::Rows, GridPattern::Grid] {
            assert_eq!(GridPattern::parse(p.to_str()), p);
        }
        assert_eq!(GridPattern::parse("nonsense"), GridPattern::Columns);
    }

    #[test]
    fn text_case_modes() {
        assert_eq!(apply_text_case("abc DEF", Some("upper")), "ABC DEF");
        assert_eq!(apply_text_case("abc DEF", Some("lower")), "abc def");
        assert_eq!(
            apply_text_case("hello wide WORLD", Some("title")),
            "Hello Wide World"
        );
        assert_eq!(apply_text_case("same", None), "same");
        assert_eq!(apply_text_case("same", Some("nonesuch")), "same");
    }

    #[test]
    fn typed_text_fields_are_canonical() {
        let mut n = Node::text("t", 0.0, 0.0, 120.0, 40.0, "Hi");
        n.text_align = TextAlign::Center;
        n.text_align_vertical = TextAlignVertical::Middle;
        n.text_decoration = TextDecoration::Underline;
        n.text_case = TextCase::Upper;
        n.bindings.insert("sc".into(), "1".into()); // small caps mode
        n.list_style = ListStyle::Numbered;
        n.text_truncation = TextTruncation::Middle;
        n.max_lines = Some(3);
        n.paragraph_indent = 12.0;
        n.paragraph_spacing = 8.0;
        n.wrap_style = WrapStyle::BreakWord;
        n.vertical_trim = true;
        n.hanging_punctuation = HangingPunctuation {
            quotes: true,
            lists: true,
        };
        n.text_wrap = TextWrap::Balance;
        n.font_size = 24.0;
        n.letter_spacing = 1.5;
        n.line_height = 1.5;
        assert_eq!(n.resolved_text_align(), TextAlign::Center);
        assert_eq!(n.resolved_text_align_vertical(), TextAlignVertical::Middle);
        assert_eq!(n.resolved_text_decoration(), TextDecoration::Underline);
        assert_eq!(n.resolved_text_case(), TextCase::Upper);
        assert!(n.resolved_small_caps());
        assert_eq!(n.resolved_list_style(), ListStyle::Numbered);
        assert_eq!(
            n.resolved_truncation(),
            (TextTruncation::Middle, Some(3usize))
        );
        assert_eq!(n.resolved_paragraph_indent(), 12.0);
        assert_eq!(n.resolved_paragraph_spacing(), 8.0);
        assert!(n.resolved_word_break());
        assert!(n.vertical_trim);
        let hang = n.resolved_hanging_punctuation();
        assert!(hang.quotes && hang.lists);
        assert_eq!(n.text_wrap(), TextWrap::Balance);
        assert_eq!(n.text_wrap_mode(), Some("balance"));
        assert_eq!(n.resolved_font_size(), Some(24.0));
        assert_eq!(n.resolved_letter_spacing(), 1.5);
        assert_eq!(n.resolved_line_height(), 1.5);
        assert!(n.text_needs_styled());
    }

    #[test]
    fn legacy_text_bindings_still_resolve() {
        // documents saved before the typed fields existed keep their
        // typography in the bindings map — the getters must still honor it
        let mut n = Node::text("t", 0.0, 0.0, 120.0, 40.0, "Hi");
        n.bindings
            .insert("twm".into(), "pretty".into()); // wrap mode
        n.bindings.insert("pi".into(), "10".into()); // paragraph indent
        n.bindings.insert("ps".into(), "6".into()); // paragraph spacing
        n.bindings.insert("tc".into(), "upper".into()); // case
        n.bindings.insert("sc".into(), "1".into()); // small caps
        n.bindings.insert("fs".into(), "30".into()); // font size
        n.bindings.insert("ls".into(), "2".into()); // letter spacing
        n.bindings.insert("lh".into(), "1.75".into()); // line height
        assert_eq!(n.text_wrap_mode(), Some("pretty"));
        assert_eq!(n.resolved_paragraph_indent(), 10.0);
        assert_eq!(n.resolved_paragraph_spacing(), 6.0);
        assert_eq!(n.resolved_text_case(), TextCase::Upper);
        assert!(n.resolved_small_caps());
        assert_eq!(n.resolved_font_size(), Some(30.0));
        assert_eq!(n.resolved_letter_spacing(), 2.0);
        assert_eq!(n.resolved_line_height(), 1.75);
        assert!(n.text_needs_styled());
    }

    #[test]
    fn text_enum_strings_roundtrip() {
        for a in [
            TextAlign::Left,
            TextAlign::Center,
            TextAlign::Right,
            TextAlign::Justified,
        ] {
            assert_eq!(TextAlign::parse(a.to_str()), a);
        }
        for v in [
            TextAlignVertical::Top,
            TextAlignVertical::Middle,
            TextAlignVertical::Bottom,
        ] {
            assert_eq!(TextAlignVertical::parse(v.to_str()), v);
        }
        for d in [
            TextDecoration::None,
            TextDecoration::Underline,
            TextDecoration::Strikethrough,
        ] {
            assert_eq!(TextDecoration::parse(d.to_str()), d);
        }
        for c in [
            TextCase::Original,
            TextCase::Upper,
            TextCase::Lower,
            TextCase::Title,
        ] {
            assert_eq!(TextCase::parse(c.to_str()), c);
        }
        for t in [
            TextTruncation::Disabled,
            TextTruncation::End,
            TextTruncation::Middle,
        ] {
            assert_eq!(TextTruncation::parse(t.to_str()), t);
        }
        for l in [
            ListStyle::None,
            ListStyle::Bulleted,
            ListStyle::Numbered,
        ] {
            assert_eq!(ListStyle::parse(l.to_str()), l);
        }
        for w in [WrapStyle::Normal, WrapStyle::BreakWord] {
            assert_eq!(WrapStyle::parse(w.to_str()), w);
        }
        assert_eq!(TextAlign::parse("nonsense"), TextAlign::Left);
    }

    #[test]
    fn text_clone_keeps_typed_fields() {
        let mut n = Node::text("t", 0.0, 0.0, 120.0, 40.0, "Hi");
        n.text_align = TextAlign::Justified;
        n.vertical_trim = true;
        n.text_wrap = TextWrap::Pretty;
        let c = n.clone();
        assert_eq!(c.text_align, TextAlign::Justified);
        assert!(c.vertical_trim);
        assert_eq!(c.text_wrap, TextWrap::Pretty);
        let s = n.shallow_clone();
        assert_eq!(s.text_align, TextAlign::Justified);
        assert!(s.vertical_trim);
    }
}
