# `x_native` — the headless toolkit

One binary, two halves. `apps/x-designer/src/bin/x_native.rs` is the driver
(help, version, the no-argument engine self-test, `.fig` import, HTML export,
MCP server); `apps/x-designer/src/bin/x_native/toolkit.rs` owns the inspect /
audit / ship verbs. Both call the same functions the editor does — there is no
CLI-only engine, so a green run here means the panel in front of a user is
green too.

```
cargo build --release -p x-designer --bin x_native
./target/release/x_native --help          # everything below, in one screen
./target/release/x_native <verb> --help   # per-verb options
```

Reading a file needs no ceremony: `.x`, `.fig`, `.svg`, Figma JSON, `.sketch`
and `.png` are sniffed by `load_any`. `--json` is accepted by every verb.

## Inspect

| Verb | What it prints |
|---|---|
| `tree <file>` | indented layer tree (`--depth N`, `--json`) |
| `find <file>` | filtered layers: `--type KIND --name SUB --name-is NAME --id ID --under NODE --min-w/--min-h/--max-w/--max-h --visible --static --limit N` |
| `node <file> <id>` | one node as JSON, children to `--depth N` |
| `info <file>` | pages, nodes, frames, texts, images, components, instances, auto-layouts, interactions, assets, variables |

`find` exits **3** when nothing matches, so it works inside a shell condition
without scraping output.

## Audit

```
x_native lint <file> [--preset recommended|strict|a11y|all] [--strict]
                     [--rule ID]... [--ignore ID]... [--list-rules]
                     [--fail-on error|warning|never] [--quiet] [--json]
x_native analyze <file> [colors|type|spacing|overlaps|clusters|adoption]
                      [--top N] [--min-overlap F] [--min-cluster N] [--json]
                      [--emit-variables OUT.x]
```

Fifteen rules run from one table (`crates/x-core/src/lint.rs`); a preset is a
filter over it, and `--rule` / `--ignore` compose on top of whatever preset is
active. `--list-rules` prints id, severity, presets and the check in one line
each — that table and the `lint_design` MCP tool are generated from the same
`OnceLock`, so documentation cannot drift from behaviour.

`analyze` reports the design system the document *actually* uses: color
histogram, type scale, font families, gap/padding/radius values, repeated box
clusters, overlaps, and `adoption` — which variables exist, which are bound,
and which are dead weight. `--emit-variables` writes a copy of the document with
one typed variable per extracted token and only ever adds the missing tail, so
it is idempotent.

CI shape, using the shipped a11y preset and a hard exit on any finding:

```
x_native lint design.fig --preset a11y --fail-on error || exit 1
x_native analyze design.fig --json | jq '.total'
```

## Ship

| Verb | Output |
|---|---|
| `export-jsx <file>` | React markup from the style model; `--tailwind` swaps inline styles for arbitrary-value classes |
| `export <file> -f jsx\|tailwind\|svg\|tokens [-o OUT]` | same generators, one flag apart |
| `tokens <file>` | W3C DTCG `tokens.json` from the document variables (aliases become `{ "id": … }` references, modes become `$themes`) |
| `convert <in> <out.(x\|svg)>` | re-serialize any supported input |
| `validate <file>` | load → save → load, then compare structural stats |
| `import-fig <file.fig> [out.x]` | Figma binary → `.x`, with a diagnostics report |
| `export-html <file.x> <outdir> [--optimize] [--fonts]` | static site: `index.html`, `styles.css`, subset webfonts |
| `mcp [file.x]` | MCP server on stdio |

`validate` exits **5** and prints the diff when the format round-trip loses
content — the check a release pipeline wants. `export-html --optimize` runs the
PNG optimizer, `--fonts` writes a `@font-face` subset per family used.

## Themes

```
x_native theme audit [--theme ID] [--json]
x_native theme tokens [--theme ID] [-o OUT.json]
```

No file argument: this reads the palettes the application itself is painted
from (`crates/x-ui/src/design_system.rs`, audited in `crates/x-ui/src/theme.rs`).
`audit` walks every text role over every surface role it can land on, plus
labels on accent fills and the selection/focus indicators, against WCAG 2.1 AA
(4.5:1 text, 3:1 non-text). `tokens` emits the palette as DTCG JSON, so a
design file can import the app theme as variables instead of copying hexes.

```
$ x_native theme audit
Graphite (dark): 47 pair(s) checked, headroom 1.08×
  WCAG AA: all pairs pass
Daylight (light): 47 pair(s) checked, headroom 1.06×
  WCAG AA: all pairs pass
```

Exit **4** if any pair falls below its floor — which is what makes "add a
theme" a safe PR. `--json` carries every measured ratio, so a dashboard can
graph the headroom instead of a yes/no.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | I/O error, missing node, or a write that failed |
| 2 | usage error: unknown verb/flag/theme, dangling option, `--help` |
| 3 | `find`: no layer matched |
| 4 | `lint` findings at or above `--fail-on`; `theme audit` contrast failure |
| 5 | `validate`: the round-trip lost content |

`--help` on a known verb prints that verb; on an unknown one it prints the
summary and exits 2. Output is written through an EPIPE-safe emitter, so
`x_native tree big.x | head` never panics.

## MCP tools

`x_native mcp [file.x]` speaks JSON-RPC 2.0 on stdio (`initialize`,
`tools/list`, `tools/call`, `ping`) and exposes the same engine:

`list_pages` · `get_node` · `find_nodes` · `node_code` (`css|tailwind|swiftui|compose|xml|jsx`)
· `design_tokens` · `variables` · `inspect_tree` · `lint_design` · `list_lint_rules`
· `analyze_design` · `extract_variables`

`lint_design` takes `preset`, `rule`, `ignore`, `json`; `analyze_design` takes
`section` and `top`; `extract_variables` is a dry run that names the variables
`--emit-variables` would write. Anything an agent can do to a file is available
in the editor, and nothing is offered in only one of the two.
