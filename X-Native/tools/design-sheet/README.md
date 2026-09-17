# Design sheet

A live page generated from the shipping sources — the three palettes, every
token ladder, the dashboard at three widths, and the spacing + ratchet audit.
Nothing here is hand-maintained: if it says a value, the code ships that value.

    node extract_icons.mjs    # icons.js + icon-audit.js <- icons.rs, then who names what
    node build_tokens.mjs     # tokens.{css,js,json} <- crates/x-ui/src/design_system.rs + theme.rs
    node build_audit.mjs      # audit.{js,json} <- the paint code + design_tokens_test.rs
    python3 -m http.server 8000     # then open http://localhost:8000
    node check.mjs            # jsdom smoke test, 39 checks (needs `npm i jsdom`)

The ladders and the two vocabulary tables are read out of the sources, not
listed here: `build_tokens.mjs` walks every `pub const` in each `impl …Scale`
block (`scaleOf` throws on a rename rather than dropping the step), so a new
radius or type step appears on the sheet the moment it exists in the code. The
columns that say how often a name is used come from the production half of
`apps/x-designer/src/bin/x_native_app/*.rs` — a step no call site names is
marked "unused" instead of quietly looking load-bearing.

`scripts/check.sh` (and therefore CI) re-runs the three generators and fails on
any diff, so the sheet cannot fall behind the code. `check.mjs` is the stricter,
browser-side gate and needs jsdom; it is not run by CI because the Rust gate is
the only job.

## Every screen

    node check.mjs            # 39 checks: tokens, ladders, palettes, audit
    node check_screens.mjs    # 20 checks: the screens gallery

`screens.html` (with `screens.js`, `screens_app.js`, `screens.css`) draws each
screen the app ships — dashboard views, the editor with every panel tab, the
overlays (⌘K, context menu, paint library, colour picker, app menu, find,
notifications), the board, the chrome-less flow viewer and the document loading
screen — at the parsed window size, with the theme switch repainting all of them.

What is real: the window and dock geometry (read from `audit.js`, which
`build_audit.mjs` parses out of `theme.rs`/`state.rs`), the panel and tab names,
the tool sets, the menu rows, the copy on the states, the field style (filled, no
outline until hover, edit ring on the focused field), and every colour (roles).
The COMPOSE inspector is drawn from the offsets in `paint_design` itself, so its
rows sit where the app puts them rather than in invented sections. What is not:
the artwork on the canvas, document thumbnails (the sheet draws the flat-colour
+ `X` fallback a file with no preview shows), and anything the font engine
measures. Each card names the Rust module that paints that screen, so a claim can
be traced to its source.

`check_screens.mjs` verifies the claims it can: every screen renders, every
`module` it names exists on disk, every landmark in its `checks` list is present,
no screen draws a glyph the icon set lacks, the docks are drawn at the widths
`audit.js` parsed, no colour in the gallery is a literal, every menu is drawn on
a surface, and every box a screen places fits inside the panel it is measured
against — the last of these is what caught the minimap sitting under the right
dock and the dashboard's main column hidden behind its title bar.

## Captures

    npm i puppeteer-core @sparticuz/chromium     # once, anywhere
    node shots.mjs                               # 26 PNGs at 1440×900 + index.json + shots.html
    node shots.mjs --only editor-guides          # one screen while you work on it
    node shots.mjs --theme daylight              # the light palette, into shots/daylight/

`screens.html` draws the screens as DOM, which is enough to check layout and
wording but is still a drawing. `shots.mjs` puts those drawings in front of a
real browser engine at scale 1 and writes one PNG per screen, so what a designer
or a reviewer looks at is pixels, not markup — no GPU and no running app needed.
`@sparticuz/chromium` carries its own Chromium *and* the shared libraries a bare
image lacks, which is why the captures work where a system Chrome would not
start. The script is run from whatever directory has those two packages
installed; `SHOT_DEPS=/path/to/node_modules` points it elsewhere.

Before it writes anything it measures every box of every screen in the browser
and refuses to capture a drawing whose boxes escape the window, whose text is
clipped or which lost an icon (`--force` overrides). The result lands in
`shots/index.json` as `verified`, next to each file's size and sha256 and the
renderer version — so the sheet can say which browser produced the pixels.

Only the graphite palette is committed, to keep the repository small; the other
two are one `--theme` away.

`index.html` + `app.js` render it; the fonts are Inter (OFL) from
`@fontsource/inter`. Regenerate after changing a scale, a palette or a ceiling —
the CI ratchet (`design_tokens_test.rs`) is the same source of truth, so a
number that drifts shows up in both.
