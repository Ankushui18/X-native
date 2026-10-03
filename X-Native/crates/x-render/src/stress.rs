#[allow(unused_imports)]
use crate::*;
use vello::peniko::Color;
use x_core::*;

// ------------------------------------------------------------------- stress

pub fn benchmark_scene(count: usize) -> Node {
    let mut root = Node::frame("benchmark", 4096.0, 4096.0);
    for i in 0..count {
        let x = ((i * 37) % 4000) as f64;
        let y = ((i * 71) % 4000) as f64;
        let w = 24.0 + (i % 80) as f64;
        let h = 24.0 + (i % 60) as f64;
        let n = if i % 4 == 0 {
            Node::ellipse(
                &format!("e-{i}"),
                x,
                y,
                w,
                h,
                Color::from_rgb8(0x22, 0x88, 0xee),
            )
        } else if i % 7 == 0 {
            Node::line(&format!("l-{i}"), x, y, w, h, Color::BLACK)
        } else {
            Node::rect(
                &format!("r-{i}"),
                x,
                y,
                w,
                h,
                Color::from_rgb8(0xee, 0x66, 0x33),
            )
            .radius((i % 12) as f64)
            .rotate((i as f64 % 16.0) * PI / 32.0)
        };
        root.children.push(n)
    }
    root
}
