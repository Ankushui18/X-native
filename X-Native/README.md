# X-Native Designer

Design tool with a **Rust engine** (document, layout, `.x` IO, headless render)
and a **web designer** as the only product UI. Visual language: Graphite & Signal.

## Architecture boundary

Rust is the intended engine authority; the web designer is the only UI. Today
the web app implements the document model, undo and Auto Layout in TypeScript
and does not call the Rust crates at all. The decided boundary, the verified
gap and the order of work to close it are in
[docs/ARCHITECTURE_BOUNDARY.md](docs/ARCHITECTURE_BOUNDARY.md). Read it before
adding engine behaviour to `apps/web`.

## Document opening

The web designer loads the document through the command API. There are no fake
percentages or minimum loading delays.

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
- In-app (web designer): Prototype, Assets, Variables, and inspect panes
  live in [`apps/web`](apps/web/README.md). Headless lint / analyze / theme
  audit stay on the `x_native` CLI.

## Themes

Interface color is a set of 22 semantic roles in
[`crates/x-ui/src/design_system.rs`](crates/x-ui/src/design_system.rs) —
surfaces, text levels, accent fills, label-on-fill, selection and focus
indicators, state colors — instantiated as two palettes: **Graphite** (dark,
the default) and **Daylight** (light, for shared screens and bright rooms).
The CLI and design-system crate paint through those roles. Artwork, smart
guides and watermarks are not roles. What keeps the palettes honest is an
audit, not a vibe: every text role is measured against every surface it can
land on (plus labels on accent fills, and the 3:1 floor for non-text indicators)
using the WCAG 2.1 contrast formula.

```bash
x_native theme audit                      # both palettes, exit 4 on failure
x_native theme audit --theme daylight --json
x_native theme tokens --theme daylight -o ui-tokens.json   # import as variables
```

Every shipped palette passes, and `every_shipped_palette_is_aa_clean` fails the
build if a future tweak breaks that — which is what makes "add a theme" a normal
PR instead of a redesign.

## UI

The product interface is the React designer in [`apps/web`](apps/web/README.md)
(Figma UI3 chrome). It talks to the document through a command API so a future
WASM `x-editor` can replace the in-memory engine without rewriting the shell.
Undo, layout, `.x` IO and headless GPU export stay in Rust.

There is **no native GPU chrome**. The old `x_native_app` window (Vello panels,
immediate-mode inspector) was removed so there is one UI to design and ship.

```bash
cd apps/web && npm install && npm run dev
```

## Build

```bash
cargo build --release -p x-designer --bin x_native
cargo run --release -p x-designer --bin x_native -- --help
```

Headless GPU proof (needs a Vulkan adapter, software is fine):

```bash
cargo run --release -p x-designer --bin render_headless
```

## Test

```bash
./scripts/check.sh          # fmt, clippy, tests, doc references, CLI smoke
cargo test --workspace
cd apps/web && npx tsc -b
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
