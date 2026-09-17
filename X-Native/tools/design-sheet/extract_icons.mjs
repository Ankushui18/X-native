// Extract the Lucide path table from the app's icons.rs into icons.js, so the
// design preview cannot drift from the shipping icon set.
import { readFileSync as readSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const OUT = (f) => fileURLToPath(new URL('./' + f, import.meta.url));
const readFileSync = (p, enc) => readSync(p instanceof URL ? fileURLToPath(p) : p, enc);
const src = readFileSync(new URL('../../apps/x-designer/src/bin/x_native_app/icons.rs', import.meta.url), 'utf8');
const start = src.indexOf('const ICONS: &[(&str, &[&str])] = &[');
const body = src.slice(start, src.indexOf('\n];', start));
const icons = {};
const re = /\("([a-z0-9-]+)",\s*&\[([\s\S]*?)\]\)/g;
let m;
while ((m = re.exec(body))) {
  const paths = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  icons[m[1]] = paths;
}
writeFileSync(OUT('icons.js'), `window.ICONS = ${JSON.stringify(icons, null, 0)};\n`);
console.log(`extracted ${Object.keys(icons).length} icons`);
