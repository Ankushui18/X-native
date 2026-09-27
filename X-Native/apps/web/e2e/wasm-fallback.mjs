/** Actual dashboard upload with native assets absent. NOT a Rust execution test. */
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH || "/tmp/chromium",
  env: { ...process.env, LD_LIBRARY_PATH: process.env.CHROMIUM_LIBS || "/tmp/al2023/lib" },
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewport({ width: 1400, height: 950 });
  await page.setRequestInterception(true);
  page.on("request", (req) => /\/(?:wasm\/x_wasm\.js|x_geo\.wasm)(?:\?|$)/.test(req.url())
    ? req.respond({ status: 404, body: "WASM deliberately absent" }) : req.continue());
  await page.goto(process.env.APP_URL || "http://127.0.0.1:5173", { waitUntil: "networkidle0" });
  await page.waitForSelector('input[type="file"][accept=".fig,.sketch,.svg,.json"]');
  await page.evaluate(() => {
    const input = document.querySelector('input[type="file"][accept=".fig,.sketch,.svg,.json"]');
    const data = new DataTransfer();
    data.items.add(new File(['<svg width="200" height="120"><rect id="wasm-fallback-box" x="10" y="10" width="80" height="50" fill="#ff0000"/></svg>'], "wasm-fallback.svg", { type: "image/svg+xml" }));
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => location.hash.startsWith("#/file/"));
  await page.waitForSelector(".canvas-wrap");
  const check = await page.evaluate(() => {
    const id = location.hash.slice("#/file/".length);
    const doc = JSON.parse(localStorage.getItem(`x-native-doc:${id}`));
    const walk = (n) => n.name === "wasm-fallback-box" ? n : n.children?.map(walk).find(Boolean);
    const node = doc.pages.map((p) => walk(p.root)).find(Boolean);
    return { hasNode: !!node, w: node?.w, h: node?.h, fill: node?.fill };
  });
  assert.equal(check.hasNode, true, "actual dashboard upload persists the imported layer");
  assert.equal(check.w, 80); assert.equal(check.h, 50); assert.equal(check.fill.toLowerCase(), "#ff0000");
  console.log("PASS dashboard SVG upload -> bridge fallback -> editor -> persisted editable rectangle");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".canvas-wrap");
  assert.deepEqual(errors, []);
  console.log("PASS imported document reload; no uncaught browser errors with native assets missing");
} finally { await browser.close(); }
