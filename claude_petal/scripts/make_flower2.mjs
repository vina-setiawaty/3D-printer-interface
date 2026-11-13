// Flower made only of petal dots (strokePetalDotted -> brushPetalDot),
// after the test sheet: separate d2 dots, heads out / tails in.
// Usage: node make_flower2.mjs <path to texture_functions.js> <out.gcode>
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const [, , libPath, outPath] = process.argv;
const TF = await import(pathToFileURL(libPath).href);
const { Emitter, samplePath, polylineToPts, strokePetalDotted } = TF;

const CX = 110, CY = 110;
const DOT = { diameter: 2.0, height: 1.0, extrudeSpeed: 150, dragSpeed: 600 };

// ---------------------------------------------------------------- petals --
// 6 petals. Each is a fan of 5 rays from a base point at r = R_IN, spread
// +-26 deg; the middle ray is longest, so the tips make a rounded edge and
// the base is narrow. Outer rays start further from the base so their dots
// don't pile up where the rays converge. Rays are walked tip -> base with
// azimuthDeg 0 (drag forward = toward the centre): every dot's round head
// faces out and its tail in, like the azimuth-90 spiral on the sheet.
const PETALS = 6, R_IN = 8, RAY_MAX = 19, SPREAD = 26, RAYS = 5;

function petalRows(phi) {
  const bx = CX + R_IN * Math.cos(phi), by = CY + R_IN * Math.sin(phi);
  const rows = [];
  for (let i = 0; i < RAYS; i++) {
    const f = (2 * i) / (RAYS - 1) - 1;           // -1 .. 1 across the petal
    const a = phi + (f * SPREAD * Math.PI) / 180;
    const len = RAY_MAX * (1 - 0.35 * f * f);      // rounded tip
    const start = 3 + 5 * Math.abs(f);             // narrow base
    const at = (s) => [bx + s * Math.cos(a), by + s * Math.sin(a)];
    rows.push([at(len), at(start)]);               // tip -> base
  }
  return rows;
}

// ---------------------------------------------------------------- centre --
// Archimedean spiral r = t/pi (2 mm between turns), from 1 to 7 mm, with
// azimuthDeg 90: on a CCW spiral that drags each dot toward the middle --
// the raised centre seen on the sheet.
const T0 = Math.PI, T1 = 7 * Math.PI;

const em = new Emitter();
em.z = 10; em.retracted = true;
let dots = 0;
const count = (fn) => { const before = em.lines.filter((l) => / F150$/.test(l)).length; fn(); dots += em.lines.filter((l) => / F150$/.test(l)).length - before; };

for (let k = 0; k < PETALS; k++) {
  const phi = (2 * Math.PI * k) / PETALS + Math.PI / 2;
  for (const row of petalRows(phi)) {
    em.newPattern();
    count(() => strokePetalDotted(em, polylineToPts(row), { ...DOT, gap: 3.0, dragMm: 3.0, azimuthDeg: 0 }));
  }
}
const spiral = samplePath(
  (t) => CX + (t / Math.PI) * Math.cos(t), (t) => CY + (t / Math.PI) * Math.sin(t),
  T0, T1, { step: 0.02 });
em.newPattern();
count(() => strokePetalDotted(em, spiral, { ...DOT, gap: 2.5, dragMm: 2.0, azimuthDeg: 90 }));
em.retract();

const lines = [
  "; petal-dot flower -- 6 petals of petal dots + a spiral centre, ~54 mm across, centred at X110 Y110",
  "; brushPetalDot d2 h1; petals: rows tip->base, azimuth 0 (tails in); centre: spiral r=t/pi, azimuth 90",
  "; assumes the printer is heated and homed (like the page's run once)",
  "G90", "M83", "M221 S100",
  ...em.lines,
  "G91", "G1 Z2.000 F3000", "G90",
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({ lines: lines.length, dots, filamentMm: +em.eTotal.toFixed(1) }));
