// One-shot profiler for pan jank: loads a blur-heavy doc, captures a CDP CPU
// profile across N wheel-pans, and reports top functions by self time plus
// per-wheel wall latency. Doc/launch/load logic mirrors fps.mjs (kept
// duplicated on purpose: this script mutates docs for experiments).
//
// Usage (from apps/web, with `vite preview` on :4173):
//   node tests/benchmarks/profile.mjs [--blurs 500] [--plain] [--wheels 5]
//                                      [--live] [--keys 10]
//                                      [--url http://localhost:4173] [--out prof.json]
// --live loads the 1k-boolean doc and profiles arrow-key nudges of one
// operand (the fps.mjs b-live path) instead of wheel pans. --live --plain
// nudges a plain rect in a 1k-rect doc (isolates panel cost from paintBoolean).
import puppeteer from "puppeteer-core";
import fs from "fs";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : def;
};
const BLURS = Math.max(1, Number(flag("blurs", "500")) || 500);
const PLAIN = args.includes("--plain");
const LIVE = args.includes("--live");
const WHEELS = Math.max(1, Number(flag("wheels", "5")) || 5);
const KEYS = Math.max(1, Number(flag("keys", "10")) || 10);
const URL = process.env.APP_URL || flag("url", "http://localhost:4173");
const OUT = flag("out", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCH = {
  executablePath: process.env.CHROMIUM_PATH || "/tmp/shot/bin/chromium",
  env: { ...process.env, LD_LIBRARY_PATH: process.env.CHROMIUM_LIBS || "/tmp/shot/ext/lib",
         FONTCONFIG_PATH: process.env.FONTCONFIG_PATH || "/tmp/shot/ext/fonts" },
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
         "--use-gl=swiftshader", "--in-process-gpu", "--disable-software-rasterizer"],
};

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
  return { fileName: "prof-b", pages: [{ id: "p1", name: "Page 1",
    root: { id: "root", kind: "frame", name: "Page", x: 0, y: 0, w: 6400, h: 4000, children: kids },
    comments: [], guides: [], pixelGrid: false, pixelGridColor: "#000000", flowStart: "" }],
    components: [], styles: [], page: 0, zoom: 1, panX: 0, panY: 0,
    showRulers: false, showMinimap: false, showComments: false };
}

const FILLS = ["#0ea5e9", "#10b981", "#f59e0b", "#ef4444"];
function buildDoc(n, plain) {
  const cols = Math.ceil(Math.sqrt(n * 1.2));
  const rows = Math.ceil(n / cols);
  const kids = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const node = { id: `d${i}`, kind: "rect", name: `d${i}`,
      x: c * 120 + 15, y: r * 120 + 25, w: 90, h: 70,
      fill: FILLS[i % 4], children: [] };
    if (!plain) node.effects = [{ kind: "layer-blur", color: "#000000", x: 0, y: 0,
      blur: 30, spread: 0, visible: true }];
    kids.push(node);
  }
  return { fileName: "prof", pages: [{ id: "p1", name: "Page 1",
    root: { id: "root", kind: "frame", name: "Page", x: 0, y: 0,
      w: cols * 120, h: rows * 120, children: kids },
    comments: [], guides: [], pixelGrid: false, pixelGridColor: "#000000", flowStart: "" }],
    components: [], styles: [], page: 0, zoom: 1, panX: 0, panY: 0,
    showRulers: false, showMinimap: false, showComments: false };
}

const browser = await puppeteer.launch({ ...LAUNCH, protocolTimeout: 240000 });
const p = await browser.newPage();
await p.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
try {
  await p.goto(`${URL}/favicon.ico`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await p.evaluate(() => { try {
    for (const k of Object.keys(localStorage))
      if (k.startsWith("x-native")) localStorage.removeItem(k);
  } catch {} });
  const doc = LIVE ? (PLAIN ? buildDoc(1000, true) : buildB()) : buildDoc(BLURS, PLAIN);
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.evaluate((json) => localStorage.setItem("x-native-doc:prof", json), JSON.stringify(doc));
  await p.goto(`${URL}/#/file/prof`, { waitUntil: "networkidle0", timeout: 90000 });
  await p.waitForSelector('canvas[aria-label="Design canvas"]', { timeout: 30000 });
  await sleep(2500);

  // How many blurred rects are actually on screen?
  const visible = await p.evaluate(() => {
    const els = document.querySelectorAll("canvas");
    return { canvases: els.length };
  }).catch(() => ({}));

  const box = await p.$eval('canvas[aria-label="Design canvas"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await p.mouse.move(box.x, box.y);

  if (LIVE) {
    // Same verified prelude as fps.mjs b-live: focus, select-all, Tab to
    // one boolean, Enter to drill in — an arrow must change pixels.
    let engaged = false;
    for (let attempt = 0; attempt < 3 && !engaged; attempt++) {
      await p.mouse.click(box.x, box.y);
      await sleep(500);
      await p.keyboard.down("Control");
      await p.keyboard.press("a");
      await p.keyboard.up("Control");
      await sleep(500);
      await p.keyboard.press("Tab");
      await sleep(500);
      await p.keyboard.press("Enter");
      await sleep(500);
      if (PLAIN) { engaged = true; break; }
      const a = await p.screenshot();
      await p.keyboard.press("ArrowRight");
      await sleep(400);
      const b = await p.screenshot();
      engaged = !a.equals(b);
    }
    if (!engaged) throw new Error("live prelude failed 3x: arrows move no pixels");
  }
  await p.evaluate(() => {
    const w = window;
    w.__prof = { t: [], writes: 0, runs: true };
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (typeof k === "string" && k.startsWith("x-native-doc:")) w.__prof.writes++;
      return real.call(this, k, v);
    };
    let last = performance.now();
    const tick = (now) => {
      if (!w.__prof.runs) return;
      w.__prof.t.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const session = await p.target().createCDPSession();
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 100 });
  await session.send("Profiler.start");
  const walls = [];
  if (LIVE) {
    let right = true;
    for (let i = 0; i < KEYS; i++) {
      const t0 = Date.now();
      await p.keyboard.press(right ? "ArrowRight" : "ArrowLeft");
      walls.push(Date.now() - t0);
      right = !right;
      await sleep(150);
    }
  } else {
    let dir = 1;
    for (let i = 0; i < WHEELS; i++) {
      const t0 = Date.now();
      await p.mouse.wheel({ deltaY: 500 * dir });
      walls.push(Date.now() - t0);
      dir = -dir;
      await sleep(400);
    }
  }
  const { profile } = await session.send("Profiler.stop");
  await sleep(LIVE ? 8000 : 0); // let debounced autosave fire (engagement check)
  const mini = await p.evaluate(() => {
    window.__prof.runs = false;
    return { deltas: window.__prof.t.slice(1), writes: window.__prof.writes };
  });
  const frames = mini.deltas.slice().sort((x, y) => x - y);
  const fmean = frames.reduce((x, y) => x + y, 0) / (frames.length || 1);
  const fp95 = frames.length ? frames[Math.min(frames.length - 1, Math.floor(0.95 * frames.length))] : 0;

  // Aggregate self hits by function.
  const byFn = new Map();
  for (const n of profile.nodes) {
    const hits = n.hitCount || 0;
    if (!hits) continue;
    const fn = n.callFrame.functionName || "(anon)";
    const url = (n.callFrame.url || "").split("/").pop() || "";
    const key = `${fn} @${url}:${n.callFrame.lineNumber}`;
    byFn.set(key, (byFn.get(key) || 0) + hits);
  }
  const total = [...byFn.values()].reduce((a, b) => a + b, 0);
  console.log(`\nmode=${LIVE ? "live" : "pan"} blurs=${PLAIN ? 0 : BLURS} ` +
    `wall/op=[${walls.join(",")}]ms total=${walls.reduce((a, b) => a + b, 0)}ms samples=${total}`);
  console.log(`frames=${frames.length} mean=${fmean.toFixed(1)}ms p95=${fp95.toFixed(1)}ms writes=${mini.writes}`);
  console.log("top self-time functions:");
  for (const [k, v] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
    console.log(`  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ blurs: PLAIN ? 0 : BLURS, walls, profile }, null, 1)); console.log(`wrote ${OUT}`); }
} finally {
  await browser.close().catch(() => {});
}
