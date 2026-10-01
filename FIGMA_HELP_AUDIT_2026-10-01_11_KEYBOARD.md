# Figma Help parity audit — Use Figma products with a keyboard

**Date:** 2026-10-01
**Reference:** [Use Figma products with a keyboard](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)

## Scope

Audited only keyboard behavior that already has an X-Native counterpart: canvas navigation shortcuts and the existing keyboard-shortcuts panel. Keyboard-only object creation, keyboard box selection, screen-reader settings, and new keyboard-layout preferences were not added or expanded.

## Reference behavior

- With nothing selected, arrow keys pan the canvas; Shift increases the pan distance. Command/Ctrl with `+` or `-` zooms.
- The shortcuts panel can be opened from Help and resources, Actions, or Control+Shift+?. It is docked along the bottom, has category tabs, marks shortcuts already used, and stays open while the user continues working. The Layout tab manages keyboard-layout preferences.

## X-Native comparison

- The existing Help button and Control+Shift+? open the shortcut list. It has category tabs and a search field, and highlights a subset of shortcuts recorded during the current panel session. Command/Ctrl `+` and `-` zoom the canvas.
- Before this audit, the shortcut list was centered over a dimmed viewport. Its full-screen wrapper intercepted pointer input, and the escape registration marked it modal, unlike Figma's docked, non-blocking panel.
- The editor's arrow-key handler nudges a selected layer; with no selection it does not pan the viewport. The article's keyboard pan gesture is therefore a parity gap. It was not added in this pass: that would introduce a new canvas input gesture rather than refine the existing panel/navigation controls.
- There is no Layout tab or keyboard-layout preference model. This was recorded as an unimplemented area, not expanded into a new settings feature.

## Outcome

Refined the existing shortcuts panel only: it now docks to the bottom of the viewport, its transparent placement layer passes pointer input through to the canvas, and the panel no longer claims modal keyboard ownership. It still participates in the shared Escape stack and closes through its close button or Escape. No new product surface or keyboard capability was added.

## Changed files

- `X-Native/apps/web/src/ui/chrome.tsx` — register the shortcuts panel as non-modal and render its dock wrapper without a click-to-dismiss veil.
- `X-Native/apps/web/src/styles.css` — bottom-dock the panel and pass pointer input through outside the card.
- `X-Native/apps/web/src/ui/__tests__/keyboardHelp.dom.test.mjs` — add interaction and dock-contract regression checks.
- `X-Native/apps/web/src/ui/__tests__/modalkeys.test.mjs` — assert the shortcuts panel is Escape-managed but non-modal.
- `X-Native/apps/web/package.json` — include the focused test in `npm test`.

## Verification

- `keyboardHelp.dom.test.mjs` — 9 passed.
- `escape.test.mjs` — 49 passed.
- `modalkeys.test.mjs` — 37 passed.
- `npm run build` — passed; Vite emitted its existing advisory that the main chunk is larger than 500 kB.
