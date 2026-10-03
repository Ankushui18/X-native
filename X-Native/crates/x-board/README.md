# X-Native Board Module

Infinite canvas brainstorming and UX mapping capabilities for X-Native.

## Overview

Board is a **separate document type** from Design files, similar to how Figma and FigJam are two separate products sharing one platform.

### Key Differences from Design Files

| Feature | Design Files | Board Files |
|---------|-------------|-------------|
| Canvas | Fixed artboards | Infinite canvas |
| Layout | Auto Layout engine | Freeform positioning |
| Components | Full component system | Simple reusable stickies |
| Variables | Yes | No |
| Code Export | CSS, SwiftUI, Compose, JSX | N/A |
| Connectors | No | Yes (arrows, relationships) |
| Sticky Notes | No | Yes |
| Primary Use | UI/UX Design | Brainstorming, Mapping, Wireframing |

## Board Node Types

- **Sticky Notes**: Colored text cards for ideas and comments
- **Connectors**: Lines/arrows that stay attached when objects move
- **Simple Shapes**: Rectangle, circle, triangle, diamond
- **Pen Paths**: Freeform drawings
- **Text Labels**: Simple text annotations
- **Images**: Asset references

## Tools

- `V` - Select tool
- `S` - Sticky Note
- `C` - Connector/Arrow
- `P` - Pen (freeform drawing)
- `R` - Rectangle
- `O` - Circle
- `T` - Text Label
- `H` - Hand (pan)
- `Z` - Zoom

## Usage Example

```rust
use x_board::{BoardDocument, BoardKind, StickyNote, BoardShape};

// Create a new brainstorm board
let mut board = BoardDocument::new("Project Brainstorm", BoardKind::Brainstorm);

// Add a sticky note
let sticky = StickyNote::new("User login flow", 100.0, 100.0);
board.current_page_mut().nodes.push(BoardNode::Sticky(sticky));

// Add a connector between nodes
let connector = Connector::new(
    AttachmentPoint::NodeCenter(node1_id),
    AttachmentPoint::NodeCenter(node2_id),
    ConnectorType::Arrow,
);
board.current_page_mut().connectors.push(connector);
```

## File Format

Board files use `.xboard` extension and serialize to JSON:

```json
{
  "metadata": { ... },
  "pages": [...],
  "kind": "Brainstorm",
  "settings": {
    "infinite_canvas": true,
    "show_grid": true,
    "grid_size": 20.0
  },
  "sticky_styles": [...]
}
```

## Architecture

The Board module reuses X-Native's existing rendering engine (`x-render`) and core types (`x-core`) but maintains a separate, lighter-weight document model optimized for freeform work.

### Dependencies

- `x-core`: Shared types (NodeId, Transform, Color)
- `x-render`: Rendering primitives
- `x-editor`: Editor integration (future)
- `serde`: Serialization
- `glam`: Vector math
- `lru`: Caching
- `rayon`: Parallel processing

## Future Enhancements

- Real-time collaboration (CRDT-based)
- Presentation mode
- Export to PNG/PDF
- Template library
- Advanced diagramming shapes
- Mind map auto-layout
