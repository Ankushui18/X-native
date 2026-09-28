/**
 * Figma parity — the baseline control in the mounted inspector.
 *
 * The engine half of this feature is pinned in
 * `engine/__tests__/baselineAlignment.test.mjs`. This file covers the surface a
 * user actually touches, per Figma's *Use the horizontal and vertical flows in
 * auto layout* (help.figma.com 31289464393751):
 *
 *   "To align layers by their baselines, select the layers you want to align,
 *    and click [the alignment box] from the right panel … Next to text baseline
 *    alignment, click to enable baseline alignment."
 *   "Tip: Click the alignment box in the right panel, and press `B` to toggle
 *    text baseline alignment on and off."
 *
 * and the alignment box's own rule — "What alignment options are available are
 * determined by the flow of the auto layout frame" — so a vertical flow, which
 * has no text baseline to align to, offers no baseline control at all.
 */
import { installDom, mountPanel } from "./domEnv.mjs";
import { MemoryEngine } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
installDom();
const React = await import("react");
const { act } = React;

/** A frame whose layout is exactly what the caller asks for, selected. */
const frame = (layout, kids = 2) => (e) => {
  e.dispatch({ type: "add", kind: "frame", x: 100, y: 100, w: 300, h: 120, parent: e.snapshot().pages[0].root.id });
  const id = e.snapshot().selection[0];
  e.dispatch({ type: "autoLayout", id, layout });
  for (let i = 0; i < kids; i++) {
    e.dispatch({ type: "add", kind: i === 0 ? "rect" : "text", x: 0, y: 0, w: 48, h: i === 0 ? 48 : 20,
      extra: i === 0 ? {} : { text: "Home", fontSize: 14 }, parent: id });
  }
  // Adding a child selects it; the panel is about the frame.
  e.dispatch({ type: "select", ids: [id] });
  return id;
};
const row = (over = {}) => ({
  direction: "horizontal", gap: 10, padding: [0, 0, 0, 0],
  sizing: "hug", cross: "hug", wrap: false, align: "min", justify: "min", ...over,
});

{
  const ui = await mountPanel({ layer: frame(row({ align: "baseline" })) });
  const box = ui.one("[data-align-box]");
  t("the alignment box is on the panel", !!box);
  t("it reads as baseline-aligned", box.className.includes("baseline"));
  const toggle = ui.one("button[title='Baseline alignment active']");
  t("the baseline control says it is active", !!toggle);
  await ui.click(toggle);
  t("clicking it drops back to the start edge", ui.node().layout.align === "min");
  t("and the box stops reading as baseline", !ui.one("[data-align-box]").className.includes("baseline"));
  await ui.click(ui.one("button[title='Align to text baseline']"));
  t("clicking again turns baseline back on", ui.node().layout.align === "baseline");
  await ui.unmount();
}

{
  // `B` on the focused alignment box, which is the documented shortcut.
  const ui = await mountPanel({ layer: frame(row()) });
  const box = ui.one("[data-align-box]");
  await ui.press(box, "b");
  t("B on the alignment box toggles baseline on", ui.node().layout.align === "baseline");
  await ui.press(box, "b");
  t("and off again", ui.node().layout.align === "min");
  await ui.unmount();
}

{
  const ui = await mountPanel({ layer: frame(row({ direction: "vertical", align: "min" })) });
  t("a vertical flow offers no baseline control", ui.one("button[title='Align to text baseline']") === null
    && ui.one("button[title='Baseline alignment active']") === null);
  await ui.unmount();
}

{
  // Switching a baseline row to a vertical flow: the panel must not keep
  // showing a setting the flow cannot have, and the model must not keep it
  // either, or the two disagree.
  const ui = await mountPanel({ layer: frame(row({ align: "baseline" })) });
  t("the row starts baseline-aligned", ui.node().layout.align === "baseline");
  await ui.dispatch({ type: "autoLayout", id: ui.id, layout: { ...ui.node().layout, direction: "vertical" } });
  t("the stored layout normalizes the stale baseline", ui.node().layout.direction === "vertical" && ui.node().layout.align === "min");
  t("the vertical panel shows no baseline state", !ui.one("[data-align-box]")?.className.includes("baseline"));
  await ui.dispatch({ type: "autoLayout", id: ui.id, layout: { ...ui.node().layout, direction: "horizontal" } });
  t("switching back starts from the edge, not from a resurrected baseline", ui.node().layout.align === "min");
  t("and the control is offered again", !!ui.one("button[title='Align to text baseline']"));
  await ui.unmount();
}

{
  // The row the panel is showing is the row the canvas paints: the icon's
  // bottom and the text's baseline are one line, and the hug the panel reads
  // back reserves the descender.
  const ui = await mountPanel({ layer: frame(row({ align: "baseline" })) });
  const [icon, label] = ui.node().children;
  t("the inspector's frame hugs the baseline row", Math.abs(ui.node().h - (48 + (20 - 14 * 0.8))) < 1e-6);
  t("the icon's bottom edge is the shared line", Math.abs(icon.y + icon.h - (label.y + 14 * 0.8)) < 1e-6);
  await ui.unmount();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
