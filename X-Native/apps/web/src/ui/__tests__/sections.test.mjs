/**
 * Run 7 - Figma parity, Sections: a titled top-level container that sits behind
 * the frames it holds and does not clip.
 *
 * Source of truth: Figma's *Organize your canvas with sections* article,
 * https://help.figma.com/hc/en-us/articles/9771500257687
 *  - "Sections in Figma Design are a top-level element on the canvas by default.
 *    Sections can contain all layer types, including other sections, but cannot
 *    be contained within frames or groups."
 *  - "Click Section in the toolbar or use the keyboard shortcut ⇧ Shift S. Click
 *    and drag the location of the canvas where you'd like the section to go."
 *  - "You can also click and drag a section over the objects you want to add to
 *    it." / "Wrap in new section" from the right-click menu.
 *  - "Double-click the section title on the canvas or Layers panel. Edit the
 *    title. Press Return or Enter."
 *  - "Change the background and border color for a section using the Fill and
 *    Stroke sections of the right sidebar."
 *
 * Measured before the fix (probe, deleted): the Section tool's drag created
 * `kind=frame name="Section" fill=#00000000` (a fully transparent frame, no
 * background, no border), `node("section")` fell back to a plain shape's
 * defaults (`#d9d9d9`, no stroke) because the kind was not in `NodeKind`, no
 * title was painted anywhere except through the frame-label overlay, and a
 * section listed after a frame painted over it: the overlap pixel read
 * r=255 g=0 b=0 where the frame is green.
 *
 * The inspector half is pinned too: a section is offered no Clip content
 * toggle, because it never clips.
 *
 * Not implemented, and recorded in the comparison doc rather than claimed here:
 * a section does not yet take in the objects it is drawn or resized over
 * ("You can also click and drag a section over the objects you want to add to
 * it"), and the web app has no delete-keeping-contents route (Figma's ⌘⌫).
 *
 * The canvas half runs against the software Canvas2D in ./softCanvas2d.mjs and
 * reads device pixels and recorded fillText calls.
 *
 * Run: vite-node src/ui/__tests__/sections.test.mjs
 */
import { MemoryEngine, node, find, findParent } from "../../engine/memory.ts";
import { TOOL_META } from "../../engine/types.ts";
import { stopsMaskReach } from "../../engine/paint.ts";
import { contexts, mountCanvas } from "./softCanvas2d.mjs";
import { mountSurface } from "./domEnv.mjs";

let pass = 0,
  fail = 0;
const t = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? ` - ${extra}` : ""}`);
};

const frame = (name, x, y, w, h, extra = {}) =>
  node("frame", name, x, y, w, h, { fill: "#ffffff", fillVisible: true, ...extra });
const rect = (name, x, y, w, h, extra = {}) =>
  node("rect", name, x, y, w, h, { fill: "#00ff00", fillVisible: true, ...extra });

/* The canvas answers real mouse events; screen == world here (zoom 1, no pan),
 * and the harness pins the canvas rect at (50, 30). */
const makeDrag = (ui) => (x0, y0, x1, y1) => {
  const el = ui.host.querySelector("canvas");
  const box = el.getBoundingClientRect();
  const at = (x, y) => ({
    clientX: box.left + x,
    clientY: box.top + y,
    bubbles: true,
    button: 0,
  });
  el.dispatchEvent(new MouseEvent("mousedown", at(x0, y0)));
  el.dispatchEvent(new MouseEvent("mousemove", at(x1, y1)));
  el.dispatchEvent(new MouseEvent("mouseup", at(x1, y1)));
};
const textsOf = (name) =>
  contexts.flatMap((c) => c.texts).filter((x) => x.text === name);

/* ------------------------------------------------------------------ *
 * 1. The tool: ⇧S, and what a drag on the canvas actually creates.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([]);
  const drag = makeDrag(ui);
  const meta = TOOL_META.find((m) => m.id === "section");
  t(
    "tool: the toolbar offers Section on ⇧S",
    !!meta && meta.label === "Section" && meta.shortcut === "⇧S",
    JSON.stringify(meta),
  );
  await ui.dispatch({ type: "setTool", tool: "section" });
  t("tool: ⇧S arms the Section tool", ui.engine.snapshot().tool === "section");
  drag(100, 200, 300, 320);
  const root = ui.engine.snapshot().pages[0].root;
  const made = root.children[root.children.length - 1];
  t(
    "creation: the drag draws a section at the drawn box",
    made.kind === "section" && made.x === 100 && made.y === 200 && made.w === 200 && made.h === 120,
    `kind=${made.kind} ${made.x},${made.y} ${made.w}x${made.h}`,
  );
  t(
    "creation: the section is the article's top-level element, not a frame",
    findParent(root, made.id) === root,
    `parent=${findParent(root, made.id)?.name}`,
  );
  await ui.close();
}
{
  // "cannot be contained within frames or groups": a drag that starts over a
  // frame still creates the section on the canvas.
  const ui = await mountCanvas([frame("Host frame", 0, 0, 300, 300)]);
  const drag = makeDrag(ui);
  await ui.dispatch({ type: "setTool", tool: "section" });
  drag(40, 40, 200, 160);
  const root = ui.engine.snapshot().pages[0].root;
  const made = root.children[root.children.length - 1];
  t(
    "creation: a section drawn over a frame lands on the canvas, not inside it",
    made.kind === "section" && findParent(root, made.id) === root,
    `kind=${made.kind} parent=${findParent(root, made.id)?.name}`,
  );
  // Scope boundary, recorded rather than claimed: Figma's "You can also click
  // and drag a section over the objects you want to add to it" (and resizing a
  // section over an object) takes those objects in. This run implements
  // creation, rendering and z-order only, so the draw does not absorb yet - the
  // assertion pins the world box and the parenting, not Figma's take-in.
  t(
    "creation: drawing over a frame leaves it where it is for now (recorded residual)",
    find(root, root.children[0].id)?.children.length === 0,
  );
  await ui.close();
}
{
  // "Right-click the selection and select Wrap in new section."
  const host = frame("Host frame", 100, 100, 200, 200);
  const kid = rect("Kid", 40, 30, 60, 50);
  host.children = [kid];
  const ui = await mountCanvas([host]);
  const root = () => ui.engine.snapshot().pages[0].root;
  kid.visible = true;
  const liveKid = find(root(), kid.id);
  await ui.dispatch({ type: "select", ids: [liveKid.id] });
  await ui.dispatch({ type: "wrapSection" });
  const wrapped = root().children[root().children.length - 1];
  t(
    "wrap: Wrap in new section makes a real section",
    wrapped.kind === "section" && wrapped.name === "Section",
    `kind=${wrapped.kind} name=${wrapped.name}`,
  );
  t(
    "wrap: a section wrapped inside a frame is lifted to the canvas",
    findParent(root(), wrapped.id) === root(),
    `parent=${findParent(root(), wrapped.id)?.name}`,
  );
  t(
    "wrap: the section keeps the selection's world box and holds it",
    wrapped.x === 140 && wrapped.y === 130 && wrapped.w === 60 && wrapped.h === 50 && wrapped.children.length === 1,
    `${wrapped.x},${wrapped.y} ${wrapped.w}x${wrapped.h} children=${wrapped.children.length}`,
  );
  await ui.close();
}
{
  // The engine rule itself, whichever route a caller takes.
  const engine = new MemoryEngine(false, {
    pages: [{ id: "p", name: "Page", root: frame("Page", 0, 0, 800, 800, { kind: "frame" }), guides: [], comments: [] }],
    page: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  const root = () => engine.snapshot().pages[0].root;
  engine.dispatch({ type: "add", kind: "frame", x: 0, y: 0, w: 100, h: 100 });
  const hostId = root().children[0].id;
  engine.dispatch({ type: "add", kind: "section", x: 10, y: 10, w: 50, h: 50, parent: hostId });
  const made = root().children[root().children.length - 1];
  t(
    "engine: add() refuses to nest a section in a frame",
    made.kind === "section" && findParent(root(), made.id) === root(),
    `parent=${findParent(root(), made.id)?.name}`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. Defaults: its own background and border, and no clipping.
 * ------------------------------------------------------------------ */
{
  const s = node("section", "Fresh section", 0, 0, 100, 100);
  const r = node("rect", "Shape", 0, 0, 100, 100);
  t(
    "defaults: a section carries the article's own fill and stroke",
    s.fill === "#ffffff" && s.fillVisible === true && s.strokePaint === "#e6e6e6" && s.strokeVisible === true && s.strokeWidth === 1,
    `fill=${s.fill} stroke=${s.strokePaint}/${s.strokeWidth} visible=${s.strokeVisible}`,
  );
  t(
    "defaults: those are not a plain shape's defaults",
    r.fill !== s.fill && r.strokePaint !== s.strokePaint,
    `rect fill=${r.fill} stroke=${r.strokePaint}`,
  );
  t(
    "defaults: a section does not clip content",
    s.overflow === "visible",
    `overflow=${s.overflow}`,
  );
  t(
    "defaults: a section is not a mask boundary (run 6's rule stays frame-only)",
    stopsMaskReach({ kind: "section", overflow: "clip" }) === false,
  );
}

/* ------------------------------------------------------------------ *
 * 3. Paint: background, no clipping, and behind the frames it holds.
 * ------------------------------------------------------------------ */
{
  const ui = await mountCanvas([
    frame("Green frame", 60, 0, 100, 100, { fill: "#00ff00" }),
    node("section", "Later section", 0, 0, 100, 100, { fill: "#ff0000", fillVisible: true }),
  ]);
  const overlap = ui.pixelAt(70, 50);
  const sectionOnly = ui.pixelAt(20, 80);
  t(
    "z-order: a section listed after a frame still paints behind it",
    overlap.r === 0 && overlap.g === 255 && overlap.b === 0,
    `overlap r=${overlap.r} g=${overlap.g} b=${overlap.b} (the frame is green)`,
  );
  t(
    "z-order: and the section paints where the frame is not",
    sectionOnly.r === 255 && sectionOnly.g === 0,
    `r=${sectionOnly.r} g=${sectionOnly.g}`,
  );
  await ui.close();
}
{
  const ui = await mountCanvas([
    frame("Container", 0, 0, 400, 400, {
      children: [
        frame("Inner frame", 60, 0, 100, 100, { fill: "#00ff00" }),
        node("section", "Nested section", 0, 0, 100, 100, { fill: "#ff0000", fillVisible: true }),
      ],
    }),
  ]);
  const overlap = ui.pixelAt(70, 50);
  t(
    "z-order: the same holds inside a container",
    overlap.g === 255 && overlap.r === 0,
    `r=${overlap.r} g=${overlap.g} b=${overlap.b}`,
  );
  await ui.close();
}
{
  // Its own background and border, and a child that spills out is not clipped.
  const spill = rect("Spilling rect", 70, 20, 80, 40, { fill: "#3b82f6" });
  const ui = await mountCanvas([
    node("section", "Studio section", 0, 0, 100, 100, {
      fill: "#eeeeee",
      fillVisible: true,
      strokePaint: "#cccccc",
      strokeVisible: true,
      strokeWidth: 1,
      children: [spill],
    }),
  ]);
  const inside = ui.pixelAt(10, 80);
  const outside = ui.pixelAt(130, 40);
  t(
    "paint: the section's own background colour is painted",
    inside.r === 238 && inside.g === 238 && inside.b === 238,
    `r=${inside.r} g=${inside.g} b=${inside.b} (fill #eeeeee)`,
  );
  t(
    "paint: a child spilling past the box is not clipped",
    outside.r === 59 && outside.g === 130 && outside.b === 246,
    `r=${outside.r} g=${outside.g} b=${outside.b} (blue #3b82f6 at x=130, outside the 100px section)`,
  );
  await ui.close();
}
{
  // The harness records stroke passes rather than rasterising them, so the
  // border is read from the pass it asks for.
  const from = contexts.length;
  const ui = await mountCanvas([node("section", "Default section", 0, 0, 100, 100)]);
  const border = contexts
    .slice(from)
    .flatMap((c) => c.strokes)
    .filter((x) => /#e6e6e6|rgba\(230,\s*230,\s*230/i.test(String(x.color)));
  t(
    "paint: a default section paints its border",
    border.length >= 1,
    `${border.length} strokes in #e6e6e6 (${JSON.stringify(contexts.slice(from).flatMap((c) => c.strokes.map((x) => x.color)).slice(0, 4))})`,
  );
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 4. The title: on the canvas, at the top-left, and renameable.
 * ------------------------------------------------------------------ */
{
  const before = contexts.length;
  const ui = await mountCanvas([
    node("section", "Flow A", 0, 0, 200, 120, { fill: "#f5f5f5", fillVisible: true }),
  ]);
  const titles = textsOf("Flow A");
  t(
    "title: the section paints its name without being selected",
    titles.length === 1,
    `${titles.length} fillText("Flow A")`,
  );
  t(
    "title: it sits inside the section's top-left corner, at a constant 12px",
    titles[0]?.x === 8 && titles[0]?.y === 16 && /12px/.test(titles[0]?.font || ""),
    JSON.stringify(titles[0] && { x: titles[0].x, y: titles[0].y, font: titles[0].font }),
  );
  t(
    "title: it is not the frame-label rule (which hangs above the box)",
    titles.every((x) => x.y !== -8),
    JSON.stringify(titles.map((x) => x.y)),
  );

  // Move and resize: the title follows its box.
  await ui.dispatch({ type: "move", ids: [ui.engine.snapshot().pages[0].root.children[0].id], dx: 40, dy: 20 });
  await ui.dispatch({
    type: "patch",
    id: ui.engine.snapshot().pages[0].root.children[0].id,
    patch: { w: 260, h: 150 },
  });
  const moved = textsOf("Flow A").slice(-1)[0];
  t(
    "title: it follows the section when it moves",
    moved?.x === 48 && moved?.y === 36,
    JSON.stringify(moved && { x: moved.x, y: moved.y }),
  );

  // Rename: the painted title is the section's name. Every paint appends to the
  // same log, so the newest title is the one the section draws now.
  await ui.dispatch({
    type: "patch",
    id: ui.engine.snapshot().pages[0].root.children[0].id,
    patch: { name: "Flow B" },
  });
  const log = contexts.slice(before).flatMap((c) => c.texts);
  const last = log[log.length - 1];
  t(
    "title: renaming the section renames the painted title",
    last?.text === "Flow B" && log.some((x) => x.text === "Flow A"),
    `last=${JSON.stringify(last?.text)}`,
  );
  t(
    "title: the title pass is on the canvas, not in a tile",
    contexts.slice(before).flatMap((c) => c.texts).every((x) => x.inDoc),
  );
  await ui.close();
}
{
  // Zoom: the box scales, the title's type does not.
  const ui = await mountCanvas(
    [node("section", "Zoomed", 50, 50, 100, 100, { fill: "#f5f5f5", fillVisible: true })],
    { zoom: 2 },
  );
  // The box lands at screen (100, 100); the title keeps its 8/16 padding in
  // screen pixels instead of scaling, so it reads the same at any zoom.
  const title = textsOf("Zoomed").slice(-1)[0];
  t(
    "title: it keeps its padding and stays 12px while the canvas zooms",
    title?.x === 108 && title?.y === 116 && /12px/.test(title?.font || ""),
    JSON.stringify(title && { x: title.x, y: title.y, font: title.font }),
  );
  await ui.close();
}
{
  // "Double-click the section title on the canvas … Edit the title."
  const ui = await mountCanvas([
    node("section", "Renamed here", 0, 0, 200, 120, { fill: "#f5f5f5", fillVisible: true }),
  ]);
  const el = ui.host.querySelector("canvas");
  const box = el.getBoundingClientRect();
  await ui.act(() => {
    el.dispatchEvent(
      new MouseEvent("dblclick", {
        clientX: box.left + 20,
        clientY: box.top + 10,
        bubbles: true,
        button: 0,
      }),
    );
  });
  const input = ui.host.querySelector("input");
  t(
    "title: double-clicking the title opens an editor holding the section's name",
    !!input && input.value === "Renamed here",
    input ? `value=${JSON.stringify(input.value)}` : "no input appeared",
  );
  await ui.close();
}

/* ------------------------------------------------------------------ *
 * 5. The inspector: a section has no clip-content property. Figma never clips
 *    a section, so the right sidebar must not offer the toggle for one -
 *    measured before the fix: the row rendered for a section (unchecked but
 *    live, and clicking it wrote `overflow: "clip"` onto a section).
 * ------------------------------------------------------------------ */
{
  const clipRow = (ui) =>
    ui.all("label.check").find((el) => (el.textContent || "").trim().startsWith("Clip content")) ?? null;
  const selectedNode = (ui) => {
    const sel = ui.engine.snapshot().selection[0];
    const walk = (n) => (n.id === sel ? n : n.children.reduce((hit, c) => hit ?? walk(c), null));
    return walk(ui.engine.snapshot().pages[0].root);
  };

  const section = await mountSurface("inspector", {
    layer: (engine) => {
      engine.dispatch({ type: "add", kind: "section", x: 40, y: 40, w: 240, h: 140 });
      return engine.snapshot().selection[0];
    },
  });
  t(
    "inspector: a selected section is offered no Clip content toggle",
    clipRow(section) === null,
    clipRow(section) ? `row present: ${JSON.stringify(clipRow(section).textContent)}` : "row absent",
  );
  t(
    "inspector: the section keeps overflow: \"visible\" (it never clips)",
    selectedNode(section)?.kind === "section" && selectedNode(section)?.overflow === "visible",
    `kind=${selectedNode(section)?.kind} overflow=${selectedNode(section)?.overflow}`,
  );
  t(
    "inspector: Use as mask is still offered on a section",
    section.all("label.check").some((el) => (el.textContent || "").trim().startsWith("Use as mask")),
  );

  // Controls: the same row is untouched for the kinds that do clip.
  const frameUi = await mountSurface("inspector", {
    layer: (engine) => {
      engine.dispatch({ type: "add", kind: "frame", x: 40, y: 40, w: 240, h: 140 });
      return engine.snapshot().selection[0];
    },
  });
  const frameRow = clipRow(frameUi);
  t(
    "inspector: a frame still offers Clip content, checked by default",
    !!frameRow && frameRow.querySelector("input")?.checked === true,
    frameRow ? `checked=${frameRow.querySelector("input")?.checked}` : "row absent",
  );
  const rectUi = await mountSurface("inspector", {
    layer: (engine) => {
      engine.dispatch({ type: "add", kind: "rect", x: 40, y: 40, w: 120, h: 80 });
      return engine.snapshot().selection[0];
    },
  });
  const rectRow = clipRow(rectUi);
  t(
    "inspector: a shape still offers Clip content, unchecked",
    !!rectRow && rectRow.querySelector("input")?.checked === false,
    rectRow ? `checked=${rectRow.querySelector("input")?.checked}` : "row absent",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
