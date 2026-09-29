// brush-sketch: the library runtime (texture_docs/sketched_brushes.js) and
// the gate (brush-sketch/checks.js).
//
//   node tests/brush-sketch/runtime-and-checks.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SE = join(here, "../../sewingeditor");
const lib = await import(pathToFileURL(join(SE, "texture_docs/texture_functions.js")).href);
const C = await import(pathToFileURL(join(SE, "brush-sketch/checks.js")).href);

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const comma = () => ({
  name: "commaDot", version: 1, orientation: "tangent", radiusMm: 8, defaultGap: 6,
  params: { diameter: { def: 2, min: 0.8, max: 3, level: "brush" }, tailLen: { def: 3, min: 0, max: 5, level: "brush" } },
  steps: [
    { op: "travel", to: [0, 0, 0.2] }, { op: "prime", mm: 4 },
    { op: "move", to: [0, 0, "0.2+diameter/2"], e: "0.02*diameter^3", f: 120 }, { op: "dwell", ms: 1500 },
    { op: "move", to: ["-tailLen", 0, 0.3], bead: { w: 0.8, h: 0.3 }, f: 200 }, { op: "retract", mm: 4 },
    { op: "move", to: ["-tailLen-1", 0, 1.0], f: 600 },
  ],
});

console.log("runtime");

test("the circular import loads from either end", () => {
  // A fresh process per entry point: module caching would hide a TDZ
  // error in whichever order was not tried first.
  for (const entry of ["texture_functions.js", "sketched_brushes.js"]) {
    const url = pathToFileURL(join(SE, "texture_docs", entry)).href;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(url)}); console.log(typeof m.freeformSketchDotted, typeof m.SKETCH_BRUSHES);`]).toString().trim();
    assert.equal(out, "function object", entry);
  }
  assert.equal(typeof lib.stampSketch, "function");
  assert.equal(typeof lib.blobDot, "function", "the hand-written library is still exported");
});

test("expressions: params, i/n, functions; anything else is rejected", () => {
  assert.equal(lib.evalSketchValue("2*d + max(1, i)", { d: 1.5, i: 3 }), 6);
  assert.equal(lib.evalSketchValue("-2^2", {}), -4);
  assert.ok(Math.abs(lib.evalSketchValue("cos(pi)", {}) + 1) < 1e-12);
  assert.throws(() => lib.evalSketchValue("process.exit(1)", {}), /bad number|unexpected|unknown/);
  assert.throws(() => lib.evalSketchValue("constructor", {}), /unknown name/);
  assert.throws(() => lib.evalSketchValue("q + 1", { d: 1 }), /unknown name "q"/);
  assert.throws(() => lib.evalSketchValue("1/0", {}), /Infinity/);
});

test("expand: to / by / bead / repeat, with source paths", () => {
  const p = {
    name: "t", params: { r: { def: 1, min: 0.5, max: 2 } },
    steps: [
      { op: "travel", to: [0, 0, 0.2] },
      { op: "move", by: [2, 0, 0], bead: { w: 0.8, h: 0.2 }, f: 300 },
      { op: "repeat", n: 4, steps: [{ op: "move", to: ["r*cos(2*pi*(i+1)/n)", "r*sin(2*pi*(i+1)/n)", 1], f: 600 }] },
    ],
  };
  const s = lib.expandSketchProgram(p, lib.resolveSketchParams(p, { r: 2 }));
  assert.equal(s.length, 6);
  assert.deepEqual(s[1].to, [2, 0, 0.2]);
  assert.ok(Math.abs(s[1].e - lib.eRate(0.8, 0.2) * 2) < 1e-12, "bead e = eRate x length");
  assert.deepEqual(s[5].src, [2, 3, 0]);
  assert.ok(Math.abs(s[5].to[0] - 2) < 1e-9 && Math.abs(s[5].to[1]) < 1e-9, "repeat i/n reach the last point of the circle");
  assert.throws(() => lib.expandSketchProgram({ steps: [{ op: "move", to: [0, 0, 1], f: 100 }] }, {}), /start with a travel/);
  assert.throws(() => lib.expandSketchProgram({ steps: [{ op: "travel", to: [0, 0, 1] }, { op: "travel", to: [0, 0, 1] }] }, {}), /only allowed as the very first/);
});

test("emit: prime takes the one-time start bonus; tangent + azimuth rotate the frame", () => {
  const em = new lib.Emitter();
  em.header();
  const start = em.lines.length;
  lib.freeformSketchDotted(em, comma(), (t) => 50 + t, () => 60, 0, 6, { azimuthDeg: 90 });
  const L = em.lines.slice(start);
  const primes = L.filter((l) => /^G1 E4\.\d+ F900$/.test(l));
  assert.equal(primes[0], "G1 E4.3000 F900", "first prime of the element carries LINE_START_PRIME_MM");
  assert.equal(primes[1], "G1 E4.0000 F900", "later primes don't");
  // tangent 0deg + offset 90deg: the tail (local -x) goes to -y on the bed
  assert.ok(L.includes("G1 X50.000 Y57.000 Z0.300 E0.3125 F200"), "tail rotated onto -y");
  assert.equal(L.filter((l) => /\bE-4\.0000/.test(l)).length, 2, "one retract per stamp, two stamps");
});

test("stampSketch calls newPattern; brushSketchDotted does not", () => {
  const em = new lib.Emitter(); em.header();
  lib.stampSketch(em, comma(), 50, 50);
  assert.ok(em.lines.includes("G1 E4.3000 F900"));
  const em2 = new lib.Emitter(); em2.header();
  const pts = lib.samplePath((t) => 50 + t, () => 50, 0, 1, {});
  lib.brushSketchDotted(em2, comma(), pts, {});
  assert.ok(em2.lines.includes("G1 E4.0000 F900") && !em2.lines.includes("G1 E4.3000 F900"));
});

console.log("gate");

test("a sound program passes at every corner", () => {
  const r = C.checkProgram(lib, comma());
  assert.equal(r.ok, true, r.errors.join("\n"));
  assert.equal(r.stats.retracts, 1);
  assert.equal(C.paramCorners(comma()).length, 1 + 4);
});

test("shape errors come before anything is expanded", () => {
  const p = comma();
  p.name = "Bad Name"; p.params.gap = { def: 1, min: 0, max: 2 }; p.params.diameter.def = 9;
  p.steps.push({ op: "wiggle" });
  const errs = C.validateProgramShape(p);
  assert.ok(errs.some((e) => /camelCase/.test(e)));
  assert.ok(errs.some((e) => /reserved/.test(e)));
  assert.ok(errs.some((e) => /outside 0.8..3/.test(e)));
  assert.ok(errs.some((e) => /unknown op "wiggle"/.test(e)));
});

test("machine-safety problems are errors, found at the corners too", () => {
  const p = comma();
  p.steps[1].f = 2000;                                  // TPU retract/prime speed
  p.steps[6].to = ["-tailLen-1", 0, "0.3 - tailLen/10"];   // below 0.1mm when tailLen = 5
  const r = C.checkProgram(lib, p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /2000mm\/min is over the TPU prime speed cap/.test(e)));
  assert.ok(r.errors.some((e) => /below 0.1mm/.test(e) && /tailLen=5/.test(e)), r.errors.join("\n"));
  assert.ok(C.checkProgram(lib, p, { material: "PLA" }).errors.every((e) => !/speed cap/.test(e)), "PLA allows 2000");
  const far = comma(); far.radiusMm = 3;
  assert.ok(C.checkProgram(lib, far).errors.some((e) => /past its radiusMm 3/.test(e)));
});

test("exploration hazards are warnings, never errors", () => {
  const p = {
    name: "hazards", params: {},
    steps: [
      { op: "travel", to: [0, 0, 0.2] },
      { op: "extrudeHere", e: 0.5, ms: 1000 },                             // puddle, no prime
      { op: "move", to: [3, 0, 0.3], bead: { w: 0.8, h: 0.3 }, f: 200 },   // bead to x=3
      { op: "move", to: [1.5, 0, 0.1], f: 600 },                           // dry, no retract: string + drag through
      { op: "move", to: [4, 0, 0.1], f: 600 },
    ],
  };
  const r = C.checkProgram(lib, p);
  assert.equal(r.ok, true, r.errors.join("\n"));
  const w = r.warnings.join("\n");
  assert.match(w, /deliberate stationary extrusion/);
  assert.match(w, /still retracted|no prime step/);
  assert.match(w, /dry right after extruding without a retract/);
  assert.match(w, /passes below the top of material/);
});

test("volumetric flow over the limit is a warning", () => {
  const p = comma();
  p.steps[2].e = 3; p.steps[2].f = 600;
  const r = C.checkProgram(lib, p);
  assert.ok(r.warnings.some((w) => /mm3\/s is over the 4mm3\/s/.test(w)));
});

test("the limits text is generated from the table", () => {
  const t = C.sketchLimitsText();
  for (const r of Object.values(C.SKETCH_LIMITS)) assert.ok(t.includes(r.applies), r.applies);
});

console.log(`\n${n} passed`);
