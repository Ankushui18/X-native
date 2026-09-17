// jsdom smoke test for the design sheet: it must render every palette, the
// ladders, the frames and the audit without a console error.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The sheet documents the code, so its own test reads the code: a ladder that
// drops a step, a role that loses its runtime colour, or a hardcoded hex in the
// chrome is a FAIL here, not a thing to notice by eye later.
const DS = readFileSync(
  fileURLToPath(new URL('../../crates/x-ui/src/design_system.rs', import.meta.url)),
  'utf8',
);
const stepCount = (structName) => {
  const start = DS.indexOf(`impl ${structName} {`);
  const body = DS.slice(start, DS.indexOf('\n}', start));
  return [...body.matchAll(/pub const [A-Z0-9_]+: (?:f64|u8) = /g)].length;
};
const sourceSteps = {
  type: stepCount('TypographyScale'),
  icon: stepCount('IconScale') - 1, // STROKE is a weight, not a size
  radius: stepCount('RadiusScale'),
  spacing: stepCount('SpacingScale'),
  alpha: stepCount('AlphaScale'),
  stroke: stepCount('StrokeScale'),
};
const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
const appJs = readFileSync(fileURLToPath(new URL('./app.js', import.meta.url)), 'utf8');
const tokensCss = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

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
const ladder = (s) => d.querySelectorAll(s).length;
check(
  'every type step is on the sheet',
  ladder('#l-type .row') === sourceSteps.type,
  `${ladder('#l-type .row')} rows vs ${sourceSteps.type} in TypographyScale`,
);
check(
  'the type ladder names the aliases the chrome uses',
  ['T10', 'T12', 'T16', 'T20'].every((a) => d.getElementById('l-type').textContent.includes(a)),
  'T10/T12/T16/T20 all present',
);
check(
  'spacing ladder',
  ladder('#l-space .row') === sourceSteps.spacing,
  `${ladder('#l-space .row')} vs ${sourceSteps.spacing}`,
);
check(
  'every radius step is on the sheet',
  ladder('#l-radius .row') === sourceSteps.radius,
  `${ladder('#l-radius .row')} rows vs ${sourceSteps.radius} in RadiusScale`,
);
check(
  'icon ladder',
  ladder('#l-icon figure') >= sourceSteps.icon + 4,
  `${ladder('#l-icon figure')} figures for ${sourceSteps.icon} sizes + 4 named`,
);
check('alpha ladder', ladder('#l-alpha .row') === sourceSteps.alpha, `${sourceSteps.alpha}`);
check(
  'stroke + motion',
  ladder('#l-stroke .row') === sourceSteps.stroke && ladder('#l-motion .row') === 3,
  `${sourceSteps.stroke} + 3`,
);
const frames = ['#stage', '#narrow', '#wide'].map((s) => d.querySelector(s).innerHTML.length);
check('dashboard + fluid frames built', frames.every((n) => n > 2000), frames.map((n) => n + ' chars').join(', '));
const heights = ['#stage-wrap', '#narrow-wrap', '#wide-wrap'].map((s) =>
  parseInt(d.querySelector(s).style.height, 10),
);
check(
  'frames never scale to nothing',
  heights.every((h) => h > 0) &&
    ![...d.querySelectorAll('.stage')].some((el) => el.style.transform === 'scale(0)'),
  heights.join(', '),
);
const stage = d.getElementById('stage').innerHTML;
const wide = d.getElementById('wide').innerHTML;
check(
  'the dashboard frame shows the chrome the app paints',
  ['Trash', 'Sorted by Edited', 'Grid', 'List'].every((t) => stage.includes(t)),
  'nav rows + sort chip + layout toggle',
);
check(
  'the wide frame is the List layout',
  ['NAME', 'TEAM', 'EDITED'].every((t) => wide.includes(t)),
  'column headers present',
);
const textRoles = new Set(window.TOKENS.textRoles);
const ratioCount = d.querySelectorAll('#roles .ratio.pass, #roles .ratio.warn').length;
check(
  'only text roles carry a ratio, and there is a legend for the rest',
  ratioCount === textRoles.size && /are fills, rings and washes/.test(d.getElementById('palette-note').textContent),
  `${ratioCount} ratios for ${textRoles.size} text roles`,
);
const ia = window.ICON_AUDIT;
check(
  'every icon the chrome names exists in the set',
  Boolean(ia) && ia.missing.length === 0,
  ia ? `${ia.used} named, ${ia.missing.length} missing` : 'no audit',
);
check(
  'the sheet only draws icons that exist',
  (() => {
    const named = new Set([...appJs.matchAll(/svgIcon\('([a-z0-9-]+)'/g)].map((m) => m[1]));
    return [...named].every((n) => n in window.ICONS);
  })(),
  'svgIcon names checked against icons.js',
);
// the "used" column is derived from the app sources, so the sheet must agree
// with it: every alias with a zero count wears the pill, every other one shows
// its number. A row that silently drops the annotation fails here.
const usage = window.TOKENS.usage;
const aliasRows = [...d.querySelectorAll('#vocab tbody tr')].filter((tr) => tr.querySelector('.alias'));
const usageMismatch = aliasRows.filter((tr) => {
  const name = tr.querySelector('.alias').textContent;
  const cell = tr.querySelector('.uses');
  if (!cell) return true;
  const want = usage[name];
  if (want === undefined) return false;
  return want === 0 ? !cell.classList.contains('none') : cell.textContent !== `×${want}`;
});
check(
  'every alias on the sheet reports how often it is used',
  usageMismatch.length === 0,
  usageMismatch.map((tr) => tr.querySelector('.alias').textContent).join(', '),
);
const typeRows = [...d.querySelectorAll('#l-type .row')];
check(
  'every type step carries its alias and its use count',
  typeRows.length === sourceSteps.type && typeRows.every((r) => r.querySelector('.uses')),
  `${typeRows.length} rows annotated`,
);
check(
  'a step no call site names is marked, not hidden',
  (() => {
    const zero = Object.entries(usage).filter(([, n]) => n === 0).map(([k]) => k);
    return zero.every((n) => {
      const pill = [...d.querySelectorAll('.uses.none')].some(
        (el) => el.closest('tr, .row')?.textContent.includes(n),
      );
      return pill;
    });
  })(),
  'zero-use constants carry the unused pill',
);
check(
  'the motion row says whether the chrome uses it',
  (() => {
    const t = d.getElementById('l-motion').textContent;
    return window.TOKENS.motionMentions === 0
      ? /does not name these yet/.test(t)
      : /named \d+×/.test(t);
  })(),
  `${window.TOKENS.motionMentions} mentions in app sources`,
);
const vocabTotal = Object.values(window.TOKENS.appVocab).reduce((n, v) => n + v.length, 0);
const vocabRows = d.querySelectorAll('#vocab table.vocab tbody tr').length;
check(
  'every named constant the chrome uses is on the sheet',
  vocabRows === vocabTotal + Object.keys(window.TOKENS.appVocab).length,
  `${vocabRows} rows for ${vocabTotal} aliases in 5 families`,
);
check(
  'every chrome constant resolves to a step',
  d.body.dataset.vocabBroken === '0',
  `broken=${d.body.dataset.vocabBroken}`,
);
const colorRows = [...d.querySelectorAll('#colornames tbody tr')].filter((tr) => tr.querySelector('.alias'));
const colorCount = Object.keys(window.TOKENS.colorAliases).length;
check(
  'every chrome colour is named and classified',
  colorRows.length === colorCount &&
    Number(d.body.dataset.pinnedColors) === window.TOKENS.colorResolved.literal,
  `${colorRows.length}/${colorCount} rows, ${d.body.dataset.pinnedColors} pinned`,
);
check(
  'colour swatches are live (theme-aware)',
  (() => {
    const before = d.querySelector('#colornames .swatch').getAttribute('style');
    d.querySelector('#themes button[data-theme=hc]').click();
    const after = d.querySelector('#colornames .swatch').getAttribute('style');
    d.querySelector('#themes button[data-theme=graphite]').click();
    return before !== after;
  })(),
  'HC swatch differs from Graphite',
);
const used = new Set(
  [...`${html}${appJs}`.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]),
);
const defined = new Set([...tokensCss.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
const undefinedVars = [...used].filter((v) => !defined.has(v));
check('every var(--x) the sheet uses is defined', undefinedVars.length === 0, undefinedVars.join(', '));
const rawLiterals = html.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
check(
  "the sheet's own chrome uses no raw colour literals",
  rawLiterals.length === 0,
  rawLiterals.join(', '),
);
check('narrow frame is 980 wide', d.querySelector('#narrow .win').style.width === '980px');
check('wide frame is 1920 wide', d.querySelector('#wide .win').style.width === '1920px');
check('ratchet table lists ceilings', d.querySelectorAll('#ratchet tr').length >= 21, `${d.querySelectorAll('#ratchet tr').length} rows`);
check('audit says nothing is over ceiling', !d.querySelector('#ratchet .pill.no'), 'no over-ceiling pill');
check('spacing audit table', d.querySelectorAll('#offsets tr').length === 15);
check('rules documented', d.querySelectorAll('#rules > div').length === 6);
check('fluid widths table', d.querySelectorAll('#fluid tr').length === 6, `${d.querySelectorAll('#fluid tr').length} rows`);
// The sheet solves the wordmark width from the reference the source records,
// so recomputing search_rect from the sheet's own numbers must land back on it.
const tb = window.TOKENS && window.AUDIT.titleBar;
const solvedX = (() => {
  const leftEnd = 12 + tb.logoW + 12 + tb.wordmarkW + 12;
  const rightStart = tb.measuredW - 12 - 32 - 8 - 97 - 12;
  return leftEnd + (rightStart - leftEnd - tb.searchW) / 2;
})();
check(
  'the title bar numbers reproduce the measured search position',
  Math.abs(solvedX - tb.measuredX) < 0.05,
  `solved x=${solvedX.toFixed(1)} vs measured ${tb.measuredX}`,
);
check(
  'the invert claim is computed from the dock ranges',
  (() => {
    const a = window.AUDIT;
    const naive = a.window.min[0] - a.docks.nav - a.docks.leftRange[1] - a.docks.rightRange[1];
    const text = d.getElementById('layout').textContent;
    return text.includes(`${naive}px`) && naive < 0;
  })(),
  'aria-free arithmetic on the parsed ranges',
);
check('provenance line', /@ [0-9a-f]{7}/.test(d.getElementById('provenance').textContent));
process.exit(errors.length ? 1 : 0);
