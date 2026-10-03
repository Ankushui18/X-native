// Shell for the screens gallery: theme switch, sidebar, one card per screen.
// The scaling falls back to 1:1 when the container measures zero (the same fix
// the token sheet needed) so a screen is never drawn at scale(0).
const SC = window.SCREENS || [];
const AU = window.AUDIT;
const WINW = AU.window.default[0];

const state = { theme: 'graphite', scale: null }; // scale: null = fit to the column
const el = (id) => document.getElementById(id);

function draw(winEl, wrapEl) {
  const want = state.scale || wrapEl.clientWidth / WINW;
  const k = want > 0 ? want : 1;
  winEl.style.transform = `scale(${k})`;
  winEl.style.width = `${WINW}px`;
  wrapEl.style.height = `${Math.round(900 * k)}px`;
  return k;
}

function cardFor(screen) {
  const card = document.createElement('section');
  card.className = 'card';
  card.id = screen.id;
  const isNew = /new|minimap|guide|readout/i.test(`${screen.note} ${screen.name}`);
  card.innerHTML = `
    <div class="card-h">
      <h2>${screen.name}</h2>
      <span class="mod">${screen.module}</span>
      <span class="badge">${screen.group}</span>
      ${isNew ? '<span class="badge new">latest passes</span>' : ''}
    </div>
    <p>${screen.what}</p>
    <p>${screen.note}</p>
    <div class="capture"><div class="viewport"></div></div>
    <div class="checks">${screen.checks.map((c) => `<span>${c}</span>`).join('')}</div>`;
  const viewport = card.querySelector('.viewport');
  const winEl = document.createElement('div');
  winEl.innerHTML = screen.render();
  const node = winEl.firstElementChild;
  viewport.appendChild(node);
  card.dataset.screen = screen.id;
  card._resize = () => draw(node, viewport);
  return card;
}

function boot() {
  document.getElementById('logo').innerHTML = window.ICONS.frame
    ? `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">${window.ICONS.frame
        .map((d) => `<path d="${d}"/>`)
        .join('')}</svg>`
    : '';
  el('dim').textContent = `${WINW}×${AU.window.default[1]}`;

  // theme switch — the same two palettes the app ships
  el('themes').innerHTML = [
    ['graphite', 'Graphite'],
    ['daylight', 'Daylight'],
  ]
    .map(
      ([id, label]) =>
        `<button data-theme="${id}" aria-pressed="${id === state.theme}" title="${label}">${label}</button>`,
    )
    .join('');
  el('themes').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.theme = b.dataset.theme;
    document.documentElement.dataset.theme = state.theme;
    [...el('themes').querySelectorAll('button')].forEach((x) =>
      x.setAttribute('aria-pressed', String(x.dataset.theme === state.theme)),
    );
  });

  // zoom: fit, 100%, 50%
  el('scales').innerHTML = [
    ['fit', 'Fit'],
    ['1', '100%'],
    ['0.5', '50%'],
  ]
    .map(([v, label]) => `<button data-scale="${v}" aria-pressed="${v === 'fit'}">${label}</button>`)
    .join('');
  el('scales').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.scale = b.dataset.scale === 'fit' ? null : Number(b.dataset.scale);
    [...el('scales').querySelectorAll('button')].forEach((x) =>
      x.setAttribute('aria-pressed', String(x.dataset.scale === b.dataset.scale)),
    );
    document.querySelectorAll('.card').forEach((c) => c._resize && c._resize());
  });

  el('lede').textContent =
    `${SC.length} screens and overlays, in the order you meet them: dashboard, editor, ` +
    `overlays, board, flow, loading. Each card names the module that paints it and what to check.`;

  const groups = [];
  for (const s of SC) {
    if (!groups.includes(s.group)) groups.push(s.group);
  }
  el('nav-list').innerHTML = groups
    .map(
      (g) => `<div class="nav-group">${g}</div>` + SC.filter((s) => s.group === g)
        .map((s) => `<a href="#${s.id}" data-target="${s.id}"><i></i>${s.name}</a>`)
        .join(''),
    )
    .join('');

  const stack = el('stack');
  SC.forEach((s) => stack.appendChild(cardFor(s)));

  const cards = [...document.querySelectorAll('.card')];
  cards.forEach((c) => c._resize && c._resize());

  // Active link follows the scroll. jsdom has no IntersectionObserver, so fall
  // back to a scroll listener rather than throwing and losing the whole page.
  const links = [...el('nav-list').querySelectorAll('a')];
  const mark = (id) => links.forEach((a) => a.classList.toggle('on', a.dataset.target === id));
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) mark(e.target.id);
      },
      { rootMargin: '-68px 0px -70% 0px' },
    );
    cards.forEach((c) => io.observe(c));
  } else {
    addEventListener('scroll', () => {
      let id = cards[0] && cards[0].id;
      for (const c of cards) if (c.getBoundingClientRect().top < 140) id = c.id;
      mark(id);
    });
    mark(cards[0] && cards[0].id);
  }

  addEventListener('resize', () => cards.forEach((c) => c._resize && c._resize()));
  document.body.dataset.screens = String(SC.length);
}
addEventListener('DOMContentLoaded', boot);
