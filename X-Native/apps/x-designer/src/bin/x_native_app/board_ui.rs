//! Board UI — dot grid, node painting, overlays and tool rail for the
//! infinite-canvas Board screen. Rendering works against the real `x-board`
//! model: `BoardDocument { pages: Vec<BoardPage> }`, each page owning
//! `nodes: Vec<BoardNode>` and `connectors: Vec<Connector>`.
//!
//! World→screen mapping follows `App::board_canvas_transform()`:
//! `screen = world * z + (ox, oy)`.

use vello::kurbo::{Affine, BezPath, Circle, Rect, RoundedRect, Stroke};
use vello::peniko::{Color, Fill};
use vello::Scene;
use x_board::{AttachmentPoint, BoardDocument, BoardNode, BoardPage, Side};

use crate::icons::draw_icon;
use crate::paint::{fill_rect, fill_rrect, hline, stroke_rrect, Wt};
use crate::state::{Action, App, BoardRegions, DashView, Drag, Tool};
use crate::theme::*;

/// Convert a world point to screen space.
fn w2s(x: f64, y: f64, ox: f64, oy: f64, z: f64) -> (f64, f64) {
    (x * z + ox, y * z + oy)
}

/// `[f32; 4]` model colors (0..=1) → peniko color.
fn f_color(c: &[f32; 4]) -> Color {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Color::from_rgba8(q(c[0]), q(c[1]), q(c[2]), q(c[3]))
}

/// Paint the board chrome: the tool rail for board mode.
pub fn paint(app: &mut App, s: &mut Scene) {
    let mut hit: Vec<(Rect, crate::state::Action)> = Vec::new();
    paint_board_header(app, s, &mut hit);
    paint_board_toolbar(app, s, &mut hit);
    app.hit = hit;
}

/// Board mode has its own lightweight chrome. The old screen only rendered
/// the bottom tool rail, which left users without a visible way back to the
/// dashboard and hid the persisted grid/connector settings.
fn paint_board_header(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let header = Rect::new(0.0, 0.0, app.win_w, ED_TITLE_H);
    fill_rect(s, header, C_PANEL);
    hline(s, 0.0, app.win_w, ED_TITLE_H - 1.0, C_LINE);

    let back = Rect::new(10.0, 6.0, 94.0, 30.0);
    if app.mouse.x >= back.x0
        && app.mouse.x <= back.x1
        && app.mouse.y >= back.y0
        && app.mouse.y <= back.y1
    {
        fill_rrect(s, back, 6.0, C_FIELD_2);
    }
    draw_icon(s, "undo", 18.0, 13.0, 16.0, C_DIM);
    app.fonts.text(s, 40.0, 11.0, "Dashboard", T11, C_TEXT, Wt::Med);
    hit.push((back, Action::DashNav(DashView::Home)));

    let (name, page_label) = {
        let board = app.board_doc();
        (
            board.metadata.name.clone(),
            format!("Page {} · {}", board.active_page_index() + 1, board.current_page().name),
        )
    };
    app.fonts.text(s, 118.0, 11.0, &name, T12, C_TEXT, Wt::Semi);
    app.fonts.text(s, 118.0, 25.0, "Board · infinite canvas", T10, C_DIM, Wt::Reg);

    let page = Rect::new(300.0, 7.0, 408.0, 29.0);
    fill_rrect(s, page, 6.0, C_FIELD);
    stroke_rrect(s, page, 6.0, C_LINE, 1.0);
    app.fonts.text(s, page.x0 + 10.0, page.y0 + 6.0, &page_label, T10, C_TEXT, Wt::Reg);
    draw_icon(s, "chevron-down", page.x1 - 22.0, page.y0 + 7.0, 14.0, C_DIM);
    hit.push((page, Action::BoardNextPage));
    let add_page = Rect::new(414.0, 7.0, 442.0, 29.0);
    fill_rrect(s, add_page, 6.0, C_FIELD);
    stroke_rrect(s, add_page, 6.0, C_LINE, 1.0);
    draw_icon(s, "plus", add_page.x0 + 12.0, add_page.y0 + 7.0, 14.0, C_DIM);
    hit.push((add_page, Action::BoardAddPage));

    let grid_on = app.board_doc().settings.show_grid;
    let grid = Rect::new(app.win_w - 190.0, 7.0, app.win_w - 112.0, 29.0);
    fill_rrect(s, grid, 6.0, if grid_on { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, grid, 6.0, C_LINE, 1.0);
    draw_icon(s, "grid-2x2", grid.x0 + 8.0, grid.y0 + 6.0, 14.0, C_DIM);
    app.fonts.text(s, grid.x0 + 29.0, grid.y0 + 6.0, "Grid", T10, C_TEXT, Wt::Reg);
    hit.push((grid, Action::BoardToggleGrid));

    let connectors_on = app.board_doc().settings.show_connectors;
    let connectors = Rect::new(app.win_w - 104.0, 7.0, app.win_w - 12.0, 29.0);
    fill_rrect(
        s,
        connectors,
        6.0,
        if connectors_on { C_FIELD_2 } else { C_FIELD },
    );
    stroke_rrect(s, connectors, 6.0, C_LINE, 1.0);
    draw_icon(
        s,
        "arrow-left-right",
        connectors.x0 + 8.0,
        connectors.y0 + 6.0,
        14.0,
        C_DIM,
    );
    app.fonts
        .text(s, connectors.x0 + 29.0, connectors.y0 + 6.0, "Links", T10, C_TEXT, Wt::Reg);
    hit.push((connectors, Action::BoardToggleConnectors));
}

/// Dot grid background for the infinite canvas (FigJam style).
pub fn paint_grid(app: &App, s: &mut Scene, reg: &BoardRegions) {
    // The setting is persisted with the board. Do not paint a grid that the
    // user has explicitly hidden; this also keeps the preview and editor in
    // agreement because both call this painter.
    if !app
        .doc_opt()
        .and_then(|doc| doc.board_doc.as_ref())
        .is_some_and(|board| board.settings.show_grid)
    {
        return;
    }
    let (ox, oy, z) = app.board_canvas_transform();
    let spacing_world = app
        .doc_opt()
        .and_then(|doc| doc.board_doc.as_ref())
        .map_or(20.0, |board| board.settings.grid_size.max(1.0) as f64);
    let spacing = (spacing_world * z).max(6.0);

    let dot = |scene: &mut Scene, x: f64, y: f64, r: f64| {
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            C_LINE,
            None,
            &Circle::new((x, y), r),
        );
    };

    // Adaptive dot size: smaller when zoomed out.
    let r = if spacing < 10.0 {
        0.5
    } else if spacing > 40.0 {
        1.8
    } else {
        1.0
    };

    // Screen-space lattice anchored to the pan offset so dots track the canvas.
    let canvas = reg.canvas;
    let mut y = canvas.y0 + oy.rem_euclid(spacing);
    while y < canvas.y1 {
        let mut x = canvas.x0 + ox.rem_euclid(spacing);
        while x < canvas.x1 {
            // major dot every 5th intersection
            let gx = ((x - ox) / spacing).round();
            let gy = ((y - oy) / spacing).round();
            let major = gx.rem_euclid(5.0) == 0.0 && gy.rem_euclid(5.0) == 0.0;
            dot(s, x, y, if major { r * 2.0 } else { r });
            x += spacing;
        }
        y += spacing;
    }
}

/// Draw a hand-rolled dashed segment (kurbo ships stroke dashes only with
/// an optional feature that vello does not enable).
fn dashed_line(s: &mut Scene, a: (f64, f64), b: (f64, f64), col: Color, w: f64, dash: f64) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = (dx * dx + dy * dy).sqrt();
    if len <= 1e-6 {
        return;
    }
    let (ux, uy) = (dx / len, dy / len);
    let mut t = 0.0;
    let mut on = true;
    while t < len {
        let e = (t + dash).min(len);
        if on {
            let mut seg = BezPath::new();
            seg.move_to((a.0 + ux * t, a.1 + uy * t));
            seg.line_to((a.0 + ux * e, a.1 + uy * e));
            s.stroke(&Stroke::new(w), Affine::IDENTITY, col, None, &seg);
        }
        t = e;
        on = !on;
    }
}

/// Paint the active board page's nodes and its connectors.
pub fn paint_nodes(app: &App, s: &mut Scene, board: &BoardDocument, ox: f64, oy: f64, z: f64) {
    let page = board.current_page();
    for node in &page.nodes {
            paint_node(app, s, node, ox, oy, z);
            if page.selection.iter().any(|id| id == node.id()) {
                let b = node.bounding_box();
                if b.width() <= 0.5 || b.height() <= 0.5 {
                    continue;
                }
                let (x0, y0) = w2s(b.x0, b.y0, ox, oy, z);
                let (x1, y1) = w2s(b.x1, b.y1, ox, oy, z);
                let bounds = Rect::new(x0, y0, x1, y1);
                s.stroke(
                    &Stroke::new(2.0),
                    Affine::IDENTITY,
                    C_ACCENT,
                    None,
                    &RoundedRect::from_rect(bounds, 4.0),
                );
                // A small handle makes selection visible even for a very
                // thin pen path or text label, where an outline alone can be
                // hard to spot at low zoom.
                s.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    C_ACCENT,
                    None,
                    &Circle::new((x1, y1), 3.5),
                );
            }
        }
    if board.settings.show_connectors {
        for conn in &page.connectors {
            let (sx, sy) = resolve_attachment(&conn.from, page);
            let (ex, ey) = resolve_attachment(&conn.to, page);
            let (sx, sy) = w2s(sx, sy, ox, oy, z);
            let (ex, ey) = w2s(ex, ey, ox, oy, z);

            let width = (conn.stroke_width as f64 * z).max(1.0);
            let col = f_color(&conn.stroke_color);
            if matches!(conn.connector_type, x_board::ConnectorType::Dashed) {
                dashed_line(s, (sx, sy), (ex, ey), col, width, 4.0 * z.max(2.0));
            } else {
                let mut path = BezPath::new();
                path.move_to((sx, sy));
                path.line_to((ex, ey));
                s.stroke(&Stroke::new(width), Affine::IDENTITY, col, None, &path);
            }

            let angle = (ey - sy).atan2(ex - sx);
            let head = |s: &mut Scene, hx: f64, hy: f64, flip: f64| {
                let a = 8.0 * z;
                let mut arrow = BezPath::new();
                arrow.move_to((hx, hy));
                arrow.line_to((
                    hx - a * (flip - std::f64::consts::FRAC_PI_6).cos(),
                    hy - a * (flip - std::f64::consts::FRAC_PI_6).sin(),
                ));
                arrow.line_to((
                    hx - a * (flip + std::f64::consts::FRAC_PI_6).cos(),
                    hy - a * (flip + std::f64::consts::FRAC_PI_6).sin(),
                ));
                arrow.close_path();
                s.fill(Fill::NonZero, Affine::IDENTITY, col, None, &arrow);
            };
            match conn.connector_type {
                x_board::ConnectorType::Arrow => head(s, ex, ey, angle),
                x_board::ConnectorType::DoubleArrow => {
                    head(s, ex, ey, angle);
                    head(s, sx, sy, angle + std::f64::consts::PI);
                }
                _ => {}
            }
        }
    }
}

fn resolve_attachment(pt: &AttachmentPoint, page: &BoardPage) -> (f64, f64) {
    match pt {
        AttachmentPoint::Free(p) => (p.x as f64, p.y as f64),
        AttachmentPoint::NodeCenter(id) => center_of(page, id).unwrap_or((0.0, 0.0)),
        AttachmentPoint::NodeSide(id, side) => {
            let b = page
                .nodes
                .iter()
                .find(|n| n.id() == id)
                .map(|n| n.bounding_box());
            match b {
                Some(b) => match side {
                    Side::Top => (b.x0 + b.width() / 2.0, b.y0),
                    Side::Right => (b.x1, b.y0 + b.height() / 2.0),
                    Side::Bottom => (b.x0 + b.width() / 2.0, b.y1),
                    Side::Left => (b.x0, b.y0 + b.height() / 2.0),
                },
                None => (0.0, 0.0),
            }
        }
    }
}

fn center_of(page: &BoardPage, id: &str) -> Option<(f64, f64)> {
    page.nodes
        .iter()
        .find(|n| n.id() == id)
        .map(|n| n.bounding_box())
        .map(|b| (b.x0 + b.width() / 2.0, b.y0 + b.height() / 2.0))
}

fn paint_node(app: &App, s: &mut Scene, node: &BoardNode, ox: f64, oy: f64, z: f64) {
    match node {
        BoardNode::Sticky(sticky) => {
            let (x0, y0) = w2s(sticky.transform.x, sticky.transform.y, ox, oy, z);
            let (x1, y1) = w2s(
                sticky.transform.x + sticky.width as f64,
                sticky.transform.y + sticky.height as f64,
                ox,
                oy,
                z,
            );
            let r = Rect::new(x0, y0, x1, y1);
            // soft shadow + body
            s.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgba8(0, 0, 0, 46),
                None,
                &RoundedRect::new(r.x0 + 1.0, r.y0 + 2.0, r.x1 + 1.0, r.y1 + 2.0, 6.0),
            );
            s.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                f_color(&sticky.background_color),
                None,
                &RoundedRect::from_rect(r, 6.0),
            );
            if !sticky.text.is_empty() {
                let size = (sticky.font_size as f64 * z).clamp(6.0, 96.0);
                let text_col = f_color(&sticky.text_color);
                let pad = 10.0 * z;
                let mut ty = r.y0 + pad;
                let max_ty = r.y1 - size;
                for line in sticky.text.lines() {
                    if ty > max_ty {
                        break;
                    }
                    let clipped: String = line.chars().take(64).collect();
                    app.fonts
                        .text(s, r.x0 + pad, ty, &clipped, size, text_col, Wt::Reg);
                    ty += size * 1.4;
                }
            }
        }
        BoardNode::Shape(shape) => {
            let (x0, y0) = w2s(shape.transform.x, shape.transform.y, ox, oy, z);
            let w = shape.width as f64 * z;
            let h = shape.height as f64 * z;
            let r = Rect::new(x0, y0, x0 + w, y0 + h);
            let fill = shape.fill_color.as_ref().map(f_color);
            let stroke_c = shape.stroke_color.as_ref().map(f_color);
            match &shape.shape_type {
                x_board::ShapeType::Rectangle { corner_radius } => {
                    let rad = (*corner_radius as f64 * z).min(w / 2.0).max(0.0);
                    let rr = RoundedRect::new(r.x0, r.y0, r.x1, r.y1, rad);
                    if let Some(c) = fill {
                        s.fill(Fill::NonZero, Affine::IDENTITY, c, None, &rr);
                    }
                    if let Some(c) = stroke_c {
                        s.stroke(
                            &Stroke::new((shape.stroke_width as f64 * z).max(1.0)),
                            Affine::IDENTITY,
                            c,
                            None,
                            &rr,
                        );
                    }
                }
                x_board::ShapeType::Circle => {
                    let c0 = Circle::new((r.x0 + w / 2.0, r.y0 + h / 2.0), (w.min(h)) / 2.0);
                    if let Some(c) = fill {
                        s.fill(Fill::NonZero, Affine::IDENTITY, c, None, &c0);
                    }
                    if let Some(c) = stroke_c {
                        s.stroke(
                            &Stroke::new((shape.stroke_width as f64 * z).max(1.0)),
                            Affine::IDENTITY,
                            c,
                            None,
                            &c0,
                        );
                    }
                }
                x_board::ShapeType::Triangle | x_board::ShapeType::Diamond => {
                    let mut p = BezPath::new();
                    if matches!(shape.shape_type, x_board::ShapeType::Triangle) {
                        p.move_to((r.x0 + w / 2.0, r.y0));
                        p.line_to((r.x1, r.y1));
                        p.line_to((r.x0, r.y1));
                    } else {
                        p.move_to((r.x0 + w / 2.0, r.y0));
                        p.line_to((r.x1, r.y0 + h / 2.0));
                        p.line_to((r.x0 + w / 2.0, r.y1));
                        p.line_to((r.x0, r.y0 + h / 2.0));
                    }
                    p.close_path();
                    if let Some(c) = fill {
                        s.fill(Fill::NonZero, Affine::IDENTITY, c, None, &p);
                    }
                    if let Some(c) = stroke_c {
                        s.stroke(
                            &Stroke::new((shape.stroke_width as f64 * z).max(1.0)),
                            Affine::IDENTITY,
                            c,
                            None,
                            &p,
                        );
                    }
                }
            }
        }
        BoardNode::PenPath(pen) => {
            if pen.points.len() < 2 {
                return;
            }
            let mut path = BezPath::new();
            for (i, p) in pen.points.iter().enumerate() {
                let (sx, sy) = w2s(
                    pen.transform.x + p.x as f64,
                    pen.transform.y + p.y as f64,
                    ox,
                    oy,
                    z,
                );
                if i == 0 {
                    path.move_to((sx, sy));
                } else {
                    path.line_to((sx, sy));
                }
            }
            s.stroke(
                &Stroke::new((pen.stroke_width as f64 * z).max(1.0)),
                Affine::IDENTITY,
                f_color(&pen.stroke_color),
                None,
                &path,
            );
        }
        BoardNode::TextLabel(text) => {
            let (x, y) = w2s(text.transform.x, text.transform.y, ox, oy, z);
            let size = (text.font_size as f64 * z).clamp(6.0, 96.0);
            let line: String = text.text.chars().take(120).collect();
            app.fonts
                .text(s, x, y, &line, size, f_color(&text.color), Wt::Reg);
        }
        BoardNode::Image(img) => {
            // No decoded asset on board images yet — placeholder frame at
            // the node origin with a fixed preview box.
            let (x, y) = w2s(img.transform.x, img.transform.y, ox, oy, z);
            let r = Rect::new(x, y, x + 120.0 * z, y + 90.0 * z);
            s.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                C_FIELD_2,
                None,
                &RoundedRect::from_rect(r, 6.0),
            );
            s.stroke(
                &Stroke::new(1.0),
                Affine::IDENTITY,
                C_LINE,
                None,
                &RoundedRect::from_rect(r, 6.0),
            );
        }
        BoardNode::ConnectorRef(_) => {
            // Connector geometry is painted from BoardPage::connectors.
        }
    }
}

/// Overlays drawn above document content: in-progress marquee and the
/// connector preview line.
pub fn paint_over(app: &mut App, s: &mut Scene) {
    let (ox, oy, z) = app.board_canvas_transform();

    match app.drag {
        Some(Drag::BoardMarquee { start, cur }) => {
            let (ax, ay) = w2s(start.x, start.y, ox, oy, z);
            let (bx, by) = w2s(cur.x, cur.y, ox, oy, z);
            let r = Rect::new(ax.min(bx), ay.min(by), ax.max(bx), ay.max(by));
            s.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::from_rgba8(0x7C, 0x5C, 0xFC, 40),
                None,
                &r,
            );
            s.stroke(&Stroke::new(1.0), Affine::IDENTITY, C_ACCENT, None, &r);
        }
        Some(Drag::BoardConnector {
            from_point,
            to_point,
            ..
        }) => {
            let (ax, ay) = w2s(from_point.x, from_point.y, ox, oy, z);
            let (bx, by) = w2s(to_point.x, to_point.y, ox, oy, z);
            dashed_line(
                s,
                (ax, ay),
                (bx, by),
                Color::from_rgba8(0x7C, 0x5C, 0xFC, 160),
                2.0,
                5.0,
            );
        }
        _ => {}
    }
}

/// Bottom tool rail for board mode — same geometry as the editor dock,
/// board tool set (the dock in editor_ui picks board tools automatically
/// when a Board doc is active; this covers the pure Board screen).
fn paint_board_toolbar(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, crate::state::Action)>) {
    let tools = [
        Tool::Select,
        Tool::BoardSticky,
        Tool::BoardConnector,
        Tool::Pen,
        Tool::BoardRect,
        Tool::BoardCircle,
        Tool::Text,
        Tool::Hand,
        Tool::Zoom,
    ];
    let reg = app.board_regions();
    let bar_w = tools.len() as f64 * 36.0 + 14.0;
    let bar_x0 = reg.canvas.x0 + (reg.canvas.width() - bar_w) / 2.0;
    let bar_y0 = app.win_h - TOOLBAR_BOTTOM - TOOLBAR_H;
    let bar = Rect::new(bar_x0, bar_y0, bar_x0 + bar_w, bar_y0 + TOOLBAR_H);
    s.fill(
        Fill::NonZero,
        Affine::IDENTITY,
        C_TOOLBAR,
        None,
        &RoundedRect::from_rect(bar, R_TOOLBAR),
    );
    s.stroke(
        &Stroke::new(1.0),
        Affine::IDENTITY,
        C_LINE,
        None,
        &RoundedRect::from_rect(bar, R_TOOLBAR),
    );

    for (i, t) in tools.iter().enumerate() {
        let x = bar.x0 + 7.0 + 36.0 * i as f64;
        let r = Rect::new(x, bar.y0 + 4.0, x + TOOL_ICON, bar.y0 + 4.0 + TOOL_ICON);
        let active = app.tool == *t;
        let hov = app.mouse.x >= r.x0
            && app.mouse.x <= r.x1
            && app.mouse.y >= r.y0
            && app.mouse.y <= r.y1;
        if active {
            s.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                C_TEXT,
                None,
                &RoundedRect::from_rect(r, R_TOOL_ICON),
            );
        } else if hov {
            s.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                C_FIELD_2,
                None,
                &RoundedRect::from_rect(r, R_TOOL_ICON),
            );
        }
        draw_icon(
            s,
            t.icon(),
            r.x0 + (TOOL_ICON - 16.0) / 2.0,
            r.y0 + (TOOL_ICON - 16.0) / 2.0,
            16.0,
            if active { C_BG } else { C_DIM },
        );
        hit.push((r, crate::state::Action::Tool(*t)));
    }
}
