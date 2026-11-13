// Sheet 2: nine petal-dot graphics where every dot can have its own gap,
// diameter, height, drag and angle. Uses the unchanged brushPetalDot from
// texture_functions.js (loaded from a copy with the brush exported).
// Usage: node make_sheet2.mjs <path to texture_functions.js> <out.gcode>
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [, , libPath, outPath] = process.argv;
const copy = join(dirname(fileURLToPath(import.meta.url)), "tf_copy.mjs");
writeFileSync(copy, readFileSync(libPath, "utf8") + "\nexport { brushPetalDot };\n");
const TF = await import(pathToFileURL(copy).href + `?t=${Date.now()}`);
const { Emitter, samplePath, polylineToPts, pointAtArcLength, totalLength, brushPetalDot } = TF;

const D2R = Math.PI / 180, TAU = 2 * Math.PI;
const SAFE_Z = 5;
const em = new Emitter();
em.z = 10; em.retracted = true;

// ------------------------------------------------------------- building --
/** One petal dot. az = absolute drag direction in degrees (CCW from +X). */
function dot(x, y, { d = 2, h = 1, drag = 2, az = 0 } = {}) {
  brushPetalDot(em, x, y, { diameter: d, height: h, dragMm: Math.max(0.6, drag), azimuthDeg: az, extrudeSpeed: 150, dragSpeed: 600 });
}
/** A stroke whose every stop can differ: f(i, s, frac) -> {gap, d, h, drag, az}
 * where az is an offset from the path direction (0 = forward) and gap is the
 * distance to the NEXT stop. */
function walkVar(pts, f, s0 = 0) {
  const L = totalLength(pts);
  em.newPattern();
  for (let s = s0, i = 0; s <= L + 1e-6; i++) {
    const o = f(i, s, L > 0 ? s / L : 0);
    const [x, y] = pointAtArcLength(pts, s);
    const a = pointAtArcLength(pts, Math.max(0, s - 1)), b = pointAtArcLength(pts, Math.min(L, s + 1));
    const hd = Math.atan2(b[1] - a[1], b[0] - a[0]) / D2R;
    dot(x, y, { ...o, az: hd + (o.az ?? 0) });
    s += o.gap;
  }
}
/** A stroke over a given list of stops, each with its own settings. */
function dotsAt(list) { em.newPattern(); for (const p of list) dot(p.x, p.y, p); }
const line = (a, b) => polylineToPts([a, b]);
const curve = (fx, fy, t0, t1, step = 0.005) => samplePath(fx, fy, t0, t1, { step });
const lerp = (a, b, t) => a + (b - a) * t;
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// ---------------------------------------------------------------- pieces --

// A. PARAMETER SWATCH -- diameter grows left to right (1.4 -> 3.0 mm),
// drag grows bottom to top (0.5 -> 6.5 mm), every tail up. A printed key
// for what each setting looks and feels like.
function swatch(cx, cy) {
  const ds = [1.4, 1.7, 2.0, 2.3, 2.6, 3.0], drags = [0.5, 1.5, 2.5, 3.5, 5, 6.5];
  const xs = []; let x = 0;
  for (const d of ds) { xs.push(x); x += d + 3.2; }
  const ys = []; let y = 0;
  for (const g of drags) { ys.push(y); y += g + 3.4; }
  const ox = cx - (xs.at(-1)) / 2, oy = cy - (ys.at(-1) + drags.at(-1)) / 2;
  drags.forEach((g, r) => dotsAt(ds.map((d, c) => ({ x: ox + xs[c], y: oy + ys[r], d, drag: g, az: 90 }))));
}

// B. COMET -- a big head with a halo, and three curved trails. Along each
// trail the dots shrink (3 -> 1.2 mm), spread out (gap 2.6 -> 6 mm) and
// streak longer (drag 1.5 -> 6.5 mm), so it fades like a tail.
function comet(cx, cy) {
  const H = [cx + 14, cy + 13];
  dot(H[0], H[1], { d: 3.0, h: 1.3, drag: 1.0, az: 220 });
  for (let k = 0; k < 8; k++) { const a = k * 45; dot(H[0] + 4.2 * Math.cos(a * D2R), H[1] + 4.2 * Math.sin(a * D2R), { d: 1.4, drag: 1.6, az: a }); }
  for (const [ex, ey, bend] of [[-20, -13, 8], [-16, -18, 4], [-10, -20, 2]]) {
    const E = [cx + ex, cy + ey], C = [(H[0] + E[0]) / 2 - bend, (H[1] + E[1]) / 2 + bend];
    const bz = (t, i) => (1 - t) ** 2 * H[i] + 2 * (1 - t) * t * C[i] + t * t * E[i];
    walkVar(curve((t) => bz(t, 0), (t) => bz(t, 1), 0, 1, 0.002), (i, s, f) => ({
      gap: lerp(2.6, 6, f), d: lerp(2.8, 1.2, f), h: lerp(1.2, 0.8, f), drag: lerp(1.5, 4.5, f), az: 0,
    }), 6);
  }
}

// C. PHYLLOTAXIS -- 120 dots on the golden angle (137.5 deg), r = c*sqrt(n).
// Dots grow from 1.3 to 2.8 mm and drag 0.8 -> 3.5 mm straight outward, so
// the sunflower's two families of spirals appear on their own.
function phyllotaxis(cx, cy) {
  const N = 90, R = 20, c = R / Math.sqrt(N), list = [];
  for (let n = 1; n <= N; n++) {
    const r = c * Math.sqrt(n), th = n * 137.508, f = r / R;
    list.push({ x: cx + r * Math.cos(th * D2R), y: cy + r * Math.sin(th * D2R), d: lerp(1.3, 2.8, f), drag: lerp(0.8, 3.0, f), az: th });
  }
  dotsAt(list);
}

// D. FINGERPRINT -- 8 wobbly oval ridges. The outer ones open at the bottom
// like a real print. Along each ridge the gap breathes (2.2 -> 3.0 mm) and
// the dot size swells and thins, tails chained forward.
function fingerprint(cx, cy) {
  for (let k = 0; k < 7; k++) {
    const rk = 3.2 + 2.6 * k, open = k >= 3 ? 0.45 : 0.05;
    const t0 = -Math.PI / 2 + open, t1 = -Math.PI / 2 + TAU - open;
    const r = (t) => rk * (1 + 0.09 * Math.sin(3 * t + 0.7 * k) + 0.04 * Math.sin(5 * t));
    walkVar(curve((t) => cx + 0.82 * r(t) * Math.cos(t), (t) => cy + r(t) * Math.sin(t), t0, t1, 0.002), (i, s, f) => {
      const t = lerp(t0, t1, f), gap = 2.6 + 0.4 * Math.sin(4 * t + k);
      return { gap, d: 1.6 + 0.45 * Math.sin(6 * t + k), drag: 0.85 * gap, az: 0 };
    });
  }
}

// E. TREE -- recursive branches. Each level is thinner: diameter x0.8,
// gap = diameter + 0.9, drag chains along the branch. Tips end in a fan of
// three leaf dots.
function tree(cx, cy) {
  const MAXD = 4;
  const branch = (x, y, ang, len, depth) => {
    const ex = x + len * Math.cos(ang * D2R), ey = y + len * Math.sin(ang * D2R);
    const d = Math.max(1.3, 3.0 * 0.8 ** depth);
    walkVar(line([x, y], [ex, ey]), () => ({ gap: d + 0.9, d, h: depth === 0 ? 1.3 : 1.0, drag: 0.75 * (d + 0.9), az: 0 }), depth === 0 ? 0 : d);
    if (depth === MAXD) {
      dotsAt([-35, 0, 35].map((da) => ({ x: ex, y: ey, d: 1.6, drag: 2.4, az: ang + da })));
      return;
    }
    const spread = depth % 2 ? 22 : 30;
    branch(ex, ey, ang + spread, len * 0.76, depth + 1);
    branch(ex, ey, ang - spread, len * 0.76, depth + 1);
  };
  branch(cx, cy - 24, 90, 13, 0);
}

// F. INTERFERENCE -- a hex grid of dots in a circle; each dot's size and
// drag follow the interference of two waves from points 14 mm apart.
// Where the waves cancel, dots are left out: the nodal lines show as gaps.
function interference(cx, cy) {
  const R = 21, sp = 4.0, lam = 8, list = [];
  let row = 0;
  for (let y = -R; y <= R; y += sp * 0.866, row++) {
    const xsRow = [];
    for (let x = -R + (row % 2) * sp / 2; x <= R; x += sp) xsRow.push(x);
    if (row % 2) xsRow.reverse(); // serpentine
    for (const x of xsRow) {
      if (x * x + y * y > R * R) continue;
      const d1 = Math.hypot(x + 7, y), d2 = Math.hypot(x - 7, y);
      const v = Math.abs(Math.cos((TAU * d1) / lam) + Math.cos((TAU * d2) / lam)) / 2;
      if (v < 0.15) continue;
      list.push({ x: cx + x, y: cy + y, d: lerp(1.2, 2.9, v), drag: lerp(0.6, 2.6, v), az: Math.atan2(y, x + 7) / D2R });
    }
  }
  dotsAt(list);
}

// G. LETTERING "TPU" -- calligraphic strokes: each one starts thick
// (2.6 mm) and ends thin (1.5 mm), with the gap opening and the drag
// chaining along the stroke.
function lettering(cx, cy) {
  const cal = (pts) => walkVar(pts, (i, s, f) => { const gap = lerp(2.2, 3.0, f); return { gap, d: lerp(2.6, 1.5, f), drag: 0.8 * gap, az: 0 }; });
  const H = 10, W = 12, sp = 4, x0 = cx - (3 * W + 2 * sp) / 2;
  // T
  cal(line([x0, cy + H], [x0 + W, cy + H]));
  cal(line([x0 + W / 2, cy + H - 3], [x0 + W / 2, cy - H]));
  // P
  const px = x0 + W + sp;
  cal(line([px, cy - H], [px, cy + H]));
  const br = H / 2;
  cal(curve((t) => px + 3 + (W - 3 - br) * Math.min(1, t) + (t > 1 ? br * Math.sin((t - 1) * Math.PI) : 0) - (t > 2 ? 0 : 0),
    (t) => (t <= 1 ? cy + H : cy + br + br * Math.cos((t - 1) * Math.PI)), 0, 2, 0.002));
  // U
  const ux = px + W + sp, ur = W / 2;
  cal(curve((t) => (t < 1 ? ux : t < 2 ? ux + ur - ur * Math.cos((t - 1) * Math.PI) : ux + W),
    (t) => (t < 1 ? cy + H - (H * 2 - ur) * t : t < 2 ? cy - H + ur - ur * Math.sin((t - 1) * Math.PI) : cy - H + ur + (2 * H - ur) * (t - 2)), 0, 3, 0.002));
}

// H. RAIN -- Poisson-disc scatter (seeded, so it is repeatable). Every drop
// gets its own random size (1.3 -> 3.0 mm) and a streak that grows with
// size, all slanting the same way like windblown rain.
function rain(cx, cy) {
  const rand = rng(7), S = 42, minD = 4.4, pts = [];
  const far = (p) => pts.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= minD);
  for (let tries = 0; tries < 6000 && pts.length < 160; tries++) {
    const p = [rand() * S - S / 2, rand() * (S - 6) - S / 2 + 6];
    if (far(p)) pts.push(p);
  }
  pts.sort((a, b) => b[1] - a[1] || a[0] - b[0]); // top row first
  dotsAt(pts.map(([x, y]) => { const d = lerp(1.3, 3.0, rand()); return { x: cx + x, y: cy + y, d, drag: 1.0 + 1.6 * d * (0.6 + 0.4 * rand()), az: 255 }; }));
}

// I. MANDALA -- five rings, each with its own count, size, drag and
// direction: out, alternating in, swirling, radial spokes, then a fringe.
function mandala(cx, cy) {
  const P = (r, a) => [cx + r * Math.cos(a * D2R), cy + r * Math.sin(a * D2R)];
  const ringAt = (r, n, f) => dotsAt(Array.from({ length: n }, (_, i) => { const a = (360 * i) / n; const [x, y] = P(r, a); return { x, y, ...f(i, a) }; }));
  ringAt(2.6, 6, (i, a) => ({ d: 1.8, drag: 1.0, az: a }));
  ringAt(6.4, 12, (i, a) => ({ d: i % 2 ? 1.5 : 2.2, drag: i % 2 ? 0.9 : 1.9, az: a + 180 }));
  ringAt(10.2, 16, (i, a) => ({ d: 1.7, drag: 2.2, az: a + 90 }));
  for (let k = 0; k < 12; k++) {
    const a = k * 30 + 15;
    dotsAt([[13.8, 2.3], [16, 1.9], [18.2, 1.5]].map(([r, d]) => { const [x, y] = P(r, a); return { x, y, d, drag: 1.5, az: a }; }));
  }
  ringAt(21.5, 30, (i, a) => ({ d: 1.4, drag: 1.1, az: a }));
}

// J. VORTEX -- a spiral walked from the rim inward. Toward the centre the
// dots shrink (2.8 -> 1.3 mm), crowd closer (gap 3.4 -> 1.9 mm) and drag
// longer (1.2 -> 3.0 mm), so it reads as falling into a drain.
function vortex(cx, cy) {
  const R0 = 22, k = 3.0 / TAU, uMax = (R0 - 1.5) / k;
  const r = (u) => R0 - k * u;
  walkVar(curve((u) => cx + r(u) * Math.cos(-u), (u) => cy + r(u) * Math.sin(-u), 0, uMax, 0.003), (i, s, f) => ({
    gap: lerp(3.4, 1.9, f), d: lerp(2.8, 1.3, f), drag: lerp(1.2, 3.0, f), az: 0,
  }));
}

// K. HEARTBEAT -- two beats of an ECG trace. Dot size and height follow how
// far the trace is from the baseline, and the gap tightens on the spikes,
// so the peaks stand up as the tallest, densest ridge.
function heartbeat(cx, cy) {
  const beat = (x0) => [[x0, 0], [x0 + 3, 0], [x0 + 4.5, 2.5], [x0 + 6, 0], [x0 + 7.5, 0], [x0 + 8.3, -4], [x0 + 9.8, 17], [x0 + 11.3, -8], [x0 + 12.5, 0], [x0 + 15, 0], [x0 + 17, 4], [x0 + 19, 0]];
  const pts = [...beat(-23), ...beat(-4).slice(1), [19, 0], [23, 0]].map(([x, y]) => [cx + x, cy + y - 4]);
  const P = polylineToPts(pts, 0.05);
  walkVar(P, (i, s) => {
    const a = Math.min(1, Math.abs(pointAtArcLength(P, s)[1] - (cy - 4)) / 15);
    const gap = lerp(3.2, 2.0, a);
    return { gap, d: lerp(1.4, 2.6, a), h: lerp(0.9, 1.3, a), drag: 0.8 * gap, az: 0 };
  });
}

// L. TURING STRIPES -- a grid of stops inside a circle; a dot is printed only
// where a wavy stripe field is "on", sized by how strongly, and its tail
// runs along the stripe. Gives zebra / coral-like bands.
function stripes(cx, cy) {
  const R = 22, sp = 2.6, list = [];
  const v = (x, y) => Math.sin(0.62 * x + 2.4 * Math.sin(0.17 * y) + 1.3 * Math.sin(0.11 * (x + y)));
  let row = 0;
  for (let y = -R; y <= R; y += sp, row++) {
    const xs = [];
    for (let x = -R; x <= R; x += sp) xs.push(x);
    if (row % 2) xs.reverse();
    for (const x of xs) {
      if (x * x + y * y > R * R) continue;
      const val = v(x, y);
      if (val < 0.1) continue;
      const gx = (v(x + 0.1, y) - v(x - 0.1, y)) / 0.2, gy = (v(x, y + 0.1) - v(x, y - 0.1)) / 0.2;
      list.push({ x: cx + x, y: cy + y, d: lerp(1.3, 2.4, (val - 0.1) / 0.9), drag: 1.8, az: Math.atan2(gy, gx) / D2R + 90 });
    }
  }
  dotsAt(list);
}

// M. FISH -- a lens-shaped body filled with staggered scale rows (tails toward
// the tail fin, biggest along the middle), an eye, a fanned tail and a fin.
function fish(cx, cy) {
  const nose = -21, joint = 11, half = (x) => 10 * Math.max(0, Math.sin((Math.PI * (x - nose)) / (joint - nose))) ** 0.8;
  const eye = [cx - 14, cy + 2.5];
  dot(eye[0], eye[1], { d: 2.8, h: 1.3, drag: 0.8, az: 180 });
  for (let row = -2; row <= 2; row++) {
    const y = row * 3.2, list = [];
    for (let x = nose + 4 + (Math.abs(row) % 2) * 1.6; x < joint - 1; x += 3.2) {
      if (half(x) < Math.abs(y) + 1.4) continue;
      if (Math.hypot(cx + x - eye[0], cy + y - eye[1]) < 3.5) continue;
      list.push({ x: cx + x, y: cy + y, d: lerp(2.4, 1.6, Math.abs(row) / 2), drag: 2.0, az: 0 });
    }
    dotsAt(list);
  }
  for (const a of [-38, -19, 0, 19, 38]) {
    const ang = a * D2R, A = [cx + joint, cy], B = [cx + joint + 11 * Math.cos(ang), cy + 11 * Math.sin(ang)];
    walkVar(line(A, B), (i, s, f) => ({ gap: lerp(2.4, 3.2, f), d: lerp(2.0, 1.4, f), drag: 2.0, az: 0 }), 1.5);
  }
  for (const xf of [-4, -1, 2]) walkVar(line([cx + xf, cy + half(xf) + 1.5], [cx + xf + 4, cy + half(xf) + 6]), () => ({ gap: 2.4, d: 1.4, drag: 1.5, az: 0 }));
}

// N. NAUTILUS -- a logarithmic spiral shell, dots growing along it, plus the
// chamber walls: short lines from each point to the whorl inside, every 40
// degrees, in small dots.
function nautilus(cx, cy) {
  const a = 1.3, b = 0.175, thMax = Math.log(21 / a) / b;
  const S = (t) => [cx - 2 + a * Math.exp(b * t) * Math.cos(t), cy + a * Math.exp(b * t) * Math.sin(t)];
  walkVar(curve((t) => S(t)[0], (t) => S(t)[1], 0, thMax, 0.003), (i, s, f) => {
    const gap = lerp(1.9, 3.4, f); return { gap, d: lerp(1.3, 2.8, f), drag: 0.8 * gap, az: 0 };
  });
  for (let t = TAU + 0.4; t < thMax - 0.2; t += 40 * D2R) {
    const A = S(t), B = S(t - TAU), len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (len < 4) continue;
    walkVar(line(A, B), () => ({ gap: 2.2, d: 1.3, drag: 1.2, az: 0 }), 1.8);
  }
}

// O. BUBBLES -- circles of different sizes packed in a disc (seeded). Each
// bubble is a ring whose dot size, gap and drag all scale with its radius,
// tails running around the ring; big bubbles get a highlight dot.
function bubbles(cx, cy) {
  const rand = rng(11), radii = [8.5, 6.5, 5.5, 5, 4.5, 4, 3.5, 3.5, 3, 3, 2.6, 2.6, 2.3], placed = [];
  for (const R of radii) {
    for (let tries = 0; tries < 800; tries++) {
      const ang = rand() * TAU, dist = rand() * (21 - R), x = dist * Math.cos(ang), y = dist * Math.sin(ang);
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.R + R + 2.8)) { placed.push({ x, y, R }); break; }
    }
  }
  for (const { x, y, R } of placed) {
    const gap = 1.8 + 0.28 * R, n = Math.max(4, Math.round((TAU * R) / gap));
    dotsAt(Array.from({ length: n }, (_, i) => {
      const a = (360 * i) / n;
      return { x: cx + x + R * Math.cos(a * D2R), y: cy + y + R * Math.sin(a * D2R), d: 1.2 + 0.14 * R, drag: 0.7 * gap, az: a + 90 };
    }));
    if (R >= 4.5) dot(cx + x - 0.45 * R, cy + y + 0.45 * R, { d: 1.3, drag: 0.8, az: 135 });
  }
}

// P. DANDELION -- a seed head of thin rays (small dots, wide gaps) each
// ending in a little fan, on a curved stem walked up toward the head, with
// a jagged leaf at the base.
function dandelion(cx, cy) {
  const H = [cx, cy + 7];
  dotsAt([0, 120, 240].map((a) => ({ x: H[0] + 0.9 * Math.cos(a * D2R), y: H[1] + 0.9 * Math.sin(a * D2R), d: 1.6, drag: 0.8, az: a })));
  for (let k = 0; k < 22; k++) {
    const a = k * (360 / 22) + 5;
    if (Math.abs(((a - 270 + 540) % 360) - 180) < 28) continue; // leave room for the stem
    const L = 10.5 + 2 * Math.sin(k * 1.7), u = [Math.cos(a * D2R), Math.sin(a * D2R)];
    walkVar(line([H[0] + 2.5 * u[0], H[1] + 2.5 * u[1]], [H[0] + L * u[0], H[1] + L * u[1]]), () => ({ gap: 2.6, d: 1.2, drag: 1.4, az: 0 }));
    dotsAt([-32, 32].map((da) => ({ x: H[0] + (L + 1.2) * u[0], y: H[1] + (L + 1.2) * u[1], d: 1.2, drag: 1.8, az: a + da })));
  }
  const st = (t) => [cx + 3 * Math.sin(t * 1.4), cy - 23 + 25 * t];
  walkVar(curve((t) => st(t)[0], (t) => st(t)[1], 0, 1, 0.002), (i, s, f) => ({ gap: lerp(2.2, 2.8, f), d: lerp(2.2, 1.6, f), drag: 1.8, az: 0 }));
  const leaf = [[cx + 0.5, cy - 21], [cx - 4, cy - 19], [cx - 5, cy - 16], [cx - 8, cy - 15], [cx - 9, cy - 12], [cx - 12, cy - 11]];
  walkVar(polylineToPts(leaf, 0.05), (i, s, f) => ({ gap: 2.4, d: lerp(2.0, 1.3, f), drag: 1.6, az: 0 }));
}

// ------------------------------------------------------------------ layout --
// 4 x 4 grid, 53 mm cells; printed in a snake so moves stay short.
const G = [31, 84, 137, 190], HALF = 26.3;
const PIECES = [
  ["parameter swatch", swatch, G[0], G[0]], ["comet", comet, G[1], G[0]], ["phyllotaxis", phyllotaxis, G[2], G[0]], ["vortex", vortex, G[3], G[0]],
  ["fingerprint", fingerprint, G[3], G[1]], ["tree", tree, G[2], G[1]], ["mandala", mandala, G[1], G[1]], ["fish", fish, G[0], G[1]],
  ["heartbeat", heartbeat, G[0], G[2]], ["nautilus", nautilus, G[1], G[2]], ["bubbles", bubbles, G[2], G[2]], ["interference", interference, G[3], G[2]],
  ["dandelion", dandelion, G[3], G[3]], ["Turing stripes", stripes, G[2], G[3]], ["rain", rain, G[1], G[3]], ["lettering TPU", lettering, G[0], G[3]],
];

const report = [];
for (const [name, fn, cx, cy] of PIECES) {
  em.retract();
  em.a(`G1 Z${SAFE_Z.toFixed(3)} F3000`); em.z = SAFE_Z;
  em.a(`; --- ${name} at X${cx} Y${cy} ---`);
  const from = em.lines.length;
  fn(cx, cy);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, dots = 0;
  const ds = new Set(), drags = [];
  for (const l of em.lines.slice(from)) {
    if (/ F150$/.test(l)) dots++;
    const mx = l.match(/X(-?[\d.]+)/), my = l.match(/Y(-?[\d.]+)/);
    if (mx) { x0 = Math.min(x0, +mx[1]); x1 = Math.max(x1, +mx[1]); }
    if (my) { y0 = Math.min(y0, +my[1]); y1 = Math.max(y1, +my[1]); }
  }
  const inCell = x0 >= cx - HALF && x1 <= cx + HALF && y0 >= cy - HALF && y1 <= cy + HALF;
  const onBed = x0 >= 5 && y0 >= 5 && x1 <= 215 && y1 <= 215;
  report.push({ name, at: [cx, cy], dots, x: [+x0.toFixed(1), +x1.toFixed(1)], y: [+y0.toFixed(1), +y1.toFixed(1)] });
  if (!inCell || !onBed) throw new Error(`${name} leaves its cell or the bed: ${JSON.stringify(report.at(-1))}`);
}
em.retract();

const lines = [
  "; sheet 2 -- sixteen petal-dot graphics with per-dot gap / diameter / height / drag / angle (NEW sheet)",
  "; 4 x 4 grid, centres X/Y 31 84 137 190 -- Y31: swatch, comet, phyllotaxis, vortex | Y84: fish, mandala, tree, fingerprint | Y137: heartbeat, nautilus, bubbles, interference | Y190: TPU, rain, Turing stripes, dandelion",
  "; brushPetalDot from texture_functions.js, called per dot; lifts to Z5 between pieces",
  "; assumes the printer is heated and homed (like the page's run once); no prime line",
  "G90", "M83", "M221 S100",
  ...em.lines,
  "G91", "G1 Z5.000 F3000", "G90",
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({ lines: lines.length, filamentMm: +em.eTotal.toFixed(1), dots: report.reduce((a, r) => a + r.dots, 0) }));
for (const r of report) console.log(r.name, r.at, "dots", r.dots, "x", r.x, "y", r.y);
