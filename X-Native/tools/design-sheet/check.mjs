// jsdom smoke test for the design sheet: it must render every palette, the
// ladders, the frames and the audit without a console error.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const errors = [];
const vc = new VirtualConsole();
// jsdom raises "Not implemented: getContext" for the canvas probe; the sheet
// catches that itself, so filter the notice rather than the app error path
const ignorable = (m) => /Not implemented: HTMLCanvasElement/.test(m);
vc.on('jsdomError', (e) => !ignorable(String(e)) && errors.push(String(e)));
vc.on('error', (e) => !ignorable(String(e)) && errors.push(String(e)));

const dom = new JSDOM(readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8'), {
  runScripts: 'dangerously',
  resources: 'usable',
  url: new URL('./index.html', import.meta.url).href,
  virtualConsole: vc,
  pretendToBeVisual: true,
});
const { window } = dom;
await new Promise((r) => setTimeout(r, 700));
const d = window.document;
const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);

check('no script errors', errors.length === 0, errors.join(' | '));
const roles = d.querySelectorAll('#roles .role');
check('palette sheet rendered', roles.length === 24, `${roles.length} roles`);
check('three themes offered', d.querySelectorAll('#themes button').length === 3);
check('theme switch repaints', (() => {
  d.querySelector('#themes button[data-theme=daylight]').click();
  const hex = d.querySelector('#roles .chip').style.background;
  const dark = window.TOKENS.palettes.graphite[window.TOKENS.roleNames[0]];
  d.querySelector('#themes button[data-theme=graphite]').click();
  return hex !== '' && hex !== dark;
})(), 'daylight chip differs from graphite');
check('type ladder', d.querySelectorAll('#l-type .row').length === 5);
check('spacing ladder', d.querySelectorAll('#l-space .row').length === 11);
check('radius ladder', d.querySelectorAll('#l-radius .row').length === 6);
check('icon ladder', d.querySelectorAll('#l-icon figure').length >= 9);
check('alpha ladder', d.querySelectorAll('#l-alpha .row').length === 5);
check('stroke + motion', d.querySelectorAll('#l-stroke .row').length === 2 && d.querySelectorAll('#l-motion .row').length === 3);
const frames = ['#stage', '#narrow', '#wide'].map((s) => d.querySelector(s).innerHTML.length);
check('dashboard + fluid frames built', frames.every((n) => n > 2000), frames.map((n) => n + ' chars').join(', '));
check('narrow frame is 980 wide', d.querySelector('#narrow .win').style.width === '980px');
check('wide frame is 1920 wide', d.querySelector('#wide .win').style.width === '1920px');
check('ratchet table lists ceilings', d.querySelectorAll('#ratchet tr').length >= 21, `${d.querySelectorAll('#ratchet tr').length} rows`);
check('audit says nothing is over ceiling', !d.querySelector('#ratchet .pill.no'), 'no over-ceiling pill');
check('spacing audit table', d.querySelectorAll('#offsets tr').length === 15);
check('rules documented', d.querySelectorAll('#rules > div').length === 6);
check('fluid widths table', d.querySelectorAll('#fluid tr').length === 6, `${d.querySelectorAll('#fluid tr').length} rows`);
check('provenance line', /@ [0-9a-f]{7}/.test(d.getElementById('provenance').textContent));
process.exit(errors.length ? 1 : 0);
