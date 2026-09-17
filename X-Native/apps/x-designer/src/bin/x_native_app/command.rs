//! Command Palette (⌘K / Ctrl+K) for X-Native Designer.
//!
//! Design philosophy:
//!   "Command-first discovery — beginners learn via ⌘K, not tours"
//!
//! Full implementation with:
//! - Real command registration system
//! - Fuzzy search functionality  
//! - Keyboard navigation
//! - Context-aware filtering
//! - Usage tracking and recent commands
//! - Proper command execution dispatch

use std::collections::HashMap;
use vello::peniko::Color;

// ═══════════════════════════════════════════════════════════
// Constants (match theme.rs tokens)
// ═══════════════════════════════════════════════════════════

pub const PALETTE_WIDTH: f64 = 480.0;
pub const PALETTE_MAX_HEIGHT: f64 = 400.0;
pub const INPUT_HEIGHT: f64 = 40.0;
pub const ROW_HEIGHT: f64 = 30.0;
pub const PADDING: f64 = crate::theme::SP_3;
pub const SHORTCUT_TEXT_WIDTH: f64 = 80.0;

// Theme tokens — aliases onto crate::theme (the palette), never literals
const BG_OVERLAY: Color = crate::theme::C_SCRIM;
const BG_PALETTE: Color = crate::theme::C_PANEL;
const BG_INPUT: Color = crate::theme::C_FIELD;
const BG_ROW_HOVER: Color = crate::theme::C_RAISED;
const BG_ROW_SELECTED: Color = crate::theme::C_ACCENT_MUTED;
const BG_SECTION: Color = crate::theme::C_BASE;
const TEXT_MUTED: Color = crate::theme::C_FAINT;
const TEXT_SHORTCUT: Color = crate::theme::C_DIM;

// ═══════════════════════════════════════════════════════════
// Command Categories
// ═══════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandCategory {
    File,
    Edit,
    View,
    Tools,
    Object,
    Layout,
    Prototype,
    Text,
    Help,
}

impl CommandCategory {
    pub fn label(&self) -> &'static str {
        match self {
            Self::File => "File",
            Self::Edit => "Edit",
            Self::View => "View",
            Self::Tools => "Tools",
            Self::Object => "Object",
            Self::Layout => "Layout",
            Self::Prototype => "Prototype",
            Self::Text => "Text",
            Self::Help => "Help",
        }
    }

    pub fn sort_order(&self) -> u8 {
        match self {
            Self::File => 0,
            Self::Edit => 1,
            Self::View => 2,
            Self::Tools => 3,
            Self::Object => 4,
            Self::Layout => 5,
            Self::Text => 6,
            Self::Prototype => 7,
            Self::Help => 8,
        }
    }
}

// ═══════════════════════════════════════════════════════════
// Command Definition
// ═══════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct CommandDef {
    pub id: &'static str,
    pub label: String,
    pub category: CommandCategory,
    pub shortcut: Option<String>,
    pub icon: &'static str,
    pub requires_selection: bool,
    pub enabled: bool,
}

// ═══════════════════════════════════════════════════════════
// Fuzzy Matching
// ═══════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct FuzzyResult {
    pub score: f64,
    pub matched_indices: Vec<usize>,
}

pub fn fuzzy_match(query: &str, haystack: &str) -> Option<FuzzyResult> {
    if query.is_empty() {
        return Some(FuzzyResult {
            score: 0.0,
            matched_indices: vec![],
        });
    }

    let query_lower: Vec<char> = query.to_lowercase().chars().collect();
    let hay_lower: Vec<char> = haystack.to_lowercase().chars().collect();

    let mut qi = 0;
    let mut indices = Vec::new();
    let mut score = 0.0f64;
    let mut consecutive = 0.0f64;
    let mut last_match: Option<usize> = None;

    for (i, &hc) in hay_lower.iter().enumerate() {
        if qi >= query_lower.len() {
            break;
        }

        if hc == query_lower[qi] {
            indices.push(i);
            let mut char_score = 1.0f64;

            if let Some(lm) = last_match {
                if i == lm + 1 {
                    consecutive += 2.0;
                    char_score += consecutive;
                } else {
                    consecutive = 0.0;
                }
            }

            if i == 0 || !hay_lower[i.saturating_sub(1)].is_alphanumeric() {
                char_score += 3.0;
            }

            if i > 0 && hay_lower[i].is_alphanumeric() && !hay_lower[i - 1].is_alphanumeric() {
                char_score += 2.0;
            }

            if i == qi {
                char_score += 4.0;
            }

            score += char_score;
            last_match = Some(i);
            qi += 1;
        }
    }

    if qi < query_lower.len() {
        return None;
    }

    score -= (haystack.len() as f64 - query.len() as f64) * 0.01;

    if indices.len() > 1 {
        let span = indices.last().unwrap() - indices.first().unwrap();
        let coverage = indices.len() as f64 / (span + 1) as f64;
        score += coverage * 2.0;
    }

    Some(FuzzyResult {
        score,
        matched_indices: indices,
    })
}

// ═══════════════════════════════════════════════════════════
// Palette State
// ═══════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct PaletteMatch {
    pub command_id: String,
    pub label: String,
    pub category: CommandCategory,
    pub shortcut: Option<String>,
    pub icon: String,
    pub score: f64,
    pub matched_indices: Vec<usize>,
    pub enabled: bool,
}

pub struct CommandPalette {
    pub open: bool,
    pub query: String,
    pub commands: Vec<CommandDef>,
    pub results: Vec<PaletteMatch>,
    pub selected_index: usize,
    pub recent: Vec<String>,
    pub max_recent: usize,
    pub usage_counts: HashMap<String, u64>,
    pub has_selection: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scroll_offset: f64,
    // Legacy aliases for backward compatibility
    pub palette_open: bool,
    pub palette_query: String,
    pub palette_index: usize,
}

impl CommandPalette {
    pub fn new(screen_w: f64, screen_h: f64) -> Self {
        let width = PALETTE_WIDTH;
        let height = PALETTE_MAX_HEIGHT;
        let x = (screen_w - width) / 2.0;
        let y = screen_h * 0.15;

        let mut palette = Self {
            open: false,
            query: String::new(),
            commands: Vec::new(),
            results: Vec::new(),
            selected_index: 0,
            recent: Vec::new(),
            max_recent: 5,
            usage_counts: HashMap::new(),
            has_selection: false,
            x,
            y,
            width,
            height,
            scroll_offset: 0.0,
            // Legacy aliases
            palette_open: false,
            palette_query: String::new(),
            palette_index: 0,
        };

        palette.register_standard_commands();
        palette
    }

    pub fn register_standard_commands(&mut self) {
        let commands = vec![
            // File
            CommandDef {
                id: "file.new",
                label: "New Design File".into(),
                category: CommandCategory::File,
                shortcut: Some("⌘N".into()),
                icon: "file-plus",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "file.new_board",
                label: "New Board (Brainstorm)".into(),
                category: CommandCategory::File,
                shortcut: Some("⌘⇧B".into()),
                icon: "layout-grid",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "file.open",
                label: "Open File".into(),
                category: CommandCategory::File,
                shortcut: Some("⌘O".into()),
                icon: "folder-open",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "file.save",
                label: "Save".into(),
                category: CommandCategory::File,
                shortcut: Some("⌘S".into()),
                icon: "save",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "file.save_as",
                label: "Save As...".into(),
                category: CommandCategory::File,
                shortcut: Some("⇧⌘S".into()),
                icon: "save",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "file.export_png",
                label: "Export PNG".into(),
                category: CommandCategory::File,
                shortcut: Some("⇧⌘E".into()),
                icon: "download",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "file.export_svg",
                label: "Export SVG".into(),
                category: CommandCategory::File,
                shortcut: None,
                icon: "download",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "file.export_sketch",
                label: "Export Sketch".into(),
                category: CommandCategory::File,
                shortcut: None,
                icon: "download",
                requires_selection: false,
                enabled: true,
            },
            // Edit
            CommandDef {
                id: "edit.undo",
                label: "Undo".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⌘Z".into()),
                icon: "undo",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "edit.redo",
                label: "Redo".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⇧⌘Z".into()),
                icon: "redo",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "edit.cut",
                label: "Cut".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⌘X".into()),
                icon: "scissors",
                requires_selection: true,
                enabled: true,
            },
            CommandDef {
                id: "edit.copy",
                label: "Copy".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⌘C".into()),
                icon: "copy",
                requires_selection: true,
                enabled: true,
            },
            CommandDef {
                id: "edit.paste",
                label: "Paste".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⌘V".into()),
                icon: "clipboard",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "edit.duplicate",
                label: "Duplicate".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⌘D".into()),
                icon: "copy",
                requires_selection: true,
                enabled: true,
            },
            CommandDef {
                id: "edit.delete",
                label: "Delete".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⌫".into()),
                icon: "trash",
                requires_selection: true,
                enabled: true,
            },
            CommandDef {
                id: "edit.select_all",
                label: "Select All".into(),
                category: CommandCategory::Edit,
                shortcut: Some("⌘A".into()),
                icon: "maximize",
                requires_selection: false,
                enabled: true,
            },
            // View
            CommandDef {
                id: "view.zoom_in",
                label: "Zoom In".into(),
                category: CommandCategory::View,
                shortcut: Some("⌘=".into()),
                icon: "zoom-in",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "view.zoom_out",
                label: "Zoom Out".into(),
                category: CommandCategory::View,
                shortcut: Some("⌘-".into()),
                icon: "zoom-out",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "view.zoom_fit",
                label: "Zoom to Fit".into(),
                category: CommandCategory::View,
                shortcut: Some("⇧1".into()),
                icon: "maximize",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "view.zoom_100",
                label: "Zoom to 100%".into(),
                category: CommandCategory::View,
                shortcut: Some("⌘0".into()),
                icon: "target",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "view.toggle_grid",
                label: "Toggle Grid".into(),
                category: CommandCategory::View,
                shortcut: Some("⌘'".into()),
                icon: "layout-grid",
                requires_selection: false,
                enabled: true,
            },
            // Tools
            CommandDef {
                id: "tools.select",
                label: "Select Tool".into(),
                category: CommandCategory::Tools,
                shortcut: Some("V".into()),
                icon: "mouse-pointer",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "tools.frame",
                label: "Frame Tool".into(),
                category: CommandCategory::Tools,
                shortcut: Some("F".into()),
                icon: "frame",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "tools.rectangle",
                label: "Rectangle Tool".into(),
                category: CommandCategory::Tools,
                shortcut: Some("R".into()),
                icon: "square",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "tools.ellipse",
                label: "Ellipse Tool".into(),
                category: CommandCategory::Tools,
                shortcut: Some("O".into()),
                icon: "circle",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "tools.pen",
                label: "Pen Tool".into(),
                category: CommandCategory::Tools,
                shortcut: Some("P".into()),
                icon: "pen-tool",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "tools.text",
                label: "Text Tool".into(),
                category: CommandCategory::Tools,
                shortcut: Some("T".into()),
                icon: "type",
                requires_selection: false,
                enabled: true,
            },
            CommandDef {
                id: "tools.eraser",
                label: "Vector Eraser".into(),
                category: CommandCategory::Tools,
                shortcut: Some("⇧E".into()),
                icon: "eraser",
                requires_selection: false,
                enabled: true,
            },
            // Object
            CommandDef {
                id: "object.group",
                label: "Group".into(),
                category: CommandCategory::Object,
                shortcut: Some("⌘G".into()),
                icon: "group",
                requires_selection: true,
                enabled: true,
            },
            CommandDef {
                id: "object.ungroup",
                label: "Ungroup".into(),
                category: CommandCategory::Object,
                shortcut: Some("⇧⌘G".into()),
                icon: "ungroup",
                requires_selection: true,
                enabled: true,
            },
            CommandDef {
                id: "object.bring_front",
                label: "Bring to Front".into(),
                category: CommandCategory::Object,
                shortcut: Some("⌘]".into()),
                icon: "arrow-up",
                requires_selection: true,
                enabled: true,
            },
            CommandDef {
                id: "object.send_back",
                label: "Send to Back".into(),
                category: CommandCategory::Object,
                shortcut: Some("⌘[".into()),
                icon: "arrow-down",
                requires_selection: true,
                enabled: true,
            },
            // Layout
            CommandDef {
                id: "layout.add_auto",
                label: "Add Auto Layout".into(),
                category: CommandCategory::Layout,
                shortcut: Some("⇧A".into()),
                icon: "layout-list",
                requires_selection: true,
                enabled: true,
            },
            // Prototype
            CommandDef {
                id: "proto.preview",
                label: "Preview Prototype".into(),
                category: CommandCategory::Prototype,
                shortcut: Some("⌘⏎".into()),
                icon: "play",
                requires_selection: false,
                enabled: true,
            },
            // Help
            CommandDef {
                id: "help.shortcuts",
                label: "Keyboard Shortcuts".into(),
                category: CommandCategory::Help,
                shortcut: Some("?".into()),
                icon: "keyboard",
                requires_selection: false,
                enabled: true,
            },
        ];

        self.commands = commands;
    }

    pub fn toggle(&mut self) {
        if self.open {
            self.close();
        } else {
            self.open();
        }
    }

    pub fn open(&mut self) {
        self.open = true;
        self.query.clear();
        self.selected_index = 0;
        self.scroll_offset = 0.0;
        self.update_results();
    }

    pub fn close(&mut self) {
        self.open = false;
    }

    pub fn set_query(&mut self, query: &str) {
        self.query = query.to_string();
        self.selected_index = 0;
        self.scroll_offset = 0.0;
        self.update_results();
    }

    fn update_results(&mut self) {
        self.results.clear();

        for cmd in &self.commands {
            if cmd.requires_selection && !self.has_selection {
                continue;
            }
            if !cmd.enabled {
                continue;
            }

            let (score, matched_indices) = if self.query.is_empty() {
                let freq = self.usage_counts.get(cmd.id).copied().unwrap_or(0) as f64;
                let recency = self
                    .recent
                    .iter()
                    .position(|r| r == cmd.id)
                    .map(|p| (self.max_recent - p) as f64 * 0.5)
                    .unwrap_or(0.0);
                (freq * 0.1 + recency, vec![])
            } else {
                match fuzzy_match(&self.query, &cmd.label) {
                    Some(m) => {
                        let freq = self.usage_counts.get(cmd.id).copied().unwrap_or(0) as f64 * 0.5;
                        (m.score + freq, m.matched_indices)
                    }
                    None => continue,
                }
            };

            self.results.push(PaletteMatch {
                command_id: cmd.id.to_string(),
                label: cmd.label.clone(),
                category: cmd.category,
                shortcut: cmd.shortcut.clone(),
                icon: cmd.icon.to_string(),
                score,
                matched_indices,
                enabled: cmd.enabled,
            });
        }

        self.results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    pub fn select_next(&mut self) {
        if !self.results.is_empty() {
            self.selected_index = (self.selected_index + 1) % self.results.len();
            self.ensure_selected_visible();
        }
    }

    pub fn select_previous(&mut self) {
        if !self.results.is_empty() {
            self.selected_index = if self.selected_index == 0 {
                self.results.len() - 1
            } else {
                self.selected_index - 1
            };
            self.ensure_selected_visible();
        }
    }

    fn ensure_selected_visible(&mut self) {
        let row_top = self.selected_index as f64 * ROW_HEIGHT;
        let row_bottom = row_top + ROW_HEIGHT;
        let visible_height = self.height - INPUT_HEIGHT - PADDING * 2.0;

        if row_top < self.scroll_offset {
            self.scroll_offset = row_top;
        } else if row_bottom > self.scroll_offset + visible_height {
            self.scroll_offset = row_bottom - visible_height;
        }
    }

    pub fn execute_selected(&mut self) -> Option<String> {
        let result = self.results.get(self.selected_index)?;
        let cmd_id = result.command_id.clone();

        *self.usage_counts.entry(cmd_id.clone()).or_insert(0) += 1;

        self.recent.retain(|r| r != &cmd_id);
        self.recent.insert(0, cmd_id.clone());
        self.recent.truncate(self.max_recent);

        self.close();
        Some(cmd_id)
    }

    pub fn handle_key(&mut self, key: &str, is_char: bool) -> Option<String> {
        if is_char {
            self.query.push_str(key);
            self.set_query(&self.query.clone());
            None
        } else {
            match key {
                "Backspace" => {
                    self.query.pop();
                    self.set_query(&self.query.clone());
                    None
                }
                "ArrowDown" => {
                    self.select_next();
                    None
                }
                "ArrowUp" => {
                    self.select_previous();
                    None
                }
                "Enter" => self.execute_selected(),
                "Escape" => {
                    self.close();
                    None
                }
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_match_exact() {
        let r = fuzzy_match("save", "Save");
        assert!(r.is_some());
        assert!(r.unwrap().score > 0.0);
    }

    #[test]
    fn fuzzy_match_partial() {
        let r = fuzzy_match("sv", "Save As");
        assert!(r.is_some());
    }

    #[test]
    fn fuzzy_match_no_match() {
        let r = fuzzy_match("xyz", "Save");
        assert!(r.is_none());
    }

    #[test]
    fn palette_initialization() {
        let p = CommandPalette::new(1920.0, 1080.0);
        assert!(!p.open);
        assert!(p.commands.len() > 30);
    }

    #[test]
    fn search_filters_results() {
        let mut p = CommandPalette::new(1920.0, 1080.0);
        p.open();
        p.set_query("zoom");
        assert!(p
            .results
            .iter()
            .all(|r| r.label.to_lowercase().contains("zoom")));
    }

    #[test]
    fn keyboard_navigation() {
        let mut p = CommandPalette::new(1920.0, 1080.0);
        p.open();
        p.set_query("zoom");
        let initial = p.selected_index;
        p.select_next();
        assert_eq!(p.selected_index, initial + 1);
    }
}
