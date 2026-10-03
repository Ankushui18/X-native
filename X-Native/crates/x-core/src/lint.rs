//! Design lint: deterministic, rule-id-keyed findings over a Document —
//! the checkable half of OpenPencil's `openpencil lint` workflow.
//!
//! Rules are plain functions over the tree (no render access needed);
//! findings sort by (depth-first node order, rule id) so CLI output is
//! byte-stable for a given document.
//!
//! ## Presets
//!
//! A preset decides which rules are enabled; `--rule`/`--ignore` then
//! refine the selection by id (allow-list first, deny-list after):
//!
//! * `recommended` — the default: naming, invisible geometry, small/low
//!   contrast text, touch targets, nesting depth, stray children, hidden
//!   content in exporting frames, duplicate sibling names.
//! * `strict` — recommended, but WCAG-AA text contrast (4.5:1) replaces
//!   the 3:1 floor, plus sub-pixel geometry, empty containers and
//!   palette-adherence checks.
//! * `a11y` — accessibility rules only (readable text, contrast, hit
//!   targets, clipped text).
//! * `all` — every rule the engine knows about.

use crate::query::kind_label;
use crate::{Document, Node, NodeKind, Paint, Variables};

/// Preset name accepted by `--preset` (and by MCP callers).
pub const PRESET_RECOMMENDED: &str = "recommended";
pub const PRESET_STRICT: &str = "strict";
pub const PRESET_A11Y: &str = "a11y";
pub const PRESET_ALL: &str = "all";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Warning,
    Error,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Warning => "warning",
            Severity::Error => "error",
        }
    }
}

/// Which rules a lint run enables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Recommended,
    Strict,
    A11y,
    All,
}

impl Preset {
    pub fn all() -> [Preset; 4] {
        [
            Preset::Recommended,
            Preset::Strict,
            Preset::A11y,
            Preset::All,
        ]
    }

    pub fn name(self) -> &'static str {
        match self {
            Preset::Recommended => PRESET_RECOMMENDED,
            Preset::Strict => PRESET_STRICT,
            Preset::A11y => PRESET_A11Y,
            Preset::All => PRESET_ALL,
        }
    }

    /// Parse a preset name; unknown names return `None` so callers can
    /// report a usage error instead of silently picking a default.
    pub fn parse(s: &str) -> Option<Preset> {
        match s {
            PRESET_RECOMMENDED | "default" => Some(Preset::Recommended),
            PRESET_STRICT => Some(Preset::Strict),
            PRESET_A11Y | "accessibility" | "wcag" => Some(Preset::A11y),
            PRESET_ALL => Some(Preset::All),
            _ => None,
        }
    }

    /// True when `rule` belongs to the set of rules this preset turns on.
    /// `low-contrast` and `aa-contrast` are mutually exclusive because
    /// they are two thresholds of one check (see [`LintConfig::strict`]).
    pub fn enables(self, rule: &str) -> bool {
        match self {
            Preset::Recommended => RECOMMENDED.contains(&rule),
            Preset::Strict => {
                (RECOMMENDED.contains(&rule) && rule != "low-contrast")
                    || STRICT_EXTRA.contains(&rule)
            }
            Preset::A11y => A11Y.contains(&rule) && rule != "aa-contrast",
            Preset::All => true,
        }
    }
}

/// Rules in the default preset (everything except the opinionated extras).
const RECOMMENDED: &[&str] = &[
    "unnamed-layer",
    "generic-name",
    "duplicate-sibling",
    "zero-size",
    "text-small",
    "low-contrast",
    "deep-nesting",
    "stray-child",
    "touch-target",
    "hidden-in-export",
];
/// Added on top of `recommended` by the `strict` preset (which also swaps
/// `low-contrast` for the stricter `aa-contrast`).
const STRICT_EXTRA: &[&str] = &[
    "aa-contrast",
    "text-clipped",
    "off-grid",
    "empty-frame",
    "hardcoded-color",
];
/// The accessibility-only cut: readable, perceivable, hittable.
const A11Y: &[&str] = &[
    "text-small",
    "low-contrast",
    "aa-contrast",
    "touch-target",
    "text-clipped",
    "zero-size",
];

/// One rule's self-description, as printed by `--list-rules`.
#[derive(Debug, Clone, Copy)]
pub struct RuleInfo {
    pub id: &'static str,
    /// One-line description of what the rule checks.
    pub what: &'static str,
    /// Severity findings of this rule carry.
    pub severity: Severity,
    /// Presets that enable this rule.
    pub presets: &'static [Preset],
}

impl RuleInfo {
    pub fn in_preset(&self, p: Preset) -> bool {
        self.presets.contains(&p)
    }
}

/// Everything a lint run needs: preset, explicit allow/deny lists and the
/// WCAG threshold implied by the preset.
#[derive(Debug, Clone)]
pub struct LintConfig {
    pub preset: Preset,
    /// When non-empty only these rule ids run (before `skip`).
    pub only: Vec<String>,
    /// These rule ids never run.
    pub skip: Vec<String>,
}

impl Default for LintConfig {
    fn default() -> Self {
        Self {
            preset: Preset::Recommended,
            only: Vec::new(),
            skip: Vec::new(),
        }
    }
}

impl LintConfig {
    pub fn preset(p: Preset) -> Self {
        Self {
            preset: p,
            ..Self::default()
        }
    }
    /// `true` when the AA (4.5:1) contrast check replaces the 3:1 one.
    pub fn strict_contrast(&self) -> bool {
        matches!(self.preset, Preset::Strict | Preset::All)
    }
    fn wants(&self, rule: &str) -> bool {
        if !self.only.is_empty() {
            if !self.only.iter().any(|r| r == rule) {
                return false;
            }
        } else if !self.preset.enables(rule) {
            return false;
        }
        !self.skip.iter().any(|r| r == rule)
    }
    /// Human-readable one-liner for status bars ("preset strict").
    pub fn describe(&self) -> String {
        let mut s = format!("preset {}", self.preset.name());
        if !self.only.is_empty() {
            s.push_str(&format!(", only {}", self.only.join("+")));
        }
        if !self.skip.is_empty() {
            s.push_str(&format!(", -{}", self.skip.join("+")));
        }
        s
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub rule: &'static str,
    pub severity: Severity,
    pub node: String,
    pub message: String,
}

impl Finding {
    pub fn to_json(&self) -> String {
        format!(
            "{{ \"rule\": \"{}\", \"severity\": \"{}\", \"node\": \"{}\", \"message\": \"{}\" }}",
            self.rule,
            self.severity.as_str(),
            crate::query::esc_str(&self.node),
            crate::query::esc_str(&self.message)
        )
    }
}

/// Machine-readable run summary: counts by severity, the fired rule set and
/// the findings themselves. Used by `x_native lint --json`.
pub fn report_json(findings: &[Finding], label: &str, cfg: &LintConfig) -> String {
    let (mut errors, mut warnings) = (0usize, 0usize);
    let mut fired: Vec<&'static str> = Vec::new();
    for f in findings {
        match f.severity {
            Severity::Error => errors += 1,
            Severity::Warning => warnings += 1,
        }
        if !fired.contains(&f.rule) {
            fired.push(f.rule);
        }
    }
    fired.sort_unstable();
    format!(
        "{{ \"source\": \"{}\", \"preset\": \"{}\", \"filters\": \"{}\", \
         \"counts\": {{ \"error\": {}, \"warning\": {}, \"total\": {} }}, \
         \"rules_fired\": [{}], \"findings\": [{}] }}",
        crate::query::esc_str(label),
        cfg.preset.name(),
        crate::query::esc_str(&cfg.describe()),
        errors,
        warnings,
        findings.len(),
        fired
            .iter()
            .map(|r| format!("\"{r}\""))
            .collect::<Vec<_>>()
            .join(", "),
        findings
            .iter()
            .map(|f| f.to_json())
            .collect::<Vec<_>>()
            .join(",\n")
    )
}

/// Every rule the linter can produce, with severity and preset membership
/// (for `--list-rules`).
pub fn rule_table() -> &'static [RuleInfo] {
    const ALL: &[Preset] = &[
        Preset::Recommended,
        Preset::Strict,
        Preset::A11y,
        Preset::All,
    ];
    const REC: &[Preset] = &[Preset::Recommended, Preset::Strict, Preset::All];
    const STRICT: &[Preset] = &[Preset::Strict, Preset::All];
    const A11Y_ONLY: &[Preset] = &[Preset::A11y, Preset::All];
    &[
        RuleInfo {
            id: "unnamed-layer",
            what: "layer has no name",
            severity: Severity::Warning,
            presets: REC,
        },
        RuleInfo {
            id: "generic-name",
            what: "layer is still named after its type",
            severity: Severity::Warning,
            presets: REC,
        },
        RuleInfo {
            id: "duplicate-sibling",
            what: "two siblings share one name",
            severity: Severity::Warning,
            presets: REC,
        },
        RuleInfo {
            id: "zero-size",
            what: "layer is invisible-size (≤1px) yet paints",
            severity: Severity::Error,
            presets: ALL,
        },
        RuleInfo {
            id: "text-small",
            what: "text renders under 12px",
            severity: Severity::Warning,
            presets: ALL,
        },
        RuleInfo {
            id: "text-clipped",
            what: "text box is shorter than its line height",
            severity: Severity::Warning,
            presets: A11Y_ONLY,
        },
        RuleInfo {
            id: "low-contrast",
            what: "text vs. container background below 3:1",
            severity: Severity::Warning,
            presets: &[Preset::Recommended, Preset::A11y, Preset::All],
        },
        RuleInfo {
            id: "aa-contrast",
            what: "text vs. container below 4.5:1 (WCAG AA)",
            severity: Severity::Warning,
            presets: &[Preset::Strict, Preset::All],
        },
        RuleInfo {
            id: "touch-target",
            what: "interactive node smaller than 40×40",
            severity: Severity::Warning,
            presets: ALL,
        },
        RuleInfo {
            id: "deep-nesting",
            what: "tree nests deeper than 12 levels",
            severity: Severity::Warning,
            presets: REC,
        },
        RuleInfo {
            id: "stray-child",
            what: "child exceeds its non-auto-layout parent 2×",
            severity: Severity::Warning,
            presets: REC,
        },
        RuleInfo {
            id: "off-grid",
            what: "sub-pixel x/y/width/height on a shape",
            severity: Severity::Warning,
            presets: STRICT,
        },
        RuleInfo {
            id: "empty-frame",
            what: "container frame holds nothing",
            severity: Severity::Warning,
            presets: STRICT,
        },
        RuleInfo {
            id: "hardcoded-color",
            what: "fill bypasses the variable palette",
            severity: Severity::Warning,
            presets: STRICT,
        },
        RuleInfo {
            id: "hidden-in-export",
            what: "hidden sibling inside an exporting frame",
            severity: Severity::Warning,
            presets: REC,
        },
    ]
}

/// All rule ids the linter can produce (for `--list-rules`). A `(id, what)`
/// view of [`rule_table`], built once and cached.
pub fn rules() -> &'static [(&'static str, &'static str)] {
    use std::sync::OnceLock;
    static MIRROR: OnceLock<Vec<(&'static str, &'static str)>> = OnceLock::new();
    MIRROR.get_or_init(|| rule_table().iter().map(|r| (r.id, r.what)).collect())
}

/// Preset severity of a rule id (`None` for unknown ids).
pub fn rule_severity(id: &str) -> Option<Severity> {
    rule_table().iter().find(|r| r.id == id).map(|r| r.severity)
}

/// Unknown-rule validation for CLI/MCP argument parsing.
pub fn unknown_rules(ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| rule_table().iter().all(|r| &r.id != id))
        .cloned()
        .collect()
}

/// Lint with the `recommended`/`strict` bool API kept for callers that only
/// know the pre-preset signature.
pub fn lint(doc: &Document, strict: bool) -> Vec<Finding> {
    lint_with(
        doc,
        &LintConfig::preset(if strict {
            Preset::Strict
        } else {
            Preset::Recommended
        }),
    )
}

pub fn lint_with(doc: &Document, cfg: &LintConfig) -> Vec<Finding> {
    let mut out = Vec::new();
    for p in &doc.pages {
        walk(p, 0, None, cfg, Some(&doc.variables), &mut out);
    }
    out
}

/// Lint a single live tree root (the editor canvas tree, which is what the
/// app renders — `Document.pages` may lag behind while editing). Without a
/// Document there is no palette to check, so `hardcoded-color` is skipped.
pub fn lint_node(root: &Node, strict: bool) -> Vec<Finding> {
    lint_node_with(
        root,
        &LintConfig::preset(if strict {
            Preset::Strict
        } else {
            Preset::Recommended
        }),
    )
}

pub fn lint_node_with(root: &Node, cfg: &LintConfig) -> Vec<Finding> {
    let mut out = Vec::new();
    walk(root, 0, None, cfg, None, &mut out);
    out
}

/// Relative luminance per WCAG from the sRGB hex `color_to_hex` produces.
pub fn luminance(hex: &str) -> Option<f64> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let ch = |i: usize| -> Option<f64> {
        let v = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).ok()?;
        let s = v as f64 / 255.0;
        Some(if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        })
    };
    Some(0.2126 * ch(0)? + 0.7152 * ch(1)? + 0.0722 * ch(2)?)
}

pub fn contrast(a: &str, b: &str) -> Option<f64> {
    let (la, lb) = (luminance(a)?, luminance(b)?);
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    Some((hi + 0.05) / (lo + 0.05))
}

fn solid_hex(p: &Paint) -> Option<String> {
    match p {
        Paint::Solid(c) if c.components[3] > 0.0 => Some(crate::color_to_hex(*c)),
        _ => None,
    }
}

fn text_size(n: &Node) -> f64 {
    n.text_metrics
        .as_ref()
        .map(|t| if t.font_size > 0.0 { t.font_size } else { 16.0 })
        .unwrap_or(16.0)
}

fn near_int(v: f64) -> bool {
    (v - v.round()).abs() < 0.01
}

fn walk(
    n: &Node,
    depth: usize,
    parent: Option<&Node>,
    cfg: &LintConfig,
    vars: Option<&Variables>,
    out: &mut Vec<Finding>,
) {
    let is_page_root = depth == 0;
    let fire = |rule: &'static str, severity: Severity, message: String, out: &mut Vec<Finding>| {
        if cfg.wants(rule) {
            out.push(Finding {
                rule,
                severity,
                node: n.id.clone(),
                message,
            });
        }
    };
    if !is_page_root {
        // ————————————————— naming
        if n.name.trim().is_empty() {
            fire(
                "unnamed-layer",
                Severity::Warning,
                "layer has no name".into(),
                out,
            );
        } else if kind_label(n) == n.name.trim().to_uppercase() {
            fire(
                "generic-name",
                Severity::Warning,
                format!("layer is still named \"{}\"", n.name.trim()),
                out,
            );
        }
        // ————————————————— geometry
        if (n.w <= 1.0 || n.h <= 1.0) && solid_hex(&n.fill).is_some() && n.visible {
            fire(
                "zero-size",
                Severity::Error,
                format!("paints at {:.1}×{:.1}px", n.w, n.h),
                out,
            );
        }
        if depth > 12 {
            fire(
                "deep-nesting",
                Severity::Warning,
                format!("nested {depth} levels deep"),
                out,
            );
        }
        let is_container = matches!(
            &n.kind,
            NodeKind::Frame { .. } | NodeKind::Component { .. } | NodeKind::Group
        );
        if is_container && n.children.is_empty() && solid_hex(&n.fill).is_none() {
            fire(
                "empty-frame",
                Severity::Warning,
                "container has no children and no fill".into(),
                out,
            );
        }
        if !matches!(&n.kind, NodeKind::Text { .. }) && n.visible {
            let off = [n.transform.x, n.transform.y, n.w, n.h]
                .into_iter()
                .filter(|v| !near_int(*v))
                .count();
            if off > 0 {
                fire(
                    "off-grid",
                    Severity::Warning,
                    format!(
                        "{off} value(s) off the pixel grid (x={:.2} y={:.2} {:.2}×{:.2})",
                        n.transform.x, n.transform.y, n.w, n.h
                    ),
                    out,
                );
            }
        }
        // ————————————————— text
        if let NodeKind::Text { text } = &n.kind {
            let size = text_size(n);
            if size < 12.0 {
                fire(
                    "text-small",
                    Severity::Warning,
                    format!(
                        "{size:.0}px text ({})",
                        text.chars().take(24).collect::<String>()
                    ),
                    out,
                );
            }
            let need = n
                .text_metrics
                .as_ref()
                .and_then(|t| {
                    if t.line_height > 0.0 {
                        Some(t.line_height)
                    } else {
                        None
                    }
                })
                .unwrap_or(1.2)
                * size;
            let lines = n
                .text_metrics
                .as_ref()
                .map(|t| t.line_count.max(1))
                .unwrap_or(1);
            if n.h > 0.0 && n.h + 0.5 < need * lines as f64 {
                fire(
                    "text-clipped",
                    Severity::Warning,
                    format!(
                        "{:.0}px box holds {:.1}px of {}-line {:.0}px text",
                        n.h,
                        need * lines as f64,
                        lines,
                        size
                    ),
                    out,
                );
            }
            // contrast against the nearest solid-filled ancestor (page bg = white)
            if let Some(fg) = n
                .text_runs
                .first()
                .and_then(|r| r.color)
                .map(crate::color_to_hex)
                .or_else(|| solid_hex(&n.fill))
            {
                let bg = parent
                    .and_then(|p| solid_hex(&p.fill))
                    .unwrap_or_else(|| "#ffffff".to_string());
                if let Some(c) = contrast(&fg, &bg) {
                    let (rule, min) = if cfg.strict_contrast() {
                        ("aa-contrast", 4.5)
                    } else {
                        ("low-contrast", 3.0)
                    };
                    if c < min {
                        fire(
                            rule,
                            Severity::Warning,
                            format!("contrast {c:.1}:1 (needs {min}:1) on {bg}"),
                            out,
                        );
                    }
                }
            }
        }
        // ————————————————— interaction / export parity
        if !n.interactions.is_empty() && (n.w < 40.0 || n.h < 40.0) {
            fire(
                "touch-target",
                Severity::Warning,
                format!("clickable area {:.0}×{:.0}px < 40×40", n.w, n.h),
                out,
            );
        }
        if let Some(p) = parent {
            let auto = matches!(&p.kind, NodeKind::Frame { layout: Some(_) });
            let over = n.transform.x < -p.w * 1.0
                || n.transform.y < -p.h * 1.0
                || n.transform.x > p.w * 2.0
                || n.transform.y > p.h * 2.0;
            if !auto && over && p.w > 0.0 {
                fire(
                    "stray-child",
                    Severity::Warning,
                    "positioned >2× outside its parent's bounds".into(),
                    out,
                );
            }
        }
        // ————————————————— design-system adherence
        if let Some(vars) = vars {
            if !vars.colors.is_empty() {
                if let Some(hex) = solid_hex(&n.fill) {
                    let bound =
                        n.bindings.contains_key("fill") || matches!(&n.fill, Paint::Variable(_));
                    let in_palette = vars
                        .colors
                        .values()
                        .any(|c| crate::color_to_hex(*c).eq_ignore_ascii_case(&hex));
                    if !bound && !in_palette {
                        fire(
                            "hardcoded-color",
                            Severity::Warning,
                            format!(
                                "{hex} is not a variable color — bind one or add it to the palette"
                            ),
                            out,
                        );
                    }
                }
            }
        }
    }
    // duplicate sibling names: one finding per duplicated name, reported on
    // the second occurrence so the id points at a real actionable layer
    if cfg.wants("duplicate-sibling") {
        // (name, count, id of the second node using it)
        let mut tally: Vec<(String, usize, String)> = Vec::new();
        for c in &n.children {
            let name = c.name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            match tally.iter_mut().find(|e| e.0 == name) {
                Some(e) => {
                    e.1 += 1;
                    if e.2.is_empty() {
                        e.2 = c.id.clone();
                    }
                }
                None => tally.push((name, 1, String::new())),
            }
        }
        for (name, count, id) in tally {
            if count > 1 {
                out.push(Finding {
                    rule: "duplicate-sibling",
                    severity: Severity::Warning,
                    node: id,
                    message: format!(
                        "\"{name}\" used by {count} siblings of \"{}\"",
                        n.name.trim()
                    ),
                });
            }
        }
    }

    let mut hidden_count = 0usize;
    for c in &n.children {
        if !c.visible {
            hidden_count += 1;
        }
        walk(c, depth + 1, Some(n), cfg, vars, out);
    }
    if !is_page_root && hidden_count > 0 && matches!(&n.kind, NodeKind::Frame { .. }) {
        // export-parity nudge: hidden content only warns when the frame
        // itself carries export settings (it will ship without them)
        if !n.export_settings.is_empty() {
            fire(
                "hidden-in-export",
                Severity::Warning,
                format!("{hidden_count} hidden child(ren) will vanish from exports"),
                out,
            );
        }
    }
}

/// `openpencil`-style one-line rendering per finding.
pub fn render(findings: &[Finding], label: &str) -> String {
    let mut errs = 0usize;
    let mut warns = 0usize;
    let mut lines = String::new();
    for f in findings {
        match f.severity {
            Severity::Error => errs += 1,
            Severity::Warning => warns += 1,
        }
        lines.push_str(&format!(
            "  {} {} [{}]: {}\n",
            match f.severity {
                Severity::Error => "error",
                Severity::Warning => "warn ",
            },
            f.rule,
            f.node,
            f.message
        ));
    }
    let mut fired: Vec<&str> = vec![];
    for f in findings {
        if !fired.contains(&f.rule) {
            fired.push(f.rule);
        }
    }
    lines.push_str(&format!(
        "{label}: {errs} error(s), {warns} warning(s) ({} rule(s) fired)\n",
        fired.len()
    ));
    lines
}

/// One-line status for the editor's lint command.
pub fn summary_line(findings: &[Finding]) -> String {
    let mut errs = 0usize;
    let mut warns = 0usize;
    for f in findings {
        match f.severity {
            Severity::Error => errs += 1,
            Severity::Warning => warns += 1,
        }
    }
    format!("Lint: {errs} error(s), {warns} warning(s)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Color, Document, Node, TextMetrics};

    fn findings_of(doc: &Document) -> Vec<&'static str> {
        lint(doc, false).into_iter().map(|f| f.rule).collect()
    }

    fn messy_doc() -> Document {
        let mut d = Document::new();
        let mut page = Node::frame("p", 800.0, 600.0);
        page.name = "Page".into();
        let mut anon = Node::rect("", 0.0, 0.0, 50.0, 50.0, Color::BLACK);
        anon.name = String::new();
        let generic = Node::rect("g", 0.0, 0.0, 50.0, 50.0, Color::BLACK); // name "g" not generic
        let mut tiny = Node::rect("tiny", 0.0, 0.0, 0.5, 20.0, Color::BLACK);
        tiny.name = "Hairline".into();
        let mut small_text = Node::text("st", 4.0, 4.0, 60.0, 8.0, "small");
        small_text.name = "Caption".into();
        small_text.text_metrics = Some(TextMetrics {
            font_size: 8.0,
            ..Default::default()
        });
        let mut dark = Node::frame("dark", 100.0, 100.0);
        dark.name = "Frame".into(); // generic name + has children
        dark.fill = Paint::Solid(Color::BLACK);
        let mut black_on_black = Node::text("bo b", 0.0, 0.0, 50.0, 14.0, "x");
        black_on_black.name = "Ink".into();
        black_on_black.fill = Paint::Solid(Color::BLACK);
        dark.children.push(black_on_black);
        let mut button = Node::rect("btn", 0.0, 0.0, 20.0, 16.0, Color::BLACK);
        button.name = "Btn".into();
        button.interactions.push(crate::Interaction::click("p"));
        let mut twin_a = Node::rect("ta", 300.0, 0.0, 40.0, 40.0, Color::BLACK);
        twin_a.name = "Icon".into();
        let mut twin_b = Node::rect("tb", 400.0, 0.0, 40.0, 40.0, Color::BLACK);
        twin_b.name = "Icon".into();
        page.children.push(anon);
        page.children.push(generic);
        page.children.push(tiny);
        page.children.push(small_text);
        page.children.push(dark);
        page.children.push(button);
        page.children.push(twin_a);
        page.children.push(twin_b);
        let mut empty = Node::frame("empty", 20.0, 400.0);
        empty.name = "Unused".into();
        page.children.push(empty);
        d.pages.push(page);
        d
    }

    #[test]
    fn rules_fire_on_a_messy_doc() {
        let d = messy_doc();
        let rules = findings_of(&d);
        assert!(rules.contains(&"unnamed-layer"), "{rules:?}");
        assert!(rules.contains(&"zero-size"), "{rules:?}");
        assert!(rules.contains(&"text-small"), "{rules:?}");
        assert!(rules.contains(&"low-contrast"), "{rules:?}");
        assert!(rules.contains(&"touch-target"), "{rules:?}");
        assert!(rules.contains(&"duplicate-sibling"), "{rules:?}");
        // strict preset swaps the contrast rule id and adds extras
        let strict: Vec<&'static str> = lint(&d, true).into_iter().map(|f| f.rule).collect();
        assert!(
            strict.contains(&"aa-contrast") && !strict.contains(&"low-contrast"),
            "{strict:?}"
        );
        assert!(strict.contains(&"empty-frame"), "{strict:?}");
    }

    #[test]
    fn presets_gate_rule_sets() {
        let d = messy_doc();
        let ids = |c: &LintConfig| -> Vec<&'static str> {
            lint_with(&d, c).into_iter().map(|f| f.rule).collect()
        };
        let a11y = ids(&LintConfig::preset(Preset::A11y));
        assert!(a11y.contains(&"text-small"), "{a11y:?}");
        assert!(!a11y.contains(&"unnamed-layer"), "{a11y:?}");
        assert!(!a11y.contains(&"empty-frame"), "{a11y:?}");
        let all = ids(&LintConfig::preset(Preset::All));
        assert!(all.contains(&"unnamed-layer") && all.contains(&"empty-frame"));
        // skip list removes; only list restricts
        let cfg = LintConfig {
            skip: vec!["unnamed-layer".into()],
            ..Default::default()
        };
        assert!(!ids(&cfg).contains(&"unnamed-layer"));
        let cfg = LintConfig {
            only: vec!["zero-size".into()],
            ..Default::default()
        };
        assert_eq!(ids(&cfg), vec!["zero-size"]);
    }

    #[test]
    fn hardcoded_color_only_fires_against_a_palette() {
        let mut d = messy_doc();
        let cfg = LintConfig::preset(Preset::Strict);
        // no palette defined yet → nothing to compare against
        assert!(
            !lint_with(&d, &cfg)
                .into_iter()
                .any(|f| f.rule == "hardcoded-color"),
            "no palette, no palette rule"
        );
        d.variables
            .colors
            .insert("color/ink".into(), Color::from_rgb8(0, 0, 0));
        let hits: Vec<String> = lint_with(&d, &cfg)
            .into_iter()
            .filter(|f| f.rule == "hardcoded-color")
            .map(|f| f.node)
            .collect();
        // black IS the palette entry now, so only non-ink paints report
        assert!(!hits.contains(&"ta".to_string()), "{hits:?}");
        assert!(!hits.is_empty(), "{hits:?}");
    }

    #[test]
    fn rule_table_matches_preset_membership() {
        for r in rule_table() {
            // every rule must be reachable by at least one preset
            assert!(
                Preset::all().iter().any(|p| r.in_preset(*p)),
                "{} unreachable",
                r.id
            );
            assert_eq!(
                rule_severity(r.id),
                Some(r.severity),
                "{} severity mismatch",
                r.id
            );
        }
        // ids unique, and `rules()` mirror agrees
        let ids: Vec<&str> = rule_table().iter().map(|r| r.id).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ids.len(), sorted.len(), "duplicate rule ids");
        assert_eq!(rules().len(), ids.len());
        for (id, what) in rules() {
            assert!(ids.contains(id), "mirror leaked unknown id {id}");
            assert_eq!(
                rule_table().iter().find(|r| r.id == *id).unwrap().what,
                *what
            );
        }
        assert_eq!(
            unknown_rules(&["nope".into(), "zero-size".into()]),
            vec!["nope".to_string()]
        );
    }

    #[test]
    fn json_report_is_structured() {
        let d = messy_doc();
        let cfg = LintConfig::default();
        let f = lint_with(&d, &cfg);
        let js = report_json(&f, "doc.x", &cfg);
        assert!(js.contains("\"source\": \"doc.x\""), "{js}");
        assert!(js.contains("\"preset\": \"recommended\""), "{js}");
        assert!(js.contains("\"counts\": { \"error\": 1"), "{js}");
        assert!(js.contains("\"findings\": ["), "{js}");
        assert!(js.contains("\"zero-size\""), "{js}");
    }

    #[test]
    fn clean_doc_is_silent_and_render_stable() {
        let mut d = Document::new();
        let mut page = Node::frame("p", 400.0, 300.0);
        page.name = "Home".into();
        let mut r = Node::rect("hero", 20.0, 20.0, 300.0, 120.0, Color::BLACK);
        r.name = "Hero".into();
        page.children.push(r);
        d.pages.push(page);
        let f = lint(&d, false);
        assert!(
            f.is_empty(),
            "{:?}",
            f.iter().map(|x| x.rule).collect::<Vec<_>>()
        );
        let text = render(&f, "doc.x");
        assert_eq!(text, render(&lint(&d, false), "doc.x"));
        assert!(text.contains("0 error(s)"), "{text}");
        assert_eq!(summary_line(&f), "Lint: 0 error(s), 0 warning(s)");
    }

    #[test]
    fn sub_pixel_geometry_is_a_strict_only_warning() {
        let mut d = Document::new();
        let mut page = Node::frame("p", 400.0, 300.0);
        page.name = "Home".into();
        let mut r = Node::rect("r", 20.5, 20.0, 100.0, 50.0, Color::BLACK);
        r.name = "Half Pixel".into();
        page.children.push(r);
        d.pages.push(page);
        assert!(!findings_of(&d).contains(&"off-grid"));
        assert!(lint(&d, true).iter().any(|f| f.rule == "off-grid"));
    }
}
