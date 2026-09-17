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
    const main = w - 284 - 24; // mx1 - MX
    const cards = (main - 12 * 3) / 4;
    const grid = (main - 16 * 2) / 3;
    // editor_regions(): the docks yield to the canvas floor
    const room = Math.max(0, w - 48 - 280);
    const worstLeft = Math.min(480, Math.max(0, room - 240));
    const worstRight = Math.min(520, Math.max(0, room - worstLeft));
    return {
      window: w,
      card: Math.round(cards * 10) / 10,
      grid: Math.round(grid * 10) / 10,
      canvas: w - 48 - 280 - 340,
      canvasWorst: w - 48 - worstLeft - worstRight,
      searchSlack: Math.round(w - 12 - 32 - 8 - 97 - 12 - (12 + 28 + 12 + 66 + 12) - 480),
    };
  }),
  window: { min: [980, 680], default: [1440, 900] },
  canvasFloor: Number(themeSrc.match(/ED_CANVAS_MIN: f64 = ([\d.]+)/)[1]),
  docks: {
    nav: 48,
    left: Number(themeSrc.match(/ED_LEFT_W: f64 = ([\d.]+)/)[1]),
    leftRange: [
      Number(themeSrc.match(/ED_LEFT_MIN: f64 = ([\d.]+)/)[1]),
      Number(themeSrc.match(/ED_LEFT_MAX: f64 = ([\d.]+)/)[1]),
    ],
    right: Number(themeSrc.match(/ED_RIGHT_W: f64 = ([\d.]+)/)[1]),
    rightRange: [
      Number(themeSrc.match(/ED_RIGHT_MIN: f64 = ([\d.]+)/)[1]),
      Number(themeSrc.match(/ED_RIGHT_MAX: f64 = ([\d.]+)/)[1]),
    ],
  },
};
const OUT = (f) => fileURLToPath(new URL('./' + f, import.meta.url));
writeFileSync(OUT('audit.json'), JSON.stringify(auditPayload, null, 2));
writeFileSync(OUT('audit.js'), `window.AUDIT = ${JSON.stringify(auditPayload)};\n`);
const overColour = PAINTED.filter((f) => colours[f] > (ceilings.colours[f] ?? 0) || ink[f] > (ceilings.ink[f] ?? 0));
console.log(
  `radii left ${Object.values(radii).reduce((a, b) => a + b, 0)} (canvas-space ${canvasSpace}), raw icons ${Object.values(icons).reduce((a, b) => a + b, 0)}, over-ceiling files: ${overColour.length ? overColour.join(',') : 'none'}, offsets ${totalOffsets} (${Math.round((100 * onLadder) / totalOffsets)}% on ladder)`,
);
