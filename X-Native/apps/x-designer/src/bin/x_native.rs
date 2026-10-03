//! Demo driver for the v0.4 engine: builds a document exercising every new
//! phase slice, runs the headless editor through a scripted session
//! (select → move → undo → group → save/load → SVG export → prototype
//! playback), and prints verifiable stats for each step.

// The toolkit lives beside this driver (not in `src/bin/`, where Cargo would
// treat it as its own binary target).
#[path = "x_native/toolkit.rs"]
mod toolkit;

use vello::kurbo::{Point, Rect};
use x_native::editor::{align, hit_test, AlignKind, Editor, Player, SpatialGrid};
use x_native::fileio::{export_svg, load_x, save_x};
use x_native::{
    apply_layout_recursive, build_scene, AutoLayout, BlendKind, Color, CrossAlign, Document,
    Effect, GradSpace, LayoutDirection, Node, Paint, Sizing, Variables, Viewport, PI,
};

/// `x_native mcp [file.x]` — MCP server over stdio (newline-delimited
/// JSON-RPC). Without a file argument it serves a small demo document.
fn mcp_main(path: Option<&str>) {
    let doc = match path {
        Some(p) => match std::fs::read_to_string(p)
            .map_err(|e| e.to_string())
            .and_then(|t| x_native::fileio::load_x(&t).map_err(|e| e.to_string()))
        {
            Ok(d) => d,
            Err(e) => {
                eprintln!("mcp: cannot load {p}: {e}");
                return;
            }
        },
        None => {
            let mut d = x_native::Document::default();
            let mut page = x_native::Node::frame("demo", 400.0, 300.0);
            page.name = "Demo".into();
            page.children.push(x_native::Node::rect(
                "card",
                0.0,
                0.0,
                120.0,
                60.0,
                x_native::Color::from_rgb8(0x33, 0x66, 0xff),
            ));
            page.children.push(x_native::Node::text(
                "title",
                0.0,
                0.0,
                120.0,
                16.0,
                "Hello MCP",
            ));
            d.pages.push(page);
            d.variables.numbers.insert("gap".into(), 8.0);
            d
        }
    };
    eprintln!(
        "x-native MCP server ready ({} pages) — JSON-RPC on stdin",
        doc.pages.len()
    );
    use std::io::BufRead;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rsp) = x_native::mcp::mcp_handle(line, &doc) {
            println!("{rsp}");
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("mcp") {
        mcp_main(args.get(2).map(String::as_str));
        return;
    }
    if args.get(1).map(String::as_str) == Some("import-fig") {
        let Some(in_path) = args.get(2) else {
            eprintln!("usage: x_native import-fig <file.fig> [out.x]");
            std::process::exit(2);
        };
        let bytes = match std::fs::read(in_path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("import-fig: read {in_path}: {e}");
                std::process::exit(1);
            }
        };
        match x_native::fileio::import_fig_bytes_with_report(&bytes) {
            Ok((doc, report)) => {
                let out = args
                    .get(3)
                    .cloned()
                    .unwrap_or_else(|| in_path.replace(".fig", ".x"));
                if let Err(e) = std::fs::write(&out, x_native::fileio::save_x(&doc)) {
                    eprintln!("import-fig: write {out}: {e}");
                    std::process::exit(1);
                }
                println!(
                    "import-fig: {} -> {out} (pages={}, nodes={}, assets={}, {} diagnostics)",
                    in_path,
                    doc.pages.len(),
                    report.nodes_imported,
                    report.assets_imported,
                    report.diagnostics.len()
                );
                for d in report.diagnostics.iter().take(8) {
                    println!("  note: {d}");
                }
                return;
            }
            Err(e) => {
                eprintln!("import-fig: {in_path}: {e}");
                std::process::exit(1);
            }
        }
    }
    // ————————————————— headless toolkit: inspect / lint / analyze / codegen
    // (one module owns the flag grammar, help text and exit codes)
    if let Some(verb) = args.get(1).map(String::as_str) {
        match verb {
            "--help" | "-h" | "help" => {
                std::process::exit(toolkit::print_help(args.get(2).map(String::as_str)));
            }
            "--version" | "-V" | "version" => {
                println!("{}", toolkit::version());
                return;
            }
            _ if toolkit::is_toolkit(verb) => {
                std::process::exit(toolkit::dispatch(verb, &args[2..]));
            }
            _ if !matches!(verb, "mcp" | "import-fig" | "export-html") => {
                eprintln!("x_native: unknown verb '{verb}'\n\n{}", toolkit::SUMMARY);
                std::process::exit(2);
            }
            _ => {}
        }
    }
    if args.get(1).map(String::as_str) == Some("export-html") {
        let (Some(in_path), Some(out_dir)) = (args.get(2), args.get(3)) else {
            eprintln!("usage: x_native export-html <file.x> <outdir> [--optimize] [--fonts]");
            std::process::exit(2);
        };
        let text = match std::fs::read_to_string(in_path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("export-html: read {in_path}: {e}");
                std::process::exit(1);
            }
        };
        let doc = match x_native::fileio::load_x(&text) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("export-html: parse {in_path}: {e}");
                std::process::exit(1);
            }
        };
        let mut fonts = x_native::text::FontManager::new();
        if args.iter().any(|a| a == "--fonts") {
            fonts.load_system_fonts();
        }
        let opts = x_native::HtmlExportOptions {
            optimize_images: args.iter().any(|a| a == "--optimize"),
            max_image_dim: Some(2048),
            embed_subset_fonts: args.iter().any(|a| a == "--fonts"),
        };
        match x_native::export_html(&doc, std::path::Path::new(out_dir), &fonts, &opts) {
            Ok(rep) => {
                println!(
                    "export-html: {out_dir}/ pages={} nodes={} assets={} fonts={:?} saved={}B",
                    rep.pages, rep.nodes, rep.assets_written, rep.fonts_embedded, rep.bytes_saved
                );
                for n in rep.notes.iter().take(8) {
                    println!("  note: {n}");
                }
                return;
            }
            Err(e) => {
                eprintln!("export-html: {e}");
                std::process::exit(1);
            }
        }
    }

    // ---- variables v2: modes + aliases -----------------------------------
    let mut vars = Variables::default();
    vars.colors
        .insert("bg".into(), Color::from_rgb8(0xff, 0xff, 0xff));
    vars.aliases.insert("surface".into(), "bg".into());
    let mut dark = std::collections::HashMap::new();
    dark.insert("bg".to_string(), Color::from_rgb8(0x1e, 0x1e, 0x1e));
    vars.modes.insert("dark".into(), dark);
    vars.numbers.insert("gap-lg".into(), 28.0);

    // ---- document: text, gradients, shadows, blend, layout v2 ------------
    let page = Node::frame("page-1", 1000.0, 700.0)
        .auto_layout(AutoLayout {
            direction: LayoutDirection::Horizontal,
            gap: 20.0,
            padding: [24.0; 4],
            sizing: Sizing::Fixed,
            align: CrossAlign::Center,
            gap_var: Some("gap-lg".into()),
            ..Default::default()
        })
        .child(
            Node::rect(
                "card",
                0.0,
                0.0,
                240.0,
                140.0,
                Color::from_rgb8(0x0d, 0x99, 0xff),
            )
            .radius(18.0)
            .rotate(PI / 8.0)
            .effect(Effect::DropShadow {
                dx: 4.0,
                dy: 6.0,
                blur: 10.0,
                color: Color::BLACK,
            }),
        )
        .child(
            Node::rect("grad", 0.0, 0.0, 200.0, 120.0, Color::WHITE).fill_paint(
                Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (200.0, 0.0),
                    stops: vec![
                        (0.0, Color::from_rgb8(0xff, 0x5a, 0x00)),
                        (1.0, Color::from_rgb8(0x8e, 0x2d, 0xe2)),
                    ],
                    space: GradSpace::Srgb,
                },
            ),
        )
        .child(
            Node::ellipse(
                "dot",
                0.0,
                0.0,
                120.0,
                120.0,
                Color::from_rgb8(0xf2, 0x48, 0x22),
            )
            .opacity(0.75)
            .blend(BlendKind::Multiply),
        )
        .child(Node::text("title", 0.0, 0.0, 220.0, 30.0, "X NATIVE 0.4").prototype("page-2", 250));

    let mut doc = Document::new();
    doc.variables = vars.clone();
    doc.pages.push(page);
    doc.pages.push(
        Node::frame("page-2", 1000.0, 700.0)
            .child(Node::text("t2", 40.0, 40.0, 300.0, 40.0, "SCREEN 2")),
    );

    // layout v2 (recursive)
    for p in &mut doc.pages {
        apply_layout_recursive(p, &vars);
    }

    let (scene, stats) = build_scene(
        &doc.pages[0],
        Some(Viewport {
            x: 0.0,
            y: 0.0,
            w: 1000.0,
            h: 700.0,
        }),
        &vars,
    );
    println!(
        "render:      nodes={} paths={} culled={} vello_paths={} (text now DRAWS)",
        stats.nodes,
        stats.paths,
        stats.culled,
        scene.encoding().n_paths
    );

    // ---- editor session: hit test, move, undo, group ----------------------
    let mut ed = Editor::new(doc.pages[0].clone());
    let card_center = {
        let c = x_native::editor::find(&ed.root, "card").unwrap();
        Point::new(c.transform.x + c.w / 2.0, c.transform.y + c.h / 2.0)
    };
    ed.click(card_center, false);
    println!(
        "hit+select:  clicked {:?} -> selection={:?}",
        (card_center.x, card_center.y),
        ed.selection
    );

    ed.move_selection(15.0, -10.0);
    ed.undo();
    ed.redo();
    println!(
        "undo/redo:   card.x after move+undo+redo = {}",
        x_native::editor::find(&ed.root, "card")
            .unwrap()
            .transform
            .x
    );

    ed.marquee(Rect::new(0.0, 0.0, 1000.0, 700.0));
    println!("marquee:     selected {} nodes", ed.selection.len());

    ed.selection = vec!["grad".into(), "dot".into()];
    ed.group_selection("group-1");
    println!(
        "group:       group-1 children={}",
        x_native::editor::find(&ed.root, "group-1")
            .unwrap()
            .children
            .len()
    );
    ed.undo();
    println!(
        "ungroup(undo): group exists = {}",
        x_native::editor::find(&ed.root, "group-1").is_some()
    );

    align(
        &mut ed.root,
        &["card".to_string(), "title".to_string()],
        AlignKind::Top,
    );

    // ---- variables v2 -----------------------------------------------------
    let mut dark_vars = vars.clone();
    dark_vars.active_mode = Some("dark".into());
    println!(
        "variables:   surface(light)={} surface(dark)={}",
        x_native::color_to_hex(vars.color("surface", Color::BLACK)),
        x_native::color_to_hex(dark_vars.color("surface", Color::BLACK)),
    );

    // ---- .x save/load roundtrip -------------------------------------------
    let saved = save_x(&doc);
    let loaded = load_x(&saved).expect("load_x");
    let roundtrip_ok = save_x(&loaded) == saved;
    println!(
        ".x format:   {} bytes, roundtrip stable = {}",
        saved.len(),
        roundtrip_ok
    );

    // ---- SVG export --------------------------------------------------------
    let svg = export_svg(&doc.pages[0], &vars);
    std::fs::write("export_page1.svg", &svg).ok();
    println!("svg export:  {} bytes -> export_page1.svg", svg.len());

    // ---- prototype playback ------------------------------------------------
    let proto_doc = Node::frame("proto", 2000.0, 700.0)
        .child(doc.pages[0].clone())
        .child(doc.pages[1].clone());
    let mut player = Player::new(&proto_doc, "page-1");
    let title_pos = {
        let f = x_native::editor::find(&proto_doc, "page-1").unwrap();
        let t = x_native::editor::find(f, "title").unwrap();
        Point::new(t.transform.x + 10.0, t.transform.y + 10.0)
    };
    let ms = player.click(title_pos);
    let after_click = player.current.clone();
    player.back();
    println!(
        "prototype:   click title -> {} (transition {:?}ms), back() -> {}",
        after_click, ms, player.current
    );

    // ---- spatial index at 100K ---------------------------------------------
    let big = x_native::benchmark_scene(100_000);
    let t0 = std::time::Instant::now();
    let grid = SpatialGrid::build(&big, 256.0);
    let built = t0.elapsed();
    let t1 = std::time::Instant::now();
    let hits = grid.query_point(Point::new(1000.0, 1000.0)).len();
    let q = t1.elapsed();
    println!(
        "spatial:     100K nodes indexed in {:?}, point query {:?} ({} hits)",
        built, q, hits
    );
    // linear hit test comparison
    let t2 = std::time::Instant::now();
    let _ = hit_test(&big, Point::new(1000.0, 1000.0));
    println!("             vs full-tree hit_test {:?}", t2.elapsed());

    // ---- copy/paste/duplicate (Phase 2.7) -----------------------------------
    ed.selection = vec!["card".into()];
    ed.copy();
    let pasted = ed.paste("page-1", (24.0, 24.0));
    println!("copy/paste:  pasted ids={:?}, undoable={}", pasted, {
        ed.undo();
        x_native::editor::find(&ed.root, "card-copy").is_none()
    });

    // ---- editable vectors (Phase 2.6) ----------------------------------------
    let star = Node::vector(
        "star",
        0.0,
        0.0,
        100.0,
        100.0,
        vec![
            x_native::PathCmd::MoveTo(50.0, 0.0),
            x_native::PathCmd::LineTo(79.0, 91.0),
            x_native::PathCmd::LineTo(2.0, 35.0),
            x_native::PathCmd::LineTo(98.0, 35.0),
            x_native::PathCmd::LineTo(21.0, 91.0),
            x_native::PathCmd::Close,
        ],
    );
    let (_, vs) = build_scene(&star, None, &vars);
    println!("vector node: star path -> {} draw path(s)", vs.paths);

    // ---- SVG import (Phase 7.4) ----------------------------------------------
    let reimported = x_native::fileio::import_svg(&svg).expect("re-import own export");
    let (_, ris) = build_scene(&reimported, None, &vars);
    println!(
        "svg import:  re-imported own export -> {} nodes, {} paths",
        ris.nodes, ris.paths
    );

    // ---- smart animate (Phase 8.3) --------------------------------------------
    let from = Node::frame("s1", 400.0, 400.0).child(Node::rect(
        "box",
        0.0,
        0.0,
        100.0,
        100.0,
        Color::from_rgb8(255, 0, 0),
    ));
    let to = Node::frame("s2", 400.0, 400.0).child(Node::rect(
        "box",
        200.0,
        100.0,
        200.0,
        100.0,
        Color::from_rgb8(0, 0, 255),
    ));
    let mid = x_native::editor::smart_animate(&from, &to, 0.5);
    let b = x_native::editor::find(&mid, "box").unwrap();
    println!(
        "smart anim:  t=0.5 -> x={} w={} fill={}",
        b.transform.x,
        b.w,
        if let x_native::Paint::Solid(c) = &b.fill {
            x_native::color_to_hex(*c)
        } else {
            "?".into()
        }
    );

    // ---- dev mode -----------------------------------------------------------
    let css =
        x_native::editor::node_to_css(x_native::editor::find(&ed.root, "card").unwrap(), &vars);
    println!("dev mode CSS for #card:\n{css}");

    // ---- stress (unchanged from v0.3) ---------------------------------------
    for n in [10_000usize, 50_000] {
        let (s, st) = build_scene(&x_native::benchmark_scene(n), None, &vars);
        println!(
            "stress {} nodes: encoded={} paths={} vello_paths={}",
            n,
            st.nodes,
            st.paths,
            s.encoding().n_paths
        );
    }
}
