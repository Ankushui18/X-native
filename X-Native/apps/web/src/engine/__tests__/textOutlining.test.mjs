/**
 * Tests for Typography Engine Phase 2: Text Outlining Correctness.
 * Verifies contour signed areas, counter loop normalization, NONZERO winding rule,
 * and hole rendering for lowercase and mixed text glyphs.
 */
import {
  convertTextToGlyphPaths,
  convertTextToVectorPaths,
  signedArea,
  polygonWindingNumber,
  pointInPolygon,
} from "../textVector.ts";

let pass = 0;
let fail = 0;

function t(name, ok) {
  if (ok) {
    pass++;
    console.log(`ok   ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}`);
  }
}

console.log("textOutlining: testing glyph contours and NONZERO winding parity");

// Helper to reconstruct polygon vertices from loop vertex indices
function getLoopPolygon(network, loopIndices) {
  return loopIndices.map((idx) => network.vertices[idx]);
}

// ---------------------------------------------------------------------------
// Test A: Glyph "O" (48px)
// ---------------------------------------------------------------------------
{
  const results = convertTextToGlyphPaths("O", 48);
  t("Test A: Glyph 'O' produces 1 glyph layer", results.length === 1 && results[0].char === "O");

  const glyph = results[0];
  const region = glyph.network.regions?.[0];
  t("Test A: 'O' has regions defined with windingRule 'NONZERO'", region && region.windingRule === "NONZERO");
  t("Test A: 'O' (48px) has exactly 2 loops", region && region.loops.length === 2);

  const loop0 = getLoopPolygon(glyph.network, region.loops[0]);
  const loop1 = getLoopPolygon(glyph.network, region.loops[1]);
  const area0 = signedArea(loop0);
  const area1 = signedArea(loop1);

  console.log(`[Signed Area] 'O' (48px): Loop 0 = ${area0.toFixed(2)}, Loop 1 = ${area1.toFixed(2)}`);

  t("Test A: Loop 0 (outer) is CCW (positive area)", area0 > 0);
  t("Test A: Loop 1 (inner counter) is CW (negative area)", area1 < 0);
  t("Test A: Loop 0 and Loop 1 have opposite signed areas", area0 * area1 < 0);

  // Hole test: Center of "O" inner counter must have winding number 0 under NONZERO
  const holePt = { x: glyph.w / 2, y: glyph.h / 2 };
  const wnOuter = polygonWindingNumber(holePt, loop0);
  const wnInner = polygonWindingNumber(holePt, loop1);
  const totalWnHole = wnOuter + wnInner;

  t("Test A: Center point is inside outer contour", wnOuter !== 0);
  t("Test A: Center point is inside inner contour", wnInner !== 0);
  t("Test A: Counter renders as a hole under NONZERO (total winding number = 0)", totalWnHole === 0);

  // Solid test: Rim of "O" must have winding number != 0
  const rimPt = { x: loop0[0].x + 1, y: loop0[0].y + 1 };
  const totalWnRim = polygonWindingNumber(rimPt, loop0) + polygonWindingNumber(rimPt, loop1);
  t("Test A: Rim of 'O' renders solid (winding number != 0)", totalWnRim !== 0);
}

// ---------------------------------------------------------------------------
// Test B: Glyph "e" (48px)
// ---------------------------------------------------------------------------
{
  const results = convertTextToGlyphPaths("e", 48);
  t("Test B: Glyph 'e' produces 1 glyph layer", results.length === 1 && results[0].char === "e");

  const glyph = results[0];
  const region = glyph.network.regions?.[0];
  t("Test B: 'e' has windingRule 'NONZERO'", region && region.windingRule === "NONZERO");
  t("Test B: 'e' (48px) has exactly 2 loops", region && region.loops.length === 2);

  const loop0 = getLoopPolygon(glyph.network, region.loops[0]);
  const loop1 = getLoopPolygon(glyph.network, region.loops[1]);
  const area0 = signedArea(loop0);
  const area1 = signedArea(loop1);

  console.log(`[Signed Area] 'e' (48px): Outer Loop = ${area0.toFixed(2)}, Eye Loop = ${area1.toFixed(2)}`);

  t("Test B: Outer loop is CCW (positive area)", area0 > 0);
  t("Test B: Eye counter loop is CW (negative area)", area1 < 0);
  t("Test B: Opposite winding directions (area0 * area1 < 0)", area0 * area1 < 0);

  // Eye hole test
  // Compute centroid of the eye loop
  const eyeCx = loop1.reduce((sum, p) => sum + p.x, 0) / loop1.length;
  const eyeCy = loop1.reduce((sum, p) => sum + p.y, 0) / loop1.length;
  const eyePt = { x: eyeCx, y: eyeCy };

  const wnEyeOuter = polygonWindingNumber(eyePt, loop0);
  const wnEyeInner = polygonWindingNumber(eyePt, loop1);
  const totalWnEye = wnEyeOuter + wnEyeInner;

  t("Test B: Eye point is inside outer contour", wnEyeOuter !== 0);
  t("Test B: Eye point is inside inner loop", wnEyeInner !== 0);
  t("Test B: The eye of 'e' renders as a hole under NONZERO (total winding number = 0)", totalWnEye === 0);
}

// ---------------------------------------------------------------------------
// Test C: Glyph "g" (48px)
// ---------------------------------------------------------------------------
{
  const results = convertTextToGlyphPaths("g", 48);
  t("Test C: Glyph 'g' produces 1 glyph layer", results.length === 1 && results[0].char === "g");

  const glyph = results[0];
  const region = glyph.network.regions?.[0];
  t("Test C: 'g' has windingRule 'NONZERO'", region && region.windingRule === "NONZERO");

  // Lowercase 'g' has 3 loops (outer body + upper bowl counter + lower loop counter)
  t("Test C: Glyph 'g' has 3 loops (outer + upper bowl counter + lower loop counter)", region && region.loops.length === 3);

  const loop0 = getLoopPolygon(glyph.network, region.loops[0]);
  const loopUpper = getLoopPolygon(glyph.network, region.loops[1]);
  const loopLower = getLoopPolygon(glyph.network, region.loops[2]);

  const area0 = signedArea(loop0);
  const areaUpper = signedArea(loopUpper);
  const areaLower = signedArea(loopLower);

  console.log(`[Signed Area] 'g' (48px): Outer = ${area0.toFixed(2)}, Upper Counter = ${areaUpper.toFixed(2)}, Lower Counter = ${areaLower.toFixed(2)}`);

  t("Test C: Outer loop is CCW (positive area)", area0 > 0);
  t("Test C: Upper counter is CW (negative area)", areaUpper < 0);
  t("Test C: Lower loop counter exists and is CW (negative area)", areaLower < 0);
  t("Test C: Both counters have opposite winding to outer contour", area0 * areaUpper < 0 && area0 * areaLower < 0);

  // Verify lower loop counter renders as a hole
  const lowerCx = loopLower.reduce((sum, p) => sum + p.x, 0) / loopLower.length;
  const lowerCy = loopLower.reduce((sum, p) => sum + p.y, 0) / loopLower.length;
  const lowerPt = { x: lowerCx, y: lowerCy };

  const totalWnLower =
    polygonWindingNumber(lowerPt, loop0) +
    polygonWindingNumber(lowerPt, loopUpper) +
    polygonWindingNumber(lowerPt, loopLower);

  t("Test C: Lower loop counter renders as a hole under NONZERO (total winding number = 0)", totalWnLower === 0);

  // Verify upper bowl counter renders as a hole
  const upperCx = loopUpper.reduce((sum, p) => sum + p.x, 0) / loopUpper.length;
  const upperCy = loopUpper.reduce((sum, p) => sum + p.y, 0) / loopUpper.length;
  const upperPt = { x: upperCx, y: upperCy };

  const totalWnUpper =
    polygonWindingNumber(upperPt, loop0) +
    polygonWindingNumber(upperPt, loopUpper) +
    polygonWindingNumber(upperPt, loopLower);

  t("Test C: Upper bowl counter renders as a hole under NONZERO (total winding number = 0)", totalWnUpper === 0);
}

// ---------------------------------------------------------------------------
// Test D: Mixed string "Figma" (48px)
// ---------------------------------------------------------------------------
{
  const results = convertTextToGlyphPaths("Figma", 48);
  t("Test D: 'Figma' (48px) creates exactly 5 separate vector layers", results.length === 5);
  t("Test D: Layers match characters ['F', 'i', 'g', 'm', 'a'] in order",
    results.map((r) => r.char).join("") === "Figma"
  );

  // Verify all layers are vector networks with NONZERO windingRule
  t("Test D: All glyph layers have windingRule 'NONZERO'",
    results.every((r) => r.network.regions?.[0]?.windingRule === "NONZERO")
  );

  // Check 'g' glyph in "Figma"
  const gGlyph = results[2];
  t("Test D: Glyph 'g' has 3 loops", gGlyph.network.regions[0].loops.length === 3);

  // Check 'a' glyph in "Figma"
  const aGlyph = results[4];
  t("Test D: Glyph 'a' has 2 loops (outer + bowl counter)", aGlyph.network.regions[0].loops.length === 2);

  const aLoop0 = getLoopPolygon(aGlyph.network, aGlyph.network.regions[0].loops[0]);
  const aLoop1 = getLoopPolygon(aGlyph.network, aGlyph.network.regions[0].loops[1]);
  const aArea0 = signedArea(aLoop0);
  const aArea1 = signedArea(aLoop1);

  console.log(`[Signed Area] 'a' (48px): Outer = ${aArea0.toFixed(2)}, Counter = ${aArea1.toFixed(2)}`);

  t("Test D: 'a' outer is CCW and counter is CW", aArea0 > 0 && aArea1 < 0);

  const aCx = aLoop1.reduce((sum, p) => sum + p.x, 0) / aLoop1.length;
  const aCy = aLoop1.reduce((sum, p) => sum + p.y, 0) / aLoop1.length;
  const aHolePt = { x: aCx, y: aCy };
  const aTotalWn = polygonWindingNumber(aHolePt, aLoop0) + polygonWindingNumber(aHolePt, aLoop1);

  t("Test D: 'a' bowl counter renders as a hole under NONZERO (total winding number = 0, no solid blob)", aTotalWn === 0);

  // Verify non-intersecting horizontal placement
  let nonOverlapping = true;
  for (let i = 0; i < results.length - 1; i++) {
    const cur = results[i];
    const next = results[i + 1];
    // Each glyph x should advance
    if (next.x <= cur.x) {
      nonOverlapping = false;
      break;
    }
  }
  t("Test D: All 5 glyph layers have progressing horizontal positions (x offsets advance)", nonOverlapping);
}

// ---------------------------------------------------------------------------
// Additional Lowercase Fallbacks: 'm', 'f', 'p', 'q', 'b', 'd'
// ---------------------------------------------------------------------------
{
  for (const ch of ["m", "f", "p", "q", "b", "d"]) {
    const res = convertTextToGlyphPaths(ch, 48);
    t(`Fallback '${ch}': produces valid glyph layer`, res.length === 1 && res[0].char === ch);
    const loops = res[0].network.regions[0].loops;
    const polys = loops.map((l) => getLoopPolygon(res[0].network, l));
    const areas = polys.map(signedArea);
    console.log(`[Signed Area] '${ch}' (48px): ${areas.map((a) => a.toFixed(2)).join(", ")}`);

    t(`Fallback '${ch}': outer contour is CCW (positive area)`, areas[0] > 0);
    if (areas.length > 1) {
      for (let k = 1; k < areas.length; k++) {
        t(`Fallback '${ch}': inner counter ${k} is CW (negative area)`, areas[k] < 0);
      }
    }
  }
}

console.log(`\ntextOutlining: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
