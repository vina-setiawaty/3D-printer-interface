# Hardware & Material — essentials

Trimmed reference for the parametric tactile-graphic page. This folder is a
**pinned prototype snapshot**; the live tuning history lives in
`../../texture_docs/`. If a number here disagrees with
`docs/texture_functions.js`, the code wins.

## Machine

| | |
|---|---|
| Printer | Ender 3 V2, Creality Sprite **direct-drive** extruder |
| Nozzle | 0.4 mm |
| Bed | 220 × 220 mm |
| Safe print area | 15 mm margin on every edge → usable **X/Y 15–205** |
| Extrusion mode | **relative (`M83`)** everywhere — every `E` value is a delta |
| Positioning | absolute (`G90`) for X/Y/Z |

## Material — TPU is the default

**If the user does not name a material, assume TPU.** Every default in
`texture_functions.js` is a TPU value from real testing on this printer. Do
not silently substitute PLA numbers or mix the two.

| Property | TPU (default) | PLA |
|---|---|---|
| Nozzle temp | 220 °C | 205 °C |
| Bed temp | 50 °C | 60 °C |
| Flow (`M221`) | 180 % | 100 % |
| Default retraction | 1.3 mm @ 900 mm/min | 1.3 mm @ 1500–2400 mm/min |
| Print-move speed | 100–600 mm/min (pattern-dependent) | 600–1500 mm/min |

**Why TPU is conservative:** it is soft and compressible. Fast or frequent
retraction can grind a flat spot into the filament at the drive gear,
causing under-extrusion that persists into *later, unrelated* prints. Some
dot/hair functions already use a larger 4.0 mm retract; that is deliberate
and per-function, not a global change.

## Geometry constants

| | Value | Meaning |
|---|---|---|
| Filament diameter | 1.75 mm | drives all `E` math (`FIL_AREA`) |
| Layer height | 0.20 mm | a feature's relief height is a whole multiple of this |
| Relief-height floor | 0.40 mm (2 layers) | anything less is not reliably felt — justify it |
| Bead width (default) | 0.5 mm | one extruded line |
| Z-hop | 0.4 mm | automatic safety lift before every travel move |
| Travel speed | 3000 mm/min | automatic, for non-printing moves |

## Start / end sequence

Every job is wrapped by `em.header()` … `em.footer()` (the page adds these —
the model never emits them). The header heats, homes, lays a prime line at
the far-left edge (x ≈ 10, outside the pattern area) and leaves the nozzle
retracted. The footer retracts, lifts 10 mm, presents the bed
(`G1 X0 Y218`), and switches the heaters off. Prime-line position, homing,
and command order are **not** parameters — they are fixed in
`Emitter.header()`.

## Multi-feature layout

Nothing stops two separately-placed textures from physically overlapping,
which crashes the nozzle into printed material. The page runs
`verifyLayout()` over a bounding box for every call before showing the
G-code as safe: **overlaps are hard errors**, sub-0.5 mm gaps are warnings.
