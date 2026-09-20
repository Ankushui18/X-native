# OpenPencil adoption note

Upstream: <https://github.com/ZSeven-W/openpencil> (MIT License, © 2026
ZSeven—W), studied at `e6c9bce` — a Rust workspace (the TypeScript side is
retired) with ≤800-line files and clippy `-D warnings`.

OpenPencil already implements most Figma behaviour in code, so it is this
repo's first reference when a Figma behaviour needs a rule: read their
implementation, then implement the same behaviour in our architecture. No
OpenPencil source files are vendored — the adoption is behavioural, which is
why there is no entry in `THIRD_PARTY_NOTICES.md` (fonts only). If OpenPencil
source is ever copied in substantially, its MIT copyright notice must ship
with it.

## Adopted

- **Text commit rule** (`text_edit.rs`): the draft syncs to the node,
  Enter inserts a newline, Esc **commits** the edit (the layer stays
  selected), an outside press commits first and then dispatches, and only a
  fresh EMPTY node is discarded — by the same commit path, which removes a
  node whose committed text is empty. Ours: `run.rs` (`commit_text_field`,
  `commit_text_if_press_outside`, the `text_edit` Escape arm), pinned by
  `escape_commits_the_text_edit_and_keeps_the_layer_selected`,
  `escape_on_a_fresh_empty_text_discards_the_layer`,
  `an_outside_press_commits_the_text_before_selecting`.
- **Esc ladder**: exactly one layer per press, with the step semantics
  single-sourced. Ours: the `Esc` unwind order (master-list 3.9).
- **Codegen target shape**: one generator per platform over the document,
  with shared scalar variables plus per-target emitters. Ours:
  `x-format::codegen` behind the six INSPECT platforms
  (CSS / SwiftUI / Compose / XML / Tailwind / JSX).

## Studied, nothing to take

- **Canvas frame labels**: OpenPencil has no canvas frame-label
  implementation to copy, so ours is original — the engine's one
  size/offset/ink rule (`LABEL_SIZE`, `LABEL_ABOVE_Y`, `frame_label_targets`)
  read by the screen-space overlay (`editor_ui::paint_frame_labels`).

## Deliberately not ported

In-app AI chat, P2P WebRTC collaboration, HTML/CSS → document import, and
XPath queries — each with its reason in `KNOWN_DEBT.md` §5.
