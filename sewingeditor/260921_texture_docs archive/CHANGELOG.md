# Changelog

Running log of requests, what was delivered, problems reported back from
real hardware or review, and the fixes applied. Newest entry at the
bottom. This is a conversation/decision log, not API documentation --
see `texture_patterns.md` for current parameter tables and
`troubleshooting.md` for root-cause writeups (this file cross-references
both rather than duplicating their content).

---

## 1. Session kickoff

**Asked**: read everything in `texture_docs/`; going forward, test each
texture in `texture_patterns.md` / `texture_functions.js`, writing new
functions or updating existing ones as needed. All generated G-code goes
in `test_print_gcode/`, filename starting with a timestamp plus a brief
description.

**Given**: read `texture_patterns.md`, `texture_functions.js`,
`troubleshooting.md`, `global_printing_parameters.md`. Confirmed the
workflow. No code or G-code changed yet.

---

## 2. New default dot type: `blobDot` (v1)

**Asked**: a new dot texture -- extrude an amount of filament at a point,
dwell, retract, Z-lift on the same spot, dwell, move to next point -- to
become the **default** dot (replacing `circularDot` as default). Suggested
`diameter` as the user-facing parameter, with filament amount derived from
it. Then: generate a 30mm line of these dots, 5mm gap.

**Given**:
- New `blobDot(em, cx, cy, options)` / `freeformBlobDotted(...)` in
  `texture_functions.js`, plus shared `emitBlobDot()` helper.
- v1 volume model: pure hemisphere, `V = (2/3)*pi*r^3`, `diameter` only.
- Updated `texture_patterns.md`: `blobDot` marked DEFAULT, `circularDot`
  demoted to "alternative."
- `test_print_gcode/20260826-120036_blob-dotted-line-30mm-gap5mm.gcode`
  -- 7 dots, x=50-80, y=100, default 1.6mm diameter.

---

## 3. "Why PLA parameters?" -- false alarm

**Asked**: why did the gcode use PLA temperatures?

**Checked**: `M104 S232` / `M140 S50` in the file -- those ARE the TPU
defaults (PLA would be 205/60 per `global_printing_parameters.md`). No
fix needed; premise was incorrect.

---

## 4. Diameter -> extrusion math, explained

**Asked**: what diameter was targeted, and how does extrusion amount
relate to it, ahead of fine-tuning.

**Given**: walked through the v1 hemisphere formula (default 1.6mm ->
0.4459mm filament), and flagged two caveats for tuning: (1) the 180% flow
override (`M221 S180`) is applied by firmware on top of the nominal E
value, not accounted for in the formula; (2) the hemisphere model ignores
`baseZ` (nozzle standoff), a real physical factor in actual blob shape.

---

## 5. `baseZ` folded into the volume model; anti-stringing v1; bed-margin catch

**Asked**: fold `baseZ` into the extrusion equation (not just position);
increase extrusion or the multiplier, whichever helps; add a Z-down
(no extrusion) after the Z-lift to press stringing back down, then
Z-lift again before moving on. *(Mid-turn: print location should start at
x=20, y=210.)*

**Given**:
- Volume model v1 -> v1.5: `standoff cylinder (pi*r^2*baseZ) + hemisphere
  dome (2/3*pi*r^3)`, plus an explicit `extrusionMultiplier` dial.
- Anti-stringing v1: lift -> press back down to `baseZ` (no extrusion) ->
  lift again, before travel.
- **Flagged before generating**: y=210 is inside the library's 15mm
  safe-bed-margin zone (`verifyLayout()` hard error, max y=205). Asked
  the user via AskUserQuestion; they chose "adjust to y=205." Further
  nudged to **y=204** to keep the dot's own radius footprint inside the
  margin (a plain y=205 centerline would still poke 0.8mm over).
- `test_print_gcode/20260826-121411_blob-dotted-line-30mm-gap5mm-baseZ-antistring.gcode`
  -- 7 dots, x=20-50, y=204, default 1.6mm.

---

## 6. Stringing methods menu; session-only 1mm test at 220°C, no cooldown

**Problem reported**: stringing still present after v1's lift-press-lift.

**Asked**: suggest fixes; try `diameter = 1mm`; *session-only, not saved
to files*: no nozzle/bed cooldown in the footer; note that the *next*
print in this session should go at y=195 to avoid overlapping this one.

**Given**: explained 4 standard anti-stringing levers (wipe-on-retract,
more retraction distance, lower nozzle temp, shorter dwell) and applied
all 4 in a session-only script (not written to `texture_functions.js`):
232->220°C, dwell 400->150ms, retraction 1.3->2.3mm (distance only, same
speed), 0.6mm lateral wipe folded into the retract, custom footer with no
`M104 S0`/`M140 S0`.

**Bug caught before delivery**: the custom retract subtracted 2.3mm but
the script's use of the library's generic `em.unretract()` only restored
the global 1.3mm each cycle -- E drifted negative after a few dots
(caught via the project's own "always check for negative E" discipline).
Fixed by making the script's retract/unretract symmetric on the custom
amount.

**Blocked mid-turn**: host machine ran out of disk space (G: and the temp
drive both near-zero free) -- `node`'s ESM loader couldn't even read the
36KB source file, and a plain `cp` failed with `ENOSPC` too. Reported
this plainly rather than attempting workarounds or cleanup, since freeing
disk space wasn't this session's call to make.

---

## 7. Resume after disk space freed

**Asked**: try to continue now.

**Given**: disk space confirmed freed (7GB+ available); regenerated the
corrected session-only script successfully:
`test_print_gcode/20260826-123513_blob-dot-1mm-antistring-session-no-cooldown.gcode`
-- 7 dots, 1mm diameter, x=20-50, y=204, 220°C, no cooldown footer,
verified zero negative-E lines.

---

## 8. "Isn't retract a negative E value?" -- clarified, no bug

**Asked**: double-check whether the retract moves in the last file were
a bug (negative E).

**Given**: explained the absolute-vs-relative E-mode distinction -- this
file uses `M82` (absolute), so a retract shows as the E number
*decreasing* but staying positive (e.g. `E4.1068 -> E1.8068`), which is
correct. A true bug looks like the absolute value itself going negative
(e.g. `E-0.7796`, as briefly happened in item 6 before the fix). No
change needed.

---

## 9. Stringing still present; deposition method redesigned (v2: Z-rise build)

**Problem reported**: stringing got WORSE with the session-only
wipe/temp/dwell/retract combo from item 6.

**Asked**: does it still have the dwell? what about extruding a large
amount at the start that decreases only minimally as Z rises, forming the
blob progressively, then dwell/retract/lift/z-down (no extrude or
retract)/lift/move? *("Good?")* Print at y=180.

**Given**: confirmed the dwell was present (150ms in that session
variant). Agreed the theory was sound -- a single extrusion burst builds
nozzle pressure that keeps oozing regardless of retract/lift tuning.
Replaced the deposition method (**v2**): builds the dome across
`buildSteps` (default 6) small Z-rise increments, tapering by
`taperFactor` (default 0.25) from heaviest at the bottom. Kept the v1
lift -> drop (no E, no retraction) -> lift as a second line of defense.
Reverted the session-only temp/dwell/retract/wipe tweaks back to file
defaults to isolate this one new variable.

Logged the item-6 wipe/temp/dwell combo's negative result, and this v2
change's rationale, in `troubleshooting.md` §10 (new section) --
including that only v1 had been print-tested (and failed) as of this
edit.

**Given**:
`test_print_gcode/20260826-124757_blob-dot-1mm-v2-Zrise-build-antistring.gcode`
-- 7 dots, 1mm diameter, x=20-50, y=180, default TPU temps, normal
cooldown footer. Verified the taper numerically in the output (each rise
step's E delta 25% smaller than the last) and zero negative-E lines.

---

## 10. v2 hardware result; v3 -- stronger coasting + isolated retraction bump

**Problem reported** (from printing item 9's file): still a bit of
stringing. **Positive result**: diameter -> extrusion volume conversion
confirmed accurate.

**Asked**: generate a `diameter = 2mm` print with a mechanism aimed at
less stringing. Print at y=170. *(Mid-turn: also start maintaining this
changelog.)*

**Given** (**v3**, both changes made together but reasoned separately):
1. `taperFactor` raised 0.25 -> 0.7 -- last build step now lays down only
   30% of the first step's rate (deliberate coasting toward near-zero
   flow at the tip, up from a mild 75%).
2. New dot-specific `retractMm = 2.0` (up from the shared global 1.3mm),
   distance only, speed unchanged -- explicitly noted as testing
   *increased retraction distance in isolation* this time, since item 6's
   combo changed retraction alongside temp/dwell/wipe simultaneously and
   couldn't isolate which one hurt.

Required updating the priming un-retract inside `emitBlobDot()` to
restore exactly `retractMm` (not the library's generic `em.unretract()`,
which only knows the shared global amount) -- same symmetric-retract
lesson as the bug caught in item 6, reapplied here since `retractMm` is
now dot-specific.

Updated `troubleshooting.md` §10 (v2 hardware result + v3 rationale),
`texture_patterns.md` (parameter table, hardware-status summary), and
`global_printing_parameters.md`'s "Retraction Is Not Uniform" table (new
row for `blobDot`/`freeformBlobDotted`).

**Given**:
`test_print_gcode/20260826-140426_blob-dot-2mm-v3-coast-retract-antistring.gcode`
-- 7 dots, 2mm diameter, x=20-50, y=170, default TPU temps/cooldown.
Verified the total extruded volume matches the updated formula
(1.2626mm filament for 2mm diameter), the taper ratio matches
`taperFactor=0.7`, retraction is now 2.0mm (not 1.3mm), and zero
negative-E lines. **Not yet print-tested** -- v3 status is provisional
pending real-hardware confirmation, same as noted in `troubleshooting.md`.

---

## 11. Convention check: is diameter->extrusion "shared" like eRate()?

**Asked**: is the diameter-to-extrusion conversion actually specified
inside `blobDot`, and does it follow the same convention as the rest of
the file?

**Given**: confirmed it's inline in `emitBlobDot()`, using the same
underlying conversion primitive as `eRate()` (divide a geometric quantity
by `FIL_AREA`) -- started to extract it into a separate exported function
to mirror `eRate()`'s pattern, but was stopped before making the change.

**Corrected mid-turn**: user clarified it should stay inline, since
`eRate()` is shared because 6+ line/fill styles reuse the *same* formula,
whereas the blob-dot volume math is only ever used in one place --
extracting it would be indirection without reuse benefit. No code
changed.

**Follow-up asked**: why is `eRate()` shared among the line styles at
all, if each style has its own extrusion behavior? **Given**: explained
that `eRate()` is reused specifically by the "moving bead" styles
(`freeformSolid`, `freeformDashed`, the spiral inside `freeformDotted`,
`freeformVariableThickness`, `circularDot`/`emitStroke`, diamond fill)
because they share one identical physical formula (width x height x
flowMult / FIL_AREA) for filament-per-mm-of-travel; `freeformSegmented`,
`freeformHairy`, and `blobDot` each define their own extrusion math
because none of them is a "bead along a path" in the first place
(segmented controls rate directly, hairy/blobDot are fixed-budget
point-extrusions). No code changed.

---

## 12. "What does the nozzle do for each dot?"

**Asked**: walk through the physical nozzle motion for one dot, using the
real numbers from the open 2mm v3 file; then clarified the question was
about `blobDot()` specifically (as opposed to the line-wrapper).

**Given**: a plain-language, step-by-step walkthrough of one
`emitBlobDot()` cycle at the time (v3): travel+settle, prime, build (rise
+ taper), dwell, retract, lift, dwell, drop (no E), dwell, lift again --
tied to actual G-code lines from the 2mm test file. No code changed.

---

## 13. v4: pre-retract drop, retraction 2.0->4.0mm, dwells >= 500ms

**Asked**: before the retract step, add a slight lower-down first; raise
the retraction amount, maybe to 4mm; raise every dwell in the function to
a 500ms minimum. *(Mid-turn: generate a new 3mm-diameter test print at
y=160.)*

**Given** (**v4**):
- New pre-retract drop: `preRetractDropMm` (default 0.15mm, clamped to
  never go below `baseZ`) -- lowers with NO extrusion immediately before
  the retract, then dwells, distinct from the existing post-retract
  lift-drop-lift anti-string sequence.
- `retractMm` raised 2.0 -> 4.0mm -- matches `freeformSegmented`'s own
  hardware-validated retraction distance (different function, same
  number), though not yet validated for `blobDot` itself. Noted in
  `troubleshooting.md` that retraction distance still hasn't been tested
  completely in isolation from the taper/pre-retract-drop changes made
  alongside it in v3/v4.
- All dwells (`dwellMs`, `preRetractDwellMs`, `liftDwellMs`,
  `pressDwellMs`) raised to a 500ms floor.
- Updated `texture_patterns.md`, `troubleshooting.md` §10, and
  `global_printing_parameters.md`'s retraction table for v4.

**Given**:
`test_print_gcode/20260826-153903_blob-dot-3mm-v4-preretract-drop-500ms-dwells.gcode`
-- 7 dots, 3mm diameter, x=20-50, y=160. Verified by hand: taper ratio
still 0.30 (`taperFactor=0.7` unchanged), pre-retract drop to 0.15mm
below dome top with no E term, retract now shows 4.0mm, all four dwells
show `P500`, zero negative-E lines. **Not yet print-tested.**

---

## 14. v4 hardware result: "definitely less stringing"; v5 -- orbit around the dot

**Problem reported** (from printing item 13's file): still some
stringing, but the best result of any version yet.

**Positive result**: v4 confirmed on real hardware -- "definitely less
stringing" (3mm diameter print).

**Asked**: add a circular movement around the blob before moving to the
next dot, so any leftover string winds around the current dot instead of
connecting straight to the next one. Try again with `diameter = 2mm` at
y=150.

**Given** (**v5**): added an orbit step at the very end of
`emitBlobDot()` -- after the existing lift-drop-lift, the nozzle now
traces one full circle (`orbitRadius`, default the dot's own radius
`diameter/2`, `orbitPts` default 16 segments, `orbitSpeed` default
600mm/min) around the dot at travel height, no extrusion, before the
next dot's travel move begins. Framed as targeting a different mechanism
than v4's retract/lift tuning: even after v4's improvements, if any ooze
remains on the tip, a straight travel move to the next dot stretches it
into a bridging strand -- looping back around the current dot first
detours that travel so the ooze winds around the current dot instead.
Pass `orbitRadius: 0` to disable. Updated `texture_patterns.md`
(hardware-status section now records v4's positive result) and
`troubleshooting.md` §10.

**Given**:
`test_print_gcode/20260826-154844_blob-dot-2mm-v5-orbit-antistring.gcode`
-- 7 dots, 2mm diameter, x=20-50, y=150. Verified: 17-point circle
(radius 1.0mm, matching `diameter/2`) traced around each dot after the
lift sequence, all pure `G0` travel moves at F600 with no E term, zero
negative-E lines. **Not yet print-tested.**

---

## 15. v6: remove both vertical squish steps; orbit moved to dome height

**Asked**: remove the pre-retract drop from v4 ("no drop, it squishes
it"); combine the two dwells around it into a single 1000ms dwell; move
the orbit down to happen at the dome's own top height instead of at
travel height; after the orbit, still lift to travel height and dwell
before moving on. Try again with `diameter = 2mm` at y=140.

**Given** (**v6**, a simplification, not just tuning): read as a
coherent redesign of the whole tail sequence, not additive parameter
changes --
- Removed the v4 pre-retract drop entirely (`preRetractDropMm`,
  `preRetractSpeed`, `preRetractDwellMs` parameters deleted, not just
  defaulted to 0 -- codebase convention is to delete unused code, not
  leave dead parameters).
- Removed the v1 post-retract lift→drop→lift entirely (`pressZ`,
  `pressDwellMs`, `pressSpeed` parameters deleted too) -- since the orbit
  moving to dome height now serves the same anti-string role this was
  meant to serve, and the user reported this general style of vertical
  pressing squishes the dot.
- `dwellMs` default raised 500->1000ms, now sitting right after the dome
  build, before retract (previously split across two 500ms dwells
  bracketing the removed pre-retract drop).
- Orbit relocated: now happens immediately after retract, at the current
  Z (the dome's own top -- no Z move needed to get there, since nothing
  changed Z since the build finished), instead of after a full lift to
  travel height.
- New sequence: build -> dwell(1000) -> retract -> orbit (at dome height)
  -> lift(`liftZ`) -> dwell(`liftDwellMs`, 500ms) -> travel to next dot.
- Updated `texture_patterns.md` (parameter table, hardware-status
  history now covers v1 through v6), `troubleshooting.md` §10, and
  `global_printing_parameters.md`'s retraction-table note for `blobDot`.

**Given**:
`test_print_gcode/20260826-155822_blob-dot-2mm-v6-orbit-at-dome-height-no-squish.gcode`
-- 7 dots, 2mm diameter, x=20-50, y=140. Verified: dwell shows `P1000`,
retract still 4.0mm, the 17-point orbit happens at Z1.300 (dome top,
matching the build's final Z, no intermediate lift), THEN a single lift
to Z3.300 with a single `P500` dwell follows the orbit -- no
pre-retract-drop or post-retract-press lines present anywhere in the
file. Zero negative-E lines. **Not yet print-tested.**

---

## 16. v7: orbit x3, extrusionMultiplier 1.0->1.3, all dwells 1000ms; calibration-line convention started

**Asked**: repeat the orbit 3 times per dot; increase the extrusion
multiplier (reported under-extruded); raise all dwells to 1000ms. *(Mid-
turn: print position y=130 for the dot line.)* Also, starting now: every
generated print should include a calibration line from x=60 to x=120 at
y=200, decreasing by 5 for each subsequent file generated.

**Given** (**v7**):
- `orbitLoops` parameter added (default 3) -- the v6 dome-height orbit
  now repeats 3 times before lifting.
- `extrusionMultiplier` default raised 1.0 -> 1.3.
- `liftDwellMs` default raised 500 -> 1000ms (now matches `dwellMs`,
  so both dwells in the function are 1000ms).
- Updated `texture_patterns.md` (parameter table + hardware-status
  history now covers v1-v7) and `troubleshooting.md` §10 for v7.
- Documented the new calibration-line convention in `texture_patterns.md`'s
  intro section (a test-harness convention, built inline per generation
  script, not a `texture_functions.js` change) -- **next file's
  calibration line should use y=195.**

**Given**:
`test_print_gcode/20260826-160434_blob-dot-2mm-v7-orbitx3-moreextrusion-1000ms-dwells-calibration.gcode`
-- 7 dots, 2mm diameter, x=20-50, y=130, PLUS a `freeformSolid`
calibration line x=60-120 at y=200. Verified: dwell `P1000` before
retract, orbit circle (17 points) repeated exactly 3 times in a row per
dot (51 orbit `G0` lines total), total extrusion per dot 1.6414mm for a
2mm dot (vs. 1.2626mm at `extrusionMultiplier=1.0` previously -- ratio
1.3, matches), final lift dwell now `P1000`, calibration line present at
the correct coordinates. Zero negative-E lines. **Not yet print-tested.**

---

## 17. v8: fold priming into the build (no stationary extrusion), recenter after orbit

**Asked**: reviewing v7's actual G-code, flagged that the priming
restoration is extruded as a standalone stationary line before the build
starts, and asked for it to be spread into the gradual rise instead, so
extrusion always happens together with movement. Also asked for a dwell
and a move back down to dome-top height after the orbit, before the
z-lift and travel to the next dot. *(Mid-turn: print position y=130
opened in IDE for a different file; final position for this print given
as part of the request context was inferred as continuing the sequence.)*

**Given** (**v8**):
- Removed the standalone `G1 E<primeAmount>` line entirely. The priming
  restoration (`retractMm` + first-dot prime bonus) is now added into
  the FIRST build step's E value, combined with that step's tapered
  share of the print volume -- so the first upward Z movement carries
  both. No line in this function now extrudes without accompanying
  movement.
- Added a dwell (`orbitDwellMs`, default 1000ms) after the orbit
  loop(s), followed by an explicit `G0` move back to (cx, cy) at the
  unchanged dome-top height (a re-center, since the orbit's last point
  sits `orbitRadius` away from center) -- only then does the existing
  lift + `liftDwellMs` dwell happen.
- Updated `texture_patterns.md` (parameter table + v8 notes +
  hardware-status history now covers v1-v8) and `troubleshooting.md`
  §10 for v8.

**Given**:
`test_print_gcode/20260826-161406_blob-dot-2mm-v8-merged-prime-recenter-orbit.gcode`
-- 7 dots, 2mm diameter, x=20-50, y=120, PLUS calibration line x=60-120
at y=195 (continuing the decreasing-by-5 sequence from item 16). Verified
by hand: sequence goes straight from the baseZ descent to
`G1 Z0.467 E6.0209 F200` (first build step) with NO intervening
stationary E-only line -- the delta (6.0209-1.3=4.7209) matches
primeE(4.3) + first step's taper share(0.4209). After the 3x orbit (51
lines), a `G4 P1000` dwell, THEN `G0 X20.000 Y120.000` (recenter back to
the dot's own center), THEN the lift and its own `G4 P1000` dwell. Zero
negative-E lines. **Not yet print-tested.**

---

## 18. Clarified retract-vs-extrude confusion; calibration line reordered + shifted

**Asked**: why does it still extrude at the top when it dwells after the
blob extrusion? Also: the calibration line should print before the
tested texture, not after, and its x-position should shift by +60mm.

**Given/checked**: traced the full per-dot sequence in item 17's file --
confirmed no code change was needed. The line right after the post-build
dwell, `G1 E3.2414 F900`, is the RETRACT (previous E was 7.2414;
7.2414-4.0=3.2414, exactly `retractMm`), not a new extrusion -- same
absolute-vs-relative-E distinction clarified earlier in this session
(item 8). Nothing in `emitBlobDot()` extrudes after any dwell; the
`E3.2414` line simply carries an `E` parameter because a retract IS an
E-command, just a decreasing one.

**Given** (test-harness change, not `texture_functions.js`): swapped
the generation script's call order so the calibration line
(`freeformSolid`) now runs BEFORE `freeformBlobDotted`, and shifted its
X range +60mm, from x=60-120 to **x=120-180**. Updated the standing
convention note in `texture_patterns.md`'s intro to match -- this is now
the default for all future generated test prints, not a one-off.

**Given**:
`test_print_gcode/20260826-161908_blob-dot-2mm-v8-calibration-first-shifted.gcode`
-- calibration line x=120-180 at y=190 (continuing the decreasing-by-5
sequence) printed FIRST, then 7 blob dots (diameter=2mm, v8 mechanism
unchanged) at x=20-50, y=110. Verified: calibration line's G-code
appears before the dot line's in the file (confirmed via line-number
search for each section's start), coordinates match the shifted range.
Zero negative-E lines. **Not yet print-tested** (v8's actual mechanism
is unchanged from item 17 -- this turn only reordered/repositioned the
calibration line and clarified the retract question).

---

## 19. Architecture change: absolute E -> relative E (M83) project-wide

**Asked**: switch the whole library from absolute extrusion to relative,
so each function's G-code output is a genuinely independent, insertable
unit rather than depending on a global cumulative E baseline -- framed
explicitly around future composability (an LLM assembling multiple
functions' output together).

**Given**: converted `Emitter.header()` (`M82`->`M83`, prime line's
second pass `E24`->`E12`, replaced the `G92 E<RETRACT_MM>` baseline trick
with an explicit `G1 E-<RETRACT_MM>` retract), `goto()`/`unretract()`/
`retract()`/`printMove()` (all emit deltas directly now; `eTotal` kept
informational-only, never emitted), `freeformSegmented()` (removed its
now-redundant internal `M83` and the trailing `M82`, which would have
silently reverted every later function to absolute mode), `freeformHairy()`
(removed a bookkeeping-only line that existed purely to pre-correct the
next loop iteration's absolute cumulative math -- unnecessary once each
iteration's deltas are independent), and `emitBlobDot()` (same
simplification -- the "must manually replicate the bonus logic exactly
or E drifts negative across calls" caution from earlier this session is
now structurally impossible, since there's no cross-call cumulative
state to drift out of sync with). Updated `global_printing_parameters.md`
(header/footer reference), `troubleshooting.md` (§4 marked resolved by
this change, §7's "always check for negative E" guidance REVISED --
negative E is now the normal, expected shape of every retract, not a red
flag -- and new §11 documenting the full rationale and change list), and
`texture_patterns.md`'s intro.

**Given**:
`test_print_gcode/20260826-162552_blob-dot-2mm-relative-E-refactor.gcode`
-- verified physical behavior is unchanged: the first blob-dot build
step's E delta is still 4.7209mm (previously computed by diffing two
cumulative absolute values; now the literal itself), every retract shows
as a clean negative literal (e.g. `G1 E-4.0000`), and the negative-E line
count (10) matches the actual retract-event count exactly (1 header + 2
calibration-line layers + 7 dot retracts) with no discrepancy. No `M82`
appears anywhere in the file after the header. Footer correctly skips
its own conditional retract since the emitter was already left in a
retracted state.

**Mid-turn question**: does the dwell/orbit/lift sequence happen
regardless of whether extrusion has finished? **Answered**: yes --
G-code executes strictly sequentially; firmware never advances to the
next line until the current move or dwell physically completes, so
there is no async/background extrusion possible.

---

## 20. "Still extruding" observation clarified; v9 -- recenter before dwell, 2000ms

**Asked**: why does extrusion still seem to happen after the orbital
movement, at the lift? Checked the exact code -- confirmed the orbit
(`G0`), recenter (`G0`), and lift (`G1 Z...`, no `E` term) genuinely
carry no extrusion command, in both the pre- and post-relative-E-refactor
versions. Asked the user whether this was observed in the raw G-code
text, a slicer preview, or an actual physical print/run, since a
physical print showing continued material despite zero commanded E would
be residual melt pressure/ooze (the stringing problem itself), not a
code bug -- this distinction was left for the user to clarify, but they
moved directly to a mitigation rather than continuing the diagnosis.

**Asked**: after the orbital movement, recenter, THEN dwell 2000ms
(order swapped from v8's dwell-then-recenter), then lift, then dwell
1000ms (unchanged). Try d=2mm at the next position. Also: describe the
current steps.

**Given** (**v9**): swapped `emitBlobDot()`'s post-orbit order so the
`G0` recenter move happens BEFORE the dwell, and raised `orbitDwellMs`
default 1000ms -> 2000ms -- giving residual melt pressure time to settle
at the dot's own center rather than dwelling off-center before the final
move back. Updated `texture_patterns.md` (parameter table + hardware
status now covers v9) and `troubleshooting.md` §10.

**Given**:
`test_print_gcode/20260826-163018_blob-dot-2mm-recenter-then-2000ms-dwell.gcode`
-- calibration line x=120-180 y=185, then 7 blob dots (diameter=2mm) at
x=20-50, y=100. Verified the exact post-orbit sequence: recenter
(`G0 X20.000 Y100.000`) immediately followed by `G4 P2000`, then lift
(`G1 Z3.300`), then `G4 P1000` -- matching the requested order and
timing exactly. 10 negative-E lines (retracts), matching the expected
count. **Not yet print-tested.**

---

## 21. "Still extruding" re-raised as a direct observation; code confirmed clean

**Asked**: does the dwell/orbit/lift sequence happen regardless of
whether extrusion has finished? **Answered**: yes, G-code executes
strictly sequentially -- no async/background extrusion is possible.

**Asked again**: why is extrusion still observed happening after the
orbital movement, at the lift? Re-checked the exact current code (the
orbit's `G0` lines, the recenter `G0`, and the lift `G1 Z...` with no `E`
term) -- confirmed none of them carry an extrusion command, in the file
generated this same turn. Since the user clarified this was a direct
observation, not a misreading of the G-code text (as the earlier
"isn't retract a negative value"-style questions had been), asked which
of three things they were observing it in: the raw G-code text, a slicer
preview, or an actual physical print/run -- flagging that a physical
print showing continued material despite zero commanded E would be
residual melt pressure/ooze (the stringing problem itself, not a code
bug), while a slicer preview could have its own travel-move-rendering
quirks. The user moved directly to a mitigation (see item 20) rather
than continuing this diagnosis, so the distinction remains unresolved --
worth returning to if the mitigations in items 20/22 don't fully resolve
the observation.

---

## 22. v10: dwellMs 2000ms, new postRetractDwellMs, liftZ 5.0mm

**Asked**: step 3 (the post-build dwell) to 2000ms; a new 2000ms dwell
inserted right after step 4 (the retract), before the orbit; `liftZ` to
5.0mm.

**Given** (**v10**): `dwellMs` default raised 1000 -> 2000ms.
`postRetractDwellMs` (new parameter, default 2000ms) added, dwelling
immediately after the retract and before the orbit begins -- a fourth,
separate dwell in the function (alongside `dwellMs`, `orbitDwellMs`, and
`liftDwellMs`). `liftZ` raised 2.0 -> 5.0mm. Updated `texture_patterns.md`
(parameter table + hardware status now covers v10) and
`troubleshooting.md` §10, flagging that with three of the four dwells
now defaulting to 2000ms, it is not yet known whether any single one is
doing useful work or whether it's the cumulative dwell time before
travel that matters.

**Given**:
`test_print_gcode/20260826-163759_blob-dot-2mm-dwell2000-postretract2000-liftz5.gcode`
-- calibration line x=120-180 y=180, then 7 blob dots (diameter=2mm) at
x=20-50, y=90. Verified the exact sequence: `G4 P2000` (dwellMs) ->
retract -> `G4 P2000` (new postRetractDwellMs) -> orbit x3 -> recenter ->
`G4 P2000` (orbitDwellMs) -> `G1 Z6.300` (lift = baseZ+domeHeight+liftZ
= 1.3+5.0, confirming liftZ=5.0) -> `G4 P1000` (liftDwellMs). 10
negative-E lines (retracts), matching the expected count.
**Not yet print-tested.**

---

## 23. v10 printed: oozing confirmed real (not a code bug); root cause diagnosed; v11 targets the mechanism

**Problem reported** (from printing item 22's v10 file): there is really
some extrusion happening after the orbital movement and during the
dwell -- this time stated as a direct observation from printing, not a
question about reading the G-code.

**Given**: re-checked the exact code for the orbit/recenter/lift block a
third time and confirmed again it carries no `E` command anywhere.
Explained the likely physical mechanism: TPU's compressibility means a
build burst stores elastic pressure in the filament column that a single
retract does not instantly relieve -- the melt (kept fluid at 232°C) can
keep oozing under that residual pressure regardless of what the E-axis
is doing, which is exactly the window all the v4-v10 dwells were
implicitly waiting out without addressing why the pressure built up in
the first place. Offered four options via AskUserQuestion (gentler
build/lower extrudeSpeed, stronger/longer retract, lower nozzle temp,
or print v10 as-is first) -- user chose gentler build + lower temp, and
added a fourth request: lower `baseZ` to 0.2/0.15mm and extrude more (or
dwell) there, to create a bigger, better-sticking base.

**Given** (**v11**): `extrudeSpeed` lowered 200 -> 120mm/min (less
pressure builds up during the build). `baseZ` lowered 0.3 -> 0.2mm
(squashes the initial deposit flatter/wider against the bed). New
`baseExtraMm` (0.3mm, extra filament at just the first build step, on
top of its normal taper share) and `baseDwellMs` (1000ms dwell
immediately after that first step) added to anchor the first contact
point before the rest of the dome builds on top of it. Nozzle
temperature lowered to 220°C for this test at the generation-script
level (`em.header({nozzleTemp: 220})`) -- not a `blobDot` parameter,
since temperature is print-wide. Flagged in `troubleshooting.md` §10
that this reuses the exact 220°C value from the item-6 session-only
experiment, but this time isolated from the wipe/dwell/retraction
changes that confounded that earlier "worse" result -- still bundled
with `extrudeSpeed` and the base-anchoring changes here, though, so
temperature alone remains untested in full isolation. Cross-referenced
the new compressible-TPU mechanism from `troubleshooting.md` §1 (related
to, but distinct from, the drive-gear-damage mechanism already
documented there). Updated `texture_patterns.md` (parameter table +
hardware status now records v10's confirmed-real oozing result and v11's
rationale).

**Given**:
`test_print_gcode/20260826-164529_blob-dot-2mm-gentlebuild-lowtemp-stickybase.gcode`
-- nozzle 220°C, calibration line x=120-180 y=175, then 7 blob dots
(diameter=2mm) at x=20-50, y=80. Verified by hand: header shows
`M104 S220`/`M109 S220`; dot build starts at `Z0.200` (baseZ); first
build step shows `E4.9773 F120` (F120 confirms lowered extrudeSpeed;
delta verified as 0.3774 taper share + 4.3 prime + 0.3 baseExtraMm =
4.9774, matching), immediately followed by `G4 P1000` (new
baseDwellMs) before the remaining tapered steps continue. 10 negative-E
lines (retracts), matching the expected count. **Not yet print-tested.**

---

## 24. v12: standardize 220°C as the global default; add postLiftBounces

**Asked**: standardize the TPU nozzle temperature to 220°C (make it the
real default, not just a session/test override). One last change: after
the orbital movement and lift, do two down-to-dome-top /
back-up-to-travel-height cycles before moving to the next dot.

**Given** (**v12**):
- `NOZZLE_TEMP` constant in `texture_functions.js` changed 232 -> 220 --
  a real default change now, not a per-test header override.
  `global_printing_parameters.md`'s Filament Profiles table, header
  example, and a new Change Log row all updated to match. Flagged in
  `troubleshooting.md` §10 that this reuses the same 220°C value tried
  once before (item 6, reported worse when bundled with other changes)
  and has still not been validated in isolation from v11's
  extrudeSpeed/baseZ/baseExtraMm changes -- standardizing it now is a
  judgment call, not a proven-in-isolation result.
- New `postLiftBounces` parameter (default 2) added to `emitBlobDot()`:
  after the existing lift + `liftDwellMs`, this many additional
  down-to-dome-top / back-up-to-travel-height cycles happen (no
  extrusion) before departing for the next dot.
- Updated `texture_patterns.md` (parameter table + hardware status now
  covers v12) and `troubleshooting.md` §10 (v11 marked never
  print-tested/superseded, v12 rationale, updated isolation candidates).

**Given**:
`test_print_gcode/20260826-165122_blob-dot-2mm-standardized220C-postliftbounces2.gcode`
-- calibration line x=120-180 y=170, then 7 blob dots (diameter=2mm) at
x=20-50, y=70. Verified: header now shows `M104 S220`/`M109 S220` with
NO per-call override needed (confirms the global default actually
changed, not just this script). Post-lift sequence confirmed exactly:
`Z6.200` (initial lift) -> `G4 P1000` (liftDwellMs) -> `Z1.200` (down to
dome top) -> `Z6.200` (up) -> `Z1.200` (down) -> `Z6.200` (up) -- two
full bounce cycles, no `E` on any of them -- then `Z6.600` (goto's travel
hop) to the next dot. 10 negative-E lines (retracts), matching the
expected count. **Not yet print-tested.**

---

## 25. v13: recenter and post-lift bounces hover above the blob instead of touching it

**Asked**: the recenter after the orbital movement should be a bit above
the blob, and the same for the two post-lift z-hops -- so the nozzle
doesn't touch the blob and remelt it.

**Given** (**v13**, a real bug catch rather than a stringing theory):
confirmed that both the recenter move and the down-phase of each
`postLiftBounces` cycle were targeting `z` -- the dome top's EXACT
height -- meaning the nozzle genuinely touched/dragged across the
just-printed blob on every one of those moves, independent of the
stringing question. Fixed with a new `blobClearanceMm` parameter
(default 0.3mm): the recenter now does a pure Z lift to
`z + blobClearanceMm` FIRST, then moves XY back to center at that
hover height (rather than moving XY at the exact dome-top height); each
bounce's down-phase now targets that same hover height instead of `z`.
The orbit itself is deliberately left unchanged -- it still sweeps AT
the exact dome-top height, since catching a string at its real
attachment height is the whole point of that mechanism; only the
recenter and bounces (which have no reason to contact the blob) needed
the fix. Updated `texture_patterns.md` (parameter table + hardware
status now covers v13) and `troubleshooting.md` §10.

**Given**:
`test_print_gcode/20260826-165819_blob-dot-2mm-noblobcontact-hoverclearance.gcode`
-- calibration line x=120-180 y=165, then 7 blob dots (diameter=2mm) at
x=20-50, y=60. Verified by hand: after the orbit, `G1 Z1.500` (lift to
zHover = dome top 1.200 + 0.3 clearance) happens BEFORE `G0 X20.000
Y60.000` (recenter XY move) -- confirming the nozzle is already clear
before it moves, not moving XY at the touching height. Both
`postLiftBounces` cycles show `G1 Z1.500` (down to hover) / `G1 Z6.200`
(up), never the exact `Z1.200` dome-top value. 10 negative-E lines
(retracts), matching the expected count. **Not yet print-tested.**

---

## 26. v14: second, wider/lower orbit after the bounces to catch a sagging strand

**Asked**: after the double z-hop thing, add another circular movement
just outside the diameter of the blob, at a height a bit lower than the
dome top, so the leftover "hair" goes around it too -- then move to
print the next dot. (Aside, answered inline, no implementation needed:
why not use `G2`/`G3` arcs instead of point-sampling? Because this
codebase's `samplePath`-based approach is deliberately used for every
curve everywhere -- lines, dots, orbits -- so all shapes go through one
consistent code path; `G2`/`G3` are never used anywhere in the file.)

**Given** (**v14**, a new stringing-mitigation theory, not a bug catch):
v13's orbit and bounces only sweep or hover right at (or just above) the
dome's own top height, so if a trailing strand sags down the SIDE of the
dome rather than staying at its tip, nothing in the existing sequence
would ever pass near it. Added a second orbit, traced after the
`postLiftBounces` cycles, that is deliberately WIDER than the first
orbit (new `secondOrbitRadius`, default the dot's own `radius + 0.5mm`,
just outside the blob's own physical edge) and LOWER than the dome top
(new `secondOrbitZDrop`, default 0.3mm below `z`, clamped to never go
below `baseZ`) -- opposite direction from `blobClearanceMm`'s
hover-above. New `secondOrbitPts` controls its point count, same
sampling approach as `orbitPts`. Lifts back to `liftZ` afterward, before
the caller's next `goto()` departs for the next dot. Wired the three new
parameters through `freeformBlobDotted`'s options pass-through (it was
missing them after being added to `emitBlobDot` first). Updated the
`emitBlobDot` docstring, `texture_patterns.md` (parameter table,
anti-stringing mechanism list, sequence description, hardware status now
covers v14, `freeformBlobDotted` full-signature line), and
`troubleshooting.md` §10.

**Given**:
`test_print_gcode/20260826-170751_blob-dot-2mm-secondorbit-haircatch.gcode`
-- calibration line x=120-180 y=160, then 7 blob dots (diameter=2mm) at
x=20-50, y=50. Verified by hand: after the two `postLiftBounces` cycles
end back at `Z6.200`, the sequence shows `G1 Z0.900` (secondZ = dome top
1.200 - 0.3 drop), then 17 `G0` points tracing a circle of radius 1.5mm
(dot radius 1.0 + 0.5mm margin) around the dot center with zero `E` on
any of them, then `G1 Z6.200` (lift back to `liftZ`) before the next
dot's travel hop. 10 negative-E lines (retracts), matching the expected
count. **Not yet print-tested.**

---

## 27. v15: orbit moved to happen after a full lift, replacing bounces and both earlier orbits

**Asked**: instead of the 2 z-hop (`postLiftBounces`), make the circular
movement happen again three times, but at a height higher than the blob
dot -- and remove the current last two circular movements. Try again
with d=3mm.

**Given** (**v15**, a simplification rather than another stacked
mechanism): read this as replacing the entire v10-v14 stack -- the
dome-height orbit, the recenter step, `postLiftBounces`, and the v14
second wider/lower orbit -- with one idea: lift clear of the dome FIRST
(`liftZ`, unchanged default 5.0mm), dwell (`liftDwellMs`), and only THEN
orbit `orbitLoops` (unchanged default 3, hence "three times") times at
that lifted height -- clearly higher than the blob, and clearly not
touching it. This is the exact inverse order of v10-v14 (which orbited
low, right at the dome top, then lifted after). Because nothing moves in
XY before the orbit now, no recenter step is needed afterward either.
Removed `orbitDwellMs`, `postLiftBounces`, `blobClearanceMm`,
`secondOrbitRadius`, `secondOrbitZDrop`, and `secondOrbitPts` as
parameters -- none of them are meaningful under this simpler sequence.
Updated the `emitBlobDot` docstring, wired the trimmed parameter list
through `freeformBlobDotted`, and updated `texture_patterns.md`
(signature, description, parameter table, anti-stringing mechanism list,
hardware status now covers v15) and `troubleshooting.md` §10.

**Given**:
`test_print_gcode/20260826-171439_blob-dot-3mm-orbit-at-lifted-height.gcode`
-- calibration line x=120-180 y=150, then 7 blob dots (diameter=3mm) at
x=20-50, y=40. Verified by hand: dome top at Z1.700 (radius 1.5 for
d=3mm), retract `E-4.0000`, dwell, then `G1 Z6.700` (lift to
`liftZ`=5.0 above the dome, well BEFORE any orbit move) and a 1000ms
dwell, then 51 `G0` points (3 loops x 17 points) tracing a circle of
radius 1.5mm at that same Z6.700 height with zero `E` on any of them,
then the next dot's travel hop. No recenter move present -- confirmed
the sequence goes straight from the orbit to the next dot's `goto()`.
10 negative-E lines (retracts), matching the expected count. **Not yet
print-tested.**

---

## 28. v16: restored the original dome-height orbit that v15 had wrongly removed

**Asked**: "Huh, man you removed the original circle movement? that is
what works." Plus: give a description of the current steps again.

**Given** (**v16**, a correction, not a new theory): v15 misread the
prior turn's instruction. "Instead of a 2 z-hop, make the circular
movement happen again three times ... Remove the current last two
circular movement" was meant as: replace `postLiftBounces` (the "2
z-hop") with a new orbit repeated three times at a higher position, and
remove the two untested additions stacked on top of the original orbit
(`postLiftBounces` and the v14 second wider/lower orbit) -- not the
original dome-height orbit itself, which was the one already confirmed
on real hardware to reduce stringing. v15 removed that original orbit
too, by mistake. v16 restores it: the dome-height orbit + recenter +
`orbitDwellMs` dwell + lift + `liftDwellMs` dwell sequence is back
exactly as it was in v13 (`orbitDwellMs` and `blobClearanceMm` are
parameters again), and the new "three times, higher than the blob"
orbit from the previous turn is kept as an ADDITION after that, not a
replacement -- a new `topOrbitLoops` (default 3) parameter controls a
second pass of the same circle at the lifted height, which is what
actually replaces `postLiftBounces` and the v14 second orbit. Updated
the `emitBlobDot` docstring, wired the restored/new parameters through
`freeformBlobDotted`, and rewrote `texture_patterns.md` (signature,
description, parameter table, anti-stringing list back to 4 items,
hardware status now explains the v15 mistake and the v16 correction) and
`troubleshooting.md` §10 (v15 section relabeled as a caught mistake, new
v16 section documenting the fix).

**Given**:
`test_print_gcode/20260826-172034_blob-dot-3mm-both-orbits-restored.gcode`
-- calibration line x=120-180 y=140, then 7 blob dots (diameter=3mm) at
x=20-50, y=30. Verified by hand: dome top Z1.700, retract, dwell, then
the first orbit (51 `G0` points, 3 loops, radius 1.5mm, zero `E`) at
Z1.700 unchanged, then `G1 Z2.000` (recenter hover = dome top + 0.3
`blobClearanceMm`), `G0 X20.000 Y30.000` (recenter XY), `G4 P2000`
(`orbitDwellMs`), `G1 Z6.700` (lift to `liftZ`), `G4 P1000`
(`liftDwellMs`), then the second orbit (another 51 `G0` points, 3
`topOrbitLoops`, same radius, zero `E`) at Z6.700, then the next dot's
travel hop. Both orbits present, in the right order, at the right
heights. 10 negative-E lines (retracts), matching the expected count.
**Not yet print-tested.**

---

## 29. v17 (session-only): disabled steps 6-10 to isolate the dome-height orbit alone

**Asked**: after the fifth step, move straight to the next dot -- comment
out steps 6 to 10 for now.

**Given**: this is a temporary isolation test, not a new numbered design
-- the point is to test whether the original dome-height orbit
(mechanism 3, the one already confirmed on hardware) is sufficient on
its own, without v16's still-untested recenter/lift/second-orbit tail
stacked on top of it. Commented out the recenter, both dwells, the lift,
and the second (lifted-height) orbit in `emitBlobDot`, wrapped in a
single `/* ... */` block with a note on what to uncomment to restore v16
behavior. The parameters those steps use (`orbitDwellMs`,
`blobClearanceMm`, `liftZ`, `liftSpeed`, `liftDwellMs`, `topOrbitLoops`)
are untouched on the function signature -- only the code that consumes
them is disabled. Did not touch `freeformBlobDotted`'s parameter
pass-through, since re-enabling later needs no signature changes. Added
a note to `texture_patterns.md` (a blockquote under the Blob Dot
description, not a rewrite of the parameter table, since nothing about
the parameters themselves changed) and a new paragraph in
`troubleshooting.md` §10.

**Given**:
`test_print_gcode/20260826-172507_blob-dot-3mm-orbit-only-no-tail.gcode`
-- calibration line x=120-180 y=130, then 7 blob dots (diameter=3mm) at
x=20-50, y=20. Verified by hand: build, retract, the first orbit (51
`G0` points, 3 loops, zero `E`) at dome height Z1.700, then immediately
`G1 Z2.100` -- the next dot's own travel-lift move -- with no recenter,
no dwells, no lift-to-`liftZ`, and no second orbit in between. 10
negative-E lines (retracts), matching the expected count. **Not yet
print-tested.**

---

## 30. v17 confirmed best result on real hardware

**Asked**: "Ok. Yes this works best." (confirming the v17 print --
build/retract/one dome-height orbit/straight to next dot, steps 6-10
disabled).

**Given**: no code change -- updated hardware-status tracking across all
three docs to reflect this as a CONFIRMED result, not just an untested
isolation test. `texture_patterns.md`'s Blob Dot header changed from
"⚠️ v16, partially hardware-validated" to "✅ v17 CONFIRMED BEST on
hardware"; its v17 blockquote and the Hardware status paragraph both
rewritten to state plainly that steps 6-10 are confirmed NOT needed, not
merely untested. `troubleshooting.md` §10's v17 paragraph updated the
same way. This is now the working default recipe for `emitBlobDot`:
build (rise+taper+prime+base-anchor) -> dwell -> retract -> dwell -> ONE
dome-height orbit (`orbitLoops`, default 3) -> straight to the next
dot's own travel move. Nothing else in the function is currently active
past that point.

---

## 31. Implemented the "hairy dot" (closes a long-standing known gap)

**Asked**: implement a single dot with one pulled hair strand, with
user-facing parameters for hair thickness (mapping to a slower pull
speed for thicker hair), hair length (mapping to both extrusion amount
and pull distance), a direction (top/left/bottom/right), and an
overtravel margin beyond the hair's length so consecutive strands don't
connect to the next dot. Test file: calibration line at the same
x-location as before but y stepping by 5mm instead of 10; the hairy-dot
line itself at x=70 to x=10, same gap as other dotted-line tests.

**Given**: added `emitHairyDot` (private) / `hairyDot` (single-dot
wrapper, mirrors `blobDot`) / `freeformHairyDotted` (line wrapper,
mirrors `freeformBlobDotted`) to `texture_functions.js`. Mechanism is
deliberately deposit-then-stretch (all material extruded stationary at
the anchor, then the nozzle pulls away with zero further extrusion,
stretching it into a strand) -- this is the opposite goal from
`emitBlobDot`'s anti-stringing work: here the "stringing" behavior IS
the feature. Volume model mirrors `emitBlobDot`'s
standoff-cylinder-plus-dome split: anchor volume
(`π·(rootDiameter/2)²·baseZ`) plus hair volume
(`π·(hairThickness/2)²·hairLength`), both converted via `FIL_AREA`.
`hairSpeed`, when not overridden, derives from thickness as
`600 * (DEFAULT_WIDTH / hairThickness)` -- thicker hair pulls slower.
`hairDirection: "top"` pulls straight up in Z only; `"left"`/`"right"`/
`"bottom"` lift by a fixed `clearanceZ` first, then travel horizontally
in that compass direction -- a separate, independent mechanism from the
"horizontal option...explored and abandoned" note already on
`freeformHairy` (a different, older function). `overtravelMm` walks
further past `hairLength` in the same direction, still no extrusion,
before the retract, so the strand's actual tip stays short of the next
dot. No recenter/return code at the end of `emitHairyDot` -- same
"let the caller's next `goto()` handle repositioning" convention
established for `emitBlobDot` in v15-v17. Updated `texture_patterns.md`
(the "Hairy dot" section flipped from ❌ not implemented to ✅
implemented, full parameter table, plus a new "Hairy-dotted line" entry
under Line) and added `troubleshooting.md` §12 with the full design
record.

**Problem reported** (by the layout check, not the user): the first
generation attempt used the user's literal x=70-to-10, y=10 coordinates,
which `verifyLayout()` correctly rejected -- both fall inside the
project-wide 15mm bed-margin safety check every other test file in this
session has respected. Flagged this to the user via `AskUserQuestion`
rather than silently shrinking the margin or repositioning unilaterally.
User chose new coordinates over the two turns: first x=70 to x=100 (a
positive-direction 30mm span instead of the original negative-direction
60mm span), then a follow-up correction to y=120 (up from an initial
y=20 guess).

**Given**:
`test_print_gcode/20260826-174028_hairy-dot-v1-top-direction.gcode` --
calibration line x=120-180 y=125, then 7 hairy dots (`hairDirection:
"top"`, all defaults) from x=70 to x=100, y=120. Verified by hand: first
dot's deposit line `G1 E1.9069` matches the hand-computed anchor+hair
volume (0.235619 + 0.502655 = 0.738274mm3 / FIL_AREA 2.40528 = 0.30693mm
E) plus prime (1.3 retractMm + 0.3 first-dot bonus); pull move `G0
Z4.300 F750` matches z1 = baseZ 0.3 + hairLength 4.0, F = 600*(0.5/0.4);
overtravel `G0 Z6.300 F600` matches z2 = z1 + overtravelMm 2.0; retract
`G1 E-1.3000 F900` immediately follows; second dot's deposit line `G1
E1.6069` matches the no-bonus recompute (0.30693 + 1.3). 10 negative-E
lines (3 calibration, 7 dots), matching the expected count. **Not yet
print-tested.**

---

## 32. Hairy dot, second test: larger diameter/thickness/length/overtravel

**Asked**: fix `rootDiameter` (called "base diameter") at 2mm for now.
Try `hairThickness` 0.5mm, `hairLength` 8mm -- extrusion should cover
(be sized for) 8mm, and the retract should fire well beyond that point,
not right at it. After the target length, travel a lot further --
roughly an extra 20mm -- to make sure the hair is fully detached. Use
the next position in the y sequence. Also asked for a detailed
explanation of every hair parameter and how it relates to extrusion,
travel speed, and timing.

**Given**: no code change -- these are call-site parameter overrides
passed through the generation script's options object, not changes to
`emitHairyDot`'s own defaults (matching how diameter was varied per-test
for `blobDot` all project without touching its defaults). Confirmed the
already-implemented v1 mechanism already matches what was described:
ALL extrusion happens in one stationary shot at the anchor (so it's
"covered"/sized for the full `hairLength` from the start, not extruded
gradually during the pull), the retract fires only after BOTH the
`hairLength` pull AND the `overtravelMm` extra travel are complete (not
right at `hairLength`), and `overtravelMm` is exactly the "how much
further to travel to ensure detachment" knob already in place -- so this
turn is a parameter-value test of the existing v1 design, not a design
change. Set `overtravelMm: 20` (10x the previous default) accordingly.
Gave the user a full prose explanation of all 14 `emitHairyDot`
parameters grouped by phase (anchor deposit / pull / overtravel /
retract) and how thickness and length independently drive the deposited
volume while thickness alone additionally drives pull speed -- see the
chat response for the full text; not duplicated here since
`texture_patterns.md`'s parameter table already covers the same ground
in reference form. Logged the test in `troubleshooting.md` §12.

**Given**:
`test_print_gcode/20260826-174900_hairy-dot-v2-larger-params.gcode` --
calibration line x=120-180 y=120, then 7 hairy dots (`rootDiameter=2mm,
hairThickness=0.5mm, hairLength=8mm, overtravelMm=20mm,
hairDirection="top"` (default, unchanged)) from x=70 to x=100, y=110.
Verified by hand: first dot's deposit `G1 E2.6449` matches anchor volume
0.94248mm3 + hair volume 1.57080mm3 = 2.51327mm3 / FIL_AREA 2.40528 =
1.04490mm E, + prime (1.3 + 0.3 first-dot bonus) = 2.64490; pull `G0
Z8.300 F600` matches z1 = baseZ 0.3 + hairLength 8.0, speed =
600*(0.5/0.5) = 600 exactly (hairThickness now equals `DEFAULT_WIDTH`,
so no scaling applied); overtravel `G0 Z28.300 F600` matches z2 =
8.3 + 20.0; retract `G1 E-1.3000 F900` immediately follows; next dot's
`goto()` correctly lifts to `G1 Z28.700` (28.3 + Z_HOP 0.4) before
traveling. Second dot's no-bonus deposit `G1 E2.3449` matches
1.04490 + 1.3. 10 negative-E lines, matching the expected count. **Not
yet print-tested.**

---

## 33. Hairy dot v3: root now built like a real blobDot, retract moved mid-pull

**Asked**: retract probably needs to happen earlier than the very end,
since TPU has leftover pressure -- try firing it around 2mm into an 8mm
hair. And: check how `blobDot` actually builds a 2mm dot, and use that
as the base of the hairy texture (rather than the custom anchor+hair
volume formula v1/v2 used).

**Given**: replaced `emitHairyDot`'s one-shot stationary anchor deposit
with `emitBlobDot`'s own tapered Z-rise build, verbatim -- same
`domeHeight`/`standoffVolume`/`domeVolume`/`totalE` formulas and the
same `buildSteps`/`taperFactor`/`baseExtraMm`/`baseDwellMs`/`dwellMs`
parameters, so the root really is what a `blobDot` of `rootDiameter`
would deposit. Added `retractAtMm` (default 2.0mm, clamped to
`[0, hairLength]`) so the retract fires partway into the pull instead of
only at the very end, with a new `postRetractDwellMs` dwell mirroring
`emitBlobDot`'s own dwell-after-retract. Updated `texture_functions.js`
docstrings, `texture_patterns.md`, and `troubleshooting.md` §12.

**Given**:
`test_print_gcode/20260826-180025_hairy-dot-v3-blobdot-root-midpull-retract.gcode`
-- calibration line x=120-180 y=115, then 7 hairy dots (rootDiameter=2mm,
hairThickness=0.5mm, hairLength=8mm, retractAtMm=2mm, overtravelMm=20mm)
from x=70 to x=100, y=100. Verified by hand: root build matches
`emitBlobDot`'s formula exactly (first step `E2.2773`, dome top
Z1.200); retract fires at Z3.200 (dome top + `retractAtMm`); dwell
`G4 P500`; remaining pull to Z9.200 (dome top + `hairLength`); overtravel
to Z29.200. 10 negative-E lines, matching expected. **Not yet
print-tested.**

---

## 34. Hairy dot v4: redesigned around the X-Hair paper's Two-Step Suspend Printing

**Asked**: "Can you also check this pdf for more information on hairy
texture?" -- `sewingeditor/texture_docs/3654777.3676360.pdf`. (The path
didn't come through automatically; asked the user directly and they
provided it after a couple of exchanges. `pdftoppm`/`pdftotext` weren't
installed for the Read tool's PDF pipeline -- installed poppler via
`scoop install poppler` and used `pdftotext -layout` directly to extract
the paper's text since the Read tool's own process didn't pick up the
newly-installed binary on PATH mid-session.)

**Given**: the PDF is Wang et al., *"X-Hair: 3D Printing Hair-like
Structures with Multi-form, Multi-property and Multi-function"* (UIST
'24). Reported its findings to the user and asked how to proceed; user
chose to implement immediately. Two corrections applied to
`emitHairyDot`:
1. The first pull segment now genuinely EXTRUDES WHILE MOVING (a real
   bead, via the shared `eRate()` helper), matching the paper's
   "Extrude" step -- v1-v3 deposited everything stationary beforehand
   and pulled with zero extrusion the whole way, which the user's own
   framing in the previous turn ("the extrusion should stop by 8mm") had
   actually anticipated correctly. `pullExtrudeMm` (renamed from v3's
   `retractAtMm`, since it no longer marks where the retract fires) /
   `hairLength` is exactly the paper's Extrusion Length Ratio (α).
2. The retract now fires ONCE, after the full `hairLength` pull (the
   paper's "Z-hop" step, which comes after their "Stringing" step, not
   between it and "Extrude") -- reverting v3's mid-pull retract timing,
   now that the real reason for wanting an early cutoff (only extrude
   for part of the distance) is handled correctly by the new Extrude/
   String split instead.
3. `hairSpeed` (the zero-extrusion "String" segment's speed) changed
   from a thickness-derived formula (thicker = slower, v1-v3) to a flat
   default of 8000mm/min, matching the paper's validated 7000-9000mm/min
   range for their critical parameter -- `hairThickness` now only sets
   the extrude segment's bead cross-section, not speed. Flagged
   explicitly, in both code comments and docs, that the paper's numbers
   are PLA on a different printer, not TPU-validated.
Updated the `emitHairyDot` docstring (now cites the paper), rewired
`freeformHairyDotted`'s parameter list to match, and rewrote the "Hairy
dot" section of `texture_patterns.md` and `troubleshooting.md` §12 (also
fixed a stray duplicated sentence left at the end of §11 from an earlier
edit).

**Given**:
`test_print_gcode/20260826-180815_hairy-dot-v4-xhair-two-step.gcode` --
calibration line x=120-180 y=110, then 7 hairy dots (rootDiameter=2mm,
hairThickness=0.5mm, hairLength=8mm, pullExtrudeMm=2mm,
overtravelMm=20mm, `hairSpeed`/`pullExtrudeSpeed` at their new defaults)
from x=70 to x=100, y=90. Verified by hand: root build unchanged from v3
(dome top Z1.200); extrude segment `G1 Z3.200 E0.2702 F1000` matches
`eRate(0.5, 0.5, 1.3) × 2.0mm = 0.27026`; string segment `G0 Z9.200
F8000` matches dome top + `hairLength`, at the new speed; retract fires
once, after the string segment; overtravel `G0 Z29.200 F600` matches
+20.0; next dot's `goto()` correct. 10 negative-E lines, matching
expected. **Not yet print-tested** -- and since v3 wasn't print-tested
either before v4 superseded it, a hardware result on v4 won't by itself
show whether the root-build change (v3) or the Two-Step mechanism change
(v4) is what mattered.

---

## 35. Hairy dot v5: moved the retract back right after the extrude segment

**Problem reported**: user printed v4 and found "It still strings the
whole z-lift though?" -- visible stringing along the entire pull, not a
clean short hair.

**Given** (diagnosis, not a fresh guess -- matches an already
hardware-confirmed mechanism): v4 retracted only at the very end of the
full `hairLength` + `overtravelMm` pull, matching X-Hair's own step
order ("Z-hop" after "Stringing"). But this function's root is a
`blobDot`-style dome build, which -- per this same section's v10 entry
for `emitBlobDot`, also hardware-confirmed -- stores real residual melt
pressure from TPU's compressibility that keeps oozing regardless of the
E-axis for a while after a build burst. X-Hair's own foundation (a plain
printed wall) isn't under that kind of pressure, so their late-retract
timing doesn't carry the same risk. Waiting until the very end of the
pull gave the residual pressure the entire ~28mm distance to keep
oozing before the retract finally cut it off.

**Given** (fix): moved the retract to fire immediately after the
extrude segment (`pullExtrudeMm`) instead of after the string segment,
with a new `postRetractDwellMs` (default 500ms, mirrors `emitBlobDot`'s
own dwell-after-retract) in between. This functionally restores this
function's own v3 retract timing (which had already tried retracting
mid-pull for the same reason, before v4 reverted to match the paper's
literal order) while keeping v4's real improvement -- an actual
extruded bead for the first segment via `eRate()`, not v1-v3's
all-stationary deposit. For `left`/`right`/`bottom` directions, the
`clearanceZ` hop was reordered to happen after the retract+dwell instead
of before the string segment directly. Updated the `emitHairyDot`
docstring, `freeformHairyDotted`'s parameter list, `texture_patterns.md`
(full rewrite of the Hairy dot section, including the v4 hardware result
in its Hardware status line), and `troubleshooting.md` §12.

**Given**:
`test_print_gcode/20260826-181636_hairy-dot-v5-retract-after-extrude.gcode`
-- same test parameters as the printed v4 file (rootDiameter=2mm,
hairThickness=0.5mm, hairLength=8mm, pullExtrudeMm=2mm,
overtravelMm=20mm), calibration line x=120-180 y=105, 7 hairy dots from
x=70 to x=100, y=80. Verified by hand: extrude segment unchanged (`G1
Z3.200 E0.2702 F1000`); retract `G1 E-1.3000 F900` now fires
IMMEDIATELY after that line (previously only after the string segment);
`G4 P500` (`postRetractDwellMs`) follows; string segment `G0 Z9.200
F8000` and overtravel `G0 Z29.200 F600` unchanged in distance/speed,
just now entirely after the retract. 10 negative-E lines, matching
expected. **Not yet print-tested** -- this is a direct fix for a
confirmed v4 problem, but the fix itself still needs a hardware result
before being treated as settled.

---

## 36. Hairy dot v5 printed (partial success); follow-up gap=3mm/hairLength=10mm test

**Problem reported / confirmed** (positive this time): "Actually it is
kind of working, the extrude segment become roughly the length of the
hair." Moving the retract to right after the extrude segment (v5) did
reduce the whole-pull stringing seen in v4. Also surfaced an open
question, not yet root-caused: the visible hair length seems to track
`pullExtrudeMm` (the real extruded bead) rather than the full
`hairLength`, suggesting the zero-extrusion STRING segment after the
retract may not be adding much visible length. No code change made for
this yet -- logged in `troubleshooting.md` §12 to track across further
tests.

**Asked**: try a smaller `gap` (5mm -> 3mm) and a longer `hairLength`
(8mm -> 10mm), same v5 mechanism and other parameters unchanged.

**Given**: no code change -- parameters passed as generation-script
options, same pattern as prior parameter-only tests. Updated
`texture_patterns.md`'s Hairy dot header and Hardware status paragraph
to record the partial v5 confirmation and the open question, and added
the follow-up test to `troubleshooting.md` §12.

**Given**:
`test_print_gcode/20260826-182625_hairy-dot-v5-gap3-len10.gcode` --
calibration line x=120-180 y=100, then 11 hairy dots (rootDiameter=2mm,
hairThickness=0.5mm, hairLength=10mm, pullExtrudeMm=2mm,
overtravelMm=20mm, gap=3mm) from x=70 to x=100, y=70. Verified by hand:
dot x-positions exactly 3mm apart (70, 73, 76, ..., 100, 11 dots total);
extrude segment unchanged (`G1 Z3.200 E0.2702 F1000`); retract and
`postRetractDwellMs` unchanged; string segment now reaches `G0 Z11.200
F8000` (dome top 1.2 + `hairLength` 10.0, up from 9.200 at the old
8mm); overtravel `G0 Z31.200 F600` (+20.0); next dot's `goto()` lifts
correctly to `G1 Z31.600`. 14 negative-E lines (3 calibration + 11
dots), matching expected. **Not yet print-tested.**

---

## 37. Hairy dot v6: hairLength redefined as the extrude distance, retractMm raised to 4mm

**Asked**: "Actually it is kind of working, the extrude segment become
roughly the length of the hair" was clarified further: "the extrude
segment actually is more efficient in defining the hair length... for
TPU, somehow it seems that the string from the stringing becomes very
soft and can be ignored from the hairy texture." Explicit instruction:
extrude for 10mm, dwell a bit, then do the (now secondary) string
segment and overtravel -- "don't be too constrained by what the blob
used to do." Separately asked why `retractMm` defaulted to 1.3mm, then
asked to raise it to 4mm "but maintain the global speed that does not
damage TPU."

**Given**: this is a deliberate departure from X-Hair's own paper, based
on TPU-specific hardware behavior, not a paper-following change like
v4/v5 were. `hairLength` now defines the EXTRUDE segment's own length
directly (previously the TOTAL pull distance, with a separate
`pullExtrudeMm` marking how much of it was extruded -- that parameter is
removed entirely). The retract still fires immediately after the
extrude segment (v5's anti-ooze fix, unchanged). A new `stringMm`
(default 2.0mm) parameter controls a small, independent fast
zero-extrusion finishing pull after the post-retract dwell -- X-Hair's
own "Stringing" step, demoted from length-definer to a cosmetic
finishing touch. Confirmed `RETRACT_SPEED` (900mm/min, already slowed
project-wide specifically to avoid TPU drive-gear damage) is independent
of `retractMm` (the distance) and already applies unconditionally in
this function's retract line -- raised `retractMm`'s default from the
plain shared global default (1.3mm) to 4.0mm, matching `blobDot`'s own
dot-specific override, with the speed untouched. Rewrote the
`emitHairyDot` docstring, updated `freeformHairyDotted`'s parameter
list, rewrote the "Hairy dot" section of `texture_patterns.md` (now v6,
full parameter table and hardware-status history across all six
versions), and added the v6 entry to `troubleshooting.md` §12.

**Given**:
`test_print_gcode/20260826-183902_hairy-dot-v6-extrude-defines-length.gcode`
-- calibration line x=120-180 y=95, then 11 hairy dots (rootDiameter=2mm,
hairThickness=0.5mm, hairLength(extrude)=10mm, stringMm=2mm,
overtravelMm=20mm, retractMm=4mm, gap=3mm) from x=70 to x=100, y=60.
Verified by hand: first-step deposit `E4.9773` correctly reflects the
new 4.0mm `retractMm` prime restoration (up from `E2.2773` at the old
1.3mm, an exact +2.7mm difference); extrude segment now lays a real
10mm bead, `G1 Z11.200 E1.3512 F1000` (matches `eRate(0.5, 0.5, 1.3) x
10.0`); retract `G1 E-4.0000 F900` fires immediately after, at the new
4.0mm distance; dwell `G4 P500`; string segment `G0 Z13.200 F8000`
matches 11.2 + `stringMm` 2.0; overtravel `G0 Z33.200 F600` matches
13.2 + 20.0; next dot's `goto()` correctly lifts to `G1 Z33.600`. 14
negative-E lines, matching expected. **Not yet print-tested.**

---

## 38. Added a "test mode" to `Task_FineTune.md` (calibration-line placement only)

**Asked**: add a test mode to `Task_FineTune.md` that covers the per-print
y movement and is new — but instead of the usual calibration line
(horizontal, `x=120→180`), in test mode the calibration line is vertical
at x=200, y=40 to ~100 (per the current calibration length), and each
subsequent test-mode print moves it −3mm in x; once it reaches x=160,
reset to x=200 with the y-band at 110; when that column fills too, wrap
back to the x=200 / y=40 band. Only in test mode.

**Given**: new §6 "Test mode" in `Task_FineTune.md`. Clarified with the
user first: (1) the texture under test is positioned exactly as in normal
mode (its y descends 5–10mm per file from the previous file) — test mode
changes only the calibration line; (2) after the second (y=110) column
also marches to x≤160, wrap back to the first column (x=200, y=40),
assuming earlier prints have been cleared. Spelled out the wrap threshold
as "the next −3mm step would put the stripe at x ≤ 160", the vertical
`freeformSolid` path functions (`xFunc = () => X`, `yFunc = t => 40 + t`,
`tEnd = <calibration length>`), a `-testmode` filename marker so the
independent test-mode x-march sequence isn't cross-continued with §3's
descending-y sequence, and a bed-margin/layout note. Added a pointer to §6
from the §3 calibration-line bullet. No `texture_functions.js`,
`texture_patterns.md`, or `troubleshooting.md` change — like the normal
calibration convention, this is a test-harness rule built inline per
generation script. No G-code generated this turn.

---

## 39. Hairy dot v7: `hairThickness` derived from `hairLength`; `rootDiameter` a feel knob

**Problem reported** (from printing the v6 file): (a) at the fixed 0.5mm
`hairThickness`, a 4-5mm hair holds up but a 10mm hair "flops a lot
more" -- longer hair needs to be thicker; (b) `rootDiameter` (base
diameter) visibly changes how soft/tough the hair feels -- smaller base
= softer, bigger = tougher -- and the user wants it treated as a real
parameter, not a fixed value.

**Asked**: make base diameter a parameter; consider that longer hair
needs to be thicker (couple thickness to length). Then print at x=20,
y=200 a 30mm hairy-dotted line with 2mm base / 5mm hair, and right after
it a 30mm line with 3mm base / 5mm hair.

**Given** (**v7**):
- `hairThickness` default `0.4` -> `null` in `emitHairyDot` and
  `freeformHairyDotted`. When `null`, it's derived as
  `0.5 * (hairLength / 4.0)`, clamped 0.4-2.0mm -- anchored at the one
  known-good point (~0.5mm at a 4mm hair), scaled linearly. Explicit
  numbers still override. Inline in `emitHairyDot` (`HAIR_T_REF` /
  `HAIR_L_REF`), same "starting-point formula, not calibrated across its
  range" caveat as the `hairSpeed` derivation.
- `rootDiameter` unchanged mechanically but documented as an explicit
  softness/toughness knob, and kept OUT of the thickness derivation on
  purpose so the two effects stay separable.
- Updated `emitHairyDot` docstring (new v7 block + `hairThickness` note),
  `texture_patterns.md` (Hairy dot header -> v7, both signatures ->
  `hairThickness = null`, new v7 mechanism note, `rootDiameter` /
  `hairThickness` / `hairLength` table rows, Hardware status), and
  `troubleshooting.md` §12 (v6 print result + full v7 entry). Clarified
  with the user first: this print is in **test mode** (Task_FineTune.md
  §6) -- so the calibration line is the vertical stripe, not the
  horizontal x=120-180 line; texture positions are explicit overrides.
  Also added `gen_template.mjs` (reference generation script that prints
  a verification digest) and §7 "token-cost discipline" to
  `Task_FineTune.md`.

**Given**:
`test_print_gcode/20260827-100409_hairy-dot-v7-testmode-basediameter-2vs3-len5.gcode`
-- **test mode**, so the calibration line is a vertical `freeformSolid`
stripe at x=200, y=40->100 (first test-mode print, so the stripe is at
its starting x=200); then line A (`rootDiameter` 2mm, `hairLength` 5mm)
at x=20-50 y=200 and line B (`rootDiameter` 3mm, `hairLength` 5mm) at
x=20-50 y=190, `gap` 5mm -> 7 dots each. The wrong first cut of this file
(20260827-095250, horizontal calibration) was deleted. Both lines hold
`hairLength` at
5mm so the derived thickness (0.625mm) is identical on both -- isolating
the base-diameter effect. Verified by hand: extrude segment `E1.0556` on
both lines (`eRate(0.625,0.625,1.3) x 5`); line A root first step
`G1 Z0.367 E4.9773 F120`, dome top Z1.200; line B root first step
`G1 Z0.450 E5.7755 F120`, dome top Z1.700, no-bonus second dot `E5.4755`;
retract `E-4.0000` immediately after each extrude segment; string /
overtravel zero-E; calibration stripe confirmed vertical (`G0 X200.000
Y40.000` then `G1 X200.000 Y40.100 E…`, x fixed, y increasing);
`verifyLayout` ok (no overlap/warnings); 17 negative-E lines
(1 + 2 + 7 + 7), footer skips its own retract. **Not yet print-tested.**

---

## 40. Hairy dot v8: `beadFlowMult` -- thicker step-1 bead by default

**Problem reported / asked**: the hair was still flopping. "Increase the
amount of filament extruded when extruding a real bead (step 3), increase
the multiplier so by default it is thicker." Then: print a 1mm base /
3mm length line and a 2mm base / 3mm length line now.

**Given** (**v8**):
- New `beadFlowMult` parameter (default **2.0**) in `emitHairyDot` +
  `freeformHairyDotted` (wired through the pass-through). It multiplies
  the step-1 extruded bead's E on top of `extrusionMultiplier`, via
  `eRate(effThickness, effThickness, extrusionMultiplier * beadFlowMult)`
  -- effective bead flow 1.3 · 2.0 = 2.6× the geometric rate.
- Deliberately a **separate** knob from `extrusionMultiplier`, because
  that one also scales the root dome's volume model (hardware-confirmed
  accurate, §10 v2) -- `beadFlowMult` touches only the bead, never the
  root. Documented "dial toward 1.0 if it comes out too fat".
- Updated the `emitHairyDot` docstring (new v8 block), `texture_patterns.md`
  (Hairy dot header → v8, both signatures, step-1 mechanism note, new
  `beadFlowMult` table row, new v8 mechanism paragraph, Hardware status),
  and `troubleshooting.md` §12 (v7 marked superseded, full v8 entry).

**Given**:
`test_print_gcode/20260827-100902_hairy-dot-v8-testmode-beadflow-1vs2mm-len3.gcode`
-- **test mode**, SECOND test-mode print, so the vertical calibration
stripe marched from x=200 → **x=197** (y-band 40→100 unchanged). Two 30mm
hairy-dotted lines, `gap` 5mm (7 dots each): line A `rootDiameter` 1mm at
y=180, line B `rootDiameter` 2mm at y=170 (texture y descends 10 from the
previous test-mode file's lowest line at y=190), both `hairLength` 3mm.
Verified by hand: step-1 bead `E0.5189` on both lines
(`eRate(0.4, 0.4, 2.6) × 3`, exactly 2× the `E0.2594` it would have been
at v7's flow); root dome untouched -- line A first step
`G1 Z0.283 E4.6580 F120` (dome top Z0.700), line B `G1 Z0.367 E4.9773
F120` (dome top Z1.200, identical to v7's line-B numbers); bead E
identical on both lines so only the root differs; retract `E-4.0000`
right after each bead; string/overtravel zero-E; calibration stripe
vertical at x=197; 17 negative-E lines (1 + 2 + 7 + 7); footer skips its
own retract. **Not yet print-tested.**

---

## 41. Hairy dot v9: slower + fatter step-1 bead (`pullExtrudeSpeed` 500, `beadFlowMult` 3.5)

**Asked**: "Can slow down the z up movement when it is extruding.
probably F500? And increase the flow multiplier a bit. maybe try 3.5.
Make the gap between hair 3mm now. Do the same thing 1mm and 2mm base
with same length."

**Given** (**v9**):
- `pullExtrudeSpeed` default 1000 → **500mm/min** (step-1 bead's Z-rise
  feedrate — slower rise, denser bead).
- `beadFlowMult` default 2.0 → **3.5** (effective bead flow
  `extrusionMultiplier · beadFlowMult` = 1.3 · 3.5 = 4.55× the geometric
  `eRate`). Root dome still untouched by it.
- Both changed in `emitHairyDot` + `freeformHairyDotted` signatures.
  Updated the `emitHairyDot` docstring (new v9 block, `pullExtrudeSpeed`
  note, `beadFlowMult` comment), `texture_patterns.md` (header → v9, both
  signatures, step-1 mechanism note, v8/v9 mechanism paragraph, both
  table rows, Hardware status), and `troubleshooting.md` §12 (v8 marked
  superseded, full v9 entry).

**Given**:
`test_print_gcode/20260827-102001_hairy-dot-v9-testmode-slowbead-flow3p5-gap3-1vs2mm-len3.gcode`
— **test mode**, THIRD test-mode print, so the vertical calibration
stripe marched x=200 → 197 → **x=194** (y-band 40→100). Two 30mm
hairy-dotted lines, **`gap` 3mm** (11 dots each, x = 20,23,…,50): line A
`rootDiameter` 1mm at y=160, line B `rootDiameter` 2mm at y=150 (texture
y descends 10 from the previous file's lowest line at y=170), both
`hairLength` 3mm. Verified by hand: step-1 bead `E0.9080` at `F500` on
both lines (`eRate(0.4, 0.4, 4.55) × 3` = 1.75× the v8 `E0.5189`,
F500 vs v8 F1000); root dome unchanged (line A first step `G1 Z0.283
E4.6580 F120`, dome top Z0.700; line B `G1 Z0.367 E4.9773 F120`, dome
top Z1.200); bead E identical on both lines so only the root differs;
retract `E-4.0000` right after each bead; string/overtravel zero-E;
calibration stripe vertical at x=194; 25 negative-E lines (1 + 2 + 11 +
11); footer skips its own retract; no stray E. **Not yet print-tested.**

---

## 42. Hairy dot v10: Z-up speed matched to filament feed speed, then a dry rise

**Asked**: "lower the F to F150 ... make sure the F here is always the
same as the F for the filament. Actually make it slightly slower like
-10mm/min so that the extrusion finishes first before the Z rises to the
right height ... the Z-up speed should be roughly the same as the
filament extrusion speed" (the last part flagged as the more important
one). Then: try again with 1mm and 2mm base, same length.

**Given** (**v10**): a single `G1 Z.. E.. F..` move can't match the Z
rate to the filament rate (F is the Z rate; E is slaved to finish
together), so the Extrude step is now **split in two**:
1. `G1 Z(domeTop + eA) E(eA) F(pullExtrudeSpeed)` — Z rises by exactly
   `eA` mm (the filament amount) while extruding `eA`, so both the Z rate
   and the actual filament rate are `pullExtrudeSpeed`.
2. `G1 Z(domeTop + hairLength) F(pullExtrudeSpeed − dryRiseFeedDrop)` —
   no extrusion, finishing the climb to full height, `dryRiseFeedDrop`
   (new param, default 10) mm/min slower.
Same split for the horizontal directions (XY instead of Z). If
`eA ≥ hairLength`, move 2 is skipped. `pullExtrudeSpeed` default
500 → **150**. Root dome untouched. Updated the `emitHairyDot` docstring
(v10 block, `pullExtrudeSpeed`/`dryRiseFeedDrop` notes), both signatures
+ the `freeformHairyDotted` pass-through, `texture_patterns.md` (header →
v10, signatures, Mechanism step 1 split, v10 paragraph, both table rows +
new `dryRiseFeedDrop` row, Hardware status), and `troubleshooting.md`
§12 (v9 superseded, full v10 entry).

**Given**:
`test_print_gcode/20260827-103219_hairy-dot-v10-testmode-matchedfeed-drypull-1vs2mm-len3.gcode`
— **test mode**, FOURTH test-mode print, calibration stripe marched to
**x=191** (vertical, y-band 40→100). Two 30mm hairy-dotted lines, `gap`
3mm (11 dots each): line A `rootDiameter` 1mm at y=140, line B 2mm at
y=130, both `hairLength` 3mm. Verified by hand: line A split
`G1 Z1.608 E0.9080 F150` (Z rises 0.908mm = E 0.908mm → both axes at
150mm/min) then `G1 Z3.700 F140` (dry rise, no E); line B
`G1 Z2.108 E0.9080 F150` then `G1 Z4.200 F140`; `eA` unchanged from v9;
root dome unchanged (line A `G1 Z0.283 E4.6580 F120`, line B `G1 Z0.367
E4.9773 F120`); retract `E-4.0000` right after the dry rise; string/
overtravel zero-E; 25 negative-E lines (1 + 2 + 11 + 11); footer skips
its own retract. **Not yet print-tested.**

---

## 43. Hairy dot v10 printed — tentative-positive

**Problem reported / confirmed** (positive): user printed the v10 file
and said **"Printed, I think it is working."** First non-superseded
hardware feedback since v6. Not a firm confirmation, but the v10 split
(matched Z/filament feedrate during deposition + a `dryRiseFeedDrop`
-slower no-extrusion rise to finish the height) did not break anything
and appears to help.

**Given**: no code change. Updated the Hardware status paragraph in
`texture_patterns.md` and the v10 section of `troubleshooting.md` §12 to
record the tentative-positive result and to say v10's split mechanism is
provisionally good — keep it unless a later print contradicts.

**Asked** (double thickness): "try double thickness of the hair with
base 1mm and 2mm too." Flagged that doubling `hairThickness` to 0.8mm
(from the 0.4mm derived) pushes the bead's per-mm deposit to ~1.21mm/mm
(thickness is squared in the model, `beadFlowMult` 3.5 still on top),
above 1.0 — which breaks v10's matched-feedrate split. Offered three
resolutions; **user chose: clamp to `hairLength`** (keep `beadFlowMult`
3.5, one extrude move over the full rise, no dry rise, feed not matched
— exactly what the v10 code already does when `eA ≥ hairLength`).

**Given**: no code change — call-site `hairThickness: 0.8` override,
same pattern as prior per-test parameter sweeps.
`test_print_gcode/20260827-104355_hairy-dot-v10-testmode-thick0p8-clamped-1vs2mm-len3.gcode`
— test mode, FIFTH test-mode print, calibration stripe marched to
**x=188**. Two 30mm hairy-dotted lines, `gap` 3mm: line A `rootDiameter`
1mm at y=120, line B 2mm at y=110, both `hairLength` 3mm,
`hairThickness` 0.8. Verified by hand: extrude segment `G1 Z3.700
E3.6320 F150` (line A) / `G1 Z4.200 E3.6320 F150` (line B) — a single
move over the full 3mm rise, **no dry rise** (eA 3.632 > hairLength 3),
E is 4× v10's `E0.9080` (thickness doubled → squared → 4×); root dome
unchanged (line A `G1 Z0.283 E4.6580 F120`, line B `G1 Z0.367 E4.9773
F120`); retract `E-4.0000` right after; string/overtravel zero-E; 25
negative-E lines; no stray E; footer skips its own retract. **Not yet
print-tested.**

---

## 44. Hairy dot v11: polar (2-angle) pull direction + `stampOrder`

**Asked**: (1) directional hair pull defined like polar coordinates —
one angle for the compass direction, one for the tilt from flat — named
accordingly; keep the 4 string presets; `"top"` stays the default. (2) a
way to stamp the dot line so the next dot doesn't hit the previous
strand (if the hair leans right, start from the right). Then print the
same thing (thickness as before) at azimuth 30° / elevation 45°, 1mm
and 2mm base.

**Given** (**v11**):
- New `hairAzimuthDeg` (CCW from +X) and `hairElevationDeg` (0 = flat
  along the bed, 90 = straight up) on `emitHairyDot` + `freeformHairyDotted`.
  New module helper `resolveHairDir()` maps either the `hairDirection`
  string preset (`top` = el 90; `right`/`left`/`bottom` = el 0 at
  az 0/180/270) or the explicit angles to a unit vector `(dx,dy,dz)`.
  Explicit angle (either non-null) wins over the string.
- The two pre-v11 pull branches (pure Z / pure XY) collapse into one
  `pull(d,e,f,rapid)` closure walking the vector. It writes only the
  axes that move, so **all four presets' emitted G-code is unchanged**
  (verified `top`/`right`/`left`/`bottom` directly). `clearanceZ` hop
  now gated on `hairElevationDeg` < 30.
- New `stampOrder` on `freeformHairyDotted` (`"auto"` default). `"auto"`
  reverses the stamp order when the hair azimuth leans forward along the
  path, so each strand trails behind its dot.
- Updated `emitHairyDot` docstring (v11 block, direction paragraph,
  `resolveHairDir` doc), both signatures + the pass-through,
  `texture_patterns.md` (header → v11, signatures, Mechanism direction
  note, `hairDirection`/`hairAzimuthDeg`/`hairElevationDeg`/`clearanceZ`
  rows, `stampOrder` on the Hairy-dotted line entry, Hardware status),
  and `troubleshooting.md` §12 (full v11 entry + the XY-reach caveat for
  `verifyLayout`).

**Given**:
`test_print_gcode/20260827-105639_hairy-dot-v11-testmode-polar-az30-el45-1vs2mm-len3.gcode`
— test mode, SIXTH test-mode print, calibration stripe at **x=185**. Two
30mm hairy-dotted lines, `gap` 3mm: line A `rootDiameter` 1mm y=100, line
B 2mm y=90, both `hairLength` 3, `hairThickness` 0.8, `hairAzimuthDeg` 30,
`hairElevationDeg` 45. Verified by hand: pull vector dx 0.6124 / dy
0.3536 / dz 0.7071; line A first dot `G1 X51.837 Y101.061 Z2.821 E3.6320
F150` (one move, clamped — `eA` 3.632 > `hairLength` 3), no clearance hop
(el 45), string `G0 X53.062 Y101.768 Z4.236 F8000`, overtravel
`G0 X54.287 Y102.475 Z5.650 F600`; `"auto"` reversed the stamp order
(dots x = 50, 47, … 20 on both lines); all 4 presets unchanged; 25
negative-E lines; no stray E; footer skips its retract; `verifyLayout`
ok with hair reach (rx 4.29, ry 2.47). **Not yet print-tested.**

---

## 45. New texture: directional (leaning) blob dot

**Asked**: a variant of `blobDot` that leans in a compass direction —
during the build it moves `radius` in the azimuth direction as it rises
to the dome top; after the orbit it recenters on the (leaning) apex and
travels diagonally down to bed level in a move whose length = `diameter`.
Confirmed with the user first: arbitrary `azimuthDeg` (not just x/y);
recenter target = the leaning apex; the diagonal drag goes −azimuth with
no extrusion. Then: generate a test — one line 2mm blob, one line 3mm
blob, both azimuth 0.

**Given**: new `emitDirectionalBlobDot` (private) / `directionalBlobDot`
(single) / `freeformDirectionalBlobDotted` (line). **Separate from
`blobDot`** — the v17 hardware-confirmed default is untouched (same as
`hairyDot` is separate). Reuses `blobDot`'s volume model + its
build/dwell/retract/dwell/one-orbit skeleton. Two `azimuthDeg`-driven
changes: (1) sheared build — nozzle travels `radius` in azimuth across
`buildSteps` while rising, apex ends at `(cx + r·cos az, cy + r·sin az,
domeTop)`; (2) post-orbit — recenter onto that apex, then one
no-extrusion `G1` move down to `baseZ` heading −azimuth, 3D length =
`diameter` (Z drop = radius, so XY leg = √3·radius, ending ≈0.73·radius
past centre). Orbit unchanged (around `(cx,cy)`, `orbitRadius` = radius,
`orbitLoops` 3). New params: `azimuthDeg` (0), `dragSpeed` (600); the v16
lift/second-orbit params are not carried over.
`freeformDirectionalBlobDotted` also gets `stampOrder` (default `"auto"`,
same logic as `freeformHairyDotted`). Added `texture_patterns.md`
entries (Directional blob dot under Dots, Directional blob-dotted line
under Line) and `troubleshooting.md` §13 (design record).

**Given**:
`test_print_gcode/20260827-111012_dirblob-v1-testmode-az0-2vs3mm.gcode`
— test mode, SEVENTH test-mode print, calibration stripe at **x=182**.
Two 30mm lines, `gap` 10 (4 dots each), `azimuthDeg` 0: line A `diameter`
2mm at y=80, line B `diameter` 3mm at y=70. Verified by hand: line A
first dot at (50,80) — sheared build `G1 X50.167 … Z0.367 E4.9773` …
`G1 X51.000 … Z1.200` (X +1.0 = radius, Y fixed), retract `E-4.0000`,
3× orbit radius 1 at Z1.200, recenter `G0 X51.000 Y80.000`, drag
`G1 X49.268 Y80.000 Z0.200 F600` (ΔX −√3·r, ΔZ −r, 3D length **2.000 =
diameter**, no E); line B drag `G1 X18.902 Y70.000 Z0.200 F600`
(apexX 21.5 − √6.75). `stampOrder: "auto"` reversed both lines (x = 50,
40, 30, 20). 11 negative-E lines (1 + 2 + 4 + 4); no stray E; footer
skips its retract; `verifyLayout` ok. **Not yet print-tested.**

---

## 46. Directional blob dot v2: orbit + recenter removed; `gap` 3

**Asked** (after reviewing the v1 file): "I don't think there is any need
for the circular movement anymore, so after it goes to the top, recenter
(i guess this is not needed) and move down straight away. Make the gap be
3mm."

**Given** (**v2**): removed the dome-height orbit AND the recenter from
`emitDirectionalBlobDot` — `orbitRadius` / `orbitPts` / `orbitSpeed` /
`orbitLoops` deleted from both signatures (and the pass-through), per the
codebase convention of deleting unused params rather than zeroing them.
New sequence: build → dwell(`dwellMs`) → retract → dwell
(`postRetractDwellMs`) → diagonal drag (from the leaning apex, where the
nozzle already is) → next dot. The drag is now the only post-build
shaping; noted it still sweeps the tip through/past the blob so it should
also catch residual string. Updated the `emitDirectionalBlobDot`
docstring, `texture_patterns.md` (both entries → v2, signatures,
mechanism, param table), `troubleshooting.md` §13 (v2 entry), and
`global_printing_parameters.md`'s retraction-table note.

**Given**:
`test_print_gcode/20260827-111953_dirblob-v2-testmode-noorbit-gap3-az0-2vs3mm.gcode`
— test mode, EIGHTH test-mode print, calibration stripe at **x=179**.
Two 30mm lines, **`gap` 3** (11 dots each), `azimuthDeg` 0: line A
`diameter` 2mm y=60, line B `diameter` 3mm y=50. Verified by hand: line A
first dot at (50,60) — sheared build to apex (51.0, 60, 1.2), `G4 P2000`,
retract `E-4.0000`, `G4 P2000`, **straight to `G1 X49.268 Y60.000 Z0.200
F600`** (3D length 2.000 = diameter, no E) — **no orbit/recenter line in
between**. `stampOrder: "auto"` reversed both lines (x = 50, 47, … 20).
25 negative-E lines (1 + 2 + 11 + 11); no stray E; footer skips its
retract; `verifyLayout` ok. **Not yet print-tested.**

## 47. Directional blob dot v3: squish-then-drag; `gap` defaults to `diameter`

**Asked** (after the v2 print): "the downward movement, instead of making
it a diagonal movement down, make it go down the z first (kind of
squishing the blob down) before it does x/y movement. Can you try that
again with the same parameters? Also, the gap should be the same as the
diameter of the blob, put this part in the function too."

**Given** (**v3**), two changes:

1. **Drag split into squish-then-drag.** v2's single diagonal
   `G1 X.. Y.. Z.. F<dragSpeed>` becomes `G1 Z<baseZ> F<dragSpeed>`
   (straight down from the leaning apex, squishing the blob) followed by
   `G1 X<endX> Y<endY> F<dragSpeed>` (pure lateral drag by `diameter` in
   the −azimuth direction, ending at `cx - radius*ax`). Neither move
   carries `E`.
2. **`gap` default `10.0` → `null`, resolving to `diameter`.**
   `freeformDirectionalBlobDotted` now uses `const g = gap ?? diameter`;
   `g` drives the stop spacing and the `stampOrder` tangent check. Pass
   an explicit `gap` to override.

Removed the now-unused `domeTop` local. Updated the
`emitDirectionalBlobDot` docstring, `texture_patterns.md` (both entries →
v3, signature, mechanism, `gap` note), `troubleshooting.md` §13 (v3
entry), and `global_printing_parameters.md`'s retraction-table note.

**Given**:
`test_print_gcode/20260827-113000_dirblob-v3-testmode-squishdrag-gapEQdia-az0-2vs3mm.gcode`
— test mode, NINTH test-mode print, calibration stripe at **x=176**. Two
30mm lines, `azimuthDeg` 0, `gap` omitted (= diameter): line A
`diameter` 2mm y=40 → **16 dots**; line B `diameter` 3mm y=30 → **11
dots**. Verified by hand: line A first dot at (50,40) — sheared build to
apex (51.0, 40, 1.2), `G4 P2000`, retract `E-4.0000`, `G4 P2000`, then
**`G1 Z0.200 F600`** (squish) then **`G1 X49.000 Y40.000 F600`** (lateral
drag by diameter=2 to cx−radius = 50−1). Line B last dot drag ends
`G1 X18.500 Y30.000 F600`. 30 negative-E lines (1 + 2 + 16 + 11); no
stray E; footer skips its retract; `verifyLayout` ok; eTotal 86.66.
`stampOrder: "auto"` reversed both lines.

**PRINTED AND CONFIRMED WORKING** (user: "Printed and is working") — the
first hardware result for the directional blob dot. Squish-then-drag and
`gap` = `diameter` both hold up at `azimuthDeg` 0; nonzero azimuth still
untested. Docs updated to hardware-confirmed:
`texture_patterns.md` (Directional blob dot → "✅ hardware-confirmed
working", Hardware status paragraph added), `troubleshooting.md` §13.

## 48. Directional blob dot: default `diameter` 1.6 → 2.0; az-45 test generated

**Asked**: "try a 45deg azimuth, just one line of 2mm blob. Make this the
default size."

**Given**:

1. **Default `diameter` 1.6 → 2.0** in `emitDirectionalBlobDot`,
   `directionalBlobDot` (pass-through), and `freeformDirectionalBlobDotted`.
   The directional blob dot's defaults now diverge from `blobDot` (still
   1.6) in exactly this one value — noted in the `texture_patterns.md`
   param table and `troubleshooting.md` §13. Updated both signatures in
   `texture_patterns.md`, the "Directional blob dot" section header stays
   "✅ hardware-confirmed working" (az-0 only).
2. **az-45 test generated** (not yet printed):
   `test_print_gcode/20260827-114728_dirblob-v3-testmode-az45-2mm-default.gcode`
   — test mode, 10th test-mode print, calibration stripe at **x=173**.
   One 30mm line at y=40, `azimuthDeg` 45, `diameter` + `gap` omitted (=
   2.0, = diameter) → **16 dots**. Hand-verified: first dot (50,40)
   shears to apex **(50.707, 40.707, 1.200)** (Δ = radius·cos45 on each
   axis); retract `E-4.0000`; squish `G1 Z0.200 F600`; lateral drag
   `G1 X49.293 Y39.293 F600` (Δ = −diameter·cos45 each axis). 19
   negative-E lines (1 + 2 + 16); no stray E; footer skips its retract;
   `verifyLayout` ok; eTotal 32.63. `stampOrder: "auto"` reversed the
   line. **Nonzero azimuth is still hardware-unverified.**

## 49. Directional blob-dotted line: lean follows the path tangent

**Asked**: "when this directional blob is a line, the azimuth should
follow the line tangent at that point, so ... each blob that makes up the
line may have different azimuth. No need to test, just make sure this is
reflected in the files and docs."

**Given**: in `freeformDirectionalBlobDotted` only, `azimuthDeg` changed
from a fixed absolute heading applied to every dot → an **offset** added
to the local path-tangent heading, computed per stop from points
`±min(gap/2, 1mm)` either side of it. Default offset `0` → every dot
leans along its own direction of travel (a curve now rakes consistently
downstream); `90` = left of travel, `180` = backward. The
`stampOrder: "auto"` check evaluates the offset lean at the path start
(offset 0 ⇒ always forward ⇒ always reverses).

`emitDirectionalBlobDot` / `directionalBlobDot` (single dot) **unchanged**
— `azimuthDeg` stays absolute there. Straight-line output unchanged: on a
+X path the tangent is 0°, so `20260827-113000_...` (az 0) and
`20260827-114728_...` (az 45) both regenerate **byte-identical** —
verified. Also verified on a quarter-circle arc that per-dot lean sweeps
with the tangent (≈93° → ≈176° over 6 dots). No mechanism change, no new
print. Updated `texture_patterns.md` (Line section + single-dot
`azimuthDeg` row) and `troubleshooting.md` §13.

---

## 50. Every line-style function in one comparison print; `freeformHairyDotted` firehose at default `hairLength`

**Asked**: print every available line function, 60mm each, at x=80 with y
starting at 200 and descending by 10; pick the parameters. Then — after a
per-line breakdown and a question about the very fast retraction/extrusion
in the hairy-dotted section — regenerate just the hairy-dotted line with
the current tested settings, placed below the comparison block. Hold the
doc updates until the concurrent session (entries 45–49) stopped, then
restart the test-mode calibration stripe at **x=170**.

**Given**: no `texture_functions.js` change — all nine line functions
called via generation scripts at chosen parameters.

- `test_print_gcode/20260827-120643_all-line-functions-testmode.gcode`
  — test mode, **11th** test-mode print, vertical calibration stripe at
  **x=170** (the concurrent session had consumed x=182/179/176/173).
  Nine lines, x=80→140 (60mm), y=200 → y=120 by 10:

  | y | function | params (rest = library default) |
  |---|---|---|
  | 200 | `freeformSolid` | all default (width 0.5, nLayers 2, F400) |
  | 190 | `freeformDashed` | segLen 8, gapLen 4 → 5 dashes |
  | 180 | `freeformDotted` | gap 10 → 7 spiral discs |
  | 170 | `freeformBlobDotted` | gap 10 → 7 dots, v17 defaults |
  | 160 | `freeformDirectionalBlobDotted` | **gap 10**, azimuthDeg 0 → 7 dots; v3 squish-then-drag, diameter-2.0 default (concurrent entries 47/48) |
  | 150 | `freeformSegmented` | segLen 10 → 6 segments (E 5 / 20 alternating) |
  | 140 | `freeformVariableThickness` | all default (wavelength 8, speed 25) |
  | 130 | `freeformHairy` | all default → 13 strands (13 retracts) |
  | 120 | `freeformHairyDotted` | **hairLength 3, hairThickness 0.8, gap 3** → 21 dots (NOT the library defaults — see the finding below) |

  Verified by digest: **84 negative-E** (1 + 2 calibration + 2 + 10 + 14 +
  7 + 7 + 6 + 1 + 13 + 21), matches expected; first unit of each texture
  hand-checked (bead E-rates, dome heights, dash/dot counts, v3 dir-blob
  squish `G1 Z0.200 F600` + lateral drag `G1 X139.000 Y160.000 F600`);
  `verifyLayout` ok; eTotal 217.8.

- `test_print_gcode/20260827-120720_hairy-dotted-line-testmode-len3-thick0p8-gap3.gcode`
  — test mode, **12th** test-mode print, calibration stripe at **x=167**.
  One `freeformHairyDotted` line, x=80→140, **y=110** (one step below the
  comparison block), `hairLength` 3 / `hairThickness` 0.8 / `gap` 3 → 21
  dots. Extrude segment `G1 Z4.200 E3.6320 F150` (vs the 29.56mm firehose
  at defaults). 24 negative-E (1 + 2 + 21); `verifyLayout` ok; eTotal
  117.8.

**Finding — `freeformHairyDotted` / `hairyDot` over-extrude ~8× at bare
defaults**: `hairLength` still defaults to 10.0 (its pre-v7 value), which
derives `hairThickness` 1.25mm, which with `beadFlowMult` 3.5 puts the
extrude bead at 29.56mm of filament per dot, laid in one clamped move at
~3× the nominal feed. All recent tests (v9–v11) overrode to `hairLength` 3
/ `hairThickness` 0.8 / `gap` 3 — the real working regime. Logged in
`troubleshooting.md` §12; no default changed (would ripple through
`hairyDot`, and no one asked). `texture_patterns.md` `hairLength` row +
§12 flag it.

**Problem reported** (both files printed on real hardware): the
**segmented line** and the **variable-thickness line** are the two most
problematic of the nine — fine-tuning them is the next task. (No detail on
the other seven yet.) A first-look at the code: `freeformSegmented`'s
"fat" segment at default `esegment` 0.5 × `multiplier` 4 = **2.0mm
filament per mm of travel** (~48× a normal 0.5×0.2 bead) — almost
certainly a gross over-extrusion; and `freeformVariableThickness` accepts
a `peakDwellMs` parameter that its body never uses (dead param).

**Concurrent-session note**: entries 45–49 (directional blob dot v1→v3 +
tangent-follow) were done by a second session during this turn; its edits
to `texture_functions.js` and the docs landed via Google Drive mid-task.
Both files above were regenerated against that current code. Their first
cuts (calibration x=179 and x=173) collided with that session's stripe
positions and were deleted.

---

## 51. Segmented line v2: independent thin/fat length + width; inter-segment retract removed (cone fix)

**Problem reported** (from printing the #50 comparison file): the
`freeformSegmented` line's fat segments were visually distinct but
**cone-shaped** — a starved point at the start ramping to full flow at
the end — and the same starved-start repeated on the thin segments. Not a
clean rectangular thick/thin alternation.

**Diagnosis**: v1 retracted `retractMm` (4.0mm) between every segment
with **no matching un-retract**, so each segment's `E<eAmt>` spent its
first ~4mm refilling the retract (nozzle depressurised, nothing
deposited) before pressure — and bead width — built back up over the rest
of the segment. Fat segments recovered enough to read as fat; thin
segments barely recovered. The 4.0mm/1000 retraction really was tuned
against hardware once, but for a *faint whole line* — the same artifact —
so bumping it only masked the mechanism. Logged in `troubleshooting.md`
§14 (new section).

**Asked**: refine the function for a genuinely distinct thin vs. fat
line; generate a thin segment 0.8mm thick × 8mm long and a fat segment
1.6mm thick × 4mm long, repeating over a 60mm line, printed below the
previous hairy line. Also confirmed for the user that
`freeformDirectionalBlobDotted`'s `gap` is not hard-coded — it's a
parameter defaulting to `null`, resolving to `diameter` via
`gap ?? diameter` (concurrent session's #47), overridable.

**Given** (`freeformSegmented` **v2**, a rewrite):
- Signature: `{thinLen = 8.0, thinWidth = 0.8, fatLen = 4.0, fatWidth = 1.6, z = 0.2, speed = 400, flowMult = 1.0, eprime = 1.6, primedwellS = 1.0, retractMm = 4.0, retractSpeed = 1000, step = 0.1}`. `segLen` (was required) / `esegment` / `multiplier` / `fm` are gone — this is now the only line style with no required option.
- Each segment type gets its own length AND its own bead width. E per
  segment = `eRate(width, LAYER_HEIGHT) · segDist` (standard bead model),
  not the old `esegment × multiplier` rate.
- **Inter-segment retract removed entirely.** The line is continuous —
  no travel move between segments — so nothing needs a retract there.
  One prime at the start, one retract at the end.
- `eprime` 4.0 → 1.6mm (just over the `RETRACT_MM` the `goto` pulled),
  so the start doesn't blob against the much smaller per-segment E.
- G91/G90 XY segment walk kept (the one hardware-validated part of v1).
- Updated the `freeformSegmented` docstring, `texture_patterns.md`
  (Segmented section rewritten — header, signature, prose, param table,
  mechanism), `global_printing_parameters.md`'s retraction table row,
  and `troubleshooting.md` §14.

**Given** (file):
`test_print_gcode/20260827-122010_segmented-v2-testmode-thin0p8x8-fat1p6x4.gcode`
— test mode, **13th** test-mode print, vertical calibration stripe at
**x=164** (march 170 → 167 → 164). One `freeformSegmented` line, x=80→140
(60mm), **y=100** (one step below the y=110 hairy-dotted line), thin
0.8mm×8mm / fat 1.6mm×4mm → 10 segments (5 pairs, 8+4=12mm × 5 = 60mm
exact). Verified by digest: prime `G1 E1.6000 F150`, then **ten
consecutive `G1 X8/X4 … E0.5322 F400` moves with no `E-` line between any
of them**, then one `G1 E-4.0000 F1000`; `eRate(0.8,0.2)·8` =
`eRate(1.6,0.2)·4` = 0.5322 (equal by construction — 2× width, ½ length);
4 negative-E (1 header + 2 calibration + 1 final); `verifyLayout` ok;
eTotal 6.9. **Not yet print-tested.**

**Still open**: `freeformVariableThickness` (the other line flagged as
problematic in #50) is not touched yet — its `peakDwellMs` param is dead
(never used in the body), and its behaviour on the print hasn't been
described in detail. Next.

---

## 52. Segmented line v3: slower + more flow + per-segment dwell + boundary pressure nudge

**Problem reported** (from printing the #51 v2 file): "just printing a
solid line without much difference in thickness." The cone was fixed, but
v2's 2:1 thin/fat E-per-mm ratio (0.0665 vs 0.133 mm/mm) at `speed` 400 /
`flowMult` 1.0 was too small a difference to survive — both segments
smeared to ~nozzle width and read as one uniform line.

**Asked**: slower travel so the filament deposits well; a dwell before
each segment to make sure enough is deposited; maybe a small retract when
moving thick→thin; more filament, proportionate to thickness. "Try
again."

**Given** (`freeformSegmented` **v3**) — four changes, all from that
feedback:
- `speed` 400 → **120** mm/min.
- `flowMult` 1.0 → **1.8** — the fat segment (already 2× the thin's
  E/mm) now genuinely over-extrudes; on one layer the excess bulges
  upward, which is what reads as a raised fat segment.
- `segDwellMs` (new, **400** ms) — stationary dwell at the start of
  every segment so nozzle pressure settles to that segment's rate first.
- `transE` / `transESpeed` (new, **0.3** mm / 900) — a small stationary
  E nudge at each type boundary: **+**`transE` entering a fat segment
  (pre-charge), **−**`transE` entering a thin one (relieve). Symmetric,
  ≈ net-zero per thin+fat pair. Explicitly *not* v1's mistake: 10×
  smaller, matched, and biased toward the fat segment.
- Updated the `freeformSegmented` docstring, `texture_patterns.md`
  (Segmented section — header → v3, signature, prose, full param table
  with the four new rows), `troubleshooting.md` §14 (v2 print result +
  v3 fix), `global_printing_parameters.md`'s retraction-table row.

**Given** (file):
`test_print_gcode/20260827-123241_segmented-v3-testmode-slow-flow1p8-dwell-transE.gcode`
— test mode, **14th** test-mode print, vertical calibration stripe at
**x=161** (march 170 → 167 → 164 → 161; next −3 hits x=158 ≤ 160 → column
wrap). One `freeformSegmented` line, x=80→140 (60mm), **y=90** (one step
below the y=100 v2 line), thin 0.8mm×8mm / fat 1.6mm×4mm → 10 segments.
Verified by digest: prime `G1 E1.6000 F150`; then per segment a `G4 P400`
+ `G1 X8/X4 … E0.9579 F120` (E0.9579 = `eRate(w, 0.2, 1.8)·segLen`, 1.8×
the v2 value, still equal thin↔fat by construction); `G1 E0.3000` before
each fat move, `G1 E-0.3000` before each thin move; one `G1 E-4.0000
F1000` at the end; 8 negative-E (1 + 2 + 4 thin-entry nudges + 1 final);
`verifyLayout` ok; eTotal 11.5. **Not yet print-tested.**

**Note**: the test-mode calibration stripe has now marched x=200 → 161
across 14 prints; the next −3 step (x=158) triggers the §6 column wrap —
reset to x=200, y-band 110→170.

---

## 53. Segmented line v4: per-segment bead height + speed so the fat segment prints genuinely wider

**Problem reported** (from printing the #52 v3 file): "clear segment
demarcation between the 8mm segment and the 4mm segment, but I can't see a
difference in the thickness of the line." v3's `transE` nudge made a
visible boundary blob (the demarcation), but the segment *bodies* still
printed the same width despite a 3:1 E-per-mm ratio.

**Diagnosis**: at a fixed low nozzle Z (0.2mm) the nozzle tip physically
confines the bead — the fat segment's extra material backs up / oozes
rather than spreading sideways into a wider bead. More flow at a fixed Z
domes or blobs; it doesn't widen. Logged in `troubleshooting.md` §14.

**Clarified with the user**: "thickness" means in-plane **width** (a
single-layer line whose width varies by segment), driven by extrusion
volume + travel/extrusion speed, with volume = width × height.

**Given** (`freeformSegmented` **v4**):
- **Per-segment bead height** (`thinHeight` 0.2 / `fatHeight` 0.3), and
  the nozzle Z steps to it per segment (`G1 Z±0.1` relative, inside the
  G91 block). The fat nozzle sitting a little higher is the mechanism
  that lets its extra volume spread wide instead of doming.
- E/mm = `eRate(width, height, flowMult)` with the per-segment height —
  volume = width × height, per the user's model. Fat is now 3× the thin's
  E/mm (`eRate(1.6, 0.3, 1.4)` vs `eRate(0.8, 0.2, 1.4)`).
- **Per-segment speed** (`thinSpeed` 130 / `fatSpeed` 60) — the wide fat
  bead needs a slower pass to lay down without drag distortion.
- `transE` / `transESpeed` **removed** — the per-segment Z step marks the
  boundaries on its own, and the nudge's blob wasn't helping width.
  `flowMult` 1.8 → 1.4, `segDwellMs` 400 → 250, `z` param gone (replaced
  by the per-segment heights).
- Updated the `freeformSegmented` docstring, `texture_patterns.md`
  (Segmented section — header → v4, signature, prose, full param table
  rewritten with the height/speed pairs), `troubleshooting.md` §14 (v3
  print result + v4 fix), `global_printing_parameters.md` retraction row.

**Given** (file):
`test_print_gcode/20260827-124623_segmented-v4-testmode-perseg-height-speed-width.gcode`
— test mode, **15th** test-mode print, **column wrap**: x=161 −3 = x=158
≤ 160, so per §6 the stripe resets to **x=200, y-band 110→170** (start of
the second column). One `freeformSegmented` line, x=80→140 (60mm),
**y=80** (one step below the y=90 v3 line), thin 0.8mm×8mm×0.2h / fat
1.6mm×4mm×0.3h → 10 segments. Verified by digest: prime `G1 E1.6000
F150`; per thin `G1 X8 … E0.7450 F130`, per fat `G1 X4 … E1.1175 F60`;
`G1 Z0.100 F600` before each fat / `G1 Z-0.100 F600` before each thin,
`G4 P250` after each; one `G1 E-4.0000 F1000` at the end; 4 negative-E
(1 + 2 + 1); `verifyLayout` ok; eTotal 10.9. **Not yet print-tested.**
