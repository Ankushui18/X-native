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
      const note = isText ? `${worst.toFixed(2)}:1 worst surface` : 'fill / chrome';
      return `<div class="role">
        <span class="chip" style="background:${p[r]}"></span>
        <span class="meta">
          <b>${r}</b>
          <span>${p[r]} · <span class="ratio ${cls}">${note}</span></span>
        </span>
      </div>`;
    })
    .join('');
  document.getElementById('palette-note').textContent =
    `${T.roleNames.length} roles × ${THEMES.length} palettes, every pair audited by the crate's own test`;
}

// -------------------------------------------------------------------- ladders
const bar = (w, v, max, alt = '') =>
  `<span class="bar ${alt}" style="width:${Math.max(2, (w * v) / max)}px"></span><span class="nums">${v}</span>`;
const rowOf = (label, inner) => `<div class="row"><span class="label">${label}</span>${inner}</div>`;

function renderScales() {
  const s = T.scales;
  const type = Object.entries(s.type);
  document.getElementById('l-type').innerHTML =
    `<div class="nums" style="margin-bottom:2px">type — T${type.map(([, v]) => v).join(' · T')}</div>` +
    type
      .map(([k, v]) =>
        rowOf(`${k} ${v}px`, `<span class="type" style="font-size:${v}px">Ag — quick brown fox</span>`),
      )
      .join('');

  document.getElementById('l-space').innerHTML =
    `<div class="nums" style="margin-bottom:2px">spacing — SP_0 .. SP_10</div>` +
    Object.entries(s.spacing)
      .map(([k, v]) => rowOf(k.replace('SPACE_', 'SP_').toLowerCase(), bar(160, v, 48)))
      .join('');

  document.getElementById('l-radius').innerHTML =
    `<div class="nums" style="margin-bottom:2px">radius — R_NONE .. R_XL</div>` +
    Object.entries(s.radius)
      .map(([k, v]) =>
        rowOf(k.toLowerCase(), `<span style="width:64px;height:20px;background:var(--surface-hover);border:1px solid var(--border-strong);border-radius:${v}px"></span><span class="nums">${v}</span>`),
      )
      .join('');

  document.getElementById('l-icon').innerHTML =
    `<div style="width:100%" class="nums">icons — ICON_XS .. ICON_XL (Lucide, stroke ${s.icon.STROKE})</div>` +
    Object.entries(s.icon)
      .filter(([k]) => k !== 'STROKE')
      .map(([k, v]) => `<figure>${svgIcon('search', v)}<figcaption>${k} ${v}</figcaption></figure>`)
      .join('') +
    ['plus', 'sticky-note', 'layout-template', 'star']
      .map((n) => `<figure>${svgIcon(n, 18)}<figcaption>${n}</figcaption></figure>`)
      .join('');

  document.getElementById('l-alpha').innerHTML =
    `<div class="nums" style="margin-bottom:2px">alpha — A_WHISPER .. A_STRONG (0–255)</div>` +
    Object.entries(s.alpha)
      .map(([k, v]) =>
        rowOf(k.toLowerCase(), `<span class="swatch" style="width:160px;background:color-mix(in srgb, var(--accent) ${((v / 255) * 100).toFixed(0)}%, transparent)"></span><span class="nums">${v} · ${((v / 255) * 100).toFixed(0)}%</span>`),
      )
      .join('');

  document.getElementById('l-stroke').innerHTML =
    `<div class="nums" style="margin-bottom:2px">stroke</div>` +
    Object.entries(s.stroke)
      .map(([k, v]) => rowOf(k.toLowerCase(), `<span style="width:160px;border-top:${v}px solid var(--text-primary)"></span><span class="nums">${v}px</span>`))
      .join('');

  document.getElementById('l-motion').innerHTML =
    `<div class="nums" style="margin-bottom:2px">motion — honoured only when reduced-motion is off</div>` +
    Object.entries(s.motion)
      .map(([k, v]) => rowOf(k.replace('_MS', '').toLowerCase(), bar(160, v, 240, 'alt')))
      .join('');
}

// ------------------------------------------------------------ dashboard mock
// Absolute geometry: the same numbers the Rust paints, so the sheet shows the
// real density (sidebar 260, title bar 40, main padding 24, cards 88 tall,
// grid thumb 140, draft rows 48).
function dashboardMock(width, { rows = 3 } = {}) {
  const cards = [
    ['plus', 'New design file', 'Start from scratch'],
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
        ${svgIcon('search', 16)}<span>Search files, templates and commands</span><kbd>⌘K</kbd>
      </div>
      <div class="avatar" style="right:16px">A</div>
    </div>
    <div class="sidebar" style="height:${620 - 40}px">
      <div class="side-row active">${svgIcon('home', 14)}Home</div>
      <div class="side-row">${svgIcon('clock', 14)}Recents</div>
      <div class="side-row">${svgIcon('star', 14)}Starred</div>
      <div class="side-label">Teams</div>
      <div class="side-row">${svgIcon('users', 14)}Product</div>
      <div class="side-row">${svgIcon('users', 14)}Marketing</div>
      <div class="side-chip"><span class="cx">${svgIcon('check', 16)}</span>All changes saved</div>
    </div>
    <div class="main">
      <div class="h1">Your design workspace</div>
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
      <div class="section-h">Recently viewed</div>
      <div class="grid3">
        ${files
          .map(
            ([c, name, meta]) => `<div class="gcard">
              <div class="thumb" style="background:${c}22;color:${c}">X</div>
              <div class="gbody"><div class="gname">${name}</div><div class="gmeta">${meta}</div></div>
            </div>`,
          )
          .join('')}
      </div>
      <div class="section-h">Drafts</div>
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

function fit(stageEl, wrapEl, width, height) {
  stageEl.innerHTML = dashboardMock(width);
  const k = wrapEl.clientWidth / width;
  stageEl.style.transform = `scale(${k})`;
  wrapEl.style.height = `${height * k}px`;
}

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
  document.getElementById('layout').innerHTML = `<h2>Layout bounds</h2>
    <table>
      <tr><td>window</td><td class="num">${w.default[0]}×${w.default[1]} default</td></tr>
      <tr><td>minimum window</td><td class="num">${w.min[0]}×${w.min[1]}</td></tr>
      <tr><td>canvas floor</td><td class="num">${a.canvasFloor}px</td></tr>
      <tr><td>nav rail</td><td class="num">${a.docks.nav}</td></tr>
      <tr><td>left dock</td><td class="num">${a.docks.left} (${a.docks.leftRange.join('–')})</td></tr>
      <tr><td>right dock</td><td class="num">${a.docks.right} (${a.docks.rightRange.join('–')})</td></tr>
    </table>
    <p style="margin-top:8px">At ${w.min[0]} with both docks at their widest the canvas would invert (−68px) —
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
  renderFrames();
}

function renderFrames() {
  fit(document.getElementById('stage'), document.getElementById('stage-wrap'), 1440, 620);
  fit(document.getElementById('narrow'), document.getElementById('narrow-wrap'), 980, 620);
  fit(document.getElementById('wide'), document.getElementById('wide-wrap'), 1920, 620);
  document.getElementById('dash-note').textContent =
    `1440×620 of the ${T.provenance.commit} paint code — same slots, same paddings; the sidebar's saved-chip is the audited success pair`;
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
