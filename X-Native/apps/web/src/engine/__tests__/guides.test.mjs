/**
 * Rulers & guides (360040449713):
 *   ⇧R toggles rulers; addGuide creates a horizontal or vertical guide;
 *   removeGuide deletes a selected guide.
 */
import { MemoryEngine } from "../../engine/memory.ts";

let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

{
  const engine = new MemoryEngine(false);
  engine.dispatch({ type: "addGuide", axis: "v", at: 200 });
  const snap = engine.snapshot();
  t("addGuide creates a vertical guide at x=200", snap.pages[0].guides.some(g => g.axis === "v" && g.at === 200));
  const gid = snap.pages[0].guides[0].id;
  engine.dispatch({ type: "select", ids: [] });
  engine.dispatch({ type: "selectGuide", id: gid });
  t("selectGuide selects the guide", engine.snapshot().selectedGuide === gid);
  engine.dispatch({ type: "removeGuide", id: gid });
  t("removeGuide removes the guide", engine.snapshot().pages[0].guides.length === 0);
}

{
  const engine = new MemoryEngine(false);
  engine.dispatch({ type: "toggleRulers" });
  t("toggleRulers enables rulers", engine.snapshot().showRulers === true);
  engine.dispatch({ type: "toggleRulers" });
  t("toggleRulers disables rulers", engine.snapshot().showRulers === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
