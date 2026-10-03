//! Scale benchmarks (beta checklist): 1k → 100k nodes, plus a mixed
//! workload (shapes + text + images + instances + gradients) that
//! resembles a real document instead of a rectangle farm.
//!
//! Measures the CPU side of the pipeline — build_render_tree (IR
//! lowering) and VelloSink::render (scene encode) — which is where node
//! count bites. GPU submit is excluded on purpose: it needs a display
//! and is constant-ish per frame area.
// This binary replaces the global allocator, which is inherently `unsafe`.
// It is the only place in the workspace that needs it, and the workspace lints
// (`unsafe_code = "deny"`) prove that: remove this attribute and CI tells you.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use x_native::{
    build_render_tree, Assets, Color, FrameCache, GradSpace, Node, Paint, Variables, VelloSink,
};

// ---- memory profiling: counting allocator (peak + live bytes) ----
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let live = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        System.dealloc(p, l);
    }
}
#[global_allocator]
static A: Counting = Counting;
fn mem_mb() -> (f64, f64) {
    (
        LIVE.load(Ordering::Relaxed) as f64 / 1e6,
        PEAK.load(Ordering::Relaxed) as f64 / 1e6,
    )
}
use std::time::Instant;
use x_native::text::{FontManager, ShapedTextCache};

fn rect_farm(n: usize) -> Node {
    let mut page = Node::frame("page", 4000.0, 4000.0);
    let cols = (n as f64).sqrt().ceil() as usize;
    for i in 0..n {
        let (c, r) = (i % cols, i / cols);
        page.children.push(
            Node::rect(
                &format!("r{i}"),
                c as f64 * 12.0,
                r as f64 * 12.0,
                10.0,
                10.0,
                Color::from_rgb8((i % 255) as u8, 0x99, 0xff),
            )
            .radius(2.0),
        );
    }
    page
}

fn mixed_workload(n: usize) -> Node {
    let mut page = Node::frame("page", 4000.0, 4000.0);
    // one component master, instanced heavily (the realistic pattern)
    page.children.push(
        Node::component("m", "Chip", 60.0, 24.0)
            .child(
                Node::rect(
                    "m-bg",
                    0.0,
                    0.0,
                    60.0,
                    24.0,
                    Color::from_rgb8(0x0d, 0x99, 0xff),
                )
                .radius(6.0),
            )
            .child(Node::text("m-t", 8.0, 5.0, 44.0, 12.0, "CHIP")),
    );
    let cols = (n as f64).sqrt().ceil() as usize;
    for i in 0..n {
        let (c, r) = (i % cols, i / cols);
        let (x, y) = (c as f64 * 70.0, r as f64 * 30.0);
        let id = format!("n{i}");
        page.children.push(match i % 5 {
            0 => Node::rect(&id, x, y, 60.0, 24.0, Color::from_rgb8(0xf3, 0x9c, 0x12)).radius(4.0),
            1 => Node::ellipse(&id, x, y, 24.0, 24.0, Color::from_rgb8(0x2e, 0xcc, 0x71)),
            2 => Node::text(&id, x, y, 60.0, 12.0, "lorem ipsum"),
            3 => {
                Node::rect(&id, x, y, 60.0, 24.0, Color::WHITE).fill_paint(Paint::LinearGradient {
                    start: (0.0, 0.0),
                    end: (60.0, 0.0),
                    stops: vec![
                        (0.0, Color::from_rgb8(255, 90, 0)),
                        (1.0, Color::from_rgb8(142, 45, 226)),
                    ],
                    space: GradSpace::Srgb,
                })
            }
            _ => Node::instance(&id, "Chip", x, y, 60.0, 24.0),
        });
    }
    page
}

fn bench(name: &str, page: &Node, fonts: &FontManager, budget_ms: u128) {
    let vars = Variables::default();
    let assets = Assets::new();
    let sink = VelloSink {
        assets: Some(&assets),
        fonts: Some(fonts),
    };
    // COLD: first frame, empty shaped-text cache for this content
    ShapedTextCache::global().clear();
    let t0 = Instant::now();
    let tree = build_render_tree(page, &vars);
    let t_ir_cold = t0.elapsed();
    let t1 = Instant::now();
    let _scene = sink.render(&tree);
    let t_encode_cold = t1.elapsed();
    // WARM: steady-state frame (what interaction latency actually is)
    let t2 = Instant::now();
    let tree2 = build_render_tree(page, &vars);
    let t_ir = t2.elapsed();
    let t3 = Instant::now();
    let _scene2 = sink.render(&tree2);
    let t_encode = t3.elapsed();
    let warm_total = (t_ir + t_encode).as_millis();
    let (hits, misses) = ShapedTextCache::global().stats();
    println!(
        "{name:<14} nodes={:<7} cold={:>8.2?} warm: ir={:>8.2?} encode={:>8.2?} total={:>8.2?} cache {}h/{}m {}",
        count(page), t_ir_cold + t_encode_cold, t_ir, t_encode, t_ir + t_encode,
        hits, misses,
        if warm_total <= budget_ms { format!("<= {budget_ms}ms ✓") } else { format!("OVER {budget_ms}ms ✗") }
    );
}

fn count(n: &Node) -> usize {
    1 + n.children.iter().map(count).sum::<usize>()
}

/// INTERACTION frame with an optional viewport (the app always has one).
fn bench_interaction_vp(
    name: &str,
    mut page: Node,
    fonts: &FontManager,
    budget_ms: u128,
    vp: Option<vello::kurbo::Rect>,
) {
    let vars = Variables::default();
    let assets = Assets::new();
    let sink = VelloSink {
        assets: Some(&assets),
        fonts: Some(fonts),
    };
    let mut fc = FrameCache::new();
    fc.render_viewport(&page, &vars, &sink, vp); // prime
                                                 // move a node that's INSIDE the viewport (the realistic drag)
    let idx = if vp.is_some() {
        3
    } else {
        page.children.len() / 2
    };
    let mut worst = std::time::Duration::ZERO;
    let mut total = std::time::Duration::ZERO;
    const FRAMES: u32 = 10;
    for f in 0..FRAMES {
        page.children[idx].transform.x += 3.0 + f as f64;
        let t = Instant::now();
        fc.render_viewport(&page, &vars, &sink, vp);
        let dt = t.elapsed();
        total += dt;
        if dt > worst {
            worst = dt;
        }
    }
    let avg = total / FRAMES;
    let st = fc.stats;
    println!(
        "{name:<14} drag-frame avg={avg:>8.2?} worst={worst:>8.2?} (hash={:.1}ms lower={:.1}ms encode={:.1}ms, {}/{} reused, {} culled) {}",
        st.hash_ms, st.lower_ms, st.encode_ms, st.segments_reused, st.segments_total, st.culled,
        if avg.as_millis() <= budget_ms { format!("<= {budget_ms}ms ✓") } else { format!("OVER {budget_ms}ms ✗") }
    );
}

fn main() {
    let mut fonts = FontManager::new();
    fonts.load_system_fonts();
    // acceptance criteria (review): 1k<=16.7ms, 10k<=33ms, 100k<=100ms warm
    println!("--- rect farm (uniform) ---");
    for (n, budget) in [(1_000, 17), (10_000, 33), (50_000, 66), (100_000, 100)] {
        bench(&format!("rects/{n}"), &rect_farm(n), &fonts, budget);
    }
    println!("--- mixed workload (rect/ellipse/text/gradient/instance) ---");
    for (n, budget) in [(1_000, 17), (10_000, 33), (50_000, 66), (100_000, 100)] {
        bench(&format!("mixed/{n}"), &mixed_workload(n), &fonts, budget);
    }
    println!("--- INTERACTION: FrameCache, one node moving per frame ---");
    for (n, budget) in [(1_000, 17), (10_000, 33), (100_000, 100)] {
        bench_interaction_vp(
            &format!("mixed/{n}"),
            mixed_workload(n),
            &fonts,
            budget,
            None,
        );
        let (live, peak) = mem_mb();
        let (cache_bytes, evictions) = x_native::text::ShapedTextCache::global().memory();
        println!(
            "  mem: live={live:.1}MB peak={peak:.1}MB | text-cache {:.1}MB ({evictions} evictions)",
            cache_bytes as f64 / 1e6
        );
    }
    println!("--- INTERACTION + VIEWPORT (app conditions: ~1500x1000 window) ---");
    for (n, budget) in [(10_000, 17), (100_000, 33)] {
        // the app's actual situation: only the viewport region visible
        let vp = vello::kurbo::Rect::new(0.0, 0.0, 1500.0, 1000.0);
        bench_interaction_vp(
            &format!("mixed/{n}"),
            mixed_workload(n),
            &fonts,
            budget,
            Some(vp),
        );
    }
}
