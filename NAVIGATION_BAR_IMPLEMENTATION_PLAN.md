# Navigation Bar & Left Sidebar Implementation Plan

## Current State Analysis

X-Native currently has:
- **Horizontal title bar** at the top with file tabs
- **Left panel** (280px) with:
  - DRAFTS header
  - File name (editable)
  - Pills: LAYERS / ASSETS / TOKENS
  - PAGES section
  - Layer tree with visibility/lock
- **Right panel** (340px) with DESIGN/PROTOTYPE/INSPECT/UX tabs

## What Figma Has (New Navigation Structure)

**Navigation Bar** (vertical left-most bar, ~48px wide):
1. **Figma Menu** - Hamburger menu with app commands
2. **Files Tab** - Pages and layers
3. **Agents Tab** - AI collaboration
4. **Assets Tab** - Components and libraries
5. **Tools Tab** - Plugins, widgets, shaders
6. **Variables View** - Variable management
7. **File Notifications** - Library updates, missing fonts

**Left Sidebar** (dynamic panel, resizable):
- Edit file menu (rename, version history, color profile, move)
- Pages panel (create, organize pages)
- Find/Replace (search entire file)
- Layers panel (with hover highlight, collapse all, bulk actions)
- Libraries modal (publish/import components)
- Resizable width (drag right edge)

## Implementation Plan

### Phase 1: Navigation Bar Structure
- [ ] Add vertical navigation bar on left (48px wide)
- [ ] Add menu icon (hamburger) at top
- [ ] Add tab icons: File, Agents, Assets, Tools, Variables, Notifications
- [ ] Add labels below icons (toggleable)
- [ ] Add keyboard shortcuts (⌥1-6 for tabs)

### Phase 2: File Tab Implementation
- [ ] Move current left panel content to sidebar
- [ ] Add edit file menu (3-dot menu next to file name)
- [ ] Add find/replace search bar at top
- [ ] Add "Collapse layers" button
- [ ] Make sidebar resizable

### Phase 3: Menu System
- [ ] Implement hamburger menu with:
  - File operations (New, Open, Save, Export)
  - Edit operations (Undo, Redo, Copy, Paste)
  - View options (Zoom, Grid, Rulers)
  - Preferences (Dark mode, Highlight layers on hover)
  - Help (Keyboard shortcuts, About)

### Phase 4: Agents Tab
- [ ] Add chat interface
- [ ] Implement message history
- [ ] Add "New chat" button
- [ ] Add chat access settings
- [ ] Integrate with AI backend

### Phase 5: Assets Tab
- [ ] Move current assets panel to sidebar
- [ ] Add libraries modal
- [ ] Add search/filter
- [ ] Add grid/list view toggle
- [ ] Add drag-to-canvas for instances
- [ ] Add library update indicators

### Phase 6: Tools Tab
- [ ] Add plugin browser
- [ ] Add widget browser
- [ ] Add shader browser
- [ ] Add search/filter
- [ ] Add "Created by X-Native" filter
- [ ] Add install/uninstall

### Phase 7: Variables View
- [ ] Add dedicated variables panel
- [ ] Make accessible from nav bar (not just tokens)
- [ ] Add collection management
- [ ] Add mode management
- [ ] Add variable editor

### Phase 8: File Notifications
- [ ] Add notification bell icon at bottom
- [ ] Add notification panel
- [ ] Implement library update notifications
- [ ] Implement missing font alerts
- [ ] Add offline status indicators

### Phase 9: UI Improvements
- [ ] Add minimize UI shortcut (⌘⇧\)
- [ ] Add auto-expand right panel on selection
- [ ] Add sidebar resize handle
- [ ] Add hover highlight toggle
- [ ] Add panel state persistence

### Phase 10: Polish & Integration
- [ ] Add smooth transitions
- [ ] Add tooltips
- [ ] Add keyboard navigation
- [ ] Add accessibility features
- [ ] Add state persistence

## Technical Architecture

### New Components

```rust
// Navigation bar
struct NavigationBar {
    active_tab: NavTab,
    show_labels: bool,
    notifications_count: usize,
}

enum NavTab {
    File,
    Agents,
    Assets,
    Tools,
    Variables,
}

// Left sidebar
struct LeftSidebar {
    width: f64,
    resizable: bool,
    content: SidebarContent,
}

enum SidebarContent {
    File(FileTab),
    Agents(AgentsTab),
    Assets(AssetsTab),
    Tools(ToolsTab),
    Variables(VariablesTab),
}

// Menu system
struct AppMenu {
    open: bool,
    items: Vec<MenuItem>,
}

struct MenuItem {
    label: String,
    shortcut: Option<String>,
    action: Action,
    separator: bool,
}

// Find/Replace
struct FindReplace {
    query: String,
    replace: String,
    case_sensitive: bool,
    in_selection: bool,
}

// Notifications
struct NotificationCenter {
    notifications: Vec<Notification>,
    unread_count: usize,
}

struct Notification {
    id: String,
    kind: NotificationKind,
    message: String,
    timestamp: u64,
    read: bool,
}

enum NotificationKind {
    LibraryUpdate,
    MissingFont,
    OfflineStatus,
    ComponentUpdate,
}
```

### New Actions

```rust
enum Action {
    // Navigation bar
    NavTab(NavTab),
    ToggleNavLabels,
    OpenMenu,
    CloseMenu,
    MenuAction(MenuItem),
    
    // Sidebar
    ResizeSidebar(f64),
    CollapseSidebar,
    ExpandSidebar,
    
    // Find/Replace
    OpenFind,
    CloseFind,
    FindNext,
    FindPrev,
    ReplaceAll,
    FindInSelection,
    ToggleCaseSensitive,
    
    // Menu items
    MenuNewFile,
    MenuOpenFile,
    MenuSave,
    MenuExport,
    MenuUndo,
    MenuRedo,
    MenuPreferences,
    MenuToggleDarkMode,
    MenuToggleHighlight,
    MenuShortcuts,
    MenuAbout,
    
    // Agents
    NewChat,
    SendChatMessage(String),
    ToggleChatAccess,
    
    // Assets
    OpenLibraries,
    ToggleAssetsView,
    ImportLibrary(String),
    UpdateLibrary(String),
    
    // Tools
    InstallPlugin(String),
    UninstallPlugin(String),
    RunPlugin(String),
    
    // Variables
    OpenVariablesView,
    CreateVariableCollection,
    CreateVariable,
    
    // Notifications
    OpenNotifications,
    MarkNotificationRead(String),
    MarkAllRead,
    DismissNotification(String),
}
```

## File Changes

### State Updates
- `apps/x-designer/src/bin/x_native_app/state.rs`
  - Add `NavigationBar` struct
  - Add `LeftSidebar` struct
  - Add `AppMenu` struct
  - Add `FindReplace` struct
  - Add `NotificationCenter` struct
  - Add new `Action` variants

### UI Rendering
- `apps/x-designer/src/bin/x_native_app/editor_ui.rs`
  - Add `paint_navigation_bar()` function
  - Add `paint_left_sidebar()` function (replace current left panel)
  - Add `paint_app_menu()` function
  - Add `paint_find_replace()` function
  - Add `paint_notifications()` function
  - Add tab-specific content renderers

### Event Handling
- `apps/x-designer/src/bin/x_native_app/run.rs`
  - Add navigation bar click handlers
  - Add menu interaction handlers
  - Add sidebar resize handlers
  - Add find/replace handlers
  - Add keyboard shortcuts

### Theme Updates
- `apps/x-designer/src/bin/x_native_app/theme.rs`
  - Add navigation bar colors
  - Add menu colors
  - Add notification colors
  - Add icon sizes and spacing

## Keyboard Shortcuts

| Action | Mac | Windows |
|--------|-----|---------|
| File tab | ⌥1 | Alt+1 |
| Assets tab | ⌥2 | Alt+2 |
| Tools tab | ⌥3 | Alt+3 |
| Variables tab | ⌥4 | Alt+4 |
| Find | ⌘F | Ctrl+F |
| Replace | ⌘H | Ctrl+H |
| Minimize UI | ⌘⇧\ | Ctrl+Shift+\ |
| Open menu | ⌘, | Ctrl+, |
| New chat | ⌘N | Ctrl+N |
| Toggle labels | ⌘⇧L | Ctrl+Shift+L |

## Visual Design

### Navigation Bar
- Width: 48px
- Background: #1A1A1A (dark) / #FFFFFF (light)
- Icon size: 20px
- Label font: 10px
- Active tab: Accent color background
- Hover: Subtle highlight

### Left Sidebar
- Min width: 200px
- Max width: 500px
- Default width: 280px
- Background: #1E1E1E (dark) / #F5F5F5 (light)
- Resize handle: 4px, visible on hover

### Menu
- Background: #2A2A2A (dark) / #FFFFFF (light)
- Border: 1px #3A3A3A
- Item height: 32px
- Separator: 1px line
- Shadow: 8px blur

## Testing Strategy

1. **Navigation Bar Tests**
   - Tab switching
   - Label toggle
   - Keyboard shortcuts
   - State persistence

2. **Sidebar Tests**
   - Resizing
   - Content switching
   - Collapse/expand
   - State persistence

3. **Menu Tests**
   - Open/close
   - Item selection
   - Keyboard navigation
   - Accessibility

4. **Find/Replace Tests**
   - Search functionality
   - Replace all
   - Case sensitivity
   - In selection toggle

5. **Notification Tests**
   - Notification display
   - Mark as read
   - Dismiss
   - Count updates

## Implementation Priority

1. **Critical** (Must have)
   - Navigation bar structure
   - File tab migration
   - Menu system
   - Find/Replace

2. **High** (Should have)
   - Agents tab
   - Assets tab enhancements
   - Variables view
   - Sidebar resizing

3. **Medium** (Nice to have)
   - Tools tab
   - Notifications
   - UI polish
   - Keyboard shortcuts

4. **Low** (Future)
   - Advanced features
   - Animations
   - Customization

## Migration Strategy

Since this is a major UI restructuring, we'll use a phased approach:

1. **Phase 1**: Add navigation bar alongside existing UI (hidden by default)
2. **Phase 2**: Implement all tabs in parallel
3. **Phase 3**: Add feature flag to switch between old/new UI
4. **Phase 4**: Test thoroughly
5. **Phase 5**: Make new UI default
6. **Phase 6**: Remove old UI code

## Success Criteria

- [ ] All navigation bar tabs functional
- [ ] Left sidebar resizable and collapsible
- [ ] Menu system with all actions
- [ ] Find/Replace working
- [ ] All keyboard shortcuts working
- [ ] Smooth transitions
- [ ] No regressions in existing features
- [ ] Performance maintained or improved
- [ ] Accessibility compliant
