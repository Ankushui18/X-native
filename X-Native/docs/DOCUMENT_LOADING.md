# Document loading screen requirement and implementation

## Requirement

When a user opens a file, X-Native immediately enters a loading screen or overlay
while the **actual** document-loading work runs.

- Small files proceed as soon as they are ready. They may finish before a loading
  frame reaches the display; the application must not add a delay to force one.
- Medium files show an indeterminate loading indicator while work is pending.
- Large/complex files keep that feedback visible until initialization and rendering
  preparation finish.
- No artificial minimum duration, fake percentage, timer-based completion, or
  file-size-derived progress estimate is allowed.

Where observable work exists, meaningful stages may be shown: reading, parsing or
decompressing, validating, constructing the document, loading assets, preparing
rendering/caches, and handing off to the editor. Stages reflect the real order for
each format, not a scripted animation. Accurate percentages are not currently
available, so the UI uses an indeterminate spinner.

Expected flow:

**Open requested → loading state → read/parse/import → validate → build editor
state → load assets → prepare rendering/cache → successful first native
presentation → interactive editor.**

The editor must never expose an intermediate or inconsistent loading candidate.
Errors must become actionable: **Try Again** and **Close** are required. Existing
work, imported sources, native files and recovery snapshots must not be discarded
because an open was cancelled or failed.

## Implemented state machine

`loading.rs` owns the presentation state:

1. **Working:** current real stage and animated indeterminate spinner.
2. **Recovery choice:** choose the newer recovery or the saved native version.
3. **Failed:** error details, Try Again, Close, and Recover a copy when appropriate.
4. **Presenting:** CPU initialization is complete, but input is still blocked.
5. **Ready:** the native host has rendered, blitted and presented the first editor
   frame; loading state is removed immediately.

The normal foreground loading screen covers the document area/window rather than
painting the old or candidate document underneath every animation frame. It uses
the existing Graphite/Signal colors, typography and native Vello UI primitives.
Keyboard access is Tab/Shift+Tab, Enter/Space, and Escape.

## Connection to real work

- Loading state and redraw are requested on acceptance, **before** submitting work.
  A single pending open may wait behind the existing bounded worker; its truthful
  label is “Waiting for the file worker.” Cancelling it does not cancel an unrelated
  export already writing a file.
- The worker sends bounded, ticketed stage events. Old/cancelled jobs cannot change
  a newer load or replace an error screen with stale progress.
- Existing native/import validation, byte/depth/expansion limits, resource decoding,
  conflict fingerprints and cancellation remain the same admission boundaries.
- Render-required image and component references must be resolved before readiness.
  A missing component master produces a readiness error instead of a blank instance. Missing,
  damaged or unsupported required images produce a loading error instead of
  publishing gray placeholders. This does not claim lossless conversion of every
  external-format feature; importer fidelity limits still apply.
- The worker prepares the first page's actual canonical FrameCache for the shared
  initial camera/viewport and font collection. Data for all pages and document
  assets is initialized; other viewport/page cache updates remain normal editor
  work rather than pre-encoding every possible view.
- If window geometry or fonts change during preparation, the loaded model is
  prepared again for the new inputs **without rereading the file**.
- At handoff, editor input remains blocked. The last loading frame stays on screen
  while the complete editor frame is rendered. The host removes the gate only
  after the real storage-target render, surface blit and `present()` succeed.
- Transient first-surface acquisition failures are retried; persistent failures
  become an error state. Minimizing to zero pixels is not treated as a file failure.

`Instant`/elapsed time only chooses the spinner angle and its redraw cadence.
There is deliberately no duration condition in the readiness/presentation callback.

## Safety, recovery and ownership

- A newly inserted but unpresented candidate is input-inaccessible and excluded
  from autosave. Cancelling/closing its error rolls it back and restores the
  previous active document/camera. Existing dirty work is retained.
- Closing or retrying never deletes the failed input or a recovery source. Newer
  autosave decisions are part of the loading screen. Prefix/backup repair remains
  an explicit, labelled recovery-copy action.
- Normal autosave protection continues for existing documents. Native saves and
  autosave writes still have synchronous work; this change is not represented as
  a complete asynchronous-persistence rewrite.
- Native file-picker dialogs and startup recovery selection remain native UI.
  Once a selected recovery starts loading it uses this same loading/ready flow.
- If a read was deliberately backgrounded through the existing reliability
  coordinator and editing context changed, the prepared document can remain in a
  background tab rather than replacing ongoing input.

## Verification

Sixteen `run::loading_tests` regressions exercise the production worker and controller, including:

- immediate state/input isolation before any worker result;
- real ticketed stages, stale-event suppression and indeterminate animation;
- cache preparation and presentation acknowledgement without a minimum time;
- file failure, retry, close and previous-work restoration;
- required-asset failures and saved-versus-recovered decisions;
- viewport changes both during loading and before first presentation;
- failed first rendering and candidate rollback;
- keyboard actions and cancellation while another export owns the worker.

The headless tests inject only the final presenter acknowledgement. The dedicated
native smoke uses the actual window/swapchain and reports editor frames, loading
frames and `load ready=true`. No assertion requires a small file to display the
spinner for any fixed duration.

```sh
cargo test --locked -p x-designer --bin x_native_app loading_tests
cargo run --locked -p x-designer --bin x_native_app -- --open project.x
# Native presentation smoke (software Vulkan/Xvfb requires the Linux packages
# listed in RELIABILITY.md):
LP_NUM_THREADS=1 WGPU_BACKEND=vulkan xvfb-run -a \
  target/debug/x_native_app --smoke-test --open project.x
```

Optional deterministic **UI visual previews** use the production loading painter
and Vello GPU rendering; they are not an artificial delay in file loading:

```sh
X_NATIVE_LOADING_PREVIEW_DIR=/tmp/loading-previews LP_NUM_THREADS=1 \
  cargo test --locked -p x-designer --bin x_native_app loading_screen_visuals \
  -- --ignored --nocapture
```
