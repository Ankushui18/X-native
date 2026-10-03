//! Design analysis + token extraction — the terminal half of a design
//! system audit (OpenPencil's `analyze` workflow, in-engine): color usage
//! histogram, type scale, spacing scale, sibling-overlap report, repeated
//! box clusters — plus one-click variable generation from the result.

use crate::{color_to_hex, Document, Node, NodeKind, Paint, Value, Variables};
use std::collections::HashMap;

/// Bump a histogram entry.
fn bump(h: &mut HashMap<String, usize>, k: String) {
    *h.entry(k).or_insert(0) += 1;
}

fn hist_pairs(h: HashMap<String, usize>, cap: usize) -> Vec<(String, usize)> {
    let mut v: Vec<(String, usize)> = h.into_iter().collect();
    // deterministic: count desc, then key asc
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v.truncate(cap);
    v
}

/// Tunables for an analysis run (CLI `--min-overlap`, `--min-cluster`, `--top`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnalyzeOptions {
    /// Sibling boxes whose intersection exceeds this fraction of the
    /// smaller box are reported as overlapping.
    pub overlap_ratio: f64,
    /// How often a (kind, w×h) shape must repeat to count as a cluster.
    pub min_cluster: usize,
    /// Per-section row cap (`0` = unlimited).
    pub top: usize,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        Self {
            overlap_ratio: 0.25,
            min_cluster: 3,
            top: 0,
        }
    }
}

impl AnalyzeOptions {
    fn cap(self, default: usize) -> usize {
        if self.top == 0 {
            default
        } else {
            self.top
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tokens {
    pub colors: Vec<(String, usize)>,
    pub font_sizes: Vec<(String, usize)>,
    pub font_families: Vec<(String, usize)>,
    pub gaps: Vec<(String, usize)>,
    pub paddings: Vec<(String, usize)>,
    pub radii: Vec<(String, usize)>,
    /// sibling boxes overlapping >25% of the smaller one: (a, b)
    pub overlaps: Vec<(String, String)>,
    /// repeated (kind, rounded w×h) shapes with count ≥ 3: (kind, w, h, count)
    pub clusters: Vec<(String, String, String, usize)>,
}

/// Analyze one live tree root (the app canvas); equivalent to running the
/// audit on a Document whose only page is `root`.
pub fn analyze_root(root: &Node) -> Tokens {
    analyze_root_with(root, &AnalyzeOptions::default())
}

/// [`analyze_root`] with explicit thresholds.
pub fn analyze_root_with(root: &Node, opts: &AnalyzeOptions) -> Tokens {
    let mut t = Tokens::default();
    let mut colors: HashMap<String, usize> = HashMap::new();
    let mut sizes: HashMap<String, usize> = HashMap::new();
    let mut families: HashMap<String, usize> = HashMap::new();
    let mut gaps: HashMap<String, usize> = HashMap::new();
    let mut pads: HashMap<String, usize> = HashMap::new();
    let mut radii: HashMap<String, usize> = HashMap::new();
    let mut clusters: HashMap<(String, String, String), usize> = HashMap::new();
    let mut overlaps: Vec<(String, String)> = Vec::new();
    walk_node(
        root,
        opts,
        &mut colors,
        &mut sizes,
        &mut families,
        &mut gaps,
        &mut pads,
        &mut radii,
        &mut clusters,
        &mut overlaps,
    );
    t.colors = hist_pairs(colors, opts.cap(40));
    t.font_sizes = hist_pairs(sizes, opts.cap(16));
    t.font_families = hist_pairs(families, opts.cap(12));
    t.gaps = hist_pairs(gaps, opts.cap(12));
    t.paddings = hist_pairs(pads, opts.cap(16));
    t.radii = hist_pairs(radii, opts.cap(12));
    overlaps.sort();
    overlaps.dedup();
    t.overlaps = overlaps.into_iter().take(opts.cap(50)).collect();
    let mut cl: Vec<(String, String, String, usize)> = clusters
        .into_iter()
        .filter(|(_, c)| *c >= opts.min_cluster.max(2))
        .map(|((k, w, h), c)| (k, w, h, c))
        .collect();
    cl.sort_by(|a, b| b.3.cmp(&a.3).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    t.clusters = cl.into_iter().take(opts.cap(20)).collect();
    t
}

/// Audit a whole document (every page) with the default thresholds.
pub fn analyze(doc: &Document) -> Tokens {
    analyze_with(doc, &AnalyzeOptions::default())
}

/// [`analyze`] with explicit thresholds.
///
/// Each page is walked with unlimited caps and the lowest cluster
/// threshold, then the per-page histograms are merged and the limits
/// applied once — so a shape that appears twice on one page and once on
/// another still reaches the cluster threshold.
pub fn analyze_with(doc: &Document, opts: &AnalyzeOptions) -> Tokens {
    let per_page = AnalyzeOptions {
        top: 0,
        min_cluster: 2,
        ..*opts
    };
    let mut acc = Tokens::default();
    for p in &doc.pages {
        acc.merge_with(analyze_root_with(p, &per_page));
    }
    acc.apply(opts);
    acc
}

fn fmt_num(v: f64) -> String {
    let r = (v * 100.0).round() / 100.0;
    if (r - r.trunc()).abs() < f64::EPSILON {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

fn solid(p: &Paint) -> Option<String> {
    match p {
        Paint::Solid(c) if c.components[3] > 0.0 => Some(color_to_hex(*c)),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn walk_node(
    n: &Node,
    opts: &AnalyzeOptions,
    colors: &mut HashMap<String, usize>,
    sizes: &mut HashMap<String, usize>,
    families: &mut HashMap<String, usize>,
    gaps: &mut HashMap<String, usize>,
    pads: &mut HashMap<String, usize>,
    radii: &mut HashMap<String, usize>,
    clusters: &mut HashMap<(String, String, String), usize>,
    overlaps: &mut Vec<(String, String)>,
) {
    if !n.visible {
        return;
    }
    if let Some(hex) = solid(&n.fill) {
        bump(colors, hex);
    }
    match &n.kind {
        NodeKind::Text { .. } => {
            let size = n
                .text_metrics
                .as_ref()
                .map(|t| if t.font_size > 0.0 { t.font_size } else { 16.0 })
                .unwrap_or(16.0);
            bump(sizes, format!("{}px", fmt_num(size)));
            if let Some(f) = n.bindings.get("font") {
                bump(families, f.clone());
            }
        }
        NodeKind::Frame { layout: Some(l) } => {
            if l.gap > 0.0 {
                bump(gaps, fmt_num(l.gap));
            }
            // one count per distinct value per frame (16 16 16 16 = one
            // "16" token, not four)
            let mut seen: Vec<String> = Vec::new();
            for pv in l.padding {
                let k = fmt_num(pv);
                if pv > 0.0 && !seen.contains(&k) {
                    seen.push(k.clone());
                    bump(pads, k);
                }
            }
        }
        _ => {}
    }
    if let Some([a, b, c, d]) = n.corner_radii {
        if a > 0.0 && a == b && b == c && c == d {
            bump(radii, fmt_num(a));
        }
    }
    if !matches!(
        n.kind,
        NodeKind::Frame { .. } | NodeKind::Group | NodeKind::Section
    ) {
        let key = (
            crate::query::kind_label(n).to_string(),
            fmt_num(n.w.round()),
            fmt_num(n.h.round()),
        );
        *clusters.entry(key).or_insert(0) += 1;
    }
    // sibling overlap scan (both visible, painted, overlapping boxes)
    for i in 0..n.children.len() {
        for j in i + 1..n.children.len() {
            let (a, b) = (&n.children[i], &n.children[j]);
            if !a.visible || !b.visible {
                continue;
            }
            let ax0 = a.transform.x;
            let ax1 = ax0 + a.w;
            let ay0 = a.transform.y;
            let ay1 = ay0 + a.h;
            let bx0 = b.transform.x;
            let bx1 = bx0 + b.w;
            let by0 = b.transform.y;
            let by1 = by0 + b.h;
            let ix = (ax1.min(bx1) - ax0.max(bx0)).max(0.0);
            let iy = (ay1.min(by1) - ay0.max(by0)).max(0.0);
            let inter = ix * iy;
            let smaller = (a.w * a.h).min(b.w * b.h);
            if smaller > 0.0 && inter / smaller > opts.overlap_ratio {
                let (mut x, mut y) = (a.id.clone(), b.id.clone());
                if x > y {
                    std::mem::swap(&mut x, &mut y);
                }
                overlaps.push((x, y));
            }
        }
    }
    for c in &n.children {
        walk_node(
            c, opts, colors, sizes, families, gaps, pads, radii, clusters, overlaps,
        );
    }
}

impl Tokens {
    /// Human report (CLI `analyze` output).
    pub fn render(&self) -> String {
        let mut o = String::new();
        if !self.colors.is_empty() {
            o.push_str("colors:\n");
            for (hex, c) in &self.colors {
                let bar = "█".repeat((*c).clamp(1, 30));
                o.push_str(&format!("  {hex}  {bar} {c}×\n"));
            }
        }
        if !self.font_sizes.is_empty() {
            o.push_str("type scale:\n");
            for (sz, c) in &self.font_sizes {
                o.push_str(&format!("  {sz} {c}×\n"));
            }
        }
        if !self.font_families.is_empty() {
            o.push_str("families:\n");
            for (f, c) in &self.font_families {
                o.push_str(&format!("  {f} {c}×\n"));
            }
        }
        if !self.gaps.is_empty() {
            o.push_str("spacing (gaps):\n");
            for (g, c) in &self.gaps {
                o.push_str(&format!("  {g}px {c}×\n"));
            }
        }
        if !self.paddings.is_empty() {
            o.push_str("spacing (padding):\n");
            for (g, c) in &self.paddings {
                o.push_str(&format!("  {g}px {c}×\n"));
            }
        }
        if !self.radii.is_empty() {
            o.push_str("radii:\n");
            for (r, c) in &self.radii {
                o.push_str(&format!("  {r}px {c}×\n"));
            }
        }
        if !self.clusters.is_empty() {
            o.push_str("clusters (repeated boxes):\n");
            for (kind, w, h, c) in &self.clusters {
                o.push_str(&format!("  {c}× {kind} {w}×{h}\n"));
            }
        }
        if !self.overlaps.is_empty() {
            o.push_str("overlapping siblings:\n");
            for (a, b) in &self.overlaps {
                o.push_str(&format!("  {a} ↔ {b}\n"));
            }
        }
        if o.is_empty() {
            o.push_str("nothing to report — document is empty\n");
        }
        o
    }

    /// Sum another run's histograms into this one (same-key counts add;
    /// overlap pairs union). Used to fold per-page results together.
    pub fn merge_with(&mut self, other: Tokens) {
        fn add(dst: &mut Vec<(String, usize)>, src: Vec<(String, usize)>) {
            for (k, v) in src {
                match dst.iter_mut().find(|e| e.0 == k) {
                    Some(e) => e.1 += v,
                    None => dst.push((k, v)),
                }
            }
        }
        add(&mut self.colors, other.colors);
        add(&mut self.font_sizes, other.font_sizes);
        add(&mut self.font_families, other.font_families);
        add(&mut self.gaps, other.gaps);
        add(&mut self.paddings, other.paddings);
        add(&mut self.radii, other.radii);
        for (kind, w, h, c) in other.clusters {
            match self
                .clusters
                .iter_mut()
                .find(|e| e.0 == kind && e.1 == w && e.2 == h)
            {
                Some(e) => e.3 += c,
                None => self.clusters.push((kind, w, h, c)),
            }
        }
        for o in other.overlaps {
            if !self.overlaps.contains(&o) {
                self.overlaps.push(o);
            }
        }
    }

    /// Sort, threshold and cap every section — the last step of a run.
    pub fn apply(&mut self, opts: &AnalyzeOptions) {
        fn order(v: &mut Vec<(String, usize)>, cap: usize) {
            v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            if cap > 0 {
                v.truncate(cap);
            }
        }
        order(&mut self.colors, opts.cap(40));
        order(&mut self.font_sizes, opts.cap(16));
        order(&mut self.font_families, opts.cap(12));
        order(&mut self.gaps, opts.cap(12));
        order(&mut self.paddings, opts.cap(16));
        order(&mut self.radii, opts.cap(12));
        self.overlaps.sort();
        self.overlaps.dedup();
        if opts.cap(50) > 0 {
            self.overlaps.truncate(opts.cap(50));
        }
        self.clusters
            .retain(|(_, _, _, c)| *c >= opts.min_cluster.max(2));
        self.clusters.sort_by(|a, b| {
            b.3.cmp(&a.3)
                .then(a.0.cmp(&b.0))
                .then(a.1.cmp(&b.1))
                .then(a.2.cmp(&b.2))
        });
        if opts.cap(20) > 0 {
            self.clusters.truncate(opts.cap(20));
        }
    }

    /// Copy limited to one report section, so the CLI, the MCP server and
    /// the app panel all agree on what "colors" or "spacing" means.
    /// `None` for an unknown section name.
    pub fn section(&self, name: &str) -> Option<Tokens> {
        let clear_everything_but = |keep: &str| -> Option<Tokens> {
            let mut sub = self.clone();
            if keep != "colors" {
                sub.colors.clear();
            }
            if keep != "type" {
                sub.font_sizes.clear();
                sub.font_families.clear();
            }
            if keep != "spacing" {
                sub.gaps.clear();
                sub.paddings.clear();
                sub.radii.clear();
            }
            if keep != "overlaps" {
                sub.overlaps.clear();
            }
            if keep != "clusters" {
                sub.clusters.clear();
            }
            Some(sub)
        };
        match name {
            "all" => Some(self.clone()),
            "colors" => clear_everything_but("colors"),
            "type" | "typography" => clear_everything_but("type"),
            "spacing" => clear_everything_but("spacing"),
            "overlaps" => clear_everything_but("overlaps"),
            "clusters" => clear_everything_but("clusters"),
            _ => None,
        }
    }

    /// `true` when the audit found nothing at all (empty document).
    pub fn is_empty(&self) -> bool {
        self.colors.is_empty()
            && self.font_sizes.is_empty()
            && self.font_families.is_empty()
            && self.gaps.is_empty()
            && self.paddings.is_empty()
            && self.radii.is_empty()
            && self.overlaps.is_empty()
            && self.clusters.is_empty()
    }

    /// Machine-readable form (`x_native analyze --json`). Key order is
    /// fixed so output can be diffed in tests and CI.
    pub fn to_json(&self) -> String {
        self.to_json_with(&[])
    }

    /// [`to_json`] with extra top-level sections appended verbatim, e.g.
    /// `("adoption", &adoption.to_json())`. One writer owns the enclosing
    /// braces, so callers cannot produce unbalanced JSON.
    pub fn to_json_with(&self, extra: &[(&str, &str)]) -> String {
        let mut tail = String::new();
        for (key, json) in extra {
            tail.push_str(&format!(", {}: {}", quoted(key), json));
        }
        fn pairs(v: &[(String, usize)]) -> String {
            v.iter()
                .map(|(k, c)| format!("[{}, {}]", quoted(k), c))
                .collect::<Vec<_>>()
                .join(", ")
        }
        format!(
            r#"{{ "total": {{"colors": {cn}, "text": {tn}, "overlaps": {on}, "clusters": {cln}}}, "colors": [{colors}], "font_sizes": [{sizes}], "font_families": [{fams}], "gaps": [{gaps}], "paddings": [{pads}], "radii": [{radii}], "overlaps": [{ov}], "clusters": [{cl}]{tail} }}"#,
            cn = self.colors.len(),
            tn = self.font_sizes.len(),
            on = self.overlaps.len(),
            cln = self.clusters.len(),
            colors = pairs(&self.colors),
            sizes = pairs(&self.font_sizes),
            fams = pairs(&self.font_families),
            gaps = pairs(&self.gaps),
            pads = pairs(&self.paddings),
            radii = pairs(&self.radii),
            ov = self
                .overlaps
                .iter()
                .map(|(a, b)| format!("[{}, {}]", quoted(a), quoted(b)))
                .collect::<Vec<_>>()
                .join(", "),
            cl = self
                .clusters
                .iter()
                .map(|(k, w, h, c)| {
                    format!("[{}, {}, {}, {}]", quoted(k), quoted(w), quoted(h), c)
                })
                .collect::<Vec<_>>()
                .join(", "),
            tail = tail,
        )
    }

    /// Define one variable per top token, typed the way a design system
    /// expects: colors become real **color** variables (`color/<hex>`),
    /// type sizes, spacing and radii become **number** variables
    /// (`text/<size>`, `space/<v>`, `radius/<v>`), so the extracted palette
    /// is bindable in the picker, drives auto layout and survives the DTCG
    /// export as `$type: color` / `$type: number`.
    ///
    /// Returns how many NEW variables were created; existing names are
    /// left alone, so re-running only adds the missing tail.
    pub fn emit_variables(&self, vars: &mut Variables) -> usize {
        let mut added = 0usize;
        let mut define = |name: String, kind: &str, value: &str| {
            if vars.get(&name).is_some() {
                return;
            }
            let ok = match kind {
                "color" => match hex_color(value) {
                    Some(c) => {
                        vars.colors.insert(name.clone(), c);
                        true
                    }
                    None => false,
                },
                "number" => match num_of(value) {
                    Some(n) => {
                        vars.numbers.insert(name.clone(), n);
                        true
                    }
                    None => false,
                },
                _ => {
                    vars.strings.insert(name.clone(), value.to_string());
                    true
                }
            };
            if ok {
                vars.collections
                    .entry(name)
                    .or_insert_with(|| "Tokens".to_string());
                added += 1;
            }
        };
        for (hex, _) in self.colors.iter().take(12) {
            define(
                format!("color/{}", hex.trim_start_matches('#')),
                "color",
                hex,
            );
        }
        for (sz, _) in self.font_sizes.iter().take(8) {
            define(format!("text/{}", sz.replace("px", "")), "number", sz);
        }
        let mut spaces: Vec<String> = Vec::new();
        for (g, _) in &self.gaps {
            if !spaces.contains(g) {
                spaces.push(g.clone());
            }
        }
        for (p, _) in &self.paddings {
            if !spaces.contains(p) {
                spaces.push(p.clone());
            }
        }
        for sp in spaces.into_iter().take(10) {
            define(format!("space/{sp}"), "number", &sp);
        }
        for (r, _) in self.radii.iter().take(8) {
            define(format!("radius/{r}"), "number", r);
        }
        added
    }
}

/// JSON string literal, escaped with the shared query escaper.
fn quoted(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    o.push_str(&crate::query::esc_str(s));
    o.push('"');
    o
}

/// Parse a CSS-ish hex color (`#rgb`, `#rrggbb`, `#rrggbbaa`). The lint and
/// analyze engines both round-trip colors through hex strings, so this is
/// the inverse of `color_to_hex`.
pub fn hex_color(hex: &str) -> Option<crate::Color> {
    let h = hex.trim_start_matches('#');
    let mut v: Vec<u8> = Vec::with_capacity(4);
    if h.len() == 3 {
        for c in h.chars() {
            v.push((c.to_digit(16)? * 17) as u8);
        }
    } else if h.len() == 6 || h.len() == 8 {
        let b = h.as_bytes();
        let mut i = 0;
        while i + 1 < b.len() {
            let s = std::str::from_utf8(&b[i..i + 2]).ok()?;
            v.push(u8::from_str_radix(s, 16).ok()?);
            i += 2;
        }
    } else {
        return None;
    }
    if v.len() < 3 {
        return None;
    }
    Some(crate::Color::from_rgba8(
        v[0],
        v[1],
        v[2],
        v.get(3).copied().unwrap_or(255),
    ))
}

/// `16px` or `16` to a number (token keys carry the unit for humans).
fn num_of(s: &str) -> Option<f64> {
    s.trim().trim_end_matches("px").trim().parse::<f64>().ok()
}

/// Design-system adoption: how much of the document is driven by variables
/// and which defined variables are dead weight. A palette nobody binds is
/// the most common failure mode of "we have tokens" claims, so the audit
/// reports it next to the histograms.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Adoption {
    /// Nodes that could carry a binding (painted layers).
    pub nodes: usize,
    /// Of those, how many actually do.
    pub bound_nodes: usize,
    /// Variables defined in the document.
    pub defined: usize,
    /// Defined variables referenced by at least one node.
    pub used: Vec<String>,
    /// Defined variables referenced by nothing.
    pub unused: Vec<String>,
}

impl Adoption {
    /// Share of paintable nodes carrying at least one binding (0.0..=1.0).
    pub fn coverage(&self) -> f64 {
        if self.nodes == 0 {
            0.0
        } else {
            self.bound_nodes as f64 / self.nodes as f64
        }
    }

    pub fn render(&self) -> String {
        let mut o = String::new();
        o.push_str(&format!(
            "adoption: {}/{} painted layers bound ({}%), {} variable(s) defined, {} used\n",
            self.bound_nodes,
            self.nodes,
            (self.coverage() * 100.0).round() as i64,
            self.defined,
            self.used.len()
        ));
        if !self.unused.is_empty() {
            o.push_str(&format!("unused variables: {}\n", self.unused.join(", ")));
        }
        o
    }

    pub fn to_json(&self) -> String {
        format!(
            r#"{{ "nodes": {n}, "bound_nodes": {b}, "coverage": {c:.4}, "defined": {d}, "used": [{u}], "unused": [{x}] }}"#,
            n = self.nodes,
            b = self.bound_nodes,
            c = self.coverage(),
            d = self.defined,
            u = self
                .used
                .iter()
                .map(|s| quoted(s))
                .collect::<Vec<_>>()
                .join(", "),
            x = self
                .unused
                .iter()
                .map(|s| quoted(s))
                .collect::<Vec<_>>()
                .join(", "),
        )
    }
}

/// Adoption of a whole document (all pages, its own variables).
pub fn adoption(doc: &Document) -> Adoption {
    let mut refs: Vec<String> = Vec::new();
    let mut nodes = 0usize;
    let mut bound = 0usize;
    for p in &doc.pages {
        scan_bindings(p, &mut refs, &mut nodes, &mut bound, true);
    }
    finish(&doc.variables, refs, nodes, bound)
}

/// Adoption of one live tree root (the editor canvas) against a variable
/// table — the in-app variant of [`adoption`].
pub fn adoption_root(root: &Node, vars: &Variables) -> Adoption {
    let mut refs: Vec<String> = Vec::new();
    let mut nodes = 0usize;
    let mut bound = 0usize;
    scan_bindings(root, &mut refs, &mut nodes, &mut bound, false);
    finish(vars, refs, nodes, bound)
}

fn finish(vars: &Variables, refs: Vec<String>, nodes: usize, bound: usize) -> Adoption {
    let mut defined: Vec<String> = Vec::new();
    defined.extend(vars.colors.keys().cloned());
    defined.extend(vars.numbers.keys().cloned());
    defined.extend(vars.strings.keys().cloned());
    defined.extend(vars.bools.keys().cloned());
    defined.sort();
    defined.dedup();
    let mut a = Adoption {
        nodes,
        bound_nodes: bound,
        defined: defined.len(),
        ..Default::default()
    };
    for name in defined {
        // an alias is load-bearing even when no node names its source, so
        // both sides of `aliases[src] = target` count as used
        let referenced = refs.contains(&name)
            || vars.aliases.contains_key(&name)
            || refs
                .iter()
                .any(|r| vars.aliases.get(r).map(String::as_str) == Some(name.as_str()));
        if referenced {
            a.used.push(name);
        } else {
            a.unused.push(name);
        }
    }
    a
}

/// Walk one tree collecting variable references; `skip_root` ignores the
/// page frame itself when scanning pages.
fn scan_bindings(
    n: &Node,
    refs: &mut Vec<String>,
    nodes: &mut usize,
    bound: &mut usize,
    is_root: bool,
) {
    let mut mine: Vec<String> = Vec::new();
    for v in n.bindings.values() {
        mine.push(v.clone());
    }
    push_paint_var(&n.fill, &mut mine);
    push_paint_var(&n.stroke.paint, &mut mine);
    for l in &n.fill_layers {
        push_paint_var(&l.paint, &mut mine);
    }
    for l in &n.stroke_layers {
        push_paint_var(&l.stroke.paint, &mut mine);
    }
    if let NodeKind::Frame {
        layout: Some(layout),
    } = &n.kind
    {
        if let Some(g) = &layout.gap_var {
            mine.push(g.clone());
        }
        if let Some(p) = &layout.padding_var {
            mine.push(p.clone());
        }
    }
    let paintable = !matches!(n.kind, NodeKind::Group);
    if paintable && !is_root {
        *nodes += 1;
        if !mine.is_empty() {
            *bound += 1;
        }
    }
    refs.extend(mine);
    for c in &n.children {
        scan_bindings(c, refs, nodes, bound, false);
    }
}

fn push_paint_var(p: &Paint, out: &mut Vec<String>) {
    if let Paint::Variable(name) = p {
        out.push(name.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AutoLayout, Color, Document, LayoutDirection, Node, NodeKind, Sizing, TextMetrics,
        Variables,
    };

    fn doc() -> Document {
        let mut d = Document::new();
        let mut page = Node::frame("p", 800.0, 600.0);
        page.name = "Page".into();
        for i in 0..3 {
            let mut r = Node::rect(
                &format!("r{i}"),
                i as f64 * 30.0,
                0.0,
                100.0,
                100.0,
                Color::from_rgb8(0x11, 0x22, 0x33),
            );
            r.name = format!("Rect {i}");
            page.children.push(r);
        }
        for (i, size) in [14.0, 14.0, 20.0].iter().enumerate() {
            let mut t = Node::text(
                &format!("t{i}"),
                0.0,
                200.0 + i as f64 * 30.0,
                60.0,
                *size,
                "x",
            );
            t.name = "Label".into();
            t.text_metrics = Some(TextMetrics {
                font_size: *size,
                ..Default::default()
            });
            t.fill = Paint::Solid(Color::from_rgb8(0x11, 0x22, 0x33));
            page.children.push(t);
        }
        let mut row = Node::frame("row", 300.0, 60.0);
        row.name = "Row".into();
        row.transform.y = 400.0;
        row.kind = NodeKind::Frame {
            layout: Some(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 8.0,
                padding: [16.0; 4],
                sizing: Sizing::Fixed,
                ..Default::default()
            }),
        };
        let mut rounded = Node::rect("c1", 0.0, 0.0, 60.0, 40.0, Color::from_rgb8(0, 0, 0));
        rounded.name = "Chip".into();
        rounded.corner_radii = Some([8.0; 4]);
        row.children.push(rounded);
        // overlapping siblings
        let mut o1 = Node::rect("o1", 0.0, 500.0, 100.0, 100.0, Color::from_rgb8(1, 1, 1));
        o1.name = "O1".into();
        let mut o2 = Node::rect("o2", 30.0, 520.0, 100.0, 90.0, Color::from_rgb8(2, 2, 2));
        o2.name = "O2".into();
        page.children.push(o1);
        page.children.push(o2);
        page.children.push(row);
        d.pages.push(page);
        d
    }

    #[test]
    fn histograms_count_usage() {
        let t = analyze(&doc());
        assert_eq!(t.colors[0], ("#112233".into(), 6), "{:?}", t.colors);
        assert!(
            t.font_sizes.contains(&("14px".into(), 2)),
            "{:?}",
            t.font_sizes
        );
        assert!(t.gaps.contains(&("8".into(), 1)), "{:?}", t.gaps);
        assert!(t.paddings.contains(&("16".into(), 1)), "{:?}", t.paddings);
        assert!(t.radii.contains(&("8".into(), 1)), "{:?}", t.radii);
        assert!(
            t.overlaps.contains(&("o1".into(), "o2".into())),
            "{:?}",
            t.overlaps
        );
        // four identical 100×100 rects cluster (three siblings + o1)
        assert!(
            t.clusters
                .iter()
                .any(|(k, w, h, c)| k == "RECT" && w == "100" && h == "100" && *c == 4),
            "{:?}",
            t.clusters
        );
    }

    #[test]
    fn emit_variables_is_idempotent() {
        let t = analyze(&doc());
        let mut vars = Variables::default();
        let n1 = t.emit_variables(&mut vars);
        assert!(n1 >= 3, "{n1}");
        let n2 = t.emit_variables(&mut vars);
        assert_eq!(n2, 0, "second run adds nothing");
        let text = t.render();
        assert!(
            text.contains("colors:") && text.contains("type scale:"),
            "{text}"
        );
    }
    #[test]
    fn emitted_variables_are_typed_and_grouped() {
        let t = analyze(&doc());
        let mut vars = Variables::default();
        t.emit_variables(&mut vars);
        // colors land in the color table (bindable in the picker), not as
        // strings, and sizes/spacing/radii are numbers (DTCG $type:number)
        assert_eq!(
            vars.color("color/112233", crate::Color::TRANSPARENT),
            crate::Color::from_rgb8(0x11, 0x22, 0x33)
        );
        assert_eq!(vars.number("space/16", -1.0), 16.0);
        assert_eq!(vars.number("space/8", -1.0), 8.0);
        assert_eq!(vars.number("radius/8", -1.0), 8.0);
        assert_eq!(vars.number("text/14", -1.0), 14.0);
        let kinds: Vec<&'static str> = vars
            .catalog()
            .into_iter()
            .filter(|(_, n, _)| n.starts_with("color/"))
            .map(|(_, _, k)| k)
            .collect();
        assert_eq!(kinds.len(), 4, "{kinds:?}");
        assert!(
            kinds.iter().all(|k| *k == "color"),
            "palette vars must be colors: {kinds:?}"
        );
        for (_, name, _) in vars.catalog() {
            assert_eq!(vars.collection_of(&name), "Tokens", "{name}");
        }
    }

    #[test]
    fn json_report_has_every_section() {
        let t = analyze(&doc());
        let js = t.to_json();
        assert!(
            js.starts_with(r#"{ "total": {"colors": 4, "text": 2, "overlaps": 4, "clusters": 1}"#,),
            "{js}"
        );
        for key in [
            "\"colors\": [",
            "\"font_sizes\": [",
            "\"font_families\": [",
            "\"gaps\": [",
            "\"paddings\": [",
            "\"radii\": [",
            "\"overlaps\": [",
            "\"clusters\": [",
        ] {
            assert!(js.contains(key), "missing {key} in {js}");
        }
        assert!(js.contains("[\"o1\", \"o2\"]"), "{js}");
    }

    #[test]
    fn options_tune_thresholds_and_caps() {
        let d = doc();
        // a stricter overlap floor drops the pair the default caught
        let strict = analyze_with(
            &d,
            &AnalyzeOptions {
                overlap_ratio: 0.9,
                ..Default::default()
            },
        );
        assert!(strict.overlaps.is_empty(), "{:?}", strict.overlaps);
        // a higher cluster floor drops the 4×100px group? no: it needs 5
        let cl = analyze_with(
            &d,
            &AnalyzeOptions {
                min_cluster: 5,
                ..Default::default()
            },
        );
        assert!(cl.clusters.is_empty(), "{:?}", cl.clusters);
        // --top caps each histogram
        let top1 = analyze_with(
            &d,
            &AnalyzeOptions {
                top: 1,
                ..Default::default()
            },
        );
        assert_eq!(top1.colors.len(), 1, "{:?}", top1.colors);
        assert_eq!(top1.font_sizes.len(), 1, "{:?}", top1.font_sizes);
    }

    #[test]
    fn adoption_counts_bindings_and_dead_variables() {
        let mut d = doc();
        let a = adoption(&d);
        assert!(a.nodes >= 6, "{a:?}");
        assert_eq!(a.bound_nodes, 0, "nothing bound yet");
        assert_eq!(a.defined, 0);
        // define a palette, bind one node to it
        let t = analyze(&d);
        t.emit_variables(&mut d.variables);
        let unused_after_bind = {
            let page = &mut d.pages[0];
            page.children[0].fill = Paint::Variable("color/112233".into());
            page.children[0]
                .bindings
                .insert("w".into(), "space/16".into());
            adoption(&d)
        };
        assert_eq!(unused_after_bind.bound_nodes, 1, "{unused_after_bind:?}");
        assert!(
            unused_after_bind.used.contains(&"color/112233".to_string()),
            "{:?}",
            unused_after_bind.used
        );
        assert!(
            unused_after_bind.unused.contains(&"radius/8".to_string()),
            "{:?}",
            unused_after_bind.unused
        );
        assert!(unused_after_bind.coverage() > 0.0);
        let js = unused_after_bind.to_json();
        assert!(js.contains("\"bound_nodes\": 1"), "{js}");
        assert!(js.contains("\"coverage\": 0.1"), "{js}");
        assert!(unused_after_bind.render().contains("adoption: 1/"));
    }
}
