# The strict UI↔code Figma parity rule

**UI and code match Figma 100%.** That is not a goal, it is the gate: a
behaviour the user can see must behave like Figma, and the code that makes it
so must live in exactly one place that the UI reads — never in a copy the UI
recomputes.

## The rule, in two directions

1. **UI → code: every Figma-visible behaviour names its one owner.**
   A design decision lives in exactly one place. The canvas, the panels, the
   exports and the thumbnails all read that place. When two sites need the
   same number, the second one imports it; a literal written out twice is two
   owners, and two owners drift. (Past drifts this rule would have caught:
   the canvas name label's ink at four sites with one arm faded to 70%, its
   size at three sites as 14/18/20px in the same canvas.)
2. **Code → UI: every parity claim names the test that pins it.**
   A behaviour is a test, not a sentence. `docs/FIGMA_PARITY.md` §2 lists
   what we claim with the Figma source and the test name; a claim with no
   test is listed as *open* in §3, never quietly dropped.

## How the gate enforces it

`node tools/design-sheet/guard.mjs` runs in `scripts/check.sh` on every push:

- one owner per decision — a hardcoded canvas colour in two files fails;
- the literal ceilings — a new engine-chrome literal fails unless routed
  through a named constant (or the ceiling is raised on purpose, in a diff a
  reviewer can see);
- the wiring checks — frame-label constants (`LABEL_SIZE` 12,
  `LABEL_ABOVE_Y` −20), the canvas lowering stripping world-space `/label`,
  the overlay reading `frame_label_targets`, the text Esc arm committing,
  the outside press committing before dispatch, the six INSPECT platforms;
- every §2 parity row cites a Figma source and names tests that still exist;
- the master-list scoreboard is its own arithmetic — every section header
  equals its rows, `**total**` equals the sum of the headers.

`cargo fmt --check`, clippy with zero live warnings, and the Rust test suite
(including the pixel tests in `raster.rs`) run in the same script. Any of
them red means the rule is broken, whatever the screenshot looks like.

## Adding a Figma behaviour, start to finish

1. Find it in Figma first — help article, guide, or reproducible app
   behaviour — and keep the URL; it goes in the parity row.
2. Put the rule in its one owner (never at the call site); the UI reads the
   owner, it does not recompute the behaviour.
3. Write the test that pins it, named after the behaviour.
4. Add the row to `docs/FIGMA_PARITY.md` §2 with the Figma URL and that test
   name; move the master-list row if its status changed, keeping the
   scoreboard arithmetic intact.
5. `node tools/design-sheet/guard.mjs` — fails if the row and the test
   disagree.

## What "100%" means

The number is read off
[the master-list scoreboard](FIGMA_PARITY_MASTER_LIST.md#the-scoreboard):
every row `MATCH`, zero `MISSING`, the named divergences inside `PARTIAL`
closed. The queue that gets there is the waves list in the same file.
