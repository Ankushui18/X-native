# Navigation Bar & Left Sidebar Implementation

## Overview

This implementation adds Figma's new navigation bar and left sidebar structure to X-Native, matching the modern Figma UI paradigm.

## Architecture

### Visual Structure (left to right)
```
┌──────────────────────────────────────────────────────────────┐
│ Title Bar (36px)                                             │
├────┬─────────────────────┬──────────────────┬───────────────┤
│    │                     │                  │               │
│ N  │  Left Sidebar       │  Canvas          │  Right Panel  │
│ a  │  (280px)            │  (flexible)      │  (340px)      │
│ v  │                     │                  │               │
│    │  - DRAFTS           │                  │               │
│ B  │  - File Name        │                  │               │
│ a  │  - LAYERS/ASSETS    │                  │               │
│ r  │  - PAGES            │                  │               │
│    │  - Layer Tree       │                  │               │
│ 48 │                     │                  │               │
│ px │                     │                  │               │
│    │                     │                  │               │
├────┴─────────────────────┴──────────────────┴───────────────┤
```

### Navigation Bar (48px wide)
The leftmost vertical bar with:
1. **Hamburger Menu** — Opens the app menu dropdown
2. **Files Tab** (⌥1) — Pages and layers
3. **Agents Tab** (⌥2) — AI collaboration
4. **Assets Tab** (⌥3) — Components and libraries
5. **Tools Tab** (⌥4) — Plugins, widgets, shaders
6. **Variables Tab** (⌥5) — Variable management
7. **Notifications** — Bell icon with unread badge

### Left Sidebar (280px, resizable 200-500px)
Dynamic panel that changes based on the selected nav tab. For the "File" tab:
- DRAFTS header with project icon
- Editable file name
- Pill tabs: LAYERS / ASSETS / TOKENS
- PAGES section with page selector
- Layer tree with visibility/lock toggles
- Find/Replace search overlay

## Data Model Changes (state.rs)

### New Types
```rust
pub enum NavTab { File, Agents, Assets, Tools, Variables }
pub struct AppMenu { open: bool, hover_index: Option<usize> }
pub struct FindReplace {
    open: bool, show_replace: bool,
    query: String, replace: String,
    case_sensitive: bool, in_selection: bool,
    match_count: usize, current_match: usize,
}
pub struct NotificationCenter {
    open: bool, notifications: Vec<Notification>, unread_count: usize,
}
pub enum NotificationKind { LibraryUpdate, MissingFont, OfflineStatus, ComponentUpdate }
```

### New App Fields
```rust
nav_tab: NavTab,
nav_show_labels: bool,
nav_bar_w: f64,          // 48px
left_sidebar_w: f64,     // 280px
sidebar_resizing: bool,
ui_minimized: bool,
app_menu: AppMenu,
find_replace: FindReplace,
notifications: NotificationCenter,
left_sidebar_width: f64,
```

### New Actions
```rust
NavTab(NavTab),           // Switch nav bar tab
ToggleNavLabels,          // Show/hide tab labels
OpenAppMenu,              // Toggle hamburger menu
CloseAppMenu,
AppMenuItem(usize),       // Menu item selected
OpenFind, CloseFind,
FindNext, FindPrev,
ReplaceAll,
ToggleCaseSensitive,
ToggleFindInSelection,
ToggleNotifications,
DismissNotification(String),
MarkAllNotificationsRead,
ToggleMinimizeUI,         // ⌘⇧\ minimize all panels
ResizeLeftSidebar(f64),
CollapseAllLayers,
FileRename, FileMoveToDrafts, FileDuplicate,
```

### Editor Regions Update
```rust
pub struct EdRegions {
    pub left: Rect,     // Combined nav bar + sidebar
    pub nav_bar: Rect,  // 48px vertical rail
    pub sidebar: Rect,  // 280px content panel
    pub right: Rect,
    pub canvas: Rect,
}
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌥1 | Switch to Files tab |
| ⌥2 | Switch to Agents tab |
| ⌥3 | Switch to Assets tab |
| ⌥4 | Switch to Tools tab |
| ⌥5 | Switch to Variables tab |
| ⌘⇧\ | Toggle minimize UI |
| ⌘⇧F | Toggle Find/Replace |

## Files Modified

1. **state.rs** — New types, actions, and App fields
2. **editor_ui.rs** — New paint functions:
   - `paint_nav_bar()` — Vertical navigation rail
   - `paint_app_menu()` — Hamburger menu dropdown
   - `paint_find_replace()` — Search/replace panel
   - `paint_notifications()` — Notification panel
   - Updated `paint_left()` — Sidebar offset for nav bar
   - Updated `paint_resizers()` — New region boundaries
3. **run.rs** — Action handlers and keyboard shortcuts

## Implementation Notes

### Sidebar Coordinate Offset
The existing `paint_left()` function used absolute x-coordinates assuming the left panel started at x=0. With the nav bar, the sidebar starts at x=48 (nav_bar_w). A `sx` offset variable was added to shift all sidebar content appropriately.

### Icon Compatibility
The navigation bar icons use existing Lucide icons from the icon cache:
- File → `file`
- Agents → `sparkles`
- Assets → `component`
- Tools → `sliders-horizontal`
- Variables → `code`
- Notifications → `message-circle`

### UI Minimization
When `ui_minimized` is true, the sidebar is hidden, leaving only the 48px nav bar visible. This gives maximum canvas space, matching Figma's ⌘⇧\ behavior.

## Future Enhancements (Planned)

### Phase 2: Agents Tab
- Chat interface for AI collaboration
- Message history
- Chat access settings

### Phase 3: Assets Tab Enhanced
- Libraries modal
- Grid/list view toggle
- Drag-to-canvas instances
- Library update indicators

### Phase 4: Tools Tab
- Plugin browser
- Widget browser
- Shader browser
- Search/filter

### Phase 5: Variables View
- Dedicated variables panel
- Collection management
- Mode management
- Variable editor

### Phase 6: UI Polish
- Smooth panel transitions
- Sidebar resize handle with visual feedback
- Panel state persistence
- Accessibility improvements
