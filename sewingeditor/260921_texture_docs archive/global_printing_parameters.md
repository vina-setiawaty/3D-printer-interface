# Global Printing Parameters

Machine and material settings shared across every texture in
`texture_functions.js`. Read this before generating any G-code.

**Editing discipline**: when a parameter changes as a result of testing,
update the value here AND the matching constant/default in
`texture_functions.js` in the same edit. If this file and the code ever
disagree, the code is what actually runs — an out-of-sync doc is worse
than no doc.

---

## Default material: TPU

**If a request does not specify a material, assume TPU.** Every tuned
default in `texture_functions.js` (temperatures, retraction amount and
speed, flow percentage, per-pattern overrides) is a TPU value derived
from real testing on this project's hardware. Do not silently apply PLA
settings, and do not mix values between the two profiles.

## Filament Profiles

| Property | TPU (default) | PLA |
|---|---|---|
| Nozzle temperature | 220°C | 205°C |
| Bed temperature | 50°C | 60°C |
| Flow (M221) baseline | 180% | 100% |
| Retraction amount (default) | 1.3mm | 1.3mm |
| Retraction speed (default) | 900mm/min (15mm/s) | 1500-2400mm/min (25-40mm/s) |
| Practical max retraction speed before filament-damage risk | ~1000mm/min (~17mm/s) | ~2400mm/min (40mm/s) |
| Typical print-move speed | 100-600mm/min (pattern-dependent) | 600-1500mm/min |

**Why TPU is so much more conservative**: TPU is soft and compressible.
Fast or frequent retraction cycles can grind a flat spot into the filament
at the extruder drive gear, degrading grip and causing under-extrusion
that *persists into later, unrelated prints* until the filament is
manually re-fed past the damaged section. See `troubleshooting.md` §1.

**Hardware these were tuned on**: Ender 3 V2, Creality Sprite direct-drive
extruder, 0.4mm nozzle. A different TPU shore hardness or a Bowden
extruder would likely need re-tuning.

## Printing Bed

| Property | Value |
|---|---|
| Bed size | 220mm x 220mm (`BED_X`, `BED_Y`) |
| Safe margin | 15mm from each edge — enforced by `verifyLayout()`'s `bedMargin` |
| Minimum gap between separate textures | 0.5mm — `verifyLayout()`'s `minGap` default, equal to one bead width (`DEFAULT_WIDTH`). Deliberately permissive: overlaps remain hard errors, but tight-but-separate placements pass. Raise it if adjacent features fusing becomes a problem. |
| Substrate | Not parameterized — current designs assume bare-bed adhesion at 50°C is adequate for TPU |

## Start / End Sequences (`em.header()` and `em.footer()`)

Every generated print MUST begin with `em.header()` and end with
`em.footer()`. These emit the machine setup and shutdown commands — they
are not optional, and no texture function emits them.

**Extrusion mode is RELATIVE (`M83`), not absolute.** Every `G1 E<value>`
anywhere in this file -- in the `Emitter` class and in every texture
function -- is a DELTA: positive always means extrude, negative always
means retract, independent of everything printed before it. This
replaced an earlier absolute-E (`M82`) design where every E value was
the cumulative position, which made two things worse: a line's meaning
(extrude vs. retract) was only readable by diffing it against the
previous line, and no function's G-code output was a genuinely
independent, insertable unit -- combining two functions' output required
first knowing the exact cumulative E baseline in effect at that point.
See `troubleshooting.md` §11 for the full rationale and what changed.

### `em.header(options)` — emitted at the start of every print

```
G21                  set units to millimetres
G90                  absolute positioning (XYZ)
M83                  RELATIVE extrusion (E) -- see note above
M220 S100            feedrate override 100% (no global speed scaling)
M221 S<flowPercent>  flow override -- 180 for TPU by default
M104 S<nozzleTemp>   start heating nozzle (does not wait)
M140 S<bedTemp>      start heating bed (does not wait)
M190 S<bedTemp>      WAIT for bed to reach temperature
M109 S<nozzleTemp>   WAIT for nozzle to reach temperature
G28                  home all axes
G92 E0               zero the extruder
G1 Z5 F3000          lift to a safe height
                     ... prime line: two passes at x=10 / x=10.4,
                     y=15..100, each pass extruding E12 (a relative
                     delta -- NOT E12 then E24 as in the old absolute
                     design; each pass is now independently 12mm) ...
G92 E0               re-zero after priming
G1 Z2.0 F3000        lift clear of the prime line
G1 E-<RETRACT_MM> F<RETRACT_SPEED>   explicit retract, establishing the
                     starting retracted state (replaces an earlier
                     absolute-mode trick of baselining E via G92 to a
                     nonzero value, which has no equivalent in relative
                     mode)
```

**Why the heat commands are ordered this way**: `M104`/`M140` start both
heaters without blocking, so they warm in parallel; `M190`/`M109` then
wait. Bed-wait comes before nozzle-wait because the bed is usually
slower — waiting on it first means the nozzle is typically already at
temperature by the time its own wait is reached.

**The prime line is deliberate**, not leftover debris. It draws two
adjacent passes near the left edge of the bed (x≈10-10.4, y=15-100),
extruding ~24mm of filament before any real texture starts. This purges
air and stale filament and establishes consistent pressure in the nozzle.
It is placed outside the usable pattern area, so it never collides with
generated textures.

**Configurable parameters** (all default to the constants in this file):

```js
em.header({ nozzleTemp: 220, bedTemp: 50, flowPercent: 180 });
```

Passing nothing (`em.header()`) uses the TPU defaults. To print in PLA,
pass that profile's values explicitly — the header does not switch
profiles on its own.

**Not configurable without editing the code**: the prime line's position
and length, the homing behaviour, and the command ordering. If a printer
needs a different start sequence (e.g. bed levelling via `G29`, or a
different prime location), that is a code change to `Emitter.header()`,
not a parameter.

### `em.footer()` — emitted at the end of every print

```
G91                  relative positioning
G1 E-<RETRACT_MM>    final retract (only if not already retracted)
G1 Z10 F3000         raise the nozzle 10mm clear of the print
G90                  back to absolute positioning
G1 X0 Y218 F3000     present the bed: move the head aside and the bed
                     forward (Y = BED_Y - 2) so the print is reachable
M104 S0              nozzle heater off
M140 S0              bed heater off
M84                  disable steppers
```

`em.footer()` takes no parameters. The "present" position is derived from
`BED_Y`, so it follows automatically if the bed size constant changes.

**Note**: the footer does NOT run a cooling-fan-off command or wait for
cooldown — heaters are simply switched off and the machine is left to cool
passively. If an explicit cooldown wait or fan command is needed for a
particular printer, that is a code change to `Emitter.footer()`.

## Multi-Texture Layouts

Each texture already carries its own position — lines via their `x(t),
y(t)` functions, fills via their `region`. Nothing prevents two
separately-chosen positions from **physically overlapping**, which would
crash the nozzle into already-printed material. The library generates
overlapping layouts silently, with no error.

**Before generating any print with more than one texture, call
`verifyLayout(regions, options)` and confirm `ok === true`:**

```js
import { verifyLayout } from './texture_functions.js';

const layout = [
  { x0: 20, y0: 50, w: 30, h: 20, name: 'solid fill' },
  { x0: 60, y0: 50, w: 30, h: 20, name: 'diamond fill' },
];
const { ok, errors, warnings } = verifyLayout(layout);
if (!ok) { /* fix positions before generating */ }
```

- **Errors** (hard failures): regions overlap, or a region falls outside
  the safe bed margin. Do not generate G-code until resolved.
- **Warnings**: regions are closer than `minGap` (0.5mm default, one
  bead width) but not overlapping — effectively touching, so adjacent
  features may fuse. Worth surfacing to the user rather than silently
  accepting.

For line textures, derive an equivalent bounding region from the path's
extent to include them in the check.

## Shared Constants (`texture_functions.js` §1)

| Constant | Value | Effect |
|---|---|---|
| `FILAMENT_DIA` | 1.75mm | Filament cross-section for all E-value math |
| `Z_HOP` | 0.4mm | Safety lift before every travel move |
| `TRAVEL_SPEED` | 3000mm/min | All non-printing repositioning |
| `LAYER_HEIGHT` | 0.20mm | Per-layer Z step for multi-layer strokes |
| `RETRACT_MM` | 1.3mm | Default retraction — several functions override it (see below) |
| `RETRACT_SPEED` | 900mm/min | Default retraction speed |
| `LINE_START_PRIME_MM` | 0.3mm | Extra extrusion applied once per major element via `Emitter.newPattern()` |

## Relief Height Floor

Every texture must produce at least **0.4mm** of relief (`MIN_LAYERS = 2`
× `LAYER_HEIGHT = 0.20mm`) to be reliably distinguishable as a tactile
feature. Treat anything less as needing explicit justification.

## Retraction Is Not Uniform — Check Before Assuming

| Function | Retraction amount | Retraction speed | Why it differs |
|---|---|---|---|
| `freeformSegmented` | `retractMm: 4.0` | `retractSpeed: 1000` | **(v2+)** Now only ONE retract at this distance, at the very end of the line. v1 retracted it between every segment with no un-retract, starving the start of each segment (`troubleshooting.md` §14) — the "faint/failed prints" this distance was tuned against were that artifact. The start `eprime` (1.6mm) is separate. (v3's `transE` boundary nudges were dropped in v4.) |
| `freeformHairy` | `retractMm: 1.3` per strand | 900 (global) | One retract/unretract PER strand — highest cycle count in the library, see `troubleshooting.md` §1 |
| `blobDot` / `freeformBlobDotted` | `retractMm: 4.0` | 900 (global) | Anti-stringing change since v4 — larger distance only, speed left at global default per the TPU-damage caution in `troubleshooting.md` §1. Matches `freeformSegmented`'s own validated distance (different function, same number). The v4 print this shipped in was confirmed on real hardware to reduce stringing, but v4 also changed two other things at once, so this distance specifically is still not isolated — see `troubleshooting.md` §10 |
| `hairyDot` / `freeformHairyDotted` | `retractMm: 4.0` | 900 (global) | Matches `blobDot`'s override (its root is a `blobDot`-style dome). One retract per dot — see `troubleshooting.md` §12 and the §1 caution before a dense `gap` |
| `directionalBlobDot` / `freeformDirectionalBlobDotted` | `retractMm: 4.0` | 900 (global) | Same as `blobDot`. One retract per dot; the post-retract squish-then-drag shaping move carries no `E` (v2 removed the orbit; v3 split the drag into Z-down then lateral). See `troubleshooting.md` §13 |
| Everything else | 1.3mm (global) | 900 (global) | No override needed |

## Change Log

| Change | Reason |
|---|---|
| `RETRACT_SPEED` 1500→900mm/min | Fast retraction suspected of damaging TPU filament at the drive gear |
| Added `LINE_START_PRIME_MM` | Patterns reported printing faint at the very start of an element |
| `freeformSegmented` retraction speed 1800→1000mm/min, amount kept at 4.0mm | Reverted through several iterations to a version confirmed working on real hardware |
| Ported Python → JavaScript | Target app runs in a browser. Port verified to produce identical bounds, E-values, and checkerboard results to the original before adoption. |
| `freeformDashed` / `freeformSegmented` signatures changed: `segLen`/`gapLen` moved from positional parameters into the options object | They were the only two line styles with extra positional parameters, which silently broke them when used as `fill()` styles — see `troubleshooting.md` §8. All six styles now share one identical signature. |
| Added `verifyLayout()` | Nothing previously checked whether separate textures overlapped; overlaps generated silently and would crash the nozzle mid-print. |
| `verifyLayout()` `minGap` default 10mm → 0.5mm | 10mm (this project's own historical grid spacing) was too conservative as a general default — it warned on perfectly reasonable tight layouts. 0.5mm = one bead width, so it now warns only when regions are effectively touching. Overlap remains a hard error either way. |
| Extrusion mode M82 (absolute) → M83 (relative) project-wide | Composability — each function's G-code output is now a self-contained, insertable unit with no dependency on a global cumulative E baseline. See `troubleshooting.md` §11. |
| TPU default `NOZZLE_TEMP` 232°C → 220°C | Standardized after testing lower temperature as part of reducing TPU melt-pressure oozing (compressible-filament mechanism, see `troubleshooting.md` §10) — not yet confirmed in isolation from the other changes it shipped alongside, but adopted as the new default. |
