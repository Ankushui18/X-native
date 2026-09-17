// Renders the design sheet from the generated tokens (tokens.json/js, which are
// themselves generated from the Rust sources) plus the layout audit.
const T = window.TOKENS;
const ICONS = window.ICONS;
const AUDIT = window.AUDIT;

const THEMES = [
  ['graphite', 'Graphite', 'dark — the shipping default'],
  ['daylight', 'Daylight', 'light — bright rooms, screen sharing'],
  ['hc', 'High contrast', 'AA+ everywhere, for low vision'],
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const contrast = (a, b) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

let theme = 'graphite';
const palette = () => T.palettes[theme];

// ---------------------------------------------------------------- icon helper
const svgIcon = (name, size, cls = '') => {
  const paths = ICONS[name];
  if (!paths) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths
    .map((d) => `<path d="${d}"/>`)
    .join('')}</svg>`;
};

// ------------------------------------------------------------------- palette
function renderPalette() {
  const p = palette();
  // exactly the roles the crate audits as text (TEXT_ROLES in x-ui/theme.rs)
  const textRoles = new Set(T.textRoles);
  // the same six surfaces the crate's audit walks
  const surfaces = ['background', 'canvas', 'surface', 'surface_elevated', 'surface_hover', 'surface_active'];
  document.getElementById('roles').innerHTML = T.roleNames
    .map((r) => {
      const worst = Math.min(...surfaces.map((bg) => contrast(p[r], p[bg])));
      const isText = textRoles.has(r);
      const cls = isText ? (worst >= 4.5 ? 'pass' : 'warn') : '';
      const orphan = (T.orphanRoles || []).includes(r);
      const note = isText ? `${worst.toFixed(2)}:1 worst surface` : 'fill / chrome';
      return `<div class="role">
        <span class="chip" style="background:${p[r]}"></span>
        <span class="meta">
          <b>${r}${orphan ? ' <span class="uses none">no chrome name</span>' : ''}</b>
          <span>${p[r]} · <span class="ratio ${cls}">${note}</span></span>
        </span>
      </div>`;
    })
    .join('');
  const textCount = T.roleNames.filter((r) => textRoles.has(r)).length;
  document.getElementById('palette-note').textContent =
    `${T.roleNames.length} roles × ${THEMES.length} palettes. ` +
    `${textCount} carry text and show their worst-surface ratio (AA is 4.5:1); ` +
    `the other ${T.roleNames.length - textCount} are fills, rings and washes — a fill is not ` +
    `measured as ink, so they say so instead of showing a number that would mean nothing. ` +
    `The crate's own test audits every pair.` +
    (T.orphanRoles && T.orphanRoles.length
      ? ` ${T.orphanRoles.length} roles — ${T.orphanRoles.join(', ')} — are named by no chrome ` +
        `constant yet: the palette defines them (and the crate audits the accent fills), but no ` +
        `screen paints with them today.`
      : '');
}

// -------------------------------------------------------------------- ladders
const bar = (w, v, max, alt = '') =>
  `<span class="bar ${alt}" style="width:${Math.max(2, (w * v) / max)}px"></span><span class="nums">${v}</span>`;
const rowOf = (label, inner) => `<div class="row"><span class="label">${label}</span>${inner}</div>`;

// How many call sites name this constant. `0` is a fact worth printing: the
// 16px type step and the fully-round radius exist in the scale but no chrome
// file spells them, and a reader deciding what to reuse should know that.
const uses = (name) => {
  const n = T.usage ? T.usage[name] : undefined;
  if (n === undefined) return '';
  return n === 0
    ? `<span class="uses none" title="declared in theme.rs, named by no call site yet">unused</span>`
    : `<span class="uses" title="${n} reference${n === 1 ? '' : 's'} in the app sources">×${n}</span>`;
};

function renderScales() {
  const s = T.scales;
  const type = Object.entries(s.type);
  const aliasName = (k) => (T.typeAliases ? T.typeAliases[k] || '' : '');
  // NB: the separator is a middle dot, not whitespace — `alias(k).trim()` would
  // leave "T10 ·" and the lookup would miss. Keep the bare name for lookups.
  const alias = (k) => (aliasName(k) ? `${aliasName(k)} · ` : '');
  document.getElementById('l-type').innerHTML =
    `<div class="nums" style="margin-bottom:2px">type — ${type.length} steps, ` +
    `${type.map(([k, v]) => `${alias(k)}${v}px`).join(' · ')} (TypographyScale; the chrome names the alias)</div>` +
    type
      .map(([k, v]) =>
        rowOf(
          `${alias(k)}${k.toLowerCase()} ${v}px ${uses(aliasName(k))}`,
          `<span class="type" style="font-size:${v}px">Ag — quick brown fox</span>`,
        ),
      )
      .join('');

  document.getElementById('l-space').innerHTML =
    `<div class="nums" style="margin-bottom:2px">spacing — ${Object.keys(s.spacing).length} steps in SpacingScale; ` +
    `the chrome's names start at SP_1 (SPACE_0 is the zero, named by nothing)</div>` +
    Object.entries(s.spacing)
      .map(([k, v]) =>
        rowOf(
          `${k.replace('SPACE_', 'SP_').toLowerCase()} ${uses(k.replace('SPACE_', 'SP_'))}`,
          bar(160, v, 48),
        ),
      )
      .join('');

  document.getElementById('l-radius').innerHTML =
    `<div class="nums" style="margin-bottom:2px">radius — ${Object.keys(s.radius).length} steps, R_NONE .. R_FULL</div>` +
    Object.entries(s.radius)
      .map(([k, v]) =>
        rowOf(
          `${k.toLowerCase()} ${uses(`R_${k}`)}`,
          `<span style="width:64px;height:20px;background:var(--surface-hover);border:1px solid var(--border-strong);border-radius:${v}px"></span><span class="nums">${v}</span>`,
        ),
      )
      .join('');

  const IA = window.ICON_AUDIT;
  document.getElementById('l-icon').innerHTML =
    `<div style="width:100%" class="nums">icons — ICON_XS .. ICON_XL (Lucide, stroke ${s.icon.STROKE})</div>` +
    Object.entries(s.icon)
      .filter(([k]) => k !== 'STROKE')
      .map(
        ([k, v]) =>
          `<figure>${svgIcon('search', v)}<figcaption>${k} ${v} ${uses(k === 'STROKE' ? 'STROKE_ICON' : `ICON_${k}`)}</figcaption></figure>`,
      )
      .join('') +
    ['plus', 'sticky-note', 'layout-template', 'star']
      .map((n) => `<figure>${svgIcon(n, 18)}<figcaption>${n}</figcaption></figure>`)
      .join('') +
    (IA
      ? `<div class="nums" style="width:100%; margin-top:6px">` +
        `${Object.keys(ICONS).length} glyphs in <code>icons.rs</code>; ` +
        `<b>${IA.used}</b> are named by the chrome (${IA.where}, ${IA.files} files) — ` +
        (IA.missing.length
          ? `<span class="ratio warn">${IA.missing.length} name${IA.missing.length === 1 ? '' : 's'} not in the set: ${IA.missing.join(', ')}</span>`
          : `none of them missing`) +
        `. ${IA.unused.length} are in the set but not named anywhere yet.</div>`
      : '');
  document.body.dataset.iconsMissing = IA ? String(IA.missing.length) : 'n/a';

  document.getElementById('l-alpha').innerHTML =
    `<div class="nums" style="margin-bottom:2px">alpha — A_WHISPER .. A_STRONG (0–255)</div>` +
    Object.entries(s.alpha)
      .map(([k, v]) =>
        rowOf(`a_${k.toLowerCase()} ${uses('A_' + k)}`, `<span class="swatch" style="width:160px;background:color-mix(in srgb, var(--accent) ${((v / 255) * 100).toFixed(0)}%, transparent)"></span><span class="nums">${v} · ${((v / 255) * 100).toFixed(0)}%</span>`),
      )
      .join('');

  document.getElementById('l-stroke').innerHTML =
    `<div class="nums" style="margin-bottom:2px">stroke</div>` +
    Object.entries(s.stroke)
      .map(([k, v]) => rowOf(`${k.toLowerCase()} ${uses('STROKE_' + k)}`, `<span style="width:160px;border-top:${v}px solid var(--text-primary)"></span><span class="nums">${v}px</span>`))
      .join('');

  document.getElementById('l-motion').innerHTML =
    `<div class="nums" style="margin-bottom:2px">motion — honoured only when reduced-motion is off` +
    (T.motionMentions === 0
      ? ` · the desktop chrome does not name these yet (they are for the shared crate)`
      : ` · named ${T.motionMentions}× by the chrome`) +
    `</div>` +
    Object.entries(s.motion)
      .map(([k, v]) => rowOf(k.replace('_MS', '').toLowerCase(), bar(160, v, 240, 'alt')))
      .join('');
}

// ------------------------------------------------------------ dashboard mock
// The sheet's OWN markup, laid out with the app's numbers: sidebar 260, title
// bar 40, nav rows 32 at pitch 34, sort chip and grid/list toggle 32 tall at
// the right edge of the main column, quick cards 88, grid thumb 140, list rows
// 48. It exists to show density and the audited pairs in a browser without the
// Rust binary; it is NOT a screenshot, and the note above it says so.
function dashboardMock(width, { rows = 3, layout = 'grid', view = 'Home' } = {}) {
  const cards = [
    ['plus', 'New design file', 'Compose, flow, ship — from one file'],
    ['import', 'Import file', 'SVG, PNG, Sketch, Figma JSON'],
    ['sticky-note', 'New board', 'Infinite canvas for brainstorming'],
    ['layout-template', 'Start from template', 'Mobile, landing, system, board'],
  ];
  const files = [
    ['#1BCB55', 'Mobile onboarding', 'Product · Edited 2h ago'],
    ['#5B7CFF', 'Marketing site', 'Marketing · Edited yesterday'],
    ['#FF7A45', 'Design system', 'Platform · Edited 3d ago'],
  ];
  const drafts = [
    ['file-text', 'Checkout flow', '2 min ago'],
    ['frame', 'Pricing page', '18 min ago'],
    ['component', 'Nav bar', '1h ago'],
  ];
  const navs = [
    ['layout-dashboard', 'Home'],
    ['clock', 'Recents'],
    ['star', 'Starred'],
    ['trash-2', 'Trash'],
  ];
  // the search is centred in the space between the wordmark group and the
  // right cluster — the same arithmetic as `search_rect()` in dashboard.rs
  // jsdom has no 2d context and a headless run has no fonts yet; the fallback
  // is the measured width of "X-Native" at 14px/600 in Inter
  let mark = 66;
  try {
    const ctx = (dashboardMock.ctx ||= document.createElement('canvas').getContext('2d'));
    ctx.font = '600 14px Inter';
    mark = ctx.measureText('X-Native').width;
  } catch {
    /* keep the fallback */
  }
  const leftEnd = 12 + 16 + 12 + mark + 12;
  const rightStart = width - 16 - 24 - 12;
  const searchX = leftEnd + (rightStart - leftEnd - 480) / 2;
  return `
  <div class="win tight" style="width:${width}px">
    <div class="titlebar">
      <div class="wordmark"><span class="gl"></span>X-Native</div>
      <div class="search" style="left:${searchX}px; width:480px">
        ${svgIcon('search', 16)}<span>Search recent local files</span><kbd>⌘K</kbd>
      </div>
      <span class="btn ghost tb-newfile">${svgIcon('plus', 16)}New file</span>
      <div class="avatar" style="right:16px">A</div>
    </div>
    <div class="sidebar" style="height:${620 - 40}px">
      <div class="side-label">${svgIcon('box', 12)}DRAFTS</div>
      <div class="side-head"><span class="sdot"></span><span>Personal</span></div>
      ${navs
        .map(
          ([icon, label]) =>
            `<div class="side-row${label === view ? ' active' : ''}">${svgIcon(icon, 16)}${label}</div>`,
        )
        .join('')}
      <div class="side-div"></div>
      <div class="side-label">LOCAL WORKSPACE</div>
      <div class="side-block"><b>No account required</b><span>Cloud teams are not available yet</span></div>
      <div class="side-label">THE WORKFLOW</div>
      ${[['1', 'Compose', 'Frames, auto layout, vectors'], ['2', 'Flow', 'Connect screens, preview'], ['3', 'Ship', 'Export PNG, PDF, SVG']]
        .map(
          ([n, name, sub]) =>
            `<div class="wrow"><span class="wnum">${n}</span><div class="wtxt"><b>${name}</b><span>${sub}</span></div></div>`,
        )
        .join('')}
    </div>
    <div class="main">
      <div class="head">
        <div class="h1">Your design workspace</div>
        <div class="grow"></div>
        <div class="sortchip">${svgIcon('arrow-up-down', 16)}<span>Sorted by Edited</span>${svgIcon('chevron-down', 12)}</div>
        <div class="seglay">
          <span class="lay${layout === 'grid' ? ' on' : ''}">${svgIcon('grid-2x2', 16)}Grid</span>
          <span class="lay${layout === 'list' ? ' on' : ''}">${svgIcon('list', 16)}List</span>
        </div>
      </div>
      <div class="cards">
        ${cards
          .map(
            ([icon, title, sub]) => `<div class="qcard">
              <div class="qchip">${svgIcon(icon, 16)}</div>
              <div class="qtitle">${title}</div>
              <div class="qsub">${sub}</div>
            </div>`,
          )
          .join('')}
      </div>
      <div class="recents-head"><b>Recents</b><span class="vchip">${svgIcon('rotate-cw', 12)}All files</span></div>
      ${
        layout === 'list'
          ? `<div class="lpanel">
        <div class="lhead"><span class="lname">NAME</span><span class="lteam">TEAM</span>` +
            `<span class="ledited on">EDITED${svgIcon('chevron-down', 12)}</span></div>` +
            files
              .map(
                ([c, name, meta]) =>
                  `<div class="lrow"><span class="ldot" style="background:${c}"></span>` +
                  `<span class="lname">${name}</span>` +
                  `<span class="lteam">${meta.split(' · ')[0]}</span>` +
                  `<span class="ledited">${meta.split(' · ')[1]}</span></div>`,
              )
              .join('') +
            `</div>`
          : `<div class="grid3">
        ${files
          .map(
            ([c, name, meta]) => `<div class="gcard">
              <div class="thumb" style="background:${c}22;color:${c}">X</div>
              <div class="gbody"><div class="gname">${name}</div><div class="gmeta">${meta}</div></div>
            </div>`,
          )
          .join('')}
      </div>`
      }
      <div class="section-h">Open in this session</div>
      <div class="dpanel">
        ${drafts
          .slice(0, rows)
          .map(
            ([icon, name, edited]) =>
              `<div class="drow">${svgIcon(icon, 16)}<span class="dname">${name}</span><span class="dedit">${edited}</span></div>`,
          )
          .join('')}
      </div>
    </div>
  </div>`;
}

function fit(stageEl, wrapEl, width, height, opts) {
  stageEl.innerHTML = dashboardMock(width, opts);
  // A zero-width wrapper (hidden section, print, first paint before layout)
  // used to scale the frame to nothing and set a 0px height — a mock that
  // silently disappears. Fall back to 1:1; `overflow: hidden` keeps it tidy.
  const measured = wrapEl.clientWidth;
  const k = measured > 0 ? measured / width : 1;
  stageEl.style.transform = `scale(${k})`;
  wrapEl.style.height = `${Math.round(height * k)}px`;
  return k;
}

// ------------------------------------------------------- chrome colour names
// `C_MUTED` is what the paint code writes; `text_dim` is what the palette
// audits. This is the join, sorted by the only question worth asking of a
// chrome colour: does it follow the theme, or is it pinned?
function alphaOf(name) {
  if (name == null) return null;
  if (/^A_[A-Z]+$/.test(name)) return T.scales.alpha[name.slice(2)] ?? null;
  const n = /^0x/i.test(name) ? parseInt(name, 16) : parseInt(name, 10);
  return Number.isFinite(n) ? n : null;
}
function renderColorAliases() {
  const A = T.colorAliases || {};
  const p = palette();
  const rows = Object.entries(A).map(([alias, a]) => {
    let cur = alias;
    const chain = [];
    const seen = new Set();
    while (A[cur] && A[cur].kind === 'alias' && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = A[cur].of;
    }
    const end = A[cur] || {};
    const role = end.kind === 'role' ? end.role : end.resolvedRole;
    // role and literal both carry `alpha`; an alias carries it resolved
    const alpha = end.alpha ?? end.resolvedAlpha;
    const n = alphaOf(alpha);
    const base = role ? p[role] : end.hex || null;
    // A wash is its alpha: `C_BLACK_10` drawn opaque would be a black tile, not
    // the 10% scrim it is.
    const rgb = base && base.startsWith('#') ? hex(base).join(',') : null;
    const swatch = !base
      ? 'transparent'
      : n != null && rgb && (role || end.kind === 'literal')
        ? `rgba(${rgb},${(n / 255).toFixed(3)})`
        : base;
    return {
      alias,
      swatch,
      role,
      alpha: alpha ? alpha.replace(/^A_/, '').toLowerCase() : null,
      hex: base,
      pixels: role ? p[role] : end.kind === 'literal' ? end.hex : null,
      follows: Boolean(role),
      chain: chain.length ? chain.join(' → ') : '',
      unparsed: end.kind === 'other' ? end.rhs || 'unparsed' : '',
    };
  });
  const follows = rows.filter((r) => r.follows).sort((a, b) => a.alias.localeCompare(b.alias));
  const pinned = rows.filter((r) => !r.follows).sort((a, b) => a.alias.localeCompare(b.alias));
  const line = (r) =>
    `<tr><td class="alias">${r.alias}</td>` +
    `<td class="chain">${
      r.role ? r.role + (r.alpha ? ` · ${r.alpha}` : '') : r.unparsed ? r.unparsed : 'literal'
    }${r.chain ? ` <span class="via">via ${r.chain}</span>` : ''}</td>` +
    `<td class="px">${r.pixels || '—'}</td>` +
    `<td class="sw"><span class="swatch" style="background:${r.swatch}"></span></td></tr>`;
  document.getElementById('colornames').innerHTML =
    `<div class="card vocab-card">
      <table class="vocab">
        <thead><tr><th>alias</th><th>resolves to</th><th style="text-align:right">hex</th><th></th></tr></thead>
        <tbody>
          <tr><td colspan="4" class="vocab-family">Follows the palette — ${follows.length}</td></tr>
          ${follows.map(line).join('')}
          <tr><td colspan="4" class="vocab-family">Pinned literals — ${pinned.length}</td></tr>
          ${pinned.map(line).join('')}
        </tbody>
      </table>
    </div>`;
  const note = document.getElementById('colornames-note');
  if (note) {
    note.textContent =
      `${rows.length} chrome colour constants: ${follows.length} resolve to a palette role ` +
      `(so they repaint with the theme) and ${pinned.length} are literals that stay put — ` +
      `scrims, brand and identity colours, ruler ticks and grid dots. ` +
      `Swatches follow the theme switch.`;
  }
  document.body.dataset.pinnedColors = String(pinned.length);
}
renderColorAliases();

// ---------------------------------------------------------- chrome vocabulary
// The generator reads every named constant the chrome uses (`R_CARD`, `SP_2`,
// `A_SOFT`, `ICON_MD`, `STROKE_RING`); this renders each alias *and* what it
// resolves to, so "8px card corner" is traceable rather than folklore.
function renderVocab() {
  const V = T.appVocab || {};
  const familyOf = (name) => ({
    RadiusScale: 'radius',
    IconScale: 'icon',
    SpacingScale: 'spacing',
    AlphaScale: 'alpha',
    StrokeScale: 'stroke',
  })[name];
  const resolve = (family, name, seen = new Set()) => {
    if (seen.has(name)) return null;
    seen.add(name);
    const chain = (V[family] || []).find(([a]) => a === name);
    if (!chain) return null;
    const target = chain[1];
    if (target.includes('::')) {
      const [struct, step] = target.split('::');
      const fam = familyOf(struct);
      const v = T.scales[fam] && T.scales[fam][step];
      return v === undefined ? null : { value: v, target: [target], family: fam };
    }
    const next = resolve(family, target, seen);
    return next && { ...next, target: [target, ...next.target] };
  };
  const unit = (family, v) => (family === 'alpha' ? `${Math.round((v / 255) * 100)}%` : `${v}px`);
  const families = [
    ['radius', 'Radius — corners'],
    ['spacing', 'Spacing — gaps and insets'],
    ['icon', 'Icon — glyph boxes'],
    ['stroke', 'Stroke — line weights'],
    ['alpha', 'Alpha — washes'],
  ].filter(([f]) => (V[f] || []).length);
  let broken = 0;
  document.getElementById('vocab').innerHTML = families
    .map(([family, label]) => {
      const rows = V[family]
        .map(([alias, target]) => {
          const r = resolve(family, alias);
          if (!r) broken += 1;
          const shown = r ? r.target.join(' → ').replace(`${alias} → `, '') : '— unresolved';
          return `<tr><td class="alias">${alias}</td><td class="chain">${shown}</td>` +
            `<td class="uses-cell">${uses(alias)}</td>` +
            `<td class="px">${r ? unit(r.family, r.value) : '<b>?</b>'}</td></tr>`;
        })
        .join('');
      return `<div class="card vocab-card">
        <table class="vocab">
          <thead><tr><th>alias</th><th>resolves to</th><th>used</th><th style="text-align:right">value</th></tr></thead>
          <tbody><tr><td colspan="4" class="vocab-family">${label}</td></tr>${rows}</tbody>
        </table>
      </div>`;
    })
    .join('');
  const total = families.reduce((n, [f]) => n + V[f].length, 0);
  document.getElementById('vocab-note').textContent =
    `${total} named constants the chrome paints with, each traced to its step — ` +
    `the ladder above is what they resolve into` +
    (broken ? ` · ${broken} unresolved` : '');
  document.body.dataset.vocabBroken = String(broken);
}
renderVocab();

// ---------------------------------------------------------------------- audit
function renderAudit() {
  const a = AUDIT;
  document.getElementById('space-note').textContent =
    `${a.spacing.total} measured offsets across the paint code, ${Math.round((100 * a.spacing.onLadder) / a.spacing.total)}% on the 4/6/8/12/16/20/24/32/40/48 ladder (the rest are optical nudges like (32−14)/2, not gaps)`;
  document.getElementById('offsets').innerHTML =
    `<tr><th>offset</th><th class="num">uses</th><th>ladder</th></tr>` +
    a.spacing.top
      .map(
        (o) =>
          `<tr><td>+${o.value}</td><td class="num">${o.count}</td><td>${
            o.onLadder ? '<span class="pill ok">step</span>' : '<span class="pill no">nudge</span>'
          }</td></tr>`,
      )
      .join('');

  const r = a.ratchet;
  const rowsOf = (metric, ceilings, total) =>
    Object.keys(ceilings)
      .map((f) => {
        const used = metric[f] ?? 0;
        const over = used > ceilings[f];
        return `<tr><td><code>${f}</code></td><td class="num">${used} / ${ceilings[f]}</td><td>${
          over ? '<span class="pill no">over</span>' : '<span class="pill ok">ok</span>'
        }</td></tr>`;
      })
      .join('');
  document.getElementById('ratchet').innerHTML = `<h2>Ratchet — colour literals</h2>
    <table><tr><th>file</th><th class="num">used / ceiling</th><th></th></tr>${rowsOf(r.colourLiterals, r.ceilings.colours)}</table>
    <h2 style="margin-top:10px">Ratchet — bare ink</h2>
    <table><tr><th>file</th><th class="num">used / ceiling</th><th></th></tr>${rowsOf(r.inkLiterals, r.ceilings.ink)}</table>
    <p style="margin-top:8px">numeric icon sizes left: ${Object.values(r.icons).reduce((x, y) => x + y, 0)} ·
    numeric radii left: ${Object.values(r.radii).reduce((x, y) => x + y, 0)} (all canvas-space: ${r.canvasList.join(', ')})</p>`;

  const w = a.window;
  document.getElementById('fluid').innerHTML = `<h2>Fluid widths</h2>
    <table><tr><th>window</th><th class="num">card</th><th class="num">grid col</th><th class="num">canvas</th><th class="num">both docks maxed</th><th class="num">search slack</th></tr>
    ${a.fluid
      .map(
        (f) =>
          `<tr><td>${f.window}</td><td class="num">${f.card}</td><td class="num">${f.grid}</td><td class="num">${f.canvas}</td><td class="num">${f.canvasWorst}${f.canvasWorst === a.canvasFloor ? ' (floor)' : ''}</td><td class="num">${f.searchSlack}</td></tr>`,
      )
      .join('')}</table>
    <p style="margin-top:8px">Cards and grid columns are divided from the column, never fixed: 274→${a.fluid[0].card}px across the supported range. The search keeps ${a.fluid[0].searchSlack}px of slack at the minimum window, so it never collides with the right cluster.</p>`;
  // The "would invert" number is arithmetic on the parsed dock ranges, not a
  // figure someone typed once: 980 − 48 − 480 − 520 = −68.
  const docksWidest = {
    left: a.docks.leftRange[1],
    right: a.docks.rightRange[1],
    naive: w.min[0] - a.docks.nav - a.docks.leftRange[1] - a.docks.rightRange[1],
  };
  document.getElementById('layout').innerHTML = `<h2>Layout bounds</h2>
    <table>
      <tr><td>window</td><td class="num">${w.default[0]}×${w.default[1]} default</td></tr>
      <tr><td>minimum window</td><td class="num">${w.min[0]}×${w.min[1]}</td></tr>
      <tr><td>canvas floor</td><td class="num">${a.canvasFloor}px</td></tr>
      <tr><td>nav rail</td><td class="num">${a.docks.nav}</td></tr>
      <tr><td>left dock</td><td class="num">${a.docks.left} (${a.docks.leftRange.join('–')})</td></tr>
      <tr><td>right dock</td><td class="num">${a.docks.right} (${a.docks.rightRange.join('–')})</td></tr>
      <tr><td>title bar search</td><td class="num">${a.titleBar.searchW}×32, wordmark ${a.titleBar.wordmarkW.toFixed(1)}px</td></tr>
    </table>
    <p style="margin-top:8px">At ${w.min[0]} with both docks dragged to their widest
    (${docksWidest.left} + ${docksWidest.right}) the canvas would invert (${docksWidest.naive}px) —
    it now stops at the floor instead, and <code>docks_never_eat_the_canvas</code> pins that across 6 widths × 9 dock pairs.</p>`;
}

// ---------------------------------------------------------------------- rules
function renderRules() {
  const rules = [
    ['Container padding', 'On the ladder: 8 (SP_3) for palette rows, 12 (SP_4) for panel interiors, 16–24 for page and card padding. Where a screen is a pixel clone of the audited HTML, the measured value wins and says so in a comment.'],
    ['Optical nudges are not margins', 'Off-ladder offsets like 2, 3, 5, 7, 9 exist to centre a glyph or a 10px label inside its box — arithmetic, not spacing. The audit table above lists them as nudges on purpose.'],
    ['Fluid, not fixed', 'The card row, the 3-up grid and the draft panel divide whatever the column gives them (274 → 159px cards at the 980 minimum). Text inside them is measured and ellipsised; nothing paints over a neighbour.'],
    ['Docks yield to the canvas', 'The nav rail plus both panels may not take the canvas below 280px. The drag stops at the floor and editor_regions() re-derives it, so a window resize under a dragged layout cannot invert the regions.'],
    ['Themes are not a filter', 'Every role follows the active palette; the brand set (logo green, avatar/team hues, draft dot, canvas guides) deliberately does not, and each such literal carries the reason.'],
    ['Ink takes a role', 'Text and glyphs use C_ON_ACCENT / C_ON_DANGER / C_BLACK / C_ACCENT_INK — never white or an accent token — so no palette can make a label unreadable.'],
  ];
  document.getElementById('rules').innerHTML = rules
    .map(([t, b]) => `<div><h2>${t}</h2><p style="margin-top:2px">${b}</p></div>`)
    .join('');
}

// ------------------------------------------------------------------- switches
function setTheme(id) {
  theme = id;
  document.documentElement.dataset.theme = id;
  [...document.querySelectorAll('#themes button')].forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.theme === id)),
  );
  renderPalette();
  renderColorAliases();
  renderFrames();
}

function renderFrames() {
  fit(document.getElementById('stage'), document.getElementById('stage-wrap'), 1440, 620);
  fit(document.getElementById('narrow'), document.getElementById('narrow-wrap'), 980, 620);
  fit(document.getElementById('wide'), document.getElementById('wide-wrap'), 1920, 620, {
    layout: 'list',
  });
  // What this is, exactly: the sheet's markup, the app's numbers. Saying "the
  // paint code" would be a claim the sheet cannot keep (it is not a capture).
  document.getElementById('dash-note').textContent =
    `the sheet's own markup at the ${T.provenance.commit} numbers — sidebar 260, bar 40, ` +
    `nav rows 32 at pitch 34, sort chip + grid/list toggle 32, cards 88, list rows 48; ` +
    `the saved-chip is the audited success pair`;
}

function boot() {
  document.getElementById('provenance').textContent =
    `generated from ${T.provenance.xui.split('/').pop()} + ${T.provenance.app.split('/').pop()} @ ${T.provenance.commit}`;
  document.getElementById('themes').innerHTML = THEMES.map(
    ([id, label, title]) =>
      `<button data-theme="${id}" title="${title}" aria-pressed="${id === theme}">${label}</button>`,
  ).join('');
  document.getElementById('themes').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setTheme(b.dataset.theme);
  });
  renderScales();
  renderAudit();
  renderRules();
  setTheme(theme);
  addEventListener('resize', renderFrames);
}
addEventListener('DOMContentLoaded', boot);
