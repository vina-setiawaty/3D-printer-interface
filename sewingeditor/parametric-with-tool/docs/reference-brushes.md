# Brushes, stamps and fill patterns

Every texture is **what happens between two points**. A line element, a
region outline, and each stroke of a fill pattern is a point list that a
**brush** walks; a point element and each position of a stamp pattern is
where a **stamp** is deposited. Options in mm, degrees CCW from +X,
mm/min, ms. Defaults apply for anything omitted.

## Line brushes — `slot: brush` (line), `outline` (region), `fill` with a stroke pattern

| name | makes | key options (default) |
|---|---|---|
| `solid` | continuous ridge | `width` (0.5), `nLayers` (2), `speed` (400) |
| `dashed` | dashes measured along arc length | `segLen` (8), `gapLen` (4), `width`, `nLayers`, `speed` |
| `dotted` | flat spiral discs along the path | `gap` (10), `dotRadius` (0.8), `nLayers`, `speed` (250) |
| `blobDotted` — **default dotted** | domed blob dots along the path | `gap` (10), `diameter` (1.6) + blob build + orbit options |
| `directionalBlobDotted` | leaning domes raking along the local tangent | `gap` (= diameter), `diameter` (2.0), `azimuthDeg` (0, offset from the tangent), `dragSpeed`, `stampOrder` |
| `hairy` | vertical strands pulled up along the path | `spacing` (5), `bigLift` (4), `esegmentMm` (1.2), `smallLift`, `dwellMs`, `baseZ`, `speed` — one retraction per strand |
| `hairyDotted` | anchored hairy dots (root dome + one pulled strand) | `gap` (10), `rootDiameter` (2), `hairLength` (3), `hairDirection` (`top`\|`right`\|`left`\|`bottom`), `hairAzimuthDeg`/`hairElevationDeg`, `beadFlowMult`, `pullExtrudeSpeed` — one retraction per dot |
| `segmented` | alternating thin/fat bead segments | `thinLen` (8), `thinWidth` (0.8), `fatLen` (4), `fatWidth` (1.6), heights, speeds, `flowMult` |
| `variableThickness` | ridge that swells and thins sinusoidally | `hMin` (0.16), `hMax` (0.9), `wavelength` (8), `beadWidth` (0.8), `zGap` (0.25, never lower) |

**Blob build options** (every blob / hairy dome): `baseZ` 0.2, `buildSteps` 6,
`taperFactor` 0.7, `extrudeSpeed` 120, `dwellMs` 2000, `extrusionMultiplier` 1.3,
`retractMm` 4.0, `postRetractDwellMs` 2000, `baseExtraMm` 0.3, `baseDwellMs` 1000.
**Orbit options** (blob only): `orbitRadius` (null = dome radius, 0 = off),
`orbitPts` 16, `orbitSpeed` 600, `orbitLoops` 3.

## Stamps — `slot: brush` (point), `fill` with a stamp pattern

| name | makes | key options |
|---|---|---|
| `blob` — **default dot** | small extruded dome | `diameter` (1.6) + blob build + orbit |
| `disc` | flat precise disc, diameter and height independent | `diameter` (1.6), `height` (0.4, steps of 0.2), `speed` (250) |
| `directionalBlob` | leaning dome | `diameter` (2.0), `azimuthDeg` (absolute heading), `dragSpeed` |
| `hairyDot` | dome + one pulled strand | `rootDiameter` (2), `hairLength` (3), `hairDirection`, … as hairyDotted |

## Fill patterns — `slot: fill` on a region, `pattern` JSON

A pattern says **where** the texture goes inside the region; the page clips
everything to the boundary and transforms it with the graphic. Any pattern
whose coordinates you write yourself is in the graphic's own coordinates.

| kind | spec | brush type |
|---|---|---|
| `hatch` | `{"kind": "hatch", "angleDeg": 0, "gap": 4}` parallel strokes, recomputed from the region | line brush |
| `grid` | `{"kind": "grid", "dx": 6, "dy": 6, "angleDeg": 0}` stamp lattice | stamp |
| `diamond` | `{"kind": "diamond", "diag": 8, "fillGap": 0.6}` lattice + checkerboard-filled cells; **rectangular region only**; always this kind, never two angled hatches | `solid` |
| `stamps` | `{"kind": "stamps", "points": [[x, y], ...]}` explicit stamp positions | stamp |
| `strokes` | `{"kind": "strokes", "strokes": [[[x, y], [x, y], ...], ...]}` explicit polylines, corners allowed | line brush |
| `curves` | `{"kind": "curves", "curves": [{"x": ..., "y": ..., "tEnd": n}, ...]}` a collection of formula strokes | line brush |
| `family` | `{"kind": "family", "x": "<expr in t,u>", "y": "<expr in t,u>", "tEnd": n, "uEnd": n, "uStep": n}` one stroke per `u` — radial (`x: cx + t*cos(u)`), concentric (`x: cx + u*cos(t)`), wavy hatch, … | line brush |

Guidance: a solid sheet is `hatch` + `solid` with `gap` ≈ 0.45; line
shading is `hatch` + `solid` with `gap` 3–6; dotted/hairy shading is
`hatch` + that brush with `gap` 6–10, or `grid`/`stamps` + a stamp.
Pattern spacing scales with the graphic; brush mm values do not.

<!-- The enforced limits and the tactile-legibility guidance used to be
hand-copied tables here. They are now GENERATED from `PRINT_LIMITS` /
`GEOMETRY_LIMITS` / `LEGIBILITY_GUIDE` in `../parametric-catalog-with-tool.js`
(`limitsText()` / `legibilityText()`) and appended to this file by
`systemPromptFor()`, so the prompt cannot drift from what the code checks.
`docs/PARAMETER_CONSTRAINTS.md` is the fill-in form generated from the same
objects. To change a limit, change it in the catalog. -->

