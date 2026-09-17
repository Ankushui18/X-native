//! X-Native Unified Design System
//!
//! This module defines the complete design system used across ALL X-Native screens.
//! No screen should define its own colors, spacing, or typography - everything
//! comes from here to ensure perfect consistency.

// ============================================================ Color System

/// Semantic color roles for the whole application.
///
/// This is the single source of truth for UI color: the designer's
/// `theme::C_*` constants are derived from [`ColorTokens::GRAPHITE`], the
/// runtime theme switch maps through [`ColorTokens::remap_from`], and the
/// [`crate::theme`] audit checks these exact numbers against WCAG 2.1 AA.
/// Add a role here — never at a call site.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorTokens {
    /// Window background behind the panels.
    pub background: [u8; 3],
    /// The artboard area.
    pub canvas: [u8; 3],
    /// Primary panel surface.
    pub surface: [u8; 3],
    /// Raised surfaces: fields, hovered rows, menus.
    pub surface_elevated: [u8; 3],
    /// Pointer-over fill for inputs and rows.
    pub surface_hover: [u8; 3],
    /// Selected / active fill.
    pub surface_active: [u8; 3],
    /// Hairline separators.
    pub border: [u8; 3],
    /// Emphasised borders (focused fields, panel edges).
    pub border_strong: [u8; 3],
    /// Body text and layer names.
    pub text_primary: [u8; 3],
    /// Labels and secondary values.
    pub text_secondary: [u8; 3],
    /// De-emphasized meta (counts, hints, timestamps).
    pub text_dim: [u8; 3],
    /// Input placeholders (exempt from the text-contrast floor by design).
    pub text_placeholder: [u8; 3],
    /// Accent as a FILL (primary buttons, active tool). Pair with
    /// [`ColorTokens::on_accent`].
    pub accent: [u8; 3],
    pub accent_hover: [u8; 3],
    pub accent_active: [u8; 3],
    /// Accent as TEXT on a surface — brighter than the fill so labels clear
    /// AA without dulling the brand color used for fills.
    pub accent_ink: [u8; 3],
    /// Text drawn on an accent fill.
    pub on_accent: [u8; 3],
    pub selection: [u8; 3],
    pub focus_ring: [u8; 3],
    pub success: [u8; 3],
    pub warning: [u8; 3],
    /// Danger as text (destructive menu items) and as an icon stroke.
    pub danger: [u8; 3],
    /// Danger as a FILL (an unread/error badge). The text role above is
    /// deliberately pale so it stays legible *on* a surface; a badge needs the
    /// opposite — a saturated tile whose label is [`ColorTokens::on_danger`].
    /// Before this role existed the chrome invented its own badge red and
    /// shipped 3.5:1 white-on-red labels.
    pub danger_fill: [u8; 3],
    /// Text drawn on a danger fill.
    pub on_danger: [u8; 3],
}

/// Every role name, in the order the remap table, the audit and the DTCG
/// export walk. Keep in sync with [`ColorTokens::role`].
pub const COLOR_ROLES: &[&str] = &[
    "background",
    "canvas",
    "surface",
    "surface_elevated",
    "surface_hover",
    "surface_active",
    "border",
    "border_strong",
    "text_primary",
    "text_secondary",
    "text_dim",
    "text_placeholder",
    "accent",
    "accent_hover",
    "accent_active",
    "accent_ink",
    "on_accent",
    "selection",
    "focus_ring",
    "success",
    "warning",
    "danger",
    "danger_fill",
    "on_danger",
];

impl ColorTokens {
    /// Graphite & Signal — the shipping default, and the palette the
    /// designer's constants are derived from.
    pub const GRAPHITE: Self = Self {
        background: [0x09, 0x09, 0x09],
        canvas: [0x06, 0x06, 0x06],
        surface: [0x1b, 0x1d, 0x23],
        surface_elevated: [0x24, 0x26, 0x2d],
        surface_hover: [0x2e, 0x31, 0x3a],
        surface_active: [0x2e, 0x30, 0x38],
        border: [0x2a, 0x2c, 0x34],
        border_strong: [0x3a, 0x3d, 0x46],
        text_primary: [0xf2, 0xf3, 0xf7],
        text_secondary: [0xb0, 0xb5, 0xc1],
        text_dim: [0x9a, 0x9e, 0xaa],
        text_placeholder: [0x93, 0x9a, 0xa6],
        accent: [0x6b, 0x49, 0xf5],
        accent_hover: [0x5b, 0x3c, 0xe0],
        accent_active: [0x4a, 0x2f, 0xc4],
        accent_ink: [0xb4, 0xa4, 0xff],
        on_accent: [0xff, 0xff, 0xff],
        selection: [0x7c, 0x5c, 0xfc],
        focus_ring: [0xa9, 0x96, 0xff],
        success: [0x4c, 0xd9, 0x66],
        warning: [0xf0, 0xad, 0x4e],
        danger: [0xef, 0x9a, 0x94],
        danger_fill: [0xc0, 0x39, 0x2b],
        on_danger: [0xff, 0xff, 0xff],
    };

    /// Daylight — for bright rooms, projectors and screen sharing. Text and
    /// accent values are AA-verified against every surface in this palette.
    pub const DAYLIGHT: Self = Self {
        background: [0xee, 0xf0, 0xf4],
        canvas: [0xe9, 0xea, 0xee],
        surface: [0xff, 0xff, 0xff],
        surface_elevated: [0xf7, 0xf8, 0xfa],
        surface_hover: [0xee, 0xf0, 0xf5],
        surface_active: [0xe4, 0xe7, 0xee],
        border: [0xd6, 0xd9, 0xe0],
        border_strong: [0xae, 0xb3, 0xbf],
        text_primary: [0x1b, 0x1d, 0x23],
        text_secondary: [0x4e, 0x54, 0x60],
        text_dim: [0x5a, 0x5f, 0x6b],
        text_placeholder: [0x5b, 0x62, 0x74],
        accent: [0x4a, 0x2f, 0xc4],
        accent_hover: [0x3f, 0x27, 0x99],
        accent_active: [0x33, 0x1e, 0x7c],
        accent_ink: [0x44, 0x2b, 0xb8],
        on_accent: [0xff, 0xff, 0xff],
        selection: [0x4a, 0x2f, 0xc4],
        focus_ring: [0x3f, 0x27, 0x99],
        success: [0x16, 0x6b, 0x2e],
        warning: [0x8a, 0x5a, 0x00],
        danger: [0xb3, 0x24, 0x2b],
        danger_fill: [0xc0, 0x39, 0x2b],
        on_danger: [0xff, 0xff, 0xff],
    };

    /// Pure black with maximum separation, for low-vision users.
    pub const HIGH_CONTRAST: Self = Self {
        background: [0x00, 0x00, 0x00],
        canvas: [0x00, 0x00, 0x00],
        surface: [0x0a, 0x0a, 0x0a],
        surface_elevated: [0x14, 0x14, 0x14],
        surface_hover: [0x1f, 0x1f, 0x1f],
        surface_active: [0x2a, 0x2a, 0x2a],
        border: [0x8a, 0x8a, 0x8a],
        border_strong: [0xc8, 0xc8, 0xc8],
        text_primary: [0xff, 0xff, 0xff],
        text_secondary: [0xe6, 0xe6, 0xe6],
        text_dim: [0xd0, 0xd0, 0xd0],
        text_placeholder: [0xb8, 0xb8, 0xb8],
        accent: [0xff, 0xd4, 0x00],
        accent_hover: [0xff, 0xe0, 0x4a],
        accent_active: [0xe6, 0xbd, 0x00],
        accent_ink: [0xff, 0xeb, 0x3b],
        on_accent: [0x00, 0x00, 0x00],
        selection: [0xff, 0xeb, 0x3b],
        focus_ring: [0xff, 0xff, 0x00],
        success: [0x7f, 0xff, 0x9f],
        warning: [0xff, 0xe0, 0x8a],
        danger: [0xff, 0xa3, 0xa3],
        danger_fill: [0xff, 0x9a, 0x8f],
        on_danger: [0x00, 0x00, 0x00],
    };

    /// Look a role up by name (an entry of [`COLOR_ROLES`]).
    pub fn role(&self, name: &str) -> Option<[u8; 3]> {
        Some(match name {
            "background" => self.background,
            "canvas" => self.canvas,
            "surface" => self.surface,
            "surface_elevated" => self.surface_elevated,
            "surface_hover" => self.surface_hover,
            "surface_active" => self.surface_active,
            "border" => self.border,
            "border_strong" => self.border_strong,
            "text_primary" => self.text_primary,
            "text_secondary" => self.text_secondary,
            "text_dim" => self.text_dim,
            "text_placeholder" => self.text_placeholder,
            "accent" => self.accent,
            "accent_hover" => self.accent_hover,
            "accent_active" => self.accent_active,
            "accent_ink" => self.accent_ink,
            "on_accent" => self.on_accent,
            "selection" => self.selection,
            "focus_ring" => self.focus_ring,
            "success" => self.success,
            "warning" => self.warning,
            "danger" => self.danger,
            "danger_fill" => self.danger_fill,
            "on_danger" => self.on_danger,
            _ => return None,
        })
    }

    pub const fn for_theme(id: crate::theme::ThemeId) -> Self {
        match id {
            crate::theme::ThemeId::Graphite => Self::GRAPHITE,
            crate::theme::ThemeId::Daylight => Self::DAYLIGHT,
            crate::theme::ThemeId::HighContrast => Self::HIGH_CONTRAST,
        }
    }

    /// Every role value, paired with its name, in [`COLOR_ROLES`] order.
    pub fn roles(&self) -> Vec<(&'static str, [u8; 3])> {
        COLOR_ROLES
            .iter()
            .filter_map(|n| self.role(n).map(|v| (*n, v)))
            .collect()
    }

    /// `from`-palette colors mapped onto this one. One entry per role — the
    /// designer's drawing seam applies these so a theme switch is a single
    /// lookup instead of 600 edited call sites. Identity when `from` is this
    /// palette.
    /// The `(from, to)` table a theme switch walks, keyed by *source color*
    /// (that is what the app hands back at paint time). Two roles may share a
    /// source value — white is the ink on both an accent fill and the danger
    /// fill — and the first role in `COLOR_ROLES` order wins; the palettes
    /// keep such shared values mapped to the same target, which the remap
    /// test in `theme.rs` enforces for every shipped palette.
    pub fn remap_from(&self, from: &ColorTokens) -> Vec<([u8; 3], [u8; 3])> {
        let mut out: Vec<([u8; 3], [u8; 3])> = Vec::new();
        for name in COLOR_ROLES {
            let (a, b) = match (from.role(name), self.role(name)) {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };
            if !out.iter().any(|(x, _)| *x == a) {
                out.push((a, b));
            }
        }
        out
    }

    /// Remap one color, keeping its alpha (translucent scrims and tinted
    /// selections stay translucent in every theme).
    pub fn remap_color(&self, from: &ColorTokens, c: [u8; 4]) -> [u8; 4] {
        let rgb = [c[0], c[1], c[2]];
        let to = self
            .remap_from(from)
            .into_iter()
            .find(|(f, _)| *f == rgb)
            .map(|(_, t)| t)
            .unwrap_or(rgb);
        [to[0], to[1], to[2], c[3]]
    }

    pub const fn high_contrast() -> Self {
        Self::HIGH_CONTRAST
    }
}

impl Default for ColorTokens {
    fn default() -> Self {
        Self::GRAPHITE
    }
}

// ========================================================== Typography System

/// Typography scale - ONE scale for the entire application.
/// No screen should invent its own font sizes.
#[derive(Debug, Clone, Copy)]
pub struct TypographyScale {
    pub size_xs: f64,   // 10px - metadata
    pub size_sm: f64,   // 11px - labels
    pub size_base: f64, // 12px - controls
    pub size_md: f64,   // 13px - primary UI
    pub size_lg: f64,   // 14px - important UI
    pub size_xl: f64,   // 16px - section titles
    pub size_xxl: f64,  // 20px - major headings

    pub line_height_tight: f64,
    pub line_height_base: f64,
    pub line_height_relaxed: f64,

    pub weight_regular: i32,
    pub weight_medium: i32,
    pub weight_semibold: i32,
    pub weight_bold: i32,

    pub letter_spacing_tight: f64,
    pub letter_spacing_base: f64,
    pub letter_spacing_wide: f64,
}

impl Default for TypographyScale {
    fn default() -> Self {
        Self {
            size_xs: Self::XS,
            size_sm: Self::SM,
            size_base: Self::BASE,
            size_md: Self::MD,
            size_lg: Self::LG,
            size_xl: Self::XL,
            size_xxl: Self::XXL,

            line_height_tight: 1.2,
            line_height_base: 1.4,
            line_height_relaxed: 1.6,

            weight_regular: 400,
            weight_medium: 500,
            weight_semibold: 600,
            weight_bold: 700,

            letter_spacing_tight: -0.2,
            letter_spacing_base: 0.0,
            letter_spacing_wide: 0.5,
        }
    }
}

impl TypographyScale {
    /// The seven type steps, usable in `const` contexts: the designer's
    /// `theme::T10`–`T20` are aliases of these, so the scale has one name
    /// per step and the audit below pins them equal.
    pub const XS: f64 = 10.0;
    pub const SM: f64 = 11.0;
    pub const BASE: f64 = 12.0;
    pub const MD: f64 = 13.0;
    pub const LG: f64 = 14.0;
    pub const XL: f64 = 16.0;
    pub const XXL: f64 = 20.0;
}

// =========================================================== Spacing System

/// Spacing scale - consistent rhythm across all screens.
/// Values in pixels, will be multiplied by scale factor.
#[derive(Debug, Clone, Copy)]
pub struct SpacingScale {
    pub space_0: f64,  // 0
    pub space_1: f64,  // 4px
    pub space_2: f64,  // 6px
    pub space_3: f64,  // 8px
    pub space_4: f64,  // 12px
    pub space_5: f64,  // 16px
    pub space_6: f64,  // 20px
    pub space_7: f64,  // 24px
    pub space_8: f64,  // 32px
    pub space_9: f64,  // 40px
    pub space_10: f64, // 48px
}

impl SpacingScale {
    /// The ten steps, usable in `const` contexts: the designer's `theme::SP_*`
    /// vocabulary derives from these, so a gap is always 4/6/8/12/16/20/24/
    /// 32/40/48 and the audit below pins the ladder.
    pub const SPACE_0: f64 = 0.0;
    pub const SPACE_1: f64 = 4.0;
    pub const SPACE_2: f64 = 6.0;
    pub const SPACE_3: f64 = 8.0;
    pub const SPACE_4: f64 = 12.0;
    pub const SPACE_5: f64 = 16.0;
    pub const SPACE_6: f64 = 20.0;
    pub const SPACE_7: f64 = 24.0;
    pub const SPACE_8: f64 = 32.0;
    pub const SPACE_9: f64 = 40.0;
    pub const SPACE_10: f64 = 48.0;
}

impl Default for SpacingScale {
    fn default() -> Self {
        Self {
            space_0: Self::SPACE_0,
            space_1: Self::SPACE_1,
            space_2: Self::SPACE_2,
            space_3: Self::SPACE_3,
            space_4: Self::SPACE_4,
            space_5: Self::SPACE_5,
            space_6: Self::SPACE_6,
            space_7: Self::SPACE_7,
            space_8: Self::SPACE_8,
            space_9: Self::SPACE_9,
            space_10: Self::SPACE_10,
        }
    }
}

// ============================================================= Icon System

/// Icon sizing - Lucide icons with consistent stroke weight and optical sizing.
#[derive(Debug, Clone, Copy)]
pub struct IconScale {
    pub size_xs: f64, // 12px - metadata
    pub size_sm: f64, // 14px - standard controls
    pub size_md: f64, // 16px - primary controls
    pub size_lg: f64, // 18px - important actions
    pub size_xl: f64, // 24px - major icons

    pub stroke_width: f64,
}

impl IconScale {
    /// The five optical sizes, usable in `const` contexts: the app's
    /// `ICON_*` vocabulary derives from these, so an icon is always 12/14/
    /// 16/18/24 and the audit below pins the ladder.
    pub const XS: f64 = 12.0;
    pub const SM: f64 = 14.0;
    pub const MD: f64 = 16.0;
    pub const LG: f64 = 18.0;
    pub const XL: f64 = 24.0;
    /// Stroke weight, constant across sizes ([`IconScale::stroke_width`]).
    pub const STROKE: f64 = 1.5;
}

impl Default for IconScale {
    fn default() -> Self {
        Self {
            size_xs: Self::XS,
            size_sm: Self::SM,
            size_md: Self::MD,
            size_lg: Self::LG,
            size_xl: Self::XL,
            stroke_width: Self::STROKE,
        }
    }
}

// ================================================ Border & Radius System

/// Border radius values for consistent rounding.
#[derive(Debug, Clone, Copy)]
pub struct RadiusScale {
    pub none: f64,
    pub xs: f64,   // 2px - tight corners
    pub sm: f64,   // 4px - inputs, small buttons
    pub md: f64,   // 6px - standard buttons
    pub lg: f64,   // 8px - panels, cards
    pub xl: f64,   // 12px - modals, large surfaces
    pub full: f64, // 9999px - circular
}

impl Default for RadiusScale {
    fn default() -> Self {
        Self {
            none: Self::NONE,
            xs: Self::XS,
            sm: Self::SM,
            md: Self::MD,
            lg: Self::LG,
            xl: Self::XL,
            full: Self::FULL,
        }
    }
}

impl RadiusScale {
    /// The radius steps, usable in `const` contexts: the designer's
    /// `theme::R_*` vocabulary derives from these, so a corner radius is
    /// always one of 2/4/6/8/12 and the audit below pins them equal.
    pub const NONE: f64 = 0.0;
    pub const XS: f64 = 2.0;
    pub const SM: f64 = 4.0;
    pub const MD: f64 = 6.0;
    pub const LG: f64 = 8.0;
    pub const XL: f64 = 12.0;
    pub const FULL: f64 = 9999.0;
}

// ======================================================== Shadow System

/// Elevation shadows - subtle, multi-layered for depth.
///
/// `Copy` because elevation is read per painted surface: copying a 44-byte
/// token out of the scale is cheaper and clearer than cloning through an
/// `Option` at every call site.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shadow {
    pub color: [u8; 3],
    pub offset_x: f64,
    pub offset_y: f64,
    pub blur: f64,
    pub spread: f64,
    pub alpha: u8,
}

#[derive(Debug, Clone)]
pub struct ShadowScale {
    pub none: Option<Shadow>,
    pub sm: Option<Shadow>,
    pub md: Option<Shadow>,
    pub lg: Option<Shadow>,
    pub xl: Option<Shadow>,
}

impl Default for ShadowScale {
    fn default() -> Self {
        Self {
            none: None,
            sm: Some(Shadow {
                color: [0, 0, 0],
                offset_x: 0.0,
                offset_y: 1.0,
                blur: 2.0,
                spread: 0.0,
                alpha: 40,
            }),
            md: Some(Shadow {
                color: [0, 0, 0],
                offset_x: 0.0,
                offset_y: 2.0,
                blur: 4.0,
                spread: 0.0,
                alpha: 50,
            }),
            lg: Some(Shadow {
                color: [0, 0, 0],
                offset_x: 0.0,
                offset_y: 4.0,
                blur: 8.0,
                spread: 0.0,
                alpha: 60,
            }),
            xl: Some(Shadow {
                color: [0, 0, 0],
                offset_x: 0.0,
                offset_y: 8.0,
                blur: 16.0,
                spread: 0.0,
                alpha: 80,
            }),
        }
    }
}

/// How many translucent shells the renderer stacks for one shadow.
/// Twelve steps is enough that the falloff reads as a blur, not bands.
pub const ELEVATION_LAYERS: usize = 12;

/// Named elevation intent — WHY a surface floats, not how far.
///
/// Call sites name the intent (`Raised` toolbar, `Floating` menu, `Overlay`
/// prototype layer, `Modal` palette) and [`Elevation::layers`] turns it
/// into paint. Blur radii and alphas live in exactly one place: the
/// [`ShadowScale`] token each intent maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Elevation {
    /// Flush with its parent: no shadow at all.
    #[default]
    Flat,
    /// Resting chrome: toolbars, cards, canvas frames.
    Raised,
    /// Hovered/floating controls: dropdown menus, tooltips, popovers.
    Floating,
    /// Content floating above the page: prototype overlays, drawers.
    Overlay,
    /// Blocking surfaces: command palette, dialogs, modals.
    Modal,
}

impl Elevation {
    /// The shadow token this intent carries. `Copy` on [`Shadow`] keeps
    /// this a value return instead of a borrow into a temporary scale.
    pub fn token(self) -> Option<Shadow> {
        let scale = ShadowScale::default();
        match self {
            Elevation::Flat => None,
            Elevation::Raised => scale.sm,
            Elevation::Floating => scale.md,
            Elevation::Overlay => scale.lg,
            Elevation::Modal => scale.xl,
        }
    }

    /// The 12 `(grow_px, alpha)` shells for this intent, innermost first.
    ///
    /// The falloff weights are NORMALISED: the alphas sum to exactly the
    /// token's alpha, so the token means what it says. (An earlier draft
    /// scaled raw falloff weights and delivered only ~62% of the token's
    /// alpha — the audit below pins the sum.) Grows expand linearly out
    /// to `1.75 × blur`; `Flat` yields twelve transparent shells.
    pub fn layers(self) -> [(f64, u8); ELEVATION_LAYERS] {
        let mut out = [(0.0, 0); ELEVATION_LAYERS];
        let Some(t) = self.token() else {
            return out;
        };
        let mut weights = [0.0f64; ELEVATION_LAYERS];
        let mut sum = 0.0;
        let mut w = 1.0;
        for slot in weights.iter_mut() {
            *slot = w;
            sum += w;
            w *= 0.72;
        }
        let max_grow = t.blur * 1.75;
        let mut acc = 0u32;
        for (i, slot) in out.iter_mut().enumerate() {
            let a = (f64::from(t.alpha) * weights[i] / sum)
                .round()
                .clamp(0.0, 255.0) as u8;
            acc += u32::from(a);
            slot.0 = max_grow * (i + 1) as f64 / ELEVATION_LAYERS as f64;
            slot.1 = a;
        }
        // Rounding residue lands on the innermost (most visible) shell so
        // the stack delivers the token's alpha exactly.
        let target = u32::from(t.alpha);
        if acc != target {
            let fixed = i32::from(out[0].1) + (target as i32 - acc as i32);
            out[0].1 = fixed.clamp(0, 255) as u8;
        }
        out
    }
}

// ==================================================== Wash & Alpha System

/// Alpha steps for the translucent washes the chrome composites over a
/// surface — scrims, hover discs, selection washes, focus borders, unread
/// tints. Every one of them used to be a bare `0x33`/`0x42` at its call site,
/// which made "how strong is a wash here?" unanswerable from the palette.
///
/// The step names describe the intent, so a new wash should reuse a step
/// rather than invent a number: if none of the five fit, the wash is
/// probably a new *role* ([`ColorTokens`]) rather than a new alpha.
#[derive(Debug, Clone, Copy)]
pub struct AlphaScale {
    pub whisper: u8, // 0x08 — barely-there tint (unread row)
    pub faint: u8,   // 0x14 — soft wash (selected text behind chrome)
    pub soft: u8,    // 0x33 — the standard wash (icon chips, hover discs)
    pub medium: u8,  // 0x42 — emphasis wash (canvas text selection)
    pub strong: u8,  // 0x80 — a border/edge that must read as a line
}

impl Default for AlphaScale {
    fn default() -> Self {
        Self {
            whisper: Self::WHISPER,
            faint: Self::FAINT,
            soft: Self::SOFT,
            medium: Self::MEDIUM,
            strong: Self::STRONG,
        }
    }
}

impl AlphaScale {
    /// The five steps, usable in `const` contexts (the app's `A_*` vocabulary
    /// derives from these).
    pub const WHISPER: u8 = 0x08;
    pub const FAINT: u8 = 0x14;
    pub const SOFT: u8 = 0x33;
    pub const MEDIUM: u8 = 0x42;
    pub const STRONG: u8 = 0x80;
}

// ============================================================ Stroke System

/// Stroke widths. The chrome draws hairlines at 1.0 — the minimum that
/// survives rasterisation at 1× — and rings at 1.5 so a selected chip's
/// outline is not confused with a divider.
#[derive(Debug, Clone, Copy)]
pub struct StrokeScale {
    pub hairline: f64,
    pub ring: f64,
}

impl Default for StrokeScale {
    fn default() -> Self {
        Self {
            hairline: Self::HAIRLINE,
            ring: Self::RING,
        }
    }
}

impl StrokeScale {
    pub const HAIRLINE: f64 = 1.0;
    pub const RING: f64 = 1.5;
}

// ============================================================ Motion System

/// Motion tokens: durations in milliseconds plus the easing curves the app is
/// allowed to use. Nothing tweens today (hover states are painted instantly),
/// but a duration that is invented at a call site is exactly the kind of
/// divergence this system exists to prevent, so the set is fixed here first.
///
/// [`DesignSystem::reduced_motion`] is the contract: when it is true, a
/// duration is read as 0 and transitions collapse to their end state.
#[derive(Debug, Clone, Copy)]
pub struct MotionScale {
    /// Instant feedback: a press, a toggle.
    pub fast: u32,
    /// The default: hover lifts, menu fades.
    pub base: u32,
    /// Larger surfaces: modals, panels sliding in.
    pub slow: u32,
    /// The one easing for entry/exit; a linear curve is never correct for
    /// position.
    pub standard_easing: &'static str,
    /// Easing for things that move within the layout (reorder, resize).
    pub emphasized_easing: &'static str,
}

impl Default for MotionScale {
    fn default() -> Self {
        Self {
            fast: Self::FAST_MS,
            base: Self::BASE_MS,
            slow: Self::SLOW_MS,
            standard_easing: Self::STANDARD_EASING,
            emphasized_easing: Self::EMPHASIZED_EASING,
        }
    }
}

impl MotionScale {
    pub const FAST_MS: u32 = 120;
    pub const BASE_MS: u32 = 180;
    pub const SLOW_MS: u32 = 240;
    pub const STANDARD_EASING: &'static str = "cubic-bezier(0.2, 0, 0, 1)";
    pub const EMPHASIZED_EASING: &'static str = "cubic-bezier(0.4, 0, 0.2, 1)";
}

// =================================================== Interaction States

/// All interactive components must support these states.
/// Defined once, reused everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InteractionState {
    #[default]
    Default,
    Hover,
    Pressed,
    Active,
    Focused,
    Disabled,
    Selected,
    Loading,
}

// =============================================== Complete Design System

/// The complete X-Native Design System.
///
/// This is the SINGLE SOURCE OF TRUTH for all visual properties.
/// Every screen, panel, and component uses this.
#[derive(Debug, Clone)]
pub struct DesignSystem {
    pub colors: ColorTokens,
    pub typography: TypographyScale,
    pub spacing: SpacingScale,
    pub icons: IconScale,
    pub radius: RadiusScale,
    pub shadows: ShadowScale,
    pub alpha: AlphaScale,
    pub stroke: StrokeScale,
    pub motion: MotionScale,

    /// Which palette these tokens came from.
    pub theme_id: crate::theme::ThemeId,
    pub scale: f64, // Global UI scale (accessibility)
    pub high_contrast: bool,
    pub reduced_motion: bool,
}

impl Default for DesignSystem {
    fn default() -> Self {
        Self {
            colors: ColorTokens::default(),
            typography: TypographyScale::default(),
            spacing: SpacingScale::default(),
            icons: IconScale::default(),
            radius: RadiusScale::default(),
            shadows: ShadowScale::default(),
            alpha: AlphaScale::default(),
            stroke: StrokeScale::default(),
            motion: MotionScale::default(),
            theme_id: crate::theme::ThemeId::Graphite,
            scale: 1.0,
            high_contrast: false,
            reduced_motion: false,
        }
    }
}

impl DesignSystem {
    /// The full token set for one theme (palette + the shared scales).
    pub fn with_theme(id: crate::theme::ThemeId) -> Self {
        Self {
            colors: ColorTokens::for_theme(id),
            theme_id: id,
            high_contrast: id == crate::theme::ThemeId::HighContrast,
            ..Default::default()
        }
    }

    /// Re-skin an existing system in place (keeps any custom scale).
    pub fn set_theme(&mut self, id: crate::theme::ThemeId) {
        self.colors = ColorTokens::for_theme(id);
        self.theme_id = id;
        self.high_contrast = id == crate::theme::ThemeId::HighContrast;
    }

    /// Create high contrast version
    pub fn high_contrast() -> Self {
        Self::with_theme(crate::theme::ThemeId::HighContrast)
    }

    /// Apply scale factor to a value
    pub fn scaled(&self, value: f64) -> f64 {
        value * self.scale
    }

    /// Get spacing value scaled
    pub fn space(&self, level: usize) -> f64 {
        let value = match level {
            0 => self.spacing.space_0,
            1 => self.spacing.space_1,
            2 => self.spacing.space_2,
            3 => self.spacing.space_3,
            4 => self.spacing.space_4,
            5 => self.spacing.space_5,
            6 => self.spacing.space_6,
            7 => self.spacing.space_7,
            8 => self.spacing.space_8,
            9 => self.spacing.space_9,
            _ => self.spacing.space_10,
        };
        self.scaled(value)
    }

    /// Get font size scaled
    pub fn font_size(&self, level: &str) -> f64 {
        let value = match level {
            "xs" => self.typography.size_xs,
            "sm" => self.typography.size_sm,
            "base" | "md" => self.typography.size_base,
            "lg" => self.typography.size_md,
            "xl" => self.typography.size_lg,
            "xxl" => self.typography.size_xl,
            _ => self.typography.size_base,
        };
        self.scaled(value)
    }
}

// ========================================================= Legacy Compatibility

/// Convert DesignSystem to old Theme format for backward compatibility
pub use crate::Theme;

impl From<&DesignSystem> for Theme {
    fn from(ds: &DesignSystem) -> Self {
        Self {
            id: ds.theme_id,
            colors: ds.colors,
            scale: ds.scale,
            high_contrast: ds.high_contrast,
            reduced_motion: ds.reduced_motion,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_consts_match_defaults() {
        let r = RadiusScale::default();
        assert_eq!(
            [r.none, r.xs, r.sm, r.md, r.lg, r.xl, r.full],
            [
                RadiusScale::NONE,
                RadiusScale::XS,
                RadiusScale::SM,
                RadiusScale::MD,
                RadiusScale::LG,
                RadiusScale::XL,
                RadiusScale::FULL,
            ]
        );
        let t = TypographyScale::default();
        assert_eq!(
            [
                t.size_xs,
                t.size_sm,
                t.size_base,
                t.size_md,
                t.size_lg,
                t.size_xl,
                t.size_xxl,
            ],
            [
                TypographyScale::XS,
                TypographyScale::SM,
                TypographyScale::BASE,
                TypographyScale::MD,
                TypographyScale::LG,
                TypographyScale::XL,
                TypographyScale::XXL,
            ]
        );
        let sp = SpacingScale::default();
        assert_eq!(
            [
                sp.space_0,
                sp.space_1,
                sp.space_2,
                sp.space_3,
                sp.space_4,
                sp.space_5,
                sp.space_6,
                sp.space_7,
                sp.space_8,
                sp.space_9,
                sp.space_10,
            ],
            [
                SpacingScale::SPACE_0,
                SpacingScale::SPACE_1,
                SpacingScale::SPACE_2,
                SpacingScale::SPACE_3,
                SpacingScale::SPACE_4,
                SpacingScale::SPACE_5,
                SpacingScale::SPACE_6,
                SpacingScale::SPACE_7,
                SpacingScale::SPACE_8,
                SpacingScale::SPACE_9,
                SpacingScale::SPACE_10,
            ]
        );
        let i = IconScale::default();
        assert_eq!(
            [
                i.size_xs,
                i.size_sm,
                i.size_md,
                i.size_lg,
                i.size_xl,
                i.stroke_width
            ],
            [
                IconScale::XS,
                IconScale::SM,
                IconScale::MD,
                IconScale::LG,
                IconScale::XL,
                IconScale::STROKE
            ]
        );
        let a = AlphaScale::default();
        assert_eq!(
            [a.whisper, a.faint, a.soft, a.medium, a.strong],
            [
                AlphaScale::WHISPER,
                AlphaScale::FAINT,
                AlphaScale::SOFT,
                AlphaScale::MEDIUM,
                AlphaScale::STRONG
            ]
        );
        let s = StrokeScale::default();
        assert_eq!(
            [s.hairline, s.ring],
            [StrokeScale::HAIRLINE, StrokeScale::RING]
        );
        let m = MotionScale::default();
        assert_eq!(
            [m.fast, m.base, m.slow],
            [
                MotionScale::FAST_MS,
                MotionScale::BASE_MS,
                MotionScale::SLOW_MS
            ]
        );
    }

    /// A scale is an ordered ladder: an out-of-order step means two tokens
    /// that look different in code are the same (or inverted) in pixels, and
    /// every `match` on a step silently lies.
    #[test]
    fn every_scale_is_monotonic() {
        let r = RadiusScale::default();
        let radii = [r.none, r.xs, r.sm, r.md, r.lg, r.xl];
        assert!(radii.windows(2).all(|w| w[0] < w[1]), "radii: {radii:?}");

        let t = TypographyScale::default();
        let type_steps = [
            t.size_xs,
            t.size_sm,
            t.size_base,
            t.size_md,
            t.size_lg,
            t.size_xl,
            t.size_xxl,
        ];
        assert!(
            type_steps.windows(2).all(|w| w[0] < w[1]),
            "type: {type_steps:?}"
        );

        let i = IconScale::default();
        let icons = [i.size_xs, i.size_sm, i.size_md, i.size_lg, i.size_xl];
        // distinct, and never below the 1px-per-step floor that makes an
        // "optical size" meaningful at all
        assert!(
            icons.windows(2).all(|w| w[0] < w[1] && w[1] - w[0] >= 2.0),
            "icons: {icons:?}"
        );

        let sp = SpacingScale::default();
        let space = [
            sp.space_1,
            sp.space_2,
            sp.space_3,
            sp.space_4,
            sp.space_5,
            sp.space_6,
            sp.space_7,
            sp.space_8,
            sp.space_9,
            sp.space_10,
        ];
        assert!(space.windows(2).all(|w| w[0] < w[1]), "space: {space:?}");

        let a = AlphaScale::default();
        let alphas = [a.whisper, a.faint, a.soft, a.medium, a.strong];
        assert!(alphas.windows(2).all(|w| w[0] < w[1]), "alpha: {alphas:?}");

        let m = MotionScale::default();
        assert!(m.fast < m.base && m.base < m.slow, "motion: {m:?}");
    }

    /// The aggregate is the object screens are handed, so a scale that is not
    /// wired into `DesignSystem` is invisible to every consumer — this pins
    /// the whole set in one place.
    #[test]
    fn design_system_carries_every_scale() {
        let ds = DesignSystem::default();
        assert_eq!(ds.spacing.space_4, SpacingScale::default().space_4);
        assert_eq!(ds.typography.size_base, TypographyScale::BASE);
        assert_eq!(ds.radius.lg, RadiusScale::LG);
        assert_eq!(ds.icons.size_md, IconScale::MD);
        assert_eq!(ds.alpha.soft, AlphaScale::SOFT);
        assert_eq!(ds.stroke.hairline, StrokeScale::HAIRLINE);
        assert_eq!(ds.motion.base, MotionScale::BASE_MS);
        assert!(ds.shadows.md.is_some());
        // the accessibility knobs travel with the system, not with the theme
        assert_eq!(ds.scale, 1.0);
        assert!(!ds.reduced_motion);
        let hc = DesignSystem::high_contrast();
        assert!(hc.high_contrast);
        assert_eq!(hc.theme_id, crate::theme::ThemeId::HighContrast);
        // and the legacy `Theme` view agrees with it (one-way conversion)
        let t: crate::Theme = (&hc).into();
        assert!(t.high_contrast);
        assert_eq!(t.id, hc.theme_id);
    }

    #[test]
    fn shadow_is_copy() {
        fn assert_copy<T: Copy>() {}
        assert_copy::<Shadow>();
        // ... which is what lets intents hand out tokens by value
        let a = Elevation::Modal.token().unwrap();
        let b = a;
        assert_eq!(a, b);
    }

    #[test]
    fn elevation_intents_deepen_monotonically() {
        let tokens = [
            Elevation::Raised.token().unwrap(),
            Elevation::Floating.token().unwrap(),
            Elevation::Overlay.token().unwrap(),
            Elevation::Modal.token().unwrap(),
        ];
        for pair in tokens.windows(2) {
            assert!(pair[1].alpha > pair[0].alpha, "alpha must deepen: {pair:?}");
            assert!(pair[1].blur > pair[0].blur, "blur must deepen: {pair:?}");
        }
        assert!(Elevation::Flat.token().is_none());
    }

    #[test]
    fn elevation_layers_are_normalised_to_the_token() {
        for intent in [
            Elevation::Raised,
            Elevation::Floating,
            Elevation::Overlay,
            Elevation::Modal,
        ] {
            let layers = intent.layers();
            let token = intent.token().unwrap();
            let sum: u32 = layers.iter().map(|(_, a)| u32::from(*a)).sum();
            assert_eq!(sum, u32::from(token.alpha), "{intent:?} stack must deliver");
            assert!(layers[0].1 > 0, "{intent:?} innermost shell is visible");
            for pair in layers.windows(2) {
                assert!(pair[1].0 > pair[0].0, "{intent:?} shells expand outward");
            }
        }
        assert!(Elevation::Flat.layers().iter().all(|(_, a)| *a == 0));
    }
}
