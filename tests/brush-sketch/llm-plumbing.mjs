// brush-sketch: prompt assembly from the real docs, and the gated repair
// loop driven by a scripted fake model. No API key, no browser.
//
//   node tests/brush-sketch/llm-plumbing.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SE = join(here, "../../sewingeditor");
const BS = join(SE, "brush-sketch");
const lib = await import(pathToFileURL(join(SE, "texture_docs/texture_functions.js")).href);
const PA = await import(pathToFileURL(join(BS, "prompt-assembly.js")).href);
const SP = await import(pathToFileURL(join(BS, "sketch-pipeline.js")).href);
const C = await import(pathToFileURL(join(BS, "checks.js")).href);
const { STAGES } = await import(pathToFileURL(join(BS, "stage-schemas.js")).href);

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const docs = Object.fromEntries(PA.DOC_PATHS.map((p) => [p, PA.docText(p, readFileSync(join(BS, p), "utf8"))]));

console.log("prompts");

await test("every stage has a schema and a prompt built from its docs", () => {
  assert.deepEqual(Object.keys(PA.STAGE_DOCS).sort(), Object.keys(STAGES).sort());
  for (const stage of Object.keys(STAGES)) {
    const sys = PA.composeSystemPrompt(stage, { docs, material: "TPU" });
    assert.match(sys, /^ROLE\n/, `${stage}: starts with the fenced prompt, not the notes around it`);
    assert.match(sys, /SESSION: material = TPU/);
    assert.ok(sys.length > 1500, `${stage} prompt is ${sys.length} chars`);
  }
});

await test("stage docs contribute only their fence; references are whole", () => {
  const raw = readFileSync(join(BS, "docs/stage-interpret.md"), "utf8");
  assert.ok(!docs["docs/stage-interpret.md"].includes("Turns a freehand sketch's literal draft"), "the notes outside the fence are dropped");
  assert.ok(raw.includes("Turns a freehand sketch's literal draft"));
  assert.ok(docs["docs/ref-brush-program.md"].includes("```json"), "reference examples are kept");
});

await test("exploration-first rule and the generated limits reach the interpret prompt", () => {
  const sys = PA.composeSystemPrompt("interpret", { docs, material: "PLA" });
  assert.match(sys, /EXPLORATION FIRST\. Never replace the sketch with an existing library/);
  assert.ok(sys.includes(C.sketchLimitsText()));
  assert.match(sys, /PLA: 205C/);
  assert.ok(!PA.composeSystemPrompt("document", { docs }).includes("LIMITS THE PAGE CHECKS"), "document does not need the limits");
});

await test("user messages carry what each stage needs, and a repair block when repairing", () => {
  const draft = { name: "x", steps: [{ op: "travel", to: [0, 0, 0.2] }] };
  const m = PA.composeUserMessage("interpret", { intent: "a hook", draft, strokes: [{ stroke: 1 }], check: { errors: [], warnings: ["w1"], stats: null } });
  assert.match(m, /AUTHOR'S INTENT:\na hook/);
  assert.match(m, /LITERAL DRAFT/);
  assert.match(m, /WARNINGS:\n  - w1/);
  const r = PA.composeUserMessage("interpret", { intent: "", draft, strokes: [], check: null }, { errors: ["bad z"], previous: "{...}" });
  assert.match(r, /^REPAIR:/);
  assert.match(r, /  - bad z/);
  assert.match(PA.composeUserMessage("feedback", { report: "strings everywhere", program: draft }), /AUTHOR'S REPORT, VERBATIM:\nstrings everywhere/);
});

console.log("repair loop");

const good = {
  name: "hookDot", version: 1, orientation: "fixed", radiusMm: 5, params: {},
  steps: [{ op: "travel", to: [0, 0, 0.2] }, { op: "prime", mm: 1.3 }, { op: "move", to: [2, 0, 0.3], bead: { w: 0.8, h: 0.3 }, f: 300 }, { op: "retract", mm: 1.3 }],
};
const gate = (value) => {
  const pr = SP.parseProgramField(value?.program);
  if (pr.error) return [pr.error];
  return C.checkProgram(lib, pr.program).errors;
};

await test("unparseable, then unprintable, then good: two repairs, errors quoted back", async () => {
  const bad = { ...good, steps: [...good.steps.slice(0, 2), { op: "move", to: [2, 0, 0.02], e: 0.1, f: 300 }] };
  const script = [
    { value: null, errors: ["not valid JSON: Unexpected token"], raw: "{oops" },
    { value: { chat: "", notes: [], program: JSON.stringify(bad) }, errors: [], raw: "bad-program" },
    { value: { chat: "ok", notes: [], program: JSON.stringify(good) }, errors: [], raw: "good-program" },
  ];
  const seen = [];
  const res = await SP.runGatedStage({
    stage: "interpret",
    compose: (repair) => PA.composeUserMessage("interpret", { intent: "", draft: good, strokes: [], check: null }, repair),
    callModel: async (stage, msg) => { seen.push(msg); return script.shift(); },
    gate,
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts.length, 3);
  assert.ok(!seen[0].startsWith("REPAIR"));
  assert.match(seen[1], /not valid JSON/);
  assert.match(seen[1], /YOUR PREVIOUS OUTPUT:\n\{oops/);
  assert.match(seen[2], /below 0.1mm/);
});

await test("bounded: gives up after maxRepairs and returns the last valid answer", async () => {
  let calls = 0;
  const res = await SP.runGatedStage({
    stage: "interpret", compose: () => "m", maxRepairs: 2, gate: () => ["still wrong"],
    callModel: async () => { calls++; return { value: { program: "{}" }, errors: [], raw: "x" }; },
  });
  assert.equal(calls, 3);
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, ["still wrong"]);
  assert.deepEqual(res.value, { program: "{}" });
});

await test("parameterize: the motion at the defaults must equal the drawing", () => {
  const before = SP.motionSignature(lib, good);
  const same = { ...good, params: { reach: { def: 2, min: 1, max: 4, level: "brush" } }, steps: good.steps.map((s, i) => (i === 2 ? { ...s, to: ["reach", 0, 0.3] } : s)) };
  assert.deepEqual(SP.compareMotion(before, SP.motionSignature(lib, same)), []);
  const drifted = { ...same, params: { reach: { def: 2.5, min: 1, max: 4, level: "brush" } } };
  const diff = SP.compareMotion(before, SP.motionSignature(lib, drifted));
  assert.equal(diff.length, 1);
  assert.match(diff[0], /expanded step 3 \(move\): value 1 is 2\.5/);
});

console.log(`\n${n} passed`);
