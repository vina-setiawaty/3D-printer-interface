/**
 * generate.js -- turn one texture card (texture + option values +
 * placement + shared settings) into G-code lines for a live session.
 *
 * Unlike a standalone test print, there is no Emitter.header()/footer():
 * the printer is already homed and heated by the main controller. In
 * their place:
 *   prelude  G90 / M83 (texture functions are absolute XY, relative E)
 *            and M221 at the chosen flow %
 *   body     the texture function's own output, with zOffset added to
 *            every Z word (the library assumes Z0 is the print surface)
 *   ending   retract if still primed, lift by liftMm, M221 back to 100
 *
 * Pure: no DOM, `TF` is the imported texture_functions.js module.
 */

/** Add `offset` to every Z word. Every texture function writes absolute
 * Z (G90 throughout), so a plain shift is exact. */
export function offsetZ(line, offset) {
  if (!offset) return line;
  return line.replace(/\bZ(-?\d+(?:\.\d+)?)/g, (_, z) => `Z${(Number(z) + offset).toFixed(3)}`);
}

/** First line whose X or Y lies outside the bed, or null. */
export function findOutOfBounds(lines, bedX, bedY) {
  for (const line of lines) {
    const x = /\bX(-?\d+(?:\.\d+)?)/.exec(line);
    const y = /\bY(-?\d+(?:\.\d+)?)/.exec(line);
    if ((x && (Number(x[1]) < 0 || Number(x[1]) > bedX)) ||
        (y && (Number(y[1]) < 0 || Number(y[1]) > bedY))) return line;
  }
  return null;
}

// ------------------------------------------------------------------ paths --
// A card's "line" is one of three shapes, all from (x0, y0):
//   straight  to (x1, y1)
//   polyline  through the typed corners, to (x1, y1)
//   curve     preset: from (x0, y0) to (x1, y1), bowed sideways by `bend`
//             and/or wiggled by a sine wave (`waveHeight`, `waveLength`)
//             formula: x(t), y(t) for t from t0 to t1 (x0 / y0 usable in them)

/** Names a curve formula may use: t, x0, y0, and Math's functions / constants. */
const MATH_NAMES = ["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
  "sqrt", "cbrt", "abs", "exp", "log", "log2", "log10", "pow", "min", "max",
  "floor", "ceil", "round", "sign", "hypot", "PI", "E"];
const FORMULA_NAMES = new Set(["t", "x0", "y0", ...MATH_NAMES]);

/** A formula like "x0 + 20*cos(t)" -> (t) => number. Only numbers, the
 * names above, + - * / ^ ( ) and commas are accepted. */
export function compileFormula(expr, label, vars) {
  const text = String(expr ?? "").trim();
  if (!text) throw new Error(`${label} is empty`);
  if (/[^\w\s.+\-*/^(),]/.test(text)) {
    throw new Error(`${label}: use numbers, t, x0, y0, + - * / ^ ( ) and Math functions like sin, cos, sqrt`);
  }
  for (const name of text.match(/(?<![\w.])[A-Za-z_]\w*/g) ?? []) {
    if (!FORMULA_NAMES.has(name)) throw new Error(`${label}: unknown name "${name}"`);
  }
  let fn;
  try {
    fn = new Function("t", "x0", "y0", "M", `const { ${MATH_NAMES.join(", ")} } = M; return (${text.replace(/\^/g, "**")});`);
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
  return (t) => {
    const v = fn(t, vars.x0, vars.y0, Math);
    if (!Number.isFinite(v)) throw new Error(`${label} is not a number at t = ${t}`);
    return v;
  };
}

/** "90,105; 100,95" -> [[90, 105], [100, 95]]. */
export function parseCorners(text) {
  const pts = [];
  for (const part of String(text ?? "").split(";")) {
    if (!part.trim()) continue;
    const xy = part.split(",").map((v) => Number(v.trim()));
    if (xy.length !== 2 || !xy.every(Number.isFinite)) throw new Error(`corner "${part.trim()}" should be x,y`);
    pts.push(xy);
  }
  return pts;
}

/** The [x, y, s] point list a card's stroke walks, from its placement. */
export function buildPath(TF, placement) {
  const p = placement;
  const num = (k) => {
    const v = Number(p[k]);
    if (p[k] === "" || p[k] == null || !Number.isFinite(v)) throw new Error(`${k} is not a number`);
    return v;
  };
  const shape = p.shape ?? "straight";
  const x0 = num("x0"), y0 = num("y0");

  if (shape === "curve" && p.curveMode === "formula") {
    const fx = compileFormula(p.fx, "x(t)", { x0, y0 });
    const fy = compileFormula(p.fy, "y(t)", { x0, y0 });
    const t0 = num("t0"), t1 = num("t1");
    if (!(t1 > t0)) throw new Error("t to must be larger than t from");
    // ~0.1 per step, but never more than 20000 samples
    return TF.samplePath(fx, fy, t0, t1, { step: Math.max(Math.min(0.1, (t1 - t0) / 100), (t1 - t0) / 20000) });
  }

  const x1 = num("x1"), y1 = num("y1");
  if (shape === "polyline") {
    const pts = [[x0, y0], ...parseCorners(p.corners), [x1, y1]];
    if (pts.every((q) => Math.hypot(q[0] - x0, q[1] - y0) < 1e-6)) throw new Error("all the polyline's points are the same");
    return TF.polylineToPts(pts, 0.1);
  }
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (L < 1e-6) throw new Error("line start and end are the same point");
  if (shape === "curve") {
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;   // along the line
    const nx = -uy, ny = ux;                        // sideways (to the left)
    const bend = num("bend"), waveHeight = num("waveHeight"), waveLength = num("waveLength");
    if (waveHeight !== 0 && !(waveLength > 0)) throw new Error("wave length must be > 0");
    const off = (u) => bend * Math.sin((Math.PI * u) / L) +
      (waveHeight !== 0 ? waveHeight * Math.sin((2 * Math.PI * u) / waveLength) : 0);
    return TF.samplePath((u) => x0 + ux * u + nx * off(u), (u) => y0 + uy * u + ny * off(u), 0, L, { step: 0.1 });
  }
  return TF.polylineToPts([[x0, y0], [x1, y1]], 0.1);
}

/**
 * @param TF        the texture_functions.js module
 * @param texture   a TEXTURES entry from spec.js
 * @param values    {option: value} -- the full option set to pass
 * @param placement {shape, x0, y0, x1, y1, ...} -- the path the stroke walks (buildPath)
 * @param settings  {flowPercent, zOffset, liftMm, startZ}
 * @returns {lines, bodyLines, filamentMm}
 */
export function buildGcode(TF, texture, values, placement, settings) {
  const { flowPercent = 100, zOffset = 0, liftMm = 2, startZ = 10 } = settings;

  const em = new TF.Emitter();
  // Hop/travel heights are computed from em.z, so seed it with a
  // conservative "nozzle is at least this high" value -- the first goto()
  // then travels at startZ + Z_HOP before descending.
  em.z = startZ;
  em.retracted = true;
  em.newPattern();

  TF.BRUSHES[texture.fn](em, buildPath(TF, placement), values);
  em.retract();

  const bodyLines = em.lines.map((l) => offsetZ(l, zOffset));
  const lines = [
    "G90",
    "M83",
    `M221 S${Math.round(flowPercent)}`,
    ...bodyLines,
    "G91",
    `G1 Z${Number(liftMm).toFixed(3)} F3000`,
    "G90",
  ];
  if (Math.round(flowPercent) !== 100) lines.push("M221 S100");

  return { lines, bodyLines, filamentMm: em.eTotal };
}
