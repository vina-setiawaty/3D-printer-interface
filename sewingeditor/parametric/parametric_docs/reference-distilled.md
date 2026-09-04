# Reference — machine, path math, call menu, constraints (distilled)

Everything you need to pick calls/options and to numerically verify your
own planned geometry. Distilled from `hardware.md`, `path-spec.md`,
`catalog.md`, and `PARAMETER_CONSTRAINTS.md` — those stay the full
reference for the base parametric page; this is the trimmed version for
this page only.

## Machine & material

| | |
|---|---|
| Bed | 220 × 220 mm — safe area X/Y **15–205** |
| Extrusion | relative (`M83`) — positioning absolute (`G90`) |
| Layer height | 0.20 mm |
| Relief-height floor | 0.40 mm (2 layers) — anything shorter isn't reliably felt |
| Default bead width | 0.5 mm |
| Filament diameter | 1.75 mm |

**TPU is the default material** — assume it unless the user names PLA; never mix defaults from the two.

| | TPU (default) | PLA |
|---|---|---|
| Nozzle / bed temp | 220 °C / 50 °C | 205 °C / 60 °C |
| Flow (`M221`) | 180% | 100% |
| Default retraction | 1.3 mm @ 900 mm/min | 1.3 mm @ 1500–2400 mm/min |
| Print speed | 100–600 mm/min | 600–1500 mm/min |

The page wraps every job in its own start/end sequence (heat, home, prime line, retract at start; retract, lift, cooldown at end). **Never emit heating, homing, priming, or a cooldown call yourself.**

## Path spec — how a line/curve is described

A path is a genuine parametric formula: `{"x": "<expr in t>", "y": "<expr in t>", "tEnd": <number>}` — `x(t)` and `y(t)` evaluated over `t ∈ [0, tEnd]`. A line-style call puts its spec in `geometry.path`; a fill can use the same shape in `geometry.boundary` (see Fills below) as an alternative to a rectangle; dots use `geometry.at`.

**Expression syntax**: `+ - * /` and `^` (power), unary minus, parentheses, the variable `t`, the constant `pi`, and these functions only: `sin cos tan sqrt abs exp log` (1 argument), `min max pow` (2 arguments). No other identifier or function name is recognized — using one is a hard error, not a silent no-op. Example: a 30mm-radius circle centered at (110,110) is `{"x": "110 + 30*cos(t)", "y": "110 + 30*sin(t)", "tEnd": 6.283185}`.

**A single formula is one smooth curve — it cannot have a sharp corner** (that's non-differentiable). A multi-segment stroke with real corners (a rectangle border, an L-shape, a zigzag) needs **one line call per straight or curved run**, not one call for the whole shape.

`t` does not have to be arc length — the page re-parameterises whatever curve you give it by real arc length internally, so `gap`/`segLen`/dot spacing etc. always mean real millimetres regardless of how "fast" your formula's `t` moves. A formula that's too steep to print at any sampling resolution (e.g. an extremely tight spiral) is rejected — soften the shape, never retry blindly. Every point the curve visits must stay inside **X/Y 15–205**.

## Call menu

A graphic is an ordered list of **calls**. `options` values you omit use the default shown. All lengths are mm, angles degrees CCW from +X, speeds mm/min, times ms. **Call order matters**: put an outline/frame call before the fill or texture it surrounds.

**Shared BLOB BUILD OPTIONS** (used by every blob/hairy dot and dotted-line style below — listed once, referenced by name): `baseZ` (0.2), `buildSteps` (6), `taperFactor` (0.7), `extrudeSpeed` (120), `dwellMs` (2000), `extrusionMultiplier` (1.3), `retractMm` (4.0), `postRetractDwellMs` (2000), `baseExtraMm` (0.3), `baseDwellMs` (1000).

**Shared ORBIT OPTIONS** (blob dot / blob-dotted line only): `orbitRadius` (`null` → the dot's own radius; `0` disables), `orbitPts` (16), `orbitSpeed` (600), `orbitLoops` (3).

### Lines — `fn(em, xFunc, yFunc, tStart, tEnd, options)`, you supply `geometry.path` + `options`

| `fn` | Makes | Options beyond the shared ones above |
|---|---|---|
| `freeformSolid` | continuous ridge | `width` (0.5), `nLayers` (2), `speed` (400) |
| `freeformDashed` | dashes (arc-length measured) | **`segLen` (required)**, **`gapLen` (required)**, `width` (0.5), `nLayers` (2), `speed` (400) |
| `freeformDotted` | flat spiral discs along the path | `gap` (10), `dotRadius` (0.8), `nLayers` (2), `speed` (250) |
| `freeformBlobDotted` — **default dotted style** | domed blob dots along the path | `gap` (10), `diameter` (1.6) + BLOB BUILD + ORBIT |
| `freeformDirectionalBlobDotted` | leaning blob dots, each raking along the local path tangent | `gap` (`null`→one `diameter`), `diameter` (2.0), `azimuthDeg` (0 — **offset** from the local tangent), `dragSpeed` (600), `stampOrder` (`auto`\|`forward`\|`reverse`) + BLOB BUILD |
| `freeformHairy` | vertical hair strands, simple point-stamped | `spacing` (5.0), `esegmentMm` (1.2), `retractMm` (1.3), `dwellMs` (400), `smallLift` (0.2), `bigLift` (4.0), `baseZ` (0.3), `speed` (200) — **highest retraction-cycle count: one per strand** |
| `freeformHairyDotted` | anchored hairy dots (root dome + one pulled strand each) | `gap` (10), `rootDiameter` (2.0), `hairLength` (prefer **3**, not the 10.0 default), `hairThickness` (`null`→derived), `hairDirection` (`top`\|`right`\|`left`\|`bottom`), `hairAzimuthDeg`/`hairElevationDeg` (`null`; elevation 0=flat, 90=up), `beadFlowMult` (3.5), `pullExtrudeSpeed` (150), `stringMm` (2.0), `overtravelMm` (2.0), `stampOrder` (`auto`) + BLOB BUILD — **one retract per dot** |
| `freeformSegmented` | alternating thin/fat bead segments | `thinLen` (8), `thinWidth` (0.8), `thinHeight` (0.2), `thinSpeed` (130), `fatLen` (4), `fatWidth` (1.6), `fatHeight` (0.3), `fatSpeed` (60), `flowMult` (1.4), `segDwellMs` (250) |
| `freeformVariableThickness` | ridge that swells/thins sinusoidally | `hMin` (0.16), `hMax` (0.9), `wavelength` (8.0), `beadWidth` (0.8), `zGap` (0.25 — **do not lower**), `speed` (25) |

### Standalone dots — `geometry.at = [cx, cy]`

| `fn` | Makes | Options beyond the shared ones above |
|---|---|---|
| `blobDot` — **default dot** | small extruded dome, hardware-confirmed | `diameter` (1.6) + BLOB BUILD + ORBIT |
| `circularDot` | flat precise disc — use when `diameter`/`height` must be independent | `diameter` (1.6), `height` (0.4, rounded to 0.2mm steps, floor 0.4), `speed` (250) — no hollow-centre option |
| `directionalBlobDot` | leaning dome | `diameter` (2.0), `azimuthDeg` (0 — **absolute compass heading**, unlike the path-following line version), `dragSpeed` (600) + BLOB BUILD — nonzero azimuth not yet hardware-verified |
| `hairyDot` | dome + one pulled strand | `rootDiameter` (2.0), `hairLength` (prefer **3**), `hairThickness` (`null`), `hairDirection` (`top`), `hairAzimuthDeg`/`hairElevationDeg` (`null`), `beadFlowMult` (3.5), `pullExtrudeSpeed` (150), `stringMm` (2.0), `overtravelMm` (2.0) + BLOB BUILD — one retract |

### Area fills — `geometry.region = {x0,y0,w,h}` OR `geometry.boundary = {x,y,tEnd}`, plus `geometry.fillStyle`

A fill region is **either** an axis-aligned rectangle (`geometry.region`) **or** a closed parametric boundary (`geometry.boundary`, same `{x,y,tEnd}` formula shape as a line path — the model must make it close: `(x(tEnd),y(tEnd)) ≈ (x(0),y(0))`). Use `boundary` for a non-rectangular area (a circle, a rounded blob); use `region` for a plain rectangle — it's simpler and it's the only option `DIAMOND` accepts.

`fillStyle` is one of `freeformSolid`, `freeformDashed`, `freeformDotted`, `freeformBlobDotted`, `freeformHairy`, or `DIAMOND`. For every style except `DIAMOND`, `options` may include `angleDeg` (0) and `gap`, plus that style's own line options above — this applies the same way to both `region` and `boundary`.

- Solid sheet: `fillStyle:"freeformSolid"`, `gap` ≈ 0.45 (passes fuse).
- Line-shade: `fillStyle:"freeformSolid"`, any `angleDeg`, `gap` ≈ 4.
- Dashed/dotted/hairy shade: swap `fillStyle`, supply its options.
- `DIAMOND` (checkerboard, special case): **requires `geometry.region`** (a rectangle) — `geometry.boundary` is a hard error with this style. `options: {diag:8.0, fillGap:0.6}`; `angleDeg`/`gap` ignored. **Never** emulate with two angled line passes — the filled-cell selection is a discrete checkerboard parity no `gap` reproduces. Always `fn:"fill", fillStyle:"DIAMOND"`.
- `geometry.boundary` fill is restricted to a **simple, non-self-intersecting, single-contour** shape (no holes, no crossing itself) — behavior is undefined otherwise.

### Verification the page always runs after generation

1. Bed bounds — every emitted X/Y within 15–205.
2. Layout — bounding-box overlap between calls is a hard error.
3. Net extrusion never dips sharply negative (retraction-math bug tripwire).
4. Checkerboard adjacency after any `DIAMOND` fill.
5. Too-steep paths throw — fix with a gentler shape, not a blind retry.

## Constraints — respect these when choosing numbers; flag it in `chat` if the user insists on something outside them

*(Values below are placeholders pending hardware confirmation — reasoned from function defaults and TPU cautions, not yet print-tested. If a hard rule blocks something the user clearly wants, say so rather than silently complying or refusing.)*

| Rule | Applies to | Value | Kind |
|---|---|---|---|
| Min dome diameter | blob/hairy dots and dotted lines' diameter/rootDiameter | 0.8 mm | hard |
| Min disc diameter | `circularDot`, `freeformDotted` (`2×dotRadius`) | 0.8 mm | hard |
| Min disc height | `circularDot` | 0.4 mm | hard |
| Min relief (layers) | any line style's `nLayers` | 2 (0.4mm) | hard |
| Min bead width | any `width`/`beadWidth`/`thinWidth` | 0.4 mm | warn |
| Min gap, blob-dotted line | `freeformBlobDotted.gap` | `diameter + 1.0mm` | warn |
| Min gap, directional blob-dotted line | `freeformDirectionalBlobDotted.gap` | `diameter` | warn |
| Min gap, hairy-dotted line | `freeformHairyDotted.gap` | `rootDiameter + 2.0mm` | warn |
| Min strand spacing, hairy line | `freeformHairy.spacing` | 2.5 mm | warn |
| Min gap, dotted line | `freeformDotted.gap` | `2×dotRadius + 1.0mm` | warn |
| Min row gap, hairy fill | `fill`+`freeformHairy` `gap` | 4.0 mm | warn |
| Min pass gap, solid sheet fill | `fill`+`freeformSolid` `gap` | 0.35 mm | hard |
| Min separation, any two calls' bounding boxes | all calls | 0.5 mm (overlap always hard) | hard/warn |
| Max gap, any dotted line | dotted/blob/directional-blob line `gap` | `4× diameter` (or `4×2·dotRadius`) | warn |
| Max gap, hairy-dotted line | `freeformHairyDotted.gap` | `4× rootDiameter` | warn |
| Max `gapLen`, dashed line | `freeformDashed.gapLen` | `3× segLen` | warn |
| Max strand spacing, hairy line | `freeformHairy.spacing` | 12 mm | warn |
| Max pass gap, line-shade fill | `fill`+`freeformSolid` (non-sheet) `gap` | 8 mm | warn |
| Max row gap, dotted/dashed/blob/hairy fill | `fill`+those styles `gap` | 12 mm | warn |
| Min dash length / gap | `freeformDashed.segLen`/`gapLen` | 2.0 mm each | warn |
| Min segment length | `freeformSegmented.thinLen`/`fatLen` | 3.0 mm | warn |
| `zGap` floor | `freeformVariableThickness.zGap` | 0.25 mm | hard |
| Retraction cycles per job | whole job | warn at 250, hard at 2000 | warn/hard |
| Min diamond diagonal | `DIAMOND.diag` | 4.0 mm | warn |
| Min diamond fill-scanline gap | `DIAMOND.fillGap` | 0.35 mm | hard |
| Outline before its fill | a line call surrounding a fill region | must come first in the call list | warn |
