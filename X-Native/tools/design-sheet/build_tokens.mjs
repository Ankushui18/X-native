// Generate tokens.css + tokens.json from the shipping Rust sources, so the
// design sheet cannot drift from the code (the same reason icons.js exists).
import { readFileSync as readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const OUT = (f) => fileURLToPath(new URL('./' + f, import.meta.url));
const readFileSync = (p, enc) => readSync(p instanceof URL ? fileURLToPath(p) : p, enc);
import { execSync } from 'node:child_process';
const XUI = new URL('../../crates/x-ui/src/design_system.rs', import.meta.url);
const APP = new URL('../../apps/x-designer/src/bin/x_native_app/theme.rs', import.meta.url);
const ds = readFileSync(XUI, 'utf8');
const app = readFileSync(APP, 'utf8');

const hx = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// ---- palettes -------------------------------------------------------------
const palettes = {};
for (const [name, id] of [['GRAPHITE', 'graphite'], ['DAYLIGHT', 'daylight'], ['HIGH_CONTRAST', 'hc']]) {
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
const scaleOf = (structName, keys) => {
  const start = ds.indexOf(`impl ${structName} {`);
  const body = ds.slice(start, ds.indexOf('\n}', start));
  const out = {};
  for (const k of keys) {
    const m = body.match(new RegExp(`pub const ${k}: (f64|u8) = ([0-9xa-f.]+);`));
    if (m) out[k] = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseFloat(m[2]);
  }
  return out;
};
const scales = {
  type: scaleOf('TypographyScale', ['XS', 'SM', 'MD', 'LG', 'XL']),
  icon: { ...scaleOf('IconScale', ['XS', 'SM', 'MD', 'LG', 'XL']), STROKE: 1.5 },
  radius: scaleOf('RadiusScale', ['NONE', 'XS', 'SM', 'MD', 'LG', 'XL']),
  spacing: scaleOf('SpacingScale', ['SPACE_0', 'SPACE_1', 'SPACE_2', 'SPACE_3', 'SPACE_4', 'SPACE_5', 'SPACE_6', 'SPACE_7', 'SPACE_8', 'SPACE_9', 'SPACE_10']),
  alpha: scaleOf('AlphaScale', ['WHISPER', 'FAINT', 'SOFT', 'MEDIUM', 'STRONG']),
  stroke: scaleOf('StrokeScale', ['HAIRLINE', 'RING']),
};
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

const provenance = {
  commit: execSync('git rev-parse --short HEAD', { cwd: new URL('../..', import.meta.url) }).toString().trim(),
  xui: 'crates/x-ui/src/design_system.rs',
  app: 'apps/x-designer/src/bin/x_native_app/theme.rs',
};
const payload = { palettes, roleNames, scales, appVocab, provenance };
writeFileSync(OUT('tokens.json'), JSON.stringify(payload, null, 2));
writeFileSync(OUT('tokens.js'), `window.TOKENS = ${JSON.stringify(payload)};\n`);
const css = [];
for (const [id, roles] of Object.entries(palettes)) {
  css.push(`[data-theme="${id}"] {`);
  for (const [k, v] of Object.entries(roles)) css.push(`  --${k.replace(/_/g, '-')}: ${v};`);
  css.push('}');
}
writeFileSync(OUT('tokens.css'), css.join('\n') + '\n');
console.log(
  `palettes: ${Object.keys(palettes).length} × ${roleNames.length} roles; scales: ${Object.keys(scales).join(', ')}; app vocab entries: ${Object.values(appVocab).reduce((a, b) => a + b.length, 0)}`,
);
