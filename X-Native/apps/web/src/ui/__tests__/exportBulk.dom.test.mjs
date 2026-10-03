import { mountSurface } from "./domEnv.mjs";

let pass = 0;
let fail = 0;
const t = (name, condition, detail = "") => {
  if (condition) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const ui = await mountSurface("inspector", {
  layer(engine) {
    const add = (kind, name, parent) => {
      engine.dispatch({ type: "add", kind, x: 0, y: 0, w: 120, h: 40, parent, extra: { name } });
      return engine.snapshot().selection[0];
    };
    const configuredFrame = add("frame", "Configured frame");
    engine.dispatch({
      type: "patch",
      id: configuredFrame,
      patch: { exports: [{ format: "PNG", scale: 2, suffix: "@2x" }] },
    });
    const configuredChild = add("rect", "Configured child", configuredFrame);
    engine.dispatch({
      type: "patch",
      id: configuredChild,
      patch: { exports: [{ format: "SVG", scale: 1, suffix: "" }] },
    });
    add("frame", "Not configured");
    return configuredFrame;
  },
  props: { exportOpen: true, onCloseExport: () => {} },
});

const rows = [...ui.document.querySelectorAll(".xmodal[aria-label='Export assets'] .xrow")];
const names = rows.map((row) => row.querySelector(".xrow-name")?.textContent?.trim());
t("bulk modal includes configured frame and configured descendant", names.includes("Configured frame") && names.includes("Configured child"), JSON.stringify(names));
t("bulk modal omits layers without export configurations", !names.includes("Not configured"), JSON.stringify(names));
const frame = rows.find((row) => row.querySelector(".xrow-name")?.textContent?.trim() === "Configured frame");
t("configured rows are selected for bulk export by default", rows.length === 2 && rows.every((row) => row.querySelector('input[type="checkbox"]')?.checked));
t("thumbnail hover reveals the full output filename", frame?.querySelector(".xrow-thumb")?.title === "Configured frame@2x.png", frame?.querySelector(".xrow-thumb")?.title);
t("layer-name hover reveals the same output filename", frame?.querySelector(".xrow-name")?.title === "Configured frame@2x.png", frame?.querySelector(".xrow-name")?.title);

await ui.unmount();
console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\n${pass} passed`);
if (fail) process.exitCode = 1;
