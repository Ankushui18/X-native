// Captures every screen in the gallery as a PNG, at the app's real size.
//
// The gallery draws each screen at 1440×900 from the geometry the Rust sources
// declare, but it draws them as DOM. This script puts those drawings in front of
// a real browser engine, at scale 1 (no `transform`), and writes one PNG per
// screen — so the layout can be looked at pixel by pixel, and argued about,
// without a GPU or the app running.
//
// It also writes `shots/index.json` (what was captured, with the renderer's
// version and a sha256 per file) and `shots.html` (a browsable sheet over the
// PNGs), both from the live gallery data, so neither can claim more than the
// run actually produced.
//
// Run it from a directory that has `puppeteer-core` and `@sparticuz/chromium`
// installed (the latter ships a Chromium build plus the shared libraries it
// needs, so no system Chrome is required):
//   cd /path/with/node_modules && node /path/to/tools/design-sheet/shots.mjs
//
// Options:
//   --theme graphite|daylight|hc   palette to capture (default graphite)
//   --only <screen-id>             capture one screen and leave index/sheet alone
//   --out <dir>                    output directory (default shots)
//   --quiet                        only print the summary

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const DIR = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const THEME = opt('theme', 'graphite');
const ONLY = opt('only');
const OUT = resolve(DIR, opt('out', 'shots'));
const QUIET = flag('quiet');
const W = 1440;
const H = 900;

// --------------------------------------------------------------- the browser
// The dependencies are not part of the repo (`tools/design-sheet` has no
// package.json), so load them from wherever they are installed: an explicit
// `SHOT_DEPS` directory, the working directory you run from, or here.
async function deps() {
  const roots = [process.env.SHOT_DEPS, process.cwd(), DIR].filter(Boolean);
  const tried = [];
  for (const root of roots) {
    try {
      const req = createRequire(pathToFileURL(join(root, '_')).href);
      const pptr = req.resolve('puppeteer-core');
      const chr = await import(pathToFileURL(req.resolve('@sparticuz/chromium')).href);
      return { req, pptr: (await import(pathToFileURL(pptr).href)).default, chromium: chr.default };
    } catch (e) {
      tried.push(`${root}: ${e.code || e.message}`);
    }
  }
  throw new Error(
    'shots.mjs needs puppeteer-core and @sparticuz/chromium. Install them in any\n' +
      'directory and run from there, or point SHOT_DEPS at it:\n' +
      '  npm i puppeteer-core @sparticuz/chromium\n' +
      tried.join('\n'),
  );
}

// @sparticuz/chromium unpacks a Chromium binary and, beside it, the NSS/NSPR
// libraries this image is missing. The libraries live in `al2023.tar.br` and are
// not unpacked for you, so do that here — then LD_LIBRARY_PATH points at them
// and the binary starts on a machine with no browser installed at all.
async function browser({ req, pptr, chromium }) {
  const exe = await chromium.executablePath();
  const libs = join(dirname(exe), 'chromium-libs');
  const needed = join(libs, 'lib', 'libnss3.so');
  if (!existsSync(needed)) {
    // the entry point can sit in a subdirectory (build/index.js); the tarballs
    // live at the package root, so walk up to the package.json
    let pkg = dirname(req.resolve('@sparticuz/chromium'));
    while (!existsSync(join(pkg, 'package.json')) && pkg !== dirname(pkg)) pkg = dirname(pkg);
    const tar = join(pkg, 'bin', 'al2023.tar.br');
    const inTemp = join(libs, 'al2023.tar');
    mkdirSync(libs, { recursive: true });
    writeFileSync(inTemp, brotliDecompressSync(readFileSync(tar)));
    execFileSync('tar', ['xf', inTemp, '-C', libs]);
  }
  return pptr.launch({
    executablePath: exe,
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--disable-lcd-text',
      '--allow-file-access-from-files',
    ],
    env: { ...process.env, LD_LIBRARY_PATH: join(libs, 'lib') },
  });
}

// ------------------------------------------------------------- static server
// The sheet loads its fonts and sibling scripts by relative URL, which `file://`
// handles inconsistently; serve the folder instead so the capture path is the
// same one a browser gets from the preview server.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve(root) {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = resolve(root, '.' + rel);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not here');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// ------------------------------------------------------------------- shapes
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

// The browser can see things jsdom cannot: real boxes, real text metrics. This
// pass refuses to photograph a drawing that has escaped its window, been clipped
// or lost an icon — a capture of a broken screen is worse than no capture.
async function verify(page) {
  return page.evaluate(() => {
    const out = { boxes: 0, screens: [] };
    for (const s of window.SCREENS) {
      const win = document.getElementById(s.id).querySelector('.win');
      win.style.transform = 'none';
      const wr = win.getBoundingClientRect();
      const issues = [];
      for (const e of win.querySelectorAll('*')) {
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        out.boxes += 1;
        const over = Math.round(
          Math.max(r.right - wr.right, r.bottom - wr.bottom, wr.left - r.left, wr.top - r.top),
        );
        if (over > 2) {
          const cls = String(e.className).split(' ')[0] || e.tagName.toLowerCase();
          issues.push(`${cls} ${over}px outside the window`);
        }
        if (e.children.length === 0 && e.textContent.trim()) {
          const cs = getComputedStyle(e);
          if (cs.overflow === 'hidden' && (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2)) {
            issues.push(`clipped text "${e.textContent.trim().slice(0, 24)}"`);
          }
        }
      }
      const missing = win.querySelectorAll('.missing-icon').length;
      if (missing) issues.push(`${missing} icon(s) with no glyph`);
      if (issues.length) out.screens.push({ id: s.id, issues: [...new Set(issues)].slice(0, 6) });
    }
    return out;
  });
}

// Swap a screen onto an overlay stage at 1:1. The gallery scales each window to
// fit its column; a capture has to undo exactly that and nothing else.
// The stage is an overlay over the gallery, not a replacement for it: the page
// keeps all 26 drawings so each screen can be cloned out in turn. Replacing the
// body instead destroys every later screen's source.
async function showScreen(page, id, theme) {
  return page.evaluate(
    (id, theme) => {
      const source = document.getElementById(id).querySelector('.win');
      if (!source) return null;
      const win = source.cloneNode(true);
      win.style.transform = 'none';
      win.style.width = '1440px';
      win.style.height = '900px';
      document.documentElement.dataset.theme = theme;
      let stage = document.getElementById('shot-stage');
      if (!stage) {
        stage = document.createElement('div');
        stage.id = 'shot-stage';
        stage.style.cssText =
          'position:fixed;left:0;top:0;width:1440px;height:900px;overflow:hidden;' +
          'z-index:9999;background:var(--background)';
        document.body.append(stage);
      }
      stage.replaceChildren(win);
      const r = stage.getBoundingClientRect();
      return { w: win.offsetWidth, h: win.offsetHeight, stage: [r.x, r.y, r.width, r.height] };
    },
    id,
    theme,
  );
}

// ------------------------------------------------------------- the sheet page
// Generated from the run, not from the gallery, so the page cannot describe a
// capture that failed.
function sheetHtml(index) {
  const logo = index.iconFrame
    ? `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">${index.iconFrame
        .map((d) => `<path d="${d}"/>`)
        .join('')}</svg>`
    : '';
  const rows = index.screens
    .map(
      (s) => `  <section class="card" id="${s.id}">
    <div class="card-h">
      <h2>${s.name}</h2>
      <span class="mod">${s.module}</span>
      <span class="badge">${s.group}</span>
      <span class="badge new">${s.file} · ${s.width}×${s.height}</span>
      <a class="shotlink" href="${s.file}">Open PNG</a>
    </div>
    <p>${s.what}</p>
    <p>${s.note}</p>
    <div class="capture"><img class="shot" src="${s.file}" width="${s.width}" height="${s.height}" alt="${s.name} at ${s.width}×${s.height}"></div>
    <div class="checks">${s.checks.map((c) => `<span>${c}</span>`).join('')}</div>
  </section>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en" data-theme="${index.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Captures — X-Native design sheet</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="screens.css">
</head>
<body>
<header class="topbar">
  <a class="mark" href="index.html">
    <span class="logo" id="logo">${logo}</span>
    <span><b>X-Native</b><em>design sheet</em></span>
  </a>
  <nav class="tabs">
    <a href="index.html">Tokens &amp; audit</a>
    <a href="screens.html">Every screen</a>
    <a href="shots.html" aria-current="page">Captures</a>
  </nav>
  <span class="grow"></span>
  <span class="badge">${index.screens.length} PNGs · ${index.theme} · ${index.runtime}</span>
</header>

<main class="wrap">
  <aside class="nav">
    <p class="lede">${index.screens.length} screens drawn by the sheet and photographed by
    <code>shots.mjs</code> in a real browser at ${W}×${H}, scale 1. These are pixels for the
    same claims <a href="screens.html">Every screen</a> makes.</p>
    <div class="nav-group">Renderer</div>
    <p class="fine">${index.browser}<br>captured ${index.at}, one file per screen,
    largest ${kb(Math.max(...index.screens.map((s) => s.bytes)))}.</p>
    <div class="nav-group">Screens</div>
    ${index.screens.map((s) => `<a href="#${s.id}"><i></i>${s.name}</a>`).join('\n    ')}
  </aside>

  <section class="stack">
${rows}
  </section>
</main>
</body>
</html>
`;
}

// ------------------------------------------------------------------ the run
const server = await serve(DIR);
const port = server.address().port;
const browserInstance = await browser(await deps());
const page = await browserInstance.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const gallery = `http://127.0.0.1:${port}/screens.html`;
await page.goto(gallery, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => (window.SCREENS || []).length > 0, { timeout: 20000 });

const data = await page.evaluate(() => ({
  screens: window.SCREENS.map((s) => ({
    id: s.id,
    name: s.name,
    group: s.group,
    module: s.module,
    what: s.what,
    note: s.note,
    checks: s.checks,
  })),
  iconFrame: window.ICONS.frame || null,
}));
const wanted = ONLY ? data.screens.filter((s) => s.id === ONLY) : data.screens;
if (!wanted.length) throw new Error(`no such screen: ${ONLY}`);

const audit = await verify(page);
if (audit.screens.length) {
  console.error(`${audit.screens.length} of ${data.screens.length} screens have layout problems:`);
  for (const s of audit.screens) console.error(`  ${s.id}: ${s.issues.join('; ')}`);
  if (!flag('force')) {
    console.error('\nNothing written. Fix the drawings, or pass --force to capture them as they are.');
    await browserInstance.close();
    server.close();
    process.exit(1);
  }
  console.error('\n--force: capturing anyway.');
} else if (!QUIET) {
  console.log(`verified ${data.screens.length} screens, ${audit.boxes} boxes, none escaping its window\n`);
}

const dir = join(OUT, THEME === 'graphite' ? '' : THEME);
mkdirSync(dir, { recursive: true });
const rel = (p) => p.slice(DIR.length + 1);

const shots = [];
for (const s of wanted) {
  const box = await showScreen(page, s.id, THEME);
  if (!box) throw new Error(`${s.id}: the gallery has no drawing for this screen`);
  if (box.w !== W || box.h !== H) throw new Error(`${s.id}: window is ${box.w}×${box.h}, not ${W}×${H}`);
  if (box.stage.join() !== [0, 0, W, H].join()) {
    throw new Error(`${s.id}: the stage is at ${box.stage.join()}, so the clip would not be the window`);
  }
  const file = join(dir, `${s.id}.png`);
  const buf = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: W, height: H },
    captureBeyondViewport: false,
  });
  writeFileSync(file, buf);
  shots.push({ ...s, file: rel(file), bytes: buf.length, sha256: sha(buf), width: W, height: H });
  if (!QUIET) console.log(`  ${s.id.padEnd(24)} ${kb(buf.length).padStart(7)}  ${sha(buf)}`);
}

const ua = await page.evaluate(() => navigator.userAgent);
await browserInstance.close();
server.close();

// `--only` is for looking at one screen while editing it: it must not rewrite
// the index or the sheet, or a single-screen run would erase the other 25.
if (ONLY) {
  console.log(`\n1 shot → ${rel(join(dir, ONLY + '.png'))} (index and shots.html left alone)`);
  process.exit(0);
}

// Re-capturing an unchanged sheet must not churn the commit: if every file came
// back byte-identical, keep the previous capture's timestamp so `index.json` and
// `shots.html` stay stable too. The stamp describes the pixels, not the run.
const indexPath = join(OUT, 'index.json');
const prev = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : null;
const sameAsBefore =
  prev &&
  prev.theme === THEME &&
  prev.screens?.length === shots.length &&
  prev.screens.every((p, i) => p.id === shots[i].id && p.sha256 === shots[i].sha256 && p.bytes === shots[i].bytes);

const index = {
  theme: THEME,
  at: sameAsBefore ? prev.at : new Date().toISOString().slice(0, 16).replace('T', ' '),
  browser: ua.replace(/^Mozilla\/5\.0 \(X11; Linux x86_64\) /, ''),
  runtime: `chrome ${/HeadlessChrome\/([\d.]+)/.exec(ua)?.[1] || '?'}`,
  window: { width: W, height: H },
  iconFrame: data.iconFrame,
  verified: { screens: data.screens.length, boxes: audit.boxes, issues: audit.screens },
  screens: shots,
};
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
if (THEME === 'graphite') writeFileSync(join(DIR, 'shots.html'), sheetHtml(index));

const total = shots.reduce((n, s) => n + s.bytes, 0);
console.log(`\n${shots.length} shots · ${THEME} · ${kb(total)} total · ${rel(join(OUT, 'index.json'))}`);
if (THEME === 'graphite') console.log(`sheet → ${rel(join(DIR, 'shots.html'))}`);
