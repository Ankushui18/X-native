# Effects Engine Audit — measured deviations

**Run**: effects pipeline, 2026-09-29 · **Scope**: `apps/web/src/engine/paint.ts`,
`apps/web/src/ui/Canvas.tsx` — drop shadow, inner shadow, layer blur, background blur.
**Status**: **measured, then fixed and verified** (steps 5–8 below; PR #43). The deviation
report below is the pre-fix measurement, kept as the audit record.
**Suite**: green before, during and after — final run **3,599 assertions / 76 test files, 0
failing**, `tsc -b` clean, GitHub Actions `scripts/check.sh` and *Web chrome (npm test +
build)* both green on PR #43.

Instrument: `apps/web/tests/probes/effects/realCanvas.mjs` + `probe.mjs`
(`npx vite-node tests/probes/effects/probe.mjs`, needs `npm i --no-save @napi-rs/canvas`).
The probe mounts the **real** `ui/Canvas.tsx` and paints through the **real**
`engine/paint.ts` on a **Skia** backend — the same engine family Chromium uses — so
`ctx.filter`, `shadowBlur`, clip-after-filter and path/CTM semantics are the browser's,
not a model of them.

---

## 1 · Figma documentation (step 1)

All quotes from [Apply effects to layers](https://help.figma.com/hc/en-us/articles/360041488473-Apply-effects-to-layers)
unless noted.

| Behaviour | Quote | Why it matters here |
| --- | --- | --- |
| **Render order (layers)** | "**Top:** Layer blur, noise, texture (applied in their specified order) → Stroke paints → Inner shadow → Fill paints → Drop shadow → **Bottom**: Background blur, glass" | The layer blur is the **top-most** step: it is applied *once, over the composited layer* (drop shadow included), not to individual paints. |
| **Render order (groups)** | "**Top:** Layer blur, noise, texture … → Inner shadow → Paints, masks, and effects for individual fills or strokes → Drop shadow → **Bottom:** Background blur" | Same top slot; groups cast one flattened shadow. "The differences in group and layer shadows are most obvious on layers that overlap." |
| **Blur and bounds** | "Layer blurs and unclipped texture effects **extend past a selection's boundary**." | A layer blur is *not* clipped by the selection's own box. A parent frame's Clip content still clips it. |
| **Reorder** | "How effects are ordered in the **Effects** section impacts how the selection is rendered." | The list order is load-bearing: noise listed after a layer blur lands **on top** of it and stays crisp. |
| **Shadows and alpha** | "By default, Figma doesn't display drop shadows through transparent areas of the layer." Criteria for the checkbox: "Has only fills with less than 100% opacity / Has a stroke, but no fill / Has a fill or stroke with a blend mode that isn't Normal / has a center or outside stroke with less than 100% opacity" | The shadow is derived from the layer's **rendered alpha** — translucent fills, stroke-only layers and (per the forum thread on that checkbox) PNG alpha all count. Text layers: "Shadow effects on text layers translate to `text-shadow` in CSS" — glyph alpha. |
| **Shadow geometry** | "**X:** Offset the drop shadow along the x axis… **Y:** … **Blur:** Adjust the blur or feathering… **Spread:** Adjust the size…" ; "Shadow spread is only supported on rectangles, ellipses, frames, and components" | The offset is part of the effect, not a rendering hint. |
| **Background blur** | "When you apply a background blur to a layer, Figma will blur any layers behind your selection"; "you'll need to set the layer's fill opacity to any value between **.10 and 99.99%**" | Samples the backdrop *behind* the selection — including backdrop outside the selection's own box. |
| **Primitive (spec)** | HTML spec, 2D context: "the points passed to the methods, and the resulting lines added to current default path by these methods, must be transformed according to the current transformation matrix **before being added to the path**"; "The stroke *style* is affected by the transformation during painting, even if the current default path is used." | A `translate()` issued **after** a path has been traced does not move it. This is the root cause of §3.1 below. |

---

## 2 · The instrument, and why the suite never caught any of this

`probe.mjs` group **0** pins the primitive the whole shadow design rests on:

```
trace rect(10,10,20,20); translate(60,0); fill() → ink at x=15 BLACK, at x=65 white
```

That is spec-correct, and Skia agrees with Chromium here.

**The headless suite cannot see this class of bug.**
`src/ui/__tests__/softCanvas2d.mjs` stores path primitives as raw coordinates and applies
the CTM **at paint time**:

```js
case "fill": {
  const m = [...target.m];                       // CTM at fill() time
  for (const r of path) { const [x0,y0,x1,y1] = bbox(m, r[0], r[1], r[2], r[3]); … }
```

i.e. the software canvas implements the *opposite* of the spec. Every paint that traces a
path and then translates before filling — which is exactly how this painter applies shadow
offsets — "works" on the software backend and does nothing in a browser. The mask tests
(`maskAlpha.test.mjs`) only exercise tile blits, so the gap never surfaced.

Measured side by side, same scene (red rect at 100,100,100,100, shadow `x:40, blur:0`),
pixel at the offset position (210,150):

| Backend | (210,150) | (150,150) |
| --- | --- | --- |
| `softCanvas2d.mjs` (paint-time CTM) | `0,0,0` black — the offset "works" | `255,0,0` red |
| real Skia (spec: CTM at path construction) | `255,255,255` white | `255,0,0` red |

**Recommendation**: confirm §3.1 in the browser e2e suite when a Chromium is available
(`e2e/behaviour.mjs` drives a real one). The fix below is correct under either reading,
so it does not depend on that confirmation — but the *current* behaviour claim should be
pinned in the browser so the regression can never come back through the software canvas.

---

## 3 · Measured deviations (steps 3–4)

Ten deviation groups. "ours" rows are the probe's own output; the expectation column is
Figma documented behaviour (§1).

### 3.1 Drop shadow — the offset is never applied (Q1, part 1)

| Probe | ours | Figma | Verdict |
| --- | --- | --- | --- |
| **1c** opaque rect, shadow `x:40, blur:0` | `max │x=40 − x=0│ = 0.000`; shadow ink: **none** | a 20px black band at x=200…239 | **DIFF** |
| **1c″** blurred shadow `x:24, y:0, blur:6` | left bleed x=293…297 `[0.13, 0.16, 0.22, 0.27, 0.33]`, right x=403…407 `[0.27, 0.22, 0.16, 0.13, 0.09]` — a mirrored bleed | the shadow sits 24px right: x=403…407 is deep inside it (≈1.00) | **DIFF** |

The shadow is painted **exactly behind the layer**: with `blur: 0` it is completely
invisible under an opaque fill; with a blur you only see a symmetric halo with no
direction, because the blur bleeds out and the offset does not push it.

Root cause — `Canvas.tsx:1564` traces the shape, then `paintDropShadowsMasked`
(`paint.ts:916`) does, per drop (`paint.ts:944`):

```js
ctx.translate((drop.x * c + drop.y * s) * z, (-drop.x * s + drop.y * c) * z);
ctx.fill();          // ← the path was added to before the translate; the CTM cannot move it
```

Per §1's spec quote the translate is a no-op for the fill (and for the ring branch's
`ctx.stroke()` and the spread stroke). The painter is **internally inconsistent**: the
translucent-fill path `paintMaskedDrop` re-traces *after* translating (`paint.ts:1015`),
so it does offset —

| Probe | ours | Figma | Verdict |
| --- | --- | --- | --- |
| **1c′** translucent fill `#00000080`, shadow `x:40` | ink `4000px x200..239 y400..499` | offset applies | **MATCH** |
| **1d** text layer, shadow `(20,20)` | glyph `140px x505..508`, shadow `140px x525..528 y127..161` → offset `(20,20)` | glyph-shaped shadow at the glyphs + (20,20) | **MATCH** (via `ctx.shadowOffsetX/Y`) |

So today: **text and Boolean layers offset their drop shadows, everything else does not.**
Spread behaves the same way as the fill (it strokes the same pre-translated path).

### 3.2 Drop shadow — the silhouette is the traced outline, not the rendered alpha (Q1, part 2)

| Probe | ours | Figma | Verdict |
| --- | --- | --- | --- |
| **1a** image fill whose alpha is a **disc**, shadow `(20,0)` | black ink `2100px x100..199 y100..199` — the layer's **bounding box**; corner `(105,105)` (transparent in the image) is shadowed; **1272 px** shadowed that Figma leaves empty, **1120** Figma shadow px missing (14408 agree) | the shadow is the alpha — the disc, offset | **DIFF** |
| **1b** group of two disjoint opaque rects, shadow `(10,10)` | shadow pixels: **none** | the union silhouette of the children (≥1400 px) per the group render order | **DIFF** |

`canShadow` (`Canvas.tsx:1596`) requires a fill/image/stroke on the node itself, so a
container whose only paint is its children casts nothing; and for nodes with a fill the
shadow painter fills the **outline path**, so per-pixel alpha (image alpha, glyphs,
Boolean results, groups) is never consulted. The one place a real alpha mask is used is
Boolean, via `ctx.shadowColor/shadowBlur` (`Canvas.tsx:1498-1520`) — which is also why
Boolean offsets work (§3.1).

### 3.3 Layer blur — computed per paint op, not over the composite (Q2)

| Probe | ours | Figma | Verdict |
| --- | --- | --- | --- |
| **2a** blurred child inside a parent with Clip content | 5px outside the child (inside the parent) = `0.325`; at the child's edge = `0.522`; 5px outside the parent = `0.000` | spills past the child, clipped by the parent | **MATCH** |
| **2b** frame with Clip content and its **own** layer blur 10 | x=699 `0.52` · **x=700 `0.00`** · x=704 `0.00` · x=712 `0.00` (hard cut) | blur extends past the boundary: > 0 outside, ramping to 0 | **DIFF** |
| **2c** two abutting opaque children, blur 10 on the frame | coverage across the shared edge `[…0.75, 0.75, 0.75…]`, worst **0.749** — 25% of the background shows through a 17px band | `1.00`: the union of two opaque halves is solid | **DIFF** |
| **2d** one layer, fill + inside stroke, blur 10 | worst coverage **0.478** | `1.00`: fill and stroke are one composite | **DIFF** |

Root cause — `Canvas.tsx:1425-1426` sets **one** `ctx.filter`, then every individual draw
op is filtered on its own: the drop shadow's fill, the fill, glass, the inner-shadow ring,
the stroke, the glyphs, **each child**, noise and texture. Filtering each op and then
compositing is not the same as filtering the composite: wherever two ops of one layer
overlap (fill/stroke edge, two abutting children) the blurred alphas multiply-composite to
`1-(1-a)(1-b)` instead of staying 1 — hence the 0.749 and 0.478 seams.

The frame case (2b) adds an ordering error: the filter is set at the *bottom* of the
render order, before the frame's `ctx.clip()` (`Canvas.tsx:1896`), so the clip cuts the
blur (hard edge at the frame's own box) where Figma applies the blur *above* the clip.

There is already machinery that would produce the right answer for leaves — the
`cacheable` blur raster (`Canvas.tsx:1440-1500`) renders the node into an offscreen tile
and blits it once with `filter: none` — but it is gated off for every node with children,
rotation, flip, text, an image fill or a non-`source-over` blend mode, so the common cases
take the per-op path.

### 3.4 Effect stacking — blur + drop shadow (Q3)

Figma's order is one stack: `background blur → drop shadow → fills → inner shadow →
strokes → layer blur/noise/texture`. Ours puts the blur first (bottom) and lets each op
override it.

| Probe | ours | Figma | Verdict |
| --- | --- | --- | --- |
| **3a** shadow (blur 6) + layer blur 10 | worst `│with − without the layer blur│ = 0.522`; worst `│ours − Figma order│ = 0.196` on the edge row; ours `[0.93, 0.90, 0.87, …]` vs the ordered composite `[0.74, 0.71, 0.67, …]` | the composite (shadow *and* fill) blurred once | **DIFF** |
| **3b** `[layer blur, noise]` vs `[noise, layer blur]` | `max │order A − order B│ = 0.000`; dark specks `0 vs 0`; darkest pixel `252` | list order decides; blur-listed-first leaves the noise crisp on top | **DIFF** |

Details: a drop shadow with its **own** blur replaces `ctx.filter` for its op and restores
it afterwards (`paint.ts:937`), so the layer blur never reaches it, while a drop shadow
with `blur: 0` silently inherits it. And because the noise is painted under the still-live
`ctx.filter`, it is blurred away in both orders — the control scenes measure 670 dark
specks (darkest 197) for noise alone versus 0 specks (darkest 252) whenever the layer blur
is present.

### 3.5 Background blur (bonus — the fourth effect type)

| Probe | ours | Figma | Verdict |
| --- | --- | --- | --- |
| **4** background blur 12 over a backdrop with a light/dark edge at x=210 | worst `│ours − true backdrop blur│ = 0.161` at exactly x=210; row x=201…230 `[0.21 … 0.42, 0.62, 0.62, 0.64 …]` — a one-pixel step | a smooth ramp `[0.21 … 0.42, 0.45, 0.48, 0.51 … 0.62 …]` | **DIFF** |

`Canvas.tsx:1584-1596` blits **only the node's own box** under `filter = blur(N)`
(`ctx.drawImage(c, sx, sy, sw, sh, sx, sy, sw, sh)`), so the kernel reads transparent
outside the box and the selection's blurred backdrop fades at its own edge instead of
sampling the backdrop beyond it.

---

## 4 · Proposed engine fix (step 5 — proposed, not written)

One structural change fixes §3.1, §3.2, §3.3, §3.4 and most of §3.5, and it reuses
machinery that already exists in the file.

**A. Render the layer once into an offscreen tile, then apply effects to the tile.**
The painter already builds device-resolution tiles for masks and for the leaf blur cache
(`Canvas.tsx:2022-2040`, the `tile()` helper) with the current transform baked in. Extend that to every layer
that carries effects:

1. paint the layer's own content into the tile — drop shadow first (as today, but see B),
   then fills, glass, inner shadow, strokes, glyphs, **and children**;
2. blit the tile back **once** with `ctx.filter = blur(layerBlur)` (padding the tile by
   `≈3×blur` so the kernel has real pixels to read);
3. paint noise/texture *after* the blit, in effect-list order, so `[layer blur, noise]`
   stays crisp and `[noise, layer blur]` is blurred — the documented order.

Blurring the composite is exact for the seam cases (2c/2d become 1.00) and it reproduces
Figma's blend-mode isolation note for free (the tile is `source-over` internally).

**B. Give the drop shadow its own traced path, under the shadow's CTM.**
Inside `paintDropShadowsMasked`, `beginPath()` + re-trace inside the translated space (the
pattern `paintMaskedDrop` already uses) instead of filling the caller's path — the offset
then works for the shape, the ring and the spread alike.

**C. Derive the shadow's silhouette from the tile's alpha.**
Once (A) exists, the shadow is `ctx.shadowColor/shadowBlur/shadowOffsetX/Y` applied to the
tile (or an inverse-clipped blit for "show behind transparent areas" off). This is per-pixel
by construction: image alpha, glyph alpha, Boolean results and container silhouettes all
come out of the tile, and containers with only children cast the union — §3.2 solved with
the same mechanism as the Boolean path already uses.

**D. Sample a padded source for the background blur.**
Inflate the source *and* destination rect by `≈3×blur` when blitting the backdrop under
`filter = blur(N)`, keeping the clip to the node's outline, so the kernel reads backdrop
outside the selection's box.

**E. Cost control.** The existing cache key (`zoom + JSON.stringify(node)`) and byte budget
can be reused; the tile only needs to exist when the layer has effects, and only needs
re-blurring when something below it changes.

---

## 5 · Test plan (step 6 — after approval)

New `apps/web/src/ui/__tests__/effects.test.mjs`, sabotage-verified, wired into `npm test`:

1. **Per-pixel drop shadow** — the disc-alpha image casts shadow only inside
   `disc(center + offset) \ disc(center)`; assert the corner is clean and the crescent is
   inked (the 1a scene).
2. **Offset** — the opaque-rect shadow (blur 0) is a band at `x+offset..`, and the blurred
   version is directional (not the mirrored bleed of 1c″).
3. **Container silhouette** — a group of two rects casts the union (1b).
4. **Stacking** — two abutting opaque children under a layer blur read 1.00 across the
   seam (2c); one layer's fill + inside stroke read 1.00 everywhere (2d); the
   Figma-ordered composite reference matches within 0.02 (3a).
5. **Order** — `[layer blur, noise]` differs from `[noise, layer blur]` and the first keeps
   the noise crisp (3b, control: 670 specks vs 0).
6. **Clip** — a blurred child inside a clipped parent spills inside, 0 outside (2a), and a
   clipped frame's own blur spills past its box (2b).

**The instrument has to be fixed too, or the test will lie.** `softCanvas2d.mjs` must bake
the CTM into the path when a point is added (`case "fill"`/`"stroke"` currently re-applies
`target.m` at paint time), or the new test must run on a browser-faithful backend. I
recommend baking the CTM in the software canvas *and* keeping a real-backend check for
blur pixels (the software canvas records `filter` but does not execute it, and blur is the
subject of this run). That is an extra decision I'd like your call on, because it means
either an optional devDependency (`@napi-rs/canvas`) or a small Gaussian implementation in
the software backend.

---

## Appendix · probe output (2026-09-29)

```
0 · backend primitive
  trace rect(10,10,20,20); translate(60,0); fill() → ink at x=15 BLACK, at x=65 white
DIFF 1a  disc-alpha image + shadow (20,0)   corner (105,105)=shadow; 1272 px over-shadowed, 1120 missing
DIFF 1b  group of two rects + shadow (10,10)   (345,320)=empty; shadow pixels: none
DIFF 1c  opaque rect, shadow x:40, blur:0   max |x=40 − x=0| = 0.000; ink: none
DIFF 1c″ blurred shadow (24,0,6)   left [0.13…0.33]; right [0.27…0.09] — no direction
 ok  1c′ translucent fill, shadow x:40   ink 4000px x200..239 y400..499
 ok  1d  text + shadow (20,20)   glyph 140px x505..508; shadow 140px x525..528 → offset (20,20)
 ok  2a  blurred child in a clipped parent   0.325 inside / 0.000 outside the parent
DIFF 2b  clipped frame's own blur   x=699 0.52 · x=700 0.00 · x=704 0.00 · x=712 0.00
DIFF 2c  two abutting children + blur   seam worst 0.749 (expected 1.00)
DIFF 2d  fill + inside stroke + blur   worst 0.478 (expected 1.00)
DIFF 3a  shadow + layer blur   worst |ours − Figma order| = 0.196; |with − without| = 0.522
DIFF 3b  [blur, noise] vs [noise, blur]   max Δ 0.000; specks 0 vs 0 (control: 670)
DIFF 4   background blur over a backdrop edge   worst |ours − true| = 0.161 at the edge
10 deviation group(s) measured
```


---

## 6 · What shipped (steps 5–8)

Landed in PR #43, all inside `ui/Canvas.tsx` (plus the test tree) — no command, model field
or Rust file changed, so no WASM guard was touched.

| Deviation | Fix |
| --- | --- |
| §3.1 offset never applied to a path-based shadow | The shadow is no longer a fill of the caller's path. It is `ctx.shadowOffsetX/Y` + `shadowBlur` over the layer's raster, so the offset is applied where the spec applies it (at paint time). |
| §3.2 silhouette was the outline | The shadow is derived from the effected layer's offscreen tile **alpha**: image transparency, glyph coverage, Boolean results and a container's union of children are all per-pixel by construction. Spread dilates that alpha with 16 offset draws. |
| §3.3 blur computed per draw op | The layer paints once into a tile; the blur is a single filtered blit of the composite. Two abutting children now read 1.000 through their seam, fill + inside stroke 1.000. |
| §3.3 blur cut by the frame's clip | The blur is the top-most step of the pipeline: the tile is rasterised *inside* the clip and blurred *after* it, so a clipped frame's own blur spills past its box until a parent's clip stops it. |
| §3.4 list order ignored | `noise`/`texture` rows are split by their index relative to the layer blur: rows above it paint into the tile (and are blurred), rows below paint on top of the blurred composite. |
| §3.4 shadow's own blur replaced the layer blur | A shadow's blur is applied while the tile is built; the layer blur is applied to the finished composite, so both reach the shadow. |
| §3.5 background blur read only the box | The backdrop blit's source rect is grown by `3 × blur`, with the clip still at the node's outline. |
| Method: the baseline canvas hid §3.1 | `softCanvas2d.mjs` bakes the CTM in when a path point is added, per the spec. |

**Verification.** `apps/web/src/ui/__tests__/effects.test.mjs` (26 assertions) runs the real
paint path on Skia through `src/ui/__tests__/realCanvas2d.mjs`; `@napi-rs/canvas` is a
devDependency. Sabotage runs, each restored afterwards:

| sabotage | expected failure | measured |
| --- | --- | --- |
| the shadow's silhouette is the tile's rectangular footprint, not its alpha | A1–A4 | **3 FAIL** (A1 1008 px over-shadowed, A2, A4 a 200×60 box shadow) |
| the effect list's order is ignored (`postBlur = topGroup`) | C, C-order | **2 FAIL** (`[noise, blur]` rendered crisp: 794 specks vs 0) |
| the layer blur is set per draw op again (the pre-fix behaviour) | B2, B3, B4, C2 | **4 FAIL** (B3 seam 0.749, B4 edge 0.675, C2 0.075 off the documented profile) |
| restored | — | **26 passed** |

Full suite after restore: **3,599 assertions, 0 failing**; `tsc -b` clean; PR #43's *Web
chrome (npm test + build)* and `scripts/check.sh` jobs both green.

**Residual, recorded rather than hidden:** progressive (non-uniform) layer and background
blurs are still uniform; the leaf blur raster cache was removed along with the per-op path,
so an animated effected layer re-rasterises its tile each frame (the tile itself has no
cache yet); a canvas too large for the tile budget (> 4096 px a side or > 16.7 M px) falls
back to the direct paint path and therefore to the old per-op behaviour.
