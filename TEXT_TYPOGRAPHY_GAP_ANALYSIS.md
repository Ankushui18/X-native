# Text & Typography Gap Analysis: Figma vs X-Native

Source of truth for "what Figma does": the 14 articles in
[Figma Learn → Text and typography](https://help.figma.com/hc/en-us/sections/360006606853-Text-and-typography).
Source of truth for "what X-Native does": this tree, read line by line — every
claim below carries a `file:line`. The analysis was written against `a2cefb0`
(the Phase 6 merge); the references have since been carried forward to this
branch's head, which repairs that merge's build damage, adds the P0 work below,
and has been through `cargo fmt` — so the numbers are this branch's, not
`a2cefb0`'s. If the tree moves again, grep by symbol name: the claims are about
code, not coordinates.

## Executive Summary

X-Native's **text engine is close to Figma**; its **text product is not**.

`crates/x-text` is a real shaper, not a toy: rustybuzz (HarfBuzz port) for
GSUB ligatures and GPOS/kern positioning, `unicode-bidi` for RTL and mixed
directional runs, per-run font-coverage segmentation so one line can mix Latin
+ Devanagari + CJK, CJK line breaking without spaces, synthesized small caps,
variable-font axes (`wght`/`opsz`/`wdth`), a shaped-text cache, and a
three-sink parity contract (canvas / SVG / PDF all derive glyph geometry from
the same `node_text_outlines` pipeline, pinned by
`crates/x-native/tests/text_export_parity.rs`).

What is missing sits almost entirely **above** the engine:

| Layer | State |
| --- | --- |
| Shaping / layout engine (`x-text`) | ~85% of Figma's documented behaviour |
| Data model (`x-core`) | Two **parallel, partially dead** representations of the same properties |
| Renderer wiring (`x-render`) | Reads one representation, ignores the other |
| Inspector UI (`x-designer`) | Offers controls for properties nothing renders — **phantom controls** |
| Text styles | **Wired on this branch** (P0.1/P0.2 below): registry ops, `.x` round-trip, inspector picker |
| Variables → typography | **Resolved at render time on this branch** (P0.3 below) for size / line-height / letter spacing |
| Fonts (browse / add / missing) | Engine has Google Fonts + system enumeration; **no UI reaches either** |

Concretely, of the properties Figma documents in *Explore text properties*,
these are settable in our inspector and saved in `.x` but **do not render**:
horizontal alignment, vertical alignment, decoration (underline /
strikethrough), lists, list spacing, paragraph indent, hanging quotes, hanging
lists, truncation, max lines. A user can cycle "Decoration: Underline" today
and nothing on canvas changes.

Two more findings that are not typography but blocked all of this work:

1. **`main` did not compile.** `crates/x-core/src/node.rs` was missing the
   closing brace of `pub struct Node` (line 242 opens; `pub image_rotation:
   f64,` at 354 was followed directly by `impl Node {`), which is exactly the
   CI failure on `main`: *"error: this file contains an unclosed delimiter →
   crates/x-core/src/node.rs:1707:3"*. Behind it, the Phase 6 commit added
   `Paint::{AngularGradient, DiamondGradient}` and
   `BlendKind::{PlusDarker, PlusLighter, PassThrough}` without updating the 13
   exhaustive `match`es they appear in, plus two type errors in the new
   text-formatting panel (`f32` into an `f64` field, `u32` into
   `Option<usize>`). Repaired in `03a68a0`.
2. **`TEXT_FORMATTING_IMPLEMENTATION.md` overstates what shipped.** It lists
   eight "implemented features"; three files changed (model + serialize +
   deserialize). No renderer, no engine, no test. Treat that document as a
   model-layer changelog, not a feature record.

### Status legend used below

- ✅ **end-to-end** — model → inspector → renderer → export, with a test
- 🟡 **partial** — some layers wired, at least one missing (usually the renderer)
- ☠️ **dead** — code exists and is unreachable from the product
- ❌ **missing** — no code at all

---

## 1. What already works (so the backlog doesn't re-do it)

### Engine (`crates/x-text`, 4 771 LOC)

| Capability | Evidence |
| --- | --- |
| TTF/OTF loading, cmap/glyf/hmtx via `ttf-parser` | `font.rs:1-120` |
| Kerning (`kern` table + GPOS through rustybuzz) | `font.rs:103-109`, `shaping.rs:1556-1580` (test) |
| Ligatures (GSUB `liga`) | `shaping.rs:1542-1553` (test: "fi" → 1 glyph) |
| BiDi + RTL (Arabic joining, visual runs) | `shaping.rs:134-160` |
| Per-run font-coverage segmentation (mixed scripts in one line) | `shaping.rs:150-154` |
| CJK line breaking without spaces | `typography_fixture.rs:158-166` (test) |
| Font fallback per run, incl. forced Noto CJK load | `font.rs:238-244` |
| Letter spacing, word spacing, paragraph spacing | `shaping.rs:692-714`, `:845` |
| Line-height modes: auto / px / % (CSS half-leading model) | `node.rs:422-452`, `scene.rs:397-417` |
| Horizontal align in the shaper (Left/Center/Right) | `shaping.rs:662-666`, `:815`, `:1845-1860` (test) |
| Wrap styles Auto / Balance / Pretty (Figma Aug-2026) | `node.rs:464-477`, `shaping.rs:701` |
| Synthesized small caps (70% uppercase) when no `smcp` | `shaping.rs:668-712` |
| Variable-font axes (`wght`, `opsz`, `wdth`) | `shaping.rs:29`, `:206-215`, `:780-783` |
| Shaped-text cache keyed on the full style tuple | `cache.rs:47`, `:123-190` |
| System font enumeration (platform dirs) | `sources.rs:36-107` |
| Google Fonts catalog / search / download / install | `sources.rs:191-390` |
| Font subsetting for HTML export | `subset.rs` (TrueType only — `docs/KNOWN_DEBT.md` §7) |
| Three-sink glyph parity (canvas/SVG/PDF) | `x-native/tests/text_export_parity.rs` |
| Multi-script fixture (Devanagari, Arabic, CJK, emoji) | `x-native/tests/typography_fixture.rs` |

### Product

| Capability | Evidence |
| --- | --- |
| Text tool: click/drag creates a node and enters edit | `run.rs:4094-4110` |
| Inline editor: caret, anchor, shift-select, ⌘A, word/line nav | `run.rs:4330-4434`, `state.rs:1464-1478` |
| Per-range rich text: color / size / family / weight / italic / ls | `node.rs:807-819`, `run.rs:1962-1997` |
| ⌘B / ⌘I on the selection (runs), with toggle-off semantics | `run.rs:1972-1997`, `:4416-4423` |
| Bounded undo inside the editor, document undo at commit | `text_session.rs:1-82` |
| Grapheme-correct editing (ZWJ emoji, combining marks) | `run.rs:1708` |
| Empty-on-commit deletes the layer (Figma parity) | `run.rs:2087-2093` |
| Auto-width text box that hugs measured ink | `run.rs:2220-2318` |
| Manual resize / W-H edit pins the box to `tm=fixed` | `run.rs:3589-3601`, `:3704-3716`, `:9235-9244` |
| Typography panel: family, weight, size, line height (+mode), letter/word/paragraph spacing, baseline shift, text case, opsz, wdth | `editor_ui.rs:3035-3298`, `run.rs:2349-2463` |
| Text case transform (upper/lower/title/small caps) | `node.rs:853`, `ir.rs:1135`, `scene.rs:359` |
| Named styles: apply/bind/detach/rename/usage/resolve + `.xlib` pinning | `document.rs:37-148`, `library.rs:101-127`, `:274-282` |
| Dev Mode CSS: font-size/family/line-height/letter-spacing/text-wrap/weight/italic | `devmode.rs:306-344` |
| Codegen: JSX/Tailwind/CSS/Swift/Compose/XML text output | `codegen.rs:427-456`, `devmode.rs:578-595`, `:821-822`, `:948-957` |
| Figma REST + `.fig` binary import of text (base style + per-char runs) | `figma.rs:674-767`, `figbinary.rs:313-410` |

---

## 2. Article-by-article mapping

### 2.1 Guide to text in Figma Design — 🟡

| Figma | X-Native | Status |
| --- | --- | --- |
| `T` tool; click → Auto width, drag → Fixed size | `run.rs:4094-4110` creates + enters edit; `tm=fixed` only ever written on manual resize (`run.rs:3599`) | 🟡 click-vs-drag does **not** set the resizing mode at creation |
| Double-click / `Enter` to edit | `run.rs:4330+`, `is_double_click` `run.rs:2101` | ✅ |
| While editing, click another text layer to edit it | not implemented | ❌ |
| Multi-edit text (one edit applies to N layers) | not implemented | ❌ |
| Spellcheck | not implemented (no `spell` anywhere) | ❌ |
| **Text on a path** tool (+ flip orientation) | not implemented | ❌ |
| Fill on text (solid/gradient/image) | fills iterate for text: `ir.rs:1160-1218` | ✅ |
| **Stroke on text** (outline individual characters) | the `NodeKind::Text` arm emits fills only; `active_strokes()` is used by other kinds (`ir.rs:559`, `:1029`) | ❌ |
| Effects on text (shadow/blur) | `ir.rs:1174` (layer blur taps) | ✅ |

### 2.2 Explore text properties — 🟡 (the core of the gap)

Figma's property list, against what our four layers actually do.
"Model A" = the `Node.text_*` enum fields (`node.rs:342-352`);
"Model B" = the `bindings` string map (`font`, `fw`, `fs`, `lh*`, `ls`, `ws`,
`ps`, `bs`, `tc`, `opsz`, `wdth`, `tw`, `tm`).

| Figma property | Model | Inspector | Renderer | Export | Verdict |
| --- | --- | --- | --- | --- | --- |
| Font family | B `font` | ✅ `editor_ui.rs:3063-3074` | ✅ `scene.rs:386` | ✅ | ✅ |
| Font weight / style | B `fw` | ✅ `:3075-3086` | ✅ `scene.rs:382-395` | ✅ | ✅ |
| Font size | B `fs` | ✅ `:3087-3098` | ✅ `ir.rs:1068-1083` | ✅ | ✅ |
| Line height (auto / px / %) | B `lhm`,`lhpx`,`lhp` | ✅ + mode dropdown `:3100-3139` | ✅ `scene.rs:397-417` | ✅ | ✅ |
| Letter spacing | B `ls` | ✅ `:3105`, `:3140` | ✅ `ir.rs:1085-1089` | ✅ | ✅ |
| Horizontal alignment (L/C/R/**Justify**) | A `text_align` | 🟡 cycles `run.rs:7590-7595`; the 6-button row is decorative (`let active = i == 0;` `editor_ui.rs:3270`) | ❌ **`scene.rs:445` hardcodes `Align::Left`**; `RenderCommand::Glyphs` has no align field (`ir.rs:44-66`) | ❌ no `text-align` in CSS (`devmode.rs:306-344`) | 🟡 phantom |
| Vertical alignment (Top/Middle/Bottom) | A `text_align_vertical` | 🟡 cycles `run.rs:7606` | ❌ not read anywhere outside model/UI/format | ❌ | 🟡 phantom |
| Decoration: underline / strikethrough (+ style, thickness, offset, skip-ink, color) | A `text_decoration` | 🟡 cycles `run.rs:7621-7627` | ❌ **no underline/strikethrough drawing code exists in the repo** | ❌ | 🟡 phantom |
| Letter case (upper/lower/capitalize/**small caps**) | **both**: A `text_case` (dead) and B `tc` (live) | ✅ via B `run.rs:2433-2444` | ✅ via B `ir.rs:1135`, `scene.rs:359`; small caps `shaping.rs:706-712` | 🟡 A serializes (`serialize.rs:884`) but nothing writes it | 🟡 duplicate model |
| Vertical trim (cap-height box, `leading-trim`) | — | ❌ | ❌ | ❌ | ❌ |
| Lists (bulleted / numbered, 5 indent levels, counters rotate numbers → letters → roman) | A `list_style` | 🟡 cycles `run.rs:7653-7657` | ❌ no bullet/counter drawing code | ❌ | 🟡 phantom |
| List spacing | — | ❌ | ❌ | ❌ | ❌ |
| Paragraph spacing | **both**: A `paragraph_spacing` (dead) and B `ps` (live) | ✅ via B `run.rs:2411-2416` | ✅ `shaping.rs:845` | 🟡 A serializes, never written | 🟡 duplicate model |
| Paragraph indent (first line) | A `paragraph_indent` | ✅ field `run.rs:9354-9360` | ❌ | ❌ | 🟡 phantom |
| Hanging quotes | A `hanging_punctuation.quotes` | ❌ no control | ❌ | ✅ round-trips `deserialize.rs:920` | ☠️ |
| Hanging lists | A `hanging_punctuation.lists` | ❌ | ❌ | ✅ | ☠️ |
| Truncate text + Max lines | A `text_truncation`, `max_lines` | ✅ `run.rs:7638-7642`, `:9362-9368` | ❌ no ellipsis/clamp code (the only `truncate` is UI-label eliding, `paint.rs:356`) | ❌ | 🟡 phantom |
| Wrap style (Auto / Balance / Pretty) | B `tw` | ❌ no control (the panel's "Wrap style" row is the unrelated CSS `WrapStyle`, see 2.2.1) | ✅ `node.rs:454-462`, `shaping.rs:701` | ✅ `devmode.rs:326-329` | 🟡 engine-only |
| Numbers: fractions, sub/superscript, slashed zero, proportional/tabular × lining/old-style | — | ❌ (`bs` baseline shift is node-wide, not per-range) | ❌ | ❌ | ❌ |
| OpenType features (`ss01`-`ss20`, `cv01`…, `liga`/`dlig`/`calt`, `ordn`, `frac`, `tnum`…) | — | ❌ | ❌ **`rustybuzz::shape(&face, &[], buf)` — the feature list is always empty** (`shaping.rs:225`); `Span` has `variations` but no `features` (`shaping.rs:20-30`) | ❌ | ❌ |
| Variable-font axes | B `opsz`, `wdth` (+ `fw`) | ✅ `editor_ui.rs:3226-3260` | ✅ `shaping.rs:206-215` | ❌ not in Dev Mode output | 🟡 |
| Dev Mode inspection (copy all properties) | — | 🟡 partial CSS | — | 🟡 | 🟡 |

#### 2.2.1 Two different things both called "wrap style"

`node.rs:663-684` defines `WrapStyle { Normal, BreakWord }` (a CSS concept),
serialized (`serialize.rs`), round-tripped, and exposed in the inspector as
"Wrap style" (`editor_ui.rs:3385-3409`, `run.rs:7668-7672`). Figma's *Wrap
style* is `TextWrap { Auto, Balance, Pretty }` (`node.rs:464-477`), which we
also implement — in the engine — with **no inspector control**. So the panel
label "Wrap style" is bound to the property Figma does not have, while the
property Figma does have is unreachable from the UI. Neither `BreakWord` nor
`text_case`/`paragraph_spacing`/`text_align*`/`text_decoration`/… (Model A) is
read by any renderer.

### 2.3 Add a font to Figma — 🟡

Figma: desktop app reads installed fonts; browser needs the Font Helper;
.TTF/.OTF only; shared org fonts; missing-font alerts and replacement.

X-Native is a native app, so the desktop half is the relevant one:
`SystemFonts::enumerate()` scans the platform dirs (`sources.rs:36-107`,
`font.rs:200-250`) and `FontManager::load_system_fonts()` loads them. What is
missing is everything user-facing:

- ❌ No "add font" / font-folder flow, no drag-a-font-in.
- ❌ **No missing-font detection.** The notification center ships a *hardcoded
  mock*: `"Inter font not installed — using fallback"` is a literal in
  `NotificationCenter::default()` (`state.rs:808-815`), not a probe. An
  unresolved family silently falls back to the default face
  (`scene.rs:386-395`).
- ❌ No replacement/substitution dialog.
- 🟡 `.fig`/REST import records the family name only; if it isn't installed the
  file renders in the default face with no warning.

### 2.4 Browse and apply fonts — ❌ (engine ✅, UI ❌)

Figma: a font picker with search + filters (All / In this file / Popular / Used
at org / Installed by you / Google fonts / Variable fonts), hover-to-preview on
the selected layer, per-session filter memory; fonts apply to a layer, to many
layers, or to a range inside a layer.

X-Native: the family field is a **free-text input** (`editor_ui.rs:3065-3076`)
that writes the `font` binding verbatim (`run.rs:2364-2371`) — no validation
against loaded families, no list, no preview, no filters. Meanwhile
`GoogleFonts::{catalog, search, fetch, install_family}` (`sources.rs:250-390`,
with a curl-based downloader and on-disk cache) and
`SystemFonts::family_names()` (`sources.rs:69`) are **referenced by no code
outside `x-text` and its own tests** — the picker's entire backend already
exists and is unreachable.

Applying to a *range* works (`text_style_field` scopes panel commits to the
editor selection, `run.rs:1999-2003`); applying to *many layers* at once does
not (`set_text_typo` uses `doc.selected_id()`, singular — `run.rs:2498-2503`).

### 2.5 Create and apply text styles — ☠️ **priority area**

Figma's own property table for text styles:

| Text property | In a Figma text style | In `TextStyleData` today |
| --- | --- | --- |
| Font family, weight, size | ✓ | ✓ (`styles.rs:216-236`) |
| Line height | ✓ | ✓ (single `f64`, **no auto/px/% mode**) |
| Letter spacing | ✓ | ✓ |
| Paragraph spacing and indentation | ✓ | spacing ✓, **indent ✗** |
| Horizontal / vertical alignment | ✕ | — (correct to omit) |
| Color / fill | ✕ | — (correct to omit) |
| Decoration | ✓ | ✓ |
| Letter case (transform) | ✓ | ✓ |
| Lists | ✓ | **✗** |
| Resizing behaviour | ✕ | — (correct to omit) |
| OpenType features | ✓ | **✗** |
| Wrap style (per *Wrap style* article) | ✓ | **✗** |

Everything around that struct is dead:

- `StyleLibrary` (add/get/get_by_name/remove/update/list/import/name_available,
  `styles.rs:546-653`), `Style`, `StyleData::Text`, `StyleUsage`
  (`styles.rs:655-691`), `StyleId` — **referenced only from
  `crates/x-core/src/styles.rs` itself**. No document field, no editor op, no
  serialization, no UI, no test.
- The live path is the *deprecated* `LegacyStyle::Text { font, size,
  letter_spacing, line_height }` (`document.rs:13-25`) — and its applier
  **throws two of the four fields away**:

  ```rust
  LegacyStyle::Text { font, size, .. } => {      // document.rs:160
      if !font.is_empty() { n.bindings.insert("font".into(), font.clone()); }
      if *size > 0.0 { n.h = *size; }            // legacy em convention
  }
  ```

  `letter_spacing` and `line_height` are bound to `..` and dropped. And size is
  written to `n.h`, which the modern pipeline ignores whenever an `fs` binding
  exists (`ir.rs:1068-1083`: `fs_binding.unwrap_or(node.h * 0.72)`) — so
  applying a text style to any node the editor has touched **changes nothing
  visible**.
- There is no style picker in the inspector. The Typography section draws a
  `grid-2x2` icon and a `plus` icon at `editor_ui.rs:3050-3064`; neither is in
  the `hit` list, so neither is clickable.
- No `textStyleId` handling in either Figma importer (`figma.rs:674-767`,
  `figbinary.rs:313-410` read `style`/`styleOverrideTable` only), so styles do
  not survive a round trip through Figma.
- `.x` carries `styles` (`serialize.rs:1051-1062`, `deserialize.rs:1073`) but as
  `legacy_style_json` — the modern type has no wire format.
- `crates/x-native/tests/library_lifecycle.rs` exercises `.xlib` style
  publish/pin/merge, so the *library* half of the story is real; the *editor*
  half is not.

**Verdict:** the architecture was designed twice and wired zero times. This is
the P0 in §4.

### 2.6 Adjust text dimensions and resizing — 🟡

Figma has three resizing modes: **Auto width** (single-click creation), **Auto
height** (fixed width, grows vertically — the paragraph default), **Fixed size**
(drag creation; manual dimension edits force Fixed). Plus: the Scale tool
changes font size *and* bounds together; vertical alignment only applies to
Fixed size; max-lines only with Auto height/width or hug-contents.

X-Native has **two** of the three, and no mode switcher:

- Auto width ✅ — `autosize_text_node` measures the **unwrapped** line and
  resizes *both* axes (`run.rs:2280-2315`), gated on the `tm` binding
  (`run.rs:2248-2252`).
- Fixed size ✅ — `tm=fixed` is written on handle-drag, scale-drag and W/H
  field commit (`run.rs:3599`, `:3714`, `:9241`).
- **Auto height ❌** — nothing ever writes `tm=auto-height`; there is no mode
  control in the Layout section, and because auto-width measures unwrapped, a
  paragraph can never reflow at a fixed width and grow downward. This is the
  single most common text mode in real files.
- Scale tool ✅ for font size — `run.rs:1536-1550` resolves the line box
  "linear in fs for every mode → scale once".
- Creation semantics 🟡 — `Tool::Text` always creates `w.max(120.0) × 14.0`
  and enters edit (`run.rs:4094-4100`); whether the user clicked or dragged is
  not consulted, so drag-to-create does not produce a Fixed-size box (it becomes
  Fixed only after the *next* manual resize).
- Overflow 🟡 — with no truncation rendering, Fixed-size text that overflows
  simply draws outside its box (Figma clips or ellipsizes).

### 2.7 Add links to text — ❌

Figma: link a whole layer or a range (`⇧⌘U`), paste-in-place a URL, hover to
preview, click to follow (external / other file / page / frame), edit/delete
from the link modal, links work in prototypes, underlined by default, `⌘U`
toggles the underline.

X-Native: no link model at all. `TextRun` (`node.rs:807-819`) has
color/size/font/weight/italic/ls and no `href`; there is no `hyperlink` field
on `Node`; neither Figma importer reads a link (REST `hyperlink` /
`.fig` `hyperlink` are not in `figma.rs:674-767` or `figbinary.rs:313-410`); no
export emits one. The prototype system (`x-core/src/prototype.rs`,
`Interaction`) navigates between frames on node clicks, which is the substrate a
"link to frame/page" would reuse — but text-range links need a new run property
plus hit-testing that maps a click to a character offset (`p0_features.rs:37-45`
already builds caret positions, so the geometry exists).

### 2.8 Add emojis and smart symbols to text — 🟡

- Emoji **input and shaping** ✅ — grapheme-cluster editing keeps ZWJ sequences
  intact (`run.rs:1708`), fallback maps emoji without crashing, and the
  contract is pinned by a test that is explicit about the limit:
  *"Color rendering (COLR/CBDT) is a known gap; this documents the current
  contract: no panic, graceful monochrome-or-skip"*
  (`typography_fixture.rs:256-270`).
- ❌ **Color emoji do not render in color** (no COLR/CPAL or CBDT/sbix path in
  `x-text`). Figma uses the Apple emoji style.
- ❌ No `:shortcode` autocomplete (`:heart`, `:plus`), no emoji picker.
- ❌ No smart symbols: nothing converts `->`→`→`, `<-`→`←`, `vv`→`↓`, `^^`→`↑`,
  `(c)`→`©`, `(r)`→`®`, `(tm)`→`™`, `[ ]`→`▢`, and no smart quotes. There is no
  input-rewrite hook in the editor at all (`run.rs:4412-4431` inserts text
  verbatim).

### 2.9 Create bulleted and numbered lists — 🟡 phantom

Figma: bulleted/numbered from `- `/`* `/`1. `/`1) ` + space, or `⌘⇧8` / `⌘⇧7`,
or the List style property; five indentation levels with Tab/`⌘]` and
Backspace/Enter-to-outdent; counters rotate numbers → letters → roman per level;
**list spacing**; hanging lists; bullets inherit the first character's color of
their item; stroke weight and effects apply to bullets too; `⌘Z` right after a
list shortcut undoes just the styling.

X-Native: `ListStyle { None, Bulleted, Numbered }` on the node
(`node.rs:636-659`), a cycling inspector control (`editor_ui.rs:3372-3384`,
`run.rs:7653-7657`), and `.x` round-trip (`serialize.rs`, `deserialize.rs:925`).
**No renderer draws a bullet or a counter**, there is no per-paragraph/per-line
list model (Figma lists are per-paragraph with a level; ours is one flag for the
whole layer), no indent levels, no list spacing, no markdown-style auto-list on
typing, and no shortcuts.

### 2.10 Use icon fonts — 🟡 (accidental)

Figma documents installing an icon font (Font Awesome 5/6 Free/Brands) and
pasting a glyph's unicode into a text layer, switching Regular/Solid.

X-Native has no icon-font-specific support, but the generic path mostly works
because a text layer can name any loaded family (`font` binding) and
`FontManager` loads whatever the platform dirs contain (`font.rs:200-250`) —
**if** the `.otf`/`.ttf` parses. Two caveats: CFF/OTF outline fonts are not
supported by the subsetter (`docs/KNOWN_DEBT.md` §7 — TrueType `glyf` only, so
HTML export falls back to copying the whole font), and there is no glyph browser
to find a codepoint. Net: paste-a-codepoint works, discoverability does not.

### 2.11 Use OpenType features — ❌ (highest-value engine gap)

Figma exposes, per font: letterforms (`liga`, `dlig`, `calt`, `ordn`), stylistic
sets `ss01`-`ss20`, character variants `cv01`…, horizontal spacing
(kern/kerning pairs), and "more" (fractions `frac`, numerators/denominators
`numr`/`dnom`, tabular/oldstyle figures `tnum`/`onum`, slashed zero `zero`,
case-sensitive `case`), each with a hover preview and greyed-out when the font
lacks it.

X-Native: `rustybuzz::shape(&face, &[], buf)` — **the feature array is a
literal empty slice** (`shaping.rs:225`), so only rustybuzz's defaults apply.
`Span` carries `variations: Vec<(String, f32)>` (`shaping.rs:29`) but no
`features`, and `TextBlockStyle` (`shaping.rs:692-714`) has no feature field, so
there is nowhere to put them and no way to reach the shaper. Consequences:

- ❌ cannot disable ligatures (a real need for code/UI samples: `fi`, `->`),
- ❌ cannot enable `ss01`/`cv01` (Inter's alternate glyphs),
- ❌ no tabular figures — numbers in tables don't align,
- ❌ no fractions, ordinals, superscript/subscript glyphs, slashed zero.

The fix is local and cheap: add `features: Vec<(Tag, bool)>` to `Span`, thread
it through `TextBlockStyle` and the cache key (`cache.rs:47-190` — the key must
include features or cached runs will be wrong), and pass
`&rustybuzz::Feature` slice at `shaping.rs:225`.

### 2.12 Use variable fonts — 🟡

Figma: a **Variable** tab in type settings with a slider + input per axis
(including author-defined axes), hover preview, "frequently used axis settings"
in the font-style dropdown, static→variable replacement prompts, Dev Mode
output.

X-Native: the engine sets axes per span (`shaping.rs:206-215`), the inspector
has two numeric fields — Optical size (`opsz`) and Width (`wdth`) —
(`editor_ui.rs:3226-3260`, `run.rs:2446-2462`), and weight rides `fw`.
Gaps: ❌ no sliders, ❌ **no enumeration of the axes a face actually has**
(`font.rs:352` notes static faces ignore `wght`; there is no `fvar` reader, so
author axes like `GRAD`, `slnt`, `SOFT` are invisible), ❌ no `slnt`/italic-axis
field, ❌ no per-axis ranges/clamping, ❌ no Dev Mode output for axes, ❌ no
"frequently used settings".

### 2.13 Add text in Chinese, Japanese, and Korean — ✅ engine / ❌ product

- ✅ Shaping, fallback and **CJK line breaking between ideographs** are
  implemented and tested (`shaping.rs:150-160`, `typography_fixture.rs:158-166`
  asserts `中文`×30 breaks into ≥4 lines at 100 px).
- ✅ Noto CJK is force-loaded from `/usr/share/fonts/opentype/noto` even when
  the directory scan stops early (`font.rs:238-244`), matching Figma's
  "falls back to a Noto font".
- ✅ `.fig`/Sketch import handle astral/UTF-16 text correctly
  (`sketch.rs:1979`, `json.rs:141`, `:433`).
- ❌ No font picker, so the SC/TC/JP/KR shorthand naming and the "pick the
  right Noto for your language" flow Figma documents have no surface.
- ❌ **No IME / composing-text support.** The editor consumes
  `WindowEvent::KeyboardInput` + `text` directly (`run.rs:299`, `:4412-4431`);
  nothing handles `WindowEvent::Ime` (preedit/composition), so Pinyin/Kana/
  Hangul input cannot commit. For CJK *authoring* (as opposed to CJK
  *rendering*) this is the blocking gap. Figma's article is about fonts and
  keyboard layouts, but a native editor without IME cannot serve those layouts.
- ❌ No vertical writing mode (Figma doesn't have one either — recorded so the
  backlog doesn't invent a requirement).

### 2.14 Add right-to-left text — 🟡

- ✅ Rendering: BiDi paragraph analysis, visual runs, Arabic joining, per-run
  direction passed to rustybuzz (`shaping.rs:134-160`, `:218-225`), RTL fonts
  via Noto Arabic (`typography_fixture.rs:16-19`).
- ❌ **No direction override.** Figma detects the script and then offers
  explicit LTR/RTL controls per paragraph (sidebar toggle, quick actions, main
  menu). We always take `BidiInfo::new(&span.text, None)` — `None` means
  "auto-detect the paragraph level", with no way for the user to pin it. There
  is no `dir`/`rtl` binding, no UI, and no `.fig`/REST import of
  `textDirection`.
- ❌ **Editing is logical, not visual.** Arrow keys move by char index
  (`run.rs:4330-4411`); in mixed RTL/LTR text Figma moves the caret
  forward/backward *visually* per the paragraph direction. Same for
  click-to-caret and drag-selection: `p0_features.rs:37-45` maps y→line,
  x→char on the *logical* string.
- ❌ No auto-right-align for RTL content, and no RTL-aware alignment at all
  (alignment itself doesn't render — see 2.2).

---

## 3. Structural root causes

Fixing properties one at a time will not converge; four structural problems
generate most of the rows above.

### 3.1 Two models for the same property, one of them inert

Model A (`Node.text_align`, `text_align_vertical`, `text_decoration`,
`text_case`, `text_truncation`, `max_lines`, `paragraph_spacing`,
`paragraph_indent`, `hanging_punctuation`, `list_style`, `wrap_style` —
`node.rs:342-352`) was added by the Phase-6 "text formatting" commit: model +
serializer + deserializer + inspector labels + cycle actions.

Model B (the `bindings` map) is what the renderers actually read
(`ir.rs:1067-1098`, `scene.rs:370-469`).

Reference counts outside `node.rs` tell the story — every Model A field is
touched ~5 times, all of them in `editor_ui.rs` (label), `run.rs` (cycle),
`serialize.rs`, `deserialize.rs`:

```
text_align: 5   text_align_vertical: 5   text_decoration: 5   text_case: 3
text_truncation: 5   max_lines: 3   paragraph_spacing: 4   paragraph_indent: 4
hanging_punctuation: 4   list_style: 5   wrap_style: 5      text_runs: 104
```

Zero of those references are in `x-render` or `x-text`. **Model A is a
write-only store.** Any implementation must pick one model and delete the
other's UI/format surface, or every new property inherits the split.

### 3.2 The IR cannot express what the shaper can

`RenderCommand::Glyphs` (`ir.rs:44-66`) carries text, size, brush, max_width,
font, letter/word/paragraph spacing, line-height mode+value, wrap, baseline
shift, small caps, opsz, wdth, runs. It has **no align, no decoration, no list
state, no truncation, no indent** — so even a correctly-modelled property has
no way to reach `sinks.rs`/`raster.rs`/`text_geometry.rs`. `scene.rs` bypasses
the IR and calls `x_text` directly, and hardcodes `align: Align::Left`
(`scene.rs:445`). Alignment therefore needs: an `align` field on the IR command,
a `Justify` variant on `x_text::Align` (`shaping.rs:662-666`) with word-spacing
distribution in `layout_lines`, and the node→command plumbing.

### 3.3 OpenType features have no channel

`rustybuzz::shape(&face, &[], buf)` (`shaping.rs:225`) + a `Span` with no
feature field + a cache key that doesn't include features (`cache.rs:47-190`).
Three small changes unlock Figma's entire *Details* tab.

### 3.4 Styles and variables are unreachable from the product

- The complete style module (`styles.rs`, 446 lines) has no caller; the
  deprecated one (`document.rs`) drops half its payload and writes a field the
  renderer ignores.
- `Node::bind`/`bound_number` document `"fontsize"` as a bindable property
  (`node.rs:1384-1396`) and there is a test asserting
  `bound_number("fontsize", …)` resolves (`x-render/tests_mod.rs:597`) — but the
  renderers only ever resolve `"radius"` (`ir.rs:981`) and
  `"opacity"`/`"radius"` (`scene.rs:255`, `:279`). **A test passes for a
  behaviour no product path performs.**
- The only variable-binding UI is a context menu
  (`context_menu.rs:137`, `:795-805`: `BindVariable` / `UnbindVariable` /
  `GoToVariable`) whose `click()` result is consumed **only by its own unit
  tests** (`context_menu.rs:1326`, `:1336`) — no dispatcher in `run.rs`. This is
  the same dead-surface pattern `docs/KNOWN_DEBT.md:21` already records for
  `render_context_menu()`.

---

## 4. Prioritized backlog

Ordered by (user-visible impact) ÷ (distance from working code). P0 is what this
branch implements.

### P0 — Text styles & variables *(requested priority)*

**P0.1 One style system, wired end to end.**
Complete `TextStyleData` to Figma's table (§2.5): family, weight, italic, size,
line-height **mode+value**, letter spacing, paragraph spacing, paragraph indent,
decoration, case, list style, wrap style, hanging punctuation, OpenType features.
Add `TextStyleData::from_node(&Node)` and `apply_to_node(&mut Node)` that write
**Model B** (the bindings the renderers read) plus the Model-A fields, so a style
application is visible immediately. Give `Document` a `text_styles: StyleLibrary`
(with deterministic serialization), and editor ops: create-from-selection, apply,
detach, edit-style→resolve-all-consumers, rename, delete, usage counts. Deprecate
`LegacyStyle::Text` by making it delegate (or fix its applier to write
`ls`/`lhm`/`lhpx`/`fs` and stop writing `n.h`).
*Acceptance:* create a style from a layer → apply to another → both render
identically; edit the style → every consumer re-renders; `.x` round-trip is
byte-stable; a Figma-imported file keeps nothing silently.
*Files:* `x-core/src/styles.rs`, `document.rs`, `x-format/src/{serialize,
deserialize}.rs`, `x-editor/src/`, `apps/.../{editor_ui,run,state}.rs`.

*Implemented on this branch.* `TextStyleData` (`styles.rs:216`) now carries
Figma's whole *included* set — family, weight, size, line-height **mode +
value**, letter spacing, paragraph spacing, paragraph indent, case, synthesized
small caps, decoration, list style, wrap, wrap style, hanging punctuation — and
`from_node` / `apply_to_node` / `clear_from_node` (`:273`, `:309`, `:350`) move
it through **Model B**, the bindings every renderer reads
(`TEXT_STYLE_BINDINGS`, `:266`). The registry is `Document.styles` behind a
typed façade (`document.rs:314-383`: `text_style_names`, `text_style`,
`add_text_style`, `update_text_style`, `remove_text_style`,
`text_style_usage`) plus `detach_text_style` (`:74`), and
`LegacyStyle::Text`'s applier writes the px contract instead of stuffing the
size into `n.h` (`:160`). `.x` carries the full set
(`serialize.rs:1211` `text_style_json` ⇄ `deserialize.rs:1203`
`parse_text_style`, including the back-compat bare `lh` and `"Inter 700"`
family/weight splits). Tests: `document.rs:405` (bindings renderers read),
`:431` (detach keeps type, drops link), `:472` (update propagates to every
consumer), `:581` (rename / detach / usage), plus the format round-trip.
*Still open:* italic-as-an-axis and OpenType feature toggles are not in the
style payload (Figma includes the latter); `Document.styles` mutations are not
on any undo stack — see the debt note under P0.2.

**P0.2 Typography style picker in the inspector.**
Make the dead icons at `editor_ui.rs:3037-3051` real: a style row showing the
applied style name (or "Mixed"/none), a dropdown listing text styles with
create/apply/detach, and hit registration. Reuse the existing dropdown pattern
(`Action::LhDropdown`, `editor_ui.rs:4519`).

*Implemented on this branch.* The two icons own hit rects and hover tint now
(`editor_ui.rs:3040-3051`): the styles button toggles `Action::TextStyleDropdown`,
the plus fires `Action::CreateTextStyle`. `paint_text_style_dropdown`
(`:4568`) lists every style in the document, highlights the one the selection
carries, and appends the rows that act on the current selection — *Update
'\<name\>' from selection* and *Detach style* when it is linked, *Create text
style* when it is a text layer, *No text styles yet* when the registry is
empty. The four operations live on `App` next to the other typography mutators
(`run.rs:2552` apply, `:2583` create, `:2610` detach, `:2633` update, `:2652`
propagate-across-pages), are dispatched at `run.rs:7893-7928`, and report
through `app.status`; the menu closes on outside click and `Escape` with the
other dropdowns, and the two typography menus are mutually exclusive.
End-to-end test:
`regression_tests.rs:1923` `text_styles_create_apply_update_and_detach_end_to_end`
(create → apply to a second layer → local edit + update propagates → detach
keeps values and stops propagating → non-text selections refuse all four).

*Two debts, recorded rather than hidden.* (1) **Undo:** consumers are mutated
through `Editor::mutate_visual_stack`, so an apply/detach/update is undoable
per node, but the *definition* change in `Document.styles` is not on any undo
stack — undoing "Update style" restores the consumers' old values while the
style still holds the new ones. Fixing this properly means either putting the
registry inside `Command` or snapshotting it in the same step. (2) **Anchor
bug found while cloning the pattern:** `paint_lh_dropdown` anchored on
`ED_TITLE_H` instead of the panel's `y_entry` (`ED_TITLE_H + 89`, the chrome
sum `paint_frame_dropdown` builds), floating that menu 89px above the
Line-height field. Fixed at `editor_ui.rs:4522-4529`; `paint_frame_dropdown`
still ignores `scroll_right` and drifts when the panel is scrolled (left alone
— it needs a visual check, not a guess).

**P0.3 Variable-bound typography that actually resolves.**
Resolve number variables for `fontsize`, `lineheight`, `letterspacing`,
`paragraphspacing` in both render paths (`ir.rs:1067-1098`,
`scene.rs:370-424`) via the existing `bound_number` helper, and make the
inspector able to *create* the binding (the panel fields accept a variable
reference; the dead `BindVariable` context action gets a dispatcher or is
removed). Modes must stay respected (a variable supplies the value, `lhm`
supplies the unit).
*Acceptance:* bind font size to `type/scale/body`, switch variable mode, text
re-renders; `x-render/tests_mod.rs:597` stops being a lie.

*Implemented on this branch (renderer half).* Both render paths resolve the
typography tokens ahead of the literals, mirroring the `w`/`h`/`radius`
pattern: `fontsize` and `letterspacing` through `Node::bound_number`
(`ir.rs:1076`, `:1085`, `scene.rs:372`), `lineheight` through the token →
`(lhm, value)` pair so the **mode** still comes from `lhm` and the variable
only supplies the number. A missing token falls back to the literal, so
unbound documents are bit-identical. `build_rich_spans_px` takes the variable
map (`scene.rs:738`) and the shaped spans carry the resolved values. Tests:
`x-render/src/tests_mod.rs:606` `typography_tokens_reach_the_render_tree`,
`:663` `letterspacing_token_reaches_the_shaped_spans`.
*Still open:* the inspector cannot yet *create* those bindings — the dead
`BindVariable` / `UnbindVariable` context actions (§3) still have no
dispatcher, so a variable-bound font size is reachable only from a file or a
test. `paragraphspacing` is not resolved at render time either (P1.2 owns
paragraph spacing in the layout pass).

**P0.4 Horizontal alignment renders.**
Add `align` to `RenderCommand::Glyphs`, stop hardcoding `Align::Left`
(`scene.rs:445`), read it from Model B (new `ta` binding) with Model A as the
fallback, add `Align::Justify` + word-spacing distribution in `layout_lines`,
and emit `text-align` in Dev Mode CSS. Delete the decorative 6-button row or
make it the real control.

### P1 — Make the phantom controls real

| # | Item | Where |
| --- | --- | --- |
| P1.1 | Underline / strikethrough (per-run, with thickness/offset/color; skip-ink is a stretch) | `x-text` outline pass + `ir.rs` `Glyphs` |
| P1.2 | Lists: per-paragraph level + marker, numbered counter rotation (1 → a → i), list spacing, hanging lists, marker color inheritance | `x-text/src/shaping.rs` line loop, new paragraph model |
| P1.3 | Truncation + max lines with ellipsis (End and Middle), honoring `tm=fixed` | `x-text` layout + `ir.rs` |
| P1.4 | Vertical alignment (Fixed-size boxes only, per Figma) | `scene.rs`/`ir.rs` text origin |
| P1.5 | Paragraph indent + hanging quotes | `x-text` line positioning |
| P1.6 | Vertical trim (cap-height bounding box) + `leading-trim` in Dev Mode | `node.rs` metrics, `x-text` |
| P1.7 | Collapse Model A / Model B into one representation; delete `WrapStyle{Normal,BreakWord}` or rename it, and expose Figma's `TextWrap` (Auto/Balance/Pretty) in the panel | repo-wide |
| P1.8 | Auto-height resizing mode + a Layout-section mode switcher; click-vs-drag creation semantics | `run.rs:2220-2318`, `:4094-4110` |

### P2 — Fonts and OpenType

| # | Item |
| --- | --- |
| P2.1 | Font picker: search + filters (All / In this file / Installed / Google / Variable), hover-preview, backed by the already-written `SystemFonts::family_names` + `GoogleFonts::{catalog,search,fetch,install_family}` |
| P2.2 | Real missing-font detection replacing the mock notification (`state.rs:808-815`), with a substitution dialog |
| P2.3 | OpenType features channel: `Span.features` → `rustybuzz::Feature` slice (`shaping.rs:225`) + cache key (`cache.rs`), then a Details panel (letterforms, `ss##`, `cv##`, figures, fractions, slashed zero) with hover previews |
| P2.4 | Variable-font axis enumeration from `fvar` → sliders for every axis the face has (incl. author axes), axis ranges, Dev Mode output |
| P2.5 | Numbers: per-range superscript/subscript with faux-synthesis fallback, tabular/oldstyle figures, fractions |
| P2.6 | CFF/OTF subsetting (`docs/KNOWN_DEBT.md` §7) so icon fonts and OTF families export properly |

### P3 — Content, i18n, editing

| # | Item |
| --- | --- |
| P3.1 | Links on text ranges: `TextRun.href`, `⇧⌘U` input, hover preview, click-to-follow (reuse `Interaction` for frame/page targets), prototype playback, export to HTML/SVG |
| P3.2 | RTL/bidi direction override per paragraph + visual caret navigation and click-to-caret in mixed text |
| P3.3 | IME (preedit/composition) for CJK input |
| P3.4 | Smart symbols + smart quotes on input (`->`→`→`, `(c)`→`©`, …) behind a preference |
| P3.5 | Emoji shortcodes (`:heart`) and color emoji (COLR/CPAL, then CBDT/sbix) |
| P3.6 | Multi-edit text; click-another-layer-to-edit while in edit mode |
| P3.7 | Text on a path (+ flip orientation) |
| P3.8 | Stroke on text (outline glyphs) |
| P3.9 | Spellcheck |
| P3.10 | Per-paragraph properties (wrap style, alignment, indent, list level) instead of per-layer only |
| P3.11 | Figma `textStyleId` / `hyperlink` / `textAutoResize` / `textTruncation` / `maxLines` / `paragraphSpacing` / `paragraphIndent` / `listSpacing` / `opentypeFlags` in both importers and the REST/`.fig` exporters (today the exporter writes only family/size/lineHeightPx/letterSpacing + runs — `figma.rs:279`) |

---

## 5. Verification gaps

The suite is strong where it was aimed and silent everywhere above:

- ✅ `typography_fixture.rs` — five stages (shape every script → measure → wrap
  → resize/save/reload/render → emoji honesty), with environment-aware
  assertions (`covered()` skips script assertions when the font isn't installed).
- ✅ `text_export_parity.rs` — canvas/SVG/PDF share glyph geometry; ligature and
  kerning contracts survive export.
- ❌ **No test renders a property from Model A.** Nothing asserts that
  `text_align = Center`, `text_decoration = Underline`, `list_style = Bulleted`
  or `text_truncation = End` changes a single glyph position — which is why ten
  phantom controls shipped without a red build.
- ❌ No test for text styles (there is nothing to test — `styles.rs` has no
  `#[cfg(test)]` module).
- ❌ `x-render/tests_mod.rs:594-597` asserts `bound_number` resolves
  radius/opacity/fontsize on a **bare node**, which passes while no renderer
  calls it for font size. A parity test must go through `build_render_tree`.
- Recommended invariant to add with P0: for every inspector control, a test that
  flips it and asserts the render tree / scene changed. That single test shape
  would have caught this entire class.

---

## References

- [Guide to text in Figma Design](https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design)
- [Explore text properties](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties)
- [Add a font to Figma](https://help.figma.com/hc/en-us/articles/360039956894-Add-a-font-to-Figma)
- [Browse and apply fonts](https://help.figma.com/hc/en-us/articles/360041308034-Browse-and-apply-fonts)
- [Create and apply text styles](https://help.figma.com/hc/en-us/articles/360039957034-Create-and-apply-text-styles)
- [Adjust text dimensions and resizing](https://help.figma.com/hc/en-us/articles/27378154668951-Adjust-text-dimensions-and-resizing)
- [Add links to text](https://help.figma.com/hc/en-us/articles/360045942953-Add-links-to-text)
- [Add emojis and smart symbols to text](https://help.figma.com/hc/en-us/articles/360039957174-Add-emojis-and-smart-symbols-to-text)
- [Create bulleted and numbered lists](https://help.figma.com/hc/en-us/articles/360040449773-Create-bulleted-and-numbered-lists)
- [Use icon fonts](https://help.figma.com/hc/en-us/articles/360040449513-Use-icon-fonts)
- [Use OpenType features](https://help.figma.com/hc/en-us/articles/4913951097367-Use-OpenType-features)
- [Use variable fonts](https://help.figma.com/hc/en-us/articles/5579502031511-Use-variable-fonts)
- [Add text in Chinese, Japanese, and Korean](https://help.figma.com/hc/en-us/articles/360040449673-Add-text-in-Chinese-Japanese-and-Korean)
- [Add right-to-left text](https://help.figma.com/hc/en-us/articles/4972283635863-Add-right-to-left-text)

Internal: `X-Native/TEXT_FORMATTING_IMPLEMENTATION.md` (model-layer changelog,
overstated), `X-Native/docs/KNOWN_DEBT.md` §7 (subsetting) and rows 21/25 (dead
context-menu paint half, dead `Action` variants),
`X-Native/docs/UI_CAPABILITY_MAP.md:43`.
