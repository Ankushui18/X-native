// Which icon names the app code actually asks for.
//
// `draw_icon` silently draws nothing when a name is missing from `icons.rs`
// (there is no `has_icon` lookup at runtime), so a typo in a context menu
// ships as a blank space — a real bug this repo has hit. The scan is
// deliberately narrow and says so: it reads names out of the three positions
// that carry an icon name as a literal —
//
//   draw_icon(s, "plus", ...)     the glyph call itself
//   icon: "layout-template",      menu / toolbar rows
//   Tool::Select => "mouse-...",  the `fn icon()` binding tables
//
// Names assembled at runtime from a variable are not visible to a scanner and
// are not claimed to be; the sheet's note names both the count and the method.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PATTERNS = [/draw_icon\(\s*[^,]+,\s*"([a-z0-9-]+)"/g, /icon:\s*"([a-z0-9-]+)"/g];

// The third position that carries an icon name: the `fn icon()` tables that
// bind a tool, a nav tab or a menu row to a glyph
// (`Tool::Select => "mouse-pointer-2",`). They are literals, but neither
// pattern above can see them, so the sheet used to report 34 keys as "not
// named anywhere" while the toolbar and the context menu drew every one of
// them — the exact silent drift this scan exists to prevent. The body is
// brace-matched from `fn icon(` rather than scanned file-wide, so an unrelated
// `=> "string"` match arm elsewhere cannot be mistaken for a glyph.
const NAME_RE = /"([a-z0-9-]+)"/g;

function iconFnBodies(src) {
  const out = [];
  for (const m of src.matchAll(/\bfn [a-z_]*icon[a-z_]*\s*\(/g)) {
    const open = src.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}' && (depth -= 1) === 0) {
        out.push(src.slice(open, i + 1));
        break;
      }
    }
  }
  return out;
}

export function scanIconUsage(appDir) {
  const dir = appDir instanceof URL ? fileURLToPath(appDir) : appDir;
  const used = new Map();
  let files = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.rs')).sort()) {
    const src = readFileSync(`${dir.replace(/\/$/, '')}/${name}`, 'utf8');
    files += 1;
    const add = (icon) => {
      if (!used.has(icon)) used.set(icon, new Set());
      used.get(icon).add(name);
    };
    for (const re of PATTERNS) {
      for (const m of src.matchAll(re)) add(m[1]);
    }
    for (const body of iconFnBodies(src)) {
      for (const m of body.matchAll(NAME_RE)) add(m[1]);
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
    where: 'draw_icon / icon: / fn icon() literals',
  };
}
