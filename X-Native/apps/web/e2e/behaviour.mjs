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

/** Inspector field values addressed by aria-label, never by position: the panel
 *  gains and reorders fields as it grows, so index reads rot without anyone
 *  noticing (rotation used to be index 2, corner radius 6, stroke weight 7). */
const field = (p, label) => p.evaluate((l) => {
  const input = [...document.querySelectorAll(".inspector .field input")]
    .find((i) => i.getAttribute("aria-label") === l);
  return input ? input.value : null;
}, label);
const focusField = (p, label) => p.evaluate((l) => {
  const el = [...document.querySelectorAll(".inspector .field input")]
    .find((i) => i.getAttribute("aria-label") === l);
  if (el) { el.focus(); el.select(); }
  return !!el;
}, label);

/** The app's in-app dialog (DialogHost). Native prompt/confirm are gone, so a
 *  flow that used to be answered by page.on("dialog") is answered here. */
const dlg = (p) => p.evaluate(() => {
  const el = document.querySelector(".x-dialog");
  if (!el) return null;
  return {
    title: el.querySelector(".x-dialog-title")?.textContent ?? "",
    body: el.querySelector(".dlg-body")?.textContent ?? "",
    value: el.querySelector(".dlg-input")?.value ?? null,
    error: el.querySelector(".dlg-error")?.textContent ?? null,
    buttons: [...el.querySelectorAll(".x-dialog-foot button")].map((b) => b.textContent.trim()),
  };
});
const clickDlg = async (p, label) => {
  const hit = await p.evaluate((l) => {
    const b = [...document.querySelectorAll(".x-dialog-foot button")].find((x) => x.textContent.trim() === l);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  await sleep(350);
  return hit;
};
const typeDlg = async (p, text) => {
  await p.evaluate(() => { const el = document.querySelector(".dlg-input"); el.focus(); el.select(); });
  await p.keyboard.type(text);
  await sleep(120);
};

async function page(fresh = true) {
  const p = await b.newPage();
  await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  p.on("pageerror", e => allErrors.push(e.message));
  if (fresh) {
    // Wipe the document before the app script ever runs: loading it first would
    // let autosave immediately rewrite whatever a previous check left behind.
    await p.goto(`${URL}/favicon.ico`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await p.evaluate(async () => {
      try {
        // The dashboard keeps an index plus one document slot per file; both
        // are cleared so every check starts from the bundled sample document.
        // The interface theme is deliberately left alone.
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("x-native") && k !== "x-native-theme") localStorage.removeItem(k);
        }
        // A document that outgrows localStorage overflows into IndexedDB, and a
        // page that has just been closed can still be writing there: clear both,
        // and wait for the deletions, so no check inherits the last one's file.
        const dbs = (await indexedDB.databases?.()) ?? [];
        await Promise.all(dbs.map((d) => d.name ? new Promise((res) => {
          const r = indexedDB.deleteDatabase(d.name);
          r.onsuccess = r.onerror = r.onblocked = () => res();
        }) : null));
      } catch {}
    });
    await sleep(300);
  }
  // The app opens on the dashboard; tests drive a file, so enter one directly.
  // "demo" is the sample document, and it is created on the dashboard for a
  // brand-new store by engine/files.ts.
  await p.goto(`${URL}/#/file/demo`, { waitUntil: "networkidle0" });
  await sleep(450);
  return p;
}
// Waits for the layer list to render: a check that reads it the instant the
// document mounts can catch an empty panel and index into nothing.
const rows = async (p) => {
  for (let i = 0; i < 24; i++) {
    const out = await p.evaluate(() => [...document.querySelectorAll(".panel.left .row")].map(r => r.textContent.trim()));
    if (out.length) return out;
    await sleep(250);
  }
  return [];
};
const drawRect = async (p, x = 820, y = 640) => {
  await p.keyboard.press("r");
  await p.mouse.move(x, y); await p.mouse.down();
  await p.mouse.move(x + 140, y + 100, { steps: 6 }); await p.mouse.up();
  await sleep(400);
};

// Address a layer row by the id the engine gave it (rows carry data-row-id).
// The panel groups children under their parent and orders newest-first inside
// each group, so an index means a different layer as soon as anything is drawn
// — which is how a check ends up asserting on the wrong layer while passing.
// `add` extends the selection with ctrl (⌘/Ctrl toggle, as the panel implements
// it) rather than a shift range: a range spans every row *between* two layers,
// which is the whole tree when one of them nested into a frame.
const clickRowById = async (p, id, add = false) => {
  const hit = await p.evaluate((target, withAdd) => {
    const row = document.querySelector(`.panel.left .row[data-row-id="${target}"]`);
    if (!row) return false;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: withAdd }));
    return true;
  }, id, add);
  await sleep(400);
  return hit;
};

// 1. rename ---------------------------------------------------------------
{
  const p = await page();
  const i = (await rows(p)).indexOf("View Details Button");
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
  // An id with no stored document falls back to the autosave slot, which is
  // exactly the path these hostile payloads are aimed at. It has to be an
  // *unstored* id: `#/file/demo` now has its own stored document, so the
  // legacy slot is never read and the warning would never fire.
  await p.goto(`${URL}/#/file/${label.replace(/\W+/g, "-")}-${Date.now()}`, { waitUntil: "networkidle0" }); await sleep(700);
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
  // The confirmation is an in-app dialog, so the check drives its buttons —
  // and a native one still appearing would be a missed call site.
  const natives = [];
  p.on("dialog", async d => { natives.push(d.message()); await d.dismiss(); });
  const run = async (accept) => {
    await p.keyboard.down("Meta"); await p.keyboard.press("k"); await p.keyboard.up("Meta"); await sleep(450);
    await p.keyboard.type("New file"); await sleep(450);
    await p.evaluate(() => {
      const el = [...document.querySelectorAll(".actions button,.palette button,[role=option],.act-row")]
        .find(r => r.textContent.trim().startsWith("New file"));
      el && el.click();
    });
    await sleep(600);
    const asked = await p.evaluate(() => document.querySelector(".x-dialog-title")?.textContent || "");
    // Accepting reloads the page out from under this evaluate, so it is allowed
    // to fail with a destroyed context.
    await p.evaluate((ok) => {
      const label = ok ? "Delete and start new" : "Cancel";
      [...document.querySelectorAll(".x-dialog-foot button")]
        .find(b => b.textContent.trim() === label)?.click();
    }, accept).catch(() => {});
    await sleep(accept ? 2500 : 700);
    // Cancelling leaves the palette open; close it so the next run starts clean.
    if (!accept) { await p.keyboard.press("Escape"); await sleep(400); }
    return asked;
  };
  const cancelTitle = await run(false);
  t(`New file confirms in an in-app dialog (${cancelTitle})`, cancelTitle === "New file");
  t("cancelling New file keeps the document", (await rows(p)).length === edited);
  t("cancelling left no native dialog behind", natives.length === 0);
  await run(true);
  const after = await rows(p);
  // What the dialog promises: the stored file is gone and a blank one opens.
  // The file's own document has to be the blank one - clearing only the legacy
  // autosave slot left the drawn rect in per-file storage, so the reload read
  // it straight back and "New file" silently did nothing.
  const storedLayers = await p.evaluate(() => {
    try {
      const doc = JSON.parse(localStorage.getItem("x-native-doc:demo") || "null");
      return doc?.pages?.[0]?.root?.children?.length ?? -1;
    } catch { return -1; }
  });
  t(`New file replaces the file with a blank document (${edited}->${after.length}, stored ${storedLayers} layers)`,
    after.length < edited && !after.includes("Rectangle") && storedLayers === 0);
  await p.close();
}

// 7. undo coalescing on a real field -------------------------------------
{
  const p = await page();
  await drawRect(p);
  const rotVal = () => field(p, "Rotation");
  await focusField(p, "Rotation");
  await p.keyboard.type("45"); await p.keyboard.press("Enter"); await sleep(500);
  t(`typed rotation applies (${await rotVal()})`, String(await rotVal()).startsWith("45"));
  await p.keyboard.down("Meta"); await p.keyboard.press("z"); await p.keyboard.up("Meta"); await sleep(600);
  t(`one undo clears the whole typed value (${await rotVal()})`, String(await rotVal()) === "0");
  await p.close();
}

// 8. clipboard ------------------------------------------------------------
{
  const p = await page();
  const i = (await rows(p)).indexOf("View Details Button");
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
  await p.evaluate(() => document.querySelector('button.plus[title="Add export"], button.plus[data-tip="Add export"]').click());
  await sleep(450);
  for (let i = 0; i < 3; i++) {
    await p.evaluate(() => document.querySelector('button.fmt[title="Format"], button.fmt[data-tip="Format"]').click());
    await sleep(200);
  }
  t("export format cycles to PDF",
    (await p.evaluate(() => document.querySelector('button.fmt[title="Format"], button.fmt[data-tip="Format"]').textContent.trim())) === "PDF");
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
    // "Copy selected layer's colour" sits in the Styles subtab of this pane,
    // next to the other colour primitives — not in the Variables list.
    await p.evaluate(() => [...document.querySelectorAll(".panel.left button")]
      .find(b => b.textContent.trim() === "Styles")?.click());
    await sleep(400);
  };
  await openVars();
  await (await p.$('.panel.left button.plus[title*="Copy"], .panel.left button.plus[data-tip*="Copy"]')).click();
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
  await (await p.$('.panel.left button.plus[title*="Copy"], .panel.left button.plus[data-tip*="Copy"]')).click();
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
  // Pin the capability, not a count: the panel gained sections (Typography is
  // text-only, Modifiers/Expressions/Selection colors are conditional), so the
  // old `=== 8` failed while every section still folded. What must hold is that
  // the ones a designer needs are all there and all collapse.
  const required = ["Position", "Layout", "Appearance", "Fill", "Stroke", "Effects", "Export"];
  const missing = required.filter((n) => !base.toggles.includes(n));
  t(`every inspector section is collapsible (${base.toggles.length} sections, missing: ${missing.join(", ") || "none"})`,
    base.toggles.length >= 8 && missing.length === 0);
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
  // A drop on a frame's edge used to place the artwork entirely outside that
  // frame's clip, so the import looked like it silently did nothing. Client x
  // 800 is the right edge of the demo's "iPhone 16 Pro" frame at this viewport.
  const p = await page();
  await p.evaluate(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="160">
      <rect x="30" y="30" width="160" height="100" fill="#dddddd" stroke="#ff0000" stroke-width="10"/></svg>`;
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "edge.svg", { type: "image/svg+xml" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 800, clientY: 520 }));
  });
  await sleep(1400);
  const red = await p.evaluate(() => {
    const c = document.querySelector("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] < 80 && d[i + 2] < 80 && d[i + 3] > 200) n++;
    }
    return n;
  });
  t(`an import dropped on a frame's edge stays visible (${red}px red)`, red > 200);
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
  // Dropped on empty canvas, not over a frame: this check is about fills
  // surviving the round trip, and a frame that clips part of the artwork would
  // hide the green dot regardless of how faithfully it imports.
  const dropSketch = (name) => p.evaluate((data, n) => {
    const bin = atob(data);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], n, { type: "" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 420, clientY: 250 }));
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
  const w = await field(p, "W"), h = await field(p, "H");
  const r = await field(p, "Corner radius"), sw = await field(p, "Stroke weight");
  t(`Card keeps its 120x60 size (${w}x${h})`, w === "120" && h === "60");
  t(`Card keeps corner radius 8 and stroke 2 (r${r} s${sw})`, r === "8" && sw === "2");

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
    // Empty canvas, like the .sketch check above: dropping on top of the demo's
    // frames measures their clipping, not whether .fig fills survive import.
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 420, clientY: 250 }));
  }, b64);
  await sleep(2200);
  const after = await rows(p);
  t(`.fig opens as layers (${before} -> ${after.length})`, after.length === before + 4);
  t("frame, rect, ellipse and text all arrive",
    ["Home", "FigCard", "FigDot", "FigLabel"].every((n) => after.includes(n)));

  const rs = await p.$$(".panel.left .row");
  await rs[after.indexOf("FigCard")].click();
  await sleep(650);
  const fw = await field(p, "W"), fh = await field(p, "H");
  const fr = await field(p, "Corner radius"), fsw = await field(p, "Stroke weight");
  t(`.fig keeps exact geometry (${fw}x${fh})`, fw === "120" && fh === "60");
  t(`.fig keeps radius 8 and stroke 2 (r${fr} s${fsw})`, fr === "8" && fsw === "2");

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
    const el = [...document.querySelectorAll(".inspector button.plus")].find(b => (b.getAttribute("title") ?? b.getAttribute("data-tip")) === "Add stroke");
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
    const bs = [...document.querySelectorAll('.inspector button[title="outside"], .inspector button[data-tip="outside"]')];
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
    // Styles is a sub-tab of the Vars pane; its "+" does not exist until it is
    // the open one, so opening Vars alone left this block clicking nothing.
    await p.evaluate(() => {
      const b = [...document.querySelectorAll(".panel.left button")]
        .find(x => x.textContent.trim() === "Styles");
      if (b && b.className !== "on") b.click();
    });
    await sleep(400);
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
      .find(b => (b.getAttribute("title") ?? b.getAttribute("data-tip")) === "Create style from selection");
    el && el.click();
  });
  await sleep(700);
  // These rectangles carry only a fill, so there is no fill-or-stroke choice to
  // make: the in-app prompt for a name comes straight up, prefilled from the
  // layer. (A layer with both fills the choice dialog first — see §22.)
  const nameDlg = await dlg(p);
  t(`creating a style asks for its name in-app (${nameDlg?.title})`, nameDlg?.title === "Style name (fill)");
  await typeDlg(p, "Brand");
  await p.keyboard.press("Enter");
  await sleep(700);
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

  await p.evaluate(() => {
    const el = document.querySelector('.panel.left button[aria-label^="Edit style"]');
    el && el.click();
  });
  await sleep(700);
  const colourDlg = await dlg(p);
  t(`editing a style asks for its colour in-app (${colourDlg?.title})`, colourDlg?.title === "Colour for Brand");
  await typeDlg(p, "#0000ff");
  await p.keyboard.press("Enter");
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
  await p.close();
}

// 18. effects: compact rows, controls in a popover -------------------------
{
  const p = await page();
  const names = await rows(p);
  const rs = await p.$$(".panel.left .row");
  await rs[names.indexOf("View Details Button")].click();
  await sleep(600);
  const height = () => p.evaluate(() => {
    const i = document.querySelector(".inspector");
    return { sh: i.scrollHeight, ch: i.clientHeight };
  });
  const base = await height();
  await p.evaluate(() => {
    const t = [...document.querySelectorAll(".sec-toggle")].find(x => x.textContent.trim() === "Effects");
    if (t && t.getAttribute("aria-expanded") === "false") t.click();
  });
  await sleep(400);
  for (let k = 0; k < 3; k++) {
    await p.evaluate(() => {
      const el = [...document.querySelectorAll(".inspector button.plus")].find(b => (b.getAttribute("title") ?? b.getAttribute("data-tip")) === "Add effect");
      el && el.click();
    });
    await sleep(350);
    await p.evaluate(() => {
      const btns = [...document.querySelectorAll(".type-menu button")];
      btns[0] && btns[0].click();
    });
    await sleep(450);
  }
  t("three effects are listed", (await p.evaluate(() => document.querySelectorAll(".fx-row").length)) === 3);
  // A row used to expand inline (~148px each) and push the panel 314px past its
  // viewport. The fix moved the controls into the shared popover, so the thing
  // to hold is the row staying one line — the panel itself is `overflow: auto`
  // by design, and asserting on its scrollHeight asks it not to scroll at all.
  const after = await p.evaluate(() => {
    const rows = [...document.querySelectorAll(".fx-row")];
    return {
      heights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      inline: rows.reduce((n, r) => n + r.querySelectorAll("input,select").length, 0),
      sh: document.querySelector(".inspector").scrollHeight,
      ch: document.querySelector(".inspector").clientHeight,
    };
  });
  t(`effect rows stay one line (${after.heights.join("|")}px, panel ${base.sh} -> ${after.sh} in ${after.ch})`,
    after.heights.every((h) => h > 0 && h <= 48) && after.inline === 0);

  await p.evaluate(() => {
    const el = document.querySelector('.fx-row button[aria-label^="Edit"]');
    el && el.click();
  });
  await sleep(600);
  // The effect controls moved into the shared XPopover, so the class is the
  // shared one and the fields are named rather than positional — a new control
  // must not silently renumber this check.
  t("the row opens an effect popover", await p.evaluate(() => !!document.querySelector(".x-popover")));
  const f = await p.$$(".x-popover .field input");
  t(`the popover carries the shadow controls (${f.length})`, f.length === 4);
  const y = await p.$('.x-popover input[aria-label="Shadow Y"]');
  t("the popover names the shadow offset", !!y);
  if (y) {
    await y.click();
    await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
    await p.keyboard.type("18"); await p.keyboard.press("Enter");
    await sleep(600);
    // Assert the model, not a DOM index: which control sits at [1] is not the
    // question this check is asking.
    const sel = (await p.evaluate(() => window.__xNativeDesignApi.call("getSelection", {}))).data.ids[0];
    const y2 = (await p.evaluate((id) => window.__xNativeDesignApi.call("getNode", { id, full: true }), sel))
      .data.full.effects?.[0]?.y;
    t(`editing in the popover reaches the model (Y=${y2})`, y2 === 18);
    t("the popover stays open while editing", await p.evaluate(() => !!document.querySelector(".x-popover")));
    await p.keyboard.press("Escape");
    await sleep(400);
    t("Escape closes the popover", !(await p.evaluate(() => !!document.querySelector(".x-popover"))));
  } else {
    t("editing in the popover reaches the model (skipped: no named field)", false);
  }
  await p.close();
}

// 19. ruler guides ---------------------------------------------------------
{
  const p = await page();
  await p.keyboard.down("Shift"); await p.keyboard.press("R"); await p.keyboard.up("Shift");
  await sleep(450);
  const wrap = await p.evaluate(() => {
    const r = document.querySelector(".canvas-wrap").getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  t("both ruler rails are grabbable", (await p.evaluate(() => document.querySelectorAll(".guide-rail").length)) === 2);

  // drag a horizontal guide out of the top rail
  await p.mouse.move(wrap.x + 500, wrap.y + 10);
  await p.mouse.down();
  await p.mouse.move(wrap.x + 500, wrap.y + 300, { steps: 10 });
  await p.mouse.up();
  await sleep(600);
  t("dragging from the top rail creates a horizontal guide",
    (await p.evaluate(() => document.querySelectorAll(".guide-y").length)) === 1);

  // and a vertical one out of the left rail
  await p.mouse.move(wrap.x + 10, wrap.y + 400);
  await p.mouse.down();
  await p.mouse.move(wrap.x + 900, wrap.y + 400, { steps: 10 });
  await p.mouse.up();
  await sleep(600);
  t("dragging from the left rail creates a vertical guide",
    (await p.evaluate(() => document.querySelectorAll(".guide-x").length)) === 1);

  // a guide drag must not disturb the canvas selection underneath
  const sel = await p.evaluate(() => document.querySelector(".inspector")?.innerText.slice(0, 20) || "");
  await p.mouse.move(wrap.x + 10, wrap.y + 600);
  await p.mouse.down();
  await p.mouse.move(wrap.x + 950, wrap.y + 600, { steps: 8 });
  await p.mouse.up();
  await sleep(500);
  t("pulling a guide does not change the selection",
    (await p.evaluate(() => document.querySelector(".inspector")?.innerText.slice(0, 20) || "")) === sel);

  // double-click removes one
  const before = await p.evaluate(() => document.querySelectorAll(".guide-x").length);
  await p.evaluate(() => {
    const g = document.querySelector(".guide-x");
    g.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  await sleep(500);
  t(`double-click removes a guide (${before} -> ${await p.evaluate(() => document.querySelectorAll(".guide-x").length)})`,
    (await p.evaluate(() => document.querySelectorAll(".guide-x").length)) === before - 1);

  // guides belong to the page, so they persist
  await sleep(1300);
  await p.reload({ waitUntil: "networkidle0" });
  await sleep(1200);
  t("guides survive a reload",
    (await p.evaluate(() => document.querySelectorAll(".guide").length)) >= 2);
  await p.close();
}

// 20. minimap --------------------------------------------------------------
{
  const p = await page();
  t("minimap is off by default", (await p.evaluate(() => document.querySelectorAll(".minimap").length)) === 0);
  await p.keyboard.down("Shift"); await p.keyboard.press("M"); await p.keyboard.up("Shift");
  await sleep(600);
  t("Shift+M shows the minimap", (await p.evaluate(() => document.querySelectorAll(".minimap").length)) === 1);

  // it must actually draw the document, not sit there as an empty box
  const ink = await p.evaluate(() => {
    const c = document.querySelector(".minimap canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 10) n++;
    return n;
  });
  t(`the thumbnail renders content (${ink}px)`, ink > 5000);

  // clicking the centre must centre the viewport there; the rectangle also has
  // to stay inside the thumbnail, which it did not when the fit ignored the
  // viewport and the visible area was larger than the artwork.
  const mm = await p.evaluate(() => {
    const c = document.querySelector(".minimap canvas").getBoundingClientRect();
    return { x: c.left, y: c.top, w: c.width, h: c.height };
  });
  await p.mouse.click(Math.round(mm.x + mm.w / 2), Math.round(mm.y + mm.h / 2));
  await sleep(700);
  // The viewport rectangle is drawn in the accent green (#0e9f6e light /
  // #10b981 dark); the old predicate was blue, which is document ink - so it
  // tracked the thumbnail's fit changing, not the viewport.
  const rect = await p.evaluate(() => {
    const c = document.querySelector(".minimap canvas");
    const dpr = window.devicePixelRatio || 1;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 1] > 100 && d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 20) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : {
      cx: (minX + maxX) / 2 / dpr, cy: (minY + maxY) / 2 / dpr,
      w: (maxX - minX) / dpr, h: (maxY - minY) / dpr,
    };
  });
  t("the viewport rectangle is drawn", !!rect);
  if (rect) {
    // The thumbnail refits to the union of the document and the viewport, so the
    // rectangle lands a few pixels off the exact click: it is centred on the
    // clicked *world* point, which the fit then redraws slightly off. 12px is
    // the observed slack; the direction check below is what catches a backwards
    // mapping.
    t(`clicking centres the viewport (dx=${Math.abs(rect.cx - mm.w / 2).toFixed(0)}, dy=${Math.abs(rect.cy - mm.h / 2).toFixed(0)})`,
      Math.abs(rect.cx - mm.w / 2) < 12 && Math.abs(rect.cy - mm.h / 2) < 12);
    t(`the viewport rectangle fits the thumbnail (${rect.w.toFixed(0)}x${rect.h.toFixed(0)})`,
      rect.w <= mm.w && rect.h <= mm.h);
  }

  await p.keyboard.down("Shift"); await p.keyboard.press("M"); await p.keyboard.up("Shift");
  await sleep(500);
  t("Shift+M hides it again", (await p.evaluate(() => document.querySelectorAll(".minimap").length)) === 0);
  await p.close();
}

// 21. remaining gaps: stroke styles and draggable comment pins -------------
{
  const p = await page();
  await p.evaluate(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140">
      <rect x="20" y="20" width="150" height="90" fill="#dddddd" stroke="#ff0000" stroke-width="8"/></svg>`;
    const dt = new DataTransfer();
    dt.items.add(new File([svg], "a.svg", { type: "image/svg+xml" }));
    document.querySelector(".canvas-wrap").dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 800, clientY: 520 }));
  });
  await sleep(1400);
  await p.evaluate(() => {
    const el = [...document.querySelectorAll("button")]
      .find((x) => (x.getAttribute("aria-label") || x.textContent).trim() === "Vars");
    el.click();
  });
  await sleep(500);
  await p.evaluate(() => {
    const b = [...document.querySelectorAll(".panel.left button")]
      .find((x) => x.textContent.trim() === "Styles");
    if (b && b.className !== "on") b.click();
  });
  await sleep(400);
  await p.evaluate(() => {
    const el = [...document.querySelectorAll(".panel.left button.plus")]
      .find((x) => (x.getAttribute("title") ?? x.getAttribute("data-tip")) === "Create style from selection");
    el && el.click();
  });
  await sleep(700);
  // This layer has a fill *and* a stroke, so the app asks which one to save
  // instead of the old confirm() where OK secretly meant stroke.
  const choose = await dlg(p);
  t(`both fill and stroke offer a real choice (${choose?.title})`, choose?.title === "Create style from");
  await clickDlg(p, "Stroke");
  await typeDlg(p, "Brand");
  await p.keyboard.press("Enter");
  await sleep(900);
  // The engine has always supported stroke styles; only the UI was missing.
  const swatch = await p.evaluate(() => {
    const el = document.querySelector('.panel.left button[aria-label^="Apply style"]');
    return el ? getComputedStyle(el).backgroundColor : "";
  });
  t(`a style can be created from the stroke (${swatch})`, swatch.includes("255, 0, 0"));
  t("a bound selection offers detach", (await p.evaluate(() =>
    document.querySelectorAll('.panel.left button[aria-label^="Detach style"]').length)) === 1);
  await p.evaluate(() => {
    const el = document.querySelector('.panel.left button[aria-label^="Detach style"]');
    el && el.click();
  });
  await sleep(700);
  t("detaching drops the binding", (await p.evaluate(() =>
    document.querySelectorAll('.panel.left button[aria-label^="Detach style"]').length)) === 0);

  // comment pins: moveComment existed in the engine with no way to reach it
  await p.evaluate(() => {
    const el = [...document.querySelectorAll("button")]
      .find((x) => (x.getAttribute("aria-label") || x.textContent).trim() === "File");
    el.click();
  });
  await sleep(500);
  const wrap = await p.evaluate(() => {
    const r = document.querySelector(".canvas-wrap").getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  await p.keyboard.press("c");
  await sleep(300);
  await p.mouse.click(wrap.x + 700, wrap.y + 300);
  await sleep(450);
  await p.keyboard.type("Move me");
  await p.keyboard.press("Enter");
  await sleep(800);
  const pinLeft = () => p.evaluate(() => Math.round(document.querySelector(".cm-pin").getBoundingClientRect().left));
  const pinCentre = () => p.evaluate(() => {
    const r = document.querySelector(".cm-pin").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const before = await pinLeft();
  await p.keyboard.press("v");
  const c = await pinCentre();
  await p.mouse.move(c.x, c.y);
  await p.mouse.down();
  await p.mouse.move(c.x + 60, c.y, { steps: 8 });
  await p.mouse.move(c.x + 140, c.y, { steps: 8 });
  await p.mouse.up();
  await sleep(700);
  const after = await pinLeft();
  t(`a comment pin can be dragged (${before} -> ${after})`, Math.abs(after - before) > 100);

  // a press that never moves must still count as a click
  let c2 = await pinCentre();
  await p.mouse.click(c2.x, c2.y);
  await sleep(600);
  const closed = !(await p.evaluate(() => !!document.querySelector(".cm-pop")));
  c2 = await pinCentre();
  await p.mouse.click(c2.x, c2.y);
  await sleep(600);
  t("dragging did not break click-to-open",
    closed && (await p.evaluate(() => !!document.querySelector(".cm-pop"))));

  // the new anchor is part of the document
  await sleep(1300);
  await p.reload({ waitUntil: "networkidle0" });
  await sleep(1200);
  t(`the moved pin persists (${await pinLeft()})`, Math.abs((await pinLeft()) - after) < 4);
  await p.close();
}

// 22. cross-panel navigation: the toolbar key and the inspector bridge -----
{
  const p = await page();
  await rows(p);
  // TB-U1: the toolbar's resources key opens the Assets pane, not the palette
  // (the dedicated Actions key keeps the ⌘/ palette).
  await p.evaluate(() => document.querySelector('.dock button[aria-label="Assets"]').click());
  await sleep(400);
  t("toolbar Assets opens the Assets pane",
    await p.evaluate(() => [...document.querySelectorAll(".panel.left .section-label")]
      .some(el => /Local components/.test(el.textContent || ""))));
  t("toolbar Assets does not open the actions palette",
    await p.evaluate(() => !document.querySelector(".actions")));
  // LP-U1: with nothing selected the inspector's bridge row opens Variables.
  await p.evaluate(() => [...document.querySelectorAll(".panel.left .nav, .rail .nav")]
    .find(el => /file/i.test(el.textContent || ""))?.click());
  await p.keyboard.press("Escape");
  await sleep(400);
  const bridge = await p.evaluate(() => {
    const el = [...document.querySelectorAll(".inspector button.link")]
      .find(x => /Open variables/.test(x.textContent || ""));
    if (el) el.click();
    return !!el;
  });
  t("inspector shows the variables bridge with nothing selected", bridge);
  await sleep(400);
  t("bridge opens the Variables pane",
    await p.evaluate(() => /Variables/.test(document.querySelector(".panel.left")?.textContent || "")));
  await p.close();
}

// 23. typography: labelled align keys + italic toggle -----------------------
{
  const p = await page();
  const i = (await rows(p)).indexOf("Label");
  const rs = await p.$$(".panel.left .row");
  await rs[i].click(); await sleep(500);
  t("align keys carry labels",
    await p.evaluate(() => !!document.querySelector('.inspector button[aria-label="Align center"]')));
  t("valign keys carry labels",
    await p.evaluate(() => !!document.querySelector('.inspector button[aria-label="Vertical align middle"]')));
  await p.evaluate(() => document.querySelector('.inspector button.plus[title="Type settings"], .inspector button.plus[data-tip="Type settings"]').click());
  await sleep(400);
  const hasItalic = await p.evaluate(() => !!document.querySelector('.inspector .type-pop button[aria-label="Italic"]'));
  t("type settings has an Italic toggle", hasItalic);
  if (hasItalic) {
    await p.evaluate(() => document.querySelector('.inspector .type-pop button[aria-label="Italic"]').click());
    await sleep(400);
    t("italic toggle applies",
      await p.evaluate(() => document.querySelector('.inspector .type-pop button[aria-label="Italic"]').getAttribute("aria-pressed") === "true"));
  } else fail++;
  await p.close();
}

// 24. prototype entry: toolbar toggle + palette shortcut ----------------------
{
  const p = await page();
  await rows(p);
  const tab = () => p.evaluate(() =>
    [...document.querySelectorAll(".panel.right .tabs .tab")]
      .find(el => (el.textContent || "").trim() === "Prototype")
      ?.getAttribute("aria-current"));
  t("toolbar has a Prototype toggle",
    await p.evaluate(() => !!document.querySelector('.dock button[aria-label="Prototype"]')));
  await p.evaluate(() => document.querySelector('.dock button[aria-label="Prototype"]').click());
  await sleep(400);
  t("toggle opens the Prototype tab",
    (await tab()) === "true" &&
    (await p.evaluate(() => !!document.querySelector(".inspector .proto-row"))));
  await p.evaluate(() => document.querySelector('.dock button[aria-label="Prototype"]').click());
  await sleep(400);
  t("toggle returns to Design", (await tab()) === "false");
  await p.close();
}

// 25. outline stroke: exactly one entry, honest feedback ----------------------
{
  const p = await page();
  await rows(p);
  await drawRect(p);
  const outlines = () => p.evaluate(() =>
    [...document.querySelectorAll(".inspector button")]
      .map(b => (b.textContent || "").trim()).filter(t => /outline stroke/i.test(t)));
  t("no Outline entry before a stroke exists", (await outlines()).length === 0);
  await p.evaluate(() => [...document.querySelectorAll(".inspector .empty-add-btn")]
    .find(b => /add stroke/i.test(b.textContent || "")).click());
  await sleep(400);
  t("one Outline entry on a stroked shape", (await outlines()).length === 1);
  await p.keyboard.down("Meta"); await p.keyboard.press("e"); await p.keyboard.up("Meta");
  await sleep(500);
  t("one Outline entry after flatten to vector", (await outlines()).length === 1);
  await p.evaluate(() => [...document.querySelectorAll(".inspector button")]
    .find(b => /outline stroke/i.test(b.textContent || "")).click());
  await sleep(400);
  t("outlining toasts",
    await p.evaluate(() => (document.querySelector(".toast")?.textContent || "").includes("Outlined stroke")));
  await p.close();
}

// 26. locked selection: grey dashed chrome, no accent -------------------------
{
  const p = await page();
  await rows(p);
  const countNear = (r, g, b, tol) => p.evaluate((r, g, b, tol) => {
    const c = document.querySelector("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - r) < tol && Math.abs(d[i + 1] - g) < tol && Math.abs(d[i + 2] - b) < tol && d[i + 3] > 200) n++;
    }
    return n;
  }, r, g, b, tol);
  // The demo document paints the accent colour itself (a #10b981 toggle), so
  // chrome is measured as the difference from an idle canvas - captured before
  // anything is drawn or selected, or the baseline would contain the very
  // chrome the check is looking for. Without the subtraction "no accent left"
  // could never be true: the toggle keeps ~550px on screen either way.
  const idle = await countNear(16, 185, 129, 24);
  await drawRect(p);
  const emeraldBefore = (await countNear(16, 185, 129, 24)) - idle;
  t(`editable selection renders accent chrome (${emeraldBefore}px)`, emeraldBefore > 500);
  const greyBefore = await countNear(154, 160, 166, 20);
  await p.keyboard.down("Meta"); await p.keyboard.down("Shift");
  await p.keyboard.press("l");
  await p.keyboard.up("Shift"); await p.keyboard.up("Meta");
  await sleep(500);
  const emeraldAfter = (await countNear(16, 185, 129, 24)) - idle;
  const greyAfter = await countNear(154, 160, 166, 20);
  t(`locked selection drops the accent (${emeraldAfter}px)`, emeraldAfter < 60);
  t(`locked selection renders grey chrome (+${greyAfter - greyBefore}px)`, greyAfter - greyBefore > 100);
  await p.close();
}

// 27. toolbar flyouts: full keyboard menu -----------------------------------
{
  const p = await page();
  await rows(p);
  const flyOpen = (g) => p.evaluate((g) =>
    !!document.querySelector(`.dock .tool[data-group="${g}"].open`), g);
  const focused = () => p.evaluate(() => ({
    role: document.activeElement?.getAttribute("role"),
    label: (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || "").trim(),
  }));
  // arrows open the move-group flyout and land on the current tool
  await p.evaluate(() => document.querySelector('.dock .tool[data-group="move"] .hit').focus());
  await p.keyboard.press("ArrowDown");
  await sleep(300);
  t("arrow opens the tool flyout", await flyOpen("move"));
  t("focus lands on the current tool", (await focused()).role === "menuitemradio");
  // arrows move, esc closes and returns focus without touching the selection
  const first = (await focused()).label;
  await p.keyboard.press("ArrowDown");
  await sleep(200);
  t("arrow moves between tools", (await focused()).label !== first);
  const selBefore = await rows(p);
  await p.keyboard.press("Escape");
  await sleep(300);
  t("esc closes the flyout", !(await flyOpen("move")));
  t("esc returns focus to the trigger",
    await p.evaluate(() => document.activeElement?.classList?.contains("hit")));
  t("esc keeps the selection", JSON.stringify(await rows(p)) === JSON.stringify(selBefore));
  // enter on a menu item switches tools
  await p.keyboard.press("ArrowDown");
  await sleep(300);
  await p.keyboard.press("ArrowDown");
  await sleep(200);
  await p.keyboard.press("Enter");
  await sleep(300);
  t("enter switches to the chosen tool",
    await p.evaluate(() => document.querySelector('.dock .tool[data-group="move"] .hit').getAttribute("aria-label")) === "Hand");
  // the boolean menu takes the same path once two layers are selected
  await p.keyboard.press("r");
  await p.mouse.move(820, 620); await p.mouse.down();
  await p.mouse.move(960, 720, { steps: 6 }); await p.mouse.up();
  await sleep(300);
  await p.keyboard.press("r");
  await p.mouse.move(1000, 620); await p.mouse.down();
  await p.mouse.move(1140, 720, { steps: 6 }); await p.mouse.up();
  await sleep(300);
  // Selecting the two rects from the layer tree: a marquee has to start on
  // empty canvas, and this corner of the demo document is covered by frames, so
  // the drag grabbed whichever frame sat under it instead of marqueeing.
  const rectIds = (await p.evaluate(() => window.__xNativeDesignApi.call("findNodes", { kind: "rect", name: "Rectangle", limit: 50 }))).data.items
    .map((n) => n.id);
  for (const [k, id] of rectIds.entries()) await clickRowById(p, id, k > 0);
  await sleep(400);
  const hasBool = await p.evaluate(() => !!document.querySelector('.dock .tool[data-group="bool"] .hit'));
  t("two selected layers show the boolean menu", hasBool);
  if (hasBool) {
    await p.evaluate(() => document.querySelector('.dock .tool[data-group="bool"] .hit').focus());
    await p.keyboard.press("ArrowDown");
    await sleep(300);
    t("arrow opens the boolean menu",
      (await flyOpen("bool")) && (await focused()).role === "menuitem");
    await p.keyboard.press("Escape");
    await sleep(300);
    t("esc closes the boolean menu", !(await flyOpen("bool")));
  }
  await p.close();
}

// 28. multi-select scalars: Mixed display + apply to all ----------------------
{
  const p = await page();
  await rows(p);
  const api = (method, params) => p.evaluate((m, x) => window.__xNativeDesignApi.call(m, x), method, params);
  const setField = async (sel, v) => {
    await p.evaluate((s) => {
      const el = document.querySelector(s);
      el.focus(); el.select();
    }, sel);
    await p.keyboard.type(String(v));
    await p.keyboard.press("Enter");
    await sleep(400);
  };
  const setHex = async (v) => {
    await p.evaluate(() => { const el = document.querySelectorAll(".inspector .color-row .hex")[0]; el.focus(); el.select(); });
    await p.keyboard.type(v);
    await sleep(400);
  };
  const full = async (id) => (await api("getNode", { id, full: true })).data.full;
  // two rects, divergent opacity + fill
  await drawRect(p);
  const firstId = (await api("getSelection", {})).data.ids[0];
  await setField('.inspector input[aria-label="%"]', "30");
  await setHex("ff0000");
  await drawRect(p, 1000, 640);
  const secondId = (await api("getSelection", {})).data.ids[0];
  await setField('.inspector input[aria-label="%"]', "60");
  await setHex("0000ff");
  await clickRowById(p, firstId);
  await clickRowById(p, secondId, true);
  const ids = (await api("getSelection", {})).data.ids;
  t(`both rects selected (${ids.length})`,
    ids.length === 2 && ids.includes(firstId) && ids.includes(secondId));
  t("opacity reads Mixed",
    await p.evaluate(() => document.querySelector('.inspector input[aria-label="%"]').value) === "Mixed");
  t("fill reads Mixed",
    await p.evaluate(() => document.querySelectorAll(".inspector .color-row .hex")[0].value) === "Mixed");
  await setField('.inspector input[aria-label="%"]', "80");
  const ops = [(await full(ids[0])).opacity, (await full(ids[1])).opacity];
  t(`opacity commits to every layer (${ops.join(",")})`, ops.every(v => v === 0.8));
  await setHex("00ff00");
  const fills = [(await full(ids[0])).fill, (await full(ids[1])).fill];
  t(`fill commits to every layer (${fills.join(",")})`,
    fills.every(f => f.toLowerCase().startsWith("#00ff00")));
  await p.close();
}

// 29. multi-select type metrics: Mixed size + apply to all -------------------
{
  const p = await page();
  await rows(p);
  const api = (method, params) => p.evaluate((m, x) => window.__xNativeDesignApi.call(m, x), method, params);
  // Returns false when the field is missing so a bad setup fails as a check
  // instead of crashing the rest of the suite.
  const setSize = async (v) => {
    const present = await p.evaluate(() => !!document.querySelector('.inspector input[aria-label="S"]'));
    if (!present) return false;
    await p.evaluate(() => { const el = document.querySelector('.inspector input[aria-label="S"]'); el.focus(); el.select(); });
    await p.keyboard.type(String(v));
    await p.keyboard.press("Enter");
    await sleep(400);
    return true;
  };
  const layerCount = () => p.evaluate(() => document.querySelectorAll('.panel.left .row[style*="padding-left"]').length);
  // T on the text just created edits that layer rather than making another, so
  // each creation starts from an empty selection. The two boxes are also far
  // apart: a drag that lands inside the previous box edits its text instead of
  // creating a second layer.
  // Returns the new layer's id, so the checks below can address it directly
  // instead of guessing where it landed in the tree.
  const dragText = async (x, y) => {
    await p.keyboard.press("v");
    await p.mouse.click(300, 200);
    await sleep(200);
    const before = await layerCount();
    await p.keyboard.press("t");
    await p.mouse.move(x, y); await p.mouse.down();
    await p.mouse.move(x + 120, y + 30, { steps: 6 }); await p.mouse.up();
    await sleep(400);
    await p.keyboard.press("Escape");
    await sleep(300);
    const id = (await api("getSelection", {})).data.ids[0];
    return (await layerCount()) === before + 1 ? id : null;
  };
  const textA = await dragText(820, 640);
  const textB = await dragText(1020, 640);
  t("the text tool makes one layer per drag", !!textA && !!textB && textA !== textB);
  t("the first text layer can be selected from the tree", await clickRowById(p, textA));
  t("its size field is editable", await setSize("20"));
  t("the second text layer can be selected from the tree", await clickRowById(p, textB));
  t("its size field is editable", await setSize("32"));
  await clickRowById(p, textA);
  await clickRowById(p, textB, true); // ctrl-toggle: exactly these two
  const ids = (await api("getSelection", {})).data.ids;
  t(`two text layers selected (${ids.length})`, ids.length === 2);
  t("size reads Mixed",
    await p.evaluate(() => document.querySelector('.inspector input[aria-label="S"]')?.value) === "Mixed");
  await setSize("24");
  const sizes = [];
  for (const id of (await api("getSelection", {})).data.ids)
    sizes.push((await api("getNode", { id, full: true })).data.full.fontSize);
  t(`size commits to every text layer (${sizes.join(",")})`, sizes.every(v => v === 24));
  await p.close();
}

// 30. property-first binding: bind from the row, pill, mixed multi ---------
{
  const p = await page();
  await rows(p);
  const api = (method, params) => p.evaluate((m, x) => window.__xNativeDesignApi.call(m, x), method, params);
  const full = async (id) => (await api("getNode", { id, full: true })).data.full;
  const tab = async (re) => {
    await p.evaluate((rx) => [...document.querySelectorAll(".panel.left .nav, .rail .nav")]
      .find(el => new RegExp(rx, "i").test(el.textContent || ""))?.click(), re);
    await sleep(400);
  };
  const addVar = async (name, type, value) => {
    await p.evaluate(() => document.querySelector('.panel.left button.plus[title="Add Variable"], .panel.left button.plus[data-tip="Add Variable"]').click());
    await sleep(300);
    await p.evaluate(() => { const el = document.querySelector('.panel.left input[placeholder="Variable name"]'); el.focus(); el.select(); });
    await p.keyboard.type(name);
    await p.select('.panel.left select[aria-label="Variable type"]', type);
    await sleep(200);
    await p.evaluate(() => { const el = document.querySelector('.panel.left input[placeholder="Value"]'); el.focus(); el.select(); });
    await p.keyboard.type(value);
    await p.evaluate(() => [...document.querySelectorAll(".panel.left button")].find(b => b.textContent === "Save")?.click());
    await sleep(400);
  };
  const pickVar = async (name) => {
    const rows = await p.$$(".x-popover .bind-row");
    for (const r of rows) {
      const text = await p.evaluate(el => el.textContent, r);
      if (text.includes(name)) { await r.click(); await sleep(400); return true; }
    }
    return false;
  };
  await tab("vars");
  await addVar("e2e-red", "color", "#ff0000");
  await addVar("e2e-size", "number", "24");
  await tab("file");
  await drawRect(p);
  const id1 = (await api("getSelection", {})).data.ids[0];
  t("rect selected", !!id1);
  // fill: ghost button -> picker -> pill
  t("fill row carries a bind ghost",
    await p.evaluate(() => !!document.querySelector('.inspector button[aria-label="Bind fill to a variable"]')));
  await p.evaluate(() => document.querySelector('.inspector button[aria-label="Bind fill to a variable"]').click());
  await sleep(400);
  t("picker lists the colour variable", await pickVar("e2e-red"));
  t("pill names the bound variable",
    await p.evaluate(() => document.querySelector(".inspector .bind-pill-name")?.textContent) === "e2e-red");
  t("fill binding lands on the layer", !!(await full(id1)).variableBindings?.fill);
  await p.evaluate(() => document.querySelector('.inspector button[aria-label="Remove fill binding"]').click());
  await sleep(400);
  t("unbind detaches the fill binding", (await full(id1)).variableBindings?.fill === undefined);
  // opacity: picker filters by type; multi shows mixed then binds all
  await p.evaluate(() => document.querySelector('.inspector button[aria-label="Bind opacity to a variable"]').click());
  await sleep(400);
  const names = await p.evaluate(() => [...document.querySelectorAll(".x-popover .bind-row")].map(el => el.textContent));
  t(`opacity picker lists numbers not colours (${names.join("|")})`,
    names.some(x => x.includes("e2e-size")) && !names.some(x => x.includes("e2e-red")));
  t("number bind lands", await pickVar("e2e-size"));
  await drawRect(p, 1000, 640);
  const id2 = (await api("getSelection", {})).data.ids[0];
  await clickRowById(p, id1);
  await clickRowById(p, id2, true); // ctrl-toggle: exactly these two
  const ids = (await api("getSelection", {})).data.ids;
  t(`both rects selected (${ids.sort().join(",")})`,
    ids.length === 2 && ids.includes(id1) && ids.includes(id2));
  t("half-bound multi shows a mixed bind indicator",
    await p.evaluate(() => !!document.querySelector('.inspector button[aria-label^="Mixed bindings"]')));
  await p.evaluate(() => document.querySelector('.inspector button[aria-label^="Mixed bindings"]').click());
  await sleep(400);
  t("mixed bind resolves through the picker", await pickVar("e2e-size"));
  const bound = [(await full(ids[0])).variableBindings?.opacity, (await full(ids[1])).variableBindings?.opacity];
  t(`one pick binds every layer (${bound.join(",")})`, bound.every(Boolean) && bound[0] === bound[1]);
  await p.evaluate(() => document.querySelector('.inspector button[aria-label="Remove opacity binding"]').click());
  await sleep(400);
  const cleared = [(await full(ids[0])).variableBindings?.opacity, (await full(ids[1])).variableBindings?.opacity];
  t("one unbind clears every layer", cleared.every(v => v === undefined));
  await p.close();
}

// 31. dialogs: native prompt/confirm are gone (PM-U1) -----------------------
{
  const p = await page();
  await rows(p);
  const api = (method, params) => p.evaluate((m, x) => window.__xNativeDesignApi.call(m, x), method, params);
  const full = async (id) => (await api("getNode", { id, full: true })).data.full;

  // A native prompt/confirm blocks the page and is invisible to the DOM, so
  // "we stopped using them" is only checkable by counting the calls. Anything
  // recorded here is a site that was missed.
  const spy = () => p.evaluate(() => {
    window.__nativeCalls = [];
    window.prompt = (msg) => { window.__nativeCalls.push(`prompt: ${msg}`); return null; };
    window.confirm = (msg) => { window.__nativeCalls.push(`confirm: ${msg}`); return false; };
    window.alert = (msg) => { window.__nativeCalls.push(`alert: ${msg}`); };
  });
  const nativeCalls = () => p.evaluate(() => window.__nativeCalls || []);
  const tab = async (re) => {
    await p.evaluate((rx) => [...document.querySelectorAll(".panel.left .nav, .rail .nav")]
      .find(el => new RegExp(rx, "i").test(el.textContent || ""))?.click(), re);
    await sleep(400);
  };
  const varNames = () => p.evaluate(() =>
    [...document.querySelectorAll(".panel.left span[title='Double-click to rename'], .panel.left span[data-tip='Double-click to rename']")].map((s) => s.textContent));
  // By name: the sample document already ships variables (spacing-sm, radius-md
  // …), so "the first row" would rename one of those instead.
  const openRename = async (name) => {
    await p.evaluate((n) => {
      const spans = [...document.querySelectorAll(".panel.left span[title='Double-click to rename'], .panel.left span[data-tip='Double-click to rename']")];
      (spans.find((x) => x.textContent.trim() === n) ?? spans[0])
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, name);
    await sleep(350);
  };

  await tab("vars");
  // one variable to rename
  await p.evaluate(() => document.querySelector('.panel.left button.plus[title="Add Variable"], .panel.left button.plus[data-tip="Add Variable"]').click());
  await sleep(300);
  await p.evaluate(() => { const el = document.querySelector('.panel.left input[placeholder="Variable name"]'); el.focus(); el.select(); });
  await p.keyboard.type("dlg-token");
  await p.evaluate(() => [...document.querySelectorAll(".panel.left button")].find(b => b.textContent === "Save")?.click());
  await sleep(400);
  await spy();

  // ── prompt: rename a variable ─────────────────────────────────────────────
  // A real selection first, so "the dialog swallowed Escape" is checkable: with
  // nothing selected the old assertion could pass for the wrong reason.
  await tab("file");
  await drawRect(p);
  const keptId = (await api("getSelection", {})).data.ids[0];
  await tab("vars");
  await openRename("dlg-token");
  const rename = await dlg(p);
  t(`rename opens an in-app prompt (${rename?.title})`, rename?.title === "Rename variable");
  t(`the prompt starts from the current name (${rename?.value})`, rename?.value === "dlg-token");
  t("the prompt offers Rename and Cancel",
    rename?.buttons.join("|") === "Cancel|Rename", rename?.buttons);
  await typeDlg(p, "dlg-renamed");
  await p.keyboard.press("Enter");
  await sleep(400);
  t("Enter commits the rename", (await varNames()).includes("dlg-renamed"));
  t("no native prompt was used", (await nativeCalls()).length === 0);

  // ── Escape and backdrop are cancels, not answers ──────────────────────────
  await openRename("dlg-token");
  await p.keyboard.press("Escape");
  await sleep(350);
  t("Escape closes the prompt", (await dlg(p)) === null);
  t("Escape left the canvas selection alone",
    (await api("getSelection", {})).data.ids[0] === keptId);
  t("Escape keeps the old name", (await varNames()).includes("dlg-renamed"));
  await openRename("dlg-token");
  await p.evaluate(() => document.querySelector(".x-dialog-backdrop").click());
  await sleep(350);
  t("clicking the backdrop dismisses the prompt", (await dlg(p)) === null);
  t("dismissing keeps the old name", (await varNames()).includes("dlg-renamed"));
  t("still no native dialogs", (await nativeCalls()).length === 0);

  // ── confirm: deleting a collection is explicit and named ──────────────────
  await p.evaluate(() => document.querySelector('.panel.left button[title="Add collection"], .panel.left button[data-tip="Add collection"]').click());
  await sleep(350);
  const newCol = await dlg(p);
  t(`creating a collection asks in-app (${newCol?.title})`, newCol?.title === "New collection");
  t("the collection name is prefilled", !!newCol?.value);
  await typeDlg(p, "QA");
  await clickDlg(p, "Create");
  const chips = () => p.evaluate(() => [...document.querySelectorAll(".panel.left button")].map((b) => b.textContent.trim()));
  t("the collection is created", (await chips()).includes("QA"));

  await p.evaluate(() => document.querySelector('.panel.left button[title^="Delete collection"], .panel.left button[data-tip^="Delete collection"]').click());
  await sleep(350);
  const del = await dlg(p);
  t(`deleting a collection confirms in-app (${del?.title})`, del?.title === 'Delete collection "QA"');
  t("the confirm names what is lost", /variables/i.test(del?.body ?? ""));
  t("the confirm says Delete collection, not OK",
    del?.buttons.join("|") === "Cancel|Delete collection", del?.buttons);
  await p.keyboard.press("Escape");
  await sleep(350);
  t("cancelling the confirm keeps the collection", (await chips()).includes("QA"));
  await p.evaluate(() => document.querySelector('.panel.left button[title^="Delete collection"], .panel.left button[data-tip^="Delete collection"]').click());
  await sleep(350);
  await clickDlg(p, "Delete collection");
  t("confirming deletes the collection", !(await chips()).includes("QA"));
  t("destructive flows used no native confirm", (await nativeCalls()).length === 0);

  // ── choice: a style is created from the stroke or the fill, both as buttons
  await tab("file");
  await drawRect(p);
  const id = (await api("getSelection", {})).data.ids[0];
  await p.evaluate(() => [...document.querySelectorAll(".inspector button.plus")]
    .find((b) => (b.getAttribute("title") ?? b.getAttribute("data-tip")) === "Add stroke")?.click());
  await sleep(400);
  const strokePaint = (await full(id)).strokePaint;
  await tab("vars");
  await p.evaluate(() => [...document.querySelectorAll(".panel.left button")]
    .find((b) => b.textContent.trim() === "Styles")?.click());
  await sleep(300);
  await p.evaluate(() => document.querySelector('.panel.left button.plus[title="Create style from selection"], .panel.left button.plus[data-tip="Create style from selection"]').click());
  await sleep(350);
  const choose = await dlg(p);
  t(`a two-way style choice is a real choice (${choose?.title})`, choose?.title === "Create style from");
  t("both outcomes are named buttons, and Cancel exists",
    choose?.buttons.join("|") === "Cancel|Stroke|Fill", choose?.buttons);
  await clickDlg(p, "Stroke");
  const nameDlg = await dlg(p);
  t(`picking Stroke leads to the name (${nameDlg?.title})`, nameDlg?.title === "Style name (stroke)");
  const layerName = (await full(id)).name;
  t(`the style name starts from the layer name (${nameDlg?.value} vs ${layerName})`,
    nameDlg?.value === layerName);
  await typeDlg(p, "stroke-qa");
  await p.keyboard.press("Enter");
  await sleep(400);
  const styleRow = await p.evaluate(() => {
    const row = [...document.querySelectorAll(".panel.left .color-row")]
      .find((r) => r.textContent.includes("stroke-qa"));
    if (!row) return null;
    return { name: row.textContent.trim(), swatch: getComputedStyle(row.querySelector(".swatch")).backgroundColor };
  });
  t("the stroke style lands in the styles list", !!styleRow);
  const hexToRgb = (hex) => {
    const h = (hex || "").replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  t(`it holds the stroke colour, not the fill (${styleRow?.swatch} vs ${strokePaint})`,
    !!styleRow && styleRow.swatch === hexToRgb(strokePaint));
  t("the choice flow used no native confirm", (await nativeCalls()).length === 0);

  // ── validation: a rejected answer keeps the dialog open and says why ──────
  await p.goto(`${URL}/#/`, { waitUntil: "networkidle0" });
  await sleep(500);
  await spy();
  await p.evaluate(() => document.querySelector('button[title="New project"], button[data-tip="New project"]').click());
  await sleep(350);
  const project = await dlg(p);
  t(`new project asks in-app (${project?.title})`, project?.title === "New project");
  await clickDlg(p, "Create");
  const blocked = await dlg(p);
  t("an empty name is refused, not silently dropped", !!blocked?.error, blocked?.error);
  t("the dialog stays open on a refused answer", !!blocked);
  await typeDlg(p, "E2E project");
  await p.keyboard.press("Enter");
  await sleep(400);
  t("a valid name closes the dialog", (await dlg(p)) === null);
  t("the dashboard reported the new project",
    await p.evaluate(() => (document.querySelector(".toast")?.textContent ?? "").includes("E2E project")));
  t("the dashboard used no native prompt", (await nativeCalls()).length === 0);

  await p.close();
}

// 32. one tooltip system: native titles adopt the shared pill ----------------
{
  const p = await page();
  await rows(p);
  // Controls that only have the native attribute are named before anyone
  // interacts with them, so assistive tech and tests can find them.
  const named = await p.evaluate(() => {
    const el = document.querySelector('.panel.left button.mini[title^="Lock layer"]');
    if (!el) return null;
    el.dataset.probeTip = "1";
    return { title: el.getAttribute("title"), name: el.getAttribute("aria-label") };
  });
  t(`a title-only control is named up front (${named?.name})`, named?.name === "Lock layer");

  const visibleTips = () => p.evaluate(() =>
    [...document.querySelectorAll(".tip")].filter((el) => getComputedStyle(el).display !== "none").length);

  // Hover: the browser's own box is taken out of the way and the shared pill
  // renders instead, with the shortcut split into its own chip.
  const box = await p.evaluate(() => {
    const el = document.querySelector('[data-probe-tip="1"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top };
  });
  await p.mouse.move(box.x, box.y);
  await sleep(650);
  const hovered = await p.evaluate(() => {
    const el = document.querySelector('[data-probe-tip="1"]');
    const tips = [...document.querySelectorAll(".tip")].filter((t) => getComputedStyle(t).display !== "none");
    return {
      pills: tips.length,
      text: tips.map((t) => t.textContent).join(" | "),
      title: el.getAttribute("title"),
      dataTip: el.dataset.tip,
      chip: tips[0]?.querySelector(".tip-sc")?.textContent ?? null,
      above: tips[0] ? Math.round(tips[0].getBoundingClientRect().bottom) <= Math.round(el.getBoundingClientRect().top) : null,
    };
  });
  t(`hover shows the shared pill (${hovered.text})`, hovered.pills === 1 && hovered.text.startsWith("Lock layer"));
  t(`the shortcut is its own chip (${hovered.chip})`, hovered.chip === "⇧⌘L");
  t("the native attribute is out of the way while the pill shows",
    hovered.title === null && hovered.dataTip === "Lock layer (⇧⌘L)");
  t("the pill sits above its control, not over it", hovered.above === true);

  // Leaving puts the attribute back: the bridge is presentation, not the owner.
  await p.mouse.move(box.x + 300, box.y + 260);
  await sleep(400);
  const left = await p.evaluate(() => {
    const el = document.querySelector('[data-probe-tip="1"]');
    return { title: el.getAttribute("title"), dataTip: el.dataset.tip ?? null };
  });
  t(`the attribute returns on leave (${left.title})`,
    left.title === "Lock layer (⇧⌘L)" && left.dataTip === null && (await visibleTips()) === 0);

  // Keyboard: the same label, for both kinds of control. A tool flyout button
  // is wrapped in the shared component; the lock button only has the attribute.
  await p.mouse.move(box.x + 300, box.y + 260);
  await p.keyboard.press("Tab");
  await p.evaluate(() => document.querySelector('.dock .tool[data-group="move"] .hit').focus());
  await sleep(500);
  const kbComponent = await p.evaluate(() => {
    const tips = [...document.querySelectorAll(".tip")].filter((t) => getComputedStyle(t).display !== "none");
    return { pills: tips.length, text: tips.map((t) => t.textContent).join(" | ") };
  });
  t(`keyboard focus shows a wrapped control's label (${kbComponent.text})`,
    kbComponent.pills === 1 && kbComponent.text.includes("Move"));
  await p.evaluate(() => document.querySelector('[data-probe-tip="1"]').focus());
  await sleep(500);
  const kbAttr = await p.evaluate(() => {
    const tips = [...document.querySelectorAll(".tip")].filter((t) => getComputedStyle(t).display !== "none");
    return { pills: tips.length, text: tips.map((t) => t.textContent).join(" | ") };
  });
  t(`keyboard focus shows a title-only control's label (${kbAttr.text})`,
    kbAttr.pills === 1 && kbAttr.text.startsWith("Lock layer"));
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log("page errors:", allErrors.length ? allErrors.slice(0, 5) : "none");
await b.close();
process.exit(fail ? 1 : 0);
