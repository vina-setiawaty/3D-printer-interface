// Offline tests for the scene compiler (no LLM involved):
//   node tests/parametric/compile-fixtures.mjs
// Scene -> jobs -> G-code, transform math, clipping, the abstraction rule,
// stage-output validation and merging.

import assert from "node:assert/strict";
import * as C from "../../sewingeditor/parametric-with-tool/parametric-catalog-with-tool.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const rect = (x0, y0, w, h) => ({ points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]] });

function barChart() {
  const s = C.defaultScene();
  s.elements = [
    { id: "el_1", label: "x axis", kind: "line", role: "axis", path: { points: [[40, 40], [120, 40]] } },
    { id: "el_2", label: "bar 1", kind: "region", role: "bar", boundary: [rect(50, 40, 15, 5)] },
    { id: "el_3", label: "bar 2", kind: "region", role: "bar", boundary: [rect(75, 40, 15, 12)] },
    { id: "el_4", label: "bar 3", kind: "region", role: "bar", boundary: [rect(100, 40, 15, 8)] },
    { id: "el_5", label: "peak", kind: "point", role: "marker", at: [82.5, 60] },
  ];
  s.textures = {
    el_1: { brush: { fn: "solid", options: {} } },
    el_2: { outline: { fn: "solid", options: {} }, fill: { fn: "solid", options: {}, pattern: { kind: "hatch", angleDeg: 0, gap: 1 } } },
    el_3: { outline: { fn: "solid", options: {} }, fill: { fn: "hairy", options: { spacing: 4 }, pattern: { kind: "hatch", angleDeg: 90, gap: 4 } } },
    el_4: { fill: { fn: "blob", options: {}, pattern: { kind: "grid", dx: 4, dy: 4 } } },
    el_5: { brush: { fn: "blob", options: {} } },
  };
  return s;
}

test("bar chart compiles, report lists bar heights in order", () => {
  const s = barChart();
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.report.chart.bars.map((b) => b.height).join(","), "5,12,8");
  assert.equal(r.report.chart.axes.length, 1);
  const kinds = r.jobs.map((j) => `${j.elementId}:${j.slot}:${j.kind}`);
  assert.ok(kinds.includes("el_1:brush:brush") && kinds.includes("el_2:outline:brush") && kinds.includes("el_2:fill:brush"));
  assert.ok(r.jobs.filter((j) => j.elementId === "el_4" && j.kind === "stamp").length > 4, "grid stamps inside bar 3");
  assert.ok(r.jobs.some((j) => j.elementId === "el_5" && j.kind === "stamp"));
  // outline before fill within the element, elements in order
  const order = r.jobs.map((j) => `${j.elementId}:${j.slot}`);
  assert.ok(order.indexOf("el_2:outline") < order.indexOf("el_2:fill"));
  const g = C.runJobs(r.jobs);
  assert.ok(g.ok, g.errors.join("; "));
  assert.ok(g.digest.lineCount > 100 && g.digest.boundsOk);
});

test("transform: scale 1.2 moves the bbox, pattern spacing scales, brush options do not", () => {
  const s = barChart();
  const base = C.compileScene(s);
  s.transform = { scale: 1.2, origin: [30, 30] };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.report.bbox.minX, 30);
  assert.equal(r.report.bbox.minY, 30);
  assert.equal(r.report.chart.bars[1].height, +(12 * 1.2).toFixed(2));
  const baseHatch = base.jobs.filter((j) => j.elementId === "el_2" && j.slot === "fill");
  const scaledHatch = r.jobs.filter((j) => j.elementId === "el_2" && j.slot === "fill");
  // gap scales with the region: row pitch 1 -> 1.2 (row COUNT may differ by
  // one when the last row lands exactly on the top edge)
  assert.ok(Math.abs(baseHatch.length - scaledHatch.length) <= 1, "hatch row count within one of the unscaled fill");
  assert.equal(+(scaledHatch[1].pts[0][1] - scaledHatch[0].pts[0][1]).toFixed(3), 1.2, "row pitch scaled");
  const hairy = r.jobs.find((j) => j.elementId === "el_3" && j.slot === "fill");
  assert.equal(hairy.options.spacing, 4, "brush mm untouched");
  assert.ok(r.jobs.every((j) => (j.pts || [j.at]).every((p) => p[0] >= 30 - 1e-9 && p[1] >= 30 - 1e-9)));
});

test("out of safe area is a hard error", () => {
  const s = barChart();
  s.transform = { scale: 2.5, origin: [100, 100] };
  const r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /safe area/.test(e)), r.errors.join("; "));
});

test("region between two curves via ref pieces closes and fills", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "a", label: "y=x", kind: "line", role: "curve", path: { x: "40 + 60*t", y: "40 + 60*t", tEnd: 1 } },
    { id: "b", label: "y=x^2", kind: "line", role: "curve", path: { x: "40 + 60*t", y: "40 + 60*t^2", tEnd: 1 } },
    { id: "r", label: "between", kind: "region", boundary: [{ ref: "a" }, { ref: "b", reverse: true }] },
  ];
  s.textures = {
    a: { brush: { fn: "solid", options: {} } }, b: { brush: { fn: "dashed", options: {} } },
    r: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", angleDeg: 0, gap: 3 } } },
  };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const region = r.report.elements.find((e) => e.id === "r");
  assert.ok(region.closureGap < 0.01, `closure ${region.closureGap}`);
  assert.ok(region.area > 500 && region.area < 700, `lens area ${region.area}`);   // 60*60/6 = 600
  assert.ok(region.fill.strokes > 5);
  assert.ok(C.runJobs(r.jobs).ok);
});

test("family, curves, strokes and stamps patterns are clipped to the region", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "c", label: "disc", kind: "region", boundary: [{ x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 2 * Math.PI }] }];
  const inside = (r) => r.jobs.every((j) => (j.pts || [j.at]).every(([x, y]) => Math.hypot(x - 110, y - 110) <= 30 + 0.05));

  s.textures = { c: { fill: { fn: "solid", options: {}, pattern: { kind: "family", x: "110 + t*cos(u)", y: "110 + t*sin(u)", tEnd: 40, uEnd: 3.1, uStep: 0.4 } } } };
  let r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.jobs.length >= 8 && inside(r), "radial family clipped");

  s.textures = { c: { fill: { fn: "solid", options: {}, pattern: { kind: "curves", curves: [{ x: "60 + t", y: "110 + 10*sin(t/5)", tEnd: 100 }] } } } };
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.jobs.length === 1 && inside(r), "wavy curve clipped to one run");

  s.textures = { c: { fill: { fn: "solid", options: {}, pattern: { kind: "strokes", strokes: [[[60, 110], [160, 110]], [[110, 60], [110, 160]]] } } } };
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.length, 2);
  assert.ok(inside(r));
  assert.ok(Math.abs(r.jobs[0].pts[0][0] - 80) < 0.1, "stroke clipped at the circle (sampled polygon chord)");
  assert.ok(Math.abs(r.jobs[0].pts[r.jobs[0].pts.length - 1][0] - 140) < 0.1, "stroke clipped at the vertex on the far side");

  s.textures = { c: { fill: { fn: "blob", options: {}, pattern: { kind: "stamps", points: [[110, 110], [100, 100], [200, 200]] } } } };
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.length, 2, "stamp outside the region dropped");
});

test("diamond needs a rectangle; one newPattern for the whole fill", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "d", label: "box", kind: "region", boundary: [rect(60, 60, 40, 30)] }];
  s.textures = { d: { fill: { fn: "solid", options: {}, pattern: { kind: "diamond", diag: 8, fillGap: 0.6 } } } };
  let r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.filter((j) => j.newPattern).length, 1);
  assert.ok(r.jobs.every((j) => j.options.width === 0.4));
  s.elements[0].boundary = [{ x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 2 * Math.PI }];
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /rectangular/.test(e)));
});

test("verification: closure warning, self-intersection, brush/pattern mismatch, relief floor", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "z", label: "bow", kind: "region", boundary: [{ points: [[40, 40], [80, 80], [80, 40], [40, 80], [40, 40]] }] }];
  let r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /crosses itself/.test(e)));

  s.elements = [{ id: "o", label: "open arc", kind: "region", boundary: [{ x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 4 }] }];
  r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /straight edge/.test(w)));

  s.textures = { o: { fill: { fn: "blob", options: {}, pattern: { kind: "hatch", gap: 4 } } } };
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /must be a line brush/.test(e)));

  s.textures = { o: { outline: { fn: "solid", options: { nLayers: 1 } } } };
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /nLayers/.test(e)));

  s.textures = { o: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 0.2 } } } };
  r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /over-extrusion/.test(e)));
});

test("fill-on-fill overlap warns; outline around own fill does not", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "a", label: "A", kind: "region", boundary: [rect(40, 40, 30, 30)] },
    { id: "b", label: "B", kind: "region", boundary: [rect(55, 55, 30, 30)] },
  ];
  s.textures = {
    a: { outline: { fn: "solid", options: {} }, fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 4 } } },
    b: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", gap: 4 } } },
  };
  let r = C.compileScene(s);
  assert.ok(r.warnings.some((w) => /overlap/.test(w)));
  s.elements[1].boundary = [rect(80, 40, 30, 30)];
  r = C.compileScene(s);
  assert.ok(!r.warnings.some((w) => /overlap/.test(w)));
});

test("abstraction rule: weights normalize, contributions sum, manual edit rebases, clamp", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "h", label: "patch", kind: "region", boundary: [rect(40, 40, 30, 30)] }];
  s.textures = { h: { fill: { fn: "hairy", options: { spacing: 6, bigLift: 4 }, pattern: { kind: "hatch", gap: 5 } } } };
  s.abstractions = [{
    id: "ab_1", name: "hairiness", value: 0.5, v0: 0.5,
    targets: [
      { elementId: "h", slot: "fill", option: "bigLift", weight: 3, direction: 1 },
      { elementId: "h", slot: "fill", option: "spacing", weight: 1, direction: -1 },
    ],
  }];
  assert.deepEqual(C.normalizedWeights(s.abstractions[0].targets), [0.75, 0.25]);
  assert.deepEqual(C.normalizedWeights([{ weight: -1 }, { weight: "x" }]), [0.5, 0.5]);

  C.applyAbstractions(s);
  const fill = s.textures.h.fill;
  assert.equal(fill.options.bigLift, 4, "at v0 the base is reproduced");
  assert.equal(fill.options.spacing, 6);

  s.abstractions[0].value = 1.0;
  C.applyAbstractions(s);
  // bigLift span 1..10 = 9, 0.75 * 0.5 * 9 = 3.375 ; spacing span 1..30 = 29, -0.25 * 0.5 * 29 = -3.625
  assert.equal(fill.options.bigLift, 7.375);
  assert.equal(fill.options.spacing, 2.375);

  // a second abstraction sharing spacing adds its own contribution
  s.abstractions.push({ id: "ab_2", name: "density", value: 0.5, v0: 0.5, targets: [{ elementId: "h", slot: "fill", option: "spacing", weight: 1, direction: -1 }] });
  s.abstractions[1].value = 0.0;   // less dense -> spacing up by 0.5 * 29 = 14.5
  C.applyAbstractions(s);
  assert.equal(fill.options.spacing, 16.875);

  // manual edit rebases: sliders unchanged, edited value reproduced
  C.rebaseOption(s, "h", "fill", "spacing", 8);
  C.applyAbstractions(s);
  assert.equal(fill.options.spacing, 8);
  assert.equal(s.abstractions[0].value, 1.0);

  // clamp to the option range
  s.abstractions[0].value = 0.0; s.abstractions[1].value = 0.0;
  C.applyAbstractions(s);
  assert.ok(fill.options.spacing <= 30 && fill.options.bigLift >= 1);
  assert.equal(C.driversOf(s, "h", "fill", "spacing").length, 2);
});

test("parameters stage: an empty/null option value is skipped, not stored (regression: blank fields)", () => {
  const s = C.defaultScene();
  s.elements = [{ id: "b", label: "bar", kind: "region", boundary: [rect(40, 40, 20, 20)] }];
  s.textures = { b: { fill: { fn: "solid", options: { width: 0.6 }, pattern: { kind: "hatch", angleDeg: 0, gap: 4 } } } };
  const par = C.validateStageOutput("parameters", {
    chat: "denser",
    options: [{ elementId: "b", slot: "fill", options: JSON.stringify({ width: "", nLayers: null, speed: "400", gap: "" }) }],
    abstractions: [],
  }, s);
  assert.deepEqual(par.errors, [], "empty/null values are skipped, not rejected");
  assert.deepEqual(par.value.options[0].options, { speed: 400 }, "empty/null keys omitted; a numeric string coerces");
  assert.deepEqual(par.value.options[0].patternOptions, {}, "an empty pattern value is also skipped, not stored as \"\"");
  C.mergeParameters(s, par.value);
  assert.equal(s.textures.b.fill.options.width, 0.6, "left alone, not overwritten with \"\"");
  assert.equal(s.textures.b.fill.pattern.gap, 4, "left alone, not overwritten with \"\"");

  const bad = C.validateStageOutput("parameters", {
    chat: "denser",
    options: [{ elementId: "b", slot: "fill", options: JSON.stringify({ width: "wide", gap: "loose" }) }],
    abstractions: [],
  }, s);
  assert.equal(bad.errors.length, 2, "non-numeric garbage is a real error, not silently dropped");
  assert.ok(bad.errors.every((e) => /must be a number/.test(e)));
});

test("abstraction can target a fill PATTERN option, not just its brush (regression: reported production failure)", () => {
  // A solid brush has no "gap" option -- "gap" here can only be the hatch
  // PATTERN's own spacing. Before resolveTarget() this was rejected as
  // "not a numeric option of solid".
  const s = C.defaultScene();
  s.elements = [{ id: "b", label: "bar", kind: "region", boundary: [rect(40, 40, 20, 20)] }];
  s.textures = { b: { fill: { fn: "solid", options: {}, pattern: { kind: "hatch", angleDeg: 0, gap: 4 } } } };
  assert.equal(C.resolveTarget(s, "b", "fill", "gap").location, "pattern");
  assert.equal(C.resolveTarget(s, "b", "fill", "width").location, "options", "the brush's own option still resolves too");
  assert.equal(C.resolveTarget(s, "b", "fill", "nonsense"), null);

  s.abstractions = [{ id: "ab_1", name: "density", value: 0.5, v0: 0.5, targets: [{ elementId: "b", slot: "fill", option: "gap", weight: 1, direction: -1 }] }];
  C.applyAbstractions(s);
  assert.equal(s.textures.b.fill.pattern.gap, 4, "v0 reproduces the base");
  s.abstractions[0].value = 1;
  C.applyAbstractions(s);
  assert.ok(s.textures.b.fill.pattern.gap < 4, "denser (higher knob) -> smaller gap");
  assert.equal(s.textures.b.fill.options.gap, undefined, "never written to the brush's own options");

  // manual edit of the pattern field rebases like a brush option would
  C.rebaseOption(s, "b", "fill", "gap", 2);
  C.applyAbstractions(s);
  assert.equal(s.textures.b.fill.pattern.gap, 2);

  // the parameters-stage validator now accepts "gap" for this fill slot,
  // both as a direct option edit and as an abstraction target
  const par = C.validateStageOutput("parameters", {
    chat: "denser",
    options: [{ elementId: "b", slot: "fill", options: JSON.stringify({ gap: 1.5 }) }],
    abstractions: [{ id: "", name: "density", description: "d", value: 0.5, targets: JSON.stringify([{ elementId: "b", slot: "fill", option: "gap", weight: 1, direction: -1 }]) }],
  }, s);
  assert.deepEqual(par.errors, []);
  assert.equal(par.value.options[0].patternOptions.gap, 1.5);
  assert.deepEqual(par.value.options[0].options, {});
  C.mergeParameters(s, par.value);
  assert.equal(s.textures.b.fill.pattern.gap, 1.5);
  assert.equal(C.compileScene(s).errors.length, 0);
});

test("line group (tick marks): one element, one texture, N stroke jobs", () => {
  const s = C.defaultScene();
  const ticks = [];
  for (let x = 40; x <= 100; x += 10) ticks.push({ points: [[x, 40], [x, 43]] });
  s.elements = [
    { id: "el_1", label: "x axis", kind: "line", role: "axis", path: { points: [[40, 40], [100, 40]] } },
    { id: "el_2", label: "x-axis ticks", kind: "line", role: "tick", paths: ticks },
  ];
  s.textures = { el_1: { brush: { fn: "solid", options: {} } }, el_2: { brush: { fn: "solid", options: { width: 0.3 } } } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  const tickJobs = r.jobs.filter((j) => j.elementId === "el_2");
  assert.equal(tickJobs.length, ticks.length, "one brush job per tick");
  assert.ok(tickJobs.every((j) => j.fn === "solid" && j.options.width === 0.3 && j.newPattern), "same texture, each a separate stroke");
  const entry = r.report.elements.find((e) => e.id === "el_2");
  assert.equal(entry.strokeCount, ticks.length);
  assert.equal(entry.samples.length, ticks.length);
  assert.ok(C.runJobs(r.jobs).ok);

  // one texture assignment, one abstraction, drives the WHOLE group at once
  s.abstractions = [{ id: "ab_1", name: "tick boldness", value: 1, v0: 0.5, targets: [{ elementId: "el_2", slot: "brush", option: "width", weight: 1, direction: 1 }] }];
  C.applyAbstractions(s);
  const r2 = C.compileScene(s);
  assert.ok(r2.jobs.filter((j) => j.elementId === "el_2").every((j) => j.options.width === s.textures.el_2.brush.options.width), "every tick stroke picks up the same driven value");
});

test("point group (data markers): one element, one texture, N stamp jobs", () => {
  const s = C.defaultScene();
  const marks = [[45, 60], [55, 68], [65, 61], [75, 70]];
  s.elements = [{ id: "el_1", label: "markers", kind: "point", role: "marker", at: marks }];
  s.textures = { el_1: { brush: { fn: "blob", options: { diameter: 2 } } } };
  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.jobs.length, marks.length);
  assert.ok(r.jobs.every((j) => j.kind === "stamp" && j.fn === "blob" && j.options.diameter === 2));
  const entry = r.report.elements.find((e) => e.id === "el_1");
  assert.equal(entry.count, marks.length);
  assert.equal(entry.at.length, marks.length);
  assert.ok(C.runJobs(r.jobs).ok);
});

test("a ref cannot target a line GROUP (ambiguous which stroke)", () => {
  const s = C.defaultScene();
  s.elements = [
    { id: "g", label: "ticks", kind: "line", role: "tick", paths: [{ points: [[40, 40], [40, 43]] }, { points: [[50, 40], [50, 43]] }] },
    { id: "r", label: "bad ref", kind: "region", boundary: [{ ref: "g" }, { points: [[40, 60], [50, 60]] }] },
  ];
  const r = C.compileScene(s);
  assert.ok(r.errors.some((e) => /repeated group/.test(e)));
});

test("stage validation + merge round trip", () => {
  const s = C.defaultScene();
  const geo = C.validateStageOutput("geometry", {
    chat: "built", transform: "",
    elements: [
      { id: "el_1", label: "axis", kind: "line", role: "axis", geometry: JSON.stringify({ path: { points: [[40, 40], [100, 40]] } }) },
      { id: "", label: "bar", kind: "region", role: "bar", geometry: JSON.stringify({ boundary: [rect(50, 40, 10, 20)] }) },
      { id: "el_1", label: "dup id", kind: "point", role: "", geometry: JSON.stringify({ at: [60, 70] }) },
      { id: "", label: "ticks", kind: "line", role: "tick", geometry: JSON.stringify({ paths: [{ points: [[40, 40], [40, 43]] }, { points: [[50, 40], [50, 43]] }] }) },
    ],
  }, s);
  assert.deepEqual(geo.errors, []);
  assert.deepEqual(geo.value.elements.map((e) => e.id), ["el_1", "el_2", "el_3", "el_4"]);
  assert.deepEqual(geo.value.elements[3].paths.map((p) => p.points[0]), [[40, 40], [50, 40]]);
  C.mergeGeometry(s, geo.value);
  assert.equal(s.elements.length, 4);
  assert.deepEqual(C.elementsJson(s, ["el_4"])[0].geometry, { paths: geo.value.elements[3].paths });

  const tex = C.validateStageOutput("texture", {
    chat: "textured",
    textures: [
      { elementId: "el_1", slot: "brush", fn: "solid", pattern: "" },
      { elementId: "el_2", slot: "outline", fn: "dashed", pattern: "" },
      { elementId: "el_2", slot: "fill", fn: "hairy", pattern: JSON.stringify({ kind: "hatch", gap: 5 }) },
      { elementId: "el_3", slot: "brush", fn: "solid", pattern: "" },   // a point needs a stamp
      { elementId: "el_9", slot: "brush", fn: "solid", pattern: "" },   // unknown id
    ],
  }, s);
  assert.equal(tex.errors.length, 2, tex.errors.join("; "));

  const tex2 = C.validateStageOutput("texture", {
    chat: "textured",
    textures: [
      { elementId: "el_1", slot: "brush", fn: "solid", pattern: "" },
      { elementId: "el_2", slot: "outline", fn: "dashed", pattern: "" },
      { elementId: "el_2", slot: "fill", fn: "hairy", pattern: JSON.stringify({ kind: "hatch", gap: 5 }) },
      { elementId: "el_3", slot: "brush", fn: "blob", pattern: "" },
    ],
  }, s);
  assert.deepEqual(tex2.errors, []);
  C.mergeTextures(s, tex2.value);
  assert.equal(s.textures.el_2.fill.pattern.kind, "hatch");

  const par = C.validateStageOutput("parameters", {
    chat: "params",
    options: [
      { elementId: "el_2", slot: "fill", options: JSON.stringify({ spacing: 5, bigLift: 3, bogus: 1 }) },
    ],
    abstractions: [
      { id: "", name: "hairiness", description: "d", value: 0.5, targets: JSON.stringify([{ elementId: "el_2", slot: "fill", option: "bigLift", weight: 0.6, direction: 1 }, { elementId: "el_2", slot: "fill", option: "spacing", weight: 0.4, direction: -1 }]) },
    ],
  }, s);
  assert.equal(par.errors.length, 1, "bogus option rejected");   // bogus option
  C.mergeParameters(s, par.value);
  assert.equal(s.abstractions[0].id, "ab_1");
  assert.equal(s.textures.el_2.fill.options.spacing, 5);
  s.abstractions[0].value = 1;
  C.applyAbstractions(s);
  assert.ok(s.textures.el_2.fill.options.bigLift > 3 && s.textures.el_2.fill.options.spacing < 5);

  // texture change to a different fn drops the abstraction targets
  C.mergeTextures(s, { textures: [{ elementId: "el_2", slot: "fill", fn: "solid", pattern: { kind: "hatch", gap: 4 } }] });
  assert.equal(s.abstractions.length, 0);

  const r = C.compileScene(s);
  assert.deepEqual(r.errors, []);
  assert.ok(C.sceneSummary(s).includes("el_2"));
  assert.ok(C.optionSpecsText(s).includes("segLen"));
  const route = C.validateStageOutput("route", { route: "texture", instruction: "densify el_2", targets: ["el_2", "nope"], reply: "" }, s);
  assert.deepEqual(route.value.targets, ["el_2"]);
});

test("normalizeScene discards old formats", () => {
  assert.equal(C.normalizeScene({ messages: [], calls: [] }).elements.length, 0);
  assert.equal(C.normalizeScene(null).version, C.SCENE_VERSION);
});

console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
