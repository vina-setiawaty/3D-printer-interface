// EXPERIMENTAL variant of parametric.js (parametric-with-tool.html) — adds a
// server-side code_execution self-check before the model finalizes its call
// list. See parametric.js for the base behavior; this file only differs in:
//   - a distinct localStorage key, so this page's session doesn't collide
//     with parametric.html's,
//   - buildParametricSystemPrompt() appending the appropriateness-check
//     instructions below,
//   - posting to /api/generate-parametric-tool instead of
//     /api/generate-parametric.
//
// Column 1: a multi-turn chat. Column 2: the parameter list for the call
// list the model returned. Column 3: the generated G-code (the shared
// #raw-gcode-textarea + run/save wiring from script.js).
//
// The model returns { chat, calls[] } (see api/generate-parametric-tool.js).
// Each call is executed locally by parametric-catalog.js against the pinned
// parametric_docs/texture_functions.js — editing a parameter re-runs the
// call list with no API round-trip.
//
// Reuses llm.js's provider-agnostic helpers (extractResponseOutput,
// wasTruncated, escapeHtml, readJsonResponse, recordCost, updateModelOptions,
// saveAppSecretFrom/loadAppSecretInto, renderCostTracker).

const PARAMETRIC_STORAGE_KEY = "parametricWithToolSessionState";
// A distilled single reference doc replaces catalog.md/path-spec.md/
// hardware.md/PARAMETER_CONSTRAINTS.md for this page only — same facts,
// with human-maintainer-only workflow notes (e.g. PARAMETER_CONSTRAINTS.md's
// "this is a fill-in form" preamble) and repeated option lists trimmed out.
// parametric.html keeps using the original 5-doc set unchanged.
const PROMPT_DOCS = [
  "parametric_docs/system-prompt.md",
  "parametric_docs/reference-distilled.md",
];

// system-prompt.md is shared with parametric.html and stays unchanged (see
// PROMPT_DOCS above), but its "a multi-segment stroke is ONE call with a
// polyline path" rule no longer applies here -- this page has no path
// "kind" at all, just an x(t)/y(t) formula, which can't express a sharp
// corner. This note overrides that stale rule for this page only.
const PATH_MODEL_NOTE = `
---

PATH MODEL ON THIS PAGE (overrides the polyline guidance above): every line
path and fill boundary is a literal parametric formula --
{"x": "<expr in t>", "y": "<expr in t>", "tEnd": <number>} -- evaluated over
t in [0, tEnd]. There is no "segment"/"polyline"/"arc"/"sine" kind anymore.
A single smooth formula cannot express a sharp corner, so a multi-segment
stroke (a rectangle border, an L-shape, a zigzag) now needs ONE LINE CALL
PER STRAIGHT OR CURVED RUN, not one polyline call. A fill can also use
geometry.boundary (a CLOSED formula curve, i.e. x(tEnd)~=x(0) and
y(tEnd)~=y(0)) instead of geometry.region, for a non-rectangular area --
except DIAMOND fill, which still requires a rectangular geometry.region.`;

// Appended to the base system prompt. code_execution is a server-side tool —
// Claude runs Python in Anthropic's sandbox and reads back stdout only; it
// does NOT see rendered images/plots from that sandbox, so this has to be a
// numeric/structural self-check the model reasons about, not a "look at the
// picture" check.
const CODE_EXECUTION_INSTRUCTIONS = `
---

CHECK APPROPRIATENESS BEFORE FINALIZING — when the request has real
quantitative or structural intent (a chart or graph, a shape with a stated
size/position, evenly spaced elements, anything meant to encode data or
proportions), use the code_execution tool to check your planned calls
before writing your final answer. This is a judgment check, not just a
number check:

- Reconstruct each path's/boundary's actual (x, y) geometry by evaluating
  its own x(t)/y(t) formulas directly over t in [0, tEnd] (they're already
  literal functions of t — no separate reconstruction math needed). Dot
  centers come directly from geometry.at; a rectangle fill from
  geometry.region.
- From that reconstruction, judge whether the graphic is an APPROPRIATE
  representation of what was asked — not just whether one number matches
  exactly: does it read as the right kind of chart/shape, are relative
  proportions and ordering (bar heights, data trend direction, spacing
  between elements) correct, is the composition sensible as a whole (not
  just individually valid)?
- Print what you checked and the result. If something's off — wrong
  proportions, wrong ordering, a shape that technically fits the spec but
  doesn't read as intended — fix the calls and re-check before writing your
  final JSON.
- Skip this for purely decorative textures with no quantitative/structural
  intent. This is not a substitute for the printability limits in the
  constraints reference, which are already enforced separately
  (client-side, after generation).`;

let TF = null;                 // texture_functions.js module, loaded async
let promptText = null;         // concatenated docs, loaded async
let parametricReady = false;
let rerunTimer = null;
let lastAppliedGcodeText = "";

function defaultParametricState() {
  return {
    messages: [],   // {role: "user"|"assistant", content: string}
    calls: [],      // {fn, geometry:{}, options:{}, label}
    config: { material: "TPU" },
  };
}

let pstate = loadParametricState();

function loadParametricState() {
  try {
    const raw = localStorage.getItem(PARAMETRIC_STORAGE_KEY);
    if (!raw) return defaultParametricState();
    const p = JSON.parse(raw);
    return {
      messages: Array.isArray(p.messages) ? p.messages : [],
      calls: Array.isArray(p.calls) ? p.calls : [],
      config: { ...defaultParametricState().config, ...(p.config || {}) },
    };
  } catch (e) {
    return defaultParametricState();
  }
}

function saveParametricState() {
  localStorage.setItem(PARAMETRIC_STORAGE_KEY, JSON.stringify(pstate));
}

// ------------------------------------------------------------------ loading --

async function loadParametricDeps() {
  const status = document.querySelector("#pg-status");
  status.textContent = "loading texture library…";
  try {
    // Prototype fork with the internal dedup refactor (see
    // texture_functions-with-tool.js's own header comment) -- same public
    // behavior as the pinned copy parametric.js uses.
    TF = await import("./parametric_docs/texture_functions-with-tool.js");
  } catch (e) {
    status.textContent = "";
    document.querySelector("#pg-messages").innerHTML =
      `<li>could not load parametric_docs/texture_functions-with-tool.js: ${escapeHtml(String(e.message || e))}</li>`;
    return;
  }
  try {
    const parts = await Promise.all(PROMPT_DOCS.map(async (path) => {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
      return r.text();
    }));
    // strip each doc's own markdown title line noise? keep as-is; the model
    // handles markdown fine. The system-prompt.md file wraps the real
    // prompt in a ``` fence with a preamble — pull just the fenced block.
    const sys = parts[0];
    const fenced = sys.match(/```([\s\S]*?)```/);
    parts[0] = fenced ? fenced[1].trim() : sys;
    // CODE_EXECUTION_INSTRUCTIONS is appended per-request in
    // buildParametricSystemPrompt() instead of baked in here, since the
    // "Tool execution" toggle can turn it off per send -- no point
    // instructing the model to use a tool it wasn't actually given.
    promptText = parts.join("\n\n---\n\n") + PATH_MODEL_NOTE;
  } catch (e) {
    status.textContent = "";
    document.querySelector("#pg-messages").innerHTML =
      `<li>could not load the prompt docs: ${escapeHtml(String(e.message || e))}</li>`;
    return;
  }

  parametricReady = true;
  status.textContent = "";
  document.querySelector("#pg-send-btn").classList.remove("disabled");
  rerenderCallsAndGcode();
}

// -------------------------------------------------------------- system prompt --

function buildParametricSystemPrompt(codeExecution) {
  const mat = pstate.config.material || "TPU";
  return `${promptText}${codeExecution ? CODE_EXECUTION_INSTRUCTIONS : ""}\n\n---\n\nSESSION: the user has selected material = ${mat}. ` +
    (mat === "PLA"
      ? "Use PLA numbers from hardware.md; the page will emit a PLA start sequence."
      : "Use TPU numbers (the library defaults).");
}

// The user turn carries a snapshot of the current (possibly hand-edited)
// call list so the model modifies what's actually on screen.
function callsSnapshotText() {
  if (!pstate.calls.length) return "(the call list is currently empty)";
  const wire = pstate.calls.map((c) => ({
    fn: c.fn,
    geometry: JSON.stringify(c.geometry ?? {}),
    options: JSON.stringify(c.options ?? {}),
    label: c.label || "",
  }));
  return "Current call list (JSON, reflects any manual parameter edits):\n" +
    JSON.stringify(wire, null, 2);
}

function buildMessagesForRequest(newInstruction) {
  const history = pstate.messages.map((m) => ({ role: m.role, content: m.content }));
  const lastUser = `${newInstruction}\n\n${callsSnapshotText()}`;
  return [...history.slice(0, -1), { role: "user", content: lastUser }];
}

// ----------------------------------------------------------------- chat send --

async function onParametricSend() {
  const btn = document.querySelector("#pg-send-btn");
  const status = document.querySelector("#pg-status");
  const messages = document.querySelector("#pg-messages");
  const input = document.querySelector("#pg-input");
  const instruction = input.value.trim();
  const secret = document.querySelector("#pg-app-secret").value;
  const provider = document.querySelector("#pg-provider").value;
  const model = document.querySelector("#pg-model").value;
  const effort = document.querySelector("#pg-effort").value;
  const thinking = document.querySelector("#pg-thinking").value === "on";
  const codeExecution = document.querySelector("#pg-code-execution").value === "on";

  messages.innerHTML = "";
  if (!parametricReady) { messages.innerHTML = "<li>still loading — try again in a moment</li>"; return; }
  if (!instruction) { messages.innerHTML = "<li>type a message first</li>"; return; }
  if (!secret) { messages.innerHTML = "<li>enter the app password first</li>"; return; }

  pstate.messages.push({ role: "user", content: instruction });
  renderTranscript();
  input.value = "";
  saveParametricState();

  btn.classList.add("active");
  status.textContent = "generating…";

  let response;
  try {
    response = await fetch("/api/generate-parametric-tool", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-secret": secret },
      body: JSON.stringify({
        provider, model, effort, thinking, codeExecution,
        systemPrompt: buildParametricSystemPrompt(codeExecution),
        messages: buildMessagesForRequest(instruction),
      }),
    });
  } catch (e) {
    status.textContent = ""; btn.classList.remove("active");
    messages.innerHTML = `<li>could not reach the LLM proxy: ${escapeHtml(String(e.message || e))}</li>`;
    return;
  }

  let data;
  try {
    data = await readJsonResponse(response);
  } catch (e) {
    status.textContent = ""; btn.classList.remove("active");
    const preview = e.rawText ? (e.rawText.length > 500 ? e.rawText.slice(0, 500) + "…" : e.rawText) : "(empty response)";
    messages.innerHTML = `<li>the proxy returned a response that wasn't valid JSON</li><li style="white-space:pre-wrap;">${escapeHtml(preview)}</li>`;
    return;
  }

  if (!response.ok) {
    status.textContent = ""; btn.classList.remove("active");
    messages.innerHTML = `<li>generation failed: ${escapeHtml((data && data.error) || `HTTP ${response.status}`)}</li>`;
    return;
  }

  const { text: outputText, refusal } = extractResponseOutput(data, provider);
  if (refusal) {
    status.textContent = ""; btn.classList.remove("active");
    messages.innerHTML = `<li>the model declined this request: ${escapeHtml(refusal)}</li>`;
    return;
  }
  if (!outputText) {
    status.textContent = ""; btn.classList.remove("active");
    messages.innerHTML = "<li>no text content returned by the model</li>";
    return;
  }

  let result;
  try {
    result = JSON.parse(outputText);
  } catch (e) {
    status.textContent = ""; btn.classList.remove("active");
    if (wasTruncated(data, provider)) {
      messages.innerHTML = "<li>generation was cut off (token limit) — try again or narrow the request</li>";
    } else {
      const preview = outputText.length > 500 ? outputText.slice(0, 500) + "…" : outputText;
      messages.innerHTML = `<li>could not parse the model output as JSON: ${escapeHtml(e.message)}</li><li style="white-space:pre-wrap;">${escapeHtml(preview)}</li>`;
    }
    return;
  }

  applyModelResult(result);
  if (data.usage) recordCost(data.usage, model);

  status.textContent = ""; btn.classList.remove("active");
}

function applyModelResult(result) {
  const chat = typeof result.chat === "string" ? result.chat : "";
  pstate.messages.push({ role: "assistant", content: chat || "(no message)" });

  const parseWarnings = [];
  const normalized = (Array.isArray(result.calls) ? result.calls : []).map((c, i) => {
    let geometry = {}, options = {};
    try { geometry = c.geometry ? JSON.parse(c.geometry) : {}; }
    catch (e) { parseWarnings.push(`call ${i + 1}: geometry JSON did not parse (${e.message}) — using empty`); }
    try { options = c.options ? JSON.parse(c.options) : {}; }
    catch (e) { parseWarnings.push(`call ${i + 1}: options JSON did not parse (${e.message}) — using empty`); }
    return { fn: c.fn, geometry, options, label: c.label || `call ${i + 1}` };
  });
  pstate.calls = normalized;
  saveParametricState();

  renderTranscript();
  rerenderCallsAndGcode();

  if (parseWarnings.length) {
    document.querySelector("#pg-messages").innerHTML = parseWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
  }
}

// ----------------------------------------------------------------- rendering --

function renderTranscript() {
  const el = document.querySelector("#pg-transcript");
  el.innerHTML = pstate.messages.map((m) =>
    `<div class="pg-msg pg-${m.role}"><span class="pg-role">${m.role === "user" ? "you" : "AI"}</span>` +
    `<div class="pg-msg-body">${escapeHtml(m.content)}</div></div>`
  ).join("");
  el.scrollTop = el.scrollHeight;
}

function rerenderCallsAndGcode() {
  renderParamPanel();
  rerunGcode();
}

function scheduleRerun() {
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(() => { rerunGcode(); }, 250);
}

function rerunGcode() {
  const digestEl = document.querySelector("#pg-digest");
  const textarea = document.querySelector("#raw-gcode-textarea");
  if (!parametricReady || !TF) { digestEl.textContent = "texture library not loaded"; return; }

  if (!pstate.calls.length) {
    textarea.value = "";
    lastAppliedGcodeText = "";
    digestEl.innerHTML = `<p style="color:#999;">no calls yet — describe a graphic in the chat</p>`;
    return;
  }

  let result;
  try {
    result = ParametricCatalog.runCalls(TF, pstate.calls, { material: pstate.config.material });
  } catch (e) {
    digestEl.innerHTML = `<p style="color:#c00;">interpreter error: ${escapeHtml(String(e.message || e))}</p>`;
    return;
  }

  textarea.value = result.gcode;
  lastAppliedGcodeText = result.gcode;

  const d = result.digest;
  const rows = [
    `<tr><td>G-code lines</td><td>${d.lineCount}</td></tr>`,
    `<tr><td>retraction cycles</td><td>${d.retractCycles}</td></tr>`,
    `<tr><td>net extrusion</td><td>${d.netExtrusionMm.toFixed(1)} mm (min ${d.minNetExtrusionMm.toFixed(1)})</td></tr>`,
    `<tr><td>bed bounds</td><td>${d.boundsOk ? "ok" : "OUT OF BOUNDS"}</td></tr>`,
    `<tr><td>bed margin</td><td>${d.layoutOk ? "ok" : "REGION OFF SAFE AREA"}</td></tr>`,
  ].join("");
  const errs = result.errors.length ? `<div class="pg-errs"><strong>errors — not safe to print:</strong><ul>${result.errors.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const warns = result.warnings.length ? `<div class="pg-warns"><strong>warnings:</strong><ul>${result.warnings.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
  const okBadge = result.ok
    ? `<div class="pg-ok">✓ verification passed</div>`
    : `<div class="pg-notok">✗ ${result.errors.length} blocking issue(s)</div>`;

  digestEl.innerHTML = `${okBadge}<table class="pg-digest-table">${rows}</table>${errs}${warns}`;
}

function renderParamPanel() {
  const el = document.querySelector("#pg-params");
  if (!pstate.calls.length) {
    el.innerHTML = `<p style="color:#999;">parameters appear here after the AI proposes a graphic</p>`;
    return;
  }
  el.innerHTML = "";
  pstate.calls.forEach((call, idx) => {
    el.appendChild(renderCallCard(call, idx));
  });
}

function renderCallCard(call, idx) {
  const card = document.createElement("div");
  card.className = "pg-call";
  const kind = ParametricCatalog.callKind(call.fn);

  const head = document.createElement("div");
  head.className = "pg-call-head";
  head.innerHTML = `<span class="pg-call-label">${escapeHtml(call.label)}</span>` +
    `<span class="pg-call-fn">${escapeHtml(call.fn)}${kind ? "" : " ⚠ unknown"}</span>`;
  const del = document.createElement("span");
  del.className = "pg-call-del";
  del.textContent = "remove";
  del.onclick = () => { pstate.calls.splice(idx, 1); saveParametricState(); rerenderCallsAndGcode(); };
  head.appendChild(del);
  card.appendChild(head);

  // geometry fields
  card.appendChild(renderGeometryFields(call, idx));

  // option fields
  const spec = ParametricCatalog.optionSpecFor(call);
  const optWrap = document.createElement("div");
  optWrap.className = "pg-fields";
  Object.entries(spec).forEach(([key, meta]) => {
    optWrap.appendChild(renderField(key, meta, call.options[key], (val) => {
      if (val === null || val === undefined || val === "") delete call.options[key];
      else call.options[key] = val;
      saveParametricState();
      scheduleRerun();
    }));
  });
  if (Object.keys(spec).length) {
    const title = document.createElement("div");
    title.className = "pg-fields-title";
    title.textContent = "options";
    card.appendChild(title);
    card.appendChild(optWrap);
  }
  return card;
}

function renderGeometryFields(call, idx) {
  const wrap = document.createElement("div");
  wrap.className = "pg-fields";
  const kind = ParametricCatalog.callKind(call.fn);
  const g = call.geometry || (call.geometry = {});
  const commit = () => { saveParametricState(); scheduleRerun(); };

  if (kind === "dot") {
    g.at = Array.isArray(g.at) ? g.at : [110, 110];
    wrap.appendChild(numField("cx", g.at[0], (v) => { g.at[0] = v; commit(); }));
    wrap.appendChild(numField("cy", g.at[1], (v) => { g.at[1] = v; commit(); }));
  } else if (kind === "fill") {
    const shapeSel = document.createElement("label");
    shapeSel.className = "pg-field";
    shapeSel.innerHTML = `<span>region shape</span>`;
    const shapeChoice = document.createElement("select");
    ["rectangle", "boundary"].forEach((s) => {
      const o = document.createElement("option"); o.value = s; o.textContent = s;
      if ((g.region ? "rectangle" : "boundary") === s) o.selected = true;
      shapeChoice.appendChild(o);
    });
    shapeChoice.onchange = () => {
      if (shapeChoice.value === "rectangle") { delete g.boundary; g.region = g.region || { x0: 40, y0: 40, w: 40, h: 30 }; }
      else { delete g.region; g.boundary = g.boundary || defaultFormulaSpec(true); }
      commit(); renderParamPanel();
    };
    shapeSel.appendChild(shapeChoice);
    wrap.appendChild(shapeSel);

    if (g.region) {
      ["x0", "y0", "w", "h"].forEach((k) => wrap.appendChild(numField(k, g.region[k], (v) => { g.region[k] = v; commit(); })));
    } else {
      g.boundary = g.boundary || defaultFormulaSpec(true);
      renderFormulaFields(wrap, g.boundary, commit);
    }

    const styleSel = document.createElement("label");
    styleSel.className = "pg-field";
    styleSel.innerHTML = `<span>fillStyle</span>`;
    const sel = document.createElement("select");
    ParametricCatalog.FILL_STYLES.forEach((s) => {
      const o = document.createElement("option"); o.value = s; o.textContent = s;
      if ((g.fillStyle || "freeformSolid") === s) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => { g.fillStyle = sel.value; commit(); renderParamPanel(); };
    styleSel.appendChild(sel);
    wrap.appendChild(styleSel);
  } else if (kind === "line") {
    g.path = g.path && typeof g.path.x === "string" ? g.path : defaultFormulaSpec(false);
    renderFormulaFields(wrap, g.path, commit);
  }
  return wrap;
}

// A line path can't have a sharp corner (a single smooth x(t)/y(t)
// formula is non-differentiable at a corner) -- default to a plain
// straight line. A fill boundary must be CLOSED (x(tEnd),y(tEnd) ~=
// x(0),y(0)); a circle is the simplest formula that's exactly closed.
function defaultFormulaSpec(closed) {
  return closed
    ? { x: "110 + 30*cos(t)", y: "110 + 30*sin(t)", tEnd: 2 * Math.PI }
    : { x: "40 + t", y: "110", tEnd: 60 };
}

function renderFormulaFields(wrap, spec, commit) {
  const xLbl = document.createElement("label");
  xLbl.className = "pg-field pg-field-wide";
  xLbl.innerHTML = `<span>x(t)</span>`;
  const xInp = document.createElement("input");
  xInp.type = "text";
  xInp.value = spec.x ?? "";
  xInp.onchange = () => { spec.x = xInp.value; commit(); };
  xLbl.appendChild(xInp);
  wrap.appendChild(xLbl);

  const yLbl = document.createElement("label");
  yLbl.className = "pg-field pg-field-wide";
  yLbl.innerHTML = `<span>y(t)</span>`;
  const yInp = document.createElement("input");
  yInp.type = "text";
  yInp.value = spec.y ?? "";
  yInp.onchange = () => { spec.y = yInp.value; commit(); };
  yLbl.appendChild(yInp);
  wrap.appendChild(yLbl);

  wrap.appendChild(numField("tEnd", spec.tEnd, (v) => { spec.tEnd = v; commit(); }));
}

function numField(label, value, onChange) {
  return renderField(label, { kind: "num", step: 0.5 }, value, onChange);
}

function renderField(label, meta, value, onChange) {
  const lbl = document.createElement("label");
  lbl.className = "pg-field";

  if (meta.kind === "enum") {
    lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;
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
    lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;
    const inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = value ?? meta.def ?? false;
    inp.onchange = () => onChange(inp.checked);
    lbl.appendChild(inp);
    return lbl;
  }

  // num / int / nnum
  lbl.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const inp = document.createElement("input");
  inp.type = "number";
  if (meta.step != null) inp.step = meta.step;
  if (meta.min != null) inp.min = meta.min;
  if (meta.max != null) inp.max = meta.max;
  if (meta.kind === "nnum") inp.placeholder = "auto";
  inp.value = value ?? (meta.kind === "nnum" ? "" : (meta.def ?? ""));
  inp.onchange = () => {
    if (inp.value === "") { onChange(null); return; }
    const n = parseFloat(inp.value);
    onChange(isNaN(n) ? null : (meta.kind === "int" ? Math.round(n) : n));
  };
  lbl.appendChild(inp);
  return lbl;
}

// ------------------------------------------------------------------- controls --

function newParametricConversation() {
  if (!confirm("Clear the conversation, the call list, and the generated G-code?")) return;
  pstate = defaultParametricState();
  pstate.config.material = document.querySelector("#pg-material").value;
  saveParametricState();
  renderTranscript();
  rerenderCallsAndGcode();
  document.querySelector("#pg-messages").innerHTML = "";
}

function initParametricEditor() {
  document.querySelector("#pg-send-btn").addEventListener("click", onParametricSend);
  document.querySelector("#pg-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onParametricSend(); }
  });
  document.querySelector("#pg-app-secret").addEventListener("change", () => saveAppSecretFrom("pg-app-secret"));
  document.querySelector("#pg-provider").addEventListener("change", () => updateModelOptions("pg-provider", "pg-model"));
  document.querySelector("#pg-new-btn").addEventListener("click", newParametricConversation);
  document.querySelector("#pg-material").addEventListener("change", () => {
    pstate.config.material = document.querySelector("#pg-material").value;
    saveParametricState();
    scheduleRerun();
  });

  updateModelOptions("pg-provider", "pg-model");
  loadAppSecretInto("pg-app-secret");
  renderCostTracker();

  document.querySelector("#pg-material").value = pstate.config.material;
  renderTranscript();
  renderParamPanel();
  document.querySelector("#pg-send-btn").classList.add("disabled");

  loadParametricDeps();
}
