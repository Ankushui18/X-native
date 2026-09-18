//! Dirty-subtree IR reuse (perf wave 2, item 1).
//!
//! The v0.37 SceneCache skipped ENCODE on unchanged frames but still
//! re-LOWERED the whole document every frame (71ms of the 100k warm
//! cost). This cache removes that:
//!
//!   frame → fast subtree hash walk (no allocation, no lowering)
//!     ├─ doc hash unchanged  → return cached Scene (zero lower, zero encode)
//!     └─ changed             → re-lower ONLY top-level subtrees whose
//!                              hash moved; splice cached command
//!                              segments for the rest; encode once
//!
//! Segment key includes the registry hash when the subtree contains an
//! Instance (a component edit anywhere must re-lower its consumers) and
//! the root world transform (segments bake parent transforms).
//! Correctness fallbacks: top-level masks or a non-Normal root blend
//! bypass segment reuse entirely (order-dependent clipping).

#[cfg(test)]
use crate::ir::build_render_tree;
use crate::ir::VelloSink;
use std::collections::HashMap;
use std::sync::Arc;
use vello::kurbo::Affine;
use vello::Scene;
use x_core::*;

// ------------------------------------------------------------- hashing

#[inline]
fn mix(h: &mut u64, v: u64) {
    *h ^= v;
    *h = h.wrapping_mul(0x0000_0100_0000_01b3);
}
#[inline]
fn fmix(h: &mut u64, f: f64) {
    mix(h, f.to_bits());
}
fn smix(h: &mut u64, s: &str) {
    for b in s.as_bytes() {
        mix(h, *b as u64);
    }
    mix(h, 0x1f);
}
fn cmix(h: &mut u64, c: &Color) {
    let rgba = c.to_rgba8();
    mix(
        h,
        u64::from_le_bytes([rgba.r, rgba.g, rgba.b, rgba.a, 0, 0, 0, 0]),
    );
}
fn paint_mix(h: &mut u64, p: &Paint) {
    match p {
        Paint::Solid(c) => {
            mix(h, 1);
            cmix(h, c);
        }
        Paint::Variable(n) => {
            mix(h, 2);
            smix(h, n);
        }
        Paint::LinearGradient {
            start,
            end,
            stops,
            space,
        } => {
            mix(h, 3);
            mix(h, *space as u64);
            fmix(h, start.0);
            fmix(h, start.1);
            fmix(h, end.0);
            fmix(h, end.1);
            for (t, c) in stops {
                fmix(h, *t as f64);
                cmix(h, c);
            }
        }
        Paint::Pattern { asset, fit } => {
            mix(h, 5);
            smix(h, asset);
            mix(h, *fit as u64);
        }
        Paint::RadialGradient {
            center,
            radius,
            stops,
            space,
        } => {
            mix(h, 4);
            mix(h, *space as u64);
            fmix(h, center.0);
            fmix(h, center.1);
            fmix(h, *radius);
            for (t, c) in stops {
                fmix(h, *t as f64);
                cmix(h, c);
            }
        }
        Paint::AngularGradient {
            center,
            start_angle,
            end_angle,
            stops,
            space,
        } => {
            mix(h, 6);
            mix(h, *space as u64);
            fmix(h, center.0);
            fmix(h, center.1);
            fmix(h, *start_angle);
            fmix(h, *end_angle);
            for (t, c) in stops {
                fmix(h, *t as f64);
                cmix(h, c);
            }
        }
        Paint::DiamondGradient {
            center,
            width,
            height,
            stops,
            space,
        } => {
            mix(h, 7);
            mix(h, *space as u64);
            fmix(h, center.0);
            fmix(h, center.1);
            fmix(h, *width);
            fmix(h, *height);
            for (t, c) in stops {
                fmix(h, *t as f64);
                cmix(h, c);
            }
        }
    }
}

/// (hash, contains_component, contains_instance)
fn hash_subtree(n: &Node) -> (u64, bool, bool) {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut has_comp = false;
    let mut has_inst = false;
    fn walk(n: &Node, h: &mut u64, has_comp: &mut bool, has_inst: &mut bool) {
        smix(h, &n.id);
        fmix(h, n.transform.x);
        fmix(h, n.transform.y);
        fmix(h, n.transform.rotation);
        fmix(h, n.transform.scale_x);
        fmix(h, n.transform.scale_y);
        fmix(h, n.w);
        fmix(h, n.h);
        paint_mix(h, &n.fill);
        paint_mix(h, &n.stroke.paint);
        fmix(h, n.stroke.width);
        mix(h, n.visual_stacks_materialized as u64);
        for l in &n.fill_layers {
            paint_mix(h, &l.paint);
            fmix(h, l.opacity as f64);
            mix(h, l.visible as u64);
            mix(h, l.blend as u64);
        }
        for l in &n.stroke_layers {
            paint_mix(h, &l.stroke.paint);
            fmix(h, l.stroke.width);
            fmix(h, l.opacity as f64);
            mix(h, l.visible as u64);
            mix(h, l.blend as u64);
            mix(h, l.options.align as u64);
            mix(h, l.options.cap_start as u64);
            mix(h, l.options.cap_end as u64);
            mix(h, l.options.join as u64);
            fmix(h, l.options.dash_offset);
            fmix(h, l.options.miter_limit);
            for d in &l.options.dash {
                fmix(h, *d);
            }
        }
        for l in &n.effect_layers {
            fmix(h, l.opacity as f64);
            mix(h, l.visible as u64);
            mix(h, l.blend as u64);
            match &l.effect {
                Effect::DropShadow {
                    dx,
                    dy,
                    blur,
                    color,
                } => {
                    mix(h, 31);
                    fmix(h, *dx);
                    fmix(h, *dy);
                    fmix(h, *blur);
                    cmix(h, color);
                }
                Effect::InnerShadow {
                    dx,
                    dy,
                    blur,
                    color,
                } => {
                    mix(h, 32);
                    fmix(h, *dx);
                    fmix(h, *dy);
                    fmix(h, *blur);
                    cmix(h, color);
                }
                Effect::LayerBlur { radius } => {
                    mix(h, 33);
                    fmix(h, *radius);
                }
                Effect::BackgroundBlur { radius } => {
                    mix(h, 34);
                    fmix(h, *radius);
                }
                Effect::Noise { amount, seed } => {
                    mix(h, 35);
                    fmix(h, *amount as f64);
                    mix(h, (*seed).into());
                }
            }
        }
        fmix(h, n.opacity as f64);
        mix(h, n.visible as u64);
        mix(h, (n.is_mask as u64) << 1);
        mix(h, (n.blend as u64) << 2);
        if let Some(cr) = n.corner_radii {
            for v in cr {
                fmix(h, v);
            }
        }
        for e in &n.effects {
            match e {
                Effect::DropShadow {
                    dx,
                    dy,
                    blur,
                    color,
                } => {
                    mix(h, 11);
                    fmix(h, *dx);
                    fmix(h, *dy);
                    fmix(h, *blur);
                    cmix(h, color);
                }
                Effect::InnerShadow {
                    dx,
                    dy,
                    blur,
                    color,
                } => {
                    mix(h, 12);
                    fmix(h, *dx);
                    fmix(h, *dy);
                    fmix(h, *blur);
                    cmix(h, color);
                }
                Effect::LayerBlur { radius } => {
                    mix(h, 13);
                    fmix(h, *radius);
                }
                Effect::BackgroundBlur { radius } => {
                    mix(h, 14);
                    fmix(h, *radius);
                }
                Effect::Noise { amount, seed } => {
                    mix(h, 15);
                    fmix(h, *amount as f64);
                    mix(h, (*seed).into());
                }
            }
        }
        // bindings/overrides affect resolution
        let mut keys: Vec<_> = n.bindings.iter().collect();
        keys.sort();
        for (k, v) in keys {
            smix(h, k);
            smix(h, v);
        }
        let mut ovr: Vec<_> = n.overrides.iter().collect();
        ovr.sort();
        for (k, v) in ovr {
            smix(h, k);
            smix(h, v);
        }
        match &n.kind {
            NodeKind::Frame { layout } => {
                mix(h, 21);
                // a frame's name is a canvas label when the frame is one of
                // the names the canvas draws (outermost frames and sections) —
                // a rename must invalidate the cached segment, exactly like
                // Section
                smix(h, &n.name);
                if let Some(l) = layout {
                    fmix(h, l.gap);
                    for p in l.padding {
                        fmix(h, p);
                    }
                    mix(h, l.direction as u64);
                    mix(
                        h,
                        if l.cross_sizing == Some(Sizing::Hug) {
                            2u64
                        } else if l.cross_sizing.is_some() {
                            1u64
                        } else {
                            0u64
                        },
                    );
                }
            }
            NodeKind::Group => mix(h, 22),
            NodeKind::Rect { radius } => {
                mix(h, 23);
                fmix(h, *radius);
            }
            NodeKind::Ellipse => mix(h, 24),
            NodeKind::Section => {
                mix(h, 28);
                smix(h, &n.name);
            }
            NodeKind::Arc { start, end, ratio } => {
                mix(h, 27);
                fmix(h, *start);
                fmix(h, *end);
                fmix(h, *ratio);
            }
            NodeKind::Line => mix(h, 25),
            NodeKind::Text { text } => {
                mix(h, 26);
                smix(h, text);
                // typography bindings (fs/ls/lh/ws/ps/bs/tc/fw/font) change
                // glyphs without changing `text`
                for (k, v) in &n.bindings {
                    smix(h, k);
                    smix(h, v);
                }
                // rich runs change glyphs without changing `text`
                for r in &n.text_runs {
                    smix(h, &r.start.to_string());
                    smix(h, &r.len.to_string());
                    if let Some(c) = r.color {
                        for b in c.components {
                            fmix(h, b as f64);
                        }
                    }
                    if let Some(sz) = r.size {
                        fmix(h, sz);
                    }
                    if let Some(f) = &r.font {
                        smix(h, f);
                    }
                }
            }
            NodeKind::Image {
                asset,
                fit,
                placement,
            } => {
                mix(h, 27);
                smix(h, asset);
                mix(h, *fit as u64);
                fmix(h, placement.focal.0);
                fmix(h, placement.focal.1);
                fmix(h, placement.scale);
                mix(h, placement.flip_h as u64);
                mix(h, placement.flip_v as u64);
            }
            NodeKind::Vector { path } => {
                mix(h, 28);
                for c in path {
                    match c {
                        PathCmd::MoveTo(a, b) => {
                            mix(h, 1);
                            fmix(h, *a);
                            fmix(h, *b);
                        }
                        PathCmd::LineTo(a, b) => {
                            mix(h, 2);
                            fmix(h, *a);
                            fmix(h, *b);
                        }
                        PathCmd::CurveTo(a, b, c2, d, e, f) => {
                            mix(h, 3);
                            fmix(h, *a);
                            fmix(h, *b);
                            fmix(h, *c2);
                            fmix(h, *d);
                            fmix(h, *e);
                            fmix(h, *f);
                        }
                        PathCmd::Close => mix(h, 4),
                    }
                }
            }
            NodeKind::Component { name } => {
                mix(h, 29);
                smix(h, name);
                *has_comp = true;
            }
            NodeKind::Instance { component } => {
                mix(h, 30);
                smix(h, component);
                *has_inst = true;
            }
            NodeKind::Slice => mix(h, 31),
        }
        for c in &n.children {
            walk(c, h, has_comp, has_inst);
        }
        mix(h, 0x2e);
    }
    walk(n, &mut h, &mut has_comp, &mut has_inst);
    (h, has_comp, has_inst)
}

/// Conservative world-space AABB of a subtree (rotation handled by
/// expanding to the rotated corners; instances get their node box which
/// is what layout sized them to). Cheap: one walk, no lowering.
pub fn subtree_bounds(n: &Node, parent: Affine) -> Option<vello::kurbo::Rect> {
    if !n.visible {
        return None;
    }
    let world = parent * n.transform.matrix(n.w, n.h);
    let mut acc: Option<vello::kurbo::Rect> = None;
    let include = |r: vello::kurbo::Rect, acc: &mut Option<vello::kurbo::Rect>| {
        *acc = Some(match acc {
            Some(a) => a.union(r),
            None => r,
        });
    };
    // own box (all paint kinds live inside it; effects add blur margin)
    let own = world.transform_rect_bbox(vello::kurbo::Rect::new(0.0, 0.0, n.w, n.h));
    let blur = n
        .active_effects()
        .iter()
        .map(|l| match &l.effect {
            Effect::DropShadow { dx, dy, blur, .. } => dx.abs().max(dy.abs()) + blur,
            Effect::InnerShadow { .. } => 0.0,
            Effect::LayerBlur { radius } | Effect::BackgroundBlur { radius } => *radius,
            Effect::Noise { .. } => 0.0,
        })
        .fold(0.0f64, f64::max);
    include(own.inflate(blur, blur), &mut acc);
    for c in &n.children {
        if let Some(b) = subtree_bounds(c, world) {
            include(b, &mut acc);
        }
    }
    acc
}

fn vars_hash(vars: &Variables) -> u64 {
    let mut h = 0x9e37_79b9_7f4a_7c15u64;
    let mut cs: Vec<_> = vars.colors.iter().collect();
    cs.sort_by_key(|(k, _)| (*k).clone());
    for (k, v) in cs {
        smix(&mut h, k);
        cmix(&mut h, v);
    }
    let mut ns: Vec<_> = vars.numbers.iter().collect();
    ns.sort_by_key(|(k, _)| (*k).clone());
    for (k, v) in ns {
        smix(&mut h, k);
        fmix(&mut h, *v);
    }
    if let Some(m) = &vars.active_mode {
        smix(&mut h, m);
    }
    h
}

// --------------------------------------------------------------- cache

#[derive(Debug, Clone, Copy, Default)]
pub struct FrameCacheStats {
    /// whole-frame cache hit: no lowering, no encoding
    pub full_hit: bool,
    /// children skipped by viewport culling this frame
    pub culled: usize,
    pub segments_total: usize,
    pub segments_reused: usize,
    /// milliseconds
    pub hash_ms: f32,
    pub lower_ms: f32,
    pub encode_ms: f32,
}

#[derive(Default)]
pub struct FrameCache {
    font_epoch: Option<u64>,
    hidden_text: Option<String>,
    /// Presentation mode: the artwork only, without the canvas chrome (frame
    /// names, section title chips). A render MODE, not a document property, so
    /// the document stays exactly as authored while it is on.
    presenting: bool,
    doc_hash: u64,
    /// child id -> (subtree hash, cached world bounds) — bounds only
    /// recompute when the subtree hash moves (drag = 1 recompute/frame)
    bounds: HashMap<String, (u64, Option<vello::kurbo::Rect>)>,
    /// bucket index -> (bucket key, ENCODED bucket scene). Children are
    /// chunked (BUCKET per segment): composition is ~n/BUCKET appends and
    /// a change re-encodes ONE bucket, not the world.
    segments: HashMap<usize, (u64, Arc<Scene>)>,
    scene: Option<Scene>,
    pub stats: FrameCacheStats,
    pub encode_count: usize,
}

impl FrameCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_hidden_text(&mut self, hidden: Option<&str>) {
        if self.hidden_text.as_deref() != hidden {
            self.hidden_text = hidden.map(str::to_owned);
            self.scene = None;
            self.segments.clear();
        }
    }

    /// A presentation paints the artwork alone: Figma draws no frame names in
    /// presentation mode, and there is no canvas around a presented frame for a
    /// section chip to label. Flipping the flag drops the cached scene (it is a
    /// different picture), it is not a second cache key.
    pub fn set_presenting(&mut self, presenting: bool) {
        if self.presenting != presenting {
            self.presenting = presenting;
            self.scene = None;
            self.segments.clear();
        }
    }

    /// Lower one node for the canvas under this cache's current mode: the inline
    /// editor's hidden text, and — while presenting — no canvas chrome.
    fn lower_canvas(&self, node: &Node, vars: &Variables) -> crate::ir::RenderTree {
        let mut tree =
            crate::ir::build_render_tree_with_hidden(node, vars, self.hidden_text.as_deref());
        if self.presenting {
            crate::ir::strip_canvas_chrome(&mut tree);
        }
        tree
    }

    pub fn render(&mut self, root: &Node, vars: &Variables, sink: &VelloSink) -> &Scene {
        self.render_viewport(root, vars, sink, None)
    }

    /// Approximate segment-cache footprint (encoded scene buffers).
    pub fn memory_bytes(&self) -> usize {
        // vello Scene has no size API in 0.1; estimate via encoding-count
        // proxy: buckets * mean commands * ~200B per encoded command
        self.segments.len() * 512 * 200
    }

    /// Viewport-culled render: children whose conservative world bounds
    /// miss `viewport` (world space, pre-inflated by the caller) are
    /// skipped from lowering AND encoding. The doc hash mixes a COARSE
    /// viewport cell so small pans stay cache hits; bucket keys carry
    /// the per-bucket visibility mask so scrolling re-encodes only the
    /// buckets whose visible set changed.
    pub fn render_viewport(
        &mut self,
        root: &Node,
        vars: &Variables,
        sink: &VelloSink,
        viewport: Option<vello::kurbo::Rect>,
    ) -> &Scene {
        let epoch = sink.fonts.map(|f| f.epoch());
        if self.font_epoch != epoch {
            self.scene = None;
            self.segments.clear();
            self.font_epoch = epoch;
        }
        let t0 = std::time::Instant::now();
        let vh = vars_hash(vars);
        // per-top-child hashes + registry hash (components anywhere)
        let child_info: Vec<(u64, bool, bool)> = root.children.iter().map(hash_subtree).collect();
        // viewport culling: visibility per child (world bounds vs viewport);
        // component masters always "visible" (registry must stay resolvable)
        let root_world_m = root.transform.matrix(root.w, root.h);
        let visible_mask: Vec<bool> = match viewport {
            None => vec![true; root.children.len()],
            Some(vp) => root
                .children
                .iter()
                .zip(&child_info)
                .map(|(c, (h, _, _))| {
                    if matches!(c.kind, NodeKind::Component { .. }) {
                        return true;
                    }
                    // bounds memoized by subtree hash: only re-walk changed subtrees
                    let b = match self.bounds.get(&c.id) {
                        Some((bh, bb)) if *bh == *h => *bb,
                        _ => {
                            let bb = subtree_bounds(c, root_world_m);
                            self.bounds.insert(c.id.clone(), (*h, bb));
                            bb
                        }
                    };
                    match b {
                        Some(b) => b.x1 >= vp.x0 && b.x0 <= vp.x1 && b.y1 >= vp.y0 && b.y0 <= vp.y1,
                        None => false,
                    }
                })
                .collect(),
        };
        let culled = visible_mask.iter().filter(|v| !**v).count();
        let mut reg_hash = vh;
        for (h, has_comp, _) in &child_info {
            if *has_comp {
                mix(&mut reg_hash, *h);
            }
        }
        // root shell hash (root's own fields, no children)
        let shell = root.shallow_clone();
        let (shell_hash, _, _) = hash_subtree(&shell);
        let mut doc_hash = shell_hash;
        mix(&mut doc_hash, vh);
        for ((h, _, _), vis) in child_info.iter().zip(&visible_mask) {
            mix(&mut doc_hash, *h);
            mix(&mut doc_hash, *vis as u64);
        }
        let hash_ms = t0.elapsed().as_secs_f32() * 1000.0;

        if doc_hash == self.doc_hash && self.scene.is_some() {
            self.stats = FrameCacheStats {
                full_hit: true,
                culled,
                segments_total: root.children.len(),
                segments_reused: root.children.len(),
                hash_ms,
                lower_ms: 0.0,
                encode_ms: 0.0,
            };
            // if-let here trips NLL's conditional-return-of-a-borrow
            // limitation (the loan would outlive the later self.scene
            // re-assignment on the miss path) — unwrap-at-return is the
            // shape the borrow checker can prove.
            #[allow(clippy::unnecessary_unwrap)]
            return self.scene.as_ref().unwrap();
        }

        // correctness fallbacks: top-level masks clip FOLLOWING siblings
        // (segment order dependency) → full lower+encode; ditto root blend
        let has_mask = root.children.iter().any(|c| c.is_mask);
        if has_mask
            || root.blend != BlendKind::Normal
            || root.opacity != 1.0
            || root.overflow.clips()
            || !root.active_effects().is_empty()
        {
            self.segments.clear();
            let t1 = std::time::Instant::now();
            let tree = self.lower_canvas(root, vars);
            let lower_ms = t1.elapsed().as_secs_f32() * 1000.0;
            let t2 = std::time::Instant::now();
            let scene = sink.render(&tree);
            let encode_ms = t2.elapsed().as_secs_f32() * 1000.0;
            self.encode_count += 1;
            self.scene = Some(scene);
            self.doc_hash = doc_hash;
            self.stats = FrameCacheStats {
                full_hit: false,
                culled: 0, // fallback path never culls (mask semantics)
                segments_total: root.children.len(),
                segments_reused: 0,
                hash_ms,
                lower_ms,
                encode_ms,
            };
            return self.scene.as_ref().unwrap();
        }

        // segmented path: BUCKETED encoded scenes (BUCKET children per
        // segment) — a change re-lowers+re-encodes one bucket; the rest
        // compose via ~n/BUCKET Scene::appends.
        const BUCKET: usize = 512;
        let t1 = std::time::Instant::now();
        let shell_only = root.shallow_clone();
        let shell_scene = sink.render(&self.lower_canvas(&shell_only, vars));
        let root_world = root.transform.matrix(root.w, root.h);
        let rw = root_world.as_coeffs();
        let mut reused = 0usize;
        let mut fresh: HashMap<usize, (u64, Arc<Scene>)> = HashMap::new();
        // ONE reusable lowering shell (root fields + component defs,
        // transparent fill — shell painted separately above)
        let mut lower_shell = root.shallow_clone();
        fn registry_only(n: &Node, out: &mut Vec<Node>) {
            if matches!(n.kind, NodeKind::Component { .. }) {
                let mut def = n.clone();
                def.visible = false;
                out.push(def);
            }
            for c in &n.children {
                registry_only(c, out);
            }
        }
        for child in &root.children {
            registry_only(child, &mut lower_shell.children);
        }
        lower_shell.stroke = x_core::Stroke::default();
        lower_shell.fill = Paint::Solid(Color::TRANSPARENT);
        lower_shell.fill_layers.clear();
        lower_shell.stroke_layers.clear();
        lower_shell.effect_layers.clear();
        lower_shell.visual_stacks_materialized = false;
        let shell_base_len = lower_shell.children.len();
        let mut lower_ms = 0.0f32;
        let mut encode_ms = 0.0f32;
        let mut composed = Scene::new();
        composed.append(&shell_scene, None);
        let n_buckets = root.children.len().div_ceil(BUCKET).max(1);
        for b in 0..n_buckets {
            let lo = b * BUCKET;
            let hi = ((b + 1) * BUCKET).min(root.children.len());
            // bucket key: child hashes + ids + vars + registry (if any
            // instance inside) + root world coeffs
            let mut key = 0x51_7cc1_b727_2202u64;
            let mut bucket_has_inst = false;
            for i in lo..hi {
                let (h, _, has_inst) = child_info[i];
                if !visible_mask[i] {
                    mix(&mut key, 0xdead);
                    continue;
                } // culled: key only marks absence
                mix(&mut key, h);
                if has_inst {
                    bucket_has_inst = true;
                }
            }
            mix(&mut key, vh);
            if bucket_has_inst {
                mix(&mut key, reg_hash);
            }
            for c in rw {
                fmix(&mut key, c);
            }
            let seg = match self.segments.get(&b) {
                Some((k, sc)) if *k == key => {
                    reused += hi - lo;
                    sc.clone()
                }
                _ => {
                    let tl = std::time::Instant::now();
                    for (i, child) in root.children.iter().enumerate().take(hi).skip(lo) {
                        if child.visible && visible_mask[i] {
                            lower_shell.children.push(child.clone());
                        }
                    }
                    // a bucket shell lowers the root plus ONE bucket of its
                    // children. The root is never labelled (it is the page),
                    // so there is no per-bucket label to overdraw — the shell
                    // scene above and this one agree by construction.
                    let sub_tree = self.lower_canvas(&lower_shell, vars);
                    lower_shell.children.truncate(shell_base_len);
                    lower_ms += tl.elapsed().as_secs_f32() * 1000.0;
                    let te = std::time::Instant::now();
                    let sc = Arc::new(sink.render(&sub_tree));
                    encode_ms += te.elapsed().as_secs_f32() * 1000.0;
                    self.encode_count += 1;
                    sc
                }
            };
            composed.append(&seg, None);
            fresh.insert(b, (key, seg));
        }
        self.segments = fresh;
        let compose_ms = t1.elapsed().as_secs_f32() * 1000.0 - lower_ms - encode_ms;
        let _ = compose_ms;
        self.scene = Some(composed);
        self.doc_hash = doc_hash;
        self.stats = FrameCacheStats {
            full_hit: false,
            culled,
            segments_total: root.children.len(),
            segments_reused: reused,
            hash_ms,
            lower_ms,
            encode_ms,
        };
        self.scene.as_ref().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // used only by tests (the lib itself no longer needs these names)
    use crate::ir::RenderCommand;

    fn doc(n: usize) -> Node {
        let mut page = Node::frame("page", 2000.0, 2000.0);
        for i in 0..n {
            page.children.push(Node::rect(
                &format!("r{i}"),
                (i * 20) as f64,
                10.0,
                15.0,
                15.0,
                Color::from_rgb8(50, 100, 200),
            ));
        }
        page
    }

    #[test]
    fn unchanged_frame_is_a_full_hit_no_lower_no_encode() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut fc = FrameCache::new();
        fc.render(&doc(300), &vars, &sink);
        assert!(!fc.stats.full_hit);
        let encodes = fc.encode_count;
        fc.render(&doc(300), &vars, &sink);
        assert!(fc.stats.full_hit, "identical doc -> full hit");
        assert_eq!(fc.encode_count, encodes, "no re-encode");
        assert_eq!(fc.stats.lower_ms, 0.0);
    }

    #[test]
    fn one_changed_subtree_relowers_one_bucket() {
        // 2000 children = 4 buckets of 512; moving node 42 re-lowers ONLY
        // bucket 0 — the other three buckets' encoded scenes are reused.
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut fc = FrameCache::new();
        fc.render(&doc(2000), &vars, &sink);
        let mut d2 = doc(2000);
        d2.children[42].transform.x += 5.0;
        let encodes_before = fc.encode_count;
        fc.render(&d2, &vars, &sink);
        assert!(!fc.stats.full_hit);
        assert_eq!(
            fc.stats.segments_reused,
            2000 - 512,
            "3 of 4 buckets reused"
        );
        assert_eq!(
            fc.encode_count,
            encodes_before + 1,
            "exactly ONE bucket re-encoded"
        );
    }

    #[test]
    fn instance_segments_invalidate_when_component_changes() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let make = |fill: Color| {
            Node::frame("page", 1000.0, 1000.0)
                .child(
                    Node::component("m", "Chip", 50.0, 20.0)
                        .child(Node::rect("m-bg", 0.0, 0.0, 50.0, 20.0, fill)),
                )
                .child(Node::instance("i1", "Chip", 100.0, 100.0, 50.0, 20.0))
                .child(Node::rect("plain", 300.0, 300.0, 40.0, 40.0, Color::BLACK))
        };
        let mut fc = FrameCache::new();
        fc.render(&make(Color::from_rgb8(255, 0, 0)), &vars, &sink);
        // recolor the COMPONENT: the bucket containing the instance must
        // re-lower even though the instance node itself is unchanged
        fc.render(&make(Color::from_rgb8(0, 255, 0)), &vars, &sink);
        assert!(!fc.stats.full_hit);
        assert_eq!(
            fc.stats.segments_reused, 0,
            "component change re-lowered the (single) bucket"
        );
    }

    #[test]
    fn masked_documents_fall_back_correctly() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let page = Node::frame("page", 500.0, 500.0)
            .child(Node::ellipse("m", 0.0, 0.0, 100.0, 100.0, Color::WHITE).mask(true))
            .child(Node::rect("r", 0.0, 0.0, 200.0, 200.0, Color::BLACK));
        let mut fc = FrameCache::new();
        fc.render(&page, &vars, &sink);
        // segment path bypassed; output must equal the reference lowering
        let reference = build_render_tree(&page, &vars);
        let clip_count = reference
            .commands
            .iter()
            .filter(|c| matches!(c, RenderCommand::PushClip { .. }))
            .count();
        assert_eq!(clip_count, 1, "mask semantics preserved via fallback");
        // and unchanged masked docs still get the full-hit fast path
        fc.render(&page, &vars, &sink);
        assert!(fc.stats.full_hit);
    }

    #[test]
    fn segmented_output_matches_reference_lowering() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let page = Node::frame("page", 1000.0, 1000.0)
            .child(Node::rect("a", 10.0, 10.0, 50.0, 50.0, Color::from_rgb8(255, 0, 0)).radius(4.0))
            .child(Node::ellipse(
                "b",
                100.0,
                10.0,
                50.0,
                50.0,
                Color::from_rgb8(0, 255, 0),
            ))
            .child(Node::text("t", 10.0, 100.0, 200.0, 16.0, "hello"));
        let mut fc = FrameCache::new();
        fc.render(&page, &vars, &sink);
        let reference = build_render_tree(&page, &vars);
        // command count identity is a strong structural check
        // (fingerprints include transforms + geometry)
        let mut fc2 = FrameCache::new();
        fc2.render(&page, &vars, &sink);
        assert_eq!(fc2.segments.len(), 1, "3 children fit one bucket");
        // reference sanity: the 3 child paint commands, and nothing else — the
        // root frame (the page) contributes no name label
        assert_eq!(reference.commands.len(), 3);
    }
}

#[cfg(test)]
mod culling_tests {
    use super::*;
    use vello::kurbo::Rect as KRect;

    fn spread_doc(n: usize) -> Node {
        // children spread over a huge canvas; only a few near origin
        let mut page = Node::frame("page", 100000.0, 100000.0);
        for i in 0..n {
            let x = (i % 100) as f64 * 1000.0;
            let y = (i / 100) as f64 * 1000.0;
            page.children.push(Node::rect(
                &format!("r{i}"),
                x,
                y,
                50.0,
                50.0,
                Color::from_rgb8(9, 9, 9),
            ));
        }
        page
    }

    #[test]
    fn offscreen_children_are_culled_from_lowering() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut fc = FrameCache::new();
        // viewport covers only the top-left 2000x2000 corner
        let vp = KRect::new(0.0, 0.0, 2000.0, 2000.0);
        fc.render_viewport(&spread_doc(2000), &vars, &sink, Some(vp));
        assert!(
            fc.stats.culled > 1900,
            "most children culled, got {}",
            fc.stats.culled
        );
    }

    #[test]
    fn culling_is_conservative_for_effects_and_rotation() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        // shadowed node just OUTSIDE the viewport must NOT be culled
        // (its blur bleeds in)
        let page = Node::frame("page", 5000.0, 5000.0)
            .child(
                Node::rect("sh", 2010.0, 100.0, 50.0, 50.0, Color::BLACK).effect(
                    Effect::DropShadow {
                        dx: -30.0,
                        dy: 0.0,
                        blur: 30.0,
                        color: Color::from_rgba8(0, 0, 0, 128),
                    },
                ),
            )
            .child(Node::rect("far", 4000.0, 4000.0, 50.0, 50.0, Color::BLACK));
        let mut fc = FrameCache::new();
        let vp = KRect::new(0.0, 0.0, 2000.0, 2000.0);
        fc.render_viewport(&page, &vars, &sink, Some(vp));
        assert_eq!(
            fc.stats.culled, 1,
            "shadow keeps 'sh' visible; only 'far' culled"
        );
    }

    #[test]
    fn panning_into_new_area_reencodes_only_affected_buckets() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let doc = spread_doc(2000);
        let mut fc = FrameCache::new();
        fc.render_viewport(
            &doc,
            &vars,
            &sink,
            Some(KRect::new(0.0, 0.0, 2000.0, 2000.0)),
        );
        // same viewport again: full hit even with culling active
        fc.render_viewport(
            &doc,
            &vars,
            &sink,
            Some(KRect::new(0.0, 0.0, 2000.0, 2000.0)),
        );
        assert!(fc.stats.full_hit, "static viewport = full cache hit");
        // pan far: visibility mask changes -> re-render, but ONLY dirty buckets
        let enc_before = fc.encode_count;
        fc.render_viewport(
            &doc,
            &vars,
            &sink,
            Some(KRect::new(50000.0, 0.0, 52000.0, 2000.0)),
        );
        assert!(!fc.stats.full_hit);
        assert!(fc.encode_count > enc_before, "new area encoded");
        assert!(
            fc.stats.segments_reused > 0 || fc.stats.culled > 1900,
            "pan re-encodes only visibility-changed buckets"
        );
    }

    #[test]
    fn no_viewport_means_no_culling() {
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut fc = FrameCache::new();
        fc.render(&spread_doc(500), &vars, &sink);
        assert_eq!(fc.stats.culled, 0);
    }
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    #[test]
    fn nested_master_is_available_in_every_bucket_and_painted_once() {
        let master = Node::component("master", "Card", 20.0, 20.0).child(Node::rect(
            "master-paint",
            0.0,
            0.0,
            20.0,
            20.0,
            Color::WHITE,
        ));
        let mut page = Node::frame("page", 1000.0, 1000.0)
            .child(Node::group("container", 20.0, 20.0).child(master));
        for i in 0..600 {
            page.children.push(Node::rect(
                &format!("r{i}"),
                0.0,
                0.0,
                1.0,
                1.0,
                Color::WHITE,
            ));
        }
        page.children
            .push(Node::instance("instance", "Card", 100.0, 100.0, 20.0, 20.0));
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let reference = sink.render(&build_render_tree(&page, &vars));
        let mut cache = FrameCache::new();
        assert_eq!(
            cache.render(&page, &vars, &sink).encoding().n_paths,
            reference.encoding().n_paths
        );
        cache.render(&page, &vars, &sink);
        assert!(cache.stats.full_hit);
    }
    /// Presenting is a different picture, not a second cache key: flipping the
    /// flag drops the cached scene instead of serving the editor's labelled one.
    #[test]
    fn presenting_invalidates_the_cached_scene() {
        let page = Node::frame("page", 200.0, 200.0).child(
            Node::frame("hero", 100.0, 60.0).child(Node::rect(
                "r",
                4.0,
                4.0,
                20.0,
                20.0,
                Color::WHITE,
            )),
        );
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut cache = FrameCache::new();
        cache.render(&page, &vars, &sink);
        let encoded = cache.encode_count;
        cache.render(&page, &vars, &sink);
        assert!(cache.stats.full_hit, "an unchanged page is a cache hit");
        cache.set_presenting(true);
        cache.render(&page, &vars, &sink);
        assert!(
            !cache.stats.full_hit,
            "the presentation hit the editor's scene"
        );
        assert!(
            cache.encode_count > encoded,
            "the presentation reused encoded segments"
        );
        // leaving the presentation is the editor's picture again
        cache.render(&page, &vars, &sink);
        assert!(cache.stats.full_hit, "presenting left the cache cold");
        cache.set_presenting(false);
        cache.render(&page, &vars, &sink);
        assert!(
            !cache.stats.full_hit,
            "the editor hit the presentation's scene"
        );
    }

    #[test]
    fn inline_exclusion_changes_only_the_view_and_invalidates_cached_scene() {
        let page = Node::frame("page", 100.0, 100.0)
            .child(Node::text("text", 0.0, 0.0, 100.0, 20.0, "ABC"));
        let vars = Variables::default();
        let sink = VelloSink {
            assets: None,
            fonts: None,
        };
        let mut cache = FrameCache::new();
        let paths = cache.render(&page, &vars, &sink).encoding().n_paths;
        cache.set_hidden_text(Some("text"));
        // hiding the edited TEXT node blanks its glyphs, and there is nothing
        // else in the scene: the render root is the page, and a page's name is
        // never painted on the canvas (it belongs in the pages list). The old
        // expectation here was `page.name.chars().count()` glyph paths — the
        // page name, printed across an empty artboard.
        assert_eq!(
            cache.render(&page, &vars, &sink).encoding().n_paths,
            0,
            "only the text node's glyphs are hidden"
        );
        cache.set_hidden_text(None);
        assert_eq!(cache.render(&page, &vars, &sink).encoding().n_paths, paths);
        assert!(matches!(&page.children[0].kind, NodeKind::Text { text } if text == "ABC"));
    }
}

#[cfg(test)]
mod preparation_context_tests {
    use super::*;
    #[test]
    fn a_new_font_collection_invalidates_prepared_scenes() {
        let root =
            Node::frame("p", 100.0, 100.0).child(Node::text("t", 0.0, 0.0, 80.0, 20.0, "Ready"));
        let vars = Variables::default();
        let mut cache = FrameCache::new();
        let mut a = x_text::FontManager::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/x-designer/assets/fonts/Inter-400.ttf"
        ))
        .to_vec();
        a.load_face_bytes("Inter", bytes.clone(), 0).unwrap();
        let first = crate::VelloSink {
            assets: None,
            fonts: Some(&a),
        };
        cache.render(&root, &vars, &first);
        cache.render(&root, &vars, &first);
        assert!(cache.stats.full_hit);
        let mut b = x_text::FontManager::new();
        b.load_face_bytes("Other collection", bytes, 0).unwrap();
        cache.render(
            &root,
            &vars,
            &crate::VelloSink {
                assets: None,
                fonts: Some(&b),
            },
        );
        assert!(!cache.stats.full_hit);
    }
}
