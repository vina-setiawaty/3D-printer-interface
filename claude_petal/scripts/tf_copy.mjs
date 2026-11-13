/**
 * texture_functions.js (texture-actions) -- the texture library the
 * texture-actions page runs, edits and saves defaults back into. Every
 * texture is a STROKE that walks a path and calls a BRUSH, one mark at a
 * time.
 *
 *   SECTION 2  path engine   -- a formula path (samplePath) or an explicit
 *                              polyline (polylineToPts) becomes an
 *                              arc-length-tagged point list.
 *   SECTION 3  strokes and line brushes
 *                            -- stroke*(em, pts, options) walks the list;
 *                              brush*() lays one bead / dash / thin+fat
 *                              pair / wave.
 *   SECTION 4  patterns      -- hatchStrokes / diamondStrokes: how a region
 *                              becomes a list of paths for a stroke.
 *   SECTION 5  dot brushes   -- brush*(em, cx, cy, options): one dot or
 *                              hair at a point, for the dot strokes.
 *
 * BRUSHES at the end maps each texture name to its stroke. Comments
 * document only the FINAL current behavior -- see ../texture_docs/ for the
 * historical tuning log.
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
export const FLOW_PERCENT = 180;

// Conservative placeholder pending a confirming print (same status as
// every other PRINT_LIMITS number) -- the extruder's maximum volumetric
// flow rate, for the Ender 3 V2 / Sprite direct-drive, 0.4mm nozzle, TPU.
// Well under Takahashi & Miyashita's ~11mm3/s (UIST'16 Adjunct,
// "Thickness Control Technique for Printing Tactile Sheets with FDM"),
// which was measured on a different printer and not specifically TPU --
// TPU buckles under back-pressure well before a rigid filament would, so
// published safe rates for it on a standard hotend commonly sit lower.
export const MAX_EXTRUSION_RATE_MM3_S = 4.0;

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
 * stroke walks.
 */

/**
 * Samples (xFunc(t), yFunc(t)) from tStart to tEnd at a fixed step in t
 * (deliberately NOT adaptive), always including tEnd.
 * Returns array of [x, y, s], s = cumulative arc length from tStart.
 */
export function samplePath(xFunc, yFunc, tStart, tEnd, { step = 0.1 } = {}) {
  const pts = [];
  for (let t = tStart; t < tEnd - 1e-9; t += step) pts.push([xFunc(t), yFunc(t)]);
  pts.push([xFunc(tEnd), yFunc(tEnd)]);

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
 * The polyline counterpart of samplePath(): turns an explicit
 * [[x,y], ...] point list (corners allowed -- no steepness check, the
 * corners are deliberate) into the same arc-length-tagged [x, y, s] list
 * every brush walks. `step` densifies each straight run so a brush sees
 * the same point density it sees from a formula path (dash sub-segment
 * filtering and per-point height profiles depend on it); pass `null` to
 * keep only the given vertices (a solid brush on a straight run needs no
 * more than that).
 */
export function polylineToPts(points, step = 0.1) {
  if (!Array.isArray(points) || points.length < 2) throw new Error("polylineToPts needs at least 2 points");
  // Walk each straight run exactly the way samplePath() walks
  // xFunc(t) = p0 + t*u (unit direction, t += step while t < len - 1e-9,
  // then the exact end), and tag arc length by accumulated hypot between
  // consecutive points -- same float rounding, so a brush's arc-length
  // boundary tests give the same answer as on a formula path.
  const raw = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-9) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    if (step) {
      let t = step;
      while (t < len - 1e-9) { raw.push([x0 + t * ux, y0 + t * uy]); t += step; }
    }
    raw.push([x0 + len * ux, y0 + len * uy]);
  }
  const out = [[raw[0][0], raw[0][1], 0.0]];
  let s = 0.0;
  for (let i = 1; i < raw.length; i++) {
    s += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    out.push([raw[i][0], raw[i][1], s]);
  }
  return out;
}

/**
 * ============================================================================
 * SECTION 3: STROKES AND LINE BRUSHES
 * ============================================================================
 * Every texture is a STROKE walking a path and calling a BRUSH:
 *
 *   brush*(em, ..., options)   ONE mark -- a bead between two points, one
 *                              dash, one thin+fat pair, one wave (here), or
 *                              one dot / hair (SECTION 5). It holds that
 *                              mark's own options and their defaults.
 *   stroke*(em, pts, { walk options, ...brush })
 *                              walks an arc-length-tagged point list (from
 *                              samplePath() or polylineToPts()) and calls
 *                              its brush along it. It holds only how it
 *                              walks (gap, spacing, layers, order, priming);
 *                              every other option passes straight through
 *                              to the brush as `brush`.
 *
 * BRUSHES (end of file) maps each texture name to its stroke; a card reads
 * its defaults from both functions (spec.js `sigs`). A line brush takes the
 * path from where it starts (restOfPath()) and returns how many mm it used,
 * so the stroke can call it again from there. Neither ever calls
 * em.newPattern() -- the caller does, once per printed element.
 */

/** The path from arc length `a` on, re-based so it starts at s = 0. */
function restOfPath(pts, a) {
  if (a <= 0) return pts;
  const [x0, y0] = pointAtArcLength(pts, a);
  const out = [[x0, y0, 0]];
  for (const [x, y, s] of pts) if (s > a) out.push([x, y, s - a]);
  return out;
}

/** BRUSH: one straight bead from p0 to p1, one layer high, at the nozzle's
 * current height -- the stroke has already travelled, primed and set Z. */
function brushSolid(em, p0, p1, { width = 0.5, speed = 400 } = {}) {
  const seg = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (seg < 1e-9) return;
  em.printMove(p1[0], p1[1], seg * eRate(width, LAYER_HEIGHT), speed);
}

/** STROKE: a continuous solid ridge, `nLayers` high. Per layer: travel to
 * the start at that layer's height, prime, one brushSolid() bead per pair
 * of points, retract. */
export function strokeSolid(em, pts, { nLayers = 2, ...brush } = {}) {
  for (let layer = 1; layer <= nLayers; layer++) {
    em.goto(pts[0][0], pts[0][1], LAYER_HEIGHT * layer);
    em.unretract();
    for (let i = 1; i < pts.length; i++) brushSolid(em, pts[i - 1], pts[i], brush);
    em.retract();
  }
  return pts;
}

/** BRUSH: one dash -- `segLen` mm of solid ridge from the start of `pts`
 * (shorter if the path ends first), `nLayers` high, each layer with its own
 * travel / prime / walk / retract -- followed by `gapLen` mm left blank.
 * Returns segLen + gapLen, where the next dash starts. */
function brushDashed(em, pts, {
  segLen = 8, gapLen = 4, width = 0.5, nLayers = 2, speed = 400,
} = {}) {
  if (!(segLen > 0) || !(gapLen >= 0)) {
    throw new RangeError(`dashed brush: segLen must be > 0 and gapLen >= 0 (got ${segLen}, ${gapLen})`);
  }
  const dash = pts.filter((p) => p[2] <= segLen);
  for (let layer = 1; layer <= nLayers; layer++) {
    em.goto(dash[0][0], dash[0][1], LAYER_HEIGHT * layer);
    em.unretract();
    for (let i = 1; i < dash.length; i++) {
      const seg = Math.hypot(dash[i][0] - dash[i - 1][0], dash[i][1] - dash[i - 1][1]);
      if (seg < 1e-9) continue;
      em.printMove(dash[i][0], dash[i][1], seg * eRate(width, LAYER_HEIGHT), speed);
    }
    em.retract();
  }
  return segLen + gapLen;
}

/** STROKE: dashes of segLen mm with gapLen mm of travel between, measured
 * along the line. Calls brushDashed() again and again from where the last
 * one said to go on, until the path runs out; it only ever calls a dash,
 * so it cannot end on a gap. */
export function strokeDashed(em, pts, { ...brush } = {}) {
  const total = totalLength(pts);
  let s = 0;
  while (total - s > 1e-6) {
    const used = brushDashed(em, restOfPath(pts, s), brush);
    if (!(used > 0)) break;
    s += used;
  }
  return pts;
}

/**
 * Shared walker for the dot strokes below: compute arc-length stops every
 * `gap` from 0 to the path length (inclusive), optionally decide whether
 * to walk them in reverse, optionally compute each stop's local path
 * heading, then call `dotFn(cx, cy, {headingDeg})` at each stop.
 *
 * `reverseCheck`, if given, receives `{pts, length, gap, stops, step}` and
 * returns true/false -- each stroke supplies its OWN reversal criterion
 * (they differ: directional lean vs. hair-pull direction), this walker
 * does not impose one. `withTangent` additionally hands the dot a local
 * heading in degrees (only the directional lean needs this). `step` is
 * only the tangent half-width floor here (the caller already sampled).
 */
function walkArcLengthStops(pts, gap, step, { reverseCheck = null, withTangent = false } = {}, dotFn) {
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
      dotFn(cx, cy, { headingDeg });
    } else {
      dotFn(cx, cy, {});
    }
  }
  return pts;
}

/** STROKE: flat spiral-filled dots (brushSpiralDot) every `gap` mm. */
export function strokeDotted(em, pts, { gap = 10.0, step = 0.1, ...brush } = {}) {
  return walkArcLengthStops(pts, gap, step, {}, (cx, cy) => brushSpiralDot(em, cx, cy, brush));
}

/** STROKE: blob domes (brushBlobDot) every `gap` mm. The DEFAULT dotted
 * texture, preferred over strokeDotted() unless a flat, spiral-filled dot
 * is specifically needed. */
export function strokeBlobDotted(em, pts, { gap = 10.0, step = 0.1, ...brush } = {}) {
  return walkArcLengthStops(pts, gap, step, {}, (cx, cy) => brushBlobDot(em, cx, cy, brush));
}

/** STROKE: leaning blobs (brushDirectionalBlobDot) along the line, each
 * leaning along the line's direction plus azimuthDeg. On a curve each blob
 * rakes "downstream" along the path tangent at its stop. `azimuthDeg` is an OFFSET added to
 * that tangent, in degrees CCW -- 0 leans exactly along the direction of
 * travel. An empty `gap` is one dot diameter, so neighbouring base circles
 * just touch and the drags chain into a continuous raked ridge.
 * `brushOrder` "auto": if the lean at the path start points forward along
 * the path, the dots are laid in reverse, so each apex leans back over
 * already-placed (cooled) dots rather than toward the fresh next one. */
export function strokeDirectionalBlobDotted(em, pts, {
  gap = null, azimuthDeg = 0, brushOrder = "auto", step = 0.1, ...brush
} = {}) {
  const g = gap ?? brush.diameter ?? 2.0; // 2.0: brushDirectionalBlobDot's default diameter
  return walkArcLengthStops(pts, g, step, {
    withTangent: true,
    reverseCheck: ({ pts, length, gap, stops, step }) => {
      if (brushOrder === "reverse") return true;
      if (brushOrder !== "auto") return false;
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
    brushDirectionalBlobDot(em, cx, cy, { ...brush, azimuthDeg: headingDeg + azimuthDeg });
  });
}

/** BRUSH: one vertical-lift hair strand at (x, y). At the start of a line
 * (nozzle retracted) it travels there at `baseZ` and primes; otherwise the
 * stroke has already moved it there, still lifted from the last strand,
 * and it drops back to `baseZ`. Leaves the nozzle lifted with `retractMm`
 * pulled back -- not recorded as a retract, since the next strand's
 * `esegmentMm` pushes it out again. */
function brushHairyStrand(em, x, y, {
  esegmentMm = 1.2, retractMm = 1.3, dwellMs = 400,
  smallLift = 0.2, bigLift = 4.0, baseZ = 0.3,
} = {}) {
  if (em.retracted) {
    em.goto(x, y, baseZ);
    em.unretract();
  } else {
    em.a(`G0 Z${baseZ.toFixed(3)} F600`);
    em.z = baseZ;
  }
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
}

/** STROKE: hair strands (brushHairyStrand) every `spacing` mm. Between
 * strands it travels while still lifted, at `speed`, so the nozzle clears
 * the strand just placed instead of dragging through it -- one prime for
 * the whole line, not a full retract/travel/prime per strand. CAUTION:
 * each strand is still a retract/un-retract cycle -- mind the
 * retraction-cycle cap before a dense spacing over a long path. */
export function strokeHairy(em, pts, { spacing = 2.0, speed = 200, ...brush } = {}) {
  const nRoots = Math.floor(totalLength(pts) / spacing) + 1;
  for (let i = 0; i < nRoots; i++) {
    const [x, y] = pointAtArcLength(pts, i * spacing);
    if (i > 0) {
      em.a(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F${speed}`);
      em.x = x; em.y = y;
    }
    brushHairyStrand(em, x, y, brush);
  }
  em.retracted = true;
  return pts;
}

/** STROKE: hairy dots (brushHairyDot: a root dome plus one pulled hair)
 * every `gap` mm. Same retraction-cycle caution as strokeHairy (one
 * retract/unretract PER strand). `brushOrder` "auto": if the hair's XY
 * projection leans FORWARD along the path (toward the next dot), the dots
 * are laid in REVERSE, so every strand trails behind its own dot, away
 * from where the nozzle heads next. */
export function strokeHairyDotted(em, pts, {
  gap = 10.0, brushOrder = "auto", step = 0.1, ...brush
} = {}) {
  return walkArcLengthStops(pts, gap, step, {
    reverseCheck: ({ pts, length, gap, stops }) => {
      if (brushOrder === "reverse") return true;
      if (brushOrder !== "auto") return false;
      if (stops.length <= 1) return false;
      const { dx: hx, dy: hy } = resolveHairDir(brush.hairDirection, brush.hairAzimuthDeg, brush.hairElevationDeg);
      if (Math.hypot(hx, hy) <= 1e-6) return false;
      const p0 = pointAtArcLength(pts, 0);
      const p1 = pointAtArcLength(pts, Math.min(length, gap));
      return (hx * (p1[0] - p0[0]) + hy * (p1[1] - p0[1])) > 0;
    },
  }, (cx, cy) => brushHairyDot(em, cx, cy, brush));
}

/** BRUSH: one thin + fat pair from the start of `pts` -- `thinLen` mm at
 * thinWidth / thinHeight / thinSpeed, then `fatLen` mm at the fat values,
 * each one straight bead to its end point on the path, with Z set to its
 * own height (the fat section sitting a little higher is what lets its
 * extra volume spread into a genuinely wider bead instead of doming).
 * Dwells `segDwellMs` before each section. Cut short where the path ends.
 * Continuous: no travel, prime or retract -- the stroke does those.
 * Returns the mm it used. */
function brushSegmented(em, pts, {
  thinLen = 8.0, thinWidth = 0.8, thinHeight = 0.2, thinSpeed = 130,
  fatLen = 4.0, fatWidth = 1.6, fatHeight = 0.3, fatSpeed = 60,
  flowMult = 1.4, segDwellMs = 250,
} = {}) {
  const length = totalLength(pts);
  const sections = [
    [thinLen, thinWidth, thinHeight, thinSpeed],
    [fatLen, fatWidth, fatHeight, fatSpeed],
  ];
  let s = 0, cur = pts[0];
  for (const [len, width, height, speed] of sections) {
    if (s >= length - 1e-6) break;
    const s1 = Math.min(s + len, length);
    const next = pointAtArcLength(pts, s1);
    if (segDwellMs > 0) em.dwell(segDwellMs);
    const seg = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    if (seg >= 1e-9) em.printMove(next[0], next[1], seg * eRate(width, height, flowMult), speed, height);
    cur = next;
    s = s1;
  }
  return s;
}

/** STROKE: a continuous single-layer line of thin + fat pairs
 * (brushSegmented) to the end of the path. One prime at the start
 * (`eprime` mm, just over the RETRACT_MM the goto() pulled, then
 * `primedwellS`), one retract at the very end. Absolute (G90) throughout;
 * each section's height rides in its own G1 line. */
export function strokeSegmented(em, pts, {
  eprime = 1.6, primedwellS = 1.0, retractMm = 4.0, retractSpeed = 1000, ...brush
} = {}) {
  // start at the first (thin) section's height -- 0.2 is brushSegmented's default thinHeight
  em.goto(pts[0][0], pts[0][1], brush.thinHeight ?? 0.2);
  em.a(`G1 E${eprime.toFixed(4)} F150`);
  em.eTotal += eprime;
  em.dwell(primedwellS * 1000);
  em.retracted = false;

  const total = totalLength(pts);
  let s = 0;
  while (total - s > 1e-6) {
    const used = brushSegmented(em, restOfPath(pts, s), brush);
    if (!(used > 0)) break;
    s += used;
  }
  em.a(`G1 E${(-retractMm).toFixed(4)} F${retractSpeed}`);
  em.eTotal -= retractMm;
  em.retracted = true;
  return pts;
}

/** BRUSH: one wave of thickness control after Takahashi & Miyashita,
 * "Thickness Control Technique for Printing Tactile Sheets with Fused
 * Deposition Modeling" (UIST'16 Adjunct). Prints the first `wavelength` mm
 * of `pts` (less if the path is shorter) and returns how many mm it used,
 * so a Stroke can call it again from there. Height follows a cosine bump,
 * hMin -> hMax -> hMin, starting `phase` of the way into it (0.5 starts on
 * a peak -- use it on alternate rows). The nozzle rides on the bead top
 * (Z = H). Each micromovement extrudes E = W x H x L / filament area
 * (Eq. 1) at F = volRate / (H x W) x 60 (Eq. 2), so volumetric flow stays
 * constant and only nozzle speed changes with thickness. If the nozzle is
 * retracted (the start of a line) it travels to the start and primes
 * first; otherwise it carries on from where it is. Keep volRate below the
 * measured extruder limit. Speeds are mm/min. */
function brushVariableThickness(em, pts, {
  hMin = 0.24, hMax = 0.9, wavelength = 8.0, beadWidth = 0.8,
  volRate = 4.0,        // mm³/s, held constant (measured limit: 16.8)
  stepsPerWave = 25,    // micromovements per wave
  phase = 0,            // in waves; 0.5 on alternate rows
  gapLen = 0,           // set by the stroke: > 0 means the waves are apart
} = {}) {
  if (!(hMin >= 0)) throw new RangeError(`brushVariableThickness: hMin must be >= 0 mm (got ${hMin})`);
  if (!(hMax >= hMin)) throw new RangeError(`brushVariableThickness: hMax must be >= hMin (got ${hMax} < ${hMin})`);
  if (!(hMax > 0)) throw new RangeError(`brushVariableThickness: hMax must be > 0 mm (got ${hMax})`);
  if (!(wavelength > 0)) throw new RangeError(`brushVariableThickness: wavelength must be > 0 mm (got ${wavelength})`);
  if (!(gapLen >= 0)) throw new RangeError(`brushVariableThickness: gapLen must be >= 0 mm (got ${gapLen})`);

  const len = Math.min(wavelength, pts[pts.length - 1][2]);
  if (!(len > 0)) return 0;
  const hAt = (s) => hMin + (hMax - hMin) * 0.5 * (1 - Math.cos(2 * Math.PI * (s / wavelength + phase)));
  const n = Math.max(1, Math.round((stepsPerWave * len) / wavelength));

  let j = 1;
  let px = pts[0][0], py = pts[0][1], ph = hAt(0);
  if (em.retracted) {
    const liftZ = 1.5 * hMax;
    if (gapLen > 0 && em.z < liftZ) {
      // arriving across a gap (the stroke retracted after the last wave):
      // up to 1.5 x hMax, across to this wave's start, down to its height
      em.a(`G1 Z${liftZ.toFixed(3)} F3000`);
      em.a(`G0 X${px.toFixed(3)} Y${py.toFixed(3)} F${TRAVEL_SPEED}`);
      em.a(`G1 Z${ph.toFixed(3)} F1500`);
      em.x = px; em.y = py; em.z = ph;
    } else {
      em.goto(px, py, ph); // start of the line: the usual hop, travel, down
    }
    em.unretract();
  }
  for (let k = 1; k <= n; k++) {
    const s = (len * k) / n;
    while (j < pts.length - 1 && pts[j][2] < s) j++;
    const [xa, ya, sa] = pts[j - 1], [xb, yb, sb] = pts[j];
    const t = sb > sa ? (s - sa) / (sb - sa) : 1;
    const x = xa + (xb - xa) * t, y = ya + (yb - ya) * t;
    const h = hAt(s);
    const hAvg = (ph + h) / 2;
    const L = Math.hypot(x - px, y - py);
    em.printMove(x, y, (beadWidth * hAvg * L) / FIL_AREA, (volRate / (hAvg * beadWidth)) * 60, h);
    px = x; py = y; ph = h;
  }
  return len;
}

/** STROKE: a line whose bead height rises and falls in waves, at constant
 * volumetric flow. Calls brushVariableThickness() wave after wave until
 * the path runs out (the last wave is cut short where the path ends), then
 * one retract. Knows nothing about waves: each brush call says
 * how far it got, and the options pass straight through. */
export function strokeVariableThickness(em, pts, { gapLen = 0, ...brush } = {}) {
  const total = totalLength(pts);
  let s = 0;
  while (total - s > 1e-6) {
    const used = brushVariableThickness(em, restOfPath(pts, s), { ...brush, gapLen });
    if (!(used > 0)) break;
    s += used + gapLen;
    // skip the gap: retract, so the next wave travels there and primes
    // instead of extruding across the gap
    if (gapLen > 0 && total - s > 1e-6) em.retract();
  }
  em.retract();
  return pts;
}

/**
 * ============================================================================
 * SECTION 4: PATTERNS -- stroke generators for filling a region
 * ============================================================================
 * A pattern turns a region (an axis-aligned rectangle {x0, y0, w, h} or a
 * polygon [[x,y], ...]) into a list of paths (point lists) that a stroke
 * from SECTION 3 then walks. Patterns never emit G-code
 * themselves. Diamond/checkerboard is NOT a generic "lines at a gap"
 * pattern -- which cells get filled solid is a discrete checkerboard
 * parity selection -- so it is its own generator, never emulated with two
 * angled hatches.
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

/** HATCH pattern: parallel strokes across `region` (rect or polygon) at
 * `angleDeg`, `gap` apart. Returns an array of 2-point strokes
 * [[x0,y0],[x1,y1]], each meant to be densified (polylineToPts) and
 * walked by one brush call with its own em.newPattern(). */
export function hatchStrokes(region, angleDeg = 0, gap = 4.0) {
  const segments = Array.isArray(region)
    ? polygonFillLines(region, angleDeg, gap)
    : regionFillLines(region, angleDeg, gap);
  return segments.filter(([p0, p1]) => Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) >= 1e-6);
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

/** DIAMOND pattern: lattice lines plus checkerboard-filled cells for a
 * rectangle region={x0,y0,w,h}. Indexes diamonds by their TRUE rotated-
 * square-grid coordinates (i,j) via center=(x0+half*(i+j), y0+half*(i-j)),
 * checkerboard parity=(i+j)%2. Returns {strokes, diamonds}: each stroke is
 * {points: [[x,y],[x,y]], brush: {nLayers, width, speed}} for the SOLID
 * brush (lattice at 400 mm/min, cell scanlines at 450), to be walked
 * WITHOUT densifying (`polylineToPts(points, null)`) under ONE
 * em.newPattern() for the whole fill. `diamonds` feeds
 * verifyCheckerboard(). DO NOT emulate this with two angled hatches. */
export function diamondStrokes(region, { diag = 8.0, fillGap = 0.6 } = {}) {
  const { x0, y0, w, h } = region;
  const strokes = [];
  const push = (seg, speed) => strokes.push({ points: seg, brush: { nLayers: 2, width: 0.4, speed } });
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
    if (seg) push(seg, 400);
  }
  for (const c of [...sumConsts].sort((a, b) => a - b)) {
    const seg = clipLineFamilyRegion(x0, y0, w, h, c, "sum");
    if (seg) push(seg, 400);
  }

  for (const [cx, cy, filled] of diamonds) {
    if (!filled) continue;
    for (let yy = cy - half + fillGap; yy < cy + half - 1e-6; yy += fillGap) {
      if (yy >= y0 && yy <= y0 + h) {
        const ww = half - Math.abs(yy - cy);
        if (ww > 0.05) {
          const xa = Math.max(x0, cx - ww);
          const xb = Math.min(x0 + w, cx + ww);
          if (xb > xa) push([[xa, yy], [xb, yy]], 450);
        }
      }
    }
  }
  return { strokes, diamonds };
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

/**
 * ============================================================================
 * SECTION 5: DOT BRUSHES -- one mark at one point
 * ============================================================================
 * brush*(em, cx, cy, options): one dot or hair at (cx, cy), called by the
 * dot strokes in SECTION 3 once per stop. Each does its own travel,
 * priming and retract, so a stroke only has to say where.
 */

/** BRUSH: one flat, spiral-filled dot of radius `dotRadius`, `nLayers`
 * high -- per layer: travel to the spiral's start at that layer's height,
 * prime, walk the spiral, retract. */
function brushSpiralDot(em, cx, cy, { dotRadius = 0.8, nLayers = 2, speed = 250 } = {}) {
  const dotPts = spiralDisc([cx, cy], dotRadius);
  for (let layer = 1; layer <= nLayers; layer++) {
    em.goto(dotPts[0][0], dotPts[0][1], LAYER_HEIGHT * layer);
    em.unretract();
    for (let i = 1; i < dotPts.length; i++) {
      const seg = dist(dotPts[i - 1], dotPts[i]);
      if (seg < 1e-9) continue;
      em.printMove(dotPts[i][0], dotPts[i][1], seg * eRate(0.42, LAYER_HEIGHT), speed);
    }
    em.retract();
  }
}

/**
 * BRUSH: one blob dome at (cx, cy), for strokeBlobDotted(). Builds a small dome by extruding WHILE rising in Z (no XY movement),
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
 * disable it. Then rise `blobClearanceMm` above the dome, recenter, dwell
 * `orbitDwellMs`, and trace the same circle `topOrbitLoops` times at that
 * hover height (0 skips this second orbit).
 */
function brushBlobDot(em, cx, cy, {
  diameter = 1.6, baseZ = 0.2, buildSteps = 6, taperFactor = 0.7,
  extrudeSpeed = 120, dwellMs = 2000, extrusionMultiplier = 1.3,
  retractMm = 4.0, postRetractDwellMs = 2000, baseExtraMm = 0.3,
  baseDwellMs = 1000, orbitRadius = null, orbitPts = 16, orbitSpeed = 600,
  orbitLoops = 3, orbitDwellMs = 2000, blobClearanceMm = 0.3,
  topOrbitLoops = 3,
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

  // SECOND orbit: rise blobClearanceMm above the dome top (so the move
  // back to center can't drag the fresh blob), recenter, dwell, then trace
  // the same circle topOrbitLoops times at that hover height. No lift --
  // the next dot's goto() raises to travel height before its XY move.
  // topOrbitLoops: 0 skips this whole step.
  const nTopLoops = Math.max(0, Math.round(topOrbitLoops));
  if (actualOrbitRadius > 0 && nTopLoops > 0) {
    const zHover = z + blobClearanceMm;
    em.a(`G1 Z${zHover.toFixed(3)} F${orbitSpeed}`);
    em.z = zHover;
    em.a(`G0 X${cx.toFixed(3)} Y${cy.toFixed(3)} F${orbitSpeed}`);
    em.x = cx; em.y = cy;
    em.dwell(orbitDwellMs);
    for (let loop = 0; loop < nTopLoops; loop++) {
      for (let i = 0; i <= nOrbit; i++) {
        const theta = (i / nOrbit) * 2 * Math.PI;
        const ox = cx + actualOrbitRadius * Math.cos(theta);
        const oy = cy + actualOrbitRadius * Math.sin(theta);
        em.a(`G0 X${ox.toFixed(3)} Y${oy.toFixed(3)} F${orbitSpeed}`);
        em.x = ox; em.y = oy;
      }
    }
  }
}

/**
 * BRUSH: one "directional" blob dot -- a brushBlobDot()-style dome that LEANS in a chosen
 * compass direction, for a raked/combed-looking tactile bump. Reuses
 * brushBlobDot()'s volume model, with two `azimuthDeg`-driven changes:
 *  1. SHEARED BUILD -- the nozzle travels `radius` in the azimuth
 *     direction as it rises through `buildSteps` to the dome top, while
 *     extruding, so the apex ends off-center in that direction.
 *  2. SQUISH-THEN-DRAG -- after build/dwell/retract/dwell, the nozzle
 *     (still at the leaning apex) drops straight down to bed level
 *     (squishing the leaning blob onto the bed), then drags laterally
 *     -azimuth by `diameter`, ending at the trailing edge of the base
 *     circle. This shapes the blob AND sweeps near any residual string.
 * `azimuthDeg` is CCW from +X (same convention as brushHairyDot()). For a line
 * of these, strokeDirectionalBlobDotted() sets it from the path tangent.
 */
function brushDirectionalBlobDot(em, cx, cy, {
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
function resolveHairDir(hairDirection = "top", azimuthDeg, elevationDeg) {
  let azDeg, elDeg;
  if (azimuthDeg != null || elevationDeg != null) {
    azDeg = azimuthDeg ?? 0;
    elDeg = elevationDeg ?? 90;
  } else {
    if (!(hairDirection in HAIR_PRESET)) {
      throw new Error(
        `hairy dot: hairDirection must be "top", "left", "right", or ` +
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
 * BRUSH: one dot with ONE hair strand pulled from its center, for
 * strokeHairyDotted(). Builds a real
 * root dome first (reusing brushBlobDot's own tapered-rise build mechanism
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
function brushHairyDot(em, cx, cy, {
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

  // root dome build -- identical formulas/loop to brushBlobDot's own build.
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

export function strokePetalDotted(em, pts, { gap = 6.0, azimuthDeg = 180, ...brush } = {}) {
  return walkArcLengthStops(pts, gap, 0.1, { withTangent: true }, (cx, cy, { headingDeg }) =>
    brushPetalDot(em, cx, cy, { ...brush, azimuthDeg: headingDeg + azimuthDeg }));
}

function brushPetalDot(em, cx, cy, {
  diameter = 3.0, height = 1.0, extrudeSpeed = 150,
  dragMm = 5.0, azimuthDeg = 270, dragSpeed = 600,
} = {}) {
  const r = diameter / 2;
  em.goto(cx, cy, height);
  em.unretract();
  em.printMove(cx, cy, (Math.PI * r * r * height * 0.75) / FIL_AREA, extrudeSpeed);
  em.retract();
  const a = (azimuthDeg * Math.PI) / 180;
  const ex = cx + Math.cos(a) * dragMm, ey = cy + Math.sin(a) * dragMm;
  em.a(`G0 X${ex.toFixed(3)} Y${ey.toFixed(3)} Z0.000 F${dragSpeed}`);
  em.x = ex; em.y = ey; em.z = 0;
}

/** Texture name -> its stroke, which the cards and the compiler call as
 * stroke(em, pts, options). Keys are the texture names the scene model,
 * the option table and the prompt docs use. */
export const BRUSHES = {
  solid: strokeSolid, dashed: strokeDashed, dotted: strokeDotted,
  blobDotted: strokeBlobDotted, directionalBlobDotted: strokeDirectionalBlobDotted,
  hairy: strokeHairy, hairyDotted: strokeHairyDotted, segmented: strokeSegmented,
  variableThickness: strokeVariableThickness,
  petalDot: strokePetalDotted,
};

export { brushPetalDot };
