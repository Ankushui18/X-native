// Which icon names the app code actually asks for.
//
// `draw_icon` silently draws nothing when a name is missing from `icons.rs`
// (there is no `has_icon` lookup at runtime), so a typo in a context menu
// ships as a blank space — a real bug this repo has hit. The scan is
// deliberately narrow and says so: it reads names out of the two positions
// that carry an icon name as a literal —
//
//   draw_icon(s, "plus", ...)     the glyph call itself
//   icon: "layout-template",      menu / toolbar rows
//
// Names assembled at runtime from a variable are not visible to a scanner and
// are not claimed to be; the sheet's note names both the count and the method.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATTERNS = [/draw_icon\(\s*[^,]+,\s*"([a-z0-9-]+)"/g, /icon:\s*"([a-z0-9-]+)"/g];

export function scanIconUsage(appDir) {
  const dir = appDir instanceof URL ? fileURLToPath(appDir) : appDir;
  const used = new Map();
  let files = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.rs')).sort()) {
    const src = readFileSync(`${dir.replace(/\/$/, '')}/${name}`, 'utf8');
    files += 1;
    for (const re of PATTERNS) {
      for (const m of src.matchAll(re)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(name);
      }
    }
  }
  return { used, files };
}

export function iconAudit(appDir, iconNames) {
  const { used, files } = scanIconUsage(appDir);
  const known = new Set(iconNames);
  const missing = [...used.keys()].filter((n) => !known.has(n)).sort();
  const unused = iconNames.filter((n) => !used.has(n)).sort();
  return {
    files,
    used: used.size,
    missing,
    unused,
    where: 'draw_icon / icon: literals',
  };
}
