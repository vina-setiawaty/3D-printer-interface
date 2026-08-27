# Task: Fine-tuning tactile G-code texture functions

If the user points you at this file, they want you to continue the
iterative design work on `texture_functions.js` (TPU tactile-G-code
library for a 3D-printed sewing/embroidery project). Read this whole
file before doing anything else, then follow the workflow below.

## 1. Orient yourself first

Read all four docs in this folder (`sewingeditor/texture_docs/`) in
full, in this order, before touching any code:

1. `texture_patterns.md` — parameter tables, per-function descriptions,
   "Hardware status" paragraphs (what's been print-confirmed vs.
   theoretical vs. never-tested).
2. `texture_functions.js` — the actual library code.
3. `troubleshooting.md` — numbered sections per problem area; §10 is the
   full version history of the blob-dot anti-stringing work (currently
   at v17); §11 covers the relative-extrusion architecture.
4. `global_printing_parameters.md` — global constants (`NOZZLE_TEMP`,
   `RETRACT_MM`, `FIL_AREA`, etc.) and cross-function parameter tables.
5. `CHANGELOG.md` — one numbered entry per turn of this whole project,
   `**Asked**:` / `**Given**:` / sometimes `**Problem reported**:`. Skim
   the most recent 5-10 entries to see exactly what just happened.

Do not trust your own assumptions about "what a reasonable G-code
texture function looks like" over what these docs say — this project has
a lot of hard-won, non-obvious, hardware-tested detail in it (see
`troubleshooting.md` before reinventing anything).

## 2. Current state (as of the last session)

- **Default dot texture**: `blobDot` / `emitBlobDot` (private helper) /
  `freeformBlobDotted` (line of dots). This is the actively-worked-on
  function — check `troubleshooting.md` §10 for the latest version
  number and hardware status before changing it.
- **Current best-known config (v17, CONFIRMED on real hardware)**: build
  the dome (Z-rise + taper), dwell, retract, dwell, ONE orbit at the
  dome's own top height (`orbitLoops`, default 3), then straight to the
  next dot's travel move. A later mechanism (recenter + lift + second
  higher orbit, added in v16) is **commented out** in `emitBlobDot`
  because the user confirmed it's not needed — the commented block is
  left in place (not deleted) with a note on what it was and why it's
  off, in case a future test wants to revisit it. Do not silently
  re-enable it without being asked.
- **Extrusion mode**: the whole file uses relative extrusion (`M83`).
  Every `G1 E<value>` is a DELTA, not a cumulative position. Negative E
  values are normal (retracts) — see `troubleshooting.md` §7 and §11
  before treating a negative E as a bug.
- **`NOZZLE_TEMP`**: 220°C is the real global default now (not a
  per-test override) — see `troubleshooting.md` §10 and
  `global_printing_parameters.md`.

Always re-check `texture_patterns.md`'s "Hardware status" paragraph and
`troubleshooting.md` §10 for the actual current version number and
status before assuming the above summary is still current — this file
may be stale by the time you're reading it; the two docs above are the
source of truth, this file is just an entry point.

## 3. The standing per-turn workflow

For each request the user makes (a new mechanism, a parameter tweak, a
different diameter to try, etc.):

1. **Implement** the change in `texture_functions.js`. Read the relevant
   function's current code and docstring first — don't guess at the
   current signature.
2. **Generate a test G-code file.** Copy `gen_template.mjs` (this
   folder — a reference copy, never run or edited in place) into the
   scratchpad directory as `gen_<something>.mjs`, fill in its `CONFIG`
   block and `buildTextures()` body, and run:
   `node <scratchpad>/gen_<something>.mjs <path-to-texture_functions.js> <output-path>`
   The template already handles the `pathToFileURL` dynamic import, the
   `Emitter` + `header()`/`footer()`, `verifyLayout()`, and — the point —
   prints a **verification digest** to stdout (see step 3).
   - **Calibration line first**, via `freeformSolid` — standing
     convention: horizontal x=120→180 at some y, y decreasing by 5 from
     the previous file (check the newest file in `test_print_gcode/`).
     **In test mode (§6)** it is instead a vertical stripe marched across
     X; the texture under test still follows the descending-y sequence.
   - **Texture under test** (e.g. `freeformBlobDotted`) at a y that
     continues descending from the last file (decrement 5 or 10 — check
     recent files, match the pattern, or ask if genuinely ambiguous) —
     UNLESS the user gives an explicit position.
   - Output path: `sewingeditor/texture_docs/test_print_gcode/`, named
     `{yyyymmdd-HHMMSS}_{brief-kebab-case-description}.gcode`
     (add `-testmode` to the description for a §6 print).
3. **Hand-verify from the digest — do NOT read the whole `.gcode` file.**
   (A ~1500-line hairy/blob file is ~18k tokens, mostly the ~600
   near-identical calibration moves; the digest is ~1k. This project has
   caught real bugs — nozzle-collision, negative-E drift, stray
   movements — and the digest carries what's needed to catch them.) From
   the digest confirm: the negative-E count matches the expected count
   and every retract literal is the right magnitude; the first
   texture-unit block matches what you implemented — right sequence,
   right order, right heights/positions, zero unexpected `E` on
   travel-only moves; and your hand-computed key values (first build-step
   E, dome-top Z, derived thickness, …) match the emitted numbers. If a
   specific question is still open, answer it with **one targeted**
   `grep -n` / `sed -n <range>` on the file — never a full read. Report
   what you actually checked.
4. **Update all three docs plus the changelog**, in the same turn,
   before considering the task done. Edit each doc by *section* — locate
   the target with `Grep` or a ranged `Read` (offset/limit) and edit
   that; do not re-read a whole doc (see §7). The edits themselves are
   cheap; the cost is reads around them.
   - `texture_patterns.md`: parameter table (add/remove/update rows),
     the function's prose description, the "Hardware status" paragraph
     (append the new version, note "not yet print-tested" unless you
     have an actual hardware result), and the full-signature line for
     any wrapper function (e.g. `freeformBlobDotted`) that forwards the
     changed parameters.
   - `troubleshooting.md`: the relevant numbered section (§10 for blob
     dot) gets a new version entry — what was asked, why, what changed,
     the net G-code sequence in prose, and its hardware-test status.
   - `CHANGELOG.md`: a new numbered entry, `## N. <title>`, with
     `**Asked**:` (what the user asked, close to verbatim) and
     `**Given**:` (what you did, and the generated file's name + what
     you verified by hand). Use `**Problem reported**:` instead of/in
     addition to `**Given**:` when the entry is about a bug the user hit
     on real hardware.
5. **Do not mark anything "confirmed on hardware"** unless the user has
   actually told you they printed it and what happened. Everything you
   generate is "not yet print-tested" by default. When the user reports
   back after printing, that's when you update the status — see below.

## 4. How to handle the user's replies after they print

The user prints these files on real hardware and reports back. Treat
their reply as the thing that actually matters — code review and
G-code-hand-tracing can catch bugs, but only a real print tells you if
stringing/oozing is actually fixed. Common reply shapes and what to do:

- **"This works" / "confirmed" / a specific positive observation**:
  update the "Hardware status" paragraph and the relevant
  `troubleshooting.md` entry to say so explicitly (not just "seems ok")
  — see v17's writeup for the pattern. Add a short CHANGELOG entry
  logging the confirmation even if no code changed.
- **A problem reported** (stringing persists, nozzle touches the blob,
  under/over-extrusion, wrong temperature, etc.): don't assume it's a
  code bug — first re-read the generated G-code and your own diagnosis
  reasoning to rule out a real bug (like the v13 nozzle-collision catch),
  then consider whether it's a physical/material effect requiring a
  different mitigation (like the TPU-compressibility diagnosis that
  motivated v11). Log the reported problem in `CHANGELOG.md` with
  `**Problem reported**:` before proposing a fix.
- **A correction that you misread their instruction**: don't just fix
  the code — figure out and state plainly what the misreading was (see
  the v15→v16 correction in `troubleshooting.md` §10 for the pattern),
  fix it, and log the correction explicitly rather than quietly
  reimplementing.
- **"Try again with a different diameter / parameter"**: reuse the same
  generation-script pattern, just with the new value, continuing the
  position sequence in `test_print_gcode/`.
- **A request to change something "for now" / "just testing" /
  "temporarily"**: prefer commenting the old code out (with a note on
  why and what to uncomment to restore it) over deleting it, and say so
  explicitly in the docs (see v17's writeup) — don't silently treat a
  session-only test as a permanent redesign, and don't silently treat a
  permanent redesign as reversible. If it's ambiguous which one the user
  means, ask.

## 5. Things to never do without being asked

- Don't switch back to absolute extrusion (`M82`) — the whole file is
  relative (`M83`) by deliberate architecture decision (`troubleshooting.md`
  §11).
- Don't change `NOZZLE_TEMP` away from 220°C as the global default
  without being told to — it's a real standardized value now, not a
  leftover test override.
- Don't delete a mechanism that's confirmed working on hardware (e.g.
  the dome-height orbit) just because a later change is being tested —
  comment it out and keep it, per §4 above, unless told to remove it
  permanently.
- Don't reintroduce a `postLiftBounces`/`blobClearanceMm`-style
  vertical-only anti-string mechanism without checking `troubleshooting.md`
  §10 first — several of these were tried and explicitly abandoned.

## 6. Test mode (ONLY when the user explicitly says "test mode")

Everything in this section applies to a turn **only** if the user's
request for that turn explicitly calls it a test-mode print ("in test
mode…", "test mode:", etc.). If they don't say it, follow §3 exactly as
written and ignore this section. **Test mode changes only where the
calibration line goes — nothing else.**

- **The texture under test is positioned exactly as in §3 step 2** — its
  y still descends from the previous file's texture y by the same 5 or
  10mm decrement (match the recent pattern). Test mode does not move,
  resize, or reposition the texture being tested.
- Header/footer, hand-verification (§3 step 3), and the doc + changelog
  updates (§3 step 4) are all unchanged.

### The calibration line in test mode

A **vertical** stripe near the right edge of the bed instead of the usual
horizontal `x=120→180` line:

- Still generated with `freeformSolid`, same options as normal — only the
  path functions change so it runs **along +y** at a fixed x:
  `xFunc = () => X`, `yFunc = t => 40 + t`, `tStart = 0`,
  `tEnd = <calibration length>`. Keep the calibration length equal to the
  normal horizontal line's span (currently 60mm, i.e. `x=120→180`), so the
  default stripe runs **y=40 → y=100**. If that length is ever changed,
  the far end tracks it (y=40 → y=40+L) — hence "y=40 to 100+".
- Still emitted **before** the texture under test, same as §3.

### Where the stripe goes, print to print

1. The **first** test-mode print puts the stripe at **x=200**, y-band
   **40→100**.
2. **Each subsequent** test-mode print moves the stripe **left by 3mm**
   (x = 200, 197, 194, …), y-band unchanged.
3. **Column wrap**: when the next −3mm step would put the stripe at
   **x ≤ 160**, don't place it there. Reset to **x=200** and move the
   y-band up to **110 → 110+L** (default **110→170**). Resume marching
   left by 3mm in this second column.
4. **Second wrap**: when the y=110 column's stripe would again reach
   **x ≤ 160**, wrap back to the **first** column: **x=200, y-band
   40→100**. This assumes the earlier test-mode prints have been
   physically cleared from the bed by then — this is a
   many-quick-iterations-on-one-substrate workflow, and the user
   confirmed that assumption.

### Finding the current position

Check the most recent **test-mode** file in `test_print_gcode/` — read
its calibration line's x and its y-band — and continue the sequence from
there (−3mm, wrapping per above). Put a marker in the filename (e.g.
`…_hairy-dot-v7-testmode.gcode`) so a future session can spot test-mode
files at a glance. The normal descending-calibration-y sequence in §3 and
this test-mode x-march sequence are **independent** — do not
cross-continue one from the other.

### Layout note

x=200 with a ~0.5mm bead stays inside the 15mm bed margin (usable to
x=205); the vertical stripe at x=160–200 doesn't reach the
texture-under-test area (x≈20–100 in recent work), so there's no
`verifyLayout()` conflict — but if a future texture under test extends
past ~x=150, re-check before generating.

## 7. Token-cost discipline (standing practice)

This project's docs and G-code files are large; a careless turn can burn
100k+ tokens on reads alone. Keep each turn lean:

- **Never read a generated `.gcode` file in full.** Verify from
  `gen_template.mjs`'s digest (§3 steps 2–3); for a follow-up question
  use one targeted `grep -n` / `sed -n <range>`. A full read of one
  texture file ≈ 15–20k tokens, most of it the ~600 near-identical
  calibration-line moves.
- **Edit the docs by section, not by whole-file read.** `Grep` for the
  row/paragraph, or ranged `Read` (offset/limit). Approx full sizes:
  `troubleshooting.md` ~40k, `CHANGELOG.md` ~38k, `texture_functions.js`
  ~32k, `texture_patterns.md` ~8k, `global_printing_parameters.md` ~3k.
  The §1 orientation read is the *only* time to read them whole.
- **The §3-step-4 doc updates are cheap** (~5k tokens for all three docs
  + changelog) — don't skip them to "save tokens"; the cost is reads
  around them, not the edits.
- The per-turn generation script stays a throwaway in scratchpad; only
  `gen_template.mjs` (the reference copy) lives in the repo. Keep the
  template's digest section in sync if the `Emitter` output shape
  changes.
