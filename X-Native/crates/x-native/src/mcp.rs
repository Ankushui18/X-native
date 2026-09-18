//! MCP (Model Context Protocol) server surface — JSON-RPC 2.0 over stdio.
//!
//! Figma's Dev Mode exposes an MCP server; X-Native's equivalent is the
//! `x_native mcp [file.x]` CLI mode: an AI agent (or any scripting client)
//! speaks newline-delimited JSON-RPC on stdin/stdout and can list pages,
//! inspect nodes, generate code (CSS/SwiftUI/Compose/XML), read design
//! tokens and variables. Fully offline, no accounts, no network.
//!
//! The JSON codec here is self-contained (x-format's parser is
//! `pub(crate)`), deliberately small, and unit-tested.

use crate::editor::{node_to_compose, node_to_css, node_to_swift, node_to_xml};
use crate::node_to_jsx;
use crate::{Document, Node, NodeKind};

// ------------------------------------------------------------------- codec

/// Minimal JSON value.
#[derive(Debug, Clone, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn num(&self) -> Option<f64> {
        match self {
            J::Num(n) => Some(*n),
            _ => None,
        }
    }
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

/// Parse one JSON document.
pub fn parse_json(s: &str) -> Result<J, String> {
    let mut p = P {
        b: s.as_bytes(),
        i: 0,
        depth: 0,
    };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("trailing bytes at {}", p.i));
    }
    Ok(v)
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && self.b[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn value(&mut self) -> Result<J, String> {
        if self.depth > 64 {
            return Err("nesting too deep".into());
        }
        match self.b.get(self.i) {
            None => Err("unexpected end".into()),
            Some(b'{') => {
                self.depth += 1;
                self.i += 1;
                let mut out = vec![];
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(J::Obj(out));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.ws();
                    if self.b.get(self.i) != Some(&b':') {
                        return Err("expected ':'".into());
                    }
                    self.i += 1;
                    self.ws();
                    let v = self.value()?;
                    out.push((k, v));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            self.depth -= 1;
                            return Ok(J::Obj(out));
                        }
                        _ => return Err("expected ',' or '}'".into()),
                    }
                }
            }
            Some(b'[') => {
                self.depth += 1;
                self.i += 1;
                let mut out = vec![];
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(J::Arr(out));
                }
                loop {
                    self.ws();
                    out.push(self.value()?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            self.depth -= 1;
                            return Ok(J::Arr(out));
                        }
                        _ => return Err("expected ',' or ']'".into()),
                    }
                }
            }
            Some(b'"') => Ok(J::Str(self.string()?)),
            Some(b't') => {
                self.lit("true")?;
                Ok(J::Bool(true))
            }
            Some(b'f') => {
                self.lit("false")?;
                Ok(J::Bool(false))
            }
            Some(b'n') => {
                self.lit("null")?;
                Ok(J::Null)
            }
            Some(_) => {
                let start = self.i;
                while self.i < self.b.len()
                    && matches!(
                        self.b[self.i],
                        b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'
                    )
                {
                    self.i += 1;
                }
                std::str::from_utf8(&self.b[start..self.i])
                    .ok()
                    .and_then(|t| t.parse::<f64>().ok())
                    .map(J::Num)
                    .ok_or_else(|| "bad number".into())
            }
        }
    }
    fn lit(&mut self, w: &str) -> Result<(), String> {
        if self.b[self.i..].starts_with(w.as_bytes()) {
            self.i += w.len();
            Ok(())
        } else {
            Err(format!("expected '{w}'"))
        }
    }
    fn string(&mut self) -> Result<String, String> {
        if self.b.get(self.i) != Some(&b'"') {
            return Err("expected string".into());
        }
        self.i += 1;
        let mut out = String::new();
        while let Some(&c) = self.b.get(self.i) {
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => match self.b.get(self.i) {
                    Some(b'"') => {
                        out.push('"');
                        self.i += 1;
                    }
                    Some(b'\\') => {
                        out.push('\\');
                        self.i += 1;
                    }
                    Some(b'/') => {
                        out.push('/');
                        self.i += 1;
                    }
                    Some(b'n') => {
                        out.push('\n');
                        self.i += 1;
                    }
                    Some(b't') => {
                        out.push('\t');
                        self.i += 1;
                    }
                    Some(b'r') => {
                        out.push('\r');
                        self.i += 1;
                    }
                    Some(b'u') => {
                        if self.i + 4 >= self.b.len() {
                            return Err("bad \\u escape".into());
                        }
                        let hex = std::str::from_utf8(&self.b[self.i + 1..self.i + 5])
                            .map_err(|_| "bad \\u escape".to_string())?;
                        let cp = u32::from_str_radix(hex, 16).map_err(|_| "bad \\u escape")?;
                        out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        self.i += 5;
                    }
                    _ => return Err("bad escape".into()),
                },
                _ => {
                    // copy the raw utf-8 sequence
                    let start = self.i - 1;
                    let mut end = self.i;
                    while end < self.b.len() && (self.b[end] & 0xc0) == 0x80 {
                        end += 1;
                    }
                    out.push_str(
                        std::str::from_utf8(&self.b[start..end])
                            .map_err(|_| "bad utf8".to_string())?,
                    );
                    self.i = end;
                }
            }
        }
        Err("unterminated string".into())
    }
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Serialize a JSON value (compact).
pub fn write_json(v: &J) -> String {
    match v {
        J::Null => "null".into(),
        J::Bool(b) => b.to_string(),
        J::Num(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        J::Str(s) => format!("\"{}\"", esc(s)),
        J::Arr(a) => {
            let items: Vec<String> = a.iter().map(write_json).collect();
            format!("[{}]", items.join(","))
        }
        J::Obj(m) => {
            let items: Vec<String> = m
                .iter()
                .map(|(k, v)| format!("\"{}\":{}", esc(k), write_json(v)))
                .collect();
            format!("{{{}}}", items.join(","))
        }
    }
}

fn jstr(s: &str) -> J {
    J::Str(s.to_string())
}

// -------------------------------------------------------------- rpc layer

fn ok_rsp(id: J, result: J) -> String {
    write_json(&J::Obj(vec![
        ("jsonrpc".into(), jstr("2.0")),
        ("id".into(), id),
        ("result".into(), result),
    ]))
}

fn err_rsp(id: J, code: i64, message: &str) -> String {
    write_json(&J::Obj(vec![
        ("jsonrpc".into(), jstr("2.0")),
        ("id".into(), id),
        (
            "error".into(),
            J::Obj(vec![
                ("code".into(), J::Num(code as f64)),
                ("message".into(), jstr(message)),
            ]),
        ),
    ]))
}

fn text_result(t: String) -> J {
    J::Obj(vec![
        (
            "content".into(),
            J::Arr(vec![J::Obj(vec![
                ("type".into(), jstr("text")),
                ("text".into(), J::Str(t)),
            ])]),
        ),
        ("isError".into(), J::Bool(false)),
    ])
}

fn err_result(t: String) -> J {
    J::Obj(vec![
        (
            "content".into(),
            J::Arr(vec![J::Obj(vec![
                ("type".into(), jstr("text")),
                ("text".into(), J::Str(t)),
            ])]),
        ),
        ("isError".into(), J::Bool(true)),
    ])
}

fn tools_spec() -> J {
    let tool = |name: &str, desc: &str, props: &[(&str, &str)]| {
        J::Obj(vec![
            ("name".into(), jstr(name)),
            ("description".into(), jstr(desc)),
            (
                "inputSchema".into(),
                J::Obj(vec![
                    ("type".into(), jstr("object")),
                    (
                        "properties".into(),
                        J::Obj(
                            props
                                .iter()
                                .map(|(k, ty)| {
                                    (k.to_string(), J::Obj(vec![("type".into(), jstr(ty))]))
                                })
                                .collect(),
                        ),
                    ),
                ]),
            ),
        ])
    };
    J::Obj(vec![(
        "tools".into(),
        J::Arr(vec![
            tool(
                "list_pages",
                "List every page (top-level frame) in the document.",
                &[],
            ),
            tool(
                "get_node",
                "Inspect one node by id: kind, size, fill, children, bindings.",
                &[("id", "string")],
            ),
            tool(
                "find_nodes",
                "Find nodes by kind and/or name substring.",
                &[("name_contains", "string"), ("kind", "string")],
            ),
            tool(
                "node_code",
                "Generate code for a node: css | tailwind | swiftui | compose | xml | jsx.",
                &[("id", "string"), ("platform", "string")],
            ),
            tool(
                "design_tokens",
                "Export W3C DTCG tokens.json for the document.",
                &[],
            ),
            tool(
                "variables",
                "List variables (with values, types and exposed-for-prototype flags).",
                &[],
            ),
            tool(
                "inspect_tree",
                "Indented layer tree of the whole document.",
                &[("max_depth", "number")],
            ),
            tool(
                "lint_design",
                "Design lint as a JSON report. preset: recommended | strict | a11y | all; rule/ignore narrow the set.",
                &[
                    ("preset", "string"),
                    ("rule", "string"),
                    ("ignore", "string"),
                ],
            ),
            tool(
                "list_lint_rules",
                "The rule table: id, severity, presets, what it checks.",
                &[],
            ),
            tool(
                "analyze_design",
                "Design-token audit (colors, type scale, spacing, clusters, overlaps, adoption). section: all|colors|type|spacing|overlaps|clusters; json=true for machine output.",
                &[("section", "string"), ("top", "number"), ("json", "boolean")],
            ),
            tool(
                "extract_variables",
                "Create typed variables from the extracted tokens (color/…, text/…, space/…, radius/…). Returns how many were added.",
                &[],
            ),
        ]),
    )])
}

fn kind_label(n: &Node) -> &'static str {
    match &n.kind {
        NodeKind::Frame { .. } => "frame",
        NodeKind::Group => "group",
        NodeKind::Section => "section",
        NodeKind::Rect { .. } => "rect",
        NodeKind::Text { .. } => "text",
        NodeKind::Image { .. } => "image",
        NodeKind::Component { .. } => "component",
        NodeKind::Instance { .. } => "instance",
        NodeKind::Ellipse => "ellipse",
        NodeKind::Arc { .. } => "arc",
        NodeKind::Poly { .. } => "polygon",
        NodeKind::Star { .. } => "star",
        NodeKind::Line => "line",
        NodeKind::Vector { .. } => "vector",
        _ => "node",
    }
}

fn fill_label(n: &Node) -> String {
    match &n.fill {
        crate::Paint::Solid(c) => format!(
            "#{:02X}{:02X}{:02X}{:02X}",
            c.to_rgba8().a,
            c.to_rgba8().r,
            c.to_rgba8().g,
            c.to_rgba8().b
        ),
        crate::Paint::Variable(v) => format!("var {v}"),
        crate::Paint::LinearGradient { .. } => "linear gradient".into(),
        crate::Paint::RadialGradient { .. } => "radial gradient".into(),
        crate::Paint::AngularGradient { .. } => "angular gradient".into(),
        crate::Paint::DiamondGradient { .. } => "diamond gradient".into(),
        crate::Paint::Pattern { .. } => "pattern".into(),
    }
}

fn walk<'a>(n: &'a Node, out: &mut Vec<&'a Node>) {
    out.push(n);
    for c in &n.children {
        walk(c, out);
    }
}

fn call_tool(name: &str, args: &J, doc: &Document) -> J {
    match name {
        "list_pages" => {
            let mut lines = vec![];
            for (i, p) in doc.pages.iter().enumerate() {
                lines.push(format!(
                    "[{i}] {} ({}) {}x{} — {} children",
                    p.id,
                    kind_label(p),
                    p.w,
                    p.h,
                    p.children.len()
                ));
            }
            text_result(lines.join("\n"))
        }
        "get_node" => {
            let Some(id) = args.get("id").and_then(J::str) else {
                return err_result("get_node needs an id".into());
            };
            let Some(page) = doc.pages.iter().find(|p| {
                let mut all = vec![];
                walk(p, &mut all);
                all.iter().any(|n| n.id == id)
            }) else {
                return err_result(format!("node not found: {id}"));
            };
            let mut all = vec![];
            walk(page, &mut all);
            let Some(n) = all.into_iter().find(|n| n.id == id) else {
                return err_result(format!("node not found: {id}"));
            };
            text_result(format!(
                "id: {}\nkind: {}\nname: {}\nsize: {:.0}x{:.0}\nfill: {}\nopacity: {:.2}\nchildren: {}\nbindings: {}\ncode: {}\nnote: {}",
                n.id,
                kind_label(n),
                n.name,
                n.w,
                n.h,
                fill_label(n),
                n.opacity,
                n.children.len(),
                n.bindings.keys().cloned().collect::<Vec<_>>().join(", "),
                n.bindings.get("code").cloned().unwrap_or_default(),
                n.note().unwrap_or_default(),
            ))
        }
        "find_nodes" => {
            let name_q = args
                .get("name_contains")
                .and_then(J::str)
                .unwrap_or("")
                .to_lowercase();
            let kind_q = args.get("kind").and_then(J::str).unwrap_or("");
            let mut lines = vec![];
            for p in &doc.pages {
                let mut all = vec![];
                walk(p, &mut all);
                for n in all {
                    if !kind_q.is_empty() && kind_label(n) != kind_q {
                        continue;
                    }
                    if !name_q.is_empty() && !n.name.to_lowercase().contains(&name_q) {
                        continue;
                    }
                    lines.push(format!("{} {} ({})", n.id, n.name, kind_label(n)));
                    if lines.len() >= 50 {
                        break;
                    }
                }
            }
            if lines.is_empty() {
                text_result("no matches".into())
            } else {
                text_result(lines.join("\n"))
            }
        }
        "node_code" => {
            let Some(id) = args.get("id").and_then(J::str) else {
                return err_result("node_code needs an id".into());
            };
            let platform = args.get("platform").and_then(J::str).unwrap_or("css");
            let Some(page) = doc.pages.iter().find(|p| {
                let mut all = vec![];
                walk(p, &mut all);
                all.iter().any(|n| n.id == id)
            }) else {
                return err_result(format!("node not found: {id}"));
            };
            let mut all = vec![];
            walk(page, &mut all);
            let Some(n) = all.into_iter().find(|n| n.id == id) else {
                return err_result(format!("node not found: {id}"));
            };
            let code = match platform {
                "css" => node_to_css(n, &doc.variables),
                "swiftui" | "swift" => node_to_swift(n, &doc.variables),
                "compose" => node_to_compose(n, &doc.variables),
                "xml" => node_to_xml(n, &doc.variables),
                "jsx" | "react" => node_to_jsx(n),
                "tailwind" | "tw" => crate::node_to_tailwind(n),
                other => {
                    return err_result(format!(
                        "unknown platform: {other} (css|tailwind|swiftui|compose|xml|jsx)"
                    ))
                }
            };
            text_result(code)
        }
        "design_tokens" => text_result(crate::editor::export_tokens(doc)),
        "inspect_tree" => {
            let depth = args
                .get("max_depth")
                .and_then(J::num)
                .map(|d| d.max(0.0) as usize);
            let lines = crate::query::tree_lines(doc, depth);
            if lines.is_empty() {
                text_result("empty document".into())
            } else {
                text_result(lines.join("\n"))
            }
        }
        "list_lint_rules" => {
            let lines: Vec<String> = crate::lint::rule_table()
                .iter()
                .map(|r| {
                    format!(
                        "{} [{}] ({}) — {}",
                        r.id,
                        r.severity.as_str(),
                        r.presets
                            .iter()
                            .map(|p| p.name())
                            .collect::<Vec<_>>()
                            .join("+"),
                        r.what
                    )
                })
                .collect();
            text_result(lines.join("\n"))
        }
        "lint_design" => {
            let preset = args.get("preset").and_then(J::str).unwrap_or("recommended");
            let Some(preset) = crate::lint::Preset::parse(preset) else {
                return err_result(format!(
                    "unknown preset '{preset}' (recommended|strict|a11y|all)"
                ));
            };
            let mut cfg = crate::lint::LintConfig::preset(preset);
            if let Some(r) = args.get("rule").and_then(J::str) {
                cfg.only = vec![r.to_string()];
            }
            if let Some(r) = args.get("ignore").and_then(J::str) {
                cfg.skip = vec![r.to_string()];
            }
            let bogus = crate::lint::unknown_rules(&cfg.only)
                .into_iter()
                .chain(crate::lint::unknown_rules(&cfg.skip))
                .next();
            if let Some(b) = bogus {
                return err_result(format!("unknown rule '{b}' (see list_lint_rules)"));
            }
            let findings = crate::lint::lint_with(doc, &cfg);
            text_result(crate::lint::report_json(&findings, "mcp", &cfg))
        }
        "analyze_design" => {
            let top = args.get("top").and_then(J::num).unwrap_or(0.0).max(0.0) as usize;
            let t = crate::analyze::analyze_with(
                doc,
                &crate::analyze::AnalyzeOptions {
                    top,
                    ..Default::default()
                },
            );
            let section = args.get("section").and_then(J::str).unwrap_or("all");
            if section == "adoption" {
                let ad = crate::analyze::adoption(doc);
                return text_result(ad.render());
            }
            let Some(sub) = t.section(section) else {
                return err_result(format!(
                    "unknown section '{section}' (all|colors|type|spacing|overlaps|clusters|adoption)"
                ));
            };
            if matches!(args.get("json"), Some(J::Bool(true))) {
                text_result(sub.to_json())
            } else {
                text_result(sub.render())
            }
        }
        "extract_variables" => {
            // read-only server: report what extraction *would* define, and
            // point at the command that writes it into a file
            let mut probe = doc.variables.clone();
            let added = crate::analyze::analyze(doc).emit_variables(&mut probe);
            let fresh: Vec<String> = probe
                .catalog()
                .into_iter()
                .filter(|(_, name, _)| doc.variables.get(name).is_none())
                .map(|(_, name, kind)| format!("{kind} {name}"))
                .collect();
            if added == 0 {
                return text_result(
                    "nothing to extract — every token is already a variable".into(),
                );
            }
            text_result(format!(
                "{added} variable(s) would be created:\n{}\n(write them: x_native analyze <file> --emit-variables out.x)",
                fresh.join("\n")
            ))
        }
        "variables" => {
            let mut lines = vec![];
            for (_, name, kind) in doc.variables.catalog() {
                let exposed = if doc.variables.exposed.contains(&name) {
                    " [exposed]"
                } else {
                    ""
                };
                let value = match kind {
                    "number" => format!("{:.4}", doc.variables.number(&name, 0.0)),
                    "string" => doc.variables.string(&name, "").to_string(),
                    "boolean" => doc.variables.boolean(&name, false).to_string(),
                    _ => {
                        let c = doc.variables.color(&name, crate::Color::BLACK);
                        format!(
                            "#{:02X}{:02X}{:02X}",
                            c.to_rgba8().r,
                            c.to_rgba8().g,
                            c.to_rgba8().b
                        )
                    }
                };
                lines.push(format!("{kind:8} {name:24} = {value}{exposed}"));
            }
            if lines.is_empty() {
                text_result("no variables".into())
            } else {
                text_result(lines.join("\n"))
            }
        }
        other => err_result(format!("unknown tool: {other}")),
    }
}

/// Handle one JSON-RPC message. Returns the response line, or `None` for
/// notifications (messages without an id, which never get replies).
pub fn mcp_handle(msg: &str, doc: &Document) -> Option<String> {
    let v = match parse_json(msg) {
        Ok(v) => v,
        Err(e) => return Some(err_rsp(J::Null, -32700, &format!("parse error: {e}"))),
    };
    let id = v.get("id").cloned();
    let method = v.get("method").and_then(J::str).unwrap_or("").to_string();
    let result = match method.as_str() {
        "initialize" => J::Obj(vec![
            ("protocolVersion".into(), jstr("2024-11-05")),
            (
                "capabilities".into(),
                J::Obj(vec![("tools".into(), J::Obj(vec![]))]),
            ),
            (
                "serverInfo".into(),
                J::Obj(vec![
                    ("name".into(), jstr("x-native")),
                    ("version".into(), jstr(env!("CARGO_PKG_VERSION"))),
                ]),
            ),
        ]),
        "ping" => J::Obj(vec![]),
        "tools/list" => tools_spec(),
        "tools/call" => {
            let Some(name) = v.get("params").and_then(|p| p.get("name")).and_then(J::str) else {
                return Some(err_rsp(
                    id.clone().unwrap_or(J::Null),
                    -32602,
                    "tools/call needs params.name",
                ));
            };
            let args = v
                .get("params")
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or(J::Obj(vec![]));
            call_tool(name, &args, doc)
        }
        _ => {
            id.as_ref()?; // unknown notification: no reply
            return Some(err_rsp(id?, -32601, &format!("method not found: {method}")));
        }
    };
    Some(ok_rsp(id?, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::find;
    use crate::{Color, Document, Variables};

    fn doc() -> Document {
        let mut d = Document::default();
        let mut page = Node::frame("home", 400.0, 300.0);
        page.name = "Home".into();
        let mut card = Node::rect(
            "card-1",
            0.0,
            0.0,
            120.0,
            60.0,
            Color::from_rgb8(0x33, 0x66, 0xff),
        );
        card.name = "Card".into();
        card.bindings
            .insert("code".into(), "repo/ui/Card.kt".into());
        let t = Node::text("t-1", 0.0, 0.0, 100.0, 16.0, "Hi");
        page.children.push(card);
        page.children.push(t);
        d.pages.push(page);
        d.variables.numbers.insert("gap".into(), 8.0);
        d.variables.exposed.insert("gap".into());
        d
    }

    #[test]
    fn json_codec_roundtrip() {
        let src = r#"{"a":[1,2.5,-3],"b":"x\"y\n","c":true,"d":null,"e":{"f":"ü"}}"#;
        let v = parse_json(src).expect("parse");
        assert_eq!(v.get("b").and_then(J::str), Some("x\"y\n"));
        let out = write_json(&v);
        let v2 = parse_json(&out).expect("re-parse");
        assert_eq!(v, v2);
        assert!(parse_json("{oops}").is_err());
        assert!(parse_json("[1,]").is_err());
        assert!(parse_json("").is_err());
    }

    #[test]
    fn initialize_and_tools_list() {
        let d = doc();
        let rsp = mcp_handle(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#, &d).unwrap();
        assert!(rsp.contains("protocolVersion"), "{rsp}");
        assert!(rsp.contains("x-native"), "{rsp}");
        let rsp = mcp_handle(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, &d).unwrap();
        assert!(rsp.contains("node_code"), "{rsp}");
        assert!(rsp.contains("design_tokens"), "{rsp}");
        // notifications get no reply
        assert_eq!(
            mcp_handle(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &d
            ),
            None
        );
    }

    #[test]
    fn tools_call_get_node_and_code() {
        let d = doc();
        let rsp = mcp_handle(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_node","arguments":{"id":"card-1"}}}"#,
            &d,
        )
        .unwrap();
        assert!(rsp.contains("size: 120x60"), "{rsp}");
        assert!(rsp.contains("repo/ui/Card.kt"), "{rsp}");
        let rsp = mcp_handle(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"node_code","arguments":{"id":"card-1","platform":"xml"}}}"#,
            &d,
        )
        .unwrap();
        assert!(rsp.contains("android:id"), "{rsp}");
        assert!(rsp.contains("code connect: repo/ui/Card.kt"), "{rsp}");
        // unknown tool -> isError result
        let rsp = mcp_handle(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}"#,
            &d,
        )
        .unwrap();
        assert!(
            rsp.contains("isError\\\":true") || rsp.contains("\"isError\":true"),
            "{rsp}"
        );
        // bad method -> JSON-RPC error
        let rsp = mcp_handle(r#"{"jsonrpc":"2.0","id":6,"method":"wat"}"#, &d).unwrap();
        assert!(rsp.contains("-32601"), "{rsp}");
    }

    #[test]
    fn tools_call_variables_and_find() {
        let d = doc();
        let rsp = mcp_handle(
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"variables"}}"#,
            &d,
        )
        .unwrap();
        assert!(rsp.contains("gap"), "{rsp}");
        assert!(rsp.contains("[exposed]"), "{rsp}");
        let rsp = mcp_handle(
            r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"find_nodes","arguments":{"name_contains":"card"}}}"#,
            &d,
        )
        .unwrap();
        assert!(rsp.contains("card-1"), "{rsp}");
        let rsp = mcp_handle(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"list_pages"}}"#,
            &d,
        )
        .unwrap();
        assert!(rsp.contains("home"), "{rsp}");
    }

    #[test]
    fn variables_helper_types() {
        let mut v = Variables::default();
        v.numbers.insert("n".into(), 1.5);
        assert_eq!(v.number("n", 0.0), 1.5);
        let d = doc();
        assert!(find(&d.pages[0], "t-1").is_some());
    }
    #[test]
    fn toolkit_tools_are_advertised_and_callable() {
        let d = doc();
        let rsp = mcp_handle(r#"{"jsonrpc":"2.0","id":20,"method":"tools/list"}"#, &d).unwrap();
        for tool in [
            "inspect_tree",
            "lint_design",
            "list_lint_rules",
            "analyze_design",
            "extract_variables",
        ] {
            assert!(rsp.contains(tool), "{tool} missing from tools/list");
        }
        let call = |params: &str| {
            let line = format!(
                r#"{{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{{{params}}}}}"#
            );
            mcp_handle(&line, &d).unwrap_or_default()
        };
        // tree
        let r = call(r#""name":"inspect_tree""#);
        assert!(r.contains("card-1"), "{r}");
        // lint: the demo doc is tidy, so the report is empty but structured
        let r = call(r#""name":"lint_design","arguments":{"preset":"strict"}"#);
        assert!(r.contains("counts"), "{r}");
        assert!(r.contains("strict"), "{r}");
        // lint with an unknown rule is an error, not an empty report
        let r = call(r#""name":"lint_design","arguments":{"rule":"nope"}"#);
        assert!(r.contains("unknown rule"), "{r}");
        // analyze
        let r = call(r#""name":"analyze_design","arguments":{"section":"colors"}"#);
        assert!(r.contains("colors:"), "{r}");
        let r = call(r#""name":"analyze_design","arguments":{"section":"adoption"}"#);
        assert!(r.contains("adoption:"), "{r}");
        let r = call(r#""name":"analyze_design","arguments":{"section":"bogus"}"#);
        assert!(r.contains("unknown section"), "{r}");
        // rule table + dry-run extraction
        let r = call(r#""name":"list_lint_rules""#);
        assert!(r.contains("zero-size"), "{r}");
        let r = call(r#""name":"extract_variables""#);
        assert!(
            r.contains("would be created") || r.contains("already a variable"),
            "{r}"
        );
    }

    #[test]
    fn node_code_supports_tailwind() {
        let d = doc();
        let line = r#"{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"node_code","arguments":{"id":"card-1","platform":"tailwind"}}}"#;
        let rsp = mcp_handle(line, &d).unwrap();
        assert!(rsp.contains("w-[120px]"), "{rsp}");
        let line = r#"{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"node_code","arguments":{"id":"card-1","platform":"verilog"}}}"#;
        let rsp = mcp_handle(line, &d).unwrap();
        assert!(rsp.contains("tailwind"), "{rsp}");
    }
}
