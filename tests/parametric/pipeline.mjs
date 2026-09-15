// Offline tests for the turn loop (no LLM, no browser):
//   node tests/parametric/pipeline.mjs
//
// Drives runStage/runTurn with a scripted fake model against the REAL
// catalog, so the gate really validates and really compiles. What is being
// checked is the control flow: what gets retried, what gets sent back to
// whom, and where the loop stops.

import assert from "node:assert/strict";
import * as C from "../../sewingeditor/parametric-with-tool/parametric-catalog-with-tool.js";
import { runStage, runTurn, draftScene, CHAIN } from "../../sewingeditor/parametric-with-tool/pipeline.js";
import { composeUserMessage } from "../../sewingeditor/parametric-with-tool/prompt-assembly.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const rect = (x0, y0, w, h) => ({ points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]] });

const GOOD_GEOMETRY = {
  chat: "one bar", transform: "",
  elements: [{ id: "el_1", label: "bar", kind: "region", role: "bar", geometry: JSON.stringify({ boundary: [rect(50, 40, 15, 12)] }) }],
};
const OFF_BED_GEOMETRY = {
  chat: "oops", transform: "",
  elements: [{ id: "el_1", label: "bar", kind: "region", role: "bar", geometry: JSON.stringify({ boundary: [rect(500, 40, 15, 12)] }) }],
};
const BAD_KIND_GEOMETRY = { chat: "?", transform: "", elements: [{ id: "", label: "x", kind: "blob", role: "", geometry: "{}" }] };

// A fake model: hand it a list of replies per stage and it serves them in
// order, recording every user message it was sent.
function scriptedModel(script) {
  const sent = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, v.slice()]));
  return {
    sent,
    async callModel(stage, userMessage, contextScene) {
      sent.push({ stage, userMessage });
      const q = queues[stage];
      assert.ok(q && q.length, `fake model ran out of "${stage}" replies (call ${sent.length})`);
      const out = q.length > 1 ? q.shift() : q[0];
      const v = C.validateStageOutput(stage, out, contextScene);
      return { value: v.value, errors: v.errors, raw: JSON.stringify(out) };
    },
  };
}

function baseDeps(scene, model, extra = {}) {
  return {
    C,
    callModel: model.callModel,
    compile: (s) => C.compileScene(s),
    composeUser: (stage, opts) => composeUserMessage(stage, { scene, C, ...opts }),
    merge: (stage, value) => {
      if (stage === "geometry") return C.mergeGeometry(scene, value);
      if (stage === "texture") return C.mergeTextures(scene, value);
      if (stage === "ui") return C.mergeUi(scene, value);
      return [];
    },
    maxRepairs: 2,
    maxRefineRounds: 2,
    selfCheck: true,
    ...extra,
  };
}

await test("a rejected output goes back to the same stage with its own mistake quoted", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [BAD_KIND_GEOMETRY, GOOD_GEOMETRY] });
  const res = await runStage("geometry", { scene, instruction: "one bar", targets: [] }, baseDeps(scene, model));

  assert.equal(res.ok, true);
  assert.equal(model.sent.length, 2, "one rejection, one repair");
  assert.equal(res.attempts.length, 2);
  assert.ok(res.attempts[0].errors.length, "the first attempt failed validation");

  const repairMsg = model.sent[1].userMessage;
  assert.ok(repairMsg.startsWith("REPAIR:"), "the second call is framed as a repair");
  assert.ok(/kind must be line\|region\|point/.test(repairMsg), "with the exact rejection text");
  assert.ok(repairMsg.includes('"kind":"blob"'), "and its own previous answer to compare against");
  assert.ok(repairMsg.includes("one bar"), "the original instruction survives the repair");
});

await test("output that validates but will not compile is repaired too", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [OFF_BED_GEOMETRY, GOOD_GEOMETRY] });
  const res = await runStage("geometry", { scene, instruction: "one bar", targets: [] }, baseDeps(scene, model));

  assert.equal(res.ok, true);
  assert.equal(model.sent.length, 2);
  assert.deepEqual(res.attempts[0].errors, [], "it was valid JSON in the right shape");
  assert.ok(res.attempts[0].compileErrors.some((e) => /safe area/.test(e)), "but it does not fit the bed");
  assert.ok(/safe area/.test(model.sent[1].userMessage), "which is what the repair call is told");
  assert.equal(scene.elements.length, 0, "nothing was merged along the way -- the gate holds the scene");
});

await test("repairs are bounded, and the last usable attempt still comes back", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [OFF_BED_GEOMETRY] });   // never improves
  const res = await runStage("geometry", { scene, instruction: "one bar", targets: [] }, baseDeps(scene, model));

  assert.equal(res.ok, false);
  assert.equal(model.sent.length, 3, "the first call plus maxRepairs, and no more");
  assert.ok(res.value, "the attempt is returned anyway so the user can fix it by hand");
  assert.ok(res.errors.some((e) => /safe area/.test(e)));
});

await test("a full turn runs the chain the manager picked and stops when the judge passes", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "shaded", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 4 }), options: JSON.stringify({ width: 0.5 }) }] }],
    ui: [{ chat: "surfaced", groups: [{ id: "", title: "how dense", attribute: "density", description: "", members: JSON.stringify([{ level: "pattern", elementId: "el_1", slot: "fill", option: "gap" }]) }] }],
  });
  const judged = [];
  const deps = baseDeps(scene, model, {
    route: async () => ({ route: "geometry", instruction: "one bar, shaded", targets: [], acceptance: ["one bar"], reply: "" }),
    judge: async (plan, ran) => { judged.push(ran.map((r) => r.stage)); return { pass: true, failures: [], note: "checks out" }; },
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.stopped, "passed");
  assert.deepEqual(judged, [["geometry", "texture", "ui"]], "the whole chain ran once, then one judge call");
  assert.equal(scene.elements.length, 1);
  assert.equal(scene.textures.el_1.fill.pattern.gap, 4);
  assert.equal(scene.groups.length, 1);
  assert.equal(scene.groups[0].members[0].direction, -1);
});

await test("a judge failure goes to the manager, which picks the stage to re-run", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [
      { chat: "first try", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 9 }), options: "{}" }] },
      { chat: "denser", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 3 }), options: "{}" }] },
    ],
    ui: [{ chat: "surfaced", groups: [] }],
  });
  const routeCalls = [];
  let judgeCall = 0;
  const deps = baseDeps(scene, model, {
    route: async (refine) => {
      routeCalls.push(refine);
      // first the manager enters at geometry; on refine it picks texture
      return refine
        ? { route: "texture", instruction: "make el_1's shading denser", targets: ["el_1"], acceptance: [], reply: "" }
        : { route: "geometry", instruction: "one shaded bar", targets: [], acceptance: ["the shading reads as dense"], reply: "" };
    },
    judge: async () => (++judgeCall === 1
      ? { pass: false, failures: [{ criterion: "the shading reads as dense", evidence: "hatch gap 9mm", suspectedStage: "texture" }], note: "too sparse" }
      : { pass: true, failures: [], note: "better" }),
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.stopped, "passed");
  assert.equal(out.rounds.length, 2, "one round, then one refine round");
  assert.equal(routeCalls.length, 2);
  assert.ok(routeCalls[1], "the second route call is a refine");
  assert.equal(routeCalls[1].failures[0].suspectedStage, "texture");
  assert.deepEqual(routeCalls[1].ranStages, ["geometry", "texture", "ui"]);
  assert.deepEqual(out.rounds[1].ran.map((r) => r.stage), ["texture", "ui"], "only the suffix from the chosen stage re-ran");
  assert.equal(scene.textures.el_1.fill.pattern.gap, 3, "and the refinement landed");
  // the acceptance criteria carry across the refine round
  assert.deepEqual(out.rounds[1].plan.acceptance, ["the shading reads as dense"]);
});

await test("refine rounds are bounded", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 9 }), options: "{}" }] }],
    ui: [{ chat: "", groups: [] }],
  });
  let judges = 0;
  const deps = baseDeps(scene, model, {
    maxRefineRounds: 1,
    route: async (refine) => ({ route: refine ? "texture" : "geometry", instruction: "x", targets: [], acceptance: ["never satisfied"], reply: "" }),
    judge: async () => { judges++; return { pass: false, failures: [{ criterion: "never satisfied", evidence: "-", suspectedStage: "texture" }], note: "" }; },
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.stopped, "rounds");
  assert.equal(out.rounds.length, 2, "the first pass plus one refine round, then it gives up");
  assert.equal(judges, 2);
  assert.ok(out.verdict && !out.verdict.pass, "and the user is told which criterion never passed");
});

await test("with self-check off there is no judge and no refine", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "", textures: [] }],
    ui: [{ chat: "", groups: [] }],
  });
  let judged = false;
  const deps = baseDeps(scene, model, {
    selfCheck: false,
    route: async () => ({ route: "geometry", instruction: "one bar", targets: [], acceptance: ["one bar"], reply: "" }),
    judge: async () => { judged = true; return { pass: false, failures: [], note: "" }; },
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.stopped, "done");
  assert.equal(judged, false, "the gate still runs, the judge does not");
  assert.equal(scene.elements.length, 1);
});

await test("the manager can end a refine round by asking the user instead", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({
    geometry: [GOOD_GEOMETRY],
    texture: [{ chat: "", textures: [] }],
    ui: [{ chat: "", groups: [] }],
  });
  const deps = baseDeps(scene, model, {
    route: async (refine) => (refine
      ? { route: "chat", instruction: "", targets: [], acceptance: [], reply: "Which of the two curves did you want shaded?" }
      : { route: "geometry", instruction: "shade it", targets: [], acceptance: ["the right area is shaded"], reply: "" }),
    judge: async () => ({ pass: false, failures: [{ criterion: "the right area is shaded", evidence: "two candidates", suspectedStage: "geometry" }], note: "" }),
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.stopped, "chat");
  assert.ok(/Which of the two curves/.test(out.plan.reply), "the question reaches the user rather than another silent round");
});

await test("a gate failure stops the chain before the next stage runs", async () => {
  const scene = C.defaultScene();
  const model = scriptedModel({ geometry: [OFF_BED_GEOMETRY], texture: [{ chat: "", textures: [] }] });
  const deps = baseDeps(scene, model, {
    route: async () => ({ route: "geometry", instruction: "one bar", targets: [], acceptance: ["one bar"], reply: "" }),
    judge: async () => ({ pass: true, failures: [], note: "" }),
  });

  const out = await runTurn({ scene }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.stopped, "gate");
  assert.equal(out.failedStage, "geometry");
  assert.ok(!model.sent.some((c) => c.stage === "texture"), "texture never ran on geometry nobody could print");
});

await test("draftScene shows what the scene WOULD be, without touching it", async () => {
  const scene = C.defaultScene();
  scene.elements = [{ id: "el_1", label: "bar", kind: "region", role: "bar", boundary: [rect(50, 40, 15, 12)] }];
  const v = C.validateStageOutput("texture", {
    chat: "", textures: [{ elementId: "el_1", slot: "fill", fn: "solid", pattern: JSON.stringify({ kind: "hatch", gap: 4 }), options: "{}" }],
  }, scene);
  assert.deepEqual(v.errors, []);

  const draft = draftScene("texture", scene, v.value, C);
  assert.equal(draft.textures.el_1.fill.fn, "solid", "the draft has the proposed texture");
  assert.equal(scene.textures.el_1, undefined, "the live scene is untouched");
  assert.ok(C.compileScene(draft).jobs.length > 0, "and it is a real scene the compiler accepts");
});

await test("the chain table matches what the manager may choose", async () => {
  assert.deepEqual(CHAIN.geometry, ["geometry", "texture", "ui"]);
  assert.deepEqual(CHAIN.texture, ["texture", "ui"]);
  assert.deepEqual(CHAIN.ui, ["ui"]);
  assert.deepEqual(CHAIN.chat, []);
});

console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
