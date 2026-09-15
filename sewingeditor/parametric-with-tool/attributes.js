// Which parameters affect which tactile ATTRIBUTE.
//
// Pure data. Imported by parametric-catalog-with-tool.js (which expands it
// against a real scene) and by the tests (which check every row names a
// real option).
//
// This exists because the model should not be inventing the relationship
// between "denser" and a number. The page used to ask it to produce
// weighted knobs -- pick the options, pick the weights, pick the
// directions -- and then applied those weights as arithmetic on top of the
// values. That put an opaque, re-invented mapping between the user and
// their graphic, and it had to be re-derived every turn.
//
// Here the relationships are written down once, by hand, and the model's
// job shrinks to: which attribute did the user name, and which of the
// parameters that affect it are worth surfacing for THIS scene. No
// weights, no arithmetic, no hidden transform of anyone's numbers.
//
// An influence is matched by OPTION NAME against whatever brush, stamp or
// pattern the scene actually uses; a name that no texture in the scene has
// simply does not appear. `level` says where the option lives:
//
//   "brush"    an option of the brush or stamp in that slot
//   "pattern"  a fill pattern's own field (hatch gap, grid dx/dy, ...)
//   "graphic"  a property of the whole graphic (currently only `scale`)
//
// `direction` is +1 when raising the option raises the attribute, -1 when
// raising the option lowers it. `strength` orders the controls in the
// panel: "primary" first.

export const ATTRIBUTES = {
  density: {
    label: "density",
    aliases: ["denser", "sparser", "tighter", "looser", "closer", "packed", "spacing", "crowded"],
    description: "how closely packed the marks are",
    influences: [
      { level: "pattern", option: "gap", direction: -1, strength: "primary", note: "spacing between hatch rows" },
      { level: "pattern", option: "dx", direction: -1, strength: "primary", note: "grid column spacing" },
      { level: "pattern", option: "dy", direction: -1, strength: "primary", note: "grid row spacing" },
      { level: "pattern", option: "diag", direction: -1, strength: "primary", note: "diamond cell size" },
      { level: "brush", option: "gap", direction: -1, strength: "primary", note: "distance between dots along the path" },
      { level: "brush", option: "spacing", direction: -1, strength: "primary", note: "distance between hair strands" },
      { level: "brush", option: "gapLen", direction: -1, strength: "secondary", note: "gap between dashes" },
      { level: "brush", option: "wavelength", direction: -1, strength: "secondary", note: "distance between swells" },
      { level: "graphic", option: "scale", direction: -1, strength: "secondary", note: "pattern spacing scales with the graphic, so a smaller graphic reads as denser; brush millimetres do not scale" },
    ],
    cautions: ["a dot gap below its diameter + 1 mm fuses the dots into a ridge", "a hatch gap below 0.35 mm with a solid brush is severe over-extrusion"],
  },

  boldness: {
    label: "boldness",
    aliases: ["bolder", "heavier", "thicker", "fatter", "stronger", "chunkier", "finer", "thinner"],
    description: "how wide and heavy each mark is",
    influences: [
      { level: "brush", option: "width", direction: 1, strength: "primary", note: "bead width of the ridge" },
      { level: "brush", option: "beadWidth", direction: 1, strength: "primary", note: "bead width of the ridge" },
      { level: "brush", option: "diameter", direction: 1, strength: "primary", note: "dome diameter" },
      { level: "brush", option: "rootDiameter", direction: 1, strength: "primary", note: "diameter of the dome under each hair" },
      { level: "brush", option: "dotRadius", direction: 1, strength: "primary", note: "radius of each flat disc" },
      { level: "brush", option: "fatWidth", direction: 1, strength: "secondary", note: "width of the fat segments" },
      { level: "brush", option: "thinWidth", direction: 1, strength: "secondary", note: "width of the thin segments" },
      { level: "brush", option: "segLen", direction: 1, strength: "secondary", note: "longer dashes read as a heavier line" },
    ],
    cautions: ["a bead below 0.4 mm is thinner than one nozzle width", "widening a dot without widening its gap makes neighbours fuse"],
  },

  relief: {
    label: "relief",
    aliases: ["taller", "higher", "raised", "prominent", "flatter", "lower", "height"],
    description: "how far the texture stands up off the sheet — what the fingertip catches first",
    influences: [
      { level: "brush", option: "nLayers", direction: 1, strength: "primary", note: "stacked 0.2 mm layers" },
      { level: "brush", option: "height", direction: 1, strength: "primary", note: "disc height" },
      { level: "brush", option: "hMax", direction: 1, strength: "primary", note: "tallest point of a swelling ridge" },
      { level: "brush", option: "hMin", direction: 1, strength: "secondary", note: "lowest point of a swelling ridge" },
      { level: "brush", option: "extrusionMultiplier", direction: 1, strength: "secondary", note: "dome volume; more filament makes a taller dome" },
      { level: "brush", option: "fatHeight", direction: 1, strength: "secondary", note: "height of the fat segments" },
    ],
    cautions: ["relief below 0.4 mm (2 layers) cannot reliably be felt"],
  },

  hairiness: {
    label: "hairiness",
    aliases: ["hairier", "furry", "fuzzy", "strands", "bristly", "smoother"],
    description: "how long and how frequent the pulled strands are",
    influences: [
      { level: "brush", option: "hairLength", direction: 1, strength: "primary", note: "length of each pulled strand" },
      { level: "brush", option: "bigLift", direction: 1, strength: "primary", note: "how far the nozzle pulls up, so how long the strand is" },
      { level: "brush", option: "spacing", direction: -1, strength: "primary", note: "closer strands read as hairier" },
      { level: "brush", option: "gap", direction: -1, strength: "primary", note: "closer hairy dots read as hairier" },
      { level: "brush", option: "esegmentMm", direction: 1, strength: "secondary", note: "filament per strand, so strand thickness" },
      { level: "brush", option: "beadFlowMult", direction: 1, strength: "secondary", note: "flow while pulling, so strand thickness" },
      { level: "brush", option: "hairThickness", direction: 1, strength: "secondary", note: "explicit strand thickness" },
    ],
    cautions: ["every strand costs one retraction, and TPU flat-spots past roughly 250 of them in a job", "strands closer than 2.5 mm fuse together"],
  },

  direction: {
    label: "direction",
    aliases: ["angle", "orientation", "rotate", "lean", "rake", "tilt", "which way"],
    description: "which way the texture runs or leans",
    influences: [
      { level: "pattern", option: "angleDeg", direction: 1, strength: "primary", note: "rotation of the hatch or grid" },
      { level: "brush", option: "azimuthDeg", direction: 1, strength: "primary", note: "which way a leaning dome rakes" },
      { level: "brush", option: "hairAzimuthDeg", direction: 1, strength: "primary", note: "which way the hair is pulled" },
      { level: "brush", option: "hairElevationDeg", direction: 1, strength: "secondary", note: "0 lays the hair flat, 90 stands it up" },
      { level: "brush", option: "hairDirection", direction: 1, strength: "secondary", note: "the same, as a named direction" },
    ],
    cautions: ["two regions whose hatches run at the same angle are hard to tell apart by touch"],
  },

  size: {
    label: "size",
    aliases: ["bigger", "smaller", "scale", "larger", "shrink", "grow"],
    description: "how large the whole graphic prints",
    influences: [
      { level: "graphic", option: "scale", direction: 1, strength: "primary", note: "scales the whole graphic, and pattern spacing with it, about its origin corner" },
    ],
    cautions: ["the graphic must still fit inside the safe area once scaled", "brush millimetres do not scale, so a much smaller graphic keeps full-size dots"],
  },
};

/** Attribute keys, plus the escape hatch for a quality the table does not
 * name. A `custom` group may surface any option, with a reason. */
export const ATTRIBUTE_KEYS = Object.keys(ATTRIBUTES);
export const CUSTOM_ATTRIBUTE = "custom";

/** Every influence for an attribute, or [] for an unknown one. */
export function influencesOf(attribute) {
  return ATTRIBUTES[attribute]?.influences || [];
}

/** True if `option` at `level` is one the table says affects `attribute`. */
export function influenceFor(attribute, level, option) {
  return influencesOf(attribute).find((i) => i.level === level && i.option === option) || null;
}
