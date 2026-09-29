/**
 * sketched_brushes.js -- textures that started as a DRAWING of the nozzle's
 * motion (the brush-sketch page, sewingeditor/brush-sketch/), kept separate
 * from the hand-tuned library in texture_functions.js.
 *
 * texture_functions.js re-exports everything here (`export * from
 * "./sketched_brushes.js"`), so a generation script that imports
 * texture_functions.js gets the sketched brushes too, and this file in turn
 * imports the Emitter's path engine from texture_functions.js. That is a
 * CIRCULAR import, and it is only safe under one rule:
 *
 *   NOTHING AT THE TOP LEVEL OF THIS FILE MAY READ AN IMPORTED BINDING.
 *
 * Whichever file is imported first, this one finishes evaluating before
 * texture_functions.js does, so an imported constant read at top level
 * (e.g. `const R = RETRACT_MM`) throws a TDZ ReferenceError. Imported names
 * may only be used inside function bodies, which run later. Programs are
 * therefore plain JSON literals, and the generated blocks below only
 * declare consts of literals and functions. brush-sketch/tests check this.
 *
 * A sketched brush is a BRUSH PROGRAM: a list of low-level nozzle steps in
 * a LOCAL frame around one stamp point (origin = the stamp point, z =
 * height above the bed, mm, mm/min, ms). Every number may be an expression
 * over the brush's named params. ONE interpreter below turns a program into
 * G-code -- the brush-sketch page runs exactly this code for its previews
 * and test prints, and the promoted functions at the bottom call it too, so
 * what was tested is what the library emits.
 *
 * Ops (see brush-sketch/docs/ref-brush-program.md for the full reference):
 *   travel      {to}                       hop + travel to the start (em.goto); first step only
 *   move        {to|by, f, e | bead{w,h}}  straight XYZ move, extruding if e/bead is given
 *   dwell       {ms}                       G4
 *   retract     {mm, f?}                   negative E, stationary
 *   prime       {mm, f?}                   positive E, stationary (un-retract)
 *   extrudeHere {e, ms}                    deliberate stationary extrusion (a puddle)
 *   repeat      {n, steps}                 loop; `i` (0..n-1) and `n` usable in expressions
 *
 * Built-in options every sketched brush accepts on top of its own params:
 *   azimuthDeg  rotates the local frame, degrees CCW. On a line with
 *               orientation "tangent" it is an OFFSET from the path's
 *               local direction (like freeformDirectionalBlobDotted).
 *   gap         arc-length spacing of stamps along a line (freeform form).
 *   reverse     stamp the line end-to-start.
 *
 * Do NOT hand-edit a generated block. Edit the program (the JSON in
 * sketch_brushes/<name>/vN.program.json, or in the page) and promote it
 * again -- the page replaces only the code between that brush's markers.
 */

import {
  samplePath, pointAtArcLength, totalLength, eRate, RETRACT_SPEED, LINE_START_PRIME_MM,
} from "./texture_functions.js";

/* ==========================================================================
 * SECTION A: RUNTIME (hand-written; shared by every sketched brush)
 * ========================================================================== */

// ------------------------------------------------------------- expressions --
//
// The same closed grammar as parametric-with-tool's compileExpr(): numbers,
// + - * / ^, parentheses, the functions below, `pi`, and the brush's
// variables. Parsed into an AST and evaluated by a switch -- never eval()
// or new Function(), so a model-written program can't reach any JS object.

const FN1 = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log, floor: Math.floor, round: Math.round };
const FN2 = { min: Math.min, max: Math.max, pow: Math.pow };

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (!/^\d*\.?\d+$|^\d+\.$/.test(text)) throw new Error(`bad number "${text}" in expression`);
      toks.push({ type: "num", value: parseFloat(text) });
      i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      toks.push({ type: "ident", value: src.slice(i, j) });
      i = j; continue;
    }
    if ("+-*/^(),".includes(c)) { toks.push({ type: c }); i++; continue; }
    throw new Error(`unexpected character "${c}" in expression`);
  }
  toks.push({ type: "eof" });
  return toks;
}

function parse(toks, vars) {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (type) => { if (peek().type !== type) throw new Error(`expected "${type}", got "${peek().type}"`); return next(); };
  function expr() {
    let node = term();
    while (peek().type === "+" || peek().type === "-") { const op = next().type; node = { t: "bin", op, a: node, b: term() }; }
    return node;
  }
  function term() {
    let node = unary();
    while (peek().type === "*" || peek().type === "/") { const op = next().type; node = { t: "bin", op, a: node, b: unary() }; }
    return node;
  }
  function unary() {
    if (peek().type === "-") { next(); return { t: "neg", a: unary() }; }
    return power();
  }
  function power() {
    const base = atom();
    if (peek().type === "^") { next(); return { t: "bin", op: "^", a: base, b: unary() }; }
    return base;
  }
  function atom() {
    const tok = peek();
    if (tok.type === "num") { next(); return { t: "num", v: tok.value }; }
    if (tok.type === "(") { next(); const n = expr(); expect(")"); return n; }
    if (tok.type === "ident") {
      next();
      const name = tok.value;
      if (peek().type === "(") {
        next();
        const args = [expr()];
        while (peek().type === ",") { next(); args.push(expr()); }
        expect(")");
        if (name in FN1) { if (args.length !== 1) throw new Error(`${name}() takes 1 argument`); return { t: "f1", f: name, a: args[0] }; }
        if (name in FN2) { if (args.length !== 2) throw new Error(`${name}() takes 2 arguments`); return { t: "f2", f: name, a: args[0], b: args[1] }; }
        throw new Error(`unknown function "${name}" (allowed: ${[...Object.keys(FN1), ...Object.keys(FN2)].join(", ")})`);
      }
      if (name === "pi") return { t: "num", v: Math.PI };
      if (!vars.includes(name)) throw new Error(`unknown name "${name}" (defined here: ${vars.join(", ") || "none"}, pi)`);
      return { t: "var", name };
    }
    throw new Error(`unexpected "${tok.type}" in expression`);
  }
  const root = expr();
  expect("eof");
  return root;
}

function evalNode(n, env) {
  switch (n.t) {
    case "num": return n.v;
    case "var": return env[n.name];
    case "neg": return -evalNode(n.a, env);
    case "f1": return FN1[n.f](evalNode(n.a, env));
    case "f2": return FN2[n.f](evalNode(n.a, env), evalNode(n.b, env));
    case "bin": {
      const a = evalNode(n.a, env), b = evalNode(n.b, env);
      if (n.op === "+") return a + b;
      if (n.op === "-") return a - b;
      if (n.op === "*") return a * b;
      if (n.op === "/") return a / b;
      return Math.pow(a, b);
    }
  }
  throw new Error(`bad expression node "${n.t}"`);
}

/** A number, or a string expression over `vars`, evaluated in `env`.
 * Throws on a syntax error, an unknown name, or a non-finite result. */
export function evalSketchValue(v, env, what = "value") {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${what}: not a finite number`);
    return v;
  }
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what}: expected a number or an expression string`);
  let out;
  try { out = evalNode(parse(tokenize(v), Object.keys(env)), env); }
  catch (e) { throw new Error(`${what}: ${e.message} in "${v}"`); }
  if (!Number.isFinite(out)) throw new Error(`${what}: "${v}" evaluates to ${out}`);
  return out;
}

// ----------------------------------------------------------------- params --

/** Program defaults overlaid with the caller's options. Unknown option
 * names are ignored here (the page's gate reports them); the three
 * built-ins (azimuthDeg, gap, reverse) are handled by the stampers. */
export function resolveSketchParams(program, options = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(program.params || {})) {
    const v = options[name];
    out[name] = v === undefined || v === null || v === "" ? spec.def : Number(v);
    if (!Number.isFinite(out[name])) throw new Error(`param "${name}": not a number (${v})`);
  }
  return out;
}

// ----------------------------------------------------------------- expand --

const MOVE_OPS = new Set(["travel", "move"]);
export const SKETCH_OPS = ["travel", "move", "dwell", "retract", "prime", "extrudeHere", "repeat"];

/** Program + params -> a flat list of CONCRETE steps in the local frame:
 *   {op:"travel", to:[x,y,z]}
 *   {op:"move", from:[x,y,z], to:[x,y,z], e, f}   (e = 0 for a dry move)
 *   {op:"dwell", ms} / {op:"retract"|"prime", mm, f} / {op:"extrudeHere", e, ms, at}
 * Each carries `src`: the path of top-level/nested step indices it came
 * from (e.g. [4] or [2, 0, 1] = step 2 -> repeat iteration 0 -> sub-step 1),
 * so the page can point at the step a problem came from.
 * `bead: {w, h}` becomes e = eRate(w, h) * (3D length of the move). */
export function expandSketchProgram(program, params) {
  const out = [];
  let pos = null;   // local [x, y, z]; null until the travel
  const walk = (steps, env, path) => {
    if (!Array.isArray(steps)) throw new Error(`${path.length ? `step ${path.join(".")}` : "program"}: "steps" must be a list`);
    steps.forEach((st, k) => {
      const here = [...path, k];
      const what = `step ${here.map((x) => x + 1).join(".")} (${st && st.op})`;
      const num = (v, field) => evalSketchValue(v, env, `${what} ${field}`);
      if (!st || typeof st !== "object") throw new Error(`${what}: not an object`);
      if (!SKETCH_OPS.includes(st.op)) throw new Error(`${what}: unknown op "${st.op}" (${SKETCH_OPS.join(", ")})`);

      if (MOVE_OPS.has(st.op)) {
        let to;
        if (Array.isArray(st.to)) {
          if (st.to.length !== 3) throw new Error(`${what}: "to" is [x, y, z]`);
          to = st.to.map((v, a) => num(v, `to[${"xyz"[a]}]`));
        } else if (Array.isArray(st.by) && st.op === "move") {
          if (st.by.length !== 3) throw new Error(`${what}: "by" is [dx, dy, dz]`);
          if (!pos) throw new Error(`${what}: "by" needs a position -- the program must start with a travel`);
          to = st.by.map((v, a) => pos[a] + num(v, `by[${"xyz"[a]}]`));
        } else {
          throw new Error(`${what}: needs "to": [x, y, z]${st.op === "move" ? ' or "by": [dx, dy, dz]' : ""}`);
        }
        if (st.op === "travel") {
          if (out.length) throw new Error(`${what}: travel is only allowed as the very first step`);
          out.push({ op: "travel", to, src: here });
        } else {
          if (!pos) throw new Error(`${what}: the program must start with a travel`);
          const f = num(st.f, "f");
          if (!(f > 0)) throw new Error(`${what}: f must be > 0`);
          let e = 0;
          if (st.e !== undefined && st.e !== null && st.e !== "") e = num(st.e, "e");
          else if (st.bead) {
            const w = num(st.bead.w, "bead.w"), h = num(st.bead.h, "bead.h");
            const len = Math.hypot(to[0] - pos[0], to[1] - pos[1], to[2] - pos[2]);
            e = eRate(w, h) * len;
          }
          if (e < 0) throw new Error(`${what}: e must be >= 0 (use a retract step to pull filament back)`);
          out.push({ op: "move", from: pos, to, e, f, src: here });
        }
        pos = to;
        return;
      }
      if (!pos && st.op !== "repeat") throw new Error(`${what}: the program must start with a travel`);
      if (st.op === "dwell") { const ms = num(st.ms, "ms"); if (ms < 0) throw new Error(`${what}: ms must be >= 0`); out.push({ op: "dwell", ms, src: here }); return; }
      if (st.op === "retract" || st.op === "prime") {
        const mm = num(st.mm, "mm");
        if (mm < 0) throw new Error(`${what}: mm must be >= 0`);
        const f = st.f === undefined || st.f === null || st.f === "" ? null : num(st.f, "f");
        out.push({ op: st.op, mm, f, src: here });
        return;
      }
      if (st.op === "extrudeHere") {
        const e = num(st.e, "e"), ms = num(st.ms, "ms");
        if (e < 0 || !(ms > 0)) throw new Error(`${what}: needs e >= 0 and ms > 0`);
        out.push({ op: "extrudeHere", e, ms, at: pos, src: here });
        return;
      }
      // repeat
      const n = Math.round(num(st.n, "n"));
      if (n < 0 || n > 500) throw new Error(`${what}: n must be 0..500`);
      for (let i = 0; i < n; i++) walk(st.steps, { ...env, i, n }, [...here, i]);
    });
  };
  if (!program || typeof program !== "object") throw new Error("program must be an object");
  walk(program.steps, { ...params, i: 0, n: 1 }, []);
  if (!out.length || out[0].op !== "travel") throw new Error("the program must start with a travel step");
  return out;
}

// ------------------------------------------------------------------- emit --

const f3 = (v) => v.toFixed(3);

/** Local frame -> bed: rotate xy by `deg`, then translate to (cx, cy). */
function placer(cx, cy, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return ([x, y, z]) => [cx + x * c - y * s, cy + x * s + y * c, z];
}

/** Emits ONE stamp of `program` at (cx, cy), local frame rotated by
 * `headingDeg`. Does not call em.newPattern() (the caller does, once per
 * top-level element). Returns the expanded steps (bed space). */
export function emitSketchStamp(em, program, cx, cy, headingDeg, params) {
  const steps = expandSketchProgram(program, params);
  const P = placer(cx, cy, headingDeg);
  const out = [];
  for (const st of steps) {
    if (st.op === "travel") {
      const [x, y, z] = P(st.to);
      em.goto(x, y, z);
      out.push({ ...st, to: [x, y, z] });
    } else if (st.op === "move") {
      const [x, y, z] = P(st.to);
      const ePart = st.e > 0 ? ` E${st.e.toFixed(4)}` : "";
      em.a(`G1 X${f3(x)} Y${f3(y)} Z${f3(z)}${ePart} F${Math.round(st.f)}`);
      em.eTotal += st.e;
      em.x = x; em.y = y; em.z = z;
      out.push({ ...st, from: P(st.from), to: [x, y, z] });
    } else if (st.op === "dwell") {
      em.dwell(st.ms);
      out.push(st);
    } else if (st.op === "retract") {
      em.a(`G1 E${(-st.mm).toFixed(4)} F${Math.round(st.f ?? RETRACT_SPEED)}`);
      em.eTotal -= st.mm;
      em.retracted = true;
      out.push(st);
    } else if (st.op === "prime") {
      // Same one-time start bonus Emitter.unretract() applies to the first
      // un-retract of each top-level element.
      const bonus = em.pendingPrimeBonus ? LINE_START_PRIME_MM : 0;
      em.pendingPrimeBonus = false;
      const mm = st.mm + bonus;
      em.a(`G1 E${mm.toFixed(4)} F${Math.round(st.f ?? RETRACT_SPEED)}`);
      em.eTotal += mm;
      em.retracted = false;
      out.push({ ...st, mm });
    } else if (st.op === "extrudeHere") {
      const feed = st.e / (st.ms / 60000);
      em.a(`G1 E${st.e.toFixed(4)} F${Math.max(1, Math.round(feed))}`);
      em.eTotal += st.e;
      out.push({ ...st, at: P(st.at) });
    }
  }
  return out;
}

function builtins(options) {
  return {
    azimuthDeg: Number(options.azimuthDeg ?? 0) || 0,
    gap: options.gap === undefined || options.gap === null || options.gap === "" ? null : Number(options.gap),
    reverse: options.reverse === true || options.reverse === "true",
  };
}

/** One stamp as a standalone printed element (calls em.newPattern(), like
 * blobDot()). */
export function stampSketch(em, program, cx, cy, options = {}) {
  const params = resolveSketchParams(program, options);
  em.newPattern();
  return emitSketchStamp(em, program, cx, cy, builtins(options).azimuthDeg, params);
}

/** Stamps along an arc-length-tagged point list (samplePath() output) --
 * the parametric-with-tool brush shape (em, pts, options). Does NOT call
 * em.newPattern(). */
export function brushSketchDotted(em, program, pts, options = {}) {
  const params = resolveSketchParams(program, options);
  const b = builtins(options);
  const gap = b.gap ?? Number(program.defaultGap ?? 10);
  if (!(gap > 0)) throw new Error(`gap must be > 0 (got ${gap})`);
  const length = totalLength(pts);
  const stops = [];
  for (let s = 0; s <= length + 1e-6; s += gap) stops.push(s);
  if (b.reverse) stops.reverse();
  const tanH = Math.max(0.05, Math.min(gap * 0.5, 1.0));
  for (const s of stops) {
    const [cx, cy] = pointAtArcLength(pts, s);
    let heading = b.azimuthDeg;
    if (program.orientation === "tangent" && length > 0) {
      const a = pointAtArcLength(pts, Math.max(0, s - tanH));
      const c = pointAtArcLength(pts, Math.min(length, s + tanH));
      heading += (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI;
    }
    emitSketchStamp(em, program, cx, cy, heading, params);
  }
  return pts;
}

/** Stamps along any parametric path -- the texture_functions.js line-style
 * signature (em, xFunc, yFunc, tStart, tEnd, options), so a sketched brush
 * works as a fill() style too. Calls em.newPattern() once. */
export function freeformSketchDotted(em, program, xFunc, yFunc, tStart, tEnd, options = {}) {
  const pts = samplePath(xFunc, yFunc, tStart, tEnd, { step: options.step ?? 0.1 });
  em.newPattern();
  return brushSketchDotted(em, program, pts, options);
}

/** Every promoted brush registers itself here: name -> {program, stamp,
 * freeform, brush}. Declared before the generated section on purpose (the
 * blocks assign into it at load time). */
export const SKETCH_BRUSHES = {};

/* ==========================================================================
 * SECTION B: PROMOTED BRUSHES (GENERATED by brush-sketch -- do not hand-edit)
 * ========================================================================== */

// <sketch-brushes>
// </sketch-brushes>
