# Text Formatting Properties Implementation

## Overview

This implementation adds comprehensive text formatting properties to X-Native, matching Figma Design's typography capabilities. All properties are fully serializable in the `.x` format and backward compatible with existing files.

## Implemented Features

### 1. Text Alignment

#### Horizontal Alignment (`TextAlign`)
- `Left` (default) - Text aligns to the left edge
- `Center` - Text is centered horizontally
- `Right` - Text aligns to the right edge
- `Justified` - Text is justified (stretches to fill width)

#### Vertical Alignment (`TextAlignVertical`)
- `Top` (default) - Text aligns to the top
- `Middle` - Text is vertically centered
- `Bottom` - Text aligns to the bottom

### 2. Text Decoration (`TextDecoration`)
- `None` (default) - No decoration
- `Underline` - Underline text
- `Strikethrough` - Strikethrough text

### 3. Text Case Transformation (`TextCase`)
- `Original` (default) - No transformation
- `Upper` - Convert to UPPERCASE
- `Lower` - Convert to lowercase
- `Title` - Convert to Title Case

### 4. Text Truncation (`TextTruncation`)
- `Disabled` (default) - No truncation
- `End` - Truncate with ellipsis at the end (e.g., "Long text...")
- `Middle` - Truncate in the middle (e.g., "Long...text")

#### Max Lines
- Optional `usize` field to limit the number of visible lines
- Works with text truncation to control overflow behavior

### 5. Paragraph Formatting

#### Paragraph Spacing
- `f64` value in pixels
- Adds space between paragraphs

#### Paragraph Indent
- `f64` value in pixels
- First-line indent for paragraphs

### 6. Hanging Punctuation (`HangingPunctuation`)
- `quotes: bool` - Allow quotation marks to hang outside the text box
- `lists: bool` - Allow list markers to hang outside the text box

### 7. List Styles (`ListStyle`)
- `None` (default) - No list formatting
- `Bulleted` - Bulleted list (unordered)
- `Numbered` - Numbered list (ordered)

### 8. Wrap Style (`WrapStyle`)
- `Normal` (default) - Standard word wrapping
- `BreakWord` - Break words at any character if needed

## Data Model Changes

### New Enums Added to `crates/x-core/src/node.rs`

```rust
pub enum TextAlign { Left, Center, Right, Justified }
pub enum TextAlignVertical { Top, Middle, Bottom }
pub enum TextDecoration { None, Underline, Strikethrough }
pub enum TextCase { Original, Upper, Lower, Title }
pub enum TextTruncation { Disabled, End, Middle }
pub enum ListStyle { None, Bulleted, Numbered }
pub enum WrapStyle { Normal, BreakWord }
pub struct HangingPunctuation { quotes: bool, lists: bool }
```

### New Node Fields

All text formatting properties are added as fields to the `Node` struct:
- `text_align: TextAlign`
- `text_align_vertical: TextAlignVertical`
- `text_decoration: TextDecoration`
- `text_case: TextCase`
- `text_truncation: TextTruncation`
- `max_lines: Option<usize>`
- `paragraph_spacing: f64`
- `paragraph_indent: f64`
- `hanging_punctuation: HangingPunctuation`
- `list_style: ListStyle`
- `wrap_style: WrapStyle`

## Serialization Format

### JSON Keys (in `.x` format)

All properties use snake_case keys and only serialize when non-default:

```json
{
  "text_align": "center",
  "text_align_vertical": "middle",
  "text_decoration": "underline",
  "text_case": "upper",
  "text_truncation": "end",
  "max_lines": 3,
  "paragraph_spacing": 8.0,
  "paragraph_indent": 16.0,
  "hanging_punctuation": {
    "quotes": true,
    "lists": true
  },
  "list_style": "bulleted",
  "wrap_style": "break-word"
}
```

### Backward Compatibility

- All new fields are optional in the JSON format
- Missing fields default to their default values (Left, Top, None, Original, etc.)
- Old `.x` files without these fields will load correctly with default values

## Implementation Details

### Serialization (`crates/x-format/src/serialize.rs`)

- Added serialization logic in `node_json()` function
- Only writes non-default values to keep files compact
- Uses `to_str()` methods on enums for consistent string representation

### Deserialization (`crates/x-format/src/deserialize.rs`)

- Added deserialization logic in `parse_node()` function
- Uses `parse()` methods on enums with fallback to defaults
- Handles missing fields gracefully (forward compatibility)

### Node Structure (`crates/x-core/src/node.rs`)

- Added all enums with `Default`, `Debug`, `Clone`, `Copy`, `PartialEq`, `Eq` derives
- Added `to_str()` and `parse()` methods for serialization
- Updated `Node` struct with new fields
- Updated `shallow_clone()` to copy new fields
- Updated default initialization in `Node::frame()` constructor

## Wiring — one source of truth for canvas and exports

The typed fields above are CANONICAL. Every consumer resolves them through
the getters in `crates/x-core/src/node.rs` (`resolved_text_align()`,
`resolved_text_decoration()`, `resolved_truncation()`,
`resolved_paragraph_indent()`, `resolved_small_caps()`,
`text_wrap_mode()`, `text_needs_styled()` …). Legacy documents that still
carry typography as `bindings` (`fs`/`ls`/`lh`/`ps`/`bs`/`tc`/`tw`/`twm`/
`pi`/…) keep resolving through the same getters, so no file rewrites are
required; new edits mirror onto the typed field *and* the binding.

`crates/x-render/src/ir.rs` owns the mapping from node to shaper:

- `align_bits_of` / `align_of` / `align_from_bits` — horizontal placement
  (0 left / 1 center / 2 right / 3 justify).
- `decoration_bits_of` — 0 none / 1 underline / 2 strikethrough
  (drawn by shaping as synthesized rects; `LoadedFont` has no underline
  metrics, so thickness = `size * 0.06`).
- `text_layout_of` — the `x_text::TextLayout` bundle: paragraph indent,
  list bits, hanging quotes/lists, `max_lines` + truncation mode,
  `word_break`, `vertical_trim`, and the fixed-box vertical alignment
  (`align_v`/`box_h`). Truncation clips only when a line cap exists,
  matching Figma's behavior.
- `text_spec` — builds the `x_text::NodeTextSpec` shared by every sink.

`RenderCommand::Glyphs` carries `align`, `decoration` and `layout`, and all
of them are part of the frame/glyph cache keys (`{align}{decoration}{layout
.fingerprint()}` in `ir.rs`, `TextLayoutKey::align/decoration/layout` in
`x-text`), so changing any paragraph property busts the cache exactly.
`x_text::glyph_outlines` (fed by `TextLayout`) is the single geometry
authority — the canvas (`scene.rs`), the PDF sink, the raster exporter, the
text-metrics helper and the SVG outliner all go through it.

HTML export (`x-native/src/html_export.rs`) and the Code panel
(`x-editor/src/devmode.rs`) emit the same model as CSS: `text-align
(+text-align-last for justify)`, `text-decoration`, `text-transform`,
`font-variant-caps`, `margin-bottom` (paragraph spacing), `text-indent`,
`list-style`, `overflow-wrap`, `text-wrap` (balance/pretty),
`-webkit-line-clamp` + `text-overflow` for truncation, and
`hanging-punctuation`.

### Placement contract (`glyph_outlines`)

The paragraph pass in `layout_lines_wrapped_styled` reserves lead width
(indent + non-hanging marker) inside `line.width`; the placement pass
applies the SAME lead exactly once — pen start `body_lead`, width
`line.width - body_lead` — so center/right/justify align inside the
indented box and never double-count. Justify stretches the line's SPACE
advances (never break-opportunity counts, which include CJK/hyphen
positions with no stretchable glyph), adding the slack once at the glyph
level and once consistently at the pen level. `decoration` is a bit mask
(1 underline, 2 strike, 3 both). `overflow_hidden` without a `max_lines`
cap drops WHOLE lines whose box top starts past `box_h` and clamps the
returned height to it; with a cap the wrap pass already trimmed the lines.
Auto-fit text is structurally unaffected (box == ink box).

## Still not implemented (Figma parity gaps)

- Underline sub-settings: style (solid/wavy/dotted), thickness, offset,
  skip-ink, per-decoration color. Only the synthesized solid rule exists.
- Small caps remains a shaping MODE reachable through the `tc`/`sc`
  bindings; there is no dedicated typed field yet (the inspector writes
  `"tc": "sc"`).
- Numbered-list formatting options (number style/position) always use the
  default `1.` marker at the hanging indent.
- Vertical alignment is expressed inside the fixed layer box; the engine
  has no explicit auto-width/auto-height resize mode, so for auto-fit text
  the shift is structurally a no-op (box == ink box).
- Rich runs accept size/color/font/weight/italic/ls only; per-run case,
  decoration and lists stay node-level.

## Testing

- `crates/x-core/src/node.rs` — typed fields, legacy-binding fallbacks,
  enum `to_str`/`parse`, clone fidelity.
- `crates/x-text/src/shaping.rs` — vertical-align shift, paragraph indent,
  decoration ink, list/hanging geometry, layout-in-cache-key.
- `crates/x-render/src/ir.rs` — properties flow through `Glyphs`;
  `text_spec` mirrors the command fields.
- `crates/x-editor/src/tests_mod.rs` — Code-panel CSS mirrors the model.
- `crates/x-format/tests/text_props.rs` — full round trip + byte-stability
  for plain nodes.

## References

- [Figma Design Documentation](https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design)
- [Explore text properties](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties)
- [Guide to text in Figma Design](https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design)
- [Create bulleted and numbered lists](https://help.figma.com/hc/en-us/articles/360040449773-Create-bulleted-and-numbered-lists)
- [Adjust text dimensions and resizing](https://help.figma.com/hc/en-us/articles/27378154668951-Adjust-text-dimensions-and-resizing)

## Commit Information

- **Branch**: `arena/01a0a37b-x-native`
- **Date**: 2026-09-15
- **Files changed** (wiring pass): `x-core/node.rs`, `x-text/shaping.rs`,
  `x-text/cache.rs`, `x-render/ir.rs`, `x-render/scene.rs`,
  `x-render/sinks.rs`, `x-render/raster.rs`, `x-render/text_geometry.rs`,
  `x-format/serialize.rs`, `x-format/deserialize.rs`,
  `x-native/html_export.rs`, `x-native/lib.rs`, `x-editor/devmode.rs`,
  `apps/x-designer` (inspector + field routing)
