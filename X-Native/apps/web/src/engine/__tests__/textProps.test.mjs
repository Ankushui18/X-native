/**
 * Text properties (Figma help 360039956634, 360039956434):
 *  - Default text layer: Inter, 16pt, weight 400, left-aligned, top-aligned,
 *    0 line height/letter spacing.
 *  - fontSize/weight/family/letterSpacing/lineHeight/textAlign can all be
 *    patched.
 *  - Click-and-drag text is "Fixed size" (sizingW: "fixed", sizingH: "fixed");
 *    click-only text is auto width/height ("hug"/"hug").
 *  - Text on a path (⌘ click a shape outline with T) transfers the shape's
 *    fill/effects to the new text layer.
 *  - Font-weight shortcuts ⌘⌥B bold, ⌘⌥I italic dispatch from chrome.tsx.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  // Default text layer from click-only (auto hug).
  const n = node("text", "Label", 0, 0, 0, 0, { text: "hello" });
  t("default text kind is 'text'", n.kind === "text");
  t("default font is Inter", n.fontFamily === "Inter");
  t("default fontSize is 16", n.fontSize === 16);
  t("default fontWeight is 400 (Regular)", n.fontWeight === 400);
  t("default textAlign is left", n.textAlign === "left");
  t("default textAlignVertical is top", n.textAlignVertical === "top");
  t("default lineHeight is 0 (auto)", n.lineHeight === 0);
  t("default letterSpacing is 0", n.letterSpacing === 0);
  t("default text has paragraphSpacing 0", n.paragraphSpacing === 0);
  t("default text has no list style", n.listStyle === "none");
  t("default text has no text decoration", n.textDecoration === "none");
  t("default text has no text case transform", n.textCase === "none");
}

{
  // Patch type properties.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const n = node("text", "T", 0, 0, 0, 0, { text: "hi" });
  r.children.push(n);
  engine.dispatch({ type: "patch", id: n.id, patch: {
    fontSize: 24, fontWeight: 700, letterSpacing: 1, lineHeight: 32,
    textAlign: "center", textAlignVertical: "middle",
  }});
  const p = find(r, n.id);
  t("fontSize can be set to 24", p.fontSize === 24);
  t("fontWeight can be set to 700 (Bold)", p.fontWeight === 700);
  t("letterSpacing can be set to 1px", p.letterSpacing === 1);
  t("lineHeight can be set to 32", p.lineHeight === 32);
  t("textAlign can be set to center", p.textAlign === "center");
  t("textAlignVertical can be set to middle", p.textAlignVertical === "middle");
}

{
  // Click-and-drag text is fixed size (explicit w/h per area-text spec).
  // Canvas.tsx creates dragged text with sizingW: "fixed", sizingH: "fixed"
  // when w>0 & h>0; here we verify the literal properties.
  const n = node("text", "Area", 0, 0, 300, 100, { text: "long text that wraps", sizingW: "fixed", sizingH: "fixed" });
  t("area text uses fixed sizing in both axes",
    n.sizingW === "fixed" && n.sizingH === "fixed");
  t("area text has explicit width", n.w === 300);
}

{
  // Auto-height text (fixed width, hug height) used for body copy.
  const n = node("text", "Body", 0, 0, 300, 0, { text: "body", sizingW: "fixed", sizingH: "hug" });
  t("auto-height text has fixed width and hug height",
    n.sizingW === "fixed" && n.sizingH === "hug");
}

{
  // Click-to-create auto-width text: Canvas sets sizingW: "hug", sizingH: "hug".
  const n = node("text", "Label", 0, 0, 0, 0, { text: "hello", sizingW: "hug", sizingH: "hug" });
  t("click-only auto-size text has hug/hug sizing",
    n.sizingW === "hug" && n.sizingH === "hug");
}

{
  // Italic is stored via fontStyle field.
  const n = node("text", "I", 0, 0, 0, 0, { text: "i", fontStyle: "italic" });
  t("italic text stores fontStyle 'italic'", n.fontStyle === "italic");
}

console.log(`\n${pass} passed, ${fail} failed`);
