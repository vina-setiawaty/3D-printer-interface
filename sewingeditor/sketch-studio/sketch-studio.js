// Sketch studio: a bare drawing + timeline editor, the start of a rebuild of
// brush-sketch's editing surface. Features are added from
// docs/feature-checklist.md as the author ticks them.
//
// One document: paths in the stamp's local frame (mm, +y up), printed in
// list order. The timeline shows each path as one clip whose length is its
// print time at the path's feed; travel between paths is not timed yet.
// No printing, program or LLM here yet.

const VIEW_MM = 10;          // the drawing shows -VIEW_MM..VIEW_MM
const BEAD_MM = 0.8;         // drawn line width, to scale
const DEFAULT_FEED = 300;    // mm/min
const SIMPLIFY_MM = 0.1;     // freehand RDP tolerance
const HIT_PX = 7;
const D = 560;               // drawing canvas, px square
const TL_W = 560, TL_H = 90; // timeline canvas, px
const TL_PAD = 10, RULER_H = 18, TRACK_Y = 26, TRACK_H = 34;

const doc = { paths: [] };
let nextId = 1;
const ui = { tool: "freehand", sel: null, selNode: -1, playhead: 0, playing: false, mouse: null };
let penPath = null;   // id of the path the pen is building
let stroke = null;    // freehand samples while drawing
let drag = null;      // select-tool drag in progress
const undoStack = [], redoStack = [];

// ---- geometry ----
const r3 = (v) => Math.round(v * 1000) / 1000;
const S = D / (2 * VIEW_MM);
const toPx = (p) => ({ x: D / 2 + p.x * S, y: D / 2 - p.y * S });
const toMm = (x, y) => ({ x: r3((x - D / 2) / S), y: r3((D / 2 - y) / S) });
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const byId = (id) => doc.paths.find((p) => p.id === id);

function distToSeg(p, a, b) {
  const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2)) : 0;
  return dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

/** Ramer-Douglas-Peucker; keeps first and last. */
function simplify(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  let worst = -1, idx = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], pts[0], pts[pts.length - 1]);
    if (d > worst) { worst = d; idx = i; }
  }
  if (worst <= eps) return [pts[0], pts[pts.length - 1]];
  return simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps));
}

function pathLength(p) {
  let L = 0;
  for (let i = 1; i < p.nodes.length; i++) L += dist(p.nodes[i - 1], p.nodes[i]);
  return L;
}

function pointAt(p, frac) {
  let left = pathLength(p) * Math.max(0, Math.min(1, frac));
  for (let i = 1; i < p.nodes.length; i++) {
    const a = p.nodes[i - 1], b = p.nodes[i], d = dist(a, b);
    if (left <= d && d > 0) return { x: a.x + (b.x - a.x) * left / d, y: a.y + (b.y - a.y) * left / d };
    left -= d;
  }
  return p.nodes[p.nodes.length - 1];
}

/** Each path as a clip: { path, t0, t1 } in seconds, in print order. */
function clips() {
  let t = 0;
  return doc.paths.map((p) => {
    const c = { path: p, t0: t, t1: t + pathLength(p) / (p.feed / 60) };
    t = c.t1;
    return c;
  });
}
const total = () => { const cs = clips(); return cs.length ? cs[cs.length - 1].t1 : 0; };

function nozzleAt(t) {
  const cs = clips();
  for (const c of cs) if (t <= c.t1) return pointAt(c.path, c.t1 > c.t0 ? (t - c.t0) / (c.t1 - c.t0) : 0);
  return cs.length ? pointAt(cs[cs.length - 1].path, 1) : null;
}

// ---- document edits ----
function remember() {
  undoStack.push(JSON.stringify(doc.paths));
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}

function swapHistory(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(doc.paths));
  doc.paths = JSON.parse(from.pop());
  if (!byId(ui.sel)) ui.sel = null;
  ui.selNode = -1;
  penPath = null;
  redraw();
}

function newPath(kind, nodes) {
  const p = { id: nextId++, kind, nodes, feed: DEFAULT_FEED };
  doc.paths.push(p);
  ui.sel = p.id;
  ui.selNode = -1;
  return p;
}

function finishPen() {
  const p = byId(penPath);
  if (p && p.nodes.length < 2) doc.paths = doc.paths.filter((q) => q !== p);
  penPath = null;
}

function deleteSelection() {
  const p = byId(ui.sel);
  if (!p) return;
  remember();
  if (ui.selNode >= 0 && p.nodes.length > 2) {
    p.nodes.splice(ui.selNode, 1);
    ui.selNode = Math.min(ui.selNode, p.nodes.length - 1);
  } else {
    doc.paths = doc.paths.filter((q) => q !== p);
    ui.sel = null;
    ui.selNode = -1;
  }
  if (penPath === p.id) penPath = null;
}

function nudge(dx, dy) {
  const p = byId(ui.sel);
  if (!p) return;
  remember();
  const nodes = ui.selNode >= 0 ? [p.nodes[ui.selNode]] : p.nodes;
  for (const n of nodes) { n.x = r3(n.x + dx); n.y = r3(n.y + dy); }
}

function setTool(t) {
  if (penPath !== null) finishPen();
  ui.tool = t;
  redraw();
}

// ---- hit testing (px) ----
function hitNode(m) {
  const order = doc.paths.slice().reverse();
  const sel = byId(ui.sel);
  if (sel) order.unshift(sel);   // the selected path's nodes win
  for (const p of order)
    for (let i = 0; i < p.nodes.length; i++) if (dist(toPx(p.nodes[i]), m) < HIT_PX) return { p, i };
  return null;
}

function hitPath(m) {
  for (const p of doc.paths.slice().reverse())
    for (let i = 1; i < p.nodes.length; i++)
      if (distToSeg(m, toPx(p.nodes[i - 1]), toPx(p.nodes[i])) < Math.max(HIT_PX, BEAD_MM * S / 2)) return p;
  return null;
}

// ---- canvases ----
function setupCanvas(c, w, h) {
  const r = window.devicePixelRatio || 1;
  c.width = w * r; c.height = h * r;
  c.style.width = w + "px"; c.style.height = h + "px";
  const g = c.getContext("2d");
  g.setTransform(r, 0, 0, r, 0, 0);
  return g;
}

const drawCanvas = document.querySelector("#ss-draw");
const tlCanvas = document.querySelector("#ss-timeline");
const g = setupCanvas(drawCanvas, D, D);
const tg = setupCanvas(tlCanvas, TL_W, TL_H);

function renderDrawing() {
  g.clearRect(0, 0, D, D);
  for (let v = -VIEW_MM; v <= VIEW_MM; v++) {
    const q = D / 2 + v * S;
    g.strokeStyle = v === 0 ? "#BBB" : v % 5 === 0 ? "#DDD" : "#F0F0F0";
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(q, 0); g.lineTo(q, D); g.moveTo(0, q); g.lineTo(D, q); g.stroke();
  }
  g.fillStyle = "#999"; g.font = "10px monospace";
  g.fillText(`TOP · ${VIEW_MM * 2} mm · grid 1 mm`, 6, 12);

  const line = (nodes, color, width) => {
    if (nodes.length < 2) return;
    g.strokeStyle = color; g.lineWidth = width; g.lineCap = "round"; g.lineJoin = "round";
    g.beginPath();
    nodes.forEach((n, i) => { const q = toPx(n); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    g.stroke();
  };

  doc.paths.forEach((p, k) => {
    const on = p.id === ui.sel;
    line(p.nodes, on ? "rgba(11,61,145,0.9)" : "rgba(31,95,191,0.75)", BEAD_MM * S);
    const s = toPx(p.nodes[0]);
    g.fillStyle = "#666"; g.fillText(String(k + 1), s.x + 6, s.y - 6);
  });

  // pen preview: rubber band from the last node to the mouse
  const pp = byId(penPath);
  if (pp && ui.mouse) {
    g.setLineDash([4, 4]);
    line([pp.nodes[pp.nodes.length - 1], toMm(ui.mouse.x, ui.mouse.y)], "#1f5fbf", 1);
    g.setLineDash([]);
  }
  if (stroke) line(stroke, "rgba(31,95,191,0.5)", BEAD_MM * S);

  const sel = byId(ui.sel);
  if (sel) sel.nodes.forEach((n, i) => {
    const q = toPx(n);
    g.fillStyle = i === ui.selNode ? "#0b3d91" : "#FFF";
    g.strokeStyle = "#0b3d91"; g.lineWidth = 1;
    g.fillRect(q.x - 3.5, q.y - 3.5, 7, 7); g.strokeRect(q.x - 3.5, q.y - 3.5, 7, 7);
  });

  const nz = nozzleAt(ui.playhead);
  if (nz) {
    const q = toPx(nz);
    g.strokeStyle = "#e0157a"; g.lineWidth = 2;
    g.beginPath(); g.arc(q.x, q.y, 7, 0, Math.PI * 2); g.stroke();
  }
}

const tlScale = () => (TL_W - 2 * TL_PAD) / Math.max(total(), 1);
const tlX = (t) => TL_PAD + t * tlScale();
const tlT = (x) => Math.max(0, Math.min(total(), (x - TL_PAD) / tlScale()));

function niceStep(raw) {
  const e = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * e).find((s) => s >= raw);
}

function renderTimeline() {
  tg.clearRect(0, 0, TL_W, TL_H);
  tg.fillStyle = "#F7F7F7"; tg.fillRect(0, 0, TL_W, RULER_H);
  const span = Math.max(total(), 1), step = niceStep(span / 8);
  tg.font = "10px monospace"; tg.fillStyle = "#888"; tg.strokeStyle = "#CCC"; tg.lineWidth = 1;
  for (let t = 0; t <= span + 1e-9; t += step) {
    const x = tlX(t);
    tg.beginPath(); tg.moveTo(x, RULER_H - 5); tg.lineTo(x, RULER_H); tg.stroke();
    tg.fillText(`${+t.toFixed(2)}s`, x + 2, 11);
  }
  tg.fillStyle = "#FAFAFA"; tg.fillRect(TL_PAD, TRACK_Y, TL_W - 2 * TL_PAD, TRACK_H);
  tg.fillStyle = "#AAA"; tg.fillText("XY", 0, TRACK_Y + TRACK_H + 12);

  clips().forEach((c, k) => {
    const x0 = tlX(c.t0), x1 = tlX(c.t1), on = c.path.id === ui.sel;
    tg.fillStyle = on ? "#0b3d91" : "#5b8fd6";
    tg.fillRect(x0 + 0.5, TRACK_Y, Math.max(1, x1 - x0 - 1), TRACK_H);
    if (x1 - x0 > 18) {
      tg.fillStyle = "#FFF";
      tg.fillText(`${k + 1} ${c.path.kind}`, x0 + 4, TRACK_Y + 13);
    }
  });

  const x = tlX(ui.playhead);
  tg.strokeStyle = "#e0157a"; tg.lineWidth = 1.5;
  tg.beginPath(); tg.moveTo(x, 0); tg.lineTo(x, TL_H); tg.stroke();
}

function renderStatus() {
  const m = ui.mouse ? toMm(ui.mouse.x, ui.mouse.y) : null;
  const sel = byId(ui.sel);
  const parts = [ui.tool];
  if (m) parts.push(`x ${m.x.toFixed(2)} y ${m.y.toFixed(2)}`);
  if (sel) parts.push(`path ${doc.paths.indexOf(sel) + 1}: ${sel.nodes.length} nodes, ${pathLength(sel).toFixed(2)} mm` +
    (ui.selNode >= 0 ? `, node ${ui.selNode + 1}` : ""));
  parts.push(`${doc.paths.length} path(s)`);
  document.querySelector("#ss-status").textContent = parts.join(" · ");
  document.querySelector("#ss-time").textContent = `${ui.playhead.toFixed(2)}s / ${total().toFixed(2)}s`;
  document.querySelectorAll("#ss-tools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === ui.tool));
  document.querySelector('[data-cmd="play"]').textContent = ui.playing ? "pause" : "play";
}

function redraw() {
  ui.playhead = Math.min(ui.playhead, total());
  renderDrawing();
  renderTimeline();
  renderStatus();
}

// ---- drawing input ----
const local = (e, c) => { const b = c.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };

drawCanvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const m = local(e, drawCanvas);
  drawCanvas.setPointerCapture(e.pointerId);
  if (ui.tool === "freehand") {
    stroke = [toMm(m.x, m.y)];
  } else if (ui.tool === "pen") {
    const at = toMm(m.x, m.y), p = byId(penPath);
    if (!p) { remember(); penPath = newPath("pen", [at]).id; }
    else if (dist(p.nodes[p.nodes.length - 1], at) > 0.05) { remember(); p.nodes.push(at); }
  } else {
    const hn = hitNode(m), hp = hn ? hn.p : hitPath(m);
    ui.sel = hp ? hp.id : null;
    ui.selNode = hn ? hn.i : -1;
    if (hp) { remember(); drag = { from: toMm(m.x, m.y), start: JSON.parse(JSON.stringify(hp.nodes)) }; }
  }
  redraw();
});

drawCanvas.addEventListener("pointermove", (e) => {
  ui.mouse = local(e, drawCanvas);
  const at = toMm(ui.mouse.x, ui.mouse.y);
  if (stroke) {
    if (dist(stroke[stroke.length - 1], at) > 0.05) stroke.push(at);
  } else if (drag) {
    const p = byId(ui.sel), dx = at.x - drag.from.x, dy = at.y - drag.from.y;
    const idx = ui.selNode >= 0 ? [ui.selNode] : p.nodes.map((_, i) => i);
    for (const i of idx) p.nodes[i] = { x: r3(drag.start[i].x + dx), y: r3(drag.start[i].y + dy) };
  }
  redraw();
});

drawCanvas.addEventListener("pointerup", () => {
  if (stroke) {
    const nodes = simplify(stroke, SIMPLIFY_MM);
    stroke = null;
    if (nodes.length >= 2) { remember(); newPath("freehand", nodes); }
  }
  drag = null;
  redraw();
});

drawCanvas.addEventListener("pointerleave", () => { ui.mouse = null; redraw(); });
drawCanvas.addEventListener("dblclick", () => { if (penPath !== null) { finishPen(); redraw(); } });

// ---- timeline input ----
let scrubbing = false;
tlCanvas.addEventListener("pointerdown", (e) => {
  const m = local(e, tlCanvas);
  tlCanvas.setPointerCapture(e.pointerId);
  scrubbing = true;
  ui.playhead = tlT(m.x);
  if (m.y >= TRACK_Y && m.y <= TRACK_Y + TRACK_H) {
    const c = clips().find((c) => ui.playhead >= c.t0 && ui.playhead <= c.t1);
    if (c) { ui.sel = c.path.id; ui.selNode = -1; }
  }
  redraw();
});
tlCanvas.addEventListener("pointermove", (e) => { if (scrubbing) { ui.playhead = tlT(local(e, tlCanvas).x); redraw(); } });
tlCanvas.addEventListener("pointerup", () => { scrubbing = false; });

// ---- playback ----
let lastFrame = 0;
function tick(now) {
  if (!ui.playing) return;
  ui.playhead += (now - lastFrame) / 1000;
  lastFrame = now;
  if (ui.playhead >= total()) { ui.playhead = total(); ui.playing = false; }
  redraw();
  if (ui.playing) requestAnimationFrame(tick);
}
function togglePlay() {
  if (!total()) return;
  ui.playing = !ui.playing;
  if (ui.playing) {
    if (ui.playhead >= total()) ui.playhead = 0;
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
  redraw();
}

// ---- buttons and keys ----
document.querySelectorAll("#ss-tools [data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
const commands = {
  undo: () => swapHistory(undoStack, redoStack),
  redo: () => swapHistory(redoStack, undoStack),
  clear: () => { if (doc.paths.length) { remember(); doc.paths = []; ui.sel = null; penPath = null; redraw(); } },
  play: togglePlay,
};
document.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => commands[b.dataset.cmd]()));

window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k.toLowerCase() === "z") { e.shiftKey ? commands.redo() : commands.undo(); }
  else if (ctrl && k.toLowerCase() === "y") commands.redo();
  else if (ctrl) return;
  else if (k === "v" || k === "V") setTool("select");
  else if (k === "b" || k === "B") setTool("freehand");
  else if (k === "p" || k === "P") setTool("pen");
  else if (k === "Enter" || k === "Escape") { finishPen(); stroke = null; }
  else if (k === "Delete" || k === "Backspace") deleteSelection();
  else if (k === " ") togglePlay();
  else if (k === "Home") ui.playhead = 0;
  else if (k === "End") ui.playhead = total();
  else if (k.startsWith("Arrow")) {
    const s = e.shiftKey ? 1 : 0.1;
    nudge(k === "ArrowLeft" ? -s : k === "ArrowRight" ? s : 0, k === "ArrowUp" ? s : k === "ArrowDown" ? -s : 0);
  } else return;
  e.preventDefault();
  redraw();
});

redraw();
