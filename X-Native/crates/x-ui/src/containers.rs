//! Retained container/overlay widgets: ScrollView, Dropdown, Menu,
//! Tooltip, Modal. These are the concepts that hurt most as pixel code;
//! here they are state machines with events, painted via PaintOps.

use crate::{PaintOp, Theme, UiRect, WidgetId};

// ------------------------------------------------------------- scroll view

/// Scrollable region: owns offset + content extent, clamps, exposes
/// viewport mapping for children painted relative to content space.
#[derive(Debug, Clone, PartialEq)]
pub struct ScrollView {
    pub id: WidgetId,
    pub rect: UiRect,
    pub content_h: f64,
    pub offset: f64,
}

impl ScrollView {
    pub fn new(id: WidgetId, rect: UiRect, content_h: f64) -> Self {
        Self {
            id,
            rect,
            content_h,
            offset: 0.0,
        }
    }
    pub fn max_offset(&self) -> f64 {
        (self.content_h - self.rect.h).max(0.0)
    }
    pub fn scroll_by(&mut self, dy: f64) {
        self.offset = (self.offset + dy).clamp(0.0, self.max_offset());
    }
    /// content-y -> screen-y (None when scrolled outside the viewport)
    pub fn project(&self, content_y: f64) -> Option<f64> {
        let y = self.rect.y + content_y - self.offset;
        (y >= self.rect.y - 0.5 && y <= self.rect.y + self.rect.h + 0.5).then_some(y)
    }
    /// Scroll the minimum amount to make a row visible (keyboard nav!)
    pub fn ensure_visible(&mut self, content_y: f64, row_h: f64) {
        if content_y < self.offset {
            self.offset = content_y;
        } else if content_y + row_h > self.offset + self.rect.h {
            self.offset = content_y + row_h - self.rect.h;
        }
    }
    pub fn paint_scrollbar(&self, theme: &Theme) -> Vec<PaintOp> {
        if self.content_h <= self.rect.h {
            return vec![];
        }
        let track_h = self.rect.h;
        let knob_h = (self.rect.h / self.content_h * track_h).max(20.0);
        let t = self.offset / self.max_offset();
        let knob_y = self.rect.y + t * (track_h - knob_h);
        vec![PaintOp::Rect {
            r: UiRect {
                x: self.rect.x + self.rect.w - 4.0,
                y: knob_y,
                w: 3.0,
                h: knob_h,
            },
            color: theme.dim(),
            alpha: 140,
            radius: 1.5,
        }]
    }
}

// --------------------------------------------------------------- dropdown

#[derive(Debug, Clone, PartialEq)]
pub struct Dropdown {
    pub id: WidgetId,
    pub rect: UiRect,
    pub options: Vec<String>,
    pub selected: usize,
    pub open: bool,
    pub highlighted: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DropdownEvent {
    Opened,
    Closed,
    Selected(usize),
}

impl Dropdown {
    pub fn new(id: WidgetId, rect: UiRect, options: Vec<String>, selected: usize) -> Self {
        Self {
            id,
            rect,
            highlighted: selected,
            options,
            selected,
            open: false,
        }
    }
    fn option_rect(&self, i: usize) -> UiRect {
        UiRect {
            x: self.rect.x,
            y: self.rect.y + self.rect.h + i as f64 * self.rect.h,
            w: self.rect.w,
            h: self.rect.h,
        }
    }
    pub fn click(&mut self, x: f64, y: f64) -> Option<DropdownEvent> {
        if !self.open {
            if self.rect.contains(x, y) {
                self.open = true;
                return Some(DropdownEvent::Opened);
            }
            return None;
        }
        for i in 0..self.options.len() {
            if self.option_rect(i).contains(x, y) {
                self.selected = i;
                self.open = false;
                return Some(DropdownEvent::Selected(i));
            }
        }
        self.open = false;
        Some(DropdownEvent::Closed)
    }
    /// keyboard: arrows move highlight, Enter commits, Esc closes
    pub fn key_down(&mut self) {
        if self.open {
            self.highlighted = (self.highlighted + 1).min(self.options.len() - 1);
        }
    }
    pub fn key_up(&mut self) {
        if self.open {
            self.highlighted = self.highlighted.saturating_sub(1);
        }
    }
    pub fn key_enter(&mut self) -> Option<DropdownEvent> {
        if !self.open {
            self.open = true;
            return Some(DropdownEvent::Opened);
        }
        self.selected = self.highlighted;
        self.open = false;
        Some(DropdownEvent::Selected(self.selected))
    }
    pub fn key_escape(&mut self) -> Option<DropdownEvent> {
        if self.open {
            self.open = false;
            return Some(DropdownEvent::Closed);
        }
        None
    }
    pub fn paint(&self, theme: &Theme) -> Vec<PaintOp> {
        let mut ops = vec![
            PaintOp::Rect {
                r: self.rect,
                color: [0x1a, 0x1c, 0x20],
                alpha: 255,
                radius: 4.0,
            },
            PaintOp::Border {
                r: self.rect,
                color: theme.dim(),
                width: 1.0,
            },
            PaintOp::Text {
                x: self.rect.x + 6.0,
                y: self.rect.y + self.rect.h / 2.0 - 5.0,
                size: 9.0,
                color: theme.text(),
                text: self.options.get(self.selected).cloned().unwrap_or_default(),
            },
        ];
        if self.open {
            for (i, opt) in self.options.iter().enumerate() {
                let r = self.option_rect(i);
                let hl = i == self.highlighted;
                ops.push(PaintOp::Rect {
                    r,
                    color: if hl {
                        theme.accent()
                    } else {
                        theme.palette().surface_elevated
                    },
                    alpha: 250,
                    radius: 0.0,
                });
                ops.push(PaintOp::Text {
                    x: r.x + 6.0,
                    y: r.y + r.h / 2.0 - 5.0,
                    size: 9.0,
                    color: if hl { theme.on_accent() } else { theme.text() },
                    text: opt.clone(),
                });
            }
        }
        ops
    }
}

// ------------------------------------------------------------ context menu

#[derive(Debug, Clone, PartialEq)]
pub struct MenuItem {
    pub label: String,
    pub shortcut: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Menu {
    pub items: Vec<MenuItem>,
    pub at: (f64, f64),
    pub open: bool,
    pub highlighted: Option<usize>,
}

pub const MENU_ROW_H: f64 = 22.0;
pub const MENU_W: f64 = 180.0;

impl Menu {
    pub fn open_at(&mut self, x: f64, y: f64) {
        self.at = (x, y);
        self.open = true;
        self.highlighted = None;
    }
    pub fn close(&mut self) {
        self.open = false;
    }
    pub fn rect(&self) -> UiRect {
        UiRect {
            x: self.at.0,
            y: self.at.1,
            w: MENU_W,
            h: self.items.len() as f64 * MENU_ROW_H + 8.0,
        }
    }
    pub fn hover(&mut self, x: f64, y: f64) {
        self.highlighted = self.item_at(x, y).filter(|&i| self.items[i].enabled);
    }
    pub fn item_at(&self, x: f64, y: f64) -> Option<usize> {
        if !self.open || !self.rect().contains(x, y) {
            return None;
        }
        let i = ((y - self.at.1 - 4.0) / MENU_ROW_H).floor();
        (i >= 0.0 && (i as usize) < self.items.len()).then_some(i as usize)
    }
    /// returns the picked item index; closes on any click
    pub fn click(&mut self, x: f64, y: f64) -> Option<usize> {
        let hit = self.item_at(x, y).filter(|&i| self.items[i].enabled);
        self.open = false;
        hit
    }
    pub fn paint(&self, theme: &Theme) -> Vec<PaintOp> {
        if !self.open {
            return vec![];
        }
        let r = self.rect();
        let mut ops = vec![
            PaintOp::Rect {
                r: UiRect {
                    x: r.x + 2.0,
                    y: r.y + 3.0,
                    w: r.w,
                    h: r.h,
                },
                color: [0, 0, 0],
                alpha: 90,
                radius: 6.0,
            },
            PaintOp::Rect {
                r,
                color: [0x2a, 0x2c, 0x33],
                alpha: 250,
                radius: 6.0,
            },
        ];
        for (i, item) in self.items.iter().enumerate() {
            let y = r.y + 4.0 + i as f64 * MENU_ROW_H;
            if self.highlighted == Some(i) {
                ops.push(PaintOp::Rect {
                    r: UiRect {
                        x: r.x + 3.0,
                        y,
                        w: r.w - 6.0,
                        h: MENU_ROW_H - 2.0,
                    },
                    color: theme.accent(),
                    alpha: 255,
                    radius: 4.0,
                });
            }
            let color = if !item.enabled {
                theme.dim()
            } else if self.highlighted == Some(i) {
                [255, 255, 255]
            } else {
                theme.text()
            };
            ops.push(PaintOp::Text {
                x: r.x + 10.0,
                y: y + 5.0,
                size: 9.0,
                color,
                text: item.label.clone(),
            });
            if let Some(sc) = &item.shortcut {
                ops.push(PaintOp::Text {
                    x: r.x + r.w - 52.0,
                    y: y + 5.0,
                    size: 8.0,
                    color: theme.dim(),
                    text: sc.clone(),
                });
            }
        }
        ops
    }
}

// ---------------------------------------------------------------- tooltip

/// Delayed tooltip state machine: arm on hover, fires after `delay_ms`,
/// cancels on move/leave. (standard behavior, reduced-motion aware.)
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TooltipState {
    pub text: String,
    pub at: (f64, f64),
    armed_ms: Option<u64>,
    pub visible: bool,
}

impl TooltipState {
    pub fn hover(&mut self, text: &str, x: f64, y: f64, now_ms: u64) {
        if self.text != text {
            self.text = text.into();
            self.at = (x, y);
            self.armed_ms = Some(now_ms);
            self.visible = false;
        }
    }
    pub fn leave(&mut self) {
        self.text.clear();
        self.armed_ms = None;
        self.visible = false;
    }
    pub fn tick(&mut self, now_ms: u64, delay_ms: u64, reduced_motion: bool) {
        if let Some(t0) = self.armed_ms {
            let d = if reduced_motion { 0 } else { delay_ms };
            if now_ms.saturating_sub(t0) >= d && !self.text.is_empty() {
                self.visible = true;
            }
        }
    }
    pub fn paint(&self, theme: &Theme) -> Vec<PaintOp> {
        if !self.visible {
            return vec![];
        }
        let w = self.text.len() as f64 * 6.0 + 16.0;
        let r = UiRect {
            x: self.at.0,
            y: self.at.1 - 26.0,
            w,
            h: 20.0,
        };
        vec![
            PaintOp::Rect {
                r,
                color: [0x0e, 0x0f, 0x12],
                alpha: 240,
                radius: 5.0,
            },
            PaintOp::Text {
                x: r.x + 8.0,
                y: r.y + 5.0,
                size: 8.5,
                color: theme.text(),
                text: self.text.clone(),
            },
        ]
    }
}

// ------------------------------------------------------------------ modal

/// Modal dialog: swallows all input outside itself; Esc/Enter routing;
/// focus is trapped by construction (callers route keys here first).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Modal {
    pub open: bool,
    pub title: String,
    pub body: Vec<String>,
    pub confirm_label: String,
    pub cancel_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ModalEvent {
    Confirmed,
    Cancelled,
    Swallowed,
}

impl Modal {
    pub fn open(&mut self, title: &str, body: &[&str], confirm: &str, cancel: &str) {
        self.open = true;
        self.title = title.into();
        self.body = body.iter().map(|s| s.to_string()).collect();
        self.confirm_label = confirm.into();
        self.cancel_label = cancel.into();
    }
    pub fn rect(&self, screen_w: f64, screen_h: f64) -> UiRect {
        let w = 360.0;
        let h = 90.0 + self.body.len() as f64 * 16.0;
        UiRect {
            x: (screen_w - w) / 2.0,
            y: (screen_h - h) / 2.0,
            w,
            h,
        }
    }
    fn buttons(&self, screen_w: f64, screen_h: f64) -> (UiRect, UiRect) {
        let r = self.rect(screen_w, screen_h);
        let confirm = UiRect {
            x: r.x + r.w - 90.0,
            y: r.y + r.h - 34.0,
            w: 78.0,
            h: 24.0,
        };
        let cancel = UiRect {
            x: r.x + r.w - 180.0,
            y: r.y + r.h - 34.0,
            w: 78.0,
            h: 24.0,
        };
        (confirm, cancel)
    }
    /// modal click routing: EVERY click is consumed while open.
    pub fn click(&mut self, x: f64, y: f64, screen_w: f64, screen_h: f64) -> ModalEvent {
        let (confirm, cancel) = self.buttons(screen_w, screen_h);
        if confirm.contains(x, y) {
            self.open = false;
            return ModalEvent::Confirmed;
        }
        if cancel.contains(x, y) {
            self.open = false;
            return ModalEvent::Cancelled;
        }
        ModalEvent::Swallowed
    }
    pub fn key_enter(&mut self) -> ModalEvent {
        self.open = false;
        ModalEvent::Confirmed
    }
    pub fn key_escape(&mut self) -> ModalEvent {
        self.open = false;
        ModalEvent::Cancelled
    }
    pub fn paint(&self, theme: &Theme, screen_w: f64, screen_h: f64) -> Vec<PaintOp> {
        if !self.open {
            return vec![];
        }
        let r = self.rect(screen_w, screen_h);
        let (confirm, cancel) = self.buttons(screen_w, screen_h);
        let mut ops = vec![
            PaintOp::Rect {
                r: UiRect {
                    x: 0.0,
                    y: 0.0,
                    w: screen_w,
                    h: screen_h,
                },
                color: [0, 0, 0],
                alpha: 120,
                radius: 0.0,
            },
            PaintOp::Rect {
                r,
                color: [0x24, 0x26, 0x2b],
                alpha: 252,
                radius: 10.0,
            },
            PaintOp::Text {
                x: r.x + 14.0,
                y: r.y + 12.0,
                size: 11.0,
                color: theme.text(),
                text: self.title.clone(),
            },
        ];
        for (i, line) in self.body.iter().enumerate() {
            ops.push(PaintOp::Text {
                x: r.x + 14.0,
                y: r.y + 36.0 + i as f64 * 16.0,
                size: 8.5,
                color: theme.dim(),
                text: line.clone(),
            });
        }
        ops.push(PaintOp::Rect {
            r: confirm,
            color: theme.accent(),
            alpha: 255,
            radius: 5.0,
        });
        ops.push(PaintOp::Text {
            x: confirm.x + 10.0,
            y: confirm.y + 7.0,
            size: 9.0,
            color: [255, 255, 255],
            text: self.confirm_label.clone(),
        });
        ops.push(PaintOp::Border {
            r: cancel,
            color: theme.dim(),
            width: 1.0,
        });
        ops.push(PaintOp::Text {
            x: cancel.x + 10.0,
            y: cancel.y + 7.0,
            size: 9.0,
            color: theme.text(),
            text: self.cancel_label.clone(),
        });
        ops
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollview_clamps_projects_and_ensures_visible() {
        let mut sv = ScrollView::new(
            1,
            UiRect {
                x: 0.0,
                y: 100.0,
                w: 200.0,
                h: 300.0,
            },
            1000.0,
        );
        sv.scroll_by(-50.0);
        assert_eq!(sv.offset, 0.0, "clamped at top");
        sv.scroll_by(10_000.0);
        assert_eq!(sv.offset, 700.0, "clamped at max (1000-300)");
        sv.offset = 100.0;
        assert_eq!(sv.project(150.0), Some(150.0)); // 100+150-100
        assert_eq!(sv.project(50.0), None, "above viewport");
        // keyboard nav: ensure a row at 900 is visible
        sv.ensure_visible(900.0, 22.0);
        assert!(sv.offset >= 622.0 - 1e-9 && sv.offset <= 700.0);
        // scrollbar knob appears when overflowing
        assert!(!sv.paint_scrollbar(&Theme::default()).is_empty());
        let short = ScrollView::new(
            2,
            UiRect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 300.0,
            },
            100.0,
        );
        assert!(short.paint_scrollbar(&Theme::default()).is_empty());
    }

    #[test]
    fn dropdown_full_mouse_and_keyboard_cycle() {
        let mut dd = Dropdown::new(
            1,
            UiRect {
                x: 10.0,
                y: 10.0,
                w: 100.0,
                h: 20.0,
            },
            vec!["Left".into(), "Center".into(), "Right".into()],
            0,
        );
        assert_eq!(dd.click(50.0, 20.0), Some(DropdownEvent::Opened));
        // options list is below; click option 2 ("Right") at y = 10+20+2*20+10
        assert_eq!(
            dd.click(50.0, 10.0 + 20.0 + 2.0 * 20.0 + 5.0),
            Some(DropdownEvent::Selected(2))
        );
        assert_eq!(dd.selected, 2);
        assert!(!dd.open);
        // keyboard: open, navigate, commit
        dd.highlighted = dd.selected;
        assert_eq!(dd.key_enter(), Some(DropdownEvent::Opened));
        dd.key_up();
        assert_eq!(dd.highlighted, 1);
        assert_eq!(dd.key_enter(), Some(DropdownEvent::Selected(1)));
        // escape closes without selecting
        dd.key_enter();
        assert_eq!(dd.key_escape(), Some(DropdownEvent::Closed));
        assert_eq!(dd.selected, 1);
        // click outside closes
        dd.click(50.0, 20.0);
        assert_eq!(dd.click(500.0, 500.0), Some(DropdownEvent::Closed));
    }

    #[test]
    fn menu_hover_click_and_disabled_items() {
        let mut m = Menu {
            items: vec![
                MenuItem {
                    label: "Copy".into(),
                    shortcut: Some("Ctrl+C".into()),
                    enabled: true,
                },
                MenuItem {
                    label: "Paste".into(),
                    shortcut: Some("Ctrl+V".into()),
                    enabled: false,
                },
                MenuItem {
                    label: "Delete".into(),
                    shortcut: None,
                    enabled: true,
                },
            ],
            ..Default::default()
        };
        m.open_at(100.0, 100.0);
        m.hover(110.0, 100.0 + 4.0 + MENU_ROW_H * 1.5);
        assert_eq!(m.highlighted, None, "disabled item can't highlight");
        m.hover(110.0, 100.0 + 4.0 + MENU_ROW_H * 2.5);
        assert_eq!(m.highlighted, Some(2));
        assert_eq!(
            m.click(110.0, 100.0 + 4.0 + MENU_ROW_H * 1.5),
            None,
            "disabled item can't be picked"
        );
        m.open_at(100.0, 100.0);
        assert_eq!(m.click(110.0, 100.0 + 4.0 + MENU_ROW_H * 2.5), Some(2));
        assert!(!m.open, "menu closes after pick");
        // paint has shadow + panel + rows
        m.open_at(0.0, 0.0);
        assert!(m.paint(&Theme::default()).len() >= 5);
    }

    #[test]
    fn tooltip_delay_and_reduced_motion() {
        let mut tt = TooltipState::default();
        tt.hover("RECTANGLE R", 50.0, 50.0, 1000);
        tt.tick(1200, 400, false);
        assert!(!tt.visible, "not before delay");
        tt.tick(1500, 400, false);
        assert!(tt.visible, "after delay");
        tt.leave();
        assert!(!tt.visible);
        // reduced motion: instant
        tt.hover("HAND H", 10.0, 10.0, 2000);
        tt.tick(2000, 400, true);
        assert!(tt.visible, "reduced motion shows immediately");
    }

    #[test]
    fn modal_traps_input_and_routes_keys() {
        let mut md = Modal::default();
        md.open(
            "Unsaved changes",
            &["Save before closing?"],
            "SAVE",
            "DISCARD",
        );
        // click outside = swallowed, modal stays
        assert_eq!(md.click(5.0, 5.0, 1280.0, 800.0), ModalEvent::Swallowed);
        assert!(md.open);
        // confirm button
        let r = md.rect(1280.0, 800.0);
        let ev = md.click(r.x + r.w - 50.0, r.y + r.h - 22.0, 1280.0, 800.0);
        assert_eq!(ev, ModalEvent::Confirmed);
        assert!(!md.open);
        // keyboard routing
        md.open("t", &[], "OK", "NO");
        assert_eq!(md.key_escape(), ModalEvent::Cancelled);
        md.open("t", &[], "OK", "NO");
        assert_eq!(md.key_enter(), ModalEvent::Confirmed);
        // paint covers screen with scrim
        md.open("t", &["a"], "OK", "NO");
        let ops = md.paint(&Theme::default(), 1280.0, 800.0);
        assert!(matches!(ops[0], PaintOp::Rect { r, alpha, .. } if r.w == 1280.0 && alpha < 255));
    }
}
