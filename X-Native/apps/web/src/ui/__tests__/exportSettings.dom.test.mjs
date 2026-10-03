import { mountPanel } from "./domEnv.mjs";

let pass = 0;
let fail = 0;
const t = (name, condition) => {
  if (condition) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
};

async function settingsFor(kind) {
  const panel = await mountPanel({
    layer(engine) {
      engine.dispatch({ type: "add", kind, x: 0, y: 0, w: 120, h: 40 });
      const id = engine.snapshot().selection[0];
      engine.dispatch({ type: "patch", id, patch: { exports: [{ format: "PNG", scale: 1, suffix: "" }] } });
      return id;
    },
  });
  const exportHeading = panel.all(".sec-toggle").find((button) => button.textContent.trim() === "Export");
  if (exportHeading?.getAttribute("aria-expanded") !== "true") await panel.click(exportHeading);
  await panel.click(panel.byText("Export settings"));
  const includeBoundingBox = panel.all(".export-settings label.check").find((label) => label.textContent.includes("Include bounding box"));
  return { panel, includeBoundingBox };
}

const rect = await settingsFor("rect");
t("bounding-box control is hidden on non-text layers", !rect.includeBoundingBox);
await rect.panel.unmount();
const text = await settingsFor("text");
t("bounding-box control is available on text layers", !!text.includeBoundingBox);
await text.panel.unmount();

console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
if (fail) process.exitCode = 1;
