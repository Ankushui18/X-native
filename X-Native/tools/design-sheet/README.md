# Design sheet

A live page generated from the shipping sources — the three palettes, every
token ladder, the dashboard at three widths, and the spacing + ratchet audit.
Nothing here is hand-maintained: if it says a value, the code ships that value.

    node extract_icons.mjs    # icons.js      <- apps/x-designer/.../icons.rs
    node build_tokens.mjs     # tokens.{css,js,json} <- crates/x-ui/src/design_system.rs + theme.rs
    node build_audit.mjs      # audit.{js,json} <- the paint code + design_tokens_test.rs
    python3 -m http.server 8000     # then open http://localhost:8000
    node check.mjs            # jsdom smoke test (needs `npm i jsdom`)

`index.html` + `app.js` render it; the fonts are Inter (OFL) from
`@fontsource/inter`. Regenerate after changing a scale, a palette or a ceiling —
the CI ratchet (`design_tokens_test.rs`) is the same source of truth, so a
number that drifts shows up in both.
