// Behaviour suite: drives the running app and asserts on engine state / DOM,
// not on source. Re-created after the original /tmp harness was lost.
import puppeteer from "puppeteer-core";

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
  await (await p.$(".panel.left button.plus")).click();
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
  await (await p.$(".panel.left button.plus")).click();
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

console.log(`\n${pass} passed, ${fail} failed`);
console.log("page errors:", allErrors.length ? allErrors.slice(0, 5) : "none");
await b.close();
process.exit(fail ? 1 : 0);
