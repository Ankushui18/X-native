// Layout + token audit, computed from the shipping code with the *same* parser
// the ratchet test uses (call extent + top-level argument split), so the
// numbers on the design sheet are the numbers CI enforces.
import { readFileSync as readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const readFileSync = (p, enc) => readSync(p instanceof URL ? fileURLToPath(p) : p, enc);
const DIR = fileURLToPath(new URL('../../apps/x-designer/src/bin/x_native_app/', import.meta.url));
const XUI = new URL('../../crates/x-ui/src/design_system.rs', import.meta.url);
const APP_THEME = DIR + 'theme.rs';
const themeSrc = readFileSync(APP_THEME, 'utf8');

const production = (src) => {
  const i = src.indexOf('#[cfg(test)]');
  return i < 0 ? src : src.slice(0, i);
};
const splitArgs = (body) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
};
const calls = (src, callee) => {
  const needle = callee + '(';
  const found = [];
  let i = 0;
  for (;;) {
    const j = src.indexOf(needle, i);
    if (j < 0) break;
    let depth = 1;
    let k = j + needle.length;
    while (k < src.length && depth > 0) {
      if ('([{'.includes(src[k])) depth += 1;
      else if (')]}'.includes(src[k])) depth -= 1;
      k += 1;
    }
    found.push(splitArgs(src.slice(j + needle.length, k - 1)));
    i = k;
  }
  return found;
};
const bareFloat = (a) => {
  const t = (a ?? '').trim();
  if (!t || !/^[0-9.]+$/.test(t)) return null;
  return parseFloat(t);
};

const PAINTED = ['dashboard.rs', 'editor_ui.rs', 'board_ui.rs', 'loading.rs', 'command.rs', 'paint.rs', 'run.rs', 'state.rs', 'icons.rs', 'theme.rs'];
const radii = {};
const icons = {};
const colours = {};
const ink = {};
let canvasSpace = 0;
for (const f of PAINTED) {
  const src = production(readFileSync(DIR + f, 'utf8'));
  let r = 0;
  for (const callee of ['fill_rrect', 'stroke_rrect']) {
    for (const args of calls(src, callee)) {
      const v = bareFloat(args[2]);
      if (v !== null) {
        r += 1;
        if ([1.0, 1.5, 18.0].includes(v)) canvasSpace += 1;
      }
    }
  }
  radii[f] = r;
  icons[f] = calls(src, 'draw_icon').filter((a) => bareFloat(a[4]) !== null).length;
  const prod = production(readFileSync(DIR + f, 'utf8'));
  colours[f] = (prod.match(/Color::from_rgba?8/g) || []).length;
  ink[f] = (prod.match(/Color::WHITE|Color::BLACK/g) || []).length;
}

// the ceilings CI enforces, read from the test itself
const test = readFileSync(DIR + 'design_tokens_test.rs', 'utf8');
const tableOf = (name) => {
  const start = test.indexOf(`const ${name}: &[(&str, usize)] = &[`);
  const body = test.slice(start, test.indexOf('\n];', start));
  return Object.fromEntries([...body.matchAll(/\("([a-z_.]+)",\s*(\d+)\)/g)].map((m) => [m[1], parseInt(m[2], 10)]));
};
const ceilings = { colours: tableOf('PAINTED'), ink: tableOf('INK') };
const canvasList = test.match(/const CANVAS_SPACE_RADII: &\[f64\] = &\[([^\]]+)\]/)[1].split(',').map((s) => parseFloat(s));

// spacing: the offsets the chrome actually uses
const ladder = [0, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48];
const offsets = {};
let totalOffsets = 0;
let onLadder = 0;
const perFile = {};
for (const f of ['dashboard.rs', 'editor_ui.rs', 'board_ui.rs', 'command.rs', 'loading.rs', 'run.rs', 'paint.rs']) {
  const src = production(readFileSync(DIR + f, 'utf8'));
  let n = 0;
  for (const m of src.matchAll(/\.(?:x0|x1|y0|y1)\s*(?:[+-])\s*(\d+(?:\.\d+)?)/g)) {
    const v = parseFloat(m[1]);
    offsets[v] = (offsets[v] || 0) + 1;
    n += 1;
    totalOffsets += 1;
    if (ladder.includes(v)) onLadder += 1;
  }
  perFile[f] = n;
}

// Everything the fluid table asserts is read from the file that owns it. A
// hardcoded copy of `ED_CANVAS_MIN` is exactly how a design sheet starts lying:
// the number is right the day it is typed and wrong the day the dock changes.
// `constOf` throws rather than guessing, so a rename fails the generator
// instead of quietly freezing a stale number onto the sheet.
const EXACT = (src, name, where) => {
  // `pub const NAME: f64 = 1.0`, `name: f64 = 1.0,`, `name = 1.0` — the
  // declaration, the type annotation and the trailing comma all vary. Walk the
  // lines that mention the name and take the first one that carries a number,
  // so a `self.name` read elsewhere in the file cannot shadow the declaration.
  let m = null;
  const whole = new RegExp('\\b' + name + '\\b'); // LOGO must not match LOGO_CELL_W
  for (const line of src.split('\n')) {
    if (!whole.test(line)) continue;
    const hit = line.match(/[=:]\s*([0-9.]+)/);
    if (hit) {
      m = hit;
      break;
    }
  }
  if (!m) throw new Error(`build_audit: ${name} not found in ${where} — update the sheet`);
  return parseFloat(m[1]);
};
const dashSrc = readFileSync(DIR + 'dashboard.rs', 'utf8');
const stateSrc = readFileSync(DIR + 'state.rs', 'utf8');
const geom = {
  nav: EXACT(stateSrc, 'nav_bar_w', 'state.rs App::new'),
  dashSide: EXACT(themeSrc, 'DASH_SIDE_W', 'theme.rs'),
  dashMx: EXACT(dashSrc, 'const MX', 'dashboard.rs'),
  cardGap: (() => {
    const m = dashSrc.match(/let gap = ([\d.]+);\n\s*let cw = \(x1 - x0 - gap \* 3\.0\) \/ 4\.0/);
    if (!m) throw new Error('build_audit: the quick-card row changed shape — update the sheet');
    return parseFloat(m[1]);
  })(),
  gridGap: (() => {
    const m = dashSrc.match(/let gap = ([\d.]+);\n\s*let cols = 3\.0;/);
    if (!m) throw new Error('build_audit: the grid card row changed shape — update the sheet');
    return parseFloat(m[1]);
  })(),
  cols: 3,
};

// Chrome constants the screens gallery draws with — parsed, not retyped, for
// the same reason the dock table is: a mock that carries its own copy of
// ED_TITLE_H is a mock that will one day show the previous layout.
const cmdSrc = readFileSync(DIR + 'command.rs', 'utf8');
const ui = {
  titleH: Number(themeSrc.match(/ED_TITLE_H: f64 = ([\d.]+)/)[1]),
  logoCell: Number(themeSrc.match(/LOGO_CELL_W: f64 = ([\d.]+)/)[1]),
  treeRowH: Number(themeSrc.match(/TREE_ROW_H: f64 = ([\d.]+)/)[1]),
  inputH: Number(themeSrc.match(/INPUT_H: f64 = ([\d.]+)/)[1]),
  pillH: Number(themeSrc.match(/PILL_H: f64 = ([\d.]+)/)[1]),
  toolbarH: Number(themeSrc.match(/TOOLBAR_H: f64 = ([\d.]+)/)[1]),
  toolbarBottom: Number(themeSrc.match(/TOOLBAR_BOTTOM: f64 = ([\d.]+)/)[1]),
  toolIcon: Number(themeSrc.match(/TOOL_ICON: f64 = ([\d.]+)/)[1]),
  menuW: Number(themeSrc.match(/MENU_WIDTH: f64 = ([\d.]+)/)[1]),
  menuRowH: Number(themeSrc.match(/MENU_ROW_H: f64 = ([\d.]+)/)[1]),
  appMenuW: Number(themeSrc.match(/APP_MENU_WIDTH: f64 = ([\d.]+)/)[1]),
  dashTitleH: Number(themeSrc.match(/DASH_TITLE_H: f64 = ([\d.]+)/)[1]),
  draftRowH: Number(themeSrc.match(/DRAFT_ROW_H: f64 = ([\d.]+)/)[1]),
  searchW: Number(themeSrc.match(/SEARCH_W: f64 = ([\d.]+)/)[1]),
  searchH: Number(themeSrc.match(/SEARCH_H: f64 = ([\d.]+)/)[1]),
  logo: Number(themeSrc.match(/LOGO: f64 = ([\d.]+)/)[1]),
  cmdPaletteW: Number(cmdSrc.match(/PALETTE_WIDTH: f64 = ([\d.]+)/)[1]),
  cmdPaletteMaxH: Number(cmdSrc.match(/PALETTE_MAX_HEIGHT: f64 = ([\d.]+)/)[1]),
  cmdInputH: Number(cmdSrc.match(/INPUT_HEIGHT: f64 = ([\d.]+)/)[1]),
  cmdRowH: Number(cmdSrc.match(/ROW_HEIGHT: f64 = ([\d.]+)/)[1]),
};

const docks = {
  nav: geom.nav,
  canvasMin: Number(themeSrc.match(/ED_CANVAS_MIN: f64 = ([\d.]+)/)[1]),
  left: Number(themeSrc.match(/ED_LEFT_W: f64 = ([\d.]+)/)[1]),
  leftRange: [
    Number(themeSrc.match(/ED_LEFT_MIN: f64 = ([\d.]+)/)[1]),
    Number(themeSrc.match(/ED_LEFT_MAX: f64 = ([\d.]+)/)[1]),
  ],
  right: Number(themeSrc.match(/ED_RIGHT_W: f64 = ([\d.]+)/)[1]),
  rightMin: Number(themeSrc.match(/ED_RIGHT_MIN: f64 = ([\d.]+)/)[1]),
  rightRange: [
    Number(themeSrc.match(/ED_RIGHT_MIN: f64 = ([\d.]+)/)[1]),
    Number(themeSrc.match(/ED_RIGHT_MAX: f64 = ([\d.]+)/)[1]),
  ],
  titleH: Number(themeSrc.match(/ED_TITLE_H: f64 = ([\d.]+)/)[1]),
};

// `dashboard::search_rect` in four lines, so the sheet's "search slack" is the
// app's own arithmetic rather than a pile of magic numbers that look right:
//   left_end  = 12 + LOGO + 12 + wordmark + 12
//   right_start = w - 12 - 32 - 8 - new_file_w - 12
//   x0 = left_end + (right_start - left_end - SEARCH_W) / 2
// The wordmark width is not a constant in the code — it is measured at runtime
// from Inter 14/600 with -0.025 tracking. The one measurement the source does
// record is the reference landing spot ("measured x=460.1 at 1440" beside the
// function), so the sheet solves the code's own formula for it: change any
// input and this number moves with it instead of being re-typed by hand.
const TITLE_BAR = { pad: 12, avatar: 32, gap: 8, newFile: 97, searchGap: 12 };
const searchW = EXACT(themeSrc, 'SEARCH_W', 'theme.rs');
const logoW = EXACT(themeSrc, 'LOGO', 'theme.rs');
const measured = readFileSync(DIR + 'dashboard.rs', 'utf8')
  .replace(/^\s*\/\/ ?/gm, '') // the reference is written across two comment lines
  .replace(/\s+/g, ' ') // ...so join them before matching
  .match(/measured x=([\d.]+) at (\d+)/);
if (!measured) throw new Error('build_audit: search_rect lost its measured reference — update the sheet');
const [measuredX, measuredW] = [parseFloat(measured[1]), parseFloat(measured[2])];
const rightStart = (w) => w - TITLE_BAR.pad - TITLE_BAR.avatar - TITLE_BAR.gap - TITLE_BAR.newFile - TITLE_BAR.searchGap;
const leftEnd = (wordmark) => TITLE_BAR.pad + logoW + TITLE_BAR.pad + wordmark + TITLE_BAR.pad;
const wordmarkW = 2 * measuredX - rightStart(measuredW) + searchW - (TITLE_BAR.pad * 3 + logoW);
const searchSlack = (w) => rightStart(w) - leftEnd(wordmarkW) - searchW;

const auditPayload = {
  ratchet: {
    ceilings,
    radii,
    icons,
    canvasSpaceRadii: canvasSpace,
    canvasList,
    colourLiterals: colours,
    inkLiterals: ink,
  },
  spacing: {
    ladder,
    total: totalOffsets,
    onLadder,
    perFile,
    top: Object.entries(offsets)
      .map(([v, c]) => ({ value: parseFloat(v), count: c, onLadder: ladder.includes(parseFloat(v)) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 14),
  },
  fluid: [980, 1280, 1440, 1920, 2560].map((w) => {
    const main = w - geom.dashMx - 24; // mx1 - MX at the default window
    const cards = (main - geom.cardGap * 3) / 4;
    const grid = (main - geom.gridGap * (geom.cols - 1)) / geom.cols;
    // Mirrors `App::editor_regions`: left takes what it wants up to the right
    // dock's floor, the right takes what is left, and ED_CANVAS_MIN survives.
    const room = Math.max(0, w - geom.nav - docks.canvasMin);
    const worstLeft = Math.min(docks.leftRange[1], Math.max(0, room - docks.rightMin));
    const worstRight = Math.min(docks.rightRange[1], Math.max(0, room - worstLeft));
    return {
      window: w,
      card: Math.round(cards * 10) / 10,
      grid: Math.round(grid * 10) / 10,
      canvas: w - geom.nav - docks.left - docks.right,
      canvasWorst: w - geom.nav - worstLeft - worstRight,
      searchSlack: Math.round(searchSlack(w) * 10) / 10,
      docks: { left: worstLeft, right: worstRight, canvas: Math.round(w - geom.nav - worstLeft - worstRight) },
    };
  }),
  window: { min: [980, 680], default: [1440, 900] },
  titleBar: { ...TITLE_BAR, searchW, logoW, wordmarkW, measuredX, measuredW },
  canvasFloor: docks.canvasMin,
  docks,
  geom,
  ui,
};
const OUT = (f) => fileURLToPath(new URL('./' + f, import.meta.url));
writeFileSync(OUT('audit.json'), JSON.stringify(auditPayload, null, 2));
writeFileSync(OUT('audit.js'), `window.AUDIT = ${JSON.stringify(auditPayload)};\n`);
const overColour = PAINTED.filter((f) => colours[f] > (ceilings.colours[f] ?? 0) || ink[f] > (ceilings.ink[f] ?? 0));
console.log(
  `radii left ${Object.values(radii).reduce((a, b) => a + b, 0)} (canvas-space ${canvasSpace}), raw icons ${Object.values(icons).reduce((a, b) => a + b, 0)}, over-ceiling files: ${overColour.length ? overColour.join(',') : 'none'}, offsets ${totalOffsets} (${Math.round((100 * onLadder) / totalOffsets)}% on ladder)`,
);
console.log(
  `search_rect: wordmark solved at ${wordmarkW.toFixed(1)}px from the measured x=${measuredX} at ${measuredW}; ` +
    `slack ${[980, 1440, 2560].map((w) => `${w}:${searchSlack(w).toFixed(1)}`).join(' ')}`,
);
console.log(
  `chrome constants read from source: title ${ui.titleH}, tree row ${ui.treeRowH}, toolbar ${ui.toolbarH}+${ui.toolbarBottom}, ` +
    `menu ${ui.menuW}/${ui.menuRowH}, app menu ${ui.appMenuW}, dash title ${ui.dashTitleH}, ` +
    `command palette ${ui.cmdPaletteW}×${ui.cmdPaletteMaxH}`,
);
console.log(
  `geometry read from source — nav ${geom.nav}, dash sidebar ${geom.dashSide} + mx ${geom.dashMx}, ` +
    `card gap ${geom.cardGap}, grid gap ${geom.gridGap}; docks ${docks.left}/${docks.right} ` +
    `(ranges ${docks.leftRange.join('-')}/${docks.rightRange.join('-')}), canvas floor ${docks.canvasMin}`,
);
