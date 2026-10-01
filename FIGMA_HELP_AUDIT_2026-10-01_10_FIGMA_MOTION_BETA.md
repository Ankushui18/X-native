# Figma Help parity audit — Figma Motion beta overview

**Date:** 2026-10-01
**Reference:** [What Figma features are in beta? — Figma Motion section](https://help.figma.com/hc/en-us/articles/4406787442711-What-Figma-features-are-in-beta)

## Scope

Follow-up to the animated-export topic, limited to the article's Figma Motion subsection. Other beta products on this page are separate topics. Agent-generated motion and MCP/AI workflows were not evaluated as improvement work.

## Reference behavior

Figma Motion is an open beta for Full seats on all plans, except Government plans. Creating and editing requires file edit access. Its authoring model includes preset and authored keyframes, easing and spring curves, reusable timing/easing variables, and animated components. Dev Mode offers a read-only timeline and code inspection. The beta overview lists MP4, GIF, WebM, and Animated SVG export; it says Lottie is planned for the future. Paid Full seats are required for high-resolution video exports and publishing animated components.

## X-Native comparison

- X-Native has prototype interaction transitions, easing, and a `smartAnimate` interpolation helper. These operate between prototype screens/interactions; they are not Motion keyframe tracks, a reusable timing/easing-variable system, or animated components.
- There is no Motion editing surface, read-only animation timeline, Motion export mode, or animation file encoder. Static SVG export does not create Animated SVG.
- X-Native is a local editor without Figma seat tiers, Government plans, or shared-file permission roles, so Figma's beta and access entitlements have no direct equivalent.

## Outcome

No code change was appropriate. The beta overview confirms that the prior animated-export gap is a missing product model, not merely a missing format selector. Reusing prototype transitions as Motion exports would be incomplete: arbitrary keyframes, timeline timing, animated components, deterministic frame rendering, and export encoders are absent. Plan/role gates should not be invented for X-Native without a corresponding account and sharing model.

## Verification

Inspected the `Interaction` type, `smartAnimate.ts`, static `ExportFormat` capabilities, and the inspector/presentation surfaces. They confirm prototype transition support but no Motion-track or animation-export path. No tests were changed because behavior was not changed.
