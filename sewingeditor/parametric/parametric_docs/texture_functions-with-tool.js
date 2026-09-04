/**
 * texture_functions-with-tool.js -- PROTOTYPE fork of texture_functions.js,
 * used only by parametric-with-tool.html. Behavior is identical to the
 * pinned texture_functions.js for every existing call (verified by a
 * golden-file G-code diff, not just visual inspection) -- the only real
 * change is internal: the four "*Dotted" per-point-stamp line styles
 * (freeformDotted, freeformBlobDotted, freeformDirectionalBlobDotted,
 * freeformHairyDotted) used to each reimplement their own "sample the path,
 * compute arc-length stops, maybe reverse the order, stamp each" loop.
 * They now share one driver, walkArcLengthStops() (SECTION 3). Comments
 * here document only the FINAL current behavior -- see texture_functions.js
 * (or ../../texture_docs/) for the full historical tuning log this was
 * distilled from.
 *
 * ============================================================================
 * SECTION 1: CORE INFRASTRUCTURE (Emitter, shared constants, e-rate math)
 * ============================================================================
 */

// ---------------------------------------------------------------- globals --
export const FILAMENT_DIA = 1.75;
export const FIL_AREA = Math.PI * (FILAMENT_DIA / 2) ** 2;

export const NOZZLE_TEMP = 220;   // TPU default
export const BED_TEMP = 50;
export const RETRACT_MM = 1.3;
export const RETRACT_SPEED = 900; // 15mm/s -- fast retraction risks flat-spotting TPU at the drive gear
export const LINE_START_PRIME_MM = 0.3; // extra one-time prime per top-level printed element

export const TRAVEL_SPEED = 3000;
export const Z_HOP = 0.4;
export const LAYER_HEIGHT = 0.20;
export const MIN_LAYERS = 2;      // 0.4mm floor -- see "Relief Height Floor"
export const DEFAULT_WIDTH = 0.5;
export const FLOW_PERCENT = 180;

export const BED_X = 220.0;
export const BED_Y = 220.0;

/** mm of filament per mm of XY travel, for a bead of given width/height. */
export function eRate(width, height, flowMult = 1.0) {
  return (width * height * flowMult) / FIL_AREA;
}

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Tracks running state (E, Z, XY, retracted-ness) across the whole file and
 * provides the common hop/travel/settle/retract primitives so every texture
 * function can be written as a small, self-contained unit.
 *
 * RELATIVE EXTRUSION (M83), not absolute: every `G1 E<value>` this class (and
 * every texture function) emits is a DELTA -- positive always means
 * extrude, negative always means retract, with no need to know any earlier
 * line's E value. `eTotal` is kept only for informational/debug totals
 * (e.g. total filament used) -- never itself written into a G-code line.
 */
export class Emitter {
  constructor() {
    this.lines = [];
    this.eTotal = 0;
    this.x = null;
    this.y = null;
    this.z = null;
    this.retracted = true;
    this.pendingPrimeBonus = false;
  }

  a(s) {
    this.lines.push(s);
  }

  /**
   * Call once at the start of each top-level printed element (a line, a
   * fill region, a dot). Adds LINE_START_PRIME_MM the NEXT time the
   * pattern un-retracts -- once only. Does not affect internal
   * layer-to-layer or dot-to-dot un-retracts within the same element.
   */
  newPattern() {
    this.pendingPrimeBonus = true;
  }

  header({ nozzleTemp = NOZZLE_TEMP, bedTemp = BED_TEMP, flowPercent = FLOW_PERCENT } = {}) {
    const a = (s) => this.a(s);
    a("G21"); a("G90"); a("M83");
    a("M220 S100");
    a(`M221 S${flowPercent}`);
    a(`M104 S${nozzleTemp}`);
    a(`M140 S${bedTemp}`);
    a(`M190 S${bedTemp}`);
    a(`M109 S${nozzleTemp}`);
    a("G28");
    a("G92 E0");
    a("G1 Z5 F3000");
    a("G1 X10 Y15 Z0.28 F5000");
    a("G1 X10 Y100 Z0.28 F1500 E12");
    a("G1 X10.4 Y100 Z0.28 F5000");
    a("G1 X10.4 Y15 Z0.28 F1500 E12");
    a("G92 E0");
    a("G1 Z2.0 F3000");
    // explicit retract (a relative delta) to establish the starting
    // retracted state
    a(`G1 E${(-RETRACT_MM).toFixed(4)} F${RETRACT_SPEED}`);
    this.eTotal = -RETRACT_MM;
    this.x = 10.4; this.y = 15.0; this.z = 2.0;
    this.retracted = true;
  }

  footer() {
    const a = (s) => this.a(s);
    a("G91");
    if (!this.retracted) {
      a(`G1 E${(-RETRACT_MM).toFixed(3)} F${RETRACT_SPEED}`);
      this.eTotal -= RETRACT_MM;
    }
    a("G1 Z10 F3000");
    a("G90");
    a(`G1 X0 Y${(BED_Y - 2).toFixed(0)} F3000`);
    a("M104 S0"); a("M140 S0"); a("M84");
  }

  /** Hop to a safe height, travel, settle, un-retract-if-needed. */
  goto(x, y, z) {
    const hopZ = Math.max(z, this.z ?? 0) + Z_HOP;
    this.a(`G1 Z${hopZ.toFixed(3)} F3000`);
    if (!this.retracted) {
      this.a(`G1 E${(-RETRACT_MM).toFixed(4)} F${RETRACT_SPEED}`);
      this.eTotal -= RETRACT_MM;
      this.retracted = true;
    }
    this.a(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F${TRAVEL_SPEED}`);
    this.a(`G1 Z${z.toFixed(3)} F1500`);
    this.x = x; this.y = y; this.z = z;
  }

  unretract() {
    if (this.retracted) {
      const bonus = this.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
      this.pendingPrimeBonus = false;
      const amt = RETRACT_MM + bonus;
      this.a(`G1 E${amt.toFixed(4)} F${RETRACT_SPEED}`);
      this.eTotal += amt;
      this.retracted = false;
    }
  }

  retract() {
    if (!this.retracted) {
      this.a(`G1 E${(-RETRACT_MM).toFixed(4)} F${RETRACT_SPEED}`);
      this.eTotal -= RETRACT_MM;
      this.retracted = true;
    }
  }

  printMove(x, y, eAdd, speed, z = null) {
    this.eTotal += eAdd;
    const zpart = z !== null ? ` Z${z.toFixed(3)}` : "";
    this.a(`G1 X${x.toFixed(3)} Y${y.toFixed(3)}${zpart} E${eAdd.toFixed(4)} F${speed.toFixed(0)}`);
    this.x = x; this.y = y;
    if (z !== null) this.z = z;
  }

  dwell(ms) {
    this.a(`G4 P${Math.round(ms)}`);
  }
}

export function stripComments(text) {
  const out = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    const idx = line.indexOf(";");
    if (idx !== -1) line = line.slice(0, idx).replace(/\s+$/, "");
    if (line.trim()) out.push(line);
  }
  return out.join("\n") + "\n";
}

/** Points for a solid filled circular dot. */
export function spiralDisc(center, radius, spacing = 0.28, ptsPerTurn = 20) {
  const nTurns = Math.max(1, Math.ceil(radius / spacing));
  const nPts = nTurns * ptsPerTurn;
  const pts = [];
  for (let k = 0; k <= nPts; k++) {
    const theta = (k * (nTurns * 2 * Math.PI)) / nPts;
    const r = radius * (theta / (nTurns * 2 * Math.PI));
    pts.push([center[0] + r * Math.cos(theta), center[1] + r * Math.sin(theta)]);
  }
  return pts;
}

/**
 * ============================================================================
 * SECTION 2: FREEFORM PATH ENGINE
 * ============================================================================
 * Any line follows x(t), y(t) -- a straight line, an angle, a sine wiggle,
 * an arc, or a hand-authored curve. samplePath() IS the "linked list of
 * points" a path resolves to: an arc-length-tagged point sequence every
 * texture function (line style or per-point stamp) walks.
 */

/**
 * The path has a direction change too sharp to print smoothly, even after
 * refining sampling -- the SHAPE is the problem (e.g. amplitude exceeding
 * wavelength), not the resolution. Reduce amplitude or increase
 * wavelength/radius.
 */
export class PathTooSteepError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathTooSteepError";
  }
}

function turnAngleDeg(p0, p1, p2) {
  const v1 = [p1[0] - p0[0], p1[1] - p0[1]];
  const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const a1 = Math.atan2(v1[1], v1[0]);
  const a2 = Math.atan2(v2[1], v2[0]);
  let turn = Math.abs(((a2 - a1) * 180) / Math.PI);
  return turn > 180 ? 360 - turn : turn;
}

/**
 * Samples (xFunc(t), yFunc(t)) at a fixed, fine step (deliberately NOT
 * adaptive). Verifies no consecutive-segment turn exceeds maxTurnDeg;
 * refines (halves step) up to maxRefineAttempts times; throws
 * PathTooSteepError if the violation persists.
 * Returns array of [x, y, s], s = cumulative arc length from tStart.
 */
export function samplePath(xFunc, yFunc, tStart, tEnd, {
  step = 0.1, maxTurnDeg = 15.0, maxRefineAttempts = 3,
} = {}) {
  const doSample = (step) => {
    const pts = [];
    let t = tStart;
    while (t < tEnd - 1e-9) {
      pts.push([xFunc(t), yFunc(t)]);
      t += step;
    }
    pts.push([xFunc(tEnd), yFunc(tEnd)]);
    return pts;
  };

  const maxTurn = (pts) => {
    let worst = 0.0;
    for (let i = 1; i < pts.length - 1; i++) {
      worst = Math.max(worst, turnAngleDeg(pts[i - 1], pts[i], pts[i + 1]));
    }
    return worst;
  };

  let pts = doSample(step);
  let attempts = 0;
  let prevWorst = null;
  let curStep = step;
  while (true) {
    const worst = maxTurn(pts);
    if (worst <= maxTurnDeg) break;
    if (attempts >= maxRefineAttempts) {
      throw new PathTooSteepError(
        `Path has a ${worst.toFixed(1)} degree direction change that ` +
        `persists after ${attempts} sampling refinements ` +
        `(step=${curStep.toFixed(4)}mm). Reduce amplitude or increase ` +
        `wavelength/radius rather than resampling further.`
      );
    }
    if (prevWorst !== null && worst >= prevWorst * 0.98) {
      throw new PathTooSteepError(
        `Path has a ${worst.toFixed(1)} degree direction change NOT ` +
        `improving with finer sampling (was ${prevWorst.toFixed(1)} ` +
        `degrees before refinement) -- the shape itself is too steep, ` +
        `not a resolution problem.`
      );
    }
    prevWorst = worst;
    curStep /= 2.0;
    pts = doSample(curStep);
    attempts += 1;
  }

  const out = [[pts[0][0], pts[0][1], 0.0]];
  let s = 0.0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.push([pts[i][0], pts[i][1], s]);
  }
  return out;
}

/** Interpolates the (x,y) position at a specific arc-length distance
 * along a samplePath() result. */
export function pointAtArcLength(sampledPts, targetS) {
  if (targetS <= 0) return [sampledPts[0][0], sampledPts[0][1]];
  const last = sampledPts[sampledPts.length - 1];
  if (targetS >= last[2]) return [last[0], last[1]];
  let lo = 0, hi = sampledPts.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (sampledPts[mid][2] <= targetS) lo = mid; else hi = mid;
  }
  const [x0, y0, s0] = sampledPts[lo];
  const [x1, y1, s1] = sampledPts[hi];
  const frac = s1 === s0 ? 0.0 : (targetS - s0) / (s1 - s0);
  return [x0 + frac * (x1 - x0), y0 + frac * (y1 - y0)];
}

export function totalLength(sampledPts) {
  return sampledPts[sampledPts.length - 1][2];
}

/**
 * ============================================================================
 * SECTION 3: LINE STYLES (all follow the freeform path engine above)
 * ============================================================================
 */

/** Continuous solid line following any path. */
export function freeformSolid(em, xFunc, yFunc, tStart, tEnd, {
  width = 0.5, nLayers = 2, speed = 400, step = 0.1,
} = {}) {
  const pts = samplePath(xFunc, yFunc, tStart, tEnd, { step });
  em.newPattern();
  for (let layer = 1; layer <= nLayers; layer++) {
    const z = LAYER_HEIGHT * layer;
    em.goto(pts[0][0], pts[0][1], z);
    em.unretract();
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      if (seg < 1e-9) continue;
      em.printMove(x1, y1, seg * eRate(width, LAYER_HEIGHT), speed);
    }
    em.retract();
  }
  return pts;
}

/** Dashed line following any path -- segLen/gapLen measured along actual
 * arc length, not the raw t parameter. */
export function freeformDashed(em, xFunc, yFunc, tStart, tEnd, {
  segLen, gapLen, width = 0.5, nLayers = 2, speed = 400, step = 0.1,
} = {}) {
  if (typeof segLen !== "number" || typeof gapLen !== "number") {
    throw new TypeError(
      "freeformDashed requires numeric segLen and gapLen in its options object, e.g. {segLen: 8, gapLen: 4}."
    );
  }
  const pts = samplePath(xFunc, yFunc, tStart, tEnd, { step });
  const length = totalLength(pts);
  em.newPattern();
  let s = 0.0;
  while (s < length - 1e-6) {
    const s2 = Math.min(s + segLen, length);
    const subStart = pointAtArcLength(pts, s);
    let subPts = pts.filter((p) => p[2] >= s && p[2] <= s2);
    if (subPts.length === 0 || subPts[0][2] > s + 1e-6) {
      subPts = [[subStart[0], subStart[1], s], ...subPts];
    }
    for (let layer = 1; layer <= nLayers; layer++) {
      const z = LAYER_HEIGHT * layer;
      em.goto(subPts[0][0], subPts[0][1], z);
      em.unretract();
      for (let i = 1; i < subPts.length; i++) {
        const [x0, y0] = subPts[i - 1], [x1, y1] = subPts[i];
        const seg = Math.hypot(x1 - x0, y1 - y0);
        if (seg < 1e-9) continue;
        em.printMove(x1, y1, seg * eRate(width, LAYER_HEIGHT), speed);
      }
      em.retract();
    }
    s = s2 + gapLen;
  }
  return pts;
}

/**
 * Shared driver for the four per-point "*Dotted" styles below: sample the
 * path into its point list, compute arc-length stops every `gap` from 0 to
 * the path length (inclusive), optionally decide whether to walk them in
 * reverse, optionally compute each stop's local path heading, then call
 * `stampFn(cx, cy, {headingDeg})` at each stop. Returns the full sampled
 * point list, same as every *Dotted function returned before this
 * refactor -- this function only replaces their previously-duplicated
 * loop bodies, it changes no emitted G-code.
 *
 * `reverseCheck`, if given, receives `{pts, length, gap, stops, step}` and
 * returns true/false -- each caller supplies its OWN reversal criterion
 * (they differ: directional lean vs. hair-pull direction), this driver
 * does not impose one. `withTangent` additionally hands the stamp a local
 * heading in degrees (only the directional-lean style needs this).
 */
function walkArcLengthStops(xFunc, yFunc, tStart, tEnd, gap, step, { reverseCheck = null, withTangent = false } = {}, stampFn) {
  const pts = samplePath(xFunc, yFunc, tStart, tEnd, { step });
  const length = totalLength(pts);
  const stops = [];
  for (let s = 0; s <= length + 1e-6; s += gap) stops.push(s);

  if (reverseCheck && reverseCheck({ pts, length, gap, stops, step })) stops.reverse();

  const tanH = Math.max(step, Math.min(gap * 0.5, 1.0));
  for (const s of stops) {
    const [cx, cy] = pointAtArcLength(pts, s);
    if (withTangent) {
      const a = pointAtArcLength(pts, Math.max(0, s - tanH));
      const b = pointAtArcLength(pts, Math.min(length, s + tanH));
      const headingDeg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      stampFn(cx, cy, { headingDeg });
    } else {
      stampFn(cx, cy, {});
    }
  }
  return pts;
}

/** Dots stamped at regular ARC-LENGTH intervals along any path -- a flat
 * spiral-filled disc at each stop. */
export function freeformDotted(em, xFunc, yFunc, tStart, tEnd, {
  gap = 10.0, dotRadius = 0.8, nLayers = 2, speed = 250, step = 0.1,
} = {}) {
  em.newPattern();
  return walkArcLengthStops(xFunc, yFunc, tStart, tEnd, gap, step, {}, (cx, cy) => {
    const dotPts = spiralDisc([cx, cy], dotRadius);
    for (let layer = 1; layer <= nLayers; layer++) {
      const z = LAYER_HEIGHT * layer;
      em.goto(dotPts[0][0], dotPts[0][1], z);
      em.unretract();
      for (let i = 1; i < dotPts.length; i++) {
        const seg = dist(dotPts[i - 1], dotPts[i]);
        if (seg < 1e-9) continue;
        em.printMove(dotPts[i][0], dotPts[i][1], seg * eRate(0.42, LAYER_HEIGHT), speed);
      }
      em.retract();
    }
  });
}

/** Dots stamped by the blobDot() point-extrusion mechanism (SECTION 5) at
 * regular arc-length intervals along any path -- the DEFAULT dotted-line
 * style, preferred over freeformDotted() unless a flat, spiral-filled disc
 * is specifically needed. */
export function freeformBlobDotted(em, xFunc, yFunc, tStart, tEnd, {
  gap = 10.0, diameter = 1.6, baseZ = 0.2, buildSteps = 6, taperFactor = 0.7,
  extrudeSpeed = 120, dwellMs = 2000, extrusionMultiplier = 1.3,
  retractMm = 4.0, postRetractDwellMs = 2000, baseExtraMm = 0.3,
  baseDwellMs = 1000, orbitRadius = null, orbitPts = 16, orbitSpeed = 600,
  orbitLoops = 3, orbitDwellMs = 2000, blobClearanceMm = 0.3,
  liftZ = 5.0, liftSpeed = 600, liftDwellMs = 1000, topOrbitLoops = 3,
  step = 0.1,
} = {}) {
  em.newPattern();
  return walkArcLengthStops(xFunc, yFunc, tStart, tEnd, gap, step, {}, (cx, cy) => {
    emitBlobDot(em, cx, cy, {
      diameter, baseZ, buildSteps, taperFactor, extrudeSpeed, dwellMs,
      extrusionMultiplier, retractMm, postRetractDwellMs, baseExtraMm,
      baseDwellMs, orbitRadius, orbitPts, orbitSpeed, orbitLoops,
      orbitDwellMs, blobClearanceMm, liftZ, liftSpeed, liftDwellMs,
      topOrbitLoops,
    });
  });
}

/** `directionalBlobDot()`-mechanism dots stamped at regular arc-length
 * intervals along any path -- like `freeformBlobDotted` but each dot LEANS
 * along the path tangent at that point (a curved line produces blobs that
 * each rake "downstream"). `azimuthDeg` is an OFFSET added to that local
 * tangent, in degrees CCW -- 0 (default) leans exactly along the direction
 * of travel. `gap` defaults to one `diameter` so adjacent dots' base
 * circles just touch and the drags chain into a continuous raked ridge.
 * `stampOrder` (default "auto"): if the (offset) lean at the path start
 * points forward along the path, the line is stamped in reverse so each
 * apex leans back over already-placed (cooled) dots rather than toward the
 * fresh next one. */
export function freeformDirectionalBlobDotted(em, xFunc, yFunc, tStart, tEnd, {
  gap = null, diameter = 2.0, azimuthDeg = 0, baseZ = 0.2, buildSteps = 6,
  taperFactor = 0.7, extrudeSpeed = 120, dwellMs = 2000,
  extrusionMultiplier = 1.3, retractMm = 4.0, postRetractDwellMs = 2000,
  baseExtraMm = 0.3, baseDwellMs = 1000, dragSpeed = 600,
  stampOrder = "auto", step = 0.1,
} = {}) {
  const g = gap ?? diameter;
  em.newPattern();
  return walkArcLengthStops(xFunc, yFunc, tStart, tEnd, g, step, {
    withTangent: true,
    reverseCheck: ({ pts, length, gap, stops, step }) => {
      if (stampOrder === "reverse") return true;
      if (stampOrder !== "auto") return false;
      if (stops.length <= 1) return false;
      const tanH = Math.max(step, Math.min(gap * 0.5, 1.0));
      const a = pointAtArcLength(pts, Math.max(0, 0 - tanH));
      const b = pointAtArcLength(pts, Math.min(length, 0 + tanH));
      const headingDeg0 = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      const azR = ((headingDeg0 + azimuthDeg) * Math.PI) / 180;
      const ax = Math.cos(azR), ay = Math.sin(azR);
      const p0 = pointAtArcLength(pts, 0);
      const p1 = pointAtArcLength(pts, Math.min(length, gap));
      return ax * (p1[0] - p0[0]) + ay * (p1[1] - p0[1]) > 0;
    },
  }, (cx, cy, { headingDeg }) => {
    emitDirectionalBlobDot(em, cx, cy, {
      diameter, azimuthDeg: headingDeg + azimuthDeg, baseZ, buildSteps, taperFactor,
      extrudeSpeed, dwellMs, extrusionMultiplier, retractMm,
      postRetractDwellMs, baseExtraMm, baseDwellMs, dragSpeed,
    });
  });
}

/** Vertical-lift hair strands stamped at regular arc-length intervals
 * along any path. CAUTION: each strand is a retract/un-retract cycle --
 * see PARAMETER_CONSTRAINTS.md's retraction-cycle cap before using a
 * dense spacing over a long path. */
export function freeformHairy(em, xFunc, yFunc, tStart, tEnd, {
  spacing = 2.0, esegmentMm = 1.2, retractMm = 1.3, dwellMs = 400,
  smallLift = 0.2, bigLift = 4.0, baseZ = 0.3, speed = 200, step = 0.1,
} = {}) {
  const pts = samplePath(xFunc, yFunc, tStart, tEnd, { step });
  const length = totalLength(pts);
  em.newPattern();
  const nRoots = Math.floor(length / spacing) + 1;
  const first = pointAtArcLength(pts, 0);
  em.goto(first[0], first[1], baseZ);
  em.unretract();
  for (let i = 0; i < nRoots; i++) {
    const s = i * spacing;
    em.a(`G1 E${esegmentMm.toFixed(4)} F500`);
    em.eTotal += esegmentMm;
    const z1 = baseZ + smallLift;
    em.a(`G0 Z${z1.toFixed(3)}`);
    em.z = z1;
    em.dwell(dwellMs);
    const z2 = z1 + bigLift;
    em.a(`G0 Z${z2.toFixed(3)} F600`);
    em.z = z2;
    em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
    em.eTotal -= retractMm;
    if (i < nRoots - 1) {
      const [nx, ny] = pointAtArcLength(pts, s + spacing);
      em.a(`G0 X${nx.toFixed(3)} Y${ny.toFixed(3)} F${speed}`);
      em.x = nx; em.y = ny;
    }
    em.a(`G0 Z${baseZ.toFixed(3)} F600`);
    em.z = baseZ;
  }
  em.retracted = true;
  return pts;
}

/** A line of discrete "hairy dots" (see emitHairyDot() in SECTION 5) at
 * regular arc-length intervals -- each stamp is an anchor blob plus ONE
 * pulled hair strand, not `freeformHairy`'s simpler point-stamp. Shares
 * `freeformHairy`'s retraction-cycle-count caution (one retract/unretract
 * PER strand). `stampOrder` (default "auto"): if the hair's XY projection
 * leans FORWARD along the path (toward the next dot), the line is stamped
 * in REVERSE so every strand trails behind its own dot, away from where
 * the nozzle heads next. */
export function freeformHairyDotted(em, xFunc, yFunc, tStart, tEnd, {
  gap = 10.0, rootDiameter = 2.0, baseZ = 0.2, buildSteps = 6,
  taperFactor = 0.7, extrudeSpeed = 120, baseExtraMm = 0.3,
  baseDwellMs = 1000, dwellMs = 2000, extrusionMultiplier = 1.3,
  hairThickness = null, hairLength = 10.0, pullExtrudeSpeed = 150,
  beadFlowMult = 3.5, dryRiseFeedDrop = 10, retractMm = 4.0,
  postRetractDwellMs = 500, hairDirection = "top",
  hairAzimuthDeg = null, hairElevationDeg = null, stringMm = 2.0,
  hairSpeed = 8000, clearanceZ = 0.5, clearanceSpeed = 600,
  overtravelMm = 2.0, overtravelSpeed = 600,
  stampOrder = "auto", step = 0.1,
} = {}) {
  em.newPattern();
  return walkArcLengthStops(xFunc, yFunc, tStart, tEnd, gap, step, {
    reverseCheck: ({ pts, length, gap, stops }) => {
      if (stampOrder === "reverse") return true;
      if (stampOrder !== "auto") return false;
      if (stops.length <= 1) return false;
      const { dx: hx, dy: hy } = resolveHairDir(hairDirection, hairAzimuthDeg, hairElevationDeg);
      if (Math.hypot(hx, hy) <= 1e-6) return false;
      const p0 = pointAtArcLength(pts, 0);
      const p1 = pointAtArcLength(pts, Math.min(length, gap));
      return (hx * (p1[0] - p0[0]) + hy * (p1[1] - p0[1])) > 0;
    },
  }, (cx, cy) => {
    emitHairyDot(em, cx, cy, {
      rootDiameter, baseZ, buildSteps, taperFactor, extrudeSpeed,
      baseExtraMm, baseDwellMs, dwellMs, extrusionMultiplier,
      hairThickness, hairLength, pullExtrudeSpeed, beadFlowMult,
      dryRiseFeedDrop, retractMm, postRetractDwellMs, hairDirection,
      hairAzimuthDeg, hairElevationDeg, stringMm, hairSpeed,
      clearanceZ, clearanceSpeed, overtravelMm, overtravelSpeed,
    });
  });
}

/** Alternating thin/fat segments along any path -- a continuous, single-
 * layer line that switches bead WIDTH between two segment types, each
 * with its own LENGTH: `thinWidth` x `thinLen`, then `fatWidth` x
 * `fatLen`, repeating to the end of the path. Each segment type also has
 * its own bead HEIGHT (the nozzle Z steps to it per segment) -- the fat
 * segment sitting a little higher is what lets its extra volume spread
 * into a genuinely wider bead instead of doming at a fixed low Z. No
 * retract between segments (the line is continuous); one prime at the
 * start, one retract at the very end. Uses G91 for the XY (and per-segment
 * relative Z) segment walk. */
export function freeformSegmented(em, xFunc, yFunc, tStart, tEnd, {
  thinLen = 8.0, thinWidth = 0.8, thinHeight = 0.2, thinSpeed = 130,
  fatLen = 4.0, fatWidth = 1.6, fatHeight = 0.3, fatSpeed = 60,
  flowMult = 1.4, segDwellMs = 250,
  // eprime: one-time prime after goto() leaves the nozzle retracted --
  // just over the RETRACT_MM (1.3mm) the goto pulled.
  eprime = 1.6, primedwellS = 1.0, retractMm = 4.0, retractSpeed = 1000,
  step = 0.1,
} = {}) {
  const pts = samplePath(xFunc, yFunc, tStart, tEnd, { step });
  const length = totalLength(pts);
  em.newPattern();

  const first = pointAtArcLength(pts, 0);
  em.goto(first[0], first[1], thinHeight);   // first segment is thin (i=0)
  em.a(`G1 E${eprime.toFixed(4)} F150`);
  em.eTotal += eprime;
  em.dwell(primedwellS * 1000);
  em.retracted = false;

  em.a("G91");
  let [curX, curY] = first;
  let curZ = thinHeight;
  let s = 0, i = 0;
  while (s < length - 1e-6) {
    const fat = i % 2 === 1;
    const segLen = fat ? fatLen : thinLen;
    const width  = fat ? fatWidth  : thinWidth;
    const height = fat ? fatHeight : thinHeight;
    const spd    = fat ? fatSpeed  : thinSpeed;
    const s1 = Math.min(s + segLen, length);
    const [nx, ny] = pointAtArcLength(pts, s1);
    const dx = nx - curX, dy = ny - curY;
    const segDist = Math.hypot(dx, dy);

    const dz = height - curZ;
    if (Math.abs(dz) > 1e-6) {
      em.a(`G1 Z${dz.toFixed(3)} F600`);
      curZ = height;
    }
    if (segDwellMs > 0) em.dwell(segDwellMs);

    if (segDist > 1e-9) {
      const eAmt = eRate(width, height, flowMult) * segDist;
      em.a(`G1 X${dx.toFixed(3)} Y${dy.toFixed(3)} E${eAmt.toFixed(4)} F${spd}`);
      em.eTotal += eAmt;
    }
    curX = nx; curY = ny;
    s = s1; i++;
  }
  em.a("G90");
  em.a(`G1 E${(-retractMm).toFixed(4)} F${retractSpeed}`);
  em.eTotal -= retractMm;
  em.x = curX; em.y = curY; em.z = curZ;
  em.retracted = true;
  return pts;
}

/** The sine-wave bulge technique, generalized to follow any path --
 * height varies as a function of ARC LENGTH along the path, not of x. */
export function freeformVariableThickness(em, xFunc, yFunc, tStart, tEnd, {
  hMin = 0.16, hMax = 0.9, wavelength = 8.0, beadWidth = 0.8,
  zGap = 0.25, speed = 25, peakDwellMs = 300, step = 0.1,
} = {}) {
  const pts = samplePath(xFunc, yFunc, tStart, tEnd, { step });
  em.newPattern();

  const hAt = (s) => hMin + (hMax - hMin) * 0.5 * (1 + Math.sin((2 * Math.PI * s) / wavelength));

  const firstH = hAt(0);
  em.goto(pts[0][0], pts[0][1], firstH + zGap);
  em.unretract();
  let prevH = firstH;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1, s1] = pts[i];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg < 1e-9) continue;
    const h1 = hAt(s1);
    const hAvg = (prevH + h1) / 2.0;
    em.printMove(x1, y1, seg * eRate(beadWidth, hAvg), speed, h1 + zGap);
    prevH = h1;
  }
  em.retract();
  return pts;
}

/**
 * ============================================================================
 * SECTION 4: REGIONS AND FILLS
 * ============================================================================
 * A region is {x0, y0, w, h} -- an axis-aligned rectangle; the only region
 * type implemented. Diamond/checkerboard fill is NOT a generic "lines at a
 * gap" pattern -- which cells get filled solid is a discrete checkerboard
 * parity selection, so it is its own dedicated function, never routed
 * through fillRegion().
 */

/** Exact (Liang-Barsky) clip of the infinite line (px,py)+s*(dx,dy)
 * against [x0,x1]x[y0,y1]. Returns [pStart,pEnd] or null if it misses. */
export function clipLineToRect(px, py, dx, dy, x0, y0, x1, y1) {
  let tMin = -Infinity, tMax = Infinity;
  const axes = [[px, dx, x0, x1], [py, dy, y0, y1]];
  for (const [p, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return null;
      continue;
    }
    let t0 = (lo - p) / d;
    let t1 = (hi - p) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tMin = Math.max(tMin, t0);
    tMax = Math.min(tMax, t1);
    if (tMin > tMax) return null;
  }
  return [[px + tMin * dx, py + tMin * dy], [px + tMax * dx, py + tMax * dy]];
}

/** Returns the clipped [start,end] line segments needed to fill `region`
 * with parallel lines at `angleDeg`, `gap` apart. Recomputes from scratch
 * every call. */
export function regionFillLines(region, angleDeg, gap) {
  const { x0, y0, w, h } = region;
  const x1 = x0 + w, y1 = y0 + h;
  const theta = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(theta), dy = Math.sin(theta);
  const nx = -Math.sin(theta), ny = Math.cos(theta);

  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
  const perpVals = corners.map(([cx, cy]) => cx * nx + cy * ny);
  const pMin = Math.min(...perpVals), pMax = Math.max(...perpVals);

  const segments = [];
  for (let p = pMin; p <= pMax; p += gap) {
    const px = p * nx, py = p * ny;
    const clipped = clipLineToRect(px, py, dx, dy, x0, y0, x1, y1);
    if (clipped) {
      const [[ax, ay], [bx, by]] = clipped;
      if (Math.hypot(bx - ax, by - ay) > 1e-6) segments.push(clipped);
    }
  }
  return segments;
}

/** Generic fill: clip parallel lines across `region` at `angleDeg`, `gap`
 * apart, drawn with `styleFunc` (any freeform* line style). NEVER use
 * this for diamond fill. */
export function fillRegion(em, region, styleFunc, { angleDeg = 0, gap = 4.0, ...styleOptions } = {}) {
  const segments = regionFillLines(region, angleDeg, gap);
  for (const [p0, p1] of segments) {
    const ddx = p1[0] - p0[0], ddy = p1[1] - p0[1];
    const length = Math.hypot(ddx, ddy);
    if (length < 1e-6) continue;
    const ux = ddx / length, uy = ddy / length;
    const xFunc = (t) => p0[0] + t * ux;
    const yFunc = (t) => p0[1] + t * uy;
    styleFunc(em, xFunc, yFunc, 0, length, styleOptions);
  }
}

/** Returns the clipped [start,end] segments needed to fill a polygon (an
 * array of [x,y] points, edges implied by consecutive pairs plus a
 * closing edge back to the first point -- SIMPLE, non-self-intersecting,
 * single contour, no holes; behavior is undefined otherwise) with
 * parallel lines at `angleDeg`, `gap` apart. The polygon analogue of
 * regionFillLines(): projects every vertex onto the sweep normal to find
 * the scan range, then for each swept line finds ALL intersections with
 * the polygon's edges (not just 2, as a rectangle guarantees), sorts them
 * along the sweep direction, and pairs up consecutive crossings as filled
 * sub-segments (standard scanline polygon fill). */
export function polygonFillLines(polygon, angleDeg, gap) {
  const theta = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(theta), dy = Math.sin(theta);
  const nx = -Math.sin(theta), ny = Math.cos(theta);

  const perpVals = polygon.map(([px, py]) => px * nx + py * ny);
  const pMin = Math.min(...perpVals), pMax = Math.max(...perpVals);

  const n = polygon.length;
  const segments = [];
  for (let p = pMin; p <= pMax; p += gap) {
    const ox = p * nx, oy = p * ny; // a point on this sweep line
    const hits = [];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % n];
      const ex = bx - ax, ey = by - ay;
      const cx = ax - ox, cy = ay - oy;
      const denom = ex * dy - ey * dx;
      if (Math.abs(denom) < 1e-12) continue; // edge parallel to the sweep line
      const s = (ex * cy - ey * cx) / denom;   // position along the sweep line
      const u = (dx * cy - dy * cx) / denom;   // position along the edge
      if (u < -1e-9 || u > 1 + 1e-9) continue; // intersection outside this edge segment
      hits.push(s);
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const s0 = hits[i], s1 = hits[i + 1];
      if (s1 - s0 > 1e-6) {
        segments.push([[ox + s0 * dx, oy + s0 * dy], [ox + s1 * dx, oy + s1 * dy]]);
      }
    }
  }
  return segments;
}

/** Generic polygon fill: clip parallel lines across `polygon` at
 * `angleDeg`, `gap` apart, drawn with `styleFunc` (any freeform* line
 * style) -- the polygon-boundary analogue of fillRegion(). NEVER use this
 * for diamond fill (DIAMOND stays rectangle-only). */
export function fillPolygonRegion(em, polygon, styleFunc, { angleDeg = 0, gap = 4.0, ...styleOptions } = {}) {
  const segments = polygonFillLines(polygon, angleDeg, gap);
  for (const [p0, p1] of segments) {
    const ddx = p1[0] - p0[0], ddy = p1[1] - p0[1];
    const length = Math.hypot(ddx, ddy);
    if (length < 1e-6) continue;
    const ux = ddx / length, uy = ddy / length;
    const xFunc = (t) => p0[0] + t * ux;
    const yFunc = (t) => p0[1] + t * uy;
    styleFunc(em, xFunc, yFunc, 0, length, styleOptions);
  }
}

function clipLineFamilyRegion(x0, y0, w, h, constVal, family) {
  const nScan = 200;
  let prevValid = false, runStart = null, prevPt = null, result = null;
  for (let k = 0; k <= nScan; k++) {
    const px = x0 + (w * k) / nScan;
    const py = family === "diff" ? px - constVal : constVal - px;
    const valid = py >= y0 && py <= y0 + h;
    if (valid && !prevValid) runStart = [px, py];
    if (!valid && prevValid) { result = [runStart, prevPt]; break; }
    prevValid = valid;
    prevPt = [px, py];
  }
  if (result === null && prevValid) result = [runStart, prevPt];
  return result;
}

/** Standard multi-layer stroke: print `points` as a path, nLayers times,
 * each pass a full layer higher. */
export function emitStroke(em, points, nLayers, width, speed) {
  for (let layer = 1; layer <= nLayers; layer++) {
    const z = LAYER_HEIGHT * layer;
    em.goto(points[0][0], points[0][1], z);
    em.unretract();
    for (let i = 1; i < points.length; i++) {
      const seg = dist(points[i - 1], points[i]);
      if (seg < 1e-9) continue;
      em.printMove(points[i][0], points[i][1], seg * eRate(width, LAYER_HEIGHT), speed);
    }
    em.retract();
  }
}

/** Diamond lattice with checkerboard fill. region={x0,y0,w,h}. Indexes
 * diamonds by their TRUE rotated-square-grid coordinates (i,j) via
 * center=(x0+half*(i+j), y0+half*(i-j)), checkerboard parity=(i+j)%2.
 * DO NOT reimplement this via fillRegion(). */
export function diamondFillRegion(em, region, { diag = 8.0, fillGap = 0.6 } = {}) {
  const { x0, y0, w, h } = region;
  em.newPattern();
  const half = diag / 2.0;

  const diamonds = [];
  const N = Math.floor((w + h) / diag) + 3;
  for (let i = -N; i <= N; i++) {
    for (let j = -N; j <= N; j++) {
      const cx = x0 + half * (i + j);
      const cy = y0 + half * (i - j);
      if (cx < x0 - diag || cx > x0 + w + diag) continue;
      if (cy < y0 - diag || cy > y0 + h + diag) continue;
      diamonds.push([cx, cy, (i + j) % 2 === 0]);
    }
  }

  const diffConsts = new Set(), sumConsts = new Set();
  for (const [cx, cy] of diamonds) {
    diffConsts.add(Math.round((cx - cy - half) * 10000) / 10000);
    diffConsts.add(Math.round((cx - cy + half) * 10000) / 10000);
    sumConsts.add(Math.round((cx + cy - half) * 10000) / 10000);
    sumConsts.add(Math.round((cx + cy + half) * 10000) / 10000);
  }

  for (const c of [...diffConsts].sort((a, b) => a - b)) {
    const seg = clipLineFamilyRegion(x0, y0, w, h, c, "diff");
    if (seg) emitStroke(em, seg, 2, 0.4, 400);
  }
  for (const c of [...sumConsts].sort((a, b) => a - b)) {
    const seg = clipLineFamilyRegion(x0, y0, w, h, c, "sum");
    if (seg) emitStroke(em, seg, 2, 0.4, 400);
  }

  for (const [cx, cy, filled] of diamonds) {
    if (!filled) continue;
    for (let yy = cy - half + fillGap; yy < cy + half - 1e-6; yy += fillGap) {
      if (yy >= y0 && yy <= y0 + h) {
        const ww = half - Math.abs(yy - cy);
        if (ww > 0.05) {
          const xa = Math.max(x0, cx - ww);
          const xb = Math.min(x0 + w, cx + ww);
          if (xb > xa) emitStroke(em, [[xa, yy], [xb, yy]], 2, 0.4, 450);
        }
      }
    }
  }
  return diamonds;
}

/** Explicit adjacency verification -- the ONLY acceptable way to confirm
 * diamond fill correctness. Visual inspection is NOT sufficient. Always
 * call this after generating/modifying diamond fill and confirm
 * violations === 0 before trusting the output. */
export function verifyCheckerboard(diamonds, diag) {
  const half = diag / 2.0;
  const lookup = new Map();
  for (const [cx, cy, filled] of diamonds) {
    lookup.set(`${Math.round(cx * 1000) / 1000},${Math.round(cy * 1000) / 1000}`, filled);
  }
  let checked = 0, violations = 0;
  const offsets = [[half, half], [half, -half], [-half, half], [-half, -half]];
  for (const [cx, cy, filled] of diamonds) {
    for (const [ddx, ddy] of offsets) {
      const key = `${Math.round((cx + ddx) * 1000) / 1000},${Math.round((cy + ddy) * 1000) / 1000}`;
      if (lookup.has(key)) {
        checked += 1;
        if (lookup.get(key) === filled) violations += 1;
      }
    }
  }
  return { checked, violations };
}

// pass as `style` to fill() to request diamond fill
export const DIAMOND = "__diamond__";

/** THE single unified entry point for all fills. `region` is either a
 * rectangle `{x0,y0,w,h}` or a polygon (an array of `[x,y]` points, e.g.
 * a sampled parametric boundary). `style` is either DIAMOND (routed to
 * the dedicated diamond algorithm -- rectangle regions only) or any
 * freeform* line-style function (routed through fillRegion() for a
 * rectangle, fillPolygonRegion() for a polygon). Callers never need to
 * know this split exists. */
export function fill(em, region, style, options = {}) {
  const isPolygon = Array.isArray(region);
  if (style === DIAMOND) {
    if (isPolygon) throw new Error("DIAMOND fill only supports a rectangular region, not a polygon boundary");
    return diamondFillRegion(em, region, options);
  } else if (isPolygon) {
    return fillPolygonRegion(em, region, style, options);
  } else {
    return fillRegion(em, region, style, options);
  }
}

/**
 * ============================================================================
 * SECTION 5: STANDALONE DOTS
 * ============================================================================
 */

/**
 * Shared point-extrusion mechanism for blobDot() / freeformBlobDotted():
 * builds a small dome by extruding WHILE rising in Z (no XY movement),
 * dwell, retract, orbit around the dome at its own height, then (via the
 * caller's next goto()) travel to the next spot. `diameter` is the primary
 * sizing knob; filament amount is DERIVED from it via a standoff-cylinder
 * + hemispherical-dome volume model, converted through FIL_AREA and scaled
 * by `extrusionMultiplier`.
 *
 * The rise is split into `buildSteps` increments, extruding at each step,
 * tapering toward the top by `taperFactor` (deliberate "coasting" so
 * residual nozzle pressure finishes the tip instead of a hard stop). The
 * first step also carries the priming restoration (folded in rather than
 * emitted as a stationary E-only line -- extrusion and motion are never
 * separated here) plus `baseExtraMm`, a deliberately bigger first-contact
 * blob meant to spread and stick to the bed before the rest piles on top,
 * followed by its own `baseDwellMs` dwell.
 *
 * `retractMm` (default 4.0mm) is dot-specific, larger than the shared
 * global default (1.3mm) -- confirmed on hardware to reduce stringing for
 * this deposition method; only the distance is increased; speed stays at
 * the global default (TPU filament-damage caution: don't retract fast).
 *
 * Anti-stringing: after retract + `postRetractDwellMs`, trace an orbit
 * (`orbitRadius`, default the dot's own radius) around (cx, cy) at the
 * dome's own top height, repeated `orbitLoops` times, no extrusion --
 * confirmed on hardware to reduce stringing. Pass `orbitRadius: 0` to
 * disable it.
 */
function emitBlobDot(em, cx, cy, {
  diameter = 1.6, baseZ = 0.2, buildSteps = 6, taperFactor = 0.7,
  extrudeSpeed = 120, dwellMs = 2000, extrusionMultiplier = 1.3,
  retractMm = 4.0, postRetractDwellMs = 2000, baseExtraMm = 0.3,
  baseDwellMs = 1000, orbitRadius = null, orbitPts = 16, orbitSpeed = 600,
  orbitLoops = 3, orbitDwellMs = 2000, blobClearanceMm = 0.3,
  liftZ = 5.0, liftSpeed = 600, liftDwellMs = 1000, topOrbitLoops = 3,
} = {}) {
  const radius = diameter / 2.0;
  const domeHeight = radius;
  const standoffVolume = Math.PI * radius * radius * baseZ;
  const domeVolume = (2 / 3) * Math.PI * radius ** 3;
  const totalE = ((standoffVolume + domeVolume) / FIL_AREA) * extrusionMultiplier;

  em.goto(cx, cy, baseZ);

  const bonus = em.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
  em.pendingPrimeBonus = false;
  const primeE = retractMm + bonus;
  em.retracted = false;

  const nSteps = Math.max(1, Math.round(buildSteps));
  const zStep = domeHeight / nSteps;
  const weights = [];
  for (let i = 0; i < nSteps; i++) {
    weights.push(1 - taperFactor * (nSteps > 1 ? i / (nSteps - 1) : 0));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let z = baseZ;
  for (let i = 0; i < nSteps; i++) {
    z += zStep;
    const stepE = totalE * (weights[i] / weightSum) + (i === 0 ? primeE + baseExtraMm : 0);
    em.a(`G1 Z${z.toFixed(3)} E${stepE.toFixed(4)} F${extrudeSpeed}`);
    em.eTotal += stepE;
    if (i === 0) em.dwell(baseDwellMs);
  }
  em.z = z;

  em.dwell(dwellMs);

  em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
  em.eTotal -= retractMm;
  em.retracted = true;

  em.dwell(postRetractDwellMs);

  const actualOrbitRadius = orbitRadius ?? radius;
  const nOrbit = Math.max(3, Math.round(orbitPts));
  if (actualOrbitRadius > 0) {
    const nLoops = Math.max(1, Math.round(orbitLoops));
    for (let loop = 0; loop < nLoops; loop++) {
      for (let i = 0; i <= nOrbit; i++) {
        const theta = (i / nOrbit) * 2 * Math.PI;
        const ox = cx + actualOrbitRadius * Math.cos(theta);
        const oy = cy + actualOrbitRadius * Math.sin(theta);
        em.a(`G0 X${ox.toFixed(3)} Y${oy.toFixed(3)} F${orbitSpeed}`);
        em.x = ox; em.y = oy;
      }
    }
  }
  // (recenter / lift / second orbit intentionally disabled -- the nozzle
  // goes straight from the dome-height orbit above to the next dot's
  // goto(), which itself lifts to travel height before the XY move)
}

/** The DEFAULT dot texture -- a single-point "blob" dot, preferred over
 * circularDot() unless a flat, precisely spiral-filled disc is
 * specifically needed. Extrudes filament at one fixed XY position (no
 * lateral movement), dwells, retracts, orbits -- see emitBlobDot() above. */
export function blobDot(em, cx, cy, options = {}) {
  em.newPattern();
  emitBlobDot(em, cx, cy, options);
}

/**
 * "Directional" blob dot -- a `blobDot`-family dome that LEANS in a chosen
 * compass direction, for a raked/combed-looking tactile bump. Reuses
 * `blobDot`'s volume model, with two `azimuthDeg`-driven changes:
 *  1. SHEARED BUILD -- the nozzle travels `radius` in the azimuth
 *     direction as it rises through `buildSteps` to the dome top, while
 *     extruding, so the apex ends off-center in that direction.
 *  2. SQUISH-THEN-DRAG -- after build/dwell/retract/dwell, the nozzle
 *     (still at the leaning apex) drops straight down to bed level
 *     (squishing the leaning blob onto the bed), then drags laterally
 *     -azimuth by `diameter`, ending at the trailing edge of the base
 *     circle. This shapes the blob AND sweeps near any residual string.
 * `azimuthDeg` is CCW from +X (same convention as `hairyDot`).
 */
function emitDirectionalBlobDot(em, cx, cy, {
  diameter = 2.0, azimuthDeg = 0, baseZ = 0.2, buildSteps = 6,
  taperFactor = 0.7, extrudeSpeed = 120, dwellMs = 2000,
  extrusionMultiplier = 1.3, retractMm = 4.0, postRetractDwellMs = 2000,
  baseExtraMm = 0.3, baseDwellMs = 1000, dragSpeed = 600,
} = {}) {
  const radius = diameter / 2.0;
  const domeHeight = radius;
  const standoffVolume = Math.PI * radius * radius * baseZ;
  const domeVolume = (2 / 3) * Math.PI * radius ** 3;
  const totalE = ((standoffVolume + domeVolume) / FIL_AREA) * extrusionMultiplier;

  const azR = (azimuthDeg * Math.PI) / 180;
  const ax = Math.cos(azR), ay = Math.sin(azR);

  em.goto(cx, cy, baseZ);

  const bonus = em.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
  em.pendingPrimeBonus = false;
  const primeE = retractMm + bonus;
  em.retracted = false;

  const nSteps = Math.max(1, Math.round(buildSteps));
  const zStep = domeHeight / nSteps;
  const xStep = (ax * radius) / nSteps, yStep = (ay * radius) / nSteps;
  const weights = [];
  for (let i = 0; i < nSteps; i++) {
    weights.push(1 - taperFactor * (nSteps > 1 ? i / (nSteps - 1) : 0));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let z = baseZ, bx = cx, by = cy;
  for (let i = 0; i < nSteps; i++) {
    z += zStep; bx += xStep; by += yStep;
    const stepE = totalE * (weights[i] / weightSum) + (i === 0 ? primeE + baseExtraMm : 0);
    em.a(`G1 X${bx.toFixed(3)} Y${by.toFixed(3)} Z${z.toFixed(3)} E${stepE.toFixed(4)} F${extrudeSpeed}`);
    em.eTotal += stepE;
    if (i === 0) em.dwell(baseDwellMs);
  }
  em.x = bx; em.y = by; em.z = z;
  const apexX = bx, apexY = by;

  em.dwell(dwellMs);

  em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
  em.eTotal -= retractMm;
  em.retracted = true;
  em.dwell(postRetractDwellMs);

  em.a(`G1 Z${baseZ.toFixed(3)} F${dragSpeed}`);
  em.z = baseZ;
  const endX = apexX - ax * diameter, endY = apexY - ay * diameter;
  em.a(`G1 X${endX.toFixed(3)} Y${endY.toFixed(3)} F${dragSpeed}`);
  em.x = endX; em.y = endY;
}

/** The directional (leaning) blob dot -- see emitDirectionalBlobDot()
 * above. `azimuthDeg` (CCW from +X) sets the lean direction. For a line
 * of these use freeformDirectionalBlobDotted(). */
export function directionalBlobDot(em, cx, cy, options = {}) {
  em.newPattern();
  emitDirectionalBlobDot(em, cx, cy, options);
}

/** A single solid circular dot, built by spiraling a fill path outward --
 * an ALTERNATIVE to the default blobDot() when a flat, precisely
 * diameter'd disc is needed (diameter and height are independently
 * controlled, unlike blobDot()'s derived-from-diameter dome). height
 * should be a multiple of LAYER_HEIGHT (0.2mm). No hollow-centre
 * ("donut") shape is implemented. */
export function circularDot(em, cx, cy, { diameter = 1.6, height = 0.4, speed = 250 } = {}) {
  const nLayers = Math.max(MIN_LAYERS, Math.round(height / LAYER_HEIGHT));
  const pts = spiralDisc([cx, cy], diameter / 2.0);
  em.newPattern();
  emitStroke(em, pts, nLayers, 0.42, speed);
}

// The 4 named hair directions, as (azimuth, elevation) degree pairs.
// Elevation is measured from the bed plane (0 = flat, 90 = straight up);
// azimuth is CCW from +X.
const HAIR_PRESET = {
  top:    { azDeg: 0,   elDeg: 90 },
  right:  { azDeg: 0,   elDeg: 0 },
  left:   { azDeg: 180, elDeg: 0 },
  bottom: { azDeg: 270, elDeg: 0 },
};

/**
 * Resolve a hair pull direction to azimuth/elevation degrees plus a unit
 * vector (dx,dy,dz). Explicit `azimuthDeg` / `elevationDeg` (either one
 * non-null) win over the `hairDirection` string preset; an unset explicit
 * angle defaults (azimuth 0 = +X, elevation 90 = straight up).
 */
function resolveHairDir(hairDirection, azimuthDeg, elevationDeg) {
  let azDeg, elDeg;
  if (azimuthDeg != null || elevationDeg != null) {
    azDeg = azimuthDeg ?? 0;
    elDeg = elevationDeg ?? 90;
  } else {
    if (!(hairDirection in HAIR_PRESET)) {
      throw new Error(
        `hairyDot: hairDirection must be "top", "left", "right", or ` +
        `"bottom" (got "${hairDirection}"), or pass hairAzimuthDeg / ` +
        `hairElevationDeg for an arbitrary polar direction`
      );
    }
    ({ azDeg, elDeg } = HAIR_PRESET[hairDirection]);
  }
  const DEG = Math.PI / 180;
  const elR = elDeg * DEG, azR = azDeg * DEG;
  const dxy = Math.cos(elR);
  return {
    azDeg, elDeg,
    dx: Math.cos(azR) * dxy,
    dy: Math.sin(azR) * dxy,
    dz: Math.sin(elR),
  };
}

/**
 * A single dot with ONE hair strand pulled from its center. Builds a real
 * root dome first (reusing emitBlobDot's own tapered-rise build mechanism
 * and volume model), then pulls a hair out of that dome's own melt:
 *  1. EXTRUDE segment -- move `hairLength` mm along the pull vector while
 *     extruding a real bead (cross-section via the shared `eRate()`
 *     helper), split into a rate-matched extrude sub-move plus a
 *     no-extrusion "dry rise" finishing the climb, so the bead is fully
 *     laid down before the tip stretches to height.
 *  2. Retract immediately (fixes whole-pull stringing from the
 *     pressurized root), dwell.
 *  3. An optional clearance hop (near-horizontal pulls only), then a
 *     short STRING segment (fast, zero extrusion) and `overtravelMm` for
 *     final clearance from wherever the next dot is.
 * `hairThickness`, when `null`, derives from `hairLength`
 * (`0.5 * (hairLength/4.0)`, clamped 0.4-2.0mm). `rootDiameter` changes how
 * soft/tough the finished hair feels and is kept independent of the
 * thickness derivation on purpose. `hairDirection`/`hairAzimuthDeg`/
 * `hairElevationDeg` resolve via `resolveHairDir()` above.
 * CAUTION: one retract/unretract cycle PER dot -- see
 * PARAMETER_CONSTRAINTS.md before a dense `gap` over a long path.
 */
function emitHairyDot(em, cx, cy, {
  rootDiameter = 2.0, baseZ = 0.2, buildSteps = 6, taperFactor = 0.7,
  extrudeSpeed = 120, baseExtraMm = 0.3, baseDwellMs = 1000,
  dwellMs = 2000, extrusionMultiplier = 1.3, hairThickness = null,
  hairLength = 10.0, pullExtrudeSpeed = 150, beadFlowMult = 3.5,
  dryRiseFeedDrop = 10, retractMm = 4.0,
  postRetractDwellMs = 500, hairDirection = "top",
  hairAzimuthDeg = null, hairElevationDeg = null, stringMm = 2.0,
  hairSpeed = 8000, clearanceZ = 0.5, clearanceSpeed = 600,
  overtravelMm = 2.0, overtravelSpeed = 600,
} = {}) {
  const { elDeg, dx, dy, dz } = resolveHairDir(
    hairDirection, hairAzimuthDeg, hairElevationDeg);

  // root dome build -- identical formulas/loop to emitBlobDot's own build.
  const radius = rootDiameter / 2.0;
  const domeHeight = radius;
  const standoffVolume = Math.PI * radius * radius * baseZ;
  const domeVolume = (2 / 3) * Math.PI * radius ** 3;
  const totalE = ((standoffVolume + domeVolume) / FIL_AREA) * extrusionMultiplier;

  const HAIR_T_REF = 0.5, HAIR_L_REF = 4.0;
  const effThickness = hairThickness ??
    Math.min(2.0, Math.max(0.4, HAIR_T_REF * (hairLength / HAIR_L_REF)));

  const pullERate = eRate(effThickness, effThickness, extrusionMultiplier * beadFlowMult);

  em.goto(cx, cy, baseZ);

  const bonus = em.pendingPrimeBonus ? LINE_START_PRIME_MM : 0.0;
  em.pendingPrimeBonus = false;
  const primeE = retractMm + bonus;
  em.retracted = false;

  const nSteps = Math.max(1, Math.round(buildSteps));
  const zStep = domeHeight / nSteps;
  const weights = [];
  for (let i = 0; i < nSteps; i++) {
    weights.push(1 - taperFactor * (nSteps > 1 ? i / (nSteps - 1) : 0));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let z = baseZ;
  for (let i = 0; i < nSteps; i++) {
    z += zStep;
    const stepE = totalE * (weights[i] / weightSum) + (i === 0 ? primeE + baseExtraMm : 0);
    em.a(`G1 Z${z.toFixed(3)} E${stepE.toFixed(4)} F${extrudeSpeed}`);
    em.eTotal += stepE;
    if (i === 0) em.dwell(baseDwellMs);
  }
  em.z = z;

  em.dwell(dwellMs);

  const dryF = Math.max(1, pullExtrudeSpeed - dryRiseFeedDrop);
  const eA = pullERate * hairLength;
  const dExtrude = Math.min(eA, hairLength);

  const HORIZ = Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9;
  const VERT = Math.abs(dz) > 1e-9;
  const pull = (d, e, f, rapid) => {
    const nx = em.x + dx * d, ny = em.y + dy * d, nz = em.z + dz * d;
    let s = rapid ? "G0" : "G1";
    if (HORIZ) s += ` X${nx.toFixed(3)} Y${ny.toFixed(3)}`;
    if (VERT) s += ` Z${nz.toFixed(3)}`;
    if (e != null) { s += ` E${e.toFixed(4)}`; em.eTotal += e; }
    s += ` F${f}`;
    em.a(s);
    em.x = nx; em.y = ny; em.z = nz;
  };

  pull(dExtrude, eA, pullExtrudeSpeed, false);
  if (hairLength > dExtrude + 1e-6) pull(hairLength - dExtrude, null, dryF, false);

  em.a(`G1 E${(-retractMm).toFixed(4)} F${RETRACT_SPEED}`);
  em.eTotal -= retractMm;
  em.retracted = true;
  em.dwell(postRetractDwellMs);

  const HAIR_CLEARANCE_MAX_EL_DEG = 30;
  if (elDeg < HAIR_CLEARANCE_MAX_EL_DEG && clearanceZ > 0) {
    em.a(`G0 Z${(em.z + clearanceZ).toFixed(3)} F${clearanceSpeed}`);
    em.z += clearanceZ;
  }

  if (stringMm > 0) pull(stringMm, null, hairSpeed, true);
  pull(overtravelMm, null, overtravelSpeed, true);
}

/** The dot form of the hairy texture -- see emitHairyDot() above. Do NOT
 * improvise a single hairy dot by calling `freeformHairy` with a
 * zero-length path -- that function's strand-placement logic assumes a
 * path with real extent. */
export function hairyDot(em, cx, cy, options = {}) {
  em.newPattern();
  emitHairyDot(em, cx, cy, options);
}

/**
 * ============================================================================
 * SECTION 6: MULTI-TEXTURE LAYOUT VERIFICATION
 * ============================================================================
 * Nothing else here checks whether two SEPARATELY-chosen regions
 * physically overlap -- overlapping regions generate silently, then crash
 * the nozzle into already-printed material during the actual print.
 */

/** Returns the overlapping area in mm^2 between two regions (0 if none). */
export function regionOverlapArea(a, b) {
  const xOverlap = Math.max(0, Math.min(a.x0 + a.w, b.x0 + b.w) - Math.max(a.x0, b.x0));
  const yOverlap = Math.max(0, Math.min(a.y0 + a.h, b.y0 + b.h) - Math.max(a.y0, b.y0));
  return xOverlap * yOverlap;
}

/**
 * Checks a list of regions for overlaps and for insufficient clearance.
 * Call this BEFORE generating a multi-texture print, and confirm
 * `ok === true`. Overlaps are hard failures (nozzle collision); gaps
 * smaller than minGap are warnings (features may fuse together).
 */
export function verifyLayout(regions, { minGap = 0.5, bedMargin = 15.0 } = {}) {
  const errors = [];
  const warnings = [];

  regions.forEach((r, i) => {
    const label = r.name || `region[${i}]`;
    if (r.x0 < bedMargin || r.y0 < bedMargin ||
        r.x0 + r.w > BED_X - bedMargin || r.y0 + r.h > BED_Y - bedMargin) {
      errors.push(
        `${label} at x[${r.x0}-${r.x0 + r.w}] y[${r.y0}-${r.y0 + r.h}] ` +
        `falls outside the safe bed area (${bedMargin}mm margin on a ` +
        `${BED_X}x${BED_Y}mm bed).`
      );
    }
  });

  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j];
      const la = a.name || `region[${i}]`, lb = b.name || `region[${j}]`;
      const area = regionOverlapArea(a, b);
      if (area > 0) {
        errors.push(
          `${la} and ${lb} OVERLAP by ${area.toFixed(1)}mm^2 -- the nozzle ` +
          `would crash into already-printed material. Move one of them.`
        );
        continue;
      }
      const xGap = Math.max(a.x0 - (b.x0 + b.w), b.x0 - (a.x0 + a.w));
      const yGap = Math.max(a.y0 - (b.y0 + b.h), b.y0 - (a.y0 + a.h));
      const clearance = Math.max(xGap, yGap);
      if (clearance < minGap) {
        warnings.push(
          `${la} and ${lb} are only ${clearance.toFixed(1)}mm apart ` +
          `(recommended minimum ${minGap}mm) -- adjacent features may fuse.`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
