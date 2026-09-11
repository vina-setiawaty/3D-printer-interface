// parametric-with-tool.html -- four-stage LLM pipeline for tactile graphics.
//
// Column 1: a multi-turn chat. Column 2: the parameter panel (global
// transform, elements with their textures, high-level abstraction knobs,
// remaining brush options). Column 3: the geometry report, the print
// digest and the generated G-code (the shared #raw-gcode-textarea +
// run/save wiring from script.js).
//
// A user message goes to the ROUTE stage, which rewrites it as a
// self-contained instruction and picks the entry stage; the page then
// chains geometry -> texture -> parameters (or a suffix of that) through
// /api/parametric-stage. Every stage's JSON is validated and merged into
// the SCENE by parametric-catalog-with-tool.js, which also compiles the
// scene to G-code locally -- editing anything in column 2 re-generates
// without an API round-trip.
//
// This is an ES module; it reads llm.js's classic-script helpers
// (escapeHtml, readJsonResponse, wasTruncated, extractResponseOutput,
// recordCost, renderCostTracker, updateModelOptions, saveAppSecretFrom,
// loadAppSecretInto) as globals, and exposes initParametricEditor on
// window for parametric-with-tool-compat.js.

const STORAGE_KEY = "parametricWithToolSessionState";
const DEBUG_LOG_KEY = "parametricWithToolDebugLog";
const DEBUG_LOG_MAX_TURNS = 15;   // localStorage is finite; keep the most recent turns

// Prompt docs per stage. A doc wrapped in a ``` fence contributes only the
// fenced block; a plain doc is used whole.
const STAGE_DOCS = {
  route: ["docs/stage-route.md"],
  geometry: ["docs/stage-geometry.md", "docs/reference-machine.md"],
  "geometry-check": ["docs/stage-geometry-check.md", "docs/reference-machine.md"],
  texture: ["docs/stage-texture.md", "docs/reference-machine.md", "docs/reference-brushes.md"],
  "texture-check": ["docs/stage-texture-check.md", "docs/reference-machine.md", "docs/reference-brushes.md"],
  parameters: ["docs/stage-parameters.md", "docs/reference-brushes.md"],
};
const CHAIN = { geometry: ["geometry", "texture", "parameters"], texture: ["texture", "parameters"], parameters: ["parameters"], chat: [] };
const STAGE_LABEL = { route: "routing", geometry: "geometry", texture: "texture", parameters: "parameters" };
// A *-check call reuses the "geometry"/"texture" output validator (same
// per-item shape -- see api/parametric-stage.js's shared item schemas);
// only the top-level `ok` boolean is read separately, straight off the
// raw parsed JSON, since it has no nested-JSON field that needs parsing.
const VALIDATOR_FOR_STAGE = { route: "route", geometry: "geometry", "geometry-check": "geometry", texture: "texture", "texture-check": "texture", parameters: "parameters" };
// Fill pattern kinds whose coordinates the model writes itself -- these
// are the only ones worth a texture-check pass; hatch/grid/diamond are
// recomputed deterministically from the region and can't be "wrong".
const FREEFORM_PATTERN_KINDS = ["stamps", "strokes", "curves", "family"];

let C = null;              // parametric-catalog-with-tool.js module
let docs = {};             // path -> text
let ready = false;
let scene = null;
let rerunTimer = null;
let pending = null;        // { instruction, targets, remaining: [stage...] } for retry
let busy = false;

// Debug log: one entry per user turn, each holding every stage call that
// turn triggered (route, then whichever chain), with the RAW text the
// model returned -- before JSON.parse, before validation -- so a broken
// response (malformed JSON, a rejected field, a timeout) is inspectable
// after the fact instead of only a summarized error message. Persisted
// separately from the scene so "new conversation" doesn't lose it.
let debugLog = [];
let currentDebugTurn = null;

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- state --

function loadScene() {
  try { return C.normalizeScene(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); }
  catch (e) { return C.defaultScene(); }
}
function saveScene() { localStorage.setItem(STORAGE_KEY, JSON.stringify(scene)); }

function loadDebugLog() {
  try {
    const v = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function saveDebugLog() {
  while (debugLog.length > DEBUG_LOG_MAX_TURNS) debugLog.shift();
  try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLog)); }
  catch (e) { /* quota exceeded -- drop the oldest half and try once more */
    debugLog = debugLog.slice(Math.ceil(debugLog.length / 2));
    try { localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(debugLog)); } catch (e2) { /* give up silently */ }
  }
}

// Starts a new turn in the debug log (one user input -> one or more
// stage calls). Call once per onSend(), before any callStage().
function beginDebugTurn(userInput) {
  currentDebugTurn = { at: new Date().toISOString(), userInput, calls: [] };
  debugLog.push(currentDebugTurn);
  saveDebugLog();
}

// Appends one call's record to the current turn (or a turn-less
// fallback, so a retry outside onSend() still gets logged). Called from
// callStage() via a try/finally so a thrown error still gets logged.
function logDebugCall(record) {
  if (!currentDebugTurn) { currentDebugTurn = { at: new Date().toISOString(), userInput: "(no turn context)", calls: [] }; debugLog.push(currentDebugTurn); }
  currentDebugTurn.calls.push(record);
  saveDebugLog();
}

function formatDebugLog(log) {
  if (!log.length) return "(the debug log is empty)";
  const pretty = (text) => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch (e) { return text; } };
  const lines = [`parametric-with-tool debug log -- ${log.length} turn(s), exported ${new Date().toISOString()}`, ""];
  log.forEach((turn, i) => {
    lines.push(`${"=".repeat(70)}`, `TURN ${i + 1} -- ${turn.at}`, `USER: ${turn.userInput}`, "");
    for (const c of turn.calls) {
      lines.push(`${"-".repeat(70)}`, `[${c.stage}]  ${c.provider || ""} ${c.model || ""}${c.usage ? `  (in=${c.usage.input_tokens ?? "?"} out=${c.usage.output_tokens ?? "?"})` : ""}`);
      lines.push(`settings: effort=${c.effort ?? "?"}  thinking=${c.thinking ?? "?"}  self-check=${c.selfCheck ?? "?"}  material=${c.material ?? "?"}`, "");
      lines.push("user message sent:", c.userMessage || "(none)", "");
      if (c.networkError) lines.push("NETWORK ERROR:", c.networkError, "");
      if (c.httpError) lines.push("HTTP/PROXY ERROR:", c.httpError, "");
      if (c.refusal) lines.push("MODEL REFUSED:", c.refusal, "");
      if (c.rawOutput != null) lines.push("raw model output:", pretty(c.rawOutput), "");
      if (c.parseError) lines.push("JSON PARSE ERROR:", c.parseError, "");
      if (c.validationErrors && c.validationErrors.length) lines.push("VALIDATION REJECTED:", c.validationErrors.join("\n"), "");
      if (!c.networkError && !c.httpError && !c.refusal && !c.parseError && !(c.validationErrors && c.validationErrors.length)) lines.push("(accepted)", "");
    }
    lines.push("");
  });
  return lines.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// -------------------------------------------------------------- loading --

async function loadDeps() {
  const status = $("#pg-status");
  status.textContent = "loading texture library…";
  try {
    C = await import("./parametric-catalog-with-tool.js");
  } catch (e) {
    status.textContent = "";
    $("#pg-messages").innerHTML = `<li>could not load parametric-catalog-with-tool.js: ${escapeHtml(String(e.message || e))}</li>`;
    return;
  }
  scene = loadScene();
  debugLog = loadDebugLog();
  $("#pg-material").value = scene.config.material;
  try {
    const paths = [...new Set(Object.values(STAGE_DOCS).flat())];
    await Promise.all(paths.map(async (path) => {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
      const text = await r.text();
      const fenced = text.match(/```([\s\S]*?)```/);
      docs[path] = fenced ? fenced[1].trim() : text;
    }));
  } catch (e) {
    status.textContent = "";
    $("#pg-messages").innerHTML = `<li>could not load the prompt docs: ${escapeHtml(String(e.message || e))}</li>`;
    return;
  }
  ready = true;
  status.textContent = "";
  $("#pg-send-btn").classList.remove("disabled");
  renderTranscript();
  rerenderAll();
}

// ------------------------------------------------------- stage requests --

function systemPromptFor(stage) {
  const mat = scene.config.material || "TPU";
  const body = STAGE_DOCS[stage].map((p) => docs[p]).join("\n\n---\n\n");
  const session = `\n\n---\n\nSESSION: material = ${mat}.` + (mat === "PLA" ? " Use PLA numbers; the page emits a PLA start sequence." : " Use TPU numbers (the library defaults).");
  if (stage === "route") return `${body}\n\n---\n\nSCENE SUMMARY:\n${C.sceneSummary(scene)}`;
  return body + session;
}

// The router sees the whole transcript (consecutive same-role turns merged
// so both providers accept it). Other stages are single-turn.
function routeMessages() {
  const out = [];
  for (const m of scene.messages) {
    const content = m.stage && m.role === "assistant" ? `[${m.stage}] ${m.content}` : m.content;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + content;
    else out.push({ role: m.role, content });
  }
  return out;
}

function recentConversation(n = 3) {
  const turns = scene.messages.slice(-n - 1, -1);   // exclude the current user turn
  if (!turns.length) return "(none)";
  return turns.map((m) => `${m.role}${m.stage ? ` (${m.stage})` : ""}: ${m.content}`).join("\n");
}

// One array item per line, each compact -- readable for the model without
// pretty-printing every coordinate onto its own line.
function jsonLines(arr) {
  if (!Array.isArray(arr) || !arr.length) return "[]";
  return "[\n" + arr.map((x) => "  " + JSON.stringify(x)).join(",\n") + "\n]";
}

function stageUserMessage(stage, instruction, targets) {
  const ids = targets.length ? targets : null;
  const parts = [`INSTRUCTION:\n${instruction}`, `TARGET ELEMENTS: ${targets.length ? targets.join(", ") : "(whole scene)"}`];
  parts.push(`RECENT CONVERSATION:\n${recentConversation()}`);
  if (stage === "geometry") {
    parts.push(`CURRENT ELEMENTS (JSON):\n${jsonLines(C.elementsJson(scene))}`);
    parts.push(`CURRENT TRANSFORM: ${JSON.stringify(scene.transform)}`);
  } else {
    const els = C.elementsJson(scene).map((e) => {
      const rep = scene.lastReport?.elements?.find((r) => r.id === e.id);
      return { ...e, size: rep ? { bbox: rep.bbox, length: rep.length, area: rep.area, width: rep.width, height: rep.height } : undefined };
    });
    parts.push(`ELEMENTS (JSON, geometry + printed size):\n${jsonLines(els)}`);
    parts.push(`CURRENT TEXTURES (JSON):\n${jsonLines(C.texturesJson(scene))}`);
  }
  if (stage === "parameters") {
    parts.push(`OPTION SPECS for the brushes/stamps in use:\n${C.optionSpecsText(scene, ids) || "(no textures yet)"}`);
    parts.push(`CURRENT ABSTRACTIONS (JSON):\n${jsonLines(scene.abstractions)}`);
  }
  parts.push(`LATEST GEOMETRY REPORT:\n${C.reportText(scene.lastReport)}`);
  return parts.join("\n\n");
}

// `contextScene` defaults to the live scene; a *-check call passes a
// draft scene-like object instead, since its response's elementIds may
// reference elements the real scene hasn't merged yet.
async function callStage(stage, messages, contextScene = scene) {
  const secret = $("#pg-app-secret").value;
  const provider = $("#pg-provider").value;
  const model = $("#pg-model").value;
  const effort = $("#pg-effort").value;
  const thinking = $("#pg-thinking").value === "on";

  // Built up as the call progresses and logged in `finally` below no
  // matter where (or whether) it throws -- a failed call is exactly the
  // one you most need in the debug log. Includes the generation settings
  // actually in effect for this call (not just stage/model), so "was
  // thinking on for this?" / "did self-check even run?" are answerable
  // from the log alone instead of having to be asked.
  const record = {
    stage, provider, model, effort, thinking, selfCheck: selfCheckEnabled(), material: scene?.config?.material,
    userMessage: messages[messages.length - 1]?.content || "",
  };
  try {
    let response;
    try {
      response = await fetch("/api/parametric-stage", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-secret": secret },
        body: JSON.stringify({ stage, provider, model, effort, thinking, systemPrompt: systemPromptFor(stage), messages }),
      });
    } catch (e) {
      record.networkError = String(e.message || e);
      throw new Error(`could not reach the LLM proxy: ${e.message || e}`);
    }
    let data;
    try { data = await readJsonResponse(response); }
    catch (e) {
      const preview = e.rawText ? (e.rawText.length > 300 ? e.rawText.slice(0, 300) + "…" : e.rawText) : "(empty response)";
      record.httpError = `proxy returned non-JSON: ${preview}`;
      throw new Error(`the proxy returned a response that wasn't valid JSON: ${preview}`);
    }
    if (!response.ok) { record.httpError = (data && data.error) || `HTTP ${response.status}`; throw new Error(record.httpError); }
    const { text, refusal } = extractResponseOutput(data, provider);
    if (refusal) { record.refusal = refusal; throw new Error(`the model declined: ${refusal}`); }
    if (!text) { record.httpError = "no text content returned by the model"; throw new Error(record.httpError); }
    record.rawOutput = text;
    if (data.usage) record.usage = data.usage;
    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      record.parseError = e.message + (wasTruncated(data, provider) ? " (looks truncated -- hit the token limit)" : "");
      if (wasTruncated(data, provider)) throw new Error("generation was cut off (token limit) -- try again or narrow the request");
      throw new Error(`could not parse the model output as JSON: ${e.message}`);
    }
    if (data.usage) recordCost(data.usage, model);
    const v = C.validateStageOutput(VALIDATOR_FOR_STAGE[stage], json, contextScene);
    record.validationErrors = v.errors;
    if (v.errors.length) throw new Error(`${stage} output rejected: ${v.errors.join("; ")}`);
    if (stage.endsWith("-check")) v.value.ok = !!json.ok;
    return v.value;
  } finally {
    logDebugCall(record);
  }
}

// ---------------------------------------------------------- orchestration --

function setBusy(on, text = "") {
  busy = on;
  $("#pg-send-btn").classList.toggle("active", on);
  $("#pg-status").textContent = text;
}

function showMessages(items) {
  $("#pg-messages").innerHTML = items.map((w) => `<li>${w}</li>`).join("");
}

function pushMessage(role, content, stage) {
  scene.messages.push(stage ? { role, content, stage } : { role, content });
  saveScene();
  renderTranscript();
}

async function onSend() {
  const input = $("#pg-input");
  const instruction = input.value.trim();
  showMessages([]);
  if (busy) return;
  if (!ready) { showMessages(["still loading — try again in a moment"]); return; }
  if (!instruction) { showMessages(["type a message first"]); return; }
  if (!$("#pg-app-secret").value) { showMessages(["enter the app password first"]); return; }

  pushMessage("user", instruction);
  input.value = "";
  pending = null;
  beginDebugTurn(instruction);

  setBusy(true, "routing…");
  let route;
  try {
    route = await callStage("route", routeMessages());
  } catch (e) {
    setBusy(false);
    showMessages([escapeHtml(String(e.message || e)), retryLink("route", { instruction })]);
    pending = { stage: "route", instruction };
    return;
  }
  if (route.route === "chat" || !CHAIN[route.route]) {
    pushMessage("assistant", route.reply || "(no reply)", "chat");
    setBusy(false);
    return;
  }
  const chain = CHAIN[route.route].slice();
  pending = { instruction: route.instruction || instruction, targets: route.targets, remaining: chain, total: chain.length };
  await runChain();
}

function retryLink(kind, p) {
  return `<span class="pg-retry" data-kind="${kind}">retry</span>`;
}

function selfCheckEnabled() { return $("#pg-self-check").value === "on"; }

// After the geometry stage returns a proposed element list, compile it
// (elements only, no textures -- resolveScene/compileScene don't need
// them for bbox/closure/chart-role reporting) to get the app's own exact
// numbers, then -- if there's anything worth checking and self-check is
// on -- ask the geometry-check stage to review against those numbers and
// patch anything wrong. Returns the (possibly patched) elements and a
// chat note to show, or null if nothing changed.
async function checkGeometry(step, total, instruction, elements, transform) {
  const draft = { elements, textures: {}, transform, config: scene.config, abstractions: [] };
  let compiled;
  try { compiled = C.compileScene(draft); } catch (e) { return { elements, note: null }; }
  const worthChecking = compiled.errors.length > 0 || compiled.warnings.length > 0 ||
    elements.some((e) => ["bar", "axis", "curve", "tick"].includes(e.role));
  if (!selfCheckEnabled() || !worthChecking) return { elements, note: null };

  setBusy(true, `checking geometry… (step ${step} of ${total})`);
  const parts = [
    `INSTRUCTION:\n${instruction}`,
    `PROPOSED ELEMENTS (JSON):\n${jsonLines(C.elementsJson(draft))}`,
    `DETERMINISTIC REPORT (computed by the app from this exact geometry -- trust these numbers):\n${C.reportText(compiled.report)}`,
  ];
  if (compiled.errors.length) parts.push(`HARD ERRORS (must be fixed):\n${compiled.errors.join("\n")}`);
  if (compiled.warnings.length) parts.push(`WARNINGS:\n${compiled.warnings.join("\n")}`);

  let out;
  try {
    out = await callStage("geometry-check", [{ role: "user", content: parts.join("\n\n") }], draft);
  } catch (e) {
    showMessages([`geometry check failed (kept the unverified draft): ${escapeHtml(String(e.message || e))}`]);
    return { elements, note: null };
  }
  if (out.ok || !out.elements.length) return { elements, note: null };
  const byId = new Map(elements.map((e, i) => [e.id, i]));
  for (const fix of out.elements) {
    const i = byId.get(fix.id);
    if (i != null) elements[i] = fix; else elements.push(fix);
  }
  return { elements, note: out.chat };
}

// Same idea for the texture stage, but only worth doing when at least one
// proposed fill uses a free-form (hand-written-coordinates) pattern.
async function checkTexture(step, total, instruction, textures) {
  const worthChecking = textures.some((t) => t.slot === "fill" && t.pattern && FREEFORM_PATTERN_KINDS.includes(t.pattern.kind));
  if (!selfCheckEnabled() || !worthChecking) return { textures, note: null };

  const draft = { elements: scene.elements, textures: structuredClone(scene.textures), transform: scene.transform, config: scene.config, abstractions: structuredClone(scene.abstractions) };
  C.mergeTextures(draft, { textures });
  let compiled;
  try { compiled = C.compileScene(draft); } catch (e) { return { textures, note: null }; }

  setBusy(true, `checking texture… (step ${step} of ${total})`);
  const parts = [
    `INSTRUCTION:\n${instruction}`,
    `PROPOSED TEXTURES (JSON):\n${jsonLines(textures)}`,
    `DETERMINISTIC REPORT (compiled fill stats -- trust these numbers):\n${C.reportText(compiled.report)}`,
  ];
  if (compiled.errors.length) parts.push(`HARD ERRORS (must be fixed):\n${compiled.errors.join("\n")}`);
  if (compiled.warnings.length) parts.push(`WARNINGS:\n${compiled.warnings.join("\n")}`);

  let out;
  try {
    out = await callStage("texture-check", [{ role: "user", content: parts.join("\n\n") }], draft);
  } catch (e) {
    showMessages([`texture check failed (kept the unverified draft): ${escapeHtml(String(e.message || e))}`]);
    return { textures, note: null };
  }
  if (out.ok || !out.textures.length) return { textures, note: null };
  const key = (t) => `${t.elementId} ${t.slot}`;
  const byKey = new Map(textures.map((t, i) => [key(t), i]));
  for (const fix of out.textures) {
    const i = byKey.get(key(fix));
    if (i != null) textures[i] = fix; else textures.push(fix);
  }
  return { textures, note: out.chat };
}

// The transform a proposed geometry change implies, for the check pass's
// report -- value.transform is already parsed (object or null) by
// validateStageOutput.
function previewTransform(value) {
  if (!value.transform) return scene.transform;
  const t = value.transform;
  return {
    scale: Number(t.scale) > 0 ? Number(t.scale) : scene.transform.scale,
    origin: Array.isArray(t.origin) ? t.origin.map(Number) : (t.origin === null ? null : scene.transform.origin),
  };
}

async function runChain() {
  if (!pending || !pending.remaining) return;
  while (pending.remaining.length) {
    const stage = pending.remaining[0];
    const step = pending.total - pending.remaining.length + 1;
    setBusy(true, `generating ${STAGE_LABEL[stage]}… (step ${step} of ${pending.total})`);
    let value;
    try {
      value = await callStage(stage, [{ role: "user", content: stageUserMessage(stage, pending.instruction, pending.targets) }]);
    } catch (e) {
      setBusy(false);
      showMessages([`${STAGE_LABEL[stage]} stage failed: ${escapeHtml(String(e.message || e))}`, retryLink("chain")]);
      return;
    }
    pushMessage("assistant", value.chat || "(no message)", stage);

    if (stage === "geometry") {
      const checked = await checkGeometry(step, pending.total, pending.instruction, value.elements, previewTransform(value));
      value.elements = checked.elements;
      if (checked.note) pushMessage("assistant", checked.note, "geometry-check");
    } else if (stage === "texture") {
      const checked = await checkTexture(step, pending.total, pending.instruction, value.textures);
      value.textures = checked.textures;
      if (checked.note) pushMessage("assistant", checked.note, "texture-check");
    }

    let dropped = [];
    if (stage === "geometry") dropped = C.mergeGeometry(scene, value);
    else if (stage === "texture") dropped = C.mergeTextures(scene, value);
    else if (stage === "parameters") C.mergeParameters(scene, value);
    pending.remaining.shift();
    rerenderAll();
    if (dropped.length) showMessages([`dropped abstraction targets that no longer apply: ${escapeHtml(dropped.join(", "))}`]);
  }
  pending = null;
  setBusy(false);
}

async function onRetry(kind) {
  if (busy || !pending) return;
  if (kind === "route") { $("#pg-input").value = pending.instruction; scene.messages.pop(); saveScene(); renderTranscript(); pending = null; onSend(); return; }
  await runChain();
}

// ----------------------------------------------------------------- render --

function renderTranscript() {
  const el = $("#pg-transcript");
  el.innerHTML = scene.messages.map((m) =>
    `<div class="pg-msg pg-${m.role}"><span class="pg-role">${m.role === "user" ? "you" : `AI${m.stage ? ` · ${escapeHtml(m.stage)}` : ""}`}</span>` +
    `<div class="pg-msg-body">${escapeHtml(m.content)}</div></div>`
  ).join("");
  el.scrollTop = el.scrollHeight;
}

function rerenderAll() {
  renderPanel();
  rerunGcode();
}

function scheduleRerun() {
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(rerunGcode, 250);
}

function rerunGcode() {
  const digestEl = $("#pg-digest");
  const reportEl = $("#pg-report");
  const textarea = $("#raw-gcode-textarea");
  if (!ready) { digestEl.textContent = "not loaded"; return; }
  if (!scene.elements.length) {
    textarea.value = "";
    reportEl.textContent = "(no elements yet)";
    digestEl.innerHTML = `<p style="color:#999;">no elements yet — describe a graphic in the chat</p>`;
    scene.lastReport = null;
    saveScene();
    return;
  }
  let compiled, run;
  try {
    compiled = C.compileScene(scene);
    run = C.runJobs(compiled.jobs, { material: scene.config.material });
  } catch (e) {
    digestEl.innerHTML = `<p style="color:#c00;">compiler error: ${escapeHtml(String(e.message || e))}</p>`;
    return;
  }
  scene.lastReport = compiled.report;
  saveScene();
  textarea.value = run.gcode;
  reportEl.textContent = C.reportText(compiled.report);

  const errors = [...compiled.errors, ...run.errors];
  const warnings = [...compiled.warnings, ...run.warnings];
  const d = run.digest;
  const rows = [
    `<tr><td>G-code lines</td><td>${d.lineCount}</td></tr>`,
    `<tr><td>retraction cycles</td><td>${d.retractCycles}</td></tr>`,
    `<tr><td>bed bounds</td><td>${d.boundsOk ? "ok" : "OUT OF BOUNDS"}</td></tr>`,
    `<tr><td>jobs</td><td>${compiled.jobs.length}</td></tr>`,
  ].join("");
  const errs = errors.length ? `<div class="pg-errs"><strong>errors — not safe to print:</strong><ul>${errors.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const warns = warnings.length ? `<div class="pg-warns"><strong>warnings:</strong><ul>${warnings.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const badge = errors.length ? `<div class="pg-notok">✗ ${errors.length} blocking issue(s)</div>` : `<div class="pg-ok">✓ verification passed</div>`;
  digestEl.innerHTML = `${badge}<table class="pg-digest-table">${rows}</table>${errs}${warns}`;
}

// ---------------------------------------------------------------- panel --

function renderPanel() {
  const el = $("#pg-params");
  el.innerHTML = "";
  el.appendChild(renderGraphicCard());
  const elsTitle = section("elements");
  el.appendChild(elsTitle);
  if (!scene.elements.length) el.appendChild(note("elements appear here after the AI proposes a graphic"));
  scene.elements.forEach((element, idx) => el.appendChild(renderElementCard(element, idx)));
  el.appendChild(section("high-level parameters"));
  if (!scene.abstractions.length) el.appendChild(note("the parameters stage proposes knobs like hairiness or density here"));
  scene.abstractions.forEach((a) => el.appendChild(renderAbstractionCard(a)));
  el.appendChild(section("other brush options"));
  el.appendChild(renderOtherOptions());
}

function section(title) {
  const h = document.createElement("div");
  h.className = "pg-section";
  h.textContent = title;
  return h;
}
function note(text) {
  const p = document.createElement("p");
  p.style.color = "#999";
  p.textContent = text;
  return p;
}
function card(title, sub) {
  const c = document.createElement("div");
  c.className = "pg-call";
  const head = document.createElement("div");
  head.className = "pg-call-head";
  head.innerHTML = `<span class="pg-call-label">${escapeHtml(title)}</span><span class="pg-call-fn">${escapeHtml(sub || "")}</span>`;
  c.appendChild(head);
  return c;
}
function fieldsGrid() {
  const w = document.createElement("div");
  w.className = "pg-fields";
  return w;
}
function commitGeometry() { saveScene(); scheduleRerun(); }

// --- graphic (global) ---

function renderGraphicCard() {
  const c = card("graphic", "global transform");
  const grid = fieldsGrid();
  grid.appendChild(renderField("scale %", { kind: "num", step: 5, min: 10, max: 400 }, +(scene.transform.scale * 100).toFixed(1), (v) => {
    if (v != null && v > 0) scene.transform.scale = v / 100;
    commitGeometry();
  }));
  const natural = scene.lastReport?.naturalBbox;
  const ox = scene.transform.origin ? scene.transform.origin[0] : natural?.minX;
  const oy = scene.transform.origin ? scene.transform.origin[1] : natural?.minY;
  const setOrigin = (i, v) => {
    const cur = scene.transform.origin || [natural?.minX ?? 20, natural?.minY ?? 20];
    if (v == null) { scene.transform.origin = null; }
    else { cur[i] = v; scene.transform.origin = cur; }
    commitGeometry();
  };
  grid.appendChild(renderField("origin x (min corner)", { kind: "nnum", step: 1 }, ox, (v) => setOrigin(0, v)));
  grid.appendChild(renderField("origin y (min corner)", { kind: "nnum", step: 1 }, oy, (v) => setOrigin(1, v)));
  c.appendChild(grid);
  const row = document.createElement("div");
  row.className = "pg-btn-row";
  row.appendChild(smallBtn("fit to safe area", () => {
    const nb = scene.lastReport?.naturalBbox;
    if (!nb) return;
    const w = nb.maxX - nb.minX, h = nb.maxY - nb.minY;
    const span = C.CONSTRAINTS.safeMax - C.CONSTRAINTS.safeMin;
    scene.transform.scale = Math.min(span / Math.max(w, 1e-6), span / Math.max(h, 1e-6));
    scene.transform.origin = [C.CONSTRAINTS.safeMin, C.CONSTRAINTS.safeMin];
    commitGeometry(); renderPanel();
  }));
  row.appendChild(smallBtn("reset", () => { scene.transform = { scale: 1, origin: null }; commitGeometry(); renderPanel(); }));
  c.appendChild(row);
  return c;
}

function smallBtn(label, onClick) {
  const b = document.createElement("span");
  b.className = "btn pg-small-btn";
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

// --- elements ---

function renderElementCard(el, idx) {
  const groupCount = el.kind === "point" && Array.isArray(el.at) && Array.isArray(el.at[0]) ? el.at.length
    : el.kind === "line" && Array.isArray(el.paths) ? el.paths.length : null;
  const c = card(el.label || el.id, `${el.id} · ${el.kind}${el.role ? ` · ${el.role}` : ""}${groupCount != null ? ` · group of ${groupCount}` : ""}`);
  const del = document.createElement("span");
  del.className = "pg-call-del";
  del.textContent = "remove";
  del.onclick = () => {
    scene.elements.splice(idx, 1);
    delete scene.textures[el.id];
    C.pruneAbstractions(scene);
    saveScene(); rerenderAll();
  };
  c.querySelector(".pg-call-head").appendChild(del);

  c.appendChild(renderGeometryEditor(el));

  const tex = scene.textures[el.id] || (scene.textures[el.id] = {});
  for (const slot of C.slotsFor(el.kind)) c.appendChild(renderSlotEditor(el, tex, slot));
  return c;
}

// A small "single | group" toggle shared by point/line editors -- a group
// is several stamps/strokes sharing this one element's texture (ticks,
// gridlines, a row of markers). `onToggle(isGroup)` swaps the element's
// geometry field shape; the caller re-renders.
function groupToggle(isGroup, onToggle) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field";
  lbl.innerHTML = `<span>form</span>`;
  const sel = document.createElement("select");
  [["single", "single"], ["group", "group (repeated, one texture)"]].forEach(([v, text]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = text;
    if ((isGroup ? "group" : "single") === v) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => onToggle(sel.value === "group");
  lbl.appendChild(sel);
  return lbl;
}

function renderGeometryEditor(el) {
  const wrap = document.createElement("div");
  if (el.kind === "point") {
    const isGroup = Array.isArray(el.at) && Array.isArray(el.at[0]);
    wrap.appendChild(groupToggle(isGroup, (toGroup) => {
      el.at = toGroup ? (isGroup ? el.at : [el.at || [110, 110]]) : (isGroup ? (el.at[0] || [110, 110]) : (el.at || [110, 110]));
      commitGeometry(); renderPanel();
    }));
    if (isGroup) {
      wrap.appendChild(jsonField("points [[x,y],…] -- one stamp per entry, all sharing this element's texture", el.at, (v) => {
        if (Array.isArray(v) && v.length) { el.at = v; commitGeometry(); }
      }));
    } else {
      el.at = Array.isArray(el.at) && !Array.isArray(el.at[0]) ? el.at : [110, 110];
      const g = fieldsGrid();
      g.appendChild(numField("x", el.at[0], (v) => { el.at[0] = v; commitGeometry(); }));
      g.appendChild(numField("y", el.at[1], (v) => { el.at[1] = v; commitGeometry(); }));
      wrap.appendChild(g);
    }
  } else if (el.kind === "line") {
    const isGroup = Array.isArray(el.paths);
    wrap.appendChild(groupToggle(isGroup, (toGroup) => {
      if (toGroup) { el.paths = isGroup ? el.paths : [el.path || { points: [[40, 40], [60, 40]] }]; delete el.path; }
      else { el.path = isGroup ? (el.paths[0] || { x: "40 + t", y: "110", tEnd: 60 }) : el.path; delete el.paths; }
      commitGeometry(); renderPanel();
    }));
    if (isGroup) {
      // A group is ONE element sharing ONE texture -- edit it as one
      // compact block (like a point group's point list), not as N
      // expanded per-stroke editors that read as N separate elements.
      // Each entry is a piece object (usually {"points": [[x,y],[x,y]]}
      // for a short straight stroke; a formula/ref piece object also
      // works but is rarer for a group and edited as raw JSON here).
      wrap.appendChild(jsonField(`strokes [{"points":[[x,y],[x,y]]}, …] -- one stroke per entry, all sharing this element's texture`, el.paths, (v) => {
        if (Array.isArray(v) && v.length) { el.paths = v; commitGeometry(); }
      }));
    } else {
      el.path = el.path && typeof el.path === "object" ? el.path : { x: "40 + t", y: "110", tEnd: 60 };
      wrap.appendChild(renderPieceEditor(el.path, (p) => { el.path = p; commitGeometry(); renderPanel(); }, false));
    }
  } else if (el.kind === "region") {
    el.boundary = Array.isArray(el.boundary) && el.boundary.length ? el.boundary : [{ points: [[40, 40], [80, 40], [80, 70], [40, 70], [40, 40]] }];
    const list = document.createElement("div");
    el.boundary.forEach((piece, i) => {
      const pw = document.createElement("div");
      pw.className = "pg-piece";
      const head = document.createElement("div");
      head.className = "pg-fields-title";
      head.textContent = `boundary piece ${i + 1}`;
      const rm = document.createElement("span");
      rm.className = "pg-call-del";
      rm.textContent = "remove piece";
      rm.onclick = () => { el.boundary.splice(i, 1); commitGeometry(); renderPanel(); };
      head.appendChild(rm);
      pw.appendChild(head);
      pw.appendChild(renderPieceEditor(piece, (p) => { el.boundary[i] = p; commitGeometry(); renderPanel(); }, true));
      list.appendChild(pw);
    });
    wrap.appendChild(list);
    const row = document.createElement("div");
    row.className = "pg-btn-row";
    row.appendChild(smallBtn("+ piece", () => { el.boundary.push({ points: [[40, 40], [60, 40]] }); commitGeometry(); renderPanel(); }));
    wrap.appendChild(row);
  }
  return wrap;
}

function pieceType(piece) {
  if (piece && Array.isArray(piece.points)) return "points";
  if (piece && typeof piece.ref === "string") return "ref";
  return "formula";
}

// One piece: type select + its fields. `onReplace` gets a whole new piece
// object when the type changes; in-place edits just commit.
function renderPieceEditor(piece, onReplace, allowRef) {
  const g = fieldsGrid();
  const type = pieceType(piece);
  const types = allowRef ? ["formula", "points", "ref"] : ["formula", "points"];
  g.appendChild(renderField("piece", { kind: "enum", options: types, def: type }, type, (t) => {
    if (t === type) return;
    if (t === "points") onReplace({ points: [[40, 40], [80, 40]] });
    else if (t === "ref") onReplace({ ref: scene.elements.find((e) => e.kind === "line")?.id || "", reverse: false });
    else onReplace({ x: "40 + t", y: "110", tEnd: 60 });
  }));
  if (type === "formula") {
    g.appendChild(textField("x(t)", piece.x ?? "", (v) => { piece.x = v; commitGeometry(); }, true));
    g.appendChild(textField("y(t)", piece.y ?? "", (v) => { piece.y = v; commitGeometry(); }, true));
    g.appendChild(numField("tEnd", piece.tEnd, (v) => { piece.tEnd = v; commitGeometry(); }));
  } else if (type === "points") {
    g.appendChild(jsonField("points [[x,y],…]", piece.points, (v) => { if (Array.isArray(v)) { piece.points = v; commitGeometry(); } }));
  } else {
    const lines = scene.elements.filter((e) => e.kind === "line").map((e) => e.id);
    g.appendChild(renderField("ref (line id)", { kind: "enum", options: lines.length ? lines : [""], def: piece.ref }, piece.ref, (v) => { piece.ref = v; commitGeometry(); }));
    g.appendChild(renderField("reverse", { kind: "bool", def: false }, !!piece.reverse, (v) => { piece.reverse = v; commitGeometry(); }));
    g.appendChild(renderField("tFrom", { kind: "nnum", step: 0.1 }, piece.tFrom ?? null, (v) => { if (v == null) delete piece.tFrom; else piece.tFrom = v; commitGeometry(); }));
    g.appendChild(renderField("tTo", { kind: "nnum", step: 0.1 }, piece.tTo ?? null, (v) => { if (v == null) delete piece.tTo; else piece.tTo = v; commitGeometry(); }));
  }
  return g;
}

// --- textures ---

function renderSlotEditor(el, tex, slot) {
  const wrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "pg-fields-title";
  title.textContent = slot === "brush" ? (el.kind === "point" ? "stamp" : "brush") : slot;
  wrap.appendChild(title);
  const g = fieldsGrid();
  const s = tex[slot];
  const isFill = slot === "fill";
  const pat = isFill ? (s?.pattern || { kind: "hatch" }) : null;
  const wantsStamp = el.kind === "point" || (isFill && C.STAMP_PATTERNS.includes(pat.kind));
  const names = ["(none)", ...(wantsStamp ? C.STAMP_NAMES : C.BRUSH_NAMES)];
  g.appendChild(renderField(wantsStamp ? "stamp" : "brush", { kind: "enum", options: names, def: "(none)" }, s?.fn || "(none)", (v) => {
    if (v === "(none)") delete tex[slot];
    else if (!s || s.fn !== v) tex[slot] = { fn: v, options: {}, bases: {}, ...(isFill ? { pattern: pat } : {}) };
    C.pruneAbstractions(scene);
    saveScene(); rerenderAll();
  }));
  if (isFill) {
    g.appendChild(renderField("pattern", { kind: "enum", options: C.PATTERN_KINDS, def: "hatch" }, pat.kind, (kind) => {
      const next = { kind, ...(C.PATTERN_OPTIONS[kind] ? Object.fromEntries(Object.entries(C.PATTERN_OPTIONS[kind]).map(([k, m]) => [k, m.def])) : {}) };
      if (kind === "stamps") next.points = [[60, 60], [70, 60]];
      if (kind === "strokes") next.strokes = [[[40, 40], [80, 80]]];
      if (kind === "curves") next.curves = [{ x: "40 + t", y: "60 + 5*sin(t/4)", tEnd: 60 }];
      if (kind === "family") Object.assign(next, { x: "110 + t*cos(u)", y: "110 + t*sin(u)", tEnd: 40, uEnd: 6.28, uStep: 0.5 });
      if (!s) tex[slot] = { fn: C.STAMP_PATTERNS.includes(kind) ? "blob" : "solid", options: {}, bases: {}, pattern: next };
      else {
        s.pattern = next;
        const needStamp = C.STAMP_PATTERNS.includes(kind);
        if (needStamp !== C.isStamp(s.fn)) { s.fn = needStamp ? "blob" : "solid"; s.options = {}; s.bases = {}; }
      }
      C.pruneAbstractions(scene);
      saveScene(); rerenderAll();
    }));
    if (s) {
      const spec = C.PATTERN_OPTIONS[pat.kind];
      if (spec) {
        // Route through optionField so a pattern value an abstraction also
        // drives (e.g. a "density" knob targeting hatch's gap) rebases
        // instead of fighting the slider on the next applyAbstractions().
        for (const k of Object.keys(spec)) g.appendChild(optionField(k, spec[k], { elementId: el.id, slot, option: k }, s));
      } else {
        const { kind, ...rest } = pat;
        g.appendChild(jsonField(`${kind} spec (JSON)`, rest, (v) => { if (v && typeof v === "object") { s.pattern = { kind, ...v }; saveScene(); scheduleRerun(); } }));
      }
    }
  }
  wrap.appendChild(g);
  return wrap;
}

// --- abstractions ---

function optKey(t) { return `${t.elementId} ${t.slot} ${t.option}`; }

function renderAbstractionCard(a) {
  const c = card(a.name, a.id);
  const del = document.createElement("span");
  del.className = "pg-call-del";
  del.textContent = "remove";
  del.onclick = () => { scene.abstractions = scene.abstractions.filter((x) => x !== a); saveScene(); rerenderAll(); };
  c.querySelector(".pg-call-head").appendChild(del);
  if (a.description) { const p = document.createElement("div"); p.className = "pg-desc"; p.textContent = a.description; c.appendChild(p); }

  const row = document.createElement("label");
  row.className = "pg-field pg-field-wide pg-slider";
  const val = document.createElement("span");
  val.textContent = Number(a.value).toFixed(2);
  const inp = document.createElement("input");
  inp.type = "range"; inp.min = 0; inp.max = 1; inp.step = 0.01; inp.value = a.value;
  inp.oninput = () => {
    a.value = parseFloat(inp.value);
    val.textContent = a.value.toFixed(2);
    C.applyAbstractions(scene);
    refreshDrivenInputs();
    saveScene();
    scheduleRerun();
  };
  row.appendChild(val);
  row.appendChild(inp);
  c.appendChild(row);

  const g = fieldsGrid();
  const weights = C.normalizedWeights(a.targets);
  a.targets.forEach((t, i) => {
    const s = scene.textures[t.elementId]?.[t.slot];
    if (!s) return;
    const el = scene.elements.find((e) => e.id === t.elementId);
    // A fill's option and pattern spaces are named independently (see
    // resolveTarget()) -- look in whichever one this target actually
    // resolves to, so a knob driving e.g. hatch's own "gap" still renders.
    const target = C.resolveTarget(scene, t.elementId, t.slot, t.option);
    if (!target) return;
    const label = `${el?.label || t.elementId} · ${t.slot} · ${t.option}  (${Number(t.direction) < 0 ? "−" : "+"}${(weights[i] * 100).toFixed(0)}%)`;
    g.appendChild(optionField(label, target.spec, t, s));
  });
  c.appendChild(g);
  return c;
}

// An option input bound to a scene slot -- the value may live on the
// slot's own brush/stamp options, or (fill only) on its pattern's own
// numeric fields (hatch's gap, grid's dx/dy, ...) -- see resolveTarget().
// A manual edit of a driven option rebases it so the sliders stay put.
function optionField(label, spec, t, s) {
  const loc = () => C.targetLocation(scene, t.elementId, t.slot, t.option) || "options";
  const bagOf = (l) => (l === "pattern" ? s.pattern : s.options) || {};
  const f = renderField(label, spec, bagOf(loc())[t.option], (v) => {
    const l = loc();
    const bag = l === "pattern" ? (s.pattern = s.pattern || {}) : (s.options = s.options || {});
    const bases = l === "pattern" ? s.patternBases : s.bases;
    if (v === null || v === undefined || v === "") { delete bag[t.option]; if (bases) delete bases[t.option]; }
    else {
      bag[t.option] = v;
      if (typeof v === "number") { C.rebaseOption(scene, t.elementId, t.slot, t.option, v); C.applyAbstractions(scene); refreshDrivenInputs(); }
    }
    saveScene(); scheduleRerun();
  });
  const input = f.querySelector("input,select");
  if (input) input.dataset.opt = optKey(t);
  if (C.OPTION_DESC[t.option]) f.title = C.OPTION_DESC[t.option];
  return f;
}

function refreshDrivenInputs() {
  document.querySelectorAll("[data-opt]").forEach((inp) => {
    const [elementId, slot, option] = inp.dataset.opt.split(" ");
    const s = scene.textures[elementId]?.[slot];
    if (!s) return;
    const loc = C.targetLocation(scene, elementId, slot, option);
    const bag = (loc === "pattern" ? s.pattern : s.options) || {};
    const v = bag[option];
    if (inp.type === "checkbox") inp.checked = !!v;
    else if (document.activeElement !== inp) inp.value = v ?? "";
  });
}

function renderOtherOptions() {
  const wrap = document.createElement("div");
  let any = false;
  for (const el of scene.elements) {
    const tex = scene.textures[el.id] || {};
    for (const slot of C.slotsFor(el.kind)) {
      const s = tex[slot];
      if (!s?.fn) continue;
      const spec = C.optionSpecFor(s.fn);
      const undriven = Object.keys(spec).filter((k) => !C.driversOf(scene, el.id, slot, k).length);
      if (!undriven.length) continue;
      any = true;
      const c = card(`${el.label || el.id} · ${slot}`, s.fn);
      const g = fieldsGrid();
      for (const k of undriven) g.appendChild(optionField(k, spec[k], { elementId: el.id, slot, option: k }, s));
      c.appendChild(g);
      wrap.appendChild(c);
    }
  }
  if (!any) wrap.appendChild(note("no textures yet"));
  return wrap;
}

// --- fields ---

function numField(label, value, onChange) {
  return renderField(label, { kind: "num", step: 0.5 }, value, onChange);
}

function textField(label, value, onChange, wide) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field" + (wide ? " pg-field-wide" : "");
  lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value ?? "";
  inp.onchange = () => onChange(inp.value);
  lbl.appendChild(inp);
  return lbl;
}

function jsonField(label, value, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field pg-field-wide";
  lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const ta = document.createElement("textarea");
  ta.className = "pg-json";
  ta.value = JSON.stringify(value);
  ta.onchange = () => {
    try { onChange(JSON.parse(ta.value)); ta.classList.remove("pg-bad"); }
    catch (e) { ta.classList.add("pg-bad"); }
  };
  lbl.appendChild(ta);
  return lbl;
}

function renderField(label, meta, value, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field";
  lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;

  if (meta.kind === "enum") {
    const sel = document.createElement("select");
    meta.options.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o;
      if ((value ?? meta.def) === o) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => onChange(sel.value);
    lbl.appendChild(sel);
    return lbl;
  }
  if (meta.kind === "bool") {
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = value ?? meta.def ?? false;
    inp.onchange = () => onChange(inp.checked);
    lbl.appendChild(inp);
    return lbl;
  }
  const inp = document.createElement("input");
  inp.type = "number";
  if (meta.step != null) inp.step = meta.step;
  if (meta.min != null) inp.min = meta.min;
  if (meta.max != null) inp.max = meta.max;
  if (meta.kind === "nnum") inp.placeholder = "auto";
  // A stored "" (the app's "no value" convention elsewhere) or a
  // non-finite number is not a real value either -- fall back the same
  // way missing does, instead of rendering permanently blank.
  const hasValue = value !== null && value !== undefined && value !== "" && (typeof value !== "number" || Number.isFinite(value));
  inp.value = hasValue ? value : (meta.kind === "nnum" ? "" : (meta.def ?? ""));
  inp.onchange = () => {
    if (inp.value === "") { onChange(null); return; }
    const n = parseFloat(inp.value);
    onChange(isNaN(n) ? null : (meta.kind === "int" ? Math.round(n) : n));
  };
  lbl.appendChild(inp);
  return lbl;
}

// ------------------------------------------------------------- controls --

function newConversation() {
  if (!confirm("Clear the conversation, the scene, and the generated G-code?")) return;
  scene = C.defaultScene();
  scene.config.material = $("#pg-material").value;
  pending = null;
  saveScene();
  renderTranscript();
  rerenderAll();
  showMessages([]);
}

function initParametricEditor() {
  $("#pg-send-btn").addEventListener("click", onSend);
  $("#pg-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); }
  });
  $("#pg-messages").addEventListener("click", (e) => {
    const r = e.target.closest(".pg-retry");
    if (r) onRetry(r.dataset.kind);
  });
  $("#pg-app-secret").addEventListener("change", () => saveAppSecretFrom("pg-app-secret"));
  $("#pg-provider").addEventListener("change", () => updateModelOptions("pg-provider", "pg-model"));
  $("#pg-new-btn").addEventListener("click", newConversation);
  $("#pg-save-log-btn").addEventListener("click", () => {
    if (!debugLog.length) { showMessages(["the debug log is empty — send a message first"]); return; }
    downloadText(`parametric-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`, formatDebugLog(debugLog));
  });
  $("#pg-clear-log-btn").addEventListener("click", () => {
    if (!confirm("Clear the saved debug log? This does not affect the conversation or scene.")) return;
    debugLog = [];
    currentDebugTurn = null;
    saveDebugLog();
  });
  $("#pg-material").addEventListener("change", () => {
    if (!scene) return;
    scene.config.material = $("#pg-material").value;
    saveScene();
    scheduleRerun();
  });

  updateModelOptions("pg-provider", "pg-model");
  loadAppSecretInto("pg-app-secret");
  renderCostTracker();
  $("#pg-send-btn").classList.add("disabled");

  loadDeps();
}

window.initParametricEditor = initParametricEditor;
