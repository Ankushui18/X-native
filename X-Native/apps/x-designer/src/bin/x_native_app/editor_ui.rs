//! Editor screen — the audited v45 geometry is a benchmark, not the product
//! identity. X-Native keeps the measured density where it improves usability,
//! then uses its own Graphite & Signal language and Compose → Flow → Ship
//! workflow instead of reproducing Figma's Design/Prototype/Inspect shell.
//!
//! 36px title (28px logo cell + flush file tabs + [+]), 280px left panel
//! (DRAFTS / file name / LAYERS-ASSETS-TOKENS pills / PAGES / tree),
//! #060606 canvas with floating 40px tool dock, 340px right panel
//! (DESIGN/PROTOTYPE/INSPECT with Size+Position, Auto layout, Appearance,
//! Typography, Fill, Stroke, Effects, GUIDES, Export).

use std::collections::HashSet;

use vello::kurbo::{Point, Rect};
use vello::peniko::Color;
use vello::Scene;
use x_native::{ui::Elevation, FrameCache, ImageFit, Node, NodeKind, Paint, VelloSink};

use crate::context_menu::{action_for, ContextMenuItem, SEPARATOR_HEIGHT};
use crate::icons::{draw_flow_glyph, draw_icon};
use crate::paint::*;
use crate::state::{
    kind_icon, parse_hex, Action, App, Drag, FieldId, LeftTab, NavTab, RightTab, Tool, TreeDrop,
    VariableKind, FRAME_PRESETS,
};
use crate::theme::*;

// ------------------------------------------------------------------ paint

pub fn paint(app: &mut App, s: &mut Scene) {
    app.tooltip.clear();
    app.paint_lib_at = None;
    let mut hit: Vec<(Rect, Action)> = Vec::new();
    fill_rect(s, Rect::new(0.0, 0.0, app.win_w, app.win_h), C_BG);
    if app.flow.is_some() {
        // chrome-less flow viewer: backdrop only. The document scene and
        // open overlays composite on top; the preview chip paints in
        // `paint_over`. No editor hit regions survive here.
        app.hit = hit;
        return;
    }
    let reg = app.editor_regions();

    paint_canvas_bg(app, s);
    paint_title(app, s, &mut hit);
    paint_nav_bar(app, s, &mut hit);
    paint_left(app, s, &mut hit);
    paint_resizers(app, s);
    paint_right(app, s, &mut hit);
    // top-bar bottom border: CSS border-b occupies the bar's LAST pixel
    // row (y 35) and must not be overpainted by the panel fills below.
    hline(s, 0.0, app.win_w, ED_TITLE_H - 1.0, C_LINE);

    if app.dropdown_frame {
        paint_frame_dropdown(app, s, &mut hit);
    }
    if app.dropdown_lh {
        paint_lh_dropdown(app, s, &mut hit);
    }
    if app.dropdown_text_style {
        paint_text_style_dropdown(app, s, &mut hit);
    }
    if app.dropdown_zoom {
        paint_zoom_dropdown(app, s, &mut hit);
    }
    if app.paint_lib.is_some() {
        paint_paint_library(app, s, &mut hit);
    }
    if app.palette.open {
        paint_palette(app, s, &mut hit);
    }
    if app.lib_review.is_some() {
        paint_lib_review(app, s, &mut hit);
    }
    paint_color_picker(app, s, &mut hit);
    paint_carets(app, s);
    app.hit = hit;
    let _ = reg;
}

/// Called after the document scene is composited: selection handles,
/// marquee, pen preview, floating tool dock.
pub fn paint_over(app: &mut App, s: &mut Scene) {
    let mut hit = std::mem::take(&mut app.hit);
    if app.flow.is_some() {
        // flow preview: prototype overlays + preview chip instead of
        // editor overlays (no toolbar, rulers, or handles)
        paint_flow_overlay(app, s, &mut hit);
        app.hit = hit;
        return;
    }
    paint_canvas_overlays(app, s);
    paint_minimap(app, s, &mut hit);
    paint_layout_guides(app, s);
    paint_ruler_guides(app, s);
    paint_vector_points(app, s);
    paint_smart_guides(app, s);
    paint_text_editor(app, s);
    paint_proto_connections(app, s);
    paint_rulers(app, s);
    paint_toolbar(app, s, &mut hit);
    paint_context_menu(app, s, &mut hit);
    paint_page_menu(app, s, &mut hit);
    paint_app_menu(app, s, &mut hit);
    paint_find_replace(app, s, &mut hit);
    paint_notifications(app, s, &mut hit);
    paint_tooltip(app, s);
    app.hit = hit;
}

/// P10: the hover label for the control under the cursor. The
/// smallest registered rect containing the mouse wins (most specific
/// control); the pill floats below-right of the cursor, clamped to the
/// window, inverted against the chrome.
fn paint_tooltip(app: &App, s: &mut Scene) {
    let mouse = app.mouse;
    let mut best: Option<(f64, &String)> = None;
    for (r, label) in &app.tooltip {
        if !r.contains(mouse) {
            continue;
        }
        let area = r.width() * r.height();
        if best.is_none_or(|(a, _)| area < a) {
            best = Some((area, label));
        }
    }
    let Some((_, label)) = best else {
        return;
    };
    let tw = app.fonts.measure(label, T10, Wt::Reg) + 16.0;
    let th = 20.0;
    let mut x = mouse.x + 14.0;
    let mut y = mouse.y + 18.0;
    if x + tw > app.win_w - 8.0 {
        x = (mouse.x - tw - 10.0).max(8.0);
    }
    if y + th > app.status_band().y0 - 8.0 {
        y = (mouse.y - th - 12.0).max(8.0);
    }
    let tr = Rect::new(x, y, x + tw, y + th);
    elev_shadow(s, tr, 8.0, Elevation::Floating);
    fill_rrect(s, tr, R_MD, C_TEXT);
    app.fonts
        .text(s, x + 8.0, y + 5.0, label, T10, C_BASE, Wt::Reg);
}

/// Persistent ruler guides (Figma): 1px pink lines across the canvas plus
/// the live line being dragged from a ruler.
fn paint_ruler_guides(app: &App, s: &mut Scene) {
    if !app.rulers {
        return;
    }
    let reg = app.editor_regions();
    let doc = app.doc_ref();
    if !doc.guides_visible {
        return;
    }
    let guides = doc
        .guides
        .iter()
        .copied()
        .chain(doc.guide_drag)
        .collect::<Vec<(char, f64)>>();
    let mut readout: Option<(Rect, String)> = None;
    for (ax, c) in guides {
        if ax == 'v' {
            let x = app.world_to_screen(Point::new(c, 0.0)).x;
            if x >= reg.canvas.x0 && x <= reg.canvas.x1 {
                vline(s, x, reg.canvas.y0, reg.canvas.y1, crate::theme::C_SNAP);
                if doc.guide_drag.is_some() {
                    readout = guide_readout(app, 'v', c);
                }
            }
        } else {
            let y = app.world_to_screen(Point::new(0.0, c)).y;
            if y >= reg.canvas.y0 && y <= reg.canvas.y1 {
                hline(s, reg.canvas.x0, reg.canvas.x1, y, crate::theme::C_SNAP);
                if doc.guide_drag.is_some() {
                    readout = guide_readout(app, 'h', c);
                }
            }
        }
    }
    // the numeric readout: a guide you cannot measure is a guess (Figma puts
    // the value in the ruler; ours floats next to the line it belongs to)
    if let Some((r, label)) = readout {
        fill_rrect(s, r, R_SM, C_FIELD);
        stroke_rrect(s, r, R_SM, C_LINE_2, 1.0);
        app.fonts
            .text(s, r.x0 + 6.0, r.y0 + 3.5, &label, T10, C_TEXT, Wt::Mono);
    }
}

/// The live readout chip for a guide at world coordinate `c` on `axis`:
/// where it sits and what it says. `None` when the guide is off the canvas —
/// the caller then paints nothing. Pure, so the test can ask the same
/// question the painter asks.
pub fn guide_readout(app: &App, axis: char, c: f64) -> Option<(Rect, String)> {
    let reg = app.editor_regions();
    let label = fmt_num(c.round());
    let w = app.fonts.measure(&label, T10, Wt::Mono) + 12.0;
    let r = if axis == 'v' {
        let x = app.world_to_screen(Point::new(c, 0.0)).x;
        if x < reg.canvas.x0 || x > reg.canvas.x1 {
            return None;
        }
        Rect::new(
            x + 6.0,
            reg.canvas.y0 + RULER_SIZE + 6.0,
            x + 6.0 + w,
            reg.canvas.y0 + RULER_SIZE + 24.0,
        )
    } else {
        let y = app.world_to_screen(Point::new(0.0, c)).y;
        if y < reg.canvas.y0 || y > reg.canvas.y1 {
            return None;
        }
        Rect::new(
            reg.canvas.x0 + RULER_SIZE + 6.0,
            y + 6.0,
            reg.canvas.x0 + RULER_SIZE + 6.0 + w,
            y + 24.0,
        )
    };
    // keep the chip inside the canvas: a readout clipped by the panel edge
    // would defeat the point of reading it
    let r = Rect::new(
        r.x0.min(reg.canvas.x1 - r.width() - 4.0)
            .max(reg.canvas.x0 + 2.0),
        r.y0.min(reg.canvas.y1 - 20.0).max(reg.canvas.y0 + 2.0),
        r.x1.min(reg.canvas.x1 - 4.0),
        r.y1.min(reg.canvas.y1 - 4.0),
    );
    Some((r, label))
}

// ------------------------------------------------------------- minimap

const MINIMAP_W: f64 = 176.0;
const MINIMAP_H: f64 = 116.0;
const MINIMAP_INSET: f64 = 12.0;
/// How much of a top-level node is drawn before it is just noise.
const MINIMAP_MAX_NODES: usize = 400;

/// The world box a page's content occupies: the union of its visible
/// top-level nodes. `None` when the page is empty — a minimap of nothing is
/// not a navigation aid, it is a rectangle.
pub fn page_content_bounds(app: &App) -> Option<Rect> {
    let d = app.doc_opt()?;
    let page = d.editors.get(d.page)?;
    let mut b: Option<Rect> = None;
    for n in page.root.children.iter().filter(|n| n.visible) {
        let r = Rect::new(
            n.transform.x,
            n.transform.y,
            n.transform.x + n.w,
            n.transform.y + n.h,
        );
        b = Some(b.map_or(r, |p| p.union(r)));
    }
    b
}

/// The minimap's geometry for this frame: where the panel is, what slice of
/// the world it shows, and how the two map onto each other. Pure, so the
/// painter, the pointer test and the press handler all read one thing.
pub struct MinimapGeom {
    pub panel: Rect,
    pub world: Rect,
}

impl MinimapGeom {
    /// Panel px per world px (the panel letterboxes the content box).
    pub fn scale(&self) -> f64 {
        let s = (self.panel.width() / self.world.width().max(1e-6))
            .min(self.panel.height() / self.world.height().max(1e-6));
        s.clamp(1e-6, 64.0)
    }

    /// The content box as painted inside the panel (centred, letterboxed).
    fn content(&self) -> Rect {
        let s = self.scale();
        let (w, h) = (self.world.width() * s, self.world.height() * s);
        let x0 = self.panel.x0 + (self.panel.width() - w) / 2.0;
        let y0 = self.panel.y0 + (self.panel.height() - h) / 2.0;
        Rect::new(x0, y0, x0 + w, y0 + h)
    }

    pub fn to_panel(&self, wx: f64, wy: f64) -> Point {
        let s = self.scale();
        let c = self.content();
        Point::new(
            c.x0 + (wx - self.world.x0) * s,
            c.y0 + (wy - self.world.y0) * s,
        )
    }

    pub fn to_world(&self, p: Point) -> Point {
        let s = self.scale();
        let c = self.content();
        Point::new(
            self.world.x0 + (p.x - c.x0) / s,
            self.world.y0 + (p.y - c.y0) / s,
        )
    }

    /// The panel's close button — shared by the painter and the press handler,
    /// so the ✕ that is drawn is the ✕ that works.
    pub fn close(&self) -> Rect {
        Rect::new(
            self.panel.x1 - 20.0,
            self.panel.y0 + 4.0,
            self.panel.x1 - 4.0,
            self.panel.y0 + 20.0,
        )
    }
}

/// The minimap for this frame, or `None` when it is off, the page is empty,
/// or the screen has its own navigation (boards are infinite by design; the
/// flow viewer is chrome-less).
pub fn minimap_geom(app: &App) -> Option<MinimapGeom> {
    if !app.minimap || app.screen != crate::state::Screen::Editor || app.flow.is_some() {
        return None;
    }
    let content = page_content_bounds(app)?;
    let world = content.inflate(
        (content.width() * 0.06).max(8.0),
        (content.height() * 0.06).max(8.0),
    );
    let reg = app.editor_regions();
    let w = MINIMAP_W.min(reg.canvas.width() - 40.0).max(96.0);
    let h = MINIMAP_H.min(reg.canvas.height() - 40.0).max(72.0);
    let panel = Rect::new(
        reg.canvas.x1 - MINIMAP_INSET - w,
        reg.canvas.y1 - MINIMAP_INSET - h,
        reg.canvas.x1 - MINIMAP_INSET,
        reg.canvas.y1 - MINIMAP_INSET,
    );
    Some(MinimapGeom { panel, world })
}

/// Does this page have anything to sketch? (The thumbnail and the icon are
/// mutually exclusive, so the row cannot claim content it does not have.)
pub(crate) fn page_has_content(app: &App, page_i: usize) -> bool {
    app.doc_opt()
        .and_then(|d| d.editors.get(page_i))
        .is_some_and(|p| p.root.children.iter().any(|n| n.visible))
}

/// One page's content drawn into `box`: the same mapping the minimap uses,
/// at thumbnail scale. Used by the PAGES rows so a page can be recognised
/// before it is opened.
fn paint_page_sketch(app: &App, s: &mut Scene, page_i: usize, box_: Rect) {
    let Some(d) = app.doc_opt() else {
        return;
    };
    let Some(page) = d.editors.get(page_i) else {
        return;
    };
    let mut b: Option<Rect> = None;
    for n in page.root.children.iter().filter(|n| n.visible) {
        let r = Rect::new(
            n.transform.x,
            n.transform.y,
            n.transform.x + n.w,
            n.transform.y + n.h,
        );
        b = Some(b.map_or(r, |p| p.union(r)));
    }
    fill_rrect(s, box_, R_XS, C_BG);
    stroke_rrect(s, box_, R_XS, C_LINE_2, 1.0);
    let Some(b) = b else {
        return;
    };
    let s_ = (box_.width() / b.width().max(1.0)).min(box_.height() / b.height().max(1.0));
    let ox = box_.x0 + (box_.width() - b.width() * s_) / 2.0;
    let oy = box_.y0 + (box_.height() - b.height() * s_) / 2.0;
    let clip = box_.inflate(-1.0, -1.0);
    for n in page.root.children.iter().filter(|n| n.visible).take(24) {
        let r = Rect::new(
            ox + (n.transform.x - b.x0) * s_,
            oy + (n.transform.y - b.y0) * s_,
            ox + (n.transform.x + n.w - b.x0) * s_,
            oy + (n.transform.y + n.h - b.y0) * s_,
        );
        let r = Rect::new(
            r.x0.max(clip.x0),
            r.y0.max(clip.y0),
            r.x1.min(clip.x1),
            r.y1.min(clip.y1),
        );
        if r.width() <= 0.0 || r.height() <= 0.0 {
            continue;
        }
        // the node's own colour, faint enough to be a sketch
        let c = x_native::paint_color(&n.fill, &d.doc.variables);
        fill_rrect(s, r, R_XS, c.multiply_alpha(0.75));
    }
}

/// The minimap: the whole page at a glance, with the viewport on it.
fn paint_minimap(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let Some(g) = minimap_geom(app) else {
        return;
    };
    let panel = g.panel;
    elev_shadow(s, panel, 8.0, Elevation::Floating);
    fill_rrect(s, panel, R_MD, C_PANEL);
    let hov_panel = hover(app, panel);
    stroke_rrect(
        s,
        panel,
        R_MD,
        if hov_panel { C_LINE_2 } else { C_LINE },
        1.0,
    );

    // the page itself: every visible top-level node, in its own colour
    let vars = app.doc_ref().doc.variables.clone();
    let selected: HashSet<String> = app
        .doc_ref()
        .editor_ref()
        .selection
        .iter()
        .cloned()
        .collect();
    let nodes: Vec<(Rect, Color, bool)> = {
        let d = app.doc_ref();
        match d.editors.get(d.page) {
            Some(page) => page
                .root
                .children
                .iter()
                .filter(|n| n.visible)
                .take(MINIMAP_MAX_NODES)
                .map(|n| {
                    let tl = g.to_panel(n.transform.x, n.transform.y);
                    let br = g.to_panel(n.transform.x + n.w, n.transform.y + n.h);
                    // at least a device pixel per node: a page of hairlines
                    // must still be a visible page in the map
                    let r = Rect::new(
                        tl.x.floor(),
                        tl.y.floor(),
                        br.x.ceil().max(tl.x.floor() + 1.0),
                        br.y.ceil().max(tl.y.floor() + 1.0),
                    );
                    let c = x_native::paint_color(&n.fill, &vars);
                    (r, c.multiply_alpha(0.6), selected.contains(&n.id))
                })
                .collect(),
            None => Vec::new(),
        }
    };
    for (r, c, is_sel) in nodes {
        fill_rrect(s, r, R_XS, if is_sel { C_SEL } else { c });
    }

    // the viewport: what the canvas is actually showing, clamped to the panel
    let reg = app.editor_regions();
    let tl = app.screen_to_world(Point::new(reg.canvas.x0, reg.canvas.y0));
    let br = app.screen_to_world(Point::new(reg.canvas.x1, reg.canvas.y1));
    let (p0, p1) = (g.to_panel(tl.x, tl.y), g.to_panel(br.x, br.y));
    let view = Rect::new(p0.x, p0.y, p1.x, p1.y);
    let inside = Rect::new(
        view.x0.max(panel.x0 + 1.0),
        view.y0.max(panel.y0 + 1.0),
        view.x1.min(panel.x1 - 1.0),
        view.y1.min(panel.y1 - 1.0),
    );
    if view.width() > 0.0 && view.height() > 0.0 {
        fill_rrect(s, inside, R_XS, C_SEL);
        stroke_rrect(s, inside, R_XS, C_ACCENT, STROKE_RING);
    }

    // the ✕ that hides it (⇧M brings it back); drawn only when the pointer is
    // on the panel, so the map stays a map
    let close = g.close();
    if hov_panel || hover(app, close) {
        fill_rrect(
            s,
            close,
            R_SM,
            if hover(app, close) {
                C_FIELD_2
            } else {
                C_FIELD
            },
        );
        draw_icon(s, "x", close.x0 + 2.0, close.y0 + 2.0, ICON_XS, C_MUTED);
    }
    tip(app, close, "Hide minimap (⇧M)");
    hit.push((close, Action::ToggleMinimap));
    // registered after the ✕ (reverse scan → the ✕ wins) so any input path
    // that goes through the hit list gets the same navigation the press
    // handler gives it
    let nav = g.to_world(Point::new(panel.center().x, panel.center().y));
    hit.push((panel, Action::MinimapNav(nav.x, nav.y)));
}

/// Draw the inspector's layout-guide settings on the selected frame.
///
/// These controls used to change only `guide_kind`/`guide_size` text in the
/// inspector. Keeping the overlay in the UI layer makes the control useful
/// for both legacy documents and new documents that do not yet carry a
/// serialized layout-grid definition.
fn paint_layout_guides(app: &App, s: &mut Scene) {
    let doc = app.doc_ref();
    if !doc.guides_visible {
        return;
    }
    let Some(id) = doc.selected_id() else {
        return;
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return;
    };
    // clamp, not max().min() (clippy::manual_clamp); NaN draws no guides
    // rather than a 1px wall of them.
    let step = doc.guide_size.clamp(1.0, 4096.0);
    let (ox, oy) = (node.transform.x, node.transform.y);
    let max_lines = 512usize;
    let guide_color = vello::peniko::Color::from_rgba8(0x00, 0x99, 0xFF, 0x58);
    let reg = app.editor_regions();

    // Square and Grid intentionally share the same measured cell size. Both
    // modes therefore remain useful for legacy documents even before a full
    // serialized layout-grid editor is available.
    let mut i = 0usize;
    let mut x = 0.0;
    while x <= node.w && i < max_lines {
        let sx = app.world_to_screen(Point::new(ox + x, oy)).x;
        if sx >= reg.canvas.x0 && sx <= reg.canvas.x1 {
            let color = if doc.guide_kind == 1 && i.is_multiple_of(4) {
                vello::peniko::Color::from_rgba8(0x00, 0x99, 0xFF, 0x90)
            } else {
                guide_color
            };
            vline(s, sx, reg.canvas.y0, reg.canvas.y1, color);
        }
        x += step;
        i += 1;
    }
    i = 0;
    let mut y = 0.0;
    while y <= node.h && i < max_lines {
        let sy = app.world_to_screen(Point::new(ox, oy + y)).y;
        if sy >= reg.canvas.y0 && sy <= reg.canvas.y1 {
            let color = if doc.guide_kind == 1 && i.is_multiple_of(4) {
                vello::peniko::Color::from_rgba8(0x00, 0x99, 0xFF, 0x90)
            } else {
                guide_color
            };
            hline(s, reg.canvas.x0, reg.canvas.x1, sy, color);
        }
        y += step;
        i += 1;
    }
}

/// Figma-style pink smart-guide lines while dragging.
fn paint_smart_guides(app: &App, s: &mut Scene) {
    if app.snap_lines.is_empty() {
        return;
    }
    let reg = app.editor_regions();
    for (w, kind) in &app.snap_lines {
        match kind {
            'v' => {
                let x = app.world_to_screen(Point::new(*w, 0.0)).x;
                vline(s, x, reg.canvas.y0, reg.canvas.y1, crate::theme::C_SNAP);
            }
            _ => {
                let y = app.world_to_screen(Point::new(0.0, *w)).y;
                hline(s, reg.canvas.x0, reg.canvas.x1, y, crate::theme::C_SNAP);
            }
        }
    }
}

/// Prototype connection arrows ("noodles") between frames.
/// Draws colored bezier curves connecting source nodes to their destinations,
/// following Figma's prototype visualization style.
fn paint_proto_connections(app: &App, s: &mut Scene) {
    // Only show connections when on the Prototype tab and we have a selection.
    // `app.doc()` takes `&mut self` and this painter only holds `&App`, so the
    // tab test reads through the same shared borrow the body needs anyway.
    let Some(doc) = app.doc_opt() else { return };
    if doc.right_tab != RightTab::Prototype {
        return;
    }
    let root = &doc.editor_ref().root;

    // Collect all nodes with interactions
    fn collect_interactions(n: &x_native::Node, out: &mut Vec<(String, x_native::Interaction)>) {
        for ix in x_native::effective_interactions(n) {
            out.push((n.id.clone(), ix));
        }
        for c in &n.children {
            collect_interactions(c, out);
        }
    }
    let mut all_interactions: Vec<(String, x_native::Interaction)> = Vec::new();
    collect_interactions(root, &mut all_interactions);

    if all_interactions.is_empty() {
        return;
    }

    // Helper to find node bounds
    fn find_node_bounds(root: &x_native::Node, id: &str) -> Option<Rect> {
        fn walk(n: &x_native::Node, id: &str, ox: f64, oy: f64) -> Option<Rect> {
            let x = ox + n.transform.x;
            let y = oy + n.transform.y;
            if n.id == id {
                return Some(Rect::new(x, y, x + n.w, y + n.h));
            }
            for c in &n.children {
                if let Some(r) = walk(c, id, x, y) {
                    return Some(r);
                }
            }
            None
        }
        walk(root, id, 0.0, 0.0)
    }

    // Draw each connection as a curved arrow
    for (source_id, ix) in &all_interactions {
        let dest_id = match &ix.action {
            x_native::Action::Navigate { destination } => Some(destination.as_str()),
            x_native::Action::OpenOverlay { overlay, .. } => Some(overlay.as_str()),
            x_native::Action::SwapOverlay { overlay } => Some(overlay.as_str()),
            x_native::Action::ScrollTo { destination } => Some(destination.as_str()),
            _ => None,
        };
        let Some(dest_id) = dest_id else { continue };
        let Some(src_rect) = find_node_bounds(root, source_id) else {
            continue;
        };
        let Some(dst_rect) = find_node_bounds(root, dest_id) else {
            continue;
        };

        // Convert to screen coordinates
        let src_screen = Rect::new(
            app.world_to_screen(Point::new(src_rect.x0, src_rect.y0)).x,
            app.world_to_screen(Point::new(src_rect.x0, src_rect.y0)).y,
            app.world_to_screen(Point::new(src_rect.x1, src_rect.y1)).x,
            app.world_to_screen(Point::new(src_rect.x1, src_rect.y1)).y,
        );
        let dst_screen = Rect::new(
            app.world_to_screen(Point::new(dst_rect.x0, dst_rect.y0)).x,
            app.world_to_screen(Point::new(dst_rect.x0, dst_rect.y0)).y,
            app.world_to_screen(Point::new(dst_rect.x1, dst_rect.y1)).x,
            app.world_to_screen(Point::new(dst_rect.x1, dst_rect.y1)).y,
        );

        // Start from right edge of source, end at left edge of destination
        let x0 = src_screen.x1;
        let y0 = (src_screen.y0 + src_screen.y1) / 2.0;
        let x1 = dst_screen.x0;
        let y1 = (dst_screen.y0 + dst_screen.y1) / 2.0;

        // Draw bezier curve (simplified as a line with control points)
        let mid_x = (x0 + x1) / 2.0;
        let color = crate::theme::C_SNAP; // Use the snap color (blue/purple)
        line(s, x0, y0, mid_x, y0, color, 1.5);
        line(s, mid_x, y0, mid_x, y1, color, 1.5);
        line(s, mid_x, y1, x1, y1, color, 1.5);

        // Draw arrowhead at destination
        let arrow_size = 6.0;
        // Right-pointing arrow
        line(
            s,
            x1 - arrow_size,
            y1 - arrow_size / 2.0,
            x1,
            y1,
            color,
            1.5,
        );
        line(
            s,
            x1 - arrow_size,
            y1 + arrow_size / 2.0,
            x1,
            y1,
            color,
            1.5,
        );

        // Draw small circle at source
        circle(s, x0, y0, 4.0, color);
    }
}

/// Inline canvas text editor — Figma's model: the buffer renders IN PLACE
/// over the node (its own text is blanked for the session), a thin blue
/// border replaces the selection chrome, and the caret + selection wash
/// are the only additions. No card, no fill, no handles. Ink sits on the
/// renderer's baseline (face ascent), on the SAME char grid as the caret.
fn paint_text_editor(app: &App, s: &mut Scene) {
    if app.text_edit.is_none() {
        return;
    }
    let Some(r) = app.text_edit_rect() else {
        return;
    };
    let Some((fs, ls, line_h)) = app.text_edit_metrics() else {
        return;
    };
    let Some((ox, oy, node_fw)) = app.text_edit_origin() else {
        return;
    };
    let buffer = app.text_buffer.clone();
    let sel = app.text_sel_range();
    let runs = app.text_runs_edit.clone();
    stroke_rrect(s, r, R_XS, EDIT_BORDER, 1.5);

    // first baseline = node.y + ascent * size/upem (renderer parity)
    let node_face = app.editor_face(None, node_fw.unwrap_or(400));
    let asc = {
        let f = &app.fonts.fonts.fonts[node_face];
        f.ascent * (fs / f.units_per_em)
    };

    // per-line draw: selection highlight, styled segments, caret
    let mut off = 0usize;
    for (li, line) in buffer.split('\n').enumerate() {
        let top = oy + li as f64 * line_h;
        let baseline = oy + asc + li as f64 * line_h;
        let len = line.chars().count();
        let line_a = off;
        let line_b = off + len;

        // selection highlight for this line's slice
        if let Some((sa, sb)) = sel {
            let a = sa.max(line_a);
            let b = sb.min(line_b);
            if b > a {
                let x0 = app.text_char_x(line, line_a, a - line_a, ox, fs, ls);
                let x1 = app.text_char_x(line, line_a, b - line_a, ox, fs, ls);
                let hr = Rect::new(x0, top, x1, top + line_h);
                fill_rrect(s, hr, R_XS, SELECTION_WASH);
            }
        }

        // styled segments: split the line at run boundaries; every char is
        // drawn at its exact grid position (caret math == ink math)
        let mut cursor = line_a;
        while cursor < line_b {
            // nearest run boundary at/after cursor
            let mut next = line_b;
            let mut hit: Option<x_native::TextRun> = None;
            for rr in &runs {
                let (rs, re) = (rr.start, rr.start + rr.len);
                if re <= cursor || rs >= line_b {
                    continue;
                }
                if rs > cursor {
                    next = next.min(rs);
                } else {
                    // covering run: cap the segment at its end
                    next = next.min(re);
                    hit = Some(rr.clone());
                }
            }
            for (i, ch) in line
                .chars()
                .skip(cursor - line_a)
                .take(next - cursor)
                .enumerate()
            {
                let g_off = cursor + i; // global char offset
                let x = app.text_char_x(line, line_a, g_off - line_a, ox, fs, ls);
                let sz = app.text_char_style(g_off).1;
                let size = if sz > 0.0 { sz } else { fs };
                let (fam, wgt, color) = match &hit {
                    None => (None, 400u16, C_BG),
                    Some(rr) => (
                        rr.font.as_deref(),
                        rr.weight.unwrap_or(400),
                        rr.color
                            .map(|c| {
                                let rgba = c.to_rgba8();
                                crate::theme::color_from_rgba8(rgba.r, rgba.g, rgba.b)
                            })
                            .unwrap_or(C_BG),
                    ),
                };
                let face = app.editor_face(fam, wgt);
                app.fonts
                    .text_at_baseline(s, x, baseline, &ch.to_string(), size, color, face);
            }
            cursor = next;
        }
        off += len + 1; // the '\n'
    }

    // caret (1.5px, selection blue) at the focus index
    if let Some((cx, cy)) = app.text_caret_pos(app.text_caret) {
        let cr = Rect::new(cx, cy, cx + 1.5, cy + line_h);
        fill_rrect(s, cr, R_NONE, crate::theme::C_SEL);
    }
}

/// Anchor / handle colours for vector edit mode (the theme's selection ring:
/// solid for a selected point, translucent for the tangent chrome).
const POINT_SELECTED: vello::peniko::Color = C_SEL;
const POINT_IDLE: vello::peniko::Color = vello::peniko::Color::from_rgba8(0xFF, 0xFF, 0xFF, 0xFF);
const POINT_BORDER: vello::peniko::Color = vello::peniko::Color::from_rgba8(0x00, 0x00, 0x00, 0xFF);
const HANDLE_COLOR: vello::peniko::Color = C_SEL_HANDLE;

/// Screen-space half-size of a drawn anchor. `vector_press` hit-tests with
/// [`ANCHOR_HIT_TOL`], which is this plus a couple of pixels of forgiveness, so
/// what the pointer can grab is what the user can see.
pub(crate) const ANCHOR_HALF: f64 = 4.5;
/// Screen-space half-size of a drawn control handle (smaller: it sits on top of
/// the tangent line and must not swallow clicks meant for the anchor).
pub(crate) const HANDLE_HALF: f64 = 3.5;

/// Render vector edit mode: the anchors of the node being edited, their bezier
/// control handles, and which anchors are selected.
///
/// Every position comes from the engine's WORLD-space layer
/// (`x_native::editor::anchors_world` / `handles_world`) rather than from the
/// path, for two reasons: path data is node-LOCAL while the canvas is world,
/// and these are the exact positions the pointer hit-tests against in
/// `Host::vector_press`. Painting one coordinate space and clicking in another
/// is the bug that makes a handle look draggable and miss by the node's offset.
fn paint_vector_points(app: &App, s: &mut Scene) {
    if !app.vector_edit_mode.active {
        return;
    }
    let Some(node_id) = &app.vector_edit_mode.selected_node else {
        return;
    };
    let doc = app.doc_ref();
    let Some(node) = find_node(&doc.editor_ref().root, node_id) else {
        return;
    };
    let anchors = x_native::editor::anchors_world(node);
    let selected = &app.vector_edit_mode.selected_points;

    // tangent lines and handles first, so the anchors draw on top of them
    if app.vector_edit_mode.show_handles {
        for (idx, _outgoing, (hx, hy)) in x_native::editor::handles_world(node) {
            let Some(a) = anchors.iter().find(|a| a.index == idx) else {
                continue;
            };
            let p0 = app.world_to_screen(Point::new(a.x, a.y));
            let p1 = app.world_to_screen(Point::new(hx, hy));
            line(s, p0.x, p0.y, p1.x, p1.y, HANDLE_COLOR, 1.0);
            let r = Rect::new(
                p1.x - HANDLE_HALF,
                p1.y - HANDLE_HALF,
                p1.x + HANDLE_HALF,
                p1.y + HANDLE_HALF,
            );
            fill_rrect(s, r, 1.0, HANDLE_COLOR);
            stroke_rrect(s, r, 1.0, POINT_SELECTED, 1.0);
        }
    }

    for a in &anchors {
        let p = app.world_to_screen(Point::new(a.x, a.y));
        let is_selected = selected.contains(&a.index);
        let half = if is_selected {
            ANCHOR_HALF + 1.0
        } else {
            ANCHOR_HALF
        };
        let r = Rect::new(p.x - half, p.y - half, p.x + half, p.y + half);
        fill_rrect(
            s,
            r,
            1.0,
            if is_selected {
                POINT_SELECTED
            } else {
                POINT_IDLE
            },
        );
        stroke_rrect(s, r, 1.0, POINT_BORDER, 1.0);
    }
}

/// Translucent selection wash behind the editor's selected text.
const SELECTION_WASH: vello::peniko::Color = C_SEL_WASH;

/// Light-blue border shown around the text while it is being edited
/// (Figma's edit-mode frame — replaces the selection chrome).
const EDIT_BORDER: vello::peniko::Color = C_EDIT_BORDER;

/// Inspector weight number -> the bundled face weight.
pub(crate) fn wt_for(w: u16) -> Wt {
    match w {
        500..=599 => Wt::Med,
        600..=699 => Wt::Semi,
        700.. => Wt::Bold,
        _ => Wt::Reg,
    }
}

/// Right-click context menu — app design language: #1A1A1A panel,
/// #2A2A2A border, r8, drop shadow, 28px rows (icon + label + shortcut),
/// #222222 hover row. Renders the data model's `items` — labels, icons,
/// shortcuts and enabled state are owned by `context_menu.rs` (viewport
/// audit P4: this used to be a hardcoded item list).
fn paint_context_menu(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let cm = &app.context_menu;
    if !cm.open {
        return;
    }
    let w = cm.width;
    let mut h = 10.0;
    for it in &cm.items {
        h += it.height();
    }
    let anchor = Point::new(cm.x, cm.y);
    let reg = app.editor_regions();
    // keep inside the canvas area
    let mx = anchor
        .x
        .min(reg.canvas.x1 - w - 4.0)
        .max(reg.canvas.x0 + 4.0);
    let my = anchor
        .y
        .min(app.status_band().y0 - h - 4.0)
        .max(reg.canvas.y0 + 4.0);
    let panel = Rect::new(mx, my, mx + w, my + h);
    elev_shadow(s, panel, 10.0, Elevation::Floating);
    fill_rrect(s, panel, R_LG, C_FIELD);
    stroke_rrect(s, panel, R_LG, C_LINE_2, 1.0);
    let row_h = MENU_ROW_H;
    let mut cy = my + 5.0;
    let mut flyouts: Vec<(Rect, &Vec<ContextMenuItem>)> = Vec::new();
    for it in &cm.items {
        match it {
            ContextMenuItem::Separator => {
                let ly = cy + 3.5;
                hline(s, mx + 8.0, mx + w - 8.0, ly, C_LINE_2);
                cy += SEPARATOR_HEIGHT;
            }
            ContextMenuItem::Action { action, enabled } => {
                let r = Rect::new(mx + 4.0, cy, mx + w - 4.0, cy + row_h);
                let hov = *enabled && hover(app, r);
                if hov {
                    fill_rrect(s, r, R_MD, C_FIELD_2);
                }
                let ic = if *enabled { C_TEXT } else { C_DIM };
                draw_icon(s, action.icon(), r.x0 + 8.0, r.y0 + 7.0, ICON_SM, ic);
                app.fonts
                    .text(s, r.x0 + 30.0, r.y0 + 6.8, action.label(), T11, ic, Wt::Reg);
                if let Some(sc) = action.shortcut() {
                    app.fonts.text_right(
                        s,
                        r.x1 - 8.0,
                        r.y0 + 7.3,
                        sc,
                        T10,
                        if *enabled { C_DIM } else { C_MUTED },
                        Wt::Reg,
                        0.0,
                    );
                }
                if *enabled {
                    if let Some(a) = action_for(action) {
                        hit.push((r, a));
                    }
                }
                cy += row_h;
            }
            ContextMenuItem::Submenu {
                label,
                icon,
                enabled,
                items,
            } => {
                let r = Rect::new(mx + 4.0, cy, mx + w - 4.0, cy + row_h);
                let hov = *enabled && hover(app, r);
                if hov {
                    fill_rrect(s, r, R_MD, C_FIELD_2);
                    flyouts.push((r, items));
                }
                let ic = if *enabled { C_TEXT } else { C_DIM };
                draw_icon(s, icon, r.x0 + 8.0, r.y0 + 7.0, ICON_SM, ic);
                app.fonts
                    .text(s, r.x0 + 30.0, r.y0 + 6.8, label, T11, ic, Wt::Reg);
                draw_icon(s, "chevron-right", r.x1 - 20.0, r.y0 + 8.0, ICON_XS, C_DIM);
                cy += row_h;
            }
        }
    }
    // Submenu flyouts: open on parent hover, clamped to the window,
    // flipped left when there is no room on the right.
    for (pr, sub) in flyouts {
        let sh = 6.0 + sub.len() as f64 * row_h;
        let right = pr.x1 + 4.0;
        let left = pr.x0 - w - 4.0;
        let sx = if right + w <= reg.canvas.x1 - 4.0 {
            right
        } else {
            left
        };
        let sy = (pr.y0 + 2.0).min(app.status_band().y0 - sh - 4.0);
        let sp = Rect::new(sx, sy, sx + w, sy + sh);
        elev_shadow(s, sp, 10.0, Elevation::Floating);
        fill_rrect(s, sp, R_LG, C_FIELD);
        stroke_rrect(s, sp, R_LG, C_LINE_2, 1.0);
        for (j, it) in sub.iter().enumerate() {
            if let ContextMenuItem::Action { action, enabled } = it {
                let y = sy + 3.0 + row_h * j as f64;
                let r = Rect::new(sx + 4.0, y, sx + w - 4.0, y + row_h);
                let hov = *enabled && hover(app, r);
                if hov {
                    fill_rrect(s, r, R_MD, C_FIELD_2);
                }
                let ic = if *enabled { C_TEXT } else { C_DIM };
                draw_icon(s, action.icon(), r.x0 + 8.0, r.y0 + 7.0, ICON_SM, ic);
                app.fonts
                    .text(s, r.x0 + 30.0, r.y0 + 6.8, action.label(), T11, ic, Wt::Reg);
                if let Some(sc) = action.shortcut() {
                    app.fonts.text_right(
                        s,
                        r.x1 - 8.0,
                        r.y0 + 7.3,
                        sc,
                        T10,
                        if *enabled { C_DIM } else { C_MUTED },
                        Wt::Reg,
                        0.0,
                    );
                }
                if *enabled {
                    if let Some(a) = action_for(action) {
                        hit.push((r, a));
                    }
                }
            }
        }
    }
}

/// Pages-panel context menu (right-click on the page field) — same design
/// language as the canvas menu: #1A1A1A panel, #2A2A2A border, r8, 28px rows.
fn paint_page_menu(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let Some(anchor) = app.page_menu else {
        return;
    };
    let (page, pages) = {
        let d = app.doc();
        (d.page, d.editors.len())
    };
    let items: Vec<(crate::state::PageMenuCmd, &str, &str, &str, bool)> = vec![
        (
            crate::state::PageMenuCmd::Rename,
            "pencil",
            "Rename page",
            "",
            true,
        ),
        (
            crate::state::PageMenuCmd::Duplicate,
            "copy-plus",
            "Duplicate page",
            "",
            true,
        ),
        (
            crate::state::PageMenuCmd::Delete,
            "trash-2",
            "Delete page",
            "⌫",
            pages > 1,
        ),
        (
            crate::state::PageMenuCmd::MoveUp,
            "arrow-up",
            "Move up",
            "",
            page > 0,
        ),
        (
            crate::state::PageMenuCmd::MoveDown,
            "arrow-down",
            "Move down",
            "",
            page + 1 < pages,
        ),
    ];
    let w = MENU_WIDTH;
    let row_h = MENU_ROW_H;
    let h = items.len() as f64 * row_h + 10.0;
    let mx = anchor.x.min(app.win_w - w - 4.0).max(4.0);
    let my = anchor.y.min(app.status_band().y0 - h - 4.0).max(4.0);
    let panel = Rect::new(mx, my, mx + w, my + h);
    elev_shadow(s, panel, 10.0, Elevation::Floating);
    fill_rrect(s, panel, R_LG, C_FIELD);
    stroke_rrect(s, panel, R_LG, C_LINE_2, 1.0);
    for (i, (cmd, icon, label, shortcut, enabled)) in items.iter().enumerate() {
        let r = Rect::new(
            mx + 4.0,
            my + 5.0 + row_h * i as f64,
            mx + w - 4.0,
            my + 5.0 + row_h * (i + 1) as f64,
        );
        let hov = *enabled && hover(app, r);
        if hov {
            fill_rrect(s, r, R_MD, C_FIELD_2);
        }
        let ic = if *enabled { C_TEXT } else { C_DIM };
        draw_icon(s, icon, r.x0 + 8.0, r.y0 + 7.0, ICON_SM, ic);
        app.fonts.text(
            s,
            r.x0 + 30.0,
            r.y0 + 6.8,
            label,
            T11,
            if *enabled { C_TEXT } else { C_MUTED },
            Wt::Reg,
        );
        app.fonts.text_right(
            s,
            r.x1 - 8.0,
            r.y0 + 7.3,
            shortcut,
            T10,
            if *enabled { C_DIM } else { C_MUTED },
            Wt::Reg,
            0.0,
        );
        if *enabled {
            hit.push((r, Action::PageMenu(*cmd)));
        }
    }
}

/// Viewport rulers (⇧R) — 22px top/left strips styled after the reference
/// screenshot: #2C2C2C bg, #444 inner border, #666 ticks, T10 labels.
/// Left-ruler labels are rotated 90° CCW (read bottom-to-top), like Figma.
/// A focus-ring band spans the selection's extent; an accent marker tracks
/// the pointer — both clamped to the canvas.
fn paint_rulers(app: &App, s: &mut Scene) {
    if !app.rulers {
        return;
    }
    let reg = app.editor_regions();
    let r = crate::theme::RULER_SIZE;
    fill_rect(
        s,
        Rect::new(
            reg.canvas.x0,
            reg.canvas.y0,
            reg.canvas.x1,
            reg.canvas.y0 + r,
        ),
        crate::theme::C_RULER_BG,
    );
    fill_rect(
        s,
        Rect::new(
            reg.canvas.x0,
            reg.canvas.y0,
            reg.canvas.x0 + r,
            reg.canvas.y1,
        ),
        crate::theme::C_RULER_BG,
    );
    hline(
        s,
        reg.canvas.x0,
        reg.canvas.x1,
        reg.canvas.y0 + r - 1.0,
        crate::theme::C_RULER_BORDER,
    );
    vline(
        s,
        reg.canvas.x0 + r - 1.0,
        reg.canvas.y0,
        reg.canvas.y1,
        crate::theme::C_RULER_BORDER,
    );
    // the left panel's border stays visible under the ruler strip
    vline(s, reg.canvas.x0, ED_TITLE_H, app.win_h, C_LINE);

    let (ox, oy, z) = app.canvas_transform();
    // nice step (1/2/5·10^k) with at least ~60px between labels
    let mut step = 10_000.0f64;
    for c in [
        1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0,
    ] {
        if c * z >= 60.0 {
            step = c;
            break;
        }
    }
    // top ruler — world x labels
    let x0w = (reg.canvas.x0 - ox) / z;
    let x1w = (reg.canvas.x1 - ox) / z;
    let mut wx = (x0w / step).ceil() * step;
    while wx <= x1w {
        let sx = (wx * z + ox).round(); // whole-pixel ticks → crisp #666
        vline(
            s,
            sx,
            reg.canvas.y0 + r - 5.0,
            reg.canvas.y0 + r - 1.0,
            crate::theme::C_RULER_TICK,
        );
        let label = fmt_num(wx);
        let lw = app.fonts.measure(&label, T10, Wt::Reg);
        app.fonts.text(
            s,
            sx - lw / 2.0,
            reg.canvas.y0 + 4.0,
            &label,
            T10,
            crate::theme::C_RULER_TEXT,
            Wt::Reg,
        );
        wx += step;
    }
    // left ruler — world y labels, rotated 90° CCW
    let y0w = (reg.canvas.y0 - oy) / z;
    let y1w = (reg.canvas.y1 - oy) / z;
    let mut wy = (y0w / step).ceil() * step;
    while wy <= y1w {
        let sy = (wy * z + oy).round();
        hline(
            s,
            reg.canvas.x0 + r - 5.0,
            reg.canvas.x0 + r - 1.0,
            sy,
            crate::theme::C_RULER_TICK,
        );
        let label = fmt_num(wy);
        let lw = app.fonts.measure(&label, T10, Wt::Reg);
        let mut tmp = vello::Scene::new();
        app.fonts.text(
            &mut tmp,
            0.0,
            0.0,
            &label,
            T10,
            crate::theme::C_RULER_TEXT,
            Wt::Reg,
        );
        // local x (run) → up, local y (line box) → +x; center both on sy / strip
        let t = vello::kurbo::Affine::translate((
            reg.canvas.x0 + (r - T10 * CSS_LH) / 2.0,
            sy + lw / 2.0,
        )) * vello::kurbo::Affine::rotate(-std::f64::consts::FRAC_PI_2);
        s.append(&tmp, Some(t));
        wy += step;
    }
    // selection extent: focus-ring band on both rulers spanning the
    // current-page selection's world bounds (clamped to the canvas)
    let page_sel = app.doc_opt().and_then(|d| {
        d.editors
            .get(d.page)
            .map(|ed| (d.page, ed.selection.clone()))
    });
    if let Some((page, ids)) = page_sel {
        let mut ext: Option<Rect> = None;
        for id in &ids {
            let r = flow_locate(app, id).and_then(|(pg, r, _)| (pg == page).then_some(r));
            if let Some(r) = r {
                ext = Some(ext.map_or(r, |e| e.union(r)));
            }
        }
        if let Some(e) = ext {
            let sx0 = (e.x0 * z + ox).clamp(reg.canvas.x0, reg.canvas.x1);
            let sx1 = (e.x1 * z + ox).clamp(reg.canvas.x0, reg.canvas.x1);
            let sy0 = (e.y0 * z + oy).clamp(reg.canvas.y0, reg.canvas.y1);
            let sy1 = (e.y1 * z + oy).clamp(reg.canvas.y0, reg.canvas.y1);
            if sx1 > sx0 {
                fill_rect(
                    s,
                    Rect::new(sx0, reg.canvas.y0, sx1, reg.canvas.y0 + 3.0),
                    C_SEL,
                );
            }
            if sy1 > sy0 {
                fill_rect(
                    s,
                    Rect::new(reg.canvas.x0, sy0, reg.canvas.x0 + 3.0, sy1),
                    C_SEL,
                );
            }
        }
    }
    // pointer line: accent marker across both rulers at the mouse world
    // position while the pointer is over the canvas
    if reg.canvas.contains(app.mouse) {
        let w = app.screen_to_world(app.mouse);
        let sx = (w.x * z + ox).round();
        let sy = (w.y * z + oy).round();
        vline(s, sx, reg.canvas.y0, reg.canvas.y0 + r, C_ACCENT);
        hline(s, reg.canvas.x0, reg.canvas.x0 + r, sy, C_ACCENT);
    }
}

/// P10: register a hover label for `r`; `paint_tooltip` draws the one
/// under the cursor, above everything else.
fn tip(app: &mut App, r: Rect, label: &str) {
    app.tooltip.push((r, label.to_string()));
}

fn hover(app: &App, r: Rect) -> bool {
    r.contains(app.mouse)
}

/// A field: a filled box, outlined only when it is hovered or being typed into.
///
/// Fields used to carry a hairline at rest, which made a panel of eight of them
/// read as a form of eight empty boxes. The fill is what separates a field from
/// the panel (`C_FIELD` on `C_PANEL`); the outline is the *affordance*, so it is
/// drawn when there is something to say — on hover here, and as the edit ring
/// [`paint_carets`] puts around the field currently receiving keystrokes.
fn input_box(app: &App, s: &mut Scene, r: Rect, radius: f64) {
    let hov = hover(app, r);
    fill_rrect(s, r, radius, if hov { C_INPUT_HOVER } else { C_FIELD });
    if hov {
        stroke_rrect(s, r, radius, C_LINE_2, 1.0);
    }
}

// ------------------------------------------------------------- canvas bg

fn paint_canvas_bg(app: &App, s: &mut Scene) {
    if !app.canvas_bg_visible {
        return;
    }
    let r = app.editor_regions();
    let a = (app.canvas_bg_alpha / 100.0).clamp(0.0, 1.0) as f32;
    let c = vello::peniko::Color::new([
        app.canvas_bg.components[0] * a,
        app.canvas_bg.components[1] * a,
        app.canvas_bg.components[2] * a,
        app.canvas_bg.components[3] * a,
    ]);
    fill_rect(s, r.canvas, c);
}

// ------------------------------------------------------------ title 36px

fn paint_title(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let w = app.win_w;
    fill_rect(s, Rect::new(0.0, 0.0, w, ED_TITLE_H), C_PANEL);
    // (bottom border is drawn in paint() after the panel fills)

    // logo cell 44px
    let cell = Rect::new(0.0, 0.0, LOGO_CELL_W, ED_TITLE_H);
    fill_rect(s, cell, C_PANEL);
    vline(s, LOGO_CELL_W - 1.0, 0.0, ED_TITLE_H - 1.0, C_LINE);
    crate::icons::draw_logo(
        s,
        (LOGO_CELL_W - LOGO) / 2.0,
        (ED_TITLE_H - LOGO) / 2.0,
        LOGO,
    );
    hit.push((cell, Action::DashNav(crate::state::DashView::Home)));

    // file tabs, flush against the logo cell
    let mut x = LOGO_CELL_W;
    for i in 0..app.docs.len() {
        let (name, dirty, active, is_untitled_home, stored_w) = {
            let d = &app.docs[i];
            (
                d.name.clone(),
                d.dirty || (i == app.active && app.pending_text_dirty()),
                i == app.active,
                d.path.is_none() && d.name == "Untitled",
                d.tab_w,
            )
        };
        let text_w = app.fonts.measure(&name, T11, Wt::Reg);
        let tab_w = stored_w.unwrap_or_else(|| {
            (TAB_MIN_W).max(TAB_PAD_L + 14.0 + 8.0 + text_w.min(160.0) + 8.0 + 16.0 + TAB_PAD_R)
        });
        let r = Rect::new(x, 0.0, x + tab_w, ED_TITLE_H);
        fill_rect(s, r, if active { C_FIELD } else { C_PANEL });
        vline(s, r.x1, 0.0, ED_TITLE_H, C_LINE);
        // icon — the mock's per-tab icon field: 'home' for the seed
        // Untitled tab, the blue badge for .md files, else file-text
        let ix = r.x0 + TAB_PAD_L;
        let iy = (ED_TITLE_H - 14.0) / 2.0;
        if name.ends_with(".md") {
            fill_rrect(
                s,
                Rect::new(ix, iy + 1.0, ix + 12.0, iy + 13.0),
                R_XS,
                C_MD_BADGE,
            );
            // ✦ (U+2726) isn't in Inter's latin subset — draw the 4-point
            // star as a path matched to the Chromium render
            crate::icons::draw_md_star(s, ix + 6.0, iy + 7.0, 3.25, C_TEXT);
        } else if is_untitled_home {
            draw_icon(s, "home", ix, iy, ICON_SM, C_DIM);
        } else {
            draw_icon(s, "file-text", ix, iy, ICON_SM, C_DIM);
        }
        // name
        let max_name = tab_w - TAB_PAD_L - 14.0 - 8.0 - 16.0 - TAB_PAD_R;
        let shown = app.fonts.truncate(&name, T11, Wt::Reg, max_name.max(20.0));
        app.fonts.text(
            s,
            ix + 14.0 + 8.0,
            (ED_TITLE_H - T11 * CSS_LH) / 2.0,
            &shown,
            T11,
            if active { C_TEXT } else { C_DIM },
            Wt::Reg,
        );
        // dirty marker (unsaved dot inside close-x)
        let cx_r = Rect::new(
            r.x1 - 27.0,
            (ED_TITLE_H - 16.0) / 2.0,
            r.x1 - 11.0,
            (ED_TITLE_H + 16.0) / 2.0,
        );
        // close-x is a static part of every tab in the HTML (16×16 at
        // y 9.5, 12px ✕, hover bg #2A2A2A) — always visible; audited box
        // left = tab right − 27
        if dirty {
            circle(s, cx_r.x0 - 5.0, cx_r.y0 + 8.0, 2.5, C_TEXT);
        }
        if hover(app, cx_r) {
            fill_rrect(s, cx_r, R_SM, C_LINE_2);
        }
        draw_icon(
            s,
            "x",
            cx_r.x0 + 2.0,
            cx_r.y0 + 2.0,
            ICON_XS,
            if hover(app, cx_r) { C_TEXT } else { C_DIM },
        );
        // hit zones are scanned in reverse, so the MORE SPECIFIC zone must
        // be pushed LAST: the ✕ must beat the whole-tab SelectDoc zone that
        // contains it (pushing SelectDoc last made clicks on ✕ select the
        // tab instead of closing it)
        hit.push((r, Action::SelectDoc(i)));
        hit.push((cx_r, Action::CloseDoc(i)));
        x += tab_w;
    }

    // new tab +
    let nb = Rect::new(x, 0.0, x + NEW_TAB_W, ED_TITLE_H);
    if hover(app, nb) {
        fill_rect(s, nb, C_FIELD);
    }
    vline(s, nb.x1, 0.0, ED_TITLE_H, C_LINE);
    draw_icon(
        s,
        "plus",
        nb.x0 + (NEW_TAB_W - 14.0) / 2.0,
        (ED_TITLE_H - 14.0) / 2.0,
        ICON_SM,
        C_DIM,
    );
    hit.push((nb, Action::NewFile));

    // rename doc field lives in the left panel; caret drawn there
}

// ------------------------------------------- X-Native workspace rail

/// Navigation bar colors.
// The nav bar paints through the theme roles like the rest of the chrome,
// so a theme switch reaches it too.
const C_NAV_BG: Color = C_PANEL;
const C_NAV_BORDER: Color = C_LINE;
const C_NAV_ACTIVE: Color = C_ACCENT;
const C_NAV_HOVER: Color = C_INPUT_HOVER;
const C_NAV_ICON: Color = C_DIM;
const C_NAV_ICON_ACTIVE: Color = C_TEXT;
const C_NAV_LABEL: Color = C_MUTED;
const NAV_ICON_SIZE: f64 = 20.0;
const NAV_ITEM_H: f64 = 40.0;
const NAV_ITEM_GAP: f64 = 2.0;

/// Vertical workspace rail — X-Native's persistent entry points for files,
/// agents, reusable media, tools, and design tokens. It intentionally avoids
/// Figma's Design/Prototype/Inspect naming and groups work by the full
/// compose-to-ship workflow instead.
fn paint_nav_bar(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let nr = reg.nav_bar;
    // Background
    fill_rect(s, nr, C_NAV_BG);
    vline(s, nr.x1 - 1.0, ED_TITLE_H, app.win_h, C_NAV_BORDER);

    let mut y = nr.y0 + 8.0;
    let nav_w = nr.x1 - nr.x0;

    // X-Native workspace menu at the top
    let menu_r = Rect::new(nr.x0 + 4.0, y, nr.x1 - 4.0, y + 36.0);
    let menu_hov = hover(app, menu_r);
    if menu_hov {
        fill_rrect(s, menu_r, R_MD, C_NAV_HOVER);
    }
    // Draw hamburger icon (3 lines)
    let hx = menu_r.x0 + (nav_w - 20.0) / 2.0;
    let hy = menu_r.y0 + 8.0;
    for i in 0..3 {
        hline(s, hx, hx + 20.0, hy + i as f64 * 5.0, C_NAV_ICON);
    }
    tip(app, menu_r, "Document menu");
    hit.push((menu_r, Action::OpenAppMenu));
    y += 44.0;

    // Divider
    hline(s, nr.x0 + 8.0, nr.x1 - 8.0, y, C_NAV_BORDER);
    y += 8.0;

    // Tab items
    let tabs = [
        NavTab::File,
        NavTab::Agents,
        NavTab::Assets,
        NavTab::Tools,
        NavTab::Variables,
    ];
    for tab in tabs.iter() {
        let ir = Rect::new(nr.x0 + 4.0, y, nr.x1 - 4.0, y + NAV_ITEM_H);
        let active = app.nav_tab == *tab;
        let hov = hover(app, ir);

        if active {
            // Active indicator: left border accent
            fill_rrect(s, ir, R_MD, C_NAV_HOVER);
            // Left accent bar
            fill_rrect(
                s,
                Rect::new(nr.x0, ir.y0 + 4.0, nr.x0 + 3.0, ir.y1 - 4.0),
                1.5,
                C_NAV_ACTIVE,
            );
        } else if hov {
            fill_rrect(s, ir, R_MD, C_NAV_HOVER);
        }

        // Icon
        let icon_color = if active {
            C_NAV_ICON_ACTIVE
        } else {
            C_NAV_ICON
        };
        draw_icon(
            s,
            tab.icon(),
            ir.x0 + (nav_w - 8.0 - NAV_ICON_SIZE) / 2.0,
            ir.y0 + (NAV_ITEM_H - NAV_ICON_SIZE) / 2.0 - 2.0,
            NAV_ICON_SIZE,
            icon_color,
        );

        // Label below icon
        {
            let label = tab.label();
            let lw = app.fonts.measure(label, 9.0, Wt::Reg);
            app.fonts.text(
                s,
                ir.x0 + (nav_w - 8.0 - lw) / 2.0,
                ir.y1 - 12.0,
                label,
                9.0,
                if active {
                    C_NAV_ICON_ACTIVE
                } else {
                    C_NAV_LABEL
                },
                Wt::Reg,
            );
        }

        hit.push((ir, Action::NavTab(*tab)));
        y += NAV_ITEM_H + NAV_ITEM_GAP;
    }

    // Spacer to push notifications to bottom
    y = nr.y1 - 52.0;

    // Notifications bell at bottom
    let bell_r = Rect::new(nr.x0 + 4.0, y, nr.x1 - 4.0, y + 40.0);
    let bell_hov = hover(app, bell_r);
    if bell_hov {
        fill_rrect(s, bell_r, R_MD, C_NAV_HOVER);
    }
    draw_icon(
        s,
        "message-circle",
        bell_r.x0 + (nav_w - 8.0 - 18.0) / 2.0,
        bell_r.y0 + 4.0,
        ICON_LG,
        C_NAV_ICON,
    );
    // Badge for unread count
    let unread = app.notifications.unread_count;
    if unread > 0 {
        let badge = Rect::new(
            bell_r.x1 - 16.0,
            bell_r.y0 + 4.0,
            bell_r.x1 - 4.0,
            bell_r.y0 + 18.0,
        );
        fill_rrect(s, badge, R_MD, C_DANGER_FILL);
        let count = if unread > 9 {
            "9+".to_string()
        } else {
            unread.to_string()
        };
        let cw = app.fonts.measure(&count, 8.0, Wt::Bold);
        app.fonts.text(
            s,
            badge.x0 + (badge.x1 - badge.x0 - cw) / 2.0,
            badge.y0 + 3.0,
            &count,
            8.0,
            C_ON_DANGER,
            Wt::Bold,
        );
    }
    tip(app, bell_r, "Notifications");
    hit.push((bell_r, Action::ToggleNotifications));
}

/// Application menu (hamburger menu dropdown).
fn paint_app_menu(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    if !app.app_menu.open {
        return;
    }
    let reg = app.editor_regions();
    let mx = reg.nav_bar.x1 + 4.0;
    let my = reg.nav_bar.y0 + 8.0;
    let mw = APP_MENU_WIDTH;
    // P14: every item is wired — file items route to the same commands as
    // their shortcuts; items without an implementation were removed.
    // The theme rows name the palettes and tick the active one: the old
    // single "Dark mode" row *cycled* them, so a click meant to switch the
    // app to dark could land on Daylight. Two rows, because two palettes
    // ship — the index of every row below is what `AppMenuItem` dispatches,
    // so a row removed here is a row removed in `run.rs` too.
    let active = crate::theme::active_theme();
    let tick = move |id: x_native::ui::ThemeId| -> &'static str {
        if active == id {
            "✓"
        } else {
            ""
        }
    };
    let items: Vec<(&str, &str, bool)> = vec![
        ("New file", "⌘N", true),
        ("Open file…", "⌘O", true),
        ("", "", false), // separator
        ("Save", "⌘S", true),
        ("Save as…", "⇧⌘S", true),
        ("Open version…", "", true),
        ("Duplicate file", "", true),
        ("Move to drafts", "", true),
        ("", "", false), // separator
        ("Export as…", "⇧⌘E", true),
        ("Find…", "⇧⌘F", true),
        ("", "", false), // separator
        (
            "Theme: Graphite (dark)",
            tick(x_native::ui::ThemeId::Graphite),
            true,
        ),
        (
            "Theme: Daylight (light)",
            tick(x_native::ui::ThemeId::Daylight),
            true,
        ),
        ("", "", false), // separator
        ("Welcome & shortcuts", "?", true),
    ];
    let row_h = DROPDOWN_ROW_H;
    let mut h = 8.0;
    for (label, _, is_sep) in &items {
        if *is_sep && label.is_empty() {
            h += 8.0;
        } else {
            h += row_h;
        }
    }
    let panel = Rect::new(mx, my, mx + mw, my + h);
    elev_shadow(s, panel, 12.0, Elevation::Floating);
    fill_rrect(s, panel, R_LG, C_FIELD);
    stroke_rrect(s, panel, R_LG, C_LINE_2, 1.0);

    let mut y = my + 4.0;
    for (i, (label, shortcut, is_item)) in items.iter().enumerate() {
        if *is_item && !label.is_empty() {
            let r = Rect::new(mx + 4.0, y, mx + mw - 4.0, y + row_h);
            let hov = hover(app, r);
            if hov {
                fill_rrect(s, r, R_SM, C_FIELD_2);
                app.app_menu.hover_index = Some(i);
            }
            app.fonts
                .text(s, r.x0 + 12.0, r.y0 + 8.0, label, T11, C_TEXT, Wt::Reg);
            if !shortcut.is_empty() {
                app.fonts.text_right(
                    s,
                    r.x1 - 12.0,
                    r.y0 + 8.5,
                    shortcut,
                    T10,
                    C_DIM,
                    Wt::Reg,
                    0.0,
                );
            }
            hit.push((r, Action::AppMenuItem(i)));
            y += row_h;
        } else if *is_item {
            // Separator
            hline(s, mx + 12.0, mx + mw - 12.0, y + 4.0, C_LINE);
            y += 8.0;
        }
    }

    // Close when clicking outside: no hit rect is registered for it — the
    // press dispatch treats "not inside the menu" as the outside click.
}

/// Find/Replace panel (top of left sidebar).
fn paint_find_replace(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    if !app.find_replace.open {
        return;
    }
    let reg = app.editor_regions();
    let fx = reg.sidebar.x0 + 8.0;
    let fy = reg.sidebar.y0 + 8.0;
    let fw = reg.sidebar.x1 - reg.sidebar.x0 - 16.0;
    let fh = if app.find_replace.show_replace {
        84.0
    } else {
        48.0
    };
    let panel = Rect::new(fx, fy, fx + fw, fy + fh);
    fill_rrect(s, panel, R_MD, C_FIELD);
    stroke_rrect(s, panel, R_MD, C_LINE_2, 1.0);

    // Search input row
    let search_r = Rect::new(fx + 6.0, fy + 6.0, fx + fw - 6.0, fy + 28.0);
    fill_rrect(s, search_r, R_SM, C_BG);
    stroke_rrect(s, search_r, R_SM, C_LINE, 1.0);
    draw_icon(
        s,
        "search",
        search_r.x0 + 6.0,
        glyph_top(search_r, ICON_SM),
        ICON_SM,
        C_DIM,
    );
    let query = if app
        .field
        .as_ref()
        .is_some_and(|f| f.id == FieldId::FindQuery)
    {
        app.field
            .as_ref()
            .map(|f| f.buffer.clone())
            .unwrap_or_default()
    } else if app.find_replace.query.is_empty() {
        "Search…".to_string()
    } else {
        app.find_replace.query.clone()
    };
    let qc = if app.find_replace.query.is_empty() {
        C_PLACEHOLDER
    } else {
        C_TEXT
    };
    app.fonts.text(
        s,
        search_r.x0 + 24.0,
        line_top(search_r, T11),
        &query,
        T11,
        qc,
        Wt::Reg,
    );
    // P13: the search row is a real field (was painted without a hit)
    hit.push((search_r, Action::Field(FieldId::FindQuery)));
    if !app.find_replace.query.is_empty() {
        let match_text = format!(
            "{}/{}",
            app.find_replace.current_match.max(1),
            app.find_replace.match_count
        );
        let mtw = app.fonts.measure(&match_text, T10, Wt::Reg);
        app.fonts.text(
            s,
            search_r.x1 - 60.0 - mtw,
            line_top(search_r, T10),
            &match_text,
            T10,
            C_DIM,
            Wt::Reg,
        );
        // Prev/Next buttons
        let prev_r = Rect::new(
            search_r.x1 - 44.0,
            search_r.y0 + 2.0,
            search_r.x1 - 26.0,
            search_r.y1 - 2.0,
        );
        let next_r = Rect::new(
            search_r.x1 - 22.0,
            search_r.y0 + 2.0,
            search_r.x1 - 4.0,
            search_r.y1 - 2.0,
        );
        draw_icon(
            s,
            "chevron-up",
            glyph_left(prev_r, ICON_XS),
            glyph_top(prev_r, ICON_XS),
            ICON_XS,
            C_DIM,
        );
        draw_icon(
            s,
            "chevron-down",
            glyph_left(next_r, ICON_XS),
            glyph_top(next_r, ICON_XS),
            ICON_XS,
            C_DIM,
        );
        tip(app, prev_r, "Previous match");
        hit.push((prev_r, Action::FindPrev));
        tip(app, next_r, "Next match");
        hit.push((next_r, Action::FindNext));
    }
    // Close button
    let close_r = Rect::new(fx + fw - 20.0, fy + 2.0, fx + fw - 4.0, fy + 18.0);
    draw_icon(
        s,
        "x",
        glyph_left(close_r, ICON_XS),
        glyph_top(close_r, ICON_XS),
        ICON_XS,
        C_DIM,
    );
    tip(app, close_r, "Close find & replace");
    hit.push((close_r, Action::CloseFind));

    // Replace row (if shown)
    if app.find_replace.show_replace {
        let ry = fy + 34.0;
        let replace_r = Rect::new(fx + 6.0, ry, fx + fw - 6.0, ry + 22.0);
        fill_rrect(s, replace_r, R_SM, C_BG);
        stroke_rrect(s, replace_r, R_SM, C_LINE, 1.0);
        let rep_text = if app
            .field
            .as_ref()
            .is_some_and(|f| f.id == FieldId::FindReplace)
        {
            app.field
                .as_ref()
                .map(|f| f.buffer.clone())
                .unwrap_or_default()
        } else if app.find_replace.replace.is_empty() {
            "Replace…".to_string()
        } else {
            app.find_replace.replace.clone()
        };
        let rc = if app.find_replace.replace.is_empty() {
            C_PLACEHOLDER
        } else {
            C_TEXT
        };
        app.fonts.text(
            s,
            replace_r.x0 + 8.0,
            line_top(replace_r, T11),
            &rep_text,
            T11,
            rc,
            Wt::Reg,
        );
        // P13: the replace row is a real field (was painted without a hit)
        hit.push((replace_r, Action::Field(FieldId::FindReplace)));

        // Replace / Replace All buttons
        let btn_y = ry + 26.0;
        let repl_all_r = Rect::new(fx + fw - 80.0, btn_y, fx + fw - 6.0, btn_y + 18.0);
        fill_rrect(s, repl_all_r, R_SM, C_FIELD_2);
        app.fonts.text(
            s,
            repl_all_r.x0 + 6.0,
            line_top(repl_all_r, T10),
            "Replace all",
            T10,
            C_TEXT,
            Wt::Reg,
        );
        hit.push((repl_all_r, Action::ReplaceAll));
        // P13: single-replace for the current match (was missing)
        let repl_r = Rect::new(fx + 6.0, btn_y, fx + 6.0 + 64.0, btn_y + 18.0);
        fill_rrect(s, repl_r, R_SM, C_FIELD_2);
        app.fonts.text(
            s,
            repl_r.x0 + 6.0,
            line_top(repl_r, T10),
            "Replace",
            T10,
            C_TEXT,
            Wt::Reg,
        );
        hit.push((repl_r, Action::Replace));
    }

    // Toggle row
    let toggle_y = fy
        + if app.find_replace.show_replace {
            60.0
        } else {
            32.0
        };
    let case_r = Rect::new(fx + 6.0, toggle_y, fx + 22.0, toggle_y + 14.0);
    if app.find_replace.case_sensitive {
        fill_rrect(s, case_r, R_SM, C_NAV_ACTIVE);
    }
    app.fonts.text(
        s,
        case_r.x0 + 2.0,
        line_top(case_r, 9.0),
        "Aa",
        9.0,
        if app.find_replace.case_sensitive {
            C_ON_ACCENT
        } else {
            C_DIM
        },
        Wt::Bold,
    );
    hit.push((case_r, Action::ToggleCaseSensitive));

    let sel_r = Rect::new(fx + 26.0, toggle_y, fx + 42.0, toggle_y + 14.0);
    if app.find_replace.in_selection {
        fill_rrect(s, sel_r, R_SM, C_NAV_ACTIVE);
    }
    draw_icon(
        s,
        "box-select",
        sel_r.x0 + 2.0,
        sel_r.y0 + 1.0,
        ICON_XS,
        if app.find_replace.in_selection {
            C_ON_ACCENT
        } else {
            C_DIM
        },
    );
    hit.push((sel_r, Action::ToggleFindInSelection));
}

/// Notification panel (opens from nav bar bell icon).
fn paint_notifications(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    if !app.notifications.open {
        return;
    }
    let reg = app.editor_regions();
    let nx = reg.nav_bar.x1 + 4.0;
    let ny = reg.nav_bar.y1 - 200.0;
    let nw = 280.0;
    let nh = 180.0;
    let panel = Rect::new(nx, ny, nx + nw, ny + nh);
    elev_shadow(s, panel, 12.0, Elevation::Floating);
    fill_rrect(s, panel, R_LG, C_FIELD);
    stroke_rrect(s, panel, R_LG, C_LINE_2, 1.0);

    // Header
    app.fonts.text(
        s,
        panel.x0 + 12.0,
        panel.y0 + 10.0,
        "Notifications",
        T11,
        C_TEXT,
        Wt::Med,
    );
    if app.notifications.unread_count > 0 {
        let mark_all_r = Rect::new(
            panel.x1 - 80.0,
            panel.y0 + 4.0,
            panel.x1 - 8.0,
            panel.y0 + 22.0,
        );
        app.fonts.text(
            s,
            mark_all_r.x0,
            mark_all_r.y0 + 4.0,
            "Mark all read",
            T10,
            C_ACCENT_INK,
            Wt::Reg,
        );
        hit.push((mark_all_r, Action::MarkAllNotificationsRead));
    }
    hline(s, panel.x0 + 8.0, panel.x1 - 8.0, panel.y0 + 28.0, C_LINE);

    // Notification items
    let mut y = panel.y0 + 34.0;
    for notif in &app.notifications.notifications {
        let nr = Rect::new(panel.x0 + 8.0, y, panel.x1 - 8.0, y + 44.0);
        if !notif.read {
            fill_rrect(s, nr, R_SM, C_UNREAD_WASH);
        }
        draw_icon(
            s,
            notif.kind.icon(),
            nr.x0 + 8.0,
            nr.y0 + 6.0,
            ICON_SM,
            if notif.read { C_DIM } else { C_ACCENT_INK },
        );
        let msg = app
            .fonts
            .truncate(&notif.message, T10, Wt::Reg, nr.width() - 40.0);
        app.fonts.text(
            s,
            nr.x0 + 28.0,
            nr.y0 + 8.0,
            &msg,
            T10,
            if notif.read { C_DIM } else { C_TEXT },
            Wt::Reg,
        );
        // Dismiss button
        let dismiss_r = Rect::new(nr.x1 - 20.0, nr.y0 + 4.0, nr.x1 - 4.0, nr.y0 + 20.0);
        if hover(app, dismiss_r) {
            draw_icon(
                s,
                "x",
                dismiss_r.x0 + 4.0,
                dismiss_r.y0 + 4.0,
                ICON_XS,
                C_DIM,
            );
        }
        hit.push((dismiss_r, Action::DismissNotification(notif.id.clone())));
        y += 48.0;
    }
}

// ------------------------------------------------------- left panel 280px

fn paint_left(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    // If UI is minimized, hide the sidebar
    if app.ui_minimized {
        return;
    }
    let sidebar = reg.sidebar;
    let lw = sidebar.x1;
    fill_rect(s, sidebar, C_PANEL);
    vline(s, lw - 1.0, ED_TITLE_H, app.win_h, C_LINE);

    // Audited (1440): DRAFTS row 48, project row 78, pills 110.5, PAGES 156.5,
    // page field 178, divider 218, tree from 252.5. Offsets below are abs - 36.
    let y0 = ED_TITLE_H;
    // x-offset: sidebar starts at nav_bar_w (old code assumed x=0)
    let sx = sidebar.x0;

    // DRAFTS header — one 16px box; the glyph and the label's line box are
    // both centred in it instead of being hand-placed (the glyph used to sit
    // on the box's bottom edge).
    let dbox = Rect::new(sx + 12.0, y0 + 12.0, sx + 28.0, y0 + 28.0);
    fill_rrect(s, dbox, R_SM, C_FIELD);
    stroke_rrect(s, dbox, R_SM, C_LINE, 1.0);
    draw_icon(
        s,
        "box",
        glyph_left(dbox, ICON_XS),
        glyph_top(dbox, ICON_XS),
        ICON_XS,
        C_DIM,
    );
    app.fonts
        .micro_label(s, sx + 36.0, line_top(dbox, T10), "DRAFTS", C_DIM, Wt::Med);

    // file name row (editable) — the mock's file-name-text, independent
    // from the active tab name
    let (name, _dirty) = {
        let d = app.doc();
        (
            d.file_label.clone().unwrap_or_else(|| d.name.clone()),
            d.dirty,
        )
    };
    // One 23.5px row (75…98.5): the line box, the draft dot and the pencil
    // all centre on its middle — the offsets below are row-relative, not
    // eyeballed (row centre = ny + 8.75).
    let ny = y0 + 42.0; // name text box top 78
    let nr = Rect::new(sx + 8.0, ny - 3.0, lw - 8.0, ny + 20.5);
    if app.field.as_ref().map(|f| f.id) == Some(FieldId::DocName) {
        let editing = app.field.as_ref().unwrap().buffer.clone();
        fill_rrect(
            s,
            Rect::new(sx + 12.0, ny - 1.0, lw - 12.0, ny + 19.0),
            R_SM,
            C_FIELD,
        );
        stroke_rrect(
            s,
            Rect::new(sx + 12.0, ny - 1.0, lw - 12.0, ny + 19.0),
            R_SM,
            C_LINE_2,
            1.0,
        );
        app.fonts.text(
            s,
            sx + 18.0,
            line_top(nr, T11),
            &editing,
            T11,
            C_TEXT,
            Wt::Med,
        );
    } else {
        if hover(app, nr) {
            // .editable:hover — bg #1A1A1A, border #2A2A2A, radius 4
            fill_rrect(s, nr, R_SM, C_FIELD);
            stroke_rrect(s, nr, R_SM, C_LINE_2, 1.0);
        }
        circle(s, sx + 15.0, nr.center().y, 3.0, C_DRAFT_DOT);
        let shown = app.fonts.truncate(&name, T11, Wt::Med, lw - 24.0 - 40.0);
        app.fonts.text(
            s,
            sx + 26.0,
            line_top(nr, T11),
            &shown,
            T11,
            C_TEXT,
            Wt::Med,
        );
        if hover(app, nr) {
            draw_icon(
                s,
                "pencil",
                lw - 25.0,
                glyph_top(nr, ICON_XS),
                ICON_XS,
                C_DIM,
            );
        }
    }
    hit.push((nr, Action::RenameStart));

    // pill tabs LAYERS / ASSETS / TOKENS — container (8,110.5,263,30)
    let pill_y = y0 + 74.5;
    let px0 = sx + 8.0;
    let pw = sidebar.x1 - sidebar.x0 - 17.0;
    fill_rrect(
        s,
        Rect::new(px0, pill_y, px0 + pw, pill_y + PILL_H),
        R_LG,
        C_BG,
    );
    stroke_rrect(
        s,
        Rect::new(px0, pill_y, px0 + pw, pill_y + PILL_H),
        R_LG,
        C_LINE,
        1.0,
    );
    let item_w = (pw - 6.0 - 4.0) / 3.0;
    let tabs = [
        // X-Native calls the layer tree Structure and the asset browser
        // Library: the document model is a scene graph, not a Figma clone.
        (LeftTab::Layers, "STRUCTURE"),
        (LeftTab::Assets, "LIBRARY"),
        (LeftTab::Tokens, "TOKENS"),
    ];
    for (i, (tab, label)) in tabs.into_iter().enumerate() {
        let ix = px0 + 3.0 + (item_w + 2.0) * i as f64;
        let ir = Rect::new(ix, pill_y + 3.0, ix + item_w, pill_y + 27.0);
        let active = app.doc().left_tab == tab;
        if active {
            fill_rrect(s, ir, R_PILL, C_FIELD_2);
            stroke_rrect(s, ir, R_PILL, C_LINE_2, 1.0);
        }
        app.fonts.text_center(
            s,
            ir,
            label,
            T10,
            if active { C_TEXT } else { C_DIM },
            Wt::Semi,
            true,
        );
        {
            hit.push((ir, Action::LeftTab(tab)));
        }
    }
    // Agents is a real workspace surface, not an empty selection state. Keep
    // it intentionally small until the agent conversation UI lands, but make
    // the available integration visible and give the user useful context.
    if app.nav_tab == NavTab::Agents {
        let ay = y0 + 132.0;
        app.fonts
            .micro_label(s, sx + 12.0, ay, "AGENT WORKSPACE", C_DIM, Wt::Med);
        app.fonts.text(
            s,
            sx + 12.0,
            ay + 28.0,
            "MCP tools connected",
            T11,
            C_TEXT,
            Wt::Med,
        );
        app.fonts.text(
            s,
            sx + 12.0,
            ay + 48.0,
            "Ask an agent to inspect or edit this file.",
            T10,
            C_MUTED,
            Wt::Reg,
        );
        let status_r = Rect::new(sx + 12.0, ay + 68.0, lw - 12.0, ay + 96.0);
        fill_rrect(s, status_r, R_MD, C_FIELD_2);
        app.fonts.text_center(
            s,
            status_r,
            "⌘K  Open command palette",
            T10,
            C_TEXT,
            Wt::Med,
            true,
        );
        hit.push((status_r, Action::PaletteToggle));
        return;
    }

    // LIBRARY and TOKENS own the band below the pill tabs. They used to be
    // painted *under* the pages band — at an absolute x = 12, i.e. over the
    // nav rail, and 50px lower than the tab strip — so the PAGES list, the
    // LAYERS header and the tree all landed on top of them. One band at a
    // time now: the tab picks the content, and the content starts where the
    // Layers tab's first section label starts.
    let y = y0 + 120.5; // PAGES label top 156.5
    match app.doc().left_tab {
        LeftTab::Assets => {
            paint_assets(app, s, hit, y, sx, lw);
            app.page_field_rect = None;
            return;
        }
        LeftTab::Tokens => {
            paint_tokens(app, s, hit, y, sx, lw);
            app.page_field_rect = None;
            return;
        }
        LeftTab::Layers => {}
    }

    // PAGES section — a real page LIST (viewport audit P2): every page is
    // visible, click a row to switch, right-click for the page menu, hover
    // trash to delete. The band height is MEASURED from its rows (no more
    // fixed single field) and the LAYERS band below anchors to its bottom.
    app.fonts
        .micro_label(s, sx + 12.0, y, "PAGES", C_DIM, Wt::Med);
    // the add button is exactly one line box tall, so its glyph centres on
    // the PAGES label it sits beside
    let addp = Rect::new(lw - 26.0, y, lw - 14.0, y + T10 * CSS_LH);
    draw_icon(
        s,
        "plus",
        glyph_left(addp, ICON_XS),
        glyph_top(addp, ICON_XS),
        ICON_XS,
        C_DIM,
    );
    tip(app, addp, "Add page");
    hit.push((addp, Action::AddPage));

    let page_count = app.doc().editors.len();
    let cur_page = app.doc().page;
    let rows = app.pages_rows();
    // Every page is reachable: the window follows the active page (the old
    // `+N more` sentinel row was not a real page, so pages past the 3rd
    // could not be selected, renamed or deleted).
    // right-click zone = the whole band (paint + input share pages_rows). A
    // document always has at least one page, but a corrupt load must not take
    // the paint pass down with it.
    match (rows.first(), rows.last()) {
        (Some(first), Some(last)) => {
            app.page_field_rect = Some(Rect::new(first.1.x0, first.1.y0, last.1.x1, last.1.y1));
        }
        _ => app.page_field_rect = None,
    }
    for (page_i, r) in rows {
        let active = page_i == cur_page;
        if active || hover(app, r) {
            fill_rrect(s, r, R_PAGE, if active { C_FIELD_2 } else { C_ROW_HOVER });
            if active {
                stroke_rrect(s, r, R_PAGE, C_LINE_2, 1.0);
            }
        }
        // the row carries a sketch of the page, not a generic file glyph:
        // a page you can recognise is a page you can switch to (audit §9
        // item 3 — thumbnails, next to the name they belong to). A page with
        // nothing on it keeps the plain icon.
        let thumb = Rect::new(sx + 16.0, r.y0 + 4.0, sx + 38.0, r.y0 + 22.0);
        paint_page_sketch(app, s, page_i, thumb);
        if !page_has_content(app, page_i) {
            draw_icon(
                s,
                "file",
                glyph_left(thumb, ICON_XS),
                glyph_top(thumb, ICON_XS),
                ICON_XS,
                if active { C_TEXT } else { C_DIM },
            );
        }
        let page_label = app
            .doc()
            .doc
            .pages
            .get(page_i)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| format!("Page {}", page_i + 1));
        // Hit order inside the row matters: zones are scanned in REVERSE, so
        // the row is registered FIRST and the specific zones on top of it —
        // the ✕/rename below must beat `SelectPage`, never the other way
        // round. (The trash used to be pushed before the row, which is why
        // clicking Delete selected the page instead of deleting it — the same
        // mistake the layer chevron had.)
        hit.push((r, Action::SelectPage(page_i)));
        // inline rename state (opened from the page menu): the ACTIVE row
        // shows the buffer, and the field zone sits above the row zone so a
        // click puts the caret back in the name being renamed
        let field_id = app.field.as_ref().map(|f| f.id);
        if field_id == Some(FieldId::PageName) && active {
            let editing = app.field.as_ref().unwrap().buffer.clone();
            app.fonts.text(
                s,
                sx + 41.0,
                line_top(r, T11),
                &editing,
                T11,
                C_TEXT,
                Wt::Reg,
            );
            hit.push((r, Action::Field(FieldId::PageName)));
        } else {
            let max_nw = (r.x1 - sx - 41.0 - 26.0).max(16.0);
            let shown = app.fonts.truncate(&page_label, T11, Wt::Reg, max_nw);
            let shown_color = if active { C_TEXT } else { C_MUTED };
            app.fonts.text(
                s,
                sx + 41.0,
                line_top(r, T11),
                &shown,
                T11,
                shown_color,
                Wt::Reg,
            );
        }
        // the delete affordance appears on any row (the ACTIVE page is
        // deletable too — Figma lets you delete the page you are on), but
        // never when it would leave the document with no page at all
        if hover(app, r) && page_count > 1 {
            let tr = Rect::new(
                lw - 30.0,
                r.y0 + centre_in(16.0, r.height()),
                lw - 12.0,
                r.y0 + centre_in(16.0, r.height()) + 16.0,
            );
            draw_icon(
                s,
                "trash-2",
                glyph_left(tr, ICON_XS),
                glyph_top(tr, ICON_XS),
                ICON_XS,
                C_DIM,
            );
            tip(app, tr, "Delete page");
            hit.push((tr, Action::DeletePage(page_i)));
        }
    }

    // divider + LAYERS header anchored to the measured band bottom (the
    // old fixed 182/195/216.5 offsets assumed one 28px field)
    let band_bottom = app.pages_band_bottom();
    hline(s, sx, lw, band_bottom + 12.0, C_LINE);
    let ly = band_bottom + 25.0;
    // One 16px header row holds the label and both buttons, so all three share
    // a centre line; the label used to sit 2.5px lower than the buttons it is
    // in line with (it was placed by top edge, not centre).
    let hrow = Rect::new(sx + 12.0, ly - 3.0, lw, ly + 13.0);
    app.fonts
        .micro_label(s, sx + 12.0, line_top(hrow, T10), "LAYERS", C_DIM, Wt::Med);
    // F8: the search icon was dead — it opens the tree search field
    let srch = Rect::new(lw - 28.0, hrow.y0, lw - 12.0, hrow.y1);
    if hover(app, srch) {
        fill_rrect(s, srch, R_SM, C_FIELD_2);
    }
    draw_icon(
        s,
        "search",
        glyph_left(srch, ICON_XS),
        glyph_top(srch, ICON_XS),
        ICON_XS,
        C_DIM,
    );
    tip(app, srch, "Search layers");
    hit.push((srch, Action::Field(FieldId::TreeSearch)));
    // F6: collapse-all (Figma parity) — the selection's ancestors stay
    // open; it sits left of search
    let cpl = Rect::new(lw - 46.0, hrow.y0, lw - 30.0, hrow.y1);
    if hover(app, cpl) {
        fill_rrect(s, cpl, R_SM, C_FIELD_2);
    }
    draw_icon(
        s,
        "chevrons-down",
        glyph_left(cpl, ICON_XS),
        glyph_top(cpl, ICON_XS),
        ICON_XS,
        C_DIM,
    );
    tip(app, cpl, "Collapse all layers");
    hit.push((cpl, Action::CollapseAllLayers));

    // F8: the search row is visible while the field is open or the
    // query is non-empty; the tree anchors below it
    let search_open = app.field.as_ref().map(|f| f.id) == Some(FieldId::TreeSearch)
        || !app.doc().tree_search.is_empty();
    if search_open {
        let sr = Rect::new(sx + 4.0, ly + 12.0, sx + lw - 4.0, ly + 12.0 + 24.0);
        input_box(app, s, sr, 6.0);
        draw_icon(
            s,
            "search",
            sr.x0 + 8.0,
            glyph_top(sr, ICON_XS),
            ICON_XS,
            C_DIM,
        );
        let q = if app.field.as_ref().map(|f| f.id) == Some(FieldId::TreeSearch) {
            app.field.as_ref().unwrap().buffer.clone()
        } else {
            app.doc().tree_search.clone()
        };
        if !q.is_empty() {
            let shown = app
                .fonts
                .truncate(&q, T11, Wt::Reg, (sr.width() - 40.0).max(16.0));
            app.fonts.text(
                s,
                sr.x0 + 26.0,
                line_top(sr, T11),
                &shown,
                T11,
                C_TEXT,
                Wt::Reg,
            );
            let clr = Rect::new(sr.x1 - 20.0, sr.y0 + 2.0, sr.x1 - 6.0, sr.y1 - 2.0);
            if hover(app, clr) {
                fill_rrect(s, clr, R_SM, C_FIELD_2);
            }
            draw_icon(
                s,
                "x",
                glyph_left(clr, ICON_XS),
                glyph_top(clr, ICON_XS),
                ICON_XS,
                C_DIM,
            );
            hit.push((clr, Action::TreeSearchClear));
        }
        hit.push((sr, Action::Field(FieldId::TreeSearch)));
    }

    // tree (scrollable)
    let tree_top = band_bottom + 34.5 + if search_open { 30.0 } else { 0.0 };
    let tree_bottom = app.status_band().y0 - 16.0;
    let scroll = app.doc().scroll_left;
    let (rows, total_h) = collect_tree_rows(app, scroll, tree_bottom - tree_top);
    let mut max_indent = 0usize;
    let mut last_bottom = tree_top;
    for row in &rows {
        let ry = tree_top + row.index as f64 * (TREE_ROW_H + 1.0) - scroll;
        let r = Rect::new(sx + 8.0, ry, lw - 8.0, ry + TREE_ROW_H);
        if r.y1 >= tree_top && r.y0 <= tree_bottom {
            max_indent = max_indent.max(row.indent);
            last_bottom = r.y1;
            let selected = row.selected;
            // P5: a section (frame with children) keeps a subtle header
            // band so the document's hierarchy reads at a glance; hover
            // steps one surface level up instead of appearing from none.
            if row.is_section {
                fill_rrect(s, r, R_TREE, C_FIELD);
            }
            if selected {
                fill_rrect(s, r, R_TREE, C_SEL_SOFT);
            } else if hover(app, r) {
                fill_rrect(
                    s,
                    r,
                    R_TREE,
                    if row.is_section {
                        C_FIELD_2
                    } else {
                        C_ROW_HOVER
                    },
                );
            }
            // P12: live drag indicator — the dragged row lifts and
            // the accent line/ring shows where it will land.
            if let Some(Drag::TreeRow {
                id: drag_row,
                active: true,
                over,
                ..
            }) = &app.drag
            {
                if drag_row == &row.id {
                    stroke_rrect(s, r, R_TREE, C_ACCENT, 1.5);
                }
                if let Some(drop) = over {
                    if drop.row == row.id {
                        match drop.zone {
                            0 => fill_rect(
                                s,
                                Rect::new(r.x0, r.y0 - 1.5, r.x1, r.y0 + 0.5),
                                C_ACCENT,
                            ),
                            2 => fill_rect(
                                s,
                                Rect::new(r.x0, r.y1 - 0.5, r.x1, r.y1 + 1.5),
                                C_ACCENT,
                            ),
                            _ => stroke_rrect(s, r, R_TREE, C_ACCENT, 1.5),
                        }
                    }
                }
            }
            let ix = sx + 8.0 + 8.0 + row.indent as f64 * TREE_INDENT;
            // Figma's disclosure: the chevron is its OWN target, so a click
            // on it folds the node instead of selecting the row. Hit zones
            // are scanned in reverse (most specific last) and the chevron
            // sits inside the row rect — so it is registered *after* the row
            // below, not before it.
            let chevron = if row.has_children {
                let chev = if row.expanded {
                    "chevron-down"
                } else {
                    "chevron-right"
                };
                let cr = Rect::new(ix, r.y0, ix + 14.0, r.y1);
                draw_icon(
                    s,
                    chev,
                    glyph_left(cr, ICON_XS),
                    glyph_top(cr, ICON_XS),
                    ICON_XS,
                    C_DIM,
                );
                Some(cr)
            } else {
                None
            };
            draw_icon(
                s,
                row.icon,
                ix + 14.0,
                glyph_top(r, ICON_XS),
                ICON_XS,
                C_DIM,
            );
            let nx = ix + 14.0 + 12.0 + 4.0;
            let max_nw = lw - 8.0 - nx - 8.0;
            // Inline rename (Figma: double-click a layer name). The field's
            // buffer is what the user is typing, so it wins over the node's
            // stored name; the name zone is registered AFTER the row so the
            // reverse scan finds it first.
            let editing = app
                .field
                .as_ref()
                .is_some_and(|f| f.id == FieldId::LayerName)
                && app.layer_edit_id.as_deref() == Some(row.id.as_str());
            let shown = if editing {
                app.field.as_ref().unwrap().buffer.clone()
            } else {
                app.fonts
                    .truncate(&row.name, T11, Wt::Reg, max_nw.max(16.0))
            };
            if editing {
                // a real input box, so the edit state is unmistakable
                let er = Rect::new(nx - 4.0, r.y0 + 1.0, lw - 12.0, r.y1 - 1.0);
                fill_rrect(s, er, R_SM, C_FIELD);
                stroke_rrect(s, er, R_SM, C_ACCENT, 1.0);
            }
            app.fonts.text(
                s,
                nx,
                line_top(r, T11),
                &shown,
                T11,
                if selected || editing {
                    C_TEXT
                } else {
                    C_ZINC_400
                },
                Wt::Reg,
            );
            hit.push((r, Action::TreeRow(row.id.clone())));
            let name_zone = Rect::new(nx, r.y0, lw - 12.0, r.y1);
            hit.push((name_zone, Action::LayerRename(row.id.clone())));
            if let Some(cr) = chevron {
                hit.push((cr, Action::TreeToggle(row.id.clone())));
            }
            // Figma row toggles: eye / padlock on hover (persistent when
            // the state is on); they sit above the row hit (reversed scan)
            let (locked, hidden) = (row.locked, row.hidden);
            let row_hover = hover(app, r);
            if row_hover || hidden {
                let ey = Rect::new(lw - 8.0 - 34.0, r.y0 + 2.0, lw - 8.0 - 20.0, r.y1 - 2.0);
                draw_icon(
                    s,
                    if hidden { "eye-off" } else { "eye" },
                    glyph_left(ey, ICON_XS),
                    glyph_top(ey, ICON_XS),
                    ICON_XS,
                    if hidden { C_TEXT } else { C_DIM },
                );
                tip(app, ey, "Show / hide layer");
                hit.push((ey, Action::TreeVisible(row.id.clone())));
            }
            if row_hover || locked {
                let lr = Rect::new(lw - 8.0 - 18.0, r.y0 + 2.0, lw - 8.0 - 4.0, r.y1 - 2.0);
                draw_icon(
                    s,
                    "lock",
                    glyph_left(lr, ICON_XS),
                    glyph_top(lr, ICON_XS),
                    ICON_XS,
                    if locked { C_TEXT } else { C_DIM },
                );
                tip(app, lr, "Lock / unlock layer");
                hit.push((lr, Action::TreeLock(row.id.clone())));
            }
        }
    }
    tree_indent_guides(s, sx + 16.0, tree_top, last_bottom, max_indent);
    app.scaled = total_h > tree_bottom - tree_top;
}

/// Faint vertical guides at every indent depth below the root — the
/// hierarchy affordance that makes nesting scannable (drawn after the rows
/// so the guides sit over the section bands, like the reference tool).
fn tree_indent_guides(s: &mut Scene, base_x: f64, top: f64, bottom: f64, max_indent: usize) {
    if bottom <= top {
        return;
    }
    for k in 1..=max_indent.min(12) {
        vline(
            s,
            base_x + k as f64 * TREE_INDENT + 7.0,
            top,
            bottom,
            C_LINE,
        );
    }
}

struct RowRef {
    id: String,
    name: String,
    icon: &'static str,
    index: usize,
    indent: usize,
    has_children: bool,
    expanded: bool,
    selected: bool,
    locked: bool,
    hidden: bool,
    /// A frame/section container — the document's "sections" get a
    /// persistent header band in the paint layer.
    is_section: bool,
    /// P12: accepts child drops (frames & sections, empty or not).
    can_contain: bool,
}

/// Allocate only visible row metadata. In particular, don't clone vector paths
/// or shape text for the thousands of rows outside the panel's viewport.
fn collect_tree_rows(app: &App, scroll: f64, height: f64) -> (Vec<RowRef>, f64) {
    let Some(doc) = app.doc_opt() else {
        return (vec![], 0.0);
    };
    let pitch = TREE_ROW_H + 1.0;
    let first = ((scroll - TREE_ROW_H).max(0.0) / pitch).floor() as usize;
    let last = ((scroll + height.max(0.0)) / pitch).ceil() as usize;
    let selected: HashSet<&str> = doc
        .editor_ref()
        .selection
        .iter()
        .map(String::as_str)
        .collect();
    let mut out = Vec::with_capacity(last.saturating_sub(first).min(128) + 1);
    // F8: a non-empty query renders matches plus their ancestor chain
    let ql = doc.tree_search.trim().to_lowercase();
    let visible: Option<HashSet<&str>> = if ql.is_empty() {
        None
    } else {
        let mut found = HashSet::new();
        let mut path: Vec<&str> = Vec::new();
        let root = &doc.editor_ref().root;
        for c in &root.children {
            search_visible(c, &ql, &mut path, &mut found);
        }
        Some(found)
    };
    let mut index = 0;
    let mut stack = vec![(doc.editor_ref().root.children.iter(), 0usize)];
    while let Some((children, indent)) = stack.last_mut() {
        let Some(child) = children.next() else {
            stack.pop();
            continue;
        };
        let indent = *indent;
        let has = !child.children.is_empty();
        let expanded = has && doc.expanded.contains(&child.id);
        let shown = match &visible {
            Some(set) => set.contains(child.id.as_str()),
            None => true,
        };
        if !shown {
            continue;
        }
        if (first..=last).contains(&index) {
            out.push(RowRef {
                id: child.id.clone(),
                name: child.name.clone(),
                icon: kind_icon(&child.kind),
                index,
                indent,
                has_children: has,
                expanded,
                selected: selected.contains(child.id.as_str()),
                locked: child.locked,
                hidden: !child.visible,
                is_section: has && matches!(child.kind, NodeKind::Frame { .. } | NodeKind::Section),
                can_contain: matches!(child.kind, NodeKind::Frame { .. } | NodeKind::Section),
            });
        }
        index += 1;
        // while searching, descend past collapsed nodes too — matches
        // deeper than the current expansion must still surface
        if expanded || visible.is_some() {
            stack.push((child.children.iter(), indent + 1));
        }
    }
    (out, index as f64 * pitch)
}

/// P12: the tree band's geometry (top, bottom, scroll) — the single
/// source shared by paint and drag hit-testing, so drop targets can
/// never drift from the painted rows.
pub(crate) fn tree_geometry(app: &App) -> Option<(f64, f64, f64)> {
    if app.ui_minimized {
        return None;
    }
    let doc = app.doc_opt()?;
    let search_open = app.field.as_ref().map(|f| f.id) == Some(FieldId::TreeSearch)
        || !doc.tree_search.is_empty();
    let tree_top = app.pages_band_bottom() + 34.5 + if search_open { 30.0 } else { 0.0 };
    Some((tree_top, app.status_band().y0 - 16.0, doc.scroll_left))
}

/// P12: the drop target for a layers-tree row drag: the row under
/// `p`, its zone (0 before, 1 child, 2 after) and the tree coordinates
/// to commit. Frames/sections accept child drops in the middle band;
/// leaf rows split before/after at the midpoint. The dragged row and
/// its descendants are never targets.
pub fn tree_drop_target(app: &App, drag_id: &str, p: Point) -> Option<TreeDrop> {
    let doc = app.doc_opt()?;
    let (tree_top, tree_bottom, scroll) = tree_geometry(app)?;
    if p.y < tree_top || p.y >= tree_bottom {
        return None;
    }
    let (rows, _h) = collect_tree_rows(app, scroll, tree_bottom - tree_top);
    let pitch = TREE_ROW_H + 1.0;
    let subtree = subtree_ids(app, drag_id);
    for row in &rows {
        if row.id == drag_id || subtree.contains(row.id.as_str()) {
            continue;
        }
        let ry = tree_top + row.index as f64 * pitch - scroll;
        if p.y < ry || p.y > ry + TREE_ROW_H {
            continue;
        }
        let rel = (p.y - ry) / TREE_ROW_H;
        let zone = if row.can_contain && (0.3..0.7).contains(&rel) {
            1
        } else if rel < if row.can_contain { 0.3 } else { 0.5 } {
            0
        } else {
            2
        };
        let root = &doc.editor_ref().root;
        let (parent, index) = crate::state::tree_drop_coords(root, &row.id, zone)?;
        return Some(TreeDrop {
            row: row.id.clone(),
            zone,
            parent,
            index,
        });
    }
    None
}

/// P12: every id inside the subtree rooted at `id` (the root itself
/// excluded).
fn subtree_ids(app: &App, id: &str) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    let Some(doc) = app.doc_opt() else {
        return out;
    };
    let root = &doc.editor_ref().root;
    if let Some(n) = find_node_in(root, id) {
        walk_subtree(n, &mut out);
    }
    out
}

fn find_node_in<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
    if n.id == id {
        return Some(n);
    }
    n.children.iter().find_map(|c| find_node_in(c, id))
}

fn walk_subtree(n: &Node, out: &mut HashSet<String>) {
    for c in &n.children {
        out.insert(c.id.clone());
        walk_subtree(c, out);
    }
}

/// F8: record `node` and its path in `found` when it or any descendant
/// name contains the (lowercased) query.
fn search_visible<'e>(
    node: &'e Node,
    q: &str,
    path: &mut Vec<&'e str>,
    found: &mut HashSet<&'e str>,
) -> bool {
    path.push(node.id.as_str());
    let mut match_sub = node.name.to_lowercase().contains(q);
    for c in &node.children {
        if search_visible(c, q, path, found) {
            match_sub = true;
        }
    }
    if match_sub {
        found.extend(path.iter().copied());
    }
    path.pop();
    match_sub
}

/// 6px edge strips between canvas and panels — drags are handled
/// positionally by run.rs before hit dispatch; this only paints hover.
fn paint_resizers(app: &App, s: &mut Scene) {
    let reg = app.editor_regions();
    let lr = Rect::new(
        reg.sidebar.x1 - RESIZER_W / 2.0,
        ED_TITLE_H,
        reg.sidebar.x1 + RESIZER_W / 2.0,
        app.win_h,
    );
    let rr = Rect::new(
        reg.right.x0 - RESIZER_W / 2.0,
        ED_TITLE_H,
        reg.right.x0 + RESIZER_W / 2.0,
        app.win_h,
    );
    let l_drag = matches!(app.drag, Some(crate::state::Drag::LeftPanel { .. }));
    let r_drag = matches!(app.drag, Some(crate::state::Drag::RightPanel { .. }));
    // A divider that lights up on hover says "something is here"; a grip says
    // "drag me". The pill is centred on the seam and the seam itself takes the
    // accent while hovered or dragged, so the affordance reads at 1px.
    for (seam, hot) in [
        (reg.sidebar.x1, hover(app, lr) || l_drag),
        (reg.right.x0, hover(app, rr) || r_drag),
    ] {
        if !hot {
            continue;
        }
        fill_rect(
            s,
            Rect::new(seam - 0.75, ED_TITLE_H, seam + 0.75, app.win_h),
            C_SEL,
        );
        let grip = Rect::new(
            seam - 2.0,
            ED_TITLE_H + (app.win_h - ED_TITLE_H) / 2.0 - 20.0,
            seam + 2.0,
            ED_TITLE_H + (app.win_h - ED_TITLE_H) / 2.0 + 20.0,
        );
        fill_rrect(s, grip, R_PILL, C_SEL);
    }
}

// ------------------------------------------------------ right panel 340px

fn paint_right(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let rx = reg.right.x0;
    let rw = reg.right.x1 - reg.right.x0;
    fill_rect(s, reg.right, C_PANEL);
    vline(s, rx, ED_TITLE_H, app.win_h, C_LINE);

    // Audited at 1440 (rx=1100): avatar 24px at (1113,48..72) w/ 11px bold
    // initial; zoom 11px box top 51.8 at x 1145; icons 16px at y 52, right
    // edge 1428; pill-tabs container (1109, 86, 323, 30), items 24px at y 89.
    // header row: avatar + zoom% | message/history/play
    app.fonts.avatar(
        s,
        rx + 25.0,
        ED_TITLE_H + 24.0,
        12.0,
        C_AVATAR,
        T11,
        &app.user
            .chars()
            .next()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".into()),
    );
    // zoom% is the zoom menu (audit F4): in/out/100%/selection/fit in
    // one dropdown; the dead history button is gone (F5)
    let zoom_label = format!("{}%", (app.zoom * 100.0).round() as i64);
    let zoom_r = Rect::new(rx + 38.0, ED_TITLE_H + 7.0, rx + 92.0, ED_TITLE_H + 37.0);
    if hover(app, zoom_r) || app.dropdown_zoom {
        fill_rrect(s, zoom_r, R_MD, C_FIELD_2);
    }
    app.fonts.text(
        s,
        rx + 45.0,
        ED_TITLE_H + 15.8,
        &zoom_label,
        T11,
        if app.dropdown_zoom { C_TEXT } else { C_MUTED },
        Wt::Reg,
    );
    tip(app, zoom_r, "Zoom menu");
    hit.push((zoom_r, Action::ZoomMenu));
    let icons = ["message-circle", "play"];
    for (i, ic) in icons.iter().enumerate() {
        let ix = rx + rw - 56.0 + 28.0 * i as f64;
        let iy = ED_TITLE_H + 16.0;
        draw_icon(s, ic, ix, iy, ICON_MD, C_DIM);
        let icon_hit = Rect::new(ix - 2.0, iy - 2.0, ix + 18.0, iy + 18.0);
        match i {
            0 => {
                tip(app, icon_hit, "Comment tool");
                hit.push((icon_hit, Action::Tool(Tool::Comment)));
            }
            _ => {
                // Figma's toolbar has one ▶ and it PRESENTS. Ours opened the
                // Prototype tab and left the viewer to a button inside it — the
                // panel is still one click away on the FLOW pill.
                tip(app, icon_hit, "Present");
                hit.push((icon_hit, Action::FlowEnter));
            }
        }
    }

    // X-Native workflow tabs: COMPOSE / FLOW / SHIP / UX ANALYSIS
    let py = ED_TITLE_H + 50.0;
    let px0 = rx + 9.0;
    let pw = rw - 17.0;
    fill_rrect(s, Rect::new(px0, py, px0 + pw, py + 30.0), R_LG, C_BG);
    stroke_rrect(
        s,
        Rect::new(px0, py, px0 + pw, py + 30.0),
        R_LG,
        C_LINE,
        1.0,
    );
    let item_w = (pw - 6.0 - 4.0) / 4.0;
    let tabs = [
        // Right inspector is an X-Native workflow: compose the scene,
        // route it through interactive flows, then ship an artifact.
        (RightTab::Design, "COMPOSE"),
        (RightTab::Prototype, "FLOW"),
        (RightTab::Inspect, "SHIP"),
        (RightTab::UX, "UX ANALYSIS"),
    ];
    for (i, (tab, label)) in tabs.into_iter().enumerate() {
        let ix = px0 + 3.0 + (item_w + 2.0) * i as f64;
        let ir = Rect::new(ix, py + 3.0, ix + item_w, py + 27.0);
        let active = app.doc().right_tab == tab;
        if active {
            fill_rrect(s, ir, R_PILL, C_FIELD_2);
            stroke_rrect(s, ir, R_PILL, C_LINE_2, 1.0);
        }
        app.fonts.text_center(
            s,
            ir,
            label,
            T10,
            if active { C_TEXT } else { C_DIM },
            Wt::Semi,
            true,
        );
        hit.push((ir, Action::RightTab(tab)));
    }
    let y = ED_TITLE_H + 88.0;
    hline(s, rx, rx + rw, y, C_LINE);
    let y = y + 1.0;

    // The HTML panel scrolls its content UNDER the pinned header (X/Y,
    // pill tabs, divider) — clip the scrolling region so scrolled rows
    // never overdraw the chrome, and drop hit rects that left the view.
    let clip = Rect::new(rx, y, reg.right.x1, reg.right.y1);
    let hit0 = hit.len();
    s.push_layer(
        vello::peniko::Fill::NonZero,
        vello::peniko::BlendMode::new(vello::peniko::Mix::Normal, vello::peniko::Compose::SrcOver),
        1.0,
        vello::kurbo::Affine::IDENTITY,
        &clip,
    );
    match app.doc().right_tab {
        RightTab::Design => paint_design(app, s, hit, rx, rw, y),
        RightTab::Prototype => paint_prototype(app, s, hit, rx, rw, y),
        RightTab::Inspect => paint_inspect(app, s, hit, rx, rx + rw, y),
        RightTab::UX => paint_ux_analysis(app, s, hit, rx, rw, y),
    }
    let added = hit.split_off(hit0);
    hit.extend(
        added.into_iter().filter(|(r, _)| {
            r.x0 >= clip.x0 && r.x1 <= clip.x1 && r.y0 >= clip.y0 && r.y1 <= clip.y1
        }),
    );
    s.pop_layer();
}

/// Values of the current selection (or sensible defaults) for the inspector.
pub struct Sel {
    pub is_frame: bool,
    pub name: String,
    pub w: f64,
    pub h: f64,
    pub x: f64,
    pub y: f64,
    pub rot: f64,
    pub opacity: f32,
    pub radius: f64,
    pub fill: String,
    pub stroke: String,
    pub stroke_w: f64,
    pub clip: bool,
    /// Figma's Layer → "Show name": whether the canvas paints this frame's name.
    pub show_name: bool,
}

pub fn sel_info(app: &App) -> Sel {
    let doc = app.doc_opt().unwrap();
    let vars = &doc.doc.variables;
    let Some(id) = doc.selected_id() else {
        return Sel {
            is_frame: false,
            name: "Page".into(),
            w: 0.0,
            h: 0.0,
            x: 0.0,
            y: 0.0,
            rot: 0.0,
            opacity: 1.0,
            radius: 0.0,
            fill: "FFFFFF".into(),
            stroke: "000000".into(),
            stroke_w: 0.0,
            clip: false,
            show_name: true,
        };
    };
    let root = &doc.editor_ref().root;
    let Some(n) = find_node(root, &id) else {
        return Sel {
            is_frame: false,
            name: "Page".into(),
            w: 0.0,
            h: 0.0,
            x: 0.0,
            y: 0.0,
            rot: 0.0,
            opacity: 1.0,
            radius: 0.0,
            fill: "FFFFFF".into(),
            stroke: "000000".into(),
            stroke_w: 0.0,
            clip: false,
            show_name: true,
        };
    };
    let radius = n.corner_radii.map(|c| c[0]).unwrap_or(match n.kind {
        NodeKind::Rect { radius } => radius,
        _ => 0.0,
    });
    let clip = matches_frame_clip(n);
    let show_name = n.show_name;
    Sel {
        is_frame: matches!(n.kind, NodeKind::Frame { .. }),
        name: n.name.clone(),
        w: n.w,
        h: n.h,
        x: n.transform.x,
        y: n.transform.y,
        rot: n.transform.rotation.to_degrees(),
        opacity: n.opacity,
        radius,
        fill: crate::state::node_fill_hex(n, vars),
        stroke: crate::state::node_stroke_hex(n, vars),
        stroke_w: if !n.stroke_layers.is_empty() {
            n.stroke_layers[0].stroke.width
        } else {
            n.stroke.width
        },
        clip,
        show_name,
    }
}

fn matches_frame_clip(n: &Node) -> bool {
    matches!(n.kind, NodeKind::Frame { .. }) && n.overflow.clips()
}

/// True when a node's transform is more than a translation — i.e. its box on
/// screen is a rotated / skewed / scaled QUAD, not an axis-aligned rectangle.
/// The renderer already draws it that way (`transform.matrix`); the selection
/// outline, the corner handles and the resize grab all have to agree, or a
/// rotated shape shows a box that is nowhere near the shape.
pub fn is_transformed(n: &Node) -> bool {
    let t = &n.transform;
    t.rotation.abs() > 1e-9
        || t.skew_x.abs() > 1e-9
        || t.skew_y.abs() > 1e-9
        || (t.scale_x - 1.0).abs() > 1e-9
        || (t.scale_y - 1.0).abs() > 1e-9
}

pub fn find_node<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
    if n.id == id {
        return Some(n);
    }
    for c in &n.children {
        if let Some(f) = find_node(c, id) {
            return Some(f);
        }
    }
    None
}

fn fmt_num(v: f64) -> String {
    let r = v.round();
    if (v - r).abs() < 0.005 {
        format!("{}", r as i64)
    } else {
        format!("{v:.1}")
    }
}

/// text-entry display value for a field (shows the editing buffer while active)
/// Which typography value to read from the selected Text node.
pub enum Typo {
    Family,
    Weight,
    Size,
    LineHeight,
    LetterSpacing,
    WordSpacing,
    ParaSpacing,
    BaselineShift,
    TextCase,
    OpticalSize,
    WidthAxis,
    MaxLines,
    ParagraphIndent,
}

/// px or integer formatter: trims to whole numbers when close.
fn num_str(v: f64, unit: &str) -> String {
    if (v - v.round()).abs() < 0.05 {
        format!("{}{unit}", v.round() as i64)
    } else {
        format!("{v:.1}{unit}")
    }
}

/// Live typography value for the selected Text node; HTML-spec defaults
/// when nothing (or a non-text node) is selected — pixel parity with the
/// v45 mock is preserved for every non-text state.
pub fn typo_val(app: &App, which: Typo) -> String {
    // P3: the fallback family is the document's default font (per-file
    // data), not a constant — a file can carry any default typeface
    let default_family = app.doc_ref().doc.resolved_default_font();
    let Some(t) = app.selected_text_typo() else {
        return match which {
            Typo::Family => default_family.to_string(),
            Typo::Weight => "Regular".into(),
            Typo::Size => "14".into(),
            Typo::LineHeight => "20".into(),
            Typo::LetterSpacing => "-0.16px".into(),
            Typo::WordSpacing => "0px".into(),
            Typo::ParaSpacing => "0px".into(),
            Typo::BaselineShift => "0px".into(),
            Typo::TextCase => "None".into(),
            Typo::OpticalSize => "Auto".into(),
            Typo::WidthAxis => "Auto".into(),
            Typo::MaxLines => "Auto".into(),
            Typo::ParagraphIndent => "0px".into(),
        };
    };
    match which {
        Typo::Family => t.font.unwrap_or_else(|| default_family.to_string()),
        Typo::Weight => weight_name(t.fw).to_string(),
        Typo::Size => num_str(t.fs, ""),
        Typo::LineHeight => match t.lh_mode {
            1 => num_str(t.lh_value, ""),
            2 => format!("{}%", num_str(t.lh_value, "")),
            _ => {
                let px = t.lh * app.natural_line_height(t.fs);
                num_str(px, "")
            }
        },
        Typo::LetterSpacing => num_str(t.ls, "px"),
        Typo::WordSpacing => num_str(t.ws, "px"),
        Typo::ParaSpacing => num_str(t.ps, "px"),
        Typo::BaselineShift => num_str(t.bs, "px"),
        Typo::TextCase => match t.tc.as_str() {
            "upper" => "Upper".into(),
            "lower" => "Lower".into(),
            "title" => "Title".into(),
            "sc" => "Small caps".into(),
            _ => "None".into(),
        },
        Typo::OpticalSize => {
            if t.opsz > 0.0 {
                num_str(t.opsz as f64, "")
            } else {
                "Auto".into()
            }
        }
        Typo::WidthAxis => {
            if t.width_axis > 0.0 {
                num_str(t.width_axis as f64, "")
            } else {
                "Auto".into()
            }
        }
        Typo::MaxLines => t
            .max_lines
            .map(|v| v.to_string())
            .unwrap_or_else(|| "Auto".into()),
        Typo::ParagraphIndent => num_str(t.paragraph_indent, "px"),
    }
}

/// CSS weight number -> the inspector's display name.
fn weight_name(w: u16) -> &'static str {
    match w {
        100 => "Thin",
        200 => "ExtraLight",
        300 => "Light",
        500 => "Medium",
        600 => "SemiBold",
        700 => "Bold",
        800 => "ExtraBold",
        900 => "Black",
        _ => "Regular",
    }
}

fn field_val(app: &App, id: FieldId, fallback: String) -> String {
    if let Some(f) = &app.field {
        if f.id == id {
            return f.buffer.clone();
        }
    }
    fallback
}

#[allow(clippy::too_many_arguments)]
fn input(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    r: Rect,
    label: Option<(&str, f64)>, // (text, size)
    value: &str,
    mono: bool,
    action: Option<Action>,
    right_icon: Option<&str>,
) {
    let hov = hover(app, r);
    fill_rrect(s, r, R_INPUT, if hov { C_INPUT_HOVER } else { C_FIELD });
    if hov {
        stroke_rrect(s, r, R_INPUT, C_LINE_2, 1.0);
    }
    let mut tx = r.x0 + 8.0;
    if let Some((text, size)) = label {
        // center the CSS line box (1.5em), like flex align-items:center —
        // audit: T10 label box top +6.5 inside the 28px field
        let ty = r.y0 + (INPUT_H.min(r.y1 - r.y0) - size * CSS_LH) / 2.0;
        app.fonts.text(s, tx, ty, text, size, C_DIM, Wt::Reg);
        // T10 labels sit in a fixed w-4 slot (span.w-4) then ~4px to the value
        tx += if (size - T10).abs() < 0.01 {
            16.0 + 4.4
        } else {
            app.fonts.measure(text, size, Wt::Reg) + 6.0
        };
    }
    let wt = if mono { Wt::Mono } else { Wt::Reg };
    // audit: 11px value box top +5.75 inside the 28px field
    let vh = T11 * CSS_LH;
    let vy = r.y0 + (r.y1 - r.y0 - vh) / 2.0;
    // A mono value is a measurement (W/H/X/Y). Measurements go on the field's
    // right edge — minus the icon slot when the field ends in one — so a column
    // of them shares a right edge and can be compared at a glance instead of
    // after reading each one. Text fields keep the left-aligned run from the
    // label, because a name is read from where it starts.
    if mono {
        let pad = if right_icon.is_some() { 28.0 } else { 8.0 };
        app.fonts
            .text_right(s, r.x1, vy, value, T11, C_TEXT, wt, pad);
    } else {
        app.fonts.text(s, tx, vy, value, T11, C_TEXT, wt);
    }
    if let Some(ic) = right_icon {
        draw_icon(
            s,
            ic,
            r.x1 - 8.0 - 12.0,
            r.y0 + (r.y1 - r.y0 - 12.0) / 2.0,
            ICON_XS,
            C_DIM,
        );
    }
    if let Some(a) = action {
        hit.push((r, a));
    }
}

fn sq_btn(
    app: &mut App,
    s: &mut Scene,
    _hit: &mut [(Rect, Action)],
    x: f64,
    y: f64,
    icon: &str,
    dimmed: bool,
) {
    let r = Rect::new(x, y, x + SQ_BTN, y + SQ_BTN);
    let hov = hover(app, r) && !dimmed;
    fill_rrect(s, r, R_LG, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, r, R_LG, C_LINE, 1.0);
    if !dimmed {
        draw_icon(
            s,
            icon,
            x + (SQ_BTN - 14.0) / 2.0,
            y + (SQ_BTN - 14.0) / 2.0,
            ICON_SM,
            C_DIM,
        );
    }
}

/// hex string (no '#', lowercase) for the DESIGN-panel color fields
pub fn hex6(c: vello::peniko::Color) -> String {
    format!(
        "{:02x}{:02x}{:02x}",
        (c.components[0] * 255.0).round() as u8,
        (c.components[1] * 255.0).round() as u8,
        (c.components[2] * 255.0).round() as u8
    )
}

/// DESIGN tab with nothing selected: canvas background + pixel grid
/// controls (per the design's empty-state panel).
fn paint_design_empty(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    x0: f64,
    xr: f64,
    y0: f64,
) {
    let pct_w = 64.0;

    // CANVAS BACKGROUND
    app.fonts
        .micro_label(s, x0, y0 + 14.0, "CANVAS BACKGROUND", C_DIM, Wt::Med);
    // P13: canvas background gains opacity % + visibility (Figma parity),
    // mirroring the pixel-grid row layout below
    let f1 = Rect::new(x0, y0 + 30.0, xr - pct_w - 8.0, y0 + 58.0);
    input_box(app, s, f1, R_INPUT);
    fill_rrect(
        s,
        Rect::new(x0 + 8.0, y0 + 37.0, x0 + 22.0, y0 + 51.0),
        R_SM,
        app.canvas_bg,
    );
    stroke_rrect(
        s,
        Rect::new(x0 + 8.0, y0 + 37.0, x0 + 22.0, y0 + 51.0),
        R_SM,
        C_LINE_2,
        1.0,
    );
    let bg_hex = field_val(app, FieldId::CanvasBg, hex6(app.canvas_bg));
    app.fonts
        .text(s, x0 + 30.0, y0 + 37.8, &bg_hex, T11, C_TEXT, Wt::Mono);
    hit.push((f1, Action::Field(FieldId::CanvasBg)));
    let bg_alpha = field_val(
        app,
        FieldId::CanvasBgAlpha,
        format!("{}", app.canvas_bg_alpha.round() as i64),
    );
    let fa = Rect::new(xr - pct_w, y0 + 30.0, xr, y0 + 58.0);
    input_box(app, s, fa, R_INPUT);
    app.fonts
        .text(s, fa.x0 + 9.0, y0 + 36.5, "%", T10, C_DIM, Wt::Reg);
    app.fonts
        .text_right(s, fa.x1, y0 + 37.8, &bg_alpha, T11, C_TEXT, Wt::Mono, 8.0);
    hit.push((fa, Action::Field(FieldId::CanvasBgAlpha)));
    let eye = Rect::new(f1.x1 - 24.0, f1.y0 + 6.0, f1.x1 - 6.0, f1.y1 - 6.0);
    if hover(app, eye) {
        fill_rrect(s, eye, R_SM, C_FIELD_2);
    }
    let eye_name = if app.canvas_bg_visible {
        "eye"
    } else {
        "eye-off"
    };
    let eye_col = if app.canvas_bg_visible { C_TEXT } else { C_DIM };
    draw_icon(s, eye_name, eye.x0 + 1.0, f1.y0 + 8.0, ICON_XS, eye_col);
    tip(app, eye, "Show / hide canvas background");
    hit.push((eye, Action::ToggleCanvasBgVisibility));

    // PIXEL GRID COLOR
    app.fonts
        .micro_label(s, x0, y0 + 74.0, "PIXEL GRID COLOR", C_DIM, Wt::Med);
    let f2 = Rect::new(x0, y0 + 90.0, xr - pct_w - 8.0, y0 + 118.0);
    input_box(app, s, f2, R_INPUT);
    fill_rrect(
        s,
        Rect::new(f2.x0 + 8.0, y0 + 97.0, f2.x0 + 22.0, y0 + 111.0),
        R_SM,
        app.grid_color,
    );
    stroke_rrect(
        s,
        Rect::new(f2.x0 + 8.0, y0 + 97.0, f2.x0 + 22.0, y0 + 111.0),
        R_SM,
        C_LINE_2,
        1.0,
    );
    let grid_hex = field_val(app, FieldId::GridColor, hex6(app.grid_color));
    app.fonts
        .text(s, f2.x0 + 30.0, y0 + 97.8, &grid_hex, T11, C_TEXT, Wt::Mono);
    hit.push((f2, Action::Field(FieldId::GridColor)));

    // opacity % field (same widget pattern as the zoom % field)
    let f3 = Rect::new(xr - pct_w, y0 + 90.0, xr, y0 + 118.0);
    input_box(app, s, f3, R_INPUT);
    app.fonts
        .text(s, f3.x0 + 9.0, y0 + 96.5, "%", T10, C_DIM, Wt::Reg);
    let pct_val = field_val(
        app,
        FieldId::GridPct,
        format!("{}", app.grid_pct.round() as i64),
    );
    app.fonts
        .text_right(s, f3.x1, y0 + 95.8, &pct_val, T11, C_TEXT, Wt::Mono, 8.0);
    hit.push((f3, Action::Field(FieldId::GridPct)));
}

fn paint_design(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    rx: f64,
    rw: f64,
    y_entry: f64,
) {
    // Absolute geometry, hand-tuned against a 1440px-wide reference
    // composition. `y_entry` is the pixel right after the pill-tabs divider
    // (abs 125); all offsets below are entry-relative, so the panel holds at
    // any window size.
    let scroll = app.doc().scroll_right;
    let y0 = y_entry - scroll;
    let pl = 12.0;
    let x0 = rx + pl + 1.0; // 1113 @1440: 1px panel border + 12px padding
    if app.doc().editor_ref().selection.is_empty() {
        app.paint_lib = None;
        paint_design_empty(app, s, hit, x0, rx + rw - pl, y0);
        return;
    }
    let sel = sel_info(app);
    let xr = rx + rw - pl; // 1428
    let gap = 8.0;
    let h = INPUT_H; // 28
    let mono = true;

    // ---- size & position rows: +12 / +48 / +84 / +120 (pitch 36) -------
    let r1 = y0 + 12.0;
    let fd = Rect::new(x0, r1, x0 + 145.0, r1 + h);
    let preset_name = FRAME_PRESETS[app.doc().frame_preset].0;
    input(
        app,
        s,
        hit,
        fd,
        None,
        &if sel.is_frame {
            sel.name.clone()
        } else {
            preset_name.to_string()
        },
        false,
        Some(Action::FrameDropdown),
        Some("chevron-down"),
    );
    // % field: label left, value right (justify-between per the HTML)
    let pct = Rect::new(x0 + 153.0, r1, x0 + 243.0, r1 + h);
    input_box(app, s, pct, R_INPUT);
    app.fonts
        .text(s, pct.x0 + 9.0, r1 + 6.5, "%", T10, C_DIM, Wt::Reg);
    // justify-between: label left ('%' box at +9), value right, chevron right
    let pct_val = field_val(
        app,
        FieldId::Zoom,
        format!("{}", (app.zoom * 100.0).round()),
    );
    // ml-auto, like Opacity/Radius: the value hugs the right edge, stopping
    // short of the chevron (icon left at x1 − 21)
    app.fonts.text_right(
        s,
        pct.x1 - 21.0,
        r1 + 5.8,
        &pct_val,
        T11,
        C_TEXT,
        Wt::Mono,
        4.0,
    );
    hit.push((pct, Action::Field(FieldId::Zoom)));
    // chevron: audited ink 1337-1344 → icon left = field right − 21
    draw_icon(s, "chevron-down", pct.x1 - 21.0, r1 + 8.0, ICON_XS, C_DIM);
    sq_btn(app, s, hit, x0 + 251.0, r1, "eye", false);
    hit.push((
        Rect::new(x0 + 251.0, r1, x0 + 251.0 + SQ_BTN, r1 + SQ_BTN),
        Action::ToggleVisible,
    ));
    sq_btn(app, s, hit, x0 + 287.0, r1, "lock", false);
    hit.push((
        Rect::new(x0 + 287.0, r1, x0 + 287.0 + SQ_BTN, r1 + SQ_BTN),
        Action::ToggleLock,
    ));

    let r2 = y0 + 48.0;
    let half = 135.5;
    let wr = Rect::new(x0, r2, x0 + half, r2 + h);
    input(
        app,
        s,
        hit,
        wr,
        Some(("W", T10)),
        &field_val(app, FieldId::W, fmt_num(sel.w)),
        mono,
        Some(Action::Field(FieldId::W)),
        None,
    );
    let hr = Rect::new(x0 + 143.5, r2, x0 + 143.5 + half, r2 + h);
    input(
        app,
        s,
        hit,
        hr,
        Some(("H", T10)),
        &field_val(app, FieldId::H, fmt_num(sel.h)),
        mono,
        Some(Action::Field(FieldId::H)),
        None,
    );
    let aspect_lock = Rect::new(x0 + 287.0, r2, x0 + 287.0 + SQ_BTN, r2 + SQ_BTN);
    sq_btn(app, s, hit, aspect_lock.x0, aspect_lock.y0, "lock", false);
    if app.aspect_ratio_locked {
        fill_rrect(s, aspect_lock, R_LG, C_FIELD_2);
        draw_icon(
            s,
            "lock",
            aspect_lock.x0 + 7.0,
            aspect_lock.y0 + 7.0,
            ICON_SM,
            C_TEXT,
        );
    }
    hit.push((aspect_lock, Action::ToggleAspectRatio));

    let r3 = y0 + 84.0;
    let xr3 = Rect::new(x0, r3, x0 + half, r3 + h);
    input(
        app,
        s,
        hit,
        xr3,
        Some(("X", T10)),
        &field_val(app, FieldId::X, fmt_num(sel.x)),
        mono,
        Some(Action::Field(FieldId::X)),
        None,
    );
    let yr3 = Rect::new(x0 + 143.5, r3, x0 + 143.5 + half, r3 + h);
    input(
        app,
        s,
        hit,
        yr3,
        Some(("Y", T10)),
        &field_val(app, FieldId::Y, fmt_num(sel.y)),
        mono,
        Some(Action::Field(FieldId::Y)),
        None,
    );
    // third slot is an `opacity-0` spacer in the HTML — nothing drawn

    let r4 = y0 + 120.0;
    let rr = Rect::new(x0, r4, x0 + 140.0, r4 + h);
    input_box(app, s, rr, R_INPUT);
    draw_icon(s, "rotate-cw", rr.x0 + 8.0, r4 + 8.0, ICON_XS, C_DIM);
    let rot_val = field_val(app, FieldId::Rotation, fmt_num(sel.rot));
    app.fonts
        .text_right(s, rr.x1, r4 + 5.8, &rot_val, T11, C_TEXT, Wt::Mono, 8.0);
    hit.push((rr, Action::Field(FieldId::Rotation)));

    hline(s, rx, rx + rw, y0 + 160.0, C_LINE);

    // ---- auto layout: container +161 ------------------------------------
    // Section header row (28): label vertically centered, add button on the
    // standard SQ_BTN square.
    app.fonts
        .text(s, x0, y0 + 179.5, "Auto layout", T11, C_TEXT, Wt::Med);
    let addb = Rect::new(xr - 24.0, y0 + 172.0, xr, y0 + 200.0);
    let hov = hover(app, addb);
    fill_rrect(s, addb, R_MD, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, addb, R_MD, C_LINE, 1.0);
    draw_icon(s, "plus", addb.x0 + 5.0, addb.y0 + 7.0, ICON_SM, C_DIM);
    // The add button must create the same default layout that the Flow
    // controls edit; previously it was painted without a hit target.
    hit.push((addb, Action::AddAutoLayout));

    app.fonts
        .text(s, x0, y0 + 208.0, "Flow", T10, C_DIM, Wt::Reg);
    let flow_xs = [0.0, 80.3, 160.5, 240.8];
    let flow = app.doc().flow;
    let boot_mock = app.doc().flow_boot_mock;
    for (i, &fxs) in flow_xs.iter().enumerate() {
        let fx = x0 + fxs;
        let fr = Rect::new(fx, y0 + 226.0, fx + 74.3, y0 + 254.0);
        let active = flow == i || (boot_mock && matches!(i, 0 | 2));
        let hov = hover(app, fr);
        fill_rrect(
            s,
            fr,
            R_LG,
            if active {
                C_FIELD_2
            } else if hov {
                C_INPUT_HOVER
            } else {
                C_FIELD
            },
        );
        stroke_rrect(
            s,
            fr,
            R_LG,
            if active || hov { C_LINE_2 } else { C_LINE },
            1.0,
        );
        let (gw, gh) = match i {
            0 => (18.0, 14.0),
            1 => (14.0, 18.0),
            2 => (18.0, 14.0),
            _ => (16.0, 16.0),
        };
        draw_flow_glyph(
            s,
            i,
            fr.x0 + (74.3 - gw) / 2.0,
            fr.y0 + (28.0 - gh) / 2.0,
            if active { C_TEXT } else { C_DIM },
        );
        hit.push((fr, Action::FlowBtn(i)));
    }

    app.fonts
        .text(s, x0, y0 + 262.0, "Resizing", T10, C_DIM, Wt::Reg);
    // axis sizing is REAL for auto-layout frames (A5): W chip = main axis
    // when horizontal (cross when vertical), H chip the other; click
    // toggles Hug <-> Fixed. Non-layout frames keep the mock's static chip.
    let sel_layout = app.selected_layout();
    let horizontal = sel_layout
        .as_ref()
        .map(|l| l.direction == x_native::LayoutDirection::Horizontal)
        .unwrap_or(true);
    let main_sizing = sel_layout.as_ref().map(|l| l.sizing);
    let cross_sizing = sel_layout
        .as_ref()
        .map(|l| l.cross_sizing.unwrap_or(l.sizing));
    for (i, (axis, val)) in [("W", fmt_num(sel.w)), ("H", fmt_num(sel.h))]
        .into_iter()
        .enumerate()
    {
        let fx = x0 + 141.5 * i as f64;
        let fr = Rect::new(fx, y0 + 280.0, fx + 133.5, y0 + 308.0);
        input_box(app, s, fr, 8.0);
        app.fonts
            .text(s, fx + 9.0, y0 + 289.3, axis, T10, C_DIM, Wt::Reg);
        // value stops before the Hug/Fixed chip (chip x0 = fx + 93.5)
        app.fonts
            .text_right(s, fx + 93.5, y0 + 287.8, &val, T11, C_TEXT, Wt::Mono, 6.0);
        // sizing chip: standard CHIP_H, centered in the row
        let chip = Rect::new(fx + 93.5, y0 + 286.0, fx + 124.5, y0 + 286.0 + CHIP_H);
        let is_main = (i == 0) == horizontal;
        let sizing = if is_main { main_sizing } else { cross_sizing };
        let (label, enabled) = match sizing {
            Some(s) => (
                match s {
                    x_native::Sizing::Hug => "Hug",
                    _ => "Fixed",
                },
                true,
            ),
            None => ("Hug", false),
        };
        let chov = enabled && hover(app, chip);
        fill_rrect(s, chip, R_SM, if chov { C_INPUT_HOVER } else { C_FIELD_2 });
        stroke_rrect(s, chip, R_SM, C_LINE_2, 1.0);
        app.fonts
            .text_center(s, chip, label, T10, C_TEXT, Wt::Reg, true);
        if enabled {
            hit.push((
                chip,
                if is_main {
                    Action::ToggleMainSizing
                } else {
                    Action::ToggleCrossSizing
                },
            ));
        }
    }
    app.fonts
        .text(s, x0, y0 + 316.0, "Alignment", T10, C_DIM, Wt::Reg);
    app.fonts
        .text_right(s, xr, y0 + 316.0, "Gap", T10, C_DIM, Wt::Reg, 0.0);
    // 9-dot alignment card 84×84 at +334
    let card = Rect::new(x0, y0 + 334.0, x0 + 84.0, y0 + 418.0);
    fill_rrect(s, card, R_XL, C_FIELD);
    stroke_rrect(s, card, R_XL, C_LINE, 1.0);
    hline(s, card.x0 + 12.0, card.x1 - 12.0, card.y0 + 42.0, C_LINE_2);
    vline(s, card.x0 + 42.0, card.y0 + 12.0, card.y1 - 12.0, C_LINE_2);
    // clicking a dot aligns the selection (col: L/C/R, row: T/M/B) and
    // becomes the active pair (mirrors the mock's two active dots)
    let align = app.align;
    for row in 0..3 {
        for col in 0..3 {
            let dx = card.x0 + 13.5 + col as f64 * 28.0;
            let dy = card.y0 + 13.5 + row as f64 * 28.0;
            let active = align.0 == row && align.1 == col;
            let mirror = col == 0 && align.0 == row && align.1 == 2;
            if active || mirror {
                circle(s, dx, dy, 9.0, C_WHITE_10);
            }
            circle(
                s,
                dx,
                dy,
                4.0,
                if active || mirror { C_TEXT } else { C_DIM },
            );
            let hitr = Rect::new(dx - 10.0, dy - 10.0, dx + 10.0, dy + 10.0);
            hit.push((hitr, Action::Align(row, col)));
        }
    }
    // gap column: two INPUT_H fields at x0+96
    let gx = x0 + 96.0;
    let g1 = Rect::new(gx, y0 + 334.0, gx + 219.0, y0 + 362.0);
    input_box(app, s, g1, 8.0);
    draw_icon(
        s,
        "arrow-left-right",
        g1.x0 + 8.0,
        g1.y0 + 8.0,
        ICON_XS,
        C_DIM,
    );
    let gap_now = app.doc().gap;
    let gap_val = field_val(app, FieldId::Gap, fmt_num(gap_now));
    app.fonts.text_right(
        s,
        g1.x1 - 20.0,
        g1.y0 + 4.8,
        &gap_val,
        T11,
        C_TEXT,
        Wt::Reg,
        6.0,
    );
    draw_icon(s, "chevron-down", g1.x1 - 20.0, g1.y0 + 8.0, ICON_XS, C_DIM);
    hit.push((g1, Action::Field(FieldId::Gap)));
    let g2 = Rect::new(gx, y0 + 370.0, gx + 219.0, y0 + 398.0);
    input_box(app, s, g2, 8.0);
    draw_icon(s, "arrow-up-down", g2.x0 + 8.0, g2.y0 + 8.0, ICON_XS, C_DIM);
    // The second gap axis was previously a decorative empty field. Both
    // axes use the engine's single Auto Layout gap value until independent
    // row/column gaps are supported.
    app.fonts
        .text_right(s, g2.x1, g2.y0 + 4.8, &gap_val, T11, C_TEXT, Wt::Reg, 8.0);
    hit.push((g2, Action::Field(FieldId::Gap)));

    app.fonts
        .text(s, x0, y0 + 458.0, "Padding", T10, C_DIM, Wt::Reg);
    for (i, (fid, val)) in [
        (FieldId::PadH, app.doc().pad_h),
        (FieldId::PadV, app.doc().pad_v),
    ]
    .into_iter()
    .enumerate()
    {
        let fx = x0 + 141.5 * i as f64;
        let pr = Rect::new(fx, y0 + 476.0, fx + 133.5, y0 + 504.0);
        input_box(app, s, pr, 8.0);
        let g = Rect::new(pr.x0 + 9.0, pr.y0 + 6.0, pr.x0 + 25.0, pr.y0 + 6.0 + CHIP_H);
        stroke_rrect(s, g, R_SM, C_DIM, 1.0);
        if i == 0 {
            vline(s, g.x0 + 5.0, g.y0 + 3.0, g.y1 - 3.0, C_DIM);
            vline(s, g.x1 - 5.0, g.y0 + 3.0, g.y1 - 3.0, C_DIM);
        } else {
            hline(s, g.x0 + 3.0, g.x1 - 3.0, g.y0 + 5.0, C_DIM);
            hline(s, g.x0 + 3.0, g.x1 - 3.0, g.y1 - 5.0, C_DIM);
        }
        let v = field_val(app, fid, fmt_num(val));
        app.fonts
            .text_right(s, pr.x1, pr.y0 + 4.8, &v, T11, C_TEXT, Wt::Reg, 8.0);
        hit.push((pr, Action::Field(fid)));
    }

    // ---- A3/A4 row: Wrap (frame WITH auto-layout) or, for a CHILD of
    // an auto-layout frame, Fill container + Absolute position. Progressive
    // disclosure (P0-8): these are the layout section's ADVANCED rows, so
    // the band shows an "Advanced" toggle until the user opens it. When
    // open, the chevron at the band's right edge collapses it again.
    let band = Rect::new(x0, y0 + 426.0, x0 + 315.0, y0 + 426.0 + DENSE_H);
    let has_advanced = sel_layout.is_some() || app.selected_parent_has_layout();
    let lav_open = app.layout_advanced_open;
    if has_advanced && !lav_open {
        let hov = hover(app, band);
        draw_icon(
            s,
            "chevron-right",
            band.x0 + 1.0,
            band.y0 + 6.0,
            ICON_XS,
            C_DIM,
        );
        app.fonts.text(
            s,
            band.x0 + 20.0,
            band.y0 + 5.0,
            "Advanced",
            T10,
            if hov { C_TEXT } else { C_DIM },
            Wt::Reg,
        );
        hit.push((band, Action::ToggleLayoutAdvanced));
    } else if has_advanced {
        if lav_open {
            // collapse affordance at the band's right edge (the row's
            // controls keep their own hit targets)
            draw_icon(
                s,
                "chevron-down",
                band.x1 - 14.0,
                band.y0 + 6.0,
                ICON_XS,
                C_DIM,
            );
            hit.push((
                Rect::new(band.x1 - 18.0, band.y0, band.x1, band.y1),
                Action::ToggleLayoutAdvanced,
            ));
        }
        if sel_layout.is_some() {
            let wrapping = sel_layout
                .as_ref()
                .map(|l| l.wrap == x_native::AutoLayoutWrap::Wrap)
                .unwrap_or(false);
            let wb = Rect::new(x0, y0 + 430.0, x0 + CHIP_H, y0 + 430.0 + CHIP_H);
            fill_rrect(s, wb, R_SM, C_FIELD);
            stroke_rrect(s, wb, R_SM, C_LINE_2, 1.0);
            if wrapping {
                fill_rrect(s, wb.inflate(-3.0, -3.0), R_XS, C_TEXT);
            }
            app.fonts
                .text(s, wb.x1 + 8.0, y0 + 429.7, "Wrap", T11, C_MUTED, Wt::Reg);
            hit.push((
                Rect::new(x0, y0 + 426.0, x0 + 110.0, y0 + 450.0),
                Action::ToggleWrap,
            ));
        } else if app.selected_parent_has_layout() {
            // Fixed | Fill segmented control (constraints.grow)
            let grow = {
                let d = app.doc();
                d.selected_id()
                    .and_then(|id| {
                        fn find_con(
                            n: &x_native::Node,
                            id: &str,
                        ) -> Option<x_native::ChildConstraints> {
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
                        find_con(&d.editor_ref().root, &id)
                    })
                    .map(|c| c.grow >= 1.0)
                    .unwrap_or(false)
            };
            let seg = Rect::new(x0, y0 + 426.0, x0 + 150.0, y0 + 426.0 + DENSE_H);
            let half = Rect::new(seg.x0, seg.y0, seg.x0 + 74.0, seg.y1);
            let other = Rect::new(half.x1, seg.y0, seg.x1, seg.y1);
            for (rr, lab, active, act) in [
                (half, "Fixed", !grow, Action::SetChildFill(false)),
                (other, "Fill", grow, Action::SetChildFill(true)),
            ] {
                fill_rrect(s, rr, R_MD, if active { C_FIELD_2 } else { C_FIELD });
                stroke_rrect(s, rr, R_MD, if active { C_LINE_2 } else { C_LINE }, 1.0);
                app.fonts
                    .text_center(s, rr, lab, T10, C_TEXT, Wt::Reg, true);
                hit.push((rr, act));
            }
            // absolute position checkbox
            let absolute = {
                let d = app.doc();
                d.selected_id()
                    .and_then(|id| {
                        fn find_con(
                            n: &x_native::Node,
                            id: &str,
                        ) -> Option<x_native::ChildConstraints> {
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
                        find_con(&d.editor_ref().root, &id)
                    })
                    .map(|c| c.is_absolute)
                    .unwrap_or(false)
            };
            let ab = Rect::new(x0 + 162.0, y0 + 430.0, x0 + 178.0, y0 + 430.0 + CHIP_H);
            fill_rrect(s, ab, R_SM, C_FIELD);
            stroke_rrect(s, ab, R_SM, C_LINE_2, 1.0);
            if absolute {
                fill_rrect(s, ab.inflate(-3.0, -3.0), R_XS, C_TEXT);
            }
            app.fonts.text(
                s,
                ab.x1 + 8.0,
                y0 + 429.7,
                "Absolute",
                T11,
                C_MUTED,
                Wt::Reg,
            );
            hit.push((
                Rect::new(x0 + 162.0, y0 + 426.0, x0 + 262.0, y0 + 450.0),
                Action::ToggleChildAbsolute,
            ));
        }
    }

    // clip content: dense (24px) disclosure-style row
    let clip_row = Rect::new(x0, y0 + 512.0, x0 + 110.0, y0 + 512.0 + DENSE_H);
    let cb = Rect::new(
        x0,
        clip_row.y0 + 4.0,
        x0 + CHIP_H,
        clip_row.y0 + 4.0 + CHIP_H,
    );
    fill_rrect(s, cb, R_SM, C_FIELD);
    stroke_rrect(s, cb, R_SM, C_LINE_2, 1.0);
    if sel.clip {
        fill_rrect(s, cb.inflate(-3.0, -3.0), R_XS, C_TEXT);
    }
    app.fonts.text(
        s,
        cb.x1 + 8.0,
        clip_row.y0 + 3.7,
        "Clip content",
        T11,
        C_MUTED,
        Wt::Reg,
    );
    hit.push((clip_row, Action::ClipContent));

    // Figma's right sidebar puts "Show name" in the Layer section; our panel is
    // one dense band there, so it sits beside "Clip content" in the same row —
    // same 24px checkbox, same ink, no geometry moved. Frames only: a Section
    // always shows its own name, and no other layer has one to switch off.
    if sel.is_frame {
        let sn_x = x0 + 150.0;
        let sn_row = Rect::new(sn_x, clip_row.y0, sn_x + 118.0, clip_row.y0 + DENSE_H);
        let sn_cb = Rect::new(
            sn_x,
            clip_row.y0 + 4.0,
            sn_x + CHIP_H,
            clip_row.y0 + 4.0 + CHIP_H,
        );
        fill_rrect(s, sn_cb, R_SM, C_FIELD);
        stroke_rrect(s, sn_cb, R_SM, C_LINE_2, 1.0);
        if sel.show_name {
            fill_rrect(s, sn_cb.inflate(-3.0, -3.0), R_XS, C_TEXT);
        }
        app.fonts.text(
            s,
            sn_cb.x1 + 8.0,
            clip_row.y0 + 3.7,
            "Show name",
            T11,
            C_MUTED,
            Wt::Reg,
        );
        hit.push((sn_row, Action::ToggleShowName));
    }

    hline(s, rx, rx + rw, y0 + 548.0, C_LINE);

    // ---- appearance -----------------------------------------------------
    // Section header row (28): caps label centered, eye on the SQ_BTN square.
    app.fonts
        .caps_label(s, x0, y0 + 569.0, "Appearance", C_TEXT, Wt::Med);
    let appearance_eye = Rect::new(xr - 22.0, y0 + 560.0, xr, y0 + 588.0);
    let selected_visible = {
        let d = app.doc();
        d.selected_id()
            .and_then(|id| find_node(&d.editor_ref().root, &id).map(|n| n.visible))
            .unwrap_or(true)
    };
    draw_icon(
        s,
        if selected_visible { "eye" } else { "eye-off" },
        xr - 14.0,
        y0 + 566.0,
        ICON_SM,
        C_DIM,
    );
    hit.push((appearance_eye, Action::ToggleVisible));
    let opr = Rect::new(x0, y0 + 596.0, x0 + 153.5, y0 + 624.0);
    input(
        app,
        s,
        hit,
        opr,
        Some(("Opacity", T10)),
        "",
        false,
        Some(Action::Field(FieldId::Opacity)),
        None,
    );
    // ml-auto: value hugs the right edge (audit: "100%" ends 8px before x1)
    let op_val = field_val(
        app,
        FieldId::Opacity,
        format!("{}%", (sel.opacity * 100.0).round()),
    );
    let op_vw = app.fonts.measure(&op_val, T11, Wt::Reg);
    app.fonts.text(
        s,
        opr.x1 - 8.0 - op_vw,
        y0 + 601.75,
        &op_val,
        T11,
        C_TEXT,
        Wt::Reg,
    );
    let rdr = Rect::new(x0 + 161.5, y0 + 596.0, x0 + 315.0, y0 + 624.0);
    input(
        app,
        s,
        hit,
        rdr,
        Some(("Radius", T10)),
        "",
        false,
        Some(Action::Field(FieldId::Radius)),
        None,
    );
    let rd_val = field_val(app, FieldId::Radius, fmt_num(sel.radius));
    let rd_vw = app.fonts.measure(&rd_val, T11, Wt::Reg);
    app.fonts.text(
        s,
        rdr.x1 - 8.0 - rd_vw,
        y0 + 601.75,
        &rd_val,
        T11,
        C_TEXT,
        Wt::Reg,
    );

    hline(s, rx, rx + rw, y0 + 636.0, C_LINE);

    // Phase 6: Image adjustment controls (only shown for image nodes)
    let y_after_appearance = y0 + 636.0 + 1.0 + 12.0;
    let y_after_image =
        paint_image_adjustments(app, s, hit, rx + pl, rx + rw - pl, y_after_appearance);
    if y_after_image != y_after_appearance {
        // The image-adjustment block rendered (7 sliders + buttons, ~280px).
        // Its height cannot be folded into `y0` without re-flowing every
        // offset below it, so the sections that follow keep their reference
        // positions — see the geometry note atop this function.
    }

    // ---- typography -----------------------------------------------------
    // Section header row (28): caps label centered, both buttons 28px.
    app.fonts
        .caps_label(s, x0, y0 + 657.0, "Typography", C_TEXT, Wt::Med);
    // Figma's Typography header: the styles button opens the text-style
    // picker, the plus creates a style from the current selection. Both were
    // painted but inert — these rects are what make them buttons.
    let styles_btn = Rect::new(xr - 38.0, y0 + 648.0, xr - 18.0, y0 + 676.0);
    let create_btn = Rect::new(xr - 18.0, y0 + 648.0, xr + 2.0, y0 + 676.0);
    let styles_tint = if app.dropdown_text_style || hover(app, styles_btn) {
        C_TEXT
    } else {
        C_DIM
    };
    draw_icon(
        s,
        "grid-2x2",
        xr - 14.0 - 8.0 - 12.0,
        y0 + 654.0,
        ICON_XS,
        styles_tint,
    );
    let create_tint = if hover(app, create_btn) {
        C_TEXT
    } else {
        C_DIM
    };
    draw_icon(s, "plus", xr - 14.0, y0 + 655.0, ICON_SM, create_tint);
    hit.push((styles_btn, Action::TextStyleDropdown));
    hit.push((create_btn, Action::CreateTextStyle));
    let fam = Rect::new(x0, y0 + 684.0, x0 + 315.0, y0 + 712.0);
    input(
        app,
        s,
        hit,
        fam,
        None,
        &field_val(app, FieldId::FontFamily, typo_val(app, Typo::Family)),
        false,
        Some(Action::Field(FieldId::FontFamily)),
        Some("chevron-down"),
    );
    if app.font_picker_open {
        // family-grouped listing (owned — no borrow held across draws);
        // picking a FAMILY is enough: rendering resolves it to a face.
        let fams = app.fonts.fonts.families();
        let popup = Rect::new(fam.x0, fam.y1 + 2.0, fam.x1, fam.y1 + 174.0);
        fill_rrect(s, popup, R_MD, C_PANEL_2);
        stroke_rrect(s, popup, R_MD, C_LINE_2, 1.0);
        app.fonts.micro_label(
            s,
            popup.x0 + 10.0,
            popup.y0 + 14.0,
            "FONT BROWSER",
            C_DIM,
            Wt::Med,
        );
        for (i, (fam, faces)) in fams.iter().take(8).enumerate() {
            let row = Rect::new(
                popup.x0 + 4.0,
                popup.y0 + 22.0 + i as f64 * 18.0,
                popup.x1 - 4.0,
                popup.y0 + 39.0 + i as f64 * 18.0,
            );
            if hover(app, row) {
                fill_rrect(s, row, R_SM, C_FIELD_2);
            }
            app.fonts
                .text(s, row.x0 + 6.0, row.y0 + 3.0, fam, T10, C_TEXT, Wt::Reg);
            if faces.len() > 1 {
                let cnt = format!("{} faces", faces.len());
                let cw = app.fonts.measure(&cnt, T10, Wt::Reg);
                app.fonts.text(
                    s,
                    row.x1 - 10.0 - cw,
                    row.y0 + 3.0,
                    &cnt,
                    T10,
                    C_DIM,
                    Wt::Reg,
                );
            }
            hit.push((row, Action::FontPicker(fam.clone())));
        }
    }
    let wgt = Rect::new(x0, y0 + 720.0, x0 + 227.0, y0 + 748.0);
    input(
        app,
        s,
        hit,
        wgt,
        None,
        &field_val(app, FieldId::FontWeight, typo_val(app, Typo::Weight)),
        false,
        Some(Action::Field(FieldId::FontWeight)),
        Some("chevron-down"),
    );
    let szr = Rect::new(x0 + 235.0, y0 + 720.0, x0 + 315.0, y0 + 748.0);
    input(
        app,
        s,
        hit,
        szr,
        None,
        &field_val(app, FieldId::FontSize, typo_val(app, Typo::Size)),
        false,
        Some(Action::Field(FieldId::FontSize)),
        Some("chevron-down"),
    );
    app.fonts
        .text(s, x0, y0 + 756.0, "Line height", T10, C_DIM, Wt::Reg);
    let lhr = Rect::new(x0, y0 + 774.0, x0 + 153.5, y0 + 802.0);
    input_box(app, s, lhr, R_INPUT);
    draw_icon(s, "type", lhr.x0 + 8.0, lhr.y0 + 8.0, ICON_XS, C_DIM);
    // line-height mode affordance (Auto / px / %) — same chevron language
    // as the family / weight rows
    let lh_chev = Rect::new(lhr.x1 - 20.0, lhr.y0, lhr.x1, lhr.y1);
    draw_icon(
        s,
        "chevron-down",
        lh_chev.x0 + 4.0,
        lhr.y0 + 9.0,
        ICON_XS,
        C_DIM,
    );
    let lh_val = if app.field.as_ref().map(|f| f.id) == Some(FieldId::LineHeight) {
        app.field.as_ref().unwrap().buffer.clone()
    } else {
        typo_val(app, Typo::LineHeight)
    };
    app.fonts.text(
        s,
        lhr.x0 + 27.0,
        lhr.y0 + 5.8,
        &lh_val,
        T11,
        C_TEXT,
        Wt::Reg,
    );
    hit.push((lhr, Action::Field(FieldId::LineHeight)));
    hit.push((lh_chev, Action::LhDropdown));

    // Horizontal alignment: three working buttons. The shaper degrades
    // Justified to Left, so it is not offered (a phantom state); the active
    // highlight mirrors what the canvas actually renders.
    app.fonts
        .text(s, x0, y0 + 810.0, "Alignment", T10, C_DIM, Wt::Reg);
    let align_now = selected_text_align(app);
    for (i, (ic, t)) in [
        ("align-left", x_native::TextAlign::Left),
        ("align-center", x_native::TextAlign::Center),
        ("align-right", x_native::TextAlign::Right),
    ]
    .into_iter()
    .enumerate()
    {
        let bx = x0 + 47.7 * i as f64;
        let br = Rect::new(bx, y0 + 828.0, bx + 43.8, y0 + 856.0);
        let active = align_now == t;
        if active {
            fill_rrect(s, br, R_MD, C_FIELD_2);
            stroke_rrect(s, br, R_MD, C_LINE_2, 1.0);
        } else {
            input_box(app, s, br, 6.0);
        }
        draw_icon(
            s,
            ic,
            br.x0 + (43.8 - 14.0) / 2.0,
            br.y0 + 7.0,
            ICON_SM,
            if active { C_TEXT } else { C_DIM },
        );
        hit.push((br, Action::SetTextAlign(t)));
    }

    // Vertical alignment (horizontal sits in the button row above)
    app.fonts
        .text(s, x0, y0 + 864.0, "Vertical alignment", T10, C_DIM, Wt::Reg);
    let v_align = Rect::new(x0, y0 + 882.0, x0 + 153.5, y0 + 910.0);
    input(
        app,
        s,
        hit,
        v_align,
        None,
        &text_align_vertical_label(app),
        false,
        Some(Action::CycleTextAlignVertical),
        Some("chevron-down"),
    );

    // Decoration | Wrap style (the engine's paragraph wrap strategy, "tw")
    app.fonts
        .text(s, x0, y0 + 918.0, "Decoration", T10, C_DIM, Wt::Reg);
    app.fonts
        .text(s, x0 + 161.5, y0 + 918.0, "Wrap style", T10, C_DIM, Wt::Reg);
    let deco = Rect::new(x0, y0 + 936.0, x0 + 153.5, y0 + 964.0);
    input(
        app,
        s,
        hit,
        deco,
        None,
        &text_decoration_label(app),
        false,
        Some(Action::CycleTextDecoration),
        Some("chevron-down"),
    );
    let wrap = Rect::new(x0 + 161.5, y0 + 936.0, x0 + 315.0, y0 + 964.0);
    input(
        app,
        s,
        hit,
        wrap,
        None,
        &wrap_strategy_label(app),
        false,
        Some(Action::CycleTextWrap),
        Some("chevron-down"),
    );

    // Max lines | Paragraph indent
    app.fonts
        .text(s, x0, y0 + 972.0, "Max lines", T10, C_DIM, Wt::Reg);
    app.fonts.text(
        s,
        x0 + 161.5,
        y0 + 972.0,
        "Paragraph indent",
        T10,
        C_DIM,
        Wt::Reg,
    );
    let max_lines = Rect::new(x0, y0 + 990.0, x0 + 153.5, y0 + 1018.0);
    input(
        app,
        s,
        hit,
        max_lines,
        None,
        &field_val(app, FieldId::MaxLines, typo_val(app, Typo::MaxLines)),
        false,
        Some(Action::Field(FieldId::MaxLines)),
        None,
    );
    let para_indent = Rect::new(x0 + 161.5, y0 + 990.0, x0 + 315.0, y0 + 1018.0);
    input(
        app,
        s,
        hit,
        para_indent,
        None,
        &field_val(
            app,
            FieldId::ParagraphIndent,
            typo_val(app, Typo::ParagraphIndent),
        ),
        false,
        Some(Action::Field(FieldId::ParagraphIndent)),
        None,
    );

    // ---- Advanced disclosure (progressive disclosure, P0-8) -------------
    // The spacing metrics, baseline shift, case and the variable-font axes
    // are real, engine-backed properties — but they are not the primary set
    // (Font / Weight / Size / Line height / Alignment), so they sit behind
    // a disclosure instead of disappearing.
    let adv_open = app.typo_advanced_open;
    let adv = Rect::new(x0, y0 + 1026.0, x0 + 315.0, y0 + 1026.0 + DENSE_H);
    let adv_hov = hover(app, adv);
    draw_icon(
        s,
        if adv_open {
            "chevron-down"
        } else {
            "chevron-right"
        },
        adv.x0 + 1.0,
        adv.y0 + 6.0,
        ICON_XS,
        C_DIM,
    );
    app.fonts.text(
        s,
        adv.x0 + 20.0,
        adv.y0 + 5.0,
        "Advanced",
        T10,
        if adv_hov { C_TEXT } else { C_DIM },
        Wt::Reg,
    );
    hit.push((adv, Action::ToggleTypoAdvanced));
    if adv_open {
        // Letter spacing | Word spacing
        app.fonts
            .text(s, x0, y0 + 1058.0, "Letter spacing", T10, C_DIM, Wt::Reg);
        app.fonts.text(
            s,
            x0 + 161.5,
            y0 + 1058.0,
            "Word spacing",
            T10,
            C_DIM,
            Wt::Reg,
        );
        let lsr = Rect::new(x0, y0 + 1076.0, x0 + 153.5, y0 + 1104.0);
        input(
            app,
            s,
            hit,
            lsr,
            None,
            &field_val(
                app,
                FieldId::LetterSpacing,
                typo_val(app, Typo::LetterSpacing),
            ),
            false,
            Some(Action::Field(FieldId::LetterSpacing)),
            None,
        );
        let wsr = Rect::new(x0 + 161.5, y0 + 1076.0, x0 + 315.0, y0 + 1104.0);
        input(
            app,
            s,
            hit,
            wsr,
            None,
            &field_val(app, FieldId::WordSpacing, typo_val(app, Typo::WordSpacing)),
            false,
            Some(Action::Field(FieldId::WordSpacing)),
            None,
        );
        // Paragraph spacing | Baseline shift
        app.fonts
            .text(s, x0, y0 + 1112.0, "Paragraph spacing", T10, C_DIM, Wt::Reg);
        app.fonts.text(
            s,
            x0 + 161.5,
            y0 + 1112.0,
            "Baseline shift",
            T10,
            C_DIM,
            Wt::Reg,
        );
        let psr = Rect::new(x0, y0 + 1130.0, x0 + 153.5, y0 + 1158.0);
        input(
            app,
            s,
            hit,
            psr,
            None,
            &field_val(app, FieldId::ParaSpacing, typo_val(app, Typo::ParaSpacing)),
            false,
            Some(Action::Field(FieldId::ParaSpacing)),
            None,
        );
        let bsr = Rect::new(x0 + 161.5, y0 + 1130.0, x0 + 315.0, y0 + 1158.0);
        input(
            app,
            s,
            hit,
            bsr,
            None,
            &field_val(
                app,
                FieldId::BaselineShift,
                typo_val(app, Typo::BaselineShift),
            ),
            false,
            Some(Action::Field(FieldId::BaselineShift)),
            None,
        );
        // Text case (small caps rides the same control)
        app.fonts
            .text(s, x0, y0 + 1166.0, "Text case", T10, C_DIM, Wt::Reg);
        let tcr = Rect::new(x0, y0 + 1184.0, x0 + 153.5, y0 + 1212.0);
        input(
            app,
            s,
            hit,
            tcr,
            None,
            &field_val(app, FieldId::TextCase, typo_val(app, Typo::TextCase)),
            false,
            Some(Action::Field(FieldId::TextCase)),
            Some("chevron-down"),
        );
        // Optical size | Width (variable-font axes; Auto on static faces)
        app.fonts
            .text(s, x0, y0 + 1220.0, "Optical size", T10, C_DIM, Wt::Reg);
        app.fonts
            .text(s, x0 + 161.5, y0 + 1220.0, "Width", T10, C_DIM, Wt::Reg);
        let osr = Rect::new(x0, y0 + 1238.0, x0 + 153.5, y0 + 1266.0);
        input(
            app,
            s,
            hit,
            osr,
            None,
            &field_val(app, FieldId::OpticalSize, typo_val(app, Typo::OpticalSize)),
            false,
            Some(Action::Field(FieldId::OpticalSize)),
            None,
        );
        let wdr = Rect::new(x0 + 161.5, y0 + 1238.0, x0 + 315.0, y0 + 1266.0);
        input(
            app,
            s,
            hit,
            wdr,
            None,
            &field_val(app, FieldId::WidthAxis, typo_val(app, Typo::WidthAxis)),
            false,
            Some(Action::Field(FieldId::WidthAxis)),
            None,
        );
    }

    // ---- fill / stroke / effects / guides continue with the shared tail
    // (the section's end moves with the disclosure, so does the tail)
    let tail_top = if adv_open { y0 + 1278.0 } else { y0 + 1062.0 };
    hline(s, rx, rx + rw, tail_top, C_LINE);
    let mut y = tail_top + 12.0;
    let inner_w = rw - pl * 2.0;

    // --- Fill ----------------------------------------------------------
    section_header(app, s, hit, rx, rw, pl, y, "Fill", true, Action::AddFill);
    y += 14.0 + LABEL_GAP;
    y = paint_paint_row(
        app,
        s,
        hit,
        rx,
        rw,
        pl,
        y,
        &sel.fill,
        FieldId::FillHex,
        FieldId::FillAlpha,
        true,
    );
    y += 12.0 + LABEL_GAP;

    // Phase 6: Gradient controls (only shown when fill is a gradient)
    y = paint_gradient_controls(app, s, hit, rx + pl, rx + rw - pl, y);

    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 12.0;

    // --- Stroke --------------------------------------------------------
    section_header(
        app,
        s,
        hit,
        rx,
        rw,
        pl,
        y,
        "Stroke",
        true,
        Action::AddStroke,
    );
    y += 14.0 + LABEL_GAP;
    y = paint_paint_row(
        app,
        s,
        hit,
        rx,
        rw,
        pl,
        y,
        &sel.stroke,
        FieldId::StrokeHex,
        FieldId::StrokeAlpha,
        false,
    );
    y += gap;
    let half3 = (inner_w - gap) / 2.0;
    app.fonts
        .text(s, rx + pl, y, "Position", T10, C_DIM, Wt::Reg);
    app.fonts
        .text(s, rx + pl + half3 + gap, y, "Weight", T10, C_DIM, Wt::Reg);
    y += 12.0 + LABEL_GAP;
    let pos = Rect::new(rx + pl, y, rx + pl + half3, y + h);
    input(
        app,
        s,
        hit,
        pos,
        None,
        stroke_position_label(app),
        false,
        Some(Action::CycleStrokePosition),
        Some("chevron-down"),
    );
    let wtr = Rect::new(pos.x1 + gap, y, pos.x1 + gap + half3, y + h);
    input(
        app,
        s,
        hit,
        wtr,
        None,
        &field_val(
            app,
            FieldId::StrokeWeight,
            fmt_num(if sel.stroke_w > 0.0 {
                sel.stroke_w
            } else {
                1.0
            }),
        ),
        false,
        Some(Action::Field(FieldId::StrokeWeight)),
        None,
    );
    // up/down chevrons (weight spinner)
    draw_icon(
        s,
        "chevron-up",
        wtr.x1 - 8.0 - 10.0,
        wtr.y0 + 6.0,
        ICON_XS,
        C_DIM,
    );
    draw_icon(
        s,
        "chevron-down",
        wtr.x1 - 8.0 - 10.0,
        wtr.y0 + 16.0,
        ICON_XS,
        C_DIM,
    );
    y += h + ROW_GAP;
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + SECTION_GAP;

    // --- Effects -------------------------------------------------------
    let eff_h = 40.0;
    app.fonts
        .caps_label(s, rx + pl, y + 10.0, "Effects", C_TEXT, Wt::Med);
    draw_icon(s, "plus", rx + rw - pl - 14.0, y + 9.0, ICON_SM, C_DIM);
    hit.push((
        Rect::new(rx + rw - pl - 18.0, y, rx + rw - pl, y + 32.0),
        Action::AddEffect,
    ));
    y += eff_h;
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 12.0;

    // --- GUIDES --------------------------------------------------------
    draw_icon(s, "chevron-down", rx + pl, y + 1.0, ICON_XS, C_DIM);
    app.fonts
        .caps_label(s, rx + pl + 12.0 + 6.0, y, "GUIDES", C_TEXT, Wt::Med);
    draw_icon(s, "plus", rx + rw - pl - 14.0, y - 1.0, ICON_SM, C_DIM);
    hit.push((
        Rect::new(rx + rw - pl - 18.0, y - 4.0, rx + rw - pl, y + 16.0),
        Action::AddGuide,
    ));
    y += 14.0 + LABEL_GAP;
    // P13: the guide overflow was dead; the guides list only ever gains
    // entries, so the honest control is a clear-all button
    let mvb = Rect::new(rx + pl, y, rx + pl + 24.0, y + 28.0);
    input_box(app, s, mvb, 6.0);
    if hover(app, mvb) {
        fill_rrect(s, mvb, R_MD, C_FIELD_2);
    }
    draw_icon(s, "trash-2", mvb.x0 + 6.0, mvb.y0 + 6.0, ICON_XS, C_DIM);
    tip(app, mvb, "Clear all guides");
    hit.push((mvb, Action::RemoveGuide));
    let kd_w = inner_w - 24.0 - 48.0 - 24.0 - 24.0 - 6.0 * 4.0;
    let kd = Rect::new(mvb.x1 + 6.0, y, mvb.x1 + 6.0 + kd_w, y + 28.0);
    let kind_label = if app.doc().guide_kind == 0 {
        "Square"
    } else {
        "Grid"
    };
    input(
        app,
        s,
        hit,
        kd,
        None,
        kind_label,
        false,
        Some(Action::ToggleGuide(0)),
        Some("chevron-down"),
    );
    let gs = Rect::new(kd.x1 + 6.0, y, kd.x1 + 6.0 + 48.0, y + 28.0);
    let gs_now = app.doc().guide_size;
    let gs_val = field_val(app, FieldId::GuideSize, fmt_num(gs_now));
    input(
        app,
        s,
        hit,
        gs,
        None,
        &gs_val,
        false,
        Some(Action::Field(FieldId::GuideSize)),
        None,
    );
    let guide_eye = Rect::new(
        kd.x1 + 6.0 + 48.0 + 6.0,
        y,
        kd.x1 + 6.0 + 48.0 + 6.0 + 24.0,
        y + 24.0,
    );
    let eye_icon = if app.doc().guides_visible {
        "eye"
    } else {
        "eye-off"
    };
    sq_btn_small(app, s, guide_eye.x0, guide_eye.y0, eye_icon);
    hit.push((guide_eye, Action::ToggleGuideVisibility));
    let rm = Rect::new(
        kd.x1 + 6.0 + 48.0 + 6.0 + 24.0 + 6.0,
        y + 2.0,
        kd.x1 + 6.0 + 48.0 + 6.0 + 24.0 + 6.0 + 24.0,
        y + 26.0,
    );
    if hover(app, rm) {
        fill_rrect(s, rm, R_MD, C_FIELD_2);
    }
    draw_icon(s, "minus", rm.x0 + 5.0, rm.y0 + 5.0, ICON_SM, C_DIM);
    hit.push((rm, Action::RemoveGuide));
    y += 28.0 + SECTION_GAP;
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 12.0;

    // --- Export ---------------------------------------------------------
    let fmts = ["PNG", "JPG", "SVG", "PDF", "SKETCH"];
    let scales = ["1x", "2x"];
    let f_r = Rect::new(rx + pl, y, rx + pl + 56.0, y + 24.0);
    let fmt_label = fmts[app.doc().export_format];
    input(
        app,
        s,
        hit,
        f_r,
        None,
        fmt_label,
        false,
        None,
        Some("chevron-down"),
    );
    hit.push((f_r, Action::CycleExportFormat));
    let sc_r = Rect::new(f_r.x1 + 8.0, y, f_r.x1 + 8.0 + 44.0, y + 24.0);
    let scale_label = scales[app.doc().export_scale];
    input(
        app,
        s,
        hit,
        sc_r,
        None,
        scale_label,
        false,
        None,
        Some("chevron-down"),
    );
    hit.push((sc_r, Action::CycleExportScale));
    let suf_w = inner_w - 56.0 - 44.0 - 8.0 * 2.0;
    let suf = Rect::new(sc_r.x1 + 8.0, y, sc_r.x1 + 8.0 + suf_w, y + 24.0);
    input(
        app,
        s,
        hit,
        suf,
        None,
        &field_val(app, FieldId::ExportSuffix, "Suffix".into()),
        false,
        Some(Action::Field(FieldId::ExportSuffix)),
        None,
    );
    y += 24.0 + 8.0;
    let ex = Rect::new(rx + pl, y, rx + rw - pl, y + 28.0);
    let hov = hover(app, ex);
    fill_rrect(s, ex, R_MD, if hov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, ex, R_MD, C_LINE_2, 1.0);
    let label_w = app.fonts.measure("EXPORT 1 ELEMENT", T10, Wt::Med) + 16.0 * T10 * 0.08;
    app.fonts.caps_label(
        s,
        rx + (rw - label_w) / 2.0,
        y + 8.0,
        "EXPORT 1 ELEMENT",
        C_MUTED,
        Wt::Med,
    );
    hit.push((ex, Action::ExportRun));
    y += 28.0 + SECTION_GAP;

    // --- COMPONENT (properties) -----------------------------------------
    // Masters define designer-facing properties (bound to the selected
    // descendant); instances edit them as typed overrides (A2).
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 12.0;
    app.fonts.caps_label(s, x0, y, "COMPONENT", C_TEXT, Wt::Med);
    y += 12.0 + LABEL_GAP;
    let (master, inst) = (app.selected_master_name(), app.selected_instance());
    if let Some((iid, comp)) = inst {
        // variant switcher for set members (Figma's instance VARIANT row)
        let siblings = app.doc().editor_ref().variant_siblings(&comp);
        if !siblings.is_empty() {
            let cur_variant = comp.rsplit('/').next().unwrap_or(&comp).to_string();
            let set = comp.split('/').next().unwrap_or(&comp).to_string();
            app.fonts
                .text(s, x0, y + 6.0, "Variant", T10, C_DIM, Wt::Reg);
            let vb = Rect::new(x0 + 120.0, y - 4.0, xr, y + 20.0);
            input_box(app, s, vb, 6.0);
            let shown = app.fonts.truncate(
                &format!("{set} · {cur_variant} ▾"),
                T11,
                Wt::Med,
                vb.width() - 34.0,
            );
            app.fonts
                .text(s, vb.x0 + 26.0, y + 2.4, &shown, T11, C_TEXT, Wt::Med);
            draw_icon(s, "chevron-down", vb.x1 - 18.0, y + 4.0, ICON_XS, C_DIM);
            let half = vb.width() / 2.0;
            hit.push((
                Rect::new(vb.x0, vb.y0, vb.x0 + half, vb.y1),
                Action::VariantCycle(-1),
            ));
            hit.push((
                Rect::new(vb.x0 + half, vb.y0, vb.x1, vb.y1),
                Action::VariantCycle(1),
            ));
            y += 30.0;
        }
        // instance side: one row per prop of the component
        let entries = app.props_of(&comp);
        if entries.is_empty() {
            app.fonts
                .text(s, x0, y, "No properties defined", T10, C_MUTED, Wt::Reg);
            y += 18.0;
        }
        for e in &entries {
            let value = app.instance_prop_value(&iid, e);
            match e.kind {
                x_native::ComponentPropKind::Bool => {
                    let cb = Rect::new(x0, y, x0 + 16.0, y + 16.0);
                    let on = value == "true";
                    fill_rrect(s, cb, R_SM, C_FIELD);
                    stroke_rrect(s, cb, R_SM, C_LINE_2, 1.0);
                    if on {
                        fill_rrect(s, cb.inflate(-3.0, -3.0), R_XS, C_TEXT);
                    }
                    app.fonts
                        .text(s, cb.x1 + 8.0, y - 0.3, &e.name, T11, C_TEXT, Wt::Reg);
                    hit.push((
                        Rect::new(x0, y - 6.0, x0 + 150.0, y + 22.0),
                        Action::ToggleInstanceProp(e.name.clone()),
                    ));
                    y += 28.0;
                }
                x_native::ComponentPropKind::Text => {
                    app.fonts.text(s, x0, y + 6.0, &e.name, T10, C_DIM, Wt::Reg);
                    let fr = Rect::new(x0 + 120.0, y - 4.0, xr, y + 20.0);
                    input_box(app, s, fr, R_INPUT);
                    let shown = field_val(app, FieldId::InstanceProp, value);
                    app.fonts
                        .text(s, fr.x0 + 8.0, y + 2.4, &shown, T11, C_TEXT, Wt::Mono);
                    hit.push((fr, Action::Field(FieldId::InstanceProp)));
                    app.last_instance_prop_rect = Some((fr, e.name.clone()));
                    y += 28.0;
                }
                x_native::ComponentPropKind::Swap => {
                    app.fonts.text(s, x0, y + 6.0, &e.name, T10, C_DIM, Wt::Reg);
                    let br = Rect::new(x0 + 120.0, y - 4.0, xr, y + 20.0);
                    input_box(app, s, br, 6.0);
                    app.fonts
                        .text(s, br.x0 + 8.0, y + 2.4, &value, T11, C_TEXT, Wt::Reg);
                    draw_icon(s, "chevron-down", br.x1 - 18.0, y + 4.0, ICON_XS, C_DIM);
                    hit.push((br, Action::CycleInstanceSwap(e.name.clone())));
                    y += 28.0;
                }
            }
        }
        if !entries.is_empty() {
            let rr = Rect::new(x0, y, x0 + 96.0, y + 22.0);
            let hov = hover(app, rr);
            fill_rrect(s, rr, R_MD, if hov { C_FIELD_2 } else { C_FIELD });
            stroke_rrect(s, rr, R_MD, C_LINE, 1.0);
            app.fonts
                .text_center(s, rr, "Reset overrides", T10, C_TEXT, Wt::Reg, true);
            hit.push((rr, Action::ResetInstanceProps));
            y += 30.0;
        }
        // SLOTS — insertion points declared on the master tree
        // (ComponentProp::Slot; not part of component_props). Fill from
        // another selected layer, or clear back to anchor/default.
        let slots: Vec<(String, Option<String>)> = {
            let d = app.doc_ref();
            x_native::find_master(&d.editor_ref().root, &comp)
                .map(|m| {
                    m.props
                        .iter()
                        .filter_map(|p| match p {
                            x_native::ComponentProp::Slot { name, default, .. } => {
                                Some((name.clone(), default.clone()))
                            }
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        if !slots.is_empty() {
            app.fonts.micro_label(s, x0, y, "SLOTS", C_DIM, Wt::Med);
            y += 16.0;
            for (sname, def) in &slots {
                let filled = {
                    let d = app.doc_ref();
                    crate::editor_ui::find_node(&d.editor_ref().root, iid.as_str())
                        .and_then(|n| x_native::slot_content(n, sname))
                        .is_some()
                };
                let st = if filled {
                    "filled".to_string()
                } else if def.is_some() {
                    "default".to_string()
                } else {
                    "anchor".to_string()
                };
                app.fonts.text(
                    s,
                    x0,
                    y + 6.0,
                    &app.fonts.truncate(sname, T10, Wt::Reg, 90.0),
                    T10,
                    C_TEXT,
                    Wt::Reg,
                );
                let sw = app.fonts.measure(&st, T10, Wt::Reg);
                app.fonts
                    .text(s, xr - 170.0 - sw, y + 7.0, &st, T10, C_MUTED, Wt::Reg);
                let setb = Rect::new(xr - 164.0, y, xr - 84.0, y + 20.0);
                fill_rrect(
                    s,
                    setb,
                    R_SM,
                    if hover(app, setb) { C_LINE_2 } else { C_FIELD },
                );
                stroke_rrect(s, setb, R_SM, C_LINE, 1.0);
                app.fonts
                    .text_center(s, setb, "from selection", T10, C_TEXT, Wt::Reg, true);
                hit.push((setb, Action::SlotSetFromSelection(sname.clone())));
                let clrb = Rect::new(xr - 78.0, y, xr - 56.0, y + 20.0);
                fill_rrect(
                    s,
                    clrb,
                    R_SM,
                    if hover(app, clrb) { C_LINE_2 } else { C_FIELD },
                );
                draw_icon(
                    s,
                    "x",
                    clrb.x0 + 5.0,
                    clrb.y0 + 4.0,
                    ICON_XS,
                    // C_DIM on the hover fill is 2.9:1 in Daylight (below the
                    // 3:1 floor for a glyph); text_primary reads in both
                    if hover(app, clrb) { C_TEXT } else { C_DIM },
                );
                hit.push((clrb, Action::SlotClear(sname.clone())));
                y += 26.0;
            }
            y += 8.0;
        }
    } else if let Some(master) = master {
        // master side: bind the selected descendant as a new property
        app.fonts.text(s, x0, y, &master, T10, C_DIM, Wt::Reg);
        y += 20.0;
        app.fonts.text(s, x0, y, "Description", T10, C_DIM, Wt::Reg);
        let description = app
            .doc_ref()
            .selected_id()
            .and_then(|id| find_node(&app.doc_ref().editor_ref().root, id.as_str()))
            .and_then(|n| n.bindings.get("component:description").cloned())
            .unwrap_or_default();
        let description_r = Rect::new(x0, y + 8.0, xr, y + 36.0);
        input(
            app,
            s,
            hit,
            description_r,
            None,
            &field_val(app, FieldId::ComponentDescription, description),
            false,
            Some(Action::Field(FieldId::ComponentDescription)),
            None,
        );
        y += 46.0;
        // variant-set affordance for multi-master selections
        {
            let cb = Rect::new(x0, y, xr, y + 22.0);
            let hov = hover(app, cb);
            fill_rrect(s, cb, R_MD, if hov { C_FIELD_2 } else { C_FIELD });
            stroke_rrect(s, cb, R_MD, C_LINE, 1.0);
            app.fonts.text_center(
                s,
                cb,
                "◆ Combine selected into variant set",
                T10,
                C_TEXT,
                Wt::Reg,
                true,
            );
            hit.push((cb, Action::VariantCombine));
            y += 28.0;
        }
        let slot = Rect::new(x0, y, xr, y + 24.0);
        let slot_hov = hover(app, slot);
        fill_rrect(s, slot, R_MD, if slot_hov { C_FIELD_2 } else { C_FIELD });
        stroke_rrect(s, slot, R_MD, C_LINE, 1.0);
        app.fonts
            .text_center(s, slot, "+ Slot property", T10, C_TEXT, Wt::Reg, true);
        hit.push((slot, Action::AddSlot));
        y += 28.0;
        for (kind, label) in [
            (x_native::ComponentPropKind::Text, "+ Text property"),
            (x_native::ComponentPropKind::Bool, "+ Bool property"),
            (x_native::ComponentPropKind::Swap, "+ Swap property"),
        ] {
            let br = Rect::new(x0, y, xr, y + 24.0);
            let hov = hover(app, br);
            fill_rrect(s, br, R_MD, if hov { C_FIELD_2 } else { C_FIELD });
            stroke_rrect(s, br, R_MD, C_LINE, 1.0);
            app.fonts
                .text_center(s, br, label, T10, C_TEXT, Wt::Reg, true);
            hit.push((br, Action::AddProp(kind)));
            y += 28.0;
        }
        // defined props with remove buttons
        for e in app.props_of(&master) {
            app.fonts
                .text(s, x0, y + 5.0, &e.name, T10, C_MUTED, Wt::Reg);
            let xb = Rect::new(xr - 20.0, y, xr, y + 16.0);
            draw_icon(s, "x", xb.x0 + 4.0, y + 2.0, ICON_XS, C_DIM);
            hit.push((xb, Action::RemoveProp(e.name.clone())));
            y += 22.0;
        }
    } else {
        app.fonts.text(
            s,
            x0,
            y,
            "Select inside a master or an instance",
            T10,
            C_MUTED,
            Wt::Reg,
        );
        y += 18.0;
    }
    let _ = y;
}

fn sq_btn_small(app: &mut App, s: &mut Scene, x: f64, y: f64, icon: &str) {
    let r = Rect::new(x, y, x + 24.0, y + 24.0);
    if hover(app, r) {
        fill_rrect(s, r, R_MD, C_FIELD_2);
    }
    draw_icon(s, icon, x + 5.0, y + 5.0, ICON_SM, C_DIM);
}

#[allow(clippy::too_many_arguments)]
fn section_header(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    rx: f64,
    rw: f64,
    pl: f64,
    y: f64,
    title: &str,
    with_grid: bool,
    plus_action: Action,
) {
    app.fonts.caps_label(s, rx + pl, y, title, C_TEXT, Wt::Med);
    if with_grid {
        draw_icon(
            s,
            "grid-2x2",
            rx + rw - pl - 14.0 - 8.0 - 12.0,
            y,
            ICON_XS,
            C_DIM,
        );
    }
    draw_icon(s, "plus", rx + rw - pl - 14.0, y - 1.0, ICON_SM, C_DIM);
    hit.push((
        Rect::new(rx + rw - pl - 18.0, y - 4.0, rx + rw - pl, y + 16.0),
        plus_action,
    ));
}

fn stroke_position_label(app: &App) -> &'static str {
    let Some(doc) = app.doc_opt() else {
        return "Center";
    };
    let Some(id) = doc.selected_id() else {
        return "Center";
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return "Center";
    };
    match node.stroke_layers.first().map(|l| l.options.align) {
        Some(x_native::StrokeAlign::Inside) => "Inside",
        Some(x_native::StrokeAlign::Outside) => "Outside",
        _ => "Center",
    }
}

/// Text formatting labels (Figma Design parity)
/// The selected text node's horizontal alignment, mapped onto what the
/// shaper actually renders (Justified degrades to Left) so the active
/// button always matches the canvas.
fn selected_text_align(app: &App) -> x_native::TextAlign {
    let Some(doc) = app.doc_opt() else {
        return x_native::TextAlign::Left;
    };
    let Some(id) = doc.selected_id() else {
        return x_native::TextAlign::Left;
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return x_native::TextAlign::Left;
    };
    match node.text_align {
        x_native::TextAlign::Justified => x_native::TextAlign::Left,
        other => other,
    }
}

fn text_align_vertical_label(app: &App) -> String {
    let Some(doc) = app.doc_opt() else {
        return "Top".into();
    };
    let Some(id) = doc.selected_id() else {
        return "Top".into();
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return "Top".into();
    };
    match node.text_align_vertical {
        x_native::TextAlignVertical::Top => "Top".into(),
        x_native::TextAlignVertical::Middle => "Middle".into(),
        x_native::TextAlignVertical::Bottom => "Bottom".into(),
    }
}

fn text_decoration_label(app: &App) -> String {
    let Some(doc) = app.doc_opt() else {
        return "None".into();
    };
    let Some(id) = doc.selected_id() else {
        return "None".into();
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return "None".into();
    };
    match node.text_decoration {
        x_native::TextDecoration::None => "None".into(),
        x_native::TextDecoration::Underline => "Underline".into(),
        x_native::TextDecoration::Strikethrough => "Strikethrough".into(),
    }
}

/// The engine's paragraph wrap strategy (the "tw" binding): Auto / Balance /
/// Pretty — the same values the shaper actually lays out with.
fn wrap_strategy_label(app: &App) -> String {
    let Some(doc) = app.doc_opt() else {
        return "Auto".into();
    };
    let Some(id) = doc.selected_id() else {
        return "Auto".into();
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return "Auto".into();
    };
    match node.text_wrap() {
        x_native::TextWrap::Auto => "Auto".into(),
        x_native::TextWrap::Balance => "Balance".into(),
        x_native::TextWrap::Pretty => "Pretty".into(),
    }
}

fn paint_layer_visible(app: &App, is_fill: bool) -> bool {
    let Some(doc) = app.doc_opt() else {
        return true;
    };
    let Some(id) = doc.selected_id() else {
        return true;
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return true;
    };
    if node.visual_stacks_materialized {
        if is_fill {
            node.fill_layers.first().map(|l| l.visible).unwrap_or(true)
        } else {
            node.stroke_layers
                .first()
                .map(|l| l.visible)
                .unwrap_or(true)
        }
    } else if is_fill {
        true
    } else {
        node.stroke.width > 0.0
    }
}

// ------------------------------------------------------------------ Phase 6: Gradient & Image Controls

/// Read the paint the renderer actually uses. A materialized vector may
/// have several fills; the inspector acts on the top visible gradient rather
/// than the legacy `node.fill` shadow field.
fn selected_gradient_paint(app: &App) -> Option<Paint> {
    let doc = app.doc_opt()?;
    let id = doc.selected_id()?;
    let node = find_node(&doc.editor_ref().root, &id)?;
    node.active_fills()
        .into_iter()
        .rev()
        .find_map(|layer| layer.paint.is_gradient().then_some(layer.paint))
}

fn gradient_stops(paint: &Paint) -> Option<Vec<(f32, Color)>> {
    match paint {
        Paint::LinearGradient { stops, .. }
        | Paint::RadialGradient { stops, .. }
        | Paint::AngularGradient { stops, .. }
        | Paint::DiamondGradient { stops, .. } => Some(stops.clone()),
        _ => None,
    }
}

fn next_gradient_type(paint: &Paint) -> &'static str {
    match paint.gradient_type_name() {
        "Linear" => "Radial",
        "Radial" => "Angular",
        "Angular" => "Diamond",
        _ => "Linear",
    }
}

/// Phase 6: Check if the selected node has a gradient fill
fn has_gradient_fill(app: &App) -> bool {
    selected_gradient_paint(app).is_some()
}

/// Phase 6: Get gradient type label
fn gradient_type_label(app: &App) -> String {
    selected_gradient_paint(app)
        .map(|paint| paint.gradient_type_name().to_string())
        .unwrap_or_else(|| "None".into())
}

/// Phase 6: Check if the selected node is an image
fn selected_image_fit(app: &App) -> Option<ImageFit> {
    let doc = app.doc_opt()?;
    let id = doc.selected_id()?;
    let node = find_node(&doc.editor_ref().root, &id)?;
    match &node.kind {
        NodeKind::Image { fit, .. } => Some(*fit),
        _ => None,
    }
}

fn image_fit_label(fit: ImageFit) -> &'static str {
    match fit {
        ImageFit::Fill => "Fill",
        ImageFit::Fit => "Fit",
        ImageFit::Crop => "Crop",
        ImageFit::Tile => "Tile",
    }
}

fn next_image_fit(fit: ImageFit) -> (&'static str, ImageFit) {
    match fit {
        ImageFit::Fill => ("Fit", ImageFit::Fit),
        ImageFit::Fit => ("Crop", ImageFit::Crop),
        ImageFit::Crop => ("Tile", ImageFit::Tile),
        ImageFit::Tile => ("Fill", ImageFit::Fill),
    }
}

fn is_image_node(app: &App) -> bool {
    let Some(doc) = app.doc_opt() else {
        return false;
    };
    let Some(id) = doc.selected_id() else {
        return false;
    };
    let Some(node) = find_node(&doc.editor_ref().root, &id) else {
        return false;
    };
    matches!(node.kind, x_native::NodeKind::Image { .. })
}

/// Phase 6: Paint gradient controls section
fn paint_gradient_controls(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    x0: f64,
    xr: f64,
    y: f64,
) -> f64 {
    let Some(paint) = selected_gradient_paint(app) else {
        return y;
    };
    let Some(stops) = gradient_stops(&paint) else {
        return y;
    };
    let mut y = y;

    app.fonts.caps_label(s, x0, y, "GRADIENT", C_TEXT, Wt::Med);
    y += 20.0;

    // The selector cycles through the real conversion path. It is not a
    // decorative dropdown wired to the unrelated frame menu.
    let type_r = Rect::new(x0, y, x0 + 120.0, y + 24.0);
    input_box(app, s, type_r, 6.0);
    let label = format!("{}  ·  {} stops", paint.gradient_type_name(), stops.len());
    app.fonts.text(
        s,
        type_r.x0 + 8.0,
        type_r.y0 + 6.0,
        &label,
        T10,
        C_TEXT,
        Wt::Reg,
    );
    draw_icon(
        s,
        "chevron-down",
        type_r.x1 - 18.0,
        type_r.y0 + 6.0,
        ICON_XS,
        C_DIM,
    );
    hit.push((
        type_r,
        Action::SetGradientType {
            gradient_type: next_gradient_type(&paint).into(),
        },
    ));
    y += 32.0;

    let flip_r = Rect::new(x0, y, x0 + 60.0, y + 24.0);
    input_box(app, s, flip_r, 6.0);
    draw_icon(
        s,
        "repeat",
        flip_r.x0 + 8.0,
        flip_r.y0 + 6.0,
        ICON_XS,
        C_DIM,
    );
    app.fonts.text(
        s,
        flip_r.x0 + 24.0,
        flip_r.y0 + 6.0,
        "Flip",
        T10,
        C_TEXT,
        Wt::Reg,
    );
    hit.push((flip_r, Action::FlipGradient));

    let rotate_r = Rect::new(x0 + 70.0, y, x0 + 200.0, y + 24.0);
    input_box(app, s, rotate_r, 6.0);
    draw_icon(
        s,
        "rotate-cw",
        rotate_r.x0 + 8.0,
        rotate_r.y0 + 6.0,
        ICON_XS,
        C_DIM,
    );
    app.fonts.text(
        s,
        rotate_r.x0 + 24.0,
        rotate_r.y0 + 6.0,
        "90°",
        T10,
        C_TEXT,
        Wt::Reg,
    );
    hit.push((rotate_r, Action::RotateGradient { degrees: 90.0 }));
    y += 32.0;

    let stops_r = Rect::new(x0, y, xr, y + 52.0);
    fill_rrect(s, stops_r, R_MD, C_FIELD);
    stroke_rrect(s, stops_r, R_MD, C_LINE, 1.0);
    let bar_r = Rect::new(x0 + 4.0, y + 4.0, xr - 4.0, y + 22.0);
    let gradient_preview = match &paint {
        Paint::LinearGradient { .. } => {
            vello::peniko::Gradient::new_linear((bar_r.x0, bar_r.y0), (bar_r.x1, bar_r.y0))
                .with_stops(stops.as_slice())
        }
        Paint::RadialGradient { .. } => vello::peniko::Gradient::new_radial(
            ((bar_r.x0 + bar_r.x1) / 2.0, (bar_r.y0 + bar_r.y1) / 2.0),
            (bar_r.width() / 2.0) as f32,
        )
        .with_stops(stops.as_slice()),
        Paint::AngularGradient { .. } => vello::peniko::Gradient::new_sweep(
            ((bar_r.x0 + bar_r.x1) / 2.0, (bar_r.y0 + bar_r.y1) / 2.0),
            0.0,
            std::f32::consts::TAU,
        )
        .with_stops(stops.as_slice()),
        // Peniko has no diamond primitive; keep the stop data and use a
        // linear preview rather than displaying a hard-coded two-stop ramp.
        Paint::DiamondGradient { .. } => {
            vello::peniko::Gradient::new_linear((bar_r.x0, bar_r.y0), (bar_r.x1, bar_r.y0))
                .with_stops(stops.as_slice())
        }
        _ => unreachable!("gradient_stops only returns gradient paints"),
    };
    s.fill(
        vello::peniko::Fill::NonZero,
        vello::kurbo::Affine::IDENTITY,
        &gradient_preview,
        None,
        &bar_r,
    );
    // The complete bar is an interaction surface as well: a click repositions
    // the nearest authored stop at the pointer, so stop editing is reachable
    // without requiring a tiny marker hit target.
    if let Some((index, _)) = stops.iter().enumerate().min_by(|(_, a), (_, b)| {
        let ax = (bar_r.x0 + bar_r.width() * a.0 as f64 - app.mouse.x).abs();
        let bx = (bar_r.x0 + bar_r.width() * b.0 as f64 - app.mouse.x).abs();
        ax.total_cmp(&bx)
    }) {
        let pointer_position = ((app.mouse.x - bar_r.x0) / bar_r.width()).clamp(0.0, 1.0) as f32;
        hit.push((
            bar_r,
            Action::MoveGradientStop {
                index,
                new_position: pointer_position,
            },
        ));
    }

    for (index, (position, color)) in stops.iter().enumerate() {
        let t = (*position as f64).clamp(0.0, 1.0);
        let stop_x = bar_r.x0 + bar_r.width() * t;
        let marker_r = Rect::new(stop_x - 4.0, bar_r.y1 - 1.0, stop_x + 4.0, bar_r.y1 + 7.0);
        let rgba = color.to_rgba8();
        fill_rrect(
            s,
            marker_r,
            R_XS,
            Color::from_rgba8(rgba.r, rgba.g, rgba.b, rgba.a),
        );
        stroke_rrect(s, marker_r, R_XS, C_TEXT, 1.0);
        let swatch_x = bar_r.x0 + 4.0 + index as f64 * 18.0;
        let swatch_r = Rect::new(swatch_x, y + 32.0, swatch_x + 12.0, y + 44.0);
        fill_rrect(
            s,
            swatch_r,
            R_XS,
            Color::from_rgba8(rgba.r, rgba.g, rgba.b, rgba.a),
        );
        stroke_rrect(s, swatch_r, R_XS, C_LINE_2, 1.0);
        hit.push((swatch_r, Action::CycleGradientStopColor { index }));
        // The marker hit is tied to the real bar coordinate: clicking it
        // writes the position under the pointer instead of applying a
        // hard-coded demo nudge. The action still targets the authored stop
        // used by the renderer.
        let pointer_position = ((app.mouse.x - bar_r.x0) / bar_r.width()).clamp(0.0, 1.0) as f32;
        hit.push((
            marker_r,
            Action::MoveGradientStop {
                index,
                new_position: pointer_position,
            },
        ));
    }
    y += 60.0;

    let add_r = Rect::new(x0, y, x0 + 60.0, y + 20.0);
    let hov = hover(app, add_r);
    fill_rrect(s, add_r, R_SM, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, add_r, R_SM, C_LINE, 1.0);
    draw_icon(s, "plus", add_r.x0 + 8.0, add_r.y0 + 4.0, ICON_XS, C_DIM);
    app.fonts.text(
        s,
        add_r.x0 + 24.0,
        add_r.y0 + 4.0,
        "Add",
        T10,
        C_TEXT,
        Wt::Reg,
    );
    let seed = stops
        .first()
        .map(|(_, color)| color.to_rgba8())
        .unwrap_or_else(|| Color::from_rgba8(128, 128, 128, 255).to_rgba8());
    hit.push((
        add_r,
        Action::AddGradientStop {
            position: 0.5,
            color: [seed.r, seed.g, seed.b],
        },
    ));

    // Keep removal reachable without inventing a separate hidden editor: a
    // compact minus button is rendered for every non-endpoint stop.
    if stops.len() > 2 {
        let remove_r = Rect::new(x0 + 68.0, y, x0 + 128.0, y + 20.0);
        let hov = hover(app, remove_r);
        fill_rrect(s, remove_r, R_SM, if hov { C_FIELD_2 } else { C_FIELD });
        stroke_rrect(s, remove_r, R_SM, C_LINE, 1.0);
        draw_icon(
            s,
            "minus",
            remove_r.x0 + 8.0,
            remove_r.y0 + 4.0,
            ICON_XS,
            C_DIM,
        );
        app.fonts.text(
            s,
            remove_r.x0 + 24.0,
            remove_r.y0 + 4.0,
            "Remove",
            T10,
            C_TEXT,
            Wt::Reg,
        );
        hit.push((
            remove_r,
            Action::RemoveGradientStop {
                index: stops.len() - 2,
            },
        ));
    }

    y += 28.0;
    y + 8.0
}

/// Phase 6: Paint image adjustment controls section
fn paint_image_adjustments(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    x0: f64,
    // The panel lays its sliders out from x0 with fixed widths, so the right
    // edge it is handed is never read; kept in the signature because every
    // other inspector panel takes the same (x0, xr, y) box.
    _xr: f64,
    y: f64,
) -> f64 {
    if !is_image_node(app) {
        return y;
    }

    let mut y = y;

    // Section header
    app.fonts.caps_label(s, x0, y, "IMAGE", C_TEXT, Wt::Med);
    y += 20.0;

    if let Some(fit) = selected_image_fit(app) {
        let mode_r = Rect::new(x0, y, x0 + 220.0, y + 26.0);
        input_box(app, s, mode_r, 6.0);
        app.fonts.text(
            s,
            mode_r.x0 + 8.0,
            mode_r.y0 + 7.0,
            &format!("Fill mode  ·  {}", image_fit_label(fit)),
            T10,
            C_TEXT,
            Wt::Reg,
        );
        draw_icon(
            s,
            "chevron-down",
            mode_r.x1 - 18.0,
            mode_r.y0 + 7.0,
            ICON_XS,
            C_DIM,
        );
        let (_, next) = next_image_fit(fit);
        hit.push((
            mode_r,
            Action::SetImageFillMode {
                mode: image_fit_label(next).into(),
            },
        ));
        y += 34.0;
    }

    // Get current adjustments
    let adjustments = {
        let doc = app.doc();
        let id = doc.selected_id();
        if let Some(id) = id {
            let node = find_node(&doc.editor_ref().root, &id);
            node.and_then(|n| n.image_adjustments)
        } else {
            None
        }
    };

    // Adjustment sliders
    let adj_names = [
        ("Exposure", "exposure"),
        ("Contrast", "contrast"),
        ("Saturation", "saturation"),
        ("Temperature", "temperature"),
        ("Tint", "tint"),
        ("Highlights", "highlights"),
        ("Shadows", "shadows"),
    ];

    for (label, name) in adj_names.iter() {
        let value = adjustments
            .as_ref()
            .map(|a| match *name {
                "exposure" => a.exposure,
                "contrast" => a.contrast,
                "saturation" => a.saturation,
                "temperature" => a.temperature,
                "tint" => a.tint,
                "highlights" => a.highlights,
                "shadows" => a.shadows,
                _ => 0.0,
            })
            .unwrap_or(0.0);

        // Label
        app.fonts.text(s, x0, y + 4.0, label, T10, C_DIM, Wt::Reg);

        // Slider track
        let slider_r = Rect::new(x0 + 100.0, y, x0 + 220.0, y + 20.0);
        fill_rrect(s, slider_r, R_SM, C_FIELD);

        // Slider fill (centered at 0)
        let center = (slider_r.x0 + slider_r.x1) / 2.0;
        let fill_x = center + (value as f64 * slider_r.width() / 2.0);
        let fill_r = Rect::new(
            center.min(fill_x),
            slider_r.y0 + 2.0,
            center.max(fill_x),
            slider_r.y1 - 2.0,
        );
        fill_rrect(s, fill_r, R_XS, C_ACCENT);

        // Value label
        let val_label = format!("{:.0}%", value * 100.0);
        app.fonts
            .text(s, x0 + 230.0, y + 4.0, &val_label, T10, C_TEXT, Wt::Mono);

        // Hit area for slider
        // A click is a real slider write, not a fixed demo increment: the
        // hit action is rebuilt every frame from the pointer position, so
        // the selected x-coordinate maps to the full [-1, 1] model range.
        let pointer_value =
            (((app.mouse.x - slider_r.x0) / slider_r.width()) * 2.0 - 1.0).clamp(-1.0, 1.0) as f32;
        hit.push((
            slider_r,
            Action::UpdateImageAdjustment {
                adjustment: name.to_string(),
                value: pointer_value,
            },
        ));

        y += 28.0;
    }

    // Reset button
    let reset_r = Rect::new(x0, y, x0 + 80.0, y + 24.0);
    let hov = hover(app, reset_r);
    fill_rrect(s, reset_r, R_MD, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, reset_r, R_MD, C_LINE, 1.0);
    app.fonts
        .text_center(s, reset_r, "Reset", T10, C_TEXT, Wt::Reg, true);
    hit.push((reset_r, Action::ResetImageAdjustments));

    // Rotate buttons
    let rot_cw_r = Rect::new(x0 + 90.0, y, x0 + 140.0, y + 24.0);
    let hov = hover(app, rot_cw_r);
    fill_rrect(s, rot_cw_r, R_MD, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, rot_cw_r, R_MD, C_LINE, 1.0);
    draw_icon(
        s,
        "rotate-cw",
        rot_cw_r.x0 + 8.0,
        rot_cw_r.y0 + 6.0,
        ICON_XS,
        C_DIM,
    );
    app.fonts.text(
        s,
        rot_cw_r.x0 + 24.0,
        rot_cw_r.y0 + 6.0,
        "90°",
        T10,
        C_TEXT,
        Wt::Reg,
    );
    hit.push((rot_cw_r, Action::RotateImage { clockwise: true }));

    let rot_ccw_r = Rect::new(x0 + 150.0, y, x0 + 200.0, y + 24.0);
    let hov = hover(app, rot_ccw_r);
    fill_rrect(s, rot_ccw_r, R_MD, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, rot_ccw_r, R_MD, C_LINE, 1.0);
    draw_icon(
        s,
        "rotate-ccw",
        rot_ccw_r.x0 + 8.0,
        rot_ccw_r.y0 + 6.0,
        ICON_XS,
        C_DIM,
    );
    app.fonts.text(
        s,
        rot_ccw_r.x0 + 24.0,
        rot_ccw_r.y0 + 6.0,
        "90°",
        T10,
        C_TEXT,
        Wt::Reg,
    );
    hit.push((rot_ccw_r, Action::RotateImage { clockwise: false }));

    y += 32.0;

    y
}

/// Fill / Stroke value row — swatch + hex + alpha + eye + minus.
#[allow(clippy::too_many_arguments)]
fn paint_paint_row(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    rx: f64,
    rw: f64,
    pl: f64,
    y: f64,
    hex: &str,
    hex_field: FieldId,
    alpha_field: FieldId,
    is_fill: bool,
) -> f64 {
    let inner_w = rw - pl * 2.0;
    let h = 28.0;
    // hex field + library 24 + pipette 24 + alpha % 64 + eye 24 + remove 24,
    // gaps of 8 (the library button is Figma's fill-row variable/style picker)
    let hex_w = inner_w - 64.0 - 24.0 * 4.0 - 8.0 * 5.0;
    let r = Rect::new(rx + pl, y, rx + pl + hex_w, y + h);
    let hov = hover(app, r);
    fill_rrect(s, r, R_MD, if hov { C_INPUT_HOVER } else { C_FIELD });
    stroke_rrect(s, r, R_MD, C_LINE, 1.0);
    let sw = Rect::new(r.x0 + 8.0, y + 7.0, r.x0 + 22.0, y + 21.0);
    let color = parse_hex(hex).unwrap_or(vello::peniko::Color::from_rgb8(255, 255, 255));
    fill_rrect(s, sw, R_SM, color);
    if !is_fill {
        stroke_rrect(s, sw, R_SM, C_LINE_2, 1.0);
    }
    if hover(app, sw) {
        stroke_rrect(s, sw.inflate(1.5, 1.5), R_SM, C_ACCENT, 1.5);
    }
    // A bound fill shows WHAT it is bound to, not the value it happens to
    // resolve to: the variable's name (Figma's fill row) or the style's.
    let selected = app.doc().selected_id();
    let var_name = selected
        .as_deref()
        .and_then(|id| match app.paint_of(id, is_fill) {
            Some(Paint::Variable(n)) => Some(n),
            _ => None,
        });
    let linked_style = selected
        .as_deref()
        .and_then(|id| app.linked_paint_style(id));
    // ...unless the field is open: what the user is typing always wins
    let editing = app.field.as_ref().is_some_and(|f| f.id == hex_field);
    let shown = if editing {
        field_val(app, hex_field, hex.to_string())
    } else {
        match (&var_name, &linked_style) {
            (Some(n), _) => n.clone(),
            (None, Some(n)) => n.clone(),
            (None, None) => field_val(app, hex_field, hex.to_string()),
        }
    };
    app.fonts
        .text(s, sw.x1 + 8.0, y + 8.0, &shown, T11, C_TEXT, Wt::Mono);
    // Register the broad text field first so the later, smaller swatch hit
    // wins during reverse hit-testing.
    hit.push((r, Action::Field(hex_field)));
    hit.push((sw, Action::ToggleColorPicker(is_fill)));
    // P14: eyedropper — sample a layer's paint (was an unreachable action)
    let pd = Rect::new(r.x1 + 8.0, y + 2.0, r.x1 + 8.0 + 24.0, y + 26.0);
    let drop_armed = app.eyedropper == Some(!is_fill);
    if hover(app, pd) || drop_armed {
        fill_rrect(s, pd, R_MD, if drop_armed { C_SEL } else { C_FIELD_2 });
    }
    draw_icon(
        s,
        "pipette",
        pd.x0 + 5.0,
        pd.y0 + 5.0,
        ICON_SM,
        if drop_armed { C_ON_ACCENT } else { C_DIM },
    );
    tip(app, pd, "Eyedropper: sample a layer's fill / stroke");
    hit.push((pd, Action::EnableEyedropper(!is_fill)));
    // the paint library: variables and paint styles for this row
    let lr = Rect::new(pd.x1 + 8.0, y + 2.0, pd.x1 + 8.0 + 24.0, y + 26.0);
    let lib_open = app.paint_lib == Some(is_fill);
    let bound = var_name.is_some() || linked_style.is_some();
    if hover(app, lr) || lib_open || bound {
        fill_rrect(s, lr, R_MD, if lib_open { C_SEL } else { C_FIELD_2 });
    }
    draw_icon(
        s,
        "grid-2x2",
        lr.x0 + 5.0,
        lr.y0 + 5.0,
        ICON_SM,
        if lib_open {
            // solid selection fill → the palette's on_accent ink; accent_ink
            // is the ink for accent on a *surface*, and washed out here
            C_ON_ACCENT
        } else if bound {
            C_TEXT
        } else {
            C_DIM
        },
    );
    tip(
        app,
        lr,
        if bound {
            "Linked — rebind, or detach to keep this colour"
        } else {
            "Bind to a variable / apply a paint style"
        },
    );
    hit.push((lr, Action::PaintLibToggle(is_fill)));
    if lib_open {
        // the popover anchors to this row (panel y depends on the scroll)
        app.paint_lib_at = Some((rx + pl, y + h + 4.0));
    }
    let ar = Rect::new(lr.x1 + 8.0, y, lr.x1 + 8.0 + 64.0, y + h);
    input(
        app,
        s,
        hit,
        ar,
        Some(("%", T10)),
        &field_val(app, alpha_field, "100".into()),
        false,
        Some(Action::Field(alpha_field)),
        Some("chevron-down"),
    );
    let e1 = Rect::new(ar.x1 + 8.0, y + 2.0, ar.x1 + 8.0 + 24.0, y + 2.0 + 24.0);
    let paint_visible = paint_layer_visible(app, is_fill);
    if hover(app, e1) || !paint_visible {
        fill_rrect(s, e1, R_MD, C_FIELD_2);
    }
    draw_icon(
        s,
        if paint_visible { "eye" } else { "eye-off" },
        e1.x0 + 5.0,
        e1.y0 + 5.0,
        ICON_SM,
        if paint_visible { C_DIM } else { C_TEXT },
    );
    hit.push((e1, Action::TogglePaintVisibility(is_fill)));
    let e2 = Rect::new(e1.x1 + 8.0, y + 2.0, e1.x1 + 8.0 + 24.0, y + 2.0 + 24.0);
    if hover(app, e2) {
        fill_rrect(s, e2, R_MD, C_FIELD);
    }
    draw_icon(s, "minus", e2.x0 + 6.0, e2.y0 + 6.0, ICON_XS, C_DIM);
    hit.push((
        e2,
        if is_fill {
            Action::RemoveFill
        } else {
            Action::RemoveStroke
        },
    ));
    y + h
}

// -------------------------------------------------------- frame dropdown

/// Zoom menu (audit F4): the zoom% in the right header opens it;
/// in/out/100%/selection/fit with the real shortcut hints.
fn paint_zoom_dropdown(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let x0 = reg.right.x0 + 20.0;
    let y0 = ED_TITLE_H + 42.0;
    let items = [
        ("zoom-in", "Zoom in", "⌘="),
        ("zoom-out", "Zoom out", "⌘-"),
        ("target", "Zoom to 100%", "⌘0"),
        ("box-select", "Zoom to selection", "⇧0"),
        ("maximize", "Zoom to fit", "⇧1"),
    ];
    let dd = Rect::new(x0, y0, x0 + 190.0, y0 + items.len() as f64 * DROPDOWN_ROW_H);
    elev_shadow(s, dd, 8.0, Elevation::Floating);
    fill_rrect(s, dd, R_LG, C_FIELD);
    stroke_rrect(s, dd, R_LG, C_LINE_2, 1.0);
    for (i, (ic, name, sc)) in items.into_iter().enumerate() {
        let r = Rect::new(
            x0,
            y0 + DROPDOWN_ROW_H * i as f64,
            x0 + 190.0,
            y0 + DROPDOWN_ROW_H * (i + 1) as f64,
        );
        if hover(app, r) {
            fill_rect(s, r, C_FIELD_2);
        }
        draw_icon(s, ic, r.x0 + 10.0, r.y0 + 8.0, ICON_SM, C_DIM);
        app.fonts
            .text(s, r.x0 + 32.0, r.y0 + 9.0, name, T11, C_TEXT, Wt::Reg);
        app.fonts
            .text_right(s, r.x1 - 10.0, r.y0 + 10.0, sc, T10, C_DIM, Wt::Reg, 0.0);
        hit.push((r, Action::ZoomStep(i)));
    }
}

fn paint_frame_dropdown(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let pl = 12.0;
    let inner_w = reg.right.x1 - reg.right.x0 - pl * 2.0;
    let fd_w = inner_w - 90.0 - SQ_BTN - SQ_BTN - 8.0 * 3.0;
    let dx = reg.right.x0 + pl;
    let dy = ED_TITLE_H + 8.0 + 24.0 + 10.0 + PILL_H + 10.0 + 1.0 + 12.0 + 32.0;
    let dd = Rect::new(dx, dy, dx + fd_w, dy + 5.0 * DROPDOWN_ROW_H);
    elev_shadow(s, dd, 8.0, Elevation::Floating);
    fill_rrect(s, dd, R_LG, C_FIELD);
    stroke_rrect(s, dd, R_LG, C_LINE_2, 1.0);
    for (i, (name, w, h)) in FRAME_PRESETS.into_iter().enumerate() {
        let r = Rect::new(
            dx,
            dy + DROPDOWN_ROW_H * i as f64,
            dx + fd_w,
            dy + DROPDOWN_ROW_H * (i + 1) as f64,
        );
        if hover(app, r) || i == 0 {
            fill_rect(s, r, if hover(app, r) { C_FIELD_2 } else { C_FIELD });
        }
        app.fonts.text(
            s,
            r.x0 + 10.0,
            r.y0 + 10.0,
            name,
            T11,
            if i == 0 { C_TEXT } else { C_MUTED },
            Wt::Reg,
        );
        let dims = format!("{} × {}", w as i64, h as i64);
        let dw = app.fonts.measure(&dims, T10, Wt::Reg);
        app.fonts
            .text(s, r.x1 - 10.0 - dw, r.y0 + 11.0, &dims, T10, C_DIM, Wt::Reg);
        hit.push((r, Action::FramePreset(i)));
    }
}

/// Line-height mode menu (Figma): Auto / Pixels / Percent, anchored under
/// the Line height field. Same design language as the frame dropdown.
fn paint_lh_dropdown(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let x0 = reg.right.x0 + 13.0; // panel border + padding (cols x0)
                                  // Panel rows live at `y_entry - scroll + offset`, where `y_entry` is the
                                  // pixel after the pill-tab divider: `ED_TITLE_H` plus the same chrome sum
                                  // `paint_frame_dropdown` builds (8 + 24 + 10 + PILL_H + 10 + 1 = 77, +12
                                  // to the first row = 89). Anchoring on `ED_TITLE_H` alone floated this
                                  // menu 89px above the Line-height field it belongs to.
    let y_entry = crate::theme::ED_TITLE_H + 89.0;
    // the typography rows scroll with the panel
    let fy = y_entry + 771.0 - app.doc().scroll_right;
    let dd = Rect::new(x0, fy + 28.0, x0 + 153.5, fy + 28.0 + 3.0 * DROPDOWN_ROW_H);
    elev_shadow(s, dd, 8.0, Elevation::Floating);
    fill_rrect(s, dd, R_LG, C_FIELD);
    stroke_rrect(s, dd, R_LG, C_LINE_2, 1.0);
    let mode = app.selected_text_typo().map(|t| t.lh_mode).unwrap_or(0);
    for (i, name) in ["Auto", "Pixels", "Percent"].into_iter().enumerate() {
        let r = Rect::new(
            dd.x0,
            dd.y0 + DROPDOWN_ROW_H * i as f64,
            dd.x1,
            dd.y0 + DROPDOWN_ROW_H * (i + 1) as f64,
        );
        let hov = hover(app, r);
        if hov {
            fill_rect(s, r, C_FIELD_2);
        }
        let active = (i as u8) == mode || (i == 1 && mode == 1) || (i == 2 && mode == 2);
        app.fonts.text(
            s,
            r.x0 + 10.0,
            r.y0 + 10.0,
            name,
            T11,
            if hov || active { C_TEXT } else { C_MUTED },
            Wt::Reg,
        );
        hit.push((r, Action::LhMode(i)));
    }
}

/// Text-style picker (Figma's Typography ▸ styles button): every text style in
/// the document, then the rows that act on the current selection — Update and
/// Detach when the selection is linked to a style, Create when it is a text
/// layer. Same design language as the line-height menu.
///
/// Panel rows live at `y_entry - scroll + offset`, where `y_entry` is the
/// pixel after the pill-tab divider (`ED_TITLE_H + 89`, see `paint_right`);
/// the anchor below is the Typography header row at offset 658.5.
fn paint_text_style_dropdown(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let x0 = reg.right.x0 + 13.0; // panel border + padding (cols x0)
    let y_entry = crate::theme::ED_TITLE_H + 89.0;
    let fy = y_entry + 658.5 - app.doc().scroll_right;

    let names: Vec<String> = {
        let doc = app.doc();
        doc.doc
            .text_style_names()
            .into_iter()
            .map(str::to_string)
            .collect()
    };
    let selected = app.doc().selected_id();
    let linked = selected.as_deref().and_then(|id| app.linked_text_style(id));
    let is_text = selected
        .as_deref()
        .map(|id| app.is_text_layer(id))
        .unwrap_or(false);

    // (label, action) — a None action is an inert row (the empty state)
    let mut rows: Vec<(String, Option<Action>)> = names
        .iter()
        .map(|n| (n.clone(), Some(Action::ApplyTextStyle(n.clone()))))
        .collect();
    if names.is_empty() {
        rows.push(("No text styles yet".into(), None));
    }
    if let Some(name) = &linked {
        rows.push((
            format!("Update '{name}' from selection"),
            Some(Action::UpdateTextStyleFromSelection),
        ));
        rows.push(("Detach style".into(), Some(Action::DetachTextStyle)));
    }
    if is_text {
        rows.push(("Create text style".into(), Some(Action::CreateTextStyle)));
    }

    let dd = Rect::new(
        x0,
        fy + 22.0,
        x0 + 315.0,
        fy + 22.0 + rows.len() as f64 * DROPDOWN_ROW_H,
    );
    elev_shadow(s, dd, 8.0, Elevation::Floating);
    fill_rrect(s, dd, R_LG, C_FIELD);
    stroke_rrect(s, dd, R_LG, C_LINE_2, 1.0);
    for (i, (label, action)) in rows.into_iter().enumerate() {
        let r = Rect::new(
            dd.x0,
            dd.y0 + DROPDOWN_ROW_H * i as f64,
            dd.x1,
            dd.y0 + DROPDOWN_ROW_H * (i + 1) as f64,
        );
        let hov = hover(app, r);
        if hov {
            fill_rect(s, r, C_FIELD_2);
        }
        // the style this layer already carries is the highlighted row
        let active = linked.as_deref() == Some(label.as_str());
        app.fonts.text(
            s,
            r.x0 + 10.0,
            r.y0 + 10.0,
            &label,
            T11,
            if hov || active { C_TEXT } else { C_MUTED },
            Wt::Reg,
        );
        if let Some(a) = action {
            hit.push((r, a));
        }
    }
}

// -------------------------------------------------------- paint library

/// One row of the fill/stroke library popover. `Section` and `Note` are inert;
/// every `Item` carries the action its click dispatches.
enum LibRow {
    Section(&'static str),
    Note(String),
    Item {
        label: String,
        swatch: Option<Color>,
        icon: Option<&'static str>,
        active: bool,
        action: Action,
    },
}

const LIB_W: f64 = 300.0;
const LIB_ITEM_H: f64 = 26.0;
const LIB_SECTION_H: f64 = 24.0;
const LIB_NOTE_H: f64 = 22.0;
const LIB_MAX_VARS: usize = 8;
const LIB_MAX_STYLES: usize = 6;

/// The popover's rect and rows for this frame. Pure, so the painter and the
/// pointer-cursor test read the same thing: what is drawn and what is
/// clickable cannot disagree (the same rule as the dashboard's hit list).
fn paint_library(app: &App) -> Option<(Rect, Vec<LibRow>)> {
    let is_fill = app.paint_lib?;
    let (ax, ay) = app.paint_lib_at?;
    let selected = app.doc_ref().selected_id();
    let bound_var = selected
        .as_deref()
        .and_then(|id| match app.paint_of(id, is_fill) {
            Some(Paint::Variable(n)) => Some(n),
            _ => None,
        });
    let linked_style = selected
        .as_deref()
        .and_then(|id| app.linked_paint_style(id));

    // what the file has to offer: colour variables (active mode resolved) and
    // paint styles, both sorted by name
    let doc = &app.doc_ref().doc;
    let vars: Vec<(String, Color)> = doc
        .variables
        .catalog()
        .into_iter()
        .filter(|(_, _, kind)| *kind == "color")
        .map(|(_, name, _)| {
            // resolves aliases and the active mode; the fallback role only
            // shows if a name vanished between the catalog and this call
            let c = doc.variables.color(name.as_str(), C_MUTED);
            (name, c)
        })
        .collect();
    let mut styles: Vec<(String, Color)> = doc
        .styles
        .iter()
        .filter_map(|(name, st)| match st {
            x_native::LegacyStyle::Paint { fill } => {
                Some((name.clone(), x_native::paint_color(fill, &doc.variables)))
            }
            _ => None,
        })
        .collect();
    // by name: a Color is not Ord (and sorting by colour would be useless)
    styles.sort_by(|a, b| a.0.cmp(&b.0));

    let mut rows = Vec::new();
    rows.push(LibRow::Section(if is_fill { "FILL" } else { "STROKE" }));
    rows.push(LibRow::Section("VARIABLES"));
    if vars.is_empty() {
        rows.push(LibRow::Note("No colour variables in this file".into()));
    } else {
        for (name, c) in vars.iter().take(LIB_MAX_VARS) {
            rows.push(LibRow::Item {
                label: name.clone(),
                swatch: Some(*c),
                icon: None,
                active: bound_var.as_deref() == Some(name.as_str()),
                action: Action::ApplyPaintVariable(is_fill, name.clone()),
            });
        }
        if vars.len() > LIB_MAX_VARS {
            let extra = vars.len() - LIB_MAX_VARS;
            rows.push(LibRow::Note(format!("+{extra} more in Variables (⌥5)")));
        }
    }
    rows.push(LibRow::Section("PAINT STYLES"));
    if !is_fill {
        // a paint style is `LegacyStyle::Paint { fill }`: applying one to a
        // stroke would be a lie, so the stroke row says so instead
        rows.push(LibRow::Note(
            "This engine's paint styles are fills — bind a variable here".into(),
        ));
    } else if styles.is_empty() {
        rows.push(LibRow::Note("No paint styles in this file".into()));
    } else {
        for (name, c) in styles.iter().take(LIB_MAX_STYLES) {
            rows.push(LibRow::Item {
                label: name.clone(),
                swatch: Some(*c),
                icon: None,
                active: linked_style.as_deref() == Some(name.as_str()),
                action: Action::ApplyPaintStyle(name.clone()),
            });
        }
    }
    if bound_var.is_some() || linked_style.is_some() {
        rows.push(LibRow::Item {
            label: "Detach — keep this colour".into(),
            swatch: None,
            icon: Some("x"),
            active: false,
            action: Action::DetachPaintBinding(is_fill),
        });
    }

    let reg = app.editor_regions();
    let w = (reg.right.width() - 24.0).clamp(180.0, LIB_W);
    let h: f64 = rows
        .iter()
        .map(|r| match r {
            LibRow::Section(_) => LIB_SECTION_H,
            LibRow::Item { .. } => LIB_ITEM_H,
            LibRow::Note(_) => LIB_NOTE_H,
        })
        .sum::<f64>()
        + 8.0;
    // the panel's y depends on the scroll offset, so the anchor comes from the
    // row that opened it; clamp to the window either way
    let y0 = ay.min(app.status_band().y0 - h - 8.0).max(ED_TITLE_H + 4.0);
    Some((Rect::new(ax, y0, ax + w, y0 + h), rows))
}

/// The popover's rect — the pointer test in `cursor_for` reads it.
pub fn paint_lib_rect(app: &App) -> Option<Rect> {
    paint_library(app).map(|(r, _)| r)
}

/// Trim `label` until it fits `budget` px at T11 (popovers must not paint
/// through their own border).
fn fit_label(app: &App, label: &str, budget: f64) -> String {
    let mut out: Vec<char> = label.chars().collect();
    if app.fonts.measure(label, T11, Wt::Reg) <= budget {
        return label.to_string();
    }
    while out.len() > 4 {
        out.pop();
        let probe: String = out.iter().collect::<String>() + "…";
        if app.fonts.measure(&probe, T11, Wt::Reg) <= budget {
            return probe;
        }
    }
    out.iter().collect()
}

fn paint_paint_library(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let Some((dd, rows)) = paint_library(app) else {
        return;
    };
    elev_shadow(s, dd, 8.0, Elevation::Floating);
    fill_rrect(s, dd, R_LG, C_FIELD);
    stroke_rrect(s, dd, R_LG, C_LINE_2, 1.0);
    // the panel swallows clicks in its own padding: an open popover must not
    // arm a canvas tool through the gap between two rows
    hit.push((dd, Action::PaintLibClose));
    let mut y = dd.y0 + 4.0;
    let swatch_w = 12.0;
    for row in rows {
        match row {
            LibRow::Section(title) => {
                app.fonts
                    .micro_label(s, dd.x0 + 10.0, y + 7.0, title, C_DIM, Wt::Med);
                y += LIB_SECTION_H;
            }
            LibRow::Note(text) => {
                app.fonts
                    .text(s, dd.x0 + 10.0, y + 6.0, &text, T10, C_DIM, Wt::Reg);
                y += LIB_NOTE_H;
            }
            LibRow::Item {
                label,
                swatch,
                icon,
                active,
                action,
            } => {
                let r = Rect::new(dd.x0 + 4.0, y, dd.x1 - 4.0, y + LIB_ITEM_H);
                let hov = hover(app, r);
                if hov || active {
                    // hover = raised surface; bound = selection *wash*, not
                    // the solid selection colour: that is near-black in
                    // Daylight, and the label on it disappears
                    fill_rrect(s, r, R_SM, if hov { C_FIELD_2 } else { C_SEL_WASH });
                }
                let mut tx = r.x0 + 10.0;
                if let Some(c) = swatch {
                    let sw = Rect::new(tx, r.y0 + 7.0, tx + swatch_w, r.y0 + 19.0);
                    fill_rrect(s, sw, R_SM, c);
                    stroke_rrect(s, sw, R_SM, C_LINE_2, 1.0);
                    tx = sw.x1 + 8.0;
                } else if let Some(glyph) = icon {
                    draw_icon(s, glyph, tx, r.y0 + 6.0, ICON_SM, C_DIM);
                    tx += 20.0;
                }
                let budget = r.x1 - tx - 26.0;
                let text = fit_label(app, &label, budget);
                app.fonts.text(
                    s,
                    tx,
                    r.y0 + 9.0,
                    &text,
                    T11,
                    if hov || active { C_TEXT } else { C_MUTED },
                    Wt::Reg,
                );
                if active {
                    // the binding this layer already carries (Figma's check)
                    draw_icon(s, "check", r.x1 - 24.0, r.y0 + 6.0, ICON_SM, C_ACCENT_INK);
                }
                hit.push((r, action));
                y += LIB_ITEM_H;
            }
        }
    }
}

// ------------------------------------------------------------ tool dock

fn paint_toolbar(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();

    // Choose tool set based on document type
    let tools: &[Tool] = if app.is_board() {
        // Board tools for infinite canvas
        &[
            Tool::Select,
            Tool::BoardSticky,
            Tool::BoardConnector,
            Tool::Pen,
            Tool::BoardRect,
            Tool::BoardCircle,
            Tool::Text,
            Tool::Hand,
        ]
    } else {
        // Design tools for artboard-based work — the full tool set
        // (audit F2: eraser, symmetry and comment were keyboard-only
        // before; the toolbar is the tool hub)
        &[
            Tool::Select,
            Tool::Scale,
            Tool::Frame,
            Tool::Slice,
            Tool::Text,
            Tool::Rect,
            Tool::Ellipse,
            Tool::Pen,
            Tool::Pencil,
            Tool::Eraser,
            Tool::Symmetry,
            Tool::Comment,
            Tool::Hand,
        ]
    };
    // Audited (canvas 280..1100 @900): container 523×40 r12 at bottom-5
    // (y = win_h − 60); icons 32px pitch 36 starting +7; divider mid-gap
    // after thirteen tools (Scale, the Slice tool and the Pencil joined the
    // row); palette btn at +484 from container left.
    let bar_w = 523.0;
    let bar_x0 = reg.canvas.x0 + (reg.canvas.x1 - reg.canvas.x0 - bar_w) / 2.0;
    let bar_y0 = app.win_h - TOOLBAR_BOTTOM - TOOLBAR_H;
    let bar = Rect::new(bar_x0, bar_y0, bar_x0 + bar_w, bar_y0 + TOOLBAR_H);
    elev_shadow(s, bar, 12.0, Elevation::Raised);
    fill_rrect(s, bar, R_TOOLBAR, C_TOOLBAR);
    stroke_rrect(s, bar, R_TOOLBAR, C_LINE_2, 1.0);

    for (i, t) in tools.iter().enumerate() {
        let x = bar.x0 + 7.0 + 36.0 * i as f64;
        let r = Rect::new(x, bar.y0 + 4.0, x + TOOL_ICON, bar.y0 + 4.0 + TOOL_ICON);
        let active = app.tool == *t;
        let hov = hover(app, r);
        if active {
            fill_rrect(s, r, R_TOOL_ICON, C_TEXT);
        } else if hov {
            fill_rrect(s, r, R_TOOL_ICON, C_FIELD_2);
        }
        draw_icon(
            s,
            t.icon(),
            r.x0 + (TOOL_ICON - 16.0) / 2.0,
            r.y0 + (TOOL_ICON - 16.0) / 2.0,
            ICON_MD,
            // the active chip is *inverted*: fill text_primary, ink
            // background — the same pair the dashboard's primary button
            // uses. A literal black ink vanished on Daylight, whose
            // text_primary is near-black.
            if active { C_BG } else { C_DIM },
        );
        let sc = t.shortcut_hint(app.is_board());
        let tl = if sc.is_empty() {
            t.label().to_string()
        } else {
            format!("{} ({})", t.label(), sc)
        };
        tip(app, r, &tl);
        hit.push((r, Action::Tool(*t)));
    }
    // divider between hand (ends +471) and palette (+484)
    let dx = bar.x0 + 479.5;
    fill_rect(
        s,
        Rect::new(dx, bar.y0 + 10.0, dx + 1.0, bar.y1 - 10.0),
        C_LINE_2,
    );
    // search → palette
    let sx = bar.x0 + 484.0;
    let sr = Rect::new(sx, bar.y0 + 4.0, sx + TOOL_ICON, bar.y0 + 4.0 + TOOL_ICON);
    if hover(app, sr) {
        fill_rrect(s, sr, R_TOOL_ICON, C_FIELD_2);
    }
    draw_icon(s, "search", sr.x0 + 8.0, sr.y0 + 8.0, ICON_MD, C_DIM);
    tip(app, sr, "Command palette (⌘K)");
    hit.push((sr, Action::PaletteToggle));
}

// ------------------------------------------------------- canvas overlays

/// The size badge is only drawn when the selection's SCREEN bounding box
/// actually occupies area — a zero-size node would otherwise print a
/// meaningless "0 × 0" under empty canvas.
pub(crate) fn size_badge_visible(bb: &Rect) -> bool {
    bb.width() > 0.5 && bb.height() > 0.5
}

/// Figma keeps slices visible as regions rather than layers: a dashed outline
/// per slice plus the slice's name, which is also how you reach one on the
/// canvas. Editor chrome only — nothing here reaches an export (`prepare_export`
/// builds its tree from the document, and the frame-name label strip skips
/// keys this painter never emits).
fn paint_slice_chrome(app: &mut App, s: &mut Scene) {
    let Some(doc) = app.doc_opt() else {
        return;
    };
    let mut slices: Vec<(String, Rect)> = vec![];
    fn walk(n: &Node, ox: f64, oy: f64, out: &mut Vec<(String, Rect)>) {
        let (x, y) = (ox + n.transform.x, oy + n.transform.y);
        if n.visible && matches!(n.kind, NodeKind::Slice) {
            out.push((n.name.clone(), Rect::new(x, y, x + n.w, y + n.h)));
        }
        for c in &n.children {
            walk(c, x, y, out);
        }
    }
    for c in &doc.editor_ref().root.children {
        walk(c, 0.0, 0.0, &mut slices);
    }
    if slices.is_empty() {
        return;
    }
    let reg = app.editor_regions();
    for (name, wr) in slices {
        let a = app.world_to_screen(Point::new(wr.x0, wr.y0));
        let b = app.world_to_screen(Point::new(wr.x1, wr.y1));
        let r = Rect::new(a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y));
        stroke_rect_dashed(s, r, C_SEL, 1.0, 6.0, 4.0);
        let tw = app.fonts.measure(&name, T10, Wt::Reg) + 12.0;
        let cy = (r.y0 - 18.0).max(reg.canvas.y0 + 2.0);
        let chip = Rect::new(r.x0, cy, r.x0 + tw, cy + 16.0);
        fill_rrect(s, chip, R_SM, C_TEXT);
        app.fonts
            .text_center(s, chip, &name, T10, C_BASE, Wt::Med, true);
    }
}

fn paint_canvas_overlays(app: &mut App, s: &mut Scene) {
    paint_slice_chrome(app, s);
    let doc = match app.doc_opt() {
        Some(d) => d,
        None => return,
    };

    // NOTE: board-mode grid + nodes are painted by the render paths in
    // run.rs (crate::board_ui::paint_grid / paint_nodes) before editor
    // overlays are layered on top — nothing board-specific to do here.

    // selection outlines + handles
    let sel = doc.editor_ref().selection.clone();

    // Figma hover: subtle outline on the layer under the cursor
    if let Some(hid) = app.hover_node.clone() {
        if !sel.contains(&hid) && app.text_edit.as_deref() != Some(hid.as_str()) {
            if let Some(n) = find_node(&doc.editor_ref().root, hid.as_str()) {
                let p0 = app.world_to_screen(Point::new(n.transform.x, n.transform.y));
                let p1 = app.world_to_screen(Point::new(n.transform.x + n.w, n.transform.y + n.h));
                stroke_rect(
                    s,
                    Rect::new(p0.x, p0.y, p1.x, p1.y).inflate(1.5, 1.5),
                    C_SEL,
                    1.5,
                );
            }
        }
    }

    // size badge: "W × H" under the selection (Figma), hidden while editing
    if app.text_edit.is_none() && !sel.is_empty() {
        let mut bb: Option<Rect> = None;
        for id in &sel {
            if let Some(n) = find_node(&doc.editor_ref().root, id) {
                let p0 = app.world_to_screen(Point::new(n.transform.x, n.transform.y));
                let p1 = app.world_to_screen(Point::new(n.transform.x + n.w, n.transform.y + n.h));
                let r = Rect::new(p0.x, p0.y, p1.x, p1.y);
                bb = Some(match bb {
                    None => r,
                    Some(b) => b.union(r),
                });
            }
        }
        if let Some(b) = bb {
            // a degenerate union (zero-size node) has no area to measure —
            // printing "0 × 0" under empty canvas is noise
            if size_badge_visible(&b) {
                let label = format!(
                    "{} \u{d7} {}",
                    b.width().round() as i64,
                    b.height().round() as i64
                );
                let tw = app.fonts.measure(&label, 10.0, Wt::Mono);
                let bw = (tw + 12.0).ceil();
                let cx = (b.x0 + b.x1) / 2.0;
                let by = b.y1 + 8.0;
                let reg = app.editor_regions();
                if by + 16.0 <= reg.canvas.y1 {
                    let br = Rect::new(cx - bw / 2.0, by, cx + bw / 2.0, by + 16.0);
                    // accent + on_accent: the audited label-on-fill pair
                    // (5.4:1 Graphite, 8.4:1 Daylight). text_primary on the
                    // selection colour was 4.0:1 in Graphite and 2.0:1 in
                    // Daylight — a drag readout you cannot read.
                    fill_rrect(s, br, R_SM, C_ACCENT);
                    app.fonts.text(
                        s,
                        br.x0 + 6.0,
                        by + 0.5,
                        &label,
                        10.0,
                        C_ON_ACCENT,
                        Wt::Mono,
                    );
                }
            }
        }
    }

    for id in &sel {
        // text editing = caret mode: no box, no handles for that node
        if app.text_edit.as_deref() == Some(id.as_str()) {
            continue;
        }
        if let Some(n) = find_node(&doc.editor_ref().root, id) {
            // A transformed node is outlined through its REAL corners, the
            // same four the renderer produces and the same four the resize
            // grab hit-tests — one geometry for paint and input.
            if sel.len() == 1 && is_transformed(n) {
                // world_corners order is the app's handle numbering:
                // 0 TL, 1 TR, 2 BL, 3 BR
                let corners: Vec<Point> = x_native::editor::world_corners(n)
                    .iter()
                    .map(|(wx, wy)| app.world_to_screen(Point::new(*wx, *wy)))
                    .collect();
                // push the outline 1.5px off the shape's edge (same intent as
                // the `inflate` on the axis-aligned path below)
                let cx = corners.iter().map(|p| p.x).sum::<f64>() / 4.0;
                let cy = corners.iter().map(|p| p.y).sum::<f64>() / 4.0;
                let out: Vec<Point> = corners
                    .iter()
                    .map(|p| {
                        let (dx, dy) = (p.x - cx, p.y - cy);
                        let len = (dx * dx + dy * dy).sqrt().max(1e-6);
                        Point::new(p.x + dx / len * 1.5, p.y + dy / len * 1.5)
                    })
                    .collect();
                // edges: TL-TR, TR-BR, BR-BL, BL-TL
                for (a, b) in [(0usize, 1usize), (1, 3), (3, 2), (2, 0)] {
                    line(s, out[a].x, out[a].y, out[b].x, out[b].y, C_SEL, 1.5);
                }
                for h in &corners {
                    fill_rrect(
                        s,
                        Rect::new(h.x - 3.5, h.y - 3.5, h.x + 3.5, h.y + 3.5),
                        1.0,
                        C_TEXT,
                    );
                    stroke_rrect(
                        s,
                        Rect::new(h.x - 3.5, h.y - 3.5, h.x + 3.5, h.y + 3.5),
                        1.0,
                        C_SEL,
                        1.0,
                    );
                }
                continue;
            }
            let p0 = app.world_to_screen(Point::new(n.transform.x, n.transform.y));
            let p1 = app.world_to_screen(Point::new(n.transform.x + n.w, n.transform.y + n.h));
            let r = Rect::new(p0.x, p0.y, p1.x, p1.y);
            // Figma-style: the blue outline sits OUTSIDE the bounds so the
            // node's own fill edge stays visible (white) inside the line
            stroke_rect(s, r.inflate(1.5, 1.5), C_SEL, 1.5);
            // corner handles only on a single selection; a multi-select
            // gets ONE combined box below (Figma convention)
            if sel.len() == 1 {
                for (hx, hy) in [(r.x0, r.y0), (r.x1, r.y0), (r.x0, r.y1), (r.x1, r.y1)] {
                    // white square handles with blue border
                    fill_rrect(
                        s,
                        Rect::new(hx - 3.5, hy - 3.5, hx + 3.5, hy + 3.5),
                        1.0,
                        C_TEXT,
                    );
                    stroke_rrect(
                        s,
                        Rect::new(hx - 3.5, hy - 3.5, hx + 3.5, hy + 3.5),
                        1.0,
                        C_SEL,
                        1.0,
                    );
                }
            }
        }
    }
    // Vector-editing affordances: with the Pen tool active, the selected
    // vector node shows its anchors and bezier control handles. Both come
    // from the engine's WORLD-space layer, so they sit on the shape even
    // when the node is rotated or scaled — path data is local, the canvas
    // is not, and drawing one in the other's coordinates is the bug.
    if app.tool == Tool::Pen && sel.len() == 1 {
        if let Some(n) = find_node(&doc.editor_ref().root, &sel[0]) {
            let anchors = x_native::editor::anchors_world(n);
            let handles = x_native::editor::handles_world(n);
            // tangent lines first so the points draw on top of them
            for (idx, _outgoing, (hx, hy)) in &handles {
                if let Some(a) = anchors.iter().find(|a| a.index == *idx) {
                    let p0 = app.world_to_screen(Point::new(a.x, a.y));
                    let p1 = app.world_to_screen(Point::new(*hx, *hy));
                    line(s, p0.x, p0.y, p1.x, p1.y, C_SEL, 1.0);
                }
            }
            for (_idx, _outgoing, (hx, hy)) in &handles {
                let p = app.world_to_screen(Point::new(*hx, *hy));
                let r = Rect::new(p.x - 3.0, p.y - 3.0, p.x + 3.0, p.y + 3.0);
                fill_rrect(s, r, R_SM, C_TEXT);
                stroke_rrect(s, r, R_SM, C_SEL, 1.0);
            }
            for a in &anchors {
                let p = app.world_to_screen(Point::new(a.x, a.y));
                let r = Rect::new(p.x - 3.5, p.y - 3.5, p.x + 3.5, p.y + 3.5);
                fill_rrect(s, r, 1.0, C_TEXT);
                stroke_rrect(s, r, 1.0, C_SEL, 1.0);
            }
        }
    }

    // multi-select: one COMBINED bounding box with corner-only handles
    // (Figma convention) around all selected layers
    if sel.len() > 1 {
        let mut u = Rect::new(
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for id in &sel {
            if let Some(n) = find_node(&doc.editor_ref().root, id) {
                let p0 = app.world_to_screen(Point::new(n.transform.x, n.transform.y));
                let p1 = app.world_to_screen(Point::new(n.transform.x + n.w, n.transform.y + n.h));
                let r = Rect::new(p0.x, p0.y, p1.x, p1.y);
                u = u.union(r);
            }
        }
        if u.x0.is_finite() {
            stroke_rect(s, u.inflate(1.5, 1.5), C_SEL, 1.5);
            for (hx, hy) in [(u.x0, u.y0), (u.x1, u.y0), (u.x0, u.y1), (u.x1, u.y1)] {
                fill_rrect(
                    s,
                    Rect::new(hx - 3.5, hy - 3.5, hx + 3.5, hy + 3.5),
                    1.0,
                    C_TEXT,
                );
                stroke_rrect(
                    s,
                    Rect::new(hx - 3.5, hy - 3.5, hx + 3.5, hy + 3.5),
                    1.0,
                    C_SEL,
                    1.0,
                );
            }
        }
    }
    // pixel grid (DESIGN panel, no selection): 1px world-unit grid drawn
    // over the document when zoomed in (>=800%), opacity = grid_pct
    if app.zoom >= 8.0 && app.grid_pct > 0.0 {
        let reg = app.editor_regions();
        let (ox, oy, z) = app.canvas_transform();
        let a = ((app.grid_pct / 100.0).clamp(0.0, 1.0) * 255.0).round() as u8;
        let gc = vello::peniko::Color::from_rgba8(
            (app.grid_color.components[0] * 255.0).round() as u8,
            (app.grid_color.components[1] * 255.0).round() as u8,
            (app.grid_color.components[2] * 255.0).round() as u8,
            a,
        );
        let x0w = ((reg.canvas.x0 - ox) / z).ceil();
        let x1w = ((reg.canvas.x1 - ox) / z).floor();
        let mut wx = x0w;
        while wx <= x1w {
            let sx = (wx * z + ox).round();
            if sx >= reg.canvas.x0 && sx <= reg.canvas.x1 {
                vline(s, sx, reg.canvas.y0, reg.canvas.y1, gc);
            }
            wx += 1.0;
        }
        let y0w = ((reg.canvas.y0 - oy) / z).ceil();
        let y1w = ((reg.canvas.y1 - oy) / z).floor();
        let mut wy = y0w;
        while wy <= y1w {
            let sy = (wy * z + oy).round();
            if sy >= reg.canvas.y0 && sy <= reg.canvas.y1 {
                hline(s, reg.canvas.x0, reg.canvas.x1, sy, gc);
            }
            wy += 1.0;
        }
    }
    // marquee — the drag stores WORLD corners (the same pair `marquee()`
    // hit-tests with on release), so the band has to be projected into
    // screen space before it is drawn. Drawing the raw world pair put the
    // band somewhere other than the cursor as soon as the canvas was panned
    // or zoomed.
    if let Some(crate::state::Drag::Marquee { start, cur, .. }) = &app.drag {
        let a = app.world_to_screen(*start);
        let b = app.world_to_screen(*cur);
        let r = Rect::new(a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y));
        fill_rect(s, r, C_SEL_SOFT);
        stroke_rect(s, r, C_SEL, 1.0);
    }
    // anchor lasso (vector edit mode): the same rubber band, drawn over the
    // points it is about to select
    if let Some(crate::state::Drag::VectorLasso { start, cur }) = &app.drag {
        let a = app.world_to_screen(*start);
        let b = app.world_to_screen(*cur);
        let r = Rect::new(a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y));
        fill_rect(s, r, C_SEL_SOFT);
        stroke_rect(s, r, C_SEL, 1.0);
    }
    // shape-tool create — Figma shows the pending shape and its size while you
    // drag ("You'll see the rectangle's dimensions underneath the bottom
    // edge"). The rect comes from `state::create_rect`, the same rule the commit
    // uses, ⌥ included, so the preview cannot disagree with what lands.
    if let Some(crate::state::Drag::Create { tool, start, cur }) = &app.drag {
        let reg = app.editor_regions();
        let wr = crate::state::create_rect(*start, *cur, app.alt);
        let a = app.world_to_screen(Point::new(wr.x0, wr.y0));
        let b = app.world_to_screen(Point::new(wr.x1, wr.y1));
        let r = Rect::new(a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y));
        if *tool == Tool::Slice {
            // a slice is a region, not a shape: dashed, never filled
            stroke_rect_dashed(s, r, C_SEL, 1.0, 6.0, 4.0);
        } else {
            fill_rect(s, r, C_SEL_SOFT);
            stroke_rect(s, r, C_SEL, 1.0);
        }
        let label = format!("{} × {}", wr.width().round(), wr.height().round());
        let tw = app.fonts.measure(&label, T10, Wt::Reg) + 12.0;
        let bx = r.x0.min(reg.canvas.x1 - tw - 4.0).max(reg.canvas.x0 + 4.0);
        let chip = Rect::new(bx, r.y1 + 6.0, bx + tw, r.y1 + 24.0);
        fill_rrect(s, chip, R_SM, C_TEXT);
        app.fonts
            .text_center(s, chip, &label, T10, C_BASE, Wt::Med, true);
    }
    // scale-tool drag (K) — the same deal as the create preview: the box the
    // gesture will commit, drawn through `state::scaled_box`, with the ratio
    // Figma shows while you scale. Outline only, no fill: this is the
    // selection's own box moving, not a new shape being drawn.
    if let Some(crate::state::Drag::ScaleSel {
        corner,
        orig,
        applied,
        ..
    }) = &app.drag
    {
        let reg = app.editor_regions();
        let wb = crate::state::scaled_box(*orig, *corner, *applied);
        let a = app.world_to_screen(Point::new(wb.x0, wb.y0));
        let b = app.world_to_screen(Point::new(wb.x1, wb.y1));
        let r = Rect::new(a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y));
        stroke_rect(s, r, C_SEL, 1.0);
        let label = format!("{}%", (*applied * 100.0).round() as i64);
        let tw = app.fonts.measure(&label, T10, Wt::Reg) + 12.0;
        let bx = r.x0.min(reg.canvas.x1 - tw - 4.0).max(reg.canvas.x0 + 4.0);
        let chip = Rect::new(bx, r.y1 + 6.0, bx + tw, r.y1 + 24.0);
        fill_rrect(s, chip, R_SM, C_TEXT);
        app.fonts
            .text_center(s, chip, &label, T10, C_BASE, Wt::Med, true);
    }
    // pen preview
    if let Some(crate::state::Drag::Pen { points, cursor }) = &app.drag {
        let mut prev: Option<Point> = None;
        for p in points {
            let sp = app.world_to_screen(*p);
            if let Some(q) = prev {
                line(s, q.x, q.y, sp.x, sp.y, C_SEL, 1.5);
            }
            circle(s, sp.x, sp.y, 2.5, C_SEL);
            prev = Some(sp);
        }
        if let (Some(q), Some(c)) = (prev, cursor) {
            let sp = app.world_to_screen(*c);
            line(s, q.x, q.y, sp.x, sp.y, C_SEL_SOFT, 1.0);
        }
    }

    // pencil preview: the stroke is the ink, so it is drawn in the ink — the
    // same colour and the same weight `finish_pencil` commits, scaled by zoom
    if let Some(crate::state::Drag::Pencil { points }) = &app.drag {
        let w = (crate::state::PENCIL_WEIGHT * app.zoom).clamp(1.0, 48.0);
        let ink = crate::state::pencil_ink();
        let mut prev: Option<Point> = None;
        for p in points {
            let sp = app.world_to_screen(*p);
            if let Some(q) = prev {
                line(s, q.x, q.y, sp.x, sp.y, ink, w);
            }
            prev = Some(sp);
        }
    }

    // First-run empty state (P0-10): an empty canvas says nothing, so the
    // canvas says it. The hint is pure paint — it leaves the moment the
    // first frame lands, no flag to clear, no button to dismiss.
    if !app.is_board()
        && doc
            .editors
            .get(doc.page)
            .is_some_and(|ed| ed.root.children.is_empty())
    {
        let reg = app.editor_regions();
        let cx = (reg.canvas.x0 + reg.canvas.x1) / 2.0;
        let cy = (reg.canvas.y0 + reg.canvas.y1) / 2.0;
        let l1 = "Add your first frame";
        let l2 = "Pick the frame tool in the dock below, then drag on the canvas.";
        let l3 = "Then connect screens in FLOW, and export from SHIP.";
        let w1 = app.fonts.measure(l1, T14, Wt::Med);
        let w2 = app.fonts.measure(l2, T11, Wt::Reg);
        let w3 = app.fonts.measure(l3, T11, Wt::Reg);
        let bw = w1.max(w2).max(w3) + 24.0;
        // only claim the canvas centre when the hint fits inside it
        if cx - bw / 2.0 > reg.canvas.x0 + 16.0
            && cx + bw / 2.0 < reg.canvas.x1 - 16.0
            && cy - 36.0 > reg.canvas.y0 + 16.0
            && cy + 34.0 < reg.canvas.y1 - 16.0
        {
            app.fonts
                .text(s, cx - w1 / 2.0, cy - 30.0, l1, T14, C_MUTED, Wt::Med);
            app.fonts
                .text(s, cx - w2 / 2.0, cy - 4.0, l2, T11, C_DIM, Wt::Reg);
            app.fonts
                .text(s, cx - w3 / 2.0, cy + 16.0, l3, T11, C_DIM, Wt::Reg);
        }
    }

    // comment pins render ABOVE the selection chrome (Figma z-order)
    paint_comments(app, s);
}

// --------------------------------------------------------- field carets

fn paint_carets(app: &mut App, s: &mut Scene) {
    let Some(f) = app.field.clone() else { return };
    // locate the active field's rect from hit zones (fields register Action::Field)
    for (r, a) in &app.hit {
        if let Action::Field(id) = a {
            if *id == f.id {
                // The field receiving keystrokes gets an outline. Fields carry
                // no hairline at rest (see `input_box`), so without this the one
                // being typed into looked exactly like its seven neighbours.
                // Three fields paint their own edit chrome — the doc-name row
                // and the two variables-panel rows — so they are left alone
                // rather than ringed twice, and the layers search is a 6px box.
                if !matches!(id, FieldId::DocName | FieldId::VarName | FieldId::VarValue) {
                    let radius = if matches!(id, FieldId::TreeSearch) {
                        R_MD
                    } else {
                        R_INPUT
                    };
                    stroke_rrect(s, *r, radius, EDIT_BORDER, 1.0);
                }
                let w = app.fonts.measure(&f.buffer, 11.0, Wt::Mono);
                let x = match id {
                    FieldId::DocName => r.x0 + 10.0 + w,
                    // component property input: unlabeled, text at +8
                    FieldId::InstanceProp => r.x0 + 8.0 + w,
                    // find rows: search text at +24 (after the icon),
                    // replace text at +8
                    FieldId::FindQuery => r.x0 + 24.0 + w,
                    FieldId::FindReplace => r.x0 + 8.0 + w,
                    // W/H/X/Y are measurements and sit on the right edge (that
                    // is what `input` does with a mono value), so the caret does
                    // too, 8px in from the field's edge
                    FieldId::W
                    | FieldId::H
                    | FieldId::X
                    | FieldId::Y
                    | FieldId::Rotation
                    | FieldId::Opacity
                    | FieldId::Radius
                    | FieldId::PadH
                    | FieldId::PadV
                    | FieldId::GridPct
                    | FieldId::CanvasBgAlpha => r.x1 - 8.0 - w,
                    // the zoom box ends in a chevron (icon left at x1 − 21)
                    FieldId::Zoom => r.x1 - 25.0 - w,
                    // gap row: chevron in the first field, clear edge in the second
                    FieldId::Gap => r.x1 - 26.0 - w,
                    _ => r.x0 + 8.0 + 14.0 + 6.0 + w,
                };
                if x < r.x1 - 8.0 {
                    vline(s, x, r.y0 + 6.0, r.y1 - 6.0, C_TEXT);
                }
                break;
            }
        }
    }
}

// ------------------------------------------------------ color picker

/// Bounds of the native color popover. Keeping this calculation shared by
/// painting and input means clicks outside the popup close it instead of
/// accidentally editing the canvas underneath.
pub(crate) fn color_picker_rect(app: &App) -> Option<Rect> {
    let (_, anchor, open) = *app.color_picker_popup.as_ref()?;
    if !open {
        return None;
    }
    let w = 244.0;
    let h = 250.0;
    let x_left = anchor.x0 - w - 8.0;
    let x = if x_left >= 8.0 {
        x_left
    } else {
        (anchor.x1 + 8.0).min((app.win_w - w - 8.0).max(8.0))
    };
    let y = anchor.y0.clamp(
        ED_TITLE_H + 4.0,
        (app.win_h - h - 8.0).max(ED_TITLE_H + 4.0),
    );
    Some(Rect::new(x, y, x + w, y + h))
}

fn paint_color_picker(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let Some((is_fill, _, open)) = app.color_picker_popup.as_ref().cloned() else {
        return;
    };
    if !open || app.doc_opt().is_none() {
        return;
    }
    let Some(panel) = color_picker_rect(app) else {
        return;
    };
    let info = sel_info(app);
    let current = parse_hex(if is_fill { &info.fill } else { &info.stroke })
        .unwrap_or(if is_fill { Color::WHITE } else { Color::BLACK });
    elev_shadow(s, panel, 14.0, Elevation::Floating);
    fill_rrect(s, panel, R_LG, C_FIELD);
    stroke_rrect(s, panel, R_LG, C_LINE_2, 1.0);

    app.fonts.text(
        s,
        panel.x0 + 14.0,
        panel.y0 + 14.0,
        if is_fill {
            "Fill color"
        } else {
            "Stroke color"
        },
        T11,
        C_TEXT,
        Wt::Med,
    );
    let close = Rect::new(
        panel.x1 - 30.0,
        panel.y0 + 7.0,
        panel.x1 - 7.0,
        panel.y0 + 29.0,
    );
    if hover(app, close) {
        fill_rrect(s, close, R_MD, C_FIELD_2);
    }
    draw_icon(s, "x", close.x0 + 5.0, close.y0 + 5.0, ICON_SM, C_DIM);
    hit.push((close, Action::CloseColorPicker));

    let preview = Rect::new(
        panel.x0 + 14.0,
        panel.y0 + 38.0,
        panel.x1 - 14.0,
        panel.y0 + 72.0,
    );
    fill_rrect(s, preview, R_MD, current);
    stroke_rrect(s, preview, R_MD, C_LINE_2, 1.0);
    app.fonts.text(
        s,
        panel.x0 + 14.0,
        panel.y0 + 87.0,
        &format!("#{}", crate::state::color_hex(current)),
        T10,
        C_TEXT,
        Wt::Mono,
    );
    app.fonts.text(
        s,
        panel.x0 + 14.0,
        panel.y0 + 104.0,
        "Choose a preset or edit the hex field",
        T10,
        C_DIM,
        Wt::Reg,
    );

    const PRESETS: [&str; 16] = [
        "FFFFFF", "F2F3F7", "D9DCE5", "9A9EAA", "6B6E7A", "343842", "1B1D23", "000000", "FF3B30",
        "FF9500", "FFCC00", "34C759", "00A3FF", "5856D6", "AF52DE", "FF2D55",
    ];
    let size = 26.0;
    let gap = 7.0;
    let start_x = panel.x0 + 14.0;
    let start_y = panel.y0 + 119.0;
    for (i, hex) in PRESETS.into_iter().enumerate() {
        let col = i % 8;
        let row = i / 8;
        let r = Rect::new(
            start_x + col as f64 * (size + gap),
            start_y + row as f64 * (size + gap),
            start_x + col as f64 * (size + gap) + size,
            start_y + row as f64 * (size + gap) + size,
        );
        let color = parse_hex(hex).unwrap_or(Color::WHITE);
        fill_rrect(s, r, R_MD, color);
        if color == current {
            stroke_rrect(s, r.inflate(1.5, 1.5), R_MD, C_TEXT, 1.5);
        } else {
            stroke_rrect(s, r, R_MD, C_LINE, 1.0);
        }
        hit.push((r, Action::PaintPreset(is_fill, hex.to_string())));
    }
}

// ------------------------------------------------------ command palette

#[derive(Clone)]
pub struct Command {
    pub label: &'static str,
    pub shortcut: &'static str,
}

pub fn palette_commands() -> Vec<Command> {
    vec![
        Command {
            label: "New file",
            shortcut: "⌘ N",
        },
        Command {
            label: "Open…",
            shortcut: "⌘ O",
        },
        Command {
            label: "Import…",
            shortcut: "⌘ I",
        },
        Command {
            label: "Lint document",
            shortcut: "",
        },
        Command {
            label: "Theme: Daylight (light)",
            shortcut: "",
        },
        Command {
            label: "Theme: Graphite (dark)",
            shortcut: "",
        },
        Command {
            label: "Preview prototype",
            shortcut: "⌘ ⏎",
        },
        Command {
            label: "Load font…",
            shortcut: "",
        },
        Command {
            label: "Save",
            shortcut: "⌘ S",
        },
        Command {
            label: "Export SVG",
            shortcut: "⇧ ⌘ E",
        },
        Command {
            label: "Export PNG",
            shortcut: "⇧ ⌘ P",
        },
        Command {
            label: "Export PDF",
            shortcut: "⇧⌘ E",
        },
        Command {
            label: "Copy as code",
            shortcut: "",
        },
        Command {
            label: "Comment tool",
            shortcut: "C",
        },
        Command {
            label: "Undo",
            shortcut: "⌘ Z",
        },
        Command {
            label: "Redo",
            shortcut: "⇧ ⌘ Z",
        },
        Command {
            label: "Select tool",
            shortcut: "V",
        },
        Command {
            label: "Scale tool",
            shortcut: "K",
        },
        Command {
            label: "Frame tool",
            shortcut: "F",
        },
        Command {
            label: "Slice tool",
            shortcut: "S",
        },
        Command {
            label: "Text tool",
            shortcut: "T",
        },
        Command {
            label: "Rectangle tool",
            shortcut: "R",
        },
        Command {
            label: "Ellipse tool",
            shortcut: "O",
        },
        Command {
            label: "Pen tool",
            shortcut: "P",
        },
        Command {
            label: "Pencil tool",
            shortcut: "⇧P",
        },
        Command {
            label: "Hand tool",
            shortcut: "H",
        },
        Command {
            label: "Zoom to fit",
            shortcut: "⇧ 1",
        },
        Command {
            label: "Zoom 100%",
            shortcut: "⇧ 0",
        },
        Command {
            label: "Back to dashboard",
            shortcut: "⌘ W",
        },
        Command {
            label: "Delete selection",
            shortcut: "⌫",
        },
        Command {
            label: "Duplicate selection",
            shortcut: "⌘ D",
        },
        Command {
            label: "Group selection",
            shortcut: "⌘ G",
        },
        Command {
            label: "Frame selection",
            shortcut: "⌥ ⌘ G",
        },
        Command {
            label: "Ungroup",
            shortcut: "⇧ ⌘ G",
        },
        Command {
            label: "Bring to front",
            shortcut: "⇧ ⌘ ]",
        },
        Command {
            label: "Send to back",
            shortcut: "⇧ ⌘ [",
        },
        Command {
            label: "Union selection",
            shortcut: "⌘⌥ U",
        },
        Command {
            label: "Subtract selection",
            shortcut: "⌘⌥ S",
        },
        Command {
            label: "Intersect selection",
            shortcut: "⌘⌥ I",
        },
        Command {
            label: "Exclude selection",
            shortcut: "⌘⌥ X",
        },
        Command {
            label: "Flatten selection",
            shortcut: "⌘ E",
        },
        Command {
            label: "Outline stroke",
            shortcut: "⇧ ⌘ O",
        },
        Command {
            label: "Outline text",
            shortcut: "⇧ ⌥ ⌘ O",
        },
        Command {
            label: "Enter vector edit mode",
            shortcut: "⏎",
        },
        Command {
            label: "Toggle bezier handles",
            shortcut: "",
        },
        Command {
            label: "Simplify path (0.5px tolerance)",
            shortcut: "",
        },
        Command {
            label: "Simplify path (1px tolerance)",
            shortcut: "",
        },
        Command {
            label: "Simplify path (4px tolerance)",
            shortcut: "",
        },
        Command {
            label: "Offset path outward by 4px",
            shortcut: "",
        },
        Command {
            label: "Reverse path direction",
            shortcut: "",
        },
        Command {
            label: "Join selected paths",
            shortcut: "",
        },
        Command {
            label: "Stroke cap: round (both ends)",
            shortcut: "",
        },
        Command {
            label: "Stroke cap: square (both ends)",
            shortcut: "",
        },
        Command {
            label: "Stroke cap: butt (both ends)",
            shortcut: "",
        },
        Command {
            label: "Stroke cap: arrow (both ends)",
            shortcut: "",
        },
        Command {
            label: "Renumber selected layers",
            shortcut: "⇧ ⌘ R",
        },
        Command {
            label: "Bring forward",
            shortcut: "⌘ ]",
        },
        Command {
            label: "Send backward",
            shortcut: "⌘ [",
        },
        Command {
            label: "Lock selection",
            shortcut: "⇧⌘ L",
        },
        Command {
            label: "Hide selection",
            shortcut: "⇧⌘ H",
        },
        Command {
            label: "Help: welcome & shortcuts",
            shortcut: "?",
        },
    ]
}

fn paint_palette(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let w = app.win_w;
    let h = app.win_h;
    fill_rect(s, Rect::new(0.0, 0.0, w, h), C_SCRIM);
    let pw = 480.0;
    let all = palette_commands();
    let q = app.palette.query.to_lowercase();
    let cmds: Vec<usize> = (0..all.len())
        .filter(|i| q.is_empty() || all[*i].label.to_lowercase().contains(&q))
        .collect();
    let shown = cmds.len().min(8);
    let ph = 46.0 + 26.0 + shown as f64 * 31.0 + 12.0;
    let x = (w - pw) / 2.0;
    let y = (h - ph) * 0.22;
    let panel = Rect::new(x, y, x + pw, y + ph);
    elev_shadow(s, panel, 16.0, Elevation::Modal);
    fill_rrect(s, panel, R_LG, C_FIELD);
    stroke_rrect(s, panel, R_LG, C_LINE_2, 1.0);

    // query row
    draw_icon(s, "search", x + 16.0, y + 15.0, ICON_MD, C_DIM);
    if app.palette.query.is_empty() {
        app.fonts.text(
            s,
            x + 16.0 + 16.0 + 10.0,
            y + 16.0,
            "Search every command and tool",
            T11,
            C_PLACEHOLDER,
            Wt::Reg,
        );
    } else {
        app.fonts.text(
            s,
            x + 16.0 + 16.0 + 10.0,
            y + 16.0,
            &app.palette.query.clone(),
            T11,
            C_TEXT,
            Wt::Reg,
        );
        let qw = app.fonts.measure(&app.palette.query, T11, Wt::Reg);
        vline(s, x + 42.0 + qw + 2.0, y + 12.0, y + 34.0, C_TEXT);
    }
    hline(s, x + 12.0, x + pw - 12.0, y + 46.0, C_LINE);

    app.fonts
        .micro_label(s, x + 18.0, y + 56.0, "COMMANDS", C_DIM, Wt::Med);
    for (row, &ci) in cmds.iter().take(shown).enumerate() {
        let ry = y + 72.0 + 31.0 * row as f64;
        let r = Rect::new(x + 10.0, ry, x + pw - 10.0, ry + 28.0);
        let active = row == app.palette.selected_index.min(shown - 1);
        if active {
            fill_rrect(s, r, R_MD, C_FIELD_2);
        }
        app.fonts.text(
            s,
            x + 22.0,
            ry + 8.0,
            all[ci].label,
            if active { T11 } else { T10 },
            if active { C_TEXT } else { C_MUTED },
            Wt::Reg,
        );
        let sw = app.fonts.measure(all[ci].shortcut, T10, Wt::Reg);
        app.fonts.text(
            s,
            x + pw - 22.0 - sw,
            ry + 9.0,
            all[ci].shortcut,
            T10,
            C_DIM,
            Wt::Reg,
        );
        hit.push((r, Action::PaletteRun(ci)));
    }
}

/// Paint the command palette over whichever screen is active. The palette is
/// global (Ctrl/Cmd+K), so it must not disappear just because the dashboard
/// is underneath it. This helper preserves the screen's existing hit zones
/// and appends the modal rows on top of them.
pub(crate) fn paint_palette_overlay(app: &mut App, s: &mut Scene) {
    if !app.palette.open {
        return;
    }
    let mut hit = std::mem::take(&mut app.hit);
    paint_palette(app, s, &mut hit);
    app.hit = hit;
}

// ------------------------------------------------------------ comments
// (C18): pins live ABOVE the canvas content (like selection chrome);
// hit-testing/press flow lives in the shell's canvas_press, drawing here.

/// Figma-style avatar palette (author-name hash → stable color).
fn comment_avatar_color(author: &str) -> vello::peniko::Color {
    const PALETTE: [(u8, u8, u8); 5] = [
        (0x00, 0x99, 0xFF), // blue
        (0x2E, 0xCC, 0x71), // green
        (0xF5, 0x9E, 0x0B), // amber
        (0x9B, 0x59, 0xB6), // purple
        (0xE9, 0x4F, 0x6D), // pink
    ];
    let h: usize = author.bytes().map(|b| b as usize).sum();
    let (r, g, b) = PALETTE[h % PALETTE.len()];
    vello::peniko::Color::from_rgb8(r, g, b)
}

fn paint_comments(app: &mut App, s: &mut Scene) {
    use vello::kurbo::Circle;
    let doc = match app.doc_opt() {
        Some(d) => d,
        None => return,
    };
    let comments: Vec<x_native::Comment> = doc
        .doc
        .comments
        .iter()
        .filter(|c| c.page == doc.page)
        .cloned()
        .collect();
    // Threads: one pin per ROOT; replies render inside the open card.
    let replies_of = |id: &str| -> Vec<x_native::Comment> {
        comments
            .iter()
            .filter(|c| c.parent.as_deref() == Some(id))
            .cloned()
            .collect()
    };
    for c in comments.iter().filter(|c| c.parent.is_none()) {
        let Some(pin) = app.comment_pin_rect(&c.id) else {
            continue;
        };
        let open = app.open_comment.as_deref() == Some(c.id.as_str());
        let hov = hover(app, pin);
        // avatar: 24px circle, author initial; resolved = gray + check
        let center = (pin.x0 + 12.0, pin.y0 + 12.0);
        let fill = if c.resolved {
            C_DIM
        } else {
            comment_avatar_color(&c.author)
        };
        let ring = if open || hov { C_SEL } else { C_PANEL };
        s.fill(
            vello::peniko::Fill::NonZero,
            vello::kurbo::Affine::IDENTITY,
            fill,
            None,
            &Circle::new(center, if open { 14.0 } else { 12.0 }),
        );
        s.stroke(
            &vello::kurbo::Stroke::new(1.5),
            vello::kurbo::Affine::IDENTITY,
            ring,
            None,
            &Circle::new(center, if open { 14.0 } else { 12.0 }),
        );
        if c.resolved {
            draw_icon(s, "check", pin.x0 + 5.0, pin.y0 + 5.0, ICON_SM, C_TEXT);
        } else {
            let initial = c.author.chars().next().unwrap_or('?');
            app.fonts
                .text_center(s, pin, &initial.to_string(), T11, C_TEXT, Wt::Med, false);
        }
        // reply count badge (top-right of the pin)
        let replies = replies_of(&c.id);
        if !replies.is_empty() {
            let bc = (pin.x1 - 1.0, pin.y0 + 1.0);
            s.fill(
                vello::peniko::Fill::NonZero,
                vello::kurbo::Affine::IDENTITY,
                C_SEL,
                None,
                &Circle::new(bc, 8.0),
            );
            s.stroke(
                &vello::kurbo::Stroke::new(1.5),
                vello::kurbo::Affine::IDENTITY,
                C_PANEL,
                None,
                &Circle::new(bc, 8.0),
            );
            let n = replies.len().to_string();
            app.fonts.text_center(
                s,
                Rect::new(pin.x1 - 10.0, pin.y0 - 8.0, pin.x1 + 8.0, pin.y0 + 10.0),
                &n,
                T10,
                C_TEXT,
                Wt::Semi,
                false,
            );
        }
        // collapsed preview bubble on hover (not while its thread is open)
        if hov && !open {
            let w = (app.fonts.measure(&c.text, T10, Wt::Reg) + 24.0).min(240.0);
            let b = Rect::new(pin.x1 + 6.0, pin.y0 + 1.0, pin.x1 + 6.0 + w, pin.y1 - 1.0);
            elev_shadow(s, b, 8.0, Elevation::Floating);
            fill_rrect(s, b, R_XL, C_FIELD);
            stroke_rrect(s, b, R_XL, C_LINE_2, 1.0);
            let hint = if replies.is_empty() {
                c.text.clone()
            } else {
                format!(
                    "{} · {} repl{}",
                    c.text,
                    replies.len(),
                    if replies.len() == 1 { "y" } else { "ies" }
                )
            };
            app.fonts
                .text(s, b.x0 + 12.0, b.y0 + 9.0, &hint, T10, C_TEXT, Wt::Reg);
        }
        // open thread popover (grows with the thread)
        if open {
            let reply_n = replies.len();
            let card = Rect::new(
                pin.x1 + 8.0,
                pin.y0 - 4.0,
                pin.x1 + 248.0,
                pin.y0 + 76.0 + reply_n as f64 * 18.0 + 30.0,
            );
            elev_shadow(s, card, 12.0, Elevation::Floating);
            fill_rrect(s, card, R_XL, C_FIELD);
            stroke_rrect(s, card, R_XL, C_LINE_2, 1.0);
            app.fonts.text(
                s,
                card.x0 + 12.0,
                card.y0 + 10.0,
                &c.author,
                T10,
                C_DIM,
                Wt::Med,
            );
            // text clamped to one line (thread depth is 1 message)
            let shown: String = if c.text.chars().count() > 34 {
                format!("{}…", c.text.chars().take(34).collect::<String>())
            } else {
                c.text.clone()
            };
            app.fonts.text(
                s,
                card.x0 + 12.0,
                card.y0 + 28.0,
                &shown,
                T11,
                C_TEXT,
                Wt::Reg,
            );
            // Resolve / Re-open pill + Delete
            let pill = Rect::new(
                card.x0 + 12.0,
                card.y0 + 48.0,
                card.x0 + 96.0,
                card.y0 + 70.0,
            );
            let hov_r = hover(app, pill);
            fill_rrect(s, pill, R_MD, if hov_r { C_FIELD_2 } else { C_PANEL });
            stroke_rrect(s, pill, R_MD, C_LINE_2, 1.0);
            let label = if c.resolved { "Re-open" } else { "Resolve" };
            app.fonts.text_center(
                s,
                pill,
                label,
                T10,
                if c.resolved { C_MUTED } else { C_ACCENT_INK },
                Wt::Med,
                true,
            );
            // Delete: `canvas_press` handles the del click at
            // (sp.x+126, sp.y+6, +42, +24); card.x0 = sp.x+32 and
            // card.y0 = sp.y-28, so the icon centers in that rect
            draw_icon(
                s,
                "trash-2",
                card.x0 + 108.0,
                card.y0 + 39.0,
                ICON_SM,
                C_DIM,
            );
            // reply rows (geometry mirrored by `canvas_press` — keep in sync)
            for (i, r) in replies.iter().enumerate() {
                let ry = card.y0 + 76.0 + i as f64 * 18.0;
                hline(s, card.x0 + 10.0, card.x1 - 10.0, ry, C_LINE);
                app.fonts
                    .text(s, card.x0 + 12.0, ry + 3.0, &r.author, T10, C_DIM, Wt::Med);
                let shown_r: String = if r.text.chars().count() > 26 {
                    format!("{}…", r.text.chars().take(26).collect::<String>())
                } else {
                    r.text.clone()
                };
                app.fonts
                    .text(s, card.x0 + 76.0, ry + 3.0, &shown_r, T10, C_TEXT, Wt::Reg);
                // per-reply delete ✕
                let xb = Rect::new(card.x1 - 40.0, ry + 1.0, card.x1 - 22.0, ry + 16.0);
                if hover(app, xb) {
                    fill_rrect(s, xb, R_SM, C_FIELD_2);
                }
                draw_icon(s, "x", xb.x0 + 4.0, xb.y0 + 1.0, ICON_XS, C_DIM);
            }
            // Reply pill (opens the composer parented to this thread)
            let pill_y = card.y0 + 76.0 + reply_n as f64 * 18.0 + 2.0;
            let rbtn = Rect::new(card.x0 + 12.0, pill_y, card.x0 + 96.0, pill_y + 24.0);
            fill_rrect(
                s,
                rbtn,
                R_MD,
                if hover(app, rbtn) { C_FIELD_2 } else { C_PANEL },
            );
            stroke_rrect(s, rbtn, R_MD, C_LINE_2, 1.0);
            app.fonts
                .text_center(s, rbtn, "Reply", T10, C_ACCENT_INK, Wt::Med, true);
        }
    }
    // the composer (new comment)
    if let Some(d) = app.comment_draft.clone() {
        let sp = app.world_to_screen(vello::kurbo::Point::new(d.x, d.y));
        let card = Rect::new(sp.x, sp.y, sp.x + 240.0, sp.y + 64.0);
        elev_shadow(s, card, 12.0, Elevation::Floating);
        fill_rrect(s, card, R_XL, C_FIELD);
        stroke_rrect(s, card, R_XL, C_SEL, 1.0);
        let title = match d.parent.as_deref() {
            Some(root_id) => {
                let who = app
                    .doc_opt()
                    .and_then(|dd| dd.doc.comments.iter().find(|c| c.id == root_id))
                    .map(|c| c.author.clone())
                    .unwrap_or_default();
                format!("Reply to {who}")
            }
            None => crate::state::USER_NAME.to_string(),
        };
        app.fonts.text(
            s,
            card.x0 + 28.0,
            card.y0 + 10.0,
            &title,
            T10,
            C_DIM,
            Wt::Med,
        );
        let shown = if d.buffer.is_empty() {
            "Add a comment…".to_string()
        } else {
            d.buffer.clone()
        };
        app.fonts.text(
            s,
            card.x0 + 12.0,
            card.y0 + 24.0,
            &shown,
            T11,
            if d.buffer.is_empty() { C_MUTED } else { C_TEXT },
            Wt::Reg,
        );
        // caret after the buffer
        if !d.buffer.is_empty() {
            let w = app.fonts.measure(&d.buffer, T11, Wt::Reg);
            vline(s, card.x0 + 12.0 + w, card.y0 + 24.0, card.y0 + 38.0, C_SEL);
        }
        // Post pill
        let post = Rect::new(
            card.x0 + 148.0,
            card.y0 + 34.0,
            card.x0 + 232.0,
            card.y0 + 58.0,
        );
        let hov_p = hover(app, post);
        // outline button: the accent is the *border* and the ink, never a
        // fill behind its own colour (hovering used to fill it solid and
        // paint the label in the same purple — the word "Post" vanished)
        fill_rrect(s, post, R_MD, if hov_p { C_FIELD_2 } else { C_PANEL });
        stroke_rrect(s, post, R_MD, C_SEL, 1.0);
        app.fonts
            .text_center(s, post, "Post", T10, C_ACCENT_INK, Wt::Med, true);
        // author dot anchored at the pin
        s.fill(
            vello::peniko::Fill::NonZero,
            vello::kurbo::Affine::IDENTITY,
            comment_avatar_color(crate::state::USER_NAME),
            None,
            &Circle::new((card.x0 + 16.0, card.y0 + 14.0), 6.0),
        );
    }
}

// ------------------------------------------------------------ ship mode
// (C21): the SHIP tab — platform picker + generated implementation output
// for the selection. This is an X-Native handoff surface, not a Figma Dev
// Mode replica.

// ------------------------------------------------------------ UX Analysis Tool
// Inspired by Quant-UX: analyze user flows, accessibility, design quality,
// interaction patterns, and provide actionable UX recommendations.

fn paint_ux_analysis(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    x0: f64,
    xr: f64,
    y: f64,
) {
    use crate::theme::*;

    hline(s, x0 - 8.0, xr, y, C_LINE);
    let mut y = y + 1.0 + 12.0;

    // Header
    app.fonts
        .text(s, x0 + 16.0, y, "UX ANALYSIS", T11, C_TEXT, Wt::Bold);
    y += 28.0;

    // Description
    app.fonts.text(
        s,
        x0 + 16.0,
        y,
        "Analyze your design for usability, accessibility, and best practices.",
        T10,
        C_DIM,
        Wt::Reg,
    );
    y += 32.0;

    // Quick Actions - now with real functionality
    let actions = [
        (
            "Accessibility Check",
            "Check WCAG compliance",
            Action::UxAccessibility,
        ),
        (
            "User Flow Analysis",
            "Map navigation paths",
            Action::UxUserFlow,
        ),
        (
            "Design Quality Score",
            "Evaluate visual hierarchy",
            Action::UxQualityScore,
        ),
        (
            "Interaction Patterns",
            "Review component usage",
            Action::UxPatterns,
        ),
        (
            "Color Contrast",
            "Verify text readability",
            Action::UxContrast,
        ),
        (
            "Responsive Preview",
            "Test different screen sizes",
            Action::UxResponsive,
        ),
    ];

    for (title, desc, action) in &actions {
        let card_h = 70.0;
        let card_r = Rect::new(x0 + 16.0, y, xr - 16.0, y + card_h);
        let hov = hover(app, card_r);

        fill_rrect(s, card_r, R_LG, if hov { C_FIELD_2 } else { C_FIELD });
        stroke_rrect(s, card_r, R_LG, if hov { C_LINE_2 } else { C_LINE }, 1.0);

        // Title
        app.fonts
            .text(s, x0 + 24.0, y + 14.0, title, T10, C_TEXT, Wt::Med);

        // Description
        app.fonts
            .text(s, x0 + 24.0, y + 34.0, desc, T10, C_DIM, Wt::Reg);

        hit.push((card_r, action.clone()));

        y += card_h + 12.0;
    }

    // Selection-based analysis
    let (sel, root) = {
        let d = app.doc();
        (
            d.editor_ref().selection.clone(),
            d.editor_ref().root.clone(),
        )
    };
    if !sel.is_empty() {
        y += 16.0;
        app.fonts.text(
            s,
            x0 + 16.0,
            y,
            "SELECTED ELEMENT ANALYSIS",
            T10,
            C_TEXT,
            Wt::Semi,
        );
        y += 24.0;

        app.fonts.text(
            s,
            x0 + 16.0,
            y,
            &format!("{} element(s) selected", sel.len()),
            T10,
            C_DIM,
            Wt::Reg,
        );
        y += 32.0;

        // Analyze selected nodes
        for node_id in &sel {
            if let Some(node) = find_node(&root, node_id) {
                let node_r = Rect::new(x0 + 16.0, y, xr - 16.0, y + 40.0);
                fill_rrect(s, node_r, R_MD, C_BG);

                let name = node.name.clone();
                app.fonts
                    .text(s, x0 + 24.0, y + 12.0, &name, T10, C_TEXT, Wt::Reg);

                // Quick metrics
                match &node.kind {
                    NodeKind::Text { .. } => {
                        app.fonts.text(
                            s,
                            x0 + 24.0,
                            y + 26.0,
                            "\u{2713} Text layer",
                            T10,
                            C_SUCCESS,
                            Wt::Reg,
                        );
                    }
                    NodeKind::Frame { .. } => {
                        app.fonts.text(
                            s,
                            x0 + 24.0,
                            y + 26.0,
                            "\u{2713} Container",
                            T10,
                            C_SUCCESS,
                            Wt::Reg,
                        );
                    }
                    _ => {}
                }

                y += 52.0;
            }
        }
    } else {
        y += 16.0;
        // Empty state
        let empty_r = Rect::new(x0 + 16.0, y, xr - 16.0, y + 80.0);
        fill_rrect(s, empty_r, R_LG, C_BG);
        stroke_rrect(s, empty_r, R_LG, C_LINE, 1.0);

        app.fonts.text_center(
            s,
            empty_r,
            "Select an element to analyze",
            T10,
            C_DIM,
            Wt::Reg,
            true,
        );
    }
}

fn paint_inspect(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    x0: f64,
    xr: f64,
    y: f64,
) {
    hline(s, x0 - 8.0, xr, y, C_LINE);
    let y = y + 1.0 + 12.0;
    // platform segmented control for X-Native's artifact handoff targets
    const NAMES: [&str; 5] = App::INSPECT_PLATFORMS;
    let w = xr - x0;
    let seg_w = (w - 4.0 * 4.0) / 5.0;
    for (i, name) in NAMES.iter().enumerate() {
        let bx = x0 + (seg_w + 4.0) * i as f64;
        let r = Rect::new(bx, y, bx + seg_w, y + 24.0);
        let active = app.inspect_platform == i;
        let hov = hover(app, r);
        fill_rrect(
            s,
            r,
            R_MD,
            if active {
                C_FIELD_2
            } else {
                if hov {
                    C_FIELD_2
                } else {
                    C_FIELD
                }
            },
        );
        stroke_rrect(s, r, R_MD, if active { C_LINE_2 } else { C_LINE }, 1.0);
        app.fonts.text_center(
            s,
            r,
            name,
            T10,
            if active { C_TEXT } else { C_DIM },
            if active { Wt::Med } else { Wt::Reg },
            true,
        );
        hit.push((r, Action::InspectPlatform(i)));
    }
    let mut y = y + 24.0 + 12.0;
    // code panel: dark inset with mono lines
    let code = app.inspect_code();
    let lines: Vec<&str> = if code.is_empty() {
        vec![]
    } else {
        code.lines().collect()
    };
    let row_h = 15.0;
    let pad = 10.0;
    let panel_h = if lines.is_empty() {
        44.0
    } else {
        lines.len() as f64 * row_h + pad * 2.0
    };
    let panel = Rect::new(x0, y, xr, y + panel_h);
    fill_rrect(s, panel, R_LG, C_PANEL);
    stroke_rrect(s, panel, R_LG, C_LINE, 1.0);
    if lines.is_empty() {
        app.fonts.text(
            s,
            x0 + pad,
            y + pad + 4.0,
            "Select a layer to inspect",
            T10,
            C_MUTED,
            Wt::Reg,
        );
    } else {
        for (i, line) in lines.iter().enumerate() {
            app.fonts.text(
                s,
                panel.x0 + pad,
                panel.y0 + pad + i as f64 * row_h + 2.5,
                line,
                T10,
                C_TEXT,
                Wt::Mono,
            );
        }
    }
    y += panel_h + 12.0;
    // copy button
    let cb = Rect::new(x0, y, x0 + 110.0, y + 24.0);
    let hov = hover(app, cb);
    let enabled = !code.is_empty();
    fill_rrect(
        s,
        cb,
        R_MD,
        if hov && enabled { C_FIELD_2 } else { C_FIELD },
    );
    stroke_rrect(s, cb, R_MD, C_LINE, 1.0);
    draw_icon(
        s,
        "copy",
        cb.x0 + 8.0,
        cb.y0 + 5.0,
        ICON_SM,
        if enabled { C_DIM } else { C_MUTED },
    );
    app.fonts.text(
        s,
        cb.x0 + 27.0,
        cb.y0 + 5.5,
        "Copy code",
        T10,
        if enabled { C_TEXT } else { C_MUTED },
        Wt::Reg,
    );
    hit.push((cb, Action::InspectCopy));
}

// ————————————————————————————————————————— prototype tab
// authoring (interaction rows on the selected node) + live flow preview.

/// Navigation candidates: every top-level frame plus any node explicitly
/// marked as a flow starting point, across all pages of the open doc.
pub(crate) fn proto_targets(app: &App) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let Some(d) = app.doc_opt() else { return out };
    for ed in &d.editors {
        for f in &ed.root.children {
            if !matches!(f.kind, x_native::NodeKind::Frame { .. }) {
                continue;
            }
            if !out.iter().any(|(id, _)| *id == f.id) {
                out.push((f.id.clone(), f.name.clone()));
            }
            fn starts(n: &x_native::Node, out: &mut Vec<(String, String)>) {
                if n.is_starting_point && !out.iter().any(|(id, _)| *id == n.id) {
                    out.push((n.id.clone(), n.name.clone()));
                }
                for c in &n.children {
                    starts(c, out);
                }
            }
            starts(f, &mut out);
        }
    }
    out
}

pub(crate) fn proto_trigger_label(t: &x_native::Trigger) -> &'static str {
    use x_native::Trigger as T;
    match t {
        T::OnClick => "On click",
        T::OnHover => "While hovering",
        T::MouseEnter => "Mouse enter",
        T::MouseLeave => "Mouse leave",
        T::OnPress => "While pressing",
        T::MouseUp => "Mouse up",
        T::OnDrag => "On drag",
        T::AfterDelay { .. } => "After delay",
        T::KeyDown { .. } => "Key pressed",
        T::WhenVideoHits { .. } => "Video hits",
        T::WhenVideoEnds => "Video ends",
    }
}

pub(crate) fn proto_action_label(a: &x_native::Action, targets: &[(String, String)]) -> String {
    // x_core's prototype Action; the app's own Action is `crate::state::Action`
    use x_native::Action as A;
    match a {
        A::Navigate { destination } | A::ScrollTo { destination } => targets
            .iter()
            .find(|(id, _)| id == destination)
            .map(|(_, n)| n.as_str())
            .unwrap_or(destination)
            .to_string(),
        A::OpenOverlay { overlay, position } => {
            let name = targets
                .iter()
                .find(|(id, _)| id == overlay)
                .map(|(_, n)| n.as_str())
                .unwrap_or(overlay);
            format!("{} ({})", name, position.label())
        }
        A::SwapOverlay { overlay } => {
            let name = targets
                .iter()
                .find(|(id, _)| id == overlay)
                .map(|(_, n)| n.as_str())
                .unwrap_or(overlay);
            format!("{} (swap)", name)
        }
        A::CloseOverlay => "Close overlay".into(),
        A::OpenLink { url } => format!("Open {url}"),
        A::Back => "Go back".into(),
        A::SetVar { name, .. } => format!("Set {name}"),
        A::SetMode { mode } => format!("Mode → {mode}"),
        A::Cond { .. } => "Conditional".into(),
    }
}

pub(crate) fn proto_dest_of(a: &x_native::Action) -> Option<String> {
    match a {
        x_native::Action::Navigate { destination } | x_native::Action::ScrollTo { destination } => {
            Some(destination.clone())
        }
        x_native::Action::OpenOverlay { overlay, .. }
        | x_native::Action::SwapOverlay { overlay } => Some(overlay.clone()),
        _ => None,
    }
}

pub(crate) fn proto_action_type_label(a: &x_native::Action) -> &'static str {
    use x_native::Action as A;
    match a {
        A::Navigate { .. } => "Navigate",
        A::OpenOverlay { .. } => "Overlay",
        A::SwapOverlay { .. } => "Swap overlay",
        A::CloseOverlay => "Close overlay",
        A::OpenLink { .. } => "Open link",
        A::ScrollTo { .. } => "Scroll to",
        A::Back => "Back",
        A::SetVar { .. } => "Set variable",
        A::SetMode { .. } => "Set mode",
        A::Cond { .. } => "Conditional",
    }
}

pub(crate) fn proto_animation_label(a: &x_native::Animation) -> String {
    use x_native::Animation as A;
    match a {
        A::Instant => "Instant".into(),
        A::Dissolve => "Dissolve".into(),
        A::SmartAnimate => "Smart animate".into(),
        A::SlideIn => "Slide in".into(),
        A::SlideOut => "Slide out".into(),
        A::MoveIn(d) => format!("Move in ({})", d.to_str()),
        A::MoveOut(d) => format!("Move out ({})", d.to_str()),
    }
}

fn paint_prototype(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    rx: f64,
    rw: f64,
    y0: f64,
) {
    let x0 = rx + 16.0;
    let xr = rx + rw - 16.0;
    let mut y = y0 + 14.0;
    app.fonts
        .caps_label(s, x0, y, "FLOW PREVIEW", C_TEXT, Wt::Med);
    y += 20.0;

    let sel: Vec<String> = app.doc().editor_ref().selection.clone();
    let node = if sel.len() == 1 {
        find_node(&app.doc().editor_ref().root, &sel[0]).cloned()
    } else {
        None
    };

    if let Some(n) = &node {
        // start-point checkbox
        let cb = Rect::new(x0, y + 1.0, x0 + 16.0, y + 17.0);
        fill_rrect(s, cb, R_SM, C_FIELD);
        stroke_rrect(s, cb, R_SM, C_LINE_2, 1.0);
        if n.is_starting_point {
            fill_rrect(s, cb.inflate(-3.5, -3.5), R_XS, C_TEXT);
        }
        app.fonts
            .text(s, cb.x1 + 8.0, y, "Start flow here", T11, C_TEXT, Wt::Reg);
        hit.push((
            Rect::new(x0, y - 6.0, x0 + 190.0, y + 22.0),
            Action::ProtoToggleStart,
        ));
        y += 30.0;

        // interactions header + add button
        let hb = Rect::new(x0, y, xr, y + 14.0);
        app.fonts
            .micro_label(s, x0, y, "INTERACTIONS", C_DIM, Wt::Med);
        let ab = Rect::new(xr - 66.0, y - 4.0, xr, y + 14.0);
        input_box(app, s, ab, 6.0);
        app.fonts
            .text_center(s, ab, "+ Add", T10, C_TEXT, Wt::Med, true);
        hit.push((ab, Action::ProtoAdd));
        let _ = hb;
        y += 24.0;

        let list = x_native::effective_interactions(n);
        if list.is_empty() {
            app.fonts.text(
                s,
                x0,
                y,
                "Nothing wired — add an interaction",
                T10,
                C_MUTED,
                Wt::Reg,
            );
            y += 20.0;
        }
        // Navigation candidates feed the visible destination control below;
        // the control cycles through the same ids the prototype player uses.
        let targets = proto_targets(app);
        for (i, ix) in list.iter().enumerate() {
            // Each interaction exposes the same core model fields that the
            // player consumes: trigger, action/destination, animation/speed,
            // easing and reset. URL actions get one extra line.
            let has_url = matches!(&ix.action, x_native::Action::OpenLink { .. });
            let row_h = if has_url { 128.0 } else { 96.0 };
            let row = Rect::new(x0, y, xr, y + row_h);
            fill_rrect(s, row, R_MD, C_FIELD);
            // Row 1: trigger + action type + destination
            let tb = Rect::new(x0 + 5.0, y + 4.0, x0 + 75.0, y + 20.0);
            input_box(app, s, tb, 4.0);
            app.fonts.text(
                s,
                tb.x0 + 4.0,
                y + 6.0,
                proto_trigger_label(&ix.trigger),
                T10,
                C_TEXT,
                Wt::Reg,
            );
            hit.push((tb, Action::ProtoTrigger(i)));

            // Show trigger-specific fields (delay for AfterDelay, key for KeyDown, time for WhenVideoHits)
            match &ix.trigger {
                x_native::Trigger::AfterDelay { ms } => {
                    let db = Rect::new(x0 + 80.0, y + 4.0, x0 + 140.0, y + 20.0);
                    input_box(app, s, db, 4.0);
                    app.fonts.text(
                        s,
                        db.x0 + 4.0,
                        y + 6.0,
                        &format!("{}ms", ms),
                        T10,
                        C_TEXT,
                        Wt::Mono,
                    );
                    hit.push((db, Action::ProtoEditDelay(i)));
                }
                x_native::Trigger::KeyDown { key } => {
                    let kb = Rect::new(x0 + 80.0, y + 4.0, x0 + 140.0, y + 20.0);
                    input_box(app, s, kb, 4.0);
                    app.fonts
                        .text(s, kb.x0 + 4.0, y + 6.0, key, T10, C_TEXT, Wt::Mono);
                    hit.push((kb, Action::ProtoEditKey(i)));
                }
                x_native::Trigger::WhenVideoHits { time } => {
                    let vb = Rect::new(x0 + 80.0, y + 4.0, x0 + 140.0, y + 20.0);
                    input_box(app, s, vb, 4.0);
                    app.fonts.text(
                        s,
                        vb.x0 + 4.0,
                        y + 6.0,
                        &format!("{:.1}s", time),
                        T10,
                        C_TEXT,
                        Wt::Mono,
                    );
                    hit.push((vb, Action::ProtoEditVideoTime(i)));
                }
                _ => {}
            }

            // Row 2: action type + destination. These controls mutate the
            // exact action consumed by the flow player; there is no longer a
            // painted-but-unwired destination field.
            let action_y = y + 24.0;
            let ab = Rect::new(x0 + 5.0, action_y, x0 + 86.0, action_y + 20.0);
            input_box(app, s, ab, 4.0);
            app.fonts.text(
                s,
                ab.x0 + 4.0,
                action_y + 2.0,
                &proto_action_label(&ix.action, &targets),
                T10,
                C_TEXT,
                Wt::Reg,
            );
            hit.push((ab, Action::ProtoActionType(i)));

            let target_label = ix
                .action
                .target()
                .and_then(|id| targets.iter().find(|(candidate, _)| candidate == id))
                .map(|(_, name)| name.as_str())
                .unwrap_or_else(|| {
                    if has_url {
                        "External link"
                    } else {
                        "Choose destination"
                    }
                });
            let db = Rect::new(x0 + 90.0, action_y, xr - 5.0, action_y + 20.0);
            input_box(app, s, db, 4.0);
            let target_text = app
                .fonts
                .truncate(target_label, T10, Wt::Reg, db.width() - 8.0);
            app.fonts.text(
                s,
                db.x0 + 4.0,
                action_y + 2.0,
                &target_text,
                T10,
                C_TEXT,
                Wt::Reg,
            );
            if !has_url {
                hit.push((db, Action::ProtoDest(i, 1)));
            }

            // Row 3: animation + duration. Both are authored properties on
            // Interaction and are used by the prototype transition runtime.
            let motion_y = y + 48.0;
            let mb = Rect::new(x0 + 5.0, motion_y, x0 + 120.0, motion_y + 20.0);
            input_box(app, s, mb, 4.0);
            let animation = ix.animation.label_with_dir();
            let animation = app
                .fonts
                .truncate(&animation, T10, Wt::Reg, mb.width() - 8.0);
            app.fonts.text(
                s,
                mb.x0 + 4.0,
                motion_y + 2.0,
                &animation,
                T10,
                C_TEXT,
                Wt::Reg,
            );
            hit.push((mb, Action::ProtoAnimation(i)));
            let sb = Rect::new(x0 + 124.0, motion_y, x0 + 184.0, motion_y + 20.0);
            input_box(app, s, sb, 4.0);
            app.fonts.text(
                s,
                sb.x0 + 4.0,
                motion_y + 2.0,
                &format!("{}ms", ix.transition_ms),
                T10,
                C_TEXT,
                Wt::Mono,
            );
            hit.push((sb, Action::ProtoSpeed(i)));

            // Row 4: easing + reset + remove
            let row3_y = y + 72.0;
            let eb = Rect::new(x0 + 5.0, row3_y, x0 + 85.0, row3_y + 20.0);
            input_box(app, s, eb, 4.0);
            app.fonts.text(
                s,
                eb.x0 + 4.0,
                row3_y + 2.0,
                &format!("Easing: {}", ix.easing.label()),
                T10,
                C_TEXT,
                Wt::Reg,
            );
            hit.push((eb, Action::ProtoEasing(i)));

            let rb = Rect::new(x0 + 90.0, row3_y, x0 + 140.0, row3_y + 20.0);
            input_box(app, s, rb, 4.0);
            app.fonts.text(
                s,
                rb.x0 + 4.0,
                row3_y + 2.0,
                if ix.reset_on_navigate {
                    "Reset: On"
                } else {
                    "Reset: Off"
                },
                T10,
                C_TEXT,
                Wt::Reg,
            );
            hit.push((rb, Action::ProtoToggleReset(i)));
            let rb_rm = Rect::new(xr - 30.0, row3_y, xr - 5.0, row3_y + 20.0);
            input_box(app, s, rb_rm, 4.0);
            app.fonts
                .text_center(s, rb_rm, "Remove", T10, C_TEXT, Wt::Reg, true);
            hit.push((rb_rm, Action::ProtoRemove(i)));

            // URL is intentionally below the common controls so a link
            // interaction has a full, clickable editor without overlapping
            // animation/easing.
            if let x_native::Action::OpenLink { url } = &ix.action {
                let ub = Rect::new(x0 + 5.0, y + 98.0, xr - 5.0, y + 116.0);
                input_box(app, s, ub, 4.0);
                let display_url = if url.is_empty() {
                    "https://example.com".to_string()
                } else {
                    url.clone()
                };
                let truncated = app
                    .fonts
                    .truncate(&display_url, T10, Wt::Mono, ub.width() - 8.0);
                app.fonts
                    .text(s, ub.x0 + 4.0, y + 100.0, &truncated, T10, C_TEXT, Wt::Mono);
                hit.push((ub, Action::ProtoEditUrl(i)));
            }
            y += row_h;
        }
    } else {
        let hint = if sel.len() == 1 {
            "Frame not found"
        } else {
            "Select one layer or frame to wire its interactions"
        };
        app.fonts.text(s, x0, y, hint, T10, C_MUTED, Wt::Reg);
        y += 22.0;
    }

    // preview row
    let pb = Rect::new(x0, y + 4.0, xr, y + 32.0);
    let hov = hover(app, pb);
    fill_rrect(s, pb, R_MD, if hov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, pb, R_MD, C_LINE_2, 1.0);
    let lw = app.fonts.measure("▶ Preview flow start", T10, Wt::Med);
    app.fonts
        .text_center(s, pb, "▶  Preview flow start", T10, C_TEXT, Wt::Med, true);
    let _ = lw;
    hit.push((pb, Action::FlowEnter));
    y += 44.0;
    hline(s, rx + 12.0, xr, y, C_LINE);
    y += 10.0;
    app.fonts.text(
        s,
        x0,
        y,
        "Preview plays on the live canvas: click hit targets to",
        T10,
        C_DIM,
        Wt::Reg,
    );
    y += 12.0;
    app.fonts.text(
        s,
        x0,
        y,
        "navigate, Esc steps back, Q exits.",
        T10,
        C_DIM,
        Wt::Reg,
    );
}

// ————————————————————————————————————————— flow preview overlay

/// (page index, absolute world rect, name) for a flow frame id anywhere in
/// the open doc.
pub(crate) fn flow_locate(app: &App, id: &str) -> Option<(usize, Rect, String)> {
    let d = app.doc_opt()?;
    for (i, ed) in d.editors.iter().enumerate() {
        if ed.root.id == id {
            return Some((
                i,
                Rect::new(
                    ed.root.transform.x,
                    ed.root.transform.y,
                    ed.root.transform.x + ed.root.w,
                    ed.root.transform.y + ed.root.h,
                ),
                ed.root.name.clone(),
            ));
        }
        fn walk(n: &x_native::Node, ox: f64, oy: f64, id: &str) -> Option<(Rect, String)> {
            let (x, y) = (ox + n.transform.x, oy + n.transform.y);
            if n.id == id {
                return Some((Rect::new(x, y, x + n.w, y + n.h), n.name.clone()));
            }
            for c in &n.children {
                if let Some(r) = walk(c, x, y, id) {
                    return Some(r);
                }
            }
            None
        }
        if let Some((r, name)) = walk(&ed.root, 0.0, 0.0, id) {
            return Some((i, r, name));
        }
    }
    None
}

fn paint_flow_overlay(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let Some(flow) = app.flow.clone() else { return };
    let Some((_, wr, name)) = flow_locate(app, &flow.current) else {
        return;
    };
    // open overlays, bottom → top: each frame renders relocated to its
    // anchor over the current screen (same math as the viewer's
    // hit-testing), against the preview's OWN variables.
    let aff = app.canvas_affine();
    for ov in &flow.overlays {
        let placed = {
            let Some(d) = app.doc_opt() else {
                break;
            };
            d.editors.iter().find_map(|ed| {
                if ed.root.id == ov.frame {
                    return Some(ed.root.clone());
                }
                find_node(&ed.root, &ov.frame).cloned()
            })
        };
        let Some(mut placed) = placed else {
            continue;
        };
        let (ox, oy) =
            x_native::overlay_offset(wr.width(), wr.height(), placed.w, placed.h, ov.position);
        placed.transform.x = wr.x0 + ox;
        placed.transform.y = wr.y0 + oy;
        let Some(d) = app.doc_opt() else {
            break;
        };
        let sink = VelloSink {
            assets: Some(&d.assets),
            fonts: Some(&app.fonts.fonts),
        };
        // a fresh cache per overlay: the relocated clone must never share
        // entries with the authored-position document render
        let mut cache = FrameCache::new();
        cache.set_presenting(true);
        let scene = cache.render(&placed, &flow.vars, &sink);
        s.append(scene, Some(aff));
    }

    // Optional device chrome for presenting mobile/tablet flows. The authored
    // frame remains untouched; this is preview-only presentation chrome.
    let canvas = app.view_canvas();
    if flow.device_frame {
        stroke_rrect(s, canvas, 18.0, C_LINE_2, 8.0);
        fill_rrect(
            s,
            Rect::new(
                canvas.x0 + 10.0,
                canvas.y0 + 8.0,
                canvas.x1 - 10.0,
                canvas.y0 + 12.0,
            ),
            R_XS,
            C_LINE,
        );
        fill_rrect(
            s,
            Rect::new(
                (canvas.x0 + canvas.x1) / 2.0 - 26.0,
                canvas.y1 - 18.0,
                (canvas.x0 + canvas.x1) / 2.0 + 26.0,
                canvas.y1 - 14.0,
            ),
            R_XS,
            C_LINE_2,
        );
    }
    // chrome chip: frame name + device toggle + Back + Exit
    let chip_w = 210.0 + app.fonts.measure(&name, T11, Wt::Med);
    let chip = Rect::new(
        (app.win_w - chip_w) / 2.0,
        canvas.y0 + 10.0,
        (app.win_w + chip_w) / 2.0,
        canvas.y0 + 42.0,
    );
    fill_rrect(s, chip, R_LG, C_PANEL);
    crate::paint::stroke_rrect(s, chip, R_LG, C_LINE_2, 1.0);
    app.fonts.text(
        s,
        chip.x0 + 12.0,
        chip.y0 + 12.0,
        &format!("▶ {name}"),
        T11,
        C_TEXT,
        Wt::Med,
    );
    let device_btn = Rect::new(
        chip.x0 + 112.0,
        chip.y0 + 7.0,
        chip.x0 + 176.0,
        chip.y1 - 7.0,
    );
    fill_rrect(
        s,
        device_btn,
        R_MD,
        if flow.device_frame {
            C_FIELD_2
        } else {
            C_FIELD
        },
    );
    app.fonts.text_center(
        s,
        device_btn,
        if flow.device_frame {
            "Device ✓"
        } else {
            "Device"
        },
        T10,
        C_TEXT,
        Wt::Med,
        true,
    );
    hit.push((device_btn, Action::FlowDeviceToggle));
    let bw = 74.0;
    let bb = Rect::new(
        chip.x1 - bw - 84.0,
        chip.y0 + 7.0,
        chip.x1 - bw - 14.0,
        chip.y1 - 7.0,
    );
    fill_rrect(
        s,
        bb,
        R_MD,
        if flow.stack.is_empty() {
            C_FIELD
        } else {
            C_FIELD_2
        },
    );
    app.fonts.text_center(
        s,
        bb,
        "← Back",
        T10,
        if flow.stack.is_empty() {
            C_MUTED
        } else {
            C_TEXT
        },
        Wt::Reg,
        true,
    );
    if !flow.stack.is_empty() {
        hit.push((bb, Action::FlowBack));
    }
    let eb = Rect::new(
        chip.x1 - bw - 4.0,
        chip.y0 + 7.0,
        chip.x1 - 8.0,
        chip.y1 - 7.0,
    );
    fill_rrect(s, eb, R_MD, C_FIELD_2);
    app.fonts
        .text_center(s, eb, "Exit (Q)", T10, C_TEXT, Wt::Reg, true);
    hit.push((eb, Action::FlowExit));
}

// ————————————————————————————————————————— assets panel (fonts)

/// Library update review modal: the pinned-vs-newer changeset with
/// Accept / Keep. Painted last + a full-window scrim hit, so clicks outside
/// the card close the review (hit resolution takes the LAST painted rect).
fn paint_lib_review(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    use crate::paint::{fill_rect, fill_rrect, stroke_rrect, Wt};
    let Some(rv) = app.lib_review.as_ref() else {
        return;
    };
    let card_w = 460.0;
    let row_h = 22.0;
    let shown = rv.changes.len().min(8);
    let card_h = 96.0 + shown as f64 * row_h + if rv.changes.len() > 8 { 18.0 } else { 0.0 };
    let cx = (app.win_w - card_w) / 2.0;
    let cy = (app.win_h - card_h).max(60.0) / 2.0;
    let card = Rect::new(cx, cy, cx + card_w, cy + card_h);
    // scrim swallows outside clicks
    hit.push((
        Rect::new(0.0, 0.0, app.win_w, app.win_h),
        Action::LibReviewClose,
    ));
    fill_rect(s, Rect::new(0.0, 0.0, app.win_w, app.win_h), C_SCRIM);
    fill_rrect(s, card, R_LG, C_PANEL);
    stroke_rrect(s, card, R_LG, C_LINE_2, 1.0);
    app.fonts.text(
        s,
        cx + 20.0,
        cy + 20.0,
        &format!("Update library “{}”", rv.library_id),
        T14,
        C_TEXT,
        Wt::Semi,
    );
    app.fonts.text(
        s,
        cx + 20.0,
        cy + 42.0,
        &format!(
            "{} · {} change{}",
            rv.path.display(),
            rv.changes.len(),
            if rv.changes.len() == 1 { "" } else { "s" }
        ),
        T10,
        C_MUTED,
        Wt::Reg,
    );
    for (i, ch) in rv.changes.iter().take(8).enumerate() {
        let ry = cy + 64.0 + i as f64 * row_h;
        let (glyph, label): (&str, String) = match ch {
            x_native::LibraryChange::StyleAdded(n) => ("plus", format!("Style added: {n}")),
            x_native::LibraryChange::StyleRemoved(n) => ("x", format!("Style removed: {n}")),
            x_native::LibraryChange::StyleModified(n) => ("pencil", format!("Style modified: {n}")),
            x_native::LibraryChange::VariableChanged(n) => {
                ("code", format!("Variable changed: {n}"))
            }
            x_native::LibraryChange::ComponentAdded(n) => ("plus", format!("Component added: {n}")),
            x_native::LibraryChange::ComponentRemoved(n) => {
                ("x", format!("Component removed: {n}"))
            }
        };
        let icon_c = if label.contains("removed") {
            C_MUTED
        } else {
            C_TEXT
        };
        draw_icon(s, glyph, cx + 20.0, ry + 2.0, ICON_XS, icon_c);
        app.fonts
            .text(s, cx + 40.0, ry + 2.0, &label, T11, C_TEXT, Wt::Reg);
    }
    if rv.changes.len() > 8 {
        app.fonts.text(
            s,
            cx + 40.0,
            cy + 64.0 + 8.0 * row_h,
            &format!("… and {} more", rv.changes.len() - 8),
            T10,
            C_DIM,
            Wt::Reg,
        );
    }
    // footer buttons
    let by = card.y1 - 40.0;
    let accept = Rect::new(card.x1 - 168.0, by, card.x1 - 20.0, card.y1 - 14.0);
    let keep = Rect::new(card.x1 - 292.0, by, card.x1 - 176.0, card.y1 - 14.0);
    fill_rrect(
        s,
        accept,
        R_MD,
        if hover(app, accept) {
            C_LINE_2
        } else {
            C_FIELD_2
        },
    );
    stroke_rrect(s, accept, R_MD, C_LINE_2, 1.0);
    app.fonts
        .text_center(s, accept, "Update library", T11, C_TEXT, Wt::Med, true);
    hit.push((accept, Action::LibReviewAccept));
    fill_rrect(s, keep, R_MD, C_FIELD);
    stroke_rrect(s, keep, R_MD, C_LINE, 1.0);
    app.fonts
        .text_center(s, keep, "Keep pinned version", T11, C_MUTED, Wt::Reg, true);
    hit.push((keep, Action::LibReviewClose));
}

/// The LIBRARY tab's band: the faces the render stack knows, then the
/// document's linked libraries. `y0` is the first section label's line box
/// and `sx` the left dock's left edge — the band is *inside* the dock, so
/// every x is dock-relative (it used to be a window-absolute 12, which put
/// the whole panel on top of the nav rail).
fn paint_assets(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    y0: f64,
    sx: f64,
    lw: f64,
) {
    let x0 = sx + 12.0;
    let mut y = y0;
    app.fonts.micro_label(s, x0, y, "FONTS", C_DIM, Wt::Med);
    y += 18.0;
    let fams = app.fonts.fonts.families();
    if fams.is_empty() {
        app.fonts
            .text(s, x0, y, "No faces registered", T10, C_MUTED, Wt::Reg);
        y += 18.0;
    }
    for (fam, faces) in fams.iter().take(24) {
        let label = if faces.len() > 1 {
            format!("{fam} ({})", faces.len())
        } else {
            fam.clone()
        };
        app.fonts.text(s, x0 + 4.0, y, &label, T10, C_TEXT, Wt::Reg);
        y += 16.0;
    }
    if fams.len() > 24 {
        app.fonts.text(
            s,
            x0 + 4.0,
            y,
            &format!("… {} more families", fams.len() - 24),
            T10,
            C_MUTED,
            Wt::Reg,
        );
        y += 16.0;
    }
    y += 6.0;
    let br = Rect::new(x0, y, lw - 12.0, y + 26.0);
    input_box(app, s, br, 6.0);
    app.fonts
        .text_center(s, br, "Load Font…", T10, C_TEXT, Wt::Med, true);
    hit.push((br, Action::LoadFont));
    y += 34.0;
    let publish = Rect::new(x0, y, lw - 12.0, y + 26.0);
    fill_rrect(
        s,
        publish,
        R_MD,
        if hover(app, publish) {
            C_LINE_2
        } else {
            C_FIELD_2
        },
    );
    stroke_rrect(s, publish, R_MD, C_LINE_2, 1.0);
    app.fonts
        .text_center(s, publish, "Publish library…", T10, C_TEXT, Wt::Med, true);
    hit.push((publish, Action::PublishLibrary));
    y += 34.0;
    app.fonts.text(
        s,
        x0,
        y,
        "TTF / OTF / TTC; text layers can then use it by name",
        T10,
        C_MUTED,
        Wt::Reg,
    );
    y += 20.0;
    // LIBRARIES — pinned document dependencies, each checkable against an
    // updated .xlib on disk (diff review before anything is repinned).
    let deps: Vec<(String, u32)> = app
        .doc_opt()
        .map(|d| {
            d.doc
                .library_deps
                .iter()
                .map(|dep| (dep.library_id.clone(), dep.resolved_version))
                .collect()
        })
        .unwrap_or_default();
    if !deps.is_empty() {
        app.fonts.micro_label(s, x0, y, "LIBRARIES", C_DIM, Wt::Med);
        y += 16.0;
        for (i, (id, ver)) in deps.iter().enumerate() {
            let row_t = y;
            let hover_r = Rect::new(x0, row_t, lw - 12.0, row_t + 20.0);
            if hover(app, hover_r) {
                fill_rrect(s, hover_r, R_SM, C_ROW_HOVER);
            }
            draw_icon(s, "component", x0 + 3.0, row_t + 4.0, ICON_XS, C_MUTED);
            let label = app.fonts.truncate(id, T10, Wt::Med, lw - 92.0);
            app.fonts.text(
                s,
                x0 + 20.0,
                line_top(hover_r, T10),
                &label,
                T10,
                C_TEXT,
                Wt::Med,
            );
            let vs = format!("v{ver}");
            let vw2 = app.fonts.measure(&vs, T10, Wt::Mono);
            app.fonts.text(
                s,
                lw - 74.0 - vw2,
                line_top(hover_r, T10),
                &vs,
                T10,
                C_MUTED,
                Wt::Mono,
            );
            // "check" — picks the updated .xlib and opens the diff review
            let cb = Rect::new(lw - 66.0, row_t + 2.0, lw - 16.0, row_t + 18.0);
            fill_rrect(s, cb, R_SM, if hover(app, cb) { C_LINE_2 } else { C_FIELD });
            app.fonts
                .text_center(s, cb, "check", T10, C_TEXT, Wt::Reg, true);
            hit.push((cb, Action::LibCheckUpdate(i)));
        }
    }
}

// ————————————————————————————————————————— tokens panel (design audit)

/// The TOKENS tab's band: what the document already paints with. Same
/// dock-relative rule as [`paint_assets`].
fn paint_tokens(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    y0: f64,
    sx: f64,
    lw: f64,
) {
    use crate::paint::{fill_rrect, stroke_rrect, Wt};
    let x0 = sx + 12.0;
    let mut y = y0;
    app.var_value_rects.clear();
    app.var_name_rects.clear();
    app.fonts
        .micro_label(s, x0, y, "X-NATIVE TOKENS", C_DIM, Wt::Med);
    y += 18.0;
    let tokens = app
        .doc_opt()
        .map(|d| x_native::analyze_design_root(&d.editors[d.page].root))
        .unwrap_or_default();
    if tokens.colors.is_empty() && tokens.font_sizes.is_empty() {
        app.fonts.text(
            s,
            x0,
            y,
            "No painted content to analyze yet",
            T10,
            C_MUTED,
            Wt::Reg,
        );
        y += 18.0;
    }
    for (hex, count) in tokens.colors.iter().take(7) {
        // the 12px swatch centres on the 15px line box it labels
        let sw = Rect::new(
            x0 + 4.0,
            y + centre_in(ICON_XS, T10 * CSS_LH),
            x0 + 16.0,
            y + centre_in(ICON_XS, T10 * CSS_LH) + ICON_XS,
        );
        if let Some(c) = x_native::parse_hex_color(hex) {
            fill_rrect(s, sw, R_SM, c);
            stroke_rrect(s, sw, R_SM, C_LINE_2, 1.0);
        }
        app.fonts.text(s, x0 + 24.0, y, hex, T10, C_TEXT, Wt::Mono);
        let cnt = format!("×{count}");
        let cw = app.fonts.measure(&cnt, T10, Wt::Reg);
        // the count rides the same baseline as the hex it counts
        app.fonts
            .text(s, lw - 12.0 - cw, y, &cnt, T10, C_MUTED, Wt::Reg);
        y += 18.0;
    }
    if !tokens.font_sizes.is_empty() {
        y += 4.0;
        app.fonts
            .micro_label(s, x0, y, "TYPE SCALE", C_DIM, Wt::Med);
        y += 14.0;
        let row = tokens
            .font_sizes
            .iter()
            .take(6)
            .map(|(sz, _)| sz.clone())
            .collect::<Vec<_>>()
            .join(" · ");
        app.fonts.text(s, x0 + 4.0, y, &row, T10, C_TEXT, Wt::Mono);
        y += 18.0;
    }
    if !tokens.gaps.is_empty() {
        let row = format!(
            "spacing: {}",
            tokens
                .gaps
                .iter()
                .take(6)
                .map(|(g, _)| g.as_str())
                .collect::<Vec<_>>()
                .join(" · ")
        );
        app.fonts.text(s, x0 + 4.0, y, &row, T10, C_MUTED, Wt::Mono);
        y += 16.0;
    }
    let vcount = app
        .doc_opt()
        .map(|d| d.doc.variables.catalog().len())
        .unwrap_or(0);
    y += 2.0;
    let br = Rect::new(x0, y, lw - 12.0, y + 26.0);
    // nothing to extract = a disabled control: it keeps its resting fill on
    // hover (a hover wash also dropped the muted label to 3.05:1 in Daylight)
    let hov = hover(app, br) && !tokens.colors.is_empty();
    fill_rrect(s, br, R_MD, if hov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, br, R_MD, C_LINE_2, 1.0);
    app.fonts.text_center(
        s,
        br,
        if tokens.colors.is_empty() {
            "Nothing to extract"
        } else {
            "Generate variables from tokens"
        },
        T10,
        if tokens.colors.is_empty() {
            C_MUTED
        } else {
            C_TEXT
        },
        Wt::Med,
        true,
    );
    if !tokens.colors.is_empty() {
        hit.push((br, Action::TokensExtractVars));
    }
    y += 32.0;
    // Variables are engine-backed, so the prominent rail has a real creation
    // entry point instead of being a decorative highlight. Names are generated
    // deterministically and can be renamed in the document JSON afterwards.
    app.fonts
        .micro_label(s, x0, y, "NEW VARIABLE", C_DIM, Wt::Med);
    y += 16.0;
    let kinds = [
        (VariableKind::Color, "Color"),
        (VariableKind::Number, "Number"),
        (VariableKind::String, "String"),
        (VariableKind::Boolean, "Boolean"),
    ];
    // both buttons live inside the dock's 12px insets: (right - left - gap)/2.
    // `lw` is the dock's right edge, so the width cannot be derived from it
    // alone — the old `(lw - 16) / 2` assumed a dock that started at x = 0
    // and pushed the right column 48px past the panel edge.
    let bw = ((lw - 12.0) - x0 - 4.0) / 2.0;
    for (i, (kind, label)) in kinds.into_iter().enumerate() {
        let bx = x0 + (i % 2) as f64 * (bw + 4.0);
        let by = y + (i / 2) as f64 * 30.0;
        let br = Rect::new(bx, by, bx + bw, by + 25.0);
        fill_rrect(
            s,
            br,
            R_MD,
            if hover(app, br) { C_LINE_2 } else { C_FIELD_2 },
        );
        stroke_rrect(s, br, R_MD, C_LINE_2, 1.0);
        app.fonts
            .text_center(s, br, label, T10, C_TEXT, Wt::Med, true);
        hit.push((br, Action::CreateVariable(kind)));
    }
    y += 66.0;

    // Variable management rows — every entry is live: ✕ deletes (undoable
    // through the document's variable command log), booleans toggle in place,
    // numbers step by ±1. Editing names/values as text stays in the document
    // JSON for now; the undo button below replays `var_history`.
    let mut rows: Vec<(String, &'static str, String, [u8; 3])> = Vec::new();
    if let Some(d) = app.doc_opt() {
        let v = &d.doc.variables;
        for (_coll, name, kind) in v.catalog().into_iter().take(6) {
            let (disp, sw) = match kind {
                "color" => (
                    v.colors
                        .get(&name)
                        .map(|c| x_native::color_to_hex(*c))
                        .unwrap_or_default(),
                    v.colors
                        .get(&name)
                        .map(|c| {
                            let t = c.to_rgba8();
                            [t.r, t.g, t.b]
                        })
                        .unwrap_or([0x9a, 0x9e, 0xaa]),
                ),
                "number" => (
                    v.numbers
                        .get(&name)
                        .map(|n| format!("{n}"))
                        .unwrap_or_default(),
                    [0x9a, 0x9e, 0xaa],
                ),
                "string" => (
                    v.strings.get(&name).cloned().unwrap_or_default(),
                    [0x9a, 0x9e, 0xaa],
                ),
                _ => (
                    v.bools
                        .get(&name)
                        .map(|b| b.to_string())
                        .unwrap_or_default(),
                    [0x9a, 0x9e, 0xaa],
                ),
            };
            rows.push((name, kind, disp, sw));
        }
    }
    let undo_n = app.doc_opt().map(|d| d.var_history.undo_len()).unwrap_or(0);
    if !rows.is_empty() {
        app.fonts.micro_label(s, x0, y, "VARIABLES", C_DIM, Wt::Med);
        y += 16.0;
    }
    for (name, kind, disp, sw) in rows {
        let row_t = y;
        let hover_r = Rect::new(x0, row_t, lw - 12.0, row_t + 20.0);
        if hover(app, hover_r) {
            fill_rrect(s, hover_r, R_SM, C_ROW_HOVER);
        }
        // kind marker: color swatch or a mono kind letter
        let kr = Rect::new(x0 + 2.0, row_t + 5.0, x0 + 12.0, row_t + 15.0);
        if kind == "color" {
            fill_rrect(s, kr, R_SM, x_native::Color::from_rgb8(sw[0], sw[1], sw[2]));
            stroke_rrect(s, kr, R_SM, C_LINE_2, 1.0);
        } else {
            let glyph = match kind {
                "number" => "N",
                "string" => "S",
                _ => "B",
            };
            app.fonts
                .text_center(s, kr, glyph, T10, C_DIM, Wt::Med, true);
        }
        // name slot: click to rename inline (FieldId::VarName; commits as a
        // rename-as-alias, so old bindings keep resolving).
        let editing_name = app.field.as_ref().map(|f| f.id) == Some(FieldId::VarName)
            && app.var_edit_name.as_deref() == Some(name.as_str());
        let name_shown = if editing_name {
            app.field
                .as_ref()
                .map(|f| f.buffer.clone())
                .unwrap_or_default()
        } else {
            name.clone()
        };
        let nw = app.fonts.measure(&name_shown, T10, Wt::Med);
        app.fonts.text(
            s,
            x0 + 18.0,
            line_top(hover_r, T10),
            &name_shown,
            T10,
            C_TEXT,
            Wt::Med,
        );
        let nr = Rect::new(
            x0 + 16.0,
            row_t + 1.0,
            (x0 + 24.0 + nw).min(lw - 84.0),
            row_t + 19.0,
        );
        if editing_name {
            stroke_rrect(s, nr, R_SM, C_EDIT_BORDER, 1.0);
        } else if hover(app, nr) {
            stroke_rrect(s, nr, R_SM, C_LINE_2, 1.0);
        }
        app.var_name_rects.push((nr, name.clone()));
        hit.push((nr, Action::Field(FieldId::VarName)));
        // value slot: click to edit inline (FieldId::VarValue; the active
        // buffer renders while the field is open). Bools keep the toggle —
        // their text form is still editable from the field.
        let editing_this = app.field.as_ref().map(|f| f.id) == Some(FieldId::VarValue)
            && app.var_edit_name.as_deref() == Some(name.as_str());
        let shown = if editing_this {
            app.field
                .as_ref()
                .map(|f| f.buffer.clone())
                .unwrap_or_default()
        } else {
            disp.clone()
        };
        let vvw = app.fonts.measure(&shown, T10, Wt::Mono);
        app.fonts.text(
            s,
            lw - 66.0 - vvw,
            line_top(hover_r, T10),
            &shown,
            T10,
            if editing_this { C_TEXT } else { C_MUTED },
            Wt::Mono,
        );
        if kind != "bool" {
            let vr = Rect::new(lw - 66.0 - vvw - 4.0, row_t + 1.0, lw - 42.0, row_t + 19.0);
            if editing_this {
                stroke_rrect(s, vr, R_SM, C_EDIT_BORDER, 1.0);
            } else if hover(app, vr) {
                stroke_rrect(s, vr, R_SM, C_LINE_2, 1.0);
            }
            app.var_value_rects.push((vr, name.clone()));
            hit.push((vr, Action::Field(FieldId::VarValue)));
        }
        // kind controls, right-aligned before the delete ✕
        if kind == "bool" {
            let tb = Rect::new(lw - 64.0, row_t + 2.0, lw - 38.0, row_t + 18.0);
            fill_rrect(s, tb, R_SM, if hover(app, tb) { C_LINE_2 } else { C_FIELD });
            app.fonts
                .text_center(s, tb, "on/off", T10, C_TEXT, Wt::Reg, true);
            hit.push((tb, Action::VarToggleBool(name.clone())));
        } else if kind == "number" {
            for (j, (glyph, delta)) in [("−", -1.0), ("+", 1.0)].into_iter().enumerate() {
                let sb = Rect::new(
                    lw - 64.0 + j as f64 * 14.0,
                    row_t + 2.0,
                    lw - 50.0 + j as f64 * 14.0,
                    row_t + 18.0,
                );
                fill_rrect(s, sb, R_SM, if hover(app, sb) { C_LINE_2 } else { C_FIELD });
                app.fonts
                    .text_center(s, sb, glyph, T10, C_TEXT, Wt::Med, true);
                hit.push((sb, Action::VarStep(name.clone(), delta)));
            }
        }
        let del = Rect::new(lw - 30.0, row_t + 3.0, lw - 16.0, row_t + 17.0);
        draw_icon(
            s,
            "x",
            del.x0 + 1.0,
            del.y0 + 1.0,
            ICON_XS,
            if hover(app, del) { C_TEXT } else { C_DIM },
        );
        hit.push((del, Action::VarDelete(name)));
        y += 20.0;
    }
    if undo_n > 0 {
        let ub = Rect::new(x0, y, lw - 12.0, y + 22.0);
        let hov = hover(app, ub);
        fill_rrect(s, ub, R_MD, if hov { C_LINE_2 } else { C_FIELD_2 });
        stroke_rrect(s, ub, R_MD, C_LINE_2, 1.0);
        app.fonts.text_center(
            s,
            ub,
            &format!("Undo variable edit ({undo_n})"),
            T10,
            C_TEXT,
            Wt::Med,
            true,
        );
        hit.push((ub, Action::VarUndoVars));
        y += 28.0;
    }

    // UI theme cycle. Palettes live in x-ui (design_system.rs); paint.rs maps
    // every chrome color through the active one, so this repaints the tool.
    let tb = Rect::new(x0, y, lw - 12.0, y + 26.0);
    let thov = hover(app, tb);
    fill_rrect(s, tb, R_MD, if thov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, tb, R_MD, C_LINE_2, 1.0);
    app.fonts.text_center(
        s,
        tb,
        &format!("Theme: {}", crate::theme::active_theme().label()),
        T10,
        C_TEXT,
        Wt::Med,
        true,
    );
    hit.push((tb, Action::CycleTheme));
    y += 32.0;
    app.fonts.text(
        s,
        x0,
        y,
        &format!(
            "{} variables defined · color/*, text/*, space/*, radius/*",
            vcount
        ),
        T10,
        C_MUTED,
        Wt::Reg,
    );
}

#[cfg(test)]
mod viewport_row_tests {
    use super::*;
    #[test]
    fn size_badge_needs_an_area_to_measure() {
        assert!(size_badge_visible(&Rect::new(100.0, 100.0, 140.0, 140.0)));
        assert!(size_badge_visible(&Rect::new(100.0, 100.0, 100.6, 140.0)));
        // a zero-size node selects fine, but "0 × 0" is not a measurement
        assert!(!size_badge_visible(&Rect::new(100.0, 100.0, 100.0, 100.0)));
        assert!(!size_badge_visible(&Rect::new(100.0, 100.0, 140.0, 100.0)));
    }
    #[test]
    fn layer_rows_allocate_only_the_visible_window_and_keep_flags() {
        let mut app = App::new();
        app.open_blank();
        let root = &mut app.doc().editor().root;
        for i in 0..10_000 {
            let mut n = Node::rect(&format!("r{i}"), 0.0, 0.0, 1.0, 1.0, x_native::Color::WHITE);
            n.locked = i == 9000;
            root.children.push(n);
        }
        app.doc().editor().selection = vec!["r9000".into(), "r9001".into()];
        let pitch = TREE_ROW_H + 1.0;
        let (rows, height) = collect_tree_rows(&app, 9000.0 * pitch, 300.0);
        assert!(rows.len() < 20);
        assert_eq!(height, 10_000.0 * pitch);
        let row = rows.iter().find(|r| r.id == "r9000").unwrap();
        assert!(row.locked && row.selected);
        assert!(rows.iter().find(|r| r.id == "r9001").unwrap().selected);
    }

    #[test]
    fn tree_drop_target_zones_and_exclusions() {
        let mut app = App::new();
        app.open_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc()
            .editor()
            .insert_node(&root_id, Node::frame("fr1", 300.0, 200.0));
        app.doc()
            .editor()
            .insert_node(&root_id, Node::frame("fr2", 300.0, 200.0));
        app.doc().editor().insert_node(
            "fr1",
            Node::rect("card", 0.0, 0.0, 10.0, 10.0, x_native::Color::WHITE),
        );
        app.doc().expanded.insert("fr1".into());
        let (top, _bottom, _scroll) = tree_geometry(&app).unwrap();
        let pitch = TREE_ROW_H + 1.0;
        // rows: fr1 (0), card (1), fr2 (2)
        let row_top = |idx: usize| top + idx as f64 * pitch;
        let x = 120.0;
        let p_before = Point::new(x, row_top(2) + 2.0);
        let p_inside = Point::new(x, row_top(2) + TREE_ROW_H / 2.0);
        let p_after = Point::new(x, row_top(2) + TREE_ROW_H - 1.0);
        let p_leaf = Point::new(x, row_top(1) + TREE_ROW_H / 2.0);
        let p_own = Point::new(x, row_top(1) + 1.0);
        let p_out = Point::new(x, top - 10.0);
        let before = tree_drop_target(&app, "card", p_before);
        assert_eq!(
            before.map(|d| (d.zone, d.parent, d.index)),
            Some((0, root_id.clone(), 1))
        );
        let inside = tree_drop_target(&app, "card", p_inside);
        assert_eq!(
            inside.map(|d| (d.zone, d.parent, d.index)),
            Some((1, "fr2".to_string(), 0))
        );
        let after = tree_drop_target(&app, "card", p_after);
        assert_eq!(
            after.map(|d| (d.zone, d.parent, d.index)),
            Some((2, root_id.clone(), 2))
        );
        // a leaf row never takes a child drop; midpoint falls after
        let leaf_mid = tree_drop_target(&app, "fr2", p_leaf);
        assert_eq!(leaf_mid.map(|d| d.zone), Some(2));
        // the dragged row itself is never a target
        assert!(tree_drop_target(&app, "card", p_own).is_none());
        // descendants are never targets (dragging fr1 over its own child)
        assert!(tree_drop_target(&app, "fr1", p_own).is_none());
        // outside the band
        assert!(tree_drop_target(&app, "card", p_out).is_none());
    }

    #[test]
    fn tree_search_shows_only_matches_and_ancestors() {
        // F8: a query renders matches plus their ancestor chain, through
        // collapsed nodes; clearing the query restores the full tree.
        let mut app = App::new();
        app.open_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc()
            .editor()
            .insert_node(&root_id, Node::frame("fr1", 300.0, 200.0));
        app.doc()
            .editor()
            .insert_node(&root_id, Node::frame("fr2", 300.0, 200.0));
        app.doc().editor().insert_node(
            "fr1",
            Node::rect("card", 0.0, 0.0, 10.0, 10.0, x_native::Color::WHITE),
        );
        app.doc().editor().insert_node(
            "fr2",
            Node::rect("btn", 0.0, 0.0, 10.0, 10.0, x_native::Color::WHITE),
        );
        app.doc().tree_search = "card".into();
        let (rows, _) = collect_tree_rows(&app, 0.0, 400.0);
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["fr1", "card"], "match + its ancestor only");
        app.doc().tree_search.clear();
        let (rows, _) = collect_tree_rows(&app, 0.0, 400.0);
        assert_eq!(rows.len(), 2, "cleared query → both top frames again");
    }

    #[test]
    fn tree_rows_flag_frames_as_sections_but_not_groups() {
        // P5: frames (the document's sections) carry the section affordance;
        // plain group containers do not.
        let mut app = App::new();
        app.open_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc()
            .editor()
            .insert_node(&root_id, Node::frame("fr1", 300.0, 200.0));
        app.doc()
            .editor()
            .insert_node(&root_id, Node::group("gr1", 300.0, 200.0));
        app.doc().editor().insert_node(
            "fr1",
            Node::rect("r1", 0.0, 0.0, 10.0, 10.0, x_native::Color::WHITE),
        );
        app.doc().editor().insert_node(
            "gr1",
            Node::rect("r2", 0.0, 0.0, 10.0, 10.0, x_native::Color::WHITE),
        );
        let (rows, _) = collect_tree_rows(&app, 0.0, 400.0);
        assert_eq!(rows.len(), 2, "collapsed containers hide their children");
        let fr = rows.iter().find(|r| r.id == "fr1").unwrap();
        assert!(
            fr.is_section && fr.has_children && fr.indent == 0,
            "a frame with children is a top-level section"
        );
        let gr = rows.iter().find(|r| r.id == "gr1").unwrap();
        assert!(
            gr.has_children && !gr.is_section,
            "a group is a container but not a section"
        );
        app.doc().expanded.insert("fr1".into());
        let (rows, _) = collect_tree_rows(&app, 0.0, 400.0);
        assert_eq!(rows.len(), 3);
        let child = rows.iter().find(|r| r.id == "r1").unwrap();
        assert!(
            !child.is_section && child.indent == 1,
            "a leaf child sits one level in"
        );
    }
}
