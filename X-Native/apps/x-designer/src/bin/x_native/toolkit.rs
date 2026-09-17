//! `x_native` headless design toolkit: inspect, find, lint, analyze, codegen,
//! convert, validate. One module so the CLI surface (flags, help text, exit
//! codes) is specified in exactly one place.
//!
//! ## Exit codes
//!
//! | code | meaning                                                   |
//! |------|-----------------------------------------------------------|
//! | 0    | success                                                   |
//! | 1    | I/O or parse failure (unreadable / corrupt input)         |
//! | 2    | usage error (unknown verb, bad flag, missing operand)     |
//! | 3    | `find` matched nothing                                      |
//! | 4    | `lint` found errors at or above `--fail-on` (default)      |
//! | 5    | `validate` round-trip mismatch (file does not survive save)|

use std::collections::{BTreeSet, HashMap};

use x_native::{lint_report_json, lint_summary, FindFilter, LintConfig, LintPreset, Node};

/// Verbs owned by this module.
pub const VERBS: &[&str] = &[
    "tree",
    "find",
    "node",
    "info",
    "lint",
    "analyze",
    "export-jsx",
    "export",
    "tokens",
    "convert",
    "validate",
    "theme",
];

pub fn is_toolkit(verb: &str) -> bool {
    VERBS.contains(&verb)
}

pub const SUMMARY: &str = r#"x_native — headless design toolkit (engine self-test runs with no arguments)

USAGE:
  x_native <verb> [file.(x|fig|svg|json|sketch|png)] [options]

INSPECT
  tree     <file>                     indented layer tree
           [--depth N] [--json]
  find     <file>                     filter layers
           [--type KIND] [--name SUB] [--name-is NAME] [--id ID]
           [--under NODE] [--min-w N] [--min-h N] [--max-w N] [--max-h N]
           [--visible] [--static] [--limit N] [--json]
  node     <file> <id>                 one node as JSON (children to --depth)
           [--depth N]
  info     <file>                     document statistics [--json]

AUDIT
  lint     <file>                     rule-based design lint
           [--preset recommended|strict|a11y|all] [--strict]
           [--rule ID]... [--ignore ID]... [--list-rules] [--quiet]
           [--fail-on error|warning|never] [--json]
  analyze  <file> [section]           design-token extraction + audit
           [section: colors|type|spacing|overlaps|clusters|adoption]
           [--top N] [--min-overlap F] [--min-cluster N] [--json]
           [--emit-variables OUT.x]

SHIP
  export-jsx <file>                   JSX/React markup from the style model
           [--tailwind | --style tailwind] [-o OUT.jsx]
  export   <file> -f FORMAT           jsx | tailwind | svg | tokens
           [-o OUT]
  tokens   <file>                     W3C DTCG tokens.json from the variables
           [-o OUT.json]
  convert  <in> <out.(x|svg)>         re-serialize any supported input
  validate <file>                     load → save → load integrity check
  theme    audit|tokens               the UI palettes the app paints with
           [--theme ID] [--json] [-o OUT.json]

OTHER VERBS
  x_native import-fig <file.fig> [out.x]     Figma binary → .x (+ report)
  x_native export-html <file.x> <outdir>     static site: index.html,
           [--optimize] [--fonts]             styles.css, subset webfonts
  x_native mcp [file.x]                       MCP server on stdio (JSON-RPC)

EXAMPLES
  x_native tree design.fig                       inspect an imported file
  x_native lint design.x --preset a11y --json    CI gate for contrast/size
  x_native analyze design.x --emit-variables v.x  palette → typed variables
  x_native export design.x -f tailwind -o App.jsx  code, straight to a file
  x_native validate design.x                     format round-trip integrity

Run `x_native <verb> --help` for per-verb options.
Exit codes: 0 ok · 1 I/O or missing node · 2 usage · 3 no match (find)
            4 lint findings / contrast failures · 5 round-trip mismatch
"#;

/// Per-verb help. Kept next to the parser so the two cannot drift apart.
/// Unknown verbs fall back to the summary, so `--help` never errors.
fn verb_help(verb: &str) -> &'static str {
    match verb {
        "tree" => {
            r#"tree <file> [--depth N] [--json]

Prints the layer tree, one node per line, with child index, kind label,
quoted name and id. --depth truncates at that level; --json emits an array
of the same lines for scripting.
"#
        }
        "find" => {
            r#"find <file> [filters] [--json]

Every filter is optional and filters combine with AND. Kinds are matched
case-insensitively against the tree vocabulary (FRAME, RECT, TEXT, IMAGE,
ELLIPSE, VECTOR, GROUP, COMPONENT, INSTANCE, …).

  --type KIND        node kind
  --name SUB         case-insensitive substring of the layer name
  --name-is NAME     exact layer name (replaces --name)
  --id ID            exact node id
  --under NODE       search only inside this node's subtree
  --min-w/--min-h    smallest accepted size (finds real content)
  --max-w/--max-h    largest accepted size (finds stray 1px lines)
  --visible          skip hidden layers
  --static           skip layers that carry a prototype interaction
  --limit N          stop after N hits
"#
        }
        "node" => {
            r#"node <file> <id> [--depth N]

Prints the node and its children as JSON (default depth 3). Exits 1 when no
node carries that id.
"#
        }
        "info" => {
            r#"info <file> [--json]

Pages, nodes, frames, texts, images, components, instances, auto-layout
frames, interactions, assets and variables — the counts a CI job asserts on.
"#
        }
        "lint" => {
            r#"lint <file> [options]

Deterministic rules over the tree. Presets select the rule set:

  recommended (default)  naming, invisible geometry, small/low-contrast
                         text, touch targets, nesting, stray children,
                         hidden content in exporting frames, duplicate names
  strict                 recommended minus the 3:1 contrast rule, plus
                         WCAG AA contrast, sub-pixel geometry, empty
                         containers and palette adherence
  a11y                   accessibility rules only
  all                    every rule

  --rule ID              run only this rule (repeatable; overrides preset)
  --ignore ID            never run this rule (repeatable)
  --list-rules           print the rule table and exit (no input file needed)
  --quiet                summary line only
  --fail-on LEVEL        error (default) | warning | never
  --json                 structured report: counts, rules fired, findings

Exit code 4 when findings at or above --fail-on exist.
"#
        }
        "analyze" => {
            r#"analyze <file> [section] [options]

Extracts the design system actually used: color histogram, type scale, font
families, gaps, padding, radii, repeated box clusters and overlapping
siblings — plus adoption (how much is bound to variables and which
variables are dead).

  section        colors | type | spacing | overlaps | clusters | adoption
  --top N        cap each histogram at N rows
  --min-overlap F  overlap report threshold, fraction of the smaller box
  --min-cluster N  repetition count that qualifies as a cluster
  --json         machine-readable report
  --emit-variables OUT.x  write a copy of the document with one typed
                          variable per extracted token (color/…, text/…,
                          space/…, radius/…); re-runs only add the tail
"#
        }
        "export-jsx" => {
            r#"export-jsx <file> [--tailwind] [-o OUT.jsx]

Generates JSX from the same style model the Code panel uses: auto-layout
frames become flex containers, absolute children keep their offsets, and
--tailwind emits arbitrary-value Tailwind classes instead of inline styles.
"#
        }
        "export" => {
            r#"export <file> -f FORMAT [-o OUT]

  -f jsx        JSX with inline styles
  -f tailwind   JSX with Tailwind classes
  -f svg        vector SVG of the first page
  -f tokens     W3C DTCG tokens.json from the document variables
Without -o the payload is written to stdout.
"#
        }
        "tokens" => {
            r#"tokens <file> [-o OUT.json]

Serializes the document variables as W3C Design Tokens (DTCG): colors become
$type:color, numbers $type:number, aliases become { "id": … } references,
modes become $themes entries.
"#
        }
        "theme" => {
            r#"theme audit [--theme ID] [--json]
theme tokens [--theme ID] [-o OUT.json]

The UI themes ship inside the tool as semantic color roles, so they can be
audited and exported like any design file. IDs: graphite (dark, default),
daylight (light), high-contrast. `audit` checks every text role against every
surface it can be painted on, plus labels on accent fills and the two
indicator rings, using the WCAG 2.1 contrast formula (4.5:1 text, 3:1 UI
indicators). `tokens` writes the palette as W3C DTCG JSON: import it as
variables and a design file tracks the app theme.

Exit code 4 means at least one pair is below its floor; 0 means the palette
is AA-clean. No file argument is needed — this reads the shipped palettes.
"#
        }
        "convert" => {
            r#"convert <in> <out.x|out.svg>

Reads any supported input (.x, .fig, .svg, .json, .sketch, .png) and writes a
normalized .x document or (for the first page) an SVG.
"#
        }
        "validate" => {
            r#"validate <file>

Loads the document, re-serializes it, loads that again and compares the
structural stats. Exit code 5 (with a diff on stderr) means the format
round-trip lost content — the check a release pipeline wants.
"#
        }
        _ => SUMMARY,
    }
}

pub fn print_help(verb: Option<&str>) -> i32 {
    match verb {
        Some(v) => print!("{}", verb_help(v)),
        None => print!("{SUMMARY}"),
    }
    0
}

pub fn version() -> String {
    format!(
        "x_native {} ({})",
        env!("CARGO_PKG_VERSION"),
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    )
}

// ------------------------------------------------------------------- parsing

#[derive(Debug)]
struct Args {
    pos: Vec<String>,
    opt: HashMap<String, String>,
    flags: BTreeSet<String>,
}

impl Args {
    fn flag(&self, f: &str) -> bool {
        self.flags.contains(f)
    }
    fn opt(&self, k: &str) -> Option<&str> {
        self.opt.get(k).map(String::as_str)
    }
    fn all(&self, k: &str) -> Vec<String> {
        // repeated options are collected under "k" and "k#2", "k#3"…
        let mut out: Vec<String> = Vec::new();
        if let Some(v) = self.opt.get(k) {
            out.push(v.clone());
        }
        let mut i = 2;
        while let Some(v) = self.opt.get(&format!("{k}#{i}")) {
            out.push(v.clone());
            i += 1;
        }
        out
    }
    fn number(&self, k: &str) -> Result<Option<f64>, String> {
        match self.opt(k) {
            None => Ok(None),
            Some(v) => v
                .parse::<f64>()
                .map(Some)
                .map_err(|_| format!("--{k} needs a number, got '{v}'")),
        }
    }
    fn usize(&self, k: &str) -> Result<Option<usize>, String> {
        match self.opt(k) {
            None => Ok(None),
            Some(v) => v
                .parse::<usize>()
                .map(Some)
                .map_err(|_| format!("--{k} needs a whole number, got '{v}'")),
        }
    }
    fn file(&self, verb: &str) -> Result<String, String> {
        self.pos
            .first()
            .cloned()
            .ok_or_else(|| format!("missing input file (see: x_native {verb} --help)"))
    }
}

/// Single-dash options that take a value.
const SHORT_VALUE: &[&str] = &["-o", "-f"];

/// Flags that take no value; anything else starting with `--` must be
/// followed by one. Unknown flags are an error rather than a shrug.
const NO_VALUE: &[&str] = &[
    "--json",
    "--strict",
    "--tailwind",
    "--list-rules",
    "--quiet",
    "--visible",
    "--static",
    "--help",
    "-h",
];

fn parse(verb: &str, argv: &[String]) -> Result<Args, String> {
    let mut pos = Vec::new();
    let mut opt: HashMap<String, String> = HashMap::new();
    let mut flags = BTreeSet::new();
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        if NO_VALUE.contains(&a.as_str()) {
            flags.insert(a.clone());
        } else if a.starts_with("--") || SHORT_VALUE.contains(&a.as_str()) {
            let k = a.trim_start_matches('-').to_string();
            match it.next() {
                Some(v) => {
                    let key = if opt.contains_key(&k) {
                        let mut i = 2;
                        while opt.contains_key(&format!("{k}#{i}")) {
                            i += 1;
                        }
                        format!("{k}#{i}")
                    } else {
                        k.clone()
                    };
                    opt.insert(key, v.clone());
                }
                None => return Err(format!("--{k} needs a value")),
            }
        } else if a.starts_with('-') && a.len() > 1 {
            return Err(format!("unknown flag '{a}' (see: x_native {verb} --help)"));
        } else {
            pos.push(a.clone());
        }
    }
    if flags.contains("--help") || flags.contains("-h") {
        return Err(format!("!HELP!{}", verb));
    }
    Ok(Args { pos, opt, flags })
}

// ------------------------------------------------------------------ dispatch

/// Run one toolkit verb; returns the process exit code.
pub fn dispatch(verb: &str, argv: &[String]) -> i32 {
    match run(verb, argv) {
        Ok(code) => code,
        Err(e) => {
            if let Some(v) = e.strip_prefix("!HELP!") {
                return print_help(Some(v));
            }
            eprintln!("{verb}: {e}");
            2
        }
    }
}

fn load(path: &str) -> Result<x_native::Document, String> {
    load_any(path).map_err(|e| format!("{path}: {e}"))
}

fn run(verb: &str, argv: &[String]) -> Result<i32, String> {
    let a = parse(verb, argv)?;
    match verb {
        "tree" => {
            let doc = load(&a.file(verb)?)?;
            let depth = a.usize("depth")?;
            let lines = x_native::tree_lines(&doc, depth);
            if a.flag("--json") {
                let items: Vec<String> = lines
                    .iter()
                    .map(|l| format!(r#""{}""#, x_native::esc_str(l)))
                    .collect();
                emit_line(&format!("[{}]", items.join(", ")));
            } else {
                let body = lines.join("\n");
                if !body.is_empty() {
                    emit_line(&body);
                }
                emit_line(&format!("{} line(s)", lines.len()));
            }
            Ok(0)
        }
        "find" => {
            let doc = load(&a.file(verb)?)?;
            let f = FindFilter {
                kind: a.opt("type").map(str::to_string),
                name: a.opt("name").map(str::to_string),
                name_is: a.opt("name-is").map(str::to_string),
                id: a.opt("id").map(str::to_string),
                min_w: a.number("min-w")?.unwrap_or(0.0),
                min_h: a.number("min-h")?.unwrap_or(0.0),
                max_w: a.number("max-w")?.unwrap_or(0.0),
                max_h: a.number("max-h")?.unwrap_or(0.0),
                visible_only: a.flag("--visible"),
                not_interactive: a.flag("--static"),
                limit: a.usize("limit")?.unwrap_or(0),
            };
            let hits = match a.opt("under") {
                Some(root) => x_native::find_under(&doc, root, &f),
                None => x_native::find_with(&doc, &f),
            };
            if a.flag("--json") {
                emit_line(&x_native::found_json(&hits));
            } else {
                let body: Vec<String> = hits
                    .iter()
                    .map(|h| {
                        format!(
                            "{} {} \"{}\" page {} @ {:.0},{:.0} {:.0}×{:.0}",
                            h.kind, h.id, h.name, h.page, h.x, h.y, h.w, h.h
                        )
                    })
                    .collect();
                if !body.is_empty() {
                    emit_line(&body.join("\n"));
                }
                emit_line(&format!("{} match(es)", hits.len()));
            }
            // a filter that matched nothing is a signal, not a success
            Ok(if hits.is_empty() { 3 } else { 0 })
        }
        "node" => {
            let doc = load(&a.file(verb)?)?;
            let Some(id) = a.pos.get(1) else {
                return Err("needs a node id (see: x_native node --help)".into());
            };
            match x_native::locate(&doc, id) {
                Some((_, n)) => {
                    let depth = a.usize("depth")?.unwrap_or(3);
                    emit_line(&x_native::subtree_json(n, depth));
                    Ok(0)
                }
                None => {
                    eprintln!("node: no node with id {id}");
                    Ok(1)
                }
            }
        }
        "info" => {
            let doc = load(&a.file(verb)?)?;
            let st = x_native::info(&doc);
            if a.flag("--json") {
                emit_line(&st.to_json());
            } else {
                emit_line(&format!(
                    "pages={} nodes={} frames={} texts={} images={} components={} instances={} auto-layout={} interactions={} assets={} variables={}",
                    st.pages,
                    st.nodes,
                    st.frames,
                    st.texts,
                    st.images,
                    st.components,
                    st.instances,
                    st.auto_layouts,
                    st.interactions,
                    st.assets,
                    st.variables
                ));
            }
            Ok(0)
        }
        "lint" => {
            // the rule table is not a document operation, so `--list-rules`
            // has to work in a fresh checkout with nothing to lint yet
            let doc = if a.flag("--list-rules") {
                None
            } else {
                doc_opt(&a, verb)?
            };
            run_lint(&a, &doc)
        }
        "analyze" => run_analyze(verb, &a),
        "export-jsx" | "export" => run_export(verb, &a),
        "theme" => run_theme(&a),
        "tokens" => {
            let doc = load(&a.file(verb)?)?;
            let body = x_native::editor::export_tokens(&doc);
            match a.opt("o") {
                Some(path) => write(path, &body).map(|()| 0),
                None => {
                    emit_line(&body);
                    Ok(0)
                }
            }
        }
        "convert" => {
            let (Some(inp), Some(outp)) = (a.pos.first(), a.pos.get(1)) else {
                return Err(
                    "needs an input and an output path (see: x_native convert --help)".into(),
                );
            };
            let d = load(inp)?;
            if outp.ends_with(".x") {
                write(outp, &x_native::fileio::save_x(&d))?;
            } else if outp.ends_with(".svg") {
                let Some(root) = d.pages.first() else {
                    return Err("document has no page".into());
                };
                write(outp, &x_native::fileio::export_svg(root, &d.variables))?;
            } else {
                return Err(format!("unsupported output '{outp}' (.x or .svg)"));
            }
            let st = x_native::info(&d);
            println!(
                "convert: {inp} → {outp} (pages={}, nodes={})",
                st.pages, st.nodes
            );
            Ok(0)
        }
        "validate" => {
            let path = a.file(verb)?;
            let doc = load(&path)?;
            let text = x_native::fileio::save_x(&doc);
            let again =
                x_native::fileio::load_x(&text).map_err(|e| format!("round-trip parse: {e}"))?;
            let (a1, a2) = (x_native::info(&doc), x_native::info(&again));
            let before = format!("{a1:?}");
            let after = format!("{a2:?}");
            if before == after {
                println!(
                    "validate: {path} ok ({} nodes, {} assets, {} variables survive save+load)",
                    a1.nodes, a1.assets, a1.variables
                );
                Ok(0)
            } else {
                eprintln!("validate: {path} round-trip changed the document\n  before: {before}\n  after:  {after}");
                Ok(5)
            }
        }
        other => Err(format!("unknown verb '{other}' (see: x_native --help)")),
    }
}

fn doc_opt(a: &Args, verb: &str) -> Result<Option<x_native::Document>, String> {
    match a.pos.first() {
        Some(p) => load(p).map(Some),
        None => Err(format!("missing input file (see: x_native {verb} --help)")),
    }
}

fn write(path: &str, body: &str) -> Result<(), String> {
    std::fs::write(path, body).map_err(|e| format!("write {path}: {e}"))
}

// ------------------------------------------------------------------ lint verb

fn run_lint(a: &Args, doc: &Option<x_native::Document>) -> Result<i32, String> {
    let mut cfg = match (a.opt("preset"), a.flag("--strict")) {
        (Some(p), _) => LintConfig::preset(
            LintPreset::parse(p)
                .ok_or_else(|| format!("unknown preset '{p}' (recommended|strict|a11y|all)"))?,
        ),
        (None, true) => LintConfig::preset(LintPreset::Strict),
        (None, false) => LintConfig::default(),
    };
    cfg.only = a.all("rule");
    cfg.skip = a.all("ignore");
    let bogus = x_native::unknown_rules(&cfg.only)
        .into_iter()
        .chain(x_native::unknown_rules(&cfg.skip));
    if let Some(b) = bogus.min() {
        return Err(format!(
            "unknown rule '{b}' (see: x_native lint --list-rules)"
        ));
    }
    let path = a.pos.first().cloned().unwrap_or_default();
    if a.flag("--list-rules") {
        let table = x_native::rule_table();
        if a.flag("--json") {
            let items: Vec<String> = table
                .iter()
                .map(|r| {
                    format!(
                        r#"{{ "id": "{}", "severity": "{}", "presets": [{}], "checks": "{}" }}"#,
                        x_native::esc_str(r.id),
                        r.severity.as_str(),
                        r.presets
                            .iter()
                            .map(|p| format!(r#""{}""#, p.name()))
                            .collect::<Vec<_>>()
                            .join(", "),
                        x_native::esc_str(r.what)
                    )
                })
                .collect();
            emit_line(&format!(r#"{{ "rules": [{}] }}"#, items.join(", ")));
            return Ok(0);
        }
        let mut out = format!(
            "{:<18} {:<8} {:<30} {}\n",
            "RULE", "SEVERITY", "PRESETS", "CHECKS"
        );
        for r in table {
            let presets: Vec<&str> = r.presets.iter().map(|p| p.name()).collect();
            out.push_str(&format!(
                "{:<18} {:<8} {:<30} {}\n",
                r.id,
                r.severity.as_str(),
                presets.join("+"),
                r.what
            ));
        }
        out.push_str(&format!("{} rule(s)\n", table.len()));
        emit(&out);
        return Ok(0);
    }
    let doc = doc
        .as_ref()
        .ok_or_else(|| "missing input file (see: x_native lint --help)".to_string())?;
    let findings = x_native::lint_with(doc, &cfg);
    let fail_on = a.opt("fail-on").unwrap_or("error");
    let threshold = match fail_on {
        "never" => None,
        "warning" => Some(x_native::Severity::Warning),
        "error" => Some(x_native::Severity::Error),
        other => return Err(format!("unknown --fail-on '{other}' (error|warning|never)")),
    };
    if a.flag("--json") {
        emit_line(&lint_report_json(&findings, &path, &cfg));
        return Ok(exit_for(&findings, threshold));
    }
    if a.flag("--quiet") {
        emit_line(&lint_summary(&findings));
    } else {
        emit(&x_native::lint_render(
            &findings,
            &format!("{} ({})", path, cfg.describe()),
        ));
    }
    Ok(exit_for(&findings, threshold))
}

/// Map the fail-on threshold onto a process exit code.
fn exit_for(findings: &[x_native::Finding], threshold: Option<x_native::Severity>) -> i32 {
    let fails = match threshold {
        None => false,
        Some(x_native::Severity::Error) => findings
            .iter()
            .any(|f| f.severity == x_native::Severity::Error),
        Some(x_native::Severity::Warning) => !findings.is_empty(),
    };
    if fails {
        4
    } else {
        0
    }
}

// -------------------------------------------------------------- analyze verb

fn run_analyze(verb: &str, a: &Args) -> Result<i32, String> {
    let doc = load(&a.file(verb)?)?;
    let opts = x_native::AnalyzeOptions {
        overlap_ratio: a.number("min-overlap")?.unwrap_or(0.25),
        min_cluster: a.usize("min-cluster")?.unwrap_or(3),
        top: a.usize("top")?.unwrap_or(0),
    };
    let t = x_native::analyze_design_with(&doc, &opts);
    let section = a.pos.get(1).cloned().unwrap_or_else(|| "all".into());
    if section == "adoption" {
        let ad = x_native::adoption(&doc);
        if a.flag("--json") {
            emit_line(&ad.to_json());
        } else {
            emit(&ad.render());
        }
        return Ok(0);
    }
    let sub = t.section(&section).ok_or_else(|| {
        format!("unknown section '{section}' (colors|type|spacing|overlaps|clusters|adoption)")
    })?;
    if a.flag("--json") {
        // the adoption report rides in the same object, so one call answers
        // "is this design system real" — and the braces stay balanced
        let js = if section == "all" {
            let ad = x_native::adoption(&doc);
            sub.to_json_with(&[("adoption", ad.to_json().as_str())])
        } else {
            sub.to_json()
        };
        emit_line(&js);
    } else {
        emit(&sub.render());
        if section == "all" {
            emit(&x_native::adoption(&doc).render());
        }
    }
    if let Some(out) = a.opt("emit-variables") {
        let mut d = doc;
        let added = t.emit_variables(&mut d.variables);
        write(out, &x_native::fileio::save_x(&d))?;
        eprintln!("analyze: {added} new variables → {out}");
    }
    Ok(0)
}

// --------------------------------------------------------------- export verb

fn run_export(verb: &str, a: &Args) -> Result<i32, String> {
    let doc = load(&a.file(verb)?)?;
    let style = match verb {
        "export-jsx" => {
            if a.flag("--tailwind") || a.opt("style") == Some("tailwind") {
                "tailwind"
            } else {
                "jsx"
            }
        }
        _ => a.opt("style").or_else(|| a.opt("f")).unwrap_or("jsx"),
    };
    let out = a.opt("o").map(|p| p.to_string());
    let pages: Vec<&Node> = doc.pages.iter().collect();
    let mut body = String::new();
    match style {
        "jsx" | "tailwind" => {
            for p in pages {
                for c in &p.children {
                    let frag = if style == "tailwind" {
                        x_native::node_to_tailwind(c)
                    } else {
                        x_native::node_to_jsx(c)
                    };
                    if !frag.is_empty() {
                        body.push_str(&format!("{{/* {} */}}\n", p.name));
                        body.push_str(&frag);
                    }
                }
            }
        }
        "svg" => {
            let Some(root) = pages.first() else {
                return Err("document has no page".into());
            };
            body = x_native::fileio::export_svg(root, &doc.variables);
        }
        "tokens" => body = x_native::editor::export_tokens(&doc),
        other => {
            return Err(format!(
                "unknown format '{other}' (jsx|tailwind|svg|tokens; HTML has its own verb: x_native export-html)"
            ))
        }
    }
    match out {
        Some(path) => {
            write(&path, &body)?;
            eprintln!("{style}: {} bytes → {path}", body.len());
        }
        None => print!("{body}"),
    }
    Ok(0)
}

// -------------------------------------------------------------------- loader

/// One JSON object per theme: every audited pair with its measured ratio and
/// the failures in human form. `theme_audit_json` is separate from the
/// printer so tests can assert the payload without capturing stdout.
fn theme_audit_json(ids: &[x_native::ui::ThemeId], as_json: bool) -> (String, usize) {
    use x_native::ui::ColorTokens;
    if !as_json {
        let mut failed = 0usize;
        for id in ids.iter().copied() {
            let p = ColorTokens::for_theme(id);
            failed += p.contrast_audit().len();
            emit(&p.audit_report(id.label()));
        }
        return (String::new(), failed);
    }
    let mut failed = 0usize;
    let mut bits: Vec<String> = Vec::new();
    for id in ids.iter().copied() {
        let p = ColorTokens::for_theme(id);
        let fails = p.contrast_audit();
        failed += fails.len();
        let pairs: Vec<String> = p
            .contrast_pairs()
            .iter()
            .map(|c| {
                format!(
                    r#"{{"fg":"{}","bg":"{}","ratio":{:.4},"min":{},"pass":{}}}"#,
                    c.fg,
                    c.bg,
                    c.ratio,
                    c.min,
                    c.passes()
                )
            })
            .collect();
        let f: Vec<String> = fails
            .iter()
            .map(|m| format!(r#""{}""#, x_native::esc_str(m)))
            .collect();
        bits.push(format!(
            r#"{{"theme":"{}","label":"{}","pairs":[{}],"failures":[{}]}}"#,
            id.slug(),
            x_native::esc_str(id.label()),
            pairs.join(","),
            f.join(",")
        ));
    }
    let body = if bits.len() == 1 {
        bits[0].clone()
    } else {
        format!("[{}]", bits.join(","))
    };
    (body, failed)
}

/// The shipped UI palettes, audited and exported. Kept in the CLI because a
/// theme change is exactly the kind of thing CI should gate on.
fn run_theme(a: &Args) -> Result<i32, String> {
    use x_native::ui::{ColorTokens, ThemeId};
    if !a.pos.is_empty() && a.pos[0].starts_with('-') {
        return Err("usage: x_native theme audit|tokens [--theme ID]".into());
    }
    let sub = a.pos.first().map(|s| s.as_str()).unwrap_or("audit");
    let names = ThemeId::ALL
        .iter()
        .map(|t| t.slug())
        .collect::<Vec<_>>()
        .join(", ");
    let chosen: Vec<ThemeId> = match a.opt("theme") {
        Some(t) => {
            vec![ThemeId::parse(t).ok_or_else(|| format!("unknown theme '{t}' (try: {names})"))?]
        }
        None => ThemeId::ALL.to_vec(),
    };
    match sub {
        "audit" => {
            let (body, failed) = theme_audit_json(&chosen, a.flag("--json"));
            if a.flag("--json") {
                emit_line(&body);
            }
            Ok(if failed == 0 { 0 } else { 4 })
        }
        "tokens" => {
            let id = chosen[0];
            let body = ColorTokens::for_theme(id).to_dtcg();
            match a.opt("o") {
                Some(path) => write(path, &body).map(|()| 0),
                None => {
                    emit(&body);
                    Ok(0)
                }
            }
        }
        other => Err(format!(
            "unknown theme subcommand '{other}' (audit|tokens; see: x_native theme --help)"
        )),
    }
}

/// Write to stdout without panicking when the consumer closed the pipe
/// (`x_native tree f.x | head` is a normal thing to do).
fn emit(s: &str) {
    use std::io::Write;
    let out = std::io::stdout();
    let mut h = out.lock();
    let _ = h.write_all(s.as_bytes());
    let _ = h.flush();
}

/// [`emit`] with a trailing newline.
fn emit_line(s: &str) {
    emit(s);
    emit("\n");
}

/// Load a design file in any supported format (extension-sniffed).
pub fn load_any(path: &str) -> Result<x_native::Document, String> {
    let p = std::path::Path::new(path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "x" => x_native::fileio::load_x_file(path),
        "fig" => {
            let b = std::fs::read(path).map_err(|e| e.to_string())?;
            x_native::fileio::import_fig_bytes(&b)
        }
        "json" => {
            let t = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            x_native::fileio::import_figma_json(&t)
        }
        "sketch" => {
            let b = std::fs::read(path).map_err(|e| e.to_string())?;
            x_native::fileio::import_sketch(&b)
        }
        "png" => {
            let b = std::fs::read(path).map_err(|e| e.to_string())?;
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("image");
            x_native::fileio::import_png(name, &b)
        }
        "svg" => {
            let t = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let root = x_native::fileio::import_svg(&t)?;
            let mut d = x_native::Document::new();
            d.pages.push(root);
            Ok(d)
        }
        _ => Err(format!("unsupported input extension '.{ext}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_verb_has_help_text() {
        for v in VERBS {
            assert!(!verb_help(v).is_empty(), "{v} has no help text");
            assert!(
                !std::ptr::eq(verb_help(v), SUMMARY),
                "{v} falls back to the summary instead of its own help"
            );
        }
        // summary must mention every verb, or the help is a lie
        for v in VERBS {
            assert!(SUMMARY.contains(v), "{v} missing from SUMMARY");
        }
    }

    #[test]
    fn parser_separates_flags_options_and_positionals() {
        let argv: Vec<String> = ["file.x", "--json", "--depth", "2", "-o", "out.jsx"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse("tree", &argv).unwrap();
        assert_eq!(a.pos, vec!["file.x".to_string()]);
        assert!(a.flag("--json"));
        assert_eq!(a.opt("depth"), Some("2"));
        assert_eq!(a.opt("o"), Some("out.jsx"));
        // repeatable options accumulate
        let argv: Vec<String> = ["f.x", "--rule", "zero-size", "--rule", "off-grid"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse("lint", &argv).unwrap();
        assert_eq!(a.all("rule"), vec!["zero-size", "off-grid"]);
        // unknown flags and dangling options are errors, not shrugs
        assert!(parse("lint", &["-z".to_string()]).is_err());
        assert!(parse("lint", &["--rule".to_string()]).is_err());
        assert!(parse("tree", &["--help".to_string()])
            .unwrap_err()
            .starts_with("!HELP!"));
    }

    /// End-to-end over a real file: the exit codes are part of the CLI
    /// contract, and they can only be proven by running the verbs.
    #[test]
    fn verbs_return_their_documented_exit_codes() {
        let mut d = x_native::Document::new();
        let mut page = Node::frame("p", 400.0, 300.0);
        page.name = "Page".into();
        let mut hair = Node::rect(
            "tiny",
            0.0,
            0.0,
            0.5,
            20.0,
            x_native::Color::from_rgb8(0, 0, 0),
        );
        hair.name = "Hairline".into();
        page.children.push(hair);
        d.pages.push(page);
        let path = std::env::temp_dir().join(format!(
            "x-native-toolkit-{}-{}.x",
            std::process::id(),
            line!()
        ));
        std::fs::write(&path, x_native::fileio::save_x(&d)).unwrap();
        let file = path.to_str().unwrap().to_string();
        let argv = |extra: &[&str]| -> Vec<String> {
            std::iter::once(file.clone())
                .chain(extra.iter().map(|s| s.to_string()))
                .collect()
        };
        // zero-size is an error → lint fails the build by default
        assert_eq!(dispatch("lint", &argv(&[])), 4);
        // …unless told not to, or the rule is ignored
        assert_eq!(dispatch("lint", &argv(&["--fail-on", "never"])), 0);
        assert_eq!(dispatch("lint", &argv(&["--ignore", "zero-size"])), 0);
        // find: a hit is 0, no hit is 3
        assert_eq!(dispatch("find", &argv(&["--type", "RECT"])), 0);
        assert_eq!(dispatch("find", &argv(&["--name", "nope"])), 3);
        // missing node id is an error, unknown flag is a usage error
        assert_eq!(dispatch("node", &argv(&["nope"])), 1);
        assert_eq!(dispatch("info", &argv(&["--nope"])), 2);
        // validate: the .x round-trip survives
        assert_eq!(dispatch("validate", &argv(&[])), 0);
        // tokens / export -o actually write files
        let out =
            std::env::temp_dir().join(format!("x-native-toolkit-{}.json", std::process::id()));
        assert_eq!(dispatch("tokens", &argv(&["-o", out.to_str().unwrap()])), 0);
        let body = std::fs::read_to_string(&out).unwrap();
        assert!(body.contains("\"$schema\""), "{body}");
        assert!(
            !body.contains(",\n}"),
            "tokens.json must not carry a trailing comma: {body}"
        );
        let svg = std::env::temp_dir().join(format!("x-native-toolkit-{}.svg", std::process::id()));
        assert_eq!(
            dispatch("export", &argv(&["-f", "svg", "-o", svg.to_str().unwrap()])),
            0
        );
        assert!(std::fs::read_to_string(&svg)
            .unwrap()
            .starts_with("<svg xmlns"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&svg);
    }

    #[test]
    fn numeric_options_report_their_name() {
        let argv: Vec<String> = ["f.x", "--depth", "wide"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse("tree", &argv).unwrap();
        assert_eq!(
            a.usize("depth").unwrap_err(),
            "--depth needs a whole number, got 'wide'"
        );
    }

    #[test]
    fn rule_table_needs_no_document() {
        let argv = ["--list-rules"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        // used to be a usage error (and the printer unwrapped a None document)
        assert_eq!(run("lint", &argv).unwrap(), 0);
        let json: Vec<String> = ["--list-rules", "--json"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        assert_eq!(run("lint", &json).unwrap(), 0);
        // an unknown preset is still refused before anything is printed
        let bad: Vec<String> = ["--list-rules", "--preset", "vibes"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        assert!(run("lint", &bad).is_err());
        // and linting really does still demand a file
        assert!(run("lint", &[]).is_err());
    }

    #[test]
    fn theme_verb_audits_and_exports_the_shipped_palettes() {
        use x_native::ui::ThemeId;
        let argv = |args: &[&str]| -> Vec<String> { args.iter().map(|s| s.to_string()).collect() };
        // default theme audits clean (exit 0 = CI gate green)
        assert_eq!(run("theme", &argv(&["audit"])).unwrap(), 0);
        assert_eq!(
            run("theme", &argv(&["audit", "--theme", "light"])).unwrap(),
            0
        );
        // JSON payload: one row per audited pair per theme, all passing
        let pairs = ThemeId::Graphite.palette().contrast_pairs().len();
        let (json, failed) = theme_audit_json(&ThemeId::ALL, true);
        assert_eq!(failed, 0);
        assert!(json.starts_with('[') && json.ends_with(']'), "{json}");
        assert_eq!(
            json.matches(r#""pass":true"#).count(),
            pairs * ThemeId::ALL.len()
        );
        assert!(
            !json.contains(r#""pass":false"#) && !json.contains("NaN"),
            "{json}"
        );
        let (one, _) = theme_audit_json(&[ThemeId::HighContrast], true);
        assert!(one.starts_with('{') && one.ends_with('}'));
        assert!(one.contains(r#""theme":"high-contrast""#), "{one}");
        assert!(
            one.contains(r#""fg":"on_accent""#),
            "labels on fills must be audited"
        );
        // unknown theme names are refused, not silently defaulted
        assert!(run("theme", &argv(&["audit", "--theme", "neon"])).is_err());
        assert!(run("theme", &argv(&["bogus"])).is_err());
        // tokens emit one palette as DTCG, with a $type for every role
        let d = dtcg_probe();
        assert!(
            d.contains(r#""$schema""#) && d.contains(r#""$type": "color""#),
            "{d}"
        );
        assert!(!d.contains(",\n  }"), "trailing comma in {d}");
    }

    /// probe: the palette export the CLI writes (kept next to the verb so a
    /// drift in either shows up here).
    fn dtcg_probe() -> String {
        use x_native::ui::ColorTokens;
        ColorTokens::for_theme(x_native::ui::ThemeId::Daylight).to_dtcg()
    }
}
