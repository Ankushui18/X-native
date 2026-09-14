//! Document-open presentation state. Time drives the spinner only; no timer
//! controls completion or enforces a minimum time on screen.
use crate::{
    jobs::{OpenRequest, RecoveryOffer},
    paint::{self, Wt},
    state::{Action, App, OpenDoc, Screen},
    theme::*,
};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use vello::{
    kurbo::{Affine, BezPath, Cap, Point, Rect, Stroke},
    Scene,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Waiting,
    Reading,
    Parsing,
    Decompressing,
    Validating,
    Building,
    Assets,
    Rendering,
    Opening,
}
impl Stage {
    pub fn label(self) -> &'static str {
        match self {
            Self::Waiting => "Waiting for the file worker",
            Self::Reading => "Reading the file",
            Self::Parsing => "Reading the document structure",
            Self::Decompressing => "Decompressing document resources",
            Self::Validating => "Validating the document",
            Self::Building => "Building the document",
            Self::Assets => "Loading images and other assets",
            Self::Rendering => "Preparing rendering and caches",
            Self::Opening => "Opening the document in the editor",
        }
    }
}

#[derive(Clone)]
pub enum Phase {
    Working(Stage),
    Recovery(RecoveryOffer),
    Failed {
        message: String,
        recovery: Option<RecoveryOffer>,
    },
    /// CPU initialization is complete. Inputs stay blocked until the native
    /// host confirms that the first editor frame was successfully presented.
    Presenting,
}
#[derive(Clone)]
pub struct PreviousView {
    pub document: Option<PathBuf>,
    pub screen: Screen,
    pub zoom: f64,
    pub pan: (f64, f64),
}
impl PreviousView {
    pub fn capture(app: &App) -> Self {
        Self {
            document: app.doc_opt().map(|d| d.recovery_path.clone()),
            screen: app.screen,
            zoom: app.zoom,
            pan: app.pan,
        }
    }
}
#[derive(Clone)]
pub struct LoadingScreen {
    pub ticket: u64,
    pub request: OpenRequest,
    pub phase: Phase,
    pub previous: PreviousView,
    /// Only a newly inserted, not-yet-presented document is rollback-owned.
    pub candidate: Option<PathBuf>,
    pub focused_button: usize,
    pub started: Instant,
    pub surface_failures: u8,
}
impl LoadingScreen {
    pub fn new(ticket: u64, request: OpenRequest, previous: PreviousView) -> Self {
        Self {
            ticket,
            request,
            phase: Phase::Working(Stage::Waiting),
            previous,
            candidate: None,
            focused_button: 0,
            started: Instant::now(),
            surface_failures: 0,
        }
    }
    pub fn update_stage(&mut self, ticket: u64, stage: Stage) {
        if self.ticket == ticket && matches!(self.phase, Phase::Working(_)) {
            self.phase = Phase::Working(stage);
        }
    }
    pub fn fail(&mut self, message: String, recovery: Option<RecoveryOffer>) {
        self.phase = Phase::Failed { message, recovery };
        self.focused_button = 0;
    }
    pub fn animates(&self) -> bool {
        matches!(self.phase, Phase::Working(_))
    }
    pub fn draws_overlay(&self) -> bool {
        !matches!(self.phase, Phase::Presenting)
    }
    pub fn buttons(&self) -> Vec<(&'static str, Action)> {
        match &self.phase {
            Phase::Working(_) => vec![("Cancel", Action::LoadingClose)],
            Phase::Presenting => vec![],
            Phase::Recovery(_) => vec![
                ("Recover", Action::LoadingRecover),
                ("Open saved file", Action::LoadingSaved),
                ("Cancel", Action::LoadingClose),
            ],
            Phase::Failed { recovery, .. } => {
                let mut buttons = vec![
                    ("Try Again", Action::LoadingRetry),
                    ("Close", Action::LoadingClose),
                ];
                if recovery.is_some() {
                    buttons.insert(1, ("Recover a copy", Action::LoadingRecover));
                }
                buttons
            }
        }
    }
}

/// Shared with center_view and the worker, so the cache is prepared for the
/// exact camera that the editor will use on its first frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewConfig {
    pub width: f64,
    pub height: f64,
    pub ruler: f64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub zoom: f64,
    pub pan: (f64, f64),
}
impl ViewConfig {
    pub fn from_app(app: &App) -> Self {
        let canvas = app.editor_regions().canvas;
        Self {
            width: canvas.width().max(1.0),
            height: canvas.height().max(1.0),
            ruler: if app.rulers { RULER_SIZE } else { 0.0 },
        }
    }
    pub fn camera(self, doc: Option<&OpenDoc>) -> Camera {
        let pan = doc
            .and_then(|d| d.editor_ref().root.children.first())
            .map_or((self.width / 2.0, self.height / 2.0), |n| {
                (
                    (self.width - n.w) / 2.0 - n.transform.x,
                    (self.height - n.h) / 2.0 - n.transform.y,
                )
            });
        Camera { zoom: 1.0, pan }
    }
    pub fn viewport(self, camera: Camera) -> Rect {
        let x = (-camera.pan.0 - self.ruler) / camera.zoom;
        let y = (-camera.pan.1 - self.ruler) / camera.zoom;
        Rect::new(
            x,
            y,
            x + self.width / camera.zoom,
            y + self.height / camera.zoom,
        )
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreparedCanvas {
    pub view: ViewConfig,
    pub camera: Camera,
    pub font_epoch: u64,
}
pub struct RenderEnvironment {
    pub view: ViewConfig,
    pub fonts: x_native::text::FontManager,
}
impl RenderEnvironment {
    pub fn capture(app: &App) -> Self {
        Self {
            view: ViewConfig::from_app(app),
            fonts: app.fonts.fonts.clone(),
        }
    }
}

pub fn card_rect(app: &App) -> Rect {
    let width = (app.win_w - 48.0).clamp(280.0, 544.0);
    let height = 340.0;
    let x = (app.win_w - width) / 2.0;
    let y = ((app.win_h - height) / 2.0).max(48.0);
    Rect::new(x, y, x + width, y + height)
}
pub fn button_rects(app: &App) -> Vec<(Rect, &'static str, Action)> {
    let Some(load) = &app.document_loading else {
        return vec![];
    };
    let card = card_rect(app);
    let buttons = load.buttons();
    if buttons.is_empty() {
        return vec![];
    }
    let gap = 10.0;
    let width = ((card.width() - 64.0) - gap * (buttons.len() - 1) as f64) / buttons.len() as f64;
    buttons
        .into_iter()
        .enumerate()
        .map(|(i, (label, action))| {
            let x = card.x0 + 32.0 + i as f64 * (width + gap);
            (
                Rect::new(x, card.y1 - 64.0, x + width, card.y1 - 28.0),
                label,
                action,
            )
        })
        .collect()
}
pub fn hit_action(app: &App, point: Point) -> Option<Action> {
    button_rects(app)
        .into_iter()
        .find(|(rect, _, _)| rect.contains(point))
        .map(|(_, _, a)| a)
}

pub fn paint(app: &mut App, scene: &mut Scene) {
    let Some(load) = app.document_loading.clone() else {
        return;
    };
    paint_at(app, scene, &load, load.started.elapsed());
}
/// Elapsed time changes visual rotation, never the loading state.
pub fn paint_at(app: &mut App, scene: &mut Scene, load: &LoadingScreen, elapsed: Duration) {
    use paint::{fill_rect, fill_rrect, stroke_rrect};
    app.hit.clear();
    fill_rect(scene, Rect::new(0.0, 0.0, app.win_w, app.win_h), C_BG);
    app.fonts
        .text(scene, 28.0, 22.0, "X-NATIVE", T12, C_TEXT, Wt::Semi);
    app.fonts
        .text(scene, 114.0, 23.0, "/  DOCUMENT", T10, C_DIM, Wt::Reg);
    let card = card_rect(app);
    fill_rrect(scene, card, 12.0, C_PANEL);
    stroke_rrect(scene, card, 12.0, C_LINE_2, 1.0);
    let cx = (card.x0 + card.x1) / 2.0;
    let icon = Point::new(cx, card.y0 + 48.0);
    if load.animates() {
        let angle = elapsed.as_secs_f64() * std::f64::consts::TAU / 1.15;
        for i in 0..12 {
            let a = angle + i as f64 * std::f64::consts::TAU / 12.0;
            let mut line = BezPath::new();
            line.move_to((icon.x + a.cos() * 11.0, icon.y + a.sin() * 11.0));
            line.line_to((icon.x + a.cos() * 17.0, icon.y + a.sin() * 17.0));
            scene.stroke(
                &Stroke::new(3.0).with_caps(Cap::Round),
                Affine::IDENTITY,
                C_LOGO_GREEN.multiply_alpha(0.18 + 0.82 * i as f32 / 11.0),
                None,
                &line,
            );
        }
    } else {
        let glyph = if matches!(load.phase, Phase::Failed { .. }) {
            "!"
        } else {
            "?"
        };
        paint::ring(scene, icon.x, icon.y, 18.0, C_LINE_2, 1.5);
        app.fonts.text_center(
            scene,
            Rect::new(icon.x - 16.0, icon.y - 16.0, icon.x + 16.0, icon.y + 16.0),
            glyph,
            T20,
            C_TEXT,
            Wt::Semi,
            true,
        );
    }
    let (title, detail) = match &load.phase {
        Phase::Working(stage) => ("Opening your document", stage.label().to_string()),
        Phase::Recovery(_) => (
            "Recover unsaved work?",
            "A newer recovery snapshot was found. Choose which version to open.".into(),
        ),
        Phase::Failed { message, .. } => ("Couldn't open this document", message.clone()),
        Phase::Presenting => ("Opening your document", Stage::Opening.label().into()),
    };
    app.fonts.text_center(
        scene,
        Rect::new(
            card.x0 + 24.0,
            card.y0 + 84.0,
            card.x1 - 24.0,
            card.y0 + 118.0,
        ),
        title,
        T20,
        C_TEXT,
        Wt::Semi,
        true,
    );
    let filename = load
        .request
        .path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let filename = app
        .fonts
        .truncate(&filename, T12, Wt::Med, card.width() - 64.0);
    app.fonts.text_center(
        scene,
        Rect::new(
            card.x0 + 32.0,
            card.y0 + 122.0,
            card.x1 - 32.0,
            card.y0 + 147.0,
        ),
        &filename,
        T12,
        C_MUTED,
        Wt::Med,
        true,
    );
    let lines = wrapped_lines(app, &detail, card.width() - 64.0, 3);
    for (i, line) in lines.iter().enumerate() {
        app.fonts.text_center(
            scene,
            Rect::new(
                card.x0 + 32.0,
                card.y0 + 161.0 + i as f64 * 21.0,
                card.x1 - 32.0,
                card.y0 + 182.0 + i as f64 * 21.0,
            ),
            line,
            T12,
            if load.animates() { C_TEXT } else { C_MUTED },
            Wt::Reg,
            true,
        );
    }
    if load.animates() {
        app.fonts.text_center(
            scene,
            Rect::new(
                card.x0 + 24.0,
                card.y0 + 219.0,
                card.x1 - 24.0,
                card.y0 + 242.0,
            ),
            "The editor opens as soon as the document is ready.",
            T10,
            C_DIM,
            Wt::Reg,
            true,
        );
    }
    for (i, (rect, label, action)) in button_rects(app).into_iter().enumerate() {
        let focus = i == load.focused_button;
        let hover = rect.contains(app.mouse);
        fill_rrect(scene, rect, 6.0, if hover { C_FIELD_2 } else { C_FIELD });
        stroke_rrect(
            scene,
            rect,
            6.0,
            if focus { C_LOGO_GREEN } else { C_LINE_2 },
            1.0,
        );
        app.fonts
            .text_center(scene, rect, label, T12, C_TEXT, Wt::Med, true);
        app.hit.push((rect, action));
    }
}
fn wrapped_lines(app: &App, text: &str, width: f64, max: usize) -> Vec<String> {
    let bounded: String = text.chars().take(2048).collect();
    let words: Vec<_> = bounded.split_whitespace().collect();
    let mut lines = vec![];
    let mut at = 0;
    while at < words.len() && lines.len() < max {
        if lines.len() + 1 == max {
            lines.push(
                app.fonts
                    .truncate(&words[at..].join(" "), T12, Wt::Reg, width),
            );
            break;
        }
        let mut line = words[at].to_owned();
        at += 1;
        while at < words.len() {
            let candidate = format!("{line} {}", words[at]);
            if app.fonts.measure(&candidate, T12, Wt::Reg) > width {
                break;
            }
            line = candidate;
            at += 1;
        }
        lines.push(app.fonts.truncate(&line, T12, Wt::Reg, width));
    }
    lines
}
