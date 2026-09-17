# Design sheet

A live page generated from the shipping sources — the three palettes, every
token ladder, the dashboard at three widths, and the spacing + ratchet audit.
Nothing here is hand-maintained: if it says a value, the code ships that value.

    node extract_icons.mjs    # icons.js + icon-audit.js <- icons.rs, then who names what
    node build_tokens.mjs     # tokens.{css,js,json} <- crates/x-ui/src/design_system.rs + theme.rs
    node build_audit.mjs      # audit.{js,json} <- the paint code + design_tokens_test.rs
    python3 -m http.server 8000     # then open http://localhost:8000
    node check.mjs            # jsdom smoke test, 38 checks (needs `npm i jsdom`)

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

`index.html` + `app.js` render it; the fonts are Inter (OFL) from
`@fontsource/inter`. Regenerate after changing a scale, a palette or a ceiling —
the CI ratchet (`design_tokens_test.rs`) is the same source of truth, so a
number that drifts shows up in both.
