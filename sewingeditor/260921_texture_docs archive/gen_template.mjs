/**
 * gen_template.mjs -- REFERENCE COPY. Do not run this in place and do not
 * edit it per-turn. Each turn: copy it into the scratchpad directory,
 * fill in the CONFIG block + buildTextures() body, then run:
 *
 *   node <scratchpad>/gen_hairy_vN.mjs <path-to-texture_functions.js> <out.gcode>
 *
 * Why this exists (see Task_FineTune.md SS7): it prints a compact
 * VERIFICATION DIGEST to stdout -- the negative-E lines and their
 * expected count, eTotal, the first ~55 lines of actual texture G-code,
 * and the footer tail -- so the generated .gcode file NEVER has to be
 * read back in full. A ~1500-line hairy/blob file is ~18k tokens (mostly
 * the ~600 near-identical calibration-line moves); the digest is ~1k.
 * Hand-verify from the digest; for any follow-up question use a targeted
 * `grep -n` / `sed -n`, never a full read.
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const [, , libPath, outPath] = process.argv;
if (!libPath || !outPath) {
  console.error("usage: node <this> <texture_functions.js> <out.gcode>");
  process.exit(1);
}
const lib = await import(pathToFileURL(libPath).href);
const {
  Emitter, verifyLayout, freeformSolid,
  // pull in whatever styles this test needs:
  // freeformBlobDotted, freeformHairyDotted, freeformVariableThickness, fill, DIAMOND, ...
} = lib;

/* ============================== CONFIG ============================== */

// calibration line -- NORMAL mode: horizontal x=CAL.x0..x1 at y=CAL.y.
// CAL.y = previous file's calibration y minus 5 (check the newest file in
// test_print_gcode/). For TEST MODE (Task_FineTune.md SS6) replace this
// with the vertical marched stripe instead.
const CAL = { x0: 120, x1: 180, y: /* FILL IN */ 0 };

// every printed element's bounding rectangle, for verifyLayout().
// For a line texture: x0 = min x - featureRadius, w = xspan + 2*featureRadius,
// y0 = centre y - featureRadius, h = 2*featureRadius.
// For an ANGLED hairy dot (hairElevationDeg < 90) also add the strand's
// XY reach: (hairLength + stringMm + overtravelMm) * cos(elevation),
// split into x = reach*cos(azimuth), y = reach*sin(azimuth).
const LAYOUT = [
  { name: "calibration", x0: CAL.x0, y0: CAL.y - 0.5, w: CAL.x1 - CAL.x0, h: 1 },
  // { name: "texture A", x0: 0, y0: 0, w: 0, h: 0 },
];

// how many negative-E (retract) lines to EXPECT in the whole file:
//   1  (header's establishing retract)
// + CAL_LAYERS            (freeformSolid default nLayers = 2, one retract each)
// + (retracts per texture unit) * (unit count)   -- e.g. 1 per blob/hairy dot
const CAL_LAYERS = 2;
const EXPECT_NEG_E = 1 + CAL_LAYERS + (/* per unit */ 0) * (/* unit count */ 0);

/* ============================= GENERATE ============================= */

const em = new Emitter();
em.header();

if (verifyLayout) {
  const chk = verifyLayout(LAYOUT);
  console.log("verifyLayout:", JSON.stringify(chk));
  if (!chk.ok) { console.error("*** LAYOUT FAILED -- fix positions before generating ***"); process.exit(1); }
  if (chk.warnings?.length) console.log("  (warnings above -- surface to the user)");
}

// calibration line FIRST, always.
freeformSolid(em, (t) => CAL.x0 + t, () => CAL.y, 0, CAL.x1 - CAL.x0);

const texStart = em.lines.length;   // <-- digest dumps from here

/* ------------------------- buildTextures() ------------------------- */
// Emit the texture(s) under test. Example:
//   freeformHairyDotted(em, (t) => 20 + t, () => 200, 0, 30,
//     { gap: 5, rootDiameter: 2, hairLength: 5 });

/* ----------------------------------------------------------------- */

em.footer();
writeFileSync(outPath, em.lines.join("\n") + "\n");

/* ============================== DIGEST ============================== */

const L = em.lines;
const negE = L.map((l, i) => [i + 1, l]).filter(([, l]) => /\bE-[0-9]/.test(l));

console.log("\n=== VERIFICATION DIGEST ===");
console.log(`file:         ${outPath}`);
console.log(`total lines:  ${L.length}`);
console.log(`negative-E:   ${negE.length}  (expected ${EXPECT_NEG_E})  ${
  negE.length === EXPECT_NEG_E ? "OK" : "*** MISMATCH ***"}`);
for (const [n, l] of negE) console.log(`   L${n}: ${l}`);
console.log(`eTotal (informational, never emitted): ${em.eTotal.toFixed(4)}`);

const texEnd = Math.min(texStart + 55, L.length);
console.log(`\n--- texture G-code, L${texStart + 1}..${texEnd} (first ~2 units) ---`);
for (let i = texStart; i < texEnd; i++) console.log(`   ${L[i]}`);

console.log(`\n--- footer tail, last 12 lines ---`);
for (let i = Math.max(0, L.length - 12); i < L.length; i++) console.log(`   ${L[i]}`);

// stray-E guard: an E term on something that isn't a G1 move is
// suspicious. G92 (set-position, e.g. `G92 E0`) is legitimate and
// excluded. Print anything else that looks off.
const strayE = L.map((l, i) => [i + 1, l]).filter(([, l]) =>
  /\bE-?[0-9]/.test(l) && !/^G1 /.test(l) && !/^G92\b/.test(l));
if (strayE.length) {
  console.log(`\n*** ${strayE.length} E term(s) on non-G1/non-G92 lines -- inspect: ***`);
  for (const [n, l] of strayE) console.log(`   L${n}: ${l}`);
}
