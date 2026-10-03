# Responsiveness and background file work — follow-up

This follow-up continues `fix/editor-reliability`; it does not publish a GitHub
branch or release. A file can be opened at launch with
`cargo run --locked -p x-designer --bin x_native_app -- --open path/to/file.x`. See [VERIFICATION.md](VERIFICATION.md) for local gate results.

## Document loading screen

The subsequent [loading-screen implementation](DOCUMENT_LOADING.md) gives foreground
opens an immediate modal loading surface and a first-native-presentation readiness
gate. The worker remains asynchronous; the old/candidate editor is deliberately
not interactive while the foreground loading screen is displayed.

## Background imports and exports

Opening/importing documents, scanning startup recovery files and exporting now run
on one lazily created file worker. The queue is bounded: another heavy request is
refused while the current request is active, instead of spawning unlimited jobs
or accumulating full-document snapshots. UI event processing and drawing keep running. Foreground document loading uses the
modal surface described above; background exports do not block editing.

- The status bar shows progress and a **Cancel** action. Escape cancels a file
  operation when a text field/editor does not own the keyboard.
- Cancellation is cooperative: bounded reads, JSON values/strings, SVG tags,
  ZIP entries, image decode batches, raster commands and output writes check it.
  A single filesystem call, image frame or shaping stage is not forcibly killed.
- Atomic output has an explicit publication boundary. If cancellation wins before
  rename, the previous destination remains unchanged. Once publication begins,
  cancellation reports that the write is finishing; it does not pretend to undo
  a file already written.
- Late/cancelled read results are never published as surprise new documents.
  Successful opens stay in a background tab if the user has resumed editing,
  switched documents or is composing text/comments.
- Exports use the document/font/image snapshot captured at request time. Later
  edits stay in the live document and do not race the exporter.
- Window close waits for an active export's cancellation/commit acknowledgement
  before proceeding through the existing Save/Discard/Cancel policy.

**Still synchronous:** explicit native saves, autosave snapshots/writes, small
recent/star updates and native dialogs. The UI-side model snapshot is also an
O(number of nodes) clone. This patch does not claim all blocking work has gone.

## Memory and cache changes

- AssetStore clones share a copy-on-write map instead of duplicating image bytes
  on every snapshot. An embedded transfer promotes an external-only record, so
  deduplication cannot accidentally omit the image from the saved file.
- Font snapshots share immutable bytes, but keep mutable glyph-outline caches
  thread-local. Font collection epochs are globally distinct, preventing two
  different collections with equal load counts from aliasing the global cache.
- UI text uses bounded cached scenes (2048 entries / approximately 16 MiB).
  Position is not part of the key; size, color, font collection, letter/word
  spacing and variation axes are. Width cache keys now use exact sizes and
  font epochs, and are bounded to 4096 entries.
- The layer panel creates metadata only for visible rows. It no longer clones
  every offscreen vector/text node kind or rescans the whole tree for each visible
  row's lock/visibility flags. Multi-selection is reflected in row highlighting.
- Remaining inspector-only full-root clones were removed.

## Additional safety fixes

The native conflict fingerprint now comes from the exact bytes decoded, not a
later reread that could belong to another writer. Autosave checks that fingerprint
under the native save lock. If the file changed or the writer is busy, unsaved work
is written to the document's separate recovery file rather than a misleading newer
sidecar beside another writer's file.

Provisional IME composition and nonempty unposted comments block destructive context
switches until they are finished/cancelled. The recursive JSON parser's large string
escape decoder was separated from its container stack frame; the existing depth
ceiling is tested on a normal 2 MiB thread stack.

## Reproducible CPU experiment

```sh
cargo test --locked -p x-designer --bin x_native_app \
  profile_editor_cpu_frames -- --ignored --nocapture
```

This runs **App::compose_frame**, the same logical UI/canvas composition path that
the native window calls. Fixture: 10,000 rectangles; 1440×900 logical window;
empty selection; panel at top and around row 9000; three warmups, fifteen samples.
Both measurements used the same unoptimized test profile, single build job, debug
information disabled, and the same Linux sandbox.

| Layer-panel position | Before median | Initial after median | Final rerun median |
|---|---:|---:|---:|
| Top | 116.740 ms | 9.345 ms | 8.304 ms |
| Around row 9000 | 130.384 ms | 8.502 ms | 10.329 ms |

The experiment excludes GPU rendering/presentation, hit testing and disk I/O; it
is **not** a release-build FPS claim or a 100k-node acceptance result. Run-to-run
variation is expected. The final rerun is saved with the delivered verification
logs. Sustained profiling, hardware/platform coverage and offloading native
save/autosave remain further work.
