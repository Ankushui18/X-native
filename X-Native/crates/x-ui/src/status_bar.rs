//! Market-standard Status Bar data model for X-Native Designer.
//! Supports: zoom, cursor, selection, connection, notifications, breadcrumbs,
//! performance metrics, toggles, progress tracking, and plugin status.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub type EntityId = Uuid;

// ─── Zoom Control ─────────────────────────────────────────

pub const ZOOM_PRESETS: &[f64] = &[0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 8.0];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoomState {
    pub zoom: f64,
    pub min_zoom: f64,
    pub max_zoom: f64,
}

impl ZoomState {
    pub fn new(zoom: f64) -> Self {
        Self {
            zoom,
            min_zoom: 0.01,
            max_zoom: 256.0,
        }
    }

    pub fn display_string(&self) -> String {
        if self.zoom >= 1.0 {
            format!("{}%", (self.zoom * 100.0).round() as i32)
        } else {
            format!("{:.0}%", self.zoom * 100.0)
        }
    }

    pub fn zoom_in(&mut self) -> f64 {
        let next = ZOOM_PRESETS
            .iter()
            .find(|&&p| p > self.zoom + 0.001)
            .copied()
            .unwrap_or(self.max_zoom);
        self.set_zoom(next)
    }

    pub fn zoom_out(&mut self) -> f64 {
        let prev = ZOOM_PRESETS
            .iter()
            .rev()
            .find(|&&p| p < self.zoom - 0.001)
            .copied()
            .unwrap_or(self.min_zoom);
        self.set_zoom(prev)
    }

    pub fn set_zoom(&mut self, zoom: f64) -> f64 {
        self.zoom = zoom.clamp(self.min_zoom, self.max_zoom);
        self.zoom
    }

    pub fn zoom_to_fit(
        &mut self,
        content_w: f64,
        content_h: f64,
        viewport_w: f64,
        viewport_h: f64,
    ) -> f64 {
        if content_w <= 0.0 || content_h <= 0.0 {
            return self.zoom;
        }
        let fit = (viewport_w / content_w).min(viewport_h / content_h) * 0.9;
        self.set_zoom(fit)
    }

    pub fn reset(&mut self) -> f64 {
        self.set_zoom(1.0)
    }
}

// ─── Cursor Tracking ──────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct CursorState {
    pub x: f64,
    pub y: f64,
    pub is_on_canvas: bool,
}

impl CursorState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, x: f64, y: f64) {
        self.x = x;
        self.y = y;
        self.is_on_canvas = true;
    }

    pub fn leave_canvas(&mut self) {
        self.is_on_canvas = false;
    }

    pub fn display_string(&self) -> String {
        if self.is_on_canvas {
            format!("X: {:.0}  Y: {:.0}", self.x, self.y)
        } else {
            "—".to_string()
        }
    }
}

// ─── Selection Summary ────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectionSummary {
    pub count: usize,
    pub bounds: Option<SelectionBounds>,
    pub uniform_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SelectionBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl SelectionSummary {
    pub fn empty() -> Self {
        Self {
            count: 0,
            bounds: None,
            uniform_type: None,
        }
    }

    pub fn display_string(&self) -> String {
        match self.count {
            0 => String::new(),
            1 => {
                let type_label = self.uniform_type.as_deref().unwrap_or("Element");
                if let Some(b) = &self.bounds {
                    format!("{} — {:.0} × {:.0}", type_label, b.width, b.height)
                } else {
                    type_label.to_string()
                }
            }
            n => {
                if let Some(b) = &self.bounds {
                    format!("{} selected — {:.0} × {:.0}", n, b.width, b.height)
                } else {
                    format!("{} selected", n)
                }
            }
        }
    }
}

// ─── Connection Status ────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionStatus {
    Online { collaborators: usize },
    Offline,
    Connecting,
    Syncing { progress_pct: u8 },
    Error(String),
}

impl ConnectionStatus {
    pub fn display_string(&self) -> String {
        match self {
            Self::Online { collaborators } => {
                if *collaborators > 0 {
                    format!("Online · {} editing", collaborators)
                } else {
                    "Online".to_string()
                }
            }
            Self::Offline => "Offline".to_string(),
            Self::Connecting => "Connecting…".to_string(),
            Self::Syncing { progress_pct } => format!("Syncing {}%", progress_pct),
            Self::Error(msg) => format!("Error: {}", msg),
        }
    }

    pub fn is_online(&self) -> bool {
        matches!(self, Self::Online { .. })
    }
}

// ─── Notifications ────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NotificationLevel {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone)]
pub struct StatusBarNotification {
    pub id: u64,
    pub level: NotificationLevel,
    pub message: String,
    pub created_at: Instant,
    pub duration: Duration,
    pub dismissed: bool,
}

impl StatusBarNotification {
    #[cfg(not(test))]
    pub fn is_expired(&self) -> bool {
        self.dismissed || self.created_at.elapsed() >= self.duration
    }

    #[cfg(test)]
    pub fn is_expired(&self) -> bool {
        self.dismissed
    }
}

#[derive(Debug, Clone)]
pub struct NotificationQueue {
    notifications: VecDeque<StatusBarNotification>,
    next_id: u64,
    max_visible: usize,
}

impl NotificationQueue {
    pub fn new(max_visible: usize) -> Self {
        Self {
            notifications: VecDeque::new(),
            next_id: 1,
            max_visible,
        }
    }

    pub fn push(&mut self, level: NotificationLevel, message: &str, duration: Duration) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.notifications.push_back(StatusBarNotification {
            id,
            level,
            message: message.to_string(),
            created_at: Instant::now(),
            duration,
            dismissed: false,
        });
        while self.notifications.len() > self.max_visible {
            self.notifications.pop_front();
        }
        id
    }

    pub fn info(&mut self, message: &str) -> u64 {
        self.push(NotificationLevel::Info, message, Duration::from_secs(3))
    }

    pub fn success(&mut self, message: &str) -> u64 {
        self.push(NotificationLevel::Success, message, Duration::from_secs(3))
    }

    pub fn warning(&mut self, message: &str) -> u64 {
        self.push(NotificationLevel::Warning, message, Duration::from_secs(5))
    }

    pub fn error(&mut self, message: &str) -> u64 {
        self.push(NotificationLevel::Error, message, Duration::from_secs(8))
    }

    pub fn dismiss(&mut self, id: u64) {
        if let Some(n) = self.notifications.iter_mut().find(|n| n.id == id) {
            n.dismissed = true;
        }
    }

    pub fn visible(&self) -> Vec<&StatusBarNotification> {
        self.notifications
            .iter()
            .filter(|n| !n.is_expired())
            .collect()
    }

    pub fn purge_expired(&mut self) {
        self.notifications.retain(|n| !n.is_expired());
    }

    pub fn count(&self) -> usize {
        self.notifications.len()
    }
}

// ─── Performance Metrics ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PerformanceMetrics {
    pub fps: f64,
    pub frame_time_ms: f64,
    pub gpu_memory_mb: f64,
    pub entity_count: usize,
    pub visible_entity_count: usize,
}

impl PerformanceMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn display_string(&self) -> String {
        format!(
            "{:.0} FPS · {:.1}ms · {} ent ({} vis)",
            self.fps, self.frame_time_ms, self.entity_count, self.visible_entity_count
        )
    }
}

// ─── Toggle States ────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToggleStates {
    pub grid_visible: bool,
    pub snap_to_grid: bool,
    pub snap_to_objects: bool,
    pub rulers_visible: bool,
    pub show_dimensions: bool,
    pub pixel_preview: bool,
}

// ─── Breadcrumb Navigation ───────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BreadcrumbSegment {
    pub label: String,
    pub entity_id: Option<EntityId>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BreadcrumbPath {
    pub segments: Vec<BreadcrumbSegment>,
}

impl BreadcrumbPath {
    pub fn new() -> Self {
        Self {
            segments: Vec::new(),
        }
    }

    pub fn push(&mut self, label: &str, entity_id: Option<EntityId>) {
        self.segments.push(BreadcrumbSegment {
            label: label.to_string(),
            entity_id,
        });
    }

    pub fn display_string(&self) -> String {
        self.segments
            .iter()
            .map(|s| s.label.as_str())
            .collect::<Vec<_>>()
            .join(" / ")
    }

    pub fn clear(&mut self) {
        self.segments.clear();
    }
}

// ─── Progress Tracking ────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProgressOperation {
    pub id: u64,
    pub label: String,
    pub progress_pct: u8,
    pub is_indeterminate: bool,
    pub completed: bool,
}

// ─── Complete Status Bar ──────────────────────────────────

#[derive(Debug, Clone)]
pub struct StatusBar {
    pub zoom: ZoomState,
    pub cursor: CursorState,
    pub selection: SelectionSummary,
    pub connection: ConnectionStatus,
    pub last_action: Option<String>,
    pub breadcrumbs: BreadcrumbPath,
    pub toggles: ToggleStates,
    pub performance: PerformanceMetrics,
    pub notifications: NotificationQueue,
    pub active_progress: Option<ProgressOperation>,
    pub plugin_status_count: usize,
    pub show_performance: bool,
}

impl Default for StatusBar {
    fn default() -> Self {
        Self::new()
    }
}

impl StatusBar {
    pub fn new() -> Self {
        Self {
            zoom: ZoomState::new(1.0),
            cursor: CursorState::new(),
            selection: SelectionSummary::empty(),
            connection: ConnectionStatus::Offline,
            last_action: None,
            breadcrumbs: BreadcrumbPath::new(),
            toggles: ToggleStates::default(),
            performance: PerformanceMetrics::new(),
            notifications: NotificationQueue::new(3),
            active_progress: None,
            plugin_status_count: 0,
            show_performance: false,
        }
    }

    pub fn update_cursor(&mut self, x: f64, y: f64) {
        self.cursor.update(x, y);
    }

    pub fn update_selection(&mut self, summary: SelectionSummary) {
        self.selection = summary;
    }

    pub fn set_last_action(&mut self, label: &str) {
        self.last_action = Some(label.to_string());
    }

    pub fn clear_last_action(&mut self) {
        self.last_action = None;
    }

    pub fn toggle_performance_display(&mut self) {
        self.show_performance = !self.show_performance;
    }

    pub fn start_progress(&mut self, label: &str, indeterminate: bool) -> u64 {
        let id = self.notifications.next_id;
        self.active_progress = Some(ProgressOperation {
            id,
            label: label.to_string(),
            progress_pct: 0,
            is_indeterminate: indeterminate,
            completed: false,
        });
        id
    }

    pub fn update_progress(&mut self, pct: u8) {
        if let Some(op) = &mut self.active_progress {
            op.progress_pct = pct.min(100);
        }
    }

    pub fn complete_progress(&mut self) {
        if let Some(op) = &mut self.active_progress {
            op.completed = true;
            op.progress_pct = 100;
        }
        self.active_progress = None;
    }

    pub fn snapshot(&self) -> StatusBarSnapshot {
        StatusBarSnapshot {
            zoom_display: self.zoom.display_string(),
            zoom_value: self.zoom.zoom,
            cursor_display: self.cursor.display_string(),
            selection_display: self.selection.display_string(),
            connection_display: self.connection.display_string(),
            connection_online: self.connection.is_online(),
            last_action: self.last_action.clone(),
            breadcrumb_display: self.breadcrumbs.display_string(),
            grid_visible: self.toggles.grid_visible,
            snap_enabled: self.toggles.snap_to_grid || self.toggles.snap_to_objects,
            performance_display: if self.show_performance {
                Some(self.performance.display_string())
            } else {
                None
            },
            notifications: self.notifications.visible().into_iter().cloned().collect(),
            progress: self.active_progress.clone(),
            plugin_count: self.plugin_status_count,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusBarSnapshot {
    pub zoom_display: String,
    pub zoom_value: f64,
    pub cursor_display: String,
    pub selection_display: String,
    pub connection_display: String,
    pub connection_online: bool,
    pub last_action: Option<String>,
    pub breadcrumb_display: String,
    pub grid_visible: bool,
    pub snap_enabled: bool,
    pub performance_display: Option<String>,
    #[serde(skip)]
    pub notifications: Vec<StatusBarNotification>,
    pub progress: Option<ProgressOperation>,
    pub plugin_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_display() {
        assert_eq!(ZoomState::new(1.0).display_string(), "100%");
        assert_eq!(ZoomState::new(0.5).display_string(), "50%");
    }

    #[test]
    fn zoom_in_out() {
        let mut z = ZoomState::new(0.5);
        z.zoom_in();
        assert_eq!(z.zoom, 0.75);
        z.zoom_out();
        assert_eq!(z.zoom, 0.5);
    }

    #[test]
    fn zoom_clamped() {
        let mut z = ZoomState::new(1.0);
        z.set_zoom(0.001);
        assert_eq!(z.zoom, 0.01);
        z.set_zoom(1000.0);
        assert_eq!(z.zoom, 256.0);
    }

    #[test]
    fn cursor_tracking() {
        let mut c = CursorState::new();
        c.update(100.0, 200.0);
        assert!(c.is_on_canvas);
        assert_eq!(c.display_string(), "X: 100  Y: 200");
    }

    #[test]
    fn selection_display() {
        let s = SelectionSummary {
            count: 1,
            bounds: Some(SelectionBounds {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            }),
            uniform_type: Some("Rect".into()),
        };
        assert_eq!(s.display_string(), "Rect — 200 × 100");
    }

    #[test]
    fn connection_display() {
        assert_eq!(
            ConnectionStatus::Online { collaborators: 3 }.display_string(),
            "Online · 3 editing"
        );
    }

    #[test]
    fn notifications() {
        let mut q = NotificationQueue::new(2);
        q.info("A");
        q.info("B");
        q.info("C");
        assert_eq!(q.count(), 2);
    }

    #[test]
    fn breadcrumbs() {
        let mut bc = BreadcrumbPath::new();
        bc.push("Page", None);
        assert_eq!(bc.display_string(), "Page");
    }

    #[test]
    fn progress() {
        let mut bar = StatusBar::new();
        bar.start_progress("Export", false);
        assert!(bar.active_progress.is_some());
        bar.update_progress(50);
        assert_eq!(bar.active_progress.as_ref().unwrap().progress_pct, 50);
        bar.complete_progress();
        assert!(bar.active_progress.is_none());
    }

    #[test]
    fn snapshot() {
        let mut bar = StatusBar::new();
        bar.zoom.set_zoom(1.5);
        bar.cursor.update(100.0, 200.0);
        bar.set_last_action("Move");
        let snap = bar.snapshot();
        assert_eq!(snap.zoom_display, "150%");
        assert_eq!(snap.last_action, Some("Move".into()));
    }
}
