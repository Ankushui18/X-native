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
const check = (name, ok, detail = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);

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
process.exit(errors.length || missingChecks.length ? 1 : 0);
