//! X-Native Reusable UI Components
//!
//! This module contains ALL reusable UI components that should be used
//! across every screen in the application. No screen should create its own
//! ad-hoc components - everything comes from here.

use crate::design_system::DesignSystem;
use crate::{UiRect, UiTree, WidgetId, WidgetKind};

// ============================================================= Constants

// The control-height scale is declared once, in `metrics`, so the retained-mode
// components here and the designer's immediate-mode chrome cannot drift apart.
// A panel header is not a property row, so it keeps its own height.

/// Standard control height for all inputs and buttons
pub const CONTROL_HEIGHT: f64 = crate::metrics::CONTROL_H;

/// Standard row height for lists and trees
pub const ROW_HEIGHT: f64 = crate::metrics::DENSE_H;

/// Panel header height
pub const PANEL_HEADER_H: f64 = 32.0;

/// Inspector section header height
pub const SECTION_HEADER_H: f64 = crate::metrics::DENSE_H;

// ================================================================ Button

/// Button variants for different contexts
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ButtonVariant {
    #[default]
    Primary, // Accent background, for main actions
    Secondary, // Border only, for secondary actions
    Ghost,     // No background, for toolbar buttons
    Danger,    // Red accent, for destructive actions
}

/// Button sizes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ButtonSize {
    Small, // 24px height
    #[default]
    Medium, // 28px height (CONTROL_HEIGHT)
    Large, // 36px height
}

impl ButtonSize {
    pub fn height(&self) -> f64 {
        match self {
            ButtonSize::Small => 24.0,
            ButtonSize::Medium => CONTROL_HEIGHT,
            ButtonSize::Large => 36.0,
        }
    }
}

/// Button component builder
pub struct ButtonBuilder {
    id: WidgetId,
    text: String,
    rect: UiRect,
    variant: ButtonVariant,
    size: ButtonSize,
    disabled: bool,
    tab_index: Option<u32>,
}

impl ButtonBuilder {
    pub fn new(tree: &mut UiTree, x: f64, y: f64, width: f64, text: impl Into<String>) -> Self {
        let id = tree.add(
            WidgetKind::Button { text: text.into() },
            UiRect {
                x,
                y,
                w: width,
                h: CONTROL_HEIGHT,
            },
            None,
        );
        Self {
            id,
            text: String::new(),
            rect: UiRect {
                x,
                y,
                w: width,
                h: CONTROL_HEIGHT,
            },
            variant: ButtonVariant::default(),
            size: ButtonSize::default(),
            disabled: false,
            tab_index: Some(0),
        }
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self.rect.h = size.height();
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn tab_index(mut self, index: u32) -> Self {
        self.tab_index = Some(index);
        self
    }

    pub fn build(self, _ds: &DesignSystem) -> WidgetId {
        // In a full implementation, this would store variant/size metadata
        // For now, we return the widget ID and painting handles variants
        self.id
    }
}

// ================================================================ Input

/// Input field types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InputType {
    #[default]
    Text,
    Number,
    Password,
    Search,
}

/// Number input with increment/decrement controls
pub struct NumberInputBuilder {
    id: WidgetId,
    rect: UiRect,
    value: f64,
    min: Option<f64>,
    max: Option<f64>,
    step: f64,
    placeholder: String,
    disabled: bool,
}

impl NumberInputBuilder {
    pub fn new(tree: &mut UiTree, x: f64, y: f64, width: f64, value: f64) -> Self {
        let id = tree.add(
            WidgetKind::TextField {
                text: format!("{}", value),
                cursor: 0,
                placeholder: String::new(),
            },
            UiRect {
                x,
                y,
                w: width,
                h: CONTROL_HEIGHT,
            },
            None,
        );
        Self {
            id,
            rect: UiRect {
                x,
                y,
                w: width,
                h: CONTROL_HEIGHT,
            },
            value,
            min: None,
            max: None,
            step: 1.0,
            placeholder: String::new(),
            disabled: false,
        }
    }

    pub fn range(mut self, min: f64, max: f64) -> Self {
        self.min = Some(min);
        self.max = Some(max);
        self
    }

    pub fn step(mut self, step: f64) -> Self {
        self.step = step;
        self
    }

    pub fn placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn build(self, _ds: &DesignSystem) -> WidgetId {
        self.id
    }
}

// ================================================================ Toggle

/// Toggle/Switch component
pub struct ToggleBuilder {
    id: WidgetId,
    text: String,
    rect: UiRect,
    checked: bool,
    disabled: bool,
}

impl ToggleBuilder {
    pub fn new(tree: &mut UiTree, x: f64, y: f64, text: impl Into<String>, checked: bool) -> Self {
        let text_str = text.into();
        let id = tree.add(
            WidgetKind::Checkbox {
                text: text_str.clone(),
                checked,
            },
            UiRect {
                x,
                y,
                w: 100.0,
                h: CONTROL_HEIGHT,
            },
            None,
        );
        Self {
            id,
            text: text_str,
            rect: UiRect {
                x,
                y,
                w: 100.0,
                h: CONTROL_HEIGHT,
            },
            checked,
            disabled: false,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn build(self, _ds: &DesignSystem) -> WidgetId {
        self.id
    }
}

// ================================================================ Slider

/// Slider component for continuous values
pub struct SliderBuilder {
    id: WidgetId,
    rect: UiRect,
    value: f64,
    min: f64,
    max: f64,
    disabled: bool,
}

impl SliderBuilder {
    pub fn new(
        tree: &mut UiTree,
        x: f64,
        y: f64,
        width: f64,
        value: f64,
        min: f64,
        max: f64,
    ) -> Self {
        let id = tree.add(
            WidgetKind::Slider { value, min, max },
            UiRect {
                x,
                y,
                w: width,
                h: 20.0,
            },
            None,
        );
        Self {
            id,
            rect: UiRect {
                x,
                y,
                w: width,
                h: 20.0,
            },
            value,
            min,
            max,
            disabled: false,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn build(self, _ds: &DesignSystem) -> WidgetId {
        self.id
    }
}

// ================================================================ Dropdown

/// Dropdown/Select component
pub struct DropdownBuilder {
    id: WidgetId,
    rect: UiRect,
    options: Vec<String>,
    selected: usize,
    disabled: bool,
}

impl DropdownBuilder {
    pub fn new(tree: &mut UiTree, x: f64, y: f64, width: f64, options: Vec<String>) -> Self {
        let selected_text = options.first().cloned().unwrap_or_default();
        let id = tree.add(
            WidgetKind::Button {
                text: selected_text,
            },
            UiRect {
                x,
                y,
                w: width,
                h: CONTROL_HEIGHT,
            },
            None,
        );
        Self {
            id,
            rect: UiRect {
                x,
                y,
                w: width,
                h: CONTROL_HEIGHT,
            },
            options,
            selected: 0,
            disabled: false,
        }
    }

    pub fn selected(mut self, index: usize) -> Self {
        self.selected = index;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn build(self, _ds: &DesignSystem) -> WidgetId {
        self.id
    }
}

// ================================================================ Tabs

/// Tab component
pub struct TabBuilder {
    id: WidgetId,
    rect: UiRect,
    text: String,
    active: bool,
}

impl TabBuilder {
    pub fn new(
        tree: &mut UiTree,
        x: f64,
        y: f64,
        width: f64,
        text: impl Into<String>,
        active: bool,
    ) -> Self {
        let text_str = text.into();
        let id = tree.add(
            WidgetKind::Tab {
                text: text_str.clone(),
                active,
            },
            UiRect {
                x,
                y,
                w: width,
                h: 32.0,
            },
            None,
        );
        Self {
            id,
            rect: UiRect {
                x,
                y,
                w: width,
                h: 32.0,
            },
            text: text_str,
            active,
        }
    }

    pub fn build(self, _ds: &DesignSystem) -> WidgetId {
        self.id
    }
}

// ================================================================ Labels

/// Label component for text display
pub struct LabelBuilder {
    id: WidgetId,
    rect: UiRect,
    text: String,
}

impl LabelBuilder {
    pub fn new(tree: &mut UiTree, x: f64, y: f64, text: impl Into<String>) -> Self {
        let text_str = text.into();
        let id = tree.add(
            WidgetKind::Label {
                text: text_str.clone(),
            },
            UiRect {
                x,
                y,
                w: 100.0,
                h: 20.0,
            },
            None,
        );
        Self {
            id,
            rect: UiRect {
                x,
                y,
                w: 100.0,
                h: 20.0,
            },
            text: text_str,
        }
    }

    pub fn build(self, _ds: &DesignSystem) -> WidgetId {
        self.id
    }
}

// =============================================================== Panels

/// Panel container with header
pub struct PanelBuilder {
    pub rect: UiRect,
    pub title: String,
    pub collapsed: bool,
}

impl PanelBuilder {
    pub fn new(x: f64, y: f64, width: f64, height: f64, title: impl Into<String>) -> Self {
        Self {
            rect: UiRect {
                x,
                y,
                w: width,
                h: height,
            },
            title: title.into(),
            collapsed: false,
        }
    }

    pub fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }
}

// ============================================ Component Helper Functions

/// Create a button with default styling
pub fn button(
    tree: &mut UiTree,
    ds: &DesignSystem,
    x: f64,
    y: f64,
    width: f64,
    text: impl Into<String>,
) -> WidgetId {
    ButtonBuilder::new(tree, x, y, width, text)
        .variant(ButtonVariant::Secondary)
        .build(ds)
}

/// Create a primary action button
pub fn primary_button(
    tree: &mut UiTree,
    ds: &DesignSystem,
    x: f64,
    y: f64,
    width: f64,
    text: impl Into<String>,
) -> WidgetId {
    ButtonBuilder::new(tree, x, y, width, text)
        .variant(ButtonVariant::Primary)
        .build(ds)
}

/// Create a number input field
pub fn number_input(
    tree: &mut UiTree,
    ds: &DesignSystem,
    x: f64,
    y: f64,
    width: f64,
    value: f64,
) -> WidgetId {
    NumberInputBuilder::new(tree, x, y, width, value).build(ds)
}

/// Create a toggle/checkbox
pub fn toggle(
    tree: &mut UiTree,
    ds: &DesignSystem,
    x: f64,
    y: f64,
    text: impl Into<String>,
    checked: bool,
) -> WidgetId {
    ToggleBuilder::new(tree, x, y, text, checked).build(ds)
}

/// Create a slider
pub fn slider(
    tree: &mut UiTree,
    ds: &DesignSystem,
    x: f64,
    y: f64,
    width: f64,
    value: f64,
    min: f64,
    max: f64,
) -> WidgetId {
    SliderBuilder::new(tree, x, y, width, value, min, max).build(ds)
}

/// Create a label
pub fn label(
    tree: &mut UiTree,
    ds: &DesignSystem,
    x: f64,
    y: f64,
    text: impl Into<String>,
) -> WidgetId {
    LabelBuilder::new(tree, x, y, text).build(ds)
}
