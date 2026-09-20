// Every screen the app ships, drawn as a design sheet.
//
// FIDELITY — what is real here and what is not:
//   real   the window and dock geometry (read from theme.rs/state.rs by
//          build_audit.mjs, never retyped), the panel and tab names, the
//          toolbar and rail contents, the menu rows, every colour (the theme
//          tokens), and the specific features each screen's `check` list
//          names, which are the ones the last passes shipped.
//   not    pixel placement inside panels, the document artwork on the canvas,
//          and anything that needs the font engine's measured text.
// A screen here is a claim about layout and wording. `check_screens.mjs`
// verifies the claims it can: that each screen renders, that its landmarks are
// present, that its module exists in the Rust source, and that no screen paints
// a colour the tokens do not define.
(function () {
'use strict';
const T = window.TOKENS;
const IC = window.ICONS;
const A = window.AUDIT;
const UI = A.ui;
const D = A.docks;
const G = A.geom;

const W = A.window.default[0]; // 1440
const H = A.window.default[1]; // 900
const RAIL = D.nav; // 48
const LEFT = D.left; // 280
const RIGHT = D.right; // 340
const TITLE = UI.titleH; // 36
const CANVAS = { x0: RAIL + LEFT, x1: W - RIGHT, y0: TITLE, y1: H };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const px = (n) => `${n}px`;

// ------------------------------------------------------------------ primitives
const icon = (name, size = 16, cls = '') => {
  const paths = IC[name];
  if (!paths) return `<span class="missing-icon" title="no such glyph: ${name}"></span>`;
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths
    .map((d) => `<path d="${d}"/>`)
    .join('')}</svg>`;
};

// `cls` becomes the class attribute; anything else extra is a style. Getting
// this wrong is silent — every panel keeps its inline geometry and loses its
// border, background and padding — so the class is a real parameter, never a key
// smuggled into the style map.
const box = (style, inner, cls = '') =>
  `<div class="${cls}" style="${Object.entries(style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${typeof v === 'number' ? px(v) : v}`)
    .join(';')}">${inner}</div>`;

const at = (x, y, w, h, inner, extra = {}) => {
  const { class: cls = '', attrs = '', ...style } = extra;
  return box({ position: 'absolute', left: x, top: y, width: w, height: h, ...style }, inner, cls).replace(
    '<div class="',
    attrs ? `<div ${attrs} class="` : '<div class="',
  );
};

const row = (label, value, cls = '') =>
  `<div class="field ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;

const section = (title, body, extra = '') =>
  `<div class="sec" ${extra}><div class="sec-t">${esc(title)}</div>${body}</div>`;

const badge = (text, kind = 'new') => `<span class="badge ${kind}">${esc(text)}</span>`;

// The window frame every screen is drawn in — real size, scaled by the shell.
const win = (inner, cls = '') =>
  `<div class="win ${cls}" style="width:${W}px;height:${H}px">${inner}</div>`;

// ------------------------------------------------------------------ dashboard
// Sidebar 260 + mx-6 (24) main column; title bar 40; rows 48; cards 88 (2-up at
// the top) and a 3-up grid − all the numbers paint_top_bar / paint_sidebar use.
const FILES = [
  ['file-text', 'Checkout flow', 'Product', '2 min ago', true],
  ['frame', 'Pricing page', 'Product', '18 min ago', false],
  ['component', 'Nav bar', 'Design System', '1 h ago', false],
  ['sticky-note', 'Retro board', 'Marketing', 'Yesterday', true],
  ['file-text', 'Settings sheet', 'Product', '2 days ago', false],
  ['image', 'Launch hero', 'Marketing', '3 days ago', false],
];

function dashSidebar(view) {
  const navs = [
    ['layout-dashboard', 'Home'],
    ['clock', 'Recents'],
    ['star', 'Starred'],
    ['trash-2', 'Trash'],
  ];
  // THE WORKFLOW section mirrors paint_workflow: the primary loop in the
  // sidebar's lower half, informational only (no hit region in the app).
  const workflow = [
    ['1', 'Compose', 'Frames, auto layout, vectors'],
    ['2', 'Flow', 'Connect screens, preview'],
    ['3', 'Ship', 'Export PNG, PDF, SVG'],
  ];
  return at(0, UI.dashTitleH, G.dashSide, H - UI.dashTitleH, `
    <div class="side-label">${icon('box', 12)}DRAFTS</div>
    <div class="side-head"><span class="sdot"></span><span>Personal</span></div>
    ${navs
      .map(
        ([ic, label]) =>
          `<div class="side-row${label === view ? ' active' : ''}">${icon(ic, 16)}<span>${label}</span></div>`,
      )
      .join('')}
    <div class="side-div"></div>
    <div class="side-label">LOCAL WORKSPACE</div>
    <div class="side-block"><b>No account required</b><span>Cloud teams are not available yet</span></div>
    <div class="side-label">THE WORKFLOW</div>
    ${workflow
      .map(
        ([n, name, sub]) =>
          `<div class="wrow"><span class="wnum">${n}</span><div class="wtxt"><b>${name}</b><span>${sub}</span></div></div>`,
      )
      .join('')}
  `, { class: 'sidebar' });
}

function dashTopBar() {
  return at(0, 0, W, UI.dashTitleH, `
    <span class="mark"><span class="logo">${icon('frame', 16)}</span><b>X-Native</b></span>
    <span class="search">${icon('search', 16)}<span class="ph">Search files, teams, or projects</span>
      <span class="kbd">\u2318K</span></span>
    <span class="tb-right"><span class="btn ghost">${icon('plus', 16)}New file</span>
      <span class="avatar">A</span></span>
  `, { class: 'topbar' });
}

// The card thumbnail is a document preview when the file is on disk and a flat
// colour block watermarked with "X" when it is not (dashboard.rs paints the
// watermark at T20 Bold in C_WHITE_10 / C_BLACK_10). The sheet cannot render a
// document, so it draws the fallback, which is what a brand-new file shows. The
// star lives in the thumbnail's top-right corner (x1 − 32 … x1 − 8), not beside
// the file name.
function fileCard([ic, name, team, when, star]) {
  return `<div class="gcard">
    <div class="thumb">
      <span class="wm">X</span>
      ${star ? `<span class="thumb-star">${icon('star', 12)}</span>` : ''}
    </div>
    <div class="gbody">
      <div class="gname">${esc(name)}</div>
      <div class="gmeta">${esc(team)} · ${esc(when)}</div>
    </div>
  </div>`;
}

function fileRow([ic, name, team, when, star], i, { selected } = {}) {
  return `<div class="lrow${selected ? ' sel' : ''}">
    <span class="licon">${icon(ic, 16)}</span>
    <span class="lname">${esc(name)}${star ? '<span class="star">★</span>' : ''}</span>
    <span class="lteam">${esc(team)}</span>
    <span class="ledited">${esc(when)}</span>
  </div>`;
}

function dashMain({ view = 'Home', layout = 'Grid', selected = [], sortOpen = false, empty = false, demo = true }) {
  const x0 = G.dashMx;
  const x1 = W - 24;
  const files = empty ? [] : FILES;
  const head = `
    <div class="head">
      <div class="h1">${view === 'Home' ? 'Your design workspace' : view}</div>
      <div class="grow"></div>
      <span class="sortchip${sortOpen ? ' open' : ''}">${icon('arrow-up-down', 16)}
        <span>Sorted by ${sortOpen ? 'Edited' : 'Edited'}</span>${icon('chevron-down', 12)}</span>
      <span class="seglay">
        <span class="lay${layout === 'Grid' ? ' on' : ''}">${icon('grid-2x2', 16)}Grid</span>
        <span class="lay${layout === 'List' ? ' on' : ''}">${icon('list', 16)}List</span>
      </span>
    </div>`;
  const cards = `
    <div class="cards">
      ${[
        ['plus', 'New design file', 'Compose, flow, ship — from one file'],
        ['import', 'Import file', 'SVG, PNG, Sketch, Figma JSON'],
        ['sticky-note', 'New board', 'Infinite canvas for brainstorming'],
        ['layout-template', 'Start from a template', 'Mobile, landing, system, board'],
      ]
        .map(
          ([ic, title, sub]) =>
            `<div class="qcard"><span class="qchip">${icon(ic, 18)}</span><b>${esc(title)}</b><span>${esc(sub)}</span></div>`,
        )
        .join('')}
    </div>`;
  let body = cards;
  if (view === 'Trash') {
    body += `<div class="empty">
      <b>Trash is empty</b>
      <span>Files you delete land here first, and nothing is removed until you empty it.</span>
      <span class="btn">${icon('home', 14)}Back to Home</span>
    </div>`;
  } else if (empty) {
    body += `<div class="empty">
      <b>No matching recent files</b>
      <span>Create a new file, or use Ctrl/Cmd+O to open an existing project.</span>
      <span class="btn primary">${icon('plus', 16)}Create new file</span>
      <span class="btn">${icon('folder-open', 16)}Open existing file</span>
    </div>`;
  } else if (layout === 'List') {
    body += `
      <div class="recents-head"><b>Recents</b><span class="vchip">${icon('rotate-cw', 12)}All files</span></div>
      <div class="lpanel">
        <div class="lhead">
          <span class="lname">NAME</span><span class="lteam">TEAM</span>
          <span class="ledited on">EDITED${icon('chevron-down', 12)}</span>
        </div>
        ${files.map((f, i) => fileRow(f, i, { selected: selected.includes(i) })).join('')}
      </div>`;
  } else {
    body += `
      <div class="recents-head"><b>Recents</b><span class="vchip">${icon('rotate-cw', 12)}All files</span></div>
      <div class="grid3">${files.map(fileCard).join('')}</div>`;
  }
  const sidebar = dashSidebar(view);
  // `menu-wrap` is what carries the surface, border and radius; without it the
  // sort menu was a bare grid floating transparently over the quick cards.
  const sortMenu = sortOpen
    ? at(G.dashMx + (x1 - x0) - 460, UI.dashTitleH + 118, 200, 108, `
        <div class="menu">
          <div class="menu-row on"><span>Edited</span>${icon('check', 14)}</div>
          <div class="menu-row"><span>Name</span></div>
          <div class="menu-row"><span>Starred first</span></div>
        </div>`, { class: 'menu-wrap' })
    : '';
  const bulk = selected.length
    ? at(G.dashMx, H - 72, x1 - x0, 48, `
        <div class="bulk">
          <b>${selected.length} selected</b>
          <span class="btn ghost">Star</span>
          <span class="btn ghost">Unstar</span>
          <span class="btn ghost">Open</span>
          <span class="btn ghost">Remove from recents</span>
          <span class="bkick">${icon('x', 14)}</span>
        </div>`)
    : '';
  // The main column starts under the title bar, not behind it: dashboard.rs
  // paints `Rect::new(DASH_SIDE_W, DASH_TITLE_H, win_w, win_h)`. Drawn from y 0
  // it sits under the top bar and swallows the screen's own heading.
  return win(
    dashTopBar() +
      sidebar +
      at(G.dashSide, UI.dashTitleH, W - G.dashSide, H - UI.dashTitleH, `${head}${body}`, {
        class: 'main',
        padding: '24px 24px 24px 0',
      }) +
      sortMenu +
      bulk,
  );
}

// --------------------------------------------------------------------- editor
const NAV_TABS = [
  ['File', 'home'],
  ['Agents', 'sparkles'],
  ['Assets', 'image'],
  ['Tools', 'sliders-horizontal'],
  ['Variables', 'code'],
];
const LEFT_TABS = [
  ['Layers', 'Layers'],
  ['Assets', 'Assets'],
  ['Tokens', 'Tokens'],
];
const RIGHT_TABS = [
  ['Design', 'Design'],
  ['Prototype', 'Prototype'],
  ['Inspect', 'Inspect'],
  ['UX', 'UX'],
];
const TOOLS = [
  ['Select', 'mouse-pointer-2', 'V'],
  ['Frame', 'frame', 'F'],
  ['Text', 'type', 'T'],
  ['Rect', 'square', 'R'],
  ['Ellipse', 'circle', 'O'],
  ['Pen', 'pen-tool', 'P'],
  ['Eraser', 'eraser', 'E'],
  ['Symmetry', 'reflect-vertical', 'Y'],
  ['Comment', 'message-circle', 'C'],
  ['Hand', 'hand', 'H'],
];
const BOARD_TOOLS = [
  ['Select', 'mouse-pointer-2', 'V'],
  ['Sticky note', 'sticky-note', 'S'],
  ['Connector', 'arrow-left-right', 'L'],
  ['Pen', 'pen-tool', 'P'],
  ['Rect', 'square', 'R'],
  ['Circle', 'circle', 'O'],
  ['Text', 'type', 'T'],
  ['Hand', 'hand', 'H'],
  ['Zoom', 'zoom-in', 'Z'],
];

function editorTitleBar({ file = 'Checkout flow', zoom = '100%', tabs = ['Checkout flow', 'Pricing page'] }) {
  const cell = UI.logoCell;
  let x = cell;
  const tabHtml = tabs
    .map((name, i) => {
      const active = i === tabs.length - 1;
      const w = 168;
      const html = at(x, 0, w, TITLE, `
        ${icon(i === 0 ? 'file-text' : 'frame', 12)}
        <span class="tname">${esc(name)}</span>
        ${icon('x', 12, 'tclose')}
      `, { class: `tab${active ? ' on' : ''}` });
      x += w;
      return html;
    })
    .join('');
  return at(0, 0, W, TITLE, `
    <span class="logo-cell">${icon('frame', 16)}</span>
    ${tabHtml}
    <span class="newtab">${icon('plus', 14)}</span>
    <span class="grow"></span>
    <span class="tb-chip">${icon('zoom-out', 14)}<b>${zoom}</b>${icon('zoom-in', 14)}</span>
    <span class="tb-chip">${icon('history', 14)}Version ${icon('chevron-down', 12)}</span>
    <span class="btn ghost">${icon('play', 14)}Present</span>
    <span class="btn primary">${icon('save', 14)}Save</span>
  `, { class: 'titlebar' });
}

function editorRail(active = 'File') {
  return at(0, TITLE, RAIL, H - TITLE, `
    <span class="rail-menu"><span class="burger"><i></i><i></i><i></i></span></span>
    ${NAV_TABS.map(
      ([name, ic]) =>
        `<span class="rail-item${name === active ? ' on' : ''}" title="${name}">${icon(ic, 20)}</span>`,
    ).join('')}
  `, { class: 'rail' });
}

function editorLeftPanel(tab = 'Layers', { pages = 3 } = {}) {
  const y0 = TITLE;
  const pill = `<div class="pillrow">${LEFT_TABS.map(
    ([key, label]) => `<span class="pill${key === tab ? ' on' : ''}">${label}</span>`,
  ).join('')}</div>`;
  let body = '';
  if (tab === 'Layers') {
    body = `
      <div class="tree">
        <div class="tree-h">PAGES</div>
        ${Array.from({ length: pages }, (_, i) => {
          const name = ['Checkout flow', 'Pricing page', 'Empty page'][i] || `Page ${i + 1}`;
          const hasContent = i < pages - (pages === 3 ? 1 : 0);
          return `<div class="page-row${i === 0 ? ' on' : ''}">
              ${hasContent ? '<span class="sketch"></span>' : icon('file', 14)}
              <span>${esc(name)}</span>
            </div>`;
        }).join('')}
        <div class="tree-h">CHECKOUT FLOW</div>
        ${[
          ['frame', 'Hero', 0],
          ['frame', 'Form', 1],
          ['group', 'Fields', 2],
          ['type', 'Email label', 3],
          ['square', 'Email input', 3],
          ['square', 'Submit', 2],
          ['component', 'Button / Primary', 1],
        ]
          .map(
            ([ic, name, depth]) =>
              `<div class="tree-row" style="padding-left:${10 + depth * 12}px">${icon(ic, 14)}<span>${esc(name)}</span></div>`,
          )
          .join('')}
      </div>`;
  } else if (tab === 'Assets') {
    // Mirrors `paint_assets`: the faces the render stack knows, the two font
    // actions, then the document's linked libraries (id + pinned version +
    // the per-library "check" pill that opens the diff review).
    body = `
      <div class="tree">
        <div class="tree-h">FONTS</div>
        ${[
          ['Inter', 4],
          ['Geist Mono', 2],
          ['Source Serif', 1],
        ]
          .map(
            ([fam, n]) =>
              `<div class="lrow-plain"><span>${esc(n > 1 ? `${fam} (${n})` : fam)}</span></div>`,
          )
          .join('')}
        <div class="lbtn">Load Font…</div>
        <div class="lbtn raised">Publish library…</div>
        <div class="lnote">TTF / OTF / TTC; text layers can then use it by name</div>
        <div class="tree-h">LIBRARIES</div>
        ${[
          ['design-system', 3],
          ['marketing-kit', 2],
        ]
          .map(
            ([id, ver]) => `<div class="librow">${icon('component', 14)}
              <span class="lname">${esc(id)}</span>
              <em class="lver">v${ver}</em><span class="check">check</span></div>`,
          )
          .join('')}
      </div>`;
  } else {
    // Mirrors `paint_tokens`: the palette/type/spacing the document already
    // paints with, the extract action, the four create-kind buttons and the
    // variable rows (name slot + value slot + delete).
    body = `
      <div class="tree">
        <div class="tree-h">X-NATIVE TOKENS</div>
        ${[
          ['text_primary', 12],
          ['background', 8],
          ['accent', 5],
        ]
          .map(
            ([role, n]) =>
              `<div class="tokrow"><span class="sw" style="background:var(--${role.replace('_', '-')})"></span><span class="tokhex">${esc(T.palettes.graphite[role])}</span><em>×${n}</em></div>`,
          )
          .join('')}
        <div class="tree-h">TYPE SCALE</div>
        <div class="lrow-plain mono">16 · 13 · 12 · 10</div>
        <div class="lrow-plain mono dim">spacing: 12 · 8 · 6</div>
        <div class="lbtn raised">Generate variables from tokens</div>
        <div class="tree-h">NEW VARIABLE</div>
        <div class="kindgrid">
          ${['Color', 'Number', 'String', 'Boolean']
            .map((k) => `<span class="lbtn">${k}</span>`)
            .join('')}
        </div>
        <div class="tree-h">VARIABLES</div>
        ${[
          ['color/accent', T.palettes.graphite.accent, 'color'],
          ['space/4', null, 'number'],
          ['font/size/md', null, 'string'],
        ]
          .map(
            ([name, sw, kind]) => `<div class="varrow">
              ${
                sw
                  ? `<span class="sw" style="background:${sw}"></span>`
                  : `<span class="sw letter">${{ number: 'N', string: 'S', color: 'C' }[kind]}</span>`
              }
              <span class="tokhex">${esc(name)}</span>${icon('x', 12)}</div>`,
          )
          .join('')}
        <div class="lbtn raised">Undo variable edit (2)</div>
        <div class="lbtn raised">Theme: Graphite (dark)</div>
      </div>`;
  }
  return at(RAIL, y0, LEFT, H - y0, pill + body, { class: 'panel left-panel' });
}

// ------------------------------------------------------------------ inspector
// The COMPOSE tab is drawn from `paint_design` in editor_ui.rs: the same
// geometry at 1440 (x0 = 1113, xr = 1428, scroll region from y 125, panel top
// 36), the same section labels and the same rows. Coordinates here are
// panel-local — subtract (1100, 36) from the absolute numbers in the source.
//
// This replaced a set of invented sections ("POSITION / LAYOUT / FILL / STROKE /
// CORNER RADIUS") that the app never painted: the real panel has no fill or
// corner-radius section at all (fills live in the paint-library popover) and its
// group labels are sentence case — "Auto layout", "Flow", "Resizing",
// "Alignment", "Padding" — with `caps_label` only on "Appearance",
// "Typography" and friends.
const insField = (x, y, w, h, o = {}) => {
  const { label = '', value = '', end = false, left = '', right = '', focus = false } = o;
  const inner =
    (left ? icon(left, 12) : '') +
    (label ? `<span class="lab">${esc(label)}</span>` : '') +
    (value !== '' ? `<span class="val${end ? ' end' : ''}">${esc(value)}</span>` : '') +
    (right ? icon(right, 12) : '');
  return at(x, y, w, h, inner, { class: `field${focus ? ' on' : ''}` });
};

const hr = (y, x = 0, w = RIGHT) => at(x, y, w, 1, '', { class: 'hr' });

// `draw_flow_glyph` draws four layout diagrams at 18×14 / 14×18 / 18×14 / 16×16.
const flowGlyph = (i) => {
  const b = (x, y, w, h) => `<span class="glyph" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></span>`;
  if (i === 0) return b(0, 4, 5, 6) + b(6.5, 4, 5, 6) + b(13, 4, 5, 6);
  if (i === 1) return b(6, 0, 6, 4) + b(6, 5, 6, 4) + b(6, 10, 6, 4);
  if (i === 2) return b(0, 2, 5, 5) + b(11, 2, 5, 5) + b(0, 9, 16, 4);
  return b(0, 0, 7, 6) + b(9, 0, 7, 6) + b(0, 8, 7, 6) + b(9, 8, 7, 6);
};

function composePanel() {
  const x0 = 13; // rx + 12 padding + 1 border
  const xr = 328; // rx + rw − 12
  const y0 = 89; // scroll region (abs 125) − panel top (36)
  const half = 135.5;
  const hit = '196';
  // header row: avatar 24 at (25, 24) centre, zoom at +45, icons at the right
  const header =
    at(13, 12, 24, 24, 'A', { class: 'avatar sm' }) +
    at(45, 13, 44, 18, '100%', { class: 'zoom' }) +
    at(284, 16, 16, 16, icon('message-circle', 16)) +
    at(312, 16, 16, 16, icon('play', 16));
  const pills = at(
    9,
    50,
    323,
    30,
    ['Design', 'Prototype', 'Inspect', 'UX']
      .map((l, i) => `<span class="pill${i === 0 ? ' on' : ''}">${l}</span>`)
      .join(''),
    { class: 'pillrow' },
  );

  // rows 1–4: name + %, W/H, X/Y, rotation (audit pitch 36 from +12)
  const r1 = y0 + 12;
  const row1 =
    insField(x0, r1, 145, 28, { value: 'Checkout', right: 'chevron-down' }) +
    insField(x0 + 153, r1, 90, 28, { label: '%', value: '100', end: true }) +
    at(x0 + 251, r1, 28, 28, icon('eye', 12), { class: 'sq-btn' }) +
    at(x0 + 287, r1, 28, 28, icon('lock', 12), { class: 'sq-btn' });
  const row2 =
    insField(x0, r1 + 36, half, 28, { label: 'W', value: '320', end: true }) +
    insField(x0 + 143.5, r1 + 36, half, 28, { label: 'H', value: '48', end: true }) +
    at(x0 + 287, r1 + 36, 28, 28, icon('lock', 12), { class: 'sq-btn' });
  const row3 =
    insField(x0, r1 + 72, half, 28, { label: 'X', value: hit, end: true }) +
    insField(x0 + 143.5, r1 + 72, half, 28, { label: 'Y', value: '128', end: true }) +
    insField(x0, r1 + 108, 140, 28, { left: 'rotate-cw', value: '0', end: true });

  // auto layout: label + plus, the four flow diagrams, then the sizing row
  const auto =
    at(x0, y0 + 179.5, 120, 18, 'Auto layout', { class: 'lead' }) +
    at(x0 + 291, y0 + 172, 24, 28, icon('plus', 14), { class: 'sq-btn' }) +
    at(x0, y0 + 208 - 5, 60, 14, 'Flow', { class: 'grp-t' }) +
    [0, 1, 2, 3]
      .map((i) => {
        const fx = x0 + [0, 80.3, 160.5, 240.8][i];
        const gw = i === 1 ? 14 : i === 3 ? 16 : 18;
        return at(
          fx,
          y0 + 226,
          74.3,
          28,
          `<span class="gl" style="left:${(74.3 - gw) / 2}px;top:${(28 - (i === 1 ? 18 : 14)) / 2}px;width:${gw}px;height:${i === 1 ? 18 : 14}px">${flowGlyph(i)}</span>`,
          { class: `diag-chip${i === 0 ? ' on' : ''}` },
        );
      })
      .join('');
  const resizing =
    at(x0, y0 + 262 - 5, 80, 14, 'Resizing', { class: 'grp-t' }) +
    [['W', '320'], ['H', '48']]
      .map(([lab, val], i) => {
        const fx = x0 + 141.5 * i;
        return (
          insField(fx, y0 + 280, 133.5, 28, { label: lab }) +
          at(fx + 26, y0 + 287.8, 61.5, 18, val, { class: 'fv right' }) +
          at(fx + 93.5, y0 + 286, 31, 16, i === 0 ? 'Fixed' : 'Hug', { class: 'chip' })
        );
      })
      .join('');

  // alignment card + the two gap fields
  const dot = (r, c) => {
    const active = r === 0 && (c === 0 || c === 2);
    const dx = 13.5 + c * 28 - 9;
    const dy = 13.5 + r * 28 - 9;
    return (
      (active ? at(dx, dy, 18, 18, '', { class: 'align-halo' }) : '') +
      at(dx + 5, dy + 5, 8, 8, '', { class: `align-dot${active ? ' on' : ''}` })
    );
  };
  const card = at(
    x0,
    y0 + 334,
    84,
    84,
    at(12, 42, 60, 1, '', { class: 'hr2' }) +
      at(42, 12, 1, 60, '', { class: 'hr2' }) +
      [0, 1, 2].map((r) => [0, 1, 2].map((c) => dot(r, c)).join('')).join(''),
    { class: 'align-card' },
  );
  const gapRow = (y, ic, val) =>
    insField(x0 + 96, y, 219, 28, { left: ic, value: val, end: true });
  const align =
    at(x0, y0 + 316 - 5, 80, 14, 'Alignment', { class: 'grp-t' }) +
    at(xr - 60, y0 + 311, 60, 14, 'Gap', { class: 'grp-t right' }) +
    card +
    gapRow(y0 + 334, 'arrow-left-right', '12') +
    gapRow(y0 + 370, 'arrow-up-down', '12');

  // padding, clip content, appearance (opacity + radius)
  const padding =
    at(x0, y0 + 458 - 5, 80, 14, 'Padding', { class: 'grp-t' }) +
    [0, 1]
      .map((i) => {
        const fx = x0 + 141.5 * i;
        const glyph =
          i === 0
            ? at(fx + 9, y0 + 482, 16, 16, '', { class: 'pad-glyph' }) +
              at(fx + 14, y0 + 485, 1, 10, '', { class: 'ink' }) +
              at(fx + 19, y0 + 485, 1, 10, '', { class: 'ink' })
            : at(fx + 9, y0 + 482, 16, 16, '', { class: 'pad-glyph' }) +
              at(fx + 12, y0 + 487, 10, 1, '', { class: 'ink' }) +
              at(fx + 12, y0 + 492, 10, 1, '', { class: 'ink' });
        return (
          insField(fx, y0 + 476, 133.5, 28, {}) + glyph +
          at(fx + 60, y0 + 482, 65.5, 18, '16', { class: 'fv right' })
        );
      })
      .join('');
  const clip =
    at(x0, y0 + 516, 16, 16, at(3, 3, 10, 10, '', { class: 'ink-fill' }), { class: 'checkbox' }) +
    at(x0 + 24, y0 + 515.7, 120, 18, 'Clip content', { class: 'muted11' });
  const appearance =
    at(x0, y0 + 569 - 5, 120, 16, 'Appearance', { class: 'sec-t' }) +
    at(x0 + 293, y0 + 560, 28, 28, icon('eye', 14), { class: 'sq-btn' }) +
    insField(x0, y0 + 596, 153.5, 28, { label: 'Opacity', value: '100%', end: true }) +
    insField(x0 + 161.5, y0 + 596, 153.5, 28, { label: 'Radius', value: '8', end: true });

  // typography: family, weight/size end at the fold (abs 881). The line
  // height row (grid 756/774–802) and the rest of the typography tail are
  // scroll content in the app (fold = content N ≤ 775), so the scroll-0
  // mock stops here — painting the line-height field pushed 27px past the
  // window bottom.
  const typography =
    at(x0, y0 + 657 - 5, 120, 16, 'Typography', { class: 'sec-t' }) +
    at(x0 + 281, y0 + 652, 16, 16, icon('grid-2x2', 12)) +
    at(x0 + 303, y0 + 654, 16, 16, icon('plus', 14)) +
    insField(x0, y0 + 684, 315, 28, { value: 'Inter', right: 'chevron-down' }) +
    insField(x0, y0 + 720, 227, 28, { value: 'Medium', right: 'chevron-down' }) +
    insField(x0 + 235, y0 + 720, 80, 28, { value: '13', end: true });

  return at(W - RIGHT, TITLE, RIGHT, H - TITLE, `
    ${at(0, 0, 1, H - TITLE, '', { class: 'hr' })}${header}${pills}${hr(88)}
    ${row1}${row2}${row3}${hr(y0 + 160)}
    ${auto}${resizing}
    ${align}${padding}${clip}${hr(y0 + 548)}
    ${appearance}${hr(y0 + 636)}${typography}
  `, { class: 'panel right-panel' });
}

function editorRightPanel(tab = 'Design') {
  if (tab === 'Design') return composePanel();
  let body = '';
  if (tab === 'Prototype') {
    body =
      section(
        'Flow starting point',
        `<div class="checkrow">${icon('check', 14)}<span>Start flow here</span></div>
         <div class="btn wide">▶ Preview flow start</div>
         <div class="hint">Preview plays on the live canvas: click hit targets to follow the flow.</div>`,
      ) +
      section(
        'Interactions',
        `<div class="proto-row"><b>On click</b><span>Navigate to →</span><em>Pricing page</em></div>
         <div class="proto-row"><b>On drag</b><span>Back</span><em>—</em></div>`,
      ) +
      section('Animation', `<div class="grid2">${row('Type', 'Smart animate')}${row('Easing', 'Ease out')}</div>`);
  } else if (tab === 'Inspect') {
    body =
      section(
        'Selection',
        `<div class="insp-name">Button / Primary</div>
         <div class="grid2">${row('Size', '320 × 48')}${row('Radius', '8')}</div>`,
      ) +
      section(
        'Fill',
        `<div class="paint-row"><span class="sw" style="background:var(--accent)"></span><span class="pl">Accent</span>
          <span class="link">accent</span></div>
         <div class="cap">color/surface · ${T.palettes.graphite.surface.toUpperCase()}${badge('variable', 'ok')}</div>`,
      ) +
      section(
        'Text style',
        `<div class="grid2">${row('Family', 'Inter')}${row('Weight', 'Medium')}</div>
         <div class="grid2">${row('Size', '13')}${row('Line', '18')}</div>`,
      ) +
      section('Code', `<div class="cap mono">background: var(--accent); border-radius: 8px;</div>`);
  } else {
    body =
      section(
        'Contrast',
        `<div class="ux-row ok">${icon('check', 14)}<span>13 of 13 text pairs pass AA</span></div>
         <div class="ux-row ok">${icon('check', 14)}<span>Placeholder 4.59:1 on surface</span></div>`,
      ) +
      section(
        'Flow',
        `<div class="ux-row warn">${icon('message-circle', 14)}<span>2 frames have no outgoing interaction</span></div>
         <div class="ux-row">${icon('frame', 14)}<span>3 frames, 11 layers, 4 components</span></div>`,
      ) +
      section('Quality', `<div class="ux-row">${icon('sliders-horizontal', 14)}<span>4 hard-coded radii off the scale</span></div>`);
  }
  return at(W - RIGHT, TITLE, RIGHT, H - TITLE, `
    ${at(0, 0, 1, H - TITLE, '', { class: 'hr' })}
    ${at(10, 10, RIGHT - 20, H - TITLE - 20, `
      <div class="pillrow">${RIGHT_TABS.map(
        ([key, label]) => `<span class="pill${key === tab ? ' on' : ''}">${label}</span>`,
      ).join('')}</div>${body}
    `, { class: 'tab-body' })}
  `, { class: 'panel right-panel' });
}

function canvas({ page = 'Checkout flow', minimap = true, guides = false, connections = false, empty = false } = {}) {
  const cw = CANVAS.x1 - CANVAS.x0;
  const ch = CANVAS.y1 - CANVAS.y0;
  const frame = empty
    ? `<div class="canvas-hint">${icon('mouse-pointer-2', 20)}<b>Empty page</b>
        <span>Press ⇧1 to fit the page, or drag a tool from the dock.</span></div>`
    : `<div class="artboard">
        <div class="ab-name">${esc(page)}</div>
        <div class="ab-body">
          <div class="ab-nav"><span class="dot"></span><span class="bar"></span><span class="bar short"></span></div>
          <div class="ab-hero"><b>Checkout</b><span>Two steps, one screen.</span></div>
          <div class="ab-row"><span class="ab-input"></span><span class="ab-input"></span></div>
          <div class="ab-btn">Pay</div>
          ${connections ? '<span class="proto-link"></span>' : ''}
        </div>
      </div>`;
  // These two sit inside `.canvas`, which is itself positioned, so their
  // coordinates must be relative to the canvas — `CANVAS.x1` is a window
  // coordinate and using it here added the canvas origin a second time, sliding
  // the minimap under the right dock and off the bottom of the window.
  const miniX = CANVAS.x1 - CANVAS.x0 - 12 - 176;
  const miniY = CANVAS.y1 - CANVAS.y0 - 12 - 116;
  const minimapHtml = minimap
    ? at(miniX, miniY, 176, 116, `
        <span class="mm-close">${icon('x', 12)}</span>
        <span class="mm-node n1"></span><span class="mm-node n2"></span><span class="mm-node n3"></span>
        <span class="mm-view"></span>
        <span class="mm-cap">click or drag to navigate</span>
      `, { class: 'minimap' })
    : '';
  // Sits just below-right of where the two guides cross (canvas-relative), the
  // way the app's clamped readout hugs the measurement it describes.
  const readout = guides
    ? at(324, 272, 168, 24, `<span class="ro">X 256 · gap 16 · Y 128</span>`, { class: 'readout' })
    : '';
  return at(CANVAS.x0, CANVAS.y0, cw, ch, `
    ${frame}
    <span class="ruler top">${Array.from({ length: 12 }, (_, i) => `<b>${i * 100}</b>`).join('')}</span>
    <span class="ruler side">${Array.from({ length: 8 }, (_, i) => `<b>${i * 100}</b>`).join('')}</span>
    ${guides ? '<span class="sguide v"></span><span class="sguide h"></span>' : ''}
    ${minimapHtml}
    ${readout}
    <span class="status">${empty ? 'Empty page' : 'Page 1 / 3'} · 100% · ${D.titleH}px top bar</span>
  `, { class: 'canvas' });
}

function toolDock({ board = false, active = 'Select' } = {}) {
  const tools = board ? BOARD_TOOLS : TOOLS;
  const w = board ? tools.length * 36 + 14 : 415;
  const source = board ? 'board_ui.rs' : 'editor_ui.rs';
  return at(CANVAS.x0 + (CANVAS.x1 - CANVAS.x0 - w) / 2, H - UI.toolbarBottom - UI.toolbarH, w, UI.toolbarH, `
    ${tools
      .map(
        ([name, ic, key]) =>
          `<span class="tool${name === active ? ' on' : ''}" title="${name} (${key})">${icon(ic, 18)}</span>`,
      )
      .join('')}
    ${board ? '' : `<span class="toolsplit"></span><span class="tool" title="Palette">${icon('pipette', 18)}</span>`}
  `, { class: 'dock', attrs: `data-source="${source}"` });
}

function editorScreen(opts = {}) {
  const { leftTab = 'Layers', rightTab = 'Design', overlay = null, ...canvasOpts } = opts;
  return win(
    editorTitleBar(opts) +
      editorRail(opts.navTab || 'File') +
      editorLeftPanel(leftTab, opts) +
      canvas(canvasOpts) +
      editorRightPanel(rightTab) +
      toolDock({ board: false, active: opts.tool || 'Select' }) +
      (overlay || ''),
  );
}

// -------------------------------------------------------------------- overlay
const overlayScrim = (inner) => `<span class="scrim">${inner}</span>`;

function ovPaintLibrary() {
  const libW = 300;
  return at(RAIL + LEFT + 12, TITLE + 220, libW, 300, `
    <div class="pop-h">Fill ${icon('x', 12)}</div>
    <div class="pop-t">VARIABLES ${icon('chevron-down', 12)}</div>
    ${[
      ['accent', 'Accent', true],
      ['color/surface', 'Surface', false],
      ['color/danger', 'Danger', false],
    ]
      .map(
        ([name, label, on]) =>
          `<div class="pop-row${on ? ' on' : ''}">${on ? icon('check', 14) : '<span class="gap"></span>'}
            <span class="sw" style="background:var(--accent)"></span><span>${esc(label)}</span>
            <em>${esc(name)}</em></div>`,
      )
      .join('')}
    <div class="pop-more">+N more in Variables (⌥5)</div>
    <div class="pop-t">PAINT STYLES</div>
    ${[
      ['Brand / Primary', 'Fills only'],
      ['Brand / Subtle', 'Fills only'],
    ]
      .map(
        ([name, sub]) =>
          `<div class="pop-row"><span class="gap"></span><span class="sw" style="background:var(--accent)"></span>
            <span>${esc(name)}</span><em>${esc(sub)}</em></div>`,
      )
      .join('')}
    <div class="pop-foot">${icon('scissors', 14)}<span>Detach — keep this colour</span></div>
  `, { class: 'popover' });
}

function ovCommandPalette() {
  const cats = ['File', 'Edit', 'View', 'Tools', 'Object', 'Layout', 'Prototype', 'Text', 'Help'];
  const cmds = [
    ['New file', '⌘N', 'File'],
    ['Export as…', '⇧⌘E', 'File'],
    ['Toggle minimap', '⇧M', 'View'],
    ['Zoom to fit', '⇧1', 'View'],
    ['Toggle grid', "'", 'View'],
    ['Group selection', '⌘G', 'Object'],
  ];
  const pw = UI.cmdPaletteW;
  const x = (W - pw) / 2;
  return overlayScrim(
    at(x, 132, pw, UI.cmdPaletteMaxH, `
      <div class="cp-input">${icon('search', 16)}<span>Toggle</span><span class="kbd">esc</span></div>
      <div class="cp-body">
        <div class="cp-cats">${cats.map((c, i) => `<span class="${i === 2 ? 'on' : ''}">${c}</span>`).join('')}</div>
        ${cmds
          .map(
            ([name, key, cat], i) =>
              `<div class="cp-row${i === 2 ? ' on' : ''}">${icon(i === 2 ? 'layout-dashboard' : 'file-text', 16)}
                <span class="cp-name">${esc(name)}</span><em>${esc(cat)}</em><span class="kbd">${esc(key)}</span></div>`,
          )
          .join('')}
      </div>
      <div class="cp-foot">↑↓ to move · ⏎ to run · esc to close</div>
    `, { class: 'cmdpalette' }),
  );
}

function ovContextMenu() {
  const rows = [
    ['Copy', '⌘C'],
    ['Paste here', '⌘V'],
    ['Duplicate', '⌘D'],
    ['—'],
    ['Bring forward', '⌘]'],
    ['Toggle minimap', '⇧M'],
    ['Toggle grid', "'"],
  ];
  return at(RAIL + LEFT + 260, 300, UI.menuW, rows.length * UI.menuRowH + 12, `
    <div class="menu">
      ${rows
        .map(([label, key]) =>
          label === '—'
            ? '<div class="menu-sep"></div>'
            : `<div class="menu-row"><span>${esc(label)}</span><em>${esc(key)}</em></div>`,
        )
        .join('')}
    </div>
  `, { class: 'menu-wrap' });
}

function ovColourPicker() {
  // Figma anatomy: a saturation/value field, a hue rail, an alpha rail, then a
  // row of eyedropper + hex field + opacity field, then the theme's own swatch
  // ramp. The ramp is the palette's roles — a picker that showed invented hexes
  // would be the one place in the app where a colour has no name.
  const p = T.palettes.graphite;
  const swatches = [p.accent, p.accent_hover, p.focus_ring, p.success, p.warning, p.danger, p.selection, p.text_dim];
  const hex = p.accent.slice(1).toUpperCase();
  return at(RAIL + LEFT + 12, TITLE + 150, 268, 332, `
    <div class="pop-h">Fill colour ${icon('x', 12)}</div>
    <div class="colr-field"><span class="colr-dot" style="left:72%;top:28%"></span></div>
    <div class="colr-hue"><span class="colr-handle" style="left:58%"></span></div>
    <div class="colr-alpha"><span class="colr-handle" style="left:100%"></span></div>
    <div class="colr-row">
      <span class="colr-pip">${icon('pipette', 14)}</span>
      <span class="colr-hex mono">${hex}</span>
      <span class="colr-op mono">100%</span>
    </div>
    <div class="colr-swatches">${swatches
      .map((c) => `<span class="colr-sw" style="background:${c}"></span>`)
      .join('')}</div>
  `, { class: 'popover' });
}

function ovAppMenu() {
  // Mirrors `paint_app_menu` in editor_ui.rs row for row: the theme rows name
  // the palettes (and tick the active one) instead of a single "Dark mode" row
  // that cycled them, and Help reopens the welcome card. Two theme rows,
  // because two palettes ship — the row index is what the app dispatches.
  const rows = [
    ['New file', '⌘N'],
    ['Open file…', '⌘O'],
    ['—'],
    ['Save', '⌘S'],
    ['Save as…', '⇧⌘S'],
    ['Open version…', ''],
    ['Duplicate file', ''],
    ['Move to drafts', ''],
    ['—'],
    ['Export as…', '⇧⌘E'],
    ['Find…', '⇧⌘F'],
    ['—'],
    ['Theme: Graphite (dark)', '✓'],
    ['Theme: Daylight (light)', ''],
    ['—'],
    ['Welcome & shortcuts', '?'],
  ];
  return at(RAIL + 4, TITLE + 44, UI.appMenuW, rows.length * UI.menuRowH + 12, `
    <div class="menu">
      ${rows
        .map(([label, key]) =>
          label === '—'
            ? '<div class="menu-sep"></div>'
            : `<div class="menu-row"><span>${esc(label)}</span><em>${esc(key)}</em></div>`,
        )
        .join('')}
    </div>
  `, { class: 'menu-wrap' });
}

function ovFind() {
  return at(CANVAS.x1 - 380, CANVAS.y0 + 12, 368, 84, `
    <div class="find-row">${icon('search', 14)}<span class="find-input">Pay</span>
      <span class="muted">1 / 4</span>${icon('chevron-up', 14)}${icon('chevron-down', 14)}${icon('x', 14)}</div>
    <div class="find-row">${icon('repeat', 14)}<span class="find-input">Payment</span>
      <span class="chk on">${icon('check', 12)}</span><span class="lbl">selection only</span></div>
  `, { class: 'findbar' });
}

function ovNotifications() {
  return `<span class="toasts">
    <span class="toast ok">${icon('check', 14)}<span><b>Checkout flow saved</b><em>3.2 MB · just now</em></span></span>
    <span class="toast">${icon('history', 14)}<span><b>Undo: moved Button / Primary</b><em>⌘Z to restore</em></span></span>
  </span>`;
}

function ovTemplates() {
  const rows = [
    ['frame', 'Checkout flow', 'A two-step payment flow with a summary panel.'],
    ['layout-dashboard', 'Dashboard shell', 'Sidebar, cards, and a sortable table.'],
    ['sticky-note', 'Retro board', 'Board with sticky notes and connectors.'],
    ['sliders-horizontal', 'Design system sheet', 'Palette, ladders and audit in one page.'],
  ];
  return overlayScrim(
    at(240, 120, W - 480, H - 240, `
      <div class="modal-h">Browse templates ${icon('x', 16)}</div>
      <div class="modal-sub">48 audited starting points, each pinned by a test</div>
      <div class="tpl-grid">
        ${rows
          .map(
            ([ic, name, sub]) =>
              `<div class="tpl"><span class="tpl-chip">${icon(ic, 20)}</span><b>${esc(name)}</b><span>${esc(sub)}</span></div>`,
          )
          .join('')}
      </div>
    `, { class: 'modal' }),
  );
}

// ---------------------------------------------------------------------- board
const BOARD_NODES = [
  { x: 120, y: 140, w: 200, h: 150, text: 'Two steps, one screen — where does the summary live?' },
  { x: 372, y: 140, w: 200, h: 150, text: 'Collapse the summary panel on the second step.' },
  { x: 120, y: 340, w: 200, h: 150, text: 'Tax rows overflow on a 375-wide phone.' },
  { x: 372, y: 340, w: 200, h: 150, text: 'A/B the collapsed form against the current one.' },
];

function boardScreen({ grid = true, links = true, tool = 'Sticky note' } = {}) {
  const nodes = BOARD_NODES.map(
    (n, i) =>
      at(n.x + RAIL, n.y + TITLE, n.w, n.h, `
        <span class="sticky-text">${esc(n.text)}</span>
        <span class="sticky-tag">${['Problem', 'Idea', 'Risk', 'Ship'][i]}</span>
      `, { class: `sticky k${i}` }),
  ).join('');
  return win(
    at(0, 0, W, TITLE, `
      <span class="back">${icon('undo', 16)}<span>Dashboard</span></span>
      <span class="board-name">Retro board <em>· Page 1 · Brainstorm</em></span>
      <span class="grow"></span>
      <span class="tb-chip${grid ? ' on' : ''}">${icon('grid-2x2', 14)}Grid</span>
      <span class="tb-chip${links ? ' on' : ''}">${icon('arrow-left-right', 14)}Links</span>
      <span class="btn ghost">${icon('play', 14)}Present</span>
    `, { class: 'titlebar board-bar' }) +
      at(RAIL, TITLE, W - RAIL, H - TITLE, `
        ${grid ? '<span class="dotgrid"></span>' : ''}
        ${nodes}
        ${
          links
            ? '<svg class="links" viewBox="0 0 700 560"><path d="M320 215 H372"/><path d="M220 290 Q260 330 220 340"/><path d="M472 290 V340"/></svg>'
            : ''
        }
        <span class="zoom-chip">${icon('minus', 12)}<b>100%</b>${icon('plus', 12)}</span>
      `, { class: 'board-canvas' }) +
      toolDock({ board: true, active: tool }) +
      at(RAIL + 16, H - 140, 240, 96, `
        <div class="mini-h">Board outline</div>
        ${BOARD_NODES.map((n) => `<span class="mini-node" style="left:${n.x / 7}px;top:${n.y / 7}px"></span>`).join('')}
      `, { class: 'mini-map' }),
  );
}

// ----------------------------------------------------------------------- flow
function flowScreen() {
  return win(
    at(0, 0, W, H, `
      <div class="flow-frame">
        <div class="ab-name">Checkout flow</div>
        <div class="ab-body">
          <div class="ab-nav"><span class="dot"></span><span class="bar"></span><span class="bar short"></span></div>
          <div class="ab-hero"><b>Checkout</b><span>Two steps, one screen.</span></div>
          <div class="ab-row"><span class="ab-input"></span><span class="ab-input"></span></div>
          <div class="ab-btn">Pay</div>
        </div>
      </div>
      <span class="flow-hit">1</span>
      <span class="flow-hit two">2</span>
      <span class="flow-chip">
        <b>▶ Preview</b><span>Checkout flow</span><em>Page 1 of 3</em>
        ${icon('chevron-right', 14)}${icon('x', 14)}
      </span>
      <span class="flow-note">Chrome-less: the prototype gets every pixel. Rulers, docks and the tool rail are hidden.</span>
    `, { class: 'flow' }),
  );
}

// -------------------------------------------------------------------- loading
function loadingScreen() {
  const phases = [
    'Waiting for the file worker',
    'Reading the file',
    'Reading the document structure',
    'Decompressing document resources',
    'Validating the document',
    'Building the document',
    'Loading images and other assets',
    'Preparing rendering and caches',
    'Opening the document in the editor',
  ];
  return win(
    at(0, 0, W, H, `
      <div class="load-head"><b>X-NATIVE</b><span>/  DOCUMENT</span></div>
      <div class="load-card">
        <span class="spinner"></span>
        <b class="load-title">Reading the document structure</b>
        <span class="load-sub">checkout-flow.x · 3.2 MB</span>
        <span class="load-bar"><i style="width:42%"></i></span>
        <span class="load-phase">${phases
          .map((p, i) => `<em class="${i < 3 ? 'done' : i === 3 ? 'now' : ''}">${esc(p)}</em>`)
          .join('')}</span>
        <span class="btn ghost">Cancel</span>
      </div>
    `, { class: 'loading' }),
  );
}

// -------------------------------------------------------------------- registry
// `module` must exist as a file in the app (checked), `checks` are the
// landmarks the screen must render (checked), and `note` says what to look at —
// including which parts arrived in the latest passes.
window.SCREENS = [
  {
    id: 'dash-home-grid',
    group: 'Dashboard',
    name: 'Home · Grid',
    module: 'dashboard.rs',
    what: 'Dashboard → Home: title bar 40, sidebar 260, sort chip + grid/list toggle, quick cards, 3-up grid.',
    note: 'The sort chip names the current order and the grid/list toggle is a real hit target; both were the messy part of this screen before the IA pass.',
    checks: ['Your design workspace', 'Sorted by Edited', 'Grid', 'List', 'Start from a template'],
    render: () => dashMain({}),
  },
  {
    id: 'dash-home-list',
    group: 'Dashboard',
    name: 'Home · List',
    module: 'dashboard.rs',
    what: 'The same files in the List layout: one panel, NAME / TEAM / EDITED header, rows 48 tall.',
    note: 'NAME and EDITED are sortable — the header chevron marks the active key; clicking a header sorts, clicking the sort chip opens the same list.',
    checks: ['NAME', 'TEAM', 'EDITED', 'Design System'],
    render: () => dashMain({ layout: 'List' }),
  },
  {
    id: 'dash-recents',
    group: 'Dashboard',
    name: 'Recents',
    module: 'dashboard.rs',
    what: 'Sidebar view: files touched recently, same grid and sort machinery.',
    note: '`visible_files()` is the one filter+sort list every view reads, so Recents cannot disagree with Home about order.',
    checks: ['Recents', 'All files'],
    render: () => dashMain({ view: 'Recents' }),
  },
  {
    id: 'dash-starred',
    group: 'Dashboard',
    name: 'Starred',
    module: 'dashboard.rs',
    what: 'Starred files only; the star sits on the card and in the row.',
    note: 'Starring is per file and shows in both layouts; the sort has a Starred-first mode that keeps recency inside each group.',
    checks: ['Starred', '★'],
    render: () => dashMain({ view: 'Starred', layout: 'List' }),
  },
  {
    id: 'dash-trash',
    group: 'Dashboard',
    name: 'Trash (empty)',
    module: 'dashboard.rs',
    what: 'Trash with nothing in it — an empty state with a way back.',
    note: 'This used to be a dead end with no content and no exit; the state now says what Trash is for.',
    checks: ['Trash is empty', 'nothing is removed'],
    render: () => dashMain({ view: 'Trash' }),
  },
  {
    id: 'dash-selection',
    group: 'Dashboard',
    name: 'Selection + sort menu',
    module: 'dashboard.rs',
    what: 'Two files selected: bulk bar at the bottom, sort menu open over the grid.',
    note: '⌘A selects everything visible, Esc unwinds menu → selection → focus ring. The bulk bar only exists while something is selected.',
    checks: ['selected', 'Unstar', 'Open', 'Starred first'],
    render: () => dashMain({ layout: 'List', selected: [0, 3], sortOpen: true }),
  },
  {
    id: 'dash-empty',
    group: 'Dashboard',
    name: 'No files yet',
    module: 'dashboard.rs',
    what: 'An empty recents list (first run, or a search that matches nothing): instructions plus the two actions that get you out.',
    note: 'The empty state offers "Open existing file"; with a file present the same slot shows the grid.',
    checks: ['No matching recent files', 'Open existing file', 'Create new file'],
    render: () => dashMain({ empty: true }),
  },
  {
    id: 'dash-templates',
    group: 'Dashboard',
    name: 'Templates',
    module: 'dashboard.rs',
    what: 'The template gallery modal: 48 audited starting points, one glyph per row.',
    note: 'Backed by OpenDoc::TEMPLATES; a test asserts every row has a distinct glyph (a column of identical chips was the bug).',
    checks: ['Start from a template', 'Checkout flow', 'Retro board'],
    render: () => win(dashMain({}) + ovTemplates()),
  },
  {
    id: 'editor-structure',
    group: 'Editor',
    name: 'Editor · Structure + canvas',
    module: 'editor_ui.rs',
    what: `Full editor chrome: title bar ${TITLE}, rail ${RAIL}, left dock ${LEFT} (Layers / Assets / Tokens), right dock ${RIGHT}, rulers, tool dock ${UI.toolbarH} tall. The Design inspector is drawn from paint_design: name + %, W/H, X/Y, rotation, Auto layout, Flow, Resizing, Alignment, Padding, Clip content, Appearance, Typography — fields are filled boxes with no outline until hover, and the value being typed into is ringed.`,
    note: 'Tabs use Figma names (Layers/Assets, Design/Prototype/Inspect) with X-Native adds (Tokens, UX). Three canvas aids ship in this frame: the minimap (bottom-right, ⇧M or its ✕), page sketches in every PAGES row that has content, and ⇧1 fitting the frame to the page content.',
    checks: [
      'Layers',
      'Assets',
      'Tokens',
      'Design',
      'minimap',
      'PAGES',
      'sketch',
      'Auto layout',
      'Resizing',
      'Alignment',
      'Padding',
      'Appearance',
      'Typography',
    ],
    render: () => editorScreen({}),
  },
  {
    id: 'editor-library',
    group: 'Editor',
    name: 'Editor · Library',
    module: 'editor_ui.rs',
    what: 'Left dock on Assets: the faces the render stack knows (Load Font…) and the libraries this document is linked to, each with its pinned version and a check pill.',
    note: 'The left tabs are Layers / Assets / Tokens — Figma names plus X-Native\'s Tokens add.',
    checks: ['Assets', 'FONTS', 'Load Font…', 'LIBRARIES', 'check'],
    render: () => editorScreen({ leftTab: 'Assets' }),
  },
  {
    id: 'editor-tokens',
    group: 'Editor',
    name: 'Editor · Tokens',
    module: 'editor_ui.rs',
    what: 'Left dock on Tokens: what the document already paints with (colours, type scale, spacing), the extract-to-variables action, the four create-kind buttons and every variable with its delete ✕.',
    note: 'Variable edits route through the undo log; the inspector shows the variable name beside any bound fill.',
    checks: ['Tokens', 'TYPE SCALE', 'NEW VARIABLE', 'VARIABLES'],
    render: () => editorScreen({ leftTab: 'Tokens' }),
  },
  {
    id: 'editor-flow',
    group: 'Editor',
    name: 'Editor · Flow (prototype)',
    module: 'editor_ui.rs',
    what: 'Right dock on Prototype: start point, interactions, animation; connections draw on the canvas.',
    note: '“▶ Preview flow start” enters the chrome-less flow viewer (next screen).',
    checks: ['Prototype', 'Start flow here', 'Preview flow start'],
    render: () => editorScreen({ rightTab: 'Prototype', connections: true }),
  },
  {
    id: 'editor-ship',
    group: 'Editor',
    name: 'Editor · Ship (inspect)',
    module: 'editor_ui.rs',
    what: 'Right dock on Inspect: size, fill (with its variable), text style, and the CSS line.',
    note: 'The fill row names the variable it is bound to, which is the link the paint library edits.',
    checks: ['Inspect', 'Selection', 'variable'],
    render: () => editorScreen({ rightTab: 'Inspect' }),
  },
  {
    id: 'editor-ux',
    group: 'Editor',
    name: 'Editor · UX analysis',
    module: 'editor_ui.rs',
    what: 'Right dock on UX: contrast, flow gaps, quality notes.',
    note: 'The contrast rows read the same audited pairs the palette table and the CLI theme audit use.',
    checks: ['UX', 'Contrast', 'pass AA'],
    render: () => editorScreen({ rightTab: 'UX' }),
  },
  {
    id: 'editor-paint-lib',
    group: 'Editor',
    name: 'Paint library (new)',
    module: 'editor_ui.rs',
    what: 'The fill/stroke library popover: variables (active mode resolved, tick on the bound one), paint styles, and a detach row.',
    note: 'Linking is by reference, not a copy: a bound row shows the variable name, the popover is 300 wide, lists ≤8 variables then "+N more in Variables (⌥5)", and Detach keeps the resolved colour.',
    checks: ['VARIABLES', 'PAINT STYLES', 'Detach', 'more in Variables'],
    render: () => editorScreen({ overlay: ovPaintLibrary() }),
  },
  {
    id: 'editor-guides',
    group: 'Editor',
    name: 'Guides + guide readout (new)',
    module: 'editor_ui.rs',
    what: 'Dragging a node: smart guides, ruler guides, and the mono readout chip that follows the pointer.',
    note: 'The readout is clamped to the canvas and only exists inside it; the minimap and the page sketches are the other two aids from the same pass.',
    checks: ['readout', 'sguide'],
    render: () => editorScreen({ guides: true }),
  },
  {
    id: 'editor-empty-page',
    group: 'Editor',
    name: 'Empty page (⇧1)',
    module: 'editor_ui.rs',
    what: 'A page with nothing on it: the canvas says what to do, and ⇧1 frames the camera instead of fitting nothing.',
    note: 'Content-fit fits the union of visible nodes with 24 px of padding; on an empty page it falls back to framing the camera.',
    checks: ['Empty page', 'fit the page'],
    render: () => editorScreen({ empty: true, minimap: false }),
  },
  {
    id: 'editor-command',
    group: 'Overlays',
    name: 'Command palette (⌘K)',
    module: 'command.rs',
    what: `Centred ${UI.cmdPaletteW}×${UI.cmdPaletteMaxH} palette: input ${UI.cmdInputH} tall, rows ${UI.cmdRowH}, categories File→Help.`,
    note: 'Command-first discovery; fuzzy search over registered commands, ↑↓ to move, ⏎ to run.',
    checks: ['Toggle minimap', 'Zoom to fit', 'Prototype'],
    render: () => editorScreen({ overlay: ovCommandPalette() }),
  },
  {
    id: 'editor-context',
    group: 'Overlays',
    name: 'Context menu',
    module: 'context_menu.rs',
    what: `Right-click menu, ${UI.menuW} wide with ${UI.menuRowH}-tall rows, keyboard hints on the right.`,
    note: 'The canvas menu carries the view toggles the last pass added — Toggle minimap (⇧M) sits beside Toggle grid.',
    checks: ['Toggle minimap', 'Toggle grid', 'Duplicate'],
    render: () => editorScreen({ overlay: ovContextMenu() }),
  },
  {
    id: 'editor-colour',
    group: 'Overlays',
    name: 'Colour picker',
    module: 'editor_ui.rs',
    what: 'The fill colour popover, Figma anatomy: saturation/value field, hue + alpha rails, eyedropper + hex + opacity row, and the theme swatch ramp.',
    note: 'Colour popovers are modal to the inspector: clicks inside are consumed, so a pick never falls through to the canvas.',
    checks: ['Fill colour', '6B49F5', '100%'],
    render: () => editorScreen({ overlay: ovColourPicker() }),
  },
  {
    id: 'editor-app-menu',
    group: 'Overlays',
    name: 'App menu',
    module: 'editor_ui.rs',
    what: `The hamburger menu, ${UI.appMenuW} wide: file actions, export, find, the two theme rows, and the welcome card.`,
    note: 'Every row here is a real action; shortcuts are shown only where the app binds them.',
    checks: ['New file', 'Export as…', 'Theme: Graphite (dark)', 'Welcome & shortcuts'],
    render: () => editorScreen({ overlay: ovAppMenu() }),
  },
  {
    id: 'editor-find',
    group: 'Overlays',
    name: 'Find & replace',
    module: 'editor_ui.rs',
    what: 'Find bar with replace row, match counter, case and selection-only toggles.',
    note: '⇧⌘F opens it; matching is document-wide by default, or scoped to the selection.',
    checks: ['selection only', '1 / 4'],
    render: () => editorScreen({ overlay: ovFind() }),
  },
  {
    id: 'editor-notify',
    group: 'Overlays',
    name: 'Notifications',
    module: 'editor_ui.rs',
    what: 'Toasts in the corner: what happened, and the shortcut that undoes it.',
    note: 'The undo toast names the exact operation because "Undo" alone never tells you what you are undoing.',
    checks: ['Checkout flow saved', 'Undo'],
    render: () => editorScreen({ overlay: ovNotifications() }),
  },
  {
    id: 'board',
    group: 'Board',
    name: 'Board',
    module: 'board_ui.rs',
    what: `Infinite canvas: header ${TITLE} with a way back, dot grid, sticky notes, links, board tool dock (9 tools), zoom chip, outline.`,
    note: 'Boards carry their own tool set and a Grid / Links toggle; the header keeps a visible route to the dashboard.',
    checks: ['Retro board', 'Grid', 'Links', 'where does the summary live', 'Board outline'],
    render: () => boardScreen({}),
  },
  {
    id: 'flow',
    group: 'Board',
    name: 'Flow viewer (present)',
    module: 'editor_ui.rs',
    what: 'Prototype playback: no chrome at all, hit targets numbered, preview chip floating.',
    note: 'The flow viewer hides the docks, rulers and toolbar so the prototype gets every pixel; the chip is the only chrome left.',
    checks: ['Preview', 'Page 1 of 3', 'Chrome-less'],
    render: () => flowScreen(),
  },
  {
    id: 'loading',
    group: 'Board',
    name: 'Document loading',
    module: 'loading.rs',
    what: 'The loading screen: card, spinner, progress, and the nine phases named as they happen.',
    note: 'Elapsed time changes the spinner, never the phase; a failure offers Recover / Open saved file, a working phase offers Cancel.',
    checks: ['Reading the document structure', 'Cancel', 'Loading images'],
    render: () => loadingScreen(),
  },];
})();
