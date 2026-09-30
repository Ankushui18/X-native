/**
 * P0-4: the export pathway, and the clipboard flavour it shares with copy.
 *
 * Three claims are pinned here:
 *
 *  1. *File ▸ Export assets…* exists in the chrome's File menu and opens the
 *     one export sheet (the App-owned dialog, asked for by event).
 *  2. With nothing selected the right panel still offers the Export section —
 *     Figma's documented way to export the whole page ("deselect everything").
 *     This is asserted rather than fixed: the reported gap (E-02) was stale.
 *  3. The clipboard SVG flavour (`exportClipSvg`) carries a stroke as geometry
 *     a renderer cannot lose: no degenerate `<clipPath>` for an open path, and
 *     a filled outline for a non-centre stroke, exactly as the file exporter
 *     writes it.
 *
 * Run with:  npx vite-node src/ui/__tests__/exportPathway.dom.test.mjs
 */
import { mountLeftPanel, mountPanel } from "./domEnv.mjs";

let pass = 0;
let fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra === "" ? "" : ` — ${extra}`}`);
  }
};
process.on("exit", () => {
  console.log(fail ? `\n${fail} FAILING (${pass} passed)` : `\nexport pathway: ${pass} passed, 0 failed`);
});

/* ── 1. the File menu row ─────────────────────────────────────────────────── */

console.log("1 · File ▸ Export assets…");
{
  const heard = [];
  const onExport = () => heard.push("asked");
  // Mounting the surface installs the DOM this suite runs in, so everything
  // that needs `window` — the event spy, the modules the panel imports — comes
  // after it.
  const panel = await mountLeftPanel();
  const { escapeStack } = await import("../escape.ts");
  const { MemoryEngine, find, node } = await import("../../engine/memory.ts");
  const { exportClipSvg, exportSvg } = await import("../../engine/svgExport.ts");
  window.addEventListener("x-native-export-dialog", onExport);
  const trigger = panel.one('button[aria-label="File menu"]');
  await panel.click(trigger);
  const rows = panel.all('[role="menuitem"]');
  t("the File menu lists three rows", rows.length === 3, rows.map((r) => r.textContent.trim()).join(" | "));
  const row = rows.find((r) => (r.textContent || "").includes("Export assets"));
  t("...one of them is Export assets…", !!row, rows.map((r) => r.textContent.trim()).join(" | "));
  t("...advertising ⇧⌘E", (row?.textContent || "").includes("⇧⌘E"), row?.textContent);
  await panel.click(row);
  t("clicking it asks for the export sheet", heard.length === 1, JSON.stringify(heard));
  t("...and closes the menu", !panel.one('[role="menu"]'));
  t("...leaving no overlay registered behind it", !escapeStack().includes("file-menu"), JSON.stringify(escapeStack()));
  window.removeEventListener("x-native-export-dialog", onExport);
  await panel.unmount();
  globalThis.__exports = { MemoryEngine, find, node, exportClipSvg, exportSvg };
}

/* ── 2. the Export section with nothing selected ──────────────────────────── */

console.log("2 · nothing selected = the page can still be exported");
{
  const panel = await mountPanel({ layer: "empty" });
  const titles = panel.all(".sec-toggle h2").map((el) => (el.textContent || "").trim());
  const hasExport = titles.some((x) => x === "Export");
  t("the right panel shows an Export section", hasExport, titles.join(" | "));
  t("...and no layer sections", titles.every((x) => x !== "Fill" && x !== "Stroke"), titles.join(" | "));
  t("the section offers the whole-page sheet", !!panel.byText("All…"), titles.join(" | "));
  await panel.unmount();
}

/* ── 3. the clipboard flavour ─────────────────────────────────────────────── */

const { MemoryEngine, find, node, exportClipSvg, exportSvg } = globalThis.__exports;

console.log("3 · exportClipSvg: strokes leave as geometry, not as a clip");

// A two-point pen segment, as P0-3 creates it: open, centre, round-capped.
const pen = node("vector", "Pen segment", 0, 0, 100, 1, {
  path: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  closed: false,
  strokeVisible: true,
  strokeWidth: 2,
  strokePaint: "#1e1e1e",
  strokeCap: "round",
  strokeAlign: "center",
});
const penSvg = exportClipSvg([pen]);
t("the pen stroke is in the file", /stroke="#1e1e1e"/.test(penSvg), penSvg);
t("...at its own width, not a doubled one", /stroke-width="2"/.test(penSvg), penSvg);
t("...and nothing clips it", !/clipPath/.test(penSvg), penSvg);
t("...with the round cap the pen set", /stroke-linecap="round"/.test(penSvg), penSvg);

// An old document: the same open path, stored "inside". The guard has to hold
// at export time too, and it has to hold *as centre* — otherwise the path is
// outlined as if it had an inside to clip, and a copy of an old file stops
// looking like a copy of a new one.
const legacy = { ...pen, strokeAlign: "inside" };
const legacySvg = exportClipSvg([legacy]);
t("an open path stored inside exports exactly like a centre one", legacySvg === penSvg, legacySvg);
t("...so the stroke leaves as a stroke, not an outline", /stroke="#1e1e1e"/.test(legacySvg) && !/fill="#1e1e1e"/.test(legacySvg), legacySvg);
t("...and nothing clips it", !/clipPath/.test(legacySvg), legacySvg);
{
  const preset = { format: "SVG", scale: 1, suffix: "" };
  t("the file exporter agrees about the same document",
    exportSvg(legacy, preset) === exportSvg(pen, preset),
    exportSvg(legacy, preset));
}

// A closed shape's inside stroke has a region to clip to, so the clipboard
// flavour writes it the way the file exporter does: a filled outline.
const box = node("rect", "Box", 0, 0, 100, 100, {
  fill: "#d9d9d9",
  fillVisible: true,
  strokeVisible: true,
  strokeWidth: 4,
  strokePaint: "#1e1e1e",
  strokeAlign: "inside",
});
const boxSvg = exportClipSvg([box]);
t("a closed inside stroke exports as a filled outline", /<path d="[^"]+" fill="#1e1e1e" fill-opacity="1" stroke="none"\/>/.test(boxSvg), boxSvg);
t("...which needs no clip either", !/clipPath/.test(boxSvg), boxSvg);

// The clipboard flavour and the file exporter agree about the shape of a
// stroke, so a copy and an export of one layer cannot drift apart.
const fileSvg = exportSvg(box, { format: "SVG", scale: 1, suffix: "" });
t("the file exporter writes the same filled-outline form", !/clipPath/.test(fileSvg) && /stroke="none"/.test(fileSvg), fileSvg);

/* ── 4. page export carries every top-level layer ─────────────────────────── */

console.log("4 · a page export is the whole page");
{
  const engine = new MemoryEngine(false);
  const root = () => engine.snapshot().pages[engine.snapshot().page].root;
  // A fresh engine seeds a starter document; the page export is about *this*
  // page's layers, so clear it first.
  const kids = root().children.map((n) => n.id);
  engine.dispatch({ type: "select", ids: kids });
  engine.dispatch({ type: "delete" });
  engine.dispatch({ type: "add", kind: "rect", x: 0, y: 0, w: 40, h: 40 });
  engine.dispatch({ type: "add", kind: "ellipse", x: 80, y: 0, w: 40, h: 40 });
  engine.dispatch({ type: "setTool", tool: "pen" });
  engine.dispatch({ type: "addPath", points: [{ x: 0, y: 80 }, { x: 60, y: 80 }], closed: false });
  const svg = exportSvg(root(), { format: "SVG", scale: 1, suffix: "" }, { page: true });

  // One translated group per top-level layer: the page export is not a
  // selection, so nothing may be skipped.
  const groups = (svg.match(/<g transform="translate\(/g) ?? []).length;
  t("all three top-level layers are in the page export", groups === 3, `${groups} groups`);
  // The pen path's box is its own 60x1 segment, so the content box is 120x81.
  t("...cropped to their content box", svg.includes('viewBox="0 0 120 81"'), svg.slice(0, 120));
  t("...including the unclosed pen path's stroke", /stroke="#1e1e1e"/.test(svg), "no pen stroke");
  t("...which is not clipped", !/clipPath/.test(svg.slice(svg.indexOf("translate(0 80)"))), "pen group clipped");
  t("...and the export is a real svg document", svg.startsWith("<svg xmlns=") && svg.endsWith("</svg>"), svg.slice(0, 60));
}
