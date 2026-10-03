//! Headless GPU proof of the typography stack: renders a specimen sheet
//! through rustybuzz shaping -> Vello -> wgpu -> PNG.
use vello::kurbo::Affine;
use vello::peniko::Color;
use vello::{AaConfig, RenderParams, Renderer, RendererOptions, Scene};
use x_native::text::{encode_rich_text, Align, FontManager, Span, TextBlockStyle};

fn main() {
    pollster::block_on(run());
}

async fn run() {
    let (width, height) = (900u32, 640u32);
    let mut fm = FontManager::new();
    let n = fm.load_system_fonts();
    let _ = fm.load_file(
        "NotoSansArabic",
        "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
    );
    let _ = fm.load_file(
        "NotoSansCJK",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    );
    let _ = fm.load_file(
        "NotoSansDevanagari",
        "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
    );
    // google families for the fixture header (cache-first, skip offline)
    let gf = x_native::text::GoogleFonts::new();
    let _ = gf.load_into(&mut fm, "Inter", 400);
    let _ = gf.load_into(&mut fm, "Roboto", 400);
    eprintln!("fonts loaded: {}", n + 1);
    let f = fm.default_font().expect("fonts");

    let mut scene = Scene::new();
    let white = Color::from_rgb8(0xff, 0xff, 0xff);
    let accent = Color::from_rgb8(0x0d, 0x99, 0xff);
    let dim = Color::from_rgb8(0x9a, 0x9a, 0xa2);
    let style = |w: f64| TextBlockStyle {
        max_width: w,
        line_height: 1.25,
        align: Align::Left,
        wrap: x_native::TextWrap::Auto,
        ..Default::default()
    };
    let mut y = 30.0;
    let put = |scene: &mut Scene, spans: &[Span], y: &mut f64, w: f64| {
        let (_, h) = encode_rich_text(
            scene,
            &fm,
            spans,
            f,
            Affine::translate((40.0, *y)),
            &style(w),
        );
        *y += h + 18.0;
    };

    put(
        &mut scene,
        &[Span::new("Typography Test", 28.0).color(white)],
        &mut y,
        820.0,
    );
    // family row: each name in its own face
    {
        let mut spans = vec![];
        for fam in [
            "Inter 400",
            "Roboto 400",
            "DejaVuSans",
            "NotoSansDevanagari",
            "NotoSansArabic",
        ] {
            if let Some(i) = fm.font_index(fam) {
                spans.push(
                    Span::new(&format!("{}  ", fam.trim_end_matches(" 400")), 18.0)
                        .color(accent)
                        .font(i),
                );
            }
        }
        if !spans.is_empty() {
            put(&mut scene, &spans, &mut y, 820.0);
        }
    }
    put(
        &mut scene,
        &[
            Span::new("Aa  AV  fi  ffi  123   ", 30.0).color(white),
            Span::new("हिन्दी   ", 30.0).color(white),
            Span::new("العربية   ", 30.0).color(white),
            Span::new("中文", 30.0).color(white),
        ],
        &mut y,
        820.0,
    );
    put(
        &mut scene,
        &[
            Span::new("Ligatures: ", 18.0).color(dim),
            Span::new("office waffle fjord difficult", 22.0).color(white),
        ],
        &mut y,
        820.0,
    );
    put(
        &mut scene,
        &[
            Span::new("Kerning: ", 18.0).color(dim),
            Span::new("AVATAR WAVE To Ya LT", 22.0).color(white),
        ],
        &mut y,
        820.0,
    );
    put(
        &mut scene,
        &[
            Span::new("Arabic (RTL, joined): ", 18.0).color(dim),
            Span::new("سلام عليكم — التصميم الجيد", 24.0).color(accent),
        ],
        &mut y,
        820.0,
    );
    put(
        &mut scene,
        &[
            Span::new("Mixed direction: ", 18.0).color(dim),
            Span::new("design سلام tools عليكم native", 20.0).color(white),
        ],
        &mut y,
        820.0,
    );
    put(
        &mut scene,
        &[
            Span::new("CJK wrap: ", 18.0).color(dim),
            Span::new(
                "設計工具は素晴らしい。디자인 도구. 设计工具很棒，可以自动换行到下一行。",
                20.0,
            )
            .color(white),
        ],
        &mut y,
        520.0,
    );
    put(
        &mut scene,
        &[
            Span::new("Letter spacing: ", 18.0).color(dim),
            Span::new("TRACKED OUT", 20.0)
                .color(white)
                .letter_spacing(8.0),
        ],
        &mut y,
        820.0,
    );
    put(
        &mut scene,
        &[
            Span::new("Rich text: ", 18.0).color(dim),
            Span::new("red ", 20.0).color(Color::from_rgb8(0xff, 0x5a, 0x52)),
            Span::new("blue ", 26.0).color(accent),
            Span::new("small ", 13.0).color(white),
            Span::new(
                "and wrapped together in one paragraph flowing naturally.",
                20.0,
            )
            .color(dim),
        ],
        &mut y,
        480.0,
    );

    // ---- wgpu headless render (same as render_headless) ----
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .expect("adapter");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
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
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width,
            height,
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
                base_color: Color::from_rgb8(0x1b, 0x1d, 0x21),
                width,
                height,
                antialiasing_method: AaConfig::Area,
            },
        )
        .expect("render");
    let bpr = (width * 4).div_ceil(256) * 256;
    let buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (bpr * height) as u64,
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
                bytes_per_row: Some(bpr),
                rows_per_image: Some(height),
            },
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(enc.finish()));
    let slice = buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    rx.recv().unwrap().unwrap();
    let data = slice.get_mapped_range();
    let mut px = vec![0u8; (width * height * 4) as usize];
    for row in 0..height as usize {
        let s = row * bpr as usize;
        let d = row * width as usize * 4;
        px[d..d + width as usize * 4].copy_from_slice(&data[s..s + width as usize * 4]);
    }
    let file = std::fs::File::create("type_specimen.png").unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&px).unwrap();
    eprintln!("wrote type_specimen.png");
}
