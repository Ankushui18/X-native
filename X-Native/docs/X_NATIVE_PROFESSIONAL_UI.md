# X-Native Professional UI

This package contains a clean native desktop workspace for X-Native. The shell uses the existing Rust, Winit, WGPU, Vello, and X-Native text stack; no web view or browser UI is introduced.

## Product direction

- Native decorated window on macOS, Windows, and Linux
- Inter Regular is resolved explicitly for application chrome through `SystemFonts`; a safe system fallback is used only when Inter is unavailable
- Platform-aware `Command K` / `Ctrl K` labels and input
- Calm Graphite surfaces with X-Native's Signal accent and role-based theme tokens
- Compact 24–34 px control density suited to a professional design tool
- Responsive 216/240 px navigator and 264/288 px inspector
- Canvas-first hierarchy with quiet chrome and high-contrast selection
- Contextual inspector states for page and object selection
- Layer search, page/layer hierarchy, libraries, variables, plugins, export, and auto-layout entry points
- Command palette plus V/F/T/R tool shortcuts
- Custom Vello stroke icons; emoji glyphs are not used for tools
- Clean viewport at normal zoom; the 1 x 1 document-pixel grid appears only from 800% zoom
- Original centered Graphite command capsule, 232 px navigator, and 296 px contextual inspector
- Neutral editable desktop and mobile frames keep attention on the editor UI rather than a showcase design
- Eight-handle selection bounds, live size badge, center snapping guides, and named frame labels are retained as usability benchmarks, not brand identity
- X-Native's Compose → Flow → Ship inspector, infinite Board workspace, Agents rail, and artifact handoff are intentionally not Figma's Design → Prototype → Dev Mode flow

## Important source

- `apps/x-designer/src/bin/x_native_app/main.rs` — native window bootstrap
- `apps/x-designer/src/bin/x_native_app/editor_ui.rs` — editor shell, hit regions, inspector, overlays, and Vello painting
- `apps/x-designer/src/bin/x_native_app/run.rs` — window lifecycle, input routing, action dispatch, and presentation

## Run

```bash
cargo run -p x-designer --bin x_native_app
```

## Design notes

The shell uses the reference's measured density only where it improves legibility. Its product language is X-Native: Graphite & Signal surfaces, Structure/Library navigation, a persistent Agents entry point, an infinite Board workspace, and Compose → Flow → Ship handoff. Inspector controls are expected to mutate the same document/render state used by canvas and export sinks; visible state must never be decorative.
