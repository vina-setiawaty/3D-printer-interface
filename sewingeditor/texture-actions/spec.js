/**
 * spec.js -- how each option is shown on a card (step, min/max, unit, or a
 * list of choices). Holds NO textures and NO default values: the textures
 * are the BRUSHES entries of texture_functions.js and their options and
 * defaults are read from each one's stroke and brush signatures (see
 * signature.js listTextures / parseAllDefaults), so a texture added by the
 * function editor gets a card with nothing to add here. An option missing
 * from PARAMS still works, as a plain number input.
 */

/** How each option name is displayed. Names mean the same thing across
 * functions, so one table covers them all. Speeds are G-code F values
 * (mm/min). `options` makes a select. A `null` default always renders as
 * an optional number whose empty value means "auto" (passes null). */
export const PARAMS = {
  // geometry / bead
  width: { step: 0.05, min: 0.1, unit: "mm" },
  nLayers: { step: 1, min: 1, unit: "layers" },
  segLen: { step: 0.5, min: 0.1, unit: "mm" },
  gapLen: { step: 0.5, min: 0, unit: "mm" },
  gap: { step: 0.5, min: 0.1, unit: "mm" },
  spacing: { step: 0.5, min: 0.1, unit: "mm" },
  dotRadius: { step: 0.1, min: 0.1, unit: "mm" },
  diameter: { step: 0.1, min: 0.1, unit: "mm" },
  rootDiameter: { step: 0.1, min: 0.1, unit: "mm" },
  baseZ: { step: 0.05, min: 0, unit: "mm" },
  buildSteps: { step: 1, min: 1, unit: "steps" },
  taperFactor: { step: 0.05, min: 0, max: 1, unit: "x" },
  extrusionMultiplier: { step: 0.05, min: 0, unit: "x" },
  baseExtraMm: { step: 0.05, min: 0, unit: "mm E" },
  azimuthDeg: { step: 5, unit: "deg" },
  step: { step: 0.05, min: 0.01, unit: "mm" },
  brushOrder: { options: ["auto", "forward", "reverse"] },

  // speeds (F, mm/min)
  speed: { step: 10, min: 1, unit: "F" },
  extrudeSpeed: { step: 10, min: 1, unit: "F" },
  orbitSpeed: { step: 50, min: 1, unit: "F" },
  dragSpeed: { step: 50, min: 1, unit: "F" },
  pullExtrudeSpeed: { step: 10, min: 1, unit: "F" },
  hairSpeed: { step: 100, min: 1, unit: "F" },
  clearanceSpeed: { step: 50, min: 1, unit: "F" },
  overtravelSpeed: { step: 50, min: 1, unit: "F" },
  retractSpeed: { step: 50, min: 1, unit: "F" },
  thinSpeed: { step: 10, min: 1, unit: "F" },
  fatSpeed: { step: 10, min: 1, unit: "F" },

  // timing
  dwellMs: { step: 100, min: 0, unit: "ms" },
  postRetractDwellMs: { step: 100, min: 0, unit: "ms" },
  baseDwellMs: { step: 100, min: 0, unit: "ms" },
  orbitDwellMs: { step: 100, min: 0, unit: "ms" },
  segDwellMs: { step: 50, min: 0, unit: "ms" },
  peakDwellMs: { step: 50, min: 0, unit: "ms" },
  primedwellS: { step: 0.1, min: 0, unit: "s" },

  // retraction / anti-stringing
  retractMm: { step: 0.1, min: 0, unit: "mm E" },
  orbitRadius: { step: 0.1, min: 0, unit: "mm" },
  orbitPts: { step: 1, min: 3, unit: "pts" },
  orbitLoops: { step: 1, min: 0, unit: "loops" },
  topOrbitLoops: { step: 1, min: 0, unit: "loops" },
  blobClearanceMm: { step: 0.05, min: 0, unit: "mm" },

  // hairy
  esegmentMm: { step: 0.1, min: 0, unit: "mm E" },
  smallLift: { step: 0.05, min: 0, unit: "mm" },
  bigLift: { step: 0.5, min: 0, unit: "mm" },
  hairThickness: { step: 0.1, min: 0.1, unit: "mm" },
  hairLength: { step: 0.5, min: 0, unit: "mm" },
  beadFlowMult: { step: 0.1, min: 0, unit: "x" },
  dryRiseFeedDrop: { step: 1, min: 1, unit: "x" },
  hairDirection: { options: ["top", "left", "right", "bottom"] },
  hairAzimuthDeg: { step: 5, unit: "deg" },
  hairElevationDeg: { step: 5, min: -90, max: 90, unit: "deg" },
  stringMm: { step: 0.5, min: 0, unit: "mm" },
  clearanceZ: { step: 0.1, min: 0, unit: "mm" },
  overtravelMm: { step: 0.5, min: 0, unit: "mm" },

  // segmented
  thinLen: { step: 0.5, min: 0.1, unit: "mm" },
  thinWidth: { step: 0.05, min: 0.1, unit: "mm" },
  thinHeight: { step: 0.05, min: 0.05, unit: "mm" },
  fatLen: { step: 0.5, min: 0.1, unit: "mm" },
  fatWidth: { step: 0.05, min: 0.1, unit: "mm" },
  fatHeight: { step: 0.05, min: 0.05, unit: "mm" },
  flowMult: { step: 0.05, min: 0, unit: "x" },
  eprime: { step: 0.1, min: 0, unit: "mm E" },

  // variable thickness
  hMin: { step: 0.02, min: 0.05, unit: "mm" },
  hMax: { step: 0.05, min: 0.05, unit: "mm" },
  wavelength: { step: 0.5, min: 0.5, unit: "mm" },
  beadWidth: { step: 0.05, min: 0.1, unit: "mm" },
  volRate: { step: 0.5, min: 0.1, unit: "mm³/s" },
  stepsPerWave: { step: 1, min: 1, unit: "steps" },
  phase: { step: 0.25, unit: "waves" },
  peak: { step: 0.05, min: 0, max: 1, unit: "of wave" },
};
