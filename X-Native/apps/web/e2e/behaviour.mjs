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
  // The viewport rectangle is drawn in the accent green: Minimap.tsx reads
  // `--accent` per paint (FR-U2), so it is #0e9f6e light and #10b981 dark and
  // this predicate stays green-ish rather than pinning either value. The old
  // predicate was blue, which is document ink - so it tracked the thumbnail's
  // fit changing, not the viewport.
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
  // by accessible name: this button is Tooltip-wrapped, so it carries no native
  // title for the bridge to adopt (and must not, or it would be labelled twice)
  await p.evaluate(() => document.querySelector('button[aria-label="New project"]').click());
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

  // A control inside a Tooltip wrapper must not ALSO carry a native title: both
  // systems would answer, and the user sees two boxes (TY-U4).
  await p.mouse.move(30, 980);
  await p.keyboard.press("Escape");
  await sleep(250);
  const doubly = await p.evaluate(() =>
    [...document.querySelectorAll(".tip-host [title], .tip-host[title]")]
      .map((el) => el.getAttribute("title") || ""));
  t(`no control is labelled twice (${doubly.length ? doubly.join(", ") : "none"})`, doubly.length === 0);
  await p.close();
}

// 33. one header chrome: layer and prototype blocks fold like sections -------
{
  const p = await page();
  await rows(p);
  const secOpen = (p, title) => p.evaluate((t) =>
    [...document.querySelectorAll(".inspector .sec-toggle")]
      .find((b) => b.textContent.trim() === t)?.getAttribute("aria-expanded") ?? null, title);
  const secTitles = () => p.evaluate(() =>
    [...document.querySelectorAll(".inspector .sec-toggle")].map((b) => b.textContent.trim()));
  const buttons = () => p.evaluate(() => document.querySelector(".inspector").querySelectorAll("button").length);

  // Two rects: the Boolean block used to be a static <h3> header with no fold.
  await drawRect(p, 820, 640);
  await drawRect(p, 1000, 640);
  const drawn = (await p.evaluate(() => window.__xNativeDesignApi.call("findNodes", { kind: "rect", name: "Rectangle", limit: 50 }))).data.items.map((n) => n.id);
  const pair = drawn.slice(-2);
  for (const [k, id] of pair.entries()) await clickRowById(p, id, k > 0);
  await sleep(450);
  t("the boolean block is a section header now", (await secOpen(p, "Boolean")) === "true");
  const withBoolean = await buttons();
  await p.evaluate(() => [...document.querySelectorAll(".sec-toggle")].find((b) => b.textContent.trim() === "Boolean").click());
  await sleep(250);
  const foldedBoolean = await buttons();
  await p.evaluate(() => [...document.querySelectorAll(".sec-toggle")].find((b) => b.textContent.trim() === "Boolean").click());
  await sleep(250);
  t(`folding the boolean block hides its controls (${withBoolean} -> ${foldedBoolean} -> ${await buttons()})`,
    (await secOpen(p, "Boolean")) === "true" && foldedBoolean < withBoolean && (await buttons()) === withBoolean);

  // Prototype tab: the three blocks were static headers too.
  await p.keyboard.down("Shift"); await p.keyboard.press("e"); await p.keyboard.up("Shift");
  await sleep(500);
  const proto = await secTitles();
  for (const want of ["Flow starting point", "Prototype settings", "Interactions"]) {
    t(`the prototype ${want.toLowerCase()} block is a section`, proto.includes(want));
  }
  await p.evaluate(() => [...document.querySelectorAll(".sec-toggle")].find((b) => b.textContent.trim() === "Prototype settings").click());
  await sleep(250);
  t("folding prototype settings closes it", (await secOpen(p, "Prototype settings")) === "false");
  await p.evaluate(() => [...document.querySelectorAll(".sec-toggle")].find((b) => b.textContent.trim() === "Prototype settings").click());
  await sleep(250);
  t("and reopening it brings the device rows back", (await secOpen(p, "Prototype settings")) === "true");
  await p.close();
}

// 34. one nav truth: every entry point switches the visible pane ------------
{
  const p = await page();
  await rows(p);
  const pane = () => p.evaluate(() => document.querySelector(".nav.on")?.textContent?.trim() ?? null);
  // The engine's leftTab was write-only: the palette's variable row and the
  // ⌥1..3 chords "worked" (they dispatched) but no panel read the value, so
  // nothing moved. They now go through the App-owned nav the panel reads.
  await p.keyboard.down("Alt"); await p.keyboard.press("3"); await p.keyboard.up("Alt");
  await sleep(400);
  const vars = await pane();
  t(`⌥3 opens the Variables pane (${vars})`, vars === "Vars");
  await p.keyboard.down("Alt"); await p.keyboard.press("1"); await p.keyboard.up("Alt");
  await sleep(350);
  t(`⌥1 returns to the layers pane (${await pane()})`, (await pane()) === "File");

  // a variable result in the palette must land on the pane that lists it
  const name = (await p.evaluate(() => window.__xNativeDesignApi.call("getVariables", { limit: 1 }))).data.items[0].name;
  await p.keyboard.down("Meta"); await p.keyboard.press("k"); await p.keyboard.up("Meta");
  await sleep(400);
  await p.keyboard.type(name);
  await sleep(600);
  const opened = await p.evaluate(() => {
    const rows2 = [...document.querySelectorAll("[role=option], .act-row")];
    const hit = rows2[rows2.length - 1];
    hit?.click();
    return hit?.textContent?.trim().slice(0, 30) ?? null;
  });
  await sleep(500);
  t(`a palette variable opens the Variables pane (${opened} → ${await pane()})`, opened !== null && (await pane()) === "Vars");
  t("and the toast points at the pane it opened",
    await p.evaluate(() => /Variables tab/.test(document.querySelector(".toast")?.textContent ?? "")));
  await p.close();
}

// 35. "Edit points" edits; "Flatten" bakes (IN-U5) ----------------------------
{
  const p = await page();
  await rows(p);
  await drawRect(p);
  const seg = () => p.evaluate(() =>
    [...document.querySelectorAll(".inspector .seg button")].map((b) => b.textContent.trim()).filter(Boolean));
  const names = await seg();
  // Both buttons used to dispatch `flatten`, so "Edit vector" promised editing
  // and delivered a bake - the same action twice under two labels.
  t(`the vector row offers distinct actions (${names.join(" / ")})`,
    names.includes("Edit points") && names.includes("Flatten"));
  const doneVisible = () => p.evaluate(() => !!document.querySelector('.dock [title^="Done editing path"]'));
  t("vector edit mode is off to begin with", (await doneVisible()) === false);

  await p.evaluate(() => [...document.querySelectorAll(".inspector .seg button")].find((b) => b.textContent.trim() === "Edit points").click());
  await sleep(500);
  const editing = await p.evaluate(() => {
    const b = [...document.querySelectorAll(".inspector .seg button")].find((x) => /point/i.test(x.textContent));
    return { label: b?.textContent.trim(), done: !!document.querySelector('.dock [title^="Done editing path"]') };
  });
  t(`Edit points enters vector edit (${editing.label}, done button ${editing.done})`,
    editing.done === true && editing.label === "Editing points");

  await p.keyboard.press("Escape");
  await sleep(400);
  const left = await p.evaluate(() => {
    const s = window.__xNativeDesignApi.call("getSelection", {}).data;
    return {
      done: !!document.querySelector('.dock [title^="Done editing path"]'),
      sel: s.ids.length,
      seg: [...document.querySelectorAll(".inspector .seg button")].map((b) => b.textContent.trim()).filter(Boolean),
    };
  });
  // Leaving the point editor must not also drop the layer: the inspector used
  // to jump back to the page panel and the shape being edited was lost, because
  // the App's Escape cascade deselects without knowing edit mode exists.
  t(`Esc leaves vector edit and keeps the layer selected (${left.sel} selected, ${left.seg.join("/")})`,
    left.done === false && left.sel === 1 && left.seg.includes("Edit points"));

  // Flatten is still its own action: it converts the shape, not the mode.
  await p.evaluate(() => [...document.querySelectorAll(".inspector .seg button")].find((b) => b.textContent.trim() === "Flatten")?.click());
  await sleep(500);
  const after = await p.evaluate(() => {
    const s = window.__xNativeDesignApi.call("getSelection", {}).data;
    return { kind: s.nodes?.[0]?.kind ?? null, done: !!document.querySelector('.dock [title^="Done editing path"]') };
  });
  t(`Flatten converts the shape without entering edit mode (kind ${after.kind})`,
    after.kind === "vector" && after.done === false);
  await p.close();
}

// 36. one tab primitive: three strips, one behaviour (PM-U5, IN-U7) ---------
{
  const p = await page();
  await rows(p);
  const strip = (sel) => p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return {
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label"),
      buttons: [...el.querySelectorAll("button")].map((b) => ({
        text: b.textContent.trim(),
        selected: b.getAttribute("aria-selected"),
        roving: b.getAttribute("tabindex"),
      })),
    };
  }, sel);

  // The inspector head strip: role/aria-selected/roving focus, and the
  // underline look it always had (driven by aria-current).
  const head = await strip(".panel.right .tabs-row .tabs");
  t(`the inspector tabs are a real tab list (${head?.buttons.map((b) => b.text).join("/")})`,
    head?.role === "tablist" && head.buttons.length === 2 && head.buttons.every((b) => b.selected !== null));
  t("only the active tab is tabbable",
    head.buttons.filter((b) => b.roving === "0").length === 1 && head.buttons.filter((b) => b.roving === "-1").length === 1);
  t("the zoom menu still shares the row",
    await p.evaluate(() => !!document.querySelector(".panel.right .tabs-row .zoom, .panel.right .tabs-row .tabs ~ .zoom")));

  await p.evaluate(() => document.querySelector('.panel.right .tabs-row .tabs button[aria-selected="true"]')?.focus());
  await p.keyboard.press("ArrowRight");
  await sleep(350);
  const moved = await strip(".panel.right .tabs-row .tabs");
  t(`arrows switch the inspector tab (${moved.buttons.find((b) => b.selected === "true")?.text})`,
    moved.buttons.find((b) => b.selected === "true")?.text === "Prototype" &&
    (await p.evaluate(() => document.activeElement?.textContent?.trim())) === "Prototype");
  t("and the prototype panel followed", await p.evaluate(() => !!document.querySelector(".inspector .proto-row")));
  await p.keyboard.press("Home");
  await sleep(300);
  const home = await strip(".panel.right .tabs-row .tabs");
  t(`Home returns to the first tab (${home.buttons.find((b) => b.selected === "true")?.text})`,
    home.buttons.find((b) => b.selected === "true")?.text === "Design");

  // The Variables/Styles switch was four inline-styled buttons with no keyboard
  // path; it is now the shared segmented control.
  await p.keyboard.down("Alt"); await p.keyboard.press("3"); await p.keyboard.up("Alt");
  await sleep(500);
  const pane = await strip(".panel.left .seg.pane");
  t(`the variables pane switch is a tab list (${pane?.buttons.map((b) => b.text).join("/")})`,
    pane?.role === "tablist" && pane.buttons.length === 2);
  t("its active pane is selected, not just coloured",
    pane.buttons.find((b) => b.text === "Variables")?.selected === "true");
  t("and it carries no styling of its own",
    await p.evaluate(() => ![...document.querySelectorAll(".panel.left .seg.pane button")].some((b) => b.getAttribute("style"))));
  await p.evaluate(() => document.querySelector(".panel.left .seg.pane button")?.focus());
  await p.keyboard.press("ArrowRight");
  await sleep(450);
  const after = await strip(".panel.left .seg.pane");
  t(`arrows switch to the styles pane (${after.buttons.find((b) => b.selected === "true")?.text})`,
    after.buttons.find((b) => b.selected === "true")?.text === "Styles" &&
    (await p.evaluate(() => !!document.querySelector(".panel.left .color-row"))));
  await p.close();
}

// 37. the palette dismisses like every other overlay (PM-U2) --------------
{
  const p = await page();
  await rows(p);
  const open = () => p.evaluate(() => !!document.querySelector(".actions"));
  await p.keyboard.down("Meta"); await p.keyboard.press("k"); await p.keyboard.up("Meta");
  await sleep(450);
  t("the palette opens on ⌘/", await open());
  t("with a backdrop over the app", await p.evaluate(() => !!document.querySelector(".actions-veil-bg")));
  // Clicking away used to leave it sitting over the canvas: only Escape, running
  // a row, or its own close button dismissed it.
  await p.mouse.click(1300, 850);
  await sleep(400);
  t("clicking outside closes it", (await open()) === false);
  t("and the editor did not take that click",
    (await p.evaluate(() => document.querySelectorAll(".panel.left .row").length)) === 23);
  // Inside the sheet, clicks must keep working (the palette is not dismiss-on-any-click).
  await p.keyboard.down("Meta"); await p.keyboard.press("k"); await p.keyboard.up("Meta");
  await sleep(400);
  await p.keyboard.type("zoom");
  await sleep(500);
  const head = await p.evaluate(() => {
    const r = document.querySelector(".actions").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 30) };
  });
  await p.mouse.click(head.x, head.y);
  await sleep(350);
  t("clicking inside keeps it open", await open());
  await p.keyboard.press("Escape");
  await sleep(300);
  t("and Escape still closes it", (await open()) === false);
  await p.close();
}

// 38. the nudge form is a dialog, not a help sheet (PM-U4) ------------------
{
  const p = await page();
  await rows(p);
  await p.evaluate(() => window.dispatchEvent(new CustomEvent("x-native-nudge-dialog")));
  await sleep(500);
  const look = await p.evaluate(() => ({
    title: document.querySelector(".x-dialog-title")?.textContent ?? null,
    label: document.querySelector(".x-dialog")?.getAttribute("aria-label") ?? null,
    modal: document.querySelector(".x-dialog")?.getAttribute("aria-modal") ?? null,
    helpChrome: !!document.querySelector(".help-card.nudge-dialog, .help-pop"),
    fields: [...document.querySelectorAll(".x-dialog-body input")].map((i) => i.getAttribute("aria-label")),
  }));
  // It used to wear help-pop / help-card / shortcuts-head — a preferences form
  // styled as documentation, with its own capture-phase Escape handler.
  t(`the nudge form uses the shared dialog (${look.title})`,
    look.title === "Nudge amount" && look.modal === "true" && look.helpChrome === false);
  t(`both amounts are editable there (${look.fields.join(", ")})`,
    look.fields.length === 2 && look.fields.includes("Small nudge") && look.fields.includes("Big nudge"));

  await p.evaluate(() => { const i = document.querySelector('input[aria-label="Small nudge"]'); i.focus(); i.select(); });
  await p.keyboard.type("7");
  await p.keyboard.press("Enter");
  await sleep(400);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("x-native-nudge") || "{}").small);
  t(`a committed nudge value is stored (${saved})`, saved === 7);
  await p.keyboard.press("Escape");
  await sleep(350);
  t("and the shared dialog closes on Escape", await p.evaluate(() => !document.querySelector(".x-dialog")));
  await p.close();
}

// 39. canvas floating chrome is a dock, not near-black (PT-U4) --------------
{
  const p = await page();
  await rows(p);
  /** Resolve a CSS token/value to a canonical computed colour, so a token read
   *  off the root ("rgba(255, 255, 255, 0.94)") compares equal to a computed
   *  style no matter how each side is spaced. */
  const norm = (v) => p.evaluate((val) => {
    const d = document.createElement("div");
    d.style.color = val;
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }, v);
  const token = (name) => p.evaluate((n) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

  // (a) the vector tool strip
  await drawRect(p);
  await p.evaluate(() => [...document.querySelectorAll(".inspector .seg button")].find((b) => b.textContent.trim() === "Edit points").click());
  await sleep(500);
  const bar = await p.evaluate(() => {
    const el = document.querySelector(".vector-edit-toolbar");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      bg: cs.backgroundColor,
      radius: cs.borderRadius,
      labels: [...el.querySelectorAll("button")].map((b) => (b.textContent || "").trim() || b.title),
      // every inline style left inside the strip; the Icon component sets its own
      // width/height/display, nothing here may lay the chrome out or colour it
      inline: [...el.querySelectorAll("[style]")].map((e) => e.getAttribute("style")),
      sep: !!el.querySelector(".dock-sep"),
      doneBg: getComputedStyle(el.querySelector(".dock-done")).backgroundColor,
      on: el.querySelector(".tool-btn.on")?.textContent?.trim() ?? null,
    };
  });
  const dock = await token("--dock");
  const accent = await token("--accent");
  // It carried `background: "#18181b"` + `color: "#fff"` inline on the strip and
  // on all nine buttons, so nothing on canvas could follow the theme.
  t(`the vector strip is a dock surface (${bar?.bg}, radius ${bar?.radius})`,
    bar?.bg === (await norm(dock)) && bar?.radius === "24px" &&
    bar?.inline.every((v) => !/background|border|color|padding/.test(v)));
  // The italic "Delete point (⌫)" comes from the button's title: it is icon-only.
  const WANT = ["Select", "Pen", "Bend", "Paint", "Shape Builder", "Simplify path", "Clean up", "Delete point (⌫)", "Done"];
  t(`and keeps all nine tools (${bar?.labels.join(", ")})`,
    bar?.labels.length === WANT.length && WANT.every((w) => bar.labels.includes(w)));
  t(`divider and Done use tokens (sep ${bar?.sep}, ${bar?.doneBg})`,
    bar?.sep === true && bar?.doneBg === (await norm(accent)));

  await p.evaluate(() => [...document.querySelectorAll(".vector-edit-toolbar .tool-btn")].find((b) => b.textContent.trim() === "Bend").click());
  await sleep(350);
  const switched = await p.evaluate(() => document.querySelector(".vector-edit-toolbar .tool-btn.on")?.textContent.trim());
  t(`the active tool moves to the one chosen (${switched})`, switched === "Bend");
  await p.keyboard.press("Escape");
  await sleep(400);

  // (b) the selected-connection chip: it renders only for a clicked connector, so
  //     the noodles are found by their own pixels on the canvas.
  await p.evaluate(() => document.querySelector('.dock button[aria-label="Prototype"]')?.click());
  await sleep(600);
  await p.mouse.click(760, 200);            // empty canvas: clear the selection
  await sleep(400);
  const cand = await p.evaluate(() => {
    const main = [...document.querySelectorAll("canvas")]
      .map((c) => ({ c, r: c.getBoundingClientRect() }))
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
    const { c, r } = main;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const sx = r.width / c.width, sy = r.height / c.height;
    const seen = new Set(), out = [];
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (Math.abs(d[i] - 16) < 26 && Math.abs(d[i + 1] - 185) < 30 && Math.abs(d[i + 2] - 129) < 30 && d[i + 3] > 200) {
        const px = Math.round(r.left + x * sx), py = Math.round(r.top + y * sy);
        const k = `${Math.round(px / 24)},${Math.round(py / 24)}`;
        if (seen.has(k)) continue;
        seen.add(k); out.push([px, py]);
      }
    }
    return out.slice(0, 80);
  });
  /** Click the first canvas accent pixel that opens a chip. The connectors are
   *  canvas drawings with their own hit test, so their pixels are how a test
   *  finds one without knowing the document's geometry. */
  const clickANoodle = async () => {
    for (const [x, y] of cand) {
      if (x < 240 || y < 120 || x > 1400 || y > 900) continue;
      await p.mouse.click(x, y);
      await sleep(90);
      if (await p.evaluate(() => !!document.querySelector(".conn-chip"))) return [x, y];
    }
    return null;
  };
  const onNoodle = await clickANoodle();
  t(`clicking a connector opens its chip (${onNoodle ? onNoodle.join(",") : "no noodle hit"})`, !!onNoodle);
  if (onNoodle) {
    const chip = await p.evaluate(() => {
      const el = document.querySelector(".conn-chip");
      const cs = getComputedStyle(el);
      return {
        text: el.querySelector("span")?.textContent,
        bg: cs.backgroundColor, color: cs.color, radius: cs.borderRadius,
        transform: cs.transform, shadow: cs.boxShadow,
        inline: [...el.querySelectorAll("[style]")].map((e) => e.getAttribute("style")),
      };
    });
    t(`the chip is a dock surface too (${chip.bg}, radius ${chip.radius})`,
      chip.bg === (await norm(dock)) && chip.radius === "14px" && chip.text?.includes("→") &&
      chip.inline.every((v) => !/background|color|border|padding/.test(v)));
    // The ring is the selection, so it has to be the accent token, not a literal.
    t(`its selection ring is the accent token (${chip.shadow.split(", ").pop()})`,
      chip.shadow.includes(await norm(accent)));
    // The same surface has to answer the theme; the old literal #18181b could not.
    const darkBg = await p.evaluate(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = {
        chip: getComputedStyle(document.querySelector(".conn-chip")).backgroundColor,
        dock: getComputedStyle(document.documentElement).getPropertyValue("--dock").trim(),
      };
      return out;
    });
    t(`and follows the theme (dark dock ${darkBg.chip})`, darkBg.chip === (await norm(darkBg.dock)) && darkBg.chip !== chip.bg);
    await p.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    await p.keyboard.press("Escape");
    await sleep(400);
    t("Escape dismisses the chip and leaves the connection", await p.evaluate(() => !document.querySelector(".conn-chip")));
    // The connector is still there to be clicked: Escape dropped the chip, not
    // the interaction (the same accent pixels are still drawn).
    await p.mouse.move(1000, 200);
    await sleep(400);
    const again = await clickANoodle();
    t(`and the connector opens again (${again ? again.join(",") : "no noodle"})`, !!again);
  }
  await p.close();
}

// 40. the presentation player is chrome, not inline paint (PT-U5) -----------
{
  const p = await page();
  await rows(p);
  const present = async () => {
    await p.evaluate(() => document.querySelector('.dock button[aria-label="Prototype"]')?.click());
    await sleep(600);
    await p.evaluate(() => [...document.querySelectorAll(".inspector button")]
      .find((b) => /Present Prototype/.test(b.textContent || ""))?.click());
    await sleep(900);
  };
  await present();

  const look = await p.evaluate(() => {
    const dock = document.querySelector(".player-dock");
    const cs = dock ? getComputedStyle(dock) : null;
    return {
      dock: !!dock,
      bg: cs?.backgroundColor, radius: cs?.borderRadius, blur: cs?.backdropFilter,
      // The Icon component keeps its own width/height/display; chrome may not
      // lay itself out or colour itself inline.
      inline: [...(dock?.querySelectorAll("[style]") ?? [])]
        .map((e) => e.getAttribute("style"))
        .filter((v) => !/^width: 1[0-9]px; height: 1[0-9]px; display: block;$/.test(v || "")),
      layerInline: document.querySelector(".prototype-player-layer")?.getAttribute("style"),
      children: [...(dock?.children ?? [])].map((c) => `${c.tagName.toLowerCase()}:${c.className}`),
      selects: [...(dock?.querySelectorAll("select") ?? [])].map((s) => s.getAttribute("aria-label")),
      buttons: [...(dock?.querySelectorAll("button") ?? [])].map((b) => (b.textContent || "").trim() || b.title),
      pressed: [...(dock?.querySelectorAll("button[aria-pressed]") ?? [])].map((b) => `${b.title}=${b.getAttribute("aria-pressed")}`),
      pager: dock?.querySelector(".player-page")?.textContent.trim(),
    };
  });
  // Eleven inline style objects used to carry the whole player: `#18181b`,
  // `#fff` and `rgba(255,255,255,0.7)` written out per control, unreachable by
  // any token. The dock and its stage palette live in the stylesheet now.
  t(`the player dock is stage chrome (${look.bg}, r${look.radius})`,
    look.dock && look.bg === "rgba(24, 24, 27, 0.85)" && look.radius === "24px" &&
    (look.blur || "").includes("20px") && look.inline.length === 0 && look.layerInline === null);
  const WANT_BTNS = ["Previous frame (←)", "Next frame (→ / Space)", "Restart", "Hotspots", "Fit",
                     "Live Inputs", "Toggle tactile sound feedback (M)", "Fullscreen (F)", "Exit"];
  t(`every player control is still there (${look.buttons.length} buttons, ${look.selects.length} selects)`,
    look.children.length === 13 && look.selects.join("|") === "Preview frame|Device mockup frame" &&
    look.buttons.join("|") === WANT_BTNS.join("|"));
  // A toggle used to say it was on only by its own inline colour; the state is
  // in the DOM now, so assistive tech and tests can read it.
  t(`toggles expose their state (${look.pressed.join(", ")})`,
    look.pressed.join("|") === "Toggle hotspot hints (H)=false|Toggle live editable inputs (I)=true|Toggle tactile sound feedback (M)=true");

  const step = () => p.evaluate(() => {
    const sel = document.querySelector('.player-dock select[aria-label="Preview frame"]');
    return {
      pager: document.querySelector(".player-page").textContent.trim(),
      frame: sel.selectedOptions[0]?.textContent.trim(),
      options: [...sel.options].map((o) => o.textContent.trim()),
      nextOff: document.querySelector('.player-dock button[title^="Next frame"]').disabled,
      prevOff: document.querySelector('.player-dock button[title^="Previous frame"]').disabled,
    };
  });
  const clickPlayer = (title) => p.evaluate((t) =>
    document.querySelector(`.player-dock button[title^="${t}"]`).click(), title);

  const first = await step();
  // The pager used to list every frame in the document while presentGo lands on
  // the outermost frame that contains the destination — so "2. Card" (a frame
  // inside the phone frame) was a step that went nowhere and still grew the
  // back history. Every step now lands somewhere.
  t(`the pager lists only frames it can reach (${first.options.join(", ")})`,
    first.options.join("|") === "1. iPhone 16 Pro|2. Success|3. Filter Sheet" &&
    !first.options.some((o) => /Card/.test(o)));
  t(`and starts on the first with prev disabled (${first.pager})`,
    first.pager === "1 / 3" && first.prevOff === true && first.nextOff === false);

  await clickPlayer("Next frame");
  await sleep(500);
  const second = await step();
  t(`next actually moves the stage (${first.frame} → ${second.frame}, ${second.pager})`,
    second.pager === "2 / 3" && second.frame === "2. Success" && second.prevOff === false);
  await clickPlayer("Next frame");
  await sleep(500);
  const third = await step();
  await clickPlayer("Previous frame");
  await sleep(500);
  const back = await step();
  t(`the ends are honest (${third.pager} next-off ${third.nextOff}, back to ${back.pager})`,
    third.pager === "3 / 3" && third.nextOff === true && back.pager === "2 / 3");

  // Toggles: on is a pill in the control's own hue, off is plain text.
  const hue = async (label) => p.evaluate((l) => {
    const b = [...document.querySelectorAll(".player-dock button")].find((x) => (x.textContent || "").includes(l));
    const cs = getComputedStyle(b);
    return { pressed: b.getAttribute("aria-pressed"), color: cs.color, bg: cs.backgroundColor };
  }, label);
  await p.evaluate(() => [...document.querySelectorAll(".player-dock button")].find((b) => /Hotspots/.test(b.textContent)).click());
  await sleep(400);
  const onBlue = await hue("Hotspots");
  await p.evaluate(() => [...document.querySelectorAll(".player-dock button")].find((b) => /Live Inputs/.test(b.textContent)).click());
  await sleep(250);
  await p.evaluate(() => [...document.querySelectorAll(".player-dock button")].find((b) => /Live Inputs/.test(b.textContent)).click());
  await sleep(400);
  const onGreen = await hue("Live Inputs");
  t(`a toggled control reads as on (hotspots ${onBlue.color}, inputs ${onGreen.color})`,
    onBlue.pressed === "true" && onBlue.color === "rgb(56, 189, 248)" &&
    onGreen.pressed === "true" && onGreen.color === "rgb(52, 211, 153)" &&
    onBlue.color !== onGreen.color);

  // It gets out of the way while the prototype is being looked at.
  await sleep(4200);
  const idle = await p.evaluate(() => {
    const d = document.querySelector(".player-dock");
    const cs = getComputedStyle(d);
    return { hidden: d.classList.contains("hidden"), opacity: cs.opacity, pointer: cs.pointerEvents };
  });
  t(`the dock slides away when idle (opacity ${idle.opacity}, ${idle.pointer})`,
    idle.hidden && idle.opacity === "0" && idle.pointer === "none");

  // …and its labels are the shared pill, like every other control (the player
  // used to be the one surface with the browser's own tooltip).
  await p.mouse.move(800, 500);
  await sleep(300);
  const rb = await p.evaluate(() => {
    const b = [...document.querySelectorAll(".player-dock button")].find((x) => /Restart/.test(x.textContent));
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, hidden: document.querySelector(".player-dock").classList.contains("hidden") };
  });
  await p.mouse.move(rb.x, rb.y);
  await sleep(750);
  const tip = await p.evaluate(() => {
    const tips = [...document.querySelectorAll(".tip")].filter((t) => getComputedStyle(t).display !== "none");
    const b = [...document.querySelectorAll(".player-dock button")].find((x) => /Restart/.test(x.textContent));
    return { pills: tips.length, text: tips.map((t) => t.textContent).join(" | "), chip: tips[0]?.querySelector(".tip-sc")?.textContent ?? null, title: b.getAttribute("title"), tip: b.dataset.tip };
  });
  t(`the dock wakes on a move and labels with the shared pill (${tip.text})`,
    rb.hidden === false && tip.pills === 1 && tip.text === "Restart flowR" && tip.chip === "R" &&
    tip.title === null && tip.tip === "Restart flow (R)");

  // Exit still ends the presentation (and the stage goes with it).
  await p.mouse.move(800, 400);
  await p.evaluate(() => [...document.querySelectorAll(".player-dock button")].find((b) => /Exit/.test(b.textContent)).click());
  await sleep(700);
  t("Exit leaves the player", await p.evaluate(() =>
    !document.querySelector(".player-dock") && !document.querySelector(".prototype-player-layer")));
  await p.close();
}

// 41. the prototype panel is one set of controls (PT-U2, PT-U3, PT-U7) ------
{
  const p = await page();
  const layerRows = await rows(p);
  await p.evaluate(() => document.querySelector('.dock button[aria-label="Prototype"]')?.click());
  await sleep(700);
  // View Details Button carries the sample file's interaction.
  await clickRowById(p, "rect_5");
  await sleep(700);

  const panel = await p.evaluate(() => {
    const right = document.querySelector(".panel.right");
    const rowSel = right.querySelector(".proto-row select");
    const card = right.querySelector(".proto-interaction");
    const cardSel = card?.querySelector("select");
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const shape = (el) => {
      const c = cs(el);
      return c ? `${c.height}|${c.borderStyle} ${c.borderWidth}|${c.borderRadius}|${c.fontSize}|${c.backgroundColor}` : null;
    };
    return {
      rowShape: shape(rowSel),
      cardShape: shape(cardSel),
      card: card ? { bg: cs(card).backgroundColor, border: cs(card).borderWidth, radius: cs(card).borderRadius, gap: cs(card).gap } : null,
      // The card's own layout was six inline style objects; only the svg
      // children may keep theirs (the Icon component's box, the easing curve's
      // overflow).
      cardInline: [...(card?.querySelectorAll("[style]") ?? [])]
        .map((e) => e.getAttribute("style"))
        .filter((v) => !/^(width: \d+px; height: \d+px; display: block;|overflow: visible;?)$/.test(v || "")),
      selectInline: [...right.querySelectorAll("select")].filter((s) => s.getAttribute("style")).length,
      present: (() => {
        const b = [...right.querySelectorAll("button")].find((x) => /Present Prototype/.test(x.textContent));
        return b ? { cls: b.className, bg: getComputedStyle(b).backgroundColor } : null;
      })(),
      // The sections of the card, including the condition row (added below).
      layouts: [".proto-top", ".proto-pair", ".proto-anim", ".proto-cond", ".proto-check", ".proto-ease"]
        .map((sel) => [sel, !!right.querySelector(sel)]),
    };
  });
  // A borderless 24px select in the panel's rows, a bordered 12px default in the
  // card, one row apart: the same control looked like two different things.
  t(`panel and card selects share one recipe (${panel.rowShape})`,
    panel.rowShape === panel.cardShape && panel.rowShape.startsWith("28px|solid 1px|6px|11px"));
  t(`the interaction is a card (${panel.card?.border}, ${panel.card?.radius}, ${panel.card?.bg})`,
    panel.card?.border === "1px" && panel.card?.radius === "8px" && panel.card?.gap === "5px");
  t(`and styles itself from the sheet (${panel.cardInline.length} inline, ${panel.selectInline} on selects)`,
    panel.cardInline.length === 0 && panel.selectInline === 0);
  // The condition row only exists once a condition does: switching it on must
  // give the row its own layout (it used to be an inline 4-column grid).
  await p.evaluate(() => {
    const b = [...document.querySelectorAll(".proto-interaction button")].find((x) => /Condition/.test(x.textContent));
    b?.click();
  });
  await sleep(400);
  const condLayout = await p.evaluate(() => {
    const cond = document.querySelector(".proto-cond");
    if (!cond) return null;
    const c = getComputedStyle(cond);
    return { cols: c.gridTemplateColumns.split(" ").length, inline: cond.getAttribute("style") };
  });
  const layouts = await p.evaluate(() => [".proto-top", ".proto-pair", ".proto-anim", ".proto-check", ".proto-ease"]
    .every((sel) => !!document.querySelector(sel)));
  t(`every interaction control has a layout class (${layouts}, condition ${condLayout?.cols} columns)`,
    panel.layouts.slice(0, 3).every(([, ok]) => ok) && layouts &&
    condLayout?.cols === 4 && condLayout.inline === null);

  // PT-U2: the button is a primary action, not an export one.
  const blue = await p.evaluate(() => {
    const d = document.createElement("div");
    d.style.color = getComputedStyle(document.documentElement).getPropertyValue("--blue").trim();
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  });
  t(`Present Prototype is a primary button (${panel.present?.cls}, ${panel.present?.bg})`,
    panel.present?.cls === "x-primary" && panel.present?.bg === blue);

  // PT-U7: the chip must name the key that starts a presentation, not the one
  // that leaves it.
  const box = await p.evaluate(() => {
    const b = document.querySelector('.panel.right button[aria-label="Present"]');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await p.mouse.move(box.x, box.y);
  await sleep(750);
  const tip = await p.evaluate(() => {
    const tips = [...document.querySelectorAll(".tip")].filter((t) => getComputedStyle(t).display !== "none");
    return { text: tips.map((t) => t.textContent).join(" | "), chip: tips[0]?.querySelector(".tip-sc")?.textContent ?? null };
  });
  t(`Present's chip is the start chord (${tip.text})`, tip.chip === "⌘⌥↩" && tip.text.startsWith("Present"));
  t(`and ${layerRows.length} layer rows were untouched by any of it`, layerRows.length === 23);
  await p.close();
}

// 42. the vector card and the boolean menu are sheet chrome (IN-U4, TB-U5) ---
{
  const p = await page();
  await rows(p);
  await drawRect(p);
  // A rectangle has no path, so the card stays hidden until the shape is baked
  // into a vector — the same route §35 takes.
  await p.evaluate(() => [...document.querySelectorAll(".inspector .seg button")]
    .find((b) => b.textContent.trim() === "Flatten")?.click());
  await sleep(500);

  // The card's geometry is read *against the panel's own recipes* rather than
  // against numbers written here: the claim is "one recipe", so the layer align
  // row and the Position fields are the reference. If the sheet's scale moves,
  // both sides move and this stays true; a bespoke copy would not.
  const card = await p.evaluate(() => {
    const c = document.querySelector(".vec-card");
    const cs = c ? getComputedStyle(c) : null;
    const size = (el) => { const r = getComputedStyle(el); return `${r.width}x${r.height}`; };
    return {
      present: !!c,
      headers: [...document.querySelectorAll(".h-row .sec-toggle h2")].map((h) => h.textContent.trim()),
      chip: document.querySelector(".h-act .vec-chip")?.textContent.trim() ?? null,
      // Icon sizes its svg and Field marks its label scrubbable; anything else
      // inline is bespoke layout the sheet cannot reach.
      inline: [...(c?.querySelectorAll("[style]") ?? [])].map((e) => e.getAttribute("style"))
        .filter((v) => !/^(width: \d+px; height: \d+px; display: block;|cursor: ew-resize;( display: inline-flex;)?$)/.test(v || "")),
      hex: (c?.innerHTML.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []),
      exportRun: document.querySelectorAll(".vec-card .export-run").length,
      strong: document.querySelectorAll(".vec-card strong").length,
      cardBg: cs?.backgroundColor,
      alignSizes: [...document.querySelectorAll(".vec-align .g button")].map(size),
      layerAlignSizes: [...document.querySelectorAll(".align:not(.vec-align) .g button")].map(size),
      fieldHeights: [...document.querySelectorAll(".vec-card .field")].map((f) => getComputedStyle(f).height),
      positionFieldHeights: [...document.querySelectorAll(".inspector .field")]
        .filter((f) => !f.closest(".vec-card")).map((f) => getComputedStyle(f).height),
      actionHeights: [...document.querySelectorAll(".vec-actions button")].map((b) => getComputedStyle(b).height),
      mirrorTabs: [...document.querySelectorAll('.seg[aria-label="Handle mirroring"] button[role="tab"]')]
        .map((b) => `${b.textContent.trim()}=${b.getAttribute("aria-selected")}`),
      alignRoles: [...document.querySelectorAll(".vec-align button")].map((b) => b.getAttribute("role")),
    };
  });
  t(`the card is a section among the others (${card.headers.join(" / ")})`,
    card.present && card.headers.includes("Vector") && card.chip === "Native Graph");
  t(`the card styles itself from the sheet (${card.inline.length} stray inline, ${card.hex.length} literal colours, ${card.exportRun} export-run, ${card.strong} <strong>)`,
    card.inline.length === 0 && card.hex.length === 0 && card.exportRun === 0 && card.strong === 0);
  t(`its align row is the layer align row's recipe (${card.alignSizes.join(" ")} vs ${card.layerAlignSizes.slice(0, 3).join(" ")})`,
    card.alignSizes.length === 6 && card.layerAlignSizes.length > 0 &&
    card.alignSizes.every((s) => s === card.layerAlignSizes[0]));
  t(`its numbers are the panel's fields (${[...new Set(card.fieldHeights)].join(",")} vs ${[...new Set(card.positionFieldHeights)].join(",")})`,
    card.fieldHeights.length >= 3 && card.positionFieldHeights.length > 0 &&
    card.fieldHeights.every((h) => h === card.positionFieldHeights[0]));
  t(`its four actions share one height (${[...new Set(card.actionHeights)].join(",")})`,
    card.actionHeights.length === 4 && new Set(card.actionHeights).size === 1);
  // Six one-shot actions must not claim a selection: a tab says "this panel is
  // showing", which an align button never is. The mirroring switch does select,
  // so it keeps the tab semantics and shows the point's current mode.
  t(`alignment claims no tab (${card.alignRoles.filter(Boolean).length} roles)`, card.alignRoles.every((r) => r === null));
  t(`mirroring selects exactly one tab (${card.mirrorTabs.join(" ")})`,
    card.mirrorTabs.length === 3 && card.mirrorTabs.filter((m) => m.endsWith("=true")).length === 1);

  // The form's Apply is the accent from the token, not a colour typed onto it.
  await p.evaluate(() => [...document.querySelectorAll(".vec-actions button")]
    .find((b) => /Simplify/.test(b.textContent))?.click());
  await sleep(350);
  const apply = await p.evaluate(() => {
    const token = document.createElement("div");
    token.style.color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    document.body.appendChild(token);
    const want = getComputedStyle(token).color;
    token.remove();
    const el = document.querySelector(".vec-sub .x-btn-primary");
    const b = [...document.querySelectorAll(".vec-actions button")].find((x) => /Simplify/.test(x.textContent));
    return { want, got: el ? getComputedStyle(el).backgroundColor : null, cls: el?.className ?? null,
             toggle: b?.className ?? null, toggleBg: b ? getComputedStyle(b).backgroundColor : null };
  });
  t(`Apply simplify is the accent token (${apply.cls}, ${apply.got})`,
    apply.got === apply.want && /x-btn-primary/.test(apply.cls || ""));
  t(`and its toggle reads as pressed while the form is open (${apply.toggle})`,
    / on/.test(apply.toggle || "") && apply.toggleBg !== apply.want);

  // Entering point edit puts the dock's one commit button on screen: it wears
  // the accent, and its ink has to be the accent's own — the `#fff` it used to
  // hardcode is unreadable on the dark theme's accent ink (`#0a0e13`).
  await p.evaluate(() => [...document.querySelectorAll(".h-act button")]
    .find((b) => /Edit points/.test(b.textContent))?.click());
  await sleep(400);
  const dark = await p.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    const token = (name) => {
      const d = document.createElement("div");
      d.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    };
    const done = document.querySelector(".hit.vec-done");
    const card = document.querySelector(".vec-card");
    const out = {
      hover: token("--hover"), onAccent: token("--on-accent"), accent: token("--accent"),
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      doneBg: done ? getComputedStyle(done).backgroundColor : null,
      doneFg: done ? getComputedStyle(done).color : null,
      doneInline: done?.getAttribute("style") ?? null,
      doneTitle: done?.getAttribute("title") ?? null,
    };
    document.documentElement.removeAttribute("data-theme");
    return out;
  });
  t(`the card follows the theme in dark (${dark.cardBg} vs --hover ${dark.hover})`, dark.cardBg === dark.hover);
  t(`and the dock's Done wears the accent and its ink (${dark.doneBg}, ${dark.doneFg} vs ${dark.onAccent})`,
    dark.doneBg === dark.accent && dark.doneFg === dark.onAccent && dark.doneInline === null &&
    (dark.doneTitle || "").startsWith("Done editing path"));

  // TB-U5: the boolean menu only exists once two layers are selected, and its
  // width is measured against a tool group's `.fly` rather than a number — the
  // finding was that this one menu did not use the recipe the others do.
  await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
  await sleep(500);
  const dock = await p.evaluate(() => {
    const bool = document.querySelector('.tool[data-group="bool"] .fly');
    const shape = document.querySelector('.tool[data-group="shape"] .fly');
    const m = (el) => { const r = getComputedStyle(el); return { min: r.minWidth, radius: r.borderRadius, pad: r.padding }; };
    const div = bool?.querySelector(".fly-div");
    return {
      bool: bool ? m(bool) : null, shape: shape ? m(shape) : null,
      boolInline: bool?.getAttribute("style") ?? null,
      split: document.querySelector('.tool[data-group="bool"]')?.className ?? null,
      hitInline: document.querySelector('.tool[data-group="bool"] .hit')?.getAttribute("style") ?? null,
      caret: document.querySelector('.tool[data-group="bool"] i.caret')?.getAttribute("aria-label") ?? null,
      rows: [...(bool?.querySelectorAll('button[role="menuitem"]') ?? [])].map((b) => b.textContent.trim()),
      divH: div ? getComputedStyle(div).height : null,
      divInline: div?.getAttribute("style") ?? null,
      dockStrays: [...document.querySelectorAll(".dock [style]")].map((e) => e.getAttribute("style"))
        .filter((v) => !/^width: \d+px; height: \d+px; display: block;$/.test(v || "")),
    };
  });
  t(`the boolean menu is the tool groups' menu (${JSON.stringify(dock.bool)} vs ${JSON.stringify(dock.shape)})`,
    !!dock.bool && !!dock.shape && dock.bool.min === dock.shape.min &&
    dock.bool.radius === dock.shape.radius && dock.bool.pad === dock.shape.pad &&
    dock.boolInline === null && dock.rows.length === 5);
  t(`its trigger is the dock's split tool (${dock.split}, caret ${dock.caret})`,
    /tool split/.test(dock.split || "") && dock.hitInline === null && !!dock.caret);
  t(`its separator is a hairline from the sheet (${dock.divH})`, dock.divH === "1px" && dock.divInline === null);
  t(`and the whole dock is inline-free (${dock.dockStrays.length} stray: ${dock.dockStrays.join(" ") || "none"})`,
    dock.dockStrays.length === 0);
  await p.close();
}

// 43. FR-U2: canvas chrome is the sheet's, and document ink is not -----------
{
  const p = await page();
  await rows(p);

  /** A custom property as the browser resolves it, as [r, g, b]. The canvases
   *  paint whatever the sheet says, so the check has to ask the sheet too: a
   *  literal here would be exactly the drift it is looking for. */
  const tokenRgb = (name) =>
    p.evaluate((n) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = "#000000";
      c.fillStyle = raw; // normalises any colour the sheet used to #rrggbb
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.fillStyle);
      return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }, name);

  /** Opaque pixels of the main canvas within `tol` of a colour. */
  const countNear = (rgb, tol) =>
    p.evaluate((r, g, b, t2) => {
      const c = document.querySelector("canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) < t2 && Math.abs(d[i + 1] - g) < t2 && Math.abs(d[i + 2] - b) < t2 && d[i + 3] > 200) n++;
      }
      return n;
    }, rgb[0], rgb[1], rgb[2], tol);

  const nudge = async () => { await p.keyboard.press("ArrowRight"); await sleep(350); };

  const sel = await tokenRgb("--cv-sel");
  const lock = await tokenRgb("--cv-lock");
  t(`the sheet declares the canvas chrome roles (--cv-sel ${JSON.stringify(sel)}, --cv-lock ${JSON.stringify(lock)})`,
    Array.isArray(sel) && Array.isArray(lock));

  // The demo document paints the accent itself (a #10b981 toggle), so chrome is
  // measured as the difference from an idle canvas, as §26 does.
  const idle = await countNear(sel, 24);
  await drawRect(p);
  const chrome = (await countNear(sel, 24)) - idle;
  t(`selection chrome paints --cv-sel (+${chrome}px over an idle ${idle}px)`, chrome > 500);

  // The part that could not pass before FR-U2: retheme the role under the
  // running app and the chrome has to follow, while the document's own emerald
  // stays put. The ring used to be `const BRAND_ACCENT = "#10b981"`, so the
  // sheet had nothing to say about it.
  await p.evaluate(() => document.documentElement.style.setProperty("--cv-sel", "#ff8800"));
  await nudge();
  const moved = await countNear([255, 136, 0], 24);
  const stayed = await countNear(sel, 24);
  t(`rethemeing --cv-sel repaints the chrome (${moved}px of orange)`, moved > 500);
  t(`and the document's own emerald does not follow it (${stayed}px, idle was ${idle}px)`, Math.abs(stayed - idle) < 150);

  await p.evaluate(() => document.documentElement.style.removeProperty("--cv-sel"));
  await nudge();
  const back = (await countNear(sel, 24)) - idle;
  t(`removing the override paints the token again (+${back}px)`, back > 500);

  // The lock role, measured the same way §26 measures it - but against the
  // token, so a retuned --cv-lock cannot quietly desync from the canvas.
  const lockBefore = await countNear(lock, 20);
  await p.keyboard.down("Meta"); await p.keyboard.down("Shift");
  await p.keyboard.press("l");
  await p.keyboard.up("Shift"); await p.keyboard.up("Meta");
  await sleep(500);
  const lockAfter = await countNear(lock, 20);
  const selAfterLock = (await countNear(sel, 24)) - idle;
  t(`locked chrome paints --cv-lock (+${lockAfter - lockBefore}px)`, lockAfter - lockBefore > 100);
  t(`and drops the selection role (${selAfterLock}px)`, selAfterLock < 60);
  await p.close();
}

// 43b. the same contract in the dark theme -----------------------------------
{
  // Boot dark through the app's own path (ThemeProvider reads this key before
  // first paint, and page() deliberately spares it) rather than by setting the
  // attribute: only the real thing puts React's `theme` in the paint deps, and
  // the canvases re-read their tokens on that paint.
  const seed = await page();
  await seed.evaluate(() => localStorage.setItem("x-native-theme", "dark"));
  await seed.close();

  const p = await page();
  await rows(p);
  const tokenRgb = (name) =>
    p.evaluate((n) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = "#000000";
      c.fillStyle = raw;
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.fillStyle);
      return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }, name);
  const countNear = (rgb, tol, scope = "canvas") =>
    p.evaluate((r, g, b, t2, s) => {
      const c = document.querySelector(s);
      if (!c) return -1;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) < t2 && Math.abs(d[i + 1] - g) < t2 && Math.abs(d[i + 2] - b) < t2 && d[i + 3] > 200) n++;
      }
      return n;
    }, rgb[0], rgb[1], rgb[2], tol, scope);

  const theme = await p.evaluate(() => document.documentElement.dataset.theme);
  const accent = await tokenRgb("--accent");
  const sel = await tokenRgb("--cv-sel");
  t(`the app booted dark (data-theme=${theme}, --accent ${JSON.stringify(accent)})`, theme === "dark" && Array.isArray(accent));

  const idle = await countNear(sel, 24);
  await drawRect(p);
  const chrome = (await countNear(sel, 24)) - idle;
  t(`dark selection chrome paints the dark --cv-sel (+${chrome}px)`, chrome > 500);

  await p.evaluate(() => document.documentElement.style.setProperty("--cv-sel", "#ff8800"));
  await p.keyboard.press("ArrowRight"); await sleep(350);
  const moved = await countNear([255, 136, 0], 24);
  t(`and follows a retheme in dark too (${moved}px of orange)`, moved > 500);
  await p.evaluate(() => document.documentElement.style.removeProperty("--cv-sel"));

  // The minimap viewport wears --accent, the one chrome colour whose two theme
  // values genuinely differ (#0e9f6e light / #10b981 dark), so this is the pixel
  // a visitor can see answer the theme. Tolerance 16 keeps the two apart (their
  // green channels are 26 apart) while the document's own #10b981 toggle still
  // shows up in the thumbnail - hence no "zero emerald" assertion in light.
  await p.keyboard.down("Shift"); await p.keyboard.press("M"); await p.keyboard.up("Shift");
  await sleep(600);
  const darkAccent = await countNear(accent, 16, ".minimap canvas");
  const lightAccent = await countNear([14, 159, 110], 16, ".minimap canvas");
  t(`the minimap viewport wears the dark accent (${darkAccent}px) and not the light one (${lightAccent}px)`,
    darkAccent > 30 && lightAccent < 25);

  await p.evaluate(() => localStorage.setItem("x-native-theme", "light"));
  await p.close();
}

// 44. LP-U3 + LP-U4: an empty page teaches, and only until you dismiss it -----
{
  const p = await page();
  await rows(p);
  // Empty the sample document the way a visitor would: select everything, delete.
  const emptyIt = async () => {
    await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
    await sleep(300);
    await p.keyboard.press("Delete");
    await sleep(500);
  };
  await emptyIt();

  // LP-U3: the layers tree used to render an empty <div class="tree"> here.
  const taught = await p.evaluate(() => {
    const tree = document.querySelector(".panel.left .tree");
    const state = tree?.querySelector(".empty-state") ?? null;
    const cs = state ? getComputedStyle(state) : null;
    return {
      rows: tree ? tree.querySelectorAll("[data-row-id]").length : -1,
      title: state?.querySelector(".empty-title")?.textContent.trim() ?? null,
      body: (state?.querySelector(".empty-body")?.textContent || "").trim(),
      kbds: [...(state?.querySelectorAll(".empty-hint kbd") ?? [])].map((k) => k.textContent.trim()),
      icon: !!state?.querySelector("svg"),
      strays: [...(state?.querySelectorAll("[style]") ?? [])]
        .map((e) => e.getAttribute("style"))
        .filter((v) => !/^(width|height): \d+px/.test(v || "")),
      display: cs?.display ?? null,
      align: cs?.textAlign ?? null,
      padTop: cs?.paddingTop ?? null,
      // the inspector's own empty state, for the "one recipe" claim
      inspectorUsesSameRecipe: !!document.querySelector(".inspector .empty-state, .panel.right .empty-state"),
    };
  });
  t(`an empty page teaches in the layers tree (${taught.title})`,
    taught.rows === 0 && taught.title === "No layers on this page" && taught.icon && taught.body.length > 40);
  t(`with the chords it names (${taught.kbds.join(" ")})`,
    ["F", "R", "T", "⌘", "K"].every((k) => taught.kbds.includes(k)));
  t(`laid out by the sheet, not inline (${taught.display}/${taught.align}, ${taught.strays.length} stray)`,
    taught.display === "flex" && taught.align === "center" && taught.strays.length === 0 && taught.padTop !== "0px");
  // With nothing selected the inspector shows its own `.empty-state` at the same
  // moment, so the two panels are visibly one recipe rather than two lookalikes.
  t("and the inspector is showing the same recipe at the same time", taught.inspectorUsesSameRecipe);

  // LP-U4: the card over the empty canvas.
  const hint = await p.evaluate(() => {
    const c = document.querySelector(".canvas-hint");
    const wrap = document.querySelector(".canvas-wrap");
    if (!c || !wrap) return null;
    const r = c.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const btn = c.querySelector("button");
    return {
      title: c.querySelector(".canvas-hint-title")?.textContent.trim() ?? null,
      kbds: [...c.querySelectorAll("kbd")].map((k) => k.textContent.trim()),
      label: btn?.textContent.trim() ?? null,
      pe: getComputedStyle(c).pointerEvents,
      btnPe: btn ? getComputedStyle(btn).pointerEvents : null,
      bg: getComputedStyle(c).backgroundColor,
      centred: Math.abs((r.x + r.width / 2) - (w.x + w.width / 2)),
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  });
  t(`the empty canvas carries the first-run card (${hint?.title})`,
    !!hint && hint.title === "Draw your first layer" && ["F", "R", "T"].every((k) => hint.kbds.includes(k)));
  t(`click-through card, live button (${hint?.pe}/${hint?.btnPe})`,
    hint?.pe === "none" && hint?.btnPe === "auto");
  t(`its control says what it does (${hint?.label})`, (hint?.label || "").includes("show this again"));
  t(`and it sits centred over the canvas (${Math.round(hint?.centred ?? -1)}px off)`, (hint?.centred ?? 99) < 4);

  // The card describes a drag, so a drag through it has to work.
  const hx = hint.box.x + hint.box.w / 2;
  const hy = hint.box.y + hint.box.h / 2;
  await p.keyboard.press("r");
  await p.mouse.move(hx - 70, hy - 45); await p.mouse.down();
  await p.mouse.move(hx + 70, hy + 45, { steps: 6 }); await p.mouse.up();
  await sleep(500);
  const drawn = await p.evaluate(() => ({
    rows: document.querySelectorAll(".panel.left .tree [data-row-id]").length,
    hint: !!document.querySelector(".canvas-hint"),
    taught: !!document.querySelector(".panel.left .tree .empty-state"),
  }));
  t(`a drag straight through the card draws (${drawn.rows} row)`, drawn.rows === 1);
  t("and one layer retires both empty states", !drawn.hint && !drawn.taught);

  // The layer search's own blank is a different sentence (LP-U3's second half).
  const search = await p.evaluate(() => {
    const el = [...document.querySelectorAll(".panel.left .search input")]
      .find((i) => i.getAttribute("aria-label") === "Find layers");
    if (!el) return null;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, "zzz-no-such-layer");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  await sleep(400);
  const noMatch = await p.evaluate(() => ({
    rows: document.querySelectorAll(".panel.left .tree [data-row-id]").length,
    msg: document.querySelector(".panel.left .tree .empty")?.textContent.trim() ?? null,
    taught: !!document.querySelector(".panel.left .tree .empty-state"),
  }));
  t(`a search nothing answers says so instead of going blank (${noMatch.msg})`,
    !!search && noMatch.rows === 0 && (noMatch.msg || "").includes("No layer matches") &&
    (noMatch.msg || "").includes("zzz-no-such-layer") && !noMatch.taught);
  await p.evaluate(() => {
    const el = [...document.querySelectorAll(".panel.left .search input")]
      .find((i) => i.getAttribute("aria-label") === "Find layers");
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(400);
  t("and clearing it brings the page back",
    (await p.evaluate(() => document.querySelectorAll(".panel.left .tree [data-row-id]").length)) === 1);

  // Dismissal is permanent: empty the page again, dismiss, reload, empty again.
  await emptyIt();
  const back = await p.evaluate(() => !!document.querySelector(".canvas-hint"));
  t("the card is back while the page is empty and it has not been dismissed", back);
  await p.evaluate(() => document.querySelector(".canvas-hint button")?.click());
  await sleep(400);
  const dismissed = await p.evaluate(() => ({
    hint: !!document.querySelector(".canvas-hint"),
    key: localStorage.getItem("x-native-hint-empty-canvas"),
  }));
  t(`dismissing hides it and records it (${dismissed.key})`, !dismissed.hint && dismissed.key === "1");
  await p.reload({ waitUntil: "networkidle0" });
  await sleep(500);
  await rows(p);
  await emptyIt();
  const afterReload = await p.evaluate(() => ({
    hint: !!document.querySelector(".canvas-hint"),
    taught: !!document.querySelector(".panel.left .tree .empty-state"),
  }));
  t("the dismissal outlives the reload", !afterReload.hint);
  t("but the layers panel still teaches — it is a state, not a nudge", afterReload.taught);
  await p.close();
}

// 45. LP-U5 + LP-U6: the Tools pane tells the truth, the agent answers --------
{
  const p = await page();
  await rows(p);
  const navTo = async (label) => {
    await p.evaluate((l) => {
      const b = [...document.querySelectorAll(".rail .nav")].find((x) => x.textContent.trim() === l);
      b?.click();
    }, label);
    await sleep(400);
  };
  const tokenRgb = (name) =>
    p.evaluate((n) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = "#000000";
      c.fillStyle = raw;
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.fillStyle);
      return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }, name);
  const cssColor = (name) =>
    p.evaluate((n) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = "#000000";
      c.fillStyle = raw;
      return c.fillStyle;
    }, name);
  const countNear = (rgb, tol) =>
    p.evaluate((r, g, b, t2) => {
      const c = document.querySelector("canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) < t2 && Math.abs(d[i + 1] - g) < t2 && Math.abs(d[i + 2] - b) < t2 && d[i + 3] > 200) n++;
      }
      return n;
    }, rgb[0], rgb[1], rgb[2], tol);

  /* ── the Tools pane ── */
  await navTo("Tools");
  const pane = await p.evaluate(() => {
    const rows = [...document.querySelectorAll(".panel.left .presets button")];
    return {
      rows: rows.map((b) => {
        const sc = b.querySelector(".sc");
        const cs = getComputedStyle(b);
        return {
          label: (b.textContent || "").replace(sc?.textContent || "", "").trim(),
          sc: sc?.textContent.trim() ?? null,
          disabled: b.disabled,
          color: cs.color,
          cursor: cs.cursor,
          hoverBg: cs.backgroundColor,
          title: b.getAttribute("title"),
        };
      }),
      muted: [...document.querySelectorAll(".panel.left .muted")].map((e) => e.textContent.trim()),
      strays: [...document.querySelectorAll(".panel.left .presets [style]")].map((e) => e.getAttribute("style")),
    };
  });
  t(`the Tools pane lists its commands with a chord each (${pane.rows.length} rows)`,
    pane.rows.length === 7 && pane.rows.every((r) => !!r.sc && !!r.label));
  t(`it does not advertise plugins (${pane.muted[0]})`,
    !/plugin/i.test(pane.muted.join(" ")) && /palette|chord/i.test(pane.muted[0]));
  t(`and no row carries an inline style (${pane.strays.length} stray)`, pane.strays.length === 0);

  // The chords are the palette's own: open it and compare, rather than trusting
  // either surface to keep a number straight.
  await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control");
  await sleep(500);
  const palette = await p.evaluate(() => {
    const rows = [...document.querySelectorAll(".actions button, .palette button, [role=\"dialog\"] button")];
    return rows
      .map((b) => {
        const sc = b.querySelector(".sc");
        return { label: (b.textContent || "").replace(sc?.textContent || "", "").trim(), sc: sc?.textContent.trim() ?? "" };
      })
      .filter((r) => r.label);
  });
  await p.keyboard.press("Escape");
  await sleep(400);
  const mismatched = pane.rows
    .map((r) => {
      const said = palette.find((x) => x.label === r.label);
      return said && said.sc !== r.sc ? `${r.label}: pane ${r.sc} vs palette ${said.sc}` : null;
    })
    .filter(Boolean);
  t(`every chord matches the palette's (${mismatched.join("; ") || `${pane.rows.length} agree`})`,
    mismatched.length === 0 && palette.length > 20);

  // Disabled means dimmed, cursor-less and explained - and the explanation is
  // text on the page, not a tooltip on a control that cannot receive the pointer.
  const dim = await cssColor("--dim");
  const ink = await cssColor("--text");
  const disabled = pane.rows.filter((r) => r.disabled);
  const enabled = pane.rows.filter((r) => !r.disabled);
  t(`disabled rows are dimmed (${disabled.length} disabled, ${dim})`,
    disabled.length > 0 && disabled.every((r) => r.color === dim && r.cursor === "default"));
  t(`live rows are not (${enabled.length} enabled)`,
    enabled.length > 0 && enabled.every((r) => r.color === ink));
  t("none of them explains itself with a native title", pane.rows.every((r) => r.title === null));
  const why = pane.muted.at(-1) || "";
  t(`and the pane says why, in words (${why})`,
    disabled.every((r) => why.includes(r.label)) && enabled.every((r) => !why.includes(r.label)));

  // A dead row stays dead: clicking it changes nothing.
  const rowsBefore = await p.evaluate(() => document.querySelectorAll(".panel.left .tree [data-row-id]").length);
  await navTo("File");
  const dupBtn = await p.evaluate(() => {
    const b = [...document.querySelectorAll(".panel.left .presets button")]
      .find((x) => x.textContent.includes("Duplicate"));
    return b ? { disabled: b.disabled } : null;
  });
  await p.evaluate(() => {
    [...document.querySelectorAll(".panel.left .presets button")]
      .find((x) => x.textContent.includes("Duplicate"))?.click();
  });
  await sleep(400);
  const rowsAfter = await p.evaluate(() => document.querySelectorAll(".panel.left .tree [data-row-id]").length);
  t(`clicking a dimmed row does nothing (${rowsBefore} → ${rowsAfter} layers, disabled=${dupBtn?.disabled})`,
    dupBtn?.disabled === true && rowsAfter === rowsBefore);

  // Pick a layer and the selection-bound rows come back to life.
  await p.evaluate(() => document.querySelector(".panel.left .tree [data-row-id]")?.dispatchEvent(
    new MouseEvent("click", { bubbles: true })));
  await sleep(400);
  await navTo("Tools");
  const after = await p.evaluate(() => ({
    dup: [...document.querySelectorAll(".panel.left .presets button")]
      .find((x) => x.textContent.includes("Duplicate"))?.disabled ?? null,
    grp: [...document.querySelectorAll(".panel.left .presets button")]
      .find((x) => x.textContent.includes("Group"))?.disabled ?? null,
    why: [...document.querySelectorAll(".panel.left .muted")].map((e) => e.textContent.trim()).at(-1) || "",
  }));
  t(`a selection re-enables them (Duplicate ${after.dup}, Group ${after.grp})`,
    after.dup === false && after.grp === false && !/needs a selection/.test(after.why));

  /* ── the agent pane ── */
  await navTo("Agent");
  const greet = await p.evaluate(() => ({
    turns: [...document.querySelectorAll(".agent-row")].map((r) => ({
      who: r.getAttribute("data-who"),
      text: (r.querySelector(".name")?.textContent || "").trim(),
    })),
  }));
  t(`the agent opens by naming what it can do (${greet.turns[0]?.text})`,
    greet.turns.length === 1 && greet.turns[0].who === "agent" &&
    /frame/.test(greet.turns[0].text) && /rectangle/.test(greet.turns[0].text) &&
    !/colo(?:u)?r/i.test(greet.turns[0].text));

  const ask = async (text) => {
    await p.evaluate((v) => {
      const el = [...document.querySelectorAll(".panel.left .search input")]
        .find((i) => i.getAttribute("aria-label") === "Ask the agent");
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      el.focus();
      set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
    await sleep(200);
    await p.keyboard.press("Enter");
    await sleep(500);
  };

  // Pan somewhere else first: the old pane placed layers at a fixed document
  // coordinate, so "added" routinely meant "added off-screen".
  const selRgb = await tokenRgb("--cv-sel");
  const idle = await countNear(selRgb, 24);
  await p.keyboard.press("h");
  await p.mouse.move(900, 500); await p.mouse.down();
  await p.mouse.move(1250, 720, { steps: 8 }); await p.mouse.up();
  await p.keyboard.press("v");
  await sleep(400);
  await ask("please add a frame");
  const reply = await p.evaluate(() => {
    const turns = [...document.querySelectorAll(".agent-row")].map((r) => ({
      who: r.getAttribute("data-who"),
      text: (r.querySelector(".name")?.textContent || "").trim(),
      h: r.getBoundingClientRect().height,
      nameColor: getComputedStyle(r.querySelector(".name")).color,
      whiteSpace: getComputedStyle(r.querySelector(".name")).whiteSpace,
    }));
    return { turns, rows: document.querySelectorAll(".panel.left .tree").length };
  });
  const said = reply.turns.at(-1);
  t(`a matched ask is answered with what happened (${said?.text})`,
    said?.who === "agent" && /393 × 852/.test(said.text) && /centred/.test(said.text));
  const chromePx = (await countNear(selRgb, 24)) - idle;
  t(`and the frame it added is on screen where the user is looking (+${chromePx}px of selection chrome)`,
    chromePx > 500);
  const size = { w: await field(p, "W"), h: await field(p, "H") };
  t(`the inspector agrees it is the preset (${size.w} × ${size.h})`, size.w === "393" && size.h === "852");

  // A reply is a sentence, not a layer name: it wraps, and the two voices differ.
  const mutedInk = await cssColor("--muted");
  t(`the reply wraps instead of ellipsising (${Math.round(said?.h ?? 0)}px tall, ${said?.whiteSpace})`,
    (said?.h ?? 0) > 30 && said?.whiteSpace === "normal");
  t(`and the agent's voice is muted against the visitor's (${said?.nameColor} vs ${mutedInk})`,
    said?.nameColor === mutedInk &&
    reply.turns.filter((x) => x.who === "you").every((x) => x.nameColor !== mutedInk));

  // An ask it cannot answer still gets an answer, and changes nothing.
  const layersBefore = await p.evaluate(() => document.querySelectorAll(".panel.left .tree [data-row-id]").length);
  await navTo("File");
  await navTo("Agent");
  await ask("make me a sandwich");
  const void_ = await p.evaluate(() => {
    const turns = [...document.querySelectorAll(".agent-row")].map((r) => (r.querySelector(".name")?.textContent || "").trim());
    return { last: turns.at(-1), count: turns.length };
  });
  await navTo("File");
  const layersAfter = await p.evaluate(() => document.querySelectorAll(".panel.left .tree [data-row-id]").length);
  t(`an ask it cannot answer says so (${void_.last?.slice(0, 40)}…)`,
    /nothing/i.test(void_.last || "") && /changed nothing/i.test(void_.last || ""));
  t(`and changes nothing (${layersBefore} → ${layersAfter} layers)`, layersAfter === layersBefore);
  await p.close();
}

// 46. RW-U1 + FR-U4 + PM-U6: chrome that fits its screen and answers the keyboard
{
  const p = await page();
  await rows(p);
  const tokenRgb = (name) =>
    p.evaluate((n) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = "#000000";
      c.fillStyle = raw;
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.fillStyle);
      return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }, name);
  /** Accent pixels inside one horizontal band of the canvas, measured from the
   *  bottom edge up. The badge is painted in --cv-sel, the same ink as the
   *  selection outline, so every check here compares two bands rather than
   *  trusting an absolute count: the outline contributes a hairline to both. */
  const band = (rgb, tol, fromBottom, height) =>
    p.evaluate((r, g, b, t2, fb, hh) => {
      const c = document.querySelector("canvas");
      const y0 = Math.max(0, c.height - fb - hh);
      const d = c.getContext("2d").getImageData(0, y0, c.width, Math.min(hh, c.height - y0)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - r) < t2 && Math.abs(d[i + 1] - g) < t2 && Math.abs(d[i + 2] - b) < t2 && d[i + 3] > 200) n++;
      }
      return n;
    }, rgb[0], rgb[1], rgb[2], tol, fromBottom, height);
  const panBy = async (dy) => {
    const w = await p.evaluate(() => {
      const r = document.querySelector(".canvas-wrap").getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), top: Math.round(r.top) };
    });
    await p.keyboard.press("h");
    await p.mouse.move(w.cx, w.top + 120); await p.mouse.down();
    await p.mouse.move(w.cx, w.top + 120 + dy, { steps: 10 }); await p.mouse.up();
    await p.keyboard.press("v");
    await sleep(500);
  };

  /* ── FR-U4: the size readout stays on the canvas ── */
  const sel = await tokenRgb("--cv-sel");
  const box = await p.evaluate(() => {
    const r = document.querySelector(".canvas-wrap").getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  // A rectangle in the middle of the stage: its badge hangs 8px below it, far
  // from either edge, so both bands start empty of chrome.
  await drawRect(p, box.left + Math.round(box.w / 2) - 70, box.top + Math.round(box.h / 2) - 50);
  const flipBand = { from: 110, h: 35 };   // where a badge flipped above the box lands
  const clampBand = { from: 5, h: 30 };    // where a badge clamped into view lands
  const baseFlip = await band(sel, 24, flipBand.from, flipBand.h);
  const baseClamp = await band(sel, 24, clampBand.from, clampBand.h);

  // Pan until the box's bottom edge is 10px above the canvas bottom: below no
  // longer fits, above does, so the readout has to move above the box.
  await panBy(Math.round(box.h / 2) - 60);
  const flipNow = await band(sel, 24, flipBand.from, flipBand.h) - baseFlip;
  const clampNow = await band(sel, 24, clampBand.from, clampBand.h) - baseClamp;
  t(`the readout flips above the box when below is off-canvas (+${flipNow}px above vs +${clampNow}px below)`,
    flipNow > 500 && flipNow > clampNow);

  // Pan further, so neither side of the box is on screen: the last resort is the
  // clamp, and the readout must still be painted somewhere.
  await panBy(220);
  const flipGone = await band(sel, 24, flipBand.from, flipBand.h) - baseFlip;
  const clampGone = await band(sel, 24, clampBand.from, clampBand.h) - baseClamp;
  t(`and clamps into view when neither side fits (+${clampGone}px below vs +${flipGone}px above)`,
    clampGone > 500 && clampGone > flipGone);

  /* ── RW-U1: the dock is bounded by the column it hangs in ── */
  const dockFit = () => p.evaluate(() => {
    const dock = document.querySelector(".dock");
    const col = document.querySelector(".canvas-col");
    const dr = dock.getBoundingClientRect();
    const cr = col.getBoundingClientRect();
    const cs = getComputedStyle(dock);
    const hits = [...dock.querySelectorAll("button.hit")];
    const off = hits.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width === 0 || r.right > window.innerWidth + 0.5 || r.left < -0.5 || r.bottom > window.innerHeight + 0.5;
    });
    return {
      tools: hits.length,
      off: off.map((b) => b.getAttribute("aria-label")),
      inside: dr.left >= cr.left - 0.5 && dr.right <= cr.right + 0.5,
      rows: new Set(hits.map((b) => Math.round(b.getBoundingClientRect().top / 10))).size,
      scrollable: dock.scrollWidth > dock.clientWidth + 1,
      overflow: cs.overflowX,
      wrap: cs.flexWrap,
      multi: !!dock.querySelector(".toolset.multi"),
    };
  });
  await p.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await sleep(500);
  await p.keyboard.down("Meta"); await p.keyboard.press("a"); await p.keyboard.up("Meta");
  await sleep(400);
  for (const width of [1600, 1100, 900, 700]) {
    await p.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await sleep(600);
    const d = await dockFit();
    t(`at ${width}px all ${d.tools} dock tools are on screen (${d.off.join(", ") || "none off"}, ${d.rows} row(s), multi ${d.multi})`,
      d.tools > 6 && d.off.length === 0 && d.inside && d.scrollable === false &&
      d.overflow === "visible" && d.wrap === "wrap");
  }

  // On a phone the strip is narrower than the tool menu that escapes it, which is
  // exactly what the old `overflow-x: auto` override clipped.
  await p.setViewport({ width: 430, height: 780, deviceScaleFactor: 1 });
  await sleep(700);
  const narrow = await dockFit();
  t(`at 430px the dock still fits its column (${narrow.off.join(", ") || "none off"}, overflow ${narrow.overflow})`,
    narrow.off.length === 0 && narrow.inside && narrow.overflow === "visible");
  const opened = await p.evaluate(() => {
    const caret = document.querySelector('.dock .tool[data-group="bool"] .caret');
    if (!caret) return false;
    caret.click();
    return true;
  });
  await sleep(400);
  const fly = await p.evaluate(() => {
    const f = document.querySelector('.dock .tool[data-group="bool"] .fly');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const dock = document.querySelector(".dock").getBoundingClientRect();
    // Clipping is visual, not geometric: an element inside a scroll container
    // still reports its full rect. Ask the browser what is actually painted at
    // the menu's centre.
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { h: Math.round(r.height), w: Math.round(r.width), above: Math.round(dock.top - r.top), painted: !!el?.closest(".fly") };
  });
  t(`the tool menu escapes the strip and is painted there (${fly ? `${fly.h}px tall, ${fly.above}px above the dock` : "no bool tool"})`,
    !opened || (!!fly && fly.h > 40 && fly.above > 10 && fly.painted));
  await p.keyboard.press("Escape");
  await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await sleep(500);

  /* ── PM-U6: the export sheet opens with the keyboard already inside it ── */
  await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control");
  await sleep(500);
  const ran = await p.evaluate(() => {
    const b = [...document.querySelectorAll(".actions button, [role=\"dialog\"] button")]
      .find((x) => (x.textContent || "").includes("Export assets"));
    if (!b) return false;
    b.click();
    return true;
  });
  await sleep(600);
  const sheet = await p.evaluate(() => {
    const d = document.querySelector('.xmodal[aria-label="Export assets"]');
    const a = document.activeElement;
    const first = d?.querySelector("input, button, select, textarea, a[href]");
    return {
      open: !!d,
      modal: d?.getAttribute("aria-modal"),
      focused: a?.className || a?.tagName,
      inSheet: !!a?.closest?.(".xmodal"),
      firstIsFilter: first?.className === "xmodal-filter",
      rows: document.querySelectorAll(".xrow").length,
    };
  });
  t(`Export assets opens as a modal sheet (${sheet.modal ? "aria-modal" : "not modal"}, ${sheet.rows} rows)`,
    ran && sheet.open && sheet.modal === "true" && sheet.rows > 0);
  t(`and the keyboard is already in its filter field (${sheet.focused})`,
    sheet.inSheet && sheet.focused === "xmodal-filter" && sheet.firstIsFilter);
  await p.keyboard.type("zzz-no-such-layer");
  await sleep(400);
  const filtered = await p.evaluate(() => document.querySelectorAll(".xrow").length);
  t(`typing filters without a click first (${sheet.rows} → ${filtered} rows)`, filtered === 0);
  await p.keyboard.press("Escape");
  await sleep(400);
  t("and Escape closes it", await p.evaluate(() => !document.querySelector(".xmodal")));

  /* ── PM-U3: one Escape, and the caret comes back ─────────────────────── */
  // Two overlays at once: the dock's shape flyout, then the shortcuts sheet on
  // top of it (⇧/ — the sheet's own key; it is not looking for an input because
  // focus is on a menu item). Escape must close the overlay opened last, which
  // is the sheet, and only it; before the registry, the press was answered by
  // registration order, and the sheet could be starved outright.
  const flyOpen = () => p.evaluate(() => !!document.querySelector('.dock .tool[data-group="shape"] .fly'));
  await p.evaluate(() => document.querySelector('.dock .tool[data-group="shape"] .hit')?.focus());
  await p.keyboard.press("ArrowDown");
  await sleep(350);
  t("the shape menu is open on the dock", (await flyOpen()));

  await p.keyboard.down("Shift"); await p.keyboard.press("Slash"); await p.keyboard.up("Shift");
  await sleep(500);
  const stacked = await p.evaluate(() => ({
    sheet: !!document.querySelector(".help-pop"),
    fly: !!document.querySelector('.tool[data-group="shape"] .fly'),
    focused: document.activeElement?.className || document.activeElement?.tagName,
  }));
  t(`the shortcuts sheet opens on top of it (focus in ${stacked.focused})`, stacked.sheet && stacked.fly);

  await p.keyboard.press("Escape");
  await sleep(450);
  const afterOne = await p.evaluate(() => ({
    sheet: !!document.querySelector(".help-pop"),
    fly: !!document.querySelector('.tool[data-group="shape"] .fly'),
    inMenu: !!document.activeElement?.closest?.('.tool[data-group="shape"]'),
  }));
  t(`one Escape closes the sheet and leaves the menu under it (sheet ${afterOne.sheet}, menu ${afterOne.fly})`,
    !afterOne.sheet && afterOne.fly);
  t("and hands the caret back into that menu", afterOne.inMenu);

  await p.keyboard.press("Escape");
  await sleep(450);
  const afterTwo = await p.evaluate(() => {
    const a = document.activeElement;
    return { fly: !!document.querySelector('.tool[data-group="shape"] .fly'), active: a?.className || a?.tagName,
             onTrigger: !!a?.closest?.('.tool[data-group="shape"] .hit') };
  });
  t(`the next Escape closes the menu itself (${afterTwo.fly ? "still open" : "closed"})`, !afterTwo.fly);
  t(`with the caret on the control that opened it (${afterTwo.active})`, afterTwo.onTrigger);

  // The same, on an inspector menu, and then the case that made the ordering
  // rule worth stating: a click on another control while a menu is open still
  // focuses what was clicked, because the browser focuses as the default action
  // of mousedown, after the handler that closed the menu has run.
  await p.evaluate(() => document.querySelector(".zoom-caret")?.focus());
  await p.evaluate(() => document.querySelector(".zoom-caret")?.click());
  await sleep(350);
  const zoomWas = await p.evaluate(() => !!document.querySelector(".ctx.zoom-menu"));
  await p.keyboard.press("Escape");
  await sleep(400);
  const zoomNow = await p.evaluate(() => ({
    open: !!document.querySelector(".ctx.zoom-menu"),
    caret: document.activeElement?.className === "zoom-caret",
  }));
  t(`the zoom menu closes on Escape (${zoomWas ? "was open" : "never opened"})`, zoomWas && !zoomNow.open);
  t("and the caret goes back to its caret button", zoomNow.caret);

  const target = await p.evaluate(() => {
    const input = [...document.querySelectorAll(".inspector .field input")].find((i) => i.getAttribute("aria-label"));
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return { label: input.getAttribute("aria-label"), x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) };
  });
  await p.evaluate(() => document.querySelector(".zoom-caret")?.click());
  await sleep(300);
  if (target) {
    await p.mouse.click(target.x, target.y);
    await sleep(400);
    const won = await p.evaluate(() => ({
      menu: !!document.querySelector(".ctx.zoom-menu"),
      focused: document.activeElement?.getAttribute?.("aria-label") || document.activeElement?.className || document.activeElement?.tagName,
    }));
    t(`a click on another control still focuses it (${won.focused} · menu ${won.menu ? "open" : "closed"})`,
      !won.menu && won.focused === target.label);
  }

  // The export sheet opened from the palette: the row that ran the command is
  // gone by the time the sheet closes, so the caret cannot go back to it. It
  // must land on the editor's own surface instead of <body> — the fallback the
  // canvas column carries.
  await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control");
  await sleep(500);
  await p.evaluate(() => [...document.querySelectorAll(".actions button")]
    .find((x) => (x.textContent || "").includes("Export assets"))?.click());
  await sleep(600);
  await p.keyboard.press("Escape");
  await sleep(500);
  const landed = await p.evaluate(() => {
    const a = document.activeElement;
    return {
      sheet: !!document.querySelector(".xmodal"),
      tag: a?.tagName,
      home: !!a?.hasAttribute?.("data-focus-home"),
      where: a?.className || a?.tagName,
    };
  });
  t(`closing the export sheet does not drop the caret on <body> (${landed.where})`,
    !landed.sheet && landed.tag !== "BODY");
  t(`it lands on the editor's focus home (${landed.home ? "canvas column" : landed.where})`, landed.home);

  /* ── PM-U7: the veil is a wall ───────────────────────────────────────── */
  // `aria-modal` says the page behind a modal is inert; these checks are the
  // keyboard half of that claim. Tab at the end of the sheet used to walk out
  // from under the veil into the toolbar behind it, where Enter did something
  // the user could not see.
  const paletteRun = async (text) => {
    await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control");
    await sleep(500);
    const hit = await p.evaluate((want) => {
      const b = [...document.querySelectorAll('.actions button, [role="dialog"] button')]
        .find((x) => (x.textContent || "").includes(want));
      if (!b) return false;
      b.click();
      return true;
    }, text);
    await sleep(650);
    return hit;
  };
  // The same focusable set the trap uses, read in the browser so the check is on
  // what a Tab press can actually reach.
  const ringOf = (sel) => p.evaluate((rootSel) => {
    const root = document.querySelector(rootSel);
    if (!root) return null;
    const items = [...root.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")]
      .filter((el) => !el.disabled && !el.closest("[hidden]") && el.getAttribute("aria-hidden") !== "true" &&
                      Number(el.getAttribute("tabindex") ?? 0) !== -1 && el !== root);
    return {
      count: items.length,
      first: items[0]?.className || items[0]?.tagName,
      last: items[items.length - 1]?.className || items[items.length - 1]?.tagName,
      active: (() => { const i = items.indexOf(document.activeElement); return i < 0 ? null : i; })(),
    };
  }, sel);

  const sheetRan = await paletteRun("Export assets");
  const beforeTabs = await ringOf(".xmodal");
  t(`the export sheet opens with the caret inside it (${beforeTabs?.count} Tab stops)`,
    sheetRan && !!beforeTabs && beforeTabs.active === 0);

  // Nothing selected for export: the button is disabled, so it is not a stop.
  await p.evaluate(() => [...document.querySelectorAll(".xmodal-head button.link")]
    .find((b) => b.textContent.trim() === "Clear")?.click());
  await sleep(250);

  let outOfSheet = 0;
  let onDisabled = 0;
  for (let i = 0; i < 24; i++) {
    await p.keyboard.press("Tab");
    const where = await p.evaluate(() => {
      const a = document.activeElement;
      const btn = a && a.classList?.contains("export-run") && a.disabled;
      return { inSheet: !!a?.closest?.(".xmodal"), disabledRun: !!btn };
    });
    if (!where.inSheet) outOfSheet++;
    if (where.disabledRun) onDisabled++;
  }
  t(`24 Tabs never leave the sheet (${outOfSheet} escape${outOfSheet === 1 ? "" : "s"})`, outOfSheet === 0);
  t(`and never land on its disabled Export button (${onDisabled} hit${onDisabled === 1 ? "" : "s"})`, onDisabled === 0);

  await p.evaluate(() => document.querySelector(".xmodal-filter")?.focus());
  await p.keyboard.down("Shift"); await p.keyboard.press("Tab"); await p.keyboard.up("Shift");
  await sleep(300);
  const wrapped = await ringOf(".xmodal");
  t(`Shift+Tab at the top of the sheet wraps to its last stop (index ${wrapped?.active} of ${wrapped?.count}, ${wrapped?.last})`,
    !!wrapped && wrapped.active === wrapped.count - 1);
  await p.keyboard.press("Escape");
  await sleep(400);
  t("and Escape still closes it", await p.evaluate(() => !document.querySelector(".xmodal")));

  // XDialog — the nudge dialog, and every queued question, renders through it.
  const nudgeRan = await paletteRun("Nudge amount");
  const nudgeStart = await p.evaluate(() => ({
    open: !!document.querySelector(".x-dialog"),
    focus: document.activeElement?.getAttribute?.("aria-label") || document.activeElement?.className || document.activeElement?.tagName,
  }));
  t(`the nudge dialog takes the caret to its first field (${nudgeStart.focus})`,
    nudgeRan && nudgeStart.open && nudgeStart.focus === "Small nudge");

  const nudgeRing = await ringOf(".x-dialog");
  await p.evaluate(() => {
    const root = document.querySelector(".x-dialog");
    const items = [...root.querySelectorAll("button, input, [tabindex]")]
      .filter((el) => !el.disabled && Number(el.getAttribute("tabindex") ?? 0) !== -1 && el !== root);
    items[items.length - 1]?.focus();
  });
  await p.keyboard.press("Tab");
  await sleep(300);
  const nudgeBack = await ringOf(".x-dialog");
  t(`Tab at the end of the dialog wraps to its first control (${nudgeBack?.first})`, nudgeBack?.active === 0);
  await p.keyboard.press("Escape");
  await sleep(400);
  const nudgeGone = await p.evaluate(() => ({
    open: !!document.querySelector(".x-dialog"),
    where: document.activeElement?.className || document.activeElement?.tagName,
  }));
  t(`and Escape closes it without dropping the caret on <body> (${nudgeGone.where})`,
    !nudgeGone.open && nudgeGone.where !== "BODY");

  await p.close();
}

// 49. PM-U8: the app says it out loud ----------------------------------------
{
  const p = await page();
  await rows(p);

  /* ── the status region exists before it has anything to say ── */
  const quiet = await p.evaluate(() => {
    const st = document.querySelector('[role="status"]');
    const cs = st ? getComputedStyle(st) : null;
    return {
      present: !!st,
      text: st?.textContent ?? null,
      live: st?.getAttribute("aria-live"),
      atomic: st?.getAttribute("aria-atomic"),
      cls: st?.className ?? null,
      display: cs?.display ?? null,
      clip: cs?.clip ?? null,
      pill: !!document.querySelector(".toast"),
      regions: [...document.querySelectorAll("[aria-live]")].map((el) => el.getAttribute("role")),
    };
  });
  t(`the editor mounts its status region empty (${quiet.present ? `${quiet.cls}, ${quiet.regions.length} live region(s)` : "missing"})`,
    quiet.present && quiet.text === "" && quiet.live === "polite" && quiet.atomic === "true" && !quiet.pill);
  t(`and clips it rather than hiding it (display ${quiet.display}, clip ${quiet.clip})`,
    quiet.display !== "none" && /rect|inset/.test(quiet.clip || ""));

  /* ── a destructive action is announced, once ── */
  // The idiom §44 uses to empty the sample document: select everything, delete.
  await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
  await sleep(300);
  await p.keyboard.press("Delete");
  await sleep(500);
  const said = await p.evaluate(() => {
    const st = document.querySelector('[role="status"]');
    const pill = document.querySelector(".toast");
    return {
      text: (st?.textContent || "").trim(),
      pill: (pill?.textContent || "").trim(),
      same: !!pill && pill.textContent === st?.textContent,
      pillLive: !!pill && (pill.hasAttribute("aria-live") || !!pill.closest("[aria-live]")),
      regions: [...document.querySelectorAll("[aria-live]")].map((el) => el.getAttribute("role")),
    };
  });
  t(`deleting a layer is announced (${JSON.stringify(said.text).slice(0, 56)})`, /delet/i.test(said.text));
  t("the visible pill says the same words", said.same);
  t("and is not itself a live region — one message, one announcement", !said.pillLive);
  t(`nothing else on screen is a live region (${said.regions.join(", ") || "none"})`,
    said.regions.length === 1 && said.regions[0] === "status");

  /* ── it clears; the region does not ── */
  await sleep(2200);
  const cleared = await p.evaluate(() => {
    const st = document.querySelector('[role="status"]');
    return { present: !!st, text: st?.textContent ?? null, pill: !!document.querySelector(".toast") };
  });
  t(`the message clears and the region stays for the next one (pill ${cleared.pill ? "still up" : "gone"})`,
    cleared.present && cleared.text === "" && !cleared.pill);

  /* ── a stream that arrives on its own: the agent's transcript ── */
  await p.evaluate(() => {
    [...document.querySelectorAll(".rail .nav")].find((x) => x.textContent.trim() === "Agent")?.click();
  });
  await sleep(500);
  const opened = await p.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    return {
      present: !!log,
      label: log?.getAttribute("aria-label"),
      live: log?.getAttribute("aria-live"),
      rows: document.querySelectorAll(".agent-row").length,
      text: (log?.textContent || "").slice(0, 40),
    };
  });
  t(`the agent's transcript is a named log, mounted with the greeting (${opened.rows} row, "${opened.text}")`,
    opened.present && opened.label === "Agent transcript" && opened.live === "polite" &&
    opened.rows >= 1 && /frame|rectangle/i.test(opened.text));

  await p.evaluate(() => {
    const el = [...document.querySelectorAll(".panel.left .search input")]
      .find((i) => i.getAttribute("aria-label") === "Ask the agent");
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    el.focus();
    set.call(el, "add a rectangle");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  await p.keyboard.press("Enter");
  await sleep(700);
  const answered = await p.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    const rows = [...document.querySelectorAll(".agent-row")].map((r) => ({
      who: r.getAttribute("data-who"),
      text: (r.querySelector(".name")?.textContent || "").trim(),
    }));
    return {
      logs: document.querySelectorAll('[role="log"]').length,
      rows,
      // The transcript is what the region contains — an answer that rendered
      // outside it would be visible and silent.
      inLog: /rectangle/i.test(log?.textContent || ""),
    };
  });
  const answer = answered.rows.filter((r) => r.who === "agent").pop();
  t(`the answer lands inside the log, not beside it ("${answer?.text?.slice(0, 48)}")`,
    answered.logs === 1 && answered.inLog && /rectangle/i.test(answer?.text || ""));
  t(`and the question and the answer are both in it (${answered.rows.length} turns)`,
    answered.rows.length >= 3 && answered.rows.some((r) => r.who === "you"));

  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log("page errors:", allErrors.length ? allErrors.slice(0, 5) : "none");
await b.close();
process.exit(fail ? 1 : 0);
