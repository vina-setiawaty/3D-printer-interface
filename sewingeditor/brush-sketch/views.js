// Canvas views of one stamp: TOP (xy), SIDE (a vertical plane at a chosen
// azimuth) and TIMELINE (time -> Z, flow, events). Each draws the EXPANDED
// program -- what the interpreter will actually emit -- so the picture is
// never a guess about the G-code.
//
// Legend (all views):
//   solid blue, width ~ bead      extruding move
//   dashed grey                   dry move
//   hollow ring, size ~ time      dwell
//   filled orange disc            extrusion while standing still
//   red triangle down / green up  retract / prime
//   black square                  the travel (start point)

export const COLORS = {
  grid: "#EEE", axis: "#CCC", radius: "#E3D9C6", extrude: "#1f5fbf", dry: "#999",
  dwell: "#7a4fb3", puddle: "#e07b00", retract: "#c0392b", prime: "#2a8a4a",
  select: "#ff2d95", literal: "rgba(120,120,120,0.35)", raw: "rgba(31,95,191,0.25)", text: "#666",
};

const len3 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** Seconds each expanded step takes (travel counts as 0). */
export function stepTimes(steps, retractSpeed = 900) {
  let t = 0;
  return steps.map((s) => {
    let d = 0;
    if (s.op === "move") d = (len3(s.from, s.to) / s.f) * 60;
    else if (s.op === "dwell" || s.op === "extrudeHere") d = s.ms / 1000;
    else if (s.op === "retract" || s.op === "prime") d = (s.mm / (s.f ?? retractSpeed)) * 60;
    const out = { t0: t, t1: t + d };
    t += d;
    return out;
  });
}

/** Where each expanded step "happens" in local 3D. */
function stepPos(s, prev) {
  if (s.op === "travel" || s.op === "move") return s.to;
  if (s.op === "extrudeHere") return s.at;
  return prev;
}

// ------------------------------------------------------------ projections --

export function topProjection(W, H, R) {
  const s = Math.min(W, H) / (2 * R);
  return {
    s,
    to: (p) => [W / 2 + p[0] * s, H / 2 - p[1] * s],
    from: (px, py) => [(px - W / 2) / s, (H / 2 - py) / s],
  };
}

/** Side view: the vertical plane through the origin whose horizontal axis
 * points along azimuth `az` (degrees CCW from +x). z = 0 (the bed) sits
 * 18px above the bottom edge. */
export function sideProjection(W, H, R, az) {
  const s = W / (2 * R);
  const a = (az * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  const base = H - 18;
  return {
    s, dir: [c, sn],
    u: (p) => p[0] * c + p[1] * sn,
    to: (p) => [W / 2 + (p[0] * c + p[1] * sn) * s, base - p[2] * s],
    fromUZ: (px, py) => [(px - W / 2) / s, (base - py) / s],
  };
}

// ---------------------------------------------------------------- drawing --

// W/H are CSS pixels; the page sizes the backing store by devicePixelRatio
// and records it on the context as `ctx.dpr`.
function clear(ctx, W, H) {
  const d = ctx.dpr || 1;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#FFF";
  ctx.fillRect(0, 0, W, H);
}

function gridTop(ctx, W, H, P, R, radiusMm) {
  const step = R > 12 ? 5 : 1;
  ctx.lineWidth = 1;
  for (let v = -Math.ceil(R); v <= Math.ceil(R); v += step) {
    ctx.strokeStyle = v === 0 ? COLORS.axis : COLORS.grid;
    const [x] = P.to([v, 0]); const [, y] = P.to([0, v]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  if (radiusMm) {
    ctx.strokeStyle = COLORS.radius; ctx.setLineDash([4, 4]);
    const [cx, cy] = P.to([0, 0]);
    ctx.beginPath(); ctx.arc(cx, cy, radiusMm * P.s, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]);
  }
  // nozzle footprint reference at the origin
  ctx.strokeStyle = COLORS.axis;
  const [ox, oy] = P.to([0, 0]);
  ctx.beginPath(); ctx.arc(ox, oy, 0.2 * P.s, 0, 2 * Math.PI); ctx.stroke();
}

function gridSide(ctx, W, H, P, R) {
  const step = R > 12 ? 5 : 1;
  ctx.lineWidth = 1;
  for (let v = -Math.ceil(R); v <= Math.ceil(R); v += step) {
    ctx.strokeStyle = v === 0 ? COLORS.axis : COLORS.grid;
    const x = W / 2 + v * P.s;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let z = 0; z <= 2 * R; z += step) {
    const y = H - 18 - z * P.s;
    ctx.strokeStyle = z === 0 ? "#999" : COLORS.grid;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.fillStyle = COLORS.text; ctx.font = "10px monospace";
  ctx.fillText("bed", 4, H - 6);
}

function tri(ctx, x, y, up, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (up) { ctx.moveTo(x, y - size); ctx.lineTo(x - size, y + size * 0.6); ctx.lineTo(x + size, y + size * 0.6); }
  else { ctx.moveTo(x, y + size); ctx.lineTo(x - size, y - size * 0.6); ctx.lineTo(x + size, y - size * 0.6); }
  ctx.closePath(); ctx.fill();
}

/** Draws the expanded steps through projection `to` (3D -> px).
 * opts: {scale (px/mm), color override, selectedTop, filArea} */
function drawSteps(ctx, steps, to, opts = {}) {
  let prev = null;
  const faded = !!opts.color;
  steps.forEach((s) => {
    const sel = opts.selectedTop !== undefined && opts.selectedTop !== null && s.src[0] === opts.selectedTop;
    const here = stepPos(s, prev);
    if (s.op === "travel") {
      const [x, y] = to(s.to);
      ctx.fillStyle = opts.color || "#000";
      ctx.fillRect(x - 3, y - 3, 6, 6);
    } else if (s.op === "move") {
      const [x0, y0] = to(s.from), [x1, y1] = to(s.to);
      if (s.e > 0) {
        // bead width from volume: area = e * filArea / length
        const L = len3(s.from, s.to);
        const w = L > 1e-6 ? Math.sqrt((s.e * opts.filArea) / L) * 1.3 : 0.4;
        ctx.strokeStyle = opts.color || COLORS.extrude;
        ctx.lineWidth = Math.max(1.5, w * opts.scale);
        ctx.setLineDash([]);
        ctx.lineCap = "round";
      } else {
        ctx.strokeStyle = opts.color || COLORS.dry;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
      }
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.setLineDash([]);
      if (sel) {
        ctx.strokeStyle = COLORS.select; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    } else if (here && !faded) {
      const [x, y] = to(here);
      if (s.op === "dwell") {
        ctx.strokeStyle = COLORS.dwell; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 4 + Math.sqrt(s.ms) / 6, 0, 2 * Math.PI); ctx.stroke();
      } else if (s.op === "extrudeHere") {
        ctx.fillStyle = COLORS.puddle; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.arc(x, y, Math.max(3, Math.cbrt(s.e * opts.filArea) * opts.scale), 0, 2 * Math.PI); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (s.op === "retract") tri(ctx, x + 7, y, false, 4, COLORS.retract);
      else if (s.op === "prime") tri(ctx, x - 7, y, true, 4, COLORS.prime);
    }
    if (sel && here) {
      const [x, y] = to(here);
      ctx.strokeStyle = COLORS.select; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke();
    }
    prev = here;
  });
}

function drawNodes(ctx, nodes, to, selectedTop) {
  for (const n of nodes) {
    const [x, y] = to(n.pos);
    ctx.fillStyle = n.index === selectedTop ? COLORS.select : "#FFF";
    ctx.strokeStyle = n.locked ? "#999" : "#333";
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    if (n.locked) { ctx.fillStyle = "#999"; ctx.font = "9px monospace"; ctx.fillText("ƒ", x + 5, y - 5); }
  }
}

function drawRaw(ctx, strokes, to3) {
  ctx.strokeStyle = COLORS.raw; ctx.lineWidth = 1;
  for (const st of strokes) {
    if (!st.samples?.length) continue;
    ctx.setLineDash(st.dry ? [2, 3] : []);
    ctx.beginPath();
    st.samples.forEach((p, i) => { const [x, y] = to3([p.x, p.y, p.z]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** view: {ctx, W, H, R, radiusMm, az?}; data: {steps, literal, nodes,
 * selectedTop, raw, filArea, pen} */
export function renderTop(view, data) {
  const { ctx, W, H, R } = view;
  clear(ctx, W, H);
  const P = topProjection(W, H, R);
  gridTop(ctx, W, H, P, R, view.radiusMm);
  const to = (p) => P.to(p);
  if (data.raw) drawRaw(ctx, data.raw, to);
  if (data.literal) drawSteps(ctx, data.literal, to, { scale: P.s, color: COLORS.literal, filArea: data.filArea });
  if (data.steps) drawSteps(ctx, data.steps, to, { scale: P.s, selectedTop: data.selectedTop, filArea: data.filArea });
  if (data.nodes) drawNodes(ctx, data.nodes, to, data.selectedTop);
  if (view.az !== undefined) {
    // the side view's plane, through the pen
    const a = (view.az * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const p0 = data.pen || [0, 0];
    const perp = p0[0] * -s + p0[1] * c;
    const base = [-s * perp, c * perp];
    const [x0, y0] = P.to([base[0] - c * 2 * R, base[1] - s * 2 * R]);
    const [x1, y1] = P.to([base[0] + c * 2 * R, base[1] + s * 2 * R]);
    ctx.strokeStyle = "rgba(122,79,179,0.25)"; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]);
  }
  if (data.pen) {
    const [x, y] = P.to(data.pen);
    ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
  }
  if (data.marker) drawMarker(ctx, P.to(data.marker));
  return P;
}

export function renderSide(view, data) {
  const { ctx, W, H, R, az } = view;
  clear(ctx, W, H);
  const P = sideProjection(W, H, R, az);
  gridSide(ctx, W, H, P, R);
  const to = (p) => P.to(p);
  if (data.raw) drawRaw(ctx, data.raw, to);
  if (data.literal) drawSteps(ctx, data.literal, to, { scale: P.s, color: COLORS.literal, filArea: data.filArea });
  if (data.steps) drawSteps(ctx, data.steps, to, { scale: P.s, selectedTop: data.selectedTop, filArea: data.filArea });
  if (data.nodes) drawNodes(ctx, data.nodes, to, data.selectedTop);
  if (data.pen) {
    const [x, y] = P.to([data.pen[0], data.pen[1], data.pen[2] ?? 0.2]);
    ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
  }
  if (data.marker) drawMarker(ctx, P.to(data.marker));
  ctx.fillStyle = COLORS.text; ctx.font = "10px monospace";
  ctx.fillText(`plane az ${Math.round(az)}°`, W - 90, 12);
  return P;
}

/** The nozzle at the playhead: where the next thing will start. */
function drawMarker(ctx, [x, y]) {
  ctx.strokeStyle = COLORS.select; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x - 7, y); ctx.moveTo(x + 7, y); ctx.lineTo(x + 10, y);
  ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 7); ctx.moveTo(x, y + 7); ctx.lineTo(x, y + 10); ctx.stroke();
}

// ---------------------------------------------------------------- timeline --

// Lane layout (CSS px). The ruler is where the playhead is grabbed.
export const TL_LAYOUT = { L: 46, R: 8, ruler: [0, 16], z: [18, 66], flow: [70, 100], events: [104, 124] };

const NICE = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120];

/**
 * Timeline: x = print time. Lanes: Z (paintable), flow (mm³/s), events.
 * data: {steps, filArea, maxFlow, selectedTop, playhead (s | null = end),
 *        win {t0, t1} | null (= whole stamp), paint [{t, z}] | null,
 *        target {t0, t1} | null (the movement a stroke would reshape),
 *        zTop (frozen scale while painting) | null}
 * Returns the geometry the page needs for interaction:
 *   {total, win, zTop, xAt(t), timeAt(px), laneAt(py), zAt(py), pick(px)}
 */
export function renderTimeline(view, data) {
  const { ctx, W, H } = view;
  const { L, R: Rm } = TL_LAYOUT;
  clear(ctx, W, H);
  const steps = data.steps || [];
  const times = stepTimes(steps);
  const total = Math.max(0.2, times.length ? times[times.length - 1].t1 : 0);
  const win = data.win && data.win.t1 > data.win.t0 ? data.win : { t0: 0, t1: total };
  const span = win.t1 - win.t0;
  const xAt = (t) => L + ((t - win.t0) / span) * (W - L - Rm);
  const timeAt = (px) => win.t0 + ((px - L) / (W - L - Rm)) * span;

  let zMax = 0.5;
  steps.forEach((s) => { if (s.op === "move" || s.op === "travel") zMax = Math.max(zMax, s.to[2]); });
  const zTop = data.zTop || Math.max(1.5, zMax * 1.25);
  const zl = TL_LAYOUT.z;
  const zy = (z) => zl[1] - (z / zTop) * (zl[1] - zl[0]);
  const zAt = (py) => Math.max(0, ((zl[1] - py) / (zl[1] - zl[0])) * zTop);

  // labels + lane frames
  ctx.fillStyle = COLORS.text; ctx.font = "10px monospace";
  ctx.fillText("time", 4, 12); ctx.fillText("Z", 4, 30); ctx.fillText(`${zTop.toFixed(1)}`, 4, 42); ctx.fillText("flow", 4, 88); ctx.fillText("events", 2, 118);
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
  for (const k of ["z", "flow", "events"]) { const [a, b] = TL_LAYOUT[k]; ctx.strokeRect(L, a, W - L - Rm, b - a); }
  ctx.fillStyle = "#F7F7F7"; ctx.fillRect(L, TL_LAYOUT.ruler[0], W - L - Rm, TL_LAYOUT.ruler[1] - TL_LAYOUT.ruler[0]);

  // ruler ticks
  const tick = NICE.find((s) => span / s <= 10) || 120;
  ctx.fillStyle = COLORS.text; ctx.strokeStyle = "#CCC";
  for (let t = Math.ceil(win.t0 / tick) * tick; t <= win.t1 + 1e-9; t += tick) {
    const x = xAt(t);
    ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, 16); ctx.stroke();
    ctx.strokeStyle = "#F2F2F2";
    ctx.beginPath(); ctx.moveTo(x, zl[0]); ctx.lineTo(x, TL_LAYOUT.events[1]); ctx.stroke();
    ctx.strokeStyle = "#CCC";
    ctx.fillText(`${+t.toFixed(2)}s`, x + 2, 9);
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(L, 0, W - L - Rm, H); ctx.clip();

  // selected step
  steps.forEach((s, i) => {
    if (data.selectedTop === null || data.selectedTop === undefined || s.src[0] !== data.selectedTop) return;
    ctx.fillStyle = "rgba(255,45,149,0.10)";
    ctx.fillRect(xAt(times[i].t0), zl[0], Math.max(2, xAt(times[i].t1) - xAt(times[i].t0)), TL_LAYOUT.events[1] - zl[0]);
  });

  // the movement a TOP/SIDE stroke would reshape now
  if (data.target) {
    const a = xAt(data.target.t0), b = xAt(data.target.t1);
    ctx.fillStyle = "rgba(31,95,191,0.08)";
    ctx.fillRect(a, TL_LAYOUT.ruler[0], Math.max(2, b - a), TL_LAYOUT.events[1]);
    ctx.fillStyle = "rgba(31,95,191,0.45)";
    ctx.fillRect(a, TL_LAYOUT.ruler[1] - 3, Math.max(2, b - a), 3);
  }

  // Z lane
  ctx.strokeStyle = "#333"; ctx.lineWidth = 1.3;
  ctx.beginPath();
  let z = 0, started = false;
  steps.forEach((s, i) => {
    if (s.op === "travel") { z = s.to[2]; ctx.moveTo(xAt(times[i].t0), zy(z)); started = true; return; }
    if (!started) return;
    if (s.op === "move") { ctx.lineTo(xAt(times[i].t0), zy(s.from[2])); ctx.lineTo(xAt(times[i].t1), zy(s.to[2])); z = s.to[2]; }
    else ctx.lineTo(xAt(times[i].t1), zy(z));
  });
  ctx.stroke();
  ctx.strokeStyle = "rgba(153,153,153,0.5)"; ctx.setLineDash([2, 3]);   // the bed / 0.2mm first contact
  ctx.beginPath(); ctx.moveTo(L, zy(0.2)); ctx.lineTo(W, zy(0.2)); ctx.stroke(); ctx.setLineDash([]);

  // painting preview
  if (data.paint?.length) {
    ctx.strokeStyle = COLORS.select; ctx.lineWidth = 2;
    ctx.beginPath();
    data.paint.forEach((p, i) => { const x = xAt(p.t), y = zy(p.z); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  }

  // flow lane
  const flows = steps.map((s, i) => {
    const dt = times[i].t1 - times[i].t0;
    if (dt <= 0) return 0;
    if ((s.op === "move" && s.e > 0) || s.op === "extrudeHere") return (s.e * data.filArea) / dt;
    return 0;
  });
  const fMax = Math.max(0.5, ...flows, data.maxFlow || 0);
  const fl = TL_LAYOUT.flow;
  steps.forEach((s, i) => {
    const f = flows[i];
    if (f <= 0) return;
    const h = (f / fMax) * (fl[1] - fl[0] - 2);
    ctx.fillStyle = s.op === "extrudeHere" ? COLORS.puddle : COLORS.extrude;
    ctx.fillRect(xAt(times[i].t0), fl[1] - h, Math.max(1, xAt(times[i].t1) - xAt(times[i].t0)), h);
  });
  if (data.maxFlow) {
    const y = fl[1] - (data.maxFlow / fMax) * (fl[1] - fl[0] - 2);
    ctx.strokeStyle = "rgba(192,57,43,0.5)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
  }

  // events lane
  const ev = TL_LAYOUT.events, my = (ev[0] + ev[1]) / 2;
  steps.forEach((s, i) => {
    const x0 = xAt(times[i].t0), x1 = xAt(times[i].t1);
    if (s.op === "dwell") { ctx.fillStyle = "rgba(122,79,179,0.25)"; ctx.fillRect(x0, ev[0] + 2, Math.max(1, x1 - x0), ev[1] - ev[0] - 4); }
    else if (s.op === "extrudeHere") { ctx.fillStyle = "rgba(224,123,0,0.35)"; ctx.fillRect(x0, ev[0] + 2, Math.max(1, x1 - x0), ev[1] - ev[0] - 4); }
    else if (s.op === "retract") tri(ctx, x0, my, false, 4, COLORS.retract);
    else if (s.op === "prime") tri(ctx, x0, my, true, 4, COLORS.prime);
  });

  // playhead
  const ph = data.playhead === null || data.playhead === undefined ? total : Math.min(data.playhead, total);
  const px = xAt(ph);
  ctx.strokeStyle = COLORS.select; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ev[1]); ctx.stroke();
  ctx.fillStyle = COLORS.select;
  ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.closePath(); ctx.fill();
  ctx.restore();

  ctx.fillStyle = COLORS.text;
  const where = data.playhead === null || data.playhead === undefined ? "end (new things are appended)" : `${ph.toFixed(2)}s`;
  ctx.fillText(`playhead ${where} · stamp ${total.toFixed(1)}s · max flow ${fMax.toFixed(1)}mm³/s${span < total - 1e-6 ? ` · showing ${win.t0.toFixed(1)}–${win.t1.toFixed(1)}s` : ""}`, L, H - 4);

  const laneAt = (py) => {
    for (const k of ["ruler", "z", "flow", "events"]) { const [a, b] = TL_LAYOUT[k]; if (py >= a && py <= b) return k; }
    return null;
  };
  const pick = (pxx) => {
    const t = timeAt(pxx);
    let best = -1;
    times.forEach((tt, i) => { if (t >= tt.t0 && t <= Math.max(tt.t1, tt.t0 + span * 0.01)) best = i; });
    return best;
  };
  return { total, win, zTop, xAt, timeAt, laneAt, zAt, pick };
}
