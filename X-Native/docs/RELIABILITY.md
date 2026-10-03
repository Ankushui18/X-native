# Reliability patch — 7 September 2026

Implementation branch: `fix/editor-reliability`. Based on
`93d2233b83ef69ebc53699964cf87ff32790627e`. No GitHub push is part of this patch.

## Document loading

[DOCUMENT_LOADING.md](DOCUMENT_LOADING.md) records the loading-screen requirement,
state machine and acceptance coverage. Foreground opens now use a real-stage
loading screen and a first-presentation input gate, with retry/close/recovery states.

## Follow-up

See [RESPONSIVENESS.md](RESPONSIVENESS.md) for the next pass: cancellable background
imports/exports, bounded UI text caching, visible layer rows, copy-on-write assets,
font snapshots and conflict-safe autosave recovery.

## Run

Install Rust through rustup; `rust-toolchain.toml` selects **1.98.1**.

```sh
cargo run --locked -p x-designer --bin x_native_app
# Explicit visual fixtures, never the normal startup:
cargo run --locked -p x-designer --bin x_native_app -- --demo
```

The default is an empty local workspace with real persisted recents. New files
contain an empty page. The HTML under `ui/` remains the visual reference, not a
specification for fake data or placeholder behavior. The active application is
`apps/x-designer/src/bin/x_native_app/main.rs`. Dormant shells and legacy rendering
APIs remain for compatibility; they are not the active canvas path.

On Debian/Ubuntu X11, install `libxkbcommon-x11-0`, `libxkbcommon0`, `libx11-6`,
`libvulkan1` and an appropriate Vulkan driver (`mesa-vulkan-drivers` for software
rendering). File pickers require a desktop session with `xdg-desktop-portal` and
a matching implementation such as `xdg-desktop-portal-gtk`. Xvfb is for CI only.

## Save and recovery rules

The UI reads native v1/v2 files and writes v2 envelopes, preserving native metadata.
An older v1-only UI build may not open files saved by this updated application.

- Opening SVG, PNG, Sketch or Figma REST JSON creates a **new unsaved document**.
  Its source is not its native save path. Ctrl/Cmd+S asks for a `.x` destination.
- Save commits pending inline text/fields, synchronizes **all pages**, validates
  the result, rotates three backups and atomically replaces the native file.
  Temporary files are exclusively created, synced and renamed in the same
  directory. Unix directory metadata is synced as well.
- Native saves use an OS advisory lock. A changed on-disk fingerprint prevents
  silently replacing another writer's work; use Save As or reopen to reconcile.
  A zero-byte `.x.lock` file may remain; the OS lock releases on process exit.
- Close offers **Save / Discard / Cancel**. Failed saves and cancelled Save As
  keep the document open. During whole-window close, tabs already explicitly
  saved/discarded may close before a later cancellation; remaining work stays.
- Autosave runs every **30 seconds**, including buffered inline text without
  ending the edit. Named documents use `.x.autosave`; unnamed/imported documents
  use the application's recovery directory. A successful explicit save or
  explicit discard clears that document's recovery snapshot.
- Newer autosaves are offered on open/startup. Equal/older sidecars do not
  supersede a saved file. Damaged native files can recover an intact backup,
  or an explicitly labelled partial repair, into a new unsaved copy.
- `X_NATIVE_DATA_DIR` overrides application storage. Otherwise OS/XDG local
  application data directories hold recents, stars and unnamed recovery files.

## Audit disposition

| Audit area | Implemented in this patch | Remaining boundary |
|---|---|---|
| F01 native GPU target | Rgba8Unorm storage texture, separate presentation blit, resize handling | Hardware/OS matrix still needs real-user testing |
| F02–04 save/close/recovery | Source separation, decisions, all-page save, atomic writes, checked backups, autosave, recovery and conflict detection | Native save/autosave remain synchronous; imports/exports use a bounded worker; OS/network filesystem semantics vary |
| F05 identities | Process-unique monotonic IDs, insertion/group guards, reference remapping, stable detach identity | IDs are not security tokens; legacy per-page identity scope remains |
| F06 camera/DPI | One canvas affine/inverse and logical resize handling; cursor-anchored zoom | No touch/tablet device QA |
| F07 text input | Focused Space, IME commit/preedit/candidate anchor, grapheme navigation/deletion, multiline motion, local text undo and focused shortcuts | Native IME composition and non-Latin font coverage require desktop QA |
| F08–09 resources/rendering | Persistent PNG/JPEG decode cache; canonical IR canvas; cache/registry fixes; shared glyph geometry and correct group compositing | Importers remain subsets of external formats, not lossless converters |
| F10 export | Explicit page/selection scope, all selected roots, conservative bounds/rebasing, stroke/text outlines, assets, correct raster scaling, atomic output | PNG is transparent; JPG/PDF use white paper. PDF rasterizes unsupported transparency/blending and reports it |
| F11–12 ownership/history | Authoritative editor roots, read-only paint, document transactions for pages/comments/properties/title, saved revision tracking | Document-level transactions still use snapshots; history memory is a soft estimate |
| F13 clipboard | Application ownership, world placement, assets/masters/overrides, atomic paste/undo | Conflicting resource names/modes and overlapping dependency graphs are rejected rather than guessed; external prototype targets may need reconnection |
| F14 clipping | Inspector reads/writes actual overflow; undo, serialization and export coverage | Advanced scroll/prototype authoring is not complete |
| F15–16 untrusted data | XML escaping, strict JSON and schema checks, finite/resource admission, bounded ZIP expansion and CRC, decoded/raster budgets, cycle checks | This is hardening, not a security certification; sustained fuzzing and hard syscall/decode deadlines remain work |
| F17 comments | Transactional page-index remapping, delete semantics and undo | Duplicating a page deliberately does **not** duplicate comments; collaboration is not implemented |
| F18 product honesty | Empty startup, explicit demo, real recents/stars, missing-file errors, visible feedback, disabled unsupported workspaces | Assets/Tokens browsers, Prototype UI/player, teams, templates and billing are not shipped features |
| F19 release gates | Locked build/test/lint/format CI, toolchain pin, GPU/native-surface job, portable packaging script, font notices | Remote CI and Windows/macOS were not executed in this local session; signing, notarization and project code licensing need maintainer work |
| F20 application path | Persistent FrameCache/Assets, viewport culling, shallow shell copies, bounded transaction count and text history; fixed avatar leaks | Hashing/hit-testing remain linear; no 100k-node/GPU frame-time claim; a 10k-node CPU comparison is recorded in RESPONSIVENESS.md; native save/autosave offloading and profiling remain |

### Input and memory policy

Independent limits include 64 MiB input, two million JSON values, JSON depth 512,
100,000 nodes and model depth 256, finite/bounded geometry, bounded component
expansion, 32 MiB per ZIP entry / 128 MiB declared total expansion, 16 megapixels
per image, 128 MiB decoded image cache, and 16 megapixels / 256 MiB work surfaces
for raster export. A document may hit one budget before another. These checks
reject unsafe work rather than promise every large input will fit every machine.

Document history retains up to 128 complete transactions with a soft 64 MiB
estimate, keeping at least the newest transaction even if it is larger. Inline
text history has separate 64-entry / 8 MiB soft limits. Unused embedded assets may
remain after undo so live references are never dangling.

## Verification

The latest local results are recorded in [VERIFICATION.md](VERIFICATION.md),
including the separately run GPU contract and native-window smoke.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked --no-fail-fast
cargo build --workspace --locked
cargo test -p x-designer --bin x_native_app --locked gpu_storage_and_blit_contract -- --ignored --nocapture
```

For the native surface path (not an offscreen screenshot substitute):

```sh
mkdir -p /tmp/x-native-runtime /tmp/x-native-smoke
chmod 700 /tmp/x-native-runtime
XDG_RUNTIME_DIR=/tmp/x-native-runtime X_NATIVE_DATA_DIR=/tmp/x-native-smoke \
  LP_NUM_THREADS=1 WGPU_BACKEND=vulkan \
  xvfb-run -a -s '-screen 0 1600x1000x24' target/debug/x_native_app --smoke-test
```

This launches the actual window, renders its UI to the production storage target,
blits to the swapchain, resizes and presents at least three frames before exiting.
It is **not** a manual click-through or a full native IME/dialog acceptance test.
`LP_NUM_THREADS=1` kept Mesa software rendering within this sandbox's memory limit.

The 17 independent audit invariants now live in `regression_tests.rs`, alongside
close/recovery, resource, clipboard, export-pixel and revision tests. Tests use
production policy/helpers instead of reimplementing old buggy expressions.
Existing screenshots/inspector fixtures now request demo content deliberately.
Invalid test ZIP fixtures were corrected to carry real CRCs; CRC validation was
not weakened to accommodate them.

## Packaging

```sh
python3 scripts/package.py
```

This builds a release binary and creates a portable ZIP/checksum under `artifacts/`.
It does not publish, sign or notarize anything. Bundled font licenses are included.
The maintainer has not supplied a project code license: packages without one are
labelled **internal evaluation builds**, not licensed public releases.
