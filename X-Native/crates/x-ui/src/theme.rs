//! UI themes: named palettes plus the contrast audit that keeps them honest.
//!
//! A theme here is *only* a set of semantic roles (surface / text / accent /
//! state). The application paints from these numbers: `apps/x-designer`
//! derives its `theme::C_*` constants from [`ColorTokens::GRAPHITE`] at
//! compile time and remaps them at draw time through
//! [`ColorTokens::remap_color`], so the audit below checks the colors users
//! actually see rather than a parallel decorative table.
//!
//! ## The audit
//!
//! [`ColorTokens::contrast_audit`] walks every text role over every surface
//! role it can land on and reports pairs below the WCAG 2.1 AA floor (4.5:1
//! for body text, 3:1 for non-text indicators such as the focus ring). Both
//! shipped palettes pass, and `every_shipped_palette_is_aa_clean` pins that —
//! which is what makes "add a theme" a safe operation instead of a guessing
//! game.

use crate::design_system::{ColorTokens, COLOR_ROLES};

/// The shipped UI themes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeId {
    /// Dark "Graphite & Signal" — the product default.
    Graphite,
    /// Light theme for daylight work and screen sharing.
    Daylight,
}

impl ThemeId {
    /// Every shipped palette. The app offers exactly these — a third
    /// palette is a product decision (a menu row, a design-sheet swatch, a
    /// persisted slug), not something a tool adds on its own.
    pub const ALL: [ThemeId; 2] = [ThemeId::Graphite, ThemeId::Daylight];

    pub fn label(self) -> &'static str {
        match self {
            ThemeId::Graphite => "Graphite (dark)",
            ThemeId::Daylight => "Daylight (light)",
        }
    }

    /// Stable machine name (CLI flags, persisted settings, MCP payloads).
    pub fn slug(self) -> &'static str {
        match self {
            ThemeId::Graphite => "graphite",
            ThemeId::Daylight => "daylight",
        }
    }

    /// Accepts the slug, the label, and the conventional `dark`/`light`
    /// aliases. Unknown names return `None` so callers can report instead of
    /// silently falling back — including the retired `high-contrast` slug,
    /// which a settings file written by an older build may still carry (the
    /// caller then falls back to the default palette).
    pub fn parse(s: &str) -> Option<ThemeId> {
        let t = s.trim().to_lowercase().replace(' ', "-");
        match t.as_str() {
            "graphite" | "dark" | "default" => return Some(ThemeId::Graphite),
            "daylight" | "light" => return Some(ThemeId::Daylight),
            _ => {}
        }
        // labels carry a qualifier ("Graphite (dark)"); accept the leading
        // word so a UI string can be fed back in
        match t
            .split(|c: char| !c.is_ascii_alphabetic())
            .next()
            .unwrap_or_default()
        {
            "graphite" => Some(ThemeId::Graphite),
            "daylight" => Some(ThemeId::Daylight),
            _ => None,
        }
    }

    pub fn is_dark(self) -> bool {
        !matches!(self, ThemeId::Daylight)
    }

    pub fn palette(self) -> ColorTokens {
        ColorTokens::for_theme(self)
    }

    /// Next theme in the cycle (the "flip the UI" shortcut): a flip between
    /// the two palettes, so holding the shortcut can never land on a palette
    /// the user did not ask for.
    pub fn next(self) -> ThemeId {
        match self {
            ThemeId::Graphite => ThemeId::Daylight,
            ThemeId::Daylight => ThemeId::Graphite,
        }
    }
}

/// WCAG 2.1 relative luminance of an sRGB triple.
pub fn luminance(c: [u8; 3]) -> f64 {
    fn chan(v: u8) -> f64 {
        let s = v as f64 / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2])
}

/// Contrast ratio between two colors (1.0 … 21.0).
pub fn contrast_ratio(a: [u8; 3], b: [u8; 3]) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

/// `true` when a color is light enough that text on it should be dark.
pub fn is_light(c: [u8; 3]) -> bool {
    luminance(c) > 0.42
}

/// One audited (foreground role, background role) pair.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContrastPair {
    pub fg: &'static str,
    pub bg: &'static str,
    pub fg_rgb: [u8; 3],
    pub bg_rgb: [u8; 3],
    pub ratio: f64,
    /// Minimum this pair must reach: 4.5 for body text, 3.0 for non-text
    /// indicators such as the selection ring.
    pub min: f64,
}

impl ContrastPair {
    pub fn passes(&self) -> bool {
        self.ratio + 1e-6 >= self.min
    }

    /// `text_secondary on surface_active 3.87:1 (needs 4.5:1)`
    pub fn describe(&self) -> String {
        format!(
            "{} on {} {:.2}:1 (needs {:.1}:1)",
            self.fg, self.bg, self.ratio, self.min
        )
    }
}

/// Roles that carry text, with the floor they must clear.
const TEXT_ROLES: &[(&str, f64)] = &[
    ("text_primary", 4.5),
    ("text_secondary", 4.5),
    ("text_dim", 4.5),
    ("accent_ink", 4.5),
    ("success", 4.5),
    ("warning", 4.5),
    ("danger", 4.5),
    // The placeholder is *text*: a hint the user has to read before typing
    // over it. It used to be exempt as "faint by intent", which shipped
    // #6B6E7A (2.56:1 on a hover fill) — under AA in all three palettes.
    ("text_placeholder", 4.5),
];

/// Roles text sits on.
const SURFACE_ROLES: &[&str] = &[
    "background",
    "canvas",
    "surface",
    "surface_elevated",
    "surface_hover",
    "surface_active",
];

/// Accent fills — `on_accent` is the only text drawn on them.
const ACCENT_FILLS: &[&str] = &["accent", "accent_hover", "accent_active"];

/// (label role, fill role) pairs for saturated tiles that carry text — a
/// count badge, a primary button. A fill is *not* text and does not get the
/// text-contrast exemption: whatever is drawn on it must clear 4.5:1, which is
/// why `danger_fill` exists as a role instead of an invented hex at the badge.
const LABEL_FILLS: &[(&str, &str)] = &[("on_danger", "danger_fill")];

/// Non-text indicators: 3:1 (WCAG 1.4.11), not 4.5:1.
const INDICATOR_ROLES: &[&str] = &["selection", "focus_ring"];

fn pair(p: &ColorTokens, fg: &'static str, bg: &'static str, min: f64) -> Option<ContrastPair> {
    let (fg_rgb, bg_rgb) = (p.role(fg)?, p.role(bg)?);
    Some(ContrastPair {
        fg,
        bg,
        fg_rgb,
        bg_rgb,
        ratio: contrast_ratio(fg_rgb, bg_rgb),
        min,
    })
}

impl ColorTokens {
    /// Every (text role, surface role) pair this palette can produce, plus
    /// labels on accent fills and the two indicator rings.
    pub fn contrast_pairs(&self) -> Vec<ContrastPair> {
        let mut out: Vec<ContrastPair> = Vec::new();
        for (fg, min) in TEXT_ROLES {
            for bg in SURFACE_ROLES {
                if let Some(p) = pair(self, fg, bg, *min) {
                    out.push(p);
                }
            }
        }
        for bg in ACCENT_FILLS {
            if let Some(p) = pair(self, "on_accent", bg, 4.5) {
                out.push(p);
            }
        }
        for (fg, bg) in LABEL_FILLS {
            if let Some(p) = pair(self, fg, bg, 4.5) {
                out.push(p);
            }
        }
        for name in INDICATOR_ROLES {
            if let Some(p) = pair(self, name, "surface", 3.0) {
                out.push(p);
            }
        }
        out
    }

    /// Pairs below their floor, formatted for a log or a test message.
    /// Empty means the palette is AA-clean.
    pub fn contrast_audit(&self) -> Vec<String> {
        self.contrast_pairs()
            .iter()
            .filter(|p| !p.passes())
            .map(|p| p.describe())
            .collect()
    }

    /// Tightest margin in the palette, as a ratio-to-floor quotient — the
    /// number to watch when nudging a color.
    pub fn contrast_headroom(&self) -> Option<f64> {
        self.contrast_pairs()
            .iter()
            .map(|p| p.ratio / p.min)
            .fold(None, |acc: Option<f64>, v| {
                Some(acc.map(|a: f64| a.min(v)).unwrap_or(v))
            })
    }

    /// Multi-line human report (what `x_native theme audit` prints).
    pub fn audit_report(&self, title: &str) -> String {
        let pairs = self.contrast_pairs();
        let mut o = format!(
            "{}: {} pair(s) checked, headroom {:.2}×\n",
            title,
            pairs.len(),
            self.contrast_headroom().unwrap_or(0.0)
        );
        let fails = self.contrast_audit();
        if fails.is_empty() {
            o.push_str("  WCAG AA: all pairs pass\n");
        } else {
            o.push_str(&format!("  WCAG AA: {} pair(s) FAIL\n", fails.len()));
            for f in fails {
                o.push_str(&format!("    - {f}\n"));
            }
        }
        o
    }

    /// The palette as W3C DTCG JSON, so a design file can match the tool:
    /// import these as variables and the document tracks the UI theme.
    pub fn to_dtcg(&self) -> String {
        let roles = self.roles();
        let mut out = String::from(
            "{\n  \"$schema\": \"https://tr.designtokens.org/format/\",\n  \"ui\": {\n",
        );
        for (i, (name, c)) in roles.iter().enumerate() {
            let comma = if i + 1 == roles.len() { "" } else { "," };
            out.push_str(&format!(
                "    \"{name}\": {{ \"$type\": \"color\", \"$value\": \"{}\" }}{comma}\n",
                hex(c)
            ));
        }
        out.push_str("  }\n}\n");
        out
    }

    /// Map one color authored against `from` onto this palette, returning the
    /// themed triple. Allocation-free (draw loops call this per color); the
    /// first matching role wins, matching [`ColorTokens::remap_from`].
    pub fn resolve(&self, from: &ColorTokens, rgb: [u8; 3]) -> Option<[u8; 3]> {
        for name in COLOR_ROLES {
            if from.role(name) == Some(rgb) {
                return self.role(name);
            }
        }
        None
    }

    /// Every role name this palette knows (for tooling and docs).
    pub fn role_names() -> &'static [&'static str] {
        COLOR_ROLES
    }
}

/// `#rrggbb` for a role triple.
pub fn hex(c: &[u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_palette_is_aa_clean() {
        for id in ThemeId::ALL {
            let fails = id.palette().contrast_audit();
            assert!(fails.is_empty(), "{} fails AA: {fails:?}", id.label());
        }
    }

    #[test]
    fn audit_covers_the_whole_role_matrix() {
        // 8 text roles × 6 surfaces + 3 accent labels + 2 indicators
        // + 1 declared label pair (on-danger ink on the danger fill)
        let pairs = ThemeId::Graphite.palette().contrast_pairs();
        assert_eq!(pairs.len(), 8 * 6 + 3 + 2 + 1, "{pairs:?}");
        assert!(
            pairs.iter().all(|p| p.ratio > 1.0),
            "every pair must compare two real colors"
        );
        assert!(pairs
            .iter()
            .any(|p| p.fg == "on_accent" && p.bg == "accent_hover"));
        // Every role is either checked by the audit or explicitly exempt:
        // hairlines carry no meaning on their own, so they are the only
        // exemption left.
        const EXEMPT: &[&str] = &["border", "border_strong"];
        for name in ColorTokens::role_names() {
            let mentioned = pairs.iter().any(|p| p.fg == *name || p.bg == *name);
            assert!(
                mentioned || EXEMPT.contains(name),
                "{name} is neither audited nor exempt"
            );
        }
    }

    #[test]
    fn remap_is_a_function_and_identity_for_graphite() {
        let g = ColorTokens::GRAPHITE;
        // The table is keyed by *color*. Figma's Graphite palette reuses values
        // across roles (#2C2C2C is both chrome and panel; #FFFFFF is both body
        // text and button ink), so a shared source resolves first-role-wins.
        // That is fine because chrome is painted through the role accessors
        // (Theme::text, Theme::on_accent, …), not this table — the table exists
        // to re-tint content authored against Graphite. What it must still
        // guarantee: a unique source per entry, identity within a palette, and
        // pass-through for colors that are not Graphite roles.
        let table = ColorTokens::DAYLIGHT.remap_from(&g);
        let mut seen: Vec<[u8; 3]> = Vec::new();
        for (from, _) in &table {
            assert!(!seen.contains(from), "duplicate source color {from:?}");
            seen.push(*from);
        }
        // identity when the target is the same palette
        for (from, to) in ColorTokens::GRAPHITE.remap_from(&g) {
            assert_eq!(from, to, "graphite must map to itself");
        }
        // a unique Graphite role color keeps its alpha and maps to that role's
        // Daylight value: canvas #1E1E1E -> #F5F5F5
        let c = g.remap_color(&g, [0x1e, 0x1e, 0x1e, 230]);
        assert_eq!(c, [0x1e, 0x1e, 0x1e, 230]);
        let l = ColorTokens::DAYLIGHT.remap_color(&g, [0x1e, 0x1e, 0x1e, 230]);
        assert_eq!(l, [0xf5, 0xf5, 0xf5, 230]);
        // unknown colors pass through untouched
        let u = ColorTokens::DAYLIGHT.remap_color(&g, [0xf2, 0x4e, 0x1e, 255]);
        assert_eq!(u, [0xf2, 0x4e, 0x1e, 255]);
    }

    #[test]
    fn palettes_are_actually_distinct() {
        let g = ThemeId::Graphite.palette();
        let l = ThemeId::Daylight.palette();
        assert_ne!(g.background, l.background, "light theme must differ");
        assert!(
            luminance(l.background) > luminance(g.background),
            "daylight must be the light one"
        );
        // exactly two palettes ship: dark and light, no third option hidden
        // behind a cycle
        assert_eq!(ThemeId::ALL.len(), 2);
        assert_eq!(ThemeId::Graphite.next(), ThemeId::Daylight);
        assert_eq!(ThemeId::Daylight.next(), ThemeId::Graphite);
    }

    #[test]
    fn theme_identity_round_trips() {
        for id in ThemeId::ALL {
            assert_eq!(ThemeId::parse(id.slug()), Some(id), "{}", id.slug());
            assert_eq!(ThemeId::parse(id.label()), Some(id), "{}", id.label());
        }
        assert_eq!(ThemeId::parse("dark"), Some(ThemeId::Graphite));
        assert_eq!(ThemeId::parse("LIGHT"), Some(ThemeId::Daylight));
        assert_eq!(ThemeId::parse("nonsense"), None);
        // the retired slug is refused rather than silently defaulted: the
        // caller (a settings loader) decides what to do about it
        assert_eq!(ThemeId::parse("high-contrast"), None);
        assert_eq!(ThemeId::parse("High Contrast"), None);
        assert_eq!(ThemeId::Graphite.next(), ThemeId::Daylight);
        assert_eq!(ThemeId::Daylight.next(), ThemeId::Graphite);
        assert!(ThemeId::Graphite.is_dark() && !ThemeId::Daylight.is_dark());
    }

    #[test]
    fn dtcg_export_is_valid_and_complete() {
        let json = ThemeId::Daylight.palette().to_dtcg();
        assert!(json.contains("\"$schema\""), "{json}");
        for name in ColorTokens::role_names() {
            assert!(
                json.contains(&format!("\"{name}\": {{ \"$type\": \"color\"")),
                "{name} missing from {json}"
            );
        }
        assert_eq!(json.matches('{').count(), json.matches('}').count());
        assert!(!json.contains(",\n  }"), "trailing comma: {json}");
        assert!(!json.contains(",\n}"), "trailing comma: {json}");
    }

    #[test]
    fn audit_reports_failures_loudly() {
        // a deliberately broken palette: dim text on a busy surface
        let mut broken = ThemeId::Daylight.palette();
        // dim text on the busiest surface — an unmistakable failure
        broken.text_dim = broken.surface_hover;
        let audit = broken.contrast_audit();
        assert!(!audit.is_empty(), "the audit must notice");
        assert!(audit.iter().any(|a| a.starts_with("text_dim")), "{audit:?}");
        let report = broken.audit_report("Daylight");
        assert!(report.contains("FAIL"), "{report}");
        // headroom collapses below 1.0 when a pair fails
        assert!(broken.contrast_headroom().unwrap() < 1.0);
        assert!(
            ThemeId::Graphite.palette().contrast_headroom().unwrap() >= 1.0,
            "shipping palette must have headroom"
        );
    }
}
