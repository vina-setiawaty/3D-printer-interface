// LLM-assisted action generation. Reads/writes the same DOM fields as the
// Manual tab (#action-name, #action-description, #action-variables-container,
// #action-gcode) so the two tabs never hold conflicting state.

const LLM_PRICE_PER_MTOK = {
  "gpt-5.6-luna": { input: 0.20, output: 1.20 },
  "gpt-5.6-terra": { input: 2.00, output: 12.00 },
  "gpt-5.6-sol": { input: 5.00, output: 30.00 },
};

let lastAppliedGcode = "";
let llmSessionCost = parseFloat(localStorage.getItem("llmCostTotal") || "0");

function switchEditorTab(tab) {
  const isManual = tab === "manual";
  document.querySelector("#action-editor-tab-manual").classList.toggle("active", isManual);
  document.querySelector("#action-editor-tab-llm").classList.toggle("active", !isManual);
  document.querySelector("#action-editor-manual-panel").classList.toggle("active", isManual);
  document.querySelector("#action-editor-llm-panel").classList.toggle("active", !isManual);
}

function resetLlmPanel() {
  document.querySelector("#llm-description").value = "";
  document.querySelector("#llm-messages").innerHTML = "";
  document.querySelector("#llm-status").textContent = "";
  lastAppliedGcode = "";
}

function collectManualFormState() {
  const variables = [];
  document.querySelectorAll("#action-variables-container .action-variable-item").forEach(item => {
    const key = item.querySelector(".action-variable-key").value;
    const val = parseFloat(item.querySelector(".action-variable-val").value);
    if (key) {
      variables.push({ key, default: isNaN(val) ? 0 : val });
    }
  });
  return {
    name: document.querySelector("#action-name").value,
    description: document.querySelector("#action-description").value,
    variables,
    gcode: document.querySelector("#action-gcode").value.split("\n").filter(l => l.trim() !== ""),
  };
}

function buildSystemPrompt() {
  const whitelist = gcodeCheck.join(", ");
  return `You generate "actions" for a Marlin G-code motion-control web app. An action is JSON with:
- name: short lowercase alphanumeric identifier (no spaces/symbols)
- description: one sentence, plain language
- variables: array of {key, default} where key starts with "__" and contains only letters/digits (e.g. "__z"), default is a number
- gcode: array of strings, each one G-code line

GCODE LINE RULES (all must be followed exactly):
1. Each line's command word (before the first space) MUST be one of this exact whitelist — any other G/M/T code is silently dropped by the app at runtime and will not run:
   ${whitelist}
2. Use a variable's key literally inside a line to substitute its live value at run time, e.g. "G0 Z__z F__fm".
3. For derived/computed numeric values, wrap a JavaScript arithmetic expression in curly braces, e.g. "G0 Z{-__z * 2} F__fm". Inside {}, use ONLY: the declared variable keys, numeric literals, arithmetic operators (+ - * / % ()), and nothing else. Never use any other function call, assignment, semicolon, or non-arithmetic JavaScript.
4. Do not include comments (// ...) in gcode lines.
5. Every __key placeholder used in gcode must be declared in variables with a sensible numeric default. Keep defaults physically conservative (small travel distances, e.g. a few mm, unless the instruction clearly calls for more) since this controls a physical machine.
6. Prefer relative positioning (G91) with a trailing G90 to restore absolute mode for self-contained relative moves, matching the style of the example below — but use whatever mode is correct for the requested motion.

EXAMPLE (existing action in this app, for style reference):
{
  "name": "simple-up-down",
  "description": "move up and down, extruding at the bottom and retracting at the top",
  "variables": [
    {"key": "__e", "default": 1.5},
    {"key": "__r", "default": 1.5},
    {"key": "__fe", "default": 200.0},
    {"key": "__fm", "default": 600.0},
    {"key": "__z", "default": 5.0}
  ],
  "gcode": [
    "G91",
    "G0 Z__z F__fm",
    "G0 Z{-__z * 2} F__fm",
    "G1 F__fe E__e",
    "G1 Z__z F__fm E-__r"
  ]
}

You will also be given the CURRENT state of the action editor (may be empty/default, or already contain a name/description/variables/gcode from prior manual or AI edits). Treat the new instruction as a modification of that current state where it makes sense (e.g. "also add a pause at the top" keeps existing lines and adds to them); start fresh only if the instruction clearly describes a new, unrelated action. Always return the FULL resulting action, not a diff.

Respond with only the JSON object described by the schema.`;
}

function buildUserMessage(nlDescription, currentState) {
  return `Current action editor state (JSON):\n${JSON.stringify(currentState, null, 2)}\n\nInstruction: ${nlDescription}`;
}

function buildRequestBody(nlDescription, model, currentState) {
  return {
    model,
    systemPrompt: buildSystemPrompt(),
    userMessage: buildUserMessage(nlDescription, currentState),
  };
}

function validateGeneratedAction(result) {
  const warnings = [];
  const variables = Array.isArray(result.variables) ? result.variables : [];
  const gcode = Array.isArray(result.gcode) ? result.gcode : [];

  const MAGNITUDE_THRESHOLD = 50;
  variables.forEach(v => {
    if (typeof v.default === "number" && Math.abs(v.default) > MAGNITUDE_THRESHOLD) {
      warnings.push(`variable ${v.key} default of ${v.default} is unusually large — double-check before running on hardware`);
    }
  });

  const sortedVars = [...variables].sort((a, b) => (b.key || "").length - (a.key || "").length);
  const exprAllowlist = /^[0-9a-zA-Z_\s+\-*/%().,]*$/;

  gcode.forEach((rawLine, i) => {
    const command = rawLine.trim().split(" ")[0];
    if (command && !gcodeCheck.includes(command)) {
      warnings.push(`line ${i + 1}: "${command}" is not a whitelisted G/M/T code and will be dropped at runtime`);
    }

    let line = rawLine;
    sortedVars.forEach(v => {
      line = line.split(v.key).join(v.default);
    });

    const expLocations = [];
    let close = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === "{") {
        if (!close) { expLocations.push([c]); close = true; }
      }
      if (line[c] === "}") {
        if (close) { expLocations[expLocations.length - 1].push(c); close = false; }
      }
    }

    expLocations.forEach(loc => {
      if (loc.length !== 2) {
        warnings.push(`line ${i + 1}: unmatched { or } in generated gcode`);
        return;
      }
      const expr = line.slice(loc[0] + 1, loc[1]);
      if (!exprAllowlist.test(expr)) {
        warnings.push(`line ${i + 1}: expression "${expr}" contains disallowed characters and was not evaluated`);
        return;
      }
      try {
        eval(expr);
      } catch (e) {
        warnings.push(`line ${i + 1}: expression "${expr}" failed to evaluate (${e.message})`);
      }
    });
  });

  return warnings;
}

function applyResultToManualForm(result) {
  const name = (result.name || "").toLowerCase().replace(/[^a-zA-Z0-9]/g, "");
  document.querySelector("#action-name").value = name;
  document.querySelector("#action-description").value = result.description || "";

  const gcodeText = (result.gcode || []).join("\n");
  document.querySelector("#action-gcode").value = gcodeText;

  const container = document.querySelector("#action-variables-container");
  container.innerHTML = "";
  (result.variables || []).forEach(v => {
    addVariable();
    const last = container.querySelector(".action-variable-item:last-child");
    last.querySelector(".action-variable-key").value = v.key;
    last.querySelector(".action-variable-val").value = v.default;
  });

  lastAppliedGcode = gcodeText;
}

function recordCost(usage, model) {
  const price = LLM_PRICE_PER_MTOK[model];
  if (!price) return;
  const cost = ((usage.input_tokens || 0) / 1e6) * price.input + ((usage.output_tokens || 0) / 1e6) * price.output;
  llmSessionCost += cost;
  localStorage.setItem("llmCostTotal", llmSessionCost.toString());
  renderCostTracker();
}

function renderCostTracker() {
  document.querySelector("#llm-cost-tracker").textContent =
    `estimated cost so far: $${llmSessionCost.toFixed(4)} (client-side estimate only — set real limits on the OpenAI platform dashboard)`;
}

function saveAppSecret() {
  localStorage.setItem("llmAppSecret", document.querySelector("#llm-app-secret").value);
}

function loadAppSecret() {
  const secret = localStorage.getItem("llmAppSecret");
  if (secret) {
    document.querySelector("#llm-app-secret").value = secret;
  }
}

// Walks the OpenAI Responses API "output" array (one or more items of type
// "message", "reasoning", etc.) to find either the generated JSON text or a
// refusal explanation, wherever they landed in the array.
function extractResponseOutput(data) {
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const block of item.content || []) {
      if (block.type === "output_text") return { text: block.text, refusal: null };
      if (block.type === "refusal") return { text: null, refusal: block.refusal };
    }
  }
  return { text: null, refusal: null };
}

async function onGenerateClick() {
  const btn = document.querySelector("#llm-generate-btn");
  const status = document.querySelector("#llm-status");
  const messages = document.querySelector("#llm-messages");
  const description = document.querySelector("#llm-description").value.trim();
  const secret = document.querySelector("#llm-app-secret").value;
  const model = document.querySelector("#llm-model").value;

  messages.innerHTML = "";

  if (!description) {
    messages.innerHTML = "<li>describe the action before generating</li>";
    return;
  }
  if (!secret) {
    messages.innerHTML = "<li>enter the app password before generating</li>";
    return;
  }

  const currentState = collectManualFormState();
  const currentGcode = currentState.gcode.join("\n");
  if (currentGcode && currentGcode !== lastAppliedGcode) {
    if (!confirm("Generating will overwrite the current Manual tab fields. Continue?")) {
      return;
    }
  }

  btn.classList.add("active");
  status.textContent = "generating...";

  let response;
  try {
    response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-secret": secret },
      body: JSON.stringify(buildRequestBody(description, model, currentState)),
    });
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = `<li>could not reach the LLM proxy: ${e.message}</li>`;
    return;
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = "<li>the proxy returned a response that wasn't valid JSON</li>";
    return;
  }

  if (!response.ok) {
    status.textContent = "";
    btn.classList.remove("active");
    const detail = (data && data.error) ? data.error : `HTTP ${response.status}`;
    messages.innerHTML = `<li>generation failed: ${detail}</li>`;
    return;
  }

  const { text: outputText, refusal } = extractResponseOutput(data);

  if (refusal) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = `<li>the model declined this request: ${refusal}</li>`;
    return;
  }

  if (!outputText) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = "<li>no text content returned by the model</li>";
    return;
  }

  let result;
  try {
    result = JSON.parse(outputText);
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = "<li>could not parse the generated action as JSON</li>";
    return;
  }

  const warnings = validateGeneratedAction(result);
  applyResultToManualForm(result);

  if (data.usage) {
    recordCost(data.usage, model);
  }

  status.textContent = "";
  btn.classList.remove("active");
  messages.innerHTML = warnings.map(w => `<li>${w}</li>`).join("");
}

function initLlmEditor() {
  document.querySelector("#action-editor-tab-manual").addEventListener("click", () => switchEditorTab("manual"));
  document.querySelector("#action-editor-tab-llm").addEventListener("click", () => switchEditorTab("llm"));
  document.querySelector("#llm-generate-btn").addEventListener("click", onGenerateClick);
  document.querySelector("#llm-app-secret").addEventListener("change", saveAppSecret);
  loadAppSecret();
  renderCostTracker();
}
