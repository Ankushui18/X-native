# Contributing

Short version: `./scripts/check.sh` before you push. It is the same script CI
runs, so a green local run is a green pipeline.

## Setup

```
rustup toolchain install stable --profile minimal   # rust-toolchain.toml pins it
rustup component add rustfmt clippy
cargo build --workspace                             # vello + wgpu, a few minutes cold
cargo test --workspace
cd apps/web && npm install && npm run dev            # product UI
```

Linux needs Vulkan loaders for headless GPU bins (`render_headless`,
`type_proof`); the engine, CLI and MCP server build and test without them.
Everything in the test suite is deterministic and offline — no fixture
downloads, no wall-clock assertions, no network. The handful of GPU tests
are `#[ignore]`d on purpose:

```
cargo test --workspace -- --ignored   # needs software Vulkan
```

## Layout

| Path | What lives there |
|---|---|
| `crates/x-core` | document model, style/variable stores, lint, analyze, query |
| `crates/x-format` | `.x` serialization, `.fig`/kiwi import, codegen (JSX/Tailwind/SVG/HTML) |
| `crates/x-editor` | editor semantics: selection, hit-testing, auto-layout, dev mode |
| `crates/x-render` | scene lowering for Vello, vector networks |
| `crates/x-text` | font management, shaping, `glyf` subsetting |
| `crates/x-ui` | widget kit, **design system + themes** (`design_system.rs`, `theme.rs`) |
| `crates/x-native` | façade re-exports + the MCP server |
| `apps/web` | **product UI** (React Figma UI3 chrome over the command API) |
| `apps/x-designer` | CLI + headless GPU bins (`x_native`, `render_headless`, …) |

The façade rule: `x_native::*` is what the app and the CLI both import. If a
capability should be reachable from a script, an agent and the panel, it gets a
re-export here and a test on each side — not a second implementation.

## Conventions that are actually enforced

- **Colors are roles, never literals.** Interface chrome takes its colors from
  `x_native::ui::ColorTokens` (`crates/x-ui/src/design_system.rs`). Add the
  role to the palette if it is missing, and the audit in
  `crates/x-ui/src/theme.rs` will hold it to WCAG AA — `x_native theme audit`
  in CI, and `every_shipped_palette_is_aa_clean` as a unit test. Content colors
  (what the user drew, smart guides, watermarks, brand marks) stay literals on
  purpose: a theme switch must not repaint them.
- **New UI colors live in the web designer.** Chrome is `apps/web`. Engine
  canvas labels still take roles from `crates/x-ui`. There is no native GPU
  chrome to paint through.
- **No `unsafe`, no `dbg!`, no `todo!`.** Denied by `[workspace.lints]`. A new
  `unsafe` block needs a documented `#[allow(unsafe_code)]` and a sentence in
  `docs/KNOWN_DEBT.md` about why it cannot be avoided.
- **Dead code is ratcheted, not ignored.** `scripts/check.sh` fails when the
  dead-code warning count rises past `DEAD_CODE_CEILING`. Fix a warning by
  deleting it or by wiring it up; lowering the ceiling in the same PR is
  welcome. The inventory lives in `docs/KNOWN_DEBT.md`.
- **A `docs/*.md` path cited in a comment must exist.** The gate greps the
  sources for doc references and fails on a dangling one, because a pointer to
  a file nobody ships teaches the next reader to distrust the comments.
- **Errors are owned strings, not error types.** This engine returns
  `Result<T, String>` deliberately; keep messages actionable ("unknown preset
  'x' (recommended|strict|a11y|all)").

## Adding a CLI verb

The toolkit owns its own contract, and four tests keep it honest in
`apps/x-designer/src/bin/x_native/toolkit.rs`:

1. put the verb in `VERBS` (that also makes `is_toolkit` route it);
2. add a block to `verb_help` — `every_verb_has_help_text` fails otherwise, and
   it is what makes `x_native <verb> --help` impossible to forget;
3. pick an exit code from the documented set (0 ok, 1 I/O, 2 usage, 3 no match,
   4 findings, 5 round-trip mismatch) and cover it in
   `verbs_return_their_documented_exit_codes`;
4. print through `emit` / `emit_line` (EPIPE-safe) and write files with `write`,
   never `println!` — `| head` is a supported use of this tool;
5. accept `--json` if the output is data, and update `docs/CLI.md` and
   `SUMMARY` in the same commit.

If the verb is worth automating, it is worth exposing as an MCP tool: see
`crates/x-native/src/mcp.rs`, where `tools/list` and the dispatch arm are one
function apart and the tests drive real JSON-RPC lines.

## Commits

One capability per commit, imperative subject, and a body that says *why* — the
`git log` of this repository doubles as design documentation. Release-worthy
changes get a line in `CHANGELOG.md`. Never rewrite a pushed commit; add
another.

## Definition of done

```
./scripts/check.sh            # fmt, clippy, tests, docs refs, CLI smoke
x_native theme audit           # if you touched anything about color
```

Both green, `CHANGELOG.md` updated, `docs/KNOWN_DEBT.md` edited if you moved a
ceiling — then open the PR.
