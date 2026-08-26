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

**Current status in `freeformSegmented`**: uses explicit `M83` after
`G91` (defensive, matches the theory) and `M82`/`G90` to restore state
afterward. If this pattern is reported faint again, **do not immediately
add more defensive fixes on top** — first check whether reverting to the
simpler (no explicit `M83`) mechanism, exactly as validated in the
project's history, resolves it before layering further changes.

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
- **Always check for negative E values** in generated G-code — a
  reliable, cheap signal that retraction/extrusion bookkeeping has gone
  wrong somewhere, even if the specific cause isn't yet known.
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

**Fix applied**: after the first lift, `emitBlobDot()` now presses back
down to `baseZ` with **no extrusion** (lays the strand flat against the
already-deposited blob) before lifting again for the actual travel-safe
clearance. This is a lift → press → lift sequence on the same XY spot,
not a single lift.

**Not yet validated against real hardware** — both fixes are
theoretically motivated (see the general caution in §7 about
theoretically well-motivated fixes not being automatically correct).
Confirm on an actual print before treating either as settled, and note
what worked/didn't in a future edit to this section.
