// Variable-thickness sheet: nine graphics made only with brushVariableThickness
// (one cosine wave of bead height per call), where every wave can have its own
// wavelength, hMin/hMax, beadWidth, phase and the gap after it.
// The brush is the unchanged one from texture_functions.js, loaded from a copy
// with the brush and restOfPath exported.
// Usage (from claude_variableThickness/):
//   node scripts/make_vt_sheet.mjs ../sewingeditor/texture-actions/texture_functions.js vt-sheet.gcode
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [, , libPath, outPath] = process.argv;
const copy = join(dirname(fileURLToPath(import.meta.url)), "tf_copy.mjs");
writeFileSync(copy, readFileSync(libPath, "utf8") + "\nexport { brushVariableThickness, restOfPath, brushPetalDot };\n");
const TF = await import(pathToFileURL(copy).href + `?t=${Date.now()}`);
const { Emitter, samplePath, polylineToPts, totalLength, pointAtArcLength, brushVariableThickness, restOfPath, brushPetalDot } = TF;

const D2R = Math.PI / 180, TAU = 2 * Math.PI;
const SAFE_Z = 5;
const em = new Emitter();
em.z = 10; em.retracted = true;

// ------------------------------------------------------------- building --
/** A stroke whose every wave can differ. f(i, s, frac) -> { wavelength, hMin,
 * hMax, beadWidth, phase, stepsPerWave, gap } for the wave starting at arc
 * length s; `gap` is blank space AFTER this wave (lifted over, then primed).
 * Mirrors strokeVariableThickness: brush wave by wave, retract across gaps. */
function waveVar(pts, f, s0 = 0) {
  const L = totalLength(pts);
  em.newPattern();
  let s = s0, prevGap = 0;
  for (let i = 0; L - s > 1e-6; i++) {
    const { gap = 0, ...o } = f(i, s, L > 0 ? s / L : 0);
    const used = brushVariableThickness(em, restOfPath(pts, s), { volRate: 4.0, stepsPerWave: 25, ...o, gapLen: prevGap });
    if (!(used > 0)) break;
    s += used + gap;
    prevGap = gap;
    if (gap > 0 && L - s > 1e-6) em.retract();
  }
  em.retract();
}
/** One petal dot (brushPetalDot, unchanged): blob of diameter d at height h,
 * then a drag of `drag` mm toward absolute angle az (deg, CCW from +X). */
function dot(x, y, { d = 2, h = 1, drag = 2, az = 0 } = {}) {
  em.newPattern();
  brushPetalDot(em, x, y, { diameter: d, height: h, dragMm: Math.max(0.6, drag), azimuthDeg: az, extrudeSpeed: 150, dragSpeed: 600 });
}
const line = (a, b) => polylineToPts([a, b], 0.05);
const curve = (fx, fy, t0, t1, step = 0.002) => samplePath(fx, fy, t0, t1, { step });
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- pieces --

// A. AM / FM SWATCH -- the radio idea in plastic. Top four rows: frequency
// modulation, the wavelength sweeps 12 -> 3 mm along the row (a tactile
// chirp), each row a little taller. Bottom four: amplitude modulation, a
// fixed 5 mm wave whose peak height swells 0.3 -> 1.4 -> 0.3 mm, each row a
// little wider.
function amfm(cx, cy) {
  for (let r = 0; r < 8; r++) {
    const y = cy + 15 - r * 4.3;
    const P = line([cx - 25, y], [cx + 25, y]);
    if (r < 4) {
      const hMax = [0.5, 0.8, 1.1, 1.4][r];
      waveVar(P, (i, s, f) => ({ wavelength: lerp(12, 3, f), hMin: 0.24, hMax, beadWidth: 1.2 }));
    } else {
      const bw = [0.8, 1.4, 2.0, 2.6][r - 4];
      waveVar(P, (i, s, f) => ({ wavelength: 5, hMin: 0.24, hMax: 0.3 + 1.1 * Math.sin(Math.PI * Math.min(1, f + 0.05)), beadWidth: bw }));
    }
  }
}

// B. FAN OF RIDGES -- 18 fused rows; each row's wavelength is 4.5% longer
// than the one below (5 -> 10.5 mm). Peaks that start lined up drift apart
// row by row, so the bumps join into ridges that fan out across the patch:
// a pattern no single row has. Rows run back and forth; reversed rows get
// the phase that puts their peaks at the same X as a forward row would.
function fan(cx, cy) {
  const W = 50, rows = 18, sp = 1.7;
  for (let k = 0; k < rows; k++) {
    const lam = 5 * (1 + 0.045 * k), y = cy - ((rows - 1) * sp) / 2 + k * sp;
    const fwd = k % 2 === 0;
    const P = fwd ? line([cx - W / 2, y], [cx + W / 2, y]) : line([cx + W / 2, y], [cx - W / 2, y]);
    const phase = fwd ? 0 : (((-W / lam) % 1) + 1) % 1;
    waveVar(P, () => ({ wavelength: lam, hMin: 0.25, hMax: 1.0, beadWidth: 1.9, phase }));
  }
}

// C. SUNBURST FROM THICKNESS -- plain concentric rings, no spokes drawn.
// Every ring holds a whole number of waves starting at the same angle, so
// the peaks of all rings line up and radial ribs appear by themselves:
// 12 ribs inside, splitting into 24 in the outer rings.
function sunburst(cx, cy) {
  for (let r = 6; r <= 26; r += 2) {
    const N = r < 15 ? 12 : 24, lam = (TAU * r) / N;
    const P = curve((t) => cx + r * Math.cos(t), (t) => cy + r * Math.sin(t), 0, TAU, 0.002);
    waveVar(P, () => ({ wavelength: lam, hMin: 0.24, hMax: r < 15 ? 1.1 : 0.9, beadWidth: 1.7 }));
  }
}

// D. SPIRAL ARMS -- one Archimedean spiral (2 mm pitch, fused). The
// wavelength grows with the radius so each turn holds 5.2 waves: the extra
// 0.2 wave per turn makes the peaks drift, and they line up into five
// curved arms.
function spiralArms(cx, cy) {
  const k = 2.0 / TAU, th0 = 1.5 / k, th1 = 24 / k;
  const P = curve((t) => cx + k * t * Math.cos(t), (t) => cy + k * t * Math.sin(t), th0, th1, 0.002);
  waveVar(P, (i, s) => {
    const th = Math.sqrt((2 * s) / k + th0 * th0), r = k * th;
    return { wavelength: Math.max(1.8, (TAU * r) / 5.2), hMin: 0.25, hMax: 1.1, beadWidth: 1.8 };
  });
}

// E. WEAVE -- over-under lattice from height alone. Horizontal threads dip
// low (0.25 mm) at every other crossing and rise (0.9 mm) between. Vertical
// threads are printed second as single tall waves (1.35 mm) centred on the
// crossings where the horizontal dips, and lift over (gap) the crossings
// where the horizontal is high. Each thread alternates over / under, like
// cloth.
function weave(cx, cy) {
  const p = 4.5, n = 9, x0 = cx - ((n - 1) * p) / 2, y0 = cy - ((n - 1) * p) / 2;
  for (let i = 0; i < n; i++) {
    const y = y0 + i * p;
    waveVar(line([x0 - p, y], [x0 + n * p, y]), () => ({ wavelength: 2 * p, hMin: 0.25, hMax: 0.9, beadWidth: 1.4, phase: i % 2 ? 0.5 : 0 }));
  }
  for (let j = 0; j < n; j++) {
    const x = x0 + j * p;
    const over = [...Array(n).keys()].filter((i) => (i + j) % 2 === 1);
    const seg = 1.2 * p, first = y0 + over[0] * p - seg / 2, last = y0 + over.at(-1) * p + seg / 2;
    waveVar(line([x, first], [x, last]), () => ({ wavelength: seg, hMin: 0.3, hMax: 1.35, beadWidth: 1.4, gap: 2 * p - seg }));
  }
}

// F. RELIEF -- a 2.5D height map printed as fused raster rows. Each "wave"
// is a 1.5 mm step with hMin = hMax, so the bead holds one height there:
// the rows build a dome with ripples rolling out from the centre, like a
// drop in a pond, 0.3 -> 1.3 mm.
function relief(cx, cy) {
  const R = 24, sp = 1.1;
  const H = (x, y) => {
    const r = Math.hypot(x, y), d = Math.min(1, r / R);
    return 0.3 + 0.55 * (1 - d * d) + 0.45 * (1 - d) * 0.5 * (1 + Math.cos((TAU * r) / 6));
  };
  let row = 0;
  for (let y = -R + 0.5; y <= R - 0.5; y += sp, row++) {
    const hw = Math.sqrt(R * R - y * y) - 0.6;
    if (hw < 1.5) continue;
    const a = [cx - hw, cy + y], b = [cx + hw, cy + y];
    const [A, B] = row % 2 ? [b, a] : [a, b];
    const ux = (B[0] - A[0]) / (2 * hw);
    waveVar(line(A, B), (i, s) => {
      const h = H(A[0] + ux * (s + 0.75) - cx, y);
      return { wavelength: 1.5, hMin: h, hMax: h, beadWidth: 1.3, stepsPerWave: 2 };
    });
  }
}

// G. MORSE "TPU" -- one letter per row; a dot is one short, wide, tall wave
// (5 mm, 2.8 mm wide, 1.3 mm high) and a dash one long, narrow, low wave
// (14 mm, 1.6 mm wide, 0.8 mm high), with 4 mm lifted gaps between symbols. Each
// brush call is one symbol you can read with a fingertip.
function morse(cx, cy) {
  const DOT = { wavelength: 5, hMin: 0.3, hMax: 1.3, beadWidth: 2.8 };
  const DASH = { wavelength: 14, hMin: 0.3, hMax: 0.8, beadWidth: 1.6 };
  const letters = [["T", "-"], ["P", ".--."], ["U", "..-"]];
  letters.forEach(([, code], r) => {
    const syms = [...code].map((c) => (c === "." ? DOT : DASH)), g = 4;
    const len = syms.reduce((a, o) => a + o.wavelength, 0) + g * (syms.length - 1);
    const y = cy + 18 - r * 18;
    waveVar(line([cx - len / 2, y], [cx + len / 2, y]), (i) => ({ ...syms[i], gap: i < syms.length - 1 ? g : 0 }));
  });
}

// H. NECKLACE -- two closed loops strung with alternating pearls (4.2 mm
// waves, 2.8 mm wide, 1.3 mm high) and thin spacers (2.2 mm, 1.0 mm wide,
// 0.45 mm high). Outer loop is a five-lobed flower, inner a plain circle
// with smaller pearls. Width and height change from wave to wave.
function necklace(cx, cy) {
  const pearl = (i, big) => (i % 2 === 0
    ? { wavelength: big ? 4.2 : 3.2, hMin: 0.3, hMax: big ? 1.3 : 1.0, beadWidth: big ? 2.8 : 2.2 }
    : { wavelength: 2.2, hMin: 0.3, hMax: 0.45, beadWidth: 1.0 });
  waveVar(curve((t) => cx + (21 + 4 * Math.cos(5 * t)) * Math.cos(t), (t) => cy + (21 + 4 * Math.cos(5 * t)) * Math.sin(t), 0, TAU), (i) => pearl(i, true));
  waveVar(curve((t) => cx + 10 * Math.cos(t), (t) => cy + 10 * Math.sin(t), 0, TAU), (i) => pearl(i, false));
}

// I. WHEAT -- five stalks fanning from the base. The stem is one long gentle
// wave (thin, 0.25 -> 0.6 mm); the ear is a run of grains, short tall waves
// that shrink toward the tip (2.4 -> 1.4 mm wide). Two leaves are each a
// single wave the length of the leaf: thin at both ends, full in the middle.
function wheat(cx, cy) {
  const stalks = [[-6, -24], [-3, -12], [0, 0], [3, 12], [6, 24]]; // base x, tip angle offset (deg)
  for (const [bx, da] of stalks) {
    const a = (90 - da) * D2R, Lst = 52 - Math.abs(da) * 0.2;
    const A = [cx + bx, cy - 27], B = [A[0] + Lst * Math.cos(a), A[1] + Lst * Math.sin(a)];
    const C = [(A[0] + B[0]) / 2 + da * 0.12, (A[1] + B[1]) / 2];
    const bz = (t, k) => (1 - t) ** 2 * A[k] + 2 * (1 - t) * t * C[k] + t * t * B[k];
    const P = curve((t) => bz(t, 0), (t) => bz(t, 1), 0, 1, 0.001);
    const L = totalLength(P), stem = 0.6 * L;
    waveVar(P, (i, s) => {
      if (s < stem - 1e-6) return { wavelength: stem, hMin: 0.25, hMax: 0.6, beadWidth: 1.0 };
      const f = (s - stem) / (L - stem);
      return { wavelength: 2.8, hMin: 0.3, hMax: lerp(1.15, 0.7, f), beadWidth: lerp(2.4, 1.4, f) };
    });
  }
  for (const side of [-1, 1]) {
    const A = [cx + side * 9, cy - 25], B = [cx + side * 25, cy - 8], C = [cx + side * 22, cy - 24];
    const bz = (t, k) => (1 - t) ** 2 * A[k] + 2 * (1 - t) * t * C[k] + t * t * B[k];
    const P = curve((t) => bz(t, 0), (t) => bz(t, 1), 0, 1, 0.001);
    waveVar(P, () => ({ wavelength: totalLength(P), hMin: 0.2, hMax: 1.0, beadWidth: 1.8 }));
  }
}

// ==================== TWO-BRUSH SHEET (vt-extras.gcode): X 10-200, Y 140-220
// Ten graphics that use both brushes. Rules that keep them printable:
//  - petal dots only on bare bed, never on a variable-thickness bead (the
//    drag ends at Z 0 and would plow through it);
//  - before every stroke or dot group the nozzle lifts to Z 2 (CLEAR), so
//    travel never clips a blob (~1 mm) or a bead (up to 1.3 mm).
const CLEAR = 2.0;
function lift() { em.retract(); if (em.z < CLEAR) { em.a(`G1 Z${CLEAR.toFixed(3)} F3000`); em.z = CLEAR; } }
const wv = (pts, f, s0) => { lift(); waveVar(pts, f, s0); };
const pd = (x, y, o) => { lift(); dot(x, y, o); };
const bezier = (A, C, B) => { const bz = (t, k) => (1 - t) ** 2 * A[k] + 2 * (1 - t) * t * C[k] + t * t * B[k]; return curve((t) => bz(t, 0), (t) => bz(t, 1), 0, 1, 0.001); };

// T1. FIREWORK (full height, X24) -- the climb is one variable-thickness line
// rising 48 mm whose waves get shorter, taller and wider toward the top
// (wavelength 7 -> 2.5 mm, 0.5 -> 1.15 mm high, 1.0 -> 2.0 mm wide), so it
// feels like it is speeding up. Small petal dots peel off both sides as
// falling sparks. At the top it bursts: three rings of petal dots, every
// tail flung outward, each ring smaller-dotted and shorter-tailed.
function firework(cx) {
  wv(line([cx, 142], [cx, 190]), (i, s, f) => ({ wavelength: lerp(7, 2.5, f), hMin: 0.25, hMax: lerp(0.5, 1.15, f), beadWidth: lerp(1.0, 2.0, f) }));
  for (let k = 0; k < 7; k++) {
    const y = 148 + k * 6, side = k % 2 ? 1 : -1;
    pd(cx + side * 3.6, y, { d: lerp(1.2, 1.5, k / 6), drag: 1.8, az: side > 0 ? -55 : 235 });
  }
  const B = [cx, 205.5];
  [[4, 8, 1.9, 2.4, 22.5], [7.6, 12, 1.5, 2.0, 0], [11, 16, 1.2, 1.6, 11.25]].forEach(([r, n, d, drag, off]) => {
    for (let k = 0; k < n; k++) { const a = off + (360 * k) / n; pd(B[0] + r * Math.cos(a * D2R), B[1] + r * Math.sin(a * D2R), { d, drag, az: a }); }
  });
}

// T2. TULIP (full height, X187) -- stem and leaves are variable-thickness:
// the stem one long gentle wave, each leaf a single wave the length of the
// leaf (thin ends, full middle). The flower is petal dots: three chains
// (left, centre, right) of six, shrinking as they rise, tails chaining
// upward, so the cup reads as three raised petals.
function tulip(cx) {
  const S = curve((t) => cx + 2 * Math.sin(t * Math.PI), (t) => 142 + 54 * t, 0, 1, 0.001);
  wv(S, () => ({ wavelength: totalLength(S), hMin: 0.3, hMax: 0.8, beadWidth: 1.3 }));
  for (const [side, ya, yb] of [[-1, 147, 175], [1, 154, 182]]) {
    const P = bezier([cx + side * 1.8, ya], [cx + side * 12, ya + 3], [cx + side * 10, yb]);
    wv(P, () => ({ wavelength: totalLength(P), hMin: 0.2, hMax: 1.0, beadWidth: 2.0 }));
  }
  const head = 200, N = 6;
  const chains = [
    (t) => [-(2.8 + 5 * Math.sin(Math.PI * t * 0.75)), 1.2 + 13.5 * t],
    (t) => [0, 3 + 12 * t],
    (t) => [2.8 + 5 * Math.sin(Math.PI * t * 0.75), 1.2 + 13.5 * t],
  ];
  for (const c of chains) for (let i = 0; i < N; i++) {
    const [dx, dy] = c(i / (N - 1)), [nx, ny] = c(Math.min(1, (i + 1) / (N - 1)));
    const az = i < N - 1 ? Math.atan2(ny - dy, nx - dx) / D2R : 90 + dx * 4;
    pd(cx + dx, head + dy, { d: lerp(2.4, 1.5, i / (N - 1)), drag: i < N - 1 ? 2.2 : 1.5, az });
  }
}

// G1. CATERPILLAR -- the body is one wavy variable-thickness line whose
// waves are its segments (4.4 mm, 2.6 mm wide, 0.4 -> 1.2 mm high), the head
// a bigger last wave. Petal-dot legs hang below each segment with tails
// swept back, and two petal-dot antennae flick forward from the head.
function caterpillar(cx, cy) {
  const yb = (x) => cy + 3 * Math.sin((x - cx) / 6);
  const P = curve((x) => x, (x) => yb(x), cx - 13, cx + 9, 0.01);
  const L = totalLength(P);
  wv(P, (i, s) => (L - s < 6 ? { wavelength: 5.5, hMin: 0.4, hMax: 1.35, beadWidth: 3.0 } : { wavelength: 4.4, hMin: 0.4, hMax: 1.2, beadWidth: 2.6 }));
  for (let x = cx - 11; x <= cx + 3; x += 4.4) pd(x, yb(x) - 3.8, { d: 1.4, drag: 1.8, az: 215 });
  pd(cx + 10.5, yb(cx + 10.5) + 3.6, { d: 1.2, drag: 2.6, az: 50 });
  pd(cx + 13, yb(cx + 13) + 2.6, { d: 1.2, drag: 2.0, az: 25 });
}

// G2. SUN -- a variable-thickness spiral disc (2 mm pitch, 5.2 waves per turn,
// so faint arms swirl in it) ringed by petal-dot rays: long and short
// alternating, all flung outward.
function sun(cx, cy) {
  const k = 2.0 / TAU, th0 = 1.5 / k, th1 = 8 / k;
  const P = curve((t) => cx + k * t * Math.cos(t), (t) => cy + k * t * Math.sin(t), th0, th1, 0.002);
  wv(P, (i, s) => { const r = k * Math.sqrt((2 * s) / k + th0 * th0); return { wavelength: Math.max(1.8, (TAU * r) / 5.2), hMin: 0.3, hMax: 1.1, beadWidth: 1.8 }; });
  for (let n = 0; n < 16; n++) { const a = n * 22.5, long = n % 2 === 0; pd(cx + 11.5 * Math.cos(a * D2R), cy + 11.5 * Math.sin(a * D2R), { d: long ? 2.0 : 1.4, drag: long ? 3.0 : 1.8, az: a }); }
}

// G3. SNAIL -- a variable-thickness spiral shell whose waves grow with the
// radius, sitting on a body that is one long tapering wave (thin tail, full
// middle). Two petal-dot eye stalks are pulled up and forward from the head.
function snail(cx, cy) {
  const C = [cx - 3, cy + 3], k = 2.2 / TAU, th0 = 1 / k, th1 = 9 / k;
  const P = curve((t) => C[0] + k * t * Math.cos(t), (t) => C[1] + k * t * Math.sin(t), th0, th1, 0.002);
  wv(P, (i, s) => { const r = k * Math.sqrt((2 * s) / k + th0 * th0); return { wavelength: Math.max(1.8, (TAU * r) / 6), hMin: 0.3, hMax: lerp(0.7, 1.2, r / 9), beadWidth: 1.8 }; });
  const Bd = line([cx - 14, cy - 9.2], [cx + 11, cy - 9.2]);
  wv(Bd, () => ({ wavelength: totalLength(Bd), hMin: 0.3, hMax: 0.9, beadWidth: 2.2 }));
  pd(cx + 9.5, cy - 5.6, { d: 1.3, drag: 3.0, az: 75 });
  pd(cx + 12.2, cy - 5.9, { d: 1.3, drag: 3.0, az: 50 });
}

// G4. RAIN CLOUD -- the cloud is four fused variable-thickness rows of
// bumpy waves, longest in the middle, phases alternating so the bumps nest.
// Below it falls staggered rain: petal dots whose tails point up, so each
// reads as a drop (round head down), bigger drops lower down.
function rainCloud(cx, cy) {
  [[14, 20], [12.4, 27], [10.8, 28], [9.2, 23]].forEach(([dy, len], r) => {
    const y = cy + dy;
    wv(line([cx - len / 2, y], [cx + len / 2, y]), () => ({ wavelength: 4.5, hMin: 0.4, hMax: 1.1, beadWidth: 1.8, phase: r % 2 ? 0.5 : 0 }));
  });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
    const x = cx - 10 + c * 5 + (r % 2 ? 2.5 : 0), y = cy + 3 - r * 5.6;
    if (x > cx + 12) continue;
    pd(x, y, { d: lerp(1.2, 2.0, r / 3), drag: 2.4, az: 95 });
  }
}

// G5. PINE TREE -- a variable-thickness trunk (one tapering wave) with
// tiers of petal-dot needles either side, narrowing toward the top, every
// needle swept down and out like a drooping branch.
function pine(cx, cy) {
  const T = line([cx, cy - 18], [cx, cy + 15]);
  wv(T, () => ({ wavelength: totalLength(T), hMin: 0.3, hMax: 0.9, beadWidth: 1.8 }));
  for (let t = 0; t < 6; t++) {
    const y = cy - 10 + t * 4.5, n = 5 - Math.floor(t * 0.8);
    for (let j = 0; j < n; j++) for (const side of [-1, 1]) pd(cx + side * (2.8 + j * 2.4), y, { d: 1.6, drag: 2.2, az: side > 0 ? -70 : 250 });
  }
  pd(cx, cy + 17.2, { d: 1.6, drag: 1.2, az: 90 });
}

// G6. BUTTERFLY -- a variable-thickness body of three waves (long thin
// abdomen, short fat thorax, round head) with thin single-wave antennae;
// petal dots make the club tips and the wings: fans of rays chaining
// outward, big upper wings and smaller lower ones.
function butterfly(cx, cy) {
  const Bd = line([cx, cy - 12], [cx, cy + 8]);
  const seg = [{ wavelength: 12, hMin: 0.3, hMax: 0.9, beadWidth: 1.6 }, { wavelength: 5, hMin: 0.4, hMax: 1.2, beadWidth: 2.4 }, { wavelength: 3, hMin: 0.4, hMax: 1.0, beadWidth: 2.0 }];
  wv(Bd, (i) => seg[Math.min(i, 2)]);
  for (const side of [-1, 1]) {
    const A = line([cx + side * 0.9, cy + 9], [cx + side * 5.5, cy + 15.5]);
    wv(A, () => ({ wavelength: totalLength(A), hMin: 0.2, hMax: 0.5, beadWidth: 0.9 }));
    pd(cx + side * 6.4, cy + 16.6, { d: 1.4, drag: 1.0, az: side > 0 ? 55 : 125 });
    for (const a of [15, 32, 49, 66]) for (const [r, d] of [[4.6, 2.0], [8, 1.8], [11.3, 1.5]]) {
      const ang = side > 0 ? a : 180 - a;
      pd(cx + side * 1.5 + r * Math.cos(ang * D2R), cy + 1 + r * Math.sin(ang * D2R), { d, drag: 2.4, az: ang });
    }
    for (const a of [-20, -40, -60]) for (const [r, d] of [[4.6, 1.8], [7.8, 1.5]]) {
      const ang = side > 0 ? a : 180 - a;
      pd(cx + side * 1.5 + r * Math.cos(ang * D2R), cy - 1 + r * Math.sin(ang * D2R), { d, drag: 2.0, az: ang });
    }
  }
}

// G7. PEACOCK FEATHER -- a variable-thickness shaft (one thin tapering
// wave) ending in an eye of two whole-wave rings; petal-dot barbs sweep up
// and out along the shaft, and a halo of petal dots rings the eye.
function peacock(cx, cy) {
  const S = curve((t) => cx - 2 + 4 * t * t, (t) => cy - 18 + 21 * t, 0, 1, 0.001);
  wv(S, () => ({ wavelength: totalLength(S), hMin: 0.3, hMax: 0.8, beadWidth: 1.2 }));
  const E = [cx + 2, cy + 8.2];
  for (const [r, N] of [[2, 4], [4.2, 8]]) {
    const R = curve((t) => E[0] + r * Math.cos(t), (t) => E[1] + r * Math.sin(t), 0, TAU, 0.002);
    wv(R, () => ({ wavelength: (TAU * r) / N, hMin: 0.3, hMax: 1.1, beadWidth: 1.4 }));
  }
  for (let y = cy - 14; y <= cy - 1; y += 2.6) {
    const t = (y - (cy - 18)) / 21, sx = cx - 2 + 4 * t * t;
    pd(sx - 2.6, y, { d: 1.5, drag: 3.0, az: 135 });
    pd(sx + 2.6, y, { d: 1.5, drag: 3.0, az: 45 });
  }
  for (let n = 0; n < 16; n++) {
    const a = n * 22.5;
    if (a > 215 && a < 325) continue; // leave room for the shaft
    pd(E[0] + 7 * Math.cos(a * D2R), E[1] + 7 * Math.sin(a * D2R), { d: 1.3, drag: 2.0, az: a });
  }
}

// G8. HEDGEHOG -- the body is a half-dome of fused variable-thickness rows
// with small bumpy waves (furry), the snout one tapering wave; petal-dot
// spines fan out around the back, plus a nose and two little feet.
function hedgehog(cx, cy) {
  const C = [cx, cy - 8], R = 11;
  for (let k = 0; k < 9; k++) {
    const dy = 0.6 + k * 1.2, hw = R * Math.sqrt(1 - (dy / R) ** 2) - 0.7, y = C[1] + dy;
    const [A, B] = k % 2 ? [[C[0] + hw, y], [C[0] - hw, y]] : [[C[0] - hw, y], [C[0] + hw, y]];
    wv(line(A, B), () => ({ wavelength: 3, hMin: 0.4, hMax: 0.8, beadWidth: 1.4, phase: k % 2 ? 0.5 : 0 }));
  }
  const Sn = line([C[0] + 10.3, C[1] + 1.4], [C[0] + 13.0, C[1] + 2.2]);
  wv(Sn, () => ({ wavelength: totalLength(Sn), hMin: 0.3, hMax: 0.9, beadWidth: 1.6 }));
  pd(C[0] + 14.4, C[1] + 2.5, { d: 1.4, drag: 0.8, az: 10 });
  for (let a = 40; a <= 160; a += 10) pd(C[0] + 13.5 * Math.cos(a * D2R), C[1] + 13.5 * Math.sin(a * D2R), { d: 1.6, drag: 2.5, az: a });
  for (const fx of [-5, 4]) pd(C[0] + fx, C[1] - 2.6, { d: 1.6, drag: 1.5, az: 270 });
}

// ------------------------------------------------------------------ layout --
// 3 x 3 grid, 70 mm cells; printed in a snake so moves stay short.
// Third argument picks the sheet: "base" (default) = the nine variable-
// thickness graphics (vt-sheet.gcode); "extras" = the ten two-brush graphics
// in X 10-200, Y 140-220 (vt-extras.gcode), a separate sheet.
const MODE = process.argv[4] ?? "base";
if (!["base", "extras"].includes(MODE)) throw new Error(`mode must be base or extras (got ${MODE})`);
const G = [40, 110, 180], HALF = 33;
const BASE = [
  ["AM/FM swatch", amfm, G[0], G[0]], ["fan of ridges", fan, G[1], G[0]], ["sunburst", sunburst, G[2], G[0]],
  ["spiral arms", spiralArms, G[2], G[1]], ["weave", weave, G[1], G[1]], ["relief", relief, G[0], G[1]],
  ["Morse TPU", morse, G[0], G[2]], ["necklace", necklace, G[1], G[2]], ["wheat", wheat, G[2], G[2]],
];
// Two-brush sheet, X 10-200 x Y 140-220: a full-height column at each end,
// and a 4 x 2 grid of 34 x 40 mm cells between (X 38-174). box = where every
// printed mark (bead width, blob size and drags included) must stay.
const GX = [55, 89, 123, 157], GY = [160, 200];
const cell = (cx, cy) => ({ x0: cx - 16.5, x1: cx + 16.5, y0: cy - 19.6, y1: cy + 19.6 });
const EXTRAS = [
  ["firework", (cx) => firework(cx), 24, 180, { x0: 10, x1: 38, y0: 140, y1: 220 }],
  ["caterpillar", caterpillar, GX[0], GY[0], cell(GX[0], GY[0])], ["sun", sun, GX[1], GY[0], cell(GX[1], GY[0])],
  ["snail", snail, GX[2], GY[0], cell(GX[2], GY[0])], ["rain cloud", rainCloud, GX[3], GY[0], cell(GX[3], GY[0])],
  ["hedgehog", hedgehog, GX[3], GY[1], cell(GX[3], GY[1])], ["peacock feather", peacock, GX[2], GY[1], cell(GX[2], GY[1])],
  ["butterfly", butterfly, GX[1], GY[1], cell(GX[1], GY[1])], ["pine tree", pine, GX[0], GY[1], cell(GX[0], GY[1])],
  ["tulip", (cx) => tulip(cx), 187, 180, { x0: 174, x1: 200, y0: 140, y1: 220 }],
];
const PIECES = MODE === "base" ? BASE : EXTRAS;

/** Printed marks of a slice of G-code, as discs {x, y, r}: bead segments at
 * their width, petal blobs at their size, petal drags as thin tails. */
function marks(slice) {
  const out = []; let x = null, y = null, z = 0;
  for (const l of slice) {
    if (!/^G[01] /.test(l)) continue;
    const m = Object.fromEntries([...l.matchAll(/([XYZE])(-?[\d.]+)/g)].map((r) => [r[1], +r[2]]));
    const nx = m.X ?? x, ny = m.Y ?? y, nz = m.Z ?? z;
    if (x != null && (m.E ?? 0) > 0 && m.X != null) {
      const L = Math.hypot(nx - x, ny - y);
      if (L < 1e-6) out.push({ x: nx, y: ny, r: Math.sqrt((m.E * TF.FIL_AREA) / (0.75 * Math.PI * Math.max(0.3, z))) }); // petal blob
      else { const w = (m.E * TF.FIL_AREA) / (L * Math.max(0.05, (z + nz) / 2)); out.push({ x: nx, y: ny, r: Math.min(2, w / 2) }); }
    } else if (l.startsWith("G0") && m.Z === 0 && x != null) { // petal drag: thin tail
      for (let t = 0; t <= 1; t += 0.25) out.push({ x: x + (nx - x) * t, y: y + (ny - y) * t, r: 0.5 });
    }
    x = nx; y = ny; z = nz;
  }
  return out;
}

const report = [], allMarks = [];
let volume = 0;
for (const [name, fn, cx, cy, box] of PIECES) {
  em.retract();
  em.a(`G1 Z${SAFE_Z.toFixed(3)} F3000`); em.z = SAFE_Z;
  em.a(`; --- ${name} at X${cx} Y${cy} ---`);
  const from = em.lines.length, e0 = em.eTotal;
  fn(cx, cy);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zMax = 0, waves = 0;
  for (const l of em.lines.slice(from)) {
    const mx = l.match(/X(-?[\d.]+)/), my = l.match(/Y(-?[\d.]+)/), mz = l.match(/^G1 X.* Z(-?[\d.]+) E/);
    if (mx) { x0 = Math.min(x0, +mx[1]); x1 = Math.max(x1, +mx[1]); }
    if (my) { y0 = Math.min(y0, +my[1]); y1 = Math.max(y1, +my[1]); }
    if (mz) zMax = Math.max(zMax, +mz[1]);
  }
  const mine = marks(em.lines.slice(from));
  const ex = mine.reduce((b, p) => ({ x0: Math.min(b.x0, p.x - p.r), x1: Math.max(b.x1, p.x + p.r), y0: Math.min(b.y0, p.y - p.r), y1: Math.max(b.y1, p.y + p.r) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  const inCell = box
    ? ex.x0 >= box.x0 && ex.x1 <= box.x1 && ex.y0 >= box.y0 && ex.y1 <= box.y1
    : x0 >= cx - HALF && x1 <= cx + HALF && y0 >= cy - HALF && y1 <= cy + HALF;
  const onBed = x0 >= 5 && y0 >= 5 && x1 <= 215 && y1 <= (box ? 220 : 215);
  // clash: the closest edge-to-edge distance to anything printed before (needs >= 0.8 mm)
  let clear = Infinity;
  for (const p of mine) for (const q of allMarks) {
    if (Math.abs(p.x - q.x) > 6 || Math.abs(p.y - q.y) > 6) continue;
    clear = Math.min(clear, Math.hypot(p.x - q.x, p.y - q.y) - p.r - q.r);
  }
  allMarks.push(...mine);
  const mm3 = (em.eTotal - e0) * TF.FIL_AREA;
  volume += mm3;
  report.push({ name, at: [cx, cy], x: [+ex.x0.toFixed(1), +ex.x1.toFixed(1)], y: [+ex.y0.toFixed(1), +ex.y1.toFixed(1)], zMax, plasticMm3: Math.round(mm3), clearMm: clear === Infinity ? null : +clear.toFixed(2) });
  if (!inCell || !onBed) throw new Error(`${name} leaves its ${box ? "box" : "cell"} or the bed: ${JSON.stringify(report.at(-1))}`);
  if (box && clear < 0.8) throw new Error(`${name} clashes with an earlier piece: ${JSON.stringify(report.at(-1))}`);
}
em.retract();

const lines = [
  ...{
    base: ["; variable-thickness sheet -- nine graphics, brushVariableThickness called wave by wave (NEW sheet)",
      "; 3 x 3 grid, centres X/Y 40 110 180 -- Y40: AM/FM swatch, fan of ridges, sunburst | Y110: relief, weave, spiral arms | Y180: Morse TPU, necklace, wheat"],
    extras: ["; two-brush sheet -- ten graphics using both brushVariableThickness and brushPetalDot, all within X 10-200, Y 140-220 (separate sheet)",
      "; firework X24 (full height) | Y160: caterpillar X55, sun X89, snail X123, rain cloud X157 | Y200: pine X55, butterfly X89, peacock X123, hedgehog X157 | tulip X187 (full height)",
      "; petal dots only on bare bed; lifts to Z2 before every stroke or dot group"],
  }[MODE],
  "; volRate 4 mm3/s throughout; lifts to Z5 between pieces",
  "; assumes the printer is heated and homed (like the page's run once); no prime line",
  "G90", "M83", "M221 S100",
  ...em.lines,
  "G91", "G1 Z5.000 F3000", "G90",
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({ lines: lines.length, filamentMm: +em.eTotal.toFixed(1), plasticMm3: Math.round(volume), extrudeMinutes: +(volume / 4 / 60).toFixed(1) }));
for (const r of report) console.log(r.name, r.at, "x", r.x, "y", r.y, "zMax", r.zMax, "mm3", r.plasticMm3);
