// Freehand capture -> a LITERAL brush program: what was drawn, as steps,
// with no printing knowledge added. The interpret stage (LLM) starts from
// this and must justify every change it makes to it, so the author can see
// exactly where their drawing ended and the model's judgement began.
//
// Input: strokes as captured by the page, already in the local 3D frame
//   { dry: bool, samples: [{t, x, y, z, flow}], events: [{t, type: "retract"|"prime"}] }
//   t in ms since the sketch started, x/y/z in mm, flow 0..5 (0 = none).
// Pure ES module.

// Flow level -> bead cross-section (moving) and filament feed (holding
// still). Level 3 is roughly the library's everyday bead.
export const FLOW_LEVELS = {
  1: { w: 0.4, h: 0.2, stillMmPerS: 0.10 },
  2: { w: 0.6, h: 0.25, stillMmPerS: 0.20 },
  3: { w: 0.8, h: 0.3, stillMmPerS: 0.30 },
  4: { w: 1.2, h: 0.35, stillMmPerS: 0.45 },
  5: { w: 1.6, h: 0.4, stillMmPerS: 0.60 },
};

export const DRAFT_DEFAULTS = {
  simplifyMm: 0.12,        // RDP tolerance
  stillMm: 0.15,           // "holding still": moved less than this ...
  stillMs: 150,            // ... for at least this long
  timeScale: 1.0,          // drawn ms -> printed ms for dwells and puddles
  retractMm: 1.3,          // RETRACT_MM, the library's default
  useDrawSpeed: false,     // map drawing speed to feed (off: fixed feeds)
  feedExtrude: 300, feedDry: 600, feedBetween: 1200,
};

const r2 = (v) => Math.round(v * 100) / 100;
const d3 = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** Ramer-Douglas-Peucker on 3D points; keeps first and last. */
export function simplify3(points, eps) {
  if (points.length <= 2) return points.slice();
  const a = points[0], b = points[points.length - 1];
  const ab = [b.x - a.x, b.y - a.y, b.z - a.z];
  const L = Math.hypot(...ab);
  let worst = -1, idx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const ap = [p.x - a.x, p.y - a.y, p.z - a.z];
    let d;
    if (L < 1e-9) d = Math.hypot(...ap);
    else {
      const cx = ap[1] * ab[2] - ap[2] * ab[1], cy = ap[2] * ab[0] - ap[0] * ab[2], cz = ap[0] * ab[1] - ap[1] * ab[0];
      d = Math.hypot(cx, cy, cz) / L;
    }
    if (d > worst) { worst = d; idx = i; }
  }
  if (worst <= eps) return [a, b];
  return [...simplify3(points.slice(0, idx + 1), eps).slice(0, -1), ...simplify3(points.slice(idx), eps)];
}

/** Splits one stroke's samples into alternating spans:
 *   {kind: "still", from, to, ms, flow}  held (almost) in place
 *   {kind: "move",  pts, flow}           moving at one flow level */
export function segmentStroke(samples, { stillMm, stillMs }) {
  const n = samples.length;
  const spans = [];
  // Last index j such that samples i..j all stay within stillMm of sample
  // i at the same flow level.
  const stillEnd = (i) => {
    let j = i;
    while (j + 1 < n && d3(samples[i], samples[j + 1]) < stillMm && samples[j + 1].flow === samples[i].flow) j++;
    return j;
  };
  let run = [];
  const flush = () => {
    if (run.length >= 2) spans.push({ kind: "move", pts: run, flow: run[0].flow });
    run = [];
  };
  let i = 0;
  while (i < n) {
    const s = samples[i];
    const j = stillEnd(i);
    if (j > i && samples[j].t - s.t >= stillMs) {
      run.push(s);
      flush();
      spans.push({ kind: "still", at: s, ms: samples[j].t - s.t, flow: s.flow });
      run = [samples[j]];
      i = j + 1;
      continue;
    }
    if (run.length && s.flow !== run[0].flow) {
      // the segment up to the change keeps the old flow
      run.push({ ...s, flow: run[0].flow });
      flush();
    }
    run.push(s);
    i++;
  }
  flush();
  return spans;
}

function feedFor(speedMmS, extruding, o) {
  if (!o.useDrawSpeed || !Number.isFinite(speedMmS)) return extruding ? o.feedExtrude : o.feedDry;
  const band = speedMmS < 5 ? 0 : speedMmS > 20 ? 2 : 1;
  return extruding ? [120, 300, 800][band] : [400, 800, 1500][band];
}

/** strokes -> { program, trace } where trace[k] = {stroke, kind} says
 * which stroke/span produced step k (for the literal overlay). */
export function literalDraft(strokes, options = {}) {
  const o = { ...DRAFT_DEFAULTS, ...options };
  const steps = [];
  const trace = [];
  let pos = null;
  let reach = 0;
  const push = (step, t) => { steps.push(step); trace.push(t); };
  const grow = (p) => { reach = Math.max(reach, Math.abs(p.x), Math.abs(p.y)); };

  const usable = strokes.filter((s) => s.samples && s.samples.length);
  usable.forEach((stroke, si) => {
    const first = stroke.samples[0];
    grow(first);
    if (!pos) push({ op: "travel", to: [r2(first.x), r2(first.y), r2(Math.max(first.z, 0.1))] }, { stroke: si, kind: "travel" });
    else if (d3(pos, first) > 0.05) push({ op: "move", to: [r2(first.x), r2(first.y), r2(first.z)], f: o.feedBetween }, { stroke: si, kind: "between" });
    pos = first;

    // events are placed after the span they fall in (or before the first)
    const events = (stroke.events || []).slice().sort((a, b) => a.t - b.t);
    let ev = 0;
    const flushEvents = (uptoT) => {
      while (ev < events.length && events[ev].t <= uptoT) {
        const e = events[ev++];
        push({ op: e.type, mm: o.retractMm }, { stroke: si, kind: e.type });
      }
    };

    for (const span of segmentStroke(stroke.samples, o)) {
      if (span.kind === "still") {
        flushEvents(span.at.t);
        const ms = Math.round(span.ms * o.timeScale);
        const flow = stroke.dry ? 0 : span.flow;
        if (flow > 0) push({ op: "extrudeHere", e: r2(FLOW_LEVELS[flow].stillMmPerS * ms / 1000), ms }, { stroke: si, kind: "puddle" });
        else push({ op: "dwell", ms }, { stroke: si, kind: "dwell" });
        continue;
      }
      const flow = stroke.dry ? 0 : span.flow;
      const simple = simplify3(span.pts, o.simplifyMm);
      for (let k = 1; k < simple.length; k++) {
        const a = simple[k - 1], b = simple[k];
        flushEvents(a.t);
        const dt = Math.max(1, b.t - a.t) / 1000;
        const f = feedFor(d3(a, b) / dt, flow > 0, o);
        const step = { op: "move", to: [r2(b.x), r2(b.y), r2(Math.max(b.z, 0.1))], f };
        if (flow > 0) step.bead = { w: FLOW_LEVELS[flow].w, h: FLOW_LEVELS[flow].h };
        push(step, { stroke: si, kind: flow > 0 ? "extrude" : "dry" });
        grow(b);
        pos = b;
      }
    }
    flushEvents(Infinity);
    pos = stroke.samples[stroke.samples.length - 1];
  });

  const radius = Math.max(2, Math.ceil(reach + 1));
  return {
    program: {
      name: "sketchedBrush",
      version: 1,
      orientation: "fixed",
      radiusMm: radius,
      defaultGap: Math.max(4, 2 * radius),
      params: {},
      steps,
    },
    trace,
  };
}

/** A compact numeric summary of the raw strokes for the model -- each
 * stroke resampled to at most `maxPts` points, times in ms from its start. */
export function strokeSummary(strokes, maxPts = 80) {
  return strokes.filter((s) => s.samples?.length).map((s, i) => {
    const step = Math.max(1, Math.ceil(s.samples.length / maxPts));
    const t0 = s.samples[0].t;
    const pts = s.samples.filter((_, k) => k % step === 0 || k === s.samples.length - 1)
      .map((p) => [Math.round(p.t - t0), r2(p.x), r2(p.y), r2(p.z), p.flow]);
    return {
      stroke: i + 1, view: s.view, dry: !!s.dry, durationMs: Math.round(s.samples[s.samples.length - 1].t - t0),
      events: (s.events || []).map((e) => [Math.round(e.t - t0), e.type]),
      points_t_x_y_z_flow: pts,
    };
  });
}
