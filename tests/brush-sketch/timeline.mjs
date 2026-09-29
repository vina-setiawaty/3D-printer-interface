// brush-sketch: editing by time -- the playhead (insert at a moment) and
// painting the Z lane over what is already drawn.
//
//   node tests/brush-sketch/timeline.mjs

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SE = join(here, "../../sewingeditor");
const lib = await import(pathToFileURL(join(SE, "texture_docs/texture_functions.js")).href);
const TL = await import(pathToFileURL(join(SE, "brush-sketch/timeline-edit.js")).href);

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// a 4mm extruding move along +x at 240mm/min = 1s, then a 1s dwell
const base = () => ({
  name: "t", params: { d: { def: 1, min: 0.5, max: 2 } },
  steps: [
    { op: "travel", to: [0, 0, 0.2] },
    { op: "prime", mm: 1.3 },
    { op: "move", to: [4, 0, 0.2], e: 0.4, f: 240 },
    { op: "dwell", ms: 1000 },
    { op: "retract", mm: 1.3 },
  ],
});
const P = (p) => lib.resolveSketchParams(p, {});

test("timing: top-level spans and the nozzle position at a moment", () => {
  const T = TL.timing(lib, base(), {});
  const prime = 1.3 / 900 * 60;
  assert.ok(Math.abs(T.spans[2].t0 - prime) < 1e-9 && Math.abs(T.spans[2].t1 - (prime + 1)) < 1e-9);
  assert.deepEqual(TL.positionAt(T.steps, T.times, prime + 0.25).map((v) => +v.toFixed(3)), [1, 0, 0.2]);
  assert.deepEqual(TL.positionAt(T.steps, T.times, 99), [4, 0, 0.2]);
});

test("splitAt cuts a move in time, e split proportionally", () => {
  const T = TL.timing(lib, base(), {});
  const t = T.spans[2].t0 + 0.25;
  const s = TL.splitAt(lib, base(), {}, t);
  assert.equal(s.index, 3);
  assert.deepEqual(s.program.steps[2], { op: "move", to: [1, 0, 0.2], e: 0.1, f: 240 });
  assert.deepEqual(s.program.steps[3], { op: "move", to: [4, 0, 0.2], e: 0.3, f: 240 });
  // splitting doesn't change what is printed
  const a = lib.expandSketchProgram(base(), {}), b = lib.expandSketchProgram(s.program, {});
  assert.ok(Math.abs(a.reduce((x, y) => x + (y.e || 0), 0) - b.reduce((x, y) => x + (y.e || 0), 0)) < 1e-9);
});

test("splitAt cuts a dwell; refuses a param-driven step (places after it)", () => {
  const T = TL.timing(lib, base(), {});
  const s = TL.splitAt(lib, base(), {}, T.spans[3].t0 + 0.4);
  assert.deepEqual([s.program.steps[3].ms, s.program.steps[4].ms], [400, 600]);
  const p = base(); p.steps[2].to = ["4*d", 0, 0.2];
  const s2 = TL.splitAt(lib, p, P(p), T.spans[2].t0 + 0.5);
  assert.equal(s2.index, 3);
  assert.match(s2.note, /can't be cut/);
  assert.equal(s2.program.steps.length, 5);
});

test("insertAt mid-move: stroke joined by a dry move, then a dry move back so the rest is unchanged", () => {
  const T = TL.timing(lib, base(), {});
  const stroke = [{ op: "travel", to: [2, 2, 0.2] }, { op: "move", to: [2, 3, 0.2], bead: { w: 0.8, h: 0.3 }, f: 300 }];
  const r = TL.insertAt(lib, base(), {}, T.spans[2].t0 + 0.5, stroke);
  const ops = r.program.steps.map((s) => `${s.op}${s.to ? `(${s.to.join(",")})` : ""}`);
  assert.deepEqual(ops, ["travel(0,0,0.2)", "prime", "move(2,0,0.2)", "move(2,2,0.2)", "move(2,3,0.2)", "move(2,0,0.2)", "move(4,0,0.2)", "dwell", "retract"]);
  assert.equal(r.returned, true);
  assert.deepEqual([r.first, r.last], [3, 5]);
});

test("insertAt the end: appended, no dry move back; an event at a moment", () => {
  const r = TL.insertAt(lib, base(), {}, null, [{ op: "travel", to: [4, 0, 0.2] }, { op: "move", to: [4, 0, 2], e: 0.2, f: 120 }]);
  assert.deepEqual(r.program.steps.slice(-1), [{ op: "move", to: [4, 0, 2], e: 0.2, f: 120 }]);
  assert.equal(r.returned, false);
  const T = TL.timing(lib, base(), {});
  const d = TL.insertAt(lib, base(), {}, T.spans[2].t0 + 0.5, [{ op: "dwell", ms: 300 }]);
  assert.deepEqual(d.program.steps.slice(2, 5).map((s) => s.op), ["move", "dwell", "move"]);
  assert.equal(d.returned, false);
});

test("paintZ over a drawn move: cut at the painted corners, heights set, dwell untouched", () => {
  const T = TL.timing(lib, base(), {});
  const t0 = T.spans[2].t0, t1 = T.spans[2].t1;
  // a tent: 0.2 -> 1.2 at the middle -> 0.2, plus hand jitter
  const samples = [];
  for (let k = 0; k <= 40; k++) {
    const t = t0 + (k / 40) * (t1 - t0);
    samples.push({ t, z: 0.2 + 1.0 * (1 - Math.abs(k - 20) / 20) + (k % 2 ? 0.01 : -0.01) });
  }
  const r = TL.paintZ(lib, base(), {}, samples);
  assert.deepEqual(r.skipped, []);
  const moves = r.program.steps.filter((s) => s.op === "move");
  assert.equal(moves.length, 2, "jitter under 0.05mm is ignored: one corner, two moves");
  assert.ok(Math.abs(moves[0].to[0] - 2) < 0.01 && Math.abs(moves[0].to[2] - 1.2) < 0.02, JSON.stringify(moves[0]));
  assert.ok(Math.abs(moves[1].to[2] - 0.2) < 0.02);
  assert.equal(r.program.steps.find((s) => s.op === "dwell").ms, 1000);
  assert.ok(Math.abs(moves[0].e + moves[1].e - 0.4) < 1e-9, "same filament");
});

test("paintZ skips moves whose height is a param", () => {
  const p = base(); p.steps[2].to = [4, 0, "0.2*d"];
  const T = TL.timing(lib, p, P(p));
  const r = TL.paintZ(lib, p, P(p), [{ t: T.spans[2].t0, z: 1 }, { t: T.spans[2].t1, z: 1 }]);
  assert.deepEqual(r.skipped, ["step 3"]);
});

console.log("channels (XY and Z reshape a movement; they never prolong it)");

const total = (p) => TL.timing(lib, p, P(p)).total;
const filament = (p) => lib.expandSketchProgram(p, P(p)).reduce((a, s) => a + (s.e || 0), 0);
// a flat 6mm drag along x at the bed, bead-based, then a retract and a vertical pull
const drag = () => ({
  name: "t", params: {},
  steps: [
    { op: "travel", to: [-3, 0, 0.2] }, { op: "prime", mm: 1.3 },
    { op: "move", to: [3, 0, 0.2], bead: { w: 0.8, h: 0.3 }, f: 360 },
    { op: "retract", mm: 1.3 },
    { op: "move", to: [3, 0, 3.2], e: 0.5, f: 120 },
  ],
});

test("which movement a stroke reshapes: inside, just before, or the last one", () => {
  const p = drag(), T = TL.timing(lib, p, {});
  assert.deepEqual([TL.movementAt(p, T, null).first, TL.movementAt(p, T, null).last], [4, 4], "at the end: the last movement");
  const mid = (T.spans[2].t0 + T.spans[2].t1) / 2;
  const m = TL.movementAt(p, T, mid);
  assert.equal(m.first, 2); assert.ok(Math.abs(m.ta - mid) < 1e-9, "inside: from the playhead on");
  assert.equal(TL.movementAt(p, T, T.spans[3].t0 + 0.01).first, 2, "in the retract between: the one just before");
});

test("SIDE by position: a hump over x -1..1 raises only that part; timing and filament kept", () => {
  const p = drag(), T = TL.timing(lib, p, {});
  const hump = [];
  for (let k = 0; k <= 20; k++) { const u = -1 + k * 0.1; hump.push({ t: k * 16, u, z: 0.2 + (1 - Math.abs(u)) }); }
  const r = TL.overlayZ(lib, p, {}, T.spans[2].t0 + 0.001, hump, [1, 0]);
  assert.equal(r.mode, "position");
  const moves = r.program.steps.filter((s) => s.op === "move").slice(0, -1);   // the drag, now in pieces
  const top = moves.reduce((a, s) => (s.to[2] > a.to[2] ? s : a));
  assert.deepEqual([top.to[0], top.to[2]], [0, 1.2], "the peak sits at x=0");
  assert.ok(moves.every((s) => s.to[1] === 0), "XY untouched");
  assert.ok(moves.filter((s) => s.to[0] <= -1 || s.to[0] >= 1.001).every((s) => s.to[2] === 0.2), "outside the hump: still on the bed");
  assert.ok(Math.abs(total(r.program) - total(p)) < 0.01, `time ${total(p)} -> ${total(r.program)}`);
  assert.ok(Math.abs(filament(r.program) - filament(p)) < 1e-3);
  assert.equal(r.program.steps.at(-1).to[2], 3.2, "the pull after it is untouched");
});

test("SIDE on a vertical pull (no sideways extent) falls back to time", () => {
  const p = drag();
  const s = [{ t: 0, u: 3, z: 0.2 }, { t: 500, u: 3.1, z: 5 }, { t: 1000, u: 3, z: 2 }];
  const r = TL.overlayZ(lib, p, {}, null, s, [1, 0]);
  assert.equal(r.mode, "time");
  const last = r.program.steps.filter((x) => x.op === "move").at(-1);
  assert.equal(last.to[2], 2);
  assert.ok(Math.abs(total(r.program) - total(p)) < 0.01);
});

test("TOP stretched over a vertical pull: it leans and curves; height, timing, filament kept", () => {
  const p = drag();
  // an L: 2mm along +x, then 1mm along +y, drawn at an even pace
  const s = [];
  for (let k = 0; k <= 20; k++) s.push({ t: k * 20, x: 10 + k * 0.1, y: 5 });
  for (let k = 1; k <= 10; k++) s.push({ t: 400 + k * 20, x: 12, y: 5 + k * 0.1 });
  const r = TL.overlayXY(lib, p, {}, null, s);
  const pull = r.program.steps.slice(4).filter((x) => x.op === "move");
  assert.equal(pull.length, 2, "cut at the L's corner");
  assert.deepEqual(pull[0].to.map((v) => +v.toFixed(2)), [5, 0, 2.2], "corner at 2/3 of the pull: +2mm x, 2/3 of the way up");
  assert.deepEqual(pull[1].to.map((v) => +v.toFixed(2)), [5, 1, 3.2], "ends +2x +1y from where it started, at the same height");
  assert.ok(Math.abs(total(r.program) - total(p)) < 0.01);
  assert.ok(Math.abs(filament(r.program) - filament(p)) < 1e-3);
  assert.deepEqual(r.program.steps[2].to, [3, 0, 0.2], "the drag before it is untouched");
});

test("a `movement` label separates back-to-back movements; splitting keeps it on the first half only", () => {
  const p = drag();
  p.steps.splice(3, 1);                              // no retract: line and pull back to back
  p.steps[3].movement = "pull";
  const T = TL.timing(lib, p, {});
  assert.deepEqual([TL.movementAt(p, T, null).first, TL.movementAt(p, T, null).last], [3, 3], "the pull alone");
  const s = TL.splitAt(lib, p, {}, (T.spans[3].t0 + T.spans[3].t1) / 2);
  assert.equal(s.program.steps[3].movement, "pull");
  assert.equal(s.program.steps[4].movement, undefined);
  assert.deepEqual(lib.expandSketchProgram(p, {}).map((x) => x.op), ["travel", "prime", "move", "move"], "printing ignores the label");
});

test("the Z lane keeps timing too now", () => {
  const p = drag(), T = TL.timing(lib, p, {});
  const r = TL.paintZ(lib, p, {}, [{ t: T.spans[2].t0, z: 0.2 }, { t: (T.spans[2].t0 + T.spans[2].t1) / 2, z: 1.5 }, { t: T.spans[2].t1, z: 0.2 }]);
  assert.ok(Math.abs(total(r.program) - total(p)) < 0.01);
  assert.ok(Math.abs(filament(r.program) - filament(p)) < 1e-3);
});

console.log(`\n${n} passed`);
