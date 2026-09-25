//! Export scope, origin and typography are decided once, before choosing a sink.
use vello::kurbo::{Affine, Rect, Shape};
use x_core::{Node, NodeKind, Variables};
use x_render::{RenderCommand, RenderTree};

/// The plan for one slice: the page content inside the slice's world bounds,
/// re-origined to (0, 0) with the slice's own size as the canvas. The slice
/// layer itself contributes no commands — it is a region, and an empty slice
/// still exports its size (a transparent image), which is what  does.
fn prepare_slice_export(
    root: &Node,
    id: &str,
    vars: &Variables,
    fonts: &x_text::FontManager,
) -> Result<ExportPlan, String> {
    let (tree, width, height) =
        x_render::ir::build_render_tree_slice(root, id, vars).ok_or("slice no longer exists")?;
    let mut tree = tree;
    // same chrome strip as every other export: a slice must never capture a
    // frame's on-canvas name label
    tree.commands
        .retain(|c| !x_render::ir::is_frame_name_label(c.key()));
    let mut tree = x_render::text_geometry::outline_text(&tree, fonts)?;
    x_render::text_geometry::outline_strokes(&mut tree);
    Ok(ExportPlan {
        tree,
        width,
        height,
        origin: (0.0, 0.0),
    })
}

pub struct ExportPlan {
    pub tree: RenderTree,
    pub width: f64,
    pub height: f64,
    pub origin: (f64, f64),
}

pub fn prepare_export(
    root: &Node,
    vars: &Variables,
    selection: Option<&[String]>,
    fonts: &x_text::FontManager,
) -> Result<ExportPlan, String> {
    // A SLICE is an export REGION, not a layer: the node draws nothing itself,
    // so a selected slice exports the flattened canvas content inside its
    // bounds (: "anything that overlaps the slice will be exported").
    // One slice per export — this app writes one file per invocation, so a
    // selection that mixes a slice with other layers is refused rather than
    // silently exporting part of it.
    if let Some(ids) = selection {
        let slice = ids.iter().find(|id| {
            matches!(x_core::find_node(root, id), Some(n) if matches!(n.kind, NodeKind::Slice))
        });
        match (ids.len(), slice) {
            (1, Some(slice)) => return prepare_slice_export(root, slice, vars, fonts),
            (_, Some(_)) => {
                return Err("a slice exports on its own — select the slice, or the layers".into());
            }
            _ => {}
        }
    }
    let tree = match selection {
        Some([]) => return Err("select at least one layer, or choose Export page".into()),
        Some(ids) => x_render::ir::build_render_tree_selection(root, ids, vars)
            .ok_or("selection no longer exists")?,
        None => x_render::build_render_tree(root, vars),
    };
    // A FRAME's name is canvas chrome (like the canvas grid): it helps identify
    // layers while editing but is never part of the exported artwork — 
    // exports frame names out of the output too. Stripping here (before
    // outlining) keeps label glyph outlines out of BOTH the export content and
    // the computed bounds, in one place, for every export format (PNG / SVG /
    // PDF / clipboard image).
    //
    // A SECTION is different, and its slot name says so: the title chip is part
    // of the section's own artwork and exports with it (`/pill` + `/chip`), which
    // is also why the two do not share the `/label` suffix — stripping the chip's
    // text would have left a solid, wordless tag in the output.
    let tree = {
        let mut t = tree;
        t.commands
            .retain(|c| !x_render::ir::is_frame_name_label(c.key()));
        t
    };
    let mut tree = x_render::text_geometry::outline_text(&tree, fonts)?;
    x_render::text_geometry::outline_strokes(&mut tree);
    let mut bounds: Option<Rect> = None;
    // Keep explicitly sized boxes (including an empty transparent frame).
    fn geometry(n: &Node, parent: Affine, selection: Option<&[String]>, out: &mut Option<Rect>) {
        let world = parent * n.transform.matrix(n.w, n.h);
        if selection.is_none() || selection.is_some_and(|ids| ids.contains(&n.id)) {
            if n.visible {
                union(
                    out,
                    world.transform_rect_bbox(Rect::new(0.0, 0.0, n.w, n.h)),
                );
            }
            if selection.is_none() {
                return;
            }
        }
        for c in &n.children {
            geometry(c, world, selection, out);
        }
    }
    geometry(root, Affine::IDENTITY, selection, &mut bounds);
    let mut clips: Vec<Option<Rect>> = vec![None];
    for command in &tree.commands {
        let r = match command {
            RenderCommand::FillPath {
                path, transform, ..
            } => Some(transform.transform_rect_bbox(path.bounding_box())),
            RenderCommand::Image {
                transform,
                w,
                h,
                rotation,
                ..
            } => {
                let image_transform = *transform
                    * Affine::translate((*w / 2.0, *h / 2.0))
                    * Affine::rotate(rotation.to_radians())
                    * Affine::translate((-*w / 2.0, -*h / 2.0));
                Some(image_transform.transform_rect_bbox(Rect::new(0.0, 0.0, *w, *h)))
            }
            RenderCommand::PushClip {
                path, transform, ..
            } => {
                let b = transform.transform_rect_bbox(path.bounding_box());
                clips.push(Some(
                    clips
                        .last()
                        .copied()
                        .flatten()
                        .map_or(b, |p| p.intersect(b)),
                ));
                None
            }
            RenderCommand::PushLayer { bounds: b, .. } => {
                clips.push(Some(
                    clips
                        .last()
                        .copied()
                        .flatten()
                        .map_or(*b, |p| p.intersect(*b)),
                ));
                None
            }
            RenderCommand::PopLayer => {
                if clips.len() <= 1 {
                    return Err("unbalanced render layers".into());
                }
                clips.pop();
                None
            }
            _ => None,
        };
        if let Some(mut r) = r {
            if let Some(clip) = clips.last().copied().flatten() {
                r = r.intersect(clip);
            }
            if r.width() > 0.0 && r.height() > 0.0 {
                union(&mut bounds, r);
            }
        }
    }
    if clips.len() != 1 {
        return Err("unbalanced render layers".into());
    }
    let bounds = bounds.ok_or("nothing visible to export")?;
    let (w, h) = (bounds.width(), bounds.height());
    if ![w, h, bounds.x0, bounds.y0].iter().all(|n| n.is_finite()) || w <= 0.0 || h <= 0.0 {
        return Err("export has empty/non-finite bounds".into());
    }
    let shift = Affine::translate((-bounds.x0, -bounds.y0));
    for command in &mut tree.commands {
        match command {
            RenderCommand::FillPath { transform, .. }
            | RenderCommand::StrokePath { transform, .. }
            | RenderCommand::Glyphs { transform, .. }
            | RenderCommand::Image { transform, .. }
            | RenderCommand::PushClip { transform, .. } => *transform = shift * *transform,
            RenderCommand::PushLayer { bounds, .. } => *bounds = shift.transform_rect_bbox(*bounds),
            RenderCommand::PopLayer => {}
        }
    }
    Ok(ExportPlan {
        tree,
        width: w,
        height: h,
        origin: (bounds.x0, bounds.y0),
    })
}
fn union(out: &mut Option<Rect>, r: Rect) {
    *out = Some(out.map_or(r, |b| b.union(r)));
}

/// The minimal vector PDF writer has no transparency groups or image alpha.
/// Choose a declared white-paper raster fallback rather than silently losing it.
pub fn pdf_needs_flattening(tree: &RenderTree, assets: &x_render::Assets) -> bool {
    use vello::peniko::{Brush, Mix};
    tree.commands.iter().any(|c| match c {
        RenderCommand::PushLayer { .. } => true,
        RenderCommand::FillPath {
            brush: Brush::Solid(c),
            ..
        } => c.components[3] < 1.0,
        RenderCommand::FillPath {
            brush: Brush::Gradient(g),
            ..
        } => g.stops.iter().any(|s| {
            s.color
                .to_alpha_color::<vello::peniko::color::Srgb>()
                .components[3]
                < 1.0
        }),
        RenderCommand::Image { asset, .. } => assets.get(asset).is_none_or(|i| {
            i.image
                .data
                .data()
                .as_chunks::<4>()
                .0
                .iter()
                .any(|c| c[3] != 255)
        }),
        _ => false,
    }) || tree
        .commands
        .iter()
        .any(|c| matches!(c, RenderCommand::PushLayer { mix, .. } if *mix != Mix::Normal))
}
