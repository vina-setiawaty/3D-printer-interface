// Editing a brush program BY TIME: the timeline's playhead says when
// something new happens, whichever view it was drawn in, and the Z lane
// can be painted over moves already drawn (XY from TOP, height over time
// from the timeline -> one 3D movement).
//
// Everything works on TOP-LEVEL steps. A step can be split at a moment
// only when the numbers involved are plain numbers (a move's target, its
// `e`, a dwell's ms, a puddle's e/ms); a step driven by a param expression
// or a `repeat` is never split -- things land after it instead, and the
// caller is told.
//
// Pure ES module: the texture library is passed in as `lib`.

import { stepTimes } from "./views.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const clone = (x) => JSON.parse(JSON.stringify(x));
const EPS = 1e-6;

/** The expanded program with times, and each top-level step's time span. */
export function timing(lib, program, params) {
  const steps = lib.expandSketchProgram(program, params);
  const times = stepTimes(steps);
  const total = times.length ? times[times.length - 1].t1 : 0;
  let prevEnd = 0;
  const spans = program.steps.map((_, k) => {
    let first = -1, last = -1;
    steps.forEach((s, i) => { if (s.src[0] === k) { if (first < 0) first = i; last = i; } });
    if (first < 0) return { k, t0: prevEnd, t1: prevEnd, first, last };   // e.g. a repeat of 0
    const span = { k, t0: times[first].t0, t1: times[last].t1, first, last };
    prevEnd = span.t1;
    return span;
  });
  return { steps, times, total, spans };
}

/** Where the nozzle is at time t (local frame). */
export function positionAt(steps, times, t) {
  let pos = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], { t0, t1 } = times[i];
    if (s.op === "travel") { pos = s.to; continue; }
    if (s.op !== "move") continue;
    if (t >= t1 - EPS) { pos = s.to; continue; }
    if (t > t0) {
      const f = (t - t0) / Math.max(t1 - t0, EPS);
      return s.from.map((a, j) => a + (s.to[j] - a) * f);
    }
    return pos || s.from;
  }
  return pos || [0, 0, 0.2];
}

/** Position the nozzle is at just before top-level step `index` runs. */
export function positionBefore(T, index) {
  let pos = [0, 0, 0.2];
  for (const s of T.steps) {
    if (s.src[0] >= index) break;
    if (s.op === "travel" || s.op === "move") pos = s.to;
  }
  return pos;
}

/** Tries to cut top-level step k at fraction f of its duration. Returns
 * the two halves, or null when the step can't be split. `from` is the
 * expanded start position (for a move). */
function cut(step, f, from) {
  if (step.op === "move") {
    const vec = step.to || step.by;
    if (!vec || !vec.every(isNum)) return null;
    if (step.e !== undefined && step.e !== "" && !isNum(step.e)) return null;
    const to = step.to ? step.to : step.by.map((d, j) => from[j] + d);
    const mid = from.map((a, j) => r3(a + (to[j] - a) * f));
    const a = clone(step), b = clone(step);
    delete b.movement;                  // a movement starts once, at its first half
    if (step.to) { a.to = mid; b.to = to.slice(); }
    else { a.by = mid.map((m, j) => r3(m - from[j])); b.by = to.map((v, j) => r3(v - mid[j])); }
    if (isNum(step.e)) { a.e = r4(step.e * f); b.e = r4(step.e - a.e); }
    return [a, b];
  }
  if (step.op === "dwell" && isNum(step.ms)) {
    const ms = Math.round(step.ms * f);
    return [{ ...step, ms }, { ...step, ms: step.ms - ms }];
  }
  if (step.op === "extrudeHere" && isNum(step.ms) && isNum(step.e)) {
    const ms = Math.round(step.ms * f);
    const e = r4(step.e * f);
    return [{ ...step, e, ms }, { ...step, e: r4(step.e - e), ms: step.ms - ms }];
  }
  return null;
}

/** Makes time t a step boundary. Returns {program, index, atEnd, note}:
 * new steps spliced in at `index` run at time t. `onlyMoves` limits
 * splitting to moves (painting Z must never cut a dwell). */
export function splitAt(lib, program, params, t, { onlyMoves = false } = {}) {
  const p = clone(program);
  const T = timing(lib, p, params);
  if (t === null || t === undefined || t >= T.total - EPS) return { program: p, index: p.steps.length, atEnd: true, note: "" };
  if (t <= EPS) return { program: p, index: 1, atEnd: false, note: "" };
  for (const sp of T.spans) {
    if (sp.k === 0) continue;                       // the travel
    if (t <= sp.t0 + EPS) return { program: p, index: sp.k, atEnd: false, note: "" };
    if (t < sp.t1 - EPS) {
      const step = p.steps[sp.k];
      const halves = !onlyMoves || step.op === "move"
        ? cut(step, (t - sp.t0) / (sp.t1 - sp.t0), sp.first >= 0 ? T.steps[sp.first].from : null)
        : null;
      if (!halves) {
        return { program: p, index: sp.k + 1, atEnd: false, note: `step ${sp.k + 1} (${step.op}) can't be cut there (it uses a param or is a repeat) -- placed after it` };
      }
      p.steps.splice(sp.k, 1, ...halves);
      return { program: p, index: sp.k + 1, atEnd: false, note: "" };
    }
  }
  return { program: p, index: p.steps.length, atEnd: true, note: "" };
}

/**
 * Inserts `block` (steps) so it happens at time t (null = at the end).
 * A leading `travel` in the block (a drawn stroke's start) becomes a dry
 * move from where the nozzle is. With `returnHome` (a drawn stroke: an
 * excursion), when inserted mid-sequence and the block ends somewhere
 * else, a dry move back is added so everything after it still happens where
 * it did before. Without it (a waypoint), the sequence simply carries on
 * from the new point.
 * Returns {program, first, last, note, returned}.
 */
export function insertAt(lib, program, params, t, block, { feedBetween = 1200, returnFeed = 600, returnHome = true } = {}) {
  const s = splitAt(lib, program, params, t);
  const p = s.program;
  const T = timing(lib, p, params);
  const pos = positionBefore(T, s.index);
  const steps = clone(block);
  if (steps[0]?.op === "travel") {
    const to = steps[0].to;
    const far = to.some((v, j) => !isNum(v) || Math.abs(v - pos[j]) > 0.05);
    if (far) steps[0] = { op: "move", to, f: feedBetween };
    else steps.shift();
  }
  let end = pos;
  for (const st of steps) if (st.op === "move" && Array.isArray(st.to) && st.to.every(isNum)) end = st.to;
  let returned = false;
  if (returnHome && !s.atEnd && end.some((v, j) => Math.abs(v - pos[j]) > 0.05)) {
    steps.push({ op: "move", to: pos.map(r3), f: returnFeed });
    returned = true;
  }
  if (!steps.length) return { program: p, first: s.index, last: s.index - 1, note: s.note, returned };
  p.steps.splice(s.index, 0, ...steps);
  return { program: p, first: s.index, last: s.index + steps.length - 1, note: s.note, returned };
}

/** Simplifies painted (t, z) samples: keeps a point only where the height
 * deviates from the straight line between its neighbours by more than
 * `tolMm`. */
export function simplifyPaint(samples, tolMm = 0.05) {
  const pts = samples.slice().sort((a, b) => a.t - b.t);
  const rec = (a, b) => {
    if (b - a < 2) return [];
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const f = (pts[i].t - pts[a].t) / Math.max(pts[b].t - pts[a].t, EPS);
      const d = Math.abs(pts[i].z - (pts[a].z + (pts[b].z - pts[a].z) * f));
      if (d > worst) { worst = d; at = i; }
    }
    return worst > tolMm ? [...rec(a, at), pts[at], ...rec(at, b)] : [];
  };
  if (pts.length <= 2) return pts;
  return [pts[0], ...rec(0, pts.length - 1), pts[pts.length - 1]];
}

function zAtTime(curve, t) {
  if (t <= curve[0].t) return curve[0].z;
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i].t) {
      const a = curve[i - 1], b = curve[i];
      return a.z + ((b.z - a.z) * (t - a.t)) / Math.max(b.t - a.t, EPS);
    }
  }
  return curve[curve.length - 1].z;
}

// ---------------------------------------------------------------- channels --
//
// XY and Z are separate CHANNELS of one movement. Reshaping one (a TOP
// stroke -> XY, a SIDE stroke or the timeline's Z lane -> Z) never
// prolongs the path: the steps keep their timing and their extrusion, and
// only that channel's coordinates change.

const len3 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** Duration and filament of every top-level move, so they can be put back
 * after its coordinates change. */
function snapshotMoves(T, program) {
  const snap = new Map();
  for (const sp of T.spans) {
    if (program.steps[sp.k].op !== "move" || sp.first < 0) continue;
    const ex = T.steps[sp.first];
    snap.set(sp.k, { dur: sp.t1 - sp.t0, e: ex.e, len: len3(ex.from, ex.to) });
  }
  return snap;
}

/** For every move whose length changed: the feed that keeps its duration,
 * and its original filament as a fixed `e` (a `bead` would rescale with
 * the new length). Feeds or amounts written as expressions are left alone.
 * Returns the step numbers whose timing could not be kept. */
function keepTimingAndFlow(lib, program, params, snap) {
  const T = timing(lib, program, params);
  const drift = [];
  for (const [k, s] of snap) {
    const st = program.steps[k], sp = T.spans[k];
    if (!st || st.op !== "move" || sp.first < 0) continue;
    const ex = T.steps[sp.first];
    const L = len3(ex.from, ex.to);
    if (Math.abs(L - s.len) < 1e-6) continue;
    if (s.dur > EPS && L > 1e-6) {
      if (isNum(st.f)) st.f = Math.max(1, Math.round((L / s.dur) * 60 * 10) / 10);
      else drift.push(`step ${k + 1}`);
    }
    if (s.e > 0 && (st.bead || isNum(st.e))) { delete st.bead; st.e = r4(s.e); }
  }
  return drift;
}

/**
 * Paints nozzle height over time onto what is already drawn: moves inside
 * the painted time range are cut at the painted curve's corners, then each
 * move's end height is set to the painted height at that moment. Timing
 * and extrusion are kept (the Z channel only). Dwells and other stationary
 * steps are left alone. Moves whose target uses a param, and `by` moves,
 * are skipped and reported.
 * Returns {program, changed, skipped}.
 */
export function paintZ(lib, program, params, samples, { minZ = 0.05 } = {}) {
  const curve = simplifyPaint(samples);
  if (curve.length < 2) return { program: clone(program), changed: 0, skipped: [] };
  const ta = curve[0].t, tb = curve[curve.length - 1].t;
  let p = clone(program);
  for (const c of curve) {
    if (c.t <= ta + EPS || c.t >= tb - EPS) continue;
    p = splitAt(lib, p, params, c.t, { onlyMoves: true }).program;
  }
  // also cut where the painted range starts/ends inside a move, so moves
  // outside the range keep their heights
  p = splitAt(lib, p, params, ta, { onlyMoves: true }).program;
  p = splitAt(lib, p, params, tb, { onlyMoves: true }).program;

  const T = timing(lib, p, params);
  const snap = snapshotMoves(T, p);
  let changed = 0;
  const skipped = [];
  for (const sp of T.spans) {
    const st = p.steps[sp.k];
    if (st.op === "travel" && ta <= EPS) {
      if (isNum(st.to[2])) { st.to[2] = Math.max(minZ, Math.round(zAtTime(curve, 0) * 100) / 100); changed++; }
      continue;
    }
    if (st.op !== "move" || sp.t1 < ta - EPS || sp.t1 > tb + EPS) continue;
    if (!st.to || !isNum(st.to[2])) { skipped.push(`step ${sp.k + 1}`); continue; }
    st.to[2] = Math.max(minZ, Math.round(zAtTime(curve, sp.t1) * 100) / 100);
    changed++;
  }
  skipped.push(...keepTimingAndFlow(lib, p, params, snap).map((s) => `${s} (its feed is a param, so its timing changed)`));
  return { program: p, changed, skipped };
}

/** The MOVEMENT a stroke reshapes: a run of consecutive top-level moves,
 * broken by any non-move step and by a move carrying a `movement` label
 * (where something was added as a new movement).
 * The one the playhead is inside; otherwise the one that just ended before
 * it (so "draw TOP, then draw SIDE" reshapes what was just drawn);
 * otherwise the next one. Returns {first, last, t0, t1, ta, tb} -- ta..tb
 * is the part that gets reshaped (from the playhead on, when inside) --
 * or null when there is no movement at all. */
export function movementAt(program, T, t) {
  const runs = [];
  let cur = null;
  program.steps.forEach((st, k) => {
    if (k > 0 && st.op === "move" && cur && st.movement) { runs.push(cur); cur = { first: k, last: k }; }
    else if (k > 0 && st.op === "move") { if (cur) cur.last = k; else cur = { first: k, last: k }; }
    else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  for (const r of runs) { r.t0 = T.spans[r.first].t0; r.t1 = T.spans[r.last].t1; }
  const withSpan = (r, from) => (r ? { ...r, ta: from ?? r.t0, tb: r.t1 } : null);
  if (!runs.length) return null;
  if (t === null || t === undefined) return withSpan(runs[runs.length - 1]);
  const inside = runs.find((r) => t > r.t0 + EPS && t < r.t1 - EPS);
  if (inside) return withSpan(inside, t);
  const before = [...runs].reverse().find((r) => r.t1 <= t + EPS);
  return withSpan(before || runs.find((r) => r.t0 >= t - EPS));
}

/** (t, u) along the expanded path between ta and tb, u = position along
 * the side view's horizontal axis. */
function pathU(T, ta, tb, dir) {
  const out = [];
  const u = (p) => p[0] * dir[0] + p[1] * dir[1];
  const pos0 = positionAt(T.steps, T.times, ta);
  out.push({ t: ta, u: u(pos0) });
  T.steps.forEach((s, i) => {
    const t1 = T.times[i].t1;
    if (s.op === "move" && t1 > ta + EPS && t1 < tb - EPS) out.push({ t: t1, u: u(s.to) });
  });
  out.push({ t: tb, u: u(positionAt(T.steps, T.times, tb)) });
  return out;
}

/**
 * A SIDE stroke -> the Z channel of the movement at the playhead.
 * BY POSITION: where the stroke passes over horizontal position u, the
 * path at that u takes the stroke's height -- the height profile as seen
 * from the side. When the path doubles back in that view (u not monotonic)
 * or barely moves along it (a vertical pull), position is ambiguous, so it
 * falls back to BY TIME: the stroke, in the order drawn, stretched over the
 * movement from the playhead.
 * `stroke`: [{t (ms), u, z}] in drawing order. `dir`: the view's
 * horizontal axis [cos az, sin az].
 * Returns {program, mode, changed, skipped, movement} or null (nothing to reshape).
 */
export function overlayZ(lib, program, params, t, stroke, dir) {
  const T = timing(lib, program, params);
  const mv = movementAt(program, T, t);
  if (!mv || stroke.length < 2) return null;
  const path = pathU(T, mv.ta, mv.tb, dir);
  const us = path.map((p) => p.u);
  const span = Math.max(...us) - Math.min(...us);
  let sign = 0, monotonic = true;
  for (let i = 1; i < path.length; i++) {
    const d = path[i].u - path[i - 1].u;
    if (Math.abs(d) < 1e-6) continue;
    const s = Math.sign(d);
    if (sign && s !== sign) { monotonic = false; break; }
    sign = s;
  }
  let samples, mode;
  if (monotonic && span >= 0.3) {
    mode = "position";
    const lo = Math.min(...us), hi = Math.max(...us);
    // the stroke as a height profile z(u), sorted along u
    const prof = stroke.map((p) => ({ t: p.u, z: p.z })).sort((a, b) => a.t - b.t);
    const zAtU = (u) => zAtTime(prof, u);
    const uLo = Math.max(lo, prof[0].t), uHi = Math.min(hi, prof[prof.length - 1].t);
    if (!(uHi > uLo)) return { program: clone(program), mode, changed: 0, skipped: [], movement: mv, note: "the SIDE stroke doesn't pass over the movement -- draw across it" };
    // u -> t on the (monotonic) path
    const tAtU = (u) => {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        if ((u - a.u) * (u - b.u) <= 0 && Math.abs(b.u - a.u) > 1e-9) return a.t + ((u - a.u) / (b.u - a.u)) * (b.t - a.t);
      }
      return null;
    };
    const knots = simplifyPaint(prof.filter((p) => p.t >= uLo && p.t <= uHi)).map((p) => p.t);
    const uKnots = [...new Set([uLo, ...knots, uHi].map((u) => Math.round(u * 1e4) / 1e4))];
    samples = uKnots.map((u) => ({ t: tAtU(u), z: zAtU(u) })).filter((s) => s.t !== null).sort((a, b) => a.t - b.t);
  } else {
    mode = "time";
    const d0 = stroke[0].t, d1 = stroke[stroke.length - 1].t;
    samples = stroke.map((p, i) => ({
      t: mv.ta + (d1 > d0 ? (p.t - d0) / (d1 - d0) : i / (stroke.length - 1)) * (mv.tb - mv.ta),
      z: p.z,
    }));
  }
  const r = paintZ(lib, program, params, samples);
  return { ...r, mode, movement: mv };
}

/**
 * A TOP stroke -> the XY channel of the movement at the playhead,
 * STRETCHED over it: from the playhead to the movement's end, the path's
 * sideways motion becomes the stroke's shape (relative to where the stroke
 * started), in the order and pace it was drawn. Height, timing and
 * extrusion stay. A straight vertical pull becomes a curved, leaning one.
 * `stroke`: [{t (ms), x, y}] in drawing order.
 * Returns {program, changed, skipped, movement} or null (nothing to reshape).
 */
export function overlayXY(lib, program, params, t, stroke, { tolMm = 0.12 } = {}) {
  const T0 = timing(lib, program, params);
  const mv = movementAt(program, T0, t);
  if (!mv || stroke.length < 2) return null;
  const d0 = stroke[0].t, d1 = stroke[stroke.length - 1].t;
  const sOf = (p, i) => (d1 > d0 ? (p.t - d0) / (d1 - d0) : i / (stroke.length - 1));
  const pts = stroke.map((p, i) => ({ s: sOf(p, i), x: p.x - stroke[0].x, y: p.y - stroke[0].y }));
  const xyAt = (s) => {
    if (s <= 0) return [pts[0].x, pts[0].y];
    for (let i = 1; i < pts.length; i++) {
      if (s <= pts[i].s) {
        const a = pts[i - 1], b = pts[i], f = (s - a.s) / Math.max(b.s - a.s, EPS);
        return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
      }
    }
    return [pts[pts.length - 1].x, pts[pts.length - 1].y];
  };
  // corners of the stroke (RDP in xy) become cut points in time
  const rdp = (a, b) => {
    if (b - a < 2) return [];
    let worst = -1, at = -1;
    const A = pts[a], B = pts[b], L = Math.hypot(B.x - A.x, B.y - A.y);
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const d = L < 1e-9 ? Math.hypot(P.x - A.x, P.y - A.y) : Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / L;
      if (d > worst) { worst = d; at = i; }
    }
    return worst > tolMm ? [...rdp(a, at), at, ...rdp(at, b)] : [];
  };
  const corners = rdp(0, pts.length - 1).map((i) => pts[i].s);
  const tOf = (s) => mv.ta + s * (mv.tb - mv.ta);

  let p = clone(program);
  p = splitAt(lib, p, params, mv.ta, { onlyMoves: true }).program;
  for (const s of corners) p = splitAt(lib, p, params, tOf(s), { onlyMoves: true }).program;

  const T = timing(lib, p, params);
  const snap = snapshotMoves(T, p);
  const base = positionAt(T.steps, T.times, mv.ta);
  let changed = 0;
  const skipped = [];
  for (const sp of T.spans) {
    const st = p.steps[sp.k];
    if (st.op !== "move" || sp.t1 <= mv.ta + EPS || sp.t1 > mv.tb + EPS) continue;
    if (!st.to || !isNum(st.to[0]) || !isNum(st.to[1])) { skipped.push(`step ${sp.k + 1}`); continue; }
    const [dx, dy] = xyAt((sp.t1 - mv.ta) / Math.max(mv.tb - mv.ta, EPS));
    st.to[0] = r3(base[0] + dx);
    st.to[1] = r3(base[1] + dy);
    changed++;
  }
  skipped.push(...keepTimingAndFlow(lib, p, params, snap).map((s) => `${s} (its feed is a param, so its timing changed)`));
  return { program: p, changed, skipped, movement: mv };
}
