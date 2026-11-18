// G-code labels: before a stroke or brush call, a comment naming the function
// and every setting it runs with (its defaults filled in), in the style of
// the per-level lines in claude_3d/garden.gcode, e.g.
//   ; brushPetalDot  diameter 3.2 height 0.7 dragMm 0.8 azimuthDeg 0 extrudeSpeed 150 dragSpeed 600
// A brush label is skipped when it would repeat the comment just above it, so
// a run of identical marks gets one label; a stroke is always labelled.
// Only comment lines are added: the moves are unchanged.
// (Same file in claude_3d, claude_petal and claude_variableThickness scripts/.)

// Defaults copied from sewingeditor/texture-actions/texture_functions.js.
const BRUSH_PETAL_DOT = { diameter: 3.0, height: 1.0, dragMm: 5.0, azimuthDeg: 270, extrudeSpeed: 150, dragSpeed: 600 };
const DEFAULTS = {
  brushPetalDot: BRUSH_PETAL_DOT,
  brushVariableThickness: { hMin: 0.24, hMax: 0.9, wavelength: 8.0, beadWidth: 0.8, volRate: 4.0, stepsPerWave: 25, phase: 0, peak: 0.5, gapLen: 0 },
  // azimuthDeg here is relative to the path direction; gap is between dots
  strokePetalDotted: { gap: 6.0, ...BRUSH_PETAL_DOT, azimuthDeg: 180 },
};

const fmt = (v) => (typeof v === "number" ? String(+v.toFixed(3)) : String(v));

function lastComment(em) {
  for (let i = em.lines.length - 1; i >= 0; i--) if (em.lines[i].startsWith(";")) return em.lines[i];
  return null;
}

/** `fn` wrapped so that each call first writes its label to em (the first
 * argument). The options object is the last argument. */
export function labelled(name, fn, { stroke = name.startsWith("stroke") } = {}) {
  return (...args) => {
    const em = args[0], opt = args[args.length - 1] ?? {};
    const vals = { ...DEFAULTS[name], ...opt };
    const text = `; ${name}  ` + Object.entries(vals)
      .filter(([, v]) => ["number", "string", "boolean"].includes(typeof v))
      .map(([k, v]) => `${k} ${fmt(v)}`).join(" ");
    if (stroke || lastComment(em) !== text) em.a(text);
    return fn(...args);
  };
}
