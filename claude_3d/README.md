# 3D structures from the two texture brushes

2026-11-13 · PLA · untested on the printer

Four small 3D pieces built only from `brushVariableThickness` (now with `peak`) and `brushPetalDot`, both unchanged from [texture_functions.js](../sewingeditor/texture-actions/texture_functions.js). Each piece is its own file, centred at X110 Y110.

| File | What it is | Brushes | Size | Filament |
| --- | --- | --- | --- | --- |
| [tube.gcode](tube.gcode) | **Knit tube.** 40-turn helix, radius 15. One fixed wave setting, 12.5 waves per turn, so each turn's bumps sit between the bumps below and read as knitted stitches. | variable thickness: hMin 0.25, hMax 0.65, width 1.0 | Ø 31 × 18.3 mm | 0.70 m |
| [beehive.gcode](beehive.gcode) | **Herringbone beehive.** A dome, radius 18 → 5 over 36 turns, 9 waves per turn. Even turns lean their waves forward (`peak` 0.25); odd turns print the exact complement (`peak` 0.75, `phase` −0.25). Each pair of turns adds up level while the lean alternates, making chevrons. Waves get taller near the top. | variable thickness: width 1.2, hMin 0.25, hMax 0.6 → 0.8 | Ø 37 × 18.2 mm | 0.51 m |
| [garden.gcode](garden.gcode) | **Spike garden.** A 7 × 7 grid of pillars, 6 mm apart, each a stack of petal dots: 1 at the corners, up to 14 in the middle (a hill). Dots shrink 3.2 → 1.4 mm going up so pillars taper; each drag turns 40° from the one below, so tails twist round the spike. Printed level by level so each dot cools while the others print. | petal dot: height 0.7, drag 0.8 | 36 × 36 × 11.2 mm | 0.38 m |
| [cactus.gcode](cactus.gcode) | **Crowned cactus.** A ribbed column (radius 9, 30 turns, 7.5 waves per turn, 0.3 → 0.9 mm waves), then a crown of 8 tapering petal-dot spikes (5 dots each, dragged outward so the tips flare), then 16 pebble dots on the bed round its foot. | both | Ø 28 × 21.9 mm | 0.56 m |

Extrusion alone takes about 4–7 minutes per piece at the brush's 4 mm³/s, plus travel and lifts. Each file turns the part fan on (`M106 S255`) and off at the end.

## How stacking works

Both brushes write Z as **height above the surface they print on** (a wave rides at Z = its bead height; a dot sits at its height, then drags down to 0). The generator calls the brushes as if printing on the bed, then raises every Z they wrote by what is already printed underneath (`stack()` in [make_3d.mjs](scripts/make_3d.mjs)):

- **Walls** are one continuous helix, never separate layers. A ring of 1440 angle bins records the wall's top. Each wave's base at an angle is the top of the turn below. The ring updates half a turn late so a turn never reads its own fresh bead.
- **Dots** sit on whatever is under them: the bed, the pillar so far, or the wall rim (its highest point under the dot).
- **Travel** always lifts 2 mm above the tallest thing printed so far before crossing.

Rules the pieces follow so the walls grow level:

1. **Every wave spans a fixed angle.** The wavelength is the arc length of 1/waves of a turn at that radius, so waves don't drift round a wall that narrows.
2. **The next turn has to complement the one below.** A symmetric wave at n + 0.5 waves per turn does this: peaks land on troughs and each pair of turns adds up level. An asymmetric `peak` does **not**. A first version of the beehive with `peak` 0.25 on every turn got 0.2 mm more uneven every two turns, about 5 mm by the top. Alternating the wave with its exact complement (`peak` 1 − p, shifted by p) fixes it.
3. **The first turn ramps from 35 % to full height**, so the helix has no step where each turn begins.

[scripts/check_levels.cjs](scripts/check_levels.cjs) checks these on the G-code: the height spread of each turn (tube ~0.6 mm, cactus ~0.85, beehive ~1.0–1.3, all steady, not growing) and the largest Z jump between moves (0.12 / 0.15 / 0.57 mm).

## How the pieces got here

These came out of checking the first versions with [check_levels.cjs](scripts/check_levels.cjs) and the previews.

**An asymmetric `peak` doesn't stack evenly.** Stacking only stays level if each pair of turns adds up to the same height everywhere. For a wave shape f at n + 0.5 waves per turn, that needs f(u) + f(u + ½) to be constant. That's true for the symmetric cosine (`peak` 0.5) and false otherwise.

With `peak` 0.25 the sum swings between 0.75 and 1.25 of (hMax − hMin). The thick spots land on the same angles turn after turn, so the gap keeps growing:

- **Beehive, first version (`peak` 0.25 on every turn):** the spread per turn grew from 0.4 to 5.4 mm.
- **Cactus, first version (`peak` 0.6):** grew slowly, from 0.6 to 1.2 mm over 30 turns. It now uses the symmetric wave.

**The fix that keeps an asymmetric wave is to alternate it with its complement.** The complement of a wave with peak p is the wave with peak 1 − p, shifted by −p of a wave. It is 1 − f, so its trough sits under the original's crest. A wave and its complement add up to exactly hMin + hMax at every angle. The beehive alternates them turn by turn, with 9 waves per turn, so each turn's waves line up on the turn below. The alternating lean is what makes the herringbone.

**Waves are tied to angles, not to radius.** At first, each wave's wavelength came from the radius where it started, as 2πr / waves. On the narrowing beehive the radius shrinks while a wave is printed, so each wave covered a little more angle than intended. The waves crept round the wall, and after enough turns crests stacked on crests. Each wave now covers exactly 1/waves of a turn, measured along the actual path.

**The first turn ramps up.** A helix that starts flat on the bed has a step where every turn begins, about one bead height, at the same angle all the way up. The first tube used the stock `strokeVariableThickness` with fixed settings, which can't vary height by turn. It had a 0.28 mm jump at that point, which showed as a diagonal streak in the preview. All three walls now go through `helixWall()`, which scales the first turn from 35 % to full height. The tube's largest jump is now 0.12 mm.

**Dots on the wall rim sit on the highest point under them.** The rim is wavy, so each crown dot takes the maximum of the ring over its width (16 bins, ±4°). That way the nozzle never comes down into the bead.

**Travel lifts above everything.** A brush's own hop is only 0.4 mm above its own mark, which isn't enough to clear a 20 mm wall or a taller pillar nearby. Before every dot, the nozzle rises 2 mm above the tallest point printed so far, then comes down.

**The preview isn't the print.** The pale vertical stripe at the front of the tube and cactus previews comes from the order the renderer draws in. It isn't in the G-code.

## Expect

- **Dot stacks rely on each blob coming out about as tall as asked (0.7 mm).** If blobs come out shorter, the nozzle climbs ahead of the material and the upper dots get stringy. Print the garden first to see whether stacking works. If it doesn't, lower `H` in `garden()`.
- **Crown spikes overhang the 1.2 mm rim** (first dot 2.6 mm wide); the fan matters there.
- **No bottoms.** The tube, beehive and cactus are open shells.
- **The files don't heat or home the printer**, like the earlier sheets. Heat and home first. The fan is switched on in the file.
- **Comments in the G-code** record the brush settings: one line before each wall and before each crown or garden level.

## Files

- [scripts/make_3d.mjs](scripts/make_3d.mjs): the generator, one function per piece. Regenerate with `node scripts/make_3d.mjs ../sewingeditor/texture-actions/texture_functions.js <tube|beehive|garden|cactus> <piece>.gcode`. Output is byte-for-byte reproducible. It writes `scripts/tf_copy.mjs`, a copy of the library with the two brushes exported.
- [scripts/check_levels.cjs](scripts/check_levels.cjs): `node scripts/check_levels.cjs tube.gcode beehive.gcode cactus.gcode` prints, for each wall, the height spread every 5 turns and the largest Z jump between moves. If the spread keeps growing turn after turn, the wall is going uneven.
- [scripts/plot_3d.mjs](scripts/plot_3d.mjs): the 3D preview. `node scripts/plot_3d.mjs <in.gcode> <out.png> [pixels] [elevationDeg]`. It rebuilds each bead's height and width from the G-code against a 0.2 mm height field and draws from the front, 32° up, coloured by height.
- [previews/](previews/): `tube.png`, `beehive.png`, `garden.png`, `cactus.png`.
