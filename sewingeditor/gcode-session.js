// Multi-turn, session-aware raw-gcode LLM generation for the "printing
// session" page (gcode-session.html). Parallel to llm-gcode.js's single-turn
// flow — not shared, since this flow diverges in two structural ways:
//   1. "current state" is a whole physical print session (filament/temp/
//      Z-start-offset, fresh-vs-continuation, a deterministically chosen
//      prime spot, and a history of already-RUN turns), not just whatever is
//      in the textarea.
//   2. On a continuation turn the model is asked to return ONLY the new
//      incremental gcode, not a full restatement — the app's own history
//      panel carries the running record instead.
// Still posts to the same /api/generate-gcode endpoint with the same
// {provider, model, effort, thinking, systemPrompt, userMessage} shape as
// llm-gcode.js — all session context is folded into those two strings
// client-side, so the backend needs no changes at all.
// Reuses llm.js's provider-agnostic helpers (extractResponseOutput,
// wasTruncated, escapeHtml, readJsonResponse, recordCost, updateModelOptions,
// saveAppSecretFrom/loadAppSecretInto, renderCostTracker) since those don't
// know or care about the shape of the generated payload.

const GCODE_SESSION_STORAGE_KEY = "gcodeSessionState";

// Deterministically cycled prime spots (perimeter of the 220x220 bed, ~10-15mm
// in), so a continuation turn never primes on top of a prior turn's work
// without needing the model to infer/remember unused spots from prose.
// Sessions past 8 committed turns wrap around and can reuse an earlier spot —
// a known limitation, not worth a bigger list until it's actually a problem.
const PRIME_CANDIDATES = [
  { x: 10, y: 10 }, { x: 210, y: 10 }, { x: 210, y: 210 }, { x: 10, y: 210 },
  { x: 110, y: 10 }, { x: 210, y: 110 }, { x: 110, y: 210 }, { x: 10, y: 110 },
];

function defaultGcodeSessionState() {
  return {
    config: {
      filament: "PLA",
      printTemp: 210,
      zStartOffset: 10,
      continuityMode: "stay-hot",
    },
    turns: [],
  };
}

function loadGcodeSessionState() {
  const raw = localStorage.getItem(GCODE_SESSION_STORAGE_KEY);
  if (!raw) return defaultGcodeSessionState();
  try {
    const parsed = JSON.parse(raw);
    return {
      config: { ...defaultGcodeSessionState().config, ...(parsed.config || {}) },
      turns: Array.isArray(parsed.turns) ? parsed.turns : [],
    };
  } catch (e) {
    return defaultGcodeSessionState();
  }
}

function saveGcodeSessionState() {
  localStorage.setItem(GCODE_SESSION_STORAGE_KEY, JSON.stringify(gcodeSession));
}

let gcodeSession = loadGcodeSessionState();

// The last-generated-but-not-yet-run draft, so a Run click can decide whether
// to commit it to history. Deliberately not persisted — losing an uncommitted
// draft on reload is correct, since nothing physical happened yet.
let pendingTurn = null;
let lastAppliedGcodeSessionText = "";

// substrateFresh is derived, never stored as its own flag, so it can't drift
// out of sync with the turns array it's supposed to describe.
function isFreshSubstrate() {
  return gcodeSession.turns.length === 0;
}

function getPrimeLocation(turnIndex) {
  return PRIME_CANDIDATES[turnIndex % PRIME_CANDIDATES.length];
}

function summarizePriorTurns(turns) {
  if (turns.length === 0) return "";
  const recent = turns.slice(-5);
  const startNumber = turns.length - recent.length + 1;
  const lines = recent.map((t, i) => {
    const shortExplanation = (t.explanation || "").slice(0, 150);
    return `- Turn ${startNumber + i} ("${t.instruction}") — ${shortExplanation}`;
  });
  return `\nPRIOR TURNS ON THIS SUBSTRATE (most recent last):\n${lines.join("\n")}\n`;
}

function buildHardwareProfileSection(config) {
  if (config.filament === "TPU") {
    return `HARDWARE PROFILE (Ender 3 V2 + Creality Sprite direct-drive extruder, TPU, 0.4mm nozzle — do not deviate without being told to)
- Nozzle temp for this session: ${config.printTemp}C — use exactly this value, do not deviate. Bed temp: 50-60C (60C is a reasonable default on this hardware).
- Extrusion width: 0.44mm. Filament diameter: 1.75mm. Layer height: 0.2mm (a texture element's total height is a whole multiple of this).
- Retraction: TPU is a flexible filament and behaves very differently from PLA in a direct-drive feed path — use MUCH shorter retraction than PLA, 0-1.5mm at a slower 1200-1800 mm/min, or skip retraction entirely for short travels. Aggressive retraction on a flexible filament is more likely to buckle in the hobbed-gear feed path than to actually pull the filament back cleanly.
- Z-hop for travel between features: ~0.4mm. Travel feed: 1500-2400 mm/min (slower than PLA — TPU's elasticity means fast travel moves risk the filament compressing/buckling in the feed path before the hot end). Print feed: 150-250 mm/min for small/curved features (dots, arcs), 200-350 mm/min for straight lines — notably slower than PLA to give the flexible filament time to feed consistently.
- Bed size 220x220mm.
CAVEAT: these TPU numbers are best-effort defaults, not hands-on tuned on this specific hardware (unlike the PLA profile below, which came from a real tuning session on this exact printer — see docs/gcode-session-system-prompt.md). Treat them cautiously and flag anything that looks like it's underperforming (stringing, under-extrusion, grinding) in the explanation field.`;
  }

  return `HARDWARE PROFILE (Ender 3 V2 + Creality Sprite direct-drive extruder, PLA, 0.4mm nozzle — do not deviate without being told to)
- Nozzle temp for this session: ${config.printTemp}C — use exactly this value, do not deviate. Bed temp: 60C.
- Extrusion width: 0.44mm. Filament diameter: 1.75mm. Layer height: 0.2mm (a texture element's total height is a whole multiple of this).
- Retraction: 0.4-0.6mm at 2400-3000 mm/min. This is a DIRECT-DRIVE extruder — never use Bowden-style retraction distances (5mm+); on this hardware that over-retracts, grinds filament against the hobbed gear, and ruins the feed. Circles/dots need more retraction than straight lines (more internal pressure from a longer continuous multi-ring path) — 0.55mm is a good default for those; 0.4-0.5mm suffices for lines.
- Z-hop for travel between features: ~0.4mm. Travel feed: 3000-3600 mm/min. Print feed: 300 mm/min for small/curved features (dots, arcs), 400-600 mm/min for straight lines.
- Bed size 220x220mm.`;
}

// Every turn, regardless of fresh/continuation or continuity mode, ends with
// the same travel move a normal end-of-print gcode does on this class of
// printer (Cura's stock Ender 3 end-gcode: lift Z, then "G1 X0 Y220 ;Present
// print") — moving the bed clear so the current state of the substrate is
// visible before the next instruction, not just at the very end of the whole
// job. `includeCooldown` controls whether the heaters/steppers also shut off
// here (only when this turn is genuinely the end of physical activity until
// Reset) or whether the session stays live for another turn.
function buildPresentationMove(includeCooldown) {
  if (includeCooldown) {
    return "End with this hardware's normal end-of-print presentation move, then cool down and park: G1 Z10 F3000 / G0 X0 Y220 F3000 / M104 S0 / M140 S0 / M106 S0 / M84 X Y E.";
  }
  return "End with this hardware's normal end-of-print presentation move — G1 Z10 F3000 / G0 X0 Y220 F3000 — so the current state of the substrate is visible before the next turn. Do NOT turn off the heaters or disable steppers (no M104 S0/M140 S0/M84) — the session continues from here.";
}

function buildSessionContinuitySection(config, primeLocation, fresh, turns) {
  const primeText = `X${primeLocation.x} Y${primeLocation.y}`;
  const zStart = config.zStartOffset;
  const presentationMove = buildPresentationMove(config.continuityMode === "full-reset");

  if (fresh) {
    return `SESSION CONTINUITY
This is the FIRST turn on a fresh, blank substrate — nothing has been printed yet. Start with a heat/home/prime sequence, e.g. (adapt coordinates as needed, but keep the shape of it):
  G21 / G90 / M83 / M104 S${config.printTemp} / M140 S60 / M190 S60 / M109 S${config.printTemp} / G28 / G92 E0 / G1 Z${zStart} F3000
then a short prime line at ${primeText} (move there, extrude a short line to purge the nozzle, e.g. ~12mm of E over ~15mm of travel, then retract) before the first real feature — this avoids the first real stroke starting under-extruded from a cold, unprimed nozzle.
${presentationMove}`;
  }

  const priorTurnsText = summarizePriorTurns(turns);

  if (config.continuityMode === "stay-hot") {
    return `SESSION CONTINUITY
This is a CONTINUATION turn on the same physical substrate as prior turns — the nozzle is assumed to still be hot and homed from the end of the last turn (this session keeps the machine hot between turns rather than cooling down each time). Do NOT re-home (no G28), do NOT re-heat (no M104/M140/M109/M190), and do NOT repeat G92 E0.
Travel to the new prime location ${primeText} (this turn's prime spot is deliberately different from every prior turn's, to avoid priming on top of existing work) and prime there the same way a fresh job would (short purge line, then retract) before drawing anything new.
Emit ONLY this turn's new feature(s) in "gcode" — do not restate, redraw, or re-derive anything from a prior turn; the app's own history panel keeps the full record of what's already been printed, not the gcode box. This is a deliberate exception to returning "the full result" — for this session, each turn's gcode is additive, not a full restatement.
${presentationMove}${priorTurnsText}`;
  }

  return `SESSION CONTINUITY
This is a CONTINUATION turn — the physical substrate already has prior turns' geometry on it, so do NOT redraw or restate anything from a prior turn; emit ONLY this turn's new feature(s) in "gcode". However, this session fully resets machine state on every single run, so even though the substrate itself continues, treat this turn as its own complete job:
  G21 / G90 / M83 / M104 S${config.printTemp} / M140 S60 / M190 S60 / M109 S${config.printTemp} / G28 / G92 E0 / G1 Z${zStart} F3000
then prime at ${primeText} (this turn's prime spot is deliberately different from every prior turn's, to avoid priming on top of existing work), draw only the new feature(s). ${presentationMove}${priorTurnsText}`;
}

function buildGcodeSessionSystemPrompt(config, primeLocation, fresh, turns) {
  const whitelist = gcodeCheck.join(", ");
  const primeLocationText = `X${primeLocation.x} Y${primeLocation.y}`;

  return `You generate raw G-code that prints TACTILE GRAPHICS — touch-readable diagrams built from raised extruded texture (dots, lines, hatching, ridged/ribbed strokes) rather than a solid 3D object. Output goes straight to the machine, to be run directly and immediately, as ONE TURN of an ongoing multi-turn printing session on a single physical substrate. This is NOT the app's "action" template system — do not use "__" variable placeholders or {} expressions here. Every value must be a concrete literal, computed from the actual geometry requested, never guessed.

Respond with JSON: { "gcode": string[], "explanation": string }
- gcode: array of strings, each one complete G-code line, ready to run as-is.
- explanation: see EXPLANATION FIELD below.

FORMAT RULES
1. Each line's command word (before the first space) MUST be one of this exact whitelist — any other G/M/T code is silently dropped by the app at runtime and will not run:
   ${whitelist}
2. Use only concrete numeric values — no "__key" placeholders, no {} expressions. Those belong to this app's separate "actions" feature and are not supported here; a line containing them would be sent to the machine literally, not substituted.
3. Do not include comments (; ... or // ...) in gcode lines.

${buildHardwareProfileSection(config)}

EXTRUSION MATH — always compute E this way from actual geometry, never invent a flat E value that isn't derived from a length:
  e_per_mm = (extrusion_width * layer_height) / (pi * (filament_diameter/2)^2)
  E for a straight or curved segment = e_per_mm * segment_length
  (segment_length for an arc is its arc length: 2*pi*radius for a full circle, proportionally less for a partial one)

POSITIONING AND EXTRUSION MODE
- Use G90 (absolute) for all X/Y/Z coordinates throughout. Do not use G91 for position.
- Set M83 (relative extrusion) once near the top of the gcode, and never toggle it. Every E value from then on is a delta, not an absolute target. Do not mix G91 with extrusion math — G91 does NOT change E mode, and assuming it does is a common, serious bug (an E delta gets interpreted as an absolute target, causing a huge unintended retraction or extrusion).
- Track the actual amount retracted at each point and de-retract by that same amount before the next print move. Do not assume a fixed retract value if different features retract by different amounts (dots vs. lines, see HARDWARE PROFILE) — mismatches cause progressive under-priming.

${buildSessionContinuitySection(config, primeLocation, fresh, turns)}

TEXTURE PRIMITIVES FOR TACTILE GRAPHICS — compose a graphic out of these; pick primitives that will feel distinct from each other by touch when representing different regions/series/meanings:
- DOT (a filled point, size-controllable): trace concentric circles (G2/G3) from the outer radius inward, each ring stepped in by ~0.85x the extrusion width, connected ring-to-ring by a short straight radial bridge (with its own computed E). Finish with a short spoke into the exact center — never a stationary "insurance" extrusion dab (pushing extra material while stationary spikes nozzle pressure right before retract and worsens stringing; a tiny unclosed pinhole at the center is the better trade). Retract once, after the whole dot, not once per ring.
- SOLID LINE (straight or curved, continuous ridge): steady E along the path from the extrusion math above. A short prime blob + brief dwell (G4) at the very start of the line avoids a thin, under-extruded lead-in.
- ZIGZAG / SQUIGGLY LINE: like a solid line, but oscillate a perpendicular offset (triangle wave) along the path — alternate +amplitude/-amplitude at evenly spaced points along the direction of travel. Reads as a distinct wavy ridge versus a straight one.
- DOTTED LINE: pulse extrusion in short bursts along a path — extrude a short segment, retract, travel to the next point along the path, de-retract, extrude again — producing a row of separated bumps instead of a continuous ridge. Distinct by touch from a solid line even along the same path shape.
- RIBBED / TEXTURED LINE: split a straight line into equal-length segments and alternate the E rate between two multipliers on consecutive segments (e.g. one segment at the normal computed E, the next at roughly double) without changing feed or path — creates a palpable ridged texture along an otherwise straight line, distinct from a smooth solid line.
- HATCH FILL (scanline): fill or texture an area with parallel line strokes spaced about 1x extrusion width apart, clipped to the region's boundary. More robust than concentric fill for concave or irregular areas (star shapes, letterforms, anything non-convex); pair it with a separate outline pass for a crisp edge, since scanline fill alone leaves a stair-stepped boundary.
- FRAME / OUTLINE: a closed boundary path (e.g. a circle or polygon outline) printed to a taller total height than the texture inside it (see MULTI-FEATURE GRAPHICS below), giving a palpable raised border that lets a reader find the edge of a region by touch before exploring its interior texture.

FILLING A LARGER CLOSED SHAPE (not just a small dot)
- A single perimeter outline only reads as "solid" when the traced path is small enough that the extrusion width itself nearly fills it (true for ~1-2mm dots). Anything bigger needs real infill:
  (a) Contour offset (concentric) fill — repeatedly offset the boundary inward by ~0.7-0.85x the extrusion width and trace it, continuing toward the interior. Good for convex/simple shapes (circles, ovals, rounded rectangles, most simple polygons); can self-intersect or produce garbled paths on concave shapes, thin extensions, or shapes with holes (letterforms with counters, star shapes).
  (b) Scanline/zigzag fill (see HATCH FILL above) — more robust for arbitrary or concave shapes.
  Default to (a) when the shape is confirmed convex or circular; use (b) otherwise, or when convexity can't be confirmed from the description.
- Regardless of method: retract only once per whole filled feature, not once per ring/scanline.
- End the fill path at an interior point that's already covered by other material (dot center for concentric fill, the last scanline's endpoint for zigzag), not at the outermost/most exposed point — so any residual ooze at lift-off lands on material already down, not toward the next feature.
- Do NOT add a stationary "insurance" dab to close a small remaining gap — see the DOT primitive above; the same reasoning applies to any filled shape.

ANTI-STRINGING, IN ORDER OF EXPECTED IMPACT
1. A settling dwell (G4 P100) after the print move but before retract, so the deposit bonds before the nozzle pulls back.
2. A second short dwell (G4 P50) after retract but before the next travel move, letting internal pressure relax before the nozzle moves.
3. Fast retract speed (~3000mm/min) shears cleanly; fast travel speed (~3600mm/min) shortens the ooze-exposure window.
4. After retracting at the end of any printed path that ends at an exposed (non-interior) point — a straight or curved line, not a shape whose fill already ends at an interior point — add a short (~1mm) reverse wipe backward along the tangent direction of the last extruded segment, before traveling away. This generalizes to curves too: it's always "reverse from wherever the nozzle just was," never specific to straight lines. Skip it when the path already ends at a hidden/interior point (see FILLING above) — the two techniques solve the same problem and don't need to stack.
5. Light coasting — extrude for slightly less than the full move distance (e.g. 0.2-0.3mm short) while still commanding the full move — relieves pressure at the end of a move without needing more retraction. Applies to the final segment of any print move.
6. A single feature requiring a very long continuous extrusion path (dense infill, many mm of uninterrupted travel) risks sustained flow falling behind at the low end of the temperature range — note this as a risk in the explanation field rather than silently assuming it will print cleanly.

MULTI-FEATURE GRAPHICS (more than one shape/line/dot in one turn)
- Order sub-paths to minimize total travel distance between them.
- If different sub-features need different relief heights (e.g. a frame meant to stand taller than the texture inside it), don't print each feature to full height in one pass. Loop by layer instead: for each layer height from the bottom up, emit only the sub-features whose target height is greater than or equal to that layer's Z — so a tall frame keeps getting reprinted at the same X/Y on layers where a shorter texture feature has already stopped.
- The very first travel move of this turn (right after its priming sequence) is a special case: the nozzle may already be elevated above the first feature's normal hop height (e.g. from the prime block's own safety lift). Compute that first travel height as the max of the current safe height and the hop target, not the hop target alone — otherwise the first move silently drops clearance before the longest, most exposed travel of the turn.

SAFETY BOUNDS
- Bed is 220x220mm. Confirm every X/Y coordinate you emit stays within 0-220 on both axes given the geometry described. If a described layout could push a coordinate out of bounds, say so explicitly in the explanation field rather than emitting gcode that assumes it fits.
- The prime location for this turn is fixed at ${primeLocationText} — use it as given, do not choose your own prime spot.

EXPLANATION FIELD
- State what the gcode physically produces, one or two sentences.
- State the one or two things most likely to go wrong on real hardware (stringing, under-fill, grinding, out-of-bounds) and which technique above this gcode already uses to mitigate them.
- If you deliberately skipped a technique from this prompt (e.g. no wipe move because the path never travels between two exposed print points), say so rather than leaving it unexplained.
- On a continuation turn, briefly note what this turn adds relative to what's already on the substrate (a summary of prior turns is given above).

You will also be given the CURRENT content of the gcode box (may be empty, may hold a still-unrun draft from this same turn's own prior generation, or hand edits). Treat the new instruction as what to add or change for THIS turn specifically. On a fresh-substrate turn, follow the SESSION CONTINUITY instructions above for a full self-contained job. On a continuation turn, return ONLY this turn's new gcode as instructed above — never restate prior turns' geometry, since the app's history panel already keeps that record.

Respond with only the JSON object described by the schema.`;
}

function collectGcodeSessionBoxState() {
  return {
    gcode: document.querySelector("#raw-gcode-textarea").value.split("\n").filter(l => l.trim() !== ""),
  };
}

function buildGcodeSessionUserMessage(nlDescription, currentState) {
  return `Current gcode box content (JSON):\n${JSON.stringify(currentState, null, 2)}\n\nInstruction: ${nlDescription}`;
}

function buildGcodeSessionRequestBody(nlDescription, provider, model, effort, thinking, currentState, primeLocation, fresh) {
  return {
    provider,
    model,
    effort,
    thinking,
    systemPrompt: buildGcodeSessionSystemPrompt(gcodeSession.config, primeLocation, fresh, gcodeSession.turns),
    userMessage: buildGcodeSessionUserMessage(nlDescription, currentState),
  };
}

function validateGeneratedSessionGcode(result) {
  const warnings = [];
  const gcode = Array.isArray(result.gcode) ? result.gcode : [];

  gcode.forEach((line, i) => {
    const command = line.trim().split(" ")[0];
    if (command && !gcodeCheck.includes(command)) {
      warnings.push(`line ${i + 1}: "${command}" is not a whitelisted G/M/T code and will be dropped at runtime`);
    }
    if (/__[a-zA-Z0-9]/.test(line) || /[{}]/.test(line)) {
      warnings.push(`line ${i + 1}: contains "__" or "{}" syntax, which isn't supported for raw gcode — it will be sent literally, not substituted`);
    }
  });

  return warnings;
}

function applyResultToSessionGcodeBox(result, instruction, primeLocation, fresh) {
  const gcodeText = (result.gcode || []).join("\n");
  document.querySelector("#raw-gcode-textarea").value = gcodeText;
  lastAppliedGcodeSessionText = gcodeText;
  pendingTurn = {
    instruction,
    gcode: result.gcode || [],
    explanation: result.explanation || "",
    primeLocation,
    substrateFreshAtGenerate: fresh,
  };
}

function renderHistoryPanel() {
  const container = document.querySelector("#gcode-session-history-list");
  if (gcodeSession.turns.length === 0) {
    container.innerHTML = `<p style="color:#999;">no turns printed yet on this substrate</p>`;
    return;
  }
  container.innerHTML = gcodeSession.turns.map((t, i) => {
    const time = new Date(t.timestamp).toLocaleTimeString();
    return `<div class="session-turn-item">
      <div class="session-turn-header">Turn ${i + 1} &middot; ${time} &middot; prime X${t.primeLocation.x} Y${t.primeLocation.y}${t.substrateFreshAtGenerate ? " &middot; fresh substrate" : ""}</div>
      <div class="session-turn-instruction">${escapeHtml(t.instruction)}</div>
      <div class="session-turn-explanation">${escapeHtml(t.explanation)}</div>
    </div>`;
  }).join("");
}

// Second, independent click listener on #run-gcode-btn (alongside script.js's
// own, which actually streams the gcode to the printer) — this one only
// decides whether that run should be recorded as a session turn. Only a Run
// that matches the last AI-generated, still-pending draft counts: hand-typed
// gcode or re-running something already committed leaves history untouched,
// so history stays an honest record of AI turns actually sent to hardware.
function commitPendingTurnIfMatches() {
  if (!fab.isPrinting) return;
  if (!pendingTurn) {
    pushMessage("ran gcode not tied to an AI turn — session history unchanged", "#999");
    return;
  }
  const liveText = document.querySelector("#raw-gcode-textarea").value;
  if (liveText !== pendingTurn.gcode.join("\n")) {
    pushMessage("ran gcode not tied to an AI turn — session history unchanged", "#999");
    return;
  }
  gcodeSession.turns.push({
    instruction: pendingTurn.instruction,
    explanation: pendingTurn.explanation,
    gcode: pendingTurn.gcode,
    primeLocation: pendingTurn.primeLocation,
    substrateFreshAtGenerate: pendingTurn.substrateFreshAtGenerate,
    timestamp: Date.now(),
  });
  pendingTurn = null;
  saveGcodeSessionState();
  renderHistoryPanel();
  pushMessage("turn recorded in session history", "green");
}

function resetGcodeSession() {
  if (!confirm("This clears the session history and starts fresh, as if the printer is now working on a brand-new blank substrate. Continue?")) {
    return;
  }
  gcodeSession.turns = [];
  pendingTurn = null;
  document.querySelector("#raw-gcode-textarea").value = "";
  lastAppliedGcodeSessionText = "";
  saveGcodeSessionState();
  renderHistoryPanel();
  pushMessage("session reset — printer treated as starting on a new substrate", "blue");
}

function exportGcodeSessionAsFile() {
  const data = JSON.stringify(gcodeSession, null, 2);
  const blob = new Blob([data], { type: "application/json" });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `gcode-session-${Date.now()}.json`;

  document.body.appendChild(link);
  link.click();

  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

async function onGcodeSessionGenerateClick() {
  const btn = document.querySelector("#gcode-session-generate-btn");
  const status = document.querySelector("#gcode-session-status");
  const messages = document.querySelector("#gcode-session-messages");
  const explanationEl = document.querySelector("#gcode-session-explanation");
  const description = document.querySelector("#gcode-session-description").value.trim();
  const secret = document.querySelector("#gcode-session-app-secret").value;
  const provider = document.querySelector("#gcode-session-provider").value;
  const model = document.querySelector("#gcode-session-model").value;
  const effort = document.querySelector("#gcode-session-effort").value;
  const thinking = document.querySelector("#gcode-session-thinking").value === "on";

  messages.innerHTML = "";
  explanationEl.textContent = "";

  if (!description) {
    messages.innerHTML = "<li>describe what to add before generating</li>";
    return;
  }
  if (!secret) {
    messages.innerHTML = "<li>enter the app password before generating</li>";
    return;
  }

  const currentState = collectGcodeSessionBoxState();
  const currentGcode = currentState.gcode.join("\n");
  if (currentGcode && currentGcode !== lastAppliedGcodeSessionText) {
    if (!confirm("Generating will overwrite the current gcode box content. Continue?")) {
      return;
    }
  }

  btn.classList.add("active");
  status.textContent = "generating...";

  const fresh = isFreshSubstrate();
  const primeLocation = getPrimeLocation(gcodeSession.turns.length);

  let response;
  try {
    response = await fetch("/api/generate-gcode", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-secret": secret },
      body: JSON.stringify(buildGcodeSessionRequestBody(description, provider, model, effort, thinking, currentState, primeLocation, fresh)),
    });
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    messages.innerHTML = `<li>could not reach the LLM proxy: ${e.message}</li>`;
    return;
  }

  let data;
  try {
    data = await readJsonResponse(response);
  } catch (e) {
    status.textContent = "";
    btn.classList.remove("active");
    const preview = e.rawText ? (e.rawText.length > 500 ? e.rawText.slice(0, 500) + "…" : e.rawText) : "(empty response)";
    messages.innerHTML = `<li>the proxy returned a response that wasn't valid JSON</li><li style="white-space:pre-wrap;">${escapeHtml(preview)}</li>`;
    return;
  }

  if (!response.ok) {
    status.textContent = "";
    btn.classList.remove("active");
    const detail = (data && data.error) ? data.error : `HTTP ${response.status}`;
    messages.innerHTML = `<li>generation failed: ${detail}</li>`;
    return;
  }

  const { text: outputText, refusal } = extractResponseOutput(data, provider);

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
    if (wasTruncated(data, provider)) {
      messages.innerHTML = "<li>generation was cut off before finishing (hit the token limit) — try again, or shorten the description</li>";
    } else {
      const preview = outputText.length > 500 ? outputText.slice(0, 500) + "…" : outputText;
      messages.innerHTML = `<li>could not parse the generated gcode as JSON: ${escapeHtml(e.message)}</li><li style="white-space:pre-wrap;">${escapeHtml(preview)}</li>`;
    }
    return;
  }

  const warnings = validateGeneratedSessionGcode(result);
  applyResultToSessionGcodeBox(result, description, primeLocation, fresh);
  explanationEl.textContent = result.explanation || "";

  if (data.usage) {
    recordCost(data.usage, model);
  }

  status.textContent = "";
  btn.classList.remove("active");
  messages.innerHTML = warnings.map(w => `<li>${w}</li>`).join("");
}

function initGcodeSessionEditor() {
  document.querySelector("#gcode-session-generate-btn").addEventListener("click", onGcodeSessionGenerateClick);
  document.querySelector("#gcode-session-app-secret").addEventListener("change", () => saveAppSecretFrom("gcode-session-app-secret"));
  document.querySelector("#gcode-session-provider").addEventListener("change", () => updateModelOptions("gcode-session-provider", "gcode-session-model"));
  document.querySelector("#gcode-session-reset-btn").addEventListener("click", resetGcodeSession);
  document.querySelector("#gcode-session-export-btn").addEventListener("click", exportGcodeSessionAsFile);
  document.querySelector("#run-gcode-btn").addEventListener("click", commitPendingTurnIfMatches);

  document.querySelector("#gcode-session-filament").addEventListener("change", () => {
    gcodeSession.config.filament = document.querySelector("#gcode-session-filament").value;
    saveGcodeSessionState();
  });
  document.querySelector("#gcode-session-print-temp").addEventListener("change", () => {
    gcodeSession.config.printTemp = parseFloat(document.querySelector("#gcode-session-print-temp").value) || 210;
    saveGcodeSessionState();
  });
  document.querySelector("#gcode-session-z-start-offset").addEventListener("change", () => {
    gcodeSession.config.zStartOffset = parseFloat(document.querySelector("#gcode-session-z-start-offset").value) || 10;
    saveGcodeSessionState();
  });
  document.querySelector("#gcode-session-continuity-mode").addEventListener("change", () => {
    gcodeSession.config.continuityMode = document.querySelector("#gcode-session-continuity-mode").value;
    saveGcodeSessionState();
  });

  document.querySelector("#gcode-session-filament").value = gcodeSession.config.filament;
  document.querySelector("#gcode-session-print-temp").value = gcodeSession.config.printTemp;
  document.querySelector("#gcode-session-z-start-offset").value = gcodeSession.config.zStartOffset;
  document.querySelector("#gcode-session-continuity-mode").value = gcodeSession.config.continuityMode;

  updateModelOptions("gcode-session-provider", "gcode-session-model");
  loadAppSecretInto("gcode-session-app-secret");
  renderCostTracker();
  renderHistoryPanel();
}
