//! X-Native Design System — Graphite & Signal Palette
//!
//! Every semantic color below is **derived from the shared palette** in
//! `x_native::ui::ColorTokens::GRAPHITE` (crates/x-ui/src/design_system.rs),
//! which is the single source of truth for UI color and is WCAG-AA audited by
//! `x_native theme audit`. Do not introduce a color that is not a role there;
//! add the role to the palette instead, so every theme and the audit see it.
//!
//! Content colors that are *not* theme roles (the logo, team avatars, smart
//! guides, watermarks) stay as literals at the bottom of this file: switching
//! the UI theme must never repaint what the user drew.
//!
//! ## Runtime themes
//!
//! The app paints through [`resolve`], which maps a Graphite-authored color
//! onto the active palette ([`ThemeId::Daylight`], [`ThemeId::HighContrast`]).
//! With the default theme active it is an atomic load and an early return, so
//! there is no per-frame cost for the feature.

use vello::peniko::Color;
use x_native::text::Span;
use x_native::ui::{ColorTokens, RadiusScale, ThemeId, TypographyScale};

/// The palette these constants are derived from.
const P: ColorTokens = ColorTokens::GRAPHITE;

/// `[u8; 3]` role → opaque color, usable in a `const` context.
pub const fn rgb(c: [u8; 3]) -> Color {
    Color::from_rgb8(c[0], c[1], c[2])
}

/// Role → color with explicit alpha (`const`-safe).
pub const fn rgba(c: [u8; 3], a: u8) -> Color {
    Color::from_rgba8(c[0], c[1], c[2], a)
}

/// `0xAARRGGBB` for a role — for the few surfaces whose scene builder takes
/// packed integers instead of a `Color`. Still derived from the palette.
pub const fn argb(c: [u8; 3]) -> u32 {
    (0xFF << 24) | ((c[0] as u32) << 16) | ((c[1] as u32) << 8) | c[2] as u32
}

/// [`argb`] with explicit alpha.
pub const fn argba(c: [u8; 3], a: u8) -> u32 {
    ((a as u32) << 24) | ((c[0] as u32) << 16) | ((c[1] as u32) << 8) | c[2] as u32
}

/// `role → ROLE` alias for the palette fields that replace the old
/// hand-typed hex values.
macro_rules! role {
    ($name:ident) => {
        P.$name
    };
}

// ------------------------------------------------------------------ theme state

/// Index into [`ThemeId::ALL`]; 0 is the default (identity, no remap).
static ACTIVE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub fn active_theme() -> ThemeId {
    let i = ACTIVE.load(std::sync::atomic::Ordering::Relaxed) as usize;
    ThemeId::ALL.get(i).copied().unwrap_or(ThemeId::Graphite)
}

/// Make `id` the active palette; returns `true` when something changed.
pub fn set_theme(id: ThemeId) -> bool {
    let index = ThemeId::ALL.iter().position(|t| *t == id).unwrap_or(0) as u8;
    ACTIVE.swap(index, std::sync::atomic::Ordering::Relaxed) != index
}

/// Load the user's UI palette from the platform config directory. A missing
/// or malformed preference intentionally falls back to Graphite.
pub fn load_persisted_theme() -> Option<ThemeId> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::PathBuf::from(home)
        .join(".config")
        .join("x-native")
        .join("theme");
    let value = std::fs::read_to_string(path).ok()?;
    ThemeId::parse(value.trim())
}

/// Persist only the stable theme slug, using a temp file so an interrupted
/// write cannot leave a truncated preference.
pub fn persist_theme(id: ThemeId) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let dir = std::path::PathBuf::from(home)
        .join(".config")
        .join("x-native");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("theme");
    let tmp = dir.join("theme.tmp");
    if std::fs::write(&tmp, format!("{}\n", id.slug())).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

/// Map a Graphite-authored color into the active theme. Identity while the
/// default theme is active, and for colors that are not palette roles.
#[inline]
pub fn resolve(c: Color) -> Color {
    if ACTIVE.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        return c;
    }
    let to = active_theme().palette();
    let rgba8 = c.to_rgba8();
    let from = [rgba8.r, rgba8.g, rgba8.b];
    match to.resolve(&P, from) {
        Some(t) => Color::from_rgba8(t[0], t[1], t[2], rgba8.a),
        None => c,
    }
}

/// Re-color a shaped text run before it reaches the scene (and its cache
/// key). `None` means "no theme is active, use what you were given" — the
/// hot path allocates nothing.
pub fn tint_spans(spans: &[Span]) -> Option<Vec<Span>> {
    if ACTIVE.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        return None;
    }
    let to = active_theme().palette();
    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
    for sp in spans {
        let mut sp = sp.clone();
        let c = sp.color.to_rgba8();
        if let Some(t) = to.resolve(&P, [c.r, c.g, c.b]) {
            sp.color = Color::from_rgba8(t[0], t[1], t[2], c.a);
        }
        out.push(sp);
    }
    Some(out)
}

// ------------------------------------------------------------------ surfaces

pub const C_BG: Color = rgb(role!(background)); // Main background (darker than panel)
pub const C_CANVAS: Color = rgb(role!(canvas)); // Canvas area
pub const C_PANEL: Color = rgb(role!(surface)); // Primary panel surface
pub const C_PANEL_2: Color = rgb(role!(surface_elevated)); // Elevated panel (hover state)
pub const C_FIELD: Color = rgb(role!(surface_elevated)); // Input fields
pub const C_FIELD_2: Color = rgb(role!(surface_active)); // Active/selected fields
pub const C_INPUT_HOVER: Color = rgb(role!(surface_hover)); // Input hover state
pub const C_ROW_HOVER: Color = rgb(role!(surface_elevated)); // Row hover state
pub const C_TOOLBAR: Color = rgba(role!(surface), 230); // Toolbar with transparency
pub const C_SCRIM: Color = Color::from_rgba8(0x00, 0x00, 0x00, 145); // Modal/palette overlay
pub const C_BASE: Color = C_BG; // Alias for chrome.rs
pub const C_RAISED: Color = C_PANEL_2; // Raised surface
pub const C_EDGE: Color = C_LINE; // Edge/border color

// ------------------------------------------------------------------- accents

pub const C_ACCENT: Color = rgb(role!(accent)); // Primary accent (fill)
pub const C_ACCENT_MUTED: Color = rgba(role!(accent), 0x33); // Muted accent
/// Unread-notification wash on the nav bar (accent at a whisper of alpha).
pub const C_UNREAD_WASH: Color = rgba(role!(accent), 0x08);
pub const C_ON_ACCENT: Color = rgb(role!(on_accent)); // Text on accent

// ------------------------------------------------------------------ textual

pub const C_TEXT: Color = rgb(role!(text_primary)); // Primary text
pub const C_MUTED: Color = rgb(role!(text_dim)); // Secondary text
pub const C_DIM: Color = rgb(role!(text_placeholder)); // Dimmed text
pub const C_PLACEHOLDER: Color = rgb(role!(text_placeholder)); // Placeholder text
pub const C_ZINC_400: Color = rgb(role!(text_dim)); // Tree names
pub const C_FAINT: Color = C_MUTED; // Faint text (legacy name)
pub const C_BLACK: Color = Color::from_rgb8(0x00, 0x00, 0x00);
pub const C_BLACK_10: Color = Color::from_rgba8(0x00, 0x00, 0x00, 26); // dark watermark
pub const C_WHITE_10: Color = rgba(role!(text_primary), 26); // light watermark

// -------------------------------------------------------------------- lines

pub const C_LINE: Color = rgb(role!(border)); // Subtle borders
pub const C_LINE_2: Color = rgb(role!(border_strong)); // Strong borders

// ------------------------------------------------------------- state colors

// selection ring on canvas; smart-guide lines while dragging
pub const C_SEL: Color = rgb(role!(focus_ring));
pub const C_SEL_SOFT: Color = rgba(role!(focus_ring), 0x14);
/// Wash behind the editor's selected text (stronger than C_SEL_SOFT).
pub const C_SEL_WASH: Color = rgba(role!(focus_ring), 0x42);
/// Border of the in-place text editor (replaces the selection chrome).
pub const C_EDIT_BORDER: Color = rgba(role!(focus_ring), 0x80);
/// Tangent handles in vector edit mode.
pub const C_SEL_HANDLE: Color = rgba(role!(focus_ring), 0x40);
/// Smart-guide lines while dragging — palette accent-ink violet (the editor
/// comments expect "blue/purple"). Was #F24E1E, Figma's brand red — a clone
/// artifact from the reference scrape; role-derived so themes remap it.
pub const C_SNAP: Color = rgb(role!(accent_ink));

// ------------------------------------------------------------- core palette
// The legacy brand aliases (GRAPHITE_900 / SIGNAL_100 / VIOLET_500 …) are
// gone: every surface now names its *role*, which is what lets a theme switch
// reach it at all. New UI code adds a role to `x_native::ui::ColorTokens`
// rather than a constant here.

// ---------------------------------------------------------------- accents
pub const C_LOGO_GREEN: Color = Color::from_rgb8(0x1B, 0xCB, 0x55); // Logo X
pub const C_AVATAR: Color = Color::from_rgb8(0xFF, 0xEB, 0x3B); // Avatar highlight
pub const C_TEAM_L: Color = Color::from_rgb8(0x5B, 0x7C, 0xFF); // Team Liquor Delivery
pub const C_TEAM_D: Color = Color::from_rgb8(0xFF, 0x7A, 0x45); // Team Design System
pub const C_DRAFT_DOT: Color = Color::from_rgb8(0x2E, 0xCC, 0x71); // Draft indicator
pub const C_MD_BADGE: Color = Color::from_rgb8(0x51, 0x9A, 0xBA); // Markdown badge
pub const C_STAR: Color = Color::from_rgb8(0xFF, 0xEB, 0x3B); // Starred items

// Viewport rulers - matching the new panel color
pub const RULER_SIZE: f64 = 22.0;
pub const C_RULER_BG: Color = C_PANEL; // Matches side panels
pub const C_RULER_BORDER: Color = C_LINE; // Matches panel borders
pub const C_RULER_TICK: Color = Color::from_rgb8(0x66, 0x66, 0x66);
pub const C_RULER_TEXT: Color = rgb(role!(text_dim)); // ruler labels

// Board grid colors
pub const C_GRID: Color = Color::from_rgb8(0x4A, 0x4D, 0x58); // Grid dots (visible)
pub const C_GRID_LIGHT: Color = Color::from_rgba8(0x4A, 0x4D, 0x58, 60); // Faint grid dots

// --------------------------------------------------------------- geometry
// Editor dimensions
pub const ED_TITLE_H: f64 = 36.0;
pub const LOGO_CELL_W: f64 = 44.0;
pub const ED_LEFT_W: f64 = 280.0;
pub const ED_LEFT_MIN: f64 = 200.0;
pub const ED_LEFT_MAX: f64 = 480.0;
pub const ED_RIGHT_W: f64 = 340.0;
pub const ED_RIGHT_MIN: f64 = 240.0;
pub const ED_RIGHT_MAX: f64 = 520.0;
pub const NEW_TAB_W: f64 = 32.0;
pub const TAB_MIN_W: f64 = 120.0;
pub const TAB_PAD_L: f64 = 12.0;
pub const TAB_PAD_R: f64 = 10.0;
pub const TREE_ROW_H: f64 = 22.0;
pub const TREE_INDENT: f64 = 12.0;
pub const INPUT_H: f64 = 28.0;
pub const PILL_H: f64 = 30.0;
pub const SQ_BTN: f64 = 28.0;
pub const TOOLBAR_H: f64 = 40.0;
pub const TOOL_ICON: f64 = 32.0;
pub const TOOLBAR_BOTTOM: f64 = 20.0;
pub const RESIZER_W: f64 = 6.0;

// ------------------------------------------------------- menus & dropdowns
/// Right-click menus (canvas + pages) — one geometry for both.
pub const MENU_WIDTH: f64 = 208.0;
pub const MENU_ROW_H: f64 = 28.0;
/// Hamburger app menu width.
pub const APP_MENU_WIDTH: f64 = 220.0;
/// Row height of the hamburger + inspector dropdowns (app menu, frame,
/// line-height, text-style pickers).
pub const DROPDOWN_ROW_H: f64 = 32.0;

// Dashboard dimensions
pub const DASH_TITLE_H: f64 = 40.0;
pub const DASH_SIDE_W: f64 = 260.0;
pub const SEARCH_W: f64 = 480.0;
pub const SEARCH_H: f64 = 32.0;
pub const DRAFT_ROW_H: f64 = 48.0;
pub const LOGO: f64 = 28.0;

// --------------------------------------------------------------- radius
// One name per step, derived from the shared `x-ui` scale: a corner is
// always 2/4/6/8/12. The semantic aliases below name the intent (input,
// card, toolbar…) so call sites read as usage, not geometry.
pub const R_XS: f64 = RadiusScale::XS;
pub const R_SM: f64 = RadiusScale::SM;
pub const R_MD: f64 = RadiusScale::MD;
pub const R_LG: f64 = RadiusScale::LG;
pub const R_XL: f64 = RadiusScale::XL;

pub const R_INPUT: f64 = R_LG;
pub const R_SEARCH: f64 = R_XL;
pub const R_CARD: f64 = R_XL;
pub const R_TOOLBAR: f64 = R_XL;
pub const R_ROW: f64 = R_LG;
pub const R_PAGE: f64 = R_MD;
pub const R_PILL: f64 = R_MD;
pub const R_TREE: f64 = R_SM;
pub const R_LOGO: f64 = R_SM;
pub const R_TOOL_ICON: f64 = R_LG;

// ------------------------------------------------------------- type (px)
// One name per step, derived from the shared `x-ui` scale: 10/11/12/13/
// 14/20. There is deliberately no 9px step — micro labels sit on T10
// with tracking (`TextUi::micro_label`) instead of shrinking the face —
// and no 16px step either (nothing in the UI sets 16px; the shared
// scale still defines it for future use).
pub const T10: f64 = TypographyScale::XS;
pub const T11: f64 = TypographyScale::SM;
pub const T12: f64 = TypographyScale::BASE;
pub const T13: f64 = TypographyScale::MD;
pub const T14: f64 = TypographyScale::LG;
pub const T20: f64 = TypographyScale::XXL;

/// Create a color from RGBA8 values (for rich-text run colors).
pub fn color_from_rgba8(r: u8, g: u8, b: u8) -> vello::peniko::Color {
    vello::peniko::Color::from_rgba8(r, g, b, 255)
}
