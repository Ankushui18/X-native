//! Editor screen — pixel clone of `ui/v45-final-editor-28px.html`.
//!
//! 36px title (28px logo cell + flush file tabs + [+]), 280px left panel
//! (DRAFTS / file name / LAYERS-ASSETS-TOKENS pills / PAGES / tree),
//! #060606 canvas with floating 40px tool dock, 340px right panel
//! (DESIGN/PROTOTYPE/INSPECT with Size+Position, Auto layout, Appearance,
//! Typography, Fill, Stroke, Effects, GUIDES, Export).

use std::collections::HashSet;

use vello::kurbo::{Affine, Point, Rect};
use vello::peniko::{Color, Fill};
use vello::Scene;
use x_native::{Node, NodeKind};

use crate::icons::{draw_flow_glyph, draw_icon};
use crate::paint::*;
use crate::state::{
    kind_icon, parse_hex, Action, App, CtxCmd, FieldId, LeftTab, RightTab, Tool, FRAME_PRESETS,
};
use crate::theme::*;

// ------------------------------------------------------------------ paint

pub fn paint(app: &mut App, s: &mut Scene) {
    let mut hit: Vec<(Rect, Action)> = Vec::new();
    fill_rect(s, Rect::new(0.0, 0.0, app.win_w, app.win_h), C_BG);
    let reg = app.editor_regions();

    paint_canvas_bg(app, s);
    paint_title(app, s, &mut hit);
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
    if app.palette.open {
        paint_palette(app, s, &mut hit);
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
        // flow preview: scrim + focus instead of editor overlays
        paint_flow_overlay(app, s, &mut hit);
        paint_toolbar(app, s, &mut hit);
        app.hit = hit;
        return;
    }
    paint_canvas_overlays(app, s);
    paint_layout_guides(app, s);
    paint_ruler_guides(app, s);
    paint_smart_guides(app, s);
    paint_text_editor(app, s);
    paint_rulers(app, s);
    paint_toolbar(app, s, &mut hit);
    paint_context_menu(app, s, &mut hit);
    paint_page_menu(app, s, &mut hit);
    app.hit = hit;
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
    for (ax, c) in guides {
        if ax == 'v' {
            let x = app.world_to_screen(Point::new(c, 0.0)).x;
            if x >= reg.canvas.x0 && x <= reg.canvas.x1 {
                vline(s, x, reg.canvas.y0, reg.canvas.y1, crate::theme::C_SNAP);
            }
        } else {
            let y = app.world_to_screen(Point::new(0.0, c)).y;
            if y >= reg.canvas.y0 && y <= reg.canvas.y1 {
                hline(s, reg.canvas.x0, reg.canvas.x1, y, crate::theme::C_SNAP);
            }
        }
    }
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
    let step = doc.guide_size.max(1.0).min(4096.0);
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
            let color = if doc.guide_kind == 1 && i % 4 == 0 {
                vello::peniko::Color::from_rgba8(0x00, 0x99, 0xFF, 0x90)
            } else {
                guide_color.clone()
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
            let color = if doc.guide_kind == 1 && i % 4 == 0 {
                vello::peniko::Color::from_rgba8(0x00, 0x99, 0xFF, 0x90)
            } else {
                guide_color.clone()
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
    stroke_rrect(s, r, 2.0, EDIT_BORDER, 1.5);

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
                fill_rrect(s, hr, 2.0, SELECTION_WASH);
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
        fill_rrect(s, cr, 0.5, crate::theme::C_SEL);
    }
}

/// Translucent selection wash behind the editor's selected text.
const SELECTION_WASH: vello::peniko::Color =
    vello::peniko::Color::from_rgba8(0x00, 0x99, 0xFF, 0x42);

/// Light-blue border shown around the text while it is being edited
/// (Figma's edit-mode frame — replaces the selection chrome).
const EDIT_BORDER: vello::peniko::Color = vello::peniko::Color::from_rgba8(0x00, 0x99, 0xFF, 0x80);

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
/// #222222 hover row. Items act on the current selection.
fn paint_context_menu(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    if !app.context_menu.open {
        return;
    }
    let anchor = Point::new(app.context_menu.x, app.context_menu.y);
    let sel = {
        let d = app.doc();
        !d.editor_ref().selection.is_empty()
    };
    let group_kind = {
        use x_native::NodeKind as K;
        let d = app.doc();
        d.selected_id()
            .and_then(|id| find_node(&d.editor_ref().root, id.as_str()))
            .map(|n| matches!(n.kind, K::Group))
            .unwrap_or(false)
    };
    // boolean combine: enabled once two layers are selected (the engine
    // currently combines exactly two)
    let sel2 = {
        let d = app.doc();
        d.editor_ref().selection.len() >= 2
    };
    let items: Vec<(CtxCmd, &str, &str, &str, bool)> = vec![
        (CtxCmd::Copy, "copy", "Copy", "⌘C", sel),
        (CtxCmd::Cut, "scissors", "Cut", "⌘X", sel),
        (CtxCmd::Paste, "clipboard", "Paste", "⌘V", true),
        (CtxCmd::CopyAsCode, "code", "Copy as code", "", sel),
        (CtxCmd::Duplicate, "copy-plus", "Duplicate", "⌘D", sel),
        (CtxCmd::ToFront, "chevrons-up", "Bring to front", "⇧⌘]", sel),
        (CtxCmd::ToBack, "chevrons-down", "Send to back", "⇧⌘[", sel),
        (CtxCmd::BringFwd, "chevron-up", "Bring forward", "⌘]", sel),
        (CtxCmd::SendBack, "chevron-down", "Send backward", "⌘[", sel),
        (CtxCmd::Delete, "trash-2", "Delete", "⌫", sel),
        (CtxCmd::SelectAll, "box-select", "Select all", "⌘A", true),
        (CtxCmd::Group, "group", "Group selection", "⌘G", sel),
        (
            CtxCmd::Ungroup,
            "ungroup",
            "Ungroup",
            "⇧⌘G",
            sel && group_kind,
        ),
        (
            CtxCmd::MakeComponent,
            "component",
            "Make component",
            "⌘⌥K",
            sel,
        ),
        (CtxCmd::Union, "", "Union selection", "⌘⌥U", sel2),
        (CtxCmd::Subtract, "", "Subtract", "⌘⌥S", sel2),
        (CtxCmd::Intersect, "", "Intersect", "⌘⌥I", sel2),
        (CtxCmd::Exclude, "", "Exclude", "⌘⌥X", sel2),
        (CtxCmd::LockSel, "lock", "Lock", "⇧⌘L", sel),
        (CtxCmd::HideSel, "eye-off", "Hide", "⇧⌘H", sel),
    ];
    let w = 208.0;
    let row_h = 28.0;
    let h = items.len() as f64 * row_h + 10.0;
    let reg = app.editor_regions();
    // keep inside the canvas area
    let mx = anchor
        .x
        .min(reg.canvas.x1 - w - 4.0)
        .max(reg.canvas.x0 + 4.0);
    let my = anchor.y.min(app.win_h - h - 4.0).max(reg.canvas.y0 + 4.0);
    let panel = Rect::new(mx, my, mx + w, my + h);
    drop_shadow(s, panel, 10.0);
    fill_rrect(s, panel, 8.0, C_FIELD);
    stroke_rrect(s, panel, 8.0, C_LINE_2, 1.0);
    let _ = reg;
    for (i, (cmd, icon, label, shortcut, enabled)) in items.iter().enumerate() {
        let r = Rect::new(
            mx + 4.0,
            my + 5.0 + row_h * i as f64,
            mx + w - 4.0,
            my + 5.0 + row_h * (i + 1) as f64,
        );
        let hov = *enabled && hover(app, r);
        if hov {
            fill_rrect(s, r, 5.0, C_FIELD_2);
        }
        let ic = if *enabled { C_TEXT } else { C_DIM };
        draw_icon(s, icon, r.x0 + 8.0, r.y0 + 7.0, 14.0, ic);
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
            hit.push((r, Action::Ctx(*cmd)));
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
    let w = 208.0;
    let row_h = 28.0;
    let h = items.len() as f64 * row_h + 10.0;
    let mx = anchor.x.min(app.win_w - w - 4.0).max(4.0);
    let my = anchor.y.min(app.win_h - h - 4.0).max(4.0);
    let panel = Rect::new(mx, my, mx + w, my + h);
    drop_shadow(s, panel, 10.0);
    fill_rrect(s, panel, 8.0, C_FIELD);
    stroke_rrect(s, panel, 8.0, C_LINE_2, 1.0);
    for (i, (cmd, icon, label, shortcut, enabled)) in items.iter().enumerate() {
        let r = Rect::new(
            mx + 4.0,
            my + 5.0 + row_h * i as f64,
            mx + w - 4.0,
            my + 5.0 + row_h * (i + 1) as f64,
        );
        let hov = *enabled && hover(app, r);
        if hov {
            fill_rrect(s, r, 5.0, C_FIELD_2);
        }
        let ic = if *enabled { C_TEXT } else { C_DIM };
        draw_icon(s, icon, r.x0 + 8.0, r.y0 + 7.0, 14.0, ic);
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
/// screenshot: #2C2C2C bg, #444 inner border, #666 ticks, #777 9px labels.
/// Left-ruler labels are rotated 90° CCW (read bottom-to-top), like Figma.
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
        let lw = app.fonts.measure(&label, T9, Wt::Reg);
        app.fonts.text(
            s,
            sx - lw / 2.0,
            reg.canvas.y0 + 4.0,
            &label,
            T9,
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
        let lw = app.fonts.measure(&label, T9, Wt::Reg);
        let mut tmp = vello::Scene::new();
        app.fonts.text(
            &mut tmp,
            0.0,
            0.0,
            &label,
            T9,
            crate::theme::C_RULER_TEXT,
            Wt::Reg,
        );
        // local x (run) → up, local y (line box) → +x; center both on sy / strip
        let t = vello::kurbo::Affine::translate((
            reg.canvas.x0 + (r - T9 * CSS_LH) / 2.0,
            sy + lw / 2.0,
        )) * vello::kurbo::Affine::rotate(-std::f64::consts::FRAC_PI_2);
        s.append(&tmp, Some(t));
        wy += step;
    }
}

fn hover(app: &App, r: Rect) -> bool {
    r.contains(app.mouse)
}

/// Field/input box with the HTML `.input:hover` state (#1E1E1E bg,
/// #2A2A2A border) applied on hover
fn input_box(app: &App, s: &mut Scene, r: Rect, radius: f64) {
    let hov = hover(app, r);
    fill_rrect(s, r, radius, if hov { C_INPUT_HOVER } else { C_FIELD });
    stroke_rrect(s, r, radius, if hov { C_LINE_2 } else { C_LINE }, 1.0);
}

// ------------------------------------------------------------- canvas bg

fn paint_canvas_bg(app: &App, s: &mut Scene) {
    let r = app.editor_regions();
    fill_rect(s, r.canvas, app.canvas_bg);
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
                2.0,
                C_MD_BADGE,
            );
            // ✦ (U+2726) isn't in Inter's latin subset — draw the 4-point
            // star as a path matched to the Chromium render
            crate::icons::draw_md_star(s, ix + 6.0, iy + 7.0, 3.25, C_TEXT);
        } else if is_untitled_home {
            draw_icon(s, "home", ix, iy, 14.0, C_DIM);
        } else {
            draw_icon(s, "file-text", ix, iy, 14.0, C_DIM);
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
            fill_rrect(s, cx_r, 4.0, C_LINE_2);
        }
        draw_icon(
            s,
            "x",
            cx_r.x0 + 2.0,
            cx_r.y0 + 2.0,
            12.0,
            if hover(app, cx_r) { C_TEXT } else { C_DIM },
        );
        hit.push((cx_r, Action::CloseDoc(i)));
        hit.push((r, Action::SelectDoc(i)));
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
        14.0,
        C_DIM,
    );
    hit.push((nb, Action::NewFile));

    // rename doc field lives in the left panel; caret drawn there
}

// ------------------------------------------------------- left panel 280px

fn paint_left(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let lw = reg.left.x1;
    fill_rect(s, reg.left, C_PANEL);
    vline(s, lw - 1.0, ED_TITLE_H, app.win_h, C_LINE);

    // Audited (1440): DRAFTS row 48, project row 78, pills 110.5, PAGES 156.5,
    // page field 178, divider 218, tree from 252.5. Offsets below are abs - 36.
    let y0 = ED_TITLE_H;

    // DRAFTS header
    fill_rrect(s, Rect::new(12.0, y0 + 12.0, 28.0, y0 + 28.0), 4.0, C_FIELD);
    stroke_rrect(
        s,
        Rect::new(12.0, y0 + 12.0, 28.0, y0 + 28.0),
        4.0,
        C_LINE,
        1.0,
    );
    draw_icon(s, "box", 16.0, y0 + 16.0, 12.0, C_DIM);
    app.fonts
        .text_tracked(s, 36.0, y0 + 13.3, "DRAFTS", T9, 0.12, C_DIM, Wt::Med);
    draw_icon(s, "more-horizontal", lw - 27.0, y0 + 13.0, 14.0, C_DIM);

    // file name row (editable) — the mock's file-name-text, independent
    // from the active tab name
    let (name, _dirty) = {
        let d = app.doc();
        (
            d.file_label.clone().unwrap_or_else(|| d.name.clone()),
            d.dirty,
        )
    };
    let ny = y0 + 42.0; // name text box top 78
    let nr = Rect::new(8.0, ny - 3.0, lw - 8.0, ny + 20.5);
    if app.field.as_ref().map(|f| f.id) == Some(FieldId::DocName) {
        let editing = app.field.as_ref().unwrap().buffer.clone();
        fill_rrect(
            s,
            Rect::new(12.0, ny - 1.0, lw - 12.0, ny + 19.0),
            4.0,
            C_FIELD,
        );
        stroke_rrect(
            s,
            Rect::new(12.0, ny - 1.0, lw - 12.0, ny + 19.0),
            4.0,
            C_LINE_2,
            1.0,
        );
        app.fonts.text(s, 18.0, ny, &editing, T11, C_TEXT, Wt::Med);
    } else {
        if hover(app, nr) {
            // .editable:hover — bg #1A1A1A, border #2A2A2A, radius 4
            fill_rrect(s, nr, 4.0, C_FIELD);
            stroke_rrect(s, nr, 4.0, C_LINE_2, 1.0);
        }
        circle(s, 15.0, ny + 8.3, 3.0, C_DRAFT_DOT);
        let shown = app.fonts.truncate(&name, T11, Wt::Med, lw - 24.0 - 40.0);
        app.fonts.text(s, 26.0, ny, &shown, T11, C_TEXT, Wt::Med);
        if hover(app, nr) {
            draw_icon(s, "pencil", lw - 25.0, ny + 2.3, 12.0, C_DIM);
        }
    }
    hit.push((nr, Action::RenameStart));

    // pill tabs LAYERS / ASSETS / TOKENS — container (8,110.5,263,30)
    let pill_y = y0 + 74.5;
    let px0 = 8.0;
    let pw = 263.0;
    fill_rrect(
        s,
        Rect::new(px0, pill_y, px0 + pw, pill_y + PILL_H),
        8.0,
        C_BG,
    );
    stroke_rrect(
        s,
        Rect::new(px0, pill_y, px0 + pw, pill_y + PILL_H),
        8.0,
        C_LINE,
        1.0,
    );
    let item_w = 85.0;
    let tabs = [
        (LeftTab::Layers, "LAYERS"),
        (LeftTab::Assets, "ASSETS"),
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
            T9,
            if active { C_TEXT } else { C_DIM },
            Wt::Semi,
            true,
        );
        {
            hit.push((ir, Action::LeftTab(tab)));
        }
    }
    let y = y0 + 120.5; // PAGES label top 156.5

    if app.doc().left_tab == LeftTab::Assets {
        paint_assets(app, s, hit, y0 + 108.0, lw);
    }
    if app.doc().left_tab == LeftTab::Tokens {
        paint_tokens(app, s, hit, y0 + 108.0, lw);
    }

    // PAGES section
    app.fonts
        .text_tracked(s, 12.0, y, "PAGES", T9, 0.12, C_DIM, Wt::Med);
    let addp = Rect::new(lw - 25.0, y + 0.8, lw - 13.0, y + 12.8);
    draw_icon(s, "plus", addp.x0, y + 0.8, 12.0, C_DIM);
    hit.push((addp, Action::AddPage)); // page field top 178 → drawn below

    // The mock shows a single field: the active page ("Page 3" with 3 pages
    // in the demo doc) — not a full page list.
    let page_count = app.doc().editors.len();
    let cur_page = app.doc().page;
    let py = y0 + 142.0;
    let pr = Rect::new(12.0, py, lw - 25.0, py + 28.0);
    app.page_field_rect = Some(pr);
    fill_rrect(s, pr, R_PAGE, C_FIELD);
    stroke_rrect(s, pr, R_PAGE, C_LINE_2, 1.0);
    draw_icon(s, "file", 21.0, py + 8.0, 12.0, C_TEXT);
    let page_label = {
        let d = app.doc();
        d.doc
            .pages
            .get(cur_page)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| format!("Page {}", cur_page + 1))
    };
    // inline rename state (opened from the page context menu): the field
    // box shows the buffer; the Field hit zone (pushed BEFORE SelectPage,
    // so clicks still select) lets paint_carets find the caret position
    if app.field.as_ref().map(|f| f.id) == Some(FieldId::PageName) {
        let editing = app.field.as_ref().unwrap().buffer.clone();
        fill_rrect(s, pr, R_PAGE, C_FIELD_2);
        stroke_rrect(s, pr, R_PAGE, C_LINE_2, 1.0);
        app.fonts
            .text(s, 41.0, py + 5.8, &editing, T11, C_TEXT, Wt::Reg);
        hit.push((pr, Action::Field(FieldId::PageName)));
    } else {
        app.fonts
            .text(s, 41.0, py + 5.8, &page_label, T11, C_TEXT, Wt::Reg);
    }
    if hover(app, pr) && page_count > 1 {
        let tr = Rect::new(lw - 30.0, py + 6.0, lw - 12.0, py + 22.0);
        draw_icon(s, "trash-2", tr.x0, py + 7.0, 12.0, C_DIM);
        hit.push((tr, Action::DeletePage(cur_page)));
    }
    hit.push((pr, Action::SelectPage(cur_page)));

    // divider at 218
    hline(s, 0.0, lw, y0 + 182.0, C_LINE);

    // PAGE header — audit: label top 231, search icon 12px at (255, 231.8)
    let page_name = format!("PAGE {}", cur_page + 1);
    app.fonts
        .text_tracked(s, 12.0, y0 + 195.0, &page_name, T9, 0.12, C_DIM, Wt::Med);
    draw_icon(s, "search", lw - 25.0, y0 + 195.8, 12.0, C_DIM);

    // tree (scrollable) from 252.5
    let tree_top = y0 + 216.5;
    let tree_bottom = app.win_h - 16.0;
    let scroll = app.doc().scroll_left;
    if !app.doc().mock_layers.is_empty() {
        // v45 mock: render the hardcoded layers array (same row geometry as
        // the real tree)
        let mocks = app.doc().mock_layers.clone();
        // flat-array tree visibility: a row is hidden while any ancestor
        // with a smaller indent is collapsed
        let mut stack: Vec<(usize, bool)> = Vec::new();
        let mut ry = tree_top - scroll;
        for (mi, mock) in mocks.iter().enumerate() {
            while stack
                .last()
                .map(|(i, _)| *i >= mock.indent)
                .unwrap_or(false)
            {
                stack.pop();
            }
            let visible = stack.iter().all(|(_, e)| *e);
            if mock.has_children {
                stack.push((mock.indent, mock.expanded));
            }
            if visible {
                let r = Rect::new(8.0, ry, lw - 8.0, ry + TREE_ROW_H);
                if r.y1 >= tree_top && r.y0 <= tree_bottom {
                    if mock.selected {
                        fill_rrect(s, r, R_TREE, C_SEL_SOFT);
                    }
                    let ix = 8.0 + 8.0 + mock.indent as f64 * TREE_INDENT;
                    if mock.has_children {
                        let chev = if mock.expanded {
                            "chevron-down"
                        } else {
                            "chevron-right"
                        };
                        let cr = Rect::new(ix, r.y0, ix + 14.0, r.y1);
                        draw_icon(s, chev, ix + 1.0, r.y0 + 5.0, 12.0, C_DIM);
                        hit.push((cr, Action::TreeToggle(format!("mock:{mi}"))));
                    }
                    draw_icon(s, mock.icon, ix + 14.0, r.y0 + 5.0, 12.0, C_DIM);
                    let nx = ix + 14.0 + 12.0 + 4.0;
                    let max_nw = lw - 8.0 - nx - 8.0;
                    let shown = app
                        .fonts
                        .truncate(&mock.name, T11, Wt::Reg, max_nw.max(16.0));
                    app.fonts.text(
                        s,
                        nx,
                        r.y0 + (TREE_ROW_H - T11 * CSS_LH) / 2.0,
                        &shown,
                        T11,
                        if mock.selected { C_TEXT } else { C_ZINC_400 },
                        Wt::Reg,
                    );
                    hit.push((r, Action::TreeRow(format!("mock:{mi}"))));
                }
                ry += TREE_ROW_H + 1.0;
            }
        }
        app.scaled = false;
    } else {
        let (rows, total_h) = collect_tree_rows(app, scroll, tree_bottom - tree_top);
        for row in &rows {
            let ry = tree_top + row.index as f64 * (TREE_ROW_H + 1.0) - scroll;
            let r = Rect::new(8.0, ry, lw - 8.0, ry + TREE_ROW_H);
            if r.y1 >= tree_top && r.y0 <= tree_bottom {
                let selected = row.selected;
                if hover(app, r) || selected {
                    fill_rrect(
                        s,
                        r,
                        R_TREE,
                        if selected { C_SEL_SOFT } else { C_ROW_HOVER },
                    );
                }
                let ix = 8.0 + 8.0 + row.indent as f64 * TREE_INDENT;
                if row.has_children {
                    let chev = if row.expanded {
                        "chevron-down"
                    } else {
                        "chevron-right"
                    };
                    let cr = Rect::new(ix, r.y0, ix + 14.0, r.y1);
                    draw_icon(s, chev, ix + 1.0, r.y0 + 5.0, 12.0, C_DIM);
                    hit.push((cr, Action::TreeToggle(row.id.clone())));
                } else {
                    let _ = 12.0; // 12px spacer per the HTML
                }
                draw_icon(s, row.icon, ix + 14.0, r.y0 + 5.0, 12.0, C_DIM);
                let nx = ix + 14.0 + 12.0 + 4.0;
                let max_nw = lw - 8.0 - nx - 8.0;
                let shown = app
                    .fonts
                    .truncate(&row.name, T11, Wt::Reg, max_nw.max(16.0));
                app.fonts.text(
                    s,
                    nx,
                    r.y0 + (TREE_ROW_H - T11 * CSS_LH) / 2.0,
                    &shown,
                    T11,
                    if selected { C_TEXT } else { C_ZINC_400 },
                    Wt::Reg,
                );
                hit.push((r, Action::TreeRow(row.id.clone())));
                // Figma row toggles: eye / padlock on hover (persistent when
                // the state is on); sit above the row hit (reversed scan)
                let (locked, hidden) = (row.locked, row.hidden);
                let row_hover = hover(app, r);
                if row_hover || hidden {
                    let ey = Rect::new(lw - 8.0 - 34.0, r.y0 + 2.0, lw - 8.0 - 20.0, r.y1 - 2.0);
                    draw_icon(
                        s,
                        if hidden { "eye-off" } else { "eye" },
                        ey.x0 + 1.0,
                        r.y0 + 5.0,
                        12.0,
                        if hidden { C_TEXT } else { C_DIM },
                    );
                    hit.push((ey, Action::TreeVisible(row.id.clone())));
                }
                if row_hover || locked {
                    let lr = Rect::new(lw - 8.0 - 18.0, r.y0 + 2.0, lw - 8.0 - 4.0, r.y1 - 2.0);
                    draw_icon(
                        s,
                        "lock",
                        lr.x0 + 1.0,
                        r.y0 + 5.0,
                        12.0,
                        if locked { C_TEXT } else { C_DIM },
                    );
                    hit.push((lr, Action::TreeLock(row.id.clone())));
                }
            }
        }
        app.scaled = total_h > tree_bottom - tree_top;
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
            });
        }
        index += 1;
        if expanded {
            stack.push((child.children.iter(), indent + 1));
        }
    }
    (out, index as f64 * pitch)
}

/// 6px edge strips between canvas and panels — drags are handled
/// positionally by run.rs before hit dispatch; this only paints hover.
fn paint_resizers(app: &App, s: &mut Scene) {
    let reg = app.editor_regions();
    let lr = Rect::new(
        reg.left.x1 - RESIZER_W / 2.0,
        ED_TITLE_H,
        reg.left.x1 + RESIZER_W / 2.0,
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
    if hover(app, lr) || l_drag {
        fill_rect(s, lr, vello::peniko::Color::from_rgba8(255, 255, 255, 20));
    }
    if hover(app, rr) || r_drag {
        fill_rect(s, rr, vello::peniko::Color::from_rgba8(255, 255, 255, 20));
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
        11.0,
        &app.user
            .chars()
            .next()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".into()),
    );
    let zoom_label = format!("{}%", (app.zoom * 100.0).round() as i64);
    app.fonts.text(
        s,
        rx + 45.0,
        ED_TITLE_H + 15.8,
        &zoom_label,
        T11,
        C_MUTED,
        Wt::Reg,
    );
    let icons = ["message-circle", "history", "play"];
    for (i, ic) in icons.iter().enumerate() {
        let ix = rx + rw - 84.0 + 28.0 * i as f64;
        let iy = ED_TITLE_H + 16.0;
        draw_icon(s, ic, ix, iy, 16.0, C_DIM);
        let icon_hit = Rect::new(ix - 2.0, iy - 2.0, ix + 18.0, iy + 18.0);
        match i {
            0 => hit.push((icon_hit, Action::Tool(Tool::Comment))),
            2 => hit.push((icon_hit, Action::RightTab(RightTab::Prototype))),
            _ => {}
        }
    }

    // pill tabs DESIGN / PROTOTYPE / INSPECT
    let py = ED_TITLE_H + 50.0;
    let px0 = rx + 9.0;
    let pw = rw - 17.0;
    fill_rrect(s, Rect::new(px0, py, px0 + pw, py + 30.0), 8.0, C_BG);
    stroke_rrect(s, Rect::new(px0, py, px0 + pw, py + 30.0), 8.0, C_LINE, 1.0);
    let item_w = (pw - 6.0 - 4.0) / 4.0;
    let tabs = [
        (RightTab::Design, "DESIGN"),
        (RightTab::Prototype, "PROTOTYPE"),
        (RightTab::Inspect, "INSPECT"),
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
            T9,
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
    let clip = Rect::new(rx, y, reg.right.x1, app.win_h);
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
        };
    };
    let radius = n.corner_radii.map(|c| c[0]).unwrap_or(match n.kind {
        NodeKind::Rect { radius } => radius,
        _ => 0.0,
    });
    let clip = matches_frame_clip(n);
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
    }
}

fn matches_frame_clip(n: &Node) -> bool {
    matches!(n.kind, NodeKind::Frame { .. }) && n.overflow.clips()
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
    let Some(t) = app.selected_text_typo() else {
        return match which {
            Typo::Family => "Manrope".into(),
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
        };
    };
    match which {
        Typo::Family => t.font.unwrap_or_else(|| "Inter".into()),
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
    stroke_rrect(s, r, R_INPUT, if hov { C_LINE_2 } else { C_LINE }, 1.0);
    let mut tx = r.x0 + 8.0;
    if let Some((text, size)) = label {
        // center the CSS line box (1.5em), like flex align-items:center —
        // audit: 9px label top +7.25, 10px +6.5 inside the 28px field
        let ty = r.y0 + (INPUT_H.min(r.y1 - r.y0) - size * CSS_LH) / 2.0;
        app.fonts.text(s, tx, ty, text, size, C_DIM, Wt::Reg);
        // 9px labels sit in a fixed w-4 slot (span.w-4) then ~4px to the value
        tx += if (size - T9).abs() < 0.01 {
            16.0 + 4.4
        } else {
            app.fonts.measure(text, size, Wt::Reg) + 6.0
        };
    }
    let wt = if mono { Wt::Mono } else { Wt::Reg };
    // audit: 11px value box top +5.75 inside the 28px field
    let vh = T11 * CSS_LH;
    let vy = r.y0 + (r.y1 - r.y0 - vh) / 2.0;
    app.fonts.text(s, tx, vy, value, T11, C_TEXT, wt);
    if let Some(ic) = right_icon {
        draw_icon(
            s,
            ic,
            r.x1 - 8.0 - 12.0,
            r.y0 + (r.y1 - r.y0 - 12.0) / 2.0,
            12.0,
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
    fill_rrect(s, r, 8.0, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, r, 8.0, C_LINE, 1.0);
    if !dimmed {
        draw_icon(
            s,
            icon,
            x + (SQ_BTN - 14.0) / 2.0,
            y + (SQ_BTN - 14.0) / 2.0,
            14.0,
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
    let w = xr - x0;

    // CANVAS BACKGROUND
    app.fonts.text_tracked(
        s,
        x0,
        y0 + 14.0,
        "CANVAS BACKGROUND",
        T9,
        0.12,
        C_DIM,
        Wt::Med,
    );
    let f1 = Rect::new(x0, y0 + 30.0, x0 + w, y0 + 58.0);
    input_box(app, s, f1, R_INPUT);
    fill_rrect(
        s,
        Rect::new(x0 + 8.0, y0 + 37.0, x0 + 22.0, y0 + 51.0),
        4.0,
        app.canvas_bg,
    );
    stroke_rrect(
        s,
        Rect::new(x0 + 8.0, y0 + 37.0, x0 + 22.0, y0 + 51.0),
        4.0,
        C_LINE_2,
        1.0,
    );
    let bg_hex = field_val(app, FieldId::CanvasBg, hex6(app.canvas_bg));
    app.fonts
        .text(s, x0 + 30.0, y0 + 37.8, &bg_hex, T11, C_TEXT, Wt::Mono);
    hit.push((f1, Action::Field(FieldId::CanvasBg)));

    // PIXEL GRID COLOR
    app.fonts.text_tracked(
        s,
        x0,
        y0 + 74.0,
        "PIXEL GRID COLOR",
        T9,
        0.12,
        C_DIM,
        Wt::Med,
    );
    let pct_w = 64.0;
    let f2 = Rect::new(x0, y0 + 90.0, xr - pct_w - 8.0, y0 + 118.0);
    input_box(app, s, f2, R_INPUT);
    fill_rrect(
        s,
        Rect::new(f2.x0 + 8.0, y0 + 97.0, f2.x0 + 22.0, y0 + 111.0),
        4.0,
        app.grid_color,
    );
    stroke_rrect(
        s,
        Rect::new(f2.x0 + 8.0, y0 + 97.0, f2.x0 + 22.0, y0 + 111.0),
        4.0,
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
        .text(s, f3.x0 + 33.5, y0 + 95.8, &pct_val, T11, C_TEXT, Wt::Mono);
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
    // Absolute geometry from the Chromium audit of v45-final-editor-28px.html
    // at 1440 (see /home/user/ref/audit-editor.json). `y_entry` is the pixel
    // right after the pill-tabs divider (abs 125); all offsets below are
    // audit_y - 125, so the panel is exact at any window size.
    let scroll = app.doc().scroll_right;
    let y0 = y_entry - scroll;
    let pl = 12.0;
    let x0 = rx + pl + 1.0; // 1113 @1440: 1px panel border + 12px padding
    if app.doc().editor_ref().selection.is_empty() {
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
    // justify-between: label left, input text left-aligned after it
    // (audit: '%' box at +9, value at +33.5), chevron right
    let pct_val = field_val(
        app,
        FieldId::Zoom,
        format!("{}", (app.zoom * 100.0).round()),
    );
    app.fonts
        .text(s, pct.x0 + 33.5, r1 + 5.8, &pct_val, T11, C_TEXT, Wt::Mono);
    hit.push((pct, Action::Field(FieldId::Zoom)));
    // chevron: audited ink 1337-1344 → icon left = field right − 21
    draw_icon(s, "chevron-down", pct.x1 - 21.0, r1 + 8.0, 12.0, C_DIM);
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
        Some(("W", T9)),
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
        Some(("H", T9)),
        &field_val(app, FieldId::H, fmt_num(sel.h)),
        mono,
        Some(Action::Field(FieldId::H)),
        None,
    );
    let aspect_lock = Rect::new(x0 + 287.0, r2, x0 + 287.0 + SQ_BTN, r2 + SQ_BTN);
    sq_btn(app, s, hit, aspect_lock.x0, aspect_lock.y0, "lock", false);
    if app.aspect_ratio_locked {
        fill_rrect(s, aspect_lock, 8.0, C_FIELD_2);
        draw_icon(s, "lock", aspect_lock.x0 + 7.0, aspect_lock.y0 + 7.0, 14.0, C_TEXT);
    }
    hit.push((aspect_lock, Action::ToggleAspectRatio));

    let r3 = y0 + 84.0;
    let xr3 = Rect::new(x0, r3, x0 + half, r3 + h);
    input(
        app,
        s,
        hit,
        xr3,
        Some(("X", T9)),
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
        Some(("Y", T9)),
        &field_val(app, FieldId::Y, fmt_num(sel.y)),
        mono,
        Some(Action::Field(FieldId::Y)),
        None,
    );
    // third slot is an `opacity-0` spacer in the HTML — nothing drawn

    let r4 = y0 + 120.0;
    let rr = Rect::new(x0, r4, x0 + 140.0, r4 + h);
    input_box(app, s, rr, R_INPUT);
    draw_icon(s, "rotate-cw", rr.x0 + 8.0, r4 + 8.0, 12.0, C_DIM);
    let rot_val = field_val(app, FieldId::Rotation, fmt_num(sel.rot));
    app.fonts
        .text(s, rr.x0 + 26.0, r4 + 5.8, &rot_val, T11, C_TEXT, Wt::Mono);
    hit.push((rr, Action::Field(FieldId::Rotation)));

    hline(s, rx, rx + rw, y0 + 160.0, C_LINE);

    // ---- auto layout: container +161 ------------------------------------
    app.fonts
        .text(s, x0, y0 + 176.8, "Auto layout", T11, C_TEXT, Wt::Med);
    let addb = Rect::new(xr - 24.0, y0 + 173.0, xr, y0 + 197.0);
    let hov = hover(app, addb);
    fill_rrect(s, addb, 6.0, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, addb, 6.0, C_LINE, 1.0);
    draw_icon(s, "plus", addb.x0 + 5.0, addb.y0 + 5.0, 14.0, C_DIM);
    // The add button must create the same default layout that the Flow
    // controls edit; previously it was painted without a hit target.
    hit.push((addb, Action::AddAutoLayout));

    app.fonts
        .text(s, x0, y0 + 209.0, "Flow", T10, C_DIM, Wt::Reg);
    draw_icon(s, "arrow-up-right", xr - 14.0, y0 + 207.5, 14.0, C_DIM);
    let flow_xs = [0.0, 80.3, 160.5, 240.8];
    let flow = app.doc().flow;
    let boot_mock = app.doc().flow_boot_mock;
    for (i, &fxs) in flow_xs.iter().enumerate() {
        let fx = x0 + fxs;
        let fr = Rect::new(fx, y0 + 232.0, fx + 74.3, y0 + 260.0);
        let active = flow == i || (boot_mock && matches!(i, 0 | 2));
        let hov = hover(app, fr);
        fill_rrect(
            s,
            fr,
            8.0,
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
            8.0,
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
        .text(s, x0, y0 + 276.0, "Resizing", T10, C_DIM, Wt::Reg);
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
        let fr = Rect::new(fx, y0 + 299.0, fx + 133.5, y0 + 331.0);
        input_box(app, s, fr, 8.0);
        app.fonts
            .text(s, fx + 9.0, y0 + 308.3, axis, T9, C_DIM, Wt::Reg);
        app.fonts
            .text(s, fx + 26.0, y0 + 306.8, &val, T11, C_TEXT, Wt::Mono);
        let chip = Rect::new(fx + 93.5, y0 + 305.5, fx + 124.5, y0 + 324.5);
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
        fill_rrect(s, chip, 4.0, if chov { C_INPUT_HOVER } else { C_FIELD_2 });
        stroke_rrect(s, chip, 4.0, C_LINE_2, 1.0);
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
    let mz = Rect::new(x0 + 283.0, y0 + 299.0, x0 + 315.0, y0 + 331.0);
    input_box(app, s, mz, 8.0);
    draw_icon(s, "maximize-2", mz.x0 + 9.0, mz.y0 + 9.0, 14.0, C_DIM);

    app.fonts
        .text(s, x0, y0 + 347.0, "Alignment", T10, C_DIM, Wt::Reg);
    app.fonts
        .text_right(s, xr, y0 + 347.0, "Gap", T10, C_DIM, Wt::Reg, 0.0);
    // 9-dot alignment card 84×84 at +370
    let card = Rect::new(x0, y0 + 370.0, x0 + 84.0, y0 + 454.0);
    fill_rrect(s, card, 12.0, C_FIELD);
    stroke_rrect(s, card, 12.0, C_LINE, 1.0);
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
                circle(
                    s,
                    dx,
                    dy,
                    9.0,
                    vello::peniko::Color::from_rgba8(255, 255, 255, 31),
                );
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
    // gap column: two 32px fields at x0+96
    let gx = x0 + 96.0;
    let g1 = Rect::new(gx, y0 + 370.0, gx + 219.0, y0 + 402.0);
    input_box(app, s, g1, 8.0);
    draw_icon(
        s,
        "arrow-left-right",
        g1.x0 + 8.0,
        g1.y0 + 10.0,
        12.0,
        C_DIM,
    );
    let gap_now = app.doc().gap;
    let gap_val = field_val(app, FieldId::Gap, fmt_num(gap_now));
    app.fonts
        .text(s, g1.x0 + 29.0, g1.y0 + 6.8, &gap_val, T11, C_TEXT, Wt::Reg);
    draw_icon(s, "chevron-down", g1.x1 - 20.0, g1.y0 + 10.0, 12.0, C_DIM);
    hit.push((g1, Action::Field(FieldId::Gap)));
    let g2 = Rect::new(gx, y0 + 410.0, gx + 219.0, y0 + 442.0);
    input_box(app, s, g2, 8.0);
    draw_icon(
        s,
        "arrow-up-down",
        g2.x0 + 8.0,
        g2.y0 + 10.0,
        12.0,
        C_DIM,
    );
    // The second gap axis was previously a decorative empty field. Both
    // axes use the engine's single Auto Layout gap value until independent
    // row/column gaps are supported.
    app.fonts
        .text(s, g2.x0 + 29.0, g2.y0 + 6.8, &gap_val, T11, C_TEXT, Wt::Reg);
    hit.push((g2, Action::Field(FieldId::Gap)));

    app.fonts
        .text(s, x0, y0 + 470.0, "Padding", T10, C_DIM, Wt::Reg);
    for (i, (fid, val)) in [
        (FieldId::PadH, app.doc().pad_h),
        (FieldId::PadV, app.doc().pad_v),
    ]
    .into_iter()
    .enumerate()
    {
        let fx = x0 + 141.5 * i as f64;
        let pr = Rect::new(fx, y0 + 493.0, fx + 133.5, y0 + 525.0);
        input_box(app, s, pr, 8.0);
        let g = Rect::new(pr.x0 + 9.0, pr.y0 + 8.0, pr.x0 + 25.0, pr.y0 + 24.0);
        let gray55 = vello::peniko::Color::from_rgb8(0x55, 0x55, 0x55);
        stroke_rrect(s, g, 3.0, gray55, 1.0);
        if i == 0 {
            vline(s, g.x0 + 5.0, g.y0 + 3.0, g.y1 - 3.0, gray55);
            vline(s, g.x1 - 5.0, g.y0 + 3.0, g.y1 - 3.0, gray55);
        } else {
            hline(s, g.x0 + 3.0, g.x1 - 3.0, g.y0 + 5.0, gray55);
            hline(s, g.x0 + 3.0, g.x1 - 3.0, g.y1 - 5.0, gray55);
        }
        let v = field_val(app, fid, fmt_num(val));
        app.fonts
            .text(s, g.x1 + 5.0, pr.y0 + 6.8, &v, T11, C_TEXT, Wt::Reg);
        hit.push((pr, Action::Field(fid)));
    }
    let pgb = Rect::new(x0 + 283.0, y0 + 493.0, x0 + 315.0, y0 + 525.0);
    input_box(app, s, pgb, 8.0);
    draw_icon(s, "layout-grid", pgb.x0 + 9.0, pgb.y0 + 9.0, 14.0, C_DIM);

    // ---- A3/A4 row: Wrap (frame WITH auto-layout) or, for a CHILD of
    // an auto-layout frame, Fill container + Absolute position. Sits in
    // the free band under the alignment card — mock geometry unchanged.
    if sel_layout.is_some() {
        let wrapping = sel_layout
            .as_ref()
            .map(|l| l.wrap == x_native::AutoLayoutWrap::Wrap)
            .unwrap_or(false);
        let wb = Rect::new(x0, y0 + 448.0, x0 + 16.0, y0 + 464.0);
        fill_rrect(s, wb, 4.0, C_FIELD);
        stroke_rrect(s, wb, 4.0, C_LINE_2, 1.0);
        if wrapping {
            fill_rrect(s, wb.inflate(-3.0, -3.0), 2.0, C_TEXT);
        }
        app.fonts
            .text(s, wb.x1 + 8.0, y0 + 447.7, "Wrap", T11, C_MUTED, Wt::Reg);
        hit.push((
            Rect::new(x0, y0 + 444.0, x0 + 110.0, y0 + 468.0),
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
        let seg = Rect::new(x0, y0 + 444.0, x0 + 150.0, y0 + 468.0);
        let half = Rect::new(seg.x0, seg.y0, seg.x0 + 74.0, seg.y1);
        let other = Rect::new(half.x1, seg.y0, seg.x1, seg.y1);
        for (rr, lab, active, act) in [
            (half, "Fixed", !grow, Action::SetChildFill(false)),
            (other, "Fill", grow, Action::SetChildFill(true)),
        ] {
            fill_rrect(s, rr, 6.0, if active { C_FIELD_2 } else { C_FIELD });
            stroke_rrect(s, rr, 6.0, if active { C_LINE_2 } else { C_LINE }, 1.0);
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
        let ab = Rect::new(x0 + 162.0, y0 + 448.0, x0 + 178.0, y0 + 464.0);
        fill_rrect(s, ab, 4.0, C_FIELD);
        stroke_rrect(s, ab, 4.0, C_LINE_2, 1.0);
        if absolute {
            fill_rrect(s, ab.inflate(-3.0, -3.0), 2.0, C_TEXT);
        }
        app.fonts.text(
            s,
            ab.x1 + 8.0,
            y0 + 447.7,
            "Absolute",
            T11,
            C_MUTED,
            Wt::Reg,
        );
        hit.push((
            Rect::new(x0 + 162.0, y0 + 444.0, x0 + 262.0, y0 + 468.0),
            Action::ToggleChildAbsolute,
        ));
    }

    // clip content
    let cb = Rect::new(x0, y0 + 541.3, x0 + 16.0, y0 + 557.3);
    fill_rrect(s, cb, 4.0, C_FIELD);
    stroke_rrect(s, cb, 4.0, C_LINE_2, 1.0);
    if sel.clip {
        fill_rrect(s, cb.inflate(-3.0, -3.0), 2.0, C_TEXT);
    }
    app.fonts.text(
        s,
        cb.x1 + 8.0,
        y0 + 541.0,
        "Clip content",
        T11,
        C_MUTED,
        Wt::Reg,
    );
    hit.push((
        Rect::new(x0, y0 + 537.0, x0 + 110.0, y0 + 561.0),
        Action::ClipContent,
    ));

    hline(s, rx, rx + rw, y0 + 569.5, C_LINE);

    // ---- appearance -----------------------------------------------------
    app.fonts
        .text_tracked(s, x0, y0 + 582.5, "Appearance", T10, 0.08, C_TEXT, Wt::Med);
    let appearance_eye = Rect::new(xr - 22.0, y0 + 576.0, xr, y0 + 596.0);
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
        y0 + 582.0,
        14.0,
        C_DIM,
    );
    hit.push((appearance_eye, Action::ToggleVisible));
    let opr = Rect::new(x0, y0 + 605.5, x0 + 153.5, y0 + 633.5);
    input(
        app,
        s,
        hit,
        opr,
        Some(("Opacity", T9)),
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
        y0 + 611.25,
        &op_val,
        T11,
        C_TEXT,
        Wt::Reg,
    );
    let rdr = Rect::new(x0 + 161.5, y0 + 605.5, x0 + 315.0, y0 + 633.5);
    input(
        app,
        s,
        hit,
        rdr,
        Some(("Radius", T9)),
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
        y0 + 611.25,
        &rd_val,
        T11,
        C_TEXT,
        Wt::Reg,
    );

    hline(s, rx, rx + rw, y0 + 645.5, C_LINE);

    // ---- typography -----------------------------------------------------
    app.fonts
        .text_tracked(s, x0, y0 + 658.5, "Typography", T10, 0.08, C_TEXT, Wt::Med);
    draw_icon(
        s,
        "grid-2x2",
        xr - 14.0 - 8.0 - 12.0,
        y0 + 659.0,
        12.0,
        C_DIM,
    );
    draw_icon(s, "plus", xr - 14.0, y0 + 658.0, 14.0, C_DIM);
    let fam = Rect::new(x0, y0 + 681.5, x0 + 315.0, y0 + 709.5);
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
    let wgt = Rect::new(x0, y0 + 717.5, x0 + 227.0, y0 + 745.5);
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
    let szr = Rect::new(x0 + 235.0, y0 + 717.5, x0 + 315.0, y0 + 745.5);
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
        .text(s, x0, y0 + 753.5, "Line height", T9, C_DIM, Wt::Reg);
    app.fonts.text(
        s,
        x0 + 161.5,
        y0 + 753.5,
        "Letter spacing",
        T9,
        C_DIM,
        Wt::Reg,
    );
    let lhr = Rect::new(x0, y0 + 771.0, x0 + 153.5, y0 + 799.0);
    input_box(app, s, lhr, R_INPUT);
    draw_icon(s, "type", lhr.x0 + 8.0, lhr.y0 + 8.0, 12.0, C_DIM);
    // line-height mode affordance (Auto / px / %) — same chevron language
    // as the family / weight rows
    let lh_chev = Rect::new(lhr.x1 - 20.0, lhr.y0, lhr.x1, lhr.y1);
    draw_icon(
        s,
        "chevron-down",
        lh_chev.x0 + 4.0,
        lhr.y0 + 9.0,
        12.0,
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
    let lsr = Rect::new(x0 + 161.5, y0 + 771.0, x0 + 315.0, y0 + 799.0);
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
    // row: Word spacing | Para spacing (market-standard typography set)
    app.fonts
        .text(s, x0, y0 + 807.0, "Word spacing", T9, C_DIM, Wt::Reg);
    app.fonts.text(
        s,
        x0 + 161.5,
        y0 + 807.0,
        "Para spacing",
        T9,
        C_DIM,
        Wt::Reg,
    );
    let wsr = Rect::new(x0, y0 + 824.5, x0 + 153.5, y0 + 852.5);
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
    let psr = Rect::new(x0 + 161.5, y0 + 824.5, x0 + 315.0, y0 + 852.5);
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
    // row: Baseline shift | Text case
    app.fonts
        .text(s, x0, y0 + 861.5, "Baseline shift", T9, C_DIM, Wt::Reg);
    app.fonts
        .text(s, x0 + 161.5, y0 + 861.5, "Text case", T9, C_DIM, Wt::Reg);
    let bsr = Rect::new(x0, y0 + 879.0, x0 + 153.5, y0 + 907.0);
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
    let tcr = Rect::new(x0 + 161.5, y0 + 879.0, x0 + 315.0, y0 + 907.0);
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

    // row: Optical size | Width (variable-font axes; Auto on static faces)
    app.fonts
        .text(s, x0, y0 + 916.5, "Optical size", T9, C_DIM, Wt::Reg);
    app.fonts
        .text(s, x0 + 161.5, y0 + 916.5, "Width", T9, C_DIM, Wt::Reg);
    let osr = Rect::new(x0, y0 + 934.0, x0 + 153.5, y0 + 962.0);
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
    let wdr = Rect::new(x0 + 161.5, y0 + 934.0, x0 + 315.0, y0 + 962.0);
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

    app.fonts
        .text(s, x0, y0 + 970.5, "Alignment", T9, C_DIM, Wt::Reg);
    // 6 alignment buttons + sliders
    let al_icons = [
        Some("align-left"),
        Some("align-center"),
        Some("align-right"),
        None, // "T" text
        Some("plus"),
        Some("arrow-down"),
    ];
    for (i, ic) in al_icons.into_iter().enumerate() {
        let bx = x0 + 47.7 * i as f64;
        let br = Rect::new(bx, y0 + 988.0, bx + 43.8, y0 + 1016.0);
        let active = i == 0;
        if active {
            fill_rrect(s, br, 6.0, C_FIELD_2);
            stroke_rrect(s, br, 6.0, C_LINE_2, 1.0);
        } else {
            input_box(app, s, br, 6.0);
        }
        match ic {
            Some(ic) => draw_icon(
                s,
                ic,
                br.x0 + (43.8 - 14.0) / 2.0,
                br.y0 + 7.0,
                14.0,
                if active { C_TEXT } else { C_DIM },
            ),
            None => app.fonts.text_center(s, br, "T", T10, C_DIM, Wt::Reg, true),
        }
    }
    let slb = Rect::new(x0 + 287.0, y0 + 824.5, x0 + 315.0, y0 + 852.5);
    input_box(app, s, slb, 6.0);
    draw_icon(
        s,
        "sliders-horizontal",
        slb.x0 + 7.0,
        slb.y0 + 7.0,
        14.0,
        C_DIM,
    );

    // ---- fill / stroke / effects / guides continue with the shared tail
    hline(s, rx, rx + rw, y0 + 1028.5, C_LINE);
    let mut y = y0 + 1029.5 + 12.0;
    let inner_w = rw - pl * 2.0;

    // --- Fill ----------------------------------------------------------
    section_header(app, s, hit, rx, rw, pl, y, "Fill", true, Action::AddFill);
    y += 14.0 + 8.0;
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
    y += 12.0 + 4.0;
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
    y += 14.0 + 8.0;
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
        .text(s, rx + pl, y, "Position", T9, C_DIM, Wt::Reg);
    app.fonts
        .text(s, rx + pl + half3 + gap, y, "Weight", T9, C_DIM, Wt::Reg);
    y += 12.0 + 4.0;
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
        10.0,
        C_DIM,
    );
    draw_icon(
        s,
        "chevron-down",
        wtr.x1 - 8.0 - 10.0,
        wtr.y0 + 16.0,
        10.0,
        C_DIM,
    );
    y += h + 12.0 + 4.0;
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 6.0;

    // --- Effects -------------------------------------------------------
    let eff_h = 40.0;
    app.fonts
        .text_tracked(s, rx + pl, y + 10.0, "Effects", T10, 0.08, C_TEXT, Wt::Med);
    draw_icon(s, "plus", rx + rw - pl - 14.0, y + 9.0, 14.0, C_DIM);
    hit.push((
        Rect::new(rx + rw - pl - 18.0, y, rx + rw - pl, y + 32.0),
        Action::AddEffect,
    ));
    y += eff_h;
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 12.0;

    // --- GUIDES --------------------------------------------------------
    draw_icon(s, "chevron-down", rx + pl, y + 1.0, 12.0, C_DIM);
    app.fonts.text_tracked(
        s,
        rx + pl + 12.0 + 6.0,
        y,
        "GUIDES",
        T10,
        0.08,
        C_TEXT,
        Wt::Med,
    );
    draw_icon(s, "plus", rx + rw - pl - 14.0, y - 1.0, 14.0, C_DIM);
    hit.push((
        Rect::new(rx + rw - pl - 18.0, y - 4.0, rx + rw - pl, y + 16.0),
        Action::AddGuide,
    ));
    y += 14.0 + 8.0;
    let mvb = Rect::new(rx + pl, y, rx + pl + 24.0, y + 28.0);
    input_box(app, s, mvb, 6.0);
    draw_icon(s, "more-vertical", mvb.x0 + 6.0, mvb.y0 + 6.0, 12.0, C_DIM);
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
    sq_btn_small(
        app,
        s,
        guide_eye.x0,
        guide_eye.y0,
        if app.doc().guides_visible {
            "eye"
        } else {
            "eye-off"
        },
    );
    hit.push((guide_eye, Action::ToggleGuideVisibility));
    let rm = Rect::new(
        kd.x1 + 6.0 + 48.0 + 6.0 + 24.0 + 6.0,
        y + 2.0,
        kd.x1 + 6.0 + 48.0 + 6.0 + 24.0 + 6.0 + 24.0,
        y + 26.0,
    );
    if hover(app, rm) {
        fill_rrect(s, rm, 6.0, C_FIELD_2);
    }
    draw_icon(s, "minus", rm.x0 + 5.0, rm.y0 + 5.0, 14.0, C_DIM);
    hit.push((rm, Action::RemoveGuide));
    y += 28.0 + 12.0 + 4.0;
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 12.0;

    // --- Export ---------------------------------------------------------
    let fmts = ["PNG", "JPG", "SVG", "PDF"];
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
    fill_rrect(s, ex, 6.0, if hov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, ex, 6.0, C_LINE_2, 1.0);
    let label_w = app.fonts.measure("EXPORT 1 ELEMENT", T9, Wt::Med) + 16.0 * T9 * 0.08;
    app.fonts.text_tracked(
        s,
        rx + (rw - label_w) / 2.0,
        y + 8.0,
        "EXPORT 1 ELEMENT",
        T9,
        0.08,
        C_MUTED,
        Wt::Med,
    );
    hit.push((ex, Action::ExportRun));
    y += 28.0 + 24.0;

    // --- COMPONENT (properties) -----------------------------------------
    // Masters define designer-facing properties (bound to the selected
    // descendant); instances edit them as typed overrides (A2).
    hline(s, rx, rx + rw, y, C_LINE);
    y += 1.0 + 12.0;
    app.fonts
        .text_tracked(s, x0, y, "COMPONENT", T10, 0.08, C_TEXT, Wt::Med);
    y += 12.0 + 10.0;
    let (master, inst) = (app.selected_master_name(), app.selected_instance());
    if let Some((iid, comp)) = inst {
        // variant switcher for set members (Figma's instance VARIANT row)
        let siblings = app.doc().editor_ref().variant_siblings(&comp);
        if !siblings.is_empty() {
            let cur_variant = comp.rsplit('/').next().unwrap_or(&comp).to_string();
            let set = comp.split('/').next().unwrap_or(&comp).to_string();
            app.fonts
                .text(s, x0, y + 6.0, "Variant", T9, C_DIM, Wt::Reg);
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
            draw_icon(s, "chevron-down", vb.x1 - 18.0, y + 4.0, 12.0, C_DIM);
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
                    fill_rrect(s, cb, 4.0, C_FIELD);
                    stroke_rrect(s, cb, 4.0, C_LINE_2, 1.0);
                    if on {
                        fill_rrect(s, cb.inflate(-3.0, -3.0), 2.0, C_TEXT);
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
                    app.fonts.text(s, x0, y + 6.0, &e.name, T9, C_DIM, Wt::Reg);
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
                    app.fonts.text(s, x0, y + 6.0, &e.name, T9, C_DIM, Wt::Reg);
                    let br = Rect::new(x0 + 120.0, y - 4.0, xr, y + 20.0);
                    input_box(app, s, br, 6.0);
                    app.fonts
                        .text(s, br.x0 + 8.0, y + 2.4, &value, T11, C_TEXT, Wt::Reg);
                    draw_icon(s, "chevron-down", br.x1 - 18.0, y + 4.0, 12.0, C_DIM);
                    hit.push((br, Action::CycleInstanceSwap(e.name.clone())));
                    y += 28.0;
                }
            }
        }
        if !entries.is_empty() {
            let rr = Rect::new(x0, y, x0 + 96.0, y + 22.0);
            let hov = hover(app, rr);
            fill_rrect(s, rr, 6.0, if hov { C_FIELD_2 } else { C_FIELD });
            stroke_rrect(s, rr, 6.0, C_LINE, 1.0);
            app.fonts
                .text_center(s, rr, "Reset overrides", T9, C_TEXT, Wt::Reg, true);
            hit.push((rr, Action::ResetInstanceProps));
            y += 30.0;
        }
    } else if let Some(master) = master {
        // master side: bind the selected descendant as a new property
        app.fonts.text(s, x0, y, &master, T9, C_DIM, Wt::Reg);
        y += 20.0;
        // variant-set affordance for multi-master selections
        {
            let cb = Rect::new(x0, y, xr, y + 22.0);
            let hov = hover(app, cb);
            fill_rrect(s, cb, 6.0, if hov { C_FIELD_2 } else { C_FIELD });
            stroke_rrect(s, cb, 6.0, C_LINE, 1.0);
            app.fonts.text_center(
                s,
                cb,
                "◆ Combine selected into variant set",
                T9,
                C_TEXT,
                Wt::Reg,
                true,
            );
            hit.push((cb, Action::VariantCombine));
            y += 28.0;
        }
        for (kind, label) in [
            (x_native::ComponentPropKind::Text, "+ Text property"),
            (x_native::ComponentPropKind::Bool, "+ Bool property"),
            (x_native::ComponentPropKind::Swap, "+ Swap property"),
        ] {
            let br = Rect::new(x0, y, xr, y + 24.0);
            let hov = hover(app, br);
            fill_rrect(s, br, 6.0, if hov { C_FIELD_2 } else { C_FIELD });
            stroke_rrect(s, br, 6.0, C_LINE, 1.0);
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
            draw_icon(s, "x", xb.x0 + 4.0, y + 2.0, 12.0, C_DIM);
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
        fill_rrect(s, r, 6.0, C_FIELD_2);
    }
    draw_icon(s, icon, x + 5.0, y + 5.0, 14.0, C_DIM);
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
    app.fonts
        .text_tracked(s, rx + pl, y, title, T10, 0.08, C_TEXT, Wt::Med);
    if with_grid {
        draw_icon(
            s,
            "grid-2x2",
            rx + rw - pl - 14.0 - 8.0 - 12.0,
            y,
            12.0,
            C_DIM,
        );
    }
    draw_icon(s, "plus", rx + rw - pl - 14.0, y - 1.0, 14.0, C_DIM);
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
            node.stroke_layers.first().map(|l| l.visible).unwrap_or(true)
        }
    } else if is_fill {
        true
    } else {
        node.stroke.width > 0.0
    }
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
    let hex_w = inner_w - 64.0 - 24.0 - 24.0 - 8.0 * 3.0;
    let r = Rect::new(rx + pl, y, rx + pl + hex_w, y + h);
    let hov = hover(app, r);
    fill_rrect(s, r, 6.0, if hov { C_INPUT_HOVER } else { C_FIELD });
    stroke_rrect(s, r, 6.0, C_LINE, 1.0);
    let sw = Rect::new(r.x0 + 8.0, y + 7.0, r.x0 + 22.0, y + 21.0);
    let color = parse_hex(hex).unwrap_or(vello::peniko::Color::from_rgb8(255, 255, 255));
    fill_rrect(s, sw, 3.0, color);
    if !is_fill {
        stroke_rrect(s, sw, 3.0, C_LINE_2, 1.0);
    }
    if hover(app, sw) {
        stroke_rrect(s, sw.inflate(1.5, 1.5), 4.0, C_ACCENT, 1.5);
    }
    let shown = field_val(app, hex_field, hex.to_string());
    app.fonts
        .text(s, sw.x1 + 8.0, y + 8.0, &shown, T11, C_TEXT, Wt::Mono);
    // Register the broad text field first so the later, smaller swatch hit
    // wins during reverse hit-testing.
    hit.push((r, Action::Field(hex_field)));
    hit.push((sw, Action::ToggleColorPicker(is_fill)));
    let ar = Rect::new(r.x1 + 8.0, y, r.x1 + 8.0 + 64.0, y + h);
    input(
        app,
        s,
        hit,
        ar,
        Some(("%", T9)),
        &field_val(app, alpha_field, "100".into()),
        false,
        Some(Action::Field(alpha_field)),
        Some("chevron-down"),
    );
    let e1 = Rect::new(ar.x1 + 8.0, y + 2.0, ar.x1 + 8.0 + 24.0, y + 2.0 + 24.0);
    let paint_visible = paint_layer_visible(app, is_fill);
    if hover(app, e1) || !paint_visible {
        fill_rrect(s, e1, 6.0, C_FIELD_2);
    }
    draw_icon(
        s,
        if paint_visible { "eye" } else { "eye-off" },
        e1.x0 + 5.0,
        e1.y0 + 5.0,
        14.0,
        if paint_visible { C_DIM } else { C_TEXT },
    );
    hit.push((e1, Action::TogglePaintVisibility(is_fill)));
    let e2 = Rect::new(e1.x1 + 8.0, y + 2.0, e1.x1 + 8.0 + 24.0, y + 2.0 + 24.0);
    if hover(app, e2) {
        fill_rrect(s, e2, 6.0, C_FIELD);
    }
    draw_icon(s, "minus", e2.x0 + 6.0, e2.y0 + 6.0, 12.0, C_DIM);
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

fn paint_frame_dropdown(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let reg = app.editor_regions();
    let pl = 12.0;
    let inner_w = reg.right.x1 - reg.right.x0 - pl * 2.0;
    let fd_w = inner_w - 90.0 - SQ_BTN - SQ_BTN - 8.0 * 3.0;
    let dx = reg.right.x0 + pl;
    let dy = ED_TITLE_H + 8.0 + 24.0 + 10.0 + PILL_H + 10.0 + 1.0 + 12.0 + 32.0;
    let dd = Rect::new(dx, dy, dx + fd_w, dy + 5.0 * 32.0);
    drop_shadow(s, dd, 8.0);
    fill_rrect(s, dd, 8.0, C_FIELD);
    stroke_rrect(s, dd, 8.0, C_LINE_2, 1.0);
    for (i, (name, w, h)) in FRAME_PRESETS.into_iter().enumerate() {
        let r = Rect::new(
            dx,
            dy + 32.0 * i as f64,
            dx + fd_w,
            dy + 32.0 * (i + 1) as f64,
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
    let y0 = crate::theme::ED_TITLE_H;
    // the typography rows scroll with the panel
    let fy = y0 + 771.0 - app.doc().scroll_right;
    let dd = Rect::new(x0, fy + 28.0, x0 + 153.5, fy + 28.0 + 3.0 * 32.0);
    drop_shadow(s, dd, 8.0);
    fill_rrect(s, dd, 8.0, C_FIELD);
    stroke_rrect(s, dd, 8.0, C_LINE_2, 1.0);
    let mode = app.selected_text_typo().map(|t| t.lh_mode).unwrap_or(0);
    for (i, name) in ["Auto", "Pixels", "Percent"].into_iter().enumerate() {
        let r = Rect::new(
            dd.x0,
            dd.y0 + 32.0 * i as f64,
            dd.x1,
            dd.y0 + 32.0 * (i + 1) as f64,
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
        // Design tools for artboard-based work
        &[
            Tool::Select,
            Tool::Frame,
            Tool::Text,
            Tool::Rect,
            Tool::Ellipse,
            Tool::Pen,
            Tool::Hand,
        ]
    };
    // Audited (canvas 280..1100 @900): container 311×40 r12 at bottom-5
    // (y = win_h − 60); icons 32px pitch 36 starting +7; divider mid-gap;
    // palette btn at +272 from container left.
    let bar_w = 311.0;
    let bar_x0 = reg.canvas.x0 + (reg.canvas.x1 - reg.canvas.x0 - bar_w) / 2.0;
    let bar_y0 = app.win_h - TOOLBAR_BOTTOM - TOOLBAR_H;
    let bar = Rect::new(bar_x0, bar_y0, bar_x0 + bar_w, bar_y0 + TOOLBAR_H);
    drop_shadow(s, bar, 12.0);
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
            16.0,
            if active { C_BLACK } else { C_DIM },
        );
        hit.push((r, Action::Tool(*t)));
    }
    // divider between hand (ends +263) and palette (+272)
    let dx = bar.x0 + 267.5;
    fill_rect(
        s,
        Rect::new(dx, bar.y0 + 10.0, dx + 1.0, bar.y1 - 10.0),
        C_LINE_2,
    );
    // search → palette
    let sx = bar.x0 + 272.0;
    let sr = Rect::new(sx, bar.y0 + 4.0, sx + TOOL_ICON, bar.y0 + 4.0 + TOOL_ICON);
    if hover(app, sr) {
        fill_rrect(s, sr, R_TOOL_ICON, C_FIELD_2);
    }
    draw_icon(s, "search", sr.x0 + 8.0, sr.y0 + 8.0, 16.0, C_DIM);
    hit.push((sr, Action::PaletteToggle));
}

// ------------------------------------------------------- canvas overlays

fn paint_canvas_overlays(app: &mut App, s: &mut Scene) {
    let doc = match app.doc_opt() {
        Some(d) => d,
        None => return,
    };

    // Render board-specific elements (grid, nodes)
    if app.is_board() {
        paint_board_grid(app, s);
        paint_board_nodes(app, s);
    }

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
                fill_rrect(s, br, 3.0, C_SEL);
                app.fonts
                    .text(s, br.x0 + 6.0, by + 0.5, &label, 10.0, C_TEXT, Wt::Mono);
            }
        }
    }

    for id in &sel {
        // text editing = caret mode: no box, no handles for that node
        if app.text_edit.as_deref() == Some(id.as_str()) {
            continue;
        }
        if let Some(n) = find_node(&doc.editor_ref().root, id) {
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
    // marquee
    if let Some(crate::state::Drag::Marquee { start, cur }) = &app.drag {
        let r = Rect::new(
            start.x.min(cur.x),
            start.y.min(cur.y),
            start.x.max(cur.x),
            start.y.max(cur.y),
        );
        fill_rect(s, r, C_SEL_SOFT);
        stroke_rect(s, r, C_SEL, 1.0);
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
                let w = app.fonts.measure(&f.buffer, 11.0, Wt::Mono);
                let x = match id {
                    FieldId::DocName => r.x0 + 10.0 + w,
                    // component property input: unlabeled, text at +8
                    FieldId::InstanceProp => r.x0 + 8.0 + w,
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
    let (_, anchor, open) = app.color_picker_popup.as_ref()?.clone();
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
    let y = anchor
        .y0
        .clamp(ED_TITLE_H + 4.0, (app.win_h - h - 8.0).max(ED_TITLE_H + 4.0));
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
    drop_shadow(s, panel, 14.0);
    fill_rrect(s, panel, 10.0, C_FIELD);
    stroke_rrect(s, panel, 10.0, C_LINE_2, 1.0);

    app.fonts.text(
        s,
        panel.x0 + 14.0,
        panel.y0 + 14.0,
        if is_fill { "Fill color" } else { "Stroke color" },
        T11,
        C_TEXT,
        Wt::Med,
    );
    let close = Rect::new(panel.x1 - 30.0, panel.y0 + 7.0, panel.x1 - 7.0, panel.y0 + 29.0);
    if hover(app, close) {
        fill_rrect(s, close, 5.0, C_FIELD_2);
    }
    draw_icon(s, "x", close.x0 + 5.0, close.y0 + 5.0, 13.0, C_DIM);
    hit.push((close, Action::CloseColorPicker));

    let preview = Rect::new(panel.x0 + 14.0, panel.y0 + 38.0, panel.x1 - 14.0, panel.y0 + 72.0);
    fill_rrect(s, preview, 6.0, current.clone());
    stroke_rrect(s, preview, 6.0, C_LINE_2, 1.0);
    app.fonts.text(
        s,
        panel.x0 + 14.0,
        panel.y0 + 87.0,
        &format!("#{}", crate::state::color_hex(current.clone())),
        T10,
        C_TEXT,
        Wt::Mono,
    );
    app.fonts.text(
        s,
        panel.x0 + 14.0,
        panel.y0 + 104.0,
        "Choose a preset or edit the hex field",
        T9,
        C_DIM,
        Wt::Reg,
    );

    const PRESETS: [&str; 16] = [
        "FFFFFF", "F2F3F7", "D9DCE5", "9A9EAA", "6B6E7A", "343842", "1B1D23", "000000",
        "FF3B30", "FF9500", "FFCC00", "34C759", "00A3FF", "5856D6", "AF52DE", "FF2D55",
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
        fill_rrect(s, r, 5.0, color.clone());
        if color == current {
            stroke_rrect(s, r.inflate(1.5, 1.5), 6.0, C_TEXT, 1.5);
        } else {
            stroke_rrect(s, r, 5.0, C_LINE, 1.0);
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
            label: "Theme: High Contrast",
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
            label: "Frame tool",
            shortcut: "F",
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
    drop_shadow(s, panel, 16.0);
    fill_rrect(s, panel, 10.0, C_FIELD);
    stroke_rrect(s, panel, 10.0, C_LINE_2, 1.0);

    // query row
    draw_icon(s, "search", x + 16.0, y + 15.0, 16.0, C_DIM);
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
        .text_tracked(s, x + 18.0, y + 56.0, "COMMANDS", T9, 0.12, C_DIM, Wt::Med);
    for (row, &ci) in cmds.iter().take(shown).enumerate() {
        let ry = y + 72.0 + 31.0 * row as f64;
        let r = Rect::new(x + 10.0, ry, x + pw - 10.0, ry + 28.0);
        let active = row == app.palette.selected_index.min(shown - 1);
        if active {
            fill_rrect(s, r, 6.0, C_FIELD_2);
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
        let sw = app.fonts.measure(all[ci].shortcut, T9, Wt::Reg);
        app.fonts.text(
            s,
            x + pw - 22.0 - sw,
            ry + 9.0,
            all[ci].shortcut,
            T9,
            C_DIM,
            Wt::Reg,
        );
        hit.push((r, Action::PaletteRun(ci)));
    }
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
    for c in &comments {
        let Some(pin) = app.comment_pin_rect(&c.id) else {
            continue;
        };
        let open = app.open_comment.as_deref() == Some(c.id.as_str());
        let hov = hover(app, pin);
        // avatar: 24px circle, author initial; resolved = gray + check
        let center = (pin.x0 + 12.0, pin.y0 + 12.0);
        let fill = if c.resolved {
            vello::peniko::Color::from_rgb8(0x6B, 0x72, 0x80)
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
            draw_icon(s, "check", pin.x0 + 5.0, pin.y0 + 5.0, 14.0, C_TEXT);
        } else {
            let initial = c.author.chars().next().unwrap_or('?');
            app.fonts
                .text_center(s, pin, &initial.to_string(), T11, C_TEXT, Wt::Med, false);
        }
        // collapsed preview bubble on hover (not while its thread is open)
        if hov && !open {
            let w = (app.fonts.measure(&c.text, T10, Wt::Reg) + 24.0).min(240.0);
            let b = Rect::new(pin.x1 + 6.0, pin.y0 + 1.0, pin.x1 + 6.0 + w, pin.y1 - 1.0);
            drop_shadow(s, b, 8.0);
            fill_rrect(s, b, 12.0, C_FIELD);
            stroke_rrect(s, b, 12.0, C_LINE_2, 1.0);
            app.fonts
                .text(s, b.x0 + 12.0, b.y0 + 9.0, &c.text, T10, C_TEXT, Wt::Reg);
        }
        // open thread popover
        if open {
            let card = Rect::new(pin.x1 + 8.0, pin.y0 - 4.0, pin.x1 + 248.0, pin.y0 + 76.0);
            drop_shadow(s, card, 12.0);
            fill_rrect(s, card, 12.0, C_FIELD);
            stroke_rrect(s, card, 12.0, C_LINE_2, 1.0);
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
            fill_rrect(s, pill, 6.0, if hov_r { C_FIELD_2 } else { C_PANEL });
            stroke_rrect(s, pill, 6.0, C_LINE_2, 1.0);
            let label = if c.resolved { "Re-open" } else { "Resolve" };
            app.fonts.text_center(
                s,
                pill,
                label,
                T10,
                if c.resolved { C_MUTED } else { C_SEL },
                Wt::Med,
                true,
            );
            draw_icon(s, "trash-2", card.x0 + 126.0, card.y0 + 51.0, 14.0, C_DIM);
        }
    }
    // the composer (new comment)
    if let Some(d) = app.comment_draft.clone() {
        let sp = app.world_to_screen(vello::kurbo::Point::new(d.x, d.y));
        let card = Rect::new(sp.x, sp.y, sp.x + 240.0, sp.y + 64.0);
        drop_shadow(s, card, 12.0);
        fill_rrect(s, card, 12.0, C_FIELD);
        stroke_rrect(s, card, 12.0, C_SEL, 1.0);
        app.fonts.text(
            s,
            card.x0 + 28.0,
            card.y0 + 10.0,
            crate::state::USER_NAME,
            T9,
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
        fill_rrect(s, post, 6.0, if hov_p { C_SEL } else { C_PANEL });
        stroke_rrect(s, post, 6.0, C_SEL, 1.0);
        app.fonts
            .text_center(s, post, "Post", T10, C_SEL, Wt::Med, true);
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

// ------------------------------------------------------------ dev mode
// (C21): the INSPECT tab — platform picker + generated code for the
// selection, over the devmode generators (CSS/SwiftUI/Compose/XML).

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
        T9,
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

        fill_rrect(s, card_r, 8.0, if hov { C_FIELD_2 } else { C_FIELD });
        stroke_rrect(s, card_r, 8.0, if hov { C_LINE_2 } else { C_LINE }, 1.0);

        // Title
        app.fonts
            .text(s, x0 + 24.0, y + 14.0, title, T10, C_TEXT, Wt::Med);

        // Description
        app.fonts
            .text(s, x0 + 24.0, y + 34.0, desc, T9, C_DIM, Wt::Reg);

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
            T9,
            C_DIM,
            Wt::Reg,
        );
        y += 32.0;

        // Analyze selected nodes
        for node_id in &sel {
            if let Some(node) = find_node(&root, node_id) {
                let node_r = Rect::new(x0 + 16.0, y, xr - 16.0, y + 40.0);
                fill_rrect(s, node_r, 6.0, C_BG);

                let name = node.name.clone();
                app.fonts
                    .text(s, x0 + 24.0, y + 12.0, &name, T9, C_TEXT, Wt::Reg);

                // Quick metrics
                match &node.kind {
                    NodeKind::Text { .. } => {
                        app.fonts.text(
                            s,
                            x0 + 24.0,
                            y + 26.0,
                            "\u{2713} Text layer",
                            T9,
                            Color::from_rgb8(0x4C, 0xBB, 0x7A),
                            Wt::Reg,
                        );
                    }
                    NodeKind::Frame { .. } => {
                        app.fonts.text(
                            s,
                            x0 + 24.0,
                            y + 26.0,
                            "\u{2713} Container",
                            T9,
                            Color::from_rgb8(0x4C, 0xBB, 0x7A),
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
        fill_rrect(s, empty_r, 8.0, C_BG);
        stroke_rrect(s, empty_r, 8.0, C_LINE, 1.0);

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
    // platform segmented control (Figma dev mode's language picker)
    const NAMES: [&str; 4] = App::INSPECT_PLATFORMS;
    let w = xr - x0;
    let seg_w = (w - 3.0 * 4.0) / 4.0;
    for (i, name) in NAMES.iter().enumerate() {
        let bx = x0 + (seg_w + 4.0) * i as f64;
        let r = Rect::new(bx, y, bx + seg_w, y + 24.0);
        let active = app.inspect_platform == i;
        let hov = hover(app, r);
        fill_rrect(
            s,
            r,
            6.0,
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
        stroke_rrect(s, r, 6.0, if active { C_LINE_2 } else { C_LINE }, 1.0);
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
    fill_rrect(s, panel, 8.0, C_PANEL);
    stroke_rrect(s, panel, 8.0, C_LINE, 1.0);
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
                T9,
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
    fill_rrect(s, cb, 6.0, if hov && enabled { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, cb, 6.0, C_LINE, 1.0);
    draw_icon(
        s,
        "copy",
        cb.x0 + 8.0,
        cb.y0 + 5.0,
        13.0,
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

fn fill_circle(s: &mut Scene, center: Point, radius: f64, color: Color) {
    let circle = vello::kurbo::Circle::new((center.x, center.y), radius);
    s.fill(Fill::NonZero, Affine::IDENTITY, color, None, &circle);
}

// ------------------------------------------------------- Board rendering

fn paint_board_grid(app: &App, s: &mut Scene) {
    // Dot grid for infinite canvas - Figma FigJam style
    let spacing = 20.0; // Grid spacing in screen pixels
    let dot_radius = 1.0;

    let reg = app.editor_regions();
    let canvas = reg.canvas;

    // Clip to the canvas region
    s.push_layer(
        Fill::NonZero,
        vello::peniko::BlendMode::new(vello::peniko::Mix::Normal, vello::peniko::Compose::SrcOver),
        1.0,
        Affine::IDENTITY,
        &canvas,
    );

    // Draw dots in a grid pattern
    let mut x = canvas.x0;
    while x < canvas.x1 {
        let mut y = canvas.y0;
        while y < canvas.y1 {
            // Only draw dots at major grid intersections
            if ((x - canvas.x0) % (spacing * 5.0)).abs() < 0.1
                && ((y - canvas.y0) % (spacing * 5.0)).abs() < 0.1
            {
                // Major dot (every 5th intersection)
                fill_circle(s, Point::new(x, y), dot_radius * 1.5, C_GRID);
            } else {
                // Regular dot
                fill_circle(s, Point::new(x, y), dot_radius, C_GRID_LIGHT);
            }
            y += spacing;
        }
        x += spacing;
    }

    s.pop_layer();
}

fn paint_board_nodes(app: &App, s: &mut Scene) {
    let doc = match app.doc_opt() {
        Some(d) => d,
        None => return,
    };

    // Get board document and render nodes
    // This is a placeholder - full implementation requires board state access
    // For now, we render basic shapes from the design doc structure
    // Board-specific rendering will be implemented when board state is fully integrated

    let editor = doc.editor_ref();

    // Render all nodes with board-specific styling
    for node_id in &editor.selection {
        if let Some(node) = find_node(&editor.root, node_id) {
            let p0 = app.world_to_screen(Point::new(node.transform.x, node.transform.y));
            let p1 = app.world_to_screen(Point::new(
                node.transform.x + node.w,
                node.transform.y + node.h,
            ));
            let r = Rect::new(p0.x, p0.y, p1.x, p1.y);

            // Selection highlight for board nodes
            stroke_rect(s, r, C_SEL, 2.0);
        }
    }
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
        T::OnHover | T::MouseEnter => "While hovering",
        T::MouseLeave => "When leaving",
        T::OnPress => "On press",
        T::OnDrag => "On drag",
        T::AfterDelay { .. } => "After delay",
        T::KeyDown { .. } => "Key pressed",
    }
}

pub(crate) fn proto_action_label(a: &x_native::Action, targets: &[(String, String)]) -> String {
    // x_core's prototype Action; the app's own Action is `crate::state::Action`
    use x_native::Action as A;
    match a {
        A::Navigate { destination } | A::ScrollTo { destination } => format!(
            "→ {}",
            targets
                .iter()
                .find(|(id, _)| id == destination)
                .map(|(_, n)| n.as_str())
                .unwrap_or(destination)
        ),
        A::OpenOverlay { overlay, .. } | A::SwapOverlay { overlay } => {
            format!("⇧ overlay {overlay}")
        }
        A::CloseOverlay => "⇧ close overlay".into(),
        A::Back => "→ Back".into(),
        A::SetVar { name, .. } => format!("set {name}"),
        A::SetMode { mode } => format!("mode → {mode}"),
        A::Cond { .. } => "if/else".into(),
    }
}

pub(crate) fn proto_dest_of(a: &x_native::Action) -> Option<String> {
    match a {
        x_native::Action::Navigate { destination } | x_native::Action::ScrollTo { destination } => {
            Some(destination.clone())
        }
        _ => None,
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
        .text_tracked(s, x0, y, "PROTOTYPE", T10, 0.08, C_TEXT, Wt::Med);
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
        fill_rrect(s, cb, 4.0, C_FIELD);
        stroke_rrect(s, cb, 4.0, C_LINE_2, 1.0);
        if n.is_starting_point {
            fill_rrect(s, cb.inflate(-3.5, -3.5), 2.0, C_TEXT);
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
            .text_tracked(s, x0, y, "INTERACTIONS", T9, 0.10, C_DIM, Wt::Med);
        let ab = Rect::new(xr - 66.0, y - 4.0, xr, y + 14.0);
        input_box(app, s, ab, 6.0);
        app.fonts
            .text_center(s, ab, "+ Add", T9, C_TEXT, Wt::Med, true);
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
        let targets = proto_targets(app);
        for (i, ix) in list.iter().enumerate() {
            let row = Rect::new(x0, y, xr, y + 26.0);
            fill_rrect(s, row, 6.0, C_FIELD);
            // trigger chip (cycles on click)
            let tb = Rect::new(x0 + 5.0, y + 4.0, x0 + 97.0, y + 22.0);
            app.fonts.text(
                s,
                tb.x0 + 5.0,
                y + 7.0,
                proto_trigger_label(&ix.trigger),
                T9,
                C_TEXT,
                Wt::Reg,
            );
            hit.push((tb, Action::ProtoTrigger(i)));
            // action chip: destination cycles / label for other actions
            let db = Rect::new(tb.x1 + 5.0, y + 4.0, xr - 96.0, y + 22.0);
            let dest = proto_dest_of(&ix.action);
            let label = proto_action_label(&ix.action, &targets);
            app.fonts
                .text(s, db.x0 + 5.0, y + 7.0, &label, T9, C_TEXT, Wt::Reg);
            if dest.is_some() {
                draw_icon(s, "chevron-down", db.x1 - 15.0, y + 7.5, 10.0, C_DIM);
                let half = Rect::new(db.x0, db.y0, db.x0 + db.width() / 2.0, db.y1);
                hit.push((half, Action::ProtoDest(i, -1)));
                hit.push((
                    Rect::new(half.x1, db.y0, db.x1, db.y1),
                    Action::ProtoDest(i, 1),
                ));
            }
            // speed chip (0/150/350/700 ms)
            let sb = Rect::new(xr - 86.0, y + 4.0, xr - 40.0, y + 22.0);
            app.fonts.text(
                s,
                sb.x0 + 4.0,
                y + 7.0,
                &format!("{}ms", ix.transition_ms),
                T9,
                C_DIM,
                Wt::Mono,
            );
            hit.push((sb, Action::ProtoSpeed(i)));
            // remove
            let xb = Rect::new(xr - 32.0, y + 4.0, xr - 16.0, y + 22.0);
            app.fonts
                .text(s, xb.x0 + 3.0, y + 6.0, "✕", T10, C_DIM, Wt::Reg);
            hit.push((xb, Action::ProtoRemove(i)));
            y += 32.0;
        }
        // editing affordance for non-navigate actions: replace with click nav
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
    fill_rrect(s, pb, 6.0, if hov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, pb, 6.0, C_LINE_2, 1.0);
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
        T9,
        C_DIM,
        Wt::Reg,
    );
    y += 12.0;
    app.fonts.text(
        s,
        x0,
        y,
        "navigate, Esc steps back, Q exits.",
        T9,
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
    let reg = app.editor_regions();
    let Some((_, wr, name)) = flow_locate(app, &flow.current) else {
        return;
    };
    let a = app.world_to_screen(Point::new(wr.x0, wr.y0));
    let b = app.world_to_screen(Point::new(wr.x1, wr.y1));
    let f = Rect::new(a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y));
    let c = reg.canvas;
    // scrim: dim everything outside the focused frame (clip to canvas region)
    let dim = vello::peniko::Color::from_rgba8(5, 8, 13, 184);
    if f.y0 > c.y0 {
        fill_rect(s, Rect::new(c.x0, c.y0, c.x1, f.y0), dim);
    }
    if f.y1 < c.y1 {
        fill_rect(s, Rect::new(c.x0, f.y1.max(c.y0), c.x1, c.y1), dim);
    }
    let my0 = f.y0.max(c.y0);
    let my1 = f.y1.min(c.y1);
    if f.x0 > c.x0 {
        fill_rect(s, Rect::new(c.x0, my0, f.x0, my1), dim);
    }
    if f.x1 < c.x1 {
        fill_rect(s, Rect::new(f.x1.max(c.x0), my0, c.x1, my1), dim);
    }
    crate::paint::stroke_rrect(s, f, 0.0, C_TEXT, 1.5);

    // chrome chip: frame name + Back + Exit
    let chip_w = 210.0 + app.fonts.measure(&name, T11, Wt::Med);
    let chip = Rect::new(
        (app.win_w - chip_w) / 2.0,
        reg.canvas.y0 + 10.0,
        (app.win_w + chip_w) / 2.0,
        reg.canvas.y0 + 42.0,
    );
    fill_rrect(s, chip, 8.0, C_PANEL);
    crate::paint::stroke_rrect(s, chip, 8.0, C_LINE_2, 1.0);
    app.fonts.text(
        s,
        chip.x0 + 12.0,
        chip.y0 + 12.0,
        &format!("▶ {name}"),
        T11,
        C_TEXT,
        Wt::Med,
    );
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
        6.0,
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
    fill_rrect(s, eb, 6.0, C_FIELD_2);
    app.fonts
        .text_center(s, eb, "Exit (Q)", T10, C_TEXT, Wt::Reg, true);
    hit.push((eb, Action::FlowExit));
}

// ————————————————————————————————————————— assets panel (fonts)

fn paint_assets(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>, y0: f64, lw: f64) {
    let x0 = 12.0;
    let mut y = y0 + 160.5;
    app.fonts
        .text_tracked(s, x0, y, "FONTS", T9, 0.12, C_DIM, Wt::Med);
    y += 18.0;
    let names = app.fonts.fonts.family_names();
    if names.is_empty() {
        app.fonts
            .text(s, x0, y, "No faces registered", T10, C_MUTED, Wt::Reg);
        y += 18.0;
    }
    for nm in names.iter().take(24) {
        app.fonts.text(s, x0 + 4.0, y, nm, T10, C_TEXT, Wt::Reg);
        y += 16.0;
    }
    if names.len() > 24 {
        app.fonts.text(
            s,
            x0 + 4.0,
            y,
            &format!("… {} more", names.len() - 24),
            T9,
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
    app.fonts.text(
        s,
        x0,
        y,
        "TTF / OTF / TTC; text layers can then use it by name",
        T9,
        C_MUTED,
        Wt::Reg,
    );
}

// ————————————————————————————————————————— tokens panel (design audit)

fn paint_tokens(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>, y0: f64, lw: f64) {
    use crate::paint::{fill_rrect, stroke_rrect, Wt};
    let x0 = 12.0;
    let mut y = y0 + 160.5;
    app.fonts
        .text_tracked(s, x0, y, "DESIGN TOKENS", T9, 0.12, C_DIM, Wt::Med);
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
        let sw = Rect::new(x0 + 4.0, y + 1.0, x0 + 16.0, y + 13.0);
        if let Some(c) = x_native::parse_hex_color(hex) {
            fill_rrect(s, sw, 3.0, c);
            stroke_rrect(s, sw, 3.0, C_LINE_2, 1.0);
        }
        app.fonts.text(s, x0 + 24.0, y, hex, T10, C_TEXT, Wt::Mono);
        let cnt = format!("×{count}");
        let cw = app.fonts.measure(&cnt, T9, Wt::Reg);
        app.fonts
            .text(s, lw - 12.0 - cw, y + 1.6, &cnt, T9, C_MUTED, Wt::Reg);
        y += 18.0;
    }
    if !tokens.font_sizes.is_empty() {
        y += 4.0;
        app.fonts
            .text_tracked(s, x0, y, "TYPE SCALE", T9, 0.12, C_DIM, Wt::Med);
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
        app.fonts.text(s, x0 + 4.0, y, &row, T9, C_MUTED, Wt::Mono);
        y += 16.0;
    }
    let vcount = app
        .doc_opt()
        .map(|d| d.doc.variables.catalog().len())
        .unwrap_or(0);
    y += 2.0;
    let br = Rect::new(x0, y, lw - 12.0, y + 26.0);
    let hov = hover(app, br);
    fill_rrect(s, br, 6.0, if hov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, br, 6.0, C_LINE_2, 1.0);
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
    // UI theme cycle. Palettes live in x-ui (design_system.rs); paint.rs maps
    // every chrome color through the active one, so this repaints the tool.
    let tb = Rect::new(x0, y, lw - 12.0, y + 26.0);
    let thov = hover(app, tb);
    fill_rrect(s, tb, 6.0, if thov { C_LINE_2 } else { C_FIELD_2 });
    stroke_rrect(s, tb, 6.0, C_LINE_2, 1.0);
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
        T9,
        C_MUTED,
        Wt::Reg,
    );
}

#[cfg(test)]
mod viewport_row_tests {
    use super::*;
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
}
