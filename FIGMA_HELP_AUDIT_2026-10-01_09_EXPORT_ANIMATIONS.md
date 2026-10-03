# Figma Help parity audit — Export animations from Figma

**Date:** 2026-10-01
**Reference:** [Export animations from Figma](https://help.figma.com/hc/en-us/articles/41307983648407-Export-animations-from-Figma)

## Scope

Compared the article's Figma Motion export workflow with X-Native's design model, prototype interactions, presentation player, and export panel. Figma Motion is a separate open-beta animation authoring feature; this audit does not treat static exports or prototype navigation as equivalent animation exports.

## Reference requirements

- Animated content must be inside a top-level frame; only top-level frames with animated content can be exported.
- The Animated export UI offers MP4, WebM, GIF, or SVG, with size and frame-rate settings; MP4/WebM add quality, and GIF adds loop behavior.
- Lottie and dotLottie are separate export choices. The article notes limits for shaders, video, angular gradients, and first-frame-only drop shadow/noise/glass effects.
- Figma applies plan/access restrictions for higher resolution/frame rate and for files whose owner restricts copying/exporting.

## X-Native comparison

- X-Native has no Figma Motion-style timeline/keyframe or animated-layer data model and no Animated export tab.
- X-Native's `Interaction.animation` describes prototype navigation transitions (such as dissolve, move, or smart animate) between screens. It is not a time-based animation track attached to layers inside a frame and cannot be sampled as an MP4, GIF, animated SVG, or Lottie export.
- The existing presentation player runs prototype flows, but it does not expose deterministic frame sampling or a media export pipeline. The static export path supports PNG/JPG/SVG/PDF only.
- There is no Lottie/dotLottie serializer, browser video muxer, or GIF encoding path. Export-size/FPS plan gating and collaboration access restrictions are also not represented in the local editor model.

## Outcome

No code change was made. Adding export buttons for MP4, WebM, GIF, SVG, Lottie, or dotLottie without the underlying Motion timeline and deterministic renderer would claim unsupported behavior. A real implementation would first need an animation-track/keyframe model, time-addressable rendering, an encoder/muxing pipeline for raster/video formats, and a vector/Lottie serializer, followed by format-specific feature handling. This is a product/engine capability gap rather than a safe UI-only parity fix.

## Verification

Inspected `ExportFormat` and the static export capability table, the node `Interaction` model, `smartAnimate.ts`, and `PresentationPlayer.tsx`. The codebase contains prototype-transition and presentation playback logic, but no Motion track/keyframe or animated-media export implementation. No tests were changed because there is no behavior change to verify.
