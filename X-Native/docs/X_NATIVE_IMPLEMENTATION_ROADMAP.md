# X-Native — Figma-Level Audit & Implementation Roadmap

## Executive Summary

X-Native already possesses a **strong foundation** with variables, components, auto layout, and rendering engines. The goal is **not to rewrite** but to:

1. **Stabilize** existing systems
2. **Complete** partially implemented features
3. **Connect** everything through a consistent native UI
4. **Validate** with comprehensive regression tests

---

## 🔴 P0 — Critical / Fix First

### P0.1 — Build & Code Integrity

**Status:** Requires verification

**Actions:**
- [ ] Resolve module/source inconsistencies
- [ ] Verify all referenced Rust modules exist
- [ ] Run full build pipeline:
  ```bash
  cargo fmt
  cargo check --workspace --all-targets
  cargo test --workspace
  cargo clippy --workspace --all-targets -- -D warnings
  cargo build --release -p x_native_app
  ```
- [ ] Ensure workspace builds cleanly before adding features

**Success Criteria:** Zero warnings, all tests pass, release build succeeds

---

### P0.2 — Consolidate Native UI Architecture

**Status:** Partially implemented

**Target Architecture:**
```
x-ui (Reusable Component Layer)
 ├── Button
 ├── IconButton
 ├── Input
 ├── Select
 ├── Toggle
 ├── SegmentedControl
 ├── Slider
 ├── PropertyField
 ├── ColorField
 ├── Toolbar
 ├── LayerRow
 ├── InspectorSection
 ├── ContextToolbar
 ├── Popup
 └── Tooltip
```

**Actions:**
- [ ] Make `x-ui` the single source of truth for UI components
- [ ] Remove remaining HTML/v45 architecture dependencies
- [ ] Avoid direct Vello UI painting in screens
- [ ] Ensure all screens use `x-ui` components exclusively

---

### P0.3 — Fix the Visual Token System

**Current Issue:** Scattered hex values, old blue/v45 color system still present

**Locked X-Native Token System:**

| Token | Value |
|-------|-------|
| Panel | `#1B1D23` |
| Primary Text | `#F2F3F7` |
| Secondary Text | `#9A9EAA` |
| Accent | `#7C5CFC` |
| Focus Ring | `#A996FF` |

**Required Semantic Tokens:**
```rust
// Background tokens
Background
Surface
Surface Elevated
Surface Hover
Surface Active

// Border tokens
Border
Border Strong

// Text tokens
Text Primary
Text Secondary
Text Disabled

// Accent tokens
Accent
Accent Hover
Accent Active
Focus

// State tokens
Selection
Success
Warning
Danger

// Canvas token
Canvas
```

**Actions:**
- [ ] Create semantic token system in `x-core/src/tokens.rs`
- [ ] Replace all hardcoded hex values with token references
- [ ] Add token validation (no random `#0099FF`, `#3B82F6`, etc.)
- [ ] Update `x-ui` components to use tokens exclusively

---

### P0.4 — Fix Variable Type Safety

**Current Status:** Foundation exists but type enforcement inconsistent

**Required Variable Types:**
```rust
enum VariableValue {
    Color(Color),
    Number(f64),
    String(String),
    Boolean(bool),
}
```

**Validation Requirements:**
- [ ] Type mismatch detection
- [ ] Invalid value validation
- [ ] Broken alias detection
- [ ] Missing variable detection
- [ ] Circular reference detection

**Actions:**
- [ ] Enforce strict typing in `crates/x-core/src/variables.rs`
- [ ] Add validation layer for all variable operations
- [ ] Create comprehensive test suite for edge cases

---

### P0.5 — Fix Variable Mode Handling

**Current Issue:** Invalid modes may silently preserve unrelated active mode

**Required Behavior:**
```rust
match mode {
    Valid(mode) => activate(mode),
    Invalid(mode) => return Error::UnknownMode(mode),
    Missing => apply_deterministic_fallback(),
}
```

**Actions:**
- [ ] Define explicit mode handling logic
- [ ] Add error reporting for invalid modes
- [ ] Implement deterministic fallback strategy
- [ ] Add regression tests for all mode scenarios

---

### P0.6 — Complete Component Property Types

**Required Property Types:**
```rust
enum ComponentPropertyType {
    Boolean,
    Text,
    Number,
    Color,
    InstanceSwap,
    Slot,
}
```

**Each Property Must Have:**
```rust
struct ComponentProperty {
    id: PropertyId,
    name: String,
    property_type: ComponentPropertyType,
    default_value: PropertyValue,
    description: Option<String>,
    target: Option<NodeId>,
    allowed_values: Option<Vec<PropertyValue>>,
    min_max: Option<(f64, f64)>, // For Number
    preferred_control: Option<ControlHint>,
}
```

**Actions:**
- [ ] Verify all property types fully supported in storage model
- [ ] Add validation for property constraints
- [ ] Ensure UI controls match property types correctly

---

### P0.7 — Fix MCP Capability Reporting

**Current Issue:** Tool capability reporting may be inaccurate

**Requirements:**
- [ ] Accurate MCP initialization advertising available tools
- [ ] Structured JSON responses (not just formatted text)
- [ ] Proper error handling in MCP responses

**Actions:**
- [ ] Audit `crates/x-mcp/` for capability declarations
- [ ] Convert all responses to structured JSON
- [ ] Add schema validation for MCP messages

---

### P0.8 — Inspector Must Use Undoable Commands

**Current Issue:** Direct state mutations may bypass undo/redo

**Required Flow:**
```
Inspector Change
       ↓
   Command
       ↓
Undo / Redo History
```

**Actions:**
- [ ] Audit inspector mutations for direct state changes
- [ ] Wrap all mutations in command pattern
- [ ] Ensure keyboard, toolbar, context menu, and command palette all use same command system
- [ ] Test undo/redo for all inspector operations

---

## 🟠 P1 — Figma-Level Feature & UX Parity

### P1.1 — Variables Enhancement

**Expand with:**
- [ ] Collections organization
- [ ] Multiple Modes support
- [ ] Full alias system
- [ ] Descriptions for all variables
- [ ] Scoping (global, local, component)
- [ ] Variable usage tracking
- [ ] Broken variable detection
- [ ] Circular reference detection
- [ ] Search functionality
- [ ] Rename/refactor support
- [ ] Bulk editing
- [ ] Import/export (W3C DTCG format)
- [ ] Light/Dark mode management UI

---

### P1.2 — Design Tokens System

**Build Token Hierarchy:**
```
Primitive Tokens (color.gray.900)
       ↓
Semantic Tokens (text.primary)
       ↓
Component Tokens (button.primary.label)
       ↓
Component Instances
```

**Add:**
- [ ] Token groups/namespaces
- [ ] Token descriptions
- [ ] Token aliases (token → token references)
- [ ] Token scopes
- [ ] Token usage tracking
- [ ] Unused token detection
- [ ] Broken token detection
- [ ] Token search
- [ ] Token → component mapping
- [ ] Token → code mapping
- [ ] Light/Dark modes
- [ ] Token validation/linting
- [ ] W3C DTCG import support

---

### P1.3 — Components System

**Strengthen:**
- [ ] Component creation workflow
- [ ] Component sets (variants container)
- [ ] Instance creation
- [ ] Nested instances
- [ ] Override system
- [ ] Reset overrides
- [ ] Variant switching
- [ ] Instance swapping
- [ ] Component properties (all types)
- [ ] Slot properties
- [ ] Boolean properties
- [ ] Text properties
- [ ] Number properties
- [ ] Color properties

---

### P1.4 — Component Property Binding

**Avoid Hardcoded Mappings:**
```rust
// ❌ Bad
if property.name == "width" { node.width = value }

// ✅ Good
ComponentProperty
       ↓
PropertyBinding {
    target_node: NodeId,
    target_attribute: AttributePath,
}
       ↓
Supports: Width, Height, Radius, Gap, Padding, 
         Opacity, Color, Stroke, FontSize, etc.
```

**Actions:**
- [ ] Create binding system architecture
- [ ] Support all common attributes
- [ ] Allow multiple bindings per property
- [ ] Validate binding targets
- [ ] UI for managing bindings

---

### P1.5 — Auto Layout Enhancement

**DO NOT REWRITE THE ENGINE** — existing foundation is strong

**Improve with:**
- [ ] Independent variable padding (per-side)
- [ ] Variable gap support
- [ ] Nested Auto Layout regression tests
- [ ] Hug + Fill combinations
- [ ] Fill + min/max constraints
- [ ] Wrap + grow/shrink behavior
- [ ] Baseline alignment
- [ ] Absolute children handling
- [ ] Component + Auto Layout combinations
- [ ] Layout debugging tools
- [ ] Visual Auto Layout inspection

**Regression Matrix:**
```
Fixed, Hug, Fill, Grow, Shrink, Wrap
Gap, Padding, Min/Max
Nested layouts, Absolute children
Grid, Baseline alignment
Variables integration
Components integration
```

---

### P1.6 — Pen Tool / Vector Editing

**Current:** Good foundation

**Add:**
- [ ] Better vector point editing
- [ ] Segment editing
- [ ] Corner radius controls
- [ ] Smooth/corner point conversion
- [ ] Curve handle manipulation
- [ ] Boolean operation robustness
- [ ] Stroke expansion fidelity
- [ ] Per-side strokes
- [ ] Variable-width strokes
- [ ] Better vector constraints
- [ ] Better vector selection UX
- [ ] Boolean operation preview

---

### P1.7 — Strokes Enhancement

**Add Per-Side Strokes:**
```rust
struct StrokeSettings {
    top: Option<Stroke>,
    right: Option<Stroke>,
    bottom: Option<Stroke>,
    left: Option<Stroke>,
}
```

**Also:**
- [ ] Variable-width strokes
- [ ] Better stroke alignment (inside/center/outside)
- [ ] Stroke presets library
- [ ] Stroke styles (reusable)

---

### P1.8 — Effects System

**Current:** Good foundation

**Priority: Effect Styles > Noise**

**Add:**
- [ ] Effect presets
- [ ] Shared effect styles
- [ ] Effect libraries (.xlib)
- [ ] Better effect editing UI
- [ ] Noise/grain effect (lower priority)
- [ ] Effect token support

---

### P1.9 — Dev Mode Enhancement

**Current:** Major gap

**Add Code Generation For:**
```
React
React + CSS
React + Tailwind
HTML
Vue
Svelte
SwiftUI
UIKit
Compose
XML
```

**Critical Improvement:**
```
X-Native Auto Layout
       ↓
Layout Inference Engine
       ↓
Flexbox / Grid / Appropriate Layout
       ↓
Production-Ready Code
```

**Instead of:**
```css
/* ❌ Bad */
position: absolute;
left: 20px;
top: 40px;
```

**Generate:**
```tsx
// ✅ Good
<div className="flex gap-4 p-6">
  <Button variant="primary" />
</div>
```

**Actions:**
- [ ] Build layout inference engine
- [ ] Map Auto Layout → Flexbox/Grid
- [ ] Add framework-specific generators
- [ ] Support token → code variable mapping
- [ ] Add component → code component mapping

---

### P1.10 — Component → Code Mapping

**Create First-Class Mapping System:**
```
Design Component
       ↓
Variant (primary, large)
       ↓
Code Component (Button.tsx)
       ↓
Repository (GitHub/GitLab)
       ↓
File Path
       ↓
Generated Code
```

**Example:**
```yaml
Design: Button
Variant: 
  - variant: primary
  - size: large
Maps To:
  Framework: React
  File: components/Button.tsx
  Props:
    variant: primary
    size: large
```

**Integration:**
- [ ] Works with Dev Mode
- [ ] Works with MCP
- [ ] Supports multiple frameworks
- [ ] Version tracking
- [ ] Sync status indicators

---

### P1.11 — MCP / Design API Expansion

**Recommended API Surface:**

```rust
// Selection & Nodes
get_selected_design()
get_selection()
get_layers()
get_node(node_id)
find_nodes(query)

// Variables
get_variables()
get_variable(id)
get_variable_usage(id)

// Tokens
get_tokens()
get_token_usage(token_id)

// Components
get_component(id)
get_component_set(id)
get_instance(id)
get_component_properties(id)
get_variants(component_id)

// Layout
get_auto_layout(node_id)
get_constraints(node_id)
get_spacing(node_id)

// Styles
get_colors()
get_typography()

// Assets & Metadata
get_assets()
get_annotations()
get_design_version()

// Code Integration
get_code_mapping(component_id)
get_code_component(id)
generate_code(options)
```

**Requirements:**
- [ ] All responses structured JSON
- [ ] Machine-readable schemas
- [ ] Proper error codes
- [ ] Pagination for large results
- [ ] Filtering and querying

---

### P1.12 — Prototype System Enhancement

**Strengthen With:**
- [ ] Smart Animate
- [ ] Interactive components
- [ ] Variables in prototypes
- [ ] Conditional logic
- [ ] Multiple actions per trigger
- [ ] Overlays
- [ ] Modals
- [ ] Bottom sheets
- [ ] Actions: Open/close overlay, Scroll to, Back, Close
- [ ] Triggers: After delay, Mouse enter/leave, Drag, Keyboard

**Key Differentiator:**
```
Variables + Interactive Components + Conditions
       ↓
Powerful Prototyping System
```

---

### P1.13 — Unified Search System

**Create Single Search Interface Covering:**
```
Pages
Frames
Layers
Components
Variants
Variables
Tokens
Assets
Commands
Prototype Flows
```

**Future Vision:**
```
Design Files
Code Components
Documentation
Design Tokens
Assets
```

**Features:**
- [ ] Fuzzy matching
- [ ] Type filtering
- [ ] Recent items
- [ ] Keyboard shortcut activation
- [ ] Preview thumbnails
- [ ] Quick actions

---

### P1.14 — Design System Linting

**Design Health Checker:**
```
Unused Colors
Unused Variables
Broken Variables
Broken Tokens
Non-Token Colors
Non-Token Spacing
Wrong Typography Usage
Inconsistent Radius Values
Detached Components
Accessibility Issues
Contrast Failures
```

**Output:**
```
Design Health Score: 82 / 100

Issues:
⚠️ 3 unused color tokens
⚠️ 2 broken variable aliases
❌ 5 layers with contrast failures
✅ Component structure valid
```

**Actions:**
- [ ] Create linting rules engine
- [ ] Add fix suggestions
- [ ] Integrate into CI/CD
- [ ] Real-time feedback in editor

---

### P1.15 — Accessibility

**Implement & Test:**
- [ ] Keyboard-only navigation
- [ ] Focus management
- [ ] Focus restoration
- [ ] Screen reader semantics
- [x] ~~High Contrast mode support~~ — dropped 18 Sep 2026; the product ships two
      palettes (Graphite, Daylight) and no third
- [ ] Reduced Motion preference
- [ ] UI scaling
- [ ] Inspector keyboard editing
- [ ] Accessible tooltips
- [ ] Accessible layer names
- [ ] WCAG compliance checking

---

### P1.16 — Performance Benchmarking

**Test Scale:**
```
100 nodes
1K nodes
5K nodes
10K nodes
20K nodes
50K nodes
100K nodes
```

**Measure:**
```
Document Load Time
First Frame Render
Selection Latency
Drag Performance
Resize Operations
Auto Layout Recalculation
Text Editing Responsiveness
Zoom/Pan Smoothness
Undo/Redo Speed
Save Operations
Export Performance
```

**Critical Test Case:**
```
10K+ nodes + Nested Auto Layout + Rich Text + Components
```

**Actions:**
- [ ] Create benchmark suite
- [ ] Establish baseline metrics
- [ ] Set performance budgets
- [ ] Add regression testing
- [ ] Profile bottlenecks

---

### P1.17 — Import/Export Enhancement

**Keep `.x` as canonical native format**

**Strengthen:**
- [ ] Figma → X-Native (via JSON/SVG intermediate)
- [ ] Sketch → X-Native
- [ ] SVG → X-Native (high fidelity)
- [ ] X-Native → SVG
- [ ] X-Native → Figma-compatible export (JSON/SVG)

**Focus:** Fidelity over reverse-engineering proprietary `.fig` binary

**Round Trip Testing:**
```
X → SVG → X (verify fidelity)
X → Figma → X (via intermediate)
X → Sketch → X (via intermediate)
```

---

## 🟢 Preserve These Systems

**DO NOT REWRITE** these working systems:

- ✅ Auto Layout engine
- ✅ Document model
- ✅ Variables foundation
- ✅ Component foundation
- ✅ Rendering engine (Vello)
- ✅ Text engine
- ✅ Selection engine
- ✅ Undo/Redo system
- ✅ Prototype model
- ✅ Native `.x` format
- ✅ GPU pipeline
- ✅ Existing test infrastructure

---

## 📋 Implementation Phases

### PHASE 1 — Stability (Week 1-2)
```
├── Build integrity (P0.1)
├── Module cleanup (P0.1)
├── All tests passing (P0.1)
└── Zero clippy warnings (P0.1)
```

**Deliverables:**
- Clean workspace build
- All tests green
- Release artifact

---

### PHASE 2 — Native UI Foundation (Week 3-4)
```
├── Graphite & Signal tokens (P0.3)
├── x-ui component library (P0.2)
├── Toolbar implementation
├── Layers panel
├── Inspector panel
├── Context toolbar
└── Popups & tooltips
```

**Deliverables:**
- Consistent visual design
- Reusable component library
- All panels using x-ui

---

### PHASE 3 — Core Design Features (Week 5-8)
```
├── Variables enhancement (P1.1)
├── Design tokens system (P1.2)
├── Components strengthening (P1.3)
├── Variants system
├── Component properties (P0.6, P1.3)
├── Auto Layout improvements (P1.5)
└── Pen tool / vector editing (P1.6)
```

**Deliverables:**
- Production-ready variables/tokens
- Robust component system
- Professional vector tools

---

### PHASE 4 — Professional Workflow (Week 9-10)
```
├── Command system unification (P0.8)
├── Unified search (P1.13)
├── Prototype system (P1.12)
├── Asset management
├── Design linting (P1.14)
└── Accessibility (P1.15)
```

**Deliverables:**
- Consistent undo/redo everywhere
- Powerful search
- Advanced prototyping
- Design health monitoring

---

### PHASE 5 — Dev Mode & Integration (Week 11-13)
```
├── Dev Mode inspector (P1.9)
├── React code generation
├── Tailwind support
├── Component → code mapping (P1.10)
├── Tokens → code mapping
└── MCP API expansion (P1.11)
```

**Deliverables:**
- Production code export
- Framework integrations
- Developer handoff tools

---

### PHASE 6 — Performance & Scale (Week 14-16)
```
├── 10K nodes benchmark
├── 50K nodes benchmark
├── 100K nodes benchmark
├── Auto Layout stress tests
└── Comprehensive regression suite
```

**Deliverables:**
- Performance benchmarks
- Optimization report
- Regression test suite

---

## Success Metrics

### Technical Excellence
- [ ] Zero build warnings
- [ ] 90%+ test coverage on core systems
- [ ] <16ms frame time at 10K nodes
- [ ] <100ms undo/redo latency
- [ ] Sub-second search results

### Feature Completeness
- [ ] All P0 items resolved
- [ ] 80%+ P1 items implemented
- [ ] Figma parity on core workflows
- [ ] Unique differentiators (variables + prototyping)

### Developer Experience
- [ ] Clean, documented APIs
- [ ] Comprehensive examples
- [ ] Easy contribution process
- [ ] Fast iteration cycle

---

## Key Principles

1. **Preserve Working Systems** — Don't rewrite what works
2. **Incremental Improvement** — Small, testable changes
3. **Consistency First** — Unified patterns across the product
4. **Test Everything** — Regression suites for all features
5. **Performance Matters** — Benchmark-driven optimization
6. **Developer Friendly** — Clean code, good docs, fast builds

---

## Next Immediate Actions

1. **Run build audit** (P0.1)
   ```bash
   cd /workspace
   cargo fmt && cargo check --workspace --all-targets
   cargo test --workspace
   cargo clippy --workspace --all-targets -- -D warnings
   ```

2. **Inventory current state** of each system
3. **Prioritize P0 fixes** before adding new features
4. **Create tracking issues** for each checklist item
5. **Establish baseline metrics** for performance

---

*Last Updated: $(date)*
*Version: 1.0*
*Status: Ready for Implementation*
