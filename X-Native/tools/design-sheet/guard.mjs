// Design + Figma conformance guard — the gate's answer to "why do design errors
// keep coming back?".
//
// Dependency-free on purpose (node:fs only): unlike the two jsdom sheets, this
// runs on a bare CI runner, inside `scripts/check.sh`, on every push. It checks
// three things, each one a defect class this repository has actually shipped:
//
//   1. ONE OWNER PER DECISION — a hardcoded colour in two files is two owners of
//      one decision, and two owners drift. Found by this check the first time it
//      ran: the missing-asset grey was written out at three sites (the model's
//      `Node::image` default, the Vello sink, the tiny-skia sink — whose comment
//      promised it "matches the Vello sink"), and the pattern fallback at two.
//      Before those, the canvas name label: ink at four sites across two encoders
//      (one arm had already drifted to 70% opacity), and the size at three
//      (14/18/20px in the same canvas).
//   2. A RATCHET ON ENGINE-CHROME LITERALS — a new hardcoded colour in the engine
//      is a design decision taken at a paint site. The ceilings are a ratchet,
//      exactly like DEAD_CODE_CEILING in `scripts/check.sh`: fixing a literal
//      means lowering the number, adding one means this check fails and the author
//      either routes it through a named constant or raises the ceiling on purpose.
//      The application chrome has had the same kind of ratchet since the Daylight
//      pass — `apps/x-designer/src/bin/x_native_app/design_tokens_test.rs`.
//   3. THE STATUS BAND IS CHROME — the owner's report called it "a red bar
//      through the artwork". The geometry half of that (no region runs under the
//      band, no control hides in it) is pinned by Rust tests; the colour half is
//      a source claim, because the application paints into a GPU scene that no
//      unit test can read back. So this check reads the painter: one rect, one
//      height, a panel fill, and the flow viewer's gate on the front.
//   4. FIGMA PARITY IS A CLAIM WITH A TEST — every row of `docs/FIGMA_PARITY.md`
//      that says "we behave like Figma" must name the test that pins it, and that
//      name must still exist. A row with no test is reported as open, not hidden.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { iconAudit } from './icon_scan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// Two file sets, two questions. The literal scan wants PRODUCTION chrome, so it
// skips test code (a fixture's colour is not a design decision). The Figma-parity
// scan wants EVERY source, because a test is precisely what pins a behaviour.
const isTest = (name) =>
  ['tests', 'benches', 'examples'].includes(name) ||
  /^tests?_mod\.rs$/.test(name) ||
  name === 'tests.rs';
const walk = (dir, out = [], includeTests = true) => {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'target' || name === 'node_modules') continue;
    if (!includeTests && isTest(name)) continue;
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out, includeTests);
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
};

// ------------------------------------------------------- one owner + ratchet
// Engine chrome. Text inside `#[cfg(test)]` is a fixture, not a design decision,
// so it is cut before scanning.
const production = (src) => {
  const i = src.indexOf('#[cfg(test)]');
  return i < 0 ? src : src.slice(0, i);
};
// file -> how many raw colour literals it may keep. Lower it when you remove one;
// a deliberate addition raises it here, in a diff a reviewer can see.
const CEILINGS = {
  'crates/x-core/src/fallbacks.rs': 2, // the two greys themselves, named
  'crates/x-core/src/node.rs': 3, // section wash + section stroke + the text default
  'crates/x-render/src/ir.rs': 2, // `label_ink()` + the section chip's ink
  'crates/x-render/src/raster.rs': 1, // the no-font text placeholder box
  'crates/x-render/src/stress.rs': 2, // a benchmark scene's content, not chrome
};
const HEX =
  /Color::from_rgba?8\(\s*0x([0-9a-fA-F]{2}),\s*0x([0-9a-fA-F]{2}),\s*0x([0-9a-fA-F]{2})/g;

const repo = root.replace(/\/$/, '');
const engineFiles = walk(repo + '/crates', [], false)
  .map((p) => p.slice(root.length))
  .sort();
const counts = new Map();
const owners = new Map(); // hex -> Set(files), for the one-owner rule
for (const file of engineFiles) {
  const found = [...production(read(file)).matchAll(HEX)].map((m) =>
    `${m[1]}${m[2]}${m[3]}`.toLowerCase(),
  );
  counts.set(file, found.length);
  for (const hex of found) {
    if (!owners.has(hex)) owners.set(hex, new Set());
    owners.get(hex).add(file);
  }
}
const total = [...counts.values()].reduce((a, b) => a + b, 0);
const dirty = [...counts].filter(([, n]) => n > 0).map(([f]) => f);
const undeclared = dirty.filter((f) => !(f in CEILINGS));
check(
  'every engine file that paints a literal declares a ceiling',
  undeclared.length === 0,
  undeclared.length
    ? `add to CEILINGS: ${undeclared.join(', ')}`
    : `${total} literals in ${dirty.length} of ${engineFiles.length} files`,
);
const over = Object.entries(CEILINGS).filter(([f, n]) => (counts.get(f) ?? 0) > n);
check(
  'engine-chrome literals stay under their ceilings',
  over.length === 0,
  Object.entries(CEILINGS)
    .filter(([f]) => counts.get(f))
    .map(([f, n]) => `${f.split('/').pop()} ${counts.get(f)}/${n}`)
    .join(', ') + (over.length ? ' — route the literal through a named constant' : ''),
);
const sharedHex = [...owners].filter(([, files]) => files.size > 1);
check(
  'every engine colour has exactly ONE owner',
  sharedHex.length === 0,
  sharedHex.length
    ? sharedHex
        .map(([hex, files]) => `${hex} in ${[...files].map((f) => f.split('/').pop()).join(' + ')}`)
        .join('; ')
    : `${owners.size} colours, one definition each`,
);

// ------------------------------------------------------------------- icons
// `draw_icon` no-ops on an unknown name, so a typo ships as a blank space.
const iconsSrc = read('apps/x-designer/src/bin/x_native_app/icons.rs');
const iconsBody = iconsSrc.slice(iconsSrc.indexOf('const ICONS: &[(&str, &[&str])] = &['));
const iconNames = [...iconsBody.matchAll(/\(\s*"([a-z0-9-]+)",\s*&\[/g)].map((m) => m[1]);
const audit = iconAudit(root + 'apps/x-designer/src/bin/x_native_app/', iconNames);
check(
  'every icon name the chrome asks for exists in the set',
  iconNames.length > 20 && audit.missing.length === 0,
  `${audit.used} names used in ${audit.files} files, ${iconNames.length} in the set` +
    (audit.missing.length ? `, MISSING: ${audit.missing.join(', ')}` : ''),
);

// ------------------------------------------------------------ Figma parity
const sources = walk(repo + '/apps', walk(repo + '/crates'))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

const parity = read('docs/FIGMA_PARITY.md');
// The contract is the table in section 2; section 3 is the open list. Scoping to
// the sections keeps the decision tables in section 1 out of the row count.
const section = (md, heading) => {
  const i = md.indexOf(heading);
  if (i < 0) return '';
  const j = md.indexOf('\n## ', i + 1);
  return j < 0 ? md.slice(i) : md.slice(i, j);
};
const isHeader = (l) => /^\|\s*(behaviour|Behaviour|decision|decision)\s*\|/.test(l);
const tableRows = (md) =>
  md.split('\n').filter((l) => l.startsWith('| ') && !isHeader(l) && !/^\|\s*-/.test(l));

// A source cell is a Figma URL, or an explicit provenance tag for the rows that
// are our own invariant / an owner report rather than a Figma behaviour.
const provenance = /^(owner report|our own invariant)/i;
// A test cell names tests in backticks, or is marked `open`. Nothing else is
// allowed: a mistyped name must not pass as "no test named here".
const token = /`([A-Za-z0-9_]{6,})`/g;

let pinned = 0;
const noSource = [];
const broken = [];
const stray = [];
for (const row of tableRows(section(parity, '## 2.'))) {
  const cells = row
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.length < 4) continue;
  const [behaviour, source, , test] = cells;
  if (!/https?:\/\//.test(source) && !provenance.test(source)) noSource.push(behaviour);
  const tests = [...test.matchAll(token)].map((m) => m[1]);
  if (tests.length === 0) {
    if (!/^open\b/i.test(test)) stray.push(`${behaviour} → "${test}"`);
    continue;
  }
  pinned += 1;
  for (const t of tests) {
    if (!sources.includes(`fn ${t}(`)) broken.push(`${t} (${behaviour})`);
  }
}
const open = tableRows(section(parity, '## 3.')).length;
check('every Figma-parity row cites a Figma source', noSource.length === 0, noSource.join('; '));
check(
  'every pinned Figma behaviour still has its test',
  broken.length === 0,
  broken.join('; '),
);
check(
  'a row with no test is marked open (not silently unpinned)',
  stray.length === 0,
  stray.length ? stray.join('; ') : 'every test cell is a test name or "open"',
);
// --------------------------------------------------------- the status band
// `production()` cuts at the file's first `#[cfg(test)]`, and run.rs declares
// its test modules near the top — so slice the painter out first, then cut.
const appRun = read('apps/x-designer/src/bin/x_native_app/run.rs');
const feedback = appRun.slice(appRun.indexOf('fn paint_feedback('));
const feedbackBody = production(feedback.slice(0, feedback.indexOf('\n}\n')));
check(
  'the status band is a panel row painted from one rect, and the flow viewer turns it off',
  /app\.status_band\(\)/.test(feedbackBody) &&
    /C_PANEL/.test(feedbackBody) &&
    /paints_status_band\(\)/.test(feedbackBody) &&
    !/C_DANGER|C_ERR|C_WARN/.test(feedbackBody),
  'run.rs::paint_feedback',
);
const chromeSrc = walk(repo + '/apps/x-designer/src/bin/x_native_app')
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');
check(
  "the band's height has one owner",
  /pub const ED_STATUS_H/.test(
    read('apps/x-designer/src/bin/x_native_app/theme.rs'),
  ) && !/win_h\s*-\s*22(\.0)?\b/.test(chromeSrc),
  'ED_STATUS_H in theme.rs; no `win_h - 22` anywhere else in the chrome',
);

console.log(`      ${pinned} behaviours pinned by a test, ${open} open (documented, not pinned)`);
console.log(
  `SUMMARY  design + Figma conformance: 9 checks, ${pinned} pinned, ${open} open, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
