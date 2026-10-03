//! Visual export regression harness (review hardening pass).
//!
//! For each fixture (gradients, masks, booleans, images, text, components,
//! effects) this binary:
//!   1. renders the document with the REAL GPU canvas path (render IR ->
//!      VelloSink -> wgpu offscreen) -> canvas_<name>.png
//!   2. exports SVG -> svg_<name>.svg (rasterize externally w/ rsvg-convert)
//!   3. exports PDF -> pdf_<name>.pdf (rasterize externally w/ ghostscript)
//!
//! The driving shell script rasterizes 2+3 and computes per-fixture RMSE
//! against the canvas render: VISUAL comparison, not structural.

use vello::{AaConfig, RenderParams, Renderer, RendererOptions};
use x_native::editor::{BoolOp, Editor};
use x_native::fileio::export_svg_full;
use x_native::{
    apply_layout_recursive, export_pdf_full, svg_text_outliner, Assets, AutoLayout, Color,
    CrossAlign, Effect, GradSpace, ImageFit, LayoutDirection, Node, NodeKind, Paint, PathCmd,
    Variables,
};

const W: f64 = 400.0;
const H: f64 = 300.0;

fn fixtures() -> Vec<(&'static str, Node)> {
    let mut v: Vec<(&'static str, Node)> = Vec::new();

    v.push((
        "gradients",
        Node::frame("page", W, H)
            .child(
                Node::rect("lin", 20.0, 20.0, 170.0, 120.0, Color::WHITE).fill_paint(
                    Paint::LinearGradient {
                        start: (0.0, 0.0),
                        end: (170.0, 0.0),
                        stops: vec![
                            (0.0, Color::from_rgb8(255, 90, 0)),
                            (1.0, Color::from_rgb8(142, 45, 226)),
                        ],
                        space: GradSpace::Srgb,
                    },
                ),
            )
            .child(
                Node::rect(
                    "solid",
                    210.0,
                    20.0,
                    170.0,
                    120.0,
                    Color::from_rgb8(0x0d, 0x99, 0xff),
                )
                .radius(14.0),
            )
            .child(Node::ellipse(
                "dot",
                20.0,
                160.0,
                120.0,
                120.0,
                Color::from_rgb8(0x2e, 0xcc, 0x71),
            )),
    ));

    v.push((
        "masks",
        Node::frame("page", W, H)
            .child(Node::ellipse("m", 40.0, 40.0, 180.0, 180.0, Color::WHITE).mask(true))
            .child(Node::rect(
                "clipped",
                40.0,
                40.0,
                300.0,
                200.0,
                Color::from_rgb8(0xe7, 0x4c, 0x3c),
            )),
    ));

    // images: all four fit modes of the checker asset side by side
    v.push((
        "images",
        Node::frame("page", W, H)
            .child(Node::image("i1", 10.0, 30.0, 90.0, 110.0, "checker"))
            .child({
                let mut n = Node::image("i2", 105.0, 30.0, 90.0, 110.0, "checker");
                if let NodeKind::Image { fit, .. } = &mut n.kind {
                    *fit = ImageFit::Fit;
                }
                n
            })
            .child({
                let mut n = Node::image("i3", 200.0, 30.0, 90.0, 110.0, "checker");
                if let NodeKind::Image { fit, .. } = &mut n.kind {
                    *fit = ImageFit::Crop;
                }
                n
            })
            .child({
                let mut n = Node::image("i4", 295.0, 30.0, 90.0, 110.0, "checker");
                if let NodeKind::Image { fit, .. } = &mut n.kind {
                    *fit = ImageFit::Tile;
                }
                n
            }),
    ));

    // boolean union traced through the editor (same code path as the app)
    let bool_doc = {
        let page = Node::frame("page", W, H)
            .child(Node::rect(
                "a",
                60.0,
                60.0,
                140.0,
                140.0,
                Color::from_rgb8(0x8e, 0x2d, 0xe2),
            ))
            .child(Node::ellipse(
                "b",
                150.0,
                100.0,
                140.0,
                140.0,
                Color::from_rgb8(0x8e, 0x2d, 0xe2),
            ));
        let mut ed = Editor::new(page);
        ed.selection = vec!["a".into(), "b".into()];
        ed.boolean_selected(BoolOp::Union).expect("union");
        ed.root
    };
    v.push(("booleans", bool_doc));

    v.push((
        "text",
        Node::frame("page", W, H)
            .child(Node::text(
                "t1",
                24.0,
                60.0,
                360.0,
                34.0,
                "Export Regression",
            ))
            .child(Node::text(
                "t2",
                24.0,
                120.0,
                360.0,
                20.0,
                "canvas vs svg vs pdf",
            )),
    ));

    // component instance resolved through the registry
    let comp_doc = {
        let master = Node::component("master", "Card", 200.0, 90.0).child({
            let mut row = Node::frame("row", 200.0, 90.0)
                .auto_layout(AutoLayout {
                    direction: LayoutDirection::Horizontal,
                    gap: 10.0,
                    padding: [10.0; 4],
                    align: CrossAlign::Center,
                    ..Default::default()
                })
                .child(
                    Node::rect(
                        "chip",
                        0.0,
                        0.0,
                        60.0,
                        60.0,
                        Color::from_rgb8(0xf3, 0x9c, 0x12),
                    )
                    .radius(8.0),
                )
                .child(Node::rect(
                    "bar",
                    0.0,
                    0.0,
                    100.0,
                    30.0,
                    Color::from_rgb8(0x34, 0x49, 0x5e),
                ));
            apply_layout_recursive(&mut row, &Variables::default());
            row
        });
        let mut m = master;
        m.visible = false; // master hidden like in the app
        Node::frame("page", W, H)
            .child(m)
            .child(Node::instance("c1", "Card", 30.0, 40.0, 200.0, 90.0))
            .child(Node::instance("c2", "Card", 30.0, 160.0, 200.0, 90.0))
    };
    v.push(("components", comp_doc));

    v.push((
        "effects",
        Node::frame("page", W, H).child(
            Node::rect(
                "sh",
                60.0,
                60.0,
                160.0,
                110.0,
                Color::from_rgb8(0x0d, 0x99, 0xff),
            )
            .radius(12.0)
            .effect(Effect::DropShadow {
                dx: 8.0,
                dy: 10.0,
                blur: 18.0,
                color: Color::from_rgba8(0, 0, 0, 150),
            }),
        ),
    ));

    // vector path fixture (bezier) — exercises PathCmd through all three sinks
    let heart = vec![
        PathCmd::MoveTo(60.0, 30.0),
        PathCmd::CurveTo(60.0, 12.0, 90.0, 12.0, 90.0, 34.0),
        PathCmd::CurveTo(90.0, 50.0, 60.0, 70.0, 60.0, 80.0),
        PathCmd::CurveTo(60.0, 70.0, 30.0, 50.0, 30.0, 34.0),
        PathCmd::CurveTo(30.0, 12.0, 60.0, 12.0, 60.0, 30.0),
        PathCmd::Close,
    ];
    v.push((
        "vectors",
        Node::frame("page", W, H).child(
            Node::vector("heart", 120.0, 80.0, 120.0, 100.0, heart)
                .fill_paint(Paint::Solid(Color::from_rgb8(0xe7, 0x4c, 0x3c))),
        ),
    ));

    v
}

fn main() {
    pollster::block_on(run());
}

async fn run() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("adapter");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: None,
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            ..Default::default()
        })
        .await
        .expect("device");
    let mut renderer = Renderer::new(
        &device,
        RendererOptions {
            use_cpu: false,
            antialiasing_support: vello::AaSupport::all(),
            num_init_threads: std::num::NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .expect("renderer");

    std::fs::create_dir_all("export_fixtures").unwrap();
    let mut assets = Assets::new();
    let _ = assets.load_png("checker", "assets/checker.png");
    let resolver =
        |name: &str| -> Option<Vec<u8>> { std::fs::read(format!("assets/{name}.png")).ok() };
    // TEXT PARITY: same fonts drive canvas, SVG, and PDF text geometry
    let mut fonts = x_native::text::FontManager::new();
    fonts.load_system_fonts();
    let outliner = svg_text_outliner(&fonts);
    let vars = Variables::default();
    for (name, doc) in fixtures() {
        // 1. canvas render (GPU, via the IR — identical to the app's path)
        let (scene, tree) = x_native::render_via_ir(&doc, &vars, Some(&assets), Some(&fonts));
        let (w, h) = (W as u32, H as u32);
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&wgpu::TextureViewDescriptor::default());
        renderer
            .render_to_texture(
                &device,
                &queue,
                &scene,
                &view,
                &RenderParams {
                    base_color: Color::WHITE,
                    width: w,
                    height: h,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .expect("render");
        // readback
        let bpp = 4u32;
        let unpadded = w * bpp;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded = unpadded.div_ceil(align) * align;
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (padded * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        queue.submit(Some(enc.finish()));
        let slice = buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv().unwrap().unwrap();
        let data = slice.get_mapped_range();
        let mut px = vec![0u8; (w * h * 4) as usize];
        for y in 0..h as usize {
            let s = y * padded as usize;
            let d = y * w as usize * 4;
            px[d..d + w as usize * 4].copy_from_slice(&data[s..s + w as usize * 4]);
        }
        drop(data);
        buf.unmap();
        let f = std::fs::File::create(format!("export_fixtures/canvas_{name}.png")).unwrap();
        let mut e = png::Encoder::new(std::io::BufWriter::new(f), w, h);
        e.set_color(png::ColorType::Rgba);
        e.set_depth(png::BitDepth::Eight);
        e.write_header().unwrap().write_image_data(&px).unwrap();

        // 2. SVG export
        std::fs::write(
            format!("export_fixtures/svg_{name}.svg"),
            export_svg_full(&doc, &vars, Some(&resolver), Some(&outliner)),
        )
        .unwrap();
        // 3. PDF export (same IR tree the canvas drew)
        std::fs::write(
            format!("export_fixtures/pdf_{name}.pdf"),
            export_pdf_full(&tree, W, H, Some(&assets), Some(&fonts)),
        )
        .unwrap();
        eprintln!("fixture {name}: canvas png + svg + pdf written");
    }
    eprintln!("done: {} fixtures", fixtures().len());
}
