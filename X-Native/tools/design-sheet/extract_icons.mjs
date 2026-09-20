// Extract the Lucide path table from the app's icons.rs into icons.js, so the
// design preview cannot drift from the shipping icon set.
import { readFileSync as readSync, writeFileSync } from 'node:fs';
import { iconAudit } from './icon_scan.mjs';
import { fileURLToPath } from 'node:url';
const OUT = (f) => fileURLToPath(new URL('./' + f, import.meta.url));
const readFileSync = (p, enc) => readSync(p instanceof URL ? fileURLToPath(p) : p, enc);
const src = readFileSync(new URL('../../apps/x-designer/src/bin/x_native_app/icons.rs', import.meta.url), 'utf8');
const start = src.indexOf('const ICONS: &[(&str, &[&str])] = &[');
const body = src.slice(start, src.indexOf('\n];', start));
const icons = {};
const re = /\(\s*"([a-z0-9-]+)",\s*&\[([\s\S]*?)\]\s*,?\s*\)/g;
let m;
while ((m = re.exec(body))) {
  const paths = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  icons[m[1]] = paths;
}
writeFileSync(OUT('icons.js'), `window.ICONS = ${JSON.stringify(icons, null, 0)};\n`);

// The set alone is not the interesting fact: does the chrome ask for names that
// are not in it? `draw_icon` no-ops on an unknown name, so this is the check
// that keeps a blank glyph from shipping.
const audit = iconAudit(new URL('../../apps/x-designer/src/bin/x_native_app/', import.meta.url), Object.keys(icons));
writeFileSync(OUT('icon-audit.js'), `window.ICON_AUDIT = ${JSON.stringify(audit, null, 0)};\n`);
console.log(
  `extracted ${Object.keys(icons).length} icons; ${audit.used} named by code in ${audit.where} ` +
    `(${audit.files} files), ${audit.missing.length} missing, ${audit.unused.length} not named anywhere`,
);
