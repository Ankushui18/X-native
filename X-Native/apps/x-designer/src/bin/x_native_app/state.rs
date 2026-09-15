//! Application state — documents (engine `Document` + per-page `Editor`),
//! dashboard data, panel/tab/interaction state. UI-only; the engine does
//! the actual design work. No old-shell inheritance.

use std::collections::HashSet;
use std::path::PathBuf;

use vello::kurbo::{Point, Rect};
use x_native::editor::Editor;
use x_native::{Color, Document, Node, NodeKind, Paint, PathCmd, Variables};

use crate::command::CommandPalette;
use crate::context_menu::ContextMenu;
use crate::paint::TextUi;
use crate::theme::*;
use vello::peniko::Color as VelloColor;

// ----------------------------------------------------------------- tooling

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    Select,
    Frame,
    Text,
    Rect,
    Ellipse,
    Pen,
    Hand,
    /// C18: comment pin mode (C / palette; not on the audited toolbar)
    Comment,
    /// Vector Eraser - erase parts of paths and shapes
    Eraser,
    /// Symmetry Mirror - mirror drawing across axis
    Symmetry,
    /// Board-specific tools
    BoardSticky,
    BoardConnector,
    BoardRect,
    BoardCircle,
}

impl Tool {
    pub fn icon(self) -> &'static str {
        match self {
            Tool::Select => "mouse-pointer-2",
            Tool::Frame => "frame#",
            Tool::Text => "type",
            Tool::Rect => "square",
            Tool::Ellipse => "circle",
            Tool::Pen => "pen-tool",
            Tool::Hand => "hand",
            Tool::Comment => "message-circle",
            Tool::Eraser => "eraser",
            Tool::Symmetry => "reflect-vertical",
            Tool::BoardSticky => "sticky-note",
            Tool::BoardConnector => "arrow-right",
            Tool::BoardRect => "square",
            Tool::BoardCircle => "circle",
        }
    }

    pub fn shortcut(self) -> Option<&'static str> {
        match self {
            Tool::Select => Some("V"),
            Tool::Frame => Some("F"),
            Tool::Text => Some("T"),
            Tool::Rect => Some("R"),
            Tool::Ellipse => Some("O"),
            Tool::Pen => Some("P"),
            Tool::Hand => Some("H"),
            Tool::Comment => Some("C"),
            Tool::Eraser => Some("Shift+E"),
            Tool::Symmetry => Some("M"),
            Tool::BoardSticky => Some("S"),
            Tool::BoardConnector => Some("C"),
            Tool::BoardRect => Some("R"),
            Tool::BoardCircle => Some("O"),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Screen {
    Dashboard,
    Editor,
    Board,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LeftTab {
    Layers,
    Assets,
    Tokens,
}

/// Navigation bar tab (vertical left-most bar, Figma-style).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NavTab {
    File,
    Agents,
    Assets,
    Tools,
    Variables,
}

impl NavTab {
    pub fn icon(self) -> &'static str {
        match self {
            NavTab::File => "file",
            NavTab::Agents => "sparkles",
            NavTab::Assets => "component",
            NavTab::Tools => "sliders-horizontal",
            NavTab::Variables => "code",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            NavTab::File => "Files",
            NavTab::Agents => "Agents",
            NavTab::Assets => "Assets",
            NavTab::Tools => "Tools",
            NavTab::Variables => "Variables",
        }
    }

    pub fn shortcut(self) -> &'static str {
        match self {
            NavTab::File => "⌥1",
            NavTab::Agents => "⌥2",
            NavTab::Assets => "⌥3",
            NavTab::Tools => "⌥4",
            NavTab::Variables => "⌥5",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RightTab {
    Design,
    Prototype,
    Inspect,
    /// UX Analysis Tool - analyze user flows, accessibility, design quality
    UX,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DashView {
    Home,
    Recents,
    Starred,
    Trash,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DashLayout {
    Grid,
    List,
}

// ------------------------------------------------------------- frame sizes

/// Frame presets — exact values from the v45 dropdown.
pub const FRAME_PRESETS: [(&str, f64, f64); 5] = [
    ("Frame", 375.0, 420.0),
    ("Desktop", 1440.0, 900.0),
    ("Laptop", 1280.0, 800.0),
    ("Tablet", 768.0, 1024.0),
    ("Mobile", 375.0, 812.0),
];

// ------------------------------------------------------------ recent files

#[derive(Clone, Debug)]
pub struct RecentFile {
    pub name: String,
    pub team: String,
    pub edited: String,
    pub color: VelloColor,
    pub members: Vec<String>,
    pub starred: bool,
    pub path: Option<PathBuf>,
    pub icon: &'static str,
}

/// Seed data — the exact six files / four drafts from dashboard-v2.html.
fn seed_recents() -> Vec<RecentFile> {
    vec![
        rf(
            "Liquor Delivery App UI",
            "Liquor Delivery",
            "Edited 2h ago",
            VelloColor::from_rgb8(0xFF, 0xFF, 0xFF),
            vec!['S', 'A'],
            None,
        ),
        rf(
            "DESIGN_SYSTEM.md",
            "Design System",
            "Edited 5h ago",
            VelloColor::from_rgb8(0x1A, 0x1A, 0x1A),
            vec!['S'],
            None,
        ),
        rf(
            "Payment Flow",
            "Liquor Delivery",
            "Edited yesterday",
            VelloColor::from_rgb8(0xE7, 0xF5, 0xF1),
            vec!['S', 'R', 'M'],
            None,
        ),
        rf(
            "Onboarding Screens",
            "Personal",
            "Edited 2 days ago",
            VelloColor::from_rgb8(0x11, 0x11, 0x11),
            vec!['S'],
            None,
        ),
        rf(
            "Dashboard Redesign",
            "Design System",
            "Edited 3 days ago",
            VelloColor::from_rgb8(0x1E, 0x1E, 0x24),
            vec!['S', 'A'],
            None,
        ),
        rf(
            "Landing Page",
            "Personal",
            "Edited 1 week ago",
            VelloColor::from_rgb8(0xFF, 0xFF, 0xFF),
            vec!['S'],
            None,
        ),
    ]
}

pub fn rf(
    name: &str,
    team: &str,
    edited: &str,
    color: VelloColor,
    members: Vec<char>,
    path: Option<PathBuf>,
) -> RecentFile {
    RecentFile {
        name: name.into(),
        team: team.into(),
        edited: edited.into(),
        color,
        members: members.into_iter().map(|c| c.to_string()).collect(),
        starred: false,
        path,
        icon: "file",
    }
}

fn seed_drafts() -> Vec<RecentFile> {
    vec![
        draft("Untitled", "Edited 1h ago", "file"),
        draft("Checkout Flow", "Edited 3h ago", "shopping-cart"),
        draft("Profile Settings", "Edited yesterday", "user"),
        draft("Analytics Dashboard", "Edited 2 days ago", "bar-chart-3"),
    ]
}

fn draft(name: &str, edited: &str, icon: &'static str) -> RecentFile {
    RecentFile {
        name: name.into(),
        team: icon.into(),
        edited: edited.into(),
        color: C_PANEL,
        members: vec![],
        starred: false,
        path: None,
        icon,
    }
}

// ----------------------------------------------------------------- actions

/// Every interactive zone records one of these; `run.rs` dispatches them.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    LoadingRetry,
    LoadingClose,
    LoadingRecover,
    LoadingSaved,
    CancelFileOperation,
    Ctx(CtxCmd),
    /// pages-panel context menu (right-click on the page field)
    PageMenu(PageMenuCmd),
    /// Add the selected frame's first auto-layout definition.
    AddAutoLayout,
    /// auto-layout wrap toggle (selected frame's own layout)
    ToggleWrap,
    /// main/cross axis Hug<->Fixed (selected frame's own layout)
    ToggleMainSizing,
    ToggleCrossSizing,
    /// Lock the W/H inspector fields to the current aspect ratio.
    ToggleAspectRatio,
    /// selected CHILD of an auto-layout frame: Fill container vs Fixed
    SetChildFill(bool),
    /// selected CHILD of an auto-layout frame: absolute position toggle
    ToggleChildAbsolute,
    /// component properties (A2): add a prop bound to the selected
    /// descendant of a master; remove one from the master's definition
    AddProp(x_native::ComponentPropKind),
    RemoveProp(String),
    /// instance-side edits: toggle a Bool prop / cycle a Swap prop
    // — prototyping (authoring + flow preview) —
    TokensExtractVars,
    VariantCycle(i32),
    VariantCombine,
    ProtoAdd,
    ProtoRemove(usize),
    ProtoTrigger(usize),
    ProtoDest(usize, i32),
    ProtoSpeed(usize),
    ProtoAnimation(usize),
    ProtoActionType(usize),
    ProtoEasing(usize),
    ProtoToggleReset(usize),
    ProtoAddAction(usize),
    ProtoRemoveAction(usize, usize),
    ProtoSetVariable(usize),
    ProtoConditional(usize),
    ProtoEditDelay(usize),
    ProtoEditKey(usize),
    ProtoEditUrl(usize),
    ProtoEditVideoTime(usize),
    ProtoToggleStart,
    FlowEnter,
    FlowBack,
    FlowExit,
    /// load a .ttf/.otf/.ttc into the canvas font stack
    LoadFont,
    ToggleInstanceProp(String),
    /// C21 INSPECT: platform picker + copy-code-to-clipboard
    InspectPlatform(usize),
    InspectCopy,
    CycleInstanceSwap(String),
    ResetInstanceProps,
    // global / dashboard
    NewFile,
    NewBoard,
    ImportFile,
    OpenRecent(usize),
    StarRecent(usize),
    OpenDraft(usize),
    DashNav(DashView),
    DashLayout(DashLayout),
    SearchFocus,
    Upgrade,
    /// UI palette (roles live in crates/x-ui/src/design_system.rs)
    SetTheme(x_native::ui::ThemeId),
    CycleTheme,
    InviteTeam,
    AddTeam,
    // editor chrome
    SelectDoc(usize),
    CloseDoc(usize),
    Tool(Tool),
    LeftTab(LeftTab),
    RightTab(RightTab),
    AddPage,
    SelectPage(usize),
    DeletePage(usize),
    TreeRow(String),
    TreeToggle(String),
    RenameStart,
    // inspector
    FrameDropdown,
    LhDropdown,
    LhMode(usize),
    /// Typography panel: the styles button opens the text-style picker
    TextStyleDropdown,
    /// Apply a named text style to the selected text layers (and link them,
    /// so later edits to the style propagate)
    ApplyTextStyle(String),
    /// Create a text style from the selected text layer's typography
    CreateTextStyle,
    /// Unlink the selected text layers from their text style, keeping values
    DetachTextStyle,
    /// Push the selection's typography into the style it is linked to and
    /// re-resolve every consumer (Figma's "Update style")
    UpdateTextStyleFromSelection,
    /// layer row hover toggles (Figma): eye / padlock
    TreeVisible(String),
    TreeLock(String),
    FramePreset(usize),
    Field(FieldId),
    FlowBtn(usize),
    ClipContent,
    ExportRun,
    AddFill,
    RemoveFill,
    AddStroke,
    RemoveStroke,
    AddEffect,
    AddGuide,
    RemoveGuide,
    ToggleGuide(usize),
    ToggleGuideVisibility,
    CycleExportFormat,
    CycleExportScale,
    PaletteToggle,
    PaletteRun(usize),
    ToggleVisible,
    ToggleLock,
    /// Toggle visibility of the primary fill or stroke layer.
    TogglePaintVisibility(bool),
    /// Cycle the selected stroke between inside, center, and outside.
    CycleStrokePosition,
    /// Text formatting actions (Figma Design parity)
    /// Cycle horizontal text alignment: left/center/right/justified
    CycleTextAlign,
    /// Cycle vertical text alignment: top/middle/bottom
    CycleTextAlignVertical,
    /// Toggle text decoration: none/underline/strikethrough
    CycleTextDecoration,
    /// Cycle text truncation: disabled/end/middle
    CycleTextTruncation,
    /// Cycle list style: none/bulleted/numbered
    CycleListStyle,
    /// Toggle wrap style: normal/break-word
    ToggleTextWrapStyle,
    /// Apply a color chosen from the native color popover.
    PaintPreset(bool, String),
    Align(usize, usize),
    /// Color picker popup toggle (fill/stroke)
    ToggleColorPicker(bool),
    CloseColorPicker,
    /// UX Analysis actions (Quant-UX inspired)
    UxAccessibility,
    UxUserFlow,
    UxQualityScore,
    UxPatterns,
    UxContrast,
    UxResponsive,
    // Navigation bar (Figma-style)
    NavTab(NavTab),
    ToggleNavLabels,
    OpenAppMenu,
    CloseAppMenu,
    AppMenuItem(usize),
    OpenFind,
    CloseFind,
    FindNext,
    FindPrev,
    ReplaceAll,
    ToggleCaseSensitive,
    ToggleFindInSelection,
    ToggleNotifications,
    DismissNotification(String),
    MarkAllNotificationsRead,
    ToggleMinimizeUI,
    ResizeLeftSidebar(f64),
    CollapseAllLayers,
    /// Edit file menu actions
    FileRename,
    FileMoveToDrafts,
    FileDuplicate,
    // Layer management (Figma parity)
    /// Show hidden layer outlines (⌘⇧O)
    ToggleHiddenOutlines,
    /// Inverse selection (⌘⇧A)
    InverseSelection,
    /// Select matching objects (⌥⌘A)
    SelectMatching,
    /// Deep select with Cmd/Ctrl+click
    DeepSelect(String),
    /// Measure distances to hovered layer
    ShowMeasurements(String),
    /// Bulk rename modal
    OpenBulkRename,
    CloseBulkRename,
    ApplyBulkRename,
    /// Copy/paste properties
    CopyProperties,
    PasteProperties,
    /// Layer panel search
    SetLayerSearch(String),
    /// Keyboard navigation in layer panel
    SelectChild,
    SelectParent,
    SelectNextSibling,
    SelectPrevSibling,
    /// Select layer from context menu
    SelectLayerFromMenu(String),
    // Vector Edit Mode actions (Figma parity)
    /// Enter vector edit mode (Enter key on vector node)
    EnterVectorEditMode,
    /// Exit vector edit mode (Escape or Enter again)
    ExitVectorEditMode,
    /// Select a vector point by index
    SelectVectorPoint(usize),
    /// Deselect all vector points
    DeselectVectorPoints,
    /// Move selected vector points
    MoveVectorPoints {
        dx: f64,
        dy: f64,
    },
    /// Add a point to a vector path
    AddVectorPoint {
        segment_idx: usize,
        position: (f64, f64),
    },
    /// Delete selected vector points
    DeleteVectorPoints,
    /// Switch vector editing tool
    SetVectorTool(VectorTool),
    /// Toggle vector handle visibility
    ToggleVectorHandles,
    /// Add bezier handle to a point
    AddBezierHandle(usize),
    /// Adjust bezier handle
    AdjustBezierHandle {
        point_idx: usize,
        handle: (f64, f64),
    },
    /// Split vector path at a point
    SplitVectorPath(usize),
    /// Cut vector path along a line
    CutVectorPath {
        start: (f64, f64),
        end: (f64, f64),
    },
    /// Outline stroke (convert stroke to vector path)
    OutlineStroke,
    /// Flatten selection (merge into single vector path)
    FlattenSelection,
    /// Offset vector path
    OffsetVector {
        distance: f64,
        join: String,
    },
    /// Simplify vector path
    SimplifyVector {
        tolerance: f64,
    },
    /// Convert text to vector path
    TextToOutline,
    // Phase 2: Vector Editing Tools
    AddBezierHandle {
        point_idx: usize,
        handle_pos: (f64, f64),
    },
    AdjustBezierHandle {
        point_idx: usize,
        handle_idx: usize,
        new_pos: (f64, f64),
    },
    SplitVectorPath {
        point_idx: usize,
    },
    CutVectorPath {
        start: (f64, f64),
        end: (f64, f64),
    },
    LassoSelectPoints {
        boundary: Vec<(f64, f64)>,
    },
    SetVariableWidthStroke {
        width_points: Vec<(f64, f64)>,
    },
    RemoveBezierHandles {
        point_idx: usize,
    },
    MirrorBezierHandles {
        point_idx: usize,
        mode: crate::state::MirrorMode,
    },
    // Phase 3: Enhanced Path Operations
    OutlineStrokeEnhanced,
    OffsetVectorEnhanced {
        distance: f64,
        join_style: JoinStyle,
    },
    TextToOutlineEnhanced,
    SimplifyVectorInteractive {
        tolerance: f64,
        preview: bool,
    },
    JoinPaths {
        node_id1: String,
        node_id2: String,
    },
    ReversePathDirection,
    // Phase 4: Stroke Caps
    SetStrokeCapStart {
        node_id: String,
        cap: crate::state::StrokeCapType,
    },
    SetStrokeCapEnd {
        node_id: String,
        cap: crate::state::StrokeCapType,
    },
    // Phase 5: Interactive UI Actions
    UpdateShapeBuilderHover {
        mouse_pos: (f64, f64),
    },
    ExecuteShapeBuilderOperation,
    SetShapeBuilderMode(ShapeBuilderMode),
    ToggleShapeBuilderSelectionMode,
    ApplyDashPattern {
        node_id: String,
        pattern: DashPattern,
    },
    SetAdvancedStrokeCap {
        node_id: String,
        is_start: bool,
        cap: AdvancedStrokeCap,
    },
    // Phase 6: Advanced Gradients, Image Adjustments, and Missing Blend Modes
    /// Flip a gradient (reverse color stops)
    FlipGradient,
    /// Rotate gradient angle
    RotateGradient {
        degrees: f64,
    },
    /// Add a color stop to a gradient at position 0.0-1.0
    AddGradientStop {
        position: f32,
        color: [u8; 3],
    },
    /// Remove a color stop from gradient
    RemoveGradientStop {
        index: usize,
    },
    /// Move a color stop to new position
    MoveGradientStop {
        index: usize,
        new_position: f32,
    },
    /// Change gradient type (linear/radial/angular/diamond)
    SetGradientType {
        gradient_type: String,
    },
    /// Enable eyedropper tool
    EnableEyedropper,
    /// Set image adjustments (exposure, contrast, saturation, etc.)
    SetImageAdjustments {
        adjustments: x_native::ImageAdjustments,
    },
    /// Update individual image adjustment value
    UpdateImageAdjustment {
        adjustment: String,
        value: f32,
    },
    /// Reset all image adjustments
    ResetImageAdjustments,
    /// Rotate image (90° clockwise increments)
    RotateImage {
        clockwise: bool,
    },
    /// Set image fill mode (fill/fit/crop/tile)
    SetImageFillMode {
        mode: String,
    },
}

/// Commands offered by the editor right-click context menu
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageMenuCmd {
    Rename,
    Duplicate,
    Delete,
    MoveUp,
    MoveDown,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CtxCmd {
    ToFront,
    ToBack,
    Copy,
    /// B13: serialize the selection to JSX (system clipboard + status)
    CopyAsCode,
    Cut,
    Paste,
    Duplicate,
    Delete,
    Group,
    Ungroup,
    MakeComponent,
    /// boolean combine of the two selected shapes (engine boolean_selected)
    Union,
    Subtract,
    Intersect,
    Exclude,
    /// single-step z-order (Figma ⌘] / ⌘[)
    BringFwd,
    SendBack,
    /// layers-panel row toggles, reachable from the canvas menu too
    LockSel,
    HideSel,
    SelectAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldId {
    DocName,
    /// component property, Text kind (prop name lives in
    /// `App::instance_prop_target`)
    InstanceProp,
    /// pages panel: active-page inline rename (opened from the page menu)
    PageName,
    W,
    H,
    X,
    Y,
    Rotation,
    Opacity,
    Radius,
    FillHex,
    FillAlpha,
    StrokeHex,
    StrokeAlpha,
    StrokeWeight,
    Gap,
    PadH,
    PadV,
    FontFamily,
    FontWeight,
    FontSize,
    LineHeight,
    LetterSpacing,
    WordSpacing,
    ParaSpacing,
    BaselineShift,
    TextCase,
    OpticalSize,
    WidthAxis,
    /// Text alignment (horizontal): left/center/right/justified
    TextAlign,
    /// Text alignment (vertical): top/middle/bottom
    TextAlignVertical,
    /// Text decoration: none/underline/strikethrough
    TextDecoration,
    /// Text truncation: disabled/end/middle
    TextTruncation,
    /// Maximum lines for text truncation
    MaxLines,
    /// Paragraph indent (first-line indent in pixels)
    ParagraphIndent,
    /// List style: none/bulleted/numbered
    ListStyle,
    /// Text wrap style: normal/break-word
    TextWrapStyle,
    ExportSuffix,
    GuideSize,
    /// No-selection DESIGN panel: editor canvas background hex
    CanvasBg,
    /// No-selection DESIGN panel: pixel grid color hex
    GridColor,
    /// No-selection DESIGN panel: pixel grid opacity %
    GridPct,
    /// Right-panel zoom % box
    Zoom,
}

/// An armed `AfterDelay` trigger in the flow preview: fire `action` when
/// the wall clock reaches `at`. `source_overlay` pins delays authored
/// inside an overlay: closing the overlay disarms them.
#[derive(Clone, Debug)]
pub struct FlowDelay {
    pub at: std::time::Instant,
    pub source_overlay: Option<String>,
    pub action: x_native::Action,
    pub ms: u32,
}

/// Hamburger menu state (Figma navigation bar top menu).
#[derive(Clone, Debug, Default)]
pub struct AppMenu {
    pub open: bool,
    pub hover_index: Option<usize>,
}

/// Find/Replace panel state (Figma left sidebar search).
#[derive(Clone, Debug, Default)]
pub struct FindReplace {
    pub open: bool,
    pub show_replace: bool,
    pub query: String,
    pub replace: String,
    pub case_sensitive: bool,
    pub in_selection: bool,
    pub match_count: usize,
    pub current_match: usize,
}

/// Notification center state (Figma navigation bar bottom).
#[derive(Clone, Debug)]
pub struct NotificationCenter {
    pub open: bool,
    pub notifications: Vec<Notification>,
    pub unread_count: usize,
}

impl Default for NotificationCenter {
    fn default() -> Self {
        Self {
            open: false,
            notifications: vec![
                Notification {
                    id: "font-missing".into(),
                    kind: NotificationKind::MissingFont,
                    message: "Inter font not installed — using fallback".into(),
                    timestamp: 0,
                    read: false,
                },
                Notification {
                    id: "lib-update".into(),
                    kind: NotificationKind::LibraryUpdate,
                    message: "2 library components have updates available".into(),
                    timestamp: 0,
                    read: false,
                },
            ],
            unread_count: 2,
        }
    }
}

/// A single notification entry.
#[derive(Clone, Debug)]
pub struct Notification {
    pub id: String,
    pub kind: NotificationKind,
    pub message: String,
    pub timestamp: u64,
    pub read: bool,
}

/// Notification type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationKind {
    LibraryUpdate,
    MissingFont,
    OfflineStatus,
    ComponentUpdate,
}

impl NotificationKind {
    pub fn icon(self) -> &'static str {
        match self {
            NotificationKind::LibraryUpdate => "rotate-cw",
            NotificationKind::MissingFont => "type",
            NotificationKind::OfflineStatus => "eye-off",
            NotificationKind::ComponentUpdate => "component",
        }
    }
}

/// Flow-preview state: prototype playback in a chrome-less viewer over the
/// live canvas. The viewer focuses `current`, `stack` backs navigation,
/// `overlays` float above the screen.
///
/// `vars` is the preview's OWN variable store, cloned from the document
/// when the preview starts: expression evaluation, `SetVar`/`SetMode`,
/// and conditionals all run against it, so playback can never edit the
/// file. (No `PartialEq`: [`x_native::Variables`] deliberately doesn't
/// implement it — use field asserts in tests.)
#[derive(Clone, Debug, Default)]
pub struct FlowState {
    pub current: String,
    pub stack: Vec<String>,
    /// open overlay stack, bottom → top (the shared engine type, so the
    /// preview and the editor player can't disagree on its shape).
    pub overlays: Vec<x_native::editor::Overlay>,
    /// preview-owned variables (see above).
    pub vars: x_native::Variables,
    /// armed `AfterDelay` triggers, in arm order.
    pub delays: Vec<FlowDelay>,
    /// node id under the pointer (drives hover / enter / leave).
    pub hovered: Option<String>,
    /// a press is down inside the viewer (drag detection armed).
    pub dragging: bool,
    /// `OnDrag` already fired for this press-drag-release cycle.
    pub drag_fired: bool,
    /// armed Figma "while hovering" auto-reverse (engine `WhileSpan`).
    pub hover_span: Option<x_native::editor::WhileSpan>,
    /// armed Figma "while pressing" auto-reverse (reverts on release).
    pub press_span: Option<x_native::editor::WhileSpan>,
}

/// Clipboard for copying/pasting layer properties (Figma parity)
#[derive(Clone, Debug)]
pub struct PropertyClipboard {
    pub fill: Option<x_native::Paint>,
    pub stroke: Option<x_native::Stroke>,
    pub effects: Vec<x_native::Effect>,
    pub opacity: Option<f32>,
    pub corner_radius: Option<f64>,
}

// Vector Edit Mode (Figma parity)
#[derive(Debug, Clone)]
pub struct VectorEditMode {
    pub active: bool,
    pub selected_node: Option<String>,
    pub selected_points: Vec<usize>,
    pub tool: VectorTool,
    pub show_handles: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorTool {
    Move,
    Pen,
    Bend,
    Cut,
    Eraser,
    Lasso,
}

impl Default for VectorTool {
    fn default() -> Self {
        VectorTool::Move
    }
}

/// Mirror mode for bézier handles
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorMode {
    None,
    Angle,
    AngleAndLength,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinStyle {
    Miter,
    Round,
    Bevel,
}

impl Default for JoinStyle {
    fn default() -> Self {
        JoinStyle::Miter
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrokeCapType {
    None,
    Round,
    Square,
    Arrow,
    Triangle,
}

/// Shape Builder operation mode
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeBuilderMode {
    Merge,
    Subtract,
    Intersect,
    Exclude,
}

/// Selection mode for Shape Builder
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionMode {
    Click,
    Drag,
    Lasso,
}

/// Shape operation for Shape Builder
#[derive(Debug, Clone)]
pub enum ShapeOperation {
    Merge(Vec<String>),
    Subtract { base: String, subtract: Vec<String> },
    Intersect(Vec<String>),
    Exclude(Vec<String>),
}

/// Arrow style configuration
#[derive(Debug, Clone, PartialEq)]
pub struct ArrowStyle {
    pub length_factor: f64,
    pub width_factor: f64,
    pub filled: bool,
    pub reversed: bool,
}

/// Advanced stroke cap types
#[derive(Debug, Clone, PartialEq)]
pub enum AdvancedStrokeCap {
    None,
    Round,
    Square,
    Arrow(ArrowStyle),
    Triangle,
    Diamond,
    Circle,
    Bar,
    Custom(Vec<PathCmd>),
}

/// Dash pattern configuration
#[derive(Debug, Clone, PartialEq)]
pub struct DashPattern {
    pub dashes: Vec<f64>,
    pub offset: f64,
}

impl Default for VectorEditMode {
    fn default() -> Self {
        Self {
            active: false,
            selected_node: None,
            selected_points: Vec::new(),
            tool: VectorTool::Move,
            show_handles: true,
        }
    }
}

/// The one text-entry surface: clicking a field focuses it; keystrokes go
/// into `buffer`; Enter commits, Esc cancels.
#[derive(Clone, Debug)]
pub struct FieldEdit {
    pub id: FieldId,
    pub buffer: String,
}

// ------------------------------------------------------------ drag / input

#[derive(Clone, Debug)]
pub enum Drag {
    LeftPanel {
        start_x: f64,
        start_w: f64,
    },
    RightPanel {
        start_x: f64,
        start_w: f64,
    },
    /// Dragging the canvas with Hand tool / middle mouse / space.
    Pan {
        start: Point,
        start_pan: (f64, f64),
    },
    /// Moving the current selection.
    MoveSel {
        last: Point,
    },
    /// Rubber-band selection.
    Marquee {
        start: Point,
        cur: Point,
    },
    /// Drag-selecting text inside the open inline editor.
    TextEditSel,
    /// dragging a ruler guide ('v' top ruler / 'h' left ruler); the world
    /// coord tracks the cursor; release inside the ruler cancels
    Guide {
        axis: char,
    },
    /// Shape-tool drag-create.
    Create {
        tool: Tool,
        start: Point,
        cur: Point,
    },
    /// Corner-resize of the selection (corner idx: 0 TL, 1 TR, 2 BL, 3 BR).
    ResizeSel {
        corner: usize,
        orig: (f64, f64, f64, f64), // x, y, w, h at drag start
        start: Point,
    },
    /// Pen-tool polyline in progress (world-space points).
    Pen {
        points: Vec<Point>,
        cursor: Option<Point>,
    },
    /// Eraser tool stroke in progress.
    Erase {
        start: Point,
        cur: Point,
    },
    /// Board: Creating a sticky note.
    BoardCreateSticky {
        start: Point,
        cur: Point,
        color_idx: usize,
    },
    /// Board: Drawing a connector between nodes.
    BoardConnector {
        from_node: String,
        from_point: Point,
        to_point: Point,
    },
    /// Board: Moving a board node.
    BoardMoveNode {
        node_id: String,
        start: Point,
        cur: Point,
    },
    /// Board: Rubber-band selection on infinite canvas.
    BoardMarquee {
        start: Point,
        cur: Point,
    },
    /// Board: Pan on infinite canvas (Hand tool).
    BoardPan {
        start: Point,
        start_pan: (f64, f64),
    },
    /// Board: Pen tool freehand drawing.
    BoardPen {
        id: String,
        points: Vec<Point>,
    },
}

// -------------------------------------------------------------- open files

/// One open document = one editor tab.
pub struct OpenDoc {
    /// Imported source is never a native save destination.
    pub source_path: Option<PathBuf>,
    pub disk_hash: Option<String>,
    pub canonical_path: Option<PathBuf>,
    pub envelope: crate::session::Envelope,
    pub recovery_path: PathBuf,
    pub last_autosave_revision: Option<u64>,
    pub autosave_note: Option<String>,
    pub history: crate::session::History,
    pub assets: x_native::Assets,
    pub frame_cache: x_native::FrameCache,
    pub prepared_canvas: Option<crate::loading::PreparedCanvas>,
    pub name: String,
    pub path: Option<PathBuf>,
    /// v45 mock: the left-panel file-name row text (HTML `file-name-text`)
    /// — the mock keeps it independent from the active tab name; None
    /// falls back to `name`.
    pub file_label: Option<String>,
    /// v45 mock left-panel layers (HTML `layers` const). The mock renders
    /// the tree from this hardcoded flat array, intentionally independent
    /// from the canvas board. Empty → render the real document tree.
    pub mock_layers: Vec<MockLayer>,
    /// Seeded mock tabs keep the audited Chromium tab widths (the browser's
    /// flex layout inflates them ~2px past the text advances);
    /// None → derive from the text measure (user-created tabs).
    pub tab_w: Option<f64>,
    pub doc: Document,
    pub editors: Vec<Editor>,
    pub page: usize,
    pub dirty: bool,
    pub expanded: HashSet<String>,
    pub left_tab: LeftTab,
    pub right_tab: RightTab,
    pub frame_preset: usize,
    pub flow: usize,
    /// v45 mock boot state: flow pills 0 AND 2 carry .active in the HTML
    /// (duplicated class in the mock); first user click takes over
    pub flow_boot_mock: bool,
    pub gap: f64,
    pub pad_h: f64,
    pub pad_v: f64,
    pub export_format: usize, // 0 PNG 1 JPG 2 SVG 3 PDF
    pub export_scale: usize,  // 0 1x 1 2x
    pub export_suffix: String,
    pub guide_kind: usize, // 0 Square 1 Grid
    pub guide_size: f64,
    /// Whether the selected frame's layout-guide overlay is visible.
    pub guides_visible: bool,
    pub scroll_left: f64,
    pub scroll_right: f64,
    /// Ruler guides: ('v' | 'h', world coord along the canvas axis)
    pub guides: Vec<(char, f64)>,
    /// guide being dragged (live preview line)
    pub guide_drag: Option<(char, f64)>,
    /// Board document for infinite canvas mode
    pub board_doc: Option<x_board::BoardDocument>,
    /// Color picker popup state for fill
    pub color_picker_fill_open: bool,
    /// Color picker popup state for stroke
    pub color_picker_stroke_open: bool,
}

/// One row of the v45 mock's left-panel layers array (HTML `layers` const):
/// flat display data with explicit indents — e.g. `section-header` renders
/// at indent 2 under an indent-1 `pay-row` that itself has no chevron.
#[derive(Debug, Clone)]
pub struct MockLayer {
    pub name: String,
    pub icon: &'static str,
    pub indent: usize,
    pub expanded: bool,
    pub has_children: bool,
    pub selected: bool,
}

fn demo_layers() -> Vec<MockLayer> {
    let m = |name: &str, icon: &'static str, indent: usize, expanded: bool, has_children: bool| {
        MockLayer {
            name: name.into(),
            icon,
            indent,
            expanded,
            has_children,
            selected: false,
        }
    };
    vec![
        m("Board", "frame#", 0, false, false),
        m("order-details", "layout-grid", 0, false, true),
        m("Header", "type", 1, false, false),
        m("Content", "layout-grid", 1, false, false),
        m("Rectangle 12", "square", 0, false, false),
        m("payment-methods", "layout-grid", 0, true, true),
        m("pay-row", "frame#", 1, false, false),
        m("section-header", "type", 2, false, false),
        m("pay-row", "frame#", 1, true, true),
        m("Ellipse 3", "circle", 2, false, false),
        m("Vector", "pen-tool", 2, false, false),
    ]
}

impl OpenDoc {
    /// The v45 HTML editor mock's boot document: file "Liquor Delivery App
    /// UI" on Page 3 of 3, the Frame board (375×420 @ 0,60) as content, and
    /// the mock layers array for the left panel.
    pub fn demo_doc() -> Self {
        let mut d = OpenDoc::demo_blank("DESIGN_SYSTEM.md".into());
        d.file_label = Some("Liquor Delivery App UI".into());
        // audited Chromium tab boxes (html-editor.png): 120 | 178 | 128
        d.tab_w = Some(178.0);
        d.flow_boot_mock = true;
        // Two empty pages in front — the mock shows the "Page 3" field and
        // the PAGE 3 tree header with this document's board as Page 3.
        for n in [1usize, 2] {
            let mut p = Node::frame(&format!("page-empty-{n}"), 1440.0, 1024.0);
            p.name = format!("Page {n}");
            d.editors
                .insert(n - 1, x_native::editor::Editor::new(p.clone()));
            d.doc.pages.insert(n - 1, p);
        }
        d.page = 2;
        d.mock_layers = demo_layers();
        d
    }

    pub fn new_blank(name: String) -> Self {
        let mut page = Node::frame(&x_native::fresh_id("page"), 1440.0, 1024.0);
        page.name = "Page 1".into();
        Self::from_document(
            name,
            None,
            Document {
                pages: vec![page],
                ..Default::default()
            },
        )
    }

    pub fn demo_blank(name: String) -> Self {
        let mut page = Node::frame("page-1", 1440.0, 1024.0);
        page.name = "Page 1".into();
        // The v45 canvas shows one white 375x420 frame at X 0 Y 60.
        let mut f = Node::frame("frame-1", 375.0, 420.0);
        f.name = "Frame".into();
        f.transform.x = 0.0;
        f.transform.y = 60.0;
        f.fill = Paint::Solid(VelloColor::from_rgb8(0xFF, 0xFF, 0xFF));
        // v45 mock: `rounded-[8px] shadow-2xl` on the canvas frame
        f.corner_radii = Some([8.0, 8.0, 8.0, 8.0]);
        page.children.push(f);
        let editor = Editor::new(page.clone());
        let doc = Document {
            pages: vec![page],
            ..Document::default()
        };
        Self {
            name,
            path: None,
            source_path: None,
            disk_hash: None,
            canonical_path: None,
            envelope: Default::default(),
            recovery_path: crate::session::new_recovery_path(),
            last_autosave_revision: None,
            autosave_note: None,
            history: Default::default(),
            assets: x_native::Assets::new(),
            frame_cache: x_native::FrameCache::new(),
            prepared_canvas: None,
            file_label: None,
            mock_layers: Vec::new(),
            tab_w: None,
            doc,
            editors: vec![editor],
            page: 0,
            dirty: false,
            expanded: HashSet::new(),
            left_tab: LeftTab::Layers,
            right_tab: RightTab::Design,
            frame_preset: 0,
            flow: 0,
            flow_boot_mock: false,
            gap: 5.0,
            pad_h: 0.0,
            pad_v: 0.0,
            export_format: 0,
            export_scale: 0,
            export_suffix: String::new(),
            guide_kind: 0,
            guide_size: 16.0,
            guides_visible: true,
            scroll_left: 0.0,
            scroll_right: 0.0,
            guides: vec![],
            guide_drag: None,
            board_doc: None,
            color_picker_fill_open: false,
            color_picker_stroke_open: false,
        }
    }

    pub fn from_document(name: String, path: Option<PathBuf>, mut doc: Document) -> Self {
        if doc.pages.is_empty() {
            doc.pages.push(Node::frame("page-1", 1440.0, 1024.0));
        }
        let editors = doc.pages.iter().map(|p| Editor::new(p.clone())).collect();
        let canonical_path = path.as_ref().and_then(|p| p.canonicalize().ok());
        Self {
            name,
            path,
            source_path: None,
            disk_hash: None,
            canonical_path,
            envelope: Default::default(),
            recovery_path: crate::session::new_recovery_path(),
            last_autosave_revision: None,
            autosave_note: None,
            history: Default::default(),
            assets: x_native::Assets::new(),
            frame_cache: x_native::FrameCache::new(),
            prepared_canvas: None,
            file_label: None,
            mock_layers: Vec::new(),
            tab_w: None,
            doc,
            editors,
            page: 0,
            dirty: false,
            expanded: HashSet::new(),
            left_tab: LeftTab::Layers,
            right_tab: RightTab::Design,
            frame_preset: 0,
            flow: 0,
            flow_boot_mock: false,
            gap: 5.0,
            pad_h: 0.0,
            pad_v: 0.0,
            export_format: 0,
            export_scale: 0,
            export_suffix: String::new(),
            guide_kind: 0,
            guide_size: 16.0,
            guides_visible: true,
            scroll_left: 0.0,
            scroll_right: 0.0,
            guides: vec![],
            guide_drag: None,
            board_doc: None,
            color_picker_fill_open: false,
            color_picker_stroke_open: false,
        }
    }

    pub fn editor(&mut self) -> &mut Editor {
        let n = self.editors.len();
        let idx = self.page.min(n.saturating_sub(1));
        &mut self.editors[idx]
    }

    pub fn editor_ref(&self) -> &Editor {
        let idx = self.page.min(self.editors.len().saturating_sub(1));
        &self.editors[idx]
    }

    /// Editors own mutable page roots. Synchronize every page at persistence /
    /// document-transaction boundaries, never as a side effect of painting.
    pub fn sync(&mut self) {
        self.doc.pages = self.editors.iter().map(|e| e.root.clone()).collect();
    }

    pub fn selected_id(&self) -> Option<String> {
        self.editor_ref().selection.last().cloned()
    }
}

// ---------------------------------------------------------------- app root

/// C18: the new-comment composer anchored at a canvas point.
#[derive(Debug, Clone)]
pub struct CommentDraft {
    pub x: f64,
    pub y: f64,
    pub buffer: String,
}

pub struct App {
    pub document_loading: Option<crate::loading::LoadingScreen>,
    pub file_job: Option<crate::jobs::DisplayStatus>,
    pub demo_mode: bool,
    pub smoke_mode: bool,
    pub presented_frames: u64,
    pub smoke_resized: bool,
    pub smoke_wait_document: bool,
    pub smoke_editor_frames: u64,
    pub loading_frames_presented: u64,
    pub clipboard: crate::clipboard::Clipboard,
    pub ime_preedit: String,
    pub next_autosave: std::time::Instant,
    pub screen: Screen,
    pub docs: Vec<OpenDoc>,
    pub active: usize,
    pub user: &'static str,
    pub recents: Vec<RecentFile>,
    pub drafts: Vec<RecentFile>,
    pub dash_view: DashView,
    pub dash_layout: DashLayout,
    pub dash_search: String,
    pub dash_scroll: f64,
    pub dash_search_focus: bool,
    // editor ui state
    pub left_w: f64,
    pub right_w: f64,
    pub tool: Tool,
    pub drag: Option<Drag>,
    pub field: Option<FieldEdit>,
    /// prototype flow preview (None = normal editing)
    pub flow: Option<FlowState>,
    pub dropdown_frame: bool,
    /// Typography panel: line-height mode menu (Auto / Pixels / Percent)
    pub dropdown_lh: bool,
    /// Typography panel: text-style picker (Figma's styles button)
    pub dropdown_text_style: bool,
    /// Viewport rulers (Shift+R). Off by default — the HTML mock has none.
    pub rulers: bool,
    /// DESIGN panel (no selection): editor canvas background
    pub canvas_bg: Color,
    /// DESIGN panel (no selection): pixel grid color + opacity %
    pub grid_color: Color,
    pub grid_pct: f64,
    /// Alignment-card selection (row, col) of the last alignment applied
    pub align: (usize, usize),
    /// Active smart-guide lines while dragging: world coord + 'v'/'h'
    pub snap_lines: Vec<(f64, char)>,
    /// Last click (instant + screen pos) for double-click detection
    pub last_click: Option<(std::time::Instant, Point)>,
    /// Node being inline-edited
    pub text_edit: Option<String>,
    /// Rich-text styling of the OPEN inline editor (char-index runs over
    /// the field buffer). Committed to the node with the text.
    pub text_runs_edit: Vec<x_native::TextRun>,
    /// Inline-editor caret (CHAR index into the editor buffer) and the
    /// selection anchor (None = no selection, caret only).
    pub text_caret: usize,
    pub text_anchor: Option<usize>,
    /// Layer under the cursor (Figma hover outline). None when selected,
    /// off-canvas, dragging, editing text, or not on the select tool.
    pub hover_node: Option<String>,
    /// Press on an ALREADY-SELECTED Text node: click (release without
    /// drag) places the caret — Figma's single-click text re-entry. A
    /// drag cancels it and moves the layer instead.
    pub pending_text_edit: Option<(String, Point)>,
    /// The inline editor's OWN text (decoupled from `field` so panel
    /// typography fields can open while editing — focus decides who gets
    /// the keystrokes).
    pub text_buffer: String,
    pub text_undo: Vec<crate::text_session::TextSnapshot>,
    pub text_redo: Vec<crate::text_session::TextSnapshot>,
    pub text_clipboard: String,
    pub field_select_all: bool,
    /// the component Text property currently being edited
    pub instance_prop_target: Option<String>,
    /// last JSX produced by Copy-as-code (for tests; the real target is
    /// the system clipboard)
    pub last_copied_code: Option<String>,
    /// C18: comment being composed (pin anchor in world coords + buffer)
    pub comment_draft: Option<CommentDraft>,
    /// C18: id of the comment whose thread popover is open
    pub open_comment: Option<String>,
    /// C21 dev mode: INSPECT tab platform (0 CSS, 1 SwiftUI, 2 Compose, 3 XML)
    pub inspect_platform: usize,
    /// (rect, prop name) of the last painted InstanceProp input — lets the
    /// Field action resolve WHICH prop the click targeted
    pub last_instance_prop_rect: Option<(Rect, String)>,
    /// right-click menu on the pages panel's page field
    pub page_menu: Option<Point>,
    /// the page field rect, captured at paint for right-click hit
    pub page_field_rect: Option<Rect>,
    /// Command Palette (⌘K) - full implementation with fuzzy search, navigation, and execution
    pub palette: CommandPalette,
    /// Context menu system for canvas, layers, pages, inspector, and tool rail
    pub context_menu: ContextMenu,
    /// Color picker popup state: (is_fill, field_rect, is_open)
    pub color_picker_popup: Option<(bool, Rect, bool)>,
    pub status: String,
    // Navigation bar state (Figma-style)
    pub nav_tab: NavTab,
    pub nav_show_labels: bool,
    pub nav_bar_w: f64,
    pub left_sidebar_w: f64,
    pub sidebar_resizing: bool,
    pub ui_minimized: bool,
    pub app_menu: AppMenu,
    pub find_replace: FindReplace,
    pub notifications: NotificationCenter,
    pub left_sidebar_width: f64,
    /// Inspector W/H lock state; kept at app level because it is UI intent,
    /// not a document property.
    pub aspect_ratio_locked: bool,
    pub zoom: f64,
    pub pan: (f64, f64),
    pub ctrl: bool,
    pub shift: bool,
    /// Alt/Option held (⌥-drag = duplicate)
    pub alt: bool,
    /// Symmetry axis for mirror tool: 'v' vertical, 'h' horizontal, None = off
    pub symmetry_axis: Option<char>,
    pub fonts: TextUi,
    // Layer management (Figma parity)
    pub show_hidden_outlines: bool,
    pub property_clipboard: Option<PropertyClipboard>,
    pub layer_search: String,
    pub bulk_rename_open: bool,
    pub bulk_rename_match: String,
    pub bulk_rename_replace: String,
    pub bulk_rename_preview: Vec<(String, String)>,
    /// Vector edit mode state (Figma parity)
    pub vector_edit_mode: VectorEditMode,
    // Phase 5: Shape Builder state
    pub shape_builder_hover: Option<(f64, f64)>,
    pub shape_builder_mode: ShapeBuilderMode,
    pub shape_builder_selection_mode: SelectionMode,
    pub shape_builder_preview: Option<ShapeOperation>,
    pub win_w: f64,
    pub win_h: f64,
    pub hit: Vec<(Rect, Action)>,
    pub scaled: bool,
    pub mouse: Point,
    /// Space held → drag pans the canvas (legacy behavior, kept).
    pub space_pan: bool,
}

pub const USER_NAME: &str = "You";

impl App {
    pub fn new() -> Self {
        let mut app = Self::demo();
        app.demo_mode = false;
        app.smoke_mode = std::env::args_os().any(|a| a == "--smoke-test");
        app.docs.clear();
        app.drafts.clear();
        app.active = 0;
        app.screen = Screen::Dashboard;
        app.status = "Local files · no account required".into();
        app.reload_recents();
        app
    }

    /// Explicit --demo mode and deterministic UI fixtures only.
    pub fn demo() -> Self {
        Self {
            document_loading: None,
            file_job: None,
            demo_mode: true,
            smoke_mode: false,
            presented_frames: 0,
            smoke_resized: false,
            smoke_wait_document: false,
            smoke_editor_frames: 0,
            loading_frames_presented: 0,
            clipboard: Default::default(),
            ime_preedit: String::new(),
            next_autosave: std::time::Instant::now() + std::time::Duration::from_secs(30),
            screen: Screen::Dashboard,
            // v45 mock boot tabs: Untitled (home) | DESIGN_SYSTEM.md
            // (active, the demo doc) | Liquor App
            docs: vec![
                {
                    let mut d = OpenDoc::demo_blank("Untitled".into());
                    d.tab_w = Some(120.0); // audited Chromium tab boxes
                    d
                },
                OpenDoc::demo_doc(),
                {
                    let mut d = OpenDoc::demo_blank("Liquor App".into());
                    d.tab_w = Some(128.0);
                    d
                },
            ],
            active: 1,
            user: USER_NAME,
            recents: seed_recents(),
            drafts: seed_drafts(),
            dash_view: DashView::Home,
            dash_layout: DashLayout::Grid,
            dash_search: String::new(),
            dash_scroll: 0.0,
            dash_search_focus: false,
            left_w: ED_LEFT_W,
            right_w: ED_RIGHT_W,
            tool: Tool::Select,
            drag: None,
            field: None,
            flow: None,
            dropdown_frame: false,
            dropdown_lh: false,
            dropdown_text_style: false,
            rulers: false,
            // canvas matches the HTML `.canvas` token; grid per the design
            // empty-selection panel (PIXEL GRID COLOR 0070E4 @ 20%)
            canvas_bg: crate::theme::C_CANVAS,
            grid_color: Color::from_rgb8(0x00, 0x70, 0xE4),
            grid_pct: 20.0,
            align: (0, 2),
            snap_lines: Vec::new(),
            last_click: None,
            text_edit: None,
            text_runs_edit: Vec::new(),
            text_caret: 0,
            text_anchor: None,
            text_buffer: String::new(),
            text_undo: vec![],
            text_redo: vec![],
            text_clipboard: String::new(),
            field_select_all: false,
            hover_node: None,
            pending_text_edit: None,
            instance_prop_target: None,
            last_copied_code: None,
            comment_draft: None,
            open_comment: None,
            inspect_platform: 0,
            last_instance_prop_rect: None,
            page_menu: None,
            page_field_rect: None,
            palette: CommandPalette::new(1440.0, 900.0),
            context_menu: ContextMenu::new(),
            color_picker_popup: None,
            status: String::from("Ready"),
            nav_tab: NavTab::File,
            nav_show_labels: true,
            nav_bar_w: 48.0,
            left_sidebar_w: 280.0,
            sidebar_resizing: false,
            ui_minimized: false,
            app_menu: AppMenu::default(),
            find_replace: FindReplace::default(),
            notifications: NotificationCenter::default(),
            left_sidebar_width: 280.0,
            show_hidden_outlines: false,
            property_clipboard: None,
            layer_search: String::new(),
            bulk_rename_open: false,
            bulk_rename_match: String::new(),
            bulk_rename_replace: String::new(),
            bulk_rename_preview: Vec::new(),
            vector_edit_mode: VectorEditMode::default(),
            // Phase 5: Shape Builder state
            shape_builder_hover: None,
            shape_builder_mode: ShapeBuilderMode::Merge,
            shape_builder_selection_mode: SelectionMode::Click,
            shape_builder_preview: None,
            aspect_ratio_locked: false,
            zoom: 1.0,
            pan: (0.0, 0.0),
            ctrl: false,
            alt: false,
            shift: false,
            symmetry_axis: None,
            fonts: TextUi::load(),
            win_w: 1440.0,
            win_h: 900.0,
            hit: vec![],
            scaled: false,
            mouse: Point::ZERO,
            space_pan: false,
        }
    }

    // ------------------------------------------------------------- regions

    pub fn editor_regions(&self) -> EdRegions {
        let left_total = if self.ui_minimized {
            self.nav_bar_w
        } else {
            self.nav_bar_w + self.left_sidebar_w
        };
        EdRegions {
            left: Rect::new(0.0, ED_TITLE_H, left_total, self.win_h),
            nav_bar: Rect::new(0.0, ED_TITLE_H, self.nav_bar_w, self.win_h),
            sidebar: Rect::new(self.nav_bar_w, ED_TITLE_H, left_total, self.win_h),
            right: Rect::new(
                self.win_w - self.right_w,
                ED_TITLE_H,
                self.win_w,
                self.win_h,
            ),
            canvas: Rect::new(
                left_total,
                ED_TITLE_H,
                self.win_w - self.right_w,
                self.win_h,
            ),
        }
    }

    /// The rect the document viewport occupies: the canvas region while
    /// editing, the whole window in the chrome-less flow viewer (editor
    /// chrome is hidden, so the prototype gets every pixel).
    pub fn view_canvas(&self) -> Rect {
        if self.flow.is_some() {
            Rect::new(0.0, 0.0, self.win_w, self.win_h)
        } else {
            self.editor_regions().canvas
        }
    }

    pub fn canvas_transform(&self) -> (f64, f64, f64) {
        let c = self.view_canvas();
        // rulers shrink the viewport (content starts after the strips);
        // the flow viewer paints no rulers
        let (dx, dy) = if self.rulers && self.flow.is_none() {
            (crate::theme::RULER_SIZE, crate::theme::RULER_SIZE)
        } else {
            (0.0, 0.0)
        };
        (c.x0 + self.pan.0 + dx, c.y0 + self.pan.1 + dy, self.zoom)
    }

    pub fn screen_to_world(&self, p: Point) -> Point {
        self.canvas_affine().inverse() * p
    }

    pub fn world_to_screen(&self, p: Point) -> Point {
        self.canvas_affine() * p
    }

    pub fn canvas_affine(&self) -> vello::kurbo::Affine {
        let (x, y, z) = self.canvas_transform();
        vello::kurbo::Affine::translate((x, y)) * vello::kurbo::Affine::scale(z)
    }

    // ------------------------------------------------------------- docs

    /// Guide being dragged (lives on the doc like the guide list).
    pub fn guide_drag(&mut self) -> &mut Option<(char, f64)> {
        &mut self.doc().guide_drag
    }

    /// Immutable document access (paint paths).
    pub fn doc_ref(&self) -> &OpenDoc {
        self.docs
            .get(self.active)
            .expect("at least one doc is open")
    }

    pub fn doc(&mut self) -> &mut OpenDoc {
        if self.docs.is_empty() {
            self.docs.push(OpenDoc::new_blank("Untitled".into()));
            self.active = 0;
        }
        let a = self.active.min(self.docs.len() - 1);
        &mut self.docs[a]
    }

    pub fn doc_opt(&self) -> Option<&OpenDoc> {
        self.docs.get(self.active)
    }

    /// Check if current document is a Board (infinite canvas)
    pub fn is_board(&self) -> bool {
        self.doc_opt().is_some_and(|d| d.board_doc.is_some())
    }

    /// Get board document reference
    pub fn board_doc(&self) -> &x_board::BoardDocument {
        self.doc_opt()
            .and_then(|d| d.board_doc.as_ref())
            .expect("board_doc called when not in board mode")
    }

    /// Get mutable board document reference
    pub fn board_doc_mut(&mut self) -> &mut x_board::BoardDocument {
        self.doc()
            .board_doc
            .as_mut()
            .expect("board_doc_mut called when not in board mode")
    }

    /// Board-specific regions (no side panels for infinite canvas)
    pub fn board_regions(&self) -> BoardRegions {
        BoardRegions {
            canvas: Rect::new(0.0, ED_TITLE_H, self.win_w, self.win_h),
        }
    }

    /// Board canvas transform (pan/zoom for infinite canvas)
    pub fn board_canvas_transform(&self) -> (f64, f64, f64) {
        let r = self.board_regions();
        (
            r.canvas.x0 + self.pan.0,
            r.canvas.y0 + self.pan.1,
            self.zoom,
        )
    }

    /// Hit test board nodes at a world-space point
    pub fn hit_test_board_node(&self, point: Point) -> Option<String> {
        let doc = self.board_doc();
        let page = doc.pages.first()?;

        // Check nodes in reverse order (top-most first)
        for node in page.nodes.iter().rev() {
            let bbox = node.bounding_box();
            if bbox.contains(point) {
                return Some(node.id().clone());
            }
        }

        None
    }

    /// Get current board tool from the active tool
    pub fn board_tool(&self) -> x_board::BoardTool {
        match self.tool {
            Tool::Select => x_board::BoardTool::Select,
            Tool::BoardSticky => x_board::BoardTool::StickyNote,
            Tool::BoardConnector => x_board::BoardTool::Connector,
            Tool::Pen => x_board::BoardTool::Pen,
            Tool::BoardRect => x_board::BoardTool::Rectangle,
            Tool::BoardCircle => x_board::BoardTool::Circle,
            Tool::Text => x_board::BoardTool::Text,
            Tool::Hand => x_board::BoardTool::Hand,
            _ => x_board::BoardTool::Select,
        }
    }

    /// Alignment-card click: align selection, remember the chosen dot.
    pub fn apply_align(&mut self, row: usize, col: usize) {
        self.align = (row, col);
        let doc = self.doc();
        doc.editor().align_selection(col, row);
        self.mark_dirty();
    }

    /// Eye (lock=false) / padlock (lock=true) toggle on the selection.
    pub fn apply_toggle(&mut self, lock: bool) {
        let doc = self.doc();
        if let Some(id) = doc.editor_ref().selection.first().cloned() {
            let (locked, visible) = {
                let root = &doc.editor_ref().root;
                match crate::editor_ui::find_node(root, id.as_str()) {
                    Some(n) => (n.locked, n.visible),
                    None => return,
                }
            };
            if lock {
                doc.editor().set_locked(&id, !locked);
            } else {
                doc.editor().set_visible(&id, !visible);
            }
            self.mark_dirty();
        }
    }

    // ------------------------------------------------------- component
    // properties (A2): masters define, instances edit

    /// Name of the Component master the selected node lives inside
    /// (None for top-level selections / non-master subtrees).
    pub fn selected_master_name(&self) -> Option<String> {
        let doc = self.doc_opt()?;
        let id = doc.selected_id()?;
        if id == doc.editor_ref().root.id {
            return None;
        }
        let mut cur = id;
        loop {
            let parent = x_native::editor::parent_id(&doc.editor_ref().root, &cur)?;
            let node = crate::editor_ui::find_node(&doc.editor_ref().root, &parent)?;
            if let x_native::NodeKind::Component { name } = &node.kind {
                return Some(name.clone());
            }
            cur = parent;
        }
    }

    /// The selected instance node's (id, component) pair.
    pub fn selected_instance(&self) -> Option<(String, String)> {
        let doc = self.doc_opt()?;
        let id = doc.selected_id()?;
        match &crate::editor_ui::find_node(&doc.editor_ref().root, &id)?.kind {
            x_native::NodeKind::Instance { component } => Some((id, component.clone())),
            _ => None,
        }
    }

    /// Prop definitions of a component (empty when none).
    pub fn props_of(&self, component: &str) -> Vec<x_native::ComponentPropEntry> {
        self.doc_opt()
            .map(|d| {
                d.doc
                    .component_props
                    .get(component)
                    .cloned()
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    /// Convert stored entries into the override pipeline's registry.
    fn registry_of(
        component: &str,
        entries: &[x_native::ComponentPropEntry],
    ) -> x_native::components::PropRegistry {
        use x_native::components::ComponentProp as P;
        let mut reg = x_native::components::PropRegistry::default();
        let list = entries
            .iter()
            .map(|e| match e.kind {
                x_native::ComponentPropKind::Text => P::Text {
                    name: e.name.clone(),
                    target: e.target.clone(),
                    default: e.default.clone(),
                },
                x_native::ComponentPropKind::Bool => P::Bool {
                    name: e.name.clone(),
                    target: e.target.clone(),
                    default: e.default == "true",
                },
                x_native::ComponentPropKind::Swap => P::Swap {
                    name: e.name.clone(),
                    target: e.target.clone(),
                    default: e.default.clone(),
                },
            })
            .collect();
        reg.props.insert(component.to_string(), list);
        reg
    }

    /// Apply a prop value to an instance as a typed override (the same
    /// pipeline the renderer consumes for visibility/text/swap).
    pub fn apply_prop(
        &mut self,
        instance_id: &str,
        component: &str,
        prop_name: &str,
        value: &str,
    ) -> bool {
        let entries = self.props_of(component);
        if entries.is_empty() {
            return false;
        }
        let reg = Self::registry_of(component, &entries);
        let doc = self.doc();
        let applied = match x_native::editor::find(&doc.editor_ref().root, instance_id).cloned() {
            Some(mut node) if matches!(node.kind, x_native::NodeKind::Instance { .. }) => {
                reg.apply(component, &mut node, prop_name, value)
                    && doc.editor().replace_node(instance_id, node)
            }
            _ => false,
        };
        if applied {
            self.mark_dirty();
        }
        applied
    }

    /// Current effective value of a prop on an instance (override, else
    /// the definition's default) — for display.
    pub fn instance_prop_value(
        &self,
        instance_id: &str,
        e: &x_native::ComponentPropEntry,
    ) -> String {
        let doc = match self.doc_opt() {
            Some(d) => d,
            None => return e.default.clone(),
        };
        let node = match crate::editor_ui::find_node(&doc.editor_ref().root, instance_id) {
            Some(n) => n,
            None => return e.default.clone(),
        };
        let t = x_native::components::typed_overrides(node);
        match t.get(&e.target) {
            Some(x_native::components::OverrideValue::Text(s)) => s.clone(),
            Some(x_native::components::OverrideValue::Visible(b)) => b.to_string(),
            Some(x_native::components::OverrideValue::Swap(s)) => s.clone(),
            _ => e.default.clone(),
        }
    }

    /// Define a new prop on the selected node's master, binding the
    /// selected node as target (Figma's "use selection as property").
    pub fn add_prop(&mut self, kind: x_native::ComponentPropKind) {
        let Some(component) = self.selected_master_name() else {
            return;
        };
        let (id, name) = {
            let doc = self.doc();
            let id = match doc.selected_id() {
                Some(i) => i,
                None => return,
            };
            match crate::editor_ui::find_node(&doc.editor_ref().root, &id) {
                Some(n) => (id.clone(), n.name.clone()),
                None => return,
            }
        };
        // unique prop name (node name, then " 2", " 3", …)
        let doc = self.doc();
        let mut prop_name = name.clone();
        let mut n = 2;
        while doc
            .doc
            .component_props
            .get(&component)
            .map(|l| l.iter().any(|e| e.name == prop_name))
            .unwrap_or(false)
        {
            prop_name = format!("{name} {n}");
            n += 1;
        }
        // read the text default BEFORE borrowing the props list mutably
        let default = match kind {
            x_native::ComponentPropKind::Text => {
                let doc = self.doc();
                match crate::editor_ui::find_node(&doc.editor_ref().root, &id) {
                    Some(x_native::Node {
                        kind: x_native::NodeKind::Text { text },
                        ..
                    }) => text.clone(),
                    _ => String::new(),
                }
            }
            x_native::ComponentPropKind::Bool => "true".into(),
            x_native::ComponentPropKind::Swap => {
                // default = the component the bound node already instantiates
                let doc = self.doc();
                match crate::editor_ui::find_node(&doc.editor_ref().root, &id) {
                    Some(x_native::Node {
                        kind: x_native::NodeKind::Instance { component },
                        ..
                    }) => component.clone(),
                    _ => String::new(),
                }
            }
        };
        let doc = self.doc();
        doc.checkpoint();
        let list = doc.doc.component_props.entry(component).or_default();
        list.push(x_native::ComponentPropEntry {
            name: prop_name,
            target: id,
            kind,
            default,
        });
        self.mark_dirty();
    }

    /// Commit the component-property text field (App-level single path so
    /// tests can drive it without a window; mirrors commit_page_rename).
    pub fn commit_instance_prop(&mut self, raw: &str) {
        if let (Some((iid, comp)), Some(name)) =
            (self.selected_instance(), self.instance_prop_target.clone())
        {
            self.apply_prop(&iid, &comp, &name, raw);
        }
        self.instance_prop_target = None;
    }

    pub fn remove_prop(&mut self, component: &str, name: &str) {
        let doc = self.doc();
        if !doc
            .doc
            .component_props
            .get(component)
            .is_some_and(|l| l.iter().any(|e| e.name == name))
        {
            return;
        }
        doc.checkpoint();
        if let Some(list) = doc.doc.component_props.get_mut(component) {
            list.retain(|e| e.name != name);
        }
        self.mark_dirty();
    }

    /// Cycle a Swap prop through every master component in the document.
    pub fn cycle_swap(&mut self, instance_id: &str, component: &str, prop_name: &str) {
        let entries = self.props_of(component);
        let Some(e) = entries.iter().find(|e| e.name == prop_name) else {
            return;
        };
        // candidates: every Component master in the document (sorted)
        let doc = self.doc();
        let mut masters: Vec<String> = Vec::new();
        fn walk(n: &x_native::Node, out: &mut Vec<String>) {
            if let x_native::NodeKind::Component { name } = &n.kind {
                out.push(name.clone());
            }
            for c in &n.children {
                walk(c, out);
            }
        }
        walk(&doc.editor_ref().root.clone(), &mut masters);
        masters.sort();
        if masters.is_empty() {
            return;
        }
        let cur = self.instance_prop_value(instance_id, e);
        let idx = masters
            .iter()
            .position(|m| *m == cur)
            .map(|i| i + 1)
            .unwrap_or(0);
        let next = masters[idx % masters.len()].clone();
        self.apply_prop(instance_id, component, prop_name, &next);
    }

    pub fn reset_instance_props(&mut self, instance_id: &str) {
        let doc = self.doc();
        doc.editor().reset_instance_overrides(instance_id);
        self.mark_dirty();
    }

    /// Commit a page rename (single source of truth for the pages-panel
    /// inline field). Empty names are ignored.
    /// The selected node's own auto-layout (None unless it is a Frame
    /// carrying one).
    pub fn selected_layout(&self) -> Option<x_native::AutoLayout> {
        let doc = self.doc_opt()?;
        let id = doc.selected_id()?;
        match &crate::editor_ui::find_node(&doc.editor_ref().root, &id)?.kind {
            x_native::NodeKind::Frame { layout } => layout.clone(),
            _ => None,
        }
    }

    /// Does the selected node's PARENT carry an auto-layout? (gates the
    /// per-child Fill/Absolute controls)
    pub fn selected_parent_has_layout(&self) -> bool {
        let Some(doc) = self.doc_opt() else {
            return false;
        };
        let Some(id) = doc.selected_id() else {
            return false;
        };
        fn has_al(n: &x_native::Node) -> bool {
            matches!(n.kind, x_native::NodeKind::Frame { layout: Some(_) })
        }
        if has_al(&doc.editor_ref().root) {
            return true;
        }
        fn walk(n: &x_native::Node, id: &str, out: &mut bool) {
            if *out {
                return;
            }
            for c in &n.children {
                if c.id == id {
                    *out = has_al(n);
                    return;
                }
                walk(c, id, out);
                if *out {
                    return;
                }
            }
        }
        let mut out = false;
        walk(&doc.editor_ref().root, &id, &mut out);
        out
    }

    /// Apply `f` to the selected frame's auto-layout (creating a default
    /// one when absent) and re-solve — ONE undo step. Shell fields flow /
    /// gap / padding are the source of truth for those keys; everything
    /// else (wrap, sizing, distribute, align, grid) is preserved.
    pub fn modify_selected_layout(&mut self, f: impl FnOnce(&mut x_native::AutoLayout)) {
        let (id, vars, mut layout, had) = {
            let doc = self.doc();
            let id = match doc.selected_id() {
                Some(i) => i,
                None => return,
            };
            let vars = doc.doc.variables.clone();
            let cur = self.selected_layout();
            (id, vars, cur.clone().unwrap_or_default(), cur.is_some())
        };
        let _ = had;
        f(&mut layout);
        let doc = self.doc();
        doc.editor().set_auto_layout(&id, Some(layout), &vars);
        self.mark_dirty();
    }

    /// Apply `f` to the selected node's ChildConstraints (parent must
    /// carry the auto-layout) and re-solve the parent.
    pub fn modify_child_constraints(&mut self, f: impl FnOnce(&mut x_native::ChildConstraints)) {
        let (id, vars, mut con) = {
            let doc = self.doc();
            let id = match doc.selected_id() {
                Some(i) => i,
                None => return,
            };
            fn find_con(n: &x_native::Node, id: &str) -> Option<x_native::ChildConstraints> {
                for c in &n.children {
                    if c.id == id {
                        return Some(c.constraints.clone());
                    }
                    if let Some(x) = find_con(c, id) {
                        return Some(x);
                    }
                }
                None
            }
            let con = find_con(&doc.editor_ref().root.clone(), &id).unwrap_or_default();
            (id, doc.doc.variables.clone(), con)
        };
        f(&mut con);
        let doc = self.doc();
        doc.editor().set_child_constraints(&id, con, &vars);
        self.mark_dirty();
    }

    pub fn commit_page_rename(&mut self, raw: &str) -> bool {
        let raw = raw.trim().to_string();
        if raw.is_empty() {
            return false;
        }
        {
            let doc = self.doc();
            if doc.editor_ref().root.name == raw {
                return false;
            }
            doc.checkpoint();
            let i = doc.page;
            if let Some(p) = doc.doc.pages.get_mut(i) {
                p.name = raw.clone();
            }
            if let Some(e) = doc.editors.get_mut(i) {
                e.root.name = raw;
            }
        }
        self.mark_dirty();
        true
    }

    pub fn page_menu_cmd(&mut self, cmd: PageMenuCmd) {
        self.page_menu = None;
        match cmd {
            PageMenuCmd::Rename => {
                let name = {
                    let doc = self.doc();
                    doc.doc
                        .pages
                        .get(doc.page)
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| format!("Page {}", doc.page + 1))
                };
                self.field_select_all = true;
                self.field = Some(FieldEdit {
                    id: FieldId::PageName,
                    buffer: name,
                });
            }
            PageMenuCmd::Duplicate => {
                {
                    let doc = self.doc();
                    doc.checkpoint();
                    let n = doc.editors.len() + 1;
                    let mut page = doc
                        .doc
                        .pages
                        .get(doc.page)
                        .cloned()
                        .unwrap_or_else(|| Node::frame(&format!("page-{n}"), 1440.0, 1024.0));
                    page.name = format!("{} copy", page.name);
                    let mut names: HashSet<String> =
                        doc.doc.component_props.keys().cloned().collect();
                    fn names_in(n: &Node, out: &mut HashSet<String>) {
                        if let x_native::NodeKind::Component { name } = &n.kind {
                            out.insert(name.clone());
                        }
                        for c in &n.children {
                            names_in(c, out);
                        }
                    }
                    for p in &doc.doc.pages {
                        names_in(p, &mut names);
                    }
                    let components = crate::clipboard::rename_components(&mut page, &mut names);
                    let ids = x_native::remap_node_ids(&mut page, |_| x_native::fresh_id("node"));
                    for (old, new) in components {
                        if let Some(props) = doc.doc.component_props.get(&old).cloned() {
                            let props = props
                                .into_iter()
                                .map(|mut p| {
                                    if let Some(id) = ids.get(&p.target) {
                                        p.target = id.clone();
                                    }
                                    p
                                })
                                .collect();
                            doc.doc.component_props.insert(new, props);
                        }
                    }
                    let ed = x_native::editor::Editor::new(page.clone());
                    let at = (doc.page + 1).min(doc.editors.len());
                    doc.editors.insert(at, ed);
                    doc.doc.pages.insert(at, page);
                    for c in &mut doc.doc.comments {
                        if c.page >= at {
                            c.page += 1;
                        }
                    }
                    doc.page = at;
                }
                self.mark_dirty();
            }
            PageMenuCmd::Delete => {
                let mut deleted = false;
                {
                    let doc = self.doc();
                    if doc.editors.len() > 1 {
                        doc.checkpoint();
                        let i = doc.page;
                        doc.editors.remove(i);
                        doc.doc.pages.remove(i);
                        doc.doc.comments.retain(|c| c.page != i);
                        for c in &mut doc.doc.comments {
                            if c.page > i {
                                c.page -= 1;
                            }
                        }
                        doc.page = doc.page.min(doc.editors.len() - 1);
                        deleted = true;
                    }
                }
                if deleted {
                    self.mark_dirty();
                }
            }
            PageMenuCmd::MoveUp => {
                let moved = {
                    let doc = self.doc();
                    if doc.page > 0 {
                        doc.checkpoint();
                        let i = doc.page;
                        doc.editors.swap(i - 1, i);
                        doc.doc.pages.swap(i - 1, i);
                        crate::session::swap_comment_pages(&mut doc.doc, i - 1, i);
                        doc.page = i - 1;
                        true
                    } else {
                        false
                    }
                };
                if moved {
                    self.mark_dirty();
                }
            }
            PageMenuCmd::MoveDown => {
                let moved = {
                    let doc = self.doc();
                    if doc.page + 1 < doc.editors.len() {
                        doc.checkpoint();
                        let i = doc.page;
                        doc.editors.swap(i, i + 1);
                        doc.doc.pages.swap(i, i + 1);
                        crate::session::swap_comment_pages(&mut doc.doc, i, i + 1);
                        doc.page = i + 1;
                        true
                    } else {
                        false
                    }
                };
                if moved {
                    self.mark_dirty();
                }
            }
        }
    }

    pub fn apply_ctx(&mut self, cmd: CtxCmd) {
        use CtxCmd::*;
        match cmd {
            Copy => {
                self.copy_nodes();
                return;
            }
            CopyAsCode => {
                self.copy_selection_as_code();
                return;
            }
            SelectAll => {
                self.doc().editor().select_all();
                return;
            }
            Cut => {
                if !self.copy_nodes() {
                    return;
                }
                self.doc().editor().delete_selection();
                self.mark_dirty();
                return;
            }
            Paste => {
                self.paste_nodes();
                return;
            }
            _ => {}
        }
        // Shape Builder refusals are reported here, after the `doc` borrow
        // ends — the status bar belongs to the app, not the document.
        let mut refusal: Option<String> = None;
        let doc = self.doc();
        match cmd {
            Copy | Cut | Paste => unreachable!("clipboard handled above"),
            CopyAsCode => unreachable!("copy handled above"),
            Duplicate => {
                doc.editor().duplicate_selection((12.0, 12.0));
            }
            ToFront => {
                let id = doc.selected_id().clone();
                if let Some(id) = id {
                    doc.editor().bring_to_front(&id);
                }
            }
            ToBack => {
                let id = doc.selected_id().clone();
                if let Some(id) = id {
                    doc.editor().send_to_back(&id);
                }
            }
            Delete => doc.editor().delete_selection(),
            SelectAll => unreachable!("selection handled above"),
            Group => {
                doc.editor().group_selection(&x_native::fresh_id("group"));
            }
            Ungroup => {
                let id = doc.editor_ref().selection.first().cloned();
                if let Some(id) = id {
                    doc.editor().ungroup(&id);
                }
            }
            MakeComponent => {
                let n = doc.editor().component_names().len() + 1;
                doc.editor().make_component(&format!("Component {n}"));
            }
            Union | Subtract | Intersect | Exclude => {
                use x_native::booleans::BoolOp as B;
                use x_native::editor::{
                    ShapeBuilderOp as SbOp, DEFAULT_MIN_OVERLAP as MIN_OVERLAP,
                };
                let op = match cmd {
                    CtxCmd::Union => B::Union,
                    CtxCmd::Subtract => B::Subtract,
                    CtxCmd::Intersect => B::Intersect,
                    _ => B::Exclude,
                };
                // Union/Subtract go through the Shape Builder, which measures
                // the overlap first and refuses with a reason: merging two
                // shapes that never touch produced a compound path of two
                // unrelated islands, and subtracting a shape that fully
                // covers the other just deleted a layer. Intersect/Exclude
                // keep the raw boolean — an empty result IS their answer.
                let shape_builder = match op {
                    B::Union => Some(SbOp::Merge),
                    B::Subtract => Some(SbOp::Subtract),
                    _ => None,
                };
                match shape_builder {
                    Some(sb) => match doc.editor().shape_builder_selected(sb, MIN_OVERLAP) {
                        Ok(_) => {}
                        Err(issue) => refusal = Some(issue.message()),
                    },
                    None => {
                        doc.editor().boolean_selected(op);
                    }
                }
            }
            BringFwd => {
                if let Some(id) = doc.selected_id().clone() {
                    doc.editor().bring_forward(&id);
                }
            }
            SendBack => {
                if let Some(id) = doc.selected_id().clone() {
                    doc.editor().send_backward(&id);
                }
            }
            LockSel => {
                if let Some(id) = doc.selected_id().clone() {
                    let locked = {
                        let root = &doc.editor_ref().root;
                        crate::editor_ui::find_node(root, &id)
                            .map(|n| n.locked)
                            .unwrap_or(false)
                    };
                    doc.editor().set_locked(&id, !locked);
                }
            }
            HideSel => {
                if let Some(id) = doc.selected_id().clone() {
                    doc.editor().set_visible(&id, false);
                }
            }
        }
        if let Some(msg) = refusal {
            self.status = msg;
        }
        self.mark_dirty();
    }

    // --------------------------------------------------- dev mode
    // (C21): the INSPECT tab's code view over the existing devmode
    // generators (CSS / SwiftUI / Compose / XML)

    pub const INSPECT_PLATFORMS: [&str; 4] = ["CSS", "SwiftUI", "Compose", "XML"];

    /// Code for the current selection in the current INSPECT platform
    /// (empty string when nothing is selected).
    pub fn inspect_code(&self) -> String {
        let doc = match self.doc_opt() {
            Some(d) => d,
            None => return String::new(),
        };
        let Some(id) = doc.selected_id() else {
            return String::new();
        };
        let Some(n) = crate::editor_ui::find_node(&doc.editor_ref().root, &id) else {
            return String::new();
        };
        match self.inspect_platform {
            1 => x_native::editor::node_to_swift(n, &doc.doc.variables),
            2 => x_native::editor::node_to_compose(n, &doc.doc.variables),
            3 => x_native::editor::node_to_xml(n, &doc.doc.variables),
            _ => x_native::editor::node_to_css(n, &doc.doc.variables),
        }
    }

    // ------------------------------------------------------- comments
    // (C18): pins on the active page, composer + thread handled by the
    // editor shell's key/press paths

    /// Post a comment pin at world (x, y) on the ACTIVE page.
    pub fn post_comment(&mut self, x: f64, y: f64, text: &str) -> String {
        let doc = self.doc();
        let id = x_native::fresh_id("comment");
        doc.checkpoint();
        doc.doc.comments.push(x_native::Comment {
            id: id.clone(),
            page: doc.page,
            x,
            y,
            author: USER_NAME.to_string(),
            text: text.to_string(),
            resolved: false,
        });
        self.mark_dirty();
        id
    }

    pub fn resolve_comment(&mut self, id: &str, resolved: bool) {
        let doc = self.doc();
        if !doc
            .doc
            .comments
            .iter()
            .any(|c| c.id == id && c.resolved != resolved)
        {
            return;
        }
        doc.checkpoint();
        if let Some(c) = doc.doc.comments.iter_mut().find(|c| c.id == id) {
            c.resolved = resolved;
        }
        self.mark_dirty();
    }

    pub fn delete_comment(&mut self, id: &str) {
        let doc = self.doc();
        if !doc.doc.comments.iter().any(|c| c.id == id) {
            return;
        }
        doc.checkpoint();
        doc.doc.comments.retain(|c| c.id != id);
        self.mark_dirty();
    }

    /// Screen-space rect of a comment's avatar pin (24px circle anchored
    /// so the pin's top-left sits 12px right / 24px above the anchor,
    /// like Figma's cursor-tag offset).
    pub fn comment_pin_rect(&self, id: &str) -> Option<Rect> {
        let doc = self.doc_opt()?;
        let c = doc.doc.comments.iter().find(|c| c.id == id)?;
        if c.page != doc.page {
            return None;
        }
        let p = self.world_to_screen(Point::new(c.x, c.y));
        Some(Rect::new(p.x, p.y - 24.0, p.x + 24.0, p.y))
    }

    /// Topmost comment pin under a screen point (24px avatar, 6px slack).
    pub fn comment_at(&self, p: Point) -> Option<String> {
        let doc = self.doc_opt()?;
        let ids: Vec<String> = doc
            .doc
            .comments
            .iter()
            .filter(|c| c.page == doc.page)
            .map(|c| c.id.clone())
            .collect();
        for id in ids.iter().rev() {
            if let Some(mut r) = self.comment_pin_rect(id) {
                r.x0 -= 6.0;
                r.y0 -= 6.0;
                r.x1 += 6.0;
                r.y1 += 6.0;
                if r.contains(p) {
                    return Some(id.clone());
                }
            }
        }
        None
    }

    /// B13 "Copy as code": the selection (top-level picked nodes only —
    /// children shadowed by an also-selected ancestor) as JSX. Writes the
    /// system clipboard (best-effort; headless test runs have no display)
    /// and the status line; returns the code for tests.
    pub fn copy_selection_as_code(&mut self) -> Option<String> {
        let picked: Vec<x_native::Node> = {
            let doc = self.doc();
            let sel = doc.editor_ref().selection.clone();
            let root = &doc.editor_ref().root;
            let mut out = Vec::new();
            for id in &sel {
                // skip nodes whose ancestor is selected too (the subtree
                // already carries them)
                let mut cur = id.clone();
                let mut shadowed = false;
                while let Some(p) = x_native::editor::parent_id(root, &cur) {
                    if sel.contains(&p) {
                        shadowed = true;
                        break;
                    }
                    cur = p;
                }
                if shadowed {
                    continue;
                }
                if let Some(n) = crate::editor_ui::find_node(root, id) {
                    out.push(n.clone());
                }
            }
            out
        };
        if picked.is_empty() {
            return None;
        }
        let code = x_native::fileio::selection_to_jsx(&picked);
        let bytes = code.len();
        let sys = push_system_clipboard(&code);
        self.last_copied_code = Some(code.clone());
        self.status = if sys {
            format!("Copied {bytes} chars of JSX to the clipboard")
        } else {
            format!("Copied {bytes} chars of JSX")
        };
        Some(code)
    }

    pub fn open_blank(&mut self) {
        let n = self.docs_count_untitled();
        self.docs.push(OpenDoc::new_blank(format!("Untitled{n}")));
        self.active = self.docs.len() - 1;
        self.screen = Screen::Editor;
        self.center_view();
    }

    /// Open a new blank Board document (infinite canvas for brainstorming)
    pub fn open_blank_board(&mut self) {
        use x_board::{BoardDocument, BoardKind};
        let n = self.docs_count_untitled();
        let board_doc = BoardDocument::new(&format!("Board {}", n), BoardKind::Brainstorm);

        // Create OpenDoc with board_doc set
        let mut od = OpenDoc::new_blank(format!("Board {}", n));
        od.board_doc = Some(board_doc);

        self.docs.push(od);
        self.active = self.docs.len() - 1;
        // Board documents use the board scene and board input state. The old
        // path opened them in the artboard editor, which made the visible
        // board toolbar look active while clicks still hit design-canvas code.
        self.screen = Screen::Board;
        self.center_view();
    }

    /// Import a Figma document (from clipboard or file) into the current page.
    /// Used for direct Figma copy-paste functionality.
    pub fn import_figma_document(&mut self, figma_doc: x_native::Document) {
        // Merge variables, styles, assets from Figma doc
        let target = self.doc();

        // Merge variables
        for (name, var) in &figma_doc.variables.colors {
            if !target.doc.variables.colors.contains_key(name) {
                target.doc.variables.colors.insert(name.clone(), *var);
            }
        }
        for (name, var) in &figma_doc.variables.numbers {
            if !target.doc.variables.numbers.contains_key(name) {
                target.doc.variables.numbers.insert(name.clone(), *var);
            }
        }
        for (name, var) in &figma_doc.variables.strings {
            if !target.doc.variables.strings.contains_key(name) {
                target
                    .doc
                    .variables
                    .strings
                    .insert(name.clone(), var.clone());
            }
        }
        for (name, var) in &figma_doc.variables.bools {
            if !target.doc.variables.bools.contains_key(name) {
                target.doc.variables.bools.insert(name.clone(), *var);
            }
        }

        // Merge assets
        for asset in figma_doc.assets.iter_sorted() {
            target.doc.assets.register(
                &asset.name,
                asset.bytes.clone(),
                x_native::AssetSource::Embedded,
            );
        }

        // Merge component definitions
        for page in &figma_doc.pages {
            for node in &page.children {
                if let x_native::NodeKind::Component { name: _ } = &node.kind {
                    // Add component to registry (hidden, like clipboard deps)
                    let mut comp = node.clone();
                    comp.visible = false;
                    target.doc.pages[target.page].children.push(comp);
                }
            }
        }

        // Copy visible nodes to current page with new IDs
        let mut id_map = std::collections::HashMap::new();
        for page in &figma_doc.pages {
            for node in &page.children {
                if matches!(&node.kind, x_native::NodeKind::Component { .. }) {
                    continue; // Skip component defs, already added
                }
                let mut new_node = node.clone();
                let old_id = new_node.id.clone();
                new_node.id = x_native::fresh_id("node");
                id_map.insert(old_id, new_node.id.clone());

                // Reset transform to place at canvas center
                new_node.transform =
                    x_native::Transform::from_affine(vello::kurbo::Affine::translate((50.0, 50.0)));

                target.doc.pages[target.page].children.push(new_node);
            }
        }

        // Update selection to newly pasted nodes
        let new_ids: Vec<String> = id_map.values().cloned().collect();
        if !new_ids.is_empty() {
            target.editor().selection = new_ids;
            target.frame_cache = x_native::FrameCache::new();
            target.finish_document_edit();
            self.status = format!("Pasted {} node(s) from Figma", id_map.len());
        }
    }

    fn docs_count_untitled(&self) -> usize {
        1 + self
            .docs
            .iter()
            .filter(|d| d.name.starts_with("Untitled") && d.path.is_none())
            .count()
    }

    pub fn close_doc(&mut self, idx: usize) {
        if idx >= self.docs.len() {
            return;
        }

        // QA-002 FIX: Add warning and user feedback when trying to close dirty docs
        // This should only be called after user confirms save/discard via request_close_doc()
        if self.docs[idx].dirty {
            eprintln!(
                "[BUG] close_doc() called on dirty document at index {}. \
                 Caller should use request_close_doc() to show save dialog.",
                idx
            );
            // Set status to inform the user if this is the active document
            if idx == self.active {
                self.status = format!(
                    "Cannot close '{}': Document has unsaved changes. \
                     Please save or discard changes first.",
                    self.docs[idx].name
                );
            }
            return;
        }

        let removed = self.docs.remove(idx);
        let _ = std::fs::remove_file(&removed.recovery_path);
        if let Some(path) = removed.path.as_ref() {
            x_native::fileio::clear_autosave(&path.to_string_lossy());
        }
        if self.active > idx {
            self.active -= 1;
        }
        if self.docs.is_empty() {
            self.screen = Screen::Dashboard;
            self.active = 0;
        } else {
            self.active = self.active.min(self.docs.len() - 1);
        }
    }

    /// Center the view on document content (first open: like the HTML —
    /// the 375x420 frame centered in the canvas with p-8 padding).
    pub fn center_view(&mut self) {
        let camera = crate::loading::ViewConfig::from_app(self).camera(self.doc_opt());
        self.zoom = camera.zoom;
        self.pan = camera.pan;
    }

    pub fn mark_dirty(&mut self) {
        if let Some(d) = self.docs.get_mut(self.active) {
            d.record_page_changes(self.drag.is_some());
            d.dirty = true;
        }
    }
}

pub struct EdRegions {
    pub left: Rect,
    pub nav_bar: Rect,
    pub sidebar: Rect,
    pub right: Rect,
    pub canvas: Rect,
}

pub struct BoardRegions {
    pub canvas: Rect,
}

// ------------------------------------------------------------ node helpers

/// Layer-type icon per the v45 mapping.
pub fn kind_icon(k: &NodeKind) -> &'static str {
    match k {
        NodeKind::Frame { .. } => "frame#",
        NodeKind::Rect { .. } => "square",
        NodeKind::Group | NodeKind::Section => "layout-grid",
        NodeKind::Text { .. } => "type",
        NodeKind::Ellipse => "circle",
        NodeKind::Vector { .. } | NodeKind::Arc { .. } | NodeKind::Line => "pen-tool",
        NodeKind::Component { .. } | NodeKind::Instance { .. } => "component",
        NodeKind::Image { .. } => "image",
        _ => "box",
    }
}

// ================================================================ UX Analysis (Quant-UX inspired)
// Deterministic, rule-based analysis - no AI/LLM calls.

impl App {
    /// Check WCAG AA/AAA contrast for all text layers
    pub fn run_ux_accessibility_check(&mut self) {
        let (root, vars) = {
            let doc = self.doc();
            (doc.editor_ref().root.clone(), doc.doc.variables.clone())
        };
        let mut issues = Vec::new();
        check_contrast_node(&root, &mut issues, &vars);

        let status = if issues.is_empty() {
            "No text layers found".to_string()
        } else {
            format!("A11Y: {}", issues.join(" | "))
        };
        self.status = status;
    }

    /// Analyze user flow from prototype connections
    pub fn run_ux_user_flow_analysis(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut frames = Vec::new();
        let mut connections = Vec::new();
        collect_flow_frames(&root, &mut frames, &mut connections);

        let status = format!(
            "FLOW: {} frames found, {} prototype connections",
            frames.len(),
            connections.len()
        );
        self.status = status;
    }

    /// Calculate design quality score based on alignment, spacing, naming
    pub fn run_ux_quality_score(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut score = 100.0;
        let mut feedback = Vec::new();
        evaluate_quality_node(&root, &mut score, &mut feedback);
        score = score.max(0.0);

        let grade = match score as u8 {
            90..=100 => "Excellent",
            75..=89 => "Good",
            60..=74 => "Fair",
            _ => "Needs Improvement",
        };

        let status = format!(
            "QUALITY: {} ({:.0}/100) - {}",
            grade,
            score,
            feedback.first().unwrap_or(&"No issues found".to_string())
        );
        self.status = status;
    }

    /// Review component usage patterns
    pub fn run_ux_interaction_patterns(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut components_used = std::collections::HashMap::new();
        count_component_uses(&root, &mut components_used);

        let total: usize = components_used.values().sum();
        let status = if total == 0 {
            "PATTERNS: No component instances found".to_string()
        } else {
            format!(
                "PATTERNS: {} component types used {} times total",
                components_used.len(),
                total
            )
        };
        self.status = status;
    }

    /// Verify text readability with detailed contrast analysis
    pub fn run_ux_color_contrast(&mut self) {
        // This is a more detailed version of accessibility check
        self.run_ux_accessibility_check();
        self.status = self.status.replace("A11Y:", "CONTRAST:");
        self.mark_dirty();
    }

    /// Test different screen sizes (mobile, tablet, desktop)
    pub fn run_ux_responsive_preview(&mut self) {
        let root = self.doc().editor_ref().root.clone();
        let mut frame_sizes = Vec::new();
        collect_frame_sizes(&root, &mut frame_sizes);

        let breakpoints = [
            ("Mobile", 375.0, 812.0),
            ("Tablet", 768.0, 1024.0),
            ("Desktop", 1440.0, 900.0),
        ];

        let mut matches = Vec::new();
        for (name, w, h) in &frame_sizes {
            for (bp_name, bp_w, bp_h) in &breakpoints {
                if (w - bp_w).abs() < 50.0 && (h - bp_h).abs() < 50.0 {
                    matches.push(format!("'{}' matches {} breakpoint", name, bp_name));
                }
            }
        }

        let status = if matches.is_empty() {
            format!(
                "RESPONSIVE: {} frames found. Consider creating Mobile (375x812), Tablet (768x1024), or Desktop (1440x900) artboards",
                frame_sizes.len()
            )
        } else {
            format!("RESPONSIVE: {}", matches.join(" | "))
        };
        self.status = status;
    }
}

fn collect_flow_frames(
    n: &x_native::Node,
    frames: &mut Vec<String>,
    connections: &mut Vec<(String, String)>,
) {
    if let x_native::NodeKind::Frame { .. } = &n.kind {
        frames.push(n.name.clone());
        // Check for prototype connections
        if let Some(interactions) = n.bindings.get("prototype:interactions") {
            connections.push((n.name.clone(), interactions.clone()));
        }
    }
    for child in &n.children {
        collect_flow_frames(child, frames, connections);
    }
}

fn evaluate_quality_node(n: &x_native::Node, score: &mut f64, feedback: &mut Vec<String>) {
    // Check naming convention
    if n.name.starts_with("Rectangle") || n.name.starts_with("Frame") || n.name.starts_with("Group")
    {
        *score -= 5.0;
        feedback.push(format!("Rename '{}' to something descriptive", n.name));
    }

    // Check for nested frames (potential auto-layout candidates)
    let frame_children: usize = n
        .children
        .iter()
        .filter(|c| matches!(c.kind, x_native::NodeKind::Frame { .. }))
        .count();
    if frame_children > 3 {
        *score -= 3.0;
        feedback.push(format!("Consider Auto Layout for '{}'", n.name));
    }

    for child in &n.children {
        evaluate_quality_node(child, score, feedback);
    }
}

fn count_component_uses(n: &x_native::Node, counts: &mut std::collections::HashMap<String, usize>) {
    if let x_native::NodeKind::Instance { component, .. } = &n.kind {
        *counts.entry(component.clone()).or_insert(0) += 1;
    }
    for child in &n.children {
        count_component_uses(child, counts);
    }
}

fn collect_frame_sizes(n: &x_native::Node, sizes: &mut Vec<(String, f64, f64)>) {
    if let x_native::NodeKind::Frame { .. } = &n.kind {
        sizes.push((n.name.clone(), n.w, n.h));
    }
    for child in &n.children {
        collect_frame_sizes(child, sizes);
    }
}

fn check_contrast_node(n: &x_native::Node, issues: &mut Vec<String>, vars: &x_native::Variables) {
    use x_native::{paint_color, Color, NodeKind};
    if let NodeKind::Text { .. } = &n.kind {
        let text_color = paint_color(&n.fill, vars);
        // Assume white background for simplicity (could be improved)
        let bg_color = Color::WHITE;
        let ratio = calculate_contrast_ratio(text_color, bg_color);

        if ratio < 4.5 {
            issues.push(format!(
                "'{}': Contrast ratio {:.2}:1 (needs 4.5:1 for AA)",
                n.name, ratio
            ));
        } else if ratio < 7.0 {
            issues.push(format!(
                "'{}': Contrast ratio {:.2}:1 (AA pass, AAA needs 7.0:1)",
                n.name, ratio
            ));
        } else {
            issues.push(format!("'{}': AAA compliant ({:.2}:1)", n.name, ratio));
        }
    }
    for child in &n.children {
        check_contrast_node(child, issues, vars);
    }
}

/// Calculate WCAG contrast ratio between two colors
fn calculate_contrast_ratio(fg: Color, bg: Color) -> f64 {
    let fg_luma = relative_luminance(fg);
    let bg_luma = relative_luminance(bg);

    let lighter = fg_luma.max(bg_luma);
    let darker = fg_luma.min(bg_luma);

    (lighter + 0.05) / (darker + 0.05)
}

/// Calculate relative luminance per WCAG 2.1
fn relative_luminance(c: Color) -> f64 {
    let rgba = c.to_rgba8();
    let rsrgb = rgba.r as f64 / 255.0;
    let gsrgb = rgba.g as f64 / 255.0;
    let bsrgb = rgba.b as f64 / 255.0;

    let r = if rsrgb <= 0.03928 {
        rsrgb / 12.92
    } else {
        ((rsrgb + 0.055) / 1.055).powf(2.4)
    };
    let g = if gsrgb <= 0.03928 {
        gsrgb / 12.92
    } else {
        ((gsrgb + 0.055) / 1.055).powf(2.4)
    };
    let b = if bsrgb <= 0.03928 {
        bsrgb / 12.92
    } else {
        ((bsrgb + 0.055) / 1.055).powf(2.4)
    };

    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Fill hex of a node (first fill layer, else `fill`), like the HTML's
/// FFFFFF field.
pub fn node_fill_hex(n: &Node, vars: &Variables) -> String {
    let color = match n.fill_layers.first() {
        Some(l) => x_native::paint_color(&l.paint, vars),
        None => x_native::paint_color(&n.fill, vars),
    };
    color_hex(color)
}

pub fn node_stroke_hex(n: &Node, vars: &Variables) -> String {
    match n.stroke_layers.first() {
        Some(l) => color_hex(x_native::paint_color(&l.stroke.paint, vars)),
        None => {
            if n.stroke.width > 0.0 {
                color_hex(x_native::paint_color(&n.stroke.paint, vars))
            } else {
                "000000".into()
            }
        }
    }
}

pub fn color_hex(c: Color) -> String {
    let rgba = c.to_rgba8();
    format!("{:02X}{:02X}{:02X}", rgba.r, rgba.g, rgba.b)
}

pub fn parse_hex(s: &str) -> Option<Color> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(Color::from_rgb8(r, g, b))
}

/// System clipboard, best-effort (headless/test runs have no display —
/// the code stays available through `App::last_copied_code`).
pub fn push_system_clipboard(text: &str) -> bool {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        cb.set_text(text.to_string()).is_ok()
    } else {
        false
    }
}

/// Try to get text content from system clipboard.
/// Returns None if clipboard is empty or inaccessible.
pub fn get_system_clipboard_text() -> Option<String> {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        cb.get_text().ok()
    } else {
        None
    }
}

/// Check if clipboard contains Figma JSON data.
/// Figma copies nodes as JSON when using Cmd+C/Ctrl+C in Figma.
pub fn try_import_from_figma_clipboard() -> Option<x_native::Document> {
    let clipboard_text = get_system_clipboard_text()?;

    // QA-001 FIX: Add early validation and debug logging
    // Early exit for empty or very short content
    if clipboard_text.trim().is_empty() || clipboard_text.len() < 10 {
        return None;
    }

    // Quick check: Figma JSON must start with '{' and contain "document"
    let trimmed = clipboard_text.trim();
    if !trimmed.starts_with('{') || !trimmed.contains("\"document\"") {
        // Not Figma format - could be plain text or other app's clipboard
        eprintln!("[CLIPBOARD] Content does not appear to be Figma JSON");
        return None;
    }

    // Try to parse as Figma JSON with better error reporting
    match x_native::fileio::import_figma_json(&clipboard_text) {
        Ok(doc) => {
            eprintln!("[CLIPBOARD] Successfully imported Figma document");
            Some(doc)
        }
        Err(e) => {
            eprintln!("[CLIPBOARD] Figma import failed: {}", e);
            // Provide more context about what went wrong
            if e.contains("no \"document\"") {
                eprintln!("[CLIPBOARD] Expected Figma REST API format with 'document' key");
            } else if e.contains("not a Figma REST JSON") {
                eprintln!("[CLIPBOARD] JSON structure doesn't match Figma format");
            }
            None
        }
    }
}

#[cfg(test)]
impl App {
    /// Explicit deterministic content for old inspector/screenshot fixtures.
    pub fn open_demo_blank(&mut self) {
        self.docs.push(OpenDoc::demo_blank("Demo".into()));
        self.active = self.docs.len() - 1;
        self.screen = Screen::Editor;
        self.center_view();
    }
}
