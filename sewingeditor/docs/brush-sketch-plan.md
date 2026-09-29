# Plan: brush-sketch — prompting texture exploration by drawing

Status: **built 2026-09-29** (phases 0–5; see "As built" below). Nothing
sketched has been printed yet. Page: `sewingeditor/brush-sketch/brush-sketch.html`;
how to use it: `sewingeditor/brush-sketch/docs/README.md`.

## As built — where this differs from the plan below

Decided with the author on 2026-09-29, after the plan was written:

- **Separate file.** Generated code goes into
  `texture_docs/sketched_brushes.js`, not into `texture_functions.js`.
  `texture_functions.js` re-exports it with one line (`export * from
  "./sketched_brushes.js"`), and `sketched_brushes.js` imports the path
  engine from it.
  - This is a circular import. It is safe only because nothing at the top
    level of `sketched_brushes.js` reads an imported name. The tests load
    it from both ends and scan the generated block for this.
- **One shared interpreter instead of per-brush generated code.** §8
  planned straight-line JS generated per brush, plus an equivalence gate.
  Instead, the interpreter lives in `sketched_brushes.js` itself. A
  promoted brush is its program literal plus three thin wrappers:
  - `x(em, cx, cy, o)`
  - `freeformXDotted(em, xFunc, yFunc, tStart, tEnd, o)`
  - `brushXDotted(em, pts, o)`

  The page's previews and test prints call that same interpreter, so what
  was tested is what the library emits. There is nothing left for an
  equivalence gate to check. `promote.mjs` still verifies that the
  wrappers and the interpreter emit byte-identical G-code.
- **Naming.** A trailing "Dot" is dropped before "Dotted", following the
  library's convention (`commaDot` → `freeformCommaDotted`).
- **Test files are saved into `test_print_gcode/`** as
  `{yyyymmdd-HHMMSS}_{description from the text input}[-testmode].gcode`.
  The next calibration position is proposed from the files already there
  (recursively), or from the newest CHANGELOG entry that says "resume from
  y=N". That hint lapses once a newer normal-mode file exists.
- **Markdown regions.** Per-brush regions in the docs are fenced with
  `<!-- sketch-brush:x -->` markers. Promoting again replaces the pattern
  entry, keeping its status bullets, and extends the troubleshooting
  section.
- **No image of the sketch is sent to the model** (as planned), and no
  "keep previous version commented out" option exists. Every version's
  program stays in `sketch_brushes/<name>/`.

## 1. What this is

A page where a new texture is prompted by **drawing the nozzle's motion
for one point of a brush** instead of describing it in text. The drawing
becomes a **brush program** (data). The program compiles to G-code at once
for a test print. When the author is happy with it, it is **promoted into
`texture_docs/texture_functions.js`** as a named brush function with its
docs, in the same way the Claude Code fine-tune loop does it
(`Task_FineTune.md`).

Decisions already taken (2026-09-29):

| Decision | Consequence |
|---|---|
| **Exploration first — no matching to existing textures** | The pipeline never replaces a sketch with `blobDot`/`hairyDot`/etc. If a sketch resembles an existing texture, the *author* decides that. The LLM keeps the sketch's topology and explains every change it makes. |
| **Output = brush program + brush function** | The program (JSON) is the source of truth. A brush function in the parametric-with-tool shape (`stamp(em, cx, cy, opts)` + a path-walking dotted form + an option spec with stroke/brush levels) is **generated from it deterministically**, so a test G-code is always one click away. |
| **Mouse + keyboard only** | No pen pressure. Flow, Z and events come from the wheel, number keys and modifiers (§4). |
| **New page** | `sewingeditor/brush-sketch/`, a sibling of `parametric-with-tool/`. It *operates on* `texture_docs/`; it does not live inside it. |
| **It must update the library like the fine-tune workflow** | Through the browser **File System Access API** on the `texture_docs` folder (§8). No server is involved, so it works on `vercel dev` and on the deployed https site alike. The generated code goes in `sketched_brushes.js`, which `texture_functions.js` re-exports (see "As built"). |
| **Both drawing modes** | Freehand and vector share one program model. Freehand is interpreted by the LLM; vector compiles without it. |

## 2. The core idea: a sketch describes one stamp

This matches how the library already works. `blobDot`, `hairyDot` and
`directionalBlobDot` are each a small nozzle routine at one point. The
`*Dotted` forms repeat that routine at arc-length stops along any path
(`walkArcLengthStops` in the with-tool fork; the equivalent loop in
`freeformBlobDotted`). A sketched brush is a new routine of the same kind:

```
sketch (local frame, origin = the stamp point, z = height above bed)
   │  freehand: capture → literal draft → LLM interpret → gate
   │  vector:   edit directly                         → gate
   ▼
brush program (JSON, parametric)          ← source of truth, versioned
   │  deterministic
   ├─► interpreter  → G-code now (test print, sweep, digest)
   └─► codegen      → JS function in texture_functions.js (on promote)
                      + equivalence gate: identical G-code to the interpreter
```

Each stamp has one of two **orientations**:
- **`fixed`:** the local +X is the bed's +X.
- **`tangent`:** the local +X follows the path's direction at each stop,
  the way `freeformDirectionalBlobDotted` makes each dome lean along a
  curve. This covers raked or combed textures.

## 3. The brush program

```json
{
  "name": "commaDot",
  "version": 1,
  "orientation": "tangent",
  "radiusMm": 6,
  "params": {
    "diameter": { "def": 2.0, "min": 0.8, "max": 6,  "level": "brush",  "desc": "head dome diameter" },
    "tailLen":  { "def": 3.0, "min": 0,   "max": 10, "level": "brush",  "desc": "length of the dragged tail" },
    "gap":      { "def": 6,   "min": 1,   "max": 40, "level": "stroke", "desc": "spacing between stamps along a line" }
  },
  "steps": [
    { "op": "travel",  "to": [0, 0, 0.2] },
    { "op": "prime",   "mm": 4 },
    { "op": "move",    "to": [0, 0, "0.2 + diameter/2"], "e": "0.05*diameter^3", "f": 120 },
    { "op": "dwell",   "ms": 1500 },
    { "op": "move",    "to": ["-tailLen", 0, 0.3], "bead": { "w": 0.8, "h": 0.3 }, "f": 200 },
    { "op": "retract", "mm": 4 },
    { "op": "move",    "to": ["-tailLen - 1", 0, 1.0], "f": 600 }
  ],
  "provenance": { "mode": "freehand", "sketch": "sketch_brushes/commaDot/v1.sketch.json", "notes": [] }
}
```

**Ops.** They are low-level on purpose, so that exploration is not boxed in:

| op | fields | meaning |
|---|---|---|
| `travel` | `to` | Move with Z-hop to the start (the stamper's `em.goto`). Allowed only as the first step. |
| `move` | `to` or `by`, `f`, and one of `e` (filament mm), `bead` {w,h} (volume per mm via `eRate`) or neither (dry) | A straight move in local XYZ. It extrudes if `e`/`bead` is set. |
| `dwell` | `ms` | `G4`. No motion and no extrusion. |
| `retract` / `prime` | `mm`, optional `f` | Negative / positive E while stationary. |
| `extrudeHere` | `e`, `ms` | Deliberate extrusion while stationary (a puddle). Kept distinct from `prime` so the gate can warn about it (the blob-dot v8 lesson). It is not forbidden. |
| `repeat` | `n`, `steps` | Loop. `i` (0..n-1) and `n` are available inside expressions. This lets an orbit be written as moves. |

**Expressions.** Any number may be a string expression over the param
names plus `i`/`n`/`pi`. It is parsed by the existing safe grammar,
`compileExpr()`, which `parametric-catalog-with-tool.js` already exports
(no `eval`, and its whitelist is already tested). That is what makes a
sketch **parametric**: the author or the LLM turns a drawn number into
`diameter/2`.

**Invariants the gate enforces:**
- The stamp starts and ends retracted.
- Primes and retracts balance to zero within one stamp.
- Every coordinate stays within `radiusMm` of the origin.

## 4. The two drawing modes

Both edit the same program, in the same three views:

| View | Shows | Edits |
|---|---|---|
| **Top (XY)** | Local frame with a 1 mm grid, a 0.4 mm nozzle reference, bead thickness in proportion to flow | x, y |
| **Side (elevation)** | The vertical plane at a chosen azimuth (default XZ; `[` `]` rotate it 15°) | z, and the in-plane coordinate |
| **Timeline** | Horizontal = estimated time (from lengths ÷ feed, plus dwells). Lanes: **Z**, **flow**, **feed**, **events** | Flow, feed and dwell lengths are dragged directly |

The timeline answers "extrusion vs. dwell". A dwell is a flat span with no
motion and no flow. Extrusion while stationary is a span with no motion
and positive flow, drawn with an orange halo. The two cannot be confused.

**Visual legend (all views):**
- Line thickness is proportional to flow.
- A dashed line is a dry move.
- ◷ ring at a node = dwell, sized by ms.
- ▼ = retract, ▲ = prime.
- Orange halo = extrusion while stationary.

### 4a. Freehand ("literal brush of a mouse")

| Input | Meaning |
|---|---|
| Left-drag in the top view | Extruding stroke at the current Z |
| Left-drag in the side view | Extruding stroke in that plane (e.g. a hair pull drawn going up at an angle) |
| Shift + drag | Dry move: the nozzle moves without extruding |
| Mouse wheel during a stroke, or keys `1`–`5` | Flow level, live. `0` = no flow |
| `W` / `S` held during a top-view stroke | Raise / lower Z at a steady rate |
| Button held, mouse still | With flow > 0: extrusion at a fixed rate (hold longer = bigger puddle). With flow 0: dwell. A ring grows while held. |
| `R` / `P` | Retract / prime marker at the current point |
| Release | End of stroke. The next stroke begins with a dry move. |
| `Ctrl+Z` | Undo the last stroke |
| Option "use my drawing speed as feed" | Off by default. When on, speed is smoothed and snapped to three bands (slow / normal / fast). |

Capture keeps the raw timestamped samples `{t, x, y, z, flow, view, event}`.
A deterministic **literal draft** step turns them into a program:
- Simplify each stroke to a polyline (Ramer–Douglas–Peucker).
- Split steps at flow, view and event boundaries.
- Detect stationary spans (speed < threshold for > 150 ms) and make them
  dwells or `extrudeHere`.
- Map flow levels to `bead` sizes.

The LLM **interpret** stage (§5) then makes the draft printable and
parametric. The page overlays literal (grey) and interpreted (colour). Every
change is listed as a note, and each note can be reverted ("keep literal").
The interpreted program then opens in vector mode for fine-tuning.

### 4b. Vector

- Click in the top view to add a node. Drag a node to move it. Drag in the
  side view to set the selected node's Z. `Alt`-drag adds a curve handle
  (the curve is subdivided into moves at compile time).
- **Inspector:**
  - Selected segment: extrude on/off, `e` or `bead` w×h, feed.
  - Selected node: z, dwell ms, retract / prime mm.
- **Keys:**
  - `E` toggles extrude on the selected segment.
  - `D` adds a dwell, `R` a retract, `P` a prime.
  - `Tab` moves to the next node.
  - Arrows nudge 0.1 mm (`Shift` for 1 mm).
  - `PgUp` / `PgDn` change Z by 0.1 mm.
  - `Delete` removes a node.
- **Parameterize:** right-click any number → "make parameter" → give it a
  name, a range and a level. The field becomes the expression `name` or
  `name*k`. A "suggest parameters" button asks the LLM to propose these,
  shown as a diff to accept.
- Vector mode compiles **without any LLM call**. An optional **review**
  call gives a print-aware critique, as notes only. It never rewrites
  unless asked.

## 5. LLM calls

The calls follow parametric-with-tool's conventions:
- They go client-direct through `callLlmDirect()` in `llm.js`.
- Each call has its own JSON schema and budget, in a `stage-schemas.js`.
- Prompts are assembled from `docs/stage-*.md` (the fenced block only) and
  `docs/ref-*.md` (used whole) by a DOM-free `prompt-assembly.js`, with
  limits text **generated from code**.
- A same-stage repair loop follows the pattern of `pipeline.js` `runStage`,
  with at most 2 repairs.
- There is a debug log that can be downloaded.

The shared files `llm.js`, `script.js` and the with-tool modules are
**imported, not edited**.

| Stage | When | In → out |
|---|---|---|
| `interpret` | Freehand → program (also "suggest parameters" in vector mode) | literal draft + resampled strokes (≤100 pts each) + the author's optional one-line intent + material → `{program, notes[]}`. Each note is `{what changed, why, doc ref}`. |
| `review` | Optional, vector mode | program + gate report → notes only |
| `document` | On promote (§8) | final program + generated source + test digest → prose for `texture_patterns.md`, `troubleshooting.md`, `CHANGELOG.md` |
| `feedback` | After a print | the author's print report + current program + docs history → hardware-status text, a troubleshooting version entry, and an **optional** proposed program vN+1, shown as a diff |

**Rules for the `interpret` prompt** (`docs/stage-interpret.md`):
1. The sketch is the author's intent.
2. Never substitute an existing library texture, and never tell the author
   it "is really" one.
3. Keep the sketch's order of steps and its shape. Make the fewest changes
   that make it printable. Every change is a note.
4. Known mechanisms (taper while rising, retract right after the bead,
   orbit sweep, squish-drag) may be *offered* as notes the author can
   revert. They are never silently applied.

**`docs/ref-print-physics.md`** is a short hand-written summary of the
texture_docs lessons, each citing its section:
- TPU retraction damage (§1)
- Nozzle collision (§2)
- Stationary burst → fold into motion (blob v8, §10)
- Residual melt pressure in TPU (v10–v11)
- Retract immediately after the extrude segment (hairy v5, §12)
- Wide beads need a higher nozzle Z (segmented v4, §14)

It gives the model the reasons behind the rules, without the full 110 KB of
troubleshooting history.

Sketch images are **not** sent in v1. `callLlmDirect` sends text messages
only, and changing the shared `llm.js` is out of scope. Numeric strokes carry
the geometry more precisely anyway.

## 6. The gate (deterministic, runs on every change)

`simulate(program, params)` expands the program into a move list with state
(xyz, E, retract depth, time). It runs at the **default params and at every
min/max corner** (capped at 16 combinations).

**Errors** (block the test print; placeholder values, same status system as
`PRINT_LIMITS`):
- Schema or expression errors; a param outside its range.
- Nozzle below `0.1` mm while moving.
- A coordinate outside `radiusMm`; after placement, outside the bed safe
  area.
- Retract speed above the material cap (TPU ~1000 mm/min, PLA 2400).
- Prime/retract imbalance, or the stamp not ending retracted.
- Net E below the `netExtrusionTrip`.

**Warnings** (never block — this is an exploration tool):
- Volumetric rate above `MAX_EXTRUSION_RATE_MM3_S` on any extruding step.
- `extrudeHere` or other stationary extrusion.
- A dry move after extruding with no retract first (stringing).
- A dry move passing through already deposited material below its height
  (collision). Deposits are approximated as capsules of bead w×h along each
  extruding step (§2, blob v13).
- Retracts per stamp × stamps in the test > `retractCyclesWarn`.
- Stamp time over 30 s.

The same checks feed the `interpret` repair loop and appear in the page's
digest panel.

## 7. Test G-code (the fast loop)

The **Test print** button builds a file with the `Task_FineTune.md`
conventions:
1. `em.header()` for the session material.
2. **Calibration line:**
   - Normal mode: horizontal x = 120→180, at y = the previous normal file's
     y − 5. The page proposes this by reading the newest non-testmode file
     in `test_print_gcode/`. It is editable.
   - Test mode (a toggle, off by default, only when the author chooses
     it): the vertical stripe, marched −3 mm with the column wrap.
3. The sketched brush along a short test line: N stamps with the default
   params. Optionally a **3-tier sweep** of one chosen param side by side,
   the way the PLA calibration sheet is laid out.
4. `em.footer()`, then `verifyLayout()`.

A **digest** (a port of `gen_template.mjs`'s) shows:
- the negative-E count against the expected count from the simulator;
- the first stamp's block;
- eTotal and the footer tail.

The G-code goes into the shared `#raw-gcode-textarea`, so `script.js` can
run or save it (the compat-shim pattern from parametric-with-tool). With
folder access granted, it can also be saved as
`test_print_gcode/{yyyymmdd-HHMMSS}_{name}-v{N}[-testmode].gcode`.

## 8. Promotion: writing to texture_functions.js and the docs

**Folder access.** A "Connect texture_docs" button runs
`showDirectoryPicker()`:
- The handle is stored in IndexedDB. The browser asks again once per
  session, after a click.
- It works in Chrome/Edge over https or localhost.
- Every write first re-reads the file and compares a hash with what was
  read. If Claude Code or the author changed it in the meantime, the page
  shows a conflict instead of overwriting.

**What "Promote vN" writes**, all shown as per-file diffs and written only
after the author clicks **Write files**:

1. **`texture_functions.js`, new `SECTION 6: SKETCHED BRUSHES`.** It is
   appended, and each brush sits between markers:
   ```js
   // <sketch-brush name="commaDot" version="2"> -- GENERATED by brush-sketch
   // from sketch_brushes/commaDot/v2.program.json. Edit the program, not this code.
   export const COMMA_DOT_SPEC = { diameter: {def: 2.0, min: 0.8, max: 6, level: "brush", desc: "..."}, ... };
   function emitCommaDot(em, cx, cy, headingDeg, { diameter = 2.0, tailLen = 3.0 } = {}) { /* straight-line JS of the steps */ }
   export function commaDot(em, cx, cy, options = {}) { ... }                       // point form
   export function freeformCommaDotted(em, xFunc, yFunc, tStart, tEnd, options = {}) { ... } // six-style signature (§8 of troubleshooting)
   // </sketch-brush>
   ```
   - The code is generated **by `codegen.js`, not the LLM**. It is readable
     straight-line code with the expressions inlined.
   - The option spec uses parametric-with-tool's stroke/brush `level` tags,
     so registering the brush there later (in `BRUSHES`/`STAMPS` and
     `BRUSH_OPTIONS`) is mechanical.
   - Re-promoting replaces only the code between its markers.
2. **Equivalence gate** before anything is written. The modified library
   text is loaded through a Blob-URL `import()`; `texture_functions.js`
   has no imports, so this works. Two checks must pass:
   - The generated function must produce **byte-identical** G-code to the
     interpreter for the test file and the sweep corners.
   - A fixed matrix of the existing functions must produce output identical
     to before (the same idea as `golden-brushes.mjs`).
3. **`texture_patterns.md`:** a new entry under a "Sketched brushes"
   heading, containing the signatures, a param table generated from the
   spec, the `document` stage's prose, and "Hardware status: not yet
   print-tested".
4. **`troubleshooting.md`:** a new numbered § per brush with a v1 entry
   (what was sketched, what the interpreter changed and why, the net G-code
   sequence in prose, the status).
5. **`CHANGELOG.md`:** the next `## N.` entry with `**Asked**:` (the
   author's intent line and a pointer to the sketch) and `**Given**:` (the
   files, the digest results, the equivalence result).
6. **`texture_docs/sketch_brushes/<name>/`:**
   - `vN.program.json` and `vN.sketch.json` (raw strokes) for every
     version. Research provenance: every texture keeps the drawing it came
     from.
   - A `vN.png` thumbnail.

**After a print**, the author writes what happened into the page. The
`feedback` stage drafts:
- the hardware-status update;
- the troubleshooting version entry;
- a CHANGELOG entry (`**Problem reported**:` where it applies);
- optionally a vN+1 program.

It uses the same diff-then-write flow. The `Task_FineTune.md` §4 rules
apply: nothing is marked "confirmed" unless the author says so, and code is
commented out rather than deleted when a change is "for now". The marker
block keeps the previous version's code commented out when the author ticks
"keep previous version".

**Keeping Claude Code in step.** The build adds a short note to
`Task_FineTune.md` and `system_prompt.md`: Section 6 is generated. To change
a sketched brush, edit its program JSON and regenerate, or use the page.
Never hand-edit the block. Otherwise the two workflows would overwrite each
other.

## 9. Files

```
sewingeditor/brush-sketch/
  brush-sketch.html            3 columns: canvases | program + params + notes | digest + G-code
  brush-sketch.js              page wiring (ES module), debug log, compat entry
  brush-sketch-compat.js       same shim pattern as parametric-with-tool-compat.js
  program.js                   schema, validation, param corners, simulate()   (pure)
  interpreter.js               program → Emitter calls (stamp + path walk)     (pure)
  checks.js                    SKETCH_LIMITS table + gate rules                 (pure)
  codegen.js                   program → marked JS block; find/replace block    (pure)
  literal-draft.js             freehand samples → draft program                 (pure)
  test-print.js                calibration conventions, sweep, digest            (pure)
  sketch-pipeline.js           stage + repair loop, model call injected         (pure)
  prompt-assembly.js           docs → prompts, generated limits text            (pure)
  stage-schemas.js             interpret / review / document / feedback
  library-io.js                File System Access: connect, read, hash-checked write
  views/ top.js side.js timeline.js freehand.js vector.js
  docs/ stage-interpret.md stage-review.md stage-document.md stage-feedback.md
        ref-brush-program.md ref-print-physics.md README.md
tests/brush-sketch/            offline, node, no key, no browser
  program-simulate.mjs  literal-draft.mjs  checks.mjs
  codegen-equivalence.mjs      interpreter vs generated function, byte-identical
  pipeline.mjs                 scripted fake model, repair path
  prompt-assembly.mjs
```

It reuses the following **without editing**:
- `compileExpr` (catalog export);
- `callLlmDirect` / key helpers / cost tracker (`llm.js`);
- `script.js` run/save;
- the `texture_docs/texture_functions.js` Emitter and path engine.

## 10. Phases

| # | Deliverable | Proves |
|---|---|---|
| 0 | **Spike:** File System Access read/write on the `G:` Drive-synced folder; Blob-URL import of the library; `callLlmDirect` from a new page | The three riskiest platform assumptions, before building on them |
| 1 | **Backbone:** program model, simulate, gate, interpreter, test-print + digest, codegen + equivalence test. The UI is a JSON editor only | A hand-written program → test G-code → promoted function, with tests |
| 2 | **Vector mode:** three views, inspector, keyboard, parameterize | Drawing a brush and printing it with no LLM |
| 3 | **Freehand mode:** capture, literal draft, `interpret` stage, deviation overlay, "keep literal" | Sketch prompting |
| 4 | **Promotion:** `document` stage, diffs, hash-checked writes, `sketch_brushes/` storage, `Task_FineTune.md`/`system_prompt.md` notes | Library update in the same shape as the fine-tune workflow |
| 5 | **Feedback loop:** `feedback` stage, version bumps, keep-previous-version | Iteration after real prints |
| later | Registration in parametric-with-tool's menu; 3D preview; sending an image of the sketch (needs an `llm.js` change) | — |

## 11. Risks and open points

- **Google Drive virtual drive.** File System Access on `G:` is unverified,
  and Drive sync can race a write. Phase 0 tests this. The fallback is to
  download the changed files, or to connect a non-synced clone.
- **Generated code in a hand-curated file.** The marker block and the
  "edit the program, not the code" note contain this. The alternative is a
  separate `sketched_brushes.js` that imports from `texture_functions.js`.
  That is cleaner, but it is not "in texture_functions" as asked, so the
  plan does not take it unless the author prefers it.
- **Freehand noise.** Mouse speed and hold-still timing are noisy.
  Quantizing, the literal/interpreted overlay and "keep literal" are the
  mitigation. Whether the LLM's interpretation helps or hurts exploration
  is itself worth logging, since the debug log keeps literal vs.
  interpreted per sketch.
- **Every limit is a placeholder**, as on the other pages. It uses the same
  `status: "placeholder"` convention so it can later be confirmed in one
  place.
- **Continuous brushes** (a sketch that tiles along the path like
  `segmented`, instead of stamping) are out of scope. The `tangent`
  orientation covers the raked cases for now.
