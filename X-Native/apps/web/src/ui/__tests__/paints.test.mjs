/** UI parity regression for Figma's Guide to fills: extra strokes can be
 * reordered in the inspector without changing the document/core model. */
import { mountSurface } from "./domEnv.mjs";

let pass = 0;
let fail = 0;
const t = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

const ui = await mountSurface("inspector", {
  layer(engine) {
    engine.dispatch({
      type: "add",
      kind: "rect",
      x: 100,
      y: 100,
      w: 100,
      h: 100,
      extra: { strokePaint: "#111111", strokeWidth: 1, strokeVisible: true },
    });
    const id = engine.snapshot().selection[0];
    engine.dispatch({
      type: "patch",
      id,
      patch: {
        strokes: [
          { color: "#222222", opacity: 1, visible: true, width: 2, align: "center" },
          { color: "#333333", opacity: 1, visible: true, width: 3, align: "center" },
        ],
      },
    });
    return id;
  },
});

const selected = () => ui.engine.snapshot().pages[0].root.children.find((n) => n.id === ui.id);
const colors = () => selected()?.strokes?.map((s) => s.color).join(",");

t("extra stroke rows expose accessible forward/back controls", !!ui.one('[aria-label="Bring stroke 2 forward"]') && !!ui.one('[aria-label="Send stroke 3 backward"]'));
t("bottommost extra stroke cannot move below the base stroke", ui.one('[aria-label="Send stroke 2 backward"]')?.disabled === true);
await ui.click(ui.one('[aria-label="Bring stroke 2 forward"]'));
t("Bring forward reorders the existing extra stroke stack", colors() === "#333333,#222222", colors());
await ui.click(ui.one('[aria-label="Send stroke 3 backward"]'));
t("Send backward restores the original extra stroke order", colors() === "#222222,#333333", colors());

const React = await import("react");
const grip = ui.one('[aria-label="Drag to reorder stroke 2"]');
const strokeRows = ui.all(".stroke-paint-row");
const dragStart = new ui.window.Event("dragstart", { bubbles: true, cancelable: true });
Object.defineProperty(dragStart, "dataTransfer", { value: { effectAllowed: "" } });
await React.act(async () => grip.dispatchEvent(dragStart));
await React.act(async () => strokeRows[1].dispatchEvent(new ui.window.Event("dragover", { bubbles: true, cancelable: true })));
await React.act(async () => strokeRows[1].dispatchEvent(new ui.window.Event("drop", { bubbles: true, cancelable: true })));
t("drag handle moves a stroke to the dropped stack position", colors() === "#333333,#222222", colors());
await ui.unmount();

console.log(`paints UI: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
