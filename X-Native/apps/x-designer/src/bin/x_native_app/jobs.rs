//! One bounded, lazily started file worker. No worker touches App or Window.
//! Heavy parsing/decoding/export uses owned snapshots and returns to the UI
//! through a channel. Only the UI thread publishes documents and shows dialogs.
use crate::loading::{PreparedCanvas, RenderEnvironment, Stage};
use crate::state::OpenDoc;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError},
};
use x_native::fileio::{
    self,
    cancellation::{self, Cancellation},
};
use x_native::{text::FontManager, AssetStore, Assets, Node, Variables};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    Ask,
    Saved,
    Autosave,
    UnnamedRecovery,
    Repair,
}
#[derive(Clone)]
pub struct OpenRequest {
    pub path: PathBuf,
    pub mode: OpenMode,
}
#[derive(Clone)]
pub struct RecoveryOffer {
    pub request: OpenRequest,
    pub reason: String,
}
#[derive(Clone)]
pub struct FocusOrigin {
    pub document: Option<PathBuf>,
    pub revision: u64,
}

pub struct DisplayStatus {
    pub label: String,
    pub cancelable: bool,
    pub cancelling: bool,
}

pub enum Kind {
    Open { origin: FocusOrigin },
    Export,
    RecoveryScan,
}
pub enum Output {
    Opened {
        document: Box<OpenDoc>,
        path: PathBuf,
        note: String,
    },
    Offer(RecoveryOffer),
    Exported(String),
    Recoveries(VecDeque<RecoveryOffer>),
}
#[derive(Clone, Debug)]
pub struct Progress {
    pub ticket: u64,
    pub stage: Stage,
}
#[derive(Clone, Default)]
pub struct Reporter {
    ticket: u64,
    sender: Option<SyncSender<Progress>>,
}
impl Reporter {
    pub fn report(&self, stage: Stage) {
        if let Some(sender) = &self.sender {
            let _ = sender.try_send(Progress {
                ticket: self.ticket,
                stage,
            });
        }
    }
}
type Operation = Box<dyn FnOnce(&Reporter) -> Result<Output, String> + Send>;
struct Work {
    token: Cancellation,
    reporter: Reporter,
    operation: Operation,
}
pub struct Active {
    pub ticket: u64,
    pub kind: Kind,
    pub label: String,
    pub token: Cancellation,
}
pub struct Finished {
    pub ticket: u64,
    pub kind: Kind,
    pub result: Result<Output, String>,
    pub cancelled: bool,
}
#[derive(Default)]
pub struct Worker {
    sender: Option<SyncSender<Work>>,
    receiver: Option<Receiver<(u64, Result<Output, String>)>>,
    progress_sender: Option<SyncSender<Progress>>,
    progress_receiver: Option<Receiver<Progress>>,
    next: u64,
    pub active: Option<Active>,
}
impl Worker {
    pub fn next_ticket(&self) -> u64 {
        self.next.wrapping_add(1).max(1)
    }
    pub fn start(
        &mut self,
        kind: Kind,
        label: String,
        work: impl FnOnce() -> Result<Output, String> + Send + 'static,
    ) -> Result<(), String> {
        self.start_reported(kind, label, move |_| work())
            .map(|_| ())
    }
    pub fn start_reported(
        &mut self,
        kind: Kind,
        label: String,
        work: impl FnOnce(&Reporter) -> Result<Output, String> + Send + 'static,
    ) -> Result<u64, String> {
        if self.active.is_some() {
            return Err("A file operation is still running; wait for it or cancel it first".into());
        }
        if self.sender.is_none() {
            let (tx, rx) = mpsc::sync_channel::<Work>(1);
            let (done, out) = mpsc::sync_channel(1);
            let (progress, events) = mpsc::sync_channel(16);
            std::thread::Builder::new().name("x-native-file-worker".into()).spawn(move || {
                while let Ok(work)=rx.recv() {
                    let ticket=work.reporter.ticket;
                    let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        cancellation::with_cancellation(&work.token,|| {
                            work.token.check()?;
                            let result=(work.operation)(&work.reporter);
                            work.token.check()?;
                            result
                        })
                    })).unwrap_or_else(|_| Err("The file worker stopped unexpectedly; review the output before continuing".into()));
                    if done.send((ticket,result)).is_err() { break; }
                }
            }).map_err(|e|e.to_string())?;
            self.sender = Some(tx);
            self.receiver = Some(out);
            self.progress_sender = Some(progress);
            self.progress_receiver = Some(events);
        }
        let ticket = self.next_ticket();
        let token = Cancellation::new();
        let reporter = Reporter {
            ticket,
            sender: self.progress_sender.clone(),
        };
        self.sender
            .as_ref()
            .unwrap()
            .try_send(Work {
                token: token.clone(),
                reporter,
                operation: Box::new(work),
            })
            .map_err(|e| format!("Could not start file operation: {e}"))?;
        self.next = ticket;
        self.active = Some(Active {
            ticket,
            kind,
            label,
            token,
        });
        Ok(ticket)
    }
    pub fn cancel(&self) -> bool {
        self.active.as_ref().is_none_or(|a| a.token.cancel())
    }
    pub fn progress(&self) -> Vec<Progress> {
        self.progress_receiver
            .as_ref()
            .map(|rx| rx.try_iter().collect())
            .unwrap_or_default()
    }
    pub fn poll(&mut self) -> Option<Finished> {
        let (ticket, result) = match self.receiver.as_ref()?.try_recv() {
            Ok(value) => value,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => {
                let ticket = self.active.as_ref()?.ticket;
                self.sender = None;
                self.receiver = None;
                (
                    ticket,
                    Err("File worker disconnected; document data remains in memory".into()),
                )
            }
        };
        self.finish(ticket, result)
    }
    fn finish(&mut self, ticket: u64, result: Result<Output, String>) -> Option<Finished> {
        if self.active.as_ref()?.ticket != ticket {
            return None;
        }
        let active = self.active.take()?;
        let cancelled = active.token.is_cancelled();
        let result = if cancelled {
            Err("operation cancelled".into())
        } else {
            result
        };
        Some(Finished {
            ticket,
            kind: active.kind,
            result,
            cancelled,
        })
    }
    #[cfg(test)]
    pub fn wait(&mut self) -> Option<Finished> {
        let (ticket, result) = self
            .receiver
            .as_ref()?
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("file worker must finish test fixture");
        self.finish(ticket, result)
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.cancel();
        self.sender.take();
    }
}

#[cfg(test)]
pub fn open(request: OpenRequest) -> Result<Output, String> {
    open_tracked(request, &Reporter::default())
}
pub fn open_prepared(
    request: OpenRequest,
    environment: RenderEnvironment,
    reporter: &Reporter,
) -> Result<Output, String> {
    let output = open_tracked(request, reporter)?;
    prepare_opened(output, environment, reporter)
}
fn open_tracked(request: OpenRequest, reporter: &Reporter) -> Result<Output, String> {
    cancellation::checkpoint()?;
    reporter.report(Stage::Reading);
    let OpenRequest { path, mode } = request;
    if mode == OpenMode::Repair {
        let (document, reason) =
            crate::session::recovery_candidate_with_progress(&path, &|stage| {
                reporter.report(stage)
            })
            .ok_or("No usable backup or partial repair; original file kept")?;
        return Ok(Output::Opened {
            document: Box::new(document),
            path,
            note: format!("Recovered from {reason}; review and Save As"),
        });
    }
    let ext = if mode == OpenMode::UnnamedRecovery {
        "x".into()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    if mode == OpenMode::Ask
        && ext == "x"
        && fileio::check_crash_recovery(&path.to_string_lossy()).is_some()
    {
        cancellation::checkpoint()?;
        return Ok(Output::Offer(RecoveryOffer {
            request: OpenRequest {
                path,
                mode: OpenMode::Autosave,
            },
            reason: "a newer recovery snapshot".into(),
        }));
    }
    let read = if mode == OpenMode::Autosave {
        PathBuf::from(fileio::autosave_path(&path.to_string_lossy()))
    } else {
        path.clone()
    };
    match crate::session::load_document_with_progress(&read, &ext, &path, &|stage| {
        reporter.report(stage)
    }) {
        Ok(mut document) => {
            let note = match mode {
                OpenMode::Autosave => {
                    document.require_save();
                    "Recovered newer autosave — Save to keep it".into()
                }
                OpenMode::UnnamedRecovery => {
                    document.path = None;
                    document.canonical_path = None;
                    document.recovery_path = path.clone();
                    document.require_save();
                    "Recovered unsaved document — choose Save As".into()
                }
                _ if ext != "x" => "Imported — save a native .x copy; source is unchanged".into(),
                _ => "Opened".into(),
            };
            Ok(Output::Opened {
                document: Box::new(document),
                path,
                note,
            })
        }
        Err(error)
            if !path.exists() && fileio::list_backups(&path.to_string_lossy()).is_empty() =>
        {
            Err(format!("File is missing; locate it with Open. {error}"))
        }
        Err(error)
            if ext == "x"
                && mode != OpenMode::Autosave
                && mode != OpenMode::UnnamedRecovery
                && !cancellation::is_cancelled() =>
        {
            // Do not decode several backup documents merely to display a dialog.
            Ok(Output::Offer(RecoveryOffer {
                request: OpenRequest {
                    path,
                    mode: OpenMode::Repair,
                },
                reason: format!("Open failed: {error}. Try an intact backup or a partial repair?"),
            }))
        }
        Err(error) => Err(error),
    }
}

/// Warm the first visible page on the worker, before the UI can publish it.
/// This runs again (without rereading the file) if view/font inputs changed.
pub fn prepare_opened(
    mut output: Output,
    environment: RenderEnvironment,
    reporter: &Reporter,
) -> Result<Output, String> {
    if let Output::Opened { document, .. } = &mut output {
        cancellation::checkpoint()?;
        reporter.report(Stage::Rendering);
        fileio::validate_admission(&document.doc)?;
        document
            .assets
            .sync_store_cancellable(&document.doc.assets, &cancellation::is_cancelled)?;
        ensure_assets_ready(document)?;
        let camera = environment.view.camera(Some(document));
        let page = document.page;
        let sink = x_native::VelloSink {
            assets: Some(&document.assets),
            fonts: Some(&environment.fonts),
        };
        document.frame_cache.render_viewport(
            &document.editors[page].root,
            &document.doc.variables,
            &sink,
            Some(environment.view.viewport(camera)),
        );
        cancellation::checkpoint()?;
        document.prepared_canvas = Some(PreparedCanvas {
            view: environment.view,
            camera,
            font_epoch: environment.fonts.epoch(),
        });
    }
    Ok(output)
}

fn ensure_assets_ready(document: &OpenDoc) -> Result<(), String> {
    // Renderer registries are page-local. Missing component masters must not
    // become silently empty instances in the supposedly ready document.
    for editor in &document.editors {
        let mut masters = std::collections::HashSet::new();
        let mut references = std::collections::HashSet::new();
        let mut nodes = vec![&editor.root];
        while let Some(node) = nodes.pop() {
            cancellation::checkpoint()?;
            match &node.kind {
                x_native::NodeKind::Component { name } => {
                    masters.insert(name.as_str());
                }
                x_native::NodeKind::Instance { component } => {
                    references.insert(component.as_str());
                }
                _ => {}
            }
            for value in node.overrides.values() {
                if let Some(name) = value.strip_prefix("swap:").filter(|n| !n.is_empty()) {
                    references.insert(name);
                }
            }
            nodes.extend(&node.children);
        }
        if references.iter().any(|name| !masters.contains(name)) {
            return Err("A component required for rendering is missing. Restore its master definition or library, then try again.".into());
        }
    }
    let mut missing = std::collections::HashSet::new();
    let mut pending: Vec<_> = document.editors.iter().map(|e| &e.root).collect();
    while let Some(node) = pending.pop() {
        cancellation::checkpoint()?;
        if let x_native::NodeKind::Image { asset, .. } = &node.kind {
            if document.assets.get(asset).is_none() {
                missing.insert(asset.clone());
            }
        }
        for paint in node
            .active_fills()
            .iter()
            .map(|f| &f.paint)
            .chain(node.active_strokes().iter().map(|s| &s.stroke.paint))
        {
            if let x_native::Paint::Pattern { asset, .. } = paint {
                if document.assets.get(asset).is_none() {
                    missing.insert(asset.clone());
                }
            }
        }
        pending.extend(&node.children);
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("{} required image asset(s) are missing, damaged, or unsupported. Restore the assets, then try again. PNG and JPEG images are supported.",missing.len()))
    }
}

pub fn scan_recovery(dir: PathBuf, recents: Vec<PathBuf>) -> Result<Output, String> {
    let mut files = vec![];
    for entry in std::fs::read_dir(dir).into_iter().flatten() {
        cancellation::checkpoint()?;
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "x") {
            files.push((entry.metadata().and_then(|m| m.modified()).ok(), path));
        }
    }
    files.sort_by_key(|(time, _)| *time);
    let mut offers: VecDeque<_> = files
        .into_iter()
        .rev()
        .take(10)
        .map(|(_, path)| RecoveryOffer {
            request: OpenRequest {
                path,
                mode: OpenMode::UnnamedRecovery,
            },
            reason: "an unsaved recovery file".into(),
        })
        .collect();
    for path in recents.into_iter().take(10) {
        cancellation::checkpoint()?;
        if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("x"))
            && fileio::check_crash_recovery(&path.to_string_lossy()).is_some()
        {
            offers.push_back(RecoveryOffer {
                request: OpenRequest {
                    path,
                    mode: OpenMode::Autosave,
                },
                reason: "a newer recovery snapshot".into(),
            });
        }
    }
    Ok(Output::Recoveries(offers))
}

pub struct ExportRequest {
    pub root: Node,
    pub variables: Variables,
    pub selection: Option<Vec<String>>,
    pub assets: AssetStore,
    pub decoded: Assets,
    pub fonts: FontManager,
    pub path: PathBuf,
    pub format: usize,
    pub scale: f64,
}
impl ExportRequest {
    pub fn run(mut self) -> Result<Output, String> {
        cancellation::checkpoint()?;
        self.decoded
            .sync_store_cancellable(&self.assets, &cancellation::is_cancelled)?;
        let plan = x_native::prepare_export(
            &self.root,
            &self.variables,
            self.selection.as_deref(),
            &self.fonts,
        )?;
        cancellation::checkpoint()?;
        for c in &plan.tree.commands {
            if let x_native::RenderCommand::Image { asset, .. } = c {
                if self.decoded.get(asset).is_none() {
                    return Err(format!(
                        "Image asset {asset} is missing or could not be decoded"
                    ));
                }
            }
        }
        let raster = |format, background| {
            x_native::export_raster_cancellable(
                &plan.tree,
                plan.width,
                plan.height,
                format,
                self.scale,
                background,
                Some(&self.decoded),
                Some(&self.fonts),
                &cancellation::is_cancelled,
            )
        };
        let mut note = "Exported".to_string();
        let bytes = match self.format {
            2 => x_native::export_svg_ir(
                &plan.tree,
                plan.width,
                plan.height,
                &self.assets,
                &self.decoded,
            )?
            .into_bytes(),
            3 if x_native::export::pdf_needs_flattening(&plan.tree, &self.decoded) => {
                let (png, _, _) =
                    raster(x_native::RasterFormat::Png, Some(x_native::Color::WHITE))?;
                let mut decoded = Assets::new();
                decoded.load_png_bytes("paper", &png)?;
                let root = Node::image("paper", 0.0, 0.0, plan.width, plan.height, "paper");
                let tree = x_native::build_render_tree(&root, &Variables::default());
                note = format!(
                    "Exported PDF — rasterized at {}x on white to preserve transparency/blending",
                    self.scale
                );
                x_native::export_pdf_full(&tree, plan.width, plan.height, Some(&decoded), None)
            }
            3 => x_native::export_pdf_full(
                &plan.tree,
                plan.width,
                plan.height,
                Some(&self.decoded),
                Some(&self.fonts),
            ),
            4 => {
                // Sketch bundle: export_sketch consumes a full Document; the
                // export request carries the page tree + variables + assets,
                // which is everything the exporter reads.
                let doc = x_native::Document {
                    pages: vec![self.root.clone()],
                    variables: self.variables.clone(),
                    assets: self.assets.clone(),
                    ..Default::default()
                };
                cancellation::checkpoint()?;
                x_native::fileio::export_sketch(&doc)
            }
            0 | 1 => {
                raster(
                    if self.format == 1 {
                        x_native::RasterFormat::Jpg(90)
                    } else {
                        x_native::RasterFormat::Png
                    },
                    (self.format == 1).then_some(x_native::Color::WHITE),
                )?
                .0
            }
            _ => return Err("Unsupported export format".into()),
        };
        cancellation::checkpoint()?;
        fileio::atomic_write_path(&self.path, &bytes).map_err(|e| e.to_string())?;
        Ok(Output::Exported(note))
    }
}

pub fn same_document_path(a: &Path, b: &Path) -> bool {
    a == b // no filesystem calls in the UI's fast path
}
