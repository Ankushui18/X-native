//! Loading requirements: no synthetic waits, real worker stages, no input to
//! candidates, renderer readiness, retry/close, and recovery/cancellation safety.
use super::*;
use crate::loading::{LoadingScreen, Phase, PreviousView, Stage, ViewConfig};
use std::{
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};

fn host() -> Host {
    let mut app = App::new();
    app.docs = vec![OpenDoc::new_blank("Existing work".into())];
    app.active = 0;
    app.screen = Screen::Editor;
    let root = app.doc_ref().editor_ref().root.id.clone();
    app.doc().editor().insert_node(
        &root,
        Node::rect("existing", 0.0, 0.0, 20.0, 20.0, x_native::Color::WHITE),
    );
    app.mark_dirty();
    Host {
        window: None,
        gpu: None,
        app,
        scale: 1.0,
        files: Default::default(),
        recoveries: Default::default(),
        close_after_job: false,
        pending_open: None,
        next_loading_frame: Instant::now(),
        next_proto_frame: Instant::now(),
    }
}
fn path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{}-{name}", x_native::fresh_id("loading-test")))
}
fn svg_file() -> PathBuf {
    let p = path("document.svg");
    std::fs::write(&p,"<svg width=\"100\" height=\"100\"><rect x=\"10\" y=\"10\" width=\"20\" height=\"20\" fill=\"#ffffff\"/></svg>").unwrap();
    p
}
fn drain_cpu(h: &mut Host) {
    for _ in 0..8 {
        h.start_pending_open();
        if h.files.active.is_none() {
            return;
        }
        for p in h.files.progress() {
            if let Some(load) = &mut h.app.document_loading {
                load.update_stage(p.ticket, p.stage);
            }
        }
        let result = h.files.wait().unwrap();
        h.apply_file_result(result);
    }
    panic!("preparation failed to converge");
}
fn ready(h: &Host) -> bool {
    h.app
        .document_loading
        .as_ref()
        .is_some_and(|l| matches!(l.phase, Phase::Presenting))
}

#[test]
fn loading_appears_on_acceptance_and_blocks_old_hit_zones_and_edit_shortcuts() {
    let mut h = host();
    let p = svg_file();
    let before = h.app.docs.len();
    let revision = h.app.doc_ref().history.revision;
    h.open_path(p.clone());
    assert!(
        h.app.document_loading.is_some(),
        "state must be immediate, before polling the worker"
    );
    assert_eq!(h.app.docs.len(), before);
    assert!(
        h.app.hit.is_empty(),
        "stale document hit zones are invalidated immediately"
    );
    h.dispatch(Action::NewFile);
    h.dispatch(Action::AddPage);
    h.on_key(Key::Named(NamedKey::Delete), None);
    let zoom = h.app.zoom;
    h.on_wheel(MouseScrollDelta::LineDelta(0.0, 1.0));
    assert_eq!(h.app.zoom, zoom);
    assert_eq!(h.app.docs.len(), before);
    assert_eq!(h.app.doc_ref().history.revision, revision);
    let encoded = h.app.doc_ref().frame_cache.encode_count;
    h.app.compose_frame();
    assert_eq!(
        h.app.doc_ref().frame_cache.encode_count,
        encoded,
        "animation does not render the hidden document"
    );
    assert!(h
        .app
        .hit
        .iter()
        .all(|(_, a)| matches!(a, Action::LoadingClose)));
    h.wait_for_file_job();
    std::fs::remove_file(p).unwrap();
}

#[test]
fn readiness_is_gated_by_cache_preparation_and_first_native_presentation_not_time() {
    let mut h = host();
    let p = svg_file();
    h.open_path(p.clone());
    drain_cpu(&mut h);
    assert!(ready(&h));
    assert!(h.app.doc_ref().prepared_canvas.is_some());
    let scene = h.app.canvas_scene();
    assert!(scene.encoding().n_paths > 0);
    assert!(
        h.app.doc_ref().frame_cache.stats.full_hit,
        "the first canvas uses the worker's prepared cache"
    );
    let count = h.app.docs.len();
    h.dispatch(Action::NewFile);
    assert_eq!(h.app.docs.len(), count);
    // Reset the visual animation clock right before acknowledgement. Completion
    // must not wait for any elapsed-time threshold (small files stay instant).
    h.app.document_loading.as_mut().unwrap().started = Instant::now();
    h.document_frame_presented();
    assert!(h.app.document_loading.is_none());
    h.dispatch(Action::NewFile);
    assert_eq!(h.app.docs.len(), count + 1);
    std::fs::remove_file(p).unwrap();
}

#[test]
fn error_state_has_retry_and_close_and_retry_uses_the_actual_file() {
    let mut h = host();
    let p = path("missing.svg");
    let count = h.app.docs.len();
    h.open_path(p.clone());
    drain_cpu(&mut h);
    assert!(matches!(
        h.app.document_loading.as_ref().unwrap().phase,
        Phase::Failed { .. }
    ));
    h.app.compose_frame();
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| matches!(a, Action::LoadingRetry)));
    assert!(h
        .app
        .hit
        .iter()
        .any(|(_, a)| matches!(a, Action::LoadingClose)));
    assert_eq!(h.app.docs.len(), count);
    std::fs::write(&p, "<svg width=\"20\" height=\"20\"/>").unwrap();
    h.dispatch(Action::LoadingRetry);
    drain_cpu(&mut h);
    assert!(ready(&h));
    h.document_frame_presented();
    assert_eq!(h.app.docs.len(), count + 1);
    std::fs::remove_file(p).unwrap();
}

#[test]
fn close_error_keeps_previous_dirty_work_and_camera() {
    let mut h = host();
    h.app.pan = (81.0, 42.0);
    h.app.zoom = 2.5;
    let original = h.app.doc_ref().recovery_path.clone();
    h.open_path(path("not-here.svg"));
    drain_cpu(&mut h);
    h.dispatch(Action::LoadingClose);
    assert!(h.app.document_loading.is_none());
    assert_eq!(h.app.doc_ref().recovery_path, original);
    assert!(h.app.doc_ref().dirty);
    assert_eq!((h.app.zoom, h.app.pan), (2.5, (81.0, 42.0)));
}

#[test]
fn failed_first_render_never_exposes_a_candidate_or_discards_the_previous_document() {
    let mut h = host();
    let p = svg_file();
    let original = h.app.doc_ref().recovery_path.clone();
    h.open_path(p.clone());
    drain_cpu(&mut h);
    assert!(ready(&h));
    h.load_render_failure("Injected device failure".into(), false);
    assert!(matches!(
        h.app.document_loading.as_ref().unwrap().phase,
        Phase::Failed { .. }
    ));
    h.dispatch(Action::AddPage);
    assert_eq!(h.app.doc_ref().editors.len(), 1);
    h.dispatch(Action::LoadingClose);
    assert_eq!(h.app.docs.len(), 1);
    assert_eq!(h.app.doc_ref().recovery_path, original);
    assert!(p.exists());
    std::fs::remove_file(p).unwrap();
}

#[test]
fn a_resize_during_loading_reprepares_without_reading_the_file_again() {
    let mut h = host();
    let p = svg_file();
    h.open_path(p.clone());
    let done = h.files.wait().unwrap();
    std::fs::remove_file(&p).unwrap();
    h.update_dimensions(1200, 800, 1.0);
    h.apply_file_result(done);
    assert!(h.files.active.is_some());
    drain_cpu(&mut h);
    assert!(ready(&h));
    assert_eq!(
        h.app.doc_ref().prepared_canvas.unwrap().view,
        ViewConfig::from_app(&h.app)
    );
    h.document_frame_presented();
}

#[test]
fn a_resize_between_cpu_completion_and_present_keeps_the_loading_gate() {
    let mut h = host();
    let p = svg_file();
    h.open_path(p.clone());
    drain_cpu(&mut h);
    assert!(ready(&h));
    std::fs::remove_file(&p).unwrap();
    h.update_dimensions(1100, 720, 1.0);
    h.refresh_preparation_before_present();
    assert!(matches!(
        h.app.document_loading.as_ref().unwrap().phase,
        Phase::Working(Stage::Rendering)
    ));
    assert_eq!(
        h.app.docs.len(),
        1,
        "candidate is private while preparing again"
    );
    drain_cpu(&mut h);
    assert!(ready(&h));
    h.document_frame_presented();
}

#[test]
fn required_missing_images_fail_instead_of_publishing_placeholders() {
    let mut h = host();
    let p = path("missing-image.x");
    let doc = x_native::Document {
        pages: vec![Node::frame("page", 100.0, 100.0).child(Node::image(
            "image",
            0.0,
            0.0,
            20.0,
            20.0,
            "asset://missing",
        ))],
        ..Default::default()
    };
    std::fs::write(&p, x_native::fileio::save_x(&doc)).unwrap();
    h.open_path(p.clone());
    drain_cpu(&mut h);
    let Phase::Failed { message, .. } = &h.app.document_loading.as_ref().unwrap().phase else {
        panic!("missing asset should fail readiness")
    };
    assert!(message.contains("required image"));
    assert_eq!(h.app.docs.len(), 1);
    h.dispatch(Action::LoadingClose);
    std::fs::remove_file(p).unwrap();
}

#[test]
fn recovery_decisions_are_part_of_loading_and_never_overwrite_the_main_file() {
    let mut h = host();
    let p = path("recovery.x");
    let doc = x_native::Document {
        pages: vec![Node::frame("saved", 100.0, 100.0)],
        ..Default::default()
    };
    let saved = x_native::fileio::save_x(&doc);
    std::fs::write(&p, &saved).unwrap();
    let newer = x_native::Document {
        pages: vec![Node::frame("recovered", 100.0, 100.0)],
        ..Default::default()
    };
    let side = x_native::fileio::autosave_path(p.to_str().unwrap());
    std::fs::write(&side, x_native::fileio::save_x(&newer)).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&p)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() - Duration::from_secs(60)),
        )
        .unwrap();
    h.open_path(p.clone());
    drain_cpu(&mut h);
    assert!(matches!(
        h.app.document_loading.as_ref().unwrap().phase,
        Phase::Recovery(_)
    ));
    h.dispatch(Action::LoadingSaved);
    drain_cpu(&mut h);
    assert!(ready(&h));
    assert_eq!(h.app.doc_ref().editor_ref().root.id, "saved");
    assert_eq!(std::fs::read_to_string(&p).unwrap(), saved);
    h.document_frame_presented();
    std::fs::remove_file(p).unwrap();
    std::fs::remove_file(side).unwrap();
}

#[test]
fn queued_loading_is_immediate_and_cancel_does_not_cancel_an_unrelated_export() {
    let mut h = host();
    let (started, ready_rx) = mpsc::channel();
    let (resume, wait) = mpsc::channel();
    h.files
        .start(
            crate::jobs::Kind::Export,
            "Writing another export".into(),
            move || {
                started.send(()).unwrap();
                wait.recv().unwrap();
                Ok(crate::jobs::Output::Exported("export done".into()))
            },
        )
        .unwrap();
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let p = svg_file();
    h.open_path(p.clone());
    assert!(matches!(
        h.app.document_loading.as_ref().unwrap().phase,
        Phase::Working(Stage::Waiting)
    ));
    h.dispatch(Action::LoadingClose);
    assert!(!h.files.active.as_ref().unwrap().token.is_cancelled());
    resume.send(()).unwrap();
    h.wait_for_file_job();
    assert_eq!(h.app.docs.len(), 1);
    assert_eq!(h.app.status, "export done");
    std::fs::remove_file(p).unwrap();
}

#[test]
fn actual_worker_stages_are_ticketed_and_stale_progress_cannot_reopen_errors() {
    let mut h = host();
    let (started, ready_rx) = mpsc::channel();
    let (resume, wait) = mpsc::channel();
    let ticket = h
        .files
        .start_reported(
            crate::jobs::Kind::RecoveryScan,
            "Progress test".into(),
            move |reporter| {
                reporter.report(Stage::Reading);
                started.send(()).unwrap();
                wait.recv().unwrap();
                reporter.report(Stage::Validating);
                Ok(crate::jobs::Output::Recoveries(Default::default()))
            },
        )
        .unwrap();
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let events = h.files.progress();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].ticket, ticket);
    assert_eq!(events[0].stage, Stage::Reading);
    let request = crate::jobs::OpenRequest {
        path: PathBuf::from("example.svg"),
        mode: crate::jobs::OpenMode::Saved,
    };
    let mut screen = LoadingScreen::new(ticket + 1, request, PreviousView::capture(&h.app));
    screen.update_stage(ticket, Stage::Assets);
    assert!(matches!(screen.phase, Phase::Working(Stage::Waiting)));
    screen.fail("error".into(), None);
    screen.update_stage(ticket + 1, Stage::Rendering);
    assert!(matches!(screen.phase, Phase::Failed { .. }));
    resume.send(()).unwrap();
    h.wait_for_file_job();
}

#[test]
fn indeterminate_animation_changes_pixels_not_state_or_percentage() {
    let mut h = host();
    let request = crate::jobs::OpenRequest {
        path: PathBuf::from("Project.x"),
        mode: crate::jobs::OpenMode::Saved,
    };
    let mut loading = LoadingScreen::new(1, request, PreviousView::capture(&h.app));
    loading.phase = Phase::Working(Stage::Assets);
    h.app.document_loading = Some(loading.clone());
    let mut a = Scene::new();
    let mut b = Scene::new();
    crate::loading::paint_at(&mut h.app, &mut a, &loading, Duration::ZERO);
    crate::loading::paint_at(&mut h.app, &mut b, &loading, Duration::from_millis(150));
    assert_ne!(a.encoding().path_data, b.encoding().path_data);
    assert!(matches!(
        h.app.document_loading.as_ref().unwrap().phase,
        Phase::Working(Stage::Assets)
    ));
    assert!(!Stage::Assets.label().contains('%'));
}

#[test]
fn keyboard_retry_close_and_focus_are_available_without_editor_shortcuts() {
    let mut h = host();
    let p = path("retry.svg");
    h.open_path(p);
    drain_cpu(&mut h);
    h.on_key(Key::Named(NamedKey::Tab), None);
    assert_eq!(h.app.document_loading.as_ref().unwrap().focused_button, 1);
    h.on_key(Key::Named(NamedKey::Enter), None);
    assert!(h.app.document_loading.is_none());
    assert_eq!(h.app.docs.len(), 1);
}

#[test]
#[ignore = "GPU-rendered loading/error/recovery previews; output directory must be supplied"]
fn loading_screen_visuals() {
    let directory = std::env::var_os("X_NATIVE_LOADING_PREVIEW_DIR")
        .map(PathBuf::from)
        .expect("set X_NATIVE_LOADING_PREVIEW_DIR");
    std::fs::create_dir_all(&directory).unwrap();
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        compatible_surface: None,
        force_fallback_adapter: true,
    }))
    .unwrap();
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).unwrap();
    let mut renderer = Renderer::new(
        &device,
        RendererOptions {
            use_cpu: false,
            antialiasing_support: vello::AaSupport::all(),
            num_init_threads: std::num::NonZeroUsize::new(1),
            ..Default::default()
        },
    )
    .unwrap();
    let mut h = host();
    h.app.win_w = 1100.0;
    h.app.win_h = 760.0;
    let request = crate::jobs::OpenRequest {
        path: PathBuf::from("Commerce design system.x"),
        mode: crate::jobs::OpenMode::Ask,
    };
    let mut loading = LoadingScreen::new(1, request.clone(), PreviousView::capture(&h.app));
    let phases=[
        ("loading",Phase::Working(Stage::Assets)),
        ("error",Phase::Failed {message:"A required image asset could not be loaded. Restore the missing asset, then try again.".into(),recovery:None}),
        ("recovery",Phase::Recovery(crate::jobs::RecoveryOffer {request:crate::jobs::OpenRequest {mode:crate::jobs::OpenMode::Autosave,..request},reason:"Newer autosave".into()})),
    ];
    for (name, phase) in phases {
        loading.phase = phase;
        h.app.document_loading = Some(loading.clone());
        let mut scene = Scene::new();
        crate::loading::paint_at(&mut h.app, &mut scene, &loading, Duration::from_millis(350));
        let (w, height) = (1100u32, 760u32);
        let texture = device.create_texture(&crate::gpu_target::descriptor(w, height));
        let view = texture.create_view(&Default::default());
        renderer
            .render_to_texture(
                &device,
                &queue,
                &scene,
                &view,
                &RenderParams {
                    base_color: C_BG,
                    width: w,
                    height,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .unwrap();
        let stride = (w * 4).div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("loading preview"),
            size: u64::from(stride) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width: w,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        let (send, receive) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            send.send(r).unwrap();
        });
        device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(30)),
            })
            .unwrap();
        receive.recv().unwrap().unwrap();
        let bytes = slice.get_mapped_range();
        let mut pixels = Vec::with_capacity((w * height * 4) as usize);
        for row in 0..height {
            let offset = (row * stride) as usize;
            pixels.extend_from_slice(&bytes[offset..offset + (w * 4) as usize]);
        }
        let output = std::fs::File::create(directory.join(format!("{name}.png"))).unwrap();
        let mut encoder = png::Encoder::new(output, w, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&pixels)
            .unwrap();
        drop(bytes);
        buffer.unmap();
    }
}

#[test]
fn missing_render_component_fails_before_editor_publication() {
    let mut h = host();
    let p = path("missing-component.x");
    let document = x_native::Document {
        pages: vec![Node::frame("p", 100.0, 100.0).child(Node::instance(
            "i",
            "Missing master",
            0.0,
            0.0,
            20.0,
            20.0,
        ))],
        ..Default::default()
    };
    std::fs::write(&p, x_native::fileio::save_x(&document)).unwrap();
    h.open_path(p.clone());
    drain_cpu(&mut h);
    let Phase::Failed { message, .. } = &h.app.document_loading.as_ref().unwrap().phase else {
        panic!("missing master must not look ready")
    };
    assert!(message.contains("component"));
    assert_eq!(h.app.docs.len(), 1);
    h.dispatch(Action::LoadingClose);
    std::fs::remove_file(p).unwrap();
}

#[test]
fn autosave_protects_existing_work_but_never_serializes_an_unpresented_candidate() {
    let mut h = host();
    let old_recovery = path("existing-recovery.x");
    h.app.doc().recovery_path = old_recovery.clone();
    let input = svg_file();
    h.open_path(input.clone());
    drain_cpu(&mut h);
    assert!(ready(&h));
    let candidate_recovery = h.app.doc_ref().recovery_path.clone();
    h.app.autosave_all();
    assert!(old_recovery.exists());
    assert!(!candidate_recovery.exists());
    h.dispatch(Action::LoadingClose);
    assert!(old_recovery.exists());
    assert_eq!(h.app.docs.len(), 1);
    std::fs::remove_file(old_recovery).unwrap();
    std::fs::remove_file(input).unwrap();
}

#[test]
fn closing_failed_recovery_presentation_keeps_the_recovery_source() {
    let mut h = host();
    let p = path("original-recovery.x");
    let d = x_native::Document {
        pages: vec![Node::frame("recovered-page", 100.0, 100.0)],
        ..Default::default()
    };
    let original = x_native::fileio::save_x(&d);
    std::fs::write(&p, &original).unwrap();
    h.start_open(crate::jobs::OpenRequest {
        path: p.clone(),
        mode: crate::jobs::OpenMode::UnnamedRecovery,
    });
    drain_cpu(&mut h);
    assert!(ready(&h));
    h.load_render_failure("injected presentation failure".into(), false);
    h.dispatch(Action::LoadingClose);
    assert_eq!(std::fs::read_to_string(&p).unwrap(), original);
    assert_eq!(h.app.docs.len(), 1);
    std::fs::remove_file(p).unwrap();
}
