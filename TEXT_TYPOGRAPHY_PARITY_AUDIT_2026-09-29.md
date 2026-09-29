# Text and typography — section parity audit (2026-09-29)

Source: https://help.figma.com/hc/en-us/sections/360006606853-Text-and-typography (14 articles).
Probe: `X-Native/apps/web/tests/probes/text/sectionAudit.mjs` (real `MemoryEngine` + real Skia
pixels via `mountRealCanvas` + the app's own `textLayout` functions). Pre-fix measurement —
no code changed. Feature-presence facts are grep/source-verified against
`src/engine/types.ts`, `memory.ts`, `ui/Canvas.tsx`, `ui/inspector.tsx`, `ui/chrome.tsx`.

## 1 · Rules cited (article → rule)

- **Guide to text in Figma Design** [360039956434](https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design): text tool `T`; click → **Auto width**, drag → **Fixed size**; **Text on a path** tool (wraps along a vector path; the vector's fill/effects transfer to the text; blue handle sets the start; **Flip text orientation**); double-click/`Enter` to edit; *"Once you're editing a text layer, you can update the contents of other text layers without having to double-click"*; **Multi-edit text** (select several → Enter → *"Any changes you make will apply to all text layers you have selected"*); font fill *"will only update the color of the text"* (background = frame fill).
- **Adjust text dimensions and resizing** [27378154668951](https://help.figma.com/hc/en-us/articles/27378154668951-Adjust-text-dimensions-and-resizing): *"When you manually change a layer's dimensions in the canvas, Figma will also update the resizing property to **Fixed size**"*; Scale tool changes *"the font size, as well as the bounds"*; Wrap style only for multi-line; *"Layers set to **Auto width** only break where you press Return or Enter, so wrap style has no effect on them."*
- **Explore text properties** [360039956634](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties): vertical alignment *"only possible … in text layers with a **Fixed Size**. Layers with resizing set to Auto Width or Auto Height will ignore alignment"*; underline **details** (Style solid/dotted/wavy, Thickness, Offset, **Skip ink**, Color); letter case incl. **Small caps**; **Paragraph indent** — *"offsets the text in the first line … You can only apply paragraph indentation to text that uses the horizontal alignment setting Text-align left"*, applies to all paragraphs; **Truncate text** + **Max lines** (*"available only if truncate text is enabled, and: Text resizing is set to auto height or auto width"*); **Vertical trim** (removes space above/below text; `leading-trim` in Dev Mode); **Wrap style** Auto/Balance/Pretty — Balance *"distributes text as evenly as possible across every line"*, Pretty *"keeps each line full, but adjusts the last four lines to avoid an orphan—a single word stranded alone on the last line"* — *"has no effect on a single line of text, or on layers with … Auto width"*; Numbers (fractions `X/X`, super/subscript w/ **faux typography**, slashed zero, proportional/monospace × lining/old-style); line height **px or % of font size**, default **Auto**; shortcuts ⇧⌘</> size, ⌥⌘</> weight, ⌥</> spacing, ⇧⌥</> leading, ⌥U underline.
- **Lists** [360040449773](https://help.figma.com/hc/en-us/articles/360040449773-Create-bulleted-and-numbered-lists): create by `-` or `*` + Space (bulleted), `1.` or `1)` + Space (numbered), or the panel; **⌘⇧8** bulleted / **⌘⇧7** numbered (*"turn an individual text selection or multiple text layers into a bulleted list"*); *"Figma currently supports up to five levels of indentation"*; *"numbered list counters rotate between numbers, alphabetical characters, and roman numerals with each indentation"*; indent ↑ `Tab`, `⌘]`, `Ctrl+]`; indent ↓ `Backspace`/`Delete` at item start (*"delete the counter, but keep the same level"*) and `Return` on an empty item; **List spacing** px (default 0); **Hanging quotes** / **Hanging lists** toggles (markers outside the box); *"The first character of the first item in the list sets the color for the bullets"*; ⌘Z right after a list shortcut removes the default styling.
- **Links** [360045942953](https://help.figma.com/hc/en-us/articles/360045942953-Add-links-to-text): link a layer or a text range; **Create link** panel row, **⇧⌘U** chord, paste a URL in place (**⌘⇧V** pastes as plain text); hover previews, click follows (external opens a new tab; **⌘-click blocks**); edit/delete in text edit mode; *"Links are styled with an underline by default"*.
- **Text styles** [360039957034](https://help.figma.com/hc/en-us/articles/360039957034-Create-and-apply-text-styles): reusable type-property sets (family/weight/size, line height, letter spacing, paragraph spacing & indentation, decoration, letter case, lists, OpenType ✓; alignment/color/resizing ✕); apply to a layer **or a range**; edit propagates; ⌘B/⌘I/⌘U on a range *"without breaking the layer's existing text style"*.

## 2 · Measured — MATCH (probe, exact numbers)

| rule | measured |
| --- | --- |
| Manual dimension change → **Fixed size**; untouched axis keeps hug (A1/A2) | `resize` w 120→300 flips `sizingW:"hug"→"fixed"`; `sizingH` stays `"hug"` |
| Vertical alignment only on Fixed size (A3/A4) | fixed+middle lifts ink **Δ76.0px** = (200−48)/2 exactly; auto-height+middle stays top-anchored (Δ<20) — `valignApplies` |
| Scale tool scales font with bounds (A5) | 100×40@20 scaled to 150×60 → **fontSize 30** |
| Wrap **Balance** evens lines (B1) | greedy `10/6/4` chars → balanced `8/6/6` |
| Wrap **Pretty** kills the single-word orphan (B2) | last line 1 word → **3 words** after pretty |
| Wrap style inert on Auto width (B3) | hug identical with `balance` vs `auto` |
| Truncate + Max lines path (B4) | model carries `truncate/maxLines`; `fitLineCount` unbounded on a tall box; painter appends `…` and clips rows |
| Paragraph indent left-only (B5) | `indentOf` = `24/0/0` for left/center/right — the article's rule, coded |
| Sequential numbered markers (C1) | `1. 2. 3. 4. 5.` per paragraph |
| Type shortcuts ⇧⌘</>, ⌥⌘</>, ⌥</>, ⇧⌥</>, ⌥U (+⌘U), ⌘I | all bound in `chrome.tsx` with e.code handling |
| Click-to-edit switch between texts while editing; Enter/double-click to edit | `editSwitch` (`Canvas.tsx:4301`) |
| Letter case incl. Small caps (real `font-variant: small-caps`, not uppercasing) | `applyTextCase` + `canvasTextFont` |
| Justify stretches inter-word gaps uniformly on non-final rows | `paintText` |
| Auto width on click / Fixed on drag creation | text tool create path (`sizingW:"hug"` vs drag box) — code-pinned |

## 3 · Measured — DEVIATIONS (the report)

### A. List machinery (article [360040449773])
- **D1 — No indentation levels.** Article: *"five levels of indentation"*, `Tab`/`⌘]`/`Ctrl+]` to indent, `Backspace`/`Delete` at start deletes the counter *"but keep[s] the same level"*, `Return` on an empty item decreases indentation. Ours: `listMarker(style, index)` has **no level parameter** (probe C2: "no"); no per-paragraph indent level exists; none of the four chords/keys act on list level.
- **D2 — No counter rotation.** Article: *"numbered list counters rotate between numbers, alphabetical characters, and roman numerals with each indentation"*. Ours: always `${index+1}.` (probe C3: "never rotates") — `1. 2. 3.` at every depth.
- **D3 — No hanging toggles.** Article: **Hanging quotes** and **Hanging lists** are toggles. Ours: no fields (probe C4: "undefined"); list markers always hang in the gutter, opening quotes never hang.
- **D4 — No list spacing.** Article: px field, default 0. Ours: no `listSpacing` field (probe C5: "no field").
- **D5 — No creation characters / conversion chords.** `-` or `*` + Space, `1.` or `1)` + Space start lists; **⌘⇧8** / **⌘⇧7** convert a selection *"or multiple text layers"*. Ours: none (textarea handler = Escape/⌘Enter only; no Key8/Key7 chords).
- **D6 — Bullet color rule.** *"The first character of the first item in the list sets the color for the bullets"*. Ours paints every marker with the layer's base fill (`ctx.fillStyle = textFill`), ignoring runs.

### B. Type settings (article [360039956634])
- **D7 — No vertical trim.** No model field (probe D2: "no field"); no `leading-trim` in the Dev Mode output.
- **D8 — No underline details.** Article: Style **solid/dotted/wavy**, Thickness, Offset, **Skip ink**, Color. Ours: bare `textDecoration: "underline"` (probe D3: "none") painted as one solid line.
- **D9 — No Numbers section.** Fractions, superscript/subscript (incl. Figma's faux synthesis), slashed zero, figure style (proportional/monospace × lining/old-style) — none (probe D4: "none").
- **D10 — Line height is px-only.** Article: *"a fixed line height in pixels (px) or a line height that's a percentage of the font size (%) … switch between fixed and percentage … Figma will convert"*. Ours: `lineHeight: number` px, 0=auto (probe D5: "px only") — no % unit or conversion.
- **D11 — Pretty nuance.** Article: *"adjusts the last four lines"*. Ours (`balanceLines`) rebalances only the final line's orphan (last two lines) — the orphan goal matches; the four-line adjustment does not.
- **D12 — Wrap style is layer-level only.** Article: applies at text layer / **paragraph** / text style levels. Ours: whole-layer `textWrap` only.

### C. Feature-level absences (grep-verified, whole surfaces)
- **D13 — Links in text** [360045942953]: no hyperlink model (probe D1: "no field"), no ⇧⌘U / Create-link row / paste-in-place / ⌘⇧V plain paste / hover preview / ⌘-click guard / default-underlined links.
- **D14 — Multi-edit text** [360039956434]: Enter edits only `selection[0]` (`Canvas.tsx:984`); *"changes … apply to all text layers"* does not exist.
- **D15 — Text styles** [360039957034]: `SharedStyle` is *"Scoped to solid paints for now"*; `applyStyle` is `kind: "fill" | "stroke"`; no text-style create/apply/edit, no range application, no style propagation.
- **D16 — Text on a path** [360039956434]: no tool, no path-following text, no fill/effect transfer, no start handle, no Flip text orientation.
- **D17 — OpenType features & variable fonts** [4913951097367 / 5579502031511]: no `font-feature-settings` / `font-variation-settings` model or Type-settings Details/Variable tabs (ligatures, stylistic sets, character variants, figure styles, weight/width/optical-size/slant axes).
- **D18 — Emojis & smart symbols, icon fonts, CJK, RTL** [360039957174 / 360040449513 / 360040449673 / 4972283635863]: no emoji/smart-symbol insertion, no icon-font flows, no CJK-specific handling (Noto defaults), no bidi/RTL reordering.

## 4 · Fix groups — status (run 14)

1. **List machinery** (D1–D6): **DONE** — per-paragraph `listLevels` (five levels, default width 24, anchored re-detection rewrites the counts), Tab/⌘]/Ctrl+]/Backspace/Return semantics in the textarea, counter rotation `n.`/`a.`/`i.` per `level%3`, `hangingLists` (default ON) + `hangingQuotes` (default OFF, paragraph-start only), `listSpacing` as an additive per-item gap, creation chars, ⌘⇧8/⌘⇧7 multi-layer with `rehugText`, bullet colour from the first character of the first item (`node.fill === "mixed"`).
2. **Type settings** (D7–D12): **DONE** — vertical trim (fs×0.242 both edges + `leading-trim: both; text-edge: cap alphabetic`), underline style/thickness/offset/skip-ink/colour (skip-ink = underline under the glyphs), Numbers (faux super/sub 0.7em at −0.14em/+0.38em, fractions with a 0.6em bar, slashed zero, 4 figure styles), line-height unit auto/px/% (`effectiveLineHeight`: % of font size / stored px / fs×1.2 auto; unit switch rounds to the nearest pixel), paragraph/range wrap style via `paraWrap`. exports (`svgExport.ts`) and Dev Mode rules carry the new values. **Not changed:** `balanceLines` still balances the last **two** lines, not the documented last four (D11 — geometry surgery in `geometry.ts:1885`, kept out of this batch's painter work to protect the 70-file suite; tracked as the remaining type-settings item).
3. **Links** (D13): **DONE** — `link` on nodes and runs (`textSpans.styleTextRange`), ⇧⌘U input box above the selection (`x-native:link-input` bus), Enter applies run- or node-level (underlined by default when the layer is undecorated), paste-in-place links a URL (⇧ paste stays plain; pasting twice = text then link), hover preview "… · click to open", click follows in a new tab with the ⌘/Ctrl-select guard, Unlink row + ⌘U removes.
4. **Multi-edit text** (D14): **DONE** — Enter on a multi text selection opens one editor (shared content shown when identical, empty otherwise) and applies the contents to every selected text layer (`edit.also` fan-out with per-layer `hugSize`).
5. **Text styles** (D15): **PENDING** — `kind:"text"` in the style store + picker + range application + edit propagation.
6. **Text on a path** (D16), **OpenType/variable fonts** (D17), **emoji/CJK/RTL** (D18): **PENDING** — whole features (tools, engine, fonts), continue the run.

## 5 · Decisions and residuals (run 14)

- **Defaults the articles don't pin:** hanging lists **ON** (marker in the gutter, `markerX = −gutter`, `textLead = 0`); hanging quotes **OFF** (`hangingQuotes` absent); `listSpacing` **0** and additive with `paragraphSpacing` (`extra = itemGaps × listSpacing`); counter rotation `level%3`; `paraList === null` = Backspace-deleted counter (level kept, not counted); levels 0–4; `effectiveLineHeight` auto = fs×1.2; link-open is a new tab.
- **Approximations (canvas2d):** faux super/sub dy −0.14em/+0.38em at 0.7em; vertical-trim edges use Inter's cap/osage ratios (fs×0.242); wavy amplitude `max(1, uW×1.5)`; dotted dash `[uW, 2uW]`; slashed-zero slash spans gW 0.18→0.82; skip-ink via the underline-under-glyphs pre-pass.
- **Residuals:** canvas2d exposes `fontVariantCaps` only — `font-variant-numeric` (figure styles/fractions) reaches the textarea CSS, SVG/codegen and Dev Mode but not canvas pixels; hanging-quote + centre/right alignment shifts the stripped line (quote stays in place at left); run-14 links cover node-level follow/hover (run-level ranges store `link` and style, the follow/hover hit-test reads the layer link).
- **Tests:** `typography.test.mjs` 40 (list geometry pins both hanging variants), batch3 131, export24 43, codegen 63, events census 43 (new `x-native:link-input` entry); whole suite green, `tsc -b` clean.
