/**
 * spec.js -- which texture functions get a card, and how each option is
 * shown. Holds NO default values: those are read from the signatures in
 * texture_functions.js (see signature.js), so "save as default" only ever
 * has one place to write.
 *
 *   fn      key in BRUSHES -- the texture's stroke, what gets called
 *   sigs    [stroke, brush]: the functions whose options objects hold the
 *           defaults. The stroke has the walk options (gap, spacing,
 *           layers, order, priming), the brush the mark's own; a card
 *           shows both, and "save as default" writes each back where it
 *           came from
 *   basic   options shown on the card; every other option goes under
 *           "advanced"
 *   initial values for options that have no default in the signature
 *
 * Every option of every `sigs` function must have an entry in PARAMS
 * (tests/run.mjs checks this).
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
  liftSpeed: { step: 50, min: 1, unit: "F" },
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
  liftDwellMs: { step: 100, min: 0, unit: "ms" },
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
  liftZ: { step: 0.5, min: 0, unit: "mm" },

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
};

export const TEXTURES = [
  {
    name: "solid", fn: "solid", sigs: ["strokeSolid", "brushSolid"],
    description: "Continuous solid ridge along the line, nLayers high.",
    basic: ["width", "nLayers", "speed"],
  },
  {
    name: "dashed", fn: "dashed", sigs: ["strokeDashed", "brushDashed"],
    description: "Dashes of segLen separated by gapLen of travel, measured along the line.",
    basic: ["segLen", "gapLen", "width", "nLayers", "speed"],
    initial: { segLen: 8, gapLen: 4 },
  },
  {
    name: "dotted", fn: "dotted", sigs: ["strokeDotted", "brushSpiralDot"],
    description: "Flat spiral-filled dots every gap mm along the line.",
    basic: ["gap", "dotRadius", "nLayers", "speed"],
  },
  {
    name: "blobDotted", fn: "blobDotted", sigs: ["strokeBlobDotted", "brushBlobDot"],
    description: "Blob domes every gap mm along the line (the default dotted texture).",
    basic: ["gap", "diameter", "baseZ", "extrusionMultiplier", "dwellMs"],
  },
  {
    name: "directionalBlobDotted", fn: "directionalBlobDotted",
    sigs: ["strokeDirectionalBlobDotted", "brushDirectionalBlobDot"],
    description: "Leaning blobs along the line; azimuthDeg offsets the lean from the line direction. Empty gap = one diameter.",
    basic: ["gap", "diameter", "azimuthDeg", "brushOrder", "extrusionMultiplier"],
  },
  {
    name: "hairy", fn: "hairy", sigs: ["strokeHairy", "brushHairyStrand"],
    description: "Vertical-lift strands every spacing mm, travelling lifted between strands instead of retracting.",
    basic: ["spacing", "esegmentMm", "bigLift", "baseZ", "speed"],
  },
  {
    name: "hairyDotted", fn: "hairyDotted", sigs: ["strokeHairyDotted", "brushHairyDot"],
    description: "A root dome with one pulled hair every gap mm. Empty hairThickness = derived from hairLength.",
    basic: ["gap", "rootDiameter", "hairLength", "hairThickness", "hairDirection", "brushOrder"],
  },
  {
    name: "segmented", fn: "segmented", sigs: ["strokeSegmented", "brushSegmented"],
    description: "Continuous single-layer line alternating thin and fat sections.",
    basic: ["thinLen", "thinWidth", "fatLen", "fatWidth", "flowMult"],
  },
  {
    name: "variableThickness", fn: "variableThickness",
    sigs: ["strokeVariableThickness", "brushVariableThickness"],
    description: "Bead height sweeps between hMin and hMax, one wave every wavelength mm, at constant volumetric flow (speed follows thickness).",
    basic: ["hMin", "hMax", "wavelength", "beadWidth", "volRate"],
  },
];
