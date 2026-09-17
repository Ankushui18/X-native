# X-Native Designer

Native design tool (Rust + Vello/wgpu). **Greenfield UI** on a preserved engine.
Visual language: Graphite & Signal.

## Document opening

The [document loading screen](docs/DOCUMENT_LOADING.md) follows real read/validation,
asset and rendering work, uses an indeterminate spinner, and enables the editor
only after a successful first presentation. There are no fake percentages or
minimum loading delays. Failures offer Try Again and Close.

## Reliability and verification

See [the reliability changes, run instructions and feature boundaries](docs/RELIABILITY.md).
The [responsiveness follow-up](docs/RESPONSIVENESS.md) adds background imports/exports
and records the actual UI/canvas CPU-frame experiment.
The [local verification record](docs/VERIFICATION.md) documents what was actually
gated locally. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs
exactly [`scripts/check.sh`](scripts/check.sh), so the gate below is the same
claim in both places — until this branch reaches a host with Actions, the local
record is the one that has actually been executed.

## Foundation (engine)

- Document model, Auto Layout, components, variables (`x-core`)
- Selection, undo, constraints, prototype player (`x-editor`)
- GPU scene pipeline + export image optimizer (`x-render`)
- Typography, TrueType subsetting for export (`x-text`)
- `.x` / SVG / Sketch / Figma JSON / **Figma `.fig` binary** (`x-format`)
- Static HTML/CSS site export (`x-native::html_export`)
- Infinite canvas / UX mapping module (`x-board`)

## Formats & shipping

- **Import**: Figma `.fig` (kiwi binary container — layers, names, auto
  layout, rich text, images), Sketch, SVG, Figma REST JSON.
  CLI: `x_native import-fig file.fig [out.x]`.
- **Export**: PNG / JPG / SVG / PDF, plus **static sites** —
  `x_native export-html file.x outdir [--optimize] [--fonts]` writes
  `index.html` + per-page HTML, one shared `styles.css`, image assets
  (optionally re-compressed / downscaled) and `@font-face` declarations
  whose TTFs are **subset to exactly the characters the document draws**.
  Auto-layout frames become real CSS flex containers.
- **Design audit toolkit** (OpenPencil-inspired headless workflows, on
  `.x` and every importable format):
  `x_native tree|find|node|info file.x [--json]`,
  `x_native lint file.x [--preset recommended|strict|a11y|all] [--rule ID]
  [--ignore ID] [--fail-on error|warning|never] [--list-rules]` (15
  preset-driven rules over naming, contrast, touch-targets, zero-size, nesting,
  stray children; exit code 4 on findings), `x_native analyze file.x [colors|type|spacing|overlaps]
  [--emit-variables out.x]` (usage histograms + design-system audit, one
  command from palette → named variables), and
  `x_native export-jsx file.x [--tailwind]` — pixel-faithful JSX with
  arbitrary-value Tailwind classes generated from the same style model as
  the Code panel.
- **UI themes** are an audited, switchable palette, not a hex table:
  `x_native theme audit` checks every text role against every surface it can be
  painted on (47 pairs per theme, WCAG 2.1 AA) and `x_native theme tokens`
  exports one as W3C DTCG JSON. See [Themes](#themes).
- In-app: the PROTOTYPE tab authors interactions (on-click / hover / press
  → navigate) with live **flow preview** on the canvas (Esc steps back,
  Q exits); instances of variant sets get a **VARIANT switcher**; component
  masters expose Text/Bool/Swap **properties** editable per instance; the
  ASSETS panel can **Load Font…** (.ttf/.otf/.ttc) into the render stack;
  the TOKENS tab live-audits the document (palette, type scale, spacing)
  and generates named variables from the extracted tokens. The command
  palette gained **Lint document**.

## Themes

Interface color is a set of 22 semantic roles in
[`crates/x-ui/src/design_system.rs`](crates/x-ui/src/design_system.rs) —
surfaces, text levels, accent fills, label-on-fill, selection and focus
indicators, state colors — instantiated as three palettes: **Graphite** (dark,
the default), **Daylight** (light, for shared screens and bright rooms) and
**High Contrast** (pure black, maximum separation). The application paints
through them: `theme::resolve` maps a Graphite-authored chrome color onto the
active palette at draw time, so switching repaints every panel, row and label —
and leaves what you drew alone, because artwork, smart guides and watermarks are
not roles.

Switch it from the TOKENS panel button, or `⌘K` → `Theme: Daylight (light)` /
`Theme: High Contrast`. What keeps the light and high-contrast palettes honest
is an audit, not a vibe: every text role is measured against every surface it can
land on (plus labels on accent fills, and the 3:1 floor for non-text indicators)
using the WCAG 2.1 contrast formula.

```bash
x_native theme audit                      # all three palettes, exit 4 on failure
x_native theme audit --theme daylight --json
x_native theme tokens --theme daylight -o ui-tokens.json   # import as variables
```

Every shipped palette passes, and `every_shipped_palette_is_aa_clean` fails the
build if a future tweak breaks that — which is what makes "add a theme" a normal
PR instead of a redesign.

## UI

The native Rust UI in `apps/x-designer/src/bin/x_native_app/` is the active
product interface, implementing the Graphite & Signal design system:
app shell, home, tool rail, pages + layers, contextual inspector, status bar,
command palette. Runtime behavior uses real local documents; fixture content is
available only via `--demo`. See the [capability map](docs/UI_CAPABILITY_MAP.md),
[icon system](docs/ICON_SYSTEM.md), [product direction](docs/X_NATIVE_PROFESSIONAL_UI.md)
and [roadmap](docs/X_NATIVE_IMPLEMENTATION_ROADMAP.md). The chrome is held to a
contract in `crates/x-ui`: the [screen contract](docs/SCREEN_CONTRACT.md) lists
every surface and what it owes, and the
[component contract](docs/COMPONENT_CONTRACT.md) the components they are built
from — heights, states, hit regions and who paints each one.

## Build

```bash
sudo apt-get install -y libgtk-3-dev   # Linux dialogs (rfd)
cargo build --release -p x-designer --bin x_native_app
cargo run --release -p x-designer --bin x_native_app
```

## Test

```bash
./scripts/check.sh          # fmt, clippy, tests, doc references, CLI smoke
cargo test --workspace
cargo test -p x-designer --bin x_native_app -- --ignored   # headless GPU screenshot tests (needs software Vulkan)
```

## Repository notes

- `Cargo.lock` is committed on purpose (this workspace ships binaries; the
  packaging script builds with `--locked`).
- `target/`, generated `export_page1.svg`, and test `screenshots/` output are
  ignored — never commit build artifacts.
- Third-party font licenses: `apps/x-designer/assets/fonts/licenses/` and
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

Not declared yet, deliberately: `crates/x-board` says `MIT`, the rest of the
workspace says nothing, and there is no `LICENSE` file at the root. Until that is
resolved (see [docs/KNOWN_DEBT.md](docs/KNOWN_DEBT.md) §8) treat all code here as
"all rights reserved" and do not republish it. Third-party assets carry their own
notices in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
