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

## Testing Recommendations

When testing these features:

1. **Round-trip serialization**: Create a node with text properties, serialize to `.x` format, deserialize, and verify all properties match
2. **Default values**: Verify old files without text properties load with correct defaults
3. **Non-default values**: Test each enum variant serializes/deserializes correctly
4. **Edge cases**: Test `max_lines: None` vs `max_lines: Some(0)` vs `max_lines: Some(100)`
5. **Combination**: Test multiple properties set simultaneously (e.g., centered + underlined + uppercase text)

## Future Enhancements

Potential future additions based on Figma's full typography system:

1. **Line height modes**: Auto, exact pixels, percentage of font size
2. **Letter spacing**: Per-character spacing adjustment
3. **Text indent styles**: Hanging indent, first-line only, all lines
4. **Paragraph styles**: Named reusable paragraph formatting
5. **Text styles**: Named reusable text formatting (already partially implemented)
6. **OpenType features**: Ligatures, small caps, stylistic sets
7. **Variable font axes**: Weight, width, slant interpolation
8. **Text on path**: Curved text following a path
9. **Vertical text**: Writing modes for CJK languages
10. **Bidirectional text**: Mixed RTL/LTR text support

## References

- [Figma Design Documentation](https://help.figma.com/hc/en-us/categories/360002042553-Figma-Design)
- [Explore text properties](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties)
- [Guide to text in Figma Design](https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design)
- [Create bulleted and numbered lists](https://help.figma.com/hc/en-us/articles/360040449773-Create-bulleted-and-numbered-lists)

## Commit Information

- **Commit**: `55b8329`
- **Branch**: `arena/01a0a0a5-x-native`
- **Date**: 2026-09-15
- **Files changed**: 3
  - `crates/x-core/src/node.rs` (enum definitions, Node fields)
  - `crates/x-format/src/serialize.rs` (serialization logic)
  - `crates/x-format/src/deserialize.rs` (deserialization logic)
