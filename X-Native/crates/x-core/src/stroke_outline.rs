//! Bounded stroke-to-fill expansion.
//!
//! The renderer can keep a normal stroke as a compact paint instruction, but
//! editable Outline Stroke must materialize exactly the ink as closed vector
//! contours.  This module is deliberately independent of the editor: it takes
//! `PathCmd` centerlines plus the persisted `StrokeOptions` and returns only
//! local filled geometry.  The editor owns history/selection; render/export
//! callers can use the same pure result without inventing another stroker.
//!
//! The implementation is polyline based. Cubics are flattened at a fixed,
//! documented tolerance before caps, joins, dashes and variable-width stations
//! are resolved. That is a conscious bounded-vector dialect, not a hidden
//! approximation: output contains only `MoveTo`, `LineTo`, and `Close` and is
//! capped before it reaches document history or a bridge.

use crate::{
    PathCmd, StrokeAlign, StrokeCap, StrokeJoin, StrokeOptions, VariableWidthPoint,
    MAX_VARIABLE_WIDTH_MULTIPLIER, MAX_VARIABLE_WIDTH_POINTS,
};

/// Cubic samples per segment used by the editable-outline dialect.
pub const OUTLINE_FLATTEN_STEPS: usize = 12;
/// Largest input command vector this pure operation accepts.
pub const MAX_OUTLINE_INPUT_COMMANDS: usize = 4096;
/// Largest flattened centerline budget across all subpaths.
pub const MAX_OUTLINE_CENTERLINE_POINTS: usize = 4096;
/// Largest number of persisted dash entries. This matches admission's stroke
/// budget and bounds a pathological short-dash expansion.
pub const MAX_OUTLINE_DASH_ENTRIES: usize = 128;
/// Largest number of output anchors (`MoveTo`/`LineTo`, never `Close`).
pub const MAX_OUTLINE_ANCHORS: usize = 8192;
/// Outline Stroke accepts substantial imported strokes without allowing an
/// overflow-sized outline to enter history.
pub const MAX_OUTLINE_STROKE_WIDTH: f64 = 1_000_000.0;
/// The miter ratio is relative to the local half-width.  The renderer's
/// default is four; 64 remains useful for intentional long architectural tips
/// while keeping coordinates/bounds finite.
pub const MAX_OUTLINE_MITER_LIMIT: f64 = 64.0;

const EPS: f64 = 1e-9;
const AREA_EPS: f64 = 1e-10;
const TAU: f64 = std::f64::consts::PI * 2.0;

type Point = (f64, f64);

/// Tight local bounds of the materialized contour anchors.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokeOutlineBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl StrokeOutlineBounds {
    pub fn width(self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(self) -> f64 {
        self.max_y - self.min_y
    }
}

/// A bounded, local filled-vector result of one stroke layer.
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeOutline {
    pub path: Vec<PathCmd>,
    pub bounds: StrokeOutlineBounds,
}

/// Validate the persisted profile shape without changing it.
///
/// Profile positions must already be canonical ascending arc-length stations.
/// This avoids a save/load cycle silently reordering a user's points and makes
/// the same document deterministic for render, export and outlining. Equal
/// positions are allowed (a hard width stop); sampling chooses the earlier
/// station at the exact shared position and interpolates normally afterwards.
pub fn validate_width_profile(profile: &[VariableWidthPoint]) -> Result<(), &'static str> {
    if profile.len() > MAX_VARIABLE_WIDTH_POINTS {
        return Err("stroke width profile exceeds the point budget");
    }
    let mut previous = -1.0;
    for point in profile {
        if !point.is_valid() {
            return Err("stroke width profile contains an invalid station");
        }
        if point.position + EPS < previous {
            return Err("stroke width profile positions must be sorted");
        }
        previous = point.position;
    }
    Ok(())
}

/// Resolve a persisted profile at normalized centerline arc length `t`.
/// Empty profiles are deliberately the historic uniform-stroke fast path.
pub fn sample_width_profile(profile: &[VariableWidthPoint], t: f64) -> f64 {
    let Some(first) = profile.first() else {
        return 1.0;
    };
    let t = t.clamp(0.0, 1.0);
    if t <= first.position {
        return first.width_multiplier;
    }
    let last = profile.last().expect("first checked above");
    if t >= last.position {
        return last.width_multiplier;
    }
    for pair in profile.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if t >= a.position && t <= b.position {
            let span = b.position - a.position;
            if span <= EPS {
                return a.width_multiplier;
            }
            let f = ((t - a.position) / span).clamp(0.0, 1.0);
            return a.width_multiplier + (b.width_multiplier - a.width_multiplier) * f;
        }
    }
    // `validate_width_profile` makes this unreachable for a canonical profile,
    // but a conservative uniform fallback keeps this pure helper total.
    1.0
}

/// Convert all stroked subpaths into filled contours.
///
/// - dashes are split before outline expansion, so every painted dash receives
///   the configured start/end cap;
/// - variable profile stations are injected into the centerline before offset
///   construction, preserving peaks/tapers even on a single straight segment;
/// - closed paths emit two oppositely wound contours for a NonZero fill;
/// - unsupported/non-finite/excessive geometry returns an explicit error rather
///   than producing a truncated document mutation.
pub fn outline_stroke_path(
    path: &[PathCmd],
    width: f64,
    options: &StrokeOptions,
) -> Result<StrokeOutline, &'static str> {
    if path.len() > MAX_OUTLINE_INPUT_COMMANDS {
        return Err("stroke path exceeds the command budget");
    }
    if !width.is_finite() || !(0.0 < width && width <= MAX_OUTLINE_STROKE_WIDTH) {
        return Err("stroke width is invalid or excessive");
    }
    if !options.miter_limit.is_finite()
        || !(1.0..=MAX_OUTLINE_MITER_LIMIT).contains(&options.miter_limit)
    {
        return Err("stroke miter limit is invalid or excessive");
    }
    validate_width_profile(&options.width_profile)?;
    validate_dash(options)?;

    let centerlines = flatten_subpaths(path)?;
    let mut contours: Vec<Vec<Point>> = Vec::new();
    // Count before retaining contours: output admission below also checks the
    // cleaned anchors, but this early budget prevents a tiny dash pattern from
    // allocating an oversized intermediate vector first.
    let mut contour_anchor_budget = 0usize;
    for centerline in centerlines {
        let (left_scale, right_scale) = alignment_scales(&centerline, options.align);
        if options.dash.is_empty() {
            let samples = if centerline.closed {
                closed_samples(&centerline, &options.width_profile)
            } else {
                sample_range(
                    &centerline,
                    0.0,
                    centerline.total,
                    &options.width_profile,
                )
            };
            if samples.len() < 2 {
                continue;
            }
            if centerline.closed {
                for contour in outline_closed(
                    &samples,
                    width,
                    options,
                    left_scale,
                    right_scale,
                ) {
                    retain_contour(&mut contours, &mut contour_anchor_budget, contour)?;
                }
            } else if let Some(contour) = outline_open(
                &samples,
                width,
                options,
                left_scale,
                right_scale,
            ) {
                retain_contour(&mut contours, &mut contour_anchor_budget, contour)?;
            }
        } else {
            // Dashed closed paths are a sequence of open painted runs. A run
            // that crosses the source's close seam is merged first, so it does
            // not grow two false caps at the arbitrary MoveTo anchor.
            for (start, end) in dash_intervals(&centerline, options)? {
                let samples = sample_range(&centerline, start, end, &options.width_profile);
                if samples.len() < 2 {
                    continue;
                }
                if let Some(contour) = outline_open(
                    &samples,
                    width,
                    options,
                    left_scale,
                    right_scale,
                ) {
                    retain_contour(&mut contours, &mut contour_anchor_budget, contour)?;
                }
            }
        }
    }

    let mut output = Vec::new();
    for contour in contours {
        append_contour(&mut output, contour)?;
    }
    if output.is_empty() {
        return Err("stroke path has no drawable centerline");
    }
    let bounds = output_bounds(&output).ok_or("stroke outline has invalid bounds")?;
    Ok(StrokeOutline {
        path: output,
        bounds,
    })
}

fn validate_dash(options: &StrokeOptions) -> Result<(), &'static str> {
    if options.dash.len() > MAX_OUTLINE_DASH_ENTRIES {
        return Err("stroke dash pattern exceeds the entry budget");
    }
    if !options.dash_offset.is_finite() || options.dash_offset.abs() > 1e9 {
        return Err("stroke dash offset is invalid or excessive");
    }
    if options
        .dash
        .iter()
        .any(|d| !d.is_finite() || *d <= EPS || *d > 1e9)
    {
        // A zero-length alternating dash is accepted by a few raster APIs but
        // has no portable cap/join geometry. Refuse rather than spin or create
        // a different result in each export backend.
        return Err("stroke dash entries must be finite and positive");
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct Centerline {
    points: Vec<Point>,
    /// Arc-length station of each point; unlike `total`, this excludes the
    /// closing segment's final duplicate anchor.
    stations: Vec<f64>,
    total: f64,
    closed: bool,
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    point: Point,
    t: f64,
}

fn flatten_subpaths(path: &[PathCmd]) -> Result<Vec<Centerline>, &'static str> {
    let mut out = Vec::new();
    let mut current: Vec<Point> = Vec::new();
    let mut last = (0.0, 0.0);
    // SVG-style paths resume at a subpath's MoveTo after Close. Retaining this
    // cursor makes `Close; LineTo` deterministic rather than rejecting an
    // otherwise valid imported path.
    let mut subpath_start = (0.0, 0.0);

    let finish = |points: &mut Vec<Point>, closed: bool, out: &mut Vec<Centerline>| {
        if points.len() >= 2 {
            if let Some(line) = make_centerline(std::mem::take(points), closed) {
                out.push(line);
            }
        } else {
            points.clear();
        }
    };

    for cmd in path {
        match *cmd {
            PathCmd::MoveTo(x, y) => {
                finite_point((x, y))?;
                finish(&mut current, false, &mut out);
                current.push((x, y));
                last = (x, y);
                subpath_start = (x, y);
            }
            PathCmd::LineTo(x, y) => {
                finite_point((x, y))?;
                if current.is_empty() {
                    return Err("stroke path starts without MoveTo");
                }
                current.push((x, y));
                last = (x, y);
            }
            PathCmd::CurveTo(x1, y1, x2, y2, x, y) => {
                for point in [(x1, y1), (x2, y2), (x, y)] {
                    finite_point(point)?;
                }
                if current.is_empty() {
                    return Err("stroke curve starts without MoveTo");
                }
                let p0 = last;
                for i in 1..=OUTLINE_FLATTEN_STEPS {
                    let t = i as f64 / OUTLINE_FLATTEN_STEPS as f64;
                    current.push(cubic(p0, (x1, y1), (x2, y2), (x, y), t));
                }
                last = (x, y);
            }
            PathCmd::Close => {
                finish(&mut current, true, &mut out);
                current.push(subpath_start);
                last = subpath_start;
            }
        }
        if current.len() + out.iter().map(|line| line.points.len()).sum::<usize>()
            > MAX_OUTLINE_CENTERLINE_POINTS
        {
            return Err("stroke path exceeds the flattened-centerline budget");
        }
    }
    finish(&mut current, false, &mut out);
    if out.iter().map(|line| line.points.len()).sum::<usize>() > MAX_OUTLINE_CENTERLINE_POINTS {
        return Err("stroke path exceeds the flattened-centerline budget");
    }
    Ok(out)
}

fn finite_point((x, y): Point) -> Result<(), &'static str> {
    if !x.is_finite() || !y.is_finite() || x.abs() > 1e9 || y.abs() > 1e9 {
        return Err("stroke path contains an invalid or excessive coordinate");
    }
    Ok(())
}

fn cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: f64) -> Point {
    let mt = 1.0 - t;
    (
        mt * mt * mt * p0.0
            + 3.0 * mt * mt * t * p1.0
            + 3.0 * mt * t * t * p2.0
            + t * t * t * p3.0,
        mt * mt * mt * p0.1
            + 3.0 * mt * mt * t * p1.1
            + 3.0 * mt * t * t * p2.1
            + t * t * t * p3.1,
    )
}

fn make_centerline(mut points: Vec<Point>, requested_closed: bool) -> Option<Centerline> {
    let mut clean = Vec::with_capacity(points.len());
    for point in points.drain(..) {
        if clean.last().is_none_or(|last| distance(*last, point) > EPS) {
            clean.push(point);
        }
    }
    if requested_closed && clean.len() > 2 && clean.first() == clean.last() {
        clean.pop();
    }
    if clean.len() < 2 {
        return None;
    }
    let closed = requested_closed && clean.len() >= 3;
    let segment_count = if closed { clean.len() } else { clean.len() - 1 };
    let mut stations = Vec::with_capacity(clean.len());
    stations.push(0.0);
    let mut total = 0.0;
    for i in 0..segment_count {
        let a = clean[i];
        let b = clean[(i + 1) % clean.len()];
        let length = distance(a, b);
        if length <= EPS {
            // De-duplication removes consecutive open duplicates, but a close
            // seam can still be degenerate. A nonzero centerline elsewhere is
            // still valid; its point lookup skips this segment below.
            continue;
        }
        total += length;
        if i + 1 < clean.len() {
            stations.push(total);
        }
    }
    if total <= EPS || stations.len() != clean.len() {
        // A zero close seam made station bookkeeping ambiguous. Rebuild after
        // removing only consecutive points; refusing the rare malformed ring is
        // safer than reconnecting a different contour.
        return None;
    }
    Some(Centerline {
        points: clean,
        stations,
        total,
        closed,
    })
}

fn closed_samples(line: &Centerline, profile: &[VariableWidthPoint]) -> Vec<Sample> {
    let mut samples = sample_range(line, 0.0, line.total, profile);
    if samples.len() > 1 && distance(samples[0].point, samples.last().expect("len checked").point) <= EPS {
        samples.pop();
    }
    samples
}

/// Return a source point at an unwrapped centerline distance. Closed lines
/// accept distances past one revolution, which is needed for a dash crossing
/// the arbitrary first-anchor seam.
fn point_at(line: &Centerline, distance_at: f64) -> Point {
    let mut d = if line.closed {
        distance_at.rem_euclid(line.total)
    } else {
        distance_at.clamp(0.0, line.total)
    };
    if !line.closed && (line.total - d).abs() <= EPS {
        return *line.points.last().expect("centerline has points");
    }
    if d < EPS {
        d = 0.0;
    }
    let segment_count = if line.closed {
        line.points.len()
    } else {
        line.points.len() - 1
    };
    for i in 0..segment_count {
        let start = line.stations[i];
        let end = if i + 1 < line.points.len() {
            line.stations[i + 1]
        } else {
            line.total
        };
        if d <= end + EPS {
            let len = end - start;
            if len <= EPS {
                continue;
            }
            let f = ((d - start) / len).clamp(0.0, 1.0);
            let a = line.points[i];
            let b = line.points[(i + 1) % line.points.len()];
            return (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f);
        }
    }
    *line.points.last().expect("centerline has points")
}

fn t_at(line: &Centerline, distance_at: f64) -> f64 {
    if line.closed {
        (distance_at.rem_euclid(line.total) / line.total).clamp(0.0, 1.0)
    } else {
        (distance_at / line.total).clamp(0.0, 1.0)
    }
}

/// Sample a possibly seam-crossing interval and inject both original vertices
/// and variable-profile stations. The profile cuts are important: a two-point
/// line with a mid-path bulge must retain its actual maximum width.
fn sample_range(
    line: &Centerline,
    start: f64,
    end: f64,
    profile: &[VariableWidthPoint],
) -> Vec<Sample> {
    if end - start <= EPS {
        return Vec::new();
    }
    let mut distances = vec![start, end];
    let first_cycle = (start / line.total).floor() as i64 - 1;
    let last_cycle = (end / line.total).ceil() as i64 + 1;
    for cycle in first_cycle..=last_cycle {
        if cycle < 0 {
            continue;
        }
        let base = cycle as f64 * line.total;
        for &station in &line.stations {
            let d = base + station;
            if d > start + EPS && d < end - EPS {
                distances.push(d);
            }
        }
        for point in profile {
            let d = base + point.position * line.total;
            if d > start + EPS && d < end - EPS {
                distances.push(d);
            }
        }
    }
    distances.sort_by(|a, b| a.total_cmp(b));
    distances.dedup_by(|a, b| (*a - *b).abs() <= EPS);
    distances
        .into_iter()
        .map(|d| Sample {
            point: point_at(line, d),
            t: t_at(line, d),
        })
        .collect()
}

fn dash_intervals(
    line: &Centerline,
    options: &StrokeOptions,
) -> Result<Vec<(f64, f64)>, &'static str> {
    let mut pattern = options.dash.clone();
    if pattern.len() % 2 == 1 {
        // SVG/canvas rule: an odd list repeats to form on/off pairs.
        let copy = pattern.clone();
        pattern.extend(copy);
    }
    let period: f64 = pattern.iter().sum();
    if !period.is_finite() || period <= EPS {
        return Err("stroke dash pattern has no visible period");
    }

    // Match SVG, kurbo/Vello and tiny-skia: a positive dash offset consumes
    // that much of the pattern at the path start (visually shifting marks
    // backward); a negative offset advances them. Keeping the persisted value
    // raw here is what lets an outlined profile agree with an ordinary native
    // stroke and an SVG round-trip.
    let mut phase = options.dash_offset.rem_euclid(period);
    let mut index = 0usize;
    while phase >= pattern[index] - EPS {
        phase -= pattern[index];
        index = (index + 1) % pattern.len();
    }
    let mut remaining = (pattern[index] - phase).max(EPS);
    let mut cursor = 0.0;
    let mut out = Vec::new();
    let mut steps = 0usize;
    while cursor < line.total - EPS {
        if steps > MAX_OUTLINE_ANCHORS * 4 {
            return Err("stroke dash expansion exceeds the geometry budget");
        }
        let take = remaining.min(line.total - cursor);
        if index % 2 == 0 && take > EPS {
            out.push((cursor, cursor + take));
        }
        cursor += take;
        remaining -= take;
        if remaining <= EPS {
            index = (index + 1) % pattern.len();
            remaining = pattern[index];
        }
        steps += 1;
    }

    if line.closed && out.len() >= 2 {
        let first = out[0];
        let last_index = out.len() - 1;
        let last = out[last_index];
        if first.0 <= EPS && (line.total - last.1).abs() <= EPS {
            // [last.start, first.end + total] samples a single continuous dash
            // through the close seam and receives only its real two caps.
            out[0] = (last.0, first.1 + line.total);
            out.pop();
        }
    }
    Ok(out)
}

fn alignment_scales(line: &Centerline, align: StrokeAlign) -> (f64, f64) {
    if !line.closed || align == StrokeAlign::Center {
        return (0.5, 0.5);
    }
    // Algebraic orientation is independent of screen-y direction: a positive
    // shoelace ring has its interior on the left side of its directed edges.
    let interior_left = signed_area(&line.points) > 0.0;
    match (align, interior_left) {
        (StrokeAlign::Inside, true) | (StrokeAlign::Outside, false) => (1.0, 0.0),
        (StrokeAlign::Inside, false) | (StrokeAlign::Outside, true) => (0.0, 1.0),
        (StrokeAlign::Center, _) => (0.5, 0.5),
    }
}

fn outline_closed(
    samples: &[Sample],
    width: f64,
    options: &StrokeOptions,
    left_scale: f64,
    right_scale: f64,
) -> Vec<Vec<Point>> {
    let left = side_outline(samples, width, options, 1.0, left_scale, true);
    let mut right = side_outline(samples, width, options, -1.0, right_scale, true);
    right.reverse();
    let mut out = Vec::with_capacity(2);
    if left.len() >= 3 {
        out.push(left);
    }
    if right.len() >= 3 {
        out.push(right);
    }
    out
}

fn outline_open(
    samples: &[Sample],
    width: f64,
    options: &StrokeOptions,
    left_scale: f64,
    right_scale: f64,
) -> Option<Vec<Point>> {
    let mut left = side_outline(samples, width, options, 1.0, left_scale, false);
    let mut right = side_outline(samples, width, options, -1.0, right_scale, false);
    if left.is_empty() || right.is_empty() {
        return None;
    }

    let start_direction = direction(samples[0].point, samples[1].point)?;
    let end_direction = direction(
        samples[samples.len() - 2].point,
        samples[samples.len() - 1].point,
    )?;
    let start_full = width * sample_width_profile(&options.width_profile, samples[0].t);
    let end_full = width
        * sample_width_profile(
            &options.width_profile,
            samples.last().expect("samples nonempty").t,
        );
    let start_radius = start_full * 0.5;
    let end_radius = end_full * 0.5;

    if options.cap_start == StrokeCap::Square && start_radius > EPS {
        left[0] = sub(left[0], mul(start_direction, start_radius));
        right[0] = sub(right[0], mul(start_direction, start_radius));
    }
    if options.cap_end == StrokeCap::Square && end_radius > EPS {
        let last = left.len() - 1;
        left[last] = add(left[last], mul(end_direction, end_radius));
        let last = right.len() - 1;
        right[last] = add(right[last], mul(end_direction, end_radius));
    }

    let mut contour = left;
    append_end_cap(
        &mut contour,
        samples.last().expect("samples nonempty").point,
        end_direction,
        end_radius,
        options.cap_end,
    );
    contour.extend(right.iter().rev().copied());
    append_start_cap(
        &mut contour,
        samples[0].point,
        start_direction,
        start_radius,
        options.cap_start,
    );
    Some(contour)
}

/// Build the one-sided edge. On an outside corner, miter/bevel/round all
/// differ; on the inside corner both edges meet at their line intersection so
/// the fill has no artificial notch.
fn side_outline(
    samples: &[Sample],
    width: f64,
    options: &StrokeOptions,
    side: f64,
    side_scale: f64,
    closed: bool,
) -> Vec<Point> {
    let count = samples.len();
    if count < 2 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(count * 3);
    for i in 0..count {
        let point = samples[i].point;
        let half = width * sample_width_profile(&options.width_profile, samples[i].t) * side_scale;
        let previous = if i > 0 {
            Some(i - 1)
        } else if closed {
            Some(count - 1)
        } else {
            None
        };
        let next = if i + 1 < count {
            Some(i + 1)
        } else if closed {
            Some(0)
        } else {
            None
        };
        match (previous, next) {
            (None, Some(next)) => {
                let d = direction(point, samples[next].point).expect("nondegenerate samples");
                out.push(add(point, mul(left_normal(d), side * half)));
            }
            (Some(previous), None) => {
                let d = direction(samples[previous].point, point).expect("nondegenerate samples");
                out.push(add(point, mul(left_normal(d), side * half)));
            }
            (Some(previous), Some(next)) => {
                let Some(incoming) = direction(samples[previous].point, point) else {
                    continue;
                };
                let Some(outgoing) = direction(point, samples[next].point) else {
                    continue;
                };
                let normal_in = left_normal(incoming);
                let normal_out = left_normal(outgoing);
                let from = add(point, mul(normal_in, side * half));
                let to = add(point, mul(normal_out, side * half));
                let turn = cross(incoming, outgoing);
                let outside = side * turn < -EPS;
                if turn.abs() <= EPS {
                    if dot(incoming, outgoing) >= 0.0 {
                        out.push(from);
                    } else {
                        // A U-turn has no stable line intersection. Treat it
                        // as the conservative bevel/semicircle join instead of
                        // sending an infinite miter into history.
                        out.push(from);
                        if options.join == StrokeJoin::Round && half > EPS {
                            append_round_join(&mut out, point, from, to, side);
                        } else {
                            out.push(to);
                        }
                    }
                    continue;
                }
                let meet = line_intersection(from, incoming, to, outgoing);
                if !outside {
                    out.push(meet.unwrap_or(to));
                    continue;
                }
                match options.join {
                    StrokeJoin::Bevel => {
                        out.push(from);
                        out.push(to);
                    }
                    StrokeJoin::Round => {
                        out.push(from);
                        append_round_join(&mut out, point, from, to, side);
                    }
                    StrokeJoin::Miter => {
                        if let Some(meet) = meet {
                            let ratio = if half <= EPS {
                                1.0
                            } else {
                                distance(meet, point) / half
                            };
                            if meet.0.is_finite()
                                && meet.1.is_finite()
                                && ratio <= options.miter_limit + EPS
                            {
                                out.push(meet);
                            } else {
                                out.push(from);
                                out.push(to);
                            }
                        } else {
                            out.push(from);
                            out.push(to);
                        }
                    }
                }
            }
            (None, None) => return Vec::new(),
        }
    }
    out
}

fn append_round_join(out: &mut Vec<Point>, center: Point, from: Point, to: Point, side: f64) {
    let start = sub(from, center);
    let end = sub(to, center);
    let radius = distance(start, (0.0, 0.0));
    if radius <= EPS {
        out.push(to);
        return;
    }
    let a0 = start.1.atan2(start.0);
    let a1 = end.1.atan2(end.0);
    let delta = if side < 0.0 {
        (a1 - a0).rem_euclid(TAU)
    } else {
        -((a0 - a1).rem_euclid(TAU))
    };
    let steps = ((delta.abs() / (std::f64::consts::PI / 12.0)).ceil() as usize).clamp(1, 24);
    for i in 1..=steps {
        let a = a0 + delta * i as f64 / steps as f64;
        out.push((center.0 + radius * a.cos(), center.1 + radius * a.sin()));
    }
}

fn append_end_cap(contour: &mut Vec<Point>, point: Point, direction: Point, radius: f64, cap: StrokeCap) {
    if radius <= EPS {
        return;
    }
    match cap {
        StrokeCap::Round => {
            let normal = left_normal(direction);
            for i in 1..6 {
                let a = std::f64::consts::PI * i as f64 / 6.0;
                contour.push(add(
                    point,
                    mul(add(mul(normal, a.cos()), mul(direction, a.sin())), radius),
                ));
            }
        }
        StrokeCap::Arrow | StrokeCap::Triangle => {
            let length = match cap {
                StrokeCap::Arrow => radius * 3.0,
                StrokeCap::Triangle => radius * 2.0,
                _ => unreachable!("matched above"),
            };
            contour.push(add(point, mul(direction, length)));
        }
        StrokeCap::None | StrokeCap::Square => {}
    }
}

fn append_start_cap(
    contour: &mut Vec<Point>,
    point: Point,
    direction: Point,
    radius: f64,
    cap: StrokeCap,
) {
    if radius <= EPS {
        return;
    }
    match cap {
        StrokeCap::Round => {
            let normal = left_normal(direction);
            for i in 1..6 {
                let a = std::f64::consts::PI * i as f64 / 6.0;
                contour.push(add(
                    point,
                    mul(
                        add(mul(normal, -a.cos()), mul(direction, -a.sin())),
                        radius,
                    ),
                ));
            }
        }
        StrokeCap::Arrow | StrokeCap::Triangle => {
            let length = match cap {
                StrokeCap::Arrow => radius * 3.0,
                StrokeCap::Triangle => radius * 2.0,
                _ => unreachable!("matched above"),
            };
            contour.push(sub(point, mul(direction, length)));
        }
        StrokeCap::None | StrokeCap::Square => {}
    }
}

fn retain_contour(
    contours: &mut Vec<Vec<Point>>,
    anchors: &mut usize,
    contour: Vec<Point>,
) -> Result<(), &'static str> {
    if contour.len() > MAX_OUTLINE_ANCHORS.saturating_sub(*anchors) {
        return Err("stroke outline exceeds the output-anchor budget");
    }
    *anchors += contour.len();
    contours.push(contour);
    Ok(())
}

fn append_contour(output: &mut Vec<PathCmd>, contour: Vec<Point>) -> Result<(), &'static str> {
    let mut points = clean_contour(contour);
    if points.len() < 3 || signed_area(&points).abs() <= AREA_EPS {
        return Ok(());
    }
    if output
        .iter()
        .filter(|command| matches!(command, PathCmd::MoveTo(..) | PathCmd::LineTo(..)))
        .count()
        + points.len()
        > MAX_OUTLINE_ANCHORS
    {
        return Err("stroke outline exceeds the output-anchor budget");
    }
    let first = points.remove(0);
    output.push(PathCmd::MoveTo(first.0, first.1));
    output.extend(points.into_iter().map(|point| PathCmd::LineTo(point.0, point.1)));
    output.push(PathCmd::Close);
    Ok(())
}

fn clean_contour(points: Vec<Point>) -> Vec<Point> {
    let mut out = Vec::with_capacity(points.len());
    for point in points {
        if point.0.is_finite()
            && point.1.is_finite()
            && out.last().is_none_or(|last| distance(*last, point) > EPS)
        {
            out.push(point);
        }
    }
    if out.len() > 1 && distance(out[0], *out.last().expect("len checked")) <= EPS {
        out.pop();
    }
    out
}

fn output_bounds(path: &[PathCmd]) -> Option<StrokeOutlineBounds> {
    let mut bounds = StrokeOutlineBounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    let mut seen = false;
    for command in path {
        let point = match *command {
            PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => Some((x, y)),
            PathCmd::CurveTo(..) | PathCmd::Close => None,
        };
        if let Some((x, y)) = point {
            if !x.is_finite() || !y.is_finite() {
                return None;
            }
            bounds.min_x = bounds.min_x.min(x);
            bounds.min_y = bounds.min_y.min(y);
            bounds.max_x = bounds.max_x.max(x);
            bounds.max_y = bounds.max_y.max(y);
            seen = true;
        }
    }
    seen.then_some(bounds)
}

fn signed_area(points: &[Point]) -> f64 {
    if points.len() < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..points.len() {
        let a = points[i];
        let b = points[(i + 1) % points.len()];
        area += a.0 * b.1 - a.1 * b.0;
    }
    area * 0.5
}

fn direction(a: Point, b: Point) -> Option<Point> {
    let d = sub(b, a);
    let len = distance(d, (0.0, 0.0));
    (len > EPS).then_some((d.0 / len, d.1 / len))
}

fn line_intersection(a: Point, da: Point, b: Point, db: Point) -> Option<Point> {
    let denominator = cross(da, db);
    if denominator.abs() <= EPS {
        return None;
    }
    let t = cross(sub(b, a), db) / denominator;
    Some(add(a, mul(da, t)))
}

fn left_normal(direction: Point) -> Point {
    (-direction.1, direction.0)
}

fn add(a: Point, b: Point) -> Point {
    (a.0 + b.0, a.1 + b.1)
}

fn sub(a: Point, b: Point) -> Point {
    (a.0 - b.0, a.1 - b.1)
}

fn mul(a: Point, scalar: f64) -> Point {
    (a.0 * scalar, a.1 * scalar)
}

fn dot(a: Point, b: Point) -> f64 {
    a.0 * b.0 + a.1 * b.1
}

fn cross(a: Point, b: Point) -> f64 {
    a.0 * b.1 - a.1 * b.0
}

fn distance(a: Point, b: Point) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{StrokeAlign, StrokeCap, StrokeJoin, StrokeOptions};

    fn path_points(path: &[PathCmd]) -> Vec<Point> {
        path.iter()
            .filter_map(|command| match *command {
                PathCmd::MoveTo(x, y) | PathCmd::LineTo(x, y) => Some((x, y)),
                PathCmd::CurveTo(..) | PathCmd::Close => None,
            })
            .collect()
    }

    fn contours(path: &[PathCmd]) -> Vec<Vec<Point>> {
        let mut out = Vec::new();
        let mut current = Vec::new();
        for command in path {
            match *command {
                PathCmd::MoveTo(x, y) => current.push((x, y)),
                PathCmd::LineTo(x, y) => current.push((x, y)),
                PathCmd::Close => out.push(std::mem::take(&mut current)),
                PathCmd::CurveTo(..) => panic!("outlined path must be linear"),
            }
        }
        out
    }

    fn options() -> StrokeOptions {
        StrokeOptions::default()
    }

    #[test]
    fn uniform_open_line_is_a_butt_capped_filled_band() {
        let result = outline_stroke_path(
            &[PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(20.0, 0.0)],
            4.0,
            &options(),
        )
        .unwrap();
        assert_eq!(contours(&result.path).len(), 1);
        assert_eq!(result.bounds.min_x, 0.0);
        assert_eq!(result.bounds.max_x, 20.0);
        assert_eq!(result.bounds.min_y, -2.0);
        assert_eq!(result.bounds.max_y, 2.0);
    }

    #[test]
    fn round_square_and_triangle_caps_materialize_different_ink_bounds() {
        let path = [PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(20.0, 0.0)];
        let mut round = options();
        round.cap_start = StrokeCap::Round;
        round.cap_end = StrokeCap::Round;
        let rounded = outline_stroke_path(&path, 4.0, &round).unwrap();
        assert!(rounded.bounds.min_x < -1.9 && rounded.bounds.max_x > 21.9);
        assert!(contours(&rounded.path)[0].len() > 8, "round caps add a fan");

        let mut square = options();
        square.cap_start = StrokeCap::Square;
        square.cap_end = StrokeCap::Square;
        let squared = outline_stroke_path(&path, 4.0, &square).unwrap();
        assert_eq!(squared.bounds.min_x, -2.0);
        assert_eq!(squared.bounds.max_x, 22.0);

        let mut triangle = options();
        triangle.cap_start = StrokeCap::Triangle;
        triangle.cap_end = StrokeCap::Arrow;
        let arrows = outline_stroke_path(&path, 4.0, &triangle).unwrap();
        assert!(arrows.bounds.min_x <= -3.9);
        assert!(arrows.bounds.max_x >= 25.9);
    }

    #[test]
    fn joins_honor_miter_limit_bevel_and_round() {
        let path = [
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(20.0, 0.0),
            PathCmd::LineTo(20.0, 20.0),
        ];
        let mut miter = options();
        miter.join = StrokeJoin::Miter;
        miter.miter_limit = 4.0;
        let sharp = outline_stroke_path(&path, 10.0, &miter).unwrap();
        assert!(path_points(&sharp.path)
            .iter()
            .any(|&(x, y)| x > 24.9 && y < -4.9));

        miter.miter_limit = 1.0;
        let limited = outline_stroke_path(&path, 10.0, &miter).unwrap();
        assert!(!path_points(&limited.path)
            .iter()
            .any(|&(x, y)| x > 24.9 && y < -4.9));

        let mut rounded = options();
        rounded.join = StrokeJoin::Round;
        let round = outline_stroke_path(&path, 10.0, &rounded).unwrap();
        assert!(contours(&round.path)[0].len() > contours(&limited.path)[0].len());
    }

    #[test]
    fn dash_segments_receive_caps_and_offset_changes_phase() {
        let path = [PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(40.0, 0.0)];
        let mut style = options();
        style.dash = vec![8.0, 4.0];
        style.cap_start = StrokeCap::Round;
        style.cap_end = StrokeCap::Round;
        let zero = outline_stroke_path(&path, 4.0, &style).unwrap();
        assert_eq!(contours(&zero.path).len(), 4, "four 8px painted dashes");
        assert!(zero.bounds.min_x < -1.9, "first dash has a round cap");

        // Positive offsets consume the first on-run, matching SVG and the
        // native kurbo/tiny-skia stroke backends. At one whole dash length the
        // path starts in its gap, so the first painted cap moves forward.
        style.dash_offset = 8.0;
        let shifted = outline_stroke_path(&path, 4.0, &style).unwrap();
        assert!(shifted.bounds.min_x > -0.1, "positive phase begins in the first gap");
        assert_ne!(zero.path, shifted.path);
    }

    #[test]
    fn variable_width_injects_control_stations_and_preserves_a_taper() {
        let path = [PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)];
        let mut style = options();
        style.width_profile = vec![
            VariableWidthPoint {
                position: 0.0,
                width_multiplier: 0.5,
            },
            VariableWidthPoint {
                position: 0.5,
                width_multiplier: 2.0,
            },
            VariableWidthPoint {
                position: 1.0,
                width_multiplier: 0.0,
            },
        ];
        let result = outline_stroke_path(&path, 10.0, &style).unwrap();
        let points = path_points(&result.path);
        assert!(points.iter().any(|&(x, y)| (x - 50.0).abs() < 1e-6 && y.abs() >= 9.99));
        assert!(points
            .iter()
            .filter(|&&(x, _)| x > 99.9)
            .all(|&(_, y)| y.abs() < 1e-6));
        assert_eq!(sample_width_profile(&style.width_profile, 0.5), 2.0);
    }

    #[test]
    fn dashes_and_variable_width_can_share_one_bounded_outline() {
        let path = [PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(100.0, 0.0)];
        let mut style = options();
        style.dash = vec![20.0, 10.0];
        style.width_profile = vec![
            VariableWidthPoint {
                position: 0.0,
                width_multiplier: 0.5,
            },
            VariableWidthPoint {
                position: 1.0,
                width_multiplier: 2.0,
            },
        ];
        let result = outline_stroke_path(&path, 8.0, &style).unwrap();
        let rings = contours(&result.path);
        assert_eq!(rings.len(), 4);
        let first_height = rings[0]
            .iter()
            .map(|point| point.1)
            .fold(f64::NEG_INFINITY, f64::max)
            - rings[0]
                .iter()
                .map(|point| point.1)
                .fold(f64::INFINITY, f64::min);
        let last_height = rings[3]
            .iter()
            .map(|point| point.1)
            .fold(f64::NEG_INFINITY, f64::max)
            - rings[3]
                .iter()
                .map(|point| point.1)
                .fold(f64::INFINITY, f64::min);
        assert!(last_height > first_height * 1.5);
    }

    #[test]
    fn closed_multi_subpath_alignment_emits_opposite_winding_rings() {
        let path = [
            PathCmd::MoveTo(0.0, 0.0),
            PathCmd::LineTo(30.0, 0.0),
            PathCmd::LineTo(30.0, 20.0),
            PathCmd::LineTo(0.0, 20.0),
            PathCmd::Close,
            PathCmd::MoveTo(50.0, 0.0),
            PathCmd::LineTo(70.0, 0.0),
            PathCmd::LineTo(70.0, 20.0),
            PathCmd::LineTo(50.0, 20.0),
            PathCmd::Close,
        ];
        let mut outside = options();
        outside.align = StrokeAlign::Outside;
        outside.join = StrokeJoin::Bevel;
        let result = outline_stroke_path(&path, 4.0, &outside).unwrap();
        let rings = contours(&result.path);
        assert_eq!(rings.len(), 4, "two rings for each closed subpath");
        assert!(signed_area(&rings[0]) * signed_area(&rings[1]) < 0.0);
        assert!(result.bounds.min_x <= -1.9 && result.bounds.max_x >= 71.9);
    }

    #[test]
    fn rejects_noncanonical_or_unbounded_input_before_output() {
        let path = [PathCmd::MoveTo(0.0, 0.0), PathCmd::LineTo(10.0, 0.0)];
        let mut style = options();
        style.width_profile = vec![
            VariableWidthPoint {
                position: 0.8,
                width_multiplier: 1.0,
            },
            VariableWidthPoint {
                position: 0.2,
                width_multiplier: 1.0,
            },
        ];
        assert!(outline_stroke_path(&path, 2.0, &style).is_err());
        style.width_profile.clear();
        style.dash = vec![0.0, 1.0];
        assert!(outline_stroke_path(&path, 2.0, &style).is_err());
        assert!(outline_stroke_path(&path, f64::NAN, &options()).is_err());
        assert!(validate_width_profile(&vec![
            VariableWidthPoint { position: 0.0, width_multiplier: 1.0 };
            MAX_VARIABLE_WIDTH_POINTS + 1
        ])
        .is_err());
        assert_eq!(MAX_VARIABLE_WIDTH_MULTIPLIER, 8.0);
    }
}
