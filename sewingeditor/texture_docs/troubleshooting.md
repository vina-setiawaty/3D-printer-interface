# Troubleshooting

Organized by **root-cause mechanism**, not just symptom — the same
underlying cause has repeatedly produced different-looking symptoms in
different textures throughout this project. If a new symptom doesn't
match anything below, check whether it might still be a known mechanism
before assuming it's a new problem.

---

## 1. TPU filament damage from retraction

**Symptoms this has caused**: a pattern needs manual retract/unload/reload
before it prints well again; a texture prints fine at first then
progressively degrades (later rows/segments fainter or disconnected than
earlier ones); the SAME degradation happens regardless of print direction
(top-to-bottom vs. bottom-to-top) — that direction-independence is the
diagnostic signature that rules out a positional cause (like a bed level
issue) and points at something cumulative.

**Root cause**: TPU is soft and compressible. Repeated or fast retraction
cycles can grind a flat spot into the filament at the extruder drive gear.
Once damaged, that section grips poorly — extrusion becomes unreliable
*even in later, unrelated prints*, until the filament is manually fed past
the damaged section.

**What actually fixed it, and what didn't**:
- Slowing retraction speed (global default 1500→900mm/min, `freeformSegmented` 1800→1000mm/min) — helped, but was not sufficient alone in every case.
- Increasing retraction amount for `freeformSegmented` to 4.0mm (from the shared 1.3mm default) — this was validated against real hardware, but note the amount alone wasn't the fix — see the relative-mode discussion in section 4 below; a change that looked unrelated (mode confusion) turned out to matter more for that specific pattern.
- **Reducing the NUMBER of retraction events was the most structurally effective fix found**, on the thickness-sheet texture specifically: redesigning it from ~20 retraction events (one pair per row) down to 2 (one pair for the whole texture, using a continuous serpentine path instead of retract-travel-unretract between every row) was the fix that actually addressed the mechanism, not just a symptom of it.

**If you see this symptom in a new texture**: check the retraction event
count first (count `G1 E<negative>` lines with no accompanying X/Y in the
generated G-code). If it's high relative to the pattern's actual print
time, consider whether a continuous/serpentine redesign (fewer, larger
retraction-free print runs) is possible before just tuning the retraction
amount/speed further.

**Not fully resolved**: even after the serpentine redesign, disconnection
was reported to persist through at least one further round of testing.
Treat retraction-cycle-count as A cause, verified to matter, but don't
assume it's the ONLY cause for every future report of this symptom family.

**Related but distinct mechanism**: §10 (blob dot, v10-v11) identifies a
second TPU-specific behavior -- the filament's compressibility means a
build burst can store elastic pressure that a retract doesn't instantly
relieve, so the melt can keep oozing for a while after retraction
regardless of what the E-axis is doing. That is a residual-pressure/ooze
problem, not drive-gear damage, but it is the same underlying material
property (TPU being soft/compressible) causing trouble in a different
way. If a new symptom looks like "still extruding/oozing after retract,
during a dwell or travel move with zero commanded E," check §10 before
assuming it's this section's drive-gear mechanism.

---

## 2. Nozzle collision with adjacent already-printed material

**Symptoms**: rows/peaks in a densely-packed texture (rows spaced closer
than the tallest feature height) get dragged, flattened, or disconnected,
progressively worse as more material accumulates nearby.

**Root cause**: the standard travel-hop height (`Emitter.goto()`, using
`Z_HOP` above whichever start/end point is closest) only considers the
*immediate* transition's own endpoints. It has no knowledge that an
*adjacent* already-printed row, just a few mm away, might have peaks
reaching well above that hop height — the travel path can physically drag
through material that was already deposited nearby.

**Fix**: force the hop height for any tightly-packed texture to clear the
texture's *global* maximum height (not just the current transition's own
endpoints) plus a safety margin, before every row-to-row transition. See
`freeformVariableThickness` / the historical Python-era `rect_thickness_sheet` for
the pattern: `safe_hop = h_max + z_gap + 0.3` (or equivalent for the
specific texture), forced via an explicit pre-lift rather than relying on
the generic `goto()` logic.

**When to suspect this**: any texture where row/strand spacing is smaller
than the feature height (e.g. `row_gap` < `h_max` for a thickness sheet,
or hair spacing smaller than `big_lift` for a hairy fill).

---

## 3. Diamond checkerboard parity — visual inspection is not sufficient

**Symptoms**: a diamond/checkerboard fill "looks alternating" but isn't
really — often appears as diagonal banding or whole-row uniformity rather
than true per-cell alternation.

**Root cause history (four attempts)**:
1. Simple non-offset grid, `(row+col)%2` fill. Diamonds only corner-touch,
   not edge-share — reported as "looks like rows are filled, not a
   checkerboard."
2. Interlocked rows (offset alternate rows to edge-share). **Looked
   correct in a static preview.** Was still wrong — the true geometric
   parity in that row/col indexing is *constant across an entire row*
   (confirmed only by computing the actual coordinate transform, not by
   re-inspecting the image).
3. Deduplicated the lattice into two diagonal line families to fix
   double-printed shared edges. Introduced a NEW bug — the lattice lines
   and the fill-loop's diamond centers were computed from independent
   coordinate schemes that didn't align, so fills overflowed into
   neighboring cells.
4. **Correct**: index diamonds by their TRUE rotated-square-grid
   coordinates `(i, j)` via `center = (x0 + half*(i+j), y0 + half*(i-j))`,
   checkerboard parity = `(i+j) % 2`. Lattice lines derived from the exact
   same diamond list used for filling, so they can never drift apart.

**The actual lesson**: three of the four attempts *looked* correct in a
rendered preview and were not. **The only thing that has ever actually
confirmed correctness is `verifyCheckerboard()`** — explicit adjacency
checking (does every diamond differ from every diamond that geometrically
touches it), not visual inspection, however careful.

**Mandatory practice**: never trust a diamond fill (or any future
grid-parity-based pattern) without running its adjacency verification
function and confirming zero violations.

---

## 4. Absolute-E-during-relative-mode confusion

**Symptom**: a pattern using relative-mode retraction (`G91`) prints
faint or erratically, and/or needs the manual recalibration described in
section 1.

**Root cause**: `G91` is commonly assumed to also put the E-axis into
relative mode, but this is firmware/config-dependent — some setups keep E
in whatever mode `M82`/`M83` last explicitly set, *independent* of
`G90`/`G91`. If E silently stays absolute, a line meant as "retract 4mm
relatively" (`G1 E-4`) is instead interpreted as "jump to absolute
position -4" — a huge, unintended retraction.

**What was tried**: adding an explicit `M83` after every `G91` (to remove
the ambiguity) was a reasonable, well-motivated fix — but empirically, a
version WITHOUT the explicit `M83` (an older, simpler mechanism) was
subsequently confirmed to print correctly on the actual hardware, while
versions WITH the fix were not conclusively confirmed better. **This
does not mean the theory was wrong** — it means the fix wasn't proven to
be the deciding factor, and the version that empirically worked should be
trusted over the version that was theoretically more defensive.

**Status as of the relative-E conversion (see §11)**: this entire class
of ambiguity is now MOOT for this project. `M83` (relative E) is set
once, globally, in `Emitter.header()`, and nothing in the file ever
switches back to `M82` -- so E is unambiguously relative everywhere,
regardless of whatever `G90`/`G91` is doing to X/Y/Z at any given moment.
`freeformSegmented` no longer has its own `M83`/`M82` toggle (removed as
redundant); it still uses `G91`/`G90` for its own XY-relative segment
walking, which was always a separate, correctly-scoped mechanism from
the E-mode question this section describes. Keep this section for
historical context (the empirical lesson in "What was tried" still
matters generally), but the specific symptom it describes should not
recur in this project's G-code going forward.

---

## 5. Freeform curves: naive sampling can create sharp spikes

**Symptom**: a hand-authored `x(t), y(t)` curve produces a near-180-degree
direction reversal somewhere along its length, or `PathTooSteepError` is
raised.

**Root cause**: fixed-sample-count rendering assumes roughly constant
"speed" along the parameter `t`. For a curve whose local rate of change
varies (e.g. a chirp — a wave whose frequency increases over its length),
naive fixed sampling can be too sparse exactly where the curve is
tightening, aliasing it into an artificial sharp corner.

**What does NOT reliably fix this**: "smarter" adaptive sampling that
tries to predict the right step size analytically. This was attempted
directly during design testing and the fix itself contained a subtle
math error (missing a chain-rule term for a chirp's true instantaneous
frequency) — it only partially worked. Adaptive sampling math is its own
bug surface, not a free win.

**What does fix it (usually)**: `samplePath()`'s approach — fixed, quite
fine sampling by default, with POST-HOC verification of actual turn
angles (not predicted ones), refined by halving the step if needed.

**When it's NOT a sampling problem at all**: if refining the step doesn't
meaningfully reduce the worst turn angle (checked automatically —
`PathTooSteepError` is raised when refinement stops helping), the
requested SHAPE is too steep to print smoothly at any resolution — e.g. a
wave whose amplitude exceeds its wavelength. The fix is to change the
shape's parameters (reduce amplitude, increase wavelength/radius), not to
sample harder. Do not write a retry loop that keeps refining past what
`samplePath()` already tried.

---

## 6. Polygon region winding order

**Symptom**: a line that should clip cleanly against a polygon region
instead "misses" the shape entirely, for every test line tried.

**Root cause**: polygon-clipping-by-edge-normal (the natural extension of
rectangle clipping to arbitrary straight-edged shapes) assumes a
consistent winding direction (clockwise or counter-clockwise) for the
boundary. If the polygon's vertices are wound the *other* way, every
inside/outside test silently inverts, and every line appears to miss.

**Fix**: normalize winding order automatically inside the clipping
function (compute the signed area via the shoelace formula; if negative,
reverse the vertex list) rather than requiring the caller to know or
guess which direction their boundary was authored in.

**Status**: confirmed as a real, reproducible bug (not hypothetical) —
a hand-authored organic (Bézier-flattened) boundary was clockwise, a
hand-authored triangle was counter-clockwise, and only the triangle
worked before this fix. Polygon regions are not yet part of
`texture_functions.js` (only rectangle regions are implemented) — if
polygon support is added, this normalization must be included from the
start, not retrofitted after a similar bug is independently rediscovered.

---

## 7. General verification discipline

Patterns observed repeatedly across every mechanism above:

- **A rendered preview is a weaker check than it feels like.** Three of
  the four diamond-fill bug attempts looked correct in a preview. Prefer
  an explicit, automatable check (adjacency verification, turn-angle
  verification, bounds/negative-E checking) over "does it look right."
- **Verify the verification script, not just the generator.** Multiple
  false alarms during this project's development were bugs in quick
  throwaway plotting/checking scripts, not in the actual generator code
  — confirmed by going back to raw G-code text when a check produced a
  surprising result. When a verification result looks wrong, check
  whether the *check* is wrong before assuming the generator is.
- **Negative E values are now NORMAL, not a red flag** — since the
  relative-E conversion (§11), every retract anywhere in this file is
  legitimately written as a negative literal (e.g. `G1 E-4.0000`). Do NOT
  flag a negative E value on its own as suspicious; that guidance
  predates the conversion and would now false-positive on every single
  retract in every generated file. What to check instead: that
  retract/unretract magnitudes for a given element are symmetric (the
  same amount subtracted as was added), and that `Emitter.eTotal`'s
  running total (informational only, never itself emitted) ends the file
  at a sane, non-wildly-negative number — a large unexplained negative
  drift there still indicates something extruding less than it retracted.
- **A theoretically well-motivated fix is not automatically confirmed
  correct** — see section 4. Prefer whatever has actually been validated
  against real hardware over whatever seems more defensively correct on
  paper, when the two conflict.

---

## 8. Non-uniform function signatures break generic dispatch — silently

**Symptom**: a fill that should work (per the documentation) generates
without any error, produces a plausible-looking line count, but the
G-code contains **no actual movement** — just unretract/retract pairs
with no X/Y between them. Nothing throws. Nothing looks obviously wrong
unless you specifically check for real print moves.

**Root cause**: `fillRegion()` calls every line style the same way:
`styleFunc(em, xFunc, yFunc, 0, length, options)`. This assumes all line
styles share the signature `(em, xFunc, yFunc, tStart, tEnd, options)`.
Two of the six did not — `freeformDashed` had `segLen, gapLen` and
`freeformSegmented` had `segLen` as extra *positional* parameters sitting
between `tEnd` and the options object. Called generically, the options
object itself was bound to `segLen`.

JavaScript then coerced that object to a number rather than erroring:
`0 + {segLen: 8, ...}` → the string `"0[object Object]"` →
`Math.min(that, 20)` → `NaN`. Every subsequent arc-length comparison
against `NaN` evaluated false, so the sub-path collapsed to one point,
the print loop (needing ≥2 points) never ran, and the outer `while`
condition immediately failed on the corrupted value — one dead iteration,
then silent exit.

**Worth noting**: in Python this same mistake would almost certainly have
raised a `TypeError` immediately. JavaScript's permissive coercion is
what made it silent. This class of bug will be quieter in the JS port than
it was in the Python original — a real, ongoing cost to be aware of.

**Fix applied**: `segLen`/`gapLen` moved into the options object for both
functions, with explicit `TypeError` guards if they're missing or
non-numeric. All six line styles now share one identical signature.

**Rule going forward**: any new line style MUST match
`(em, xFunc, yFunc, tStart, tEnd, options)` exactly. Required parameters
belong in the options object with an explicit guard, never as extra
positional parameters. The uniformity is load-bearing for `fillRegion()`,
not a style preference.

**Detection**: a fill that produces far fewer G-code lines than expected
(e.g. 87 where a comparable solid fill produces 800+) is the signature of
this failure. Checking "did it throw?" is not sufficient — check that
print moves with actual X/Y coordinates exist.

---

## 9. Overlapping textures generate silently

**Symptom**: a multi-texture print crashes the nozzle into
already-printed material partway through.

**Root cause**: every verification in this library was single-texture
(bounds, negative-E, checkerboard adjacency). Nothing compared one
texture's footprint against another's. Two individually-valid regions
that happen to overlap generated with no warning at all.

**Fix**: `verifyLayout(regions, {minGap, bedMargin})` — checks all
pairwise combinations for overlap (hard error) and for clearance below
`minGap` (warning), plus bed-margin violations. Call it before generating
any print with more than one texture and confirm `ok === true`.

**Note**: overlap here is a print-quality and nozzle-collision concern,
not a machine-damage one — printing over an existing feature will ruin
the part but is not expected to harm the printer.

---

## 10. Blob dot: under-extrusion and stringing

**Symptoms**: `blobDot()` / `freeformBlobDotted()` prints noticeably
smaller/flatter blobs than the requested `diameter`, and/or leaves a thin
strand of TPU dangling between each blob and the next, dragged sideways
during travel.

**Under-extrusion root cause**: the original volume model treated the
blob as a free-standing hemisphere (`(2/3)*pi*r^3`) and ignored `baseZ`
(the nozzle standoff height during extrusion) entirely. Physically,
material must first fill the gap between the nozzle tip and the bed — a
cylinder of the target diameter and height `baseZ` — before it can dome
up above the tip. Ignoring that term under-counts the required volume.

**Fix applied**: volume is now `pi*r^2*baseZ` (standoff cylinder) +
`(2/3)*pi*r^3` (dome bulge), and an explicit `extrusionMultiplier`
(default 1.0) was added as a manual dial for further empirical tuning
against real hardware, independent of the geometry model. If prints are
still under-extruded after this change, raise `extrusionMultiplier`
rather than hand-editing the geometry formula — that keeps the tuning
knob separate from the (approximate, unverified-against-hardware) volume
model itself.

**Stringing root cause**: a bare retract-then-lift-and-travel can leave a
thin strand of TPU stretched between the blob's apex (where the nozzle
last was) and the nozzle tip as it travels away — the classic FDM
stringing failure mode, worsened here because there is no wipe/travel
move to help shear the strand.

**Fix applied (v1)**: after the first lift, `emitBlobDot()` presses back
down to `baseZ` with **no extrusion** (lays the strand flat against the
already-deposited blob) before lifting again for the actual travel-safe
clearance. This is a lift → press → lift sequence on the same XY spot,
not a single lift.

**v1 confirmed on real hardware: stringing persisted.** Printed at
1.6mm diameter, default parameters.

**Session-only variant tried, also confirmed WORSE**: for one test print
(not saved to this file), four things were changed simultaneously: nozzle
temp 232→220°C, dwell 400→150ms, retraction distance 1.3→2.3mm (speed
unchanged), and a 0.6mm lateral "wipe" folded into the retract move
(shearing sideways instead of pulling straight up). Result: stringing got
worse, not better. Because all four changed at once, which one (or which
combination) made it worse is NOT isolated — do not conclude any single
one of these is harmful on its own. But do not re-try this exact
combination expecting a different result; if wipe-on-retract is worth
revisiting, test it in isolation with baseline temp/dwell/retraction.

**Fix applied (v2)**: the actual root cause was suspected to be upstream
of retract/lift tuning entirely: extruding the WHOLE blob volume in one
instantaneous `G1 E` burst builds up nozzle pressure that keeps oozing
after the retract, no matter how the retract/lift/wipe afterward is
tuned. `emitBlobDot()` now builds the dome by extruding while rising in Z
across `buildSteps` small increments (heaviest at the bottom, tapering
only slightly by `taperFactor = 0.25` toward the top) instead of one
point stamp. The lift → drop (no E, no retraction on that move) → lift
sequence from v1 is kept as a second line of defense. `extrudeSpeed`
default lowered 300→200mm/min to match the smaller per-step E amounts.

**v2 confirmed on real hardware, printed at 1mm diameter**: two results,
one positive and one still-open —
- **Diameter → filament-volume conversion confirmed accurate.** The
  volume model (standoff cylinder + hemispherical dome, `troubleshooting.md`
  §10 fix-applied section above) is validated; do not re-derive it without
  a new specific reason.
- **Stringing reduced but NOT eliminated.** Spreading extrusion over the
  Z-rise helped versus v1's single-shot burst, but wasn't sufficient on
  its own.

**Fix applied (v3) — current**: two further changes, made together this
time (unlike the earlier session-only combo, both are being kept
permanently and tracked here, so if the combined result is inconclusive
either one can be dialed back individually later):
1. `taperFactor` raised 0.25 → 0.7 — the last build step now lays down
   only 30% of the first step's rate (deliberate coasting: residual
   nozzle pressure finishes the tip rather than a hard stop), instead of
   the mild 75% taper in v2.
2. A dot-specific `retractMm = 2.0` added (up from the shared global
   1.3mm) — distance only, `RETRACT_SPEED` left at the global 900mm/min
   per the TPU filament-damage caution in §1. This required changing the
   priming un-retract at the top of `emitBlobDot()` to restore exactly
   `retractMm` (not the library's generic `em.unretract()`, which only
   knows the global `RETRACT_MM`) — mismatching the two reproduces the
   same E-drifts-negative bug caught during the earlier session-only wipe
   experiment (see above). Symmetric now.

Note: increased retraction distance was part of the session-only combo
that made things WORSE earlier — but that combo also changed nozzle temp,
dwell, and added a lateral wipe simultaneously, so retraction distance on
its own was never actually tested. v3 tests it in isolation from those
other three (temp is back at the default 232°C, dwell is unchanged at
400ms, no wipe).

**v3 was never print-tested** — superseded by v4 (below) before any
hardware result came back on it. Its two changes (taper 0.7, retractMm
2.0) both carried forward into v4, so this isn't a discarded attempt,
just an untested intermediate step.

**Fix applied (v4) — current**: two further changes, requested directly
rather than as an open "does this help?" question:
1. **Pre-retract drop**: immediately before retracting, `emitBlobDot()`
   now drops `preRetractDropMm` (default 0.15mm, clamped to never go
   below `baseZ`) with NO extrusion, dwells, and only then retracts. This
   is a new, distinct step from the existing post-retract lift → drop →
   lift anti-string sequence -- this one happens BEFORE retract, pressing
   the dome tip while there's still some pressure in the nozzle, rather
   than after pulling away.
2. `retractMm` raised 2.0 → 4.0mm. This now matches
   `freeformSegmented`'s own retraction distance, which IS validated on
   real hardware -- for a different function, but the same underlying
   number, which is at least some evidence it's a physically reasonable
   distance for this printer/filament rather than an arbitrary guess.
3. All dwells (`dwellMs`, the new `preRetractDwellMs`, `liftDwellMs`,
   `pressDwellMs`) raised to a 500ms floor (previously 150-400ms
   depending on which one) -- more settling time everywhere, not just at
   one step.

Note on retraction distance again: item 2 here raises `retractMm` a
second time (v3 already moved it 1.3→2.0mm). The session-only combo that
made things WORSE (see above) also included a retraction-distance
increase, but bundled with temp/dwell/wipe changes that were never
isolated from it. v3 and v4's retraction changes are isolated from temp
and wipe (both still at defaults/absent) but NOT isolated from each
other or from the taper/pre-retract-drop changes made alongside them --
if v4 still strings, retraction distance specifically has still not been
tested completely alone.

**v4 confirmed on real hardware, printed at 3mm diameter: "definitely
less stringing."** The best result of any version so far. Not reported
as fully eliminated, but a clear, unambiguous improvement over v3/v2 --
first time a version has gotten unambiguously positive (not just "reduced
but not eliminated" or "worse") feedback. Which of v4's three changes
(pre-retract drop, retractMm 2.0→4.0, dwell floor) mattered most is still
not isolated -- all three shipped together.

**Fix applied (v5) — current**: rather than tuning the dot's own
retract/lift further, this targets a different mechanism entirely: after
the existing lift-drop-lift sequence, `emitBlobDot()` now traces one full
circle (`orbitRadius`, default the dot's own radius `diameter/2`, 16
points) around the dot at travel height, no extrusion, before the
caller's next goto() departs for the next dot. Rationale: even with v4's
improvements, if ANY residual ooze remains on the tip, traveling straight
to the next dot stretches it into a strand bridging the two dots. Looping
back around the current dot first detours that travel move so the ooze
winds around the current dot's own footprint instead. This is additive
on top of all of v4's changes, not a replacement for any of them.

**v5 was never print-tested** — superseded by v6 (below) before a
hardware result came back on it. Its orbit concept carried forward into
v6, but at a different height (see below); its literal implementation
(orbit at travel height, after the full lift-drop-lift) was discarded.

**Fix applied (v6) — current**: two changes based directly on reported
hardware behavior of v4, rather than an open "does this help?" question:
1. **Removed both vertical squish steps** -- the pre-retract drop
   (v4) and the post-retract lift→drop→lift (v1) were both reported to
   squish/deform the dot on real hardware. Neither was confirmed to
   actually reduce stringing on its own (v4's positive result was never
   isolated from its other two simultaneous changes -- see above), so
   with a report that they cause a real downside, both were removed
   rather than kept "just in case."
2. **Orbit moved from travel height (v5) to the dome's own top height**,
   and moved to happen immediately after retract -- BEFORE any lift, not
   after. Rationale: any residual string is physically attached at
   roughly the dome's own height, not up at the travel-clear height a
   full `liftZ` above it. Sweeping a circle right at that height should
   actually catch/wind the string; sweeping the same circle after
   already lifting `liftZ` clear of it may just trace air.
3. The two 500ms dwells that used to bracket the (now-removed)
   pre-retract drop are merged into one 1000ms dwell after the dome is
   built, before retract.

Net effect: `emitBlobDot()` is now build → dwell(1000ms) → retract →
orbit (at dome height) → lift → dwell(500ms) → travel to next dot. Three
steps shorter than v4/v5's build → dwell → drop → dwell → retract → lift
→ dwell → drop → dwell → lift → orbit(travel height) → travel.

**v6 was never print-tested** — superseded by v7 (below) before a
hardware result came back on it.

**Fix applied (v7) — current**: three changes requested directly, not as
an open "does this help" question:
1. `orbitLoops` added (default 3) -- the dome-height orbit from v6 now
   repeats 3 times in a row before lifting, in case one pass doesn't
   fully catch/wind the string.
2. `extrusionMultiplier` raised 1.0 → 1.3 -- reported under-extruded
   relative to target diameter across v1-v6 (all of which used 1.0).
3. `liftDwellMs` raised 500 → 1000ms, matching `dwellMs`'s existing
   1000ms floor (both dwells in the function are now 1000ms).

Also, from this point on, every generated test print includes a plain
reference line (x=60 to x=120, `freeformSolid`) at a y-position that
starts at 200 and decreases by 5 for each subsequent file -- a
test-harness convention (see `texture_patterns.md` intro), not a change
to `texture_functions.js` itself.

**v7 was never print-tested** — superseded by v8 (below) before a
hardware result came back on it. Its three changes (orbitLoops=3,
extrusionMultiplier=1.3, liftDwellMs=1000) all carried forward into v8.

**Fix applied (v8) — current**: two G-code-quality issues spotted by
reviewing v7's actual output, not new stringing theories:
1. **No stationary extrusion, anywhere.** The priming restoration
   (`retractMm` + first-dot prime bonus) was being emitted as its own
   `G1 E...` line with no XY/Z movement, immediately before the tapered
   build even started. This is exactly the kind of instantaneous
   pressure dump the build-while-rising design (v2) was built to avoid --
   it just moved the problem one line earlier instead of eliminating it.
   Fixed by folding the priming amount into the first build step's E
   value, so the very first upward Z movement already carries it. There
   is now no point in this function's G-code where E changes without
   accompanying X/Y/Z movement.
2. **Recenter after orbit.** The orbit's last point ends `orbitRadius`
   away from (cx, cy), not back at center -- previous versions lifted
   and traveled from that off-center position without comment. v8 adds
   a dwell (`orbitDwellMs`, default 1000ms) after the orbit(s) complete,
   then an explicit move back to (cx, cy) at the same (dome-top) height,
   before lifting.

Net sequence: build (rise+taper+prime combined) -> dwell(1000) -> retract
-> orbit x`orbitLoops` (at dome height) -> dwell(1000) -> recenter ->
lift(`liftZ`) -> dwell(1000) -> travel to next dot.

**v8 was never print-tested** — superseded by v9 (below) before a
hardware result came back on it.

**Fix applied (v9) — current**: swapped the order of the last two steps
and raised one dwell, based on the user's own reasoning about giving
residual melt pressure time to settle at the dot before departing:
1. Order swapped: recenter (the `G0` move back to (cx, cy)) now happens
   BEFORE the post-orbit dwell, not after (v8 had dwell-then-recenter).
2. `orbitDwellMs` raised 1000 → 2000ms.

Net sequence (current): build (rise+taper+prime combined) ->
dwell(1000) -> retract -> orbit x`orbitLoops` (at dome height) ->
recenter -> dwell(2000) -> lift(`liftZ`) -> dwell(1000) -> travel to
next dot.

**v9 was never print-tested** — superseded by v10 (below) before a
hardware result came back on it.

**Fix applied (v10) — current**: three changes requested directly:
1. `dwellMs` raised 1000 → 2000ms.
2. New `postRetractDwellMs` (2000ms) dwell inserted immediately after
   the retract, before the orbit begins -- a separate dwell from
   `dwellMs`, not a value change to it.
3. `liftZ` raised 2.0 → 5.0mm.

Net sequence (current): build (rise+taper+prime combined) ->
dwell(2000) -> retract -> dwell(2000, `postRetractDwellMs`) ->
orbit x`orbitLoops` (at dome height) -> recenter -> dwell(2000,
`orbitDwellMs`) -> lift(`liftZ`=5.0) -> dwell(1000) -> travel to next dot.
Four separate dwells now, three of them 2000ms.

**v10 CONFIRMED on real hardware: extrusion/oozing was still observed
happening during the dwell/orbit/lift phase**, despite the G-code
carrying no `E` command anywhere in that region -- verified by direct
code inspection on two separate occasions, including re-checking the
exact file the user was looking at. Ruled out as a G-code bug.

**Root cause identified (not yet a fix)**: TPU is compressible, unlike
PLA. During the build burst, a meaningful share of the extruder motor's
push force goes into elastically compressing the TPU filament column
itself, not just displacing melt out the nozzle tip -- like a soft
spring under load. The retract (`G1 E-4.0000`) pulls the drive gear back
mechanically, but for a compressible material that does not instantly
equal "pressure at the tip drops to zero" -- there is a physical lag
while the compressed column relaxes, during which the melt (kept fluid
at 232°C) can keep oozing regardless of what the E-axis is doing at that
moment. Every dwell added in v4 through v10 was, in effect, waiting out
this lag rather than preventing the pressure from building up -- which
explains why stacking more/longer dwells kept being tried without fully
resolving the observation: dwells address the SYMPTOM (giving the
pressure time to relax) but not the mechanism (how much pressure builds
up in the first place).

**Fix applied (v11) — current**: three changes that target the
mechanism directly, rather than adding more wait time:
1. `extrudeSpeed` lowered 200 → 120mm/min -- a gentler, slower build
   should compress the TPU column less in the first place.
2. Nozzle temperature lowered to 220°C for this test -- NOT a `blobDot`
   parameter (temperature is a print-wide `em.header()` setting, applied
   at the generation-script level, same mechanism as the item-6
   session-only temp experiment earlier this session). More viscous TPU
   should ooze less under whatever residual pressure remains.
3. A bigger, deliberately-anchored first contact point: `baseZ` lowered
   0.3 → 0.2mm (a lower standoff squashes the initial deposit
   flatter/wider against the bed), plus a new `baseExtraMm` (0.3mm extra
   filament at just the first build step, on top of its normal taper
   share) and `baseDwellMs` (1000ms dwell right after that first step)
   to let the anchor spread and stick before the rest of the dome piles
   on top of it. This one is about adhesion, distinct from the
   pressure/ooze mechanism above -- requested alongside it, not derived
   from the same diagnosis.

**Caution on lowering nozzle temperature**: item 6 of this session tried
220°C once before, bundled with three other simultaneous changes, and
that combination was reported WORSE. This time temperature is isolated
from the wipe/dwell/retraction changes that confounded that earlier
result, but it is still bundled with the `extrudeSpeed` and
base-anchoring changes in v11 -- if v11 still oozes or the base doesn't
stick better, temperature specifically has still not been tested fully
alone.

**v11 was never print-tested** — superseded by v12 (below) before a
hardware result came back on it. Its changes (extrudeSpeed 120,
baseZ 0.2, baseExtraMm, baseDwellMs, temp 220°C) all carried into v12.

**Fix applied (v12) — current**: two changes requested directly:
1. **Nozzle temperature standardized to 220°C** as the new global
   `NOZZLE_TEMP` default in `texture_functions.js` (was 232°C), rather
   than a per-test `em.header()` override. This is a real default change,
   not an experiment anymore -- `global_printing_parameters.md`'s
   Filament Profiles table and header example were updated to match. Note
   the caution from v11 still applies: this reuses the same 220°C value
   as the item-6 session-only experiment (which was reported worse when
   bundled with wipe/dwell/retraction changes), and even now it has not
   been validated in isolation from the `extrudeSpeed`/`baseZ`/
   `baseExtraMm` changes it shipped alongside in v11 -- standardizing it
   is a judgment call made without a full isolated confirmation, not a
   claim that 220°C specifically has been proven better.
2. **`postLiftBounces`** (new parameter, default 2): after the existing
   lift+`liftDwellMs`, this many additional down-to-dome-top /
   back-up-to-travel-height cycles happen, no extrusion, before departing
   for the next dot -- a further mechanical attempt at shedding any
   still-attached strand via repeated vertical motion at the two
   characteristic heights (dome top and travel-clear), on top of
   everything else already tried (orbit, recenter, dwells).

Net sequence (current): build (rise+taper+prime+base-anchor combined) ->
dwell(2000) -> retract -> dwell(2000, postRetractDwellMs) ->
orbit x`orbitLoops` (at dome height) -> recenter -> dwell(2000,
orbitDwellMs) -> lift(`liftZ`=5.0) -> dwell(1000, liftDwellMs) ->
[down to dome top -> up to travel height] x`postLiftBounces` (2) ->
travel to next dot.

**v12 was never print-tested** — superseded by v13 (below) before a
hardware result came back on it.

**Fix applied (v13) — current, a real bug catch, not a stringing
theory**: the recenter move and the down-phase of each `postLiftBounces`
cycle were both targeting `z` -- the dome top's EXACT height -- meaning
the nozzle was actually touching/dragging across the just-printed blob
on every single one of those moves, not hovering near it as intended.
This risked remelting or deforming the blob on every dot, independent of
the stringing/oozing question entirely. Fixed by adding
`blobClearanceMm` (default 0.3mm): the recenter now lifts to
`z + blobClearanceMm` BEFORE moving XY back to center (rather than
moving XY at the exact dome-top height), and each bounce's down-phase
targets that same hover height instead of `z`. The orbit itself is
UNCHANGED -- it still deliberately sweeps AT the exact dome-top height,
since that is the whole point of the anti-string mechanism (catching a
string at its actual attachment height); only the recenter and bounces,
which have no reason to touch the blob, were fixed.

Net sequence (current): build (rise+taper+prime+base-anchor combined) ->
dwell(2000) -> retract -> dwell(2000, postRetractDwellMs) ->
orbit x`orbitLoops` (AT dome height, unchanged) -> lift to
zHover=z+blobClearanceMm -> recenter (XY move at zHover, no longer at z)
-> dwell(2000, orbitDwellMs) -> lift(`liftZ`=5.0) -> dwell(1000,
liftDwellMs) -> [down to zHover -> up to travel height] x`postLiftBounces`
(2) -> travel to next dot.

**Not yet validated against real hardware** — v13 is theoretically
motivated (see the general caution in §7 about theoretically
well-motivated fixes not being automatically correct) and has NOT been
print-tested yet. Confirm on an actual print before treating it as
settled. If oozing persists, candidates to isolate next: `extrudeSpeed`
alone, nozzle temperature alone (try even lower than 220°C if it doesn't
help and doesn't hurt), `postLiftBounces` alone (try 0 vs. 2 vs. more),
`blobClearanceMm` alone (try larger if 0.3mm still catches the blob on
real hardware, e.g. if the dome's actual printed height varies from the
modeled `domeHeight`), and whether the four dwells can now be reduced
given the root-cause changes, rather than assuming they still all need
to stay at 2000ms. If stringing (a related but distinct symptom) still
needs isolating separately: `retractMm` alone, `taperFactor` toward 1.0,
`orbitRadius`, and `orbitLoops` alone remain untested in isolation from
each other.

**Fix applied (v14) — current, a new stringing-mitigation theory, not a
bug catch**: v13's orbit and bounces only sweep/hover right at (or just
above) the dome's own top height. If a trailing strand actually sags
down the SIDE of the dome rather than staying at its tip, none of the
existing moves would ever pass near it. v14 adds a second orbit, after
the `postLiftBounces` cycles, that is deliberately WIDER
(`secondOrbitRadius`, default the dot's own `radius + 0.5mm`, i.e. just
outside the blob's own physical edge) and LOWER
(`z - secondOrbitZDrop`, default 0.3mm below the dome top, clamped to
never go below `baseZ`) than the first orbit, then lifts back to
`liftZ` before departing for the next dot. Pass `secondOrbitRadius: 0`
to disable it.

Net sequence (current): build (rise+taper+prime+base-anchor combined) ->
dwell(2000) -> retract -> dwell(2000, postRetractDwellMs) ->
orbit x`orbitLoops` (AT dome height) -> lift to zHover=z+blobClearanceMm
-> recenter (XY move at zHover) -> dwell(2000, orbitDwellMs) ->
lift(`liftZ`=5.0) -> dwell(1000, liftDwellMs) -> [down to zHover -> up to
travel height] x`postLiftBounces` (2) -> down to
secondZ=z-`secondOrbitZDrop` -> second orbit x1 (radius
`radius`+0.5mm, WIDER and LOWER than the first orbit) -> lift to
`liftZ` -> travel to next dot.

**Not yet validated against real hardware** — v14, like v13, is
theoretically motivated and has NOT been print-tested yet (see the
general caution in §7). Confirm on an actual print before treating it as
settled. Because it's stacked on top of v13's untested fix, a hardware
result on v14 will not by itself tell you whether v13's clearance fix or
v14's second orbit (or neither, or both) is responsible for any change
observed -- isolate separately if the result is ambiguous.

**Attempted fix (v15) — MISTAKE, corrected in v16 below, kept here for
the record**: v10 through v14 all placed the orbit (and, at various
points, a recenter, `postLiftBounces`, and a second orbit) right at or
near the dome's own top height, on the theory that sweeping at the
string's actual attachment height would catch it better than a vertical
press. That stack had grown to four separate anti-string mechanisms
layered on top of each other, none of them individually print-confirmed
-- or so it seemed. v15 removed all of it -- the dome-height orbit, the
recenter step, `postLiftBounces`, and the v14 second wider/lower orbit --
and replaced the whole thing with lift-to-`liftZ`-then-orbit-once at the
lifted height. **This was wrong**: the dome-height orbit (mechanism 3 in
`texture_patterns.md`'s anti-stringing list) was NOT an untested layer --
it was the original mechanism, confirmed on real hardware to help
("There's definitely less stringing now", an earlier print result). v15
was asked for as a replacement for `postLiftBounces` specifically ("instead
of a 2 z-hop..."), not for the dome-height orbit, and the instruction to
"remove the current last two circular movement" was misread as covering
the original orbit too, when in context it meant `postLiftBounces` and
the v14 second orbit -- the two untested additions stacked on top of the
proven orbit, not the orbit itself. The mistake was caught immediately
(before any print) and corrected in v16.

**Fix applied (v16) — current**: restores the original dome-height orbit
+ recenter + `orbitDwellMs` dwell + lift + `liftDwellMs` dwell exactly as
in v13 (`orbitDwellMs` and `blobClearanceMm` are therefore parameters
again), and ADDS a second pass of the same circle -- `topOrbitLoops`
(default 3) -- at the lifted height on top of that, rather than replacing
the first orbit with it. This second, higher orbit is what actually
replaces `postLiftBounces` and the v14 second wider/lower orbit, both
still unused. `secondOrbitRadius`, `secondOrbitZDrop`, and
`secondOrbitPts` remain removed (the v16 second orbit reuses
`orbitRadius`/`orbitPts`, unlike v14's separate wider/lower circle).

Net sequence (current): build (rise+taper+prime+base-anchor combined) ->
dwell(2000) -> retract -> dwell(2000, postRetractDwellMs) -> orbit
x`orbitLoops` (3) AT DOME HEIGHT (original, hardware-confirmed) -> lift
to zHover=z+blobClearanceMm -> recenter (XY move at zHover) -> dwell(2000,
orbitDwellMs) -> lift(`liftZ`=5.0) -> dwell(1000, liftDwellMs) -> orbit
x`topOrbitLoops` (3) AT THE LIFTED HEIGHT (well above the dome top) ->
travel to next dot.

**Not yet validated against real hardware** — v16 has NOT been
print-tested yet (see the general caution in §7). The first (dome-height)
orbit segment of this sequence matches v13 exactly and inherits its
hardware-confirmed anti-stringing benefit; the second (lifted-height)
orbit segment is new and untested, so if a v16 print shows a change, it
is most likely attributable to that new segment rather than to the
already-proven first orbit. Remaining untested-in-isolation candidates
are unchanged from the v13 list above: `extrudeSpeed` alone, nozzle
temperature alone, `retractMm` alone, `taperFactor` toward 1.0,
`orbitRadius`, `orbitLoops`, `topOrbitLoops`, and `liftZ` alone.

**v17 (session-only isolation test, not a new design) -- CONFIRMED BEST
RESULT ON REAL HARDWARE**: steps 6-10 (recenter, both dwells, lift, and
the second lifted-height orbit) are temporarily commented out in
`emitBlobDot`, so the sequence goes directly from the first (dome-height)
orbit to the next dot's travel move. Purpose: isolate whether the
dome-height orbit alone -- the one piece of this whole mechanism
actually confirmed on hardware -- is sufficient by itself, since v16's
addition on top of it was still completely untested and stacking
untested changes on a proven baseline would have made any hardware
result hard to attribute. User printed this and confirmed: **"Yes this
works best."** This is now the best-known configuration for
`emitBlobDot` -- build, dwell, retract, dwell, ONE dome-height orbit
(`orbitLoops`), straight to the next dot. Everything after the first
orbit (recenter, `blobClearanceMm`, `orbitDwellMs`, `liftZ`,
`liftSpeed`, `liftDwellMs`, the v16 `topOrbitLoops` second orbit) is
confirmed NOT needed and remains commented out. `extrusionMultiplier`,
`retractMm`, `taperFactor`, `baseZ`/`baseExtraMm`/`baseDwellMs`, and the
220°C `NOZZLE_TEMP` standardization are all still in play as the current
working recipe; none of those have been isolated from each other, so
further fine-tuning (if stringing is still present at all) should vary
one of those next rather than reintroducing the commented-out steps.

---

## 11. Relative extrusion mode (M83) adopted project-wide

**Not a bug fix -- an architecture change**, made for composability: the
project moved from absolute extrusion (`M82`, every `G1 E<value>` is the
CUMULATIVE E position) to relative extrusion (`M83`, every `G1 E<value>`
is a DELTA -- positive extrudes, negative retracts, independent of
everything printed before it).

**Motivation**: under the old absolute-E design, two real costs kept
showing up across this project's history:
1. **Unreadable in isolation.** A line's meaning (extrude vs. retract)
   was only recoverable by diffing it against the immediately preceding
   line's E value -- see the "isn't retract a negative value?" question
   this session, twice, about the exact same non-issue in two different
   files. Under relative E, a negative literal unambiguously IS a
   retract, full stop -- see the revised guidance in §7.
2. **Not composable.** No function's G-code output was a genuinely
   independent, insertable unit -- combining two functions' output (or a
   caller supplying hand-written G-code) required first knowing, or
   recomputing, the exact cumulative E baseline in effect at that point
   in the file. This mattered specifically for an LLM assembling
   multiple functions' output together: each function's emitted lines
   are now self-contained and order-independent with respect to E.

**What changed** (`texture_functions.js`):
- `Emitter.header()`: `M82` → `M83`. The prime line's second pass changed
  from an absolute `E24` (cumulative) to a relative `E12` (matching the
  first pass -- both passes now independently extrude 12mm, same
  physical result as before). The `G92 E<RETRACT_MM>` baseline trick
  (setting E to a nonzero value to represent "already retracted") was
  replaced with an explicit `G1 E-<RETRACT_MM>` retract command --
  relative mode has no equivalent need for a nonzero baseline.
- `Emitter.goto()` / `unretract()` / `retract()` / `printMove()`: all now
  emit the delta directly instead of accumulating into and emitting
  `this.eTotal`. `eTotal` is kept ONLY as an informational running total
  (e.g. for reporting total filament used) -- it is never itself written
  into a G-code line anymore.
- `freeformSegmented()`: removed its own internal `M83` (redundant, now
  the global default) and the trailing `M82` (would have silently broken
  every function after it in the file, back to absolute mode). Its
  `G91`/`G90` toggle for XY-relative segment walking is unchanged and
  unrelated to this (see the updated §4).
- `freeformHairy()`: the per-root loop no longer needs a bookkeeping-only
  line (`em.eTotal += retractMm` with nothing emitted) that existed
  purely to pre-correct the next iteration's absolute cumulative math.
  Each iteration's extrude/retract are now independent deltas.
- `emitBlobDot()`: the "must manually replicate `em.unretract()`'s bonus
  logic exactly, or E drifts negative across calls" caution (§8's sibling
  problem, hit once already during this session's own testing) is now
  structurally impossible -- there is no cross-call cumulative state for
  a mismatch to drift out of sync with. The priming-restoration-plus-
  first-build-step math is unchanged; only the emission changed from
  absolute to relative.

**Physical behavior is unchanged.** This was verified by generating a
test print immediately after the conversion and confirming: identical
per-step E deltas to the pre-conversion version (e.g. the first blob-dot
build step's delta was 4.7209mm before and after -- only the literal now
IS 4.7209 instead of being computed by diffing two cumulative values),
identical total retract count, matching negative-E count to the number
of actual retract events (10 in a 7-dot-plus-calibration-line test:
1 header + 2 calibration-line layers + 7 dot retracts), and no leftover
`M82` anywhere that would silently revert the mode. All prior hardware
validation results (v2's diameter-accuracy confirmation, v4's stringing
improvement) still apply -- this change did not alter what gets printed,
only how the instructions to print it are written.

---

## 12. Hairy dot: closing the single-strand-dot gap

**Context**: `texture_patterns.md` had long flagged "no function exists
for a single dot with one hair strand pulled from its center" as a known
gap, explicitly warning not to improvise it via `freeformHairy` with a
zero-length path. `emitHairyDot` / `hairyDot` / `freeformHairyDotted`
close that gap.

**Design goal, stated by the user**: independently-controllable hair
thickness (mapping to pull speed -- thicker = slower), hair length
(mapping to both extrusion amount and pull distance), a choice of pull
direction (top/left/bottom/right), and an overtravel margin so
consecutive hairy dots' strands don't reach and connect to each other.

**Mechanism -- deposit-then-stretch, deliberately, not a bug to avoid**:
unlike every anti-stringing mechanism built for `emitBlobDot` in SS10
above, this function's entire point IS the stringing/fiber-pull
behavior. ALL of the hair's material is deposited in ONE stationary
extrusion at the anchor point (no extrude-while-moving at all), then the
nozzle physically walks away with ZERO further extrusion, stretching
that already-deposited material into a strand as it travels. `retractMm`
only fires once, at the very end of the full pull distance (`hairLength`
+ `overtravelMm`), to cut the strand cleanly.

**Volume model** (directly mirrors `emitBlobDot`'s standoff+dome split):
anchor volume = `π·(rootDiameter/2)²·baseZ` (a small standoff cylinder,
same shape as `emitBlobDot`'s `standoffVolume` term); hair volume =
`π·(hairThickness/2)²·hairLength` (the strand itself, modeled as a
cylinder even though the finished strand is thinner and tapered in
reality -- this is the deposited-material budget, not the final shape).
Both convert to filament length via `FIL_AREA` and sum before the single
deposit line, same conversion approach used everywhere else in this
file that maps a diameter to an E value.

**Speed-from-thickness derivation**: `hairSpeed`, when not explicitly
overridden, is `600 * (DEFAULT_WIDTH / hairThickness)` -- `DEFAULT_WIDTH`
(0.5mm) is the reference thickness at which the pull runs at the 600mm/min
baseline speed also used elsewhere in this file for non-critical Z/XY
moves (e.g. `blobDot`'s `liftSpeed`/`orbitSpeed` defaults). A
`hairThickness` above 0.5mm slows the pull below 600; below 0.5mm speeds
it up. This is a linear inverse relationship, not physically modeled
from actual TPU viscosity -- it is a starting point to tune from, not a
calibrated value. If hardware testing shows the wrong thickness comes
out at either extreme, this formula (not just the default
`hairThickness` value) is the first thing to revisit.

**Direction mechanism**: `"top"` pulls straight up in Z only (the same
axis `freeformHairy` already uses, and the only axis that needs no
lateral bed clearance). `"left"`/`"right"`/`"bottom"` instead lift by a
fixed `clearanceZ` (0.5mm default) above `baseZ` -- just enough that the
strand doesn't drag across the bed or the anchor blob -- and THEN travel
horizontally in that compass direction. This is a genuinely different,
independent mechanism from the "horizontal mechanism...explored earlier
in this project and abandoned" note under `freeformHairy` in
`texture_patterns.md` -- that abandoned attempt was for the different,
simpler `freeformHairy` point-stamp function, not this one, and nothing
about its abandonment was re-litigated or reused here. There is no
diagonal option and no separate "up"/north direction distinct from
`"top"` -- exactly 4 directions are implemented, matching what was
asked for; passing anything else throws.

**Bed-margin note from the first test generation**: the first attempt at
a test file used a hairy-dotted line spanning x=70 down to x=10 at y=10,
per the user's literal request -- `verifyLayout()` correctly rejected it
(x0=10, y0=9 both fall inside the project-wide 15mm bed-margin safety
check every other test file in this session has respected). Flagged to
the user rather than silently shrinking the margin or silently
repositioning; the user chose new coordinates (x=70 to x=100, then
y=120) rather than overriding the safety check. **If a future request
asks for coordinates that violate this margin again, flag it the same
way -- do not silently pass a smaller `bedMargin` to `verifyLayout()`.**

**v1 verified by hand** (not yet print-tested): generated
`test_print_gcode/20260826-174028_hairy-dot-v1-top-direction.gcode` --
calibration line x=120-180 y=125, then 7 hairy dots (`hairDirection:
"top"`, all other parameters at default) from x=70 to x=100, y=120.
Confirmed by hand-tracing the first dot's math: anchor volume
0.235619mm3 + hair volume 0.502655mm3 = 0.738274mm3, /FIL_AREA
(2.40528) = 0.30693mm E, + primeE (1.3 retractMm + 0.3 first-dot prime
bonus) = 1.90693 -- matches the generated `G1 E1.9069` deposit line
exactly. Pull speed: `600 * (0.5/0.4) = 750` -- matches the generated
`G0 Z4.300 F750` line exactly (z1 = baseZ 0.3 + hairLength 4.0 = 4.3).
Overtravel: `G0 Z6.300 F600` (z2 = 4.3 + overtravelMm 2.0 = 6.3, at the
default `overtravelSpeed`). Retract `G1 E-1.3000 F900` follows
immediately, then the next dot's own `goto()` (no dedicated
recenter/return code in `emitHairyDot` -- same "let the caller's next
`goto()` handle repositioning" convention established for `emitBlobDot`
in v15-v17) correctly lifts to `z + Z_HOP` before traveling. Second
dot's deposit line (no prime bonus this time, since `newPattern()`'s
bonus is consumed once per whole line) computed as 0.30693 + 1.3 (no
bonus) = 1.60693, matching the generated `G1 E1.6069` exactly. 10
negative-E lines total (3 from the calibration line, 7 from the 7 hairy
dots), matching the expected count.

**Not yet print-tested.** All of `hairThickness`/`hairLength`/
`hairDirection`/`hairSpeed`/`clearanceZ`/`overtravelMm` are untested in
isolation from each other and from the volume-model constants chosen
above -- treat every default in this section as a starting point, not a
validated value, until a hardware result comes back.

**Second test (v2, still not print-tested), larger values throughout**:
`rootDiameter` 1.0->2.0mm, `hairThickness` 0.4->0.5mm (exactly
`DEFAULT_WIDTH`, so `hairSpeed` derives to exactly the 600mm/min
baseline with no scaling), `hairLength` 4.0->8.0mm, and `overtravelMm`
2.0->20.0mm -- a 10x increase, explicitly requested "to ensure the hair
is totally off" (fully detach the pulled strand from the print head
before it travels to the next dot, rather than trusting a small margin).
These were passed as call-site options in the generation script, NOT
changed as the function's own defaults -- "let's try" / "for now"
language, consistent with how diameter was varied per-test for
`blobDot` throughout this project without touching its defaults.
Generated `test_print_gcode/20260826-174900_hairy-dot-v2-larger-params.gcode`
-- calibration line x=120-180 y=120, then 7 hairy dots (`hairDirection:
"top"`, other params as above) from x=70 to x=100, y=110. Verified by
hand: first dot's deposit `G1 E2.6449` matches anchor volume
(π·1²·0.3=0.94248) + hair volume (π·0.25²·8=1.57080) = 2.51327mm3 /
FIL_AREA 2.40528 = 1.04490mm E, + prime (1.3+0.3) = 2.64490; pull `G0
Z8.300 F600` matches z1 = 0.3+8.0, F = 600*(0.5/0.5) = 600 exactly;
overtravel `G0 Z28.300 F600` matches z2 = 8.3+20.0; retract and the next
dot's `goto()` (`G1 Z28.700` = 28.3 + Z_HOP 0.4) both correct; second
dot's no-bonus deposit `G1 E2.3449` matches 1.04490+1.3. 10 negative-E
lines, matching expected.

**v3 (root = blobDot's own build, retract mid-pull)**: user pushback --
"Retract probably need to happen earlier, especially since we learned
that the TPU probably has leftover [pressure]" -- and a request to build
the root the same way `blobDot` builds a 2mm dot, not via v1/v2's custom
anchor+hair volume formula. Replaced the one-shot stationary deposit
with `emitBlobDot`'s EXACT tapered Z-rise build (same
`domeHeight`/`standoffVolume`/`domeVolume`/`totalE` formulas,
`buildSteps`, `taperFactor`, `baseExtraMm`, `baseDwellMs`, `dwellMs`),
so the root is literally what a real `blobDot` of `rootDiameter` would
deposit. Introduced `retractAtMm` (default 2.0mm) to fire the retract
PARTWAY into `hairLength` -- clamped to `[0, hairLength]` -- instead of
only at the very end, splitting the pull into two zero-extrusion moves
around it, with a new `postRetractDwellMs` dwell in between (mirroring
`emitBlobDot`'s own dwell-after-retract). Generated and hand-verified
`test_print_gcode/20260826-180025_hairy-dot-v3-blobdot-root-midpull-retract.gcode`
(rootDiameter=2mm, hairThickness=0.5mm, hairLength=8mm, retractAtMm=2mm,
overtravelMm=20mm, x=70-100 y=100) -- root build math matched
`emitBlobDot`'s formula exactly (first step `E2.2773`, dome top
Z1.200), retract correctly fired at Z3.200 (dome top + `retractAtMm`
2.0), followed by `postRetractDwellMs` (`G4 P500`), then the remaining
pull to Z9.200 (dome top + `hairLength` 8.0), then overtravel to Z29.200
(+20.0). **v3 was never print-tested** -- superseded by v4 below after
the user asked to cross-reference outside literature before continuing.

**v4 (X-Hair paper's Two-Step Suspend Printing, current)**: the user
provided Wang et al., *"X-Hair: 3D Printing Hair-like Structures with
Multi-form, Multi-property and Multi-function"* (UIST '24,
`sewingeditor/texture_docs/3654777.3676360.pdf`,
https://doi.org/10.1145/3654777.3676360) for reference. Reading it
surfaced two corrections to v1-v3's whole approach:

1. **Extrusion should happen WHILE MOVING for the first segment, not
   stationary beforehand.** X-Hair's own "Two-Step Suspend Printing" is:
   (a) Extrude -- move AND extrude normally to a "switch point"; (b)
   Stringing -- move FAST with ZERO extrusion from the switch point to
   the end point; (c) Z-hop -- retract once, AFTER stringing, to cut the
   strand; (d) Reloading -- travel to the next root with a little
   priming extrusion (already covered by this codebase's existing
   prime-bonus mechanism, so no new step was added for it). Their
   "Extrusion Length Ratio" α = L1/L (L1 = extrude segment, L = total
   length) is exactly this function's `pullExtrudeMm / hairLength` --
   the user's original framing ("the extrusion should stop by 8mm") was
   actually closer to X-Hair's validated design than v1-v3's
   stationary-deposit-then-pure-stretch mechanism was.
2. **Pull speed for the zero-extrusion segment should be FAST (their
   validated range 7000-9000mm/min, default 8000), not slow, and NOT
   derived from thickness.** v1-v3's `hairSpeed` formula (`600 *
   (DEFAULT_WIDTH / hairThickness)`, thicker = slower) had the
   relationship backwards relative to X-Hair's findings: they found
   stringing speed itself is the critical parameter (too slow -> sags
   under gravity, not fine enough; too fast -> snaps immediately),
   independent of thickness, while thickness is instead a property of
   how much material gets laid down during the EXTRUDE segment (i.e. an
   `eRate()`-based bead cross-section, not a speed multiplier). v4
   decouples these: `hairThickness` now only sets the extrude segment's
   bead width/height via `eRate(hairThickness, hairThickness,
   extrusionMultiplier)`, same convention every other bead-based
   function in this file uses; `hairSpeed` is now a flat default (8000)
   with no thickness dependence.

**Caveat carried forward explicitly**: X-Hair's numbers are PLA on a
Prusa MK3S+, not TPU on this project's printer -- treat `hairSpeed`
8000mm/min and `pullExtrudeSpeed` 1000mm/min as informed starting
points to retune against real TPU behavior, not validated-for-TPU
values. Their α (Extrusion Length Ratio) categorization (fluff/barb/
bristle/fine hair/curly hair) is likewise a PLA-derived guide, not a
TPU-confirmed one -- and their "fine hair"/"curly hair" categories both
require a support wall this function doesn't have, so they're out of
reach here regardless of material.

Net sequence (current): root dome build (identical to `emitBlobDot`) ->
dwell(`dwellMs`) -> EXTRUDE segment (`pullExtrudeMm`, real bead, at
`pullExtrudeSpeed`) -> STRING segment (remaining distance to
`hairLength`, zero extrusion, at `hairSpeed`) -> Z-hop retract
(`retractMm`) -> overtravel (`overtravelMm`, zero extrusion, this
function's own addition beyond X-Hair's 4 steps) -> travel to next dot.

Generated and hand-verified
`test_print_gcode/20260826-180815_hairy-dot-v4-xhair-two-step.gcode`
(rootDiameter=2mm, hairThickness=0.5mm, hairLength=8mm,
pullExtrudeMm=2mm, overtravelMm=20mm, `hairSpeed`/`pullExtrudeSpeed` at
their new defaults, x=70-100 y=90) -- root build unchanged from v3
(dome top Z1.200); extrude segment `G1 Z3.200 E0.2702 F1000` matches
`pullERate` (`eRate(0.5, 0.5, 1.3)` = 0.13513) × 2.0mm = 0.27026; string
segment `G0 Z9.200 F8000` matches dome top + `hairLength` 8.0, at the
new 8000mm/min default; retract `G1 E-1.3000 F900` fires once, AFTER the
string segment (not mid-pull, unlike v3); overtravel `G0 Z29.200 F600`
matches +20.0; next dot's `goto()` lifts correctly to `G1 Z29.600`. 10
negative-E lines, matching expected. **Not yet print-tested** -- v4 is
the current design but has not been validated on real hardware, and
neither had v3 before it, so a hardware result on v4 will not
disambiguate whether the root-build change (v3) or the Two-Step
mechanism change (v4) is responsible for any observed effect; isolate
if the result is ambiguous.

**v4 PRINTED -- confirmed insufficient**: user report: "It still
strings the whole z-lift though?" -- i.e. visible stringing/ooze along
the ENTIRE pull distance (up to ~28mm here: 8mm hairLength + 20mm
overtravel), not a controlled short hair. This is the SAME mechanism
already diagnosed and hardware-confirmed for `emitBlobDot` (see this
section's v10 entry): TPU is compressible, so a build burst stores
elastic pressure in the filament column that a single retract doesn't
instantly relieve -- the melt keeps oozing under that residual pressure
for a while regardless of what the E-axis is doing. v4 retracted only
at the very end of the full `hairLength` pull, following X-Hair's own
step order literally ("Z-hop" comes after "Stringing" in their process)
-- but X-Hair's own foundation is a plain printed wall, not under
unusual pressure the way this function's `blobDot`-style dome root is.
Waiting until the very end gave that residual pressure the ENTIRE pull
distance to keep oozing before flow was finally cut, instead of a short
one.

**Fix applied (v5) -- current**: retract now fires IMMEDIATELY after the
extrude segment (`pullExtrudeMm`), not after the string segment.
`postRetractDwellMs` (default 500ms, mirrors `emitBlobDot`'s own
dwell-after-retract) follows the retract before the string segment
continues. This is functionally a return to this function's own v3
(which retracted mid-pull for the same underlying reason, before v4
reverted to match the paper's literal order) -- but v5 keeps v4's real
improvement (an actual extruded bead for the first segment, via
`eRate()`, rather than v1-v3's all-stationary deposit) and only moves
WHEN the retract fires, not whether extrusion happens during the pull at
all. For `left`/`right`/`bottom` directions, the `clearanceZ` hop that
used to happen between the extrude and string segments now happens
AFTER the retract+dwell instead (order: extrude segment -> retract ->
dwell -> clearanceZ hop -> string segment -> overtravel), so the
sequence of events for horizontal directions is otherwise unchanged,
just re-ordered around the earlier retract.

Net sequence (current): root dome build (identical to `emitBlobDot`) ->
dwell(`dwellMs`) -> EXTRUDE segment (`pullExtrudeMm`, real bead, at
`pullExtrudeSpeed`) -> RETRACT (`retractMm`) -> dwell
(`postRetractDwellMs`) -> [`clearanceZ` hop, horizontal directions only]
-> STRING segment (remaining distance to `hairLength`, zero extrusion,
at `hairSpeed`) -> overtravel (`overtravelMm`, zero extrusion) -> travel
to next dot.

Generated and hand-verified
`test_print_gcode/20260826-181636_hairy-dot-v5-retract-after-extrude.gcode`
(same test parameters as the v4 file that was printed: rootDiameter=2mm,
hairThickness=0.5mm, hairLength=8mm, pullExtrudeMm=2mm,
overtravelMm=20mm, x=70-100 y=80) -- root build and extrude segment
unchanged from v4 (`G1 Z3.200 E0.2702 F1000`); retract `G1 E-1.3000
F900` now fires IMMEDIATELY after that line (was previously issued only
after the string segment); dwell `G4 P500` (`postRetractDwellMs`)
follows; string segment `G0 Z9.200 F8000` and overtravel `G0 Z29.200
F600` unchanged in distance/speed from v4, just now happening entirely
AFTER the retract instead of before it. 10 negative-E lines, matching
expected. **Not yet print-tested** -- this is a direct, hardware-motivated
fix for a confirmed v4 problem, but the fix itself is still unvalidated;
confirm the stringing is actually reduced before treating this as
settled. If stringing persists even at v5's much-shorter post-retract
distance (2mm to the retract point instead of ~28mm), the residual
pressure window may need to be shortened further still --
`pullExtrudeMm` could be lowered (less material built up before the
cut), or the ROOT BUILD itself may need its own anti-ooze treatment
(comparable to `emitBlobDot`'s v11 `extrudeSpeed`/`baseZ` changes,
which targeted the same underlying TPU-compressibility mechanism at the
build stage rather than after it).

**v5 PRINTED -- partial confirmation, with an open question**: user
report: "it is kind of working, the extrude segment become roughly the
length of the hair" -- i.e. moving the retract to right after the
extrude segment (v5's fix) DID reduce the whole-pull stringing v4
showed. But the observation also suggests the visible/physical hair
length tracks `pullExtrudeMm` (the real extruded bead) rather than the
full `hairLength` -- i.e. the STRING segment (fast, zero-extrusion,
after the retract) may not be adding much visible length on top of the
extrude segment. Not yet root-caused: possibilities include the string
segment's material being too thin/fine to read as "hair" at these
settings, the fast post-retract pull snapping the strand close to the
extrude segment's own end, or `hairLength` simply needing to be pushed
further to see the string segment's contribution clearly. No code
change made in response to this observation yet -- logged here to track
across the next few parameter tests before drawing a conclusion.

**Follow-up test**: user asked to try a denser `gap` (5mm -> 3mm) and a
longer `hairLength` (8mm -> 10mm), same mechanism (v5), same
`rootDiameter`/`hairThickness`/`pullExtrudeMm`/`overtravelMm` as the
last printed file. Generated and hand-verified
`test_print_gcode/20260826-182625_hairy-dot-v5-gap3-len10.gcode` --
calibration line x=120-180 y=100, then 11 hairy dots (confirmed exactly
3mm apart: x=70,73,76,...,100) from x=70 to x=100, y=70. Extrude segment
unchanged (`G1 Z3.200 E0.2702 F1000`, since `pullExtrudeMm`/
`hairThickness` didn't change); retract and dwell unchanged; string
segment now reaches `G0 Z11.200 F8000` (dome top 1.2 + `hairLength` 10.0,
up from 9.200 at the old 8mm); overtravel `G0 Z31.200 F600` (+20.0); next
dot's `goto()` correctly lifts to `G1 Z31.600`. 14 negative-E lines (3
calibration + 11 dots), matching expected. **Not yet print-tested.**

**v6 -- `hairLength` redefined as the EXTRUDE distance (departs from
X-Hair)**: user clarified the earlier "kind of working" observation
further: "the extrude segment actually is more efficient in defining
the hair length... for TPU, somehow it seems that the string from the
stringing becomes very soft and can be ignored from the hairy texture."
Explicit instruction: "extrude for 10mm, dwell a bit before doing the
string segment and overtravel... don't be too constrained by what the
blob used to do." This directly contradicts X-Hair's own paper (PLA),
where the STRING segment defines most of the perceived length/fineness
and EXTRUDE is a short lead-in -- on TPU, apparently, the reverse holds:
the string segment's product is too soft to register as hair at all, so
EXTRUDE has to carry the actual target length itself.

**Fix applied (v6)**: `hairLength` now defines the EXTRUDE segment's own
length directly (previously it was the TOTAL pull distance, with a
separate `pullExtrudeMm` marking how much of it was extruded -- that
parameter is removed). The retract still fires immediately after the
extrude segment (v5's fix, unchanged -- TPU's residual-pressure issue
doesn't go away just because the length semantics changed). A new,
independent `stringMm` (default 2.0mm) parameter controls a small,
separate FAST zero-extrusion pull after the post-retract dwell -- this
is X-Hair's own "Stringing" step, kept only as a finishing touch rather
than the thing that defines hair length. `overtravelMm` is unchanged in
role (extra clearance past the string segment).

In the same turn, the user also asked why `retractMm` defaulted to
1.3mm (the plain shared global default, `RETRACT_MM`) and asked to raise
it to 4.0mm, "but maintain the global speed that does not damage TPU."
Confirmed: `RETRACT_SPEED` (900mm/min, already slowed from 1500
specifically to avoid TPU drive-gear damage -- see SS1 above) is a
project-wide constant this function's retract line already always uses,
independent of `retractMm` (the distance). Raised `retractMm`'s default
to 4.0mm, matching `blobDot`'s own dot-specific override, with no change
to the retract speed.

Net sequence (current): root dome build (identical to `emitBlobDot`) ->
dwell(`dwellMs`) -> EXTRUDE segment (FULL `hairLength`, real bead, at
`pullExtrudeSpeed`) -> RETRACT (`retractMm`, now 4.0mm default) -> dwell
(`postRetractDwellMs`) -> [`clearanceZ` hop, horizontal directions only]
-> STRING segment (`stringMm`, zero extrusion, at `hairSpeed`) ->
overtravel (`overtravelMm`, zero extrusion) -> travel to next dot.

Generated and hand-verified
`test_print_gcode/20260826-183902_hairy-dot-v6-extrude-defines-length.gcode`
-- calibration line x=120-180 y=95, then 11 hairy dots (rootDiameter=2mm,
hairThickness=0.5mm, hairLength(extrude)=10mm, stringMm=2mm,
overtravelMm=20mm, retractMm=4mm, gap=3mm) from x=70 to x=100, y=60.
Verified by hand: first-step deposit `E4.9773` correctly reflects the
new `retractMm=4.0` prime restoration (was `E2.2773` at the old 1.3mm --
difference of 2.7mm E matches exactly); dome top still Z1.200; extrude
segment now lays a real 10mm bead, `G1 Z11.200 E1.3512 F1000` (matches
`eRate(0.5, 0.5, 1.3) x 10.0` = 1.3512); retract `G1 E-4.0000 F900`
fires immediately after (v5's timing preserved, now at the new 4.0mm
distance); dwell `G4 P500`; string segment `G0 Z13.200 F8000` matches
zA(11.2) + `stringMm`(2.0); overtravel `G0 Z33.200 F600` matches
13.2 + 20.0; next dot's `goto()` correctly lifts to `G1 Z33.600`. 14
negative-E lines (3 calibration + 11 dots), matching expected. **Not yet
print-tested.**

**v6 PRINTED -- two feel observations, no stringing regression**: the
user printed the v6 file and reported (a) with `hairThickness` fixed at
0.5mm, a 4-5mm hair holds its shape but a 10mm hair "flops a lot more";
(b) `rootDiameter` (the anchor-dome size) visibly changes how the hair
feels -- a smaller base prints a softer hair, a bigger base a tougher
one. Neither is a stringing problem (v5's retract-after-extrude fix
still holds); both are about strand stiffness / perceived texture.

**Fix applied (v7) -- current**: two changes, one mechanical and one
documentation-level.
1. **`hairThickness` derived from `hairLength` when left `null`** (its
   new default). Formula: `0.5 * (hairLength / 4.0)`, clamped to
   0.4-2.0mm -- anchored at the single known-good point (≈0.5mm held a
   4mm hair) and scaled linearly, on the reasoning that a longer
   cantilevered strand needs a proportionally stiffer/thicker bead not
   to droop. At `hairLength = 5` this is 0.625mm; at 10, 1.25mm. A
   starting-point formula, **not** hardware-calibrated across its range
   -- if the derived thickness comes out wrong at either extreme, this
   formula (and its `HAIR_T_REF` / `HAIR_L_REF` anchor point in
   `emitHairyDot`) is the first thing to revisit, same caveat as the
   `hairSpeed` derivation. Passing an explicit `hairThickness` number
   still overrides it entirely.
2. **`rootDiameter` promoted to an explicit feel knob.** No mechanical
   change (it already built the root exactly like a `blobDot` of that
   diameter) -- but it is now documented as a real tuning parameter for
   hair softness/toughness rather than a "fixed at 2mm for now" value,
   and it is deliberately **kept out of the `hairThickness` derivation**
   so that base-diameter and strand-thickness effects can be
   characterised independently. Folding them together now would confound
   exactly the comparison the first v7 test is set up to make.

Net sequence unchanged from v6 -- only the extrude segment's bead
cross-section moves (with `hairLength`) now.

**v7 verified by hand** (not yet print-tested): generated
`test_print_gcode/20260827-100409_hairy-dot-v7-testmode-basediameter-2vs3-len5.gcode`
-- this print is in **test mode** (Task_FineTune.md §6), so the
calibration line is a vertical `freeformSolid` stripe at x=200,
y=40->100 (first test-mode print => stripe at its start x=200), not the
normal horizontal x=120-180 line. Then two 30mm hairy-dotted lines at
x=20-50, `gap` 5mm (7 dots each): line A `rootDiameter` 2mm at y=200,
line B `rootDiameter` 3mm at y=190 -- both `hairLength` 5mm, both
explicit positions given by the user. (An earlier cut of this file,
20260827-095250 with a horizontal calibration line, was wrong and was
deleted.) Checks:
- Derived thickness identical on both lines: `effThickness` =
  `0.5 * (5 / 4.0)` = 0.625mm; `eRate(0.625, 0.625, 1.3)` = 0.21113 mm
  filament per mm, × 5mm `hairLength` = 1.0556mm, so the extrude segment
  shows **`E1.0556`** on both line A (`G1 Z6.200 E1.0556 F1000`) and
  line B (`G1 Z6.700 E1.0556 F1000`). The only difference between the
  two lines is the root dome, exactly as intended.
- Line A root (2mm): first build step `G1 Z0.367 E4.9773 F120` =
  taper-share 0.3774 + primeE 4.3 (`retractMm` 4.0 + 0.3 first-dot
  bonus) + `baseExtraMm` 0.3; dome top Z1.200.
- Line B root (3mm): first build step `G1 Z0.450 E5.7755 F120` =
  taper-share 1.1758 + 4.3 + 0.3; dome top Z1.700; second dot's
  no-bonus step is `E5.4755` (−0.3), matching.
- Retract `G1 E-4.0000 F900` fires immediately after each extrude
  segment (v5 timing), then `G4 P500`, then string `G0 Z+2.0 F8000`
  and overtravel `G0 Z+2.0 F600`, all zero-E.
- Calibration stripe confirmed vertical: `G0 X200.000 Y40.000` then
  `G1 X200.000 Y40.100 E…` / `Y40.200` … (x fixed at 200, y climbing).
- 17 negative-E lines total (1 header + 2 calibration layers + 7 + 7
  dots); footer correctly skips its own retract (left retracted). No
  stray E on any travel/string/overtravel move.

**v7 was never print-tested** -- superseded by v8 before a hardware
result came back on it. Its two changes (derived `hairThickness`,
`rootDiameter` as a feel knob) both carry forward into v8 unchanged.

**Fix applied (v8) -- current, thicker step-1 bead by default**: user
reported the hair was still flopping and asked to "increase the amount
of filament extruded when extruding a real bead (step 3)... increase the
multiplier so by default it is thicker". New `beadFlowMult` parameter
(default **2.0**) multiplies ONLY the step-1 extruded bead's E, layered
on top of `extrusionMultiplier` -- so the effective flow multiplier on
that bead is `extrusionMultiplier * beadFlowMult` = 1.3 * 2.0 = 2.6, and
the geometric `eRate(effThickness, effThickness, ...)` is called with
`extrusionMultiplier * beadFlowMult` as its `flowMult` arg. Deliberately
a SEPARATE knob from `extrusionMultiplier`: that one also scales the
root dome's standoff+dome volume model, which is hardware-confirmed
accurate (see §10 v2) and must not be disturbed. `beadFlowMult` does
nothing to the root. Dial toward 1.0 if the printed hair comes out too
fat/blobby.

**v8 verified by hand** (not yet print-tested): generated
`test_print_gcode/20260827-100902_hairy-dot-v8-testmode-beadflow-1vs2mm-len3.gcode`
-- test mode (Task_FineTune.md §6), SECOND test-mode print, so the
vertical calibration stripe marched from x=200 to **x=197** (`G0
X197.000 Y40.000` then `G1 X197.000 Y40.100 E…`, y climbing), y-band
still 40->100. Two 30mm hairy-dotted lines, `gap` 5mm (7 dots each):
line A `rootDiameter` **1mm** at y=180, line B `rootDiameter` **2mm** at
y=170 -- both `hairLength` **3mm** (texture y descends 10 per file from
the previous test-mode file's lowest line at y=190). Checks:
- Step-1 bead E doubled vs v7: `effThickness` = `max(0.4, 0.5·(3/4))` =
  0.4mm (at the clamp floor); `eRate(0.4, 0.4, 1.3·2.0=2.6)` = 0.17295
  mm/mm; × 3mm = **`E0.5189`** on both lines
  (`G1 Z3.700 E0.5189 F1000` line A, `G1 Z4.200 E0.5189 F1000` line B).
  At v7's `beadFlowMult`-less flow this would have been `E0.2594` --
  exactly 2× smaller, confirming the multiplier.
- Root dome UNAFFECTED: line A (1mm) first build step
  `G1 Z0.283 E4.6580 F120` (dome-volume share 0.0581 + primeE 4.3 +
  `baseExtraMm` 0.3), dome top Z0.700; line B (2mm) first step
  `G1 Z0.367 E4.9773 F120`, dome top Z1.200 -- identical to v7's line-B
  numbers, i.e. `beadFlowMult` did not touch the build.
- Both lines' bead E identical (`E0.5189`) -> only the root differs
  between them, isolating the base-diameter feel effect.
- Retract `E-4.0000` immediately after each bead, `G4 P500`, string
  `G0 Z+2.0 F8000`, overtravel `G0 Z+2.0 F600`, all zero-E.
- 17 negative-E lines (1 + 2 + 7 + 7); footer skips its own retract; no
  stray E on any travel/string/overtravel move.

**v8 was never print-tested** -- superseded by v9 before a hardware
result came back. Its `beadFlowMult` (at 2.0) carries into v9 raised.

**Fix applied (v9) -- current, slower + fatter bead**: user asked to
"slow down the z up movement when it is extruding... probably F500? And
increase the flow multiplier a bit. maybe try 3.5." Two default changes,
both still plain per-call overrides:
- `pullExtrudeSpeed` 1000 -> **500mm/min** -- the step-1 bead's Z-rise
  feedrate. Slower rise while extruding = denser, better-formed bead.
- `beadFlowMult` 2.0 -> **3.5** -- effective bead flow now
  `extrusionMultiplier * beadFlowMult` = 1.3 * 3.5 = 4.55x the geometric
  `eRate`.
Neither touches the root dome (still `extrusionMultiplier` = 1.3 only).

**v9 verified by hand** (not yet print-tested): generated
`test_print_gcode/20260827-102001_hairy-dot-v9-testmode-slowbead-flow3p5-gap3-1vs2mm-len3.gcode`
-- test mode, THIRD test-mode print, vertical calibration stripe marched
x=200 -> 197 -> **x=194** (`G0 X194.000 Y40.000` then `G1 X194.000
Y40.100 E…`), y-band 40->100. Two 30mm hairy-dotted lines, **`gap` 3mm**
(11 dots each, x = 20,23,26,…,50 confirmed): line A `rootDiameter` 1mm at
y=160, line B `rootDiameter` 2mm at y=150 (texture y descends 10 from the
previous file's lowest line at y=170), both `hairLength` 3mm. Checks:
- Step-1 bead: `eRate(0.4, 0.4, 1.3·3.5=4.55)` = 0.30267 mm/mm × 3mm =
  **`E0.9080`** on both lines, at **`F500`** (`G1 Z3.700 E0.9080 F500`
  line A, `G1 Z4.200 E0.9080 F500` line B). = 1.75× the v8 `E0.5189`
  (3.5/2.0), and F500 vs v8's F1000 -- both changes confirmed.
- Root dome unchanged from v8: line A first step `G1 Z0.283 E4.6580
  F120` (dome top Z0.700), line B `G1 Z0.367 E4.9773 F120` (dome top
  Z1.200).
- Bead E identical on both lines -> only the root differs.
- Retract `E-4.0000` right after each bead, `G4 P500`, string/overtravel
  zero-E; 25 negative-E lines (1 + 2 + 11 + 11); footer skips its own
  retract; no stray E.

**v9 was never print-tested** -- superseded by v10.

**Fix applied (v10) -- current, matched Z/filament feedrate + dry rise**:
user asked to lower `pullExtrudeSpeed` to 150 and -- "the more important
part" -- to make the Z-up speed during extrusion roughly the same as the
filament feed speed, then have the extrusion finish before the Z reaches
the target height (a slightly slower, `-10mm/min`, no-extrusion finish).

A single `G1 Z.. E.. F..` move can't do that: F is the Z (Cartesian)
rate and E is slaved to finish simultaneously, so the actual filament
rate is `eA * F / Zdist` -- only equal to F if `Zdist == eA`, and the
two axes always finish together. So the Extrude step is now SPLIT:
1. **extrude-while-rising** -- `G1 Z(domeTop + eA) E(eA) F(pullExtrudeSpeed)`:
   Z rises by exactly `eA` mm (the filament amount) while extruding
   `eA` mm, so the Z rate and the filament rate are both
   `pullExtrudeSpeed` (now **150**). `eA` here is a length in mm being
   used as a Z distance -- deliberate, it's what makes the rates equal.
2. **dry rise** -- `G1 Z(domeTop + hairLength) F(pullExtrudeSpeed - dryRiseFeedDrop)`:
   no E, `dryRiseFeedDrop` (default 10) mm/min slower, finishing the
   climb to full height after the bead is down.
`dryRiseFeedDrop` is a new parameter. If `eA >= hairLength` the split
collapses to move 1 alone (rates can't be matched while still reaching
height). Same split applied to the horizontal `left`/`right`/`bottom`
directions (XY distance instead of Z). `pullExtrudeSpeed` default
500 -> 150. Nothing else changed; root dome untouched.

**v10 PRINTED -- tentative-positive**: user report on the file below:
**"Printed, I think it is working."** Not a firm confirmation, but the
first non-superseded hardware feedback since v6 -- the matched Z/filament
feedrate split and the dry-rise finish did not obviously break anything
and appear to help. Treat v10's split mechanism as provisionally good;
keep it unless a later print contradicts.

**v10 verified by hand** (before the print above): generated
`test_print_gcode/20260827-103219_hairy-dot-v10-testmode-matchedfeed-drypull-1vs2mm-len3.gcode`
-- test mode, FOURTH test-mode print, calibration stripe marched
x=200 -> 197 -> 194 -> **191** (vertical, y-band 40->100). Two 30mm
hairy-dotted lines, `gap` 3mm (11 dots each): line A `rootDiameter` 1mm
at y=140, line B 2mm at y=130 (texture y descends 10 from the previous
file's lowest at y=150), both `hairLength` 3mm. Checks:
- Extrude split, line A (domeTop Z0.700): `G1 Z1.608 E0.9080 F150`
  (Z rises 0.908mm == E 0.908mm -> both axes at 150mm/min) then
  `G1 Z3.700 F140` (dry rise to domeTop+`hairLength` 3.0, no E, 150-10).
  Line B (domeTop Z1.200): `G1 Z2.108 E0.9080 F150` then
  `G1 Z4.200 F140`. Same split on both.
- `eA` unchanged from v9 (`E0.9080` = `eRate(0.4,0.4,4.55)·3`); root
  dome unchanged (line A first step `G1 Z0.283 E4.6580 F120`, line B
  `G1 Z0.367 E4.9773 F120`).
- Retract `E-4.0000` right after the dry rise, `G4 P500`, string
  `G0 Z+2 F8000`, overtravel `G0 Z+2 F600`, all zero-E.
- 25 negative-E lines (1 + 2 + 11 + 11); footer skips its own retract;
  no stray E on any move (the digest's stray-E guard flags the header's
  two `G92 E0` lines -- those are extruder-zero commands, not
  extrusion; harmless).

**Follow-up test -- double hair thickness, split clamped**: after the
tentative-positive v10 print the user asked for "double thickness of the
hair" (base 1mm and 2mm, same 3mm length). Doubling `hairThickness`
0.4 -> 0.8mm quadruples the bead E (`eRate` uses thickness squared), so
with `beadFlowMult` still 3.5 the per-mm deposit is ~1.21mm/mm > 1 --
which means v10's matched-feedrate split can't hold (rise-by-`eA` would
overshoot `hairLength`). Offered three options; **user chose to clamp
the extrude move to `hairLength`** -- i.e. exactly what `emitHairyDot`
already does when `eA >= hairLength`: one `G1 Z(domeTop+hairLength)
E(eA) F(pullExtrudeSpeed)` move, no dry rise, Z and filament feed NOT
matched (here filament runs ~182 vs Z 150mm/min). No code change --
call-site `hairThickness: 0.8` override.

Generated
`test_print_gcode/20260827-104355_hairy-dot-v10-testmode-thick0p8-clamped-1vs2mm-len3.gcode`
(test mode, FIFTH test-mode print, calibration stripe at x=188; line A
`rootDiameter` 1mm y=120, line B 2mm y=110, both `hairLength` 3mm
`hairThickness` 0.8, `gap` 3mm). Hand-verified: extrude `G1 Z3.700
E3.6320 F150` (line A) / `G1 Z4.200 E3.6320 F150` (line B) -- one move
over the full 3mm rise, no second (dry) move; `E3.6320` = 4x v10's
`E0.9080`; root dome unchanged; retract `E-4.0000` immediately after;
25 negative-E lines; no stray E. **Not yet print-tested.**

**Fix applied (v11) -- current, arbitrary polar pull direction + stamp
order**. Two features the user asked for.

1. **Polar direction.** The hair pull was 4 hard-coded strings (`"top"`
   = pure Z, `"left"/"right"/"bottom"` = pure XY), handled by two
   separate code branches. v11 replaces that with ONE straight 3D line
   from the dome top along a unit vector set by `hairElevationDeg`
   (from the bed plane: 0 = flat, 90 = up) and `hairAzimuthDeg` (CCW
   from +X). New helper `resolveHairDir()` maps either the string
   preset or the explicit angles to `(azDeg, elDeg, dx, dy, dz)`; an
   explicit angle (either one non-null) overrides the string. `"top"`
   stays the default. The two branches collapse into one `pull(d, e, f,
   rapid)` closure that emits only the axes that actually move -- so
   the emitted G-code for all four presets is UNCHANGED (verified: e.g.
   `"top"` still emits `G1 Z.. E.. F150` with no X/Y, `"right"` still
   emits `G1 X.. Y.. E.. F150` with no Z, plus its `clearanceZ` hop).
   The `clearanceZ` hop now fires only when `hairElevationDeg` < 30
   (covers the old horizontal presets, excludes `"top"`).
   **Caveat -- an angled hair reaches into XY**:
   `(hairLength + stringMm + overtravelMm)*cos(elevation)` in the
   azimuth direction. The generation script's `verifyLayout` region
   MUST include that reach or the check is meaningless (the library
   does no bed-bounds check itself).

2. **`stampOrder`** on `freeformHairyDotted` (`"auto"` | `"forward"` |
   `"reverse"`, default `"auto"`). `"auto"` projects the hair azimuth
   onto the path's forward tangent; if the strand leans toward the next
   dot, the whole line is stamped in reverse so each strand trails
   *behind* its dot, clear of where the hot nozzle (building the next
   root) travels next. Purely vertical hair -> stays forward.

**v11 verified by hand** (not yet print-tested): generated
`test_print_gcode/20260827-105639_hairy-dot-v11-testmode-polar-az30-el45-1vs2mm-len3.gcode`
-- test mode, SIXTH test-mode print, calibration stripe at **x=185**.
Two 30mm hairy-dotted lines, `gap` 3mm: line A `rootDiameter` 1mm y=100,
line B 2mm y=90, both `hairLength` 3mm `hairThickness` 0.8,
`hairAzimuthDeg` 30 `hairElevationDeg` 45. Checks:
- Direction vector: dx = cos30·cos45 = 0.6124, dy = sin30·cos45 =
  0.3536, dz = sin45 = 0.7071.
- Line A first dot at (50,100), domeTop Z0.700: pull(3, 3.632, 150) ->
  `G1 X51.837 Y101.061 Z2.821 E3.6320 F150` (50 + 0.6124·3 = 51.837;
  100 + 0.3536·3 = 101.061; 0.700 + 0.7071·3 = 2.821). No dry move
  (`eA` 3.632 >= `hairLength` 3, so clamped, as chosen last turn). No
  clearance hop (el 45 >= 30). Retract, `G4 P500`, then string
  `G0 X53.062 Y101.768 Z4.236 F8000` (+0.6124·2 / +0.3536·2 / +0.7071·2)
  and overtravel `G0 X54.287 Y102.475 Z5.650 F600`. Next dot's `goto`
  lifts to `G1 Z6.050` (5.650 + Z_HOP 0.4).
- **Stamp order reversed** by `"auto"`: hair azimuth 30° has +x
  component, path runs +x, so both lines stamp x = 50, 47, 44, … 20
  (each strand points +x toward already-placed dots; nozzle travels -x
  to the next, away from fresh hair).
- Line B (domeTop Z1.200): `G1 X51.837 Y91.061 Z3.321 E3.6320 F150`.
- All 4 string presets still produce their pre-v11 G-code (checked
  `top`/`right`/`left`/`bottom` directly).
- 25 negative-E lines (1 + 2 + 11 + 11); footer skips its own retract;
  no stray E; `verifyLayout` ok with the hair reach (rx 4.29, ry 2.47)
  folded into the region.

**Default `hairLength` is stale -- pure defaults over-extrude ~8x**: when
the "all line functions" comparison print (CHANGELOG #50) called
`freeformHairyDotted` with no overrides, the extrude segment came out as
`G1 Z11.200 E29.5573 F150` -- **29.56mm of filament per dot**. Cause:
`hairLength` still defaults to **10.0**, its v6 value from when it was the
whole pull distance; the v7 thickness derivation then makes `hairThickness`
= `0.5 * (10/4)` = 1.25mm, and `beadFlowMult` 3.5 puts the bead at
`eRate(1.25, 1.25, 4.55) * 10` = 29.56mm. Because `eA` (29.56) far exceeds
`hairLength` (10), v10's matched-feedrate split collapses to one clamped
move and the filament runs ~3x the nominal F150 (~443 vs 150 mm/min). All
of v9-v11's own test prints overrode this to `hairLength` 3 /
`hairThickness` 0.8 / `gap` 3 -- that is the real working regime; the
function's stored defaults were never updated to match. Not changed this
turn (would ripple through `hairyDot` too, and no one has asked for a new
default) -- but treat `freeformHairyDotted()` / `hairyDot()` at bare
defaults as untested and over-extruded. Also: for a `"top"` (vertical)
hair the `hairSpeed` 8000mm/min STRING pull is a Z move, and this
printer's firmware Z max feedrate (~5-10 mm/s) clamps it hard -- the 8000
figure is only realistic for near-horizontal pulls.

---

## 13. Directional blob dot: a leaning `blobDot`

**Design goal, stated by the user**: a variant of `blobDot` where the
dome LEANS in a compass direction (`azimuthDeg`, CCW from +X, arbitrary
angle — same convention as `hairyDot`). Two changes vs `blobDot` v17,
confirmed with the user before building:

1. **Sheared build** — during the tapered Z-rise the nozzle also travels
   `radius` (= diameter/2) in the azimuth direction, spread across
   `buildSteps`, so the apex ends at
   `(cx + radius·cos az, cy + radius·sin az, domeTop)`.
2. **Post-orbit diagonal drag** — after the (unchanged) dome-height
   orbit, recenter onto the *leaning apex* (the user's choice, vs the
   geometric centre), then ONE straight NO-EXTRUSION move down to
   `baseZ`, heading **−azimuth** (the user's choice, vs +azimuth), whose
   total 3D length equals `diameter`. Z drop = dome height = radius, so
   the XY leg = `√(diameter² − radius²)` = `√3·radius`; it ends
   `(1−√3)·radius ≈ −0.73·radius` past `(cx,cy)`. A shaping drag of the
   nozzle tip, no material.

**SEPARATE function** (`emitDirectionalBlobDot` / `directionalBlobDot` /
`freeformDirectionalBlobDotted`) — `blobDot` v17 is the
hardware-confirmed default and is untouched, same as `hairyDot` is
separate from `blobDot`. Reuses `blobDot`'s volume model and its
build/dwell/retract/dwell/orbit skeleton. The v16 lift + second-orbit
parameters are not carried over (not part of this). `freeformDirectionalBlobDotted`
gets `stampOrder` (default `"auto"`, same logic as `freeformHairyDotted`).

**Bed-bounds note**: like an angled hairy dot, a directional blob reaches
`~√3·radius` in −azimuth (the drag) and `radius` in +azimuth (the apex),
so the generation script's `verifyLayout` region must include that
(the library does no bed-bounds check).

**v1 verified by hand** (not yet print-tested): generated
`test_print_gcode/20260827-111012_dirblob-v1-testmode-az0-2vs3mm.gcode`
-- test mode, SEVENTH test-mode print, calibration stripe at **x=182**.
Two 30mm directional-blob lines, `gap` 10 (4 dots each), `azimuthDeg` 0:
line A `diameter` 2mm at y=80, line B `diameter` 3mm at y=70. Checks:
- Line A first dot at (50,80): sheared build steps
  `G1 X50.167 Y80.000 Z0.367 E4.9773 F120` … `G1 X51.000 Y80.000 Z1.200
  E0.1132 F120` (X climbs +1.0 total = radius, Z climbs to domeTop 1.2,
  Y fixed since az 0); dwell, retract `E-4.0000`, dwell; 3× 17-point
  orbit around (50,80) radius 1 at Z1.200; recenter `G0 X51.000
  Y80.000`; **drag `G1 X49.268 Y80.000 Z0.200 F600`** -- ΔX −1.732
  (−√3·radius), ΔZ −1.0, 3D length `√(1.732² + 1²)` = **2.000 =
  diameter**, no E.
- Line B first dot at (50,70), `diameter` 3: build `G1 X50.250 … E5.7755`
  … apex (51.5, 70, 1.7); drag (last dot) `G1 X18.902 Y70.000 Z0.200
  F600` = apexX 21.5 − √(9−2.25) 2.598.
- `stampOrder: "auto"` reversed both lines (az 0 leans +x, path runs +x)
  -> dots x = 50, 40, 30, 20.
- 11 negative-E lines (1 + 2 + 4 + 4); footer skips its own retract; no
  stray E; `verifyLayout` ok.

**v2 -- orbit + recenter removed**: user, after looking at the v1 print
G-code: "I don't think there is any need for the circular movement
anymore, so after it goes to the top, recenter (i guess this is not
needed) and move down straight away." So v2 drops the dome-height orbit
AND the recenter -- the `orbitRadius`/`orbitPts`/`orbitSpeed`/`orbitLoops`
parameters are deleted from both signatures (codebase convention: delete
unused params, don't default them to 0). New sequence: build -> dwell
(`dwellMs`) -> retract -> dwell (`postRetractDwellMs`) -> diagonal drag
(from the leaning apex, where the nozzle already is) -> next dot. The
drag is now the only post-build shaping; it still sweeps the nozzle tip
down through/past the blob, which should also catch residual string the
way `blobDot`'s orbit did.

**v2 verified by hand** (not yet print-tested): generated
`test_print_gcode/20260827-111953_dirblob-v2-testmode-noorbit-gap3-az0-2vs3mm.gcode`
-- test mode, EIGHTH test-mode print, calibration stripe at **x=179**.
Two 30mm lines, **`gap` 3** (11 dots each), `azimuthDeg` 0: line A
`diameter` 2mm y=60, line B `diameter` 3mm y=50. Line A first dot at
(50,60): sheared build `G1 X50.167 … Z0.367 E4.9773` … `G1 X51.000
Y60.000 Z1.200`, `G4 P2000`, retract `E-4.0000`, `G4 P2000`, then
**straight to the drag `G1 X49.268 Y60.000 Z0.200 F600`** (no orbit, no
recenter line in between) -- ΔX −√3·r, ΔZ −r, 3D length **2.000 =
diameter**. Next dot's `goto` `G1 Z0.600` then `G0 X47.000` (gap 3,
reversed). `stampOrder: "auto"` reversed both lines -> x = 50, 47, … 20.
25 negative-E lines (1 + 2 + 11 + 11); no stray E; footer skips its
retract; `verifyLayout` ok.

**v3 -- squish-then-drag, `gap` defaults to `diameter`**: user, after
the v2 print: "instead of making it a diagonal movement down, make it go
down the z first (kind of squishing the blob down) before it does x/y
movement ... Also, the gap should be the same as the diameter of the
blob, put this part in the function too." Two changes:

1. **Drag split into squish-then-drag.** v2's single diagonal
   `G1 X.. Y.. Z.. F<dragSpeed>` (ΔZ and ΔXY together) becomes two
   moves: first `G1 Z<baseZ> F<dragSpeed>` straight down from the
   leaning apex (squishing the blob), *then* `G1 X<endX> Y<endY>
   F<dragSpeed>` -- a pure lateral drag by `diameter` in the −azimuth
   direction, ending at `cx - radius*ax`, `cy - radius*ay`. Neither move
   carries `E` (the retract already happened).
2. **`gap` default `null` -> `diameter`.** `freeformDirectionalBlobDotted`
   now takes `gap = null`; internally `const g = gap ?? diameter`, and
   `g` drives both the stop spacing and the `stampOrder` tangent check.
   Pass an explicit `gap` to override.

**v3 — PRINTED AND CONFIRMED WORKING on real hardware** (user: "Printed
and is working"). This is the first hardware result for the directional
blob dot; the squish-then-drag shaping and `gap` = `diameter` spacing
both hold up at `azimuthDeg` 0. Nonzero azimuth still untested.
Generated:
`test_print_gcode/20260827-113000_dirblob-v3-testmode-squishdrag-gapEQdia-az0-2vs3mm.gcode`
-- test mode, NINTH test-mode print, calibration stripe at **x=176**.
Two 30mm lines, `azimuthDeg` 0, `gap` omitted (= diameter): line A
`diameter` 2mm y=40 -> gap 2 -> **16 dots**; line B `diameter` 3mm y=30
-> gap 3 -> **11 dots**. Line A first dot at (50,40): sheared build ends
`G1 X51.000 Y40.000 Z1.200`, `G4 P2000`, retract `E-4.0000`, `G4 P2000`,
then **`G1 Z0.200 F600`** (squish straight down) then **`G1 X49.000
Y40.000 F600`** (lateral drag by diameter=2 to cx−radius = 50−1). Line B
last dot drag ends `G1 X18.500 Y30.000 F600` (= 20 − 1.5). 30 negative-E
lines (1 + 2 + 16 + 11); no stray E; footer skips its retract;
`verifyLayout` ok; eTotal 86.66. `stampOrder: "auto"` reversed both
lines.

**Default `diameter` 1.6 → 2.0** (user: "Make this the default size",
after the az-0 print). Changed in `emitDirectionalBlobDot`,
`directionalBlobDot` (pass-through), and `freeformDirectionalBlobDotted`.
This is now the one place the directional blob dot's defaults diverge
from `blobDot` (still 1.6) — noted in the `texture_patterns.md` param
table.

**Nonzero azimuth — az 45, generated, not yet printed**:
`test_print_gcode/20260827-114728_dirblob-v3-testmode-az45-2mm-default.gcode`
-- test mode, TENTH test-mode print, calibration stripe at **x=173**. One
30mm line at y=40, `azimuthDeg` 45, `diameter` omitted (= new default
2.0), `gap` omitted (= diameter) -> **16 dots**. Verified by hand: first
dot at (50,40) shears to apex **(50.707, 40.707, 1.200)** -- Δ =
radius·cos45 = 1·0.7071 on each axis; retract `E-4.0000`; squish
**`G1 Z0.200 F600`**; lateral drag **`G1 X49.293 Y39.293 F600`** -- Δ =
−diameter·cos45 = −2·0.7071 on each axis, ending at the base circle's
trailing edge (cx−0.707, cy−0.707). `stampOrder: "auto"` reversed the
line (lean has a +X component along the +X path). 19 negative-E lines
(1 header + 2 stripe passes + 16 dots); no stray E; footer skips its
retract; `verifyLayout` ok; eTotal 32.63.

**Lean now follows the path tangent (line version only)**: user -- "when
this directional blob is a line, the azimuth should follow the line
tangent at that point, so ... each blob that makes up the line may have
different azimuth." In `freeformDirectionalBlobDotted`, `azimuthDeg` was
a fixed absolute heading applied to every dot; it is now an **offset**
added to the local path-tangent heading, computed per stop from points
`±min(gap/2, 1mm)` either side. Default offset `0` = each dot leans
exactly along its direction of travel (all raking downstream); `90` =
left of travel, `180` = backward. The `stampOrder: "auto"` check now
tests the *offset* lean at the path start -- with offset 0 the lean is
always forward, so "auto" always reverses.

The single-dot `emitDirectionalBlobDot` / `directionalBlobDot` are
**unchanged** -- `azimuthDeg` stays an absolute compass heading there (a
lone dot has no path). Straight-line output is also unchanged: on a +X
path the tangent is 0°, so the az-0 and az-45 test files
(`20260827-113000_...` and `20260827-114728_...`) both **regenerate
byte-identical**. Verified on a quarter-circle arc that per-dot lean
sweeps smoothly with the tangent (≈93° → ≈176° across 6 dots). Not
separately print-tested -- no mechanism change, only the per-dot angle
source.

---

## 14. Segmented line: the inter-segment retract made every segment a cone

**Symptom** (reported from a real print of the "all line functions"
comparison, CHANGELOG #50): the fat segments of `freeformSegmented` were
visually distinct from the thin ones, but each one was **cone-shaped** --
a starved point at the start, ramping up to full flow only near the end
-- and the same starved-start pattern repeated on the thin segments too.
Not a clean rectangular thick/thin alternation.

**Root cause**: v1 emitted, per segment, `G1 X.. Y.. E<eAmt>` (extrude the
whole segment in one move) followed by `G1 E-<retractMm>` -- a **4mm
retract between every segment, with no matching un-retract before the
next segment's extrude**. So the next segment's `E<eAmt>` spent its first
~4mm just refilling the retracted filament, during which the nozzle was
depressurised and deposited nothing; pressure (and therefore bead width)
then built up over the rest of the segment. Every segment started starved.
The fat segments still read as "fat" only because their `eAmt` (segDist ×
`esegment` 0.5 × `multiplier` 4 = up to 2.0mm/mm) was large enough to
recover and over-extrude by the end; the thin segments (`eAmt` ≈ 0.5mm/mm)
barely recovered at all.

This is the same class as §10's blob-dot ooze and the hairy-dot
whole-pull stringing -- **extrusion accounting that doesn't line up with
what physically comes out of the nozzle** -- but here it's the reverse
direction: a retract that never gets restored, so material is *missing*
from the start of every segment rather than *oozing* after the end.

Note: the retraction distance/speed (4.0mm / 1000mm/min) really was
tuned against real hardware once -- but for a *faint/failed whole line*,
which is exactly the symptom this retract-without-prime causes. Bumping
the retract made the fat segments recover enough to show; it never fixed
the mechanism.

**Fix applied (v2)**: `freeformSegmented` rewritten --
- Each segment type gets its **own length and its own bead width**
  (`thinLen`/`thinWidth`, `fatLen`/`fatWidth`) -- the independent
  length/width the original spec asked for, instead of one shared
  `segLen` + a flow `multiplier`.
- E per segment derived from the standard `eRate(width, LAYER_HEIGHT)`
  bead model (same as every other line style), not an arbitrary rate.
- **The inter-segment retract is removed entirely.** The line is
  continuous -- there is no travel move between segments -- so nothing
  needs a retract there. One prime at the start (`eprime`, dropped
  4.0 → 1.6mm so it doesn't blob against the smaller per-segment E) and
  one retract at the very end.
- The `G91`/`G90` XY segment walk is kept (the one v1 part that was
  actually hardware-validated; see §4).

**Not yet print-tested** -- generated
`test_print_gcode/20260827-122010_segmented-v2-testmode-thin0p8x8-fat1p6x4.gcode`
(test mode, calibration stripe x=164; thin 0.8mm×8mm, fat 1.6mm×4mm, 10
segments over 60mm at y=100). Hand-verified: prime `G1 E1.6000 F150`,
then ten consecutive `G1 X8/X4 ... E0.5322 F400` moves with **no `E-`
line between any of them**, then one `G1 E-4.0000 F1000` at the end;
`eRate(0.8, 0.2)·8` = `eRate(1.6, 0.2)·4` = 0.5322 (equal by
construction); 4 negative-E total (1 header + 2 calibration + 1 final);
`verifyLayout` ok. Confirm on an actual print that the segments now come
out rectangular before treating this as settled -- and watch the
type-to-type width transition (with no retract and steady pressure it
should be sharp, but nozzle-pressure lag may still round it slightly).
