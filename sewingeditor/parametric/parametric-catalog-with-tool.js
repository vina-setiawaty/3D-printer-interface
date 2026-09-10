// Scene compiler for parametric-with-tool.html (ES module; also imported by
// tests/parametric/*.mjs under node).
//
// The page holds a SCENE (see defaultScene()): elements with ids (a line
// path, a closed region boundary, or a point), a texture per element slot
// (brush + options, plus a fill pattern for regions), a global transform
// (scale + origin) and a list of parameter ABSTRACTIONS (high-level knobs
// that drive several low-level options by weight). Four LLM stages write
// into that scene; everything below the LLMs is deterministic:
//
//   resolveScene()   pieces -> vertex lists in graphic space, closure and
//                    simple-polygon checks, natural bbox
//   compileScene()   transform, pattern -> strokes/stamps clipped to the
//                    region, one JOB per brush/stamp call, hard/warn checks,
//                    geometry REPORT (the model verifies against this)
//   runJobs()        jobs -> G-code via texture_functions-with-tool.js's
//                    BRUSHES / STAMPS, bounds + retraction scan, digest
//   applyAbstractions() / rebaseOption()   the abstraction rule
//   validateStageOutput() / merge*()       stage JSON -> scene
//
// A model-supplied formula string is NEVER eval()'d or passed to
// `new Function()` -- see compileExpr(): a small hand-rolled tokenizer +
// recursive-descent parser + AST evaluator with a closed whitelist of
// operators/functions. There is no code path from a formula string to any
// JS object, global, or property access outside that grammar.

import * as TF from "./parametric_docs/texture_functions-with-tool.js";

export const SCENE_VERSION = 2;

// Runtime limits: only what has a physical consequence. Perceptual limits
// ("reads as scattered dots") live in the prompt docs and the option
// min/max below, not here.
export const CONSTRAINTS = {
  bed: 220,
  safeMin: 15, safeMax: 205,   // safe area for every printed coordinate
  closureSnapMm: 0.5,          // boundary end within this of its start snaps closed
  minDomeDiameter: 0.8,        // hard: blob / hairy-root / disc / 2*dotRadius
  minDiscHeight: 0.4,          // hard
  minLayers: 2,                // hard: relief floor 0.4mm
  zGapFloor: 0.25,             // hard
  minSolidSheetGap: 0.35,      // hard: hatch gap with the solid brush
  minBeadWidth: 0.4,           // warn
  blobDottedGapOverDiameter: 1.0,  // warn: gap >= diameter + this
  hairyDottedGapOverRoot: 2.0,     // warn: gap >= rootDiameter + this
  minDottedGapOverDot: 1.0,        // warn: gap >= 2*dotRadius + this
  minHairSpacing: 2.5,             // warn
  minHairyFillRowGap: 4.0,         // warn: hatch gap with the hairy brush
  retractCyclesWarn: 250,
  retractCyclesHard: 2000,
};

// ---------------------------------------------------------------- options --

// kind: "num" | "int" | "nnum" (nullable number) | "enum". min/max are the
// slider spans the abstraction rule uses and the input clamps.
const N = (def, min, max, step) => ({ kind: "num", def, min, max, step: step ?? 0.1 });
const I = (def, min, max) => ({ kind: "int", def, min, max, step: 1 });
const NN = (def) => ({ kind: "nnum", def });
const EN = (def, options) => ({ kind: "enum", def, options });

const BLOB_BUILD_OPTS = {
  baseZ: N(0.2, 0.1, 0.6), buildSteps: I(6, 1, 20), taperFactor: N(0.7, 0, 1),
  extrudeSpeed: N(120, 20, 600, 5), dwellMs: I(2000, 0, 8000),
  extrusionMultiplier: N(1.3, 0.5, 3), retractMm: N(4.0, 0, 8),
  postRetractDwellMs: I(2000, 0, 8000), baseExtraMm: N(0.3, 0, 2),
  baseDwellMs: I(1000, 0, 5000),
};
const ORBIT_OPTS = {
  orbitRadius: NN(null), orbitPts: I(16, 3, 48), orbitSpeed: N(600, 100, 2000, 10), orbitLoops: I(3, 0, 10),
};
const HAIR_OPTS = {
  hairLength: N(3.0, 1, 30), hairThickness: NN(null),
  hairDirection: EN("top", ["top", "right", "left", "bottom"]),
  hairAzimuthDeg: NN(null), hairElevationDeg: NN(null), beadFlowMult: N(3.5, 1, 6),
  pullExtrudeSpeed: N(150, 30, 600, 5), stringMm: N(2.0, 0, 10), overtravelMm: N(2.0, 0, 10),
};

// Line brushes: what is deposited ALONG a point list.
export const BRUSH_OPTIONS = {
  solid: { width: N(0.5, 0.3, 3), nLayers: I(2, 1, 10), speed: N(400, 50, 1500, 10) },
  dashed: { segLen: N(8, 1, 60), gapLen: N(4, 1, 60), width: N(0.5, 0.3, 3), nLayers: I(2, 1, 10), speed: N(400, 50, 1500, 10) },
  dotted: { gap: N(10, 1, 60), dotRadius: N(0.8, 0.3, 3), nLayers: I(2, 1, 10), speed: N(250, 50, 1000, 10) },
  blobDotted: { gap: N(10, 1, 60), diameter: N(1.6, 0.6, 8), ...BLOB_BUILD_OPTS, ...ORBIT_OPTS },
  directionalBlobDotted: {
    gap: NN(null), diameter: N(2.0, 0.6, 8), azimuthDeg: N(0, -180, 180, 1),
    dragSpeed: N(600, 100, 2000, 10), stampOrder: EN("auto", ["auto", "forward", "reverse"]), ...BLOB_BUILD_OPTS,
  },
  hairy: {
    spacing: N(5.0, 1, 30), esegmentMm: N(1.2, 0.2, 4), retractMm: N(1.3, 0, 6), dwellMs: I(400, 0, 3000),
    smallLift: N(0.2, 0, 2), bigLift: N(4.0, 1, 10), baseZ: N(0.3, 0.1, 1), speed: N(200, 50, 1000, 10),
  },
  hairyDotted: {
    gap: N(10, 1, 60), rootDiameter: N(2.0, 0.6, 8), ...HAIR_OPTS,
    stampOrder: EN("auto", ["auto", "forward", "reverse"]), ...BLOB_BUILD_OPTS,
  },
  segmented: {
    thinLen: N(8, 1, 40), thinWidth: N(0.8, 0.3, 3), thinHeight: N(0.2, 0.1, 0.6), thinSpeed: N(130, 30, 600, 5),
    fatLen: N(4, 1, 40), fatWidth: N(1.6, 0.3, 4), fatHeight: N(0.3, 0.1, 0.8), fatSpeed: N(60, 20, 400, 5),
    flowMult: N(1.4, 0.5, 3), segDwellMs: I(250, 0, 2000),
  },
  variableThickness: {
    hMin: N(0.16, 0.1, 1), hMax: N(0.9, 0.2, 2), wavelength: N(8.0, 2, 40),
    beadWidth: N(0.8, 0.3, 3), zGap: N(0.25, 0.25, 1), speed: N(25, 10, 300, 5),
  },
};

// Stamps: what is deposited AT a point.
export const STAMP_OPTIONS = {
  blob: { diameter: N(1.6, 0.6, 8), ...BLOB_BUILD_OPTS, ...ORBIT_OPTS },
  disc: { diameter: N(1.6, 0.6, 8), height: N(0.4, 0.4, 3, 0.2), speed: N(250, 50, 1000, 10) },
  directionalBlob: { diameter: N(2.0, 0.6, 8), azimuthDeg: N(0, -180, 180, 1), dragSpeed: N(600, 100, 2000, 10), ...BLOB_BUILD_OPTS },
  hairyDot: { rootDiameter: N(2.0, 0.6, 8), ...HAIR_OPTS, ...BLOB_BUILD_OPTS },
};

// Built-in fill patterns with editable numeric specs. The free-form kinds
// (stamps / strokes / curves / family) carry their own JSON and are edited
// as text.
export const PATTERN_OPTIONS = {
  hatch: { angleDeg: N(0, -180, 180, 1), gap: N(4.0, 0.3, 20) },
  grid: { dx: N(6, 1, 40), dy: N(6, 1, 40), angleDeg: N(0, -180, 180, 1) },
  diamond: { diag: N(8.0, 2, 30), fillGap: N(0.6, 0.35, 3) },
};
export const PATTERN_KINDS = ["hatch", "grid", "diamond", "stamps", "strokes", "curves", "family"];
export const STAMP_PATTERNS = ["grid", "stamps"];           // these need a stamp fn
export const BRUSH_NAMES = Object.keys(BRUSH_OPTIONS);
export const STAMP_NAMES = Object.keys(STAMP_OPTIONS);

// One-line semantic descriptor per option name (shared names share a
// meaning) -- what it does physically and which way is "more". Sent to the
// parameters stage with the numeric spec; shown as a tooltip in the UI.
export const OPTION_DESC = {
  width: "bead width in mm; wider = broader, more prominent ridge",
  beadWidth: "bead width in mm; wider = broader ridge",
  nLayers: "stacked 0.2mm layers; more = taller relief",
  speed: "print speed mm/min; slower = cleaner deposition",
  segLen: "dash length in mm along the path",
  gapLen: "gap between dashes in mm; larger = sparser dashes",
  gap: "spacing between stamps / dashes / hatch rows in mm; smaller = denser",
  dotRadius: "radius of each flat disc in mm",
  diameter: "dome diameter in mm; larger = bigger, taller bump",
  rootDiameter: "diameter of the root dome under each hair in mm; larger = tougher hair",
  azimuthDeg: "lean / rake direction in degrees CCW from +X (offset from the path tangent on a line)",
  dragSpeed: "speed of the squish-and-drag that shapes a leaning dome",
  stampOrder: "walk the path forward or reverse so each dome leans over already-cooled ones",
  spacing: "distance between hair strands in mm; smaller = denser, hairier",
  esegmentMm: "filament extruded per strand in mm; more = thicker strand",
  retractMm: "retraction distance in mm after each strand / dome",
  dwellMs: "pause after depositing, ms; longer = more solidified before moving",
  smallLift: "first small lift after the strand root in mm",
  bigLift: "pull height in mm; taller = longer strand",
  baseZ: "nozzle height at first contact in mm",
  hairLength: "pulled hair length in mm; longer = longer, more flexible strand",
  hairThickness: "hair bead thickness in mm (blank = derived from hairLength)",
  hairDirection: "which way the hair is pulled: top (up), right, left, bottom",
  hairAzimuthDeg: "explicit hair azimuth in degrees CCW from +X (overrides hairDirection)",
  hairElevationDeg: "explicit hair elevation in degrees; 0 flat, 90 straight up",
  beadFlowMult: "extra flow while pulling the hair; more = fatter strand",
  pullExtrudeSpeed: "speed of the hair pull mm/min; slower = thicker",
  stringMm: "fast no-extrusion string break after the pull, mm",
  overtravelMm: "clearance travel after the string, mm",
  thinLen: "length of each thin segment, mm", thinWidth: "bead width of thin segments, mm",
  thinHeight: "bead height of thin segments, mm", thinSpeed: "speed on thin segments",
  fatLen: "length of each fat segment, mm", fatWidth: "bead width of fat segments, mm",
  fatHeight: "bead height of fat segments, mm", fatSpeed: "speed on fat segments",
  flowMult: "flow multiplier for the whole segmented line",
  segDwellMs: "pause at each segment change, ms",
  hMin: "lowest bead height of the swelling ridge, mm", hMax: "highest bead height of the swelling ridge, mm",
  wavelength: "distance between swells, mm; shorter = more frequent bumps",
  zGap: "nozzle-to-bead clearance, mm (never below 0.25)",
  height: "disc height in mm, multiple of 0.2",
  buildSteps: "Z increments while building a dome", taperFactor: "how much extrusion tapers toward the dome top",
  extrudeSpeed: "extrusion feed while building a dome", extrusionMultiplier: "dome volume multiplier; more = fatter dome",
  postRetractDwellMs: "pause after retracting, ms", baseExtraMm: "extra first-contact filament, mm",
  baseDwellMs: "pause after the first-contact blob, ms",
  orbitRadius: "anti-string orbit radius, mm (blank = dome radius, 0 = off)", orbitPts: "points per orbit loop",
  orbitSpeed: "orbit travel speed", orbitLoops: "number of orbit loops",
  angleDeg: "hatch / grid rotation in degrees CCW from +X",
  dx: "grid spacing along the grid's X in mm", dy: "grid spacing along the grid's Y in mm",
  diag: "diamond cell diagonal in mm; larger = bigger cells", fillGap: "scanline gap inside filled cells, mm",
};

export function optionSpecFor(fn) {
  return BRUSH_OPTIONS[fn] || STAMP_OPTIONS[fn] || {};
}
export function isBrush(fn) { return fn in BRUSH_OPTIONS; }
export function isStamp(fn) { return fn in STAMP_OPTIONS; }

// ---------------------------------------------------------- safe expression --

const FN1 = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log };
const FN2 = { min: Math.min, max: Math.max, pow: Math.pow };

function tokenizeExpr(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`bad number "${text}" in expression`);
      toks.push({ type: "num", value: parseFloat(text) });
      i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      toks.push({ type: "ident", value: src.slice(i, j) });
      i = j; continue;
    }
    if ("+-*/^(),".includes(c)) { toks.push({ type: c }); i++; continue; }
    throw new Error(`unexpected character "${c}" in expression`);
  }
  toks.push({ type: "eof" });
  return toks;
}

function parseExprTokens(toks, vars) {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (type) => { if (peek().type !== type) throw new Error(`expected "${type}", got "${peek().type}"`); return next(); };

  function parseExpr() {
    let node = parseTerm();
    while (peek().type === "+" || peek().type === "-") {
      const op = next().type;
      node = { type: "bin", op, left: node, right: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseUnary();
    while (peek().type === "*" || peek().type === "/") {
      const op = next().type;
      node = { type: "bin", op, left: node, right: parseUnary() };
    }
    return node;
  }
  function parseUnary() {
    if (peek().type === "-") { next(); return { type: "un", op: "-", arg: parseUnary() }; }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (peek().type === "^") { next(); return { type: "bin", op: "^", left: base, right: parseUnary() }; }
    return base;
  }
  function parseAtom() {
    const tok = peek();
    if (tok.type === "num") { next(); return { type: "num", value: tok.value }; }
    if (tok.type === "(") {
      next();
      const node = parseExpr();
      expect(")");
      return node;
    }
    if (tok.type === "ident") {
      next();
      const name = tok.value;
      if (peek().type === "(") {
        next();
        const args = [parseExpr()];
        while (peek().type === ",") { next(); args.push(parseExpr()); }
        expect(")");
        if (name in FN1) {
          if (args.length !== 1) throw new Error(`${name}() takes exactly 1 argument`);
          return { type: "call1", fn: name, arg: args[0] };
        }
        if (name in FN2) {
          if (args.length !== 2) throw new Error(`${name}() takes exactly 2 arguments`);
          return { type: "call2", fn: name, args };
        }
        throw new Error(`unknown function "${name}" -- allowed: ${Object.keys(FN1).concat(Object.keys(FN2)).join(", ")}`);
      }
      const vi = vars.indexOf(name);
      if (vi >= 0) return { type: "var", idx: vi };
      if (name === "pi") return { type: "const", value: Math.PI };
      throw new Error(`unknown identifier "${name}" -- only ${vars.map((v) => `"${v}"`).join(", ")} and "pi" are defined`);
    }
    throw new Error(`unexpected token "${tok.type}" in expression`);
  }

  const result = parseExpr();
  expect("eof");
  return result;
}

function evalExprNode(node, args) {
  switch (node.type) {
    case "num": return node.value;
    case "const": return node.value;
    case "var": return args[node.idx];
    case "un": return -evalExprNode(node.arg, args);
    case "call1": return FN1[node.fn](evalExprNode(node.arg, args));
    case "call2": return FN2[node.fn](evalExprNode(node.args[0], args), evalExprNode(node.args[1], args));
    case "bin": {
      const a = evalExprNode(node.left, args), b = evalExprNode(node.right, args);
      switch (node.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
      }
    }
  }
  throw new Error(`unhandled expression node "${node.type}"`);
}

/** Compiles a formula string in the given variables (default ["t"]; a
 * fill family uses ["t", "u"]) into a plain function (t, u) => number.
 * Never uses eval()/Function() -- parses into a closed AST via a
 * whitelisted grammar, then evaluates that AST with a switch we control.
 * Throws at compile time on anything outside the grammar. */
export function compileExpr(src, vars = ["t"]) {
  if (typeof src !== "string" || !src.trim()) throw new Error("expression must be a non-empty string");
  const ast = parseExprTokens(tokenizeExpr(src), vars);
  return (...args) => evalExprNode(ast, args);
}

// ------------------------------------------------------------- 2D helpers --

const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
function mergeBbox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}
function polylineLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += dist2(points[i - 1], points[i]);
  return s;
}
function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}
function dedupeConsecutive(points, eps = 1e-6) {
  const out = [];
  for (const p of points) if (!out.length || dist2(out[out.length - 1], p) > eps) out.push(p);
  return out;
}

export function pointInPolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Parameters (t along ab, u along cd) of the proper intersection of two
// segments, or null if they do not cross (touching endpoints excluded).
// With `inclusiveU` a crossing exactly through an endpoint of cd counts
// too -- the clipper needs that so a stroke passing through a polygon
// VERTEX still gets split there (it is then found on both adjacent
// edges at the same t, which the clipper's zero-length skip absorbs).
function segCross(a, b, c, d, inclusiveU = false) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / denom, u = (qx * ry - qy * rx) / denom;
  if (t <= 1e-9 || t >= 1 - 1e-9) return null;
  if (inclusiveU ? (u < -1e-9 || u > 1 + 1e-9) : (u <= 1e-9 || u >= 1 - 1e-9)) return null;
  return { t, u };
}

/** True if a closed polygon has no self-intersections (non-adjacent edges
 * never cross). O(n^2) -- boundaries are at most a few thousand points. */
export function isSimplePolygon(poly) {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;   // closing edge is adjacent to edge 0
      if (segCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** True if two simple polygons overlap in area (edges cross, or one
 * contains a vertex of the other). */
export function polygonsOverlap(a, b) {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/** Clips a polyline to the inside of a polygon: splits every segment at
 * its crossings with the polygon's edges, keeps the sub-segments whose
 * midpoint is inside, and joins consecutive kept pieces into runs.
 * Returns an array of polylines (each >= 2 points). */
export function clipPolylineToPolygon(points, poly) {
  const runs = [];
  let cur = [];
  const flush = () => { if (cur.length > 1) runs.push(cur); cur = []; };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (dist2(a, b) < 1e-9) continue;
    const ts = [0, 1];
    for (let j = 0; j < poly.length; j++) {
      const x = segCross(a, b, poly[j], poly[(j + 1) % poly.length], true);
      if (x) ts.push(x.t);
    }
    ts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const pa = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const pb = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      if (pointInPolygon(mid, poly)) {
        if (cur.length && dist2(cur[cur.length - 1], pa) < 1e-6) cur.push(pb);
        else { flush(); cur = [pa, pb]; }
      } else {
        flush();
      }
    }
  }
  flush();
  return runs;
}

// ---------------------------------------------------------------- scene --

export function defaultScene() {
  return {
    version: SCENE_VERSION,
    config: { material: "TPU" },
    transform: { scale: 1.0, origin: null },
    elements: [],
    textures: {},
    abstractions: [],
    messages: [],
    lastReport: null,
  };
}

/** Coerces a stored blob into a valid scene; anything from an older
 * format (or garbage) becomes a fresh scene. */
export function normalizeScene(raw) {
  const s = defaultScene();
  if (!raw || raw.version !== SCENE_VERSION) return s;
  s.config = { ...s.config, ...(raw.config || {}) };
  s.transform = { scale: Number(raw.transform?.scale) || 1.0, origin: Array.isArray(raw.transform?.origin) ? raw.transform.origin : null };
  s.elements = Array.isArray(raw.elements) ? raw.elements : [];
  s.textures = raw.textures && typeof raw.textures === "object" ? raw.textures : {};
  s.abstractions = Array.isArray(raw.abstractions) ? raw.abstractions : [];
  s.messages = Array.isArray(raw.messages) ? raw.messages : [];
  s.lastReport = raw.lastReport || null;
  return s;
}

export function nextId(scene, prefix) {
  let n = 1;
  const taken = new Set([...scene.elements.map((e) => e.id), ...scene.abstractions.map((a) => a.id)]);
  while (taken.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

const SLOTS_FOR_KIND = { line: ["brush"], point: ["brush"], region: ["outline", "fill"] };
export function slotsFor(kind) { return SLOTS_FOR_KIND[kind] || []; }

// ------------------------------------------------------------- resolution --

const SAMPLE_STEP = 0.1;

function checkPointList(points, what) {
  if (!Array.isArray(points) || points.length < 2) throw new Error(`${what}: needs at least 2 points`);
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`${what}: every point must be [x, y]`);
  }
  return points.map((p) => [p[0], p[1]]);
}

function sampleFormula(spec, what, tFrom = 0, tTo = null) {
  if (typeof spec.x !== "string" || typeof spec.y !== "string" || !Number.isFinite(spec.tEnd)) {
    throw new Error(`${what}: a formula piece is {"x": "<expr in t>", "y": "<expr in t>", "tEnd": <number>}`);
  }
  const fx = compileExpr(spec.x), fy = compileExpr(spec.y);
  const t0 = tFrom ?? 0, t1 = tTo ?? spec.tEnd;
  if (!(t1 > t0)) throw new Error(`${what}: t range must be increasing (got ${t0}..${t1})`);
  return TF.samplePath((t) => fx(t), (t) => fy(t), t0, t1, { step: SAMPLE_STEP }).map((p) => [p[0], p[1]]);
}

/** A piece -> vertex list in graphic space (no arc-length tag yet). */
function resolvePiece(piece, scene, what, depth = 0) {
  if (!piece || typeof piece !== "object") throw new Error(`${what}: missing piece`);
  if (Array.isArray(piece.points)) return checkPointList(piece.points, what);
  if (typeof piece.ref === "string") {
    if (depth > 2) throw new Error(`${what}: ref chain too deep`);
    const target = scene.elements.find((e) => e.id === piece.ref);
    if (!target) throw new Error(`${what}: ref "${piece.ref}" is not an element id`);
    if (target.kind !== "line") throw new Error(`${what}: ref "${piece.ref}" must be a line element`);
    let pts;
    if (Array.isArray(target.path?.points)) pts = checkPointList(target.path.points, what);
    else pts = sampleFormula(target.path || {}, `${what} (ref ${piece.ref})`, piece.tFrom ?? 0, piece.tTo ?? target.path?.tEnd);
    return piece.reverse ? pts.slice().reverse() : pts;
  }
  return sampleFormula(piece, what);
}

/** Resolves every element to vertex lists in GRAPHIC space and validates
 * region boundaries. Returns { resolved: {id -> {points|polygon, closureGap}},
 * errors, bbox }. Errors are per element; a failed element is skipped. */
export function resolveScene(scene) {
  const resolved = {}, errors = [], warnings = [];
  let bbox = null;
  for (const el of scene.elements) {
    const what = `"${el.label || el.id}"`;
    try {
      if (el.kind === "point") {
        if (!Array.isArray(el.at) || el.at.length !== 2 || !el.at.every(Number.isFinite)) throw new Error(`${what}: point needs at = [x, y]`);
        resolved[el.id] = { kind: "point", at: [el.at[0], el.at[1]] };
        bbox = mergeBbox(bbox, bboxOf([el.at]));
      } else if (el.kind === "line") {
        const pts = dedupeConsecutive(resolvePiece(el.path, scene, what));
        if (pts.length < 2) throw new Error(`${what}: path has no length`);
        resolved[el.id] = { kind: "line", points: pts, dense: !Array.isArray(el.path?.points) };
        bbox = mergeBbox(bbox, bboxOf(pts));
      } else if (el.kind === "region") {
        if (!Array.isArray(el.boundary) || !el.boundary.length) throw new Error(`${what}: region needs a boundary piece list`);
        let poly = [];
        el.boundary.forEach((piece, i) => { poly.push(...resolvePiece(piece, scene, `${what} boundary piece ${i + 1}`)); });
        poly = dedupeConsecutive(poly);
        // Closure: an end within closureSnapMm of the start snaps onto it;
        // a larger gap is closed with a straight edge (natural for point
        // lists; reported as closureGap so a formula boundary that was
        // meant to close shows up in the report and gets a warning).
        const closureGap = poly.length > 1 ? dist2(poly[0], poly[poly.length - 1]) : Infinity;
        if (closureGap <= CONSTRAINTS.closureSnapMm) poly.pop();
        else if (el.boundary.some((p) => !Array.isArray(p.points))) warnings.push(`${what}: boundary end is ${closureGap.toFixed(1)}mm from its start -- closed with a straight edge.`);
        if (poly.length < 3) throw new Error(`${what}: boundary needs at least 3 distinct points`);
        if (!isSimplePolygon(poly)) throw new Error(`${what}: boundary crosses itself -- a fill region must be a simple, single-contour shape`);
        resolved[el.id] = { kind: "region", polygon: poly, closureGap };
        bbox = mergeBbox(bbox, bboxOf(poly));
      } else {
        throw new Error(`${what}: unknown kind "${el.kind}"`);
      }
    } catch (e) {
      errors.push(e && e.name === "PathTooSteepError" ? `${what}: path is too steep to print -- ${e.message}` : String(e.message || e));
    }
  }
  return { resolved, errors, warnings, bbox };
}

// ---------------------------------------------------------------- transform --

/** The affine map graphic -> bed space: natural bbox min corner lands on
 * transform.origin (or stays put when origin is null), scaled about it. */
export function transformFor(scene, naturalBbox) {
  const scale = Number(scene.transform?.scale) > 0 ? Number(scene.transform.scale) : 1;
  const minX = naturalBbox ? naturalBbox.minX : 0, minY = naturalBbox ? naturalBbox.minY : 0;
  const origin = Array.isArray(scene.transform?.origin) ? scene.transform.origin : [minX, minY];
  const map = ([x, y]) => [origin[0] + scale * (x - minX), origin[1] + scale * (y - minY)];
  return { scale, origin, minX, minY, map };
}

function rectOfPolygon(poly) {
  if (poly.length !== 4) return null;
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ok = poly.every(([x, y]) => (Math.abs(x - x0) < 1e-6 || Math.abs(x - x1) < 1e-6) && (Math.abs(y - y0) < 1e-6 || Math.abs(y - y1) < 1e-6));
  return ok ? { x0, y0, w: x1 - x0, h: y1 - y0 } : null;
}

// ----------------------------------------------------------------- patterns --

/** pattern spec + region polygon (bed space) + transform -> { strokes:
 * [{points, brushOverride?}], stamps: [[x,y]], newPatternOnce }.
 * Built-in kinds are generated in bed space with their spacing scaled;
 * free-form kinds are given in graphic space and mapped through `tf`. */
export function generatePattern(pattern, polygon, tf, what) {
  const kind = pattern?.kind;
  const strokes = [], stamps = [];
  const bb = bboxOf(polygon);
  const T = tf.map;

  if (kind === "hatch") {
    const gap = (Number(pattern.gap) || 4) * tf.scale;
    for (const seg of TF.hatchStrokes(polygon, Number(pattern.angleDeg) || 0, gap)) strokes.push({ points: seg });
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "diamond") {
    const rect = rectOfPolygon(polygon);
    if (!rect) throw new Error(`${what}: diamond fill needs an axis-aligned rectangular boundary`);
    const d = TF.diamondStrokes(rect, { diag: (Number(pattern.diag) || 8) * tf.scale, fillGap: (Number(pattern.fillGap) || 0.6) * tf.scale });
    for (const s of d.strokes) strokes.push({ points: s.points, brushOverride: s.brush, sparse: true });
    return { strokes, stamps, newPatternOnce: true, diamonds: d.diamonds };
  }
  if (kind === "grid") {
    const dx = (Number(pattern.dx) || 6) * tf.scale, dy = (Number(pattern.dy) || 6) * tf.scale;
    const a = ((Number(pattern.angleDeg) || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const r = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2 + Math.max(dx, dy);
    for (let i = -Math.ceil(r / dx); i <= Math.ceil(r / dx); i++) {
      for (let j = -Math.ceil(r / dy); j <= Math.ceil(r / dy); j++) {
        const lx = i * dx, ly = j * dy;
        const p = [cx + lx * ca - ly * sa, cy + lx * sa + ly * ca];
        if (pointInPolygon(p, polygon)) stamps.push(p);
      }
    }
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "stamps") {
    for (const p of checkPointList(pattern.points, `${what} stamps`)) { const q = T(p); if (pointInPolygon(q, polygon)) stamps.push(q); }
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "strokes") {
    if (!Array.isArray(pattern.strokes)) throw new Error(`${what}: strokes pattern needs "strokes": [[[x,y],...], ...]`);
    pattern.strokes.forEach((pl, i) => {
      for (const run of clipPolylineToPolygon(checkPointList(pl, `${what} stroke ${i + 1}`).map(T), polygon)) strokes.push({ points: run });
    });
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "curves") {
    if (!Array.isArray(pattern.curves)) throw new Error(`${what}: curves pattern needs "curves": [{x,y,tEnd}, ...]`);
    pattern.curves.forEach((c, i) => {
      for (const run of clipPolylineToPolygon(sampleFormula(c, `${what} curve ${i + 1}`).map(T), polygon)) strokes.push({ points: run });
    });
    return { strokes, stamps, newPatternOnce: false };
  }
  if (kind === "family") {
    if (typeof pattern.x !== "string" || typeof pattern.y !== "string" || !Number.isFinite(pattern.tEnd) || !Number.isFinite(pattern.uEnd) || !(Number(pattern.uStep) > 0)) {
      throw new Error(`${what}: family pattern needs {"x": "<expr in t,u>", "y": "<expr in t,u>", "tEnd", "uEnd", "uStep"}`);
    }
    const fx = compileExpr(pattern.x, ["t", "u"]), fy = compileExpr(pattern.y, ["t", "u"]);
    for (let u = 0; u <= pattern.uEnd + 1e-9; u += pattern.uStep) {
      const pts = TF.samplePath((t) => fx(t, u), (t) => fy(t, u), 0, pattern.tEnd, { step: SAMPLE_STEP }).map((p) => T([p[0], p[1]]));
      for (const run of clipPolylineToPolygon(pts, polygon)) strokes.push({ points: run });
    }
    return { strokes, stamps, newPatternOnce: false };
  }
  throw new Error(`${what}: unknown pattern kind "${kind}" (${PATTERN_KINDS.join(", ")})`);
}

// ------------------------------------------------------------------ rules --

// Physical checks on one brush/stamp's options (see CONSTRAINTS). `ctx`
// carries the pattern gap in bed mm for hatch fills.
export function checkBrushRules(fn, opts, ctx = {}, tag = fn) {
  const errors = [], warnings = [];
  const g = (k, d) => (opts[k] === undefined || opts[k] === null ? d : opts[k]);
  const spec = optionSpecFor(fn);
  const def = (k, fallback) => (spec[k] && spec[k].def != null ? spec[k].def : fallback);

  const diaKey = fn === "hairyDotted" || fn === "hairyDot" ? "rootDiameter" : (fn === "dotted" ? null : "diameter");
  if (diaKey && diaKey in spec) {
    const dia = g(diaKey, def(diaKey, 1.6));
    if (dia < CONSTRAINTS.minDomeDiameter) errors.push(`${tag}: ${diaKey} ${dia}mm is below the ${CONSTRAINTS.minDomeDiameter}mm minimum.`);
  }
  if (fn === "dotted" && 2 * g("dotRadius", 0.8) < CONSTRAINTS.minDomeDiameter) errors.push(`${tag}: dotRadius ${g("dotRadius")}mm makes a disc below the ${CONSTRAINTS.minDomeDiameter}mm minimum.`);
  if (fn === "disc" && g("height", 0.4) < CONSTRAINTS.minDiscHeight) errors.push(`${tag}: height below ${CONSTRAINTS.minDiscHeight}mm.`);
  if ("nLayers" in spec && g("nLayers", 2) < CONSTRAINTS.minLayers) errors.push(`${tag}: nLayers ${g("nLayers")} is below ${CONSTRAINTS.minLayers} -- relief will not be felt.`);
  if (fn === "variableThickness" && g("zGap", 0.25) < CONSTRAINTS.zGapFloor) errors.push(`${tag}: zGap below the ${CONSTRAINTS.zGapFloor}mm floor (prints flat).`);
  if (ctx.hatchGap != null) {
    if (fn === "solid" && ctx.hatchGap < CONSTRAINTS.minSolidSheetGap) errors.push(`${tag}: hatch gap ${ctx.hatchGap.toFixed(2)}mm below ${CONSTRAINTS.minSolidSheetGap}mm -- severe over-extrusion.`);
    if (fn === "hairy" && ctx.hatchGap < CONSTRAINTS.minHairyFillRowGap) warnings.push(`${tag}: hairy hatch row gap ${ctx.hatchGap.toFixed(1)}mm below ${CONSTRAINTS.minHairyFillRowGap}mm -- rows may fuse.`);
  }

  for (const k of ["width", "beadWidth", "thinWidth"]) {
    if (k in spec && g(k, def(k, 0.5)) < CONSTRAINTS.minBeadWidth) warnings.push(`${tag}: ${k} below ${CONSTRAINTS.minBeadWidth}mm.`);
  }
  if (fn === "blobDotted") {
    const dia = g("diameter", 1.6), gap = g("gap", 10);
    if (gap < dia + CONSTRAINTS.blobDottedGapOverDiameter) warnings.push(`${tag}: gap ${gap}mm is tight for diameter ${dia}mm -- adjacent domes may fuse (want >= ${(dia + CONSTRAINTS.blobDottedGapOverDiameter).toFixed(1)}mm).`);
  }
  if (fn === "directionalBlobDotted") {
    const dia = g("diameter", 2.0), gap = g("gap", dia);
    if (gap < dia) warnings.push(`${tag}: gap ${gap}mm is below the diameter ${dia}mm -- domes overlap.`);
  }
  if (fn === "hairyDotted") {
    const root = g("rootDiameter", 2.0), gap = g("gap", 10);
    if (gap < root + CONSTRAINTS.hairyDottedGapOverRoot) warnings.push(`${tag}: gap ${gap}mm is tight for rootDiameter ${root}mm (want >= ${root + CONSTRAINTS.hairyDottedGapOverRoot}mm).`);
  }
  if (fn === "dotted") {
    const dr = g("dotRadius", 0.8), gap = g("gap", 10);
    if (gap < 2 * dr + CONSTRAINTS.minDottedGapOverDot) warnings.push(`${tag}: gap ${gap}mm is tight for dotRadius ${dr}mm.`);
  }
  if (fn === "hairy" && g("spacing", 5) < CONSTRAINTS.minHairSpacing) warnings.push(`${tag}: strand spacing ${g("spacing")}mm below ${CONSTRAINTS.minHairSpacing}mm -- strands may fuse.`);
  return { errors, warnings };
}

function cleanOptions(fn, options) {
  const opts = {};
  for (const [k, v] of Object.entries(options || {})) if (v !== null && v !== undefined && v !== "") opts[k] = v;
  if (fn === "dashed") { opts.segLen ??= BRUSH_OPTIONS.dashed.segLen.def; opts.gapLen ??= BRUSH_OPTIONS.dashed.gapLen.def; }
  return opts;
}

// ---------------------------------------------------------------- compile --

/** scene -> { jobs, report, errors, warnings, bbox }. A job is
 * { elementId, slot, label, kind: "brush"|"stamp", fn, options, pts | at,
 * newPattern }. */
export function compileScene(scene) {
  const { resolved, errors, warnings, bbox: naturalBbox } = resolveScene(scene);
  const tf = transformFor(scene, naturalBbox);
  const jobs = [];
  const report = { transform: { scale: tf.scale, origin: tf.origin.map((v) => +v.toFixed(2)) }, elements: [], chart: {} };
  const fillPolys = [];
  let bedBbox = null;

  const outOfSafe = (points) => points.some(([x, y]) => x < CONSTRAINTS.safeMin || x > CONSTRAINTS.safeMax || y < CONSTRAINTS.safeMin || y > CONSTRAINTS.safeMax);
  const rnd = (v) => +v.toFixed(2);
  const rndBox = (b) => ({ minX: rnd(b.minX), minY: rnd(b.minY), maxX: rnd(b.maxX), maxY: rnd(b.maxY) });

  for (const el of scene.elements) {
    const r = resolved[el.id];
    if (!r) continue;
    const label = el.label || el.id;
    const tex = scene.textures[el.id] || {};
    const entry = { id: el.id, label, kind: el.kind, role: el.role || "" };
    report.elements.push(entry);

    const addBrushJob = (slot, fn, options, pts, extra = {}, ctx = {}) => {
      const tag = `"${label}" ${slot}`;
      if (!isBrush(fn)) { errors.push(`${tag}: "${fn}" is not a line brush (${BRUSH_NAMES.join(", ")}).`); return false; }
      const opts = cleanOptions(fn, options);
      const rule = checkBrushRules(fn, opts, ctx, tag);
      errors.push(...rule.errors); warnings.push(...rule.warnings);
      jobs.push({ elementId: el.id, slot, label, kind: "brush", fn, options: { ...opts, ...(extra.brushOverride || {}) }, pts, newPattern: extra.newPattern ?? true });
      return true;
    };
    const addStampJob = (slot, fn, options, at) => {
      const tag = `"${label}" ${slot}`;
      if (!isStamp(fn)) { errors.push(`${tag}: "${fn}" is not a stamp (${STAMP_NAMES.join(", ")}).`); return false; }
      const opts = cleanOptions(fn, options);
      const rule = checkBrushRules(fn, opts, {}, tag);
      errors.push(...rule.errors); warnings.push(...rule.warnings);
      jobs.push({ elementId: el.id, slot, label, kind: "stamp", fn, options: opts, at, newPattern: true });
      return true;
    };

    try {
      if (r.kind === "point") {
        const at = tf.map(r.at);
        entry.at = at.map(rnd);
        bedBbox = mergeBbox(bedBbox, bboxOf([at]));
        if (outOfSafe([at])) errors.push(`"${label}": point is outside the safe area (${CONSTRAINTS.safeMin}-${CONSTRAINTS.safeMax}mm).`);
        if (tex.brush?.fn) addStampJob("brush", tex.brush.fn, tex.brush.options, at);
      } else if (r.kind === "line") {
        const pts = r.points.map(tf.map);
        const bb = bboxOf(pts);
        entry.bbox = rndBox(bb); entry.length = rnd(polylineLength(pts));
        entry.start = pts[0].map(rnd); entry.end = pts[pts.length - 1].map(rnd);
        if (r.dense && pts.length > 5) {
          const n = 5;
          entry.samples = [];
          for (let i = 0; i < n; i++) entry.samples.push(pts[Math.round(((pts.length - 1) * i) / (n - 1))].map(rnd));
        }
        bedBbox = mergeBbox(bedBbox, bb);
        if (outOfSafe(pts)) errors.push(`"${label}": path leaves the safe area (${CONSTRAINTS.safeMin}-${CONSTRAINTS.safeMax}mm).`);
        if (tex.brush?.fn) addBrushJob("brush", tex.brush.fn, tex.brush.options, TF.polylineToPts(pts, r.dense ? null : SAMPLE_STEP));
      } else if (r.kind === "region") {
        const poly = r.polygon.map(tf.map);
        const bb = bboxOf(poly);
        entry.bbox = rndBox(bb); entry.area = rnd(polygonArea(poly)); entry.closureGap = rnd(r.closureGap);
        entry.width = rnd(bb.maxX - bb.minX); entry.height = rnd(bb.maxY - bb.minY);
        bedBbox = mergeBbox(bedBbox, bb);
        if (outOfSafe(poly)) errors.push(`"${label}": boundary leaves the safe area (${CONSTRAINTS.safeMin}-${CONSTRAINTS.safeMax}mm).`);
        if (tex.outline?.fn) addBrushJob("outline", tex.outline.fn, tex.outline.options, TF.polylineToPts([...poly, poly[0]], SAMPLE_STEP));
        if (tex.fill?.fn) {
          fillPolys.push({ id: el.id, label, poly });
          const pat = tex.fill.pattern || { kind: "hatch" };
          const gen = generatePattern(pat, poly, tf, `"${label}" fill`);
          entry.fill = { kind: pat.kind, strokes: gen.strokes.length, stamps: gen.stamps.length, strokeLength: rnd(gen.strokes.reduce((s, st) => s + polylineLength(st.points), 0)) };
          const needsStamp = STAMP_PATTERNS.includes(pat.kind);
          if (needsStamp && !isStamp(tex.fill.fn)) errors.push(`"${label}" fill: pattern "${pat.kind}" places stamps, so the fill brush must be a stamp (${STAMP_NAMES.join(", ")}), not "${tex.fill.fn}".`);
          else if (!needsStamp && !isBrush(tex.fill.fn)) errors.push(`"${label}" fill: pattern "${pat.kind}" draws strokes, so the fill brush must be a line brush (${BRUSH_NAMES.join(", ")}), not "${tex.fill.fn}".`);
          else if (needsStamp) {
            for (const at of gen.stamps) addStampJob("fill", tex.fill.fn, tex.fill.options, at);
          } else {
            const ctx = pat.kind === "hatch" ? { hatchGap: (Number(pat.gap) || 4) * tf.scale } : {};
            gen.strokes.forEach((st, i) => {
              addBrushJob("fill", tex.fill.fn, tex.fill.options, TF.polylineToPts(st.points, st.sparse ? null : SAMPLE_STEP),
                { brushOverride: st.brushOverride, newPattern: gen.newPatternOnce ? i === 0 : true }, i === 0 ? ctx : {});
            });
            if (gen.strokes.length && !gen.strokes.some((st) => st.points.length > 1)) warnings.push(`"${label}" fill: pattern produced no printable strokes inside the region.`);
          }
          if (!gen.strokes.length && !gen.stamps.length) warnings.push(`"${label}" fill: the pattern produced nothing inside the region.`);
        }
      }
    } catch (e) {
      errors.push(e && e.name === "PathTooSteepError" ? `"${label}": path is too steep to print -- ${e.message}` : String(e.message || e));
    }
  }

  // fill-on-fill overlap between different elements (polygon test)
  for (let i = 0; i < fillPolys.length; i++) {
    for (let j = i + 1; j < fillPolys.length; j++) {
      if (polygonsOverlap(fillPolys[i].poly, fillPolys[j].poly)) warnings.push(`fills of "${fillPolys[i].label}" and "${fillPolys[j].label}" overlap -- double deposition where they share area.`);
    }
  }

  // chart-role table
  const bars = report.elements.filter((e) => e.role === "bar" && e.bbox);
  if (bars.length) report.chart.bars = bars.map((e) => ({ label: e.label, x: e.bbox.minX, width: e.width, height: e.height }));
  const axes = report.elements.filter((e) => e.role === "axis" && e.bbox);
  if (axes.length) report.chart.axes = axes.map((e) => ({ label: e.label, from: e.start, to: e.end }));
  const curves = report.elements.filter((e) => e.role === "curve" && e.bbox);
  if (curves.length) report.chart.curves = curves.map((e) => ({ label: e.label, xRange: [e.bbox.minX, e.bbox.maxX], yRange: [e.bbox.minY, e.bbox.maxY], samples: e.samples }));
  report.bbox = bedBbox ? rndBox(bedBbox) : null;
  report.naturalBbox = naturalBbox ? rndBox(naturalBbox) : null;

  return { jobs, report, errors, warnings, bbox: bedBbox };
}

// ------------------------------------------------------------- gcode scan --

// Walks the emitted G-code tracking G90/G91 and absolute position so the
// bed-bounds check reasons about real coordinates (the segmented brush
// and the footer emit G91 relative moves). Counts retraction cycles.
export function scanGcode(lines) {
  let retractCycles = 0, absolute = true, px = null, py = null;
  const outOfBounds = [];
  const num = (line, axis) => {
    const m = line.match(new RegExp(`(?:^|\\s)${axis}(-?\\d+(?:\\.\\d+)?)`));
    return m ? parseFloat(m[1]) : null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const cmd = line.split(/\s+/)[0];
    if (cmd === "G90") { absolute = true; continue; }
    if (cmd === "G91") { absolute = false; continue; }
    if (cmd === "G28") { px = 0; py = 0; continue; }
    if (cmd === "G92") { const gx = num(line, "X"), gy = num(line, "Y"); if (gx !== null) px = gx; if (gy !== null) py = gy; continue; }
    if (cmd !== "G0" && cmd !== "G1" && cmd !== "G2" && cmd !== "G3") continue;
    const e = num(line, "E");
    if (e !== null && e < 0) retractCycles++;
    const mx = num(line, "X"), my = num(line, "Y");
    if (absolute) { if (mx !== null) px = mx; if (my !== null) py = my; }
    else { if (mx !== null && px !== null) px += mx; if (my !== null && py !== null) py += my; }
    if (px !== null && (px < 0 || px > CONSTRAINTS.bed)) outOfBounds.push(`X${px.toFixed(2)} (line: ${line})`);
    if (py !== null && (py < 0 || py > CONSTRAINTS.bed)) outOfBounds.push(`Y${py.toFixed(2)} (line: ${line})`);
  }
  return { retractCycles, outOfBounds };
}

// ---------------------------------------------------------------- runJobs --

/** jobs -> { gcode, digest, errors, warnings, ok }. */
export function runJobs(jobs, { material = "TPU" } = {}) {
  const errors = [], warnings = [];
  const em = new TF.Emitter();
  em.header(material === "PLA" ? { nozzleTemp: 205, bedTemp: 60, flowPercent: 100 } : {});
  for (const job of jobs) {
    try {
      if (job.newPattern) em.newPattern();
      if (job.kind === "brush") TF.BRUSHES[job.fn](em, job.pts, job.options);
      else TF.STAMPS[job.fn](em, job.at[0], job.at[1], job.options);
    } catch (e) {
      errors.push(`"${job.label}" ${job.slot}: ${e && e.message ? e.message : e}`);
    }
  }
  em.footer();
  const lines = em.lines;
  const gcode = TF.stripComments(lines.join("\n") + "\n");
  const scan = scanGcode(lines);
  for (const oob of scan.outOfBounds.slice(0, 5)) errors.push(`coordinate out of bed bounds: ${oob}`);
  if (scan.retractCycles >= CONSTRAINTS.retractCyclesHard) errors.push(`${scan.retractCycles} retraction cycles -- over the ${CONSTRAINTS.retractCyclesHard} cap (TPU drive-gear damage risk).`);
  else if (scan.retractCycles >= CONSTRAINTS.retractCyclesWarn) warnings.push(`${scan.retractCycles} retraction cycles (soft cap ${CONSTRAINTS.retractCyclesWarn}) -- TPU can flat-spot; consider wider spacing.`);
  const digest = { lineCount: lines.length, retractCycles: scan.retractCycles, boundsOk: scan.outOfBounds.length === 0 };
  return { gcode, digest, errors, warnings, ok: errors.length === 0 };
}

// ------------------------------------------------------------ abstractions --

/** Normalized weights for an abstraction's targets: clamp to >= 0, scale
 * to sum 1; equal weights if none are usable. */
export function normalizedWeights(targets) {
  const w = targets.map((t) => (Number.isFinite(Number(t.weight)) ? Math.max(0, Number(t.weight)) : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (sum <= 0) return targets.map(() => 1 / Math.max(1, targets.length));
  return w.map((x) => x / sum);
}

function optionSpan(fn, option) {
  const spec = optionSpecFor(fn)[option];
  if (!spec || spec.min == null || spec.max == null) return null;
  return { min: spec.min, max: spec.max, span: spec.max - spec.min, isInt: spec.kind === "int" };
}

function slotObj(scene, elementId, slot) {
  const tex = scene.textures[elementId];
  return tex && tex[slot] && tex[slot].fn ? tex[slot] : null;
}

/** Sum over every abstraction of direction * weight * (value - v0) * span
 * for one option. */
export function abstractionContribution(scene, elementId, slot, option) {
  let total = 0;
  const s = slotObj(scene, elementId, slot);
  if (!s) return 0;
  const sp = optionSpan(s.fn, option);
  if (!sp) return 0;
  for (const a of scene.abstractions) {
    const targets = Array.isArray(a.targets) ? a.targets : [];
    const w = normalizedWeights(targets);
    targets.forEach((t, i) => {
      if (t.elementId !== elementId || t.slot !== slot || t.option !== option) return;
      const dir = Number(t.direction) < 0 ? -1 : 1;
      total += dir * w[i] * ((Number(a.value) || 0) - (Number(a.v0) || 0)) * sp.span;
    });
  }
  return total;
}

/** The abstraction rule: option = clamp(base + contributions, min, max)
 * for every option some abstraction targets. `base` is stored per slot
 * in slot.bases (set from the parameters stage, or rebased by a manual
 * edit). Mutates slot.options in place. */
export function applyAbstractions(scene) {
  const driven = new Set();
  for (const a of scene.abstractions) for (const t of a.targets || []) driven.add(`${t.elementId} ${t.slot} ${t.option}`);
  for (const key of driven) {
    const [elementId, slot, option] = key.split(" ");
    const s = slotObj(scene, elementId, slot);
    if (!s) continue;
    const sp = optionSpan(s.fn, option);
    if (!sp) continue;
    s.bases = s.bases || {};
    if (s.bases[option] == null) {
      const cur = s.options?.[option];
      s.bases[option] = Number.isFinite(Number(cur)) && cur !== null && cur !== "" ? Number(cur) : (optionSpecFor(s.fn)[option].def ?? sp.min);
    }
    let v = s.bases[option] + abstractionContribution(scene, elementId, slot, option);
    v = Math.min(sp.max, Math.max(sp.min, v));
    if (sp.isInt) v = Math.round(v);
    else v = +v.toFixed(3);
    s.options = s.options || {};
    s.options[option] = v;
  }
}

/** A manual edit of a driven option keeps the sliders where they are:
 * base = edited - contributions. */
export function rebaseOption(scene, elementId, slot, option, value) {
  const s = slotObj(scene, elementId, slot);
  if (!s) return;
  s.bases = s.bases || {};
  s.bases[option] = value - abstractionContribution(scene, elementId, slot, option);
}

/** Which abstractions drive a given option (for grouping in the UI). */
export function driversOf(scene, elementId, slot, option) {
  const out = [];
  for (const a of scene.abstractions) {
    const targets = Array.isArray(a.targets) ? a.targets : [];
    const w = normalizedWeights(targets);
    targets.forEach((t, i) => { if (t.elementId === elementId && t.slot === slot && t.option === option) out.push({ abstraction: a, weight: w[i], direction: Number(t.direction) < 0 ? -1 : 1 }); });
  }
  return out;
}

/** Drop targets whose element/slot/option no longer exists (after a
 * geometry or texture change). Returns the dropped targets' descriptions. */
export function pruneAbstractions(scene) {
  const dropped = [];
  for (const a of scene.abstractions) {
    a.targets = (a.targets || []).filter((t) => {
      const s = slotObj(scene, t.elementId, t.slot);
      const ok = s && t.option in optionSpecFor(s.fn);
      if (!ok) dropped.push(`${a.name}: ${t.elementId}.${t.slot}.${t.option}`);
      return ok;
    });
  }
  scene.abstractions = scene.abstractions.filter((a) => a.targets.length);
  return dropped;
}

// ------------------------------------------------------- summaries / text --

/** Compact scene description for the router and the stage prompts. */
export function sceneSummary(scene) {
  if (!scene.elements.length) return "(the scene is empty)";
  const lines = [`transform: scale ${scene.transform.scale}, origin ${scene.transform.origin ? JSON.stringify(scene.transform.origin) : "natural"}`];
  for (const el of scene.elements) {
    const tex = scene.textures[el.id] || {};
    const parts = [];
    for (const slot of slotsFor(el.kind)) {
      const s = tex[slot];
      if (s?.fn) parts.push(`${slot}=${s.fn}${slot === "fill" && s.pattern ? `/${s.pattern.kind}` : ""}`);
    }
    lines.push(`${el.id} "${el.label || ""}" ${el.kind}${el.role ? ` role=${el.role}` : ""}${parts.length ? ` [${parts.join(", ")}]` : " [no texture]"}`);
  }
  if (scene.abstractions.length) {
    lines.push("abstractions: " + scene.abstractions.map((a) => `${a.id} "${a.name}"=${Number(a.value).toFixed(2)} -> ${(a.targets || []).map((t) => `${t.elementId}.${t.slot}.${t.option}`).join(", ")}`).join("; "));
  }
  return lines.join("\n");
}

/** Element geometry as the geometry stage should see / return it. */
export function elementsJson(scene, ids = null) {
  return scene.elements
    .filter((el) => !ids || ids.includes(el.id))
    .map((el) => ({ id: el.id, label: el.label, kind: el.kind, role: el.role || "", geometry: el.kind === "line" ? { path: el.path } : el.kind === "region" ? { boundary: el.boundary } : { at: el.at } }));
}

/** Textures as the texture / parameters stages should see them. */
export function texturesJson(scene, ids = null) {
  const out = [];
  for (const el of scene.elements) {
    if (ids && !ids.includes(el.id)) continue;
    const tex = scene.textures[el.id] || {};
    for (const slot of slotsFor(el.kind)) {
      const s = tex[slot];
      if (s?.fn) out.push({ elementId: el.id, slot, fn: s.fn, ...(slot === "fill" ? { pattern: s.pattern || null } : {}), options: s.options || {} });
    }
  }
  return out;
}

/** Option specs (numeric + semantic) for the brushes/stamps actually used
 * by the given elements -- what the parameters stage needs. */
export function optionSpecsText(scene, ids = null) {
  const fns = new Set();
  for (const t of texturesJson(scene, ids)) fns.add(t.fn);
  const blocks = [];
  for (const fn of fns) {
    const spec = optionSpecFor(fn);
    const rows = Object.entries(spec).map(([k, m]) => {
      const range = m.kind === "enum" ? m.options.join("|") : m.kind === "nnum" ? "number or null" : `${m.min}..${m.max}`;
      return `  ${k}: default ${m.def === null ? "null" : m.def}, ${range}${OPTION_DESC[k] ? ` -- ${OPTION_DESC[k]}` : ""}`;
    });
    blocks.push(`${fn} (${isBrush(fn) ? "line brush" : "stamp"}):\n${rows.join("\n")}`);
  }
  return blocks.join("\n\n");
}

/** The geometry report as compact text: one line per element / chart
 * row, so the model (and the UI) can scan it without a pretty-printed
 * number per line. */
export function reportText(report) {
  if (!report) return "(no report yet)";
  const lines = [];
  lines.push(`transform: ${JSON.stringify(report.transform)}`);
  lines.push(`printed bbox: ${JSON.stringify(report.bbox)}  natural bbox: ${JSON.stringify(report.naturalBbox)}`);
  lines.push("elements:");
  for (const e of report.elements || []) lines.push("  " + JSON.stringify(e));
  const chart = report.chart || {};
  for (const [k, rows] of Object.entries(chart)) {
    lines.push(`${k}:`);
    for (const r of rows) lines.push("  " + JSON.stringify(r));
  }
  return lines.join("\n");
}

// ------------------------------------------------- stage output validation --

const parseJsonField = (v, what, errors, fallback = null) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { errors.push(`${what}: JSON did not parse (${e.message})`); return fallback; }
};

/** Parses/validates one stage's JSON output against the scene. Returns
 * { value, errors } -- value is the normalized output, errors are fatal. */
export function validateStageOutput(stage, out, scene) {
  const errors = [];
  const ids = new Set(scene.elements.map((e) => e.id));
  if (!out || typeof out !== "object") return { value: null, errors: ["output is not an object"] };

  if (stage === "route") {
    const route = ["geometry", "texture", "parameters", "chat"].includes(out.route) ? out.route : null;
    if (!route) errors.push(`route must be geometry|texture|parameters|chat (got "${out.route}")`);
    const targets = Array.isArray(out.targets) ? out.targets.filter((t) => ids.has(t)) : [];
    return { value: { route, instruction: String(out.instruction || ""), targets, reply: String(out.reply || "") }, errors };
  }

  if (stage === "geometry") {
    const elements = [];
    const seen = new Set();
    (Array.isArray(out.elements) ? out.elements : []).forEach((e, i) => {
      const what = `element ${i + 1}`;
      const g = parseJsonField(e.geometry, `${what} geometry`, errors, {});
      let id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : "";
      if (!id || seen.has(id)) id = nextId({ elements: [...scene.elements, ...elements], abstractions: [] }, "el");
      seen.add(id);
      const el = { id, label: String(e.label || id), kind: e.kind, role: String(e.role || "") };
      if (e.kind === "line") el.path = g.path;
      else if (e.kind === "region") el.boundary = g.boundary;
      else if (e.kind === "point") el.at = g.at;
      else errors.push(`${what}: kind must be line|region|point (got "${e.kind}")`);
      elements.push(el);
    });
    const transform = parseJsonField(out.transform, "transform", errors, null);
    return { value: { chat: String(out.chat || ""), elements, transform }, errors };
  }

  if (stage === "texture") {
    const textures = [];
    (Array.isArray(out.textures) ? out.textures : []).forEach((t, i) => {
      const what = `texture ${i + 1}`;
      if (!ids.has(t.elementId)) { errors.push(`${what}: elementId "${t.elementId}" does not exist`); return; }
      const el = scene.elements.find((e) => e.id === t.elementId);
      if (!slotsFor(el.kind).includes(t.slot)) { errors.push(`${what}: slot "${t.slot}" is not valid for a ${el.kind} (${slotsFor(el.kind).join("|")})`); return; }
      const fn = String(t.fn || "");
      const pattern = t.slot === "fill" ? parseJsonField(t.pattern, `${what} pattern`, errors, null) : null;
      if (fn) {
        if (el.kind === "point" && !isStamp(fn)) errors.push(`${what}: a point needs a stamp (${STAMP_NAMES.join(", ")}), got "${fn}"`);
        else if ((el.kind === "line" || t.slot === "outline") && !isBrush(fn)) errors.push(`${what}: ${t.slot} needs a line brush (${BRUSH_NAMES.join(", ")}), got "${fn}"`);
        else if (t.slot === "fill") {
          if (!pattern || !PATTERN_KINDS.includes(pattern.kind)) errors.push(`${what}: fill pattern kind must be one of ${PATTERN_KINDS.join(", ")}`);
          else if (STAMP_PATTERNS.includes(pattern.kind) ? !isStamp(fn) : !isBrush(fn)) errors.push(`${what}: pattern "${pattern.kind}" needs a ${STAMP_PATTERNS.includes(pattern.kind) ? "stamp" : "line brush"}, got "${fn}"`);
        }
      }
      textures.push({ elementId: t.elementId, slot: t.slot, fn, pattern });
    });
    return { value: { chat: String(out.chat || ""), textures }, errors };
  }

  if (stage === "parameters") {
    const options = [];
    (Array.isArray(out.options) ? out.options : []).forEach((o, i) => {
      const what = `options ${i + 1}`;
      const s = slotObj(scene, o.elementId, o.slot);
      if (!s) { errors.push(`${what}: ${o.elementId}.${o.slot} has no texture`); return; }
      const opts = parseJsonField(o.options, what, errors, {});
      const spec = optionSpecFor(s.fn);
      const clean = {};
      for (const [k, v] of Object.entries(opts || {})) { if (k in spec) clean[k] = v; else errors.push(`${what}: "${k}" is not an option of ${s.fn}`); }
      options.push({ elementId: o.elementId, slot: o.slot, options: clean });
    });
    const abstractions = [];
    const seen = new Set();
    (Array.isArray(out.abstractions) ? out.abstractions : []).forEach((a, i) => {
      const what = `abstraction ${i + 1}`;
      const targetsRaw = parseJsonField(a.targets, `${what} targets`, errors, []);
      const targets = [];
      (Array.isArray(targetsRaw) ? targetsRaw : []).forEach((t) => {
        const s = slotObj(scene, t.elementId, t.slot);
        if (!s) { errors.push(`${what}: target ${t.elementId}.${t.slot} has no texture`); return; }
        if (!(t.option in optionSpecFor(s.fn)) || !optionSpan(s.fn, t.option)) { errors.push(`${what}: "${t.option}" is not a numeric option of ${s.fn}`); return; }
        targets.push({ elementId: t.elementId, slot: t.slot, option: t.option, weight: Number(t.weight), direction: Number(t.direction) < 0 ? -1 : 1 });
      });
      let id = typeof a.id === "string" && a.id.trim() ? a.id.trim() : "";
      if (!id || seen.has(id)) id = nextId({ elements: scene.elements, abstractions: [...scene.abstractions, ...abstractions] }, "ab");
      seen.add(id);
      const value = Number.isFinite(Number(a.value)) ? Math.min(1, Math.max(0, Number(a.value))) : 0.5;
      if (targets.length) abstractions.push({ id, name: String(a.name || id), description: String(a.description || ""), value, v0: value, targets });
    });
    return { value: { chat: String(out.chat || ""), options, abstractions }, errors };
  }

  return { value: null, errors: [`unknown stage "${stage}"`] };
}

// ------------------------------------------------------------------ merge --

/** Geometry stage output -> scene. Keeps textures/abstractions for ids
 * that survive; drops the rest (pruned targets are returned). */
export function mergeGeometry(scene, value) {
  scene.elements = value.elements;
  const ids = new Set(scene.elements.map((e) => e.id));
  for (const id of Object.keys(scene.textures)) if (!ids.has(id)) delete scene.textures[id];
  for (const el of scene.elements) {
    const tex = scene.textures[el.id];
    if (!tex) continue;
    for (const slot of Object.keys(tex)) if (!slotsFor(el.kind).includes(slot)) delete tex[slot];
  }
  if (value.transform && typeof value.transform === "object") {
    if (Number(value.transform.scale) > 0) scene.transform.scale = Number(value.transform.scale);
    if (Array.isArray(value.transform.origin) && value.transform.origin.length === 2) scene.transform.origin = value.transform.origin.map(Number);
    else if (value.transform.origin === null) scene.transform.origin = null;
  }
  return pruneAbstractions(scene);
}

/** Texture stage output -> scene. fn "" clears a slot; a changed fn resets
 * options to {} (the parameters stage runs next). */
export function mergeTextures(scene, value) {
  for (const t of value.textures) {
    scene.textures[t.elementId] = scene.textures[t.elementId] || {};
    const tex = scene.textures[t.elementId];
    if (!t.fn) { delete tex[t.slot]; continue; }
    const prev = tex[t.slot];
    const same = prev && prev.fn === t.fn;
    tex[t.slot] = { fn: t.fn, options: same ? prev.options : {}, bases: same ? prev.bases : {}, ...(t.slot === "fill" ? { pattern: t.pattern } : {}) };
  }
  return pruneAbstractions(scene);
}

/** Parameters stage output -> scene: options become the new bases, the
 * abstraction list is replaced, then the rule is applied. */
export function mergeParameters(scene, value) {
  for (const o of value.options) {
    const s = slotObj(scene, o.elementId, o.slot);
    if (!s) continue;
    s.options = { ...(s.options || {}), ...o.options };
    s.bases = {};
  }
  scene.abstractions = value.abstractions;
  for (const s of Object.values(scene.textures)) for (const slot of Object.values(s)) if (slot && typeof slot === "object") slot.bases = {};
  applyAbstractions(scene);
}
