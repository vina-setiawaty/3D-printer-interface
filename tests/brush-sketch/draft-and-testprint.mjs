// brush-sketch: freehand -> literal draft, and the test-print builder
// (calibration conventions read from the REAL test_print_gcode/ folder).
//
//   node tests/brush-sketch/draft-and-testprint.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SE = join(here, "../../sewingeditor");
const TD = join(SE, "texture_docs");
const lib = await import(pathToFileURL(join(TD, "texture_functions.js")).href);
const D = await import(pathToFileURL(join(SE, "brush-sketch/literal-draft.js")).href);
const T = await import(pathToFileURL(join(SE, "brush-sketch/test-print.js")).href);
const C = await import(pathToFileURL(join(SE, "brush-sketch/checks.js")).href);

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log("literal draft");

// hold still with flow 3 (a puddle), rise extruding at flow 2, hold still
// at flow 0 (a dwell), then a dry stroke sideways with a retract before it
const still = [];
for (let t = 0; t <= 600; t += 16) still.push({ t, x: 0, y: 0, z: 0.2, flow: 3 });
for (let k = 1; k <= 30; k++) still.push({ t: 600 + k * 16, x: 0, y: 0, z: 0.2 + k * 0.1, flow: 2 });
for (let t = 1100; t <= 1400; t += 16) still.push({ t, x: 0, y: 0, z: 3.2, flow: 0 });
const dry = { dry: true, samples: Array.from({ length: 21 }, (_, k) => ({ t: 1500 + k * 16, x: k * 0.2, y: 0, z: 3.2, flow: 0 })), events: [] };
const strokes = [{ view: "side", samples: still, events: [{ t: 1450, type: "retract" }] }, { view: "top", ...dry }];

test("puddle, rise, dwell, retract and dry move come out in drawn order", () => {
  const { program, trace } = D.literalDraft(strokes);
  assert.deepEqual(trace.map((t) => t.kind), ["travel", "puddle", "extrude", "extrude", "dwell", "retract", "dry"]);
  const [, puddle, first, rise, dwell, retract, drymove] = program.steps;
  assert.equal(puddle.op, "extrudeHere");
  assert.ok(Math.abs(puddle.e - D.FLOW_LEVELS[3].stillMmPerS * puddle.ms / 1000) < 0.01);
  assert.deepEqual(rise.to, [0, 0, 3.2]);
  assert.deepEqual(rise.bead, { w: D.FLOW_LEVELS[2].w, h: D.FLOW_LEVELS[2].h });
  assert.equal(first.bead.w, D.FLOW_LEVELS[3].w, "the step up to the flow change keeps the old flow");
  assert.equal(dwell.op, "dwell");
  assert.deepEqual(retract, { op: "retract", mm: 1.3 });
  assert.equal(drymove.bead, undefined);
  assert.equal(program.radiusMm, 5);
});

test("simplify keeps corners, drops noise; hold-still time is scaled", () => {
  const zig = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0.01, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 2, z: 0 }];
  assert.equal(D.simplify3(zig, 0.12).length, 3);
  const { program } = D.literalDraft(strokes, { timeScale: 2 });
  assert.ok(program.steps[1].ms > 1100 && program.steps[1].ms < 1300);
});

test("a literal draft is a valid program the gate can judge", () => {
  const { program } = D.literalDraft(strokes);
  assert.deepEqual(C.validateProgramShape(program), []);
  const r = C.checkProgram(lib, program);
  assert.equal(r.ok, true, r.errors.join("\n"));
  assert.ok(r.warnings.some((w) => /no prime step/.test(w)), "a literal drawing is not silently fixed");
});

test("the stroke summary for the model is compact", () => {
  const s = D.strokeSummary(strokes, 20);
  assert.equal(s.length, 2);
  assert.ok(s[0].points_t_x_y_z_flow.length <= 21);
  assert.deepEqual(s[0].events, [[1450, "retract"]]);
});

console.log("test print");

function gcodeFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...gcodeFiles(p));
    else if (name.endsWith(".gcode")) out.push({ path: relative(TD, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8").slice(0, 8192) });
  }
  return out;
}
// The folder as it was when this was written: files printed since (the
// page's own test files included) would otherwise move every expectation.
const files = gcodeFiles(join(TD, "test_print_gcode")).filter((f) => {
  const ts = T.timestampOf(f.path.split("/").pop());
  return !ts || ts <= "20260925172719";
});
const changelog = readFileSync(join(TD, "CHANGELOG.md"), "utf8");

test("calibration lines are read from the repo's real files", () => {
  const byName = Object.fromEntries(files.map((f) => [f.path.split("/").pop(), T.parseCalibration(f.text)]));
  assert.deepEqual(byName["20260924-170610_backport-extrusion-cap-polygon-fill.gcode"], { mode: "normal", y: 90 });
  assert.deepEqual(byName["20260827-124623_segmented-v4-testmode-perseg-height-speed-width.gcode"], { mode: "test", x: 200, band: 110 });
  assert.deepEqual(byName["20260827-114728_dirblob-v3-testmode-az45-2mm-default.gcode"], { mode: "test", x: 173, band: 40 });
});

test("next positions: CHANGELOG 'resume from' hint wins; test mode marches 3mm left", () => {
  const p = T.proposeCalibration(files, changelog);
  assert.equal(p.normal.y, 85, p.normal.source);     // CHANGELOG #55: "resume from y=85"
  assert.deepEqual([p.test.x, p.test.band], [197, 110], p.test.source);
  const noHint = T.proposeCalibration(files, "## 1. x\n");
  assert.equal(noHint.normal.y, 195, "without the hint: 5 below the newest normal file (the y=200 sheet)");
  // once a normal-mode file newer than the hint's own file exists, the hint is spent
  const later = [...files, { path: "test_print_gcode/20991231-235959_next.gcode", text: "G0 X120.000 Y85.000 F3000\n" }];
  assert.equal(T.proposeCalibration(later, changelog).normal.y, 80);
});

test("test-mode column wrap", () => {
  const f = [{ path: "test_print_gcode/20990101-000000_x-testmode.gcode", text: "G1 Z2\nG0 X161.000 Y40.000 F3000\n" }];
  assert.deepEqual([T.proposeCalibration(f).test.x, T.proposeCalibration(f).test.band], [200, 110]);
  f[0].text = "G0 X161.000 Y110.000 F3000\n";
  assert.deepEqual([T.proposeCalibration(f).test.x, T.proposeCalibration(f).test.band], [200, 40]);
});

test("filenames: timestamp + description from the text input (+ -testmode)", () => {
  const d = new Date(2026, 8, 29, 14, 5, 9);
  assert.equal(T.testFilename("Comma dot v2 / tail 3mm", { date: d }), "20260929-140509_comma-dot-v2-tail-3mm.gcode");
  assert.equal(T.testFilename("comma", { date: d, testMode: true }), "20260929-140509_comma-testmode.gcode");
  assert.equal(T.testFilename("comma-testmode-a", { date: d, testMode: true }), "20260929-140509_comma-testmode-a.gcode");
  assert.equal(T.nextChangelogNumber(changelog) > 55, true);
});

const comma = {
  name: "commaDot", version: 1, orientation: "tangent", radiusMm: 6, defaultGap: 6,
  params: { diameter: { def: 2, min: 0.8, max: 3, level: "brush" }, tailLen: { def: 3, min: 0, max: 4, level: "brush" } },
  steps: [
    { op: "travel", to: [0, 0, 0.2] }, { op: "prime", mm: 4 },
    { op: "move", to: [0, 0, "0.2+diameter/2"], e: "0.02*diameter^3", f: 120 }, { op: "dwell", ms: 1500 },
    { op: "move", to: ["-tailLen", 0, 0.3], bead: { w: 0.8, h: 0.3 }, f: 200 }, { op: "retract", mm: 4 },
    { op: "move", to: ["-tailLen-1", 0, 1.0], f: 600 },
  ],
};

test("normal-mode file: calibration first, retract count matches, layout ok", () => {
  const r = T.buildTestPrint(lib, comma, { calibration: { mode: "normal", y: 85 }, texture: { x0: 30, y: 60, length: 30 } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.digest.negEOk, true, `${r.digest.negE} vs ${r.digest.expectedNegE}`);
  assert.equal(r.digest.stamps, 6);
  assert.equal(T.parseCalibration(r.gcode).mode, "normal");
  assert.equal(T.parseCalibration(r.gcode).y, 85);
});

test("test-mode file with a 3-row sweep; the file parses back as test mode", () => {
  const r = T.buildTestPrint(lib, comma, {
    calibration: { mode: "test", x: 197, band: 110 }, texture: { x0: 30, y: 90, length: 20 },
    sweep: { param: "diameter", values: [1, 2, 3] },
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(T.parseCalibration(r.gcode), { mode: "test", x: 197, band: 110 });
  assert.equal(r.digest.negEOk, true);
  assert.ok(r.gcode.includes("G1 X30.000 Y90.000 Z0.700"), "row 1 at diameter 1: dome top 0.2 + 0.5");
  assert.ok(r.gcode.includes("G1 X30.000 Y74.000 Z1.200"), "row 2, 16mm lower, diameter 2");
});

test("a row off the safe area is an error", () => {
  const r = T.buildTestPrint(lib, comma, { calibration: { mode: "normal", y: 85 }, texture: { x0: 30, y: 16, length: 30 } });
  assert.ok(r.errors.some((e) => /safe/.test(e)));
});

console.log(`\n${n} passed`);
