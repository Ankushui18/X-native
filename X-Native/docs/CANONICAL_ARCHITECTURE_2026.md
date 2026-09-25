# 🏛️ X-Native Canonical Architecture Document (Revised)

## 1. Core Philosophy
**Old Question:** *"How do we copy Figma and then beat it?"*  
**New Guiding Question:** *"What should X-Native's canonical design document be capable of representing that today's design tools make difficult or impossible?"*

This shifts the focus from feature parity to **architectural superiority**: a local-first, procedurally non-destructive, explicitly typed, and highly interoperable document model.

---

## 2. The Canonical Document Model
The document is not a tree of rendered pixels; it is a structured representation of intent, separated into three orthogonal pillars, all mutated exclusively through a **Command/Transaction System**.

```text
                  X-NATIVE DOCUMENT
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   GEOMETRY          LAYOUT            STATE
       │                 │                 │
 VectorNetwork       Constraints       Variables
 Planar Regions      Auto Layout       Expressions
 Modifier Stack      Components        Prototype Graph
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                  COMMAND SYSTEM (Single Source of Truth)
                         │
             ┌───────────┼───────────┐
             │           │           │
          Editor       Renderer    Prototype
             │           │           │
             └───────────┼───────────┘
                         │
                  PERSISTENCE (JSON/Binary)
                         │
                    CRDT Sync (Phase 6)
                         │
                Collaboration
```

### The Command/Transaction System (Phase 0 Foundation)
Before any UI or CRDT is built, all mutations flow through an explicit transaction stream:
```rust
pub struct Transaction {
    pub id: TransactionId,
    pub timestamp: u64,
    pub operations: Vec<Operation>, // SetProperty, InsertNode, DeleteEdge, SetVariable
}
```
*Benefits:* Enables robust Undo/Redo, deterministic serialization, clean persistence, and provides the exact delta stream required for future CRDT integration without coupling the core model to distributed systems prematurely.

---

## 3. Critical Subsystem Specifications

### A. Vector Networks & Planar Geometry
The model is decoupled from any specific math library via traits, allowing the underlying geometry engine to be swapped or enhanced.

```rust
pub trait GeometryBoolean {
    fn union(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
    fn subtract(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
    fn intersect(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
    fn exclude(&self, other: &Self) -> Result<VectorNetwork, GeometryError>;
}
```
**The Pipeline:** Curve Representation → Flattening/Intersection → Planar Arrangement → Boolean Topology → Region Extraction → Tessellation → GPU Rendering.

**Data Structure:**
```rust
pub struct VectorNetwork {
    pub vertices: HashMap<VertexId, Vertex>,
    pub edges: HashMap<EdgeId, Edge>,
    pub regions: HashMap<RegionId, Region>, // Derived from planar graph traversal
    pub paints: HashMap<PaintId, Paint>,
    pub winding_rule: WindingRule, // EvenOdd or NonZero
}
```
*Crucial Detail:* Regions are **derived** from the planar graph, not stored as arbitrary closed paths. This makes Shape Builder, boolean operations, and hit-testing mathematically sound.

### B. Procedural Modifier Stack (Non-Destructive Geometry)
Instead of destructive flattening, layers maintain an explicit procedural operation graph:
```text
Rectangle (Base)
   ↓ RoundedCorners(radius: 8)
   ↓ Offset(distance: 10, join: Miter, limit: 4)
   ↓ BooleanSubtract(target: Circle_ID)
   ↓ Stroke(width_profile, caps, joins, dashes)
   ↓ Transform(affine_matrix)
```
Every operation has parameters and recomputes from the underlying source geometry on demand.

### C. Comprehensive Stroke Semantics
Acknowledge that "mathematically perfect" stroke expansion is a fallacy. The system explicitly defines behavior for:
- Joins (Miter, Round, Bevel) & Miter Limits
- Caps (None, Round, Square, Arrow, Custom)
- Self-intersections and cusps
- Variable width (modeled as a property of the stroke: `centerline`, `width_profile`, `pressure_points`)
- Dashed strokes, transforms, gradients, and numerical tolerances.

### D. Expressions & Reactive Dependency Graph
Expressions are a first-class document language, not just a parsed string.
**Pipeline:** Expression String → Parser → AST → Type Checker → **Dependency Graph (with Cycle Detection)** → Evaluation.
*Example:* `width = container.width * 0.5 + spacing` creates a directed edge in the graph. Cycles (`A → B → C → A`) are rejected at the transaction level.

### E. Smart Animate Identity System
Heuristics are a fallback, not the primary mechanism. Matching priority:
1. Explicit `animation_id` or `prototype_identity`
2. `component_id` / `instance_id` match
3. Stable structural identity (path in the layer tree)
4. Layer `name` match
5. Geometry similarity (point count, bounding box)
6. Heuristic fallback (closest spatial match)

---

## 4. Major System Domains

### F. Typography & Text Engine
Text is a primary geometry type, not an afterthought. The `x-text` crate must handle:
- Font loading, fallback chains, and variable fonts.
- HarfBuzz (or equivalent) for shaping, kerning, and ligatures.
- Rich text ranges, paragraph layout, and line breaking (Unicode UAX #14).
- Text-on-path, baseline behavior, RTL support, and emoji.
- Missing font handling and font embedding/licensing metadata.

### G. Assets & Media
- Raster images, SVG import, and video/GIF support.
- Image cropping, masks, and image fills.
- Color profiles (sRGB, Display P3), EXIF orientation handling.
- Asset deduplication, missing asset placeholders, and drag-and-drop/clipboard interoperability.

### H. Layout & Constraints (Decoupled from CSS)
The internal layout model expresses **design intent**, not CSS.
```text
X-Native Layout Model (Constraints, Auto Layout, Min/Max, Wrap)
        ↓ (Exporter)
CSS Flexbox / Grid
        ↓ (Exporter)
SwiftUI (VStack/HStack)
        ↓ (Exporter)
Jetpack Compose (Row/Column)
```
Do not force the internal model to be a CSS Flexbox clone; let the exporters handle the translation.

### I. Import/Export & Interoperability
- **Clipboard:** Robust SVG and PNG clipboard compatibility for moving assets between Figma, Sketch, and X-Native.
- **Formats:** SVG, PNG, JPG, WebP, PDF, JSON, HTML/CSS.
- **Interoperability:** Native container support for `.fig` and `.sketch` to ease seamless project migration.

### J. Accessibility
- Full keyboard navigation and focus management.
- Screen-reader semantics and accessible component metadata.
- Built-in contrast checking and reduced motion preferences.
- Keyboard-only editing workflows and fully customizable shortcuts.

### K. Plugin & Extensibility Architecture
Design the boundary *before* the app tightens:
```rust
pub trait PluginAPI {
    fn read_document(&self) -> DocumentSnapshot;
    fn mutate(&self, transaction: Transaction) -> Result<(), PluginError>;
    fn register_ui(&self, component: PluginUI);
}
```

---

## 5. The Revised 8-Phase Engineering Roadmap

### Phase 0: Architecture & Foundation
- Canonical Document Model definition.
- Command/Transaction System & Undo/Redo.
- Stable ID generation and serialization/versioning.
- Geometry abstraction traits (`GeometryBoolean`).
- Plugin API boundary definition.

### Phase 1: Geometry Engine
- `VectorNetwork` (Vertices, Edges, Derived Regions).
- Planar graph construction and region extraction.
- Robust Boolean operations (Union, Subtract, Intersect, Exclude).
- Comprehensive Stroke model & Modifier Stack.
- Hit testing and GPU tessellation pipeline.

### Phase 2: Core Editor
- Pen tool, Node editing, Shape Builder.
- Boolean UI and live preview.
- Stroke editing, Variable width manipulation.
- Selection, Snapping, Guides, Alignment.

### Phase 3: Layout & Components
- Components, Instances, Variants.
- Auto Layout and Constraints.
- Variables system (Color, Number, String, Boolean).
- Design tokens architecture.

### Phase 4: Prototype Runtime
- Prototype graph and navigation.
- Expressions (Parser, AST, Dependency Graph, Cycle Detection).
- Conditionals and Actions.
- Smart Animate (Identity-based matching).
- Standalone Prototype Player.

### Phase 5: Developer Platform
- Dedicated Dev Mode UI.
- Box model inspector.
- Code exporters (CSS, React, SwiftUI, Compose).
- Token export (JSON/Style Dictionary).
- Developer annotations.

### Phase 6: Collaboration
- CRDT integration (consuming the Phase 0 Transaction stream).
- Multiplayer presence and cursors.
- Comments and offline sync.
- Conflict resolution.

### Phase 7: Differentiation ("Leapfrog" Features)
- Advanced Modifier Stack UI (non-destructive editing).
- Zen Mode & Contextual HUD.
- Marking/Radial menus.
- AI-assisted vector cleanup (sketch to smooth Bézier).
- Advanced automation and scripting.

---

## 6. The Benchmarking Mandate

**Target:** Sustain interactive performance on very large documents through GPU-accelerated rendering, incremental tessellation, aggressive dirty-region updates, and intelligent caching.

**Required Benchmark Suite:**
- **Benchmark A:** 10,000 simple rectangles.
- **Benchmark B:** 10,000 Bézier paths.
- **Benchmark C:** 1,000 complex boolean shapes (live editing).
- **Benchmark D:** 500 objects with heavy blur effects.
- **Benchmark E:** 100,000 nodes with 10% viewport visibility (culling test).
- **Benchmark F:** Large document + continuous typing/editing (frame latency).

**Metrics to Track:** FPS, CPU time, GPU time, memory footprint, initial load time, edit latency, and export time.
