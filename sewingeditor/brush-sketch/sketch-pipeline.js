// One gated model call with same-stage repair -- the brush-sketch version
// of parametric-with-tool/pipeline.js's runStage. Pure control flow; the
// model call and the gate are injected, so tests/brush-sketch/pipeline.mjs
// drives it with a scripted fake model and no browser.
//
//   callModel(stage, userMessage) -> { value, errors, raw }
//       errors = the call's own problems (unparseable, wrong shape)
//   gate(value) -> [error strings]      what the page's checks reject
//
// A rejected answer goes straight back to the same stage with its own
// output and the errors quoted, at most `maxRepairs` times, so a turn
// cannot spend the author's money in a loop.

export async function runGatedStage({ stage, compose, callModel, gate, maxRepairs = 2, onProgress }) {
  const attempts = [];
  let repair = null;
  let lastValid = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    onProgress?.({ stage, attempt, repairing: !!repair });
    const res = await callModel(stage, compose(repair));
    const record = { attempt, errors: res.errors || [], gateErrors: [] };
    attempts.push(record);
    if (record.errors.length) { repair = { errors: record.errors, previous: res.raw }; continue; }
    lastValid = res.value;
    record.gateErrors = gate ? await gate(res.value) : [];
    if (!record.gateErrors.length) return { ok: true, value: res.value, attempts, errors: [] };
    repair = { errors: record.gateErrors, previous: res.raw };
  }
  const last = attempts[attempts.length - 1];
  return { ok: false, value: lastValid, attempts, errors: last.errors.length ? last.errors : last.gateErrors };
}

/** Parses a stage's `program` JSON string. Returns {program} or {error}. */
export function parseProgramField(text) {
  if (typeof text !== "string" || !text.trim()) return { error: "program is empty" };
  try {
    const p = JSON.parse(text);
    if (!p || typeof p !== "object" || Array.isArray(p)) return { error: "program must be a JSON object" };
    return { program: p };
  } catch (e) {
    return { error: `program is not valid JSON: ${e.message}` };
  }
}

/** The motion a program makes at its defaults, flattened to numbers, for
 * the parameterize stage's "same motion" check. */
export function motionSignature(lib, program) {
  const steps = lib.expandSketchProgram(program, lib.resolveSketchParams(program, {}));
  return steps.map((s) => {
    if (s.op === "travel") return ["travel", ...s.to];
    if (s.op === "move") return ["move", ...s.to, s.e, s.f];
    if (s.op === "dwell") return ["dwell", s.ms];
    if (s.op === "retract" || s.op === "prime") return [s.op, s.mm, s.f ?? 0];
    return ["extrudeHere", s.e, s.ms];
  });
}

// Per signature field: mm for positions and retracts, 0.001mm for filament,
// 1 for feeds and milliseconds.
const TOLERANCE = {
  travel: [0.01, 0.01, 0.01],
  move: [0.01, 0.01, 0.01, 0.001, 1],
  dwell: [1],
  retract: [0.01, 1],
  prime: [0.01, 1],
  extrudeHere: [0.001, 1],
};

/** Differences between two motion signatures, as readable strings. */
export function compareMotion(a, b) {
  const out = [];
  if (a.length !== b.length) out.push(`the program expands to ${b.length} steps at its defaults, the drawing to ${a.length}`);
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n && out.length < 6; k++) {
    const x = a[k], y = b[k];
    if (x[0] !== y[0]) { out.push(`expanded step ${k + 1}: ${y[0]} where the drawing has ${x[0]}`); continue; }
    for (let j = 1; j < x.length; j++) {
      const tol = TOLERANCE[x[0]][j - 1];
      if (Math.abs(x[j] - y[j]) > tol) { out.push(`expanded step ${k + 1} (${x[0]}): value ${j} is ${+y[j].toFixed(4)} at the defaults, the drawing has ${+x[j].toFixed(4)}`); break; }
    }
  }
  return out;
}
