// Spiral-arms sheet: several variable-thickness spirals of different sizes
// and arm counts, packed inside a 200 x 200 mm area (X 10-210, Y 10-210).
// Same method as spiralArms() in claude_variableThickness/scripts/make_vt_sheet.mjs:
// an Archimedean spiral (fused, `pitch` mm apart) printed wave by wave with
// brushVariableThickness, each turn holding (arms + 0.2) waves so the peaks
// drift and line up into `arms` curved arms.
// Usage: node make_spirals.mjs <texture_functions.js> <out.gcode>
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { labelled } from "./label.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , libPath, outPath] = process.argv;
const copy = join(dirname(fileURLToPath(import.meta.url)), "tf_copy.mjs");
writeFileSync(copy, readFileSync(libPath, "utf8") + "\nexport { brushVariableThickness, restOfPath };\n");
const TF = await import(pathToFileURL(copy).href + `?t=${Date.now()}`);
const { Emitter, samplePath, totalLength, restOfPath } = TF;
const brushVariableThickness = labelled("brushVariableThickness", TF.brushVariableThickness);

const TAU = 2 * Math.PI, SAFE_Z = 5, AREA = { x0: 10, x1: 210, y0: 10, y1: 210 };
const em = new Emitter();
em.z = 10; em.retracted = true;

function waveVar(pts, f) {
  const L = totalLength(pts);
  em.newPattern();
  let s = 0;
  for (let i = 0; L - s > 1e-6; i++) {
    const used = brushVariableThickness(em, restOfPath(pts, s), { volRate: 4.0, stepsPerWave: 25, ...f(i, s), gapLen: 0 });
    if (!(used > 0)) break;
    s += used;
  }
  em.retract();
}

/** Spiral from r = 1.5 mm out to rOuter; `arms` arms; `twist` +1 / -1 picks
 * the turning direction so neighbours don't all swirl the same way. */
function spiral(cx, cy, { rOuter, arms, pitch = 2.0, hMax = 1.1, beadWidth = 1.8, twist = 1 }) {
  const k = pitch / TAU, th0 = 1.5 / k, th1 = rOuter / k;
  const P = samplePath((t) => cx + k * t * Math.cos(t), (t) => cy + twist * k * t * Math.sin(t), th0, th1, { step: 0.002 });
  waveVar(P, (i, s) => {
    const r = k * Math.sqrt((2 * s) / k + th0 * th0);
    return { wavelength: Math.max(1.8, (TAU * r) / (arms + 0.2)), hMin: 0.25, hMax, beadWidth };
  });
}

// name, centre, options -- printed in this order (short moves between)
const PIECES = [
  ["small 4-arm", 100, 30, { rOuter: 12, arms: 4 }],
  ["medium 5-arm", 50, 65, { rOuter: 25, arms: 5, twist: -1 }],
  ["tiny 3-arm", 95, 95, { rOuter: 15, arms: 3 }],
  ["large 6-arm", 155, 70, { rOuter: 38, arms: 6, twist: -1 }],
  ["tiny 3-arm (2)", 195, 125, { rOuter: 10, arms: 3, pitch: 1.8, beadWidth: 1.6 }],
  ["medium 7-arm", 160, 170, { rOuter: 32, arms: 7 }],
  ["small 4-arm (2)", 115, 128, { rOuter: 14, arms: 4, twist: -1 }],
  ["giant 8-arm", 60, 160, { rOuter: 45, arms: 8, hMax: 1.2 }],
];

// printed marks as discs, to check the area and the gaps between pieces
function marks(slice) {
  const out = []; let x = null, y = null, z = 0;
  for (const l of slice) {
    if (!/^G1 X/.test(l)) { const mz = l.match(/Z(-?[\d.]+)/); if (mz && l.startsWith("G1 Z")) z = +mz[1]; const mx = l.match(/^G0 X(-?[\d.]+) Y(-?[\d.]+)/); if (mx) { x = +mx[1]; y = +mx[2]; } continue; }
    const m = Object.fromEntries([...l.matchAll(/([XYZE])(-?[\d.]+)/g)].map((r) => [r[1], +r[2]]));
    const nz = m.Z ?? z, L = Math.hypot(m.X - x, m.Y - y);
    if ((m.E ?? 0) > 0 && L > 1e-6) out.push({ x: m.X, y: m.Y, r: Math.min(2, (m.E * TF.FIL_AREA) / (L * Math.max(0.05, (z + nz) / 2)) / 2) });
    x = m.X; y = m.Y; z = nz;
  }
  return out;
}

const all = [], report = [];
let volume = 0;
for (const [name, cx, cy, o] of PIECES) {
  em.retract();
  em.a(`G1 Z${SAFE_Z.toFixed(3)} F3000`); em.z = SAFE_Z;
  em.a(`; --- ${name} spiral at X${cx} Y${cy}, radius ${o.rOuter} mm ---`);
  const from = em.lines.length, e0 = em.eTotal;
  spiral(cx, cy, o);
  const mine = marks(em.lines.slice(from));
  const ex = mine.reduce((b, p) => ({ x0: Math.min(b.x0, p.x - p.r), x1: Math.max(b.x1, p.x + p.r), y0: Math.min(b.y0, p.y - p.r), y1: Math.max(b.y1, p.y + p.r) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  let clear = Infinity;
  for (const p of mine) for (const q of all) {
    if (Math.abs(p.x - q.x) > 6 || Math.abs(p.y - q.y) > 6) continue;
    clear = Math.min(clear, Math.hypot(p.x - q.x, p.y - q.y) - p.r - q.r);
  }
  all.push(...mine);
  const mm3 = (em.eTotal - e0) * TF.FIL_AREA; volume += mm3;
  const r = { name, x: [+ex.x0.toFixed(1), +ex.x1.toFixed(1)], y: [+ex.y0.toFixed(1), +ex.y1.toFixed(1)], mm3: Math.round(mm3), clearMm: clear === Infinity ? null : +clear.toFixed(1) };
  report.push(r);
  if (ex.x0 < AREA.x0 || ex.x1 > AREA.x1 || ex.y0 < AREA.y0 || ex.y1 > AREA.y1) throw new Error(`${name} leaves the 200 x 200 area: ${JSON.stringify(r)}`);
  if (clear < 0.8) throw new Error(`${name} touches an earlier spiral: ${JSON.stringify(r)}`);
}
em.retract();

const lines = [
  "; spiral-arms sheet -- 8 variable-thickness spirals of different sizes in X 10-210, Y 10-210",
  "; " + PIECES.map(([n, x, y, o]) => `${n} r${o.rOuter} @X${x} Y${y}`).join(" | "),
  "; volRate 4 mm3/s throughout; lifts to Z5 between pieces",
  "; assumes the printer is heated and homed; no prime line",
  "G90", "M83", "M221 S100",
  ...em.lines,
  "G91", "G1 Z5.000 F3000", "G90",
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({ lines: lines.length, filamentMm: +em.eTotal.toFixed(1), plasticMm3: Math.round(volume), extrudeMinutes: +(volume / 4 / 60).toFixed(1) }));
for (const r of report) console.log(r.name.padEnd(16), "x", r.x, "y", r.y, "mm3", r.mm3, "clear", r.clearMm);
