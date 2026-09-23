//! Architecture enforcement: the dependency graph is a TEST.
//! If anyone adds a forbidden edge (x-core -> anything, a cycle, or an
//! upward dependency), the build goes red.
//!
//! Allowed production graph:
//!   x-core -> (nothing internal)
//!   x-components -> x-core
//!   x-text  -> x-core
//!   x-render -> x-core, x-text
//!   x-editor -> x-core, x-components
//!   x-format -> x-core, x-components
//!   x-ui        -> x-text
//!   x-board -> x-core, x-editor, x-render, x-format, x-ui
//!   x-native (facade) -> all crates except x-board
//!   x-designer -> x-native, x-board

use std::collections::HashMap;
use std::path::Path;

fn internal_deps(toml: &str, dev: bool) -> Vec<String> {
    let mut out = vec![];
    let mut in_section = false;
    for line in toml.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_section = l
                == if dev {
                    "[dev-dependencies]"
                } else {
                    "[dependencies]"
                };
            continue;
        }
        if in_section && l.starts_with("x-") {
            if let Some(name) = l.split('=').next() {
                out.push(name.trim().to_string());
            }
        }
    }
    out
}

fn load_graph() -> HashMap<String, Vec<String>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut g = HashMap::new();
    for dir in ["crates", "apps"] {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
            continue;
        };
        for e in entries.flatten() {
            let manifest = e.path().join("Cargo.toml");
            let Ok(toml) = std::fs::read_to_string(&manifest) else {
                continue;
            };
            let name = toml
                .lines()
                .find(|l| l.trim().starts_with("name"))
                .and_then(|l| l.split('"').nth(1))
                .unwrap_or_default()
                .to_string();
            g.insert(name, internal_deps(&toml, false));
        }
    }
    g
}

#[test]
fn dependency_direction_is_enforced() {
    let g = load_graph();
    let allowed: HashMap<&str, Vec<&str>> = HashMap::from([
        ("x-core", vec![]),
        ("x-components", vec!["x-core"]),
        ("x-text", vec!["x-core"]),
        ("x-render", vec!["x-core", "x-text"]),
        ("x-editor", vec!["x-core", "x-components"]),
        ("x-format", vec!["x-core", "x-components"]),
        ("x-ui", vec!["x-text"]),
        (
            "x-native",
            vec![
                "x-core",
                "x-components",
                "x-render",
                "x-text",
                "x-editor",
                "x-format",
                "x-ui",
            ],
        ),
        (
            "x-board",
            vec!["x-core", "x-editor", "x-render", "x-format", "x-ui"],
        ),
        // The wasm bridge deliberately sits at the edge of the graph: it may
        // depend on the engine, and nothing may depend on it. See
        // docs/ARCHITECTURE_BOUNDARY.md.
        ("x-wasm", vec!["x-core", "x-format"]),
        ("x-designer", vec!["x-native", "x-board"]),
    ]);
    for (krate, deps) in &g {
        let Some(ok) = allowed.get(krate.as_str()) else {
            panic!("unknown crate '{krate}' — add it to the allowed graph deliberately");
        };
        for d in deps {
            assert!(
                ok.contains(&d.as_str()),
                "FORBIDDEN EDGE: {krate} -> {d}\nallowed deps for {krate}: {ok:?}"
            );
        }
    }
    // the headless rule, stated twice on purpose:
    assert!(
        g["x-core"].is_empty(),
        "x-core must depend on NOTHING internal (headless rule)"
    );
}

#[test]
fn no_cycles_in_production_graph() {
    let g = load_graph();
    fn visit(g: &HashMap<String, Vec<String>>, node: &str, stack: &mut Vec<String>) {
        assert!(
            !stack.iter().any(|s| s == node),
            "CYCLE: {stack:?} -> {node}"
        );
        stack.push(node.to_string());
        for d in g.get(node).cloned().unwrap_or_default() {
            visit(g, &d, stack);
        }
        stack.pop();
    }
    for k in g.keys() {
        visit(&g, k, &mut vec![]);
    }
}

#[test]
fn x_core_is_headless_no_gpu_or_windowing_types() {
    // x-core may use kurbo/peniko types (geometry/paint data) but must
    // never touch Scene/Renderer/wgpu/winit — proving server/CLI usability.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/x-core/src");
    let mut checked = 0;
    for entry in std::fs::read_dir(&root).unwrap().flatten() {
        let p = entry.path();
        if p.extension().is_some_and(|x| x == "rs") {
            let src = std::fs::read_to_string(&p).unwrap();
            for forbidden in ["vello::Scene", "wgpu::", "winit::", "Renderer"] {
                assert!(
                    !src.contains(forbidden),
                    "{}: x-core must not reference {forbidden}",
                    p.display()
                );
            }
            checked += 1;
        }
    }
    assert!(checked > 5, "expected to scan x-core sources");
}
