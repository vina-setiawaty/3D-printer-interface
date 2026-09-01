# Texture catalog — the functions you may compose

Ground truth is `parametric_docs/texture_functions.js` (a pinned copy). This
file is the menu: which functions exist, what each one makes, and which
options you may set. **Never invent geometry a function already produces,
and never write raw G-code** — your job is to pick functions and set their
numbers.

A graphic is an ordered list of **calls**. Each call is one of:

| call type | `fn` | geometry field | makes |
|---|---|---|---|
| line style | one of the nine `freeform*` names | `geometry.path` (see `path-spec.md`) | a stroke / curve with a texture |
| standalone dot | `blobDot`, `circularDot`, `directionalBlobDot`, `hairyDot` | `geometry.at` = `[cx, cy]` | one tactile bump |
| area fill | `fill` | `geometry.region` = `{x0,y0,w,h}` + `geometry.fillStyle` | a filled/hatched rectangle |

`options` is a JSON object of `name: value` pairs — only the names listed
for that function below. Anything you omit uses the default shown. All
lengths are millimetres, angles degrees CCW from +X, speeds mm/min, times
milliseconds.

**Enforced limits (minimum *and maximum* gaps, minimum diameters,
retraction-count caps, call ordering, …) live in
`PARAMETER_CONSTRAINTS.md`.** The page validates every call against that
file and will warn or clamp. Respect those limits when you choose numbers;
if the user asks for something outside them, say so.

**Call order matters:** put an outline / frame call *before* the fill or
texture it surrounds, so the fill prints inside a defined border. The page
flags a surrounding line that comes after its fill.

---

## Lines

All line styles share the signature
`fn(em, xFunc, yFunc, tStart, tEnd, options)` — you only supply
`geometry.path` and `options`.

### `freeformSolid` — continuous ridge
A smooth raised line. Options: `width` (0.5), `nLayers` (2 → 0.4 mm tall),
`speed` (400).

### `freeformDashed` — dashes
Options: **`segLen` (required)**, **`gapLen` (required)**, `width` (0.5),
`nLayers` (2), `speed` (400). Lengths are along the path's real arc length.

### `freeformDotted` — flat spiral discs along a path
Options: `gap` (10), `dotRadius` (0.8), `nLayers` (2), `speed` (250).

### `freeformBlobDotted` — domed blob dots along a path *(default dotted style)*
Point-extruded domes stamped every `gap`. Prefer this over
`freeformDotted` unless a flat disc is specifically wanted. Options:
`gap` (10), `diameter` (1.6), plus the blob-dot shaping options — see
**`blobDot`** below (same names, same defaults: `baseZ`, `buildSteps`,
`taperFactor`, `extrudeSpeed`, `dwellMs`, `extrusionMultiplier`,
`retractMm`, `postRetractDwellMs`, `baseExtraMm`, `baseDwellMs`,
`orbitRadius`, `orbitPts`, `orbitSpeed`, `orbitLoops`).

### `freeformDirectionalBlobDotted` — leaning blob dots along a path
Each dot leans along the path tangent (curved path → each blob rakes
"downstream"). Options: `gap` (`null` → one `diameter`), `diameter` (2.0),
`azimuthDeg` (0 — an **offset** from the local tangent here), `dragSpeed`
(600), `stampOrder` (`"auto"` | `"forward"` | `"reverse"`), plus the shared
blob build options (`baseZ`, `buildSteps`, `taperFactor`, `extrudeSpeed`,
`dwellMs`, `extrusionMultiplier`, `retractMm`, `postRetractDwellMs`,
`baseExtraMm`, `baseDwellMs`).

### `freeformHairy` — vertical hair strands along a path
Simple point-stamped strands, pulled straight up. **Highest
retraction-cycle count in the library — one retract per strand.** Options:
`spacing` (5.0), `esegmentMm` (1.2), `retractMm` (1.3), `dwellMs` (400),
`smallLift` (0.2), `bigLift` (4.0), `baseZ` (0.3), `speed` (200).

### `freeformHairyDotted` — anchored hairy dots along a path
Each stamp is a root dome plus one pulled strand, with independent
thickness / length / direction. One retract per dot. Options: `gap` (10),
`rootDiameter` (2.0), `hairLength` (10.0 — **see note**), `hairThickness`
(`null` → derived from length), `hairDirection` (`"top"` | `"right"` |
`"left"` | `"bottom"`), `hairAzimuthDeg` (`null`), `hairElevationDeg`
(`null`; 0 = flat, 90 = up), `beadFlowMult` (3.5), `pullExtrudeSpeed`
(150), `stringMm` (2.0), `overtravelMm` (2.0), `stampOrder` (`"auto"`),
plus the shared blob build options. *Note: the 10 mm `hairLength` default
predates recent tuning — recent tests use `hairLength` 3 / `hairThickness`
0.8. Prefer those unless the user asks for a long strand.*

### `freeformSegmented` — alternating thin/fat segments
A continuous line that alternates two bead types, each with its own
length / width / height / speed. Options: `thinLen` (8), `thinWidth`
(0.8), `thinHeight` (0.2), `thinSpeed` (130), `fatLen` (4), `fatWidth`
(1.6), `fatHeight` (0.3), `fatSpeed` (60), `flowMult` (1.4), `segDwellMs`
(250).

### `freeformVariableThickness` — a ridge that swells and thins
Bead height follows a sine along the path. Options: `hMin` (0.16), `hMax`
(0.9), `wavelength` (8.0), `beadWidth` (0.8), `zGap` (0.25 — do not lower),
`speed` (25).

---

## Standalone dots — `geometry.at = [cx, cy]`

### `blobDot` — the default dot *(v17, hardware-confirmed best)*
A small dome built by extruding while rising in Z, then a single orbit at
dome height to catch stringing. `diameter` is the one sizing knob;
filament volume is derived from it. Options: `diameter` (1.6), `baseZ`
(0.2), `buildSteps` (6), `taperFactor` (0.7), `extrudeSpeed` (120),
`dwellMs` (2000), `extrusionMultiplier` (1.3), `retractMm` (4.0),
`postRetractDwellMs` (2000), `baseExtraMm` (0.3), `baseDwellMs` (1000),
`orbitRadius` (`null` → dot radius; `0` disables the orbit), `orbitPts`
(16), `orbitSpeed` (600), `orbitLoops` (3).

### `circularDot` — a flat precise disc
Use when `diameter` and `height` must be set independently. Options:
`diameter` (1.6), `height` (0.4 — rounded to a 0.2 mm multiple, floor
0.4), `speed` (250). No hollow-centre ("donut") option exists.

### `directionalBlobDot` — a leaning dome *(v3, hardware-confirmed at az 0)*
A `blobDot` sheared so it leans, then squished and dragged against the
lean. Options: `diameter` (2.0), `azimuthDeg` (0 — absolute compass
heading for a lone dot), `dragSpeed` (600), plus the shared blob build
options. Nonzero azimuth is not yet hardware-verified.

### `hairyDot` — a dome with one pulled strand
Options: `rootDiameter` (2.0), `hairLength` (10.0 — prefer 3), `hairThickness`
(`null` → derived), `hairDirection` (`"top"`), `hairAzimuthDeg` (`null`),
`hairElevationDeg` (`null`), `beadFlowMult` (3.5), `pullExtrudeSpeed`
(150), `stringMm` (2.0), `overtravelMm` (2.0), plus the shared blob build
options. One retract per dot.

---

## Area fills — `geometry.region = {x0,y0,w,h}`, `geometry.fillStyle`

Only an **axis-aligned rectangle** is supported for `region`. No polygon
or circle regions.

`fillStyle` is one of: `"freeformSolid"`, `"freeformDashed"`,
`"freeformDotted"`, `"freeformBlobDotted"`, `"freeformHairy"`, or
`"DIAMOND"`.

For every style except `DIAMOND`, `options` may include `angleDeg` (0) and
`gap` (spacing between passes), plus that style's own options from the
Lines section (e.g. a dashed fill needs `segLen` + `gapLen`).

- **Solid sheet:** `fillStyle: "freeformSolid"`, `gap` ≈ 0.45 (passes fuse).
- **Line-shade:** `fillStyle: "freeformSolid"`, `angleDeg` any, `gap` ≈ 4.
- **Dashed / dotted / hairy shade:** swap `fillStyle`; supply that style's
  options. Hairy fill is the highest retraction-count texture here — check
  `PARAMETER_CONSTRAINTS.md`.

### `DIAMOND` — checkerboard diamond fill *(special case)*
`fillStyle: "DIAMOND"`, options `diag` (8.0, corner-to-corner) and
`fillGap` (0.6). `angleDeg`/`gap` are ignored. **Never** emulate this with
two angled line passes — the filled-cell selection is a discrete
checkerboard parity that no `gap` value reproduces, and it is the most
bug-prone pattern in this project's history. Always use `fn: "fill"`,
`fillStyle: "DIAMOND"`. The page verifies the checkerboard adjacency after
generating and will report any violation.

---

## Verification the page always runs

1. **Bed bounds** — every emitted X/Y within 15–205 mm.
2. **Layout** — `verifyLayout()` over a bounding box per call; overlaps are
   hard errors.
3. **Net extrusion** — the running sum of `E` deltas never dips
   sharply negative (a sign of a retraction-math bug).
4. **Checkerboard** — `verifyCheckerboard()` after any `DIAMOND` fill.
5. **Too-steep paths** — `samplePath()` throws `PathTooSteepError`; the
   page surfaces which call failed. The fix is a gentler shape
   (smaller amplitude, larger radius/wavelength), never a blind retry.
