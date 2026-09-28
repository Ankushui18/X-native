//! Sprint 3 measurement probe: complex inputs through the Rust Outline Stroke
//! (`stroke_outline::outline_stroke_path`) and the shared simplifier.
//!
//! This is a *diagnostic*, not a gate. It is `#[ignore]` so the normal
//! `cargo test` stays fast, and it never fails on a measurement: it prints one
//! `PROBE|…` line per case so CI can publish the numbers. The only assertions
//! are the simplifier's contract (no overflow, tolerance bound), which Phase 1
//! fixed and must keep.
//!
//! Run: cargo test -p x-core --release --test vector_probe -- --ignored --nocapture
//!
//! Columns (outline): anchors, contours, self-crossings inside one contour,
//! crossings between contours, median ms over the runs, ink coverage (share of
//! samples placed at 60% of the local half-width either side of the
//! centerline — and, on dashed cases, only inside painted dashes — that the
//! output fills under NONZERO), and the error string when the call refuses.

use std::time::Instant;
use x_core::simplify::{segment_distance_sq, simplify_keep};
use x_core::stroke_outline::{outline_stroke_path, sample_width_profile};
use x_core::{PathCmd, StrokeCap, StrokeJoin, StrokeOptions, VariableWidthPoint};

type Pt = (f64, f64);

fn contours(path: &[PathCmd]) -> Vec<Vec<Pt>> {
    let mut out: Vec<Vec<Pt>> = Vec::new();
    let mut cur: Vec<Pt> = Vec::new();
    for c in path {
        match *c {
            PathCmd::MoveTo(x, y) => {
                if cur.len() > 1 {
                    out.push(std::mem::take(&mut cur));
                }
                cur.clear();
                cur.push((x, y));
            }
            PathCmd::LineTo(x, y) => cur.push((x, y)),
            PathCmd::CurveTo(_, _, _, _, x, y) => cur.push((x, y)),
            PathCmd::Close => {
                if cur.len() > 1 {
                    out.push(std::mem::take(&mut cur));
                }
            }
        }
    }
    if cur.len() > 1 {
        out.push(cur);
    }
    out
}

fn orient(a: Pt, b: Pt, c: Pt) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// Proper crossing of two segments (shared endpoints and touching do not count).
fn crosses(a: Pt, b: Pt, c: Pt, d: Pt) -> bool {
    let (d1, d2) = (orient(a, b, c), orient(a, b, d));
    let (d3, d4) = (orient(c, d, a), orient(c, d, b));
    let eps = 1e-9;
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps))
        && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
}

fn edges(ring: &[Pt]) -> Vec<(Pt, Pt)> {
    (0..ring.len())
        .map(|i| (ring[i], ring[(i + 1) % ring.len()]))
        .collect()
}

/// (self-crossings summed over contours, crossings between contours).
fn crossings(rings: &[Vec<Pt>]) -> (usize, usize) {
    let all: Vec<Vec<(Pt, Pt)>> = rings.iter().map(|r| edges(r.as_slice())).collect();
    let mut own = 0;
    for e in &all {
        let n = e.len();
        for (i, a) in e.iter().enumerate() {
            for (j, b) in e.iter().enumerate().skip(i + 2) {
                if i == 0 && j == n - 1 {
                    continue;
                }
                if crosses(a.0, a.1, b.0, b.1) {
                    own += 1;
                }
            }
        }
    }
    let mut between = 0;
    for (ri, a) in all.iter().enumerate() {
        for b in all.iter().skip(ri + 1) {
            for s in a {
                for t in b {
                    if crosses(s.0, s.1, t.0, t.1) {
                        between += 1;
                    }
                }
            }
        }
    }
    (own, between)
}

fn winding(rings: &[Vec<Pt>], p: Pt) -> i32 {
    let mut w = 0;
    for r in rings {
        for (a, b) in edges(r) {
            if a.1 <= p.1 {
                if b.1 > p.1 && orient(a, b, p) > 0.0 {
                    w += 1;
                }
            } else if b.1 <= p.1 && orient(a, b, p) < 0.0 {
                w -= 1;
            }
        }
    }
    w
}

/// Densely sampled centerline (every command flattened at 64 steps).
fn centerline(path: &[PathCmd]) -> Vec<Pt> {
    let mut out: Vec<Pt> = Vec::new();
    let mut start = (0.0, 0.0);
    for c in path {
        let from = out.last().copied().unwrap_or(start);
        match *c {
            PathCmd::MoveTo(x, y) => {
                start = (x, y);
                out.push(start);
            }
            PathCmd::LineTo(x, y) => {
                for k in 1..=64 {
                    let t = f64::from(k) / 64.0;
                    out.push((from.0 + (x - from.0) * t, from.1 + (y - from.1) * t));
                }
            }
            PathCmd::CurveTo(ax, ay, bx, by, x, y) => {
                for k in 1..=64 {
                    let t = f64::from(k) / 64.0;
                    let m = 1.0 - t;
                    let f = |p0: f64, p1: f64, p2: f64, p3: f64| {
                        m * m * m * p0 + 3.0 * m * m * t * p1 + 3.0 * m * t * t * p2 + t * t * t * p3
                    };
                    out.push((f(from.0, ax, bx, x), f(from.1, ay, by, y)));
                }
            }
            PathCmd::Close => {
                for k in 1..=64 {
                    let t = f64::from(k) / 64.0;
                    out.push((from.0 + (start.0 - from.0) * t, from.1 + (start.1 - from.1) * t));
                }
            }
        }
    }
    out
}

/// Share of interior ink samples the outline fills (NONZERO).
fn coverage(path: &[PathCmd], rings: &[Vec<Pt>], width: f64, opts: &StrokeOptions) -> f64 {
    let line = centerline(path);
    let mut lens = vec![0.0];
    for w in line.windows(2) {
        let last = *lens.last().unwrap_or(&0.0);
        lens.push(last + (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1));
    }
    let total = *lens.last().unwrap_or(&0.0);
    let period: f64 = opts.dash.iter().sum();
    let (mut hit, mut n) = (0usize, 0usize);
    for i in 1..line.len().saturating_sub(1) {
        let s = lens[i];
        // Stay clear of ends and dash boundaries: caps are not under test.
        if s < width || total - s < width {
            continue;
        }
        if period > 0.0 {
            let on = opts.dash.first().copied().unwrap_or(period);
            let phase = s % period;
            if !(width * 0.5..=on - width * 0.5).contains(&phase) {
                continue;
            }
        }
        let (dx, dy) = (line[i + 1].0 - line[i - 1].0, line[i + 1].1 - line[i - 1].1);
        let len = dx.hypot(dy);
        if len < 1e-9 {
            continue;
        }
        let half = 0.5 * width * sample_width_profile(&opts.width_profile, s / total);
        let (nx, ny) = (-dy / len * half * 0.6, dx / len * half * 0.6);
        for p in [(line[i].0 + nx, line[i].1 + ny), (line[i].0 - nx, line[i].1 - ny)] {
            n += 1;
            if winding(rings, p) != 0 {
                hit += 1;
            }
        }
    }
    if n == 0 {
        return 1.0;
    }
    hit as f64 / n as f64
}

fn poly(pts: &[Pt], closed: bool) -> Vec<PathCmd> {
    let mut out: Vec<PathCmd> = pts
        .iter()
        .enumerate()
        .map(|(i, &(x, y))| if i == 0 { PathCmd::MoveTo(x, y) } else { PathCmd::LineTo(x, y) })
        .collect();
    if closed {
        out.push(PathCmd::Close);
    }
    out
}

fn hand(n: usize) -> Vec<Pt> {
    let mut seed: u64 = 7;
    (0..n)
        .map(|i| {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let jitter = ((seed >> 33) as f64 / f64::from(u32::MAX) - 0.25) * 3.0;
            let t = i as f64 / (n - 1) as f64;
            (t * 800.0, 100.0 * (t * 12.0).sin() + jitter)
        })
        .collect()
}

fn acute(deg: f64) -> Vec<Pt> {
    let r = deg.to_radians();
    vec![(0.0, 0.0), (200.0, 0.0), (200.0 - 197.0 * r.cos(), 197.0 * r.sin())]
}

fn star() -> Vec<Pt> {
    (0..10)
        .map(|i| {
            let r = if i % 2 == 1 { 15.0 } else { 100.0 };
            let a = f64::from(i) * std::f64::consts::PI / 5.0;
            (r * a.cos(), r * a.sin())
        })
        .collect()
}

fn bulge() -> Vec<VariableWidthPoint> {
    vec![
        VariableWidthPoint { position: 0.0, width_multiplier: 0.2 },
        VariableWidthPoint { position: 0.5, width_multiplier: 3.0 },
        VariableWidthPoint { position: 1.0, width_multiplier: 0.2 },
    ]
}

fn opts(join: StrokeJoin, cap: StrokeCap) -> StrokeOptions {
    StrokeOptions { join, cap_start: cap, cap_end: cap, ..StrokeOptions::default() }
}

fn run(name: &str, path: &[PathCmd], width: f64, o: &StrokeOptions) {
    let mut times: Vec<f64> = Vec::new();
    let mut last = None;
    for _ in 0..5 {
        let t = Instant::now();
        let r = outline_stroke_path(path, width, o);
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        last = Some(r);
    }
    times.sort_by(f64::total_cmp);
    let ms = times[times.len() / 2];
    match last {
        Some(Ok(out)) => {
            let rings = contours(&out.path);
            let anchors: usize = rings.iter().map(Vec::len).sum();
            let (own, between) = crossings(&rings);
            let cov = coverage(path, &rings, width, o);
            println!(
                "PROBE|outline|{name}|anchors={anchors}|contours={}|selfX={own}|crossX={between}|ms={ms:.3}|coverage={:.1}%",
                rings.len(),
                cov * 100.0
            );
        }
        Some(Err(e)) => println!("PROBE|outline|{name}|refused=\"{e}\"|ms={ms:.3}"),
        None => {}
    }
}

#[test]
#[ignore = "diagnostic probe; run with --ignored --nocapture (CI publishes it)"]
fn outline_probe() {
    for (tag, join) in [("miter", StrokeJoin::Miter), ("bevel", StrokeJoin::Bevel), ("round", StrokeJoin::Round)] {
        run(&format!("acute10-{tag}"), &poly(&acute(10.0), false), 20.0, &opts(join, StrokeCap::None));
        run(&format!("acute30-{tag}"), &poly(&acute(30.0), false), 20.0, &opts(join, StrokeCap::None));
        run(&format!("star-{tag}"), &poly(&star(), true), 12.0, &opts(join, StrokeCap::None));
        let vw = StrokeOptions { width_profile: bulge(), ..opts(join, StrokeCap::None) };
        run(&format!("acute10-vw-{tag}"), &poly(&acute(10.0), false), 20.0, &vw);
    }
    let square = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)];
    run("square-miter(control)", &poly(&square, true), 20.0, &opts(StrokeJoin::Miter, StrokeCap::None));
    let dashed = StrokeOptions { dash: vec![30.0, 10.0], ..opts(StrokeJoin::Miter, StrokeCap::Round) };
    run("acute10-dash30/10", &poly(&acute(10.0), false), 20.0, &dashed);
    let dashed_vw = StrokeOptions { width_profile: bulge(), ..dashed };
    run("acute10-dash-vw", &poly(&acute(10.0), false), 20.0, &dashed_vw);
    let curve = [
        PathCmd::MoveTo(0.0, 0.0),
        PathCmd::CurveTo(0.0, 200.0, 300.0, -200.0, 300.0, 0.0),
    ];
    run("s-curve-round", &curve, 16.0, &opts(StrokeJoin::Round, StrokeCap::Round));
    let h = poly(&hand(1000), false);
    run("hand1000-round", &h, 8.0, &opts(StrokeJoin::Round, StrokeCap::Round));
    run("hand1000-miter", &h, 8.0, &opts(StrokeJoin::Miter, StrokeCap::None));
    let hvw = StrokeOptions { width_profile: bulge(), ..opts(StrokeJoin::Round, StrokeCap::Round) };
    run("hand1000-vw", &h, 8.0, &hvw);
    let hd = StrokeOptions { dash: vec![12.0, 6.0], ..opts(StrokeJoin::Round, StrokeCap::Round) };
    run("hand1000-dash", &h, 8.0, &hd);
    run("hand5000-round", &poly(&hand(5000), false), 8.0, &opts(StrokeJoin::Round, StrokeCap::Round));
}

fn max_deviation(pts: &[Pt], keep: &[bool]) -> f64 {
    let kept: Vec<usize> = (0..pts.len()).filter(|&i| keep[i]).collect();
    let mut worst = 0.0f64;
    for w in kept.windows(2) {
        for p in &pts[w[0]..=w[1]] {
            worst = worst.max(segment_distance_sq(*p, pts[w[0]], pts[w[1]]).sqrt());
        }
    }
    worst
}

#[test]
#[ignore = "diagnostic probe; run with --ignored --nocapture (CI publishes it)"]
fn simplify_probe() {
    let zig = |n: usize| (0..n).map(|i| (i as f64, (i % 2) as f64 * 3.0)).collect::<Vec<Pt>>();
    let spiral = |n: usize| {
        (0..n)
            .map(|i| {
                let a = i as f64 * 0.05;
                let r = 10.0 + i as f64 * 0.5;
                (r * a.cos(), r * a.sin())
            })
            .collect::<Vec<Pt>>()
    };
    let cases: Vec<(String, Vec<Pt>, f64)> = vec![
        ("hand1000".into(), hand(1000), 1.5),
        ("hand8000".into(), hand(8000), 1.5),
        ("hand20000".into(), hand(20_000), 1.5),
        ("hand100000".into(), hand(100_000), 1.5),
        ("zigzag8000".into(), zig(8000), 1.0),
        ("zigzag20000".into(), zig(20_000), 1.0),
        ("zigzag100000".into(), zig(100_000), 1.0),
        ("spiral20000(adversarial)".into(), spiral(20_000), 0.01),
        ("spiral100000(adversarial)".into(), spiral(100_000), 0.01),
    ];
    for (name, pts, eps) in cases {
        let t = Instant::now();
        let keep = simplify_keep(&pts, eps);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let kept = keep.iter().filter(|k| **k).count();
        let dev = max_deviation(&pts, &keep);
        println!(
            "PROBE|simplify|{name}|in={}|out={kept}|eps={eps}|maxDev={dev:.4}|ms={ms:.2}",
            pts.len()
        );
        assert!(dev <= eps + 1e-9, "{name}: tolerance bound broken ({dev} > {eps})");
    }
}
