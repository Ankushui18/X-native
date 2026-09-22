// Behaviour suite: drives the running app and asserts on engine state / DOM,
// not on source. Re-created after the original /tmp harness was lost.
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Point CHROMIUM_PATH / CHROMIUM_LIBS at a local Chromium (e.g. the binary that
// ships inside @sparticuz/chromium) to run this suite.
const LAUNCH = {
  executablePath: process.env.CHROMIUM_PATH || "/tmp/shot/bin/chromium",
  env: { ...process.env, LD_LIBRARY_PATH: process.env.CHROMIUM_LIBS || "/tmp/shot/ext/lib/lib" },
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
         "--use-gl=swiftshader", "--in-process-gpu", "--disable-software-rasterizer"],
};
const URL = process.env.APP_URL || "http://localhost:5173";
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const b = await puppeteer.launch(LAUNCH);
const allErrors = [];

async function page(fresh = true) {
  const p = await b.newPage();
  await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  p.on("pageerror", e => allErrors.push(e.message));
  if (fresh) {
    // Wipe the document before the app script ever runs: loading it first would
    // let autosave immediately rewrite whatever a previous check left behind.
    await p.goto(`${URL}/favicon.ico`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await p.evaluate(() => { try { localStorage.removeItem("x-native-document"); } catch {} });
  }
  await p.goto(URL, { waitUntil: "networkidle0" });
  await sleep(450);
  return p;
}
const rows = (p) => p.evaluate(() => [...document.querySelectorAll(".panel.left .row")].map(r => r.textContent.trim()));
const drawRect = async (p, x = 820, y = 640) => {
  await p.keyboard.press("r");
  await p.mouse.move(x, y); await p.mouse.down();
  await p.mouse.move(x + 140, y + 100, { steps: 6 }); await p.mouse.up();
  await sleep(400);
};

// 1. rename ---------------------------------------------------------------
{
  const p = await page();
  const i = (await rows(p)).indexOf("Chip");
  const rs = await p.$$(".panel.left .row");
  await rs[i].click(); await sleep(400);
  await p.keyboard.down("Meta"); await p.keyboard.press("r"); await p.keyboard.up("Meta");
  await sleep(600);
  const opened = await p.evaluate(k => !!document.querySelectorAll(".panel.left .row")[k].querySelector("input"), i);
  t("\u2318R opens rename on the selected layer", opened);
  if (opened) {
    await p.evaluate(k => { const el = document.querySelectorAll(".panel.left .row")[k].querySelector("input"); el.focus(); el.select(); }, i);
    await p.keyboard.type("Renamed"); await p.keyboard.press("Enter"); await sleep(500);
    t("rename commits to the document", (await rows(p))[i] === "Renamed");
  } else fail++;
  // real double-click must open it too (draggable used to suppress dblclick)
  const j = (await rows(p)).indexOf("Label");
  const rs2 = await p.$$(".panel.left .row");
  const box = await rs2[j].boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down(); await p.mouse.up(); await sleep(80);
  await p.mouse.down(); await p.mouse.up(); await sleep(600);
  t("double-click a layer row opens rename",
    await p.evaluate(k => !!document.querySelectorAll(".panel.left .row")[k].querySelector("input"), j));
  await p.close();
}

// 2. comments -------------------------------------------------------------
{
  const p = await page();
  const before = (await rows(p)).length;
  await p.keyboard.press("c"); await sleep(300);
  await p.mouse.click(1080, 600); await sleep(450);
  await p.keyboard.type("Spacing looks off here"); await p.keyboard.press("Enter"); await sleep(600);
  const label = await p.evaluate(() => document.querySelector(".cm-pin")?.getAttribute("aria-label") || "");
  t(`comment keeps every typed character -> ${JSON.stringify(label)}`, label === "Comment: Spacing looks off here");
  t("comment creates a pin", await p.evaluate(() => document.querySelectorAll(".cm-pin").length) === 1);
  t("comment does not create a layer", (await rows(p)).length === before);
  // pin must follow a space-drag pan
  const x0 = await p.evaluate(() => document.querySelector(".cm-pin").getBoundingClientRect().left);
  await p.mouse.move(700, 500);
  await p.keyboard.down("Space"); await sleep(140);
  await p.mouse.down(); await p.mouse.move(500, 420, { steps: 8 }); await p.mouse.up();
  await p.keyboard.up("Space"); await sleep(400);
  const x1 = await p.evaluate(() => document.querySelector(".cm-pin").getBoundingClientRect().left);
  t(`comment pin follows a space-drag pan (${Math.round(x0)}->${Math.round(x1)})`, Math.abs((x0 - 200) - x1) < 3);
  t("space-drag does not open a stray comment", await p.evaluate(() => document.querySelectorAll(".cm-input").length) === 0);
  // comments must not sit on the design undo stack
  await p.keyboard.down("Meta"); await p.keyboard.press("z"); await p.keyboard.up("Meta"); await sleep(500);
  t("undo does not delete a comment", await p.evaluate(() => document.querySelectorAll(".cm-pin").length) === 1);
  await p.close();
}

// 3. persistence ----------------------------------------------------------
{
  const p = await page();
  await drawRect(p);
  await p.keyboard.press("c"); await sleep(250);
  await p.mouse.click(1080, 600); await sleep(400);
  await p.keyboard.type("Persisted note"); await p.keyboard.press("Enter");
  await sleep(1300);
  const before = await rows(p);
  await p.reload({ waitUntil: "networkidle0" }); await sleep(900);
  t("document survives a reload", JSON.stringify(before) === JSON.stringify(await rows(p)));
  const pins = await p.evaluate(() => [...document.querySelectorAll(".cm-pin")].map(e => e.getAttribute("aria-label")));
  t("comments survive a reload", pins.includes("Comment: Persisted note"));
  await p.close();
}

// 4. corrupt / hostile saved state ---------------------------------------
for (const [label, payload] of [
  ["garbage", "not json at all"],
  ["truncated", '{"version":1,"pages":['],
  ["null", "null"],
  ["empty pages", '{"version":1,"fileName":"x","pages":[],"components":[]}'],
  ["rootless page", '{"version":1,"fileName":"x","pages":[{"name":"p"}],"components":[]}'],
  ["future version", '{"version":99,"fileName":"x","pages":[{"name":"p","root":{"children":[]}}],"components":[]}'],
  ["absurd zoom", '{"version":1,"fileName":"x","pages":[{"name":"p","root":{"children":[]}}],"components":[],"zoom":1e9}'],
]) {
  const p = await b.newPage();
  await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.evaluateOnNewDocument(v => { try { localStorage.setItem("x-native-document", v); } catch {} }, payload);
  await p.goto(URL, { waitUntil: "networkidle0" }); await sleep(700);
  const n = await p.evaluate(() => document.querySelectorAll(".panel.left .row").length);
  t(`corrupt save (${label}) boots a clean document`, n > 0 && errs.length === 0);
  if (label === "garbage") {
    const toast = await p.evaluate(() => document.querySelector(".toast")?.textContent || "");
    t("corrupt save warns the user", toast.includes("could not be read"));
  }
  // These pages seed storage on every navigation and share the origin with
  // later checks; wipe it so nothing inherits a deliberately broken document.
  await p.evaluate(() => { try { localStorage.removeItem("x-native-document"); } catch {} });
  await p.close();
}

// 5. autosave is debounced -----------------------------------------------
{
  const p = await page();
  await drawRect(p);
  await sleep(900);
  await p.evaluate(() => {
    window.__w = 0;
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === "x-native-document") window.__w++; return real.call(this, k, v); };
  });
  for (let i = 0; i < 25; i++) { await p.keyboard.press("ArrowRight"); await sleep(25); }
  await sleep(1200);
  const w = await p.evaluate(() => window.__w);
  t(`25-nudge burst collapses to one write (got ${w})`, w === 1);
  await p.close();
}

// 6. New file -------------------------------------------------------------
{
  const p = await page();
  // page() clears storage, but reset it explicitly so `base` is unambiguously
  // the document New file should restore.
  await p.evaluate(() => { try { localStorage.removeItem("x-native-document"); } catch {} });
  await p.reload({ waitUntil: "networkidle0" }); await sleep(600);
  const base = (await rows(p)).length;
  await drawRect(p); await sleep(1200);
  const edited = (await rows(p)).length;
  t("drawing adds a layer", edited === base + 1);
  let accepting = false;
  p.on("dialog", async d => { accepting ? await d.accept() : await d.dismiss(); });
  const run = async (accept) => {
    accepting = accept;
    await p.keyboard.down("Meta"); await p.keyboard.press("k"); await p.keyboard.up("Meta"); await sleep(450);
    await p.keyboard.type("New file"); await sleep(450);
    await p.evaluate(() => {
      const el = [...document.querySelectorAll(".actions button,.palette button,[role=option],.act-row")]
        .find(r => r.textContent.trim().startsWith("New file"));
      el && el.click();
    });
    await sleep(accept ? 2500 : 900);
    // Cancelling leaves the palette open; close it so the next run starts clean.
    if (!accept) { await p.keyboard.press("Escape"); await sleep(400); }
  };
  await run(false);
  t("cancelling New file keeps the document", (await rows(p)).length === edited);
  await run(true);
  const after = (await rows(p)).length;
  const cleared = await p.evaluate(() => !localStorage.getItem("x-native-document"));
  t(`New file resets to a blank document (${edited}->${after}, base ${base})`,
    after === base && after < edited && cleared);
  await p.close();
}

// 7. undo coalescing on a real field -------------------------------------
{
  const p = await page();
  await drawRect(p);
  const rotVal = () => p.evaluate(() => document.querySelectorAll(".inspector .field input")[2]?.value);
  await p.evaluate(() => { const el = document.querySelectorAll(".inspector .field input")[2]; el.focus(); el.select(); });
  await p.keyboard.type("45"); await p.keyboard.press("Enter"); await sleep(500);
  t(`typed rotation applies (${await rotVal()})`, String(await rotVal()).startsWith("45"));
  await p.keyboard.down("Meta"); await p.keyboard.press("z"); await p.keyboard.up("Meta"); await sleep(600);
  t(`one undo clears the whole typed value (${await rotVal()})`, String(await rotVal()) === "0");
  await p.close();
}

// 8. clipboard ------------------------------------------------------------
{
  const p = await page();
  const i = (await rows(p)).indexOf("Chip");
  const rs = await p.$$(".panel.left .row");
  await rs[i].click(); await sleep(400);
  const errsBefore = allErrors.length;
  await p.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find(x => /copy as code/i.test(x.textContent || ""));
    if (el) el.click();
  });
  await sleep(800);
  t("Copy as code raises no unhandled rejection", allErrors.length === errsBefore);
  await p.close();
}

// 9. export: PDF must be a real PDF, not an SVG with the extension swapped ---
{
  const p = await page();
  await p.evaluate(() => {
    window.__dl = [];
    const real = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const rec = { type: blob.type, size: blob.size };
      window.__dl.push(rec);
      blob.arrayBuffer().then((b) => { rec.head = new TextDecoder().decode(new Uint8Array(b).slice(0, 5)); });
      return real(blob);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const d = window.__dl[window.__dl.length - 1];
      if (this.download && d) d.name = this.download;
      return click.call(this);
    };
  });
  const rs = await p.$$(".panel.left .row");
  await rs[2].click(); await sleep(450);
  // Export now starts folded, so open it before reaching for its "+".
  await p.evaluate(() => {
    const b = [...document.querySelectorAll(".sec-toggle")].find(x => x.textContent.trim() === "Export");
    if (b && b.getAttribute("aria-expanded") === "false") b.click();
  });
  await sleep(350);
  await p.evaluate(() => document.querySelector('button.plus[title="Add export"]').click());
  await sleep(450);
  for (let i = 0; i < 3; i++) {
    await p.evaluate(() => document.querySelector('button.fmt[title="Format"]').click());
    await sleep(200);
  }
  t("export format cycles to PDF",
    (await p.evaluate(() => document.querySelector('button.fmt[title="Format"]').textContent.trim())) === "PDF");
  await p.evaluate(() => document.querySelector("button.export-run").click());
  await sleep(2500);
  const dl = (await p.evaluate(() => window.__dl))[0] || {};
  t(`PDF export has a .pdf name (${dl.name})`, /\.pdf$/i.test(dl.name || ""));
  t(`PDF export has the PDF mime (${dl.type})`, dl.type === "application/pdf");
  t(`PDF export starts with %PDF (${dl.head})`, dl.head === "%PDF-");
  await p.close();
}

// 10. Vars "+" must do something visible ----------------------------------
{
  const p = await page();
  const openVars = async () => {
    await p.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find(x => (x.getAttribute("aria-label") || x.textContent).trim() === "Vars");
      b.click();
    });
    await sleep(550);
  };
  await openVars();
  await (await p.$('.panel.left button.plus[title*="Copy"]')).click();
  await sleep(800);
  t("Vars + with no selection explains itself",
    /select a layer/i.test(await p.evaluate(() => document.querySelector(".toast")?.textContent || "")));
  await p.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find(x => (x.getAttribute("aria-label") || x.textContent).trim() === "File");
    b.click();
  });
  await sleep(450);
  const rs = await p.$$(".panel.left .row");
  await rs[6].click(); await sleep(400);
  await openVars();
  await (await p.$('.panel.left button.plus[title*="Copy"]')).click();
  await sleep(900);
  t("Vars + copies the selected layer's colour",
    /^Copied #/.test(await p.evaluate(() => document.querySelector(".toast")?.textContent || "")));
  await p.close();
}

// 11. Agent pane actually mutates the document ----------------------------
{
  const p = await page();
  await p.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find(x => (x.getAttribute("aria-label") || x.textContent).trim() === "Agent");
    b.click();
  });
  await sleep(550);
  const inp = await p.$(".panel.left .search input");
  await inp.click();
  await p.keyboard.type("add a frame");
  await p.keyboard.press("Enter");
  await sleep(900);
  await p.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find(x => (x.getAttribute("aria-label") || x.textContent).trim() === "File");
    b.click();
  });
  await sleep(550);
  t("Agent request creates the layer it promises",
    (await rows(p)).some(r => /Agent frame/.test(r)));
  await p.close();
}

// 12. inspector sections fold away without hiding anything ----------------
{
  const p = await page();
  await p.evaluate(() => { try { localStorage.removeItem("x-native-inspector-sections"); } catch {} });
  await p.reload({ waitUntil: "networkidle0" });
  await sleep(600);
  const names = await rows(p);
  const rs = await p.$$(".panel.left .row");
  await rs[names.indexOf("Title")].click();
  await sleep(650);
  const read = () => p.evaluate(() => {
    const i = document.querySelector(".inspector");
    return {
      sh: i.scrollHeight, ch: i.clientHeight,
      toggles: [...i.querySelectorAll(".sec-toggle")].map(b => b.textContent.trim()),
      controls: i.querySelectorAll("button,select,input").length,
    };
  });
  const base = await read();
  t(`every inspector section is collapsible (${base.toggles.length})`, base.toggles.length === 8);
  const click = async (nm) => {
    await p.evaluate((n) => {
      const b = [...document.querySelectorAll(".sec-toggle")].find(x => x.textContent.trim() === n);
      b && b.click();
    }, nm);
    await sleep(200);
  };
  for (const nm of base.toggles) await click(nm);
  const closed = await read();
  t(`collapsing removes the overflow (${(base.sh / base.ch).toFixed(2)}x -> ${(closed.sh / closed.ch).toFixed(2)}x)`,
    closed.sh <= closed.ch && closed.sh < base.sh);
  for (const nm of base.toggles) await click(nm);
  const back = await read();
  t(`reopening restores every control (${back.controls}/${base.controls})`, back.controls === base.controls);
  // the choice must survive a reload, or it is noise rather than a preference
  await click("Typography");
  await p.reload({ waitUntil: "networkidle0" });
  await sleep(700);
  const rs2 = await p.$$(".panel.left .row");
  await rs2[names.indexOf("Title")].click();
  await sleep(650);
  const kept = await p.evaluate(() => {
    const b = [...document.querySelectorAll(".sec-toggle")].find(x => x.textContent.trim() === "Typography");
    return b ? b.getAttribute("aria-expanded") : "missing";
  });
  t(`a folded section stays folded across a reload (${kept})`, kept === "false");
  await p.close();
}

// 13. SVG import produces editable layers, not a flat image ---------------
{
  const p = await page();
  const drop = (svg, name) => p.evaluate((s, n) => {
    const dt = new DataTransfer();
    dt.items.add(new File([s], n, { type: "image/svg+xml" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 450 }));
  }, svg, name);

  const before = (await rows(p)).length;
  await drop(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">
    <rect x="10" y="10" width="80" height="50" fill="#ff0000"/>
    <circle cx="150" cy="40" r="30" fill="#00ff00"/>
    <text x="20" y="100" font-size="16" fill="#0000ff">Hello</text></svg>`, "logo.svg");
  await sleep(1400);
  const after = await rows(p);
  t(`SVG becomes one layer per shape (${before} -> ${after.length})`, after.length === before + 3);
  t("SVG text arrives as a text layer", after.includes("Hello"));
  t("SVG circle arrives as an ellipse", after.includes("Ellipse"));

  // the fill has to actually render, not just exist in the model
  const red = await p.evaluate(() => {
    const c = document.querySelector("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60 && d[i + 3] > 200) n++;
    }
    return n;
  });
  t(`imported fill renders on canvas (${red}px red)`, red > 200);

  // one undo must remove the whole file, not one shape
  await p.keyboard.down("Meta"); await p.keyboard.press("z"); await p.keyboard.up("Meta");
  await sleep(700);
  t(`one undo removes the whole import (${(await rows(p)).length})`, (await rows(p)).length === before);
  await p.close();
}
{
  const p = await page();
  const before = (await rows(p)).length;
  // groups with transforms, paths and polygons
  await p.evaluate(() => {
    const s = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
      <g transform="translate(50,20)" fill="#00aa00">
        <rect x="0" y="0" width="40" height="40"/><circle cx="80" cy="20" r="15"/></g>
      <path d="M10 150 L60 120 L110 150 Z" fill="#884400"/>
      <polygon points="200,20 240,60 200,100 160,60" fill="#0088ff"/></svg>`;
    const dt = new DataTransfer();
    dt.items.add(new File([s], "b.svg", { type: "image/svg+xml" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 450 }));
  });
  await sleep(1400);
  const after = await rows(p);
  t(`nested groups, paths and polygons all import (${before} -> ${after.length})`, after.length === before + 4);
  t("path imports as a vector layer", after.includes("Path"));
  await p.close();
}
{
  // a malformed file must not break the app
  const p = await page();
  const before = (await rows(p)).length;
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["<svg><broken"], "bad.svg", { type: "image/svg+xml" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 450 }));
  });
  await sleep(1000);
  const toast = await p.evaluate(() => document.querySelector(".toast")?.textContent || "");
  t(`malformed SVG is reported, not crashed (${JSON.stringify(toast)})`,
    (await rows(p)).length === before && /could not read|nothing importable/i.test(toast));
  await p.close();
}

// 14. Sketch import: a .sketch file opens as editable layers ---------------
{
  const p = await page();
  const b64 = fs.readFileSync(path.join(HERE, "fixtures", "sample.sketch")).toString("base64");
  const dropSketch = (name) => p.evaluate((data, n) => {
    const bin = atob(data);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], n, { type: "" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 450 }));
  }, b64, name);

  const before = (await rows(p)).length;
  await dropSketch("design.sketch");
  await sleep(2000);
  const after = await rows(p);
  t(`.sketch opens as layers (${before} -> ${after.length})`, after.length === before + 5);
  t("artboard, shapes and text all arrive",
    ["Home", "Card", "Dot", "Label", "Inner"].every((n) => after.includes(n)));

  // geometry and style must survive the round trip, not just the names
  const names = await rows(p);
  const rs = await p.$$(".panel.left .row");
  await rs[names.indexOf("Card")].click();
  await sleep(650);
  const f = await p.evaluate(() =>
    [...document.querySelectorAll(".inspector .field input")].map((i) => i.value).slice(0, 8));
  t(`Card keeps its 120x60 size (${f[3]}x${f[4]})`, f[3] === "120" && f[4] === "60");
  t(`Card keeps corner radius 8 and stroke 2 (r${f[6]} s${f[7]})`, f[6] === "8" && f[7] === "2");

  // and it has to actually render
  const px = await p.evaluate(() => {
    const c = document.querySelector("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let red = 0, green = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 70 && d[i + 2] < 70 && d[i + 3] > 200) red++;
      if (d[i] < 80 && d[i + 1] > 150 && d[i + 2] < 80 && d[i + 3] > 200) green++;
    }
    return { red, green };
  });
  t(`imported Sketch fills render (${px.red}px red, ${px.green}px green)`, px.red > 500 && px.green > 200);

  await p.keyboard.down("Meta"); await p.keyboard.press("z"); await p.keyboard.up("Meta");
  await sleep(800);
  t(`one undo removes the whole .sketch import (${(await rows(p)).length})`, (await rows(p)).length === before);
  await p.close();
}
{
  // a non-ZIP file named .sketch must report, not crash
  const p = await page();
  const before = (await rows(p)).length;
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["definitely not a zip"], "broken.sketch", { type: "" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 450 }));
  });
  await sleep(1200);
  const toast = await p.evaluate(() => document.querySelector(".toast")?.textContent || "");
  t(`a corrupt .sketch is reported (${JSON.stringify(toast.slice(0, 48))})`,
    (await rows(p)).length === before && /could not read/i.test(toast));
  await p.close();
}

// 15. .fig import: Figma binary opens as editable layers -------------------
{
  const p = await page();
  const b64 = fs.readFileSync(path.join(HERE, "fixtures", "sample.fig")).toString("base64");
  const before = (await rows(p)).length;
  await p.evaluate((data) => {
    const bin = atob(data);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], "design.fig", { type: "" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 450 }));
  }, b64);
  await sleep(2200);
  const after = await rows(p);
  t(`.fig opens as layers (${before} -> ${after.length})`, after.length === before + 4);
  t("frame, rect, ellipse and text all arrive",
    ["Home", "FigCard", "FigDot", "FigLabel"].every((n) => after.includes(n)));

  const rs = await p.$$(".panel.left .row");
  await rs[after.indexOf("FigCard")].click();
  await sleep(650);
  const f = await p.evaluate(() =>
    [...document.querySelectorAll(".inspector .field input")].map((i) => i.value).slice(0, 8));
  t(`.fig keeps exact geometry (${f[3]}x${f[4]})`, f[3] === "120" && f[4] === "60");
  t(`.fig keeps radius 8 and stroke 2 (r${f[6]} s${f[7]})`, f[6] === "8" && f[7] === "2");

  const px = await p.evaluate(() => {
    const c = document.querySelector("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let red = 0, green = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] < 70 && d[i + 2] < 70 && d[i + 3] > 200) red++;
      if (d[i] < 80 && d[i + 1] > 150 && d[i + 2] < 80 && d[i + 3] > 200) green++;
    }
    return { red, green };
  });
  t(`.fig fills render (${px.red}px red, ${px.green}px green)`, px.red > 500 && px.green > 200);

  await p.keyboard.down("Meta"); await p.keyboard.press("z"); await p.keyboard.up("Meta");
  await sleep(800);
  t(`one undo removes the whole .fig import (${(await rows(p)).length})`, (await rows(p)).length === before);
  await p.close();
}
{
  // a .fig that is not a ZIP, and a ZIP with no canvas.fig, must both report
  const p = await page();
  const before = (await rows(p)).length;
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["nope"], "broken.fig", { type: "" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 700, clientY: 450 }));
  });
  await sleep(1200);
  const toast = await p.evaluate(() => document.querySelector(".toast")?.textContent || "");
  t(`a corrupt .fig is reported (${JSON.stringify(toast.slice(0, 44))})`,
    (await rows(p)).length === before && /could not read/i.test(toast));
  await p.close();
}

// 16. multiple strokes per layer -------------------------------------------
{
  const p = await page();
  // thick red base stroke (inside) so a second stroke can sit beside it
  await p.evaluate(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="160">
      <rect x="30" y="30" width="160" height="100" fill="#dddddd" stroke="#ff0000" stroke-width="10"/></svg>`;
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "a.svg", { type: "image/svg+xml" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 800, clientY: 520 }));
  });
  await sleep(1400);
  const openStroke = async () => {
    await p.evaluate(() => {
      const t = [...document.querySelectorAll(".sec-toggle")].find(x => x.textContent.trim() === "Stroke");
      if (t && t.getAttribute("aria-expanded") === "false") t.click();
    });
    await sleep(400);
  };
  const px = () => p.evaluate(() => {
    const c = document.querySelector("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0, grey = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] < 80 && d[i + 2] < 80 && d[i + 3] > 200) red++;
      if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] > 180 && d[i + 3] > 200) blue++;
      if (Math.abs(d[i] - 221) < 12 && Math.abs(d[i + 1] - 221) < 12 && d[i + 3] > 200) grey++;
    }
    return { red, blue, grey };
  });
  const before = await px();
  t(`base stroke renders (${before.red}px red)`, before.red > 500);

  await openStroke();
  await p.evaluate(() => {
    const el = [...document.querySelectorAll(".inspector button.plus")].find(b => b.getAttribute("title") === "Add stroke");
    el && el.click();
  });
  await sleep(800);
  const widths = await p.$$('.inspector input[aria-label*="Stroke 2 width"]');
  t("a second stroke gets its own width control", widths.length === 1);

  await widths[0].click();
  await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
  await p.keyboard.type("4"); await p.keyboard.press("Enter");
  await sleep(600);
  await p.evaluate(() => {
    const bs = [...document.querySelectorAll('.inspector button[title="outside"]')];
    bs[bs.length - 1]?.click();
  });
  await sleep(600);
  const hexes = await p.$$(".inspector .color-row input");
  let target = null;
  for (const h of hexes) {
    const v = await p.evaluate(e => e.value, h);
    if (/^[0-9a-fA-F]{6}$/.test(v)) target = h;
  }
  await target.click({ clickCount: 3 });
  await p.keyboard.type("0000ff"); await p.keyboard.press("Enter");
  await sleep(900);

  const after = await px();
  // The point of the feature: both outlines and the fill coexist. An outside
  // stroke must not erase what is already painted inside the shape.
  t(`both strokes and the fill render together (red ${after.red}, blue ${after.blue}, fill ${after.grey})`,
    after.red > 300 && after.blue > 200 && after.grey > 1000);

  await p.keyboard.down("Meta"); await p.keyboard.press("z"); await p.keyboard.up("Meta");
  await sleep(700);
  t("undo steps back through the stroke stack", (await px()).blue < after.blue);
  await p.close();
}

// 17. shared styles: one edit repaints every bound layer -------------------
{
  const p = await page();
  let reply = "Brand";
  const onDialog = async (d) => { await d.accept(reply); };
  p.on("dialog", onDialog);
  await p.evaluate(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="140">
      <rect x="10" y="20" width="110" height="90" fill="#ff0000"/>
      <rect x="160" y="20" width="110" height="90" fill="#ff0000"/></svg>`;
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "a.svg", { type: "image/svg+xml" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 800, clientY: 520 }));
  });
  await sleep(1400);
  const px = () => p.evaluate(() => {
    const c = document.querySelector("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] < 80 && d[i + 2] < 80 && d[i + 3] > 200) red++;
      if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] > 180 && d[i + 3] > 200) blue++;
    }
    return { red, blue };
  });
  const openVars = async () => {
    await p.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find(x => (x.getAttribute("aria-label") || x.textContent).trim() === "Vars");
      b.click();
    });
    await sleep(500);
  };
  const openFile = async () => {
    await p.evaluate(() => {
      const b = [...document.querySelectorAll("button")]
        .find(x => (x.getAttribute("aria-label") || x.textContent).trim() === "File");
      b.click();
    });
    await sleep(500);
  };

  const names = await rows(p);
  const idx = names.map((n, i) => [n, i]).filter(([n]) => n === "Rectangle").map(([, i]) => i);
  let rs = await p.$$(".panel.left .row");
  await rs[idx[0]].click(); await sleep(500);
  await openVars();
  await p.evaluate(() => {
    const el = [...document.querySelectorAll(".panel.left button.plus")]
      .find(b => b.getAttribute("title") === "Create style from selection");
    el && el.click();
  });
  await sleep(900);
  t("creating a style lists it", (await p.evaluate(() =>
    document.querySelectorAll('.panel.left button[aria-label^="Apply style"]').length)) === 1);

  await openFile();
  rs = await p.$$(".panel.left .row");
  await rs[idx[1]].click(); await sleep(500);
  await openVars();
  await p.evaluate(() => {
    const el = document.querySelector('.panel.left button[aria-label^="Apply style"]');
    el && el.click();
  });
  await sleep(800);

  reply = "#0000ff";
  await p.evaluate(() => {
    const el = document.querySelector('.panel.left button[aria-label^="Edit style"]');
    el && el.click();
  });
  await sleep(1000);
  const after = await px();
  t(`one style edit repaints every bound layer (red ${after.red}, blue ${after.blue})`,
    after.blue > 1000 && after.red < 200);

  // styles and their bindings are part of the document, so they must persist
  await sleep(1300);
  await p.reload({ waitUntil: "networkidle0" });
  await sleep(1200);
  const kept = await px();
  t(`styles survive a reload (blue ${kept.blue})`, kept.blue > 1000);
  await openVars();
  t("the style list survives a reload", (await p.evaluate(() =>
    document.querySelectorAll('.panel.left button[aria-label^="Apply style"]').length)) === 1);
  p.off("dialog", onDialog);
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log("page errors:", allErrors.length ? allErrors.slice(0, 5) : "none");
await b.close();
process.exit(fail ? 1 : 0);
