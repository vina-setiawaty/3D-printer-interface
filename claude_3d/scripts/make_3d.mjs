// 3D structures from the two texture brushes, used unchanged:
//   brushVariableThickness -- one cosine wave of bead height (with `peak`)
//   brushPetalDot          -- one blob at height h, dragged back down
// Both brushes write Z as "height above the surface they print on". To stack,
// every brush call here is generated as if on the bed and its Z values are
// then raised by what is already printed underneath (`stack()` below):
//   * a wall is ONE continuous helix; at each angle its base is the top of
//     the turn below (an angle-indexed height ring, updated half a turn late
//     so a turn never reads itself);
//   * a dot's base is the top of whatever it sits on (pillar, wall rim, bed).
// Waves per turn are always n + 0.5, so each turn's peaks sit over the
// troughs of the turn below: the heights average out and the wall grows
// level, while the surface shows an interlocking (knit / brick) texture.
// Usage (from claude_3d/):
//   node scripts/make_3d.mjs ../sewingeditor/texture-actions/texture_functions.js <piece> <out.gcode>
//   piece = tube | beehive | garden | cactus
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [, , libPath, PIECE, outPath] = process.argv;
const copy = join(dirname(fileURLToPath(import.meta.url)), "tf_copy.mjs");
writeFileSync(copy, readFileSync(libPath, "utf8") + "\nexport { brushVariableThickness, restOfPath, brushPetalDot };\n");
const TF = await import(pathToFileURL(copy).href + `?t=${Date.now()}`);
const { Emitter, samplePath, totalLength, brushVariableThickness, restOfPath, brushPetalDot } = TF;

const TAU = 2 * Math.PI, D2R = Math.PI / 180;
const CX = 110, CY = 110; // every piece is centred on the bed
const em = new Emitter();
em.z = 0; em.retracted = true;
let topMax = 0; // tallest printed point so far (absolute)

// ---------------------------------------------------------- stacking ----
/** Run `emit()` (brush calls written as if on the bed), then raise every Z
 * it wrote by baseAt(x, y) -- the surface under that point. onPrint(x0, y0,
 * x1, y1, zTop, sAlong) is told about each extruding segment, so the caller
 * can record the new top surface. */
function stack(emit, baseAt, onPrint = () => {}) {
  const from = em.lines.length;
  emit();
  let x = em._x ?? null, y = em._y ?? null, s = 0;
  for (let i = from; i < em.lines.length; i++) {
    const l = em.lines[i];
    if (!/^G[01] /.test(l)) continue;
    const mx = l.match(/X(-?[\d.]+)/), my = l.match(/Y(-?[\d.]+)/), mz = l.match(/Z(-?[\d.]+)/), me = l.match(/E(-?[\d.]+)/);
    const nx = mx ? +mx[1] : x, ny = my ? +my[1] : y;
    if (mz) {
      const z = +mz[1] + baseAt(nx, ny, s);
      em.lines[i] = l.replace(/Z-?[\d.]+/, `Z${z.toFixed(3)}`);
      topMax = Math.max(topMax, me && +me[1] > 0 ? z : 0, topMax);
      if (me && +me[1] > 0 && mx && x != null) {
        const ds = Math.hypot(nx - x, ny - y);
        onPrint(x, y, nx, ny, z, s, s + ds);
        s += ds;
      }
    }
    x = nx; y = ny;
  }
  em._x = x; em._y = y;
}
/** Retract, rise above everything printed, travel, so no travel crosses
 * the structure. The brush then does its own short hop and descent. */
function travel(x, y) {
  em.retract();
  const z = topMax + 2;
  em.a(`G1 Z${z.toFixed(3)} F3000`);
  em.a(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
  em._x = x; em._y = y;
  em.z = 0; // brush Z is relative; stack() adds the base
}

/** Angle-indexed top surface of a wall around (cx, cy). */
class Ring {
  constructor(n = 1440) { this.n = n; this.z = new Float64Array(n); this.queue = []; }
  bin(x, y) { return ((Math.round((Math.atan2(y - CY, x - CX) / TAU) * this.n) % this.n) + this.n) % this.n; }
  at(x, y) { return this.z[this.bin(x, y)]; }
  max(x, y, halfBins) { const b = this.bin(x, y); let m = 0; for (let k = -halfBins; k <= halfBins; k++) m = Math.max(m, this.z[(b + k + this.n) % this.n]); return m; }
  /** queue a printed segment; applied once the stroke is `lag` mm past it */
  push(x0, y0, x1, y1, z, s1) { this.queue.push([x0, y0, x1, y1, z, s1]); }
  flush(sNow, lag) {
    while (this.queue.length && this.queue[0][5] < sNow - lag) {
      const [x0, y0, x1, y1, z] = this.queue.shift();
      let b0 = this.bin(x0, y0), b1 = this.bin(x1, y1);
      let d = b1 - b0; if (d > this.n / 2) d -= this.n; if (d < -this.n / 2) d += this.n;
      const k = Math.sign(d) || 1;
      for (let j = 0; j !== d + k; j += k) this.z[(b0 + j + this.n) % this.n] = z;
    }
  }
}

/** One continuous helical wall, wave after wave (brushVariableThickness).
 * r(u) = radius at fraction u of the way up; `waves` per turn. Each wave
 * spans exactly 1/waves of a turn (its wavelength is the arc length of that
 * angle), so waves never drift round the wall. o(u, turn) -> per-wave brush
 * options. The first turn ramps up from 35 % height, so the helix has no
 * step where each turn begins. */
function helixWall({ turns, r, waves, o }) {
  const tEnd = TAU * turns, step = 0.004;
  const pts = samplePath((t) => CX + r(t / tEnd) * Math.cos(t), (t) => CY + r(t / tEnd) * Math.sin(t), 0, tEnd, { step });
  const L = totalLength(pts), ring = new Ring();
  const tAt = (s) => { let lo = 0, hi = pts.length - 1; while (lo < hi - 1) { const m = (lo + hi) >> 1; if (pts[m][2] <= s) lo = m; else hi = m; } const [, , s0] = pts[lo], [, , s1] = pts[hi]; return Math.min(tEnd, (lo + (s1 > s0 ? (s - s0) / (s1 - s0) : 0)) * step); };
  const sAt = (t) => { const i = Math.min(pts.length - 2, Math.floor(t / step)), fr = t / step - i; return pts[i][2] + fr * (pts[i + 1][2] - pts[i][2]); };
  em.newPattern();
  let s = 0;
  stack(() => {
    while (L - s > 1e-6) {
      const t = tAt(s), turn = Math.floor(t / TAU + 1e-6), u = s / L;
      const opt = { volRate: 4.0, stepsPerWave: 24, ...o(u, turn) };
      opt.wavelength = t + TAU / waves >= tEnd - 1e-9 ? L - s : sAt(t + TAU / waves) - s;
      if (!(opt.wavelength > 1e-6)) break;
      if (turn === 0) { const k = 0.35 + 0.65 * (t / TAU); opt.hMin *= k; opt.hMax *= k; }
      const used = brushVariableThickness(em, restOfPath(pts, s), opt);
      if (!(used > 0)) break;
      s += used;
    }
    em.retract();
  }, (x, y, sNow) => { ring.flush(sNow, Math.PI * r(sNow / L)); return x == null ? 0 : ring.at(x, y); },
     (x0, y0, x1, y1, z, s0, s1) => ring.push(x0, y0, x1, y1, z, s1));
  ring.flush(Infinity, 0);
  return ring;
}

/** One petal dot sitting on `base` (absolute Z of the surface under it). */
function dotOn(x, y, base, opt) {
  travel(x, y);
  em.newPattern();
  let top = 0;
  stack(() => brushPetalDot(em, x, y, { extrudeSpeed: 150, dragSpeed: 600, ...opt }), () => base);
  top = base + opt.height;
  topMax = Math.max(topMax, top);
  return top;
}

// ------------------------------------------------------------- pieces ----
const PIECES = {
  // KNIT TUBE -- one fixed brush setting the whole way (what the stock
  // strokeVariableThickness would print) on a 40-turn helix of radius 15.
  // 12.5 waves per turn: every turn's bumps fall between the bumps below,
  // so the outside reads as knitted stitches and the top stays level.
  tube() {
    em.a("; brushVariableThickness every wave: hMin 0.25 hMax 0.65 beadWidth 1.0 peak 0.5 volRate 4.0, 12.5 waves per turn (wavelength 7.540)");
    helixWall({ turns: 40, r: () => 15, waves: 12.5, o: () => ({ hMin: 0.25, hMax: 0.65, beadWidth: 1.0 }) });
  },

  // HERRINGBONE BEEHIVE -- a dome: the radius shrinks 18 -> 5 mm over 36
  // turns (at most 0.57 mm inward per turn, under half the 1.2 mm bead, so
  // each turn sits mostly on the one below). 9 waves per turn. Even turns
  // lean their waves forward (peak 0.25: steep rise, long tail); odd turns
  // print the exact complement -- peak 0.75, shifted 0.25 of a wave so its
  // trough sits under the even turn's crest. A wave and its complement add up
  // to a level layer, so the dome grows evenly while the leans alternate turn
  // by turn into a herringbone. The waves get taller towards the top.
  beehive() {
    em.a("; brushVariableThickness per wave: beadWidth 1.2, hMin 0.25, hMax 0.6 -> 0.8 going up, 9 waves per turn");
    em.a(";   even turns: peak 0.25 phase 0 | odd turns: peak 0.75 phase -0.25 (the complement)");
    helixWall({ turns: 36, r: (u) => 18 - 13 * Math.sin((u * Math.PI) / 2), waves: 9,
      o: (u, turn) => ({ hMin: 0.25, hMax: 0.6 + 0.2 * u, beadWidth: 1.2, ...(turn % 2 ? { peak: 0.75, phase: -0.25 } : { peak: 0.25, phase: 0 }) }) });
  },

  // SPIKE GARDEN -- petal dots only. A 7 x 7 grid of pillars, 6 mm apart;
  // each pillar is a stack of dots, as many as a hill-shaped height map
  // asks for (1 at the corners, 14 in the middle). Up a pillar the dots
  // shrink (3.2 -> 1.4 mm) so it tapers to a spike, and each dot's drag
  // turns 40 deg from the one below so the tails twist round the spike.
  // Printed level by level across all pillars: each dot cools while the
  // others print.
  garden() {
    const n = 7, pitch = 6, H = 0.7, pillars = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = CX + (i - (n - 1) / 2) * pitch, y = CY + (j - (n - 1) / 2) * pitch;
      const d2 = ((x - CX) ** 2 + (y - CY) ** 2) / 100;
      const count = Math.max(1, Math.round(1 + 13 * Math.exp(-d2 / 2.2) + 1.5 * Math.cos((x - CX) * 0.6) * Math.cos((y - CY) * 0.6)));
      pillars.push({ x, y, count, top: 0, i, j });
    }
    const maxN = Math.max(...pillars.map((p) => p.count));
    for (let k = 0; k < maxN; k++) {
      const diameter = 3.2 - 1.8 * (k / (maxN - 1));
      em.a(`; level ${k + 1}: brushPetalDot  diameter ${diameter.toFixed(2)} height ${H} dragMm 0.8 azimuthDeg ${(40 * k) % 360} extrudeSpeed 150 dragSpeed 600`);
      const row = pillars.filter((p) => p.count > k).sort((a, b) => (a.i - b.i) || ((a.i % 2 ? -1 : 1) * (a.j - b.j)));
      for (const p of row) p.top = dotOn(p.x, p.y, p.top, { diameter, height: H, dragMm: 0.8, azimuthDeg: 40 * k });
    }
  },

  // CROWNED CACTUS -- both brushes. A ribbed column (radius 9, 7.5 waves per
  // turn, tall 0.3 -> 0.9 waves, symmetric) for 30 turns; then on its rim a
  // crown of 8 tapering petal-dot spikes, 5 dots each, dragged outward so
  // the tips flare; then a ring of petal-dot pebbles on the bed round its
  // foot, tails pointing away from the column.
  cactus() {
    em.a("; brushVariableThickness per wave: hMin 0.3 hMax 0.9 beadWidth 1.2 peak 0.5, 7.5 waves per turn (wavelength = 2*pi*9 / 7.5)");
    const ring = helixWall({ turns: 30, r: () => 9, waves: 7.5, o: () => ({ hMin: 0.3, hMax: 0.9, beadWidth: 1.2, peak: 0.5 }) });
    const spikes = [...Array(8).keys()].map((k) => {
      const a = (k * 45 + 22.5) * D2R, x = CX + 9 * Math.cos(a), y = CY + 9 * Math.sin(a);
      return { a, x, y, top: ring.max(x, y, 16) };
    });
    for (let lv = 0; lv < 5; lv++) {
      const diameter = 2.6 - 0.3 * lv, drag = 0.6 + 0.3 * lv;
      em.a(`; crown level ${lv + 1}: brushPetalDot  diameter ${diameter.toFixed(2)} height 0.7 dragMm ${drag.toFixed(1)} azimuthDeg = outward extrudeSpeed 150 dragSpeed 600`);
      for (const p of spikes) p.top = dotOn(p.x, p.y, p.top, { diameter, height: 0.7, dragMm: drag, azimuthDeg: p.a / D2R });
    }
    em.a("; pebbles: brushPetalDot  diameter 3.0 / 2.0 alternating, height 1.0, dragMm 2.5 / 1.5, azimuthDeg = outward");
    for (let k = 0; k < 16; k++) {
      const a = (k * 22.5) * D2R, big = k % 2 === 0, rr = big ? 14 : 13;
      dotOn(CX + rr * Math.cos(a), CY + rr * Math.sin(a), 0, { diameter: big ? 3.0 : 2.0, height: 1.0, dragMm: big ? 2.5 : 1.5, azimuthDeg: a / D2R });
    }
  },
};

const TITLES = {
  tube: "knit tube -- one fixed variable-thickness wave on a 40-turn helix, 12.5 waves per turn",
  beehive: "herringbone beehive -- a dome of brushVariableThickness waves leaning one way, then the other (peak 0.25 / 0.75)",
  garden: "spike garden -- 49 pillars of stacked petal dots, tapering and twisting",
  cactus: "crowned cactus -- ribbed variable-thickness column, petal-dot crown and pebbles",
};
if (!PIECES[PIECE]) throw new Error(`piece must be one of ${Object.keys(PIECES).join(", ")}`);
PIECES[PIECE]();
em.retract();

const out = [
  `; ${TITLES[PIECE]}`,
  "; 3D structure built from the texture brushes, centred at X110 Y110; PLA",
  "; assumes the printer is heated and homed (like the page's run once); no prime line",
  "G90", "M83", "M221 S100", "M106 S255 ; part fan on (PLA)",
  ...em.lines,
  "G91", "G1 Z10.000 F3000", "G90", "M107",
];
writeFileSync(outPath, out.join("\n") + "\n");

// report: size, height, filament, extrusion time
let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zMax = 0, vol = 0;
for (const l of em.lines) {
  const me = l.match(/E(-?[\d.]+)/);
  if (!/^G1 /.test(l) || !me || +me[1] <= 0 || !/X/.test(l)) continue;
  vol += +me[1];
  const mx = l.match(/X(-?[\d.]+)/), my = l.match(/Y(-?[\d.]+)/), mz = l.match(/Z(-?[\d.]+)/);
  if (mx) { x0 = Math.min(x0, +mx[1]); x1 = Math.max(x1, +mx[1]); }
  if (my) { y0 = Math.min(y0, +my[1]); y1 = Math.max(y1, +my[1]); }
  if (mz) zMax = Math.max(zMax, +mz[1]);
}
const mm3 = vol * Math.PI * 0.875 ** 2;
console.log(JSON.stringify({ piece: PIECE, lines: out.length, x: [+x0.toFixed(1), +x1.toFixed(1)], y: [+y0.toFixed(1), +y1.toFixed(1)], zMax: +Math.max(zMax, topMax).toFixed(2), filamentMm: +vol.toFixed(0), mm3: +mm3.toFixed(0), extrudeMin: +(mm3 / 4 / 60).toFixed(1) }));
