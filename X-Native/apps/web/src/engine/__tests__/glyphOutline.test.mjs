/** Batch 2: glyph boundaries, positions/styles, history and unchanged Flatten.
 * Raster path is exercised with deterministic alpha data; not font fidelity QA. */
import { MemoryEngine, node, find, localToWorld, defaultEffect } from "../memory.ts";
import { convertTextToGlyphPaths, convertTextToVectorPaths } from "../textVector.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const rootOf = (e) => e.snapshot().pages[0].root;
const selected = (e) => e.snapshot().selection.map((id) => find(rootOf(e), id));
const textNode = (extra = {}) => node("text", "Original", 40, 60, 120, 40, { text: "Hi", fontSize: 20, ...extra });
const engineFor = (children, ids = []) => {
  const e = new MemoryEngine(false, { pages: [{ id: "page", name: "Page", root: node("frame", "Root", 0, 0, 1000, 1000, { children }), guides: [], comments: [] }], page: 0 });
  e.dispatch({ type: "select", ids });
  return e;
};
const hi = convertTextToGlyphPaths("Hi", 20);
t("Hi produces two glyph results", hi.length === 2 && hi.map((g) => g.char).join("") === "Hi");
t("the dot and stem of i share one glyph network", hi[1].network.regions[0].loops.length === 2);
t("each glyph has local geometry, not a cumulative offset", hi.every((g) => Math.min(...g.network.vertices.map((v) => v.x)) === 0 && Math.min(...g.network.vertices.map((v) => v.y)) === 0));
t("glyph offsets use advances, not ink widths", near(hi[1].x, (82 + 8) * 0.2));
t("glyph bounds contain all vertices", hi.every((g) => g.network.vertices.every((v) => v.x >= 0 && v.x <= g.w && v.y >= 0 && v.y <= g.h)));
const spaced = convertTextToGlyphPaths("H i", 20);
t("spaces advance without creating empty layers", spaced.length === 2 && near(spaced[1].x, (82 + 30 + 8) * 0.2));
const tracking = convertTextToGlyphPaths("Hi", 20, "Inter", "400", 5);
t("letter spacing contributes once", near(tracking[1].x, hi[1].x + 5));
const lines = convertTextToGlyphPaths("H\r\ni", 20, "Inter", "400", 0, 32);
t("newlines reset horizontal advance and move down a line", lines.length === 2 && near(lines[1].x, 1.6) && near(lines[1].y, 32 + 1.6));
t("empty text does not invent Text glyphs", convertTextToGlyphPaths("", 20).length === 0);
t("whitespace-only text has no drawable glyphs", convertTextToGlyphPaths(" \n ", 20).length === 0);
t("surrogate pairs aren't split into duplicate layers", convertTextToGlyphPaths("😀", 20).length === 1);
t("combining marks stay with their base letter", convertTextToGlyphPaths("e\u0301", 20).length === 1);
t("counter loops stay with their glyph", convertTextToGlyphPaths("O", 20)[0].network.regions[0].loops.length === 2);
const flat = convertTextToVectorPaths("Hi", 20);
t("merged converter remains a single result for Flatten", !Array.isArray(flat) && flat.network.vertices.length > hi[0].network.vertices.length);

for (const command of ["outlineStroke", "convertTextToVector"]) {
  const original = textNode({ fill: "#123456", opacity: 0.6, strokePaint: "#abcdef", strokeWidth: 2, strokeVisible: true, effects: [defaultEffect("drop-shadow")] });
  const back = node("rect", "Back", 0, 0, 10, 10), front = node("rect", "Front", 300, 0, 10, 10);
  const e = engineFor([back, original, front], [original.id]);
  e.dispatch({ type: command });
  const glyphs = selected(e), ids = e.snapshot().selection;
  t(`${command}: selects two separate vector layers`, glyphs.length === 2 && glyphs.every((g) => g.kind === "vector"));
  t(`${command}: removes the original text layer`, !find(rootOf(e), original.id));
  t(`${command}: preserves the sibling paint-order slot`, rootOf(e).children.map((c) => c.id).join() === [back.id, ...ids, front.id].join());
  t(`${command}: offsets are applied exactly once`, glyphs.every((g, i) => near(g.x, original.x + hi[i].x) && near(g.y, original.y + hi[i].y)));
  t(`${command}: carries fills, stroke, opacity and effects`, glyphs.every((g) => g.fill === original.fill && g.strokePaint === original.strokePaint && g.strokeWidth === 2 && g.opacity === 0.6 && JSON.stringify(g.effects) === JSON.stringify(original.effects)));
  t(`${command}: editable glyphs do not alias styles`, glyphs[0].effects !== glyphs[1].effects && glyphs[0].effects[0] !== glyphs[1].effects[0]);
  t(`${command}: clears text and sets closed local vector geometry`, glyphs.every((g) => g.text === "" && g.closed && !g.children.length && g.sizingW === "fixed" && g.sizingH === "fixed"));
  e.dispatch({ type: "undo" });
  t(`${command}: one undo restores original text/order/selection`, rootOf(e).children.map((c) => c.id).join() === [back.id, original.id, front.id].join() && find(rootOf(e), original.id).kind === "text" && e.snapshot().selection[0] === original.id);
  e.dispatch({ type: "redo" });
  t(`${command}: redo restores the same glyph IDs`, e.snapshot().selection.join() === ids.join() && selected(e).every((g) => g.kind === "vector"));
}
{
  const original = textNode({ rotation: 37, flipH: true, flipV: true });
  const parent = node("frame", "Parent", 120, 200, 300, 200, { rotation: 20, children: [original] });
  const e = engineFor([parent], [original.id]);
  const expected = hi.map((g) => localToWorld(rootOf(e), original.id, g.x + g.network.vertices[0].x, g.y + g.network.vertices[0].y));
  e.dispatch({ type: "outlineStroke" });
  const glyphs = selected(e);
  const actual = glyphs.map((g) => localToWorld(rootOf(e), g.id, g.vectorNetwork.vertices[0].x, g.vectorNetwork.vertices[0].y));
  t("rotated/flipped text preserves each glyph's world position in a transformed parent", actual.every((p, i) => near(p.x, expected[i].x) && near(p.y, expected[i].y)));
  t("nested conversion stays in its original parent", find(rootOf(e), parent.id).children.map((g) => g.id).join() === glyphs.map((g) => g.id).join());
}
{
  const a = textNode(), b = textNode({ text: "O!", x: 200 });
  const e = engineFor([a, b], [a.id, b.id]);
  e.dispatch({ type: "outlineStroke" });
  t("multi-text outline selects all four glyphs without merging", selected(e).length === 4 && rootOf(e).children.length === 4);
  e.dispatch({ type: "undo" });
  t("multi-text outline is one undo operation", rootOf(e).children.length === 2 && find(rootOf(e), a.id)?.text === "Hi" && find(rootOf(e), b.id)?.text === "O!");
}
for (const command of ["outlineStroke", "convertTextToVector"]) {
  for (const scenario of ["locked", "ancestorLocked", "instanceMember", "empty", "whitespace"]) {
    const original = textNode({ text: scenario === "empty" ? "" : scenario === "whitespace" ? "  " : "Hi", locked: scenario === "locked" });
    const parent = node("frame", "Parent", 0, 0, 300, 200, { children: [original], locked: scenario === "ancestorLocked", componentId: scenario === "instanceMember" ? "component" : "" });
    const e = engineFor([parent], [original.id]);
    e.dispatch({ type: command, id: original.id });
    t(`${command}: ${scenario} is a safe no-op`, find(rootOf(e), original.id)?.kind === "text" && find(rootOf(e), parent.id)?.children.length === 1);
  }
}
{
  const original = textNode(), neighbor = node("rect", "Neighbor", 0, 0, 50, 40);
  const parent = node("frame", "Flow", 0, 0, 300, 100, { children: [original, neighbor], layout: { direction: "horizontal", gap: 12, padding: [0, 0, 0, 0], sizing: "fixed", cross: "fixed", align: "min", justify: "min", wrap: false } });
  const e = engineFor([parent], [original.id]);
  // Settle the initial flow before comparing.
  e.dispatch({ type: "patch", id: parent.id, patch: { name: "Flow" } });
  const before = find(rootOf(e), neighbor.id).x;
  e.dispatch({ type: "outlineStroke" });
  const slot = find(rootOf(e), original.id);
  t("auto-layout text keeps one flow slot containing two editable glyphs", slot?.kind === "group" && slot.children.length === 2 && selected(e).every((g) => g.kind === "vector"));
  t("auto-layout conversion does not add gaps or shift neighboring items", near(find(rootOf(e), neighbor.id).x, before) && slot.w === original.w && slot.h === original.h);
}
{
  const original = textNode();
  const e = engineFor([original], [original.id]);
  e.dispatch({ type: "flatten" });
  t("Flatten still produces one vector with the original identity", rootOf(e).children.length === 1 && find(rootOf(e), original.id)?.kind === "vector");
}

// A fake rasterizer makes the browser path deterministic and exercises both
// stem+dot contours without requiring a machine-specific font or native canvas.
const drawn = [];
const priorDocument = globalThis.document;
globalThis.document = {
  createElement() {
    const canvas = { width: 0, height: 0 };
    const ctx = {
      font: "", char: "", px: 0, py: 0,
      measureText(text) {
        const size = Number(this.font.match(/([\d.]+)px/)?.[1] || 20);
        const width = Array.from(text).reduce((w, c) => w + (c === "i" ? 0.3 : c === " " ? 0.4 : 0.8) * size, 0);
        return { width: width - (text.includes("Hi") ? size * 0.05 : 0) };
      },
      fillText(char, x, y) { this.char = char; this.px = x; this.py = y; drawn.push(char); },
      getImageData() {
        const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        const size = Number(this.font.match(/([\d.]+)px/)[1]);
        const top = Math.round(this.py - size * 0.8), left = Math.round(this.px + 2);
        for (let y = top; y < top + size * 0.7; y++) {
          if (this.char === "i" && y > top + 4 && y < top + 12) continue;
          for (let x = left; x < left + Math.max(3, size * (this.char === "i" ? 0.12 : 0.5)); x++) data[(y * canvas.width + x) * 4 + 3] = 255;
        }
        return { data };
      },
    };
    canvas.getContext = () => ctx;
    return canvas;
  },
};
try {
  const glyphs = convertTextToGlyphPaths("Hi", 20, "AuditFont", "600");
  t("browser tracing rasterizes each glyph separately", drawn.join() === "H,i" && glyphs.length === 2);
  t("browser i contours stay in one layer", glyphs[1].network.regions[0].loops.length >= 2);
  t("browser positions retain measured prefix kerning", near(glyphs[1].x - glyphs[0].x, 15));
  t("browser geometry is local and bounded", glyphs.every((g) => g.network.vertices.every((v) => v.x >= 0 && v.y >= 0 && v.x <= g.w && v.y <= g.h)));
  const small = convertTextToGlyphPaths("H", 8)[0];
  t("raster supersampling clamp does not enlarge a small font", small.h < 8);
} finally {
  if (priorDocument === undefined) delete globalThis.document;
  else globalThis.document = priorDocument;
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
