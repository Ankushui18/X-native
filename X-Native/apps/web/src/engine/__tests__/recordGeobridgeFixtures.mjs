/**
 * Records the geo differential corpus: runs every case in geobridgeCorpus.ts
 * through the authoritative `booleanPathTs` and snapshots the outputs.
 *
 * Run with:  npm run record:geofixtures   (from apps/web)
 *
 * Re-run whenever the TS boolean changes deliberately; the diff is the review.
 * The wasm backend (design §8/P1) must match these fixtures within epsilon.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { booleanPathTs } from "../geometry.ts";
import { CORPUS } from "./geobridgeCorpus.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "geobridge.fixtures.json");

const cases = CORPUS.map((c) => ({ name: c.name, op: c.op, shapes: c.shapes, result: booleanPathTs(c.op, c.shapes) }));
const nulls = cases.filter((c) => c.result === null).map((c) => c.name);
fs.writeFileSync(OUT, JSON.stringify({ version: 1, generator: "recordGeobridgeFixtures.mjs", count: cases.length, cases }, null, 1) + "\n");
console.log(`recorded ${cases.length} fixtures -> ${path.basename(OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)}KB)`);
console.log(`null results (emptiness cases): ${nulls.length ? nulls.join(", ") : "none"}`);
