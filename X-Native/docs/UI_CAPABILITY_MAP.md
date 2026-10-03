# X-Native UI capability map

The interface uses progressive disclosure instead of placing every engine action in the primary toolbar.

## Primary toolbar

- Select / Move
- Frame
- Section
- Rectangle and the Shape menu
- Ellipse
- Pen and Line
- Text
- Image placement
- Hand / Pan

The Shape menu and command palette expose Polygon, Star, Triangle, Line, and Slice without permanently crowding the canvas.

Toolbar artwork is rendered from native vector paths. It does not depend on emoji or platform-specific symbol glyphs.

## Viewport zoom

- Supported zoom range: 5% to 1600%
- Normal zoom: no decorative box grid
- 800% and above: a pixel grid appears
- Each grid cell represents exactly one document pixel and scales with zoom

## Left workspace

- Pages and nested layers
- Layer search and reordering surface
- Assets and image resources
- Components and instances
- Variables, modes, and libraries
- Plugin entry point

## Contextual inspector

- Align and distribute
- Position, dimensions, transform, rotation, flip, and constraints
- Auto Layout and grid layout
- Multiple fills, strokes, effects, radius, opacity, and blend
- Typography and rich-text runs for text selections
- Image crop, fit, fill, and tile for image selections
- Component properties, overrides, variants, and detach
- Export settings and multi-scale exports

## Modes

- Design: visual properties and layout
- Prototype: interactions, flows, transitions, presentation
- Code: CSS, XML, Swift, Compose, tokens, measurements, and assets

## Important status distinction

The engine already contains these capabilities, but this design pass exposes their intended UI locations. Items are not considered fully shipped until each visible control is bound to the corresponding editor API and passes interaction tests.
