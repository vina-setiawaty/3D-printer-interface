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

/**
 * @param TF        the texture_functions.js module
 * @param texture   a TEXTURES entry from spec.js
 * @param values    {option: value} -- the full option set to pass
 * @param placement brush: {x0, y0, x1, y1}; stamp: {x, y}
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

  if (texture.kind === "brush") {
    const { x0, y0, x1, y1 } = placement;
    if (Math.hypot(x1 - x0, y1 - y0) < 1e-6) throw new Error("line start and end are the same point");
    const pts = TF.polylineToPts([[x0, y0], [x1, y1]], 0.1);
    TF.BRUSHES[texture.fn](em, pts, values);
  } else {
    TF.STAMPS[texture.fn](em, placement.x, placement.y, values);
  }
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
