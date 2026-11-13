# Variable-thickness sheet: how the nine pieces are made

2026-11-13

Nine tactile graphics on a **new sheet**, made only with `brushVariableThickness` from [texture_functions.js](../sewingeditor/texture-actions/texture_functions.js). The difference from `strokeVariableThickness` is that **every wave can have its own settings**: wavelength, `hMin`, `hMax`, `beadWidth`, `phase`, and the gap after it.

| File | What it is |
| --- | --- |
| [vt-sheet.gcode](vt-sheet.gcode) | sheet 1: nine variable-thickness graphics. 19,729 lines, ~2.63 m of filament, ~6,300 mm³ of plastic |
| [vt-extras.gcode](vt-extras.gcode) | sheet 2 (separate): ten graphics that use **both** brushes, within X 10–200, Y 140–220. 5,711 lines, ~0.58 m of filament, ~1,390 mm³ |
| [scripts/make_vt_sheet.mjs](scripts/make_vt_sheet.mjs) | the generator for both sheets: one function per piece. Run it with `base` for sheet 1 or `extras` for sheet 2 |
| [scripts/plot_vt.mjs](scripts/plot_vt.mjs) | the preview renderer: beads at their real width, petal blobs at their real size with their drags, all shaded by height |
| [previews/](previews/) | `vt-sheet-all.png`, one close-up per sheet 1 piece (`zoom-*.png`), and `vt-extras-all.png` / `vt-extras-band.png` for sheet 2 |

**Print time:** at the brush's constant flow of 4 mm³/s, extrusion alone takes about **26 minutes**, plus travel and the lifts between waves.

## Sheet map

Seen from above, +Y up (on most printers +Y is the back of the bed). A 3 x 3 grid of 70 mm cells, centres at X/Y 40, 110 and 180.

```
Y180   Morse "TPU"     necklace         wheat
Y110   relief          weave            spiral arms
Y40    AM/FM swatch    fan of ridges    sunburst
```

## The brush, and how it is called here

One `brushVariableThickness` call prints **one wave**: the bead height follows a cosine from `hMin` up to `hMax` and back over `wavelength` mm. Optionally it starts `phase` of the way into the wave (0.5 starts on a peak).

- **Bead top:** the nozzle rides on the bead top, so Z = height.
- **Constant flow:** each micro-move extrudes width x height x length. The speed is set so the flow stays at `volRate` (4 mm³/s), so tall or wide parts print slower.
- **Gaps:** when a gap is asked for, the wave retracts. The next wave lifts to 1.5 x `hMax`, crosses the gap, comes down and primes.

The script loads a copy of `texture_functions.js` (`scripts/tf_copy.mjs`) with the brush and `restOfPath` exported, so the brush code is unchanged. On top of it there is one helper:

- **`waveVar(path, f)`:** walks a path wave by wave, like `strokeVariableThickness`. At each wave `f(i, s, frac)` returns that wave's `{ wavelength, hMin, hMax, beadWidth, phase, stepsPerWave, gap }`. `s` is where the wave starts and `frac` is how far along the path it is (0 to 1).

All heights stay between 0.24 and 1.4 mm, and bead widths between 0.8 and 2.8 mm. These are inside what your test sheet printed cleanly; I avoided the 0.24-2 mm range, which came out blobby.

## The pieces

### 1. AM/FM swatch (X40 Y40)

How it's made:

- 8 rows, 50 mm long, 4.3 mm apart.
- **Top four rows (FM):** the wavelength sweeps from 12 mm down to 3 mm along the row. `hMax` is 0.5, 0.8, 1.1 and 1.4 mm, one value per row. Bead width 1.2 mm.
- **Bottom four rows (AM):** a fixed 5 mm wave whose `hMax` swells from 0.3 to 1.4 and back to 0.3 mm along the row. Bead width 0.8, 1.4, 2.0 and 2.6 mm, one value per row.

Why this shape:

- Your test sheet varied one setting per line. Here a setting changes *along* a line, which needs per-wave control.
- It works as a key for the rest of the sheet: a chirp you can feel speeding up, and a swell you can feel growing.

### 2. Fan of ridges (X110 Y40)

How it's made:

- 18 rows, 50 mm long, 1.7 mm apart, bead width 1.9 mm, so the rows fuse into one surface. Heights 0.25 to 1.0 mm.
- Each row's wavelength is 4.5% longer than the row below it: 5 mm up to 10.5 mm.
- Rows run back and forth. Each reversed row gets the `phase` that puts its peaks at the same X a forward row would. I checked this in the G-code: the peaks shift steadily from row to row.

Why this shape:

- In your white wave field all rows had the same wavelength, so the bumps simply stacked. Here the peaks start lined up and drift apart row by row, so they join into diagonal ridges that fan out across the patch.
- That pattern only exists across rows; no single row has it.

### 3. Sunburst (X180 Y40)

How it's made:

- Concentric rings from radius 6 to 26 mm, 2 mm apart, bead width 1.7 mm.
- Each ring holds a whole number of waves: 12 inside radius 15 mm, 24 outside. All rings start at the same angle, so the wavelength is the circumference / 12 or / 24.

Why this shape:

- No spokes are drawn. Every ring's peaks fall at the same angles, so 12 radial ribs appear from thickness alone, splitting into 24 in the outer rings.
- Each ring starts in a valley, so its start/end seam sits at the lowest point. Your spiral discs show a straight line of small bumps across the radius; I think that may be a start or seam effect, and this ring layout should show whether starting in a valley hides it.

### 4. Spiral arms (X180 Y110)

How it's made:

- One Archimedean spiral, 2 mm pitch, radius 1.5 to 24 mm, bead width 1.8 mm, heights 0.25 to 1.1 mm.
- The wavelength grows with the radius so that each turn holds 5.2 waves.

Why this shape:

- Your spiral discs used a fixed wavelength, so their bumps fell at random angles. Here the extra 0.2 wave per turn makes the peaks drift steadily, and they line up into five curved arms.
- The arms are an effect of the wavelength rule, not a drawn shape. The close-up shows them as five dark bands curving outward.

### 5. Weave (X110 Y110)

How it's made:

- **Horizontal threads:** 9 threads 4.5 mm apart, wavelength 9 mm. Each is low (0.25 mm) at every other crossing and high (0.9 mm) in between. Alternate threads are shifted half a wave (`phase` 0.5).
- **Vertical threads:** printed second. Each is a run of single tall waves (1.35 mm, 5.4 mm long), centred on the crossings where the horizontal thread is low. Between them a 3.6 mm gap lifts over the crossings where the horizontal thread is high.

Why this shape:

- It builds on the lattice in your test photo, where the lines simply crossed. Here every thread goes over, then under, then over, like woven cloth.
- It uses three per-wave features at once: phase, gaps, and a different height for the second layer.
- The vertical threads only ever cross a horizontal thread where it is at its lowest, so the nozzle never plows into it.

### 6. Relief (X40 Y110)

How it's made:

- A 48 mm disc of fused raster rows, 1.1 mm apart, bead width 1.3 mm.
- Each wave is a 1.5 mm step with `hMin = hMax`, so the bead holds one height there.
- The heights follow a dome with ripples rolling out from the centre, from 0.3 mm at the rim to 1.3 mm at the middle.

Why this shape:

- It uses the brush as a 2.5D printer: any height map can be printed this way, not only cosine waves.
- It extends your fused 12 mm / 3.6 mm block, where the rows already merged into one surface.
- This is the newest idea on the sheet and the least tested. A wave with `hMin = hMax` is valid for the brush, but your sheets haven't tried it, and the 1.5 mm steps may print slightly terraced.

### 7. Morse "TPU" (X40 Y180)

How it's made:

- One letter per row: T = −, P = · − − ·, U = · · −.
- **Dot:** one short, wide, tall wave: 5 mm long, 2.8 mm wide, 1.3 mm high.
- **Dash:** one long, narrow, low wave: 14 mm long, 1.6 mm wide, 0.8 mm high.
- Symbols are separated by 4 mm lifted gaps.

Why this shape:

- Each brush call is exactly one symbol, so the brush becomes a tactile alphabet. Dots and dashes differ in length, width and height, so they're easy to tell apart by touch.
- It builds on your gap tests, the dashed rows labelled 1 / 2 / 1.6 / 3.2 gap. Those showed some stringing, so expect a little here too.

### 8. Necklace (X110 Y180)

How it's made:

- **Outer loop:** a five-lobed flower curve, r = 21 + 4·cos 5θ. Pearls (4.2 mm waves, 2.8 mm wide, 1.3 mm high) alternate with spacers (2.2 mm, 1.0 mm wide, 0.45 mm high).
- **Inner loop:** a 10 mm circle with smaller pearls (3.2 mm, 2.2 mm wide, 1.0 mm high), with the same spacers.

Why this shape:

- Width and height change from wave to wave, so the line reads as separate beads on a string rather than a wavy ridge.
- It builds on your bead-width sweep (0.8 to 3.6 mm), using wide and narrow waves in the same line.
- Neither loop crosses itself, so the nozzle never rides over a bead it has already printed.

### 9. Wheat (X180 Y180)

How it's made:

- **Stalks:** five gently curved stalks fanning out from bases 3 mm apart.
- **Stem:** the first 60% of each stalk is one long gentle wave, 1.0 mm wide and 0.25 to 0.6 mm high.
- **Ear:** the rest is a run of grains, 2.8 mm waves. They shrink toward the tip: 2.4 to 1.4 mm wide and 1.15 to 0.7 mm high.
- **Leaves:** two leaves, each a single wave as long as the leaf (0.2 to 1.0 mm high, 1.8 mm wide), so they are thin at both ends and full in the middle.

Why this shape:

- One stroke switches between two characters: a smooth stem, then a beaded ear.
- A leaf as a single wave is the brush's natural shape: one cosine taper is exactly a leaf profile.
- The bases are spread out so the stalks never cross each other.

## Placement and checks

- **Cell check:** after each piece, the script measures every X/Y it reached. It stops with an error if anything leaves its 70 mm cell (centre ±33 mm) or the bed. Everything lands within X/Y 14 to 206.
- **Moving between pieces:** the nozzle lifts to Z 5 before every move between pieces, and the pieces print in a snake through the grid.
- **Before printing:**
  - The file starts with `G90 / M83 / M221 S100`, like the page's "run once". The printer must already be heated and homed.
  - There is no prime line.

---

# Sheet 2: two brushes together (vt-extras.gcode)

A **separate sheet**. Ten graphics, each combining variable-thickness lines (`brushVariableThickness`, wave by wave) with petal dots (`brushPetalDot`, dot by dot). Everything printed stays within **X 10–200, Y 140–220**. Extrusion takes about 6 minutes, plus travel and lifts.

```
        X24        X55        X89          X123          X157        X187
Y200  firework | pine tree | butterfly | peacock feather | hedgehog  | tulip
Y160  (full    | caterpillar| sun      | snail           | rain cloud| (full
       height)                                                         height)
```

- **Layout:** a full-height column at each end (firework X 10–38, tulip X 174–200), and a 4 x 2 grid of 34 x 40 mm cells between them (X 38–174).
- **Checks:** the script measures every printed mark of each piece (bead width, blob size and drags included). It stops if anything leaves the piece's box, or comes within 0.8 mm of another piece.

## Rules for mixing the brushes

- **Petal dots only on bare bed.** A petal dot's drag ends at Z 0, so a dot on top of a variable-thickness bead would plow through it. Every dot sits at least about 1 mm clear of any bead, and drags point away from the beads.
- **Lift between brushes.** Before every stroke and every dot, the nozzle lifts to Z 2. Each brush's own travel hop is only 0.4 mm above where it is, which isn't enough to clear a 1 mm blob or a 1.3 mm bead from the other brush.

## The pieces

| Piece | Variable-thickness part | Petal-dot part | Why this pairing |
| --- | --- | --- | --- |
| **Firework** (column, X24) | the climbing trail: one line rising 48 mm, waves getting shorter, taller and wider toward the top (7 → 2.5 mm, 0.5 → 1.15 mm high, 1.0 → 2.0 mm wide) | falling sparks either side of the trail; a burst of three rings at the top (8, 12, 16 dots), every tail flung outward | a smooth rising ridge you can feel accelerating, ending in spiky marks; the two brushes are the two halves of the event |
| **Tulip** (column, X187) | stem = one long gentle wave; two leaves, each a single wave the length of the leaf | the flower: three chains of six dots that start close together, flare out and curve back in, shrinking as they rise, tails chaining upward | a single wave is a natural leaf profile; chained petal dots make a cup with raised petals |
| **Caterpillar** | the body: a wavy line whose waves are its segments (4.4 mm, 2.6 mm wide), with a bigger last wave for the head | legs under each segment with tails swept back; two antennae | each brush call is one body part: segment, leg or antenna |
| **Sun** | a spiral disc, 2 mm pitch, 5.2 waves per turn so faint arms swirl in it | 16 rays, long and short alternating, flung outward | a smooth, dense centre against a sharp, sparse edge |
| **Snail** | the shell: a spiral whose waves and height grow with the radius; the body: one long tapering wave | two eye stalks pulled up and forward | the shell's growth shows in the wave size, and the stalks are what a petal dot's drag naturally looks like |
| **Rain cloud** | four fused rows of bumpy waves, longest in the middle, phases alternating so the bumps nest | 18 staggered drops with tails pointing up (round head down), bigger lower down | a soft, raised cloud above, crisp separate drops below; the dot's teardrop already is a raindrop |
| **Pine tree** | the trunk: one tapering wave | tiers of needles either side, narrowing toward the top, all swept down and out; a dot at the top | the needles' drag gives the drooping-branch direction for free |
| **Butterfly** | body: three waves of different shape (long thin abdomen, short fat thorax, round head); thin single-wave antennae | club tips on the antennae; wings as fans of chained rays, big upper wings and smaller lower ones | a smooth, segmented body against textured wings |
| **Peacock feather** | a thin shaft; an eye of two whole-wave rings (4 and 8 waves) | barbs sweeping up and out along the shaft; a halo of dots around the eye, left open where the shaft comes in | the eye is a small sunburst from heights alone, framed by the dots |
| **Hedgehog** | the body: a half-dome of nine fused rows of small bumpy waves (furry); the snout: one tapering wave | spines fanning around the back; a nose; two feet | spines are exactly a petal dot's shape, and the soft body is exactly fused variable-thickness rows |

**What to watch:**
- **Many short marks.** Each petal dot is a retract/prime cycle, as on the petal sheets, so expect some stringing between nearby dots.
- **Tight spots.** The tulip's flower and the butterfly's wings have the closest dots, and are where any stringing is likeliest to show.

---

## Regenerating

From this folder:

```
node scripts/make_vt_sheet.mjs ../sewingeditor/texture-actions/texture_functions.js vt-sheet.gcode base
node scripts/make_vt_sheet.mjs ../sewingeditor/texture-actions/texture_functions.js vt-extras.gcode extras
node scripts/plot_vt.mjs vt-extras.gcode previews/vt-extras-band.png 5 100 200 1400
node scripts/plot_vt.mjs vt-sheet.gcode previews/vt-sheet-all.png
node scripts/plot_vt.mjs vt-sheet.gcode previews/zoom-weave.png 85 85 50 700   # x0 y0 size(mm) pixels
```

To change a piece, edit what its `waveVar` call returns. Each wave's settings come from a short function, so a setting can depend on the wave number, the position along the path, or anything else.
