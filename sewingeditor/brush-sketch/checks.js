// The deterministic gate for a brush program: shape, params, and the
// physical checks run on the EXPANDED program at the default params and at
// the corners of every param's range. Runs on every edit and after every
// model call (a failed gate goes back to the same stage as a repair).
//
// Exploration tool: only machine-safety problems are ERRORS (they block
// the test print). Everything the texture_docs history says tends to go
// wrong -- stationary extrusion, stringing, dragging through fresh
// material -- is a WARNING: it may be exactly what the author is trying.
//
// Pure ES module; the texture library is passed in as `lib`.

// Every number here is a PLACEHOLDER in the same sense as
// parametric-with-tool's PRINT_LIMITS: guessed from the library's defaults
// and the TPU cautions, not confirmed by a print. Change them here only.
const hard = (value, applies, note = "") => ({ value, kind: "hard", status: "placeholder", applies, note });
const warn = (value, applies, note = "") => ({ value, kind: "warn", status: "placeholder", applies, note });

export const SKETCH_LIMITS = {
  minNozzleZ: hard(0.1, "nozzle height on any move, mm", "below this the nozzle scrapes the bed"),
  maxRetractSpeedTPU: hard(1000, "retract / prime feed with TPU, mm/min", "troubleshooting.md SS1: fast retraction flat-spots TPU at the drive gear"),
  maxRetractSpeedPLA: hard(2400, "retract / prime feed with PLA, mm/min", ""),
  stampNetETrip: hard(-8, "net E of one stamp (primes + extrusion - retracts), mm", "further negative is a retraction-math mistake, not a texture"),
  maxStampRadius: hard(40, "radiusMm, mm", "a stamp is a local mechanism, not a layout"),
  maxVolumetric: warn(4.0, "volumetric flow of any extruding step, mm3/s", "MAX_EXTRUSION_RATE_MM3_S -- TPU buckles under back-pressure"),
  maxStampSeconds: warn(30, "time for one stamp, s", ""),
  retractCyclesWarn: warn(250, "retraction cycles in one test file", "TPU can flat-spot at the drive gear (troubleshooting.md SS1)"),
  dryAfterExtrudeMm: warn(0.5, "dry move after extruding without a retract, mm", "strings (hairy dot v4/v5, troubleshooting.md SS12)"),
};

export const BUILTIN_OPTIONS = ["azimuthDeg", "gap", "reverse", "step"];
const RESERVED = new Set([...BUILTIN_OPTIONS, "i", "n", "pi"]);
const LEVELS = ["brush", "stroke"];

/** The limits as prompt text -- generated, so the prompt never drifts from
 * what the gate checks. */
export function sketchLimitsText() {
  const rows = (kind) => Object.values(SKETCH_LIMITS).filter((r) => r.kind === kind)
    .map((r) => `  ${r.applies}: ${r.value}${r.note ? ` -- ${r.note}` : ""}`);
  return [
    "LIMITS THE PAGE CHECKS (every number is a placeholder pending hardware confirmation)",
    "",
    "Errors -- block the test print:",
    ...rows("hard"),
    "  every param's default inside its own min..max; every expression parses",
    "  the program starts with a travel step",
    "",
    "Warnings -- shown to the author, never blocking (this is an exploration tool):",
    ...rows("warn"),
    "  extrusion while stationary (extrudeHere, or an extruding move of zero length)",
    "  extruding while still retracted (a missing prime -- under-extrusion)",
    "  a dry move passing below the top of material this stamp already laid down",
    "  a stamp that ends un-retracted (the next travel retracts 1.3mm for it)",
  ].join("\n");
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isExprOrNum = (v) => isNum(v) || (typeof v === "string" && v.trim() !== "");

/** Structural validation, before anything is expanded. */
export function validateProgramShape(p) {
  const errors = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["the program must be a JSON object"];
  if (typeof p.name !== "string" || !/^[a-z][A-Za-z0-9]{1,40}$/.test(p.name)) errors.push(`name must be camelCase letters/digits starting lower-case (got ${JSON.stringify(p.name)})`);
  if (p.orientation !== undefined && !["fixed", "tangent"].includes(p.orientation)) errors.push(`orientation must be "fixed" or "tangent"`);
  if (p.radiusMm !== undefined && !(isNum(p.radiusMm) && p.radiusMm > 0 && p.radiusMm <= SKETCH_LIMITS.maxStampRadius.value)) errors.push(`radiusMm must be a number in 0..${SKETCH_LIMITS.maxStampRadius.value}`);
  if (p.defaultGap !== undefined && !(isNum(p.defaultGap) && p.defaultGap > 0)) errors.push("defaultGap must be a positive number");
  const params = p.params ?? {};
  if (typeof params !== "object" || Array.isArray(params)) errors.push("params must be an object {name: {def, min, max, level, desc}}");
  else {
    for (const [name, s] of Object.entries(params)) {
      if (!/^[a-zA-Z][A-Za-z0-9]*$/.test(name)) errors.push(`param "${name}": names are letters/digits only`);
      if (RESERVED.has(name)) errors.push(`param "${name}": reserved name (${[...RESERVED].join(", ")})`);
      if (!s || typeof s !== "object") { errors.push(`param "${name}": must be {def, min, max, level, desc}`); continue; }
      if (!isNum(s.def) || !isNum(s.min) || !isNum(s.max)) errors.push(`param "${name}": def, min and max must be numbers`);
      else if (!(s.min <= s.def && s.def <= s.max)) errors.push(`param "${name}": def ${s.def} is outside ${s.min}..${s.max}`);
      if (s.level !== undefined && !LEVELS.includes(s.level)) errors.push(`param "${name}": level must be "brush" or "stroke"`);
    }
  }
  if (!Array.isArray(p.steps) || !p.steps.length) errors.push("steps must be a non-empty list");
  else if (p.steps[0]?.op !== "travel") errors.push("the first step must be a travel");
  const walk = (steps, where) => (steps || []).forEach((st, k) => {
    const at = `${where}${k + 1}`;
    if (!st || typeof st !== "object") { errors.push(`step ${at}: not an object`); return; }
    const need = (field) => { if (!isExprOrNum(st[field])) errors.push(`step ${at} (${st.op}): "${field}" must be a number or an expression`); };
    const vec = (field) => { if (!Array.isArray(st[field]) || st[field].length !== 3 || !st[field].every(isExprOrNum)) errors.push(`step ${at} (${st.op}): "${field}" must be [x, y, z]`); };
    switch (st.op) {
      case "travel": vec("to"); break;
      case "move":
        if (st.to !== undefined) vec("to"); else if (st.by !== undefined) vec("by"); else errors.push(`step ${at} (move): needs "to" or "by"`);
        need("f");
        if (st.e !== undefined && st.bead !== undefined) errors.push(`step ${at} (move): give "e" or "bead", not both`);
        if (st.e !== undefined && st.e !== null && st.e !== "") need("e");
        if (st.bead !== undefined && !(st.bead && isExprOrNum(st.bead.w) && isExprOrNum(st.bead.h))) errors.push(`step ${at} (move): "bead" is {w, h}`);
        break;
      case "dwell": need("ms"); break;
      case "retract": case "prime": need("mm"); break;
      case "extrudeHere": need("e"); need("ms"); break;
      case "repeat": need("n"); if (!Array.isArray(st.steps)) errors.push(`step ${at} (repeat): needs "steps": [...]`); else walk(st.steps, `${at}.`); break;
      default: errors.push(`step ${at}: unknown op ${JSON.stringify(st.op)}`);
    }
  });
  walk(p.steps, "");
  return errors;
}

/** Param combinations to check: the defaults, then every min/max corner
 * (all 2^k when k <= 4, otherwise each param's min and max alone). */
export function paramCorners(program) {
  const params = program.params || {};
  const names = Object.keys(params);
  const defs = Object.fromEntries(names.map((n) => [n, params[n].def]));
  const out = [{ label: "defaults", values: defs }];
  if (!names.length) return out;
  if (names.length <= 4) {
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const values = { ...defs };
      names.forEach((n, i) => { values[n] = mask & (1 << i) ? params[n].max : params[n].min; });
      out.push({ label: names.map((n) => `${n}=${values[n]}`).join(", "), values });
    }
  } else {
    for (const n of names) for (const end of ["min", "max"]) out.push({ label: `${n}=${params[n][end]}`, values: { ...defs, [n]: params[n][end] } });
  }
  return out;
}

const len3 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

function distPointSeg2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return { d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
}

/** Time, filament and geometry of one expanded stamp, plus the checks
 * that look at a single stamp. `where` labels the param corner. */
export function analyzeStamp(lib, steps, { material = "TPU", where = "defaults" } = {}) {
  const errors = [], warnings = [];
  const tag = (s) => `step ${s.src.map((x) => x + 1).join(".")} (${s.op})${where === "defaults" ? "" : ` at ${where}`}`;
  const FIL = lib.FIL_AREA;
  const maxRetract = material === "PLA" ? SKETCH_LIMITS.maxRetractSpeedPLA.value : SKETCH_LIMITS.maxRetractSpeedTPU.value;

  let time = 0, eNet = 0, eOut = 0, retracts = 0, depth = 0;   // depth: mm retracted right now (>0)
  let lastExtruded = false;
  const deposits = [];          // extruding moves so far: {a, b, r, zTop}
  const bbox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const grow = (p) => { bbox.minX = Math.min(bbox.minX, p[0]); bbox.maxX = Math.max(bbox.maxX, p[0]); bbox.minY = Math.min(bbox.minY, p[1]); bbox.maxY = Math.max(bbox.maxY, p[1]); bbox.minZ = Math.min(bbox.minZ, p[2]); bbox.maxZ = Math.max(bbox.maxZ, p[2]); };
  const once = new Set();
  const warnOnce = (key, msg) => { if (!once.has(key)) { once.add(key); warnings.push(msg); } };

  // The stamp starts retracted (the travel's goto() leaves it that way);
  // how deep depends on what came before, so the first prime is taken as
  // restoring it, whatever its size.
  depth = null;
  for (const s of steps) {
    if (s.op === "travel") {
      grow(s.to);
      if (s.to[2] < SKETCH_LIMITS.minNozzleZ.value) errors.push(`${tag(s)}: starts at z=${s.to[2].toFixed(2)}, below ${SKETCH_LIMITS.minNozzleZ.value}mm`);
      continue;
    }
    if (s.op === "move") {
      grow(s.to);
      const L = len3(s.from, s.to);
      const dt = (L / s.f) * 60;
      time += dt;
      if (Math.min(s.from[2], s.to[2]) < SKETCH_LIMITS.minNozzleZ.value) errors.push(`${tag(s)}: nozzle goes to z=${Math.min(s.from[2], s.to[2]).toFixed(2)}, below ${SKETCH_LIMITS.minNozzleZ.value}mm`);
      if (s.e > 0) {
        eNet += s.e; eOut += s.e;
        if (depth !== null && depth > 1e-6) warnOnce(`retracted${s.src}`, `${tag(s)}: extrudes while the filament is still retracted by ${depth.toFixed(2)}mm -- the first ${depth.toFixed(2)}mm only refills the nozzle (a missing prime?)`);
        if (L < 1e-6) warnOnce(`still${s.src}`, `${tag(s)}: extrudes without moving -- stationary extrusion (blob dot v8 folded this into a rising move)`);
        else {
          const rate = (s.e * FIL) / dt;
          if (rate > SKETCH_LIMITS.maxVolumetric.value) warnOnce(`vol${s.src}`, `${tag(s)}: ${rate.toFixed(1)}mm3/s is over the ${SKETCH_LIMITS.maxVolumetric.value}mm3/s flow limit -- slow it down or extrude less`);
          const r = Math.max(0.2, Math.sqrt((s.e * FIL) / L / Math.PI));
          deposits.push({ a: s.from, b: s.to, r, zTop: Math.max(s.from[2], s.to[2]), src: s.src });
        }
        lastExtruded = true;
      } else if (L > 1e-6) {
        if (lastExtruded && (depth === null || depth <= 1e-6) && L >= SKETCH_LIMITS.dryAfterExtrudeMm.value) {
          warnOnce(`string${s.src}`, `${tag(s)}: moves ${L.toFixed(1)}mm dry right after extruding without a retract -- likely to string`);
        }
        // Collision: sample the dry move and see whether it passes below the
        // top of something already deposited. Points right where the nozzle
        // is leaving from are skipped -- it is always touching what it just
        // laid there.
        const n = Math.max(2, Math.ceil(L / 0.2));
        for (const d of deposits) {
          let hit = false;
          for (let k = 1; k <= n && !hit; k++) {
            const t = k / n;
            const p = [s.from[0] + (s.to[0] - s.from[0]) * t, s.from[1] + (s.to[1] - s.from[1]) * t, s.from[2] + (s.to[2] - s.from[2]) * t];
            if (Math.hypot(p[0] - s.from[0], p[1] - s.from[1]) < 0.6) continue;
            const { d: dist, t: u } = distPointSeg2(p, d.a, d.b);
            // a vertical rise (no xy extent) stands as tall as its top
            const flat = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) < 1e-6;
            const zTop = flat ? d.zTop : d.a[2] + (d.b[2] - d.a[2]) * u;
            if (dist < d.r && p[2] < zTop - 0.1) hit = true;
          }
          if (hit) { warnOnce(`hit${s.src}`, `${tag(s)}: passes below the top of material laid by step ${d.src.map((x) => x + 1).join(".")} -- drags through it (fine if that is the point, e.g. a squish)`); break; }
        }
        lastExtruded = false;
      }
      continue;
    }
    if (s.op === "dwell") { time += s.ms / 1000; continue; }
    if (s.op === "retract" || s.op === "prime") {
      const f = s.f ?? lib.RETRACT_SPEED;
      if (f > maxRetract) errors.push(`${tag(s)}: ${Math.round(f)}mm/min is over the ${material} ${s.op} speed cap of ${maxRetract}mm/min`);
      time += (s.mm / f) * 60;
      if (s.op === "retract") { retracts++; eNet -= s.mm; depth = (depth ?? 0) + s.mm; lastExtruded = false; }
      else { eNet += s.mm; depth = depth === null ? 0 : Math.max(0, depth - s.mm); }
      continue;
    }
    if (s.op === "extrudeHere") {
      time += s.ms / 1000;
      eNet += s.e; eOut += s.e;
      grow(s.at);
      const rate = (s.e * FIL) / (s.ms / 1000);
      // a puddle: a half-sphere of its volume, as tall as the nozzle was
      deposits.push({ a: s.at, b: s.at, r: Math.max(0.2, Math.cbrt((3 * s.e * FIL) / (2 * Math.PI))), zTop: s.at[2] + 0.2, src: s.src });
      warnOnce(`here${s.src}`, `${tag(s)}: deliberate stationary extrusion (${rate.toFixed(1)}mm3/s) -- pressure builds with nowhere to go; TPU tends to keep oozing after (troubleshooting.md SS10)`);
      if (rate > SKETCH_LIMITS.maxVolumetric.value) warnOnce(`vol${s.src}`, `${tag(s)}: ${rate.toFixed(1)}mm3/s is over the ${SKETCH_LIMITS.maxVolumetric.value}mm3/s flow limit`);
      if (depth !== null && depth > 1e-6) warnOnce(`retracted${s.src}`, `${tag(s)}: extrudes while still retracted by ${depth.toFixed(2)}mm`);
      lastExtruded = true;
    }
  }

  const primes = steps.filter((s) => s.op === "prime").reduce((a, s) => a + s.mm, 0);
  const pulled = steps.filter((s) => s.op === "retract").reduce((a, s) => a + s.mm, 0);
  const endsPrimed = steps.reduce((p, s) => (s.op === "prime" ? true : s.op === "retract" ? false : p), false);
  if (eNet < SKETCH_LIMITS.stampNetETrip.value) errors.push(`net E of one stamp is ${eNet.toFixed(2)}mm${where === "defaults" ? "" : ` at ${where}`} -- far more is retracted than extruded`);
  if (time > SKETCH_LIMITS.maxStampSeconds.value) warnings.push(`one stamp takes ${time.toFixed(0)}s${where === "defaults" ? "" : ` at ${where}`}`);
  if (endsPrimed) warnings.push("the stamp ends un-retracted -- the next travel retracts 1.3mm for it, which may string on the way");
  if (Math.abs(primes - pulled) > 0.01 && steps.some((s) => s.op === "prime")) {
    warnings.push(`primes (${primes.toFixed(2)}mm) and retracts (${pulled.toFixed(2)}mm) do not balance -- each stamp shifts the filament by ${(primes - pulled).toFixed(2)}mm`);
  }
  if (!steps.some((s) => s.op === "prime")) warnings.push("no prime step -- the stamp starts with the filament retracted, so the first extrusion only refills the nozzle");
  if (eOut <= 0) warnings.push("the stamp extrudes nothing");

  return { errors, warnings, stats: { seconds: +time.toFixed(1), filamentMm: +eOut.toFixed(3), retracts, bbox } };
}

/** The whole gate. Returns { ok, errors, warnings, stats } where stats are
 * at the default params. `radiusMm` is checked against every corner. */
export function checkProgram(lib, program, { material = "TPU", options = {} } = {}) {
  const shape = validateProgramShape(program);
  if (shape.length) return { ok: false, errors: shape, warnings: [], stats: null };

  const errors = [], warnings = [];
  const seenW = new Set();
  let stats = null;
  const radius = Number(program.radiusMm ?? 10);
  for (const corner of paramCorners(program)) {
    const where = corner.label;
    let steps;
    try { steps = lib.expandSketchProgram(program, corner.label === "defaults" ? lib.resolveSketchParams(program, options) : corner.values); }
    catch (e) { errors.push(corner.label === "defaults" ? e.message : `${e.message} (at ${where})`); continue; }
    const a = analyzeStamp(lib, steps, { material, where });
    errors.push(...a.errors);
    // Warnings at the corners repeat the defaults' almost verbatim; keep
    // only ones whose text (minus the corner label) is new.
    for (const w of a.warnings) {
      const key = w.replace(/ at [^-]*?(?= --|$)/, "");
      if (!seenW.has(key)) { seenW.add(key); warnings.push(w); }
    }
    const b = a.stats.bbox;
    const reach = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
    if (reach > radius + 1e-6) errors.push(`the stamp reaches ${reach.toFixed(1)}mm from its origin${where === "defaults" ? "" : ` at ${where}`}, past its radiusMm ${radius} -- raise radiusMm or shrink the motion`);
    if (corner.label === "defaults") stats = a.stats;
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings, stats };
}

/** Retract cycles a test file will contain, for the TPU caution. */
export function retractBudgetWarning(totalRetracts) {
  return totalRetracts >= SKETCH_LIMITS.retractCyclesWarn.value
    ? `${totalRetracts} retraction cycles in this test file (soft cap ${SKETCH_LIMITS.retractCyclesWarn.value}) -- TPU can flat-spot at the drive gear; shorten the line or widen the gap`
    : null;
}
