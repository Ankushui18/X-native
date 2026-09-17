// jsdom check for the screens gallery: every screen must render, name a module
// that exists in the Rust source, carry its landmarks, and use only colours the
// tokens define. Run from a directory with jsdom installed:
//   cd /path/with/node_modules && node .../tools/design-sheet/check_screens.mjs
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('./', import.meta.url);
const app = new URL('../../apps/x-designer/src/bin/x_native_app/', import.meta.url);
const errors = [];
const vc = new VirtualConsole();
const ignorable = (m) => /Not implemented: HTMLCanvasElement/.test(m);
vc.on('jsdomError', (e) => !ignorable(String(e)) && errors.push(String(e)));
vc.on('error', (e) => !ignorable(String(e)) && errors.push(String(e)));

const dom = new JSDOM(readFileSync(new URL('screens.html', dir), 'utf8'), {
  runScripts: 'dangerously',
  resources: 'usable',
  url: new URL('screens.html', dir).href,
  virtualConsole: vc,
  pretendToBeVisual: true,
});
const { window } = dom;
await new Promise((r) => setTimeout(r, 900));
const d = window.document;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const screens = window.SCREENS || [];
check('no script errors', errors.length === 0, errors.join(' | ').slice(0, 200));
check('the registry loaded', screens.length >= 20, `${screens.length} screens`);
check(
  'every screen drew a window',
  screens.every((s) => {
    const node = d.querySelector(`#${s.id} .win`);
    return node && node.innerHTML.length > 800;
  }),
  screens
    .filter((s) => {
      const node = d.querySelector(`#${s.id} .win`);
      return !node || node.innerHTML.length <= 800;
    })
    .map((s) => s.id)
    .join(', ') || 'all drawn',
);

// Every screen must name a real module: a gallery that points at a file nobody
// ships is a gallery that documents a program that does not exist.
const missingModules = screens.filter((s) => !existsSync(new URL(s.module, app)));
check(
  'every screen names a module that exists',
  missingModules.length === 0,
  missingModules.map((s) => `${s.id}→${s.module}`).join(', ') || `${screens.length} modules checked`,
);

// The landmarks each card promises must be in the drawing.
const missingChecks = [];
for (const s of screens) {
  const node = d.querySelector(`#${s.id} .win`);
  const text = node ? node.textContent + node.innerHTML : '';
  for (const c of s.checks) if (!text.includes(c)) missingChecks.push(`${s.id}: ${c}`);
}
check('every screen shows the landmarks it claims', missingChecks.length === 0, missingChecks.join('; '));

check(
  'no screen draws an icon the set does not have',
  d.querySelectorAll('.missing-icon').length === 0,
  `${d.querySelectorAll('.missing-icon').length} missing`,
);
check(
  'every sidebar entry has a card',
  [...d.querySelectorAll('#nav-list a')].every((a) => d.getElementById(a.dataset.target)),
  `${d.querySelectorAll('#nav-list a').length} links`,
);
check('theme switch offers three palettes', d.querySelectorAll('#themes button').length === 3);
check(
  'theme switch repaints a screen',
  (() => {
    const w = window;
    const root = w.getComputedStyle(d.documentElement);
    const before = root.getPropertyValue('--accent');
    d.querySelector('#themes button[data-theme=daylight]').click();
    const after = w.getComputedStyle(d.documentElement).getPropertyValue('--accent');
    d.querySelector('#themes button[data-theme=graphite]').click();
    const back = w.getComputedStyle(d.documentElement).getPropertyValue('--accent');
    return before !== after && before === back;
  })(),
  'a board sticky follows the palette',
);
check(
  'zoom control rescales the frames',
  (() => {
    const winEl = d.querySelector('#board .win');
    const before = winEl.style.transform;
    d.querySelector('#scales button[data-scale="0.5"]').click();
    const half = winEl.style.transform;
    d.querySelector('#scales button[data-scale="fit"]').click();
    return before !== half && /scale\(0\.5\)/.test(half);
  })(),
  'fit → 50% → fit',
);

// Numbers on the gallery must come from the audit, not from the file.
const src = readFileSync(new URL('screens.js', dir), 'utf8');
const AU = window.AUDIT;
check(
  'the frames are drawn at the parsed window size',
  d.querySelector('.win').style.width === `${AU.window.default[0]}px` &&
    d.querySelector('.win').style.height === `${AU.window.default[1]}px`,
  `${d.querySelector('.win').style.width}×${d.querySelector('.win').style.height}`,
);
check(
  'the docks are drawn at the parsed widths',
  (() => {
    const rail = d.querySelector('#editor-structure .rail');
    const left = d.querySelector('#editor-structure .left-panel');
    const right = d.querySelector('#editor-structure .right-panel');
    return (
      rail && left && right &&
      rail.style.width === `${AU.docks.nav}px` &&
      left.style.width === `${AU.docks.left}px` &&
      right.style.width === `${AU.docks.right}px`
    );
  })(),
  `rail ${AU.docks.nav}, left ${AU.docks.left}, right ${AU.docks.right}`,
);
const rawLiterals = src.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
check('no raw colour literals in the gallery', rawLiterals.length === 0, rawLiterals.join(', '));
const css = readFileSync(new URL('screens.css', dir), 'utf8');
const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
const defined = new Set([
  ...readFileSync(new URL('tokens.css', dir), 'utf8').matchAll(/--([a-z0-9-]+):/g),
  ...css.matchAll(/--([a-z0-9-]+):/g),
].map((m) => m[1]));
const cssLiterals = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
check(
  'every colour in the gallery stylesheet is a role or derived from one',
  cssLiterals.length === 0,
  cssLiterals.join(', '),
);
const undefinedVars = [...used].filter((v) => !defined.has(v));
check('every var(--x) the gallery uses is defined', undefinedVars.length === 0, undefinedVars.join(', '));
const noText = [...d.querySelectorAll('.card')].filter((c) => c.textContent.trim().length < 80);
check('no empty card', noText.length === 0, noText.map((c) => c.id).join(', '));
check('nothing rendered as undefined/NaN', !/undefined|NaN/.test(d.body.textContent));

// --------------------------------------------------------------- containment
// jsdom does not lay out, but every box `at()` draws carries its own left, top,
// width and height, and those numbers are the claim. So containment is checkable
// without a layout engine: a box must fit inside whichever positioned ancestor it
// is actually measured against. This is the check that was missing when the
// minimap was placed with window coordinates inside the positioned canvas — it
// landed 24px off the bottom of the window and under the right dock — and when
// the dashboard's main column was drawn from y 0 and sat under the title bar.
const px = (v) => (typeof v === 'string' && v.endsWith('px') ? parseFloat(v) : null);
const size = (el) => {
  const s = window.getComputedStyle(el);
  const w = px(s.width);
  const h = px(s.height);
  return w !== null && h !== null ? { w, h } : null;
};
const placed = (el) => {
  const s = window.getComputedStyle(el);
  const l = px(s.left);
  const t = px(s.top);
  const size_ = size(el);
  if (l === null || t === null || !size_) return null;
  return { l, t, ...size_ };
};
const escaped = [];
let measured = 0;
for (const winEl of d.querySelectorAll('.win')) {
  const winSize = size(winEl) || { w: AU.window.default[0], h: AU.window.default[1] };
  for (const el of winEl.querySelectorAll('*')) {
    if (window.getComputedStyle(el).position !== 'absolute') continue;
    const box = placed(el);
    if (!box) continue;
    let parent = el.parentElement;
    let frame = { w: winSize.w, h: winSize.h, who: 'the window' };
    while (parent && parent !== winEl) {
      if (window.getComputedStyle(parent).position !== 'static') {
        const s = size(parent);
        if (s) {
          frame = { ...s, who: `${parent.tagName.toLowerCase()}.${String(parent.className).split(' ')[0]}` };
          break;
        }
      }
      parent = parent.parentElement;
    }
    measured += 1;
    const over = Math.round(Math.max(box.l + box.w - frame.w, box.t + box.h - frame.h, -box.l, -box.t));
    if (over > 2) escaped.push(`${winEl.parentElement.id}/${String(el.className).split(' ')[0] || el.tagName.toLowerCase()} ${over}px past ${frame.who}`);
  }
}
check(
  'every box a screen draws stays inside the panel it is measured against',
  escaped.length === 0,
  escaped.length ? `${escaped.length} escaped: ${escaped.slice(0, 4).join('; ')}` : `${measured} boxes checked`,
);

// The dashboard is the one screen with two columns under a title bar; both must
// start below it, and the main column must reach the bottom of the window.
const dashMain = d.querySelector('#dash-home-grid .win .main');
const dashSide = d.querySelector('#dash-home-grid .win .sidebar');
check(
  'the dashboard columns start under the title bar and reach the bottom',
  dashMain && dashSide &&
    dashMain.style.top === `${AU.ui.dashTitleH}px` &&
    dashSide.style.top === dashMain.style.top &&
    parseFloat(dashMain.style.top) + parseFloat(dashMain.style.height) === AU.window.default[1],
  dashMain ? `top ${dashMain.style.top}, height ${dashMain.style.height}` : 'no main column',
);

// A menu without its surface class is invisible scenery: the sort menu shipped
// with rows floating over the quick cards until a capture showed it.
const bareMenus = [...d.querySelectorAll('.win .menu')].filter((m) => !m.closest('.menu-wrap, .popover, .modal, .cmdpalette, .findbar'));
check(
  'every menu is drawn on a surface',
  bareMenus.length === 0,
  bareMenus.map((m) => m.textContent.trim().split('\n')[0]).join(', ') || 'all wrapped',
);

const failures = results.filter((r) => !r.ok).length;
console.log(`\n${results.filter((r) => r.ok).length} PASS, ${failures} FAIL`);
process.exit(errors.length || missingChecks.length || failures ? 1 : 0);
