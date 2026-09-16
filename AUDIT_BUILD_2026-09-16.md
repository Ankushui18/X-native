# X-native — Audit & Build Attempt (2026-09-16)

## Verdict
- Codebase: substantial, well-structured; **no `unsafe` blocks found in workspace crates** (verify count below), but **416 `unwrap()`/`expect()`** call sites and 65 non-test `panic!()/unreachable!()` in shipped code paths.
- Build: attempted fully-offline build from a reconstructed vendor tree. Status: **see "Build result" below**.

## What this repo is
10-member cargo workspace (`X-Native/`): `x-core` (15.9k lines), `x-format` (17.4k), `x-render` (8.8k), plus app crates (`x-designer`, …). 431 locked packages, 938 `#[test]` functions. Rendering stack is wgpu 29 / vello 0.10 / winit 0.30; text via rustybuzz 0.14 + ttf-parser 0.25.

## Build attempt (fully offline)
Sandbox constraints discovered (evidence in `docs/audit/`):
- No network access to crates.io/static.rust-lang.org from the build environment → **every dependency had to be vendored from source-control mirrors**, 272 crates across `vendor/`.
- No system toolchain (clang, pkg-config, X11/GL dev headers) present.
- Toolchain 1.88.0 staged locally; `cargo build --locked --offline` with vendored-sources config.

Result: TODO-RESULT

## Fixes applied to the working tree
1. `scripts/check.sh` — added `rg` guard (fails with a clear message if ripgrep is missing instead of silently passing the panic-pattern gate).
2. `.gitignore` — added a NOTE comment about Cargo.lock handling.
3. (build-only, not committed) vendoring pipeline under `/tmp/xvendor/` + `/tmp/cargo-home/config.toml`.

## Static findings
- `unwrap()`/`expect()`: 416 sites across workspace crates (list: docs/audit/unwraps.txt).
- Non-test `panic!()/unreachable!()`: 65 sites.
- Gate `scripts/check.sh` bans `partial_cmp(...).unwrap(`; fmt + clippy(-D warnings with dead-code ceiling 82) + `cargo test --locked --no-fail-fast` + docs cross-reference check + CLI smoke test.
- `figbinary.rs` defensive parsing verified OK.
- Architecture: 3-tier backend design booleans are mutually exclusive only by convention (no compile-time guarantee).

## Dependency/vendor notes (reproducibility)
- Several lockfile entries have no reachable upstream tag at the locked version (upstreams tag independently, e.g. `ashpd` never tagged 0.8.2) → vendored at nearest tag + Cargo.toml version patched to the locked version. List: docs/audit/version-drift.txt
- `Cargo.lock` is gitignored; **recommend committing it** — it is the only record of the exact 431-package graph this build was validated against.

## Reproduce
```bash
cd X-Native
# toolchain: any 1.88+ ; vendored deps:
export CARGO_HOME=/tmp/cargo-home   # config.toml points at ../xvendor/vendor, offline=true
cargo build --locked --offline
cargo test --locked --offline --no-fail-fast
```
