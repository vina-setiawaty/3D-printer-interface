// Five different petal-dot flowers on one bed, clear of petal-flower.gcode
// (centred X110 Y110, ~X/Y 83-137). Every mark is strokePetalDotted ->
// brushPetalDot; each flower only chooses paths, gap, size and azimuth.
// Usage: node make_five.mjs <path to texture_functions.js> <out.gcode>
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const [, , libPath, outPath] = process.argv;
const TF = await import(pathToFileURL(libPath).href);
const { Emitter, samplePath, polylineToPts, strokePetalDotted } = TF;

const KEEP_OUT = { x0: 78, y0: 78, x1: 142, y1: 142 }; // petal-flower + 5 mm
const SAFE_Z = 5;                                      // travel height between flowers
const DOT = { height: 1.0, extrudeSpeed: 150, dragSpeed: 600 };
const D2R = Math.PI / 180;

const em = new Emitter();
em.z = 10; em.retracted = true;

const line = (a, b) => polylineToPts([a, b]);
const curve = (fx, fy, t0, t1, step = 0.01) => samplePath(fx, fy, t0, t1, { step });
function stroke(pts, opts) { em.newPattern(); strokePetalDotted(em, pts, { ...DOT, ...opts }); }
/** Archimedean spiral around (cx, cy), `pitch` mm between turns, r0..r1. */
const spiral = (cx, cy, pitch, r0, r1) => {
  const k = pitch / (2 * Math.PI);
  return curve((t) => cx + k * t * Math.cos(t), (t) => cy + k * t * Math.sin(t), r0 / k, r1 / k, 0.02);
};
/** Circle path (CCW), open by one gap so the first and last dot don't stack. */
const ring = (cx, cy, r, gap) => {
  const n = Math.max(3, Math.round((2 * Math.PI * r) / gap));
  const end = (2 * Math.PI * (n - 1)) / n + 0.001;
  return { pts: curve((t) => cx + r * Math.cos(t), (t) => cy + r * Math.sin(t), 0, end), gap: (2 * Math.PI * r) / n };
};

// 1. DAISY -- 12 thin ray petals, walked base -> tip with azimuth 0, so
//    every tail is dragged OUT (the spiky azimuth-270 look); spiral centre
//    with azimuth 90 (tails in, raised middle).
function daisy(cx, cy) {
  for (let k = 0; k < 12; k++) {
    const a = (k * 30 + 15) * D2R, u = [Math.cos(a), Math.sin(a)];
    stroke(line([cx + 7 * u[0], cy + 7 * u[1]], [cx + 16 * u[0], cy + 16 * u[1]]),
      { diameter: 2.0, gap: 3.0, dragMm: 3.0, azimuthDeg: 0 });
  }
  stroke(spiral(cx, cy, 2.0, 1, 5), { diameter: 2.0, gap: 2.5, dragMm: 2.0, azimuthDeg: 90 });
}

// 2. SWIRL ROSE -- one spiral, 2.5 mm between turns, d2.5 dots each
//    dragged forward along the spiral (azimuth 0): the tails chain into
//    the next dot, so it reads as a coiled rose.
function swirlRose(cx, cy) {
  stroke(spiral(cx, cy, 2.5, 1.5, 17), { diameter: 2.5, gap: 3.0, dragMm: 2.5, azimuthDeg: 0 });
}

// 3. FOUR-PETAL -- like the crosses on the test sheet, grown into a
//    flower: 4 big fan petals (5 rays, tails in) + 4 small single-ray
//    petals between them + a 4-dot centre.
function fourPetal(cx, cy) {
  for (let k = 0; k < 4; k++) {
    const phi = (k * 90) * D2R, bx = cx + 4 * Math.cos(phi), by = cy + 4 * Math.sin(phi);
    for (let i = 0; i < 5; i++) {
      const f = i / 2 - 1, a = phi + f * 24 * D2R;
      const len = 15 * (1 - 0.35 * f * f), start = 3 + 4 * Math.abs(f);
      const at = (s) => [bx + s * Math.cos(a), by + s * Math.sin(a)];
      stroke(line(at(len), at(start)), { diameter: 2.0, gap: 3.0, dragMm: 2.5, azimuthDeg: 0 });
    }
    const d = (k * 90 + 45) * D2R, at = (s) => [cx + s * Math.cos(d), cy + s * Math.sin(d)];
    stroke(line(at(11), at(5)), { diameter: 1.6, gap: 3.0, dragMm: 2.0, azimuthDeg: 0 });
  }
  const c = ring(cx, cy, 2.0, 3.0);
  stroke(c.pts, { diameter: 2.0, gap: c.gap, dragMm: 1.5, azimuthDeg: 90 });
}

// 4. ROSE CURVE -- 5 petal loops r = R cos(5u) traced as outlines (two
//    nested loops per petal). Each loop runs CCW, so azimuth 90 drags
//    every tail into the inside of its petal. The part of each loop
//    within 4 mm of the centre is skipped (it would pile up there).
function roseCurve(cx, cy) {
  for (let k = 0; k < 5; k++) {
    const phi = (k * 72 + 90) * D2R;
    for (const R of [19, 12]) {
      const u0 = Math.acos(4 / R) / 5; // where R cos(5u) = 4
      const r = (u) => R * Math.cos(5 * u);
      stroke(curve((u) => cx + r(u) * Math.cos(phi + u), (u) => cy + r(u) * Math.sin(phi + u), -u0, u0, 0.002),
        { diameter: 2.0, gap: 3.0, dragMm: 2.0, azimuthDeg: 90 });
    }
  }
  const c = ring(cx, cy, 2.0, 2.5);
  stroke(c.pts, { diameter: 1.6, gap: c.gap, dragMm: 1.5, azimuthDeg: 90 });
}

// 5. SUNFLOWER -- a seed head of small dots on 4 rings (tails out, each
//    ring offset half a gap from the last), then one ring of long ray
//    petals dragged far out. On a CCW ring azimuth -90 points outward.
function sunflower(cx, cy) {
  [2, 4.5, 7, 9.5].forEach((r, i) => {
    const c = ring(cx, cy, r, 2.5);
    const shift = (i % 2) * (c.gap / 2) / r; // stagger alternate rings
    const pts = curve((t) => cx + r * Math.cos(t + shift), (t) => cy + r * Math.sin(t + shift),
      0, (2 * Math.PI * (Math.round(2 * Math.PI * r / c.gap) - 1)) / Math.round(2 * Math.PI * r / c.gap) + 0.001);
    stroke(pts, { diameter: 1.6, gap: c.gap, dragMm: 1.2, azimuthDeg: -90 });
  });
  const c = ring(cx, cy, 12.5, 3.6);
  stroke(c.pts, { diameter: 2.5, gap: c.gap, dragMm: 6.0, azimuthDeg: -90 });
}

// ------------------------------------------------------------------ layout --
// Ordered so the path between flowers goes around the middle, never over
// it; and lifted to SAFE_Z before each move so it clears earlier prints.
const FLOWERS = [
  ["swirl rose", swirlRose, 110, 35],
  ["daisy", daisy, 35, 35],
  ["rose curve", roseCurve, 35, 110],
  ["four-petal", fourPetal, 35, 185],
  ["sunflower", sunflower, 110, 185],
];

const report = [];
for (const [name, fn, cx, cy] of FLOWERS) {
  em.retract();
  em.a(`G1 Z${SAFE_Z.toFixed(3)} F3000`); em.z = SAFE_Z;
  em.a(`; --- ${name} at X${cx} Y${cy} ---`);
  const from = em.lines.length;
  fn(cx, cy);
  // footprint check: every XY this flower touches
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, dots = 0;
  for (const l of em.lines.slice(from)) {
    if (/ F150$/.test(l)) dots++;
    const mx = l.match(/X(-?[\d.]+)/), my = l.match(/Y(-?[\d.]+)/);
    if (mx) { x0 = Math.min(x0, +mx[1]); x1 = Math.max(x1, +mx[1]); }
    if (my) { y0 = Math.min(y0, +my[1]); y1 = Math.max(y1, +my[1]); }
  }
  const hits = !(x1 < KEEP_OUT.x0 || x0 > KEEP_OUT.x1 || y1 < KEEP_OUT.y0 || y0 > KEEP_OUT.y1);
  const onBed = x0 >= 5 && y0 >= 5 && x1 <= 215 && y1 <= 215;
  report.push({ name, at: [cx, cy], dots, x: [+x0.toFixed(1), +x1.toFixed(1)], y: [+y0.toFixed(1), +y1.toFixed(1)], hitsKeepOut: hits, onBed });
  if (hits || !onBed) throw new Error(`${name} is off the bed or overlaps petal-flower: ${JSON.stringify(report.at(-1))}`);
}
em.retract();

const lines = [
  "; five petal-dot flowers -- clear of petal-flower.gcode (X/Y 78-142 kept empty)",
  "; swirl rose X110 Y35 | daisy X35 Y35 | rose curve X35 Y110 | four-petal X35 Y185 | sunflower X110 Y185",
  "; brushPetalDot via strokePetalDotted; lifts to Z5 between flowers",
  "; assumes the printer is heated and homed (like the page's run once); no prime line",
  "G90", "M83", "M221 S100",
  ...em.lines,
  "G91", "G1 Z5.000 F3000", "G90",
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({ lines: lines.length, filamentMm: +em.eTotal.toFixed(1), flowers: report }, null, 1));
