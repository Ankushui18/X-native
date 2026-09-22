# X-Native exhaustive Figma parity audit

Date: **2026-09-22** (Asia/Calcutta)
Branch audited: `arena/01a0c762-x-native` (the checked-out session branch)
Requested comparison URL: `arena/01a0c0d4-x-native` (not checked out in this session)
Product UI audited: `X-Native/apps/web` only
Reference: Figma Design help, not a claim that X-Native is Figma-complete.

## Executive result

This deliverable is an **audit only**; no product feature work was performed as part of
this report. The implementation is not at 100/100 Figma parity. The code-level audit
finds strong coverage of the core canvas/editor path, but substantial gaps in export,
prototype, collaboration, import, rich text, masks, vector editing, and transformed
rendering. Scores below are feature-level final scores; they must not be interpreted as
a validated Figma-equivalence claim. A browser replay and pixel-diff pass remains
required before assigning a definitive product-wide score.

This report is the feature-by-feature record for the current PR pass. It covers the
controls and behaviours that exist in the web designer, including the extra tools that
were already present in the last design. It deliberately records gaps instead of
silently treating them as matches.

## How scores work

Scores are **parity-confidence scores from 0–100**, not pixel-test results:

* **Pre** is the code-review score at the start of this refinement pass, before the
  fixes listed in the Changes column.
* **Final** is the score after the changes in this worktree and the engine matrix.
* A score of 90+ means the principal path and the documented edge cases are represented
  in code; it does not mean an unavailable browser replay proved pixel equality.
* `MV` means manual/visual verification is still required. The sandbox has no Chromium,
  Chrome, Firefox, Playwright, or Puppeteer, so no honest screenshot or pointer replay
  is claimed here.

## Figma reference set

The baseline was checked against these Figma Design articles:

* [Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
* [Shape tools](https://help.figma.com/hc/en-us/articles/360040450133-Shape-tools)
* [Guide to text in Figma Design](https://help.figma.com/hc/en-us/articles/360039956434/Guide-to-text-in-Figma-Design)
* [Explore text properties](https://help.figma.com/hc/en-us/articles/360039956634/Explore-text-properties)
* [Guide to fills](https://help.figma.com/hc/en-us/articles/360041003694/Guide-to-fills)
* [Use gradients as a fill or stroke](https://help.figma.com/hc/en-us/articles/34208860210199/Use-gradients-as-a-fill-or-stroke)
* [Apply and adjust stroke properties](https://help.figma.com/hc/en-us/articles/360049283914/Apply-and-adjust-stroke-properties)
* [Apply effects to layers](https://help.figma.com/hc/en-us/articles/360041488473/Apply-effects-to-layers)
* [Boolean operations](https://help.figma.com/hc/en-us/articles/360039957534/Boolean-operations)
* [Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373/Guide-to-auto-layout)
* [Guide to components](https://help.figma.com/hc/en-us/articles/360038662654/Guide-to-components-in-Figma)
* [Create and use variants](https://help.figma.com/hc/en-us/articles/360056440594/Create-and-use-variants)
* [Guide to prototyping](https://help.figma.com/hc/en-us/articles/360040314193/Guide-to-prototyping-in-Figma)
* [Export from Figma](https://help.figma.com/hc/en-us/articles/360040028114/Export-from-Figma)

## Validation gates actually run

| Gate | Result |
| --- | --- |
| `npm run build` in `X-Native/apps/web` | **PASS** — TypeScript build and Vite production build, 42 modules |
| `git diff --check` | **PASS** |
| Compiled `MemoryEngine` matrix | **PASS** — add/move/resize, undo/redo, grid, lock/hide, groups, reparent cycle guard, paste, booleans/flatten, pages, transforms, prototype stack, auto layout, components/variants, pen/outline, distribute/flip, no-op gestures |
| Nested transformed-parent engine probe | **PASS** — matrix hit testing and deepest-frame placement for rotated parent |
| Vite preview HTTP smoke | **PASS** on port 5173 during this PR pass |
| Browser pointer replay / screenshot diff | **NOT RUN** — browser automation is not installed in the sandbox |
| Rust workspace gate | **PASS remotely** — GitHub `scripts/check.sh`: 914 tests passed, zero ignored, clippy and design guard green |
| Opt-in Rust software-Vulkan screenshot suite | **PASS remotely** — GitHub `Screenshots (software Vulkan)` job passed |
| Local Rust toolchain | **NOT RUN locally** — `cargo` is not installed in the sandbox; the remote gate is the Rust validation source |

The matrix and CI prove command/model invariants; they do not replace Figma's browser
canvas or a human visual comparison. Scores marked MV remain open for that reason.

## 1. Product shell, navigation, and chrome

| Feature / option | Pre | Figma difference or issue found | Changes made in this pass | Final | Remaining limitation |
| --- | ---: | --- | --- | ---: | --- |
| Single web product UI | 92 | Figma has one editor chrome; the old native chrome was a competing surface | Kept the React web designer as the only product chrome; Rust remains headless/export | 98 | No remote file/session backend |
| X product mark | 100 | It must not be replaced by Figma's mark | Preserved the custom X logo | 100 | Intentional product difference from Figma |
| Light theme | 88 | Figma's light UI has measured neutral surfaces and selection blue | Retained UI3 light tokens and shared icon/chrome styles | 92 | MV; exact spacing/palette screenshot still required |
| Dark theme | 88 | Figma's dark canvas/panel relationship must stay consistent | Retained dark palette and user-art non-inversion | 92 | MV; no Figma pixel oracle |
| Graphite theme | 90 | Not a second GUI in Figma; it is an existing X-Native theme | Kept it as a theme preference, not a separate app surface | 94 | Extra theme, intentionally outside Figma |
| Daylight theme | 90 | Same as Graphite | Kept it as a theme preference | 94 | Extra theme, intentionally outside Figma |
| System theme | 84 | Figma follows system preference; theme should react to OS changes | Existing `matchMedia` listener and localStorage preference retained | 92 | Browser/system verification is MV |
| X-native theme persistence | 80 | Preference should survive reload | Existing localStorage read/write retained | 90 | Private browsing/storage failures are handled by fallback only |
| Navigation rail | 84 | Figma's current navigation placement differs from this product's compact rail | Kept one compact rail and custom X mark; no second native rail | 88 | Layout is an intentional approximation; MV |
| File tab / file name | 82 | Figma commits a file rename as a product-level action, not one undo per key | File-name updates no longer create one undo entry per keystroke | 90 | No file browser or cloud save |
| File menu | 80 | Figma menu actions should be keyboard and pointer reachable | X logo menu retains file reset, actions, undo, redo, duplicate, delete, themes | 88 | “Back to files” is local reset, not a file browser |
| Actions / quick command palette | 78 | Existing tools were not all searchable | Added Section, Slice, Polygon, Star; Present uses the App presentation path | 90 | No plugin marketplace/actions backend |
| Shortcut help panel | 76 | The help list was stale and called Shift+E Eraser | Added Scale and changed Shift+E label to Design / Prototype | 87 | The full Figma shortcut browser is not reproduced |
| Left panel resize | 88 | Figma has bounded dock resizing | Existing bounded pointer drag retained | 92 | MV for pointer edge cases |
| Right panel resize | 88 | Same dock constraint | Existing bounded pointer drag retained | 92 | MV for pointer edge cases |
| Minimize UI | 90 | Figma supports compact UI states | Existing `min-ui` state retained | 93 | Exact Figma compact geometry is MV |
| Hide UI | 90 | Figma's hide-UI scope and shortcut are specific | Existing `hide-ui` state retained | 93 | No multi-user/cursor UI to hide |
| File notifications | 40 | Figma has real notifications; this local product shows an alert | Audited as an existing placeholder; not expanded | 42 | Deliberate local-only limitation |
| Share | 45 | Figma opens sharing/permissions; ours copies a local URL label | Audited only; no backend added | 48 | No sharing, permissions, or published link |
| Assets tab | 78 | Figma searches local/team libraries and places instances | Existing local component search and double-click placement retained | 84 | No external/team libraries |
| Variables tab | 45 | Figma has typed variables, collections, modes, aliases, and bindings | Audited existing color collection surface; no new variable system added | 46 | Existing pane is not Figma Variables-complete |
| Tools tab | 62 | Figma does not use a generic plugins pane for these commands | Wired existing buttons to real engine actions instead of opening an empty palette | 78 | No plugin runtime |
| Agent tab | 35 | Not part of this quality pass; user explicitly made it last priority | Audited and left scoped; no AI/agent feature work added | 35 | Existing placeholder is not Figma parity |

## 2. Tools, tool options, and creation paths

| Feature / option | Pre | Figma difference or issue found | Changes made in this pass | Final | Remaining limitation |
| --- | ---: | --- | --- | ---: | --- |
| Move / Select (`V`) | 90 | Topmost selection and nested selection must agree with transforms | Kept command path; matrix hit test now handles rotated/flipped parents | 95 | Canvas overlay geometry for nested transforms is still MV |
| Scale (`K`) | 84 | Figma scales contents, text, strokes, radii, and effects together | Existing `scaleProps` path and scale tool retained in the audit | 89 | No visual replay; some nested transform cases remain |
| Frame (`F`) | 88 | Click/drag/preset creation and nesting under the pointer | Existing frame presets and host-frame placement retained | 93 | Default-size history and exact preset catalogue differ |
| Section (`Shift+S`) | 82 | Figma sections are organisational containers with section chrome | Existing frame-backed section tool retained and surfaced in command search | 87 | Section is represented by the frame model, not a distinct node kind |
| Slice (`S`) | 60 | Figma slices are export regions, not ordinary rectangles | Audited current dashed rectangle path; no new slice model added | 62 | Export semantics and slice-specific selection are incomplete |
| Rectangle (`R`) | 92 | Constrain with Shift and draw from centre with Alt | Existing creation modifiers and rounded-corner model retained | 95 | MV |
| Ellipse (`O`) | 82 | Figma exposes arc/start/ratio handles after creation | Existing ellipse creation retained | 86 | Arc handles are not implemented in this web surface |
| Line (`L`) | 90 | One stroked segment with cap/join/dash controls | Existing line path and stroke controls retained | 94 | MV for all cap/scale combinations |
| Arrow (`Shift+L`) | 84 | Arrow direction follows the drawn endpoint, including vectors | Corrected vector arrowhead orientation and kept line/arrow rotation | 92 | Arrowhead shape/scale is an approximation |
| Polygon | 84 | Shape-menu polygon with Count control | Existing count control clamped to 3–60; command palette now surfaces it | 91 | No Figma-style on-canvas count handle |
| Star | 84 | Count and inner-radius/ratio control | Existing count and ratio controls retained and clamped | 91 | No on-canvas star handles |
| Place image / video menu item | 64 | Figma's row is Image/video and supports place, crop, and video | Existing image tool remains reachable in toolbar, Actions, and drag/drop | 76 | Video and full crop workflow are not supported |
| Pen (`P`) | 78 | Click anchors, drag Bézier handles, close on first point, preview next segment | Existing pen draft, close, curve handles, and vector path retained | 86 | Rubber-band preview, vector-network topology, and boolean-quality curves are limited |
| Pencil (`Shift+P`) | 76 | Freehand is smoothed and remains active | Existing sampled freehand path retained | 84 | Smoothing/fit quality is approximate; no browser visual proof |
| Brush (`B`) | 70 | This is a Figma Draw-style extra, not normal Figma Design | Existing brush path/stroke width retained; no scope expansion | 75 | Extra tool; not Figma Design parity |
| Eraser | 68 | Figma Design does not expose this exact tool; Draw's eraser is stroke-aware | Existing hit/delete eraser retained; Shift+E is no longer claimed for it | 74 | Deletes hit layers, not portions of vector strokes |
| Text (`T`) | 87 | Click auto-width, drag fixed box, then edit in place | Existing click/drag creation and measured overlay retained; multiline overlay measurement fixed | 91 | Rich text ranges, links, lists, OpenType, and font loading are incomplete |
| Hand (`H`) | 90 | Hand tool and temporary Space pan | Existing hand and Space pan paths retained | 94 | MV |
| Comment (`C`) | 58 | Figma creates threaded comments with replies and resolve state | Audited existing comment-pin ellipse path; no collaboration feature added | 60 | No thread, author, reply, resolve, or backend |
| Resources button | 55 | Figma Resources opens community/plugins/widgets | Existing button opens Actions | 58 | No resources marketplace |
| Dev Mode button | 84 | Figma toggles Design/Dev Mode with inspect/code tools | Existing Inspect tab and Shift+D retained | 89 | Inspect surface is CSS-only, not full Figma Dev Mode |

## 3. Canvas gestures and pointer interactions

| Feature / option | Pre | Figma difference or issue found | Changes made in this pass | Final | Remaining limitation |
| --- | ---: | --- | --- | ---: | --- |
| Click select | 90 | Selection must use the same geometry as the canvas | Engine hit testing now uses affine matrices for nested rotation/flip | 95 | Canvas overlay is still additive for some nested cases |
| Shift-click add/remove | 90 | Add/remove selection without losing current selection | Existing selection toggle retained | 94 | MV |
| Cmd/Ctrl-click deep select | 88 | Deep select must traverse frames/groups and transforms | Matrix-aware hit test keeps deep mode | 94 | Component-instance editing semantics are limited |
| Marquee select | 82 | Figma selects by object intersection and respects transforms | Audited current marquee path | 84 | Canvas marquee still uses additive rectangles; rotated nested layers can differ |
| Deep marquee | 80 | Cmd/Ctrl marquee includes nested children | Existing deep traversal retained | 84 | Same transformed-parent limitation |
| Drag move | 86 | Drag distance is in page space; one gesture is one undo step | Existing grouped gesture and no-op cleanup retained | 91 | Memory move still stores local deltas, so rotated parents need more overlay work |
| Alt-drag duplicate | 86 | Duplicate occurs once at gesture start and then moves | Existing duplicate arm retained | 90 | MV; nested transform placement limitation |
| Shift axis constrain | 91 | First dominant axis wins for the drag | Existing axis rider retained | 94 | MV |
| Corner resize | 84 | Handles, opposite corner, modifiers, transforms | Existing resize and text sizing rules retained | 88 | Nested transformed-parent handles are not fully matrix-aware |
| Shift resize | 90 | Preserve aspect ratio | Existing aspect lock / Shift path retained | 93 | MV |
| Alt resize | 90 | Resize from centre | Existing from-centre path retained | 93 | MV |
| Scale-tool resize | 82 | Contents scale, unlike normal resize | Existing `scaleProps` path retained | 87 | Effect/constraint edge cases need visual replay |
| Rotate handle | 80 | Figma uses a rotation handle and 15° Shift snapping | Existing rotation handle and snapping retained | 86 | Handle position and origin are not fully nested-transform-aware |
| Flip horizontal/vertical | 84 | Flip geometry without changing visual bounds unexpectedly | Existing flip plus corner/child adjustment retained | 89 | Nested children and rotated-parent flips are approximate |
| Space while panning | 90 | Temporary hand tool should pan without changing tool | Existing Space key state retained | 94 | MV |
| Space during resize/create | 54 | Figma moves the in-progress box while preserving the active operation | Audited current path | 58 | This web canvas does not fully implement Figma's mid-gesture Space rider |
| Wheel pan | 88 | Wheel pans canvas; trackpad deltas should be preserved | Existing wheel path retained | 92 | Device-specific trackpad behavior is MV |
| Cmd/Ctrl-wheel zoom | 90 | Zoom around pointer and clamp range | Existing pointer-centred zoom and pan correction retained | 94 | MV |
| Zoom toolbar control | 80 | Figma has numeric zoom menu and view commands | Existing cycle/right-click control retained | 86 | Not the full Figma zoom menu |
| Gradient handle drag | 78 | Handles stay in object-local space through transforms | Existing on-canvas two-handle editor retained | 85 | Nested transformed-parent handle coordinates remain limited |
| Vector anchor drag | 80 | Anchors/handles edit in local vector space | Existing vector edit, delete, and curve toggles retained | 86 | Vector networks and compound paths are incomplete |
| Pen first-point close | 84 | Close target and Enter/Escape semantics | Existing close-on-first-point and keyboard finish/cancel retained | 90 | MV |
| Pencil/brush stroke finish | 82 | One stroke should be one undo step | Existing addPath path and active-tool behavior retained | 88 | Smoothing is approximate |
| Eraser click/drag | 62 | Stroke-aware erase differs from deleting whole layers | Existing layer delete behavior retained | 68 | Deliberate limitation of the existing tool |
| Text enter edit | 84 | Figma enters selected text on Enter | Existing Enter path retained; text layers bypass generic shape fill | 91 | Rich selection styling unavailable |
| Text double-click edit | 86 | Double-click enters text at the clicked layer | Existing deep hit path retained | 92 | Caret placement is native textarea, not canvas text engine |
| Text click-outside exit | 78 | Figma commits text on click outside; this was a required check | Existing textarea blur commits; canvas keeps outside click path | 90 | IME/browser focus behavior is MV |
| Text Escape exit | 84 | Escape exits without leaving a stale edit overlay | Existing blur/cancel path retained | 90 | Native textarea semantics vary by browser |
| Drag-and-drop PNG/JPG/WebP | 78 | Drop places image at pointer and uses the frame under the pointer | Image drops now resolve a host frame and convert coordinates with its transform | 88 | No URL/video/PDF drop and no crop-on-place |
| File-picker image placement | 76 | Figma can size/place and then crop an image | Existing picker and intrinsic-size cap retained | 80 | Picker path does not provide the full drag-sized crop flow |
| Canvas context menu | 84 | Menu should reflect selection and provide arrange/boolean/mask/export actions | Existing menu audited; mask shortcut now uses the same menu command | 90 | Menu action set is smaller than Figma |
| Prototype canvas wires | 45 | Figma drags a noodle from a node to a destination | Existing interaction arrows render in Prototype view | 58 | No drag-to-connect gesture; panel is the connection editor |
| Prototype present click | 72 | Click hotspot navigates and preserves presentation stack | Existing hit path and Present stack retained | 84 | Device chrome/scroll behavior is limited |
| Prototype hover | 68 | Hover trigger runs while pointer enters and resets on leave | Existing hover trigger tracking retained | 78 | Animation is a timed transition, not full Smart Animate |

## 4. Keyboard, undo/redo, and repeated-operation behaviour

| Feature / option | Pre | Figma difference or issue found | Changes made in this pass | Final | Remaining limitation |
| --- | ---: | --- | --- | ---: | --- |
| Tool shortcuts | 84 | Shift+E conflicted between Eraser and Design/Prototype | Shift+E now toggles Design/Prototype; Eraser remains in its tool menu | 91 | Some Figma shortcuts are intentionally not assigned |
| Undo | 88 | Repeated drag events must collapse into one user gesture | Existing `begin`/`end` grouping retained | 93 | Text/property field grouping is not universal |
| Redo | 88 | Redo stack should clear after a new edit | Existing command stack retained | 93 | MV |
| Empty grouped gesture | 50 | A no-op gesture must not leave an undo step | Ending unchanged groups now removes the entry, rebuilds snapshot, and notifies | 96 | JSON snapshot comparison is not a scalable history diff |
| Copy | 76 | Figma can copy between files/system clipboard | Existing internal scene clipboard retained | 82 | System/Figma clipboard interoperability is absent |
| Cut | 76 | Copy then delete in one history action | Existing cut path retained | 84 | Locked/system clipboard cases are limited |
| Paste / paste in place | 78 | Paste into context and preserve coordinates | Existing selected-parent paste and local coordinate conversion retained | 86 | Rotated parent paste is still approximate |
| Duplicate (`Cmd/Ctrl+D`) | 88 | Duplicate preserves stacking and offset | Existing duplicate path retained | 92 | Component/library edge cases remain |
| Select all | 86 | Select current context, not locked/hidden layers | Locked layers are now excluded | 93 | Context is sibling-based, not full Figma layer scope |
| Tab / Shift+Tab layer navigation | 80 | Navigate visible unlocked siblings | Existing Canvas layer navigation retained | 88 | No full keyboard focus model for the tree |
| Escape unwind | 82 | Exit presentation/edit/tool in Figma order | Existing presentation/edit/vector/tool reset paths retained | 88 | Some browser focus cases need MV |
| Delete/backspace | 88 | Locked nodes must not delete; selected connection has priority in Figma | Locked-node guard retained | 93 | No prototype-connection selection priority |
| Arrow nudge | 86 | 1px and Shift 10px; grid should snap | Existing nudge path now snaps when pixel grid is on | 93 | Nested transformed parents use local coordinates |
| Group / ungroup | 84 | Preserve stacking and child positions | Group insertion now preserves the first selected layer's stack position | 92 | Parent transform preservation is incomplete |
| Arrange front/back/forward/backward | 84 | Multi-selection moves as a block within each parent | Existing grouped arrange algorithm retained | 91 | Complex mixed-parent selections differ |
| Align / distribute | 80 | Align in page/parent context and distribute visual bounds | Existing inspector and shortcuts retained | 86 | Multi-selection uses additive `worldPos` for transformed parents |
| Boolean shortcuts | 80 | Union/subtract/intersect/exclude on vector-capable selection | Existing command paths and transformed child polygons retained | 88 | Text/holes/compound winding differ from Figma |
| Flatten (`Cmd/Ctrl+E`) | 78 | Live boolean flatten must produce a real editable path | Existing transformed boolean bake produces vector path and clears children | 88 | Raster-guided contours are approximate |
| Outline stroke/text | 78 | Outline produces editable filled vector geometry | Existing outline stroke path retained | 86 | Text outline is shape approximation, not glyph outlines |
| Lock/show-hide | 88 | Locked/hidden layers are excluded from selection/hit testing | Existing shortcuts and guards retained | 94 | Hidden selected state remains possible after toggling |
| Copy/paste properties | 25 | Figma has dedicated property clipboard shortcuts | Audited as missing; not added because this pass cannot add new scope | 25 | Missing |
| Select matching layers | 20 | Figma selects matching type/name/paint | Audited as missing | 20 | Missing |
| Rulers/guides shortcuts | 30 | Figma has ruler and guide controls | Audited current web model | 32 | Not implemented in this web surface |
| Pixel-grid shortcut | 30 | Figma toggles pixel grid with its shortcut | Pixel-grid model and snapping exist; shortcut parity remains incomplete | 46 | Missing exact shortcut path |
| Design/Prototype toggle | 56 | Existing shortcut conflicted with Eraser | Shift+E now toggles the two tabs | 90 | Inspect/Dev Mode is a third state rather than Figma's exact chrome |
| Dev Mode (`Shift+D`) | 82 | Figma enters Inspect/Dev Mode | Existing tab toggle retained | 89 | No full measure/annotate/code-connect tools |
| Rename selected layer shortcut | 35 | Figma supports direct keyboard rename | Existing context/double-click rename retained | 42 | Dedicated `Cmd/Ctrl+R` path is incomplete |
| Add auto layout (`Shift+A`) | 86 | Add/remove auto layout and preserve one command | Existing command and inspector path retained | 91 | Exact Figma sizing modes are narrower |
| Use as mask | 62 | Mask command must group the selection and mark the correct first layer | Shortcut now delegates to the same complete context-menu mask path | 82 | Alpha/vector/luminance rendering currently shares geometry clipping |
| Hide UI shortcuts | 88 | Separate hide and minimize states | Existing separate states retained | 93 | MV |
| Quick actions (`Cmd/Ctrl+K`) | 82 | Search every reachable command | Existing palette expanded for region and shape tools | 90 | No plugin commands |
| Present shortcut | 30 | Figma supports present keyboard entry | Existing Present button/action path works | 48 | Exact present shortcut is not wired |

## 5. Inspector properties, paint, effects, text, and layout

| Feature / option | Pre | Figma difference or issue found | Changes made in this pass | Final | Remaining limitation |
| --- | ---: | --- | --- | ---: | --- |
| Local X/Y inspector coordinates | 78 | Nested child fields must show parent-local values | Existing inspector uses node-local x/y rather than additive world position | 90 | Rotated parent visual bounding coordinates remain different |
| Width/height fields | 88 | Numeric fields must permit intermediate values like `12.` | Number fields now keep a draft while focused and commit on blur/Enter | 94 | Mouse scrubbing is not implemented |
| Aspect lock | 86 | Preserve ratio in field and canvas resize | Existing aspect lock retained | 92 | MV |
| Rotation field | 84 | Numeric rotation should agree with canvas | Existing patch path retained | 90 | Nested visual overlay remains MV |
| Constraints | 74 | Figma has min/center/max/stretch/scale per axis | Existing constraint fields and resize solver retained | 83 | Constraints do not cover all auto-layout cases |
| Visibility and lock controls | 88 | Eye/lock controls are per-layer and non-destructive | Existing panel controls retained | 94 | MV |
| Solid fill | 90 | Fill row, remove/hide, opacity | Existing FillPicker and fill visibility retained | 95 | MV |
| Fill opacity | 82 | Fill alpha is independent from layer opacity | Text now also honors fill visibility/opacity; shape path already did | 93 | MV |
| Color picker HSV | 84 | Interactive SV/hue/opacity controls | Existing picker retained | 90 | Exact color-management profile is not verified |
| Color picker RGB/HSL/CSS/Hex | 82 | Figma exposes multiple color models and alpha | Existing model cycling and parsing retained | 89 | Invalid/intermediate input UX is approximate |
| Recent/preset swatches | 86 | Recent colors and swatches are reachable | Existing collection/preset swatches retained | 91 | No document/team color styles |
| Eyedropper | 72 | Sample visible canvas color | Existing canvas pixel sampling retained | 82 | Browser color-management and DPR edge cases are MV |
| Linear gradient | 84 | Two stops and editable handles | Existing fill type, second stop, picker controls, canvas handles retained | 89 | SVG/export and nested-transform edge cases remain |
| Radial gradient | 82 | Center/radius handles | Existing radial fill and handles retained | 87 | Exact Figma radius semantics are approximate |
| Angular gradient | 70 | Conic gradient with handles | Existing conic path retained | 78 | Browser fallback becomes solid; SVG export lacks angular gradient |
| Diamond gradient | 68 | Four-way diamond fill | Existing four-wedge canvas fill retained | 77 | Approximate interpolation and no SVG equivalent |
| Fill blend mode | 76 | Blend is independent from layer blend | Existing fill blend field retained | 84 | Some Canvas composite modes vary by browser |
| Stroke paint/opacity | 84 | Independent stroke row and alpha | Existing hidden stroke row is editable and surfaced | 92 | MV |
| Stroke width | 88 | Numeric width and scaling | Existing field and scaleProps retained | 93 | MV |
| Stroke alignment | 78 | Inside/center/outside | Existing path-specific alignment paint retained | 86 | Outside/inside are Canvas approximations |
| Stroke caps | 82 | Butt/round/square/arrow | Existing cap controls and arrow rendering retained | 90 | Arrow geometry differs from Figma |
| Stroke joins | 84 | Miter/bevel/round | Existing join controls retained | 91 | MV |
| Stroke dash/gap | 78 | Independent dash and gap | Existing expanded dash controls retained | 87 | Vector/path dash phase is not modeled |
| Uniform corners | 88 | Radius clamps with object size | Existing geometry clamp retained | 93 | MV |
| Independent corners | 72 | Four independent values must render/export | Existing four-value geometry and SVG clip path now preserve corners | 91 | Effects/stroke alignment around corners remain approximate |
| Clip content | 84 | Frame clip follows rounded frame path | Existing clipping retained | 90 | Complex transformed clip stacks need MV |
| Mask: alpha | 62 | Mask affects following siblings | Existing mask shortcut and clipping retained | 74 | Mask uses geometric clip, not full alpha paint |
| Mask: vector | 52 | Vector mask follows vector content | Existing mask type option is surfaced | 58 | Rendering currently shares alpha geometry path |
| Mask: luminance | 35 | Luminance mask uses painted luminance | Existing option remains visible | 35 | Not implemented |
| Opacity | 90 | Layer opacity composes with paint opacity | Existing globalAlpha path retained | 94 | MV |
| Layer blend modes | 74 | Figma supports blend list and pass-through | Existing blend list and Canvas mapping retained | 82 | Browser composite-mode fidelity varies |
| Drop shadow | 80 | Offset, blur, spread, color, multiple effects | Existing effect row and canvas shadow retained | 86 | Exact spread/blur kernel differs |
| Inner shadow | 70 | Constrained inner edge shadow | Existing clipped inner-shadow paint retained | 78 | Approximate Canvas compositing |
| Layer blur | 72 | Blur layer contents | Existing `ctx.filter` path retained | 80 | Browser filter/render cost differs |
| Background blur | 60 | Blur pixels behind layer only | Existing sampled canvas background-blur path retained | 70 | Not equivalent to a compositor backdrop surface |
| Noise | 70 | Noise overlay with density/blend controls | Existing noise effect retained | 79 | Existing model exposes a simplified density value |
| Glass | 58 | Existing X-Native glass effect, not a standard Figma Design effect | Existing glass tint/blur path retained | 64 | Extra/approximate effect |
| Multiple effects | 76 | Effects stack in order and can hide/remove | Existing effects array and controls retained | 84 | Some effect ordering differs in Canvas |
| Auto-layout add/remove | 84 | Toggle auto layout on a frame/component | Existing command and panel retained | 91 | Exact Figma auto-layout modes are narrower |
| Auto-layout direction | 88 | Horizontal/vertical flow | Existing layout solver retained | 93 | MV |
| Auto-layout gap | 86 | Fixed/negative/auto spacing rules | Existing gap field retained | 89 | Negative/auto gap semantics are incomplete |
| Auto-layout padding | 82 | Uniform and independent padding | Existing four-side padding popover retained | 89 | MV |
| Auto-layout alignment | 82 | Nine-way alignment and space-between | Existing Nine control and justify control retained | 88 | Fill/hug combinations have edge cases |
| Auto-layout wrap/grid | 70 | Wrap/grid behavior and row sizing | Existing wrap/grid solver retained | 78 | Exact row/column sizing differs |
| Hug/fill/fixed sizing | 72 | Parent/child sizing semantics | Existing sizing fields and solver retained | 82 | Figma's min/max content sizing is not complete |
| Shape count / star ratio | 86 | Count/ratio controls with sane ranges | Count now clamps at 60; ratio control retained | 92 | No on-canvas handles |
| Image fit | 76 | Fill/fit/crop/tile | Existing image fit controls and canvas paths retained | 83 | Crop is cover math, not crop handles |
| Image rotation/adjustments | 68 | Exposure, contrast, saturation, temperature, tint, highlights, shadows | Existing image processing and sliders retained | 78 | Browser Canvas image processing is approximate |
| Font family | 62 | Figma font picker and loaded font availability | Existing five-option selector retained | 68 | Only Inter is bundled; other names fall back to system fonts |
| Font weight | 82 | Weight affects metrics and paint | Existing weight selector and Canvas font string retained | 88 | Available font faces are limited |
| Font size | 90 | Numeric font size | Existing field and paint path retained | 94 | MV |
| Line height | 78 | Auto or exact leading | Existing line-height field and multiline paint retained | 87 | Font metrics differ from Figma |
| Letter spacing | 76 | Numeric tracking | Existing tracking paint and edit overlay retained | 86 | Native textarea/canvas metrics can differ |
| Paragraph spacing | 74 | Paragraph-level spacing | Existing paragraph spacing field and renderer retained | 84 | Rich paragraph model is limited |
| Text alignment horizontal | 86 | Left/center/right/justified | Existing four controls retained | 91 | Justification is a simple Canvas distribution |
| Text alignment vertical | 84 | Top/middle/bottom in fixed box | Existing vertical controls retained | 90 | SVG now approximates vertical alignment; MV |
| Text decoration | 82 | Underline/strikethrough | Existing controls and renderer retained; underline width now includes tracking | 89 | Decoration metrics differ |
| Text case | 68 | None/uppercase/lowercase/title/small caps | Existing all model values and selector retained; Canvas/SVG apply them | 84 | Small caps is uppercase, not OpenType small-caps |
| Text truncation | 64 | Line limit and ellipsis in fixed box | Existing truncate/max-lines and Canvas/SVG paths retained | 76 | Export wrapping/ellipsis is approximate |
| Text enter/exit/click-outside | 76 | Commit/cancel semantics and measured overlay | Multiline overlay measurement now uses real newlines; blur commits | 90 | Native textarea is not a rich Figma text editor |
| Component master | 76 | Create/edit a reusable master | Existing make-component path retained | 84 | Property definitions and library metadata are simplified |
| Component instance | 74 | Place instance and inherit master changes | Existing Assets double-click placement and instance sync retained | 81 | Overrides/properties are incomplete |
| Detach instance | 84 | Break link without deleting content | Existing detach command retained | 90 | MV |
| Component variants | 64 | Variant set/property switching | Existing add/set variant controls retained | 75 | Variant layout/property model is simplified |
| Export presets | 78 | Format, scale, suffix, multiple rows | Existing export rows and scale cycle retained | 87 | No export selection panel/slices |

## 6. Rendering and export fidelity

| Feature / option | Pre | Figma difference or issue found | Changes made in this pass | Final | Remaining limitation |
| --- | ---: | --- | --- | ---: | --- |
| Rectangle/rounded rectangle paint | 88 | Fills/strokes/corners must share one path | Existing generic path and independent corner path retained | 93 | MV |
| Ellipse paint | 88 | Ellipse fill/stroke should be centered and transformed | Existing ellipse path retained | 92 | Arc variants missing |
| Polygon/star paint | 84 | Non-square bounds preserve separate x/y radii | Existing star/poly paths use independent half-width/half-height | 91 | MV |
| Line/arrow paint | 84 | Direction and endpoint cap must follow geometry | Existing vector arrow direction fix retained | 91 | Exact arrowhead geometry differs |
| Vector Bézier paint | 78 | Curves and handles render consistently | Existing `tracePath` and handle paths retained | 85 | Compound/vector-network parity incomplete |
| Text glyph paint | 72 | Text must not receive a generic rectangle behind glyphs | Text layers now use an empty generic path; glyph fill/stroke owns painting | 88 | Font metrics and rich text remain MV |
| Text fill visibility/opacity | 48 | Fill row must hide/fade glyphs independently | `paintText` now honors `fillVisible`, `fillOpacity`, and `strokeOpacity` | 88 | MV |
| Gradient paint | 80 | Linear/radial/conic/diamond gradients | Existing paint module and on-canvas handles retained | 86 | Browser/gradient interpolation differences |
| Shadow/blur paint | 72 | Compositor effects should match Figma kernels | Existing Canvas effects retained and audited | 79 | Kernel/backdrop differences |
| Image paint | 76 | Fit, crop, rotation, adjustments | Existing image cache/processing retained | 82 | No video/crop editor |
| Layer opacity/blend | 82 | Group pass-through and layer blend | Existing Canvas composite map retained | 87 | Pass-through is approximated as source-over |
| Mask paint | 54 | Alpha/vector/luminance masks differ | Existing mask grouping and transformed mask geometry retained | 63 | Luminance and painted-alpha semantics are missing |
| Nested transformed-parent rendering | 42 | Parent transforms must affect child paint, hit, handles, overlays, and reparenting | Engine hit test/deepest-frame now uses affine matrices; image/create placement uses `worldToLocal` | 62 | Canvas paint and inspector overlays still use additive `worldPos` in places; MV and known limitation |
| Canvas resize / DPR | 82 | CSS size and device pixels must stay aligned | Existing DPR backing-store setup retained | 88 | Browser resize replay is MV |
| Large/complex scene | 58 | Figma remains usable as scene complexity grows | Existing boolean canvas cache and image cache retained | 64 | No performance benchmark or virtualized scene renderer was added |
| Zoom/pan render stability | 84 | Geometry remains aligned while zooming/panning | Existing pointer-centered zoom/pan retained | 90 | MV |
| Page/frame labels | 82 | Frame names appear without painting the page name as art | Existing label rule excludes the page root and respects `showName` | 92 | Exact label typography is MV |
| SVG solid export | 82 | Shapes/text/images should preserve alpha and transforms | Existing refined SVG tree and alpha-preserving `svgColor` retained | 89 | Effects/blends not fully encoded |
| SVG text export | 50 | Text case, truncation, alignment, opacity, and stroke should follow canvas | Added case, truncation approximation, vertical alignment, fill/stroke attributes | 80 | Wrapping, glyph metrics, rich ranges, and font availability differ |
| SVG independent-corner clip | 52 | Clip path must preserve four corner radii | Frame clip now uses the generated rounded path instead of one `rx` | 88 | Stroke-aligned clipping still differs |
| PNG export | 76 | Raster export should match SVG/canvas | Existing SVG-to-canvas PNG path retained | 82 | Browser SVG/font/filter differences |
| JPG export | 76 | JPG needs opaque background | Existing white background path retained | 84 | Same browser raster limitations |
| PDF export | 20 | Figma emits a real PDF | Existing fallback is honestly audited | 20 | Current browser path downloads refined SVG with an `.svg` name; no PDF encoder |
| Exported image assets | 70 | Embedded image data should survive export | Existing data-URL image export retained | 78 | Adjustments/rotation are not fully serialized in SVG |
| Native/headless Rust render | 80 | Rust renderer remains available for headless/export | Kept native GPU UI removed while preserving headless role | 86 | Rust gate unavailable in this sandbox |

## 7. Prototype, inspect, import, and collaboration surfaces

| Feature / option | Pre | Figma difference or issue found | Changes made in this pass | Final | Remaining limitation |
| --- | ---: | --- | --- | ---: | --- |
| Prototype tab | 78 | Design and Prototype are separate modes | Existing tab and Shift+E toggle retained | 88 | Exact panel/chrome differs |
| Flow starting point | 78 | Choose a starting frame | Existing `flowStart` selector retained | 88 | No multiple flow labels |
| On-click navigate | 76 | Connect layer/frame to frame with action/animation | Existing interactions editor and Present stack retained | 85 | No drag noodle |
| On-hover trigger | 64 | Hover trigger with enter/leave semantics | Existing hover tracking retained | 76 | No true interactive component states |
| After-delay trigger | 66 | Delay then action in presentation | Existing timer path retained | 78 | Complex timing/scroll conditions absent |
| Back action | 78 | Back uses presentation history | Existing stack/back path retained | 88 | MV |
| Open URL action | 68 | Open URL in preview | Existing `window.open` path retained | 76 | Browser popup policy and security context apply |
| Instant animation | 80 | No transition | Existing instant path retained | 90 | MV |
| Dissolve animation | 52 | Figma dissolves between screens | Existing timed dissolve overlay retained | 70 | It is a simple fade, not full Figma transition |
| Smart animate | 30 | Figma matches and animates layers | Existing timed smart label/transition retained | 38 | No layer matching/interpolation |
| Present mode | 74 | Hide chrome, show frame, interact | Existing `presentStart`, UI hiding, focus, and hit path retained | 84 | Device chrome and scroll positions incomplete |
| Interaction arrows | 54 | Figma draws editable noodles | Existing prototype arrows render in Prototype tab | 66 | No draggable endpoints |
| Prototype scrolling | 20 | Frames can scroll and preserve/reset position | Existing overflow enum is model-only for prototype | 24 | Missing |
| Conditional variables | 20 | Figma prototype conditions/variables | Existing no-op scope audit | 20 | Missing |
| Overlays/modals | 20 | Figma opens overlays with positioning | Existing no overlay action model | 20 | Missing |
| Inspect tab | 72 | Dimensions, color, distances, code | Existing CSS inspect panel retained | 78 | No measure/annotate/platform code panels |
| Copy CSS | 80 | Copy code from inspect | Existing clipboard CSS path retained | 86 | CSS does not describe all paints/effects |
| Copy as code | 74 | Context-menu code action | Existing `copyCode` path retained | 82 | Only CSS-like output |
| Figma file import | 0 | Figma imports/opens `.fig` | Not part of this web engine; no new importer added | 0 | Missing |
| SVG import | 0 | Figma imports SVG | Existing web surface has no SVG file importer | 0 | Missing |
| PNG/JPG import | 70 | Figma places raster assets | Existing picker and drag/drop support image MIME types | 84 | No persistent asset library/crop workflow |
| PDF/WebP/video import | 0 | Figma supports broader asset types in relevant flows | Audited and left out of scope | 0 | Missing |
| Comments/threads | 20 | Figma comments have author, replies, resolve | Existing comment pin is only an ellipse layer | 22 | Missing collaboration backend |
| Multiplayer cursors | 0 | Figma shows collaborators/live cursors | No collaboration feature added | 0 | Missing |

## 8. Changes made in this pass

The implementation refinements that raised the scores above are:

1. **Text paint correctness:** text bypasses the generic shape path; glyph fill now
   respects `fillVisible`/`fillOpacity`, glyph stroke respects `strokeOpacity`, and
   tracked text decoration width includes letter spacing.
2. **Text editing correctness:** measured edit overlays split actual newline characters,
   carry line height/tracking/alignment, and rotate with the text layer; click-outside
   still commits through blur.
3. **History correctness:** unchanged `begin`/`end` gestures are removed from undo and
   snapshots/listeners are refreshed; pixel-grid nudge snaps; file-name typing does not
   create one undo item per character.
4. **Transform hit testing:** affine matrices now drive engine hit testing and deepest
   frame lookup through rotated/flipped parents. Image/create placement converts page
   points into the host frame's local coordinates.
5. **Stacking correctness:** group/boolean/section wrapping inserts at the first selected
   layer instead of always moving the new container to the front.
6. **SVG/export correctness:** text case/truncation/alignment and text stroke are emitted;
   rounded frame clips use the complete path so independent corners survive; alpha
   colors remain explicit.
7. **Chrome correctness:** the X menu no longer nests interactive buttons inside a
   button; layer-rename Escape cancels; the command palette surfaces all existing
   region/shape tools; Shift+E now matches Design/Prototype and Eraser remains available
   from its tool menu.
8. **Field/edit ergonomics:** inspector numeric fields preserve intermediate input and
   commit on blur/Enter; FillPicker updates can be sent as one node patch so a color
   change does not manufacture separate color/opacity/metadata undo steps.
9. **Rust/core regression repair:** component-property writes preserve legacy `.x`
   target keys for existing readers while direct typed overrides can retain multiple
   property kinds on one layer; property-editor writes remain exclusive where the
   existing editor contract requires one value. The workspace lockfile was regenerated
   for the removed native dependencies, and the Rust formatting/test regressions exposed
   by CI were corrected without adding product behavior.
10. **Shared text clipping:** the IR and direct Rust render paths now apply the same
    text-box clip only when text has ink; golden-render and FrameCache expectations were
    updated to record the intentional clip commands. The software-Vulkan screenshot
    suite and the full remote workspace gate pass on the resulting branch.

No AI/agent work, new product feature, native UI, or second product UI was added.

## 9. Remaining limitations and release decision

This PR is **not Figma-complete** and should not be described as such. The highest-impact
remaining limitations are:

* no browser visual replay or pixel diff was possible in this sandbox;
* nested transformed-parent rendering/handles/inspector overlays still have additive
  coordinate paths even though engine hit/deepest-frame selection is matrix-aware;
* Figma rich text (ranges, links, lists, OpenType, variable fonts, true small caps),
  complete font loading, and exact text metrics are not present;
* vector networks, arc handles, true stroke/text outlines, boolean holes/winding, and
  full mask alpha/luminance semantics are incomplete;
* prototype noodles, overlays, scrolling, conditions, true Smart Animate, and full
  device preview are incomplete;
* Figma variables/styles/libraries, file import, collaboration/comments, and backend
  sharing are not present in this local engine;
* PDF export is still an SVG fallback rather than a PDF file.

The implementation is ready for the requested **code-level refinement and audit record**
only. It is not evidence for a 100% Figma parity claim, and no new-feature work should
be inferred from the missing rows.
