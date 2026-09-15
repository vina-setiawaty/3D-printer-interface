// Offline tests for prompt assembly (no LLM, no browser):
//   node tests/parametric/prompt-assembly.mjs
//
// Loads the REAL prompt docs off disk the same way the page fetches them
// (a ``` fenced doc contributes only its fenced block) and builds every
// stage's actual system prompt and user message. Guards the two properties
// the split was for: each stage carries only the reference it needs, and
// anything mirroring code is generated rather than written out.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as C from "../../sewingeditor/parametric-with-tool/parametric-catalog-with-tool.js";
import {
  DOC_PATHS, STAGE_DOCS, docText, composeSystemPrompt, composeUserMessage, composeRouteMessages, compileStatusText,
} from "../../sewingeditor/parametric-with-tool/prompt-assembly.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../sewingeditor/parametric-with-tool");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

// Exactly what loadDeps() does in the page.
const raw = {};
const docs = {};
for (const p of DOC_PATHS) {
  raw[p] = readFileSync(resolve(root, p), "utf8");
  docs[p] = docText(p, raw[p]);
}

const rect = (x0, y0, w, h) => ({ points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]] });

function scene() {
  const s = C.defaultScene();
  s.elements = [
    { id: "el_1", label: "x axis", kind: "line", role: "axis", path: { points: [[40, 40], [120, 40]] } },
    { id: "el_2", label: "bar 1", kind: "region", role: "bar", boundary: [rect(50, 40, 15, 12)] },
  ];
  s.textures = {
    el_1: { brush: { fn: "solid", options: {} } },
    el_2: { fill: { fn: "hairy", options: { spacing: 4 }, pattern: { kind: "hatch", angleDeg: 0, gap: 5 } } },
  };
  s.messages = [{ role: "user", content: "a bar chart" }, { role: "assistant", content: "built it", stage: "geometry" }];
  s.lastReport = C.compileScene(s).report;
  return s;
}

const STAGES = Object.keys(STAGE_DOCS);

test("a reference doc reaches the prompt whole, fenced examples and all", () => {
  // Regression: the loader applied "use only the first fenced block" to
  // every doc, so a reference file whose first fence was a JSON example
  // lost everything around it -- reference-machine.md went in at 712 of
  // its 9658 characters and nothing reported a problem.
  for (const p of DOC_PATHS) {
    if (/stage-/.test(p)) continue;
    assert.equal(docs[p], raw[p], `${p} was trimmed on its way into the prompt`);
  }
  const geo = docs["docs/ref-geometry-language.md"];
  assert.ok(/```json/.test(geo), "this doc really does contain a fenced example");
  assert.ok(/Grouping repeated features/.test(geo) && /Solved regions/.test(geo), "and the prose around it survives");

  // a stage doc still contributes only its fenced prompt
  const stage = raw["docs/stage-geometry.md"];
  assert.ok(stage.startsWith("# Stage: geometry"), "the file has a markdown title");
  assert.ok(!docs["docs/stage-geometry.md"].includes("# Stage: geometry"), "which is not part of the prompt");
  assert.throws(() => docText("docs/stage-x.md", "no fence here"), /no ``` fenced prompt block/);
});

test("every stage's docs exist and every stage builds a prompt", () => {
  for (const p of DOC_PATHS) assert.ok(docs[p] && docs[p].length > 100, `${p} is missing or tiny`);
  for (const stage of STAGES) {
    const sys = composeSystemPrompt(stage, { docs, scene: scene(), C });
    assert.ok(sys.length > 500, `${stage} prompt is only ${sys.length} chars`);
  }
});

test("a generating stage states its own ROLE, INPUT and OUTPUT", () => {
  // Self-containment: a stage never sees an earlier call, so its prompt has
  // to say what it is, what it is given and what it must return.
  for (const stage of ["route", "geometry", "texture"]) {
    const sys = composeSystemPrompt(stage, { docs, scene: scene(), C });
    for (const section of ["ROLE", "INPUT", "OUTPUT", "RULES"]) {
      assert.ok(sys.includes(section), `${stage} prompt has no ${section} section`);
    }
  }
});

test("each stage carries only the reference it needs", () => {
  const sys = (stage) => composeSystemPrompt(stage, { docs, scene: scene(), C });

  const texture = sys("texture");
  assert.ok(!/Grouping repeated features/.test(texture), "texture does not decide grouping");
  assert.ok(!/tick every 10 units/.test(texture), "the geometry worked example is not texture's business");
  assert.ok(/blobDotted/.test(texture) && /hatch/.test(texture), "texture does need the brush and pattern menus");

  const geometry = sys("geometry");
  assert.ok(/Grouping repeated features/.test(geometry));
  assert.ok(/between/.test(geometry), "geometry needs the solved-region form");
  assert.ok(!/orbitLoops/.test(geometry), "geometry does not choose brush options");

  const parameters = sys("parameters");
  assert.ok(!/Grouping repeated features/.test(parameters));
  assert.ok(!/start\/end sequence/.test(parameters), "parameters does not need the machine's start sequence");
  assert.ok(/two independently-named/.test(parameters), "parameters does need the two-option-space rule");

  const route = sys("route");
  assert.ok(!/blobDotted/.test(route) && !/Grouping repeated/.test(route), "the manager picks a stage, it does not do the work");
  assert.ok(route.length < 6000, `route prompt is ${route.length} chars -- it is the cheapest call, keep it small`);
});

// Note on sizes: geometry and geometry-check are BIGGER than they were
// (3797 and 2805 chars), because what they used to receive was mostly the
// 712-char remnant of a truncated reference -- they were cheap by being
// wrong. texture-check and parameters did get smaller. The budget below is
// about keeping each call proportionate to its job, not about shrinking.
test("each stage's prompt stays within its budget", () => {
  const budget = { route: 6000, geometry: 15000, "geometry-check": 15000, texture: 13000, "texture-check": 13000, parameters: 12000 };
  const sizes = {};
  for (const stage of STAGES) {
    const n = composeSystemPrompt(stage, { docs, scene: scene(), C }).length;
    sizes[stage] = n;
    assert.ok(n <= budget[stage], `${stage} prompt is ${n} chars, over its ${budget[stage]} budget`);
  }
  // texture used to carry the whole machine + geometry reference (~18KB)
  assert.ok(sizes.texture < sizes.geometry, `texture ${sizes.texture} should now be leaner than geometry ${sizes.geometry}`);
  console.log("     sizes:", Object.entries(sizes).map(([k, v]) => `${k} ${v}`).join(", "));
});

test("code-mirroring text is generated, not written in a doc", () => {
  const texture = composeSystemPrompt("texture", { docs, scene: scene(), C });
  assert.ok(texture.includes(C.limitsText()), "the enforced limits come from limitsText() verbatim");
  assert.ok(texture.includes(C.legibilityText()), "the legibility guidance comes from legibilityText() verbatim");
  // and no doc reintroduces a hand-written copy of a limit
  for (const [p, text] of Object.entries(docs)) {
    assert.ok(!/retraction cycles in the job/.test(text), `${p} hand-copies a limit`);
  }
});

test("the material line follows the session, not a doc", () => {
  const s = scene();
  assert.ok(/material = TPU/.test(composeSystemPrompt("geometry", { docs, scene: s, C })));
  s.config.material = "PLA";
  const pla = composeSystemPrompt("geometry", { docs, scene: s, C });
  assert.ok(/material = PLA/.test(pla) && /PLA start sequence/.test(pla));
});

test("only the router sees the conversation, and only a capped slice", () => {
  const s = scene();
  const user = composeUserMessage("geometry", { scene: s, C, instruction: "add a second bar", targets: ["el_2"] });
  assert.ok(!/RECENT CONVERSATION/.test(user), "a stage works from the self-contained instruction, not the history");
  assert.ok(user.includes("add a second bar") && user.includes("TARGET ELEMENTS: el_2"));
  assert.ok(user.includes("CURRENT ELEMENTS"), "geometry sees the elements");
  assert.ok(!user.includes("OPTION SPECS"), "geometry does not set options");

  const tex = composeUserMessage("texture", { scene: s, C, instruction: "shade it", targets: [] });
  assert.ok(tex.includes("printed size"), "texture needs measured sizes");
  assert.ok(tex.includes("TARGET ELEMENTS: (whole scene)"));

  const par = composeUserMessage("parameters", { scene: s, C, instruction: "denser", targets: [] });
  assert.ok(par.includes("OPTION SPECS") && /spacing/.test(par), "parameters gets the specs for the brushes in use");

  // the router's own transcript is merged by role and capped
  s.messages = [];
  for (let i = 0; i < 40; i++) s.messages.push({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` });
  const msgs = composeRouteMessages(s, { maxTurns: 12 });
  assert.equal(msgs.length, 12, "capped");
  assert.ok(msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1].role), "roles alternate for both providers");
  assert.ok(msgs[msgs.length - 1].content.includes("turn 39"), "the cap keeps the most recent turns");
});

test("a broken scene's errors reach the next call", () => {
  const s = scene();
  s.elements.push({ id: "el_3", label: "bowtie", kind: "region", boundary: [{ points: [[40, 40], [80, 80], [80, 40], [40, 80], [40, 40]] }] });
  const compiled = C.compileScene(s);
  assert.ok(compiled.errors.length, "fixture really is broken");

  const status = compileStatusText(compiled);
  assert.ok(/BLOCKING ERRORS/.test(status) && /crosses itself/.test(status));
  const user = composeUserMessage("geometry", { scene: s, C, instruction: "fix it", compiled });
  assert.ok(user.includes("COMPILE STATUS") && user.includes("crosses itself"));

  assert.ok(/compiles cleanly/.test(compileStatusText(C.compileScene(scene()))));
  assert.ok(/not been compiled/.test(compileStatusText(null)));
});

test("a repair call hands the stage its own errors and its own last answer", () => {
  const user = composeUserMessage("geometry", {
    scene: scene(), C, instruction: "three bars",
    repair: { errors: ['"bar 2": path leaves the safe area'], previous: '{"elements":[]}' },
  });
  assert.ok(user.startsWith("REPAIR:"), "the repair framing comes first");
  assert.ok(user.includes("leaves the safe area"), "the exact error, not a paraphrase");
  assert.ok(user.includes('{"elements":[]}'), "and what it previously answered");
  assert.ok(user.includes("three bars"), "the original instruction is still there");
});

test("an unknown stage or an unloaded doc fails loudly", () => {
  assert.throws(() => composeSystemPrompt("nope", { docs, scene: scene(), C }), /no docs configured/);
  assert.throws(() => composeSystemPrompt("geometry", { docs: {}, scene: scene(), C }), /was not loaded/);
});

console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
