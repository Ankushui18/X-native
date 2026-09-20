// Generate tokens.css + tokens.json from the shipping Rust sources, so the
// design sheet cannot drift from the code (the same reason icons.js exists).
import { readFileSync as readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const OUT = (f) => fileURLToPath(new URL('./' + f, import.meta.url));
const readFileSync = (p, enc) => readSync(p instanceof URL ? fileURLToPath(p) : p, enc);
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const XUI = new URL('../../crates/x-ui/src/design_system.rs', import.meta.url);
const APP = new URL('../../apps/x-designer/src/bin/x_native_app/theme.rs', import.meta.url);
const ds = readFileSync(XUI, 'utf8');
const app = readFileSync(APP, 'utf8');
const xuiTheme = readFileSync(new URL('../../crates/x-ui/src/theme.rs', import.meta.url), 'utf8');

const hx = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// ---- palettes -------------------------------------------------------------
const palettes = {};
// two palettes ship; a third `pub const X: Self = Self { … }` in the source
// would be read here automatically only if it were listed — `check.mjs`
// pins the count the sheet offers against `ThemeId::ALL`.
for (const [name, id] of [['GRAPHITE', 'graphite'], ['DAYLIGHT', 'daylight']]) {
  const start = ds.indexOf(`pub const ${name}: Self = Self {`);
  const body = ds.slice(start, ds.indexOf('};', start));
  const roles = {};
  for (const m of body.matchAll(/([a-z_]+):\s*\[(0x[0-9a-f]{2}),\s*(0x[0-9a-f]{2}),\s*(0x[0-9a-f]{2})\]/g)) {
    roles[m[1]] = hx(parseInt(m[2]), parseInt(m[3]), parseInt(m[4]));
  }
  palettes[id] = roles;
}
const roleNames = Object.keys(palettes.graphite);

// ---- scales ---------------------------------------------------------------
// Every step is READ FROM THE SOURCE — no key list here. A hardcoded list is
// how this sheet came to ship five of the seven type steps (it dropped
// TypographyScale::BASE and ::XXL, i.e. T12 and T20, the two sizes the
// inspector leans on most) and six of the seven radii: the sheet only drifts
// if it is told what to expect. `check.mjs` now re-counts the source too.
const scaleOf = (structName) => {
  const start = ds.indexOf(`impl ${structName} {`);
  if (start < 0) throw new Error(`design_system.rs has no impl ${structName}`);
  const body = ds.slice(start, ds.indexOf('\n}', start));
  const out = {};
  for (const m of body.matchAll(/pub const ([A-Z0-9_]+): (?:f64|u8) = ([0-9xa-fA-F.]+);/g)) {
    out[m[1]] = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseFloat(m[2]);
  }
  if (Object.keys(out).length === 0) throw new Error(`impl ${structName} declares no consts`);
  return out;
};
const scales = {
  type: scaleOf('TypographyScale'),
  icon: scaleOf('IconScale'),
  radius: scaleOf('RadiusScale'),
  spacing: scaleOf('SpacingScale'),
  alpha: scaleOf('AlphaScale'),
  stroke: scaleOf('StrokeScale'),
};

// The chrome names type by its alias (`theme::T10`), so the sheet shows the
// alias and the step together — the join that used to be missing.
const typeAliases = {};
for (const m of app.matchAll(/pub const T(\d+): f64 = TypographyScale::([A-Z]+);/g)) {
  typeAliases[m[2]] = `T${m[1]}`;
}
// A *semantic* alias over a numeric step — `T_UI = T11`, the same trick the
// radii use with `R_ROW = R_LG` — is a name the chrome really sets type with,
// so it is read from the source and counted below too. Without it the sheet
// would report the 11px step as barely used while the editor paints a couple
// of hundred call sites at it under the alias.
const typeStepAliases = {};
for (const m of app.matchAll(/pub const (T_[A-Z_]+): f64 = (T\d+);/g)) {
  typeStepAliases[m[1]] = m[2];
}
scales.motion = {};
{
  const start = ds.indexOf('impl MotionScale {');
  const body = ds.slice(start, ds.indexOf('\n}', start));
  for (const m of body.matchAll(/pub const ([A-Z_]+): u32 = (\d+);/g)) scales.motion[m[1]] = parseInt(m[2]);
}

// ---- app vocabulary (what the chrome actually names) ----------------------
const appVocab = {
  radius: [...app.matchAll(/pub const (R_[A-Z_]+): f64 = ([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  icon: [...app.matchAll(/pub const (ICON_[A-Z]+): f64 = ([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  spacing: [...app.matchAll(/pub const (SP_\d+): f64 = ([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  alpha: [...app.matchAll(/pub const (A_[A-Z]+): u8 = ([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  stroke: [...app.matchAll(/pub const (STROKE_[A-Z_]+): f64 = ([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
};

// ---- chrome colour vocabulary (C_* → role, alias or pinned literal) --------
// The palette section lists the 24 roles; the code says `C_MUTED`. Without this
// join a reader cannot tell which chrome colour follows the theme and which one
// is a literal that stays put in all three — the audit's most useful question.
// ---- who actually uses each name ------------------------------------------
// A ladder step that no call site names is a real fact about the app (the
// 16px step exists for future use; `SPACE_0` is a structural zero). Saying so
// beats letting a reader assume every rung is load-bearing. Counts come from
// the production half of each file — the `#[cfg(test)]` tail is stripped — and
// the declaration itself is subtracted, so 0 means "defined, not yet named".
const usage = {};
const names = new Set([
  ...Object.values(typeAliases),
  ...Object.keys(typeStepAliases),
  ...Object.values(appVocab).flat().map(([alias]) => alias),
]);
const appDir = new URL('../../apps/x-designer/src/bin/x_native_app/', import.meta.url);
const appFiles = readdirSync(appDir).filter((f) => f.endsWith('.rs'));
for (const n of names) usage[n] = 0;
let motionMentions = 0;
for (const f of appFiles) {
  let src = readFileSync(new URL(f, appDir), 'utf8');
  const cut = src.indexOf('#[cfg(test)]');
  if (cut >= 0) src = src.slice(0, cut);
  // MotionScale lives in the shared crate; the desktop app has not named it.
  motionMentions += (src.match(/\b(FAST_MS|BASE_MS|SLOW_MS)\b/g) || []).length;
  for (const n of names) {
    const hits = src.match(new RegExp(`\\b${n}\\b`, 'g'));
    const declares = (src.match(new RegExp(`pub const ${n}\\b`, 'g')) || []).length;
    if (hits) usage[n] += hits.length - declares;
  }
}

const colorAliases = {};
for (const m of app.matchAll(/pub const (C_[A-Z0-9_]+): Color = ([^;]+);/g)) {
  const [alias, rhs] = [m[1], m[2].trim()];
  const role = rhs.match(/^rgba?\(role!\(([a-z_]+)\)(?:,\s*([^)]+))?\)$/);
  if (role) {
    colorAliases[alias] = { kind: 'role', role: role[1], alpha: role[2] ? role[2].trim() : null };
    continue;
  }
  const lit = rhs.match(/^Color::from_rgba?8\((0x[0-9a-fA-F]{2}), (0x[0-9a-fA-F]{2}), (0x[0-9a-fA-F]{2})(?:,\s*([^)]+))?\)$/);
  if (lit) {
    colorAliases[alias] = {
      kind: 'literal',
      hex: hx(parseInt(lit[1], 16), parseInt(lit[2], 16), parseInt(lit[3], 16)),
      alpha: lit[4] ? lit[4].trim() : null,
    };
    continue;
  }
  const forward = rhs.match(/^(C_[A-Z0-9_]+)$/);
  colorAliases[alias] = forward ? { kind: 'alias', of: forward[1] } : { kind: 'other', rhs };
}
// Two different counts, both honest: what each constant *is* (a forwarding
// alias is a real thing to know about), and what it lands on after following
// the chain to the colour that actually paints.
// Two ways a chrome file can name a role: through a `C_*` constant, or by
// asking for it directly (`role!(x)`). A role neither of those reaches is not a
// bug — `accent_hover`/`accent_active` are the crate's accent fills and the
// palette is allowed to define roles before a screen paints with them — but the
// sheet should say so rather than let a full-looking palette imply otherwise.
const roleMentions = new Set();
for (const f of appFiles) {
  let src = readFileSync(new URL(f, appDir), 'utf8');
  const cut = src.indexOf('#[cfg(test)]');
  if (cut >= 0) src = src.slice(0, cut);
  for (const m of src.matchAll(/role!\(([a-z_]+)\)/g)) roleMentions.add(m[1]);
}
const namedRoles = new Set();
for (const a of Object.values(colorAliases)) {
  if (a.role) namedRoles.add(a.role);
  if (a.resolvedRole) namedRoles.add(a.resolvedRole);
}
for (const r of roleMentions) namedRoles.add(r);
const orphanRoles = roleNames.filter((r) => !namedRoles.has(r));

const colorKind = { role: 0, alias: 0, literal: 0, other: 0 };
const colorResolved = { role: 0, literal: 0, other: 0 };
const resolveKind = (alias, seen = new Set()) => {
  if (seen.has(alias)) return 'other';
  seen.add(alias);
  const a = colorAliases[alias];
  if (!a) return 'other';
  if (a.kind === 'alias') return resolveKind(a.of, seen);
  return a.kind;
};
for (const alias of Object.keys(colorAliases)) {
  colorKind[colorAliases[alias].kind] += 1;
  colorResolved[resolveKind(alias)] += 1;
}
for (const a of Object.values(colorAliases)) {
  if (a.kind === 'alias') {
    const kind = resolveKind(a.of);
    if (kind === 'role') {
      const seen = new Set();
      let cur = a.of;
      while (colorAliases[cur] && colorAliases[cur].kind === 'alias' && !seen.has(cur)) {
        seen.add(cur);
        cur = colorAliases[cur].of;
      }
      const end = colorAliases[cur];
      a.resolvedRole = end && end.role;
      a.resolvedAlpha = end && end.alpha;
    } else {
      a.resolved = kind;
    }
  }
}

const provenance = {
  // `SHEET_COMMIT` lets the gate regenerate with the *committed* stamp: on a
  // merge run `git rev-parse HEAD` is the merge commit, which would look like a
  // change on every pull request and make the drift check useless.
  commit:
    process.env.SHEET_COMMIT ||
    execSync('git rev-parse --short HEAD', { cwd: new URL('../..', import.meta.url) })
      .toString()
      .trim(),
  xui: 'crates/x-ui/src/design_system.rs',
  app: 'apps/x-designer/src/bin/x_native_app/theme.rs',
};
// the roles the contrast audit checks as *text* (everything else is a fill)
const textBlock = xuiTheme.slice(
  xuiTheme.indexOf('const TEXT_ROLES'),
  xuiTheme.indexOf('];', xuiTheme.indexOf('const TEXT_ROLES')),
);
const textRoles = [...textBlock.matchAll(/\("([a-z_]+)"/g)].map((m) => m[1]);
const payload = { palettes, roleNames, textRoles, scales, typeAliases, typeStepAliases, appVocab, usage, motionMentions, orphanRoles, colorAliases, colorKind, colorResolved, provenance };
writeFileSync(OUT('tokens.json'), JSON.stringify(payload, null, 2));
writeFileSync(OUT('tokens.js'), `window.TOKENS = ${JSON.stringify(payload)};\n`);
// The sheet's two pages both link this file, so the app's typeface is declared
// here: `index.html` used to carry its own copy and `screens.html` had none,
// which silently drew the whole gallery in the machine's fallback sans.
const css = [
  '/* The app typeface, so any page linking this file renders in Inter. */',
  ...[400, 500, 600, 700].map(
    (w) =>
      `@font-face { font-family: Inter; font-weight: ${w}; font-display: swap; ` +
      `src: url(fonts/inter-latin-${w}-normal.woff2) format('woff2'); }`,
  ),
  '',
];
for (const [id, roles] of Object.entries(palettes)) {
  css.push(`[data-theme="${id}"] {`);
  for (const [k, v] of Object.entries(roles)) css.push(`  --${k.replace(/_/g, '-')}: ${v};`);
  css.push('}');
}
writeFileSync(OUT('tokens.css'), css.join('\n') + '\n');
const stepCount = Object.fromEntries(
  Object.entries(scales).map(([k, v]) => [
    k,
    k === 'icon' ? Object.keys(v).length - 1 : Object.keys(v).length,
  ]),
);
console.log(
  `palettes: ${Object.keys(palettes).length} × ${roleNames.length} roles; scale steps: ` +
    Object.entries(stepCount)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ') +
    `; type aliases ${Object.values(typeAliases).join('/')}; ` +
    `app vocab entries: ${Object.values(appVocab).reduce((a, b) => a + b.length, 0)}; ` +
    `roles no chrome constant names: ${orphanRoles.join(' ') || 'none'}; ` +
    `names unused by the chrome: ${Object.entries(usage).filter(([, n]) => n === 0).map(([k]) => k).join(' ') || 'none'}; ` +
    `chrome colours: ${Object.keys(colorAliases).length} ` +
    `(${colorKind.role} role constants, ${colorKind.alias} forwarding, ` +
    `${colorKind.literal} literals${colorKind.other ? `, ${colorKind.other} unparsed` : ''}; ` +
    `resolving to ${colorResolved.role} palette-backed and ${colorResolved.literal} pinned)`,
);
