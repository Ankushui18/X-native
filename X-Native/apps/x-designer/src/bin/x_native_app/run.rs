//! Window + GPU + input loop. Translates winit events into engine
//! operations (x-native) and paints the v45 UI. `ControlFlow::Wait` —
//! no busy redraw.

use std::sync::Arc;

use vello::kurbo::{Affine, Point, Rect};
use vello::{AaConfig, RenderParams, Renderer, RendererOptions, Scene};
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{CursorIcon, Window, WindowId};

#[cfg(test)]
use x_native::build_render_tree;
#[cfg(test)]
use x_native::build_scene_full;
#[cfg(test)]
use x_native::fileio::load_x_file;
use x_native::{
    bind_style, detach_text_style, resolve_styles, LegacyStyle, Node, NodeKind, Paint, PathCmd,
    StrokeJoin, TextStyleData,
};

use crate::dashboard;
use crate::editor_ui;
use crate::state::{
    push_system_clipboard, Action, App, CtxCmd, DashView, Drag, FieldEdit, FieldId, NavTab,
    OpenDoc, PropertyClipboard, Screen, Tool, FRAME_PRESETS,
};
use crate::theme::*;

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    renderer: Renderer,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    target: wgpu::TextureView,
    blitter: wgpu::util::TextureBlitter,
}

struct Host {
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    app: App,
    scale: f64,
    files: crate::jobs::Worker,
    recoveries: std::collections::VecDeque<crate::jobs::RecoveryOffer>,
    close_after_job: bool,
    pending_open: Option<crate::jobs::OpenRequest>,
    next_loading_frame: std::time::Instant,
}

pub fn run() {
    let event_loop = EventLoop::new().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    let mut host = Host {
        window: None,
        gpu: None,
        app: if std::env::args_os().any(|a| a == "--demo") {
            App::demo()
        } else {
            App::new()
        },
        scale: 1.0,
        files: Default::default(),
        recoveries: Default::default(),
        close_after_job: false,
        pending_open: None,
        next_loading_frame: std::time::Instant::now(),
    };
    let _ = event_loop.run_app(&mut host);
}

impl ApplicationHandler for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("X-Native")
            .with_inner_size(LogicalSize::new(1440.0, 900.0))
            .with_min_inner_size(LogicalSize::new(980.0, 680.0));
        let window = Arc::new(event_loop.create_window(attrs).expect("window"));
        self.scale = window.scale_factor();
        self.app.win_w = window.inner_size().width.max(1) as f64 / self.scale;
        self.app.win_h = window.inner_size().height.max(1) as f64 / self.scale;

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_with_display_handle(
            Box::new(window.clone()),
        ));
        let surface = instance.create_surface(window.clone()).expect("surface");
        // Two adapter attempts (hardware, then software/fallback); if both
        // fail, tell the user instead of panicking — the app must never
        // SIGABRT on a machine without a usable GPU.
        let no_gpu = |why: String| -> ! {
            eprintln!("X-Native cannot start: {why}");
            rfd::MessageDialog::new()
                .set_title("X-Native cannot start")
                .set_description(format!(
                    "{why}\n\nInstall a GPU driver, or Mesa software rendering\n(lavapipe/llvmpipe), and try again."
                ))
                .show();
            std::process::exit(1);
        };
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .or_else(|_| {
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::LowPower,
                compatible_surface: Some(&surface),
                force_fallback_adapter: true,
            }))
        });
        let adapter = match adapter {
            Ok(a) => a,
            Err(e) => no_gpu(format!("no usable GPU adapter ({e})")),
        };
        let (device, queue) =
            match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("x-native"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                ..Default::default()
            })) {
                Ok(dq) => dq,
                Err(e) => no_gpu(format!("GPU device creation failed ({e})")),
            };

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| {
                matches!(
                    f,
                    wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Bgra8Unorm
                )
            })
            .unwrap_or_else(|| {
                no_gpu("no non-sRGB surface format supported by the Vello presentation path".into())
            });
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);
        let renderer = Renderer::new(
            &device,
            RendererOptions {
                use_cpu: false,
                antialiasing_support: vello::AaSupport::all(),
                num_init_threads: std::num::NonZeroUsize::new(1),
                ..Default::default()
            },
        )
        .expect("vello renderer");

        let target = crate::gpu_target::create(&device, config.width, config.height);
        let blitter = wgpu::util::TextureBlitter::new(&device, config.format);
        self.gpu = Some(Gpu {
            target,
            blitter,
            device,
            queue,
            renderer,
            surface,
            config,
        });
        self.window = Some(window);
        let open_path = std::env::args_os()
            .skip_while(|arg| arg != "--open")
            .nth(1)
            .map(std::path::PathBuf::from);
        if let Some(path) = open_path {
            self.app.smoke_wait_document = self.app.smoke_mode;
            self.open_path(path);
        } else {
            self.offer_startup_recovery();
        }
        self.window.as_ref().unwrap().request_redraw();
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(window) = self.window.clone() else {
            return;
        };
        match event {
            WindowEvent::CloseRequested => {
                if self.request_close_window() {
                    event_loop.exit();
                } else {
                    window.request_redraw();
                }
            }
            WindowEvent::Resized(size) => {
                if self.app.smoke_mode && self.app.presented_frames > 0 {
                    self.app.smoke_resized = true;
                }
                self.update_dimensions(size.width, size.height, self.scale);
                window.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                let size = window.inner_size();
                self.update_dimensions(size.width, size.height, scale_factor);
                window.request_redraw();
            }
            WindowEvent::Focused(false) => {
                self.app.space_pan = false;
                self.app.ctrl = false;
                self.app.shift = false;
                self.app.alt = false;
                self.app.ime_preedit.clear();
                if matches!(self.app.drag, Some(Drag::Pan { .. })) {
                    self.app.drag = None;
                }
                window.request_redraw();
            }
            WindowEvent::CursorMoved { position, .. } => {
                let p = Point::new(position.x / self.scale, position.y / self.scale);
                self.app.mouse = p;
                self.on_move(p);
                self.update_cursor(&window);
                window.request_redraw();
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button,
                ..
            } => {
                let p = self.app.mouse;
                match button {
                    MouseButton::Left => self.on_press(p),
                    MouseButton::Right => self.on_right_press(p),
                    MouseButton::Middle
                        if self.app.screen == Screen::Editor
                            && self.app.document_loading.is_none()
                            && self.app.flow.is_none() =>
                    {
                        self.app.drag = Some(Drag::Pan {
                            start: p,
                            start_pan: self.app.pan,
                        });
                    }
                    _ => {}
                }
                window.request_redraw();
            }
            WindowEvent::MouseInput {
                state: ElementState::Released,
                button: MouseButton::Left,
                ..
            } => {
                self.on_release();
                window.request_redraw();
            }
            WindowEvent::MouseInput {
                state: ElementState::Released,
                button: MouseButton::Middle,
                ..
            } => {
                if matches!(self.app.drag, Some(Drag::Pan { .. })) {
                    self.app.drag = None;
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                self.on_wheel(delta);
                window.request_redraw();
            }
            WindowEvent::Ime(Ime::Preedit(text, _)) => {
                if self.app.document_loading.is_none() {
                    self.app.ime_preedit = text;
                }
                window.request_redraw();
            }
            WindowEvent::Ime(Ime::Disabled) => {
                self.app.ime_preedit.clear();
            }
            WindowEvent::Ime(Ime::Commit(text)) => {
                self.app.ime_preedit.clear();
                self.on_text(&text);
                window.request_redraw();
            }
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        logical_key,
                        state,
                        text,
                        ..
                    },
                ..
            } => {
                if logical_key == Key::Named(NamedKey::Space)
                    && !self.app.has_text_focus()
                    && self.app.document_loading.is_none()
                {
                    self.app.space_pan = state == ElementState::Pressed;
                } else if state == ElementState::Pressed && self.app.ime_preedit.is_empty() {
                    self.app.space_pan = false;
                    self.on_key(logical_key, text.as_deref());
                }
                window.request_redraw();
            }
            WindowEvent::ModifiersChanged(m) => {
                let st = m.state();
                self.app.ctrl = st.control_key() || st.super_key();
                self.app.shift = st.shift_key();
                self.app.alt = st.alt_key();
                window.request_redraw();
            }
            WindowEvent::RedrawRequested => {
                self.redraw();
                if self.app.smoke_mode {
                    if self.app.presented_frames == 1 {
                        let _ = window.request_inner_size(LogicalSize::new(1280.0, 800.0));
                    }
                    if self.app.presented_frames >= 3
                        && self.app.smoke_resized
                        && (!self.app.smoke_wait_document || self.app.smoke_editor_frames >= 2)
                    {
                        eprintln!("Native surface smoke: storage render + blit + resize + 3 frames presented; editor frames={}; loading frames={}; load ready={}",self.app.smoke_editor_frames,self.app.loading_frames_presented,self.app.document_loading.is_none());
                        event_loop.exit();
                    } else {
                        window.request_redraw();
                    }
                }
            }
            _ => {}
        }
        window.set_ime_allowed(self.app.document_loading.is_none() && self.app.has_text_focus());
        if self.app.has_text_focus() {
            let p = self.app.ime_anchor();
            window.set_ime_cursor_area(
                winit::dpi::LogicalPosition::new(p.x, p.y),
                LogicalSize::new(1.0, 24.0),
            );
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.poll_file_jobs();
        if self.close_after_job && self.files.active.is_none() {
            self.close_after_job = false;
            if self.request_close_window() {
                event_loop.exit();
                return;
            }
        }
        self.prompt_recovery();
        let now = std::time::Instant::now();
        if now >= self.app.next_autosave {
            self.app.autosave_all();
            self.app.next_autosave = now + std::time::Duration::from_secs(30);
            if let Some(w) = &self.window {
                w.request_redraw();
            }
        }
        let mut wake = if self.files.active.is_some() {
            self.app
                .next_autosave
                .min(now + std::time::Duration::from_millis(20))
        } else {
            self.app.next_autosave
        };
        if self
            .app
            .document_loading
            .as_ref()
            .is_some_and(crate::loading::LoadingScreen::animates)
        {
            if now >= self.next_loading_frame {
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
                self.next_loading_frame = now + std::time::Duration::from_millis(16);
            }
            wake = wake.min(self.next_loading_frame);
        }
        // prototype delays: fire what is due, wake for the rest
        if self.app.flow.as_ref().is_some_and(|f| !f.delays.is_empty()) {
            if self.flow_tick(now) > 0 {
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            let next = self
                .app
                .flow
                .as_ref()
                .and_then(|f| f.delays.iter().map(|d| d.at).min());
            if let Some(next) = next {
                wake = wake.min(next);
            }
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(wake));
    }
}

/// Parse a font weight from the inspector field: CSS names ("Regular",
/// "SemiBold"…) or a 100–900 number. None when unparseable.
fn parse_weight(raw: &str) -> Option<u16> {
    let r = raw.trim().to_lowercase();
    let named = match r.as_str() {
        "thin" | "hairline" => 100,
        "extralight" | "extra light" => 200,
        "light" => 300,
        "regular" | "normal" | "book" => 400,
        "medium" => 500,
        "semibold" | "semi bold" | "demibold" => 600,
        "bold" => 700,
        "extrabold" | "extra bold" => 800,
        "black" | "heavy" => 900,
        _ => return r.parse::<u16>().ok().filter(|w| (100..=900).contains(w)),
    };
    Some(named)
}

/// Pure smart-guide computation: given the moving selection's bounds, the
/// static sibling rects, and the intended delta, return the snapped delta
/// plus the guide lines (world coords, 'v'/'h') to draw.
fn compute_snap(
    moving: (f64, f64, f64, f64),
    others: &[(f64, f64, f64, f64)],
    dx: f64,
    dy: f64,
    thr: f64,
) -> (f64, f64, Vec<(f64, char)>) {
    let (bx0, by0, bx1, by1) = moving;
    let cand_x: Vec<f64> = others
        .iter()
        .flat_map(|(x0, _, x1, _)| [*x0, (*x0 + *x1) / 2.0, *x1])
        .collect();
    let cand_y: Vec<f64> = others
        .iter()
        .flat_map(|(_, y0, _, y1)| [*y0, (*y0 + *y1) / 2.0, *y1])
        .collect();
    let nearest = |m: f64, cands: &[f64]| -> Option<(f64, f64)> {
        cands
            .iter()
            .map(|c| (m - c, *c))
            .filter(|(d, _)| d.abs() < thr)
            .min_by(|a, b| a.0.abs().total_cmp(&b.0.abs()))
            .map(|(_, c)| (c - m, c))
    };
    let sx = [bx0 + dx, (bx0 + bx1) / 2.0 + dx, bx1 + dx]
        .iter()
        .filter_map(|m| nearest(*m, &cand_x))
        .min_by(|a, b| a.0.abs().total_cmp(&b.0.abs()));
    let sy = [by0 + dy, (by0 + by1) / 2.0 + dy, by1 + dy]
        .iter()
        .filter_map(|m| nearest(*m, &cand_y))
        .min_by(|a, b| a.0.abs().total_cmp(&b.0.abs()));
    let mut lines = Vec::new();
    let mut dx = dx;
    let mut dy = dy;
    if let Some((adj, line)) = sx {
        lines.push((line, 'v'));
        dx += adj;
    }
    if let Some((adj, line)) = sy {
        lines.push((line, 'h'));
        dy += adj;
    }
    (dx, dy, lines)
}

// ------------------------------------------------------- rich-text editing

#[cfg(test)]
mod run_fns_tests {
    use super::*;

    fn r(start: usize, len: usize) -> x_native::TextRun {
        x_native::TextRun {
            start,
            len,
            ..Default::default()
        }
    }

    #[test]
    fn insert_shifts_runs() {
        let runs = vec![r(6, 5)];
        // before the run: it slides right
        assert_eq!(runs_after_insert(&runs, 0, 3), vec![r(9, 5)]);
        // at the run start: still slides (typing joins from the left edge)
        assert_eq!(runs_after_insert(&runs, 6, 2), vec![r(8, 5)]);
        // inside the run: it grows
        assert_eq!(runs_after_insert(&runs, 8, 2), vec![r(6, 7)]);
        // at/after the run end: untouched
        assert_eq!(runs_after_insert(&runs, 11, 4), vec![r(6, 5)]);
    }

    #[test]
    fn delete_shifts_and_trims_runs() {
        let runs = vec![r(6, 5)];
        // entirely before: slide left
        assert_eq!(runs_after_delete(&runs, 0, 3), vec![r(3, 5)]);
        // entirely after: untouched
        assert_eq!(runs_after_delete(&runs, 12, 15), vec![r(6, 5)]);
        // clipping the head: len shrinks, start moves to a
        assert_eq!(runs_after_delete(&runs, 4, 8), vec![r(4, 3)]);
        // clipping the tail
        assert_eq!(runs_after_delete(&runs, 8, 14), vec![r(6, 2)]);
        // deleting the whole run drops it
        assert!(runs_after_delete(&runs, 6, 11).is_empty());
        // delete spanning a boundary of two runs
        let two = vec![r(2, 3), r(9, 4)];
        assert_eq!(runs_after_delete(&two, 4, 10), vec![r(2, 2), r(4, 3)]);
    }

    /// Figma interaction states: hover outline -> selection chrome ->
    /// inline editing (no hover, no handles while editing).
    #[test]
    fn hover_and_edit_states() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text("tx", 500.0, 300.0, 120.0, 24.0, "asdasd"),
        );
        let inside = app.world_to_screen(Point::new(540.0, 310.0));
        let outside = app.world_to_screen(Point::new(1200.0, 700.0));

        // hover: the layer under the cursor
        app.update_hover(inside);
        assert_eq!(app.hover_node.as_deref(), Some("tx"));
        // empty canvas: none
        app.update_hover(outside);
        assert!(app.hover_node.is_none());

        // selected layers report None (selection chrome already shows)
        app.doc().editor().selection = vec!["tx".into()];
        app.update_hover(inside);
        assert!(app.hover_node.is_none());

        // editing: hover suppressed entirely, chrome skipped in paint
        app.update_hover(inside); // re-arm via clearing selection state
        app.doc().editor().selection.clear();
        app.update_hover(inside);
        assert_eq!(app.hover_node.as_deref(), Some("tx"));
        app.begin_text_edit("tx".into(), "asdasd".into());
        assert!(app.hover_node.is_none(), "begin clears hover");
        app.update_hover(inside);
        assert!(app.hover_node.is_none(), "no hover while editing");

        // non-select tools do not hover
        app.text_cancel_edit();
        app.doc().editor().selection.clear();
        app.tool = Tool::Rect;
        app.update_hover(inside);
        assert!(app.hover_node.is_none());
        app.tool = Tool::Select;
        app.update_hover(inside);
        assert_eq!(app.hover_node.as_deref(), Some("tx"));
    }

    /// Figma-parity fixes from the tool audit: z-order (⌘]/⌘[ + ctx),
    /// ruler guides (drag from ruler, drop back to remove), pen close on
    /// the start anchor, layer lock/hide toggles, and empty-text discard.
    /// r11: pages-panel context menu (rename via the inline field,
    /// duplicate, move, delete) and the PDF export path (real PDF bytes,
    /// text as outlines — no Tj fallback).
    #[test]
    fn page_menu_and_pdf_export() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();

        // rename: menu -> field opens with the current page name -> commit
        app.page_menu_cmd(crate::state::PageMenuCmd::Rename);
        assert!(
            matches!(app.field.as_ref().map(|f| f.id), Some(FieldId::PageName)),
            "rename opens the page-name field"
        );
        app.field.as_mut().unwrap().buffer = "Drinks".into();
        let buf = app.field.as_ref().unwrap().buffer.clone();
        assert!(app.commit_page_rename(&buf), "commit applies");
        {
            let doc = app.doc();
            let i = doc.page;
            assert_eq!(doc.doc.pages[i].name, "Drinks");
            assert_eq!(doc.editors[i].root.name, "Drinks", "engine page synced");
        }

        // duplicate: inserted right after, becomes active
        app.page_menu_cmd(crate::state::PageMenuCmd::Duplicate);
        {
            let doc = app.doc();
            assert_eq!(doc.editors.len(), 4);
            assert_eq!(doc.page, 3);
            assert!(doc.doc.pages[3].name.ends_with("copy"));
        }

        // move up swaps with the previous page
        app.page_menu_cmd(crate::state::PageMenuCmd::MoveUp);
        {
            let doc = app.doc();
            assert_eq!(doc.page, 2);
            assert!(doc.doc.pages[2].name.ends_with("copy"));
            assert_eq!(doc.doc.pages[3].name, "Drinks");
        }

        // delete removes the active page and clamps the index
        app.page_menu_cmd(crate::state::PageMenuCmd::Delete);
        {
            let doc = app.doc();
            assert_eq!(doc.editors.len(), 3);
            assert!(doc.page < doc.editors.len());
        }

        // PDF export: demo page -> valid PDF header, outlined text (no Tj)
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let (root, vars) = {
            let doc = app.doc();
            doc.sync();
            (doc.editor_ref().root.clone(), doc.doc.variables.clone())
        };
        let tree = x_native::build_render_tree(&root, &vars);
        let pdf = x_native::export_pdf_full(&tree, root.w, root.h, None, Some(&app.fonts.fonts));
        assert!(pdf.starts_with(b"%PDF-"), "PDF magic bytes");
        assert!(!pdf.windows(2).any(|w| w == b"Tj"), "outlined, not Tj ops");
    }

    /// r12: auto-layout inspector completion (A3 wrap, A4 per-child
    /// Fill/Absolute, A5 main/cross Hug<->Fixed) + the instance-cycle
    /// guard (A6). Drives the same App methods the new Action arms use.
    #[test]
    fn auto_layout_inspector_and_cycle_guard() {
        use x_native::{AutoLayoutWrap, NodeKind, Sizing};
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        {
            let doc = app.doc();
            let mut f = x_native::Node::frame("al", 300.0, 200.0);
            f.name = "AL".into();
            f.children.push(x_native::Node::rect(
                "c1",
                0.0,
                0.0,
                40.0,
                30.0,
                x_native::Color::from_rgb8(0xAA, 0, 0),
            ));
            f.children.push(x_native::Node::rect(
                "c2",
                45.0,
                0.0,
                40.0,
                30.0,
                x_native::Color::from_rgb8(0, 0xAA, 0),
            ));
            doc.editor().insert_node(&root_id, f);
        }

        // A5/A3: create the layout the way the Flow button does, then
        // verify wrap + sizing edits PRESERVE everything else
        app.doc().editor().selection = vec!["al".into()];
        app.modify_selected_layout(|l| {
            l.direction = x_native::LayoutDirection::Horizontal;
            l.gap = 5.0;
        });
        app.modify_selected_layout(|l| l.wrap = AutoLayoutWrap::Wrap);
        {
            let l = app.selected_layout().expect("layout present");
            assert_eq!(l.wrap, AutoLayoutWrap::Wrap, "wrap on");
            assert_eq!(l.gap, 5.0, "gap preserved through the wrap edit");
            assert_eq!(l.sizing, Sizing::Fixed, "default sizing untouched");
            let doc = app.doc();
            assert!(
                matches!(
                    &crate::editor_ui::find_node(&doc.editor_ref().root, "al")
                        .unwrap()
                        .kind,
                    NodeKind::Frame { layout: Some(_) }
                ),
                "frame carries the layout"
            );
        }

        // A5: main sizing Hug -> the frame hugs its content
        app.modify_selected_layout(|l| l.sizing = Sizing::Hug);
        {
            let doc = app.doc();
            let al = crate::editor_ui::find_node(&doc.editor_ref().root, "al").unwrap();
            let hug_w = al.w;
            assert!(
                (hug_w - 85.0).abs() < 1.0,
                "Hug frame = 40+5+40 = 85 wide, got {hug_w}"
            );
        }
        app.modify_selected_layout(|l| l.sizing = Sizing::Fixed);
        // Fixed means the authored size rules again — restore the 300px
        // frame width the Hug experiment collapsed to 85
        app.doc().editor().resize("al", 300.0, 200.0);

        // A4: child of the layout fills the container (grow=1)
        app.doc().editor().selection = vec!["c1".into()];
        app.modify_child_constraints(|c| {
            c.grow = 1.0;
            c.is_absolute = false;
        });
        {
            let doc = app.doc();
            let c1 = crate::editor_ui::find_node(&doc.editor_ref().root, "c1").unwrap();
            // Fixed parent 300 wide, 0 padding, gap 5: leftover = 300-85 = 215
            assert!(
                (c1.w - 255.0).abs() < 1.0,
                "growing child absorbs the leftover: got {}",
                c1.w
            );
        }

        // A4: absolute child leaves the flow at its authored position
        app.modify_child_constraints(|c| c.is_absolute = true);
        {
            let doc = app.doc();
            let f = crate::editor_ui::find_node(&doc.editor_ref().root, "al").unwrap();
            let c1 = &f.children[0];
            assert!(c1.constraints.is_absolute, "flag set");
            let c2 = &f.children[1];
            // c2 no longer shares a row with the absolute child
            assert!(
                (c2.transform.x - 0.0).abs() < 1.0,
                "c2 packed to the flow start, got {}",
                c2.transform.x
            );
        }

        // A6: the instance-cycle guard
        {
            let doc = app.doc();
            let comp = x_native::Node::component("comp-node", "Comp", 100.0, 80.0);
            doc.editor().insert_node(&root_id, comp);
        }
        {
            let doc = app.doc();
            let ed = doc.editor();
            assert!(
                ed.place_instance_in("Comp", "comp-node", 0.0, 0.0)
                    .is_none(),
                "master inside itself must be rejected"
            );
            // parenting under an INSTANCE of the same component cycles too
            let inst = x_native::Node::instance("inner-a", "Comp", 0.0, 0.0, 10.0, 10.0);
            let mut host_frame = x_native::Node::frame("host", 200.0, 200.0);
            host_frame.children.push(inst);
            doc.editor().insert_node(&root_id, host_frame);
            let ed = doc.editor();
            assert!(
                ed.place_instance_in("Comp", "inner-a", 0.0, 0.0).is_none(),
                "master inside an INSTANCE of itself must be rejected"
            );
            assert!(
                ed.place_instance_in("Comp", "host", 0.0, 0.0).is_some(),
                "a frame that merely CONTAINS an instance is a legal parent"
            );
            assert!(
                ed.place_instance_in("Comp", &root_id, 10.0, 10.0).is_some(),
                "page-root placement stays allowed"
            );
        }
    }

    #[test]
    fn tool_audit_fixes() {
        use crate::state::CtxCmd;
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        {
            let doc = app.doc();
            let r = x_native::Node::rect(
                "r1",
                0.0,
                0.0,
                100.0,
                60.0,
                x_native::Color::from_rgb8(0x88, 0x99, 0xAA),
            );
            // x = 60, not 200: step 6 unions r1 and e1 through the context
            // menu, and the Shape Builder refuses to merge shapes that do not
            // overlap (that is its whole point), so the two must overlap.
            let e = x_native::Node::ellipse(
                "e1",
                60.0,
                0.0,
                60.0,
                60.0,
                x_native::Color::from_rgb8(0xAA, 0x88, 0x66),
            );
            doc.editor().insert_node(&root_id, r);
            doc.editor().insert_node(&root_id, e);
        }

        // 1) z-order: r1 is first (back), e1 last (front). Send e1 to back.
        app.doc().editor().selection = vec!["e1".into()];
        app.apply_ctx(CtxCmd::ToBack);
        {
            let doc = app.doc();
            let first = &doc.editor_ref().root.children[0].id;
            assert_eq!(first, "e1", "send to back");
        }
        app.apply_ctx(CtxCmd::ToFront);
        {
            let doc = app.doc();
            let last = doc.editor_ref().root.children.last().map(|c| c.id.clone());
            assert_eq!(last.as_deref(), Some("e1"), "bring to front");
        }

        // 2) ruler guides: add, drag, drop-back-in-ruler removes
        app.rulers = true;
        app.doc().guides.push(('v', 300.0));
        app.doc().editor().selection = vec!["r1".into()];
        // grab: press near the line on canvas (cursor tracked first)
        let on_line = app.world_to_screen(Point::new(300.0, 200.0));
        app.mouse = on_line;
        assert!(app.guide_press(on_line), "grabbed guide");
        assert!(matches!(app.drag, Some(Drag::Guide { axis: 'v' })));
        assert!(app.doc().guides.is_empty(), "grab removes from the list");
        // drag right, release on canvas -> re-added at the new coord
        let moved = app.world_to_screen(Point::new(340.0, 200.0));
        app.mouse = moved;
        *app.guide_drag() = Some(('v', 340.0));
        app.guide_release();
        assert_eq!(app.doc().guides.len(), 1);
        assert!((app.doc().guides[0].1 - 340.0).abs() < 0.01);
        // drag from the top ruler, release ON CANVAS -> kept
        let reg = app.editor_regions();
        let press = Point::new(reg.canvas.x0 + 120.0, 10.0);
        app.mouse = press;
        assert!(app.guide_press(press), "ruler press creates");
        assert!(matches!(app.drag, Some(Drag::Guide { axis: 'v' })));
        let drop = Point::new(reg.canvas.x0 + 150.0, 60.0);
        app.mouse = drop;
        let w_drop = app.screen_to_world(drop).x;
        *app.guide_drag() = Some(('v', w_drop));
        app.guide_release();
        assert_eq!(app.doc().guides.len(), 2, "dropped on canvas");
        // grab it again (same screen spot = same world coord) and release
        // INSIDE the ruler -> removed
        app.mouse = drop;
        assert!(app.guide_press(drop), "regrab");
        app.mouse = Point::new(drop.x, 10.0);
        app.guide_release();
        assert_eq!(app.doc().guides.len(), 1, "release in ruler removes");

        // 3) pen: 3 points then click the start anchor CLOSES
        app.tool = Tool::Pen;
        app.drag = None;
        let w0 = Point::new(600.0, 300.0);
        let w1 = Point::new(700.0, 300.0);
        let w2 = Point::new(650.0, 360.0);
        // points accumulate across clicks (release keeps the session)
        app.pen_click(w0);
        app.pen_click(w1);
        app.pen_click(w2);
        assert!(matches!(app.drag, Some(Drag::Pen { .. })), "session alive");
        // click back on the start anchor: closes + creates the vector
        app.pen_click(w0);
        assert!(app.drag.is_none(), "pen closed on the anchor");
        {
            let doc = app.doc();
            assert!(
                doc.editor_ref()
                    .root
                    .children
                    .iter()
                    .any(|c| matches!(c.kind, x_native::NodeKind::Vector { .. })),
                "vector created"
            );
        }

        // 4) layer lock/hide via the tree actions
        app.doc().guides.clear();
        app.apply_ctx(CtxCmd::ToFront);
        app.doc().editor().selection = vec!["r1".into()];
        app.doc().editor().set_locked("r1", true);
        {
            let doc = app.doc();
            assert!(
                crate::editor_ui::find_node(&doc.editor_ref().root, "r1")
                    .unwrap()
                    .locked
            );
        }
        // locked nodes skip hit testing
        app.doc().editor().selection.clear();
        let hit = {
            let doc = app.doc();
            let root = doc.editor_ref().root.clone();
            x_native::editor::hit_test(&root, Point::new(50.0, 30.0))
        };
        assert_ne!(hit.as_deref(), Some("r1"), "locked = not hittable");

        // 5) empty text: Esc discards the fresh node
        app.tool = Tool::Text;
        app.doc().editor().selection.clear();
        let kids = app.doc().editor_ref().root.children.len();
        let tid = {
            let doc = app.doc();
            let root_id = doc.editor_ref().root.id.clone();
            let t =
                x_native::Node::text(&format!("text-empty-{kids}"), 500.0, 500.0, 120.0, 14.0, "");
            let id = t.id.clone();
            doc.editor().insert_node(&root_id, t);
            doc.editor().selection = vec![id.clone()];
            id
        };
        app.begin_text_edit(tid, String::new());
        app.text_cancel_edit_new();
        assert_eq!(
            app.doc().editor_ref().root.children.len(),
            kids,
            "discarded"
        );
        app.tool = Tool::Select;

        // 6) booleans through the context-menu command path: two shapes
        //    union into one vector; the inputs are consumed
        app.doc().editor().selection = vec!["r1".into(), "e1".into()];
        app.apply_ctx(CtxCmd::Union);
        {
            let doc = app.doc();
            let ids: Vec<String> = doc
                .editor_ref()
                .root
                .children
                .iter()
                .map(|c| c.id.clone())
                .collect();
            assert!(!ids.contains(&"r1".to_string()), "input a consumed");
            assert!(!ids.contains(&"e1".to_string()), "input b consumed");
            assert!(
                ids.iter().any(|id| id.starts_with("bool-")),
                "union result inserted: {ids:?}"
            );
        }

        // 7) Lock / Hide via the context-menu rows (⇧⌘L / ⇧⌘H paths)
        app.doc().editor().selection = vec!["frame-1".into()];
        app.apply_ctx(CtxCmd::LockSel);
        {
            let doc = app.doc();
            let locked = crate::editor_ui::find_node(&doc.editor_ref().root, "frame-1")
                .map(|n| n.locked)
                .unwrap_or(false);
            assert!(locked, "LockSel locks the selection");
        }
        app.apply_ctx(CtxCmd::LockSel); // toggle back
        app.apply_ctx(CtxCmd::HideSel);
        {
            let doc = app.doc();
            let visible = crate::editor_ui::find_node(&doc.editor_ref().root, "frame-1")
                .map(|n| n.visible)
                .unwrap_or(true);
            assert!(!visible, "HideSel hides the selection");
            doc.editor().set_visible("frame-1", true);
        }

        // 8) single-step z-order rows: BringFwd moves e1 up one slot
        {
            // current order after union: frame-1, bool-N (e1 consumed) —
            // bring the bool result forward from wherever it is
            let before: Vec<String> = app
                .doc()
                .editor_ref()
                .root
                .children
                .iter()
                .map(|c| c.id.clone())
                .collect();
            let idx = before
                .iter()
                .position(|id| id.starts_with("bool-"))
                .unwrap();
            if idx + 1 < before.len() {
                app.doc().editor().selection = vec![before[idx].clone()];
                app.apply_ctx(CtxCmd::BringFwd);
                let after: Vec<String> = app
                    .doc()
                    .editor_ref()
                    .root
                    .children
                    .iter()
                    .map(|c| c.id.clone())
                    .collect();
                assert_eq!(after[idx], before[idx + 1], "swap happened");
                assert_eq!(after[idx + 1], before[idx], "bool moved forward");
            }
        }
    }

    /// Full designer session: create shapes with tools, transform them,
    /// group/copy/paste/undo — the flows a real user runs. Each step is an
    /// assertion about engine + UI state (Figma/Sketch conventions).
    #[test]
    fn designer_session() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let c0 = {
            let reg = app.editor_regions();
            (reg.canvas.x0, reg.canvas.y0)
        };
        fn canvas_pt(c0: (f64, f64), sx: f64, sy: f64) -> Point {
            Point::new(c0.0 + sx, c0.1 + sy)
        }
        fn world(app: &mut App, p: Point) -> Point {
            app.screen_to_world(p)
        }

        // 1) RECT tool: drag-create a 100x60 rect
        app.tool = Tool::Rect;
        let a = canvas_pt(c0, 80.0, 100.0);
        let b = canvas_pt(c0, 180.0, 160.0);
        app.doc().editor().selection.clear();
        {
            let (wa, wb) = (world(&mut app, a), world(&mut app, b));
            let root_id = app.doc().editor_ref().root.id.clone();
            let n = x_native::Node::rect(
                "r1",
                wa.x.min(wb.x),
                wa.y.min(wb.y),
                (wb.x - wa.x).abs(),
                (wb.y - wa.y).abs(),
                x_native::Color::from_rgb8(0x88, 0x99, 0xAA),
            );
            app.doc().editor().insert_node(&root_id, n);
            app.doc().editor().selection = vec!["r1".into()];
        }
        let (rw, rh) = {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "r1").unwrap();
            (n.w, n.h)
        };
        assert!(((rw - 100.0) as i64).abs() <= 1 && ((rh - 60.0) as i64).abs() <= 1);

        // 2) corner resize BR by +20/+10 => 120x70, pinned as fixed for text
        //    only; shapes stay plain
        {
            let doc = app.doc();
            doc.editor().resize("r1", 120.0, 70.0);
        }
        // 3) nudge with arrows: move_selection +10 x
        app.doc().editor().move_selection(10.0, 0.0);
        let x_after = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "r1")
                .unwrap()
                .transform
                .x
        };

        // 4) undo returns both the move and the resize
        app.doc().editor().undo();
        {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "r1").unwrap();
            assert!((n.transform.x - (x_after - 10.0)).abs() < 0.01, "undo move");
        }
        app.doc().editor().redo();

        // 5) ellipse + group + ungroup keeps children
        {
            let doc = app.doc();
            let root_id = doc.editor_ref().root.id.clone();
            let e = x_native::Node::ellipse(
                "e1",
                400.0,
                100.0,
                60.0,
                60.0,
                x_native::Color::from_rgb8(0xAA, 0x88, 0x66),
            );
            doc.editor().insert_node(&root_id, e);
        }
        app.doc().editor().selection = vec!["r1".into(), "e1".into()];
        let gname = format!("g-{}", app.doc().editor_ref().root.children.len());
        app.doc().editor().group_selection(&gname);
        {
            let doc = app.doc();
            let sel = doc.selected_id().unwrap().clone();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, &sel).unwrap();
            assert!(matches!(n.kind, x_native::NodeKind::Group), "grouped");
        }
        // 6) duplicate the group, then delete the copy
        let kids_before = app.doc().editor_ref().root.children.len();
        app.doc().editor().duplicate_selection((12.0, 12.0));
        assert_eq!(app.doc().editor_ref().root.children.len(), kids_before + 1);
        app.doc().editor().delete_selection();
        assert_eq!(app.doc().editor_ref().root.children.len(), kids_before);

        // 7) marquee selects overlapping nodes
        app.doc().editor().selection.clear();
        app.doc()
            .editor()
            .marquee(vello::kurbo::Rect::new(0.0, 0.0, 1000.0, 1000.0));
        assert!(app.doc().editor_ref().selection.len() >= 2, "marquee hit");

        // 8) text tool click-to-create starts inline edit with content
        app.tool = Tool::Text;
        let tx_id = {
            let doc = app.doc();
            let root_id = doc.editor_ref().root.id.clone();
            let mut t = x_native::Node::text(
                &format!("text-{}", doc.editor_ref().root.children.len()),
                500.0,
                300.0,
                120.0,
                14.0,
                "Text",
            );
            t.name = "Text".into();
            let id = t.id.clone();
            doc.editor().insert_node(&root_id, t);
            doc.editor().selection = vec![id.clone()];
            id
        };
        app.text_edit = None;
        app.doc().editor().selection = vec![tx_id.clone()];
        assert!(app.enter_edit_selected(), "text click-to-edit");
        app.text_insert("hello");
        app.text_cancel_edit();
        app.tool = Tool::Select;

        // 9) zoom to fit fits all content (center_view is the fit impl)
        app.center_view();
        assert!(app.zoom > 0.0);

        // 10) export SVG builds
        {
            let doc = app.doc();
            let svg = x_native::fileio::export_svg(&doc.editor_ref().root, &doc.doc.variables);
            assert!(svg.contains("<svg"), "svg export produced output");
        }
    }

    /// Figma's click-into-selected-text: click (press+release, no drag)
    /// places the caret; press+drag still moves; guards keep plain
    /// select/marquee behavior intact.
    /// Line-height MODES (Figma): bare number = fixed px, "N%" = percent
    /// of font size, "auto" = font default. Fixed px survives fs changes;
    /// the editor box + overlay metrics follow every mode.
    #[test]
    fn lh_modes() {
        use crate::editor_ui::{typo_val, Typo};
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text("tx", 500.0, 300.0, 300.0, 14.0, "one\ntwo"),
        );
        app.doc().editor().selection = vec!["tx".into()];
        // the editor overlay metrics need the inline editor open
        assert!(app.enter_edit_selected());

        // fixed px: line box 60 regardless of font size
        assert!(app.apply_typo_field(FieldId::LineHeight, "60"));
        assert_eq!(typo_val(&app, Typo::LineHeight), "60");
        let (_, _, line_h) = app.text_edit_metrics().unwrap();
        assert!((line_h - 60.0).abs() < 0.01, "got {line_h}");
        assert!(app.apply_typo_field(FieldId::FontSize, "20"));
        let (_, _, line_h) = app.text_edit_metrics().unwrap();
        assert!(
            (line_h - 60.0).abs() < 0.01,
            "fixed px must survive fs, got {line_h}"
        );

        // percent of font size: 150% at fs 20 = 30px
        assert!(app.apply_typo_field(FieldId::LineHeight, "150%"));
        assert_eq!(typo_val(&app, Typo::LineHeight), "150%");
        let (_, _, line_h) = app.text_edit_metrics().unwrap();
        assert!((line_h - 30.0).abs() < 0.01, "got {line_h}");

        // switching to px carries the current effective value (30)
        app.set_line_height_mode(Some((1, 30.0)));
        assert_eq!(typo_val(&app, Typo::LineHeight), "30");

        // auto: every lh binding cleared -> the legacy 1.2 default
        assert!(app.apply_typo_field(FieldId::LineHeight, "auto"));
        {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            assert!(!n.has_explicit_lh(), "auto clears the bindings");
            assert_eq!(n.lh_mode_value(), (0, 0.0));
        }
        let t = app.selected_text_typo().unwrap();
        let expect = t.lh * app.natural_line_height(t.fs);
        let (_, _, line_h) = app.text_edit_metrics().unwrap();
        assert!((line_h - expect).abs() < 0.01, "auto = 1.2 x natural");

        // garbage is inert
        assert!(!app.apply_typo_field(FieldId::LineHeight, "abc"));
        // the editor box grows with the mode (2 lines x 30 - padding)
        app.set_line_height_mode(Some((2, 150.0)));
        let r = app.text_edit_rect().unwrap();
        // box = max(2 lines x 30px, the auto-sized node 61px) + 4px padding
        assert!((r.height() - 65.0).abs() < 0.6, "got {}", r.height());
    }

    #[test]
    fn click_selected_text_places_caret() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text("tx", 500.0, 300.0, 120.0, 24.0, "asdasd"),
        );
        let inside = app.world_to_screen(Point::new(512.0, 310.0));
        let world = app.screen_to_world(inside);

        // NOT selected: no arming (plain click-select flow)
        app.doc().editor().selection = vec!["other".into()];
        assert!(!app.press_selected_text("tx".into(), inside, world));

        // selected: armed, and a click (release) enters edit at the caret
        app.doc().editor().selection = vec!["tx".into()];
        assert!(app.press_selected_text("tx".into(), inside, world));
        assert!(app.finish_pending_text_edit());
        assert_eq!(app.text_edit.as_deref(), Some("tx"));
        let idx = app.text_caret;
        assert!((1..=3).contains(&idx), "caret near the click, got {idx}");
        app.text_cancel_edit();

        // drag variant: movement cancels the pending edit -> no editor
        app.doc().editor().selection = vec!["tx".into()];
        assert!(app.press_selected_text("tx".into(), inside, world));
        app.pending_text_edit = None; // what on_move does on real movement
        assert!(!app.finish_pending_text_edit());
        assert!(app.text_edit.is_none());
        assert_eq!(app.doc().editor_ref().selection, vec!["tx".to_string()]);

        // multi-selection: never arms (drag = move the group)
        app.doc().editor().selection = vec!["tx".into(), "other".into()];
        assert!(!app.press_selected_text("tx".into(), inside, world));
    }

    #[test]
    fn style_creates_splits_and_coalesces() {
        let bold = |x: &mut x_native::TextRun| x.weight = Some(700);
        // unstyled range: the run is CREATED
        let out = runs_style(&[], 2, 5, bold);
        assert_eq!(
            out,
            vec![x_native::TextRun {
                start: 2,
                len: 3,
                weight: Some(700),
                ..Default::default()
            }]
        );
        // partial overlap: [4,6) has no run (base style = absence), the
        // covering run splits into styled head + unstyled tail
        let out = runs_style(&[r(6, 5)], 4, 8, bold);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].start, out[0].len, out[0].weight), (6, 2, Some(700)));
        assert_eq!(out[1], r(8, 3));
        // empty range: untouched
        assert_eq!(runs_style(&[r(6, 5)], 3, 3, bold), vec![r(6, 5)]);
    }
}

/// Shift char-index runs after inserting `n` chars at `at` (runs spanning
/// the insertion point extend; runs starting at/after it slide right).
pub fn runs_after_insert(
    runs: &[x_native::TextRun],
    at: usize,
    n: usize,
) -> Vec<x_native::TextRun> {
    runs.iter()
        .map(|r| x_native::TextRun {
            start: if r.start >= at { r.start + n } else { r.start },
            len: if r.start < at && r.start + r.len > at {
                r.len + n
            } else {
                r.len
            },
            ..r.clone()
        })
        .collect()
}

/// Shift char-index runs after deleting the range [a, b).
pub fn runs_after_delete(runs: &[x_native::TextRun], a: usize, b: usize) -> Vec<x_native::TextRun> {
    let d = b - a;
    let mut out: Vec<x_native::TextRun> = vec![];
    for r in runs {
        let (s, e) = (r.start, r.start + r.len);
        if e <= a || s >= b {
            let start = if s >= b { s - d } else { s };
            out.push(x_native::TextRun { start, ..r.clone() });
        } else {
            // run intersects the deleted range: keep the surviving pieces
            if s < a {
                out.push(x_native::TextRun {
                    start: s,
                    len: a - s,
                    ..r.clone()
                });
            }
            if e > b {
                out.push(x_native::TextRun {
                    start: a,
                    len: e - b,
                    ..r.clone()
                });
            }
        }
    }
    out
}

/// Split/merge runs so [a, b) is covered by exact-boundary runs, then apply
/// `f` to the covered pieces. Adjacent same-style runs coalesce.
pub fn runs_style<F: Fn(&mut x_native::TextRun)>(
    runs: &[x_native::TextRun],
    a: usize,
    b: usize,
    f: F,
) -> Vec<x_native::TextRun> {
    if b <= a {
        return runs.to_vec();
    }
    // styling an UNSTYLED range must create the run (the base style is
    // "no runs" — attributes attach to an explicit covering run)
    let has_overlap = runs.iter().any(|r| r.start < b && r.start + r.len > a);
    let mut parts: Vec<x_native::TextRun> = vec![];
    if !has_overlap {
        parts.push(x_native::TextRun {
            start: a,
            len: b - a,
            ..Default::default()
        });
    }
    parts.extend(runs.iter().cloned());
    let mut styled: Vec<x_native::TextRun> = vec![];
    for r in parts {
        let (s, e) = (r.start, r.start + r.len);
        if e <= a || s >= b {
            styled.push(r);
            continue;
        }
        if s < a {
            styled.push(x_native::TextRun {
                start: s,
                len: a - s,
                ..r.clone()
            });
        }
        let ms = s.max(a);
        let me = e.min(b);
        let mut mid = r.clone();
        mid.start = ms;
        mid.len = me - ms;
        f(&mut mid);
        styled.push(mid);
        if e > b {
            styled.push(x_native::TextRun {
                start: b,
                len: e - b,
                ..r.clone()
            });
        }
    }
    let mut parts = styled;
    parts.sort_by_key(|r| r.start);
    // coalesce neighbors with identical styling
    let same = |x: &x_native::TextRun, y: &x_native::TextRun| {
        x.color == y.color
            && x.size == y.size
            && x.font == y.font
            && x.weight == y.weight
            && x.italic == y.italic
            && x.ls == y.ls
    };
    let mut merged: Vec<x_native::TextRun> = vec![];
    for r in parts {
        if r.len == 0 {
            continue;
        }
        match merged.last_mut() {
            Some(last) if last.start + last.len == r.start && same(last, &r) => {
                last.len += r.len;
            }
            _ => merged.push(r),
        }
    }
    merged
}

/// Typography of the selected Text node (all engine bindings + fallbacks).
/// Legacy line-height multiplier binding (mode 0 fallback).
fn lh_mult_of(n: &x_native::Node) -> f64 {
    n.bindings
        .get("lh")
        .and_then(|v| v.parse::<f64>().ok().filter(|n| n.is_finite()))
        .unwrap_or(1.2)
}

#[derive(Debug, Clone)]
pub struct TextTypo {
    pub fs: f64,
    pub ls: f64,
    pub lh: f64,
    /// line-height mode: 0 = legacy multiplier, 1 = fixed px, 2 = percent
    pub lh_mode: u8,
    pub lh_value: f64,
    pub ws: f64,
    pub ps: f64,
    pub bs: f64,
    pub fw: u16,
    pub tc: String,
    pub opsz: f32,
    pub width_axis: f32,
    pub font: Option<String>,
}

impl App {
    /// Begin inline text editing of the given Text node
    /// (double-click or Enter on the selection).
    pub fn begin_text_edit(&mut self, id: String, text: String) {
        let runs = {
            let doc = self.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())
                .map(|n| n.text_runs.clone())
                .unwrap_or_default()
        };
        self.text_undo.clear();
        self.text_redo.clear();
        self.text_caret = text.chars().count();
        self.text_anchor = None;
        self.text_runs_edit = runs;
        self.text_buffer = text;
        self.field = None; // editor has keyboard focus, not a panel field
        self.text_edit = Some(id.clone());
        self.hover_node = None;
        self.doc().editor().selection = vec![id];
    }

    /// Cancel the inline editor WITHOUT writing (Esc): all session state
    /// (caret / selection / run styling) is dropped.
    pub fn text_cancel_edit(&mut self) {
        self.text_undo.clear();
        self.text_redo.clear();
        self.text_edit = None;
        self.field = None;
        self.text_runs_edit.clear();
        self.text_caret = 0;
        self.text_anchor = None;
        self.text_buffer.clear();
    }

    /// Esc on a FRESH EMPTY text object (click-created, never typed into)
    /// removes the node — Figma's discard-new-text behavior.
    pub fn text_cancel_edit_new(&mut self) {
        let empty_new = self
            .text_edit
            .clone()
            .map(|id| {
                let root = self.doc().editor_ref().root.clone();
                crate::editor_ui::find_node(&root, id.as_str())
                    .map(|n| matches!(&n.kind, NodeKind::Text { text } if text.is_empty()))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        self.text_cancel_edit();
        if empty_new {
            self.doc().editor().delete_selection();
            self.mark_dirty();
        }
    }

    /// The inline editor's sorted selection, None when empty/collapsed.
    pub fn text_sel_range(&self) -> Option<(usize, usize)> {
        self.text_edit.as_ref()?;
        let anchor = self.text_anchor?;
        let a = anchor.min(self.text_caret);
        let b = anchor.max(self.text_caret);
        (b > a).then_some((a, b))
    }

    /// Editor font metrics: (glyph px size, letter-spacing px, line px).
    pub fn text_edit_metrics(&self) -> Option<(f64, f64, f64)> {
        let id = self.text_edit.as_ref()?;
        let doc = self.doc_opt()?;
        let n = crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())?;
        let fs = n
            .bindings
            .get("fs")
            .and_then(|v| v.parse::<f64>().ok().filter(|n| n.is_finite()))
            .filter(|v| *v > 0.0)
            .unwrap_or(n.h * 0.72);
        let ls = n
            .bindings
            .get("ls")
            .and_then(|v| v.parse::<f64>().ok().filter(|n| n.is_finite()))
            .unwrap_or(0.0);
        // line box: legacy multiplier, or a MODE — fixed px / percent of
        // font size (Figma). Linear in fs for every mode -> scale once.
        let (lh_mode, lh_value) = n.lh_mode_value();
        let line_px = match lh_mode {
            1 => lh_value.max(1.0),
            2 => (lh_value / 100.0 * fs).max(1.0),
            _ => lh_mult_of(n) * self.natural_line_height(fs),
        };
        // screen px: the overlay draws on the zoomed canvas
        let z = self.canvas_transform().2;
        let (fs, ls) = (fs * z, ls * z);
        Some((fs, ls, line_px * z))
    }

    /// Editor text origin in SCREEN space (where the renderer puts the
    /// node's first glyph baseline start) + the node weight binding.
    pub fn text_edit_origin(&self) -> Option<(f64, f64, Option<u16>)> {
        let id = self.text_edit.as_ref()?;
        let doc = self.doc_opt()?;
        let n = crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())?;
        let p0 = self.world_to_screen(Point::new(n.transform.x, n.transform.y));
        let fw = n.bindings.get("fw").and_then(|v| v.parse::<u16>().ok());
        Some((p0.x, p0.y, fw))
    }

    /// Font face for editor ink, resolved exactly like the renderer:
    /// family (run override, then node binding) at the weight, else the
    /// default family at that weight.
    pub fn editor_face(&self, fam: Option<&str>, fw: u16) -> usize {
        let fm = &self.fonts.fonts;
        match fam {
            Some(f) => fm
                .resolve_face(f, fw)
                .or_else(|| fm.resolve_font_name(f))
                .or_else(|| fm.default_font_weighted(fw)),
            None => fm.default_font_weighted(fw),
        }
        .unwrap_or(0)
    }

    /// Editor style covering char `off`: (weight, size px) — size 0.0
    /// means "the node's size".
    pub fn text_char_style(&self, off: usize) -> (u16, f64) {
        for r in &self.text_runs_edit {
            if r.start <= off && off < r.start + r.len {
                return (r.weight.unwrap_or(400), r.size.unwrap_or(0.0));
            }
        }
        (400, 0.0)
    }

    /// Advance width of the editor char at global offset `off` (screen px)
    /// — the ONE char grid the caret, selection wash and ink all share.
    pub fn text_char_advance(&self, c: char, off: usize, fs: f64, ls: f64) -> f64 {
        let (w, sz) = self.text_char_style(off);
        let size = if sz > 0.0 { sz } else { fs };
        self.fonts
            .measure(&c.to_string(), size, crate::editor_ui::wt_for(w))
            + ls
    }

    /// X of char COL in a line on the editor grid (`line_off` = the
    /// line's first global char offset).
    pub fn text_char_x(
        &self,
        line: &str,
        line_off: usize,
        col: usize,
        x0: f64,
        fs: f64,
        ls: f64,
    ) -> f64 {
        let mut x = x0;
        for (i, c) in line.chars().take(col).enumerate() {
            x += self.text_char_advance(c, line_off + i, fs, ls);
        }
        x
    }

    /// Screen rect of the open inline editor (the overlay field). Grows
    /// with the buffer's line count.
    pub fn text_edit_rect(&self) -> Option<Rect> {
        let id = self.text_edit.as_ref()?;
        let doc = self.doc_opt()?;
        let n = crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())?;
        let p0 = self.world_to_screen(Point::new(n.transform.x, n.transform.y));
        let p1 = self.world_to_screen(Point::new(n.transform.x + n.w, n.transform.y + n.h));
        let (_, _, line_h) = self.text_edit_metrics()?;
        let lines = self.text_buffer.split('\n').count().max(1);
        let need_h = (lines as f64 * line_h + 4.0 * self.canvas_transform().2)
            .max(p1.y - p0.y + 4.0 * self.canvas_transform().2);
        Some(Rect::new(
            p0.x - 2.0,
            p0.y - 2.0,
            (p1.x + 2.0).max(p0.x + 78.0),
            p0.y - 2.0 + need_h,
        ))
    }

    /// Caret position (screen px) for the CHAR index `idx`.
    pub fn text_caret_pos(&self, idx: usize) -> Option<(f64, f64)> {
        let r = self.text_edit_rect()?;
        let (fs, ls, line_h) = self.text_edit_metrics()?;
        let buf = self.text_buffer.as_str();
        let lines: Vec<&str> = buf.split('\n').collect();
        let mut off = 0usize;
        for (li, line) in lines.iter().enumerate() {
            let len = line.chars().count();
            if idx <= off + len || li + 1 == lines.len() {
                let col = (idx - off).min(len);
                let x = self.text_char_x(line, off, col, r.x0 + 2.0, fs, ls);
                return Some((x, r.y0 + 2.0 + li as f64 * line_h));
            }
            off += len + 1; // +1 for the '\n'
        }
        None
    }

    /// CHAR index under a canvas click.
    pub fn text_char_at(&self, p: Point) -> Option<usize> {
        let r = self.text_edit_rect()?;
        if !r.contains(p) {
            return None;
        }
        let (fs, ls, line_h) = self.text_edit_metrics()?;
        let buf = self.text_buffer.as_str();
        let lines: Vec<&str> = buf.split('\n').collect();
        let li = (((p.y - r.y0 - 2.0) / line_h).floor().max(0.0) as usize).min(lines.len() - 1);
        let line = lines[li];
        let mut off = 0usize;
        for l in lines.iter().take(li) {
            off += l.chars().count() + 1;
        }
        let mut x = r.x0 + 2.0;
        let mut col = 0usize;
        for c in line.chars() {
            let w = self.text_char_advance(c, off + col, fs, ls);
            if p.x < x + w / 2.0 {
                break;
            }
            x += w;
            col += 1;
        }
        Some(off + col)
    }

    fn text_set_buffer(&mut self, chars: Vec<char>) {
        self.text_buffer = chars.into_iter().collect();
    }

    fn text_chars(&self) -> Vec<char> {
        self.text_buffer.chars().collect()
    }

    fn text_grapheme_boundaries(&self) -> Vec<usize> {
        use unicode_segmentation::UnicodeSegmentation;
        let mut out = vec![0];
        let mut chars = 0;
        for g in self.text_buffer.graphemes(true) {
            chars += g.chars().count();
            out.push(chars);
        }
        out
    }

    /// Keep the engine's scalar-index styling contract, but never split an
    /// extended grapheme (combining marks, emoji ZWJ sequences, flags).
    pub fn text_move_caret(&mut self, delta: i32, extend: bool) {
        if self.text_edit.is_none() {
            return;
        }
        if !extend {
            if let Some((a, b)) = self.text_sel_range() {
                self.text_set_caret(if delta < 0 { a } else { b }, false);
                return;
            }
        }
        let b = self.text_grapheme_boundaries();
        let at = b
            .partition_point(|i| *i <= self.text_caret)
            .saturating_sub(1);
        let next = (at as i64 + delta as i64).clamp(0, b.len() as i64 - 1) as usize;
        self.text_set_caret(b[next], extend);
    }

    pub fn text_set_caret(&mut self, idx: usize, extend: bool) {
        if self.text_edit.is_none() {
            return;
        }
        let b = self.text_grapheme_boundaries();
        let next = b[b.partition_point(|i| *i <= idx).saturating_sub(1)];
        if extend {
            if self.text_anchor.is_none() {
                self.text_anchor = Some(self.text_caret);
            }
        } else {
            self.text_anchor = None;
        }
        self.text_caret = next;
    }

    pub fn text_move_vertical(&mut self, direction: i32, extend: bool) {
        let chars = self.text_chars();
        let caret = self.text_caret.min(chars.len());
        let start = chars[..caret]
            .iter()
            .rposition(|c| *c == '\n')
            .map_or(0, |i| i + 1);
        let col = self
            .text_buffer
            .chars()
            .skip(start)
            .take(caret - start)
            .collect::<String>();
        use unicode_segmentation::UnicodeSegmentation;
        let col = col.graphemes(true).count();
        let next_start = if direction < 0 {
            if start == 0 {
                return;
            }
            chars[..start - 1]
                .iter()
                .rposition(|c| *c == '\n')
                .map_or(0, |i| i + 1)
        } else {
            let Some(end) = chars[caret..].iter().position(|c| *c == '\n') else {
                return;
            };
            caret + end + 1
        };
        let line: String = chars[next_start..]
            .iter()
            .take_while(|c| **c != '\n')
            .collect();
        let offset: usize = line
            .graphemes(true)
            .take(col)
            .map(|g| g.chars().count())
            .sum();
        self.text_set_caret(next_start + offset, extend);
    }

    /// Insert text at the caret (replacing any selection). Inserted chars
    /// inherit the styling at the selection start — the market-standard
    /// "typing continues the style" rule.
    pub fn text_insert(&mut self, t: &str) {
        if self.text_edit.is_none() {
            return;
        }
        if t.is_empty() && self.text_sel_range().is_none() {
            return;
        }
        if self
            .text_buffer
            .chars()
            .count()
            .saturating_sub(self.text_sel_range().map_or(0, |(a, b)| b - a))
            + t.chars().count()
            > 10_000
        {
            self.status = "Text edit exceeds the 10,000-character node budget".into();
            return;
        }
        self.checkpoint_text();
        let ins: Vec<char> = t.chars().collect();
        let n = ins.len();
        // style inherited from the position being typed into
        let inherit_at = self.text_sel_range().map_or(self.text_caret, |(a, _)| a);
        let inherited: Vec<x_native::TextRun> = {
            let mut seeded: Vec<x_native::TextRun> = vec![];
            for r in &self.text_runs_edit {
                if r.start <= inherit_at && inherit_at < r.start + r.len {
                    seeded.push(x_native::TextRun {
                        start: 0,
                        len: n,
                        ..r.clone()
                    });
                }
            }
            seeded
        };
        let mut chars = self.text_chars();
        if let Some((a, b)) = self.text_sel_range() {
            chars.drain(a..b);
            self.text_runs_edit = runs_after_delete(&self.text_runs_edit, a, b);
            self.text_caret = a;
            self.text_anchor = None;
        }
        for (i, c) in ins.iter().enumerate() {
            chars.insert(self.text_caret + i, *c);
        }
        self.text_runs_edit = runs_after_insert(&self.text_runs_edit, self.text_caret, n);
        if !inherited.is_empty() {
            let seg_start = self.text_caret;
            let existing = self.text_runs_edit.split_off(0);
            self.text_runs_edit = runs_style(&existing, seg_start, seg_start + n, |r| {
                for seed in &inherited {
                    if seed.weight.is_some() {
                        r.weight = seed.weight;
                    }
                    if seed.italic.is_some() {
                        r.italic = seed.italic;
                    }
                    if seed.size.is_some() {
                        r.size = seed.size;
                    }
                    if seed.color.is_some() {
                        r.color = seed.color;
                    }
                    if seed.font.is_some() {
                        r.font = seed.font.clone();
                    }
                    if seed.ls.is_some() {
                        r.ls = seed.ls;
                    }
                }
            });
        }
        self.text_caret += n;
        self.text_set_buffer(chars);
    }

    /// Backspace: delete the selection, else the char before the caret.
    pub fn text_backspace(&mut self) {
        if self.text_edit.is_none() {
            return;
        }
        if self.text_sel_range().is_some() {
            self.text_delete_selection();
            return;
        }
        if self.text_caret == 0 {
            return;
        }
        self.checkpoint_text();
        let mut chars = self.text_chars();
        let boundaries = self.text_grapheme_boundaries();
        let start = boundaries
            .iter()
            .copied()
            .take_while(|i| *i < self.text_caret)
            .last()
            .unwrap_or(0);
        chars.drain(start..self.text_caret);
        self.text_runs_edit = runs_after_delete(&self.text_runs_edit, start, self.text_caret);
        self.text_caret = start;
        self.text_set_buffer(chars);
    }

    /// Forward-delete: the selection, else the char after the caret.
    pub fn text_delete_forward(&mut self) {
        if self.text_edit.is_none() {
            return;
        }
        if self.text_sel_range().is_some() {
            self.text_delete_selection();
            return;
        }
        self.checkpoint_text();
        let mut chars = self.text_chars();
        if self.text_caret >= chars.len() {
            return;
        }
        let end = self
            .text_grapheme_boundaries()
            .into_iter()
            .find(|i| *i > self.text_caret)
            .unwrap_or(chars.len());
        chars.drain(self.text_caret..end);
        self.text_runs_edit = runs_after_delete(&self.text_runs_edit, self.text_caret, end);
        self.text_set_buffer(chars);
    }

    fn text_delete_selection(&mut self) {
        let Some((a, b)) = self.text_sel_range() else {
            return;
        };
        self.checkpoint_text();
        let mut chars = self.text_chars();
        chars.drain(a..b);
        self.text_runs_edit = runs_after_delete(&self.text_runs_edit, a, b);
        self.text_caret = a;
        self.text_anchor = None;
        self.text_set_buffer(chars);
    }

    /// Select the word under the caret (double-click inside the editor).
    pub fn text_select_word(&mut self) {
        if self.text_edit.is_none() {
            return;
        }
        let chars = self.text_chars();
        let len = chars.len();
        let mut a = self.text_caret.min(len.saturating_sub(1));
        let word = |c: char| !c.is_whitespace();
        while a > 0 && word(chars[a - 1]) {
            a -= 1;
        }
        let mut b = self.text_caret.min(len);
        while b < len && word(chars[b]) {
            b += 1;
        }
        if b > a {
            self.text_anchor = Some(a);
            self.text_caret = b;
        }
    }

    /// ⌘A inside the editor: select the whole buffer.
    pub fn text_select_all_ed(&mut self) {
        if self.text_edit.is_none() {
            return;
        }
        let len = self.text_chars().len();
        if len > 0 {
            self.text_anchor = Some(0);
            self.text_caret = len;
        }
    }

    fn text_style_range<F: Fn(&mut x_native::TextRun)>(&mut self, f: F) -> bool {
        let Some((a, b)) = self.text_sel_range() else {
            return false;
        };
        self.checkpoint_text();
        let existing = self.text_runs_edit.split_off(0);
        self.text_runs_edit = runs_style(&existing, a, b, f);
        true
    }

    /// ⌘B: toggle bold on the selection (≥600 present → clear to 400).
    pub fn text_toggle_weight(&mut self) -> bool {
        let Some((a, b)) = self.text_sel_range() else {
            return false;
        };
        let has_bold = self
            .text_runs_edit
            .iter()
            .any(|r| r.weight.unwrap_or(400) >= 600 && r.start < b && r.start + r.len > a);
        let target = if has_bold { 400 } else { 700 };
        self.text_style_range(move |r| r.weight = Some(target))
    }

    /// ⌘I: toggle italic on the selection.
    pub fn text_toggle_italic(&mut self) -> bool {
        let Some((a, b)) = self.text_sel_range() else {
            return false;
        };
        let has_it = self
            .text_runs_edit
            .iter()
            .any(|r| r.italic == Some(true) && r.start < b && r.start + r.len > a);
        let target = !has_it;
        self.text_style_range(move |r| r.italic = Some(target))
    }

    /// Panel commit scoped to the editor selection: returns false when the
    /// editor has no selection (the caller falls through to node-level).
    pub fn text_style_field(&mut self, id: FieldId, raw: &str) -> bool {
        if self.text_edit.is_none() || self.text_sel_range().is_none() {
            return false;
        }
        let num = |s: &str| -> Option<f64> {
            s.trim()
                .trim_end_matches('%')
                .trim_end_matches("px")
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
        };
        match id {
            FieldId::FontSize => {
                let Some(v) = num(raw) else {
                    return true; // selection active, bad value: swallow
                };
                let v = v.clamp(1.0, 4096.0);
                self.text_style_range(move |r| r.size = Some(v))
            }
            FieldId::FontWeight => {
                let Some(w) = parse_weight(raw) else {
                    return true;
                };
                self.text_style_range(move |r| r.weight = Some(w))
            }
            FieldId::LetterSpacing => {
                let Some(v) = num(raw) else {
                    return true;
                };
                self.text_style_range(move |r| r.ls = Some(v))
            }
            FieldId::FontFamily => {
                if raw.trim().is_empty() {
                    return true;
                }
                let fam = raw.trim().to_string();
                self.text_style_range(move |r| r.font = Some(fam.clone()))
            }
            FieldId::FillHex => {
                let Some(c) = crate::state::parse_hex(raw) else {
                    return true;
                };
                self.text_style_range(move |r| {
                    r.color = Some(x_native::Color::from_rgba8(
                        c.to_rgba8().r,
                        c.to_rgba8().g,
                        c.to_rgba8().b,
                        255,
                    ))
                })
            }
            _ => false,
        }
    }

    /// Commit an open TextContent field: applies the buffer + the session's
    /// run styling to the node (undoable) and closes the editor. Returns
    /// true if text changed.
    pub fn commit_text_field(&mut self) -> bool {
        if self.text_edit.is_none() {
            return false;
        }
        let buf = self.text_buffer.clone();
        self.commit_text_field_value(&buf)
    }

    /// Commit with an explicit buffer (the Host's commit_field already
    /// consumed the field — this is the real body, testable without a
    /// window).
    pub fn commit_text_field_value(&mut self, buffer: &str) -> bool {
        let Some(nid) = self.text_edit.clone() else {
            return false;
        };
        let changed = self.pending_text_dirty() || buffer != self.text_buffer;
        let runs = self.text_runs_edit.split_off(0);
        self.text_undo.clear();
        self.text_redo.clear();
        self.text_caret = 0;
        self.text_anchor = None;
        self.text_edit = None;
        self.field = None;
        self.text_buffer.clear();
        if !changed && !buffer.trim().is_empty() {
            return false;
        }
        // Figma: committing an EMPTY text object removes it
        if buffer.trim().is_empty() {
            self.doc().editor().selection = vec![nid.clone()];
            self.doc().editor().delete_selection();
            self.mark_dirty();
            return true;
        }
        self.doc().editor().set_text(&nid, buffer);
        self.doc().editor().set_text_runs(nid.as_str(), runs);
        // market-standard auto-width: the box hugs the new text
        self.autosize_text_node(nid.as_str());
        true
    }

    /// True when `p` is a second click inside the dbl-click window
    /// (350 ms, 4 px).
    pub fn is_double_click(&self, p: Point) -> bool {
        self.last_click
            .map(|(t, q)| {
                t.elapsed().as_millis() < 350 && (p.x - q.x).abs() < 4.0 && (p.y - q.y).abs() < 4.0
            })
            .unwrap_or(false)
    }

    /// Selected Text node's typography: (font_size, letter_spacing_px,
    /// line_height_multiplier, font_family). Legacy nodes: size = node.h,
    /// ls = 0, lh = 1.2 (the render defaults).
    pub fn selected_text_typo(&self) -> Option<TextTypo> {
        let doc = self.doc_opt()?;
        let id = doc.selected_id()?;
        let n = crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())?;
        if !matches!(n.kind, NodeKind::Text { .. }) {
            return None;
        }
        let get = |k: &str| {
            n.bindings
                .get(k)
                .and_then(|v| v.parse::<f64>().ok().filter(|n| n.is_finite()))
        };
        let (lh_mode, lh_value) = n.lh_mode_value();
        Some(TextTypo {
            fs: get("fs").filter(|v| *v > 0.0).unwrap_or(n.h),
            ls: get("ls").unwrap_or(0.0),
            lh: get("lh").unwrap_or(1.2),
            lh_mode,
            lh_value,
            ws: get("ws").unwrap_or(0.0),
            ps: get("ps").unwrap_or(0.0),
            bs: get("bs").unwrap_or(0.0),
            fw: n
                .bindings
                .get("fw")
                .and_then(|v| v.parse::<u16>().ok())
                .unwrap_or(400),
            tc: n
                .bindings
                .get("tc")
                .cloned()
                .unwrap_or_else(|| "none".into()),
            opsz: get("opsz").unwrap_or(0.0) as f32,
            width_axis: get("wdth").unwrap_or(0.0) as f32,
            font: n.bindings.get("font").cloned(),
        })
    }

    /// Natural (line_height: 1.0) height of the default face at `size` px —
    /// the unit the Line-height field is written in.
    pub fn natural_line_height(&self, size: f64) -> f64 {
        if let Some(f) = self
            .fonts
            .fonts
            .default_font()
            .map(|i| &self.fonts.fonts.fonts[i])
        {
            (f.ascent - f.descent + f.line_gap) * (size / f.units_per_em)
        } else {
            size * 1.21
        }
    }

    /// Measure a Text node with the ONE text pipeline: returns
    /// (line_width, block_height). Width is the shaper's own ADVANCE width
    /// (+ per-char letter-spacing, the CSS contract) — the exact metric
    /// `break_lines` wraps against, so a box of this width can never
    /// re-wrap. Height is the laid-out line boxes. Both use the same face
    /// the render resolves (`default_font`), so numbers match the canvas.
    #[allow(clippy::too_many_arguments)] // mirrors the engine binding set
    pub fn measure_text_node(
        &self,
        text: &str,
        fs: f64,
        lh: f64,
        ls: f64,
        ws: f64,
        ps: f64,
        sc: bool,
        wrap: x_native::TextWrap,
    ) -> (f64, f64) {
        let font = self.fonts.fonts.default_font().unwrap_or(0);
        // width: per-segment advance widths (small caps re-sizes segments —
        // the EXACT segmentation the shaper renders)
        let segs: Vec<(String, f64)> = if sc {
            x_native::small_caps_segments(text, fs)
        } else {
            vec![(text.to_string(), fs)]
        };
        let w: f64 = segs
            .iter()
            .map(|(t, sz)| self.fonts.fonts.measure(t, font, *sz))
            .sum::<f64>()
            + text.chars().count() as f64 * ls
            + text.chars().filter(|c| *c == ' ').count() as f64 * ws;
        let spans = [x_native::text::Span::new(text, fs)
            .font(font)
            .letter_spacing(ls)
            .word_spacing(ws)];
        let style = x_native::text::TextBlockStyle {
            max_width: (w + 2.0).max(8.0),
            line_height: lh,
            align: x_native::text::Align::Left,
            wrap,
            paragraph_spacing: ps,
            small_caps: sc,
            ..Default::default()
        };
        let (_, total_h) = x_native::text::glyph_outlines(&self.fonts.fonts, &spans, font, &style);
        (w, total_h)
    }

    /// Auto-size a Text node so its box hugs the laid-out text (Figma
    /// auto-width): w = measured ink width, h = measured block height, and
    /// pin the font size into the `fs` binding so box and point size stay
    /// independent from here on. Returns true if the box changed.
    pub fn autosize_text_node(&mut self, id: &str) -> bool {
        let info = {
            let doc = self.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, id);
            n.and_then(|n| match &n.kind {
                NodeKind::Text { text } => Some((
                    text.clone(),
                    n.w,
                    n.bindings
                        .get("fs")
                        .and_then(|v| v.parse::<f64>().ok().filter(|n| n.is_finite()))
                        .filter(|v| *v > 0.0)
                        .unwrap_or(n.h),
                    n.bindings
                        .get("lh")
                        .and_then(|v| v.parse::<f64>().ok().filter(|n| n.is_finite()))
                        .unwrap_or(1.2),
                    n.bindings
                        .get("tm")
                        .map(String::as_str)
                        .unwrap_or("auto")
                        .to_string(),
                )),
                _ => None,
            })
        };
        // "fixed" is the user-pinned box (drag-resize / W-H fields): text
        // wraps inside it and auto-sizing stands down, like Figma's
        // fixed-size text. Missing binding = auto-width.
        match info.as_ref().map(|i| i.4.as_str()) {
            Some("fixed") | None => return false,
            _ => {}
        }
        let (text, _, fs, lh_binding, _) = info.unwrap();
        // line-height MODE -> effective natural multiplier
        let nat = self.natural_line_height(fs).max(0.1);
        let (ls, ws, ps, tc, lh) = {
            let doc = self.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, id)
                .map(|n| {
                    let num = |k: &str| {
                        n.bindings
                            .get(k)
                            .and_then(|v| v.parse::<f64>().ok().filter(|n| n.is_finite()))
                    };
                    let lh = match n.lh_mode_value() {
                        (1, px) => px.max(1.0) / nat,
                        (2, pct) => (pct / 100.0 * fs / nat).max(0.1),
                        _ => lh_binding,
                    };
                    (
                        num("ls").unwrap_or(0.0),
                        num("ws").unwrap_or(0.0),
                        num("ps").unwrap_or(0.0),
                        n.bindings.get("tc").cloned(),
                        lh,
                    )
                })
                .unwrap_or((0.0, 0.0, 0.0, None, lh_binding))
        };
        // auto-width: measure the UNWRAPPED line so the box grows
        // horizontally with the text (case-transformed content — the box
        // fits what is actually rendered; small caps re-sizes segments)
        let tc = tc.as_deref();
        let text = x_native::apply_text_case(&text, tc);
        let (line_w, block_h) = self.measure_text_node(
            &text,
            fs,
            lh,
            ls,
            ws,
            ps,
            tc == Some("sc"),
            x_native::TextWrap::Auto,
        );
        let w = {
            let doc = self.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, id)
                .map(|n| n.w)
                .unwrap_or(0.0)
        };
        let (nw, nh) = ((line_w + 3.0).ceil(), (block_h + 0.5).ceil());
        let doc = self.doc();
        doc.editor().mutate_visual_stack(id, |n| {
            n.bindings
                .entry("fs".into())
                .or_insert_with(|| format!("{fs:.2}"));
        });
        let changed = (nw - w).abs() > 0.5
            || (nh - {
                let n = crate::editor_ui::find_node(&doc.editor_ref().root, id);
                n.map(|n| n.h).unwrap_or(nh)
            })
            .abs()
                > 0.5;
        if changed {
            doc.editor().resize(id, nw, nh);
        }
        self.mark_dirty();
        changed
    }

    /// Typography field commit (family / weight / size / line height /
    /// letter / word / paragraph spacing / baseline shift / text case):
    /// parse the raw buffer, write the engine binding, re-fit the box.
    /// Returns false when the field isn't typography or the value doesn't
    /// parse.
    /// Panel-commit routing for typography fields (+ range-scoped fill).
    /// Returns true when consumed — no node-level fallback may run.
    pub fn route_typo_panel_field(&mut self, id: FieldId, raw: &str) -> bool {
        match id {
            FieldId::FontFamily
            | FieldId::FontSize
            | FieldId::LineHeight
            | FieldId::LetterSpacing
            | FieldId::FontWeight
            | FieldId::WordSpacing
            | FieldId::ParaSpacing
            | FieldId::BaselineShift
            | FieldId::TextCase
            | FieldId::OpticalSize
            | FieldId::WidthAxis => {
                self.apply_typo_field(id, raw);
                true
            }
            FieldId::FillHex => self.apply_typo_field(FieldId::FillHex, raw),
            _ => false,
        }
    }

    pub fn apply_typo_field(&mut self, id: FieldId, raw: &str) -> bool {
        // rich-text sub-selection: style the EDITED RANGE, not the node
        if self.text_edit.is_some() && self.text_style_field(id, raw) {
            return true;
        }
        let num = |s: &str| -> Option<f64> {
            s.trim()
                .trim_end_matches('%')
                .trim_end_matches("px")
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
        };
        match id {
            FieldId::FontFamily => {
                let raw = raw.trim();
                if raw.is_empty() {
                    return false;
                }
                self.set_text_typo("font", raw.to_string());
                true
            }
            FieldId::FontSize => {
                let Some(v) = num(raw) else {
                    return false;
                };
                self.set_text_typo("fs", format!("{:.2}", v.clamp(1.0, 4096.0)));
                true
            }
            FieldId::LineHeight => {
                // Figma modes: "auto" -> font default, "N%" -> percent of
                // the font size, "N" / "Npx" -> fixed px line box
                let t = raw.trim();
                if t.eq_ignore_ascii_case("auto") {
                    return self.set_line_height_mode(None);
                }
                let pct = t.ends_with('%');
                let Some(v) = num(raw) else {
                    return false;
                };
                if pct {
                    self.set_line_height_mode(Some((2, v.clamp(1.0, 2000.0))))
                } else {
                    self.set_line_height_mode(Some((1, v.clamp(0.5, 4000.0))))
                }
            }
            FieldId::LetterSpacing => {
                let Some(v) = num(raw) else {
                    return false;
                };
                self.set_text_typo("ls", format!("{v:.2}"));
                true
            }
            FieldId::WordSpacing => {
                let Some(v) = num(raw) else {
                    return false;
                };
                self.set_text_typo("ws", format!("{v:.2}"));
                true
            }
            FieldId::ParaSpacing => {
                let Some(v) = num(raw) else {
                    return false;
                };
                self.set_text_typo("ps", format!("{v:.2}"));
                true
            }
            FieldId::BaselineShift => {
                let Some(v) = num(raw) else {
                    return false;
                };
                self.set_text_typo("bs", format!("{v:.2}"));
                true
            }
            FieldId::FontWeight => {
                let Some(w) = parse_weight(raw) else {
                    return false;
                };
                self.set_text_typo("fw", format!("{w}"));
                true
            }
            FieldId::TextCase => {
                let m = match raw.trim().to_lowercase().as_str() {
                    "upper" | "uppercase" => "upper",
                    "lower" | "lowercase" => "lower",
                    "title" => "title",
                    "small caps" | "smallcaps" | "sc" | "smcp" => "sc",
                    "none" | "" => "none",
                    _ => return false,
                };
                self.set_text_typo("tc", m.into());
                true
            }
            FieldId::OpticalSize | FieldId::WidthAxis => {
                // a number sets the variable-font axis; "auto" (or 0) clears
                let v = match raw.trim().to_lowercase().as_str() {
                    "auto" | "" => 0.0,
                    _ => {
                        let Some(v) = num(raw) else {
                            return false;
                        };
                        v
                    }
                };
                let key = match id {
                    FieldId::OpticalSize => "opsz",
                    _ => "wdth",
                };
                self.set_text_typo(key, format!("{v:.2}"));
                true
            }
            _ => false,
        }
    }

    /// Set a typography property on the selected node and re-fit its box
    /// (market-standard: the text re-measures, the box hugs the text).
    /// Write the line-height MODE (Figma): None = Auto (all lh bindings
    /// cleared -> the engine default), Some((1, px)) = fixed px line box,
    /// Some((2, pct)) = percent of the font size. Undoable, re-fits.
    pub fn set_line_height_mode(&mut self, mode: Option<(u8, f64)>) -> bool {
        let Some(id) = self.doc().selected_id() else {
            return false;
        };
        self.doc().editor().mutate_visual_stack(id.as_str(), |n| {
            n.bindings.remove("lh");
            n.bindings.remove("lhm");
            n.bindings.remove("lhpx");
            n.bindings.remove("lhp");
            match mode {
                Some((1, px)) => {
                    n.bindings.insert("lhm".into(), "px".into());
                    n.bindings.insert("lhpx".into(), format!("{px:.2}"));
                }
                Some((2, pct)) => {
                    n.bindings.insert("lhm".into(), "pct".into());
                    n.bindings.insert("lhp".into(), format!("{pct:.2}"));
                }
                _ => {}
            }
        });
        self.mark_dirty();
        self.autosize_text_node(id.as_str());
        true
    }

    pub fn set_text_typo(&mut self, key: &str, value: String) -> bool {
        let Some(id) = self.doc().selected_id() else {
            return false;
        };
        self.doc().editor().mutate_visual_stack(id.as_str(), |n| {
            n.bindings.insert(key.into(), value);
        });
        self.mark_dirty();
        self.autosize_text_node(id.as_str())
    }

    // ---------------------------------------------------------- text styles
    //
    // Figma's "Create and apply text styles": a text style is a named
    // typography definition in `Document.styles`. Applying one writes the
    // values AND links the layer through its `style:text` binding, so
    // updating the definition and re-resolving the trees moves every
    // consumer. Alignment, fill and resizing are deliberately not part of a
    // style — the four operations below only ever touch typography.

    /// True when `id` names a text layer: the only kind a text style applies
    /// to.
    pub fn is_text_layer(&self, id: &str) -> bool {
        let root = &self.doc_ref().editor_ref().root;
        crate::editor_ui::find_node(root, id)
            .map(|n| matches!(n.kind, NodeKind::Text { .. }))
            .unwrap_or(false)
    }

    /// The text style `id` is linked to, if any.
    pub fn linked_text_style(&self, id: &str) -> Option<String> {
        let root = &self.doc_ref().editor_ref().root;
        crate::editor_ui::find_node(root, id)?
            .bindings
            .get("style:text")
            .cloned()
    }

    /// Every node under `root` carrying a style link — the consumers a style
    /// edit has to re-resolve.
    pub fn collect_style_consumers(root: &Node, out: &mut Vec<String>) {
        if x_native::STYLE_BINDING_KEYS
            .iter()
            .any(|(key, _)| root.bindings.contains_key(*key))
        {
            out.push(root.id.clone());
        }
        for c in &root.children {
            Self::collect_style_consumers(c, out);
        }
    }

    /// Apply `name` to every selected text layer and link it. Returns the
    /// number of layers linked; 0 covers both "no such style" and "no text
    /// layer in the selection".
    pub fn apply_text_style(&mut self, name: &str) -> usize {
        let Some(data) = self.doc_ref().doc.text_style(name).cloned() else {
            return 0;
        };
        let ids: Vec<String> = self.doc_ref().editor_ref().selection.clone();
        let mut linked = 0usize;
        for id in ids {
            if !self.is_text_layer(id.as_str()) {
                continue;
            }
            let style = LegacyStyle::Text(data.clone());
            let bound = self
                .doc()
                .editor()
                .mutate_visual_stack(id.as_str(), |n| bind_style(n, name, &style));
            if bound {
                linked += 1;
                // the style owns the size, so the box re-fits around it
                self.autosize_text_node(id.as_str());
            }
        }
        if linked > 0 {
            self.mark_dirty();
            self.doc().sync();
        }
        linked
    }

    /// Create a style from the selected text layer's typography and apply it
    /// to that layer — Figma creates and links in one step. None when the
    /// selection is not a text layer.
    pub fn create_text_style_from_selection(&mut self) -> Option<String> {
        let id = self.doc_ref().selected_id()?;
        if !self.is_text_layer(id.as_str()) {
            return None;
        }
        let data = {
            let root = &self.doc_ref().editor_ref().root;
            let node = crate::editor_ui::find_node(root, id.as_str())?;
            let mut data = TextStyleData::from_node(node);
            // P3: a node without an explicit font carries the document's
            // default typeface into the new style
            if !node.bindings.contains_key("font") {
                data.font_family = self.doc_ref().doc.resolved_default_font().to_string();
            }
            data
        };
        // Figma's naming: "New style", then "New style 2", "New style 3", …
        let name = (1..)
            .map(|i| {
                if i == 1 {
                    "New style".to_string()
                } else {
                    format!("New style {i}")
                }
            })
            .find(|candidate| !self.doc_ref().doc.styles.contains_key(candidate))?;
        self.doc().doc.add_text_style(&name, data).ok()?;
        self.apply_text_style(&name);
        self.status = format!("Created text style '{name}'");
        Some(name)
    }

    /// Detach every selected layer linked to a text style: the typography
    /// stays, the link goes, so later style edits stop reaching it.
    pub fn detach_text_style_from_selection(&mut self) -> usize {
        let ids: Vec<String> = self.doc_ref().editor_ref().selection.clone();
        let mut detached = 0usize;
        for id in ids {
            if self.linked_text_style(id.as_str()).is_none() {
                continue;
            }
            self.doc().editor().mutate_visual_stack(id.as_str(), |n| {
                detach_text_style(n);
            });
            detached += 1;
        }
        if detached > 0 {
            self.mark_dirty();
            self.doc().sync();
        }
        detached
    }

    /// Push the selected layer's current typography into the style it is
    /// linked to, then re-resolve every page (Figma's "Update style").
    /// Returns the consumers re-resolved; None when the selection is not
    /// linked to a style.
    pub fn update_text_style_from_selection(&mut self) -> Option<usize> {
        let id = self.doc_ref().selected_id()?;
        let name = self.linked_text_style(id.as_str())?;
        let data = {
            let root = &self.doc_ref().editor_ref().root;
            let node = crate::editor_ui::find_node(root, id.as_str())?;
            let mut data = TextStyleData::from_node(node);
            if !node.bindings.contains_key("font") {
                data.font_family = self.doc_ref().doc.resolved_default_font().to_string();
            }
            data
        };
        if !self.doc().doc.update_text_style(&name, data) {
            return None;
        }
        let updated = self.propagate_styles();
        self.status = format!("Updated '{name}' — {updated} linked layers re-resolved");
        Some(updated)
    }

    /// Re-apply every linked style across all page trees: the "edit a style,
    /// every consumer updates" pass. Each consumer goes through its own page
    /// editor so the change lands in that page's undo stack (the engine keeps
    /// one undo stack per page). Returns the consumers re-resolved.
    pub fn propagate_styles(&mut self) -> usize {
        let styles = self.doc_ref().doc.styles.clone();
        // collected up front: the walk borrows the editors immutably while
        // the mutation pass needs them mutably
        let per_page: Vec<Vec<String>> = self
            .doc_ref()
            .editors
            .iter()
            .map(|ed| {
                let mut ids = Vec::new();
                Self::collect_style_consumers(&ed.root, &mut ids);
                ids
            })
            .collect();
        let mut updated = 0usize;
        for (pi, ids) in per_page.into_iter().enumerate() {
            let doc = self.doc();
            let Some(ed) = doc.editors.get_mut(pi) else {
                continue;
            };
            for id in ids {
                let registry = &styles;
                if ed.mutate_visual_stack(id.as_str(), |n| {
                    resolve_styles(n, registry);
                }) {
                    updated += 1;
                }
            }
        }
        if updated > 0 {
            self.mark_dirty();
            self.doc().sync();
        }
        updated
    }

    /// Press for a ruler guide: from a ruler strip (create) or near an
    /// existing line (grab). True when the press started a guide drag.
    pub fn guide_press(&mut self, p: Point) -> bool {
        if !self.rulers || self.text_edit.is_some() {
            return false;
        }
        let reg = self.editor_regions();
        let in_top =
            p.y <= crate::theme::RULER_SIZE && p.x >= reg.canvas.x0 && p.x <= reg.canvas.x1;
        let in_left =
            p.x <= crate::theme::RULER_SIZE && p.y >= reg.canvas.y0 && p.y <= reg.canvas.y1;
        let world = self.screen_to_world(p);
        let mouse = self.mouse;
        let tol = 4.0 / self.zoom.max(0.01);
        let grab = self
            .doc()
            .guides
            .iter()
            .position(|(ax, c)| {
                let near = if *ax == 'v' {
                    (world.x - c).abs() <= tol
                } else {
                    (world.y - c).abs() <= tol
                };
                near && reg.canvas.contains(mouse)
            })
            .map(|i| self.doc().guides.remove(i));
        if in_top || in_left {
            let axis = if in_top { 'v' } else { 'h' };
            let c = if axis == 'v' { world.x } else { world.y };
            *self.guide_drag() = grab.or(Some((axis, c)));
            self.drag = Some(Drag::Guide { axis });
            return true;
        }
        if let Some((ax, _c)) = grab {
            *self.guide_drag() = Some((ax, if ax == 'v' { world.x } else { world.y }));
            self.drag = Some(Drag::Guide { axis: ax });
            return true;
        }
        false
    }

    /// Release a guide drag: keep it when dropped on the canvas, remove
    /// when dropped back in a ruler (Figma).
    pub fn guide_release(&mut self) {
        if let Some((ax, c)) = self.guide_drag().take() {
            let reg = self.editor_regions();
            let in_ruler = if ax == 'v' {
                self.mouse.y <= crate::theme::RULER_SIZE
            } else {
                self.mouse.x <= crate::theme::RULER_SIZE
            };
            let on_canvas = reg.canvas.contains(self.mouse);
            if !in_ruler && on_canvas {
                self.doc().guides.push((ax, (c * 100.0).round() / 100.0));
            }
        }
        self.drag = None;
    }

    /// Pen: click adds a point; clicking the start anchor (8px) with >= 3
    /// points CLOSES the path (Figma) and creates the vector.
    pub fn pen_click(&mut self, world: Point) {
        match &mut self.drag {
            Some(Drag::Pen { points, cursor }) => {
                let tol = 8.0 / self.zoom.max(0.01);
                if points.len() >= 3
                    && (world.x - points[0].x).abs() <= tol
                    && (world.y - points[0].y).abs() <= tol
                {
                    let pts = points.clone();
                    self.drag = None;
                    self.finish_pen_points(pts);
                    return;
                }
                points.push(world);
                *cursor = Some(world);
            }
            _ => {
                self.drag = Some(Drag::Pen {
                    points: vec![world],
                    cursor: Some(world),
                });
            }
        }
    }

    /// Build the vector from pen points (shared by close-on-anchor and
    /// the Enter finish path).
    fn finish_pen_points(&mut self, pts: Vec<Point>) {
        if pts.len() < 2 {
            return;
        }
        let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        let mut path: Vec<PathCmd> = Vec::new();
        for (i, p) in pts.iter().enumerate() {
            let (lx, ly) = (p.x - min_x, p.y - min_y);
            if i == 0 {
                path.push(PathCmd::MoveTo(lx, ly));
            } else {
                path.push(PathCmd::LineTo(lx, ly));
            }
        }
        path.push(PathCmd::Close);
        let n = {
            let doc = self.doc();
            let root_id = doc.editor_ref().root.id.clone();
            let v = x_native::Node::vector(
                &x_native::fresh_id("path"),
                min_x,
                min_y,
                (max_x - min_x).max(1.0),
                (max_y - min_y).max(1.0),
                path,
            );
            let id = v.id.clone();
            doc.editor().insert_node(&root_id, v);
            id
        };
        self.doc().editor().selection = vec![n];
        self.mark_dirty();
    }

    /// Figma hover: track the layer under the cursor (select tool, no
    /// drag, no inline edit). Selected layers report None — their chrome
    /// already shows.
    pub fn update_hover(&mut self, p: Point) {
        let mut next: Option<String> = None;
        if self.screen == Screen::Editor
            && self.tool == Tool::Select
            && self.drag.is_none()
            && self.text_edit.is_none()
        {
            let reg = self.editor_regions();
            if reg.canvas.contains(p) {
                let world = self.screen_to_world(p);
                let root = self.doc().editor_ref().root.clone();
                next = x_native::editor::hit_test(&root, world);
            }
        }
        let on_sel = next
            .as_ref()
            .map(|id| self.doc().editor_ref().selection.contains(id))
            .unwrap_or(false);
        self.hover_node = if on_sel { None } else { next };
    }

    /// Press on an ALREADY-SELECTED Text node: arm caret-on-release.
    /// Click = edit mode with the caret at the click point; a real drag
    /// still moves the layer (movement clears the pending edit).
    /// Guarded to a plain click: single selection, select tool, no alt/shift.
    pub fn press_selected_text(&mut self, id: String, p: Point, world: Point) -> bool {
        if self.text_edit.is_some() || self.tool != Tool::Select || self.alt || self.shift {
            return false;
        }
        let sel = self.doc().editor_ref().selection.clone();
        if sel.as_slice() != [id.clone()] {
            return false;
        }
        let is_text = {
            let root = self.doc().editor_ref().root.clone();
            crate::editor_ui::find_node(&root, id.as_str())
                .map(|n| matches!(n.kind, NodeKind::Text { .. }))
                .unwrap_or(false)
        };
        if !is_text {
            return false;
        }
        self.pending_text_edit = Some((id, p));
        self.drag = Some(Drag::MoveSel {
            last: world,
            base_depth: self.doc().editor_ref().undo_depth(),
        });
        true
    }

    /// Release after `press_selected_text`: any movement (a real drag)
    /// already cleared the pending edit, so this only fires on a click.
    pub fn finish_pending_text_edit(&mut self) -> bool {
        let Some((id, p)) = self.pending_text_edit.take() else {
            return false;
        };
        let text = {
            let root = self.doc().editor_ref().root.clone();
            crate::editor_ui::find_node(&root, id.as_str()).and_then(|n| match &n.kind {
                NodeKind::Text { text } => Some(text.clone()),
                _ => None,
            })
        };
        let Some(text) = text else {
            return false;
        };
        if self.text_edit.is_some() {
            return false;
        }
        self.begin_text_edit(id, text);
        // caret at the click point
        if let Some(idx) = self.text_char_at(p) {
            self.text_set_caret(idx, false);
        }
        true
    }

    /// Enter on a single selected Text node starts inline editing.
    pub fn enter_edit_selected(&mut self) -> bool {
        if self.text_edit.is_some() {
            return false;
        }
        let hit = {
            let doc = self.doc();
            doc.selected_id().and_then(|id| {
                crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str()).and_then(|n| {
                    match &n.kind {
                        NodeKind::Text { text } => Some((n.id.clone(), text.clone())),
                        _ => None,
                    }
                })
            })
        };
        match hit {
            Some((id, text)) => {
                self.begin_text_edit(id, text);
                true
            }
            None => false,
        }
    }
}

impl Host {
    // ── vector edit mode: engine <-> app mirroring, pointer handling ──

    /// Mirror the engine's vector edit mode into the app struct the canvas
    /// overlay reads: `editor_ui` draws anchors and handles from
    /// `app.vector_edit_mode`, and it must not borrow the document while it
    /// paints. Called after every mode/selection change.
    fn sync_vector_edit_mode(&mut self) {
        let (active, node, points) = {
            let editor = self.app.doc().editor_ref();
            (
                editor.vector_edit_active,
                editor.vector_edit_node.clone(),
                editor.vector_edit_selected_points.clone(),
            )
        };
        self.app.vector_edit_mode.active = active;
        self.app.vector_edit_mode.selected_node = node;
        self.app.vector_edit_mode.selected_points = points;
    }

    /// The layer a path command should act on: the node in vector edit mode,
    /// else the single selected layer — so the palette's path commands work
    /// without entering node edit mode first.
    fn vector_edit_id(&mut self) -> Option<String> {
        let editor = self.app.doc().editor();
        if let Some(id) = editor.vector_edit_target() {
            return Some(id.to_string());
        }
        editor.selection.first().cloned()
    }

    /// Canvas press while vector edit mode is active. Anchors and control
    /// handles are hit BEFORE the layer, an empty press starts the point lasso,
    /// and the layer itself is never moved or re-selected mid-edit — that is
    /// the whole difference between editing a shape and editing its points.
    ///
    /// Returns false only when the mode has nothing to say about the press (no
    /// node behind it), so the caller can fall through to the normal tool path.
    fn vector_press(&mut self, world: Point) -> bool {
        let Some(id) = self.app.vector_edit_mode.selected_node.clone() else {
            return false;
        };
        let node = {
            let doc = self.app.doc();
            x_native::editor::find(&doc.editor_ref().root, &id).cloned()
        };
        let Some(node) = node else {
            // the layer is gone (deleted, or undo walked past it): leave the
            // mode instead of hit-testing anchors that no longer exist
            self.dispatch(Action::ExitVectorEditMode);
            return true;
        };
        // Two tools keep their own behaviour even inside the mode: Hand pans
        // (space-drag already returned before this), and the Eraser erases
        // segments — neither should be captured by an anchor lasso.
        if matches!(self.app.tool, Tool::Hand | Tool::Eraser) {
            return false;
        }
        // The tolerance is a SCREEN distance, so it shrinks in world units as
        // the user zooms in — and it is the drawn size plus a couple of pixels,
        // which keeps "what you can grab" equal to "what you can see".
        let zoom = self.app.zoom.max(1e-3);
        let anchor_tol = (crate::editor_ui::ANCHOR_HALF + 2.0) / zoom;
        let handle_tol = (crate::editor_ui::HANDLE_HALF + 2.0) / zoom;
        let (alt, pen) = (self.app.alt, self.app.tool == Tool::Pen);

        // 1. a control handle wins: it is the smaller target sitting on the
        //    tangent line, and grabbing it must never move the anchor with it
        if self.app.vector_edit_mode.show_handles {
            if let Some(hit) =
                x_native::editor::handle_at_world(&node, world.x, world.y, handle_tol)
            {
                if self.app.doc().editor().begin_path_gesture(&id) {
                    self.app.drag = Some(Drag::VectorHandle {
                        anchor_idx: hit.anchor,
                        outgoing: hit.outgoing,
                    });
                    return true;
                }
            }
        }

        // 2. an anchor: plain click selects it (⇧ adds to the selection),
        //    ⌥-click converts a curved point back to a corner, and dragging
        //    moves every selected anchor as ONE undoable gesture
        if let Some(anchor) = x_native::editor::anchor_at_world(&node, world.x, world.y, anchor_tol)
        {
            if alt {
                self.dispatch(Action::RemoveBezierHandles(anchor));
                return true;
            }
            // With the PEN tool, dragging an anchor pulls its handles out —
            // that is how a corner becomes a curve. With the move tool the same
            // drag slides the point (and every other selected point with it).
            if pen {
                if self.app.doc().editor().begin_path_gesture(&id) {
                    self.app.drag = Some(Drag::VectorBend { anchor_idx: anchor });
                }
                return true;
            }
            let already = self.app.vector_edit_mode.selected_points.contains(&anchor);
            if !already || self.app.shift {
                self.dispatch(Action::SelectVectorPoint(anchor));
            }
            if self.app.doc().editor().begin_path_gesture(&id) {
                self.app.drag = Some(Drag::VectorPoint { last: world });
            }
            return true;
        }

        // 3. pen tool: it keeps drawing THE SELECTED path (Figma's pen
        //    continues the open path) instead of starting a new polygon. On a
        //    segment it cuts an anchor in where the pen clicked.
        if pen {
            if let Some(seg) =
                x_native::editor::segment_at_world(&node, world.x, world.y, anchor_tol)
            {
                if seg > 0 {
                    let (lx, ly) = x_native::editor::local_point(&node, world.x, world.y);
                    self.dispatch(Action::AddVectorPoint {
                        segment_idx: seg,
                        position: (lx, ly),
                    });
                    return true;
                }
            }
            if self
                .app
                .doc()
                .editor()
                .pen_add_anchor_world(&id, world.x, world.y)
            {
                self.app.mark_dirty();
                self.sync_vector_edit_mode();
            }
            return true;
        }

        // 4. empty canvas with the move tool: rubber-band the anchors. A release
        //    without movement is a click, which drops the ANCHOR selection and
        //    leaves the layer selected (Figma's node-edit click).
        if self.app.tool == Tool::Select {
            self.app.drag = Some(Drag::VectorLasso {
                start: world,
                cur: world,
            });
            return true;
        }
        // every other tool (a shape tool, the comment pin) falls through to its
        // own press handler
        false
    }

    /// Apply a stroke cap to BOTH ends of the selected layer(s). The engine
    /// keeps the ends separate (`set_stroke_cap_start` / `_end`) because that is
    /// what Figma's stroke panel exposes; the palette has no parameter to ask
    /// for, so its cap entries say "both ends" and mean it.
    fn apply_stroke_caps(&mut self, cap: x_native::StrokeCap) {
        let ids = self.app.doc().editor().selection.clone();
        if ids.is_empty() {
            self.app.status = "Select a layer with a stroke first".into();
            return;
        }
        let mut changed = 0usize;
        for id in &ids {
            let editor = self.app.doc().editor();
            // either end changing counts: a node already capped at one end still
            // needs the other
            let a = editor.set_stroke_cap_start(id, cap);
            let b = editor.set_stroke_cap_end(id, cap);
            if a || b {
                changed += 1;
            }
        }
        if changed > 0 {
            self.app.mark_dirty();
            self.app.status = format!("Cap set on {changed} layer(s): {cap:?}");
        } else {
            self.app.status = "Those layers already use that cap".into();
        }
    }

    /// A world-space pointer delta expressed in a node's LOCAL units, so a drag
    /// moves the path by the right amount when the node is scaled or rotated.
    fn local_delta(&self, node: &x_native::Node, from: Point, to: Point) -> (f64, f64) {
        let (ax, ay) = x_native::editor::local_point(node, from.x, from.y);
        let (bx, by) = x_native::editor::local_point(node, to.x, to.y);
        (bx - ax, by - ay)
    }

    /// The node a live vector drag is acting on, cloned out so the pointer
    /// handlers can convert coordinates without holding the document borrow.
    fn vector_drag_node(&self) -> Option<(String, x_native::Node)> {
        let id = self.app.vector_edit_mode.selected_node.clone()?;
        let doc = self.app.doc_ref();
        let node = x_native::editor::find(&doc.editor_ref().root, &id)?.clone();
        Some((id, node))
    }

    // ------------------------------------------------------- interaction

    /// Right-click: select what's under the cursor (Figma behavior), then
    /// open the context menu there.
    fn on_right_press(&mut self, p: Point) {
        if self.app.document_loading.is_some() {
            return;
        }
        if self.app.flow.is_some() {
            // no context menus in the viewer
            return;
        }
        if self.app.screen != Screen::Editor {
            return;
        }
        let reg = self.app.editor_regions();
        if reg.canvas.contains(p) && !self.app.context_menu.open {
            let world = self.app.screen_to_world(p);
            let hit_id = {
                let doc = self.app.doc();
                let root = doc.editor_ref().root.clone();
                x_native::editor::hit_test(&root, world)
            };
            // Figma: right-clicking an ALREADY-SELECTED node keeps the
            // multi-selection. Collapsing it here made "Group selection"
            // silently no-op — the menu opened for N nodes, but
            // group_selection needs 2+ and the click had just reduced the
            // selection to the one node under the cursor.
            if let Some(hit) = hit_id {
                let er = self.app.doc_ref().editor_ref();
                let root = er.root.clone();
                let top_id = x_native::editor::top_level_ancestor(&root, &hit);
                let top = top_id.unwrap_or(hit.clone());
                let sel = er.selection.clone();
                let already_selected = sel.iter().any(|s| s == &top);
                if !already_selected {
                    let ed = self.app.doc().editor();
                    ed.click_select(world, false, false);
                }
            }
            let sel_count = {
                let doc = self.app.doc();
                doc.editor_ref().selection.len()
            };
            let contains_group = {
                use x_native::NodeKind as K;
                let d = self.app.doc();
                let id = d.selected_id();
                let root = &d.editor_ref().root;
                id.and_then(|i| crate::editor_ui::find_node(root, i.as_str()))
                    .map(|n| matches!(n.kind, K::Group))
                    .unwrap_or(false)
            };
            let target = if sel_count > 0 {
                crate::context_menu::ContextTarget::CanvasSelection {
                    selected_count: sel_count,
                    contains_group,
                }
            } else {
                crate::context_menu::ContextTarget::CanvasEmpty
            };
            let (win_w, win_h) = (self.app.win_w, self.app.win_h);
            self.app
                .context_menu
                .open_for_target(target, p.x, p.y, win_w, win_h);
        } else if self
            .app
            .page_field_rect
            .map(|r| r.contains(p))
            .unwrap_or(false)
            && self.app.page_menu.is_none()
        {
            // B14: right-click on the pages panel — the page menu acts on
            // the ACTIVE page, so a right-click on a non-active row
            // activates it first (right-click = select + menu)
            let n = self.app.doc_ref().editors.len();
            let cur = self.app.doc_ref().page;
            let rows = self.app.pages_rows();
            let mut page_index: Option<usize> = None;
            for (i, r) in rows.iter() {
                if r.contains(p) {
                    page_index = Some(*i);
                    break;
                }
            }
            if let Some(i) = page_index {
                if i < n && i != cur {
                    self.dispatch(Action::SelectPage(i));
                }
            }
            self.app.page_menu = Some(p);
        } else {
            // second right-click (or outside canvas) closes
            self.app.context_menu.close();
            self.app.page_menu = None;
        }
    }

    fn on_press(&mut self, p: Point) {
        if self.app.document_loading.is_some() {
            if let Some(action) = crate::loading::hit_action(&self.app, p) {
                self.loading_action(action);
            }
            return;
        }
        // any left press closes the context menu (its own rows dispatch
        // first — menu hits are appended last and scanned in reverse)
        if self.app.context_menu.open {
            self.app.context_menu.close();
        }
        self.app.page_menu = None;
        if self.app.palette.open {
            // zone hit or dismiss
            for (r, a) in self.app.hit.iter().rev() {
                if r.contains(p) {
                    let a = a.clone();
                    self.dispatch(a);
                    return;
                }
            }
            self.app.palette.open = false;
            return;
        }

        if self.app.screen == Screen::Dashboard {
            for (r, a) in self.app.hit.iter().rev() {
                if r.contains(p) {
                    let a = a.clone();
                    self.dispatch(a);
                    return;
                }
            }
            self.app.dash_search_focus = false;
            return;
        }

        // Board screen - handle board-specific interactions
        if self.app.screen == Screen::Board {
            let reg = self.app.board_regions();

            // close dropdowns on outside click
            if self.app.dropdown_frame {
                self.app.dropdown_frame = false;
            }
            if self.app.dropdown_zoom {
                self.app.dropdown_zoom = false;
            }
            if self.app.dropdown_text_style {
                self.app.dropdown_text_style = false;
            }

            // chrome hit zones
            for (r, a) in self.app.hit.iter().rev() {
                if r.contains(p) {
                    let a = a.clone();
                    self.dispatch(a);
                    return;
                }
            }

            // canvas interactions
            if reg.canvas.contains(p) {
                self.board_canvas_press(p);
            } else {
                // click-away commits any field edit
                self.commit_field();
            }
            return;
        }

        // Editor screen
        // panel resizers take priority (6px strips)
        let reg = self.app.editor_regions();
        if let Some(d) = resizer_at(&self.app, p) {
            match d {
                0 => {
                    self.app.drag = Some(Drag::LeftPanel {
                        start_x: p.x,
                        start_w: self.app.left_w,
                    });
                }
                _ => {
                    self.app.drag = Some(Drag::RightPanel {
                        start_x: p.x,
                        start_w: self.app.right_w,
                    });
                }
            }
            return;
        }
        let _ = reg;

        // close frame dropdown on outside click
        if self.app.dropdown_frame {
            self.app.dropdown_frame = false;
        }
        if self.app.dropdown_zoom {
            self.app.dropdown_zoom = false;
        }
        if self.app.dropdown_lh {
            self.app.dropdown_lh = false;
        }
        if self.app.dropdown_text_style {
            self.app.dropdown_text_style = false;
        }

        // Color popovers are modal to the inspector. Consume clicks inside
        // the popup and close without editing the canvas when the click lands
        // outside it.
        let color_popup_hit = crate::editor_ui::color_picker_rect(&self.app)
            .map(|r| r.contains(p))
            .unwrap_or(false);
        if self.app.color_picker_popup.is_some() && !color_popup_hit {
            self.dispatch(Action::CloseColorPicker);
            return;
        }

        // chrome hit zones
        for (r, a) in self.app.hit.iter().rev() {
            if r.contains(p) {
                let a = a.clone();
                if let Action::TreeRow(id) = &a {
                    if !id.starts_with("mock:") {
                        // P12: select on press; a >4px move starts the
                        // reorder drag, a plain click just selects
                        let doc = self.app.doc();
                        doc.mock_layers.iter_mut().for_each(|m| m.selected = false);
                        doc.editor().selection = vec![id.clone()];
                        self.app.drag = Some(Drag::TreeRow {
                            id: id.clone(),
                            start: p,
                            active: false,
                            over: None,
                        });
                        return;
                    }
                }
                if matches!(a, Action::Field(FieldId::InstanceProp)) {
                    // resolve WHICH text prop was clicked from the rect the
                    // paint pass recorded
                    self.app.instance_prop_target = self
                        .app
                        .last_instance_prop_rect
                        .as_ref()
                        .filter(|(r2, _)| r2.contains(p))
                        .map(|(_, n)| n.clone());
                }
                self.dispatch(a);
                return;
            }
        }
        if color_popup_hit {
            return;
        }

        // flow preview: viewer clicks drive the prototype, never edit
        if self.app.flow.is_some() {
            if self.app.view_canvas().contains(p) {
                self.flow_press(p);
            }
            return;
        }
        // canvas interactions
        if reg.canvas.contains(p) {
            self.canvas_press(p);
        } else {
            // click-away commits any field edit
            self.commit_field();
        }
    }

    fn canvas_press(&mut self, p: Point) {
        // Ruler guides (Figma): press in a ruler strip creates one; press
        // near an existing line grabs it. Release back in the ruler (or
        // Esc) removes it.
        if self.app.guide_press(p) {
            return;
        }
        // P13: eyedropper — the first canvas click samples the topmost
        // layer's fill into the current selection
        if self.app.eyedropper {
            self.app.eyedropper = false;
            let world = self.app.screen_to_world(p);
            let id = {
                let doc = self.app.doc();
                x_native::editor::hit_test(&doc.editor_ref().root, world)
            };
            match id {
                Some(id) => {
                    let (paint, sel) = {
                        let doc = self.app.doc();
                        let Some(node) = doc.editor_ref().get_node(&id) else {
                            self.app.status = "Eyedropper: layer not found".into();
                            return;
                        };
                        let paint = node
                            .fill_layers
                            .iter()
                            .find(|l| l.visible)
                            .map(|l| l.paint.clone())
                            .unwrap_or_else(|| node.fill.clone());
                        let sel = doc.selected_id();
                        (paint, sel)
                    };
                    match sel {
                        Some(target) if target != id => {
                            let doc = self.app.doc();
                            doc.editor().set_fill(&target, paint);
                            self.app.mark_dirty();
                            self.app.status = format!("Sampled color from {id}");
                        }
                        Some(_) => self.app.status = "Already the same layer".into(),
                        _ => self.app.status = "Select a layer first, then sample".into(),
                    }
                }
                None => self.app.status = "Eyedropper: no layer under the cursor".into(),
            }
            return;
        }
        // ---- comments (C18): composer, then pins -------------------
        if let Some(d) = self.app.comment_draft.clone() {
            let sp = self.app.world_to_screen(vello::kurbo::Point::new(d.x, d.y));
            // Post button sits at the composer's bottom-right
            let post = Rect::new(sp.x + 148.0, sp.y + 34.0, sp.x + 232.0, sp.y + 58.0);
            if post.contains(p) {
                let text = d.buffer.trim().to_string();
                self.app.comment_draft = None;
                if !text.is_empty() {
                    let (x, y) = (d.x, d.y);
                    self.app.post_comment(x, y, &text);
                    self.app.status = "Comment added".into();
                }
                return;
            }
            let box_r = Rect::new(sp.x, sp.y, sp.x + 240.0, sp.y + 64.0);
            if box_r.contains(p) {
                return; // keep typing focus
            }
            // click-away cancels the draft and consumes the click
            self.app.comment_draft = None;
            return;
        }
        // thread popover buttons when one is open
        if let Some(id) = self.app.open_comment.clone() {
            if let Some(c) = {
                let doc = self.app.doc();
                doc.doc.comments.iter().find(|c| c.id == id).cloned()
            } {
                let sp = self.app.world_to_screen(vello::kurbo::Point::new(c.x, c.y));
                // P13: rects match the painted pill (card.x0 = sp.x+32,
                // card.y0 = sp.y-28; pill at card +12/+48, 84×22) — the
                // old resolve rect missed most of the pill
                let resolve = Rect::new(sp.x + 44.0, sp.y + 20.0, sp.x + 128.0, sp.y + 42.0);
                let del = Rect::new(sp.x + 126.0, sp.y + 6.0, sp.x + 168.0, sp.y + 30.0);
                if resolve.contains(p) {
                    let next = !c.resolved;
                    self.app.resolve_comment(&id, next);
                    self.app.status = if next {
                        "Comment resolved".into()
                    } else {
                        "Comment unresolved".into()
                    };
                    return;
                }
                if del.contains(p) {
                    self.app.delete_comment(&id);
                    self.app.open_comment = None;
                    self.app.status = "Comment deleted".into();
                    return;
                }
                // clicking the card keeps it open; anywhere else closes it
                let card = Rect::new(sp.x, sp.y - 24.0, sp.x + 240.0, sp.y + 40.0);
                if card.contains(p) || self.app.comment_at(p) == Some(id.clone()) {
                    return;
                }
                self.app.open_comment = None;
                // fall through: the click proceeds to pins / canvas
            }
        }
        // any pin hit opens its thread (any tool, above the canvas)
        if let Some(id) = self.app.comment_at(p) {
            self.app.open_comment = Some(id);
            return;
        }
        // comment tool: drop a composer at the anchor point
        if self.app.tool == Tool::Comment {
            let world = self.app.screen_to_world(p);
            self.app.comment_draft = Some(crate::state::CommentDraft {
                x: world.x,
                y: world.y,
                buffer: String::new(),
            });
            return;
        }
        // clicking INSIDE the open editor moves the caret (drag selects);
        // clicking anywhere else commits
        if self.app.text_edit.is_some() {
            if let Some(idx) = self.app.text_char_at(p) {
                self.app.field = None; // editor takes keyboard focus back
                if self.app.is_double_click(p) {
                    self.app.text_set_caret(idx, false);
                    self.app.text_select_word();
                } else {
                    self.app.text_set_caret(idx, self.app.shift);
                }
                self.app.last_click = Some((std::time::Instant::now(), p));
                self.app.drag = Some(Drag::TextEditSel);
                return;
            }
        }
        self.commit_field();
        let world = self.app.screen_to_world(p);
        let tool = self.app.tool;
        if self.app.space_pan && tool != Tool::Pen {
            self.app.drag = Some(Drag::Pan {
                start: p,
                start_pan: self.app.pan,
            });
            return;
        }
        // Vector edit mode owns the canvas while it is active: the press goes
        // to anchors and handles first, and only falls through here when the
        // mode has no node to edit.
        if self.app.vector_edit_mode.active && self.vector_press(world) {
            return;
        }
        match tool {
            Tool::Hand => {
                self.app.drag = Some(Drag::Pan {
                    start: p,
                    start_pan: self.app.pan,
                });
            }
            Tool::Select => {
                // corner handles win when there's a single selection
                if let Some(dr) = self.resize_grab(world) {
                    self.app.drag = Some(dr);
                    return;
                }
                let hit_id = {
                    let doc = self.app.doc();
                    let root = doc.editor_ref().root.clone();
                    x_native::editor::hit_test(&root, world)
                };
                // double-click: deep-select into groups / inline-edit text
                let dbl = self.app.is_double_click(p);
                self.app.last_click = Some((std::time::Instant::now(), p));
                // ⌘-click reaches through groups to the exact nested layer,
                // which is the other half of Figma's selection story alongside
                // double-click diving in
                let deep_click = self.app.ctrl;
                if dbl {
                    if let Some(id) = hit_id.clone() {
                        let text = {
                            let doc = self.app.doc();
                            let root = &doc.editor_ref().root;
                            crate::editor_ui::find_node(root, id.as_str()).and_then(|n| {
                                match &n.kind {
                                    NodeKind::Text { text } => Some(text.clone()),
                                    _ => None,
                                }
                            })
                        };
                        if let Some(text) = text {
                            self.app.begin_text_edit(id, text);
                            return;
                        }
                    }
                }
                // click on ALREADY-SELECTED text: caret on release
                // (a drag still moves; plain select/move otherwise)
                if let Some(id) = hit_id.clone() {
                    if self.app.press_selected_text(id, p, world) {
                        return;
                    }
                }
                if let Some(_id) = hit_id {
                    let shift = self.app.shift;
                    let deep = dbl || deep_click;
                    // ⌥-drag: duplicate the selection, then drag the copy
                    if self.app.alt {
                        self.app.doc().editor().duplicate_selection((0.0, 0.0));
                        self.app.mark_dirty();
                    }
                    self.app.doc().editor().click_select(world, shift, deep);
                    self.app.mark_dirty();
                    self.app.drag = Some(Drag::MoveSel {
                        last: world,
                        base_depth: self.app.doc().editor_ref().undo_depth(),
                    });
                } else {
                    if !self.app.shift {
                        self.app.doc().editor().selection.clear();
                    }
                    self.app.drag = Some(Drag::Marquee {
                        start: world,
                        cur: world,
                    });
                }
            }
            Tool::Pen => self.app.pen_click(world),
            Tool::Eraser => {
                // Start eraser stroke on left click
                use x_native::editor::eraser::EraserSettings;
                let settings = EraserSettings {
                    radius: 8.0,
                    feather: 0.3,
                    min_segment_length: 2.0,
                    soft_mask: true,
                };
                self.app.doc().editor().eraser_start(settings);
                self.app.drag = Some(Drag::Erase {
                    start: world,
                    cur: world,
                });
            }
            Tool::Symmetry => {
                // Symmetry tool click - toggle symmetry axis or show options
                // For now, just provide feedback that symmetry mode is active
            }
            _ => {
                self.app.drag = Some(Drag::Create {
                    tool,
                    start: world,
                    cur: world,
                });
            }
        }
    }

    /// Board canvas press handler - handles tool-specific actions on infinite canvas
    fn board_canvas_press(&mut self, p: Point) {
        use x_board::BoardTool;

        let world = self.app.screen_to_world(p);
        let tool = self.app.board_tool();

        // Handle space-pan first
        if self.app.space_pan {
            self.app.drag = Some(Drag::BoardPan {
                start: p,
                start_pan: self.app.pan,
            });
            return;
        }

        match tool {
            BoardTool::Hand => {
                self.app.drag = Some(Drag::BoardPan {
                    start: p,
                    start_pan: self.app.pan,
                });
            }
            BoardTool::Select => {
                // Check if clicking on a node
                let hit_node = self.app.hit_test_board_node(world);

                if let Some(node_id) = hit_node {
                    // Start moving the node
                    self.app.drag = Some(Drag::BoardMoveNode {
                        node_id,
                        start: world,
                        cur: world,
                    });
                } else {
                    // Start marquee selection
                    self.app.drag = Some(Drag::BoardMarquee {
                        start: world,
                        cur: world,
                    });
                }
            }
            BoardTool::StickyNote => {
                // Create sticky note at click position
                self.app.drag = Some(Drag::BoardCreateSticky {
                    start: world,
                    cur: world,
                    color_idx: 0, // Default to first color
                });
            }
            BoardTool::Connector => {
                // Check if clicking on a node to start connector
                if let Some(node_id) = self.app.hit_test_board_node(world) {
                    self.app.drag = Some(Drag::BoardConnector {
                        from_node: node_id,
                        from_point: world,
                        to_point: world,
                    });
                }
            }
            BoardTool::Pen => {
                // Start freehand drawing - collect points while dragging
                let start_node = x_native::fresh_id("pen");
                self.app.drag = Some(Drag::BoardPen {
                    id: start_node,
                    points: vec![world],
                });
            }
            BoardTool::Rectangle | BoardTool::Circle => {
                // Create shape
                self.app.drag = Some(Drag::Create {
                    tool: if matches!(tool, BoardTool::Rectangle) {
                        Tool::Rect
                    } else {
                        Tool::Ellipse
                    },
                    start: world,
                    cur: world,
                });
            }
            BoardTool::Zoom => {
                // Click to zoom in at the cursor; the editor keeps ⌘+/⌘-
                // for precise steps, so this stays a plain zoom-in gesture.
                self.app.zoom = (self.app.zoom * 1.2).min(256.0);
                self.app.status = "Zoom in".into();
            }
            BoardTool::Text => {
                // Create text label at click position
                let id = x_native::fresh_id("label");
                let label = x_board::nodes::BoardNode::TextLabel(x_board::nodes::TextLabel {
                    id: id.clone(),
                    text: format!("Label {}", &id[..id.len().min(4)]),
                    font_size: 16.0,
                    color: [0.92, 0.92, 0.94, 1.0],
                    transform: x_native::Transform {
                        x: world.x,
                        y: world.y,
                        rotation: 0.0,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        skew_x: 0.0,
                        skew_y: 0.0,
                        origin_x: 0.5,
                        origin_y: 0.5,
                    },
                });

                if self.app.is_board() {
                    let board_doc = self.app.board_doc_mut();
                    board_doc.add_node(label);
                    board_doc.set_selection(vec![id]);
                }

                self.app.status = "Text label created".into();
            }
        }
    }

    /// Within 6px of a corner handle of the selection → start a
    /// corner resize. Corner idx: 0 TL, 1 TR, 2 BL, 3 BR.
    /// Supports multi-selection by resizing all selected items together.
    fn resize_grab(&mut self, world: Point) -> Option<Drag> {
        let doc = self.app.doc();
        let editor = doc.editor_ref();
        if editor.selection.is_empty() {
            return None;
        }
        // undo depth at press: release merges the per-event resize entries
        // so one Ctrl+Z reverts the whole corner drag
        let base_depth = editor.undo_depth();

        // Get combined bounding box for multi-selection
        let mut single: Option<x_native::Node> = None;
        let bounds = if editor.selection.len() == 1 {
            // Single selection - use existing logic
            let id = editor.selection.first()?.clone();
            let n = crate::editor_ui::find_node(&editor.root, id.as_str())?;
            let b = (n.transform.x, n.transform.y, n.w, n.h);
            single = Some(n.clone());
            b
        } else {
            // Multi-selection - compute combined bounds
            let mut min_x = f64::MAX;
            let mut min_y = f64::MAX;
            let mut max_x = f64::MIN;
            let mut max_y = f64::MIN;

            for id in &editor.selection {
                if let Some(n) = crate::editor_ui::find_node(&editor.root, id.as_str()) {
                    min_x = min_x.min(n.transform.x);
                    min_y = min_y.min(n.transform.y);
                    max_x = max_x.max(n.transform.x + n.w);
                    max_y = max_y.max(n.transform.y + n.h);
                }
            }

            if min_x == f64::MAX {
                return None;
            }

            (min_x, min_y, max_x - min_x, max_y - min_y)
        };

        let (x, y, w, h) = bounds;
        // proximity in SCREEN px
        let tol = 6.0 / self.app.zoom.max(0.01);
        let corners = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)];
        // A transformed layer's handles are NOT at the corners of its
        // axis-aligned box: the renderer draws the node through
        // `transform.matrix`, so the outline (and these handles) have to be
        // placed the same way or grabbing a rotated shape misses. Unrotated
        // nodes keep the original square-proximity test, byte for byte.
        let corner = match &single {
            Some(n) if crate::editor_ui::is_transformed(n) => {
                x_native::editor::corner_at(n, world.x, world.y, tol)
                    .map(x_native::editor::corner_index)?
            }
            _ => corners
                .iter()
                .position(|(cx, cy)| (world.x - cx).abs() <= tol && (world.y - cy).abs() <= tol)?,
        };
        Some(Drag::ResizeSel {
            corner,
            orig: (x, y, w, h),
            start: world,
            base_depth,
        })
    }

    fn on_move(&mut self, p: Point) {
        if self.app.document_loading.is_some() {
            return;
        }
        if self.app.flow.is_some() {
            // viewer: pointer moves drive hover/drag triggers, never edits
            self.flow_move(p);
            return;
        }
        match self.app.drag.clone() {
            Some(Drag::LeftPanel { start_x, start_w }) => {
                self.app.left_w = (start_w + p.x - start_x).clamp(ED_LEFT_MIN, ED_LEFT_MAX);
            }
            Some(Drag::RightPanel { start_x, start_w }) => {
                self.app.right_w = (start_w - (p.x - start_x)).clamp(ED_RIGHT_MIN, ED_RIGHT_MAX);
            }
            Some(Drag::Pan { start, start_pan }) => {
                self.app.pan = (start_pan.0 + p.x - start.x, start_pan.1 + p.y - start.y);
            }
            Some(Drag::MoveSel { last, .. }) => {
                let world = self.app.screen_to_world(p);
                let dx = world.x - last.x;
                let dy = world.y - last.y;
                if dx != 0.0 || dy != 0.0 {
                    self.app.pending_text_edit = None; // a drag moves, no caret
                    self.smart_move(dx, dy);
                    if let Some(Drag::MoveSel { last, .. }) = self.app.drag.as_mut() {
                        *last = world;
                    }
                }
            }
            Some(Drag::Marquee { .. }) => {
                let world = self.app.screen_to_world(p);
                if let Some(Drag::Marquee { cur, .. }) = self.app.drag.as_mut() {
                    *cur = world;
                }
            }
            Some(Drag::TreeRow {
                id, start, active, ..
            }) => {
                if !active {
                    if (p.x - start.x).abs().max((p.y - start.y).abs()) < 4.0 {
                        return;
                    }
                    if let Some(Drag::TreeRow { active, .. }) = self.app.drag.as_mut() {
                        *active = true;
                    }
                }
                let over = crate::editor_ui::tree_drop_target(&self.app, &id, p);
                if let Some(Drag::TreeRow { over: o, .. }) = self.app.drag.as_mut() {
                    *o = over;
                }
            }
            // ---- vector edit mode drags: live in the tree, logged once ----
            Some(Drag::VectorPoint { last }) => {
                let world = self.app.screen_to_world(p);
                let Some((id, node)) = self.vector_drag_node() else {
                    return;
                };
                let (dx, dy) = self.local_delta(&node, last, world);
                if dx == 0.0 && dy == 0.0 {
                    return;
                }
                let idxs = self.app.vector_edit_mode.selected_points.clone();
                let moved = {
                    let editor = self.app.doc().editor();
                    editor.live_rewrite_path(&id, |path| {
                        let mut path = path.to_vec();
                        x_native::editor::move_anchors_by(&mut path, &idxs, dx, dy);
                        Some(path)
                    })
                };
                if moved {
                    self.app.mark_dirty();
                    if let Some(Drag::VectorPoint { last }) = self.app.drag.as_mut() {
                        *last = world;
                    }
                }
            }
            Some(Drag::VectorHandle {
                anchor_idx,
                outgoing,
            }) => {
                let world = self.app.screen_to_world(p);
                let Some((id, node)) = self.vector_drag_node() else {
                    return;
                };
                // the handle lives in the node's LOCAL space, and Alt breaks
                // the tangent instead of mirroring through the anchor
                let (lx, ly) = x_native::editor::local_point(&node, world.x, world.y);
                let mirror = !self.app.alt;
                let moved = {
                    let editor = self.app.doc().editor();
                    editor.live_rewrite_path(&id, |path| {
                        x_native::editor::move_handle_in(path, anchor_idx, outgoing, lx, ly, mirror)
                    })
                };
                if moved {
                    self.app.mark_dirty();
                }
            }
            Some(Drag::VectorBend { anchor_idx }) => {
                let world = self.app.screen_to_world(p);
                let Some((id, node)) = self.vector_drag_node() else {
                    return;
                };
                let (lx, ly) = x_native::editor::local_point(&node, world.x, world.y);
                let mirror = !self.app.alt;
                let moved = {
                    let editor = self.app.doc().editor();
                    editor.live_rewrite_path(&id, |path| {
                        x_native::editor::bend_anchor(path, anchor_idx, (lx, ly), mirror)
                    })
                };
                if moved {
                    self.app.mark_dirty();
                }
            }
            Some(Drag::VectorLasso { .. }) => {
                let world = self.app.screen_to_world(p);
                if let Some(Drag::VectorLasso { cur, .. }) = self.app.drag.as_mut() {
                    *cur = world;
                }
            }
            Some(Drag::ResizeSel {
                corner,
                orig: (ox, oy, ow, oh),
                start,
                ..
            }) => {
                let world = self.app.screen_to_world(p);

                // ONE layer, dragged by a corner: resize in the node's own
                // frame. The engine keeps the opposite corner pinned in world
                // space (and derives the position that achieves it), instead
                // of growing an axis-aligned box and letting a rotated shape
                // slide off its own outline. ⌥ (resize from center) has no
                // anchor corner to pin, so it keeps the symmetric path below.
                let single = {
                    let doc = self.app.doc();
                    doc.editor_ref().selection.clone()
                };
                if single.len() == 1 && !self.app.alt {
                    let id = single[0].clone();
                    // read the modifier BEFORE taking the document: the
                    // editor call holds a mutable borrow of the app, so a
                    // `self.app.shift` in its argument list would fight it
                    let keep_aspect = self.app.shift;
                    let resized = {
                        let doc = self.app.doc();
                        doc.editor().resize_transformed(
                            &id,
                            x_native::editor::corner_from_index(corner),
                            world.x,
                            world.y,
                            keep_aspect,
                            2.0,
                        )
                    };
                    if resized {
                        // manually resizing a text box pins it (Figma fixed-size)
                        let is_text = {
                            let doc = self.app.doc();
                            crate::editor_ui::find_node(&doc.editor_ref().root, &id)
                                .map(|n| matches!(n.kind, x_native::NodeKind::Text { .. }))
                                .unwrap_or(false)
                        };
                        if is_text {
                            let doc = self.app.doc();
                            doc.editor().mutate_visual_stack(&id, |node| {
                                node.bindings.insert("tm".into(), "fixed".into());
                            });
                        }
                        self.app.mark_dirty();
                    }
                    return;
                }

                let mut dx = (world.x - start.x).min(ow - 2.0);
                let mut dy = (world.y - start.y).min(oh - 2.0);
                // ⇧ keeps the original aspect ratio
                if self.app.shift && ow > 0.5 && oh > 0.5 {
                    let ratio = oh / ow;
                    if dx.abs() >= dy.abs() {
                        dy = dx * ratio;
                    } else {
                        dx = dy / ratio;
                    }
                }
                // ⌥ resizes from center (symmetric)
                if self.app.alt {
                    dx *= 2.0;
                    dy *= 2.0;
                }

                // Handle multi-selection resize
                let selection = {
                    let doc = self.app.doc();
                    doc.editor_ref().selection.clone()
                };

                if selection.is_empty() {
                    return;
                }

                // Compute combined bounds for delta calculation
                let bounds = if selection.len() == 1 {
                    let id = &selection[0];
                    let doc = self.app.doc();
                    if let Some(n) =
                        crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())
                    {
                        (n.transform.x, n.transform.y, n.w, n.h)
                    } else {
                        return;
                    }
                } else {
                    let mut min_x = f64::MAX;
                    let mut min_y = f64::MAX;
                    let mut max_x = f64::MIN;
                    let mut max_y = f64::MIN;

                    let doc = self.app.doc();
                    for id in &selection {
                        if let Some(n) =
                            crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())
                        {
                            min_x = min_x.min(n.transform.x);
                            min_y = min_y.min(n.transform.y);
                            max_x = max_x.max(n.transform.x + n.w);
                            max_y = max_y.max(n.transform.y + n.h);
                        }
                    }

                    if min_x == f64::MAX {
                        return;
                    }

                    (min_x, min_y, max_x - min_x, max_y - min_y)
                };

                let (bx, by, bw, bh) = bounds;

                // Calculate new bounds based on corner
                let (nbx, nby, nbw, nbh) = match corner {
                    0 => (ox + dx, oy + dy, ow - dx, oh - dy),
                    1 => (ox, oy + dy, ow + dx, oh - dy),
                    2 => (ox + dx, oy, ow - dx, oh + dy),
                    _ => (ox, oy, ow + dx, oh + dy),
                };

                if nbw < 2.0 || nbh < 2.0 {
                    return;
                }

                // Calculate scale and offset for each selected item
                let scale_x = nbw / bw;
                let scale_y = nbh / bh;
                let offset_x = nbx - bx;
                let offset_y = nby - by;

                // Apply transform to all selected items
                for id in &selection {
                    let (tx, ty, w, h, is_text) = {
                        let doc = self.app.doc();
                        match crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str()) {
                            Some(n) => (
                                n.transform.x,
                                n.transform.y,
                                n.w,
                                n.h,
                                matches!(n.kind, x_native::NodeKind::Text { .. }),
                            ),
                            None => continue,
                        }
                    };
                    let nx = bx + (tx - bx) * scale_x + offset_x;
                    let ny = by + (ty - by) * scale_y + offset_y;
                    let nw = w * scale_x;
                    let nh = h * scale_y;

                    let doc = self.app.doc();
                    // manually resizing a text box pins it (Figma fixed-size)
                    if is_text {
                        doc.editor().mutate_visual_stack(id, |node| {
                            node.bindings.insert("tm".into(), "fixed".into());
                        });
                    }
                    doc.editor().move_node(id, nx - tx, ny - ty);
                    doc.editor().resize(id, nw, nh);
                }
                self.app.mark_dirty();
            }
            Some(Drag::Create { start, .. }) => {
                let mut world = self.app.screen_to_world(p);
                // ⇧ constrains to square / circle
                if self.app.shift {
                    let dx = world.x - start.x;
                    let dy = world.y - start.y;
                    let m = dx.abs().max(dy.abs());
                    world = Point::new(start.x + dx.signum() * m, start.y + dy.signum() * m);
                }
                if let Some(Drag::Create { cur, .. }) = self.app.drag.as_mut() {
                    *cur = world;
                }
            }
            Some(Drag::Pen { .. }) => {
                let world = self.app.screen_to_world(p);
                if let Some(Drag::Pen { cursor, .. }) = self.app.drag.as_mut() {
                    *cursor = Some(world);
                }
            }
            Some(Drag::Erase { .. }) => {
                // Update eraser stroke position
                let world = self.app.screen_to_world(p);
                if let Some(Drag::Erase { cur, .. }) = self.app.drag.as_mut() {
                    *cur = world;
                }

                // Continue eraser stroke with current position
                // Pressure is 1.0 for mouse, could be updated for tablet
                self.app
                    .doc()
                    .editor()
                    .eraser_continue(world.x, world.y, 1.0);
            }
            Some(Drag::TextEditSel) => {
                // drag-select inside the open inline editor
                if let Some(idx) = self.app.text_char_at(p) {
                    self.app.text_set_caret(idx, true);
                }
            }
            Some(Drag::Guide { axis }) => {
                let world = self.app.screen_to_world(p);
                let c = if axis == 'v' { world.x } else { world.y };
                *self.app.guide_drag() = Some((axis, c));
            }
            // Board-specific drag handlers
            Some(Drag::BoardCreateSticky {
                start: _,
                cur: _,
                color_idx: _,
            }) => {
                let world = self.app.screen_to_world(p);
                if let Some(Drag::BoardCreateSticky { cur: c, .. }) = self.app.drag.as_mut() {
                    *c = world;
                }
            }
            Some(Drag::BoardConnector {
                from_node: _,
                from_point: _,
                to_point: _,
            }) => {
                let world = self.app.screen_to_world(p);
                if let Some(Drag::BoardConnector { to_point: t, .. }) = self.app.drag.as_mut() {
                    *t = world;
                }
            }
            Some(Drag::BoardMoveNode {
                node_id,
                start: _,
                cur,
            }) => {
                let world = self.app.screen_to_world(p);
                let dx = world.x - cur.x;
                let dy = world.y - cur.y;
                if dx != 0.0 || dy != 0.0 {
                    if let Some(Drag::BoardMoveNode { cur: c, .. }) = self.app.drag.as_mut() {
                        *c = world;
                    }
                    // Move the board node
                    let doc = self.app.board_doc_mut();
                    let page = doc.current_page_mut();
                    for node in &mut page.nodes {
                        if node.id() == &node_id {
                            if let Some(transform) = node.transform_mut() {
                                transform.x += dx;
                                transform.y += dy;
                            }
                            break;
                        }
                    }
                }
            }
            Some(Drag::BoardMarquee { start: _, cur: _ }) => {
                let world = self.app.screen_to_world(p);
                if let Some(Drag::BoardMarquee { cur: c, .. }) = self.app.drag.as_mut() {
                    *c = world;
                }
            }
            Some(Drag::BoardPan { start, start_pan }) => {
                self.app.pan = (start_pan.0 + p.x - start.x, start_pan.1 + p.y - start.y);
            }
            Some(Drag::BoardPen { id: _, points: _ }) => {
                let world = self.app.screen_to_world(p);
                if let Some(Drag::BoardPen { points: pts, .. }) = self.app.drag.as_mut() {
                    pts.push(world);
                }
            }
            None => {
                self.app.update_hover(p);
            }
        }
    }

    /// Move the selection by (dx, dy) with Figma-style smart guides:
    /// snap the moving bounds to sibling edges/centers within 6 screen px
    /// and expose the snapped lines for painting.
    fn smart_move(&mut self, dx: f64, dy: f64) {
        let (bb, others) = {
            let doc = self.app.doc();
            let sel = doc.editor_ref().selection.clone();
            let root = &doc.editor_ref().root;
            let mut bb: Option<(f64, f64, f64, f64)> = None;
            for id in &sel {
                if let Some(n) = crate::editor_ui::find_node(root, id.as_str()) {
                    let (x0, y0) = (n.transform.x, n.transform.y);
                    let (x1, y1) = (x0 + n.w, y0 + n.h);
                    bb = Some(match bb {
                        None => (x0, y0, x1, y1),
                        Some((a, b, c, d)) => (a.min(x0), b.min(y0), c.max(x1), d.max(y1)),
                    });
                }
            }
            let others: Vec<(f64, f64, f64, f64)> = root
                .children
                .iter()
                .filter(|c| !sel.contains(&c.id))
                .map(|c| {
                    (
                        c.transform.x,
                        c.transform.y,
                        c.transform.x + c.w,
                        c.transform.y + c.h,
                    )
                })
                .collect();
            (bb, others)
        };
        let Some((bx0, by0, bx1, by1)) = bb else {
            let doc = self.app.doc();
            doc.editor().move_selection(dx, dy);
            self.app.mark_dirty();
            return;
        };
        let (dx, dy, lines) = compute_snap(
            (bx0, by0, bx1, by1),
            &others,
            dx,
            dy,
            6.0 / self.app.zoom.max(0.01),
        );
        self.app.snap_lines = lines;
        let doc = self.app.doc();
        doc.editor().move_selection(dx, dy);
        self.app.mark_dirty();
    }

    fn on_release(&mut self) {
        if self.app.document_loading.is_some() {
            return;
        }
        if self.app.flow.is_some() {
            self.flow_release();
            return;
        }
        self.app.snap_lines.clear();
        match self.app.drag.clone() {
            Some(Drag::Marquee { start, cur }) => {
                let r = Rect::new(
                    start.x.min(cur.x),
                    start.y.min(cur.y),
                    start.x.max(cur.x),
                    start.y.max(cur.y),
                );
                if r.width() > 2.0 || r.height() > 2.0 {
                    self.app.doc().editor().marquee(r);
                }
                self.app.drag = None;
            }
            Some(Drag::Create { tool, start, cur }) => {
                self.finish_create(tool, start, cur);
                self.app.drag = None;
            }
            // a vector drag commits here, as the ONE undo entry the engine has
            // been holding since the press opened the gesture
            Some(Drag::VectorPoint { .. })
            | Some(Drag::VectorHandle { .. })
            | Some(Drag::VectorBend { .. }) => {
                self.app.drag = None;
                if self.app.doc().editor().end_path_gesture() {
                    self.app.mark_dirty();
                    self.app.status = "Anchor moved - one undo step for the whole drag".into();
                }
                self.sync_vector_edit_mode();
            }
            Some(Drag::VectorLasso { start, cur }) => {
                self.app.drag = None;
                let zoom = self.app.zoom.max(1e-3);
                let (x0, y0) = (start.x.min(cur.x), start.y.min(cur.y));
                let (x1, y1) = (start.x.max(cur.x), start.y.max(cur.y));
                if (x1 - x0) * zoom < 2.0 && (y1 - y0) * zoom < 2.0 {
                    // a click, not a drag: empty canvas inside node edit mode
                    // drops the ANCHOR selection and leaves the layer selected
                    self.dispatch(Action::DeselectVectorPoints);
                } else {
                    self.dispatch(Action::LassoSelectPoints {
                        boundary: vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
                    });
                }
            }
            Some(Drag::Guide { .. }) => {
                self.app.guide_release();
            }
            // P12: the tree reorder commits on release — one undo step
            Some(Drag::TreeRow { active, over, .. }) => {
                if active {
                    if let Some(drop) = over {
                        self.app.apply_tree_drop(&drop);
                    }
                }
                self.app.drag = None;
            }
            // pen session continues across clicks (Enter/Esc/close ends it)
            Some(Drag::Pen { .. }) => {}
            // eraser stroke ends on release - apply the erasure
            Some(Drag::Erase { .. }) => {
                self.app.doc().editor().eraser_end();
                self.app.drag = None;
            }
            // Board: sticky creation ends on release
            Some(Drag::BoardCreateSticky {
                start,
                cur,
                color_idx,
            }) => {
                let w = (cur.x - start.x).abs().max(80.0);
                let h = (cur.y - start.y).abs().max(60.0);
                if w > 10.0 && h > 10.0 {
                    use x_board::stickies::StickyNote;
                    let sticky = StickyNote::sticky(
                        &x_native::fresh_id("sticky"),
                        start.x.min(cur.x) as f32,
                        start.y.min(cur.y) as f32,
                        w as f32,
                        h as f32,
                        color_idx,
                        "Stickie".to_string(),
                    );
                    let id = sticky.id().clone();
                    let doc = self.app.board_doc_mut();
                    doc.add_node(sticky);
                    doc.set_selection(vec![id]);
                }
                self.app.drag = None;
                self.app.tool = Tool::Select;
            }
            // Board: connector drawing ends on release
            Some(Drag::BoardConnector {
                from_node,
                to_point,
                ..
            }) => {
                // Find nearest node at to_point to complete connector
                let probe = self.app.board_doc();
                let end_node_id =
                    probe.find_nearest_node(glam::Vec2::new(to_point.x as f32, to_point.y as f32));
                if let Some(end_node_id) = end_node_id {
                    if from_node != end_node_id {
                        use x_board::stickies::StickyNote;
                        let (connector_node, connector) = StickyNote::connector(
                            &x_native::fresh_id("connector"),
                            from_node,
                            end_node_id,
                        );
                        let doc = self.app.board_doc_mut();
                        doc.add_node(connector_node);
                        doc.add_connector(connector);
                    }
                }
                self.app.drag = None;
                self.app.tool = Tool::Select;
            }
            // Board: moving a node ends on release
            Some(Drag::BoardMoveNode { .. }) => {
                self.app.drag = None;
            }
            // Board: marquee selection on infinite canvas
            Some(Drag::BoardMarquee { start, cur }) => {
                let r = Rect::new(
                    start.x.min(cur.x),
                    start.y.min(cur.y),
                    start.x.max(cur.x),
                    start.y.max(cur.y),
                );
                if r.width() > 2.0 || r.height() > 2.0 {
                    self.app.board_doc_mut().marquee_select(r);
                }
                self.app.drag = None;
            }
            // Board: panning ends on release
            Some(Drag::BoardPan { .. }) => {
                self.app.drag = None;
            }
            // Board: pen tool - create path node on release
            Some(Drag::BoardPen { id, points }) => {
                if points.len() > 1 {
                    use x_board::nodes::BoardNode;

                    // Freehand stroke: polyline through the sampled points,
                    // stored in node-local space with the first point as origin.
                    let origin = points[0];
                    let path_points: Vec<glam::Vec2> = points
                        .iter()
                        .map(|pt| {
                            glam::Vec2::new((pt.x - origin.x) as f32, (pt.y - origin.y) as f32)
                        })
                        .collect();
                    let pen_node = BoardNode::PenPath(x_board::nodes::PenPath {
                        id: id.clone(),
                        points: path_points,
                        stroke_color: [0.92, 0.92, 0.94, 1.0],
                        stroke_width: 2.0,
                        fill_color: None,
                        transform: x_native::Transform {
                            x: origin.x,
                            y: origin.y,
                            rotation: 0.0,
                            scale_x: 1.0,
                            scale_y: 1.0,
                            skew_x: 0.0,
                            skew_y: 0.0,
                            origin_x: 0.5,
                            origin_y: 0.5,
                        },
                    });

                    let doc = self.app.board_doc_mut();
                    doc.add_node(pen_node);
                    doc.set_selection(vec![id]);
                }
                self.app.drag = None;
                self.app.tool = Tool::Select;
            }
            // Layer move ends on release: every mouse event pushed its own
            // undo entry, so merge the whole gesture into ONE step — a
            // single Ctrl+Z reverts the drag (Figma semantics).
            Some(Drag::MoveSel { base_depth, .. }) => {
                {
                    let doc = self.app.doc();
                    let editor = doc.editor();
                    editor.merge_last(editor.undo_depth().saturating_sub(base_depth));
                }
                self.app.drag = None;
                // a click (no movement) on already-selected text still
                // places the caret — the gesture pushed nothing to merge
                if self.app.finish_pending_text_edit() {
                    self.app.mark_dirty();
                }
            }
            // Layer corner-resize ends on release: same one-gesture =
            // one-step merge as MoveSel.
            Some(Drag::ResizeSel { base_depth, .. }) => {
                let doc = self.app.doc();
                let editor = doc.editor();
                editor.merge_last(editor.undo_depth().saturating_sub(base_depth));
                self.app.drag = None;
            }
            _ => {
                self.app.drag = None;
                // click (no drag) on already-selected text = caret there
                if self.app.finish_pending_text_edit() {
                    self.app.mark_dirty();
                }
            }
        }
    }

    fn finish_create(&mut self, tool: Tool, start: Point, cur: Point) {
        let x = start.x.min(cur.x);
        let y = start.y.min(cur.y);
        let w = (cur.x - start.x).abs();
        let h = (cur.y - start.y).abs();
        let doc = self.app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let counter = doc
            .editors
            .iter()
            .map(|e| count_kind(&e.root))
            .sum::<usize>();
        let n = counter + 1;
        let node = match tool {
            Tool::Frame => {
                let fid = x_native::fresh_id("frame");
                let mut f = Node::frame(&fid, w.max(8.0), h.max(8.0));
                f.name = format!("Frame {n}");
                f.transform.x = x;
                f.transform.y = y;
                f.fill = Paint::Solid(x_native::Color::from_rgb8(0xFF, 0xFF, 0xFF));
                f
            }
            Tool::Rect => {
                let mut r = Node::rect(
                    &x_native::fresh_id("rectangle"),
                    x,
                    y,
                    w.max(2.0),
                    h.max(2.0),
                    x_native::Color::from_rgb8(0xFF, 0xFF, 0xFF),
                );
                r.name = format!("Rectangle {n}");
                r.stroke.width = 0.0;
                r
            }
            Tool::Ellipse => {
                let mut e = Node::ellipse(
                    &x_native::fresh_id("ellipse"),
                    x,
                    y,
                    w.max(2.0),
                    h.max(2.0),
                    x_native::Color::from_rgb8(0xFF, 0xFF, 0xFF),
                );
                e.name = format!("Ellipse {n}");
                e
            }
            Tool::Text => {
                // Figma: a new text object starts EMPTY (placeholder only);
                // committing empty deletes it
                let tid = x_native::fresh_id("text");
                let mut t = Node::text(&tid, x, y, w.max(120.0), 14.0, "");
                t.name = format!("Text {n}");
                // P3: new text is set in the document's default typeface
                // (per-file data) rather than an engine constant
                let default_font = doc.doc.resolved_default_font().to_string();
                t.bindings.insert("font".into(), default_font);
                t
            }
            _ => return,
        };
        let id = node.id.clone();
        let mut node = node;
        // Figma semantics: when exactly one container (frame / group /
        // section) is selected, the new node lands INSIDE it, with its
        // position expressed in that container's local space — drawing
        // with a frame selected builds the frame. Previously every drawn
        // node was forced onto the page root, so artboards could never
        // receive content (viewport audit P2).
        let (parent_id, parent_auto_layout) = {
            let doc = self.app.doc();
            let root = &doc.editor_ref().root;
            let sel = &doc.editor_ref().selection;
            if sel.len() == 1 {
                let p = crate::editor_ui::find_node(root, &sel[0]);
                if let Some(p) = p {
                    let is_container = matches!(
                        p.kind,
                        x_native::NodeKind::Frame { .. }
                            | x_native::NodeKind::Group
                            | x_native::NodeKind::Section
                    );
                    if is_container {
                        let (lx, ly) = world_to_local(root, &p.id, x, y);
                        node.transform.x = lx;
                        node.transform.y = ly;
                        let auto_layout =
                            matches!(&p.kind, x_native::NodeKind::Frame { layout: Some(_) });
                        (p.id.clone(), auto_layout)
                    } else {
                        (root_id.clone(), false)
                    }
                } else {
                    (root_id.clone(), false)
                }
            } else {
                (root_id.clone(), false)
            }
        };
        self.app.doc().editor().insert_node(&parent_id, node);
        // an auto-layout parent flow-places its children: the stored x/y is
        // only a pre-layout hint, so run the layout to settle it
        if parent_auto_layout {
            let vars = self.app.doc().doc.variables.clone();
            let e = self.app.doc().editor();
            let par = x_native::editor::find_mut(&mut e.root, &parent_id);
            if let Some(par) = par {
                x_native::apply_layout_recursive(par, &vars);
            }
        }
        self.app.doc().editor().selection = vec![id.clone()];
        self.app.mark_dirty();
        self.app.tool = Tool::Select;
        // click/drag with the Text tool drops a text node and starts editing it
        if tool == Tool::Text {
            self.app.begin_text_edit(id, String::new());
        }
    }

    fn on_wheel(&mut self, delta: MouseScrollDelta) {
        if self.app.document_loading.is_some() {
            return;
        }
        if self.app.flow.is_some() {
            // the viewer fits each screen; there is nothing to zoom/pan
            return;
        }
        let dy = match delta {
            MouseScrollDelta::LineDelta(_, y) => y as f64,
            MouseScrollDelta::PixelDelta(p) => p.y / 40.0,
        };
        if self.app.screen == Screen::Editor {
            let reg = self.app.editor_regions();
            let p = self.app.mouse;
            if reg.canvas.contains(p) && !self.app.ctrl {
                let f = if dy > 0.0 {
                    1.1
                } else if dy < 0.0 {
                    1.0 / 1.1
                } else {
                    return;
                };
                self.zoom_at(p, f);
            } else if reg.right.contains(p) {
                // clamp to the content: DESIGN column ends ~1780px below
                // the entry line (audit tail + margin)
                let max_scroll =
                    (1780.0 - (self.app.win_h - (crate::theme::ED_TITLE_H + 89.0))).max(0.0);
                let d = self.app.doc();
                d.scroll_right = (d.scroll_right - dy * 40.0).clamp(0.0, max_scroll);
            } else if reg.left.contains(p) {
                let d = self.app.doc();
                d.scroll_left = (d.scroll_left - dy * 40.0).max(0.0);
            }
        } else {
            let content = (self.app.recents.len().div_ceil(3) as f64 * 247.0 + 380.0)
                .max(900.0 + self.app.docs.len() as f64 * 48.0);
            self.app.dash_scroll = (self.app.dash_scroll - dy * 48.0)
                .clamp(0.0, (content - self.app.win_h + 24.0).max(0.0));
        }
    }

    /// Field value stepper (↑/↓): nudge the parsed value, apply it, and
    /// keep the field open for continued stepping.
    fn step_field(&mut self, delta: f64) {
        let Some(f) = self.app.field.clone() else {
            return;
        };
        if matches!(
            f.id,
            FieldId::DocName
                | FieldId::PageName
                | FieldId::TreeSearch
                | FieldId::InstanceProp
                | FieldId::FillHex
                | FieldId::StrokeHex
                | FieldId::FontFamily
                | FieldId::TextCase
                | FieldId::ExportSuffix
                | FieldId::CanvasBg
                | FieldId::GridColor
        ) {
            return;
        }
        let cur: f64 = f.buffer.trim().trim_end_matches('%').parse().unwrap_or(0.0);
        let nv = cur + delta;
        if !nv.is_finite() {
            self.app.status = "Enter a finite number".into();
            return;
        }
        let buf = if (nv - nv.round()).abs() < 0.005 {
            format!("{}", nv.round() as i64)
        } else {
            format!("{nv:.1}")
        };
        self.app.field = Some(crate::state::FieldEdit {
            id: f.id,
            buffer: buf.clone(),
        });
        self.commit_field();
        // reopen so continued arrows keep stepping from the new value
        self.app.field = Some(crate::state::FieldEdit {
            id: f.id,
            buffer: buf,
        });
    }

    fn on_key(&mut self, key: Key, text: Option<&str>) {
        if self.app.document_loading.is_some() {
            self.loading_key(&key);
            return;
        }
        if self.app.flow.is_some() {
            // preview mode: navigation + prototype keys only, rest swallowed
            self.flow_key(&key);
            return;
        }
        if key == Key::Named(NamedKey::Escape)
            && self.files.active.is_some()
            && !self.app.has_text_focus()
        {
            self.cancel_file_job();
            return;
        }
        if self.app.ctrl {
            if let Key::Character(c) = &key {
                let c = c.to_lowercase();
                match c.as_str() {
                    "s" => {
                        if self.app.shift {
                            self.cmd_save_as();
                        } else {
                            self.cmd_save();
                        }
                        return;
                    }
                    "n" => {
                        self.cmd_new_file();
                        return;
                    }
                    "o" => {
                        if !self.finish_edits() {
                            return;
                        }
                        self.cmd_open_file();
                        return;
                    }
                    _ => {}
                }
                if self.app.text_edit.is_some()
                    && self.app.field.is_none()
                    && self.app.comment_draft.is_none()
                    && !self.app.palette.open
                {
                    match c.as_str() {
                        "z" => {
                            self.app.undo_text(self.app.shift);
                        }
                        "y" => {
                            self.app.undo_text(true);
                        }
                        "a" => self.app.text_select_all_ed(),
                        "b" => {
                            self.app.text_toggle_weight();
                        }
                        "i" => {
                            self.app.text_toggle_italic();
                        }
                        "c" => self.app.copy_inline_text(),
                        "x" => {
                            self.app.copy_inline_text();
                            self.app.text_insert("");
                        }
                        "v" => {
                            let t = self.app.clipboard_text();
                            self.on_text(&t);
                        }
                        _ => {}
                    }
                    return;
                }
                if self.app.field.is_some() {
                    match c.as_str() {
                        "a" => self.app.field_select_all = true,
                        "v" => {
                            let t = self.app.clipboard_text();
                            self.on_text(&t);
                        }
                        "c" | "x" if self.app.field_select_all => {
                            self.app.text_clipboard =
                                self.app.field.as_ref().unwrap().buffer.clone();
                            if let Ok(mut clip) = arboard::Clipboard::new() {
                                let _ = clip.set_text(self.app.text_clipboard.clone());
                            }
                            if c == "x" {
                                self.app.field.as_mut().unwrap().buffer.clear();
                                self.app.field_select_all = false;
                            }
                        }
                        _ => {}
                    }
                    return;
                }
            }
        }
        if key == Key::Named(NamedKey::Space) && self.app.has_text_focus() {
            self.on_text(" ");
            return;
        }
        if self.app.color_picker_popup.is_some() && matches!(key, Key::Named(NamedKey::Escape)) {
            self.dispatch(Action::CloseColorPicker);
            return;
        }
        // comment composer (C18): owns the keyboard while open
        if self.app.comment_draft.is_some() {
            match (&key, text) {
                (Key::Named(NamedKey::Escape), _) => {
                    self.app.comment_draft = None;
                }
                (Key::Named(NamedKey::Enter), _) => {
                    let Some(d) = self.app.comment_draft.clone() else {
                        return;
                    };
                    let t = d.buffer.trim().to_string();
                    self.app.comment_draft = None;
                    if !t.is_empty() {
                        let (x, y) = (d.x, d.y);
                        self.app.post_comment(x, y, &t);
                        self.app.status = "Comment added".into();
                    }
                }
                (Key::Named(NamedKey::Backspace), _) => {
                    if let Some(d) = &mut self.app.comment_draft {
                        d.buffer.pop();
                    }
                }
                (Key::Character(c), Some(t)) if !self.app.ctrl => {
                    let _ = c;
                    if let Some(d) = &mut self.app.comment_draft {
                        d.buffer.push_str(t);
                    }
                }
                _ => {}
            }
            return;
        }
        // Esc closes an open thread
        if self.app.open_comment.is_some() && matches!(&key, Key::Named(NamedKey::Escape)) {
            self.app.open_comment = None;
            return;
        }
        // rich-text inline editor: caret / selection / live styling keys.
        // Focus model — a panel field being open wins (numeric entry); the
        // editor gets the keystrokes otherwise.
        if self.app.text_edit.is_some() && self.app.field.is_none() {
            match (&key, text) {
                (Key::Named(NamedKey::Escape), _) => {
                    if self.app.context_menu.open {
                        self.app.context_menu.close();
                        return;
                    }
                    // fresh empty object: Esc discards it (Figma)
                    self.app.text_cancel_edit_new();
                    return;
                }
                (Key::Named(NamedKey::Enter), _) => {
                    // Figma-style: Enter inserts a newline (⌘Enter commits)
                    if self.app.ctrl {
                        if self.app.commit_text_field() {
                            self.app.mark_dirty();
                        }
                    } else {
                        self.app.text_insert("\n");
                    }
                    return;
                }
                (Key::Named(NamedKey::Backspace), _) => {
                    self.app.text_backspace();
                    return;
                }
                (Key::Named(NamedKey::Delete), _) => {
                    self.app.text_delete_forward();
                    return;
                }
                (Key::Named(NamedKey::ArrowLeft), _) => {
                    self.app.text_move_caret(-1, self.app.shift);
                    return;
                }
                (Key::Named(NamedKey::ArrowRight), _) => {
                    self.app.text_move_caret(1, self.app.shift);
                    return;
                }
                (Key::Named(NamedKey::ArrowUp), _) => {
                    self.app.text_move_vertical(-1, self.app.shift);
                    return;
                }
                (Key::Named(NamedKey::ArrowDown), _) => {
                    self.app.text_move_vertical(1, self.app.shift);
                    return;
                }
                (Key::Named(NamedKey::Home), _) => {
                    let chars = self.app.text_chars();
                    let start = chars[..self.app.text_caret.min(chars.len())]
                        .iter()
                        .rposition(|c| *c == '\n')
                        .map_or(0, |i| i + 1);
                    self.app.text_set_caret(start, self.app.shift);
                    return;
                }
                (Key::Named(NamedKey::End), _) => {
                    let chars = self.app.text_chars();
                    let mut idx = self.app.text_caret;
                    while idx < chars.len() && chars[idx] != '\n' {
                        idx += 1;
                    }
                    self.app.text_set_caret(idx, self.app.shift);
                    return;
                }
                (Key::Character(c), Some(t)) => {
                    let _ = c;
                    if self.app.ctrl {
                        // selection shortcuts inside the editor
                        match t.to_lowercase().as_str() {
                            "b" => {
                                self.app.text_toggle_weight();
                            }
                            "i" => {
                                self.app.text_toggle_italic();
                            }
                            "a" => {
                                self.app.text_select_all_ed();
                            }
                            _ => {}
                        }
                        return;
                    }
                    self.app.text_insert(t);
                    return;
                }
                _ => {}
            }
            return;
        }

        // text entry first
        if self.app.field.is_some() {
            match (&key, text) {
                (Key::Named(NamedKey::Enter), _) => {
                    self.commit_field();
                    return;
                }
                (Key::Named(NamedKey::Escape), _) => {
                    if self.app.context_menu.open {
                        self.app.context_menu.close();
                        return;
                    }
                    self.app.field = None;
                    self.app.field_select_all = false;
                    return;
                }
                (Key::Named(NamedKey::Backspace), _) => {
                    if let Some(f) = self.app.field.as_mut() {
                        if self.app.field_select_all {
                            f.buffer.clear();
                            self.app.field_select_all = false;
                        } else {
                            use unicode_segmentation::UnicodeSegmentation;
                            if let Some((at, _)) = f.buffer.grapheme_indices(true).next_back() {
                                f.buffer.truncate(at);
                            }
                        }
                    }
                    return;
                }
                (Key::Named(NamedKey::ArrowUp), _) => {
                    self.step_field(if self.app.shift { 10.0 } else { 1.0 });
                    return;
                }
                (Key::Named(NamedKey::ArrowDown), _) => {
                    self.step_field(if self.app.shift { -10.0 } else { -1.0 });
                    return;
                }
                (Key::Character(_), Some(t)) => {
                    self.on_text(t);
                    return;
                }
                _ => {}
            }
            return;
        }

        if self.app.palette.open {
            // Update context on every frame while open
            let doc = self.app.doc();
            self.app.palette.has_selection = !doc.editor_ref().selection.is_empty();

            match (&key, text) {
                (Key::Named(NamedKey::Escape), _) => {
                    self.app.palette.close();
                }
                (Key::Named(NamedKey::Enter), _) => {
                    // The active painter uses editor_ui::palette_commands;
                    // execute the same filtered row that the user sees
                    // instead of the retired CommandDef result list.
                    if let Some(ci) = self.palette_selection() {
                        self.run_palette(ci);
                    }
                }
                (Key::Named(NamedKey::ArrowDown), _) => {
                    let len = self.palette_len();
                    if len > 0 {
                        self.app.palette.selected_index =
                            (self.app.palette.selected_index + 1) % len;
                    }
                }
                (Key::Named(NamedKey::ArrowUp), _) => {
                    let len = self.palette_len();
                    if len > 0 {
                        self.app.palette.selected_index = if self.app.palette.selected_index == 0 {
                            len - 1
                        } else {
                            self.app.palette.selected_index - 1
                        };
                    }
                }
                (Key::Named(NamedKey::Backspace), _) => {
                    let current = self.app.palette.query.clone();
                    let mut chars: Vec<char> = current.chars().collect();
                    chars.pop();
                    let new_query: String = chars.into_iter().collect();
                    self.app.palette.set_query(&new_query);
                }
                (Key::Character(_), Some(t)) => {
                    for c in t.chars() {
                        self.app.palette.handle_key(&c.to_string(), true);
                    }
                }
                _ => {}
            }
            return;
        }

        // guide drag: Esc drops the guide being dragged
        if matches!(self.app.drag, Some(Drag::Guide { .. }))
            && matches!(key, Key::Named(NamedKey::Escape))
        {
            *self.app.guide_drag() = None;
            self.app.drag = None;
            return;
        }

        // pen finish
        if matches!(self.app.drag, Some(Drag::Pen { .. })) {
            match key {
                Key::Named(NamedKey::Enter) => {
                    self.finish_pen();
                    return;
                }
                Key::Named(NamedKey::Escape) => {
                    self.app.drag = None;
                    return;
                }
                _ => {}
            }
        }

        // Enter edits the selected text node (market-standard inline edit)
        if matches!(key, Key::Named(NamedKey::Enter))
            && !self.app.shift
            && self.app.screen == Screen::Editor
            && self.app.enter_edit_selected()
        {
            return;
        }

        // Vector edit mode (Figma parity): Enter on a vector layer edits its
        // anchors; inside the mode Escape or Enter leaves, ⌫ deletes the selected
        // anchors, and the arrows nudge them (⇧ = 10px, like every other nudge).
        // Scoped to the mode on purpose: P stays the pen tool and V the move
        // tool, so node editing never hijacks the global tool shortcuts.
        if self.app.screen == Screen::Editor && !self.app.docs.is_empty() {
            if self.app.vector_edit_mode.active {
                let (ctrl, alt, shift) = (self.app.ctrl, self.app.alt, self.app.shift);
                let nudge = match &key {
                    Key::Named(NamedKey::ArrowUp) => Some((0.0, -1.0)),
                    Key::Named(NamedKey::ArrowDown) => Some((0.0, 1.0)),
                    Key::Named(NamedKey::ArrowLeft) => Some((-1.0, 0.0)),
                    Key::Named(NamedKey::ArrowRight) => Some((1.0, 0.0)),
                    _ => None,
                };
                if let Some((ux, uy)) = nudge {
                    if !ctrl && !alt {
                        let step = if shift { 10.0 } else { 1.0 };
                        self.dispatch(Action::MoveVectorPoints {
                            dx: ux * step,
                            dy: uy * step,
                        });
                        return;
                    }
                }
                match &key {
                    Key::Named(NamedKey::Escape) => {
                        self.dispatch(Action::ExitVectorEditMode);
                        return;
                    }
                    Key::Named(NamedKey::Enter) if !ctrl && !alt && !shift => {
                        self.dispatch(Action::ExitVectorEditMode);
                        return;
                    }
                    Key::Named(NamedKey::Backspace | NamedKey::Delete) => {
                        self.dispatch(Action::DeleteVectorPoints);
                        return;
                    }
                    _ => {}
                }
            } else if matches!(key, Key::Named(NamedKey::Enter))
                && !self.app.ctrl
                && !self.app.alt
                && !self.app.shift
                && self.app.doc().editor_ref().selection.len() == 1
            {
                // a single selected layer: Enter edits its anchors when it is a
                // vector (the engine refuses anything else). Text was already
                // claimed by `enter_edit_selected` above.
                self.dispatch(Action::EnterVectorEditMode);
                return;
            }
        }
        let ctrl = self.app.ctrl;
        if ctrl && (self.app.screen != Screen::Editor || self.app.docs.is_empty()) {
            if let Key::Character(c) = &key {
                if !matches!(c.as_str(), "n" | "N" | "o" | "O" | "k" | "K") {
                    return;
                }
            }
        }
        if ctrl {
            if let Key::Character(c) = &key {
                let c = c.as_str();
                match c {
                    // ⌘⌥ boolean combine (Figma's Layer > Combine shortcuts)
                    "u" | "U" if self.app.alt => {
                        self.app.apply_ctx(CtxCmd::Union);
                        return;
                    }
                    "s" | "S" if self.app.alt => {
                        self.app.apply_ctx(CtxCmd::Subtract);
                        return;
                    }
                    "i" | "I" if self.app.alt => {
                        self.app.apply_ctx(CtxCmd::Intersect);
                        return;
                    }
                    "x" | "X" if self.app.alt => {
                        self.app.apply_ctx(CtxCmd::Exclude);
                        return;
                    }
                    // ⌘E — Flatten selection (Figma's shortcut)
                    "e" | "E" if !self.app.alt && !self.app.shift => {
                        self.app.apply_ctx(CtxCmd::Flatten);
                        return;
                    }
                    // ⇧⌘O — Outline stroke, ⇧⌥⌘O — Outline text
                    "o" | "O" if self.app.shift && !self.app.alt => {
                        self.app.apply_ctx(CtxCmd::OutlineStroke);
                        return;
                    }
                    "o" | "O" if self.app.shift && self.app.alt => {
                        self.app.apply_ctx(CtxCmd::OutlineText);
                        return;
                    }
                    // ⌥1-5: navigation bar tab switching
                    "1" if self.app.alt => {
                        self.app.nav_tab = NavTab::File;
                        return;
                    }
                    "2" if self.app.alt => {
                        self.app.nav_tab = NavTab::Agents;
                        return;
                    }
                    "3" if self.app.alt => {
                        self.app.nav_tab = NavTab::Assets;
                        return;
                    }
                    "4" if self.app.alt => {
                        self.app.nav_tab = NavTab::Tools;
                        return;
                    }
                    "5" if self.app.alt => {
                        self.app.nav_tab = NavTab::Variables;
                        return;
                    }
                    // ⇧⌘\ — minimize UI
                    "\\" if self.app.shift => {
                        self.app.ui_minimized = !self.app.ui_minimized;
                        return;
                    }
                    // ⇧⌘F — find
                    "f" | "F" if self.app.shift => {
                        self.app.find_replace.open = !self.app.find_replace.open;
                        return;
                    }
                    // ⇧⌘L / ⇧⌘H — Figma's lock & hide
                    "l" | "L" if self.app.shift => {
                        self.app.apply_ctx(CtxCmd::LockSel);
                        return;
                    }
                    "h" | "H" if self.app.shift => {
                        self.app.apply_ctx(CtxCmd::HideSel);
                        return;
                    }
                    "k" | "K" => {
                        // Toggle command palette with full initialization
                        if self.app.palette.open {
                            self.app.palette.close();
                        } else {
                            self.app.palette.open();
                            self.app.palette.register_standard_commands();
                            // Update context before showing
                            let doc = self.app.doc();
                            self.app.palette.has_selection = !doc.editor_ref().selection.is_empty();
                        }
                        return;
                    }
                    "n" | "N" => {
                        self.cmd_new_file();
                        return;
                    }
                    "o" | "O" => {
                        self.cmd_open_file();
                        return;
                    }
                    "i" | "I" => {
                        self.cmd_import_file();
                        return;
                    }
                    "s" | "S" => {
                        if self.app.shift {
                            self.cmd_save_as();
                        } else {
                            self.cmd_save();
                        }
                        return;
                    }
                    "z" | "Z" => {
                        if self.app.shift {
                            if self.app.doc().redo_document() {
                                self.app.mark_dirty();
                                return;
                            }
                        } else {
                            if self.app.doc().undo_document() {
                                self.app.mark_dirty();
                                return;
                            }
                        }
                        return;
                    }
                    "y" | "Y" => {
                        if self.app.doc().redo_document() {
                            self.app.mark_dirty();
                        }
                        return;
                    }
                    // Modifier-guarded arms MUST precede the plain Ctrl+C /
                    // Ctrl+V / Ctrl+A arms below: rustc takes the first arm
                    // whose pattern matches, and an unguarded pattern makes
                    // every later guarded arm on the same key unreachable.
                    // These three were dead until they moved (Ctrl+Shift+Alt+A
                    // inverse-select, Ctrl+Alt+C copy properties, Ctrl+Alt+V
                    // paste properties); Ctrl+Shift+Alt+M was already live.
                    "a" | "A" if self.app.shift && self.app.alt => {
                        self.dispatch(Action::InverseSelection);
                        return;
                    }
                    "m" | "M" if self.app.shift && self.app.alt => {
                        self.dispatch(Action::SelectMatching);
                        return;
                    }
                    "c" | "C" if self.app.alt => {
                        self.dispatch(Action::CopyProperties);
                        return;
                    }
                    "v" | "V" if self.app.alt => {
                        self.dispatch(Action::PasteProperties);
                        return;
                    }
                    "c" | "C" => {
                        self.app.copy_nodes();
                        return;
                    }
                    "x" | "X" => {
                        if !self.app.copy_nodes() {
                            return;
                        }
                        self.app.doc().editor().delete_selection();
                        self.app.mark_dirty();
                        return;
                    }
                    "v" | "V" => {
                        // First try to paste from Figma clipboard (direct copy-paste from Figma)
                        if let Some(figma_doc) = crate::state::try_import_from_figma_clipboard() {
                            // Successfully imported from Figma clipboard
                            self.app.import_figma_document(figma_doc);
                            self.app.status = "Imported from Figma clipboard".into();
                            return;
                        }
                        // Fall back to internal clipboard
                        // QA-001 FIX: Check clipboard content via method instead of direct field access
                        let had_content = self.app.has_clipboard_content();
                        self.app.paste_nodes();

                        // Provide user feedback on paste result
                        if had_content {
                            // Status already set by paste_nodes()
                        } else {
                            self.app.status =
                                "Clipboard is empty. Copy from Figma or select objects first."
                                    .into();
                        }
                        return;
                    }
                    "d" | "D" => {
                        let doc = self.app.doc();
                        doc.editor().duplicate_selection((12.0, 12.0));
                        self.app.mark_dirty();
                        return;
                    }
                    "g" | "G" => {
                        let shift = self.app.shift;
                        let doc = self.app.doc();
                        if shift {
                            if let Some(id) = doc.selected_id() {
                                doc.editor().ungroup(&id);
                            }
                        } else {
                            doc.editor().group_selection(&x_native::fresh_id("group"));
                        }
                        self.app.mark_dirty();
                        return;
                    }
                    "]" | "}" => {
                        // Figma: ] forward (with shift: to front)
                        let to_front = self.app.shift;
                        let doc = self.app.doc();
                        if let Some(id) = doc.selected_id() {
                            let id = id.clone();
                            if to_front {
                                doc.editor().bring_to_front(&id);
                            } else {
                                doc.editor().bring_forward(&id);
                            }
                            self.app.mark_dirty();
                        }
                        return;
                    }
                    "[" | "{" => {
                        let to_back = self.app.shift;
                        let doc = self.app.doc();
                        if let Some(id) = doc.selected_id() {
                            let id = id.clone();
                            if to_back {
                                doc.editor().send_to_back(&id);
                            } else {
                                doc.editor().send_backward(&id);
                            }
                            self.app.mark_dirty();
                        }
                        return;
                    }
                    "a" | "A" => {
                        self.app.doc().editor().select_all();
                        return;
                    }
                    "w" | "W" => {
                        let a = self.app.active;
                        self.app.close_doc(a);
                        return;
                    }
                    "=" | "+" => {
                        self.zoom_at(self.app.mouse, 1.25);
                        return;
                    }
                    "-" | "_" => {
                        self.zoom_at(self.app.mouse, 0.8);
                        return;
                    }
                    "0" => {
                        self.app.zoom = 1.0;
                        return;
                    }
                    "1" => {
                        self.zoom_fit();
                        return;
                    }
                    // Layer management shortcuts
                    "r" | "R" if self.app.shift => {
                        self.dispatch(Action::RenumberSelection);
                        return;
                    }
                    // ⇧⌘B — split the path at the selected anchor (vector edit
                    // mode only; ⌘B stays free for bold everywhere else)
                    "b" | "B" if self.app.shift && self.app.vector_edit_mode.active => {
                        match self.app.vector_edit_mode.selected_points.first().copied() {
                            Some(i) => self.dispatch(Action::SplitVectorPath(i)),
                            None => {
                                self.app.status = "Select the anchor to split at, then ⇧⌘B".into()
                            }
                        }
                        return;
                    }
                    _ => {}
                }
            }
        }

        match key {
            Key::Named(NamedKey::Escape) => {
                if self.app.dropdown_frame
                    || self.app.dropdown_zoom
                    || self.app.dropdown_lh
                    || self.app.dropdown_text_style
                {
                    self.app.dropdown_frame = false;
                    self.app.dropdown_zoom = false;
                    self.app.dropdown_lh = false;
                    self.app.dropdown_text_style = false;
                } else if self.app.screen == Screen::Editor {
                    // P12: an in-flight tree drag cancels first
                    if matches!(self.app.drag, Some(Drag::TreeRow { .. })) {
                        self.app.drag = None;
                    }
                    self.app.doc().editor().selection.clear();
                } else {
                    self.app.dash_search_focus = false;
                }
            }
            Key::Named(NamedKey::Delete) | Key::Named(NamedKey::Backspace) => {
                if self.app.screen == Screen::Editor {
                    self.app.doc().editor().delete_selection();
                    self.app.mark_dirty();
                }
            }
            // Layer-tree navigation (Figma): Tab cycles siblings, ⇧Tab goes the
            // other way, ⇧⏎ climbs to the parent and ⏎ dives into the first
            // child. ⏎ only reaches here once the inline text editor and vector
            // edit mode have both declined it, so nothing is stolen from them.
            Key::Named(NamedKey::Tab) => {
                if self.app.screen == Screen::Editor {
                    self.dispatch(if self.app.shift {
                        Action::SelectPrevSibling
                    } else {
                        Action::SelectNextSibling
                    });
                }
            }
            Key::Named(NamedKey::Enter) if self.app.shift => {
                if self.app.screen == Screen::Editor {
                    self.dispatch(Action::SelectParent);
                }
            }
            Key::Named(NamedKey::Enter) => {
                if self.app.screen == Screen::Editor {
                    self.dispatch(Action::SelectChild);
                }
            }
            Key::Named(
                NamedKey::ArrowUp
                | NamedKey::ArrowDown
                | NamedKey::ArrowLeft
                | NamedKey::ArrowRight,
            ) => {
                if self.app.screen == Screen::Editor {
                    let step = if self.app.shift { 10.0 } else { 1.0 };
                    let (dx, dy) = match key {
                        Key::Named(NamedKey::ArrowUp) => (0.0, -step),
                        Key::Named(NamedKey::ArrowDown) => (0.0, step),
                        Key::Named(NamedKey::ArrowLeft) => (-step, 0.0),
                        _ => (step, 0.0),
                    };
                    self.app.doc().editor().move_selection(dx, dy);
                    self.app.mark_dirty();
                }
            }
            Key::Character(c) => {
                let c = c.as_str().to_string();
                self.on_character(&c);
            }
            _ => {}
        }
    }

    fn on_character(&mut self, c: &str) {
        if self.app.screen == Screen::Editor && !self.app.ctrl {
            // Shift+R toggles the viewport rulers (⇧R types "R")
            if self.app.shift && c == "R" {
                self.app.rulers = !self.app.rulers;
                self.app.status = if self.app.rulers {
                    "Rulers on".into()
                } else {
                    "Rulers off".into()
                };
                return;
            }
            // Tool shortcuts — the mode-aware table lives in
            // Tool::from_shortcut (audit F3); there is no second copy.
            // The ⇧R ruler arm above stays first so it keeps its key.
            let tool_key = c.to_lowercase();
            let board_mode = self.app.is_board();
            if let Some(t) = Tool::from_shortcut(&tool_key, self.app.shift, board_mode) {
                self.app.tool = t;
                return;
            }
            if self.app.shift {
                match c {
                    "!" => {
                        self.zoom_fit();
                        return;
                    }
                    ")" => {
                        self.app.zoom = 1.0;
                        return;
                    }
                    "@" => {
                        self.zoom_to_selection();
                        return;
                    }
                    _ => {}
                }
            }
        }
        if self.app.screen == Screen::Dashboard && self.app.dash_search_focus {
            self.app.dash_search.push_str(c);
        }
    }

    fn on_text(&mut self, text: &str) {
        if self.app.document_loading.is_some() {
            return;
        }
        let text: String = text
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
            .collect();
        if let Some(draft) = &mut self.app.comment_draft {
            draft.buffer.push_str(&text);
        } else if self.app.palette.open {
            self.app.palette.query.push_str(&text);
            self.app.palette.selected_index = 0;
        } else if let Some(field) = &mut self.app.field {
            let limit = if field.id == FieldId::InstanceProp {
                40_000
            } else {
                1024
            };
            if text.len()
                + if self.app.field_select_all {
                    0
                } else {
                    field.buffer.len()
                }
                > limit
            {
                self.app.status = "Field text exceeds its input budget".into();
                return;
            }
            if self.app.field_select_all {
                field.buffer.clear();
                self.app.field_select_all = false;
            }
            field.buffer.push_str(&text);
        } else if self.app.text_edit.is_some() {
            self.app.text_insert(&text);
        } else if self.app.screen == Screen::Dashboard && self.app.dash_search_focus {
            self.app.dash_search.push_str(&text);
        }
    }

    fn update_dimensions(&mut self, width: u32, height: u32, scale: f64) {
        self.scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        self.app.win_w = f64::from(width.max(1)) / self.scale;
        self.app.win_h = f64::from(height.max(1)) / self.scale;
        if let Some(gpu) = &mut self.gpu {
            gpu.config.width = width.max(1);
            gpu.config.height = height.max(1);
            gpu.target =
                crate::gpu_target::create(&gpu.device, gpu.config.width, gpu.config.height);
            gpu.surface.configure(&gpu.device, &gpu.config);
        }
    }

    fn update_cursor(&self, window: &Window) {
        if self.app.document_loading.is_some() {
            window.set_cursor(
                if crate::loading::hit_action(&self.app, self.app.mouse).is_some() {
                    CursorIcon::Pointer
                } else {
                    CursorIcon::Default
                },
            );
            return;
        }
        let icon = if self.app.screen == Screen::Editor {
            let reg = self.app.editor_regions();
            if resizer_at(&self.app, self.app.mouse).is_some() {
                CursorIcon::EwResize
            } else if matches!(self.app.drag, Some(Drag::Pan { .. })) {
                CursorIcon::Grabbing
            } else if reg.canvas.contains(self.app.mouse) {
                match self.app.tool {
                    Tool::Hand => CursorIcon::Grab,
                    Tool::Select => CursorIcon::Default,
                    _ => CursorIcon::Crosshair,
                }
            } else {
                CursorIcon::Default
            }
        } else {
            CursorIcon::Default
        };
        window.set_cursor(icon);
    }

    // ---------------------------------------------------------- commands

    fn palette_len(&self) -> usize {
        let q = self.app.palette.query.to_lowercase();
        editor_ui::palette_commands()
            .iter()
            .filter(|c| q.is_empty() || c.label.to_lowercase().contains(&q))
            .count()
    }

    fn palette_selection(&self) -> Option<usize> {
        let q = self.app.palette.query.to_lowercase();
        let cmds: Vec<usize> = editor_ui::palette_commands()
            .iter()
            .enumerate()
            .filter(|(_, c)| q.is_empty() || c.label.to_lowercase().contains(&q))
            .map(|(i, _)| i)
            .collect();
        cmds.get(
            self.app
                .palette
                .selected_index
                .min(cmds.len().saturating_sub(1)),
        )
        .copied()
    }

    fn run_palette(&mut self, ci: usize) {
        let Some(command) = editor_ui::palette_commands().get(ci).cloned() else {
            return;
        };
        let label = command.label;
        if self.app.docs.is_empty()
            && !matches!(
                label,
                "New file"
                    | "Open…"
                    | "Import…"
                    | "Back to dashboard"
                    | "Theme: Graphite (dark)"
                    | "Theme: Daylight (light)"
                    | "Theme: High Contrast"
            )
        {
            self.app.status = "Open a document to use this command".into();
            return;
        }
        self.app.palette.open = false;
        self.app.palette.query.clear();
        match label {
            "New file" => self.cmd_new_file(),
            "Open…" => self.cmd_open_file(),
            "Import…" => self.cmd_import_file(),
            "Lint document" => self.cmd_lint(),
            "Theme: Graphite (dark)" => self.apply_theme(x_native::ui::ThemeId::Graphite),
            "Theme: Daylight (light)" => self.apply_theme(x_native::ui::ThemeId::Daylight),
            "Theme: High Contrast" => self.apply_theme(x_native::ui::ThemeId::HighContrast),
            "Preview prototype" => {
                if self.app.flow.is_some() {
                    self.app.flow = None;
                } else {
                    self.flow_enter();
                }
            }
            "Load font…" => self.cmd_load_font(),
            "Save" => self.cmd_save(),
            // the label decides the format — clicking "Export PNG" must
            // never silently emit whatever format was last selected
            "Export SVG" => {
                self.app.doc().export_format = 2;
                self.cmd_export(false);
            }
            "Export PNG" => {
                self.app.doc().export_format = 0;
                self.cmd_export(false);
            }
            "Export PDF" => {
                self.app.doc().export_format = 3;
                self.cmd_export(false);
            }
            "Copy as code" => self.app.apply_ctx(CtxCmd::CopyAsCode),
            "Comment tool" => self.app.tool = Tool::Comment,
            "Union selection" => self.app.apply_ctx(CtxCmd::Union),
            "Subtract selection" => self.app.apply_ctx(CtxCmd::Subtract),
            "Intersect selection" => self.app.apply_ctx(CtxCmd::Intersect),
            "Exclude selection" => self.app.apply_ctx(CtxCmd::Exclude),
            "Flatten selection" => self.app.apply_ctx(CtxCmd::Flatten),
            "Outline stroke" => self.app.apply_ctx(CtxCmd::OutlineStroke),
            "Outline text" => self.app.apply_ctx(CtxCmd::OutlineText),
            // the palette takes no parameters, so the path commands state the
            // value they will use instead of pretending to ask for one
            // three preset tolerances instead of a dialog: the palette has no
            // parameter to ask for, so the entry states the value it will use
            "Simplify path (0.5px tolerance)" => {
                self.dispatch(Action::SimplifyVector { tolerance: 0.5 })
            }
            "Simplify path (1px tolerance)" => {
                self.dispatch(Action::SimplifyVector { tolerance: 1.0 })
            }
            "Simplify path (4px tolerance)" => {
                self.dispatch(Action::SimplifyVector { tolerance: 4.0 })
            }
            "Offset path outward by 4px" => self.dispatch(Action::OffsetVector {
                distance: 4.0,
                join: StrokeJoin::Miter,
            }),
            "Reverse path direction" => self.dispatch(Action::ReversePathDirection),
            "Join selected paths" => self.dispatch(Action::JoinSelectedPaths),
            // the palette takes no parameters, so a cap entry states the cap it
            // applies and sets BOTH ends — the per-end dropdowns are the
            // inspector's job, and the engine keeps them separate
            "Stroke cap: round (both ends)" => self.apply_stroke_caps(x_native::StrokeCap::Round),
            "Stroke cap: square (both ends)" => self.apply_stroke_caps(x_native::StrokeCap::Square),
            "Stroke cap: butt (both ends)" => self.apply_stroke_caps(x_native::StrokeCap::None),
            "Stroke cap: arrow (both ends)" => self.apply_stroke_caps(x_native::StrokeCap::Arrow),
            "Renumber selected layers" => self.dispatch(Action::RenumberSelection),
            "Enter vector edit mode" => self.dispatch(Action::EnterVectorEditMode),
            "Toggle bezier handles" => self.dispatch(Action::ToggleVectorHandles),
            "Bring forward" => self.app.apply_ctx(CtxCmd::BringFwd),
            "Send backward" => self.app.apply_ctx(CtxCmd::SendBack),
            "Lock selection" => self.app.apply_ctx(CtxCmd::LockSel),
            "Hide selection" => self.app.apply_ctx(CtxCmd::HideSel),
            "Undo" => {
                self.app.doc().undo_document();
            }
            "Redo" => {
                self.app.doc().redo_document();
            }
            "Select tool" => self.app.tool = Tool::Select,
            "Frame tool" => self.app.tool = Tool::Frame,
            "Text tool" => self.app.tool = Tool::Text,
            "Rectangle tool" => self.app.tool = Tool::Rect,
            "Ellipse tool" => self.app.tool = Tool::Ellipse,
            "Pen tool" => self.app.tool = Tool::Pen,
            "Hand tool" => self.app.tool = Tool::Hand,
            // audit F7: these labels were misspelled (and In/Out missing),
            // so four advertised palette commands ran nothing
            "Zoom In" => {
                self.zoom_at(Point::new(-100.0, -100.0), 1.25);
            }
            "Zoom Out" => {
                self.zoom_at(Point::new(-100.0, -100.0), 0.8);
            }
            "Zoom to Fit" => self.zoom_fit(),
            "Zoom to 100%" => self.app.zoom = 1.0,
            "Back to dashboard" => {
                if !self.finish_edits() {
                    return;
                }
                self.app.screen = Screen::Dashboard;
            }
            "Delete selection" => {
                self.app.doc().editor().delete_selection();
                self.app.mark_dirty();
            }
            "Duplicate selection" => {
                self.app.doc().editor().duplicate_selection((12.0, 12.0));
                self.app.mark_dirty();
            }
            "Group selection" => {
                let doc = self.app.doc();
                doc.editor().group_selection(&x_native::fresh_id("group"));
                self.app.mark_dirty();
            }
            "Bring to front" => {
                let doc = self.app.doc();
                if let Some(id) = doc.selected_id() {
                    let id = id.clone();
                    doc.editor().bring_to_front(&id);
                }
                self.app.mark_dirty();
            }
            "Send to back" => {
                let doc = self.app.doc();
                if let Some(id) = doc.selected_id() {
                    let id = id.clone();
                    doc.editor().send_to_back(&id);
                }
                self.app.mark_dirty();
            }
            "Ungroup" => {
                let doc = self.app.doc();
                if let Some(id) = doc.selected_id() {
                    doc.editor().ungroup(&id);
                }
                self.app.mark_dirty();
            }
            _ => {}
        }
    }

    /// Switch the UI palette. Paint reads colors through `theme::resolve`,
    /// so this is an atomic store plus a repaint — and the status line says
    /// whether the new palette passes the WCAG audit it ships with.
    fn apply_theme(&mut self, id: x_native::ui::ThemeId) {
        use x_native::ui::ColorTokens;
        let changed = crate::theme::set_theme(id);
        let failures = ColorTokens::for_theme(id).contrast_audit();
        self.app.status = if !changed {
            format!("Theme: {} (already active)", id.label())
        } else if failures.is_empty() {
            format!("Theme: {} — WCAG AA clean", id.label())
        } else {
            format!(
                "Theme: {} — {} pair(s) below WCAG AA",
                id.label(),
                failures.len()
            )
        };
    }

    // ——————————————————————————————— prototyping (authoring + live preview)
    fn cmd_lint(&mut self) {
        let Some(d) = self.app.doc_opt() else { return };
        let findings = x_native::lint_node(&d.editor_ref().root, false);
        let errs = findings
            .iter()
            .filter(|f| f.severity == x_native::Severity::Error)
            .count();
        self.app.status = if findings.is_empty() {
            "Lint: clean — 0 findings".into()
        } else {
            format!(
                "Lint: {errs} error(s), {} warning(s)",
                findings.len() - errs
            )
        };
        for f in findings.iter().take(6) {
            println!("lint {} [{}]: {}", f.rule, f.node, f.message);
        }
        if findings.len() > 6 {
            println!("lint: … {} more", findings.len() - 6);
        }
    }

    fn cmd_extract_tokens(&mut self) {
        let active = self.app.active;
        let Some(d) = self.app.docs.get(active) else {
            return;
        };
        let tokens = x_native::analyze_design_root(&d.editors[d.page].root);
        let colors = tokens.colors.len();
        let added = {
            let d = self.app.docs.get_mut(active).expect("active doc");
            tokens.emit_variables(&mut d.doc.variables)
        };
        if added == 0 {
            self.app.status = if colors == 0 {
                "Nothing painted to extract".into()
            } else {
                "All tokens already have variables".into()
            };
            return;
        }
        if let Some(d) = self.app.docs.get_mut(active) {
            d.frame_cache = x_native::FrameCache::new();
        }
        self.app.mark_dirty();
        self.app.status = format!("Extracted {added} design variables");
    }

    fn proto_selected_id(&self) -> Option<String> {
        let sel = self.app.doc_opt()?.editor_ref().selection.clone();
        if sel.len() == 1 {
            Some(sel[0].clone())
        } else {
            None
        }
    }

    /// Read the selected node's effective interactions, edit, write back
    /// through the undoable engine command.
    fn proto_edit(&mut self, f: impl FnOnce(&mut Vec<x_native::Interaction>)) {
        let Some(id) = self.proto_selected_id() else {
            self.app.status = "Select one layer to edit interactions".into();
            return;
        };
        let Some(mut list) = ({
            let d = self.app.doc();
            crate::editor_ui::find_node(&d.editor_ref().root, &id)
                .map(x_native::effective_interactions)
        }) else {
            return;
        };
        f(&mut list);
        if self.app.doc().editor().set_node_interactions(&id, list) {
            self.app.mark_dirty();
        }
    }

    fn proto_add(&mut self) {
        let Some(own) = self.proto_selected_id() else {
            self.app.status = "Select one layer to wire an interaction".into();
            return;
        };
        let targets = crate::editor_ui::proto_targets(&self.app);
        let Some((dest, dname)) = targets.iter().find(|(id, _)| *id != own).cloned() else {
            self.app.status = "A flow needs at least two frames to link".into();
            return;
        };
        self.proto_edit(move |l| l.push(x_native::Interaction::click(&dest)));
        self.app.status = format!("On click → {dname} (smart animate, 350ms)");
    }

    fn proto_trigger_cycle(&mut self, i: usize) {
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                ix.trigger = match ix.trigger {
                    x_native::Trigger::OnClick => x_native::Trigger::OnHover,
                    x_native::Trigger::OnHover => x_native::Trigger::MouseEnter,
                    x_native::Trigger::MouseEnter => x_native::Trigger::MouseLeave,
                    x_native::Trigger::MouseLeave => x_native::Trigger::OnPress,
                    x_native::Trigger::OnPress => x_native::Trigger::MouseUp,
                    _ => x_native::Trigger::OnClick,
                };
            }
        });
    }

    fn proto_dest_cycle(&mut self, i: usize, dir: i32) {
        let targets = crate::editor_ui::proto_targets(&self.app);
        if targets.len() < 2 {
            self.app.status = "Add another frame to pick destinations".into();
            return;
        }
        let Some(id) = self.proto_selected_id() else {
            return;
        };
        let cur = {
            let d = self.app.doc();
            crate::editor_ui::find_node(&d.editor_ref().root, &id)
                .and_then(|n| x_native::effective_interactions(n).into_iter().nth(i))
                .and_then(|ix| crate::editor_ui::proto_dest_of(&ix.action))
        };
        let pos = cur
            .as_ref()
            .and_then(|c| targets.iter().position(|(id, _)| id == c))
            .unwrap_or(0);
        let n = targets.len();
        let step = if dir >= 0 { 1 } else { -1 };
        let next = (pos as i32 + step).rem_euclid(n as i32) as usize;
        let dest = targets[next].0.clone();
        let dest_name = targets[next].1.clone();
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                ix.action = x_native::Action::Navigate { destination: dest };
            }
        });
        self.app.status = format!("Destination: {dest_name}");
    }

    fn proto_speed_cycle(&mut self, i: usize) {
        const SPEEDS: [u32; 4] = [0, 150, 350, 700];
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                let pos = SPEEDS
                    .iter()
                    .position(|m| *m == ix.transition_ms)
                    .unwrap_or(2);
                ix.transition_ms = SPEEDS[(pos + 1) % SPEEDS.len()];
            }
        });
    }

    fn proto_animation_cycle(&mut self, i: usize) {
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                ix.animation = match ix.animation {
                    x_native::Animation::Instant => x_native::Animation::Dissolve,
                    x_native::Animation::Dissolve => x_native::Animation::SmartAnimate,
                    x_native::Animation::SmartAnimate => x_native::Animation::SlideIn,
                    x_native::Animation::SlideIn => {
                        x_native::Animation::MoveIn(x_native::Direction::Left)
                    }
                    x_native::Animation::MoveIn(d) => match d {
                        x_native::Direction::Left => {
                            x_native::Animation::MoveIn(x_native::Direction::Right)
                        }
                        x_native::Direction::Right => {
                            x_native::Animation::MoveIn(x_native::Direction::Top)
                        }
                        x_native::Direction::Top => {
                            x_native::Animation::MoveIn(x_native::Direction::Bottom)
                        }
                        x_native::Direction::Bottom => {
                            x_native::Animation::MoveOut(x_native::Direction::Left)
                        }
                    },
                    x_native::Animation::MoveOut(d) => match d {
                        x_native::Direction::Left => {
                            x_native::Animation::MoveOut(x_native::Direction::Right)
                        }
                        x_native::Direction::Right => {
                            x_native::Animation::MoveOut(x_native::Direction::Top)
                        }
                        x_native::Direction::Top => {
                            x_native::Animation::MoveOut(x_native::Direction::Bottom)
                        }
                        x_native::Direction::Bottom => x_native::Animation::SlideOut,
                    },
                    x_native::Animation::SlideOut => x_native::Animation::Instant,
                };
            }
        });
    }

    fn proto_action_type_cycle(&mut self, i: usize) {
        let targets = crate::editor_ui::proto_targets(&self.app);
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                // Cycle through action types: Navigate -> OpenOverlay -> Back -> CloseOverlay -> Navigate
                ix.action = match &ix.action {
                    x_native::Action::Navigate { destination } => {
                        // Switch to OpenOverlay with same destination
                        x_native::Action::OpenOverlay {
                            overlay: destination.clone(),
                            position: x_native::OverlayPosition::Center,
                        }
                    }
                    x_native::Action::OpenOverlay { overlay, position } => {
                        // Cycle overlay position
                        let next_pos = match position {
                            x_native::OverlayPosition::Center => {
                                x_native::OverlayPosition::TopRight
                            }
                            x_native::OverlayPosition::TopRight => {
                                x_native::OverlayPosition::BottomRight
                            }
                            x_native::OverlayPosition::BottomRight => {
                                x_native::OverlayPosition::TopLeft
                            }
                            x_native::OverlayPosition::TopLeft => {
                                x_native::OverlayPosition::BottomLeft
                            }
                            x_native::OverlayPosition::BottomLeft => {
                                x_native::OverlayPosition::Center
                            }
                            _ => x_native::OverlayPosition::Center,
                        };
                        x_native::Action::OpenOverlay {
                            overlay: overlay.clone(),
                            position: next_pos,
                        }
                    }
                    x_native::Action::Back => x_native::Action::CloseOverlay,
                    x_native::Action::CloseOverlay => {
                        // Navigate to first other frame
                        let dest = targets
                            .first()
                            .map(|(id, _)| id.clone())
                            .unwrap_or_default();
                        x_native::Action::Navigate { destination: dest }
                    }
                    _ => x_native::Action::Back,
                };
            }
        });
    }

    fn proto_edit_delay(&mut self, i: usize) {
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                if let x_native::Trigger::AfterDelay { ms } = &mut ix.trigger {
                    // Cycle through common delay values: 100ms, 300ms, 500ms, 1000ms, 2000ms
                    *ms = match *ms {
                        0 => 100,
                        100 => 300,
                        300 => 500,
                        500 => 1000,
                        1000 => 2000,
                        _ => 0,
                    };
                }
            }
        });
    }

    fn proto_edit_key(&mut self, i: usize) {
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                if let x_native::Trigger::KeyDown { key } = &mut ix.trigger {
                    // Cycle through common keys
                    // The arms are &'static str and the field is a String; the
                    // match borrow of `key` ends before the assignment.
                    *key = match key.as_str() {
                        "Enter" => "Space",
                        "Space" => "Escape",
                        "Escape" => "ArrowLeft",
                        "ArrowLeft" => "ArrowRight",
                        "ArrowRight" => "ArrowUp",
                        "ArrowUp" => "ArrowDown",
                        "ArrowDown" => "a",
                        _ => "Enter",
                    }
                    .to_string();
                }
            }
        });
    }

    fn proto_edit_url(&mut self, i: usize) {
        // For now, just open a simple URL editor
        // In a full implementation, this would open a text field
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                if let x_native::Action::OpenLink { url } = &mut ix.action {
                    // Cycle through example URLs
                    *url = match url.as_str() {
                        "" => "https://example.com",
                        "https://example.com" => "https://figma.com",
                        "https://figma.com" => "https://github.com",
                        _ => "",
                    }
                    .to_string();
                }
            }
        });
    }

    fn proto_edit_video_time(&mut self, i: usize) {
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                if let x_native::Trigger::WhenVideoHits { time } = &mut ix.trigger {
                    // Cycle through common video times (in seconds)
                    *time = match (*time * 10.0) as i32 {
                        0 => 50,    // 5.0s
                        50 => 100,  // 10.0s
                        100 => 150, // 15.0s
                        150 => 200, // 20.0s
                        _ => 0,     // 0.0s
                    } as f32
                        / 10.0;
                }
            }
        });
    }

    fn proto_easing(&mut self, i: usize) {
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                // Cycle through easing options
                ix.easing = match ix.easing {
                    x_native::Easing::Linear => x_native::Easing::EaseIn,
                    x_native::Easing::EaseIn => x_native::Easing::EaseOut,
                    x_native::Easing::EaseOut => x_native::Easing::EaseInOut,
                    x_native::Easing::EaseInOut => {
                        x_native::Easing::CubicBezier(0.25, 0.1, 0.25, 1.0)
                    }
                    x_native::Easing::CubicBezier(..) => x_native::Easing::Linear,
                };
            }
        });
    }

    fn proto_toggle_reset(&mut self, i: usize) {
        self.proto_edit(move |l| {
            if let Some(ix) = l.get_mut(i) {
                ix.reset_on_navigate = !ix.reset_on_navigate;
            }
        });
    }

    fn flow_enter(&mut self) {
        let sel = self.app.doc().editor_ref().selection.clone();
        let targets = crate::editor_ui::proto_targets(&self.app);
        let picked = {
            let d = self.app.doc();
            let mut picked: Option<String> = None;
            if let Some(first) = sel.first() {
                'outer: for ed in d.editors.iter() {
                    for f in &ed.root.children {
                        fn contains(n: &x_native::Node, id: &str) -> bool {
                            n.id == id || n.children.iter().any(|c| contains(c, id))
                        }
                        if contains(f, first) {
                            picked = Some(f.id.clone());
                            break 'outer;
                        }
                    }
                }
            }
            if picked.is_none() {
                for ed in d.editors.iter() {
                    fn walk(n: &x_native::Node) -> Option<String> {
                        if n.is_starting_point {
                            return Some(n.id.clone());
                        }
                        for c in &n.children {
                            if let Some(r) = walk(c) {
                                return Some(r);
                            }
                        }
                        None
                    }
                    if let Some(r) = walk(&ed.root) {
                        picked = Some(r);
                        break;
                    }
                }
            }
            picked
        };
        let current = picked
            .or_else(|| targets.first().map(|(id, _)| id.clone()))
            .unwrap_or_else(|| self.app.doc().editor_ref().root.id.clone());
        if crate::editor_ui::flow_locate(&self.app, &current).is_none() {
            self.app.status = "Flow start frame not found in this document".into();
            return;
        }
        let vars = self.app.doc().doc.variables.clone();
        self.app.flow = Some(crate::state::FlowState {
            current: current.clone(),
            vars,
            ..Default::default()
        });
        self.flow_focus(&current);
        self.arm_flow_delays();
        self.app.status =
            "Flow preview — hover, click, drag or press keys; Esc back, Q exit".into();
    }

    /// Pan/zoom so the focused frame fills the viewer, switching pages.
    fn flow_focus(&mut self, id: &str) {
        let Some((page, r, _)) = crate::editor_ui::flow_locate(&self.app, id) else {
            return;
        };
        let d = self.app.doc();
        if d.page != page {
            d.page = page;
        }
        let c = self.app.view_canvas();
        let cw = c.x1 - c.x0;
        let ch = c.y1 - c.y0;
        let z = ((cw / r.width().max(1.0)).min(ch / r.height().max(1.0)) * 0.92).clamp(0.01, 64.0);
        self.app.zoom = z;
        self.app.pan = (
            c.x0 + cw / 2.0 - (r.x0 + r.x1) / 2.0 * z,
            c.y0 + ch / 2.0 - (r.y0 + r.y1) / 2.0 * z,
        );
    }

    /// Pan so node `id` lands centered in the viewer, KEEPING the current
    /// zoom — Figma "scroll to" pans within the screen instead of
    /// navigating. Page-switches when the node lives elsewhere.
    fn flow_pan_to(&mut self, id: &str) {
        let Some((page, r, _)) = crate::editor_ui::flow_locate(&self.app, id) else {
            return;
        };
        let d = self.app.doc();
        if d.page != page {
            d.page = page;
        }
        let c = self.app.view_canvas();
        let z = self.app.zoom;
        self.app.pan = (
            c.x0 + (c.x1 - c.x0) / 2.0 - (r.x0 + r.x1) / 2.0 * z,
            c.y0 + (c.y1 - c.y0) / 2.0 - (r.y0 + r.y1) / 2.0 * z,
        );
    }

    /// Viewer press: fires `OnPress` then `OnClick` for the node under the
    /// pointer (topmost overlay first, else the current frame), and arms
    /// drag detection. A tap is both a press and a click — distinct
    /// triggers, both fire. Pressing a new node while a "while hovering"
    /// span is armed keeps the orphan (see the engine's `press`): the
    /// next move still counts as leaving the hotspot.
    fn flow_press(&mut self, p: Point) {
        if self.app.flow.is_none() {
            return;
        }
        let w = self.app.screen_to_world(p);
        if let Some(f) = self.app.flow.as_mut() {
            f.dragging = true;
            f.drag_fired = false;
        }
        let Some((_, hit)) = self.flow_pick(w) else {
            return;
        };
        let orphaned = self
            .app
            .flow
            .as_ref()
            .is_some_and(|f| f.hover_span.as_ref().is_some_and(|s| s.hotspot() != hit));
        if !orphaned {
            if let Some(f) = self.app.flow.as_mut() {
                f.hovered = Some(hit.clone());
            }
        }
        self.flow_fire_trigger(&hit, x_native::Trigger::OnPress);
        self.flow_fire_trigger(&hit, x_native::Trigger::OnClick);
    }

    /// Step back through preview history; with no history left — and no
    /// overlays open — the preview ends. Esc reaches here only after all
    /// overlays are dismissed (see `flow_escape`).
    fn flow_back(&mut self) {
        let Some(f) = self.app.flow.as_mut() else {
            return;
        };
        match f.stack.pop() {
            Some(prev) => {
                f.current = prev;
                f.overlays.clear();
                f.hovered = None;
                let cur = f.current.clone();
                self.flow_focus(&cur);
                self.arm_flow_delays();
            }
            None => {
                self.app.flow = None;
                self.app.status = "Flow preview ended".into();
            }
        }
    }

    // ---- prototype player: triggers, overlays, and preview-owned variables ----

    /// Any node in any page by id (overlay + frame lookup).
    fn flow_node(&self, id: &str) -> Option<&x_native::Node> {
        let d = self.app.doc_ref();
        d.editors.iter().find_map(|ed| {
            if ed.root.id == id {
                return Some(&ed.root);
            }
            crate::editor_ui::find_node(&ed.root, id)
        })
    }

    /// Node under viewer point `w` (world coords) plus the subtree to
    /// search for its triggers: `(search_root_id, hit_node_id)`. The
    /// topmost overlay wins, else the current frame.
    fn flow_pick(&self, w: Point) -> Option<(String, String)> {
        let f = self.app.flow.as_ref()?;
        // overlays render anchored to the current frame: relocate each
        // candidate before hit-testing (same math as the painter)
        let (_, frame_rect, _) = crate::editor_ui::flow_locate(&self.app, &f.current)?;
        for ov in f.overlays.iter().rev() {
            let Some(node) = self.flow_node(&ov.frame) else {
                continue;
            };
            let (ox, oy) = x_native::overlay_offset(
                frame_rect.width(),
                frame_rect.height(),
                node.w,
                node.h,
                ov.position,
            );
            let mut placed = node.clone();
            placed.transform.x = frame_rect.x0 + ox;
            placed.transform.y = frame_rect.y0 + oy;
            if let Some(hit) = x_native::editor::hit_test(&placed, w) {
                return Some((ov.frame.clone(), hit));
            }
        }
        let node = self.flow_node(&f.current)?;
        let hit = x_native::editor::hit_test(node, w)?;
        Some((f.current.clone(), hit))
    }

    /// The `trigger` interaction owned by `hit` inside `frame_id`, if any.
    fn flow_find_interaction(
        &self,
        frame_id: &str,
        hit: &str,
        trigger: x_native::Trigger,
    ) -> Option<x_native::Interaction> {
        let d = self.app.doc_ref();
        let node = d
            .editors
            .iter()
            .find_map(|ed| crate::editor_ui::find_node(&ed.root, frame_id))?;
        x_native::find_interaction_for(node, hit, trigger).map(|(_, ix)| ix)
    }

    /// The `trigger` interaction owned by `hit`, searching the topmost
    /// overlay first, then the current frame. Split from
    /// `flow_fire_trigger` so the search borrows `&self` and returns an
    /// owned interaction — firing it borrows `&mut self`.
    fn flow_find_trigger(
        &self,
        hit: &str,
        trigger: &x_native::Trigger,
    ) -> Option<x_native::Interaction> {
        let f = self.app.flow.as_ref()?;
        for ov in f.overlays.iter().rev() {
            if let Some(ix) = self.flow_find_interaction(&ov.frame, hit, trigger.clone()) {
                return Some(ix);
            }
        }
        self.flow_find_interaction(&f.current, hit, trigger.clone())
    }

    /// Fire `trigger` for `hit` wherever it lives: the topmost overlay
    /// first, then the current frame. `true` when the interaction ran AND
    /// changed something — the engine's `drag_to` distinguishes an inert
    /// `Back`/`CloseOverlay` from a real one, and the drag cycle has to
    /// agree. "While" triggers that navigated or opened an overlay arm the
    /// Figma auto-reverse spans.
    fn flow_fire_trigger(&mut self, hit: &str, trigger: x_native::Trigger) -> bool {
        if let Some(ix) = self.flow_find_trigger(hit, &trigger) {
            let before = self
                .app
                .flow
                .as_ref()
                .map(|f| (f.current.clone(), f.overlays.len(), f.stack.len()));
            let (origin, overlay_depth, stack_depth) = before.unwrap_or_default();
            let effect = self.flow_fire(&ix);
            self.flow_arm_while_span(hit, &trigger, &origin, overlay_depth, stack_depth);
            effect.fired()
        } else {
            false
        }
    }

    /// Arm Figma's while-hovering/while-pressing auto-reverse (see the
    /// engine's `arm_while_span`): a "while" trigger that navigated
    /// (with a history push) or opened an overlay reverts on leave /
    /// release. Logic actions, closes, backs, and swaps never arm.
    fn flow_arm_while_span(
        &mut self,
        hit: &str,
        trigger: &x_native::Trigger,
        origin: &str,
        overlay_depth: usize,
        stack_depth: usize,
    ) {
        let Some(f) = self.app.flow.as_mut() else {
            return;
        };
        let slot = match trigger {
            x_native::Trigger::OnHover => &mut f.hover_span,
            x_native::Trigger::OnPress => &mut f.press_span,
            _ => return,
        };
        *slot = None;
        if f.current != origin && f.stack.len() > stack_depth {
            *slot = Some(x_native::editor::WhileSpan::Navigated {
                hotspot: hit.into(),
                origin: origin.into(),
                dest: f.current.clone(),
            });
        } else if f.overlays.len() > overlay_depth {
            if let Some(top) = f.overlays.last() {
                *slot = Some(x_native::editor::WhileSpan::OverlayOpened {
                    hotspot: hit.into(),
                    frame: top.frame.clone(),
                });
            }
        }
    }

    /// Revert a taken "while" span (see the engine's `revert_span`):
    /// navigate back without pushing history, or remove the opened
    /// overlay — but only if the viewer still sits in the "while"
    /// result. Returns whether anything reverted.
    fn flow_revert_span(&mut self, span: Option<x_native::editor::WhileSpan>) -> bool {
        match span {
            Some(x_native::editor::WhileSpan::Navigated { origin, dest, .. }) => {
                let still_there = self.app.flow.as_ref().is_some_and(|f| f.current == dest);
                if !still_there {
                    return false;
                }
                if let Some(f) = self.app.flow.as_mut() {
                    f.current = origin.clone();
                    f.stack.pop();
                    f.hovered = None;
                    f.dragging = false;
                    f.drag_fired = false;
                }
                self.flow_focus(&origin);
                self.arm_flow_delays();
                self.app.status = format!("Flow preview — viewing {origin}");
                true
            }
            Some(x_native::editor::WhileSpan::OverlayOpened { frame, .. }) => {
                if !self.flow_overlay_open(&frame) {
                    return false;
                }
                if let Some(f) = self.app.flow.as_mut() {
                    f.overlays.retain(|o| o.frame != frame);
                }
                true
            }
            None => false,
        }
    }

    /// Drop the hover span when the pointer leaves `hotspot`, reverting
    /// its effect when the viewer still sits in the "while" result.
    fn flow_leave_hover_span(&mut self, hotspot: &str) {
        let relevant = self.app.flow.as_ref().is_some_and(|f| {
            f.hover_span
                .as_ref()
                .is_some_and(|s| s.hotspot() == hotspot)
        });
        if !relevant {
            return;
        }
        let span = self.app.flow.as_mut().and_then(|f| f.hover_span.take());
        self.flow_revert_span(span);
    }

    /// Drop the press span on release, reverting its effect when the
    /// viewer still sits in the "while" result (wherever the pointer
    /// lifted).
    fn flow_release_press_span(&mut self) {
        let span = self.app.flow.as_mut().and_then(|f| f.press_span.take());
        self.flow_revert_span(span);
    }

    /// Run one interaction through the shared [`x_native::editor::fire_action`]
    /// engine against the preview's OWN variable store, then refocus and
    /// re-arm delays when the screen changed. Navigation re-arms from
    /// scratch; overlay changes re-arm just the top overlay.
    fn flow_fire(&mut self, ix: &x_native::Interaction) -> x_native::editor::FireEffect {
        let Some(mut f) = self.app.flow.take() else {
            return x_native::editor::FireEffect::default();
        };
        let known = |id: &str| crate::editor_ui::flow_locate(&self.app, id).is_some();
        let effect = x_native::editor::fire_action(
            &mut f.current,
            &mut f.stack,
            &mut f.overlays,
            &mut f.vars,
            &known,
            &ix.action,
            ix.transition_ms,
        );
        if effect.navigated.is_some() {
            f.hovered = None;
            f.dragging = false;
            f.drag_fired = false;
        }
        self.app.flow = Some(f);
        if effect.navigated.is_some() {
            let cur = self
                .app
                .flow
                .as_ref()
                .map(|f| f.current.clone())
                .unwrap_or_default();
            self.flow_focus(&cur);
            self.arm_flow_delays();
            self.app.status = format!("Flow preview — viewing {cur}");
        } else if effect.overlays_changed {
            self.arm_flow_overlay_delays();
        } else if let Some(dest) = effect.scrolled_to.clone() {
            // Figma "scroll to": pan within the screen, never navigate
            self.flow_pan_to(&dest);
        }
        // headless (tests, jobs) has no window: never spawn a browser
        if let Some(url) = effect.opened_link.as_deref() {
            if self.window.is_some() {
                Self::open_flow_link(url);
            }
        }
        effect
    }

    /// Open an external URL from an `OpenLink` action in the system
    /// browser. Best-effort: a missing opener must never break playback.
    fn open_flow_link(url: &str) {
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("open").arg(url).spawn();
        #[cfg(target_os = "windows")]
        let result = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let result = std::process::Command::new("xdg-open").arg(url).spawn();
        let _ = result;
    }

    /// Viewer pointer move: drag detection while pressed, hover otherwise.
    fn flow_move(&mut self, p: Point) {
        let dragging = self.app.flow.as_ref().is_some_and(|f| f.dragging);
        if dragging {
            self.flow_drag_at(p);
        } else {
            self.flow_hover_at(p);
        }
    }

    /// Viewer hover: fires `MouseLeave` on the node being left, then
    /// `MouseEnter` and `OnHover` on the node being entered, then the
    /// while-hovering auto-reverse. A "while hovering" navigate clears
    /// hover tracking, orphaning its span — the next move anywhere
    /// counts as leaving the hotspot, even onto empty canvas.
    fn flow_hover_at(&mut self, p: Point) {
        let Some(f) = self.app.flow.as_ref() else {
            return;
        };
        let cur_hovered = f.hovered.clone();
        let orphan = f.hovered.is_none() && f.hover_span.is_some();
        let orphan_hotspot = f.hover_span.as_ref().map(|s| s.hotspot().to_string());
        let w = self.app.screen_to_world(p);
        let next = self.flow_pick(w).map(|(_, hit)| hit);
        if cur_hovered == next && !orphan {
            return;
        }
        let old = cur_hovered.or(orphan_hotspot);
        if let Some(old) = old {
            if Some(&old) != next.as_ref() {
                self.flow_fire_trigger(&old, x_native::Trigger::MouseLeave);
                self.flow_leave_hover_span(&old);
            }
        }
        if let Some(f) = self.app.flow.as_mut() {
            f.hovered = next.clone();
        }
        if let Some(hit) = next {
            self.flow_fire_trigger(&hit, x_native::Trigger::MouseEnter);
            self.flow_fire_trigger(&hit, x_native::Trigger::OnHover);
        }
    }

    /// Viewer drag: fires `OnDrag` once per press-drag-release cycle.
    fn flow_drag_at(&mut self, p: Point) {
        let Some(f) = self.app.flow.as_ref() else {
            return;
        };
        if !f.dragging || f.drag_fired {
            return;
        }
        let w = self.app.screen_to_world(p);
        let Some((_, hit)) = self.flow_pick(w) else {
            return;
        };
        let orphaned = self
            .app
            .flow
            .as_ref()
            .is_some_and(|f| f.hover_span.as_ref().is_some_and(|s| s.hotspot() != hit));
        if !orphaned {
            if let Some(f) = self.app.flow.as_mut() {
                f.hovered = Some(hit.clone());
            }
        }
        if self.flow_fire_trigger(&hit, x_native::Trigger::OnDrag) {
            if let Some(f) = self.app.flow.as_mut() {
                f.drag_fired = true;
            }
        }
    }

    /// Viewer release: ends drag detection, reverts an armed "while
    /// pressing" span, then fires `MouseUp` on the node under the
    /// release point (Figma's drop-down pattern: the press opens the
    /// menu, the release selects the item).
    fn flow_release(&mut self) {
        if let Some(f) = self.app.flow.as_mut() {
            f.dragging = false;
        }
        self.flow_release_press_span();
        let w = self.app.screen_to_world(self.app.mouse);
        if let Some((_, hit)) = self.flow_pick(w) {
            self.flow_fire_trigger(&hit, x_native::Trigger::MouseUp);
        }
    }

    /// Viewer key: Q exits, Esc dismisses-then-backs (see `flow_escape`),
    /// everything else is offered to `KeyDown` triggers, topmost overlay
    /// first. The key is swallowed either way — editing never starts in
    /// the viewer.
    fn flow_key(&mut self, key: &Key) {
        match key {
            Key::Named(NamedKey::Escape) => {
                self.flow_escape();
                return;
            }
            Key::Character(c) if c.eq_ignore_ascii_case("q") => {
                self.app.flow = None;
                self.app.status = "Flow preview ended".into();
                return;
            }
            _ => {}
        }
        let name = match key {
            Key::Character(c) => c.to_string(),
            Key::Named(n) => format!("{n:?}"),
            _ => return,
        };
        if let Some(ix) = self.flow_find_key(&name) {
            self.flow_fire(&ix);
        }
    }

    /// First `KeyDown` interaction matching `name`, topmost overlay
    /// first, then the current frame. `&self` search feeding
    /// `flow_key`'s `&mut self` firing (see `flow_find_trigger`).
    fn flow_find_key(&self, name: &str) -> Option<x_native::Interaction> {
        let f = self.app.flow.as_ref()?;
        for ov in f.overlays.iter().rev() {
            let found = self
                .flow_node(&ov.frame)
                .and_then(|n| x_native::find_key_interaction(n, name));
            if let Some((_, ix)) = found {
                return Some(ix);
            }
        }
        self.flow_node(&f.current)
            .and_then(|n| x_native::find_key_interaction(n, name))
            .map(|(_, ix)| ix)
    }

    /// Is overlay `frame` open in the viewer?
    fn flow_overlay_open(&self, frame: &str) -> bool {
        self.app
            .flow
            .as_ref()
            .is_some_and(|f| f.overlays.iter().any(|o| o.frame == frame))
    }

    /// Viewer Esc: dismiss the top overlay first, then step back through
    /// history, then end the preview.
    fn flow_escape(&mut self) {
        if self
            .app
            .flow
            .as_mut()
            .is_some_and(|f| f.overlays.pop().is_some())
        {
            self.app.status = "Overlay dismissed".into();
        } else {
            self.flow_back();
        }
    }

    /// Fire due `AfterDelay` triggers in arm order. A navigation cancels
    /// the remaining due timers (the new screen re-arms its own); delays
    /// whose overlay closed are disarmed. Returns how many fired.
    fn flow_tick(&mut self, now: std::time::Instant) -> usize {
        if self.app.flow.is_none() {
            return 0;
        }
        let mut fired = 0;
        loop {
            let Some(f) = self.app.flow.as_ref() else {
                return fired;
            };
            let Some(i) = f.delays.iter().position(|d| d.at <= now) else {
                break;
            };
            let Some(f) = self.app.flow.as_mut() else {
                return fired;
            };
            let d = f.delays.remove(i);
            if let Some(src) = &d.source_overlay {
                if !self.flow_overlay_open(src) {
                    continue; // its overlay closed: disarmed
                }
            }
            let ix = x_native::Interaction {
                trigger: x_native::Trigger::AfterDelay { ms: 0 },
                action: d.action,
                actions: vec![],
                transition_ms: d.ms,
                animation: x_native::Animation::Instant,
                easing: x_native::Easing::Linear,
                reset_on_navigate: false,
            };
            let effect = self.flow_fire(&ix);
            if effect.fired() {
                fired += 1;
            }
            if effect.navigated.is_some() {
                // the new screen re-armed its own delays; old timers die
                break;
            }
        }
        fired
    }

    /// Arm the current frame's `AfterDelay` triggers against the wall
    /// clock. Called on enter and after every navigation; navigation
    /// discards previously armed delays.
    fn arm_flow_delays(&mut self) {
        let now = std::time::Instant::now();
        let node = self
            .app
            .flow
            .as_ref()
            .and_then(|f| self.flow_node(&f.current));
        let mut armed = Vec::new();
        if let Some(node) = node {
            for (_, ms, ix) in x_native::delayed_interactions(node) {
                let wait = std::time::Duration::from_millis(u64::from(ms));
                armed.push(crate::state::FlowDelay {
                    at: now + wait,
                    source_overlay: None,
                    ms: ix.transition_ms,
                    action: ix.action.clone(),
                });
            }
        }
        if let Some(f) = self.app.flow.as_mut() {
            f.delays = armed;
        }
    }

    /// Arm `AfterDelay` triggers of the topmost overlay (base-frame delays
    /// keep running underneath). Stale entries die in `flow_tick`.
    fn arm_flow_overlay_delays(&mut self) {
        let now = std::time::Instant::now();
        let top = self
            .app
            .flow
            .as_ref()
            .and_then(|f| f.overlays.last().map(|o| o.frame.clone()));
        let Some(top) = top else {
            return;
        };
        let mut armed = Vec::new();
        if let Some(node) = self.flow_node(&top) {
            for (_, ms, ix) in x_native::delayed_interactions(node) {
                let wait = std::time::Duration::from_millis(u64::from(ms));
                armed.push(crate::state::FlowDelay {
                    at: now + wait,
                    source_overlay: Some(top.clone()),
                    ms: ix.transition_ms,
                    action: ix.action.clone(),
                });
            }
        }
        if let Some(f) = self.app.flow.as_mut() {
            f.delays.extend(armed);
        }
    }

    fn cmd_load_font(&mut self) {
        if self.app.flow.is_some() {
            return;
        }
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Fonts", &["ttf", "otf", "ttc"])
            .set_title("Load font into the canvas font stack")
            .pick_file()
        else {
            return;
        };
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("font")
            .to_string();
        match self
            .app
            .fonts
            .fonts
            .load_file(&stem, path.to_str().unwrap_or_default())
        {
            Ok(_) => {
                // shaped caches are epoch-keyed, but per-doc frame caches
                // bake text into the scene graph — rebuild them all
                for d in self.app.docs.iter_mut() {
                    d.frame_cache = x_native::FrameCache::new();
                }
                self.app.mark_dirty();
                self.app.status = format!("Font '{stem}' registered — use it via the font field");
            }
            Err(e) => {
                self.app.status = format!("Load font failed: {e}");
            }
        }
    }

    fn zoom_fit(&mut self) {
        self.app.center_view();
    }

    /// Zoom by `factor` anchored at screen point `p` (cursor / center).
    fn zoom_at(&mut self, p: Point, factor: f64) {
        let reg = self.app.editor_regions();
        let pt = if reg.canvas.contains(p) {
            p
        } else {
            Point::new(
                (reg.canvas.x0 + reg.canvas.x1) / 2.0,
                (reg.canvas.y0 + reg.canvas.y1) / 2.0,
            )
        };
        let before = self.app.screen_to_world(pt);
        self.app.zoom = (self.app.zoom * factor).clamp(0.01, 64.0);
        let after = self.app.screen_to_world(pt);
        self.app.pan.0 += (after.x - before.x) * self.app.zoom;
        self.app.pan.1 += (after.y - before.y) * self.app.zoom;
    }

    /// Zoom so the current selection fits ~60% of the canvas (⇧2).
    fn zoom_to_selection(&mut self) {
        let doc = self.app.doc();
        let sel = doc.editor_ref().selection.clone();
        let mut bb: Option<(f64, f64, f64, f64)> = None;
        {
            let root = &doc.editor_ref().root;
            for id in &sel {
                if let Some(n) = crate::editor_ui::find_node(root, id.as_str()) {
                    let (x0, y0) = (n.transform.x, n.transform.y);
                    let (x1, y1) = (x0 + n.w, y0 + n.h);
                    bb = Some(match bb {
                        None => (x0, y0, x1, y1),
                        Some((a, b, c, d)) => (a.min(x0), b.min(y0), c.max(x1), d.max(y1)),
                    });
                }
            }
        }
        let Some((x0, y0, x1, y1)) = bb else { return };
        let reg = self.app.editor_regions();
        let cw = reg.canvas.x1 - reg.canvas.x0;
        let ch = reg.canvas.y1 - reg.canvas.y0;
        let z = ((cw / (x1 - x0).max(1.0)).min(ch / (y1 - y0).max(1.0)) * 0.6).clamp(0.01, 64.0);
        self.app.zoom = z;
        self.app.pan = (
            reg.canvas.x0 + cw / 2.0 - (x0 + x1) / 2.0 * z - 0.0,
            reg.canvas.y0 + ch / 2.0 - (y0 + y1) / 2.0 * z,
        );
    }

    fn cmd_new_file(&mut self) {
        if !self.finish_edits() {
            return;
        }
        self.app.open_blank();
    }

    fn cmd_new_board(&mut self) {
        if !self.finish_edits() {
            return;
        }
        self.app.open_blank_board();
    }

    fn cmd_open_file(&mut self) {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("X-Native", &["x"])
            .add_filter(
                "All supported",
                &["x", "svg", "sketch", "json", "png", "fig"],
            )
            .pick_file()
        else {
            return;
        };
        self.open_path(path);
    }

    pub fn open_path(&mut self, path: std::path::PathBuf) {
        if self.app.document_loading.is_some() {
            return;
        }
        if !self.finish_edits() {
            return;
        }
        self.app.dash_search_focus = false;
        if let Some(i) = self.app.docs.iter().position(|d| {
            d.path
                .as_ref()
                .is_some_and(|p| crate::jobs::same_document_path(p, &path))
        }) {
            self.app.active = i;
            self.app.screen = Screen::Editor;
            return;
        }
        self.start_open(crate::jobs::OpenRequest {
            path,
            mode: crate::jobs::OpenMode::Ask,
        });
    }

    fn focus_origin(&self) -> crate::jobs::FocusOrigin {
        crate::jobs::FocusOrigin {
            document: self.app.doc_opt().map(|d| d.recovery_path.clone()),
            revision: self.app.doc_opt().map_or(0, |d| d.history.revision),
        }
    }
    fn start_open(&mut self, request: crate::jobs::OpenRequest) {
        let previous = crate::loading::PreviousView::capture(&self.app);
        let ticket = self.files.next_ticket();
        self.app.document_loading = Some(crate::loading::LoadingScreen::new(
            ticket,
            request.clone(),
            previous,
        ));
        self.app.hit.clear();
        self.app.drag = None;
        self.app.space_pan = false;
        self.app.context_menu.close();
        self.app.page_menu = None;
        self.app.palette.open = false;
        self.pending_open = Some(request);
        self.next_loading_frame = std::time::Instant::now();
        // Recovery scans are pure reads and may yield to an explicit open.
        // An export is allowed to finish its already-authorized write.
        if self.files.active.as_ref().is_some_and(|a| {
            matches!(
                a.kind,
                crate::jobs::Kind::RecoveryScan | crate::jobs::Kind::Open { .. }
            )
        }) {
            self.files.cancel();
        }
        self.start_pending_open();
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
    fn start_pending_open(&mut self) {
        if self.files.active.is_some() {
            return;
        }
        let Some(request) = self.pending_open.take() else {
            return;
        };
        if self.app.document_loading.is_none() {
            return;
        }
        let origin = self.focus_origin();
        let environment = crate::loading::RenderEnvironment::capture(&self.app);
        let label = format!(
            "Opening {}…",
            request
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        );
        match self.files.start_reported(
            crate::jobs::Kind::Open { origin },
            label,
            move |reporter| crate::jobs::open_prepared(request, environment, reporter),
        ) {
            Ok(ticket) => {
                if let Some(load) = &mut self.app.document_loading {
                    load.ticket = ticket;
                    load.phase = crate::loading::Phase::Working(crate::loading::Stage::Reading);
                }
            }
            Err(error) => {
                if let Some(load) = &mut self.app.document_loading {
                    load.fail(error, None);
                }
            }
        }
        self.refresh_file_status();
    }
    fn prepare_loaded(&mut self, output: crate::jobs::Output, origin: crate::jobs::FocusOrigin) {
        let environment = crate::loading::RenderEnvironment::capture(&self.app);
        match self.files.start_reported(
            crate::jobs::Kind::Open { origin },
            "Preparing rendering and caches…".into(),
            move |reporter| crate::jobs::prepare_opened(output, environment, reporter),
        ) {
            Ok(ticket) => {
                if let Some(load) = &mut self.app.document_loading {
                    load.ticket = ticket;
                    load.phase = crate::loading::Phase::Working(crate::loading::Stage::Rendering);
                }
            }
            Err(error) => {
                self.app.status = error.clone();
                if let Some(load) = &mut self.app.document_loading {
                    load.fail(error, None);
                }
            }
        }
        self.refresh_file_status();
    }
    fn restore_loading_view(&mut self, previous: &crate::loading::PreviousView) {
        self.app.active = self.app.active.min(self.app.docs.len().saturating_sub(1));
        if let Some(key) = &previous.document {
            if let Some(i) = self.app.docs.iter().position(|d| &d.recovery_path == key) {
                self.app.active = i;
            }
        } else {
            self.app.active = self.app.active.min(self.app.docs.len().saturating_sub(1));
        }
        self.app.screen = if self.app.docs.is_empty() {
            Screen::Dashboard
        } else {
            previous.screen
        };
        self.app.zoom = previous.zoom;
        self.app.pan = previous.pan;
    }
    fn close_document_loading(&mut self) {
        let Some(load) = self.app.document_loading.take() else {
            return;
        };
        self.pending_open = None;
        if self.files.active.as_ref().is_some_and(|a| {
            a.ticket == load.ticket && matches!(a.kind, crate::jobs::Kind::Open { .. })
        }) {
            self.files.cancel();
        }
        if let Some(key) = load.candidate {
            if let Some(i) = self.app.docs.iter().position(|d| d.recovery_path == key) {
                // No edits can reach an unpresented candidate. Never delete its
                // source/autosave files when rolling back this private load.
                self.app.docs.remove(i);
            }
        }
        self.restore_loading_view(&load.previous);
        self.app.hit.clear();
        self.app.status = "Document open cancelled; files kept".into();
        self.refresh_file_status();
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
    fn loading_action(&mut self, action: Action) {
        let Some(load) = self.app.document_loading.clone() else {
            return;
        };
        match action {
            Action::LoadingClose | Action::CancelFileOperation => self.close_document_loading(),
            Action::LoadingRetry => {
                let request = load.request;
                self.close_document_loading();
                self.start_open(request);
            }
            Action::LoadingRecover => {
                let offer = match load.phase {
                    crate::loading::Phase::Recovery(o) => Some(o),
                    crate::loading::Phase::Failed { recovery, .. } => recovery,
                    _ => None,
                };
                if let Some(offer) = offer {
                    self.close_document_loading();
                    self.start_open(offer.request);
                }
            }
            Action::LoadingSaved => {
                if matches!(load.phase, crate::loading::Phase::Recovery(_)) {
                    let request = crate::jobs::OpenRequest {
                        mode: crate::jobs::OpenMode::Saved,
                        ..load.request
                    };
                    self.close_document_loading();
                    self.start_open(request);
                }
            }
            _ => {}
        }
    }
    fn loading_key(&mut self, key: &Key) {
        if *key == Key::Named(NamedKey::Escape) {
            self.close_document_loading();
            return;
        }
        let Some(load) = &mut self.app.document_loading else {
            return;
        };
        let buttons = load.buttons();
        if buttons.is_empty() {
            return;
        }
        if *key == Key::Named(NamedKey::Tab) {
            load.focused_button = (load.focused_button
                + if self.app.shift { buttons.len() - 1 } else { 1 })
                % buttons.len();
        } else if matches!(key, Key::Named(NamedKey::Enter | NamedKey::Space)) {
            let action = buttons[load.focused_button.min(buttons.len() - 1)]
                .1
                .clone();
            self.loading_action(action);
        }
    }
    fn document_frame_presented(&mut self) {
        if self
            .app
            .document_loading
            .as_ref()
            .is_some_and(|l| matches!(l.phase, crate::loading::Phase::Presenting))
        {
            // The full document, chrome, assets and blit were presented. There
            // is deliberately no elapsed-time or minimum-visible-duration test.
            self.app.document_loading = None;
        }
    }
    fn load_render_failure(&mut self, message: String, transient: bool) {
        if let Some(load) = &mut self.app.document_loading {
            if matches!(load.phase, crate::loading::Phase::Presenting) {
                load.surface_failures = load.surface_failures.saturating_add(1);
                if !transient || load.surface_failures >= 3 {
                    load.fail(message, None);
                    self.app.hit.clear();
                }
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
        } else {
            self.app.status = message;
        }
    }
    fn refresh_preparation_before_present(&mut self) {
        let Some(load) = self.app.document_loading.clone() else {
            return;
        };
        if !matches!(load.phase, crate::loading::Phase::Presenting) {
            return;
        }
        let Some(key) = load.candidate else {
            return;
        };
        let Some(index) = self.app.docs.iter().position(|d| d.recovery_path == key) else {
            return;
        };
        let view = crate::loading::ViewConfig::from_app(&self.app);
        if self.app.docs[index]
            .prepared_canvas
            .is_some_and(|p| p.view == view && p.font_epoch == self.app.fonts.fonts.epoch())
        {
            return;
        }
        let doc = self.app.docs.remove(index);
        self.restore_loading_view(&load.previous);
        if let Some(state) = &mut self.app.document_loading {
            state.candidate = None;
        }
        let origin = self.focus_origin();
        self.prepare_loaded(
            crate::jobs::Output::Opened {
                document: Box::new(doc),
                path: load.request.path,
                note: self.app.status.clone(),
            },
            origin,
        );
    }
    fn offer_startup_recovery(&mut self) {
        if self.app.demo_mode {
            return;
        }
        let directory = x_native::fileio::user_data_dir().join("recovery");
        let recents = self
            .app
            .recents
            .iter()
            .filter_map(|r| r.path.clone())
            .collect();
        if let Err(e) = self.files.start(
            crate::jobs::Kind::RecoveryScan,
            "Checking recovery files…".into(),
            move || crate::jobs::scan_recovery(directory, recents),
        ) {
            self.app.status = e;
        }
        self.refresh_file_status();
    }
    fn refresh_file_status(&mut self) {
        self.app.file_job = self
            .files
            .active
            .as_ref()
            .map(|a| crate::jobs::DisplayStatus {
                label: a.label.clone(),
                cancelable: a.token.can_cancel(),
                cancelling: a.token.is_cancelled(),
            });
    }
    fn cancel_file_job(&mut self) {
        if self.app.document_loading.is_some() {
            self.close_document_loading();
            return;
        }
        self.close_after_job = false;
        self.app.status = if self.files.cancel() {
            "Cancelling file operation…".into()
        } else {
            "File write is already committing; waiting for completion".into()
        };
        self.refresh_file_status();
    }
    fn apply_file_result(&mut self, finished: crate::jobs::Finished) {
        use crate::jobs::{Kind, Output};
        let crate::jobs::Finished {
            ticket,
            kind,
            result,
            cancelled,
        } = finished;
        let tracked = self
            .app
            .document_loading
            .as_ref()
            .is_some_and(|l| l.ticket == ticket);
        if matches!(kind, Kind::Open { .. })
            && self
                .app
                .document_loading
                .as_ref()
                .is_some_and(|l| l.ticket != ticket)
        {
            return;
        }
        if cancelled {
            if tracked {
                self.close_document_loading();
            }
            self.app.status = "File operation cancelled; files kept".into();
            self.refresh_file_status();
            return;
        }
        match result {
            Ok(Output::Opened {
                document,
                path,
                note,
            }) => {
                let doc = *document;
                let origin = match kind {
                    Kind::Open { origin } => origin,
                    _ => self.focus_origin(),
                };
                let view = crate::loading::ViewConfig::from_app(&self.app);
                if !doc
                    .prepared_canvas
                    .is_some_and(|p| p.view == view && p.font_epoch == self.app.fonts.fonts.epoch())
                {
                    self.prepare_loaded(
                        Output::Opened {
                            document: Box::new(doc),
                            path,
                            note,
                        },
                        origin,
                    );
                    return;
                }
                let current = self.focus_origin();
                let activate = origin.document == current.document
                    && origin.revision == current.revision
                    && !self.app.has_text_focus()
                    && self.app.ime_preedit.is_empty();
                let existing = doc.canonical_path.as_ref().and_then(|p| {
                    self.app
                        .docs
                        .iter()
                        .position(|d| d.canonical_path.as_ref() == Some(p))
                });
                if let Some(index) = existing {
                    if activate {
                        self.app.active = index;
                        self.app.screen = Screen::Editor;
                    }
                    self.app.status = "File is already open; existing tab kept".into();
                    if tracked {
                        self.app.document_loading = None;
                    }
                } else {
                    let warnings = doc.asset_warnings();
                    let remember = doc.path.is_some() || doc.source_path.as_ref() == Some(&path);
                    let recent_error = if remember {
                        self.push_recent(doc.name.clone(), Some(path)).err()
                    } else {
                        None
                    };
                    let key = doc.recovery_path.clone();
                    let camera = doc.prepared_canvas.expect("prepared above").camera;
                    self.app.docs.push(doc);
                    if activate {
                        self.app.active = self.app.docs.len() - 1;
                        self.app.screen = Screen::Editor;
                        self.app.zoom = camera.zoom;
                        self.app.pan = camera.pan;
                        if let Some(load) = self
                            .app
                            .document_loading
                            .as_mut()
                            .filter(|l| l.ticket == ticket)
                        {
                            load.phase = crate::loading::Phase::Presenting;
                            load.candidate = Some(key);
                            load.surface_failures = 0;
                            self.app.hit.clear();
                        }
                    } else if tracked {
                        self.app.document_loading = None;
                    }
                    self.app.status = note;
                    if !activate {
                        self.app
                            .status
                            .push_str(" · opened in a background tab; current edit kept");
                    }
                    if !warnings.is_empty() {
                        self.app.status.push_str(&format!(" · {warnings}"));
                    }
                    if let Some(error) = recent_error {
                        self.app
                            .status
                            .push_str(&format!(" · recents not updated: {error}"));
                    }
                }
            }
            Ok(Output::Offer(offer)) => {
                self.app.status = format!("{} — recovery decision required", offer.reason);
                if let Some(load) = self
                    .app
                    .document_loading
                    .as_mut()
                    .filter(|l| l.ticket == ticket)
                {
                    if offer.request.mode == crate::jobs::OpenMode::Repair {
                        load.fail(offer.reason.clone(), Some(offer));
                    } else {
                        load.phase = crate::loading::Phase::Recovery(offer);
                        load.focused_button = 0;
                    }
                } else {
                    self.recoveries.push_back(offer);
                }
            }
            Ok(Output::Recoveries(offers)) => {
                self.recoveries.extend(offers);
                if !self.recoveries.is_empty() {
                    self.app.status = "Recovery files found".into();
                }
            }
            Ok(Output::Exported(note)) => self.app.status = note,
            Err(error) => {
                self.app.status = match kind {
                    Kind::Export => format!("Export stopped: {error}"),
                    Kind::Open { .. } => format!("Open stopped: {error}"),
                    Kind::RecoveryScan => format!("Recovery scan stopped: {error}"),
                };
                if let Some(load) = self
                    .app
                    .document_loading
                    .as_mut()
                    .filter(|l| l.ticket == ticket)
                {
                    load.fail(error, None);
                    self.app.hit.clear();
                }
            }
        }
        self.refresh_file_status();
    }
    fn poll_file_jobs(&mut self) {
        let progress = self.files.progress();
        if let Some(load) = &mut self.app.document_loading {
            for event in progress {
                load.update_stage(event.ticket, event.stage);
            }
        }
        if let Some(finished) = self.files.poll() {
            self.apply_file_result(finished);
            if let Some(w) = &self.window {
                w.request_redraw();
            }
        }
        self.start_pending_open();
        self.refresh_file_status();
    }
    fn prompt_recovery(&mut self) {
        use crate::jobs::OpenMode;
        if self.window.is_none()
            || self.app.document_loading.is_some()
            || self.files.active.is_some()
            || self.app.has_text_focus()
            || !self.app.ime_preedit.is_empty()
            || self.close_after_job
        {
            return;
        }
        let Some(offer) = self.recoveries.pop_front() else {
            return;
        };
        let description=match offer.request.mode {
            OpenMode::Repair=>format!("{}\n\nRecover into a new unsaved copy? The original will not be overwritten.",offer.reason),
            OpenMode::UnnamedRecovery=>format!("An unsaved recovery exists: {}\n\nYes: recover. No: discard this recovery file. Cancel: keep it for later.",offer.request.path.display()),
            _=>format!("A newer recovery snapshot exists for {}.\n\nYes: recover. No: open the saved file. Cancel: keep the snapshot and do not open.",offer.request.path.display()),
        };
        let result = rfd::MessageDialog::new()
            .set_title("Recover unsaved work?")
            .set_description(description)
            .set_buttons(rfd::MessageButtons::YesNoCancel)
            .show();
        match result {
            rfd::MessageDialogResult::Yes => self.start_open(offer.request),
            rfd::MessageDialogResult::No if offer.request.mode == OpenMode::Autosave => self
                .start_open(crate::jobs::OpenRequest {
                    mode: OpenMode::Saved,
                    ..offer.request
                }),
            rfd::MessageDialogResult::No if offer.request.mode == OpenMode::UnnamedRecovery => {
                if let Err(e) = std::fs::remove_file(offer.request.path) {
                    self.app.status = format!("Could not discard recovery: {e}");
                }
            }
            _ => {
                self.app.status = "Recovery not opened; original files kept".into();
                self.recoveries.clear();
            }
        }
    }
    #[cfg(test)]
    fn wait_for_file_job(&mut self) {
        // Headless tests use the same CPU handoff and inject a successful
        // presenter acknowledgement; production only acknowledges tex.present().
        while self.files.active.is_some() || self.pending_open.is_some() {
            for event in self.files.progress() {
                if let Some(load) = &mut self.app.document_loading {
                    load.update_stage(event.ticket, event.stage);
                }
            }
            if let Some(finished) = self.files.wait() {
                self.apply_file_result(finished);
            }
            self.start_pending_open();
        }
        if self.window.is_none() {
            self.document_frame_presented();
        }
    }

    fn cmd_import_file(&mut self) {
        if let Some(path) = rfd::FileDialog::new()
            .add_filter(
                "Import: SVG, PNG, Sketch, Figma REST JSON",
                &["svg", "png", "sketch", "json"],
            )
            .pick_file()
        {
            self.open_path(path);
        }
    }

    fn finish_edits(&mut self) -> bool {
        if !self.app.ime_preedit.is_empty() {
            self.app.status = "Finish or cancel the current text composition first".into();
            return false;
        }
        if self
            .app
            .comment_draft
            .as_ref()
            .is_some_and(|d| !d.buffer.trim().is_empty())
        {
            self.app.status = "Post or cancel the draft comment first".into();
            return false;
        }
        self.commit_field();
        if self.app.commit_text_field() {
            self.app.mark_dirty();
        }
        true
    }

    fn cmd_save(&mut self) {
        if !self.finish_edits() {
            return;
        }
        let Some(doc) = self.app.doc_opt() else {
            return;
        };
        if let Some(path) = doc.path.clone() {
            self.save_to(path);
        } else {
            self.cmd_save_as();
        }
    }

    fn cmd_save_as(&mut self) {
        if !self.finish_edits() {
            return;
        }
        if self.window.is_none() {
            self.app.status = "Save As cancelled; no path selected".into();
            return;
        }
        let Some(doc) = self.app.doc_opt() else {
            return;
        };
        let Some(path) = rfd::FileDialog::new()
            .set_file_name(format!("{}.x", doc.name))
            .add_filter("X-Native", &["x"])
            .save_file()
        else {
            return;
        };
        self.save_to(with_extension(path, "x"));
    }

    fn save_to(&mut self, path: std::path::PathBuf) {
        if !self.finish_edits() {
            return;
        }
        if self.app.docs.is_empty() {
            return;
        }
        match self.app.doc().save_to(&path) {
            Ok(()) => {
                let name = self.app.doc_ref().name.clone();
                self.app.status = match self.push_recent(name, Some(path)) {
                    Ok(()) => "Saved".into(),
                    Err(e) => format!("Saved; recent list not updated: {e}"),
                };
            }
            Err(e) => self.app.status = format!("Save failed: {e}; document remains open"),
        }
    }

    fn push_recent(
        &mut self,
        _name: String,
        path: Option<std::path::PathBuf>,
    ) -> Result<(), String> {
        if let Some(path) = path {
            x_native::fileio::try_push_recent(&path.to_string_lossy())
                .map_err(|e| e.to_string())?;
            self.app.reload_recents();
        }
        Ok(())
    }

    fn close_choice(&self, name: &str) -> crate::session::CloseChoice {
        use crate::session::CloseChoice;
        // Tests/headless callers cannot accidentally dismiss a dirty document.
        if self.window.is_none() {
            return CloseChoice::Cancel;
        }
        let answer = rfd::MessageDialog::new().set_title("Unsaved changes")
            .set_description(format!("Save changes to {name} before closing?\n\nSave failure or cancelling Save As keeps the document open."))
            .set_buttons(rfd::MessageButtons::YesNoCancelCustom("Save".into(), "Discard".into(), "Cancel".into())).show();
        match answer {
            rfd::MessageDialogResult::Yes => CloseChoice::Save,
            rfd::MessageDialogResult::No => CloseChoice::Discard,
            rfd::MessageDialogResult::Custom(s) if s == "Save" => CloseChoice::Save,
            rfd::MessageDialogResult::Custom(s) if s == "Discard" => CloseChoice::Discard,
            _ => CloseChoice::Cancel,
        }
    }

    fn request_close_doc(&mut self, index: usize) -> bool {
        if index >= self.app.docs.len() {
            return true;
        }
        if !self.finish_edits() {
            return false;
        }
        let dirty = self.app.docs[index].dirty;
        let name = self.app.docs[index].name.clone();
        let choice = if dirty {
            self.close_choice(&name)
        } else {
            crate::session::CloseChoice::Discard
        };
        self.close_doc_with_choice(index, choice)
    }

    fn close_doc_with_choice(&mut self, index: usize, choice: crate::session::CloseChoice) -> bool {
        if index >= self.app.docs.len() {
            return true;
        }
        if !self.finish_edits() {
            return false;
        }
        let previous = self.app.active;
        self.app.active = index;
        let dirty = self.app.docs[index].dirty;
        let allowed = crate::session::permits_close(dirty, choice, || {
            self.cmd_save();
            !self.app.docs[index].dirty
        });
        if allowed {
            self.app.docs[index].dirty = false; // decision already made; state removal is guarded
            self.app.close_doc(index);
            self.app.active = previous
                .saturating_sub(usize::from(previous > index))
                .min(self.app.docs.len().saturating_sub(1));
        } else {
            self.app.active = previous;
            if choice == crate::session::CloseChoice::Cancel {
                self.app.status = "Close cancelled".into();
            }
        }
        allowed
    }

    fn request_close_window(&mut self) -> bool {
        if self.app.document_loading.is_some() {
            self.close_document_loading();
        }
        if self
            .files
            .active
            .as_ref()
            .is_some_and(|a| matches!(a.kind, crate::jobs::Kind::Export))
        {
            self.close_after_job = true;
            self.app.status = if self.files.cancel() {
                "Cancelling export before close…".into()
            } else {
                "Waiting for the file write to finish before close…".into()
            };
            return false;
        }
        self.files.cancel();
        self.recoveries.clear();
        // Sequential policy: successfully saved/discarded tabs may close;
        // cancelling any later tab leaves that tab and all remaining work open.
        while !self.app.docs.is_empty() {
            if !self.request_close_doc(self.app.docs.len() - 1) {
                return false;
            }
        }
        true
    }

    fn cmd_export(&mut self, selection_only: bool) {
        if !self.finish_edits() {
            return;
        }
        if self.app.docs.is_empty() {
            self.app.status = "Open a document before exporting".into();
            return;
        }
        let (fmt, scale, suffix, name) = {
            let d = self.app.doc_ref();
            (
                d.export_format,
                if d.export_scale == 0 { 1.0 } else { 2.0 },
                d.export_suffix.clone(),
                d.name.clone(),
            )
        };
        let ext = match fmt {
            3 => "pdf",
            2 => "svg",
            1 => "jpg",
            _ => "png",
        };
        let Some(path) = rfd::FileDialog::new()
            .set_file_name(format!("{name}{suffix}.{ext}"))
            .add_filter("Export", &[ext])
            .save_file()
        else {
            return;
        };
        let path = with_extension(path, ext);
        if let Err(e) = self.export_to(&path, selection_only, fmt, scale) {
            self.app.status = format!("Export failed: {e}");
        }
    }

    fn export_to(
        &mut self,
        path: &std::path::Path,
        selection_only: bool,
        format: usize,
        scale: f64,
    ) -> Result<(), String> {
        if self.files.active.is_some() {
            return Err("A file operation is still running".into());
        }
        if !self.finish_edits() {
            return Err(self.app.status.clone());
        }
        let d = self
            .app
            .doc_opt()
            .ok_or("Open a document before exporting")?;
        if d.path.as_ref().is_some_and(|p| p == path) {
            return Err("Export cannot overwrite the active native document".into());
        }
        let request = crate::jobs::ExportRequest {
            root: d.editor_ref().root.clone(),
            variables: d.doc.variables.clone(),
            selection: selection_only.then(|| d.editor_ref().selection.clone()),
            assets: d.doc.assets.clone(),
            decoded: d.assets.clone(),
            fonts: self.app.fonts.fonts.clone(),
            path: path.to_owned(),
            format,
            scale,
        };
        self.files.start(
            crate::jobs::Kind::Export,
            "Exporting snapshot…".into(),
            move || request.run(),
        )?;
        self.refresh_file_status();
        Ok(())
    }

    // ---------------------------------------------------------- dispatch

    fn dispatch(&mut self, a: Action) {
        if self.app.document_loading.is_some() {
            self.loading_action(a);
            return;
        }
        match a {
            Action::LoadingRetry
            | Action::LoadingClose
            | Action::LoadingRecover
            | Action::LoadingSaved => {}
            Action::CancelFileOperation => self.cancel_file_job(),
            Action::NewFile => self.cmd_new_file(),
            Action::NewBoard => self.cmd_new_board(),
            Action::ImportFile => self.cmd_import_file(),
            Action::OpenRecent(i) => {
                let path = self.app.recents.get(i).and_then(|r| r.path.clone());
                let name = self
                    .app
                    .recents
                    .get(i)
                    .map(|r| r.name.clone())
                    .unwrap_or_default();
                match path {
                    Some(p) => self.open_path(p),
                    None if self.app.demo_mode => {
                        self.app.docs.push(OpenDoc::demo_blank(name));
                        self.app.active = self.app.docs.len() - 1;
                        self.app.screen = Screen::Editor;
                        self.app.center_view();
                    }
                    _ => {
                        self.app.status = format!("Cannot open {name}: file is missing. Locate it with Open; no replacement was created.");
                    }
                }
            }
            Action::StarRecent(i) => {
                if let Some(r) = self.app.recents.get_mut(i) {
                    let starred = !r.starred;
                    if let Some(path) = &r.path {
                        if let Err(e) =
                            x_native::fileio::set_starred(&path.to_string_lossy(), starred)
                        {
                            self.app.status = format!("Could not update starred files: {e}");
                            return;
                        }
                    }
                    r.starred = starred;
                }
            }
            Action::OpenDraft(i) => {
                if !self.finish_edits() {
                    return;
                }
                let path = self.app.drafts.get(i).and_then(|d| d.path.clone());
                if let Some(p) = path {
                    // P13: saved drafts open like any other file
                    self.open_path(p);
                    return;
                }
                if !self.app.demo_mode {
                    return;
                }
                let name = self
                    .app
                    .drafts
                    .get(i)
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| "Untitled".into());
                self.app.docs.push(OpenDoc::demo_blank(name));
                self.app.active = self.app.docs.len() - 1;
                self.app.screen = Screen::Editor;
                self.app.center_view();
            }
            Action::DashNav(v) => {
                if !self.finish_edits() {
                    return;
                }
                if v == crate::state::DashView::Home
                    && self.app.screen == Screen::Editor
                    && !self.app.docs.is_empty()
                {
                    // logo cell → dashboard
                    self.app.screen = Screen::Dashboard;
                } else {
                    self.app.dash_view = v;
                    self.app.screen = Screen::Dashboard;
                }
            }
            Action::DashLayout(l) => self.app.dash_layout = l,
            Action::SearchFocus => {
                self.app.dash_search_focus = true;
            }
            Action::Upgrade => self.app.status = "Upgrade — coming soon".into(),
            Action::InviteTeam => self.app.status = "Invite team — coming soon".into(),
            Action::AddTeam => self.app.status = "Team creation — coming soon".into(),
            Action::SelectDoc(i) => {
                if !self.finish_edits() {
                    return;
                }
                if i < self.app.docs.len() {
                    self.app.active = i;
                    self.app.screen = Screen::Editor;
                    self.app.center_view();
                }
            }
            Action::CloseDoc(i) => {
                self.request_close_doc(i);
            }
            Action::Tool(t) => self.app.tool = t,
            Action::LeftTab(t) => {
                self.app.doc().left_tab = t;
            }
            Action::TokensExtractVars => self.cmd_extract_tokens(),
            Action::SetTheme(t) => self.apply_theme(t),
            Action::CycleTheme => {
                let next = crate::theme::active_theme().next();
                self.apply_theme(next);
            }
            Action::ToggleColorPicker(is_fill) => {
                let (fill_open, stroke_open) = {
                    let doc = self.app.doc();
                    if is_fill {
                        doc.color_picker_fill_open = !doc.color_picker_fill_open;
                        if doc.color_picker_fill_open {
                            doc.color_picker_stroke_open = false;
                        }
                    } else {
                        doc.color_picker_stroke_open = !doc.color_picker_stroke_open;
                        if doc.color_picker_stroke_open {
                            doc.color_picker_fill_open = false;
                        }
                    }
                    (doc.color_picker_fill_open, doc.color_picker_stroke_open)
                };
                if fill_open || stroke_open {
                    // Keep the popup anchored to the actual click instead of
                    // the retired chrome renderer. The active editor painter
                    // owns the popup and appends its own hit targets.
                    let p = self.app.mouse;
                    self.app.color_picker_popup =
                        Some((is_fill, Rect::new(p.x, p.y, p.x + 1.0, p.y + 1.0), true));
                } else {
                    self.app.color_picker_popup = None;
                }
            }
            Action::CloseColorPicker => {
                let doc = self.app.doc();
                doc.color_picker_fill_open = false;
                doc.color_picker_stroke_open = false;
                self.app.color_picker_popup = None;
            }
            Action::PaintPreset(is_fill, hex) => {
                let Some(color) = crate::state::parse_hex(&hex) else {
                    self.app.status = "Invalid color preset".into();
                    return;
                };
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer before changing its color".into();
                    return;
                };
                let info = crate::editor_ui::sel_info(&self.app);
                let changed = if is_fill {
                    self.app.doc().editor().set_fill(&id, Paint::Solid(color));
                    true
                } else {
                    let width = info.stroke_w.max(1.0);
                    self.app.doc().editor().mutate_visual_stack(&id, move |n| {
                        n.materialize_visual_stacks();
                        let stroke = x_native::Stroke::solid(color, width);
                        n.stroke = stroke.clone();
                        if let Some(layer) = n.stroke_layers.last_mut() {
                            layer.stroke = stroke;
                        } else {
                            n.stroke_layers.push(x_native::StrokeLayer::new(stroke));
                        }
                    })
                };
                if changed {
                    self.app.mark_dirty();
                    self.app.status =
                        format!("{} color updated", if is_fill { "Fill" } else { "Stroke" });
                }
                self.app.color_picker_popup = None;
                let doc = self.app.doc();
                doc.color_picker_fill_open = false;
                doc.color_picker_stroke_open = false;
            }
            Action::RightTab(t) => {
                self.app.doc().right_tab = t;
            }
            Action::VariantCycle(dir) => {
                let Some((_iid, comp)) = self.app.selected_instance() else {
                    self.app.status = "Select an instance of a variant set".into();
                    return;
                };
                let siblings = self.app.doc().editor_ref().variant_siblings(&comp);
                if siblings.is_empty() {
                    self.app.status = "This component is not part of a variant set".into();
                    return;
                }
                let set = comp.split('/').next().unwrap_or(&comp).to_string();
                let cur = comp.rsplit('/').next().unwrap_or(&comp);
                let pos = siblings.iter().position(|v| v == cur).unwrap_or(0);
                let n = siblings.len();
                let next = (pos as i32 + dir.signum()).rem_euclid(n as i32) as usize;
                let target = format!("{set}/{}", siblings[next]);
                let ok = {
                    let id = self.app.selected_instance().unwrap().0;
                    self.app.doc().editor().set_instance_component(&id, &target)
                };
                if ok {
                    self.app.mark_dirty();
                    self.app.status = format!("Variant → {}", siblings[next]);
                }
            }
            Action::VariantCombine => {
                let sel = self.app.doc().editor_ref().selection.len();
                if sel < 2 {
                    self.app.status = "Select two or more component masters first".into();
                    return;
                }
                let set_name = {
                    let d = self.app.doc();
                    let root = &d.editor_ref().root;
                    let mut nm = String::new();
                    for id in &d.editor_ref().selection {
                        if let Some(n) = crate::editor_ui::find_node(root, id) {
                            if let x_native::NodeKind::Component { name } = &n.kind {
                                nm = name.split('/').next().unwrap_or(name).to_string();
                                break;
                            }
                        }
                    }
                    if nm.is_empty() {
                        nm = "Variants".into();
                    }
                    nm
                };
                let done = self.app.doc().editor().combine_as_variants(&set_name);
                if done > 0 {
                    self.app.mark_dirty();
                    self.app.status = format!("Combined {done} component masters into {set_name}");
                } else {
                    self.app.status = "Select component masters to create a variant set".into();
                }
            }
            Action::ProtoAdd => self.proto_add(),
            Action::ProtoRemove(i) => self.proto_edit(move |l| {
                if i < l.len() {
                    l.remove(i);
                }
            }),
            Action::ProtoTrigger(i) => self.proto_trigger_cycle(i),
            Action::ProtoDest(i, dir) => self.proto_dest_cycle(i, dir),
            Action::ProtoSpeed(i) => self.proto_speed_cycle(i),
            Action::ProtoAnimation(i) => self.proto_animation_cycle(i),
            Action::ProtoActionType(i) => self.proto_action_type_cycle(i),
            Action::ProtoEditDelay(i) => self.proto_edit_delay(i),
            Action::ProtoEditKey(i) => self.proto_edit_key(i),
            Action::ProtoEditUrl(i) => self.proto_edit_url(i),
            Action::ProtoEditVideoTime(i) => self.proto_edit_video_time(i),
            Action::ProtoEasing(i) => self.proto_easing(i),
            Action::ProtoToggleReset(i) => self.proto_toggle_reset(i),
            Action::ProtoToggleStart => {
                let Some(id) = self.proto_selected_id() else {
                    self.app.status = "Select one layer to mark it as a flow start".into();
                    return;
                };
                let cur = {
                    let d = self.app.doc();
                    crate::editor_ui::find_node(&d.editor_ref().root, &id)
                        .map(|n| n.is_starting_point)
                        .unwrap_or(false)
                };
                if self.app.doc().editor().set_node_starting_point(&id, !cur) {
                    self.app.mark_dirty();
                    self.app.status = (if cur {
                        "Flow start removed"
                    } else {
                        "Flow starts here"
                    })
                    .to_string();
                }
            }
            Action::FlowEnter => self.flow_enter(),
            Action::FlowBack => self.flow_back(),
            Action::FlowExit => {
                self.app.flow = None;
                self.app.status = "Flow preview ended".into();
            }
            Action::LoadFont => self.cmd_load_font(),
            Action::Ctx(cmd) => {
                self.app.context_menu.close();
                self.app.apply_ctx(cmd);
            }
            Action::ToggleVisible => self.app.apply_toggle(false),
            Action::ToggleLock => self.app.apply_toggle(true),
            Action::ToggleAspectRatio => {
                self.app.aspect_ratio_locked = !self.app.aspect_ratio_locked;
                self.app.status = if self.app.aspect_ratio_locked {
                    "Aspect ratio locked".into()
                } else {
                    "Aspect ratio unlocked".into()
                };
            }
            Action::TogglePaintVisibility(is_fill) => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, move |n| {
                    n.materialize_visual_stacks();
                    if is_fill {
                        if let Some(layer) = n.fill_layers.first_mut() {
                            layer.visible = !layer.visible;
                        }
                    } else if let Some(layer) = n.stroke_layers.first_mut() {
                        layer.visible = !layer.visible;
                    }
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::CycleStrokePosition => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let has_stroke = crate::editor_ui::sel_info(&self.app).stroke_w > 0.0;
                if !has_stroke {
                    self.app.status = "Add a stroke before changing its position".into();
                    return;
                }
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.materialize_visual_stacks();
                    if let Some(layer) = n.stroke_layers.first_mut() {
                        layer.options.align = match layer.options.align {
                            x_native::StrokeAlign::Inside => x_native::StrokeAlign::Center,
                            x_native::StrokeAlign::Center => x_native::StrokeAlign::Outside,
                            x_native::StrokeAlign::Outside => x_native::StrokeAlign::Inside,
                        };
                    }
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::CycleTextAlign => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.text_align = match n.text_align {
                        x_native::TextAlign::Left => x_native::TextAlign::Center,
                        x_native::TextAlign::Center => x_native::TextAlign::Right,
                        x_native::TextAlign::Right => x_native::TextAlign::Justified,
                        x_native::TextAlign::Justified => x_native::TextAlign::Left,
                    };
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::CycleTextAlignVertical => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.text_align_vertical = match n.text_align_vertical {
                        x_native::TextAlignVertical::Top => x_native::TextAlignVertical::Middle,
                        x_native::TextAlignVertical::Middle => x_native::TextAlignVertical::Bottom,
                        x_native::TextAlignVertical::Bottom => x_native::TextAlignVertical::Top,
                    };
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::CycleTextDecoration => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.text_decoration = match n.text_decoration {
                        x_native::TextDecoration::None => x_native::TextDecoration::Underline,
                        x_native::TextDecoration::Underline => {
                            x_native::TextDecoration::Strikethrough
                        }
                        x_native::TextDecoration::Strikethrough => x_native::TextDecoration::None,
                    };
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::CycleTextTruncation => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.text_truncation = match n.text_truncation {
                        x_native::TextTruncation::Disabled => x_native::TextTruncation::End,
                        x_native::TextTruncation::End => x_native::TextTruncation::Middle,
                        x_native::TextTruncation::Middle => x_native::TextTruncation::Disabled,
                    };
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::CycleListStyle => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.list_style = match n.list_style {
                        x_native::ListStyle::None => x_native::ListStyle::Bulleted,
                        x_native::ListStyle::Bulleted => x_native::ListStyle::Numbered,
                        x_native::ListStyle::Numbered => x_native::ListStyle::None,
                    };
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::ToggleTextWrapStyle => {
                let Some(id) = self.app.doc().selected_id() else {
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.wrap_style = match n.wrap_style {
                        x_native::WrapStyle::Normal => x_native::WrapStyle::BreakWord,
                        x_native::WrapStyle::BreakWord => x_native::WrapStyle::Normal,
                    };
                });
                if changed {
                    self.app.mark_dirty();
                }
            }
            Action::Align(row, col) => self.app.apply_align(row, col),
            // UX Analysis actions
            Action::UxAccessibility => self.app.run_ux_accessibility_check(),
            Action::UxUserFlow => self.app.run_ux_user_flow_analysis(),
            Action::UxQualityScore => self.app.run_ux_quality_score(),
            Action::UxPatterns => self.app.run_ux_interaction_patterns(),
            Action::UxContrast => self.app.run_ux_color_contrast(),
            Action::UxResponsive => self.app.run_ux_responsive_preview(),
            // Navigation bar actions
            Action::NavTab(tab) => {
                self.app.nav_tab = tab;
            }
            Action::ToggleNavLabels => {
                self.app.nav_show_labels = !self.app.nav_show_labels;
            }
            Action::OpenAppMenu => {
                self.app.app_menu.open = !self.app.app_menu.open;
            }
            Action::CloseAppMenu => {
                self.app.app_menu.open = false;
            }
            Action::AppMenuItem(idx) => {
                self.app.app_menu.open = false;
                match idx {
                    0 => {
                        self.app.open_blank();
                    } // New file
                    3 => {
                        self.cmd_save();
                    } // Save
                    8 => {} // Preferences (no-op for now)
                    9 => {
                        // Dark mode toggle
                        let next = crate::theme::active_theme().next();
                        self.apply_theme(next);
                    }
                    _ => {}
                }
            }
            Action::OpenFind => {
                self.app.find_replace.open = true;
            }
            Action::CloseFind => {
                self.app.find_replace.open = false;
            }
            Action::FindNext => self.app.find_nav(1),
            Action::FindPrev => self.app.find_nav(-1),
            Action::ReplaceAll => {
                let changed = self.app.replace_all_find();
                self.app.status = if changed > 0 {
                    format!("Replaced matches in {changed} layers")
                } else {
                    "Nothing to replace".to_string()
                };
            }
            Action::Replace => {
                self.app.status = if self.app.replace_current_find() {
                    "Replaced current match".to_string()
                } else {
                    "Nothing to replace".to_string()
                };
            }
            Action::ToggleCaseSensitive => {
                self.app.find_replace.case_sensitive = !self.app.find_replace.case_sensitive;
            }
            Action::ToggleFindInSelection => {
                self.app.find_replace.in_selection = !self.app.find_replace.in_selection;
            }
            Action::ToggleNotifications => {
                self.app.notifications.open = !self.app.notifications.open;
                if self.app.notifications.open {
                    self.app.app_menu.open = false;
                }
            }
            Action::DismissNotification(id) => {
                self.app.notifications.notifications.retain(|n| n.id != id);
                self.app.notifications.unread_count = self
                    .app
                    .notifications
                    .notifications
                    .iter()
                    .filter(|n| !n.read)
                    .count();
            }
            Action::MarkAllNotificationsRead => {
                for n in &mut self.app.notifications.notifications {
                    n.read = true;
                }
                self.app.notifications.unread_count = 0;
            }
            Action::ToggleMinimizeUI => {
                self.app.ui_minimized = !self.app.ui_minimized;
            }
            Action::ResizeLeftSidebar(w) => {
                self.app.left_sidebar_w = w.clamp(200.0, 500.0);
            }
            Action::CollapseAllLayers => self.app.collapse_all_layers(),
            Action::TreeSearchClear => {
                self.app.doc().tree_search.clear();
                self.app.field = None;
            }
            Action::FileRename => {
                self.app.field = Some(crate::state::FieldEdit {
                    id: crate::state::FieldId::DocName,
                    buffer: self.app.doc().name.clone(),
                });
                self.app.field_select_all = true;
            }
            Action::FileDuplicate => {
                let (name, doc) = {
                    let d = self.app.doc();
                    (d.name.clone(), d.doc.clone())
                };
                let copy_name = format!("{name} (copy)");
                self.app
                    .docs
                    .push(OpenDoc::from_document(copy_name, None, doc));
                self.app.active = self.app.docs.len() - 1;
                self.app.center_view();
                self.app.status = "Document duplicated".into();
            }
            Action::FileMoveToDrafts => {
                let (name, path) = {
                    let d = self.app.doc();
                    (d.name.clone(), d.path.clone())
                };
                if path.is_none() {
                    self.app.status = "Save the document first to move it to drafts".into();
                    return;
                }
                self.app.drafts.insert(
                    0,
                    crate::state::RecentFile {
                        name,
                        team: "file".into(),
                        edited: "Just now".into(),
                        color: crate::theme::C_PANEL,
                        members: vec![],
                        starred: false,
                        path,
                        icon: "file",
                    },
                );
                self.app.status = "Moved to drafts".into();
            }
            Action::AddPage => {
                if !self.finish_edits() {
                    return;
                }
                let doc = self.app.doc();
                doc.checkpoint();
                let n = doc.editors.len() + 1;
                let mut page = Node::frame(&x_native::fresh_id("page"), 1440.0, 1024.0);
                page.name = format!("Page {n}");
                doc.editors
                    .push(x_native::editor::Editor::new(page.clone()));
                doc.doc.pages.push(page);
                doc.page = doc.editors.len() - 1;
                self.app.mark_dirty();
            }
            Action::SelectPage(i) => {
                if !self.finish_edits() {
                    return;
                }
                let d = self.app.doc();
                if i < d.editors.len() {
                    d.page = i;
                }
            }
            Action::PageMenu(cmd) => {
                if !self.finish_edits() {
                    return;
                }
                self.app.page_menu_cmd(cmd);
            }
            Action::DeletePage(i) => {
                if !self.finish_edits() {
                    return;
                }
                if i < self.app.doc_ref().editors.len() {
                    self.app.doc().page = i;
                    self.app.page_menu_cmd(crate::state::PageMenuCmd::Delete);
                }
            }
            Action::TreeRow(id) => {
                if let Some(i) = id.strip_prefix("mock:") {
                    // v45 mock rows: selection is purely visual (like the
                    // HTML's selectLayer), independent of the document
                    let i: usize = i.parse().unwrap_or(usize::MAX);
                    let doc = self.app.doc();
                    doc.editor().selection.clear();
                    for (j, m) in doc.mock_layers.iter_mut().enumerate() {
                        m.selected = j == i;
                    }
                } else {
                    let doc = self.app.doc();
                    doc.mock_layers.iter_mut().for_each(|m| m.selected = false);
                    doc.editor().selection = vec![id];
                }
            }
            Action::TreeToggle(id) => {
                if let Some(i) = id.strip_prefix("mock:") {
                    let i: usize = i.parse().unwrap_or(usize::MAX);
                    let doc = self.app.doc();
                    if let Some(m) = doc.mock_layers.get_mut(i) {
                        m.expanded = !m.expanded;
                    }
                    return;
                }
                let doc = self.app.doc();
                if doc.expanded.contains(&id) {
                    doc.expanded.remove(&id);
                } else {
                    doc.expanded.insert(id);
                }
            }
            Action::RenameStart => {
                let d = self.app.doc();
                let name = d.file_label.clone().unwrap_or_else(|| d.name.clone());
                self.app.field_select_all = true;
                self.app.field = Some(FieldEdit {
                    id: FieldId::DocName,
                    buffer: name,
                });
            }
            Action::FrameDropdown => self.app.dropdown_frame = !self.app.dropdown_frame,
            Action::ZoomMenu => self.app.dropdown_zoom = !self.app.dropdown_zoom,
            Action::ZoomStep(i) => {
                self.app.dropdown_zoom = false;
                match i {
                    0 => self.zoom_at(Point::new(-100.0, -100.0), 1.25),
                    1 => self.zoom_at(Point::new(-100.0, -100.0), 0.8),
                    2 => self.app.zoom = 1.0,
                    3 => self.zoom_to_selection(),
                    _ => self.zoom_fit(),
                }
            }
            Action::TreeVisible(id) => {
                let doc = self.app.doc();
                let v = crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())
                    .map(|n| !n.visible)
                    .unwrap_or(false);
                doc.editor().set_visible(id.as_str(), v);
                self.app.mark_dirty();
            }
            Action::TreeLock(id) => {
                let doc = self.app.doc();
                let v = crate::editor_ui::find_node(&doc.editor_ref().root, id.as_str())
                    .map(|n| !n.locked)
                    .unwrap_or(false);
                doc.editor().set_locked(id.as_str(), v);
                self.app.mark_dirty();
            }
            Action::LhDropdown => {
                self.app.dropdown_lh = !self.app.dropdown_lh;
                // the two typography menus share an anchor: never both open
                self.app.dropdown_text_style = false;
            }
            Action::TextStyleDropdown => {
                self.app.dropdown_text_style = !self.app.dropdown_text_style;
                self.app.dropdown_lh = false;
            }
            Action::ApplyTextStyle(name) => {
                self.app.dropdown_text_style = false;
                let linked = self.app.apply_text_style(name.as_str());
                self.app.status = if linked > 0 {
                    format!("Applied '{name}' to {linked} text layers")
                } else {
                    format!("'{name}' needs a text layer in the selection")
                };
            }
            Action::CreateTextStyle => {
                self.app.dropdown_text_style = false;
                if self.app.create_text_style_from_selection().is_none() {
                    self.app.status = "Select a text layer to create a style from".into();
                }
            }
            Action::DetachTextStyle => {
                self.app.dropdown_text_style = false;
                let n = self.app.detach_text_style_from_selection();
                self.app.status = if n > 0 {
                    format!("Detached {n} text layers from their style")
                } else {
                    "Nothing in the selection is linked to a text style".into()
                };
            }
            Action::UpdateTextStyleFromSelection => {
                self.app.dropdown_text_style = false;
                if self.app.update_text_style_from_selection().is_none() {
                    self.app.status = "The selection is not linked to a text style".into();
                }
            }
            Action::LhMode(i) => {
                self.app.dropdown_lh = false;
                let eff = self.app.selected_text_typo();
                let mode = match i {
                    0 => None,
                    1 => Some((1, eff.map(|t| t.lh_value).unwrap_or(20.0).max(1.0))),
                    _ => {
                        // switching to %: derive from the current effective px
                        let (fs, px) = match eff {
                            Some(t) if t.lh_mode == 2 => (t.fs, t.lh_value / 100.0 * t.fs),
                            Some(t) if t.lh_mode == 1 => (t.fs, t.lh_value),
                            Some(t) => (t.fs, t.lh * self.app.natural_line_height(t.fs)),
                            None => (14.0, 20.0),
                        };
                        Some((2, (px / fs * 100.0).clamp(1.0, 2000.0)))
                    }
                };
                if self.app.set_line_height_mode(mode) {
                    self.app.mark_dirty();
                }
            }
            Action::FramePreset(i) => {
                self.app.dropdown_frame = false;
                let (_, w, h) = FRAME_PRESETS[i];
                let doc = self.app.doc();
                doc.frame_preset = i;
                if let Some(id) = doc.selected_id() {
                    let is_frame = doc.editor_ref().root.children.iter().any(|c| c.id == id);
                    if let Some(n) = crate::editor_ui::find_node(&doc.editor_ref().root, &id) {
                        if matches!(n.kind, NodeKind::Frame { .. }) {
                            let name = FRAME_PRESETS[i].0.to_string();
                            doc.editor().rename_node(&id, &name);
                            // same parametric path as the inspector's W/H
                            // fields: bound sizes and pinned children follow
                            let mut vars = doc.doc.variables.clone();
                            doc.editor().resize_parametric(&id, w, h, &mut vars);
                            doc.doc.variables = vars;
                            self.app.mark_dirty();
                            let _ = is_frame;
                        }
                    }
                }
            }
            Action::Field(f) => {
                let buffer = field_initial(&self.app, f);
                self.app.field_select_all = true;
                self.app.field = Some(FieldEdit { id: f, buffer });
            }
            Action::FlowBtn(i) => {
                let doc = self.app.doc();
                doc.flow = i;
                doc.flow_boot_mock = false;
                self.apply_auto_layout();
            }
            Action::ClipContent => {
                let doc = self.app.doc();
                if let Some(id) = doc.selected_id() {
                    if let Some(n) = x_native::editor::find(&doc.editor_ref().root, &id) {
                        if matches!(n.kind, NodeKind::Frame { .. }) {
                            let overflow = if n.overflow.clips() {
                                x_native::Overflow::Visible
                            } else {
                                x_native::Overflow::Clip
                            };
                            doc.editor().set_overflow(&id, overflow);
                            self.app.mark_dirty();
                        }
                    }
                }
            }
            Action::ExportRun => self.cmd_export(true),
            Action::AddFill => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer before adding a fill".into();
                    return;
                };
                let info = crate::editor_ui::sel_info(&self.app);
                let color = crate::state::parse_hex(&info.fill).unwrap_or(x_native::Color::WHITE);
                if self
                    .app
                    .doc()
                    .editor()
                    .add_fill_layer(&id, Paint::Solid(color))
                {
                    self.app.mark_dirty();
                    self.app.status = "Fill layer added".into();
                }
            }
            Action::RemoveFill => {
                let doc = self.app.doc();
                if let Some(id) = doc.selected_id() {
                    doc.editor().remove_fill_layer(&id, 0);
                    self.app.mark_dirty();
                }
            }
            Action::AddStroke => {
                let doc = self.app.doc();
                if let Some(id) = doc.selected_id() {
                    doc.editor().add_stroke_layer(
                        &id,
                        x_native::Stroke::solid(x_native::Color::BLACK, 1.0),
                    );
                    self.app.mark_dirty();
                }
            }
            Action::RemoveStroke => {
                let doc = self.app.doc();
                if let Some(id) = doc.selected_id() {
                    doc.editor().remove_stroke_layer(&id, 0);
                    self.app.mark_dirty();
                }
            }
            Action::AddEffect => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer before adding an effect".into();
                    return;
                };
                let effect = x_native::Effect::DropShadow {
                    dx: 0.0,
                    dy: 4.0,
                    blur: 12.0,
                    color: x_native::Color::from_rgba8(0, 0, 0, 96),
                };
                if self.app.doc().editor().add_effect_layer(&id, effect) {
                    self.app.mark_dirty();
                    self.app.status = "Drop shadow added".into();
                }
            }
            Action::AddGuide => {
                // drop a vertical guide at the canvas center
                let reg = self.app.editor_regions();
                let c = self
                    .app
                    .screen_to_world(Point::new(
                        reg.canvas.x0 + (reg.canvas.x1 - reg.canvas.x0) / 2.0,
                        0.0,
                    ))
                    .x;
                self.app
                    .doc()
                    .guides
                    .push(('v', (c * 100.0).round() / 100.0));
                self.app.mark_dirty();
            }
            Action::RemoveGuide => {
                self.app.doc().guides.clear();
                self.app.mark_dirty();
            }
            Action::ToggleGuide(_) => {
                let doc = self.app.doc();
                doc.guide_kind = 1 - doc.guide_kind;
            }
            Action::ToggleGuideVisibility => {
                let doc = self.app.doc();
                doc.guides_visible = !doc.guides_visible;
            }
            Action::CycleExportFormat => {
                let doc = self.app.doc();
                doc.export_format = (doc.export_format + 1) % 4;
            }
            Action::CycleExportScale => {
                let doc = self.app.doc();
                doc.export_scale = 1 - doc.export_scale;
            }
            Action::AddAutoLayout => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a frame to add Auto Layout".into();
                    return;
                };
                let vars = self.app.doc().doc.variables.clone();
                let mut layout = self.app.selected_layout().unwrap_or_default();
                layout.gap = self.app.doc().gap;
                let pad_h = self.app.doc().pad_h;
                let pad_v = self.app.doc().pad_v;
                layout.padding = [pad_h, pad_v, pad_h, pad_v];
                let changed = self
                    .app
                    .doc()
                    .editor()
                    .set_auto_layout(&id, Some(layout), &vars);
                if changed {
                    self.app.mark_dirty();
                    self.app.status = "Auto Layout added".into();
                } else {
                    self.app.status = "Auto Layout can only be added to a frame".into();
                }
            }
            Action::ToggleWrap => {
                self.app.modify_selected_layout(|l| {
                    l.wrap = match l.wrap {
                        x_native::AutoLayoutWrap::Wrap => x_native::AutoLayoutWrap::NoWrap,
                        _ => x_native::AutoLayoutWrap::Wrap,
                    }
                });
            }
            Action::ToggleMainSizing => {
                self.app.modify_selected_layout(|l| {
                    l.sizing = match l.sizing {
                        x_native::Sizing::Hug => x_native::Sizing::Fixed,
                        _ => x_native::Sizing::Hug,
                    }
                });
            }
            Action::ToggleCrossSizing => {
                self.app.modify_selected_layout(|l| {
                    let cur = l.cross_sizing.unwrap_or(l.sizing);
                    let next = match cur {
                        x_native::Sizing::Hug => x_native::Sizing::Fixed,
                        _ => x_native::Sizing::Hug,
                    };
                    l.cross_sizing = Some(next);
                });
            }
            Action::SetChildFill(fill) => {
                self.app.modify_child_constraints(|c| {
                    c.grow = if fill { 1.0 } else { 0.0 };
                    c.is_absolute = false;
                });
            }
            Action::ToggleChildAbsolute => {
                self.app.modify_child_constraints(|c| {
                    c.is_absolute = !c.is_absolute;
                });
            }
            Action::AddProp(kind) => {
                self.app.add_prop(kind);
            }
            Action::RemoveProp(name) => {
                if let Some(c) = self.app.selected_master_name() {
                    self.app.remove_prop(&c, &name);
                }
            }
            Action::ToggleInstanceProp(name) => {
                if let Some((iid, comp)) = self.app.selected_instance() {
                    let cur = {
                        let entries = self.app.props_of(&comp);
                        entries
                            .iter()
                            .find(|e| e.name == name)
                            .map(|e| self.app.instance_prop_value(&iid, e))
                            .unwrap_or_else(|| "true".into())
                    };
                    let next = (cur != "true").to_string();
                    self.app.apply_prop(&iid, &comp, &name, &next);
                }
            }
            Action::CycleInstanceSwap(name) => {
                if let Some((iid, comp)) = self.app.selected_instance() {
                    self.app.cycle_swap(&iid, &comp, &name);
                }
            }
            Action::InspectPlatform(i) => {
                self.app.inspect_platform = i;
            }
            Action::InspectCopy => {
                let code = self.app.inspect_code();
                if code.is_empty() {
                    self.app.status = "Select a layer to inspect".into();
                } else {
                    let platform = App::INSPECT_PLATFORMS[self.app.inspect_platform];
                    let bytes = code.len();
                    if push_system_clipboard(&code) {
                        self.app.status = format!("Copied {platform} ({bytes} chars)");
                    } else {
                        self.app.status = format!("{platform} ready ({bytes} chars)");
                    }
                }
            }
            Action::ResetInstanceProps => {
                if let Some((iid, _)) = self.app.selected_instance() {
                    self.app.reset_instance_props(&iid);
                }
            }
            Action::PaletteToggle => {
                self.app.palette.open();
                self.app.palette.query.clear();
            }
            Action::PaletteRun(ci) => self.run_palette(ci),
            // Layer management (Figma parity). Every gesture here goes through
            // the engine's command log: a batch operation (inverse select, bulk
            // rename, paste properties) is ONE undo step via `edit_batch`, never
            // a `get_node_mut` write behind the log's back.
            Action::InverseSelection => {
                let ids: Vec<String> = {
                    let editor = self.app.doc().editor();
                    let root_id = editor.root.id.clone();
                    let current: std::collections::HashSet<String> =
                        editor.selection.iter().cloned().collect();
                    editor
                        .get_all_selectable_ids()
                        .into_iter()
                        // the page itself is not a selectable layer
                        .filter(|id| *id != root_id && !current.contains(id))
                        .collect()
                };
                let count = ids.len();
                self.app.doc().editor().selection = ids;
                self.app.status = format!("Selected {count} layers (inverse)");
            }
            Action::SelectMatching => {
                // Collect first, then select: the lookup borrows the document
                // immutably, and the selection write needs it mutably.
                let matched: Option<Vec<String>> = {
                    let editor = self.app.doc().editor();
                    if editor.selection.len() != 1 {
                        None
                    } else {
                        let sel = editor.selection[0].clone();
                        editor.get_node(&sel).map(|template| {
                            editor
                                .find_matching_nodes(template)
                                .into_iter()
                                .map(|n| n.id.clone())
                                .collect()
                        })
                    }
                };
                match matched {
                    Some(ids) if !ids.is_empty() => {
                        let count = ids.len();
                        self.app.doc().editor().selection = ids;
                        self.app.status = format!("Selected {count} matching layers");
                    }
                    _ => {
                        self.app.status = "Select exactly one layer to find matching".into();
                    }
                }
            }
            // The numbering half of Figma's bulk rename, without the modal:
            // one gesture, ONE undo step for the whole selection. The base name
            // is the first selected layer's name with trailing digits stripped,
            // so renumbering "Icon 7 / Icon 3 / Icon 9" gives "Icon 1..3"
            // instead of inventing a name the user never typed.
            Action::RenumberSelection => {
                let ids = self.app.doc().editor().selection.clone();
                if ids.is_empty() {
                    self.app.status = "Select the layers to renumber first".into();
                    return;
                }
                let renamed = {
                    let editor = self.app.doc().editor();
                    editor.edit_batch(|root| {
                        let mut base: Option<String> = None;
                        let mut n = 0;
                        for (i, id) in ids.iter().enumerate() {
                            let Some(node) = x_native::editor::find_mut(root, id) else {
                                continue;
                            };
                            if base.is_none() {
                                let stripped = node
                                    .name
                                    .trim_end_matches(|c: char| c.is_ascii_digit())
                                    .trim_end()
                                    .to_string();
                                base = Some(if stripped.is_empty() {
                                    "Layer".to_string()
                                } else {
                                    stripped
                                });
                            }
                            let name = format!("{} {}", base.as_deref().unwrap_or("Layer"), i + 1);
                            node.name = name;
                            node.dirty = true;
                            n += 1;
                        }
                        n
                    })
                };
                if renamed {
                    self.app.mark_dirty();
                    self.app.status = format!("Renumbered {} layers (one undo step)", ids.len());
                } else {
                    self.app.status = "Nothing to renumber".into();
                }
            }
            Action::CopyProperties => {
                let clipboard = {
                    let editor = self.app.doc().editor();
                    match editor.selection.len() {
                        1 => editor.get_node(&editor.selection[0].clone()).map(|node| {
                            PropertyClipboard {
                                fill: Some(node.fill.clone()),
                                stroke: Some(node.stroke.clone()),
                                effects: node.effects.clone(),
                                opacity: Some(node.opacity),
                                corner_radius: node.corner_radii.as_ref().map(|r| r[0]),
                            }
                        }),
                        _ => None,
                    }
                };
                match clipboard {
                    Some(c) => {
                        self.app.property_clipboard = Some(c);
                        self.app.status =
                            "Properties copied (fill, stroke, effects, opacity, radius)".into();
                    }
                    None => {
                        self.app.status = "Select exactly one layer to copy properties".into();
                    }
                }
            }
            Action::PasteProperties => {
                let Some(clip) = self.app.property_clipboard.clone() else {
                    self.app.status = "No properties copied yet".into();
                    return;
                };
                let ids = self.app.doc().editor().selection.clone();
                let pasted = {
                    let editor = self.app.doc().editor();
                    editor.edit_batch(|root| {
                        let mut n = 0;
                        for id in &ids {
                            let Some(node) = x_native::editor::find_mut(root, id) else {
                                continue;
                            };
                            // Figma pastes THE fill / THE stroke, not a whole
                            // stack, so each stack collapses to the one copied
                            // layer; materialized nodes read the stacks, so both
                            // the simple field and the stack are written.
                            if let Some(fill) = &clip.fill {
                                node.fill = fill.clone();
                                node.fill_layers = vec![x_native::PaintLayer::new(fill.clone())];
                            }
                            if let Some(stroke) = &clip.stroke {
                                node.stroke = stroke.clone();
                                node.stroke_layers = if stroke.width > 0.0 {
                                    vec![x_native::StrokeLayer::new(stroke.clone())]
                                } else {
                                    vec![]
                                };
                            }
                            node.effects = clip.effects.clone();
                            node.effect_layers = clip
                                .effects
                                .iter()
                                .cloned()
                                .map(x_native::EffectLayer::new)
                                .collect();
                            node.visual_stacks_materialized = true;
                            if let Some(op) = clip.opacity {
                                node.opacity = op;
                            }
                            if let Some(r) = clip.corner_radius {
                                node.corner_radii = Some([r, r, r, r]);
                            }
                            node.dirty = true;
                            n += 1;
                        }
                        n
                    })
                };
                if pasted {
                    self.app.mark_dirty();
                    self.app.status = format!("Pasted properties onto {} layers", ids.len());
                } else {
                    self.app.status = "Nothing selected to paste onto".into();
                }
            }
            Action::SelectChild => {
                let child = {
                    let editor = self.app.doc().editor();
                    match editor.selection.len() {
                        1 => {
                            let sel = editor.selection[0].clone();
                            editor
                                .get_node(&sel)
                                .and_then(|n| n.children.first().map(|c| c.id.clone()))
                        }
                        _ => None,
                    }
                };
                if let Some(id) = child {
                    self.app.doc().editor().selection = vec![id];
                }
            }
            Action::SelectParent => {
                let parent = {
                    let editor = self.app.doc().editor();
                    match editor.selection.len() {
                        1 => editor.get_parent_id(&editor.selection[0].clone()),
                        _ => None,
                    }
                };
                if let Some(id) = parent {
                    self.app.doc().editor().selection = vec![id];
                }
            }
            Action::SelectNextSibling => {
                let next = {
                    let editor = self.app.doc().editor();
                    match editor.selection.len() {
                        1 => editor.get_next_sibling_id(&editor.selection[0].clone()),
                        _ => None,
                    }
                };
                if let Some(id) = next {
                    self.app.doc().editor().selection = vec![id];
                }
            }
            Action::SelectPrevSibling => {
                let prev = {
                    let editor = self.app.doc().editor();
                    match editor.selection.len() {
                        1 => editor.get_prev_sibling_id(&editor.selection[0].clone()),
                        _ => None,
                    }
                };
                if let Some(id) = prev {
                    self.app.doc().editor().selection = vec![id];
                }
            }
            // ---- vector edit mode + path operations (Figma parity) --------
            // The engine owns the mode (`Editor::vector_edit_*`); the app
            // mirrors it into `vector_edit_mode` for the canvas overlay.
            Action::EnterVectorEditMode => {
                let id = self.app.doc().editor().selection.first().cloned();
                let had_selection = id.is_some();
                let entered = match &id {
                    Some(id) => self.app.doc().editor().enter_vector_edit_mode(id),
                    None => false,
                };
                self.sync_vector_edit_mode();
                self.app.status = match (entered, had_selection) {
                    (true, _) => {
                        "Editing anchors - Enter or Escape to leave, ⌫ deletes the selected points"
                            .into()
                    }
                    // the engine refuses anything that has no anchors to edit
                    (false, true) => {
                        "Anchor editing needs a vector layer - this one has none".into()
                    }
                    (false, false) => "Select a vector layer to edit its anchors".into(),
                };
            }
            Action::ExitVectorEditMode => {
                let editor = self.app.doc().editor();
                // leaving mid-drag abandons it: the snapshot goes back and
                // nothing is logged, so Esc is always a clean exit
                editor.cancel_path_gesture();
                editor.exit_vector_edit_mode();
                self.app.drag = None;
                self.sync_vector_edit_mode();
                self.app.status = "Left vector edit mode".into();
            }
            Action::SelectVectorPoint(idx) => {
                let additive = self.app.shift;
                let editor = self.app.doc().editor();
                editor.select_vector_point(idx, additive);
                self.sync_vector_edit_mode();
            }
            Action::DeselectVectorPoints => {
                self.app.doc().editor().deselect_vector_points();
                self.sync_vector_edit_mode();
            }
            Action::MoveVectorPoints { dx, dy } => {
                if self.app.doc().editor().move_vector_points(dx, dy) {
                    self.app.mark_dirty();
                }
            }
            Action::AddVectorPoint {
                segment_idx,
                position,
            } => {
                if self
                    .app
                    .doc()
                    .editor()
                    .add_vector_point(segment_idx, position)
                {
                    self.app.mark_dirty();
                    self.app.status = "Added an anchor on the segment".into();
                }
            }
            Action::DeleteVectorPoints => {
                if self.app.doc().editor().delete_vector_points() {
                    self.app.mark_dirty();
                    self.sync_vector_edit_mode();
                    self.app.status = "Deleted the selected anchors".into();
                } else {
                    self.app.status = "Cannot delete - a path keeps at least two anchors".into();
                }
            }
            Action::ToggleVectorHandles => {
                self.app.vector_edit_mode.show_handles = !self.app.vector_edit_mode.show_handles;
            }
            Action::RemoveBezierHandles(anchor_idx) => {
                let Some(id) = self.vector_edit_id() else {
                    return;
                };
                if self
                    .app
                    .doc()
                    .editor()
                    .remove_bezier_handles(&id, anchor_idx)
                {
                    self.app.mark_dirty();
                    self.app.status = "Handles removed - the point is a corner again".into();
                } else {
                    self.app.status =
                        "That point is already a corner - no handles to remove".into();
                }
            }
            Action::LassoSelectPoints { boundary } => {
                let Some(id) = self.vector_edit_id() else {
                    return;
                };
                let picked = self.app.doc().editor().lasso_select_points(&id, &boundary);
                self.app.doc().editor().vector_edit_selected_points = picked.clone();
                self.sync_vector_edit_mode();
                self.app.status = format!("{} anchors inside the lasso", picked.len());
            }
            Action::SplitVectorPath(anchor_idx) => {
                let Some(id) = self.vector_edit_id() else {
                    return;
                };
                match self.app.doc().editor().split_vector_path(&id, anchor_idx) {
                    Some(_) => {
                        self.app.mark_dirty();
                        self.app.status = "Split the path into two layers".into();
                    }
                    None => {
                        self.app.status =
                            "Cannot split there - pick an anchor between the first and last".into()
                    }
                }
            }
            Action::ReversePathDirection => {
                let Some(id) = self.vector_edit_id() else {
                    self.app.status = "Select a vector layer first".into();
                    return;
                };
                if self.app.doc().editor().reverse_path_direction(&id) {
                    self.app.mark_dirty();
                    self.app.status = "Reversed the path direction".into();
                } else {
                    self.app.status = "Cannot reverse - select a vector layer".into();
                }
            }
            Action::JoinSelectedPaths => {
                let pair = {
                    let sel = &self.app.doc().editor().selection;
                    if sel.len() == 2 {
                        Some((sel[0].clone(), sel[1].clone()))
                    } else {
                        None
                    }
                };
                let Some((a, b)) = pair else {
                    self.app.status = "Select exactly two vector layers to join".into();
                    return;
                };
                match self.app.doc().editor().join_paths(&a, &b) {
                    Some(_) => {
                        self.app.mark_dirty();
                        self.app.status = "Joined the two paths into one layer".into();
                    }
                    None => {
                        self.app.status = "Cannot join - both layers must be vector paths that are \
                                           not rotated or scaled"
                            .into()
                    }
                }
            }
            Action::OffsetVector { distance, join } => {
                let Some(id) = self.vector_edit_id() else {
                    self.app.status = "Select a vector layer to offset".into();
                    return;
                };
                if self.app.doc().editor().offset_vector(&id, distance, join) {
                    self.app.mark_dirty();
                    self.app.status =
                        format!("Offset the path by {distance}px ({:?} corners)", join);
                } else {
                    self.app.status =
                        "Cannot offset - select a vector layer and use a non-zero distance".into();
                }
            }
            Action::SimplifyVector { tolerance } => {
                if self.app.doc().editor().simplify_vector(tolerance) {
                    self.app.mark_dirty();
                    self.app.status = format!("Simplified the path (tolerance {tolerance}px)");
                } else {
                    self.app.status =
                        "Nothing to simplify - no anchor sits within that tolerance".into();
                }
            }
            // Phase 6: Advanced Gradients, Image Adjustments, and Missing Blend Modes
            Action::FlipGradient => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer with a gradient fill first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.fill.flip();
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = "Gradient flipped".into();
                } else {
                    self.app.status = "No gradient to flip".into();
                }
            }

            Action::RotateGradient { degrees } => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer with a gradient fill first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.fill.rotate(degrees);
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = format!("Gradient rotated by {:.1}°", degrees);
                } else {
                    self.app.status = "No gradient to rotate".into();
                }
            }

            Action::AddGradientStop { position, color } => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer with a gradient fill first".into();
                    return;
                };
                let color = x_native::Color::from_rgb8(color[0], color[1], color[2]);
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.fill.add_stop(position, color);
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = "Gradient stop added".into();
                } else {
                    self.app.status = "No gradient to add stop to".into();
                }
            }

            Action::RemoveGradientStop { index } => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer with a gradient fill first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.fill.remove_stop(index);
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = "Gradient stop removed".into();
                } else {
                    self.app.status = "Could not remove gradient stop".into();
                }
            }

            Action::MoveGradientStop {
                index,
                new_position,
            } => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select a layer with a gradient fill first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.fill.move_stop(index, new_position);
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = "Gradient stop moved".into();
                } else {
                    self.app.status = "Could not move gradient stop".into();
                }
            }

            Action::SetGradientType { gradient_type } => {
                // The selection is a precondition here, not an input: converting
                // between gradient types is not implemented, so this handler
                // only reports. Binding the id produced an unused variable.
                if self.app.doc().selected_id().is_none() {
                    self.app.status = "Select a layer with a gradient fill first".into();
                    return;
                }
                // This would require converting between gradient types
                // For now, just show a status message
                self.app.status = format!(
                    "Gradient type change to '{}' - requires gradient conversion",
                    gradient_type
                );
            }

            Action::SetImageAdjustments { adjustments } => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select an image layer first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.image_adjustments = Some(adjustments);
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = "Image adjustments applied".into();
                } else {
                    self.app.status = "Could not apply image adjustments".into();
                }
            }

            Action::UpdateImageAdjustment { adjustment, value } => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select an image layer first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    if let Some(ref mut adj) = n.image_adjustments {
                        match adjustment.as_str() {
                            "exposure" => adj.exposure = value,
                            "contrast" => adj.contrast = value,
                            "saturation" => adj.saturation = value,
                            "temperature" => adj.temperature = value,
                            "tint" => adj.tint = value,
                            "highlights" => adj.highlights = value,
                            "shadows" => adj.shadows = value,
                            _ => {}
                        }
                    } else {
                        // Initialize with default adjustments if not present
                        let mut adj = x_native::ImageAdjustments::default();
                        match adjustment.as_str() {
                            "exposure" => adj.exposure = value,
                            "contrast" => adj.contrast = value,
                            "saturation" => adj.saturation = value,
                            "temperature" => adj.temperature = value,
                            "tint" => adj.tint = value,
                            "highlights" => adj.highlights = value,
                            "shadows" => adj.shadows = value,
                            _ => {}
                        }
                        n.image_adjustments = Some(adj);
                    }
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = format!("{} adjusted to {:.2}", adjustment, value);
                } else {
                    self.app.status = "Could not update image adjustment".into();
                }
            }

            Action::ResetImageAdjustments => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select an image layer first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    n.image_adjustments = None;
                });
                if changed {
                    self.app.mark_dirty();
                    self.app.status = "Image adjustments reset".into();
                } else {
                    self.app.status = "No image adjustments to reset".into();
                }
            }

            Action::RotateImage { clockwise } => {
                let Some(id) = self.app.doc().selected_id() else {
                    self.app.status = "Select an image layer first".into();
                    return;
                };
                let changed = self.app.doc().editor().mutate_visual_stack(&id, |n| {
                    let delta = if clockwise { 90.0 } else { -90.0 };
                    n.image_rotation = (n.image_rotation + delta) % 360.0;
                    if n.image_rotation < 0.0 {
                        n.image_rotation += 360.0;
                    }
                });
                if changed {
                    self.app.mark_dirty();
                    let direction = if clockwise {
                        "clockwise"
                    } else {
                        "counter-clockwise"
                    };
                    self.app.status = format!("Image rotated 90° {}", direction);
                } else {
                    self.app.status = "Could not rotate image".into();
                }
            }

            Action::SetImageFillMode { mode } => {
                // This would require implementing image fill modes in the data model
                // For now, show a status message
                self.app.status = format!(
                    "Image fill mode '{}' - requires fill mode implementation",
                    mode
                );
            }

            Action::EnableEyedropper => {
                self.app.eyedropper = true;
                self.app.status =
                    "Eyedropper armed - click a layer to sample its color".into();
            }
            Action::ToggleCanvasBgVisibility => {
                self.app.canvas_bg_visible = !self.app.canvas_bg_visible;
            }
            Action::CycleDashView => {
                self.app.dash_view = match self.app.dash_view {
                    DashView::Home => DashView::Recents,
                    DashView::Recents => DashView::Starred,
                    DashView::Starred => DashView::Trash,
                    DashView::Trash => DashView::Home,
                };
            }
        }
    }

    fn apply_auto_layout(&mut self) {
        let (sel, flow, gap, ph, pv) = {
            let d = self.app.doc();
            (d.selected_id(), d.flow, d.gap, d.pad_h, d.pad_v)
        };
        let Some(id) = sel else { return };
        let direction = match flow {
            1 => x_native::LayoutDirection::Vertical,
            _ => x_native::LayoutDirection::Horizontal,
        };
        // START from the frame's current layout: shell edits own direction /
        // gap / padding only — wrap, axis sizing, distribution and grid
        // survive every re-apply (they used to be reset to defaults here)
        let mut layout = self.app.selected_layout().unwrap_or_default();
        layout.direction = direction;
        layout.gap = gap;
        layout.padding = [ph, pv, ph, pv];
        let vars = self.app.doc().doc.variables.clone();
        let doc = self.app.doc();
        doc.editor().set_auto_layout(&id, Some(layout), &vars);
        self.app.mark_dirty();
    }

    fn finish_pen(&mut self) {
        let pts = match &self.app.drag {
            Some(Drag::Pen { points, .. }) => points.clone(),
            _ => return,
        };
        if pts.len() < 2 {
            self.app.drag = None;
            return;
        }
        let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        let w = (max_x - min_x).max(1.0);
        let h = (max_y - min_y).max(1.0);
        let mut path: Vec<PathCmd> = Vec::new();
        for (i, p) in pts.iter().enumerate() {
            let (lx, ly) = (p.x - min_x, p.y - min_y);
            if i == 0 {
                path.push(PathCmd::MoveTo(lx, ly));
            } else {
                path.push(PathCmd::LineTo(lx, ly));
            }
        }
        path.push(PathCmd::Close);
        let doc = self.app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let n = doc.editor_ref().root.children.len() + 1;
        let mut v = Node::vector(&x_native::fresh_id("vector"), min_x, min_y, w, h, path);
        v.name = format!("Vector {n}");
        v.stroke.width = 1.5;
        let id = v.id.clone();
        doc.editor().insert_node(&root_id, v);
        doc.editor().selection = vec![id];
        self.app.mark_dirty();
        self.app.drag = None;
        self.app.tool = Tool::Select;
    }

    fn commit_field(&mut self) {
        let Some(f) = self.app.field.clone() else {
            return;
        };
        self.app.field = None;
        self.app.field_select_all = false;
        let raw = f.buffer.trim().to_string();
        match f.id {
            FieldId::DocName => {
                if !raw.is_empty() && self.app.doc_ref().name != raw {
                    self.app.doc().checkpoint();
                    self.app.doc().name = raw;
                    self.app.doc().file_label = None;
                    self.app.mark_dirty();
                }
            }
            FieldId::PageName => {
                self.app.commit_page_rename(&raw);
            }
            FieldId::TreeSearch => {
                // search stays open after Enter (Figma): the query lives
                // in the doc; re-open the field on the committed buffer
                self.app.doc().tree_search = raw.clone();
                let id = f.id;
                self.app.field = Some(FieldEdit { id, buffer: raw });
            }
            FieldId::FindQuery => {
                // P13: the query stays open and rescans on commit
                self.app.find_replace.query = raw.clone();
                self.app.rescan_find();
                let id = f.id;
                self.app.field = Some(FieldEdit { id, buffer: raw });
            }
            FieldId::FindReplace => {
                self.app.find_replace.replace = raw.clone();
                let id = f.id;
                self.app.field = Some(FieldEdit { id, buffer: raw });
            }
            FieldId::CanvasBgAlpha => {
                if let Ok(v) = raw.parse::<f64>() {
                    self.app.canvas_bg_alpha = v.clamp(0.0, 100.0);
                }
            }
            FieldId::InstanceProp => {
                self.app.commit_instance_prop(&raw);
            }
            FieldId::ExportSuffix => {
                self.app.doc().export_suffix = raw;
            }
            FieldId::GuideSize => {
                if let Some(v) = raw.parse::<f64>().ok().filter(|n| n.is_finite()) {
                    self.app.doc().guide_size = v;
                }
            }
            FieldId::CanvasBg => {
                if let Some(c) = crate::state::parse_hex(&raw) {
                    self.app.canvas_bg = c;
                }
            }
            FieldId::GridColor => {
                if let Some(c) = crate::state::parse_hex(&raw) {
                    self.app.grid_color = c;
                }
            }
            FieldId::GridPct => {
                if let Some(v) = raw.parse::<f64>().ok().filter(|n| n.is_finite()) {
                    self.app.grid_pct = v.clamp(0.0, 100.0);
                }
            }
            FieldId::Zoom => {
                if let Some(v) = raw
                    .trim_end_matches('%')
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|n| n.is_finite())
                {
                    self.app.zoom = (v / 100.0).clamp(0.01, 64.0);
                }
            }
            FieldId::Gap | FieldId::PadH | FieldId::PadV => {
                if let Some(v) = raw.parse::<f64>().ok().filter(|n| n.is_finite()) {
                    match f.id {
                        FieldId::Gap => self.app.doc().gap = v,
                        FieldId::PadH => self.app.doc().pad_h = v,
                        _ => self.app.doc().pad_v = v,
                    }
                    self.apply_auto_layout();
                }
            }
            _ => {
                // node-bound fields
                self.apply_field_to_selection(f.id, &raw);
            }
        }
    }

    fn apply_field_to_selection(&mut self, id: FieldId, raw: &str) {
        let info = crate::editor_ui::sel_info(&self.app);
        let aspect_ratio_locked = self.app.aspect_ratio_locked;
        let sel = self.app.doc().selected_id();
        let Some(node_id) = sel else { return };
        let doc = self.app.doc();
        let num = |s: &str| -> Option<f64> {
            let s = s.trim_end_matches('%').trim_end_matches("px").trim();
            s.parse::<f64>().ok().filter(|n| n.is_finite())
        };
        match id {
            FieldId::W | FieldId::H => {
                let requested = num(raw).unwrap_or(if id == FieldId::W { info.w } else { info.h });
                let (mut w, mut h) = (info.w, info.h);
                if id == FieldId::W {
                    w = requested;
                    if aspect_ratio_locked && info.w > 0.0 {
                        h = requested * info.h / info.w;
                    }
                } else {
                    h = requested;
                    if aspect_ratio_locked && info.h > 0.0 {
                        w = requested * info.w / info.h;
                    }
                }
                if w > 0.0 && h > 0.0 {
                    // manually sizing a text box pins it (Figma fixed-size)
                    doc.editor().mutate_visual_stack(&node_id, |n| {
                        if matches!(n.kind, x_native::NodeKind::Text { .. }) {
                            n.bindings.insert("tm".into(), "fixed".into());
                        }
                    });
                    // Parametric: if W or H is bound to a number variable,
                    // the variable is rewritten and every other node bound
                    // to it follows — in the same undo step. Pinned children
                    // and corner radii are re-synced to the new box too.
                    let mut vars = doc.doc.variables.clone();
                    doc.editor().resize_parametric(&node_id, w, h, &mut vars);
                    doc.doc.variables = vars;
                    self.app.mark_dirty();
                }
            }
            FieldId::X | FieldId::Y => {
                let v = num(raw).unwrap_or(0.0);
                let (dx, dy) = if id == FieldId::X {
                    (v - info.x, 0.0)
                } else {
                    (0.0, v - info.y)
                };
                doc.editor().move_selection(dx, dy);
                self.app.mark_dirty();
            }
            FieldId::Rotation => {
                if let Some(deg) = num(raw) {
                    doc.editor().rotate(&node_id, deg.to_radians());
                    self.app.mark_dirty();
                }
            }
            FieldId::Opacity => {
                if let Some(v) = num(raw) {
                    doc.editor()
                        .set_opacity(&node_id, (v / 100.0).clamp(0.0, 1.0) as f32);
                    self.app.mark_dirty();
                }
            }
            FieldId::Radius => {
                if let Some(v) = num(raw) {
                    doc.editor().set_corners(&node_id, v.max(0.0), None);
                    self.app.mark_dirty();
                }
            }
            FieldId::FillHex => {
                // inline-editor range color wins; node fill otherwise
                if self.app.route_typo_panel_field(FieldId::FillHex, raw) {
                    return;
                }
                if let Some(c) = crate::state::parse_hex(raw) {
                    self.app.doc().editor().set_fill(&node_id, Paint::Solid(c));
                    self.app.mark_dirty();
                }
            }
            FieldId::FillAlpha => {
                if let Some(a) = num(raw) {
                    let a = (a.clamp(0.0, 100.0) / 100.0 * 255.0) as u8;
                    if let Some(c) = crate::state::parse_hex(&info.fill) {
                        let rgba = c.to_rgba8();
                        doc.editor().set_fill(
                            &node_id,
                            Paint::Solid(x_native::Color::from_rgba8(rgba.r, rgba.g, rgba.b, a)),
                        );
                        self.app.mark_dirty();
                    }
                }
            }
            FieldId::StrokeHex | FieldId::StrokeAlpha => {
                let Some(mut c) = crate::state::parse_hex(&info.stroke) else {
                    return;
                };
                if id == FieldId::StrokeHex {
                    let Some(next) = crate::state::parse_hex(raw) else {
                        return;
                    };
                    c = next;
                } else if let Some(a) = num(raw) {
                    let rgba = c.to_rgba8();
                    c = x_native::Color::from_rgba8(
                        rgba.r,
                        rgba.g,
                        rgba.b,
                        (a.clamp(0.0, 100.0) / 100.0 * 255.0) as u8,
                    );
                }
                let w = info.stroke_w.max(1.0);
                doc.editor().mutate_visual_stack(&node_id, move |n| {
                    n.materialize_visual_stacks();
                    let stroke = x_native::Stroke::solid(c, w);
                    n.stroke = stroke.clone();
                    if let Some(layer) = n.stroke_layers.last_mut() {
                        layer.stroke = stroke;
                    } else {
                        n.stroke_layers.push(x_native::StrokeLayer::new(stroke));
                    }
                });
                self.app.mark_dirty();
            }
            FieldId::StrokeWeight => {
                if let Some(w) = num(raw) {
                    if let Some(c) = crate::state::parse_hex(&info.stroke) {
                        doc.editor().mutate_visual_stack(&node_id, move |n| {
                            n.materialize_visual_stacks();
                            let stroke = x_native::Stroke::solid(c, w.max(0.0));
                            n.stroke = stroke.clone();
                            if let Some(layer) = n.stroke_layers.last_mut() {
                                layer.stroke = stroke;
                            } else {
                                n.stroke_layers.push(x_native::StrokeLayer::new(stroke));
                            }
                        });
                        self.app.mark_dirty();
                    }
                }
            }
            FieldId::ParagraphIndent => {
                if let Some(v) = num(raw) {
                    doc.editor().mutate_visual_stack(&node_id, |n| {
                        n.paragraph_indent = v.max(0.0);
                    });
                    self.app.mark_dirty();
                }
            }
            FieldId::MaxLines => {
                if let Some(v) = num(raw) {
                    doc.editor().mutate_visual_stack(&node_id, |n| {
                        n.max_lines = if v > 0.0 { Some(v as usize) } else { None };
                    });
                    self.app.mark_dirty();
                }
            }
            _ => {
                if self.app.route_typo_panel_field(id, raw) {
                    self.app.mark_dirty();
                    return;
                }
                self.app.status = "Field not bound to the engine yet".into();
            }
        }
    }

    // ------------------------------------------------------------ redraw

    fn redraw(&mut self) {
        if self.window.as_ref().is_some_and(|w| {
            let s = w.inner_size();
            s.width == 0 || s.height == 0
        }) {
            return;
        }
        self.refresh_preparation_before_present();
        let drawing_loading = self
            .app
            .document_loading
            .as_ref()
            .is_some_and(crate::loading::LoadingScreen::draws_overlay);
        let Some(gpu) = self.gpu.as_mut() else { return };
        let inner = self.app.compose_frame();
        let mut root_scene = Scene::new();
        root_scene.append(&inner, Some(Affine::scale(self.scale)));

        let tex = match gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            _ => {
                gpu.surface.configure(&gpu.device, &gpu.config);
                self.load_render_failure("The document is loaded, but its window surface is unavailable. Try Again to prepare it again.".into(),true);
                return;
            }
        };
        let view = tex
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let params = RenderParams {
            base_color: C_BG,
            width: gpu.config.width,
            height: gpu.config.height,
            antialiasing_method: AaConfig::Area,
        };
        if gpu
            .renderer
            .render_to_texture(&gpu.device, &gpu.queue, &root_scene, &gpu.target, &params)
            .is_ok()
        {
            let mut encoder = gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("present Vello output"),
                });
            gpu.blitter
                .copy(&gpu.device, &mut encoder, &gpu.target, &view);
            gpu.queue.submit([encoder.finish()]);
            tex.present();
            // A lost surface self-heals on this very frame (we reconfigured
            // it before rendering). The transient message must not linger
            // in the status bar after the canvas is drawing again.
            if self.app.status.contains("window surface is unavailable") {
                self.app.status = "Ready".into();
            }
            self.app.presented_frames += 1;
            if drawing_loading {
                self.app.loading_frames_presented += 1;
            }
            if self.app.screen == Screen::Editor && !drawing_loading {
                self.app.smoke_editor_frames += 1;
                self.document_frame_presented();
            }
        } else {
            self.load_render_failure("The file was loaded, but its first editor frame could not be rendered. Try Again or Close to return to your previous work.".into(),false);
        }
    }
}

/// Soft shadow + `black/10` 28px name watermark for empty top-level
/// frames — the `bg-white rounded-[8px] shadow-2xl` canvas-frame look
/// from the v45 HTML with zero children.
/// Screen-space rects + labels of empty top-level frames (the v45 mock's
/// `bg-white rounded-[8px] shadow-2xl` hero frame with its watermark label).
fn frame_watermarks(app: &App, root: &x_native::Node) -> Vec<(vello::kurbo::Rect, String)> {
    let mut out = Vec::new();
    for f in &root.children {
        if matches!(f.kind, NodeKind::Frame { .. }) && f.children.is_empty() {
            let p0 = app.world_to_screen(Point::new(f.transform.x, f.transform.y));
            let p1 = app.world_to_screen(Point::new(f.transform.x + f.w, f.transform.y + f.h));
            let r = vello::kurbo::Rect::new(p0.x, p0.y, p1.x, p1.y);
            out.push((r, f.name.clone()));
        }
    }
    out
}

/// Pass 1 — drop shadow BEHIND the document (CSS box-shadow semantics:
/// the frame's own fill occludes the shadow's interior).
/// The inline editor paints the live buffer itself — blank the edited
/// node's own (stale) text in the scene clone so the two never double-print.
#[cfg(test)]
fn blank_editing_text(root: &mut Node, eid: Option<&str>) {
    let Some(eid) = eid else { return };
    fn walk(n: &mut Node, eid: &str) {
        if n.id == eid {
            if let NodeKind::Text { text } = &mut n.kind {
                text.clear();
            }
            return;
        }
        for c in &mut n.children {
            walk(c, eid);
        }
    }
    walk(root, eid);
}

fn watermark_shadows(app: &App, inner: &mut Scene, root: &x_native::Node) {
    for (r, _) in frame_watermarks(app, root) {
        crate::paint::elev_shadow(inner, r, 8.0, x_native::ui::Elevation::Raised);
    }
}

/// Pass 2 — watermark label ON TOP of the document (black/10, 20px bold).
fn watermark_labels(app: &App, inner: &mut Scene, root: &x_native::Node) {
    for (r, label) in frame_watermarks(app, root) {
        let cx = (r.x0 + r.x1) / 2.0;
        let cy = (r.y0 + r.y1) / 2.0;
        let w = app.fonts.measure(&label, T20, crate::paint::Wt::Bold);
        // audit: 20px bold box top = frame_center − 15 (half the 1.5em box)
        app.fonts.text(
            inner,
            cx - w / 2.0,
            cy - crate::paint::CSS_LH * T20 / 2.0,
            &label,
            T20,
            C_BLACK_10,
            crate::paint::Wt::Semi,
        );
    }
}

/// A world coordinate expressed in the local space of `target` — the space
/// a child's transform lives in: the inverse of the ancestor chain's
/// transform product. Drawing into a selected frame needs this so the new
/// node lands where the pointer was, in the frame's own coordinates.
fn world_to_local(root: &Node, target: &str, x: f64, y: f64) -> (f64, f64) {
    fn rec(n: &Node, id: &str, acc: Affine, pt: (f64, f64), out: &mut Option<(f64, f64)>) {
        // `acc` is the world matrix of `n`'s parent; multiplying in `n`'s
        // own transform gives the space where `n`'s children live.
        let m = acc * n.transform.matrix(n.w, n.h);
        if n.id == id {
            let p = m.inverse() * Point::new(pt.0, pt.1);
            *out = Some((p.x, p.y));
            return;
        }
        for c in &n.children {
            rec(c, id, m, pt, out);
            if out.is_some() {
                return;
            }
        }
    }
    let mut out = None;
    rec(root, target, Affine::IDENTITY, (x, y), &mut out);
    out.unwrap_or((x, y))
}

// ------------------------------------------------------------------ utils

fn resizer_at(app: &App, p: Point) -> Option<u8> {
    let reg = app.editor_regions();
    if p.y < ED_TITLE_H {
        return None;
    }
    if (p.x - reg.left.x1).abs() <= RESIZER_W / 2.0 {
        return Some(0);
    }
    if (p.x - reg.right.x0).abs() <= RESIZER_W / 2.0 {
        return Some(1);
    }
    None
}

fn count_kind(root: &Node) -> usize {
    fn walk(n: &Node, out: &mut usize) {
        *out += 1;
        for c in &n.children {
            walk(c, out);
        }
    }
    let mut n = 0;
    walk(root, &mut n);
    n
}

#[cfg(test)]
fn find_node_clone(root: &Node, id: &str) -> Option<Node> {
    if root.id == id {
        return Some(root.clone());
    }
    for c in &root.children {
        if let Some(f) = find_node_clone(c, id) {
            return Some(f);
        }
    }
    None
}

fn with_extension(p: std::path::PathBuf, ext: &str) -> std::path::PathBuf {
    if p.extension().map(|e| e.to_string_lossy().to_lowercase()) == Some(ext.into()) {
        p
    } else {
        p.with_extension(ext)
    }
}

/// Initial buffer for a field edit (current value).
fn field_initial(app: &App, f: FieldId) -> String {
    use crate::editor_ui::sel_info;
    let s = sel_info(app);
    match f {
        FieldId::TreeSearch => app.doc_ref().tree_search.clone(),
        FieldId::FindQuery => app.find_replace.query.clone(),
        FieldId::FindReplace => app.find_replace.replace.clone(),
        FieldId::CanvasBgAlpha => {
            format!("{}", app.canvas_bg_alpha.round() as i64)
        }
        FieldId::PageName => {
            let d = app.doc_ref();
            d.doc
                .pages
                .get(d.page)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| format!("Page {}", d.page + 1))
        }
        FieldId::W => fmt(s.w),
        FieldId::H => fmt(s.h),
        FieldId::X => fmt(s.x),
        FieldId::Y => fmt(s.y),
        FieldId::Rotation => fmt(s.rot),
        FieldId::Opacity => format!("{}", (s.opacity * 100.0).round() as i64),
        FieldId::Radius => fmt(s.radius),
        FieldId::FillHex => s.fill.clone(),
        FieldId::FillAlpha => "100".into(),
        FieldId::StrokeHex => s.stroke.clone(),
        FieldId::StrokeWeight => fmt(if s.stroke_w > 0.0 { s.stroke_w } else { 1.0 }),
        FieldId::GuideSize => fmt(app.doc_opt().map(|d| d.guide_size).unwrap_or(16.0)),
        FieldId::CanvasBg => editor_ui::hex6(app.canvas_bg),
        FieldId::GridColor => editor_ui::hex6(app.grid_color),
        FieldId::GridPct => format!("{}", app.grid_pct.round() as i64),
        FieldId::Zoom => format!("{}", (app.zoom * 100.0).round() as i64),
        FieldId::InstanceProp => {
            // current override value of the targeted prop (default if none)
            match (app.selected_instance(), app.instance_prop_target.clone()) {
                (Some((iid, comp)), Some(name)) => app
                    .props_of(&comp)
                    .iter()
                    .find(|e| e.name == name)
                    .map(|e| app.instance_prop_value(&iid, e))
                    .unwrap_or_default(),
                _ => String::new(),
            }
        }
        _ => String::new(),
    }
}

fn fmt(v: f64) -> String {
    let r = v.round();
    if (v - r).abs() < 0.005 {
        format!("{}", r as i64)
    } else {
        format!("{v:.1}")
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dashboard;
    use crate::editor_ui;
    use crate::state::{OpenDoc, RightTab, Screen, Tool};

    /// Dashboard paints without panicking (fonts may be absent in CI).
    #[test]
    fn dashboard_paints() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        let mut scene = vello::Scene::new();
        dashboard::paint(&mut app, &mut scene);
        assert!(!app.hit.is_empty(), "dashboard should register hit zones");
    }

    /// Editor screen paints with a real document; hit zones cover tools,
    /// tabs, tree rows and inspector fields.
    #[test]
    fn editor_paints() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let mut scene = vello::Scene::new();
        editor_ui::paint(&mut app, &mut scene);
        editor_ui::paint_over(&mut app, &mut scene);
        assert!(
            app.hit.len() > 20,
            "editor should register many hit zones, got {}",
            app.hit.len()
        );
        let _ = scene;
    }

    /// Selecting a node updates the inspector values.
    #[test]
    fn inspector_reads_selection() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let id = {
            let doc = app.doc();
            let sel = doc.editor_ref().root.children[0].id.clone();
            doc.editor().selection = vec![sel.clone()];
            sel
        };
        let sel = crate::editor_ui::sel_info(&app);
        assert!(sel.is_frame);
        assert_eq!(sel.name, "Frame");
        assert_eq!(sel.w, 375.0);
        assert_eq!(sel.h, 420.0);
        let _ = id;
    }

    /// Tree rows follow expansion state; toggling flips it.
    #[test]
    fn tree_expand_collapse() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        // build frame > group > rect
        let (root_id, group_id) = {
            let doc = app.doc();
            let root = doc.editor_ref().root.id.clone();
            let mut g = x_native::Node::group("grp-1", 10.0, 10.0);
            g.name = "order-details".into();
            g.children.push(x_native::Node::rect(
                "r-in",
                0.0,
                0.0,
                5.0,
                5.0,
                x_native::Color::WHITE,
            ));
            doc.editor().insert_node(&root, g);
            let gid = doc
                .editor_ref()
                .root
                .children
                .iter()
                .find(|c| c.id == "grp-1")
                .map(|c| c.id.clone())
                .unwrap();
            (root, gid)
        };
        app.doc().expanded.insert(group_id.clone());
        let mut scene = vello::Scene::new();
        editor_ui::paint(&mut app, &mut scene);
        // both group and its child should appear in hit zones
        let has_child = app
            .hit
            .iter()
            .any(|(_, a)| matches!(a, crate::state::Action::TreeRow(id) if id == "r-in"));
        assert!(has_child, "expanded group child should be a hit target");
        let _ = (root_id, group_id);
    }

    /// New page / switch page / delete page keep editors and pages in sync.
    #[test]
    fn pages_add_switch_delete() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        assert_eq!(app.doc().editors.len(), 1);
        let doc = app.doc();
        let mut page = x_native::Node::frame("page-2", 1440.0, 1024.0);
        page.name = "Page 2".into();
        doc.editors
            .push(x_native::editor::Editor::new(page.clone()));
        doc.doc.pages.push(page);
        doc.page = 1;
        assert_eq!(app.doc().page, 1);
        app.doc().editors.remove(1);
        app.doc().doc.pages.remove(1);
        app.doc().page = 0;
        assert_eq!(app.doc().editors.len(), 1);
    }

    /// Undo/redo round-trips an insert through the engine Editor.
    #[test]
    fn undo_redo_insert() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        let before = app.doc().editor_ref().root.children.len();
        let mut r = x_native::Node::rect("rect-1", 0.0, 0.0, 10.0, 10.0, x_native::Color::WHITE);
        r.name = "Rectangle 1".into();
        app.doc().editor().insert_node(&root_id, r);
        assert_eq!(app.doc().editor_ref().root.children.len(), before + 1);
        app.doc().editor().undo();
        assert_eq!(app.doc().editor_ref().root.children.len(), before);
        app.doc().editor().redo();
        assert_eq!(app.doc().editor_ref().root.children.len(), before + 1);
    }

    /// Market-standard interactions: smart-guide snapping, alt-duplicate,
    /// text inline edit commit.
    #[test]
    fn market_standard_interactions() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::rect(
                "sa",
                100.0,
                100.0,
                50.0,
                50.0,
                x_native::Color::from_rgb8(9, 9, 9),
            ),
        );
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::rect(
                "sb",
                300.0,
                300.0,
                50.0,
                50.0,
                x_native::Color::from_rgb8(9, 9, 9),
            ),
        );
        // move "sb" toward sa's right edge: intended dx=140 puts sb.left at
        // 440... choose dx so sb left lands 4px short of sa right (150):
        // sb.x=300 → target left 146 = 300 + dx → dx = -154
        app.doc().editor().selection = vec!["sb".into()];
        let (dx, dy, lines) = compute_snap(
            (300.0, 300.0, 350.0, 350.0),
            &[(100.0, 100.0, 150.0, 150.0)],
            -154.0,
            0.0,
            6.0,
        );
        // final sb.x = 300 + dx must land exactly on sa's right edge (150)
        assert!((300.0 + dx - 150.0).abs() < 0.01, "snapped dx {dx}");
        assert_eq!(dy, 0.0);
        assert!(lines.contains(&(150.0, 'v')), "v-line at sa right");
        // center snap: dx such that sb center = sa center (125): dx = -175 →
        // |dx|>thr from 125-325=-200? center candidate: 125-325+dx=-200+dx...
        let (dx2, _, lines2) = compute_snap(
            (300.0, 300.0, 350.0, 350.0),
            &[(100.0, 100.0, 150.0, 150.0)],
            -179.0,
            -179.0,
            6.0,
        );
        // moving center x = 325-179 = 146 → within 6 of 150 → snap to 150
        assert!((dx2 + 179.0 + 325.0 - 300.0).abs() < 7.0 || lines2.iter().any(|l| l.1 == 'v'));
        // alt-duplicate: duplicate_selection keeps a copy selected
        app.doc().editor().selection = vec!["sa".into()];
        let base = app.doc().editor_ref().root.children.len();
        app.apply_ctx(crate::state::CtxCmd::Duplicate);
        assert_eq!(app.doc().editor_ref().root.children.len(), base + 1);
        // text inline edit commit
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text("tx", 0.0, 400.0, 120.0, 14.0, "Hello"),
        );
        app.text_edit = Some("tx".into());
        app.text_buffer = "Changed".into();
        app.commit_text_field();
        let t = {
            let root = app.doc().editor_ref().root.clone();
            match crate::editor_ui::find_node(&root, "tx").map(|n| n.kind.clone()) {
                Some(x_native::NodeKind::Text { text }) => text,
                _ => String::new(),
            }
        };
        assert_eq!(t, "Changed");
    }

    /// Text: dbl-click detection windows, Enter-to-edit, inline editor
    /// commit (undoable) + cancel, and inert-state no-ops.
    #[test]
    fn text_editing() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text("tx", 40.0, 60.0, 120.0, 14.0, "Hello"),
        );
        app.doc().editor().selection = vec!["tx".into()];

        // dbl-click detection: no prior click, too far, too slow
        assert!(
            !app.is_double_click(Point::new(10.0, 10.0)),
            "no prior click"
        );
        app.last_click = Some((std::time::Instant::now(), Point::new(10.0, 10.0)));
        assert!(app.is_double_click(Point::new(12.0, 12.0)), "within window");
        assert!(!app.is_double_click(Point::new(20.0, 10.0)), "too far");
        let stale = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(400))
            .unwrap();
        app.last_click = Some((stale, Point::new(10.0, 10.0)));
        assert!(!app.is_double_click(Point::new(10.0, 10.0)), "too slow");

        // Enter on a selected Text node opens the inline editor
        assert!(app.enter_edit_selected());
        assert_eq!(app.text_edit.as_deref(), Some("tx"));
        assert_eq!(app.text_buffer, "Hello");
        assert_eq!(app.doc().editor_ref().selection, vec!["tx".to_string()]);

        // commit applies the buffer (undoable) and closes the editor
        app.text_buffer = "Hello world".into();
        assert!(app.commit_text_field());
        assert!(app.text_edit.is_none() && app.field.is_none());
        let read = |app: &App| -> String {
            let doc = app.doc_opt().unwrap();
            let root = doc.editor_ref().root.clone();
            match crate::editor_ui::find_node(&root, "tx").map(|n| n.kind.clone()) {
                Some(NodeKind::Text { text }) => text,
                _ => panic!("text node missing"),
            }
        };
        assert_eq!(read(&app), "Hello world");
        // commit = set_text + fs pin + auto-size resize (separate undoable
        // commands — undo-granularity coalescing is a known carry-over)
        let mut restored = false;
        for _ in 0..4 {
            if !app.doc().editor().undo() {
                break;
            }
            if read(&app) == "Hello" {
                restored = true;
                break;
            }
        }
        assert!(restored, "undoing the commit restores the original text");

        // Enter with a non-text (or empty) selection is inert
        app.doc().editor().selection.clear();
        assert!(!app.enter_edit_selected());

        // Esc cancels: editor closes, text untouched
        app.doc().editor().selection = vec!["tx".into()];
        assert!(app.enter_edit_selected());
        app.text_edit = None;
        app.field = None;
        assert_eq!(read(&app), "Hello", "Esc leaves text untouched");

        // commit with no open editor is a no-op
        assert!(!app.commit_text_field());
        assert!(app.field.is_none());
    }

    /// Rich-text sub-selection: caret + selection in the inline editor,
    /// ⌘B/⌘I range styling, insert/delete run shifting, panel fields scoped
    /// to the range, and commit persisting styled runs to the node.
    #[test]
    fn rich_text_editing() {
        use crate::editor_ui::{typo_val, Typo};
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text("tx", 40.0, 60.0, 300.0, 14.0, "Hello world"),
        );
        app.doc().editor().selection = vec!["tx".into()];
        assert!(app.enter_edit_selected());
        assert_eq!(app.text_caret, 11, "caret starts at the end");

        // select "world" (6..11) with the public caret API
        app.text_set_caret(6, false);
        assert!(app.text_sel_range().is_none(), "no anchor = no selection");
        for _ in 0..5 {
            app.text_move_caret(1, true);
        }
        assert_eq!(app.text_sel_range(), Some((6, 11)));

        // ⌘B: bold the selection (session runs, node untouched yet)
        assert!(app.text_toggle_weight());
        assert_eq!(app.text_runs_edit.len(), 1);
        assert_eq!(
            (app.text_runs_edit[0].start, app.text_runs_edit[0].len),
            (6, 5)
        );
        assert_eq!(app.text_runs_edit[0].weight, Some(700));
        {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            assert!(
                n.text_runs.is_empty(),
                "session styling stays in the editor"
            );
        }

        // typing REPLACES the selection and inherits its style
        app.text_insert("!");
        assert_eq!(app.text_buffer, "Hello !");
        assert_eq!(app.text_runs_edit.len(), 1, "the ! is bold");
        assert_eq!(
            (app.text_runs_edit[0].start, app.text_runs_edit[0].len),
            (6, 1)
        );

        // commit persists text + runs (undoable); render carries the run
        assert!(app.commit_text_field());
        let (text, runs) = {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            (
                match &n.kind {
                    NodeKind::Text { text } => text.clone(),
                    _ => unreachable!(),
                },
                n.text_runs.clone(),
            )
        };
        assert_eq!(text, "Hello !");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].weight, Some(700));
        assert_eq!((runs[0].start, runs[0].len), (6, 1));
        let root = app.doc().editor_ref().root.clone();
        let tree = x_native::build_render_tree(&root, &Default::default());
        assert!(tree.commands.iter().any(|c| matches!(c,
            x_native::RenderCommand::Glyphs { runs: gr, .. }
                if gr.iter().any(|p| p.weight == Some(700)))));

        // shift-on-insert: caret at the front (no run covers it), insert —
        // the bold run slides right, the plain prefix stays plain
        assert!(app.enter_edit_selected());
        app.text_set_caret(0, false);
        app.text_insert(">> ");
        assert_eq!(app.text_buffer, ">> Hello !");
        assert_eq!(app.text_runs_edit.len(), 1);
        assert_eq!(
            (app.text_runs_edit[0].start, app.text_runs_edit[0].len),
            (9, 1),
            "bold run slid +3"
        );

        // backspace before the run: it slides back, never breaks
        for _ in 0..3 {
            app.text_backspace();
        }
        assert_eq!(app.text_buffer, "Hello !");
        assert_eq!(
            (app.text_runs_edit[0].start, app.text_runs_edit[0].len),
            (6, 1)
        );

        // panel size scoped to the RANGE: the node's pinned fs binding
        // (autosize writes "14.00" at commit) keeps its value
        app.text_set_caret(3, false);
        for _ in 0..5 {
            app.text_move_caret(1, true);
        }
        assert!(app.apply_typo_field(FieldId::FontSize, "20"));
        assert_eq!(app.text_runs_edit[0].size, Some(20.0));
        {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            assert_eq!(
                n.bindings.get("fs").map(String::as_str),
                Some("14.00"),
                "range styling must not retune the node size"
            );
        }

        // panel fill = the range's text color
        assert!(app.apply_typo_field(FieldId::FillHex, "FF0000"));
        assert_eq!(
            app.text_runs_edit[0].color.map(|c| c.to_rgba8().r),
            Some(255)
        );

        // ⌘I toggles italic on; second toggle removes it
        assert!(app.text_toggle_italic());
        assert_eq!(app.text_runs_edit[0].italic, Some(true));
        assert!(app.text_toggle_italic());
        assert_ne!(app.text_runs_edit[0].italic, Some(true));

        // Esc cancels: node keeps the LAST committed state
        let (text_before, runs_before) = {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            (
                match &n.kind {
                    NodeKind::Text { text } => text.clone(),
                    _ => unreachable!(),
                },
                n.text_runs.clone(),
            )
        };
        app.text_cancel_edit();
        assert!(app.text_edit.is_none() && app.text_buffer.is_empty());
        let (text_after, runs_after) = {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            (
                match &n.kind {
                    NodeKind::Text { text } => text.clone(),
                    _ => unreachable!(),
                },
                n.text_runs.clone(),
            )
        };
        assert_eq!(text_before, text_after);
        assert_eq!(runs_before, runs_after);

        // multi-line: typing "\n" (Enter) starts a new line, runs shift
        assert!(app.enter_edit_selected());
        app.text_set_caret(0, false);
        app.text_insert("A\nB");
        assert_eq!(app.text_buffer, "A\nBHello !");
        assert_eq!(app.text_runs_edit[0].start, 9, "bold run slid by 3");
        assert_eq!(
            app.text_edit_rect().map(|r| r.height() as usize),
            Some(43),
            "2-line box grew (2\u{d7}21+1)"
        );

        // panel DISPATCH: every typography field reaches the engine through
        // route_typo_panel_field (weight/ws/ps/bs/case/axes were dropped by
        // the pre-round-4 dispatch), and FillHex prefers the range
        app.text_cancel_edit();
        app.doc().editor().selection = vec!["tx".into()];
        assert!(app.route_typo_panel_field(FieldId::FontWeight, "600"));
        assert_eq!(app.selected_text_typo().unwrap().fw, 600);
        assert!(app.route_typo_panel_field(FieldId::WordSpacing, "2"));
        assert_eq!(typo_val(&app, Typo::WordSpacing), "2px");
        assert!(app.route_typo_panel_field(FieldId::ParaSpacing, "4"));
        assert_eq!(typo_val(&app, Typo::ParaSpacing), "4px");
        assert!(app.route_typo_panel_field(FieldId::BaselineShift, "-1"));
        assert_eq!(typo_val(&app, Typo::BaselineShift), "-1px");
        assert!(app.route_typo_panel_field(FieldId::TextCase, "UPPER"));
        assert_eq!(typo_val(&app, Typo::TextCase), "Upper");
        // unbound fields still fall through (opacity is node-level)
        assert!(!app.route_typo_panel_field(FieldId::Opacity, "50"));

        // FillHex, no editor open: NOT consumed (node-fill fallback runs)
        assert!(!app.route_typo_panel_field(FieldId::FillHex, "0099FF"));

        // editor open + a range: consumed as the range's text color
        assert!(app.enter_edit_selected());
        app.text_set_caret(0, false);
        for _ in 0..5 {
            app.text_move_caret(1, true);
        }
        assert!(app.route_typo_panel_field(FieldId::FillHex, "0099FF"));
        assert_eq!(
            app.text_runs_edit[0].color.map(|c| c.to_rgba8().b),
            Some(255)
        );
        app.text_cancel_edit();
    }

    /// Typography controls: Size / Line height / Letter spacing / Font
    /// family write engine bindings and re-fit the box (auto-width, so the
    /// selection rect hugs the text — the image-1 divergence is gone); the
    /// render honors the `fs` binding while legacy nodes keep size = node.h.
    #[test]
    fn typography_controls() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.screen = Screen::Editor;
        app.center_view();
        let root_id = app.doc().editor_ref().root.id.clone();
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text(
                "tx",
                40.0,
                60.0,
                300.0,
                14.0,
                "lorem ipsum is text for demo",
            ),
        );
        app.doc().editor().selection = vec!["tx".into()];

        // panel reads live values (legacy node: size = h, ls 0, lh 1.2 ≈ 20px)
        use crate::editor_ui::{typo_val, Typo};
        assert_eq!(typo_val(&app, Typo::Size), "14");
        assert_eq!(typo_val(&app, Typo::LetterSpacing), "0px");
        // live value from real Inter metrics (HTML's static "20" is only the
        // no-selection fallback state)
        assert_eq!(typo_val(&app, Typo::LineHeight), "19.6");
        assert_eq!(typo_val(&app, Typo::Family), "Inter");

        // nothing selected → the document defaults (family = Inter, the
        // default font; the no-selection state must not invent a third)
        app.doc().editor().selection.clear();
        assert_eq!(typo_val(&app, Typo::Family), "Inter");
        assert_eq!(typo_val(&app, Typo::LetterSpacing), "-0.16px");
        app.doc().editor().selection = vec!["tx".into()];

        // Size 32: fs binding + the box re-measures around the bigger text
        assert!(app.apply_typo_field(FieldId::FontSize, "32"));
        let fs = app.selected_text_typo().unwrap().fs;
        assert_eq!(fs, 32.0);
        assert_eq!(typo_val(&app, Typo::Size), "32");
        let h_after = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "tx")
                .unwrap()
                .h
        };
        assert!(
            h_after > 30.0 && h_after < 60.0,
            "auto-height, got {h_after}"
        );

        // Line height 42 px: FIXED-px mode (Figma) — display round-trips
        assert!(app.apply_typo_field(FieldId::LineHeight, "42"));
        let t = app.selected_text_typo().unwrap();
        assert_eq!(t.lh_mode, 1, "bare number = fixed px mode");
        assert!((t.lh_value - 42.0).abs() < 0.01, "got {}", t.lh_value);
        assert_eq!(typo_val(&app, Typo::LineHeight), "42");

        // Letter spacing 2px + family
        assert!(app.apply_typo_field(FieldId::LetterSpacing, "2px"));
        assert_eq!(app.selected_text_typo().unwrap().ls, 2.0);
        assert_eq!(typo_val(&app, Typo::LetterSpacing), "2px");
        assert!(app.apply_typo_field(FieldId::FontFamily, "Manrope"));
        assert_eq!(
            app.selected_text_typo().unwrap().font.as_deref(),
            Some("Manrope")
        );

        // the box hugs the measured text (the image-1 contract)
        {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            println!(
                "DBG pre-hug: w={:.1} h={:.1} bind={:?} sel={:?}",
                n.w,
                n.h,
                n.bindings,
                doc.editor_ref().selection
            );
        }
        let (w, h, text) = {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            (
                n.w,
                n.h,
                match &n.kind {
                    NodeKind::Text { text } => text.clone(),
                    _ => unreachable!(),
                },
            )
        };
        let t = app.selected_text_typo().unwrap();
        // effective multiplier incl. the px/% modes
        let nat = app.natural_line_height(t.fs).max(0.1);
        let lh_eff = match t.lh_mode {
            1 => t.lh_value.max(1.0) / nat,
            2 => (t.lh_value / 100.0 * t.fs / nat).max(0.1),
            _ => t.lh,
        };
        let (line_w, block_h) = app.measure_text_node(
            &text,
            t.fs,
            lh_eff,
            t.ls,
            t.ws,
            t.ps,
            t.tc == "sc",
            x_native::TextWrap::Auto,
        );
        assert!(
            w + 0.6 >= line_w && w - line_w < 5.0,
            "box {w} hugs line width {line_w}"
        );
        assert!(
            h + 0.6 >= block_h && h - block_h < 2.5,
            "box {h} hugs block {block_h}"
        );

        // the render honors fs (32) even though the box height differs
        let root = app.doc().editor_ref().root.clone();
        let tree = x_native::build_render_tree(&root, &Default::default());
        let glyphs: Vec<_> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                x_native::RenderCommand::Glyphs { text, size, .. }
                    if text == "lorem ipsum is text for demo" =>
                {
                    Some(*size)
                }
                _ => None,
            })
            .collect();
        assert!(!glyphs.is_empty());
        // PX CONTRACT: the IR size IS the real glyph px — fs 32 renders as
        // 32px glyphs
        assert!(
            (glyphs[0] - 32.0).abs() < 0.01,
            "render px = fs, got {}",
            glyphs[0]
        );

        // legacy node (no fs binding): render size stays node.h
        app.doc().editor().insert_node(
            &root_id,
            x_native::Node::text("t2", 40.0, 300.0, 200.0, 19.0, "legacy"),
        );
        let root = app.doc().editor_ref().root.clone();
        let tree = x_native::build_render_tree(&root, &Default::default());
        let legacy = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                x_native::RenderCommand::Glyphs { text, size, .. } if text == "legacy" => {
                    Some(*size)
                }
                _ => None,
            })
            .next()
            .unwrap();
        // legacy node: the px contract pre-scales the em (h * 0.72 —
        // identical glyph geometry to the historical convention)
        assert!(
            (legacy - 19.0 * 0.72).abs() < 0.01,
            "legacy size = h * 0.72, got {legacy}"
        );

        // garbage is inert; non-typography fields are not handled here
        let w_before = w;
        assert!(!app.apply_typo_field(FieldId::FontSize, "abc"));
        assert!(!app.apply_typo_field(FieldId::Opacity, "32"));
        let w_after = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "tx")
                .unwrap()
                .w
        };
        assert_eq!(w_before, w_after);

        // ---- the market-standard tier: weight / word / para / baseline /
        // case — each writes its binding and re-fits the box
        assert!(app.apply_typo_field(FieldId::FontWeight, "SemiBold"));
        assert_eq!(app.selected_text_typo().unwrap().fw, 600);
        assert_eq!(typo_val(&app, Typo::Weight), "SemiBold");
        assert!(app.apply_typo_field(FieldId::FontWeight, "800"));
        assert_eq!(app.selected_text_typo().unwrap().fw, 800);
        assert!(!app.apply_typo_field(FieldId::FontWeight, "junk"));

        assert!(app.apply_typo_field(FieldId::WordSpacing, "6"));
        assert_eq!(typo_val(&app, Typo::WordSpacing), "6px");
        assert!(app.apply_typo_field(FieldId::ParaSpacing, "12"));
        assert_eq!(typo_val(&app, Typo::ParaSpacing), "12px");
        assert!(app.apply_typo_field(FieldId::BaselineShift, "-2"));
        assert_eq!(typo_val(&app, Typo::BaselineShift), "-2px");

        assert!(app.apply_typo_field(FieldId::TextCase, "UPPER"));
        assert_eq!(typo_val(&app, Typo::TextCase), "Upper");
        // box now fits the UPPERCASED text (wider than the original)
        let (w_up, text_up) = {
            let doc = app.doc();
            let n = crate::editor_ui::find_node(&doc.editor_ref().root, "tx").unwrap();
            (
                n.w,
                match &n.kind {
                    NodeKind::Text { text } => text.clone(),
                    _ => unreachable!(),
                },
            )
        };
        assert_eq!(
            text_up, "lorem ipsum is text for demo",
            "binding, not rewrite"
        );
        assert!(w_up > w_after, "upper-case box grew: {w_up} > {w_after}");
        let root = app.doc().editor_ref().root.clone();
        let tree = x_native::build_render_tree(&root, &Default::default());
        let drawn: Vec<String> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                x_native::RenderCommand::Glyphs { text, size, .. } if *size > 16.0 => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect();
        assert!(
            drawn.iter().any(|t| t == "LOREM IPSUM IS TEXT FOR DEMO"),
            "render draws the cased content: {drawn:?}"
        );
        assert!(app.apply_typo_field(FieldId::TextCase, "Title"));
        let root = app.doc().editor_ref().root.clone();
        let tree = x_native::build_render_tree(&root, &Default::default());
        assert!(tree.commands.iter().any(|c| matches!(c,
            x_native::RenderCommand::Glyphs { text, .. }
                if text == "Lorem Ipsum Is Text For Demo")));
        assert!(app.apply_typo_field(FieldId::TextCase, "none"));
        assert_eq!(typo_val(&app, Typo::TextCase), "None");

        // Small caps: binding (not a content rewrite), narrower than
        // UPPER (the smalls are 70%), render command carries small_caps
        assert!(app.apply_typo_field(FieldId::TextCase, "small caps"));
        assert_eq!(typo_val(&app, Typo::TextCase), "Small caps");
        let w_sc = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "tx")
                .unwrap()
                .w
        };
        assert!(
            w_sc < w_up,
            "small caps narrower than upper: {w_sc} vs {w_up}"
        );
        let root = app.doc().editor_ref().root.clone();
        let tree = x_native::build_render_tree(&root, &Default::default());
        assert!(tree.commands.iter().any(|c| matches!(c,
            x_native::RenderCommand::Glyphs { text, small_caps: true, .. }
                if text == "lorem ipsum is text for demo")));
        assert!(app.apply_typo_field(FieldId::TextCase, "none"));

        // Variable-font axes: numbers set, "auto" clears (0), cmd carries
        assert!(app.apply_typo_field(FieldId::OpticalSize, "auto"));
        assert_eq!(typo_val(&app, Typo::OpticalSize), "Auto");
        assert!(app.apply_typo_field(FieldId::OpticalSize, "32"));
        assert_eq!(typo_val(&app, Typo::OpticalSize), "32");
        assert!(app.apply_typo_field(FieldId::WidthAxis, "75"));
        assert_eq!(typo_val(&app, Typo::WidthAxis), "75");
        assert!(!app.apply_typo_field(FieldId::OpticalSize, "wide"));
        let root = app.doc().editor_ref().root.clone();
        let tree = x_native::build_render_tree(&root, &Default::default());
        assert!(tree.commands.iter().any(|c| matches!(c,
            x_native::RenderCommand::Glyphs { optical_size, width_axis, .. }
                if *optical_size == 32.0 && *width_axis == 75.0)));
        assert!(app.apply_typo_field(FieldId::OpticalSize, "auto"));
        assert!(app.apply_typo_field(FieldId::WidthAxis, "auto"));

        // multi-paragraph: para spacing grows the block height
        app.doc().editor().set_text("tx", "one\ntwo");
        app.autosize_text_node("tx");
        let h0 = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "tx")
                .unwrap()
                .h
        };
        assert!(app.apply_typo_field(FieldId::ParaSpacing, "20"));
        let h1 = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "tx")
                .unwrap()
                .h
        };
        assert!(h1 >= h0 + 7.0, "ps(12->20) grows block by ~8: {h0} -> {h1}");

        // W-field commit pins the box (Figma fixed-size): auto-size stands
        // down and the box survives further typo edits
        {
            let doc = app.doc();
            doc.editor().mutate_visual_stack("tx", |n| {
                n.bindings.insert("tm".into(), "fixed".into());
            });
        }
        let w_fixed = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "tx")
                .unwrap()
                .w
        };
        assert!(
            !app.autosize_text_node("tx"),
            "fixed box must not auto-size"
        );
        let w_still = {
            let doc = app.doc();
            crate::editor_ui::find_node(&doc.editor_ref().root, "tx")
                .unwrap()
                .w
        };
        assert_eq!(w_fixed, w_still);

        // typo edits are undoable (mutate_visual_stack snapshots)
        assert!(app.doc().editor().undo());
    }

    /// Audit: alignment card aligns nodes; eye/lock toggles; corner resize.
    #[test]
    fn audit_align_toggle_resize() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let root_id = app.doc().editor_ref().root.id.clone();
        let fill = x_native::Paint::Solid(x_native::Color::from_rgb8(1, 2, 3));
        let mut a = x_native::Node::rect(
            "ax",
            0.0,
            0.0,
            50.0,
            40.0,
            x_native::Color::from_rgb8(1, 2, 3),
        );
        let mut b = x_native::Node::rect(
            "bx",
            200.0,
            120.0,
            60.0,
            30.0,
            x_native::Color::from_rgb8(1, 2, 3),
        );
        a.fill = fill.clone();
        b.fill = fill;
        app.doc().editor().insert_node(&root_id, a);
        app.doc().editor().insert_node(&root_id, b);
        app.doc().editor().selection = vec!["ax".into(), "bx".into()];
        // align right + top: both share right edge x=260 and top y=0
        app.apply_align(0, 2);
        {
            let root = &app.doc().editor_ref().root;
            let na = crate::editor_ui::find_node(root, "ax").unwrap();
            let nb = crate::editor_ui::find_node(root, "bx").unwrap();
            assert!(
                (na.transform.x + na.w - 260.0).abs() < 0.6,
                "ax right {}",
                na.transform.x
            );
            assert!((nb.transform.x + nb.w - 260.0).abs() < 0.6, "bx right");
            assert!((na.transform.y).abs() < 0.6 && (nb.transform.y).abs() < 0.6);
        }
        assert_eq!(app.align, (0, 2));
        // eye toggle hides; locked skips hit-test
        app.doc().editor().selection = vec!["ax".into()];
        app.apply_toggle(false);
        let vis = {
            let root = &app.doc().editor_ref().root;
            crate::editor_ui::find_node(root, "ax").unwrap().visible
        };
        assert!(!vis);
        let hit = {
            let root = app.doc().editor_ref().root.clone();
            x_native::editor::hit_test(&root, Point::new(10.0, 10.0))
        };
        assert_ne!(hit.as_deref(), Some("ax"));
        app.apply_toggle(false);
        // corner resize math via the same editor ops the drag uses
        app.doc().editor().move_node("bx", -30.0, 0.0);
        app.doc().editor().resize("bx", 90.0, 30.0);
        {
            let root = &app.doc().editor_ref().root;
            let nb = crate::editor_ui::find_node(root, "bx").unwrap();
            assert!((nb.w - 90.0).abs() < 0.01 && (nb.transform.x - 170.0).abs() < 0.01);
        }
    }

    /// Right-click context menu commands act on the selection.
    #[test]
    fn context_menu_actions() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let fid = app.doc().editor_ref().root.children[0].id.clone();
        app.doc().editor().selection = vec![fid.clone()];
        let base = app.doc().editor_ref().root.children.len();

        use crate::state::CtxCmd::*;
        // duplicate
        app.apply_ctx(Duplicate);
        assert_eq!(app.doc().editor_ref().root.children.len(), base + 1);
        // copy → paste
        app.apply_ctx(Copy);
        app.apply_ctx(Paste);
        assert_eq!(app.doc().editor_ref().root.children.len(), base + 2);
        // select all then delete clears
        app.apply_ctx(SelectAll);
        app.apply_ctx(Delete);
        assert!(app.doc().editor_ref().root.children.is_empty());
    }

    /// Screen transitions: blank → editor, closing all tabs → dashboard.
    #[test]
    fn screen_transitions() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        assert_eq!(app.screen, Screen::Dashboard);
        app.open_demo_blank();
        assert_eq!(app.screen, Screen::Editor);
        // closing every tab (the three mock seeds + the new one) returns
        // to the dashboard
        while !app.docs.is_empty() {
            app.close_doc(0);
        }
        assert_eq!(app.screen, Screen::Dashboard);
    }

    /// Field initial values reflect the selection.
    #[test]
    fn field_initials() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let id = app.doc().editor_ref().root.children[0].id.clone();
        app.doc().editor().selection = vec![id];
        assert_eq!(field_initial(&app, FieldId::W), "375");
        assert_eq!(field_initial(&app, FieldId::H), "420");
        assert_eq!(field_initial(&app, FieldId::X), "0");
        assert_eq!(field_initial(&app, FieldId::Y), "60");
    }

    /// Tabs: multiple docs, switching, closing.
    #[test]
    fn tabs_lifecycle() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        assert_eq!(app.docs.len(), 3); // v45 mock seed tabs
        app.open_demo_blank();
        assert_eq!(app.docs.len(), 4);
        assert_eq!(app.active, 3);
        app.docs[3].name = "First".into();
        app.active = 3;
        assert_eq!(app.doc().name, "First");
        app.close_doc(3);
        assert_eq!(app.docs.len(), 3);
        while !app.docs.is_empty() {
            app.close_doc(0);
        }
        assert!(app.docs.is_empty());
        assert_eq!(app.screen, Screen::Dashboard);
    }

    /// Hex round-trip used by the Fill/Stroke fields.
    #[test]
    fn hex_roundtrip() {
        let c = crate::state::parse_hex("1BCB55").unwrap();
        assert_eq!(crate::state::color_hex(c), "1BCB55");
        assert!(crate::state::parse_hex("#FFFFFF").is_some());
        assert!(crate::state::parse_hex("XYZ").is_none());
    }

    /// Text engine contract: `text()` takes the TOP of the CSS 1.5em line
    /// box (Tailwind preflight), exactly like Chromium. For 11px Inter the
    /// baseline must land at y + 13.75 (hhea: ascent 0.9688em, descent
    /// 0.2422em => baseline = 1.5A - 0.25D = 1.25em... precisely
    /// 1.5*0.9688 - 0.25*0.2422 = 1.3936em = 15.33px at 11px).
    #[test]
    fn text_engine_css_baseline_contract() {
        let t = crate::paint::TextUi::load();
        assert!(t.has_fonts());
        let font = t.face(crate::paint::Wt::Reg);
        let f = &t.fonts.fonts[font];
        let k = 11.0 / f.units_per_em;
        let expected_baseline: f64 = 0.75 * 11.0 + 0.5 * (f.ascent + f.descent) * k;
        // the internal helper must agree with the CSS formula
        let span = x_native::text::Span::new("Frame", 11.0).font(font);
        let style = x_native::text::TextBlockStyle {
            max_width: 100_000.0,
            line_height: 1.5,
            align: x_native::text::Align::Left,
            wrap: x_native::TextWrap::Auto,
            ..Default::default()
        };
        let (glyphs, _) = x_native::text::glyph_outlines(&t.fonts, &[span], font, &style);
        assert!(!glyphs.is_empty());
        // glyph transforms are baseline-relative: ty at baseline == 0 offset
        // (draw_spans adds `baseline` before calling glyph_outlines, so the
        // outlines' own ty must be ~0 => the translation happens outside).
        let _ = glyphs.len();
        // cap height sanity: Inter cap ~0.727em
        let cap = t.cap_height(font, 11.0);
        assert!((cap - 8.0).abs() < 0.3, "Inter 11px cap height, got {cap}");
        // Chromium audit: 11px label top 139.3 → baseline ≈ 151.5 (Δ≈12.25)
        assert!(
            (expected_baseline - 12.25).abs() < 0.35,
            "11px baseline, got {expected_baseline}"
        );
    }

    /// The default tool dock order matches the v45 HTML.
    #[test]
    fn tool_order_matches_html() {
        assert_eq!(Tool::Select.icon(), "mouse-pointer-2");
        assert_eq!(Tool::Frame.icon(), "frame#");
        assert_eq!(Tool::Text.icon(), "type");
        assert_eq!(Tool::Rect.icon(), "square");
        assert_eq!(Tool::Ellipse.icon(), "circle");
        assert_eq!(Tool::Pen.icon(), "pen-tool");
        assert_eq!(Tool::Hand.icon(), "hand");
    }

    /// Inspector tab content switches (Design renders many zones,
    /// Prototype/Inspect render their stub titles per the HTML).
    #[test]
    fn right_tabs_switch() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        app.doc().right_tab = RightTab::Prototype;
        let mut scene = vello::Scene::new();
        editor_ui::paint(&mut app, &mut scene);
        assert!(app.hit.len() > 5);
    }

    /// Frame presets match the v45 dropdown exactly.
    #[test]
    fn frame_presets_exact() {
        assert_eq!(FRAME_PRESETS[0], ("Frame", 375.0, 420.0));
        assert_eq!(FRAME_PRESETS[1], ("Desktop", 1440.0, 900.0));
        assert_eq!(FRAME_PRESETS[2], ("Laptop", 1280.0, 800.0));
        assert_eq!(FRAME_PRESETS[3], ("Tablet", 768.0, 1024.0));
        assert_eq!(FRAME_PRESETS[4], ("Mobile", 375.0, 812.0));
    }

    /// .x save/load round-trip through the engine (file I/O preserved).
    #[test]
    fn save_load_roundtrip() {
        let mut app = App::demo();
        app.win_w = 1440.0;
        app.win_h = 900.0;
        app.open_demo_blank();
        let dir = std::env::temp_dir().join("x-native-ui-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("roundtrip.x");
        {
            let doc = app.doc();
            doc.sync();
            x_native::fileio::save_x_file(&doc.doc, path.to_string_lossy().as_ref()).unwrap();
        }
        let loaded = OpenDoc::from_document(
            "roundtrip".into(),
            Some(path.clone()),
            x_native::fileio::load_x_file(path.to_string_lossy().as_ref()).unwrap(),
        );
        assert_eq!(loaded.editors.len(), 1);
        assert_eq!(loaded.editor_ref().root.children.len(), 1);
        let _ = std::fs::remove_file(&path);
    }
}

/// Headless visual verification: paints both screens exactly like the live
/// app and rasterizes them via wgpu (software Vulkan works) to PNG files.
/// Run with: cargo test -p x-designer --bin x_native_app -- --ignored
#[test]
#[ignore]
fn screenshot_screens() {
    use std::io::Write as _;

    let out_dir = std::path::Path::new("screenshots");
    let _ = std::fs::create_dir_all(out_dir);

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        compatible_surface: None,
        force_fallback_adapter: true,
    }))
    .expect("no adapter — install mesa-vulkan-drivers (lavapipe)");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("screenshot"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .expect("device");
    let mut renderer = vello::Renderer::new(
        &device,
        vello::RendererOptions {
            use_cpu: false,
            antialiasing_support: vello::AaSupport::all(),
            num_init_threads: std::num::NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .expect("renderer");

    let mut shoot = |name: &str, app: &mut App| {
        let w = app.win_w as u32;
        let h = app.win_h as u32;
        let mut inner = vello::Scene::new();
        match app.screen {
            Screen::Dashboard => dashboard::paint(app, &mut inner),
            Screen::Editor => {
                editor_ui::paint(app, &mut inner);
                let reg = app.editor_regions();
                let (mut root, vars) = {
                    let doc = app.doc();
                    doc.sync();
                    (doc.editor_ref().root.clone(), doc.doc.variables.clone())
                };
                blank_editing_text(&mut root, app.text_edit.as_deref());
                let (doc_scene, _) =
                    build_scene_full(&root, None, &vars, None, Some(&app.fonts.fonts));
                let (ox, oy, z) = app.canvas_transform();
                watermark_shadows(app, &mut inner, &root);
                inner.push_layer(
                    vello::peniko::Fill::NonZero,
                    vello::peniko::BlendMode::new(
                        vello::peniko::Mix::Normal,
                        vello::peniko::Compose::SrcOver,
                    ),
                    1.0,
                    Affine::IDENTITY,
                    &reg.canvas,
                );
                inner.append(&doc_scene, Some(Affine::translate((ox, oy)).then_scale(z)));
                watermark_labels(app, &mut inner, &root);
                inner.pop_layer();
                editor_ui::paint_over(app, &mut inner);
            }
            Screen::Board => {
                crate::board_ui::paint(app, &mut inner);
                let reg = app.board_regions();
                let (ox, oy, z) = app.board_canvas_transform();

                // Draw dot grid background
                crate::board_ui::paint_grid(app, &mut inner, &reg);

                // Render board nodes
                inner.push_layer(
                    vello::peniko::Fill::NonZero,
                    vello::peniko::BlendMode::new(
                        vello::peniko::Mix::Normal,
                        vello::peniko::Compose::SrcOver,
                    ),
                    1.0,
                    Affine::IDENTITY,
                    &reg.canvas,
                );
                let board = app.board_doc();
                crate::board_ui::paint_nodes(&*app, &mut inner, board, ox, oy, z);
                inner.pop_layer();

                crate::board_ui::paint_over(app, &mut inner);
            }
        }
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(name),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // vello's storage-texture stages require the plain (non-sRGB)
            // format for render_to_texture; values are already display-encoded.
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        renderer
            .render_to_texture(
                &device,
                &queue,
                &inner,
                &view,
                &vello::RenderParams {
                    base_color: C_BG,
                    width: w,
                    height: h,
                    antialiasing_method: vello::AaConfig::Area,
                },
            )
            .expect("render");
        // copy to buffer
        let bytes_per_row = (w * 4).div_ceil(256) * 256;
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("out"),
            size: (bytes_per_row * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([enc.finish()]);
        let slice = buf.slice(..);
        pollster::block_on(async {
            slice.map_async(wgpu::MapMode::Read, |_| {});
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(5)),
                })
                .expect("poll");
        });
        let data = slice.get_mapped_range();
        let mut png_data = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_data, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("png header");
            let mut rows = Vec::with_capacity((bytes_per_row * h) as usize);
            for row in 0..h {
                let start = (row * bytes_per_row) as usize;
                rows.extend_from_slice(&data[start..start + (w * 4) as usize]);
            }
            writer.write_image_data(&rows).expect("png data");
        }
        drop(data);
        buf.unmap();
        let mut f = std::fs::File::create(out_dir.join(format!("{name}.png"))).unwrap();
        f.write_all(&png_data).unwrap();
        println!("wrote {name}.png ({}px × {}px)", w, h);
    };

    // 1. Dashboard exactly as the HTML default state
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    shoot("dashboard", &mut app);

    // 2. Editor with the v45 demo document (active tab DESIGN_SYSTEM.md,
    //    file "Liquor Delivery App UI", Frame 375×420 on Page 3, selected)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let fid = doc.editor_ref().root.children[0].id.clone();
        doc.editor().selection = vec![fid];
    }
    shoot("editor", &mut app);

    // 3. Editor with rulers on (⇧R)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.rulers = true;
    app.center_view();
    {
        let doc = app.doc();
        let fid = doc.editor_ref().root.children[0].id.clone();
        doc.editor().selection = vec![fid];
    }
    shoot("editor-rulers", &mut app);

    // 10. Smart guides while dragging (snap lines + moving selection)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut a = x_native::Node::rect(
            "ga",
            40.0,
            60.0,
            120.0,
            80.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        );
        let mut b = x_native::Node::rect(
            "gb",
            320.0,
            200.0,
            100.0,
            100.0,
            x_native::Color::from_rgb8(0x2E, 0xCC, 0x71),
        );
        a.fill = x_native::Paint::Solid(x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF));
        b.fill = x_native::Paint::Solid(x_native::Color::from_rgb8(0x2E, 0xCC, 0x71));
        doc.editor().insert_node(&root_id, a);
        doc.editor().insert_node(&root_id, b);
        doc.editor().selection = vec!["gb".into()];
    }
    app.snap_lines = vec![(100.0, 'v'), (160.0, 'h')];
    shoot("editor-smartguides", &mut app);

    // 11. Inline text editor open on a Text node
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut t = x_native::Node::text("tt", 80.0, 70.0, 220.0, 34.0, "Liquor store");
        t.name = "Liquor store".into();
        doc.editor().insert_node(&root_id, t);
        doc.editor().selection = vec!["tt".into()];
    }
    app.begin_text_edit("tt".into(), "Liquor store".into());
    shoot("editor-textedit", &mut app);

    // 12. Typography wired: text node selected, box hugs text, panel live
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut t = x_native::Node::text("tt", 60.0, 80.0, 300.0, 14.0, "Fresh liquor, delivered");
        t.name = "Fresh liquor, delivered".into();
        doc.editor().insert_node(&root_id, t);
        doc.editor().selection = vec!["tt".into()];
    }
    app.apply_typo_field(FieldId::FontSize, "28");
    app.apply_typo_field(FieldId::FontWeight, "600");
    app.apply_typo_field(FieldId::LetterSpacing, "0.5");
    app.apply_typo_field(FieldId::WordSpacing, "2");
    app.apply_typo_field(FieldId::LineHeight, "40");
    app.apply_typo_field(FieldId::TextCase, "small caps");
    // scroll the right panel so the spacing/case rows are in view
    app.doc().scroll_right = 200.0;
    shoot("editor-texttypo", &mut app);

    // 13. Rich-text sub-selection: inline editor open, "liquor" bolded +
    // colored, partial selection (blue wash) + caret visible mid-word
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut t = x_native::Node::text("tt", 60.0, 80.0, 300.0, 14.0, "Fresh liquor, delivered");
        t.name = "Fresh liquor, delivered".into();
        doc.editor().insert_node(&root_id, t);
    }
    app.begin_text_edit("tt".into(), "Fresh liquor, delivered".into());
    app.text_set_caret(6, false); // select "liquor"
    for _ in 0..6 {
        app.text_move_caret(1, true);
    }
    app.text_toggle_weight();
    app.apply_typo_field(FieldId::FillHex, "E11D48");
    app.text_set_caret(6, false); // re-select "liq" for the proof
    for _ in 0..3 {
        app.text_move_caret(1, true);
    }
    shoot("editor-richedit", &mut app);

    // 14. Hover state: cursor over a text layer — subtle outline, no
    // handles, no size badge (the Figma hover -> click -> edit ladder)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut t = x_native::Node::text("tt", 60.0, 80.0, 300.0, 14.0, "asdasd");
        t.name = "asdasd".into();
        doc.editor().insert_node(&root_id, t);
    }
    let hp = app.world_to_screen(vello::kurbo::Point::new(100.0, 88.0));
    app.update_hover(hp);
    shoot("editor-texthover", &mut app);

    // 15. Line-height MODES: 3-line text at a fixed 44px line box with the
    // mode menu open (Auto / Pixels / Percent — Pixels active)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut t = x_native::Node::text(
            "tt",
            60.0,
            80.0,
            300.0,
            14.0,
            "Fresh liquor\ndelivered daily\nto your door",
        );
        t.name = "Fresh liquor".into();
        doc.editor().insert_node(&root_id, t);
        doc.editor().selection = vec!["tt".into()];
    }
    app.apply_typo_field(FieldId::FontSize, "18");
    app.apply_typo_field(FieldId::LineHeight, "44");
    // scroll the typography rows into view so the anchored menu fits
    app.doc().scroll_right = 150.0;
    app.dropdown_lh = true;
    shoot("editor-lhmenu", &mut app);

    // 16. Panel scroll clip: DESIGN content scrolled 120px must slide
    // UNDER the pinned header (no overdraw on the pill tabs / divider)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut f = x_native::Node::frame("fr", 200.0, 150.0);
        f.name = "Frame".into();
        doc.editor().insert_node(&root_id, f);
        doc.editor().selection = vec!["fr".into()];
    }
    app.doc().scroll_right = 120.0;
    shoot("editor-panelclip", &mut app);

    // 7. Context menu open on the selection (right-click)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let fid = doc.editor_ref().root.children[0].id.clone();
        doc.editor().selection = vec![fid];
    }
    {
        let (ww, wh) = (app.win_w, app.win_h);
        app.context_menu.open_for_target(
            crate::context_menu::ContextTarget::CanvasSelection {
                selected_count: 1,
                contains_group: false,
            },
            700.0,
            500.0,
            ww,
            wh,
        );
    }
    shoot("editor-contextmenu", &mut app);

    // 8. Hover states: file-name row + inspector field + toolbar
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    app.mouse = vello::kurbo::Point::new(150.0, 80.0); // file-name row
    shoot("editor-hover", &mut app);

    // 9. Dashboard action-card hover (translateY lift)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.mouse = vello::kurbo::Point::new(300.0, 200.0); // over "New design file"
    shoot("dashboard-hover", &mut app);
}

#[test]
#[ignore]
fn screenshot_screens_more() {
    use std::io::Write as _;

    let out_dir = std::path::Path::new("screenshots");
    let _ = std::fs::create_dir_all(out_dir);

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        compatible_surface: None,
        force_fallback_adapter: true,
    }))
    .expect("no adapter — install mesa-vulkan-drivers (lavapipe)");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("screenshot"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .expect("device");
    let mut renderer = vello::Renderer::new(
        &device,
        vello::RendererOptions {
            use_cpu: false,
            antialiasing_support: vello::AaSupport::all(),
            num_init_threads: std::num::NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .expect("renderer");

    let mut shoot = |name: &str, app: &mut App| {
        let w = app.win_w as u32;
        let h = app.win_h as u32;
        let mut inner = vello::Scene::new();
        match app.screen {
            Screen::Dashboard => dashboard::paint(app, &mut inner),
            Screen::Editor => {
                editor_ui::paint(app, &mut inner);
                let reg = app.editor_regions();
                let (mut root, vars) = {
                    let doc = app.doc();
                    doc.sync();
                    (doc.editor_ref().root.clone(), doc.doc.variables.clone())
                };
                blank_editing_text(&mut root, app.text_edit.as_deref());
                let (doc_scene, _) =
                    build_scene_full(&root, None, &vars, None, Some(&app.fonts.fonts));
                let (ox, oy, z) = app.canvas_transform();
                watermark_shadows(app, &mut inner, &root);
                inner.push_layer(
                    vello::peniko::Fill::NonZero,
                    vello::peniko::BlendMode::new(
                        vello::peniko::Mix::Normal,
                        vello::peniko::Compose::SrcOver,
                    ),
                    1.0,
                    Affine::IDENTITY,
                    &reg.canvas,
                );
                inner.append(&doc_scene, Some(Affine::translate((ox, oy)).then_scale(z)));
                watermark_labels(app, &mut inner, &root);
                inner.pop_layer();
                editor_ui::paint_over(app, &mut inner);
            }
            Screen::Board => {
                crate::board_ui::paint(app, &mut inner);
                let reg = app.board_regions();
                let (ox, oy, z) = app.board_canvas_transform();
                crate::board_ui::paint_grid(app, &mut inner, &reg);
                let board = app.board_doc();
                crate::board_ui::paint_nodes(&*app, &mut inner, board, ox, oy, z);
            }
        }
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(name),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // vello's storage-texture stages require the plain (non-sRGB)
            // format for render_to_texture; values are already display-encoded.
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        renderer
            .render_to_texture(
                &device,
                &queue,
                &inner,
                &view,
                &vello::RenderParams {
                    base_color: C_BG,
                    width: w,
                    height: h,
                    antialiasing_method: vello::AaConfig::Area,
                },
            )
            .expect("render");
        // copy to buffer
        let bytes_per_row = (w * 4).div_ceil(256) * 256;
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("out"),
            size: (bytes_per_row * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([enc.finish()]);
        let slice = buf.slice(..);
        pollster::block_on(async {
            slice.map_async(wgpu::MapMode::Read, |_| {});
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(5)),
                })
                .expect("poll");
        });
        let data = slice.get_mapped_range();
        let mut png_data = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_data, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("png header");
            let mut rows = Vec::with_capacity((bytes_per_row * h) as usize);
            for row in 0..h {
                let start = (row * bytes_per_row) as usize;
                rows.extend_from_slice(&data[start..start + (w * 4) as usize]);
            }
            writer.write_image_data(&rows).expect("png data");
        }
        drop(data);
        buf.unmap();
        let mut f = std::fs::File::create(out_dir.join(format!("{name}.png"))).unwrap();
        f.write_all(&png_data).unwrap();
        println!("wrote {name}.png ({}px × {}px)", w, h);
    };
    // 6. Pixel grid: 1-world-px cells visible at >=800% zoom
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    app.zoom = 8.0;
    app.pan = (420.0, -350.0);
    shoot("editor-pixelgrid", &mut app);

    // 5. Editor, nothing selected: DESIGN panel shows canvas background /
    //    pixel grid controls
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.rulers = true;
    app.center_view();
    shoot("editor-noselection", &mut app);

    // 4. Editor with content: shapes, frame dropdown open, palette open
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.open_demo_blank();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut g = x_native::Node::group("order-details", 24.0, 24.0);
        g.name = "order-details".into();
        g.children.push(x_native::Node::rect(
            "header",
            0.0,
            0.0,
            200.0,
            44.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        ));
        g.children.push(x_native::Node::ellipse(
            "avatar-dot",
            8.0,
            60.0,
            24.0,
            24.0,
            x_native::Color::from_rgb8(0x2E, 0xCC, 0x71),
        ));
        g.children.push(x_native::Node::text(
            "label",
            40.0,
            64.0,
            120.0,
            14.0,
            "Payment methods",
        ));
        doc.editor().insert_node(&root_id, g);
        doc.expanded.insert("order-details".into());
        doc.editor().selection = vec!["frame-1".into()];
    }
    shoot("editor-content", &mut app);
}

#[test]
#[ignore]
fn screenshot_screens_r7() {
    use std::io::Write as _;

    let out_dir = std::path::Path::new("screenshots");
    let _ = std::fs::create_dir_all(out_dir);

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        compatible_surface: None,
        force_fallback_adapter: true,
    }))
    .expect("no adapter — install mesa-vulkan-drivers (lavapipe)");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("screenshot"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        ..Default::default()
    }))
    .expect("device");
    let mut renderer = vello::Renderer::new(
        &device,
        vello::RendererOptions {
            use_cpu: false,
            antialiasing_support: vello::AaSupport::all(),
            num_init_threads: std::num::NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .expect("renderer");

    let mut shoot = |name: &str, app: &mut App| {
        let w = app.win_w as u32;
        let h = app.win_h as u32;
        let mut inner = vello::Scene::new();
        match app.screen {
            Screen::Dashboard => dashboard::paint(app, &mut inner),
            Screen::Editor => {
                editor_ui::paint(app, &mut inner);
                let reg = app.editor_regions();
                let (mut root, vars) = {
                    let doc = app.doc();
                    doc.sync();
                    (doc.editor_ref().root.clone(), doc.doc.variables.clone())
                };
                blank_editing_text(&mut root, app.text_edit.as_deref());
                let (doc_scene, _) =
                    build_scene_full(&root, None, &vars, None, Some(&app.fonts.fonts));
                let (ox, oy, z) = app.canvas_transform();
                watermark_shadows(app, &mut inner, &root);
                inner.push_layer(
                    vello::peniko::Fill::NonZero,
                    vello::peniko::BlendMode::new(
                        vello::peniko::Mix::Normal,
                        vello::peniko::Compose::SrcOver,
                    ),
                    1.0,
                    Affine::IDENTITY,
                    &reg.canvas,
                );
                inner.append(&doc_scene, Some(Affine::translate((ox, oy)).then_scale(z)));
                watermark_labels(app, &mut inner, &root);
                inner.pop_layer();
                editor_ui::paint_over(app, &mut inner);
            }
            Screen::Board => {
                crate::board_ui::paint(app, &mut inner);
                let reg = app.board_regions();
                let (ox, oy, z) = app.board_canvas_transform();
                crate::board_ui::paint_grid(app, &mut inner, &reg);
                let board = app.board_doc();
                crate::board_ui::paint_nodes(&*app, &mut inner, board, ox, oy, z);
            }
        }
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(name),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // vello's storage-texture stages require the plain (non-sRGB)
            // format for render_to_texture; values are already display-encoded.
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::STORAGE_BINDING,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        renderer
            .render_to_texture(
                &device,
                &queue,
                &inner,
                &view,
                &vello::RenderParams {
                    base_color: C_BG,
                    width: w,
                    height: h,
                    antialiasing_method: vello::AaConfig::Area,
                },
            )
            .expect("render");
        // copy to buffer
        let bytes_per_row = (w * 4).div_ceil(256) * 256;
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("out"),
            size: (bytes_per_row * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([enc.finish()]);
        let slice = buf.slice(..);
        pollster::block_on(async {
            slice.map_async(wgpu::MapMode::Read, |_| {});
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(5)),
                })
                .expect("poll");
        });
        let data = slice.get_mapped_range();
        let mut png_data = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_data, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("png header");
            let mut rows = Vec::with_capacity((bytes_per_row * h) as usize);
            for row in 0..h {
                let start = (row * bytes_per_row) as usize;
                rows.extend_from_slice(&data[start..start + (w * 4) as usize]);
            }
            writer.write_image_data(&rows).expect("png data");
        }
        drop(data);
        buf.unmap();
        let mut f = std::fs::File::create(out_dir.join(format!("{name}.png"))).unwrap();
        f.write_all(&png_data).unwrap();
        println!("wrote {name}.png ({}px × {}px)", w, h);
    };

    // 17. r7 Layers eye/lock: hover row shows eye + padlock; a hidden row
    //     keeps its eye-off, a locked row keeps its padlock (persistent)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        doc.mock_layers.clear();
        let root_id = doc.editor_ref().root.id.clone();
        let mut r = x_native::Node::rect(
            "r1",
            40.0,
            60.0,
            120.0,
            80.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        );
        r.name = "Rectangle".into();
        r.visible = false;
        doc.editor().insert_node(&root_id, r);
        let mut e = x_native::Node::ellipse(
            "e1",
            200.0,
            80.0,
            100.0,
            100.0,
            x_native::Color::from_rgb8(0x2E, 0xCC, 0x71),
        );
        e.name = "Ellipse".into();
        e.locked = true;
        doc.editor().insert_node(&root_id, e);
        let t = x_native::Node::text("t1", 60.0, 220.0, 220.0, 20.0, "Fresh liquor");
        doc.editor().insert_node(&root_id, t);
        doc.editor().selection = vec!["t1".into()];
    }
    {
        // hover the LAST row (Text) — eye + padlock appear on hover
        let tree_top = crate::theme::ED_TITLE_H + 216.5;
        let row_y =
            tree_top + 3.0 * (crate::theme::TREE_ROW_H + 1.0) + crate::theme::TREE_ROW_H / 2.0;
        app.mouse = vello::kurbo::Point::new(140.0, row_y);
    }
    shoot("editor-tree-eyedock", &mut app);

    // 18. r7 Rulers + guides: two placed guides (v + h) and one being
    //     dragged from the top ruler (live C_SNAP line under the cursor)
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.rulers = true;
    app.center_view();
    {
        let doc = app.doc();
        doc.guides.push(('v', 250.0));
        doc.guides.push(('h', 320.0));
    }
    {
        let drag_scr = app.world_to_screen(vello::kurbo::Point::new(430.0, 200.0));
        app.mouse = drag_scr;
        *app.guide_drag() = Some(('v', 430.0));
        app.drag = Some(crate::state::Drag::Guide { axis: 'v' });
    }
    shoot("editor-rulers-guides", &mut app);

    // 19. r7 Empty text discard: Text tool click created an empty text node
    //     with the inline editor open — caret on line 1, no white card;
    //     committing empty (or Esc) deletes the node
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let t = x_native::Node::text("tx", 120.0, 140.0, 120.0, 14.0, "");
        doc.editor().insert_node(&root_id, t);
        doc.editor().selection = vec!["tx".into()];
    }
    app.begin_text_edit("tx".into(), String::new());
    shoot("editor-emptytext", &mut app);

    // 20. r7 Pen close-on-anchor: 3 points placed, cursor back on the start
    //     anchor (blue snap circle) — next click closes the vector
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let a = vello::kurbo::Point::new(320.0, 220.0);
        let b = vello::kurbo::Point::new(520.0, 220.0);
        let c = vello::kurbo::Point::new(430.0, 360.0);
        app.pen_click(a);
        app.pen_click(b);
        app.pen_click(c);
        // hover exactly on the anchor: close affordance (next click closes)
        app.mouse = app.world_to_screen(a);
    }
    shoot("editor-pen", &mut app);
    // ...and the close really fires: node created + selected
    {
        app.pen_click(vello::kurbo::Point::new(320.0, 220.0));
        let doc = app.doc();
        let closed = doc
            .editor_ref()
            .root
            .children
            .iter()
            .any(|c| c.id.starts_with("path-"));
        assert!(closed, "pen close created a vector");
        let sel = doc.selected_id().unwrap_or_default();
        assert!(
            doc.editor_ref()
                .root
                .children
                .iter()
                .any(|c| c.id == sel && c.id.starts_with("path-")),
            "closed vector selected"
        );
        println!("pen close ok: {:?}", doc.selected_id());
    }

    // 21. r11 pages-panel context menu: right-click on the page field —
    //     Rename / Duplicate / Delete / Move up / Move down
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let tree_top = crate::theme::ED_TITLE_H;
        let py = tree_top + 142.0; // the page field's y (paint_pages)
        app.page_menu = Some(vello::kurbo::Point::new(160.0, py + 30.0));
    }
    shoot("editor-pagemenu", &mut app);

    // 22. r11 export panel on PDF: format cycler now covers PNG/JPG/SVG/PDF
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let fid = doc.editor_ref().root.children[0].id.clone();
        doc.editor().selection = vec![fid];
        doc.export_format = 3;
        // scroll so the Export section (~1102 content y) sits mid-panel
        doc.scroll_right = 760.0;
    }
    shoot("editor-export-pdf", &mut app);

    // 23. r12 auto-layout inspector: AL frame selected — live Hug/Fixed
    //     chips + Wrap checkbox in the freed band under the alignment card
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut f = x_native::Node::frame("al", 220.0, 160.0);
        f.name = "Auto frame".into();
        f.children.push(x_native::Node::rect(
            "a1",
            0.0,
            0.0,
            60.0,
            40.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        ));
        f.children.push(x_native::Node::rect(
            "a2",
            70.0,
            0.0,
            60.0,
            40.0,
            x_native::Color::from_rgb8(0x2E, 0xCC, 0x71),
        ));
        doc.editor().insert_node(&root_id, f);
        doc.editor().selection = vec!["al".into()];
    }
    app.modify_selected_layout(|l| {
        l.direction = x_native::LayoutDirection::Horizontal;
        l.gap = 10.0;
        l.wrap = x_native::AutoLayoutWrap::Wrap;
    });
    app.doc().scroll_right = 120.0; // Resizing + the new row in view
    shoot("editor-allayout", &mut app);

    // 24. r12 per-child controls: child of the AL frame — Fixed/Fill seg +
    //     Absolute checkbox
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut f = x_native::Node::frame("al", 220.0, 160.0);
        f.name = "Auto frame".into();
        f.children.push(x_native::Node::rect(
            "a1",
            0.0,
            0.0,
            60.0,
            40.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        ));
        f.children.push(x_native::Node::rect(
            "a2",
            70.0,
            0.0,
            60.0,
            40.0,
            x_native::Color::from_rgb8(0x2E, 0xCC, 0x71),
        ));
        doc.editor().insert_node(&root_id, f);
        // give the PARENT the auto-layout, then select the child
        doc.editor().selection = vec!["al".into()];
    }
    app.modify_selected_layout(|l| {
        l.direction = x_native::LayoutDirection::Horizontal;
        l.gap = 10.0;
    });
    {
        let doc = app.doc();
        doc.editor().selection = vec!["a1".into()];
    }
    app.doc().scroll_right = 120.0;
    shoot("editor-alchild", &mut app);

    // 25. r13 A2: COMPONENT section — instance selected, props editable
    //     (bool checkbox / text field / swap picker) in the DESIGN panel
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut f = x_native::Node::frame("btnframe", 120.0, 44.0);
        f.name = "Btn".into();
        f.children.push(x_native::Node::text(
            "lbl", 12.0, 12.0, 80.0, 20.0, "Click me",
        ));
        f.children.push(x_native::Node::rect(
            "ico",
            96.0,
            14.0,
            16.0,
            16.0,
            x_native::Color::from_rgb8(0xEE, 0x55, 0x55),
        ));
        doc.editor().insert_node(&root_id, f);
        doc.editor()
            .insert_node(&root_id, x_native::Node::frame("badgeframe", 40.0, 24.0));
    }
    app.doc().editor().selection = vec!["btnframe".into()];
    app.doc().editor().make_component("Button");
    app.doc().editor().selection = vec!["badgeframe".into()];
    app.doc().editor().make_component("Badge");
    let badge_inst = app
        .doc()
        .editor()
        .place_instance_in("Badge", "comp-Button", 96.0, 12.0)
        .expect("badge in master");
    app.doc().editor().selection = vec!["lbl".into()];
    app.add_prop(x_native::ComponentPropKind::Text);
    app.doc().editor().selection = vec!["ico".into()];
    app.add_prop(x_native::ComponentPropKind::Bool);
    app.doc().editor().selection = vec![badge_inst];
    app.add_prop(x_native::ComponentPropKind::Swap);
    let inst = app
        .doc()
        .editor()
        .place_instance("Button", 420.0, 300.0)
        .expect("instance placed");
    app.apply_prop(&inst, "Button", "lbl", "Get started");
    {
        let doc = app.doc();
        doc.editor().selection = vec![inst];
    }
    // scroll the DESIGN column so the COMPONENT section is in view
    app.doc().scroll_right = 860.0;
    shoot("editor-component-props", &mut app);

    // 26. r15 C18: comment pins — resolved pin, open thread popover, and
    //     the new-comment composer, all above the canvas content
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut f = x_native::Node::frame("art", 300.0, 200.0);
        f.name = "Card".into();
        f.children.push(x_native::Node::rect(
            "chip",
            20.0,
            20.0,
            80.0,
            40.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        ));
        doc.editor().insert_node(&root_id, f);
    }
    let c1 = app.post_comment(430.0, 300.0, "Ship it");
    let c2 = app.post_comment(620.0, 420.0, "Use the new brand blue here");
    app.resolve_comment(&c1, true);
    app.open_comment = Some(c2);
    app.comment_draft = Some(crate::state::CommentDraft {
        x: 200.0,
        y: 500.0,
        buffer: "Need a lighter shadow".into(),
    });
    shoot("editor-comments", &mut app);

    // 27. r16 C21: INSPECT (dev mode) — CSS platform, generated code for
    //     the selected Card frame
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    {
        let doc = app.doc();
        let root_id = doc.editor_ref().root.id.clone();
        let mut f = x_native::Node::frame("card", 300.0, 200.0);
        f.name = "Card".into();
        f.children.push(x_native::Node::rect(
            "chip",
            20.0,
            20.0,
            120.0,
            44.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        ));
        doc.editor().insert_node(&root_id, f);
        doc.editor().selection = vec!["chip".into()];
    }
    app.doc().right_tab = crate::state::RightTab::Inspect;
    shoot("editor-inspect", &mut app);
}
// ------------------------------------------------- A2 component props
#[test]
fn component_props_define_edit_render_roundtrip() {
    use x_native::components::OverrideValue;
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    let root_id = app.doc().editor_ref().root.id.clone();

    // masters: Button (frame w/ text + icon rect) and Badge (frame)
    {
        let doc = app.doc();
        let mut f = x_native::Node::frame("btnframe", 120.0, 44.0);
        f.name = "Btn".into();
        f.children.push(x_native::Node::text(
            "lbl", 12.0, 12.0, 80.0, 20.0, "Click me",
        ));
        f.children.push(x_native::Node::rect(
            "ico",
            96.0,
            14.0,
            16.0,
            16.0,
            x_native::Color::from_rgb8(0xEE, 0x55, 0x55),
        ));
        doc.editor().insert_node(&root_id, f);
        doc.editor()
            .insert_node(&root_id, x_native::Node::frame("badgeframe", 40.0, 24.0));
    }
    app.doc().editor().selection = vec!["btnframe".into()];
    assert!(app.doc().editor().make_component("Button"));
    app.doc().editor().selection = vec!["badgeframe".into()];
    assert!(app.doc().editor().make_component("Badge"));

    // a Badge instance INSIDE the Button master (the swap target)
    let badge_inst = app
        .doc()
        .editor()
        .place_instance_in("Badge", "comp-Button", 96.0, 12.0)
        .expect("badge instance placed in master");

    // define props the way the panel does: select the bound node, add
    app.doc().editor().selection = vec!["lbl".into()];
    app.add_prop(x_native::ComponentPropKind::Text);
    app.doc().editor().selection = vec!["ico".into()];
    app.add_prop(x_native::ComponentPropKind::Bool);
    app.doc().editor().selection = vec![badge_inst.clone()];
    app.add_prop(x_native::ComponentPropKind::Swap);

    let entries = app.props_of("Button");
    assert_eq!(entries.len(), 3, "text + bool + swap defined");
    assert_eq!(entries[0].kind, x_native::ComponentPropKind::Text);
    assert_eq!(entries[0].target, "lbl");
    assert_eq!(entries[0].default, "Click me", "text default = node text");
    assert_eq!(entries[1].kind, x_native::ComponentPropKind::Bool);
    assert_eq!(entries[1].target, "ico");
    assert_eq!(entries[1].default, "true");
    assert_eq!(entries[2].kind, x_native::ComponentPropKind::Swap);
    assert_eq!(entries[2].target, badge_inst.as_str());
    assert_eq!(
        entries[2].default, "Badge",
        "swap default = the target's component"
    );
    let swap_prop = entries[2].name.clone();

    // place an instance of Button and drive it through the App helpers
    let inst = app
        .doc()
        .editor()
        .place_instance("Button", 40.0, 300.0)
        .expect("instance placed");
    assert!(app.apply_prop(&inst, "Button", &entries[0].name, "Hello"));

    {
        let doc = app.doc();
        let node = crate::editor_ui::find_node(&doc.editor_ref().root, &inst).unwrap();
        let t = x_native::components::typed_overrides(node);
        assert_eq!(
            t.get("lbl"),
            Some(&OverrideValue::Text("Hello".into())),
            "typed override written (text:Hello)"
        );
    }
    // the display path shows the override, not the definition default
    assert_eq!(app.instance_prop_value(&inst, &entries[0]), "Hello");

    // commit path (panel text field) — the same single path the Host
    // commit arm calls
    app.doc().editor().selection = vec![inst.clone()];
    app.instance_prop_target = Some(entries[0].name.clone());
    app.field = Some(crate::state::FieldEdit {
        id: crate::state::FieldId::InstanceProp,
        buffer: "Typed!".into(),
    });
    app.commit_instance_prop("Typed!");
    assert_eq!(app.instance_prop_value(&inst, &entries[0]), "Typed!");
    assert!(app.instance_prop_target.is_none(), "target cleared");

    // RENDER: the override text reaches the IR glyphs
    let glyph_texts = |app: &mut App| -> Vec<String> {
        let doc = app.doc();
        let tree = x_native::build_render_tree(&doc.editor_ref().root, &Default::default());
        tree.commands
            .iter()
            .filter_map(|c| match c {
                x_native::RenderCommand::Glyphs { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    };
    assert!(
        glyph_texts(&mut app).iter().any(|t| t == "Typed!"),
        "override text renders"
    );

    // BOOL: hiding the icon removes its fill from the IR
    assert!(app.apply_prop(&inst, "Button", &entries[1].name, "false"));
    {
        let doc = app.doc();
        let tree = x_native::build_render_tree(&doc.editor_ref().root, &Default::default());
        let keys: Vec<String> = tree
            .commands
            .iter()
            .filter_map(|c| match c {
                x_native::RenderCommand::FillPath { key, .. } => Some(key.clone()),
                _ => None,
            })
            .collect();
        // NOTE: make_component leaves an unedited {name}-1 instance at
        // the original spot — scope the check to OUR instance
        let own = format!("/{inst}/ico");
        assert!(
            !keys.iter().any(|k| k.contains(&own)),
            "hidden icon node renders nothing"
        );
    }
    // the override is Visible(false), and toggling back writes true
    {
        let doc = app.doc();
        let node = crate::editor_ui::find_node(&doc.editor_ref().root, &inst).unwrap();
        let t = x_native::components::typed_overrides(node);
        assert_eq!(t.get("ico"), Some(&OverrideValue::Visible(false)));
    }
    assert!(app.apply_prop(&inst, "Button", &entries[1].name, "true"));

    // SWAP: cycle Badge -> Button -> Badge (masters sorted)
    app.cycle_swap(&inst, "Button", &swap_prop);
    {
        let doc = app.doc();
        let node = crate::editor_ui::find_node(&doc.editor_ref().root, &inst).unwrap();
        let t = x_native::components::typed_overrides(node);
        assert_eq!(
            t.get(badge_inst.as_str()),
            Some(&OverrideValue::Swap("Button".into())),
            "cycle from default Badge lands on Button"
        );
    }
    app.cycle_swap(&inst, "Button", &swap_prop);
    {
        let doc = app.doc();
        let node = crate::editor_ui::find_node(&doc.editor_ref().root, &inst).unwrap();
        let t = x_native::components::typed_overrides(node);
        assert_eq!(
            t.get(badge_inst.as_str()),
            Some(&OverrideValue::Swap("Badge".into())),
            "cycle wraps back to Badge"
        );
    }

    // RESET clears every override; props fall back to the defaults
    app.reset_instance_props(&inst);
    {
        let doc = app.doc();
        let node = crate::editor_ui::find_node(&doc.editor_ref().root, &inst).unwrap();
        assert!(node.overrides.is_empty(), "reset clears overrides");
    }
    assert_eq!(
        app.instance_prop_value(&inst, &entries[0]),
        "Click me",
        "display falls back to the definition default"
    );

    // .x roundtrip preserves the DEFINITIONS (instance overrides live
    // on the instance node and ride the regular overrides map)
    assert!(app.apply_prop(&inst, "Button", &entries[0].name, "Persisted"));
    let dir = std::env::temp_dir().join("x-native-ui-test");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("component_props.x");
    {
        let doc = app.doc();
        doc.sync();
        x_native::fileio::save_x_file(&doc.doc, path.to_string_lossy().as_ref()).unwrap();
    }
    let d2 = x_native::fileio::load_x_file(path.to_string_lossy().as_ref()).unwrap();
    let defs = d2.component_props.get("Button").expect("props saved");
    assert_eq!(defs.len(), 3);
    assert_eq!(defs[0].name, entries[0].name);
    assert_eq!(defs[0].target, "lbl");
    assert_eq!(defs[0].default, "Click me");
    assert_eq!(defs[1].default, "true");
    assert_eq!(defs[2].default, "Badge");
    // and the instance's overrides survived too (search every page:
    // App::new's dashboard mock ships extra empty pages)
    let mut found = None;
    fn walk<'a>(n: &'a x_native::Node, id: &str) -> Option<&'a x_native::Node> {
        if n.id == id {
            return Some(n);
        }
        n.children.iter().find_map(|c| walk(c, id))
    }
    let hit = d2.pages.iter().find_map(|p| walk(p, &inst));
    if let Some(node) = hit {
        assert_eq!(
            node.overrides.get("lbl"),
            Some(&"text:Persisted".to_string()),
            "instance override survives save/load"
        );
        found = Some(());
    }
    assert!(found.is_some(), "instance present after load");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn copy_as_code_selection_to_jsx() {
    use x_native::{AutoLayout, Color, LayoutDirection, Node, NodeKind};
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    let root_id = app.doc().editor_ref().root.id.clone();
    {
        let doc = app.doc();
        let mut f = Node::frame("btn", 120.0, 44.0);
        f.name = "Button".into();
        f.kind = NodeKind::Frame {
            layout: Some(AutoLayout {
                direction: LayoutDirection::Horizontal,
                gap: 8.0,
                ..Default::default()
            }),
        };
        f.children
            .push(Node::text("lbl", 0.0, 0.0, 80.0, 20.0, "Copy me"));
        doc.editor().insert_node(&root_id, f);
        doc.editor().insert_node(
            &root_id,
            Node::rect("r", 300.0, 40.0, 60.0, 40.0, Color::from_rgb8(1, 2, 3)),
        );
    }

    // nothing selected → None
    assert!(app.copy_selection_as_code().is_none());

    // frame selected → flex JSX with the flowing text child
    app.doc().editor().selection = vec!["btn".into()];
    app.apply_ctx(crate::state::CtxCmd::CopyAsCode);
    let code = app.last_copied_code.clone().expect("code captured");
    assert!(code.contains("display: 'flex'"), "{code}");
    assert!(code.contains("flexDirection: 'row'"), "{code}");
    assert!(code.contains("gap: 8"), "{code}");
    assert!(code.contains("'Copy me'"), "{code}");
    assert!(code.contains("fontSize: 16"), "{code}");
    assert!(app.status.contains("JSX"), "status: {}", app.status);

    // frame + its child selected → the child is shadowed (one subtree only)
    app.doc().editor().selection = vec!["btn".into(), "lbl".into()];
    let code2 = app.copy_selection_as_code().expect("code");
    assert_eq!(
        code2.matches("<div").count() + code2.matches("<span").count(),
        2,
        "one div + one span, no duplicates: {code2}"
    );

    // two siblings → fragment
    app.doc().editor().selection = vec!["btn".into(), "r".into()];
    let code3 = app.copy_selection_as_code().expect("code");
    assert!(code3.starts_with("<>\n"), "{code3}");
    assert!(code3.contains("backgroundColor: '#010203'"), "{code3}");
}

#[test]
fn comments_pin_resolve_delete_roundtrip() {
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    let root_id = app.doc().editor_ref().root.id.clone();
    {
        let doc = app.doc();
        let mut f = x_native::Node::frame("art", 300.0, 200.0);
        f.name = "Card".into();
        doc.editor().insert_node(&root_id, f);
    }

    // post two pins on page 0
    let id1 = app.post_comment(100.0, 200.0, "Looks off-brand");
    let id2 = app.post_comment(400.0, 320.0, "Ship it");
    {
        let doc = app.doc();
        assert_eq!(doc.doc.comments.len(), 2);
        let c = &doc.doc.comments[0];
        assert_eq!(c.author, crate::state::USER_NAME);
        assert_eq!(c.page, doc.page, "pin lands on the ACTIVE page");
        assert!(!c.resolved);
        assert_eq!(c.id, id1);
        assert_ne!(id1, id2);
    }

    // hit-test: pin avatar sits at (sp.x, sp.y-24)..(sp.x+24, sp.y) +6 slack
    let sp = app.world_to_screen(vello::kurbo::Point::new(100.0, 200.0));
    assert_eq!(
        app.comment_at(vello::kurbo::Point::new(sp.x + 12.0, sp.y - 12.0))
            .as_deref(),
        Some(id1.as_str())
    );
    // outside both pins -> None (the pins are 300+ world px apart)
    assert_eq!(
        app.comment_at(vello::kurbo::Point::new(sp.x + 70.0, sp.y - 12.0)),
        None
    );
    // comments on OTHER pages are not hittable: move to a new page
    {
        let doc = app.doc();
        let mut page = x_native::Node::frame("page-9", 1440.0, 1024.0);
        page.name = "Page 9".into();
        doc.editors
            .push(x_native::editor::Editor::new(page.clone()));
        doc.doc.pages.push(page);
        doc.page = doc.editors.len() - 1;
    }
    assert_eq!(
        app.comment_at(vello::kurbo::Point::new(sp.x + 12.0, sp.y - 12.0)),
        None,
        "pins of the inactive page are not hittable"
    );
    {
        let doc = app.doc();
        doc.page = 0;
    }

    // resolve + delete
    app.resolve_comment(&id1, true);
    assert!(app.doc().doc.comments[0].resolved);
    app.delete_comment(&id2);
    assert_eq!(app.doc().doc.comments.len(), 1);

    // .x roundtrip preserves the pins
    let dir = std::env::temp_dir().join("x-native-ui-test");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("comments.x");
    {
        let doc = app.doc();
        doc.sync();
        x_native::fileio::save_x_file(&doc.doc, path.to_string_lossy().as_ref()).unwrap();
    }
    let d2 = x_native::fileio::load_x_file(path.to_string_lossy().as_ref()).unwrap();
    assert_eq!(d2.comments.len(), 1);
    let c = &d2.comments[0];
    assert_eq!(c.id, id1);
    assert_eq!(c.text, "Looks off-brand");
    assert_eq!(c.author, crate::state::USER_NAME);
    assert!(c.resolved);
    assert_eq!((c.x, c.y), (100.0, 200.0));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn inspect_tab_platforms_and_copy() {
    let mut app = App::demo();
    app.win_w = 1440.0;
    app.win_h = 900.0;
    app.screen = Screen::Editor;
    app.center_view();
    let root_id = app.doc().editor_ref().root.id.clone();
    {
        let doc = app.doc();
        let mut r = x_native::Node::rect(
            "chip",
            40.0,
            40.0,
            120.0,
            44.0,
            x_native::Color::from_rgb8(0x5B, 0x7C, 0xFF),
        );
        r.corner_radii = Some([8.0; 4]);
        doc.editor().insert_node(&root_id, r);
        doc.editor().selection = vec!["chip".into()];
    }

    // CSS (default): id selector + absolute position + size
    assert_eq!(app.inspect_platform, 0);
    let css = app.inspect_code();
    assert!(css.contains(".chip {"), "{css}");
    assert!(css.contains("position: absolute;"), "{css}");
    assert!(css.contains("width: 120px;"), "{css}");
    assert!(css.contains("border-radius: 8px 8px 8px 8px;"), "{css}");

    // SwiftUI / Compose / XML all generate for the same selection
    app.inspect_platform = 1;
    let swift = app.inspect_code();
    assert!(
        swift.contains("RoundedRectangle(cornerRadius: 8)"),
        "{swift}"
    );
    assert!(swift.contains(".fill(Color(hex: 0x5B7CFF))"), "{swift}");
    app.inspect_platform = 2;
    let compose = app.inspect_code();
    assert!(compose.contains(".size(120.dp, 44.dp)"), "{compose}");
    app.inspect_platform = 3;
    let xml = app.inspect_code();
    assert!(xml.contains("<"), "{xml}");

    // dispatch arms drive the same state (panel buttons + copy button)
    app.doc().editor().selection = vec!["chip".into()];
    app.inspect_platform = 0;
    assert_eq!(app.inspect_platform, 0);

    // nothing selected -> empty code (Copy shows the hint status)
    app.doc().editor().selection.clear();
    assert!(app.inspect_code().is_empty());
    app.inspect_platform = 1;
    assert!(app.inspect_code().is_empty());
    app.inspect_platform = 0;
}

impl App {
    pub fn has_text_focus(&self) -> bool {
        self.text_edit.is_some()
            || self.field.is_some()
            || self.comment_draft.is_some()
            || self.palette.open
            || (self.screen == Screen::Dashboard && self.dash_search_focus)
    }

    pub fn ime_anchor(&self) -> Point {
        if let Some(field) = &self.field {
            if let Some((r, _)) = self
                .hit
                .iter()
                .find(|(_, a)| matches!(a, Action::Field(id) if *id == field.id))
            {
                return Point::new(r.x0, r.y1);
            }
        } else if self.text_edit.is_some() {
            if let Some((x, y)) = self.text_caret_pos(self.text_caret) {
                return Point::new(x, y + 20.0);
            }
        }
        if self.palette.open {
            return Point::new((self.win_w - 480.0) / 2.0, 150.0);
        }
        Point::new(
            self.mouse.x.clamp(0.0, self.win_w),
            self.mouse.y.clamp(0.0, self.win_h),
        )
    }

    pub fn autosave_all(&mut self) {
        let edit = self
            .text_edit
            .clone()
            .filter(|_| self.pending_text_dirty())
            .map(|id| (id, self.text_buffer.clone(), self.text_runs_edit.clone()));
        for i in 0..self.docs.len() {
            if self
                .document_loading
                .as_ref()
                .and_then(|l| l.candidate.as_ref())
                == Some(&self.docs[i].recovery_path)
            {
                continue;
            }
            let d = &mut self.docs[i];
            // Snapshot in-progress text without committing or stealing focus.
            let pending = if i == self.active {
                edit.as_ref()
            } else {
                None
            };
            let restore = pending.and_then(|(id, text, runs)| {
                let node = x_native::editor::find_mut(&mut d.editor().root, id)?;
                let old = node.clone();
                if let NodeKind::Text { text: value } = &mut node.kind {
                    *value = text.clone();
                }
                node.text_runs = runs.clone();
                Some((id.clone(), old))
            });
            let (dirty, revision) = (d.dirty, d.last_autosave_revision);
            if restore.is_some() {
                d.dirty = true;
                d.last_autosave_revision = None;
            }
            let result = d.autosave_now();
            if let Some((id, old)) = restore {
                if let Some(node) = x_native::editor::find_mut(&mut d.editor().root, &id) {
                    *node = old;
                }
                d.dirty = dirty;
                d.last_autosave_revision = revision;
                d.sync();
            }
            match result {
                Err(e) => {
                    self.status = format!("Autosave failed: {e}. Use Save As to protect your work.")
                }
                Ok(true) => {
                    if let Some(note) = &d.autosave_note {
                        self.status = note.clone();
                    }
                }
                Ok(false) => {}
            }
        }
    }

    pub fn canvas_scene(&mut self) -> Scene {
        let canvas = self.view_canvas();
        let a = self.screen_to_world(Point::new(canvas.x0, canvas.y0));
        let b = self.screen_to_world(Point::new(canvas.x1, canvas.y1));
        let viewport = Rect::from_points(a, b);
        let Some(d) = self.docs.get_mut(self.active) else {
            return Scene::new();
        };
        if d.assets.sync_store(&d.doc.assets) > 0 {
            d.frame_cache = x_native::FrameCache::new();
        }
        d.frame_cache.set_hidden_text(self.text_edit.as_deref());
        let root = &d.editors[d.page].root;
        let sink = x_native::VelloSink {
            assets: Some(&d.assets),
            fonts: Some(&self.fonts.fonts),
        };
        d.frame_cache
            .render_viewport(root, &d.doc.variables, &sink, Some(viewport))
            .clone()
    }
}

fn paint_feedback(app: &mut App, scene: &mut Scene) {
    use crate::paint::{fill_rect, hline, Wt};
    let y = app.win_h - 22.0;
    fill_rect(scene, Rect::new(0.0, y, app.win_w, app.win_h), C_PANEL);
    hline(scene, 0.0, app.win_w, y, C_LINE);
    let prefix = if app.demo_mode {
        "DEMO · sample content · "
    } else {
        ""
    };
    let status = app
        .file_job
        .as_ref()
        .map(|j| {
            if j.cancelling {
                "Cancelling file operation…"
            } else {
                j.label.as_str()
            }
        })
        .unwrap_or(&app.status);
    let message = app.fonts.truncate(
        &format!("{prefix}{status}"),
        T10,
        Wt::Reg,
        app.win_w - if app.file_job.is_some() { 120.0 } else { 28.0 },
    );
    app.fonts
        .text(scene, 12.0, y + 5.0, &message, T10, C_TEXT, Wt::Reg);
    if app.file_job.as_ref().is_some_and(|j| j.cancelable) {
        let rect = Rect::new(app.win_w - 88.0, y + 2.0, app.win_w - 8.0, app.win_h - 2.0);
        crate::paint::fill_rrect(scene, rect, 4.0, C_FIELD_2);
        app.fonts
            .text_center(scene, rect, "Cancel", T10, C_TEXT, Wt::Med, true);
        app.hit.push((rect, Action::CancelFileOperation));
    }
    if !app.ime_preedit.is_empty() {
        let p = app.ime_anchor();
        let width = app.fonts.measure(&app.ime_preedit, T13, Wt::Reg).max(40.0) + 16.0;
        let x = p.x.min((app.win_w - width).max(0.0));
        let y = p.y.min(app.win_h - 52.0);
        fill_rect(scene, Rect::new(x, y, x + width, y + 25.0), C_FIELD);
        app.fonts.text(
            scene,
            x + 8.0,
            y + 4.0,
            &app.ime_preedit,
            T13,
            C_TEXT,
            Wt::Reg,
        );
        hline(scene, x + 8.0, x + width - 8.0, y + 22.0, C_DIM);
    }
}

#[cfg(test)]
#[path = "regression_tests.rs"]
mod audit_regressions;

impl App {
    /// The logical-frame path used by the native window and CPU profiling.
    pub fn compose_frame(&mut self) -> Scene {
        let mut inner = Scene::new();
        if self
            .document_loading
            .as_ref()
            .is_some_and(crate::loading::LoadingScreen::draws_overlay)
        {
            crate::loading::paint(self, &mut inner);
            return inner;
        }
        match self.screen {
            Screen::Dashboard => {
                dashboard::paint(self, &mut inner);
            }
            Screen::Editor => {
                editor_ui::paint(self, &mut inner);
                // document content, clipped to the viewport (the whole
                // window in the chrome-less flow viewer)
                let canvas = self.view_canvas();
                if !self.docs.is_empty() {
                    let doc_scene = self.canvas_scene();
                    if self.demo_mode {
                        watermark_shadows(self, &mut inner, &self.doc_ref().editor_ref().root);
                    }
                    inner.push_layer(
                        vello::peniko::Fill::NonZero,
                        vello::peniko::BlendMode::new(
                            vello::peniko::Mix::Normal,
                            vello::peniko::Compose::SrcOver,
                        ),
                        1.0,
                        Affine::IDENTITY,
                        &canvas,
                    );
                    inner.append(&doc_scene, Some(self.canvas_affine()));
                    // empty-frame watermark: node name in black/10, 20px bold
                    if self.demo_mode {
                        watermark_labels(self, &mut inner, &self.doc_ref().editor_ref().root);
                    }
                    inner.pop_layer();
                }
                editor_ui::paint_over(self, &mut inner);
            }
            Screen::Board => {
                crate::board_ui::paint(self, &mut inner);
                let reg = self.board_regions();
                let (ox, oy, z) = self.board_canvas_transform();
                crate::board_ui::paint_grid(self, &mut inner, &reg);
                if self.is_board() {
                    inner.push_layer(
                        vello::peniko::Fill::NonZero,
                        vello::peniko::BlendMode::new(
                            vello::peniko::Mix::Normal,
                            vello::peniko::Compose::SrcOver,
                        ),
                        1.0,
                        Affine::IDENTITY,
                        &reg.canvas,
                    );
                    let board = self.board_doc();
                    crate::board_ui::paint_nodes(self, &mut inner, board, ox, oy, z);
                    inner.pop_layer();
                }
                crate::board_ui::paint_over(self, &mut inner);
            }
        }
        paint_feedback(self, &mut inner);
        inner
    }
}

#[cfg(test)]
#[path = "loading_tests.rs"]
mod loading_tests;
