# PLA full-catalog calibration sheet — swatch map

Companion to `20260925-172719_pla-full-catalog-calibration-sheet.gcode`.
One bed, one print: every named texture in `texture_functions.js` (18
distinct entries per `texture_patterns.md`'s own catalog — 4 dots, 9
lines, 5 fills), 3 parameter tiers each = **54 swatches**. **Not yet
print-tested.**

## Material: this is PLA, not TPU — what changed and what didn't

Every mechanism in `texture_functions.js` (anti-stringing orbits, the
hairy-dot melt-pressure timing, etc.) was hand-tuned against **TPU's**
specific behavior — its compressibility, its oozing under residual melt
pressure, its drive-gear sensitivity to fast retraction. None of that
tuning has ever been tested against PLA, which behaves differently on
every one of those axes (less compressible, generally less stringy at a
sane temperature, more retraction-tolerant). Treat this sheet as the
experiment that answers "do these mechanisms even make sense on PLA," not
as a confirmed-good PLA config.

**Overridden for this print only** (via `em.header()` options — the
library's own `NOZZLE_TEMP`/`BED_TEMP`/`FLOW_PERCENT` globals, still
220°C/50°C/180% for TPU, were NOT touched):
- Nozzle: **205°C** (standard PLA range; adjust to your filament's spec)
- Bed: **60°C** (standard PLA)
- Flow: **100%** (the library's 180% is firmware-level compensation for
  TPU's own extruder slip — left at that for a rigid filament like PLA it
  would badly over-extrude)

**Left unchanged** (module constants, not exposed via `header()`, and not
unsafe for PLA — if anything overly conservative): `RETRACT_MM` (1.3mm
default / dot-family functions' own 4.0mm override), `RETRACT_SPEED`
(900mm/min, originally slowed specifically to protect TPU at the drive
gear — no reason to raise it for this test), all dwell times, all orbit/
anti-string mechanics.

**Hairy-family tiers** (`hairyDot`, `freeformHairyDotted`) are anchored on
`hairLength=3 / hairThickness=0.8` — the one combination
`texture_patterns.md` flags as the actually-validated regime on TPU (the
raw function defaults, `hairLength=10` with derived thickness, are
explicitly flagged there as ~8× outside anything tested) — not because
it's known-good on PLA, but because it's the least-arbitrary anchor point
available.

## Layout

Three columns, safe-area bed coords (15–205mm on a 220×220mm bed).
Calibration line (`freeformSolid`, x=120–180, y=200) sits above all three,
clear of the grid. **This file does not continue the normal
descending-by-5 calibration-line sequence** (last single-texture file used
y=90) — it's a full-bed matrix, not a sequential file. The next
single-texture file should resume from **y=85** as if this one weren't
part of that sequence.

| Column | X range | Contents |
|---|---|---|
| DOTS | 19–61 | 4 stamp textures, 3 stamps/row at x=25/40/55 |
| LINES | 74–142 | 9 line styles, 3× 18mm segments/row at x=75–93 / 99–117 / 123–141 |
| FILLS | 154–204 | 5 fill techniques, 3× 12×12mm patches/row (Solid fill: 8×8mm — see note) at x=155–167(or 155-163) / 173–185(or 173-181) / 191–203(or 191-199) |

`verifyLayout()` (3mm min-gap): **ok, 0 errors, 0 warnings**, across all
21 tracked regions (calibration + 20 texture rows — some rows hold more
than one swatch group, see the per-row bounding boxes in the generator
script if exact per-swatch clearance is ever needed).

---

## DOTS (single/few stamps; sizing knob = diameter unless noted)

| Texture | Swept parameter | Tier 1 | Tier 2 | Tier 3 | Row y | X positions |
|---|---|---|---|---|---|---|
| `blobDot` (v17, TPU-confirmed-best mechanism) | `diameter` | 1.2mm | 1.8mm | 2.6mm | 175 | 25 / 40 / 55 |
| `circularDot` (spiral-fill disc) | `diameter` | 1.2mm | 1.8mm | 2.6mm | 155 | 25 / 40 / 55 |
| `directionalBlobDot` (leaning dome, `azimuthDeg=45` fixed) | `diameter` | 1.5mm | 2.0mm | 3.0mm | 135 | 25 / 40 / 55 |
| `hairyDot` (root dome + pulled strand, `hairDirection="top"`) | `hairLength`/`hairThickness` (paired) | 2 / 0.6mm | 3 / 0.8mm | 5 / 1.0mm | 115 | 25 / 40 / 55 |

## LINES (3× 18mm segments per row)

| Texture | Swept parameter | Tier 1 | Tier 2 | Tier 3 | Row y | X starts |
|---|---|---|---|---|---|---|
| `freeformSolid` | `width` | 0.3mm | 0.5mm | 0.8mm | 175 | 75 / 99 / 123 |
| `freeformDashed` | `segLen`/`gapLen` | 4/2mm | 8/4mm | 14/7mm | 162 | 75 / 99 / 123 |
| `freeformDotted` | `gap` | 5mm | 10mm | 16mm | 149 | 75 / 99 / 123 |
| `freeformBlobDotted` (DEFAULT dotted-line style) | `gap` | 6mm | 10mm | 16mm | 136 | 75 / 99 / 123 |
| `freeformDirectionalBlobDotted` | `azimuthDeg` (offset from travel dir.) | 0° | 45° | 90° | 123 | 75 / 99 / 123 |
| `freeformSegmented` (v4) | `fatWidth` | 1.0mm | 1.6mm | 2.2mm | 110 | 75 / 99 / 123 |
| `freeformVariableThickness` | `hMax` | 0.4mm | 0.9mm | 1.4mm | 97 | 75 / 99 / 123 |
| `freeformHairy` (vertical-only strands) | `spacing` | 8mm | 5mm | 3mm | 84 | 75 / 99 / 123 |
| `freeformHairyDotted` (`hairLength=3`/`hairThickness=0.8` fixed, `hairDirection="top"`) | `gap` | 6mm | 10mm | 16mm | 71 | 75 / 99 / 123 |

## FILLS (3× patches per row; 12×12mm unless noted)

| Texture | Swept parameter | Tier 1 | Tier 2 | Tier 3 | Row y | X starts | Patch size |
|---|---|---|---|---|---|---|---|
| Solid fill (`freeformSolid` via `fillRegion`) | `gap` | 0.3mm | 0.45mm | 0.6mm | 175 | 155 / 173 / 191 | **8×8mm** |
| Line shade fill (`freeformSolid`, any angle) | `angleDeg` (`gap=2.5mm` fixed) | 0° | 45° | 90° | 155 | 155 / 173 / 191 | 12×12mm |
| Dots fill (`freeformDotted`) | `gap` (row spacing) | 4mm | 6mm | 9mm | 135 | 155 / 173 / 191 | 12×12mm |
| Hairy fill (`freeformHairy`) | `gap`/`spacing` (paired) | 8/8mm | 5/5mm | 3/3mm | 115 | 155 / 173 / 191 | 12×12mm |
| Diamond / checkerboard fill | `diag` (`fillGap=0.6mm` fixed) | 6mm | 8mm | 12mm | 95 | 155 / 173 / 191 | 12×12mm |

**Solid fill uses a smaller 8×8mm patch** — at tight gap (0.3–0.6mm) a
fully-solid 12×12mm patch alone needed ~22,000 of the file's ~37,000
lines (demonstrating fusion density inherently needs many close passes);
shrinking to 8×8mm brought the whole file down to ~25,000 lines without
changing what the row demonstrates.

---

## Verification performed (adapted for a 54-swatch file — see below)

`Task_FineTune.md`'s per-line hand-verification is designed for a single
texture per file; it doesn't scale to 54 swatches. What was actually
checked:

- **`verifyLayout()`**: ok, 0 errors, 0 warnings (3mm min-gap) across all
  tracked regions.
- **`verifyCheckerboard()`** on all 3 diamond-fill tiers (per
  `troubleshooting.md` §3 — mandatory for every diamond-fill generation,
  not just code changes): **0 violations** on all 3 (checked 128/98/72
  adjacency pairs for diag 6/8/12mm).
- **Stray-E guard**: clean — no `E` term outside a `G1`/`G92` line
  anywhere in ~25,000 lines.
- **Per-row negative-E counts**, computed by the generator itself (not by
  hand) and cross-checked against each function's documented retract
  pattern: 2 per `freeformSolid` segment (nLayers=2) ✓, 1 per
  `freeformSegmented`/`freeformVariableThickness` segment (single
  end-of-line retract, per v4/backport work) ✓, 1 per `blobDot`-family /
  `circularDot` (×2 layers)/`directionalBlobDot`/`hairyDot` stamp ✓.
- **Hand spot-check**: `blobDot` tier 1 (diameter=1.2mm) first build-step
  E, computed from the documented volume model (standoff cylinder +
  hemispherical dome, ×`extrusionMultiplier`, + prime + `baseExtraMm`) =
  **4.694mm** by hand vs. **4.6940mm** emitted — matches.
- **644 negative-E lines, 25,016 total lines, eTotal 315.1mm** (informational).

**Not checked** (out of scope for this pass, flag if it matters before
printing): exact per-swatch hand-verification of all 54 swatches'
individual E values; PLA-specific overhang/bridging behavior for the
`freeformHairy`/`freeformHairyDotted` vertical strands (untested in any
material at this thickness/length combo on PLA specifically).
