// Targeted re-audit: real Canvas gestures and browser font metrics.
// Run against Vite with the same CHROMIUM_PATH/CHROMIUM_LIBS/APP_URL as behaviour.mjs.
// AUDIT_PERF=1 also measures pan frame intervals on deterministic load fixtures.
// This is not the full product suite, a native renderer test, or a Figma client comparison.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH || "/tmp/shot/bin/chromium",
  env: { ...process.env, LD_LIBRARY_PATH: process.env.CHROMIUM_LIBS || "/tmp/shot/ext/lib/lib" },
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--use-gl=swiftshader", "--in-process-gpu", "--disable-software-rasterizer"],
});
const results = [], errors = [], performance = [], diagnostics = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
try {
  const page = await browser.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await page.setViewport({ width: 1400, height: 950, deviceScaleFactor: 1 });
  await page.goto(process.env.APP_URL || "http://127.0.0.1:5173", { waitUntil: "networkidle0" });
  await page.evaluate(async () => {
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
    const { MemoryEngine, node, find } = await import("/src/engine/memory.ts");
    const { Canvas } = await import("/src/ui/Canvas.tsx");
    const { ThemeProvider } = await import("/src/ui/theme.tsx");
    const host = document.createElement("div");
    host.id = "parity-audit";
    host.style.cssText = "position:fixed;left:270px;top:60px;right:40px;bottom:50px;z-index:999;background:white";
    document.body.append(host);
    const root = createRoot(host);
    let sequence = 0;
    function Host({ engine }) {
      const snap = React.useSyncExternalStore(cb => engine.subscribe(cb), () => engine.snapshot());
      return React.createElement(ThemeProvider, null, React.createElement(Canvas, { engine, snap }));
    }
    window.audit = { node, find, mount(children, selected = []) {
      const engine = new MemoryEngine(false, { pages: [{ id: "qa", name: "QA", root: node("frame", "Root", 0, 0, 4000, 4000, { children }), guides: [], comments: [] }], page: 0, zoom: 1, panX: 0, panY: 0 });
      engine.dispatch({ type: "select", ids: selected });
      window.audit.engine = engine;
      root.render(React.createElement(Host, { key: ++sequence, engine }));
    } };
  });
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const reset = async (multi = true) => {
    await page.evaluate(multi => {
      const { node, mount } = window.audit;
      const a = node("rect", "A", 100, 100, 100, 100), b = node("rect", "B", 300, 100, 100, 100);
      mount(multi ? [a, b] : [a], multi ? [a.id, b.id] : [a.id]);
    }, multi);
    await page.waitForSelector("#parity-audit .canvas-wrap"); await settle();
  };
  await reset();
  const box = await page.$eval("#parity-audit .canvas-wrap", el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const state = () => page.evaluate(() => {
    const s = window.audit.engine.snapshot(); return { nodes: s.pages[0].root.children, selection: s.selection };
  });
  await page.mouse.move(box.x + 150, box.y + 150); await page.mouse.down();
  await page.keyboard.down("Control");
  await page.mouse.move(box.x + 170, box.y + 165, { steps: 3 }); await page.mouse.up();
  await page.keyboard.up("Control"); await settle();
  let s = await state();
  check("selected-member drag retains and moves both objects", s.selection.length === 2 && s.nodes[0].x === 120 && s.nodes[1].x === 320 && s.nodes.every(n => n.y === 115));
  await page.evaluate(() => window.audit.engine.dispatch({ type: "undo" })); await settle();
  s = await state(); check("multi-move undo restores both objects", s.nodes[0].x === 100 && s.nodes[1].x === 300);
  await page.evaluate(() => window.audit.engine.dispatch({ type: "redo" })); await settle();
  s = await state(); check("multi-move redo restores both objects", s.nodes[0].x === 120 && s.nodes[1].x === 320);
  await reset();
  await page.mouse.move(box.x + 90, box.y + 90); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 90); await settle();
  s = await state(); check("multi-rotate does not jump at an offset canvas", s.nodes.every(n => n.rotation === 0));
  const a = Math.atan2(-60, -160) + Math.PI / 12, r = Math.hypot(60, 160);
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 250 + r * Math.cos(a), box.y + 150 + r * Math.sin(a)); await page.mouse.up();
  await page.keyboard.up("Shift"); await settle();
  s = await state(); check("multi-rotate Shift gesture is 15 degrees", s.nodes.every(n => n.rotation === 15));
  for (const multi of [false, true]) {
    await reset(multi); await page.mouse.move(box.x + 93, box.y + 100); await settle();
    const cursor = await page.$eval("#parity-audit .canvas-wrap", el => getComputedStyle(el).cursor);
    await page.mouse.down(); await page.mouse.move(box.x + 80, box.y + 80); await page.mouse.up(); await settle();
    s = await state(); check(`${multi ? "multi" : "single"} resize cursor starts resize, not rotation`, cursor === "nwse-resize" && s.nodes[0].rotation === 0 && s.nodes[0].w > 100);
  }
  const metrics = await page.evaluate(async () => {
    const { node } = window.audit;
    const { textMetrics, canvasTextFont, applyTextCase } = await import("/src/ui/textLayout.ts");
    const ctx = document.createElement("canvas").getContext("2d");
    const n = node("text", "Text", 0, 0, 100, 40, { text: "iii www Mixed", fontStyle: "italic", textCase: "upper", fontFamily: "Arial", fontSize: 24, sizingW: "hug" });
    ctx.font = canvasTextFont(n); const expected = ctx.measureText(applyTextCase(n.text, n.textCase)).width;
    const actual = textMetrics(ctx, n, n.text).maxW;
    return { expected, actual, font: ctx.font };
  });
  check("browser hug measurement matches italic uppercase paint metrics", Math.abs(metrics.actual - metrics.expected) < .01 && metrics.font.includes("italic"));
  await page.evaluate(() => {
    const { node, mount } = window.audit;
    const child = node("rect", "Child", 20, 20, 100, 100);
    const parent = node("frame", "Parent", 100, 100, 300, 300, { children: [child] });
    mount([parent], [parent.id, child.id]);
  });
  await settle();
  await page.mouse.move(box.x + 350, box.y + 350); await page.mouse.down();
  await page.keyboard.down("Control");
  await page.mouse.move(box.x + 370, box.y + 365, { steps: 3 }); await page.mouse.up();
  await page.keyboard.up("Control"); await settle();
  s = await state();
  check("ancestor and selected child drag only once", s.nodes[0].x === 120 && s.nodes[0].children[0].x === 20 && s.selection.length === 2);
  await page.evaluate(() => window.audit.engine.dispatch({ type: "undo" })); await settle();
  s = await state(); check("ancestor-child drag is one undo step", s.nodes[0].x === 100 && s.nodes[0].children[0].x === 20);
  await page.evaluate(() => window.audit.engine.dispatch({ type: "nudge", dx: 10, dy: 0 })); await settle();
  s = await state(); check("ancestor-child nudge command carries descendant once", s.nodes[0].x + s.nodes[0].children[0].x === 130);
  // Diagnostics reproduce OPEN findings; these are NOT passing parity checks.
  if (process.env.AUDIT_DIAGNOSTICS === "1") {
    diagnostics.push(...await page.evaluate(async () => {
      const { node, find, mount } = window.audit;
      const { vectorNetworkToPath } = await import("/src/engine/geometry.ts");
      const network = { vertices: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:200,y:0}], segments: [{start:0,end:1},{start:1,end:2},{start:1,end:3}], regions: [] };
      const v = node("vector", "Branch", 100, 100, 200, 100, { path: vectorNetworkToPath(network).path, vectorNetwork: network });
      mount([v], [v.id]);
      let e = window.audit.engine;
      e.dispatch({ type: "patchPath", id: v.id, path: v.path.map((p,i) => i ? p : {...p,x:p.x+5}), closed: false });
      let n = find(e.snapshot().pages[0].root,v.id);
      const branch = { finding: "legacy path edit loses branch", beforeVertices: 4, afterVertices: n.vectorNetwork.vertices.length, beforeSegments: 3, afterSegments: n.vectorNetwork.segments.length };
      const rotatedChild = node("rect", "Rotated child", 100, 100, 100, 20, { rotation: 90 });
      const fitParent = node("frame", "Fit parent", 0, 0, 400, 400, { children: [rotatedChild] });
      mount([fitParent], [fitParent.id]); e = window.audit.engine;
      e.dispatch({ type: "resizeToFit" });
      n = find(e.snapshot().pages[0].root,fitParent.id);
      return [branch, { finding: "resize-to-fit ignores child rotation", expected: [20,100], actual: [n.w,n.h] }];
    }));
    for (const row of diagnostics) console.log("OPEN DIAGNOSTIC", JSON.stringify(row));
  }
  if (process.env.AUDIT_PERF === "1") {
    for (const fixture of ["1", "100", "500", "deep", "layout", "images", "vectors"]) {
      await page.evaluate(fixture => {
        const { node, mount } = window.audit;
        const count = /^\d+$/.test(fixture) ? Number(fixture) : fixture === "vectors" ? 500 : 100;
        let children = Array.from({ length: count }, (_, i) => node("rect", `R${i}`, (i % 20) * 45, Math.floor(i / 20) * 28, 40, 24));
        if (fixture === "deep") {
          let tree = node("rect", "Leaf", 10, 10, 50, 50);
          for (let i = 0; i < 40; i++) tree = node("frame", `Depth ${i}`, 2, 2, 300, 300, { children: [tree] });
          children = [tree];
        }
        if (fixture === "layout") children = Array.from({ length: 10 }, (_, i) => node("frame", `Layout ${i}`, 0, i * 55, 700, 50, { children: children.slice(i * 10, i * 10 + 10), layout: { direction: "horizontal", gap: 5, padding: [5,5,5,5], sizing: "fixed", cross: "fixed", align: "min", justify: "min", wrap: false } }));
        if (fixture === "images") children.forEach(n => { n.imageSrc = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24"><rect width="40" height="24" fill="#ff6600"/></svg>'); n.fillType = "image"; });
        if (fixture === "vectors") children.forEach(n => { n.kind = "vector"; n.closed = true; n.path = Array.from({ length: 32 }, (_, k) => ({ x: 20 + 18 * Math.cos(k * Math.PI / 16), y: 12 + 10 * Math.sin(k * Math.PI / 16), ox: 2, oy: 1, ix: -2, iy: -1 })); });
        mount(children);
      }, fixture);
      await settle();
      const times = await page.evaluate(async () => {
        const times = [];
        for (let i = 0; i < 60; i++) {
          const start = performance.now(); window.audit.engine.dispatch({ type: "pan", dx: i % 2 ? -2 : 2, dy: 0 });
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          times.push(performance.now() - start);
        }
        return times.sort((a,b) => a-b);
      });
      const row = { fixture, samples: times.length, medianMs: +times[30].toFixed(2), p95Ms: +times[56].toFixed(2), maxMs: +times[59].toFixed(2) };
      performance.push(row); console.log("PERF", JSON.stringify(row));
    }
  }
  check("no browser page errors", errors.length === 0);
} finally {
  await browser.close();
  if (process.env.AUDIT_RESULT) fs.writeFileSync(process.env.AUDIT_RESULT, JSON.stringify({ results, errors, performance, diagnostics }, null, 2));
}
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
