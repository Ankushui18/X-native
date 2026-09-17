//! Dashboard screen.
//!
//! Layout constants are hand-tuned for a 1440×900 composition:
//! top bar h-10 (40), sidebar w-[260px], search 480×32 at y 3.5, quick cards
//! 274×88 at y 147.5, recents cards 366.7×230.5 at y 307.5, drafts rows h-12.
//! Text y values are line-box TOPS (1.5 line-height) passed to `TextUi::text`.

use vello::kurbo::Rect;
use vello::Scene;
use x_native::ui::Elevation;
use x_native::Color;

use crate::icons::draw_icon;
use crate::paint::*;
use crate::state::{Action, App, DashLayout, DashSort, DashView, OpenDoc, RecentFile};
use crate::theme::*;

/// Left edge of the main column (sidebar 260 + px-6 24).
const MX: f64 = 284.0;

/// Right edge of the main column (win_w - 24), computed per frame.
fn mx1(app: &App) -> f64 {
    app.win_w - 24.0
}

pub fn paint(app: &mut App, s: &mut Scene) {
    let mut hit: Vec<(Rect, Action)> = Vec::new();
    let win_w = app.win_w;
    let win_h = app.win_h;

    fill_rect(s, Rect::new(0.0, 0.0, win_w, win_h), C_BG);

    paint_top_bar(app, s, &mut hit);
    paint_sidebar(app, s, &mut hit);
    paint_main(app, s, &mut hit);
    paint_first_launch(app, s, &mut hit);

    // search text entry (drawn last so the caret overlays)
    if app.dash_search_focus {
        caret(s, app, search_rect(app));
    }

    // template gallery modal (topmost; its scrim swallows clicks — the
    // input pass resolves the LAST painted rect first)
    if app.template_picker_open {
        paint_template_picker(app, s, &mut hit);
    }

    // Multi-select bar and the sort menu sit above the page content (their
    // hits are appended last, so they resolve first) but under the template
    // modal, which owns the interaction while it is open.
    if !app.template_picker_open {
        paint_bulk_bar(app, s, &mut hit);
        if app.dash_sort_open {
            paint_sort_menu(app, s, &mut hit);
        }
    }

    // Keyboard focus ring: painted from the list just built, under the modal
    // (a modal owns the interaction) so the two never disagree. Focus is the
    // `focus_ring` role (C_FOCUS) — deliberately distinct from the canvas
    // selection colour.
    if !app.template_picker_open {
        if let Some(r) = focus_ring(app, &hit) {
            let ring = r.inflate(1.5, 1.5);
            stroke_rrect(s, ring, R_ROW, C_FOCUS, STROKE_RING);
        }
    }

    app.hit = hit;
}

/// Template gallery modal: the built-in catalog, each row opens a fresh
/// document COPY (templates are code, so opens never share state).
fn paint_template_picker(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let card_w = 520.0;
    let row_h = 64.0;
    let n = OpenDoc::TEMPLATES.len() as f64;
    let card_h = 76.0 + n * row_h + 20.0;
    let cx = (app.win_w - card_w) / 2.0;
    let cy = ((app.win_h - card_h) / 2.0).max(60.0);
    hit.push((
        Rect::new(0.0, 0.0, app.win_w, app.win_h),
        Action::CloseTemplates,
    ));
    fill_rect(s, Rect::new(0.0, 0.0, app.win_w, app.win_h), C_SCRIM);
    let card = Rect::new(cx, cy, cx + card_w, cy + card_h);
    fill_rrect(s, card, R_XL, C_PANEL);
    stroke_rrect(s, card, R_XL, C_LINE_2, 1.0);
    app.fonts.text(
        s,
        cx + 24.0,
        cy + 22.0,
        "Start from a template",
        T14,
        C_TEXT,
        Wt::Semi,
    );
    app.fonts.text(
        s,
        cx + 24.0,
        cy + 46.0,
        "Opens as a new copy — your files stay independent",
        T10,
        C_MUTED,
        Wt::Reg,
    );
    for (i, (name, blurb, icon)) in OpenDoc::TEMPLATES.iter().enumerate() {
        let ry = cy + 76.0 + i as f64 * row_h;
        let row = Rect::new(cx + 12.0, ry, cx + card_w - 12.0, ry + row_h - 8.0);
        if hover(app, row) {
            fill_rrect(s, row, R_LG, C_FIELD_2);
        }
        // template mark: violet chip + that template's OWN glyph — four
        // identical chips in a column read as placeholder art. 32×32 at the
        // row's vertical center (56px row), so chip, CTA and the text block
        // all center on the same line.
        let chip = Rect::new(row.x0 + 12.0, ry + 12.0, row.x0 + 44.0, ry + 44.0);
        fill_rrect(s, chip, R_ROW, C_ACCENT_MUTED);
        draw_icon(s, icon, chip.x0 + 8.0, chip.y0 + 8.0, ICON_MD, C_ON_ACCENT);
        // the row is as wide as the window; keep the copy clear of the CTA
        let text_w = (row.x1 - 76.0) - (row.x0 + 58.0) - 12.0;
        let name = app.fonts.truncate(name, T13, Wt::Med, text_w);
        let blurb = app.fonts.truncate(blurb, T11, Wt::Reg, text_w);
        app.fonts
            .text(s, row.x0 + 58.0, ry + 10.0, &name, T13, C_TEXT, Wt::Med);
        app.fonts
            .text(s, row.x0 + 58.0, ry + 30.0, &blurb, T11, C_DIM, Wt::Reg);
        // CTA at the app's standard control size (32 tall, R_ROW radius) and
        // its standard button hover fill — C_LINE_2 is a *border* role, so a
        // button filled with it looked like a second outline, not a hover.
        let useb = Rect::new(row.x1 - 76.0, ry + 12.0, row.x1 - 12.0, ry + 44.0);
        fill_rrect(
            s,
            useb,
            R_ROW,
            if hover(app, useb) { C_FIELD_2 } else { C_FIELD },
        );
        stroke_rrect(s, useb, R_ROW, C_LINE, 1.0);
        app.fonts
            .text_center(s, useb, "Use", T11, C_TEXT, Wt::Med, true);
        hit.push((useb, Action::NewFromTemplate(i)));
        hit.push((row, Action::NewFromTemplate(i)));
    }
}

pub fn search_rect(app: &App) -> Rect {
    // The HTML centers the 480px search inside the flex-1 container between
    // the wordmark group and the right button group — measured x=460.1 at
    // 1440 (NOT the window center).
    let lw = app.fonts.measure_tracked("X-Native", T14, -0.025, Wt::Semi);
    let left_end = 12.0 + LOGO + 12.0 + lw + 12.0;
    let right_start = app.win_w - 12.0 - 32.0 - 8.0 - 97.0 - 12.0;
    let x0 = left_end + (right_start - left_end - SEARCH_W) / 2.0;
    Rect::new(x0, 3.5, x0 + SEARCH_W, 3.5 + SEARCH_H)
}

fn caret(s: &mut Scene, app: &App, field: Rect) {
    let x = field.x0 + 35.0 + app.fonts.measure(&app.dash_search, T13, Wt::Reg);
    vline(s, x, field.y0 + 7.0, field.y1 - 7.0, C_TEXT);
}

// ------------------------------------------------------- first-launch guide

fn first_launch_marker() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".config/x-native/onboarding-complete"))
}

fn paint_first_launch(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    if app.demo_mode || first_launch_marker().is_some_and(|p| p.exists()) {
        return;
    }
    let card = Rect::new(330.0, 170.0, app.win_w - 330.0, 510.0);
    fill_rect(s, Rect::new(0.0, 40.0, app.win_w, app.win_h), C_SCRIM);
    fill_rrect(s, card, R_XL, C_PANEL);
    stroke_rrect(s, card, R_XL, C_LINE_2, 1.0);
    app.fonts.text(
        s,
        card.x0 + 32.0,
        card.y0 + 34.0,
        "Welcome to X-Native",
        T20,
        C_TEXT,
        Wt::Semi,
    );
    app.fonts.text(
        s,
        card.x0 + 32.0,
        card.y0 + 72.0,
        "A quick start for your first design.",
        T13,
        C_MUTED,
        Wt::Reg,
    );
    let tips = [
        (
            "1",
            "Design",
            "Create frames, layers, vectors, and auto layouts.",
        ),
        (
            "2",
            "Prototype",
            "Connect screens and test interactions in Flow preview.",
        ),
        (
            "3",
            "Ship",
            "Use variables, components, libraries, and PNG/PDF export.",
        ),
    ];
    for (i, (n, title, body)) in tips.into_iter().enumerate() {
        let y = card.y0 + 116.0 + i as f64 * 54.0;
        circle(s, card.x0 + 46.0, y + 9.0, 12.0, C_FIELD_2);
        app.fonts.text_center(
            s,
            Rect::new(card.x0 + 34.0, y - 3.0, card.x0 + 58.0, y + 21.0),
            n,
            T10,
            C_TEXT,
            Wt::Med,
            true,
        );
        app.fonts
            .text(s, card.x0 + 72.0, y, title, T12, C_TEXT, Wt::Med);
        app.fonts
            .text(s, card.x0 + 72.0, y + 19.0, body, T10, C_DIM, Wt::Reg);
    }
    let sample = Rect::new(
        card.x0 + 32.0,
        card.y1 - 56.0,
        card.x0 + 190.0,
        card.y1 - 22.0,
    );
    fill_rrect(s, sample, R_ROW, C_TEXT);
    app.fonts
        .text_center(s, sample, "Open sample project", T11, C_BG, Wt::Med, true);
    hit.push((sample, Action::OnboardingSample));
    let blank = Rect::new(
        card.x0 + 202.0,
        card.y1 - 56.0,
        card.x0 + 350.0,
        card.y1 - 22.0,
    );
    fill_rrect(s, blank, R_ROW, C_FIELD_2);
    app.fonts.text_center(
        s,
        blank,
        "Start with blank file",
        T11,
        C_TEXT,
        Wt::Med,
        true,
    );
    hit.push((blank, Action::OnboardingBlank));
    app.fonts.text(
        s,
        card.x1 - 82.0,
        card.y1 - 42.0,
        "Skip",
        T10,
        C_DIM,
        Wt::Reg,
    );
    hit.push((
        Rect::new(
            card.x1 - 100.0,
            card.y1 - 65.0,
            card.x1 - 24.0,
            card.y1 - 12.0,
        ),
        Action::OnboardingDismiss,
    ));
}

// ------------------------------------------------------------- top bar 40px

fn paint_top_bar(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let win_w = app.win_w;
    let bar = Rect::new(0.0, 0.0, win_w, DASH_TITLE_H);
    fill_rect(s, bar, C_PANEL);
    hline(s, 0.0, win_w, DASH_TITLE_H - 1.0, C_LINE);

    // logo 28×28 at (12, 5.5) + wordmark 14px/600 top 9
    logo_and_name(&mut app.fonts, s, 12.0, 5.5, true);

    // centered search 480×32, y 3.5, radius 10
    let sr = search_rect(app);
    fill_rrect(s, sr, R_SEARCH, C_FIELD);
    stroke_rrect(
        s,
        sr,
        R_SEARCH,
        if app.dash_search_focus {
            C_LINE_2
        } else {
            C_LINE
        },
        1.0,
    );
    draw_icon(s, "search", sr.x0 + 12.0, sr.y0 + 8.0, ICON_MD, C_DIM);
    let tx = sr.x0 + 35.0;
    let label = if app.dash_search.is_empty() {
        if app.demo_mode {
            "Search files, teams, or projects"
        } else {
            "Search recent local files"
        }
    } else {
        app.dash_search.as_str()
    };
    let color = if app.dash_search.is_empty() {
        C_PLACEHOLDER
    } else {
        C_TEXT
    };
    app.fonts
        .text(s, tx, sr.y0 + 6.3, label, T13, color, Wt::Reg);
    // ⌘K badge 31×21 at right pad 12, y 9
    let br = Rect::new(sr.x1 - 43.0, 9.0, sr.x1 - 12.0, 30.0);
    stroke_rrect(s, br, R_SM, C_LINE, 1.0);
    app.fonts
        .text_center(s, br, "⌘K", T10, C_DIM, Wt::Reg, true);
    hit.push((sr, Action::SearchFocus));

    // New file 97×32 at right (avatar 32 + gap 8), radius 8
    let nb = Rect::new(
        win_w - 12.0 - 32.0 - 8.0 - 97.0,
        3.5,
        win_w - 12.0 - 32.0 - 8.0,
        35.5,
    );
    let hov = hover(app, nb);
    fill_rrect(s, nb, R_ROW, if hov { C_FIELD_2 } else { C_FIELD });
    stroke_rrect(s, nb, R_ROW, C_LINE, 1.0);
    draw_icon(s, "plus", nb.x0 + 12.0, nb.y0 + 8.0, ICON_MD, C_TEXT);
    app.fonts
        .text(s, nb.x0 + 36.0, 10.5, "New file", T12, C_TEXT, Wt::Med);
    hit.push((nb, Action::NewFile));

    // avatar S — 32 circle, center (win-28, 19.5)
    let av_cx = win_w - 28.0;
    let av_cy = 19.5;
    let initial = app.user.chars().next().unwrap_or('?').to_string();
    app.fonts
        .avatar(s, av_cx, av_cy, 16.0, C_AVATAR, T12, &initial);
}

// -------------------------------------------------------- sidebar 260px

fn paint_sidebar(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let side = Rect::new(0.0, DASH_TITLE_H, DASH_SIDE_W, app.win_h);
    fill_rect(s, side, C_PANEL);
    vline(s, DASH_SIDE_W - 1.0, DASH_TITLE_H, app.win_h, C_LINE);

    // DRAFTS header row — label box top 53.3
    fill_rrect(s, Rect::new(12.0, 52.0, 28.0, 68.0), R_SM, C_FIELD);
    draw_icon(s, "box", 16.0, 56.0, ICON_XS, C_DIM);
    app.fonts
        .micro_label(s, 36.0, 53.3, "DRAFTS", C_DIM, Wt::Med);

    // Personal row 30px at y 80
    let pr = Rect::new(8.0, 80.0, DASH_SIDE_W - 8.0, 110.0);
    if hover(app, pr) {
        fill_rrect(s, pr, R_MD, C_FIELD);
    }
    circle(s, 23.0, 95.0, 3.0, C_DRAFT_DOT);
    app.fonts
        .text(s, 34.0, 86.0, "Personal", T12, C_TEXT, Wt::Med);
    if hover(app, pr) {
        draw_icon(s, "chevron-down", 234.0, 89.0, ICON_XS, C_DIM);
    }

    // nav rows h-8 (32) at y 122/156/190/224, radius 8, px-2
    let navs = [
        (DashView::Home, "layout-dashboard", "Home"),
        (DashView::Recents, "clock", "Recents"),
        (DashView::Starred, "star", "Starred"),
        (DashView::Trash, "trash-2", "Trash"),
    ];
    for (i, (view, icon, label)) in navs.into_iter().enumerate() {
        let y = 122.0 + 34.0 * i as f64;
        let r = Rect::new(8.0, y, DASH_SIDE_W - 8.0, y + 32.0);
        let active = app.dash_view == view;
        if active {
            fill_rrect(s, r, R_ROW, C_FIELD);
            stroke_rrect(s, r, R_ROW, C_LINE_2, 1.0);
        } else if hover(app, r) {
            fill_rrect(s, r, R_ROW, C_FIELD);
        }
        draw_icon(
            s,
            icon,
            16.0,
            y + 8.0,
            ICON_MD,
            if active { C_TEXT } else { C_DIM },
        );
        app.fonts.text(
            s,
            43.0,
            y + 7.0,
            label,
            T12,
            if active { C_TEXT } else { C_MUTED },
            if active { Wt::Med } else { Wt::Reg },
        );
        hit.push((r, Action::DashNav(view)));
    }

    // divider my-3 → y 268
    hline(s, 0.0, DASH_SIDE_W, 268.0, C_LINE);

    if !app.demo_mode {
        app.fonts
            .text(s, 16.0, 284.0, "LOCAL WORKSPACE", T10, C_DIM, Wt::Med);
        app.fonts
            .text(s, 16.0, 310.0, "No account required", T12, C_TEXT, Wt::Reg);
        app.fonts.text(
            s,
            16.0,
            335.0,
            "Cloud teams are not available yet",
            T10,
            C_DIM,
            Wt::Reg,
        );
        return;
    }
    // TEAMS header — label box top 281
    app.fonts
        .micro_label(s, 12.0, 281.0, "TEAMS", C_DIM, Wt::Med);
    let plus_r = Rect::new(234.0, 273.75, 248.0, 287.75);
    draw_icon(s, "plus", 234.0, 280.75, ICON_SM, C_DIM);
    hit.push((plus_r, Action::AddTeam));

    // team rows h-8 at y 302.5 / 336.5
    let teams: [(&str, char, Color, Option<&str>); 2] = [
        ("Liquor Delivery", 'L', C_TEAM_L, Some("12")),
        ("Design System", 'D', C_TEAM_D, None),
    ];
    for (i, (name, ch, color, count)) in teams.into_iter().enumerate() {
        let y = 302.5 + 34.0 * i as f64;
        let r = Rect::new(8.0, y, DASH_SIDE_W - 8.0, y + 32.0);
        if hover(app, r) {
            fill_rrect(s, r, R_ROW, C_FIELD);
        }
        let initials: String = [ch].iter().collect();
        app.fonts
            .badge(s, 16.0, y + 6.0, 20.0, 6.0, color, &initials);
        app.fonts
            .text(s, 46.0, y + 7.0, name, T12, C_MUTED, Wt::Reg);
        if let Some(n) = count {
            let cb = Rect::new(223.0, y + 6.0, 243.0, y + 26.0);
            circle(s, 233.0, y + 16.0, 10.0, C_FIELD);
            ring(s, 233.0, y + 16.0, 10.0, C_LINE, 1.0);
            app.fonts.text_center(s, cb, n, T10, C_DIM, Wt::Reg, true);
        }
        hit.push((r, Action::DashNav(DashView::Home)));
    }

    // Free/local-first badge (was the "Upgrade to Pro" card — the tool is
    // free to use, there is nothing to sell). Same geometry as before so the
    // sidebar keeps its bottom anchor; purely informational, not clickable.
    let card = Rect::new(
        12.0,
        app.win_h - 102.0,
        DASH_SIDE_W - 12.0,
        app.win_h - 12.0,
    );
    fill_rrect(s, card, R_SEARCH, C_FIELD);
    stroke_rrect(s, card, R_SEARCH, C_LINE, 1.0);
    let ib = Rect::new(
        card.x0 + 13.0,
        card.y0 + 13.0,
        card.x0 + 45.0,
        card.y0 + 45.0,
    );
    fill_rrect(s, ib, R_ROW, C_SUCCESS_WASH);
    stroke_rrect(s, ib, R_ROW, C_SUCCESS_EDGE, STROKE_HAIRLINE);
    draw_icon(s, "check", ib.x0 + 8.0, ib.y0 + 8.0, ICON_MD, C_SUCCESS);
    app.fonts.text(
        s,
        ib.x1 + 8.0,
        card.y0 + 13.3,
        "Free for everyone",
        T11,
        C_TEXT,
        Wt::Med,
    );
    app.fonts.text(
        s,
        ib.x1 + 8.0,
        card.y0 + 29.8,
        "No account required",
        T10,
        C_DIM,
        Wt::Reg,
    );
    // old button slot → plain caption row (not a control, no hit region)
    let cb = Rect::new(
        card.x0 + 13.0,
        card.y1 - 37.0,
        card.x1 - 13.0,
        card.y1 - 13.0,
    );
    fill_rrect(s, cb, R_MD, C_FIELD_2);
    app.fonts.text_center(
        s,
        cb,
        "Your files stay on this machine",
        T10,
        C_MUTED,
        Wt::Reg,
        true,
    );
}

// ------------------------------------------------------------- main area

fn paint_main(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let main = Rect::new(DASH_SIDE_W, DASH_TITLE_H, app.win_w, app.win_h);
    fill_rect(s, main, C_CANVAS);

    // The audited coordinates are viewport-absolute at scroll 0 (the main
    // column already starts below the 40px bar), so the offset is purely
    // the scroll position.
    let dy = -app.dash_scroll;
    let x0 = MX;
    let x1 = mx1(app);

    // Welcome header — h1 box top 64 (36 tall), p top 104
    // tracking-tight (-0.025em) per the h1 class
    app.fonts.text_tracked(
        s,
        x0,
        dy + 64.0,
        &if app.demo_mode {
            format!("Welcome back, {}", app.user)
        } else {
            "Your design workspace".into()
        },
        T20,
        -0.025,
        C_TEXT,
        Wt::Semi,
    );
    let count = if app.demo_mode && app.recents.iter().all(|r| r.path.is_none()) {
        12
    } else {
        app.recents.len()
    };
    app.fonts.text(
        s,
        x0,
        dy + 104.0,
        &if app.demo_mode {
            format!("You have {count} files edited in the last 7 days")
        } else {
            format!("{count} recent local files · Save with Ctrl/Cmd+S · Open with Ctrl/Cmd+O")
        },
        T13,
        C_MUTED,
        Wt::Reg,
    );

    // Sort chip — the grid view has no column headers to click, so the same
    // choice lives here as a menu. It says what the current order *is*.
    let sb = Rect::new(x1 - 320.0, dy + 77.8, x1 - 160.0, dy + 109.8);
    let sb_hot = hover(app, sb) || app.dash_sort_open;
    fill_rrect(s, sb, R_ROW, if sb_hot { C_FIELD_2 } else { C_FIELD });
    // open dropdown = an active (focused) control, not a canvas selection
    stroke_rrect(
        s,
        sb,
        R_ROW,
        if app.dash_sort_open { C_FOCUS } else { C_LINE },
        1.0,
    );
    draw_icon(
        s,
        "arrow-up-down",
        sb.x0 + 12.0,
        sb.y0 + 8.0,
        ICON_MD,
        C_DIM,
    );
    app.fonts.text(
        s,
        sb.x0 + 36.0,
        sb.y0 + 7.0,
        &format!("Sorted by {}", app.dash_sort.label()),
        T12,
        C_MUTED,
        Wt::Reg,
    );
    draw_icon(
        s,
        "chevron-down",
        sb.x1 - 21.0,
        sb.y0 + 10.0,
        ICON_XS,
        C_DIM,
    );
    hit.push((sb, Action::DashSortMenu));

    // Grid / List toggle — 74×32 + 70×32 at y 77.8, right-aligned
    let gb = Rect::new(x1 - 152.0, dy + 77.8, x1 - 70.0 - 8.0, dy + 109.8);
    let lb = Rect::new(x1 - 70.0, dy + 77.8, x1, dy + 109.8);
    for (r, lay, icon, label) in [
        (gb, DashLayout::Grid, "grid-2x2", "Grid"),
        (lb, DashLayout::List, "list", "List"),
    ] {
        let active = app.dash_layout == lay;
        fill_rrect(s, r, R_ROW, if active { C_FIELD } else { C_PANEL });
        stroke_rrect(s, r, R_ROW, C_LINE, 1.0);
        draw_icon(
            s,
            icon,
            r.x0 + 12.0,
            r.y0 + 8.0,
            ICON_MD,
            if active { C_TEXT } else { C_DIM },
        );
        app.fonts.text(
            s,
            r.x0 + 36.0,
            r.y0 + 7.0,
            label,
            T12,
            if active { C_TEXT } else { C_DIM },
            Wt::Reg,
        );
        hit.push((r, Action::DashLayout(lay)));
    }

    // Quick actions — 4 cards 274×88 at y 147.5, gap 12, radius 12.
    // The slot geometry is the reference's; the interior is the signature
    // pass's (square violet chip — see below).
    let gap = 12.0;
    let cw = (x1 - x0 - gap * 3.0) / 4.0;
    let cards: [(&str, &str, &str); 4] = [
        ("plus", "New design file", "Start from scratch"),
        ("import", "Import file", "SVG, PNG, Sketch, Figma JSON"),
        (
            // P14: was the dead "Browse templates" card; boards are real.
            // sticky-note, not layout-template: the template card beside it
            // owns that glyph, and two identical chips in one row read as a
            // rendering bug rather than a family.
            "sticky-note",
            "New board",
            "Infinite canvas for brainstorming",
        ),
        (
            "layout-template",
            "Start from a template",
            "Mobile, landing, system, board",
        ),
    ];
    let acts = [
        Action::NewFile,
        Action::ImportFile,
        Action::NewBoard,
        Action::OpenTemplates,
    ];
    for (i, (icon, title, sub)) in cards.into_iter().enumerate() {
        let cx = x0 + (cw + gap) * i as f64;
        let r = Rect::new(cx, dy + 147.5, cx + cw, dy + 235.5);
        let hov = hover(app, r);
        // .card:hover{transform:translateY(-2px);...} — lift the whole card
        let dy = if hov { dy - 2.0 } else { dy };
        let r = Rect::new(cx, dy + 147.5, cx + cw, dy + 235.5);
    fill_rrect(s, r, R_CARD, if hov { C_PANEL_2 } else { C_PANEL });
    // hover: a quiet strong-border ring (hover must not impersonate the
    // selection colour)
    stroke_rrect(s, r, R_CARD, if hov { C_LINE_2 } else { C_LINE }, 1.0);
        // signature: the icon chip is a square violet tile — the same 32×32,
        // r8, 16px-glyph mark the template-gallery rows wear. The reference
        // mock's flex had SHRUNK its w-8 h-8 chip to 30.7×18 inside the fixed
        // 88px card (a wide lozenge: 7.3px side padding, 1px above/below),
        // and the old clone copied the squash. A square is what that mock was
        // drawing, so the card's interior re-spaces around it instead of
        // shipping the artifact. The card slot itself (274×88, gap 12, tag row
        // top 147.5) is untouched — 10px above the chip, 10px below the copy.
        let ib = Rect::new(cx + 17.0, dy + 157.5, cx + 49.0, dy + 189.5);
        fill_rrect(s, ib, R_ROW, C_ACCENT_MUTED);
        draw_icon(s, icon, ib.x0 + 8.0, ib.y0 + 8.0, ICON_MD, C_ON_ACCENT);
        // title box top 189.5 (+42), sub top 209 (+61.5). The slot is fluid
        // (`cw` is derived from the window: 274 at 1440, 159 at the 980
        // minimum), so both lines are measured against it — at the reference
        // width nothing truncates, and a narrow window ellipsises instead of
        // painting over the neighbouring card.
        let text_w = cw - 34.0;
        let title = app.fonts.truncate(title, T13, Wt::Med, text_w);
        let sub = app.fonts.truncate(sub, T11, Wt::Reg, text_w);
        app.fonts
            .text(s, cx + 17.0, dy + 189.5, &title, T13, C_TEXT, Wt::Med);
        app.fonts
            .text(s, cx + 17.0, dy + 209.0, &sub, T11, C_DIM, Wt::Reg);
        hit.push((r, acts[i].clone()));
    }

    // visible sections depend on the sidebar view
    let view = app.dash_view;
    if matches!(view, DashView::Home | DashView::Recents | DashView::Starred) {
        paint_recents(app, s, hit, x0, x1, dy);
    }
    if view == DashView::Trash {
        // An empty state is a place to go next, not a wall: it says what is
        // true (nothing is in the trash) and offers the way back. Trash used
        // to be a dead end — the only control on screen was the sidebar.
        let box_ = Rect::new(x0, dy + 251.5, x1, dy + 331.5);
        app.fonts
            .text_center(s, box_, "Trash is empty", T14, C_TEXT, Wt::Med, true);
        app.fonts.text_center(
            s,
            Rect::new(x0, dy + 277.5, x1, dy + 297.5),
            "Files you delete land here first, and nothing is removed until you empty it.",
            T11,
            C_DIM,
            Wt::Reg,
            true,
        );
        let back = Rect::new(
            (x0 + x1) / 2.0 - 62.0,
            dy + 321.5,
            (x0 + x1) / 2.0 + 62.0,
            dy + 353.5,
        );
        fill_rrect(
            s,
            back,
            R_ROW,
            if hover(app, back) { C_FIELD_2 } else { C_FIELD },
        );
        stroke_rrect(s, back, R_ROW, C_LINE, 1.0);
        app.fonts
            .text_center(s, back, "Back to Home", T11, C_TEXT, Wt::Med, true);
        hit.push((back, Action::DashNav(DashView::Home)));
    }
    if app.dash_view == DashView::Home {
        paint_drafts(app, s, hit, x0, x1, dy);
    }
}

/// The files the dashboard is showing, in the order it is showing them:
/// `dash_view` filter → search query → `dash_sort`. Painting and bulk actions
/// both go through this, so "select all" and "the rows on screen" are the same
/// list by construction.
pub fn visible_files(app: &App) -> Vec<usize> {
    let query = app.dash_search.to_lowercase();
    let mut idx: Vec<usize> = app
        .recents
        .iter()
        .enumerate()
        .filter(|(_, f)| match app.dash_view {
            DashView::Starred => f.starred,
            DashView::Home | DashView::Recents | DashView::Trash => true,
        })
        .filter(|(_, f)| {
            query.is_empty()
                || f.name.to_lowercase().contains(&query)
                || f.team.to_lowercase().contains(&query)
        })
        .map(|(i, _)| i)
        .collect();
    match app.dash_sort {
        DashSort::Edited => idx.sort_by_key(|i| app.recents[*i].edited_min),
        DashSort::Name => idx.sort_by_key(|i| app.recents[*i].name.to_lowercase()),
        DashSort::Starred => {
            idx.sort_by_key(|i| (!app.recents[*i].starred, app.recents[*i].edited_min))
        }
    }
    // the demo home page shows six, like the reference; other views show all
    if !app.demo_mode && app.dash_view == DashView::Home {
        idx.truncate(6);
    }
    idx
}

fn paint_recents(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    x0: f64,
    x1: f64,
    dy: f64,
) {
    // header row y 267.5 h-6: H2 top 269, chip 24, icons right
    app.fonts
        .text(s, x0, dy + 269.0, "Recents", T14, C_TEXT, Wt::Semi);
    let chip_l = x0 + app.fonts.measure("Recents", T14, Wt::Semi) + 12.0;
    // P13: the chip was painted without a hit; it now cycles the view
    // (Home -> Recents -> Starred -> Trash) and reflects the active one
    let chip_label = match app.dash_view {
        DashView::Home => "All files",
        DashView::Recents => "Recents",
        DashView::Starred => "Starred",
        DashView::Trash => "Trash",
    };
    let chip = Rect::new(chip_l, dy + 267.5, chip_l + 75.0, dy + 291.5);
    fill_rrect(s, chip, R_MD, C_FIELD);
    stroke_rrect(s, chip, R_MD, C_LINE, 1.0);
    app.fonts.text(
        s,
        chip.x0 + 9.0,
        dy + 271.3,
        chip_label,
        T11,
        C_MUTED,
        Wt::Reg,
    );
    draw_icon(
        s,
        "chevron-down",
        chip.x1 - 21.0,
        dy + 273.5,
        ICON_XS,
        C_DIM,
    );
    hit.push((chip, Action::CycleDashView));

    let files: Vec<(usize, &RecentFile)> = visible_files(app)
        .into_iter()
        .map(|i| (i, &app.recents[i]))
        .collect();
    if files.is_empty() {
        app.fonts.text(
            s,
            x0,
            dy + 326.0,
            "No matching recent files",
            T13,
            C_TEXT,
            Wt::Med,
        );
        app.fonts.text(
            s,
            x0,
            dy + 354.0,
            "Create a new file, or use Ctrl/Cmd+O to open an existing project.",
            T12,
            C_DIM,
            Wt::Reg,
        );
        // Empty states must offer the next action, not only instructions.
        let create = Rect::new(x0, dy + 386.0, x0 + 142.0, dy + 418.0);
        fill_rrect(
            s,
            create,
            R_ROW,
            if hover(app, create) {
                C_FIELD_2
            } else {
                C_TEXT
            },
        );
        app.fonts.text_center(
            s,
            create,
            "Create new file",
            T11,
            if hover(app, create) { C_TEXT } else { C_BG },
            Wt::Med,
            true,
        );
        hit.push((create, Action::NewFile));
        let open = Rect::new(x0 + 150.0, dy + 386.0, x0 + 292.0, dy + 418.0);
        fill_rrect(
            s,
            open,
            R_ROW,
            if hover(app, open) { C_FIELD_2 } else { C_PANEL },
        );
        stroke_rrect(s, open, R_ROW, C_LINE, 1.0);
        app.fonts
            .text_center(s, open, "Open existing file", T11, C_TEXT, Wt::Med, true);
        hit.push((open, Action::ImportFile));
        return;
    }

    if app.dash_layout == DashLayout::Grid {
        let gap = 16.0;
        let cols = 3.0;
        let cw = ((x1 - x0) - gap * (cols - 1.0)) / cols;
        let mut thumb_pending: Vec<std::path::PathBuf> = Vec::new();
        for (i, (idx, f)) in files.iter().enumerate() {
            let col = i as f64 % cols;
            let row = (i as f64 / cols).floor();
            let cx = x0 + (cw + gap) * col;
            let cy = dy + 307.5 + (230.5 + gap) * row;
            let card = Rect::new(cx, cy, cx + cw, cy + 230.5);
            hit.push((card, Action::OpenRecent(*idx)));
            let hov = hover(app, card);
            let selected = app.dash_selected.contains(idx);
            fill_rrect(
                s,
                card,
                R_CARD,
                if selected {
                    C_SELECTION_WASH
                } else if hov {
                    C_PANEL_2
                } else {
                    C_PANEL
                },
            );
            // selection is a *state*, not a hover: it keeps the accent ring
            // whether or not the pointer is over it (Figma's browsers do the
            // same, and a multi-select that fades as you move the mouse is
            // unusable)
            stroke_rrect(
                s,
                card,
                R_CARD,
                if selected {
                    C_SEL
                } else if hov {
                    C_LINE_2
                } else {
                    C_LINE
                },
                if selected {
                    STROKE_RING
                } else {
                    STROKE_HAIRLINE
                },
            );
            // thumb 140 tall — live document preview when the file exists on
            // disk (rendered through the same export pipeline as PNG export),
            // flat color + watermark otherwise. One render per frame is
            // pumped at the bottom of paint_recents.
            let thumb = Rect::new(cx + 1.0, cy + 1.0, cx + cw - 1.0, cy + 141.0);
            let mut drawn = false;
            if let Some(p) = f.path.as_ref() {
                if let Some((iw, ih)) = app.thumb_ready(p) {
                    if let Some(assets) = app.thumb_brush(p) {
                        if let Some(b) = assets.get("thumb") {
                            use vello::kurbo::{Affine, RoundedRect};
                            let sc =
                                (thumb.width() / f64::from(iw)).max(thumb.height() / f64::from(ih));
                            let dw = f64::from(iw) * sc;
                            let dh = f64::from(ih) * sc;
                            s.push_clip_layer(
                                vello::peniko::Fill::NonZero,
                                Affine::IDENTITY,
                                &RoundedRect::new(thumb.x0, thumb.y0, thumb.x1, thumb.y1, 8.0),
                            );
                            s.draw_image(
                                b,
                                Affine::translate((
                                    thumb.x0 + (thumb.width() - dw) / 2.0,
                                    thumb.y0 + (thumb.height() - dh) / 2.0,
                                )) * Affine::scale(sc),
                            );
                            s.pop_layer();
                            drawn = true;
                        }
                    }
                }
            }
            if !drawn {
                fill_rect(s, thumb, f.color);
                // big X watermark — 28px bold centered
                let dark_bg = f.color == Color::from_rgb8(0xFF, 0xFF, 0xFF);
                let wm = if dark_bg { C_BLACK_10 } else { C_WHITE_10 };
                app.fonts
                    .text_center(s, thumb, "X", T20, wm, Wt::Bold, true);
                if let Some(p) = &f.path {
                    thumb_pending.push(p.clone());
                }
            }
            if selected {
                let mark = Rect::new(
                    thumb.x0 + 8.0,
                    thumb.y0 + 8.0,
                    thumb.x0 + 28.0,
                    thumb.y0 + 28.0,
                );
                circle(s, mark.center().x, mark.center().y, 10.0, C_ACCENT);
                draw_icon(
                    s,
                    "check",
                    mark.x0 + 2.0,
                    mark.y0 + 2.0,
                    ICON_MD,
                    C_ON_ACCENT,
                );
            }
            let st = Rect::new(
                thumb.x1 - 32.0,
                thumb.y0 + 8.0,
                thumb.x1 - 8.0,
                thumb.y0 + 32.0,
            );
            if hov {
                circle(s, st.x0 + 12.0, st.y0 + 12.0, 12.0, C_DISC_SCRIM);
                draw_icon(
                    s,
                    "star",
                    st.x0 + 5.0,
                    st.y0 + 5.0,
                    ICON_SM,
                    if f.starred { C_STAR } else { C_TEXT },
                );
                hit.push((st, Action::StarRecent(*idx)));
            } else if f.starred {
                draw_icon(s, "star", st.x0 + 5.0, st.y0 + 5.0, ICON_SM, C_STAR);
            }
            // body: name top +153, meta +173, avatars +197.5 (all card-relative)
            let name = app
                .fonts
                .truncate(&f.name, T12, Wt::Med, cw - 24.0 - 16.0 - 8.0);
            app.fonts
                .text(s, cx + 13.0, cy + 153.0, &name, T12, C_TEXT, Wt::Med);
            let meta = app.fonts.truncate(
                &format!("{} • {}", f.team, f.edited),
                T11,
                Wt::Reg,
                cw - 26.0,
            );
            app.fonts
                .text(s, cx + 13.0, cy + 173.0, &meta, T11, C_DIM, Wt::Reg);
            draw_icon(
                s,
                "more-horizontal",
                cx + cw - 28.0,
                cy + 153.0,
                ICON_MD,
                C_DIM,
            );
            // members — 20px overlapping avatars
            let mut mx = cx + 13.0;
            for m in f.members.iter() {
                let mcx = mx + 10.0;
                let mcy = cy + 207.5;
                circle(s, mcx, mcy, 10.0, C_AVATAR);
                ring(s, mcx, mcy, 10.0, C_PANEL, 1.5);
                app.fonts.avatar(s, mcx, mcy, 10.0, C_AVATAR, T10, m);
                mx += 20.0;
            }
        }
        // warm the thumbnail cache progressively (one render per frame)
        app.thumb_pump(thumb_pending);
    } else {
        // list layout — same rows as the drafts panel
        let list_h = (files.len() as f64 * DRAFT_ROW_H).max(1.0);
        let panel = Rect::new(x0, dy + 307.5, x1, dy + 307.5 + list_h);
        fill_rrect(s, panel, R_CARD, C_PANEL);
        stroke_rrect(s, panel, R_CARD, C_LINE, 1.0);
        // Header row: sorting lives on the column it sorts, the way a table
        // should behave (the toolbar chip does the same thing, for the grid
        // view where there are no columns to click).
        let sort_x = x1 - 250.0;
        let head = Rect::new(x0, dy + 279.5, x1, dy + 303.5);
        app.fonts
            .micro_label(s, x0 + 45.0, dy + 288.0, "NAME", C_DIM, Wt::Med);
        for (label, key, hx) in [
            ("TEAM", DashSort::Name, x0 + 320.0),
            ("EDITED", DashSort::Edited, sort_x),
        ] {
            let active = app.dash_sort == key;
            let hr = Rect::new(hx - 6.0, head.y0, hx + 60.0, head.y1);
            app.fonts.micro_label(
                s,
                hx,
                dy + 288.0,
                label,
                if active { C_TEXT } else { C_DIM },
                Wt::Med,
            );
            if active {
                draw_icon(s, "chevron-down", hx + 44.0, dy + 287.0, ICON_XS, C_TEXT);
            }
            hit.push((hr, Action::DashSortBy(key)));
        }
        for (i, (idx, f)) in files.iter().enumerate() {
            let r = Rect::new(
                x0,
                dy + 307.5 + DRAFT_ROW_H * i as f64,
                x1,
                dy + 307.5 + DRAFT_ROW_H * (i + 1) as f64,
            );
            let selected = app.dash_selected.contains(idx);
            if selected {
                fill_rect(s, r, C_SELECTION_WASH);
            } else if hover(app, r) {
                fill_rect(s, r, C_FIELD);
            }
            if i > 0 {
                hline(s, x0, x1, r.y0, C_LINE);
            }
            draw_icon(s, "file-text", r.x0 + 16.0, r.y0 + 16.0, ICON_MD, C_DIM);
            // the row is as wide as the window; measure the name against the
            // columns that follow it rather than the whole row
            let name =
                app.fonts
                    .truncate(&f.name, T12, Wt::Med, (x0 + 320.0 - 12.0) - (r.x0 + 45.0));
            app.fonts
                .text(s, r.x0 + 45.0, r.y0 + 15.0, &name, T12, C_TEXT, Wt::Med);
            app.fonts.text(
                s,
                x0 + 320.0,
                r.y0 + 15.8,
                &app.fonts
                    .truncate(&f.team, T11, Wt::Reg, sort_x - (x0 + 320.0) - 12.0),
                T11,
                C_DIM,
                Wt::Reg,
            );
            app.fonts
                .text(s, sort_x, r.y0 + 15.8, &f.edited, T11, C_DIM, Wt::Reg);
            // hover actions, right-aligned: star, then the row menu
            let star = Rect::new(r.x1 - 64.0, r.y0 + 8.0, r.x1 - 48.0, r.y0 + 24.0);
            let more = Rect::new(r.x1 - 40.0, r.y0 + 8.0, r.x1 - 24.0, r.y0 + 24.0);
            if hover(app, r) || f.starred {
                draw_icon(
                    s,
                    "star",
                    star.x0,
                    star.y0,
                    ICON_MD,
                    if f.starred { C_STAR } else { C_DIM },
                );
            }
            if hover(app, r) {
                draw_icon(s, "more-horizontal", more.x0, more.y0, ICON_MD, C_DIM);
            }
            hit.push((star, Action::StarRecent(*idx)));
            hit.push((r, Action::OpenRecent(*idx)));
        }
    }
}

fn paint_drafts(
    app: &mut App,
    s: &mut Scene,
    hit: &mut Vec<(Rect, Action)>,
    x0: f64,
    x1: f64,
    dy: f64,
) {
    if !app.demo_mode {
        let y = dy + 816.5;
        app.fonts
            .text(s, x0, y, "Open in this session", T14, C_TEXT, Wt::Semi);
        if app.docs.is_empty() {
            app.fonts
                .text(s, x0, y + 33.0, "No open documents", T12, C_DIM, Wt::Reg);
        }
        for (i, doc) in app.docs.iter().enumerate() {
            let r = Rect::new(
                x0,
                y + 30.0 + i as f64 * 48.0,
                x1,
                y + 78.0 + i as f64 * 48.0,
            );
            fill_rrect(s, r, R_ROW, if hover(app, r) { C_FIELD_2 } else { C_PANEL });
            let label = format!("{}{}", doc.name, if doc.dirty { " · unsaved" } else { "" });
            app.fonts
                .text(s, x0 + 16.0, r.y0 + 15.0, &label, T12, C_TEXT, Wt::Med);
            hit.push((r, Action::SelectDoc(i)));
        }
        return;
    }
    // header y 816.5: H2 top 816.5, count top 818.8
    app.fonts
        .text(s, x0, dy + 816.5, "Drafts", T14, C_TEXT, Wt::Semi);
    app.fonts.text_right(
        s,
        x1,
        dy + 818.8,
        &format!("{} files", app.drafts.len().max(12)),
        T11,
        C_DIM,
        Wt::Reg,
        0.0,
    );

    let query = app.dash_search.to_lowercase();
    let drafts: Vec<(usize, &RecentFile)> = app
        .drafts
        .iter()
        .enumerate()
        .filter(|(_, d)| query.is_empty() || d.name.to_lowercase().contains(&query))
        .collect();

    // panel y 849.5, radius 12, rows h-12 (48)
    let list_h = (drafts.len() as f64 * DRAFT_ROW_H).max(1.0);
    let panel_y = dy + 849.5;
    let panel = Rect::new(x0, panel_y, x1, panel_y + list_h);
    fill_rrect(s, panel, R_CARD, C_PANEL);
    stroke_rrect(s, panel, R_CARD, C_LINE, 1.0);
    for (i, (idx, d)) in drafts.iter().enumerate() {
        let r = Rect::new(
            x0,
            panel_y + DRAFT_ROW_H * i as f64,
            x1,
            panel_y + DRAFT_ROW_H * (i + 1) as f64,
        );
        if hover(app, r) {
            fill_rect(s, r, C_FIELD);
        }
        if i > 0 {
            hline(s, x0, x1, r.y0, C_LINE);
        }
        // px-4: icon 16 at +16, name at +45 (16+16+12 gap), name top +14.5
        draw_icon(s, d.icon, x0 + 16.0, r.y0 + 16.0, ICON_MD, C_DIM);
        // the row spans the window and the timestamp is right-aligned, so the
        // name is measured against what is actually left of it
        let edited_w = app.fonts.measure(&d.edited, T11, Wt::Reg);
        let name = app.fonts.truncate(
            &d.name,
            T12,
            Wt::Med,
            (x1 - 45.0 - edited_w - 12.0) - (x0 + 45.0),
        );
        app.fonts
            .text(s, x0 + 45.0, r.y0 + 14.5, &name, T12, C_TEXT, Wt::Med);
        // edited text right edge at more-icon − 12; more at right pad 16
        app.fonts.text_right(
            s,
            x1 - 45.0,
            r.y0 + 15.3,
            &d.edited,
            T11,
            C_DIM,
            Wt::Reg,
            0.0,
        );
        draw_icon(s, "more-horizontal", x1 - 33.0, r.y0 + 16.0, ICON_MD, C_DIM);
        hit.push((r, Action::OpenDraft(*idx)));
    }
}

/// The sort menu, anchored under the sort chip. Three honest orders; the
/// active one is marked, and the whole popup closes on Escape or a click away.
fn paint_sort_menu(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    let x1 = mx1(app);
    let w = 190.0;
    let dd = Rect::new(x1 - 24.0 - w, 113.8, x1 - 24.0, 113.8 + 30.0 * 3.0);
    elev_shadow(s, dd, 8.0, Elevation::Floating);
    fill_rrect(s, dd, R_LG, C_FIELD);
    stroke_rrect(s, dd, R_LG, C_LINE_2, 1.0);
    for (i, (sort, icon)) in [
        (DashSort::Edited, "clock"),
        (DashSort::Name, "type"),
        (DashSort::Starred, "star"),
    ]
    .into_iter()
    .enumerate()
    {
        let r = Rect::new(
            dd.x0,
            dd.y0 + 30.0 * i as f64,
            dd.x1,
            dd.y0 + 30.0 * (i + 1) as f64,
        );
        let active = app.dash_sort == sort;
        if active || hover(app, r) {
            fill_rrect(
                s,
                r.inflate(-4.0, -2.0),
                R_MD,
                if active { C_FIELD_2 } else { C_RAISED },
            );
        }
        draw_icon(
            s,
            icon,
            r.x0 + 12.0,
            r.y0 + 7.0,
            ICON_MD,
            if active { C_TEXT } else { C_DIM },
        );
        app.fonts.text(
            s,
            r.x0 + 38.0,
            r.y0 + 6.5,
            sort.label(),
            T12,
            if active { C_TEXT } else { C_MUTED },
            Wt::Reg,
        );
        if active {
            draw_icon(s, "check", r.x1 - 28.0, r.y0 + 7.0, ICON_MD, C_ACCENT_INK);
        }
        hit.push((r, Action::DashSortBy(sort)));
    }
}

/// The multi-select bar: what is selected, and the things you can do with it.
/// It is only painted when something *is* selected, so it never floats over an
/// empty page, and it sits over the main column (centred on it) like Figma's
/// selection toolbar.
fn paint_bulk_bar(app: &mut App, s: &mut Scene, hit: &mut Vec<(Rect, Action)>) {
    if app.dash_selected.is_empty() {
        return;
    }
    let x0 = MX;
    let x1 = mx1(app);
    let h = 44.0;
    let y0 = app.win_h - 24.0 - h;
    let n = app.dash_selected.len();
    let label = format!("{n} selected");
    let label_w = app.fonts.measure(&label, T12, Wt::Med);
    let buttons: [(&str, Action); 4] = [
        ("Star", Action::DashBulkStar),
        ("Unstar", Action::DashBulkUnstar),
        ("Open", Action::DashBulkOpen),
        ("Remove from recents", Action::DashBulkRemove),
    ];
    let mut widths = Vec::new();
    for (name, _) in &buttons {
        widths.push(app.fonts.measure(name, T11, Wt::Med) + 24.0);
    }
    let inner = 16.0 + label_w + 16.0 + 24.0 + widths.iter().sum::<f64>() + 34.0;
    let bar = Rect::new(
        x0 + ((x1 - x0) - inner) / 2.0,
        y0,
        x0 + ((x1 - x0) - inner) / 2.0 + inner,
        y0 + h,
    );
    elev_shadow(s, bar, 10.0, Elevation::Floating);
    fill_rrect(s, bar, R_CARD, C_RAISED);
    stroke_rrect(s, bar, R_CARD, C_LINE_2, 1.0);
    // swallow presses inside the bar (nothing behind it should react)
    hit.push((bar, Action::DashBarNoop));
    app.fonts.text(
        s,
        bar.x0 + 16.0,
        bar.y0 + 14.0,
        &label,
        T12,
        C_TEXT,
        Wt::Med,
    );
    let mut bx = bar.x0 + 16.0 + label_w + 16.0;
    vline(s, bx - 12.0, bar.y0 + 12.0, bar.y1 - 12.0, C_LINE_2);
    for (i, (name, act)) in buttons.into_iter().enumerate() {
        let r = Rect::new(bx, bar.y0 + 8.0, bx + widths[i], bar.y1 - 8.0);
        let hot = hover(app, r);
        fill_rrect(s, r, R_ROW, if hot { C_FIELD_2 } else { C_FIELD });
        let ink = if act == Action::DashBulkRemove {
            if hot {
                C_DANGER_INK
            } else {
                C_MUTED
            }
        } else if hot {
            C_TEXT
        } else {
            C_MUTED
        };
        app.fonts.text_center(s, r, name, T11, ink, Wt::Med, true);
        bx += widths[i] + 4.0;
        hit.push((r, act));
    }
    // clear the selection
    let clear = Rect::new(bar.x1 - 30.0, bar.y0 + 12.0, bar.x1 - 14.0, bar.y1 - 12.0);
    draw_icon(s, "x", clear.x0, clear.y0, ICON_MD, C_DIM);
    hit.push((clear, Action::DashClearSelection));
}

fn hover(app: &App, r: Rect) -> bool {
    r.contains(app.mouse)
}

/// The dashboard's keyboard stops: the hit list minus the things that are not
/// controls (a modal scrim swallows clicks but must not take focus, and a
/// 10px decoration is not a target). Order is paint order — the sidebar first,
/// then the top bar's buttons, the quick actions, the file grid and the
/// drafts — so Tab walks the page the way it reads.
pub fn focus_targets(app: &App) -> Vec<usize> {
    let full_w = app.win_w - 1.0;
    let full_h = app.win_h - 1.0;
    app.hit
        .iter()
        .enumerate()
        .filter(|(_, (r, _))| {
            let big = r.width() >= full_w && r.height() >= full_h;
            !big && r.width() >= 12.0 && r.height() >= 12.0
        })
        .map(|(i, _)| i)
        .collect()
}

/// Where the ring is: `dash_focus` indexes [`focus_targets`], so the ring can
/// be painted from the freshly built hit list without a second layout pass.
fn focus_ring(app: &App, hit: &[(Rect, Action)]) -> Option<Rect> {
    let targets = focus_targets(app);
    let at = app.dash_focus?;
    targets.get(at).map(|i| hit[*i].0)
}
