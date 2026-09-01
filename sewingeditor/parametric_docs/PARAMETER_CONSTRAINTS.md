# Parameter constraints — FILL-IN FORM

> **This file is a form. Edit the `Value` and `Status` columns and send it
> back.** Every number below is a **PLACEHOLDER** — my best guess from the
> function defaults and the TPU cautions in `../texture_docs/`, not a
> hardware-tested limit. Nothing here has been printed to confirm it.
>
> How to use it:
> 1. Change any `Value` you know is wrong.
> 2. Set `Status` to `confirmed` once you've verified a row on a print,
>    or leave it `placeholder`.
> 3. Add rows if something is missing; delete rows that don't matter.
> 4. Send the edited file back — I'll transcribe it into
>    `parametric-catalog.js`, which is what the page actually enforces.
>
> The page treats a **hard** rule as a blocking error (won't show the
> G-code as safe) and a **warn** rule as a yellow notice you can override.

---

## 1. Minimum feature size

| Rule | Applies to | Value (PLACEHOLDER) | Kind | Status | Notes |
|---|---|---|---|---|---|
| Min dome diameter | `blobDot`, `freeformBlobDotted`, `directionalBlobDot`, `freeformDirectionalBlobDotted`, `hairyDot` root, `freeformHairyDotted` root | **0.8 mm** | hard | placeholder | Below this the dome doesn't clear the 0.4 mm relief floor |
| Min disc diameter | `circularDot`, `freeformDotted` (`2×dotRadius`) | **0.8 mm** | hard | placeholder | |
| Min disc height | `circularDot` | **0.4 mm** | hard | placeholder | 2 layers; already floored in code |
| Min relief (layers) | all line styles `nLayers` | **2** (0.4 mm) | hard | placeholder | |
| Min bead width | any `width` / `beadWidth` / `thinWidth` | **0.4 mm** | warn | placeholder | ~one nozzle width |

## 2. Minimum spacing (so features stay separable by touch / don't fuse)

| Rule | Applies to | Value (PLACEHOLDER) | Kind | Status | Notes |
|---|---|---|---|---|---|
| Min gap, blob-dotted line | `freeformBlobDotted.gap` | **`diameter + 1.0 mm`** | warn | placeholder | Closer than this and adjacent domes fuse into a ridge |
| Min gap, directional blob-dotted line | `freeformDirectionalBlobDotted.gap` | **`diameter` (touching, by design)** | warn | placeholder | Default is one diameter; below that the drags overlap heavily |
| Min gap, hairy-dotted line | `freeformHairyDotted.gap` | **`rootDiameter + 2.0 mm`** | warn | placeholder | Also see retraction-count cap below |
| Min strand spacing, hairy line | `freeformHairy.spacing` | **2.5 mm** | warn | placeholder | |
| Min gap, dotted line | `freeformDotted.gap` | **`2×dotRadius + 1.0 mm`** | warn | placeholder | |
| Min row gap, hairy fill | `fill` + `freeformHairy` `gap` | **4.0 mm** | warn | placeholder | |
| Min pass gap, solid sheet fill | `fill` + `freeformSolid` `gap` | **0.35 mm** | hard | placeholder | Below this = massive over-extrusion |
| Min separation between calls | any two calls' bounding boxes | **0.5 mm** | hard (overlap) / warn (< value) | confirmed | `verifyLayout()` default; overlap always hard |

## 2b. Maximum spacing (beyond this a "line" reads as scattered dots, or a "fill" as spaced lines)

All **warn** — a sparse layout may be intentional.

| Rule | Applies to | Value (PLACEHOLDER) | Status | Notes |
|---|---|---|---|---|
| Max gap, any dotted line | `freeformDotted` / `freeformBlobDotted` / `freeformDirectionalBlobDotted` `gap` | **`4 × diameter`** (`4 × 2·dotRadius` for `freeformDotted`) | placeholder | Above this it stops reading as a connected line |
| Max gap, hairy-dotted line | `freeformHairyDotted.gap` | **`4 × rootDiameter`** | placeholder | |
| Max `gapLen`, dashed line | `freeformDashed.gapLen` | **`3 × segLen`** | placeholder | Above this it reads as isolated dashes |
| Max strand spacing, hairy line | `freeformHairy.spacing` | **12 mm** | placeholder | |
| Max pass gap, line-shade fill | `fill` + `freeformSolid` (non-sheet) `gap` | **8 mm** | placeholder | Above this the area no longer reads as shaded |
| Max row gap, dotted / dashed / blob / hairy fill | `fill` + those styles `gap` | **12 mm** | placeholder | Above this it reads as separate rows, not a filled patch |

## 3. Dashes / segments

| Rule | Applies to | Value (PLACEHOLDER) | Kind | Status | Notes |
|---|---|---|---|---|---|
| Min dash length | `freeformDashed.segLen` | **2.0 mm** | warn | placeholder | |
| Min dash gap | `freeformDashed.gapLen` | **2.0 mm** | warn | placeholder | |
| Min segment length | `freeformSegmented.thinLen` / `fatLen` | **3.0 mm** | warn | placeholder | |
| `zGap` floor | `freeformVariableThickness.zGap` | **0.25 mm** | hard | placeholder | User-validated; do not lower |

## 4. Curves — printability

| Rule | Applies to | Value (PLACEHOLDER) | Kind | Status | Notes |
|---|---|---|---|---|---|
| Min arc radius | `path.kind = "arc"` | **`3 × bead width`** (≈1.5 mm at default) | warn | placeholder | `samplePath()` throws below the true limit regardless |
| Max sine amplitude vs wavelength | `path.kind = "sine"` | **`amplitude ≤ 0.15 × wavelength`** | warn | placeholder | Steeper is rejected by `samplePath()` |
| Min sine wavelength | `path.kind = "sine"` | **4.0 mm** | warn | placeholder | |

## 5. Retraction-cycle cap (TPU filament damage)

TPU can be permanently flat-spotted by too many retraction cycles in one
job. `freeformHairy`, `freeformHairyDotted`, hairy fill, and every
dot-per-stamp line do one retract per stamp.

| Rule | Value (PLACEHOLDER) | Kind | Status | Notes |
|---|---|---|---|---|
| Total retraction cycles per job — warn | **250** | warn | placeholder | Surface the count to the user |
| Total retraction cycles per job — hard | **2000** | hard | placeholder | Refuse to mark safe above this. Set high on purpose — a diamond fill alone does hundreds of tiny in-place retracts |

## 6. Diamond fill

| Rule | Applies to | Value (PLACEHOLDER) | Kind | Status | Notes |
|---|---|---|---|---|---|
| Min diagonal | `DIAMOND.diag` | **4.0 mm** | warn | placeholder | Smaller diamonds stop reading as distinct cells |
| Min fill scanline gap | `DIAMOND.fillGap` | **0.35 mm** | hard | placeholder | |

## 7b. Call ordering

| Rule | Value | Kind | Status | Notes |
|---|---|---|---|---|
| Outline / frame before its fill | a line call that surrounds a fill region must come **before** that fill in the call list | warn | placeholder | So the fill prints inside an already-defined border and lift-off ooze lands on the frame, not bare bed. The page flags a surrounding line drawn after its fill. |

## 7. Fixed (not tunable here — listed for reference)

| | Value | Where |
|---|---|---|
| Bed size | 220 × 220 mm | `texture_functions.js` `BED_X/Y` |
| Safe margin | 15 mm | `verifyLayout()` `bedMargin` |
| Layer height | 0.20 mm | `LAYER_HEIGHT` |
| Nozzle / bed temp (TPU) | 220 / 50 °C | `em.header()` |
| Default retraction | 1.3 mm @ 900 mm/min | `RETRACT_MM` / `RETRACT_SPEED` |
