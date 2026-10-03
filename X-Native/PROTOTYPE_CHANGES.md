# Prototype System Improvements

## Summary of Changes

We've significantly enhanced the prototype system with Figma-like features for creating interactive prototypes.

## New Features

### 1. Animation Type Selection (✓ Complete)
- Added `ProtoAnimation` action to cycle through animation types
- Supports: Instant, Dissolve, Smart Animate, Slide In/Out, Move In/Out (with direction)
- UI chip shows current animation type and allows cycling

### 2. Action Type Selection (✓ Complete)
- Added `ProtoActionType` action to cycle through action types
- Supports: Navigate, Open Overlay, Swap Overlay, Close Overlay, Back, Set Variable, Set Mode, Conditional
- UI chip shows current action type and allows cycling
- Overlay actions automatically cycle through positions (Center, Top Right, Bottom Right, Top Left, Bottom Left)

### 3. Trigger-Specific Fields (✓ Complete)
- **AfterDelay**: Shows editable delay field (cycles: 0ms → 100ms → 300ms → 500ms → 1000ms → 2000ms)
- **KeyDown**: Shows editable key field (cycles: Enter → Space → Escape → Arrow keys → 'a')
- These fields appear inline when the trigger type requires them

### 4. Open Link Action with URL Editing (✓ Complete)
- When action type is OpenLink, shows URL field
- Cycles through example URLs (https://example.com, https://figma.com, https://github.com)
- Full row expands to show URL when present
- URL is truncated in UI if too long (>30 chars)

### 5. Dynamic Row Heights (✓ Complete)
- Interaction rows automatically adjust height based on content
- Standard rows: 56px (trigger + action type + destination + animation + speed + remove)
- URL rows: 92px (adds URL field row)
- Trigger-specific fields (delay/key) share first row with trigger

## UI Layout

Each interaction row now has:

**Row 1 (y+4):**
- Trigger chip (left)
- Trigger-specific field (delay/key) OR action type chip (middle)
- Destination chip (right, only for Navigate/Overlay)

**Row 1.5 (y+50, only for OpenLink):**
- URL field (full width)

**Row 2 (y+26 or y+72 depending on URL):**
- Animation chip (left)
- Speed chip (middle)
- Remove button (right)

## Code Changes

### state.rs
- Added `ProtoAnimation(usize)` action
- Added `ProtoActionType(usize)` action
- Added `ProtoEditDelay(usize)` action
- Added `ProtoEditKey(usize)` action
- Added `ProtoEditUrl(usize)` action

### run.rs
- Added `proto_animation_cycle()` - cycles through all animation types
- Added `proto_action_type_cycle()` - cycles through all action types
- Added `proto_edit_delay()` - cycles through delay values
- Added `proto_edit_key()` - cycles through key values
- Added `proto_edit_url()` - cycles through example URLs

### editor_ui.rs
- Enhanced `paint_prototype()` to show trigger-specific fields
- Added dynamic row height calculation
- Added URL field rendering for OpenLink actions
- Adjusted all element positions to account for dynamic heights

## What's Next (Not Yet Implemented)

### High Priority
1. **Multiple Actions Per Trigger** - Allow adding multiple actions to a single trigger
2. **Custom Delay Input** - Allow typing custom delay values instead of cycling
3. **Custom Key Binding** - Allow typing any key instead of cycling
4. **Custom URL Input** - Allow typing any URL instead of cycling

### Medium Priority
5. **Easing Curves** - Add easing options (ease-in, ease-out, ease-in-out, custom bezier)
6. **Scroll To Action** - Allow scrolling to specific elements within a frame
7. **Set Variable Action UI** - Full UI for setting variables with expression editor
8. **Conditional Logic UI** - Visual editor for if/else conditions

### Low Priority
9. **Smart Animate Layer Matching** - Match layers by name for smooth transitions
10. **Video Triggers** - When video ends / when video hits specific time
11. **Gamepad Support** - Map gamepad buttons to prototype actions
12. **State Management** - Reset object properties when navigating

## Testing Recommendations

1. Test animation cycling through all types
2. Test action type cycling and verify destination chips appear/disappear correctly
3. Test AfterDelay trigger with different delay values
4. Test KeyDown trigger with different keys
5. Test OpenLink action with URL editing
6. Test dynamic row heights with and without URL fields
7. Test that all existing interactions still work (Navigate, Overlay, etc.)
