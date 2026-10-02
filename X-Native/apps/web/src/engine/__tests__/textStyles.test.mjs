/**
 * Text style shortcuts (⌘B bold, ⌘I italic, ⌘U underline) toggle the
 * respective fields on selected text layers. Chrome.tsx dispatches patch
 * events; this test drives the engine directly.
 */
import { MemoryEngine, node, find } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const n = node("text", "T", 0, 0, 0, 0, { text: "hi" });
  r.children.push(n);
  engine.dispatch({ type: "select", ids: [n.id] });

  // Bold toggles fontWeight 400↔700.
  engine.dispatch({ type: "patch", id: n.id, patch: { fontWeight: 700 } });
  t("⌘B makes text bold (weight 700)", find(r, n.id).fontWeight === 700);
  engine.dispatch({ type: "patch", id: n.id, patch: { fontWeight: 400 } });
  t("⌘B again returns to regular (400)", find(r, n.id).fontWeight === 400);

  // Italic toggles fontStyle normal↔italic.
  engine.dispatch({ type: "patch", id: n.id, patch: { fontStyle: "italic" } });
  t("⌘I makes text italic", find(r, n.id).fontStyle === "italic");
  engine.dispatch({ type: "patch", id: n.id, patch: { fontStyle: "normal" } });
  t("⌘I again returns to normal", find(r, n.id).fontStyle === "normal");

  // Underline toggles textDecoration.
  engine.dispatch({ type: "patch", id: n.id, patch: { textDecoration: "underline" } });
  t("⌘U adds underline", find(r, n.id).textDecoration === "underline");
  engine.dispatch({ type: "patch", id: n.id, patch: { textDecoration: "none" } });
  t("⌘U again removes underline", find(r, n.id).textDecoration === "none");
}

{
  // Paragraph spacing is patchable (article paragraph-spacing field).
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const n = node("text", "T", 0, 0, 200, 200, { text: "p1\np2", sizingW: "fixed", sizingH: "fixed" });
  r.children.push(n);
  engine.dispatch({ type: "patch", id: n.id, patch: { paragraphSpacing: 24 } });
  t("paragraph spacing can be set to 24", find(r, n.id).paragraphSpacing === 24);
}

{
  // Text case transforms: uppercase/lowercase/title/none.
  const engine = new MemoryEngine(false);
  const r = engine.snapshot().pages[0].root;
  r.children = [];
  const n = node("text", "T", 0, 0, 0, 0, { text: "hi" });
  r.children.push(n);
  for (const c of ["uppercase", "lowercase", "title", "none"]) {
    engine.dispatch({ type: "patch", id: n.id, patch: { textCase: c } });
    t(`textCase '${c}' stores on node`, find(r, n.id).textCase === c);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
