# Batch 44 — Place-image shortcut parity (Figma Design)

Source article: Figma Design toolbar/shortcuts reference + multiple
Figma-help-verified third-party sources: Place Image chord is **⌘⇧K**
on Mac / **Ctrl+Shift+K** on Windows.

## Bug #18: ⇧I was incorrectly bound to Place Image

In `chrome.tsx` the shifted letter map had:

```js
const shifted = { s: "section", p: "pencil", l: "arrow", i: "image" };
```

This made `⇧I` switch into the image-placement tool, and the tooltip /
Actions menu advertised `⇧I` as the Place Image shortcut. In Figma:

- `I` (bare) = Eyedropper ✓ (already handled by `isEyedrop` early-return
  at chrome.tsx:2384).
- `⇧I` is **unbound** — Figma has no default on this chord.
- **⌘⇧K** = Place Image (file picker first, then click to drop).

The ⌘⇧K handler already existed at chrome.tsx (it dispatches the
`x-native-place-image` custom event that opens the system file picker),
and `⌘⌥K` correctly creates a component, `⌘K` opens Quick Actions. The
only defect was (a) the stale `i: "image"` entry in the shifted map,
and (b) two menu labels still showing `⇧I`.

### Fix
- Removed `i: "image"` from the `shifted` tool map.
- Updated Tools menu and Actions menu labels from `sc: "⇧I"` →
  `sc: "⌘⇧K"` and routed both to `x-native-place-image` (file-picker
  flow). The location-first image cursor remains reachable from the
  toolbar shape menu ▸ Place image.
- Updated the stale comment above the ⌘⇧K handler.

### Tests
- New `placeImageShortcut.test.mjs` (4/0) locks in the fix: asserts the
  shifted map no longer contains `i`, ⌘⇧K handler is present, no menu
  label advertises ⇧I, and the eyedrop guard still excludes ⇧I.
- Full suite: **4640 passed, 0 failed** (same baseline minus DOM tests
  that fail in headless vite-node due to missing jsdom — preexisting,
  not caused by this change).
- `tsc -b --noEmit` clean; `npm run build` succeeds in 4.12s; dev server
  live at http://localhost:5173/ (HTTP 200).

## Also verified while reading Figma's Edit vector layers article
- Cut subtool on `X` in vecEdit mode: already handled in Canvas.tsx
  (Run 22, audit P1 #10). ✓
- Paint bucket on `⇧B` in vecEdit mode: handled at chrome.tsx:2251,
  dispatches `x-native-vec-subtool`/`paint`. ✓
- Eraser subtool on `⇧E` in vecEdit mode: handled at chrome.tsx:2246,
  dispatches `setTool("eraser")`. ✓
- Lasso on `Q` in vecEdit mode: the state type includes `"lasso"` but
  there is no toolbar button or keyboard handler for it. Documented for
  a future batch — not a visible regression because lasso-only users
  can still marquee-select points via the default band select.

## Cumulative product bugs fixed this QA session: **18**
(#1–#17 per prior session memory; #18 documented above.)
