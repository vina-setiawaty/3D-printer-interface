# What the hardware has taught this project

A short summary of `texture_docs/troubleshooting.md` (the full record is
~110 KB). Every entry says what happened on real prints and cites the
section it came from. Machine: Ender 3 V2, Creality Sprite direct drive,
0.4 mm nozzle.
- **TPU is the default material.** Nozzle 220 °C, bed 50 °C, and
  **firmware flow 180 %** (`M221 S180`): every E you write comes out as
  1.8× that on TPU.
- **PLA:** 205 °C, 60 °C, 100 % flow.

These are **mechanisms the author may want or may be deliberately
challenging**. This is an exploration tool: use them to explain a risk or
to offer a change, never to overrule the drawing.

## Pressure and flow

- **TPU stores pressure (§10, blob v10–v11).** TPU is compressible. A burst
  of extrusion compresses the filament column, and the melt keeps oozing
  afterwards, during dwells and dry moves with **no E commanded at all**. A
  retract does not relieve it instantly. What helped: building more slowly
  (120 mm/min rather than 200), a lower first contact (z 0.2), and a lower
  nozzle temperature. Longer dwells only wait out the ooze; they do not
  prevent it.
- **No stationary bursts (§10, blob v8).** Extruding while the nozzle
  stands still dumps pressure at one spot. The blob dot folds even its
  prime into the first *rising* move, so extrusion always comes with
  motion.
- **A retract with no matching prime starves the next extrusion (§14,
  segmented v1).** The first `retractMm` of the next E only refills the
  nozzle, so each segment printed as a cone (starved start, fat end).
  Every retract needs a prime of about the same amount before extruding
  again.
- **Volumetric flow is capped at about 4 mm³/s** (placeholder, well under
  published rigid-filament figures). TPU buckles under back-pressure.

## Shaping a deposit

- **Dome by rising (§10).** A small dome is built by extruding while rising
  in Z, with no XY motion, in about 6 steps, each laying down less than the
  one before (taper 0.7), from a first contact at z 0.2.
  - A bigger first-step "anchor" plus a 1 s dwell helps it stick.
  - Dome height ≈ half the diameter.
  - Volume = a cylinder π r² · z(first contact) + a hemisphere ⅔ π r³.
  - Confirmed good for sizes 1.6–3 mm.
- **Width needs height (§14, segmented v4).** At a fixed low nozzle height
  the tip confines the bead: extra material backs up rather than spreading.
  A genuinely wider bead needs the nozzle a little higher (0.3 vs 0.2 mm)
  and a slower pass.
- **Hair is pulled from melt (§12, hairy dot v5–v11).**
  - On TPU the *extruding* part of the pull sets the visible hair length.
    The fast dry "string" afterwards goes soft and barely counts.
  - Retract **immediately** after the extruding pull, not at the end of
    it. Retracting at the end strung across the whole pull (v4).
  - Longer hair needs a thicker bead, or it flops.
  - Matching the Z rise speed to the filament feed during the extruding
    part (both about 150 mm/min), then a slightly slower dry rise, was
    tentatively good.
- **Lean by shearing (§13, directional blob v3, confirmed).** Travelling
  sideways while rising leans the dome. Afterwards, dropping straight down
  to bed height and dragging back across the base shapes it. Both of those
  moves are dry.
- **Minimum relief** is about 0.4 mm (two layers) to be felt. This is a
  recommendation, not a tested limit.

## Stringing

- **Orbit at the dome's own height (§10, blob v6/v17, confirmed).** After
  the retract, circling the dot at its top height 3 times with no
  extrusion clearly reduced stringing. Lifting and orbiting again higher
  up was **not needed** (v17). Vertical up-and-down "bounces" were tried
  and dropped (v10–v14).
- **Dry moves right after extruding, without a retract, string.** Any dry
  move leaving fresh material should come after the retract.

## The machine

- **Retraction damages TPU (§1).** Fast or frequent retracts grind a flat
  spot on the filament at the drive gear. The damage persists into later
  prints.
  - Keep retract/prime feeds ≤ about 1000 mm/min on TPU (the default is
    900).
  - Count the cycles: one retract per stamp × hundreds of stamps adds up.
  - Distances used: 1.3 mm by default, 4 mm for dots and hair.
- **Collisions (§2).** A travel or dry move can drag through material
  already laid down, including this stamp's own. The standard hop clears
  only 0.4 mm above the current point. A deliberate squish is fine; an
  accidental drag flattens the feature.
- **Paths too steep to print (§5).** A curve with a sharp direction change
  cannot be printed smoothly at any resolution. Change the shape instead
  of sampling it more finely.
- **Nothing prints below about 0.1 mm** of nozzle height. First-layer
  contact is 0.2 mm.
