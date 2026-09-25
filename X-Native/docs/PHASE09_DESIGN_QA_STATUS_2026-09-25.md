# Phase 9 design QA — status 2026-09-25 (`track=ts`, P1)

Full designer pass over the running app: headless-Chromium screenshots of
dashboard + editor (light/dark/selection/quick-open/mobile 390px), DOM
measurements, and axe-core audits. Screenshots kept at `/home/user/shots/`.

## Bugs fixed
- Inspector Sizing row: 4 children in a 3-col grid wrapped min/max below,
  where its H-like glyph read as stray text — new `.grid4` (`inspector.tsx`,
  `styles.css`).
- Corner-smoothing row overflowed its 239px parent; the iOS preset was cut
  off — tighter gap/field (`styles.css`).
- Demo "Explore Store" content: body text ran under the card title in wider
  fonts; "View Details →" pill wrapped to two lines — card/filter shifted
  +20px, pill widened 110→136 (`memory.ts`).
- Nested frame name tags floated over sibling content (demo "Card" sat 4px
  under body text) — tags now render only when the parent is not a frame;
  draw + hit-test kept in sync (`Canvas.tsx`).
- Deep-linking `#/file/demo` on a fresh store opened scratch "Untitled"
  instead of the sample — `ensureDemoFile()` for `DEMO_ID` (`App.tsx`).
- No favicon (browsers 404'd `/favicon.ico`) — emerald X `favicon.svg` +
  `<link>` (`public/`, `index.html`).

## Accessibility (axe-core: was 2+5 types → now 0 on both views)
- Critical: icon-only "New project" / "Play prototype" buttons had no
  accessible name; 27 bare `<select>`s across inspector/prototype dialogs
  labelled (`Dashboard.tsx`, `inspector.tsx`, `chrome.tsx`,
  `FigInspectorModal.tsx`, `PresentationPlayer.tsx`).
- Contrast: `--dim` darkened both themes; new `--accent-ink` token
  (`#065f46` light) for emerald-on-light text (side selection, rail
  selection, brand pill); rail micro-labels full opacity; empty-state
  captions full opacity (`styles.css`, `chrome.tsx`).
- Landmarks/headings: editor canvas column is now `<main>` with an sr-only
  `h1`, canvas has `role="img"` + label, nav/asides labelled, section
  toggles `h3`→`h2` (`App.tsx`, `Canvas.tsx`, `chrome.tsx`,
  `inspector.tsx`, `x-ui.tsx`, `.sr-only` in CSS).

## Small screens (390px verified, no page overflow)
- Dashboard: header keeps brand/search/actions on one row (crumb, title
  text and search hint collapse progressively; New button goes icon-only),
  filter/sort/view controls wrap+scroll, hints wrap (`styles.css`,
  `new-label` span in `Dashboard.tsx`).
- Editor: auto-minimizes at ≤860px (full-width canvas + filename chip);
  restored panels become overlays instead of squeezing the canvas; dock
  scrolls safely (`App.tsx` matchMedia initial, `styles.css`).

## Non-issues (verified, left alone)
- "Success Screen 🎉" tofu + `⇧⌘` shortcut boxes: headless container lacks
  emoji/symbol fonts; real browsers render them.
- Position X/Y grid (5 children, 3+2) renders two tidy rows by design.
- `width-min` icon genuinely looks like "H" — reads fine inline; noted.

## Verification
`tsc` clean · tests 1112/0 · `vite build` clean · dev 200 (port 5203) ·
axe 0 violations (dash + selected-frame editor) · screenshots re-taken.

## Still deferred
P1.10 "Works with MCP".
