// Five exploratory textures, one test file each (PLA by default). Nothing here is a library function yet.
//   fish-scales   sideways-pulled strands that ramp up to a free tip, laid tip-first so they overlap like tiles
//   sawtooth      ridges with one sloped and one vertical face (layers stepped sideways), + a symmetric control
//   woven         basket-weave relief: at each crossing one direction is raised (over), the other broken (under)
//   donut         ring / crater dots (spiral annulus), + a solid-disc control
//   stipple       disc-dot fields whose density (or dot size) grades across the region, hex and random
// Usage: node ideas_test.mjs <path to texture_functions.js> <out dir> [pla|tpu] [idea ...]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const lib = await import(pathToFileURL(process.argv[2]).href);
const { Emitter, FIL_AREA, eRate, emitStroke, spiralDisc, circularDot, freeformSolid, verifyLayout, stripComments,
  LAYER_HEIGHT, MAX_EXTRUSION_RATE_MM3_S, RETRACT_MM } = lib;
const outDir = process.argv[3];
// Material presets: TPU = the library defaults; PLA = the 20260925 PLA calibration sheet's header.
const MATERIALS = {
  tpu: { name: "TPU", nozzleTemp: lib.NOZZLE_TEMP, bedTemp: lib.BED_TEMP, flowPercent: lib.FLOW_PERCENT },
  pla: { name: "PLA", nozzleTemp: 205, bedTemp: 60, flowPercent: 100 },
};
const MAT = MATERIALS[process.argv[4] ?? "pla"];
const only = process.argv.slice(5);
const flow = MAT.flowPercent / 100;
const vol = (eRatePerMm, F) => eRatePerMm * FIL_AREA * flow * (F / 60); // mm3/s

// ------------------------------------------------------------------ helpers --

// Extruded straight 3D move split into 0.5mm pieces, e proportional to 3D length.
function strandTo(em, x, y, z, F, rate) {
  const d = Math.hypot(x - em.x, y - em.y, z - em.z);
  const n = Math.max(1, Math.ceil(d / 0.5));
  const x0 = em.x, y0 = em.y, z0 = em.z;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    em.printMove(x0 + (x - x0) * t, y0 + (y - y0) * t, (rate * d) / n, F, z0 + (z - z0) * t);
  }
}

// One flat bead polyline at height z, retracted at the end.
function bead(em, pts, z, { width = 0.5, F = 900 } = {}) {
  em.goto(pts[0][0], pts[0][1], z);
  em.unretract();
  const r = eRate(width, LAYER_HEIGHT);
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (d > 1e-9) em.printMove(pts[i][0], pts[i][1], d * r, F, z);
  }
  em.retract();
}

const retractCount = (em) => em.lines.filter((l) => l.startsWith(`G1 E-${RETRACT_MM.toFixed(4)}`)).length;

// Small seeded PRNG so the random stipple is reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------- 1. scales --

const SCALE = { anchorE: 0.2, anchorZ: 0.5, rate: 0.05, F: 300, dwellMs: 500 };

function fishScale(em, ax, ay, { L, tipH }) {
  em.goto(ax, ay, 0.2);
  em.unretract();
  em.a(`G1 Z${SCALE.anchorZ.toFixed(3)} E${SCALE.anchorE.toFixed(4)} F60`); // anchor puddle
  em.eTotal += SCALE.anchorE; em.z = SCALE.anchorZ;
  strandTo(em, ax + L, ay, tipH, SCALE.F, SCALE.rate);                    // ramp out to a raised tip
  em.dwell(SCALE.dwellMs);
  em.retract();
  strandTo(em, ax + L + 0.8, ay, tipH, 1200, 0);                          // dry pull: snap the tail
  em.a(`G1 Z${(tipH + 2).toFixed(3)} F1500`); em.z = tipH + 2;
}

// Scales point +X; printed from the +X end back so each new scale lies over the previous one's base.
function scaleRow(em, x0, y, { n, pitch, L, tipH }) {
  em.newPattern();
  for (let i = n - 1; i >= 0; i--) fishScale(em, x0 + i * pitch, y, { L, tipH });
}

function fishScales(em, { ox: X0 = 20, oy = 25 } = {}) {
  const rows = [
    { id: "F1", y: oy, n: 8, pitch: 5, L: 4, tipH: 1.0, note: "single tongues, no overlap -- baseline" },
    { id: "F2", y: oy + 8, n: 8, pitch: 5, L: 4, tipH: 1.5, note: "steeper, higher tip, no overlap" },
    { id: "F3", y: oy + 16, n: 12, pitch: 2, L: 4, tipH: 1.3, note: "overlapping tiles, half-length pitch" },
    { id: "F4", y: oy + 24, n: 12, pitch: 2, L: 5, tipH: 1.7, note: "longer overlapping tiles" },
  ];
  const regions = [];
  for (const r of rows) {
    em.a(`; row ${r.id}: ${r.note}`);
    scaleRow(em, X0, r.y, r);
    r.region = { name: r.id, x0: X0 - 1, y0: r.y - 1, w: (r.n - 1) * r.pitch + r.L + 2, h: 2 };
    // vertical clearance between a new scale's strand and the one it lies over
    r.clear = r.pitch < r.L ? ((r.tipH - SCALE.anchorZ) * r.pitch) / r.L : null;
    r.params = `L ${r.L}, tip ${r.tipH}mm, pitch ${r.pitch}, ${r.n} scales` + (r.clear != null ? `, overlap clearance ${r.clear.toFixed(2)}mm` : "");
    regions.push(r.region);
  }
  // F5: a staggered 2D patch -- 4 rows 1.5mm apart, alternate rows offset by half a pitch
  const patch = { id: "F5", y: oy + 35, rows: 4, dy: 1.5, n: 10, pitch: 2, L: 4, tipH: 1.3, note: "staggered 2D patch (4 rows x 10), the fish-skin field" };
  em.a(`; row F5: ${patch.note}`);
  for (let k = 0; k < patch.rows; k++) scaleRow(em, X0 + (k % 2) * patch.pitch / 2, patch.y + k * patch.dy, patch);
  patch.region = { name: "F5", x0: X0 - 1, y0: patch.y - 1, w: (patch.n - 1) * patch.pitch + patch.pitch / 2 + patch.L + 2, h: (patch.rows - 1) * patch.dy + 2 };
  patch.params = `4 rows, 1.5mm apart, L ${patch.L}, tip ${patch.tipH}, pitch ${patch.pitch}`;
  rows.push(patch); regions.push(patch.region);
  return {
    title: "Fish scales", rows, regions,
    intro: `Each scale: anchor puddle (Z 0.2->${SCALE.anchorZ}, e ${SCALE.anchorE}) -> strand ramps +X over length L up to the tip height ` +
      `(e/d ${SCALE.rate}, F${SCALE.F}) -> ${SCALE.dwellMs}ms dwell -> retract -> 0.8mm dry pull to snap the tail -> lift. ` +
      `Scales point +X and each row is printed from its +X end, so later scales lie on the bases of earlier ones. ` +
      `"Overlap clearance" is how far the new strand runs above the one beneath (aim >= 0.4mm, one strand thickness).`,
    look: "Stroke each row toward +X (with the grain) and toward -X (against it): is there a clear difference? Do the tips stay raised or droop flat? " +
      "In F3/F4/F5, did the overlapping strands fuse into a sheet or stay separate tiles? Did the dry pull leave clean tips or strings?",
  };
}

// ------------------------------------------------------------- 2. sawtooth --

function sawtoothPatch(em, x0, y0, { W, nLayers, nRidges, len, symmetric, F = 1200 }) {
  const sp = 0.45, r = eRate(sp, LAYER_HEIGHT);
  em.newPattern();
  for (let k = 1; k <= nLayers; k++) {           // layer by layer across the patch: the nozzle never sits below a taller ridge
    const z = LAYER_HEIGHT * k;
    const wk = W * (1 - (k - 1) / nLayers);
    for (let j = 0; j < nRidges; j++) {
      const yb = y0 + j * W;
      const lo = symmetric ? yb + (W - wk) / 2 : yb, hi = lo + wk; // asymmetric: steep face held at yb
      const m = Math.max(1, Math.round(wk / sp));
      const ys = m === 1 ? [(lo + hi) / 2] : Array.from({ length: m }, (_, i) => lo + sp / 2 + (i * (hi - lo - sp)) / (m - 1));
      em.goto(x0, ys[0], z);
      em.unretract();
      ys.forEach((y, i) => {                     // serpentine inside one ridge strip
        const [xa, xb] = i % 2 ? [x0 + len, x0] : [x0, x0 + len];
        if (i > 0) em.printMove(xa, y, Math.abs(y - ys[i - 1]) * r, F, z);
        em.printMove(xb, y, len * r, F, z);
      });
      em.retract();
    }
  }
}

function sawtooth(em, { ox = 20, oy = 25, dx = 45, dy = 20 } = {}) {
  const len = 30;
  const rows = [
    { id: "S1", x0: ox, y0: oy, W: 2, nLayers: 5, nRidges: 6, note: "asymmetric, fine: 2mm pitch, 1.0mm tall" },
    { id: "S2", x0: ox + dx, y0: oy, W: 3, nLayers: 8, nRidges: 4, note: "asymmetric, coarse: 3mm pitch, 1.6mm tall" },
    { id: "S3", x0: ox, y0: oy + dy, W: 3, nLayers: 8, nRidges: 4, symmetric: true, note: "SYMMETRIC control for S2 (same pitch and height)" },
    { id: "S4", x0: ox + dx, y0: oy + dy, W: 4, nLayers: 5, nRidges: 3, note: "asymmetric, shallow: 4mm pitch, 1.0mm tall" },
  ];
  for (const r of rows) {
    em.a(`; patch ${r.id}: ${r.note}`);
    sawtoothPatch(em, r.x0, r.y0, { ...r, len });
    r.region = { name: r.id, x0: r.x0 - 1, y0: r.y0 - 1, w: len + 2, h: r.nRidges * r.W + 2 };
    r.y = r.y0;
    r.params = `${r.nRidges} ridges x ${len}mm along X, pitch ${r.W}, ${r.nLayers} layers (${(r.nLayers * LAYER_HEIGHT).toFixed(1)}mm)`;
  }
  return {
    title: "Sawtooth ridges", rows, regions: rows.map((r) => r.region),
    intro: `Ridges run along X and repeat along +Y. Each layer is a solid strip of 0.45mm-spaced beads (serpentine, F1200, e/d ${eRate(0.45, LAYER_HEIGHT).toFixed(4)}); ` +
      `layer k is (1 - (k-1)/n) of the pitch wide. Asymmetric patches keep the strip pinned to the ridge's -Y edge, so that face is vertical and the slope descends toward +Y. ` +
      `Patches are printed layer by layer across all ridges.`,
    look: "Stroke S1/S2/S4 along +Y (down the slopes) and -Y (into the steep faces): is the direction obvious? Compare S2 with S3, which has the same size but no direction. " +
      "Did the vertical face stay vertical or slump?",
  };
}

// --------------------------------------------------------------- 3. woven --

function wovenPatch(em, x0, y0, { P, g, over, crosshatch }) {
  const n = Math.floor(P / g);
  const ys = Array.from({ length: n }, (_, j) => y0 + g / 2 + j * g);  // warp lines (along X)
  const xs = Array.from({ length: n }, (_, i) => x0 + g / 2 + i * g);  // weft lines (along Y)
  const c = 0.6, h = 1.2; // weft break half-gap at a crossing; half-length of an "over" bump
  em.newPattern();
  ys.forEach((y) => bead(em, [[x0, y], [x0 + P, y]], 0.2));            // warp base
  if (crosshatch) {
    xs.forEach((x) => bead(em, [[x, y0], [x, y0 + P]], 0.4));          // plain crosshatch: weft simply crosses on top
    return;
  }
  xs.forEach((x) => {                                                   // weft base, broken at every crossing
    const stops = [y0, ...ys.flatMap((y) => [y - c, y + c]), y0 + P];
    for (let s = 0; s < stops.length; s += 2) bead(em, [[x, stops[s]], [x, stops[s + 1]]], 0.2);
  });
  for (const z of [0.4, 0.6]) {                                         // "over" bumps, two layers
    xs.forEach((x, i) => ys.forEach((y, j) => {
      if (over(i, j)) bead(em, [[x - h, y], [x + h, y]], z);           // warp over: bump on the warp
      else bead(em, [[x, y - h], [x, y + h]], z);                      // weft over: bridge the break, on top of the warp
    }));
  }
}

function woven(em, { ox = 20, oy = 25, dx = 40, dy = 34 } = {}) {
  const P = 24;
  const plain = (i, j) => (i + j) % 2 === 0;
  const twill = (i, j) => (i + j) % 4 < 2;
  const rows = [
    { id: "W1", x0: ox, y0: oy, g: 4, over: plain, note: "plain weave, 4mm grid" },
    { id: "W2", x0: ox + dx, y0: oy, g: 3, over: plain, note: "plain weave, 3mm grid" },
    { id: "W3", x0: ox, y0: oy + dy, g: 3, over: twill, note: "2/2 twill, 3mm grid -- diagonal ribs" },
    { id: "W4", x0: ox + dx, y0: oy + dy, g: 4, crosshatch: true, note: "CONTROL: plain crosshatch, no over/under" },
  ];
  for (const r of rows) {
    em.a(`; patch ${r.id}: ${r.note}`);
    wovenPatch(em, r.x0, r.y0, { P, ...r });
    r.region = { name: r.id, x0: r.x0 - 1, y0: r.y0 - 1, w: P + 2, h: P + 2 };
    r.y = r.y0;
    r.params = `${P}x${P}mm, ${Math.floor(P / r.g)} x ${Math.floor(P / r.g)} lines`;
  }
  return {
    title: "Woven over-under", rows, regions: rows.map((r) => r.region),
    intro: "Warp = lines along X, weft = lines along Y, bead 0.5 x 0.2, F900. Layer 1: full warp lines; weft lines broken 0.6mm either side of every warp line. " +
      "Layers 2 and 3 (Z 0.4, 0.6): at each crossing, a 2.4mm bump on whichever thread is 'over' -- on the warp it sits on the warp; on the weft it bridges the break and crosses on top of the warp. " +
      "The 'under' thread stays broken, so it reads as passing beneath. A real under-pass is not printable (the nozzle can't fit under a strand), so this is a relief imitation.",
    look: "Does W1/W2 read as fabric under the finger compared with W4? Does the twill (W3) give a diagonal grain? Did the weft bridges over the breaks hold or sag into gaps?",
  };
}

// --------------------------------------------------------------- 4. donut --

function donut(em, cx, cy, { od, id, layers }) {
  const w = 0.42;
  const pts = spiralDisc([cx, cy], od / 2 - w / 2, w, 30).filter(([x, y]) => Math.hypot(x - cx, y - cy) >= id / 2 + w / 2);
  em.newPattern();
  emitStroke(em, pts, layers, w, 250);
}

function donuts(em, { ox: X0 = 25, oy = 25, pitch = 10 } = {}) {
  const rows = [
    { id: "D1", y: oy, od: 3, id_: 1.2, layers: 2, n: 5, pitch, note: "small ring" },
    { id: "D2", y: oy + 10, od: 4, id_: 1.6, layers: 3, n: 5, pitch, note: "medium ring" },
    { id: "D3", y: oy + 20, od: 5, id_: 2.5, layers: 3, n: 5, pitch, note: "larger ring, half-diameter hole" },
    { id: "D4", y: oy + 30, od: 6, id_: 3.6, layers: 3, n: 5, pitch, note: "thin-walled ring" },
    { id: "D5", y: oy + 40, od: 6, id_: 3.6, layers: 5, n: 5, pitch, note: "as D4 but 1.0mm tall -- a crater" },
    { id: "D6", y: oy + 50, od: 4, layers: 3, n: 5, pitch, solid: true, note: "CONTROL: solid circularDot, same size/height as D2" },
    { id: "D7", y: oy + 60, od: 3, id_: 1.2, layers: 3, n: 10, pitch: 4, note: "ring line: rings 4mm apart, nearly touching" },
  ];
  for (const r of rows) {
    em.a(`; row ${r.id}: ${r.note}`);
    for (let i = 0; i < r.n; i++) {
      const cx = X0 + i * r.pitch;
      if (r.solid) circularDot(em, cx, r.y, { diameter: r.od, height: r.layers * LAYER_HEIGHT });
      else donut(em, cx, r.y, { od: r.od, id: r.id_, layers: r.layers });
    }
    r.region = { name: r.id, x0: X0 - r.od / 2 - 0.5, y0: r.y - r.od / 2 - 0.5, w: (r.n - 1) * r.pitch + r.od + 1, h: r.od + 1 };
    r.params = r.solid ? `solid D ${r.od}, ${r.layers} layers` : `OD ${r.od}, hole ${r.id_}, wall ${((r.od - r.id_) / 2).toFixed(1)}, ${r.layers} layers (${(r.layers * LAYER_HEIGHT).toFixed(1)}mm), ${r.n} @ ${r.pitch}mm`;
  }
  return {
    title: "Donut / crater dots", rows, regions: rows.map((r) => r.region),
    intro: "Each ring is the library's spiralDisc() with 0.42mm turns, trimmed to the annulus and printed through emitStroke() (0.42 bead, F250), one layer at a time. " +
      "D6 is the existing circularDot as a solid reference.",
    look: "Can you feel the hole in each size (where does it stop reading as a ring and start reading as a dot)? Compare D2 with D6 directly. Did the small holes (D1, D7) close up with ooze?",
  };
}

// ------------------------------------------------------------- 5. stipple --

function hexPoints(x0, y0, w, h, spacingAt, margin) {
  const pts = [];
  let x = x0 + margin, col = 0;
  while (x <= x0 + w - margin + 1e-9) {
    const s = spacingAt(x);
    const ys = [];
    for (let y = y0 + margin + (col % 2) * s / 2; y <= y0 + h - margin + 1e-9; y += s) ys.push(y);
    if (col % 2) ys.reverse();                    // serpentine order
    ys.forEach((y) => pts.push([x, y]));
    x += s * Math.sqrt(3) / 2; col++;
  }
  return pts;
}

function randomPoints(x0, y0, w, h, spacingAt, margin, seed) {
  const rnd = mulberry32(seed), pts = [];
  for (let a = 0; a < 6000; a++) {
    const p = [x0 + margin + rnd() * (w - 2 * margin), y0 + margin + rnd() * (h - 2 * margin)];
    const s = spacingAt(p[0]);
    if (pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= Math.min(s, spacingAt(q[0])))) pts.push(p);
  }
  // order: 4mm column bins, serpentine within a bin
  return pts.sort((a, b) => Math.floor((a[0] - x0) / 4) - Math.floor((b[0] - x0) / 4) ||
    (Math.floor((a[0] - x0) / 4) % 2 ? b[1] - a[1] : a[1] - b[1]));
}

function stipple(em, { ox: X0 = 20, oy = 25, dy = 20 } = {}) {
  const W = 50, H = 14;
  const grad = (lo, hi) => (x) => lo + ((hi - lo) * (x - X0)) / W;
  const rows = [
    { id: "P1", y: oy, layout: "hex", spacing: () => 3, d: () => 1.2, note: "CONTROL: uniform hex, 3mm" },
    { id: "P2", y: oy + dy, layout: "hex", spacing: grad(2, 6), d: () => 1.2, note: "hex, spacing grades 2 -> 6mm along +X" },
    { id: "P3", y: oy + 2 * dy, layout: "random", spacing: grad(2, 6), d: () => 1.2, note: "random (seeded), min spacing grades 2 -> 6mm" },
    { id: "P4", y: oy + 3 * dy, layout: "hex", spacing: () => 3.5, d: grad(0.8, 2.4), note: "hex 3.5mm, dot DIAMETER grades 0.8 -> 2.4mm" },
  ];
  for (const r of rows) {
    em.a(`; field ${r.id}: ${r.note}`);
    const margin = 1.5;
    const pts = r.layout === "hex" ? hexPoints(X0, r.y, W, H, r.spacing, margin) : randomPoints(X0, r.y, W, H, r.spacing, margin, 20261029);
    pts.forEach(([x, y]) => circularDot(em, x, y, { diameter: r.d(x), height: 0.4 }));
    r.count = pts.length;
    r.region = { name: r.id, x0: X0, y0: r.y, w: W, h: H };
    r.params = `${W}x${H}mm, ${pts.length} dots, height 0.4` + (r.layout === "random" ? ", seed 20261029" : "");
  }
  return {
    title: "Density-gradient stipple", rows, regions: rows.map((r) => r.region),
    intro: "Every dot is the library's circularDot (spiral disc, 0.4mm tall). Gradients run along +X across a 50mm field: low X = dense / small, high X = sparse / large.",
    look: "Sweep a finger along +X: does P2/P3 feel like a smooth rough-to-smooth change, or in steps? Is the random field (P3) more pleasant than the hex (P2)? " +
      "Does a size gradient (P4) read as strongly as a spacing gradient?",
  };
}

// ---------------------------------------------------------------- runner --

const IDEAS = [
  { key: "fish-scales", calY: 70, build: fishScales },
  { key: "sawtooth", calY: 65, build: sawtooth },
  { key: "woven", calY: 60, build: woven },
  { key: "donut", calY: 55, build: donuts },
  { key: "stipple", calY: 50, build: stipple },
];
const CAL = { x0: 120, x1: 180 };
const SAFE_Z = 5;

// The "sheet": all five ideas on one bed, one calibration line, tighter internal spacing.
// Each entry is an IDEAS key plus the origin/spacing passed to its builder.
const SHEET = {
  key: "five-ideas-sheet", calY: 45, parts: [
    { key: "fish-scales", opts: { ox: 20, oy: 21 } },
    { key: "donut", opts: { ox: 25, oy: 72, pitch: 9 } },
    { key: "sawtooth", opts: { ox: 72, oy: 56, dx: 36, dy: 18 } },
    { key: "stipple", opts: { ox: 72, oy: 96, dy: 18 } },
    { key: "woven", opts: { ox: 146, oy: 56, dx: 30, dy: 30 } },
  ],
};

function writeFile(key, calY, parts) {
  const em = new Emitter();
  em.header({ nozzleTemp: MAT.nozzleTemp, bedTemp: MAT.bedTemp, flowPercent: MAT.flowPercent });
  em.a(`; ${key} exploration -- see MAP.md`);
  em.a(`; calibration line x=${CAL.x0}-${CAL.x1} y=${calY}`);
  freeformSolid(em, (t) => t, () => calY, CAL.x0, CAL.x1);
  em.a("M106 S255");
  const results = parts.map((p) => {
    if (parts.length > 1) {
      // Travel between blocks can cross blocks already printed (ridges up to 1.6mm, scale tips up to 1.7mm),
      // and goto() only hops Z_HOP above the last height -- so clear everything before moving to the next block.
      em.a(`; ===== ${p.key} =====`);
      em.retract();
      em.a(`G1 Z${SAFE_Z.toFixed(3)} F1500`); em.z = SAFE_Z;
    }
    return { key: p.key, ...IDEAS.find((i) => i.key === p.key).build(em, p.opts) };
  });
  em.a("M107");
  em.footer();

  const regions = results.flatMap((res) => res.regions.map((r) => ({ ...r, name: `${res.key} ${r.name}` })));
  const layout = verifyLayout([{ name: "calibration", x0: CAL.x0, y0: calY - 0.5, w: CAL.x1 - CAL.x0, h: 1 }, ...regions], { minGap: 3 });
  if (!layout.ok) { console.error(key, layout); process.exit(1); }

  const base = `20261029_${key}-${MAT.name}`;
  writeFileSync(join(outDir, `${base}.gcode`), stripComments(em.lines.join("\n")));
  const extent = (rs) => {
    const xs = [], ys = [];
    for (const r of rs) { xs.push(r.x0, r.x0 + r.w); ys.push(r.y0, r.y0 + r.h); }
    return `x ${Math.min(...xs).toFixed(0)}-${Math.max(...xs).toFixed(0)}, y ${Math.min(...ys).toFixed(0)}-${Math.max(...ys).toFixed(0)}`;
  };
  const sheet = results.length > 1;
  let md = sheet
    ? `# Five texture ideas, one sheet -- ${MAT.name}, nozzle ${MAT.nozzleTemp}C, bed ${MAT.bedTemp}C, M221 S${MAT.flowPercent}\n\n` +
      `**Not yet print-tested.** Generated by \`ideas_test.mjs ${key}\`; none of these is a library function. ` +
      `Same textures and parameters as the five single files from the same day, only moved and packed closer together.\n\n` +
      `Calibration line: \`freeformSolid\` x=${CAL.x0}-${CAL.x1}, y=${calY}, printed first. Part fan on (\`M106 S255\`) after it, off at the end. ` +
      `Before each block the nozzle retracts and lifts to Z${SAFE_Z}, so travel between blocks clears everything already printed. ` +
      `\`verifyLayout\` (3mm min gap, all ${regions.length + 1} regions): ok=${layout.ok}, ${layout.warnings.length} warnings.\n\n` +
      `| block | area on the bed | print order |\n|---|---|---|\n` +
      results.map((res, i) => `| ${res.title} | ${extent(res.regions)} | ${i + 1} |\n`).join("") + "\n"
    : "";
  for (const res of results) {
    md += sheet
      ? `## ${res.title}\n\n${res.intro}\n\n`
      : `# ${res.title} -- ${MAT.name}, nozzle ${MAT.nozzleTemp}C, bed ${MAT.bedTemp}C, M221 S${MAT.flowPercent}\n\n` +
        `**Not yet print-tested.** Generated by \`ideas_test.mjs ${key}\`; no library function exists for this texture.\n\n` +
        `${res.intro}\n\n` +
        `Calibration line: \`freeformSolid\` x=${CAL.x0}-${CAL.x1}, y=${calY}, printed first. Part fan on (\`M106 S255\`) after it, off at the end. ` +
        `Textures occupy ${extent(res.regions)}. ` +
        `\`verifyLayout\` (3mm min gap): ok=${layout.ok}, ${layout.warnings.length} warnings.\n\n`;
    md += `| id | position (x0, y0) | parameters | note |\n|---|---|---|---|\n`;
    for (const r of res.rows) md += `| ${r.id} | ${r.region.x0.toFixed(1)}, ${r.region.y0.toFixed(1)} | ${r.params} | ${r.note} |\n`;
    md += `\n**What to look for**: ${res.look}\n\n`;
  }
  md += `Totals: ${em.lines.length} G-code lines, ${retractCount(em)} retractions, ${em.eTotal.toFixed(1)} mm commanded filament.\n`;
  writeFileSync(join(outDir, `${base}-MAP.md`), md);
  console.log(`${base}: ${em.lines.length} lines, ${retractCount(em)} retracts, ${em.eTotal.toFixed(1)}mm, warnings ${layout.warnings.length}`);
}

for (const idea of IDEAS.filter((i) => !only.length || only.includes(i.key))) writeFile(idea.key, idea.calY, [{ key: idea.key }]);
if (only.includes(SHEET.key)) writeFile(SHEET.key, SHEET.calY, SHEET.parts);
