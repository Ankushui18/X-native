#[allow(unused_imports)]
use crate::*;
use x_core::*;

// -------------------------------------------------------------- constraints

/// The pin table itself: where a child goes and what size it takes when its
/// container resizes. ONE function, because Figma has one table — the two
/// appliers below only differ in how they write the answer down.
pub fn pin_deltas(c: &Node, dw: f64, dh: f64, sx: f64, sy: f64) -> (f64, f64, f64, f64) {
    let (mut dx, mut dy) = (0.0, 0.0);
    let (mut w, mut h) = (c.w, c.h);
    match c.pin.0 {
        HPin::Left => {}
        HPin::Right => dx = dw,
        HPin::CenterH => dx = dw / 2.0,
        HPin::StretchH => w += dw,
        HPin::ScaleH => {
            dx = c.transform.x * (sx - 1.0);
            w *= sx;
        }
    }
    match c.pin.1 {
        VPin::Top => {}
        VPin::Bottom => dy = dh,
        VPin::CenterV => dy = dh / 2.0,
        VPin::StretchV => h += dh,
        VPin::ScaleV => {
            dy = c.transform.y * (sy - 1.0);
            h *= sy;
        }
    }
    (dx, dy, w, h)
}

/// Do this node's children answer to constraints? Figma's table is about
/// layers inside FRAMES ("how layers should behave when you resize the frame
/// they are in"), so a group — which resizes with its own contents — and a
/// plain shape have none.
pub fn constrains_children(n: &Node) -> bool {
    matches!(n.kind, NodeKind::Frame { .. })
}

/// Phase 2.12: apply pin constraints to `frame`'s children after the frame
/// resizes from (old_w, old_h) to its current (w, h). A child that changed
/// size hands the change on to ITS pinned children, which is how a nested
/// frame behaves on Figma's canvas.
pub fn apply_constraints(frame: &mut Node, old_w: f64, old_h: f64) {
    let (dw, dh) = (frame.w - old_w, frame.h - old_h);
    let (sx, sy) = (
        if old_w > 0.0 { frame.w / old_w } else { 1.0 },
        if old_h > 0.0 { frame.h / old_h } else { 1.0 },
    );
    let mut grew: Vec<(usize, f64, f64)> = Vec::new();
    for (i, c) in frame.children.iter_mut().enumerate() {
        let (ow, oh) = (c.w, c.h);
        let (dx, dy, w, h) = pin_deltas(c, dw, dh, sx, sy);
        c.transform.x += dx;
        c.transform.y += dy;
        c.w = w;
        c.h = h;
        c.dirty = true;
        let grew_here = (w - ow).abs() > 1e-9 || (h - oh).abs() > 1e-9;
        if grew_here && constrains_children(c) {
            grew.push((i, ow, oh));
        }
    }
    for (i, ow, oh) in grew {
        apply_constraints(&mut frame.children[i], ow, oh);
    }
}

/// [`apply_constraints`] written down as commands. A constraint-aware resize is
/// ONE entry on the undo stack: the frame's own `Command::Resize` and the
/// `Move`/`Resize` pairs its children need ride in the same list, so undo and
/// redo move the whole picture together.
pub fn pin_commands(
    children: &[Node],
    new_w: f64,
    new_h: f64,
    old_w: f64,
    old_h: f64,
    out: &mut Vec<Command>,
) {
    let (dw, dh) = (new_w - old_w, new_h - old_h);
    let (sx, sy) = (
        if old_w > 0.0 { new_w / old_w } else { 1.0 },
        if old_h > 0.0 { new_h / old_h } else { 1.0 },
    );
    for c in children {
        let (dx, dy, w, h) = pin_deltas(c, dw, dh, sx, sy);
        if dx != 0.0 || dy != 0.0 {
            out.push(Command::Move {
                id: c.id.clone(),
                dx,
                dy,
            });
        }
        if (w - c.w).abs() > 1e-9 || (h - c.h).abs() > 1e-9 {
            out.push(Command::Resize {
                id: c.id.clone(),
                from: (c.w, c.h),
                to: (w, h),
            });
            if constrains_children(c) {
                pin_commands(&c.children, w, h, c.w, c.h, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(id: &str, x: f64, y: f64, w: f64, h: f64, hp: HPin, vp: VPin) -> Node {
        let mut n = Node::rect(id, x, y, w, h, Color::WHITE);
        n.pin = (hp, vp);
        n
    }

    /// One frame, one child per row of Figma's table.
    fn pinned_frame() -> Node {
        let mut f = Node::frame("f", 200.0, 200.0);
        f.children = vec![
            rect("left", 10.0, 10.0, 40.0, 20.0, HPin::Left, VPin::Top),
            rect("right", 150.0, 10.0, 40.0, 20.0, HPin::Right, VPin::Top),
            rect(
                "band",
                20.0,
                20.0,
                160.0,
                20.0,
                HPin::StretchH,
                VPin::Bottom,
            ),
            rect("mid", 80.0, 90.0, 40.0, 20.0, HPin::CenterH, VPin::CenterV),
            rect(
                "scaled",
                50.0,
                50.0,
                100.0,
                100.0,
                HPin::ScaleH,
                VPin::ScaleV,
            ),
        ];
        f
    }

    fn at(n: &Node, id: &str) -> (f64, f64, f64, f64) {
        let c = find(n, id).expect("child");
        (c.transform.x, c.transform.y, c.w, c.h)
    }

    #[test]
    fn the_pin_table_is_figmas_own() {
        let mut f = pinned_frame();
        f.w = 300.0;
        f.h = 400.0;
        apply_constraints(&mut f, 200.0, 200.0);
        assert_eq!(at(&f, "left"), (10.0, 10.0, 40.0, 20.0));
        assert_eq!(at(&f, "right"), (250.0, 10.0, 40.0, 20.0));
        assert_eq!(at(&f, "band"), (20.0, 220.0, 260.0, 20.0));
        assert_eq!(at(&f, "mid"), (130.0, 190.0, 40.0, 20.0));
        assert_eq!(at(&f, "scaled"), (75.0, 100.0, 150.0, 200.0));
    }

    #[test]
    fn a_nested_frame_hands_the_resize_to_its_own_children() {
        let mut inner = Node::frame("inner", 100.0, 100.0);
        inner.pin = (HPin::StretchH, VPin::StretchV);
        let deep = rect("deep", 80.0, 80.0, 10.0, 10.0, HPin::Right, VPin::Bottom);
        inner.children = vec![deep];
        let mut f = Node::frame("f", 200.0, 200.0);
        f.children = vec![inner];
        f.w = 300.0;
        f.h = 300.0;
        apply_constraints(&mut f, 200.0, 200.0);
        assert_eq!(at(&f, "inner"), (0.0, 0.0, 200.0, 200.0));
        assert_eq!(at(&f, "deep"), (180.0, 180.0, 10.0, 10.0));
    }

    #[test]
    fn the_commands_and_the_in_place_pass_agree() {
        let before = pinned_frame();
        let mut in_place = before.clone();
        in_place.w = 300.0;
        in_place.h = 400.0;
        apply_constraints(&mut in_place, 200.0, 200.0);

        let mut cmds = Vec::new();
        pin_commands(&before.children, 300.0, 400.0, 200.0, 200.0, &mut cmds);
        let mut replayed = before.clone();
        for c in &cmds {
            match c {
                Command::Move { id, dx, dy } => {
                    let n = find_mut(&mut replayed, id).expect("moved");
                    n.transform.x += dx;
                    n.transform.y += dy;
                }
                Command::Resize { id, to, .. } => {
                    let n = find_mut(&mut replayed, id).expect("resized");
                    n.w = to.0;
                    n.h = to.1;
                }
                _ => panic!("pin commands are Move/Resize only"),
            }
        }
        for id in ["left", "right", "band", "mid", "scaled"] {
            assert_eq!(at(&replayed, id), at(&in_place, id), "{id}");
        }
    }
}
