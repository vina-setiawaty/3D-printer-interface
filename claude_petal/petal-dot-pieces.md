# Petal-dot test sheets: how the pieces are made

2026-11-13

Two sheets of tactile pieces, every mark a single petal dot (`brushPetalDot`):

- **Sheet 1** (12 pieces, around the existing petal-flower). Every dot within a stroke has the same settings. A piece only chooses a path, a walking direction and four options.
- **Sheet 2** (16 pieces, on a new sheet). Every dot can have its own gap, diameter, height, drag length and angle.

| Sheet | File | Pieces | Dots | Filament | Lines |
| --- | --- | --- | --- | --- | --- |
| 1 | [petal-flower.gcode](petal-flower.gcode) | 1, centred at X110 Y110 | 139 | ~146 mm | 982 |
| 1 | [five-flowers.gcode](five-flowers.gcode) | daisy, swirl rose, rose curve, four-petal, sunflower | 423 | ~483 mm | 2,981 |
| 1 | [seven-pieces.gcode](seven-pieces.gcode) | wave field, galaxy, feather, heart, target, pinwheel, raindrop | 353 | ~292 mm | 2,495 |
| 2 | [sheet2-patterns.gcode](sheet2-patterns.gcode) | 16 graphics (see the Sheet 2 map) | 1,425 | ~1.30 m | 10,017 |

All generators import the working copy of [sewingeditor/texture-actions/texture_functions.js](../sewingeditor/texture-actions/texture_functions.js). So the dots are exactly what the page's `petalDot` card prints.

## The brush (both sheets)

`brushPetalDot(em, x, y, { diameter, height, extrudeSpeed, dragMm, azimuthDeg, dragSpeed })` makes one mark:

1. It extrudes a blob in place at Z = `height` (the round **head**). The amount is 3/4 of a cylinder `diameter` wide and `height` tall.
2. It retracts.
3. It drags `dragMm` toward `azimuthDeg` while dropping to Z 0 (the **tail**).

| diameter (height 1) | Filament per dot |
| --- | --- |
| 1.2 mm | 0.35 mm |
| 1.6 mm | 0.63 mm |
| 2.0 mm | 0.98 mm |
| 2.5 mm | 1.53 mm |
| 3.0 mm | 2.20 mm |

Both sheets use `extrudeSpeed` 150 and `dragSpeed` 600.

Every file starts with `G90 / M83 / M221 S100`, like the page's "run once":
- The printer must already be heated and homed.
- There is no prime line, so nothing builds up on a reused sheet.
- Every drag ends at Z 0, touching the bed or fabric. Use a Z offset if you need clearance.

The nozzle lifts to Z 5 before every move between pieces.

---

# Sheet 1: twelve pieces around petal-flower

## Sheet 1 map

Seen from above, +Y up (on most printers +Y is the back of the bed). Centres in mm.

```
Y185   four-petal (35,185)     sunflower (110,185)     feather (185,185)
Y155          raindrop (65,155)            heart (155,155)
Y110   rose curve (35,110)     [petal-flower 110,110]  galaxy (185,110)
Y65           pinwheel (65,65)             target (155,65)
Y35    daisy (35,35)           swirl rose (110,35)     wave field (185,35)
```

- The 3 x 3 grid holds the large pieces (about 30 to 38 mm). Petal-flower takes the centre cell.
- The four small pieces (12 to 20 mm) sit in the diagonal gaps around petal-flower. Only about 20 mm is free there, which is why they are small.

## Sheet 1 recipe: one setting per stroke

Every piece is the same two calls: `strokePetalDotted` walks a path and `brushPetalDot` makes each mark.

```js
stroke(path, { diameter, gap, dragMm, azimuthDeg })
// = em.newPattern(); strokePetalDotted(em, path, { height: 1, extrudeSpeed: 150, dragSpeed: 600, ...options })
```

1. The stroke puts a stop every `gap` mm along the path. At each stop it measures the path's direction (`headingDeg`), from the points 1 mm before and 1 mm after.
2. It calls the brush with `azimuthDeg = headingDeg + azimuthDeg`.

The stroke's `azimuthDeg` is measured from the direction of travel:

| azimuthDeg | Tail points | On a counter-clockwise circle |
| --- | --- | --- |
| 0 | forward along the path | around it |
| 90 | left of travel | inward |
| -90 | right of travel | outward |
| 180 | backward | around it, backward |

Two habits come up again and again below:

- **Chaining:** when `dragMm` is close to `gap`, each tail ends where the next dot lands, so the dots join into one streak.
- **Shared points:** where many paths meet at one point, the paths start a few mm out so the blobs don't pile up there.

Paths come from four helpers:

- `line(a, b)`: a straight line (`polylineToPts`).
- `curve(fx, fy, t0, t1)`: any formula (`samplePath`).
- `spiral`: r grows steadily with angle.
- `ring`: a counter-clockwise circle, stopped one gap short so its first and last dots don't land on each other.

In each piece, paths are given relative to the piece's centre.

## Sheet 1: the five flowers (five-flowers.gcode)

Each flower tests one idea taken from the first test sheet: tails out versus in, chaining, outlines, the cross motif, and drag length.

### 1.1 Daisy (X35 Y35)

How it's made:

- **Petals:** 12 straight lines 30° apart, from 7 to 16 mm out. Each is walked outward with azimuth 0. d2, gap 3, drag 3.
- **Centre:** a spiral, 2 mm between turns, radius 1 to 5 mm, azimuth 90 (tails in). gap 2.5, drag 2.

Why this shape:

- It puts both tail directions in one piece: spiky tails out on the rays, a raised tails-in mound in the middle.
- Drag equal to gap (3 and 3) is the cleanest chaining test: each tail should end exactly under the next blob.
- The centre repeats the azimuth-90 spiral from the test sheet, which already printed well. So the only new part is the rays.

### 1.2 Swirl rose (X110 Y35)

How it's made:

- One spiral, 2.5 mm between turns, radius 1.5 to 17 mm, walked outward with azimuth 0. d2.5, gap 3, drag 2.5.

Why this shape:

- One continuous path is the simplest possible piece: one start, no travel between strokes.
- On the test sheet, d2 dots stayed separate and d3 dots merged. d2.5 with 2.5 mm between turns sits between the two, to see where merging starts.
- Every tail chains forward, so the disc should read as one coiled ribbon rather than as dots.

### 1.3 Rose curve (X35 Y110)

How it's made:

- **Petals:** 5 petals, each one loop of r = R·cos(5u), turned 72° apart. There are two loops per petal: R = 19 (the edge) and R = 12 (an inner vein). d2, gap 3, drag 2, azimuth 90.
- **Tail direction:** the loops run counter-clockwise, so azimuth 90 drags every tail into its own petal.
- **Centre:** the part of each loop within 4 mm of the centre is cut off (u0 = acos(4/R)/5). In its place is a 2 mm ring of d1.6 dots, tails in.

Why this shape:

- It draws petals as outlines instead of filling them, which none of the test-sheet prints did.
- The rose curve makes a closed petal loop from one formula, and its tip turns sharply. That tests the stroke's direction measurement where the path bends hardest.
- All 10 loops cross the centre, so it is also the clearest case for starting paths away from a shared point.

### 1.4 Four-petal (X35 Y185)

How it's made:

- **Large petals:** 4 petals, each a fan of 5 lines from a base point 4 mm out, spread ±24°. The middle line is 15 mm. The outer lines are 35% shorter and start further from the base.
- **Direction:** each line is walked tip to base with azimuth 0. d2, gap 3, drag 2.5.
- **Small petals:** 4 single lines at 45°, from 11 to 5 mm out, d1.6.
- **Centre:** 4 dots on a 2 mm ring, tails in.

Why this shape:

- It grows the test sheet's four-petal cross motif into a full flower, so the two can be compared side by side.
- Walking tip to base puts the round heads along the petal edge and hides the tails inside. The head is the round part of the mark, so the edge comes out smooth and rounded.
- The fan gives a narrow base and a wide rounded tip without any fill pattern. The outer lines starting later keeps the base from clogging.

### 1.5 Sunflower (X110 Y185)

How it's made:

- **Seed head:** rings at radius 2, 4.5, 7 and 9.5 mm. d1.6 dots about 2.5 mm apart, azimuth -90 (tails out), drag 1.2. Every other ring is rotated by half a gap.
- **Rays:** one ring at 12.5 mm, d2.5, azimuth -90, drag 6.

Why this shape:

- It puts the shortest drag (1.2 mm) and the longest (6 mm) in one piece, to see how far a tail can be pulled before it thins or snaps.
- The staggered rings pack the small dots like seeds, so the head reads as a texture rather than as circles.
- Every ring has tails out, so to the touch the whole piece runs one way, the opposite of the daisy's mixed directions.

## Sheet 1: the seven pieces (seven-pieces.gcode)

These seven don't have to be flowers. The rule was that each one should suit the teardrop shape of the petal dot: the drop's direction is the pattern. The large ones use direction across a whole area. The small ones use few, separate drops, because at 20 mm fine detail merges into one blob.

### 1.6 Wave field (X185 Y35)

How it's made:

- 5 rows, 7 mm apart. Each is a sine wave y = 2.2·sin(2πx/11) over x = -16 to 16, walked left to right.
- azimuth 90, so each tail sits to the left of the direction of travel. d2, gap 3, drag 2.5.

Why this shape:

- The path's direction keeps changing, so the tails tilt with the slope of the wave. It shows the direction measurement working across a whole area.
- Rows of tilted teardrops read as fish scales or ripples, a texture the brush makes naturally.
- A square of rows is also a swatch: the closest thing on sheet 1 to a texture you could repeat across fabric.

### 1.7 Galaxy (X185 Y110)

How it's made:

- 4 arms, 90° apart. Each is a logarithmic spiral r = 2·e^(0.25θ) from radius 2 to 16.5 mm, about 1.3 turns.
- Walked outward with azimuth 0. d2, gap 3, drag 2.5.

Why this shape:

- A logarithmic spiral opens up as it goes out, so the same gap and drag go from tightly chained at the core to separate dots at the rim. One piece shows a gradient.
- It contrasts with the swirl rose: four arms whose spacing changes, against one spiral whose spacing stays even.

### 1.8 Feather (X185 Y185)

How it's made:

- **Spine:** a line from (-8, -12) to (8, 12), bowed 3 mm sideways. Walked base to tip with azimuth 0. d2, gap 2.5, drag 2.
- **Barbs:** at 10 points along the spine, on both sides, short lines leave at ±50° from the spine, angled toward the tip.
  - Length is 2 + 7·sin(πs)^0.8, where s runs from 0 at the base to 1 at the tip. So they are longest in the middle and short at both ends.
  - Each starts 1.5 mm off the spine and is walked outward with azimuth 0. d1.6, gap 2.5, drag 1.5.

Why this shape:

- A single teardrop already looks like a barb, so a feather is built from the brush's own shape.
- It is the only branching piece on sheet 1. It tests two dot sizes as a hierarchy: d2 for the spine, d1.6 for the barbs.
- Walking each barb outward sweeps the tails to the edge like real vanes. The sine length profile gives the feather its outline without drawing one.

### 1.9 Heart (X155 Y155)

How it's made:

- The heart curve x = 16·sin³t, y = 13·cos t - 5·cos 2t - 2·cos 3t - cos 4t, at two sizes: x0.52 and x0.30.
- The curve runs clockwise, so azimuth -90 (right of travel) drags every tail into the heart.
- The last 0.12 of t is left out so the first and last dots don't stack. d1.6, gap 2.5, drag 1.5.

Why this shape:

- It is the one clockwise curve on sheet 1, so it needs -90 rather than 90 for "inward". That makes it a check that the direction convention holds both ways.
- It has a dip at the top and a point at the bottom: two hard spots for the direction measurement.
- It is recognisable at 16 mm with only 35 dots, which suits a small slot.

### 1.10 Target (X155 Y65)

How it's made:

- Three rings: r = 3 (azimuth -90, tails out), r = 6 (azimuth 90, tails in), r = 9 (azimuth -90, tails out). d1.6, about 2.5 mm apart, drag 1.2.

Why this shape:

- The inner two rings drag toward each other and the outer one drags away. It is a direct test of whether you can feel tail direction change from ring to ring.
- Rings are the simplest closed path, so at 20 mm nothing blurs.

### 1.11 Pinwheel (X65 Y65)

How it's made:

- 6 arms, 60° apart. Each curls as it goes out: angle = start + 0.13·r, for r from 1.5 to 8.5 mm.
- Walked outward with azimuth 0. d1.6, gap 2.3, drag 1.5.

Why this shape:

- It is the smallest chaining test, 24 dots in all.
- The curl shows rotation, which no other small piece has.

### 1.12 Raindrop (X65 Y155)

How it's made:

- The outline is the teardrop curve: 18 mm long, half-width 9·sin t·sin(t/2).
- It is filled with 5 rows parallel to the drop's length, 2.4 mm apart, each trimmed to fit inside the outline.
- Rows are walked from the round end toward the tip with azimuth 0. The whole drop is tilted 45°. d1.6, gap 2.6, drag 1.5.

Why this shape:

- It is the brush's own shape scaled up, a big drop made of small drops all pointing at its tip.
- Every dot points the same way, so it tests one uniform direction over an area.
- It replaced a snowflake I made first. At 16 mm the snowflake's arms and branches merged into one blob, and the separate drops didn't show.

## Sheet 1 placement and checks

- **Positions:** each piece is a function that takes its centre `(cx, cy)`. A table at the bottom of each script sets the centres and the print order.
- **Overlap check:** after each piece, the script measures every X/Y it reached, drag ends included. It stops with an error if anything falls in petal-flower's area (X/Y 78-142), on an earlier piece, or off the bed.
- **Furthest point:** X 199.886, the end of a drag in the galaxy.
- **Print order:** it goes around the edge of the bed, never across the middle.
  - five-flowers: swirl rose, daisy, rose curve, four-petal, sunflower.
  - seven-pieces: wave field, galaxy, feather, heart, target, pinwheel, raindrop.
- **Limits of the check:** it only knows about the sheet 1 files. Anything else already on that sheet isn't checked.

---

# Sheet 2: sixteen pieces with per-dot settings

## Sheet 2 map

A **new, empty sheet**. Seen from above, +Y up. A 4 x 4 grid of 53 mm cells, centres at X/Y 31, 84, 137 and 190.

```
Y190  TPU lettering   rain          Turing stripes   dandelion
Y137  heartbeat       nautilus      bubbles          interference
Y84   fish            mandala       tree             fingerprint
Y31   param. swatch   comet         phyllotaxis      vortex
```

## Sheet 2 recipe: one setting per dot

`strokePetalDotted` gives every dot in a stroke the same settings. For sheet 2, the script loads a copy of `texture_functions.js` (`tf_copy.mjs`) with `brushPetalDot` exported, and calls the brush once per dot. The brush code is unchanged and the repo file is never modified.

Two helpers decide where each dot goes:

- **`walkVar(path, f, s0)`:** walks a path from arc length `s0`. At each stop, `f(i, s, frac)` returns that dot's `{ gap, d, h, drag, az }`, where `gap` is the distance to the *next* stop and `az` is an offset from the path direction (0 = forward). So size, spacing and drag can change smoothly along one stroke.
- **`dotsAt(list)`:** places dots at a given list of points, each with its own settings and an absolute angle. Used where there is no path: grids, scatters, golden-angle spirals.

In the pieces below, "a → b" means the value changes smoothly from a at the start to b at the end, and `frac` runs from 0 to 1 along the stroke. Paths are relative to the piece's centre.

### 2.1 Parameter swatch (X31 Y31)

How it's made:

- A 6 x 6 grid. Diameter grows left to right: 1.4, 1.7, 2.0, 2.3, 2.6, 3.0 mm. Drag grows bottom to top: 0.5, 1.5, 2.5, 3.5, 5, 6.5 mm.
- Every tail points straight up (+Y). Columns are spaced diameter + 3.2 mm apart, and rows drag + 3.4 mm apart, so no tail reaches the next row.

Why this shape:

- It is a printed key: one look (or touch) shows what each diameter and drag does, which makes the other fifteen easier to judge.
- Only two settings change and all angles are the same, so any difference between dots comes from those two settings alone.

### 2.2 Comet (X84 Y31)

How it's made:

- **Head:** one dot at (14, 13), d3, height 1.3, drag 1. A halo of 8 dots on a 4.2 mm ring around it, d1.4, tails outward.
- **Trails:** three curved trails (quadratic Bézier curves) from the head to (-20, -13), (-16, -18) and (-10, -20). Each is walked from 6 mm past the head toward its end, with azimuth 0.
  - From start to end: gap 2.6 → 6 mm, diameter 2.8 → 1.2 mm, height 1.2 → 0.8 mm, drag 1.5 → 4.5 mm.

Why this shape:

- It is the one stroke on sheet 2 where all four settings change together, to see whether a fade reads clearly when nothing stays fixed.
- Shrinking, spreading, longer-streaked dots read as speed and distance, which a constant-setting stroke can't show.
- The first version's longest drags (6.5 mm) ran out of the cell, so they were cut to 4.5 mm.

### 2.3 Phyllotaxis (X137 Y31)

How it's made:

- 90 dots, dot n at radius 20·√(n/90) and angle n x 137.508° (the golden angle).
- From centre to edge: diameter 1.3 → 2.8 mm, drag 0.8 → 3.0 mm. Each tail points straight outward.

Why this shape:

- There is no path at all, only a placement rule. The sunflower's two sets of spirals appear on their own, which shows `dotsAt` working.
- The dots are smallest at the centre, where they are packed tightest, so the middle doesn't clog.

### 2.4 Vortex (X190 Y31)

How it's made:

- A spiral, 3 mm between turns, walked from the rim (r = 22) inward to r = 1.5, turning clockwise, with azimuth 0.
- From rim to centre: gap 3.4 → 1.9 mm, diameter 2.8 → 1.3 mm, drag 1.2 → 3.0 mm.

Why this shape:

- It is the comet's gradient run the other way: smaller and closer toward the end. So it feels like falling into a drain.
- With 196 dots and a 1.9 mm gap at the centre, it is the densest piece on sheet 2. It tests how close small dots can go before they merge.

### 2.5 Fingerprint (X190 Y84)

How it's made:

- 7 oval ridges, radius 3.2 + 2.6k (k = 0 to 6). Each wobbles by 9%·sin 3θ + 4%·sin 5θ, and is squeezed to 0.82 in X.
- The outer four ridges are open at the bottom (0.45 rad each side), like the loops of a real print.
- Along each ridge: gap 2.6 ± 0.4 mm and diameter 1.6 ± 0.45 mm, both rising and falling with angle. drag = 0.85 x gap, azimuth 0, so the tails chain.

Why this shape:

- Ridges whose size and spacing breathe along the line feel uneven, like skin. A constant stroke would feel machined.
- The open loops break the symmetry, so it reads as a fingerprint rather than a target.

### 2.6 Tree (X137 Y84)

How it's made:

- A 13 mm trunk from (0, -24) straight up, then branching 4 levels deep. Each fork spreads ±30° and ±22° on alternating levels, and each branch is 0.76 x its parent's length.
- **Per level:** diameter = 3.0 x 0.8^level (at least 1.3 mm), gap = diameter + 0.9 mm, drag = 0.75 x gap, azimuth 0. The trunk is 1.3 mm tall.
- Each branch starts one diameter past its fork, so the joints don't pile up.
- Every tip ends in a fan of three leaf dots at ±35°, d1.6, drag 2.4.

Why this shape:

- Scaling every setting with depth gives a hierarchy you can feel: a thick trunk down to fine twigs. That's only possible with per-dot settings.
- The first version went 5 levels deep and its tips merged into one dense canopy, so one level was cut.

### 2.7 Mandala (X84 Y84)

How it's made, ring by ring from the centre:

| Radius | Dots | Diameter | Drag | Tails |
| --- | --- | --- | --- | --- |
| 2.6 mm | 6 | 1.8 | 1.0 | outward |
| 6.4 mm | 12 | 2.2 / 1.5 alternating | 1.9 / 0.9 | inward |
| 10.2 mm | 16 | 1.7 | 2.2 | around the ring (counter-clockwise swirl) |
| 13.8, 16, 18.2 mm | 12 spokes x 3 | 2.3, 1.9, 1.5 | 1.5 | outward |
| 21.5 mm | 30 | 1.4 | 1.1 | outward |

Why this shape:

- Each ring is its own setting set, so one piece samples outward, inward and swirling tails, alternating sizes, and shrinking spokes.
- It is symmetrical, so any dot that prints wrong stands out against its neighbours.

### 2.8 Fish (X31 Y84)

How it's made:

- **Body:** a lens shape from the nose at x = -21 to the tail joint at x = 11. Its half-height is 10·sin(...)^0.8, so it is fattest just ahead of the middle.
- **Scales:** 5 staggered rows, 3.2 mm apart, dots 3.2 mm apart. Diameter is 2.4 on the middle row, falling to 1.6 on the outer rows. Each tail points toward the tail fin (+X), drag 2.
- **Eye:** one dot at (-14, 2.5), d2.8, height 1.3. Scales within 3.5 mm of it are left out.
- **Tail:** 5 rays fanned ±38°, 11 mm long, with gap 2.4 → 3.2 mm and diameter 2.0 → 1.4 mm.
- **Fin:** 3 short lines above the back, d1.4.

Why this shape:

- The teardrop already looks like a scale, and all tails pointing backward is how scales lie.
- Dot size encodes body thickness (biggest along the middle), so size is used for 3D form, not just decoration.

### 2.9 Heartbeat (X31 Y137)

How it's made:

- Two beats of an ECG trace as one polyline: a small P bump (+2.5 mm), the QRS spike (-4, +17, -8 mm) and a T bump (+4 mm), on a flat baseline.
- At each stop, a = distance from the baseline / 15 mm (at most 1). Then:
  - gap 3.2 → 2.0 mm
  - diameter 1.4 → 2.6 mm
  - height 0.9 → 1.3 mm
  - drag 0.8 x gap, azimuth 0.

Why this shape:

- It maps data to dots: the further the trace is from the baseline, the bigger, taller and denser the dots. So the graph can be read by touch.
- It is a tactile chart, a use case different from decoration.

### 2.10 Nautilus (X84 Y137)

How it's made:

- **Shell:** a logarithmic spiral r = 1.3·e^(0.175θ) out to r = 21 (about 2.5 turns), walked outward with azimuth 0. gap 1.9 → 3.4 mm, diameter 1.3 → 2.8 mm, drag 0.8 x gap.
- **Chamber walls:** every 40° after the first turn, a short line from the shell to the point one turn inside. d1.3, gap 2.2, drag 1.2, starting 1.8 mm in.

Why this shape:

- The dots grow with the spiral, the way a shell's chambers do, so growth is shown by size as well as shape.
- The thin walls against the thick shell line test whether two line weights stay distinct.

### 2.11 Bubbles (X137 Y137)

How it's made:

- 13 circles with radii from 8.5 down to 2.3 mm, placed at random (seed 11) inside a 21 mm disc, at least 2.8 mm apart edge to edge.
- Each bubble is a ring of dots with tails running around it. Every setting comes from the radius R: gap = 1.8 + 0.28R, diameter = 1.2 + 0.14R, drag = 0.7 x gap.
- Bubbles of 4.5 mm and larger get a small highlight dot (d1.3) at the upper left.

Why this shape:

- One rule produces many sizes: every setting follows from R, so big bubbles have big, widely spaced dots and small ones have fine, close dots.
- It tests rings from 2.3 to 8.5 mm side by side, the smallest closed shapes on sheet 2.

### 2.12 Interference (X190 Y137)

How it's made:

- A hexagonal grid of points 4 mm apart inside a 21 mm circle. Two wave sources sit 14 mm apart (at x = ±7), wavelength 8 mm.
- At each point, v = |cos(2π·d1/8) + cos(2π·d2/8)| / 2, where d1 and d2 are the distances to the two sources.
- Where v < 0.15 no dot is printed. Elsewhere: diameter 1.2 → 2.9 mm and drag 0.6 → 2.6 mm as v rises, tails pointing away from the left source.

Why this shape:

- Leaving dots out is a setting too. The empty nodal lines carry the picture, like a halftone.
- It is the only piece where the gaps, not the dots, make the pattern.

### 2.13 TPU lettering (X31 Y190)

How it's made:

- Letters 12 mm wide and 20 mm tall, 4 mm apart. Strokes: the T bar and stem; the P stem (walked bottom to top) and bowl; the U as one stroke.
- Every stroke is walked with azimuth 0: diameter 2.6 → 1.5 mm, gap 2.2 → 3.0 mm, drag 0.8 x gap.

Why this shape:

- It tests whether dots can carry readable text.
- The thick-to-thin taper, as in calligraphy, shows where each stroke starts and which way it goes.

### 2.14 Rain (X84 Y190)

How it's made:

- Points scattered at random (Poisson disc, seed 7) in a 42 mm square, at least 4.4 mm apart.
- Each drop gets a random diameter from 1.3 to 3.0 mm. Its drag is 1.0 + 1.6 x diameter x (a random 0.6 to 1.0), so big drops leave longer streaks.
- All tails point the same way (255°), slanting like windblown rain. Drops print from the top row down.

Why this shape:

- No path and no regular grid: it tests irregular spacing and random sizes.
- Tying streak length to drop size makes the big drops look heavier and faster.

### 2.15 Turing stripes (X137 Y190)

How it's made:

- A grid of points 2.6 mm apart inside a 22 mm circle, printed in alternating row directions.
- A wavy field v = sin(0.62x + 2.4·sin(0.17y) + 1.3·sin(0.11(x + y))) decides each point. Where v ≥ 0.1 a dot is printed, with diameter 1.3 → 2.4 mm as v rises.
- Each tail runs along the band (the field's gradient turned 90°), drag 1.8.

Why this shape:

- The tails follow a field rather than a path: the direction comes from the pattern itself.
- Bands like a zebra or coral are a texture that could run across fabric.
- The first version (a 2.9 mm grid, cut-off 0.25) printed broken dashes, so the grid was tightened until the bands joined up.

### 2.16 Dandelion (X190 Y190)

How it's made:

- **Seed head:** centred at (0, 7), 3 small centre dots (d1.6). 22 rays from 2.5 mm out to 10.5 ± 2 mm, d1.2, gap 2.6, drag 1.4, azimuth 0. Rays within 28° of straight down are left out to make room for the stem.
- **Ray tips:** each ends in two seed dots fanned ±32°, d1.2, drag 1.8.
- **Stem:** a gently swaying curve from (0, -23), walked upward 25 mm toward the head. gap 2.2 → 2.8 mm, diameter 2.2 → 1.6 mm, drag 1.8.
- **Leaf:** a jagged polyline at the stem base, diameter 2.0 → 1.3 mm.

Why this shape:

- It is the finest piece on either sheet: d1.2 dots with wide gaps. It tests the lower limit of the brush.
- The stem is walked upward, so its tails point toward the head and it thins as it rises.

## Sheet 2 placement and checks

- **Cell check:** after each piece, the script measures every X/Y it reached, drag ends included. It stops with an error if anything leaves its 53 mm cell (centre ±26.3 mm) or the bed. Everything lands within X/Y 8 to 213.
- **Print order:** a snake through the grid, so moves stay short. Bottom row left to right, second row right to left, and so on.
- **Rain and bubbles:** both use a fixed random seed, so they come out the same every time.

---

## Regenerating

Everything for both sheets is in this folder (`petal_claude/`): the G-code and this doc at the top, the generators and preview plotters in `scripts/`, and top-view previews in `previews/`. Each generator takes the library path and an output path; run them from this folder:

```
node scripts/make_flower2.mjs ../sewingeditor/texture-actions/texture_functions.js petal-flower.gcode
node scripts/make_five.mjs    ../sewingeditor/texture-actions/texture_functions.js five-flowers.gcode
node scripts/make_seven.mjs   ../sewingeditor/texture-actions/texture_functions.js seven-pieces.gcode
node scripts/make_sheet2.mjs  ../sewingeditor/texture-actions/texture_functions.js sheet2-patterns.gcode
```

To redraw a preview: `node scripts/plotbed.mjs <file.gcode> <out.png>` (whole bed; `plot.mjs` and `plotcell.mjs` are zoomed variants). `make_sheet2.mjs` writes a helper copy of the library, `scripts/tf_copy.mjs`, with the brush exported; it is regenerated on every run.


- **Sheet 1 pieces:** edit a piece's function or its centre in the table at the bottom of the script.
- **Sheet 2 pieces:** change any setting per dot inside its `walkVar` or `dotsAt` call.
