// brush-sketch: promotion into the library, against COPIES of the real
// texture_docs files in a temp folder (the repo's files are never touched).
//
//   node tests/brush-sketch/promote.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SE = join(here, "../../sewingeditor");
const TD = join(SE, "texture_docs");
const P = await import(pathToFileURL(join(SE, "brush-sketch/promote.js")).href);
const lib = await import(pathToFileURL(join(TD, "texture_functions.js")).href);

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const tmp = mkdtempSync(join(tmpdir(), "brush-sketch-promote-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const FILES = ["texture_functions.js", "sketched_brushes.js", "texture_patterns.md", "troubleshooting.md", "CHANGELOG.md"];
for (const f of FILES) writeFileSync(join(tmp, f), readFileSync(join(TD, f)));
writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
const read = () => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(tmp, f), "utf8")]));
const apply = (out) => {
  for (const e of out.edits) writeFileSync(join(tmp, e.path), e.after);
  for (const f of out.newFiles) { mkdirSync(dirname(join(tmp, f.path)), { recursive: true }); writeFileSync(join(tmp, f.path), f.text); }
};

const program = {
  name: "commaDot", version: 1, orientation: "tangent", radiusMm: 6, defaultGap: 6,
  params: { diameter: { def: 2, min: 0.8, max: 3, level: "brush", desc: "head dome | diameter" }, tailLen: { def: 3, min: 0, max: 4, level: "brush", desc: "tail" } },
  steps: [
    { op: "travel", to: [0, 0, 0.2] }, { op: "prime", mm: 4 },
    { op: "move", to: [0, 0, "0.2+diameter/2"], e: "0.02*diameter^3", f: 120 }, { op: "dwell", ms: 1500 },
    { op: "move", to: ["-tailLen", 0, 0.3], bead: { w: 0.8, h: 0.3 }, f: 200 }, { op: "retract", mm: 4 },
    { op: "move", to: ["-tailLen-1", 0, 1.0], f: 600 },
  ],
};
const doc = { summary: "a dome that drags into a tail", description: "A small dome ...", sequence: "travel, prime 4mm, rise ...", changes: "Drawn freehand." };
const before = read();

console.log("promotion");

let out1;
test("v1: code block, pattern entry, troubleshooting section, changelog entry, program JSON", () => {
  out1 = P.buildPromotion({
    files: before, program, doc, intent: "a comma", origin: "drawn freehand, interpreted by the model",
    notes: [{ change: "step 2: added a 4mm prime", why: "the drawing started retracted", ref: "§14" }],
    digest: "negative-E: 9 (expected 9) OK", testFile: "20260929-140509_comma-dot-v1.gcode",
    sketch: { mode: "freehand", strokes: [] }, date: "2026-09-29",
  });
  assert.deepEqual(out1.edits.map((e) => e.path), ["sketched_brushes.js", "texture_patterns.md", "troubleshooting.md", "CHANGELOG.md"]);
  assert.deepEqual(out1.newFiles.map((f) => f.path), ["sketch_brushes/commaDot/v1.program.json", "sketch_brushes/commaDot/v1.sketch.json"]);
  const code = out1.edits[0].after;
  assert.match(code, /\/\/ <sketch-brush name="commaDot" version="1">/);
  assert.ok(code.indexOf("// <sketch-brush name=") < code.indexOf("// </sketch-brushes>"), "inside the generated region");
  // everything outside the generated region is untouched
  const cut = (t) => t.slice(0, t.indexOf("// <sketch-brushes>"));
  assert.equal(cut(code), cut(before["sketched_brushes.js"]));
  assert.ok(out1.edits[1].after.startsWith(before["texture_patterns.md"].replace(/\s*$/, "")), "patterns: appended, nothing above changed");
  assert.match(out1.edits[1].after, /## Sketched brushes/);
  assert.match(out1.edits[1].after, /head dome \\\| diameter/, "pipes in a desc are escaped for the table");
  assert.match(out1.edits[2].after, /## \d+\. Sketched brush: `commaDot`/);
  assert.match(out1.edits[3].after, new RegExp(`## ${out1.changelogNumber}\\. Sketched brush \`commaDot\` v1`));
  assert.match(out1.edits[3].after, /\*\*Not yet print-tested\.\*\*/);
  apply(out1);
});

test("the promoted library imports in a fresh process and matches the interpreter byte for byte", () => {
  const url = pathToFileURL(join(tmp, "texture_functions.js")).href;
  const script = `
    const m = await import(${JSON.stringify(url)});
    const run = (f) => { const em = new m.Emitter(); em.header(); f(em); em.footer(); return em.lines.join("\\n"); };
    const p = m.commaDotProgram;
    const opts = { diameter: 2.5, tailLen: 2, azimuthDeg: 30, gap: 5 };
    const a = run((em) => m.freeformCommaDotted(em, (t) => 40 + t, (t) => 60 + 3 * Math.sin(t / 5), 0, 30, opts));
    const b = run((em) => m.freeformSketchDotted(em, p, (t) => 40 + t, (t) => 60 + 3 * Math.sin(t / 5), 0, 30, opts));
    const c = run((em) => m.commaDot(em, 50, 50, opts));
    const d = run((em) => m.stampSketch(em, p, 50, 50, opts));
    console.log(JSON.stringify({ same: a === b && c === d, keys: Object.keys(m.SKETCH_BRUSHES), fill: typeof m.fill, n: a.split("\\n").length }));`;
  const res = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script]).toString());
  assert.equal(res.same, true);
  assert.deepEqual(res.keys, ["commaDot"]);
  assert.ok(res.n > 60, `only ${res.n} lines`);
});

test("the program round-trips out of the generated block", () => {
  const code = read()["sketched_brushes.js"];
  assert.deepEqual(P.libraryProgram(code, "commaDot"), program);
  assert.equal(P.libraryVersion(code, "commaDot"), 1);
  assert.deepEqual(P.libraryBrushes(code), [{ name: "commaDot", version: 1 }]);
});

test("v2 replaces the code block and entry, keeps status history, extends troubleshooting", () => {
  const v2 = { ...program, version: 2, steps: program.steps.map((s) => (s.op === "dwell" ? { ...s, ms: 800 } : s)) };
  const out2 = P.buildPromotion({
    files: read(), program: v2, doc: { ...doc, changes: "Shorter dwell." }, intent: "a comma", origin: "edited from v1 in the vector editor",
    notes: [], digest: "", testFile: "", sketch: null, date: "2026-09-30",
  });
  apply(out2);
  const f = read();
  assert.equal((f["sketched_brushes.js"].match(/<sketch-brush name="commaDot"/g) || []).length, 1);
  assert.equal(P.libraryVersion(f["sketched_brushes.js"], "commaDot"), 2);
  assert.equal((f["texture_patterns.md"].match(/<!-- sketch-brush:commaDot -->/g) || []).length, 1);
  assert.equal((f["texture_patterns.md"].match(/## Sketched brushes/g) || []).length, 1);
  const status = P.statusBullets(f["texture_patterns.md"], "commaDot");
  assert.equal(status.length, 2);
  assert.match(status[0], /^- v1 \(2026-09-29\)/);
  assert.match(status[1], /^- v2 \(2026-09-30\): edited from v1/);
  assert.equal((f["troubleshooting.md"].match(/### v\d \(/g) || []).length, 2);
  assert.equal((f["troubleshooting.md"].match(/Sketched brush: `commaDot`/g) || []).length, 1);
  assert.match(f["troubleshooting.md"], /printed as drawn/);
  assert.deepEqual(out2.newFiles.map((x) => x.path), ["sketch_brushes/commaDot/v2.program.json"]);
});

test("a print report adds a status bullet, a troubleshooting subsection and a changelog entry", () => {
  const f = read();
  const out = P.buildFeedback({
    files: f, program: P.libraryProgram(f["sketched_brushes.js"], "commaDot"), report: "the tail curls up at the end",
    status: "v2 printed: 'the tail curls up at the end'.", analysis: "Possibly the dry lift after the retract drags the tail tip.",
    testFile: "20260930-101010_comma-dot-v2.gcode", proposed: { version: 3 }, date: "2026-09-30",
  });
  assert.deepEqual(out.edits.map((e) => e.path), ["texture_patterns.md", "troubleshooting.md", "CHANGELOG.md"]);
  apply(out);
  const g = read();
  assert.equal(P.statusBullets(g["texture_patterns.md"], "commaDot").length, 3);
  assert.match(g["troubleshooting.md"], /### v2 printed \(2026-09-30\)/);
  assert.match(g["CHANGELOG.md"], /\*\*Problem reported\*\*: "the tail curls up at the end"/);
  // the brush's troubleshooting region stays one contiguous section
  const region = g["troubleshooting.md"].match(/<!-- sketch-brush:commaDot -->[\s\S]*?<!-- \/sketch-brush:commaDot -->/)[0];
  assert.ok(region.indexOf("### v1") < region.indexOf("### v2 (") && region.indexOf("### v2 (") < region.indexOf("### v2 printed"));
});

test("hunk() isolates the changed lines", () => {
  const h = P.hunk("a\nb\nc\nd\n", "a\nb\nX\nY\nd\n");
  assert.deepEqual([h.startLine, h.removed, h.added], [3, ["c"], ["X", "Y"]]);
});

test("the generated block obeys the circular-import rule (no imported name at top level)", () => {
  const block = read()["sketched_brushes.js"].match(/\/\/ <sketch-brushes>([\s\S]*)\/\/ <\/sketch-brushes>/)[1];
  const imported = ["samplePath", "pointAtArcLength", "totalLength", "eRate", "RETRACT_SPEED", "LINE_START_PRIME_MM"];
  // strip function bodies; what remains is top-level code
  const top = block.replace(/\{\n[\s\S]*?\n\}/g, "{}");
  for (const name of imported) assert.ok(!new RegExp(`\\b${name}\\b`).test(top), name);
});

console.log(`\n${n} passed`);
