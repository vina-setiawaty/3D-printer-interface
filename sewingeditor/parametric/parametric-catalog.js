// Catalog + interpreter for the parametric tactile-graphic page.
//
// The model returns a list of CALLS ({fn, geometry, options, label}); this
// file is the fixed machinery that turns that data into G-code by calling
// the pinned `docs/texture_functions.js`. No model-authored
// code is ever executed — only data-driven calls into the allowlist below.
//
// Enforced limits (min AND max gaps, min sizes, retraction caps, call
// ordering) are the PLACEHOLDER values from
// docs/PARAMETER_CONSTRAINTS.md. When the user returns that form
// with real numbers, edit CONSTRAINTS here to match — that file and this
// object are the two halves that must stay in sync.

const CONSTRAINTS = {
  minDomeDiameter: 0.8,      // hard
  minDiscDiameter: 0.8,      // hard
  minDiscHeight: 0.4,        // hard
  minLayers: 2,              // hard
  minBeadWidth: 0.4,         // warn
  blobDottedGapOverDiameter: 1.0,   // warn: gap >= diameter + this
  hairyDottedGapOverRoot: 2.0,      // warn: gap >= rootDiameter + this
  minHairSpacing: 2.5,       // warn
  minDottedGapOverDot: 1.0,  // warn: gap >= 2*dotRadius + this
  minHairyFillRowGap: 4.0,   // warn
  minSolidSheetGap: 0.35,    // hard
  minCallSeparation: 0.5,    // handled by verifyLayout
  minDashLen: 2.0,           // warn
  minDashGap: 2.0,           // warn
  minSegmentLen: 3.0,        // warn
  // --- maximum gap: beyond these a "line" stops reading as a connected
  // line, or a "fill" stops reading as a filled/shaded area (all warn) ---
  maxDottedGapOverDiameter: 4.0,  // warn: dotted/blob/dir/hairy line gap <= diameter * this
  maxDashGapOverSegLen: 3.0,      // warn: freeformDashed gapLen <= segLen * this
  maxShadeFillGap: 8.0,           // warn: line-shade fill (non-solid) pass gap
  maxDottedFillRowGap: 12.0,      // warn: dotted/hairy fill row gap
  maxHairSpacing: 12.0,           // warn: freeformHairy strand spacing
  zGapFloor: 0.25,           // hard
  minArcRadiusOverBead: 3.0, // warn: radius >= 3 * bead width
  sineAmplitudeRatio: 0.15,  // warn: amplitude <= ratio * wavelength
  minSineWavelength: 4.0,    // warn
  retractCyclesWarn: 250,    // warn
  retractCyclesHard: 2000,   // hard
  minDiamondDiag: 4.0,       // warn
  minDiamondFillGap: 0.35,   // hard
  bed: 220,
  bedMargin: 15,
};

// ---------------------------------------------------------------- allowlist --

const LINE_FNS = [
  "freeformSolid", "freeformDashed", "freeformDotted", "freeformBlobDotted",
  "freeformDirectionalBlobDotted", "freeformHairy", "freeformHairyDotted",
  "freeformSegmented", "freeformVariableThickness",
];
const DOT_FNS = ["blobDot", "circularDot", "directionalBlobDot", "hairyDot"];
const FILL_STYLES = [
  "freeformSolid", "freeformDashed", "freeformDotted", "freeformBlobDotted",
  "freeformHairy", "DIAMOND",
];

function callKind(fn) {
  if (LINE_FNS.includes(fn)) return "line";
  if (DOT_FNS.includes(fn)) return "dot";
  if (fn === "fill") return "fill";
  return null;
}

// Option descriptors. kind: "num" | "int" | "nnum" (nullable number) |
// "enum" | "bool". Only the fields the UI needs; anything omitted from a
// call's options just uses the library default.
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

const OPTIONS = {
  freeformSolid: { width: N(0.5, 0.3, 3), nLayers: I(2, 1, 10), speed: N(400, 50, 1500, 10) },
  freeformDashed: {
    segLen: N(8, 1, 60), gapLen: N(4, 1, 60), width: N(0.5, 0.3, 3),
    nLayers: I(2, 1, 10), speed: N(400, 50, 1500, 10),
  },
  freeformDotted: { gap: N(10, 1, 60), dotRadius: N(0.8, 0.3, 3), nLayers: I(2, 1, 10), speed: N(250, 50, 1000, 10) },
  freeformBlobDotted: {
    gap: N(10, 1, 60), diameter: N(1.6, 0.6, 8), ...BLOB_BUILD_OPTS,
    orbitRadius: NN(null), orbitPts: I(16, 3, 48), orbitSpeed: N(600, 100, 2000, 10), orbitLoops: I(3, 0, 10),
  },
  freeformDirectionalBlobDotted: {
    gap: NN(null), diameter: N(2.0, 0.6, 8), azimuthDeg: N(0, -180, 180, 1),
    dragSpeed: N(600, 100, 2000, 10), stampOrder: EN("auto", ["auto", "forward", "reverse"]),
    ...BLOB_BUILD_OPTS,
  },
  freeformHairy: {
    spacing: N(5.0, 1, 30), esegmentMm: N(1.2, 0.2, 4), retractMm: N(1.3, 0, 6),
    dwellMs: I(400, 0, 3000), smallLift: N(0.2, 0, 2), bigLift: N(4.0, 1, 10),
    baseZ: N(0.3, 0.1, 1), speed: N(200, 50, 1000, 10),
  },
  freeformHairyDotted: {
    gap: N(10, 1, 60), rootDiameter: N(2.0, 0.6, 8), hairLength: N(10.0, 1, 30),
    hairThickness: NN(null), hairDirection: EN("top", ["top", "right", "left", "bottom"]),
    hairAzimuthDeg: NN(null), hairElevationDeg: NN(null), beadFlowMult: N(3.5, 1, 6),
    pullExtrudeSpeed: N(150, 30, 600, 5), stringMm: N(2.0, 0, 10), overtravelMm: N(2.0, 0, 10),
    stampOrder: EN("auto", ["auto", "forward", "reverse"]), ...BLOB_BUILD_OPTS,
  },
  freeformSegmented: {
    thinLen: N(8, 1, 40), thinWidth: N(0.8, 0.3, 3), thinHeight: N(0.2, 0.1, 0.6), thinSpeed: N(130, 30, 600, 5),
    fatLen: N(4, 1, 40), fatWidth: N(1.6, 0.3, 4), fatHeight: N(0.3, 0.1, 0.8), fatSpeed: N(60, 20, 400, 5),
    flowMult: N(1.4, 0.5, 3), segDwellMs: I(250, 0, 2000),
  },
  freeformVariableThickness: {
    hMin: N(0.16, 0.1, 1), hMax: N(0.9, 0.2, 2), wavelength: N(8.0, 2, 40),
    beadWidth: N(0.8, 0.3, 3), zGap: N(0.25, 0.25, 1), speed: N(25, 10, 300, 5),
  },
  blobDot: {
    diameter: N(1.6, 0.6, 8), ...BLOB_BUILD_OPTS,
    orbitRadius: NN(null), orbitPts: I(16, 3, 48), orbitSpeed: N(600, 100, 2000, 10), orbitLoops: I(3, 0, 10),
  },
  circularDot: { diameter: N(1.6, 0.6, 8), height: N(0.4, 0.4, 3, 0.2), speed: N(250, 50, 1000, 10) },
  directionalBlobDot: {
    diameter: N(2.0, 0.6, 8), azimuthDeg: N(0, -180, 180, 1), dragSpeed: N(600, 100, 2000, 10),
    ...BLOB_BUILD_OPTS,
  },
  hairyDot: {
    rootDiameter: N(2.0, 0.6, 8), hairLength: N(10.0, 1, 30), hairThickness: NN(null),
    hairDirection: EN("top", ["top", "right", "left", "bottom"]),
    hairAzimuthDeg: NN(null), hairElevationDeg: NN(null), beadFlowMult: N(3.5, 1, 6),
    pullExtrudeSpeed: N(150, 30, 600, 5), stringMm: N(2.0, 0, 10), overtravelMm: N(2.0, 0, 10),
    ...BLOB_BUILD_OPTS,
  },
  // fill options are style-dependent; the panel merges these with the
  // chosen fillStyle's own line options.
  _fillCommon: { angleDeg: N(0, -180, 180, 1), gap: N(4.0, 0.3, 20) },
  _diamond: { diag: N(8.0, 2, 30), fillGap: N(0.6, 0.35, 3) },
};

function optionSpecFor(call) {
  const kind = callKind(call.fn);
  if (kind === "line" || kind === "dot") return OPTIONS[call.fn] || {};
  if (kind === "fill") {
    const style = (call.geometry && call.geometry.fillStyle) || "freeformSolid";
    if (style === "DIAMOND") return OPTIONS._diamond;
    return { ...OPTIONS._fillCommon, ...(OPTIONS[style] || {}) };
  }
  return {};
}

// --------------------------------------------------------------- path build --

function lineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

// Returns { xFunc, yFunc, tStart, tEnd, bbox:{minX,minY,maxX,maxY} }.
// Every path is parameterised by arc length in mm.
function buildPath(spec) {
  if (!spec || typeof spec !== "object") throw new Error("missing path spec");
  const kind = spec.kind;

  if (kind === "segment") {
    const [x0, y0] = spec.from, [x1, y1] = spec.to;
    const L = Math.hypot(x1 - x0, y1 - y0) || 1e-6;
    return {
      xFunc: (t) => x0 + (x1 - x0) * (t / L),
      yFunc: (t) => y0 + (y1 - y0) * (t / L),
      tStart: 0, tEnd: L,
      bbox: bboxOfPoints([spec.from, spec.to]),
    };
  }

  if (kind === "polyline") {
    const pts = spec.points;
    if (!Array.isArray(pts) || pts.length < 2) throw new Error("polyline needs >= 2 points");
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1] || 1e-6;
    const at = (s) => {
      if (s <= 0) return pts[0];
      if (s >= total) return pts[pts.length - 1];
      let i = 1;
      while (i < cum.length && cum[i] < s) i++;
      const seg = cum[i] - cum[i - 1] || 1e-6;
      const f = (s - cum[i - 1]) / seg;
      return [pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1])];
    };
    // The freeform sampler rejects turns sharper than ~15 deg, so a polyline
    // with real corners can't be ONE parametric path. Expand it to one
    // straight sub-segment per vertex pair; runCalls() invokes the line
    // style once per sub-segment (same as fill() does per fill line).
    const segments = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const L = Math.hypot(bx - ax, by - ay) || 1e-6;
      segments.push({
        xFunc: (t) => ax + (bx - ax) * (t / L),
        yFunc: (t) => ay + (by - ay) * (t / L),
        tStart: 0, tEnd: L,
      });
    }
    return { segments, bbox: bboxOfPoints(pts) };
  }

  if (kind === "arc") {
    const [cx, cy] = spec.center;
    const r = spec.radius;
    const a0 = (spec.startDeg * Math.PI) / 180;
    const a1 = (spec.endDeg * Math.PI) / 180;
    const dir = a1 >= a0 ? 1 : -1;
    const sweep = Math.abs(a1 - a0);
    const total = r * sweep || 1e-6;
    const ang = (s) => a0 + dir * (s / r);
    // conservative bbox: whole circle
    return {
      xFunc: (t) => cx + r * Math.cos(ang(t)),
      yFunc: (t) => cy + r * Math.sin(ang(t)),
      tStart: 0, tEnd: total,
      bbox: { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r },
    };
  }

  if (kind === "sine") {
    const [x0, y0] = spec.from, [x1, y1] = spec.to;
    const L = Math.hypot(x1 - x0, y1 - y0) || 1e-6;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    const nx = -uy, ny = ux;
    const amp = spec.amplitude, wl = spec.wavelength || 1e-6;
    const off = (t) => amp * Math.sin((2 * Math.PI * t) / wl);
    const bb = bboxOfPoints([spec.from, spec.to]);
    return {
      xFunc: (t) => x0 + ux * t + nx * off(t),
      yFunc: (t) => y0 + uy * t + ny * off(t),
      tStart: 0, tEnd: L,
      bbox: { minX: bb.minX - Math.abs(amp), minY: bb.minY - Math.abs(amp), maxX: bb.maxX + Math.abs(amp), maxY: bb.maxY + Math.abs(amp) },
    };
  }

  throw new Error(`unknown path kind "${kind}"`);
}

function bboxOfPoints(pts) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function padBbox(bb, pad) {
  return { minX: bb.minX - pad, minY: bb.minY - pad, maxX: bb.maxX + pad, maxY: bb.maxY + pad };
}

function bboxToRegion(bb, name) {
  return { x0: bb.minX, y0: bb.minY, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, name };
}

// ------------------------------------------------------------- per-call rules --

// Returns {errors:[], warnings:[]} for one call's chosen numbers.
function checkCallRules(call, opts) {
  const errors = [], warnings = [];
  const kind = callKind(call.fn);
  const tag = call.label ? `"${call.label}"` : call.fn;
  const g = (k, d) => (opts[k] === undefined || opts[k] === null ? d : opts[k]);

  if (kind === "dot" || call.fn === "freeformBlobDotted" || call.fn === "freeformDirectionalBlobDotted" || call.fn === "freeformHairyDotted") {
    const diaKey = call.fn === "circularDot" ? "diameter" : (/hairy/i.test(call.fn) ? "rootDiameter" : "diameter");
    const dia = g(diaKey, call.fn === "freeformDirectionalBlobDotted" || call.fn === "directionalBlobDot" ? 2.0 : 1.6);
    const min = call.fn === "circularDot" ? CONSTRAINTS.minDiscDiameter : CONSTRAINTS.minDomeDiameter;
    if (dia < min) errors.push(`${tag}: ${diaKey} ${dia}mm is below the ${min}mm minimum (relief-height floor).`);
  }

  if (call.fn === "freeformBlobDotted" || call.fn === "freeformDirectionalBlobDotted") {
    const dia = g("diameter", call.fn === "freeformDirectionalBlobDotted" ? 2.0 : 1.6);
    const gap = g("gap", call.fn === "freeformDirectionalBlobDotted" ? dia : 10);
    const minGap = call.fn === "freeformBlobDotted" ? dia + CONSTRAINTS.blobDottedGapOverDiameter : dia;
    if (gap < minGap)
      warnings.push(`${tag}: gap ${gap}mm is tight for diameter ${dia}mm — adjacent domes may fuse (want >= ${minGap.toFixed(1)}mm).`);
    if (gap > dia * CONSTRAINTS.maxDottedGapOverDiameter)
      warnings.push(`${tag}: gap ${gap}mm is large for diameter ${dia}mm — this reads as scattered dots, not a line (want <= ${(dia * CONSTRAINTS.maxDottedGapOverDiameter).toFixed(1)}mm).`);
  }
  if (call.fn === "freeformHairyDotted") {
    const root = g("rootDiameter", 2.0), gap = g("gap", 10);
    if (gap < root + CONSTRAINTS.hairyDottedGapOverRoot)
      warnings.push(`${tag}: gap ${gap}mm is tight for rootDiameter ${root}mm (want >= ${root + CONSTRAINTS.hairyDottedGapOverRoot}mm).`);
    if (gap > root * CONSTRAINTS.maxDottedGapOverDiameter)
      warnings.push(`${tag}: gap ${gap}mm is large for rootDiameter ${root}mm — reads as scattered hairy dots, not a line (want <= ${(root * CONSTRAINTS.maxDottedGapOverDiameter).toFixed(1)}mm).`);
  }
  if (call.fn === "freeformDotted") {
    const dr = g("dotRadius", 0.8), gap = g("gap", 10);
    if (gap < 2 * dr + CONSTRAINTS.minDottedGapOverDot)
      warnings.push(`${tag}: gap ${gap}mm is tight for dotRadius ${dr}mm.`);
    if (gap > 2 * dr * CONSTRAINTS.maxDottedGapOverDiameter)
      warnings.push(`${tag}: gap ${gap}mm is large for dotRadius ${dr}mm — reads as scattered dots, not a line (want <= ${(2 * dr * CONSTRAINTS.maxDottedGapOverDiameter).toFixed(1)}mm).`);
  }
  if (call.fn === "freeformHairy") {
    const sp = g("spacing", 5);
    if (sp < CONSTRAINTS.minHairSpacing) warnings.push(`${tag}: spacing ${sp}mm below recommended ${CONSTRAINTS.minHairSpacing}mm.`);
    if (sp > CONSTRAINTS.maxHairSpacing) warnings.push(`${tag}: spacing ${sp}mm above ${CONSTRAINTS.maxHairSpacing}mm — the strands stop reading as a continuous hairy line.`);
  }
  if (call.fn === "freeformDashed") {
    const segLen = g("segLen", 8), gapLen = g("gapLen", 4);
    if (segLen < CONSTRAINTS.minDashLen) warnings.push(`${tag}: segLen below ${CONSTRAINTS.minDashLen}mm.`);
    if (gapLen < CONSTRAINTS.minDashGap) warnings.push(`${tag}: gapLen below ${CONSTRAINTS.minDashGap}mm.`);
    if (gapLen > segLen * CONSTRAINTS.maxDashGapOverSegLen)
      warnings.push(`${tag}: gapLen ${gapLen}mm is large vs segLen ${segLen}mm — reads as isolated dashes, not a dashed line (want <= ${(segLen * CONSTRAINTS.maxDashGapOverSegLen).toFixed(1)}mm).`);
  }
  if (call.fn === "freeformSegmented") {
    if (g("thinLen", 8) < CONSTRAINTS.minSegmentLen || g("fatLen", 4) < CONSTRAINTS.minSegmentLen)
      warnings.push(`${tag}: a segment length is below ${CONSTRAINTS.minSegmentLen}mm.`);
  }
  if (call.fn === "freeformVariableThickness") {
    if (g("zGap", 0.25) < CONSTRAINTS.zGapFloor) errors.push(`${tag}: zGap ${g("zGap")} is below the ${CONSTRAINTS.zGapFloor}mm floor (prints flat).`);
  }
  if (call.fn === "circularDot") {
    if (g("height", 0.4) < CONSTRAINTS.minDiscHeight) errors.push(`${tag}: height below ${CONSTRAINTS.minDiscHeight}mm.`);
  }
  if ((call.fn === "freeformSolid" || call.fn === "freeformDashed") && call.fn in OPTIONS) {
    if (g("nLayers", 2) < CONSTRAINTS.minLayers) warnings.push(`${tag}: nLayers ${g("nLayers")} is below ${CONSTRAINTS.minLayers} — relief may not be felt.`);
    if (g("width", 0.5) < CONSTRAINTS.minBeadWidth) warnings.push(`${tag}: width below ${CONSTRAINTS.minBeadWidth}mm.`);
  }

  // path-shape rules
  if (kind === "line" && call.geometry && call.geometry.path) {
    const p = call.geometry.path;
    const beadW = g("width", g("beadWidth", g("thinWidth", 0.5)));
    if (p.kind === "arc" && p.radius < CONSTRAINTS.minArcRadiusOverBead * beadW)
      warnings.push(`${tag}: arc radius ${p.radius}mm is tight for a ${beadW}mm bead (want >= ${(CONSTRAINTS.minArcRadiusOverBead * beadW).toFixed(1)}mm); samplePath may reject it.`);
    if (p.kind === "sine") {
      if (p.wavelength < CONSTRAINTS.minSineWavelength) warnings.push(`${tag}: sine wavelength ${p.wavelength}mm below ${CONSTRAINTS.minSineWavelength}mm.`);
      if (Math.abs(p.amplitude) > CONSTRAINTS.sineAmplitudeRatio * p.wavelength)
        warnings.push(`${tag}: sine amplitude ${p.amplitude}mm is large vs wavelength ${p.wavelength}mm (want <= ${(CONSTRAINTS.sineAmplitudeRatio * p.wavelength).toFixed(1)}mm) — likely too steep to print.`);
    }
  }

  if (kind === "fill") {
    const style = call.geometry && call.geometry.fillStyle;
    const fgap = g("gap", 4);
    if (style === "DIAMOND") {
      if (g("diag", 8) < CONSTRAINTS.minDiamondDiag) warnings.push(`${tag}: diamond diag ${g("diag")}mm below ${CONSTRAINTS.minDiamondDiag}mm — cells stop reading distinctly.`);
      if (g("fillGap", 0.6) < CONSTRAINTS.minDiamondFillGap) errors.push(`${tag}: diamond fillGap below ${CONSTRAINTS.minDiamondFillGap}mm.`);
    } else if (style === "freeformSolid") {
      if (fgap < CONSTRAINTS.minSolidSheetGap) errors.push(`${tag}: fill gap ${fgap}mm below ${CONSTRAINTS.minSolidSheetGap}mm — severe over-extrusion.`);
      else if (fgap > CONSTRAINTS.maxShadeFillGap) warnings.push(`${tag}: fill gap ${fgap}mm above ${CONSTRAINTS.maxShadeFillGap}mm — the area no longer reads as filled/shaded, just spaced lines.`);
    } else if (style === "freeformHairy") {
      if (fgap < CONSTRAINTS.minHairyFillRowGap) warnings.push(`${tag}: hairy-fill row gap ${fgap}mm below ${CONSTRAINTS.minHairyFillRowGap}mm.`);
      else if (fgap > CONSTRAINTS.maxDottedFillRowGap) warnings.push(`${tag}: hairy-fill row gap ${fgap}mm above ${CONSTRAINTS.maxDottedFillRowGap}mm — reads as separate rows, not a filled patch.`);
    } else if ((style === "freeformDotted" || style === "freeformDashed" || style === "freeformBlobDotted") && fgap > CONSTRAINTS.maxDottedFillRowGap) {
      warnings.push(`${tag}: fill row gap ${fgap}mm above ${CONSTRAINTS.maxDottedFillRowGap}mm — reads as separate rows, not a filled patch.`);
    }
  }

  return { errors, warnings };
}

// ----------------------------------------------------------------- gcode scan --

// Walks the emitted G-code tracking G90/G91 mode and absolute head position
// so the bed-bounds check reasons about real coordinates (freeformSegmented
// and the footer emit G91 relative moves). The net-E figure is a running
// sum of E deltas — not a machine-accurate model (ignores G92) but a useful
// tripwire for a gross retraction-math bug.
function scanGcode(lines) {
  let eSum = 0, eMin = 0, retractCycles = 0;
  let absolute = true;           // G90 by default; header sets it explicitly
  let px = null, py = null;      // absolute head position once known
  const outOfBounds = [];
  const NEG_TRIPWIRE = -20;
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
    if (cmd === "G92") {
      const gx = num(line, "X"), gy = num(line, "Y");
      if (gx !== null) px = gx;
      if (gy !== null) py = gy;
      continue;
    }
    if (cmd !== "G0" && cmd !== "G1" && cmd !== "G2" && cmd !== "G3") continue;

    const e = num(line, "E");
    if (e !== null) {
      eSum += e;
      if (eSum < eMin) eMin = eSum;
      if (e < 0) retractCycles++;
    }

    const mx = num(line, "X"), my = num(line, "Y");
    if (absolute) {
      if (mx !== null) px = mx;
      if (my !== null) py = my;
    } else {
      if (mx !== null && px !== null) px += mx;
      if (my !== null && py !== null) py += my;
    }
    if (px !== null && (px < 0 || px > CONSTRAINTS.bed)) outOfBounds.push(`X${px.toFixed(2)} (line: ${line})`);
    if (py !== null && (py < 0 || py > CONSTRAINTS.bed)) outOfBounds.push(`Y${py.toFixed(2)} (line: ${line})`);
  }
  return { eSum, eMin, retractCycles, negTrip: eMin < NEG_TRIPWIRE, outOfBounds };
}

// ------------------------------------------------------------------- runCalls --

// TF = the imported texture_functions module. calls = normalized call
// objects (geometry/options already parsed to objects). Returns everything
// the UI needs.
function runCalls(TF, calls, { material = "TPU" } = {}) {
  const errors = [], warnings = [], perCall = [];
  const regions = [];
  const callMeta = [];   // {idx, kind, fn, label, bbox} for successfully-run calls

  const em = new TF.Emitter();
  const headerOpts = material === "PLA" ? { nozzleTemp: 205, bedTemp: 60, flowPercent: 100 } : {};
  em.header(headerOpts);

  calls.forEach((call, idx) => {
    const kind = callKind(call.fn);
    const label = call.label || `call ${idx + 1}`;
    if (!kind) { errors.push(`${label}: "${call.fn}" is not an allowlisted function.`); perCall.push({ ok: false }); return; }

    // Drop null/undefined/"" option values entirely — every texture_functions
    // parameter falls back to its own default when the key is absent (the
    // `= null` defaults are read through `??`), so this is always safe and
    // avoids passing an explicit null into arithmetic (e.g. `diameter: null`).
    const opts = {};
    for (const [k, v] of Object.entries(call.options || {})) {
      if (v !== null && v !== undefined && v !== "") opts[k] = v;
    }
    const rule = checkCallRules(call, opts);
    errors.push(...rule.errors);
    warnings.push(...rule.warnings);

    try {
      if (kind === "line") {
        const p = buildPath(call.geometry && call.geometry.path);
        const segs = p.segments || [{ xFunc: p.xFunc, yFunc: p.yFunc, tStart: p.tStart, tEnd: p.tEnd }];
        for (const s of segs) TF[call.fn](em, s.xFunc, s.yFunc, s.tStart, s.tEnd, opts);
        regions.push(bboxToRegion(padBbox(p.bbox, 3), label));
        callMeta.push({ idx, kind, fn: call.fn, label, bbox: p.bbox });
      } else if (kind === "dot") {
        const at = call.geometry && call.geometry.at;
        if (!Array.isArray(at) || at.length !== 2) throw new Error("dot needs geometry.at = [cx, cy]");
        TF[call.fn](em, at[0], at[1], opts);
        const reach = (opts.hairLength || 0) + (opts.stringMm || 0) + (opts.overtravelMm || 0);
        const rad = (opts.diameter || opts.rootDiameter || 3) / 2 + 2 + reach;
        const bb = { minX: at[0] - rad, minY: at[1] - rad, maxX: at[0] + rad, maxY: at[1] + rad };
        regions.push(bboxToRegion(bb, label));
        callMeta.push({ idx, kind, fn: call.fn, label, bbox: bb });
      } else if (kind === "fill") {
        const region = call.geometry && call.geometry.region;
        if (!region || ["x0", "y0", "w", "h"].some(k => typeof region[k] !== "number"))
          throw new Error("fill needs geometry.region = {x0,y0,w,h}");
        const styleName = call.geometry.fillStyle;
        if (!FILL_STYLES.includes(styleName)) throw new Error(`fillStyle "${styleName}" is not allowed`);
        const style = styleName === "DIAMOND" ? TF.DIAMOND : TF[styleName];
        const ret = TF.fill(em, region, style, opts);
        regions.push({ ...region, name: label });
        callMeta.push({ idx, kind, fn: call.fn, label, bbox: { minX: region.x0, minY: region.y0, maxX: region.x0 + region.w, maxY: region.y0 + region.h } });
        if (styleName === "DIAMOND" && Array.isArray(ret)) {
          const { violations } = TF.verifyCheckerboard(ret, opts.diag || 8.0);
          if (violations !== 0) errors.push(`${label}: diamond checkerboard has ${violations} adjacency violations.`);
        }
      }
      perCall.push({ ok: true });
    } catch (e) {
      perCall.push({ ok: false });
      if (e && e.name === "PathTooSteepError") {
        errors.push(`${label}: path is too steep to print — ${e.message} Soften the shape (smaller amplitude, larger radius/wavelength).`);
      } else {
        errors.push(`${label}: ${e && e.message ? e.message : e}`);
      }
    }
  });

  em.footer();
  const lines = em.lines;
  const gcode = TF.stripComments(lines.join("\n") + "\n");

  // layout: bed-margin violations are hard errors; bounding-box OVERLAP is
  // only a warning here — putting texture inside a taller frame is a normal
  // tactile-graphic pattern, and the boxes are padded estimates anyway. A
  // real same-height collision still shows up, just as a warning to eyeball.
  let marginOk = true;
  if (regions.length) {
    const layout = TF.verifyLayout(regions);
    for (const e of layout.errors) {
      if (/OVERLAP/.test(e)) {
        warnings.push(`${e} — fine if one is texture inside a taller frame; a collision risk only if they print at the same height.`);
      } else {
        marginOk = false;
        errors.push(e);
      }
    }
    warnings.push(...layout.warnings);
  }

  // Ordering: an outline / frame should be emitted BEFORE the fill texture it
  // encloses, so the fill is laid down inside an already-defined border (and
  // any lift-off ooze lands on the frame, not bare bed). Flag a line call
  // that surrounds a fill region but comes after it in the list.
  const bbArea = (b) => Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
  const surrounds = (o, f) =>
    o.minX <= f.minX + 1 && o.minY <= f.minY + 1 &&
    o.maxX >= f.maxX - 1 && o.maxY >= f.maxY - 1 &&
    bbArea(o) <= 2.5 * bbArea(f);
  for (const f of callMeta.filter(m => m.kind === "fill")) {
    for (const o of callMeta.filter(m => m.kind === "line" && m.idx > f.idx)) {
      if (surrounds(o.bbox, f.bbox)) {
        warnings.push(`"${o.label}" looks like an outline around the fill "${f.label}" but is drawn after it — put the outline call first so the fill prints inside a defined border.`);
      }
    }
  }

  const scan = scanGcode(lines);
  if (scan.negTrip) errors.push(`net extrusion dips to ${scan.eMin.toFixed(2)}mm — likely a retraction-math bug in one of the calls.`);
  for (const oob of scan.outOfBounds.slice(0, 5)) errors.push(`coordinate out of bed bounds: ${oob}`);
  if (scan.retractCycles >= CONSTRAINTS.retractCyclesHard)
    errors.push(`${scan.retractCycles} retraction cycles in this job — over the ${CONSTRAINTS.retractCyclesHard} cap (TPU drive-gear damage risk).`);
  else if (scan.retractCycles >= CONSTRAINTS.retractCyclesWarn)
    warnings.push(`${scan.retractCycles} retraction cycles in this job (soft cap ${CONSTRAINTS.retractCyclesWarn}) — TPU can flat-spot; consider wider spacing.`);

  const digest = {
    lineCount: lines.length,
    retractCycles: scan.retractCycles,
    netExtrusionMm: scan.eSum,
    minNetExtrusionMm: scan.eMin,
    boundsOk: scan.outOfBounds.length === 0,
    layoutOk: marginOk,
    regions: regions.map(r => ({ name: r.name, x0: +r.x0.toFixed(1), y0: +r.y0.toFixed(1), w: +r.w.toFixed(1), h: +r.h.toFixed(1) })),
  };

  return { gcode, digest, errors, warnings, perCall, ok: errors.length === 0 };
}

const ParametricCatalog = {
  CONSTRAINTS, LINE_FNS, DOT_FNS, FILL_STYLES, OPTIONS,
  callKind, optionSpecFor, buildPath, runCalls,
};

if (typeof window !== "undefined") window.ParametricCatalog = ParametricCatalog;
if (typeof module !== "undefined" && module.exports) module.exports = ParametricCatalog;
