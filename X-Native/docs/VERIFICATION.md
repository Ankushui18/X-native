# Local verification record — document loading screen

- Date: 7 September 2026
- Original audited base: `93d2233b83ef69ebc53699964cf87ff32790627e`
- Local branch: `fix/editor-reliability` (not pushed)
- Toolchain: Rust 1.98.1
- Platform: Linux x86_64; Mesa llvmpipe/Vulkan for GPU/native checks

| Gate | Latest result |
|---|---|
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Passed |
| `cargo test --workspace --locked --no-fail-fast` | **661 passed, 0 failed, 6 ignored** |
| Original audit invariants | All 17 still pass |
| Loading state/controller regressions | 16 passed |
| `cargo build --workspace --locked` | Passed |
| Explicit GPU storage/presentation contract | Passed separately |
| GPU-rendered loading/error/recovery visual previews | Passed separately |
| Native file-open/readiness smoke: 1 layer | Passed; 2 editor frames, 1 observed loading frame, ready=true |
| Native file-open/readiness smoke: 2,500 layers | Passed; 2 editor frames, 3 observed loading frames, ready=true |
| Native file-open/readiness smoke: 20,000 layers | Passed; 2 editor frames, 40 observed loading frames, ready=true |

The six default-ignored tests are three existing screenshot fixtures, the GPU
contract test, the CPU profile and the new loading visual-preview test. The last
three are dedicated opt-in checks; the visual previews were explicitly rendered
in this pass. Earlier GPU/CPU results remain recorded in the delivered follow-up
logs; ignored tests are not counted as normal-suite passes.

Loading frame counts above were **observed**, not required or artificially held.
The smoke includes application/GPU startup, so its wall-clock duration is not a
file-loading benchmark. A small file may legitimately complete before a loading
frame is displayed. The unit test resets the spinner clock before acknowledgement
to prove completion does not depend on an elapsed-time threshold.

The visual previews render the production loading painter through Vello. They are
deterministic UI-state previews, not evidence of delayed live file processing.
Native smoke independently exercises the real worker, cache preparation, window,
storage target, blit, resize and first-editor-presentation gate.

See [DOCUMENT_LOADING.md](DOCUMENT_LOADING.md) for requirements and acceptance
coverage. The previous 10k-node CPU experiment is in
[RESPONSIVENESS.md](RESPONSIVENESS.md); it is not a GPU FPS or 100k-node claim.

Not executed here: GitHub-hosted CI, Windows/macOS hands-on acceptance, manual
file-picker/IME testing, release signing/notarization/packaging and sustained
fuzzing. Native save/autosave still have synchronous work. Importer fidelity and
hardware/device-loss limitations are not represented as solved by this loading UI.

---

# Tooling, themes and maturity pass — 12 September 2026

Recorded separately from the document-loading record above, because the scope is
the toolkit, the theme system and the gates rather than the loading screen.
Base: `69315b0` + the work described in [`../CHANGELOG.md`](../CHANGELOG.md).
Toolchain: stable `rustc 1.98.1`, Linux x86_64.

| Gate | Result |
|---|---|
| `./scripts/check.sh` (fmt, clippy, tests, doc refs, CLI smoke) | Passed — see the run log below |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --workspace --all-targets` | 0 errors; 0 warnings outside the tracked dead-code budget (76, ratcheted in `scripts/check.sh`) |
| `cargo test --workspace` | **774 passed, 0 failed** (+7 ignored: six `#[ignore]`d opt-in GPU/screenshot tests and one `ignore`d doc-test in `x-render`) |
| `cargo build --release --workspace --locked` | Passed — cold `target/`, 5m48s, warnings only (the tracked dead code) |
| `x_native theme audit` | 3 palettes × 47 pairs, all pass WCAG AA (headroom 1.08× / 1.06× / 1.67×) |
| `x_native` end-to-end on `crates/x-format/tests/fixtures/circle.fig` (release binary) | `import-fig` → `.x` (pages=1, nodes=3, assets=0, 1 diagnostic) → `lint --preset recommended` "0 error(s), 0 warning(s) (0 rule(s) fired)" → `analyze --json` `{"colors": 2, "text": 0, "overlaps": 0, "clusters": 0}` → `info --json` (pages 1 / nodes 3 / frames 2) → `export -f svg` 464 bytes |
| `cargo test --release -p x-designer --bin x_native` / `-p x-native mcp` | 6 passed / 7 passed (the CI job runs both in release) |
| `x_native theme audit --theme bogus` | `theme: unknown theme 'bogus' (try: graphite, daylight, high-contrast)`, exit 2 |
| `x_native lint --list-rules` (no file) | 15 rules, exit 0 |
| CLI exit codes | 0 ok · 1 missing node · 2 usage/unknown theme · 3 no match · 4 findings/contrast · 5 round-trip mismatch, asserted by `verbs_return_their_documented_exit_codes` |

Gate log (tail, this machine):

```
==> formatting (cargo fmt --check)
    ok tree is formatted
==> lints (cargo clippy --workspace --all-targets)
    ok no lints outside the dead-code budget
    ok dead code 76 / ceiling 76        # ceiling lowered from 88 during this pass
==> tests (cargo test --workspace --locked)
    ok 774 passed, 7 ignored (opt-in GPU/screenshot tests)
==> docs references
    ok every docs/*.md referenced from the sources exists
==> CLI smoke (x_native)
    ok --version · ok --help · ok theme audit: all palettes pass WCAG AA
    ok lint --list-rules · ok unknown input exits 2 (usage)
```

**Since this record was taken.** The log above is the 7 September pass and is left
as written; two of its numbers are no longer current. The dead-code ceiling is
**82**, not 76: the tree stopped compiling after this pass, and a workspace that
does not build reports no dead-code diagnostics at all, so the count was
remembered rather than measured until the first gate run that could see the whole
workspace again (84 warnings, of which none belonged to the branch that found
them). `KNOWN_DEBT.md` §1 names every item and records why the ceiling moved.
The suite is **896 passed, 6 ignored** as of 16 September 2026, gate exit 0 on
`arena/01a0a5bd-x-native`.

## What was deliberately changed in the default theme

Three colors in the shipped dark palette moved because they failed AA, not for
taste. Each is a claim a user can verify with `x_native theme audit`:

- `text_secondary` `#9A9EAA` → `#B0B5C1` (was 3.87:1 when painted on an active
  row);
- `danger` as *text* `#D9534F` → `#EF9A94` (2.6–4.6:1 in destructive menus —
  the red remains as a fill for badges);
- `accent` fill `#7C5CFC` → `#6B49F5`, so white button labels clear 4.5:1
  (5.39:1). `#7C5CFC` survives as the `selection` role, and a new `accent_ink`
  role (`#B4A4FF`, 7.78:1) carries accent-colored text and links.

`text_placeholder` and the hairline `border` are exempt from the 4.5:1 text
floor (WCAG excludes disabled content and pure hairlines); selection and focus
indicators are held to 3:1.

## Not verified here

- No remote CI ran: `.github/workflows/ci.yml` is in-tree and its steps were
  replayed locally (including the release build and the fixture pipeline), but
  no Actions runner has executed them for this commit. Every step in the
toolkit job was nevertheless replayed by hand against the release binary, with
the outputs recorded above, so the workflow is not a wish.
- The theme switch is not persisted across restarts, and the right-click menu's
  parallel `ContextPaintCommand` renderer stays unwired — both are itemized in
  [KNOWN_DEBT.md](KNOWN_DEBT.md) rather than claimed as done.
- Visual parity of Daylight/High Contrast was checked by unit tests and by
  asserting that every chrome color resolves through a role; no pixel-diff
  fixture exists per theme (the repository has no visual-oracle harness).
