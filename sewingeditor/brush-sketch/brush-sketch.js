// brush-sketch.html -- prompt the exploration of a NEW tactile texture by
// drawing what the nozzle does at one stamp point.
//
//   column 1  the sketch: TOP / SIDE / TIMELINE views, freehand or vector
//   column 2  the brush program it becomes: params, steps, the gate
//   column 3  test G-code into test_print_gcode/, promotion into the
//             library (sketched_brushes.js + the docs), print feedback
//
// The working PROGRAM is the one source of truth. Freehand strokes produce
// a literal draft program (literal-draft.js); the interpret stage (LLM)
// may turn that into a printable, parametric one, listing every change;
// vector mode edits the program directly. Everything printed goes through
// the library's own interpreter (texture_docs/sketched_brushes.js), which
// is also what the promoted functions call -- what was tested is what the
// library emits.
//
// This is an ES module. It reads llm.js's classic-script helpers as
// globals (escapeHtml, extractResponseOutput, wasTruncated, recordCost,
// renderCostTracker, updateModelOptions, saveApiKeyFrom, loadApiKeyInto,
// callLlmDirect) and exposes initBrushSketch for brush-sketch-compat.js.
// Its own inputs use data-k attributes, not ids: script.js saves and
// restores every <input id> page-wide, which would silently overwrite them.

import * as lib from "../texture_docs/texture_functions.js";
import { checkProgram, validateProgramShape, BUILTIN_OPTIONS, retractBudgetWarning } from "./checks.js";
import { literalDraft, strokeSummary, DRAFT_DEFAULTS } from "./literal-draft.js";
import { renderTop, renderSide, renderTimeline, topProjection, sideProjection } from "./views.js";
import { timing, positionAt, insertAt, paintZ, movementAt, overlayZ, overlayXY } from "./timeline-edit.js";
import { buildTestPrint, proposeCalibration, testFilename, digestText } from "./test-print.js";
import { STAGES } from "./stage-schemas.js";
import { DOC_PATHS, docText, composeSystemPrompt, composeUserMessage } from "./prompt-assembly.js";
import { runGatedStage, parseProgramField, motionSignature, compareMotion } from "./sketch-pipeline.js";
import * as P from "./promote.js";
import * as io from "./library-io.js";

const STORAGE_KEY = "brushSketchState";
const DEBUG_LOG_KEY = "brushSketchDebugLog";
const $ = (sel) => document.querySelector(sel);
const $k = (k) => document.querySelector(`[data-k="${k}"]`);
const today = () => new Date().toISOString().slice(0, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ state --

function starterProgram() {
  return {
    name: "sketchedBrush", version: 1, orientation: "fixed", radiusMm: 4, defaultGap: 6, params: {},
    steps: [
      { op: "travel", to: [0, 0, 0.2] },
      { op: "prime", mm: 1.3 },
      { op: "move", to: [0, 0, 1.0], e: 0.3, f: 120 },
      { op: "dwell", ms: 1000 },
      { op: "retract", mm: 1.3 },
    ],
  };
}

function defaultState() {
  return {
    mode: "freehand",
    program: starterProgram(),
    source: "starter",        // starter | drawn | interpreted | edited | library | proposed
    literal: null,            // {program}: your drawing as it was before the last interpretation
    interpreted: null,        // {program, notes, chat}
    notes: [],                // changes from the drawing that the current program carries
    sketch: { strokes: [] },
    values: {},               // preview values per param
    selected: 1,
    playhead: null,           // seconds into the stamp; null = the end
    tlWin: null,              // timeline zoom window {t0, t1}; null = whole stamp
    ui: {
      zoom: 8, az: 0, timeScale: 1, drawRetractMm: 1.3, useDrawSpeed: false, intent: "", showLiteral: true, showStrokes: true,
      material: "TPU", calMode: "normal", calY: 85, calX: 197, calBand: 110,
      texX: 30, texY: 85, texLen: 30, optAz: 0, optGap: "", sweepParam: "", sweepValues: "", fileDesc: "", report: "",
    },
    aiLog: [],
    lastTest: null,           // {filename, digest, programKey}
    vecExtrude: true,
  };
}

let S = loadState();
function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!raw || !raw.program) return defaultState();
    const d = defaultState();
    const out = { ...d, ...raw, ui: { ...d.ui, ...(raw.ui || {}) } };
    if (out.source === "literal" || out.source === "vector") out.source = "drawn";   // names before the timeline rework
    if (out.literal && !out.literal.program) out.literal = null;
    return out;
  } catch { return defaultState(); }
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); } catch { /* quota: the sketch is still in memory */ }
}

// Undo: each entry is the program AND how many strokes existed, so undoing
// a freehand stroke also forgets it from the sketch record.
let history = [];
function pushHistory() {
  history.push(JSON.stringify({ program: S.program, strokes: S.sketch.strokes.length, source: S.source }));
  if (history.length > 80) history.shift();
}

const programKey = (p) => JSON.stringify(p);

/** Any hand edit: the program is now "yours" (or an edit of what the
 * model / library / a print report produced). */
function markEdited() {
  if (S.source === "interpreted") S.source = "edited";
  else if (S.source === "starter") S.source = "drawn";
}

// Library-side state (not persisted: re-read from disk on connect).
const LIB = { files: {}, hashes: {}, pending: null, pendingFeedback: null, proposed: null };

// ------------------------------------------------------------- derived --

let derived = { steps: null, error: null, check: null, literalSteps: null, T: null };

function currentValues() {
  const out = {};
  for (const [k, s] of Object.entries(S.program.params || {})) {
    const v = S.values[k];
    out[k] = Number.isFinite(v) && v >= s.min && v <= s.max ? v : s.def;
  }
  return out;
}

function recompute() {
  derived = { steps: null, error: null, check: null, literalSteps: null, T: null };
  const shape = validateProgramShape(S.program);
  if (shape.length) derived.error = shape[0];
  else {
    try {
      derived.T = timing(lib, S.program, currentValues());
      derived.steps = derived.T.steps;
    } catch (e) { derived.error = e.message; }
  }
  derived.check = checkProgram(lib, S.program, { material: S.ui.material, options: currentValues() });
  if (S.literal && S.ui.showLiteral && (S.source === "interpreted" || S.source === "edited")) {
    try { derived.literalSteps = lib.expandSketchProgram(S.literal.program, lib.resolveSketchParams(S.literal.program, {})); } catch { /* shown via its own check */ }
  }
  if (S.playhead !== null && derived.T && S.playhead >= derived.T.total - 1e-6) S.playhead = null;
}

// ---------------------------------------------------------------- playhead --
//
// The playhead is a moment in the stamp (seconds of print time), or null =
// "at the end". Whatever is added next -- a stroke drawn in TOP or SIDE, a
// dwell/retract/prime key, a node clicked in vector mode -- happens at the
// playhead, and the nozzle marker in both views shows where it will start.

/** The movement a TOP/SIDE stroke would reshape right now, or null. */
function targetMovement() {
  if (!derived.T || S.source === "starter") return null;
  return movementAt(S.program, derived.T, S.playhead);
}

function playheadPos() {
  if (!derived.T) return [0, 0, 0.2];
  const t = S.playhead === null ? derived.T.total : S.playhead;
  return positionAt(derived.T.steps, derived.T.times, t);
}

function setPlayhead(t) {
  if (!derived.T) return;
  S.playhead = t === null || t >= derived.T.total - 1e-6 ? null : Math.max(0, t);
}

/** Moves the playhead to the end of top-level step k (null when k is last). */
function playheadAfterStep(k) {
  if (!derived.T) return;
  setPlayhead(k >= S.program.steps.length - 1 ? null : derived.T.spans[k]?.t1 ?? null);
}

/** Step boundaries, for `,` / `.` and for snapping. */
function boundaries() {
  if (!derived.T) return [0];
  const b = new Set([0]);
  for (const sp of derived.T.spans) { b.add(+sp.t0.toFixed(6)); b.add(+sp.t1.toFixed(6)); }
  return [...b].sort((a, c) => a - c);
}

function stepPlayhead(dir) {
  const cur = S.playhead === null ? derived.T?.total ?? 0 : S.playhead;
  const b = boundaries();
  const next = dir > 0 ? b.find((t) => t > cur + 1e-6) : [...b].reverse().find((t) => t < cur - 1e-6);
  setPlayhead(next === undefined ? (dir > 0 ? null : 0) : next);
  syncSelectionToPlayhead();
  render(); renderSteps(); saveSoon();
}

function syncSelectionToPlayhead() {
  if (!derived.T) return;
  const t = S.playhead === null ? derived.T.total : S.playhead;
  // the step that ENDS at or last before the playhead -- "after this"
  let k = 0;
  for (const sp of derived.T.spans) if (sp.t1 <= t + 1e-6) k = sp.k;
  S.selected = k;
}

/** Puts `block` at the playhead. `excursion`: the block goes somewhere and
 * the sequence should carry on from where it was (a drawn stroke) -- a
 * dry move back is added. Otherwise (a waypoint, an event) it just slots
 * in. The playhead then sits right after what was added. */
function insertAtPlayhead(block, { excursion = false } = {}) {
  pushHistory();
  const values = currentValues();
  const r = insertAt(lib, S.program, values, S.playhead, block, { returnHome: excursion });
  if (excursion && r.last >= r.first) {
    // a drawn stroke is its own movement, and so is what carries on after it
    const n = S.program.steps.filter((q) => q.movement).length + 2;
    if (r.program.steps[r.first]?.op === "move") r.program.steps[r.first].movement = `movement ${n}`;
    const after = r.program.steps[r.last + 1];
    if (after?.op === "move" && !after.movement) after.movement = `movement ${n + 1}`;
  }
  S.program = r.program;
  markEdited();
  if (r.note) aiNote(r.note);
  if (r.returned && excursion) aiNote(`step ${r.last + 1}: a dry move back to where the sequence carries on was added -- delete it if the stroke should end where you lifted the mouse`);
  recompute();
  if (derived.T && S.playhead !== null) {
    const lastOwn = excursion && r.returned ? r.last - 1 : r.last;
    S.playhead = derived.T.spans[lastOwn]?.t1 ?? null;
  }
  S.selected = Math.max(0, excursion && r.returned ? r.last - 1 : r.last);
  changed();
}

// --------------------------------------------------------------- canvases --

const views = {};
function setupCanvas(id, w, h) {
  const c = $(id);
  const dpr = window.devicePixelRatio || 1;
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d");
  ctx.dpr = dpr;
  return { c, ctx, W: w, H: h };
}

function topNodes() {
  // editable nodes = top-level travel/move steps, at their expanded position
  if (!derived.steps || S.mode !== "vector") return null;
  const nodes = [];
  S.program.steps.forEach((st, k) => {
    if (st.op !== "travel" && st.op !== "move") return;
    const ex = derived.steps.find((s) => s.src.length === 1 && s.src[0] === k);
    if (!ex) return;
    const vec = st.to || st.by || [];
    nodes.push({ index: k, pos: ex.to, locked: vec.map((v) => typeof v === "string"), usesBy: !st.to });
  });
  return nodes;
}

let tl = null;                // the timeline's geometry from its last render
let tlDrag = null;            // {kind: "scrub"} | {kind: "paint", zTop, samples}
let viewSaveTimer = null;
function saveSoon() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveState, 300);
}

function render() {
  const R = Number(S.ui.zoom) || 8;
  const marker = playheadPos();
  if (!live) { pen3.x = marker[0]; pen3.y = marker[1]; pen3.z = marker[2]; }
  const data = {
    steps: derived.steps, literal: derived.literalSteps, nodes: topNodes(), selectedTop: S.selected,
    raw: S.mode === "freehand" && S.ui.showStrokes ? [...S.sketch.strokes, ...(live ? [live] : [])] : live ? [live] : null,
    filArea: lib.FIL_AREA, pen: live ? [pen3.x, pen3.y, pen3.z] : null, marker: live ? null : marker, maxFlow: 4.0,
  };
  renderTop({ ...views.top, R, radiusMm: S.program.radiusMm, az: S.mode === "freehand" ? Number(S.ui.az) : undefined }, data);
  renderSide({ ...views.side, R, az: Number(S.ui.az) }, data);
  const target = S.mode === "freehand" && !live ? targetMovement() : null;
  tl = renderTimeline(views.timeline, {
    ...data, playhead: S.playhead, win: S.tlWin, target: target ? { t0: target.ta, t1: target.tb } : null,
    paint: tlDrag?.kind === "paint" ? tlDrag.samples : null, zTop: tlDrag?.kind === "paint" ? tlDrag.zTop : null,
  });
  renderPen();
}

function renderPen() {
  const el = $("#bs-pen");
  const at = S.playhead === null ? "the end" : `${S.playhead.toFixed(2)}s`;
  if (S.mode === "freehand") {
    const mv = live ? null : targetMovement();
    const what = live
      ? (live.insert ? "drawing a new movement" : `reshaping its ${live.view === "top" ? "XY" : "Z"}`)
      : mv ? `strokes reshape steps ${mv.first + 1}–${mv.last + 1} (TOP → XY, SIDE → Z) · Ctrl+drag adds a new movement at ${at}`
        : `the next stroke starts a movement at ${at}`;
    el.textContent = `${what} · z ${pen3.z.toFixed(2)}mm · flow ${flow} · plane ${S.ui.az}°`;
    $("#bs-flow-dots").innerHTML = [1, 2, 3, 4, 5].map((i) => `<span class="${i <= flow ? "on" : ""}"></span>`).join("");
  } else {
    el.textContent = `new moves ${S.vecExtrude ? "extrude (bead 0.8×0.3, 300mm/min)" : "are dry (600mm/min)"} · inserted at ${at} · selected: step ${S.selected + 1}`;
    $("#bs-flow-dots").innerHTML = "";
  }
}

// ---------------------------------------------------------------- timeline --

function timelinePointer(e) {
  const r = views.timeline.c.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}

/** Snaps a time to the nearest step boundary within 5px. */
function snapTime(t) {
  if (!tl) return t;
  let best = t, bd = 5;
  for (const b of boundaries()) {
    const d = Math.abs(tl.xAt(b) - tl.xAt(t));
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

function onTimelineDown(e) {
  if (!tl || e.button !== 0) return;
  const { px, py } = timelinePointer(e);
  views.timeline.c.setPointerCapture(e.pointerId);
  const lane = tl.laneAt(py);
  if (lane === "z" && !e.altKey) {
    tlDrag = { kind: "paint", zTop: tl.zTop, samples: [{ t: Math.max(0, tl.timeAt(px)), z: tl.zAt(py) }] };
  } else {
    tlDrag = { kind: "scrub" };
    setPlayhead(e.altKey ? tl.timeAt(px) : snapTime(tl.timeAt(px)));
    syncSelectionToPlayhead();
    renderSteps();
  }
  render();
}

function onTimelineMove(e) {
  if (!tlDrag || !tl) return;
  const { px, py } = timelinePointer(e);
  if (tlDrag.kind === "paint") {
    const t = Math.max(0, Math.min(tl.total, tl.timeAt(px)));
    const last = tlDrag.samples[tlDrag.samples.length - 1];
    if (t > last.t) tlDrag.samples.push({ t, z: Math.max(0.05, tl.zAt(py)) });   // left-to-right only
  } else {
    setPlayhead(e.altKey ? tl.timeAt(px) : snapTime(tl.timeAt(px)));
    syncSelectionToPlayhead();
  }
  render();
}

function onTimelineUp() {
  if (!tlDrag) return;
  const d = tlDrag;
  tlDrag = null;
  if (d.kind === "paint" && d.samples.length >= 2) {
    pushHistory();
    const r = paintZ(lib, S.program, currentValues(), d.samples);
    if (!r.changed) { history.pop(); aiNote("nothing moves in that stretch of time -- paint over a move (dwells and retracts stay where they are)"); }
    else {
      S.program = r.program;
      markEdited();
      if (r.skipped.length) aiNote(`${r.skipped.join(", ")}: height is driven by a param (or a "by" move) -- left as it is`);
    }
    changed();
    return;
  }
  changed(false);
  saveSoon();
}

function onTimelineWheel(e) {
  if (!tl) return;
  e.preventDefault();
  const { px } = timelinePointer(e);
  const { t0, t1 } = tl.win;
  const span = t1 - t0;
  let n0, n1;
  if (e.shiftKey) {                                    // pan
    const d = (e.deltaY || e.deltaX) > 0 ? span * 0.15 : -span * 0.15;
    n0 = t0 + d; n1 = t1 + d;
  } else {                                             // zoom about the pointer
    const at = tl.timeAt(px);
    const k = e.deltaY < 0 ? 0.8 : 1.25;
    n0 = at - (at - t0) * k; n1 = at + (t1 - at) * k;
  }
  const total = tl.total;
  if (n1 - n0 >= total) { S.tlWin = null; render(); saveSoon(); return; }
  if (n0 < 0) { n1 -= n0; n0 = 0; }
  if (n1 > total) { n0 -= n1 - total; n1 = total; }
  S.tlWin = { t0: Math.max(0, n0), t1: Math.max(n0 + 0.02, n1) };
  render(); saveSoon();
}

// --------------------------------------------------------------- freehand --

const pen3 = { x: 0, y: 0, z: 0.2 };
let flow = 3;
let live = null;              // the stroke being drawn
let livePointer = null;       // {view, px, py}
let sketchT0 = null;
const keysDown = new Set();
let lastFrame = 0;

function nowMs() {
  if (sketchT0 === null) sketchT0 = performance.now() - (lastSampleT() + 500);
  return performance.now() - sketchT0;
}
function lastSampleT() {
  const st = S.sketch.strokes[S.sketch.strokes.length - 1];
  return st?.samples?.length ? st.samples[st.samples.length - 1].t : -500;
}

function pointerToLocal(view, px, py) {
  const R = Number(S.ui.zoom) || 8;
  if (view === "top") {
    const Pj = topProjection(views.top.W, views.top.H, R);
    const [x, y] = Pj.from(px, py);
    return { x, y, z: pen3.z };
  }
  const Pj = sideProjection(views.side.W, views.side.H, R, Number(S.ui.az));
  const [u, z] = Pj.fromUZ(px, py);
  const [c, s] = Pj.dir;
  // stay in the vertical plane through the pen
  const perp = pen3.x * -s + pen3.y * c;
  return { x: -s * perp + c * u, y: c * perp + s * u, z: Math.max(0.05, z) };
}

function addSample() {
  if (!live || !livePointer) return;
  const t = nowMs();
  const dt = Math.max(0, (t - lastFrame) / 1000);
  lastFrame = t;
  if (live.view === "top") {
    if (keysDown.has("w")) pen3.z += 2 * dt;
    if (keysDown.has("s")) pen3.z = Math.max(0.1, pen3.z - 2 * dt);
  }
  const p = pointerToLocal(live.view, livePointer.px, livePointer.py);
  live.samples.push({ t, x: r2(p.x), y: r2(p.y), z: r2(p.z), flow: live.dry ? 0 : flow });
  pen3.x = p.x; pen3.y = p.y; pen3.z = p.z;
}

function frame() {
  if (!live) return;
  addSample();
  render();
  requestAnimationFrame(frame);
}

function beginStroke(view, e) {
  const rect = e.target.getBoundingClientRect();
  // start from the nozzle at the playhead: its height (TOP) and the
  // vertical plane through it (SIDE)
  const m = S.source === "starter" ? [0, 0, 0.2] : playheadPos();
  pen3.x = m[0]; pen3.y = m[1]; pen3.z = Math.max(0.1, m[2]);
  livePointer = { view, px: e.clientX - rect.left, py: e.clientY - rect.top };
  live = { view, dry: e.shiftKey, insert: e.ctrlKey || e.metaKey, az: Number(S.ui.az), samples: [], events: [], at: S.playhead };
  lastFrame = nowMs();
  addSample();
  requestAnimationFrame(frame);
}

function draftOptions() {
  return { ...DRAFT_DEFAULTS, timeScale: Number(S.ui.timeScale) || 1, retractMm: Number(S.ui.drawRetractMm) || 1.3, useDrawSpeed: !!S.ui.useDrawSpeed };
}

function endStroke(cancel = false) {
  if (!live) return;
  const st = live;
  live = null; livePointer = null;
  if (cancel || st.samples.length < 2) { render(); return; }
  const { program: d } = literalDraft([st], draftOptions());
  if (S.source === "starter") {
    // the first stroke replaces the starter program outright
    pushHistory();
    S.sketch.strokes.push(st);
    S.program = { ...d, name: S.program.name };
    S.source = "drawn";
    S.playhead = null;
    S.selected = S.program.steps.length - 1;
    changed();
    return;
  }
  if (!st.insert && reshapeWithStroke(st, d)) return;
  pushHistory();                       // undo returns to before this stroke
  S.sketch.strokes.push({ ...st, use: "new movement" });
  S.program.radiusMm = Math.max(Number(S.program.radiusMm) || 0, d.radiusMm);
  insertAtPlayheadNoHistory(d.steps, { excursion: true });
}

/** A stroke reshapes ONE channel of the movement at the playhead: TOP ->
 * its XY (stretched over it), SIDE -> its Z (by position, or by time when
 * position is ambiguous). Timing and extrusion stay; nothing is added to
 * the path. Returns false when there is no movement to reshape. */
function reshapeWithStroke(st, d) {
  const values = currentValues();
  let r;
  if (st.view === "side") {
    const a = (st.az * Math.PI) / 180, dir = [Math.cos(a), Math.sin(a)];
    r = overlayZ(lib, S.program, values, S.playhead, st.samples.map((q) => ({ t: q.t, u: q.x * dir[0] + q.y * dir[1], z: q.z })), dir);
  } else {
    r = overlayXY(lib, S.program, values, S.playhead, st.samples.map((q) => ({ t: q.t, x: q.x, y: q.y })));
  }
  if (!r) return false;
  if (!r.changed) { aiNote(r.note || "that stroke didn't reach any move of the movement at the playhead"); render(); return true; }
  pushHistory();
  S.sketch.strokes.push({ ...st, use: st.view === "side" ? `Z of steps ${r.movement.first + 1}-${r.movement.last + 1}` : `XY of steps ${r.movement.first + 1}-${r.movement.last + 1}` });
  S.program = r.program;
  S.program.radiusMm = Math.max(Number(S.program.radiusMm) || 0, reachOf(S.program));
  markEdited();
  if (r.mode === "time") aiNote("the movement barely goes along this side view (or doubles back in it), so your SIDE stroke was matched by time instead of by position");
  if (r.skipped.length) aiNote(`${r.skipped.join(", ")}: left as they were (driven by a param)`);
  changed();
  return true;
}

/** How far the stamp reaches from its origin at the current params, +1mm. */
function reachOf(program) {
  try {
    const steps = lib.expandSketchProgram(program, currentValues());
    let m = 0;
    for (const q of steps) if (q.to) m = Math.max(m, Math.abs(q.to[0]), Math.abs(q.to[1]));
    return Math.ceil(m + 1);
  } catch { return 0; }
}

/** insertAtPlayhead without its own history entry (the caller pushed one). */
function insertAtPlayheadNoHistory(block, opts) {
  const h = history.length;
  insertAtPlayhead(block, opts);
  if (history.length > h) history.splice(h, 1);
}

function freehandEvent(type) {
  if (live) {
    live.events.push({ t: nowMs(), type });
    return;
  }
  insertAtPlayhead([{ op: type, mm: Number(S.ui.drawRetractMm) || 1.3 }]);
}

// ----------------------------------------------------------------- vector --

let drag = null;              // {index, view, axisLock}

function snap(v, free) { return free ? r2(v) : Math.round(v * 20) / 20; }

function nodeAt(view, px, py) {
  const nodes = topNodes();
  if (!nodes) return null;
  const R = Number(S.ui.zoom) || 8;
  const Pj = view === "top" ? topProjection(views.top.W, views.top.H, R) : sideProjection(views.side.W, views.side.H, R, Number(S.ui.az));
  let best = null, bd = 8;
  for (const n of nodes) {
    const [x, y] = Pj.to(n.pos);
    const d = Math.hypot(x - px, y - py);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

function prevPosition(index) {
  // position the nozzle is at just before top-level step `index` runs
  if (!derived.steps) return [0, 0, 0.2];
  let pos = [0, 0, 0.2];
  for (const s of derived.steps) {
    if (s.src[0] >= index) break;
    if (s.op === "travel" || s.op === "move") pos = s.to;
  }
  return pos;
}

function setNodePosition(index, p, view, free) {
  const st = S.program.steps[index];
  const cur = st.to ? st.to.slice() : null;
  const pos = [snap(p[0], free), snap(p[1], free), snap(Math.max(0.05, p[2]), free)];
  if (st.to) {
    st.to = cur.map((v, a) => (typeof v === "string" ? v : pos[a]));
  } else if (st.by) {
    // rewrite "by" relative to the previous position, keeping expressions
    const prev = prevPosition(index);
    st.by = st.by.map((v, a) => (typeof v === "string" ? v : r2(pos[a] - prev[a])));
  }
  markEdited();
}

function selectStep(k) {
  S.selected = k;
  recompute();
  playheadAfterStep(k);
}

function vectorPointerDown(view, e) {
  const rect = e.target.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const hit = nodeAt(view, px, py);
  if (hit) {
    selectStep(hit.index);
    pushHistory();
    drag = { index: hit.index, view, locked: hit.locked };
    changed(false);
    return;
  }
  // add a waypoint at the playhead, going to the clicked point
  const R = Number(S.ui.zoom) || 8;
  const base = playheadPos();
  let to;
  if (view === "top") {
    const [x, y] = topProjection(views.top.W, views.top.H, R).from(px, py);
    to = [snap(x, e.altKey), snap(y, e.altKey), r2(base[2])];
  } else {
    const Pj = sideProjection(views.side.W, views.side.H, R, Number(S.ui.az));
    const [u, z] = Pj.fromUZ(px, py);
    const [c, s] = Pj.dir;
    const perp = base[0] * -s + base[1] * c;
    to = [snap(-s * perp + c * u, e.altKey), snap(c * perp + s * u, e.altKey), snap(Math.max(0.1, z), e.altKey)];
  }
  const step = S.vecExtrude ? { op: "move", to, bead: { w: 0.8, h: 0.3 }, f: 300 } : { op: "move", to, f: 600 };
  insertAtPlayhead([step]);
}

function vectorPointerMove(e) {
  if (!drag) return;
  const view = drag.view;
  const el = view === "top" ? views.top.c : views.side.c;
  const rect = el.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const R = Number(S.ui.zoom) || 8;
  const ex = derived.steps?.find((s) => s.src.length === 1 && s.src[0] === drag.index);
  const cur = ex ? ex.to : [0, 0, 0.2];
  let p;
  if (view === "top") {
    const [x, y] = topProjection(views.top.W, views.top.H, R).from(px, py);
    p = [x, y, cur[2]];
  } else {
    const Pj = sideProjection(views.side.W, views.side.H, R, Number(S.ui.az));
    const [u, z] = Pj.fromUZ(px, py);
    const [c, s] = Pj.dir;
    const perp = cur[0] * -s + cur[1] * c;
    p = [-s * perp + c * u, c * perp + s * u, z];
  }
  setNodePosition(drag.index, p, view, e.altKey);
  changed(false);
}

function nudge(dx, dy, dz) {
  const st = S.program.steps[S.selected];
  if (!st || (st.op !== "move" && st.op !== "travel")) return;
  const ex = derived.steps?.find((s) => s.src.length === 1 && s.src[0] === S.selected);
  if (!ex) return;
  pushHistory();
  setNodePosition(S.selected, [ex.to[0] + dx, ex.to[1] + dy, ex.to[2] + dz], "top", true);
  changed();
}

/** Keys that add something at the playhead -- the same in both modes. */
function eventKey(k) {
  if (k === "d" || k === "D") { insertAtPlayhead([{ op: "dwell", ms: 500 }]); return true; }
  if (k === "h" || k === "H") { insertAtPlayhead([{ op: "extrudeHere", e: 0.2, ms: 1000 }]); return true; }
  return false;
}

function vectorKey(e) {
  const k = e.key;
  const big = e.shiftKey ? 1 : 0.1;
  const st = S.program.steps[S.selected];
  if (k === "x" || k === "X") { S.vecExtrude = !S.vecExtrude; renderPen(); saveState(); return true; }
  if (k === "e" || k === "E") {
    if (!st || st.op !== "move") return true;
    pushHistory();
    if (st.e !== undefined || st.bead) { delete st.e; delete st.bead; st.f = 600; }
    else { st.bead = { w: 0.8, h: 0.3 }; st.f = 300; }
    markEdited(); changed(); return true;
  }
  if (eventKey(k)) return true;
  if (k === "r" || k === "R") { insertAtPlayhead([{ op: "retract", mm: 1.3 }]); return true; }
  if (k === "p" || k === "P") { insertAtPlayhead([{ op: "prime", mm: 1.3 }]); return true; }
  if (k === "Delete" || k === "Backspace") { deleteStep(S.selected); return true; }
  if (k === "Tab") { selectStep((S.selected + (e.shiftKey ? -1 : 1) + S.program.steps.length) % S.program.steps.length); changed(false); return true; }
  if (k === "ArrowLeft") { nudge(-big, 0, 0); return true; }
  if (k === "ArrowRight") { nudge(big, 0, 0); return true; }
  if (k === "ArrowUp") { nudge(0, big, 0); return true; }
  if (k === "ArrowDown") { nudge(0, -big, 0); return true; }
  if (k === "PageUp") { nudge(0, 0, big); return true; }
  if (k === "PageDown") { nudge(0, 0, -big); return true; }
  return false;
}

function deleteStep(i) {
  if (i === 0) { aiNote("the first step is the travel to the start -- move it instead of deleting it"); return; }
  if (!S.program.steps[i]) return;
  pushHistory();
  S.program.steps.splice(i, 1);
  S.selected = Math.max(0, Math.min(i - 1, S.program.steps.length - 1));
  markEdited();
  changed();
}

function undo() {
  const prev = history.pop();
  if (!prev) return;
  const h = JSON.parse(prev);
  S.program = h.program;
  S.source = h.source;
  S.sketch.strokes.length = Math.min(S.sketch.strokes.length, h.strokes);
  S.selected = Math.min(S.selected, S.program.steps.length - 1);
  changed();
}

function resetSketch() {
  S.program = starterProgram();
  S.source = "starter";
  S.sketch.strokes = [];
  S.literal = null; S.interpreted = null; S.notes = []; S.values = {};
  S.playhead = null; S.tlWin = null; S.selected = 1;
  pen3.x = 0; pen3.y = 0; pen3.z = 0.2; sketchT0 = null; history = [];
}

// ---------------------------------------------------------------- panels --

function field(label, value, onChange, { wide = false, type = "text", options = null, title = "" } = {}) {
  const l = document.createElement("label");
  l.className = "bs-field" + (wide ? " wide" : "");
  if (title) l.title = title;
  l.innerHTML = `<span>${escapeHtml(label)}</span>`;
  let inp;
  if (options) {
    inp = document.createElement("select");
    for (const [v, t] of options) { const o = document.createElement("option"); o.value = v; o.textContent = t; if (String(v) === String(value)) o.selected = true; inp.appendChild(o); }
  } else {
    inp = document.createElement("input");
    inp.type = type;
    inp.value = value ?? "";
  }
  inp.onchange = () => onChange(inp.value);
  l.appendChild(inp);
  return l;
}

const numOrExpr = (s) => {
  const t = String(s).trim();
  if (t === "") return "";
  return /^-?\d*\.?\d+(e-?\d+)?$/i.test(t) ? Number(t) : t;
};

function renderMeta() {
  const el = $("#bs-meta");
  el.innerHTML = "";
  const p = S.program;
  const edit = (fn) => (v) => { pushHistory(); fn(v); markEdited(); changed(); };
  el.appendChild(field("name (camelCase)", p.name, edit((v) => { p.name = v.trim(); })));
  el.appendChild(field("version", p.version, edit((v) => { p.version = Math.max(1, parseInt(v, 10) || 1); }), { type: "number" }));
  el.appendChild(field("orientation", p.orientation || "fixed", edit((v) => { p.orientation = v; }), { options: [["fixed", "fixed (bed axes)"], ["tangent", "tangent (turns with the line)"]] }));
  el.appendChild(field("reach radiusMm", p.radiusMm ?? 10, edit((v) => { p.radiusMm = Number(v); }), { type: "number" }));
  el.appendChild(field("default gap along a line", p.defaultGap ?? 10, edit((v) => { p.defaultGap = Number(v); }), { type: "number" }));
  const src = { starter: "starter example", drawn: "your drawing", interpreted: "interpreted by the model", edited: "interpreted, then edited by you", library: "from the library (edited here)", proposed: "proposed after a print" }[S.source] || S.source;
  $("#bs-source").textContent = `· ${src}`;
}

function renameParamRefs(obj, from, to) {
  const re = new RegExp(`\\b${from}\\b`, "g");
  const walk = (v) => {
    if (typeof v === "string") return v.replace(re, to);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}

function renderParams() {
  const el = $("#bs-params");
  const params = S.program.params || {};
  const names = Object.keys(params);
  if (!names.length) { el.innerHTML = `<div class="bs-muted">none yet -- right-click a number in the inspector (or ƒ) to make it a param</div>`; }
  else {
    const t = document.createElement("table");
    t.innerHTML = `<tr><th>name</th><th>def</th><th>min</th><th>max</th><th>level</th><th>desc</th><th></th></tr>`;
    for (const n of names) {
      const s = params[n];
      const tr = document.createElement("tr");
      const cell = (key, w) => {
        const td = document.createElement("td");
        const i = document.createElement("input");
        i.value = key === "name" ? n : s[key] ?? "";
        if (w) i.style.width = w;
        i.onchange = () => {
          pushHistory();
          if (key === "name") {
            const nn = i.value.trim();
            if (!nn || nn === n || params[nn]) { changed(); return; }
            const next = {};
            for (const [k, v] of Object.entries(params)) next[k === n ? nn : k] = v;
            S.program.params = next;
            S.program.steps = renameParamRefs(S.program.steps, n, nn);
          } else if (key === "desc") s.desc = i.value;
          else s[key] = Number(i.value);
          markEdited();
          changed();
        };
        td.appendChild(i);
        return td;
      };
      tr.appendChild(cell("name"));
      tr.appendChild(cell("def", "4em")); tr.appendChild(cell("min", "4em")); tr.appendChild(cell("max", "4em"));
      const lv = document.createElement("td");
      const sel = document.createElement("select");
      for (const v of ["brush", "stroke"]) { const o = document.createElement("option"); o.value = v; o.textContent = v; if ((s.level || "brush") === v) o.selected = true; sel.appendChild(o); }
      sel.onchange = () => { pushHistory(); s.level = sel.value; changed(); };
      lv.appendChild(sel); tr.appendChild(lv);
      tr.appendChild(cell("desc"));
      const del = document.createElement("td");
      del.innerHTML = `<span class="del" style="color:#c00;cursor:pointer;">✕</span>`;
      del.onclick = () => {
        pushHistory();
        // replace references by the default value
        S.program.steps = renameParamRefs(S.program.steps, n, `(${s.def})`);
        delete params[n];
        changed();
      };
      tr.appendChild(del);
      t.appendChild(tr);
    }
    el.innerHTML = "";
    el.appendChild(t);
  }

  // preview values
  const vals = $("#bs-values");
  vals.innerHTML = "";
  const cv = currentValues();
  for (const n of names) {
    const s = params[n];
    const l = document.createElement("label");
    l.className = "bs-field";
    l.innerHTML = `<span>${escapeHtml(n)} = <b>${cv[n]}</b></span>`;
    const r = document.createElement("input");
    r.type = "range"; r.min = s.min; r.max = s.max; r.step = (s.max - s.min) / 100 || 0.01; r.value = cv[n];
    r.oninput = () => { S.values[n] = r2(Number(r.value)); l.querySelector("b").textContent = S.values[n]; recompute(); render(); renderGate(); };
    r.onchange = () => { saveState(); renderPanels(); };
    l.appendChild(r);
    vals.appendChild(l);
  }
  if (!names.length) vals.innerHTML = `<div class="bs-muted">(no params)</div>`;

  // sweep param options
  const sp = $k("sweepParam");
  const cur = S.ui.sweepParam;
  sp.innerHTML = `<option value="">(none: one row)</option>` + names.map((n) => `<option value="${n}"${n === cur ? " selected" : ""}>${n}</option>`).join("");
}

function stepSummary(st) {
  const v = (x) => (Array.isArray(x) ? `[${x.join(", ")}]` : String(x));
  switch (st.op) {
    case "travel": return `→ ${v(st.to)}`;
    case "move": return `${st.to ? `→ ${v(st.to)}` : `by ${v(st.by)}`}${st.e !== undefined ? ` e ${st.e}` : st.bead ? ` bead ${st.bead.w}×${st.bead.h}` : " dry"} f${st.f}`;
    case "dwell": return `${st.ms}ms`;
    case "retract": case "prime": return `${st.mm}mm${st.f ? ` f${st.f}` : ""}`;
    case "extrudeHere": return `e ${st.e} over ${st.ms}ms`;
    case "repeat": return `×${st.n}: ${st.steps?.length || 0} steps`;
    default: return "";
  }
}

function renderSteps() {
  const ol = $("#bs-steps");
  ol.innerHTML = "";
  S.program.steps.forEach((st, i) => {
    const li = document.createElement("li");
    if (i === S.selected) li.className = "sel";
    li.innerHTML = `<span class="bs-muted">${i + 1}</span><span class="op">${st.movement ? "▸ " : ""}${escapeHtml(st.op)}</span><span>${escapeHtml(stepSummary(st))}</span>${i ? '<span class="del" title="delete">✕</span>' : ""}`;
    li.onclick = (e) => {
      if (e.target.classList.contains("del")) { deleteStep(i); return; }
      selectStep(i); changed(false);
    };
    ol.appendChild(li);
  });
  const sel = ol.querySelector("li.sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });
  renderInspector();
}

function makeParamFrom(value, apply) {
  const name = prompt("Name for the new param (letters/digits, camelCase):");
  if (!name || !/^[a-zA-Z][A-Za-z0-9]*$/.test(name) || BUILTIN_OPTIONS.includes(name)) return;
  const v = Number(value);
  if (!Number.isFinite(v)) { aiNote("only a plain number can become a param"); return; }
  pushHistory();
  S.program.params = S.program.params || {};
  if (!S.program.params[name]) {
    const lo = v > 0 ? r2(v * 0.25) : r2(v - 5), hi = v > 0 ? r2(v * 3) : r2(v + 5);
    S.program.params[name] = { def: v, min: Math.min(lo, v), max: Math.max(hi, v), level: "brush", desc: "" };
  }
  apply(name);
  markEdited();
  changed();
}

function renderInspector() {
  const el = $("#bs-inspector");
  el.innerHTML = "";
  const st = S.program.steps[S.selected];
  if (!st) return;
  const box = document.createElement("div");
  box.className = "bs-inspector";
  box.innerHTML = `<div class="bs-muted">step ${S.selected + 1} · ${escapeHtml(st.op)} -- a number or an expression over the params</div>`;
  const g = document.createElement("div");
  g.className = "bs-fields";
  const setter = (obj, key, idx = null) => (raw) => {
    pushHistory();
    const v = numOrExpr(raw);
    if (idx === null) { if (v === "") delete obj[key]; else obj[key] = v; }
    else obj[key][idx] = v === "" ? 0 : v;
    markEdited();
    changed();
  };
  const num = (label, obj, key, idx = null) => {
    const val = idx === null ? obj[key] : obj[key][idx];
    const f = field(label, val, setter(obj, key, idx));
    const b = document.createElement("button");
    b.textContent = "ƒ"; b.title = "make this number a param";
    b.onclick = (e) => { e.preventDefault(); makeParamFrom(val, (name) => { if (idx === null) obj[key] = name; else obj[key][idx] = name; }); };
    f.querySelector("input").addEventListener("contextmenu", (e) => { e.preventDefault(); b.onclick(e); });
    const wrap = document.createElement("div");
    wrap.className = "bs-f";
    f.style.flex = "1";
    wrap.appendChild(f); wrap.appendChild(b);
    return wrap;
  };
  const vec = (key) => ["x", "y", "z"].forEach((a, i) => g.appendChild(num(`${key} ${a}`, st, key, i)));
  if (st.op === "travel") vec("to");
  if (st.op === "move") {
    vec(st.to ? "to" : "by");
    g.appendChild(num("f (mm/min)", st, "f"));
    const mode = st.e !== undefined ? "e" : st.bead ? "bead" : "dry";
    g.appendChild(field("extrusion", mode, (m) => {
      pushHistory();
      delete st.e; delete st.bead;
      if (m === "e") st.e = 0.2;
      if (m === "bead") st.bead = { w: 0.8, h: 0.3 };
      markEdited(); changed();
    }, { options: [["dry", "dry"], ["e", "filament mm (e)"], ["bead", "bead w × h"]] }));
    if (mode === "e") g.appendChild(num("e (filament mm)", st, "e"));
    if (mode === "bead") { g.appendChild(num("bead w (mm)", st.bead, "w")); g.appendChild(num("bead h (mm)", st.bead, "h")); }
  }
  if (st.op === "dwell") g.appendChild(num("ms", st, "ms"));
  if (st.op === "retract" || st.op === "prime") { g.appendChild(num("mm", st, "mm")); g.appendChild(num("f (blank = 900)", st, "f")); }
  if (st.op === "extrudeHere") { g.appendChild(num("e (filament mm)", st, "e")); g.appendChild(num("ms", st, "ms")); }
  if (st.op === "repeat") {
    g.appendChild(num("n", st, "n"));
    const ta = document.createElement("textarea");
    ta.className = "bs-json"; ta.style.height = "8em";
    ta.value = JSON.stringify(st.steps, null, 1);
    ta.onchange = () => { try { pushHistory(); st.steps = JSON.parse(ta.value); ta.classList.remove("bad"); changed(); } catch { ta.classList.add("bad"); } };
    const l = document.createElement("label"); l.className = "bs-field wide"; l.innerHTML = `<span>steps (JSON; i and n usable)</span>`; l.appendChild(ta);
    g.appendChild(l);
  }
  box.appendChild(g);
  if (st.op === "move") {
    const row = document.createElement("div");
    row.className = "bs-row";
    const b = document.createElement("span");
    b.className = "btn small";
    b.textContent = st.to ? "use relative (by)" : "use absolute (to)";
    b.onclick = () => {
      const ex = derived.steps?.find((s) => s.src.length === 1 && s.src[0] === S.selected);
      if (!ex) return;
      pushHistory();
      if (st.to) { st.by = ex.to.map((v, a) => r2(v - ex.from[a])); delete st.to; }
      else { st.to = ex.to.map(r2); delete st.by; }
      changed();
    };
    row.appendChild(b);
    box.appendChild(row);
  }
  el.appendChild(box);
}

function renderGate() {
  const el = $("#bs-gate");
  const c = derived.check;
  if (!c) { el.innerHTML = ""; return; }
  const errs = c.errors.length ? `<div class="bs-errs"><strong>errors -- the test print is blocked:</strong><ul>${c.errors.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const warns = c.warnings.length ? `<div class="bs-warns"><strong>warnings -- yours to judge:</strong><ul>${c.warnings.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const stats = c.stats ? `<div class="bs-muted">one stamp: ${c.stats.seconds}s · ${c.stats.filamentMm}mm filament · ${c.stats.retracts} retract(s) · reach x ${r2(c.stats.bbox.minX)}..${r2(c.stats.bbox.maxX)}, y ${r2(c.stats.bbox.minY)}..${r2(c.stats.bbox.maxY)}, z ${r2(c.stats.bbox.minZ)}..${r2(c.stats.bbox.maxZ)}mm</div>` : "";
  const badge = c.ok ? `<div class="bs-ok">✓ printable (checked at the defaults and every param corner)</div>` : `<div class="bs-notok">✗ ${c.errors.length} blocking issue(s)</div>`;
  el.innerHTML = badge + stats + errs + warns;
}

function renderNotes() {
  const el = $("#bs-notes");
  if (!S.notes.length) {
    el.className = "bs-muted";
    el.textContent = S.source === "drawn" ? "none -- this is exactly what you drew" : "none recorded";
    return;
  }
  el.className = "";
  el.innerHTML = `<ul class="bs-notes">${S.notes.map((n) => `<li>${escapeHtml(n.change)} -- <i>${escapeHtml(n.why)}</i>${n.ref ? ` <span class="ref">${escapeHtml(n.ref)}</span>` : ""}</li>`).join("")}</ul>` +
    (S.literal ? `<div class="bs-muted">Don't want these? "back to my drawing" restores the program as it was before the model changed it.</div>` : "");
}

function renderJson() {
  const ta = $("#bs-json");
  if (document.activeElement !== ta) { ta.value = JSON.stringify(S.program, null, 2); ta.classList.remove("bad"); }
}

function renderAi() {
  const el = $("#bs-ai");
  el.innerHTML = S.aiLog.slice(-6).map((m) => `<div class="msg"><span class="who">${escapeHtml(m.who)}</span>${escapeHtml(m.text)}</div>`).join("");
}
function aiNote(text, who = "page") {
  S.aiLog.push({ who, text });
  if (S.aiLog.length > 30) S.aiLog.shift();
  renderAi();
  saveState();
}

function renderModeUi() {
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
  $("#bs-freehand-controls").style.display = S.mode === "freehand" ? "" : "none";
  $("#bs-keys-freehand").style.display = S.mode === "freehand" ? "" : "none";
  $("#bs-keys-vector").style.display = S.mode === "vector" ? "" : "none";
  $("#bs-use-literal-btn").classList.toggle("disabled", !(S.literal && (S.source === "interpreted" || S.source === "edited")));
  $("#bs-interpret-btn").classList.toggle("disabled", S.source === "starter");
}

function renderPanels() {
  renderMeta();
  renderParams();
  renderSteps();
  renderGate();
  renderNotes();
  renderJson();
  renderModeUi();
  renderFilename();
  renderPromoteInfo();
}

let saveTimer = null;
function changed(full = true) {
  recompute();
  render();
  if (full) renderPanels();
  else { renderSteps(); renderGate(); renderMeta(); renderPen(); }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 200);
}

// ---------------------------------------------------------------- LLM --

let docs = {};
let debugLog = [];
try { debugLog = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || "[]"); } catch { debugLog = []; }
function logCall(rec) {
  debugLog.push(rec);
  while (debugLog.length > 40) debugLog.shift();
  try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLog)); } catch { debugLog = debugLog.slice(-10); }
}

async function loadDocs() {
  await Promise.all(DOC_PATHS.map(async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
    docs[p] = docText(p, await r.text());
  }));
}

function apiKey(provider) { return $(provider === "openai" ? "#bs-openai-key" : "#bs-anthropic-key").value; }

async function callModel(stage, userMessage) {
  const provider = $("#bs-provider").value, model = $("#bs-model").value, effort = $("#bs-effort").value;
  const cfg = STAGES[stage];
  const thinking = $("#bs-thinking").value === "on" && !!cfg.thinking;
  const rec = { at: new Date().toISOString(), stage, provider, model, effort, thinking, userMessage };
  try {
    let data;
    try {
      data = await callLlmDirect({
        provider, apiKey: apiKey(provider), model, systemPrompt: composeSystemPrompt(stage, { docs, material: S.ui.material }),
        messages: [{ role: "user", content: userMessage }], schema: cfg.schema, schemaName: cfg.schemaName,
        maxOutputTokens: cfg.maxOutputTokens, effort, thinking,
      });
    } catch (e) { rec.httpError = String(e.message || e); throw e; }
    const { text, refusal } = extractResponseOutput(data, provider);
    if (refusal) { rec.refusal = refusal; throw new Error(`the model declined: ${refusal}`); }
    if (!text) throw new Error("the model returned no text");
    rec.raw = text;
    if (data.usage) { rec.usage = data.usage; recordCost(data.usage, model); renderCostTracker(); }
    try { return { value: JSON.parse(text), errors: [], raw: text }; }
    catch (e) {
      rec.parseError = e.message;
      if (wasTruncated(data, provider)) throw new Error("the answer was cut off at the token limit -- try again");
      return { value: null, errors: [`not valid JSON: ${e.message}`], raw: text };
    }
  } finally { logCall(rec); }
}

let busy = false;
function setBusy(on, text = "") {
  busy = on;
  $("#bs-ai-status").textContent = text;
  document.querySelectorAll(".btn.ai").forEach((b) => b.classList.toggle("active", on));
}

function precheck() {
  const provider = $("#bs-provider").value;
  if (busy) return "a request is already running";
  if (!apiKey(provider)) return `enter your ${provider} API key under "model & material settings"`;
  if (!Object.keys(docs).length) return "the prompt docs have not loaded";
  return null;
}

/** Gate for a stage that returns a program: parseable, well-formed, and
 * free of blocking errors at every param corner. */
function programGate(extra) {
  return (value) => {
    const pr = parseProgramField(value?.program);
    if (pr.error) return [pr.error];
    const c = checkProgram(lib, pr.program, { material: S.ui.material });
    const errs = [...c.errors];
    if (extra) errs.push(...extra(pr.program));
    return errs;
  };
}

async function onInterpret() {
  const why = precheck() || (S.source === "starter" ? "draw something first" : null);
  if (why) { aiNote(why); return; }
  setBusy(true, "interpreting…");
  try {
    const draft = clone(S.program);
    const ctx = { intent: S.ui.intent, draft, strokes: strokeSummary(S.sketch.strokes), check: checkProgram(lib, draft, { material: S.ui.material }) };
    const res = await runGatedStage({
      stage: "interpret",
      compose: (repair) => composeUserMessage("interpret", ctx, repair),
      callModel,
      gate: programGate(),
      onProgress: ({ attempt, repairing }) => setBusy(true, repairing ? `fixing the program (attempt ${attempt + 1})…` : "interpreting…"),
    });
    const pr = res.value ? parseProgramField(res.value.program) : { error: "no answer" };
    if (!res.ok || pr.error) {
      aiNote(`could not produce a printable program after ${res.attempts.length} attempt(s):\n${(res.errors || []).slice(0, 4).join("\n")}`);
      return;
    }
    const program = pr.program;
    program.version = program.version || 1;
    pushHistory();
    S.literal = { program: draft };
    S.interpreted = { program: clone(program), notes: res.value.notes || [], chat: res.value.chat };
    S.program = program;
    S.playhead = null;
    S.values = {};
    S.notes = res.value.notes || [];
    S.source = "interpreted";
    S.selected = 1;
    aiNote(res.value.chat, "interpret");
    changed();
  } catch (e) { aiNote(String(e.message || e)); }
  finally { setBusy(false); }
}

async function onSuggestParams() {
  const why = precheck() || (validateProgramShape(S.program).length ? "fix the program's shape errors first" : null);
  if (why) { aiNote(why); return; }
  setBusy(true, "suggesting params…");
  try {
    const before = motionSignature(lib, S.program);
    const ctx = { intent: S.ui.intent, program: S.program, check: derived.check };
    const res = await runGatedStage({
      stage: "parameterize",
      compose: (repair) => composeUserMessage("parameterize", ctx, repair),
      callModel,
      gate: programGate((p) => {
        try { return compareMotion(before, motionSignature(lib, p)).map((d) => `motion changed: ${d} -- params must reproduce the drawing at their defaults`); }
        catch (e) { return [e.message]; }
      }),
      onProgress: ({ attempt, repairing }) => setBusy(true, repairing ? `fixing (attempt ${attempt + 1})…` : "suggesting params…"),
    });
    if (!res.ok) { aiNote(`no usable suggestion:\n${res.errors.slice(0, 4).join("\n")}`); return; }
    pushHistory();
    S.program = parseProgramField(res.value.program).program;
    S.values = {};
    S.notes = [...S.notes, ...(res.value.notes || [])];
    aiNote(res.value.chat, "params");
    changed();
  } catch (e) { aiNote(String(e.message || e)); }
  finally { setBusy(false); }
}

async function onReview() {
  const why = precheck();
  if (why) { aiNote(why); return; }
  setBusy(true, "reviewing…");
  try {
    const res = await runGatedStage({
      stage: "review", compose: (repair) => composeUserMessage("review", { intent: S.ui.intent, program: S.program, check: derived.check }, repair),
      callModel, gate: null, maxRepairs: 1,
    });
    if (!res.ok) { aiNote(res.errors.join("\n")); return; }
    const notes = (res.value.notes || []).map((n) => `• ${n.step}: ${n.observation}${n.suggestion ? ` → ${n.suggestion}` : ""}${n.ref ? ` [${n.ref}]` : ""}`).join("\n");
    aiNote(`${res.value.chat}${notes ? `\n\n${notes}` : ""}`, "review");
  } catch (e) { aiNote(String(e.message || e)); }
  finally { setBusy(false); }
}

// ------------------------------------------------------------ test print --

function testOptions() {
  const o = { ...currentValues(), azimuthDeg: Number(S.ui.optAz) || 0 };
  if (S.ui.optGap !== "" && Number(S.ui.optGap) > 0) o.gap = Number(S.ui.optGap);
  return o;
}

function calibration() {
  return S.ui.calMode === "test"
    ? { mode: "test", x: Number(S.ui.calX), band: Number(S.ui.calBand) }
    : { mode: "normal", y: Number(S.ui.calY) };
}

function currentFilename() {
  const desc = S.ui.fileDesc?.trim() || `${S.program.name}-v${S.program.version}`;
  return testFilename(desc, { testMode: S.ui.calMode === "test" });
}
function renderFilename() {
  $("#bs-filename").textContent = `→ test_print_gcode/${currentFilename()}  (timestamp taken when saved)`;
}

let lastBuild = null;
function onBuild() {
  const sweep = S.ui.sweepParam && S.ui.sweepValues.trim()
    ? { param: S.ui.sweepParam, values: S.ui.sweepValues.split(",").map((v) => Number(v.trim())).filter(Number.isFinite) }
    : null;
  if (!derived.check?.ok) { $("#bs-digest").innerHTML = `<div class="bs-notok">fix the program's errors first (column 2, "check")</div>`; lastBuild = null; return null; }
  const res = buildTestPrint(lib, S.program, {
    material: S.ui.material, calibration: calibration(),
    texture: { x0: Number(S.ui.texX), y: Number(S.ui.texY), length: Number(S.ui.texLen) },
    options: testOptions(), sweep,
  });
  const retracts = res.lines.filter((l) => /\bE-[0-9]/.test(l)).length;
  const budget = retractBudgetWarning(retracts);
  if (budget) res.warnings.push(budget);
  $("#raw-gcode-textarea").value = res.gcode;
  lastBuild = { res, key: programKey(S.program), options: testOptions(), sweep };
  const d = res.digest;
  const head = `<table class="bs-muted"><tr><td>lines</td><td>${d.lineCount}</td><td>stamps</td><td>${d.stamps}</td><td>eTotal</td><td>${d.eTotal}mm</td></tr>` +
    `<tr><td>negative-E</td><td colspan="5">${d.negE} (expected ${d.expectedNegE}) ${d.negEOk ? "✓" : "✗ MISMATCH"}</td></tr></table>`;
  const errs = res.errors.length ? `<div class="bs-errs"><strong>not safe to print:</strong><ul>${res.errors.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : `<div class="bs-ok">✓ layout, bounds and retract count verified</div>`;
  const warns = res.warnings.length ? `<div class="bs-warns"><ul>${res.warnings.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  $("#bs-digest").innerHTML = errs + head + warns +
    `<details class="bs-fold"><summary>first texture lines (digest)</summary><pre>${escapeHtml(d.textureHead.join("\n"))}</pre></details>`;
  $("#gcode-filename-input").value = currentFilename();
  return res;
}

async function onSaveTest() {
  if (!io.connected()) { $("#bs-digest").insertAdjacentHTML("afterbegin", `<div class="bs-notok">connect texture_docs first</div>`); return; }
  const res = onBuild();
  if (!res) return;
  if (res.errors.length) { $("#bs-digest").insertAdjacentHTML("afterbegin", `<div class="bs-notok">not saved: fix the errors above first</div>`); return; }
  const name = currentFilename();
  try {
    await io.writeText(`test_print_gcode/${name}`, res.gcode, null);
    S.lastTest = { filename: name, digest: digestText(res, `test_print_gcode/${name}`), key: programKey(S.program), version: S.program.version, name: S.program.name };
    saveState();
    $("#bs-digest").insertAdjacentHTML("afterbegin", `<div class="bs-ok">saved test_print_gcode/${escapeHtml(name)}</div>`);
    $("#gcode-filename-input").value = name;
    await refreshCalibration(true);
  } catch (e) {
    $("#bs-digest").insertAdjacentHTML("afterbegin", `<div class="bs-notok">${escapeHtml(String(e.message || e))}</div>`);
  }
}

// --------------------------------------------------------------- library --

async function refreshLibrary() {
  $("#bs-lib-status").textContent = `connected: ${io.folderName()}`;
  $("#bs-connect-btn").textContent = "reload library";
  LIB.files = {}; LIB.hashes = {};
  for (const f of Object.values(P.LIB_FILES)) {
    const t = await io.readText(f);
    if (t === null) throw new Error(`${f} is missing from ${io.folderName()}`);
    LIB.files[f] = t;
    LIB.hashes[f] = await io.hashText(t);
  }
  const sel = $("#bs-lib-open");
  const brushes = P.libraryBrushes(LIB.files[P.LIB_FILES.code]);
  sel.innerHTML = `<option value="">— ${brushes.length ? `${brushes.length} sketched brush(es)` : "none promoted yet"} —</option>` +
    brushes.map((b) => `<option value="${b.name}">${b.name} (v${b.version})</option>`).join("");
  await refreshCalibration(false);
  renderPromoteInfo();
}

async function refreshCalibration(afterSave) {
  try {
    const files = await io.listTestGcode();
    const cl = LIB.files[P.LIB_FILES.changelog] || "";
    const prop = proposeCalibration(files, cl);
    // After this page saved a normal-mode file, the "resume from" hint in
    // an older CHANGELOG entry no longer applies -- the newest file wins.
    if (afterSave && S.ui.calMode === "normal") prop.normal = { y: Number(S.ui.calY) - 5, source: "5mm below the file just saved" };
    S.ui.calY = prop.normal.y; S.ui.calX = prop.test.x; S.ui.calBand = prop.test.band;
    if (S.ui.calMode === "normal") S.ui.texY = prop.normal.y;
    $("#bs-cal-source").textContent = `normal: ${prop.normal.source} · test mode: ${prop.test.source}. Proposals only -- overwrite as needed.`;
    syncInputs();
    saveState();
  } catch (e) {
    $("#bs-cal-source").textContent = `could not read test_print_gcode/: ${e.message}`;
  }
}

/** Click: connect (or re-allow, or reload). Shift+click: pick a different
 * folder. */
async function onConnect(e) {
  try {
    const state = e?.shiftKey ? "none" : await io.restore();
    if (state === "needs-permission") await io.reconnect();
    else if (state === "none") await io.connect();
    await refreshLibrary();
  } catch (e) {
    if (e?.name === "AbortError") return;
    $("#bs-lib-status").textContent = String(e.message || e);
  }
}

function libraryLoad(name) {
  const p = P.libraryProgram(LIB.files[P.LIB_FILES.code] || "", name);
  if (!p) { aiNote(`could not read ${name}'s program from sketched_brushes.js`); return; }
  pushHistory();
  S.program = p; S.values = {}; S.source = "library"; S.notes = []; S.selected = 1;
  S.mode = "vector";
  changed();
  aiNote(`loaded ${name} v${p.version} from the library -- edits here become v${p.version + 1} when promoted`);
}

function renderPromoteInfo() {
  const el = $("#bs-promote-info");
  if (!io.connected() || !LIB.files[P.LIB_FILES.code]) { el.textContent = "connect texture_docs to promote"; return; }
  const libV = P.libraryVersion(LIB.files[P.LIB_FILES.code], S.program.name);
  const libP = libV ? P.libraryProgram(LIB.files[P.LIB_FILES.code], S.program.name) : null;
  const same = libP && programKey(libP) === programKey({ ...S.program, version: libP.version });
  const tested = S.lastTest && S.lastTest.key === programKey(S.program);
  el.innerHTML = [
    libV ? `library has <b>${escapeHtml(S.program.name)}</b> v${libV}${same ? " -- identical to this program" : ` -- promoting writes v${Math.max(libV + 1, S.program.version)}`}` : `<b>${escapeHtml(S.program.name)}</b> is not in the library yet -- promoting writes v${S.program.version}`,
    tested ? `test file for exactly this program: ${escapeHtml(S.lastTest.filename)}` : "no saved test file for exactly this program (the docs will say so)",
  ].join("<br>");
}

function renderDiffs(el, edits, newFiles) {
  const parts = [];
  for (const e of edits) {
    const h = P.hunk(e.before, e.after);
    const lines = [
      ...h.contextBefore.map((l) => `<span class="ctx">  ${escapeHtml(l)}</span>`),
      ...h.removed.map((l) => `<span class="rem">- ${escapeHtml(l)}</span>`),
      ...h.added.map((l) => `<span class="add">+ ${escapeHtml(l)}</span>`),
      ...h.contextAfter.map((l) => `<span class="ctx">  ${escapeHtml(l)}</span>`),
    ];
    parts.push(`<div class="file">${escapeHtml(e.path)} <span class="bs-muted">from line ${h.startLine}: +${h.added.length} / -${h.removed.length}</span></div><pre>${lines.join("")}</pre>`);
  }
  for (const f of newFiles) {
    const lines = f.text.split("\n");
    parts.push(`<div class="file">${escapeHtml(f.path)} <span class="bs-muted">new file, ${lines.length} lines</span></div><pre>${escapeHtml(lines.slice(0, 40).join("\n"))}${lines.length > 40 ? "\n…" : ""}</pre>`);
  }
  el.innerHTML = parts.join("");
}

async function onPreparePromotion() {
  const status = $("#bs-promote-status");
  $("#bs-write-btn").style.display = "none";
  LIB.pending = null;
  if (!io.connected()) { status.textContent = "connect texture_docs first"; return; }
  if (!derived.check?.ok) { status.textContent = "the program has blocking errors"; return; }
  const why = precheck();
  if (why) { status.textContent = why; return; }
  try {
    await refreshLibrary();
    const code = LIB.files[P.LIB_FILES.code];
    const name = S.program.name;
    // name collisions with the hand-written library
    const names = Object.values(P.exportNames(name));
    // (the page's `lib` was loaded at startup: a brush already in the
    // library then is in it under its own names, which is not a clash)
    const ownBlock = P.libraryVersion(code, name) > 0;
    const clash = ownBlock ? [] : names.filter((n) => n in lib);
    if (clash.length) { status.textContent = `the name "${name}" would shadow existing library exports: ${clash.join(", ")} -- rename the brush`; return; }

    const libV = P.libraryVersion(code, name);
    const program = clone(S.program);
    if (libV) {
      const libP = P.libraryProgram(code, name);
      if (libP && programKey(libP) === programKey({ ...program, version: libP.version })) { status.textContent = `v${libV} in the library is already identical to this program`; return; }
      if (program.version <= libV) program.version = libV + 1;
    }
    const tested = S.lastTest && S.lastTest.key === programKey(S.program) ? S.lastTest : null;
    const how = S.sketch.strokes.length ? "drawn freehand (and on the timeline)" : "drawn in the vector editor";
    const origin = { drawn: `${how}, printed as drawn`, interpreted: `${how}, interpreted by the model`, edited: `${how}, interpreted by the model, then edited by hand`, library: `edited from v${libV} on the page`, proposed: `proposed after printing v${libV}, then reviewed`, starter: "the page's starter example" }[S.source] || S.source;
    setBusy(true, "writing the documentation…");
    const res = await runGatedStage({
      stage: "document",
      compose: (repair) => composeUserMessage("document", {
        intent: S.ui.intent, version: program.version, program, notes: S.notes, check: derived.check,
        digest: tested ? tested.digest : "", previous: libV ? { program: P.libraryProgram(code, name), docs: "" } : null,
      }, repair),
      callModel,
      gate: (v) => ["summary", "description", "sequence", "changes"].filter((k) => !String(v?.[k] || "").trim()).map((k) => `"${k}" is empty`),
      maxRepairs: 1,
    });
    if (!res.ok) { status.textContent = `documentation failed: ${res.errors.join("; ")}`; return; }
    const sketch = { mode: S.sketch.strokes.length ? "freehand" : "vector", intent: S.ui.intent, strokes: S.sketch.strokes, drawnBeforeInterpretation: S.literal?.program ?? null, notes: S.notes, date: today() };
    const out = P.buildPromotion({
      files: LIB.files, program, doc: res.value, intent: S.ui.intent, origin, notes: S.notes,
      digest: tested?.digest || "", testFile: tested?.filename || "", sketch, date: today(),
    });
    LIB.pending = { ...out, program };
    renderDiffs($("#bs-diffs"), out.edits, out.newFiles);
    status.textContent = `review the changes below, then write them (CHANGELOG #${out.changelogNumber})`;
    $("#bs-write-btn").style.display = "";
  } catch (e) { status.textContent = String(e.message || e); }
  finally { setBusy(false); }
}

async function writePending(pending, statusEl) {
  const written = [];
  try {
    for (const f of pending.newFiles) { await io.writeText(f.path, f.text, null); written.push(f.path); }
    for (const e of pending.edits) { await io.writeText(e.path, e.after, LIB.hashes[e.path]); written.push(e.path); }
    statusEl.textContent = `written: ${written.join(", ")}`;
    return true;
  } catch (e) {
    statusEl.textContent = `${written.length ? `written: ${written.join(", ")}. ` : ""}STOPPED: ${e.message || e}`;
    return false;
  } finally {
    await refreshLibrary().catch(() => {});
  }
}

async function onWritePromotion() {
  const p = LIB.pending;
  if (!p) return;
  $("#bs-write-btn").style.display = "none";
  const ok = await writePending(p, $("#bs-promote-status"));
  if (ok) {
    S.program.version = p.program.version;
    S.source = "library";
    aiNote(`${p.program.name} v${p.program.version} is in the library: ${p.program.name}(), ${P.exportNames(p.program.name).freeform}(), ${P.exportNames(p.program.name).brush}() -- CHANGELOG #${p.changelogNumber}`);
    changed();
  }
  LIB.pending = null;
}

async function onFeedback() {
  const status = $("#bs-feedback-status");
  $("#bs-feedback-write-btn").style.display = "none";
  $("#bs-load-proposed-btn").style.display = "none";
  LIB.pendingFeedback = null; LIB.proposed = null;
  if (!io.connected()) { status.textContent = "connect texture_docs first"; return; }
  const report = S.ui.report.trim();
  if (!report) { status.textContent = "write what happened on the printer first"; return; }
  const why = precheck();
  if (why) { status.textContent = why; return; }
  try {
    await refreshLibrary();
    const code = LIB.files[P.LIB_FILES.code];
    const name = S.program.name;
    const libV = P.libraryVersion(code, name);
    if (!libV) { status.textContent = `"${name}" is not in the library -- promote it before recording a print`; return; }
    const printed = P.libraryProgram(code, name);
    const testFile = S.lastTest?.name === name && S.lastTest.version === libV ? S.lastTest.filename : "";
    setBusy(true, "recording the print…");
    const res = await runGatedStage({
      stage: "feedback",
      compose: (repair) => composeUserMessage("feedback", { report, program: printed, testFile, docsSoFar: "" }, repair),
      callModel,
      gate: (v) => {
        if (!v?.program?.trim()) return [];
        const errs = programGate((p) => [
          ...(p.name !== name ? [`keep the name "${name}"`] : []),
          ...(p.version !== libV + 1 ? [`the proposed version must be ${libV + 1}`] : []),
        ])(v);
        return errs;
      },
    });
    if (!res.ok) { status.textContent = `failed: ${res.errors.slice(0, 3).join("; ")}`; return; }
    const proposed = res.value.program?.trim() ? parseProgramField(res.value.program).program : null;
    const out = P.buildFeedback({ files: LIB.files, program: printed, report, status: res.value.status, analysis: res.value.analysis, testFile, proposed, date: today() });
    LIB.pendingFeedback = out;
    LIB.proposed = proposed ? { program: proposed, notes: res.value.notes || [] } : null;
    renderDiffs($("#bs-feedback-diffs"), out.edits, out.newFiles);
    status.textContent = `review, then write (CHANGELOG #${out.changelogNumber})`;
    $("#bs-feedback-write-btn").style.display = "";
    if (proposed) $("#bs-load-proposed-btn").style.display = "";
    aiNote(res.value.chat, "feedback");
  } catch (e) { status.textContent = String(e.message || e); }
  finally { setBusy(false); }
}

async function onWriteFeedback() {
  const p = LIB.pendingFeedback;
  if (!p) return;
  $("#bs-feedback-write-btn").style.display = "none";
  if (await writePending(p, $("#bs-feedback-status"))) { S.ui.report = ""; syncInputs(); saveState(); }
  LIB.pendingFeedback = null;
}

function onLoadProposed() {
  if (!LIB.proposed) return;
  pushHistory();
  S.program = clone(LIB.proposed.program);
  S.notes = LIB.proposed.notes;
  S.values = {};
  S.source = "proposed";
  S.mode = "vector";
  changed();
  aiNote(`loaded the proposed v${S.program.version} -- test it, then promote it`);
}

// ---------------------------------------------------------------- inputs --

function syncInputs() {
  document.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.dataset.k;
    if (!(k in S.ui)) return;
    if (el.type === "checkbox") el.checked = !!S.ui[k];
    else if (document.activeElement !== el) el.value = S.ui[k] ?? "";
  });
}

function bindInputs() {
  document.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.dataset.k;
    const handler = () => {
      S.ui[k] = el.type === "checkbox" ? el.checked : el.value;
      if (k === "zoom" || k === "az") { render(); }
      if (k === "material" || k === "showLiteral") changed();
      if (k === "showStrokes") render();
      if (k === "calMode" && el.value === "normal") S.ui.texY = S.ui.calY;
      renderFilename();
      renderPromoteInfo();
      saveState();
    };
    el.addEventListener(el.tagName === "TEXTAREA" || el.type === "text" ? "input" : "change", handler);
  });
}

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
}

function onKeyDown(e) {
  if (isTyping()) return;
  if ($("#motion-keyboard-control")?.checked) return;   // script.js owns the keys then
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) { e.preventDefault(); undo(); return; }
  if (k === "," || k === "<") { stepPlayhead(-1); return; }
  if (k === "." || k === ">") { stepPlayhead(1); return; }
  if (k === "Home") { e.preventDefault(); setPlayhead(0); syncSelectionToPlayhead(); render(); renderSteps(); saveSoon(); return; }
  if (k === "End") { e.preventDefault(); setPlayhead(null); syncSelectionToPlayhead(); render(); renderSteps(); saveSoon(); return; }
  if (k === "[" || k === "]") { S.ui.az = String(((Number(S.ui.az) + (k === "]" ? 15 : -15)) % 360 + 360) % 360); syncAz(); render(); saveState(); return; }
  if (S.mode === "freehand") {
    if (/^[0-5]$/.test(k)) { flow = Number(k); renderPen(); return; }
    if (k === "w" || k === "W" || k === "s" || k === "S") { keysDown.add(k.toLowerCase()); e.preventDefault(); return; }
    if (k === "r" || k === "R") { freehandEvent("retract"); return; }
    if (k === "p" || k === "P") { freehandEvent("prime"); return; }
    if (k === "Escape") { endStroke(true); return; }
    if (!live && eventKey(k)) return;
    return;
  }
  if (vectorKey(e)) e.preventDefault();
}

function syncAz() {
  const sel = $k("az");
  if (![...sel.options].some((o) => o.value === String(S.ui.az))) {
    const o = document.createElement("option"); o.value = String(S.ui.az); o.textContent = `${S.ui.az}°`; sel.appendChild(o);
  }
  sel.value = String(S.ui.az);
}

// ------------------------------------------------------------------- init --

function initBrushSketch() {
  views.top = setupCanvas("#bs-top", 340, 340);
  views.side = setupCanvas("#bs-side", 340, 340);
  views.timeline = setupCanvas("#bs-timeline", 688, 142);

  for (const which of ["top", "side"]) {
    const c = views[which].c;
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      if (S.mode === "freehand") beginStroke(which, e);
      else vectorPointerDown(which, e);
    });
    c.addEventListener("pointermove", (e) => {
      if (live && livePointer?.view === which) { const r = c.getBoundingClientRect(); livePointer.px = e.clientX - r.left; livePointer.py = e.clientY - r.top; }
      if (drag) vectorPointerMove(e);
    });
    c.addEventListener("pointerup", () => {
      if (S.mode === "freehand") endStroke();
      if (drag) { drag = null; changed(); }
    });
    c.addEventListener("wheel", (e) => {
      if (S.mode !== "freehand") return;
      e.preventDefault();
      flow = Math.max(0, Math.min(5, flow + (e.deltaY < 0 ? 1 : -1)));
      renderPen();
    }, { passive: false });
  }
  const tc = views.timeline.c;
  tc.addEventListener("pointerdown", onTimelineDown);
  tc.addEventListener("pointermove", onTimelineMove);
  tc.addEventListener("pointerup", onTimelineUp);
  tc.addEventListener("pointercancel", onTimelineUp);
  tc.addEventListener("wheel", onTimelineWheel, { passive: false });
  tc.addEventListener("dblclick", () => { S.tlWin = null; render(); saveState(); });

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", (e) => keysDown.delete(e.key.toLowerCase()));

  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    S.mode = b.dataset.mode;
    endStroke(true);
    changed();
  }));
  $("#bs-new-btn").addEventListener("click", () => {
    if (!confirm("Start a new brush? This clears the sketch and the program (the library is not touched).")) return;
    const ui = S.ui;
    S = defaultState();
    S.ui = { ...ui, intent: "", fileDesc: "", report: "", sweepParam: "", sweepValues: "" };
    resetSketch();
    syncInputs();
    changed();
  });
  $("#bs-undo-stroke").addEventListener("click", undo);
  $("#bs-clear-sketch").addEventListener("click", () => {
    if (!confirm("Clear the drawing and start from the starter example? (The library is not touched.)")) return;
    resetSketch();
    changed();
  });
  $("#bs-interpret-btn").addEventListener("click", onInterpret);
  $("#bs-use-literal-btn").addEventListener("click", () => {
    if (!S.literal) return;
    pushHistory();
    S.program = clone(S.literal.program); S.source = "drawn"; S.notes = []; S.values = {}; S.playhead = null;
    changed();
  });
  $("#bs-add-param").addEventListener("click", () => {
    const name = prompt("Param name (letters/digits, camelCase):");
    if (!name || !/^[a-zA-Z][A-Za-z0-9]*$/.test(name) || BUILTIN_OPTIONS.includes(name)) return;
    pushHistory();
    S.program.params = { ...(S.program.params || {}), [name]: { def: 1, min: 0, max: 10, level: "brush", desc: "" } };
    changed();
  });
  $("#bs-suggest-params").addEventListener("click", onSuggestParams);
  $("#bs-review").addEventListener("click", onReview);
  $("#bs-json-apply").addEventListener("click", () => {
    const ta = $("#bs-json");
    try {
      const p = JSON.parse(ta.value);
      pushHistory();
      S.program = p; markEdited();
      $("#bs-json-status").textContent = "applied";
      ta.classList.remove("bad");
      changed();
    } catch (e) { ta.classList.add("bad"); $("#bs-json-status").textContent = e.message; }
  });

  $("#bs-build-btn").addEventListener("click", onBuild);
  $("#bs-save-test-btn").addEventListener("click", onSaveTest);
  $("#bs-connect-btn").addEventListener("click", onConnect);
  $("#bs-lib-open").addEventListener("change", (e) => { if (e.target.value) libraryLoad(e.target.value); e.target.value = ""; });
  $("#bs-promote-btn").addEventListener("click", onPreparePromotion);
  $("#bs-write-btn").addEventListener("click", onWritePromotion);
  $("#bs-feedback-btn").addEventListener("click", onFeedback);
  $("#bs-feedback-write-btn").addEventListener("click", onWriteFeedback);
  $("#bs-load-proposed-btn").addEventListener("click", onLoadProposed);

  $("#bs-openai-key").addEventListener("change", () => saveApiKeyFrom("openai", "bs-openai-key"));
  $("#bs-anthropic-key").addEventListener("change", () => saveApiKeyFrom("anthropic", "bs-anthropic-key"));
  $("#bs-provider").addEventListener("change", () => updateModelOptions("bs-provider", "bs-model"));
  $("#bs-save-log-btn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(debugLog, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `brush-sketch-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  });
  $("#bs-clear-log-btn").addEventListener("click", () => { if (confirm("Clear the debug log?")) { debugLog = []; localStorage.removeItem(DEBUG_LOG_KEY); } });
  updateModelOptions("bs-provider", "bs-model");
  loadApiKeyInto("openai", "bs-openai-key");
  loadApiKeyInto("anthropic", "bs-anthropic-key");
  renderCostTracker();

  // restore the pen to where the drawing left off
  const last = S.sketch.strokes[S.sketch.strokes.length - 1]?.samples?.slice(-1)[0];
  if (last) { pen3.x = last.x; pen3.y = last.y; pen3.z = last.z; }

  bindInputs();
  syncInputs();
  syncAz();
  changed();
  renderAi();

  loadDocs().catch((e) => aiNote(`could not load the prompt docs: ${e.message}`));
  io.restore().then(async (st) => {
    if (st === "connected") await refreshLibrary();
    else if (st === "needs-permission") { $("#bs-lib-status").textContent = `${io.folderName()} -- click to re-allow access`; $("#bs-connect-btn").textContent = "re-allow texture_docs"; }
    else if (!io.supported()) $("#bs-lib-status").textContent = "this browser has no folder access -- use Chrome or Edge";
  }).catch((e) => { $("#bs-lib-status").textContent = String(e.message || e); });
}

window.initBrushSketch = initBrushSketch;
window.dispatchEvent(new Event("brush-sketch-ready"));
