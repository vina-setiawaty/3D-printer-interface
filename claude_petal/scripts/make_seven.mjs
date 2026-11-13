// Seven more petal-dot designs for the same sheet: three large ones in the
// right column, four small ones in the diagonal gaps around petal-flower.
// Clear of petal-flower.gcode (X/Y 78-142) and five-flowers.gcode.
// Every mark is strokePetalDotted -> brushPetalDot.
// Usage: node make_seven.mjs <path to texture_functions.js> <out.gcode>
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const [, , libPath, outPath] = process.argv;
const TF = await import(pathToFileURL(libPath).href);
const { Emitter, samplePath, polylineToPts, strokePetalDotted } = TF;

// Already on the sheet: petal-flower (+5 mm) and the five flowers' extents (+2 mm)
const TAKEN = [
  { name: "petal-flower", x0: 78, y0: 78, x1: 142, y1: 142 },
  { name: "swirl rose", x0: 91.6, y0: 15.9, x1: 127.2, y1: 52.8 },
  { name: "daisy", x0: 14.6, y0: 14.6, x1: 55.4, y1: 55.4 },
  { name: "rose curve", x0: 15.6, y0: 92.5, x1: 54.9, y1: 130.5 },
  { name: "four-petal", x0: 14, y0: 164, x1: 56, y1: 206 },
  { name: "sunflower", x0: 89.5, y0: 164.7, x1: 130.5, y1: 205.3 },
];
const SAFE_Z = 5;
const DOT = { height: 1.0, extrudeSpeed: 150, dragSpeed: 600 };
const D2R = Math.PI / 180;

const em = new Emitter();
em.z = 10; em.retracted = true;

const line = (a, b) => polylineToPts([a, b]);
const curve = (fx, fy, t0, t1, step = 0.01) => samplePath(fx, fy, t0, t1, { step });
function stroke(pts, opts) { em.newPattern(); strokePetalDotted(em, pts, { ...DOT, ...opts }); }
const ring = (cx, cy, r, gap) => {
  const n = Math.max(3, Math.round((2 * Math.PI * r) / gap));
  return { pts: curve((t) => cx + r * Math.cos(t), (t) => cy + r * Math.sin(t), 0, (2 * Math.PI * (n - 1)) / n + 0.001), gap: (2 * Math.PI * r) / n };
};

// ------------------------------------------------- large (right column) --

// WAVE FIELD -- five sine-wave rows, every dot's tail dragged to the left
// of travel (azimuth 90), so the tails follow the wave's slope: a field
// of fish scales / ripples.
function waveField(cx, cy) {
  for (const off of [-14, -7, 0, 7, 14]) {
    stroke(curve((x) => cx + x, (x) => cy + off + 2.2 * Math.sin((2 * Math.PI * x) / 11), -16, 16, 0.02),
      { diameter: 2.0, gap: 3.0, dragMm: 2.5, azimuthDeg: 90 });
  }
}

// GALAXY -- four logarithmic-spiral arms r = 2 e^(0.25 th), walked from
// the core outward with azimuth 0: each tail chains into the next dot, so
// the arms read as curved streaks that widen as they go out.
function galaxy(cx, cy) {
  const a = 2, b = 0.25, thMax = Math.log(16.5 / a) / b;
  for (let k = 0; k < 4; k++) {
    const ph = k * 90 * D2R, r = (t) => a * Math.exp(b * t);
    stroke(curve((t) => cx + r(t) * Math.cos(t + ph), (t) => cy + r(t) * Math.sin(t + ph), 0, thMax, 0.005),
      { diameter: 2.0, gap: 3.0, dragMm: 2.5, azimuthDeg: 0 });
  }
}

// FEATHER -- a bowed spine (walked base -> tip, tails forward) and barbs
// leaving it at 50 deg toward the tip, longest in the middle, each walked
// outward so its tails sweep out to the edge like a quill's vanes.
function feather(cx, cy) {
  const A = [-8, -12], B = [8, 12];
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const ux = (B[0] - A[0]) / len, uy = (B[1] - A[1]) / len, nx = -uy, ny = ux;
  const P = (s) => [cx + A[0] + ux * len * s + nx * 3 * Math.sin(Math.PI * s), cy + A[1] + uy * len * s + ny * 3 * Math.sin(Math.PI * s)];
  stroke(curve((s) => P(s)[0], (s) => P(s)[1], 0, 1, 0.002), { diameter: 2.0, gap: 2.5, dragMm: 2.0, azimuthDeg: 0 });
  for (let s = 0.14; s <= 0.9; s += 0.085) {
    const [px, py] = P(s);
    const tx = ux + nx * 3 * Math.PI * Math.cos(Math.PI * s) / len, ty = uy + ny * 3 * Math.PI * Math.cos(Math.PI * s) / len;
    const th = Math.atan2(ty, tx), L = 2 + 7 * Math.sin(Math.PI * s) ** 0.8;
    for (const side of [1, -1]) {
      const a = th + side * 50 * D2R, d = [Math.cos(a), Math.sin(a)];
      stroke(line([px + 1.5 * d[0], py + 1.5 * d[1]], [px + (1.5 + L) * d[0], py + (1.5 + L) * d[1]]),
        { diameter: 1.6, gap: 2.5, dragMm: 1.5, azimuthDeg: 0 });
    }
  }
}

// ------------------------------------------------ small (diagonal gaps) --

// PINWHEEL -- six arms curling as they go out, tails chained forward.
function pinwheel(cx, cy) {
  for (let k = 0; k < 6; k++) {
    const ph = k * 60 * D2R, th = (r) => ph + 0.13 * r;
    stroke(curve((r) => cx + r * Math.cos(th(r)), (r) => cy + r * Math.sin(th(r)), 1.5, 8.5, 0.01),
      { diameter: 1.6, gap: 2.3, dragMm: 1.5, azimuthDeg: 0 });
  }
}

// TARGET -- three rings whose tails alternate out / in / out, so
// neighbouring rings drag toward or away from each other: a texture you
// can feel change direction ring by ring.
function target(cx, cy) {
  [[3, -90], [6, 90], [9, -90]].forEach(([r, az]) => {
    const c = ring(cx, cy, r, 2.5);
    stroke(c.pts, { diameter: 1.6, gap: c.gap, dragMm: 1.2, azimuthDeg: az });
  });
}

// RAINDROP -- the brush's own shape, scaled up: a big teardrop (teardrop
// curve x = cos t, half-width sin t * sin(t/2)) filled with rows parallel
// to its axis, each walked from the round end toward the tip with
// azimuth 0 -- small drops all pointing at the big drop's tip. Tilted 45 deg.
function raindrop(cx, cy) {
  const S = 9, tilt = 45 * D2R, ax = [Math.cos(tilt), Math.sin(tilt)], nv = [-ax[1], ax[0]];
  const halfW = (x) => { const t = Math.acos(Math.max(-1, Math.min(1, x / S))); return S * Math.sin(t) * Math.sin(t / 2); };
  const at = (x, o) => [cx + ax[0] * x + nv[0] * o, cy + ax[1] * x + nv[1] * o];
  for (let o = -4.8; o <= 4.8 + 1e-9; o += 2.4) {
    let x0 = null, x1 = null;
    for (let x = -S; x <= S; x += 0.05) if (halfW(x) >= Math.abs(o) + 0.8) { x0 ??= x; x1 = x; }
    if (x0 == null || x1 - x0 < 1) continue;
    stroke(line(at(x0 + 0.8, o), at(x1 - 1.5, o)), { diameter: 1.6, gap: 2.6, dragMm: 1.5, azimuthDeg: 0 });
  }
}

// HEART -- two nested hearts (x = 16 sin^3 t, y = 13 cos t - 5 cos 2t -
// 2 cos 3t - cos 4t). The curve runs clockwise, so azimuth -90 drags every
// tail into the heart.
function heart(cx, cy) {
  const hx = (t) => 16 * Math.sin(t) ** 3, hy = (t) => 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  for (const k of [0.52, 0.3]) {
    const n = 0.12; // leave the last bit open so first and last dot don't stack
    stroke(curve((t) => cx + k * hx(t), (t) => cy + 1.2 + k * hy(t), 0, 2 * Math.PI - n, 0.002),
      { diameter: 1.6, gap: 2.5, dragMm: 1.5, azimuthDeg: -90 });
  }
}

// ------------------------------------------------------------------ layout --
// Bottom -> right column -> top, then the diagonal gaps; lifts to SAFE_Z
// before every move between pieces.
const PIECES = [
  ["wave field", waveField, 185, 35],
  ["galaxy", galaxy, 185, 110],
  ["feather", feather, 185, 185],
  ["heart", heart, 155, 155],
  ["target", target, 155, 65],
  ["pinwheel", pinwheel, 65, 65],
  ["raindrop", raindrop, 65, 155],
];

const report = [], placed = [];
for (const [name, fn, cx, cy] of PIECES) {
  em.retract();
  em.a(`G1 Z${SAFE_Z.toFixed(3)} F3000`); em.z = SAFE_Z;
  em.a(`; --- ${name} at X${cx} Y${cy} ---`);
  const from = em.lines.length;
  fn(cx, cy);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, dots = 0;
  for (const l of em.lines.slice(from)) {
    if (/ F150$/.test(l)) dots++;
    const mx = l.match(/X(-?[\d.]+)/), my = l.match(/Y(-?[\d.]+)/);
    if (mx) { x0 = Math.min(x0, +mx[1]); x1 = Math.max(x1, +mx[1]); }
    if (my) { y0 = Math.min(y0, +my[1]); y1 = Math.max(y1, +my[1]); }
  }
  const box = { name, x0, y0, x1, y1 };
  const hit = [...TAKEN, ...placed].find((b) => !(x1 < b.x0 || x0 > b.x1 || y1 < b.y0 || y0 > b.y1));
  const onBed = x0 >= 5 && y0 >= 5 && x1 <= 215 && y1 <= 215;
  report.push({ name, at: [cx, cy], dots, x: [+x0.toFixed(1), +x1.toFixed(1)], y: [+y0.toFixed(1), +y1.toFixed(1)] });
  if (hit || !onBed) throw new Error(`${name} ${hit ? `overlaps ${hit.name}` : "is off the bed"}: ${JSON.stringify(report.at(-1))}`);
  placed.push({ name, x0: x0 - 2, y0: y0 - 2, x1: x1 + 2, y1: y1 + 2 });
}
em.retract();

const lines = [
  "; seven petal-dot pieces -- clear of petal-flower.gcode (X/Y 78-142) and five-flowers.gcode",
  "; wave field X185 Y35 | galaxy X185 Y110 | feather X185 Y185 | heart X155 Y155 | target X155 Y65 | pinwheel X65 Y65 | raindrop X65 Y155",
  "; brushPetalDot via strokePetalDotted; lifts to Z5 between pieces",
  "; assumes the printer is heated and homed (like the page's run once); no prime line",
  "G90", "M83", "M221 S100",
  ...em.lines,
  "G91", "G1 Z5.000 F3000", "G90",
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({ lines: lines.length, filamentMm: +em.eTotal.toFixed(1), dots: report.reduce((a, r) => a + r.dots, 0) }));
for (const r of report) console.log(r.name, r.at, "dots", r.dots, "x", r.x, "y", r.y);
