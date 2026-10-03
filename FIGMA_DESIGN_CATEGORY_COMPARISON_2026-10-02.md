# X-Native vs Figma Design Help Center — category comparison

**Date:** 2026-10-02  
**Reference:** [Figma Design Help Center](https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design)  
**Scope:** High-level comparison of the live help-center categories against X-Native's existing product surface, backed by repository audits and current regression tests. **No new product capability is proposed or added.** This pass includes one narrow responsive-layout correction to the existing editor and E2E fixture/assertion corrections so the tests exercise the actual controls and outputs.

## Executive summary

X-Native already covers a substantial part of Figma's **core design-authoring workflow**: canvas tools, layers and transforms, vector and text editing, paints/effects, layout, local components/variables, prototype authoring/playback, and local import/export. Its strongest overlap is in **Create designs**.

The category is broader than an editor feature checklist. It also documents Figma's online product/service layer: shared libraries, permissions, multiplayer, branch review/merge, mobile viewing, and Figma Motion. Those workflows are absent, local-only, or not equivalent in X-Native. They are product-scope gaps—not missing buttons that should be added without their underlying model or service.

**Bottom line:** X-Native is a capable local design editor with meaningful behavioral parity work underway, not a Figma-wide replacement. The evidence does **not** support a single overall parity percentage. Existing category audits cover different scopes and depths; article-level “partial” and “not verified” items must not be reported as matches. This pass also fixed a narrow-viewport canvas/dock layering defect and verified the current browser suite at **383 passed, 0 failed**, with no page errors; passing tests establish the covered X-Native behaviors, not Figma-wide equivalence.

## The reference's seven sections

The live category index lists these sections: [Tour the interface](https://help.figma.com/hc/en-us/sections/13148571463703-Tour-the-interface), [Create designs](https://help.figma.com/hc/en-us/sections/4403912808599-Create-designs), [Figma Draw](https://help.figma.com/hc/en-us/sections/31830768959511-Figma-Draw), [Build design systems](https://help.figma.com/hc/en-us/sections/23536356509975-Build-design-systems), [Create prototypes](https://help.figma.com/hc/en-us/sections/360006534454-Create-prototypes), [Import and export](https://help.figma.com/hc/en-us/sections/360006620214-Import-and-export), and [Work together in files](https://help.figma.com/hc/en-us/sections/23537156813975-Work-together-in-files).

| Figma section | X-Native comparison | Status |
|---|---|---|
| **Tour the interface** | X-Native has a web editor shell with a tool dock, canvas, layers/pages, inspector, contextual actions, zoom/navigation, and a keyboard-shortcuts panel. Guides, file utilities, and help surfaces are present. It is not Figma's cloud file-browser/account experience. Some documented interaction details remain different or unverified; for example, the keyboard-pan gesture when nothing is selected and keyboard-layout preferences are not implemented. | **Broad overlap; partial parity** |
| **Create designs** | Strongest area of overlap: shapes, frames/sections, layers, transforms, vector editing, typography, fills/strokes/effects, images/cropping, guides/constraints, and Auto Layout all have product surfaces and regression coverage. The existing article-level audit counted 70 Create designs articles as 42 verified, 21 partial, 6 missing, and 1 deliberately out of scope at that audit's date. Later article audits have extended or refined parts of that ledger; those counts are not a current category-wide score. | **Broad implementation; mixed parity** |
| **Figma Draw** | X-Native has related pen, pencil, brush, and vector-editing workflows, plus pattern support. That overlap does not establish parity with Figma Draw as a distinct illustration workflow. Draw-specific workflows such as creating patterns with transforms have not been fully compared. | **Partial overlap; not fully audited** |
| **Build design systems** | Local reusable components/instances, variants and properties, styles, variables, collections, and modes are represented in the product. This is not equivalent to Figma's shared-library service: publishing and consuming across teams/files, access controls, update review, and distribution are not a complete match. Some component-slot authoring workflows are also partial. | **Local foundation; sharing lifecycle is a gap** |
| **Create prototypes** | X-Native has prototype connections/flows, interaction triggers and actions, overlays, transitions, conditions/variables, and a presentation player. Prototype transitions are not the same thing as Figma Motion's layer-timeline/keyframe authoring. Motion timelines, animated components, and MP4/WebM/GIF/Lottie export are not present. Mobile-device viewing/accessibility and shared presentation workflows are not full equivalents. | **Core prototype workflow; partial ecosystem parity** |
| **Import and export** | The web editor supports a local format workflow with Figma `.fig`, SVG, image, and JSON paths; the wider Rust/CLI workspace also documents Sketch import and additional local export/code-generation paths. Static PNG/JPG/SVG/PDF export and per-layer/bulk export exist. Gaps include Figma `.fig` export, a raster-backed browser PDF path rather than editable vector PDF, some export-option differences, and animated-media export. Do not assume every CLI format is exposed in the web editor. | **Useful local coverage; format/workflow gaps** |
| **Work together in files** | Local comments/annotations and local document/version workflows exist, but they do not make X-Native a multiplayer service. Real-time presence/cursors, cursor chat, spotlight, shared-file permissions and notifications, viewer history, and Figma-style branch review/merge are not equivalent production workflows. | **Major product-scope gap** |

## What is already strong

- **Core editor breadth:** the web app is the shipped UI and includes substantial authoring, layout, text, vector, paint, and prototype functionality.
- **Behavioral detail:** many workflows have focused regression tests rather than being represented only by model fields or toolbar labels.
- **Local design-system primitives:** components, variants, variables/modes, and styles give X-Native a meaningful foundation without a cloud library dependency.
- **Static handoff:** local asset exports, code-oriented outputs, and supported document imports cover common individual-designer workflows.
- **Recent parity hardening:** the latest 2026-10-02 audit notes correct shape-tool click behavior and the Place Image shortcut; this pass also restores the canvas and tool flyouts in the editor's narrow, restored-panel layout. Earlier focused audits cover crop interactions, eyedropper behavior, color profiles, and static export details.

## Material differences to keep visible

These are comparisons, not feature requests:

1. **Local editor vs online workspace.** Figma's help category documents file sharing, team access, collaboration, library publishing, and branching. X-Native primarily owns local editing; those online workflows should not be implied by local UI affordances.
2. **Prototype transitions vs Motion.** A prototype player is not an animation timeline or media encoder. Motion export cannot be represented accurately by adding an export-format selector alone.
3. **Import is not round-trip compatibility.** Supporting Figma `.fig` import does not mean X-Native can export `.fig` or preserve every Figma feature on round-trip.
4. **A feature's presence is not parity proof.** A control or data field may exist while rendering, persistence, undo, keyboard behavior, accessibility, or edge cases still differ. Use “partial” or “not verified” unless the specific workflow is tested.
5. **The reference is a help-center taxonomy.** This is a capability comparison against the linked category, not a pixel/visual comparison of the help-center web page.

## Existing-surface follow-up only

Given the “no new features for now” constraint, the useful next step is **not** to expand the product to match every heading. This pass stayed on that path: it fixes only the existing narrow-layout canvas/dock behavior; most E2E edits correct selectors, fixture setup, and assertions rather than changing product behavior. Continue with bounded correctness and verification of shipped surfaces: shortcut/label consistency, interaction regressions, inspector-to-engine wiring, persistence/undo, and output correctness. Treat multiplayer, shared-cloud libraries, Figma Motion, and other absent product models as deferred—not as small parity fixes.

## Verification of the existing surface (2026-10-02)

| Check | Result | What it establishes |
|---|---|---|
| `npm test` | **PASS — 3,692 assertions across 69 suite summaries; 0 failed** | Engine/model and headless UI regressions across the existing web surface. |
| `npm run build` | **PASS** (`tsc -b` + Vite production build) | Current TypeScript and production bundle compile. Vite reports the main minified JS chunk is about 1.34 MB (407 KB gzip), above its 500 KB advisory threshold. |
| `npm run test:e2e` | **PASS — 383 passed, 0 failed; no page errors** | Browser behavior, focus, computed styles, interaction flows, and the tested narrow layouts on the current Vite preview. This is not a Figma client comparison. |
| Narrow restored-panel layout | **PASS at 700 px and 430 px** | Canvas remains 648 px / 378 px wide respectively; all 12 dock tools stay on-screen. At 430 px the dock wraps to five rows, and the Boolean flyout paints above its trigger and the panel overlay. |
| `npm run test:wasm` | **BLOCKED locally** | The real-artifact runner exits with `ENOENT` because optional generated `public/wasm/x_wasm_bg.wasm` is absent. The checked-in README says the regular web editor continues on TypeScript without these artifacts; real WASM execution is not established by this run. |
| Rust workspace tests | **Not run** | `cargo` is not installed in this environment. |

The E2E test corrections are intentionally distinguished from product fixes: the flyout assertion now checks open state instead of whether a hidden node remains mounted; the zoom-menu test clicks a genuinely unobscured “Find layers” input; Delete targets a leaf layer so the row-count assertion matches descendant-deletion semantics; and the theme-color check waits for the CSS transition endpoint. The product change in this pass is the ≤860 px layout correction: explicitly place the canvas in its 1fr grid track and raise the dock above restored sidebar overlays. No new capability was added.

## Evidence and limits

This comparison uses the live category hierarchy read on 2026-10-02, the product's current README and capability map, repository audits, and the current web test/build results above. It is not a fresh article-by-article audit of every page in the help center and is not a live side-by-side comparison with a Figma client. A passing X-Native regression suite does not turn “partial” or “not verified” help-center workflows into parity claims.

Useful detailed records:

- [`CREATE_DESIGNS_PARITY_AUDIT_2026-09-29.md`](CREATE_DESIGNS_PARITY_AUDIT_2026-09-29.md) — Create designs article ledger and its explicit partial/missing statuses.
- [`FIGMA_HELP_AUDIT_2026-09-30_01_IMAGE_PROPERTIES.md`](FIGMA_HELP_AUDIT_2026-09-30_01_IMAGE_PROPERTIES.md), [`FIGMA_HELP_AUDIT_2026-10-01_02_CROP_IMAGE.md`](FIGMA_HELP_AUDIT_2026-10-01_02_CROP_IMAGE.md), and the adjacent 2026-10-01 help-audit files — focused image, color, keyboard, and export comparisons.
- [`FIGMA_HELP_AUDIT_2026-10-02_42_CLICK_NO_STAMP_BUG.md`](FIGMA_HELP_AUDIT_2026-10-02_42_CLICK_NO_STAMP_BUG.md) and [`FIGMA_HELP_AUDIT_2026-10-02_44_PLACE_IMAGE_SHORTCUT.md`](FIGMA_HELP_AUDIT_2026-10-02_44_PLACE_IMAGE_SHORTCUT.md) — latest interaction/shortcut corrections.
- [`X-Native/docs/FIGMA_BEHAVIOR_PARITY_AUDIT.md`](X-Native/docs/FIGMA_BEHAVIOR_PARITY_AUDIT.md) — broad feature-family evidence ledger; explicitly marks incomplete verification rather than claiming exhaustive parity.
- [`X-Native/docs/WASM_RUNTIME_AUDIT_2026-09-28.md`](X-Native/docs/WASM_RUNTIME_AUDIT_2026-09-28.md) — WASM ownership boundary and the missing-generated-artifacts limitation for this checkout.
- [`X-Native/apps/web/README.md`](X-Native/apps/web/README.md) — current web product and architecture boundary.

No new feature or model was added. This pass changed `X-Native/apps/web/src/styles.css` for the verified narrow-layout defect and updated `X-Native/apps/web/e2e/behaviour.mjs` to stabilize the existing regression checks. The category comparison remains a scoped audit, not a claim of 100% parity.
