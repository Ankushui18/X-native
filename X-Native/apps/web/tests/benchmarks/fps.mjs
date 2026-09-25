// FPS benchmark: drives the running app in headless Chromium and measures true
// rAF frame times, long tasks, and heap on heavy documents. Complements the
// engine-throughput suite in src/engine/__tests__/benchmark.mjs (`npm run bench`),
// which cannot see paint, compositing, or React costs.
//
// Usage (from apps/web):
//   node tests/benchmarks/fps.mjs [--scenario a|b|blive|d|all] [--seconds 8]
//                                  [--url http://localhost:5173] [--out results.json]
//
// Chromium discovery mirrors e2e/behaviour.mjs: CHROMIUM_PATH / CHROMIUM_LIBS,
// defaulting to a @sparticuz/chromium extract under /tmp/shot. APP_URL overrides --url.
//
// Documents are injected through the same localStorage slot the app itself
// uses (engine/files.ts `x-native-doc:<id>`), in the sparse-seed form the
// loader backfills via reviveNode — no test hooks in the app, no UI changes.
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : def;
};
const SCENARIO = flag("scenario", "all");
const SECONDS = Math.max(3, Number(flag("seconds", "8")) || 8);
const URL = process.env.APP_URL || flag("url", "http://localhost:5173");
const OUT = flag("out", "");
const SHOTS = path.join(HERE, ".shots");
fs.mkdirSync(SHOTS, { recursive: true });

const LAUNCH = {
  executablePath: process.env.CHROMIUM_PATH || "/tmp/shot/bin/chromium",
  env: {
    ...process.env,
    LD_LIBRARY_PATH: process.env.CHROMIUM_LIBS || "/tmp/shot/ext/lib",
    FONTCONFIG_PATH: process.env.FONTCONFIG_PATH || "/tmp/shot/ext/fonts",
  },
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
         "--use-gl=swiftshader", "--in-process-gpu", "--disable-software-rasterizer"],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sparse document builders. reviveNode backfills every field we omit, so seeds
// stay small enough for localStorage (scenario A is ~1.1MB of JSON).
// ---------------------------------------------------------------------------
function seed(id, name, root, zoom) {
  return {
    fileName: name,
    pages: [{ id: "p1", name: "Page 1", root, comments: [], guides: [],
              pixelGrid: false, pixelGridColor: "#000000", flowStart: "" }],
    components: [], styles: [], page: 0, zoom, panX: 0, panY: 0,
    showRulers: false, showMinimap: false, showComments: false,
  };
}
const FILLS = ["#0ea5e9", "#10b981", "#f59e0b", "#ef4444"];

const GRID_N = Number(process.env.FPS_GRID || "100");
function buildA() {
  const kids = [];
  let i = 0;
  for (let r = 0; r < GRID_N; r++)
    for (let c = 0; c < GRID_N; c++, i++)
      kids.push({ id: `r${i}`, kind: "rect", name: `r${i}`,
                  x: c * 64 + 4, y: r * 42 + 4, w: 56, h: 34,
                  fill: FILLS[i % 4], children: [] });
  return seed("bench-a", "bench-a", { id: "root", kind: "frame", name: "Page",
    x: 0, y: 0, w: GRID_N * 64, h: GRID_N * 42, children: kids }, 1);
}

// A union-shaped octagon: what the app itself bakes (n.path) when two
// overlapping rects are unioned. The static B run paints these pre-baked
// paths, which is exactly the app's steady state — booleans bake on edit.
const BAKED_UNION = [
  { x: 0, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 0 }, { x: 100, y: 0 },
  { x: 100, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 100 }, { x: 100, y: 100 },
  { x: 100, y: 120 }, { x: 20, y: 120 }, { x: 20, y: 100 }, { x: 0, y: 100 },
];
const OPS = ["union", "subtract", "intersect", "exclude"];

function buildB() {
  const kids = [];
  let i = 0;
  for (let r = 0; r < 25; r++)
    for (let c = 0; c < 40; c++, i++)
      kids.push({
        id: `b${i}`, kind: "boolean", name: `b${i}`, booleanOp: OPS[i % 4],
        x: c * 160 + 20, y: r * 160 + 20, w: 120, h: 120,
        fill: FILLS[i % 4], path: BAKED_UNION, closed: true,
        children: [
          { id: `b${i}a`, kind: "rect", name: `b${i}a`, x: 0, y: 20, w: 100, h: 80, children: [] },
          { id: `b${i}b`, kind: "rect", name: `b${i}b`, x: 20, y: 0, w: 80, h: 100, children: [] },
        ],
      });
  return seed("bench-b", "bench-b", { id: "root", kind: "frame", name: "Page",
    x: 0, y: 0, w: 6400, h: 4000, children: kids }, 1);
}

function buildD() {
  const kids = [];
  let i = 0;
  for (let r = 0; r < 20; r++)
    for (let c = 0; c < 25; c++, i++)
      kids.push({ id: `d${i}`, kind: "rect", name: `d${i}`,
                  x: c * 120 + 15, y: r * 120 + 25, w: 90, h: 70,
                  fill: FILLS[i % 4], children: [],
                  effects: [{ kind: "layer-blur", color: "#000000", x: 0, y: 0,
                              blur: 30, spread: 0, visible: true }] });
  return seed("bench-d", "bench-d", { id: "root", kind: "frame", name: "Page",
    x: 0, y: 0, w: 3000, h: 2400, children: kids }, 1);
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
function stats(deltas) {
  // Drop the first sample: it spans sampler install, not a real frame.
  const s = [...deltas].slice(1).sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return { frames: s.length, fps: mean ? 1000 / mean : 0, mean, p50: q(0.5),
           p95: q(0.95), max: s.length ? s[s.length - 1] : 0,
           dropped: s.filter((d) => d > 50).length };
}

async function freshPage(browser) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e?.message || e)));
  p.on("console", (m) => {
    // The app's wheel handler calls preventDefault through React's passive
    // listener, which logs on every wheel event (pan still works — only the
    // default-prevent is dropped). Counted separately in the report, not here.
    if (m.type() !== "error" || m.text().includes("favicon") || m.text().includes("404") ||
        m.text().includes("passive event listener")) return;
    errors.push("console: " + m.text().slice(0, 200));
  });
  await p.goto(`${URL}/favicon.ico`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await p.evaluate(() => {
    try {
      for (const k of Object.keys(localStorage))
        if (k.startsWith("x-native")) localStorage.removeItem(k);
    } catch {}
  });
  return { p, errors };
}

async function loadDoc(p, docId, doc, errors) {
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.evaluate((id, json) => {
    localStorage.setItem(`x-native-doc:${id}`, json);
  }, docId, JSON.stringify(doc));
  await p.goto(`${URL}/#/file/${docId}`, { waitUntil: "networkidle0", timeout: 90000 });
  try {
    await p.waitForSelector('canvas[aria-label="Design canvas"]', { timeout: 30000 });
  } catch (e) {
    const diag = await p.evaluate((id) => ({
      canvases: document.querySelectorAll("canvas").length,
      body: document.body.innerText.slice(0, 200),
      keys: Object.keys(localStorage).join(","),
      docLen: (localStorage.getItem(`x-native-doc:${id}`) || "").length,
    }), docId).catch(() => ({}));
    console.log("LOAD-FAIL diagnostics:", JSON.stringify(diag).slice(0, 500));
    console.log("LOAD-FAIL errors:", JSON.stringify((errors || []).slice(0, 5)));
    throw e;
  }
  await sleep(2500); // first paint + React settle
}

async function sampler(p) {
  await p.evaluate(() => {
    const w = window;
    w.__fps = { t: [], long: 0, heap0: 0, runs: true, writes: 0, wticks: [], mem: false };
    try { w.__fps.heap0 = performance.memory.usedJSHeapSize; w.__fps.mem = true; } catch {}
    try {
      new PerformanceObserver((l) => { w.__fps.long += l.getEntries().length; })
        .observe({ entryTypes: ["longtask"] });
    } catch {}
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (typeof k === "string" && k.startsWith("x-native-doc:")) { w.__fps.writes++; w.__fps.wticks.push(Math.round(performance.now())); }
      return real.call(this, k, v);
    };
    let last = performance.now();
    const tick = (now) => {
      if (!w.__fps.runs) return;
      w.__fps.t.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampler(p) {
  return p.evaluate(() => {
    const w = window;
    w.__fps.runs = false;
    let heap1 = 0;
    try { heap1 = performance.memory.usedJSHeapSize; } catch {}
    return { deltas: w.__fps.t, longtasks: w.__fps.long, mem: w.__fps.mem,
             heap0: w.__fps.heap0, heap1, writes: w.__fps.writes, wticks: w.__fps.wticks };
  });
}

async function drivePan(p, ms) {
  const box = await p.$eval('canvas[aria-label="Design canvas"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await p.mouse.move(box.x, box.y);
  const t0 = Date.now();
  const end = t0 + ms;
  const rtt = [];
  let dir = 1;
  while (Date.now() < end) {
    const w0 = Date.now();
    await p.mouse.wheel({ deltaY: 500 * dir });
    rtt.push(Date.now() - w0);
    dir = -dir;
    await sleep(250);
  }
  return { wallMs: Date.now() - t0, rtt };
}

// Live edit through the real stack, keyboard only: select-all, Tab to a single
// boolean, Enter to drill into its first operand, then nudge it back and forth.
// Every nudge is a real move command + repaint + autosave.
async function driveLive(p, ms) {
  const box = await p.$eval('canvas[aria-label="Design canvas"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  // Prelude with engagement verification: Tab/Enter occasionally misses,
  // which would silently measure idle instead of live-edit. An arrow must
  // change pixels, else retry (max 3) and then fail loudly.
  let engaged = false;
  for (let attempt = 0; attempt < 3 && !engaged; attempt++) {
    await p.mouse.click(box.x, box.y); // focus the canvas
    await sleep(500);
    await p.keyboard.down("Control");
    await p.keyboard.press("a");
    await p.keyboard.up("Control");
    await sleep(500);
    await p.keyboard.press("Tab");
    await sleep(500);
    await p.keyboard.press("Enter");
    await sleep(500);
    const a = await p.screenshot();
    await p.keyboard.press("ArrowRight");
    await sleep(400);
    const b = await p.screenshot();
    engaged = !a.equals(b);
  }
  if (!engaged) throw new Error("b-live prelude failed 3x: arrows move no pixels");
  const t0 = Date.now();
  const end = t0 + ms;
  let n = 0;
  let right = true;
  while (Date.now() < end) {
    await p.keyboard.press(right ? "ArrowRight" : "ArrowLeft");
    right = !right;
    n++;
    await sleep(150);
  }
  return { keys: n, wallMs: Date.now() - t0 };
}

const SCENARIOS = {
  "a-pan":  { doc: "bench-a", build: buildA, drive: drivePan,  label: "A  10k rects, pan @zoom1" },
  "a-full": { doc: "bench-a", build: () => ({ ...buildA(), zoom: 0.25 }), drive: drivePan, label: "A  10k rects, pan @zoom0.25 (all visible)" },
  "b-pan":  { doc: "bench-b", build: buildB, drive: drivePan,  label: "B  1k live booleans, pan @zoom1" },
  "b-full": { doc: "bench-b", build: () => ({ ...buildB(), zoom: 0.25 }), drive: drivePan, label: "B  1k live booleans, pan @zoom0.25 (all visible)" },
  "b-live": { doc: "bench-b", build: buildB, drive: driveLive, label: "B  live nudge of a boolean operand" },
  "d-pan":  { doc: "bench-d", build: buildD, drive: drivePan,  label: "D  500 layer-blurs, pan @zoom1" },
};

async function runOne(browser, key) {
  const sc = SCENARIOS[key];
  const { p, errors } = await freshPage(browser);
  try {
    await loadDoc(p, sc.doc, sc.build(), errors);
    await sampler(p);
    const extra = await sc.drive(p, SECONDS * 1000);
    const raw = await stopSampler(p);
    await p.screenshot({ path: path.join(SHOTS, `${key}.png`) });
    const s = stats(raw.deltas);
    const rtt = extra && extra.rtt ? extra.rtt : [];
    const rttMax = rtt.length ? Math.max(...rtt) : 0;
    return { key, label: sc.label, ...s, longtasks: raw.longtasks,
             heap0MB: raw.heap0 / 1048576, heap1MB: raw.heap1 / 1048576, heap: !!raw.mem,
             docWrites: raw.writes, wticks: raw.wticks || [], keys: (extra && extra.keys) || 0,
             wallMs: (extra && extra.wallMs) || 0, rttMax, deltas: raw.deltas, pageerrors: errors };
  } finally {
    await p.close().catch(() => {});
  }
}

const keys = SCENARIO === "all" ? Object.keys(SCENARIOS)
  : SCENARIO === "a" ? ["a-pan", "a-full"]
  : SCENARIO === "b" ? ["b-pan", "b-full", "b-live"]
  : SCENARIOS[SCENARIO] ? [SCENARIO] : null;
if (!keys) { console.error(`unknown scenario: ${SCENARIO}`); process.exit(2); }

const browser = await puppeteer.launch({ ...LAUNCH, protocolTimeout: 240000 });
const results = [];
try {
  for (const k of keys) {
    process.stdout.write(`… ${SCENARIOS[k].label} (${SECONDS}s)\n`);
    try {
      results.push(await runOne(browser, k));
    } catch (e) {
      console.log(` scenario ${k} FAILED: ${String(e).split("\n")[0].slice(0, 160)}`);
      results.push({ key: k, label: SCENARIOS[k].label, failed: String(e).split("\n")[0].slice(0, 160) });
    }
  }
} finally {
  await browser.close().catch(() => {});
}

const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
console.log("\nkey     fps   n frm  mean   p50   p95   max  drop>50  longtask  heapΔMB  writes  keys  wallms errors");
for (const r of results) {
  if (r.failed) { console.log(`${r.key.padEnd(7)} FAILED ${r.failed}`); continue; }
  console.log(
    `${r.key.padEnd(7)} ${f1(r.fps).padStart(5)} ${String(r.frames).padStart(5)} ${f1(r.mean).padStart(5)} ${f1(r.p50).padStart(5)} ` +
    `${f1(r.p95).padStart(5)} ${String(Math.round(r.max)).padStart(5)} ${String(r.dropped).padStart(7)} ` +
    `${String(r.longtasks).padStart(8)} ${(r.heap ? f1(r.heap1MB - r.heap0MB) : "n/a").padStart(7)} ` +
    `${String(r.docWrites).padStart(6)} ${String(r.keys).padStart(5)} ${String(r.wallMs).padStart(6)} ${String(r.pageerrors.length).padStart(6)}`);
}
for (const r of results) {
  if (r.failed || !r.deltas) continue;
  const stalls = [];
  r.deltas.forEach((d, i) => { if (d > 500) stalls.push(`${i}:${Math.round(d)}`); });
  console.log(`[${r.key}] frames=${r.frames} rttMax=${r.rttMax}ms wticks=${JSON.stringify(r.wticks)} stalls[>500ms idx:ms]=${stalls.join(" ") || "none"}`);
}
const live = results.find((r) => r.key === "b-live");
if (live && live.docWrites === 0)
  console.log("\nWARNING: b-live produced 0 autosave writes — the edit path did not engage; treat its FPS as idle, not live-edit.");
for (const r of results)
  for (const e of (r.pageerrors || []).slice(0, 3)) console.log(`pageerror [${r.key}]: ${e}`);
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ url: URL, seconds: SECONDS,
    chromium: LAUNCH.executablePath, results }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
