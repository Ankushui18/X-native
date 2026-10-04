/**
 * F1 parity pin (BEHAVIOR_OUTPUT_PARITY_AUDIT_2026-10-04.md): the WASM
 * export bridge must not answer `exportNode` with flat-color stubs.
 *
 * The stubs this replaced (tree @ 9baf0cd):
 * (crates/x-wasm/src/session.rs, ~:341) encodes a single solid
 * `node_rgba()` fill for the whole box (encode_node_png ~:692), a JPEG that
 * is marker soup around raw RGBA (~:731), and a PDF of one `re f` rect
 * (~:750) - and inspector.tsx (~:9312) routes web exports through it
 * *preferentially*. The real pipeline exists (`x_render::export_raster` +
 * `ir::build_render_tree*`, used by crates/x-native/src/export.rs) and the
 * fix is to route the bridge through it, refusing nodes it cannot render
 * rather than painting them wrong. Pixel-level assertions (the fix PR adds crates/x-wasm/tests/export_pixels.rs:
 * corner alpha, child pixels, JPEG decodability, PDF op-count - per the report ledger, run under cargo in CI).
 *
 * These are static contract pins because the sandbox `npm test` suite never
 * loads a compiled .wasm (apps/web/public ships none) - exactly the blind
 * spot that let the stubs survive; the pixel truth is pinned by the Rust
 * tests in session.rs (`cargo test -p x-wasm -- export`) which byte-compare
 * the bridge's envelope against `x_render`'s own encoders. In the chain:
 * `vite-node src/ui/__tests__/exportBridgeContract.test.mjs`.
 *
 * Sabotage ledger (each entry must catch at least one assertion):
 *   re-add encode_node_png flat fill      -> "no stub encoder survives"
 *   keep the tree call but ignore it      -> "export_node body renders a tree"
 *   drop the quality argument again        -> "options payload crosses the bridge"
 *   fake the regex with a doc comment only -> body-scoped regexes reject it
 *   delete session.rs entirely             -> "bridge files still exist" fails
 */
import { existsSync, readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

const read = (u) => {
  const p = new URL(u, import.meta.url);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
};

console.log("F1 wasm export bridge contract (export must be the real x-render pipeline):");

const session = read("../../../../../crates/x-wasm/src/session.rs");
const lib = read("../../../../../crates/x-wasm/src/lib.rs");
const wasmExport = read("../../engine/wasmExport.ts");
t("bridge sources exist (moving them without updating this pin is itself a break)",
  session !== null && lib !== null && wasmExport !== null);

if (session !== null) {
  // Slice the export_node function body so the assertions can't be satisfied
  // by an unrelated mention elsewhere in the file. Stop at the next method of
  // the impl OR the next top-level fn - whichever comes first.
  const at = session.indexOf("fn export_node");
  const ends = [session.indexOf("\n    fn ", at + 10), session.indexOf("\n    pub fn ", at + 10), session.indexOf("\nfn ", at + 10)]
    .map((i) => (i > 0 ? i : Infinity));
  const body = at >= 0 ? session.slice(at, Math.min(...ends, at + 6000)) : "";
  t("export_node is still a function in session.rs (pin guard)", at >= 0);
  t("export_node routes through the real render tree",
    /build_render_tree|export_raster|RasterFormat/.test(body));
  t("no flat-fill pixel path inside export_node", !/node_rgba/.test(body));
  t("no stub encoders survive anywhere in the session",
    !/fn encode_node_png|fn encode_node_jpg|fn encode_node_pdf/.test(session));
  t("no hand-written one-rect PDF page", !/re f/.test(session));
}

if (lib !== null && session !== null) {
  // The bridge must carry the per-format options Figma documents (JPG/PDF
  // image quality, resampling, ignore-overlapping scope) or the format
  // toggles silently do nothing in wasm builds (finding F8).
  const sig = (lib.match(/fn export_node\(([^)]*)\)/s) || [])[1] || (session.match(/fn export_node\(([^)]*)\)/s) || [])[1] || "";
  t("export_node signature carries an options payload, not just id/format/scale",
    /quality|options|opts|json/.test(sig));
}

if (wasmExport !== null) {
  t("the TS bridge sends an options payload to the wasm call",
    /quality/.test(wasmExport));
  t("the TS bridge validates returned image bytes before declaring success",
    /decode|validate|assertOk|magic|signature/i.test(wasmExport) &&
    !/return\s*\{\s*ok:\s*true/.test(wasmExport.replace(/return \{ ok: true \} \/\/ validated/g, "")));
}

console.log(`\nexportBridgeContract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
